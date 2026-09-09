"""Client manager for the persistent pythonocc injection worker.

Owns the lifecycle of one :mod:`server_py.inject_worker` subprocess on behalf of
the long-lived server: lazy spawn, serialized request/response over stdio
JSON-RPC, respawn after crash/EOF, periodic recycle. Exposes :func:`inject_step`
matching what :func:`backend.maybe_inject_step_entity_ids` needs.

The interpreter is ``$VIEWER_PYTHONOCC_PYTHON`` (the same env var the old
per-part subprocess used) — a python with pythonocc-core. When it is unset or the
worker is disabled (``VIEWER_CAD_INJECT_WORKER=0``) the client raises
:class:`_InjectUnavailable`, and the backend falls back to per-GLB cold
subprocesses (the pre-daemon behaviour).
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import threading

# viewer/ — the dir holding the `server_py` package, so the worker resolves as
# `-m server_py.inject_worker` under the pythonocc interpreter.
_SERVER_PY_PARENT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def _pythonocc_python() -> str:
    """The configured pythonocc interpreter. Empty disables the daemon."""
    path = os.environ.get("VIEWER_PYTHONOCC_PYTHON", "").strip()
    return path if path and os.path.isfile(path) else ""


def _worker_enabled() -> bool:
    return str(os.environ.get("VIEWER_CAD_INJECT_WORKER", "1")).strip() not in {"0", "false", "no", ""}


def _request_timeout() -> float:
    try:
        return max(1.0, float(os.environ.get("VIEWER_CAD_INJECT_TIMEOUT", "300")))
    except ValueError:
        return 300.0


def _recycle_after() -> int:
    try:
        return max(0, int(os.environ.get("VIEWER_CAD_INJECT_RECYCLE", "200")))
    except ValueError:
        return 200


class _InjectUnavailable(RuntimeError):
    """No pythonocc interpreter / daemon disabled — backend falls back to cold."""


class _InjectTransportError(RuntimeError):
    """Worker spawn/IO/EOF fault. Respawn-worthy; the caller may retry once."""


class _InjectTimeout(_InjectTransportError):
    """Worker did not answer. The request is dead; recycle, do not retry."""


class InjectWorker:
    """Manages a single pythonocc worker subprocess. Thread-safe; requests serialized
    (pythonocc is single-threaded — same constraint as the CAD worker)."""

    def __init__(self) -> None:
        self._lock = threading.RLock()
        self._proc: subprocess.Popen | None = None
        self._next_id = 0
        self._invokes = 0

    # --- process lifecycle --------------------------------------------------------
    def _alive(self) -> bool:
        return self._proc is not None and self._proc.poll() is None

    def _spawn(self) -> None:
        self._reap()
        python = _pythonocc_python()
        if not python:
            raise _InjectUnavailable("VIEWER_PYTHONOCC_PYTHON not configured")
        env = dict(os.environ)
        env["PYTHONPATH"] = _SERVER_PY_PARENT
        stderr = None if str(os.environ.get("VIEWER_CAD_INJECT_WORKER_STDERR")) == "1" else subprocess.DEVNULL
        try:
            self._proc = subprocess.Popen(
                [python, "-m", "server_py.inject_worker"],
                env=env,
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=stderr,
                text=True,
                bufsize=1,
            )
        except OSError as exc:
            self._proc = None
            raise _InjectTransportError(f"could not spawn inject worker: {exc}") from exc
        self._invokes = 0

    def _reap(self) -> None:
        proc, self._proc = self._proc, None
        if proc is None:
            return
        try:
            if proc.poll() is None:
                proc.terminate()
                try:
                    proc.wait(timeout=2)
                except subprocess.TimeoutExpired:
                    proc.kill()
        except OSError:
            pass
        for stream in (proc.stdin, proc.stdout, proc.stderr):
            if stream is not None:
                try:
                    stream.close()
                except OSError:
                    pass

    def close(self) -> None:
        with self._lock:
            proc = self._proc
            if proc is not None and proc.poll() is None and proc.stdin is not None:
                try:
                    proc.stdin.write(json.dumps({"jsonrpc": "2.0", "id": 0, "method": "shutdown"}) + "\n")
                    proc.stdin.flush()
                    proc.wait(timeout=2)
                except (OSError, ValueError, subprocess.TimeoutExpired):
                    pass
            self._reap()

    # --- request/response ---------------------------------------------------------
    def _readline_timed(self, proc, timeout: float) -> str:
        holder: dict = {}
        done = threading.Event()

        def _reader() -> None:
            try:
                holder["line"] = proc.stdout.readline()
            except Exception as exc:  # noqa: BLE001 — surfaced below
                holder["error"] = exc
            finally:
                done.set()

        thread = threading.Thread(target=_reader, name="inject-worker-readline", daemon=True)
        thread.start()
        if not done.wait(timeout):
            raise _InjectTimeout(f"inject worker did not answer within {timeout:g}s")
        if "error" in holder:
            raise _InjectTransportError(f"inject worker read failed: {holder['error']}") from holder["error"]
        return holder.get("line", "")

    def _send_once(self, params: dict) -> dict:
        if not self._alive():
            self._spawn()
        proc = self._proc
        assert proc is not None and proc.stdin is not None and proc.stdout is not None
        self._next_id += 1
        req_id = self._next_id
        frame = {"jsonrpc": "2.0", "id": req_id, "method": "inject", "params": params}
        try:
            proc.stdin.write(json.dumps(frame) + "\n")
            proc.stdin.flush()
        except (OSError, ValueError) as exc:
            raise _InjectTransportError(f"inject worker stdin write failed: {exc}") from exc
        line = self._readline_timed(proc, _request_timeout())
        if line == "":  # worker died mid-request (pythonocc segfault etc.)
            raise _InjectTransportError("inject worker closed the connection (no response)")
        try:
            response = json.loads(line)
        except ValueError as exc:
            raise _InjectTransportError(f"inject worker sent a non-JSON frame: {line[:200]!r}") from exc
        if "error" in response:
            err = response["error"] or {}
            raise _InjectTransportError(f"inject worker error: {err.get('message')}")
        return response.get("result") or {}

    def _request(self, params: dict) -> dict:
        """Send one injection request; recycle-before-request; respawn ONCE on a
        transport fault; a timeout is never retried (the request is dead)."""
        with self._lock:
            recycle = _recycle_after()
            if recycle and self._invokes >= recycle:
                self._reap()
            try:
                result = self._send_once(params)
            except _InjectTimeout:
                self._reap()
                raise
            except _InjectTransportError:
                self._reap()
                result = self._send_once(params)
            self._invokes += 1
            return result

    def inject(self, step_path: str, glbs: list[str]) -> dict:
        """Inject stepEntityId into every GLB of ``step_path`` in one worker round
        trip (entity map extracted once). Returns the worker result dict."""
        return self._request({"step": step_path, "glbs": list(glbs)})


_INJECTOR: InjectWorker | None = None
_INJECTOR_LOCK = threading.Lock()


def get_injector() -> InjectWorker:
    global _INJECTOR
    with _INJECTOR_LOCK:
        if _INJECTOR is None:
            _INJECTOR = InjectWorker()
            import atexit

            atexit.register(_INJECTOR.close)
        return _INJECTOR


def inject_step(step_path: str, glbs: list[str]) -> dict:
    """Daemon path for stepEntityId injection. Raises :class:`_InjectUnavailable`
    when the pythonocc daemon cannot run (caller falls back to cold subprocesses)."""
    if not _worker_enabled() or not _pythonocc_python():
        raise _InjectUnavailable("inject worker disabled or VIEWER_PYTHONOCC_PYTHON unset")
    return get_injector().inject(step_path, glbs)
