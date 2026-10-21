"""The CAD Viewer's local-filesystem backend.

Owns root resolution, catalog absolutization (raw scanner URLs ->
``/__cad/asset?file=...`` form the client consumes verbatim), the guarded
asset-path resolver, and the render-artifact build/export routes that shell
out to cadgen.
"""

from __future__ import annotations

import os
import re
from urllib.parse import urlsplit, parse_qs, unquote

from . import artifact as artifact_mod
from . import cadgen_bridge
from . import scanner
from .content_types import content_type_for_path
from .save_dialog import pick_save_destination
from .urls import local_asset_url_for_path

_STEP_EXPORT_FORMAT_SUFFIX = {"step": "step", "stl": "stl", "3mf": "3mf", "glb": "glb"}

# How long an artifact build may wait for a peer's generation lock before reporting the
# peer's run instead. Long enough that an UNCONTENDED acquire never trips it (it is a
# couple of syscalls), short enough that a POST cannot park the shared warm worker.
_ARTIFACT_LOCK_TIMEOUT_SECONDS = 0.5

# The formats an `.implicit.js` model exports to. Rejected here only so a bad request fails
# before a Node process is spawned; `cadgen.implicit_export` holds the authoritative list
# beside the exporter it drives, and validates again.
_IMPLICIT_EXPORT_FORMATS = ("stl", "glb", "3mf")


def _to_posix(value: str) -> str:
    return str(value or "").replace(os.sep, "/")


def normalize_dir_arg(value: str) -> str:
    """Normalize a directory argument coming from a page URL path.

    On Windows, a Viewer URL path looks like ``/D:/models`` (file:// style), but
    ``os.path.abspath`` treats the leading slash as a root-relative marker and
    would produce ``D:\\D:\\models``. Strip the leading slash when the remainder
    is a drive-prefixed absolute path so the URL path resolves correctly.
    """
    text = str(value or "").strip()
    if re.match(r"^/[A-Za-z]:[\\/]", text):
        return text[1:]
    return text


def absolute_file_ref(file_path: str) -> str:
    return _to_posix(os.path.abspath(file_path))


def relative_file_ref(root_path: str, file_path: str) -> str:
    return _to_posix(os.path.relpath(os.path.abspath(file_path), os.path.abspath(root_path)))


def normalized_file_ref(value: str) -> str:
    raw = str(value or "").strip().replace("\\", "/")
    if not raw:
        return ""
    if "\0" in raw:
        raise ValueError("File path contains an invalid null byte")
    return absolute_file_ref(raw) if os.path.isabs(raw) else raw.lstrip("/")


def require_directory(root_path: str) -> None:
    if not os.path.isdir(root_path):
        raise ValueError(f"CAD Viewer directory not found: {root_path}")


class ForbiddenAssetError(Exception):
    status_code = 403


def _query_value(raw_url: str, name: str) -> str:
    try:
        params = parse_qs(urlsplit(str(raw_url or "")).query)
        return (params.get(name) or [""])[0]
    except ValueError:
        return ""


def _asset_path_from_catalog_url(scan_repo_root: str, raw_url: str) -> str:
    text = str(raw_url or "").strip()
    if not text:
        return ""
    try:
        parts = urlsplit(text)
        explicit_file = (parse_qs(parts.query).get("file") or [""])[0]
        if explicit_file:
            return os.path.abspath(explicit_file)
        return os.path.abspath(os.path.join(scan_repo_root, unquote(parts.path).lstrip("/")))
    except ValueError:
        cleaned = text.split("?", 1)[0].split("#", 1)[0].lstrip("/")
        return os.path.abspath(os.path.join(scan_repo_root, cleaned))


def _absolute_path_from_catalog_value(scan_repo_root: str, value: str) -> str:
    text = str(value or "").strip()
    if not text:
        return ""
    if os.path.isabs(text):
        return os.path.abspath(text)
    return os.path.abspath(os.path.join(scan_repo_root, text))


def _absolutize_keyed(obj, scan_repo_root: str, keys):
    if not isinstance(obj, dict):
        return obj
    nxt = dict(obj)
    for key in keys:
        if nxt.get(key):
            nxt[key] = absolute_file_ref(_absolute_path_from_catalog_value(scan_repo_root, nxt[key]))
    return nxt


def _absolutize_source(source, scan_repo_root):
    return _absolutize_keyed(source, scan_repo_root, ("file", "path", "sourcePath"))


def _absolutize_source_status(status, scan_repo_root):
    return _absolutize_keyed(status, scan_repo_root, ("sourcePath", "stepPath", "packagePath"))


def _absolutize_artifact(artifact, scan_repo_root):
    return _absolutize_keyed(artifact, scan_repo_root, ("stepPath", "packagePath", "sourcePath", "cadPath"))


