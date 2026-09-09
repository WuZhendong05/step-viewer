# -*- coding: utf-8 -*-
"""STEP entity-id extraction + GLB stepEntityId column injection (pythonocc channel).

This is the LEGACY (fallback) injector: since the inline OCP injection landed in
``cadgen/_internal/step_entity_ids.py``, the normal build path writes the column at
build time and this module is only invoked when a package lacks the column.

Reconstructed from the validated behaviour (71 files / ~3,700 faces ground truth)
after the workspace loss; the GLB manifest layout was re-derived from real packages:

  * ``extensions.STEP_topology.selectorView`` = index of the LAST bufferView, whose
    payload is the selector manifest as UTF-8 JSON (tables.faceColumns / faces rows).
  * Injection = append a ``stepEntityId`` value per face row + declare the column,
    then re-serialise the manifest in place (last view -> tail append is safe).
  * Row->entity pairing uses surfaceType reconciliation; a mismatch or a zero id
    writes 0 (fail-safe: never a wrong id).

CLI:
    python step_feature_augment.py --step <file> --glb <glb> [--glb <glb> ...]
Exit codes: 0 ok, 2 zero-guard (no entity ids extractable), 3 hard failure.
"""
from __future__ import annotations

import argparse
import json
import struct
import sys

_STMAP = {0: "plane", 1: "cylinder", 2: "cone", 3: "sphere", 4: "torus"}
_ALIAS = {"pl": "plane", "cy": "cylinder", "co": "cone", "cn": "cone",
          "sp": "sphere", "to": "torus"}


# ---------------------------------------------------------------- GLB layer ----

def read_glb(path: str):
    """Return (gltf_dict, binary_bytes) from a GLB container."""
    with open(path, "rb") as handle:
        data = handle.read()
    if data[:4] != b"glTF":
        raise ValueError("not a GLB container")
    total = struct.unpack("<I", data[8:12])[0]
    if len(data) < total:
        raise ValueError("truncated GLB")
    json_len, _json_type = struct.unpack("<I4s", data[12:20])
    gltf = json.loads(data[20:20 + json_len].decode("utf-8"))
    bin_off = 20 + json_len
    bin_len, _bin_type = struct.unpack("<I4s", data[bin_off:bin_off + 8])
    binary = data[bin_off + 8: bin_off + 8 + bin_len]
    return gltf, binary


def read_selector_manifest(gltf: dict, binary: bytes) -> dict:
    """Decode the STEP_topology selector manifest (last bufferView, UTF-8 JSON)."""
    ext = (gltf.get("extensions") or {}).get("STEP_topology") or {}
    view = ext.get("selectorView")
    if view is None:
        raise ValueError("GLB has no STEP_topology selectorView")
    bv = (gltf.get("bufferViews") or [])[view]
    raw = binary[bv["byteOffset"]: bv["byteOffset"] + bv["byteLength"]]
    return json.loads(raw.decode(ext.get("encoding", "utf-8")))


