/**
 * GPS alerts (owner request 18 Oct 2026: "build GPS alerts"; GPS tracking mode ALERTS): the operations
 * alerts' rules (lib/alerts/rules.ts) with the IVMS live link's GPS (lib/alerts/gps.ts), on synthetic facts.
 *  - golden: below ALERTS (the facts carry no GPS settings) a truck-day's GPS is never read, and the visits
 *    read through withoutGpsTimes give exactly the phone-only evaluation (facts.ts alertVisitRow);
 *  - each rule with GPS-only times: R1 from a GPS arrival / departure, R2 from the depot IN / OUT, R3 from
 *    the live position's ETA, R4 from the depot OUT, R5 capped while GPS follows the truck, R6 from a GPS
 *    arrival, R10 back by GPS;
 *  - observed vs unobserved GPS times (an upper bound never measures a duration);
 *  - a stale position (wait between two reads, phone-based without a fix) and a suppressed truck-day
 *    (no GPS: as with the link off);
 *  - the driver's tap wins over GPS;
 *  - the pure helpers (gpsLiveOf, outSince, gpsBackOf, moveObserved, gpsTruckDayFactOf, openStayEnd,
 *    gpsAlertConfigOf) and the replay with the GPS events and depot moves;
 *  - the review of 18 Oct 2026 (findings 1-6): the live ETA only while the GPS history has caught up with
 *    the fix, no close-and-reopen when a fix ages out, a GPS arrival ended by a batched result, a depot OUT
 *    that comes back (fuel), another depot's moves, the stored exactness of a depot move - several of them
 *    as sweeps in a row through the store (in memory), counting the rows reopened (e-mailed again).
 * Invented data only: truck T-100, depot D1, pins around 10.0001 / 20.0002; Asia/Muscat time (UTC+4).
 */
import type { StopVisit } from '@prisma/client';
import { describe, expect, it } from 'vitest';
import { ALERT_RULES, subjectKeyOf, thresholdsOf, type AlertConfig, type AlertKind, type AlertRule } from '@/lib/alerts/catalog';
import { alertVisitRow } from '@/lib/alerts/facts';
import {
  gpsAlertConfigOf,
  gpsBackOf,
  gpsLiveOf,
  gpsTruckDayFactOf,
  moveObserved,
  openStayEnd,
  outSince,
  GPS_OUT_CONFIRM_MIN,
  GPS_WAIT_MIN,
  historyCoversFix,
  LIVE_ETA_TRAIL_LAG_MIN,
  outState,
  type AlertGpsSettings,
} from '@/lib/alerts/gps';
import { replayDay, type AlertDayExport, type ExportEvent } from '@/lib/alerts/replay';
import { evaluate, openKey, type AlertFacts, type FactLoad, type FactStop, type FactTruckDay, type FactVisit, type OpenRowInfo } from '@/lib/alerts/rules';
import { applyPlanInMemory, planApply, type MemAlert } from '@/lib/alerts/store';
import type { Candidate, Evaluation } from '@/lib/alerts/types';
import { NO_OWN_TIMES, withoutGpsTimes } from '@/lib/delivery/visit';
import { addDaysIso, parseHhmm, zonedDayStart } from '@/lib/dispatch/time';
import { IVMS_MODES, type GpsTruckDayFact } from '@/lib/ivms/types';

const TZ = 'Asia/Muscat';
const D = '2026-10-20';
const at = (t: string, date = D) => new Date(zonedDayStart(date, TZ).getTime() + parseHhmm(t)! * 60_000);

const DEPOT = { lat: 10.0001, lng: 20.0002 };
const P1 = { lat: 10.01, lng: 20.01 };
const P2 = { lat: 10.02, lng: 20.02 };
const P3 = { lat: 10.03, lng: 20.03 };
const PINS = [P1, P2, P3];
const FAR = { lat: 10.05, lng: 20.06 };

const ON: Partial<AlertConfig> = {
  alertsEnabled: true,
  alertUnloadOverMin: 30,
  alertLoadingOverMin: 40,
  alertEtaLateMin: 30,
  alertDepartLateMin: 30,
  alertSilentMin: 120,
  alertPageNotOpenedMin: 30,
  alertAfterClosingMin: 15,
  alertPriorityMax: 2,
  alertDeliveredNote: true,
  alertProofFarM: 500,
  alertNotClosedMin: 120,
};
const ALL = thresholdsOf(ON);

const GPS: AlertGpsSettings = { atStopRadiusM: 250, atDepotRadiusM: 450, avgSpeedKmh: 40, distanceMultiplier: 1.3, depots: new Map([['D1', DEPOT]]) };

function visit(over: Partial<FactVisit> = {}): FactVisit {
  return {
    arrivedAt: null,
    arrivalSource: null,
    arrivalObserved: true,
    arrivalDistanceM: null,
    arrivalAccuracyM: null,
    timingSuspect: false,
    departedAt: null,
    departedAtOutcome: false,
    autoMinutes: null,
    autoServiceMinutes: null,
    outcome: null,
    reason: null,
    reasonNote: null,
    outcomeAt: null,
    outcomeSource: null,
    outcomeDistanceM: null,
    outcomeAccuracyM: null,
    casesPlanned: 10,
    casesDelivered: null,
    plannedServiceMin: null,
    windowStartMin: null,
    windowEndMin: null,
    photos: [],
    ...over,
  };
}

/** A GPS arrival (and departure) the visit rebuild filled in (StopVisit arrivalSource / departureSource AYUN). */
const gpsVisit = (arr: string, dep: string | null = null, o: { arrObserved?: boolean; depObserved?: boolean } = {}) =>
  visit({
    arrivedAt: at(arr),
    arrivalSource: 'AYUN',
    arrivalObserved: o.arrObserved ?? true,
    arrivalDistanceM: 30,
    departedAt: dep ? at(dep) : null,
    departureSource: dep ? 'AYUN' : null,
    departureObserved: o.depObserved ?? true,
  });

/** A stop the driver closed: tapped arrival, Delivered from the phone (the result ends it). */
const doneVisit = (arr: string, result: string) =>
  visit({ arrivedAt: at(arr), arrivalSource: 'PHONE_MANUAL', departedAt: at(result), departedAtOutcome: true, departureSource: 'PHONE_MANUAL', outcome: 'DELIVERED', outcomeAt: at(result), outcomeSource: 'PHONE_MANUAL' });

function stop(sequence: number, eta: number, over: Partial<FactStop> = {}): FactStop {
  return {
    sequence,
    customerId: `cust-${sequence}`,
    customerCode: `C${sequence}00`,
    branchCode: null,
    customerName: `Shop Example ${sequence}`,
    etaMin: eta,
    serviceStartMin: eta,
    departureMin: eta + 20,
    plannedServiceMin: 20,
    windowStartMin: null,
    windowEndMin: null,
    priority: 3,
    pinVerified: true,
    pin: PINS[sequence - 1] ?? null,
    visit: null,
    ...over,
  };
}

/** T-100 L1 of depot D1: depart 07:30, stops 08:00, 09:00, 10:00, back 12:00; dispatched 07:30. */
function load(over: Partial<FactLoad> = {}): FactLoad {
  const stops = over.stops ?? [stop(1, 480), stop(2, 540), stop(3, 600)];
  return {
    id: 'load-1',
    depotId: 'D1',
    date: D,
    truckId: 'TR1',
    truckCode: 'T-100',
    loadNo: 1,
    status: 'DISPATCHED',
    departMin: 450,
    returnMin: 720,
    statusChangedAt: at('07:30'),
    windowRule: 'START',
    breakMin: null,
    backAt: null,
    leftTapAt: null,
    stopCount: stops.length,
    ...over,
    stops,
  };
}

/** A depot move: its time (exact), or [time, exact, depot] (no depot: any). */
type MoveIn = string | [string, boolean] | [string, boolean, string];

/** The truck-day's GPS: a live fix (`fix`: when, `where`: the position), the trail-confirmed depot moves and how far the history was processed. */
function gpsDay(now: Date, o: { fix?: string | null; where?: { lat: number; lng: number } | null; speedKmh?: number; ins?: MoveIn[]; outs?: MoveIn[]; trailTo?: string } = {}): GpsTruckDayFact {
  const move = (m: MoveIn) => (typeof m === 'string' ? { kind: 'x', at: at(m), observed: true, depotId: null } : { kind: 'x', at: at(m[0]), observed: m[1], depotId: m[2] ?? null });
  return gpsTruckDayFactOf({
    position: o.fix ? { fixAt: at(o.fix), lat: (o.where ?? FAR).lat, lng: (o.where ?? FAR).lng, speedKmh: o.speedKmh ?? 0, flags: [], movedAt: at(o.fix) } : null,
    moves: [...(o.ins ?? []).map(move).map((m) => ({ ...m, kind: 'DEPOT_IN' as const })), ...(o.outs ?? []).map(move).map((m) => ({ ...m, kind: 'DEPOT_OUT' as const }))],
    trailTo: o.trailTo ? at(o.trailTo) : null,
    now,
  });
}

