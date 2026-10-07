/**
 * The driver page's offline queue (owner request 4 Oct 2026, spec sections 13.1 to 13.3) on the
 * memory store: backoff, ordering, the answers per item and per request (429 keeps everything), held
 * arrivals released at dispatch, drafts committed with Save, a reissued link picking up the waiting
 * items and the clean-up of old truck-days. Synthetic data only.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';
import {
  actionItem,
  applyResults,
  backoff,
  classify,
  flushQueue,
  newKey,
  nextBatch,
  readSendAnswer,
  releaseHeld,
  staleNamespaces,
  waitingCount,
  type QueueItem,
} from '@/lib/driver-page/queue';
import { memoryStore } from '@/lib/driver-page/store';
import { dropDriverWorker, forgetDriverPage, shouldRegisterWorker } from '@/lib/driver-page/worker';
import type { DriverAction } from '@/lib/driver-link/manifest-types';

const NS = 't5|2026-10-05';
const T0 = 1_000_000;
const arrive = (stop: string, key = newKey()): DriverAction => ({ key, type: 'ARRIVE', stop, at: new Date(T0).toISOString(), mode: 'AUTO' });
const result = (stop: string, key = newKey()): DriverAction => ({ key, type: 'OUTCOME', stop, at: new Date(T0).toISOString(), outcome: 'DELIVERED', photoKeys: [] });
function photo(stop: string, createdAt: number, over: Partial<QueueItem> = {}): QueueItem {
  const key = newKey();
  return { key, ns: NS, kind: 'photo', state: 'ready', createdAt, attempts: 0, nextAt: createdAt, stopKey: stop, loadNo: 1, body: { key, stop, takenAt: new Date(createdAt).toISOString(), positionStatus: 'OK' }, blob: new Blob([new Uint8Array([0xff, 0xd8, 0xff])]), ...over };
}

describe('keys and backoff', () => {
  it('a key is a lowercase v4 UUID, also without crypto.randomUUID', () => {
    expect(newKey()).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    const noUuid = { getRandomValues: (b: Uint8Array) => b.fill(0xab) } as unknown as Crypto;
    expect(newKey(noUuid)).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it('5 s, 15 s, 30 s, 60 s, then every 5 min', () => {
    expect([1, 2, 3, 4, 5, 9].map(backoff)).toEqual([5_000, 15_000, 30_000, 60_000, 300_000, 300_000]);
  });
});

describe('nextBatch: order', () => {
  it('ready actions in creation order (up to 50); a photo only after the actions created before it, and after its position or 15 s', () => {
    const a1 = actionItem(NS, arrive('D1:1:1'), T0);
    const a2 = actionItem(NS, result('D1:1:1'), T0 + 10);
    const p = photo('D1:1:1', T0 + 20, { body: { key: 'k', stop: 'D1:1:1', takenAt: '', positionStatus: 'TIMEOUT', positionUntil: T0 + 15_020 } });
    const held = actionItem(NS, arrive('D1:2:1'), T0 + 5, true);
    const items = [p, a2, held, a1];
    expect(nextBatch(items, T0 + 100)).toEqual({ actions: [a1, a2], photo: null });
    // Once the actions went: the photo waits for its position (at most 15 s).
    expect(nextBatch([p], T0 + 100).photo).toBeNull();
    expect(nextBatch([p], T0 + 15_100).photo).toBe(p);
    // An action waiting for its backoff still holds a later photo back.
    const waiting = { ...a1, nextAt: T0 + 60_000 };
    expect(nextBatch([waiting, photo('D1:1:1', T0 + 30)], T0 + 100)).toEqual({ actions: [], photo: null });
    expect(nextBatch(Array.from({ length: 60 }, (_, i) => actionItem(NS, arrive('D1:1:1'), T0 + i)), T0 + 100).actions).toHaveLength(50);
  });
});

describe('the answers', () => {
  it('ok / duplicate remove; refused removes and reports; LOAD_NOT_DISPATCHED for an arrival is held; an error retries with backoff', () => {
    const items = [actionItem(NS, arrive('D1:1:1'), T0), actionItem(NS, result('D1:1:1'), T0 + 1), actionItem(NS, result('D1:1:2'), T0 + 2), actionItem(NS, arrive('D1:2:1'), T0 + 3), actionItem(NS, arrive('D1:1:3'), T0 + 4)];
    const out = applyResults(
      items,
      [
        { key: items[0]!.key, status: 'ok' },
        { key: items[1]!.key, status: 'duplicate' },
        { key: items[2]!.key, status: 'refused', code: 'PHOTO_REQUIRED', message: { en: 'A photo is required for this result.', ar: 'الصورة مطلوبة لهذه النتيجة.' } },
        { key: items[3]!.key, status: 'refused', code: 'LOAD_NOT_DISPATCHED', transient: true },
        { key: items[4]!.key, status: 'error' },
      ],
      T0 + 100,
    );
    expect(out.remove).toEqual([items[0]!.key, items[1]!.key, items[2]!.key]);
    expect(out.report).toEqual([expect.objectContaining({ key: items[2]!.key, stopKey: 'D1:1:2', code: 'PHOTO_REQUIRED', type: 'OUTCOME' })]);
    expect(out.update).toEqual([expect.objectContaining({ key: items[3]!.key, state: 'held' }), expect.objectContaining({ key: items[4]!.key, attempts: 1, nextAt: T0 + 100 + 5_000 })]);
    expect(out.sent).toEqual({ 'D1:1:1': { outcome: 'DELIVERED', at: new Date(T0).toISOString() } });
    expect(classify(undefined)).toBe('retry');
  });

  it('reads the request answers: 429 pauses (Retry-After), 409 / 5xx / network retry, 404 / 410 stop, UPLOAD_CLOSED closes, 413 / 415 / photo limit drop', () => {
    expect(readSendAnswer(429, null, '12')).toEqual({ kind: 'pause', ms: 12_000 });
    expect(readSendAnswer(429, null, null)).toEqual({ kind: 'pause', ms: 60_000 });
    for (const s of [409, 500, 502, 0]) expect(readSendAnswer(s, { error: { code: 'PLAN_BUSY' } }, null)).toEqual({ kind: 'retry' });
    expect(readSendAnswer(410, { error: { code: 'LINK_REPLACED' } }, null)).toEqual({ kind: 'dead', code: 'LINK_REPLACED' });
    expect(readSendAnswer(404, { error: { code: 'LINK_NOT_FOUND' } }, null)).toEqual({ kind: 'dead', code: 'LINK_NOT_FOUND' });
    expect(readSendAnswer(410, { error: { code: 'UPLOAD_CLOSED' } }, null)).toEqual({ kind: 'closed' });
    expect(readSendAnswer(415, { error: { code: 'NOT_JPEG', error: 'Only JPEG' } }, null)).toMatchObject({ kind: 'drop', code: 'NOT_JPEG' });
    expect(readSendAnswer(409, { error: { code: 'PHOTO_LIMIT' } }, null)).toMatchObject({ kind: 'drop', code: 'PHOTO_LIMIT' });
  });
});

describe('flushQueue on the memory store', () => {
  const ok = (body: unknown) => ({ status: 200, body: { data: body, error: null }, retryAfter: null });

  it('sends the actions, then the photo; reports refusals; keeps everything on 429 and waits Retry-After', async () => {
    const store = memoryStore();
    const a = actionItem(NS, result('D1:1:1'), T0);
    const p = photo('D1:1:1', T0 + 1);
    await store.put([a, p]);
    let posted = 0;
    const r429 = await flushQueue({ store, ns: NS, now: () => T0 + 10, postActions: async () => ({ status: 429, body: null, retryAfter: '30' }), postPhoto: async () => ok({}) });
    expect(r429.pauseUntil).toBe(T0 + 10 + 30_000);
    expect(await store.items(NS)).toEqual(expect.arrayContaining([expect.objectContaining({ key: a.key, attempts: 0 }), expect.objectContaining({ key: p.key })]));
    const r = await flushQueue({
      store,
      ns: NS,
      now: () => T0 + 10,
      postActions: async (actions) => {
        posted += actions.length;
        return ok({ results: actions.map((x) => ({ key: x.key, status: 'ok' })), stops: { 'D1:1:1': { outcome: 'DELIVERED' } }, back: {} });
      },
      postPhoto: async (item) => ok({ photoId: item.key, status: 'ok', stops: {}, back: {} }),
    });
    expect(posted).toBe(1);
    expect(r.sent).toBe(2);
    expect(r.sentMap['D1:1:1']).toMatchObject({ outcome: 'DELIVERED' });
    expect(await store.items(NS)).toEqual([]);
  });

  it("each round's results reach the page BEFORE its sent items leave the phone (a sent result never disappears in between)", async () => {
    const store = memoryStore();
    const a = actionItem(NS, result('D1:1:1'), T0);
    const p = photo('D1:1:1', T0 + 1);
    await store.put([a, p]);
    const seen: string[] = [];
    await flushQueue({
      store,
      ns: NS,
      now: () => T0 + 20_000,
      postActions: async (actions) => ok({ results: actions.map((x) => ({ key: x.key, status: 'ok' })), stops: { 'D1:1:1': { outcome: 'DELIVERED' } }, back: {} }),
      postPhoto: async (item) => ok({ photoId: item.key, status: 'ok', stops: { 'D1:1:1': { outcome: 'DELIVERED', photoIds: [item.key] } }, back: {} }),
      onResults: async (r) => {
        // When the results arrive, the item they answer is still on the phone.
        const keys = (await store.items(NS)).map((i) => i.key);
        seen.push(`${Object.keys(r.stops).join(',')}:${keys.includes(a.key) ? 'action kept' : 'action gone'}:${keys.includes(p.key) ? 'photo kept' : 'photo gone'}`);
      },
    });
    expect(seen).toEqual(['D1:1:1:action kept:photo kept', 'D1:1:1:action gone:photo kept']);
    expect(await store.items(NS)).toEqual([]);
  });

  it('409 / 5xx keep the items for a retry; 404 / 410 stop sending; UPLOAD_CLOSED is reported', async () => {
    const store = memoryStore();
    const a = actionItem(NS, arrive('D1:1:1'), T0);
    await store.put([a]);
    const busy = await flushQueue({ store, ns: NS, now: () => T0, postActions: async () => ({ status: 409, body: { error: { code: 'PLAN_BUSY' } }, retryAfter: null }), postPhoto: async () => ok({}) });
    expect(busy.sent).toBe(0);
    expect((await store.items(NS))[0]).toMatchObject({ attempts: 1, nextAt: T0 + 5_000 });
    const gone = await flushQueue({ store, ns: NS, now: () => T0 + 10_000, postActions: async () => ({ status: 410, body: { error: { code: 'LINK_REVOKED' } }, retryAfter: null }), postPhoto: async () => ok({}) });
    expect(gone.dead).toBe('LINK_REVOKED');
    expect(await store.items(NS)).toHaveLength(1); // kept for a new link of the same truck-day
    const closed = await flushQueue({ store, ns: NS, now: () => T0 + 60_000, postActions: async () => ({ status: 410, body: { error: { code: 'UPLOAD_CLOSED' } }, retryAfter: null }), postPhoto: async () => ok({}) });
    expect(closed.closed).toBe(true);
  });

  it('a photo refused for good (too large, not a JPEG, over the limit) is dropped and reported', async () => {
    const store = memoryStore();
    const p = photo('D1:1:1', T0);
    await store.put([p]);
    const r = await flushQueue({ store, ns: NS, now: () => T0 + 10, postActions: async () => ok({ results: [] }), postPhoto: async () => ({ status: 409, body: { error: { code: 'PHOTO_LIMIT' } }, retryAfter: null }) });
    expect(r.reports).toEqual([expect.objectContaining({ key: p.key, code: 'PHOTO_LIMIT', type: 'PHOTO' })]);
    expect(await store.items(NS)).toEqual([]);
  });
});

describe('held items, drafts, namespaces', () => {
  it('held arrivals become ready once their trip is dispatched, with their original times; they are not counted as waiting', () => {
    const h1 = actionItem(NS, arrive('D1:1:1'), T0, true);
    const h2 = actionItem(NS, arrive('D1:2:1'), T0 + 1, true);
    expect(waitingCount([h1, h2])).toBe(0);
    const released = releaseHeld([h1, h2], new Set(['D1:1']), T0 + 500);
    expect(released).toEqual([expect.objectContaining({ key: h1.key, state: 'ready', body: h1.body })]);
  });

  it('Save commits the draft photos and the result in one step; other drafts of the stop go; Cancel drops them', async () => {
    const store = memoryStore();
    const used = photo('D1:1:1', T0, { state: 'draft' });
    const retaken = photo('D1:1:1', T0 + 1, { state: 'draft' });
    const otherStop = photo('D1:1:2', T0 + 2, { state: 'draft' });
    await store.put([used, retaken, otherStop]);
    await store.putDraft(NS, 'D1:1:1', { outcome: 'DELIVERED', reason: null, note: '', lines: {}, photoKeys: [used.key], pendingPhotoKey: null, noPhoto: false, savedAt: T0 });
    const action = actionItem(NS, { ...result('D1:1:1'), photoKeys: [used.key] } as DriverAction, T0 + 10);
    await store.commit(NS, 'D1:1:1', [used.key], action);
    const after = await store.items(NS);
    expect(after.find((i) => i.key === used.key)).toMatchObject({ state: 'ready', createdAt: T0 + 11 });
    expect(after.find((i) => i.key === retaken.key)).toBeUndefined();
    expect(after.find((i) => i.key === action.key)).toMatchObject({ state: 'ready' });
    expect(await store.getDraft(NS, 'D1:1:1')).toBeNull();
    // The photo goes after its result.
    expect(nextBatch(after, T0 + 100).actions.map((i) => i.key)).toEqual([action.key]);
    await store.dropDrafts(NS, 'D1:1:2');
    expect((await store.items(NS)).find((i) => i.key === otherStop.key)).toBeUndefined();
  });

  it('a reissued link on the same phone picks up the waiting items (the namespace is the truck-day, not the link)', async () => {
    const store = memoryStore();
    await store.put([actionItem(NS, result('D1:1:1'), T0)]);
    await store.putLink('old-link-hash', { ns: NS, trackingOn: true });
    await store.putLink('new-link-hash', { ns: NS, trackingOn: false });
    expect((await store.getLink('new-link-hash'))!.ns).toBe(NS);
    expect(await store.items(NS)).toHaveLength(1);
  });

  it('truck-days 5 or more days before the phone\'s date are deleted with everything they kept', async () => {
    const store = memoryStore();
    const old = 't5|2026-09-29';
    await store.put([{ ...actionItem(old, result('D1:1:1'), T0) }, actionItem(NS, result('D1:1:1'), T0)]);
    await store.putManifest(old, { manifest: {}, savedAt: T0, sent: {} });
    await store.putLink('h', { ns: old, trackingOn: false });
    expect(staleNamespaces(await store.namespaces(), '2026-10-04').sort()).toEqual([old]);
    expect(staleNamespaces([NS], '2026-10-09')).toEqual([]);
    expect(staleNamespaces([NS], '2026-10-10')).toEqual([NS]);
    await store.clearNamespace(old);
    expect(await store.items(old)).toEqual([]);
    expect(await store.getManifest(old)).toBeNull();
    expect(await store.getLink('h')).toBeNull();
    expect(await store.items(NS)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------------------
// The service worker (public/driver-sw.js, demo fix of 4 Oct 2026): a cache that fails never fails a
// request, and the page registers the worker in production builds only. The worker file is run as it
// is, in a vm context with a stub CacheStorage, fetch and `self` (no browser here).
// ---------------------------------------------------------------------------------------
describe('the driver service worker', () => {
  const src = readFileSync(path.resolve(__dirname, '../../public/driver-sw.js'), 'utf8');
  type Listener = (e: Record<string, unknown>) => void;
  type Cache = { match: (r: unknown) => Promise<Response | undefined>; put: (r: unknown, res: Response) => Promise<void>; keys: () => Promise<unknown[]>; delete: (r: unknown) => Promise<boolean> };
  type Storage = { open: (name?: string) => Promise<Cache>; keys?: () => Promise<string[]>; delete?: (n: string) => Promise<boolean>; match?: (r: unknown) => Promise<Response | undefined> };

  /**
   * The worker's script in a context with the given CacheStorage (undefined: none at all) and fetch.
   * `windows`: the browser's open windows of this origin (clients.matchAll; null: no matchAll at all),
   * none of them controlled by a worker (a first visit) unless given as { url, controlled: true }: as
   * a browser, matchAll lists the uncontrolled ones only with includeUncontrolled. `build`: the ?v= of
   * the registration (a new build registers a new one).
   */
  function boot(
    storage: Storage | undefined,
    fetchImpl: (r: unknown, init?: unknown) => Promise<Response>,
    windows: (string | { url: string; controlled: boolean })[] | null = [],
    build = 'b1',
  ) {
    const listeners: Record<string, Listener> = {};
    const claimed = { n: 0 };
    const wins = (windows ?? []).map((w) => (typeof w === 'string' ? { url: w, controlled: false } : w));
    const self = {
      location: { href: `https://app.test/driver-sw.js?v=${build}`, origin: 'https://app.test' },
      addEventListener: (type: string, l: Listener) => {
        listeners[type] = l;
      },
      skipWaiting: () => undefined,
      clients: {
        claim: async () => void claimed.n++,
        ...(windows
          ? {
              matchAll: async (opts?: { type?: string; includeUncontrolled?: boolean }) =>
                wins.filter((w) => (opts?.includeUncontrolled || w.controlled) && (!opts?.type || opts.type === 'window' || opts.type === 'all')).map((w) => ({ url: w.url, type: 'window' })),
            }
          : {}),
      },
    };
    const globals: Record<string, unknown> = { self, fetch: fetchImpl, URL, Response, setTimeout, clearTimeout, crypto: globalThis.crypto, TextEncoder };
    if (storage) globals.caches = storage;
    vm.runInContext(src, vm.createContext(globals));
    return { listeners, claimed };
  }
  const goodCache = (over: Partial<Cache> = {}): Cache => ({ match: async () => undefined, put: async () => undefined, keys: async () => [], delete: async () => true, ...over });
  /** Fires a fetch event and returns what the worker answered (undefined: it did not respond, the browser goes to the network itself). */
  async function ask(listeners: Record<string, Listener>, url: string, mode = 'no-cors', method = 'GET') {
    let answer: Promise<Response> | undefined;
    listeners.fetch!({ request: { method, url, mode }, respondWith: (p: Promise<Response>) => void (answer = p) });
    return answer ? await answer : undefined;
  }
  const CHUNK = 'https://app.test/_next/static/chunks/app.js';
  const network = () => {
    const calls: unknown[] = [];
    return { calls, fetch: async (r: unknown) => (calls.push(r), new Response('js', { status: 200 })) };
  };
  const text = async (r: Response | undefined) => (r ? await r.text() : null);

  it('a /_next/static/ file: the kept copy first, else the network, and the copy is kept for next time', async () => {
    const net = network();
    const kept: unknown[] = [];
    const a = boot({ open: async () => goodCache({ match: async () => new Response('kept') }) }, net.fetch);
    expect(await text(await ask(a.listeners, CHUNK))).toBe('kept');
    expect(net.calls).toHaveLength(0);
    const b = boot({ open: async () => goodCache({ put: async (r) => void kept.push(r) }) }, net.fetch);
    expect(await text(await ask(b.listeners, CHUNK))).toBe('js');
    expect(net.calls).toHaveLength(1);
    expect(kept).toHaveLength(1);
  });

  it('a broken or full CacheStorage never fails a chunk: open, match and put errors (and no CacheStorage at all) all fall back to the network', async () => {
    const cases: [string, Storage | undefined][] = [
      ['open rejects', { open: async () => Promise.reject(new Error('QuotaExceededError')) }],
      [
        'open throws',
        {
          open: () => {
            throw new Error('SecurityError');
          },
        },
      ],
      ['match rejects', { open: async () => goodCache({ match: async () => Promise.reject(new Error('UnknownError')) }) }],
      ['put rejects (storage full)', { open: async () => goodCache({ put: async () => Promise.reject(new Error('QuotaExceededError')) }) }],
      [
        'put throws',
        {
          open: async () =>
            goodCache({
              put: () => {
                throw new Error('boom');
              },
            }),
        },
      ],
      ['no CacheStorage', undefined],
    ];
    for (const [name, storage] of cases) {
      const net = network();
      const w = boot(storage, net.fetch);
      expect(await text(await ask(w.listeners, CHUNK)), name).toBe('js');
      expect(net.calls, name).toHaveLength(1);
    }
    // The network failing is the one thing that fails the request (as without a worker).
    const down = boot({ open: async () => Promise.reject(new Error('x')) }, async () => Promise.reject(new TypeError('Failed to fetch')));
    await expect(ask(down.listeners, CHUNK)).rejects.toThrow('Failed to fetch');
  });

  it('a page under /d/ without network and with a broken cache is a network error, not a crash; /api, other origins and POSTs are never touched', async () => {
    const down = boot({ open: async () => Promise.reject(new Error('x')) }, async () => Promise.reject(new TypeError('offline')));
    const res = await ask(down.listeners, 'https://app.test/d/token123', 'navigate');
    expect(res?.type).toBe('error');
    const net = network();
    const w = boot({ open: async () => goodCache() }, net.fetch);
    expect(await ask(w.listeners, 'https://app.test/api/driver/x')).toBeUndefined();
    expect(await ask(w.listeners, 'https://cdn.other.test/_next/static/a.js')).toBeUndefined();
    expect(await ask(w.listeners, CHUNK, 'no-cors', 'POST')).toBeUndefined();
    expect(await ask(w.listeners, 'https://app.test/t/acme/dispatch', 'navigate')).toBeUndefined();
  });

  it('activate takes over and the "forget" message ends well even when the cache storage is broken', async () => {
    const w = boot({ open: async () => Promise.reject(new Error('x')), keys: async () => Promise.reject(new Error('x')) }, network().fetch);
    const waits: Promise<unknown>[] = [];
    w.listeners.activate!({ waitUntil: (p: Promise<unknown>) => void waits.push(p) });
    w.listeners.message!({ data: { type: 'forget', url: '/d/token123' }, waitUntil: (p: Promise<unknown>) => void waits.push(p) });
    await expect(Promise.all(waits)).resolves.toHaveLength(2);
    expect(w.claimed.n).toBe(1);
  });

  // ---- ISSUE 8: the first visit prepares an offline reload ----------------------------------------
  /** A CacheStorage in memory, keyed by URL as the browser's (a request or a string). */
  function memoryCaches() {
    const stores = new Map<string, Map<string, Response>>();
    const keyOf = (r: unknown) => new URL(typeof r === 'string' ? r : (r as { url: string }).url, 'https://app.test').href;
    const open = async (name: string): Promise<Cache> => {
      if (!stores.has(name)) stores.set(name, new Map());
      const m = stores.get(name)!;
      return {
        match: async (r) => m.get(keyOf(r))?.clone(),
        put: async (r, res) => {
          m.delete(keyOf(r));
          m.set(keyOf(r), res);
        },
        keys: async () => [...m.keys()].map((url) => ({ url })),
        delete: async (r) => m.delete(keyOf(r)),
      };
    };
    /** CacheStorage.match: every cache, in the order they were made. */
    const matchAny = async (r: unknown) => {
      for (const m of stores.values()) {
        const hit = m.get(keyOf(r));
        if (hit) return hit.clone();
      }
      return undefined;
    };
    const storage = { open, keys: async () => [...stores.keys()], delete: async (n: string) => stores.delete(n), match: matchAny } as Storage;
    /** Every kept URL, by cache. */
    const kept = () => Object.fromEntries([...stores].map(([n, m]) => [n, [...m.keys()]]));
    return { storage, stores, kept };
  }
  const TOKEN = 'AbCdEfGhIjKlMnOpQrStUvWx'; // 24 characters, as a driver link's (synthetic)
  const PAGE = `https://app.test/d/${TOKEN}`;
  // The shell as Next.js 14 writes it: its CSS, the font it preloads, the page's chunks (one with a
  // query written &amp;), and a file of another origin that is never kept.
  const ASSETS = ['/_next/static/css/app-1a2b.css', '/_next/static/media/inter-3c4d.woff2', '/_next/static/chunks/webpack-5e6f.js', '/_next/static/chunks/app/d/%5Btoken%5D/page-7a8b.js?dpl=b1&v=2'];
  const HTML =
    '<!DOCTYPE html><html><head>' +
    `<link rel="stylesheet" href="${ASSETS[0]}" data-precedence="next"/>` +
    `<link rel="preload" href="${ASSETS[1]}" as="font" crossorigin="" type="font/woff2"/>` +
    `<script src="${ASSETS[2]}" async=""></script>` +
    `<script src="${ASSETS[3]!.replace('&', '&amp;')}" async=""></script>` +
    '<script src="https://cdn.other.test/_next/static/chunks/other.js" async=""></script>' +
    '</head><body><div id="driver-page"></div><script>self.__next_f.push([1,"..."])</script></body></html>';
  // A font only the stylesheet names (a subset of next/font the HTML does not preload; seen in Chromium).
  const CSS_FONT = '/_next/static/media/e4af-s.p.woff2';
  /** The site as the network serves it: the page under any token, its assets, the API, a tenant page. */
  function site() {
    const net = { online: true, calls: [] as string[], hold: null as Promise<void> | null, pageStatus: 200, redirected: false };
    const fetchImpl = async (r: unknown) => {
      const url = new URL(typeof r === 'string' ? r : (r as { url: string }).url, 'https://app.test');
      net.calls.push(url.href);
      if (net.hold) await net.hold;
      if (!net.online) throw new TypeError('Failed to fetch');
      if (url.origin !== 'https://app.test') return new Response('other origin', { status: 200 });
      if (url.pathname.startsWith('/d/')) {
        const res = new Response(net.pageStatus === 200 ? HTML : 'error page', { status: net.pageStatus, headers: { 'content-type': 'text/html; charset=utf-8' } });
        if (net.redirected) Object.defineProperty(res, 'redirected', { value: true });
        return res;
      }
      if (url.pathname === ASSETS[0]) return new Response(`@font-face{font-family:Inter;src:url(${CSS_FONT}) format("woff2")}body{color:#000}`, { status: 200, headers: { 'content-type': 'text/css' } });
      if (url.pathname === CSS_FONT) return new Response(`asset ${url.pathname}`, { status: 200 });
      if (ASSETS.some((a) => new URL(a, 'https://app.test').href === url.href)) return new Response(`asset ${url.pathname}`, { status: 200 });
      if (url.pathname.startsWith('/api/')) return new Response('{"data":{"stops":[]}}', { status: 200, headers: { 'content-type': 'application/json' } });
      return new Response('tenant page', { status: 200, headers: { 'content-type': 'text/html' } });
    };
    return { net, fetchImpl };
  }
  /** Install then activate, as the browser runs them after the page registered the worker. */
  async function installAndActivate(w: { listeners: Record<string, Listener> }) {
    for (const type of ['install', 'activate']) {
      const waits: Promise<unknown>[] = [];
      w.listeners[type]!({ waitUntil: (p: Promise<unknown>) => void waits.push(p) });
      await Promise.all(waits);
    }
  }

  it('ISSUE 8: a fresh first visit can reload offline - install keeps the open driver page and the files it loads', async () => {
    const c = memoryCaches();
    const { net, fetchImpl } = site();
    // The first visit loaded the page and its files from the network before any worker existed; the
    // page then registered the worker. Another window of the site shows a tenant page.
    const w = boot(c.storage, fetchImpl, [PAGE, 'https://app.test/t/acme/dispatch']);
    await installAndActivate(w);
    net.online = false; // the driver loses signal and reopens the link
    const page = await ask(w.listeners, PAGE, 'navigate');
    expect(page?.status).toBe(200);
    expect(await text(page)).toBe(HTML);
    expect(await text(await ask(w.listeners, `${PAGE}?from=qr`, 'navigate'))).toBe(HTML);
    for (const a of [...ASSETS.slice(1), CSS_FONT]) {
      const res = await ask(w.listeners, new URL(a, 'https://app.test').href);
      expect(res?.status, a).toBe(200);
      expect(await text(res), a).toBe(`asset ${new URL(a, 'https://app.test').pathname}`);
    }
    expect(await text(await ask(w.listeners, `https://app.test${ASSETS[0]}`))).toMatch(/^@font-face/);
    // Only the driver page and its own files: no API answer, no tenant page, no other origin.
    const keys = Object.values(c.kept()).flat();
    expect(keys.filter((k) => k.includes('/api/') || k.includes('/t/') || !k.startsWith('https://app.test/'))).toEqual([]);
    expect(c.kept()['riq-driver-pages-b1']).toEqual([`https://app.test/d/${TOKEN}`]);
  });

  it('ISSUE 8: install never fails over it - broken or missing storage, no network, no clients list: it installs and serves later', async () => {
    const cases: [string, Storage | undefined, boolean, string[] | null][] = [
      ['open rejects', { open: async () => Promise.reject(new Error('QuotaExceededError')), keys: async () => [] }, true, [PAGE]],
      ['no CacheStorage', undefined, true, [PAGE]],
      ['network down', memoryCaches().storage, false, [PAGE]],
      ['no clients.matchAll', memoryCaches().storage, true, null],
    ];
    for (const [name, storage, online, windows] of cases) {
      const { net, fetchImpl } = site();
      net.online = online;
      const w = boot(storage, fetchImpl, windows);
      await expect(installAndActivate(w), name).resolves.toBeUndefined();
      expect(w.claimed.n, name).toBe(1);
    }
  });

  it('ISSUE 8: an error page, a redirect or a page that is not HTML is not kept as the driver page', async () => {
    for (const make of [(n: ReturnType<typeof site>['net']) => (n.pageStatus = 404), (n: ReturnType<typeof site>['net']) => (n.pageStatus = 500), (n: ReturnType<typeof site>['net']) => (n.redirected = true)]) {
      const c = memoryCaches();
      const { net, fetchImpl } = site();
      make(net);
      const w = boot(c.storage, fetchImpl, [PAGE]);
      await installAndActivate(w);
      expect(c.kept()['riq-driver-pages-b1'] ?? []).toEqual([]);
    }
  });

  it('ISSUE 8: a link forgotten (revoked, replaced, expired) while install fetches its page is not kept, in any build\'s cache, and never again', async () => {
    const c = memoryCaches();
    // A copy kept by the worker of an older build (its caches not deleted yet).
    await (await c.storage.open('riq-driver-pages-old')).put(PAGE, new Response(HTML));
    const { net, fetchImpl } = site();
    let release!: () => void;
    net.hold = new Promise<void>((r) => (release = r));
    const w = boot(c.storage, fetchImpl, [PAGE]);
    const waits: Promise<unknown>[] = [];
    w.listeners.install!({ waitUntil: (p: Promise<unknown>) => void waits.push(p) });
    await new Promise((r) => setTimeout(r, 0));
    // The page found the link revoked and asked the (still installing) worker to forget it.
    w.listeners.message!({ data: { type: 'forget', url: `/d/${TOKEN}` }, waitUntil: (p: Promise<unknown>) => void waits.push(p) });
    release();
    net.hold = null;
    await Promise.all(waits);
    expect(c.kept()['riq-driver-pages-b1'] ?? []).toEqual([]);
    expect(c.kept()['riq-driver-pages-old']).toEqual([]);
    // Opened again online: the network's page is shown, and still not kept.
    expect(await text(await ask(w.listeners, PAGE, 'navigate'))).toBe(HTML);
    await new Promise((r) => setTimeout(r, 0));
    expect(c.kept()['riq-driver-pages-b1'] ?? []).toEqual([]);
  });

  it('ISSUE 8 review: a link forgotten under one build is not kept again by the next build\'s worker, though its dead tab is still open', async () => {
    const c = memoryCaches();
    const { fetchImpl } = site();
    const DEAD = 'https://app.test/d/YesterdayTokenXXXXXXXXXX';
    const LIVE = 'https://app.test/d/TodayTokenYYYYYYYYYYYYYY';
    const b1 = boot(c.storage, fetchImpl, [DEAD]);
    await installAndActivate(b1);
    const waits: Promise<unknown>[] = [];
    b1.listeners.message!({ data: { type: 'forget', url: '/d/YesterdayTokenXXXXXXXXXX' }, waitUntil: (p: Promise<unknown>) => void waits.push(p) });
    await Promise.all(waits);
    expect(c.kept()['riq-driver-pages-b1']).toEqual([]);
    // A deploy; the driver opens today's link: the new build's worker installs with the dead tab still open.
    const b2 = boot(c.storage, fetchImpl, [{ url: DEAD, controlled: true }, LIVE], 'b2');
    await installAndActivate(b2);
    expect(c.kept()['riq-driver-pages-b2']).toEqual([LIVE]);
    // Its navigation handler keeps it out too; no token in any cache key of what it remembers.
    await ask(b2.listeners, DEAD, 'navigate');
    await new Promise((r) => setTimeout(r, 5));
    expect(c.kept()['riq-driver-pages-b2']).toEqual([LIVE]);
    expect(Object.values(c.kept()).flat().filter((k) => k.includes('YesterdayToken'))).toEqual([]);
  });

  it('ISSUE 8 review: install fetches each file once, whatever the number of driver tabs open', async () => {
    const c = memoryCaches();
    const { net, fetchImpl } = site();
    const tabs = ['A', 'B', 'C'].map((x) => `https://app.test/d/${x.repeat(24)}`);
    await installAndActivate(boot(c.storage, fetchImpl, [...tabs, tabs[0]!]));
    const counts: Record<string, number> = {};
    for (const u of net.calls) counts[new URL(u).pathname] = (counts[new URL(u).pathname] ?? 0) + 1;
    for (const a of [...ASSETS, CSS_FONT]) expect(counts[new URL(a, 'https://app.test').pathname], a).toBe(1);
    for (const t of tabs) expect(counts[new URL(t).pathname], t).toBe(1);
  });

  it('ISSUE 8 review: a new build installed without signal keeps what the old build kept, so the reload still works offline', async () => {
    const c = memoryCaches();
    const { net, fetchImpl } = site();
    await installAndActivate(boot(c.storage, fetchImpl, [PAGE]));
    net.online = false; // a deploy, and the signal is gone while the new worker installs
    const b2 = boot(c.storage, fetchImpl, [{ url: PAGE, controlled: true }], 'b2');
    await installAndActivate(b2);
    expect(Object.keys(c.kept()).filter((n) => n.endsWith('-b1'))).toEqual([]); // the old build's caches are gone
    expect(await text(await ask(b2.listeners, PAGE, 'navigate'))).toBe(HTML);
    for (const a of [...ASSETS.slice(1), CSS_FONT]) expect((await ask(b2.listeners, new URL(a, 'https://app.test').href))?.status, a).toBe(200);
  });

  it('ISSUE 8: at most 8 driver pages are kept (the oldest go first)', async () => {
    const c = memoryCaches();
    const { fetchImpl } = site();
    const w = boot(c.storage, fetchImpl, []);
    for (let i = 0; i < 10; i++) {
      await ask(w.listeners, `https://app.test/d/${String(i).padStart(24, 'x')}`, 'navigate');
      await new Promise((r) => setTimeout(r, 5));
    }
    const pages = c.kept()['riq-driver-pages-b1']!;
    expect(pages).toHaveLength(8);
    expect(pages[0]).toBe(`https://app.test/d/${'2'.padStart(24, 'x')}`);
  });

  it('ISSUE 8: the page asks every worker of its registration to forget it (on a first visit none controls the page yet), once each, and never throws', async () => {
    const got: string[] = [];
    const worker = (name: string) => ({ postMessage: (m: { type: string; url: string }) => void got.push(`${name}:${m.type}:${m.url}`) });
    const active = worker('active');
    await forgetDriverPage({ serviceWorker: { controller: active, getRegistration: async () => ({ installing: worker('installing'), waiting: null, active }) } } as never, `/d/${TOKEN}`);
    expect(got).toEqual([`active:forget:/d/${TOKEN}`, `installing:forget:/d/${TOKEN}`]);
    got.length = 0;
    await forgetDriverPage({ serviceWorker: { controller: null, getRegistration: async () => ({ installing: worker('installing'), waiting: null, active: null }) } } as never, `/d/${TOKEN}`);
    expect(got).toEqual([`installing:forget:/d/${TOKEN}`]);
    // The link found dead before the page's registration even exists (seen in Chromium): no worker yet,
    // so the message goes to the worker once it is active - after its install kept the page.
    got.length = 0;
    let activate!: (reg: unknown) => void;
    const ready = new Promise((r) => (activate = r));
    await forgetDriverPage({ serviceWorker: { controller: null, getRegistration: async () => undefined, ready } } as never, `/d/${TOKEN}`);
    expect(got).toEqual([]);
    activate({ installing: null, waiting: null, active: worker('active') });
    await new Promise((r) => setTimeout(r, 0));
    expect(got).toEqual([`active:forget:/d/${TOKEN}`]);
    // Already sent to that worker while it installed: not sent twice.
    got.length = 0;
    const same = worker('w');
    await forgetDriverPage({ serviceWorker: { controller: null, getRegistration: async () => ({ installing: same, waiting: null, active: null }), ready: Promise.resolve({ active: same }) } } as never, `/d/${TOKEN}`);
    await new Promise((r) => setTimeout(r, 0));
    expect(got).toEqual([`w:forget:/d/${TOKEN}`]);
    await expect(forgetDriverPage({ serviceWorker: { controller: null, getRegistration: async () => Promise.reject(new Error('x')) } } as never, '/d/x')).resolves.toBeUndefined();
    await expect(forgetDriverPage({ serviceWorker: { controller: null, ready: Promise.reject(new Error('x')) } } as never, '/d/x')).resolves.toBeUndefined();
    await expect(forgetDriverPage({} as never, '/d/x')).resolves.toBeUndefined();
    await expect(forgetDriverPage(null, '/d/x')).resolves.toBeUndefined();
    // The page uses it.
    expect(readFileSync(path.resolve(__dirname, '../../app/d/[token]/driver-page.tsx'), 'utf8')).toMatch(/forgetDriverPage\(navigator, window\.location\.pathname\)/);
  });

  it('only production builds register it (next dev chunk URLs are not hashed: cache first would serve stale JS); a dev build removes an old one', async () => {
    expect(shouldRegisterWorker('production', { serviceWorker: {} })).toBe(true);
    expect(shouldRegisterWorker('development', { serviceWorker: {} })).toBe(false);
    expect(shouldRegisterWorker('test', { serviceWorker: {} })).toBe(false);
    expect(shouldRegisterWorker(undefined, { serviceWorker: {} })).toBe(false);
    expect(shouldRegisterWorker('production', {})).toBe(false); // a browser without service workers
    expect(shouldRegisterWorker('production', null)).toBe(false);
    const unregistered: string[] = [];
    const deleted: string[] = [];
    const reg = (scope: string) => ({ scope, unregister: async () => void unregistered.push(scope) });
    await dropDriverWorker({ serviceWorker: { getRegistrations: async () => [reg('https://app.test/d/'), reg('https://app.test/')] } } as never, {
      keys: async () => ['riq-driver-static-b1', 'riq-driver-pages-b1', 'other-cache'],
      delete: async (n: string) => (deleted.push(n), true),
    });
    expect(unregistered).toEqual(['https://app.test/d/']); // the driver page's own scope only
    expect(deleted).toEqual(['riq-driver-static-b1', 'riq-driver-pages-b1']);
    // Errors never reach the page.
    await expect(dropDriverWorker({ serviceWorker: { getRegistrations: async () => Promise.reject(new Error('x')) } } as never, { keys: async () => Promise.reject(new Error('x')), delete: async () => true })).resolves.toBeUndefined();
    await expect(dropDriverWorker({} as never, undefined)).resolves.toBeUndefined();
  });
});
