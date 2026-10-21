/**
 * GPS times win over late phone times (owner decision 21 Oct 2026: "GPS arrival should win of course"; the GPS
 * timing study of 19-20 Oct 2026 found Ayun's own detection right and the times shown wrong on about 15% of the
 * visits because the driver's late taps always won). lib/delivery/visit.ts:
 * - F1: an observed GPS arrival more than 2 min before the driver's arrival tap (or the phone's automatic arrival,
 *   or a "when?" answer) made in the same GPS stay, at most 240 min before it, is shown; the office always wins;
 * - F2: the GPS stay holding the driver's own result gives its observed departure up to 60 min after the result
 *   (15 min for any other, a departure after a gap, or with the driver tapping at another stop in between); the
 *   minutes more than 15 min after the result are "after the result" (afterResultMinutes), never unloading;
 * - F4: an observed GPS departure more than 2 min from the phone's automatic departure replaces it (without a
 *   result, not when the truck came back to the pin before the phone's departure);
 * - F5: the arrival and a phone result tapped within 3 min of each other, at least 10 min after the last GPS stay
 *   at the stop ended and with none in progress, and a result now: that stay's arrival and departure are shown;
 * - the driver's own times the GPS replaced are kept on the visit (own*), so the visit "without GPS"
 *   (withoutGpsTimes) is exactly the driver's and the office's, for every mix of events;
 * - what the office, the truck day page, the alerts, the KPI and the driver page show with them;
 * - migration 20261022090000_gps_times_win.
 * Synthetic stop, invented pin (20.1, 55.1), invented codes; Asia/Muscat time.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  AFTER_RESULT_UNLOADING_MIN,
  deriveVisit,
  GPS_ARRIVAL_WINS_MIN,
  GPS_DEPARTURE_WINS_MIN,
  GPS_MAX_AFTER_RESULT_MIN,
  GPS_TAP_LOOKBACK_MIN,
  LATE_TAP_GAP_MIN,
  LATE_TAP_MIN_STAND_MIN,
  LATE_TAP_TOGETHER_MIN,
  afterResultOf,
  NO_OWN_TIMES,
  OWN_TIME_KEYS,
  OWN_TIMES_SELECT,
  ownArrivalOf,
  withoutGpsTimes,
  type VisitContext,
  type VisitEvent,
  type VisitState,
  type VisitTimes,
} from '@/lib/delivery/visit';
import { actualMinutes, afterResultText, arrivalNote, departureNote, timedByText } from '@/lib/delivery/office-text';
import { arrivalIsObserved, type KpiVisit } from '@/lib/delivery/kpis';
import { measuredOnSite } from '@/lib/delivery/measured';
import { truckDayResults } from '@/lib/delivery/event-service';
import { applyQueued, stopInProgress } from '@/lib/driver-page/overlay';
import type { DriverManifest, ManifestStop } from '@/lib/driver-link/manifest-types';
import { thresholdsOf, type AlertConfig } from '@/lib/alerts/catalog';
import { gpsTruckDayFactOf, type AlertGpsSettings } from '@/lib/alerts/gps';
import { evaluate, type AlertFacts, type FactLoad, type FactStop, type FactVisit } from '@/lib/alerts/rules';
import { addDaysIso, parseHhmm, zonedDayStart } from '@/lib/dispatch/time';
import { buildTruckDay, type TruckDayInput, type TruckDayVisitInput } from '@/lib/ivms/truck-day';
import { changeOf, countChange, emptyCounts } from '@/scripts/rebuild-gps-visits';

const TZ = 'Asia/Muscat';
const D = '2026-10-20';
const DAY = zonedDayStart(D, TZ);
const L = (hhmm: string) => new Date(DAY.getTime() + parseHhmm(hhmm)! * 60_000);
const PIN = { lat: 20.1, lng: 55.1 };
const LINES = [{ orderId: 'O1', lineId: 'A', productCode: 'A', plannedCases: 30, deliveredCases: null }];
const CTX: VisitContext = { dayStart: DAY, windowStartMin: null, breakMin: null, lines: LINES, pin: PIN, radiusM: 100 };

let n = 0;
function ev(kind: VisitEvent['kind'], source: VisitEvent['source'], at: string, payload: Record<string, unknown> = {}, over: Partial<VisitEvent> = {}): VisitEvent {
  n++;
  return { id: `e${n}`, kind, source, at: L(at), receivedAt: over.receivedAt ?? L(at), lat: null, lng: null, accuracyM: null, distanceM: null, payload, ...over };
}
/** A GPS stay's arrival as the detector writes it (the stay summary: minutes standing, minutes away before it). */
const gpsIn = (at: string, o: { observed?: boolean; standMin?: number; awayMin?: number | null; distanceM?: number } = {}) =>
  ev('ARRIVED', 'AYUN', at, { observed: o.observed ?? true, detector: 'ivms-v3', segmentStartAt: L(at).toISOString(), stay: { standMin: o.standMin ?? 20, awayMin: o.awayMin ?? null, merged: 0 } }, { distanceM: o.distanceM ?? 24 });
const gpsOut = (at: string, start: string, gap = false) => ev('DEPARTED', 'AYUN', at, { observed: !gap, ...(gap ? { gap: true } : {}), detector: 'ivms-v3', segmentStartAt: L(start).toISOString() });
/** GPS events stored by the detector of 16-19 Oct 2026 (ivms-v1: no stay summary). */
const v1In = (at: string) => ev('ARRIVED', 'AYUN', at, { observed: true, detector: 'ivms-v1' });
const v1Out = (at: string) => ev('DEPARTED', 'AYUN', at, { observed: true, detector: 'ivms-v1' });
const tap = (at: string, when = false) => ev('ARRIVED', 'PHONE_MANUAL', at, { mode: 'MANUAL', ...(when ? { when: true } : {}) }, { distanceM: 12, accuracyM: 8 });
const autoIn = (at: string, observed = true) => ev('ARRIVED', 'PHONE_AUTO', at, { mode: 'AUTO', ...(observed ? {} : { observed: false }) });
const autoOut = (at: string) => ev('DEPARTED', 'PHONE_AUTO', at, { reason: 'LEFT' });
const result = (at: string, outcome = 'DELIVERED', source: VisitEvent['source'] = 'PHONE_MANUAL') => ev('OUTCOME', source, at, { outcome });
const office = (kind: 'ARRIVED' | 'DEPARTED', at: string) => ev(kind, 'DISPATCHER', at, { mode: 'OFFICE' }, { receivedAt: L('18:00'), userId: 'u1' });
const v = (events: VisitEvent[], ctx: Partial<VisitContext> = {}) => deriveVisit(events, { ...CTX, ...ctx });

