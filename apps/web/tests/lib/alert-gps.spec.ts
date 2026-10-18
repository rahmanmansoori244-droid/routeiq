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
 *    gpsAlertConfigOf) and the replay with the GPS events and depot moves.
 * Invented data only: truck T-100, depot D1, pins around 10.0001 / 20.0002; Asia/Muscat time (UTC+4).
 */
import type { StopVisit } from '@prisma/client';
import { describe, expect, it } from 'vitest';
import { subjectKeyOf, thresholdsOf, type AlertConfig, type AlertRule } from '@/lib/alerts/catalog';
import { alertVisitRow } from '@/lib/alerts/facts';
import {
  gpsAlertConfigOf,
  gpsBackOf,
  gpsLiveOf,
  gpsTruckDayFactOf,
  moveObserved,
  openStayEnd,
  outSince,
  GPS_WAIT_MIN,
  type AlertGpsSettings,
} from '@/lib/alerts/gps';
import { replayDay, type AlertDayExport, type ExportEvent } from '@/lib/alerts/replay';
import { evaluate, openKey, type AlertFacts, type FactLoad, type FactStop, type FactTruckDay, type FactVisit, type OpenRowInfo } from '@/lib/alerts/rules';
import type { Candidate, Evaluation } from '@/lib/alerts/types';
import { withoutGpsTimes } from '@/lib/delivery/visit';
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

/** The truck-day's GPS: a live fix (`fix`: when, `where`: the position) and the trail-confirmed depot moves. */
function gpsDay(now: Date, o: { fix?: string | null; where?: { lat: number; lng: number } | null; speedKmh?: number; ins?: (string | [string, boolean])[]; outs?: (string | [string, boolean])[]; trailTo?: string } = {}): GpsTruckDayFact {
  const move = (m: string | [string, boolean]) => (typeof m === 'string' ? { kind: 'x', at: at(m), observed: true } : { kind: 'x', at: at(m[0]), observed: m[1] });
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
    const withGps = (v: FactVisit) => withoutGpsTimes({ ...v, departureSource: v.departureSource ?? null });
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

  it('between two reads it waits (an open row stays, nothing new); with no fix at all a GPS arrival is not followed', () => {
    const now = at('09:00');
    const wait = gpsDay(now, { fix: '08:45', where: P1 });
    expect(raised(r1(gpsVisit('08:00'), now, wait), 'UNLOAD_OVER')).toBeUndefined();
    expect(held(r1(gpsVisit('08:00'), now, wait, true), 'UNLOAD_OVER', stopKey(1))).toBe(true);
    const none = gpsDay(now, { trailTo: '08:30' });
    expect(raised(r1(gpsVisit('08:00'), now, none), 'UNLOAD_OVER')).toBeUndefined();
    expect(r1(gpsVisit('08:00'), now, none, true).ended.find((e) => e.rule === 'UNLOAD_OVER' && e.subjectKey === stopKey(1))).toMatchObject({ reason: 'NOT_FOLLOWED' });
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
    const ev = evaluate(facts(day({}), { gps: gpsDay(now, { ins: ['10:40'], outs: ['07:35', '11:40'] }) }), now, only('LOADING_OVER'));
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
    const noFix = evaluate(facts(day(loading), { gps: gpsDay(now, { ins: ['10:40'] }), open: [['LOADING_OVER', loadKey(2)]] }), now, only('LOADING_OVER'));
    expect(noFix.ended.find((e) => e.subjectKey === loadKey(2))).toMatchObject({ reason: 'NOT_FOLLOWED' });
  });
});

describe('R3 running late, from the live position', () => {
  const stops = () => [stop(1, 480, { visit: doneVisit('08:00', '08:20') }), stop(2, 540), stop(3, 600)];

  it('with a fresh position: the live map\'s ETA of the next stop, also while the driver is silent; the text says GPS', () => {
    const now = at('10:00');
    // Nothing from the phone since the Dispatch press: R5 is raised (a warning: GPS follows the truck), and R3 is not held for it.
    const ev = evaluate(facts([load({ stops: stops() })], { gps: gpsDay(now, { fix: '09:59', where: P1, speedKmh: 30 }) }), now, { ...only('ETA_LATE'), DRIVER_SILENT: 120 });
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
    const ev = evaluate(facts([load({ stops: late })], { gps: gpsDay(now, { fix: '09:59', where: near, speedKmh: 30 }), open: [['ETA_LATE', loadKey()]] }), now, only('ETA_LATE'));
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
    const now = at('08:30');
    const late = evaluate(facts([locked()], { gps: gpsDay(now, { outs: ['08:20'] }) }), now, only('DEPART_LATE'));
    const c = raised(late, 'DEPART_LATE', loadKey())!;
    expect(c).toMatchObject({ history: true, value: 50, tier: 1, occurredAt: at('08:20') });
    expect(c.text).toBe('T-100 L1 left the depot at 08:20 (GPS), 50 min after 07:30; Dispatch is not pressed yet (load is Locked): press it so the driver page and the alerts follow the truck.');
    const onTime = evaluate(facts([locked()], { gps: gpsDay(now, { outs: ['07:40'] }), open: [['DEPART_LATE', loadKey()]] }), now, only('DEPART_LATE'));
    expect(ended(onTime, 'DEPART_LATE', loadKey())?.text).toMatch(/^T-100 L1 left the depot at 07:40 \(GPS\), 10 min after 07:30; Dispatch is not pressed yet/);
    expect(ended(onTime, 'DEPART_LATE', loadKey())?.reason).toBe('ENDED');
  });

  it('an unobserved OUT says it left by then, never how late; a fuel run that came back is no departure', () => {
    const now = at('08:30');
    const ev = evaluate(facts([locked()], { gps: gpsDay(now, { outs: [['08:20', false]] }) }), now, only('DEPART_LATE'));
    expect(raised(ev, 'DEPART_LATE')).toBeUndefined();
    expect(ended(ev, 'DEPART_LATE', loadKey())?.text).toMatch(/left the depot by 08:20 \(GPS\) \(planned 07:30\)/);
    const fuel = evaluate(facts([locked()], { gps: gpsDay(now, { fix: '08:29', where: DEPOT, outs: ['06:00'], ins: ['06:30'] }) }), now, only('DEPART_LATE'));
    expect(raised(fuel, 'DEPART_LATE')?.text).toMatch(/not dispatched: planned departure 07:30, now 08:30 \(1 h late\), load is Locked\. Driver page last open 07:35\. GPS: the truck is still at the depot at 08:29\. Dispatch it if it has left\.$/);
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
