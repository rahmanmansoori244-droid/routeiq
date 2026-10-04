/*
 * The driver page's service worker (owner request 4 Oct 2026, spec section 13.4). Registered by the
 * driver page only, with scope /d/: no tenant page is affected.
 *
 * - Navigations under /d/: network first; without a network, the last copy of that page. The page is
 *   a shell with no data (the stops come from the manifest kept in IndexedDB), so an old copy never
 *   shows old stops.
 * - /_next/static/*: cache first. The files are content-hashed, so a cached file is never stale; the
 *   cache is named after the build (?v= of the registration) and older builds' caches are deleted on
 *   activate. The cache only ever helps: when CacheStorage is broken or full (open, match or put
 *   rejects or throws) the request goes to the network as if there were no worker, so a phone with
 *   bad site storage still loads every JS chunk. The page registers this worker in production
 *   builds only (next dev chunk URLs are not content-hashed: cache first would serve stale code).
 * - /api/*: never cached, never touched.
 * - A message { type: 'forget', url } from the page (after a 404 / 410, or when the link's upload
 *   window has ended) deletes the cached copy of that page.
 */
const VERSION = new URL(self.location.href).searchParams.get('v') || 'v1';
const PAGES = 'riq-driver-pages-' + VERSION;
const STATIC = 'riq-driver-static-' + VERSION;
const MAX_STATIC = 120;

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    Promise.resolve()
      .then(() => caches.keys())
      .then((names) => Promise.all(names.filter((n) => n.startsWith('riq-driver-') && n !== PAGES && n !== STATIC).map((n) => caches.delete(n))))
      // Old caches that cannot be listed or deleted (broken storage) never stop the worker from taking over.
      .catch(() => {})
      .then(() => self.clients.claim()),
  );
});

async function trim(cacheName, max) {
  const cache = await caches.open(cacheName);
  const keys = await cache.keys();
  for (let i = 0; i < keys.length - max; i++) await cache.delete(keys[i]);
}

/**
 * A /_next/static/ file: the kept copy when there is one, else the network (kept for next time).
 * Every cache step is best effort: an error in one means "no cache", never a failed request.
 */
async function staticFile(req) {
  let cache = null;
  try {
    cache = await caches.open(STATIC);
    const hit = await cache.match(req);
    if (hit) return hit;
  } catch (e) {
    cache = null;
  }
  const res = await fetch(req);
  if (cache && res.ok) {
    try {
      cache
        .put(req, res.clone())
        .then(() => trim(STATIC, MAX_STATIC))
        .catch(() => {});
    } catch (e) {
      // the copy is not kept; the answer still goes out
    }
  }
  return res;
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/')) return;

  if (req.mode === 'navigate' && url.pathname.startsWith('/d/')) {
    event.respondWith(
      fetch(req)
        .then((res) => {
          if (res.ok) {
            try {
              const copy = res.clone();
              caches.open(PAGES).then((c) => c.put(url.pathname, copy)).catch(() => {});
            } catch (e) {
              // the copy is not kept; the page still loads
            }
          }
          return res;
        })
        .catch(() =>
          Promise.resolve()
            .then(() => caches.open(PAGES))
            .then((c) => c.match(url.pathname))
            .catch(() => null)
            .then((hit) => hit || Response.error()),
        ),
    );
    return;
  }

  if (url.pathname.startsWith('/_next/static/')) {
    event.respondWith(staticFile(req));
  }
});

self.addEventListener('message', (event) => {
  const data = event.data || {};
  if (data.type === 'forget' && typeof data.url === 'string') {
    const path = new URL(data.url, self.location.origin).pathname;
    event.waitUntil(
      Promise.resolve()
        .then(() => caches.open(PAGES))
        .then((c) => c.delete(path))
        .catch(() => {}),
    );
  }
});
