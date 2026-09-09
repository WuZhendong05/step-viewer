import { useCallback, useRef, useState } from "react";

// CAD-style ViewCube (top-right corner of the viewport). The cube is DYNAMIC:
// its faces/edges/corners are projected from a real 3D cube using the live
// camera orientation, so rotating the model rotates the cube with it — the
// cube always shows exactly which way the camera is looking.
//
// Interaction model matches mainstream CAD viewers:
//   - face   -> orthogonal view (top / bottom / front / back / left / right)
//   - edge   -> 45° axonometric view (two axes at once)
//   - corner -> isometric view (three axes at once)
//   - drag   -> free orbit; the model rotates with the cube
//   - home   -> reset to the default isometric view
// The cube is translucent (60%) at rest and opaque on hover; the currently
// facing element is highlighted. Rendered in white line style.

const ORIENTATION_FALLBACK = Object.freeze({
  x: [1, 0, 0],
  y: [0, 1, 0],
  z: [0, 0, 1]
});

const DEFAULT_VIEW_PLANE_PALETTE = Object.freeze({
  center: {
    fill: [255, 255, 255],
    stroke: [255, 255, 255]
  }
});

const VIEW_CUBE_SIZE = "5.75rem";
const VIEW_CUBE_REST_OPACITY = 0.6;
const VIEW_CUBE_HOVER_OPACITY = 1;

// World-space directions for the cube's orthographic face views. +Z is "up"
// (WORLD_UP); -Y faces the camera at rest, +X is to the right. These ids are
// the VIEW_PLANE_FACES ids from viewportCameraKit.
const FACE_DIRECTION_BY_ID = Object.freeze({
  z: [0, 0, 1],
  zNeg: [0, 0, -1],
  yNeg: [0, -1, 0],
  y: [0, 1, 0],
  x: [1, 0, 0],
  xNeg: [-1, 0, 0]
});

// Chinese labels for the six face directions.
const FACE_LABEL_BY_ID = Object.freeze({
  z: "上",
  zNeg: "下",
  yNeg: "前",
  y: "后",
  x: "右",
  xNeg: "左"
});

const FACE_TITLE_BY_ID = Object.freeze({
  z: "俯视图（上）",
  zNeg: "仰视图（下）",
  yNeg: "前视图",
  y: "后视图",
  x: "右视图",
  xNeg: "左视图"
});

// --- 3D cube geometry -------------------------------------------------------
// 8 vertices of a unit cube centered at the origin.
const CUBE_VERTICES = [
  [-1, -1, -1], // 0: down-front-left
  [1, -1, -1], // 1: down-front-right
  [1, 1, -1], // 2: down-back-right
  [-1, 1, -1], // 3: down-back-left
  [-1, -1, 1], // 4: up-front-left
  [1, -1, 1], // 5: up-front-right
  [1, 1, 1], // 6: up-back-right
  [-1, 1, 1] // 7: up-back-left
];

// Six faces: vertex indices (counter-clockwise from outside) + world normal.
const CUBE_FACES = [
  { faceId: "z", vertices: [4, 5, 6, 7] },
  { faceId: "zNeg", vertices: [1, 0, 3, 2] },
  { faceId: "yNeg", vertices: [0, 1, 5, 4] },
  { faceId: "y", vertices: [2, 3, 7, 6] },
  { faceId: "x", vertices: [1, 2, 6, 5] },
  { faceId: "xNeg", vertices: [3, 0, 4, 7] }
];

