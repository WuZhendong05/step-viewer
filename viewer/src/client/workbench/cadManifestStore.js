const CAD_CATALOG_REFRESH_INTERVAL_MS = 2_000;
const CAD_CATALOG_FETCH_TIMEOUT_MS = 10_000;
const CAD_DIR_QUERY_PARAM = "dir";
const CAD_FILE_QUERY_PARAM = "file";
const CAD_TASK_QUERY_PARAM = "task";

// Task mode: an opaque ?task=<taskId> share URL. The resolved absolute directory
// lives ONLY here (in-memory) and is fed to /__cad/* as ?dir= — it is never written
// back to the address bar, history, or shared links.
let _taskDir = "";
let _taskResolvePromise = null;

function normalizeCadManifest(manifest) {
  if (!manifest || typeof manifest !== "object") {
    return {
      schemaVersion: 4,
      entries: [],
    };
  }

  return {
    schemaVersion: 4,
    entries: Array.isArray(manifest.entries) ? manifest.entries : [],
  };
}

const listeners = new Set();
let currentManifestSignature = "";
let currentSnapshot = {
  manifest: normalizeCadManifest(),
  revision: 0,
  catalogHydrated: false,
  catalogRefreshing: typeof window !== "undefined",
  catalogError: "",
  activeDir: "",
};
let refreshRequestId = 0;
let refreshInFlight = null;
let refreshLoopStarted = false;

currentManifestSignature = JSON.stringify(currentSnapshot.manifest);

function publishCadManifest(nextManifest, { hydrated = true, refreshing = false, error = "", activeDir = currentSnapshot.activeDir } = {}) {
  const manifest = normalizeCadManifest(nextManifest);
  const manifestSignature = JSON.stringify(manifest);
  const manifestChanged = manifestSignature !== currentManifestSignature;
  const nextSnapshot = {
    manifest: manifestChanged ? manifest : currentSnapshot.manifest,
    revision: currentSnapshot.revision + 1,
    catalogHydrated: hydrated,
    catalogRefreshing: refreshing,
    catalogError: error,
    activeDir,
  };
  if (
    !manifestChanged &&
    nextSnapshot.catalogHydrated === currentSnapshot.catalogHydrated &&
    nextSnapshot.catalogRefreshing === currentSnapshot.catalogRefreshing &&
    nextSnapshot.catalogError === currentSnapshot.catalogError &&
    nextSnapshot.activeDir === currentSnapshot.activeDir
  ) {
    return;
  }
  if (manifestChanged) {
    currentManifestSignature = manifestSignature;
  }
  currentSnapshot = {
    ...nextSnapshot,
  };
  for (const listener of listeners) {
    listener();
  }
}

function publishCadRefreshState({ refreshing = currentSnapshot.catalogRefreshing, error = currentSnapshot.catalogError, activeDir = currentSnapshot.activeDir } = {}) {
  if (
    refreshing === currentSnapshot.catalogRefreshing &&
    error === currentSnapshot.catalogError &&
    activeDir === currentSnapshot.activeDir
  ) {
    return;
  }
  currentSnapshot = {
    ...currentSnapshot,
    revision: currentSnapshot.revision + 1,
    catalogRefreshing: refreshing,
    catalogError: error,
    activeDir,
  };
  for (const listener of listeners) {
    listener();
  }
}

function readSearchParam(name) {
  if (typeof window === "undefined") {
    return "";
  }
  try {
    return String(new URL(window.location.href).searchParams.get(name) || "").trim();
  } catch {
    return "";
  }
}

/** The opaque taskId of the current page, or "" when not in task mode. */
export function readActiveTask() {
  return readSearchParam(CAD_TASK_QUERY_PARAM);
}

/**
 * Resolve ?task=<taskId> to its absolute uploads directory via the constrained
 * server resolver (/__cad/resolve). The result is cached in memory ONLY — never
 * in the URL. Resolves to "" when there is no task.
 */