const TIMES = ['arrivedAt', 'arrivalSource', 'arrivalDistanceM', 'arrivalAccuracyM', 'arrivalObserved', 'departedAt', 'departureSource', 'departedAtOutcome', 'outcome', 'outcomeAt', 'outcomeSource'] as const;
const timesOf = (x: VisitTimes) => Object.fromEntries(TIMES.map((k) => [k, x[k]]));
/** The visit as the driver and the office made it: rebuilt without the GPS events. */
const ownOf = (events: VisitEvent[]) => v(events.filter((e) => e.source !== 'AYUN'));

describe('the rules and their numbers (owner decision 21 Oct 2026)', () => {
  it('as approved', () => {
    expect([GPS_ARRIVAL_WINS_MIN, GPS_TAP_LOOKBACK_MIN, GPS_MAX_AFTER_RESULT_MIN, AFTER_RESULT_UNLOADING_MIN, GPS_DEPARTURE_WINS_MIN]).toEqual([2, 240, 60, 15, 2]);
    expect([LATE_TAP_TOGETHER_MIN, LATE_TAP_GAP_MIN, LATE_TAP_MIN_STAND_MIN]).toEqual([3, 10, 3]);
  });
});

describe('F1: the GPS arrival wins over a late phone arrival made in the same GPS stay', () => {
  it('a tap 13 min into an observed GPS stay: the GPS arrival is shown, the tap kept as the driver\'s own', () => {
    const events = [gpsIn('10:02', { distanceM: 31 }), gpsOut('10:40', '10:02'), tap('10:15'), result('10:30')];
    const x = v(events);
    expect(x).toMatchObject({ arrivalSource: 'AYUN', arrivalObserved: true, arrivalDistanceM: 31, arrivalAccuracyM: null, ownArrivalSource: 'PHONE_MANUAL', ownArrivalDistanceM: 12, ownArrivalAccuracyM: 8, ownArrivalObserved: true });
    expect(x.arrivedAt).toEqual(L('10:02'));
    expect(x.ownArrivedAt).toEqual(L('10:15'));
    // The result stood in for the departure; the GPS one 10 min after it is shown (as before), the stand-in kept.
    expect(x).toMatchObject({ departureSource: 'AYUN', departedAt: L('10:40'), ownDepartedAt: L('10:30'), ownDepartureSource: 'PHONE_MANUAL', ownDepartedAtOutcome: true, afterResultMinutes: null });
    // The driver's and the office's own visit is restored exactly.
    expect(timesOf(withoutGpsTimes(x))).toEqual(timesOf(ownOf(events)));
    expect(ownArrivalOf(x)).toEqual({ at: L('10:15'), source: 'PHONE_MANUAL' });
  });

  it('a tap at most 2 min after the GPS arrival, a tap before the stay began, an unobserved GPS arrival: the tap stays', () => {
    expect(v([gpsIn('10:02'), tap('10:04'), result('10:30')])).toMatchObject({ arrivalSource: 'PHONE_MANUAL', arrivedAt: L('10:04'), ownArrivedAt: null });
    expect(v([gpsIn('10:02'), tap('10:05'), result('10:30')]).arrivalSource).toBe('AYUN');
    expect(v([tap('09:55'), gpsIn('10:02'), gpsOut('10:40', '10:02'), result('10:30')])).toMatchObject({ arrivalSource: 'PHONE_MANUAL', arrivedAt: L('09:55') });
    expect(v([gpsIn('10:02', { observed: false }), tap('10:15'), result('10:30')])).toMatchObject({ arrivalSource: 'PHONE_MANUAL', arrivedAt: L('10:15') });
  });

  it('a GPS stay begun more than 240 min before the tap is not used', () => {
    expect(v([gpsIn('06:00'), tap('10:01'), result('10:30')])).toMatchObject({ arrivalSource: 'PHONE_MANUAL', arrivedAt: L('10:01') });
    expect(v([gpsIn('06:00'), tap('10:00'), result('10:30')])).toMatchObject({ arrivalSource: 'AYUN', arrivedAt: L('06:00') });
  });

  it("the office's arrival always wins", () => {
    expect(v([gpsIn('10:02'), office('ARRIVED', '10:15'), result('10:30')])).toMatchObject({ arrivalSource: 'DISPATCHER', arrivedAt: L('10:15'), ownArrivedAt: null });
  });

  it('a "when?" answer is a phone arrival too: GPS wins over it (the 4 in the study were 3.6-4.1 min late)', () => {
    expect(v([gpsIn('10:02'), autoIn('10:12', false), tap('10:06', true), result('10:30')])).toMatchObject({ arrivalSource: 'AYUN', arrivedAt: L('10:02'), ownArrivedAt: L('10:06'), ownArrivalSource: 'PHONE_MANUAL' });
  });

  it("the phone's automatic arrival 3 min after the GPS one: the GPS arrival is shown, the measured (automatic) times stay the phone's (M3, H-2)", () => {
    const x = v([gpsIn('10:02'), autoIn('10:05'), result('10:20')]);
    expect(x).toMatchObject({ arrivalSource: 'AYUN', arrivedAt: L('10:02'), ownArrivalSource: 'PHONE_AUTO', autoArrivedAt: L('10:05'), autoBasis: 'RESULT', autoMinutes: 15, autoServiceMinutes: 15 });
    expect(timedByText(x)).toBe('Auto to result');
  });

  it('a big site: the GPS stay in progress at the tap gives the arrival, not an earlier one', () => {
    const x = v([gpsIn('09:00'), gpsOut('09:30', '09:00'), gpsIn('10:02', { awayMin: 25 }), gpsOut('10:40', '10:02'), tap('10:15'), result('10:30')]);
    expect(x).toMatchObject({ arrivalSource: 'AYUN', arrivedAt: L('10:02'), departedAt: L('10:40') });
  });

  it('ivms-v1 events (no stay summary) work the same', () => {
    expect(v([v1In('10:02'), v1Out('10:40'), tap('10:15'), result('10:30')])).toMatchObject({ arrivalSource: 'AYUN', arrivedAt: L('10:02'), departureSource: 'AYUN', departedAt: L('10:40') });
  });
});

