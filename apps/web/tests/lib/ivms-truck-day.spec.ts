/**
 * A truck's day (owner request 18 Oct 2026: "i click on [a truck] it takes me to where the truck is and what it
 * was doing"), the pure model of lib/ivms/truck-day.ts: the timeline in the order things happened with who
 * recorded each time, what has not happened at its planned time, the earlier GPS visit of a customer who
 * refused first, the trail thinned to 2,000 points, the live status with the next stop's ETA, the alerts,
 * and what the GPS tracking modes OFF and MAP (and a suppressed truck-day) leave out. Invented data only:
 * a depot in empty desert (tests/lib/ivms-trail.ts), truck "T-100", shops "Shop Example A..".
 */
import { describe, expect, it } from 'vitest';
import { at, T } from './ivms-trail';
import type { OpsAlertRow } from '@/lib/alerts/types';
import {
  buildTruckDay,
  dateLabel,
  datePicker,
  downsampleTrail,
  isIsoDate,
  lastActivityOf,
  otherGpsStays,
  timeOnDay,
  trailKept,
  trailWindow,
  truckDayHref,
  truckDayRefreshMs,
  TRAIL_MAX_POINTS,
  type TruckDayEventInput,
  type TruckDayInput,
  type TruckDayLoadInput,
  type TruckDayModel,
  type TruckDayStopInput,
  type TruckDayVisitInput,
} from '@/lib/ivms/truck-day';
import { zonedDayStart } from '@/lib/dispatch/time';

const TZ = 'Asia/Muscat';
const DATE = '2026-10-20';
const DEPOT = { id: 'D1', code: 'D1', name: 'Example depot', ...at(0) };

const stop = (sequence: number, east: number, etaMin: number, extra: Partial<TruckDayStopInput> = {}): TruckDayStopInput => ({
  sequence,
  customerCode: `C-${sequence}`,
  customerName: `Shop Example ${String.fromCharCode(64 + sequence)}`,
  etaMin,
  plannedServiceMin: 15,
  windowStartMin: null,
  windowEndMin: null,
  pin: at(east),
  casesPlanned: 40,
  ...extra,
});

const L1: TruckDayLoadInput = {
  id: 'L1',
  runId: 'R1',
  depotId: 'D1',
  loadNo: 1,
  status: 'COMPLETED',
  departMin: 420,
  returnMin: 600,
  driverName: 'Driver Example',
  driverCasual: false,
  dispatchedAt: T('06:55'),
  statusChangedAt: T('10:45'),
  stops: [stop(1, 3000, 450), stop(2, 6000, 480), stop(3, 9000, 510)],
};
const L2: TruckDayLoadInput = {
  id: 'L2',
  runId: 'R1',
  depotId: 'D1',
  loadNo: 2,
  status: 'DISPATCHED',
  departMin: 660,
  returnMin: 900,
  driverName: 'Driver Example',
  driverCasual: false,
  dispatchedAt: T('11:05'),
  statusChangedAt: T('11:05'),
  stops: [stop(1, 4000, 690), stop(2, 8000, 720)],
};

const visit = (loadNo: number, sequence: number, fields: Partial<TruckDayVisitInput>): TruckDayVisitInput => ({
  depotId: 'D1',
  loadNo,
  sequence,
  arrivedAt: null,
  arrivalSource: null,
  arrivalDistanceM: null,
  arrivalAccuracyM: null,
  arrivalObserved: true,
  departedAt: null,
  departureSource: null,
  departedAtOutcome: false,
  outcome: null,
  outcomeAt: null,
  outcomeSource: null,
  reason: null,
  reasonNote: null,
  casesPlanned: 40,
  casesDelivered: null,
  photoCount: 0,
  outcomeLate: false,
  ...fields,
});

const ev = (loadNo: number, sequence: number | null, kind: string, source: string, hhmm: string, payload: Record<string, unknown> | null = null): TruckDayEventInput => ({
  depotId: 'D1',
  loadNo,
  sequence,
  kind,
  source,
  at: T(hhmm),
  receivedAt: T(hhmm),
  payload,
});

