/**
 * The visit rebuild with GPS (AYUN) events, IVMS live link (lib/delivery/visit.ts; design section 6.4
 * with the binding review's H1/M1/M3/M4): GPS has its own cycles and only fills what the driver and the
 * office left; it never writes a result, never feeds the measured unloading times, counts as on time
 * only at a stop where goods were handed over, and never restores the phone's stop timer. Synthetic
 * stop, invented pin.
 */
import { describe, expect, it } from 'vitest';
import { deriveVisit, type VisitContext, type VisitEvent } from '@/lib/delivery/visit';
import { arrivalByText, arrivalNote, departureNote, sourceWord, timedByText } from '@/lib/delivery/office-text';
import { arrivalIsObserved, arrivedInsideWindow, type KpiVisit } from '@/lib/delivery/kpis';
import { eligibleForMeasured } from '@/lib/delivery/measured';
import { applyQueued, stopInProgress } from '@/lib/driver-page/overlay';
import { actionItem, newKey } from '@/lib/driver-page/queue';
import type { DriverManifest, ManifestStop, StopResult } from '@/lib/driver-link/manifest-types';

const DAY = new Date('2026-10-05T00:00:00+04:00');
const L = (hhmm: string) => new Date(DAY.getTime() + (Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5))) * 60_000);
const PIN = { lat: 20.1, lng: 55.1 };
const LINES = [{ orderId: 'O1', lineId: 'A', productCode: 'A', plannedCases: 30, deliveredCases: null }];
const CTX: VisitContext = { dayStart: DAY, windowStartMin: null, breakMin: null, lines: LINES, pin: PIN, radiusM: 100 };

let n = 0;
function ev(kind: VisitEvent['kind'], source: VisitEvent['source'], at: string, payload: Record<string, unknown> = {}, over: Partial<VisitEvent> = {}): VisitEvent {
  n++;
  return { id: `e${n}`, kind, source, at: L(at), receivedAt: over.receivedAt ?? L(at), lat: null, lng: null, accuracyM: null, distanceM: null, payload, ...over };
}
const gpsIn = (at: string, observed = true) => ev('ARRIVED', 'AYUN', at, { observed, detector: 'ivms-v1' });
const gpsOut = (at: string, gap = false) => ev('DEPARTED', 'AYUN', at, { observed: !gap, ...(gap ? { gap: true } : {}), detector: 'ivms-v1' });
const autoIn = (at: string, observed = true) => ev('ARRIVED', 'PHONE_AUTO', at, { mode: 'AUTO', ...(observed ? {} : { observed: false }) });
const autoOut = (at: string) => ev('DEPARTED', 'PHONE_AUTO', at, { reason: 'LEFT' });
const tap = (at: string, when = false) => ev('ARRIVED', 'PHONE_MANUAL', at, { mode: 'MANUAL', ...(when ? { when: true } : {}) });
const result = (at: string, outcome = 'DELIVERED', source: VisitEvent['source'] = 'PHONE_MANUAL') => ev('OUTCOME', source, at, { outcome });
const office = (kind: 'ARRIVED' | 'DEPARTED', at: string) => ev(kind, 'DISPATCHER', at, { mode: 'OFFICE' }, { receivedAt: L('16:00'), userId: 'u1' });

