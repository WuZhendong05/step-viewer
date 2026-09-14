import { useState } from "react";

// Screen-space axes indicator (HUD gizmo) pinned to the bottom-left of the
// viewport, like mainstream CAD tools. It draws the world X/Y/Z axes projected
// through the live camera orientation, so the indicator rotates exactly with
// the model. Standard CAD axis colors: X = red, Y = green, Z = blue.
// The indicator is translucent at rest and opaque on hover so it never
// obscures the model; hovering an axis highlights it.

const ORIENTATION_FALLBACK = Object.freeze({
  x: [1, 0, 0],
  y: [0, 1, 0],
  z: [0, 0, 1]
});

const AXIS_COLORS = Object.freeze({
  x: { front: "#ff0000", dim: "rgba(255,0,0,0.55)" },
  y: { front: "#00ff00", dim: "rgba(0,255,0,0.55)" },
  z: { front: "#0000ff", dim: "rgba(0,0,255,0.55)" }
});

// 画布（viewBox）要比几何本身大一圈：标签中心落在「中心 + 60 × 1.28 = 76.8 单位」处，
// 加上 Bold 单字母的半字宽最远到 ~81.4 单位，而旧画布 `0 0 140 140` 的半宽只有 70
// → 在某根轴投影恰好是屏幕水平/竖直的轴对齐视角（俯视 / 正视 / 侧视）下，标签会溢出
// 画布被 SVG 的默认 overflow:hidden 裁掉（等轴测下各轴投影 ≈ ±0.577，不会触发）。
// 改用负原点把四周各留 18 单位：内容中心 (70,70) 仍是视口正中，所以轴长 / 箭头 /
// 标签系数 / 字号这些几何数字一个都不用动。
const AXIS_VIEW_BOX = "-18 -18 176 176";
// 容器按 176/140 等比放大，使屏幕像素基本不变（箭头尖端半径 41.1 → 40.9px，
// 标签偏离 52.7 → 52.4px，字号 8.91 → 8.86px）；紧凑模式 64px → 80px 同比例。
// ⚠️ 调用方若把指示器锚在容器角上（左下角那个），必须把偏移量各减 12px 才能让
// 「可见中心」留在原位——容器边长从 96 涨到 120，其中心相对左下角各移了 12px。
const AXIS_SIZE = "7.5rem";
const AXIS_COMPACT_SIZE_CLASS = "h-20 w-20";
const AXIS_REST_OPACITY = 0.75;
const AXIS_HOVER_OPACITY = 1;

function normalizeAxis(axis, fallback) {
  if (!Array.isArray(axis) || axis.length !== 3) {
    return [...fallback];
  }
  const x = Number(axis[0]);
  const y = Number(axis[1]);
  const z = Number(axis[2]);
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) {
    return [...fallback];
  }
  const magnitude = Math.hypot(x, y, z);
  if (magnitude < 1e-6) {
    return [...fallback];
  }
  return [x / magnitude, y / magnitude, z / magnitude];
}

function normalizeOrientation(orientation) {
  return {
    x: normalizeAxis(orientation?.x, ORIENTATION_FALLBACK.x),
    y: normalizeAxis(orientation?.y, ORIENTATION_FALLBACK.y),
    z: normalizeAxis(orientation?.z, ORIENTATION_FALLBACK.z)
  };
}

// Project a world direction into the camera view basis. The third component is
// depth (positive = toward the viewer), used to fade axes pointing away.
function projectDirection(orientation, direction) {
  const [dx = 0, dy = 0, dz = 0] = Array.isArray(direction) ? direction : [0, 0, 0];
  return [
    orientation.x[0] * dx + orientation.y[0] * dy + orientation.z[0] * dz,
    orientation.x[1] * dx + orientation.y[1] * dy + orientation.z[1] * dz,
    orientation.x[2] * dx + orientation.y[2] * dy + orientation.z[2] * dz
  ];
}

// 投影后的三根轴（screen y = -y'，因为 SVG 的 y 轴向下）。
function projectAxes(orientation, labels = { x: "X", y: "Y", z: "Z" }) {
  return [
    { id: "x", label: labels.x, direction: [1, 0, 0] },
    { id: "y", label: labels.y, direction: [0, 1, 0] },
    { id: "z", label: labels.z, direction: [0, 0, 1] }
  ].map((axis) => {
    const projected = projectDirection(orientation, axis.direction);
    const towardViewer = projected[2] >= 0;
    return {
      ...axis,
      x: projected[0],
      y: -projected[1],
      depth: Math.abs(projected[2]),
      towardViewer
    };
  });
}

