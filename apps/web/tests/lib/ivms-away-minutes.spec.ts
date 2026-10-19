/**
 * The visit rebuild and the unloading times at big customers (owner request 19 Oct 2026; the GPS study of
 * 18-19 Oct 2026, 76 driver-tapped visits): when the driver or the office gave the arrival, the GPS departure
 * comes from the GPS stay that holds the driver's result (the truck came back to the pin), keeping the result
 * + 15 min cap; a leave-and-return (the GPS stays' minutes away) is recorded on the visit (awayMinutes) and
 * never counted as unloading - the plan screen, the truck day page, the delivery export, the measured time,
 * the KPI and UNLOAD_OVER all use the time on site; the migration's CHECKs; the Details dialog's site radius.
 * Synthetic stops, invented pins (20.1, 55.1), truck T-100; Asia/Muscat time.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { awayMinutesOf, deriveVisit, withoutGpsTimes, type VisitContext, type VisitEvent } from '@/lib/delivery/visit';
import { actualMinutes, awayInside, awayText, onSite } from '@/lib/delivery/office-text';
import { eligibleForMeasured, measuredOnSite, measuredUnloading, type MeasuredVisit } from '@/lib/delivery/measured';
import { deliveryKpis, type KpiVisit } from '@/lib/delivery/kpis';
import { actualsRowOf } from '@/lib/delivery/actuals-workbook';
import { thresholdsOf, type AlertConfig } from '@/lib/alerts/catalog';
import { atStopRadiusOf, gpsTruckDayFactOf, liveAt, type AlertGpsSettings } from '@/lib/alerts/gps';
import { evaluate, type AlertFacts, type FactLoad, type FactStop, type FactVisit } from '@/lib/alerts/rules';
import { addDaysIso, parseHhmm, zonedDayStart } from '@/lib/dispatch/time';
import { buildTruckDay, otherGpsStays, type TruckDayInput } from '@/lib/ivms/truck-day';
import { customerPatchSchema } from '@/lib/schemas';
import { detailsFormOf, detailsPatch, EMPTY_DETAILS } from '@/app/t/[slug]/dispatch/customer-details';

const TZ = 'Asia/Muscat';
const D = '2026-10-20';
const DAY = zonedDayStart(D, TZ);
const L = (hhmm: string) => new Date(DAY.getTime() + parseHhmm(hhmm)! * 60_000);
const PIN = { lat: 20.1, lng: 55.1 };
const CTX: VisitContext = { dayStart: DAY, windowStartMin: null, breakMin: null, lines: [], pin: PIN, radiusM: 100 };

let n = 0;
function ev(kind: VisitEvent['kind'], source: VisitEvent['source'], at: string, payload: Record<string, unknown> = {}): VisitEvent {
  n++;
  return { id: `e${n}`, kind, source, at: L(at), receivedAt: L(at), lat: null, lng: null, accuracyM: null, distanceM: null, payload };
}
/** A GPS stay's arrival as the detector writes it (ivms-v2: the stay summary with the minutes away before it). */
const gpsIn = (at: string, awayMin: number | null = null) => ev('ARRIVED', 'AYUN', at, { observed: true, detector: 'ivms-v2', segmentStartAt: L(at).toISOString(), stay: { awayMin, merged: 0 } });
const gpsOut = (at: string, start: string) => ev('DEPARTED', 'AYUN', at, { observed: true, detector: 'ivms-v2', segmentStartAt: L(start).toISOString() });
const tap = (at: string) => ev('ARRIVED', 'PHONE_MANUAL', at, { mode: 'MANUAL' });
const result = (at: string, source: VisitEvent['source'] = 'PHONE_MANUAL') => ev('OUTCOME', source, at, { outcome: 'DELIVERED' });
const office = (kind: 'ARRIVED' | 'DEPARTED', at: string) => ev(kind, 'DISPATCHER', at, { mode: 'OFFICE' });

