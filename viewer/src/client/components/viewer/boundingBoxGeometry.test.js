import test from "node:test";
import assert from "node:assert/strict";

import {
  AXIS_EDGE_INDICES,
  BOX_CORNER_COUNT,
  BOX_EDGES,
  BOX_EDGE_COUNT,
  CORNER_EDGE_INDICES,
  boundingBoxOverlayEqual,
  buildBoundingBoxOverlay,
  cornerIndex,
  formatLength,
  projectBoxCorners,
  resolveDepthCorners
} from "./boundingBoxGeometry.js";

// 用**真实的正交投影**做 stub：屏幕坐标由两个正交的屏幕基向量决定，
// 深度沿视线方向线性映射进 NDC。这样才能真正检验"最远的角 = 隐藏角"这条判据 ——
// 若改成常见的 2:1 仿射简写（ex=(1,-0.5)、ey=(1,0.5)），深度排序就不是几何一致的。
const BOX = { min: [0, 0, 0], max: [50, 30, 25] };
const WIDTH = 680;
const HEIGHT = 600;
const SCALE = 6;
const CENTER = { x: 340, y: 300 };

const SQRT1_2 = Math.SQRT1_2;
const INV_SQRT6 = 1 / Math.sqrt(6);
const INV_SQRT3 = 1 / Math.sqrt(3);

// 相机在盒子的 (-1,-1,+1) 方向 → 看到 x=min、y=min、z=max 三个面。
const ISO_CAMERA = {
  u: { x: -SQRT1_2, y: SQRT1_2, z: 0 },
  v: { x: INV_SQRT6, y: INV_SQRT6, z: 2 * INV_SQRT6 },
  n: { x: INV_SQRT3, y: INV_SQRT3, z: -INV_SQRT3 }
};

// 正俯视：沿 +Z 看下去，Z 方向的边在屏幕上退化成一个点。
const TOP_CAMERA = {
  u: { x: 1, y: 0, z: 0 },
  v: { x: 0, y: 1, z: 0 },
  n: { x: 0, y: 0, z: 1 }
};

function makeVector3Class() {
  return class FakeVector3 {
    constructor(x = 0, y = 0, z = 0) {
      this.x = x;
      this.y = y;
      this.z = z;
    }

    project(camera) {
      const { u, v, n, center, scale, width, height, depthRange } = camera;
      const px = this.x;
      const py = this.y;
      const pz = this.z;
      const right = px * u.x + py * u.y + pz * u.z;
      const up = px * v.x + py * v.y + pz * v.z;
      const along = px * n.x + py * n.y + pz * n.z;
      const sx = center.x + right * scale;
      const sy = center.y - up * scale;
      const span = depthRange[1] - depthRange[0];
      this.x = (2 * sx) / width - 1;
      this.y = 1 - (2 * sy) / height;
      this.z = span === 0 ? 0 : (2 * (along - depthRange[0])) / span - 1;
      return this;
    }
  };
}

const THREE = { Vector3: makeVector3Class() };

const cornerPoints3d = () => {
  const list = [];
  for (const x of [BOX.min[0], BOX.max[0]]) {
    for (const y of [BOX.min[1], BOX.max[1]]) {
      for (const z of [BOX.min[2], BOX.max[2]]) {
        list.push([x, y, z]);
      }
    }
  }
  return list;
};

/** 以给定方向构造相机，并把盒子的深度范围归一化进 NDC。 */
function makeCamera({ u, v, n }, { center = CENTER, scale = SCALE, offset = [0, 0, 0] } = {}) {
  const depths = cornerPoints3d().map(([x, y, z]) => (
    (x + offset[0]) * n.x + (y + offset[1]) * n.y + (z + offset[2]) * n.z
  ));
  return {
    ...ISO_CAMERA_PROPS(u, v, n),
    center,
    scale,
    width: WIDTH,
    height: HEIGHT,
    depthRange: [Math.min(...depths), Math.max(...depths)]
  };
}

const ISO_CAMERA_PROPS = (u, v, n) => ({ u, v, n });

function makeModelGroup(offset = [0, 0, 0]) {
  return {
    localToWorld(vector) {
      vector.x += offset[0];
      vector.y += offset[1];
      vector.z += offset[2];
      return vector;
    }
  };
}

const overlayFor = (camera, offset = [0, 0, 0]) => buildBoundingBoxOverlay({
  THREE,
  camera,
  modelGroup: makeModelGroup(offset),
  bounds: BOX,
  width: WIDTH,
  height: HEIGHT
});

