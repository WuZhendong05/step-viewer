import assert from "node:assert/strict";
import test from "node:test";

import { buildFeatureTree } from "./featureRecognition.js";

// 取自 samples/测试2特征识别.txt（方件）
const RECT_PAYLOAD = {
  code: 200,
  partType: "rectangular_part",
  numOfPart: 0,
  fixtureType: "Vise",
  msg: "",
  rectangular_part: {
    machinedSurface: { numberOfMachiningSurface: 4, numberOfBevels: 0, numberOfSides: 2 },
    partGeometryInformation: {
      surfaceArea: 52898.58,
      volume: 204966.34,
      basalArea: 25116.0,
      primeDirection: [0, 0, -1],
      assistantDirection: [0, 1, 0]
    },
    contour: { regular: { length: 300, width: 85, height: 12 } }
  }
};

function findLeaf(node, id) {
  if (!node || typeof node !== "object") {
    return null;
  }
  if (node.id === id) {
    return node;
  }
  for (const child of node.children || []) {
    const hit = findLeaf(child, id);
    if (hit) {
      return hit;
    }
  }
  return null;
}

function geometryBranch(payload) {
  const [root] = buildFeatureTree(payload);
  return findLeaf(root, "info:geometry");
}

test("方件几何信息里展示主加工方向与辅加工方向", () => {
  const geometry = geometryBranch(RECT_PAYLOAD);
  assert.ok(geometry, "应有 整体信息 > 几何信息");
  const labels = geometry.children.map((child) => child.label);
  assert.deepEqual(labels, ["表面积", "体积", "底面面积", "主加工方向", "辅加工方向"]);

  // 格式与原始特征 JSON 一致：[0.00, 0.00, -1.00]
  assert.equal(findLeaf(geometry, "info:prime").sub, "[0.00, 0.00, -1.00]");
  assert.equal(findLeaf(geometry, "info:assistant").sub, "[0.00, 1.00, 0.00]");
});

test("方向字段缺失时不渲染对应叶子（圆类没有这两个字段）", () => {
  const withoutDirections = {
    partType: "rectangular_part",
    rectangular_part: {
      machinedSurface: {},
      partGeometryInformation: { surfaceArea: 1, volume: 2, basalArea: 3 },
      contour: { regular: { length: 1, width: 1, height: 1 } }
    }
  };
  const labels = geometryBranch(withoutDirections).children.map((child) => child.label);
  assert.deepEqual(labels, ["表面积", "体积", "底面面积"]);
});

test("方向字段非法（长度不对/非数字）时也不渲染", () => {
  const badPayload = {
    partType: "rectangular_part",
    rectangular_part: {
      machinedSurface: {},
      partGeometryInformation: {
        surfaceArea: 1,
        volume: 2,
        basalArea: 3,
        primeDirection: [0, 0],
        assistantDirection: [0, null, 1]
      },
      contour: { regular: { length: 1, width: 1, height: 1 } }
    }
  };
  const labels = geometryBranch(badPayload).children.map((child) => child.label);
  assert.equal(labels.includes("主加工方向"), false);
  assert.equal(labels.includes("辅加工方向"), false);
});
