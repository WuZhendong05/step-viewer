"""Runnable Python CAD Viewer backend (stdlib http.server, zero deps).

Serves the /__cad/* contract the client consumes: GET /__cad/server,
GET /__cad/catalog, GET /__cad/asset, GET /__cad/download, GET /__cad/artifact,
POST /__cad/artifact (build) and POST /__cad/export, plus the static dist/SPA and
legacy Referer assets.

Run: python -m server_py.server [--port N] [--host H]

There is no served root. A page URL's PATH is the absolute directory to open
(`http://host:port/Users/me/models`), exactly as in a file:// URL; the client
reads it from location.pathname and passes it to /__cad/* as ?dir=. The bare
origin names no directory, which the backend reads as the process cwd. The only
paths that are NOT a directory are the bundle's /assets/* and the /__cad/* API.

Security / trust model: binds to loopback (127.0.0.1) and serves UNAUTHENTICATED.
Any local process can read files under --dir (GET /__cad/asset), trigger STEP
builds/exports, and activate directories. This is a single-user, local-filesystem
viewer where loopback binding is the trust boundary. Do NOT bind a non-loopback
--host or expose this server beyond localhost without adding auth.
"""

from __future__ import annotations

import argparse
import os
import posixpath
import re
import signal
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlsplit, parse_qs, unquote

if __package__ in (None, ""):
    sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    from server_py import backend as backend_mod
    from server_py import cadgen_bridge
    from server_py import server_info as server_info_mod
    from server_py import encoding as enc
    from server_py.content_types import content_type_for_static_asset
else:
    from . import backend as backend_mod
    from . import cadgen_bridge
    from . import server_info as server_info_mod
    from . import encoding as enc
    from .content_types import content_type_for_static_asset

LOCAL_SERVER_FEATURES = ["path-directory"]
_BAD_PERCENT_RE = re.compile(r"%(?![0-9A-Fa-f]{2})")


def _strict_decode_uri_component(value: str) -> str:
    """Match JS decodeURIComponent: raise on a malformed percent escape."""
    if _BAD_PERCENT_RE.search(value):
        raise ValueError("URI malformed")
    return unquote(value)


def _sibling_file_ref(source_file_ref: str, relative_file_ref: str) -> str:
    source = str(source_file_ref or "").replace("\\", "/")
    relative = re.sub(r"^/+", "", str(relative_file_ref or "").replace("\\", "/"))
    if not source or not relative:
        return ""
    if os.path.isabs(source):
        return os.path.normpath(os.path.join(os.path.dirname(source), relative))
    source_dir = posixpath.dirname(source)
    return posixpath.normpath(posixpath.join("" if source_dir == "." else source_dir, relative))


class _Ctx:
    backend = None
    directory_root = ""
    dist_root = ""
    port = server_info_mod.DEFAULT_VIEWER_PORT
    host = server_info_mod.DEFAULT_VIEWER_HOST
    debug = False


def _is_loopback_host(host: str) -> bool:
    """True for 127.0.0.0/8, localhost, and ::1 — the only safe bind targets for
    this unauthenticated viewer outside an authenticated reverse proxy."""
    value = str(host or "").strip().lower()
    if value in ("localhost", "::1"):
        return True
    return value == "127.0.0.1" or value.startswith("127.")


# taskId == uploads/<taskId> directory name, produced by backend._new_task_id().
_TASK_ID_RE = re.compile(r"^\d{8}_\d{6}_[0-9a-f]{6}$")

# Upper bound for POST bodies (JSON link/upload payloads). Matches the upload
# API's default; override with VIEWER_LINK_MAX_BODY_BYTES if needed.
_MAX_LINK_BODY_BYTES = int(os.environ.get("VIEWER_LINK_MAX_BODY_BYTES", 100 * 1024 * 1024))