test("盒拓扑：12 条边、每角 3 条、每轴 4 条", () => {
  assert.equal(BOX_EDGE_COUNT, 12);
  assert.equal(BOX_EDGES.length, 12);
  assert.equal(BOX_CORNER_COUNT, 8);
  const seen = new Set();
  for (const [a, b] of BOX_EDGES) {
    const key = `${Math.min(a, b)}-${Math.max(a, b)}`;
    assert.ok(!seen.has(key), `重复边 ${key}`);
    seen.add(key);
    assert.notEqual(a, b);
  }
  assert.equal(seen.size, 12);
  for (let corner = 0; corner < BOX_CORNER_COUNT; corner += 1) {
    assert.equal(CORNER_EDGE_INDICES[corner].length, 3, `角 ${corner} 的连接边数`);
  }
  for (const axis of [0, 1, 2]) {
    assert.equal(AXIS_EDGE_INDICES[axis].length, 4, `轴 ${axis} 的候选边数`);
  }
  assert.equal(cornerIndex(1, 1, 0), 3);
  assert.equal(cornerIndex(0, 0, 1), 4);
});

test("等轴测下：正面角=z 最大、隐藏角=z 最小且 x/y 最大", () => {
  const camera = makeCamera(ISO_CAMERA);
  const points = projectBoxCorners({
    THREE,
    camera,
    modelGroup: makeModelGroup(),
    bounds: BOX,
    width: WIDTH,
    height: HEIGHT
  });
  assert.ok(points);
  const { hidden, front } = resolveDepthCorners(points);
  // 相机在 (-1,-1,+1) 方向 → 最近的是 (0,0,zmax)，最远的是 (xmax,ymax,0)
  assert.equal(front, cornerIndex(0, 0, 1));
  assert.equal(hidden, cornerIndex(1, 1, 0));
});

test("等轴测下：三向尺寸落在下方三边（长左下、宽右下、高左侧）", () => {
  const overlay = overlayFor(makeCamera(ISO_CAMERA));
  assert.ok(overlay);
  assert.equal(overlay.edges.length, 12);
  assert.equal(overlay.dimensions.length, 3);
  assert.deepEqual(overlay.dimensions.map((entry) => entry.label.text), ["50", "30", "25"]);

  const [length, width, height] = overlay.dimensions;
  // X 尺寸线的方向必须与 A→B 平行，且整体被推到质心之外（左下）
  const dx = length.to.x - length.from.x;
  const dy = length.to.y - length.from.y;
  assert.ok(Math.abs(dy / dx - (177.526 - 300) / (127.868 - 340)) < 0.02, "长的尺寸线不平行于前下边");
  assert.ok(length.from.x > 127 && length.from.x < 340, "长的尺寸线没有落在左下");
  assert.ok(length.from.y > 300, "长的尺寸线应该在盒子下方");

  // 高的尺寸线是竖直的，且被推到最左侧
  assert.ok(Math.abs(height.to.x - height.from.x) < 0.001, "高的尺寸线应该是竖直的");
  assert.ok(height.from.x < 127.868, "高的尺寸线应该在盒子左侧");

  // 宽的尺寸线在右下
  assert.ok(width.from.x > 340, "宽的尺寸线应该在右下");
});

test("隐藏边恰好是与隐藏角相连的 3 条，且随视角翻转", () => {
  const iso = overlayFor(makeCamera(ISO_CAMERA));
  const hiddenIso = iso.edges.map((edge, index) => (edge.hidden ? index : -1)).filter((i) => i >= 0);
  assert.equal(hiddenIso.length, 3);
  assert.deepEqual(hiddenIso.slice().sort((a, b) => a - b), CORNER_EDGE_INDICES[cornerIndex(1, 1, 0)].slice().sort((a, b) => a - b));

  // 换成 (-1,-1,-1) 方向（相机移到下方）→ 隐藏角应换到 z 最小的那一侧
  const flipped = overlayFor(makeCamera({
    u: { x: -SQRT1_2, y: SQRT1_2, z: 0 },
    v: { x: -INV_SQRT6, y: -INV_SQRT6, z: -2 * INV_SQRT6 },
    n: { x: INV_SQRT3, y: INV_SQRT3, z: INV_SQRT3 }
  }));
  const hiddenFlipped = flipped.edges.map((edge, index) => (edge.hidden ? index : -1)).filter((i) => i >= 0);
  assert.equal(hiddenFlipped.length, 3);
  assert.notDeepEqual(hiddenFlipped.slice().sort((a, b) => a - b), hiddenIso.slice().sort((a, b) => a - b));
});