describe('F2: the GPS departure of the stay holding the driver result, up to 60 min after it', () => {
  it('left 30 min after the result: the GPS departure, 30 min after the result; the unloading still ends at the result', () => {
    const x = v([gpsIn('10:00'), gpsOut('10:50', '10:00'), tap('10:00'), result('10:20')]);
    expect(x).toMatchObject({ arrivalSource: 'PHONE_MANUAL', departureSource: 'AYUN', departedAt: L('10:50'), departedAtOutcome: false, afterResultMinutes: 30, ownDepartedAt: L('10:20'), ownDepartedAtOutcome: true });
    expect(actualMinutes(x)).toEqual({ min: 20, label: 'arrival to departure, less 30 min after the result', auto: false });
  });

  it('14 min after the result: shown as before, no minutes after the result; 16 min: 16 after it', () => {
    expect(v([gpsIn('10:00'), gpsOut('10:34', '10:00'), tap('10:00'), result('10:20')])).toMatchObject({ departureSource: 'AYUN', departedAt: L('10:34'), afterResultMinutes: null });
    expect(v([gpsIn('10:00'), gpsOut('10:36', '10:00'), tap('10:00'), result('10:20')])).toMatchObject({ departureSource: 'AYUN', afterResultMinutes: 16 });
  });

  it('more than 60 min after the result: the result time ends the stop (a break taken at the customer)', () => {
    expect(v([gpsIn('10:00'), gpsOut('11:21', '10:00'), tap('10:00'), result('10:20')])).toMatchObject({ departureSource: 'PHONE_MANUAL', departedAtOutcome: true, departedAt: L('10:20'), afterResultMinutes: null });
  });

  it("an office result: the 15-minute rule, as before (it is not the end of the stop either)", () => {
    expect(v([gpsIn('10:00'), gpsOut('10:50', '10:00'), tap('10:00'), result('10:20', 'DELIVERED', 'DISPATCHER')])).toMatchObject({ departedAt: null, afterResultMinutes: null });
  });

  it('the neighbour guard: the driver tapped at another stop of the truck-day between the result and the GPS departure: the 15-minute rule', () => {
    const events = [gpsIn('10:00'), gpsOut('10:50', '10:00'), tap('10:00'), result('10:20')];
    expect(v(events, { otherStopTimes: [L('10:40')] })).toMatchObject({ departureSource: 'PHONE_MANUAL', departedAtOutcome: true, afterResultMinutes: null });
    // Taps elsewhere before the result or after the departure change nothing.
    expect(v(events, { otherStopTimes: [L('09:30'), L('10:20'), L('10:50'), L('11:30')] })).toMatchObject({ departureSource: 'AYUN', afterResultMinutes: 30 });
    // 14 min after the result is no allowance: the guard does not matter.
    expect(v([gpsIn('10:00'), gpsOut('10:34', '10:00'), tap('10:00'), result('10:20')], { otherStopTimes: [L('10:30')] })).toMatchObject({ departureSource: 'AYUN', departedAt: L('10:34') });
  });

  it('the result changed after the truck left (tapped again from the next stop): the GPS departure, no minutes after the result', () => {
    const x = v([gpsIn('10:00'), gpsOut('10:50', '10:00'), tap('10:00'), result('10:20'), result('11:30', 'PARTLY_DELIVERED')]);
    expect(x).toMatchObject({ departureSource: 'AYUN', departedAt: L('10:50'), afterResultMinutes: null, outcome: 'PARTLY_DELIVERED' });
  });

  it('time away inside the minutes after the result is counted once: away, not after the result', () => {
    // One cycle (the first stay's departure not written): 10:00, away 10:30-10:40, back 10:40, left 11:00; result 10:20.
    const x = v([gpsIn('10:00'), gpsIn('10:40', { awayMin: 10 }), gpsOut('11:00', '10:40'), tap('10:00'), result('10:20')]);
    expect(x).toMatchObject({ departureSource: 'AYUN', departedAt: L('11:00'), awayMinutes: 10, afterResultMinutes: 30 });
    expect(actualMinutes(x)).toEqual({ min: 20, label: 'arrival to departure, less 10 min away and 30 min after the result', auto: false });
  });

  it('a GPS departure after a gap in the trail (only an upper bound) gets no hour: the 15-minute rule, as before (review of 21 Oct 2026)', () => {
    const at = (gap: boolean, out = '12:15') => v([gpsIn('10:00'), tap('10:01'), result('11:30'), gpsOut(out, '10:00', gap)]);
    expect(at(false)).toMatchObject({ departureSource: 'AYUN', departedAt: L('12:15'), departureGap: false, afterResultMinutes: 45 });
    expect(at(true)).toMatchObject({ departureSource: 'PHONE_MANUAL', departedAt: L('11:30'), departedAtOutcome: true, departureGap: false, afterResultMinutes: null, ownDepartedAt: null });
    // Within 15 min of the result, as before: shown, marked as found after a gap.
    expect(at(true, '11:40')).toMatchObject({ departureSource: 'AYUN', departedAt: L('11:40'), departureGap: true, afterResultMinutes: null });
  });

  it('"Auto to result" is never replaced (second review H-2)', () => {
    expect(v([gpsIn('10:00'), gpsOut('10:50', '10:00'), autoIn('10:00'), result('10:20')])).toMatchObject({ departureSource: 'PHONE_MANUAL', departedAtOutcome: true, autoBasis: 'RESULT', afterResultMinutes: null });
  });
});

describe("F4: an observed GPS departure replaces the phone's automatic departure", () => {
  it('9 min apart: the GPS departure is shown; the automatic timing stays the phone\'s', () => {
    const x = v([autoIn('10:00'), autoOut('10:22'), gpsIn('09:59'), gpsOut('10:31', '09:59'), result('10:20')]);
    expect(x).toMatchObject({ arrivalSource: 'PHONE_AUTO', departureSource: 'AYUN', departedAt: L('10:31'), ownDepartedAt: L('10:22'), ownDepartureSource: 'PHONE_AUTO', ownDepartedAtOutcome: false });
    expect(x).toMatchObject({ autoDepartedAt: L('10:22'), autoBasis: 'DEPARTURE', autoMinutes: 22 });
    expect(timedByText(x)).toBe('Auto to departure');
    // Earlier than the phone's too (the study's case: 26 min).
    expect(v([autoIn('10:00'), autoOut('10:40'), gpsIn('09:59'), gpsOut('10:14', '09:59'), result('10:30')])).toMatchObject({ departureSource: 'AYUN', departedAt: L('10:14') });
  });

  it('2 min apart, a GPS departure after a gap, or the office Left: the phone\'s (or the office\'s) stays', () => {
    expect(v([autoIn('10:00'), autoOut('10:22'), gpsIn('09:59'), gpsOut('10:24', '09:59'), result('10:20')])).toMatchObject({ departureSource: 'PHONE_AUTO', departedAt: L('10:22'), ownDepartedAt: null });
    expect(v([autoIn('10:00'), autoOut('10:22'), gpsIn('09:59'), gpsOut('10:31', '09:59', true), result('10:20')])).toMatchObject({ departureSource: 'PHONE_AUTO' });
    expect(v([autoIn('10:00'), autoOut('10:22'), gpsIn('09:59'), gpsOut('10:31', '09:59'), result('10:20'), office('DEPARTED', '10:25')])).toMatchObject({ departureSource: 'DISPATCHER', departedAt: L('10:25') });
  });

  it("no result and the truck came back to the pin before the phone's departure: the phone's stays, it is the later stay's (review of 21 Oct 2026)", () => {
    const events = [autoIn('09:01'), gpsIn('09:00'), gpsOut('09:20', '09:00'), gpsIn('09:40', { awayMin: 18 }), gpsOut('10:30', '09:40'), autoOut('10:31')];
    expect(v(events)).toMatchObject({ arrivalSource: 'PHONE_AUTO', departureSource: 'PHONE_AUTO', departedAt: L('10:31'), ownDepartedAt: null, state: 'PENDING' });
    // No other stay began before the phone's departure: replaced, as with a result.
    expect(v([autoIn('09:01'), gpsIn('09:00'), gpsOut('09:20', '09:00'), autoOut('09:35')])).toMatchObject({ departureSource: 'AYUN', departedAt: L('09:20'), ownDepartedAt: L('09:35'), ownDepartureSource: 'PHONE_AUTO' });
  });
});

