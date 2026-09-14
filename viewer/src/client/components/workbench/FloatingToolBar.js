import { useCallback, useEffect, useRef, useState } from "react";
import {
  Crosshair,
  Focus,
  Hand,
  MousePointer2,
  Orbit,
  Pause,
  Play,
  PenTool,
  X
} from "lucide-react";
import {
  renderCapabilities,
  supportsTool,
  viewportContentKind,
  VIEWPORT_CONTENT
} from "cadjs/lib/renderCapabilities";
import { TooltipProvider } from "../ui/tooltip";
import DrawingToolbar from "./DrawingToolbar";
import { ToolbarButton } from "./ToolbarButton";
import { ZoomControl } from "../viewer/ZoomControl";
import { CAD_WORKSPACE_TOOLBAR_DESKTOP_WIDTH_CLASS } from "./ToolbarShell";
import { StepExportDropdown } from "./StepExportDropdown";
import { DisplayModeDropdown } from "../viewer/DisplayModeDropdown";
import { ViewDirectionDropdown } from "../viewer/ViewDirectionDropdown";
import { BoundingBoxIcon, PartAlignmentIcon } from "../viewer/CadToolbarIcons";

const FLOATING_TOOL_BAR_SURFACE_CLASS =
  "cad-glass-surface border border-sidebar-border text-sidebar-foreground shadow-sm";
const PREVIEW_TOOLBAR_HIDE_DELAY_MS = 2500;

// In orbit/preview mode the toolbar stays available but auto-hides: it appears
// on any cursor activity and fades out after a short idle delay (and never
// hides while the pointer is over it). Outside preview mode it is always shown.
function usePreviewToolbarVisibility(previewMode) {
  const [visible, setVisible] = useState(true);
  const hideTimerRef = useRef(0);
  const hoveredRef = useRef(false);
  const previewRef = useRef(previewMode);
  previewRef.current = previewMode;

  const scheduleHide = useCallback(() => {
    if (typeof window === "undefined") {
      return;
    }
    window.clearTimeout(hideTimerRef.current);
    if (!previewRef.current || hoveredRef.current) {
      return;
    }
    hideTimerRef.current = window.setTimeout(() => setVisible(false), PREVIEW_TOOLBAR_HIDE_DELAY_MS);
  }, []);

  const reveal = useCallback(() => {
    setVisible(true);
    scheduleHide();
  }, [scheduleHide]);

  useEffect(() => {
    if (typeof window === "undefined") {
      return undefined;
    }
    if (!previewMode) {
      window.clearTimeout(hideTimerRef.current);
      hoveredRef.current = false;
      setVisible(true);
      return undefined;
    }
    reveal();
    const onActivity = () => reveal();
    window.addEventListener("pointermove", onActivity, { passive: true });
    window.addEventListener("pointerdown", onActivity, { passive: true });
    return () => {
      window.clearTimeout(hideTimerRef.current);
      window.removeEventListener("pointermove", onActivity);
      window.removeEventListener("pointerdown", onActivity);
    };
  }, [previewMode, reveal]);

  const onToolbarEnter = useCallback(() => {
    hoveredRef.current = true;
    if (typeof window !== "undefined") {
      window.clearTimeout(hideTimerRef.current);
    }
    setVisible(true);
  }, []);
  const onToolbarLeave = useCallback(() => {
    hoveredRef.current = false;
    scheduleHide();
  }, [scheduleHide]);

  return {
    toolbarHidden: previewMode ? !visible : false,
    onToolbarEnter,
    onToolbarLeave
  };
}
const FLOATING_TOOL_BAR_BUTTON_CLASSES =
  "grid size-8 shrink-0 place-items-center rounded-sm text-sidebar-foreground/70 shadow-none transition hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/45 disabled:pointer-events-none disabled:opacity-50 data-[state=open]:bg-sidebar-accent data-[state=open]:text-sidebar-accent-foreground";