// Twelve edges: vertex pairs + the two adjacent face normals.
const CUBE_EDGES = [
  { id: "edge-top-front", a: "z", b: "yNeg", vertices: [4, 5], title: "前上轴测视图" },
  { id: "edge-top-back", a: "z", b: "y", vertices: [7, 6], title: "后上轴测视图" },
  { id: "edge-top-left", a: "z", b: "xNeg", vertices: [4, 7], title: "左上轴测视图" },
  { id: "edge-top-right", a: "z", b: "x", vertices: [5, 6], title: "右上轴测视图" },
  { id: "edge-bottom-front", a: "zNeg", b: "yNeg", vertices: [0, 1], title: "前下轴测视图" },
  { id: "edge-bottom-back", a: "zNeg", b: "y", vertices: [3, 2], title: "后下轴测视图" },
  { id: "edge-bottom-left", a: "zNeg", b: "xNeg", vertices: [3, 0], title: "左下轴测视图" },
  { id: "edge-bottom-right", a: "zNeg", b: "x", vertices: [2, 1], title: "右下轴测视图" },
  { id: "edge-front-left", a: "yNeg", b: "xNeg", vertices: [0, 4], title: "前左轴测视图" },
  { id: "edge-front-right", a: "yNeg", b: "x", vertices: [1, 5], title: "前右轴测视图" },
  { id: "edge-back-left", a: "y", b: "xNeg", vertices: [3, 7], title: "后左轴测视图" },
  { id: "edge-back-right", a: "y", b: "x", vertices: [2, 6], title: "后右轴测视图" }
];

// Eight corners: the vertex index + its three adjacent face normals.
const CUBE_CORNERS = [
  { vertex: 0, faces: ["zNeg", "yNeg", "xNeg"], title: "等轴测视图（前·左·下）" },
  { vertex: 1, faces: ["zNeg", "yNeg", "x"], title: "等轴测视图（前·右·下）" },
  { vertex: 2, faces: ["zNeg", "y", "x"], title: "等轴测视图（后·右·下）" },
  { vertex: 3, faces: ["zNeg", "y", "xNeg"], title: "等轴测视图（后·左·下）" },
  { vertex: 4, faces: ["z", "yNeg", "xNeg"], title: "等轴测视图（前·左·上）" },
  { vertex: 5, faces: ["z", "yNeg", "x"], title: "等轴测视图（前·右·上）" },
  { vertex: 6, faces: ["z", "y", "x"], title: "等轴测视图（后·右·上）" },
  { vertex: 7, faces: ["z", "y", "xNeg"], title: "等轴测视图（后·左·上）" }
];

// Four navigation arrows around the cube, matching mainstream CAD ViewCube
// behavior (AutoCAD / SolidWorks / Fusion 360):
//   - left/right arrows orbit 90° around the world up axis (azimuth);
//   - up/down arrows flip 90° over the camera's horizontal (right) axis.
// Clicking computes the rotated view direction at click time and navigates to
// it, so each arrow lands exactly on the adjacent orthographic/axonometric view.
const NAV_ARROWS = Object.freeze([
  { id: "nav-up", cx: 50, cy: 7, title: "向上旋转视图", path: "M50 3 L55 12 L45 12 Z", direction: "up" },
  { id: "nav-down", cx: 50, cy: 93, title: "向下旋转视图", path: "M50 97 L55 88 L45 88 Z", direction: "down" },
  { id: "nav-left", cx: 8, cy: 50, title: "向左旋转视图", path: "M3 50 L12 45 L12 55 Z", direction: "left" },
  { id: "nav-right", cx: 92, cy: 50, title: "向右旋转视图", path: "M97 50 L88 45 L88 55 Z", direction: "right" }
]);

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function normalizeCssLength(value, fallback = "") {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return `${value}px`;
  }
  const text = String(value || "").trim();
  return text || fallback;
}

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

// Project a world-space point/direction into the camera view basis. The third
// component is depth (positive = toward the viewer).
function projectDirection(orientation, direction) {
  const [dx = 0, dy = 0, dz = 0] = Array.isArray(direction) ? direction : [0, 0, 0];
  return [
    orientation.x[0] * dx + orientation.y[0] * dy + orientation.z[0] * dz,
    orientation.x[1] * dx + orientation.y[1] * dy + orientation.z[1] * dz,
    orientation.x[2] * dx + orientation.y[2] * dy + orientation.z[2] * dz
  ];
}

function addDirection(...vectors) {
  const out = [0, 0, 0];
  for (const vector of vectors) {
    const [x = 0, y = 0, z = 0] = Array.isArray(vector) ? vector : [0, 0, 0];
    out[0] += x;
    out[1] += y;
    out[2] += z;
  }
  const magnitude = Math.hypot(...out);
  if (magnitude < 1e-6) {
    return [0, 0, 1];
  }
  return out.map((component) => component / magnitude);
}

