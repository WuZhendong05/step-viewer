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
            features  (text, optional)    feature-recognition JSON string
        A worker thread lands the files under ``uploads/<jobId>/`` and flips the
        job to ``landed`` (with ``result.viewerUrl``) or ``failed``.
    GET  /api/v1/jobs/{jobId}   200 {jobId, status, result?}
        status: received -> landed | failed
    GET  /healthz               200 {"ok": true}

Auth
    Every /api/v1/* request requires ``Authorization: Bearer <key>`` (or
    ``X-API-Key: <key>``). The key comes from ``--api-key`` / $VIEWER_API_KEY and
    is REQUIRED — the server refuses to run without one.

Advertised viewer URL
    The returned ``result.viewerUrl`` points at the CAD Viewer (default
    http://127.0.0.1:3245). Use --viewer-host/--viewer-port (or
    --viewer-base-url for a full origin) so the business system can actually
    reach it. ``landed`` means "files on disk + URL openable"; GLB/topology
    artifacts are generated lazily by the viewer on first open.

Job records live in memory only (this process). The landed files under
``uploads/<jobId>/`` persist on disk regardless of restarts.

Run: python -m server_py.api_server --api-key <key> [--port 8420] [--host 0.0.0.0]
"""

from __future__ import annotations

import argparse
import concurrent.futures
import email
import email.policy
import hmac
import json
import os
import re
import signal
import socket
import sys
import threading
import time
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import quote, urlsplit

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

    def create(self) -> dict:
        job = {
            "jobId": backend_mod._new_task_id(),
            "status": "received",
            "createdAt": time.strftime("%Y-%m-%dT%H:%M:%S"),
            "error": None,
            "result": None,
            "prewarm": "queued" if _Ctx.prewarm else "disabled",
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


def _require_step_field(fields) -> tuple[str, bytes]:
    entry = fields.get("step")
    if not entry or not entry[0] or not entry[1]:
        raise ValueError("multipart field 'step' (a .step/.stp file) is required")
    return entry[0], entry[1]


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
    try:
        path = f"/__cad/artifact?task={quote(job_id)}&file={quote(file_name)}"
        req = urllib.request.Request(_Ctx.prewarm_url + path, method="POST")
        with urllib.request.urlopen(req, timeout=_Ctx.prewarm_timeout) as resp:
            payload = json.loads(resp.read().decode("utf-8") or "{}")
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


def _land_job(job_id: str, step_name: str, step_bytes: bytes, features_bytes: bytes | None) -> None:
    """Worker: perform the disk landing, update the job status, and kick off prewarm."""
    try:
        result = backend_mod.land_uploaded_step(
            step_name, step_bytes, features_bytes,
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
                        "POST /api/v1/jobs   (multipart: step, features?)",
                        "GET  /api/v1/jobs/{jobId}",
                        "POST /api/v1/jobs/{jobId}/features   (raw feature JSON body; attach later)",
                        "GET  /healthz",
                    ],
                    "auth": "Authorization: Bearer <api-key>",
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
            step_name, step_bytes = _require_step_field(fields)
            # features is a TEXT field (the JSON string itself), not a file part.
            # Payload bytes are what matter whether it arrives as a form field
            # (no filename) or a file part.
            features = fields.get("features")
            features_bytes = features[1] if features and features[1] else None
            # Validate before creating a job: malformed requests get a 4xx, not a failed job.
            _validate_step(step_name, step_bytes)
            if features_bytes is not None:
                _validate_features_json(features_bytes)
            job = _JOBS.create()
            threading.Thread(
                target=_land_job,
                args=(job["jobId"], step_name, step_bytes, features_bytes),
                daemon=True,
            ).start()
            self._send_json(202, {"jobId": job["jobId"], "status": "received"})
        except _TooLargeError as exc:
            self._send_json(413, {"error": str(exc)})
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
    parser.add_argument("--max-upload-bytes", type=int, default=DEFAULT_MAX_UPLOAD_BYTES)
    parser.add_argument("--debug", action="store_true",
                        help="return full error detail to callers (development only)")
    parser.add_argument("--no-prewarm", dest="prewarm", action="store_false", default=True,
                        help="disable background GLB prewarm (pure lazy generation)")
    parser.add_argument("--prewarm-url", default="",
                        help="viewer base URL for background prewarm (default http://127.0.0.1:<viewer-port>)")
    parser.add_argument("--prewarm-workers", type=int, default=2,
                        help="concurrent background prewarm builds (default 2)")
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
