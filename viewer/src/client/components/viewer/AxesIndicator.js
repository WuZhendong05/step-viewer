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

const AXIS_SIZE = "6rem";
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
  const size = compact ? "h-16 w-16" : "";
  const sizeStyle = compact ? undefined : { width: AXIS_SIZE, height: AXIS_SIZE };
  const opacity = hovered ? AXIS_HOVER_OPACITY : AXIS_REST_OPACITY;

  // Project each world axis; screen x = +x', screen y = -y' (SVG y grows down).
  const axes = [
    { id: "x", label: "X", direction: [1, 0, 0] },
    { id: "y", label: "Y", direction: [0, 1, 0] },
    { id: "z", label: "Z", direction: [0, 0, 1] }
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

  // Arrowhead triangle, pointing along the projected axis.
  const arrowHead = (axis) => {
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
  };

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
        <svg className="absolute inset-0 h-full w-full focus-within:outline-solid focus-within:outline-2 focus-within:outline-offset-1 focus-within:outline-ring/70" viewBox="0 0 140 140" role="group" aria-label="坐标轴指示器">
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
