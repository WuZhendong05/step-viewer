import { useEffect } from "react";
import { isEditableTarget } from "../../../ui/dom";
import {
  isWebGlContextCreationError,
  isSoftwareWebGlRenderer,
  runtimeErrorMessage
} from "cadjs/lib/viewer/webglSupport";
import {
  createCadWebGlRenderer
} from "cadjs/common/webglRenderer";
import {
  resolveInteractionPixelRatioCap
} from "cadjs/lib/viewer/renderQuality";
import { updateOrbitControls } from "../orbitControls.js";

// Perf experiment: render with a model-fitted depth range instead of a
// logarithmic depth buffer so early-Z rejection stays enabled. Flip to false
// to restore the log-depth renderer if depth artifacts appear.
const FITTED_DEPTH_RANGE_ENABLED = true;

// Viewport rotate feel: radians of model rotation per pixel, tuned by the
// OrbitControls rotateSpeed factor (2*PI * SPEED / height). Raise it for faster
// grabbing, lower for slower.
const VIEWPORT_ROTATE_SPEED = 0.6;
// Model-rotation inertia (the "silky glide" after a drag). SPEED keeps the model
// moving after release; DECAY is the per-second exponential damping; EPSILON is
// the angular speed below which the glide stops (radians/second).
const ROTATION_INERTIA_DECAY_PER_SEC = 8;
const ROTATION_INERTIA_EPSILON = 0.04;
const ROTATION_INERTIA_MAX_SPEED = 8;

function createWebGlRenderer(THREE) {
  return createCadWebGlRenderer(THREE, {
    allowFallback: true,
    isRecoverableError: isWebGlContextCreationError,
    logarithmicDepthBuffer: !FITTED_DEPTH_RANGE_ENABLED
  });
}

