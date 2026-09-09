import {
  applyTopologyDisplayEdgeSurfaceOffset,
  disposeTopologyDisplayEdgeObject
} from "../../common/topologyDisplayEdgeRuntime.js";
import {
  composeDisplayRecordEffectMatrix
} from "../../common/displayRecordTransform.js";
import {
  createTopologyDisplayEdgeObject
} from "../../common/renderEdges.js";

function normalizePartIdList(value) {
  return (Array.isArray(value) ? value : [value])
    .map((id) => String(id || "").trim())
    .filter(Boolean);
}

function partIdMatchesAny(partId, partIds = []) {
  const normalizedPartId = String(partId || "").trim();
  if (!normalizedPartId) {
    return false;
  }
  for (const candidate of partIds) {
    if (normalizedPartId === candidate || normalizedPartId.startsWith(`${candidate}.`)) {
      return true;
    }
  }
  return false;
}

function uniqueDisplayRecordsByPartId(displayRecords = []) {
  const records = [];
  const seen = new Set();
  for (const record of Array.isArray(displayRecords) ? displayRecords : []) {
    const partId = String(record?.partId || "").trim();
    if (!partId || seen.has(partId)) {
      continue;
    }
    seen.add(partId);
    records.push(record);
  }
  return records;
}

function displayRecordPartIds(displayRecords = []) {
  return uniqueDisplayRecordsByPartId(displayRecords).map((record) => String(record.partId || "").trim());
}

function topologyDisplayEdgeLineSettingsKey(
  edgeSettings = {},
  focusedPartIds = [],
  baseTheme = {},
  dimmedOpacity = 0.035,
  {
    transformByRecord = false,
    displayRecords = []
  } = {}
) {
  const numberOrNull = (value) => Number.isFinite(Number(value)) ? Number(value) : null;
  return JSON.stringify({
    color: String(edgeSettings?.color || ""),
    opacity: numberOrNull(edgeSettings?.opacity),
    thickness: numberOrNull(edgeSettings?.thickness),
    includePartIds: normalizePartIdList(edgeSettings?.includePartIds),
    excludePartIds: normalizePartIdList(edgeSettings?.excludePartIds),
    visibilityClasses: normalizePartIdList(edgeSettings?.visibilityClasses),
    classes: edgeSettings?.classes && typeof edgeSettings.classes === "object"
      ? Object.fromEntries(Object.entries(edgeSettings.classes).map(([classId, settings]) => [
          classId,
          {
            color: String(settings?.color || ""),
            opacity: numberOrNull(settings?.opacity),
            thickness: numberOrNull(settings?.thickness)
          }
        ]))
      : null,
    highlightColor: String(edgeSettings?.highlightColor || ""),
    highlightOpacity: numberOrNull(edgeSettings?.highlightOpacity),
    highlightRenderOrder: numberOrNull(edgeSettings?.highlightRenderOrder),
    focusedPartIds: normalizePartIdList(focusedPartIds),
    dimmedOpacity,
    baseEdge: String(baseTheme?.edge || ""),
    baseEdgeOpacity: numberOrNull(baseTheme?.edgeOpacity),
    baseEdgeThickness: numberOrNull(baseTheme?.edgeThickness),
    transformByRecord: transformByRecord === true,
    recordPartIds: transformByRecord === true ? displayRecordPartIds(displayRecords) : []
  });
}

function applyRecordEffectMatrix(runtime, object, record) {
  const THREE = runtime?.THREE;
  if (!THREE || !object) {
    return false;
  }
  const nextMatrix = composeDisplayRecordEffectMatrix(THREE, record) || new THREE.Matrix4();
  object.matrixAutoUpdate = false;
  const targetMatrix = object.matrix instanceof THREE.Matrix4 ? object.matrix : new THREE.Matrix4();
  const changed = !targetMatrix.equals(nextMatrix);
  if (changed) {
    targetMatrix.copy(nextMatrix);
    object.matrix = targetMatrix;
    object.matrixWorldNeedsUpdate = true;
  }
  const nextVisible = record?.mesh?.visible !== false && record?.effectVisible !== false;
  if (object.visible !== nextVisible) {
    object.visible = nextVisible;
    return true;
  }
  return changed;
}

function syncRecordEdgeLineTransforms(runtime, group, displayRecords = []) {
  if (!group?.children?.length) {
    return false;
  }
  const recordByPartId = new Map();
  for (const record of uniqueDisplayRecordsByPartId(displayRecords)) {
    recordByPartId.set(String(record.partId || "").trim(), record);
  }

  let changed = false;
  for (const child of group.children) {
    const partId = String(child?.userData?.cadTopologyDisplayRecordPartId || "").trim();
    if (!partId) {
      // 非"按记录"生成的子对象（普通整线路径的类分组不带该标记）：
      // 不属于本同步的管理范围，跳过而不是隐藏——否则爆炸视图 effect 一跑
      // 就会把整条拓扑线全部隐藏（2026-09-08 "边线消失"根因）。
      continue;
    }
    const record = recordByPartId.get(partId) || null;
    if (!record) {
      if (child.visible !== false) {
        child.visible = false;
        changed = true;
      }
      continue;
    }
    changed = applyRecordEffectMatrix(runtime, child, record) || changed;
  }
  if (changed) {
    runtime.edgesGroup?.updateMatrixWorld?.(true);
  }
  return changed;
}