// Arrowhead triangle, pointing along the projected axis.
function arrowHeadFor(axis) {
  const tipX = axis.x * 60;
  const tipY = axis.y * 60;
  const baseX = axis.x * 42;
  const baseY = axis.y * 42;
  // Perpendicular offset for a compact triangle.
  const nx = -axis.y;
  const ny = axis.x;
  const wing = 6;
  return {
    tip: `${(70 + tipX).toFixed(1)},${(70 + tipY).toFixed(1)}`,
    base: [
      `${(70 + baseX + nx * wing).toFixed(1)},${(70 + baseY + ny * wing).toFixed(1)}`,
      `${(70 + baseX - nx * wing).toFixed(1)},${(70 + baseY - ny * wing).toFixed(1)}`
    ].join(" ")
  };
}

export default function AxesIndicator({
  showAxes,
  previewMode,
  isLoading,
  hasContent,
  viewPlaneOrientation,
  viewPlaneOffsetLeft = 16,
  viewPlaneOffsetBottom = 16,
  compact = false
}) {
  const [hoveredAxis, setHoveredAxis] = useState("");
  const [hovered, setHovered] = useState(false);

  if (!showAxes || previewMode || isLoading || !hasContent) {
    return null;
  }

  const orientation = normalizeOrientation(viewPlaneOrientation);
  const size = compact ? AXIS_COMPACT_SIZE_CLASS : "";
  const sizeStyle = compact ? undefined : { width: AXIS_SIZE, height: AXIS_SIZE };
  const opacity = hovered ? AXIS_HOVER_OPACITY : AXIS_REST_OPACITY;

  // Project each world axis; screen x = +x', screen y = -y' (SVG y grows down).
  const axes = projectAxes(orientation);

  // Arrowhead triangle, pointing along the projected axis.
  const arrowHead = arrowHeadFor;

  return (
    <div
      className="pointer-events-none absolute z-30 flex flex-col items-start gap-1"
      style={{ left: `${viewPlaneOffsetLeft}px`, bottom: `${viewPlaneOffsetBottom}px` }}
      onPointerEnter={() => setHovered(true)}
      onPointerLeave={() => setHovered(false)}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <div
        className={`pointer-events-auto relative text-sidebar-foreground transition duration-200 ${size}`}
        style={{
          ...sizeStyle,
          opacity,
          transition: "opacity 200ms ease-out"
        }}
      >
        <svg className="absolute inset-0 h-full w-full focus-within:outline-solid focus-within:outline-2 focus-within:outline-offset-1 focus-within:outline-ring/70" viewBox={AXIS_VIEW_BOX} role="group" aria-label="坐标轴指示器">
          {axes.map((axis) => {
            const active = hoveredAxis === axis.id;
            const color = AXIS_COLORS[axis.id];
            // Axes pointing away from the viewer are dimmed.
            const stroke = active ? color.front : (axis.towardViewer ? color.front : color.dim);
            const strokeOpacity = active ? 1 : (axis.towardViewer ? 0.92 : 0.5);
            const head = arrowHead(axis);
            const tipX = axis.x * 60;
            const tipY = axis.y * 60;
            return (
              <g
                key={axis.id}
                role="button"
                tabIndex={0}
                aria-label={`${axis.label} 轴`}
                className="group cursor-pointer"
                onPointerDown={(event) => {
                  event.stopPropagation();
                }}
                onPointerEnter={() => setHoveredAxis(axis.id)}
                onPointerMove={() => setHoveredAxis(axis.id)}
                onPointerLeave={() => setHoveredAxis((current) => (current === axis.id ? "" : current))}
                onMouseEnter={() => setHoveredAxis(axis.id)}
                onMouseMove={() => setHoveredAxis(axis.id)}
                onMouseLeave={() => setHoveredAxis((current) => (current === axis.id ? "" : current))}
                onFocus={() => setHoveredAxis(axis.id)}
                onBlur={() => setHoveredAxis((current) => (current === axis.id ? "" : current))}
              >
                <line
                  x1="70"
                  y1="70"
                  x2={70 + axis.x * 48}
                  y2={70 + axis.y * 48}
                  stroke={stroke}
                  strokeOpacity={strokeOpacity}
                  strokeWidth={active ? 3 : 2}
                  strokeLinecap="round"
                  style={{
                    transition: "stroke-width 120ms ease-out, stroke-opacity 120ms ease-out"
                  }}
                />
                <polygon
                  points={`${head.tip} ${head.base}`}
                  fill={stroke}
                  fillOpacity={strokeOpacity}
                  stroke="none"
                  style={{
                    transition: "fill-opacity 120ms ease-out"
                  }}
                />
                <text
                  x={70 + tipX * 1.28}
                  y={70 + tipY * 1.28}
                  textAnchor="middle"
                  dominantBaseline="middle"
                  className="select-none font-bold"
                  fill={stroke}
                  fillOpacity={active ? 1 : (axis.towardViewer ? 0.95 : 0.55)}
                  fontSize={13}
                  stroke="none"
                  pointerEvents="none"
                >
                  {axis.label}
                </text>
              </g>
            );
          })}
          {/* Center hub dot */}
          <circle
            cx="70"
            cy="70"
            r="3.2"
            fill="var(--sidebar-foreground)"
            fillOpacity="0.85"
            stroke="none"
            pointerEvents="none"
          />
        </svg>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 第二个坐标系：零件摆正坐标系（贴在零件包围盒顶面中心）。
//
// 与左下角的世界坐标系指示器**共用同一套常量与几何**（AXIS_VIEW_BOX / AXIS_SIZE /
// 箭头三角形），所以两者尺寸严格一致；区别只有：
//   * 位置由调用方给出的屏幕坐标决定（跟着零件的包围盒顶面中心走）
//   * 标签带撇号 X′/Y′/Z′（删掉下方那行文字后，这是区分两个坐标系的唯一手段）
//   * 纯展示：pointer-events-none，绝不会抢画布的指针事件（拾取/框选/绘制都不受影响）
//
// orientation 由 CadViewer 用"预设部分"（去掉摆正基座）投影得到 —— 也就是零件
// 自身坐标系的 XYZ 在当前视图里朝哪边。
const ALIGNED_AXIS_LABELS = Object.freeze({ x: "X′", y: "Y′", z: "Z′" });
const ALIGNED_REST_OPACITY = 0.9;

export function AlignmentAxesIndicator({ indicator, compact = false }) {
  if (!indicator) {
    return null;
  }
  const orientation = normalizeOrientation(indicator.orientation);
  const axes = projectAxes(orientation, ALIGNED_AXIS_LABELS);
  const size = compact ? AXIS_COMPACT_SIZE_CLASS : "";
  const sizeStyle = compact ? undefined : { width: AXIS_SIZE, height: AXIS_SIZE };

  return (
    <div
      className="pointer-events-none absolute z-30"
      style={{
        left: `${indicator.left}px`,
        // 抬一点，避免三角架压在零件表面上；下方那行文字删掉后视觉重心上移，
        // 抬升量从 18 收到 10（它走 translate(-50%,-50%) 居中，中心不随尺寸漂移）。
        top: `${indicator.top - 10}px`,
        transform: "translate(-50%, -50%)"
      }}
      aria-hidden="true"
    >
      <div
        className={`relative transition duration-200 ${size}`}
        style={{ ...sizeStyle, opacity: ALIGNED_REST_OPACITY }}
      >
        <svg className="absolute inset-0 h-full w-full" viewBox={AXIS_VIEW_BOX} role="img" aria-label="摆正坐标系">
          {axes.map((axis) => {
            const color = AXIS_COLORS[axis.id];
            const stroke = axis.towardViewer ? color.front : color.dim;
            const strokeOpacity = axis.towardViewer ? 0.95 : 0.55;
            const head = arrowHeadFor(axis);
            return (
              <g key={axis.id}>
                <line
                  x1="70"
                  y1="70"
                  x2={70 + axis.x * 48}
                  y2={70 + axis.y * 48}
                  stroke={stroke}
                  strokeOpacity={strokeOpacity}
                  strokeWidth={2}
                  strokeLinecap="round"
                />
                <polygon points={`${head.tip} ${head.base}`} fill={stroke} fillOpacity={strokeOpacity} stroke="none" />
                <text
                  x={70 + axis.x * 60 * 1.28}
                  y={70 + axis.y * 60 * 1.28}
                  textAnchor="middle"
                  dominantBaseline="middle"
                  className="select-none font-bold"
                  fill={stroke}
                  fillOpacity={strokeOpacity}
                  fontSize={13}
                  stroke="none"
                >
                  {axis.label}
                </text>
              </g>
            );
          })}
          <circle cx="70" cy="70" r="3.2" fill="var(--sidebar-foreground)" fillOpacity="0.85" stroke="none" />
        </svg>
      </div>
    </div>
  );
}