describe('GPS alone fills a stop the phone did not time', () => {
  it('arrival and departure from GPS: automatic timing to the departure, but never a measured time (M3)', () => {
    const v = deriveVisit([gpsIn('10:00'), gpsOut('10:25'), result('10:20')], CTX);
    expect(v).toMatchObject({ arrivalSource: 'AYUN', departureSource: 'AYUN', arrivalObserved: true, autoBasis: 'DEPARTURE', autoMinutes: 25, autoServiceMinutes: null, state: 'DONE' });
    expect(v.arrivedAt).toEqual(L('10:00'));
    expect(eligibleForMeasured({ ...v, plannedServiceMin: 20, deliveryDate: '2026-10-05' })).toBe(false);
  });

  it('a GPS arrival and the driver result: automatic timing to the result, still not measured', () => {
    expect(deriveVisit([gpsIn('10:00'), result('10:20')], CTX)).toMatchObject({ arrivalSource: 'AYUN', autoBasis: 'RESULT', autoMinutes: 20, autoServiceMinutes: null, departedAtOutcome: true });
  });

  it('an unobserved GPS arrival is shown but never automatic; a GPS departure after a gap is not observed', () => {
    expect(deriveVisit([gpsIn('10:00', false), gpsOut('10:25'), result('10:20')], CTX)).toMatchObject({ arrivalObserved: false, autoArrivedAt: null, autoBasis: null });
    const gap = deriveVisit([gpsIn('10:00'), gpsOut('10:22', true), result('10:20')], CTX);
    expect(gap).toMatchObject({ departureGap: true, autoDepartedAt: null, autoBasis: 'RESULT' });
  });

  it('a GPS stay without a result is in progress (ARRIVED), then PENDING after the departure', () => {
    expect(deriveVisit([gpsIn('10:00')], CTX).state).toBe('ARRIVED');
    expect(deriveVisit([gpsIn('10:00'), gpsOut('10:20')], CTX).state).toBe('PENDING');
  });

  it('GPS positions are never plausibility evidence (pin check stays phone-only)', () => {
    const atPin = ev('ARRIVED', 'AYUN', '10:00', { observed: true }, { lat: PIN.lat, lng: PIN.lng });
    expect(deriveVisit([atPin, result('10:20')], CTX)).toMatchObject({ timingSuspect: false, suspect: [] });
  });
});

describe('the driver and the office always win (design 6.4, owner decision D-3 recommendation)', () => {
  it('the office arrival beats everything', () => {
    const v = deriveVisit([gpsIn('09:50'), autoIn('10:00'), office('ARRIVED', '10:05'), result('10:20')], CTX);
    expect(v).toMatchObject({ arrivalSource: 'DISPATCHER' });
    expect(v.arrivedAt).toEqual(L('10:05'));
  });

  it('a "when?" answer and a plain tap beat an earlier GPS arrival', () => {
    expect(deriveVisit([gpsIn('09:50'), autoIn('10:00', false), tap('09:58', true), result('10:20')], CTX)).toMatchObject({ arrivalSource: 'PHONE_MANUAL' });
    const tapped = deriveVisit([gpsIn('09:50'), tap('10:01'), result('10:20')], CTX);
    expect(tapped).toMatchObject({ arrivalSource: 'PHONE_MANUAL' });
    expect(tapped.arrivedAt).toEqual(L('10:01'));
  });

  it('two automatic arrivals: the observed one first, then the earlier (M1)', () => {
    // Both observed: the earlier (GPS) wins.
    expect(deriveVisit([autoIn('10:00'), gpsIn('09:58'), result('10:20')], CTX)).toMatchObject({ arrivalSource: 'AYUN' });
    // The phone's observed arrival beats an earlier GPS upper bound.
    expect(deriveVisit([autoIn('10:00'), gpsIn('09:40', false), result('10:20')], CTX)).toMatchObject({ arrivalSource: 'PHONE_AUTO', arrivalObserved: true });
    // The phone's arrival found when the page came back loses to an observed GPS arrival.
    expect(deriveVisit([autoIn('10:05', false), gpsIn('10:00'), result('10:20')], CTX)).toMatchObject({ arrivalSource: 'AYUN', arrivalObserved: true });
    // Neither observed: the earlier.
    expect(deriveVisit([autoIn('10:05', false), gpsIn('10:00', false), result('10:20')], CTX)).toMatchObject({ arrivalSource: 'AYUN', arrivalObserved: false });
  });

  it('departure: the office, else the phone, else the GPS stay that began near the arrival', () => {
    expect(deriveVisit([autoIn('10:00'), autoOut('10:22'), gpsIn('09:59'), gpsOut('10:24'), result('10:20')], CTX)).toMatchObject({ departureSource: 'PHONE_AUTO' });
    expect(deriveVisit([autoIn('10:00'), gpsIn('09:59'), gpsOut('10:24'), result('10:20'), office('DEPARTED', '10:30')], CTX)).toMatchObject({ departureSource: 'DISPATCHER' });
    // The phone saw no departure: the GPS one fills it.
    const filled = deriveVisit([autoIn('10:00'), gpsIn('09:59'), gpsOut('10:24'), result('10:20')], CTX);
    expect(filled).toMatchObject({ departureSource: 'AYUN', departedAtOutcome: false, autoBasis: 'DEPARTURE' });
    expect(filled.departedAt).toEqual(L('10:24'));
  });

  it('a GPS stay that began more than 15 min after the chosen arrival is not its departure', () => {
    const v = deriveVisit([office('ARRIVED', '10:00'), gpsIn('10:30'), gpsOut('10:45'), result('10:40', 'DELIVERED')], CTX);
    expect(v.departureSource).not.toBe('AYUN');
  });

  it('the 15-minute rule after the result applies to a GPS departure too', () => {
    const parked = deriveVisit([gpsIn('10:00'), gpsOut('10:50'), result('10:20')], CTX);
    expect(parked).toMatchObject({ departedAtOutcome: true, departureSource: 'PHONE_MANUAL', autoBasis: 'RESULT' });
  });

  it('the GPS cycle used is the one overlapping the phone cycle, never an earlier stay nearby', () => {
    const v = deriveVisit([gpsIn('08:00'), gpsOut('08:10'), autoIn('10:00'), gpsIn('10:02'), gpsOut('10:21'), result('10:15')], CTX);
    expect(v).toMatchObject({ arrivalSource: 'PHONE_AUTO', departureSource: 'AYUN' });
    expect(v.departedAt).toEqual(L('10:21'));
  });

  it('GPS never gives a result: a visit with only GPS events has none', () => {
    expect(deriveVisit([gpsIn('10:00'), gpsOut('10:25')], CTX)).toMatchObject({ outcome: null, outcomeSource: null, driverResultAt: null });
  });
});

