# -*- coding: utf-8 -*-
"""Inline stepEntityId injection regression tool (persistent, replaces ad-hoc scripts).

Two modes (OCP and pythonocc live in different interpreters):

  # 1) One-time / refreshed ground truth — run under a pythonocc interpreter:
  #    (D:/Anaconda/envs/gccad310/python.exe)
  python tools/verify_inline_entity_ids.py baseline <dir> [-o baseline.json]

  # 2) Regression check — run under the cadgen venv (OCP):
  #    optionally --rebuild wipes <dir>/__cadgen__ and rebuilds via the warm worker
  #    (production-equivalent path) before reconciling.
  python tools/verify_inline_entity_ids.py check <dir> [--baseline baseline.json] [--rebuild]

Baseline format: {file name: {ordinal: entity id}}. Without a baseline, check
still reports column presence / non-zero rate but cannot verify correctness.
"""
import glob
import json
import os
import re
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TARGET_STEP_GLOBS = ("*.step", "*.STEP", "*.stp")


def _step_files(target):
    files = sorted({os.path.basename(p)
                    for pattern in TARGET_STEP_GLOBS
                    for p in glob.glob(os.path.join(target, pattern))})
    if not files:
        print(f"no STEP files under {target}")
        sys.exit(2)
    return files


# ---------------------------------------------------------------- baseline ----

def mode_baseline(target, out_path):
    """Ground truth via pythonocc IdentLabel (the long-proven channel)."""
    sys.path.insert(0, os.path.join(ROOT, 'tools'))
    from step_feature_augment import extract_entity_map  # noqa: E402

    report = {}
    files = _step_files(target)
    for idx, name in enumerate(files, 1):
        path = os.path.join(target, name)
        try:
            mapping = extract_entity_map(path)
            report[name] = {str(k): int(v.get('entityId') or 0) for k, v in mapping.items()}
            print(f'[{idx}/{len(files)}] {name} faces={len(mapping)}')
        except Exception as exc:  # noqa: BLE001
            print(f'[{idx}/{len(files)}] {name} FAILED: {exc}')
    with open(out_path, 'w', encoding='utf-8') as handle:
        json.dump(report, handle, ensure_ascii=False, indent=1)
    print(f'baseline written -> {out_path} ({len(report)} files)')


# -------------------------------------------------------------------- check ----

def _read_glb_column(glb_path):
    sys.path.insert(0, os.path.join(ROOT, 'tools'))
    from step_feature_augment import read_glb, read_selector_manifest  # noqa: E402
    gltf, binary = read_glb(glb_path)
    manifest = read_selector_manifest(gltf, binary)
    cols = (manifest.get('tables') or {}).get('faceColumns') or []
    rows = manifest.get('faces') or []
    if 'stepEntityId' not in cols:
        return None, rows
    idx = cols.index('stepEntityId')
    ordinal_idx = cols.index('ordinal')
    return ({int(r[ordinal_idx]): int(r[idx] or 0) for r in rows},
            {int(r[ordinal_idx]): 1 for r in rows})


def _rebuild(target):
    """Wipe the render-package cache and rebuild via the warm worker
    (bench_warm_glb.py = production-equivalent serial prewarm path)."""
    import shutil
    cache = os.path.join(target, '__cadgen__')
    if os.path.isdir(cache):
        shutil.rmtree(cache)
    result = subprocess.run(
        [sys.executable, os.path.join(ROOT, 'tools', 'bench_warm_glb.py'), target],
        cwd=ROOT, capture_output=True, text=True,
    )
    tail = (result.stdout or '').strip().splitlines()[-3:]
    print('\n'.join(tail))
    if result.returncode != 0:
        print('REBUILD FAILED'); sys.exit(2)


def mode_check(target, baseline_path, rebuild):
    if rebuild:
        _rebuild(target)
    baseline = {}
    if baseline_path and os.path.isfile(baseline_path):
        data = json.load(open(baseline_path, encoding='utf-8'))
        if 'files' in data:  # legacy wrapper format
            data = {os.path.basename(k): v.get('ids', v) for k, v in data['files'].items()}
        baseline = {name: {int(o): int(i) for o, i in ids.items()}
                    for name, ids in data.items()}
    elif baseline_path:
        print(f'baseline not found: {baseline_path} (column-presence check only)')
        print('generate one first:  <pythonocc python> tools/verify_inline_entity_ids.py '
              f'baseline "{target}" -o "{baseline_path}"')

    files = _step_files(target)
    n_file = n_col = n_face = n_nonzero = n_mis = 0
    problems = []
    for name in files:
        glbs = glob.glob(os.path.join(target, '__cadgen__', 'models', name,
                                      'components', '*.glb'))
        if not glbs:
            problems.append(f'{name}: no GLB package')
            continue
        n_file += 1
        got_all = {}
        has_col = False
        for glb in glbs:
            column, _rows = _read_glb_column(glb)
            if column is None:
                continue
            has_col = True
            got_all.update(column)
        if has_col:
            n_col += 1
        else:
            problems.append(f'{name}: GLB has NO stepEntityId column (inline off/failed?)')
            continue
        gt = baseline.get(name)
        if gt is None:
            n_face += len(got_all)
            n_nonzero += sum(1 for v in got_all.values() if v)
            continue
        n_face += len(gt)
        n_nonzero += sum(1 for v in got_all.values() if v)
        for ordinal, want in gt.items():
            if got_all.get(ordinal, 0) != want:
                n_mis += 1
                if len(problems) < 10:
                    problems.append(f'{name} ordinal{ordinal}: inline={got_all.get(ordinal, 0)} '
                                    f'baseline={want}')
    print('---')
    print(f'files={n_file} withColumn={n_col} faces={n_face} nonZero={n_nonzero} '
          f'({n_nonzero / max(n_face, 1) * 100:.2f}%) mismatchVsBaseline={n_mis}')
    for line in problems:
        print('   ', line)
    sys.exit(1 if (problems or n_mis or (baseline and n_col != n_file)) else 0)


def main(argv):
    if len(argv) >= 3 and argv[1] == 'baseline':
        target = os.path.abspath(argv[2])
        out = argv[argv.index('-o') + 1] if '-o' in argv else os.path.join(target, '.entity_id_baseline.json')
        mode_baseline(target, out)
    elif len(argv) >= 3 and argv[1] == 'check':
        target = os.path.abspath(argv[2])
        baseline = None
        if '--baseline' in argv:
            baseline = os.path.abspath(argv[argv.index('--baseline') + 1])
        else:
            default = os.path.join(target, '.entity_id_baseline.json')
            baseline = default if os.path.isfile(default) else None
            if baseline:
                print(f'using default baseline: {baseline}')
        mode_check(target, baseline, '--rebuild' in argv)
    else:
        print(__doc__)
        sys.exit(2)


if __name__ == '__main__':
    main(sys.argv)