describe('F5: arrival and result tapped together after the truck had left: the GPS stay is shown', () => {
  const stay = () => [gpsIn('10:00', { standMin: 25 }), gpsOut('10:30', '10:00')];

  it('taps 11:40 and 11:41, the GPS stay 10:00-10:30, nothing in progress: the stay is shown, the taps kept', () => {
    const events = [...stay(), tap('11:40'), result('11:41')];
    const x = v(events);
    expect(x).toMatchObject({ arrivalSource: 'AYUN', arrivedAt: L('10:00'), departureSource: 'AYUN', departedAt: L('10:30'), departedAtOutcome: false, awayMinutes: null, afterResultMinutes: null, state: 'DONE', outcome: 'DELIVERED' });
    expect(x).toMatchObject({ ownArrivedAt: L('11:40'), ownArrivalSource: 'PHONE_MANUAL', ownDepartedAt: L('11:41'), ownDepartedAtOutcome: true });
    expect(timesOf(withoutGpsTimes(x))).toEqual(timesOf(ownOf(events)));
    expect(actualMinutes(x)).toEqual({ min: 30, label: 'arrival to departure', auto: false });
  });

  it('not when: the taps are 4 min apart, the stay ended less than 10 min before, more than 240 min before, or stood 2 min', () => {
    expect(v([...stay(), tap('11:40'), result('11:44')]).arrivalSource).toBe('PHONE_MANUAL');
    expect(v([gpsIn('10:00'), gpsOut('11:32', '10:00'), tap('11:40'), result('11:41')]).arrivalSource).toBe('PHONE_MANUAL');
    expect(v([gpsIn('06:00'), gpsOut('07:39', '06:00'), tap('11:40'), result('11:41')]).arrivalSource).toBe('PHONE_MANUAL');
    expect(v([gpsIn('06:00'), gpsOut('07:40', '06:00'), tap('11:40'), result('11:41')]).arrivalSource).toBe('AYUN');
    expect(v([gpsIn('10:00', { standMin: 2 }), gpsOut('10:30', '10:00'), tap('11:40'), result('11:41')]).arrivalSource).toBe('PHONE_MANUAL');
    // ivms-v1 events (no stay summary) pass the standing check.
    expect(v([v1In('10:00'), v1Out('10:30'), tap('11:40'), result('11:41')])).toMatchObject({ arrivalSource: 'AYUN', departureSource: 'AYUN', departedAt: L('10:30') });
  });

  it('the last stay before the taps decides: one that ended less than 10 min before them is never skipped for an older one (review of 21 Oct 2026)', () => {
    const events = [gpsIn('09:00'), gpsOut('09:30', '09:00'), gpsIn('09:45', { standMin: 7, awayMin: 14 }), gpsOut('09:52', '09:45'), tap('09:55'), result('09:56')];
    expect(v(events)).toMatchObject({ arrivalSource: 'PHONE_MANUAL', arrivedAt: L('09:55'), departureSource: 'PHONE_MANUAL', departedAt: L('09:56'), ownArrivedAt: null, ownDepartedAt: null });
    // The later stay ended 11 min before the taps: that stay is shown, never the older one.
    expect(v([gpsIn('09:00'), gpsOut('09:30', '09:00'), gpsIn('09:40', { standMin: 4, awayMin: 9 }), gpsOut('09:44', '09:40'), tap('09:55'), result('09:56')])).toMatchObject({ arrivalSource: 'AYUN', arrivedAt: L('09:40'), departureSource: 'AYUN', departedAt: L('09:44') });
  });

  it("the driver's Undo: no result now, the stop is in progress again as without GPS; a new result applies the rule again (review of 21 Oct 2026)", () => {
    const undone = [...stay(), tap('11:40'), result('11:41'), ev('OUTCOME', 'PHONE_MANUAL', '11:43', { outcome: null })];
    const x = v(undone);
    expect(x).toMatchObject({ arrivalSource: 'PHONE_MANUAL', arrivedAt: L('11:40'), departedAt: null, outcome: null, state: 'ARRIVED', ownArrivedAt: null, ownDepartedAt: null });
    expect(timesOf(x)).toEqual(timesOf(ownOf(undone)));
    expect(v([...undone, result('12:10')])).toMatchObject({ arrivalSource: 'AYUN', arrivedAt: L('10:00'), departureSource: 'AYUN', departedAt: L('10:30'), state: 'DONE', ownArrivedAt: L('11:40') });
  });

  it('a GPS stay in progress at the tap: F1 instead (the stay\'s arrival, its own departure rules)', () => {
    expect(v([gpsIn('11:30'), tap('11:40'), result('11:41')])).toMatchObject({ arrivalSource: 'AYUN', arrivedAt: L('11:30'), departureSource: 'PHONE_MANUAL', departedAtOutcome: true });
  });

  it('a phone result corrected 30 min later still applies (any phone result within 3 min of the tap); an office result alone, or the office Left, never', () => {
    expect(v([...stay(), tap('11:40'), result('11:41'), result('12:11', 'PARTLY_DELIVERED')])).toMatchObject({ arrivalSource: 'AYUN', departedAt: L('10:30'), outcome: 'PARTLY_DELIVERED' });
    expect(v([...stay(), tap('11:40'), result('11:41', 'DELIVERED', 'DISPATCHER')]).arrivalSource).toBe('PHONE_MANUAL');
    expect(v([...stay(), tap('11:40'), result('11:41'), office('DEPARTED', '11:50')])).toMatchObject({ arrivalSource: 'PHONE_MANUAL', departureSource: 'DISPATCHER' });
  });
});

