/**
 * The driver page's offline queue (owner request 4 Oct 2026, spec sections 13.1 to 13.3) on the
 * memory store: backoff, ordering, the answers per item and per request (429 keeps everything), held
 * arrivals released at dispatch, drafts committed with Save, a reissued link picking up the waiting
 * items and the clean-up of old truck-days. Synthetic data only.
 */
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
    const a1 = actionItem(NS, arrive('1:1'), T0);
    const a2 = actionItem(NS, result('1:1'), T0 + 10);
    const p = photo('1:1', T0 + 20, { body: { key: 'k', stop: '1:1', takenAt: '', positionStatus: 'TIMEOUT', positionUntil: T0 + 15_020 } });
    const held = actionItem(NS, arrive('2:1'), T0 + 5, true);
    const items = [p, a2, held, a1];
    expect(nextBatch(items, T0 + 100)).toEqual({ actions: [a1, a2], photo: null });
    // Once the actions went: the photo waits for its position (at most 15 s).
    expect(nextBatch([p], T0 + 100).photo).toBeNull();
    expect(nextBatch([p], T0 + 15_100).photo).toBe(p);
    // An action waiting for its backoff still holds a later photo back.
    const waiting = { ...a1, nextAt: T0 + 60_000 };
    expect(nextBatch([waiting, photo('1:1', T0 + 30)], T0 + 100)).toEqual({ actions: [], photo: null });
    expect(nextBatch(Array.from({ length: 60 }, (_, i) => actionItem(NS, arrive('1:1'), T0 + i)), T0 + 100).actions).toHaveLength(50);
  });
});

describe('the answers', () => {
  it('ok / duplicate remove; refused removes and reports; LOAD_NOT_DISPATCHED for an arrival is held; an error retries with backoff', () => {
    const items = [actionItem(NS, arrive('1:1'), T0), actionItem(NS, result('1:1'), T0 + 1), actionItem(NS, result('1:2'), T0 + 2), actionItem(NS, arrive('2:1'), T0 + 3), actionItem(NS, arrive('1:3'), T0 + 4)];
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
    expect(out.report).toEqual([expect.objectContaining({ key: items[2]!.key, stopKey: '1:2', code: 'PHOTO_REQUIRED', type: 'OUTCOME' })]);
    expect(out.update).toEqual([expect.objectContaining({ key: items[3]!.key, state: 'held' }), expect.objectContaining({ key: items[4]!.key, attempts: 1, nextAt: T0 + 100 + 5_000 })]);
    expect(out.sent).toEqual({ '1:1': { outcome: 'DELIVERED', at: new Date(T0).toISOString() } });
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
    const a = actionItem(NS, result('1:1'), T0);
    const p = photo('1:1', T0 + 1);
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
        return ok({ results: actions.map((x) => ({ key: x.key, status: 'ok' })), stops: { '1:1': { outcome: 'DELIVERED' } }, back: {} });
      },
      postPhoto: async (item) => ok({ photoId: item.key, status: 'ok', stops: {}, back: {} }),
    });
    expect(posted).toBe(1);
    expect(r.sent).toBe(2);
    expect(r.sentMap['1:1']).toMatchObject({ outcome: 'DELIVERED' });
    expect(await store.items(NS)).toEqual([]);
  });

  it("each round's results reach the page BEFORE its sent items leave the phone (a sent result never disappears in between)", async () => {
    const store = memoryStore();
    const a = actionItem(NS, result('1:1'), T0);
    const p = photo('1:1', T0 + 1);
    await store.put([a, p]);
    const seen: string[] = [];
    await flushQueue({
      store,
      ns: NS,
      now: () => T0 + 20_000,
      postActions: async (actions) => ok({ results: actions.map((x) => ({ key: x.key, status: 'ok' })), stops: { '1:1': { outcome: 'DELIVERED' } }, back: {} }),
      postPhoto: async (item) => ok({ photoId: item.key, status: 'ok', stops: { '1:1': { outcome: 'DELIVERED', photoIds: [item.key] } }, back: {} }),
      onResults: async (r) => {
        // When the results arrive, the item they answer is still on the phone.
        const keys = (await store.items(NS)).map((i) => i.key);
        seen.push(`${Object.keys(r.stops).join(',')}:${keys.includes(a.key) ? 'action kept' : 'action gone'}:${keys.includes(p.key) ? 'photo kept' : 'photo gone'}`);
      },
    });
    expect(seen).toEqual(['1:1:action kept:photo kept', '1:1:action gone:photo kept']);
    expect(await store.items(NS)).toEqual([]);
  });

  it('409 / 5xx keep the items for a retry; 404 / 410 stop sending; UPLOAD_CLOSED is reported', async () => {
    const store = memoryStore();
    const a = actionItem(NS, arrive('1:1'), T0);
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
    const p = photo('1:1', T0);
    await store.put([p]);
    const r = await flushQueue({ store, ns: NS, now: () => T0 + 10, postActions: async () => ok({ results: [] }), postPhoto: async () => ({ status: 409, body: { error: { code: 'PHOTO_LIMIT' } }, retryAfter: null }) });
    expect(r.reports).toEqual([expect.objectContaining({ key: p.key, code: 'PHOTO_LIMIT', type: 'PHOTO' })]);
    expect(await store.items(NS)).toEqual([]);
  });
});