interface FactsOpts {
  gps?: GpsTruckDayFact | null;
  /** The facts' GPS settings (GPS tracking ALERTS); false: below ALERTS. */
  alerts?: boolean;
  open?: [AlertRule, string, ('CONDITION' | 'EVENT')?][];
  lastSignal?: FactTruckDay['lastSignal'];
}

function facts(loads: FactLoad[], o: FactsOpts = {}): AlertFacts {
  const truckDays: FactTruckDay[] = [{ date: D, truckId: 'TR1', linkSeenAt: at('07:35'), pageOpened: true, lastSignal: o.lastSignal ?? null, gps: o.gps ?? null }];
  const open = new Map<string, OpenRowInfo>();
  for (const [rule, key, kind] of o.open ?? []) open.set(openKey(rule, key), { kind: kind ?? 'CONDITION', tier: 1, depotId: 'D1', deliveryDate: D });
  return { tz: TZ, today: D, dates: [addDaysIso(D, -1), D, addDaysIso(D, 1)], loads, truckDays, open, ...(o.alerts === false ? {} : { gps: GPS }) };
}

const loadKey = (loadNo = 1) => subjectKeyOf({ depotId: 'D1', date: D, truckId: 'TR1', loadNo });
const stopKey = (sequence: number, loadNo = 1) => subjectKeyOf({ depotId: 'D1', date: D, truckId: 'TR1', loadNo, sequence });
const raised = (ev: Evaluation, rule: AlertRule, key?: string): Candidate | undefined => ev.active.find((c) => c.rule === rule && (!key || c.subjectKey === key));
const ended = (ev: Evaluation, rule: AlertRule, key: string) => ev.ended.find((e) => e.rule === rule && e.subjectKey === key);
const held = (ev: Evaluation, rule: AlertRule, key: string) => (ev.held ?? []).some((h) => h.rule === rule && h.subjectKey === key);
const only = (rule: AlertRule) => ({ ...Object.fromEntries(Object.keys(ALL).map((k) => [k, null])), [rule]: ALL[rule] }) as typeof ALL;

describe('golden: below GPS tracking ALERTS nothing changes', () => {
  it('ALERTS is the fourth mode, after TIMES; only ALERTS (and the link not switched off) gives the alerts their GPS', () => {
    expect(IVMS_MODES).toEqual(['OFF', 'MAP', 'TIMES', 'ALERTS']);
    for (const mode of ['OFF', 'MAP', 'TIMES', 'alerts', null]) expect(gpsAlertConfigOf({ ivmsMode: mode }, false), String(mode)).toBeNull();
    expect(gpsAlertConfigOf({ ivmsMode: 'ALERTS' }, true)).toBeNull();
    expect(gpsAlertConfigOf({ ivmsMode: 'ALERTS', ivmsStopRadiusM: 120, ivmsDepotRadiusM: 400, avgSpeedKmh: 35, distanceMultiplier: 1.2 }, false)).toEqual({
      atStopRadiusM: 270,
      atDepotRadiusM: 550,
      avgSpeedKmh: 35,
      distanceMultiplier: 1.2,
    });
  });

  it('a visit read for the alerts below ALERTS has no GPS time (a GPS-only visit is none); in ALERTS it is the stored visit', () => {
    const row = { id: 'v1', arrivedAt: at('08:00'), arrivalSource: 'AYUN', arrivalDistanceM: 30, arrivalAccuracyM: null, arrivalObserved: true, departedAt: at('08:40'), departureSource: 'AYUN', departedAtOutcome: false, outcome: null, outcomeAt: null, outcomeSource: null } as unknown as StopVisit;
    expect(alertVisitRow(row, [])).toBeNull();
    expect(alertVisitRow(row, [], true)).toBe(row);
    const tapped = { ...row, arrivalSource: 'PHONE_MANUAL' } as StopVisit;
    expect(alertVisitRow(tapped, [])).toMatchObject({ arrivedAt: at('08:00'), departedAt: null, departureSource: null });
  });

  it('the same day read as TIMES reads it (withoutGpsTimes, no GPS settings) evaluates exactly as the phone alone, whatever GPS the truck-day carries', () => {
    const now = at('09:20');
    const withGps = (v: FactVisit) => withoutGpsTimes({ ...NO_OWN_TIMES, ...v, departureSource: v.departureSource ?? null });
    const phoneOnly = load({ stops: [stop(1, 480, { visit: null }), stop(2, 540), stop(3, 600)] });
    const timesRead = load({ stops: [stop(1, 480, { visit: withGps(gpsVisit('08:00', '08:50')) }), stop(2, 540), stop(3, 600)] });
    // withoutGpsTimes leaves the row's other fields: a GPS-only visit is then a visit without any time.
    expect(timesRead.stops[0]!.visit).toMatchObject({ arrivedAt: null, departedAt: null });
    const a = evaluate(facts([phoneOnly], { alerts: false }), now, ALL);
    const b = evaluate(facts([{ ...timesRead, stops: timesRead.stops.map((s) => ({ ...s, visit: s.visit?.arrivedAt ? s.visit : null })) }], { alerts: false, gps: gpsDay(now, { fix: '09:19', where: P1, outs: ['07:35'], ins: ['09:10'] }) }), now, ALL);
    expect(b).toEqual(a);
  });

  it('GPS-sourced visit times without the GPS settings are not treated as GPS (R1 keeps its phone words)', () => {
    const now = at('09:00');
    const ev = evaluate(facts([load({ stops: [stop(1, 480, { visit: gpsVisit('08:00', null, { arrObserved: false }) }), stop(2, 540), stop(3, 600)] })], { alerts: false }), now, only('UNLOAD_OVER'));
    expect(raised(ev, 'UNLOAD_OVER')?.text).toMatch(/since arrival 08:00 \(arrival time not certain\)/);
  });
});

describe('the pure helpers', () => {
  it('gpsLiveOf: LIVE with a fresh fix, WAIT between two reads (at most GPS_WAIT_MIN old), else null', () => {
    const now = at('10:00');
    expect(gpsLiveOf(null, now)).toBeNull();
    expect(gpsLiveOf(gpsDay(now, { fix: '09:58', where: P1 }), now)).toBe('LIVE');
    expect(gpsLiveOf(gpsDay(now, { fix: '09:50', where: P1 }), now)).toBe('WAIT');
    expect(gpsLiveOf(gpsDay(now, { fix: '09:29', where: P1 }), now)).toBeNull();
    expect(GPS_WAIT_MIN).toBe(30);
    // A stale fix is never "tracked" and its position is not kept.
    expect(gpsDay(now, { fix: '09:50', where: P1 })).toMatchObject({ tracked: false, position: null, fixAt: at('09:50') });
  });

  it('gpsTruckDayFactOf: an invalid fix is never tracked; parked minutes; trips from the moves', () => {
    const now = at('10:00');
    const f = gpsTruckDayFactOf({ position: { fixAt: at('09:59'), lat: 10.01, lng: 20.01, speedKmh: 0, flags: ['INVALID_FIX'], movedAt: at('09:40') }, moves: [], trailTo: null, now });
    expect(f.tracked).toBe(false);
    const g = gpsTruckDayFactOf({
      position: { fixAt: at('09:59'), lat: 10.01, lng: 20.01, speedKmh: 0, flags: [], movedAt: at('09:40') },
      moves: [
        { kind: 'DEPOT_IN', at: at('11:00'), observed: true },
        { kind: 'DEPOT_OUT', at: at('07:35'), observed: true },
        { kind: 'DEPOT_OUT', at: at('11:50'), observed: false },
      ],
      trailTo: at('09:30'),
      now,
    });
    expect(g).toMatchObject({ tracked: true, parkedSinceMin: 19, position: { lat: 10.01, lng: 20.01 }, trailTo: at('09:30') });
    expect(g.trips).toEqual([
      { outAt: at('07:35'), inAt: at('11:00'), loadNo: null },
      { outAt: at('11:50'), inAt: null, loadNo: null },
    ]);
    expect(g.depotOut.map((m) => m.observed)).toEqual([true, false]);
  });

  it('moveObserved: a zone move is the device\'s own; a trail move only with a point at most 5 min before it', () => {
    expect(moveObserved({ kind: 'DEPOT_OUT', at: at('08:00'), origin: 'WEBHOOK' }, [])).toBe(true);
    expect(moveObserved({ kind: 'DEPOT_OUT', at: at('08:00'), origin: 'TRAIL' }, [at('07:56')])).toBe(true);
    expect(moveObserved({ kind: 'DEPOT_OUT', at: at('08:00'), origin: 'TRAIL' }, [at('07:54'), at('08:01')])).toBe(false);
  });

  it('outSince: the truck is out since its last OUT with no IN after it (a fuel run that came back is no departure)', () => {
    const now = at('10:00');
    const g = gpsDay(now, { outs: ['06:00', '08:10'], ins: ['06:30'] });
    expect(outSince(g, at('05:30'), now)?.at).toEqual(at('08:10'));
    expect(outSince(g, at('05:30'), at('07:00'))).toBeNull();
    expect(outSince(gpsDay(now, { outs: ['06:00'], ins: ['06:30'] }), at('05:30'), now)).toBeNull();
  });

  it('gpsBackOf: the first IN after the last sign, only once every stop has a result or a sign', () => {
    const now = at('13:00');
    const g = gpsDay(now, { ins: ['09:30', '11:40'] });
    expect(gpsBackOf(g, { lastSignAt: at('10:10'), dispatchAt: at('07:30'), allStopsDone: true }, now)?.at).toEqual(at('11:40'));
    expect(gpsBackOf(g, { lastSignAt: at('10:10'), dispatchAt: at('07:30'), allStopsDone: false }, now)).toBeNull();
    expect(gpsBackOf(g, { lastSignAt: null, dispatchAt: at('07:30'), allStopsDone: true }, now)).toBeNull();
    expect(gpsBackOf(g, { lastSignAt: at('10:10'), dispatchAt: null, allStopsDone: true }, at('11:00'))).toBeNull();
  });

  it('openStayEnd: in progress while the fresh fix is at the stop; away: by the planned end, never after the fix; a GPS stay the trail lost: never pushed by the clock', () => {
    const now = at('10:00');
    const v = { arrivedAt: at('09:00'), gpsArrival: true, plannedServiceMin: 20 };
    expect(openStayEnd(v, 'AT', gpsDay(now, { fix: '09:59', where: P1 }), now)).toBeNull();
    expect(openStayEnd(v, 'AWAY', gpsDay(now, { fix: '09:59', where: FAR }), now)).toEqual(at('09:20'));
    expect(openStayEnd(v, 'AWAY', gpsDay(now, { fix: '09:10', where: FAR }), at('09:11'))).toEqual(at('09:10'));
    expect(openStayEnd(v, null, gpsDay(now, { trailTo: '09:45' }), now)).toEqual(at('09:45'));
    expect(openStayEnd(v, null, gpsDay(now, { trailTo: '10:30' }), now)).toBeNull();
    expect(openStayEnd({ ...v, gpsArrival: false }, null, gpsDay(now), now)).toBeNull();
  });
});

