// External face-highlight protocol: the iframe host talks to step-viewer over
// postMessage so it can highlight faces WITHOUT shipping a feature-recognition
// JSON. Decision record (2026-10-16): origin 全量开放 (no allow-list), no focus
// command, no reverse channel (viewer never reports user clicks back).
//
// Wire format — every frame carries source + version so both sides can cheaply
// discard anything that is not ours:
//
//   viewer -> host   { source:"cad-viewer", version:1, type:"ready",
//                      taskId, file }
//   host   -> viewer { source:"cad-host",   version:1, type:"highlightFaces",
//                      entityIds:[#N...], requestId }        // [] = clear
//   viewer -> host   { source:"cad-viewer", version:1, type:"highlightResult",
//                      requestId, ok, matched, total, unknown[], error }
//
// `entityIds` are STEP entity numbers (#N) — the exact same space as
// `relatedEntityIds` in the feature-recognition JSON, so the host needs no new
// capability beyond what it already has.
//
// This module is deliberately dependency-free and DOM-free except for the
// obvious window.postMessage callsite in the caller, so `node --test` can cover
// every rule without a browser.

export const VIEWER_SOURCE = "cad-viewer";
export const HOST_SOURCE = "cad-host";
export const PROTOCOL_VERSION = 1;

export const TYPE_READY = "ready";
export const TYPE_HIGHLIGHT_FACES = "highlightFaces";
export const TYPE_HIGHLIGHT_RESULT = "highlightResult";

// Upper bound for one highlight request. This is not a product limit — it exists
// so a misbehaving host cannot freeze the render thread with a garbage payload.
export const MAX_ENTITY_IDS = 5000;

function uniqueNumbers(values) {
  const seen = new Set();
  const out = [];
  for (const value of values) {
    const numeric = Number(value);
    if (!seen.has(numeric)) {
      seen.add(numeric);
      out.push(numeric);
    }
  }
  return out;
}

// Normalise anything the host sends into a clean list of positive STEP entity
// numbers. Mirrors flattenEntityIds() in featureRecognition.js (which keeps the
// feature-JSON shape) — nested arrays are flattened, junk and <=0 are dropped,
// duplicates collapse, and the result is capped.
export function normaliseEntityIds(raw) {
  const collected = [];
  const push = (entry) => {
    if (Array.isArray(entry)) {
      entry.forEach(push);
      return;
    }
    if (entry === null || entry === undefined || entry === "") {
      return;
    }
    const numeric = Number(entry);
    if (Number.isFinite(numeric) && numeric > 0) {
      collected.push(numeric);
    }
  };
  if (Array.isArray(raw)) {
    raw.forEach(push);
  } else {
    push(raw);
  }
  return uniqueNumbers(collected).slice(0, MAX_ENTITY_IDS);
}

// Cheap shape check so unrelated messages (devtools, other widgets, Web Workers
// bubbling through) never reach the parser.
export function isExternalHostMessage(data) {
  return Boolean(
    data &&
    typeof data === "object" &&
    data.source === HOST_SOURCE &&
    Number(data.version) === PROTOCOL_VERSION &&
    typeof data.type === "string" &&
    data.type.length > 0
  );
}

// Parse one inbound host frame. Returns { ok:false, error } for anything we must
// ignore, { ok:true, entityIds, requestId } for a highlightFaces we will apply.
// An empty (or fully invalid) entityIds list is a VALID request: it means "clear".
export function parseExternalHighlightMessage(data) {
  if (!isExternalHostMessage(data)) {
    return { ok: false, error: "not an external-highlight message" };
  }
  if (data.type !== TYPE_HIGHLIGHT_FACES) {
    return { ok: false, error: `unsupported type "${data.type}"` };
  }
  if (!Array.isArray(data.entityIds)) {
    return { ok: false, error: "entityIds must be an array" };
  }
  const entityIds = normaliseEntityIds(data.entityIds);
  const requestId = typeof data.requestId === "string" ? data.requestId : "";
  return { ok: true, type: TYPE_HIGHLIGHT_FACES, entityIds, requestId };
}

export function buildReadyMessage({ taskId = "", file = "" } = {}) {
  return {
    source: VIEWER_SOURCE,
    version: PROTOCOL_VERSION,
    type: TYPE_READY,
    taskId: String(taskId || ""),
    file: String(file || "")
  };
}

// matched/total/unknown is the debugging lifeline: the most common integration
// failure is "9 of 10 faces lit, why?" — without the receipt that is untraceable.
export function buildHighlightResultMessage({
  requestId = "",
  ok = true,
  matched = 0,
  total = 0,
  unknown = [],
  error = ""
} = {}) {
  return {
    source: VIEWER_SOURCE,
    version: PROTOCOL_VERSION,
    type: TYPE_HIGHLIGHT_RESULT,
    requestId: String(requestId || ""),
    ok: Boolean(ok),
    matched: Number(matched) || 0,
    total: Number(total) || 0,
    unknown: (Array.isArray(unknown) ? unknown : []).map(Number),
    error: String(error || "")
  };
}