describe('held items, drafts, namespaces', () => {
  it('held arrivals become ready once their trip is dispatched, with their original times; they are not counted as waiting', () => {
    const h1 = actionItem(NS, arrive('1:1'), T0, true);
    const h2 = actionItem(NS, arrive('2:1'), T0 + 1, true);
    expect(waitingCount([h1, h2])).toBe(0);
    const released = releaseHeld([h1, h2], new Set([1]), T0 + 500);
    expect(released).toEqual([expect.objectContaining({ key: h1.key, state: 'ready', body: h1.body })]);
  });

  it('Save commits the draft photos and the result in one step; other drafts of the stop go; Cancel drops them', async () => {
    const store = memoryStore();
    const used = photo('1:1', T0, { state: 'draft' });
    const retaken = photo('1:1', T0 + 1, { state: 'draft' });
    const otherStop = photo('1:2', T0 + 2, { state: 'draft' });
    await store.put([used, retaken, otherStop]);
    await store.putDraft(NS, '1:1', { outcome: 'DELIVERED', reason: null, note: '', lines: {}, photoKeys: [used.key], pendingPhotoKey: null, noPhoto: false, savedAt: T0 });
    const action = actionItem(NS, { ...result('1:1'), photoKeys: [used.key] } as DriverAction, T0 + 10);
    await store.commit(NS, '1:1', [used.key], action);
    const after = await store.items(NS);
    expect(after.find((i) => i.key === used.key)).toMatchObject({ state: 'ready', createdAt: T0 + 11 });
    expect(after.find((i) => i.key === retaken.key)).toBeUndefined();
    expect(after.find((i) => i.key === action.key)).toMatchObject({ state: 'ready' });
    expect(await store.getDraft(NS, '1:1')).toBeNull();
    // The photo goes after its result.
    expect(nextBatch(after, T0 + 100).actions.map((i) => i.key)).toEqual([action.key]);
    await store.dropDrafts(NS, '1:2');
    expect((await store.items(NS)).find((i) => i.key === otherStop.key)).toBeUndefined();
  });

  it('a reissued link on the same phone picks up the waiting items (the namespace is the truck-day, not the link)', async () => {
    const store = memoryStore();
    await store.put([actionItem(NS, result('1:1'), T0)]);
    await store.putLink('old-link-hash', { ns: NS, trackingOn: true });
    await store.putLink('new-link-hash', { ns: NS, trackingOn: false });
    expect((await store.getLink('new-link-hash'))!.ns).toBe(NS);
    expect(await store.items(NS)).toHaveLength(1);
  });

  it('truck-days 5 or more days before the phone\'s date are deleted with everything they kept', async () => {
    const store = memoryStore();
    const old = 't5|2026-09-29';
    await store.put([{ ...actionItem(old, result('1:1'), T0) }, actionItem(NS, result('1:1'), T0)]);
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
