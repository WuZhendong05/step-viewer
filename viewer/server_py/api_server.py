"""Standalone authenticated HTTP API for landing CAD uploads from a business system.

The CAD Viewer backend (``server_py.server``) is a loopback-bound, UNAUTHENTICATED,
single-user local viewer — it must not be exposed beyond localhost. This separate
process is the safe outward-facing entry point: a small REST surface an external
business system can call to land a STEP file (+ optional feature-recognition JSON)
and receive back a ready-to-open Viewer URL. It never touches the viewer server's
own routes or its ``dist/``; the only shared state is the ``uploads/`` root, so a
landed task can be opened by the viewer (default port 3245) immediately.

Task model (asynchronous)
    POST /api/v1/jobs           202 {jobId, status:"received"}
        multipart/form-data fields:
            step      (file, required)    .step/.stp
            stepUrl   (text, required)    http(s) URL of the file — EXACTLY ONE of
                                          ``step`` / ``stepUrl`` may be given; both
                                          or neither is a 400 naming which was wrong
            stepName  (text, optional)    land under this name (needed when the URL
                                          carries no .step/.stp file name)
            features  (text, optional)    feature-recognition JSON string
        A worker thread lands the files under ``uploads/<jobId>/`` and flips the
        job to ``landed`` (with ``result.viewerUrl``) or ``failed``. With
        ``stepUrl`` the worker downloads first, so the job passes through
        ``fetching``.
    GET  /api/v1/jobs/{jobId}   200 {jobId, status, result?}
        status: received -> fetching? -> landed | failed
    GET  /healthz               200 {"ok": true}

Auth
    Every /api/v1/* request requires ``Authorization: Bearer <key>`` (or
    ``X-API-Key: <key>``). The key comes from ``--api-key`` / $VIEWER_API_KEY and
    is REQUIRED — the server refuses to run without one.

Outbound URL fetching (stepUrl)
    ``stepUrl`` turns this server into a client of the caller's file host, so it is
    gated by an explicit allow-list (``--url-allow-hosts`` / $VIEWER_URL_ALLOW_HOSTS,
    host-suffix or CIDR entries). An EMPTY list rejects every stepUrl — the feature
    is off unless an operator turns it on. Unconditionally rejected regardless of
    the allow-list: non-http(s) schemes (``file://`` would be arbitrary file read),
    URLs carrying userinfo, and link-local targets (cloud metadata).

Advertised viewer URL
    The returned ``result.viewerUrl`` points at the CAD Viewer (default
    http://127.0.0.1:3245). Use --viewer-host/--viewer-port (or
    --viewer-base-url for a full origin) so the business system can actually
    reach it. ``landed`` means "files on disk + URL openable"; GLB/topology
    artifacts are generated lazily by the viewer on first open.

Job records live in memory only (this process). The landed files under
``uploads/<jobId>/`` persist on disk regardless of restarts. A stepUrl is stored
REDACTED (scheme://host/path) because the query string of a signed URL is a
credential and job.json is written to disk.

Run: python -m server_py.api_server --api-key <key> [--port 8420] [--host 0.0.0.0]
     [--url-allow-hosts "*.aliyuncs.com,10.20.0.0/16"]
"""

from __future__ import annotations

import argparse
import concurrent.futures
import email
import email.policy
import hmac
import ipaddress
import json
import os
import re
import secrets
import signal
import socket
import sys
import threading
import time
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import quote, unquote, urlsplit

if __package__ in (None, ""):
    sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    from server_py import backend as backend_mod
    from server_py import server_info as server_info_mod
    from server_py.encoding import compact_json, url_search_params_encode
else:
    from . import backend as backend_mod
    from . import server_info as server_info_mod
    from .encoding import compact_json, url_search_params_encode

DEFAULT_API_PORT = 8420
DEFAULT_MAX_UPLOAD_BYTES = 100 * 1024 * 1024  # 100 MiB
DEFAULT_URL_TIMEOUT = 60
_URL_CHUNK_BYTES = 64 * 1024
_URL_HEAD_TIMEOUT = 15
# Link-local is where the cloud metadata service lives; no CAD file host is ever
# there, so it stays blocked even if an operator allow-lists the whole internet.
_URL_BLOCKED_NETWORKS = (
    ipaddress.ip_network("169.254.0.0/16"),
    ipaddress.ip_network("0.0.0.0/8"),
)

_JOB_RE = re.compile(r"^/api/v1/jobs/([^/]+)$")
# "attach features later": POST the raw feature-recognition JSON to an existing job.
_JOB_FEATURES_RE = re.compile(r"^/api/v1/jobs/([^/]+)/features$")


class _Ctx:
    api_key = ""
    host = "0.0.0.0"
    port = DEFAULT_API_PORT
    viewer_host = server_info_mod.DEFAULT_VIEWER_HOST
    viewer_port = server_info_mod.DEFAULT_VIEWER_PORT
    viewer_base_url = ""
    max_upload_bytes = DEFAULT_MAX_UPLOAD_BYTES
    debug = False
    prewarm = True
    prewarm_url = ""
    prewarm_timeout = 300
    prewarm_executor = None
    url_allow_rules: list = []
    url_timeout = DEFAULT_URL_TIMEOUT


# --- job store ---------------------------------------------------------------

