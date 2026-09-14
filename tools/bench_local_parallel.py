# -*- coding: utf-8 -*-
"""本地并发构建基准：走与生产同一套 warm-worker 通道（server_py.worker_client），
但**不经 HTTP / 上传 / 轮询**，用于和"计划任务 + 上传 API"的端到端耗时做对照。

    # 本地 4 并发（预热 8 件把 4 个 worker 全部拉起后再计时）
    rem VIEWER_PYTHONOCC_PYTHON 指向本机"OCC 命名空间"的 Python（见 README 环境说明）
    set VIEWER_PYTHONOCC_PYTHON=<本机 OCC 环境 python.exe>
    set VIEWER_CAD_WORKERS=4
    python tools/bench_local_parallel.py samples/100 4 8

    # 串行单 worker 对照（另有 tools/bench_warm_glb.py 亦可）
    python tools/bench_local_parallel.py samples/100 1 1

参数: <dir> [并发数=4] [预热件数=0]
产物: <dir>/__cadgen__/models/<step>/（始终 --force 重建，避免命中缓存）

⚠️ 必须设置 VIEWER_PYTHONOCC_PYTHON，否则 GLB 缺 stepEntityId 注入列，
   与 HTTP 口径不一致（注入是生产链路的一部分）。
"""
import glob
import os
import sys
import time
from concurrent.futures import ThreadPoolExecutor

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "viewer"))
sys.path.insert(0, os.path.join(ROOT, "viewer", "packages", "cadgen", "src"))

from server_py import worker_client  # noqa: E402


def _one(target, name):
    t = time.perf_counter()
    result = worker_client.run_cadgen(
        "cadgen.step_artifact",
        ["--repo-root", target, "--step", name, "--force"],
        target,
    )
    return bool(result.get("ok")), time.perf_counter() - t, name


def main(argv):
    if len(argv) < 2:
        print(__doc__)
        return 2
    target = os.path.abspath(argv[1])
    nw = int(argv[2]) if len(argv) > 2 else 4
    nwarm = int(argv[3]) if len(argv) > 3 else 0
    files = sorted({os.path.basename(p)
                    for pat in ("*.step", "*.STEP", "*.stp")
                    for p in glob.glob(os.path.join(target, pat))})
    if not files:
        print("no STEP files under", target)
        return 2
    if not os.environ.get("VIEWER_PYTHONOCC_PYTHON"):
        print("!! VIEWER_PYTHONOCC_PYTHON 未设置 —— 产物将缺少特征注入列，口径与 HTTP 不一致",
              file=sys.stderr)

    if nwarm:
        tw = time.perf_counter()
        with ThreadPoolExecutor(nw) as pool:
            warm = list(pool.map(lambda n: _one(target, n), files[:nwarm]))
        print(f"预热 {nwarm} 件（{sum(w[0] for w in warm)}/{nwarm} ok）"
              f"耗时 {time.perf_counter() - tw:.2f}s，worker 池已就绪")

    t0 = time.perf_counter()
    with ThreadPoolExecutor(nw) as pool:
        res = list(pool.map(lambda n: _one(target, n), files))
    total = time.perf_counter() - t0

    durs = sorted(r[1] for r in res)
    ok = sum(1 for r in res if r[0])
    pick = lambda p: durs[min(len(durs) - 1, int(len(durs) * p))]  # noqa: E731
    print(f"本地并发={nw}  OK {ok}/{len(files)}  总墙钟 {total:.2f}s")
    print(f"  单件 p50={pick(.5):.2f}s p90={pick(.9):.2f}s max={pick(.999):.2f}s "
          f"Σ单件={sum(durs):.1f}s（含客户端侧开销，仅作参考）")
    for _, d, n in sorted(res, key=lambda r: -r[1])[:3]:
        print(f"  最慢: {n[:40]:<42} {d:5.2f}s")
    return 0 if ok == len(files) else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv))