describe('the own times: kept exactly, never GPS, absent without GPS events', () => {
  // GPS stays (one near the arrival, one late with a gap, one after which the driver tapped late), the phone's
  // taps and automatic timing (a departure 9 min before the GPS one), its results (one 20 min before a GPS
  // departure), the office's entries: every subset, rebuilt with and without the AYUN events.
  const withSummary = (e: VisitEvent): VisitEvent => (e.source === 'AYUN' ? { ...e, payload: { ...e.payload, stay: { standMin: 20, awayMin: 0, merged: 0 } } } : e);
  const poolOf = (v2: boolean) =>
    [
      gpsIn('10:00'),
      gpsOut('10:28', '10:00'),
      gpsIn('11:10', { observed: false }),
      gpsOut('11:40', '11:10', true),
      tap('10:04'),
      autoIn('10:03'),
      autoOut('10:19'),
      result('10:20'),
      result('10:22', 'NOT_DELIVERED', 'DISPATCHER'),
      office('ARRIVED', '10:01'),
      office('DEPARTED', '10:35'),
      result('11:20', 'PARTLY_DELIVERED'),
      tap('11:55'),
      result('11:56'),
    ].map((e) => (v2 ? withSummary(e) : { ...e, payload: { ...e.payload, stay: undefined, detector: e.source === 'AYUN' ? 'ivms-v1' : undefined } }));

  it.each([
    ['ivms-v1', false, 3000],
    ['ivms-v3', true, 3000],
  ] as const)('withoutGpsTimes on the stored visit is the visit the driver and the office made, for every mix of events; an own source is never AYUN (%s)', (_name, v2, atLeast) => {
    const pool = poolOf(v2);
    let changed = 0;
    let replaced = 0;
    for (let mask = 1; mask < 1 << pool.length; mask++) {
      const events = pool.filter((_, i) => mask & (1 << i));
      const stored = v(events);
      const own = ownOf(events);
      if (JSON.stringify(timesOf(stored)) !== JSON.stringify(timesOf(own))) changed++;
      if (stored.ownArrivedAt || stored.ownDepartedAt) replaced++;
      const back = withoutGpsTimes(stored);
      if (JSON.stringify(timesOf(back)) !== JSON.stringify(timesOf(own))) {
        expect(timesOf(back), events.map((e) => `${e.kind}/${e.source}@${e.at.toISOString().slice(11, 16)}`).join(' ')).toEqual(timesOf(own));
      }
      expect(stored.ownArrivalSource).not.toBe('AYUN');
      expect(stored.ownDepartureSource).not.toBe('AYUN');
      // A stored own time comes with the shown source AYUN (the readers rely on it).
      if (stored.ownArrivedAt) expect(stored.arrivalSource).toBe('AYUN');
      if (stored.ownDepartedAt) expect(stored.departureSource).toBe('AYUN');
    }
    expect(changed).toBeGreaterThan(atLeast);
    expect(replaced).toBeGreaterThan(1000);
  });

  it('a visit without GPS events has the nine keys undefined (the golden rebuild is unchanged); with them, a value or null', () => {
    const own = v([tap('10:04'), result('10:20')]);
    for (const k of OWN_TIME_KEYS) expect(own[k], k).toBeUndefined();
    expect(JSON.parse(JSON.stringify(own))).not.toHaveProperty('ownArrivedAt');
    const gps = v([gpsIn('09:00'), gpsOut('09:20', '09:00'), tap('10:04'), result('10:20')]);
    for (const k of OWN_TIME_KEYS) expect(gps[k], k).toBeNull();
    expect(withoutGpsTimes(own)).toBe(own);
  });

  it('a stored row an older version rebuilt (own times left stale under a phone source) is read as it is', () => {
    const row: VisitTimes = { ...timesOf(v([tap('10:04'), result('10:20')])), ...NO_OWN_TIMES, ownArrivedAt: L('09:00'), ownArrivalSource: 'PHONE_MANUAL' } as VisitTimes;
    expect(ownArrivalOf(row)).toEqual({ at: L('10:04'), source: 'PHONE_MANUAL' });
    expect(withoutGpsTimes(row)).toBe(row);
  });

  it('afterResultOf: the minutes after the result only under the GPS departure they belong to (stale ones after a rollback are ignored)', () => {
    expect(afterResultOf({ departureSource: 'AYUN', departedAtOutcome: false, afterResultMinutes: 30 })).toBe(30);
    expect(afterResultOf({ departureSource: 'PHONE_MANUAL', departedAtOutcome: true, afterResultMinutes: 30 })).toBeNull();
    expect(afterResultOf({ departureSource: 'AYUN', departedAtOutcome: false, afterResultMinutes: null })).toBeNull();
    expect(afterResultOf({ departureSource: 'AYUN', departedAtOutcome: false })).toBeNull();
  });

  it('ownArrivalOf: the replaced tap, else a phone or office arrival, never a GPS-only one', () => {
    expect(ownArrivalOf({ arrivedAt: L('10:00'), arrivalSource: 'AYUN', ownArrivedAt: null, ownArrivalSource: null })).toBeNull();
    expect(ownArrivalOf({ arrivedAt: L('10:00'), arrivalSource: 'AYUN', ownArrivedAt: L('10:15'), ownArrivalSource: 'PHONE_AUTO' })).toEqual({ at: L('10:15'), source: 'PHONE_AUTO' });
    expect(ownArrivalOf({ arrivedAt: L('10:00'), arrivalSource: 'DISPATCHER' })).toEqual({ at: L('10:00'), source: 'DISPATCHER' });
    expect(ownArrivalOf({ arrivedAt: null, arrivalSource: null })).toBeNull();
    expect(Object.keys(OWN_TIMES_SELECT).sort()).toEqual([...OWN_TIME_KEYS].sort());
  });
});

