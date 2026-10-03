/*
 * The driver page's service worker (owner request 4 Oct 2026, spec section 13.4). Registered by the
 * driver page only, with scope /d/: no tenant page is affected.
 *
 * - Navigations under /d/: network first; without a network, the last copy of that page. The page is
 *   a shell with no data (the stops come from the manifest kept in IndexedDB), so an old copy never
 *   shows old stops.
 * - /_next/static/*: cache first. The files are content-hashed, so a cached file is never stale; the
 *   cache is named after the build (?v= of the registration) and older builds' caches are deleted on
 *   activate.
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
    caches
      .keys()
      .then((names) => Promise.all(names.filter((n) => n.startsWith('riq-driver-') && n !== PAGES && n !== STATIC).map((n) => caches.delete(n))))
      .then(() => self.clients.claim()),
  );
});

async function trim(cacheName, max) {
  const cache = await caches.open(cacheName);
  const keys = await cache.keys();
  for (let i = 0; i < keys.length - max; i++) await cache.delete(keys[i]);
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
            const copy = res.clone();
            caches.open(PAGES).then((c) => c.put(url.pathname, copy)).catch(() => {});
          }
          return res;
        })
        .catch(() => caches.open(PAGES).then((c) => c.match(url.pathname)).then((hit) => hit || Response.error())),
    );
    return;
  }

  if (url.pathname.startsWith('/_next/static/')) {
    event.respondWith(
      caches.open(STATIC).then((c) =>
        c.match(req).then(
          (hit) =>
            hit ||
            fetch(req).then((res) => {
              if (res.ok) {
                c.put(req, res.clone())
                  .then(() => trim(STATIC, MAX_STATIC))
                  .catch(() => {});
              }
              return res;
            }),
        ),
      ),
    );
  }
});

self.addEventListener('message', (event) => {
  const data = event.data || {};
  if (data.type === 'forget' && typeof data.url === 'string') {
    const path = new URL(data.url, self.location.origin).pathname;
    event.waitUntil(caches.open(PAGES).then((c) => c.delete(path)));
  }
});