def _absolutize_entry(entry: dict, *, root_path: str, scan_repo_root: str, root_dir: str) -> dict:
    output_path = os.path.abspath(os.path.join(root_path, str(entry.get("file") or "")))
    nxt = dict(entry)
    nxt["file"] = absolute_file_ref(output_path)
    nxt["rootRelativeFile"] = relative_file_ref(root_path, output_path)
    if entry.get("url"):
        asset_path = _asset_path_from_catalog_url(scan_repo_root, entry["url"])
        nxt["url"] = local_asset_url_for_path(asset_path, version=_query_value(entry["url"], "v"), root_dir=root_dir)
        nxt["assetFile"] = absolute_file_ref(asset_path)
    if entry.get("moduleUrl"):
        module_path = _asset_path_from_catalog_url(scan_repo_root, entry["moduleUrl"])
        nxt["moduleUrl"] = local_asset_url_for_path(module_path, version=_query_value(entry["moduleUrl"], "v"), root_dir=root_dir)
        nxt["moduleFile"] = absolute_file_ref(module_path)
    if entry.get("source"):
        nxt["source"] = _absolutize_source(entry["source"], scan_repo_root)
    if entry.get("sourceStatus"):
        nxt["sourceStatus"] = _absolutize_source_status(entry["sourceStatus"], scan_repo_root)
    if entry.get("artifact"):
        nxt["artifact"] = _absolutize_artifact(entry["artifact"], scan_repo_root)
    relations = entry.get("relations")
    if isinstance(relations, dict):
        nxt_relations = {}
        for key, relation in relations.items():
            if not isinstance(relation, dict):
                nxt_relations[key] = relation
                continue
            relation_path = os.path.abspath(os.path.join(root_path, str(relation.get("file") or "")))
            nxt_relation = dict(relation)
            nxt_relation["file"] = absolute_file_ref(relation_path)
            nxt_relation["rootRelativeFile"] = relative_file_ref(root_path, relation_path)
            if relation.get("url"):
                rel_asset = _asset_path_from_catalog_url(scan_repo_root, relation["url"])
                nxt_relation["url"] = local_asset_url_for_path(rel_asset, version=_query_value(relation["url"], "v"), root_dir=root_dir)
                nxt_relation["assetFile"] = absolute_file_ref(rel_asset)
            nxt_relations[key] = nxt_relation
        nxt["relations"] = nxt_relations
    return nxt