describe('R1 unloading longer than planned, from GPS times', () => {
  const r1 = (v: FactVisit, now: Date, gps: GpsTruckDayFact | null, open = false) =>
    evaluate(facts([load({ stops: [stop(1, 480, { visit: v }), stop(2, 540), stop(3, 600)] })], { gps, open: open ? [['UNLOAD_OVER', stopKey(1)]] : [] }), now, only('UNLOAD_OVER'));

  it('a GPS arrival starts the unloading like a tap, raised live while the fresh position shows the truck still there; the text says GPS', () => {
    const now = at('09:00');
    const c = raised(r1(gpsVisit('08:00'), now, gpsDay(now, { fix: '08:58', where: P1 })), 'UNLOAD_OVER', stopKey(1))!;
    expect(c).toMatchObject({ tier: 1, value: 40, threshold: 30 });
    expect(c.history).toBeUndefined();
    expect(c.text).toMatch(/^T-100 L1 stop 1 Shop Example 1 \(C100\): no result or departure recorded since arrival 08:00 \(GPS\) - 1 h at the stop, planned 20 min \(40 min over\)\. GPS: the truck is still there at 08:58\./);
    expect(c.facts).toMatchObject({ gps: true });
  });

  it('the fresh position away from the stop: it has left - nothing new, an open row waits for the GPS departure', () => {
    const now = at('09:00');
    const g = gpsDay(now, { fix: '08:58', where: P2 });
    expect(raised(r1(gpsVisit('08:00'), now, g), 'UNLOAD_OVER')).toBeUndefined();
    expect(ended(r1(gpsVisit('08:00'), now, g), 'UNLOAD_OVER', stopKey(1))?.text).toMatch(/away from the stop: it has left .*\(GPS\)/);
    expect(held(r1(gpsVisit('08:00'), now, g, true), 'UNLOAD_OVER', stopKey(1))).toBe(true);
  });

  it('between two reads it waits (an open row stays, nothing new); with no fix for longer a GPS arrival is not followed live, but an open row waits (review finding 2)', () => {
    const now = at('09:00');
    const wait = gpsDay(now, { fix: '08:45', where: P1 });
    expect(raised(r1(gpsVisit('08:00'), now, wait), 'UNLOAD_OVER')).toBeUndefined();
    expect(held(r1(gpsVisit('08:00'), now, wait, true), 'UNLOAD_OVER', stopKey(1))).toBe(true);
    const none = gpsDay(now, { trailTo: '08:30' });
    expect(raised(r1(gpsVisit('08:00'), now, none), 'UNLOAD_OVER')).toBeUndefined();
    expect(ended(r1(gpsVisit('08:00'), now, none), 'UNLOAD_OVER', stopKey(1))?.text).toMatch(/no recent GPS position shows the truck still there, so the unloading is not followed live \(GPS\)/);
    // Never closed as NOT_FOLLOWED only because the fix aged out: the next fresh fix would raise it again (and e-mail again).
    expect(held(r1(gpsVisit('08:00'), now, none, true), 'UNLOAD_OVER', stopKey(1))).toBe(true);
    expect(r1(gpsVisit('08:00'), now, none, true).ended.find((e) => e.rule === 'UNLOAD_OVER' && e.subjectKey === stopKey(1))).toBeUndefined();
  });

  it('an unobserved GPS arrival or departure is only an upper bound: never measured', () => {
    const now = at('09:00');
    expect(raised(r1(gpsVisit('08:00', null, { arrObserved: false }), now, gpsDay(now, { fix: '08:58', where: P1 })), 'UNLOAD_OVER')).toBeUndefined();
    expect(ended(r1(gpsVisit('08:00', null, { arrObserved: false }), now, null), 'UNLOAD_OVER', stopKey(1))?.text).toMatch(/GPS arrival 08:00 is not certain .*not measured \(GPS\)/);
    const later = at('10:30');
    expect(raised(r1(gpsVisit('08:00', '09:20', { depObserved: false }), later, null), 'UNLOAD_OVER')).toBeUndefined();
    expect(ended(r1(gpsVisit('08:00', '09:20', { depObserved: false }), later, null), 'UNLOAD_OVER', stopKey(1))?.text).toMatch(/GPS departure 09:20 is not certain/);
  });

  it('a GPS arrival and departure, both observed, measure it: over the limit and never seen live, one history row naming GPS', () => {
    const now = at('10:30');
    const c = raised(r1(gpsVisit('08:00', '09:20'), now, null), 'UNLOAD_OVER', stopKey(1))!;
    expect(c).toMatchObject({ history: true, value: 60, tier: 1 });
    expect(c.text).toBe('T-100 L1 stop 1 Shop Example 1 (C100): unloading took 1 h 20 min (GPS arrival and departure), planned 20 min (1 h over).');
  });

  it("the driver's tap wins: his arrival with a GPS departure (the rebuild only filled the gap) says GPS departure", () => {
    const now = at('10:30');
    const v = visit({ arrivedAt: at('08:10'), arrivalSource: 'PHONE_MANUAL', departedAt: at('09:20'), departureSource: 'AYUN', departureObserved: true });
    expect(raised(r1(v, now, null), 'UNLOAD_OVER', stopKey(1))?.text).toMatch(/unloading took 1 h 10 min \(GPS departure\), planned 20 min \(50 min over\)/);
  });

  it('a phone arrival with no departure: the fresh position away from the stop means the truck left (no alert from the phone alone)', () => {
    const now = at('09:00');
    const v = visit({ arrivedAt: at('08:00'), arrivalSource: 'PHONE_MANUAL' });
    expect(raised(r1(v, now, gpsDay(now, { fix: '08:58', where: P3 })), 'UNLOAD_OVER')).toBeUndefined();
    // No GPS for the truck-day (suppressed, or no tracker): as before.
    expect(raised(r1(v, now, null), 'UNLOAD_OVER')?.text).toMatch(/no result or departure tapped since arrival 08:00 - 1 h at the stop/);
  });
});

