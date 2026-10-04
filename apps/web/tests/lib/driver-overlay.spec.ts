/**
 * What the driver page shows: the server's state plus what is still on the phone (owner request
 * 4 Oct 2026, spec section 13.5). applyQueued, stopInProgress and the unsent list. Synthetic stops
 * ACME and BETA on truck T05.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DriverAction, DriverManifest, ManifestStop, StopResult } from '@/lib/driver-link/manifest-types';
import { applyQueued, stopInProgress, unsentList } from '@/lib/driver-page/overlay';
import { actionItem, newKey, type QueueItem } from '@/lib/driver-page/queue';
import { Host } from './hook-host';

// The tracker hook (app/d/[token]/use-tracker.ts) runs on the hook host: React's hooks replaced.
vi.mock('react', async (importActual) => (await import('./hook-host')).mockReactHooks(importActual));
const { useTracker } = await import('@/app/d/[token]/use-tracker');

const NS = 't5|2026-10-05';
const T0 = Date.parse('2026-10-05T06:00:00Z');

function stop(seq: number, name: string, result: StopResult | null = null): ManifestStop {
  return {
    key: `1:${seq}`,
    sequence: seq,
    customerName: name,
    customerCode: name,
    branchCode: null,
    address: null,
    lat: 23.6,
    lng: 58.4 + seq / 100,
    navUrl: null,
    etaMin: 480,
    untilMin: 500,
    hours: null,
    promised: null,
    cases: 40,
    orders: [{ orderId: `O${seq}`, salesOrders: [], lines: [{ lineId: `A${seq}`, productCode: 'A', productName: 'Water', cases: 30 }, { lineId: `B${seq}`, productCode: 'B', productName: 'Juice', cases: 10 }] }],
    notes: [],
    accessNotes: null,
    split: null,
    carriedFrom: null,
    changeNotes: [],
    result,
  };
}

function serverResult(over: Partial<StopResult>): StopResult {
  return {
    state: 'DONE',
    arrivedAt: null,
    arrivalObserved: true,
    departedAt: null,
    minutes: null,
    outcome: 'DELIVERED',
    reason: null,
    note: null,
    outcomeAt: new Date(T0).toISOString(),
    by: 'DRIVER',
    casesDelivered: 40,
    lines: null,
    photoIds: [],
    proofPhotos: 0,
    noPhotoReason: null,
    late: false,
    editable: true,
    carriedTo: null,
    ...over,
  };
}

function manifest(stops: ManifestStop[], backAtDepotAt: string | null = null): Pick<DriverManifest, 'loads'> {
  return { loads: [{ loadNo: 1, trips: 1, status: 'DISPATCHED', actionable: true, departMin: 430, returnMin: 900, driverName: 'Salim', cases: 80, backAtDepotAt, stops }] };
}

const item = (a: DriverAction, at = T0, held = false): QueueItem => actionItem(NS, a, at, held);

describe('applyQueued', () => {
  it('an unsent result shows "saved on phone" and ends the stop for the tracker; it is never offered again', () => {
    const r = item({ key: newKey(), type: 'OUTCOME', stop: '1:1', at: new Date(T0).toISOString(), outcome: 'PARTLY_DELIVERED', reason: 'DAMAGED_GOODS', lines: [{ lineId: 'B1', delivered: 4 }], photoKeys: [] });
    const [l] = applyQueued(manifest([stop(1, 'ACME'), stop(2, 'BETA')]), [r]);
    expect(l!.stops[0]!.view).toMatchObject({ outcome: 'PARTLY_DELIVERED', pending: true, doneAt: T0, casesDelivered: 34, state: 'DONE', reason: 'DAMAGED_GOODS' });
    expect(l!.stops[1]!.view).toMatchObject({ outcome: null, pending: false, doneAt: null });
  });

  it('an unsent arrival shows its time and the running timer', () => {
    const a = item({ key: newKey(), type: 'ARRIVE', stop: '1:2', at: new Date(T0 + 60_000).toISOString(), mode: 'AUTO', observed: false });
    const [l] = applyQueued(manifest([stop(1, 'ACME'), stop(2, 'BETA')]), [a]);
    expect(l!.stops[1]!.view).toMatchObject({ arrivedAt: T0 + 60_000, arrivalObserved: false, state: 'ARRIVED', pending: true });
    expect(stopInProgress([l!], 1)).toEqual({ key: '1:2', arrivedAt: T0 + 60_000, observed: false });
  });

  it('an unsent Back at depot closes the trip on the phone', () => {
    const b = item({ key: newKey(), type: 'BACK_AT_DEPOT', load: 1, at: new Date(T0 + 3_600_000).toISOString() });
    const [l] = applyQueued(manifest([stop(1, 'ACME')]), [b]);
    expect(l).toMatchObject({ back: true, backAt: T0 + 3_600_000, backPending: true });
    const [server] = applyQueued(manifest([stop(1, 'ACME')], new Date(T0).toISOString()), []);
    expect(server).toMatchObject({ back: true, backPending: false });
  });

  it('a server result that differs from what this phone sent, with nothing left to send, shows "changed by office / another phone"', () => {
    const m = manifest([stop(1, 'ACME', serverResult({ outcome: 'NOT_DELIVERED', reason: 'SHOP_CLOSED', by: 'OFFICE', casesDelivered: 0 }))]);
    const sent = { '1:1': { outcome: 'DELIVERED' as const, at: new Date(T0).toISOString() } };
    expect(applyQueued(m, [], sent)[0]!.stops[0]!.view).toMatchObject({ outcome: 'NOT_DELIVERED', changedByOffice: true });
    // The same result: nothing to flag. Something still to send: the phone's own result shows.
    expect(applyQueued(manifest([stop(1, 'ACME', serverResult({}))]), [], sent)[0]!.stops[0]!.view.changedByOffice).toBe(false);
    const pending = item({ key: newKey(), type: 'OUTCOME', stop: '1:1', at: new Date(T0 + 1).toISOString(), outcome: 'DELIVERED', photoKeys: [] });
    expect(applyQueued(m, [pending], sent)[0]!.stops[0]!.view).toMatchObject({ outcome: 'DELIVERED', pending: true, changedByOffice: false });
  });

  it('draft photos do not count; queued photos are counted per stop; a server ARRIVED stop is in progress', () => {
    const draft: QueueItem = { ...item({ key: newKey(), type: 'ARRIVE', stop: '1:1', at: new Date(T0).toISOString(), mode: 'AUTO' }), kind: 'photo', state: 'draft' };
    const ready: QueueItem = { ...draft, key: newKey(), state: 'ready' };
    const m = manifest([stop(1, 'ACME', serverResult({ state: 'ARRIVED', outcome: null, outcomeAt: null, casesDelivered: null, arrivedAt: new Date(T0).toISOString() }))]);
    const [l] = applyQueued(m, [draft, ready]);
    expect(l!.stops[0]!.view).toMatchObject({ localPhotos: 1, state: 'ARRIVED', doneAt: null });
    expect(stopInProgress([l!], 1)).toEqual({ key: '1:1', arrivedAt: T0, observed: true });
  });

  it('lists the unsent results for the "link replaced" page', () => {
    const r = item({ key: newKey(), type: 'OUTCOME', stop: '1:2', at: new Date(T0).toISOString(), outcome: 'NOT_DELIVERED', reason: 'SHOP_CLOSED', photoKeys: [] });
    const loads = applyQueued(manifest([stop(1, 'ACME'), stop(2, 'BETA')]), [r]);
    expect(unsentList(loads, [r])).toEqual([{ stopKey: '1:2', customer: 'BETA', outcome: 'NOT_DELIVERED', at: new Date(T0).toISOString() }]);
  });
});

// ---------------------------------------------------------------------------------------
// The tracker hook on the page (review of 4 Oct 2026), on the hook host (no DOM).
// ---------------------------------------------------------------------------------------
describe('useTracker on the page', () => {
  const DEPOT = { lat: 23.6, lng: 58.3 };
  const queuedArrive = () => item({ key: newKey(), type: 'ARRIVE', stop: '1:2', at: new Date(T0 + 60_000).toISOString(), mode: 'AUTO' });
  const base = (loads: ReturnType<typeof applyQueued>, over: { ready?: boolean } = {}): Parameters<typeof useTracker>[0] => ({
    loads,
    depot: DEPOT,
    radiusM: 100,
    nowMinOf: () => 600,
    enqueue: () => undefined,
    resume: false,
    onTrackingChange: () => undefined,
    ...over,
  });

  beforeEach(() => {
    vi.stubGlobal('document', { visibilityState: 'visible', addEventListener: () => undefined, removeEventListener: () => undefined });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('after a reload the trip starts only once the queue was read: an arrival still waiting to send restores its stop with its own time', () => {
    const m = manifest([stop(1, 'ACME', serverResult({})), stop(2, 'BETA')]);
    const host = new Host(useTracker, base(applyQueued(m, []), { ready: false }));
    host.render();
    expect(host.tree.state.phase).toBe('SEEKING');
    host.render({ loads: applyQueued(m, [queuedArrive()]), ready: true });
    expect(host.tree.state).toMatchObject({ phase: 'AT_STOP', key: '1:2', arrivedAt: T0 + 60_000 });
  });

  it('"Back at depot?" belongs to the trip it was raised for: dispatching trip 2 clears it', () => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    let watcher: ((p: { coords: { latitude: number; longitude: number; accuracy: number; speed: number | null }; timestamp: number }) => void) | null = null;
    vi.stubGlobal('navigator', { geolocation: { watchPosition: (cb: typeof watcher) => ((watcher = cb), 1), clearWatch: () => undefined } });
    const done = manifest([stop(1, 'ACME', serverResult({}))]);
    const host = new Host(useTracker, base(applyQueued(done, [])));
    host.render();
    host.tree.start();
    host.flush();
    for (let s = 0; s <= 130; s += 5) {
      vi.setSystemTime(T0 + s * 1000);
      watcher!({ coords: { latitude: DEPOT.lat, longitude: DEPOT.lng, accuracy: 10, speed: 0 }, timestamp: Date.now() });
      host.flush();
    }
    expect(host.tree.backSuggested).toBe(1);
    // The dispatcher dispatches trip 2: the suggestion is not carried over to it.
    const twoTrips = { loads: [...done.loads, { ...done.loads[0]!, loadNo: 2, trips: 2, stops: [{ ...stop(1, 'GAMMA'), key: '2:1' }] }] };
    host.render({ loads: applyQueued(twoTrips, []) });
    expect(host.tree.trip).toMatchObject({ loadNo: 2 });
    expect(host.tree.backSuggested).toBeNull();
  });

  it('the last trip back at the depot ends the position watch and shows the timer off; a trip dispatched later starts it again; a timer the driver stopped stays stopped (demo fix, 4 Oct 2026)', () => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    const watched: number[] = [];
    const cleared: number[] = [];
    const saved: boolean[] = [];
    vi.stubGlobal('navigator', {
      geolocation: {
        watchPosition: () => {
          watched.push(watched.length + 1);
          return watched.length;
        },
        clearWatch: (id: number) => cleared.push(id),
      },
    });
    const first = manifest([stop(1, 'ACME'), stop(2, 'BETA')]).loads[0]!;
    const trip = (loadNo: number, over: Partial<typeof first> = {}) => ({ ...first, loadNo, trips: 3, stops: [{ ...stop(1, 'GAMMA'), key: `${loadNo}:1` }], ...over });
    const backAt = new Date(T0 + 3_600_000).toISOString();
    const host = new Host(useTracker, { ...base(applyQueued({ loads: [first] }, [])), onTrackingChange: (on: boolean) => void saved.push(on) });
    host.render();
    host.tree.start();
    host.flush();
    expect(host.tree).toMatchObject({ on: true, trip: { loadNo: 1 } });
    expect(saved).toEqual([true]);

    // "Back at depot" on the only trip: nothing left to time -> the watch ends, the page shows the timer off.
    const done = applyQueued({ loads: [{ ...first, backAtDepotAt: backAt }] }, []);
    host.render({ loads: done });
    expect(host.tree).toMatchObject({ on: false, gps: 'idle', trip: null });
    expect(cleared).toEqual([1]);
    expect(saved).toEqual([true]); // the saved "timer on" is kept: a reload during the wait restarts it too
    host.render({ loads: done });
    expect(watched).toEqual([1]); // still nothing on the road: not started again

    // Trip 2 is dispatched later: the watch starts again without a tap.
    host.render({ loads: applyQueued({ loads: [{ ...first, backAtDepotAt: backAt }, trip(2)] }, []) });
    expect(host.tree).toMatchObject({ on: true, trip: { loadNo: 2, held: false } });
    expect(watched).toEqual([1, 2]);

    // A timer the driver stops by hand is not started again by the next trip.
    host.tree.stop();
    host.flush();
    expect(host.tree.on).toBe(false);
    expect(cleared).toEqual([1, 2]);
    host.render({ loads: applyQueued({ loads: [{ ...first, backAtDepotAt: backAt }, trip(2, { backAtDepotAt: backAt }), trip(3)] }, []) });
    expect(host.tree.on).toBe(false);
    expect(watched).toEqual([1, 2]);
  });
});

describe('the result sheet (review of 4 Oct 2026)', () => {
  const draft = (over: Record<string, unknown> = {}) => ({ outcome: 'PARTLY_DELIVERED', reason: 'DAMAGED_GOODS', note: '', lines: { A1: 28 }, photoKeys: [], pendingPhotoKey: null, noPhoto: false, savedAt: T0, ...over }) as never;
  it('a changed result saves without a new photo when an earlier Delivered or Partly named one (on the server or still on the phone); a first result still needs one', async () => {
    const { canSave, proofPhotos } = await import('@/app/d/[token]/outcome-flow');
    const [l] = applyQueued(manifest([stop(1, 'ACME', serverResult({ photoIds: ['p1', 'p2', 'p3'], proofPhotos: 3 })), stop(2, 'BETA')]), []);
    expect(proofPhotos(l!.stops[0]!)).toBe(3);
    expect(canSave(l!.stops[0]!, draft(), true)).toBe(true);
    expect(canSave(l!.stops[1]!, draft(), true)).toBe(false);
    expect(canSave(l!.stops[1]!, draft({ noPhoto: true }), true)).toBe(true);
    // Delivered with P1 is still on the phone (weak signal), its photo too: the change counts it, as the server will.
    const queued = item({ key: newKey(), type: 'OUTCOME', stop: '1:2', at: new Date(T0).toISOString(), outcome: 'DELIVERED', photoKeys: [newKey()] });
    const [q] = applyQueued(manifest([stop(1, 'ACME'), stop(2, 'BETA')]), [queued]);
    expect(proofPhotos(q!.stops[1]!)).toBe(1);
    expect(canSave(q!.stops[1]!, draft(), true)).toBe(true);
  });

  it('the photo heading says "Photo required" only while no photo is on the draft: a photo just added counts (demo fix, 4 Oct 2026)', async () => {
    const { photoStillRequired } = await import('@/app/d/[token]/outcome-flow');
    const [l] = applyQueued(manifest([stop(1, 'ACME', serverResult({ photoIds: ['p1'], proofPhotos: 1 })), stop(2, 'BETA')]), []);
    const fresh = l!.stops[1]!;
    expect(photoStillRequired(fresh, 'DELIVERED', true, 0)).toBe(true);
    expect(photoStillRequired(fresh, 'PARTLY_DELIVERED', true, 0)).toBe(true);
    expect(photoStillRequired(fresh, 'DELIVERED', true, 1)).toBe(false); // a photo was added to the draft
    expect(photoStillRequired(fresh, 'NOT_DELIVERED', true, 0)).toBe(false); // optional for Not delivered
    expect(photoStillRequired(fresh, 'DELIVERED', false, 0)).toBe(false); // the company does not require one
    expect(photoStillRequired(l!.stops[0]!, 'DELIVERED', true, 0)).toBe(false); // an earlier Delivered's photo is the proof
    // The component uses it for the heading and for "Camera not working", with the draft's photo count.
    const flow = readFileSync(path.resolve(__dirname, '../../app/d/[token]/outcome-flow.tsx'), 'utf8');
    expect(flow).toContain('photoStillRequired(stop, outcome, photoRequired, photos.length)');
    expect(flow).toContain("{photoNeeded ? t(lang, 'photoRequired') : t(lang, 'photosLabel', { n: photos.length + kept })}");
  });

  it('the driver page keeps "Cases: N" together on a stop row (nowrap) and registers the worker in production builds only', () => {
    const page = readFileSync(path.resolve(__dirname, '../../app/d/[token]/driver-page.tsx'), 'utf8');
    expect(page).toContain(`<span className="whitespace-nowrap">{t(lang, 'casesLabel', { n: s.cases })}</span>`);
    expect(page).toContain('shouldRegisterWorker(process.env.NODE_ENV, navigator)');
    expect(page).not.toMatch(/if \('serviceWorker' in navigator\) void navigator\.serviceWorker\.register/);
  });

  it('photos taken for a Not delivered are no proof for a later Delivered (a return visit takes its own photo)', async () => {
    const { canSave, proofPhotos } = await import('@/app/d/[token]/outcome-flow');
    const shut = serverResult({ outcome: 'NOT_DELIVERED', reason: 'SHOP_CLOSED', casesDelivered: 0, photoIds: ['p1'], proofPhotos: 0 });
    const [l] = applyQueued(manifest([stop(1, 'ACME', shut)]), []);
    expect(proofPhotos(l!.stops[0]!)).toBe(0);
    expect(canSave(l!.stops[0]!, draft({ outcome: 'DELIVERED', reason: null }), true)).toBe(false);
    // The same on the phone: a queued Not delivered with a photo.
    const queued = item({ key: newKey(), type: 'OUTCOME', stop: '1:1', at: new Date(T0).toISOString(), outcome: 'NOT_DELIVERED', reason: 'SHOP_CLOSED', photoKeys: [newKey()] });
    const [q] = applyQueued(manifest([stop(1, 'ACME')]), [queued]);
    expect(proofPhotos(q!.stops[0]!)).toBe(0);
    expect(canSave(q!.stops[0]!, draft({ outcome: 'DELIVERED', reason: null }), true)).toBe(false);
  });
});