/** The day: L1 done (stop 3 before stop 2, stop 2 refused), L2 on the road at stop 1, stop 2 to come. */
function input(over: Partial<TruckDayInput> = {}): TruckDayInput {
  return {
    now: T('11:50'),
    tz: TZ,
    date: DATE,
    mode: 'TIMES',
    trailDays: 2,
    truck: { id: 't1', code: 'T-100', description: 'Example 10-ton truck', hired: false, oneDay: false, depotId: 'D1', hasTracker: true },
    depots: [DEPOT],
    loads: [L2, L1],
    visits: [
      visit(1, 1, { arrivedAt: T('07:28'), arrivalSource: 'PHONE_MANUAL', departedAt: T('07:45'), departureSource: 'PHONE_AUTO', outcome: 'DELIVERED', outcomeAt: T('07:44'), outcomeSource: 'PHONE_MANUAL', casesDelivered: 40, photoCount: 1 }),
      visit(1, 3, { arrivedAt: T('08:05'), arrivalSource: 'AYUN', departedAt: T('08:20'), departureSource: 'AYUN', outcome: 'PARTLY_DELIVERED', outcomeAt: T('08:18'), outcomeSource: 'PHONE_MANUAL', reason: 'NOT_ON_TRUCK', casesDelivered: 30, photoCount: 2 }),
      visit(1, 2, { arrivedAt: T('08:40'), arrivalSource: 'PHONE_MANUAL', departedAt: T('08:50'), departureSource: 'PHONE_MANUAL', departedAtOutcome: true, outcome: 'NOT_DELIVERED', outcomeAt: T('08:50'), outcomeSource: 'PHONE_MANUAL', reason: 'CUSTOMER_REFUSED' }),
      visit(2, 1, { arrivedAt: T('11:35'), arrivalSource: 'PHONE_AUTO' }),
    ],
    events: [ev(1, null, 'BACK_AT_DEPOT', 'PHONE_MANUAL', '10:40'), ev(2, null, 'DEPOT_DEPART', 'PHONE_MANUAL', '11:08')],
    moves: [
      { kind: 'DEPOT_OUT', origin: 'TRAIL', at: T('06:58'), depotId: 'D1', outcome: 'USED' },
      { kind: 'DEPOT_IN', origin: 'WEBHOOK', at: T('10:38'), depotId: 'D1', outcome: 'USED' },
      // The same move from the trail: kept as a DUPLICATE by the processing, never shown twice.
      { kind: 'DEPOT_IN', origin: 'TRAIL', at: T('10:39'), depotId: 'D1', outcome: 'DUPLICATE' },
      { kind: 'DEPOT_OUT', origin: 'BACKSTOP', at: T('11:06'), depotId: 'D1', outcome: 'UNCONFIRMED' },
    ],
    trail: [],
    truckDay: null,
    position: null,
    alerts: [],
    dates: [DATE, '2026-10-19', '2026-10-15'],
    cfg: { avgSpeedKmh: 40, distanceMultiplier: 1.3, stopRadiusM: 100 },
    ...over,
  };
}

const ids = (m: TruckDayModel) => m.timeline.map((t) => `${t.at ? timeOnDay(t.at, zonedDayStart(DATE, TZ), TZ) : `(${timeOnDay(t.plannedAt!, zonedDayStart(DATE, TZ), TZ)})`} ${t.kind} ${t.title}`);

