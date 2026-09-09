import assert from "node:assert/strict";
import test from "node:test";

import { readActiveCadDir, readActiveTask, ensureTaskResolved } from "./cadManifestStore.js";

function withWindow(url, callback) {
  const previousWindow = globalThis.window;
  globalThis.window = { location: { href: url } };
  try {
    return callback({
      setHref(nextUrl) {
        globalThis.window.location.href = nextUrl;
      },
    });
  } finally {
    if (previousWindow === undefined) {
      delete globalThis.window;
    } else {
      globalThis.window = previousWindow;
    }
  }
}

test("readActiveCadDir returns the URL path as the directory", () => {
  withWindow("http://viewer.test/tmp/models", () => {
    assert.equal(readActiveCadDir(), "/tmp/models");
  });
});

test("readActiveCadDir ignores the file query param", () => {
  withWindow("http://viewer.test/tmp/models?file=robots/next.step", () => {
    assert.equal(readActiveCadDir(), "/tmp/models");
  });
});

test("readActiveCadDir decodes percent-escaped path segments", () => {
  withWindow("http://viewer.test/tmp/my%20models", () => {
    assert.equal(readActiveCadDir(), "/tmp/my models");
  });
});

test("readActiveCadDir keeps a path containing dots intact", () => {
  // A dotted directory must not be mistaken for a file extension.
  withWindow("http://viewer.test/Users/me/v0.4/models", () => {
    assert.equal(readActiveCadDir(), "/Users/me/v0.4/models");
  });
});

test("readActiveCadDir strips a trailing slash", () => {
  withWindow("http://viewer.test/tmp/models/", () => {
    assert.equal(readActiveCadDir(), "/tmp/models");
  });
});

test("readActiveCadDir treats the bare origin as no directory", () => {
  // "" makes the backend fall back to its cwd.
  withWindow("http://viewer.test/", () => {
    assert.equal(readActiveCadDir(), "");
  });
});

test("readActiveCadDir has no stored fallback — the URL is the only source", () => {
  withWindow("http://viewer.test/tmp/models", ({ setHref }) => {
    assert.equal(readActiveCadDir(), "/tmp/models");

    // Navigating to the bare origin must NOT resurrect the previous directory.
    setHref("http://viewer.test/?file=robot.step");
    assert.equal(readActiveCadDir(), "");
  });
});

test("readActiveCadDir follows the path when it changes", () => {
  withWindow("http://viewer.test/tmp/models", ({ setHref }) => {
    assert.equal(readActiveCadDir(), "/tmp/models");

    setHref("http://viewer.test/tmp/other");
    assert.equal(readActiveCadDir(), "/tmp/other");
  });
});

// --- task mode: opaque ?task= share URLs, dir only in memory ---

test("readActiveTask returns the opaque taskId", () => {
  withWindow("http://viewer.test/?task=20260821_115310_bd87a6&file=part.step", () => {
    assert.equal(readActiveTask(), "20260821_115310_bd87a6");
  });
});

test("readActiveTask is empty outside task mode", () => {
  withWindow("http://viewer.test/tmp/models?file=a.step", () => {
    assert.equal(readActiveTask(), "");
  });
});

test("task mode: readActiveCadDir is empty before resolve and never reads the URL path", () => {
  // The URL only carries the taskId; before the resolver returns, there is no dir.
  withWindow("http://viewer.test/?task=20260821_115310_bd87a6", () => {
    assert.equal(readActiveCadDir(), "");
  });
});

test("ensureTaskResolved caches the dir in memory via /__cad/resolve", async () => {
  const calls = [];
  const previousWindow = globalThis.window;
  const previousFetch = globalThis.fetch;
  globalThis.window = { location: { href: "http://viewer.test/?task=20260821_115310_bd87a6" } };
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    return { ok: true, json: async () => ({ dir: "D:/uploads/20260821_115310_bd87a6" }) };
  };
  try {
    assert.equal(await ensureTaskResolved(), "D:/uploads/20260821_115310_bd87a6");
    assert.equal(readActiveCadDir(), "D:/uploads/20260821_115310_bd87a6");
    assert.equal(calls.length, 1, "resolver should be called once");
    assert.ok(calls[0].includes("/__cad/resolve"), calls[0]);
    assert.ok(calls[0].includes("task=20260821_115310_bd87a6"), calls[0]);
  } finally {
    globalThis.window = previousWindow;
    globalThis.fetch = previousFetch;
  }
});
