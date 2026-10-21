// Unit tests for the external face-highlight protocol (workbench/externalHighlight.js).
// The module is dependency-free on purpose so these run under plain `node --test`
// — the component wiring (CadWorkspace) cannot be unit-tested in this tree
// because the runner does not transpile JSX.
import test from "node:test";
import assert from "node:assert/strict";

import {
  HOST_SOURCE,
  VIEWER_SOURCE,
  PROTOCOL_VERSION,
  MAX_ENTITY_IDS,
  TYPE_READY,
  TYPE_HIGHLIGHT_FACES,
  TYPE_HIGHLIGHT_RESULT,
  normaliseEntityIds,
  isExternalHostMessage,
  parseExternalHighlightMessage,
  buildReadyMessage,
  buildHighlightResultMessage
} from "./externalHighlight.js";

test("normaliseEntityIds flattens nested arrays and drops junk", () => {
  assert.deepEqual(normaliseEntityIds([1111, [1112, [1113]], "1114"]), [1111, 1112, 1113, 1114]);
});

test("normaliseEntityIds keeps only positive finite numbers", () => {
  assert.deepEqual(normaliseEntityIds([1111, 0, -5, NaN, Infinity, null, undefined, "", "abc"]), [1111]);
});

test("normaliseEntityIds dedupes", () => {
  assert.deepEqual(normaliseEntityIds([1111, 1111, "1111", [1111]]), [1111]);
});

test("normaliseEntityIds caps the payload", () => {
  const ids = normaliseEntityIds(Array.from({ length: MAX_ENTITY_IDS + 100 }, (_, i) => i + 1));
  assert.equal(ids.length, MAX_ENTITY_IDS);
});

test("normaliseEntityIds of an empty array is an empty array (clear request)", () => {
  assert.deepEqual(normaliseEntityIds([]), []);
});

test("isExternalHostMessage accepts only frames tagged with our source and version", () => {
  assert.equal(isExternalHostMessage({ source: HOST_SOURCE, version: 1, type: TYPE_HIGHLIGHT_FACES }), true);
  assert.equal(isExternalHostMessage({ source: HOST_SOURCE, version: 2, type: TYPE_HIGHLIGHT_FACES }), false);
  assert.equal(isExternalHostMessage({ source: "someone-else", version: 1, type: TYPE_HIGHLIGHT_FACES }), false);
  assert.equal(isExternalHostMessage({ source: VIEWER_SOURCE, version: 1, type: TYPE_HIGHLIGHT_FACES }), false,
    "our own outbound frames must not be re-ingested");
  assert.equal(isExternalHostMessage(null), false);
  assert.equal(isExternalHostMessage("highlightFaces"), false);
  assert.equal(isExternalHostMessage({ source: HOST_SOURCE, version: 1 }), false);
});

test("parseExternalHighlightMessage rejects foreign frames", () => {
  assert.equal(parseExternalHighlightMessage({ nope: true }).ok, false);
  assert.equal(parseExternalHighlightMessage({ source: HOST_SOURCE, version: 1, type: "hover" }).ok, false);
  assert.match(parseExternalHighlightMessage({ source: HOST_SOURCE, version: 1, type: "hover" }).error, /unsupported type/);
});

test("parseExternalHighlightMessage requires entityIds to be an array", () => {
  const parsed = parseExternalHighlightMessage({ source: HOST_SOURCE, version: 1, type: TYPE_HIGHLIGHT_FACES, entityIds: 1111 });
  assert.equal(parsed.ok, false);
  assert.match(parsed.error, /array/);
});

test("parseExternalHighlightMessage keeps the requestId and normalises ids", () => {
  const parsed = parseExternalHighlightMessage({
    source: HOST_SOURCE,
    version: 1,
    type: TYPE_HIGHLIGHT_FACES,
    entityIds: [1111, 0, [1112, "1112"]],
    requestId: "r7"
  });
  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.entityIds, [1111, 1112]);
  assert.equal(parsed.requestId, "r7");
});

test("parseExternalHighlightMessage: an empty array is a valid clear request", () => {
  const parsed = parseExternalHighlightMessage({ source: HOST_SOURCE, version: 1, type: TYPE_HIGHLIGHT_FACES, entityIds: [] });
  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.entityIds, []);
});

test("buildReadyMessage carries the protocol stamp and the current part identity", () => {
  assert.deepEqual(buildReadyMessage({ taskId: "20261015_151517_1d70a7", file: "JTZH.01.01-03.step" }), {
    source: VIEWER_SOURCE,
    version: PROTOCOL_VERSION,
    type: TYPE_READY,
    taskId: "20261015_151517_1d70a7",
    file: "JTZH.01.01-03.step"
  });
  assert.deepEqual(buildReadyMessage(), { source: VIEWER_SOURCE, version: PROTOCOL_VERSION, type: TYPE_READY, taskId: "", file: "" });
});

test("buildHighlightResultMessage reports matched/total/unknown for debugging", () => {
  assert.deepEqual(buildHighlightResultMessage({ requestId: "r3", matched: 2, total: 3, unknown: [9999] }), {
    source: VIEWER_SOURCE,
    version: PROTOCOL_VERSION,
    type: TYPE_HIGHLIGHT_RESULT,
    requestId: "r3",
    ok: true,
    matched: 2,
    total: 3,
    unknown: [9999],
    error: ""
  });
});

test("buildHighlightResultMessage: a failed lookup still carries a shape the host can render", () => {
  const message = buildHighlightResultMessage({ requestId: "r9", ok: false, error: "task_mismatch" });
  assert.equal(message.ok, false);
  assert.equal(message.matched, 0);
  assert.equal(message.error, "task_mismatch");
  assert.deepEqual(message.unknown, []);
});
