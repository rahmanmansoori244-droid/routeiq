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

type WorkerLike = { postMessage(message: unknown): void } | null | undefined;

type RegistrationLike = { installing?: WorkerLike; waiting?: WorkerLike; active?: WorkerLike } | null | undefined;

/**
 * Asks the driver workers of this page to forget the kept copy of `path` (a link found revoked,
 * replaced, expired or closed): the worker in control and the installing, waiting and active one of
 * the /d/ registration, each once - on a first visit none controls the page yet, and during a deploy
 * a new build's worker may be installing it (ISSUE 8) - and the active worker once the registration
 * has one (`ready`: the link can be found dead before the registration even exists, and that worker's
 * install then kept the page). Best effort: never throws, never waits for `ready`.
 */
export async function forgetDriverPage(
  nav: { serviceWorker?: { controller?: WorkerLike; getRegistration?: (scope?: string) => Promise<RegistrationLike>; ready?: Promise<RegistrationLike> } } | null | undefined,
  path: string,
): Promise<void> {
  const sent = new Set<unknown>();
  const post = (w: WorkerLike) => {
    if (!w || sent.has(w)) return;
    sent.add(w);
    try {
      w.postMessage({ type: 'forget', url: path });
    } catch {
      // that worker is gone: nothing kept by it to forget
    }
  };
  const sw = nav?.serviceWorker;
  if (!sw) return;
  try {
    // Never resolves without a registration (a development build): nothing waits for it.
    sw.ready?.then((reg) => post(reg?.active)).catch(() => undefined);
  } catch {
    // no ready promise: the posts below are all there is
  }
  try {
    post(sw.controller);
    const reg = await sw.getRegistration?.('/d/');
    if (reg) [reg.installing, reg.waiting, reg.active].forEach(post);
  } catch {
    // no worker, or the browser refuses: nothing to forget
  }
}