describe('the timeline: what happened in order, with who recorded it', () => {
  it('dispatch, depot moves, stops as they were visited (3 before 2), back, completed; what has not happened at its planned time, after what did', () => {
    const m = buildTruckDay(input());
    expect(ids(m)).toEqual([
      '06:55 DISPATCHED L1 dispatched',
      '06:58 DEPOT_OUT Left the depot',
      '07:28 STOP Stop 1 · Shop Example A (C-1)',
      '08:05 STOP Stop 3 · Shop Example C (C-3)',
      '08:40 STOP Stop 2 · Shop Example B (C-2)',
      '10:38 DEPOT_IN Arrived at the depot',
      '10:40 DEPOT_IN Back at the depot',
      '10:45 COMPLETED L1 completed',
      '11:05 DISPATCHED L2 dispatched',
      '11:06 DEPOT_OUT Left the depot',
      '11:08 DEPOT_OUT Left the depot',
      '11:35 STOP Stop 1 · Shop Example A (C-1)',
      '(12:00) STOP Stop 2 · Shop Example B (C-2)',
      '(15:00) DEPOT_IN Planned back at the depot',
    ]);
  });

  it('names the source of every time: the office Dispatch, the GPS trail, Ayun webhook and event list, the driver, GPS (Ayun)', () => {
    const m = buildTruckDay(input());
    const src = m.timeline.map((t) => t.source);
    expect(src).toEqual(['dispatcher (Dispatch)', 'GPS trail', 'driver', 'GPS (Ayun)', 'driver', 'Ayun webhook', 'driver', null, 'dispatcher (Dispatch)', 'Ayun event list', 'driver', 'driver', null, null]);
    const unconfirmed = m.timeline.find((t) => t.source === 'Ayun event list')!;
    expect(unconfirmed).toMatchObject({ tone: 'muted' });
    expect(unconfirmed.lines).toContain('Not confirmed by the GPS trail');
  });

  it("a stop's lines: the plan, the arrival and its source, the departure, the result with its reason, the cases and the photos", () => {
    const m = buildTruckDay(input());
    const s3 = m.timeline.find((t) => t.key === 'stop:D1:1:3')!;
    expect(s3.lines).toEqual([
      'Planned 08:30, unloading 15 min',
      'Arrived 08:05 (GPS (Ayun)), 25 min early',
      'Left 08:20 (GPS (Ayun))',
      'On site 15 min (planned unloading 15 min)',
      'Partly delivered: Missing from the truck - 30 of 40 cases (driver, 08:18)',
      '2 photos',
    ]);
    expect(s3.tone).toBe('warn');
    const s2 = m.timeline.find((t) => t.key === 'stop:D1:1:2')!;
    expect(s2.lines).toContain('Left: no departure seen, the result at 08:50 ended the stop');
    expect(s2.lines).toContain('Not delivered: Customer refused (driver, 08:50)');
    expect(s2.tone).toBe('bad');
    expect(m.stops.map((s) => `${s.loadNo}.${s.sequence} ${s.result} ${s.state}`)).toEqual([
      '1.1 DELIVERED DONE',
      '1.2 NOT_DELIVERED DONE',
      '1.3 PARTLY_DELIVERED DONE',
      '2.1 PENDING AT_STOP',
      '2.2 PENDING PENDING',
    ]);
    expect(m.summary).toEqual({ stops: 5, delivered: 1, partly: 1, notDelivered: 1, pending: 2 });
    expect(m.loads.map((l) => `L${l.loadNo} ${l.status} ${l.done}/${l.stops}`)).toEqual(['L1 COMPLETED 3/3', 'L2 DISPATCHED 0/2']);
    expect(m.drivers).toEqual(['Driver Example']);
  });

  it('waiting for the receiving window and the time on site against the planned unloading', () => {
    const early = { ...L1, status: 'DISPATCHED', stops: [stop(1, 3000, 480, { windowStartMin: 480, windowEndMin: 720, plannedServiceMin: 20 })] };
    const m = buildTruckDay(input({ loads: [early], visits: [visit(1, 1, { arrivedAt: T('07:40'), arrivalSource: 'PHONE_AUTO', departedAt: T('08:30'), departureSource: 'PHONE_AUTO' })], moves: [], events: [] }));
    const s = m.stops[0]!;
    expect(s).toMatchObject({ waitedMin: 20, onSiteMin: 50, plannedServiceMin: 20, lateMin: -20, state: 'LEFT', window: '08:00–12:00' });
    expect(m.timeline.find((t) => t.kind === 'STOP')!.lines).toEqual([
      'Planned 08:00, window 08:00–12:00, unloading 20 min',
      'Arrived 07:40 (driver), 20 min early',
      'Left 08:30 (driver)',
      'On site 50 min (planned unloading 20 min)',
      'Waited about 20 min for the receiving window to open (08:00)',
      'Left without a result',
    ]);
  });

  it('a day not started: every line at its planned time, in plan order', () => {
    const planned = { ...L1, status: 'LOCKED', dispatchedAt: null, statusChangedAt: null };
    const m = buildTruckDay(input({ visits: [], events: [], moves: [], loads: [planned], now: T('05:00') }));
    expect(ids(m)).toEqual([
      '(07:00) DISPATCHED L1 planned departure',
      '(07:30) STOP Stop 1 · Shop Example A (C-1)',
      '(08:00) STOP Stop 2 · Shop Example B (C-2)',
      '(08:30) STOP Stop 3 · Shop Example C (C-3)',
      '(10:00) DEPOT_IN Planned back at the depot',
    ]);
    expect(m.timeline[0]!.lines).toContain('Status: Locked');
    expect(m.timeline.every((t) => t.tone === 'muted')).toBe(true);
  });

  it('the alerts raised for the truck that day, at their time, by severity', () => {
    const alert = (id: string, severity: 'HIGH' | 'WARN', hhmm: string, state: OpsAlertRow['state']): OpsAlertRow => ({
      id,
      rule: 'UNLOAD_OVER',
      kind: 'CONDITION',
      severity,
      tier: severity === 'HIGH' ? 2 : 1,
      state,
      depotId: 'D1',
      deliveryDate: DATE,
      truckId: 't1',
      truckCode: 'T-100',
      loadNo: 1,
      sequence: 2,
      customerId: null,
      value: 50,
      threshold: 30,
      text: 'T-100 L1 stop 2, Shop Example B: unloading 50 min (planned 15)',
      occurredAt: T(hhmm).toISOString(),
      firstSeenAt: T(hhmm).toISOString(),
      lastSeenAt: T(hhmm).toISOString(),
      resolvedAt: state === 'RESOLVED' ? T('09:00').toISOString() : null,
      resolvedReason: state === 'RESOLVED' ? 'ENDED' : null,
      occurrences: 1,
      ackedAt: null,
      ackedByName: null,
      mayToast: true,
    });
    const m = buildTruckDay(input({ alerts: [alert('a1', 'HIGH', '08:45', 'OPEN'), alert('a2', 'WARN', '08:42', 'RESOLVED')] }));
    const alerts = m.timeline.filter((t) => t.kind === 'ALERT');
    expect(alerts.map((a) => `${a.key} ${a.tone}`)).toEqual(['alert:a2 muted', 'alert:a1 bad']);
    expect(alerts[1]).toMatchObject({ title: 'Alert: Unloading longer than planned', loadNo: 1, sequence: 2 });
    expect(alerts[1]!.lines).toEqual(['T-100 L1 stop 2, Shop Example B: unloading 50 min (planned 15)', 'High · Open']);
    // Between stop 2's arrival (08:40) and the depot (10:38).
    const order = m.timeline.map((t) => t.key);
    expect(order.indexOf('alert:a1')).toBe(order.indexOf('stop:D1:1:2') + 2);
  });
});

