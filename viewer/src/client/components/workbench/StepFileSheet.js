import { useEffect, useMemo, useRef, useState } from "react";
import { Box, Boxes, ChevronRight, Eye, EyeOff, Link2, TriangleAlert, X } from "lucide-react";
import { cn } from "@/ui/utils";
import {
  STEP_MODEL_ROOT_ID,
  flattenVisibleStepTreeRows,
  stepTreeNodeChildren
} from "cadjs/lib/step/stepTree";
import { useStepAnimationElapsed } from "@/workbench/stepAnimationStore";
import { Button } from "../ui/button";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger
} from "../ui/context-menu";
import { Slider } from "../ui/slider";
import FileSheet, {
  FILE_SHEET_PRECISION_SLIDER_CLASSES,
  FileSheetSliderField,
  FileSheetStatusText,
  parseFileSheetNumberInput
} from "./FileSheet";
import FileSheetTabbedSurface from "./FileSheetTabbedSurface";
import AssemblyContextMenuItems from "./AssemblyContextMenuItems";
import { buildFileStatusTab } from "./FileStatusSection";
import { buildParameterControlsTab } from "./ParameterControlsSection";
import { buildStepReferenceTab } from "./StepReferenceSection";
const treeChevronButtonClasses = "grid h-5 w-5 shrink-0 place-items-center rounded-sm px-0 text-current/60 hover:bg-sidebar-accent/45 hover:text-sidebar-accent-foreground focus-visible:bg-sidebar-accent/45";
const treeRowActionButtonClasses = "h-5 w-5 rounded-sm px-0 text-current/60 shadow-none hover:bg-sidebar-accent/45 hover:text-sidebar-accent-foreground focus-visible:bg-sidebar-accent/45 focus-visible:text-sidebar-accent-foreground";
const treeRowContentClasses = "h-8 min-w-0 text-[15px] font-normal";
const treeGroupLabelClasses = "px-2 pb-1 pt-2 text-[13px] font-medium text-sidebar-foreground/45";
const treeGlyphIconClasses = "size-3.5 shrink-0 text-current/60";
const treeMateIconSlotClasses = "grid h-5 w-5 shrink-0 place-items-center text-current/60";
// One indent level equals the expand-chevron's footprint (w-5 button + gap-1.5),
// so a leaf row's glyph (which has no chevron) lines up exactly under its
// expandable parent's glyph instead of sitting a few pixels to the left.
const treeDepthIndentPx = 26;
const treeDepthGuideOffsetPx = 14;
const treeDepthMaxPx = 156;
const treeSectionId = "tree";
const treeRevealScrollPaddingTopPx = 120;
function formatSeconds(value) {
  const numericValue = Math.max(Number(value) || 0, 0);
  return `${numericValue.toFixed(numericValue >= 10 ? 1 : 2)}s`;
}

function leafIdsHidden(leafPartIds, hiddenPartIds) {
  const leafIds = Array.isArray(leafPartIds)
    ? leafPartIds.map((id) => String(id || "").trim()).filter(Boolean)
    : [];
  if (!leafIds.length) {
    return false;
  }
  const hidden = new Set(Array.isArray(hiddenPartIds) ? hiddenPartIds : []);
  return leafIds.every((id) => hidden.has(id));
}

function hiddenStepTreeRowIds(visibleRows, hiddenPartIds) {
  const hiddenRows = new Set();
  const hiddenByDepth = [];
  for (const row of Array.isArray(visibleRows) ? visibleRows : []) {
    const depth = Math.max(Number(row?.depth) || 0, 0);
    hiddenByDepth.length = depth;
    const parentHidden = depth > 0 && hiddenByDepth[depth - 1] === true;
    const rowHidden = parentHidden || leafIdsHidden(row?.leafPartIds, hiddenPartIds);
    hiddenByDepth[depth] = rowHidden;
    if (rowHidden) {
      hiddenRows.add(String(row?.id || "").trim());
    }
  }
  return hiddenRows;
}

function stepTreeNodeId(node) {
  return String(node?.id || node?.occurrenceId || "").trim();
}

function isolatedStepTreeRowIds(visibleRows, focusedNodeIds) {
  const focused = new Set(
    (Array.isArray(focusedNodeIds) ? focusedNodeIds : [])
      .map((id) => String(id || "").trim())
      .filter(Boolean)
  );
  if (!focused.size) {
    return null;
  }
  const isolatedRows = new Set();
  const isolatedByDepth = [];
  for (const row of Array.isArray(visibleRows) ? visibleRows : []) {
    const rowId = String(row?.id || "").trim();
    const depth = Math.max(Number(row?.depth) || 0, 0);
    isolatedByDepth.length = depth;
    const parentIsolated = depth > 0 && isolatedByDepth[depth - 1] === true;
    const rowIsolated = parentIsolated || focused.has(rowId);
    isolatedByDepth[depth] = rowIsolated;
    if (rowIsolated && rowId) {
      isolatedRows.add(rowId);
    }
  }
  return isolatedRows;
}

function scrollTreeNodeIntoView(target, { block = "nearest" } = {}) {
  if (!target) {
    return;
  }

  const viewport = target.closest("[data-slot='scroll-area-viewport']");
  if (!viewport) {
    target.scrollIntoView?.({
      block,
      behavior: "instant"
    });
    return;
  }

  const targetRect = target.getBoundingClientRect();
  const viewportRect = viewport.getBoundingClientRect();

  if (block === "center") {
    const targetCenter = targetRect.top + targetRect.height / 2;
    const viewportCenter = viewportRect.top + viewportRect.height / 2;
    viewport.scrollTop += targetCenter - viewportCenter;
    return;
  }

  const paddedTop = viewportRect.top + treeRevealScrollPaddingTopPx;

  if (targetRect.top < paddedTop) {
    viewport.scrollTop += targetRect.top - paddedTop;
    return;
  }

  if (targetRect.bottom > viewportRect.bottom) {
    viewport.scrollTop += targetRect.bottom - viewportRect.bottom;
  }
}

function topologyTreeRowType(row) {
  const explicitType = String(row?.topologyType || "").trim();
  if (explicitType) {
    return explicitType;
  }
  const nodeType = String(row?.nodeType || row?.node?.nodeType || "").trim();
  return nodeType.startsWith("topology-") ? nodeType.slice("topology-".length) : "";
}

function topologyTreeRowDetailText(row) {
  return String(row?.detail || row?.node?.detail || row?.summary || row?.node?.summary || "").trim();
}

function topologyTreeRowKind(row, type) {
  const detail = topologyTreeRowDetailText(row).toLowerCase();
  const label = String(row?.label || row?.node?.displayName || "").trim().toLowerCase();
  const haystack = `${detail} ${label}`;
  if (type === "face") {
    if (/\bplane\b/.test(haystack)) return "plane";
    if (/\bcylinder\b/.test(haystack)) return "cylinder";
    if (/\bcone\b/.test(haystack)) return "cone";
    if (/\bsphere\b/.test(haystack)) return "sphere";
    if (/\btorus\b/.test(haystack)) return "torus";
    if (/\bbspline\b|\bspline\b|\bbezier\b/.test(haystack)) return "spline";
    return "face";
  }
  if (type === "edge") {
    if (/\bcircle\b/.test(haystack)) return "circle";
    if (/\bellipse\b/.test(haystack)) return "ellipse";
    if (/\bline\b/.test(haystack)) return "line";
    if (/\bbspline\b|\bspline\b|\bbezier\b/.test(haystack)) return "spline";
    return "edge";
  }
  if (type === "shape") {
    if (/\bsolid\b/.test(haystack)) return "solid";
    if (/\bshell\b/.test(haystack)) return "shell";
  }
  return type;
}

function capitalizeTreeLabel(value) {
  const text = String(value || "").trim();
  return text ? `${text.slice(0, 1).toUpperCase()}${text.slice(1)}` : "";
}

