/*
 * The driver page's service worker (owner request 4 Oct 2026, spec section 13.4). Registered by the
 * driver page only, with scope /d/: no tenant page is affected.
 *
 * - Install (ISSUE 8): the first visit loaded the page and its files before any worker existed, so
 *   none of them went through this worker and a driver who lost signal right after could not reopen
 *   the link. Install therefore keeps the driver pages open in this browser (clients.matchAll) and the
 *   /_next/static/ files each one's HTML names (its scripts, styles and preloaded fonts) and its
 *   stylesheets name (the other font files), fetched again from the network. Best effort and bounded (PRECACHE_MS): a failure here never stops the
 *   worker from installing. A new build's worker does the same, so a deploy leaves no gap either.
 * - Navigations under /d/: network first; without a network, the last copy of that page. The page is
 *   a shell with no data (the stops come from the manifest kept in IndexedDB), so an old copy never
 *   shows old stops. Its HTML names the link's token (Next.js writes the URL into it), so each link's
 *   copy is kept under its own path: at most MAX_PAGES, a link's copy deleted when the page says it is
 *   dead (below), and every copy when a new build takes over.
 * - /_next/static/*: cache first. The files are content-hashed, so a cached file is never stale; the
 *   cache is named after the build (?v= of the registration) and older builds' caches are deleted on
 *   activate. The cache only ever helps: when CacheStorage is broken or full (open, match or put
 *   rejects or throws) the request goes to the network as if there were no worker, so a phone with
 *   bad site storage still loads every JS chunk. The page registers this worker in production
 *   builds only (next dev chunk URLs are not content-hashed: cache first would serve stale code).
 * - /api/*: never cached, never touched (its answers hold one link's data).
 * - A message { type: 'forget', url } from the page (after a 404 / 410, or when the link's upload
 *   window has ended) deletes the cached copy of that page, in every build's page cache, and this
 *   worker never keeps it again (also when install is still fetching it: the page asks an installing
 *   worker too, lib/driver-page/worker.ts forgetDriverPage).
 */
const VERSION = new URL(self.location.href).searchParams.get('v') || 'v1';
const PAGES = 'riq-driver-pages-' + VERSION;
const STATIC = 'riq-driver-static-' + VERSION;
const MAX_STATIC = 120;
const MAX_PAGES = 8;
const PRECACHE_MS = 20000;
/** Paths the page asked this worker to forget: never kept again in its life. */
const forgotten = new Set();

/** The URL when it is of this site, else null. */
function ownUrl(href) {
  try {
    const u = new URL(href, self.location.origin);
    return u.origin === self.location.origin ? u : null;
  } catch (e) {
    return null;
  }
}

/** The /_next/static/ files an HTML page names in src= / href= (its scripts, styles, preloaded fonts). */
function staticUrlsOf(html) {
  const out = new Set();
  const re = /(?:src|href)\s*=\s*["'](\/_next\/static\/[^"'\s<>]+)["']/g;
  let m;
  while ((m = re.exec(html)) && out.size < MAX_STATIC) {
    const href = m[1].replace(/&amp;/g, '&');
    if (!/\.map(?:\?|$)/.test(href)) out.add(href);
  }
  return [...out];
}

/** The /_next/static/ files a stylesheet names in url(...) (next/font's font files). */
function cssUrlsOf(css) {
  const out = new Set();
  const re = /url\(\s*["']?(\/_next\/static\/[^"')\s]+)["']?\s*\)/g;
  let m;
  while ((m = re.exec(css)) && out.size < MAX_STATIC) out.add(m[1]);
  return [...out];
}

/**
 * A /_next/static/ file of this site kept for later (already kept: nothing to do), and for a
 * stylesheet the files it names too (a font subset the HTML does not preload).
 */
async function keepStatic(href, depth = 0) {
  const u = ownUrl(href);
  if (!u || !u.pathname.startsWith('/_next/static/')) return;
  const cache = await caches.open(STATIC);
  let res = await cache.match(u.href);
  if (!res) {
    const got = await fetch(u.href, { credentials: 'same-origin' });
    if (!got.ok || got.redirected) return;
    res = got.clone();
    await cache.put(u.href, got);
  }
  if (depth === 0 && /\.css$/.test(u.pathname)) {
    const css = await res.text();
    await Promise.all(cssUrlsOf(css).map((f) => keepStatic(f, 1).catch(() => {})));
  }
}

/**
 * A driver page open in this browser, fetched again and kept under its path, then the files its HTML
 * names. Only a page under /d/ that answers 200 with HTML (never an error page or a redirect), and
 * never one the page asked to forget.
 */
async function keepPage(href) {
  const u = ownUrl(href);
  if (!u || !u.pathname.startsWith('/d/')) return;
  const path = u.pathname;
  if (forgotten.has(path)) return;
  const res = await fetch(u.origin + path, { credentials: 'same-origin' });
  if (!res.ok || res.redirected || !/text\/html/i.test(res.headers.get('content-type') || '')) return;
  const html = await res.clone().text();
  if (forgotten.has(path)) return;
  const pages = await caches.open(PAGES);
  await pages.put(path, res);
  if (forgotten.has(path)) {
    await pages.delete(path);
    return;
  }
  await trim(PAGES, MAX_PAGES);
  await Promise.all(staticUrlsOf(html).map((f) => keepStatic(f).catch(() => {})));
  await trim(STATIC, MAX_STATIC);
}

/** Every driver page open in this browser (on a first visit: the page that registered this worker). */
async function precacheOpenPages() {
  if (!self.clients || typeof self.clients.matchAll !== 'function') return;
  const open = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  await Promise.all(open.map((c) => keepPage(c.url).catch(() => {})));
}

self.addEventListener('install', (event) => {
  self.skipWaiting();
  // Never longer than PRECACHE_MS and never a failure: the worker installs either way.
  const work = Promise.resolve()
    .then(precacheOpenPages)
    .catch(() => {});
  let timer = null;
  const limit = new Promise((resolve) => {
    timer = setTimeout(resolve, PRECACHE_MS);
  });
  event.waitUntil(Promise.race([work, limit]).then(() => clearTimeout(timer)));
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
          if (res.ok && !forgotten.has(url.pathname)) {
            try {
              const copy = res.clone();
              caches
                .open(PAGES)
                .then((c) => c.put(url.pathname, copy))
                .then(() => trim(PAGES, MAX_PAGES))
                .catch(() => {});
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
    const u = ownUrl(data.url);
    if (!u) return;
    const path = u.pathname;
    forgotten.add(path);
    // This build's page cache, then every other build's (an older worker's copy not deleted yet).
    event.waitUntil(
      Promise.resolve()
        .then(() => caches.open(PAGES))
        .then((c) => c.delete(path))
        .catch(() => {})
        .then(() => caches.keys())
        .then((names) => Promise.all(names.filter((n) => n.startsWith('riq-driver-pages-') && n !== PAGES).map((n) => caches.open(n).then((c) => c.delete(path)))))
        .catch(() => {}),
    );
  }
});