def write_glb(path: str, gltf: dict, binary: bytes) -> None:
    json_bytes = json.dumps(gltf, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    json_bytes += b" " * ((4 - len(json_bytes) % 4) % 4)
    bin_data = binary + b"\x00" * ((4 - len(binary) % 4) % 4)
    total = 12 + 8 + len(json_bytes) + 8 + len(bin_data)
    out = (b"glTF"
           + struct.pack("<II", 2, total)
           + struct.pack("<I4s", len(json_bytes), b"JSON")
           + json_bytes
           + struct.pack("<I4s", len(binary), b"BIN\x00")
           + bin_data)
    with open(path, "wb") as handle:
        handle.write(out)


def _norm_type(text) -> str:
    value = str(text).strip().lower()
    return _ALIAS.get(value, value)


# ----------------------------------------------------------- pythonocc side ----

def extract_entity_map(step_path: str) -> dict:
    """ordinal(1-based, TopExp_Explorer face order) -> {entityId, surfaceType}.

    Uses pythonocc's IdentLabel — the only channel proven to return the REAL file
    entity number (OCP's binding returns 0 for every face).
    """
    from OCC.Core.STEPControl import STEPControl_Reader
    from OCC.Core.TopExp import TopExp_Explorer
    from OCC.Core.TopAbs import TopAbs_FACE
    from OCC.Core.BRepAdaptor import BRepAdaptor_Surface
    from OCC.Core import TopoDS as _tds_mod

    # pythonocc 7.7 binds the downcast as module-level TopoDS.Face; OCP uses Face_s
    face_cast = getattr(_tds_mod, "Face_s", None) or _tds_mod.Face

    reader = STEPControl_Reader()
    if reader.ReadFile(str(step_path)) != 1:  # IFSelect_RetDone
        raise RuntimeError(f"STEP read failed: {step_path}")
    reader.TransferRoots()
    shape = reader.OneShape()
    model = reader.StepModel()
    ws = reader.WS()
    transfer_reader = ws.TransferReader()

    out: dict = {}
    ordinal = 0
    explorer = TopExp_Explorer(shape, TopAbs_FACE)
    while explorer.More():
        ordinal += 1
        face = face_cast(explorer.Current())
        entry = {"entityId": 0, "surfaceType": "?", "radius": None}
        try:
            item = transfer_reader.EntityFromShapeResult(face, 1)
            if item is not None:
                label = model.IdentLabel(item)
                if label:
                    entry["entityId"] = int(label)
        except Exception:  # noqa: BLE001 — per-face, keep scanning
            pass
        try:
            adaptor = BRepAdaptor_Surface(face)
            entry["surfaceType"] = _STMAP.get(int(adaptor.GetType()), "other")
        except Exception:  # noqa: BLE001
            entry["surfaceType"] = "other"
        out[ordinal] = entry
        explorer.Next()
    return out


def inject_step_entity_column(gltf: dict, binary: bytes, entity_map: dict):
    """Append the stepEntityId column to the manifest; returns (gltf, binary).

    Idempotent: a manifest that already declares the column is returned untouched.
    The selector manifest must be the LAST bufferView (tail append is safe); a
    different layout refuses rather than corrupting the file. Signature is the
    contract consumed by ``server_py/inject_worker.py`` — do not change arity.
    """
    ext = (gltf.get("extensions") or {}).get("STEP_topology") or {}
    view = ext.get("selectorView")
    if view is None:
        raise ValueError("GLB has no STEP_topology selectorView")
    views = gltf.get("bufferViews") or []
    bv = views[view]

    manifest = json.loads(binary[bv["byteOffset"]: bv["byteOffset"] + bv["byteLength"]]
                          .decode(ext.get("encoding", "utf-8")))
    cols = manifest["tables"]["faceColumns"]
    if "stepEntityId" in cols:
        return gltf, binary  # already injected (idempotent)
    # Tail-append safety: the selector manifest must be the LAST bufferView (the
    # buffer may carry up to 4 bytes of alignment padding after it).
    if view != len(views) - 1 or bv["byteOffset"] + bv["byteLength"] > \
            (gltf.get("buffers") or [{}])[0].get("byteLength", 0):
        raise ValueError("selectorView is not the last bufferView — refusing to inject")
    ordinal_i = cols.index("ordinal")
    type_i = cols.index("surfaceType")
    for row in manifest["faces"]:
        entity_id = 0
        info = entity_map.get(int(row[ordinal_i]))
        if info and _norm_type(row[type_i]) == _norm_type(info.get("surfaceType", "?")):
            entity_id = int(info.get("entityId") or 0)
        row.append(entity_id)
    manifest["tables"]["faceColumns"].append("stepEntityId")

    payload = json.dumps(manifest, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    new_binary = binary[:bv["byteOffset"]] + payload
    bv["byteLength"] = len(payload)
    gltf["buffers"][0]["byteLength"] = bv["byteOffset"] + len(payload)
    return gltf, new_binary


# ------------------------------------------------------------------- CLI -------

def main(argv=None):
    parser = argparse.ArgumentParser(description="Inject stepEntityId column into GLB selector manifests")
    parser.add_argument("--step", required=True)
    parser.add_argument("--glb", action="append", required=True)
    args = parser.parse_args(argv)

    entity_map = extract_entity_map(args.step)
    with_ids = sum(1 for v in entity_map.values() if v.get("entityId"))
    print(f"实体提取: {len(entity_map)} 面, 有 id {with_ids}")
    if with_ids == 0:
        # Zero-guard: writing an all-zero column would neuter the frontend mapping
        # AND make every future injection idempotent-skip. Fail loudly instead.
        print("ZERO-GUARD: no entity ids extractable from STEP", file=sys.stderr)
        return 2

    ok_glbs = 0
    for glb in args.glb:
        try:
            gltf, binary = read_glb(glb)
        except Exception as exc:  # noqa: BLE001
            print(f"{glb}: bad GLB: {exc}", file=sys.stderr)
            continue
        try:
            gltf, binary = inject_step_entity_column(gltf, binary, entity_map)
        except ValueError as exc:
            print(f"{glb}: skipped: {exc}", file=sys.stderr)
            continue
        except Exception as exc:  # noqa: BLE001
            print(f"{glb}: injection failed: {exc}", file=sys.stderr)
            continue
        write_glb(glb, gltf, binary)
        # Re-read to report the match rate (also validates the rewritten container).
        _gltf2, _bin2 = read_glb(glb)
        manifest = read_selector_manifest(_gltf2, _bin2)
        cols = manifest["tables"]["faceColumns"]
        oi, ti, si = cols.index("ordinal"), cols.index("surfaceType"), cols.index("stepEntityId")
        matched = sum(1 for row in manifest["faces"]
                      if row[si] and _norm_type(row[ti]) == _norm_type(
                          entity_map.get(int(row[oi]), {}).get("surfaceType", "?")))
        ok_glbs += 1
        print(f"对账匹配: {matched}/{len(manifest['faces'])}, 写入 {glb}")
    print(f"注入完成: {ok_glbs}/{len(args.glb)} glb")
    return 0 if ok_glbs == len(args.glb) else 3


if __name__ == "__main__":
    sys.exit(main())