describe('R2 loading between trips, from the depot moves', () => {
  /** L1 completed (every stop Delivered by 10:10, no Back at depot tap); L2 of the same truck (planned 12:00). */
  function day(l2: Partial<FactLoad>, l1: Partial<FactLoad> = {}): FactLoad[] {
    return [
      load({ status: 'COMPLETED', statusChangedAt: at('12:30'), returnMin: 660, stops: [stop(1, 480, { visit: doneVisit('08:00', '08:10') }), stop(2, 540, { visit: doneVisit('09:00', '09:10') }), stop(3, 600, { visit: doneVisit('10:00', '10:10') })], ...l1 }),
      load({ id: 'load-2', loadNo: 2, departMin: 720, returnMin: 900, statusChangedAt: at('07:00'), stops: [stop(1, 750), stop(2, 780)], ...l2 }),
    ];
  }

  it('no Back at depot tap: the observed depot IN counts as it, the observed depot OUT as the leave - over the limit, one history row naming GPS', () => {
    const now = at('12:30');
    // The trail followed the truck out for 40 min after the OUT (GPS_OUT_CONFIRM_MIN): it left.
    const ev = evaluate(facts(day({}), { gps: gpsDay(now, { ins: ['10:40'], outs: ['07:35', '11:40'], trailTo: '12:20' }) }), now, only('LOADING_OVER'));
    const c = raised(ev, 'LOADING_OVER', loadKey(2))!;
    expect(c).toMatchObject({ history: true, value: 60, tier: 1 });
    expect(c.text).toBe('T-100 L2: 1 h at the depot between L1 and L2 (back 10:40 (GPS), left 11:40, by the GPS depot exit (no Leaving tap)), limit 40 min.');
    expect(c.facts).toMatchObject({ how: 'GPS', gps: true });
  });

  it('an unobserved depot IN or OUT never measures it', () => {
    const now = at('12:30');
    expect(ended(evaluate(facts(day({}), { gps: gpsDay(now, { ins: [['10:40', false]], outs: ['11:40'] }) }), now, only('LOADING_OVER')), 'LOADING_OVER', loadKey(2))?.text).toMatch(/no Back at depot tapped for L1/);
    // An unobserved OUT is no leave: the Dispatch press was before Back at depot, no stop reached: still "at the depot" (no fresh position: not followed live).
    const ev = evaluate(facts(day({}), { gps: gpsDay(now, { ins: ['10:40'], outs: [['11:40', false]] }) }), now, only('LOADING_OVER'));
    expect(raised(ev, 'LOADING_OVER')).toBeUndefined();
  });

  it("the driver's taps win: Back at depot and Leaving for next load tapped, GPS moves aside", () => {
    const now = at('12:30');
    const ev = evaluate(facts(day({ leftTapAt: at('11:20'), leftTaps: [at('11:20')] }, { backAt: at('10:50') }), { gps: gpsDay(now, { ins: ['10:40'], outs: ['11:40'] }) }), now, only('LOADING_OVER'));
    expect(ended(ev, 'LOADING_OVER', loadKey(2))?.text).toBe('T-100 L2: 30 min at the depot between L1 and L2 (back 10:50, left 11:20, by Leaving tapped), limit 40 min.');
  });

  it('live from a GPS return only while the fresh position shows the truck at the depot (the planned wait counts); away: it has left', () => {
    const now = at('11:30');
    const loading = { status: 'LOADING', statusChangedAt: at('10:50') };
    const atDepot = evaluate(facts(day(loading), { gps: gpsDay(now, { fix: '11:29', where: DEPOT, ins: ['10:40'] }) }), now, only('LOADING_OVER'));
    const c = raised(atDepot, 'LOADING_OVER', loadKey(2))!;
    expect(c).toMatchObject({ value: 50, tier: 1 });
    expect(c.history).toBeUndefined();
    expect(c.text).toMatch(/^T-100 L2: at the depot for 50 min since L1 back at the depot at 10:40 \(GPS\), not left with L2 yet \(limit 40 min\)\. Planned departure 12:00, load is Loading\. GPS: the truck is at the depot at 11:29\.$/);
    const away = evaluate(facts(day(loading), { gps: gpsDay(now, { fix: '11:29', where: P2, ins: ['10:40'] }) }), now, only('LOADING_OVER'));
    expect(raised(away, 'LOADING_OVER')).toBeUndefined();
    expect(ended(away, 'LOADING_OVER', loadKey(2))?.text).toMatch(/away from the depot: it has left with L2/);
    // No fix for longer (review finding 2): an open row waits for one, or for the OUT - never NOT_FOLLOWED and raised again.
    const noFix = evaluate(facts(day(loading), { gps: gpsDay(now, { ins: ['10:40'] }), open: [['LOADING_OVER', loadKey(2)]] }), now, only('LOADING_OVER'));
    expect(noFix.ended.find((e) => e.subjectKey === loadKey(2))).toBeUndefined();
    expect(held(noFix, 'LOADING_OVER', loadKey(2))).toBe(true);
    expect(raised(evaluate(facts(day(loading), { gps: gpsDay(now, { ins: ['10:40'] }) }), now, only('LOADING_OVER')), 'LOADING_OVER')).toBeUndefined();
  });
});

describe('R3 running late, from the live position', () => {
  const stops = () => [stop(1, 480, { visit: doneVisit('08:00', '08:20') }), stop(2, 540), stop(3, 600)];

  it('with a fresh position: the live map\'s ETA of the next stop, also while the driver is silent; the text says GPS', () => {
    const now = at('10:00');
    // Nothing from the phone since the Dispatch press: R5 is raised (a warning: GPS follows the truck), and R3 is not held for it.
    const ev = evaluate(facts([load({ stops: stops() })], { gps: gpsDay(now, { fix: '09:59', where: P1, speedKmh: 30, trailTo: '09:55' }) }), now, { ...only('ETA_LATE'), DRIVER_SILENT: 120 });
    expect(raised(ev, 'DRIVER_SILENT', loadKey())).toMatchObject({ tier: 1 });
    const c = raised(ev, 'ETA_LATE', loadKey())!;
    expect(c.text).toMatch(/^T-100 L1 is running about 1 h \d\d min late \(GPS\): next stop 2 Shop Example 2 \(C200\) expected about 10:\d\d from the truck's GPS position at 09:59 \(planned 09:00\); 2 stops left, back about/);
    expect(c.facts).toMatchObject({ nextSequence: 2, gps: true });
    expect(c.value).toBeGreaterThan(60);
  });

  it('on time by the fresh position: an open row closes with the GPS words', () => {
    const now = at('10:00');
    const late = [stop(1, 480, { visit: doneVisit('08:00', '08:20') }), stop(2, 610), stop(3, 640)];
    const near = { lat: 10.0195, lng: 20.0195 };
    const ev = evaluate(facts([load({ stops: late })], { gps: gpsDay(now, { fix: '09:59', where: near, speedKmh: 30, trailTo: '09:58' }), open: [['ETA_LATE', loadKey()]] }), now, only('ETA_LATE'));
    expect(raised(ev, 'ETA_LATE')).toBeUndefined();
    expect(ended(ev, 'ETA_LATE', loadKey())?.text).toMatch(/back on time .* by the GPS position at 09:59\) \(GPS\)\.$/);
  });

  it('between two reads it waits: an open row stays, nothing new from the phone alone; with no fix for longer, the phone-based projection as before', () => {
    const now = at('10:00');
    const wait = gpsDay(now, { fix: '09:45', where: P1 });
    expect(raised(evaluate(facts([load({ stops: stops() })], { gps: wait }), now, only('ETA_LATE')), 'ETA_LATE')).toBeUndefined();
    expect(held(evaluate(facts([load({ stops: stops() })], { gps: wait, open: [['ETA_LATE', loadKey()]] }), now, only('ETA_LATE')), 'ETA_LATE', loadKey())).toBe(true);
    const stale = gpsDay(now, { fix: '09:00', where: P1 });
    const phone = raised(evaluate(facts([load({ stops: stops() })], { gps: stale }), now, only('ETA_LATE')), 'ETA_LATE')!;
    const before = raised(evaluate(facts([load({ stops: stops() })], { alerts: false }), now, only('ETA_LATE')), 'ETA_LATE')!;
    expect(phone.text).toBe(before.text);
    expect(phone.text).not.toMatch(/GPS/);
  });
});