class _JobStore:
    """Job registry keyed by jobId == uploads/<jobId> directory name.

    Jobs persist to ``uploads/<jobId>/job.json`` so a server restart does not lose
    status/results (the uploaded files already live on disk). The in-memory dict is
    the fast path; a disk miss is recovered from the file on demand.
    """

    def __init__(self) -> None:
        self._jobs: dict[str, dict] = {}
        self._lock = threading.Lock()

    def _job_dir(self, job_id: str) -> str:
        return os.path.join(backend_mod._link_upload_root(), job_id)

    def _job_file(self, job_id: str) -> str:
        return os.path.join(self._job_dir(job_id), "job.json")

    def _persist(self, job: dict) -> None:
        # Best effort: a failed write (e.g. disk full) must never fail the request;
        # the in-memory record still serves the caller for this process lifetime.
        try:
            with open(self._job_file(job["jobId"]), "w", encoding="utf-8") as handle:
                json.dump(job, handle, ensure_ascii=False)
        except OSError:
            pass

    def _load(self, job_id: str) -> dict | None:
        try:
            with open(self._job_file(job_id), "r", encoding="utf-8") as handle:
                return json.load(handle)
        except (OSError, ValueError):
            return None

    def create(self, source: dict | None = None) -> dict:
        job = {
            "jobId": backend_mod._new_task_id(),
            "status": "received",
            "createdAt": time.strftime("%Y-%m-%dT%H:%M:%S"),
            "error": None,
            "result": None,
            "prewarm": "queued" if _Ctx.prewarm else "disabled",
            # Which door the STEP came in by. A stepUrl is stored REDACTED: its query
            # string may be a credential and this record is persisted to job.json.
            "source": source or {"mode": "file"},
            # Two-phase contract: features may arrive with the upload ("done") or
            # later via POST /api/v1/jobs/{id}/features ("none" -> "done"/"failed").
            "features": "none",
            "featuresError": None,
        }
        with self._lock:
            self._jobs[job["jobId"]] = job
        # Ensure the task dir exists now so job.json can be written alongside it.
        try:
            os.makedirs(self._job_dir(job["jobId"]), exist_ok=True)
            self._persist(job)
        except OSError:
            pass
        return job

    def get(self, job_id: str) -> dict | None:
        with self._lock:
            job = self._jobs.get(job_id)
            if job is None:
                job = self._load(job_id)
                if job is None:
                    return None
                self._jobs[job_id] = job
            return self._normalise(job)

    def _normalise(self, job: dict) -> dict:
        """Jobs created before the two-phase contract have no features field: infer
        it from the on-disk sidecar so legacy jobs report the truth instead of a
        blanket "none"."""
        if "features" not in job:
            job["features"] = "done" if self._sidecar_present(job) else "none"
            job.setdefault("featuresError", None)
        job.setdefault("featuresError", None)
        return job

    def _sidecar_present(self, job: dict) -> bool:
        file_name = (job.get("result") or {}).get("file")
        if not file_name:
            return False
        try:
            step_path = os.path.join(self._job_dir(job["jobId"]), str(file_name))
            return bool(backend_mod.find_features_sidecar(step_path))
        except Exception:  # noqa: BLE001 — inference is best effort
            return False

    def set_features(self, job_id: str, state: str, error: str | None = None,
                     features_name: str | None = None, viewer_url: str | None = None) -> None:
        with self._lock:
            job = self._jobs.get(job_id)
            if job is None:
                return
            job["features"] = state
            job["featuresError"] = error
            if features_name or viewer_url:
                result = job.get("result") or {}
                if features_name:
                    result["features"] = features_name
                if viewer_url:
                    result["viewerUrl"] = viewer_url
                job["result"] = result
            self._persist(job)

    def set_fetching(self, job_id: str) -> None:
        with self._lock:
            job = self._jobs.get(job_id)
            if job is None:
                return
            job["status"] = "fetching"
            self._persist(job)

    def set_landed(self, job_id: str, result: dict) -> None:
        with self._lock:
            job = self._jobs.get(job_id)
            if job is None:
                return
            job["status"] = "landed"
            job["result"] = result
            self._persist(job)

    def set_prewarm(self, job_id: str, status: str) -> None:
        with self._lock:
            job = self._jobs.get(job_id)
            if job is None:
                return
            job["prewarm"] = status
            self._persist(job)

    def set_failed(self, job_id: str, error: str) -> None:
        with self._lock:
            job = self._jobs.get(job_id)
            if job is None:
                return
            job["status"] = "failed"
            job["error"] = error
            job["prewarm"] = "disabled"
            self._persist(job)


_JOBS = _JobStore()


# --- helpers -----------------------------------------------------------------

def _viewer_authority() -> str:
    """The viewer origin (host:port netloc) advertised in handed-back URLs.

    Prefers the full --viewer-base-url; otherwise --viewer-host:--viewer-port.
    """
    base = (_Ctx.viewer_base_url or "").strip()
    if base:
        return urlsplit(base).netloc or base
    return f"{_Ctx.viewer_host}:{_Ctx.viewer_port}"


def _parse_authority(authority: str):
    """Split a ``host:port`` authority into (host, port) for a reachability probe."""
    try:
        parts = urlsplit("//" + authority)
        port = parts.port or (443 if parts.scheme == "https" else 80)
        return parts.hostname or "", int(port)
    except ValueError:
        return "", 0


class _TooLargeError(Exception):
    pass