class LocalAssetBackend:
    """Serves whatever directory a request names. There is no configured root.

    A request's directory is an absolute filesystem path (the page URL's path;
    see server.py). It is its own scan root, so there is no base-vs-request root
    to reconcile, no relative-vs-absolute resolution, and no re-basing of scanned
    entries. An empty directory means the process cwd.
    """

    kind = "local-fs"

    def resolve_root(self, root_dir: str = "") -> dict:
        root_path = os.path.abspath(normalize_dir_arg(root_dir) or os.getcwd())
        if "\0" in root_path:
            raise ValueError("CAD Viewer directory contains an invalid null byte")
        require_directory(root_path)
        return {"dir": absolute_file_ref(root_path), "rootPath": root_path, "rootName": os.path.basename(root_path)}

    def read_catalog(self, root_dir: str = "", file_ref: str = "") -> dict:
        resolved_root = self.resolve_root(root_dir)
        root_path = resolved_root["rootPath"]
        if file_ref:
            raw_entries = [self._single_file_entry(root_path, file_ref)]
        else:
            raw = scanner.scan_cad_directory(root_path, include_artifact_status=False)
            raw_entries = raw["entries"]
        entries = [
            _absolutize_entry(entry, root_path=root_path, scan_repo_root=root_path, root_dir=resolved_root["dir"])
            for entry in raw_entries
        ]
        return {"schemaVersion": scanner.CAD_CATALOG_SCHEMA_VERSION, "entries": entries}

    def _single_file_entry(self, root_path: str, file_ref: str) -> dict:
        """Build a catalog entry for exactly one file, without scanning the directory.

        Used for single-file preview mode: the URL names a directory AND a ?file=
        relative to it, so the backend never walks the tree. The entry is constructed
        through the same create_*_entry builders the scanner uses, so the shape is
        identical to a full-scan catalog entry.
        """
        raw = str(file_ref or "").strip().replace("\\", "/")
        if not raw or "\0" in raw:
            raise ValueError("Invalid file reference")
        candidate = (
            os.path.abspath(raw)
            if os.path.isabs(raw)
            else os.path.abspath(os.path.join(root_path, raw.lstrip("/")))
        )
        candidate = os.path.normpath(candidate)
        if not scanner.path_is_inside(candidate, root_path):
            raise ValueError(f"CAD file is outside the viewer directory: {candidate}")
        if not os.path.isfile(candidate):
            raise ValueError(f"CAD file not found: {candidate}")
        if not scanner.is_served_cad_asset(candidate):
            raise ValueError(f"Not a served CAD asset: {candidate}")
        logical = (
            scanner.entry_path_for_render_package(candidate)
            if scanner.is_render_package_path(candidate)
            else candidate
        )
        extension = os.path.splitext(logical)[1].lower()
        if scanner.is_dxf_generator_path(logical):
            return scanner.create_generated_dxf_entry(root_path, root_path, logical)
        if extension in (".step", ".stp") or logical.lower().endswith(".step.py"):
            return scanner.create_step_entry(root_path, root_path, logical, extension, include_artifact_status=False)
        return scanner.create_single_asset_entry(root_path, root_path, candidate, extension)

    def asset_path_for_file_ref(self, file_ref: str, resolved_root: dict | None = None, root_dir: str = "") -> str | None:
        normalized = normalized_file_ref(file_ref)
        if not normalized or not os.path.isabs(normalized):
            return None
        candidate = os.path.abspath(normalized)
        if not scanner.is_served_cad_asset(candidate):
            return None
        active = resolved_root or (self.resolve_root(root_dir) if root_dir else None)
        if active:
            if not (candidate == active["rootPath"] or scanner.path_is_inside(candidate, active["rootPath"])):
                raise ForbiddenAssetError("Forbidden")
            # Hidden (dot-prefixed) directories below the served root are never served;
            # only root-relative components are checked so a root that itself lives under
            # a hidden absolute path still works.
            relative = os.path.relpath(candidate, active["rootPath"])
            if any(part.startswith(".") for part in relative.split(os.sep) if part and part != ".."):
                return None
        return candidate

    def content_type_for_path(self, file_path: str) -> str:
        return content_type_for_path(file_path)

    def catalog_entry_for_file_ref(self, catalog, file_ref):
        norm = normalized_file_ref(file_ref)
        if not norm or not isinstance(catalog, dict):
            return None
        for entry in catalog.get("entries", []):
            if normalized_file_ref(entry.get("file")) == norm or normalized_file_ref(entry.get("rootRelativeFile")) == norm:
                return entry
        return None

    def _source_candidates_for_file_ref(self, file_ref, resolved_root):
        normalized = normalized_file_ref(file_ref)
        if not normalized:
            return "", []
        if os.path.isabs(normalized):
            candidates = [os.path.abspath(normalized), os.path.abspath(os.path.join(resolved_root["rootPath"], normalized.lstrip("/")))]
        else:
            candidates = [os.path.abspath(os.path.join(resolved_root["rootPath"], normalized))]
        seen = []
        existing = []
        for c in candidates:
            if c in seen:
                continue
            seen.append(c)
            inside = c == resolved_root["rootPath"] or scanner.path_is_inside(c, resolved_root["rootPath"])
            if inside and os.path.exists(c):
                existing.append(c)
        return normalized, existing

    def resolve_step_source(self, file_ref, resolved_root):
        normalized, candidates = self._source_candidates_for_file_ref(file_ref, resolved_root)
        if not normalized:
            raise ValueError("Missing STEP file")
        for c in candidates:
            ext = os.path.splitext(c)[1].lower()
            if ext == ".py":
                stem = os.path.basename(c)[: -len(".py")]
                step_base = stem if re.search(r"\.(step|stp)$", stem, re.IGNORECASE) else stem + ".step"
                return {"stepPath": os.path.join(os.path.dirname(c), step_base), "sourcePath": c, "skipStepWrite": True}
            if ext not in (".step", ".stp"):
                raise ValueError("Only STEP/STP sources or same-stem Python generators can generate STEP topology artifacts")
            # A same-stem `<name>.step.py` generator OWNS the entry even when an
            # exported `<name>.step` sits beside it. The export is the generator's
            # output, and only the generator can declare the model's `params`
            # sidecar -- the documented way to attach one to an imported STEP
            # (skills/cad/references/parameters.md). Resolving it here keeps the
            # build, the freshness check and STEP export all keyed on the same
            # source. cadgen's generator mode writes only the render package, so
            # the exported `.step` beside it is never rewritten.
            generator = self._same_stem_python_generator_path(c)
            if generator:
                return {"stepPath": c, "sourcePath": generator, "skipStepWrite": True}
            return {"stepPath": c, "sourcePath": "", "skipStepWrite": False}
        raise ValueError(f"STEP file not found: {normalized}")

    def resolve_dxf_source(self, file_ref, resolved_root):
        # Both DXF inputs resolve here, exactly as both STEP inputs do above: a `.dxf.py`
        # generator (run it) and an imported `.dxf` (copy it in and bake its preview). An
        # imported drawing is artifact-managed because the package's preview.glb is the only
        # 3D DXF renderer there is.
        normalized, candidates = self._source_candidates_for_file_ref(file_ref, resolved_root)
        if not normalized:
            raise ValueError("Missing DXF file")
        for c in candidates:
            if not scanner.is_dxf_generator_path(c) and os.path.splitext(c)[1].lower() != ".dxf":
                raise ValueError(
                    "Only .dxf drawings and .dxf.py drawing generators can generate DXF drawing artifacts"
                )
            return {"sourcePath": c}
        raise ValueError(f"DXF source not found: {normalized}")

    def resolve_implicit_source(self, file_ref, resolved_root):
        # One input, one resolution: the `.implicit.js` model itself. There is no generator
        # indirection (the model IS the generator) and no exported sibling to prefer.
        normalized, candidates = self._source_candidates_for_file_ref(file_ref, resolved_root)
        if not normalized:
            raise ValueError("Missing implicit CAD file")
        for c in candidates:
            if not scanner.path_is_implicit_cad_source(c):
                raise ValueError(
                    "Only .implicit.js models can generate implicit CAD render artifacts"
                )
            return {"sourcePath": c}
        raise ValueError(f"Implicit CAD source not found: {normalized}")

    # One record per render-package format, matched in order. Everything that used to be an
    # `if owns_dxf_entry(entry): ... else: ...` at three call sites lives here, so adding a
    # format is a row rather than another branch in each method.
    #
    # The table is TOTAL by construction: it RAISES when no predicate matches instead of
    # falling through to STEP. A half-wired format that silently answered as STEP would
    # validate an assembly.json that does not exist, report `ready` for the missing-source
    # code, and never build -- the failure mode this shape exists to make impossible.
    def _artifact_format(self, entry):
        formats = (
            (artifact_mod.owns_dxf_entry, {
                "validate": artifact_mod.validate_dxf_freshness,
                "resolve_source": lambda file_ref, root: self.resolve_dxf_source(file_ref, root)["sourcePath"],
                "build": self.generate_dxf_artifact,
            }),
            (artifact_mod.owns_implicit_entry, {
                "validate": artifact_mod.validate_implicit_freshness,
                "resolve_source": lambda file_ref, root: self.resolve_implicit_source(file_ref, root)["sourcePath"],
                "build": self.generate_implicit_artifact,
            }),
            (artifact_mod.owns_step_entry, {
                "validate": artifact_mod.validate_step_freshness,
                "resolve_source": self._resolve_step_artifact_source,
                "build": self.generate_step_artifact,
            }),
        )
        for owns, record in formats:
            if owns(entry):
                return record
        raise ValueError(
            f"No render-artifact format owns this entry: {str((entry or {}).get('file') or '(unknown)')}"
        )

    def _resolve_step_artifact_source(self, file_ref, resolved_root):
        resolved = self.resolve_step_source(file_ref, resolved_root)
        return resolved.get("sourcePath") or resolved["stepPath"]

    def artifact_status(self, file_ref, resolved_root, catalog):
        entry = self.catalog_entry_for_file_ref(catalog, file_ref)
        ref = str((entry or {}).get("url") or "")
        if not artifact_mod.owns_entry(entry):
            return {"state": artifact_mod.ARTIFACT_STATE_READY, "ref": ref}
        fmt = self._artifact_format(entry)
        try:
            artifact_source = fmt["resolve_source"](file_ref, resolved_root)
        except ValueError as exc:
            return {"state": artifact_mod.ARTIFACT_STATE_ERROR, "error": str(exc)}
        package_dir = scanner.render_package_dir(artifact_source)
        snap = artifact_mod.generation_snapshot(package_dir)
        if snap.writing:
            # The LOCK decides the state; the record only says how far along it is, and is
            # omitted when the build has not reported yet, or when the record on disk
            # belongs to some other (dead) run. runId lets the client tell one run from the
            # next, so its bar resets on a handoff instead of jumping backwards.
            status = {"state": artifact_mod.ARTIFACT_STATE_GENERATING, "ref": ref}
            if snap.run_id:
                status["runId"] = snap.run_id
            if snap.progress is not None:
                status["progress"] = snap.progress
            return status
        ok, code = fmt["validate"](resolved_root["rootPath"], artifact_source)
        if ok:
            # A busy GENERATOR (an export running this model's gen_step) does not hide a
            # renderable model -- nothing is rewriting the package, so what is on disk is
            # still valid. Annotated so the client can say why a build is unavailable.
            status = {"state": artifact_mod.ARTIFACT_STATE_READY, "ref": ref}
            if snap.busy:
                status["busy"] = True
                # An occupied generator (an export, an on-demand topology extraction) runs
                # the same multi-minute gen_step a build does. It does NOT hide the model —
                # nothing is being rewritten — so this rides alongside a ready artifact and
                # the client shows it without blocking the render.
                if snap.run_id:
                    status["runId"] = snap.run_id
                if snap.progress is not None:
                    status["progress"] = snap.progress
            return status
        if code in artifact_mod.BUILDABLE_ARTIFACT_CODES:
            status = {"state": artifact_mod.ARTIFACT_STATE_NEEDS_BUILD, "reason": code, "ref": ref}
            if snap.busy:
                # Stale AND the generator is occupied (an export is running this model's
                # gen_step). A build would NOT block on it -- the two take different
                # sentinels precisely so they do not exclude each other -- it would run the
                # same generator a second time, concurrently, for nothing. Telling the
                # client to wait is an efficiency call, not a deadlock avoidance one.
                status["blocked"] = True
            return status
        return {"state": artifact_mod.ARTIFACT_STATE_ERROR, "reason": code, "error": code, "ref": ref}

    def _same_stem_python_generator_path(self, step_path):
        ext = os.path.splitext(step_path)[1].lower()
        if ext not in (".step", ".stp"):
            return ""
        candidate = os.path.join(os.path.dirname(step_path), os.path.basename(step_path) + ".py")
        return candidate if scanner._file_has_python_generator(candidate, "gen_step") else ""

    # POST /__cad/artifact build — subprocess cadgen.step_artifact (OCP stays out of
    # the server process).
    def generate_step_artifact(self, file_ref, force, resolved_root, catalog):
        resolved = self.resolve_step_source(file_ref, resolved_root)
        step_path = resolved["stepPath"]
        ext = os.path.splitext(step_path)[1].lower()
        has_step = ext in (".step", ".stp") and os.path.isfile(step_path)
        # resolve_step_source already prefers a same-stem generator over a sibling
        # export, so both the freshness check and this build key on one source.
        generator = resolved.get("sourcePath") or ""
        has_generator = bool(generator) and os.path.isfile(generator)
        if not has_step and not has_generator:
            raise ValueError("CAD Viewer regenerates GLB artifacts only for existing STEP/STP files or their same-stem Python generators.")
        args = ["--step", step_path]
        if has_generator:
            # Generated models keep no .step on disk — --source-path selects generator
            # mode: cadgen runs the generator in-process and writes only the render
            # package (the logical --step path never exists).
            args += ["--source-path", generator]
        result = self._run_artifact_build(
            "cadgen.step_artifact", args, resolved_root["rootPath"],
            force=force, error_label="STEP render artifact build failed",
        )
        if result.get("ok") and not result.get("contended"):
            maybe_inject_step_entity_ids(step_path)
        return {**result, "stepPath": step_path}

    # POST /__cad/artifact build for a generated `.dxf.py` drawing — subprocess
    # cadgen.dxf_artifact (parity with the STEP build; the generator runs out of the
    # server process).
    def generate_dxf_artifact(self, file_ref, force, resolved_root, catalog):
        resolved = self.resolve_dxf_source(file_ref, resolved_root)
        source_path = resolved["sourcePath"]
        result = self._run_artifact_build(
            "cadgen.dxf_artifact", ["--source-path", source_path], resolved_root["rootPath"],
            force=force, error_label="DXF render artifact build failed",
        )
        return {**result, "sourcePath": source_path}

    # POST /__cad/artifact build for an `.implicit.js` model — subprocess
    # cadgen.implicit_artifact. Same shape as the DXF build: the cadgen module holds the
    # generation lock and owns the Node mesher's lifetime, so nothing about "the geometry is
    # produced in JS" leaks into this process.
    def generate_implicit_artifact(self, file_ref, force, resolved_root, catalog):
        resolved = self.resolve_implicit_source(file_ref, resolved_root)
        source_path = resolved["sourcePath"]
        result = self._run_artifact_build(
            "cadgen.implicit_artifact", ["--source-path", source_path], resolved_root["rootPath"],
            force=force, error_label="Implicit CAD render artifact build failed",
        )
        return {**result, "sourcePath": source_path}

    # Shared build tail for both artifact formats: run the cadgen module in a
    # subprocess/worker. Freshness is decided by the recorded source-closure CONTENT
    # hash, so there is nothing to touch afterwards — the descriptor mtime bump this
    # used to do existed only to quiet the old mtime staleness trigger after a
    # rebuild that the CLI had correctly skipped as current.
    def _run_artifact_build(self, module, args, root_path, *, force, error_label):
        full_args = ["--repo-root", root_path, *args]
        if force:
            full_args += ["--force"]
        # NEVER wait out a peer inside a build. cadgen's acquire is blocking by default,
        # which is right for a CLI (an agent asking for a build wants the build) and wrong
        # here: this request runs in the ONE serial warm worker, so a build parked on
        # another process's lock stops every OTHER model's build and export for as long as
        # the peer runs -- measured at 32s for an unrelated, already-current model. The
        # snap.writing pre-check in resolve_artifact narrows the window but cannot close it
        # (a peer can take the lock right after the snapshot, and force= skips the check
        # entirely). This is the part that actually cannot block.
        full_args += ["--lock-timeout", str(_ARTIFACT_LOCK_TIMEOUT_SECONDS)]
        if os.environ.get("VIEWER_STEP_ARTIFACT_VERBOSE") == "1":
            full_args += ["--verbose"]
        result = cadgen_bridge.run_cadgen(module, full_args, root_path)
        if result.get("contended"):
            # A peer holds the lock. Nothing failed and nothing was built: the caller
            # reports the peer's run so the client attaches to its progress.
            return {"ok": True, "contended": True, "error": "", "result": result}
        error = "" if result.get("ok") else str(result.get("error") or error_label)
        return {"ok": bool(result.get("ok")), "error": error, "result": result}

    def resolve_artifact(self, file_ref, force, resolved_root, catalog):
        entry = self.catalog_entry_for_file_ref(catalog, file_ref)
        ref = str((entry or {}).get("url") or "")
        if not artifact_mod.owns_entry(entry):
            return {"ok": True, "state": artifact_mod.ARTIFACT_STATE_READY, "ref": ref}
        fmt = self._artifact_format(entry)
        try:
            artifact_source = fmt["resolve_source"](file_ref, resolved_root)
        except ValueError as exc:
            return {"ok": False, "state": artifact_mod.ARTIFACT_STATE_ERROR, "error": str(exc)}
        # A POST NEVER BLOCKS ON A PEER. This used to wait up to 180 SECONDS in
        # await_generation_lock, discard the timeout's return value, and then build anyway
        # -- so a user who opened a model during a long `cad gen` waited out the CLI run
        # and then paid for a full duplicate rebuild, with the bar restarting from zero.
        # Worse, that queued build then blocked inside the single process-global worker
        # lock, freezing every OTHER model's build and export for the duration.
        #
        # Reporting `generating` immediately lets the client attach to the peer's run and
        # watch its live progress instead, which is both faster and truthful.
        #
        # This check is the FAST PATH, not the guarantee: it is a snapshot, so a peer can
        # take the lock immediately after it, and force= skips it entirely. The guarantee is
        # the bounded --lock-timeout in _run_artifact_build, whose contended result lands on
        # the same answer below.
        snap = artifact_mod.generation_snapshot(scanner.render_package_dir(artifact_source))
        if not force and snap.writing:
            result = {"ok": True, "state": artifact_mod.ARTIFACT_STATE_GENERATING, "ref": ref}
            if snap.run_id:
                result["runId"] = snap.run_id
            return result
        built = fmt["build"](file_ref, force, resolved_root, catalog)
        if built.get("contended"):
            # The peer took the lock between the snapshot above and the build (or force=
            # skipped that check). Same answer as the pre-check: attach to their run.
            result = {"ok": True, "state": artifact_mod.ARTIFACT_STATE_GENERATING, "ref": ref}
            live = artifact_mod.generation_snapshot(scanner.render_package_dir(artifact_source))
            if live.run_id:
                result["runId"] = live.run_id
            return result
        if built["ok"]:
            return {"ok": True, "state": artifact_mod.ARTIFACT_STATE_READY, "ref": ref}
        return {"ok": False, "state": artifact_mod.ARTIFACT_STATE_ERROR, "error": built["error"]}

    # POST /__cad/export — native Save dialog (subprocess) + a cadgen export module
    # (subprocess). Headless fallback writes beside the source + a download URL. One route
    # for every exportable entry: the source file decides which producer runs.
    def generate_export(self, file_ref, fmt, resolved_root, catalog):
        normalized = str(fmt or "").strip().lower()
        if scanner.is_dxf_generator_path(str(normalized_file_ref(file_ref))):
            if normalized != "dxf":
                raise ValueError(f"Unsupported export format for a DXF drawing: {fmt}")
            return self.generate_dxf_export(file_ref, resolved_root)
        if scanner.path_is_implicit_cad_source(str(normalized_file_ref(file_ref))):
            return self.generate_implicit_export(file_ref, normalized, resolved_root)
        if normalized not in _STEP_EXPORT_FORMAT_SUFFIX:
            raise ValueError(f"Unsupported export format: {fmt}")
        resolved = self.resolve_step_source(file_ref, resolved_root)
        step_path = resolved["stepPath"]
        source_path = resolved["sourcePath"]
        if not (step_path == resolved_root["rootPath"] or scanner.path_is_inside(step_path, resolved_root["rootPath"])):
            raise ValueError("Requested file is outside the active CAD Viewer root")
        base_name = re.sub(r"\.(step|stp)$", "", os.path.basename(step_path), flags=re.IGNORECASE)

        def _export(out_path):
            args = ["--repo-root", resolved_root["rootPath"], "--step", step_path, "--format", normalized, "--out", out_path]
            if source_path:
                args += ["--source-path", source_path]
            return cadgen_bridge.run_cadgen("cadgen.step_export_target", args, resolved_root["rootPath"])

        return self._export_with_destination(
            resolved_root,
            run_export=_export,
            base_name=base_name,
            suggested_name=f"{base_name}.{_STEP_EXPORT_FORMAT_SUFFIX[normalized]}",
            default_dir=os.path.dirname(step_path),
            format_name=normalized,
            error_label="STEP export failed",
        )

    # Export a generated `.dxf.py` drawing as a `.dxf` file — cadgen.dxf_artifact with
    # --export ensures the drawing package is fresh (rebuilding if the source changed)
    # and writes the DXF to the chosen path.
    def generate_dxf_export(self, file_ref, resolved_root):
        resolved = self.resolve_dxf_source(file_ref, resolved_root)
        source_path = resolved["sourcePath"]
        base_name = os.path.basename(source_path)[: -len(".dxf.py")]

        def _export(out_path):
            args = ["--repo-root", resolved_root["rootPath"], "--source-path", source_path, "--export", out_path]
            return cadgen_bridge.run_cadgen("cadgen.dxf_artifact", args, resolved_root["rootPath"])

        return self._export_with_destination(
            resolved_root,
            run_export=_export,
            base_name=base_name,
            suggested_name=f"{base_name}.dxf",
            default_dir=os.path.dirname(source_path),
            format_name="dxf",
            error_label="DXF export failed",
        )

    # Export an `.implicit.js` model as STL/GLB/3MF — cadgen.implicit_export runs the
    # shipped implicitjs export CLI in a Node child, under the model's GENERATOR lock.
    #
    # This used to happen in the browser: the client loaded the model module, meshed and
    # serialized it in the tab, and POSTed the bytes here to be written to disk. That kept a
    # second live geometry runtime in the viewer for the sake of one menu item. The mesher
    # is the same JS either way; only the process differs.
    def generate_implicit_export(self, file_ref, fmt, resolved_root):
        normalized = str(fmt or "").strip().lower().lstrip(".")
        if normalized not in _IMPLICIT_EXPORT_FORMATS:
            raise ValueError(f"Unsupported implicit CAD export format: {fmt or '(missing)'}")
        resolved = self.resolve_implicit_source(file_ref, resolved_root)
        source_path = resolved["sourcePath"]
        base_name = re.sub(r"\.implicit\.(?:mjs|js)$", "", os.path.basename(source_path), flags=re.IGNORECASE)

        def _export(out_path):
            args = [
                "--repo-root", resolved_root["rootPath"],
                "--source-path", source_path,
                "--format", normalized,
                "--out", out_path,
            ]
            return cadgen_bridge.run_cadgen("cadgen.implicit_export", args, resolved_root["rootPath"])

        return self._export_with_destination(
            resolved_root,
            run_export=_export,
            base_name=base_name,
            suggested_name=f"{base_name}.{normalized}",
            default_dir=os.path.dirname(source_path),
            format_name=normalized,
            error_label="Implicit CAD export failed",
        )

    # Shared export orchestration for every format: native Save dialog, chosen-path
    # write, or the headless fallback beside the source with a /__cad/download URL.
    def _export_with_destination(
        self, resolved_root, *, run_export, base_name, suggested_name, default_dir, format_name, error_label
    ):
        destination = pick_save_destination(
            suggested_name=suggested_name, default_dir=default_dir,
            prompt=f"Export {base_name} as {format_name.upper()}",
        )
        if destination.get("cancelled"):
            return {"ok": False, "cancelled": True}

        if destination.get("path"):
            result = run_export(os.path.abspath(destination["path"]))
            if not result.get("ok"):
                return {"ok": False, "error": str(result.get("error") or error_label)}
            out_path = os.path.abspath(result.get("path") or destination["path"])
            inside = out_path == resolved_root["rootPath"] or scanner.path_is_inside(out_path, resolved_root["rootPath"])
            return {"ok": True, "path": out_path, "filename": result.get("filename") or os.path.basename(out_path),
                    "format": format_name, "catalogChanged": inside}

        # Headless fallback: write beside the source, hand to the browser via /__cad/download.
        output_path = os.path.join(default_dir, suggested_name)
        if not (output_path == resolved_root["rootPath"] or scanner.path_is_inside(output_path, resolved_root["rootPath"])):
            raise ValueError("Requested file is outside the active CAD Viewer root")
        result = run_export(output_path)
        if not result.get("ok"):
            return {"ok": False, "error": str(result.get("error") or error_label)}
        output_file_ref = _to_posix(os.path.relpath(output_path, resolved_root["rootPath"]))
        return {"ok": True, "fallback": True, "path": output_path, "filename": os.path.basename(output_path),
                "format": format_name, "catalogChanged": True, "outputFileRef": output_file_ref}