export function syncRecordTopologyDisplayEdgeTransforms(runtime, displayRecords = []) {
  return syncRecordEdgeLineTransforms(runtime, runtime?.topologyDisplayEdgeLine, displayRecords);
}

export function createRecordTopologyDisplayEdgeGroup(runtime, sourceRuntime, {
  edgeSettings = {},
  focusedPartIds = [],
  viewerTheme = {},
  dimmedOpacity = 0.035,
  displayRecords = []
} = {}) {
  if (!runtime?.THREE || !sourceRuntime) {
    return null;
  }
  const records = uniqueDisplayRecordsByPartId(displayRecords);
  if (!records.length) {
    return null;
  }
  const group = new runtime.THREE.Group();
  const focusedIds = normalizePartIdList(focusedPartIds);
  const highlightIds = normalizePartIdList(edgeSettings?.highlightPartIds);
  const baseOpacity = Number.isFinite(Number(edgeSettings?.opacity)) ? Number(edgeSettings.opacity) : null;
  for (const record of records) {
    const partId = String(record?.partId || "").trim();
    if (!partId) {
      continue;
    }
    if (highlightIds.length && !partIdMatchesAny(partId, highlightIds)) {
      continue;
    }
    const opacity = focusedIds.length && !partIdMatchesAny(partId, focusedIds)
      ? dimmedOpacity
      : baseOpacity;
    const recordEdgeSettings = highlightIds.length
      ? {
          ...edgeSettings,
          highlightPartIds: [partId]
        }
      : {
          ...edgeSettings,
          includePartIds: [partId],
          ...(opacity !== null ? { opacity } : {})
        };
    const line = createTopologyDisplayEdgeObject(
      runtime,
      sourceRuntime,
      recordEdgeSettings,
      viewerTheme
    );
    if (!line) {
      continue;
    }
    line.userData = {
      ...(line.userData || {}),
      cadTopologyDisplayRecordPartId: partId
    };
    applyRecordEffectMatrix(runtime, line, record);
    group.add(line);
  }
  if (!group.children.length) {
    return null;
  }
  group.name = "TopologyDisplayEdges";
  group.userData.partId = "__topology__";
  group.userData.disposeGeometry = false;
  group.userData.disposeMaterial = false;
  return group;
}

export function syncTopologyDisplayEdgeLine(runtime, topologyRuntime, {
  visible = false,
  edgeSettings = {},
  focusedPartIds = [],
  viewerTheme = {},
  dimmedOpacity = 0.035,
  transformByRecord = false,
  displayRecords = [],
  syncClip = null
} = {}) {
  if (!runtime?.THREE || !runtime?.edgesGroup) {
    return false;
  }

  const sourceRuntime = visible ? topologyRuntime : null;
  const settingsKey = sourceRuntime
    ? topologyDisplayEdgeLineSettingsKey(edgeSettings, focusedPartIds, viewerTheme, dimmedOpacity, {
        transformByRecord,
        displayRecords
      })
    : "";
  const current = runtime.topologyDisplayEdgeLine || null;
  if (
    current &&
    current.userData?.cadTopologyDisplayEdgeRuntime === sourceRuntime &&
    current.userData?.cadTopologyDisplayEdgeSettingsKey === settingsKey
  ) {
    const changed = transformByRecord
      ? syncRecordEdgeLineTransforms(runtime, current, displayRecords)
      : false;
    if (changed) {
      applyTopologyDisplayEdgeSurfaceOffset(runtime.displayRecords, edgeSettings);
      syncClip?.(runtime);
      runtime.requestRender?.();
    }
    return changed;
  }

  if (!sourceRuntime) {
    // 显式隐藏：正常拆除旧线
    if (current) {
      runtime.edgesGroup.remove(current);
      disposeTopologyDisplayEdgeObject(current);
      runtime.topologyDisplayEdgeLine = null;
    }
    syncClip?.(runtime);
    runtime.requestRender?.();
    return true;
  }

  // 先创建、成功后再拆旧线：重建失败时保留现有线，避免一次失败的重建
  // 让边线整体消失（2026-09-08 "任意操作后边线消失"的教训）。
  const topologyEdgeLine = transformByRecord
    ? createRecordTopologyDisplayEdgeGroup(runtime, sourceRuntime, {
        edgeSettings,
        focusedPartIds,
        viewerTheme,
        dimmedOpacity,
        displayRecords
      })
    : createTopologyDisplayEdgeObject(
        runtime,
        sourceRuntime,
        {
          ...edgeSettings,
          focusedPartIds,
          dimmedOpacity
        },
        viewerTheme
      );
  if (!topologyEdgeLine) {
    // 创建失败：保留现有线（如果有的话）
    if (current) {
      current.visible = true;
    }
    syncClip?.(runtime);
    runtime.requestRender?.();
    return false;
  }
  if (current) {
    runtime.edgesGroup.remove(current);
    disposeTopologyDisplayEdgeObject(current);
  }

  topologyEdgeLine.userData = {
    ...(topologyEdgeLine.userData || {}),
    cadTopologyDisplayEdgeRuntime: sourceRuntime,
    cadTopologyDisplayEdgeSettingsKey: settingsKey
  };
  runtime.topologyDisplayEdgeLine = topologyEdgeLine;
  runtime.edgesGroup.add(topologyEdgeLine);
  runtime.edgesGroup.updateMatrixWorld?.(true);
  applyTopologyDisplayEdgeSurfaceOffset(runtime.displayRecords, edgeSettings);
  syncClip?.(runtime);
  runtime.requestRender?.();
  return true;
}