def _parse_multipart_form(body: bytes, content_type: str) -> dict[str, tuple[str | None, bytes]]:
    """Parse a ``multipart/form-data`` body into ``{field_name: (filename, payload)}``.

    Uses the stdlib ``email`` parser over the raw body (prepended with a synthetic
    header block carrying the request's Content-Type), so no third-party dependency
    is required — the same constraint as the rest of this package.
    """
    if not content_type or "boundary=" not in content_type:
        raise ValueError("expected multipart/form-data request")
    mime = f"Content-Type: {content_type}\r\nMIME-Version: 1.0\r\n\r\n".encode("utf-8") + body
    message = email.parser.BytesParser(policy=email.policy.HTTP).parsebytes(mime)
    if not message.is_multipart():
        raise ValueError("request body is not multipart/form-data")
    fields: dict[str, tuple[str | None, bytes]] = {}
    for part in message.iter_parts():
        name = part.get_param("name", header="content-disposition")
        if name is None:
            continue
        payload = part.get_payload(decode=True)
        if payload is None:
            # A text part with an explicit charset can fail to decode (e.g. a
            # UTF-8 BOM); fall back to the raw payload bytes.
            raw = part.get_payload(decode=False)
            payload = str(raw).encode("utf-8") if raw is not None else b""
        fields[name] = (part.get_filename(), payload)
    return fields


def _field_text(fields, name: str) -> str:
    """A TEXT form field's value, or ``""`` when absent/empty.

    A row that carries a filename is a FILE part, never a text value — which is
    what makes ``step`` (file) and ``stepUrl`` (text) unambiguous by construction
    rather than by convention.
    """
    entry = fields.get(name)
    if not entry or not entry[1] or entry[0]:
        return ""
    try:
        return entry[1].decode("utf-8-sig", errors="strict").strip()
    except UnicodeDecodeError:
        raise ValueError(f"multipart field '{name}' is not valid utf-8") from None


def _resolve_step_source(fields) -> dict:
    """Enforce the step / stepUrl 二选一 contract.

    EXACTLY ONE of the two may carry a value. Every failure mode gets its own
    message so a caller can tell "sent both" from "sent neither" from "put the URL
    in the wrong row" without reading server logs.
    """
    entry = fields.get("step")
    has_file = bool(entry and entry[0] and entry[1])
    step_text = _field_text(fields, "step")
    url_text = _field_text(fields, "stepUrl")

    if has_file and url_text:
        raise ValueError("pass exactly one of 'step' (a file part) or 'stepUrl' "
                         "(a file URL) — both were provided")
    if has_file:
        return {"mode": "file", "name": entry[0], "data": entry[1]}
    if step_text and not url_text:
        raise ValueError("'step' received a text value instead of a file part; to pass a file "
                         "URL use the 'stepUrl' text field, or switch the 'step' row type to File")
    if url_text:
        return {"mode": "url", "url": url_text}
    if entry is not None or "stepUrl" in fields:
        # The row exists but carries nothing: the classic "added the row, forgot the value".
        raise ValueError("the step source is empty: fill 'step' (a .step/.stp file part) "
                         "or 'stepUrl' (a file URL), not an empty row")
    raise ValueError("'step' (a .step/.stp file part) or 'stepUrl' (a file URL text field) "
                     "is required")


def _job_source(source: dict) -> dict:
    """The persisted, secret-free description of where a job's STEP came from."""
    if source.get("mode") == "url":
        return {"mode": "url", "url": _redact_url(source["url"])}
    return {"mode": "file", "name": source.get("name") or ""}


def _validate_step(filename: str, data: bytes) -> None:
    name = os.path.basename(str(filename or "").replace("\\", "/"))
    if not name or os.path.splitext(name)[1].lower() not in (".step", ".stp"):
        raise ValueError("Only .step/.stp files are supported")
    if not data:
        raise ValueError("step content is empty")


def _validate_features_json(data: bytes) -> None:
    # utf-8-sig tolerates a leading UTF-8 BOM (common from Windows tools) and is
    # otherwise identical to utf-8.
    try:
        json.loads(data.decode("utf-8-sig", errors="strict"))
    except (ValueError, UnicodeDecodeError) as exc:
        raise ValueError(f"invalid features JSON: {exc}") from exc


# --- outbound URL fetching (stepUrl) -----------------------------------------

_URL_USER_AGENT = "cad-viewer-upload-api/1.0"


class _UrlFetchError(Exception):
    """A remote/runtime fetch failure carrying a stable, caller-facing short code.

    Contract: a caller mistake is a 400 raised before the job exists; anything that
    fails because of the remote end or the network is a job ``failed`` with one of
    these codes (``url_fetch_timeout``, ``url_http_error``, …).
    """

    def __init__(self, code: str, detail: str = "") -> None:
        self.code = code
        super().__init__(f"{code}: {detail}" if detail else code)


def parse_allow_rules(spec: str) -> list:
    """Parse ``--url-allow-hosts``: comma-separated host suffixes, exact hosts, or CIDRs.

    ``*.aliyuncs.com`` also matches the bare ``aliyuncs.com`` — fewer surprises for
    whoever operates this than a strict subdomain-only reading.
    """
    rules: list = []
    for raw in str(spec or "").split(","):
        item = raw.strip()
        if not item:
            continue
        if "/" in item:
            try:
                rules.append(("cidr", ipaddress.ip_network(item, strict=False)))
            except ValueError as exc:
                raise ValueError(f"invalid CIDR in --url-allow-hosts: {item} ({exc})") from None
            continue
        host = item.lstrip("*").lstrip(".").lower().rstrip(".")
        if host:
            rules.append(("host", host))
    return rules


def _host_rule_match(host: str, rule: str) -> bool:
    host = host.lower().rstrip(".")
    return host == rule or host.endswith("." + rule)


def _redact_url(url: str) -> str:
    """Keep scheme/host/path, drop userinfo and query.

    A signed URL's query string IS a credential, and job records are written to
    ``job.json`` on disk, so the raw value must never be persisted or echoed.
    """
    try:
        parts = urlsplit(str(url or ""))
    except ValueError:
        return "<unparseable url>"
    host = parts.hostname or ""
    try:
        if parts.port:
            host = f"{host}:{parts.port}"
    except ValueError:
        pass
    return f"{parts.scheme}://{host}{parts.path}"


