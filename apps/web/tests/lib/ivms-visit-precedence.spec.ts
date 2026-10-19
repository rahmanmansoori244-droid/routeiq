/**
 * The visit rebuild with GPS (AYUN) events, IVMS live link (lib/delivery/visit.ts; design section 6.4
 * with the binding review's H1/M1/M3/M4 and the second review's H-2/L-2/L-3): the visit is the driver's
 * and the office's exactly as with the link off; GPS only fills an arrival or a departure nothing else
 * gave, never writes a result, never touches the automatic (measured) timing, counts as on time only at
 * a stop where goods were handed over, and is never the driver page's arrival. Synthetic stop, invented
 * pin.
 */
import { describe, expect, it } from 'vitest';
import { deriveVisit, withoutGpsTimes, type VisitContext, type VisitEvent, type VisitTimes } from '@/lib/delivery/visit';
import { actualMinutes, arrivalByText, arrivalNote, departureNote, sourceWord, timedByText } from '@/lib/delivery/office-text';
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
  it('arrival and departure from GPS: shown, never automatic and never a measured time (M3)', () => {
    const v = deriveVisit([gpsIn('10:00'), gpsOut('10:25'), result('10:20')], CTX);
    expect(v).toMatchObject({ arrivalSource: 'AYUN', departureSource: 'AYUN', arrivalObserved: true, autoBasis: null, autoMinutes: null, autoServiceMinutes: null, state: 'DONE' });
    expect(v.arrivedAt).toEqual(L('10:00'));
    expect(v.departedAt).toEqual(L('10:25'));
    expect(eligibleForMeasured({ ...v, plannedServiceMin: 20, deliveryDate: '2026-10-05' })).toBe(false);
    // The unloading shown is arrival to departure, not "auto"; "timed by" says GPS.
    expect(actualMinutes(v)).toEqual({ min: 25, label: 'arrival to departure', auto: false });
    expect(timedByText(v)).toBe('GPS (Ayun)');
  });

  it('a GPS arrival and the driver result: the result ends the stop, still not automatic', () => {
    expect(deriveVisit([gpsIn('10:00'), result('10:20')], CTX)).toMatchObject({ arrivalSource: 'AYUN', autoBasis: null, autoMinutes: null, autoServiceMinutes: null, departedAtOutcome: true, departureSource: 'PHONE_MANUAL' });
  });

  it('an unobserved GPS arrival is shown as not observed; a GPS departure after a gap is not observed', () => {
    expect(deriveVisit([gpsIn('10:00', false), gpsOut('10:25'), result('10:20')], CTX)).toMatchObject({ arrivalObserved: false, autoArrivedAt: null, autoBasis: null });
    const gap = deriveVisit([gpsIn('10:00'), gpsOut('10:22', true), result('10:20')], CTX);
    expect(gap).toMatchObject({ departureGap: true, departureSource: 'AYUN', autoDepartedAt: null, autoBasis: null });
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

describe("the phone's measured times are never touched by GPS (second review H-2)", () => {
  const keys = ['arrivedAt', 'arrivalSource', 'departedAt', 'departureSource', 'departedAtOutcome', 'autoArrivedAt', 'autoDepartedAt', 'autoBasis', 'autoMinutes', 'autoServiceMinutes', 'state'] as const;
  const pick = (v: ReturnType<typeof deriveVisit>) => Object.fromEntries(keys.map((k) => [k, v[k]]));
  const phone = [autoIn('09:00'), result('09:12')];

  it('phone automatic arrival + result, and a GPS stay around it: exactly as with the link off', () => {
    const off = deriveVisit(phone, CTX);
    expect(off).toMatchObject({ autoBasis: 'RESULT', autoMinutes: 12, autoServiceMinutes: 12 });
    expect(pick(deriveVisit([...phone, gpsIn('08:59'), gpsOut('09:14')], CTX))).toEqual(pick(off));
    // A GPS arrival just after the phone's, and its departure: still the phone's timing.
    expect(pick(deriveVisit([...phone, gpsIn('09:01'), gpsOut('09:14')], CTX))).toEqual(pick(off));
  });

  it('phone arrival and departure: the GPS stay changes nothing', () => {
    const own = [autoIn('09:00'), autoOut('09:20'), result('09:12')];
    expect(pick(deriveVisit([...own, gpsIn('08:58'), gpsOut('09:22')], CTX))).toEqual(pick(deriveVisit(own, CTX)));
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

  it("the phone's automatic arrival, observed or found later, beats any GPS arrival (H-2)", () => {
    expect(deriveVisit([autoIn('10:00'), gpsIn('09:58'), result('10:20')], CTX)).toMatchObject({ arrivalSource: 'PHONE_AUTO', arrivalObserved: true });
    expect(deriveVisit([autoIn('10:00'), gpsIn('09:40', false), result('10:20')], CTX)).toMatchObject({ arrivalSource: 'PHONE_AUTO', arrivalObserved: true });
    expect(deriveVisit([autoIn('10:05', false), gpsIn('10:00'), result('10:20')], CTX)).toMatchObject({ arrivalSource: 'PHONE_AUTO', arrivalObserved: false });
  });

  it('departure: the office, else the phone, else the result time, else the GPS stay that began near the arrival', () => {
    expect(deriveVisit([autoIn('10:00'), autoOut('10:22'), gpsIn('09:59'), gpsOut('10:24'), result('10:20')], CTX)).toMatchObject({ departureSource: 'PHONE_AUTO' });
    expect(deriveVisit([autoIn('10:00'), gpsIn('09:59'), gpsOut('10:24'), result('10:20'), office('DEPARTED', '10:30')], CTX)).toMatchObject({ departureSource: 'DISPATCHER' });
    // The driver's result ends the stop (Auto to result): the GPS departure does not replace it.
    expect(deriveVisit([autoIn('10:00'), gpsIn('09:59'), gpsOut('10:24'), result('10:20')], CTX)).toMatchObject({ departureSource: 'PHONE_MANUAL', departedAtOutcome: true, autoBasis: 'RESULT' });
    // The driver tapped "I arrived" and saved the result: the result time only stood in for the departure, GPS saw it.
    const tapped = deriveVisit([tap('10:01'), gpsIn('09:59'), gpsOut('10:24'), result('10:20')], CTX);
    expect(tapped).toMatchObject({ arrivalSource: 'PHONE_MANUAL', departureSource: 'AYUN', departedAtOutcome: false, autoBasis: null, autoServiceMinutes: null });
    expect(timedByText(tapped)).toBe('Manual arrival, GPS (Ayun) departure');
    // No result yet and the phone saw no departure: the GPS one fills it (the phone's timing stays as it was).
    const filled = deriveVisit([autoIn('10:00'), gpsIn('09:59'), gpsOut('10:24')], CTX);
    expect(filled).toMatchObject({ departureSource: 'AYUN', departedAtOutcome: false, autoBasis: null, state: 'PENDING' });
    expect(filled.departedAt).toEqual(L('10:24'));
  });

  it('without a result, a GPS stay that began more than 15 min after the chosen arrival is not its departure', () => {
    const v = deriveVisit([office('ARRIVED', '10:00'), gpsIn('10:30'), gpsOut('10:45')], CTX);
    expect(v.departureSource).not.toBe('AYUN');
  });

  it('with a result, the GPS stay that holds it gives the departure, wherever it began (owner request 19 Oct 2026)', () => {
    const v = deriveVisit([office('ARRIVED', '10:00'), gpsIn('10:30'), gpsOut('10:45'), result('10:40', 'DELIVERED')], CTX);
    expect(v).toMatchObject({ departureSource: 'AYUN', departedAt: L('10:45') });
  });

  it('the 15-minute rule after the result applies to a GPS departure too', () => {
    const parked = deriveVisit([gpsIn('10:00'), gpsOut('10:50'), result('10:20')], CTX);
    expect(parked).toMatchObject({ departedAtOutcome: true, departureSource: 'PHONE_MANUAL', autoBasis: null });
  });

  it('the GPS stay used is the one at the arrival shown, never an earlier stay nearby', () => {
    const v = deriveVisit([gpsIn('08:00'), gpsOut('08:10'), autoIn('10:00'), gpsIn('10:02'), gpsOut('10:21')], CTX);
    expect(v).toMatchObject({ arrivalSource: 'PHONE_AUTO', departureSource: 'AYUN' });
    expect(v.departedAt).toEqual(L('10:21'));
  });

  it('GPS never gives a result: a visit with only GPS events has none', () => {
    expect(deriveVisit([gpsIn('10:00'), gpsOut('10:25')], CTX)).toMatchObject({ outcome: null, outcomeSource: null, driverResultAt: null });
  });

  it('a GPS arrival never comes after the Left the office entered', () => {
    expect(deriveVisit([gpsIn('10:30'), gpsOut('10:45'), office('DEPARTED', '10:20')], CTX)).toMatchObject({ arrivedAt: null, departureSource: 'DISPATCHER' });
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
    expect(timedByText({ autoBasis: null, arrivalSource: 'AYUN', departureSource: 'AYUN', departedAtOutcome: false, outcomeSource: 'PHONE_MANUAL' })).toBe('GPS (Ayun)');
    expect(timedByText({ autoBasis: null, arrivalSource: 'AYUN', departureSource: 'PHONE_MANUAL', departedAtOutcome: true, outcomeSource: 'PHONE_MANUAL' })).toBe('GPS (Ayun)');
    // The driver's own arrival and a GPS departure: never just "GPS (Ayun)" (second review L-2).
    expect(timedByText({ autoBasis: null, arrivalSource: 'PHONE_MANUAL', departureSource: 'AYUN', departedAtOutcome: false, outcomeSource: null })).toBe('Manual arrival, GPS (Ayun) departure');
    expect(timedByText({ autoBasis: null, arrivalSource: 'PHONE_AUTO', departureSource: 'AYUN', departedAtOutcome: false, outcomeSource: null })).toBe('Auto arrival, GPS (Ayun) departure');
  });
  it('the phone and office words are unchanged', () => {
    expect(departureNote(false, true)).toBe('not observed');
    expect(departureNote(false, false, 'PHONE_AUTO')).toBeNull();
    expect(arrivalNote('PHONE_AUTO', false)).toBe('arrival not observed (page opened at the shop)');
    expect(timedByText({ autoBasis: null, arrivalSource: 'PHONE_AUTO', departureSource: null, departedAtOutcome: false, outcomeSource: null })).toBe('Manual');
    expect(timedByText({ autoBasis: 'DEPARTURE', arrivalSource: 'PHONE_AUTO', departureSource: 'PHONE_AUTO', departedAtOutcome: false, outcomeSource: 'PHONE_MANUAL' })).toBe('Auto to departure');
    expect(timedByText({ autoBasis: 'RESULT', arrivalSource: 'PHONE_AUTO', departureSource: 'PHONE_MANUAL', departedAtOutcome: true, outcomeSource: 'PHONE_MANUAL' })).toBe('Auto to result');
  });
});

describe("the driver page: a GPS-only arrival is never the driver's (M4, first review M-2, second review L-3)", () => {
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

  it('a stop arrived only by GPS is not arrived on the phone: "I arrived" stays, no timer, no "At stop", not visited', () => {
    const [l] = applyQueued(manifest([stop(1, res({ arrivalByGps: true, minutes: 95 }))]), []);
    const v = l!.stops[0]!.view;
    // The sheet shows "I arrived" while arrivedAt is null; the list's "At stop" chip needs state ARRIVED; the
    // tracker's "visited" needs arrivedAt or doneAt.
    expect(v).toMatchObject({ state: 'PENDING', arrivedAt: null, doneAt: null, minutes: null, gpsArrivedAt: T0 });
    expect(stopInProgress([l!], 'D1:1')).toBeNull();
  });

  it('with a result after a GPS-only arrival: done, and still no arrival of the driver', () => {
    const [l] = applyQueued(manifest([stop(1, res({ arrivalByGps: true, state: 'DONE', outcome: 'DELIVERED', outcomeAt: new Date(T0 + 600_000).toISOString() }))]), []);
    expect(l!.stops[0]!.view).toMatchObject({ state: 'DONE', arrivedAt: null, doneAt: T0 + 600_000 });
  });

  it("the phone's own unsent arrival replaces the GPS note and restores the timer", () => {
    const mine = actionItem('t5|2026-10-05', { key: newKey(), type: 'ARRIVE', stop: 'D1:1:1', at: new Date(T0 + 120_000).toISOString(), mode: 'AUTO' }, T0 + 120_000, false);
    const [l] = applyQueued(manifest([stop(1, res({ arrivalByGps: true }))]), [mine]);
    expect(l!.stops[0]!.view.gpsArrivedAt).toBeUndefined();
    expect(stopInProgress([l!], 'D1:1')).toEqual({ key: 'D1:1:1', arrivedAt: T0 + 120_000, observed: true });
  });

  it('a stop without a GPS arrival is exactly as before (no new field)', () => {
    const [l] = applyQueued(manifest([stop(1, res({}))]), []);
    expect('gpsArrivedAt' in l!.stops[0]!.view).toBe(false);
    expect(l!.stops[0]!.view).toMatchObject({ state: 'ARRIVED', arrivedAt: T0 });
    expect(stopInProgress([l!], 'D1:1')).toEqual({ key: 'D1:1:1', arrivedAt: T0, observed: true });
  });
});

describe('the operations alerts read the visit without its GPS times (merge review of 17 Oct 2026, finding 1)', () => {
  const TIMES = ['arrivedAt', 'arrivalSource', 'arrivalDistanceM', 'arrivalAccuracyM', 'arrivalObserved', 'departedAt', 'departureSource', 'departedAtOutcome', 'outcome', 'outcomeAt', 'outcomeSource'] as const;
  const timesOf = (v: VisitTimes) => Object.fromEntries(TIMES.map((k) => [k, v[k]]));

  it('withoutGpsTimes on the stored visit is the visit the driver and the office made (the link off), for every mix of events', () => {
    // GPS stays (one near the arrival, one late, one unobserved), the phone's taps and automatic timing, its
    // results, the office's entries: every subset of them, rebuilt with and without the AYUN events.
    const pool = [
      gpsIn('10:00'),
      gpsOut('10:28'),
      gpsIn('11:10', false),
      gpsOut('11:40', true),
      tap('10:04'),
      autoIn('10:03'),
      autoOut('10:24'),
      result('10:20'),
      result('10:22', 'NOT_DELIVERED', 'DISPATCHER'),
      office('ARRIVED', '10:01'),
      office('DEPARTED', '10:35'),
      result('11:20', 'PARTLY_DELIVERED'),
    ];
    let gpsChanged = 0;
    for (let mask = 1; mask < 1 << pool.length; mask++) {
      const events = pool.filter((_, i) => mask & (1 << i));
      const stored = deriveVisit(events, CTX);
      const own = deriveVisit(
        events.filter((e) => e.source !== 'AYUN'),
        CTX,
      );
      if (JSON.stringify(timesOf(stored)) !== JSON.stringify(timesOf(own))) gpsChanged++;
      expect(timesOf(withoutGpsTimes(stored)), events.map((e) => `${e.kind}/${e.source}@${e.at.toISOString().slice(11, 16)}`).join(' ')).toEqual(timesOf(own));
    }
    // The pool really exercises what GPS fills: arrivals, departures and the result standing in for one. (It
    // was over 500 before the rebuild took the departure from the stay that holds the result, owner request
    // 19 Oct 2026: a result at 11:20 in the 11:10-11:40 stay now keeps the result time, as that stay's
    // departure is more than 15 min after it, where the first stay's 10:28 was shown before.)
    expect(gpsChanged).toBeGreaterThan(400);
  });

  it('a GPS arrival and the driver result: for the alerts no arrival and no departure, as on the driver page; the result stays', () => {
    const stored = deriveVisit([gpsIn('10:00'), gpsOut('10:28'), result('10:20')], CTX);
    expect(stored).toMatchObject({ arrivalSource: 'AYUN', departureSource: 'AYUN' });
    expect(withoutGpsTimes(stored)).toMatchObject({ arrivedAt: null, arrivalSource: null, departedAt: null, departureSource: null, departedAtOutcome: false, outcome: 'DELIVERED', outcomeAt: L('10:20') });
    // The driver's arrival and a GPS departure: for the alerts the result ends the stop again.
    const tapped = deriveVisit([tap('10:04'), gpsIn('10:00'), gpsOut('10:28'), result('10:20')], CTX);
    expect(tapped).toMatchObject({ arrivalSource: 'PHONE_MANUAL', departureSource: 'AYUN', departedAt: L('10:28') });
    expect(withoutGpsTimes(tapped)).toMatchObject({ arrivedAt: L('10:04'), departedAt: L('10:20'), departureSource: 'PHONE_MANUAL', departedAtOutcome: true });
  });

  it('a visit without GPS times is returned as it is (the same object)', () => {
    const v = deriveVisit([tap('10:04'), result('10:20')], CTX);
    expect(withoutGpsTimes(v)).toBe(v);
  });
});
