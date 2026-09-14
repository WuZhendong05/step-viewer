// 零件摆正（alignment）坐标系。
//
// 由特征识别 JSON 的
//   {partType}.partGeometryInformation.primeDirection     —— 主加工面法向（见文档 §partGeometryInformation）
//   {partType}.partGeometryInformation.assistantDirection —— 辅方向
// 构造正交右手基（摆正坐标系 X′/Y′/Z′），并给出"世界坐标 → 摆正坐标"的旋转 R：
//
//   Z′ = normalize(primeDirection)
//   X′ = normalize(assistantDirection − (assistantDirection·Z′)Z′)   // Gram-Schmidt 正交化
//   Y′ = Z′ × X′                                                     // 右手系，无需取舍
//   R  = Mᵀ，M 的三列为 X′/Y′/Z′  ⇒  R·prime = (0,0,1)，R·assistant = (1,0,0)
//
// R 作为 viewGroup 的"基座四元数"参与渲染：整个模型/边线/拾取组都挂在 viewGroup 下
// （components/viewer/hooks/useViewerRuntime.js），所以只需转 viewGroup 即全部一致。
//
// 实测真实数据里 primeDirection / assistantDirection 100% 是 ±单位轴向量且互相正交
// （samples + uploads 共 7 份），因此这里保留了"轴对齐取整"快速路径：先把分量吸附到精确
// 整数，避免 0.9999999 这类浮点残差污染四元数（也让断言可以写成严格相等）。
//
// 本模块保持纯函数（不依赖 three），便于单测。

const EPSILON = 1e-9;
const SNAP_EPSILON = 1e-9;

export const IDENTITY_QUATERNION = Object.freeze([0, 0, 0, 1]);

export const ALIGNMENT_INVALID_REASONS = Object.freeze({
  MISSING_PRIME: "缺少主加工方向",
  MISSING_ASSISTANT: "缺少辅加工方向",
  PRIME_INVALID: "主加工方向不是有效三维向量",
  ASSISTANT_INVALID: "辅加工方向不是有效三维向量",
  PRIME_ZERO: "主加工方向是零向量",
  ASSISTANT_ZERO: "辅加工方向是零向量",
  PARALLEL: "主加工方向与辅加工方向平行，无法确定摆正坐标系"
});

// 严格的 3 维数值解析：null / undefined / "" / 布尔一律拒绝
// （否则 Number(null) === 0 会把脏数据悄悄变成一个可用的方向）。
function toVector3(value) {
  if (!Array.isArray(value) || value.length !== 3) {
    return null;
  }
  const out = [];
  for (const entry of value) {
    if (typeof entry !== "number" && typeof entry !== "string") {
      return null;
    }
    if (String(entry).trim() === "") {
      return null;
    }
    const numeric = Number(entry);
    if (!Number.isFinite(numeric)) {
      return null;
    }
    out.push(numeric);
  }
  return out;
}

const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

const cross = (a, b) => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0]
];

const length = (v) => Math.hypot(...v);

function normalize(v) {
  const magnitude = length(v);
  if (!Number.isFinite(magnitude) || magnitude < EPSILON) {
    return null;
  }
  return v.map((entry) => entry / magnitude);
}

// 轴对齐（±单位轴）向量吸附为精确整数；只要有一个分量不是 ±1/0 就原样返回。
// 顺手把 -0 归一成 0（叉积会产生 -0，会让严格相等断言与序列化结果不一致）。
function snapAxisAligned(vector) {
  const snapped = vector.map((entry) => {
    const rounded = Math.round(entry);
    const value = Math.abs(entry - rounded) <= SNAP_EPSILON ? rounded : entry;
    return value === 0 ? 0 : value;
  });
  const axisAligned = snapped.every(
    (entry) => Math.abs(entry) < SNAP_EPSILON || Math.abs(Math.abs(entry) - 1) < SNAP_EPSILON
  );
  return axisAligned ? snapped : vector;
}