function faceDirectionForId(faceId) {
  return FACE_DIRECTION_BY_ID[faceId] || [0, 0, 1];
}

// Which cube element (face/edge/corner) currently faces the camera: the one
// whose projected direction has the largest +Z (toward-viewer) component.
function closestViewElementId(orientation, elements) {
  let bestId = "";
  let bestScore = -Infinity;
  for (const element of elements) {
    const projected = projectDirection(orientation, element.direction);
    if (projected[2] > bestScore) {
      bestScore = projected[2];
      bestId = element.id;
    }
  }
  return bestId;
}

// Rotate a world direction by 90° about `axis` (Rodrigues rotation). Used by the
// navigation arrows to move to the adjacent view.
function rotateDirectionAbout(direction, axis) {
  const angle = Math.PI / 2;
  const [dx, dy, dz] = direction;
  const [ax, ay, az] = axis;
  const dot = dx * ax + dy * ay + dz * az;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const cross = [
    ay * dz - az * dy,
    az * dx - ax * dz,
    ax * dy - ay * dx
  ];
  return [
    dx * cos + cross[0] * sin + ax * dot * (1 - cos),
    dy * cos + cross[1] * sin + ay * dot * (1 - cos),
    dz * cos + cross[2] * sin + az * dot * (1 - cos)
  ];
}

function normalizeVector(vector) {
  const magnitude = Math.hypot(...vector);
  if (magnitude < 1e-9) {
    return [0, 0, 1];
  }
  return vector.map((component) => component / magnitude);
}

function usePointerDrag(onDrag) {
  const dragRef = useRef(null);
  const onDragRef = useRef(onDrag);
  onDragRef.current = onDrag;

  const onPointerDown = useCallback((event) => {
    event.stopPropagation();
    const startX = event.clientX;
    const startY = event.clientY;
    dragRef.current = { startX, startY, lastX: startX, lastY: startY };
    const target = event.currentTarget;
    const pointerId = event.pointerId;
    target.setPointerCapture?.(pointerId);
  }, []);

  const onPointerMove = useCallback((event) => {
    const drag = dragRef.current;
    if (!drag) {
      return;
    }
    const dx = event.clientX - drag.lastX;
    const dy = event.clientY - drag.lastY;
    drag.lastX = event.clientX;
    drag.lastY = event.clientY;
    if (Math.abs(dx) > 0.5 || Math.abs(dy) > 0.5) {
      onDragRef.current?.(dx, dy);
    }
  }, []);

  const endDrag = useCallback((event) => {
    if (!dragRef.current) {
      return;
    }
    dragRef.current = null;
    const pointerId = event?.pointerId;
    if (pointerId != null) {
      event.currentTarget?.releasePointerCapture?.(pointerId);
    }
  }, []);

  return {
    onPointerDown,
    onPointerMove,
    onPointerUp: endDrag,
    onPointerCancel: endDrag,
    onPointerLeave: endDrag
  };
}

