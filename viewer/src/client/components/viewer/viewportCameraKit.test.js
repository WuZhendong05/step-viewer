import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "three";

import {
  applyViewRotationDelta,
  clamp,
  viewGroupQuaternionForPreset,
  viewportFitScale,
  viewRotationForCameraPose
} from "./viewportCameraKit.js";

// The framed area of a viewport with a top bar and no side sheets, then the same
// window with a sheet open. Only the ratio between two scales is used, so these
// read as "how much further back the camera has to sit than it did before".
const wide = { aspect: 1120 / 756, height: 800, framedHeight: 756 };
const narrow = { aspect: 355 / 756, height: 800, framedHeight: 756 };

test("perspective fit scale is fixed while the framed area stays wider than tall", () => {
  // The vertical field of view is what frames the model, so extra width changes
  // nothing -- and a resize that only adds width must not move the camera.
  const square = viewportFitScale({ fov: 48, aspect: 1 });
  assert.ok(Math.abs(viewportFitScale({ fov: 48, aspect: 2.4 }) - square) < 1e-9);
  assert.ok(Math.abs(viewportFitScale({ fov: 48, aspect: 1.4 }) - square) < 1e-9);
  assert.ok(Math.abs(square - 1 / Math.sin((48 * Math.PI) / 360)) < 1e-9);
});

test("perspective fit scale grows once the framed area is taller than wide", () => {
  const half = viewportFitScale({ fov: 48, aspect: 0.5 });
  assert.ok(half > viewportFitScale({ fov: 48, aspect: 1 }));
  // Width is the limiting dimension now, so halving it pulls the camera back
  // by close to 2x -- exactly 2x only in the small-angle limit.
  assert.ok(half / viewportFitScale({ fov: 48, aspect: 1 }) > 1.8);
});

test("orthographic fit scale tracks the smaller framed dimension", () => {
  // R * height / min(framedWidth, framedHeight), expressed per unit radius.
  assert.ok(Math.abs(viewportFitScale({ orthographic: true, ...wide }) - 800 / 756) < 1e-9);
  assert.ok(Math.abs(viewportFitScale({ orthographic: true, ...narrow }) - 800 / 355) < 1e-9);
});

test("closing a sheet undoes the scale change that opening it made", () => {
  // Reframing is applied as a ratio, so a viewport that comes back to where it
  // started has to leave the camera where it started.
  const opened = viewportFitScale({ orthographic: true, ...narrow }) / viewportFitScale({ orthographic: true, ...wide });
  const closed = viewportFitScale({ orthographic: true, ...wide }) / viewportFitScale({ orthographic: true, ...narrow });
  assert.ok(opened > 2);
  assert.ok(Math.abs(opened * closed - 1) < 1e-12);
});

function makeRuntime() {
  const camera = new THREE.PerspectiveCamera();
  const controls = { target: new THREE.Vector3(0, 0, 0) };
  const viewGroup = new THREE.Group();
  camera.up.set(0, 0, 1);
  camera.position.set(180, -180, 120);
  camera.lookAt(controls.target);
  return { THREE, camera, controls, viewGroup };
}

test("applyViewRotationDelta rotates the model group, not the camera", () => {
  const runtime = makeRuntime();
  const cameraPosition = runtime.camera.position.clone();
  const cameraUp = runtime.camera.up.clone();
  assert.equal(applyViewRotationDelta(runtime, 0.5, 0), true);
  assert.ok(runtime.viewGroup.quaternion.lengthSq() > 0, "model group should rotate");
  assert.ok(runtime.camera.position.distanceTo(cameraPosition) < 1e-9, "camera must stay pinned");
  assert.ok(runtime.camera.up.distanceTo(cameraUp) < 1e-9, "camera must stay upright");
});