// 把三列基向量组成的矩阵 M 求转置再转四元数。
// M 的三列是 X′/Y′/Z′，而 R = Mᵀ ⇒ R 的三"行"才是 X′/Y′/Z′：
//   R·v = (X′·v, Y′·v, Z′·v)，所以 row0 = X′、row1 = Y′、row2 = Z′。
// 行主序 m{row}{col} 即 m00 = xAxis[0], m01 = xAxis[1], m02 = xAxis[2], ...
function quaternionFromTransposedBasis(xAxis, yAxis, zAxis) {
  const m00 = xAxis[0];
  const m01 = xAxis[1];
  const m02 = xAxis[2];
  const m10 = yAxis[0];
  const m11 = yAxis[1];
  const m12 = yAxis[2];
  const m20 = zAxis[0];
  const m21 = zAxis[1];
  const m22 = zAxis[2];

  const trace = m00 + m11 + m22;
  let w;
  let x;
  let y;
  let z;
  if (trace > 0) {
    const s = Math.sqrt(trace + 1) * 2;
    w = 0.25 * s;
    x = (m21 - m12) / s;
    y = (m02 - m20) / s;
    z = (m10 - m01) / s;
  } else if (m00 > m11 && m00 > m22) {
    const s = Math.sqrt(1 + m00 - m11 - m22) * 2;
    w = (m21 - m12) / s;
    x = 0.25 * s;
    y = (m01 + m10) / s;
    z = (m02 + m20) / s;
  } else if (m11 > m22) {
    const s = Math.sqrt(1 + m11 - m00 - m22) * 2;
    w = (m02 - m20) / s;
    x = (m01 + m10) / s;
    y = 0.25 * s;
    z = (m12 + m21) / s;
  } else {
    const s = Math.sqrt(1 + m22 - m00 - m11) * 2;
    w = (m10 - m01) / s;
    x = (m02 + m20) / s;
    y = (m12 + m21) / s;
    z = 0.25 * s;
  }
  const normalized = normalize([x, y, z, w]);
  return normalized || [...IDENTITY_QUATERNION];
}

// 用四元数旋转一个三维向量（v + 2w(q×v) + 2q×(q×v)），避免依赖 three。
export function applyQuaternionToVector(quaternion, vector) {
  const [x, y, z, w] = quaternion ?? IDENTITY_QUATERNION;
  const qv = [x, y, z];
  const uv = cross(qv, vector);
  const uuv = cross(qv, uv);
  return [
    vector[0] + 2 * (w * uv[0] + uuv[0]),
    vector[1] + 2 * (w * uv[1] + uuv[1]),
    vector[2] + 2 * (w * uv[2] + uuv[2])
  ];
}

/**
 * 由两个方向构造摆正坐标系。
 * @returns {{ok: boolean, reason: string, prime: number[]|null, assistant: number[]|null,
 *            xAxis: number[]|null, yAxis: number[]|null, zAxis: number[]|null,
 *            quaternion: number[], axisAligned: boolean}}
 *   quaternion = [x, y, z, w]，即基座四元数；ok=false 时是单位四元数（调用方应忽略）。
 */
export function resolveAlignmentFrame(primeDirection, assistantDirection) {
  const invalid = (reason) => ({
    ok: false,
    reason,
    prime: null,
    assistant: null,
    xAxis: null,
    yAxis: null,
    zAxis: null,
    quaternion: [...IDENTITY_QUATERNION],
    axisAligned: false
  });

  if (primeDirection == null) {
    return invalid(ALIGNMENT_INVALID_REASONS.MISSING_PRIME);
  }
  if (assistantDirection == null) {
    return invalid(ALIGNMENT_INVALID_REASONS.MISSING_ASSISTANT);
  }
  const primeRaw = toVector3(primeDirection);
  if (!primeRaw) {
    return invalid(ALIGNMENT_INVALID_REASONS.PRIME_INVALID);
  }
  const assistantRaw = toVector3(assistantDirection);
  if (!assistantRaw) {
    return invalid(ALIGNMENT_INVALID_REASONS.ASSISTANT_INVALID);
  }
  const prime = normalize(snapAxisAligned(primeRaw));
  if (!prime) {
    return invalid(ALIGNMENT_INVALID_REASONS.PRIME_ZERO);
  }
  const assistant = normalize(snapAxisAligned(assistantRaw));
  if (!assistant) {
    return invalid(ALIGNMENT_INVALID_REASONS.ASSISTANT_ZERO);
  }

  const zAxis = prime;
  const projection = dot(assistant, zAxis);
  const residual = [
    assistant[0] - projection * zAxis[0],
    assistant[1] - projection * zAxis[1],
    assistant[2] - projection * zAxis[2]
  ];
  const xAxis = normalize(snapAxisAligned(residual));
  if (!xAxis) {
    // assistant 与 prime 共线：无法确定 X′，宁可拒绝也不给一个"看起来能用"的歪坐标系。
    return invalid(ALIGNMENT_INVALID_REASONS.PARALLEL);
  }
  const yAxis = normalize(snapAxisAligned(cross(zAxis, xAxis)));

  return {
    ok: true,
    reason: "",
    prime,
    assistant,
    xAxis,
    yAxis,
    zAxis,
    quaternion: quaternionFromTransposedBasis(xAxis, yAxis, zAxis),
    axisAligned: [xAxis, yAxis, zAxis].every((axis) => axis.every((entry) => Number.isInteger(entry)))
  };
}