describe('on-time KPI: a GPS arrival counts only where goods were handed over (M3)', () => {
  const kv = (over: Partial<KpiVisit>): KpiVisit => ({
    outcome: 'DELIVERED',
    autoServiceMinutes: null,
    timingSuspect: false,
    outcomeLate: false,
    plannedServiceMin: 20,
    casesDelivered: 30,
    autoArrivedAt: null,
    deliveryDate: '2026-10-05',
    reason: null,
    casesPlanned: 30,
    arrivedAt: L('09:00'),
    arrivalSource: 'AYUN',
    arrivalObserved: true,
    windowStartMin: 8 * 60,
    windowEndMin: 10 * 60,
    noPhotoReason: null,
    dayStart: DAY,
    ...over,
  });
  it('Delivered or Partly: counted; Not delivered or no result: not', () => {
    expect(arrivalIsObserved(kv({}))).toBe(true);
    expect(arrivalIsObserved(kv({ outcome: 'PARTLY_DELIVERED' }))).toBe(true);
    expect(arrivedInsideWindow(kv({ outcome: 'NOT_DELIVERED' }))).toBeNull();
    expect(arrivedInsideWindow(kv({ outcome: null }))).toBeNull();
    expect(arrivedInsideWindow(kv({ arrivalObserved: false }))).toBeNull();
  });
  it('the phone sources are unchanged', () => {
    expect(arrivalIsObserved(kv({ arrivalSource: 'PHONE_AUTO', outcome: null }))).toBe(true);
    expect(arrivalIsObserved(kv({ arrivalSource: 'PHONE_MANUAL', outcome: 'NOT_DELIVERED' }))).toBe(true);
  });
});

describe('the words for GPS times', () => {
  it('source, arrival, departure and "timed by" say GPS (Ayun), never "Manual"', () => {
    expect(sourceWord('AYUN')).toBe('GPS (Ayun)');
    expect(arrivalByText('AYUN', true)).toBe('GPS (Ayun)');
    expect(arrivalByText('AYUN', false)).toBe('GPS (Ayun), not observed');
    expect(arrivalNote('AYUN', true)).toBe('GPS (Ayun)');
    expect(arrivalNote('AYUN', false)).toBe("GPS (Ayun): not observed (gap in the tracker's points)");
    expect(departureNote(false, false, 'AYUN')).toBe('GPS (Ayun)');
    expect(departureNote(false, true, 'AYUN')).toBe('GPS (Ayun), not observed');
    expect(departureNote(true, false, 'AYUN')).toBe('result time');
    // The fixed bug: a GPS arrival without automatic timing was labelled "Manual".
    expect(timedByText({ autoBasis: null, arrivalSource: 'AYUN', departureSource: null, departedAtOutcome: false, outcomeSource: null })).toBe('GPS (Ayun)');
    expect(timedByText({ autoBasis: 'DEPARTURE', arrivalSource: 'AYUN', departureSource: 'AYUN', departedAtOutcome: false, outcomeSource: 'PHONE_MANUAL' })).toBe('GPS to departure');
    expect(timedByText({ autoBasis: 'DEPARTURE', arrivalSource: 'PHONE_AUTO', departureSource: 'AYUN', departedAtOutcome: false, outcomeSource: 'PHONE_MANUAL' })).toBe('GPS to departure');
    expect(timedByText({ autoBasis: 'RESULT', arrivalSource: 'AYUN', departureSource: 'PHONE_MANUAL', departedAtOutcome: true, outcomeSource: 'PHONE_MANUAL' })).toBe('GPS to result');
  });
  it('the phone and office words are unchanged', () => {
    expect(departureNote(false, true)).toBe('not observed');
    expect(departureNote(false, false, 'PHONE_AUTO')).toBeNull();
    expect(arrivalNote('PHONE_AUTO', false)).toBe('arrival not observed (page opened at the shop)');
    expect(timedByText({ autoBasis: null, arrivalSource: 'PHONE_AUTO', departureSource: null, departedAtOutcome: false, outcomeSource: null })).toBe('Manual');
  });
});