def _resolve_task_dir(task_id: str) -> str:
    """Deterministically map a taskId to its absolute uploads path.

    Strictly validated (no arbitrary paths), resolved against the same uploads
    root the upload API writes to (VIEWER_UPLOAD_ROOT, default <project>/uploads),
    and must stay inside it. Raises ForbiddenAssetError on format/containment
    violations and FileNotFoundError when the task directory does not exist.
    """
    if not _TASK_ID_RE.match(str(task_id or "")):
        raise backend_mod.ForbiddenAssetError("Forbidden")
    upload_root = os.path.abspath(backend_mod._link_upload_root())
    candidate = os.path.abspath(os.path.join(upload_root, task_id))
    if not (candidate == upload_root or backend_mod.scanner.path_is_inside(candidate, upload_root)):
        raise backend_mod.ForbiddenAssetError("Forbidden")
    if not os.path.isdir(candidate):
        raise FileNotFoundError(f"task {task_id!r} not found")
    return candidate


def _server_info(root_dir: str = "") -> dict:
    return server_info_mod.build_viewer_server_info(
        root_dir=root_dir or "",
        port=_Ctx.port,
        host=_Ctx.host,
        backend="local-fs",
        step_artifact_generation_available=True,
        server_mode="serve",
        server_features=LOCAL_SERVER_FEATURES,
    )


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    # --- helpers ---
    def _report_internal_error(self, exc) -> str:
        """Log the full traceback server-side; return a message safe to expose.

        Internal paths/stack traces are never returned to clients unless --debug.
        """
        import traceback
        traceback.print_exc()
        return str(exc) if _Ctx.debug else "internal server error"

    def _send_json(self, status: int, payload, cache_control: str = "no-store"):
        body = enc.compact_json(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("content-type", "application/json; charset=utf-8")
        self.send_header("cache-control", cache_control or "no-store")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def _send_bytes(self, status: int, data: bytes, content_type: str, *, disposition: str | None = None):
        self.send_response(status)
        if content_type:
            self.send_header("content-type", content_type)
        if disposition:
            self.send_header("content-disposition", disposition)
        self.send_header("cache-control", "no-store")
        self.send_header("content-length", str(len(data)))
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(data)

    def _query(self):
        parts = urlsplit(self.path)
        q = parse_qs(parts.query)
        return parts.path, {k: (v[0] if v else "") for k, v in q.items()}

    def _root_dir(self, q):
        """The active directory for a request: from ?dir=, or resolved from ?task=
        (taskId -> uploads/<taskId>, constrained to the uploads root)."""
        task = q.get("task", "")
        if task:
            return _resolve_task_dir(task)
        return q.get("dir", "")

    def log_message(self, *args):  # quieter
        pass

    # --- dispatch ---
    def do_GET(self):
        path, q = self._query()
        try:
            if path == "/__cad/server":
                self._send_json(200, _server_info(self._root_dir(q)))
            elif path == "/__cad/resolve":
                task = q.get("task", "")
                self._send_json(200, {"task": task, "dir": _resolve_task_dir(task)})
            elif path == "/__cad/catalog":
                catalog = _Ctx.backend.read_catalog(root_dir=self._root_dir(q), file_ref=q.get("file", ""))
                self._send_json(200, catalog)
            elif path == "/__cad/artifact":
                root_dir = self._root_dir(q)
                catalog = _Ctx.backend.read_catalog(root_dir=root_dir, file_ref=q.get("file", ""))
                resolved = _Ctx.backend.resolve_root(root_dir)
                self._send_json(200, _Ctx.backend.artifact_status(q.get("file", ""), resolved, catalog))
            elif path == "/__cad/test-lab":
                self._serve_test_lab()
            elif path == "/__cad/asset":
                self._serve_asset(q, download=False)
            elif path == "/__cad/download":
                self._serve_asset(q, download=True)
            elif self._legacy_cad_asset(path, q):
                pass  # served (or 403) by the legacy Referer-based handler
            else:
                self._serve_dist(path)
        except backend_mod.ForbiddenAssetError:
            self._send_json(403, {"error": "Forbidden"})
        except Exception as exc:  # noqa: BLE001
            self._send_json(400, {"error": self._report_internal_error(exc)})

    def do_POST(self):
        path, q = self._query()
        try:
            if path == "/__cad/artifact":
                self._artifact_build(q)
            elif path == "/__cad/link":
                payload = self._read_json_body()
                host = self.headers.get("host") or ""
                result = backend_mod.create_viewer_link(payload, host=host)
                self._send_json(200, result)
            elif path == "/__cad/inject":
                self._cad_inject(q)
            elif path == "/__cad/export":
                self._export(q)
            else:
                self.send_response(405)
                self.send_header("allow", "POST")
                self.send_header("content-length", "0")
                self.end_headers()
        except backend_mod.ForbiddenAssetError:
            self._send_json(403, {"error": "Forbidden"})
        except Exception as exc:  # noqa: BLE001
            self._send_json(400, {"ok": False, "error": self._report_internal_error(exc)})

    def do_HEAD(self):
        self.do_GET()

    # --- route bodies ---
    def _serve_static_file(self, file_path: str, content_type: str | None) -> bool:
        """Stream a file with no-store + content-length, NO etag/last-modified/range.
        Returns False (no response written) if the path is missing/not a regular file."""
        if not os.path.isfile(file_path):
            return False
        with open(file_path, "rb") as handle:
            data = handle.read()
        self.send_response(200)
        if content_type:
            self.send_header("content-type", content_type)
        self.send_header("cache-control", "no-store")
        self.send_header("content-length", str(len(data)))
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(data)
        return True

    def _request_referer_file_ref(self):
        value = self.headers.get("referer") or self.headers.get("referrer") or ""
        if not value:
            return ""
        try:
            ref_url = urlsplit(value if "://" in value else "http://localhost" + value)
            return (parse_qs(ref_url.query).get("file") or [""])[0].strip()
        except ValueError:
            return ""

    def _legacy_cad_asset(self, path: str, q) -> bool:
        # GET /__cad/<rel>.<ext>: a sibling-of-Referer asset request (relative package
        # assets like URDF meshes / ../components). Returns True if it handled the
        # response (served or 403), False to fall through to dist serving.
        if not path.startswith("/__cad/") or path == "/__cad/asset":
            return False
        try:
            relative_path = _strict_decode_uri_component(path[len("/__cad/"):])
        except ValueError:
            return False
        if not relative_path or not os.path.splitext(relative_path)[1]:
            return False
        file_ref = _sibling_file_ref(self._request_referer_file_ref(), relative_path)
        if not file_ref:
            return False
        root_dir = q.get("dir", "")
        try:
            candidate = _Ctx.backend.asset_path_for_file_ref(file_ref, root_dir=root_dir)
        except backend_mod.ForbiddenAssetError:
            self.send_response(403)
            self.send_header("content-length", str(len(b"Forbidden")))
            self.end_headers()
            if self.command != "HEAD":
                self.wfile.write(b"Forbidden")
            return True
        if not candidate:
            return False
        content_type = _Ctx.backend.content_type_for_path(candidate) or None
        return self._serve_static_file(candidate, content_type)

    def _serve_dist(self, path: str):
        # Static dist + SPA fallback (serve mode). dev mode serves the client via Vite.
        #
        # Every path that is not a bundle asset is a DIRECTORY the client will open
        # (the page URL's path is the absolute directory), so it must fall through to
        # index.html. That includes directory paths containing dots — `/Users/j/v0.4/models`
        # is a directory, not a missing file — which is why "has an extension" cannot be
        # the static-asset test here; only the bundle's own /assets/ prefix can be.
        dist_root = _Ctx.dist_root
        request_path = "/index.html" if path == "/" else path
        try:
            decoded = _strict_decode_uri_component(request_path)
        except ValueError:
            self._plain(400, "Bad request")
            return
        file_path = os.path.abspath(os.path.join(dist_root, decoded.lstrip("/")))
        inside_dist = file_path == dist_root or file_path.startswith(dist_root + os.sep)
        if not inside_dist and os.path.isfile(file_path):
            # Files outside dist are forbidden (never disclose one by path). A path
            # that is NOT a real file may still be a DIRECTORY the client opens —
            # the page URL's path IS the directory, and on Windows a drive-letter
            # path like /D:/... resolves outside dist — so it falls through to the
            # SPA below instead of 403ing.
            self._plain(403, "Forbidden")
            return
        if os.path.isfile(file_path):
            self._serve_static_file(file_path, content_type_for_static_asset(file_path) or None)
            return
        if request_path.startswith("/assets/"):
            self.send_response(404)
            self.send_header("content-type", "text/plain; charset=utf-8")
            self.send_header("cache-control", "no-store")
            self.send_header("content-length", str(len(b"Not found")))
            self.end_headers()
            if self.command != "HEAD":
                self.wfile.write(b"Not found")
            return
        index_html = os.path.join(dist_root, "index.html")
        if not self._serve_static_file(index_html, content_type_for_static_asset(index_html) or None):
            self.send_response(404)
            self.send_header("content-type", "text/plain; charset=utf-8")
            self.send_header("cache-control", "no-store")
            self.send_header("content-length", str(len(b"Not found")))
            self.end_headers()
            if self.command != "HEAD":
                self.wfile.write(b"Not found")

    def _plain(self, status: int, text: str):
        body = text.encode("utf-8")
        self.send_response(status)
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def _read_json_body(self):
        # Guard both failure modes of unbounded reads: a negative Content-Length
        # would make read() block until EOF (thread hung for the life of the
        # keep-alive connection), and no upper bound lets a single request balloon
        # memory (JSON + base64 x1.33) and disk. Mirrors api_server._read_body.
        try:
            length = int(self.headers.get("content-length") or 0)
        except (TypeError, ValueError) as exc:
            raise ValueError("Invalid Content-Length") from exc
        if length < 0:
            raise ValueError("Invalid Content-Length")
        if length > _MAX_LINK_BODY_BYTES:
            raise ValueError(f"Request body exceeds {_MAX_LINK_BODY_BYTES} bytes")
        raw = self.rfile.read(length) if length else b"{}"
        import json
        try:
            return json.loads(raw.decode("utf-8") or "{}")
        except (ValueError, UnicodeDecodeError) as exc:
            raise ValueError(f"Invalid JSON body: {exc}") from exc

    def _serve_test_lab(self):
        html_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "test_lab.html")
        if not self._serve_static_file(html_path, "text/html; charset=utf-8"):
            self._plain(404, "test-lab page not found")

    def _serve_asset(self, q, *, download: bool):
        if self.command not in ("GET", "HEAD"):
            self.send_response(405)
            self.send_header("allow", "GET")
            self.send_header("content-length", "0")
            self.end_headers()
            return
        file_ref = q.get("file", "")
        root_dir = self._root_dir(q)
        if q.get("task", "") and file_ref and not os.path.isabs(file_ref):
            # In task mode `file` is relative to the task directory.
            file_ref = os.path.join(root_dir, file_ref)
        resolved = _Ctx.backend.resolve_root(root_dir) if root_dir else None
        candidate = _Ctx.backend.asset_path_for_file_ref(file_ref, resolved_root=resolved, root_dir=root_dir)
        if not candidate or not os.path.isfile(candidate):
            self._send_json(404, {"error": "Not found"})
            return
        with open(candidate, "rb") as handle:
            data = handle.read()
        content_type = _Ctx.backend.content_type_for_path(candidate) or "application/octet-stream"
        disposition = None
        if download:
            disposition = enc.attachment_content_disposition(os.path.basename(candidate))
        self._send_bytes(200, data, content_type, disposition=disposition)

    def _artifact_build(self, q):
        root_dir = self._root_dir(q)
        catalog = _Ctx.backend.read_catalog(root_dir=root_dir, file_ref=q.get("file", ""))
        resolved = _Ctx.backend.resolve_root(root_dir)
        result = _Ctx.backend.resolve_artifact(q.get("file", ""), q.get("force", "") == "1", resolved, catalog)
        # Refresh the catalog AFTER the build (even on failure) and attach it, matching Node.
        next_catalog = _Ctx.backend.read_catalog(root_dir=root_dir, file_ref=q.get("file", ""))
        status = 500 if result.get("ok") is False else 200
        self._send_json(status, {**result, "catalog": next_catalog})

    def _cad_inject(self, q):
        """POST /__cad/inject?task=&file= — ensure the render package for a landed
        STEP carries the stepEntityId column WITHOUT rebuilding the GLB. Idempotent:
        the inline column check short-circuits; the legacy pythonocc injector runs
        only when the column is absent. Requires a feature-recognition sidecar."""
        task = q.get("task", "")
        file_ref = q.get("file", "")
        if not task or not file_ref:
            self._send_json(400, {"ok": False, "error": "task and file are required"})
            return
        root_dir = _resolve_task_dir(task)  # validated against the uploads root
        step_path = os.path.abspath(os.path.join(root_dir, file_ref.replace("\\", "/").lstrip("/")))
        if not (backend_mod.scanner.path_is_inside(step_path, root_dir)
                and os.path.splitext(step_path)[1].lower() in (".step", ".stp")
                and os.path.isfile(step_path)):
            self._send_json(404, {"ok": False, "error": "STEP not found in task"})
            return
        sidecar = backend_mod.find_features_sidecar(step_path)
        injected = bool(sidecar) and backend_mod.maybe_inject_step_entity_ids(step_path)
        self._send_json(200, {
            "ok": True,
            "injected": bool(injected),
            "hasSidecar": bool(sidecar),
            "sidecar": os.path.basename(sidecar) if sidecar else "",
        })

    def _export(self, q):
        root_dir = self._root_dir(q)
        catalog = _Ctx.backend.read_catalog(root_dir=root_dir, file_ref=q.get("file", ""))
        resolved = _Ctx.backend.resolve_root(root_dir)
        result = _Ctx.backend.generate_export(q.get("file", ""), q.get("format", "step") or "step", resolved, catalog)
        if result.get("cancelled"):
            self._send_json(200, {"ok": False, "cancelled": True})
            return
        if not result.get("ok"):
            self._send_json(400, {"ok": False, "error": result.get("error", "Export failed")})
            return
        payload = {"ok": True, "path": result["path"], "filename": result["filename"], "format": result["format"]}
        if result.get("catalogChanged"):
            payload["catalogChanged"] = True
        if result.get("fallback") and result.get("outputFileRef"):
            payload["fallback"] = True
            payload["downloadUrl"] = (
                f"/__cad/download?dir={enc.encode_uri_component(root_dir)}"
                f"&file={enc.encode_uri_component(result['outputFileRef'])}&asset=output"
            )
        self._send_json(200, payload)