def _check_url(url: str) -> str:
    """Validate a stepUrl and return its hostname, or raise ``_UrlFetchError``.

    Gates, in order: the feature must be enabled at all, scheme must be http(s),
    no embedded credentials, then the allow-list (host rules win outright; CIDR
    rules require EVERY resolved address to be inside one, which is what closes the
    DNS-rebinding hole).
    """
    rules = _Ctx.url_allow_rules
    if not rules:
        raise _UrlFetchError("url_fetch_disabled",
                             "this server does not accept file URLs "
                             "(start it with --url-allow-hosts to enable stepUrl)")
    try:
        parts = urlsplit(str(url or "").strip())
    except ValueError:
        raise _UrlFetchError("url_invalid", "the URL could not be parsed") from None
    scheme = (parts.scheme or "").lower()
    if scheme not in ("http", "https"):
        raise _UrlFetchError("url_scheme_not_allowed",
                             f"only http/https URLs are supported, got {scheme or '(none)'}")
    if parts.username or parts.password:
        raise _UrlFetchError("url_userinfo_not_allowed",
                             "credentials embedded in the URL are not supported")
    host = (parts.hostname or "").lower()
    if not host:
        raise _UrlFetchError("url_invalid", "the URL has no host")
    if any(_host_rule_match(host, rule) for kind, rule in rules if kind == "host"):
        return host

    cidrs = [rule for kind, rule in rules if kind == "cidr"]
    if not cidrs:
        raise _UrlFetchError("url_host_not_allowed",
                             f"{_redact_url(url)} is not on the allow-list")
    try:
        infos = socket.getaddrinfo(
            host, parts.port or (443 if scheme == "https" else 80), proto=socket.IPPROTO_TCP,
        )
    except (socket.gaierror, OSError):
        raise _UrlFetchError("url_dns_failed", f"cannot resolve {host}") from None
    addresses = {info[4][0] for info in infos}
    if not addresses:
        raise _UrlFetchError("url_dns_failed", f"cannot resolve {host}")
    for addr in addresses:
        try:
            ip = ipaddress.ip_address(addr.split("%", 1)[0])
        except ValueError:
            raise _UrlFetchError("url_invalid", f"unparseable address for {host}") from None
        if any(ip in blocked for blocked in _URL_BLOCKED_NETWORKS):
            raise _UrlFetchError("url_host_not_allowed",
                                 f"{host} resolves to a blocked address")
        if not any(ip in net for net in cidrs):
            raise _UrlFetchError("url_host_not_allowed",
                                 f"{host} ({addr}) is not inside any allowed CIDR")
    return host


class _GuardedRedirectHandler(urllib.request.HTTPRedirectHandler):
    """Re-validate every redirect hop, so an allow-listed host cannot bounce the
    request onto an internal target after the first check has passed."""

    max_redirections = 3

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        _check_url(newurl)
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def _url_landing_name(url: str, declared: str, explicit: str) -> str:
    """Choose the landing name: explicit stepName > URL basename > Content-Disposition.

    Each candidate must carry a .step/.stp extension to win — a URL whose last path
    segment is a bare id (``…/download``) is why ``stepName`` exists.
    """
    candidates = (explicit, unquote(os.path.basename(urlsplit(url).path or "")), declared or "")
    for candidate in candidates:
        if not candidate:
            continue
        name = os.path.basename(str(candidate).replace("\\", "/"))
        if os.path.splitext(name)[1].lower() in (".step", ".stp"):
            return name
    if explicit:
        raise _UrlFetchError("url_name_invalid",
                             f"stepName {explicit!r} does not end in .step/.stp")
    raise _UrlFetchError("url_name_unknown",
                         "cannot determine a .step/.stp file name from the URL; pass stepName")


def _remove_quietly(path: str) -> None:
    try:
        os.remove(path)
    except OSError:
        pass


def _head_url(url: str):
    """Best-effort HEAD: lets an oversized file be rejected before any bytes move.

    Non-fatal by design (some hosts answer 405/403 to HEAD) — the GET still decides.
    """
    req = urllib.request.Request(url, method="HEAD",
                                 headers={"User-Agent": _URL_USER_AGENT, "Accept": "*/*"})
    opener = urllib.request.build_opener(_GuardedRedirectHandler)
    try:
        with opener.open(req, timeout=min(_Ctx.url_timeout, _URL_HEAD_TIMEOUT)) as resp:
            return resp.headers
    except Exception:  # noqa: BLE001 — an optimisation, never a gate
        return None


