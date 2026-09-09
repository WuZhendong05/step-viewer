import glob
import json
import os
import struct
import sys

task_dir = sys.argv[1]
glbs = glob.glob(os.path.join(task_dir, "__cadgen__", "models", "**", "*.glb"), recursive=True)
if not glbs:
    print("NO GLB found under", task_dir)
    sys.exit(1)
for glb in glbs:
    data = open(glb, "rb").read()
    json_len = struct.unpack("<I", data[12:16])[0]
    bin_start = 20 + json_len + 8
    gltf = json.loads(data[20:20 + json_len])
    ext = gltf.get("extensions", {}).get("STEP_topology", {})
    if not ext:
        print(os.path.basename(glb), "-> no STEP_topology extension")
        continue
    bv = gltf["bufferViews"][ext["selectorView"]]
    start = bv.get("byteOffset", 0)
    raw = data[bin_start + start:bin_start + start + bv["byteLength"]]
    man = json.loads(raw.decode("utf-8"))
    cols = man.get("tables", {}).get("faceColumns", [])
    faces = man.get("faces", [])
    has = "stepEntityId" in cols
    nonzero = sum(1 for row in faces if row and row[cols.index("stepEntityId")] if has) if has else 0
    print(os.path.basename(glb), "stepEntityId column:", has, "| faces:", len(faces), "| non-zero ids:", nonzero)
