"""Inline STEP entity-id resolution for the GLB selector manifest (viewer feature).

Write the ``stepEntityId`` column (STEP entity number #N per face) INTO the GLB at
build time, in the same OCP process that tessellates — one STEP parse, no pythonocc.

Method (validated: 71 business files / ~3,700 faces, 100% hit, 0 ambiguity,
0 mismatch vs pythonocc ground truth):

  * OCP loads entities in file-definition order, so ``model.Entity(i)`` is the i-th
    definition whose REAL file number (#N) may differ from i (non-sequential
    exporters). A cheap TEXT-layer pass records ``rec[k] = #id of the k-th "#n ="``.
  * Per face: ``EntityFromShapeResult(face, 1)`` -> scan ``model.Entity(i) == item``
    -> rank i -> real id ``rec[i-1]``.
  * Component GLBs are built from REBUILT geometry (build123d compound, no STEP
    session), so object identity does not survive. Faces are therefore paired by
    GEOMETRIC FINGERPRINT: (surfaceType, area, centroid) matched with tolerance
    (mesh vs analytic area differs ~1e-3..3.5e-3, centroid ~5e-3).
  * B-spline-parameterised cones/cylinders are typed 6 (BSplineSurface) by OCP but
    ``cone``/``cylinder`` by cadgen, so type-6 source faces join every candidate set;
    free-form BSpline faces are filtered out by the tolerance + ambiguity guard.

Fail-open everywhere: any problem yields id 0 on that row and never breaks the build.
Kill switch: CADGEN_INLINE_ENTITY_IDS=0 restores the legacy (no-column) behaviour so
the pythonocc injector stays authoritative.
"""

from __future__ import annotations

import os
import re
import threading

from OCP.TopAbs import TopAbs_FACE
from OCP.TopExp import TopExp
from OCP.TopTools import TopTools_IndexedMapOfShape
from OCP.BRepAdaptor import BRepAdaptor_Surface
from OCP.BRepGProp import BRepGProp
from OCP.GProp import GProp_GProps
from OCP.TopoDS import TopoDS

# --- matching tolerances (calibrated on 71 business files) ----------------------
REL_AREA = 1e-2        # mesh vs analytic relative area diff (cones measured ~3.5e-3)
ABS_CENTER = 0.05      # centroid distance (measured ~5e-3)
_AMB_GAP = 0.05        # reject when the runner-up is this close (fail-safe -> 0)

_MAX_ENTITIES = int(os.environ.get("CADGEN_ENTITY_SCAN_MAX", "50000"))
_DEF_RE = re.compile(r"^\s*#(\d+)\s*=")

_STMAP = {"plane": 0, "cylinder": 1, "cone": 2, "sphere": 3, "torus": 4}
_ALIAS = {"pl": "plane", "cy": "cylinder", "co": "cone", "cn": "cone",
          "sp": "sphere", "to": "torus"}

# Source-side fingerprint index for the CURRENT build request. The warm worker
# handles one build at a time (global lock), and the source load always precedes
# the component extract, so a single slot is sufficient and avoids mixing parts.
# Rows: (st, area, cx, cy, cz, rid)
_SOURCE: list[tuple[int, float, float, float, float, int]] = []
_SOURCE_KEY = ""
_LOCK = threading.Lock()

# (abspath, size, mtime_ns) -> [(real #id, text type)] definition index, per process.
_DEFS: dict[tuple[str, int, int], list[tuple[int, str]]] = {}
_DEFS_LOCK = threading.Lock()


def enabled() -> bool:
    """Inline injection is ON by default; CADGEN_INLINE_ENTITY_IDS=0 disables it."""
    return str(os.environ.get("CADGEN_INLINE_ENTITY_IDS", "1")).strip() not in {"0", "false", "no"}


def build_definition_index(step_path: str) -> list[tuple[int, str]]:
    """Text layer: definition lines in file order -> [(real #id, type)]. Cached."""
    try:
        stats = os.stat(step_path)
        key = (os.path.abspath(step_path), stats.st_size, stats.st_mtime_ns)
    except OSError:
        return []
    with _DEFS_LOCK:
        cached = _DEFS.get(key)
        if cached is not None:
            return cached
    rec: list[tuple[int, str]] = []
    try:
        with open(step_path, "r", encoding="utf-8", errors="replace") as handle:
            for line in handle:
                match = _DEF_RE.match(line)
                if match:
                    rest = line[match.end():].lstrip()
                    if rest.startswith("("):
                        rec.append((int(match.group(1)), "(COMPLEX)"))
                    else:
                        rec.append((int(match.group(1)), rest.split("(", 1)[0].strip() or "?"))
    except OSError:
        return []
    with _DEFS_LOCK:
        _DEFS[key] = rec
    return rec


def _st_of(text) -> int:
    """cadgen manifest surfaceType (or legacy short code) -> OCP GeomAbs_SurfaceType."""
    value = str(text).strip().lower()
    value = _ALIAS.get(value, value)
    if value.startswith("type"):
        try:
            return int(value[4:])
        except ValueError:
            return 99
    return _STMAP.get(value, 99)


