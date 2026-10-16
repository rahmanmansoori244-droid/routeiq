/**
 * The turnaround at the depot between two trips (owner decision of 16 Oct 2026: alert rule R2 is measured
 * from the driver's Back at depot to his "Leaving for next load"; lib/delivery/turnaround.ts), the one
 * reading the rules, the plan screen and the day screen share: live while waiting, final once left, the
 * fallbacks when the tap is missing (the Dispatch press after Back at depot, the first arrival), a tap
 * after the first arrival, nothing without Back at depot, and the trip before in departure order.
 */
import { describe, expect, it } from 'vitest';
import { leftHowText, previousTrip, turnaroundLine, turnaroundMinutesText, turnaroundOf, type TurnaroundIn } from '@/lib/delivery/turnaround';

const T0 = Date.parse('2026-10-20T07:20:00Z'); // 11:20 in Muscat: Back at depot of trip 1
const at = (min: number) => new Date(T0 + min * 60_000);
const clock = (d: Date) => new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: 'Asia/Muscat' }).format(d);
const input = (over: Partial<TurnaroundIn> = {}): TurnaroundIn => ({ backAt: at(0), leftTapAt: null, dispatchAt: null, firstArrivalAt: null, now: at(30), ...over });

describe('turnaroundOf', () => {
  it('nothing without Back at depot of the trip before', () => {
    expect(turnaroundOf(input({ backAt: null, leftTapAt: at(50) }))).toBeNull();
  });

  it('live while the truck is still at the depot: now - Back at depot, not final', () => {
    expect(turnaroundOf(input({ now: at(41) }))).toEqual({ backAt: at(0), leftAt: null, how: null, tapLate: false, minutes: 41, final: false });
  });

  it('final with the driver tap: Back at depot to Leaving for next load', () => {
    expect(turnaroundOf(input({ leftTapAt: at(52), now: at(60) }))).toEqual({ backAt: at(0), leftAt: at(52), how: 'TAP', tapLate: false, minutes: 52, final: true });
    // A tap dated before Back at depot (a clock off, Back at depot recorded later by the office): 0 min.
    expect(turnaroundOf(input({ leftTapAt: at(-5), now: at(10) }))).toMatchObject({ leftAt: at(0), minutes: 0, how: 'TAP' });
    // A tap the server dated after now (cannot happen: clamped on receipt) is not a leave yet.
    expect(turnaroundOf(input({ leftTapAt: at(40), now: at(30) }))).toMatchObject({ final: false, minutes: 30 });
  });

  it('without the tap: the Dispatch press after Back at depot or the first arrival, whichever came first, marked as such', () => {
    expect(turnaroundOf(input({ dispatchAt: at(45), now: at(60) }))).toMatchObject({ leftAt: at(45), how: 'DISPATCH', minutes: 45, final: true });
    expect(turnaroundOf(input({ dispatchAt: at(45), firstArrivalAt: at(40), now: at(60) }))).toMatchObject({ leftAt: at(40), how: 'ARRIVAL' });
    expect(turnaroundOf(input({ firstArrivalAt: at(70), now: at(80) }))).toMatchObject({ leftAt: at(70), how: 'ARRIVAL', minutes: 70 });
  });

  it('a Dispatch press before Back at depot (every load pressed in the morning) is not the truck leaving', () => {
    expect(turnaroundOf(input({ dispatchAt: at(-240), now: at(50) }))).toMatchObject({ final: false, minutes: 50 });
    expect(turnaroundOf(input({ dispatchAt: at(-240), firstArrivalAt: at(65), now: at(70) }))).toMatchObject({ how: 'ARRIVAL', minutes: 65 });
    // An arrival before Back at depot belongs to an earlier time: ignored too.
    expect(turnaroundOf(input({ firstArrivalAt: at(-30), now: at(20) }))).toMatchObject({ final: false });
  });

  it('a tap after the first arrival (tapped late, at the customer): the arrival is when the truck had left', () => {
    expect(turnaroundOf(input({ leftTapAt: at(90), firstArrivalAt: at(70), now: at(95) }))).toEqual({ backAt: at(0), leftAt: at(70), how: 'ARRIVAL', tapLate: true, minutes: 70, final: true });
    // The tap wins over a later Dispatch press.
    expect(turnaroundOf(input({ leftTapAt: at(30), dispatchAt: at(40), now: at(50) }))).toMatchObject({ how: 'TAP', minutes: 30 });
  });
});

describe('the words', () => {
  it('how the leave is known', () => {
    expect(leftHowText({ how: 'TAP', tapLate: false })).toBe('Leaving tapped');
    expect(leftHowText({ how: 'DISPATCH', tapLate: false })).toBe('the Dispatch press (no Leaving tap)');
    expect(leftHowText({ how: 'ARRIVAL', tapLate: false })).toBe('the first arrival (no Leaving tap)');
    expect(leftHowText({ how: 'ARRIVAL', tapLate: true })).toBe('the first arrival (Leaving tapped later)');
  });

  it('the load row: back, left, minutes; a fallback is named; still at the depot', () => {
    expect(turnaroundLine(turnaroundOf(input({ leftTapAt: at(48), now: at(60) }))!, clock)).toBe('back 11:20, left 12:08, 48 min');
    expect(turnaroundLine(turnaroundOf(input({ dispatchAt: at(65), now: at(70) }))!, clock)).toBe('back 11:20, left 12:25 (Dispatch press), 1 h 05 min');
    expect(turnaroundLine(turnaroundOf(input({ firstArrivalAt: at(60), now: at(70) }))!, clock)).toBe('back 11:20, left 12:20 (first arrival), 1 h');
    expect(turnaroundLine(turnaroundOf(input({ now: at(25) }))!, clock)).toBe('back 11:20, not left yet, 25 min so far');
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