describe('what the office sees', () => {
  it('the notes: "GPS (Ayun); driver tapped 10:15" and "GPS (Ayun), 30 min after the result"; without the new arguments as before', () => {
    expect(arrivalNote('AYUN', true, '10:15')).toBe('GPS (Ayun); driver tapped 10:15');
    expect(arrivalNote('AYUN', true)).toBe('GPS (Ayun)');
    expect(arrivalNote('PHONE_MANUAL', true, '10:15')).toBe('manual');
    expect(departureNote(false, false, 'AYUN', 30)).toBe('GPS (Ayun), 30 min after the result');
    expect(departureNote(false, true, 'AYUN', 30.4)).toBe('GPS (Ayun), not observed, 30 min after the result');
    expect(departureNote(false, false, 'AYUN')).toBe('GPS (Ayun)');
    expect(departureNote(true, false, 'PHONE_MANUAL', 30)).toBe('result time');
    expect(afterResultText(null)).toBeNull();
    expect(afterResultText(0.4)).toBe('1 min after the result');
  });

  it('the measured (automatic) unloading never sees the minutes after the result', () => {
    expect(measuredOnSite({ autoServiceMinutes: 20, autoMinutes: 20, awayMinutes: null, ...({ afterResultMinutes: 30 } as object) })).toBe(20);
    expect(actualMinutes({ autoServiceMinutes: 20, autoMinutes: 20, arrivedAt: L('10:00'), departedAt: L('10:50'), departedAtOutcome: false, outcomeSource: 'PHONE_MANUAL', afterResultMinutes: 30 })).toEqual({ min: 20, label: 'auto, from the window start', auto: true });
  });

  it('the on-time KPI: a GPS arrival that replaced the driver\'s tap counts, also at a Not delivered stop; a GPS-only one there does not (M3)', () => {
    const kv = (over: Partial<KpiVisit>) => ({ arrivedAt: L('10:00'), arrivalSource: 'AYUN', arrivalObserved: true, timingSuspect: false, outcome: 'NOT_DELIVERED', ...over });
    expect(arrivalIsObserved(kv({ ownArrivalSource: 'PHONE_MANUAL' }))).toBe(true);
    expect(arrivalIsObserved(kv({ ownArrivalSource: 'PHONE_AUTO' }))).toBe(true);
    expect(arrivalIsObserved(kv({}))).toBe(false);
    expect(arrivalIsObserved(kv({ ownArrivalSource: null }))).toBe(false);
    expect(arrivalIsObserved(kv({ ownArrivalSource: 'PHONE_MANUAL', arrivalObserved: false }))).toBe(false);
    expect(arrivalIsObserved(kv({ outcome: 'DELIVERED' }))).toBe(true);
  });

  it('the truck day page: the GPS arrival with the driver\'s tap beside it, the GPS departure with the minutes after the result', () => {
    const x = v([gpsIn('10:02'), gpsOut('11:00', '10:02'), tap('10:15'), result('10:30')]);
    expect(x).toMatchObject({ arrivalSource: 'AYUN', departureSource: 'AYUN', afterResultMinutes: 30 });
    const visit: TruckDayVisitInput = { ...x, depotId: 'D1', loadNo: 1, sequence: 1, casesPlanned: 30, casesDelivered: 30, photoCount: 0, outcomeLate: false };
    const i: TruckDayInput = {
      now: L('16:00'),
      tz: TZ,
      date: D,
      mode: 'TIMES',
      trailDays: 2,
      truck: { id: 'TR1', code: 'T-100', description: null, hired: false, oneDay: false, depotId: 'D1', hasTracker: true },
      depots: [{ id: 'D1', code: 'D1', name: 'Depot', lat: 20.0, lng: 55.0 }],
      loads: [{ id: 'L1', runId: 'R1', depotId: 'D1', loadNo: 1, status: 'COMPLETED', departMin: 540, returnMin: 900, driverName: null, driverCasual: false, dispatchedAt: L('09:00'), statusChangedAt: L('15:00'), stops: [{ sequence: 1, customerCode: 'TST0001', customerName: 'Shop Example A', etaMin: 600, plannedServiceMin: 20, windowStartMin: null, windowEndMin: null, pin: PIN, casesPlanned: 30 }] }],
      visits: [visit],
      events: [],
      moves: [],
      trail: [],
      truckDay: null,
      position: null,
      alerts: [],
      dates: [D],
      cfg: { avgSpeedKmh: 40, distanceMultiplier: 1.3, stopRadiusM: 100 },
    };
    const m = buildTruckDay(i);
    expect(m.stops[0]).toMatchObject({ arrivalTapAt: L('10:15').toISOString(), afterResultMin: 30, onSiteMin: 58 });
    const lines = m.timeline.find((t) => t.kind === 'STOP')!.lines.join(' | ');
    expect(lines).toContain('Arrived 10:02 (GPS (Ayun); driver tapped 10:15)');
    expect(lines).toContain('Left 11:00 (GPS (Ayun)), 30 min after the result');
    expect(lines).toContain('On site 58 min (planned unloading 20 min; 30 min after the result, not unloading)');
    // Below TIMES the page reads the visit without GPS times: the driver's own, nothing beside it.
    const map = buildTruckDay({ ...i, mode: 'MAP' });
    expect(map.stops[0]).toMatchObject({ arrivedAt: L('10:15').toISOString(), arrivalTapAt: null, afterResultMin: null });
  });
});

describe('UNLOAD_OVER (GPS tracking ALERTS) with the minutes after the result and a replaced tap', () => {
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
  const stop = (fv: FactVisit): FactStop => ({ sequence: 1, customerId: 'cust-1', customerCode: 'TST0001', branchCode: null, customerName: 'Shop Example A', etaMin: 600, serviceStartMin: 600, departureMin: 640, plannedServiceMin: 40, windowStartMin: null, windowEndMin: null, priority: 3, pinVerified: true, pin: PIN, visit: fv });
  const load = (s: FactStop): FactLoad => ({ id: 'load-1', depotId: 'D1', date: D, truckId: 'TR1', truckCode: 'T-100', loadNo: 1, status: 'DISPATCHED', departMin: 540, returnMin: 1080, statusChangedAt: L('09:00'), windowRule: 'START', breakMin: null, backAt: null, leftTapAt: null, stopCount: 1, stops: [s] });
  const facts = (s: FactStop, trailTo = '15:00', fixAt: string | null = null): AlertFacts => ({
    tz: TZ,
    today: D,
    dates: [addDaysIso(D, -1), D, addDaysIso(D, 1)],
    loads: [load(s)],
    truckDays: [{ date: D, truckId: 'TR1', linkSeenAt: L('09:05'), pageOpened: true, lastSignal: null, gps: gpsTruckDayFactOf({ position: fixAt ? { fixAt: L(fixAt), lat: 21, lng: 56, speedKmh: 0, flags: [], movedAt: L(fixAt) } : null, moves: [], trailTo: L(trailTo), now: L(fixAt ?? '15:00') }) }],
    open: new Map(),
    gps: GPS,
  });

  it('a stop left 50 min after a result tapped 30 min in: the unloading took 30 min (the 50 after the result not counted): no alert', () => {
    const fv = visit({ arrivedAt: L('10:00'), arrivalSource: 'AYUN', ownArrivedAt: L('10:12'), departedAt: L('11:20'), departureSource: 'AYUN', departureObserved: true, outcome: 'DELIVERED', outcomeAt: L('10:30'), outcomeSource: 'PHONE_MANUAL', afterResultMinutes: 50 });
    expect(evaluate(facts(stop(fv)), L('15:00'), T_ON).active.filter((c) => c.rule === 'UNLOAD_OVER')).toEqual([]);
    // The same visit 90 min to its result: over; the text says the minutes after the result were not counted.
    const long = visit({ ...fv, outcomeAt: L('11:30'), departedAt: L('12:20') });
    const row = evaluate(facts(stop(long)), L('15:00'), T_ON).active.find((c) => c.rule === 'UNLOAD_OVER')!;
    expect(row).toMatchObject({ value: 90 - 40, facts: { tookMin: 90, plannedMin: 40, afterResultMin: 50, gps: true } });
    expect(row.text).toMatch(/unloading took 1 h 30 min \(GPS arrival and departure\) \(50 min after the result not counted, GPS\), planned 40 min/);
  });

  it('a GPS departure after a gap 45 min after the result: the result ends the stop, so the unloading is still measured (review of 21 Oct 2026)', () => {
    for (const gap of [false, true]) {
      const s = v([gpsIn('10:00'), tap('10:01'), result('11:30'), gpsOut('12:15', '10:00', gap)]);
      const fv = visit({
        arrivedAt: s.arrivedAt,
        arrivalSource: s.arrivalSource,
        departedAt: s.departedAt,
        departureSource: s.departureSource,
        departedAtOutcome: s.departedAtOutcome,
        departureObserved: !s.departureGap,
        outcome: s.outcome,
        outcomeAt: s.outcomeAt,
        outcomeSource: s.outcomeSource,
        afterResultMinutes: s.afterResultMinutes,
        autoMinutes: s.autoMinutes,
        autoServiceMinutes: s.autoServiceMinutes,
        casesDelivered: 30,
      });
      const row = evaluate(facts(stop(fv)), L('15:00'), T_ON).active.find((c) => c.rule === 'UNLOAD_OVER');
      expect(row, gap ? 'gap' : 'observed').toMatchObject({ value: 89 - 40, facts: { tookMin: 89, plannedMin: 40 } });
    }
  });

  it('a GPS arrival that replaced the driver\'s tap, ended by the result: measured at once (not waiting for the GPS history, as a GPS-only arrival does)', () => {
    const tapped = visit({ arrivedAt: L('10:00'), arrivalSource: 'AYUN', ownArrivedAt: L('10:12'), departedAt: L('11:30'), departureSource: 'PHONE_MANUAL', departedAtOutcome: true, outcome: 'DELIVERED', outcomeAt: L('11:30'), outcomeSource: 'PHONE_MANUAL' });
    const row = evaluate(facts(stop(tapped), '11:00'), L('11:40'), T_ON).active.find((c) => c.rule === 'UNLOAD_OVER');
    expect(row).toMatchObject({ facts: { tookMin: 90 } });
    // The same times from GPS alone (no tap): waits for the GPS history to show when the truck left.
    const gpsOnly = visit({ ...tapped, ownArrivedAt: undefined });
    const wait = evaluate(facts(stop(gpsOnly), '11:00'), L('11:40'), T_ON);
    expect(wait.active.filter((c) => c.rule === 'UNLOAD_OVER')).toEqual([]);
    expect(evaluate(facts(stop(gpsOnly), '11:45'), L('11:50'), T_ON).active.find((c) => c.rule === 'UNLOAD_OVER')).toMatchObject({ facts: { tookMin: 90 } });
  });
});

