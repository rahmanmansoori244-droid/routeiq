/**
 * The turnaround at the depot between two trips (owner decision of 16 Oct 2026: alert rule R2 is measured
 * from the driver's Back at depot to his "Leaving for next load"; lib/delivery/turnaround.ts), the one
 * reading the rules, the plan screen and the replay share: live while waiting, final once left, the
 * fallbacks when the tap is missing (the Dispatch press after Back at depot, the first stop reached less
 * the planned drive), the latest tap before a stop (a tap too early is corrected), nothing without Back
 * at depot, and the trip before in departure order. The second review of 16 Oct 2026: a trip started
 * before Back at depot was tapped is not measured (H1), the Dispatch press survives the Completed press
 * (H2), a trip planned after Back at depot counts from then (H3), the drive to the first stop is not time
 * at the depot (M1), and the load row's "no leave recorded" (M3).
 */
import { describe, expect, it } from 'vitest';
import { firstSignOf, leftHowText, plannedDriveOf, previousTrip, TURNAROUND_MAX_MIN, turnaroundLine, turnaroundMinutesText, turnaroundOf, type TurnaroundIn } from '@/lib/delivery/turnaround';
import { NO_OWN_TIMES, withoutGpsTimes } from '@/lib/delivery/visit';

const T0 = Date.parse('2026-10-20T07:20:00Z'); // 11:20 in Muscat: Back at depot of trip 1
const at = (min: number) => new Date(T0 + min * 60_000);
const clock = (d: Date) => new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: 'Asia/Muscat' }).format(d);
const input = (over: Partial<TurnaroundIn> = {}): TurnaroundIn => ({ backAt: at(0), leftTaps: [], dispatchAt: null, firstSignAt: null, now: at(30), ...over });