describe('an earlier GPS visit (a customer who refused first, received later)', () => {
  const gps = (seq: number, kind: 'ARRIVED' | 'DEPARTED', hhmm: string) => ev(1, seq, kind, 'AYUN', hhmm, { observed: true, segmentStartAt: T(hhmm).toISOString() });
  const day = (mode: TruckDayInput['mode']) =>
    buildTruckDay(
      input({
        mode,
        loads: [{ ...L1, status: 'DISPATCHED' }],
        visits: [visit(1, 2, { arrivedAt: T('13:40'), arrivalSource: 'PHONE_MANUAL', departedAt: T('13:58'), departureSource: 'AYUN', outcome: 'DELIVERED', outcomeAt: T('13:55'), outcomeSource: 'PHONE_MANUAL', casesDelivered: 40 })],
        events: [gps(2, 'ARRIVED', '08:10'), gps(2, 'DEPARTED', '08:16'), gps(2, 'ARRIVED', '13:39'), gps(2, 'DEPARTED', '13:58')],
        moves: [],
        now: T('15:00'),
      }),
    );

  it('TIMES: the 08:10 stay is listed at its time; the stay of the 13:40 arrival is the stop itself', () => {
    const m = day('TIMES');
    const g = m.timeline.filter((t) => t.kind === 'GPS_VISIT');
    expect(g).toHaveLength(1);
    expect(g[0]).toMatchObject({ title: 'Earlier GPS visit · stop 2 · Shop Example B', source: 'GPS (Ayun)', loadNo: 1, sequence: 2, at: T('08:10').toISOString() });
    expect(g[0]!.lines).toEqual(['At the customer 08:10-08:16 (6 min)', "Not the stop's times: the stop's arrival is 13:40 (driver)"]);
    expect(m.timeline.find((t) => t.key === 'stop:D1:1:2')!.lines).toContain('Left 13:58 (GPS (Ayun))');
  });

  it('OFF and MAP: no GPS visit, and the GPS departure is not shown (the times as the driver and the office made them)', () => {
    for (const mode of ['OFF', 'MAP'] as const) {
      const m = day(mode);
      expect(m.timeline.filter((t) => t.kind === 'GPS_VISIT')).toEqual([]);
      const s = m.stops.find((x) => x.sequence === 2)!;
      // The result stood in for the departure GPS gave (withoutGpsTimes).
      expect(s).toMatchObject({ arrivedAt: T('13:40').toISOString(), departedAt: T('13:55').toISOString(), departedAtResult: true, departureBy: 'driver' });
    }
  });

  it('otherGpsStays: before, after and without an arrival shown; a stay begun within 15 min of the arrival is its own', () => {
    const e = (kind: 'ARRIVED' | 'DEPARTED', hhmm: string) => ({ kind, source: 'AYUN' as const, at: T(hhmm), receivedAt: T(hhmm), payload: null });
    const stays = [e('ARRIVED', '08:10'), e('DEPARTED', '08:16'), e('ARRIVED', '10:00'), e('DEPARTED', '10:20'), e('ARRIVED', '12:00'), e('DEPARTED', '12:10')];
    expect(otherGpsStays(stays, { arrivedAt: T('09:50') }).map((s) => s.when)).toEqual(['EARLIER', 'LATER']);
    expect(otherGpsStays(stays, { arrivedAt: null }).map((s) => s.when)).toEqual(['UNUSED', 'UNUSED', 'UNUSED']);
    // A driver tap inside the stay keeps it.
    expect(otherGpsStays(stays, { arrivedAt: T('10:05') })).toHaveLength(2);
    // Only AYUN events count.
    expect(otherGpsStays([{ ...e('ARRIVED', '08:10'), source: 'PHONE_AUTO' as never }], { arrivedAt: null })).toEqual([]);
  });
});