# --- viewer link (test-lab upload) -------------------------------------------

_LINK_UPLOAD_ENV = "VIEWER_UPLOAD_ROOT"
# Default uploads root sits beside the viewer app root (the project root).
_LINK_UPLOAD_PARENT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
_PYTHONOCC_PYTHON_ENV = "VIEWER_PYTHONOCC_PYTHON"
# No machine-specific default: stepEntityId injection requires the operator to point
# VIEWER_PYTHONOCC_PYTHON at a python with pythonocc-core. Empty disables it gracefully.
_PYTHONOCC_DEFAULT_PYTHON = ""
_FEATURES_SIDECAR_NAMES = ("特征识别.json", "特征.json", "feature.json")


def _link_upload_root() -> str:
    configured = os.environ.get(_LINK_UPLOAD_ENV, "").strip()
    return os.path.abspath(configured) if configured else os.path.join(_LINK_UPLOAD_PARENT, "uploads")


def _new_task_id() -> str:
    import secrets
    import time
    return f"{time.strftime('%Y%m%d_%H%M%S')}_{secrets.token_hex(3)}"


def normalise_step_name(step_name: str) -> str:
    """Basename-collapse a caller-supplied STEP name and enforce the extension.

    Shared by every landing path so a URL-derived name can never smuggle a path
    separator (``../``) into the task directory.
    """
    name = os.path.basename(str(step_name or "").replace("\\", "/"))
    if not name or os.path.splitext(name)[1].lower() not in (".step", ".stp"):
        raise ValueError("Only .step/.stp files are supported")
    return name


