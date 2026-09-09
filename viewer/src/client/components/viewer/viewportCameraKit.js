// Shared, renderer-agnostic viewport/camera helpers used by both the mesh CAD
// viewer (CadViewer) and its implicit raymarch pass (useImplicitRaymarch). These
// helpers operate on a generic `runtime` shape that exposes at least
// `{ THREE, camera, controls, keyboardOrbitState }`; they make no assumption
// about how the scene itself is rendered (mesh scene graph vs raymarch quad).
//
// The implementations here are the canonical mesh-viewer versions. The implicit
// viewer is being brought in line with the mesh viewer, so it consumes these
// instead of maintaining its own parallel copies.

export const WORLD_UP = Object.freeze([0, 0, 1]);
export const KEYBOARD_ORBIT_NUDGE_RAD = Math.PI / 32;
export const KEYBOARD_ORBIT_SPEED_RAD_PER_SEC = Math.PI * 0.42;
export const VIEW_PLANE_ACTIVE_DOT_THRESHOLD = 0.994;
export const VIEW_PLANE_TRANSITION_MS = 280;
export const VIEW_PLANE_POLE_DIRECTION_DOT_THRESHOLD = 0.9999;
export const DEFAULT_PERSPECTIVE_DIRECTION_DOT_THRESHOLD = 0.999;
export const DEFAULT_PERSPECTIVE_UP_DOT_THRESHOLD = 0.999;
export const DEFAULT_VIEW_DIRECTION = Object.freeze([2.1, -1.65, 1.08]);
export const DEFAULT_VIEW_PLANE_ORIENTATION = Object.freeze({
  x: [1, 0, 0],
  y: [0, 1, 0],
  z: [0, 0, 1]
});
export const VIEW_PLANE_FACES = [
  { id: "z", label: "Z", title: "Jump to top view", direction: [0, 0, 1], up: [0, 1, 0] },
  { id: "zNeg", label: "-Z", title: "Jump to bottom view", direction: [0, 0, -1], up: [0, 1, 0] },
  { id: "yNeg", label: "-Y", title: "Jump to front view", direction: [0, -1, 0], up: WORLD_UP },
  { id: "y", label: "Y", title: "Jump to back view", direction: [0, 1, 0], up: WORLD_UP },
  { id: "x", label: "X", title: "Jump to right view", direction: [1, 0, 0], up: WORLD_UP },
  { id: "xNeg", label: "-X", title: "Jump to left view", direction: [-1, 0, 0], up: WORLD_UP }
];
export const VIEW_PLANE_FACE_BY_ID = Object.fromEntries(
  VIEW_PLANE_FACES.map((face) => [face.id, face])
);
export const VIEW_PLANE_DEFAULT_PRESET = {
  id: "isometric",
  title: "Reset to default isometric view",
  direction: DEFAULT_VIEW_DIRECTION,
  up: WORLD_UP
};

export function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

