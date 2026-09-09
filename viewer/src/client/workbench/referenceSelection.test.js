import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildNormalizedReferenceState,
  buildReferenceCacheKey,
  computeNextSelectionIds,
  normalizeReferenceList,
  orderedStringListEqual,
  parseAssemblyPartReferenceSelectionId,
  resolveTopologyRelativeFile,
  selectRequestedAssemblyComponents,
  uniqueStringList
} from "./referenceSelection.js";

const STEP_ENTRY = {
  file: "models/assy.step",
  kind: "part",
  url: "/models/.assy.step.glb",
  hash: "selector-hash",
  bytes: 42
};

function selectorBundle() {
  return {
    manifest: {
      cadRef: "models/assy",
      tables: {
        occurrenceColumns: ["id", "path", "name", "sourceName", "parentId", "transform", "bbox", "shapeStart", "shapeCount", "faceStart", "faceCount", "edgeStart", "edgeCount"],
        shapeColumns: ["id", "occurrenceId", "ordinal", "kind", "bbox", "center", "area", "volume", "faceStart", "faceCount", "edgeStart", "edgeCount"],
        faceColumns: ["id", "occurrenceId", "shapeId", "ordinal", "surfaceType", "area", "center", "normal", "bbox", "edgeStart", "edgeCount", "relevance", "flags", "params", "triangleStart", "triangleCount"],
        edgeColumns: ["id", "occurrenceId", "shapeId", "ordinal", "curveType", "length", "center", "bbox", "faceStart", "faceCount", "relevance", "flags", "params", "segmentStart", "segmentCount"]
      },
      occurrences: [
        ["o1", "1", "Root", null, null, null, null, 0, 1, 0, 1, 0, 1]
      ],
      shapes: [
        ["o1.s1", "o1", 1, "solid", null, [0, 0, 0], 1, 1, 0, 1, 0, 1]
      ],
      faces: [
        ["o1.f1", "o1", "o1.s1", 1, "plane", 4, [0, 0, 0], [0, 0, 1], null, 0, 0, 0, 0, {}, 0, 0]
      ],
      edges: [
        ["o1.e1", "o1", "o1.s1", 1, "line", 2, [1, 0, 0], null, 0, 1, 0, 0, {}, 0, 0]
      ]
    },
    buffers: {}
  };
}

test("reference state normalization trims reference metadata and preserves cache keys", () => {
  assert.deepEqual(normalizeReferenceList([
    { id: " f1 ", label: "  Face 1  ", summary: "", copyText: "#f1", partId: "p1", entityType: "face" },
    { id: "", label: "Empty id" },
    { id: "e1", label: "Edge 1", shortSummary: "edge", copyText: " #e1 ", partId: "", selectorType: "edge" },
    null
  ]), [
    { id: "f1", label: "Face 1", summary: "", shortSummary: "", copyText: "#f1", partId: "p1", entityType: "face", selectorType: "", normalizedSelector: "", displaySelector: "" },
    { id: "e1", label: "Edge 1", summary: "edge", shortSummary: "edge", copyText: "#e1", partId: "", entityType: "", selectorType: "edge", normalizedSelector: "", displaySelector: "" }
  ]);

  const referenceState = buildNormalizedReferenceState(STEP_ENTRY, selectorBundle(), {});
  assert.equal(buildReferenceCacheKey(STEP_ENTRY), "models/assy.step:selector-hash");
  assert.equal(referenceState.fileRef, "models/assy.step");
  assert.equal(referenceState.referenceHash, "models/assy.step:selector-hash");
  assert.equal(referenceState.stepHash, "selector-hash");
  assert.deepEqual(referenceState.counts, { faces: 1, edges: 1 });
  assert.deepEqual(
    referenceState.references.map((reference) => reference.id),
    ["o1", "s1", "f1", "e1"]
  );
});

test("selection utility helpers preserve list and topology path behavior", () => {
  assert.deepEqual(parseAssemblyPartReferenceSelectionId("assembly-part:part-a"), { partId: "part-a" });
  assert.deepEqual(parseAssemblyPartReferenceSelectionId("topology|part-b|face|f1"), { partId: "part-b" });
  assert.equal(parseAssemblyPartReferenceSelectionId("f1"), null);

  assert.equal(orderedStringListEqual(["a", "b"], ["a", "b"]), true);
  assert.equal(orderedStringListEqual(["a", "b"], ["b", "a"]), false);
  assert.deepEqual(uniqueStringList([" a ", "", "b", "a", " b "]), ["a", "b"]);
  assert.deepEqual(computeNextSelectionIds(["a"], "a"), []);
  assert.deepEqual(computeNextSelectionIds(["a"], "b"), ["b"]);
  assert.deepEqual(computeNextSelectionIds(["a"], "b", { multiSelect: true }), ["a", "b"]);
  assert.deepEqual(computeNextSelectionIds(["a", "b"], "a", { multiSelect: true }), ["b"]);

  assert.equal(
    resolveTopologyRelativeFile({ file: "models/assy.step" }, "../parts/part.step"),
    "models/parts/part.step"
  );
});

test("selectRequestedAssemblyComponents loads only the expanded occurrences' components", () => {
  const descriptor = {
    kind: "assembly-package",
    components: { cidA: { glb: "a.glb" }, cidB: { glb: "b.glb" }, cidC: { glb: "c.glb" } },
    occurrences: [
      { id: "o1", name: "root" }, // subassembly: no component
      { id: "o1.1", component: "cidA" },
      { id: "o1.2", component: "cidB" },
      { id: "o1.3", component: "cidA" } // shares cidA with o1.1
    ]
  };

  // Expanding ONE leaf node loads only that occurrence's component — not the whole assembly.
  const one = selectRequestedAssemblyComponents(descriptor, ["o1.2"]);
  assert.deepEqual(one.occurrencesToLoad.map((occ) => occ.id), ["o1.2"]);
  assert.deepEqual(one.neededCids, ["cidB"]);
  assert.equal(one.loadedTopologyKey, "o1.2");

  // Expanding a subassembly node loads that node's children AND de-dupes shared cids.
  const sub = selectRequestedAssemblyComponents(descriptor, ["o1", "o1.1", "o1.3"]);
  assert.deepEqual(sub.occurrencesToLoad.map((occ) => occ.id), ["o1", "o1.1", "o1.3"]);
  assert.deepEqual(sub.neededCids, ["cidA"]);
  assert.equal(sub.loadedTopologyKey, "o1|o1.1|o1.3");

  // A single-component part loads every occurrence regardless of the requested set.
  const single = selectRequestedAssemblyComponents(descriptor, ["o1.2"], { singleComponentPart: true });
  assert.deepEqual(single.occurrencesToLoad.map((occ) => occ.id), ["o1", "o1.1", "o1.2", "o1.3"]);
  assert.deepEqual(single.neededCids, ["cidA", "cidB"]);
  assert.equal(single.loadedTopologyKey, "*");
});