def _download_step(url: str, dest_dir: str, explicit_name: str) -> tuple[str, str]:
    """Stream a stepUrl into ``dest_dir/.tmp-fetch-*``; return (temp_path, landing_name).

    The size cap is enforced WHILE streaming because Content-Length is a remote
    claim, and the temp file is removed on every failure so a half-written .step can
    never end up looking like a landed part. ``land_downloaded_step`` then moves the
    temp file into place, so the bytes are never buffered twice.
    """
    _check_url(url)
    limit = _Ctx.max_upload_bytes
    declared_name = ""
    headers = _head_url(url)
    if headers is not None:
        try:
            declared_len = int(headers.get("content-length") or 0)
        except (TypeError, ValueError):
            declared_len = 0
        if declared_len > limit:
            raise _UrlFetchError("url_too_large",
                                 f"remote file is {declared_len} bytes, limit is {limit}")
        declared_name = headers.get_filename() or ""

    name = _url_landing_name(url, declared_name, explicit_name)

    os.makedirs(dest_dir, exist_ok=True)
    tmp_path = os.path.join(dest_dir, f".tmp-fetch-{secrets.token_hex(6)}")
    opener = urllib.request.build_opener(_GuardedRedirectHandler)
    req = urllib.request.Request(url, headers={"User-Agent": _URL_USER_AGENT, "Accept": "*/*"})
    deadline = time.monotonic() + _Ctx.url_timeout
    total = 0
    try:
        with opener.open(req, timeout=_Ctx.url_timeout) as resp:
            with open(tmp_path, "wb") as handle:
                while True:
                    if time.monotonic() > deadline:
                        raise _UrlFetchError("url_fetch_timeout",
                                             f"download exceeded {_Ctx.url_timeout}s")
                    chunk = resp.read(_URL_CHUNK_BYTES)
                    if not chunk:
                        break
                    total += len(chunk)
                    if total > limit:
                        raise _UrlFetchError("url_too_large",
                                             f"download exceeded {limit} bytes")
                    handle.write(chunk)
        if total == 0:
            raise _UrlFetchError("url_empty", "the URL returned an empty body")
    except _UrlFetchError:
        _remove_quietly(tmp_path)
        raise
    except urllib.error.HTTPError as exc:
        _remove_quietly(tmp_path)
        raise _UrlFetchError("url_http_error", f"HTTP {exc.code}") from None
    except urllib.error.URLError as exc:
        _remove_quietly(tmp_path)
        reason = getattr(exc, "reason", exc)
        if isinstance(reason, (socket.timeout, TimeoutError)) or "timed out" in str(reason).lower():
            raise _UrlFetchError("url_fetch_timeout",
                                 f"no response within {_Ctx.url_timeout}s") from None
        raise _UrlFetchError("url_unreachable", f"{type(reason).__name__}: {reason}") from None
    except (socket.timeout, TimeoutError):
        _remove_quietly(tmp_path)
        raise _UrlFetchError("url_fetch_timeout",
                             f"no response within {_Ctx.url_timeout}s") from None
    except ValueError as exc:
        # A malformed redirect hop (or any other url-level rejection).
        _remove_quietly(tmp_path)
        raise _UrlFetchError("url_invalid", str(exc)) from None
    return tmp_path, name


def _task_viewer_url(task_id: str, file: str, features: str) -> str:
    """Build the external share URL in TASK form: pathname stays neutral ("/") and
    only the opaque taskId + relative file/features names appear. No absolute local
    path ever reaches the address bar or a shared link."""
    query = [("task", task_id)]
    if file:
        query.append(("file", file))
    if features:
        query.append(("features", features))
    return f"http://{_viewer_authority()}/?" + url_search_params_encode(query)


def _prewarm_payload_ok(payload) -> bool:
    """A prewarm build succeeded when the viewer reports ok and state=ready."""
    if not isinstance(payload, dict):
        return False
    if payload.get("ok") is False:
        return False
    return payload.get("state") == "ready"


def _prewarm_job(job_id: str, file_name: str) -> None:
    """Best-effort background GLB build + stepEntityId injection via the viewer.

    Fires ``POST /__cad/artifact?task=<jobId>&file=<name>`` on the viewer so the
    model is cached before the first user opens the URL. Failures never fail the
    job: the lazy build on first open remains the fallback.
    """
    _JOBS.set_prewarm(job_id, "running")
    import time as _t

    timing = os.environ.get("VIEWER_TIMING_LOG") == "1"
    try:
        path = f"/__cad/artifact?task={quote(job_id)}&file={quote(file_name)}"
        req = urllib.request.Request(_Ctx.prewarm_url + path, method="POST")
        t0 = _t.perf_counter()
        with urllib.request.urlopen(req, timeout=_Ctx.prewarm_timeout) as resp:
            raw = resp.read()
        t_http = _t.perf_counter()
        payload = json.loads(raw.decode("utf-8") or "{}")
        t_parse = _t.perf_counter()
        if timing:
            print(
                f"[timing] prewarm http={t_http - t0:.3f}s parse={t_parse - t_http:.3f}s "
                f"total={t_parse - t0:.3f}s bytes={len(raw)} state={payload.get('state')} "
                f"job={job_id}",
                file=sys.stderr,
            )
        if _prewarm_payload_ok(payload):
            _JOBS.set_prewarm(job_id, "ready")
        else:
            _JOBS.set_prewarm(job_id, "failed")
            print(
                f"prewarm {job_id}: build not ready: {payload.get('error') or payload.get('state')}",
                file=sys.stderr,
            )
    except Exception as exc:  # noqa: BLE001 — prewarm must never break the job
        print(f"prewarm {job_id} failed: {exc}", file=sys.stderr)
        _JOBS.set_prewarm(job_id, "failed")


def _inject_columns(job_id: str, file_name: str) -> None:
    """Best effort: ask the viewer to make sure the GLB carries the stepEntityId
    column (no rebuild). Covers jobs whose package was built before the inline
    injection existed, or builds where the inline pass was skipped."""
    try:
        base = _Ctx.prewarm_url or f"http://{_viewer_authority()}"
        path = f"/__cad/inject?task={quote(job_id)}&file={quote(file_name)}"
        req = urllib.request.Request(base + path, method="POST")
        with urllib.request.urlopen(req, timeout=_Ctx.prewarm_timeout) as resp:
            payload = json.loads(resp.read().decode("utf-8") or "{}")
        if not payload.get("ok"):
            print(f"inject {job_id}: viewer reports failure: {payload}", file=sys.stderr)
    except Exception as exc:  # noqa: BLE001 — must never fail the attach
        print(f"inject {job_id} failed: {exc}", file=sys.stderr)