export async function ensureTaskResolved() {
  const task = readActiveTask();
  if (!task) {
    return "";
  }
  if (_taskDir) {
    return _taskDir;
  }
  if (_taskResolvePromise) {
    return _taskResolvePromise;
  }
  _taskResolvePromise = (async () => {
    const url = `/__cad/resolve?${new URLSearchParams({ task }).toString()}`;
    const response = await fetchWithTimeout(
      url,
      { cache: "no-store" },
      CAD_CATALOG_FETCH_TIMEOUT_MS,
      "Timed out resolving task"
    );
    if (!response.ok) {
      throw new Error(await readJsonError(response, `Failed to resolve task ${response.status}`));
    }
    const payload = await response.json();
    _taskDir = String(payload?.dir || "").trim();
    return _taskDir;
  })().finally(() => {
    _taskResolvePromise = null;
  });
  return _taskResolvePromise;
}

/**
 * The directory the page is showing: the URL's PATH, exactly as in a file:// URL.
 *
 * `http://127.0.0.1:3245/Users/me/models` opens `/Users/me/models`. The bare origin
 * names no directory and returns "", which the backend reads as its cwd.
 *
 * The URL is the only source of truth — there is deliberately no stored fallback.
 * A dir that persisted in sessionStorage used to make the same URL render different
 * models depending on what you had opened before.
 */
export function readActiveCadDir() {
  if (typeof window === "undefined") {
    return "";
  }
  // Task mode: the directory comes from the in-memory resolver cache, never from
  // the URL (the URL only carries the opaque taskId). Empty until resolved.
  if (readActiveTask()) {
    return _taskDir;
  }
  let pathname = "";
  try {
    pathname = new URL(window.location.href).pathname;
  } catch {
    return "";
  }
  let decoded = pathname;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    // A malformed escape leaves the raw path; the backend rejects it with a clear error.
  }
  const trimmed = String(decoded || "").replace(/\/+$/, "");
  return trimmed === "" || trimmed === "/" ? "" : trimmed;
}

function cadApiUrl(path, {
  activeDir = readActiveCadDir(),
  includeFile = false,
  params = {},
} = {}) {
  const url = new URL(path, "http://cad.local");
  const task = readActiveTask();
  if (task) {
    // Task mode: drive reads by the opaque taskId (server resolves the dir);
    // the absolute dir is never placed on the wire either.
    url.searchParams.set(CAD_TASK_QUERY_PARAM, task);
  } else if (activeDir) {
    url.searchParams.set(CAD_DIR_QUERY_PARAM, activeDir);
  }
  if (includeFile) {
    const file = readSearchParam(CAD_FILE_QUERY_PARAM);
    if (file) {
      url.searchParams.set(CAD_FILE_QUERY_PARAM, file);
    }
  }
  for (const [key, value] of Object.entries(params)) {
    const text = String(value ?? "").trim();
    if (text) {
      url.searchParams.set(key, text);
    }
  }
  return `${url.pathname}${url.search}`;
}

async function readJsonError(response, fallback) {
  try {
    const payload = await response.json();
    const error = String(
      payload?.error ||
      payload?.result?.error ||
      payload?.result?.validation?.error?.message ||
      fallback
    ).trim();
    return error || fallback;
  } catch {
    return fallback;
  }
}