describe('the GPS trail', () => {
  const trail = (n: number) => Array.from({ length: n }, (_, k) => ({ fixAt: new Date(T('06:00').getTime() + k * 10_000), ...at(k), speedKmh: 30 }));

  it('at most 2,000 points reach the page, evenly spread, first and last kept; [lng, lat] at 5 decimals', () => {
    const m = buildTruckDay(input({ trail: trail(5000) }));
    expect(m.trail.points).toHaveLength(TRAIL_MAX_POINTS);
    expect(m.trail.total).toBe(5000);
    const first = at(0);
    const last = at(4999);
    expect(m.trail.points[0]).toEqual([Math.round(first.lng * 1e5) / 1e5, Math.round(first.lat * 1e5) / 1e5]);
    expect(m.trail.points[TRAIL_MAX_POINTS - 1]).toEqual([Math.round(last.lng * 1e5) / 1e5, Math.round(last.lat * 1e5) / 1e5]);
    expect(m.trail.from).toBe(T('06:00').toISOString());
    expect(m.gps.trail).toBe(true);
  });

  it('downsampleTrail: fewer points come back as they are; never more than asked; evenly spaced', () => {
    expect(downsampleTrail([1, 2, 3], 2000)).toEqual([1, 2, 3]);
    const xs = Array.from({ length: 101 }, (_, k) => k);
    expect(downsampleTrail(xs, 11)).toEqual([0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100]);
    expect(downsampleTrail(xs, 1)).toEqual([0, 100]);
  });

  it('MAP, OFF and a suppressed truck-day show no trail, no GPS depot move and no GPS facts', () => {
    const facts = [{ kind: 'NEAR_DEPOT', loadNo: 1, sequences: [1], from: T('07:00').toISOString(), to: null }];
    expect(buildTruckDay(input({ trail: trail(50), truckDay: { suppressedAt: null, suppressReason: null, gpsFactsJson: facts } })).gps.facts).toHaveLength(1);
    for (const over of [{ mode: 'MAP' as const }, { mode: 'OFF' as const }, { truckDay: { suppressedAt: T('09:00'), suppressReason: 'UNDO', gpsFactsJson: facts } }]) {
      const m = buildTruckDay(input({ trail: trail(50), ...over }));
      expect(m.trail).toEqual({ points: [], total: 0, from: null, to: null });
      expect(m.gps).toMatchObject({ trail: false, times: false, facts: [] });
      expect(m.timeline.filter((t) => t.source === 'GPS trail' || t.source === 'Ayun webhook' || t.source === 'Ayun event list')).toEqual([]);
    }
    const sup = buildTruckDay(input({ truckDay: { suppressedAt: T('09:00'), suppressReason: 'UNDO', gpsFactsJson: null } }));
    expect(sup.gps.notes.join(' ')).toMatch(/GPS times of this truck-day were removed \(a company admin undid them\)/);
  });

  it('only the days the retention keeps whole (today and yesterday by default); an older day says why, even with points left', () => {
    const old = buildTruckDay(input({ date: '2026-10-15', trail: trail(50) }));
    expect(old.trail.total).toBe(0);
    expect(old.gps.notes.join(' ')).toMatch(/kept 2 days .*no longer shown/);
    expect(buildTruckDay(input({ date: '2026-10-19', trail: trail(50) })).trail.total).toBe(50);
    expect(buildTruckDay(input({ date: '2026-10-18', trail: trail(50) })).trail.total).toBe(0);
    expect(buildTruckDay(input({ date: '2026-10-15', trail: trail(50), trailDays: 7 })).trail.total).toBe(50);
    const fresh = buildTruckDay(input());
    expect(fresh.gps.notes.join(' ')).toMatch(/No GPS trail is stored for this day \(yet\)/);
  });

  it('trailKept: today back to ivmsTrailDays - 1 days, never a later day; 1-7 days', () => {
    expect(trailKept(DATE, DATE, 2)).toBe(true);
    expect(trailKept('2026-10-19', DATE, 2)).toBe(true);
    expect(trailKept('2026-10-18', DATE, 2)).toBe(false);
    expect(trailKept('2026-10-21', DATE, 2)).toBe(false);
    expect(trailKept('2026-10-19', DATE, 1)).toBe(false);
    expect(trailKept('2026-10-14', DATE, 7)).toBe(true);
    expect(trailKept('2026-10-13', DATE, 30)).toBe(false);
    expect(trailKept(DATE, DATE, 0)).toBe(true);
  });
});