describe('the visit rebuild: the GPS departure of the stay that holds the result (owner request 19 Oct 2026)', () => {
  it('a long trip away and back: tapped 07:56, GPS stays 07:47-08:27 and 09:20-14:23, result 14:17: left 14:23, 53 min away, 5 h 34 min on site', () => {
    const v = deriveVisit([tap('07:56'), gpsIn('07:47'), gpsOut('08:27', '07:47'), gpsIn('09:20', 53), gpsOut('14:23', '09:20'), result('14:17')], CTX);
    expect(v).toMatchObject({ arrivalSource: 'PHONE_MANUAL', departureSource: 'AYUN', departedAtOutcome: false, awayMinutes: 53 });
    expect(v.departedAt).toEqual(L('14:23'));
    expect(actualMinutes(v)).toEqual({ min: 387 - 53, label: 'arrival to departure, less 53 min away', auto: false });
  });

  it('before the change the first stay\'s departure was shown (08:27, 351 min before the result)', () => {
    // Without the second stay's events the rebuild falls back to the stay of the arrival, as it always did.
    const v = deriveVisit([tap('07:56'), gpsIn('07:47'), gpsOut('08:27', '07:47'), result('14:17')], CTX);
    expect(v.departedAt).toEqual(L('08:27'));
    expect(v.awayMinutes ?? null).toBeNull();
  });

  it('the truck left and the result was tapped far away hours later: the GPS departure stays', () => {
    const v = deriveVisit([tap('10:00'), gpsIn('09:58'), gpsOut('10:30', '09:58'), result('13:08')], CTX);
    expect(v).toMatchObject({ departureSource: 'AYUN', awayMinutes: null });
    expect(v.departedAt).toEqual(L('10:30'));
  });

  it('a site move the detector merged: one stay, the departure after the result; nothing away', () => {
    const v = deriveVisit([tap('17:18'), gpsIn('17:25'), gpsOut('18:41', '17:25'), result('18:39')], CTX);
    expect(v.departedAt).toEqual(L('18:41'));
    expect(v.awayMinutes ?? null).toBeNull();
  });

  it('the result + 15 min cap still applies: the holding stay left 50 min after the result, so the result ends the stop (time away still taken off)', () => {
    const v = deriveVisit([tap('07:59'), gpsIn('07:59'), gpsOut('08:11', '07:59'), gpsIn('09:47', 96), gpsOut('11:30', '09:47'), result('10:36')], CTX);
    expect(v).toMatchObject({ departureSource: 'PHONE_MANUAL', departedAtOutcome: true, awayMinutes: 96 });
    expect(actualMinutes(v).min).toBe(157 - 96);
  });

  it('an office Left: only the part of the absence before it is inside the visit', () => {
    const events = [tap('07:56'), gpsIn('07:47'), gpsOut('08:27', '07:47'), gpsIn('09:20', 53), gpsOut('14:23', '09:20'), result('14:17')];
    expect(deriveVisit([...events, office('DEPARTED', '08:20')], CTX)).toMatchObject({ departureSource: 'DISPATCHER', awayMinutes: null });
    // The office says 08:30, the GPS saw the truck gone from 08:27: 3 minutes of it were not on site.
    expect(deriveVisit([...events, office('DEPARTED', '08:30')], CTX)).toMatchObject({ departureSource: 'DISPATCHER', awayMinutes: 3 });
  });

  it('a stop still in progress after a return (no result yet, the truck back at the pin): at the stop again, the minutes away recorded', () => {
    const v = deriveVisit([tap('07:56'), gpsIn('07:47'), gpsOut('08:27', '07:47'), gpsIn('09:20', 53)], CTX);
    expect(v).toMatchObject({ state: 'ARRIVED', departedAt: null, awayMinutes: 53 });
    // Before the return (no later stay yet) the GPS departure of the arrival's stay shows, as before.
    expect(deriveVisit([tap('07:56'), gpsIn('07:47'), gpsOut('08:27', '07:47')], CTX)).toMatchObject({ state: 'PENDING', departedAt: L('08:27'), departureSource: 'AYUN' });
    // Back and left again, still no result: the stay of the arrival, as before (its absence is after the departure shown).
    expect(deriveVisit([tap('07:56'), gpsIn('07:47'), gpsOut('08:27', '07:47'), gpsIn('09:20', 53), gpsOut('09:40', '09:20')], CTX)).toMatchObject({ departedAt: L('08:27'), awayMinutes: null });
  });

  it('awayMinutesOf: each absence [return - away, return], clipped to the visit, each stay once', () => {
    const evs = [gpsIn('09:20', 53), gpsIn('09:20', 53), gpsIn('12:00', 30), gpsIn('07:00', null), gpsIn('08:00', 0)];
    expect(awayMinutesOf(evs, L('07:56').getTime(), L('14:23').getTime())).toBe(83);
    // 09:00-09:20 of the first absence and 11:30-11:50 of the second.
    expect(awayMinutesOf(evs, L('09:00').getTime(), L('11:50').getTime())).toBe(40);
    expect(awayMinutesOf(evs, L('12:30').getTime(), null)).toBeNull();
  });

  it('the link off view (withoutGpsTimes) has no minutes away; a visit without any is returned as it is', () => {
    const v = deriveVisit([tap('07:56'), gpsIn('07:47'), gpsOut('08:27', '07:47'), gpsIn('09:20', 53), gpsOut('14:23', '09:20'), result('14:17')], CTX);
    const own = withoutGpsTimes(v);
    expect(own).toMatchObject({ awayMinutes: null, departedAt: L('14:17'), departedAtOutcome: true });
    // The stand-in departure kept by GPS (the holding stay's departure was capped): only the minutes away go.
    const capped = deriveVisit([tap('07:59'), gpsIn('07:59'), gpsOut('08:11', '07:59'), gpsIn('09:47', 96), gpsOut('11:30', '09:47'), result('10:36')], CTX);
    expect(withoutGpsTimes(capped)).toMatchObject({ awayMinutes: null, departedAt: L('10:36'), departureSource: 'PHONE_MANUAL' });
    const plain = deriveVisit([tap('10:00'), result('10:20')], CTX);
    expect(withoutGpsTimes(plain)).toBe(plain);
    expect('awayMinutes' in plain).toBe(false);
  });
});

