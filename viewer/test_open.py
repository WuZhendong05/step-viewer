import base64
import json
import os
import urllib.error
import urllib.parse
import urllib.request

BASE = os.environ.get("VIEWER_BASE", "http://127.0.0.1:3245")
_REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
STEP = os.path.join(_REPO, "samples", "测试1.STEP")
JSONF = os.path.join(_REPO, "samples", "测试1特征识别.txt")


def get(url, timeout=30):
    req = urllib.request.Request(url, method="GET")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return resp.status, resp.read()
    except urllib.error.HTTPError as exc:
        return exc.code, exc.read()


def post_json(url, payload, timeout=60):
    req = urllib.request.Request(
        url, data=json.dumps(payload).encode("utf-8"),
        headers={"content-type": "application/json"}, method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return resp.status, resp.read()
    except urllib.error.HTTPError as exc:
        return exc.code, exc.read()


# 1) create the link
step_b64 = base64.b64encode(open(STEP, "rb").read()).decode("ascii")
feat = open(JSONF, encoding="utf-8").read()
status, body = post_json(BASE + "/__cad/link", {
    "stepName": "测试1.STEP", "stepData": step_b64, "featuresJson": feat,
})
link = json.loads(body)
task_dir = link["dir"]
print("link:", status, link["url"])

# 2) catalog single-file mode for the uploaded STEP
cat_url = BASE + "/__cad/catalog?" + urllib.parse.urlencode({"dir": task_dir, "file": link["file"]})
status, body = get(cat_url)
cat = json.loads(body)
print("catalog:", status, "entries:", len(cat.get("entries", [])), "file:", cat["entries"][0]["file"] if cat.get("entries") else "-")

# 3) feature JSON served as an asset
feat_abs = os.path.join(task_dir, link["features"])
asset_url = BASE + "/__cad/asset?" + urllib.parse.urlencode({"file": feat_abs})
status, body = get(asset_url)
print("features asset:", status, "len:", len(body), "has rectangular_part:", "rectangular_part" in body.decode("utf-8", "replace"))

# 4) lazy artifact build (what opening the URL triggers) + stepEntityId injection
art_url = BASE + "/__cad/artifact?" + urllib.parse.urlencode({"dir": task_dir, "file": link["file"]})
status, body = post_json(art_url, {"force": "1"}, timeout=240)
print("artifact build:", status)
try:
    art = json.loads(body)
    print("  state:", art.get("state"), "ok:", art.get("ok"), "error:", art.get("error"))
except Exception as exc:
    print("  parse failed:", exc, body[:300])
