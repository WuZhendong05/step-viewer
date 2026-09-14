// 外包围盒叠加层的纯几何计算。
//
// 定位与 workbench/alignmentFrame.js 相同：不碰 React、不碰 DOM，只吃数字吐数字，
// 所以在 node:test 里可以直接测（不经过 JSX 转译）。
//
// 输出的是**屏幕空间（CSS 像素）**的数据，供 BoundingBoxOverlay 直接画 SVG：
//   * 12 条盒边，其中 3 条（与"隐藏角"相连的那 3 条）标记为 hidden —— 叠加层不画它们，
//     这个标记只用来把尺寸标注推到盒子外侧（尺寸线绝不能落在背面边上）
//   * 3 条尺寸标注（沿 X / Y / Z 各一条，即长 / 宽 / 高）
//
// 为什么"隐藏角"只要取深度最大的角点就够了：包围盒必然凸，所以离相机最远的那个角
// 一定不落在任何一个朝向相机的面上 —— 它就是被挡在后面的角，与它相连的 3 条边即隐藏边。
// 每转一次视角这 3 条边会换一组，这是几何事实（所有 CAD 查看器都如此），本模块按帧重算。

export const BOX_CORNER_COUNT = 8;
export const BOX_EDGE_COUNT = 12;

/** 角点索引：bit0 = x 取 max、bit1 = y 取 max、bit2 = z 取 max。 */
export function cornerIndex(ix, iy, iz) {
  return (ix ? 1 : 0) | (iy ? 2 : 0) | (iz ? 4 : 0);
}

// 12 条边，按轴分组（前 4 条沿 X、中间 4 条沿 Y、后 4 条沿 Z），
// 这样"某个轴的尺寸候选边"就是一段连续下标。
const EDGE_BUILD = (() => {
  const edges = [];
  const axis = [];
  for (const iy of [0, 1]) {
    for (const iz of [0, 1]) {
      edges.push([cornerIndex(0, iy, iz), cornerIndex(1, iy, iz)]);
      axis.push(0);
    }
  }
  for (const ix of [0, 1]) {
    for (const iz of [0, 1]) {
      edges.push([cornerIndex(ix, 0, iz), cornerIndex(ix, 1, iz)]);
      axis.push(1);
    }
  }
  for (const ix of [0, 1]) {
    for (const iy of [0, 1]) {
      edges.push([cornerIndex(ix, iy, 0), cornerIndex(ix, iy, 1)]);
      axis.push(2);
    }
  }
  return { edges, axis };
})();

export const BOX_EDGES = Object.freeze(EDGE_BUILD.edges.map((edge) => Object.freeze(edge)));
export const BOX_EDGE_AXIS = Object.freeze(EDGE_BUILD.axis);
/** 每个轴的 4 条候选边。 */
export const AXIS_EDGE_INDICES = Object.freeze([
  Object.freeze([0, 1, 2, 3]),
  Object.freeze([4, 5, 6, 7]),
  Object.freeze([8, 9, 10, 11])
]);
/** 每个角点相连的 3 条边。 */
export const CORNER_EDGE_INDICES = Object.freeze(
  Array.from({ length: BOX_CORNER_COUNT }, () => [])
);
(() => {
  const buckets = Array.from({ length: BOX_CORNER_COUNT }, () => []);
  BOX_EDGES.forEach(([a, b], edgeIndex) => {
    buckets[a].push(edgeIndex);
    buckets[b].push(edgeIndex);
  });
  buckets.forEach((list, corner) => {
    CORNER_EDGE_INDICES[corner].push(...list);
  });
})();

// 尺寸线与盒边之间的间距，以及引线两端的留白。
const OFFSET_MIN_PX = 20;
const OFFSET_MAX_PX = 56;
const OFFSET_RATIO = 0.07;
const LABEL_GAP_PX = 13;
const EXTENSION_GAP_PX = 3;
const EXTENSION_OVERSHOOT_PX = 4;
// 投影后长度小于这个值就不画（例如正俯视时"高"这条在屏幕上退化成一个点）。
const MIN_DIMENSION_PX = 14;

const toVector3 = (value) => {
  if (!Array.isArray(value) && !ArrayBuffer.isView(value)) {
    return null;
  }
  const x = Number(value[0]);
  const y = Number(value[1]);
  const z = Number(value[2]);
  return [x, y, z].every(Number.isFinite) ? [x, y, z] : null;
};

const clamp = (value, min, max) => Math.min(Math.max(value, min), max);