async function fetchWithTimeout(url, options, timeoutMs, timeoutMessage) {
  if (typeof AbortController !== "function") {
    return fetch(url, options);
  }
  const controller = new AbortController();
  const timeoutId = setTimeout(() => {
    controller.abort();
  }, timeoutMs);
  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal,
    });
  } catch (error) {
    if (error?.name === "AbortError") {
      throw new Error(timeoutMessage);
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}

export async function refreshCadCatalog({ markRefreshing = !currentSnapshot.catalogHydrated } = {}) {
  if (typeof window === "undefined") {
    return;
  }
  if (refreshInFlight) {
    return refreshInFlight;
  }
  const requestId = ++refreshRequestId;
  const activeDir = readActiveCadDir();
  if (markRefreshing) {
    publishCadRefreshState({ refreshing: true, error: "", activeDir });
  }
  refreshInFlight = (async () => {
    try {
      const response = await fetchWithTimeout(
        cadApiUrl("/__cad/catalog", { activeDir, includeFile: true }),
        { cache: "no-store" },
        CAD_CATALOG_FETCH_TIMEOUT_MS,
        `Timed out loading CAD catalog after ${CAD_CATALOG_FETCH_TIMEOUT_MS / 1000}s`
      );
      if (!response.ok) {
        throw new Error(await readJsonError(
          response,
          `Failed to read CAD catalog: ${response.status} ${response.statusText}`
        ));
      }
      const catalog = await response.json();
      if (requestId === refreshRequestId) {
        publishCadManifest(catalog, { hydrated: true, refreshing: false, error: "", activeDir });
      }
    } catch (error) {
      if (requestId === refreshRequestId) {
        publishCadManifest(currentSnapshot.manifest, {
          hydrated: true,
          refreshing: false,
          error: error instanceof Error ? error.message : String(error),
          activeDir,
        });
      }
      throw error;
    } finally {
      if (requestId === refreshRequestId) {
        refreshInFlight = null;
      }
    }
  })();
  return refreshInFlight;
}

// Unified render-artifact client API. GET reports freshness ({ state: "ready" | "needs-build" |
// "error", ... }); a direct-render entry is always "ready". (Replaced the STEP-specific
// requestStepSourceStatus + requestStepArtifactGeneration.)
export async function requestArtifactStatus(fileRef, { signal } = {}) {
  if (typeof window === "undefined") {
    return null;
  }
  const normalizedFileRef = String(fileRef || "").trim();
  if (!normalizedFileRef) {
    throw new Error("Missing file");
  }
  const response = await fetch(cadApiUrl("/__cad/artifact", {
    params: { file: normalizedFileRef },
  }), {
    method: "GET",
    cache: "no-store",
    signal,
  });
  if (!response.ok) {
    throw new Error(await readJsonError(
      response,
      `Failed to check render artifact: ${response.status} ${response.statusText}`
    ));
  }
  return response.json();
}

// POST (re)builds the artifact and publishes the refreshed catalog; resolves to
// { ok, state: "ready" | "error", ... }.
export async function requestArtifact(fileRef, { force = false, signal } = {}) {
  if (typeof window === "undefined") {
    return null;
  }
  const normalizedFileRef = String(fileRef || "").trim();
  if (!normalizedFileRef) {
    throw new Error("Missing file");
  }
  const response = await fetch(cadApiUrl("/__cad/artifact", {
    params: { file: normalizedFileRef, ...(force ? { force: "1" } : {}) },
  }), {
    method: "POST",
    cache: "no-store",
    signal,
  });
  if (!response.ok) {
    throw new Error(await readJsonError(
      response,
      `Failed to generate render artifact: ${response.status} ${response.statusText}`
    ));
  }
  const payload = await response.json();
  if (payload?.catalog) {
    publishCadManifest(payload.catalog);
  }
  return payload;
}

export function getCadManifestSnapshot() {
  return currentSnapshot;
}

export function subscribeCadManifest(listener) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

if (import.meta.hot) {
  import.meta.hot.on("cad-catalog:changed", (data = {}) => {
    const changedDir = String(data?.dir || "").trim();
    const activeDir = readActiveCadDir();
    if (changedDir && activeDir && changedDir !== activeDir) {
      return;
    }
    refreshCadCatalog().catch((error) => {
      console.warn("Failed to refresh CAD catalog", error);
    });
  });
}

if (typeof window !== "undefined") {
  const refreshSilently = () => {
    refreshCadCatalog({ markRefreshing: false }).catch((error) => {
      if (import.meta.env.DEV) {
        console.warn("Failed to refresh CAD catalog", error);
      }
    });
  };

  // Resolve ?task= to its in-memory dir before the first catalog load (task mode).
  ensureTaskResolved()
    .catch((error) => {
      if (import.meta.env.DEV) {
        console.warn("Failed to resolve CAD task", error);
      }
    })
    .finally(() => {
      refreshCadCatalog().catch((error) => {
        if (import.meta.env.DEV) {
          console.warn("Failed to refresh CAD catalog", error);
        }
      });
    });

  if (!refreshLoopStarted) {
    refreshLoopStarted = true;
    window.setInterval(() => {
      if (document.visibilityState !== "hidden") {
        refreshSilently();
      }
    }, CAD_CATALOG_REFRESH_INTERVAL_MS);
    window.addEventListener("focus", refreshSilently);
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState !== "hidden") {
        refreshSilently();
      }
    });
  }
}