describe('the live status (today)', () => {
  const pos = (fields: Partial<NonNullable<TruckDayInput['position']>>) => ({ truckId: 't1', fixAt: T('11:49'), lat: 0, lng: 0, speedKmh: 0, heading: null, flags: [], movedAt: null, ...fields });
  const doneL2Stop1 = visit(2, 1, { arrivedAt: T('11:35'), arrivalSource: 'PHONE_AUTO', departedAt: T('11:46'), departureSource: 'PHONE_AUTO', outcome: 'DELIVERED', outcomeAt: T('11:45'), outcomeSource: 'PHONE_MANUAL', casesDelivered: 40 });

  it('moving: the speed, the distance to the depot, the next stop of the load on the road with its live ETA', () => {
    const m = buildTruckDay(input({ visits: [doneL2Stop1], position: pos({ ...at(6000), speedKmh: 40, heading: 90 }) }));
    expect(m.live).toMatchObject({ stale: false, moving: true, speedKmh: 40, loadNo: 2, parkedSince: null, depotKm: 6 });
    expect(m.live!.next).toMatchObject({ loadNo: 2, sequence: 2, customerName: 'Shop Example B', atStop: false });
    expect(m.live!.text).toMatch(/^Updated 1 min ago \(11:49\) · moving, 40 km\/h · 6 km from the depot \(straight line\) · next: L2 stop 2, Shop Example B, about \d\d:\d\d/);
    expect(m.gps.live).toBe(true);
    expect(truckDayRefreshMs(m)).toBe(60_000);
    // The next stop's own line says it too.
    expect(m.timeline.find((t) => t.key === 'stop:D1:2:2')!.lines.at(-1)).toMatch(/^Live ETA about \d\d:\d\d( \([+-]\d+ min against the plan\))? \(GPS\)$/);
  });

  it('parked: since the last moving fix; at the stop it arrived at', () => {
    const m = buildTruckDay(input({ position: pos({ ...at(4000), movedAt: T('11:40') }) }));
    expect(m.live).toMatchObject({ moving: false, parkedSince: T('11:40').toISOString(), parkedMin: 9 });
    expect(m.live!.next).toMatchObject({ sequence: 1, atStop: true });
    expect(m.live!.text).toContain('parked since 11:40 (9 min)');
    expect(m.live!.text).toContain('at L2 stop 1, Shop Example A');
    expect(m.timeline.find((t) => t.key === 'stop:D1:2:1')!.lines).toContain('The truck is here now (GPS)');
  });

  it('a stale position: grey, no speed, no ETA', () => {
    const m = buildTruckDay(input({ position: pos({ ...at(4000), fixAt: T('11:20'), speedKmh: 50 }) }));
    expect(m.live).toMatchObject({ stale: true, speedKmh: null, moving: false, next: null });
    expect(m.live!.text).toMatch(/^No GPS position for 30 min \(last 11:20\)/);
  });

  it('OFF: no live status even with a position; another day than today: none either; no position today: a note', () => {
    const p = pos({ ...at(4000) });
    expect(buildTruckDay(input({ mode: 'OFF', position: p })).live).toBeNull();
    expect(buildTruckDay(input({ position: p, date: '2026-10-15' })).live).toBeNull();
    // Yesterday while a load of it is still out (a trip past midnight): shown.
    expect(buildTruckDay(input({ position: p, date: '2026-10-19', now: T('11:50') })).live).not.toBeNull();
    const none = buildTruckDay(input({ position: null }));
    expect(none.gps.notes.join(' ')).toMatch(/No live position now/);
    expect(buildTruckDay(input({ position: null, truck: { ...input().truck, hasTracker: false } })).gps.notes.join(' ')).toMatch(/no GPS tracker set/);
  });
});

