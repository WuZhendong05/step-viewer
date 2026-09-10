"""Client manager for the persistent warm-OCCT CAD worker (viewer-specific).

Owns the lifecycle of one :mod:`server_py.worker` subprocess on behalf of the
long-lived server: lazy spawn, serialized request/response over stdio JSON-RPC,
transparent respawn after a crash/EOF, and periodic recycle to bound the OCP
kernel's memory growth. Exposes :func:`run_cadgen` with the same
``(module, args, repo_root) -> dict`` contract as the cold-subprocess bridge, so it
is a drop-in for the heavy STEP build/export path.

OCP is single-threaded, so all requests are serialized under one lock — matching
the effective serialization of the previous per-request subprocess model, but warm.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import threading

from . import cadgen_bridge

# viewer/ (dev) or the bundled runtime root — the dir that holds the `server_py`
# package, so the worker resolves as `-m server_py.worker`.
_SERVER_PY_PARENT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def _worker_enabled() -> bool:
    """Warm worker is on by default; VIEWER_CAD_WORKER=0 forces the cold path."""
    return str(os.environ.get("VIEWER_CAD_WORKER", "1")).strip() not in {"0", "false", "no", ""}


def _recycle_after() -> int:
    try:
        return max(0, int(os.environ.get("VIEWER_CAD_WORKER_RECYCLE", "200")))
    except ValueError:
        return 200


class _WorkerError(RuntimeError):
    """Raised on a worker fault so the bridge can fall back to the cold subprocess."""


class _WorkerTransportError(_WorkerError):
    """A spawn/IO/EOF fault (the worker is gone or unhealthy). Respawn-worthy —
    distinct from a clean JSON-RPC ``error`` response, which means the worker is
    alive and simply rejected the request (no respawn)."""


class _WorkerTimeout(_WorkerTransportError):
    """The worker did not answer within the timeout. The request is DEAD (a hung
    OCP parse never finishes), so it must NOT be retried on a fresh worker — only
    the process gets recycled. cadgen_bridge treats this specially and does NOT
    fall back to a cold subprocess (which would burn another full timeout on the
    same pathological file)."""


def _request_timeout() -> float:
    """Seconds a single worker request may take before the worker is recycled.
    A generous default: real multi-minute builds exist; only a truly hung OCP
    parse should trip it."""
    try:
        return max(1.0, float(os.environ.get("VIEWER_CAD_WORKER_TIMEOUT", "600")))
    except ValueError:
        return 600.0


class CadWorker:
    """Manages a single warm worker subprocess. Thread-safe; requests serialized."""

    def __init__(self) -> None:
        self._lock = threading.RLock()
        # Pool slot: a NON-BLOCKING ownership flag used by the pool to tell whether
        # this worker is idle. The actual request serialization still uses _lock;
        # _slot is only a "is someone using me right now" signal for dispatch.
        self._slot = threading.Lock()
        self._proc: subprocess.Popen | None = None
        self._next_id = 0
        self._invokes = 0

    # --- process lifecycle -------------------------------------------------------
    def _env_for(self, repo_root: str) -> dict:
        env = dict(os.environ)
        parts = [_SERVER_PY_PARENT]
        pythonpath = cadgen_bridge.cadgen_pythonpath(repo_root)
        if pythonpath:
            parts.append(pythonpath)
        env["PYTHONPATH"] = os.pathsep.join(p for p in parts if p)
        # Byte-deterministic artifacts (drawing packages are content-addressed):
        # ezdxf's object ordering depends on Python hash randomization.
        env.setdefault("PYTHONHASHSEED", "0")
        return env

    def _alive(self) -> bool:
        return self._proc is not None and self._proc.poll() is None

    def _spawn(self, repo_root: str) -> None:
        self._reap()
        stderr = None if str(os.environ.get("VIEWER_CAD_WORKER_STDERR")) == "1" else subprocess.DEVNULL
        try:
            self._proc = subprocess.Popen(
                [sys.executable, "-m", "server_py.worker"],
                cwd=repo_root if repo_root and os.path.isdir(repo_root) else None,
                env=self._env_for(repo_root),
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=stderr,
                text=True,
                bufsize=1,
            )
        except OSError as exc:
            self._proc = None
            raise _WorkerTransportError(f"could not spawn CAD worker: {exc}") from exc
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
                try:  # best-effort graceful shutdown
                    proc.stdin.write(json.dumps({"jsonrpc": "2.0", "id": 0, "method": "shutdown"}) + "\n")
                    proc.stdin.flush()
                    proc.wait(timeout=2)
                except (OSError, ValueError, subprocess.TimeoutExpired):
                    pass
            self._reap()

    # --- request/response --------------------------------------------------------
    def _readline_timed(self, proc, timeout: float) -> str:
        """``proc.stdout.readline()`` bounded by ``timeout`` seconds.

        A reader thread does the blocking read (select/readline timeouts are not
        portable on Windows pipes); the caller waits on an Event. On timeout the
        caller must reap the worker — the old reader thread then unblocks on EOF
        once the process dies and the stream is closed.
        """
        holder: dict = {}
        done = threading.Event()

        def _reader() -> None:
            try:
                holder["line"] = proc.stdout.readline()
            except Exception as exc:  # noqa: BLE001 — surfaced below
                holder["error"] = exc
            finally:
                done.set()

        thread = threading.Thread(target=_reader, name="cad-worker-readline", daemon=True)
        thread.start()
        if not done.wait(timeout):
            raise _WorkerTimeout(f"worker did not answer within {timeout:g}s")
        if "error" in holder:
            raise _WorkerTransportError(f"worker read failed: {holder['error']}") from holder["error"]
        return holder.get("line", "")

    def _send_once(self, repo_root: str, method: str, params: dict) -> dict:
        if not self._alive():
            self._spawn(repo_root)
        proc = self._proc
        assert proc is not None and proc.stdin is not None and proc.stdout is not None
        self._next_id += 1
        req_id = self._next_id
        frame = {"jsonrpc": "2.0", "id": req_id, "method": method, "params": params}
        try:
            proc.stdin.write(json.dumps(frame) + "\n")
            proc.stdin.flush()
        except (OSError, ValueError) as exc:
            raise _WorkerTransportError(f"worker stdin write failed: {exc}") from exc
        line = self._readline_timed(proc, _request_timeout())
        if line == "":  # EOF: the worker died (e.g. OCP segfault)
            raise _WorkerTransportError("worker closed the connection (no response)")
        try:
            response = json.loads(line)
        except ValueError as exc:
            raise _WorkerTransportError(f"worker sent a non-JSON frame: {line[:200]!r}") from exc
        if response.get("id") != req_id:
            raise _WorkerTransportError(f"worker id mismatch: want {req_id}, got {response.get('id')}")
        if "error" in response:  # worker is healthy but rejected the request -> no respawn
            err = response["error"] or {}
            raise _WorkerError(f"worker protocol error: {err.get('message')}")
        return response.get("result") or {}

    def _request(self, repo_root: str, method: str, params: dict) -> dict:
        """Send a request, respawning once on a TRANSPORT fault before giving up. A
        clean protocol-error response propagates without a respawn, and a TIMEOUT is
        never retried (the request itself is dead — recycling the worker is enough)."""
        import sys as _sys
        import time as _t

        timing = os.environ.get("VIEWER_TIMING_LOG") == "1"
        t0 = _t.perf_counter()
        with self._lock:
            t_lock = _t.perf_counter()
            recycle = _recycle_after()
            if recycle and self._invokes >= recycle:
                self._reap()  # bound OCP memory: recycle the warm process
            try:
                result = self._send_once(repo_root, method, params)
            except _WorkerTimeout:
                self._reap()
                raise
            except _WorkerTransportError:
                self._reap()
                result = self._send_once(repo_root, method, params)  # one clean retry
            self._invokes += 1
            if timing:
                # lockWait is pure queueing behind other builds in this ONE serial
                # worker; rpc is the actual OCP work (parse + tessellate + inject).
                t_done = _t.perf_counter()
                print(
                    f"[timing] worker lockWait={t_lock - t0:.3f}s "
                    f"rpc={t_done - t_lock:.3f}s total={t_done - t0:.3f}s method={method}",
                    file=_sys.stderr,
                )
            return result

    def run_cadgen(self, module: str, args, repo_root: str) -> dict:
        return self._request(
            repo_root, "invoke", {"module": module, "args": list(args), "repo_root": repo_root}
        )

    def ping(self, repo_root: str = "") -> dict:
        """Spawn-if-needed and round-trip a health check (OCP is not imported)."""
        return self._request(repo_root, "ping", {})


def _worker_count() -> int:
    """Number of warm OCP worker processes (VIEWER_CAD_WORKERS).

    OCP is single-threaded, so one worker = one serial build lane. cadgen's
    generation lock is PER PACKAGE, so independent parts build safely in
    parallel — the pool turns the single lane into N lanes. Default 1 keeps the
    historical behaviour/memory profile; raise it on multi-core hosts.
    """
    try:
        return max(1, int(os.environ.get("VIEWER_CAD_WORKERS", "1")))
    except ValueError:
        return 1


_POOL: list[CadWorker] = []
_POOL_LOCK = threading.Lock()
_RR = 0


def _ensure_pool() -> list[CadWorker]:
    global _POOL
    with _POOL_LOCK:
        want = _worker_count()
        if len(_POOL) < want:
            import atexit

            for _ in range(want - len(_POOL)):
                worker = CadWorker()
                atexit.register(worker.close)
                _POOL.append(worker)
        return _POOL


def _pick() -> CadWorker:
    """Idle-first dispatch, round-robin fallback when every worker is busy."""
    global _RR
    pool = _ensure_pool()
    for worker in pool:
        if not worker._slot.locked():
            return worker
    with _POOL_LOCK:
        worker = pool[_RR % len(pool)]
        _RR += 1
    return worker


def get_client() -> CadWorker:
    """Single-worker accessor (health checks / callers that want one lane)."""
    return _ensure_pool()[0]


def run_cadgen(module: str, args, repo_root: str) -> dict:
    """Warm-worker equivalent of :func:`cadgen_bridge.run_cadgen`. Raises
    :class:`_WorkerError` on a transport/spawn fault (caller falls back to cold).

    Dispatches to the least-busy worker in the pool: independent parts build in
    parallel (cadgen locks per package), while a fully busy pool queues on the
    picked worker's slot exactly like the old single-worker model.
    """
    if not _worker_enabled():
        raise _WorkerError("warm worker disabled (VIEWER_CAD_WORKER=0)")
    worker = _pick()
    worker._slot.acquire()  # blocks only when every worker is busy (queueing)
    try:
        return worker.run_cadgen(module, args, repo_root)
    finally:
        worker._slot.release()