describe('turnaroundOf', () => {
  it('nothing without Back at depot of the trip before', () => {
    expect(turnaroundOf(input({ backAt: null, leftTaps: [at(50)] }))).toBeNull();
  });

  it('live while the truck is still at the depot: now - Back at depot, not final', () => {
    expect(turnaroundOf(input({ now: at(41) }))).toMatchObject({ backAt: at(0), startAt: at(0), addedLater: false, leftAt: null, how: null, tapLate: false, minutes: 41, graceMin: 0, final: false, notMeasured: null });
  });

  it('final with the driver tap: Back at depot to Leaving for next load', () => {
    expect(turnaroundOf(input({ leftTaps: [at(52)], now: at(60) }))).toMatchObject({ leftAt: at(52), how: 'TAP', tapLate: false, minutes: 52, final: true });
    // A tap the server dated after now (cannot happen: clamped on receipt) is not a leave yet.
    expect(turnaroundOf(input({ leftTaps: [at(40)], now: at(30) }))).toMatchObject({ final: false, minutes: 30 });
  });

  it('a tap made too early is corrected by tapping again: the latest tap before the truck reached a stop counts', () => {
    expect(turnaroundOf(input({ leftTaps: [at(20), at(55)], now: at(60) }))).toMatchObject({ leftAt: at(55), how: 'TAP', minutes: 55 });
    // The order the taps come in does not matter; one after the first stop is left out.
    expect(turnaroundOf(input({ leftTaps: [at(90), at(55), at(20)], firstSignAt: at(70), now: at(95) }))).toMatchObject({ leftAt: at(55), how: 'TAP', minutes: 55 });
  });

  it('review H1: a trip that had started before Back at depot of the trip before was tapped is not measured', () => {
    // L2 out since the morning, at its first stop 11:30; Back at depot of L1 tapped at 12:00.
    const late = turnaroundOf(input({ backAt: at(40), dispatchAt: at(-260), firstSignAt: at(10), now: at(100) }));
    expect(late).toMatchObject({ notMeasured: 'BACK_LATE', final: false, leftAt: null, minutes: 0 });
    // A Leaving tap before Back at depot (Back at depot recorded later): not measured either (was 0 min).
    expect(turnaroundOf(input({ leftTaps: [at(-5)], now: at(10) }))).toMatchObject({ notMeasured: 'BACK_LATE', minutes: 0 });
  });

  it('without the tap: the Dispatch press after Back at depot or the first stop reached, whichever came first, marked as such', () => {
    expect(turnaroundOf(input({ dispatchAt: at(45), now: at(60) }))).toMatchObject({ leftAt: at(45), how: 'DISPATCH', minutes: 45, final: true });
    expect(turnaroundOf(input({ dispatchAt: at(45), firstSignAt: at(40), now: at(60) }))).toMatchObject({ leftAt: at(40), how: 'ARRIVAL', signAt: at(40) });
    expect(turnaroundOf(input({ firstSignAt: at(70), now: at(80) }))).toMatchObject({ leftAt: at(70), how: 'ARRIVAL', minutes: 70, driveMin: 0 });
  });

  it('review M1: the planned drive to the first stop is taken off the first stop reached ("left by")', () => {
    // 70 min to the first stop, 20 min of it the planned drive: left by 50 min.
    expect(turnaroundOf(input({ firstSignAt: at(70), plannedDriveMin: 20, now: at(80) }))).toMatchObject({ leftAt: at(50), how: 'ARRIVAL', signAt: at(70), driveMin: 20, minutes: 50 });
    // Never before Back at depot.
    expect(turnaroundOf(input({ firstSignAt: at(10), plannedDriveMin: 25, now: at(20) }))).toMatchObject({ leftAt: at(0), minutes: 0 });
    // Dispatched in the morning and no tap: while no stop is reached the truck may be on the road; the drive is allowed.
    expect(turnaroundOf(input({ dispatchAt: at(-240), plannedDriveMin: 15, now: at(50) }))).toMatchObject({ final: false, minutes: 50, graceMin: 15 });
    // Not while the Dispatch press is still to come (Locked or Loading): it ends the wait itself.
    expect(turnaroundOf(input({ plannedDriveMin: 15, now: at(50) }))).toMatchObject({ graceMin: 0 });
  });

  it('a Dispatch press before Back at depot (every load pressed in the morning) is not the truck leaving', () => {
    expect(turnaroundOf(input({ dispatchAt: at(-240), now: at(50) }))).toMatchObject({ final: false, minutes: 50 });
    expect(turnaroundOf(input({ dispatchAt: at(-240), firstSignAt: at(65), now: at(70) }))).toMatchObject({ how: 'ARRIVAL', minutes: 65 });
  });

  it('review H2: the Dispatch press counts whatever the status now; a Completed load is never "still at the depot"', () => {
    // L1 back 11:20, L2 dispatched 11:50, first stop 12:35, then completed: still 30 min by the Dispatch press.
    expect(turnaroundOf(input({ dispatchAt: at(30), firstSignAt: at(75), completed: true, now: at(300) }))).toMatchObject({ how: 'DISPATCH', minutes: 30, final: true });
    // Completed with nothing after Back at depot (results recorded by the office, pressed in the morning): no number.
    expect(turnaroundOf(input({ dispatchAt: at(-240), completed: true, now: at(300) }))).toMatchObject({ notMeasured: 'NO_LEAVE', final: false, minutes: 0 });
  });

  it('review H3: a trip planned after Back at depot is counted from when it was planned', () => {
    // Back at depot 11:20; L3 added by a re-plan at 13:20 (120 min later).
    expect(turnaroundOf(input({ existedAt: at(120), now: at(121) }))).toMatchObject({ startAt: at(120), addedLater: true, minutes: 1, final: false });
    expect(turnaroundOf(input({ existedAt: at(120), leftTaps: [at(150)], now: at(160) }))).toMatchObject({ how: 'TAP', minutes: 30 });
    // Planned before Back at depot (the night before): from Back at depot.
    expect(turnaroundOf(input({ existedAt: at(-900), now: at(41) }))).toMatchObject({ startAt: at(0), addedLater: false, minutes: 41 });
  });

  it('a tap after the first stop reached (tapped late, at the customer): the stop is when the truck had left', () => {
    expect(turnaroundOf(input({ leftTaps: [at(90)], firstSignAt: at(70), now: at(95) }))).toMatchObject({ leftAt: at(70), how: 'ARRIVAL', tapLate: true, minutes: 70, final: true });
    // The tap wins over a later Dispatch press.
    expect(turnaroundOf(input({ leftTaps: [at(30)], dispatchAt: at(40), now: at(50) }))).toMatchObject({ how: 'TAP', minutes: 30 });
  });

  it('GPS alerts (owner request 18 Oct 2026): the depot OUT stands in for a missing tap, ahead of the Dispatch press and the first stop', () => {
    expect(turnaroundOf(input({ gpsLeftAt: at(48), dispatchAt: at(55), firstSignAt: at(70), plannedDriveMin: 10, now: at(80) }))).toMatchObject({ leftAt: at(48), how: 'GPS', minutes: 48, final: true });
    // The driver's tap wins.
    expect(turnaroundOf(input({ leftTaps: [at(45)], gpsLeftAt: at(48), now: at(80) }))).toMatchObject({ leftAt: at(45), how: 'TAP' });
    // Never before the count starts, after now, or after the first stop reached.
    expect(turnaroundOf(input({ gpsLeftAt: at(-5), dispatchAt: at(40), now: at(80) }))).toMatchObject({ how: 'DISPATCH' });
    expect(turnaroundOf(input({ gpsLeftAt: at(90), now: at(80) }))).toMatchObject({ final: false, minutes: 80 });
    expect(turnaroundOf(input({ gpsLeftAt: at(75), firstSignAt: at(70), now: at(80) }))).toMatchObject({ how: 'ARRIVAL' });
    // Absent (the load row never passes it): as before.
    expect(turnaroundOf(input({ dispatchAt: at(45), now: at(60) }))).toMatchObject({ how: 'DISPATCH' });
  });
});