def _land_step(step_name: str, write_step, features_bytes: bytes | None, *,
               host: str = "", task_id: str | None = None) -> dict:
    """Shared landing tail for every ingestion path (multipart bytes, fetched URL).

    ``write_step(step_path)`` is responsible for producing the STEP file at that
    exact path; everything after it — the feature sidecar, the on-disk layout and
    the returned contract — stays identical no matter where the bytes came from.
    """
    import json

    step_name = normalise_step_name(step_name)
    upload_root = _link_upload_root()
    os.makedirs(upload_root, exist_ok=True)
    task_id = task_id or _new_task_id()
    task_dir = os.path.join(upload_root, task_id)
    os.makedirs(task_dir, exist_ok=True)

    step_path = os.path.join(task_dir, step_name)
    write_step(step_path)

    features_name = ""
    if features_bytes:
        # utf-8-sig tolerates a leading UTF-8 BOM (common from Windows tools).
        text = features_bytes.decode("utf-8-sig", errors="strict")
        json.loads(text)  # validate
        stem = os.path.splitext(step_name)[0]
        features_name = f"{stem}.特征识别.json"
        with open(os.path.join(task_dir, features_name), "w", encoding="utf-8") as handle:
            handle.write(text)

    from . import encoding as enc
    dir_path = "/" + task_dir.replace("\\", "/")
    # features must be an ABSOLUTE path: the client loads it via /__cad/asset,
    # which only resolves absolute file refs (relative refs 404).
    query = [("file", step_name)]
    if features_name:
        query.append(("features", os.path.join(task_dir, features_name)))
    url = f"http://{host or '127.0.0.1:3245'}{dir_path}?" + enc.url_search_params_encode(query)
    return {
        "url": url,
        "taskId": task_id,
        "dir": task_dir,
        "file": step_name,
        "features": features_name,
    }