/**
 * 摆正坐标系下"包围盒顶面中心"在 authored 坐标里的位置。
 * = 八个角点中沿 +zAxis 最靠前的那些点的中心（轴对齐时就是那个面的精确中心）。
 */
export function alignmentAnchorPoint(bounds, zAxis) {
  const min = toVector3(bounds?.min);
  const max = toVector3(bounds?.max);
  const axis = toVector3(zAxis);
  if (!min || !max || !axis) {
    return null;
  }
  const center = [
    (min[0] + max[0]) / 2,
    (min[1] + max[1]) / 2,
    (min[2] + max[2]) / 2
  ];
  const corners = [];
  for (const x of [min[0], max[0]]) {
    for (const y of [min[1], max[1]]) {
      for (const z of [min[2], max[2]]) {
        corners.push([x, y, z]);
      }
    }
  }
  const heights = corners.map((corner) => dot(
    [corner[0] - center[0], corner[1] - center[1], corner[2] - center[2]],
    axis
  ));
  const highest = Math.max(...heights);
  const top = corners.filter((_, index) => highest - heights[index] <= 1e-6);
  const sum = top.reduce(
    (acc, corner) => [acc[0] + corner[0], acc[1] + corner[1], acc[2] + corner[2]],
    [0, 0, 0]
  );
  return sum.map((entry) => entry / top.length);
}

/**
 * 包围盒经 baseFrame 旋转（并整体平移 modelOffset）之后的最低点世界 Z。
 * 摆正后用它重算地板高度，零件才会"落在"摆正姿态的最低面上。
 */
export function rotatedBoundsMinZ(bounds, modelOffset, quaternion) {
  const min = toVector3(bounds?.min);
  const max = toVector3(bounds?.max);
  if (!min || !max) {
    return null;
  }
  const offset = toVector3(modelOffset) || [0, 0, 0];
  let lowest = Infinity;
  for (const x of [min[0], max[0]]) {
    for (const y of [min[1], max[1]]) {
      for (const z of [min[2], max[2]]) {
        const rotated = applyQuaternionToVector(quaternion, [x + offset[0], y + offset[1], z + offset[2]]);
        if (rotated[2] < lowest) {
          lowest = rotated[2];
        }
      }
    }
  }
  return Number.isFinite(lowest) ? lowest : null;
}

/**
 * 从特征识别 payload 里取"用于摆正的段"：多实体取体积最大的那一段（用户决策 3）。
 * 返回 { partType, part, primeDirection, assistantDirection, volume, segmentIndex } 或 null。
 */
export function resolveAlignmentSource(payload) {
  const segments = Array.isArray(payload?.parts) && payload.parts.length
    ? payload.parts
    : (payload && typeof payload === "object" ? [payload] : []);

  let best = null;
  segments.forEach((segment, index) => {
    const partType = String(segment?.partType || "").trim();
    const part = segment?.[partType] && typeof segment[partType] === "object" ? segment[partType] : segment;
    const info = part?.partGeometryInformation;
    if (!info) {
      return;
    }
    const volumeRaw = Number(info.volume);
    const volume = Number.isFinite(volumeRaw) && volumeRaw > 0 ? volumeRaw : 0;
    if (!best || volume > best.volume) {
      best = {
        partType,
        part,
        primeDirection: info.primeDirection ?? null,
        assistantDirection: info.assistantDirection ?? null,
        volume,
        segmentIndex: index
      };
    }
  });
  return best;
}