describe('on-site minutes everywhere an unloading is measured', () => {
  it('onSite / awayInside / awayText', () => {
    expect(onSite(120, null)).toBe(120);
    expect(onSite(120, 53)).toBe(67);
    expect(onSite(30, 53)).toBe(0);
    // Counted from the window start 40 min after the arrival: at least 53 - 40 of the absence was after it.
    expect(awayInside(53, 40)).toBe(13);
    expect(onSite(100, 53, 40)).toBe(87);
    expect(awayText(52.6)).toBe('away 53 min');
    expect(awayText(0)).toBeNull();
  });

  it('actualMinutes: the automatic timing also loses the minutes away (from the window start only what can be after it)', () => {
    const base = { arrivedAt: L('08:00'), departedAt: L('10:00'), departedAtOutcome: false, outcomeSource: 'PHONE_MANUAL' };
    expect(actualMinutes({ ...base, autoServiceMinutes: null, autoMinutes: 120, awayMinutes: 50 })).toEqual({ min: 70, label: 'auto, less 50 min away', auto: true });
    expect(actualMinutes({ ...base, autoServiceMinutes: 90, autoMinutes: 120, awayMinutes: 50 })).toEqual({ min: 70, label: 'auto, from the window start, less 20 min away', auto: true });
    // Without minutes away: exactly as before.
    expect(actualMinutes({ ...base, autoServiceMinutes: null, autoMinutes: null })).toEqual({ min: 120, label: 'arrival to departure', auto: false });
  });

  it('the measured unloading per customer and the KPI delta take the time on site', () => {
    const v = (min: number, away: number | null): MeasuredVisit => ({ outcome: 'DELIVERED', autoServiceMinutes: min, autoMinutes: min, timingSuspect: false, outcomeLate: false, plannedServiceMin: 30, casesDelivered: 0, autoArrivedAt: L('08:00'), deliveryDate: D, awayMinutes: away });
    // 120 min with 90 away is 30 on site: eligible (it was over the plan + 60 cap before).
    expect(eligibleForMeasured(v(120, null))).toBe(false);
    expect(eligibleForMeasured(v(120, 90))).toBe(true);
    expect(measuredOnSite(v(120, 90))).toBe(30);
    expect(measuredUnloading([v(120, 90), v(32, null), v(34, null)], 0)!.minutes).toBe(32);
    const kv = (m: MeasuredVisit): KpiVisit => ({ ...m, reason: null, casesPlanned: 10, arrivedAt: L('08:00'), arrivalSource: 'PHONE_AUTO', arrivalObserved: true, windowStartMin: null, windowEndMin: null, noPhotoReason: null, dayStart: DAY });
    expect(deliveryKpis([kv(v(120, 90)), kv(v(40, null))]).avgUnloadDeltaMin).toBe(5);
  });

  it('the delivery export: the actual unloading on site and an "Away from the customer" column', () => {
    const stop = { date: D, depot: 'D1', truck: 'T-100', hired: false, loadNo: 1, sequence: 1, customerCode: 'TST0001', branch: null, customer: 'Shop Example A', driver: null, dailyDriver: false, etaMin: 480, windowStartMin: null, windowEndMin: null, plannedServiceMin: 40, casesPlanned: 30, broughtForwardTo: null };
    const visit = {
      outcome: 'DELIVERED',
      reason: null,
      casesPlanned: 30,
      casesDelivered: 30,
      arrivedAt: L('07:56'),
      arrivalSource: 'PHONE_MANUAL',
      arrivalObserved: true,
      timingSuspect: false,
      windowStartMin: null,
      windowEndMin: null,
      autoServiceMinutes: null,
      plannedServiceMin: 40,
      outcomeLate: false,
      noPhotoReason: null,
      autoArrivedAt: null,
      deliveryDate: D,
      dayStart: DAY,
      autoBasis: null,
      autoMinutes: null,
      departedAt: L('14:23'),
      departureSource: 'AYUN',
      departedAtOutcome: false,
      outcomeSource: 'PHONE_MANUAL',
      arrivalDistanceM: null,
      outcomeAt: L('14:17'),
      reasonNote: null,
      recordedBy: 'Driver link',
      awayMinutes: 53,
    };
    expect(actualsRowOf(stop, visit, [], TZ)).toMatchObject({ actualUnloadMin: 334, awayMin: 53 });
    expect(actualsRowOf(stop, { ...visit, awayMinutes: null }, [], TZ)).toMatchObject({ actualUnloadMin: 387, awayMin: null });
  });

  it('the truck day page: on site without the minutes away, and "away 53 min" on the stop; the later stay is the stop\'s own', () => {
    const v = deriveVisit([tap('07:56'), gpsIn('07:47'), gpsOut('08:27', '07:47'), gpsIn('09:20', 53), gpsOut('14:23', '09:20'), result('14:17')], CTX);
    const i: TruckDayInput = {
      now: L('16:00'),
      tz: TZ,
      date: D,
      mode: 'TIMES',
      trailDays: 2,
      truck: { id: 'TR1', code: 'T-100', description: null, hired: false, oneDay: false, depotId: 'D1', hasTracker: true },
      depots: [{ id: 'D1', code: 'D1', name: 'Depot', lat: 20.0, lng: 55.0 }],
      loads: [{ id: 'L1', runId: 'R1', depotId: 'D1', loadNo: 1, status: 'COMPLETED', departMin: 420, returnMin: 900, driverName: null, driverCasual: false, dispatchedAt: L('07:00'), statusChangedAt: L('15:00'), stops: [{ sequence: 1, customerCode: 'TST0001', customerName: 'Shop Example A', etaMin: 470, plannedServiceMin: 40, windowStartMin: null, windowEndMin: null, pin: PIN, casesPlanned: 30 }] }],
      visits: [{ ...v, depotId: 'D1', loadNo: 1, sequence: 1, casesPlanned: 30, casesDelivered: 30, photoCount: 0, outcome: 'DELIVERED' }],
      events: [gpsIn('07:47'), gpsOut('08:27', '07:47'), gpsIn('09:20', 53), gpsOut('14:23', '09:20')].map((e) => ({ depotId: 'D1', loadNo: 1, sequence: 1, kind: e.kind, source: e.source, at: e.at, receivedAt: e.receivedAt, payload: e.payload ?? null })),
      moves: [],
      trail: [],
      truckDay: null,
      position: null,
      alerts: [],
      dates: [D],
      cfg: { avgSpeedKmh: 40, distanceMultiplier: 1.3, stopRadiusM: 100 },
    };
    const m = buildTruckDay(i);
    expect(m.stops[0]).toMatchObject({ onSiteMin: 334, awayMin: 53 });
    const item = m.timeline.find((x) => x.kind === 'STOP')!;
    expect(item.lines.join(' | ')).toMatch(/On site 334 min \(planned unloading 40 min; away 53 min not counted/);
    // The 07:47 stay (before the tap, still there at it) and the 09:20 stay (before the departure shown) are the stop's own.
    expect(m.timeline.filter((x) => x.kind === 'GPS_VISIT')).toEqual([]);
    expect(otherGpsStays([gpsIn('07:47'), gpsOut('08:27', '07:47'), gpsIn('09:20', 53), gpsOut('14:23', '09:20')], { arrivedAt: L('07:56') }).map((s) => s.when)).toEqual(['LATER']);
  });
});

describe('UNLOAD_OVER measures the time on site (GPS tracking ALERTS)', () => {
  const ON: Partial<AlertConfig> = { alertsEnabled: true, alertUnloadOverMin: 30 };
  const T_ON = thresholdsOf(ON);
  const GPS: AlertGpsSettings = { atStopRadiusM: 250, atDepotRadiusM: 450, avgSpeedKmh: 40, distanceMultiplier: 1.3, depots: new Map([['D1', { lat: 20.0, lng: 55.0 }]]) };
  const visit = (over: Partial<FactVisit>): FactVisit => ({
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
    casesPlanned: 30,
    casesDelivered: null,
    plannedServiceMin: 40,
    windowStartMin: null,
    windowEndMin: null,
    photos: [],
    ...over,
  });
  const stop = (v: FactVisit, over: Partial<FactStop> = {}): FactStop => ({ sequence: 1, customerId: 'cust-1', customerCode: 'TST0001', branchCode: null, customerName: 'Shop Example A', etaMin: 470, serviceStartMin: 470, departureMin: 510, plannedServiceMin: 40, windowStartMin: null, windowEndMin: null, priority: 3, pinVerified: true, pin: PIN, visit: v, ...over });
  const load = (s: FactStop): FactLoad => ({ id: 'load-1', depotId: 'D1', date: D, truckId: 'TR1', truckCode: 'T-100', loadNo: 1, status: 'DISPATCHED', departMin: 420, returnMin: 1080, statusChangedAt: L('07:00'), windowRule: 'START', breakMin: null, backAt: null, leftTapAt: null, stopCount: 1, stops: [s] });
  const facts = (s: FactStop, gps = true, fixAt: string | null = null, where = PIN): AlertFacts => ({
    tz: TZ,
    today: D,
    dates: [addDaysIso(D, -1), D, addDaysIso(D, 1)],
    loads: [load(s)],
    truckDays: [{ date: D, truckId: 'TR1', linkSeenAt: L('07:05'), pageOpened: true, lastSignal: null, gps: gps ? gpsTruckDayFactOf({ position: fixAt ? { fixAt: L(fixAt), lat: where.lat, lng: where.lng, speedKmh: 0, flags: [], movedAt: L(fixAt) } : null, moves: [], trailTo: L('15:00'), now: L(fixAt ?? '15:00') }) : null }],
    open: new Map(),
    ...(gps ? { gps: GPS } : {}),
  });

  it('a finished stop: 6 h 27 min arrival to departure with 53 min away is 5 h 34 min on site; the words say so', () => {
    const v = visit({ arrivedAt: L('07:56'), arrivalSource: 'PHONE_MANUAL', departedAt: L('14:23'), departureSource: 'AYUN', departureObserved: true, outcome: 'DELIVERED', outcomeAt: L('14:17'), outcomeSource: 'PHONE_MANUAL', awayMinutes: 53 });
    const ev = evaluate(facts(stop(v)), L('15:00'), T_ON);
    const row = ev.active.find((c) => c.rule === 'UNLOAD_OVER')!;
    expect(row).toMatchObject({ value: 334 - 40, facts: { tookMin: 334, awayMin: 53, gps: true } });
    expect(row.text).toMatch(/unloading took 5 h 34 min \(GPS departure\) \(away 53 min not counted, GPS\), planned 40 min/);
  });

  it('a stop the truck left for 50 min and came back to, still open: the minutes away are not counted; under the limit no alert', () => {
    // Arrived 08:00, away 08:20-09:10, now 09:20: 80 min since the arrival, 30 on site (planned 40).
    const v = visit({ arrivedAt: L('08:00'), arrivalSource: 'PHONE_MANUAL', awayMinutes: 50 });
    expect(evaluate(facts(stop(v), true, '09:19'), L('09:20'), T_ON).active.filter((c) => c.rule === 'UNLOAD_OVER')).toEqual([]);
    // Without the minutes away it was 80 min, 40 over the plan: raised.
    expect(evaluate(facts(stop({ ...v, awayMinutes: null }), true, '09:19'), L('09:20'), T_ON).active.find((c) => c.rule === 'UNLOAD_OVER')).toBeTruthy();
    // Later on: over the limit on site, and the words say what was not counted.
    const late = evaluate(facts(stop(v), true, '10:39'), L('10:40'), T_ON).active.find((c) => c.rule === 'UNLOAD_OVER')!;
    expect(late.text).toMatch(/1 h 50 min at the stop \(away 50 min not counted, GPS\)/);
  });

  it("the customer's site radius: a fresh fix 370 m from the pin is still at the stop (never narrower than the company's)", () => {
    const fix = { lat: PIN.lat + 370 / 111_320, lng: PIN.lng };
    expect(atStopRadiusOf(GPS, null)).toBe(250);
    expect(atStopRadiusOf(GPS, 400)).toBe(400);
    expect(atStopRadiusOf(GPS, 150)).toBe(250);
    expect(atStopRadiusOf(GPS, 900)).toBe(250);
    const g = gpsTruckDayFactOf({ position: { fixAt: L('09:19'), lat: fix.lat, lng: fix.lng, speedKmh: 0, flags: [], movedAt: L('09:00') }, moves: [], trailTo: L('09:15'), now: L('09:20') });
    expect(liveAt(g, PIN, atStopRadiusOf(GPS, null), L('09:20'))).toBe('AWAY');
    expect(liveAt(g, PIN, atStopRadiusOf(GPS, 400), L('09:20'))).toBe('AT');
    // R1 on a GPS arrival: AWAY waits for the GPS departure; AT with the site radius is followed live.
    const v = visit({ arrivedAt: L('07:30'), arrivalSource: 'AYUN', arrivalObserved: true });
    const away = evaluate(facts(stop(v), true, '09:19', fix), L('09:20'), T_ON);
    expect(away.active.filter((c) => c.rule === 'UNLOAD_OVER')).toEqual([]);
    const atSite = evaluate(facts(stop(v, { siteRadiusM: 400 }), true, '09:19', fix), L('09:20'), T_ON);
    expect(atSite.active.find((c) => c.rule === 'UNLOAD_OVER')?.text).toMatch(/the truck is still there/);
  });

  it('below ALERTS the facts carry no minutes away (the alerts read the visit as the driver made it): the rule is as before', () => {
    const v = visit({ arrivedAt: L('07:56'), arrivalSource: 'PHONE_MANUAL', departedAt: L('14:17'), departedAtOutcome: true, departureSource: 'PHONE_MANUAL', outcome: 'DELIVERED', outcomeAt: L('14:17'), outcomeSource: 'PHONE_MANUAL' });
    const row = evaluate(facts(stop(v), false), L('15:00'), T_ON).active.find((c) => c.rule === 'UNLOAD_OVER')!;
    expect(row.text).not.toMatch(/away/);
    expect(row.facts).toEqual({ tookMin: 381, plannedMin: 40 });
  });
});

describe('migration 20261019120000_gps_site_radius_away', () => {
  const WEB = path.resolve(__dirname, '../..');
  const NAME = '20261019120000_gps_site_radius_away';
  const raw = readFileSync(path.join(WEB, 'prisma', 'migrations', NAME, 'migration.sql'), 'utf8').replace(/\r\n/g, '\n');
  const body = raw
    .split('\n')
    .filter((l) => !l.trim().startsWith('--'))
    .join('\n');
  const schema = readFileSync(path.join(WEB, 'prisma', 'schema.prisma'), 'utf8').replace(/\r\n/g, '\n');
  const block = (m: string) => schema.slice(schema.indexOf(`\nmodel ${m} {`), schema.indexOf('\n}', schema.indexOf(`\nmodel ${m} {`)));
  /** What a CHECK of the form `"col" IS NULL OR (...)` lets through, evaluated on a number (null = NULL). */
  const allows = (constraint: string, col: string, v: number | null) => {
    const m = new RegExp(`"${constraint}" CHECK \\((.*)\\);`).exec(body);
    if (!m) throw new Error(`no CHECK ${constraint}`);
    if (v === null) return /IS NULL OR/.test(m[1]!);
    const js = m[1]!.replace(new RegExp(`"${col}" IS NULL OR`), '').replace(new RegExp(`"${col}"`, 'g'), String(v)).replace(/\bAND\b/g, '&&');
    return Function(`return (${js});`)() as boolean;
  };

  it('sorts after the GPS migrations before it', () => {
    const dir = path.join(WEB, 'prisma', 'migrations');
    const folders = readdirSync(dir).filter((x) => statSync(path.join(dir, x)).isDirectory() && /^\d{14}_/.test(x)).sort();
    expect(folders.indexOf(NAME)).toBeGreaterThan(folders.indexOf('20261018130000_ivms_move_observed'));
    expect(folders.indexOf('20261018130000_ivms_move_observed')).toBeGreaterThan(-1);
  });

  it('adds two nullable columns (no default: no row rewritten) with their CHECKs; schema.prisma agrees', () => {
    expect(body).toContain('ALTER TABLE "Customer" ADD COLUMN     "siteRadiusM" INTEGER;');
    expect(body).toContain('ALTER TABLE "StopVisit" ADD COLUMN     "awayMinutes" DOUBLE PRECISION;');
    for (const re of [/\bDROP\s+(TABLE|COLUMN|INDEX|TYPE|CONSTRAINT)\b/i, /\bRENAME\b/i, /\bALTER\s+COLUMN\b/i, /\bNOT NULL\b/i, /\bDEFAULT\b/i, /\bUPDATE\s+"/i, /\bDELETE\s+FROM\b/i, /\bINSERT\s+INTO\b/i]) {
      expect(body, String(re)).not.toMatch(re);
    }
    expect(block('Customer')).toMatch(/\n\s+siteRadiusM\s+Int\?\n/);
    expect(block('StopVisit')).toMatch(/\n\s+awayMinutes\s+Float\?\n/);
  });

  it('the site radius CHECK: NULL or 100-500, the app bounds (lib/ivms/site-radius.ts)', () => {
    for (const v of [null, 100, 400, 500]) expect(allows('Customer_siteRadiusM_range', 'siteRadiusM', v), String(v)).toBe(true);
    for (const v of [0, 99, 501, 1000, -100]) expect(allows('Customer_siteRadiusM_range', 'siteRadiusM', v), String(v)).toBe(false);
  });

  it('the minutes away CHECK: NULL or more than 0 (the rebuild writes NULL for none)', () => {
    for (const v of [null, 0.1, 53, 2000]) expect(allows('StopVisit_awayMinutes_range', 'awayMinutes', v), String(v)).toBe(true);
    for (const v of [0, -1]) expect(allows('StopVisit_awayMinutes_range', 'awayMinutes', v), String(v)).toBe(false);
  });

  it('takes its lock without waiting first, before the change, with no time limit, and documents the rollback', () => {
    expect(body).toContain('LOCK TABLE "Customer", "StopVisit" IN ACCESS EXCLUSIVE MODE NOWAIT;');
    expect(body.indexOf('NOWAIT')).toBeLessThan(body.indexOf('ALTER TABLE'));
    expect(body).toContain("SELECT set_config('statement_timeout', '0', true);");
    expect(raw).toContain('--   ALTER TABLE "StopVisit" DROP CONSTRAINT "StopVisit_awayMinutes_range", DROP COLUMN "awayMinutes";');
    expect(raw).toContain('--   ALTER TABLE "Customer" DROP CONSTRAINT "Customer_siteRadiusM_range", DROP COLUMN "siteRadiusM";');
    expect(raw).toContain(`DELETE FROM "_prisma_migrations" WHERE migration_name = '${NAME}';`);
  });
});

describe("the office edits a customer's site radius (Details dialog, PATCH /api/customers/:id)", () => {
  it('the API takes whole metres 100-500 or null, nothing else', () => {
    for (const v of [100, 400, 500, null]) expect(customerPatchSchema.safeParse({ siteRadiusM: v }).success, String(v)).toBe(true);
    for (const v of [99, 501, 250.5, '400', '', 'big']) expect(customerPatchSchema.safeParse({ siteRadiusM: v }).success, JSON.stringify(v)).toBe(false);
  });

  it('the dialog sends it only when it changed, refuses a wrong value, and empties it to null', () => {
    const c = { customerType: null, priority: 3, serviceMin: 20, hardWindowStartMin: null, hardWindowEndMin: null, prefWindowStartMin: null, prefWindowEndMin: null, siteRadiusM: 400 };
    const f = detailsFormOf(c);
    expect(f.siteRadius).toBe('400');
    expect(detailsPatch(f, f)).toEqual({ ok: true, patch: {} });
    expect(detailsPatch(f, { ...f, siteRadius: ' 400 ' })).toEqual({ ok: true, patch: {} });
    expect(detailsPatch(f, { ...f, siteRadius: '350' })).toEqual({ ok: true, patch: { siteRadiusM: 350 } });
    expect(detailsPatch(f, { ...f, siteRadius: '' })).toEqual({ ok: true, patch: { siteRadiusM: null } });
    expect(detailsPatch(f, { ...f, siteRadius: '600' })).toMatchObject({ ok: false });
    // A customer without one opens empty, and Save without a change sends nothing (as before).
    const none = detailsFormOf({ ...c, siteRadiusM: null });
    expect(none.siteRadius).toBe('');
    expect(detailsPatch(none, none)).toEqual({ ok: true, patch: {} });
    expect(EMPTY_DETAILS.siteRadius).toBe('');
  });
});
