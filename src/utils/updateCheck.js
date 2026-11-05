/**
 * App update check.
 *
 * Compares the bundled app version (`__APP_VERSION__`, injected by Vite from
 * package.json) against the version published on the GitHub default branch.
 * The canonical source is raw.githubusercontent.com with the jsDelivr CDN as
 * a fallback (raw.githubusercontent is sometimes unreachable, jsDelivr caches
 * for a while — both are fine for a "newer release exists" signal).
 *
 * The module keeps a tiny store with subscriptions so the main-toolbar
 * settings button and the Settings → About tab can both render the badge
 * without prop drilling. Results are cached in localStorage and re-checked at
 * most twice a day (manual checks can force through).
 */

const GITHUB_REPO = 'backsapce/CherryAgent';

export const GITHUB_URL = `https://github.com/${GITHUB_REPO}`;

const VERSION_SOURCES = [
  `https://raw.githubusercontent.com/${GITHUB_REPO}/main/package.json`,
  `https://cdn.jsdelivr.net/gh/${GITHUB_REPO}@main/package.json`,
];

const STORAGE_KEY = 'cherry-agent-update-check';
const CHECK_INTERVAL_MS = 12 * 60 * 60 * 1000; // at most twice a day
const FETCH_TIMEOUT_MS = 8000;

// Dev/test fallback: `__APP_VERSION__` only exists in Vite builds.
export const APP_VERSION = typeof __APP_VERSION__ === 'undefined'
  ? '0.0.0-dev'
  : __APP_VERSION__;

const listeners = new Set();

let state = {
  status: 'idle', // 'idle' | 'checking' | 'checked' | 'error'
  currentVersion: APP_VERSION,
  latestVersion: null,
  checkedAtMs: null,
  error: null,
};

function readCachedResult() {
  try {
    const raw = typeof localStorage === 'undefined' ? null : localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    const latestVersion = parseVersion(parsed.latestVersion)
      ? String(parsed.latestVersion).trim()
      : null;
    if (!latestVersion) return null;
    const checkedAtMs = Number(parsed.checkedAtMs);
    return {
      latestVersion,
      checkedAtMs: Number.isFinite(checkedAtMs) ? checkedAtMs : null,
    };
  } catch {
    return null;
  }
}

function persistResult(latestVersion, checkedAtMs) {
  try {
    if (typeof localStorage === 'undefined') return;
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ latestVersion, checkedAtMs }));
  } catch {
    // Private-browsing quota errors are irrelevant to the check itself.
  }
}

function setState(patch) {
  state = { ...state, ...patch };
  for (const listener of listeners) {
    try {
      listener(getUpdateStatus());
    } catch (err) {
      console.warn('update-check listener failed:', err);
    }
  }
}

export function parseVersion(version) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(String(version || '').trim());
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

export function compareVersions(a, b) {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa || !pb) return 0;
  for (let i = 0; i < 3; i += 1) {
    if (pa[i] !== pb[i]) return pa[i] > pb[i] ? 1 : -1;
  }
  return 0;
}

export function isNewerVersion(candidate, current) {
  return compareVersions(candidate, current) > 0;
}

export function extractVersionFromPackageJson(pkg) {
  if (!pkg || typeof pkg !== 'object') return null;
  const version = pkg.version;
  return parseVersion(version) ? String(version).trim() : null;
}

export function getUpdateStatus() {
  return {
    ...state,
    updateAvailable: Boolean(
      state.latestVersion && isNewerVersion(state.latestVersion, state.currentVersion),
    ),
  };
}

export function subscribeUpdateStatus(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

async function fetchLatestVersion(fetchImpl) {
  let lastError = null;
  for (const url of VERSION_SOURCES) {
    const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timer = controller
      ? setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
      : null;
    try {
      const response = await fetchImpl(url, {
        cache: 'no-store',
        ...(controller ? { signal: controller.signal } : {}),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const pkg = await response.json();
      const version = extractVersionFromPackageJson(pkg);
      if (!version) throw new Error('No version in package.json');
      return version;
    } catch (err) {
      lastError = err;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
  throw lastError || new Error('Update check failed');
}

/**
 * Run (or replay a cached) update check. Non-forced calls are rate limited to
 * CHECK_INTERVAL_MS; an in-flight check is shared, not duplicated.
 */
export async function checkForUpdates({
  force = false,
  fetchImpl,
  now = () => Date.now(),
} = {}) {
  const doFetch = fetchImpl || (typeof fetch === 'undefined'
    ? async () => { throw new Error('fetch unavailable'); }
    : fetch);

  if (state.status === 'checking') return getUpdateStatus();

  const cached = state.status === 'checked' ? state : readCachedResult();
  if (cached) {
    const checkedAt = cached.checkedAtMs;
    const fresh = typeof checkedAt === 'number'
      && now() - checkedAt < CHECK_INTERVAL_MS;
    if (!force && fresh && cached.latestVersion) {
      setState({
        status: 'checked',
        latestVersion: cached.latestVersion,
        checkedAtMs: checkedAt,
        error: null,
      });
      return getUpdateStatus();
    }
  }

  if (!force && state.lastFailedAtMs && now() - state.lastFailedAtMs < 5 * 60 * 1000) {
    return getUpdateStatus();
  }

  setState({ status: 'checking', error: null });
  try {
    const latestVersion = await fetchLatestVersion(doFetch);
    const checkedAtMs = now();
    persistResult(latestVersion, checkedAtMs);
    setState({
      status: 'checked',
      latestVersion,
      checkedAtMs,
      error: null,
      lastFailedAtMs: 0,
    });
  } catch (err) {
    setState({
      status: 'error',
      error: err?.message || String(err),
      lastFailedAtMs: now(),
    });
  }
  return getUpdateStatus();
}

// Hydrate from the cache on load so a previously-found update reappears
// without waiting for the network.
(function hydrateFromCache() {
  const cached = readCachedResult();
  if (cached) {
    state = { ...state, latestVersion: cached.latestVersion, checkedAtMs: cached.checkedAtMs };
  }
})();