export function finiteNumber(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

export function normalizeAngleAround(angle, center) {
  let adjusted = angle;
  while (adjusted - center > Math.PI) {
    adjusted -= Math.PI * 2;
  }
  while (adjusted - center < -Math.PI) {
    adjusted += Math.PI * 2;
  }
  return adjusted;
}

export function easeInOutCubic(t) {
  if (t <= 0) {
    return 0;
  }
  if (t >= 1) {
    return 1;
  }
  return t < 0.5 ? 4 * t * t * t : 1 - ((-2 * t + 2) ** 3) / 2;
}

export function isTrackpadLikeWheelEvent(event) {
  return event.ctrlKey || (event.deltaMode === 0 && Math.abs(event.deltaY) < 20);
}

export function normalizeViewportFrameInsets(value = {}) {
  const normalizeInset = (inset) => {
    const numericInset = Number(inset);
    return Number.isFinite(numericInset) ? Math.max(0, numericInset) : 0;
  };
  return {
    top: normalizeInset(value?.top),
    right: normalizeInset(value?.right),
    bottom: normalizeInset(value?.bottom),
    left: normalizeInset(value?.left)
  };
}

// How far back the camera has to sit (perspective) or how tall the orthographic
// frustum has to be, per unit of model radius, for the model to be framed by the
// given viewport. The absolute value is only meaningful against a radius; what
// callers use is the RATIO between two viewports. Rescaling the camera by that
// ratio keeps the model the same fraction of the framed area when the window
// resizes or a side sheet opens or closes, which is what stops a wide model from
// being cropped by a narrowing viewport.
//
// The formulas mirror getFitDistanceForBoundingSphere and
// getOrthographicHalfHeightForBoundingSphere in CadViewer, so a viewport change
// leaves the camera exactly where a fresh fit would have put it -- that is what
// keeps "100%" honest across a resize.
export function viewportFitScale({
  orthographic = false,
  fov = 48,
  aspect = 1,
  height = 1,
  framedHeight = 1
} = {}) {
  const safeAspect = Math.max(finiteNumber(aspect, 1), 1e-3);
  if (orthographic) {
    const safeHeight = Math.max(finiteNumber(height, 1), 1);
    const safeFramedHeight = Math.max(finiteNumber(framedHeight, safeHeight), 1);
    return (1 / Math.min(safeAspect, 1)) * (safeHeight / safeFramedHeight);
  }
  const verticalHalfFov = (Math.max(finiteNumber(fov, 48), 1e-3) * Math.PI) / 360;
  const horizontalHalfFov = Math.atan(Math.tan(verticalHalfFov) * safeAspect);
  const limitingHalfFov = Math.max(Math.min(verticalHalfFov, horizontalHalfFov), 1e-3);
  return 1 / Math.sin(limitingHalfFov);
}

export function getKeyboardOrbitCommand(event) {
  if (!event) {
    return null;
  }
  if (event.key === "ArrowLeft") {
    return { direction: "left", keyId: "ArrowLeft" };
  }
  if (event.key === "ArrowRight") {
    return { direction: "right", keyId: "ArrowRight" };
  }
  if (event.key === "ArrowUp") {
    return { direction: "up", keyId: "ArrowUp" };
  }
  if (event.key === "ArrowDown") {
    return { direction: "down", keyId: "ArrowDown" };
  }

  const key = String(event.key || "").toLowerCase();
  if (key === "a" || event.code === "KeyA") {
    return { direction: "left", keyId: event.code || "KeyA" };
  }
  if (key === "d" || event.code === "KeyD") {
    return { direction: "right", keyId: event.code || "KeyD" };
  }
  if (key === "w" || event.code === "KeyW") {
    return { direction: "up", keyId: event.code || "KeyW" };
  }
  if (key === "s" || event.code === "KeyS") {
    return { direction: "down", keyId: event.code || "KeyS" };
  }
  return null;
}

export function getKeyboardOrbitAxes(keyboardOrbitState) {
  return {
    azimuth:
      (keyboardOrbitState.directionCounts.right > 0 ? 1 : 0) -
      (keyboardOrbitState.directionCounts.left > 0 ? 1 : 0),
    polar:
      (keyboardOrbitState.directionCounts.down > 0 ? 1 : 0) -
      (keyboardOrbitState.directionCounts.up > 0 ? 1 : 0)
  };
}

export function clearKeyboardOrbitState(keyboardOrbitState) {
  if (!keyboardOrbitState) {
    return;
  }
  keyboardOrbitState.pressedKeys.clear();
  keyboardOrbitState.directionCounts.left = 0;
  keyboardOrbitState.directionCounts.right = 0;
  keyboardOrbitState.directionCounts.up = 0;
  keyboardOrbitState.directionCounts.down = 0;
  keyboardOrbitState.lastFrameTime = 0;
}

export function createKeyboardOrbitState() {
  return {
    pressedKeys: new Set(),
    directionCounts: { left: 0, right: 0, up: 0, down: 0 },
    lastFrameTime: 0
  };
}

export function applyOrbitDelta(runtime, azimuthDelta, polarDelta) {
  if (!runtime?.THREE || !runtime?.camera || !runtime?.controls) {
    return false;
  }
  if (Math.abs(azimuthDelta) < 1e-6 && Math.abs(polarDelta) < 1e-6) {
    return false;
  }

  const offset = new runtime.THREE.Vector3().copy(runtime.camera.position).sub(runtime.controls.target);
  const distance = offset.length();
  if (!Number.isFinite(distance) || distance <= 1e-6) {
    return false;
  }
  const worldUp = new runtime.THREE.Vector3(...WORLD_UP).normalize();

  // Azimuth (horizontal orbit around the world up axis) is unlimited in the
  // shipped viewer; it is only constrained when a caller configures finite
  // min/max azimuth limits.
  const minAzimuth = Number.isFinite(runtime.controls.minAzimuthAngle) ? runtime.controls.minAzimuthAngle : -Infinity;
  const maxAzimuth = Number.isFinite(runtime.controls.maxAzimuthAngle) ? runtime.controls.maxAzimuthAngle : Infinity;
  if (Number.isFinite(minAzimuth) || Number.isFinite(maxAzimuth)) {
    const currentAzimuth = Math.atan2(offset.y, offset.x);
    const nextAzimuth = clamp(normalizeAngleAround(currentAzimuth + azimuthDelta, currentAzimuth), minAzimuth, maxAzimuth);
    azimuthDelta = nextAzimuth - currentAzimuth;
  }
  if (Math.abs(azimuthDelta) > 1e-6) {
    offset.applyAxisAngle(worldUp, azimuthDelta);
  }

  // Polar (vertical tumble) around the camera's screen-horizontal axis.
  // Trackball-style: NOT clamped to 0..PI, so the view keeps rotating over the
  // top/bottom poles instead of stopping at 180° of pitch. camera.up is rotated
  // by the same step so it rolls with the tumble and camera.lookAt never
  // degenerates, which is what makes "pitch past 180°" possible.
  if (Math.abs(polarDelta) > 1e-6) {
    const forward = new runtime.THREE.Vector3().subVectors(runtime.controls.target, runtime.camera.position);
    let orbitRight = new runtime.THREE.Vector3().crossVectors(forward, runtime.camera.up);
    if (orbitRight.lengthSq() <= 1e-9) {
      orbitRight = new runtime.THREE.Vector3(1, 0, 0);
    }
    orbitRight.normalize();
    offset.applyAxisAngle(orbitRight, polarDelta);
    runtime.camera.up.applyAxisAngle(orbitRight, polarDelta);
    runtime.camera.up.normalize();
  }

  runtime.camera.position.copy(runtime.controls.target).add(offset);
  runtime.camera.lookAt(runtime.controls.target);
  return true;
}

// Rotate-the-model view control. The camera is pinned and always upright; all
// view orientation lives in `runtime.viewGroup.quaternion`. The deltas mirror
// the old camera orbit exactly, so the on-screen feel is unchanged — but because
// the MODEL does the rotating there are no poles, no 180° pitch cap, and the
// camera.up never moves, so the view can roll and tumble freely.
export function applyViewRotationDelta(runtime, azimuthDelta, polarDelta) {
  if (!runtime?.THREE || !runtime?.viewGroup || !runtime?.camera || !runtime?.controls) {
    return false;
  }
  if (Math.abs(azimuthDelta) < 1e-6 && Math.abs(polarDelta) < 1e-6) {
    return false;
  }
  const { THREE, viewGroup, camera, controls } = runtime;
  const worldUp = new THREE.Vector3(...WORLD_UP).normalize();
  const quat = new THREE.Quaternion();

  // Azimuth: spin the model around the world up axis (the pinned camera's up).
  if (Math.abs(azimuthDelta) > 1e-6) {
    quat.setFromAxisAngle(worldUp, -azimuthDelta);
    viewGroup.quaternion.premultiply(quat);
  }

  // Polar: tilt the model around the same screen-horizontal axis the camera used
  // to orbit, mirrored. camera.up is never touched, so the camera stays upright
  // and "pitch" is unlimited — the model just keeps turning.
  if (Math.abs(polarDelta) > 1e-6) {
    const offset = new THREE.Vector3().copy(camera.position).sub(controls.target);
    let orbitRight = new THREE.Vector3().crossVectors(worldUp, offset);
    if (orbitRight.lengthSq() <= 1e-9) {
      orbitRight = new THREE.Vector3(1, 0, 0);
    }
    orbitRight.normalize();
    quat.setFromAxisAngle(orbitRight, -polarDelta);
    viewGroup.quaternion.premultiply(quat);
  }
  viewGroup.quaternion.normalize();
  return true;
}

// Compute the model rotation that shows a preset view through the pinned camera.
// A preset's `direction` (which way the old camera used to look from) becomes the
// model axis that points toward the camera, and `up` becomes the on-screen up.
// The default isometric preset is the model's authored orientation → identity.
export function viewGroupQuaternionForPreset(runtime, preset) {
  if (
    !runtime?.THREE ||
    !runtime?.camera ||
    !runtime?.controls ||
    !preset ||
    !Array.isArray(preset.direction) ||
    preset.direction.length !== 3 ||
    !Array.isArray(preset.up) ||
    preset.up.length !== 3
  ) {
    return null;
  }
  const { THREE, camera, controls } = runtime;
  if (preset.id === VIEW_PLANE_DEFAULT_PRESET.id) {
    return new THREE.Quaternion();
  }
  const viewOffset = new THREE.Vector3().copy(camera.position).sub(controls.target);
  if (viewOffset.lengthSq() <= 1e-8) {
    return null;
  }
  viewOffset.normalize();
  const camUp = camera.up.clone().normalize();
  // Model "up" should land on the on-screen up: the camera's up projected onto
  // the plane perpendicular to the view direction.
  const screenUp = camUp.clone().addScaledVector(viewOffset, -camUp.dot(viewOffset));
  if (screenUp.lengthSq() < 1e-6) {
    screenUp.set(0, 1, 0).addScaledVector(viewOffset, -viewOffset.y);
  }
  if (screenUp.lengthSq() < 1e-6) {
    screenUp.set(1, 0, 0);
  }
  screenUp.normalize();
  const dir = new THREE.Vector3(...preset.direction).normalize();
  const up = new THREE.Vector3(...preset.up).normalize();
  const oldZ = new THREE.Vector3().crossVectors(dir, up).normalize();
  const newZ = new THREE.Vector3().crossVectors(viewOffset, screenUp).normalize();
  const mOld = new THREE.Matrix4().makeBasis(dir, up, oldZ);
  const mNew = new THREE.Matrix4().makeBasis(viewOffset, screenUp, newZ);
  const m = mNew.multiply(mOld.clone().invert());
  return new THREE.Quaternion().setFromRotationMatrix(m);
}

// Legacy migration helper: convert an old camera pose (position/target/up) into
// the equivalent model rotation, so a snapshot written before the rotate-the-model
// scheme restores the same view through the now-pinned camera.
//
// The old camera looked from offsetDir with screen-up `up`. To reproduce that
// with a pinned camera: rotate the model so the axis that used to face the old
// camera now faces the new (default) camera, and the axis that used to be
// screen-up lands on the new screen-up (world up projected onto the plane ⊥ the
// default view direction).
export function viewRotationForCameraPose(THREE, position, target, up) {
  if (!THREE?.Vector3 || !Array.isArray(position) || !Array.isArray(target) || !Array.isArray(up)) {
    return null;
  }
  const sourceDir = new THREE.Vector3(...position).sub(new THREE.Vector3(...target));
  if (sourceDir.lengthSq() <= 1e-8) {
    return null;
  }
  sourceDir.normalize();
  const sourceUp = new THREE.Vector3(...up).normalize();
  const targetDir = new THREE.Vector3(...DEFAULT_VIEW_DIRECTION).normalize();
  const worldUp = new THREE.Vector3(...WORLD_UP).normalize();
  const targetUp = worldUp.clone().addScaledVector(targetDir, -worldUp.dot(targetDir));
  if (targetUp.lengthSq() < 1e-6) {
    targetUp.set(0, 1, 0).addScaledVector(targetDir, -targetDir.y);
  }
  if (targetUp.lengthSq() < 1e-6) {
    targetUp.set(1, 0, 0);
  }
  targetUp.normalize();
  const oldZ = new THREE.Vector3().crossVectors(sourceDir, sourceUp).normalize();
  const newZ = new THREE.Vector3().crossVectors(targetDir, targetUp).normalize();
  const mOld = new THREE.Matrix4().makeBasis(sourceDir, sourceUp, oldZ);
  const mNew = new THREE.Matrix4().makeBasis(targetDir, targetUp, newZ);
  const m = mNew.multiply(mOld.clone().invert());
  return new THREE.Quaternion().setFromRotationMatrix(m);
}

export function stepKeyboardOrbit(runtime, timestamp) {
  const keyboardOrbitState = runtime?.keyboardOrbitState;
  if (!keyboardOrbitState) {
    return false;
  }

  const axes = getKeyboardOrbitAxes(keyboardOrbitState);
  if (!axes.azimuth && !axes.polar) {
    keyboardOrbitState.lastFrameTime = 0;
    return false;
  }
  if (!keyboardOrbitState.lastFrameTime) {
    keyboardOrbitState.lastFrameTime = timestamp;
    return false;
  }

  const deltaSeconds = clamp((timestamp - keyboardOrbitState.lastFrameTime) / 1000, 0, 0.05);
  keyboardOrbitState.lastFrameTime = timestamp;
  return applyViewRotationDelta(
    runtime,
    axes.azimuth * KEYBOARD_ORBIT_SPEED_RAD_PER_SEC * deltaSeconds,
    axes.polar * KEYBOARD_ORBIT_SPEED_RAD_PER_SEC * deltaSeconds
  );
}

export function viewPlaneOrientationEqual(a, b, epsilon = 1e-4) {
  if (!a || !b) {
    return false;
  }
  for (const axis of ["x", "y", "z"]) {
    const left = a[axis];
    const right = b[axis];
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== 3 || right.length !== 3) {
      return false;
    }
    for (let index = 0; index < 3; index += 1) {
      if (Math.abs((left[index] || 0) - (right[index] || 0)) > epsilon) {
        return false;
      }
    }
  }
  return true;
}