test("正俯视：高的尺寸退化，只剩长与宽", () => {
  const overlay = overlayFor(makeCamera(TOP_CAMERA));
  assert.ok(overlay);
  assert.deepEqual(overlay.dimensions.map((entry) => entry.label.text), ["50", "30"]);
  for (const dimension of overlay.dimensions) {
    const span = Math.hypot(dimension.to.x - dimension.from.x, dimension.to.y - dimension.from.y);
    assert.ok(span >= 14, "退化尺寸不该被画出来");
  }
});

test("模型偏移会体现在投影结果里（走 localToWorld）", () => {
  const base = overlayFor(makeCamera(ISO_CAMERA));
  const shifted = overlayFor(makeCamera(ISO_CAMERA), [100, 0, 0]);
  const centroid = (overlay) => {
    const sum = overlay.edges.reduce(
      (acc, edge) => ({ x: acc.x + (edge.ax + edge.bx) / 2, y: acc.y + (edge.ay + edge.by) / 2 }),
      { x: 0, y: 0 }
    );
    return { x: sum.x / overlay.edges.length, y: sum.y / overlay.edges.length };
  };
  const delta = {
    x: centroid(shifted).x - centroid(base).x,
    y: centroid(shifted).y - centroid(base).y
  };
  // 沿 +X 平移 100 → 屏幕右移基向量投到 -0.7071，上移基向量投到 +0.4082
  assert.ok(Math.abs(delta.x - (-SQRT1_2 * 100 * SCALE)) < 0.5, `x 位移不对：${delta.x}`);
  assert.ok(Math.abs(delta.y - (-INV_SQRT6 * 100 * SCALE)) < 0.5, `y 位移不对：${delta.y}`);
});

test("缺数据 / 尺寸为零时不至于炸掉", () => {
  assert.equal(buildBoundingBoxOverlay({
    THREE, camera: makeCamera(ISO_CAMERA), modelGroup: makeModelGroup(), bounds: null, width: WIDTH, height: HEIGHT
  }), null);
  assert.equal(buildBoundingBoxOverlay({
    THREE, camera: makeCamera(ISO_CAMERA), modelGroup: makeModelGroup(), bounds: BOX, width: 0, height: HEIGHT
  }), null);
  const flat = buildBoundingBoxOverlay({
    THREE,
    camera: makeCamera(TOP_CAMERA),
    modelGroup: makeModelGroup(),
    bounds: { min: [0, 0, 0], max: [50, 30, 0] },
    width: WIDTH,
    height: HEIGHT
  });
  assert.ok(flat);
  assert.equal(flat.dimensions.length, 2, "零厚度的 z 尺寸不该出现");
});

test("formatLength 去掉尾随零且不留 -0", () => {
  assert.equal(formatLength(50), "50");
  assert.equal(formatLength(50.5), "50.5");
  assert.equal(formatLength(0.125), "0.13");
  assert.equal(formatLength(0), "0");
  assert.equal(formatLength(-0.0001), "0");
  assert.equal(formatLength(Number.NaN), "");
});

test("boundingBoxOverlayEqual 对微小抖动判定为相等", () => {
  const base = overlayFor(makeCamera(ISO_CAMERA));
  assert.equal(boundingBoxOverlayEqual(base, base), true);
  assert.equal(boundingBoxOverlayEqual(null, base), false);
  assert.equal(boundingBoxOverlayEqual(base, null), false);
  const nudged = {
    ...base,
    edges: base.edges.map((edge, index) => (
      index === 0 ? { ...edge, ax: edge.ax + 0.2 } : edge
    ))
  };
  assert.equal(boundingBoxOverlayEqual(base, nudged), true);
  const moved = {
    ...base,
    edges: base.edges.map((edge, index) => (
      index === 0 ? { ...edge, ax: edge.ax + 9 } : edge
    ))
  };
  assert.equal(boundingBoxOverlayEqual(base, moved), false);
  const flipped = {
    ...base,
    edges: base.edges.map((edge, index) => (
      index === 0 ? { ...edge, hidden: !edge.hidden } : edge
    ))
  };
  assert.equal(boundingBoxOverlayEqual(base, flipped), false);
});