describe('R4 not dispatched on time: the depot OUT counts as leaving', () => {
  const locked = () => load({ status: 'LOCKED', statusChangedAt: at('05:00'), stops: [], stopCount: 3 });

  it('left late by GPS, Dispatch not pressed: one history row with the time it left; left on time: closes', () => {
    const now = at('09:00');
    // The trail followed the truck out for 35 min after the OUT (GPS_OUT_CONFIRM_MIN): it left.
    const late = evaluate(facts([locked()], { gps: gpsDay(now, { outs: ['08:20'], trailTo: '08:55' }) }), now, only('DEPART_LATE'));
    const c = raised(late, 'DEPART_LATE', loadKey())!;
    expect(c).toMatchObject({ history: true, value: 50, tier: 1, occurredAt: at('08:20') });
    expect(c.text).toBe('T-100 L1 left the depot at 08:20 (GPS), 50 min after 07:30; Dispatch is not pressed yet (load is Locked): press it so the driver page and the alerts follow the truck.');
    const onTime = evaluate(facts([locked()], { gps: gpsDay(now, { outs: ['07:40'], trailTo: '08:55' }), open: [['DEPART_LATE', loadKey()]] }), now, only('DEPART_LATE'));
    expect(ended(onTime, 'DEPART_LATE', loadKey())?.text).toMatch(/^T-100 L1 left the depot at 07:40 \(GPS\), 10 min after 07:30; Dispatch is not pressed yet/);
    expect(ended(onTime, 'DEPART_LATE', loadKey())?.reason).toBe('ENDED');
  });

  it('an unobserved OUT says it left by then, never how late; a fuel run that came back is no departure', () => {
    const now = at('09:00');
    const ev = evaluate(facts([locked()], { gps: gpsDay(now, { outs: [['08:20', false]], trailTo: '08:55' }) }), now, only('DEPART_LATE'));
    expect(raised(ev, 'DEPART_LATE')).toBeUndefined();
    expect(ended(ev, 'DEPART_LATE', loadKey())?.text).toMatch(/left the depot by 08:20 \(GPS\) \(planned 07:30\)/);
    const fuel = evaluate(facts([locked()], { gps: gpsDay(now, { fix: '08:59', where: DEPOT, outs: ['06:00'], ins: ['06:30'] }) }), now, only('DEPART_LATE'));
    expect(raised(fuel, 'DEPART_LATE')?.text).toMatch(/not dispatched: planned departure 07:30, now 09:00 \(1 h 30 min late\), load is Locked\. Driver page last open 07:35\. GPS: the truck is still at the depot at 08:59\. Dispatch it if it has left\.$/);
  });

  it('the fresh position away from the depot: it has left (nothing new); no GPS: as before', () => {
    const now = at('08:30');
    expect(raised(evaluate(facts([locked()], { gps: gpsDay(now, { fix: '08:29', where: P1 }) }), now, only('DEPART_LATE')), 'DEPART_LATE')).toBeUndefined();
    expect(raised(evaluate(facts([locked()], { gps: null }), now, only('DEPART_LATE')), 'DEPART_LATE')?.text).toMatch(/not dispatched: planned departure 07:30.* Dispatch it if it has left\.$/);
  });
});

describe('R5 driver silent: followed by GPS, a warning at most', () => {
  it('silent for 4 h 10 min with GPS following the truck: tier 1 (2 without GPS), saying when GPS last saw it', () => {
    const now = at('11:40');
    const ev = evaluate(facts([load()], { gps: gpsDay(now, { fix: '11:38', where: FAR, speedKmh: 42 }) }), now, only('DRIVER_SILENT'));
    const c = raised(ev, 'DRIVER_SILENT', loadKey())!;
    expect(c.tier).toBe(1);
    expect(c.text).toMatch(/GPS last saw the truck at 11:38 \(moving, 42 km\/h\): it is followed, but no results come from the driver \(GPS\)\.$/);
    expect(raised(evaluate(facts([load()], { gps: null }), now, only('DRIVER_SILENT')), 'DRIVER_SILENT')!.tier).toBe(2);
  });

  it('GPS stop times count as progress: a truck the trail shows working through its stops is not overdue', () => {
    const now = at('10:35');
    const progressing = load({ stops: [stop(1, 480, { visit: gpsVisit('08:00', '08:20') }), stop(2, 540, { visit: gpsVisit('09:00', '09:20') }), stop(3, 600, { visit: gpsVisit('10:00', '10:20') })] });
    const ev = evaluate(facts([progressing], { gps: gpsDay(now, { trailTo: '10:30' }) }), now, only('DRIVER_SILENT'));
    expect(raised(ev, 'DRIVER_SILENT')).toBeUndefined();
  });
});

describe('R6 after the delivery window: an observed GPS arrival is an arrival', () => {
  const windowed = (v: FactVisit) => load({ stops: [stop(1, 480, { windowEndMin: 840, visit: v }), stop(2, 540), stop(3, 600)] });

  it('a GPS arrival after the window: an event naming GPS (no result needed); unobserved: not certain', () => {
    const now = at('14:30');
    const c = raised(evaluate(facts([windowed(gpsVisit('14:20'))]), now, only('AFTER_CLOSING')), 'AFTER_CLOSING', stopKey(1))!;
    expect(c).toMatchObject({ kind: 'EVENT', tier: 1, value: 20 });
    expect(c.text).toBe('T-100 L1 stop 1 Shop Example 1 (C100): arrived 14:20 (GPS), after its delivery window ended at 14:00 (20 min late).');
    expect(ended(evaluate(facts([windowed(gpsVisit('14:20', null, { arrObserved: false }))]), now, only('AFTER_CLOSING')), 'AFTER_CLOSING', stopKey(1))?.text).toMatch(/GPS arrival time is not certain/);
  });

  it("the driver's tap wins: his arrival inside the window corrects the GPS event", () => {
    const now = at('14:30');
    const tapped = visit({ arrivedAt: at('13:50'), arrivalSource: 'PHONE_MANUAL' });
    const ev = evaluate(facts([windowed(tapped)], { open: [['AFTER_CLOSING', stopKey(1), 'EVENT']] }), now, only('AFTER_CLOSING'));
    expect(ev.ended.find((e) => e.subjectKey === stopKey(1))).toMatchObject({ reason: 'CORRECTED', text: expect.stringMatching(/arrived 13:50, inside its delivery window/) });
  });
});

describe('R10 load not closed: back at the depot by GPS', () => {
  const allDone = () => load({ stops: [stop(1, 480, { visit: doneVisit('08:00', '08:10') }), stop(2, 540, { visit: doneVisit('09:00', '09:10') }), stop(3, 600, { visit: doneVisit('10:00', '10:10') })] });

  it('every result in and the trail shows the truck back: closing, as with Back at depot', () => {
    const now = at('14:30');
    const ev = evaluate(facts([allDone()], { gps: gpsDay(now, { ins: ['10:40'] }), open: [['LOAD_NOT_CLOSED', loadKey()]] }), now, only('LOAD_NOT_CLOSED'));
    expect(ended(ev, 'LOAD_NOT_CLOSED', loadKey())?.text).toBe('T-100 L1: back at the depot at 10:40 (GPS) with every result recorded: closing.');
    expect(raised(evaluate(facts([allDone()], { gps: null }), now, only('LOAD_NOT_CLOSED')), 'LOAD_NOT_CLOSED')?.text).toMatch(/no Back at depot, every result recorded/);
  });

  it('a depot IN while a stop is still pending is no return (a run back for goods)', () => {
    const now = at('14:30');
    const pending = load({ stops: [stop(1, 480, { visit: doneVisit('08:00', '08:10') }), stop(2, 540, { visit: doneVisit('09:00', '09:10') }), stop(3, 600)] });
    const c = raised(evaluate(facts([pending], { gps: gpsDay(now, { ins: ['09:40'] }) }), now, only('LOAD_NOT_CLOSED')), 'LOAD_NOT_CLOSED')!;
    expect(c.text).toMatch(/no Back at depot, 1 of 3 stops without a result/);
  });
});

describe('a suppressed truck-day (or none with GPS) is read as with the link off', () => {
  it('no GpsTruckDayFact and phone-only visits: every rule answers as below ALERTS', () => {
    const now = at('10:00');
    const l = load({ stops: [stop(1, 480, { visit: doneVisit('08:00', '08:20') }), stop(2, 540), stop(3, 600)] });
    const withSettings = evaluate(facts([l], { gps: null }), now, ALL);
    const below = evaluate(facts([l], { alerts: false }), now, ALL);
    expect(withSettings).toEqual(below);
  });
});

describe('replay with the GPS alerts (GPS events and depot moves as they were received)', () => {
  const ev = (kind: string, source: string, hhmm: string, received: string, payload: Record<string, unknown> | null = null): ExportEvent => ({ kind, source, at: at(hhmm).toISOString(), receivedAt: at(received).toISOString(), distanceM: 30, accuracyM: null, payload });
  function exportOf(mode: string | null, suppressedAt: string | null = null): AlertDayExport {
    return {
      v: 1,
      kind: 'routeiq-alerts-day',
      date: D,
      tz: TZ,
      exportedAt: at('23:00').toISOString(),
      config: ON,
      loads: [
        {
          id: 'load-1',
          depotId: 'D1',
          truckId: 'TR1',
          truckCode: 'T-100',
          loadNo: 1,
          departMin: 450,
          returnMin: 720,
          windowRule: 'START',
          breakMin: null,
          finalStatus: 'DISPATCHED',
          stopCount: 2,
          history: [{ status: 'DISPATCHED', at: at('07:30').toISOString() }],
          backEvents: [],
          departEvents: [],
          plannedAt: null,
          stops: [
            {
              ...stop(1, 480),
              visit: {
                plannedServiceMin: 20,
                windowStartMin: null,
                windowEndMin: null,
                casesPlanned: 10,
                // The trail pulled at 09:05 and 10:05: GPS saw the truck at stop 1 from 08:00 to 09:30.
                events: [ev('ARRIVED', 'AYUN', '08:00', '09:05', { observed: true }), ev('DEPARTED', 'AYUN', '09:30', '10:05', { observed: true })],
                photos: [],
              },
            },
            { ...stop(2, 600), visit: null },
          ],
        },
      ],
      truckDays: [{ truckId: 'TR1', firstSeenAt: at('07:35').toISOString(), lastSeenAt: at('07:35').toISOString() }],
      ...(mode ? { gps: { mode, config: { atStopRadiusM: 250, atDepotRadiusM: 450, avgSpeedKmh: 40, distanceMultiplier: 1.3 }, truckDays: [{ truckId: 'TR1', suppressedAt, moves: [] }] } } : {}),
    };
  }
  const r1 = (r: ReturnType<typeof replayDay>) => r.rules.find((x) => x.rule === 'UNLOAD_OVER')!;

  it('a day saved in ALERTS replays with the GPS times by default: the stop GPS timed at 1 h 30 min is one history row naming GPS', () => {
    const r = replayDay(exportOf('ALERTS'), { fromMin: 420, toMin: 720, stepMin: 5 });
    expect(r.gps).toBe(true);
    expect(r1(r)).toMatchObject({ raised: 0, history: 1, first: '10:05' });
    expect(r1(r).samples[0]).toMatch(/unloading took 1 h 30 min \(GPS arrival and departure\), planned 20 min/);
  });

  it('a day saved in TIMES replays without them by default, and with --gps as ALERTS would have; no GPS in the file: refused', () => {
    expect(r1(replayDay(exportOf('TIMES'), { fromMin: 420, toMin: 720, stepMin: 5 }))).toMatchObject({ raised: 0, history: 0 });
    expect(r1(replayDay(exportOf('TIMES'), { fromMin: 420, toMin: 720, stepMin: 5, gps: true }))).toMatchObject({ history: 1 });
    expect(() => replayDay(exportOf(null), { gps: true })).toThrow(/no GPS/);
  });

  it('a truck-day suppressed during the day keeps no GPS from then on', () => {
    expect(r1(replayDay(exportOf('ALERTS', at('09:50').toISOString()), { fromMin: 420, toMin: 720, stepMin: 5 }))).toMatchObject({ history: 0 });
  });
});

