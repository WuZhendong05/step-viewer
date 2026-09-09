"""Persistent pythonocc worker for STEP entity-id injection (viewer-specific).

Mirror of :mod:`server_py.worker` (the warm-OCCT CAD worker), but for the feature
injection step: it imports pythonocc-core ONCE and services many
:func:`tools.step_feature_augment` injections in-process, so the ~1s pythonocc
import + STEP re-read cost is paid once per process instead of once per uploaded
part (measured: per-part cold injection 1.64s vs warm ~0.5s).

Protocol — newline-delimited JSON-RPC 2.0 on stdio (same shape as worker.py):

  request : {"jsonrpc":"2.0","id":N,"method":"inject",
             "params":{"step":"<abs step>","glbs":["<abs glb>", ...]}}
  response: {"jsonrpc":"2.0","id":N,"result":{"ok":true,
             "results":[{"glb":"...","ok":true,"matched":106,"total":106,"skipped":false}]}}

``extract_entity_map`` runs ONCE per step and is shared across all ``glbs`` of that
step (an assembly with N component GLBs pays one STEP parse, not N).

stdout is reserved for protocol frames: fd 1 is redirected to fd 2 at startup and
frames go to a dup() of the original stdout (identical isolation trick to worker.py).
"""

from __future__ import annotations

import json
import os
import sys

# --- stdout isolation: do this BEFORE importing anything that may print ----------
_RPC_OUT_FD = os.dup(1)  # keep the real stdout (the pipe to the client) for frames
os.dup2(2, 1)  # fd 1 -> stderr; later stdout (incl. pythonocc noise) -> stderr
_RPC_OUT = os.fdopen(_RPC_OUT_FD, "w", buffering=1, encoding="utf-8")
sys.stdout = sys.stderr

# tools/step_feature_augment.py lives at <repo>/tools (three dirs up from this file,
# whose parent is viewer/server_py). It imports pythonocc lazily inside its
# functions, so importing it in this pythonocc process is safe.
_REPO_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
_TOOLS_DIR = os.path.join(_REPO_ROOT, "tools")
sys.path.insert(0, _TOOLS_DIR)

_FAILURE_REASONS = {
    "no_entity_ids": "could not extract any STEP entity id "
                     "(pythonocc binding lacks IdentLabel support; use an OCC env)",
    "not_glb": "not a GLB file",
    "no_manifest": "GLB has no STEP_topology selector manifest",
    "bad_glb": "GLB read/rewrite failed",
}

# Imported lazily so `-m server_py.inject_worker` fails fast only when actually used.
_augment = None


def _load_augment():
    global _augment
    if _augment is None:
        from step_feature_augment import (  # noqa: PLC0415
            extract_entity_map,
            inject_step_entity_column,
            read_glb,
            read_selector_manifest,
            write_glb,
        )

        _augment = (extract_entity_map, inject_step_entity_column, read_glb, read_selector_manifest, write_glb)
    return _augment


def _inject_one(step: str, glb: str) -> dict:
    extract_entity_map, inject_step_entity_column, read_glb, read_selector_manifest, write_glb = _load_augment()
    entry = {"glb": glb, "ok": False, "skipped": False}
    try:
        entity_map = extract_entity_map(step)
    except Exception as exc:  # noqa: BLE001 — surfaced per-glb
        entry["error"] = f"entity extraction failed: {exc}"
        return entry
    with_entity = sum(1 for v in entity_map.values() if v.get("entityId"))
    if with_entity == 0:
        entry["error"] = _FAILURE_REASONS["no_entity_ids"]
        return entry
    try:
        gltf, binary = read_glb(glb)
    except Exception as exc:  # noqa: BLE001
        entry["error"] = f"{_FAILURE_REASONS['bad_glb']}: {exc}"
        return entry
    if not (gltf.get("extensions") or {}).get("STEP_topology"):
        entry["error"] = _FAILURE_REASONS["no_manifest"]
        return entry
    try:
        # Cheap idempotency probe BEFORE any rewrite: the stepEntityId column lives
        # in the selectorView manifest inside the binary chunk, not in the top-level
        # gltf extensions (only buffer indices are there). Skip == leave file untouched.
        manifest = read_selector_manifest(gltf, binary)
        columns = (manifest.get("tables") or {}).get("faceColumns")
        if isinstance(columns, list) and "stepEntityId" in columns:
            entry.update({"ok": True, "skipped": True})
            return entry
        gltf2, new_binary = inject_step_entity_column(gltf, binary, entity_map)
        write_glb(glb, gltf2, new_binary)
        entry.update({"ok": True, "matched": None, "total": len(entity_map)})
        return entry
    except Exception as exc:  # noqa: BLE001
        entry["error"] = f"{_FAILURE_REASONS['bad_glb']}: {exc}"
        return entry


def _handle(params: dict) -> dict:
    step = str(params.get("step") or "")
    glbs = list(params.get("glbs") or [])
    if not step or not glbs:
        return {"ok": False, "results": [], "error": "step and glbs are required"}
    results = [_inject_one(step, glb) for glb in glbs]
    ok = all(r.get("ok") for r in results)
    return {"ok": ok, "results": results}


def _write(frame: dict) -> None:
    _RPC_OUT.write(json.dumps(frame, separators=(",", ":")))
    _RPC_OUT.write("\n")
    _RPC_OUT.flush()


def serve(stdin=None) -> int:
    stream = stdin if stdin is not None else sys.stdin
    for line in stream:
        line = line.strip()
        if not line:
            continue
        try:
            request = json.loads(line)
        except ValueError:
            _write({"jsonrpc": "2.0", "id": None, "error": {"code": -32700, "message": "Invalid JSON"}})
            continue
        req_id = request.get("id")
        method = request.get("method")
        try:
            if method == "inject":
                result = _handle(request.get("params") or {})
                _write({"jsonrpc": "2.0", "id": req_id, "result": result})
            elif method == "ping":
                _write({"jsonrpc": "2.0", "id": req_id, "result": {"ok": True, "pid": os.getpid()}})
            elif method == "shutdown":
                _write({"jsonrpc": "2.0", "id": req_id, "result": {"ok": True}})
                break
            else:
                _write({"jsonrpc": "2.0", "id": req_id,
                        "error": {"code": -32601, "message": f"Unknown method: {method!r}"}})
        except Exception as exc:  # noqa: BLE001 — one bad request must not kill the loop
            _write({"jsonrpc": "2.0", "id": req_id, "error": {"code": -32603, "message": str(exc)}})
    return 0


if __name__ == "__main__":
    raise SystemExit(serve())
