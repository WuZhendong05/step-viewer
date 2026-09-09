import base64
import json
import os
import sys
import urllib.error
import urllib.request

BASE = os.environ.get("VIEWER_BASE", "http://127.0.0.1:3245")
_REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
STEP = os.path.join(_REPO, "samples", "测试1.STEP")
JSONF = os.path.join(_REPO, "samples", "测试1特征识别.txt")

step_b64 = base64.b64encode(open(STEP, "rb").read()).decode("ascii")
feat = open(JSONF, encoding="utf-8").read()

payload = {"stepName": "测试1.STEP", "stepData": step_b64, "featuresJson": feat}
req = urllib.request.Request(
    BASE + "/__cad/link",
    data=json.dumps(payload).encode("utf-8"),
    headers={"content-type": "application/json"},
    method="POST",
)
try:
    with urllib.request.urlopen(req, timeout=30) as resp:
        print("STATUS", resp.status)
        print(resp.read().decode("utf-8"))
except urllib.error.HTTPError as exc:
    print("HTTP", exc.code, exc.read().decode("utf-8"))