export function readViewPlaneOrientation(runtime) {
  if (!runtime?.THREE || !runtime?.camera) {
    return null;
  }
  const inverseCameraRotation = runtime.camera.quaternion.clone().invert();
  // The model group rotates instead of the camera, so world axes are first
  // rotated by the model then projected through the (pinned) camera.
  const rotation = runtime.viewGroup?.quaternion
    ? inverseCameraRotation.clone().multiply(runtime.viewGroup.quaternion)
    : inverseCameraRotation;
  const projectAxis = (x, y, z) => {
    const projected = new runtime.THREE.Vector3(x, y, z).applyQuaternion(rotation);
    return [projected.x, projected.y, projected.z];
  };
  return {
    x: projectAxis(1, 0, 0),
    y: projectAxis(0, 1, 0),
    z: projectAxis(0, 0, 1)
  };
}

export function getActiveViewPlaneFaceId(runtime) {
  if (!runtime?.THREE || !runtime?.camera || !runtime?.controls) {
    return "";
  }

  const offset = new runtime.THREE.Vector3().copy(runtime.camera.position).sub(runtime.controls.target);
  if (offset.lengthSq() < 1e-6) {
    return "";
  }
  offset.normalize();

  let bestId = "";
  let bestScore = -Infinity;
  for (const face of VIEW_PLANE_FACES) {
    // Face directions live in model space; the model group rotation maps them to
    // world space for comparison against the (pinned) camera.
    const direction = new runtime.THREE.Vector3(...face.direction).normalize();
    if (runtime.viewGroup?.quaternion) {
      direction.applyQuaternion(runtime.viewGroup.quaternion);
    }
    const score = offset.dot(direction);
    if (score > bestScore) {
      bestScore = score;
      bestId = face.id;
    }
  }
  return bestScore >= VIEW_PLANE_ACTIVE_DOT_THRESHOLD ? bestId : "";
}

