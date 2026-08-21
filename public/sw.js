/**
 * Service Worker for Cherry Agent — offline-first caching.
 *
 * Strategy:
 *   - Precache the app shell (index.html, JS, CSS, icons) on install.
 *   - Use cache-first for static assets, network-first for navigations.
 *   - All fetched resources are opportunistically cached for offline use.
 */

const CACHE_NAME = 'cherry-agent-v1';
const BASE = '/';  // replaced at build time with GH_PAGES_BASE (e.g. '/CherryAgent/')
const DEV_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
const IS_DEV_HOST = DEV_HOSTS.has(self.location.hostname);

// App shell files to precache — use absolute URLs so they resolve correctly
// regardless of where the SW is registered (dev vs GH Pages).
const APP_SHELL = [
  self.location.origin + BASE,
  self.location.origin + BASE + 'index.html',
  self.location.origin + BASE + 'favicon.svg',
  self.location.origin + BASE + 'manifest.json',
];

async function cacheResponse(request, response) {
  if (!response || !response.ok) return response;

  const clone = response.clone();
  try {
    const cache = await caches.open(CACHE_NAME);
    await cache.put(request, clone);
  } catch (err) {
    console.warn('[SW] cache put failed:', request.url, err);
  }

  return response;
}

async function matchCachedIndex() {
  const cached = await caches.match(self.location.origin + BASE + 'index.html');
  if (cached) return cached;

  // Last resort: find any cached entry ending with index.html
  for (const key of await caches.keys()) {
    const cache = await caches.open(key);
    const entries = await cache.keys();
    for (const entry of entries) {
      if (entry.url.endsWith('index.html')) {
        return cache.match(entry);
      }
    }
  }

  return undefined;
}

async function networkFirst(request) {
  try {
    const response = await fetch(request);
    return cacheResponse(request, response);
  } catch {
    return caches.match(request);
  }
}

// ── Install: precache app shell (non-atomic — skip failures so partial
//    offline still works instead of caching nothing at all) ──────────────────
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(async (cache) => {
      // Cache each file individually; log failures but keep going
      for (const url of APP_SHELL) {
        try {
          await cache.add(url);
        } catch (err) {
          console.warn('[SW] precache failed:', url, err);
        }
      }
    })
  );
  // Activate immediately without waiting for old SW to retire
  self.skipWaiting();
});

// ── Activate: clean up old caches ───────────────────────────────────────────
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))
      )
    )
  );
  // Start controlling all clients immediately
  self.clients.claim();
});

// ── Fetch: cache-first for assets, network-first for navigations ────────────
self.addEventListener('fetch', (event) => {
  const { request } = event;

  // Skip non-GET requests and cross-origin requests (e.g. LLM API calls)
  if (request.method !== 'GET') return;

  // Let LLM API / agent calls pass through without caching
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname === '/agent' || url.pathname.startsWith('/agent/')) return;

  // Vite dev serves source modules and HMR clients as same-origin files.
  // Keep dev fresh with network-first, but fall back to the previous cache
  // so an installed/open PWA can still load after the dev server stops.
  if (IS_DEV_HOST) {
    event.respondWith(
      networkFirst(request).then(async (response) => {
        if (response) return response;
        if (request.mode === 'navigate') return matchCachedIndex();
        return fetch(request);
      })
    );
    return;
  }

  // Navigation requests (HTML pages) — network first, fallback to cached
  // index.html so the SPA loads regardless of the URL path
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((response) => cacheResponse(request, response))
        .catch(async () => {
          return matchCachedIndex();
        })
    );
    return;
  }

  // Static assets — cache first, fallback to network (and cache the response)
  event.respondWith(
    caches.match(request).then((cached) => {
      if (cached) return cached;
      return fetch(request).then((response) => cacheResponse(request, response));
    })
  );
});
