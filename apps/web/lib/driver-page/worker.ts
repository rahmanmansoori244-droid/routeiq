/**
 * The driver page's service worker (public/driver-sw.js): when the page registers it. Browser-safe.
 *
 * Production builds only. The worker keeps /_next/static/ files cache first, which is right for the
 * content-hashed files of a production build and wrong for `next dev`, whose chunk URLs are not
 * hashed: a cached chunk would be served for ever and the page would run stale code. A development
 * build therefore does not register it, and removes one an earlier visit left on this browser.
 */

/** Pass `process.env.NODE_ENV` as written (Next.js replaces that exact expression at build time). */
export function shouldRegisterWorker(nodeEnv: string | undefined, nav: { serviceWorker?: unknown } | null | undefined): boolean {
  return nodeEnv === 'production' && !!nav && 'serviceWorker' in nav;
}

/** Best effort: unregisters the driver worker (scope /d/) and deletes its caches. Never throws. */
export async function dropDriverWorker(nav: Pick<Navigator, 'serviceWorker'>, cacheStorage: Pick<CacheStorage, 'keys' | 'delete'> | undefined): Promise<void> {
  try {
    const regs = (await nav.serviceWorker?.getRegistrations?.()) ?? [];
    await Promise.all(regs.filter((r) => new URL(r.scope).pathname === '/d/').map((r) => r.unregister()));
  } catch {
    // nothing to remove, or the browser refuses: the page works either way
  }
  try {
    const names = (await cacheStorage?.keys()) ?? [];
    await Promise.all(names.filter((n) => n.startsWith('riq-driver-')).map((n) => cacheStorage!.delete(n)));
  } catch {
    // broken storage: nothing to clean
  }
}