test("applyViewRotationDelta has no 180° polar clamp (incremental pitch exceeds PI)", () => {
  const runtime = makeRuntime();
  const steps = 10;
  for (let i = 0; i < steps; i += 1) {
    assert.equal(applyViewRotationDelta(runtime, 0, 0.5), true);
  }
  // 10 * 0.5 = 5 rad about a fixed axis. A polar clamp would have stopped at PI.
  const angle = 2 * Math.acos(clamp(runtime.viewGroup.quaternion.w, -1, 1));
  assert.ok(Math.abs(angle - 5) < 1e-6, `expected 5 rad total rotation, got ${angle}`);
});

test("applyViewRotationDelta a full 2*PI tumble returns to identity", () => {
  const runtime = makeRuntime();
  assert.equal(applyViewRotationDelta(runtime, 0, 2 * Math.PI), true);
  const q = runtime.viewGroup.quaternion;
  assert.ok(Math.abs(Math.abs(q.w) - 1) < 1e-6, "expected identity after a full turn");
});

test("viewGroupQuaternionForPreset maps the default isometric preset to identity", () => {
  const runtime = makeRuntime();
  const quaternion = viewGroupQuaternionForPreset(runtime, { id: "isometric", direction: [2.1, -1.65, 1.08], up: [0, 0, 1] });
  assert.ok(quaternion, "expected a quaternion");
  assert.ok(Math.abs(quaternion.w - 1) < 1e-6, "default preset should be identity");
});

test("viewGroupQuaternionForPreset points the top face at the pinned camera", () => {
  const runtime = makeRuntime();
  const quaternion = viewGroupQuaternionForPreset(runtime, { id: "z", direction: [0, 0, 1], up: [0, 1, 0] });
  assert.ok(quaternion, "expected a quaternion");
  // The model's +Z (top) axis must end up pointing at the camera.
  const topWorld = new THREE.Vector3(0, 0, 1).applyQuaternion(quaternion);
  const viewOffset = new THREE.Vector3().copy(runtime.camera.position).sub(runtime.controls.target).normalize();
  assert.ok(topWorld.dot(viewOffset) > 0.999, `top face should face the camera, dot=${topWorld.dot(viewOffset)}`);
});

test("viewRotationForCameraPose migrates a legacy top view to a model rotation", () => {
  // Legacy: camera above (+Z offset), screen-up +Y.
  const quaternion = viewRotationForCameraPose(THREE, [0, 0, 1], [0, 0, 0], [0, 1, 0]);
  assert.ok(quaternion, "expected a quaternion");
  const defaultDir = new THREE.Vector3(2.1, -1.65, 1.08).normalize();
  // The model axis that used to face the old camera (its +Z top) must now face
  // the pinned default camera.
  const topWorld = new THREE.Vector3(0, 0, 1).applyQuaternion(quaternion);
  assert.ok(topWorld.dot(defaultDir) > 0.999, `top should face the new camera, dot=${topWorld.dot(defaultDir)}`);
  // The model +Y (old screen-up) must land on the new screen-up (world up
  // projected onto the plane perpendicular to the default view).
  const frontWorld = new THREE.Vector3(0, 1, 0).applyQuaternion(quaternion);
  assert.ok(frontWorld.dot(defaultDir) < 1e-6, "model front must stay perpendicular to the view");
  assert.ok(Math.abs(frontWorld.z) > 0.5, "model front should be mostly upright on screen");
});

test("degenerate viewports fall back instead of producing a non-finite scale", () => {
  for (const metrics of [
    {},
    { aspect: 0 },
    { aspect: Number.NaN },
    { orthographic: true, aspect: 0, height: 0, framedHeight: 0 },
    { orthographic: true, aspect: Number.NaN, height: Number.NaN, framedHeight: Number.NaN },
    { fov: 0, aspect: 1 },
    { fov: Number.NaN, aspect: 1 }
  ]) {
    const scale = viewportFitScale(metrics);
    assert.ok(Number.isFinite(scale) && scale > 0, `bad scale for ${JSON.stringify(metrics)}`);
  }
});