describe('GPS tracking OFF and MAP', () => {
  it('OFF: the plan and the results; a GPS-only arrival is not shown; a note says GPS is off', () => {
    const m = buildTruckDay(input({ mode: 'OFF' }));
    const s3 = m.stops.find((s) => s.loadNo === 1 && s.sequence === 3)!;
    expect(s3).toMatchObject({ arrivedAt: null, arrivalBy: null, result: 'PARTLY_DELIVERED' });
    expect(m.gps).toMatchObject({ times: false, live: false, trail: false });
    expect(m.gps.notes[0]).toMatch(/^GPS tracking is off/);
    expect(m.timeline.some((t) => t.kind === 'DEPOT_OUT' && t.source === 'GPS trail')).toBe(false);
    // The driver's own taps stay.
    expect(m.timeline.filter((t) => t.source === 'driver').length).toBeGreaterThan(0);
  });

  it('MAP: a note that the times are the drivers and the office; GPS times not shown', () => {
    const m = buildTruckDay(input({ mode: 'MAP' }));
    expect(m.gps.notes[0]).toMatch(/live map only/);
    expect(m.stops.find((s) => s.loadNo === 1 && s.sequence === 3)!.arrivedAt).toBeNull();
  });

  it('never an IMEI or a provider name: the model holds RouteIQ data only, a depot field by field', () => {
    const depotRow = { ...DEPOT, ivmsZoneName: 'Example zone name', tenantId: 'tA' } as TruckDayInput['depots'][number];
    const m = buildTruckDay(input({ depots: [depotRow], position: { truckId: 't1', fixAt: T('11:49'), ...at(100), speedKmh: 0, heading: null, flags: [], movedAt: null } }));
    expect(JSON.stringify(m)).not.toMatch(/imei|zoneName|objectName|Example zone name|tenantId/i);
    expect(m.depots).toEqual([DEPOT]);
    expect(m.ayunUrl).toBe('https://server.ayunts.com');
  });

  it('the result with its reason and the note: Other carries it, any other result adds it', () => {
    const one = (fields: Partial<TruckDayVisitInput>) =>
      buildTruckDay(input({ loads: [{ ...L1, stops: [stop(1, 3000, 450)] }], visits: [visit(1, 1, { outcomeAt: T('07:40'), outcomeSource: 'PHONE_MANUAL', ...fields })], events: [], moves: [] })).stops[0]!.resultText;
    expect(one({ outcome: 'DELIVERED' })).toBe('Delivered');
    expect(one({ outcome: 'DELIVERED', reasonNote: 'left at the back door' })).toBe('Delivered; note: left at the back door');
    expect(one({ outcome: 'NOT_DELIVERED', reason: 'SHOP_CLOSED', reasonNote: 'closed for prayer' })).toBe('Not delivered: Shop closed; note: closed for prayer');
    expect(one({ outcome: 'NOT_DELIVERED', reason: 'OTHER', reasonNote: 'gate locked' })).toBe('Not delivered: Other - gate locked');
    expect(one({ outcome: 'PARTLY_DELIVERED' })).toBe('Partly delivered');
  });

  it('a receiving window of the whole day is no window (and no waiting)', () => {
    const anyTime = { ...L1, stops: [stop(1, 3000, 450, { windowStartMin: 0, windowEndMin: 1439 })] };
    const m = buildTruckDay(input({ loads: [anyTime], visits: [visit(1, 1, { arrivedAt: T('07:00'), arrivalSource: 'PHONE_AUTO' })], events: [], moves: [] }));
    expect(m.stops[0]).toMatchObject({ window: null, waitedMin: null });
  });
});