export function useViewerRuntime({
  mountRef,
  runtimeRef,
  previewModeRef,
  setError,
  setViewerReadyTick,
  viewerTheme,
  syncDrawingCanvasSize,
  renderDrawingOverlay,
  emitPerspectiveChange,
  setActiveViewPlaneFace,
  activeViewPlaneFaceRef,
  stepCameraTransition,
  stepKeyboardOrbit,
  getActiveViewPlaneFaceId,
  cancelCameraTransition,
  clearKeyboardOrbitState,
  isTrackpadLikeWheelEvent,
  getKeyboardOrbitCommand,
  getKeyboardOrbitAxes,
  applyViewRotationDelta,
  getViewerThemeValue,
  getPixelRatioCap,
  applySceneBackground,
  applyCameraFrameInsets,
  frameInsetsRef,
  applyInitialPerspective,
  updateGridHelper,
  clearSceneGroup,
  disposeSceneObject,
  disposeTexture,
  syncViewPlaneOrientation,
  BASE_VIEWER_THEME,
  DEFAULT_LIGHTING,
  DEFAULT_DAMPING_FACTOR,
  DEFAULT_ZOOM_SPEED,
  COARSE_POINTER_ZOOM_SPEED,
  INTERACTION_PIXEL_RATIO_CAP,
  IDLE_PIXEL_RATIO_CAP,
  INTERACTION_IDLE_DELAY_MS,
  TRACKPAD_PINCH_ZOOM_SPEED,
  COARSE_POINTER_PINCH_ZOOM_SPEED,
  ACCELERATED_WHEEL_ZOOM_SPEED,
  KEYBOARD_ORBIT_NUDGE_RAD,
  defaultGridRadius,
  sceneScaleMode,
  floorMode,
  onManualCameraInteraction,
  onViewportResize,
  onContextLost,
  onContextRestored,
  onInitializationError,
  preserveInteractionPixelRatio = false,
  runtimeResetToken = 0
}) {
  useEffect(() => {
    if (runtimeRef.current) {
      runtimeRef.current.preserveInteractionPixelRatio = preserveInteractionPixelRatio === true;
    }
  }, [preserveInteractionPixelRatio, runtimeRef, runtimeResetToken]);

  // Runtime setup/teardown should run once per WebGL runtime epoch.
  useEffect(() => {
    let cancelled = false;
    let cleanup = () => {};

    async function initializeViewer() {
      const [
        THREE,
        { OrbitControls },
        { Line2 },
        { LineGeometry },
        { LineSegments2 },
        { LineSegmentsGeometry },
        { LineMaterial }
      ] = await Promise.all([
        import("three"),
        import("three/examples/jsm/controls/OrbitControls.js"),
        import("three/examples/jsm/lines/Line2.js"),
        import("three/examples/jsm/lines/LineGeometry.js"),
        import("three/examples/jsm/lines/LineSegments2.js"),
        import("three/examples/jsm/lines/LineSegmentsGeometry.js"),
        import("three/examples/jsm/lines/LineMaterial.js")
      ]);
      if (cancelled || !mountRef.current) {
        return;
      }

      const container = mountRef.current;
      const coarsePointerQuery = typeof window.matchMedia === "function"
        ? window.matchMedia("(pointer: coarse)")
        : null;
      const prefersCoarsePointer = coarsePointerQuery?.matches ?? false;
      const getOrbitControlsPixelRatioBucket = () => Math.max((window.devicePixelRatio || 1) | 0, 1);
      const initialWheelPixelRatioBucket = getOrbitControlsPixelRatioBucket();
      const getDefaultZoomSpeed = () => (prefersCoarsePointer ? COARSE_POINTER_ZOOM_SPEED : DEFAULT_ZOOM_SPEED);
      const getPinchZoomSpeed = () => (prefersCoarsePointer ? COARSE_POINTER_PINCH_ZOOM_SPEED : TRACKPAD_PINCH_ZOOM_SPEED);
      const getWheelZoomSpeed = (baseZoomSpeed) => {
        // OrbitControls divides wheel deltas by a floored devicePixelRatio internally.
        // Browser zoom changes that bucket, so scale our speed back to the initial bucket.
        return baseZoomSpeed * (getOrbitControlsPixelRatioBucket() / initialWheelPixelRatioBucket);
      };
      const width = container.clientWidth || 800;
      const height = container.clientHeight || 640;

      const scene = new THREE.Scene();

      const syncCameraViewport = (targetCamera, nextWidth = width, nextHeight = height) => {
        if (!targetCamera) {
          return;
        }
        const aspect = Math.max(nextWidth, 1) / Math.max(nextHeight, 1);
        if (targetCamera.isPerspectiveCamera) {
          targetCamera.aspect = aspect;
        } else if (targetCamera.isOrthographicCamera) {
          const halfHeight = Math.max(Number(targetCamera.userData?.cadHalfHeight) || 120, 1e-3);
          targetCamera.left = -halfHeight * aspect;
          targetCamera.right = halfHeight * aspect;
          targetCamera.top = halfHeight;
          targetCamera.bottom = -halfHeight;
        }
        targetCamera.updateProjectionMatrix?.();
      };

      const perspectiveCamera = new THREE.PerspectiveCamera(48, width / height, 0.1, 50000);
      const orthographicCamera = new THREE.OrthographicCamera(-120, 120, 120, -120, 0.1, 50000);
      orthographicCamera.userData.cadHalfHeight = 120;
      const camera = perspectiveCamera;
      camera.up.set(0, 0, 1);
      camera.position.set(180, -180, 120);
      orthographicCamera.up.copy(camera.up);
      orthographicCamera.position.copy(camera.position);
      syncCameraViewport(perspectiveCamera, width, height);
      syncCameraViewport(orthographicCamera, width, height);

      const renderer = createWebGlRenderer(THREE);
      const softwareRendering = isSoftwareWebGlRenderer(renderer);
      const idlePixelRatioCap = softwareRendering ? 1 : IDLE_PIXEL_RATIO_CAP;
      const interactionPixelRatioCap = softwareRendering ? 1 : INTERACTION_PIXEL_RATIO_CAP;
      renderer.outputColorSpace = THREE.SRGBColorSpace;
      renderer.toneMapping = THREE.ACESFilmicToneMapping;
      renderer.toneMappingExposure = getViewerThemeValue(viewerTheme, "toneMappingExposure", DEFAULT_LIGHTING.toneMappingExposure);
      renderer.localClippingEnabled = true;
      renderer.shadowMap.enabled = !softwareRendering;
      renderer.shadowMap.type = THREE.PCFSoftShadowMap;
      // Shadow maps are re-rendered only when the scene changes (see
      // interactionState.shadowsDirty); camera-only frames reuse the last map.
      renderer.shadowMap.autoUpdate = false;
      renderer.setPixelRatio(getPixelRatioCap(idlePixelRatioCap));
      renderer.setSize(width, height);
      container.innerHTML = "";
      container.appendChild(renderer.domElement);

      const controls = new OrbitControls(camera, renderer.domElement);
      controls.enableDamping = true;
      controls.dampingFactor = DEFAULT_DAMPING_FACTOR;
      controls.rotateSpeed = VIEWPORT_ROTATE_SPEED;
      controls.panSpeed = 1.35;
      controls.zoomSpeed = getDefaultZoomSpeed();
      if ("zoomToCursor" in controls) {
        controls.zoomToCursor = true;
      }
      // The camera is pinned and always upright; the MODEL rotates (viewGroup).
      // OrbitControls only provides pan/zoom here, so its own rotate is disabled.
      controls.enableRotate = false;

      const hemisphereLight = new THREE.HemisphereLight(
        getViewerThemeValue(viewerTheme, "hemisphereSky", DEFAULT_LIGHTING.hemisphereSky),
        getViewerThemeValue(viewerTheme, "hemisphereGround", DEFAULT_LIGHTING.hemisphereGround),
        getViewerThemeValue(viewerTheme, "hemisphereIntensity", DEFAULT_LIGHTING.hemisphereIntensity)
      );
      scene.add(hemisphereLight);
      const ambientLight = new THREE.AmbientLight("#ffffff", 0);
      scene.add(ambientLight);
      const keyLight = new THREE.DirectionalLight(
        getViewerThemeValue(viewerTheme, "keyLightColor", DEFAULT_LIGHTING.keyLightColor),
        getViewerThemeValue(viewerTheme, "keyLightIntensity", DEFAULT_LIGHTING.keyLightIntensity)
      );
      keyLight.position.set(240, -150, 340);
      keyLight.castShadow = !softwareRendering;
      keyLight.shadow.mapSize.set(2048, 2048);
      keyLight.shadow.bias = -0.00025;
      keyLight.shadow.normalBias = 0.024;
      scene.add(keyLight);
      const fillLight = new THREE.DirectionalLight(
        getViewerThemeValue(viewerTheme, "fillLightColor", DEFAULT_LIGHTING.fillLightColor),
        getViewerThemeValue(viewerTheme, "fillLightIntensity", DEFAULT_LIGHTING.fillLightIntensity)
      );
      fillLight.position.set(120, 80, 210);
      scene.add(fillLight);
      const rimLight = new THREE.DirectionalLight(
        getViewerThemeValue(viewerTheme, "rimLightColor", DEFAULT_LIGHTING.rimLightColor),
        getViewerThemeValue(viewerTheme, "rimLightIntensity", DEFAULT_LIGHTING.rimLightIntensity)
      );
      rimLight.position.set(-260, 240, 180);
      scene.add(rimLight);
      const spotLight = new THREE.SpotLight("#ffffff", 0, 0, Math.PI / 6);
      spotLight.position.set(160, -120, 140);
      spotLight.visible = false;
      spotLight.castShadow = false;
      spotLight.shadow.mapSize.set(1024, 1024);
      spotLight.shadow.bias = -0.00025;
      spotLight.shadow.normalBias = 0.01;
      scene.add(spotLight);
      scene.add(spotLight.target);
      const pointLight = new THREE.PointLight("#ffffff", 0, 0);
      pointLight.position.set(-120, 80, 140);
      pointLight.visible = false;
      pointLight.castShadow = false;
      scene.add(pointLight);
      const axesHelper = null;

      const stageGroup = new THREE.Group();
      // viewGroup carries the view orientation: the camera is pinned and always
      // upright, and the model (plus its edges and pick proxies) rotates inside
      // this group. The stage (grid/floor/background) stays in world space.
      const viewGroup = new THREE.Group();
      const modelGroup = new THREE.Group();
      const edgesGroup = new THREE.Group();
      const facePickGroup = new THREE.Group();
      const edgePickGroup = new THREE.Group();
      const vertexPickGroup = new THREE.Group();
      // Pick proxies are opacity-0 raycast targets; keep them out of the render
      // pass entirely. Raycaster does not check `visible`, so picking still works.
      facePickGroup.visible = false;
      edgePickGroup.visible = false;
      vertexPickGroup.visible = false;
      scene.add(stageGroup);
      scene.add(viewGroup);
      viewGroup.add(modelGroup);
      viewGroup.add(edgesGroup);
      viewGroup.add(facePickGroup);
      viewGroup.add(edgePickGroup);
      viewGroup.add(vertexPickGroup);

      const raycaster = new THREE.Raycaster();
      const pointer = new THREE.Vector2();
      const interactionState = {
        active: false,
        pixelRatioCap: idlePixelRatioCap,
        pixelRatio: getPixelRatioCap(idlePixelRatioCap),
        renderQueued: false,
        renderQueuedAt: 0,
        renderFallbackTimerId: 0,
        restoreTimerId: 0,
        shadowsDirty: true,
        interactionQuality: false
      };
      const keyboardOrbitState = {
        pressedKeys: new Set(),
        directionCounts: {
          left: 0,
          right: 0,
          up: 0,
          down: 0
        },
        lastFrameTime: 0
      };
      const screenSpaceLineMaterials = new Set();

      const getScreenSpaceLineMaterialCount = () => (
        screenSpaceLineMaterials.size +
        Number(runtimeRef.current?.cadScene?.runtime?.screenSpaceLineMaterials?.size || 0)
      );

      const syncScreenSpaceLineMaterials = () => {
        const nextWidth = container.clientWidth || width || 1;
        const nextHeight = container.clientHeight || height || 1;
        for (const material of screenSpaceLineMaterials) {
          material?.resolution?.set?.(nextWidth, nextHeight);
        }
        runtimeRef.current?.cadScene?.runtime?.syncScreenSpaceLineMaterials?.(nextWidth, nextHeight);
      };

      const registerScreenSpaceLineMaterial = (material) => {
        if (!material?.resolution?.set) {
          return;
        }
        screenSpaceLineMaterials.add(material);
        material.resolution.set(container.clientWidth || width || 1, container.clientHeight || height || 1);
      };

      const unregisterScreenSpaceLineMaterial = (material) => {
        if (!material) {
          return;
        }
        screenSpaceLineMaterials.delete(material);
      };
      const handleContextLost = (event) => {
        event.preventDefault();
        clearKeyboardOrbitState(keyboardOrbitState);
        setError("WebGL context was lost. Restoring CAD Viewer…");
        onContextLost?.();
      };
      const handleContextRestored = () => {
        interactionState.shadowsDirty = true;
        setError("");
        onContextRestored?.();
      };

      // A render type may tighten the pixel ratio further than the shared
      // idle/interaction caps (the implicit raymarcher trades resolution for
      // step budget while the camera moves). It only ever caps DOWN, so the
      // mesh path — which installs no resolver — is unaffected.
      const resolveRenderPixelRatio = (pixelRatioCap, interaction) => {
        const base = getPixelRatioCap(pixelRatioCap);
        const extraCap = Number(runtimeRef.current?.resolveExtraPixelRatioCap?.(interaction));
        return Number.isFinite(extraCap) && extraCap > 0 ? Math.min(base, extraCap) : base;
      };

      const applyRenderQuality = (pixelRatioCap, { force = false, interaction = null } = {}) => {
        const nextInteraction = interaction === null
          ? interactionState.interactionQuality === true
          : interaction === true;
        interactionState.interactionQuality = nextInteraction;
        const nextPixelRatio = resolveRenderPixelRatio(pixelRatioCap, nextInteraction);
        if (
          !force &&
          Math.abs(interactionState.pixelRatioCap - pixelRatioCap) < 1e-4 &&
          Math.abs((interactionState.pixelRatio || 0) - nextPixelRatio) < 1e-4
        ) {
          return;
        }
        interactionState.pixelRatioCap = pixelRatioCap;
        interactionState.pixelRatio = nextPixelRatio;
        renderer.setPixelRatio(nextPixelRatio);
        renderer.setSize(container.clientWidth || width, container.clientHeight || height, false);
        syncScreenSpaceLineMaterials();
        syncDrawingCanvasSize(runtimeRef.current);
        renderDrawingOverlay();
      };

      const fitCameraDepthRange = (runtime) => {
        const activeCamera = runtime?.camera;
        if (
          !FITTED_DEPTH_RANGE_ENABLED ||
          !activeCamera?.isPerspectiveCamera ||
          renderer.capabilities?.logarithmicDepthBuffer
        ) {
          return;
        }
        const radius = Math.max(Number(runtime?.modelRadius) || 1, 1e-6);
        const sceneExtent = Math.max(radius, Number(runtime?.gridConfig?.radius) || 0);
        const target = runtime?.controls?.target || controls.target;
        const distance = Math.max(activeCamera.position.distanceTo(target), radius * 1e-3);
        const near = Math.max(distance - radius * 4, distance / 250);
        const far = Math.max(distance + sceneExtent * 50, near * 16);
        if (
          Math.abs(near - activeCamera.near) > activeCamera.near * 0.1 ||
          Math.abs(far - activeCamera.far) > activeCamera.far * 0.1
        ) {
          activeCamera.near = near;
          activeCamera.far = far;
          activeCamera.updateProjectionMatrix();
        }
      };

      let rafId = 0;
      const requestRender = () => {
        if (interactionState.renderQueued) {
          const now = typeof performance !== "undefined" && typeof performance.now === "function"
            ? performance.now()
            : Date.now();
          if (interactionState.renderQueuedAt && now - interactionState.renderQueuedAt < 120) {
            return;
          }
          window.cancelAnimationFrame(rafId);
          interactionState.renderQueued = false;
          interactionState.renderQueuedAt = 0;
        }
        interactionState.renderQueued = true;
        interactionState.renderQueuedAt = typeof performance !== "undefined" && typeof performance.now === "function"
          ? performance.now()
          : Date.now();
        rafId = window.requestAnimationFrame(renderFrame);
        if (interactionState.renderFallbackTimerId) {
          window.clearTimeout(interactionState.renderFallbackTimerId);
        }
        interactionState.renderFallbackTimerId = window.setTimeout(() => {
          if (!interactionState.renderQueued) {
            return;
          }
          window.cancelAnimationFrame(rafId);
          renderFrame(
            typeof performance !== "undefined" && typeof performance.now === "function"
              ? performance.now()
              : Date.now()
          );
        }, 120);
        if (runtimeRef.current) {
          runtimeRef.current.rafId = rafId;
        }
      };

      function renderFrame(timestamp) {
        interactionState.renderQueued = false;
        interactionState.renderQueuedAt = 0;
        if (interactionState.renderFallbackTimerId) {
          window.clearTimeout(interactionState.renderFallbackTimerId);
          interactionState.renderFallbackTimerId = 0;
        }
        const cameraTransitionActive = stepCameraTransition(runtimeRef.current, timestamp);
        const keyboardOrbitMoved = stepKeyboardOrbit(runtimeRef.current, timestamp);
        const rotationInertiaMoved = stepRotationInertia(runtimeRef.current, timestamp);
        const needsMoreFrames = updateOrbitControls(controls, timestamp, runtimeRef.current);
        if (cameraTransitionActive || keyboardOrbitMoved || rotationInertiaMoved) {
          emitPerspectiveChange(runtimeRef.current);
        }
        fitCameraDepthRange(runtimeRef.current);
        renderer.shadowMap.needsUpdate = interactionState.shadowsDirty === true;
        interactionState.shadowsDirty = false;
        renderer.render(scene, runtimeRef.current?.camera || camera);
        const previewOrbitActive = !!runtimeRef.current?.previewOrbitEnabled;
        if (!previewOrbitActive) {
          const nextActiveFace = getActiveViewPlaneFaceId(runtimeRef.current);
          if (nextActiveFace !== activeViewPlaneFaceRef.current) {
            activeViewPlaneFaceRef.current = nextActiveFace;
            setActiveViewPlaneFace(nextActiveFace);
          }
          syncViewPlaneOrientation(runtimeRef.current);
        }
        if (
          cameraTransitionActive ||
          keyboardOrbitMoved ||
          rotationInertiaMoved ||
          needsMoreFrames ||
          // Hold the loop open for the whole gesture so a mesh scene keeps
          // repainting at interaction quality. A render type whose frame costs
          // tens of milliseconds (the implicit raymarcher) opts out: it would
          // otherwise re-render every vsync between wheel ticks even though the
          // camera has not moved, and a 60 Hz pinch saturates the queue. Camera
          // movement still repaints through the controls `change` handler, and
          // damping/transition/keyboard/preview keep their own terms above.
          (interactionState.active && runtimeRef.current?.renderOnDemandOnly !== true) ||
          previewOrbitActive
        ) {
          requestRender();
        }
      }

      const beginInteraction = () => {
        if (interactionState.restoreTimerId) {
          window.clearTimeout(interactionState.restoreTimerId);
          interactionState.restoreTimerId = 0;
        }
        interactionState.active = true;
        applyRenderQuality(resolveInteractionPixelRatioCap({
          idlePixelRatioCap,
          interactionPixelRatioCap,
          preservePixelRatio: runtimeRef.current?.preserveInteractionPixelRatio === true,
          screenSpaceLineMaterialCount: getScreenSpaceLineMaterialCount()
        }), { interaction: true });
        requestRender();
      };

      const scheduleIdleQuality = () => {
        if (interactionState.restoreTimerId) {
          window.clearTimeout(interactionState.restoreTimerId);
        }
        // Restoring full quality costs one expensive frame plus a drawing-buffer
        // reallocation. At 140 ms that lands BETWEEN discrete wheel ticks, so a
        // slow render type pays it repeatedly mid-gesture; such a type raises the
        // delay past a comfortable tick cadence.
        const idleDelayMs = Math.max(
          Number(runtimeRef.current?.idleQualityDelayMs) || 0,
          INTERACTION_IDLE_DELAY_MS
        );
        interactionState.restoreTimerId = window.setTimeout(() => {
          interactionState.restoreTimerId = 0;
          interactionState.active = false;
          controls.enableDamping = true;
          controls.dampingFactor = DEFAULT_DAMPING_FACTOR;
          controls.zoomSpeed = getDefaultZoomSpeed();
          // Two-stage restore: give the render type its idle quality and let it
          // repaint, then raise the pixel ratio on the next tick so the costly
          // frame and the buffer reallocation do not land on the same vsync.
          const onIdleQuality = runtimeRef.current?.onIdleQualityRestore;
          if (typeof onIdleQuality === "function") {
            onIdleQuality();
            requestRender();
            window.setTimeout(() => {
              applyRenderQuality(idlePixelRatioCap, { interaction: false });
              requestRender();
            }, 0);
            return;
          }
          applyRenderQuality(idlePixelRatioCap, { interaction: false });
          requestRender();
        }, idleDelayMs);
      };

      const onResize = () => {
        const w = container.clientWidth || 800;
        const h = container.clientHeight || 640;
        applyRenderQuality(interactionState.pixelRatioCap);
        renderer.setSize(w, h);
        syncCameraViewport(perspectiveCamera, w, h);
        syncCameraViewport(orthographicCamera, w, h);
        applyCameraFrameInsets?.(runtimeRef.current, frameInsetsRef?.current, { updateProjection: false });
        syncScreenSpaceLineMaterials();
        syncDrawingCanvasSize(runtimeRef.current);
        renderDrawingOverlay();
        runtimeRef.current?.onViewportResize?.();
        requestRender();
      };
      window.addEventListener("resize", onResize);
      const resizeObserver = typeof ResizeObserver === "function"
        ? new ResizeObserver(() => {
          onResize();
        })
        : null;
      resizeObserver?.observe(container);

      // Zoom-to-cursor leaves the orbit pivot (controls.target) drifting along the view ray
      // at the new camera distance. Perspective pan and dolly both scale by the
      // camera->pivot distance, so a drifted pivot makes panning and zooming feel slow when
      // zoomed in and fast when zoomed out. After each wheel zoom, re-anchor the pivot depth
      // onto the geometry under the cursor (falling back to the model centre), keeping it on
      // the forward axis so the camera never re-orients or jumps the view.
      const zoomReanchorPointer = new THREE.Vector2();
      const zoomReanchorForward = new THREE.Vector3();
      const zoomReanchorScratch = new THREE.Vector3();
      const zoomReanchorCenter = new THREE.Vector3();
      let zoomPivotReanchorPending = false;

      const readModelWorldCenter = (out) => {
        const runtime = runtimeRef.current;
        const bounds = runtime?.modelBounds;
        if (bounds && Array.isArray(bounds.min) && Array.isArray(bounds.max)) {
          out.set(
            (Number(bounds.min[0]) + Number(bounds.max[0])) / 2,
            (Number(bounds.min[1]) + Number(bounds.max[1])) / 2,
            (Number(bounds.min[2]) + Number(bounds.max[2])) / 2
          );
          if (runtime.modelGroup?.position) {
            out.add(runtime.modelGroup.position);
          }
          return out;
        }
        return out.copy(runtime?.controls?.target || out.set(0, 0, 0));
      };

      const reanchorZoomPivot = () => {
        const runtime = runtimeRef.current;
        const activeCamera = runtime?.camera;
        const activeControls = runtime?.controls;
        // Orthographic pan/dolly do not depend on the pivot distance, so leave them alone.
        if (!activeCamera?.isPerspectiveCamera || !activeControls?.target) {
          return;
        }
        activeCamera.getWorldDirection(zoomReanchorForward);
        // Depth of a world point along the view axis (never negative / behind the camera).
        const depthOf = (point) => Math.max(
          zoomReanchorScratch.copy(point).sub(activeCamera.position).dot(zoomReanchorForward),
          0
        );
        let depth = 0;
        if (runtime.raycaster && runtime.modelGroup) {
          runtime.raycaster.setFromCamera(zoomReanchorPointer, activeCamera);
          // Only the nearest hit matters here; lets BVH-backed meshes early-out.
          runtime.raycaster.firstHitOnly = true;
          const hits = runtime.raycaster.intersectObject(runtime.modelGroup, true);
          runtime.raycaster.firstHitOnly = false;
          const hit = hits.find((entry) => entry?.point);
          if (hit) {
            depth = depthOf(hit.point);
          }
        }
        if (!(depth > 0)) {
          depth = depthOf(readModelWorldCenter(zoomReanchorCenter));
        }
        const minDepth = Math.max(
          Number.isFinite(activeControls.minDistance) ? activeControls.minDistance : 0,
          1e-4
        );
        const maxDepth = Number.isFinite(activeControls.maxDistance) && activeControls.maxDistance > 0
          ? activeControls.maxDistance
          : Number.POSITIVE_INFINITY;
        depth = Math.min(Math.max(depth, minDepth), maxDepth);
        // Only the pivot depth changes; the camera keeps looking down the same forward ray.
        activeControls.target.copy(activeCamera.position).addScaledVector(zoomReanchorForward, depth);
      };

      let controlsStartDistance = null;
      const readControlsDistance = () => {
        const activeRuntime = runtimeRef.current;
        if (!activeRuntime?.camera || !activeRuntime?.controls?.target) {
          return null;
        }
        return activeRuntime.camera.position.distanceTo(activeRuntime.controls.target);
      };
      const handleControlsStart = () => {
        controlsStartDistance = readControlsDistance();
        cancelCameraTransition(runtimeRef.current);
        beginInteraction();
      };
      const handleControlsChange = () => {
        if (zoomPivotReanchorPending) {
          zoomPivotReanchorPending = false;
          reanchorZoomPivot();
        }
        emitPerspectiveChange(runtimeRef.current);
        requestRender();
      };
      const handleControlsEnd = () => {
        const controlsEndDistance = readControlsDistance();
        if (Number.isFinite(controlsStartDistance) && Number.isFinite(controlsEndDistance)) {
          const threshold = Math.max(Math.abs(controlsStartDistance) * 0.002, 1e-4);
          if (Math.abs(controlsEndDistance - controlsStartDistance) > threshold) {
            runtimeRef.current?.onManualCameraInteraction?.("zoom");
          }
        }
        controlsStartDistance = null;
        scheduleIdleQuality();
      };
      const handleWheel = (event) => {
        runtimeRef.current?.onManualCameraInteraction?.("wheel");
        cancelCameraTransition(runtimeRef.current);
        clearRotationInertia();
        controls.enableDamping = false;
        controls.zoomSpeed = getWheelZoomSpeed(isTrackpadLikeWheelEvent(event)
          ? getPinchZoomSpeed()
          : ACCELERATED_WHEEL_ZOOM_SPEED);
        // Capture the cursor (NDC) so the post-zoom pivot re-anchor can raycast under it.
        const rect = renderer.domElement.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0) {
          zoomReanchorPointer.set(
            ((event.clientX - rect.left) / rect.width) * 2 - 1,
            -((event.clientY - rect.top) / rect.height) * 2 + 1
          );
          zoomPivotReanchorPending = true;
        }
        beginInteraction();
      };
      const wheelListenerOptions = { passive: true, capture: true };

      // Free rotation on the viewport itself: left-drag rotates the MODEL group
      // (applyViewRotationDelta), keeping the camera pinned and upright — no
      // poles, no 180° pitch cap. OrbitControls is disabled for rotate and only
      // handles pan/zoom. planMode remaps LEFT to PAN, which is how this handler
      // knows to step aside and let OrbitControls pan instead.
      const orbitRotateState = {
        active: false,
        pointerId: null,
        lastX: 0,
        lastY: 0,
        touchPointers: 0,
        prevAutoRotate: undefined,
        lastMoveTime: 0
      };
      // Model-rotation inertia: angular velocity (rad/sec) sampled while dragging,
      // then glided to a stop after release with exponential decay.
      const rotationInertia = {
        azimuthSpeed: 0,
        polarSpeed: 0,
        active: false
      };
      const getViewportOrbitScale = () => {
        const height = Math.max(container.clientHeight || 800, 1);
        return (2 * Math.PI * VIEWPORT_ROTATE_SPEED) / height;
      };
      const clearRotationInertia = () => {
        rotationInertia.azimuthSpeed = 0;
        rotationInertia.polarSpeed = 0;
        rotationInertia.active = false;
      };
      // Apply a rotation delta AND sample the angular velocity behind it, so a
      // release can glide on with the gesture's momentum. Shared by the viewport
      // drag and (via runtime.clearRotationInertia) guarded by other gestures.
      const feedRotationInertia = (azimuthDelta, polarDelta, deltaSeconds) => {
        const moved = applyViewRotationDelta(runtimeRef.current, azimuthDelta, polarDelta);
        if (moved && Number.isFinite(deltaSeconds) && deltaSeconds > 0) {
          const clampSpeed = (value) => Math.max(-ROTATION_INERTIA_MAX_SPEED, Math.min(ROTATION_INERTIA_MAX_SPEED, value));
          rotationInertia.azimuthSpeed = clampSpeed(azimuthDelta / deltaSeconds);
          rotationInertia.polarSpeed = clampSpeed(polarDelta / deltaSeconds);
          rotationInertia.active = true;
        }
        return moved;
      };
      // Per-frame inertia step: decay the residual velocity and keep rotating.
      // Never runs while the pointer is driving the rotation.
      const stepRotationInertia = (runtime, timestamp) => {
        if (orbitRotateState.active || !runtime?.viewGroup) {
          return false;
        }
        if (!rotationInertia.active &&
          Math.abs(rotationInertia.azimuthSpeed) < ROTATION_INERTIA_EPSILON &&
          Math.abs(rotationInertia.polarSpeed) < ROTATION_INERTIA_EPSILON) {
          return false;
        }
        const deltaSeconds = Math.min(Math.max((timestamp - (orbitRotateState.lastMoveTime || timestamp)) / 1000, 0), 0.05);
        orbitRotateState.lastMoveTime = timestamp;
        const decay = Math.exp(-ROTATION_INERTIA_DECAY_PER_SEC * deltaSeconds);
        const azimuth = rotationInertia.azimuthSpeed * deltaSeconds;
        const polar = rotationInertia.polarSpeed * deltaSeconds;
        rotationInertia.azimuthSpeed *= decay;
        rotationInertia.polarSpeed *= decay;
        const moved = applyViewRotationDelta(runtime, azimuth, polar);
        if (moved) {
          emitPerspectiveChange(runtime);
        }
        if (Math.abs(rotationInertia.azimuthSpeed) < ROTATION_INERTIA_EPSILON &&
          Math.abs(rotationInertia.polarSpeed) < ROTATION_INERTIA_EPSILON) {
          rotationInertia.active = false;
          scheduleIdleQuality();
        }
        return moved;
      };
      const handleOrbitRotateDown = (event) => {
        if (event.pointerType === "touch") {
          orbitRotateState.touchPointers += 1;
          if (orbitRotateState.touchPointers > 1) {
            orbitRotateState.active = false;
            return;
          }
        }
        if (
          event.button !== 0 ||
          event.ctrlKey ||
          event.metaKey ||
          event.shiftKey ||
          isEditableTarget(event.target)
        ) {
          return;
        }
        const runtime = runtimeRef.current;
        if (!runtime || runtime.controls?.mouseButtons?.LEFT !== THREE.MOUSE.ROTATE) {
          return;
        }
        orbitRotateState.active = true;
        orbitRotateState.pointerId = event.pointerId;
        orbitRotateState.lastX = event.clientX;
        orbitRotateState.lastY = event.clientY;
        orbitRotateState.lastMoveTime = 0;
        clearRotationInertia();
        // Pause preview auto-rotation while the user is dragging so the two do
        // not fight (OrbitControls' own rotate is disabled, so its STATE stays
        // NONE and autoRotate would otherwise keep running mid-drag).
        orbitRotateState.prevAutoRotate = controls.autoRotate;
        if (controls.autoRotate) {
          controls.autoRotate = false;
        }
        cancelCameraTransition(runtimeRef.current);
        beginInteraction();
      };
      const handleOrbitRotateMove = (event) => {
        if (!orbitRotateState.active || event.pointerId !== orbitRotateState.pointerId) {
          return;
        }
        const dx = event.clientX - orbitRotateState.lastX;
        const dy = event.clientY - orbitRotateState.lastY;
        orbitRotateState.lastX = event.clientX;
        orbitRotateState.lastY = event.clientY;
        const now = performance.now();
        const deltaSeconds = orbitRotateState.lastMoveTime
          ? (now - orbitRotateState.lastMoveTime) / 1000
          : 0;
        orbitRotateState.lastMoveTime = now;
        const scale = getViewportOrbitScale();
        if (feedRotationInertia(-dx * scale, -dy * scale, deltaSeconds)) {
          emitPerspectiveChange(runtimeRef.current);
          requestRender();
        }
      };
      const handleOrbitRotateUp = (event) => {
        if (event.pointerType === "touch") {
          orbitRotateState.touchPointers = Math.max(0, orbitRotateState.touchPointers - 1);
        }
        if (event.pointerId !== orbitRotateState.pointerId) {
          return;
        }
        if (orbitRotateState.active) {
          orbitRotateState.active = false;
          if (orbitRotateState.prevAutoRotate) {
            controls.autoRotate = true;
          }
          orbitRotateState.prevAutoRotate = undefined;
          // Leave the sampled angular velocity in place so the model glides to a
          // stop via stepRotationInertia; only idle the quality once it settles.
          orbitRotateState.lastMoveTime = performance.now();
          if (!rotationInertia.active &&
            Math.abs(rotationInertia.azimuthSpeed) < ROTATION_INERTIA_EPSILON &&
            Math.abs(rotationInertia.polarSpeed) < ROTATION_INERTIA_EPSILON) {
            scheduleIdleQuality();
          }
        }
        orbitRotateState.pointerId = null;
      };

      controls.addEventListener("start", handleControlsStart);
      controls.addEventListener("change", handleControlsChange);
      controls.addEventListener("end", handleControlsEnd);
      renderer.domElement.addEventListener("pointerdown", handleOrbitRotateDown);
      renderer.domElement.addEventListener("pointermove", handleOrbitRotateMove);
      renderer.domElement.addEventListener("pointerup", handleOrbitRotateUp);
      renderer.domElement.addEventListener("pointercancel", handleOrbitRotateUp);
      renderer.domElement.addEventListener("wheel", handleWheel, wheelListenerOptions);
      renderer.domElement.addEventListener("webglcontextlost", handleContextLost, false);
      renderer.domElement.addEventListener("webglcontextrestored", handleContextRestored, false);

      const handleKeyDown = (event) => {
        if (
          previewModeRef.current ||
          event.defaultPrevented ||
          event.ctrlKey ||
          event.metaKey ||
          event.altKey ||
          isEditableTarget(event.target)
        ) {
          return;
        }

        const command = getKeyboardOrbitCommand(event);
        if (!command) {
          return;
        }
        if (keyboardOrbitState.pressedKeys.has(command.keyId)) {
          event.preventDefault();
          return;
        }

        keyboardOrbitState.pressedKeys.add(command.keyId);
        keyboardOrbitState.directionCounts[command.direction] += 1;
        keyboardOrbitState.lastFrameTime = 0;
        cancelCameraTransition(runtimeRef.current);
        clearRotationInertia();
        beginInteraction();
        applyViewRotationDelta(
          runtimeRef.current,
          (command.direction === "right" ? 1 : command.direction === "left" ? -1 : 0) * KEYBOARD_ORBIT_NUDGE_RAD,
          (command.direction === "down" ? 1 : command.direction === "up" ? -1 : 0) * KEYBOARD_ORBIT_NUDGE_RAD
        );
        emitPerspectiveChange(runtimeRef.current);
        requestRender();
        event.preventDefault();
      };

      const handleKeyUp = (event) => {
        const command = getKeyboardOrbitCommand(event);
        if (!command) {
          return;
        }
        if (!keyboardOrbitState.pressedKeys.delete(command.keyId)) {
          return;
        }

        keyboardOrbitState.directionCounts[command.direction] = Math.max(
          0,
          keyboardOrbitState.directionCounts[command.direction] - 1
        );
        const axes = getKeyboardOrbitAxes(keyboardOrbitState);
        if (!axes.azimuth && !axes.polar) {
          keyboardOrbitState.lastFrameTime = 0;
          scheduleIdleQuality();
        }
        event.preventDefault();
      };

      const clearKeyboardOrbit = () => {
        if (!keyboardOrbitState.pressedKeys.size) {
          return;
        }
        clearKeyboardOrbitState(keyboardOrbitState);
        scheduleIdleQuality();
      };

      const handleVisibilityChange = () => {
        if (document.visibilityState !== "visible") {
          clearKeyboardOrbit();
        }
      };

      runtimeRef.current = {
        THREE,
        scene,
        camera,
        perspectiveCamera,
        orthographicCamera,
        projection: "perspective",
        syncCameraViewport,
        renderer,
        softwareRendering,
        Line2,
        LineGeometry,
        LineSegments2,
        LineSegmentsGeometry,
        LineMaterial,
        controls,
        stageGroup,
        viewGroup,
        // 零件摆正基座：viewGroup.quaternion = preset × baseFrameQuaternion。
        // null 表示未摆正（世界坐标系）。见 workbench/alignmentFrame.js。
        baseFrameQuaternion: null,
        modelGroup,
        edgesGroup,
        facePickGroup,
        edgePickGroup,
        vertexPickGroup,
        facePickMesh: null,
        edgePickLines: null,
        vertexPickPoints: null,
        edgePickObjects: [],
        displayRecords: [],
        modelBounds: null,
        modelRadius: 1,
        activeModelKey: "",
        sceneScaleMode,
        raycaster,
        pointer,
        hemisphereLight,
        ambientLight,
        keyLight,
        fillLight,
        rimLight,
        spotLight,
        pointLight,
        axesHelper,
        sceneBackgroundTexture: null,
        environmentTexture: null,
        environmentTextureUrl: "",
        gridConfig: null,
        gridHelper: null,
        floorMode,
        hasVisibleModel: false,
        edgePickThreshold: 1.5,
        vertexPickThreshold: 0.9,
        cameraTransition: null,
        previewOrbitEnabled: false,
        orbitControlsLastTimestamp: 0,
        preserveInteractionPixelRatio: preserveInteractionPixelRatio === true,
        interactionState,
        keyboardOrbitState,
        onResize,
        resizeObserver,
        rafId,
        // Renders requested through the runtime come from scene mutations
        // (model/theme/params/overlay effects), so they also refresh shadows.
        // Camera-driven paths use the closure-local requestRender and keep the
        // last shadow map.
        requestRender: () => {
          interactionState.shadowsDirty = true;
          requestRender();
        },
        invalidateShadows: () => {
          interactionState.shadowsDirty = true;
        },
        beginInteraction,
        scheduleIdleQuality,
        // Hooks a render type installs to tune the shared loop for its own frame
        // cost. All are inert on the mesh path, which leaves them at these
        // defaults.
        //
        // renderOnDemandOnly  - do not hold the loop open for the whole gesture
        // idleQualityDelayMs  - raise the idle-restore delay above the default
        // onIdleQualityRestore- restore full quality before the pixel ratio
        // resolveExtraPixelRatioCap - cap resolution below the shared caps
        renderOnDemandOnly: false,
        idleQualityDelayMs: 0,
        onIdleQualityRestore: null,
        resolveExtraPixelRatioCap: null,
        refreshRenderQuality: () => {
          applyRenderQuality(interactionState.pixelRatioCap, { force: true });
        },
        applyCameraFrameInsets,
        frameInsetsRef,
        onManualCameraInteraction,
        onViewportResize,
        registerScreenSpaceLineMaterial,
        unregisterScreenSpaceLineMaterial,
        // 供场景重建后立即同步线材质分辨率（新 LineMaterial 默认 (1,1) 会铺满全屏）
        syncScreenSpaceLineMaterials,
        // Lets other gestures (view-cube drag, preset jumps, fits) cancel any
        // lingering rotation inertia so it does not fight the new motion.
        clearRotationInertia
      };
      syncDrawingCanvasSize(runtimeRef.current);
      renderDrawingOverlay();
      applySceneBackground(runtimeRef.current, viewerTheme);
      applyCameraFrameInsets?.(runtimeRef.current, frameInsetsRef?.current);
      applyInitialPerspective?.(runtimeRef.current);
      window.addEventListener("keydown", handleKeyDown);
      window.addEventListener("keyup", handleKeyUp);
      window.addEventListener("blur", clearKeyboardOrbit);
      document.addEventListener("visibilitychange", handleVisibilityChange);
      requestRender();
      updateGridHelper(runtimeRef.current, viewerTheme, defaultGridRadius, 0, sceneScaleMode, floorMode);
      setViewerReadyTick((value) => value + 1);

      cleanup = () => {
        const runtime = runtimeRef.current;
        if (!runtime) {
          return;
        }
        if (runtime.interactionState.restoreTimerId) {
          window.clearTimeout(runtime.interactionState.restoreTimerId);
        }
        if (runtime.interactionState.renderFallbackTimerId) {
          window.clearTimeout(runtime.interactionState.renderFallbackTimerId);
        }
        cancelCameraTransition(runtime, { scheduleIdle: false });
        window.cancelAnimationFrame(runtime.rafId);
        window.removeEventListener("resize", runtime.onResize);
        runtime.resizeObserver?.disconnect();
        runtime.controls.removeEventListener("start", handleControlsStart);
        runtime.controls.removeEventListener("change", handleControlsChange);
        runtime.controls.removeEventListener("end", handleControlsEnd);
        runtime.renderer.domElement.removeEventListener("pointerdown", handleOrbitRotateDown);
        runtime.renderer.domElement.removeEventListener("pointermove", handleOrbitRotateMove);
        runtime.renderer.domElement.removeEventListener("pointerup", handleOrbitRotateUp);
        runtime.renderer.domElement.removeEventListener("pointercancel", handleOrbitRotateUp);
        runtime.renderer.domElement.removeEventListener("wheel", handleWheel, wheelListenerOptions);
        runtime.renderer.domElement.removeEventListener("webglcontextlost", handleContextLost, false);
        runtime.renderer.domElement.removeEventListener("webglcontextrestored", handleContextRestored, false);
        window.removeEventListener("keydown", handleKeyDown);
        window.removeEventListener("keyup", handleKeyUp);
        window.removeEventListener("blur", clearKeyboardOrbit);
        document.removeEventListener("visibilitychange", handleVisibilityChange);
        runtime.controls.dispose();
        clearSceneGroup(runtime.stageGroup);
        // viewGroup contains modelGroup/edgesGroup/pick groups; clearing it
        // disposes them all. The individual clears below are then no-ops.
        clearSceneGroup(runtime.viewGroup);
        clearSceneGroup(runtime.modelGroup);
        clearSceneGroup(runtime.edgesGroup);
        clearSceneGroup(runtime.facePickGroup);
        clearSceneGroup(runtime.edgePickGroup);
        clearSceneGroup(runtime.vertexPickGroup);
        disposeSceneObject(runtime.gridHelper);
        disposeSceneObject(runtime.axesHelper);
        disposeTexture(runtime.sceneBackgroundTexture);
        disposeTexture(runtime.environmentTexture);
        runtime.renderer.dispose();
        if (container.contains(runtime.renderer.domElement)) {
          container.removeChild(runtime.renderer.domElement);
        }
        runtimeRef.current = null;
      };
    }

    initializeViewer().catch((err) => {
      if (!cancelled) {
        setError(runtimeErrorMessage(err));
        onInitializationError?.(err);
      }
    });

    return () => {
      cancelled = true;
      cleanup();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runtimeResetToken]);
}