describe('the signs at a stop and the planned drive', () => {
  const v = (over: Partial<Parameters<typeof firstSignOf>[0][number] & object> = {}) => ({ arrivedAt: null, departedAt: null, outcomeAt: null, outcomeSource: null, ...over });
  it('arrival, departure and the phone result count; a result the office recorded does not; phone photos count', () => {
    expect(firstSignOf([v({ arrivedAt: at(30) }), v({ departedAt: at(20) })])).toEqual(at(20));
    expect(firstSignOf([v({ outcomeAt: at(15), outcomeSource: 'PHONE_MANUAL' })])).toEqual(at(15));
    expect(firstSignOf([v({ outcomeAt: at(15), outcomeSource: 'DISPATCHER' })])).toBeNull();
    expect(firstSignOf([null, v()], [at(25)])).toEqual(at(25));
  });
  it('merge review of 17 Oct 2026 (findings 1 and 2): GPS times are no sign; the Leaving tap after a GPS-only arrival still counts', () => {
    // The IVMS live link timed the first stop of the next trip from the tracker alone (arrival 11:50, and the
    // driver's result 12:05 ends it); the driver tapped Leaving for next load at 11:55, while his page still
    // showed the stop as not arrived (lib/driver-page/overlay.ts), so the page offered the button.
    const gps = { ...NO_OWN_TIMES, ...v({ arrivedAt: at(30), departedAt: at(45), outcomeAt: at(45), outcomeSource: 'PHONE_MANUAL' }), arrivalSource: 'AYUN', arrivalDistanceM: 20, arrivalAccuracyM: 8, arrivalObserved: true, departureSource: 'PHONE_MANUAL', departedAtOutcome: true, outcome: 'DELIVERED' };
    expect(firstSignOf([gps])).toEqual(at(30)); // read as stored, the GPS arrival would be the first sign
    const sign = firstSignOf([withoutGpsTimes(gps)]); // as rule R2 and the load row read it
    expect(sign).toEqual(at(45)); // the driver's own result
    expect(turnaroundOf(input({ leftTaps: [at(35)], firstSignAt: sign, now: at(60) }))).toMatchObject({ leftAt: at(35), how: 'TAP', tapLate: false, minutes: 35, final: true });
    // A stop only the tracker saw (no result yet) is no sign at all: the truck is still "at the depot" until a tap or a fallback.
    const only = { ...gps, departedAt: at(40), departureSource: 'AYUN', departedAtOutcome: false, outcome: null, outcomeAt: null, outcomeSource: null };
    expect(firstSignOf([withoutGpsTimes(only)])).toBeNull();
  });
  it('the planned drive: the first stop by sequence with an ETA, less the planned departure', () => {
    expect(plannedDriveOf(780, [{ sequence: 2, etaMin: 840 }, { sequence: 1, etaMin: 800 }])).toBe(20);
    expect(plannedDriveOf(780, [{ sequence: 1, etaMin: null }, { sequence: 2, etaMin: 830 }])).toBe(50);
    expect(plannedDriveOf(780, [])).toBeNull();
    expect(plannedDriveOf(780, [{ sequence: 1, etaMin: 700 }])).toBeNull();
  });
});

