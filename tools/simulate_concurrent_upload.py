# -*- coding: utf-8 -*-
"""模拟业务系统同时并发上传 N 个零件 → 全部 prewarm ready 的端到端压测。

口径（与业务一致）：
  T0 = 第一批并发 POST 发出
  阶段1: 全部拿到 202 + jobId
  阶段2: 轮询 GET /jobs/{id}，直到 status=landed 且 prewarm=ready（模型完全可看）
  报告: 总墙钟 / 上传阶段 / 预热阶段 / landed 就绪分位

用法: python tools/simulate_concurrent_upload.py <dir> [并发数] [上限件数]
"""
import glob
import json
import os
import sys
import time
import urllib.request
import uuid
from concurrent.futures import ThreadPoolExecutor

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
API = "http://127.0.0.1:8420/api/v1/jobs"


def api_key():
    for p in (os.path.join(ROOT, "secrets", "api.key"),):
        if os.path.isfile(p):
            return open(p, "r", encoding="utf-8").read().strip()
    raise SystemExit("api key not found")


def multipart(step_name: str, data: bytes) -> tuple[str, bytes]:
    boundary = "----sim" + uuid.uuid4().hex
    part = (
        f"--{boundary}\r\n"
        f'Content-Disposition: form-data; name="step"; filename="{step_name}"\r\n'
        f"Content-Type: application/step\r\n\r\n"
    ).encode("utf-8") + data + f"\r\n--{boundary}--\r\n".encode("utf-8")
    return f"multipart/form-data; boundary={boundary}", part


def upload_one(path: str, key: str):
    t0 = time.perf_counter()
    body = open(path, "rb").read()
    ctype, payload = multipart(os.path.basename(path), body)
    req = urllib.request.Request(
        API, data=payload, method="POST",
        headers={"Authorization": f"Bearer {key}", "Content-Type": ctype},
    )
    with urllib.request.urlopen(req, timeout=120) as resp:
        job = json.loads(resp.read().decode("utf-8"))
    return job["jobId"], t0, time.perf_counter()


def job_state(job_id: str, key: str):
    req = urllib.request.Request(
        f"{API}/{job_id}", headers={"Authorization": f"Bearer {key}"})
    with urllib.request.urlopen(req, timeout=30) as resp:
        return json.loads(resp.read().decode("utf-8"))


def main(argv):
    target = os.path.abspath(argv[1]) if len(argv) > 1 else os.path.join(ROOT, "samples", "100")
    concurrency = int(argv[2]) if len(argv) > 2 else 20
    limit = int(argv[3]) if len(argv) > 3 else 10**9
    key = api_key()
    files = sorted({p for pat in ("*.step", "*.STEP", "*.stp")
                    for p in glob.glob(os.path.join(target, pat))})[:limit]
    if not files:
        print("no step files"); return 2
    print(f"并发={concurrency} 件数={len(files)} 总大小="
          f"{sum(os.path.getsize(f) for f in files)/1024/1024:.1f}MB")

    t0 = time.perf_counter()
    with ThreadPoolExecutor(concurrency) as pool:
        uploads = list(pool.map(lambda p: upload_one(p, key), files))
    t_uploaded = time.perf_counter()
    job_ids = [u[0] for u in uploads]
    print(f"阶段1 上传: 全部 202 于 {t_uploaded - t0:.2f}s "
          f"(p50={sorted(u[2]-u[1] for u in uploads)[len(uploads)//2]:.2f}s "
          f"max={max(u[2]-u[1] for u in uploads):.2f}s)")

    # 轮询直到全部 prewarm ready / failed
    pending = set(job_ids)
    landed_t, ready_t, failed = {}, {}, []
    while pending:
        time.sleep(0.4)
        for jid in list(pending):
            try:
                d = job_state(jid, key)
            except Exception:
                continue
            if d.get("status") == "landed" and jid not in landed_t:
                landed_t[jid] = time.perf_counter()
            if d.get("prewarm") == "ready":
                ready_t[jid] = time.perf_counter(); pending.discard(jid)
            elif d.get("prewarm") == "failed" or d.get("status") == "failed":
                failed.append(jid); pending.discard(jid)
    t_end = time.perf_counter()

    lat = sorted(ready_t[j] - t0 for j in ready_t)
    landed_lat = sorted(landed_t[j] - t0 for j in landed_t)
    def pct(seq, p): return seq[min(len(seq)-1, int(len(seq)*p))] if seq else 0
    print(f"阶段2 预热: 全部 ready 于 {t_end - t0:.2f}s")
    print("---")
    print(f"成功 {len(ready_t)}/{len(files)}  失败 {len(failed)}")
    print(f"landed(拿URL) 就绪: p50={pct(landed_lat,.5):.2f}s p90={pct(landed_lat,.9):.2f}s "
          f"p99={pct(landed_lat,.99):.2f}s max={max(landed_lat) if landed_lat else 0:.2f}s")
    print(f"prewarm ready(完全可用): p50={pct(lat,.5):.2f}s p90={pct(lat,.9):.2f}s "
          f"p99={pct(lat,.99):.2f}s max={max(lat) if lat else 0:.2f}s")
    print(f"总墙钟(T0→全部完全可用) = {t_end - t0:.2f}s")
    return 0 if not failed else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv))