describe('the driver page: the driver sees his own taps, never a GPS time that replaced one (owner decision 21 Oct 2026, recommended)', () => {
  const row = (x: VisitState) => ({
    ...x,
    id: 'v1',
    depotId: 'D1',
    loadNo: 1,
    sequence: 1,
    linesJson: x.lines,
    reasonNote: x.reasonNote,
  });
  const fakeDb = (visits: unknown[]) =>
    ({
      stopVisit: { findMany: async () => visits },
      stopEvent: { findMany: async () => [] },
      deliveryPhoto: { findMany: async () => [] },
      order: { findMany: async () => [] },
    }) as never;
  const results = async (x: VisitState) => (await truckDayResults(fakeDb([row(x)]), 'tA', 'TR1', D, [{ loadNo: 1, depotId: 'D1', status: 'DISPATCHED', stops: [{ sequence: 1, orderIds: [] }] }])).stops['D1:1:1']!;
  const manifestOf = (r: Awaited<ReturnType<typeof results>>): Pick<DriverManifest, 'loads'> =>
    ({
      loads: [
        {
          key: 'D1:1',
          depotId: 'D1',
          loadNo: 1,
          trips: 1,
          status: 'DISPATCHED',
          actionable: true,
          departMin: 540,
          returnMin: 900,
          driverName: 'Driver A',
          cases: 30,
          backAtDepotAt: null,
          stops: [{ key: 'D1:1:1', sequence: 1, customerName: 'Shop Example A', customerCode: 'TST0001', branchCode: null, address: null, lat: PIN.lat, lng: PIN.lng, navUrl: null, etaMin: 600, untilMin: 640, hours: null, promised: null, cases: 30, orders: [], notes: [], accessNotes: null, split: null, carriedFrom: null, changeNotes: [], result: r } as ManifestStop],
        },
      ],
    }) as Pick<DriverManifest, 'loads'>;

  it('a tap 13 min into the GPS stay, no result yet: his 10:15 arrival, the stop in progress, the timer from 10:15, no "I arrived" again', async () => {
    const x = v([gpsIn('10:02'), tap('10:15')]);
    expect(x).toMatchObject({ arrivalSource: 'AYUN', arrivedAt: L('10:02'), state: 'ARRIVED' });
    const r = await results(x);
    expect(r).toMatchObject({ state: 'ARRIVED', arrivedAt: L('10:15').toISOString(), arrivalObserved: true });
    expect('arrivalByGps' in r).toBe(false);
    const [l] = applyQueued(manifestOf(r), []);
    expect(l!.stops[0]!.view).toMatchObject({ state: 'ARRIVED', arrivedAt: L('10:15').getTime() });
    expect('gpsArrivedAt' in l!.stops[0]!.view).toBe(false);
    expect(stopInProgress([l!], 'D1:1')).toEqual({ key: 'D1:1:1', arrivedAt: L('10:15').getTime(), observed: true });
  });

  it('late taps after the truck left (F5): his own arrival and result; a GPS-only arrival is still marked as before (M4)', async () => {
    const late = await results(v([gpsIn('10:00', { standMin: 25 }), gpsOut('10:30', '10:00'), tap('11:40'), result('11:41')]));
    expect(late).toMatchObject({ state: 'DONE', arrivedAt: L('11:40').toISOString(), departedAt: L('11:41').toISOString(), minutes: 1 });
    const only = await results(v([gpsIn('10:00'), gpsOut('10:30', '10:00'), result('10:20')]));
    expect(only).toMatchObject({ arrivalByGps: true, arrivedAt: L('10:00').toISOString() });
  });
});

describe('the rebuild of past visits (scripts/rebuild-gps-visits.ts): counts per rule, never a name', () => {
  it('a stored visit against its rebuild: the shifts and the rules', () => {
    const tapped = [gpsIn('10:02'), gpsOut('11:00', '10:02'), tap('10:15'), result('10:30')];
    const before = { arrivedAt: L('10:15'), arrivalSource: 'PHONE_MANUAL', departedAt: L('10:30'), departureSource: 'PHONE_MANUAL' };
    const ch = changeOf(before, v(tapped));
    expect(ch).toEqual({ arrivalMin: 13, departureMin: 30, rules: ['F1', 'F2'] });
    expect(changeOf(before, v([gpsIn('10:00', { standMin: 25 }), gpsOut('10:30', '10:00'), tap('11:40'), result('11:41')])).rules).toEqual(['F5']);
    expect(changeOf(before, v([autoIn('10:00'), autoOut('10:22'), gpsIn('09:59'), gpsOut('10:31', '09:59'), result('10:20')])).rules).toEqual(['F4']);
    expect(changeOf(before, before)).toEqual({ arrivalMin: 0, departureMin: 0, rules: [] });
    const c = emptyCounts();
    countChange(c, ch);
    countChange(c, changeOf(before, { ...before, departedAt: null }));
    expect(c).toMatchObject({ visits: 2, arrivalOver2: 1, arrivalOver5: 1, departureOver2: 2, departureOver5: 2, rules: { F1: 1, F2: 1, F4: 0, F5: 0 } });
  });
});

