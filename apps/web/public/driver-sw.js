/*
 * The driver page's service worker (owner request 4 Oct 2026, spec section 13.4). Registered by the
 * driver page only, with scope /d/: no tenant page is affected.
 *
 * - Install (ISSUE 8): the first visit loaded the page and its files before any worker existed, so
 *   none of them went through this worker and a driver who lost signal right after could not reopen
 *   the link. Install therefore keeps the driver pages open in this browser (clients.matchAll) and the
 *   /_next/static/ files each one's HTML names (its scripts, styles and preloaded fonts) and its
 *   stylesheets name (the other font files), fetched again from the network - once each, whatever
 *   the tabs open. A new build's worker does the same when the driver next opens a link, from the
 *   network or, without signal, from the copies the older build kept (deleted only once this one took
 *   over). Best effort and bounded (PRECACHE_MS): a failure here never stops the worker installing.
 * - Navigations under /d/: network first; without a network, the last copy of that page. The page is
 *   a shell with no data (the stops come from the manifest kept in IndexedDB), so an old copy never
 *   shows old stops. Its HTML names the link's token (Next.js writes the URL into it), so each link's
 *   copy is kept under its own path: at most MAX_PAGES, a link's copy deleted when the page says it is
 *   dead (below), and the older build's copies when a new build takes over.
 * - /_next/static/*: cache first. The files are content-hashed, so a cached file is never stale; the
 *   cache is named after the build (?v= of the registration) and older builds' caches are deleted on
 *   activate. The cache only ever helps: when CacheStorage is broken or full (open, match or put
 *   rejects or throws) the request goes to the network as if there were no worker, so a phone with
 *   bad site storage still loads every JS chunk. The page registers this worker in production
 *   builds only (next dev chunk URLs are not content-hashed: cache first would serve stale code).
 * - /api/*: never cached, never touched (its answers hold one link's data).
 * - A message { type: 'forget', url } from the page (after a 404 / 410, or when the link's upload
 *   window has ended) deletes the cached copy of that page, in every build's page cache, and no
 *   worker keeps it again: this one, also when install is still fetching it (the page asks an
 *   installing worker too, lib/driver-page/worker.ts forgetDriverPage), nor a later build's while the
 *   dead tab stays open (remembered by a hash of the path - never the token - in GONE, which no build
 *   deletes).
 */
const VERSION = new URL(self.location.href).searchParams.get('v') || 'v1';
const PAGES = 'riq-driver-pages-' + VERSION;
const STATIC = 'riq-driver-static-' + VERSION;
const MAX_STATIC = 120;
const MAX_PAGES = 8;
const PRECACHE_MS = 20000;
/**
 * The links a page found dead (revoked, replaced, expired, closed): never kept again - by this worker
 * or by a later build's (a dead tab can stay open across a deploy, and the next install would keep its
 * page). In memory, and by hash - never the token - in a cache no build deletes (at most MAX_GONE).
 */
const GONE = 'riq-driver-gone';
const MAX_GONE = 200;
const forgotten = new Set();
/** This worker's downloads in progress or done, by URL: one per file and page, whatever the tabs open. */
const inflight = new Map();

/** The URL when it is of this site, else null. */
function ownUrl(href) {
  try {
    const u = new URL(href, self.location.origin);
    return u.origin === self.location.origin ? u : null;
  } catch (e) {
    return null;
  }
}

/** The key a dead link is remembered under: a hash of its path, never the token itself. */
async function goneKey(path) {
  let hex;
  try {
    const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(path));
    hex = Array.from(new Uint8Array(d), (b) => b.toString(16).padStart(2, '0')).join('');
  } catch (e) {
    // No WebCrypto (an insecure origin): a short hash, still never the token.
    let h = 2166136261;
    for (let i = 0; i < path.length; i++) h = Math.imul(h ^ path.charCodeAt(i), 16777619) >>> 0;
    hex = 'f' + h.toString(16);
  }
  return self.location.origin + '/__gone/' + hex;
}

async function isGone(path) {
  if (forgotten.has(path)) return true;
  try {
    const c = await caches.open(GONE);
    return !!(await c.match(await goneKey(path)));
  } catch (e) {
    return false;
  }
}