describe('the driver page never restores its stop timer from a GPS arrival (M4)', () => {
  const T0 = Date.parse('2026-10-05T06:00:00Z');
  const res = (over: Partial<StopResult>): StopResult => ({
    state: 'ARRIVED',
    arrivedAt: new Date(T0).toISOString(),
    arrivalObserved: true,
    departedAt: null,
    minutes: null,
    outcome: null,
    reason: null,
    note: null,
    outcomeAt: null,
    by: null,
    casesDelivered: null,
    lines: null,
    photoIds: [],
    proofPhotos: 0,
    noPhotoReason: null,
    late: false,
    editable: true,
    carriedTo: null,
    ...over,
  });
  const stop = (seq: number, result: StopResult | null): ManifestStop =>
    ({
      key: `D1:1:${seq}`,
      sequence: seq,
      customerName: `Shop Example ${seq}`,
      customerCode: `C${seq}`,
      branchCode: null,
      address: null,
      lat: PIN.lat,
      lng: PIN.lng + seq / 100,
      navUrl: null,
      etaMin: 480,
      untilMin: 500,
      hours: null,
      promised: null,
      cases: 30,
      orders: [],
      notes: [],
      accessNotes: null,
      split: null,
      carriedFrom: null,
      changeNotes: [],
      result,
    }) as ManifestStop;
  const manifest = (stops: ManifestStop[]): Pick<DriverManifest, 'loads'> =>
    ({ loads: [{ key: 'D1:1', depotId: 'D1', loadNo: 1, trips: 1, status: 'DISPATCHED', actionable: true, departMin: 430, returnMin: 900, driverName: 'Driver A', cases: 60, backAtDepotAt: null, stops }] }) as Pick<DriverManifest, 'loads'>;

  it('a stop arrived by GPS shows the arrival, labelled, and is not the stop in progress', () => {
    const [l] = applyQueued(manifest([stop(1, res({ arrivalByGps: true }))]), []);
    expect(l!.stops[0]!.view).toMatchObject({ state: 'ARRIVED', arrivedAt: T0, arrivalByGps: true });
    expect(stopInProgress([l!], 'D1:1')).toBeNull();
  });

  it("the phone's own unsent arrival replaces the GPS one and restores the timer", () => {
    const mine = actionItem('t5|2026-10-05', { key: newKey(), type: 'ARRIVE', stop: 'D1:1:1', at: new Date(T0 + 120_000).toISOString(), mode: 'AUTO' }, T0 + 120_000, false);
    const [l] = applyQueued(manifest([stop(1, res({ arrivalByGps: true }))]), [mine]);
    expect(l!.stops[0]!.view.arrivalByGps).toBeUndefined();
    expect(stopInProgress([l!], 'D1:1')).toEqual({ key: 'D1:1:1', arrivedAt: T0 + 120_000, observed: true });
  });

  it('a stop without a GPS arrival is exactly as before (no new field)', () => {
    const [l] = applyQueued(manifest([stop(1, res({}))]), []);
    expect('arrivalByGps' in l!.stops[0]!.view).toBe(false);
    expect(stopInProgress([l!], 'D1:1')).toEqual({ key: 'D1:1:1', arrivedAt: T0, observed: true });
  });
});
