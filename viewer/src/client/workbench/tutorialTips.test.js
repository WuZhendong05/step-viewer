import assert from "node:assert/strict";
import test from "node:test";

import {
  markTutorialTipSeen,
  readSeenTutorialTipIds,
  resetTutorialTips,
  TUTORIAL_TIP_STORAGE_KEY,
  TUTORIAL_TIP_STORAGE_VERSION,
  tutorialTipSeen
} from "./persistence.js";

function createMemoryStorage() {
  const values = new Map();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => {
      values.set(key, String(value));
    },
    removeItem: (key) => {
      values.delete(key);
    }
  };
}

test("a tip is unseen until it is marked, then stays seen", () => {
  const storage = createMemoryStorage();
  assert.equal(tutorialTipSeen("copyReference", { storage }), false);

  markTutorialTipSeen("copyReference", { storage });
  assert.equal(tutorialTipSeen("copyReference", { storage }), true);
  assert.deepEqual(readSeenTutorialTipIds({ storage }), ["copyReference"]);
});

test("marking the same tip twice does not duplicate it", () => {
  const storage = createMemoryStorage();
  markTutorialTipSeen("copyReference", { storage });
  markTutorialTipSeen("copyReference", { storage });
  assert.deepEqual(readSeenTutorialTipIds({ storage }), ["copyReference"]);
});

test("tips are tracked independently", () => {
  const storage = createMemoryStorage();
  markTutorialTipSeen("otherTip", { storage });
  assert.equal(tutorialTipSeen("otherTip", { storage }), true);
  assert.equal(tutorialTipSeen("copyReference", { storage }), false);
});

test("reset clears every seen tip", () => {
  const storage = createMemoryStorage();
  markTutorialTipSeen("copyReference", { storage });
  markTutorialTipSeen("otherTip", { storage });

  resetTutorialTips({ storage });
  assert.deepEqual(readSeenTutorialTipIds({ storage }), []);
  assert.equal(tutorialTipSeen("copyReference", { storage }), false);
});

test("a stored payload from another schema version re-arms the tips", () => {
  const storage = createMemoryStorage();
  storage.setItem(TUTORIAL_TIP_STORAGE_KEY, JSON.stringify({
    version: TUTORIAL_TIP_STORAGE_VERSION + 1,
    seen: ["copyReference"]
  }));
  assert.deepEqual(readSeenTutorialTipIds({ storage }), []);
});

test("unreadable storage reads as unseen rather than throwing", () => {
  const storage = {
    getItem: () => "{not json",
    setItem: () => {},
    removeItem: () => {}
  };
  assert.deepEqual(readSeenTutorialTipIds({ storage }), []);
  assert.equal(tutorialTipSeen("copyReference", { storage }), false);
});

test("an empty tip id is never seen and is never recorded", () => {
  const storage = createMemoryStorage();
  assert.equal(markTutorialTipSeen("", { storage }), false);
  assert.equal(tutorialTipSeen("", { storage }), false);
  assert.deepEqual(readSeenTutorialTipIds({ storage }), []);
});