/** 尺寸文本：最多两位小数并去掉尾随零（与 featureRecognition 的 fmtDim 一致）。 */
export function formatLength(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return "";
  }
  const text = (Math.abs(numeric) < 0.005 ? 0 : numeric).toFixed(2).replace(/\.?0+$/, "");
  return text === "-0" ? "0" : text;
}

/**
 * 把包围盒 8 个角点投到屏幕。bounds 在 modelGroup 局部坐标里，必须走 localToWorld，
 * 这样基座四元数、模型偏移、缩放全都自动带上，不用手工拼矩阵。
 */
export function projectBoxCorners({ THREE, camera, modelGroup, bounds, width, height }) {
  const min = toVector3(bounds?.min);
  const max = toVector3(bounds?.max);
  // 注意：不要检查 camera.project —— three.js 的投影方法挂在 Vector3 上，相机本身没有它。
  if (!min || !max || !THREE?.Vector3 || !camera || !modelGroup?.localToWorld) {
    return null;
  }
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return null;
  }
  const points = new Array(BOX_CORNER_COUNT);
  for (const ix of [0, 1]) {
    for (const iy of [0, 1]) {
      for (const iz of [0, 1]) {
        const point = new THREE.Vector3(
          ix ? max[0] : min[0],
          iy ? max[1] : min[1],
          iz ? max[2] : min[2]
        );
        modelGroup.localToWorld(point);
        point.project(camera);
        if (!Number.isFinite(point.x) || !Number.isFinite(point.y) || !Number.isFinite(point.z)) {
          return null;
        }
        points[cornerIndex(ix, iy, iz)] = {
          x: (point.x * 0.5 + 0.5) * width,
          y: (-point.y * 0.5 + 0.5) * height,
          depth: point.z
        };
      }
    }
  }
  return points;
}

/** 离相机最远（隐藏）与最近（正面）的角点。NDC z 越大越远。 */
export function resolveDepthCorners(points) {
  let hidden = 0;
  let front = 0;
  for (let index = 1; index < points.length; index += 1) {
    if (points[index].depth > points[hidden].depth) {
      hidden = index;
    }
    if (points[index].depth < points[front].depth) {
      front = index;
    }
  }
  return { hidden, front };
}

const distance = (ax, ay, bx, by) => Math.hypot(ax - bx, ay - by);

function centroidOf(points) {
  let x = 0;
  let y = 0;
  for (const point of points) {
    x += point.x;
    y += point.y;
  }
  return { x: x / points.length, y: y / points.length };
}

// 每个轴挑一条"轮廓边"（两端既不是正面角、也不是隐藏角，即六边形轮廓上的边），
// 再按屏幕位置二选一：水平两轴取最靠下的（长落在左下、宽落在右下），
// 竖直轴取最靠左的（高落在左侧）。默认等轴测下就正好是"下方三边"。
//
// 刻意不用"离 2D 质心最远"做判据：真实相机的等轴测投影里，X 轴那两条候选边中
// 较远的那条落在盒子**上方**，选出来会与确认的设计不符。
function pickDimensionEdge(points, axis, hidden, front) {
  const silhouette = [];
  const all = [];
  for (const edgeIndex of AXIS_EDGE_INDICES[axis]) {
    const [a, b] = BOX_EDGES[edgeIndex];
    const entry = {
      edgeIndex,
      midX: (points[a].x + points[b].x) / 2,
      midY: (points[a].y + points[b].y) / 2
    };
    all.push(entry);
    if (a !== hidden && b !== hidden && a !== front && b !== front) {
      silhouette.push(entry);
    }
  }
  // 退化视角（例如正俯视）可能一条轮廓边都没有，退回全部候选。
  const candidates = silhouette.length ? silhouette : all;
  candidates.sort((left, right) => (
    axis === 2
      ? left.midX - right.midX || left.edgeIndex - right.edgeIndex
      : right.midY - left.midY || left.edgeIndex - right.edgeIndex
  ));
  return candidates[0];
}