describe('review of 18 Oct 2026 (the GPS alerts branch)', () => {
  /** Sweeps in a row through the rules and the store (in memory), as the live sweep: the rows, and how many times a closed row was reopened (alerted and e-mailed again). */
  function sweeps(steps: { now: Date; loads: FactLoad[]; gps: GpsTruckDayFact | null }[], thresholds: typeof ALL) {
    const rows: MemAlert[] = [];
    let reopened = 0;
    for (const st of steps) {
      const open = new Map<string, OpenRowInfo>();
      for (const r of rows) if (!r.resolvedAt) open.set(openKey(r.rule, r.subjectKey), { kind: r.kind as AlertKind, tier: r.tier, depotId: r.depotId, deliveryDate: r.deliveryDate });
      const ev = evaluate({ ...facts(st.loads, { gps: st.gps }), open }, st.now, thresholds);
      const plan = planApply(rows, ev, { now: st.now, alertsEnabledAt: at('05:00'), windowFrom: addDaysIso(D, -1), today: D, todayStart: zonedDayStart(D, TZ), rulesOn: ALERT_RULES.filter((r) => thresholds[r] !== null) });
      reopened += plan.counts.reopened;
      applyPlanInMemory(rows, plan, st.now);
    }
    return { rows, reopened };
  }

  describe('finding 1: R3 reads the live ETA only while the GPS history has caught up with the fix', () => {
    // Depart 07:30, stops planned 08:00, 09:00, 10:00. At 09:05 the fresh fix shows the truck at stop 2: stop 1
    // was served on time, no GPS time for it yet, the driver taps nothing (the page was opened).
    const now = at('09:05');

    it('the pure check: the history at most LIVE_ETA_TRAIL_LAG_MIN before the fix', () => {
      expect(LIVE_ETA_TRAIL_LAG_MIN).toBe(10);
      expect(historyCoversFix(gpsDay(now, { fix: '09:04', where: P2, trailTo: '08:54' }))).toBe(true);
      expect(historyCoversFix(gpsDay(now, { fix: '09:04', where: P2, trailTo: '08:53' }))).toBe(false);
      expect(historyCoversFix(gpsDay(now, { fix: '09:04', where: P2 }))).toBe(false);
      expect(historyCoversFix(gpsDay(now, { trailTo: '09:00' }))).toBe(false);
    });

    it('the history older than the fix: no live ETA (stop 1 would look next: "running about 1 h 35 min late (GPS)"), and the clock never pushes stop 1 - nothing raised, an open row waits', () => {
      const g = gpsDay(now, { fix: '09:04', where: P2, trailTo: '08:00' });
      const ev = evaluate(facts([load()], { gps: g }), now, only('ETA_LATE'));
      expect(raised(ev, 'ETA_LATE')).toBeUndefined();
      expect(ended(ev, 'ETA_LATE', loadKey())?.text).toBe("T-100 L1: the GPS history reaches only to 08:00, behind the truck's GPS position at 09:04: waiting for it before the next stop is judged (GPS).");
      expect(held(evaluate(facts([load()], { gps: g, open: [['ETA_LATE', loadKey()]] }), now, only('ETA_LATE')), 'ETA_LATE', loadKey())).toBe(true);
      // No history processed yet at all: the same.
      const none = evaluate(facts([load()], { gps: gpsDay(now, { fix: '09:04', where: P2 }) }), now, only('ETA_LATE'));
      expect(raised(none, 'ETA_LATE')).toBeUndefined();
      expect(ended(none, 'ETA_LATE', loadKey())?.text).toMatch(/the GPS history has not been read yet, behind the truck's GPS position at 09:04/);
    });

    it('the history caught up but stop 1 has no GPS time (a stay left to the office): the fix at stop 2\'s pin puts stop 1 behind the truck - on time, an open row closes', () => {
      const g = gpsDay(now, { fix: '09:04', where: P2, trailTo: '09:00' });
      const ev = evaluate(facts([load()], { gps: g, open: [['ETA_LATE', loadKey()]] }), now, only('ETA_LATE'));
      expect(raised(ev, 'ETA_LATE')).toBeUndefined();
      expect(ended(ev, 'ETA_LATE', loadKey())?.text).toMatch(/^T-100 L1: back on time \(about \d+ min late at the next stop, stop 2 Shop Example 2 \(C200\), by the GPS position at 09:04\) \(GPS\)\.$/);
    });

    it('while the history lags, a delay the recorded GPS times already show still counts (the projection, not the clock)', () => {
      // Stop 1 left at 09:30 by GPS (planned 08:20): stop 2 expected about 10:10, planned 09:00.
      const late = load({ stops: [stop(1, 480, { visit: gpsVisit('08:00', '09:30') }), stop(2, 540), stop(3, 600)] });
      const at0950 = at('09:50');
      const c = raised(evaluate(facts([late], { gps: gpsDay(at0950, { fix: '09:49', where: FAR, speedKmh: 40, trailTo: '09:31' }) }), at0950, only('ETA_LATE')), 'ETA_LATE', loadKey())!;
      expect(c).toMatchObject({ value: 70, tier: 2 });
      expect(c.text).toMatch(/next stop 2 Shop Example 2 \(C200\) expected about 10:10 \(planned 09:00\)/);
    });

    it('as sweeps: a truck exactly on its plan, untapped, the history pulled at 08:30 and 10:00 - never an alert (before: "about 1 h 10 min late (GPS)" at 09:45)', () => {
      // On the plan: at stop 1 08:00-08:20, stop 2 09:00-09:20, stop 3 10:00-10:20, driving in between.
      const between = (a: { lat: number; lng: number }, b: { lat: number; lng: number }, f: number) => ({ lat: a.lat + (b.lat - a.lat) * f, lng: a.lng + (b.lng - a.lng) * f });
      // What each pull gave: stop 1's stay with the 08:30 pull, stop 2's with the 10:00 pull.
      const known = (pulled: string) =>
        load({ stops: [stop(1, 480, { visit: gpsVisit('08:00', '08:20') }), stop(2, 540, pulled >= '10:00' ? { visit: gpsVisit('09:00', '09:20') } : {}), stop(3, 600)] });
      const step = (hhmm: string, where: { lat: number; lng: number }, pulled: string) => ({ now: at(hhmm), loads: [known(pulled)], gps: gpsDay(at(hhmm), { fix: hhmm, where, speedKmh: 30, trailTo: pulled }) });
      const { rows } = sweeps(
        [
          step('08:35', between(P1, P2, 0.375), '08:30'),
          step('09:10', P2, '08:30'),
          // Stop 2 served, its GPS times not pulled yet, the truck on its way to stop 3.
          step('09:45', between(P2, P3, 0.625), '08:30'),
          step('10:05', P3, '10:00'),
        ],
        only('ETA_LATE'),
      );
      expect(rows).toEqual([]);
    });
  });

  describe('finding 2: a row raised from GPS is never closed because the fix aged out, then raised (and e-mailed) again', () => {
    it('R1 from a GPS arrival: fresh fix at the stop, then no fix for 35 min, then a fresh fix: one row, never reopened', () => {
      const l = load({ stops: [stop(1, 480, { visit: gpsVisit('08:00') }), stop(2, 540), stop(3, 600)] });
      const step = (hhmm: string, fix: string) => ({ now: at(hhmm), loads: [l], gps: gpsDay(at(hhmm), { fix, where: P1, trailTo: '08:30' }) });
      const { rows, reopened } = sweeps([step('09:00', '08:58'), step('09:40', '09:05'), step('09:50', '09:49')], only('UNLOAD_OVER'));
      expect(reopened).toBe(0);
      expect(rows.filter((r) => r.rule === 'UNLOAD_OVER')).toEqual([expect.objectContaining({ resolvedAt: null, occurrences: 1 })]);
    });

    it('R2 from a GPS Back at depot: at the depot, no fix for 36 min, at the depot again: one row, never reopened', () => {
      const done = (arr: string, res: string) => visit({ arrivedAt: at(arr), arrivalSource: 'PHONE_MANUAL', departedAt: at(res), departedAtOutcome: true, departureSource: 'PHONE_MANUAL', outcome: 'DELIVERED', outcomeAt: at(res), outcomeSource: 'PHONE_MANUAL' });
      const loads = [
        load({ status: 'COMPLETED', statusChangedAt: at('12:30'), returnMin: 660, stops: [stop(1, 480, { visit: done('08:00', '08:10') }), stop(2, 540, { visit: done('09:00', '09:10') }), stop(3, 600, { visit: done('10:00', '10:10') })] }),
        load({ id: 'load-2', loadNo: 2, status: 'LOADING', statusChangedAt: at('10:50'), departMin: 720, returnMin: 900, stops: [stop(1, 750), stop(2, 780)] }),
      ];
      const step = (hhmm: string, fix: string) => ({ now: at(hhmm), loads, gps: gpsDay(at(hhmm), { fix, where: DEPOT, ins: ['10:45'], trailTo: '11:00' }) });
      const { rows, reopened } = sweeps([step('11:45', '11:44'), step('12:20', '11:44'), step('12:30', '12:29')], only('LOADING_OVER'));
      expect(reopened).toBe(0);
      expect(rows.filter((r) => r.rule === 'LOADING_OVER')).toEqual([expect.objectContaining({ resolvedAt: null, occurrences: 1 })]);
    });
  });

  describe('finding 3: a GPS arrival ended only by the driver\'s result (tapped in a batch) is measured once the GPS history covers that result', () => {
    // GPS arrival 10:00 at stop 1 (no tap); the driver taps the results of stops 1, 2 and 3 together at 11:30.
    const result = (hhmm: string) => ({ outcome: 'DELIVERED', outcomeAt: at(hhmm), outcomeSource: 'PHONE_MANUAL' });
    const batched = (first: FactVisit) => load({ stops: [stop(1, 480, { visit: first }), stop(2, 540, { visit: visit(result('11:30')) }), stop(3, 600, { visit: visit(result('11:30')) })] });
    const standIn = visit({ arrivedAt: at('10:00'), arrivalSource: 'AYUN', arrivalObserved: true, departedAt: at('11:30'), departedAtOutcome: true, departureSource: 'PHONE_MANUAL', ...result('11:30') });

    it('history to 11:00: no "unloading took 1 h 30 min (GPS arrival)" history row (it could never be corrected); an open row waits', () => {
      const now = at('11:35');
      const g = gpsDay(now, { trailTo: '11:00' });
      const ev = evaluate(facts([batched(standIn)], { gps: g }), now, only('UNLOAD_OVER'));
      expect(raised(ev, 'UNLOAD_OVER')).toBeUndefined();
      expect(ended(ev, 'UNLOAD_OVER', stopKey(1))?.text).toBe('T-100 L1 stop 1 Shop Example 1 (C100): GPS arrival 10:00, result 11:30: waiting for the GPS history to show when the truck left (GPS).');
      expect(held(evaluate(facts([batched(standIn)], { gps: g, open: [['UNLOAD_OVER', stopKey(1)]] }), now, only('UNLOAD_OVER')), 'UNLOAD_OVER', stopKey(1))).toBe(true);
    });

    it('the next pull brings the GPS departure 10:20: 20 min, nothing to say; covered and still no GPS departure: measured to the result, as before', () => {
      const now = at('12:10');
      const withDeparture = visit({ ...gpsVisit('10:00', '10:20'), ...result('11:30') });
      expect(raised(evaluate(facts([batched(withDeparture)], { gps: gpsDay(now, { trailTo: '12:05' }) }), now, only('UNLOAD_OVER')), 'UNLOAD_OVER')).toBeUndefined();
      const covered = raised(evaluate(facts([batched(standIn)], { gps: gpsDay(now, { trailTo: '12:05' }) }), now, only('UNLOAD_OVER')), 'UNLOAD_OVER', stopKey(1))!;
      expect(covered).toMatchObject({ history: true, value: 70 });
      expect(covered.text).toMatch(/unloading took 1 h 30 min \(GPS arrival\), planned 20 min \(1 h 10 min over\)\.$/);
    });

    it('the day over with the history still short of the result (the link down): not measured, the wait ends', () => {
      const next = new Date(at('08:00').getTime() + 24 * 3_600_000);
      const ev = evaluate({ ...facts([batched(standIn)], { gps: gpsDay(next, { trailTo: '11:00' }), open: [['UNLOAD_OVER', stopKey(1)]] }), today: addDaysIso(D, 1) }, next, only('UNLOAD_OVER'));
      expect(ev.ended.find((e) => e.rule === 'UNLOAD_OVER' && e.subjectKey === stopKey(1))).toMatchObject({
        reason: 'ENDED',
        text: 'T-100 L1 stop 1 Shop Example 1 (C100): GPS arrival 10:00, result 11:30: the GPS history never showed when the truck left, so the unloading is not measured (GPS).',
      });
    });

    it('a tapped arrival with a batched result is as before (the phone path; GPS changes nothing)', () => {
      const now = at('11:35');
      const tapped = visit({ ...standIn, arrivalSource: 'PHONE_MANUAL' });
      expect(raised(evaluate(facts([batched(tapped)], { gps: gpsDay(now, { trailTo: '11:00' }) }), now, only('UNLOAD_OVER')), 'UNLOAD_OVER', stopKey(1))).toMatchObject({ history: true });
    });
  });

  describe('finding 4: a depot OUT is the truck leaving only once known (a fuel run comes back)', () => {
    const locked = () => load({ status: 'LOCKED', statusChangedAt: at('05:00'), stops: [], stopCount: 3 });

    it('outState: LEFT once a stop is reached or the trail followed it GPS_OUT_CONFIRM_MIN out; BACK with a fresh fix at the depot after it; else PENDING', () => {
      const now = at('09:00');
      const out = { at: at('08:10'), observed: true };
      expect(GPS_OUT_CONFIRM_MIN).toBe(30);
      expect(outState(gpsDay(now, { trailTo: '08:20' }), out, { atDepot: null })).toBe('PENDING');
      expect(outState(gpsDay(now, { trailTo: '08:40' }), out, { atDepot: null })).toBe('LEFT');
      expect(outState(gpsDay(now, { trailTo: '08:20' }), out, { atDepot: null, signAt: at('08:30') })).toBe('LEFT');
      expect(outState(gpsDay(now, { fix: '08:58', where: DEPOT, trailTo: '08:20' }), out, { atDepot: 'AT' })).toBe('BACK');
    });

    it('R4: Locked, late; out for fuel 08:10-08:25, the IN only in the next pull: the row stays open the whole time, never closed as "left" and reopened', () => {
      const step = (hhmm: string, g: Parameters<typeof gpsDay>[1]) => ({ now: at(hhmm), loads: [locked()], gps: gpsDay(at(hhmm), g) });
      const { rows, reopened } = sweeps(
        [
          step('08:05', { fix: '08:04', where: DEPOT }),
          // The 08:20 pull shows the OUT only; the fix shows the truck away (at the fuel station).
          step('08:22', { fix: '08:21', where: P1, outs: ['08:10'], trailTo: '08:20' }),
          // Back at the depot by the fresh fix; the IN not pulled yet.
          step('08:40', { fix: '08:39', where: DEPOT, outs: ['08:10'], trailTo: '08:20' }),
          // The 08:50 pull brings the IN.
          step('08:55', { fix: '08:54', where: DEPOT, outs: ['08:10'], ins: ['08:25'], trailTo: '08:50' }),
        ],
        only('DEPART_LATE'),
      );
      expect(reopened).toBe(0);
      const r4 = rows.filter((r) => r.rule === 'DEPART_LATE');
      expect(r4).toEqual([expect.objectContaining({ resolvedAt: null, occurrences: 1 })]);
      expect(r4[0]!.text).toMatch(/not dispatched: planned departure 07:30, now 08:55 .* GPS: the truck is still at the depot at 08:54\. Dispatch it if it has left\.$/);
    });

    it('R4: the OUT waits while not known, closes with the time it left once the trail followed it out', () => {
      const pending = evaluate(facts([locked()], { gps: gpsDay(at('08:22'), { fix: '08:21', where: P1, outs: ['08:10'], trailTo: '08:20' }), open: [['DEPART_LATE', loadKey()]] }), at('08:22'), only('DEPART_LATE'));
      expect(held(pending, 'DEPART_LATE', loadKey())).toBe(true);
      expect(ended(pending, 'DEPART_LATE', loadKey())).toBeUndefined();
      const left = evaluate(facts([locked()], { gps: gpsDay(at('08:50'), { fix: '08:49', where: P2, outs: ['08:10'], trailTo: '08:45' }), open: [['DEPART_LATE', loadKey()]] }), at('08:50'), only('DEPART_LATE'));
      expect(ended(left, 'DEPART_LATE', loadKey())?.text).toMatch(/^T-100 L1 left the depot at 08:10 \(GPS\), 40 min after 07:30; Dispatch is not pressed yet/);
    });

    it('R2: back by GPS 10:40, out for fuel 11:35 (IN not pulled yet): no final "left 11:35 by the GPS depot exit"; back at the depot by the fresh fix: still at the depot, never reopened', () => {
      const done = (arr: string, res: string) => visit({ arrivedAt: at(arr), arrivalSource: 'PHONE_MANUAL', departedAt: at(res), departedAtOutcome: true, departureSource: 'PHONE_MANUAL', outcome: 'DELIVERED', outcomeAt: at(res), outcomeSource: 'PHONE_MANUAL' });
      const loads = [
        load({ status: 'COMPLETED', statusChangedAt: at('12:30'), returnMin: 660, stops: [stop(1, 480, { visit: done('08:00', '08:10') }), stop(2, 540, { visit: done('09:00', '09:10') }), stop(3, 600, { visit: done('10:00', '10:10') })] }),
        load({ id: 'load-2', loadNo: 2, status: 'LOADING', statusChangedAt: at('10:50'), departMin: 720, returnMin: 900, stops: [stop(1, 750), stop(2, 780)] }),
      ];
      const step = (hhmm: string, g: Parameters<typeof gpsDay>[1]) => ({ now: at(hhmm), loads, gps: gpsDay(at(hhmm), { ins: ['10:40'], ...g }) });
      const { rows, reopened } = sweeps(
        [
          step('11:30', { fix: '11:29', where: DEPOT, trailTo: '11:00' }),
          step('11:50', { fix: '11:49', where: P2, outs: ['11:35'], trailTo: '11:45' }),
          step('12:05', { fix: '12:04', where: DEPOT, outs: ['11:35'], trailTo: '11:45' }),
        ],
        only('LOADING_OVER'),
      );
      expect(reopened).toBe(0);
      const r2 = rows.filter((r) => r.rule === 'LOADING_OVER');
      expect(r2).toEqual([expect.objectContaining({ resolvedAt: null, occurrences: 1 })]);
      expect(r2[0]!.text).toMatch(/at the depot for 1 h 25 min since L1 back at the depot at 10:40 \(GPS\), not left with L2 yet .* GPS: the truck is at the depot at 12:04\.$/);
      // An OUT the history never confirms (the pulls stopped) is waited for at most TURNAROUND_MAX_MIN after the return.
      const stuck = evaluate(facts(loads, { gps: gpsDay(at('14:45'), { ins: ['10:40'], outs: ['11:35'], trailTo: '11:45' }), open: [['LOADING_OVER', loadKey(2)]] }), at('14:45'), only('LOADING_OVER'));
      expect(stuck.ended.find((e) => e.rule === 'LOADING_OVER' && e.subjectKey === loadKey(2))).toMatchObject({ reason: 'NOT_FOLLOWED' });
    });
  });

  describe("finding 5: only the load's own depot's moves count", () => {
    it('R4: left D1 at 07:40, then drove through depot D2\'s zone (in 08:10, out 08:20): it left at 07:40, not 08:20', () => {
      const now = at('09:00');
      const g = gpsDay(now, { outs: [['07:40', true, 'D1'], ['08:20', true, 'D2']], ins: [['08:10', true, 'D2']], trailTo: '08:55' });
      const ev = evaluate(facts([load({ status: 'LOCKED', statusChangedAt: at('05:00'), stops: [], stopCount: 3 })], { gps: g, open: [['DEPART_LATE', loadKey()]] }), now, only('DEPART_LATE'));
      expect(raised(ev, 'DEPART_LATE')).toBeUndefined();
      expect(ended(ev, 'DEPART_LATE', loadKey())?.text).toMatch(/^T-100 L1 left the depot at 07:40 \(GPS\), 10 min after 07:30;/);
    });

    it("back: the first IN of the load's own depot after its last stop (a drive through D2's zone at 10:20 is not back at D1)", () => {
      const now = at('14:30');
      const done = load({ stops: [stop(1, 480, { visit: doneVisit('08:00', '08:10') }), stop(2, 540, { visit: doneVisit('09:00', '09:10') }), stop(3, 600, { visit: doneVisit('10:00', '10:10') })] });
      const g = gpsDay(now, { ins: [['10:20', true, 'D2'], ['10:40', true, 'D1']] });
      expect(ended(evaluate(facts([done], { gps: g, open: [['LOAD_NOT_CLOSED', loadKey()]] }), now, only('LOAD_NOT_CLOSED')), 'LOAD_NOT_CLOSED', loadKey())?.text).toBe(
        'T-100 L1: back at the depot at 10:40 (GPS) with every result recorded: closing.',
      );
      expect(outSince(g, at('05:00'), now, 'D1')).toBeNull();
      expect(gpsBackOf(g, { lastSignAt: at('10:10'), dispatchAt: at('07:30'), allStopsDone: true, depotId: 'D2' }, now)?.at).toEqual(at('10:20'));
    });
  });

  describe('finding 6: a trail move keeps the exactness the stop detector stored with it', () => {
    it('moveObserved: the stored flag wins (the trail points may be deleted); only a move without one is read against the points', () => {
      expect(moveObserved({ kind: 'DEPOT_OUT', at: at('08:00'), origin: 'TRAIL', observed: true }, [])).toBe(true);
      expect(moveObserved({ kind: 'DEPOT_OUT', at: at('08:00'), origin: 'TRAIL', observed: false }, [at('07:58')])).toBe(false);
      expect(moveObserved({ kind: 'DEPOT_OUT', at: at('08:00'), origin: 'TRAIL', observed: null }, [at('07:58')])).toBe(true);
      expect(moveObserved({ kind: 'DEPOT_OUT', at: at('08:00'), origin: 'TRAIL', observed: null }, [])).toBe(false);
    });
  });

  describe('the replay (finding 3 and 4 there): the history processed by t is the latest GPS the server wrote by then', () => {
    const ev = (kind: string, source: string, hhmm: string, received: string, payload: Record<string, unknown> | null = null): ExportEvent => ({ kind, source, at: at(hhmm).toISOString(), receivedAt: at(received).toISOString(), distanceM: 30, accuracyM: null, payload });
    it('a GPS arrival with a result tapped at 09:40 waits for the 10:05 pull, whose GPS departure (08:30) measures 30 min: no history row', () => {
      const exp: AlertDayExport = {
        v: 1,
        kind: 'routeiq-alerts-day',
        date: D,
        tz: TZ,
        exportedAt: at('23:00').toISOString(),
        config: ON,
        loads: [
          {
            id: 'load-1',
            depotId: 'D1',
            truckId: 'TR1',
            truckCode: 'T-100',
            loadNo: 1,
            departMin: 450,
            returnMin: 720,
            windowRule: 'START',
            breakMin: null,
            finalStatus: 'DISPATCHED',
            stopCount: 1,
            history: [{ status: 'DISPATCHED', at: at('07:30').toISOString() }],
            backEvents: [],
            departEvents: [],
            plannedAt: null,
            stops: [
              {
                ...stop(1, 480),
                visit: {
                  plannedServiceMin: 20,
                  windowStartMin: null,
                  windowEndMin: null,
                  casesPlanned: 10,
                  events: [
                    ev('ARRIVED', 'AYUN', '08:00', '09:05', { observed: true }),
                    ev('OUTCOME', 'PHONE_MANUAL', '09:40', '09:40', { outcome: 'DELIVERED' }),
                    ev('DEPARTED', 'AYUN', '08:30', '10:05', { observed: true }),
                  ],
                  photos: [],
                },
              },
            ],
          },
        ],
        truckDays: [{ truckId: 'TR1', firstSeenAt: at('07:35').toISOString(), lastSeenAt: at('07:35').toISOString() }],
        gps: { mode: 'ALERTS', config: { atStopRadiusM: 250, atDepotRadiusM: 450, avgSpeedKmh: 40, distanceMultiplier: 1.3 }, truckDays: [{ truckId: 'TR1', suppressedAt: null, moves: [] }] },
      };
      const r = replayDay(exp, { fromMin: 420, toMin: 720, stepMin: 5 });
      expect(r.rules.find((x) => x.rule === 'UNLOAD_OVER')).toMatchObject({ raised: 0, history: 0 });
    });
  });
});