def land_uploaded_step(
    step_name: str,
    step_bytes: bytes,
    features_bytes: bytes | None = None,
    *,
    host: str = "",
    task_id: str | None = None,
) -> dict:
    """Land an uploaded STEP (+ optional feature-recognition JSON) under
    uploads/<taskId>/ and return {url, taskId, dir, file, features} — the same
    contract create_viewer_link returns, but built from raw bytes (multipart
    uploads) instead of a base64 JSON payload.

    ``host`` is the viewer authority (``host:port``) embedded in the returned
    URL; empty defaults to the loopback viewer. ``task_id`` overrides the
    generated uploads directory name (used by the external API so its jobId
    equals the on-disk task directory).
    """
    # Checked here (before the emptiness test) so this function's error precedence is
    # byte-for-byte what it was before the URL path was added — the viewer process
    # shares this code.
    normalise_step_name(step_name)
    if not step_bytes:
        raise ValueError("step content is required")

    def _write(path: str) -> None:
        with open(path, "wb") as handle:
            handle.write(step_bytes)

    return _land_step(step_name, _write, features_bytes, host=host, task_id=task_id)


def land_downloaded_step(
    step_name: str,
    source_path: str,
    features_bytes: bytes | None = None,
    *,
    host: str = "",
    task_id: str | None = None,
) -> dict:
    """Land a STEP that is already sitting in a local temp file (the URL-fetch path).

    The temp file is MOVED into the task directory instead of being re-read into
    memory, so a large download is never buffered twice. ``os.replace`` is atomic
    only within one filesystem (and the uploads root and the system temp dir are
    routinely on different volumes here), so a cross-volume move falls back to a
    copy-then-unlink.
    """
    import shutil

    if not source_path or not os.path.isfile(source_path):
        raise ValueError("downloaded step file is missing")

    def _write(path: str) -> None:
        try:
            os.replace(source_path, path)
        except OSError:
            shutil.copyfile(source_path, path)
            try:
                os.remove(source_path)
            except OSError:
                pass  # a leftover temp file must not fail an otherwise good landing

    return _land_step(step_name, _write, features_bytes, host=host, task_id=task_id)