def _shape_records(shape, model, transfer_reader, defs) -> list[tuple[int, float, float, float, float, int]]:
    """(st, area, cx, cy, cz, real #id) for every face of one shape."""
    face_map = TopTools_IndexedMapOfShape()
    TopExp.MapShapes_s(shape, TopAbs_FACE, face_map)
    extent = int(face_map.Extent())
    if extent == 0:
        return []
    nb = int(model.NbEntities())
    if not defs or nb != len(defs) or nb > _MAX_ENTITIES:
        return []  # definition index unusable / too large -> fail open
    out: list[tuple[int, float, float, float, float, int]] = []
    for ordinal in range(1, extent + 1):
        face = face_map.FindKey(ordinal)
        try:
            item = transfer_reader.EntityFromShapeResult(face, 1)
        except Exception:  # noqa: BLE001
            item = None
        rid = 0
        if item is not None:
            for i in range(1, nb + 1):
                try:
                    if model.Entity(i) == item:
                        rid = defs[i - 1][0] if i <= len(defs) else 0
                        break
                except Exception:  # noqa: BLE001
                    continue
        try:
            f = TopoDS.Face_s(face)
            adaptor = BRepAdaptor_Surface(f)
            st = int(adaptor.GetType())
            props = GProp_GProps()
            BRepGProp.SurfaceProperties_s(f, props)
            centre = props.CentreOfMass()
            out.append((st, props.Mass(), centre.X(), centre.Y(), centre.Z(), rid))
        except Exception:  # noqa: BLE001
            out.append((99, 0.0, 0.0, 0.0, 0.0, rid))
    return out


def record_from_session(step_path, reader, prototype_shapes: dict[int, object]) -> None:
    """Build the source fingerprint index while the CAF reader session is alive.

    ``reader`` is a STEPCAFControl_Reader (its inner STEPControl reader holds the
    transferred model) or a plain STEPControl_Reader (fallback load path).
    """
    global _SOURCE, _SOURCE_KEY
    if not enabled() or not prototype_shapes:
        return
    try:
        inner = reader.Reader() if hasattr(reader, "Reader") else reader
        model = inner.StepModel()
        transfer_reader = inner.WS().TransferReader()
        defs = build_definition_index(str(step_path))
        if not defs:
            return
        records: list[tuple[int, float, float, float, float, int]] = []
        for _key, shape in prototype_shapes.items():
            records.extend(_shape_records(shape, model, transfer_reader, defs))
        if records:
            with _LOCK:
                _SOURCE = records
                _SOURCE_KEY = os.path.abspath(str(step_path))
    except Exception:  # noqa: BLE001 — fail open, never break loading
        return


def has_source_index() -> bool:
    with _LOCK:
        return bool(_SOURCE)


def entity_id_for_face(surface_type, area: float, center) -> int:
    """Fingerprint lookup for a component face row (tolerant nearest neighbour).

    ``surface_type`` is the cadgen manifest value (string or short code); ``area``
    and ``center`` are the manifest values for that row, i.e. computed on the same
    geometry the source index was built from (modulo mesh vs analytic).
    """
    if not enabled():
        return 0
    st = _st_of(surface_type)
    try:
        area = float(area)
        cx, cy, cz = (float(center[0]), float(center[1]), float(center[2]))
    except (TypeError, ValueError, IndexError):
        return 0
    with _LOCK:
        source = _SOURCE
    if not source:
        return 0
    cands = [row for row in source if row[0] == st or (st != 6 and row[0] == 6)]
    if not cands:
        return 0
    scored = []
    for row_st, row_area, row_cx, row_cy, row_cz, rid in cands:
        rel = abs(area - row_area) / max(row_area, 1e-9)
        dist = ((cx - row_cx) ** 2 + (cy - row_cy) ** 2 + (cz - row_cz) ** 2) ** 0.5
        scored.append((rel + dist, rel, dist, rid))
    scored.sort(key=lambda item: item[0])
    best = scored[0]
    if best[1] > REL_AREA or best[2] > ABS_CENTER:
        return 0  # gap: not the same face -> fail safe
    if len(scored) > 1 and scored[1][0] - best[0] < _AMB_GAP and scored[1][3] != best[3] \
            and scored[1][1] <= REL_AREA and scored[1][2] <= ABS_CENTER:
        return 0  # ambiguous (e.g. symmetric faces) -> never guess
    return int(best[3]) if best[3] > 0 else 0


def cache_payload() -> list[list[float]]:
    """Serialisable copy of the source index (persisted into the scene cache)."""
    with _LOCK:
        return [[row[0], row[1], row[2], row[3], row[4], row[5]] for row in _SOURCE]


def register_cached(payload) -> None:
    """Restore a source index persisted in the scene cache (BinTools reload path has
    no live reader). Only fills the slot when it is empty, so a fresh source load
    always wins."""
    global _SOURCE
    if not enabled() or not payload:
        return
    try:
        rows = [(int(r[0]), float(r[1]), float(r[2]), float(r[3]), float(r[4]), int(r[5]))
                for r in payload]
    except (TypeError, ValueError, IndexError):
        return
    if not rows:
        return
    with _LOCK:
        if not _SOURCE:
            _SOURCE = rows


def clear() -> None:
    """Drop cached state (worker recycle)."""
    global _SOURCE, _SOURCE_KEY
    with _LOCK:
        _SOURCE = []
        _SOURCE_KEY = ""
    with _DEFS_LOCK:
        _DEFS.clear()