function stepTreeRowAriaLabel(row, topologyType, detail = "") {
  const label = String(row?.label || row?.node?.displayName || "").trim();
  const normalizedTopologyType = String(topologyType || "").trim();
  const normalizedDetail = String(detail || "").trim();
  if (normalizedTopologyType) {
    const prefix = capitalizeTreeLabel(normalizedTopologyType);
    const normalizedLabel = label.toLowerCase();
    const shouldPrefix = prefix && !normalizedLabel.startsWith(normalizedTopologyType.toLowerCase());
    return [shouldPrefix ? prefix : "", label, normalizedDetail].filter(Boolean).join(" ");
  }
  const nodeType = String(row?.nodeType || row?.node?.nodeType || "").trim();
  const prefix = nodeType === "assembly" ? "装配体" : "组件";
  return [prefix, label, normalizedDetail].filter(Boolean).join(" ");
}

function formatTreeTooltipLine(label, value) {
  const normalizedValue = String(value || "").trim();
  return normalizedValue ? `${label}: ${normalizedValue}` : "";
}

function formatRefForTooltip(value) {
  const normalizedValue = String(value || "").trim().replace(/^#/, "");
  return normalizedValue ? `#${normalizedValue}` : "";
}

function stepTreeRowTooltip(row, {
  topologyType = "",
  topologyReferenceId = "",
  detail = "",
  disabledReason = "",
} = {}) {
  const label = String(row?.label || row?.node?.displayName || "").trim();
  const nodeType = String(row?.nodeType || row?.node?.nodeType || "").trim();
  const type = topologyType
    ? capitalizeTreeLabel(topologyType)
    : nodeType === "assembly" ? "装配体" : "组件";
  const selector = topologyType
    ? String(row?.node?.displaySelector || row?.displaySelector || topologyReferenceId || "").trim()
    : String(row?.node?.occurrenceId || row?.node?.id || row?.id || "").trim();
  return [
    formatTreeTooltipLine(type || "Item", label),
    formatTreeTooltipLine("Ref", formatRefForTooltip(selector)),
    formatTreeTooltipLine("Info", detail),
    formatTreeTooltipLine("Status", disabledReason),
  ].filter(Boolean).join("\n");
}

function mateRowTooltip(mate, disabledReason = "") {
  return [
    formatTreeTooltipLine("Mate", mate?.label),
    formatTreeTooltipLine("Ref", formatRefForTooltip(mate?.id)),
    formatTreeTooltipLine("Info", mate?.detail),
    formatTreeTooltipLine("Status", disabledReason),
  ].filter(Boolean).join("\n");
}

function StepTreeDepthGuides({ depth }) {
  const normalizedDepth = Math.min(
    Math.max(Math.trunc(Number(depth) || 0), 0),
    Math.floor(treeDepthMaxPx / treeDepthIndentPx)
  );

  if (normalizedDepth < 1) {
    return null;
  }

  return (
    <span className="pointer-events-none absolute inset-y-0 left-0" aria-hidden="true">
      {Array.from({ length: normalizedDepth }).map((_, index) => (
        <span
          key={index}
          className="absolute inset-y-0 border-l border-sidebar-border/65"
          style={{ left: `${index * treeDepthIndentPx + treeDepthGuideOffsetPx}px` }}
        />
      ))}
    </span>
  );
}

function TopologySvg({ children }) {
  return (
    <svg
      className={treeGlyphIconClasses}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.45"
      strokeLinecap="round"
      strokeLinejoin="round"
      shapeRendering="geometricPrecision"
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

function TopologyTreeGlyph({ row, type }) {
  const normalizedType = String(type || "").trim();
  const kind = topologyTreeRowKind(row, normalizedType);
  const common = `relative ${treeGlyphIconClasses}`;
  if (normalizedType === "occurrence") {
    return null;
  }
  if (normalizedType === "shape") {
    if (kind === "shell") {
      return (
        <TopologySvg>
          <path d="M4.5 4.5h7v7h-7z" />
          <path d="M6.25 6.25h3.5v3.5h-3.5z" />
        </TopologySvg>
      );
    }
    return (
      <span className={common} aria-hidden="true">
        <span className="absolute left-[3px] top-[3px] size-2.5 rotate-45 rounded-[1px] border border-current" />
      </span>
    );
  }
  if (normalizedType === "face") {
    if (kind === "cylinder") {
      return (
        <TopologySvg>
          <ellipse cx="8" cy="4" rx="4" ry="2" />
          <path d="M4 4v8" />
          <path d="M12 4v8" />
          <ellipse cx="8" cy="12" rx="4" ry="2" />
        </TopologySvg>
      );
    }
    if (kind === "cone") {
      return (
        <TopologySvg>
          <path d="M8 3 4 12" />
          <path d="M8 3l4 9" />
          <path d="M4 12c1.25 1.25 6.75 1.25 8 0" />
        </TopologySvg>
      );
    }
    if (kind === "sphere") {
      return (
        <TopologySvg>
          <circle cx="8" cy="8" r="5" />
          <path d="M8 3c1.3 1.35 2 3.05 2 5s-.7 3.65-2 5" />
          <path d="M3 8h10" />
        </TopologySvg>
      );
    }
    if (kind === "torus") {
      return (
        <TopologySvg>
          <ellipse cx="8" cy="8" rx="5.2" ry="3.4" />
          <ellipse cx="8" cy="8" rx="2.2" ry="1.25" />
        </TopologySvg>
      );
    }
    if (kind === "spline") {
      return (
        <TopologySvg>
          <path d="M3 11.5c2.1-6.6 7.6 1 10-5.8" />
          <path d="M3.5 12.7h8.8" opacity="0.45" />
        </TopologySvg>
      );
    }
    return (
      <span className={common} aria-hidden="true">
        <span className="absolute inset-[3px] rounded-[1px] border border-current bg-current/15" />
      </span>
    );
  }
  if (normalizedType === "edge") {
    if (kind === "circle") {
      return (
        <TopologySvg>
          <circle cx="8" cy="8" r="4.6" />
          <circle cx="8" cy="8" r="1.2" fill="currentColor" stroke="none" opacity="0.25" />
        </TopologySvg>
      );
    }
    if (kind === "ellipse") {
      return (
        <TopologySvg>
          <ellipse cx="8" cy="8" rx="5.4" ry="3.2" />
        </TopologySvg>
      );
    }
    if (kind === "spline") {
      return (
        <TopologySvg>
          <path d="M2.8 10.6c2.1-5.8 5.2 2.8 10.4-4.8" />
          <circle cx="2.8" cy="10.6" r="0.9" fill="currentColor" stroke="none" />
          <circle cx="13.2" cy="5.8" r="0.9" fill="currentColor" stroke="none" />
        </TopologySvg>
      );
    }
    return (
      <span className={common} aria-hidden="true">
        <span className="absolute left-[2px] top-[7px] h-px w-3 rotate-[-28deg] rounded-full bg-current" />
        <span className="absolute left-[1px] top-[8px] size-1 rounded-full bg-current" />
        <span className="absolute right-[1px] top-[3px] size-1 rounded-full bg-current" />
      </span>
    );
  }
  return null;
}

function StepTreeRowGlyph({ row }) {
  const topologyType = topologyTreeRowType(row);
  // Topology leaves (faces/edges/shapes) keep their geometric glyph; everything
  // else — assemblies, components, and part occurrences — gets a box icon so
  // every tree row carries an icon, not only the leaf topology nodes.
  if (topologyType && topologyType !== "occurrence") {
    return <TopologyTreeGlyph row={row} type={topologyType} />;
  }
  const nodeType = String(row?.nodeType || row?.node?.nodeType || "").trim();
  const Icon = nodeType === "assembly" ? Boxes : Box;
  return <Icon className={treeGlyphIconClasses} strokeWidth={1.6} aria-hidden="true" />;
}

function normalizeAssemblyMateRows(assemblyMates) {
  if (!Array.isArray(assemblyMates)) {
    return [];
  }
  return assemblyMates
    .filter((mate) => mate && typeof mate === "object")
    .map((mate, index) => {
      const fallbackId = `m${index + 1}`;
      const id = String(mate.id || fallbackId).trim() || fallbackId;
      const sourceLabel = String(mate.sourceLabel || mate.name || "").trim();
      const rawLabel = String(mate.label || "").trim();
      const label = sourceLabel || (rawLabel && rawLabel !== id ? rawLabel : "") || id;
      const type = String(mate.type || mate.relation || "mate").trim() || "mate";
      const fixed = String(mate.fixed || "").trim();
      const moving = String(mate.moving || "").trim();
      const endpoints = fixed && moving ? `${fixed} -> ${moving}` : fixed || moving;
      const detail = [id, type, endpoints].filter(Boolean).join(" ");
      return {
        id,
        label,
        detail,
      };
    });
}

// The shared TimeControl contract, with STEP's live elapsed time: while the
// animation plays the value comes from the frame store rather than the runtime
// snapshot, so the slider tracks playback instead of sitting still.
function StepModuleAnimationTimeControl({
  animationState,
  duration,
  enabled,
  onScrub,
  label = "STEP"
}) {
  const liveElapsedSec = useStepAnimationElapsed();
  const rawElapsedSec = animationState?.playing
    ? liveElapsedSec
    : Number(animationState?.elapsedSec) || 0;
  const elapsedSec = Math.min(Math.max(rawElapsedSec, 0), duration);

  return (
    <FileSheetSliderField
      label="Time"
      value={formatSeconds(elapsedSec)}
      onValueCommit={(nextValue) => {
        onScrub?.(parseFileSheetNumberInput(nextValue, {
          fallback: elapsedSec,
          min: 0,
          max: duration
        }));
      }}
      valueInputProps={{
        disabled: !enabled,
        ariaLabel: `${label} animation time value`
      }}
    >
      <Slider
        className={FILE_SHEET_PRECISION_SLIDER_CLASSES}
        value={[elapsedSec]}
        min={0}
        max={duration}
        step={0.01}
        onValueChange={(nextValue) => onScrub?.(nextValue?.[0] ?? 0)}
        disabled={!enabled}
        aria-label={`${label} animation time`}
      />
    </FileSheetSliderField>
  );
}

export default function StepFileSheet({
  open,
  isDesktop,
  width,
  onOpenChange,
  onStartResize,
  selectedEntry,
  viewerLoading,
  isAssemblyView = false,
  stepTreeRoot,
  assemblyMates = [],
  expandedTreeNodeIds,
  loadableTreeNodeIds = [],
  selectedPartIds,
  selectedReferenceIds = [],
  selectedReferences = [],
  selectedMateIds = [],
  selectableNodeIds = null,
  activeTreeNodeId: activeTreeNodeIdProp = "",
  activeTreeNodeScrollKey = "",
  hoveredPartId,
  hoveredReferenceId = "",
  hoveredMateId = "",
  hiddenPartIds,
  focusedNodeIds = [],
  onSelectTreeNode,
  onSelectReferenceNode,
  onSelectMateNode,
  onFocusTreeNode,
  onUnfocusTreeNode,
  onExitAllIsolate,
  onHideOtherTreeNode,
  onToggleTreeNode,
  onClearSelection,
  onHoverTreeNode,
  onHoverReferenceNode,
  onHoverMateNode,
  recognitionFeatures = [],
  recognitionError = "",
  onSelectFeatureFaces,
  onFocusFeatureFaces,
  onSelectSegmentShape,
  treeSelectionDisabled = false,
  treeSelectionDisabledReason = "",
  onTogglePartVisibility,
  hideAllParts,
  showAllHiddenParts,
  stepModule = null,
  fileDownloadAvailable = false,
  viewerServerInfo = null,
  localFileOpenAvailable = false,
  fileAccessBusyKey = "",
  onOpenFileAsset,
  suppressDynamicMetadataStatus = false,
  statusItems = [],
  themeTabs = [],
  openSectionIds = [],
  onOpenSectionIdsChange
}) {
  const rowRefs = useRef(new Map());
  const lastActiveTreeNodeScrollKeyRef = useRef("");
  const selectedIds = Array.isArray(selectedPartIds) ? selectedPartIds : [];
  // Feature tree collapse state: default fully expanded; category/group rows
  // toggle their key in the collapsed set. Reset whenever the tree changes.
  const [featureCollapsed, setFeatureCollapsed] = useState(() => new Set());
  const [selectedFeatureId, setSelectedFeatureId] = useState("");
  useEffect(() => {
    setFeatureCollapsed(new Set());
    setSelectedFeatureId("");
  }, [recognitionFeatures]);
  const toggleFeatureCollapsed = useMemo(() => (key) => {
    setFeatureCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  }, []);
  const selectedReferenceIdSet = useMemo(
    () => new Set((Array.isArray(selectedReferenceIds) ? selectedReferenceIds : []).map((id) => String(id || "").trim()).filter(Boolean)),
    [selectedReferenceIds]
  );
  // Recursive renderer for the feature-recognition tree. Branch nodes toggle
  // collapse; leaf nodes with faceIds highlight on click (others are display-only).
  // Segment roots resolved to a shape double-click to highlight that whole shape
  // (active style mirrors the geometry tree when its shape is selected).
  const renderFeatureNode = useMemo(() => (node, depth) => {
    if (!node || typeof node !== "object") {
      return null;
    }
    const padLeft = 6 + depth * 15;
    if (node.leaf) {
      const actionable = Array.isArray(node.faceIds) && node.faceIds.length > 0;
      const selected = node.id === selectedFeatureId;
      // 结构化叶子：feature 由 workbench/featureFields.js 生成（编号｜类型｜参数块｜方向｜面数）。
      // 没有它（DFM / 整体信息 / 本模块未覆盖的类型）时走下面的旧布局。
      const feature = node.feature
        && node.feature.typeLabel
        && Array.isArray(node.feature.blocks)
        && node.feature.blocks.length
        ? node.feature
        : null;
      const handleClick = actionable ? () => {
        setSelectedFeatureId(node.id);
        if (typeof onSelectFeatureFaces === "function") {
          onSelectFeatureFaces(node.faceIds);
        }
      } : undefined;
      const handleDoubleClick = actionable && typeof onFocusFeatureFaces === "function" ? () => {
        setSelectedFeatureId(node.id);
        onFocusFeatureFaces(node.faceIds);
      } : undefined;
      if (feature) {
        // 侧栏实测只有 364px 宽（叶子还有 depth 缩进），"编号｜类型｜参数｜方向｜面数"五段挤一行
        // 会把「贯穿」挤到第二行、且参差不齐。所以固定拆成两行（所有特征叶子等高、更规整）：
        //   主行 = 编号 + 类型 +（右对齐）方向 + 面数
        //   参数行 = 各参数块，缩进对齐到类型名下方
        // 参数块**不用 chip 底色**：底色 + 块间距会把一行的宽度预算吃掉约 50px，用等宽数字
        // 与弱化标签分层即可（见 2026-09-15 方案 A / C 的实测取舍）。
        // 长度单位 mm 一律省略（CAD 语境默认毫米，原始 label 本来也不带单位），
        // 只在 mm² / mm³ / ° 这类会歧义时才显示。
        return (
          <button
            key={node.id}
            type="button"
            title={feature.fallback || undefined}
            onClick={handleClick}
            onDoubleClick={handleDoubleClick}
            disabled={!actionable}
            className={cn(
              "flex w-full min-w-0 flex-col gap-0.5 rounded-md py-1 pr-2 text-left text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground disabled:cursor-default disabled:opacity-80",
              selected && "bg-sidebar-accent font-medium text-sidebar-accent-foreground"
            )}
            style={{ paddingLeft: padLeft }}
          >
            <span className="flex w-full min-w-0 items-center gap-2">
              {node.dot ? (
                <span className="shrink-0" style={{ width: 8, height: 8, borderRadius: 999, background: node.dot, flex: "none" }} />
              ) : (
                <span className="w-2 shrink-0" />
              )}
              {/* 特征编号：灰底圆角小框，仅包围编号文本，与后面的参数做视觉分组。
                  用 bg-accent token（与分支计数徽章同族），深浅主题自动跟随。 */}
              <span className="shrink-0 rounded-[4px] bg-accent px-1.5 py-0.5 font-mono text-[14px] leading-none tabular-nums text-muted-foreground">
                {node.label}
              </span>
              <span className="shrink-0 text-[15px] font-medium">{feature.typeLabel}</span>
              {feature.directionLabel || feature.faceCount ? (
                <span className="ml-auto flex shrink-0 items-center gap-2 text-[14px]">
                  {/* 方向与面数：与左端编号同款灰底 chip（bg-accent + 4px 圆角 + 6×2 内边距）
                      —— 三者视觉同族、只做分组不带语义。编号用等宽字，这两项用常规字，
                      保持"标识 vs 属性"的区分。 */}
                  {feature.directionLabel ? (
                    <span className="shrink-0 rounded-[4px] bg-accent px-1.5 py-0.5 leading-none text-muted-foreground">
                      {feature.directionLabel}
                    </span>
                  ) : null}
                  {feature.faceCount ? (
                    <span className="shrink-0 rounded-[4px] bg-accent px-1.5 py-0.5 leading-none tabular-nums text-muted-foreground">
                      {feature.faceCount} 面
                    </span>
                  ) : null}
                </span>
              ) : null}
            </span>
            <span
              className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-0.5 text-[14px]"
              // 74 = dot 8 + 间距 8 + 编号框 50.5（38.5 文本 + 左右 6px 内边距）+ 间距 8，
              // 让参数与主行的类型名对齐（编号加底框后 +12px，实测校准）
              style={{ paddingLeft: 74 }}
            >
              {feature.blocks.map((field) => (
                <span key={field.id} className="shrink-0 whitespace-nowrap">
                  {field.label ? <span className="text-muted-foreground">{field.label}</span> : null}
                  <span className="font-mono tabular-nums">{field.value}</span>
                  {field.unit && field.unit !== "mm" ? (
                    <span className="ml-0.5 text-[13px] text-muted-foreground">{field.unit}</span>
                  ) : null}
                </span>
              ))}
            </span>
          </button>
        );
      }
      if (node.dfm) {
        // DFM 警示条目：浅粉圆角底框（从图标处开始、收缩包住内容）+ 前置警示三角 +
        // 深红文字（参考系统警示横幅样式，用户 2026-09-15 确认：无严重度分级，单档）。
        // 底框在**内层 span** 上而不是整行 button —— 缩进区不上色；行 hover 时底色加深一档。
        // 颜色硬编码（浅 #FFECE8/#BE5557，深 #3A2426/#F2A9A5），不走 --ui-warning-*（琥珀）——
        // 警示粉是全树唯一彩底，两套语义不混用。
        return (
          <button
            key={node.id}
            type="button"
            title={actionable ? `${node.label}（${node.faceIds.length} 个面）` : node.label}
            onClick={handleClick}
            onDoubleClick={handleDoubleClick}
            disabled={!actionable}
            className={cn(
              "group flex w-full min-w-0 items-center rounded-md py-1 pr-2 text-left text-[15px] disabled:cursor-default",
              selected && "font-medium"
            )}
            style={{ paddingLeft: padLeft }}
          >
            <span
              className={cn(
                // ⚠ 本项目设计系统 --radius: 0（全零圆角），rounded-md 会解析成 0px ——
                // 必须用 arbitrary 值显式写 6px（编号框的 rounded-[4px] 同理）
                "inline-flex max-w-full items-center gap-1.5 rounded-[6px] px-2 py-1",
                "bg-[#FFECE8] text-[#BE5557]",
                "group-hover:bg-[#FFD9D2]",
                "dark:bg-[#3A2426] dark:text-[#F2A9A5] dark:group-hover:bg-[#452D2F]"
              )}
            >
              <TriangleAlert className="size-4 shrink-0" strokeWidth={2} aria-hidden="true" />
              <span className="min-w-0 truncate font-medium">{node.label}</span>
              {Array.isArray(node.badges) && node.badges[0] ? (
                <span className="shrink-0 font-mono text-[14px] tabular-nums">{node.badges[0]}</span>
              ) : null}
              {Array.isArray(node.badges) && node.badges[1] ? (
                <span className="shrink-0 text-[13px] opacity-70">{node.badges[1]}</span>
              ) : null}
            </span>
          </button>
        );
      }
      if (node.metric) {
        // 整体信息：key 左对齐、值右对齐（等宽数字）+ 固定宽度的单位列。
        // 单位列固定宽度是这里的关键 —— 它让每一行的数字右边界落在同一条竖线上，
        // 所以 12 970.00 / 39 338.29 / 2 303.37 可以直接比大小，而不是各自贴着右边缘。
        return (
          <button
            key={node.id}
            type="button"
            title={node.sub || undefined}
            disabled
            className="flex w-full min-w-0 items-center gap-2 rounded-md py-1 pr-2 text-left text-[15px] text-sidebar-foreground disabled:cursor-default"
            style={{ paddingLeft: padLeft }}
          >
            {node.dot ? (
              <span className="shrink-0" style={{ width: 8, height: 8, borderRadius: 999, background: node.dot, flex: "none" }} />
            ) : (
              <span className="w-2 shrink-0" />
            )}
            <span className="min-w-0 flex-1 truncate">{node.label}</span>
            <span className="ml-auto flex shrink-0 items-baseline gap-1.5">
              <span className="font-mono text-[14px] tabular-nums">{node.metric.value}</span>
              <span className="w-7 text-left text-[13px] text-muted-foreground">{node.metric.unit}</span>
            </span>
          </button>
        );
      }
      return (
        <button
          key={node.id}
          type="button"
          title={actionable ? `${node.label}（${node.faceIds.length} 个面）` : node.sub || undefined}
          onClick={handleClick}
          onDoubleClick={handleDoubleClick}
          disabled={!actionable}
          className={cn(
            "flex w-full min-w-0 items-center gap-2 rounded-md py-1 pr-2 text-left text-[15px] text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground disabled:cursor-default disabled:opacity-80",
            selected && "bg-sidebar-accent font-medium text-sidebar-accent-foreground"
          )}
          style={{ paddingLeft: padLeft }}
        >
          {node.dot ? (
            <span className="shrink-0" style={{ width: 8, height: 8, borderRadius: 999, background: node.dot, flex: "none" }} />
          ) : (
            <span className="w-2 shrink-0" />
          )}
          <span className="min-w-0 flex-1 truncate font-medium">{node.label}</span>
          {Array.isArray(node.badges) && node.badges.length ? (
            <span className="ml-auto flex min-w-0 shrink-0 items-center gap-1.5">
              {node.badges.map((badge, badgeIndex) => (
                <span key={badgeIndex} className={cn(
                  "shrink-0 rounded-sm px-1 py-0.5 text-[15px]",
                  badgeIndex === 0 ? "bg-accent font-medium text-accent-foreground" : "bg-muted text-muted-foreground"
                )}>{badge}</span>
              ))}
            </span>
          ) : node.sub || actionable ? (
            <span className="ml-auto flex min-w-0 shrink-0 items-center gap-1.5">
              {node.sub ? (
                <span className={cn(
                  "truncate font-mono text-muted-foreground",
                  actionable ? "max-w-[13rem] rounded-sm bg-muted px-1 py-0.5 text-[15px]" : "shrink-0 text-[15.5px]"
                )}>{node.sub}</span>
              ) : null}
              {actionable ? (
                <span className="shrink-0 rounded-sm bg-muted px-1 py-0.5 text-[15px] text-muted-foreground">
                  {node.faceIds.length} 面
                </span>
              ) : null}
            </span>
          ) : null}
        </button>
      );
    }
    const open = !featureCollapsed.has(node.id);
    const segmentShapeRefId = node.segmentShape?.shapeRefId
      ? String(node.segmentShape.shapeRefId).trim()
      : "";
    const segmentActive = Boolean(segmentShapeRefId) && selectedReferenceIdSet.has(segmentShapeRefId);
    const segmentShapeTitle = node.segmentShape?.shapeRefId
      ? `双击高亮对应实体 ${segmentShapeRefId}（${node.segmentShape.method === "faceBridge" ? "面级桥匹配" : "体积匹配"}）`
      : undefined;
    return (
      <div key={node.id}>
        <button
          type="button"
          onClick={() => toggleFeatureCollapsed(node.id)}
          onDoubleClick={segmentShapeRefId && typeof onSelectSegmentShape === "function" ? () => {
            onSelectSegmentShape(segmentShapeRefId);
          } : undefined}
          title={segmentShapeTitle}
          aria-expanded={open}
          className={cn(
            "flex w-full min-w-0 items-center gap-1.5 rounded-md py-1 pr-2 text-left text-[16px] font-medium text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
            segmentActive && "bg-sidebar-accent text-sidebar-accent-foreground"
          )}
          style={{ paddingLeft: padLeft }}
        >
          <span className="inline-block w-3 shrink-0 text-[14px] leading-none">
            {open ? "▾" : "▸"}
          </span>
          {node.dot ? (
            <span className="shrink-0" style={{ width: 8, height: 8, borderRadius: 999, background: node.dot, flex: "none" }} />
          ) : (
            <span className="w-2 shrink-0" />
          )}
          <span className="min-w-0 flex-1 truncate font-semibold">{node.label}</span>
          {node.sub ? (
            // 分支 badge（根节点的零件类型「方件」/「DFM 信息」的「N 条」）与编号、方向、面数同款 chip。
            // 注意 rounded-sm 在本项目等于 0px（--radius: 0），要圆角必须写 arbitrary 值。
            <span className="shrink-0 rounded-[4px] bg-accent px-1.5 py-0.5 text-[14px] font-medium text-accent-foreground">
              {node.sub}
            </span>
          ) : null}
        </button>
        {open ? (
          <div className="space-y-px">
            {(node.children || []).map((child) => renderFeatureNode(child, depth + 1))}
          </div>
        ) : null}
      </div>
    );
  }, [featureCollapsed, onSelectFeatureFaces, onFocusFeatureFaces, onSelectSegmentShape, selectedFeatureId, selectedReferenceIdSet, toggleFeatureCollapsed]);
  const activeSelectedReferenceId = String(
    Array.isArray(selectedReferenceIds) ? selectedReferenceIds[selectedReferenceIds.length - 1] || "" : ""
  ).trim();
  const selectedMateIdSet = useMemo(
    () => new Set((Array.isArray(selectedMateIds) ? selectedMateIds : []).map((id) => String(id || "").trim()).filter(Boolean)),
    [selectedMateIds]
  );
  const hiddenIds = Array.isArray(hiddenPartIds) ? hiddenPartIds : [];
  const focusedNodeIdSet = useMemo(
    () => new Set((Array.isArray(focusedNodeIds) ? focusedNodeIds : []).map((id) => String(id || "").trim()).filter(Boolean)),
    [focusedNodeIds]
  );
  const normalizedHoveredReferenceId = String(hoveredReferenceId || "").trim();
  const normalizedHoveredMateId = String(hoveredMateId || "").trim();
  const selectableNodeIdSet = useMemo(() => {
    if (!Array.isArray(selectableNodeIds)) {
      return null;
    }
    return new Set(selectableNodeIds.map((id) => String(id || "").trim()).filter(Boolean));
  }, [selectableNodeIds]);
  const treeRoot = stepTreeRoot;
  const treeRootChildren = stepTreeNodeChildren(treeRoot);
  const elideRootTreeRow = treeRootChildren.length > 0 && (
    isAssemblyView ||
    stepTreeNodeId(treeRoot) === STEP_MODEL_ROOT_ID
  );
  const assemblyMateRows = useMemo(
    () => normalizeAssemblyMateRows(assemblyMates),
    [assemblyMates]
  );
  const visibleRows = useMemo(
    () => flattenVisibleStepTreeRows(treeRoot, expandedTreeNodeIds, {
      omitRoot: elideRootTreeRow,
      showAllRootChildren: true
    }),
    [elideRootTreeRow, expandedTreeNodeIds, treeRoot]
  );
  const visibleRowIdsSignature = useMemo(
    () => visibleRows.map((row) => String(row?.id || "")).join("\n"),
    [visibleRows]
  );
  const hiddenTreeRowIds = useMemo(
    () => hiddenStepTreeRowIds(visibleRows, hiddenIds),
    [hiddenIds, visibleRows]
  );
  const isolatedTreeRowIds = useMemo(
    () => isolatedStepTreeRowIds(visibleRows, focusedNodeIds),
    [focusedNodeIds, visibleRows]
  );
  const hasAssemblyTree = isAssemblyView || elideRootTreeRow
    ? visibleRows.length > 0
    : visibleRows.some((row) => row?.hasChildren);
  const hasMateRows = assemblyMateRows.length > 0;
  const showInstancesLabel = hasMateRows;
  const showMateSections = hasMateRows;
  const activeReferenceTreeRow = useMemo(
    () => activeSelectedReferenceId
      ? visibleRows.find((row) => String(row?.topologyReferenceId || "").trim() === activeSelectedReferenceId) || null
      : null,
    [activeSelectedReferenceId, visibleRows]
  );
  const rawActiveTreeNodeId = String(activeTreeNodeIdProp || selectedIds[selectedIds.length - 1] || "").trim();
  const activeTreeNodeId = String(activeReferenceTreeRow?.id || rawActiveTreeNodeId || "").trim();
  const activeTreeRow = useMemo(
    () => activeTreeNodeId
      ? visibleRows.find((row) => (
          String(row?.id || "").trim() === activeTreeNodeId ||
          String(row?.node?.selectionPartId || "").trim() === activeTreeNodeId
        )) || null
      : null,
    [activeTreeNodeId, visibleRows]
  );
  const activeTreeNodeIsTopology = activeTreeRow?.node?.visualOnly === true
    ? false
    : Boolean(topologyTreeRowType(activeTreeRow));
  const isolateActive = focusedNodeIdSet.size > 0;
  const showTreeVisibilityControls = isAssemblyView === true;
  const treeSectionOpen = Array.isArray(openSectionIds) && openSectionIds.includes(treeSectionId);
  const treeSelectionTitle = treeSelectionDisabled
    ? String(treeSelectionDisabledReason || "Tree selection is disabled in the current parameter state.").trim()
    : "";
  const expandedTreeNodeIdSet = useMemo(
    () => new Set((Array.isArray(expandedTreeNodeIds) ? expandedTreeNodeIds : []).map((id) => String(id || "").trim()).filter(Boolean)),
    [expandedTreeNodeIds]
  );
  const loadableTreeNodeIdSet = useMemo(
    () => new Set((Array.isArray(loadableTreeNodeIds) ? loadableTreeNodeIds : []).map((id) => String(id || "").trim()).filter(Boolean)),
    [loadableTreeNodeIds]
  );
  const rowCanExpandOrLoad = (row) => {
    const rowId = String(row?.id || "").trim();
    return Boolean(row?.hasChildren || (rowId && loadableTreeNodeIdSet.has(rowId)));
  };
  const expandableTreeNodeIds = useMemo(() => {
    const ids = [];
    const seen = new Set();
    for (const row of visibleRows) {
      const rowId = String(row?.id || "").trim();
      if (!rowId || seen.has(rowId)) {
        continue;
      }
      if (rowCanExpandOrLoad(row)) {
        seen.add(rowId);
        ids.push(rowId);
      }
    }
    return ids;
  }, [loadableTreeNodeIdSet, visibleRows]);
  const collapsedExpandableTreeNodeIds = useMemo(
    () => expandableTreeNodeIds.filter((nodeId) => !expandedTreeNodeIdSet.has(nodeId)),
    [expandableTreeNodeIds, expandedTreeNodeIdSet]
  );
  const expandedExpandableTreeNodeIds = useMemo(
    () => expandableTreeNodeIds.filter((nodeId) => expandedTreeNodeIdSet.has(nodeId)),
    [expandableTreeNodeIds, expandedTreeNodeIdSet]
  );
  const visibleRowById = useMemo(() => {
    const map = new Map();
    for (const row of visibleRows) {
      const rowId = String(row?.id || "").trim();
      if (rowId) {
        map.set(rowId, row);
      }
      const selectionRowId = String(row?.node?.selectionPartId || "").trim();
      if (selectionRowId && !map.has(selectionRowId)) {
        map.set(selectionRowId, row);
      }
    }
    return map;
  }, [visibleRows]);

  const focusTreeRowAtIndex = (startIndex, direction = 1) => {
    if (!visibleRows.length) {
      return;
    }
    const step = direction < 0 ? -1 : 1;
    let index = Math.min(Math.max(Number(startIndex) || 0, 0), visibleRows.length - 1);
    while (index >= 0 && index < visibleRows.length) {
      const rowId = String(visibleRows[index]?.id || "").trim();
      const node = rowId ? rowRefs.current.get(rowId) : null;
      if (node && node.getAttribute("aria-disabled") !== "true") {
        node.focus?.();
        scrollTreeNodeIntoView(node, { block: "nearest" });
        return;
      }
      index += step;
    }
  };

  useEffect(() => {
    const scrollKey = String(activeTreeNodeScrollKey || "").trim();
    if (!scrollKey || scrollKey === lastActiveTreeNodeScrollKeyRef.current || !activeTreeNodeId || !treeSectionOpen) {
      return;
    }
    const scrollToActiveTreeNode = () => {
      const activeNode = rowRefs.current.get(activeTreeNodeId);
      if (!activeNode) {
        return;
      }
      lastActiveTreeNodeScrollKeyRef.current = scrollKey;
      scrollTreeNodeIntoView(activeNode, {
        block: activeTreeNodeIsTopology ? "center" : "nearest"
      });
    };
    if (typeof window === "undefined") {
      scrollToActiveTreeNode();
      return;
    }
    const frameId = window.requestAnimationFrame(scrollToActiveTreeNode);
    return () => {
      window.cancelAnimationFrame(frameId);
    };
  }, [activeTreeNodeId, activeTreeNodeIsTopology, activeTreeNodeScrollKey, treeSectionOpen, visibleRowIdsSignature]);

  if (!selectedEntry) {
    return null;
  }

  const sections = [
    recognitionFeatures.length > 0 || recognitionError ? {
      id: "features",
      title: "特征信息树",
      content: (
        <div className="space-y-px px-2 pb-2">
          {recognitionError ? (
            <FileSheetStatusText className="py-1">
              特征识别结果加载失败：{recognitionError}
            </FileSheetStatusText>
          ) : null}
          {recognitionFeatures.map((rootNode) => renderFeatureNode(rootNode, 0))}
        </div>
      )
    } : null,
    {
      id: treeSectionId,
      title: "几何信息树",
      titleAttr: treeSelectionTitle || undefined,
      content: (
            <div className="max-w-full overflow-hidden pb-2">
              <div
                className="select-none space-y-px"
                role="tree"
                aria-multiselectable="true"
                aria-disabled={treeSelectionDisabled}
                title={treeSelectionTitle || undefined}
                onClick={(event) => {
                  if (treeSelectionDisabled) {
                    return;
                  }
                  if (event.target === event.currentTarget) {
                    onClearSelection?.();
                  }
                }}
              >
              {showInstancesLabel ? (
                <div className={treeGroupLabelClasses} role="presentation">
                  Instances
                </div>
              ) : null}

              {viewerLoading && !visibleRows.length ? (
                <FileSheetStatusText className="py-1">
                  Loading STEP tree...
                </FileSheetStatusText>
              ) : null}

              {hasAssemblyTree
                ? visibleRows.map((row, rowIndex) => {
                  const visualOnlyRow = row?.node?.visualOnly === true;
                  const topologyType = visualOnlyRow ? "" : topologyTreeRowType(row);
                  const topologyRow = Boolean(topologyType);
                  const rowId = String(row.id || "").trim();
                  const selectionRowId = String(row.node?.selectionPartId || row.id || "").trim();
                  const topologyReferenceId = String(row.topologyReferenceId || "").trim();
                  const topologyPartId = topologyRow ? String(row.node?.partId || "").trim() : "";
                  const selectableTopologyRow = Boolean(topologyType) &&
                    topologyReferenceId &&
                    typeof onSelectReferenceNode === "function";
                  const rowDetail = String(row.detail || "").trim();
                  const inlineRowDetail = topologyType ? "" : rowDetail;
                  const rowAriaLabel = stepTreeRowAriaLabel(row, topologyType, rowDetail);
                  const rowHasChildren = rowCanExpandOrLoad(row);
                  const rowExpanded = Boolean(row.expanded);
                  const selected = topologyRow
                    ? selectedReferenceIdSet.has(topologyReferenceId)
                    : selectedIds.includes(selectionRowId);
                  const topologyInsideSelectablePart = topologyRow && topologyPartId && (
                    isolatedTreeRowIds?.has(topologyPartId) ||
                    focusedNodeIdSet.has(topologyPartId) ||
                    selectableNodeIdSet?.has(topologyPartId)
                  );
                  const insideIsolation = !isolatedTreeRowIds ||
                    isolatedTreeRowIds.has(rowId) ||
                    topologyInsideSelectablePart;
                  const focused = !topologyRow && focusedNodeIdSet.has(rowId);
                  const topologyWholeOfFocusedPart = (topologyType === "shape" || topologyType === "occurrence") &&
                    focusedNodeIdSet.has(String(row.node?.partId || "").trim());
                  const selectable = topologyRow
                    ? selectableTopologyRow && insideIsolation && !topologyWholeOfFocusedPart
                    : !focused && (!selectableNodeIdSet || selectableNodeIdSet.has(selectionRowId) || selected);
                  const hidden = hiddenTreeRowIds.has(String(row.id || "").trim());
                  const isolationMuted = isolateActive && !insideIsolation;
                  const rowSelectionDisabled = treeSelectionDisabled || hidden || !selectable;
                  const showSelectedRowState = selected && !hidden && !focused && !topologyWholeOfFocusedPart;
                  const hovered = !hidden && !rowSelectionDisabled && (
                    topologyRow
                      ? topologyReferenceId && normalizedHoveredReferenceId === topologyReferenceId
                      : hoveredPartId === selectionRowId
                  );
                  const rowDisabledReason = treeSelectionTitle ||
                    (!selectable
                      ? topologyWholeOfFocusedPart
                        ? "Select a face or edge of this isolated component"
                        : !topologyRow
                          ? isolateActive ? "Exit isolate to select this node" : "Select a parent assembly to inspect this node"
                          : ""
                      : "");
                  const rowHasEnabledActionButton = !topologyRow &&
                    showTreeVisibilityControls &&
                    !treeSelectionDisabled &&
                    (
                      focused
                        ? typeof onUnfocusTreeNode === "function"
                        : typeof onTogglePartVisibility === "function"
                    );
                  const rowAriaDisabled = rowSelectionDisabled && !rowHasEnabledActionButton;
                  const rowTitle = stepTreeRowTooltip(row, {
                    topologyType,
                    topologyReferenceId,
                    detail: rowDetail,
                    disabledReason: rowDisabledReason,
                  });
                  const rowDepthPx = Math.min(Math.max(row.depth, 0) * treeDepthIndentPx, treeDepthMaxPx);
                  const selectRow = (event) => {
                    const multiSelect = event.shiftKey;
                    if (topologyRow) {
                      onSelectReferenceNode?.(topologyReferenceId, { multiSelect });
                    } else {
                      onSelectTreeNode?.(selectionRowId, { multiSelect });
                    }
                  };
                  const handleRowHoverStart = () => {
                    if (rowSelectionDisabled) {
                      return;
                    }
                    if (topologyRow) {
                      if (topologyReferenceId) {
                        onHoverReferenceNode?.(topologyReferenceId);
                      }
                      return;
                    }
                    onHoverTreeNode?.(selectionRowId);
                  };
                  const handleRowHoverEnd = () => {
                    if (topologyRow) {
                      if (topologyReferenceId) {
                        onHoverReferenceNode?.("");
                      }
                      return;
                    }
                    if (!rowSelectionDisabled) {
                      onHoverTreeNode?.("");
                    }
                  };
                  const handleRowClick = (event) => {
                    if (rowSelectionDisabled) {
                      event.preventDefault();
                      return;
                    }
                    selectRow(event);
                  };
                  const handleRowKeyDown = (event) => {
                    if (event.target !== event.currentTarget || rowSelectionDisabled) {
                      return;
                    }
                    if (event.key === "ArrowDown") {
                      event.preventDefault();
                      focusTreeRowAtIndex(rowIndex + 1, 1);
                      return;
                    }
                    if (event.key === "ArrowUp") {
                      event.preventDefault();
                      focusTreeRowAtIndex(rowIndex - 1, -1);
                      return;
                    }
                    if (event.key === "Home") {
                      event.preventDefault();
                      focusTreeRowAtIndex(0, 1);
                      return;
                    }
                    if (event.key === "End") {
                      event.preventDefault();
                      focusTreeRowAtIndex(visibleRows.length - 1, -1);
                      return;
                    }
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      selectRow(event);
                      return;
                    }
                    if (rowHasChildren && event.key === "ArrowRight" && !rowExpanded) {
                      event.preventDefault();
                      onToggleTreeNode?.(row.id);
                      return;
                    }
                    if (rowHasChildren && event.key === "ArrowLeft" && rowExpanded) {
                      event.preventDefault();
                      onToggleTreeNode?.(row.id);
                    }
                  };
                  const contextFocusActionAvailable = focused
                    ? typeof onUnfocusTreeNode === "function"
                    : typeof onFocusTreeNode === "function";
                  const contextSelectDisabled = treeSelectionDisabled || (!selectable && !selected) || (hidden && !selected);
                  const contextFocusDisabled = topologyRow ||
                    treeSelectionDisabled ||
                    !contextFocusActionAvailable ||
                    (!focused && !selectable && !selected);
                  const contextExitAllIsolateAvailable = !topologyRow &&
                    isolateActive &&
                    focusedNodeIdSet.size > 1 &&
                    typeof onExitAllIsolate === "function";
                  const contextHideOtherDisabled = topologyRow ||
                    treeSelectionDisabled ||
                    hidden ||
                    typeof onHideOtherTreeNode !== "function";
                  const contextHideAllDisabled = topologyRow ||
                    treeSelectionDisabled ||
                    (hidden
                      ? typeof showAllHiddenParts !== "function"
                      : typeof hideAllParts !== "function");
                  const contextVisibilityDisabled = topologyRow ||
                    focused ||
                    !showTreeVisibilityControls ||
                    typeof onTogglePartVisibility !== "function";
                  const selectedContextNodeIds = !topologyRow
                    ? selectedIds
                      .map((id) => String(id || "").trim())
                      .filter(Boolean)
                    : [];
                  const actionNodeIds = !topologyRow
                    ? Array.from(new Set([
                      ...selectedContextNodeIds,
                      selectionRowId
                    ].filter(Boolean)))
                    : [];
                  const actionRows = actionNodeIds
                    .map((nodeId) => visibleRowById.get(nodeId) || null)
                    .filter(Boolean);
                  const collapsedActionNodeIds = actionRows
                    .filter((actionRow) => rowCanExpandOrLoad(actionRow) && !expandedTreeNodeIdSet.has(String(actionRow.id || "").trim()))
                    .map((actionRow) => String(actionRow.id || "").trim())
                    .filter(Boolean);
                  const expandedActionNodeIds = actionRows
                    .filter((actionRow) => rowCanExpandOrLoad(actionRow) && expandedTreeNodeIdSet.has(String(actionRow.id || "").trim()))
                    .map((actionRow) => String(actionRow.id || "").trim())
                    .filter(Boolean);
                  const contextActionCount = actionNodeIds.length || 1;
                  const expandSelectedDisabled = collapsedActionNodeIds.length < 1 ||
                    typeof onToggleTreeNode !== "function";
                  const collapseSelectedDisabled = expandedActionNodeIds.length < 1 ||
                    typeof onToggleTreeNode !== "function";
                  const expandAllDisabled = collapsedExpandableTreeNodeIds.length < 1 ||
                    typeof onToggleTreeNode !== "function";
                  const collapseAllDisabled = expandedExpandableTreeNodeIds.length < 1 ||
                    typeof onToggleTreeNode !== "function";
                  return (
                    <div key={row.id} className="relative min-w-0 max-w-full">
                      <StepTreeDepthGuides depth={row.depth} />
                      <div
                        className="relative flex h-8 min-w-0 max-w-full items-center"
                        style={rowDepthPx > 0 ? { marginLeft: `${rowDepthPx}px` } : undefined}
                      >
                        <ContextMenu modal={false}>
                          <ContextMenuTrigger asChild>
                            <div
                              ref={(node) => {
                                if (node) {
                                  rowRefs.current.set(row.id, node);
                                  if (selectionRowId && selectionRowId !== row.id) {
                                    rowRefs.current.set(selectionRowId, node);
                                  }
                                  return;
                                }
                                rowRefs.current.delete(row.id);
                                if (selectionRowId && selectionRowId !== row.id) {
                                  rowRefs.current.delete(selectionRowId);
                                }
                              }}
                              role="treeitem"
                              aria-expanded={rowHasChildren ? rowExpanded : undefined}
                              aria-selected={selected}
                              aria-label={rowAriaLabel}
                              data-step-tree-node-id={row.id || undefined}
                              data-step-tree-node-type={row.nodeType || undefined}
                              data-step-tree-topology-reference-id={topologyReferenceId || undefined}
                              data-selection-disabled={rowSelectionDisabled ? "true" : undefined}
                              aria-disabled={rowAriaDisabled}
                              tabIndex={rowSelectionDisabled ? -1 : 0}
                              className={cn(
                                "group/tree-row flex h-8 min-w-0 w-full max-w-full items-center gap-2 rounded-md px-2 outline-none transition-colors focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/40",
                                rowSelectionDisabled
                                  ? "cursor-default text-sidebar-foreground/55"
                                  : "cursor-pointer text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:bg-sidebar-accent focus-visible:text-sidebar-accent-foreground",
                                showSelectedRowState
                                  ? "bg-sidebar-accent font-medium text-sidebar-accent-foreground"
                                  : hovered && "bg-sidebar-accent text-sidebar-accent-foreground",
                                (hidden || isolationMuted) && "opacity-45"
                              )}
                              title={rowTitle}
                              onClick={handleRowClick}
                              onKeyDown={handleRowKeyDown}
                              onMouseEnter={handleRowHoverStart}
                              onMouseLeave={handleRowHoverEnd}
                            >
                              <div className="flex min-w-0 flex-1 items-center gap-1.5 overflow-hidden">
                                {rowHasChildren ? (
                                  <Button
                                    type="button"
                                    variant="ghost"
                                    size="icon-sm"
                                    className={treeChevronButtonClasses}
                                    onClick={(event) => {
                                      event.stopPropagation();
                                      onToggleTreeNode?.(row.id);
                                    }}
                                    aria-label={rowExpanded ? `Collapse ${row.label}` : `Expand ${row.label}`}
                                    title={rowExpanded ? "Collapse" : "Expand"}
                                  >
                                    <ChevronRight
                                      className={cn("size-3.5 transition-transform", rowExpanded && "rotate-90")}
                                      strokeWidth={2}
                                      aria-hidden="true"
                                    />
                                  </Button>
                                ) : null}
                                <div
                                  className={cn(
                                    treeRowContentClasses,
                                    "flex min-w-0 flex-1 shrink touch-manipulation items-center justify-start gap-1.5 overflow-hidden px-0 text-left",
                                    rowSelectionDisabled && "text-sidebar-foreground/55"
                                  )}
                                >
                                  <StepTreeRowGlyph row={row} />
                                  <span className="min-w-0 flex-1 overflow-hidden">
                                    <span className="flex min-w-0 items-baseline gap-1.5 overflow-hidden text-[15px] font-medium leading-4">
                                      <span className="min-w-0 truncate">
                                        {row.label}
                                      </span>
                                      {inlineRowDetail ? (
                                        <span className="min-w-0 truncate text-[13px] font-normal text-current/50">
                                          {inlineRowDetail}
                                        </span>
                                      ) : null}
                                    </span>
                                  </span>
                                </div>
                              </div>
                              {!topologyRow && showTreeVisibilityControls ? (
                                <Button
                                  type="button"
                                  variant="ghost"
                                  size="icon-sm"
                                  className={cn(
                                    treeRowActionButtonClasses,
                                    "ml-1 shrink-0",
                                    !hidden && !showSelectedRowState && !hovered && !focused && "opacity-0 group-hover/tree-row:opacity-100 focus-visible:opacity-100",
                                    hidden && "text-current/75",
                                    treeSelectionDisabled && "cursor-default text-current/35 hover:!bg-transparent hover:!text-current/35"
                                  )}
                                  disabled={treeSelectionDisabled || (
                                    focused
                                      ? typeof onUnfocusTreeNode !== "function"
                                      : typeof onTogglePartVisibility !== "function"
                                  )}
                                  aria-label={focused
                                    ? `退出 ${row.label} 的隔离`
                                    : hidden ? `显示 ${row.label}` : `隐藏 ${row.label}`}
                                  title={focused ? "退出隔离" : hidden ? "显示" : "隐藏"}
                                  onClick={(event) => {
                                    event.stopPropagation();
                                    if (focused) {
                                      onUnfocusTreeNode?.(row.id);
                                      return;
                                    }
                                    onTogglePartVisibility?.(row.id);
                                  }}
                                >
                                  {focused ? (
                                    <X className="size-3" strokeWidth={2} aria-hidden="true" />
                                  ) : hidden ? (
                                    <Eye className="size-3" strokeWidth={1.8} aria-hidden="true" />
                                  ) : (
                                    <EyeOff className="size-3" strokeWidth={1.8} aria-hidden="true" />
                                  )}
                                </Button>
                              ) : null}
                            </div>
                          </ContextMenuTrigger>
                          <ContextMenuContent className="w-44">
                        <AssemblyContextMenuItems
                          Item={ContextMenuItem}
                          Separator={ContextMenuSeparator}
                          selected={selected}
                          isolated={focused}
                          hidden={hidden}
                          actionCount={contextActionCount}
                          selectDisabled={contextSelectDisabled}
                          showIsolate={!topologyRow}
                          isolateDisabled={contextFocusDisabled}
                          showExitAllIsolate={contextExitAllIsolateAvailable}
                          exitAllIsolateDisabled={treeSelectionDisabled || !contextExitAllIsolateAvailable}
                          showHideOther={!topologyRow}
                          hideOtherDisabled={contextHideOtherDisabled}
                          hideAllDisabled={contextHideAllDisabled}
                          hideAllLabel="Show all"
                          showVisibility={!topologyRow && !focused}
                          visibilityDisabled={contextVisibilityDisabled}
                          showHideAll={false}
                          showExpandCollapse={rowHasChildren || actionRows.some((actionRow) => rowCanExpandOrLoad(actionRow)) || expandableTreeNodeIds.length > 0}
                          expandSelectedDisabled={expandSelectedDisabled}
                          collapseSelectedDisabled={collapseSelectedDisabled}
                          expandAllDisabled={expandAllDisabled}
                          collapseAllDisabled={collapseAllDisabled}
                          onSelect={(event) => {
                            if (!topologyRow && selected && selectedContextNodeIds.length > 1) {
                              onClearSelection?.();
                              return;
                            }
                            selectRow(event);
                          }}
                          onIsolate={() => {
                            if (focused) {
                              onUnfocusTreeNode?.(row.id);
                              return;
                            }
                            onFocusTreeNode?.(actionNodeIds);
                          }}
                          onExitAllIsolate={() => {
                            onExitAllIsolate?.();
                          }}
                          onHideOther={() => {
                            onHideOtherTreeNode?.(actionNodeIds);
                          }}
                          onHideAll={() => {
                            if (hidden) {
                              showAllHiddenParts?.();
                              return;
                            }
                            hideAllParts?.();
                          }}
                          onToggleVisibility={() => {
                            for (const nodeId of actionNodeIds) {
                              onTogglePartVisibility?.(nodeId);
                            }
                          }}
                          onExpandSelected={() => {
                            for (const nodeId of collapsedActionNodeIds) {
                              onToggleTreeNode?.(nodeId);
                            }
                          }}
                          onCollapseSelected={() => {
                            for (const nodeId of expandedActionNodeIds) {
                              onToggleTreeNode?.(nodeId);
                            }
                          }}
                          onExpandAll={() => {
                            for (const nodeId of collapsedExpandableTreeNodeIds) {
                              onToggleTreeNode?.(nodeId);
                            }
                          }}
                          onCollapseAll={() => {
                            for (const nodeId of expandedExpandableTreeNodeIds) {
                              onToggleTreeNode?.(nodeId);
                            }
                          }}
                        />
                          </ContextMenuContent>
                        </ContextMenu>
                      </div>
                    </div>
                  );
                })
                : null}

              {!hasAssemblyTree && !viewerLoading ? (
                <FileSheetStatusText className="py-1">
                  No assembly tree
                </FileSheetStatusText>
              ) : null}

              {showMateSections ? (
                <>
                  <div className={treeGroupLabelClasses} role="presentation">
                    Mates
                  </div>
                  {assemblyMateRows.map((mate) => {
                    const mateSelected = selectedMateIdSet.has(mate.id);
                    const mateHovered = normalizedHoveredMateId === mate.id;
                    const mateSelectionDisabled = treeSelectionDisabled || typeof onSelectMateNode !== "function";
                    const mateTitle = mateRowTooltip(mate, treeSelectionTitle);
                    const selectMate = (event) => {
                      onSelectMateNode?.(mate.id, { multiSelect: event?.shiftKey === true });
                    };
                    return (
                      <ContextMenu key={mate.id} modal={false}>
                        <ContextMenuTrigger asChild>
                          <div
                            role="treeitem"
                            aria-label={[mate.label, mate.detail].filter(Boolean).join(" ")}
                            aria-selected={mateSelected}
                            aria-disabled={mateSelectionDisabled}
                            tabIndex={mateSelectionDisabled ? -1 : 0}
                            className={cn(
                              "flex h-8 min-w-0 max-w-full items-center gap-2 rounded-md px-2 text-[15px] outline-none transition-colors focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/40",
                              mateSelectionDisabled
                                ? "cursor-default text-sidebar-foreground/55"
                                : "cursor-pointer text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:bg-sidebar-accent focus-visible:text-sidebar-accent-foreground",
                              mateSelected
                                ? "bg-sidebar-accent font-medium text-sidebar-accent-foreground"
                                : mateHovered && "bg-sidebar-accent text-sidebar-accent-foreground"
                            )}
                            title={mateTitle}
                            onClick={(event) => {
                              if (mateSelectionDisabled) {
                                event.preventDefault();
                                return;
                              }
                              selectMate(event);
                            }}
                            onKeyDown={(event) => {
                              if (event.target !== event.currentTarget || mateSelectionDisabled) {
                                return;
                              }
                              if (event.key === "Enter" || event.key === " ") {
                                event.preventDefault();
                                selectMate(event);
                              }
                            }}
                            onMouseEnter={() => {
                              if (!mateSelectionDisabled) {
                                onHoverMateNode?.(mate.id);
                              }
                            }}
                            onMouseLeave={() => {
                              if (!mateSelectionDisabled) {
                                onHoverMateNode?.("");
                              }
                            }}
                          >
                            <span className={treeMateIconSlotClasses} aria-hidden="true">
                              <Link2 className="size-3.5" strokeWidth={1.8} />
                            </span>
                            <span className="min-w-0 flex-1 truncate font-medium leading-4">
                              {mate.label}
                            </span>
                          </div>
                        </ContextMenuTrigger>
                        <ContextMenuContent className="w-44">
                          <AssemblyContextMenuItems
                            Item={ContextMenuItem}
                            Separator={ContextMenuSeparator}
                            selected={mateSelected}
                            selectDisabled={mateSelectionDisabled}
                            showIsolate={false}
                            showHideOther={false}
                            showVisibility={false}
                            showHideAll={false}
                            showExpandCollapse={false}
                            onSelect={selectMate}
                          />
                        </ContextMenuContent>
                      </ContextMenu>
                    );
                  })}
                </>
              ) : null}
              </div>
            </div>
      )
    },
    buildStepReferenceTab({ references: selectedReferences }),
    // The parameters tab is the shared ParameterControlsSection; the only
    // STEP-specific part is the time control, which tracks live playback.
    buildParameterControlsTab({
      runtime: stepModule,
      label: "STEP",
      loadingLabel: "Loading STEP module…",
      noParametersLabel: "No module parameters.",
      showEnableToggle: true,
      enableAriaLabel: "Enable STEP module",
      animationAriaLabel: "STEP animation",
      resetTitle: "Reset STEP parameters",
      TimeControl: StepModuleAnimationTimeControl
    }),
    ...themeTabs,
    // "Issues" is a diagnostic shown only when there are warnings/errors, so it trails the
    // content + display tabs as the last item in the top section (null when there are none;
    // the surface filters falsy tabs).
    buildFileStatusTab(statusItems)
  ];

  return (
    <FileSheet
      open={open}
      title="STEP"
      isDesktop={isDesktop}
      width={width}
      onOpenChange={onOpenChange}
      onStartResize={onStartResize}
      scrollBody={false}
    >
      <FileSheetTabbedSurface
        kind="step"
        sections={sections}
        openSectionIds={openSectionIds}
        onOpenSectionIdsChange={onOpenSectionIdsChange}
      />
    </FileSheet>
  );
}