def create_viewer_link(payload: dict, host: str = "") -> dict:
    """POST /__cad/link: land an uploaded STEP (+ optional feature-recognition JSON)
    under uploads/<taskId>/ and return a viewer URL that opens it."""
    import base64

    body = payload or {}
    step_name = str(body.get("stepName") or "").strip()
    step_data = str(body.get("stepData") or "").strip()
    features_json = body.get("featuresJson")
    if not step_name or not step_data:
        raise ValueError("stepName and stepData are required")
    features_bytes = None
    if features_json is not None and str(features_json).strip():
        features_bytes = str(features_json).strip().encode("utf-8")
    return land_uploaded_step(step_name, base64.b64decode(step_data), features_bytes, host=host)


def write_features_sidecar(task_dir: str, step_name: str, features_bytes: bytes) -> str:
    """Write (or overwrite) the feature-recognition sidecar for an ALREADY landed
    STEP — the "attach features later" path of the two-phase upload contract.

    Uses the same naming/validation rules as :func:`land_uploaded_step` so
    :func:`find_features_sidecar` picks the file up and the injection step can
    see it. Raises ValueError on malformed JSON.
    """
    import json

    text = features_bytes.decode("utf-8-sig", errors="strict")
    json.loads(text)  # validate before touching disk
    stem = os.path.splitext(os.path.basename(str(step_name or "")))[0]
    if not stem:
        raise ValueError("cannot derive a sidecar name without the STEP file name")
    name = f"{stem}.特征识别.json"
    with open(os.path.join(task_dir, name), "w", encoding="utf-8") as handle:
        handle.write(text)
    return name


def find_features_sidecar(step_path: str) -> str:
    """A feature-recognition JSON sitting beside the STEP (uploaded via the test lab)."""
    base = os.path.splitext(os.path.basename(step_path))[0]
    directory = os.path.dirname(step_path)
    for suffix in _FEATURES_SIDECAR_NAMES:
        candidate = os.path.join(directory, f"{base}.{suffix}")
        if os.path.isfile(candidate):
            return candidate
        candidate = os.path.join(directory, f"{base}{suffix}")
        if os.path.isfile(candidate):
            return candidate
    return ""