def main(argv=None):
    parser = argparse.ArgumentParser(description="Python CAD Viewer backend")
    parser.add_argument("--port", type=int, default=server_info_mod.DEFAULT_VIEWER_PORT)
    parser.add_argument("--host", default=server_info_mod.DEFAULT_VIEWER_HOST)
    parser.add_argument("--dist-root", default="", help="built SPA dist directory (serve mode)")
    parser.add_argument("--debug", action="store_true",
                        help="return full error detail to clients (development only)")
    args = parser.parse_args(argv)

    # No served root: the request's URL path IS the directory (see Handler.do_GET).
    # cwd is only the fallback for a request that names no directory at all.
    directory_root = os.getcwd()
    if os.environ.get("VIEWER_CAD_BACKEND_VALIDATED") != "1":
        try:
            cadgen_bridge.require_cadgen_runtime(directory_root)
        except RuntimeError as exc:
            print(str(exc), file=sys.stderr)
            return 1
    _Ctx.directory_root = directory_root
    # viewer app root is the parent of this server_py package -> dist is <viewer>/dist.
    viewer_app_root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    _Ctx.dist_root = os.path.abspath(args.dist_root) if args.dist_root else os.path.join(viewer_app_root, "dist")
    _Ctx.port = server_info_mod.normalize_viewer_port(args.port)
    _Ctx.host = args.host
    _Ctx.debug = bool(args.debug)

    if not _is_loopback_host(args.host):
        print(
            f"WARNING: binding to non-loopback host {args.host!r}. The CAD Viewer is "
            "UNAUTHENTICATED and serves local files by URL path. Do not expose it "
            "beyond a trusted network; put it behind an authenticated reverse proxy "
            "for any external access.",
            file=sys.stderr,
        )
    _Ctx.backend = backend_mod.LocalAssetBackend()

    httpd = ThreadingHTTPServer((args.host, _Ctx.port), Handler)
    print(f"Python CAD Viewer backend listening on http://{args.host}:{_Ctx.port}/ (local-fs)")

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
    print("CAD Viewer backend stopped", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
