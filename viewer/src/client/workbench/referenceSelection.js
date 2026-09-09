import { buildSelectorRuntime } from "cadjs/lib/selectors/runtime.js";
import { entryReferenceAssetSignature } from "cadjs/lib/entryAssets.js";
import { cadPathForEntry, fileKey } from "./sidebar.js";

export function buildReferenceCacheKey(entry) {
  const fileRef = fileKey(entry);
  const referenceHash = entryReferenceAssetSignature(entry);
  return fileRef && referenceHash ? `${fileRef}:${referenceHash}` : "";
}

export function normalizeReferenceList(value) {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .filter((reference) => reference && typeof reference === "object")
    .map((reference) => ({
      ...reference,
      id: String(reference.id || "").trim(),
      label: String(reference.label || reference.id || "Reference").trim() || "Reference",
      summary: String(reference.summary || reference.shortSummary || "").trim(),
      shortSummary: String(reference.shortSummary || reference.summary || "").trim(),
      copyText: String(reference.copyText || "").trim(),
      partId: String(reference.partId || "").trim(),
      entityType: String(reference.entityType || "").trim(),
      selectorType: String(reference.selectorType || "").trim(),
      normalizedSelector: String(reference.normalizedSelector || "").trim(),
      displaySelector: String(reference.displaySelector || "").trim()
    }))
    .filter((reference) => reference.id);
}

export function buildNormalizedReferenceState(entry, referencePayload = null, {
  copyCadPath,
  partId = "",
  transform = null,
  remapOccurrenceId = "",
  remapOccurrencePrefix = null,
  selectorRuntime: prebuiltSelectorRuntime = null,
  loadedTopologyKey = ""
} = {}) {
  // A component-GLB package has no whole-assembly selector bundle; the caller composes the
  // per-component runtimes and passes the result here instead of a single bundle to parse.
  const selectorRuntime = prebuiltSelectorRuntime || buildSelectorRuntime(referencePayload, {
    copyCadPath: copyCadPath || cadPathForEntry(entry),
    partId,
    transform,
    remapOccurrenceId,
    remapOccurrencePrefix
  });
  const references = normalizeReferenceList(selectorRuntime.references);
  return {
    fileRef: fileKey(entry),
    kind: entry.kind,
    referenceHash: buildReferenceCacheKey(entry),
    stepRelPath: fileKey(entry),
    stepHash: String(selectorRuntime.stepHash || entry?.hash || ""),
    counts: {
      faces: Number(selectorRuntime.faces?.length || 0),
      edges: Number(selectorRuntime.edges?.length || 0)
    },
    parts: [],
    selectorRuntime,
    references,
    loadedTopologyKey,
    disabledReason: ""
  };
}

// Lazy assembly topology: from a component-GLB package descriptor, pick only the occurrences whose
// ids are in `requestedOccurrenceIds` (the tree nodes the user expanded) and the de-duplicated set
// of component cids they need. A single-component part has no assembly tree, so it loads every
// occurrence. `loadedTopologyKey` is a stable key over the requested set so callers can detect when
// the expanded set grows and re-load only the newly-needed components.
export function selectRequestedAssemblyComponents(
  packageDescriptor,
  requestedOccurrenceIds,
  { singleComponentPart = false } = {}
) {
  const occurrences = Array.isArray(packageDescriptor?.occurrences) ? packageDescriptor.occurrences : [];
  const requestedSet = new Set(
    (Array.isArray(requestedOccurrenceIds) ? requestedOccurrenceIds : [])
      .map((id) => String(id || "").trim())
      .filter(Boolean)
  );
  const occurrencesToLoad = singleComponentPart
    ? occurrences
    : occurrences.filter((occurrence) => requestedSet.has(String(occurrence?.id || "").trim()));
  const neededCids = [];
  const seenCids = new Set();
  for (const occurrence of occurrencesToLoad) {
    const cid = String(occurrence?.component || "").trim();
    if (cid && !seenCids.has(cid)) {
      seenCids.add(cid);
      neededCids.push(cid);
    }
  }
  const loadedTopologyKey = singleComponentPart ? "*" : [...requestedSet].sort().join("|");
  return { occurrencesToLoad, neededCids, loadedTopologyKey };
}

export function parseAssemblyPartReferenceSelectionId(referenceId) {
  const normalizedReferenceId = String(referenceId || "").trim();
  const prefix = "assembly-part:";
  if (normalizedReferenceId.startsWith(prefix)) {
    const partId = normalizedReferenceId.slice(prefix.length).trim();
    if (!partId) {
      return null;
    }
    return { partId };
  }
  if (normalizedReferenceId.startsWith("topology|")) {
    const parts = normalizedReferenceId.split("|");
    const partId = String(parts[1] || "").trim();
    if (!partId) {
      return null;
    }
    return { partId };
  }
  return null;
}

export function orderedStringListEqual(a, b) {
  if (a === b) {
    return true;
  }
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) {
    return false;
  }
  for (let index = 0; index < a.length; index += 1) {
    if (a[index] !== b[index]) {
      return false;
    }
  }
  return true;
}

export function uniqueStringList(values) {
  const seen = new Set();
  const result = [];
  for (const value of Array.isArray(values) ? values : []) {
    const normalizedValue = String(value || "").trim();
    if (!normalizedValue || seen.has(normalizedValue)) {
      continue;
    }
    seen.add(normalizedValue);
    result.push(normalizedValue);
  }
  return result;
}

function normalizePosixPath(path) {
  const parts = [];
  for (const part of String(path || "").replace(/\\/g, "/").split("/")) {
    if (!part || part === ".") {
      continue;
    }
    if (part === "..") {
      parts.pop();
      continue;
    }
    parts.push(part);
  }
  return parts.join("/");
}

export function resolveTopologyRelativeFile(entry, sourcePath) {
  const relativeSourcePath = String(sourcePath || "").trim();
  const stepPath = fileKey(entry);
  if (!relativeSourcePath || !stepPath) {
    return "";
  }
  const stepParts = stepPath.split("/");
  const stepFilename = stepParts.pop();
  const stepDirectory = stepParts.join("/");
  const topologyDirectory = stepDirectory ? `${stepDirectory}/.${stepFilename}` : `.${stepFilename}`;
  return normalizePosixPath(`${topologyDirectory}/${relativeSourcePath}`);
}

export function computeNextSelectionIds(currentIds, selectionId, { multiSelect = false } = {}) {
  const normalizedSelectionId = String(selectionId || "").trim();
  if (!normalizedSelectionId) {
    return [];
  }
  const current = Array.isArray(currentIds) ? currentIds : [];
  if (multiSelect) {
    return current.includes(normalizedSelectionId)
      ? current.filter((id) => id !== normalizedSelectionId)
      : [...current, normalizedSelectionId];
  }
  if (current.length === 1 && current[0] === normalizedSelectionId) {
    return [];
  }
  return [normalizedSelectionId];
}
