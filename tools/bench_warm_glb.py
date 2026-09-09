# -*- coding: utf-8 -*-
"""Benchmark: build every STEP under a directory into GLB render packages via the
production-equivalent warm-worker serial channel (server_py.worker_client).

Usage:
    python tools/bench_warm_glb.py <dir>          # build all (fresh packages only)
    python tools/bench_warm_glb.py <dir> --force  # ignore freshness, rebuild all

Output packages land under <dir>/__cadgen__/models/<step name>/.
"""
import glob
import os
import sys
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "viewer"))
sys.path.insert(0, os.path.join(ROOT, "viewer", "packages", "cadgen", "src"))

from server_py import worker_client  # noqa: E402


def main(argv):
    if len(argv) < 2:
        print("usage: bench_warm_glb.py <dir> [--force]"); return 2
    target = os.path.abspath(argv[1])
    force = "--force" in argv
    files = sorted({os.path.basename(p)
                    for pattern in ("*.step", "*.STEP", "*.stp")
                    for p in glob.glob(os.path.join(target, pattern))})
    if not files:
        print("no STEP files under", target); return 2

    t0 = time.perf_counter()
    ok = fail = 0
    first_ready = None
    for idx, name in enumerate(files, 1):
        args = ["--repo-root", target, "--step", name]
        if force:
            args.append("--force")
        t1 = time.perf_counter()
        # repo_root == target: the worker's cwd AND the CLI's --repo-root must be
        # the sample dir so relative --step names resolve (worker discovery walks
        # upward from here to find the cadgen package).
        result = worker_client.run_cadgen("cadgen.step_artifact", args, target)
        dt = time.perf_counter() - t1
        if first_ready is None:
            first_ready = dt
        good = bool(result.get("ok"))
        size = ""
        pkg = os.path.join(target, "__cadgen__", "models", name)
        glbs = glob.glob(os.path.join(pkg, "components", "*.glb"))
        if glbs:
            size = f"{os.path.getsize(glbs[0]) / 1024:.0f}KB"
        status = "ok" if good else f"FAIL {result.get('error', '')[:60]}"
        print(f"[{idx}/{len(files)}] {name[:40]:<42} "
              f"{os.path.getsize(os.path.join(target, name)) / 1024:6.1f}KB {dt:5.2f}s {status} {size}")
        ok, fail = ok + (1 if good else 0), fail + (0 if good else 1)
    total = time.perf_counter() - t0
    print("=" * 64)
    print(f"OK      : {ok}/{len(files)}")
    print(f"总墙钟   : {total:.2f}s  (含首次 worker 拉起+OCP 导入)")
    print(f"首次就绪 : {first_ready:.2f}s  (第一件出结果的时刻)")
    if ok:
        print(f"若预热窗口先跑: {ok} 件串行预热 ≈ {total - (first_ready or 0):.0f}s 全就绪（不含 HTTP/轮询开销）")
    return 0 if fail == 0 else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv))