function buildDimension(points, axis, pick, extent2d, min, max, centroid) {
  const [a, b] = BOX_EDGES[pick.edgeIndex];
  let dirX = pick.midX - centroid.x;
  let dirY = pick.midY - centroid.y;
  let length = Math.hypot(dirX, dirY);
  if (length < 1e-3) {
    // 退化：质心正好落在这条边中点上，改用边的 2D 法向朝外。
    const edgeX = points[b].x - points[a].x;
    const edgeY = points[b].y - points[a].y;
    length = Math.hypot(edgeX, edgeY) || 1;
    dirX = -edgeY / length;
    dirY = edgeX / length;
  } else {
    dirX /= length;
    dirY /= length;
  }
  const offset = clamp(
    Math.max(extent2d.width, extent2d.height) * OFFSET_RATIO,
    OFFSET_MIN_PX,
    OFFSET_MAX_PX
  );
  const shiftX = dirX * offset;
  const shiftY = dirY * offset;

  const from = { x: points[a].x + shiftX, y: points[a].y + shiftY };
  const to = { x: points[b].x + shiftX, y: points[b].y + shiftY };
  if (distance(from.x, from.y, to.x, to.y) < MIN_DIMENSION_PX) {
    return null;
  }
  const labelMidX = (from.x + to.x) / 2 + dirX * LABEL_GAP_PX;
  const labelMidY = (from.y + to.y) / 2 + dirY * LABEL_GAP_PX;
  return {
    axis,
    from,
    to,
    extensions: [
      {
        from: { x: points[a].x + dirX * EXTENSION_GAP_PX, y: points[a].y + dirY * EXTENSION_GAP_PX },
        to: { x: from.x + dirX * EXTENSION_OVERSHOOT_PX, y: from.y + dirY * EXTENSION_OVERSHOOT_PX }
      },
      {
        from: { x: points[b].x + dirX * EXTENSION_GAP_PX, y: points[b].y + dirY * EXTENSION_GAP_PX },
        to: { x: to.x + dirX * EXTENSION_OVERSHOOT_PX, y: to.y + dirY * EXTENSION_OVERSHOOT_PX }
      }
    ],
    label: {
      x: labelMidX,
      y: labelMidY,
      text: formatLength(max[axis] - min[axis])
    }
  };
}

/**
 * 叠加层的全部可序列化数据。返回 null 表示"这次画不出来"（调用方据此清空叠加层）。
 */
export function buildBoundingBoxOverlay({
  THREE,
  camera,
  modelGroup,
  bounds,
  width,
  height
}) {
  const min = toVector3(bounds?.min);
  const max = toVector3(bounds?.max);
  const points = projectBoxCorners({ THREE, camera, modelGroup, bounds, width, height });
  if (!points || !min || !max) {
    return null;
  }
  const { hidden, front } = resolveDepthCorners(points);
  const centroid = centroidOf(points);
  const hiddenEdges = new Set(CORNER_EDGE_INDICES[hidden]);

  const edges = BOX_EDGES.map(([a, b], edgeIndex) => ({
    ax: points[a].x,
    ay: points[a].y,
    bx: points[b].x,
    by: points[b].y,
    hidden: hiddenEdges.has(edgeIndex)
  }));

  const width2d = Math.max(...points.map((point) => point.x)) - Math.min(...points.map((point) => point.x));
  const height2d = Math.max(...points.map((point) => point.y)) - Math.min(...points.map((point) => point.y));
  const extent = { width: width2d, height: height2d };

  const dimensions = [];
  for (const axis of [0, 1, 2]) {
    const pick = pickDimensionEdge(points, axis, hidden, front);
    if (!pick) {
      continue;
    }
    const dimension = buildDimension(points, axis, pick, extent, min, max, centroid);
    if (dimension) {
      dimensions.push(dimension);
    }
  }

  return { width, height, edges, dimensions };
}

const NUMERIC_KEYS = ["ax", "ay", "bx", "by"];

/** 视角变化时避免每帧都换新对象触发重渲染；0.5px 以内视为没变。 */
export function boundingBoxOverlayEqual(left, right) {
  if (left === right) {
    return true;
  }
  if (!left || !right) {
    return false;
  }
  if (left.edges.length !== right.edges.length || left.dimensions.length !== right.dimensions.length) {
    return false;
  }
  if (Math.abs(left.width - right.width) > 0.5 || Math.abs(left.height - right.height) > 0.5) {
    return false;
  }
  for (let index = 0; index < left.edges.length; index += 1) {
    const a = left.edges[index];
    const b = right.edges[index];
    if (a.hidden !== b.hidden) {
      return false;
    }
    for (const key of NUMERIC_KEYS) {
      if (Math.abs(a[key] - b[key]) > 0.5) {
        return false;
      }
    }
  }
  for (let index = 0; index < left.dimensions.length; index += 1) {
    const a = left.dimensions[index];
    const b = right.dimensions[index];
    if (a.label.text !== b.label.text) {
      return false;
    }
    if (Math.abs(a.from.x - b.from.x) > 0.5 || Math.abs(a.from.y - b.from.y) > 0.5
      || Math.abs(a.to.x - b.to.x) > 0.5 || Math.abs(a.to.y - b.to.y) > 0.5
      || Math.abs(a.label.x - b.label.x) > 0.5 || Math.abs(a.label.y - b.label.y) > 0.5) {
      return false;
    }
  }
  return true;
}