async function markGone(path) {
  forgotten.add(path);
  const c = await caches.open(GONE);
  await c.put(await goneKey(path), new Response(''));
  await trim(GONE, MAX_GONE);
}

/** A copy an older build kept (CacheStorage-wide), when the network cannot answer during install. */
async function olderCopy(key) {
  try {
    return typeof caches.match === 'function' ? (await caches.match(key)) || null : null;
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
 * A /_next/static/ file of this site kept for later (already kept: nothing to do), once per worker
 * whatever the number of pages naming it; for a stylesheet the files it names too (a font subset the
 * HTML does not preload). Without the network, an older build's copy (the files are content-hashed).
 */
function keepStatic(href, depth = 0) {
  const u = ownUrl(href);
  if (!u || !u.pathname.startsWith('/_next/static/')) return Promise.resolve();
  if (!inflight.has(u.href)) inflight.set(u.href, keepStaticOnce(u, depth).catch(() => {}));
  return inflight.get(u.href);
}

async function keepStaticOnce(u, depth) {
  const cache = await caches.open(STATIC);
  let res = await cache.match(u.href);
  if (!res) {
    let got = null;
    try {
      got = await fetch(u.href, { credentials: 'same-origin' });
      if (!got.ok || got.redirected) got = null;
    } catch (e) {
      got = null;
    }
    if (!got) got = await olderCopy(u.href);
    if (!got) return;
    res = got.clone();
    await cache.put(u.href, got);
  }
  if (depth === 0 && /\.css$/.test(u.pathname)) {
    const css = await res.text();
    await Promise.all(cssUrlsOf(css).map((f) => keepStatic(f, 1)));
  }
}

/**
 * A driver page open in this browser, fetched again (once per path) and kept under its path, then the
 * files its HTML names. Only a page under /d/ that answers 200 with HTML (never an error page or a
 * redirect), never a link found dead; without the network, the copy an older build kept.
 */
function keepPage(href) {
  const u = ownUrl(href);
  if (!u || !u.pathname.startsWith('/d/')) return Promise.resolve();
  const key = 'page:' + u.pathname;
  if (!inflight.has(key)) inflight.set(key, keepPageOnce(u.origin, u.pathname).catch(() => {}));
  return inflight.get(key);
}

async function keepPageOnce(origin, path) {
  if (await isGone(path)) return;
  let res = null;
  try {
    res = await fetch(origin + path, { credentials: 'same-origin' });
  } catch (e) {
    res = await olderCopy(path);
  }
  if (!res || !res.ok || res.redirected || !/text\/html/i.test(res.headers.get('content-type') || '')) return;
  const html = await res.clone().text();
  if (await isGone(path)) return;
  const pages = await caches.open(PAGES);
  await pages.put(path, res);
  if (await isGone(path)) {
    await pages.delete(path);
    return;
  }
  await trim(PAGES, MAX_PAGES);
  await Promise.all(staticUrlsOf(html).map((f) => keepStatic(f)));
  await trim(STATIC, MAX_STATIC);
}

/** Every driver page open in this browser (on a first visit: the page that registered this worker). */
async function precacheOpenPages() {
  if (!self.clients || typeof self.clients.matchAll !== 'function') return;
  const open = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  await Promise.all(open.map((c) => keepPage(c.url)));
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
      .then((names) => Promise.all(names.filter((n) => n.startsWith('riq-driver-') && n !== PAGES && n !== STATIC && n !== GONE).map((n) => caches.delete(n))))
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
              isGone(url.pathname)
                .then((gone) => (gone ? null : caches.open(PAGES).then((c) => c.put(url.pathname, copy)).then(() => trim(PAGES, MAX_PAGES))))
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
    // Remembered for every build (by hash), then deleted from this build's page cache and every other
    // build's (an older worker's copy not deleted yet).
    event.waitUntil(
      Promise.resolve()
        .then(() => markGone(path))
        .catch(() => {})
        .then(() => caches.open(PAGES))
        .then((c) => c.delete(path))
        .catch(() => {})
        .then(() => caches.keys())
        .then((names) => Promise.all(names.filter((n) => n.startsWith('riq-driver-pages-') && n !== PAGES).map((n) => caches.open(n).then((c) => c.delete(path)))))
        .catch(() => {}),
    );
  }
});