describe('migration 20261022090000_gps_times_win', () => {
  const WEB = path.resolve(__dirname, '../..');
  const NAME = '20261022090000_gps_times_win';
  const raw = readFileSync(path.join(WEB, 'prisma', 'migrations', NAME, 'migration.sql'), 'utf8').replace(/\r\n/g, '\n');
  const body = raw
    .split('\n')
    .filter((l) => !l.trim().startsWith('--'))
    .join('\n');
  const schema = readFileSync(path.join(WEB, 'prisma', 'schema.prisma'), 'utf8').replace(/\r\n/g, '\n');
  const block = (m: string) => schema.slice(schema.indexOf(`\nmodel ${m} {`), schema.indexOf('\n}', schema.indexOf(`\nmodel ${m} {`)));
  /** What a CHECK of the form `"col" IS NULL OR (...)` lets through, evaluated on a number (null = NULL). */
  const allows = (constraint: string, col: string, x: number | null) => {
    const m = new RegExp(`"${constraint}" CHECK \\((.*)\\);`).exec(body);
    if (!m) throw new Error(`no CHECK ${constraint}`);
    if (x === null) return /IS NULL OR/.test(m[1]!);
    const js = m[1]!.replace(new RegExp(`"${col}" IS NULL OR`), '').replace(new RegExp(`"${col}"`, 'g'), String(x)).replace(/\bAND\b/g, '&&');
    return Function(`return (${js});`)() as boolean;
  };
  const COLUMNS: [string, string, string][] = [
    ['ownArrivedAt', 'TIMESTAMPTZ(3)', 'DateTime\\?\\s+@db\\.Timestamptz\\(3\\)'],
    ['ownArrivalSource', '"StopEventSource"', 'StopEventSource\\?'],
    ['ownArrivalDistanceM', 'DOUBLE PRECISION', 'Float\\?'],
    ['ownArrivalAccuracyM', 'DOUBLE PRECISION', 'Float\\?'],
    ['ownArrivalObserved', 'BOOLEAN', 'Boolean\\?'],
    ['ownDepartedAt', 'TIMESTAMPTZ(3)', 'DateTime\\?\\s+@db\\.Timestamptz\\(3\\)'],
    ['ownDepartureSource', '"StopEventSource"', 'StopEventSource\\?'],
    ['ownDepartedAtOutcome', 'BOOLEAN', 'Boolean\\?'],
    ['afterResultMinutes', 'DOUBLE PRECISION', 'Float\\?'],
  ];

  it('sorts after the migrations before it', () => {
    const dir = path.join(WEB, 'prisma', 'migrations');
    const folders = readdirSync(dir).filter((x) => statSync(path.join(dir, x)).isDirectory() && /^\d{14}_/.test(x)).sort();
    expect(folders.indexOf(NAME)).toBeGreaterThan(folders.indexOf('20261020000000_alert_notes'));
    expect(folders.indexOf('20261020000000_alert_notes')).toBeGreaterThan(-1);
    expect(folders.at(-1)).toBe(NAME);
  });

  it('adds nine nullable columns (no default: no row rewritten) and nothing else; schema.prisma and the code agree', () => {
    for (const [col, sqlType] of COLUMNS) expect(body).toContain(`ADD COLUMN     "${col}" ${sqlType}`);
    expect(body.match(/ADD COLUMN/g)).toHaveLength(9);
    for (const re of [/\bDROP\s+(TABLE|COLUMN|INDEX|TYPE|CONSTRAINT)\b/i, /\bRENAME\b/i, /\bALTER\s+COLUMN\b/i, /\bNOT NULL\b/i, /\bDEFAULT\b/i, /\bUPDATE\s+"/i, /\bDELETE\s+FROM\b/i, /\bINSERT\s+INTO\b/i]) {
      expect(body, String(re)).not.toMatch(re);
    }
    for (const [col, , prismaType] of COLUMNS) expect(block('StopVisit'), col).toMatch(new RegExp(`\\n\\s+${col}\\s+${prismaType}\\n`));
    expect(COLUMNS.map((c) => c[0]).sort()).toEqual([...OWN_TIME_KEYS].sort());
  });

  it('the CHECKs: an own time and its source together, the source never AYUN; the minutes after the result NULL or (0, 1440]; none ties them to the other columns (app rollback safe)', () => {
    expect(body).toContain('ADD CONSTRAINT "StopVisit_ownArrival_pair" CHECK (("ownArrivedAt" IS NULL) = ("ownArrivalSource" IS NULL));');
    expect(body).toContain(`ADD CONSTRAINT "StopVisit_ownArrival_notGps" CHECK ("ownArrivalSource" IS NULL OR "ownArrivalSource" <> 'AYUN');`);
    expect(body).toContain('ADD CONSTRAINT "StopVisit_ownDeparture_pair" CHECK (("ownDepartedAt" IS NULL) = ("ownDepartureSource" IS NULL));');
    expect(body).toContain(`ADD CONSTRAINT "StopVisit_ownDeparture_notGps" CHECK ("ownDepartureSource" IS NULL OR "ownDepartureSource" <> 'AYUN');`);
    for (const x of [null, 0.1, 30, 1440]) expect(allows('StopVisit_afterResultMinutes_range', 'afterResultMinutes', x), String(x)).toBe(true);
    for (const x of [0, -1, 1440.5]) expect(allows('StopVisit_afterResultMinutes_range', 'afterResultMinutes', x), String(x)).toBe(false);
    for (const other of ['"arrivalSource"', '"departureSource"', '"arrivedAt"', '"departedAt"']) expect(body).not.toContain(other);
  });

  it('takes its lock without waiting first, before the change, with no time limit, and documents the rollback', () => {
    expect(body).toContain('LOCK TABLE "StopVisit" IN ACCESS EXCLUSIVE MODE NOWAIT;');
    expect(body.indexOf('NOWAIT')).toBeLessThan(body.indexOf('ALTER TABLE'));
    expect(body).toContain("SELECT set_config('statement_timeout', '0', true);");
    expect(raw).toContain('--   ALTER TABLE "StopVisit" DROP CONSTRAINT "StopVisit_ownArrival_pair"');
    for (const [col] of COLUMNS) expect(raw).toContain(`DROP COLUMN "${col}"`);
    expect(raw).toContain(`DELETE FROM "_prisma_migrations" WHERE migration_name = '${NAME}';`);
  });
});