export function cameraMatchesViewPreset(runtime, preset, {
  directionDotThreshold = DEFAULT_PERSPECTIVE_DIRECTION_DOT_THRESHOLD,
  upDotThreshold = DEFAULT_PERSPECTIVE_UP_DOT_THRESHOLD
} = {}) {
  if (
    !runtime?.THREE ||
    !runtime?.camera ||
    !runtime?.controls ||
    !runtime?.viewGroup?.quaternion ||
    !preset ||
    !Array.isArray(preset.direction) ||
    !Array.isArray(preset.up)
  ) {
    return false;
  }
  // The view is the model rotation: a preset matches when the model's
  // preset.direction axis points at the (pinned) camera and preset.up stays
  // aligned with the camera up.
  const nextDirection = new runtime.THREE.Vector3(...preset.direction).applyQuaternion(runtime.viewGroup.quaternion);
  const nextUp = new runtime.THREE.Vector3(...preset.up).applyQuaternion(runtime.viewGroup.quaternion);
  const currentDirection = runtime.camera.position.clone().sub(runtime.controls.target);
  const currentUp = runtime.camera.up.clone();
  if (
    currentDirection.lengthSq() <= 1e-8 ||
    nextDirection.lengthSq() <= 1e-8 ||
    currentUp.lengthSq() <= 1e-8 ||
    nextUp.lengthSq() <= 1e-8
  ) {
    return false;
  }
  currentDirection.normalize();
  nextDirection.normalize();
  currentUp.normalize();
  nextUp.normalize();
  return nextDirection.dot(currentDirection) >= directionDotThreshold &&
    nextUp.dot(currentUp) >= upDotThreshold;
}