export default function ViewPlaneControl({
  showViewPlane,
  previewMode,
  isLoading,
  meshData,
  viewPlaneOffsetRight,
  viewPlaneOffsetTop = 16,
  viewPlaneVerticalCenter = false,
  activeViewPlaneFace,
  viewPlaneOrientation,
  viewerTheme,
  compact = false,
  variant = "3d",
  viewPlaneSize,
  viewPlaneHeader = null,
  activateViewPlaneFace,
  activateDefaultViewPlane,
  onViewCubeDrag,
  onViewCubeNavigate
}) {
  const [hoveredNodeId, setHoveredNodeId] = useState("");
  const [hovered, setHovered] = useState(false);

  // React hooks rule: every hook must run before any conditional return, and
  // the same number must run on every render. Dragging the cube rotates the
  // camera, so the drag pointer handlers are created unconditionally here.
  const dragHandlers = usePointerDrag((dx, dy) => {
    // Map horizontal drag to azimuth (around world up), vertical to polar.
    const azimuthDelta = -dx * 0.012;
    const polarDelta = -dy * 0.012;
    onViewCubeDrag?.(azimuthDelta, polarDelta);
  });

  if (!showViewPlane || previewMode || isLoading || !meshData) {
    return null;
  }

  const orientation = normalizeOrientation(viewPlaneOrientation);
  const is2d = variant === "2d";
  const customViewPlaneSize = !compact && !is2d
    ? normalizeCssLength(viewPlaneSize, VIEW_CUBE_SIZE)
    : "";
  const viewPlaneSizeClasses = compact || is2d ? "h-20 w-20" : "";
  const viewPlaneSizeStyle = customViewPlaneSize
    ? { width: customViewPlaneSize, height: customViewPlaneSize }
    : undefined;
  const viewPlaneSurfaceClasses = is2d
    ? "cad-glass-surface pointer-events-auto relative rounded-md border border-sidebar-border text-sidebar-foreground shadow-sm transition duration-150"
    : "pointer-events-auto relative text-sidebar-foreground transition duration-150";
  const viewPlaneLabel = is2d ? "2D 视图选择器" : "视角选择器";
  const normalizedTopOffset = typeof viewPlaneOffsetTop === "number"
    ? `${viewPlaneOffsetTop}px`
    : viewPlaneOffsetTop;
  // Vertical placement: either a fixed top offset or centered on the right edge.
  const viewPlaneAnchorStyle = viewPlaneVerticalCenter
    ? { right: `${viewPlaneOffsetRight}px`, top: "50%", transform: "translateY(-50%)" }
    : { right: `${viewPlaneOffsetRight}px`, top: normalizedTopOffset };
  const centerHovered = hoveredNodeId === "__default__";

  // 2D mode keeps the original compact crosshair selector.
  if (is2d) {
    return (
      <div
        className="pointer-events-none absolute z-30 flex flex-col items-end gap-1"
        style={viewPlaneAnchorStyle}
      >
        <div
          className={`${viewPlaneSurfaceClasses} ${viewPlaneSizeClasses}`}
          style={viewPlaneSizeStyle}
          onPointerDown={(event) => {
            event.stopPropagation();
          }}
        >
          <svg className="absolute inset-0 h-full w-full focus-within:outline-solid focus-within:outline-2 focus-within:outline-offset-1 focus-within:outline-ring/70" viewBox="0 0 100 100" role="group" aria-label={viewPlaneLabel}>
            <defs>
              <radialGradient id="view-sphere-shell" cx="34%" cy="28%" r="74%">
                <stop offset="0%" stopColor="var(--sidebar)" />
                <stop offset="100%" stopColor="var(--sidebar)" />
              </radialGradient>
            </defs>
            <rect x="15" y="15" width="70" height="70" rx="8" fill="url(#view-sphere-shell)" stroke="var(--sidebar-border)" strokeWidth="0.75" />
            <line x1="22" y1="50" x2="78" y2="50" fill="none" stroke="color-mix(in oklch, var(--sidebar-foreground) 18%, transparent)" strokeWidth="1" strokeLinecap="round" />
            <line x1="50" y1="22" x2="50" y2="78" fill="none" stroke="color-mix(in oklch, var(--sidebar-foreground) 18%, transparent)" strokeWidth="1" strokeLinecap="round" />
            <g
              role="button"
              tabIndex={0}
              aria-label="适配 2D 视图"
              className="group cursor-pointer"
              onPointerDown={(event) => {
                event.stopPropagation();
              }}
              onPointerEnter={() => setHoveredNodeId("__default__")}
              onPointerLeave={() => setHoveredNodeId((current) => (current === "__default__" ? "" : current))}
              onFocus={() => setHoveredNodeId("__default__")}
              onBlur={() => setHoveredNodeId((current) => (current === "__default__" ? "" : current))}
              onClick={(event) => {
                event.stopPropagation();
                activateDefaultViewPlane?.();
              }}
              onKeyDown={(event) => {
                if (event.key !== "Enter" && event.key !== " ") {
                  return;
                }
                event.preventDefault();
                event.stopPropagation();
                activateDefaultViewPlane?.();
              }}
            >
              <circle cx="50" cy="50" r="11.4" fill="transparent" stroke="none" />
              <circle
                cx="50"
                cy="50"
                r="11.4"
                className="transition-opacity duration-150"
                opacity={centerHovered ? 1 : 0}
                fill="color-mix(in oklch, var(--sidebar-foreground) 18%, transparent)"
                stroke="color-mix(in oklch, var(--sidebar-foreground) 85%, transparent)"
                strokeWidth="1.1"
              />
              <circle
                cx="50"
                cy="50"
                r={centerHovered ? 7.6 : 7}
                className="transition-[r] duration-150 ease-out"
                fill="var(--sidebar-foreground)"
                stroke="var(--sidebar-foreground)"
                strokeWidth="1.05"
              />
            </g>
          </svg>
        </div>
      </div>
    );
  }

  // --- Dynamic 3D ViewCube ------------------------------------------------
  // Project the cube's 8 vertices through the live camera orientation into a
  // 100x100 viewBox. The cube is centered high enough (y≈32) that the four
  // navigation arrows and the home button all fit inside the box without the
  // control overflowing the viewport corner.
  const PROJECT_SCALE = 21;
  const PROJECT_CENTER = { x: 50, y: 50 };
  const projectVertex = (vertex) => {
    const projected = projectDirection(orientation, vertex);
    return {
      x: PROJECT_CENTER.x + projected[0] * PROJECT_SCALE,
      y: PROJECT_CENTER.y - projected[1] * PROJECT_SCALE,
      depth: projected[2]
    };
  };
  const projectedVertices = CUBE_VERTICES.map(projectVertex);

  // Which faces are visible: face normal points toward the viewer (depth > 0).
  const faceVisibility = {};
  const facePolygons = CUBE_FACES.map((face) => {
    const normal = faceDirectionForId(face.faceId);
    const normalProjected = projectDirection(orientation, normal);
    const visible = normalProjected[2] > 0.02;
    faceVisibility[face.faceId] = visible;
    // Face depth = average of its vertex depths, for painter's order.
    const points = face.vertices.map((vertexIndex) => projectedVertices[vertexIndex]);
    const depth = points.reduce((sum, point) => sum + point.depth, 0) / points.length;
    return {
      ...face,
      label: FACE_LABEL_BY_ID[face.faceId],
      title: FACE_TITLE_BY_ID[face.faceId],
      direction: normal,
      visible,
      depth,
      points
    };
  });

  const visibleFaces = facePolygons
    .filter((face) => face.visible)
    .sort((a, b) => a.depth - b.depth); // far to near

  // Edges: visible when both adjacent faces are visible.
  const visibleEdges = CUBE_EDGES
    .map((edge) => {
      const visible = faceVisibility[edge.a] && faceVisibility[edge.b];
      const [startIndex, endIndex] = edge.vertices;
      const start = projectedVertices[startIndex];
      const end = projectedVertices[endIndex];
      const direction = addDirection(faceDirectionForId(edge.a), faceDirectionForId(edge.b));
      return {
        ...edge,
        visible,
        start,
        end,
        direction,
        depth: (start.depth + end.depth) / 2
      };
    })
    .filter((edge) => edge.visible)
    .sort((a, b) => a.depth - b.depth);

  // Corners: visible when all three adjacent faces are visible.
  const visibleCorners = CUBE_CORNERS
    .map((corner) => {
      const visible = corner.faces.every((faceId) => faceVisibility[faceId]);
      const point = projectedVertices[corner.vertex];
      const direction = addDirection(...corner.faces.map(faceDirectionForId));
      return {
        ...corner,
        visible,
        point,
        direction,
        depth: point.depth
      };
    })
    .filter((corner) => corner.visible)
    .sort((a, b) => a.depth - b.depth);

  const allViewElements = [
    ...visibleFaces.map((face) => ({ id: `face:${face.faceId}`, direction: face.direction })),
    ...visibleEdges.map((edge) => ({ id: edge.id, direction: edge.direction })),
    ...visibleCorners.map((corner) => ({ id: `corner:${corner.vertex}`, direction: corner.direction }))
  ];
  const highlightedElementId = closestViewElementId(orientation, allViewElements);

  const activateFace = (faceId) => {
    activateViewPlaneFace?.(faceId);
  };
  const activateEdge = (edge) => {
    onViewCubeNavigate?.(edge.direction, ORIENTATION_FALLBACK.y);
  };
  const activateCorner = (corner) => {
    onViewCubeNavigate?.(corner.direction, ORIENTATION_FALLBACK.y);
  };

  // Arrow navigation, matching standard CAD ViewCube:
  //   - left/right: rotate 90° around the world up axis (Z).
  //   - up/down: rotate 90° around the camera's right axis (screen-horizontal).
  // `orientation` here is the inverse camera rotation (world axes expressed in
  // camera space), so the camera basis vectors in world space are the ROWS of
  // that matrix: right = row 0, up = row 1, view direction = row 2.
  const activateNavArrow = (arrow) => {
    const cameraRight = [orientation.x[0], orientation.y[0], orientation.z[0]]; // camera X in world
    const cameraUp = [orientation.x[1], orientation.y[1], orientation.z[1]];    // camera Y in world
    const viewDirection = [orientation.x[2], orientation.y[2], orientation.z[2]]; // camera Z in world
    const worldUp = [0, 0, 1];

    let axis;
    if (arrow.direction === "right") {
      // +90° around world up: front(-Y) -> right(+X)
      axis = worldUp;
    } else if (arrow.direction === "left") {
      // -90° around world up: front(-Y) -> left(-X)
      axis = [0, 0, -1];
    } else if (arrow.direction === "up") {
      // -90° around the right axis (tilt up): front(-Y) -> top(+Z)
      axis = [-cameraRight[0], -cameraRight[1], -cameraRight[2]];
    } else {
      // +90° around the right axis (tilt down): front(-Y) -> bottom(-Z)
      axis = [cameraRight[0], cameraRight[1], cameraRight[2]];
    }

    const nextDirection = normalizeVector(rotateDirectionAbout(viewDirection, axis));
    const nextUp = normalizeVector(rotateDirectionAbout(cameraUp, axis));
    onViewCubeNavigate?.(nextDirection, nextUp);
  };

  const cubeOpacity = hovered ? VIEW_CUBE_HOVER_OPACITY : VIEW_CUBE_REST_OPACITY;
  const polygonPoints = (points) => points
    .map((point) => `${point.x.toFixed(1)},${point.y.toFixed(1)}`)
    .join(" ");

  return (
    <div
      className="pointer-events-none absolute z-30 flex flex-col items-end gap-1"
      style={viewPlaneAnchorStyle}
      onPointerEnter={() => setHovered(true)}
      onPointerLeave={() => setHovered(false)}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      {viewPlaneHeader ? (
        <div
          className="pointer-events-auto"
          onPointerDown={(event) => {
            event.stopPropagation();
          }}
        >
          {viewPlaneHeader}
        </div>
      ) : null}
      <div
        className={`${viewPlaneSurfaceClasses} ${viewPlaneSizeClasses} cursor-grab active:cursor-grabbing`}
        style={{
          ...viewPlaneSizeStyle,
          opacity: cubeOpacity,
          transition: "opacity 200ms ease-out"
        }}
        {...dragHandlers}
      >
        <svg className="absolute inset-0 h-full w-full focus-within:outline-solid focus-within:outline-2 focus-within:outline-offset-1 focus-within:outline-ring/70" viewBox="0 0 100 100" role="group" aria-label={viewPlaneLabel}>
          {/* Faces (far to near) */}
          {visibleFaces.map((face) => {
            const active = highlightedElementId === `face:${face.faceId}`;
            const hoveredFace = hoveredNodeId === `face:${face.faceId}`;
            const centroidX = face.points.reduce((sum, point) => sum + point.x, 0) / face.points.length;
            const centroidY = face.points.reduce((sum, point) => sum + point.y, 0) / face.points.length;
            return (
              <g
                key={face.faceId}
                role="button"
                tabIndex={0}
                aria-label={face.title}
                aria-current={active ? "true" : undefined}
                className="group cursor-pointer"
                onPointerDown={(event) => {
                  event.stopPropagation();
                }}
                onPointerEnter={() => setHoveredNodeId(`face:${face.faceId}`)}
                onPointerMove={() => setHoveredNodeId(`face:${face.faceId}`)}
                onPointerLeave={() => setHoveredNodeId((current) => (current === `face:${face.faceId}` ? "" : current))}
                onMouseEnter={() => setHoveredNodeId(`face:${face.faceId}`)}
                onMouseMove={() => setHoveredNodeId(`face:${face.faceId}`)}
                onMouseLeave={() => setHoveredNodeId((current) => (current === `face:${face.faceId}` ? "" : current))}
                onFocus={() => setHoveredNodeId(`face:${face.faceId}`)}
                onBlur={() => setHoveredNodeId((current) => (current === `face:${face.faceId}` ? "" : current))}
                onClick={(event) => {
                  event.stopPropagation();
                  activateFace(face.faceId);
                }}
                onKeyDown={(event) => {
                  if (event.key !== "Enter" && event.key !== " ") {
                    return;
                  }
                  event.preventDefault();
                  event.stopPropagation();
                  activateFace(face.faceId);
                }}
              >
                <polygon
                  points={polygonPoints(face.points)}
                  fill={active || hoveredFace ? "color-mix(in oklch, var(--sidebar-foreground) 18%, transparent)" : "color-mix(in oklch, var(--sidebar-foreground) 6%, transparent)"}
                  stroke="color-mix(in oklch, var(--sidebar-foreground) 92%, transparent)"
                  strokeWidth={active ? 2.4 : hoveredFace ? 1.8 : 1.1}
                  strokeLinejoin="round"
                  style={{
                    transition: "fill 140ms ease-out, stroke-width 140ms ease-out"
                  }}
                />
                <text
                  x={centroidX}
                  y={centroidY}
                  textAnchor="middle"
                  dominantBaseline="middle"
                  className="select-none font-semibold"
                  fill="var(--sidebar-foreground)"
                  fontSize={11}
                  stroke="none"
                  pointerEvents="none"
                >
                  {face.label}
                </text>
              </g>
            );
          })}

          {/* Edges (visible internal folds) */}
          {visibleEdges.map((edge) => {
            const active = highlightedElementId === edge.id;
            const hoveredEdge = hoveredNodeId === edge.id;
            const hitWidth = hoveredEdge || active ? 15 : 9;
            return (
              <g
                key={edge.id}
                role="button"
                tabIndex={0}
                aria-label={edge.title}
                aria-current={active ? "true" : undefined}
                className="group cursor-pointer"
                onPointerDown={(event) => {
                  event.stopPropagation();
                }}
                onPointerEnter={() => setHoveredNodeId(edge.id)}
                onPointerMove={() => setHoveredNodeId(edge.id)}
                onPointerLeave={() => setHoveredNodeId((current) => (current === edge.id ? "" : current))}
                onMouseEnter={() => setHoveredNodeId(edge.id)}
                onMouseMove={() => setHoveredNodeId(edge.id)}
                onMouseLeave={() => setHoveredNodeId((current) => (current === edge.id ? "" : current))}
                onFocus={() => setHoveredNodeId(edge.id)}
                onBlur={() => setHoveredNodeId((current) => (current === edge.id ? "" : current))}
                onClick={(event) => {
                  event.stopPropagation();
                  activateEdge(edge);
                }}
                onKeyDown={(event) => {
                  if (event.key !== "Enter" && event.key !== " ") {
                    return;
                  }
                  event.preventDefault();
                  event.stopPropagation();
                  activateEdge(edge);
                }}
              >
                <line
                  x1={edge.start.x}
                  y1={edge.start.y}
                  x2={edge.end.x}
                  y2={edge.end.y}
                  stroke={active || hoveredEdge ? "var(--sidebar-foreground)" : "color-mix(in oklch, var(--sidebar-foreground) 45%, transparent)"}
                  strokeWidth={active || hoveredEdge ? hitWidth : 2}
                  strokeLinecap="round"
                  fill="none"
                  style={{
                    transition: "stroke 140ms ease-out, stroke-width 140ms ease-out"
                  }}
                />
              </g>
            );
          })}

          {/* Corners (isometric views) */}
          {visibleCorners.map((corner) => {
            const active = highlightedElementId === `corner:${corner.vertex}`;
            const hoveredCorner = hoveredNodeId === `corner:${corner.vertex}`;
            return (
              <g
                key={corner.vertex}
                role="button"
                tabIndex={0}
                aria-label={corner.title}
                aria-current={active ? "true" : undefined}
                className="group cursor-pointer"
                onPointerDown={(event) => {
                  event.stopPropagation();
                }}
                onPointerEnter={() => setHoveredNodeId(`corner:${corner.vertex}`)}
                onPointerMove={() => setHoveredNodeId(`corner:${corner.vertex}`)}
                onPointerLeave={() => setHoveredNodeId((current) => (current === `corner:${corner.vertex}` ? "" : current))}
                onMouseEnter={() => setHoveredNodeId(`corner:${corner.vertex}`)}
                onMouseMove={() => setHoveredNodeId(`corner:${corner.vertex}`)}
                onMouseLeave={() => setHoveredNodeId((current) => (current === `corner:${corner.vertex}` ? "" : current))}
                onFocus={() => setHoveredNodeId(`corner:${corner.vertex}`)}
                onBlur={() => setHoveredNodeId((current) => (current === `corner:${corner.vertex}` ? "" : current))}
                onClick={(event) => {
                  event.stopPropagation();
                  activateCorner(corner);
                }}
                onKeyDown={(event) => {
                  if (event.key !== "Enter" && event.key !== " ") {
                    return;
                  }
                  event.preventDefault();
                  event.stopPropagation();
                  activateCorner(corner);
                }}
              >
                <circle
                  cx={corner.point.x}
                  cy={corner.point.y}
                  r={hoveredCorner || active ? 8 : 5}
                  fill={active || hoveredCorner ? "var(--sidebar-foreground)" : "color-mix(in oklch, var(--sidebar-foreground) 15%, transparent)"}
                  stroke={active ? "var(--sidebar-foreground)" : "color-mix(in oklch, var(--sidebar-foreground) 55%, transparent)"}
                  strokeWidth={active ? 1.6 : 1}
                  style={{
                    transition: "fill 140ms ease-out, r 140ms ease-out"
                  }}
                />
              </g>
            );
          })}

          {/* Navigation arrows around the cube: rotate the camera 90° to the
              adjacent view. Left/right orbit around world-up (azimuth); up/down
              tilt the polar angle. */}
          {NAV_ARROWS.map((arrow) => {
            const hoveredArrow = hoveredNodeId === arrow.id;
            return (
              <g
                key={arrow.id}
                role="button"
                tabIndex={0}
                aria-label={arrow.title}
                className="group cursor-pointer"
                onPointerDown={(event) => {
                  event.stopPropagation();
                }}
                onPointerEnter={() => setHoveredNodeId(arrow.id)}
                onPointerMove={() => setHoveredNodeId(arrow.id)}
                onPointerLeave={() => setHoveredNodeId((current) => (current === arrow.id ? "" : current))}
                onMouseEnter={() => setHoveredNodeId(arrow.id)}
                onMouseMove={() => setHoveredNodeId(arrow.id)}
                onMouseLeave={() => setHoveredNodeId((current) => (current === arrow.id ? "" : current))}
                onFocus={() => setHoveredNodeId(arrow.id)}
                onBlur={() => setHoveredNodeId((current) => (current === arrow.id ? "" : current))}
                onClick={(event) => {
                  event.stopPropagation();
                  activateNavArrow(arrow);
                }}
                onKeyDown={(event) => {
                  if (event.key !== "Enter" && event.key !== " ") {
                    return;
                  }
                  event.preventDefault();
                  event.stopPropagation();
                  activateNavArrow(arrow);
                }}
              >
                <circle
                  cx={arrow.cx}
                  cy={arrow.cy}
                  r="7.5"
                  fill={hoveredArrow ? "color-mix(in oklch, var(--sidebar-foreground) 22%, transparent)" : "color-mix(in oklch, var(--sidebar-foreground) 8%, transparent)"}
                  stroke={hoveredArrow ? "var(--sidebar-foreground)" : "color-mix(in oklch, var(--sidebar-foreground) 45%, transparent)"}
                  strokeWidth={hoveredArrow ? 1.5 : 1}
                  style={{
                    transition: "fill 140ms ease-out, stroke-width 140ms ease-out"
                  }}
                />
                <path
                  d={arrow.path}
                  fill="var(--sidebar-foreground)"
                  stroke="none"
                  pointerEvents="none"
                />
              </g>
            );
          })}

        </svg>
      </div>
    </div>
  );
}