def _glb_has_step_entity_id(glb_path: str) -> bool:
    """Cheap probe: does a GLB already carry the ``stepEntityId`` column? Used to skip
    the pythonocc injector when the inline OCP build path already wrote it.

    The selector manifest lives in the binary buffer (``STEP_topology``/selectorView
    bufferView) rather than the glTF JSON chunk, and is written last, so the probe
    scans the tail of the file. Conservative: on any doubt it reports "absent" so the
    legacy injector still runs."""
    tail_scan = 4 * 1024 * 1024
    try:
        size = os.path.getsize(glb_path)
        with open(glb_path, "rb") as handle:
            if size > tail_scan:
                handle.seek(size - tail_scan)
            data = handle.read()
        return b"stepEntityId" in data
    except OSError:
        return False


def maybe_inject_step_entity_ids(step_path: str) -> bool:
    """After a STEP render package is built, inject the stepEntityId column when a
    feature-recognition sidecar exists and a pythonocc runtime is available.

    Never blocks viewing: any failure only writes a ``.feature-inject-failed`` marker
    (hidden dotfile, invisible to freshness checks) next to the package and logs one
    stderr line, so a misconfigured environment is discoverable instead of silent —
    and the marker is retried automatically on the next build of that STEP.

    Injection order: the persistent pythonocc worker (:mod:`server_py.inject_worker`)
    when enabled, else one cold ``tools/step_feature_augment.py`` subprocess PER
    component GLB (the pre-daemon behaviour, now covering every GLB, not just the
    first). The entity map is extracted once per STEP in the daemon path.
    """
    import sys as _sys

    def _marker_path(package_dir: str) -> str:
        return os.path.join(package_dir, ".feature-inject-failed")

    def _write_marker(package_dir: str, reason: str) -> None:
        try:
            with open(_marker_path(package_dir), "w", encoding="utf-8") as handle:
                handle.write(reason.rstrip() + "\n")
        except OSError:
            pass

    def _clear_marker(package_dir: str) -> None:
        try:
            marker = _marker_path(package_dir)
            if os.path.isfile(marker):
                os.remove(marker)
        except OSError:
            pass

    try:
        if not find_features_sidecar(step_path):
            return False
        package_dir = scanner.render_package_dir(step_path)
        components_dir = os.path.join(package_dir, "components")
        if not os.path.isdir(components_dir):
            return False
        glbs = sorted(
            os.path.join(components_dir, name)
            for name in os.listdir(components_dir)
            if name.lower().endswith(".glb")
        )
        if not glbs:
            return False

        # Inline (OCP build-time) injection already wrote the column: skip pythonocc
        # entirely. Without this check the daemon would start and only then hit its
        # own idempotency check, wasting ~1s of pythonocc imports per part.
        if all(_glb_has_step_entity_id(glb) for glb in glbs):
            _clear_marker(package_dir)
            print(
                f"stepEntityId 注入 {step_path}: inline (build-time) column present, "
                "pythonocc skipped",
                file=_sys.stderr,
            )
            return True

        pythonocc = os.environ.get(_PYTHONOCC_PYTHON_ENV, "").strip() or _PYTHONOCC_DEFAULT_PYTHON
        if not os.path.isfile(pythonocc):
            reason = f"VIEWER_PYTHONOCC_PYTHON not configured: {pythonocc!r} — injection skipped"
            _write_marker(package_dir, reason)
            print(f"stepEntityId 注入 {step_path}: {reason}", file=_sys.stderr)
            return False

        # Preferred: one warm pythonocc worker round trip (entity map once per STEP).
        try:
            from . import inject_client

            result = inject_client.inject_step(step_path, glbs)
            if result.get("ok"):
                _clear_marker(package_dir)
                skipped = sum(1 for r in result.get("results") or [] if r.get("skipped"))
                print(
                    f"stepEntityId 注入 {step_path}: ok, {len(glbs)} glb(s), {skipped} skipped via daemon",
                    file=_sys.stderr,
                )
                return True
            reasons = "; ".join(
                str(r.get("error") or "?") for r in (result.get("results") or [])
            ) or str(result.get("error") or "inject worker failed")
            _write_marker(package_dir, f"daemon injection failed: {reasons}")
            print(f"stepEntityId 注入 {step_path}: FAILED ({reasons})", file=_sys.stderr)
            return False
        except Exception as exc:  # noqa: BLE001 — daemon down -> cold fallback below
            print(f"stepEntityId 注入 {step_path}: daemon unavailable ({exc}); cold fallback", file=_sys.stderr)

        # Fallback: one cold pythonocc subprocess per component GLB.
        import subprocess

        script = os.path.join(_LINK_UPLOAD_PARENT, "tools", "step_feature_augment.py")
        if not os.path.isfile(script):
            reason = f"inject script missing: {script}"
            _write_marker(package_dir, reason)
            print(f"stepEntityId 注入 {step_path}: {reason}", file=_sys.stderr)
            return False
        ok_glbs = 0
        errors = []
        for glb in glbs:
            try:
                proc = subprocess.run(
                    [pythonocc, script, "--step", step_path, "--glb", glb],
                    capture_output=True, timeout=180, text=True, errors="replace",
                )
            except subprocess.TimeoutExpired:
                errors.append(f"{os.path.basename(glb)}: timed out")
                continue
            if proc.returncode == 0:
                ok_glbs += 1
            else:
                detail = (proc.stderr or proc.stdout or f"exit {proc.returncode}").strip().splitlines()
                errors.append(f"{os.path.basename(glb)}: {detail[-1] if detail else 'failed'}")
        if ok_glbs == len(glbs):
            _clear_marker(package_dir)
            print(f"stepEntityId 注入 {step_path}: ok, {len(glbs)} glb(s) via cold subprocess", file=_sys.stderr)
            return True
        reason = f"cold injection partial ({ok_glbs}/{len(glbs)}): {'; '.join(errors)}"
        _write_marker(package_dir, reason)
        print(f"stepEntityId 注入 {step_path}: {reason}", file=_sys.stderr)
        return False
    except Exception as exc:  # noqa: BLE001 — injection must never break model viewing
        print(f"stepEntityId 注入 {step_path}: unexpected failure: {exc}", file=_sys.stderr)
        return False