def _land_job(job_id: str, source: dict, features_bytes: bytes | None) -> None:
    """Worker: land the STEP (downloading it first when it came as a URL), update
    the job status, and kick off prewarm.

    The fetch runs immediately in this per-request thread, never behind the build
    queue: a signed stepUrl expires, so queueing it would turn a valid request into a
    timeout for no reason.
    """
    try:
        if source.get("mode") == "url":
            # Fetch inside the task dir so a failure leaves its debris where it can be
            # seen, rather than in the system temp dir.
            _JOBS.set_fetching(job_id)
            temp_path, landing_name = _download_step(
                source["url"], _JOBS._job_dir(job_id), source.get("name") or "",
            )
            result = backend_mod.land_downloaded_step(
                landing_name, temp_path, features_bytes,
                host=_viewer_authority(), task_id=job_id,
            )
        else:
            result = backend_mod.land_uploaded_step(
                source["name"], source["data"], features_bytes,
                host=_viewer_authority(), task_id=job_id,
            )
        _JOBS.set_landed(job_id, {
            "viewerUrl": _task_viewer_url(job_id, result["file"], result["features"]),
            "taskId": result["taskId"],
            "dir": result["dir"],
            "file": result["file"],
            "features": result["features"],
        })
        if result.get("features"):
            # Features arrived with the upload: two-phase contract already satisfied.
            _JOBS.set_features(job_id, "done")
        executor = _Ctx.prewarm_executor
        if _Ctx.prewarm and executor is not None:
            executor.submit(_prewarm_job, job_id, result["file"])
    except Exception as exc:  # noqa: BLE001 — a landing failure is a job failure, not a server crash
        _JOBS.set_failed(job_id, str(exc))


# --- HTTP handler ------------------------------------------------------------

class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *args):  # quieter
        pass

    # --- shared helpers ---
    def _report_internal_error(self, exc) -> str:
        """Log the full traceback server-side; return a message safe to expose.

        Production never leaks internal paths/stack traces to callers. With
        --debug the real message is returned for local development/troubleshooting.
        """
        import traceback
        traceback.print_exc()
        return str(exc) if _Ctx.debug else "internal server error"

    def _send_json(self, status: int, payload) -> None:
        body = compact_json(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("content-type", "application/json; charset=utf-8")
        self.send_header("cache-control", "no-store")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def _read_body(self) -> bytes:
        try:
            length = int(self.headers.get("content-length") or 0)
        except (TypeError, ValueError):
            raise ValueError("invalid content-length") from None
        if length < 0 or length > _Ctx.max_upload_bytes:
            raise _TooLargeError(f"request body exceeds {_Ctx.max_upload_bytes} bytes")
        return self.rfile.read(length) if length else b""

    def _authorized(self) -> bool:
        expected = _Ctx.api_key
        if not expected:
            return True
        auth = self.headers.get("authorization", "")
        if auth.lower().startswith("bearer "):
            token = auth[7:].strip()
            if token and hmac.compare_digest(token, expected):
                return True
        header_key = self.headers.get("x-api-key", "")
        return bool(header_key) and hmac.compare_digest(header_key, expected)

    def _require_auth(self) -> bool:
        if self._authorized():
            return True
        body = b'{"error":"Unauthorized"}'
        self.send_response(401)
        self.send_header("www-authenticate", "Bearer")
        self.send_header("content-type", "application/json; charset=utf-8")
        self.send_header("cache-control", "no-store")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)
        return False

    # --- routes ---
    def do_GET(self):
        try:
            parts = urlsplit(self.path)
            if parts.path == "/healthz":
                self._send_json(200, {"ok": True, "service": "cad-viewer-upload-api"})
                return
            if parts.path == "/":
                self._send_json(200, {
                    "service": "cad-viewer-upload-api",
                    "endpoints": [
                        "POST /api/v1/jobs   (multipart: step[file] XOR stepUrl[text], "
                        "stepName?, features?)",
                        "GET  /api/v1/jobs/{jobId}",
                        "POST /api/v1/jobs/{jobId}/features   (raw feature JSON body; attach later)",
                        "GET  /healthz",
                    ],
                    "auth": "Authorization: Bearer <api-key>",
                    "statuses": ["received", "fetching", "landed", "failed"],
                    "urlFetch": "enabled" if _Ctx.url_allow_rules else "disabled",
                })
                return
            match = _JOB_RE.match(parts.path)
            if match:
                if not self._require_auth():
                    return
                job = _JOBS.get(match.group(1))
                if job is None:
                    self._send_json(404, {"error": "job not found"})
                else:
                    self._send_json(200, job)
                return
            self._send_json(404, {"error": "not found"})
        except Exception as exc:  # noqa: BLE001
            self._send_json(500, {"error": self._report_internal_error(exc)})

    def _handle_attach_features(self, job_id: str) -> None:
        """POST /api/v1/jobs/{jobId}/features — the "attach later" half of the
        two-phase contract. Body is the raw feature-recognition JSON text
        (utf-8, BOM tolerated); idempotent overwrite; on validation failure the
        job's features state flips to "failed" (the model URL stays usable)."""
        job = _JOBS.get(job_id)
        if job is None:
            self._send_json(404, {"error": "job not found"})
            return
        try:
            body = self._read_body()
            _validate_features_json(body)
        except _TooLargeError as exc:
            self._send_json(413, {"error": str(exc)})
            return
        except ValueError as exc:
            # A failed attach must not clobber an already-done state: the sidecar on
            # disk is still the last GOOD payload, so "failed" would lie about it.
            if job.get("features") != "done":
                _JOBS.set_features(job_id, "failed", str(exc))
            self._send_json(400, {"error": str(exc)})
            return
        if str(job.get("status")) != "landed":
            self._send_json(409, {"error": f"job is not landed yet (status={job.get('status')})"})
            return
        result = job.get("result") or {}
        file_name = str(result.get("file") or "")
        if not file_name:
            self._send_json(409, {"error": "job result carries no STEP file name"})
            return
        try:
            features_name = backend_mod.write_features_sidecar(
                _JOBS._job_dir(job_id), file_name, body,
            )
        except Exception as exc:  # noqa: BLE001 — malformed payload -> failed state
            if job.get("features") != "done":
                _JOBS.set_features(job_id, "failed", str(exc))
            self._send_json(400, {"error": f"invalid features JSON: {exc}"})
            return
        # Ensure the GLB carries the stepEntityId column (inline pass already did it
        # for new builds; legacy packages get it here without a rebuild).
        _inject_columns(job_id, file_name)
        url = _task_viewer_url(job_id, file_name, features_name)
        _JOBS.set_features(job_id, "done", None,
                           features_name=features_name, viewer_url=url)
        self._send_json(200, {
            "jobId": job_id,
            "features": "done",
            "featuresName": features_name,
            "viewerUrl": url,
        })

    def do_POST(self):
        try:
            parts = urlsplit(self.path)
            match = _JOB_FEATURES_RE.match(parts.path)
            if match:
                if not self._require_auth():
                    return
                self._handle_attach_features(match.group(1))
                return
            if parts.path != "/api/v1/jobs":
                self._send_json(404, {"error": "not found"})
                return
            if not self._require_auth():
                return
            body = self._read_body()
            fields = _parse_multipart_form(body, self.headers.get("content-type", ""))
            source = _resolve_step_source(fields)
            # features is a TEXT field (the JSON string itself), not a file part.
            # Payload bytes are what matter whether it arrives as a form field
            # (no filename) or a file part.
            features = fields.get("features")
            features_bytes = features[1] if features and features[1] else None
            # Validate before creating a job: malformed requests get a 4xx, not a failed
            # job. Only CALLER mistakes belong here — anything the remote end controls
            # (reachability, size, HTTP status) surfaces as a failed job instead, so the
            # two error channels stay distinguishable.
            if source["mode"] == "file":
                _validate_step(source["name"], source["data"])
            else:
                _check_url(source["url"])
                explicit = _field_text(fields, "stepName")
                if explicit:
                    # Name the caller explicitly asked for: a bad extension is their bug.
                    source["name"] = backend_mod.normalise_step_name(explicit)
            if features_bytes is not None:
                _validate_features_json(features_bytes)
            job = _JOBS.create(source=_job_source(source))
            threading.Thread(
                target=_land_job,
                args=(job["jobId"], source, features_bytes),
                daemon=True,
            ).start()
            self._send_json(202, {"jobId": job["jobId"], "status": "received"})
        except _TooLargeError as exc:
            self._send_json(413, {"error": str(exc)})
        except _UrlFetchError as exc:
            # At request time a URL rejection is a caller/config error, not a server fault.
            self._send_json(400, {"error": str(exc)})
        except ValueError as exc:
            self._send_json(400, {"error": str(exc)})
        except Exception as exc:  # noqa: BLE001
            self._send_json(500, {"error": self._report_internal_error(exc)})