describe('the small helpers', () => {
  it('isIsoDate: a real calendar date written YYYY-MM-DD only', () => {
    expect(isIsoDate('2026-10-20')).toBe(true);
    for (const bad of ['2026-02-30', '20261020', '2026-1-2', '', null, undefined, 20, '2026-10-20T00:00']) expect(isIsoDate(bad)).toBe(false);
  });

  it('trailWindow: the local day, to the last activity + 15 min when later, never past 27 h', () => {
    const start = zonedDayStart(DATE, TZ);
    const h = (n: number) => new Date(start.getTime() + n * 3_600_000);
    expect(trailWindow(start, null)).toEqual({ from: start, to: h(24) });
    expect(trailWindow(start, h(10))).toEqual({ from: start, to: h(24) });
    expect(trailWindow(start, h(25))).toEqual({ from: start, to: h(25.25) });
    expect(trailWindow(start, h(40))).toEqual({ from: start, to: h(27) });
  });

  it("lastActivityOf: the latest visit time, tap or completion; null when nothing happened", () => {
    expect(lastActivityOf([], [], [])).toBeNull();
    const m = lastActivityOf(input().visits, input().events, [{ status: 'COMPLETED', statusChangedAt: T('10:45') }]);
    expect(m).toEqual(T('11:35'));
  });

  it('the date picker: dates with a load, newest first, the date shown kept; the days before and after', () => {
    expect(datePicker(['2026-10-15', '2026-10-20', '2026-10-19'], '2026-10-19')).toEqual({ options: ['2026-10-20', '2026-10-19', '2026-10-15'], older: '2026-10-15', newer: '2026-10-20' });
    expect(datePicker(['2026-10-15'], '2026-10-17')).toEqual({ options: ['2026-10-17', '2026-10-15'], older: '2026-10-15', newer: null });
    expect(dateLabel('2026-10-20', '2026-10-20')).toBe('Tue 20 Oct (today)');
    expect(dateLabel('2026-10-19', '2026-10-20')).toBe('Mon 19 Oct (yesterday)');
    expect(dateLabel('2026-10-21', '2026-10-20')).toBe('Wed 21 Oct (tomorrow)');
    expect(dateLabel('2026-10-18', '2026-10-20')).toBe('Sun 18 Oct');
  });

  it('timeOnDay: "+1" after the delivery day\'s midnight; the address of the page; the refresh only while the truck can move', () => {
    const start = zonedDayStart(DATE, TZ);
    expect(timeOnDay(T('07:05'), start, TZ)).toBe('07:05');
    expect(timeOnDay(new Date(start.getTime() + 24.5 * 3_600_000), start, TZ)).toBe('00:30 +1');
    expect(timeOnDay(new Date(start.getTime() - 1_800_000).toISOString(), start, TZ)).toBe('23:30');
    expect(truckDayHref('example', 't1', DATE)).toBe('/t/example/dispatch/truck/t1?date=2026-10-20');
    expect(truckDayRefreshMs({ date: DATE, today: DATE, live: null })).toBe(60_000);
    expect(truckDayRefreshMs({ date: '2026-10-15', today: DATE, live: null })).toBeNull();
  });

  it('no load that day: an empty timeline, no stop, no summary', () => {
    const m = buildTruckDay(input({ loads: [], visits: [], events: [], moves: [] }));
    expect(m).toMatchObject({ loads: [], stops: [], timeline: [], summary: { stops: 0, delivered: 0, partly: 0, notDelivered: 0, pending: 0 } });
    expect(m.dates).toEqual(['2026-10-20', '2026-10-19', '2026-10-15']);
  });
});