function DesktopFloatingToolBar({
  renderFormat,
  floatingCadToolbarPosition,
  zoomControlsVisible = false,
  zoomPercent = 100,
  onZoomPercentChange,
  onZoomReset,
  drawingViewToggle = false,
  drawingViewMode = "3d",
  onDrawingViewModeChange,
  previewMode = false,
  toolbarHidden = false,
  onToolbarEnter,
  onToolbarLeave,
  handleExitPreviewMode,
  selectionToolActive,
  referenceSelectionPending = false,
  referenceSelectionUnavailable = false,
  referenceSelectionDeferred = false,
  urdfPosePickerAvailable = false,
  urdfPosePickerActive = false,
  handleToggleUrdfPosePicker,
  animationAvailable = false,
  animationPlaying = false,
  animationDisabled = false,
  handleAnimationPlayToggle,
  drawToolActive,
  panToolActive,
  handleSelectTabToolMode,
  viewerLoading,
  selectedMeshData,
  selectedDxfData,
  selectedImplicitModel,
  drawingToolOptions,
  drawingTool,
  handleSelectDrawingTool,
  handleUndoDrawing,
  handleRedoDrawing,
  handleClearDrawings,
  canUndoDrawing,
  canRedoDrawing,
  drawingStrokes,
  handleEnterPreviewMode,
  handleScreenshotCopy,
  displayMode,
  onDisplayModeChange,
  onSelectViewDirection,
  // 零件摆正（方件 primeDirection/assistantDirection → 摆正坐标系；见 workbench/alignmentFrame.js）
  alignmentAvailable = false,
  alignmentEnabled = false,
  onToggleAlignment,
  // 外包围盒 + 尺寸标注（纯几何量，任何模型都适用；见 viewer/boundingBoxGeometry.js）
  boundingBoxEnabled = false,
  onToggleBoundingBox,
  selectedEntry,
  onExportModelFile,
  fileAccessBusyKey = ""
}) {
  // What this format can do, from the one capability table — never re-derived from
  // its identity, so a new format inherits the toolbar by declaring a row.
  const capabilities = renderCapabilities(renderFormat);
  // "Is there anything on screen?" — asked once, for every format. An implicit
  // raymarches its own GLSL and never loads mesh data, so asking only about
  // selectedMeshData left its screenshot and orbit buttons permanently disabled
  // even though both underlying paths work.
  const viewportContent = viewportContentKind(renderFormat) === VIEWPORT_CONTENT.IMPLICIT
    ? selectedImplicitModel
    : selectedMeshData;
  const showToolCluster = supportsTool(renderFormat, "select") ||
    supportsTool(renderFormat, "pan") ||
    supportsTool(renderFormat, "draw");
  const captureDisabled = viewerLoading || !viewportContent;
  const selectDisabled = viewerLoading ||
    !viewportContent ||
    referenceSelectionPending ||
    referenceSelectionUnavailable ||
    referenceSelectionDeferred;
  const posePickerDisabled = viewerLoading || !viewportContent || !urdfPosePickerAvailable;
  const selectLabel = referenceSelectionPending ? "正在准备选择" : "选择";
  // Any format with animation clips gets transport controls, whichever store backs them.
  const showAnimationPlay = capabilities.animations && animationAvailable;
  const animationPlayDisabled = viewerLoading || !viewportContent || animationDisabled;
  const animationLabel = animationPlaying ? "暂停" : "播放";

  // Buttons shared between the full toolbar and the reduced orbit-mode toolbar.
  const animationButton = showAnimationPlay ? (
    <ToolbarButton
      label={animationLabel}
      active={animationPlaying}
      onClick={handleAnimationPlayToggle}
      disabled={animationPlayDisabled}
      aria-pressed={animationPlaying}
    >
      {animationPlaying ? (
        <Pause className="size-4" strokeWidth={2} aria-hidden="true" />
      ) : (
        <Play className="size-4" strokeWidth={2} aria-hidden="true" />
      )}
    </ToolbarButton>
  ) : null;

  const screenshotButton = (
    <ToolbarButton
      label="复制截图"
      onClick={() => {
        void handleScreenshotCopy();
      }}
      disabled={captureDisabled}
    >
      <Focus className="size-4" strokeWidth={2} aria-hidden="true" />
    </ToolbarButton>
  );

  // A drawing's own toolbar, in its own pill to the LEFT of the shared one: 2D and 3D are a
  // property of the drawing being viewed, not a tool that acts on it, so grouping them with
  // select/pan/draw would read as a fourth mode of the same kind.
  const drawingViewToolbar = drawingViewToggle ? (
    <div
      className={`${toolbarHidden ? "pointer-events-none" : "pointer-events-auto"} inline-flex h-10 w-fit items-center gap-1 rounded-md p-1 ${FLOATING_TOOL_BAR_SURFACE_CLASS}`}
      onPointerEnter={onToolbarEnter}
      onPointerLeave={onToolbarLeave}
    >
      {/* `active`, not `isActive`: ToolbarButton switches variant on `active`, and an unknown
          prop is silently dropped -- which is why neither button looked selected. */}
      <ToolbarButton
        label="俯视 2D 视图"
        active={drawingViewMode === "2d"}
        onClick={() => onDrawingViewModeChange?.("2d")}
      >
        <span className="text-lg font-medium leading-none">2D</span>
      </ToolbarButton>
      <ToolbarButton
        label="3D 视图"
        active={drawingViewMode !== "2d"}
        onClick={() => onDrawingViewModeChange?.("3d")}
      >
        <span className="text-lg font-medium leading-none">3D</span>
      </ToolbarButton>
    </div>
  ) : null;

  const zoomToolbar = zoomControlsVisible ? (
    <div
      className={`${toolbarHidden ? "pointer-events-none" : "pointer-events-auto"} inline-flex h-10 w-fit items-center gap-1 rounded-md p-1 ${FLOATING_TOOL_BAR_SURFACE_CLASS}`}
      onPointerEnter={onToolbarEnter}
      onPointerLeave={onToolbarLeave}
    >
      <ZoomControl
        zoomPercent={zoomPercent}
        onZoomPercentChange={onZoomPercentChange}
        onZoomReset={onZoomReset}
      />
    </div>
  ) : null;

  return (
    <div
      className={`absolute z-20 flex flex-col items-center gap-1 transition-opacity duration-300 ${toolbarHidden ? "opacity-0" : "opacity-100"}`}
      style={floatingCadToolbarPosition}
    >
      <TooltipProvider delayDuration={250}>
        <div className="flex w-fit items-center gap-1 self-center">
        {zoomToolbar}
        {drawingViewToolbar}
        <div
          className={`${toolbarHidden ? "pointer-events-none" : "pointer-events-auto"} inline-flex h-10 w-fit items-center gap-1 self-center rounded-md p-1 ${FLOATING_TOOL_BAR_SURFACE_CLASS}`}
          onPointerEnter={onToolbarEnter}
          onPointerLeave={onToolbarLeave}
        >
          {previewMode ? (
            // Orbit mode: only tools that make sense while orbiting, plus an
            // explicit exit (X). No select/draw/pose/orbit/export here.
            <>
              {animationButton}
              {screenshotButton}
              <ToolbarButton label="退出轨道" onClick={handleExitPreviewMode}>
                <X className="size-4" strokeWidth={2} aria-hidden="true" />
              </ToolbarButton>
            </>
          ) : (
            <>
              {/* Select/Pan/Draw. Pan and Draw are camera and 2D-overlay tools that
                  work against any viewport; Select is only meaningful where there is
                  something to pick. Each button asks the capability table, so enabling
                  one for a new format is a data change. */}
              {showToolCluster ? (
                <>
                  <ToolbarButton
                    label={selectLabel}
                    active={referenceSelectionDeferred ? false : selectionToolActive}
                    onClick={() => handleSelectTabToolMode("references")}
                    disabled={selectDisabled}
                    aria-pressed={referenceSelectionDeferred ? false : selectionToolActive}
                  >
                    <MousePointer2 className="size-4" strokeWidth={2} aria-hidden="true" />
                  </ToolbarButton>

                  <ToolbarButton
                    label="平移"
                    active={panToolActive}
                    onClick={() => handleSelectTabToolMode("pan")}
                    disabled={viewerLoading || !viewportContent}
                    aria-pressed={panToolActive}
                  >
                    <Hand className="size-4" strokeWidth={2} aria-hidden="true" />
                  </ToolbarButton>

                  <ToolbarButton
                    label="绘制"
                    active={drawToolActive}
                    onClick={() => handleSelectTabToolMode("draw")}
                    disabled={viewerLoading || !viewportContent}
                    aria-pressed={drawToolActive}
                  >
                    <PenTool className="size-4" strokeWidth={2} aria-hidden="true" />
                  </ToolbarButton>

                  {animationButton}
                </>
              ) : null}

              {capabilities.posePicker ? (
                <ToolbarButton
                  label="选择位姿"
                  active={urdfPosePickerActive}
                  onClick={handleToggleUrdfPosePicker}
                  disabled={posePickerDisabled}
                  aria-pressed={urdfPosePickerActive}
                >
                  <Crosshair className="size-4" strokeWidth={2} aria-hidden="true" />
                </ToolbarButton>
              ) : null}

              <ToolbarButton
                label="轨道"
                onClick={handleEnterPreviewMode}
                disabled={captureDisabled}
              >
                <Orbit className="size-4" strokeWidth={2} aria-hidden="true" />
              </ToolbarButton>

              {screenshotButton}

              {capabilities.displayModes && displayMode ? (
                <DisplayModeDropdown
                  value={displayMode}
                  onValueChange={onDisplayModeChange}
                  triggerClassName={FLOATING_TOOL_BAR_BUTTON_CLASSES}
                  contentAlign="end"
                  contentSide="bottom"
                  contentSideOffset={6}
                />
              ) : null}

              <ViewDirectionDropdown
                onSelectView={onSelectViewDirection}
                disabled={captureDisabled}
                triggerClassName={FLOATING_TOOL_BAR_BUTTON_CLASSES}
                contentAlign="end"
                contentSide="bottom"
                contentSideOffset={6}
              />

              {/* 摆正 / 复位：把零件按其主加工面法向（primeDirection）摆正，
                  主加工方向朝 +Z、辅加工方向朝 +X。无方向字段（如圆类）时禁用。 */}
              <ToolbarButton
                label={alignmentEnabled ? "复位到世界坐标系" : "摆正零件（主加工方向朝上）"}
                active={alignmentEnabled}
                disabled={!alignmentAvailable}
                aria-pressed={alignmentEnabled}
                onClick={() => onToggleAlignment?.(!alignmentEnabled)}
              >
                <PartAlignmentIcon className="size-4" strokeWidth={2} />
              </ToolbarButton>

              {/* 外包围盒 + 尺寸标注：画轴对齐包围盒并标注长/宽/高。
                  纯几何量，圆类零件、装配体一样适用，所以不设 disabled。 */}
              <ToolbarButton
                label={boundingBoxEnabled ? "隐藏外包围盒与尺寸" : "显示外包围盒与尺寸标注"}
                active={boundingBoxEnabled}
                aria-pressed={boundingBoxEnabled}
                onClick={() => onToggleBoundingBox?.(!boundingBoxEnabled)}
              >
                <BoundingBoxIcon className="size-4" strokeWidth={2} />
              </ToolbarButton>

              <StepExportDropdown
                selectedEntry={selectedEntry}
                onExportModelFile={onExportModelFile}
                fileAccessBusyKey={fileAccessBusyKey}
                triggerClassName={FLOATING_TOOL_BAR_BUTTON_CLASSES}
                iconClassName="size-4"
                contentAlign="end"
                contentSide="bottom"
                contentSideOffset={6}
              />
            </>
          )}
        </div>
        </div>
      </TooltipProvider>

      {!previewMode && supportsTool(renderFormat, "draw") && drawToolActive ? (
        <DrawingToolbar
          className={CAD_WORKSPACE_TOOLBAR_DESKTOP_WIDTH_CLASS}
          drawingToolOptions={drawingToolOptions}
          drawingTool={drawingTool}
          handleSelectDrawingTool={handleSelectDrawingTool}
          handleUndoDrawing={handleUndoDrawing}
          handleRedoDrawing={handleRedoDrawing}
          handleClearDrawings={handleClearDrawings}
          canUndoDrawing={canUndoDrawing}
          canRedoDrawing={canRedoDrawing}
          drawingStrokes={drawingStrokes}
        />
      ) : null}
    </div>
  );
}

export default function FloatingToolBar({
  previewMode,
  selectedEntry,
  ...toolbarProps
}) {
  const { toolbarHidden, onToolbarEnter, onToolbarLeave } = usePreviewToolbarVisibility(previewMode);
  if (!selectedEntry) {
    return null;
  }

  return (
    <DesktopFloatingToolBar
      selectedEntry={selectedEntry}
      previewMode={previewMode}
      toolbarHidden={toolbarHidden}
      onToolbarEnter={onToolbarEnter}
      onToolbarLeave={onToolbarLeave}
      {...toolbarProps}
    />
  );
}