# --- entry point -------------------------------------------------------------

def main(argv=None):
    parser = argparse.ArgumentParser(
        description="Standalone authenticated CAD upload API for external business systems",
    )
    parser.add_argument("--port", type=int, default=DEFAULT_API_PORT)
    parser.add_argument("--host", default="0.0.0.0", help="address to bind (default 0.0.0.0)")
    parser.add_argument("--api-key", default=None,
                        help="API key (or $VIEWER_API_KEY). REQUIRED unless --api-key-file is used.")
    parser.add_argument("--api-key-file", default="",
                        help="path to a file whose first line is the API key (avoids exposing it "
                             "on the command line; or $VIEWER_API_KEY_FILE). Takes precedence over "
                             "--api-key only when --api-key is empty.")
    parser.add_argument("--upload-root", default="", help="uploads root (default: <project>/uploads)")
    parser.add_argument("--viewer-host", default=server_info_mod.DEFAULT_VIEWER_HOST)
    parser.add_argument("--viewer-port", type=int, default=server_info_mod.DEFAULT_VIEWER_PORT)
    parser.add_argument("--viewer-base-url", default="",
                        help="full advertised viewer origin, e.g. http://192.168.1.10:3245")
    parser.add_argument("--max-upload-bytes", type=int, default=DEFAULT_MAX_UPLOAD_BYTES,
                        help="cap for a request body AND for a stepUrl download (default 100 MiB)")
    parser.add_argument("--url-allow-hosts",
                        default=os.environ.get("VIEWER_URL_ALLOW_HOSTS", ""),
                        help="comma-separated host suffixes / exact hosts / CIDRs that a stepUrl "
                             "may point at, e.g. \"*.aliyuncs.com,10.20.0.0/16\" (or "
                             "$VIEWER_URL_ALLOW_HOSTS). EMPTY is the default and rejects every "
                             "stepUrl: the URL upload path stays OFF until an operator enables "
                             "it, because it makes this server fetch from a caller-chosen host.")
    parser.add_argument("--url-timeout", type=int,
                        default=int(os.environ.get("VIEWER_URL_TIMEOUT", str(DEFAULT_URL_TIMEOUT))),
                        help="per stepUrl download timeout in seconds, connect + total "
                             "(default %d; or $VIEWER_URL_TIMEOUT)" % DEFAULT_URL_TIMEOUT)
    parser.add_argument("--debug", action="store_true",
                        help="return full error detail to callers (development only)")
    parser.add_argument("--no-prewarm", dest="prewarm", action="store_false", default=True,
                        help="disable background GLB prewarm (pure lazy generation)")
    parser.add_argument("--prewarm-url", default="",
                        help="viewer base URL for background prewarm (default http://127.0.0.1:<viewer-port>)")
    parser.add_argument("--prewarm-workers", type=int,
                        default=int(os.environ.get("VIEWER_PREWARM_WORKERS", "2")),
                        help="concurrent background prewarm builds "
                             "(default 2, or $VIEWER_PREWARM_WORKERS)")
    parser.add_argument("--prewarm-timeout", type=int, default=300,
                        help="per-prewarm HTTP timeout in seconds (default 300)")
    args = parser.parse_args(argv)

    # API key resolution precedence:
    #   --api-key  >  --api-key-file  >  $VIEWER_API_KEY  >  $VIEWER_API_KEY_FILE
    def _read_key_file(path: str) -> str:
        try:
            with open(path, "r", encoding="utf-8") as handle:
                text = handle.read().strip()
        except OSError as exc:
            print(f"api_server could not read api key file {path}: {exc}", file=sys.stderr)
            return ""
        return text.splitlines()[0].strip() if text else ""

    api_key = str(args.api_key).strip() if args.api_key is not None else ""
    if not api_key and args.api_key_file:
        api_key = _read_key_file(args.api_key_file)
    if not api_key:
        api_key = os.environ.get("VIEWER_API_KEY", "").strip()
    if not api_key and os.environ.get("VIEWER_API_KEY_FILE", "").strip():
        api_key = _read_key_file(os.environ.get("VIEWER_API_KEY_FILE", "").strip())
    if not api_key:
        print("api_server requires an API key: pass --api-key <key> / --api-key-file <file> "
              "/ $VIEWER_API_KEY / $VIEWER_API_KEY_FILE", file=sys.stderr)
        return 1

    if args.upload_root:
        os.environ.setdefault("VIEWER_UPLOAD_ROOT", args.upload_root)
    upload_root = backend_mod._link_upload_root()

    _Ctx.api_key = api_key
    _Ctx.host = args.host
    _Ctx.port = server_info_mod.normalize_viewer_port(args.port, fallback=DEFAULT_API_PORT)
    _Ctx.viewer_host = args.viewer_host
    _Ctx.viewer_port = server_info_mod.normalize_viewer_port(args.viewer_port)
    _Ctx.viewer_base_url = (args.viewer_base_url or "").strip()
    _Ctx.max_upload_bytes = max(1, int(args.max_upload_bytes))
    try:
        _Ctx.url_allow_rules = parse_allow_rules(args.url_allow_hosts)
    except ValueError as exc:
        print(f"api_server: {exc}", file=sys.stderr)
        return 1
    _Ctx.url_timeout = max(1, int(args.url_timeout))
    _Ctx.debug = bool(args.debug)
    _Ctx.prewarm = bool(args.prewarm)
    _Ctx.prewarm_url = (args.prewarm_url or "").strip() or f"http://127.0.0.1:{_Ctx.viewer_port}"
    _Ctx.prewarm_timeout = max(1, int(args.prewarm_timeout))
    _Ctx.prewarm_executor = (
        concurrent.futures.ThreadPoolExecutor(max_workers=max(1, int(args.prewarm_workers)))
        if _Ctx.prewarm else None
    )

    viewer_url = f"http://{_viewer_authority()}"
    probe_host, probe_port = _parse_authority(_viewer_authority())
    if probe_host:
        try:
            with socket.create_connection((probe_host, probe_port), timeout=1.0):
                pass
        except OSError:
            print(f"WARNING: advertised viewer {viewer_url} is not reachable; "
                  f"returned URLs will not open until it is", file=sys.stderr)

    httpd = ThreadingHTTPServer((args.host, _Ctx.port), Handler)
    print(f"CAD upload API listening on http://{args.host}:{_Ctx.port}/ (auth: on)")
    print(f"  uploads root: {upload_root}")
    print(f"  returned viewer URLs will advertise: {viewer_url}")
    print(f"  prewarm: {'on -> ' + _Ctx.prewarm_url if _Ctx.prewarm else 'off (lazy only)'}")
    if _Ctx.url_allow_rules:
        allowed = ", ".join(
            (f"*.{rule}" if kind == "host" else str(rule)) for kind, rule in _Ctx.url_allow_rules
        )
        print(f"  stepUrl fetch: on -> {allowed} (timeout {_Ctx.url_timeout}s, "
              f"max {_Ctx.max_upload_bytes} bytes)")
    else:
        print("  stepUrl fetch: OFF (no --url-allow-hosts) — 'stepUrl' requests get 400")

    def _request_shutdown(signum, _frame):
        # httpd.shutdown() must run off the serve_forever thread (it blocks until
        # the serve loop exits); a daemon thread avoids deadlocking the handler.
        print(f"received signal {signum}; shutting down gracefully", file=sys.stderr)
        threading.Thread(target=httpd.shutdown, daemon=True).start()

    for _sig in (signal.SIGINT, signal.SIGTERM):
        try:
            signal.signal(_sig, _request_shutdown)
        except (ValueError, OSError):
            pass  # e.g. SIGTERM unsupported on some Windows runtimes

    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        httpd.server_close()
        if _Ctx.prewarm_executor is not None:
            _Ctx.prewarm_executor.shutdown(wait=False)
    print("API server stopped", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