describe('the words', () => {
  it('how the leave is known (GPS alerts: the GPS depot exit)', () => {
    expect(leftHowText({ how: 'GPS', tapLate: false, signAt: null, driveMin: 0 }, clock)).toBe('the GPS depot exit (no Leaving tap)');
    expect(leftHowText({ how: 'TAP', tapLate: false, signAt: null, driveMin: 0 }, clock)).toBe('Leaving tapped');
    expect(leftHowText({ how: 'DISPATCH', tapLate: false, signAt: null, driveMin: 0 }, clock)).toBe('the Dispatch press (no Leaving tap)');
    expect(leftHowText({ how: 'ARRIVAL', tapLate: false, signAt: at(60), driveMin: 15 }, clock)).toBe('the first stop reached at 12:20 less the planned 15 min drive (no Leaving tap)');
    expect(leftHowText({ how: 'ARRIVAL', tapLate: true, signAt: at(60), driveMin: 0 }, clock)).toBe('the first stop reached at 12:20 (Leaving tapped later)');
  });

  it('the load row: back, left, minutes; a fallback is named; still at the depot; no leave recorded; not measured', () => {
    expect(turnaroundLine(turnaroundOf(input({ leftTaps: [at(48)], now: at(60) }))!, clock)).toBe('back 11:20, left 12:08, 48 min');
    expect(turnaroundLine(turnaroundOf(input({ dispatchAt: at(65), now: at(70) }))!, clock)).toBe('back 11:20, left 12:25 (Dispatch press), 1 h 05 min');
    expect(turnaroundLine(turnaroundOf(input({ firstSignAt: at(60), plannedDriveMin: 15, now: at(70) }))!, clock)).toBe('back 11:20, left by 12:05 (first stop reached 12:20, less the planned 15 min drive), 45 min');
    expect(turnaroundLine(turnaroundOf(input({ firstSignAt: at(60), now: at(70) }))!, clock)).toBe('back 11:20, left by 12:20 (first stop reached 12:20), 1 h');
    expect(turnaroundLine(turnaroundOf(input({ now: at(25) }))!, clock)).toBe('back 11:20, not left yet, 25 min so far');
    // Review M3: no endless "22 h so far": over the 4 h limit, or the day is over.
    expect(turnaroundLine(turnaroundOf(input({ now: at(TURNAROUND_MAX_MIN + 1) }))!, clock)).toBe('back 11:20, no leave recorded');
    expect(turnaroundLine(turnaroundOf(input({ now: at(25) }))!, clock, { dayOver: true })).toBe('back 11:20, no leave recorded');
    expect(turnaroundLine(turnaroundOf(input({ dispatchAt: at(-240), completed: true, now: at(300) }))!, clock)).toBe('back 11:20, no leave recorded');
    expect(turnaroundLine(turnaroundOf(input({ firstSignAt: at(-10), now: at(30) }))!, clock)).toBe('back 11:20, tapped after this trip had started: not measured');
    expect(turnaroundLine(turnaroundOf(input({ existedAt: at(120), leftTaps: [at(150)], now: at(160) }))!, clock)).toBe('back 11:20, trip planned 13:20, left 13:50, 30 min');
    expect([turnaroundMinutesText(0.4), turnaroundMinutesText(59.6), turnaroundMinutesText(125)]).toEqual(['0 min', '1 h', '2 h 05 min']);
  });
});

describe('previousTrip', () => {
  const l = (id: string, departMin: number, loadNo: number) => ({ id, departMin, loadNo });
  it('the load before in departure order (then load number); none for the first trip of the day', () => {
    const day = [l('L3', 900, 3), l('L1', 430, 1), l('L2', 700, 2)];
    expect(previousTrip(day, 'L1')).toBeNull();
    expect(previousTrip(day, 'L2')?.id).toBe('L1');
    expect(previousTrip(day, 'L3')?.id).toBe('L2');
    expect(previousTrip(day, 'missing')).toBeNull();
    // Two loads at the same planned time: by load number.
    expect(previousTrip([l('B', 600, 2), l('A', 600, 1)], 'B')?.id).toBe('A');
  });
});
