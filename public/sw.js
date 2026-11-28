/**
 * Service Worker for Cherry Agent — offline-first caching.
 *
 * Strategy:
 *   - Precache the app shell (index.html, JS, CSS, icons) on install.
 *   - Use cache-first for static assets, network-first for navigations.
 *   - This deployment's resources are opportunistically cached for offline use.
 */

const CACHE_VERSION = 'v1'; // replaced at build time
const BASE = new URL(self.registration.scope).pathname;
const CACHE_PREFIX = `cherry-agent:${encodeURIComponent(BASE)}:`;
const CACHE_NAME = CACHE_PREFIX + CACHE_VERSION;
const INDEX_PATH = BASE + 'index.html';
const INDEX_URL = self.location.origin + INDEX_PATH;
const DEV_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
const IS_DEV_HOST = DEV_HOSTS.has(self.location.hostname);

// App shell files to precache — use absolute URLs so they resolve correctly
// regardless of where the SW is registered (dev vs GH Pages).
const APP_SHELL = [
  self.location.origin + BASE,
  INDEX_URL,
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

function matchCached(request) {
  return caches.match(request, { cacheName: CACHE_NAME });
}

async function networkFirst(request, fallback) {
  try {
    return cacheResponse(request, await fetch(request));
  } catch (error) {
    const cached = await matchCached(request) || (fallback && await matchCached(fallback));
    if (cached) return cached;
    throw error;
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
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((key) => key.startsWith(CACHE_PREFIX) && key !== CACHE_NAME)
      .map((key) => caches.delete(key)));
    await self.clients.claim();
  })());
});

// ── Fetch: cache-first for assets, network-first for navigations ────────────
self.addEventListener('fetch', (event) => {
  const { request } = event;

  // Skip non-GET requests and cross-origin requests (e.g. LLM API calls)
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin || !url.pathname.startsWith(BASE)) return;

  const navigation = request.mode === 'navigate';
  // A parent worker must not serve its shell for a child deployment's page.
  if (navigation && url.pathname !== BASE && url.pathname !== INDEX_PATH) return;
  // Keep Vite modules fresh during local development.
  if (IS_DEV_HOST || navigation) {
    event.respondWith(networkFirst(request, navigation ? INDEX_URL : null));
    return;
  }

  event.respondWith(
    matchCached(request).then((cached) => {
      if (cached) return cached;
      return fetch(request).then((response) => cacheResponse(request, response));
    })
  );
});
