/**
 * What the driver page shows: the server's state plus what is still on the phone (owner request
 * 4 Oct 2026, spec section 13.5). applyQueued, stopInProgress and the unsent list. Synthetic stops
 * ACME and BETA on truck T05.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DriverAction, DriverManifest, ManifestStop, StopResult } from '@/lib/driver-link/manifest-types';
import { applyQueued, LEAVE_RETAP_MIN, leaveOffer, stopInProgress, unsentList } from '@/lib/driver-page/overlay';
import { actionItem, newKey, type QueueItem } from '@/lib/driver-page/queue';
import { Host } from './hook-host';

// The tracker hook (app/d/[token]/use-tracker.ts) runs on the hook host: React's hooks replaced.
vi.mock('react', async (importActual) => (await import('./hook-host')).mockReactHooks(importActual));
const { recentPosOf, useTracker } = await import('@/app/d/[token]/use-tracker');

const NS = 't5|2026-10-05';
const T0 = Date.parse('2026-10-05T06:00:00Z');

function stop(seq: number, name: string, result: StopResult | null = null): ManifestStop {
  return {
    key: `D1:1:${seq}`,
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
  return { loads: [{ key: 'D1:1', depotId: 'D1', loadNo: 1, trips: 1, status: 'DISPATCHED', actionable: true, departMin: 430, returnMin: 900, driverName: 'Salim', cases: 80, backAtDepotAt, stops }] };
}

const item = (a: DriverAction, at = T0, held = false): QueueItem => actionItem(NS, a, at, held);

describe('applyQueued', () => {
  it('an unsent result shows "saved on phone" and ends the stop for the tracker; it is never offered again', () => {
    const r = item({ key: newKey(), type: 'OUTCOME', stop: 'D1:1:1', at: new Date(T0).toISOString(), outcome: 'PARTLY_DELIVERED', reason: 'DAMAGED_GOODS', lines: [{ lineId: 'B1', delivered: 4 }], photoKeys: [] });
    const [l] = applyQueued(manifest([stop(1, 'ACME'), stop(2, 'BETA')]), [r]);
    expect(l!.stops[0]!.view).toMatchObject({ outcome: 'PARTLY_DELIVERED', pending: true, doneAt: T0, casesDelivered: 34, state: 'DONE', reason: 'DAMAGED_GOODS' });
    expect(l!.stops[1]!.view).toMatchObject({ outcome: null, pending: false, doneAt: null });
  });

  it('an unsent arrival shows its time and the running timer', () => {
    const a = item({ key: newKey(), type: 'ARRIVE', stop: 'D1:1:2', at: new Date(T0 + 60_000).toISOString(), mode: 'AUTO', observed: false });
    const [l] = applyQueued(manifest([stop(1, 'ACME'), stop(2, 'BETA')]), [a]);
    expect(l!.stops[1]!.view).toMatchObject({ arrivedAt: T0 + 60_000, arrivalObserved: false, state: 'ARRIVED', pending: true });
    expect(stopInProgress([l!], 'D1:1')).toEqual({ key: 'D1:1:2', arrivedAt: T0 + 60_000, observed: false });
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
    const sent = { 'D1:1:1': { outcome: 'DELIVERED' as const, at: new Date(T0).toISOString() } };
    expect(applyQueued(m, [], sent)[0]!.stops[0]!.view).toMatchObject({ outcome: 'NOT_DELIVERED', changedByOffice: true });
    // The same result: nothing to flag. Something still to send: the phone's own result shows.
    expect(applyQueued(manifest([stop(1, 'ACME', serverResult({}))]), [], sent)[0]!.stops[0]!.view.changedByOffice).toBe(false);
    const pending = item({ key: newKey(), type: 'OUTCOME', stop: 'D1:1:1', at: new Date(T0 + 1).toISOString(), outcome: 'DELIVERED', photoKeys: [] });
    expect(applyQueued(m, [pending], sent)[0]!.stops[0]!.view).toMatchObject({ outcome: 'DELIVERED', pending: true, changedByOffice: false });
  });

  it('draft photos do not count; queued photos are counted per stop; a server ARRIVED stop is in progress', () => {
    const draft: QueueItem = { ...item({ key: newKey(), type: 'ARRIVE', stop: 'D1:1:1', at: new Date(T0).toISOString(), mode: 'AUTO' }), kind: 'photo', state: 'draft' };
    const ready: QueueItem = { ...draft, key: newKey(), state: 'ready' };
    const m = manifest([stop(1, 'ACME', serverResult({ state: 'ARRIVED', outcome: null, outcomeAt: null, casesDelivered: null, arrivedAt: new Date(T0).toISOString() }))]);
    const [l] = applyQueued(m, [draft, ready]);
    expect(l!.stops[0]!.view).toMatchObject({ localPhotos: 1, state: 'ARRIVED', doneAt: null });
    expect(stopInProgress([l!], 'D1:1')).toEqual({ key: 'D1:1:1', arrivedAt: T0, observed: true });
  });

  it('lists the unsent results for the "link replaced" page', () => {
    const r = item({ key: newKey(), type: 'OUTCOME', stop: 'D1:1:2', at: new Date(T0).toISOString(), outcome: 'NOT_DELIVERED', reason: 'SHOP_CLOSED', photoKeys: [] });
    const loads = applyQueued(manifest([stop(1, 'ACME'), stop(2, 'BETA')]), [r]);
    expect(unsentList(loads, [r])).toEqual([{ stopKey: 'D1:1:2', customer: 'BETA', outcome: 'NOT_DELIVERED', at: new Date(T0).toISOString() }]);
  });
});

// ---------------------------------------------------------------------------------------
// The tracker hook on the page (review of 4 Oct 2026), on the hook host (no DOM).
// ---------------------------------------------------------------------------------------
describe('useTracker on the page', () => {
  const DEPOT = { lat: 23.6, lng: 58.3 };
  const queuedArrive = () => item({ key: newKey(), type: 'ARRIVE', stop: 'D1:1:2', at: new Date(T0 + 60_000).toISOString(), mode: 'AUTO' });
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
    expect(host.tree.state).toMatchObject({ phase: 'AT_STOP', key: 'D1:1:2', arrivedAt: T0 + 60_000 });
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
    expect(host.tree.backSuggested).toBe('D1:1');
    // The dispatcher dispatches trip 2: the suggestion is not carried over to it.
    const twoTrips = { loads: [...done.loads, { ...done.loads[0]!, key: 'D1:2', loadNo: 2, trips: 2, stops: [{ ...stop(1, 'GAMMA'), key: 'D1:2:1' }] }] };
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
    const trip = (loadNo: number, over: Partial<typeof first> = {}) => ({ ...first, key: `D1:${loadNo}`, loadNo, trips: 3, stops: [{ ...stop(1, 'GAMMA'), key: `D1:${loadNo}:1` }], ...over });
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
    const queued = item({ key: newKey(), type: 'OUTCOME', stop: 'D1:1:2', at: new Date(T0).toISOString(), outcome: 'DELIVERED', photoKeys: [newKey()] });
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
    const queued = item({ key: newKey(), type: 'OUTCOME', stop: 'D1:1:1', at: new Date(T0).toISOString(), outcome: 'NOT_DELIVERED', reason: 'SHOP_CLOSED', photoKeys: [newKey()] });
    const [q] = applyQueued(manifest([stop(1, 'ACME')]), [queued]);
    expect(proofPhotos(q!.stops[0]!)).toBe(0);
    expect(canSave(q!.stops[0]!, draft({ outcome: 'DELIVERED', reason: null }), true)).toBe(false);
  });
});

describe('Leaving for next load (owner decision 16 Oct 2026: R2 is measured from the driver taps)', () => {
  const trip = (loadNo: number, over: Partial<DriverManifest['loads'][number]> = {}): DriverManifest['loads'][number] => ({
    key: `D1:${loadNo}`,
    depotId: 'D1',
    loadNo,
    trips: 3,
    status: 'DISPATCHED',
    actionable: true,
    departMin: 400 + loadNo * 200,
    returnMin: 560 + loadNo * 200,
    driverName: 'Salim',
    cases: 40,
    backAtDepotAt: null,
    leftDepotAt: null,
    stops: [{ ...stop(1, `SHOP${loadNo}`), key: `D1:${loadNo}:1` }],
    ...over,
  });
  const at = (min: number) => new Date(T0 + min * 60_000).toISOString();
  const day = (...loads: DriverManifest['loads']) => ({ loads });
  const offerOf = (m: Pick<DriverManifest, 'loads'>, items: QueueItem[] = [], now?: number) => {
    const o = leaveOffer(applyQueued(m, items), now);
    return o ? { from: o.from.loadNo, to: o.to.loadNo } : null;
  };

  it('is offered after Back at depot when the truck has a later trip that day, for that next trip', () => {
    // Trip 1 out: nothing to offer yet.
    expect(offerOf(day(trip(1), trip(2, { status: 'LOCKED', actionable: false })))).toBeNull();
    // Trip 1 back: leave with trip 2 (not dispatched yet: the dispatcher may press Dispatch later).
    expect(offerOf(day(trip(1, { status: 'COMPLETED', backAtDepotAt: at(300) }), trip(2, { status: 'LOCKED', actionable: false })))).toEqual({ from: 1, to: 2 });
    // A Back at depot still on the phone counts too.
    const back = item({ key: newKey(), type: 'BACK_AT_DEPOT', load: 1, depot: 'D1', at: at(300) });
    expect(offerOf(day(trip(1), trip(2, { status: 'LOADING' })), [back])).toEqual({ from: 1, to: 2 });
  });

  it('never after the last trip, and never on a one-trip day', () => {
    expect(offerOf(day(trip(1, { trips: 1, backAtDepotAt: at(300) })))).toBeNull();
    expect(offerOf(day(trip(1, { status: 'COMPLETED', backAtDepotAt: at(300), leftDepotAt: null }), trip(2, { leftDepotAt: at(330), backAtDepotAt: at(520) })))).toBeNull();
  });

  it('gone once tapped (on the server, still on the phone, or held for a Planned trip) when the page does not say the time; not when the truck is already at a stop of it', () => {
    const backDay = (over: Partial<DriverManifest['loads'][number]> = {}) => day(trip(1, { status: 'COMPLETED', backAtDepotAt: at(300) }), trip(2, over));
    expect(offerOf(backDay({ leftDepotAt: at(330) }))).toBeNull();
    const leave = item({ key: newKey(), type: 'DEPOT_DEPART', load: 2, depot: 'D1', at: at(330) });
    expect(offerOf(backDay(), [leave])).toBeNull();
    const held = item({ key: newKey(), type: 'DEPOT_DEPART', load: 2, depot: 'D1', at: at(330) }, T0, true);
    expect(offerOf(backDay({ status: 'PLANNED', actionable: false }), [held])).toBeNull();
    // The driver forgot to tap and is already at trip 2's first stop: the arrival stands in for it.
    const arrived = item({ key: newKey(), type: 'ARRIVE', stop: 'D1:2:1', at: at(360), mode: 'MANUAL' });
    expect(offerOf(backDay(), [arrived])).toBeNull();
    expect(offerOf(backDay({ status: 'COMPLETED' }))).toBeNull();
  });

  it('review finding 2: offered again for 30 min after the tap, to correct a tap made too early; then gone', () => {
    const backDay = (over: Partial<DriverManifest['loads'][number]> = {}) => day(trip(1, { status: 'COMPLETED', backAtDepotAt: at(300) }), trip(2, over));
    const ms = (min: number) => T0 + min * 60_000;
    expect(offerOf(backDay({ leftDepotAt: at(330) }), [], ms(331))).toEqual({ from: 1, to: 2 });
    expect(offerOf(backDay({ leftDepotAt: at(330) }), [], ms(330 + LEAVE_RETAP_MIN))).toEqual({ from: 1, to: 2 });
    expect(offerOf(backDay({ leftDepotAt: at(330) }), [], ms(331 + LEAVE_RETAP_MIN))).toBeNull();
    // A second tap still on the phone restarts the 30 min and is the one shown.
    const again = item({ key: newKey(), type: 'DEPOT_DEPART', load: 2, depot: 'D1', at: at(350) });
    expect(offerOf(backDay({ leftDepotAt: at(330) }), [again], ms(331 + LEAVE_RETAP_MIN))).toEqual({ from: 1, to: 2 });
    const [, l2] = applyQueued(backDay({ leftDepotAt: at(330) }), [again]);
    expect(l2).toMatchObject({ left: true, leftAt: ms(350), leftPending: true });
    // The server's later tap wins over an older one still on the phone.
    const older = item({ key: newKey(), type: 'DEPOT_DEPART', load: 2, depot: 'D1', at: at(320) });
    expect(applyQueued(backDay({ leftDepotAt: at(330) }), [older])[1]).toMatchObject({ leftAt: ms(330), leftPending: false });
    // Not once the truck is at a stop of the trip.
    const arrived = item({ key: newKey(), type: 'ARRIVE', stop: 'D1:2:1', at: at(345), mode: 'MANUAL' });
    expect(offerOf(backDay({ leftDepotAt: at(330) }), [arrived], ms(346))).toBeNull();
  });

  it('merge review of 17 Oct 2026, finding 2: a GPS-only arrival at a stop of the next trip does not take the offer away (rule R2 ignores GPS times, so the tap still counts)', () => {
    const gpsOnly = serverResult({ state: 'ARRIVED', arrivedAt: at(350), arrivalByGps: true, outcome: null, outcomeAt: null, casesDelivered: null, by: null });
    const next = trip(2, { stops: [{ ...stop(1, 'SHOP2', gpsOnly), key: 'D1:2:1' }] });
    const [, l2] = applyQueued(day(trip(1, { status: 'COMPLETED', backAtDepotAt: at(300) }), next), []);
    expect(l2!.stops[0]!.view).toMatchObject({ arrivedAt: null, doneAt: null, gpsArrivedAt: T0 + 350 * 60_000 });
    expect(offerOf(day(trip(1, { status: 'COMPLETED', backAtDepotAt: at(300) }), next))).toEqual({ from: 1, to: 2 });
    // The driver's own arrival there still takes it away.
    const arrived = item({ key: newKey(), type: 'ARRIVE', stop: 'D1:2:1', at: at(355), mode: 'MANUAL' });
    expect(offerOf(day(trip(1, { status: 'COMPLETED', backAtDepotAt: at(300) }), next), [arrived])).toBeNull();
  });

  it('review finding 5: never when the next trip is at another depot (nothing is measured across two depots)', () => {
    const m = day(trip(1, { status: 'COMPLETED', backAtDepotAt: at(300) }), trip(1, { key: 'D2:1', depotId: 'D2', departMin: 800, stops: [{ ...stop(1, 'SHOPX'), key: 'D2:1:1' }] }));
    expect(offerOf(m)).toBeNull();
  });

  it('review finding 8: the position of a Leaving tap only from a fix at most 2 min old', () => {
    const fix = { at: T0, gpsAt: null, lat: 23.6, lng: 58.4, accuracyM: 12.34, speedMps: null };
    expect(recentPosOf(fix, T0 + 120_000, 120_000)).toMatchObject({ lat: 23.6, lng: 58.4, accuracyM: 12.3 });
    expect(recentPosOf(fix, T0 + 120_001, 120_000)).toBeUndefined();
    expect(recentPosOf(null, T0, 120_000)).toBeUndefined();
  });

  it('the latest trip back decides: after trip 2 is back, trip 3 is offered', () => {
    const m = day(trip(1, { status: 'COMPLETED', backAtDepotAt: at(300) }), trip(2, { status: 'COMPLETED', leftDepotAt: at(330), backAtDepotAt: at(520) }), trip(3, { status: 'LOCKED', actionable: false }));
    expect(offerOf(m)).toEqual({ from: 2, to: 3 });
  });

  it('the overlay shows the trip as left: from the server, or a tap still on the phone (pending)', () => {
    const leave = item({ key: newKey(), type: 'DEPOT_DEPART', load: 2, depot: 'D1', at: at(330) });
    const [, queued] = applyQueued(day(trip(1, { backAtDepotAt: at(300) }), trip(2)), [leave]);
    expect(queued).toMatchObject({ left: true, leftAt: T0 + 330 * 60_000, leftPending: true });
    const [, server] = applyQueued(day(trip(1, { backAtDepotAt: at(300) }), trip(2, { leftDepotAt: at(331) })), []);
    expect(server).toMatchObject({ left: true, leftAt: T0 + 331 * 60_000, leftPending: false });
    // A manifest kept on the phone from before (no leftDepotAt): not left.
    const old = trip(2);
    delete (old as Partial<typeof old>).leftDepotAt;
    expect(applyQueued(day(old), [])[0]).toMatchObject({ left: false, leftAt: null });
  });

  it('a queued tap is a load-level item: no stop, the load it leaves with as its key', () => {
    const leave = item({ key: newKey(), type: 'DEPOT_DEPART', load: 2, depot: 'D1', at: at(330) });
    expect(leave).toMatchObject({ kind: 'action', stopKey: null, loadNo: 2, loadKey: 'D1:2', state: 'ready' });
  });
});
