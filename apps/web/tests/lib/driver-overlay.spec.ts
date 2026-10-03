/**
 * What the driver page shows: the server's state plus what is still on the phone (owner request
 * 4 Oct 2026, spec section 13.5). applyQueued, stopInProgress and the unsent list. Synthetic stops
 * ACME and BETA on truck T05.
 */
import { describe, expect, it } from 'vitest';
import type { DriverAction, DriverManifest, ManifestStop, StopResult } from '@/lib/driver-link/manifest-types';
import { applyQueued, stopInProgress, unsentList } from '@/lib/driver-page/overlay';
import { actionItem, newKey, type QueueItem } from '@/lib/driver-page/queue';

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
