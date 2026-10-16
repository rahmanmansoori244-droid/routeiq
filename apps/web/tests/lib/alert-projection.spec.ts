/**
 * Operations alerts (owner request 16 Oct 2026): the projection of a dispatched load (lib/alerts/
 * projection.ts), which rule R3 "running late" and the next stop's window check read. Minutes of the
 * delivery day throughout. Synthetic loads only.
 */
import { describe, expect, it } from 'vitest';
import { projectLoad, type ProjectionIn, type ProjectionStopIn } from '@/lib/alerts/projection';

/** A stop planned at eta, unloading `service` min (no wait unless serviceStart says so). */
const stop = (sequence: number, eta: number, service = 20, extra: Partial<ProjectionStopIn> = {}): ProjectionStopIn => ({
  sequence,
  etaMin: eta,
  serviceStartMin: eta,
  departureMin: eta + service,
  plannedServiceMin: service,
  windowStartMin: null,
  arrivedMin: null,
  endMin: null,
  hasOutcome: false,
  ...extra,
});

/** Depart 07:30 (450), stops at 08:00, 09:00, 10:00 (20 min each), back 11:00. */
const base = (over: Partial<ProjectionIn> = {}): ProjectionIn => ({
  departMin: 450,
  returnMin: 660,
  dispatchMin: 450,
  nowMin: 460,
  lateDispatchMin: 30,
  stops: [stop(1, 480), stop(2, 540), stop(3, 600)],
  ...over,
});

describe('projectLoad', () => {
  it('on time: the next stop is stop 1, expected at its plan, nothing late, back as planned', () => {
    const p = projectLoad(base());
    expect(p.next).toMatchObject({ sequence: 1, state: 'PENDING', expectedArrMin: 480, arrMin: 480, delayMin: 0, clockBound: false });
    expect(p.returnMin).toBe(660);
    expect(p.approximate).toBe(false);
  });

  it('a Dispatch press 20 min late (within the threshold) carries through every stop and the return', () => {
    const p = projectLoad(base({ dispatchMin: 470 }));
    expect(p.stops.map((s) => s.delayMin)).toEqual([20, 20, 20]);
    expect(p.returnMin).toBe(680);
  });

  it('a press before the planned departure does not make the truck early', () => {
    expect(projectLoad(base({ dispatchMin: 360 })).next).toMatchObject({ arrMin: 480, delayMin: 0 });
  });

  it('M3: a press 50 min late before any stop activity starts from the planned departure (held taps arrive in a burst)', () => {
    const p = projectLoad(base({ dispatchMin: 500, nowMin: 505 }));
    expect(p.fromPlannedDeparture).toBe(true);
    expect(p.next).toMatchObject({ sequence: 1, arrMin: 505, delayMin: 25, clockBound: true });
    // With activity already, the press time is trusted again.
    const q = projectLoad(base({ dispatchMin: 500, nowMin: 505, stops: [stop(1, 480, 20, { arrivedMin: 470 }), stop(2, 540), stop(3, 600)] }));
    expect(q.fromPlannedDeparture).toBe(false);
  });

  it('a stop not reached is never expected before now (the clock holds the arrival back)', () => {
    const p = projectLoad(base({ nowMin: 520 }));
    expect(p.next).toMatchObject({ sequence: 1, expectedArrMin: 480, arrMin: 520, delayMin: 40, clockBound: true });
    expect(p.stops[2]).toMatchObject({ arrMin: 640, delayMin: 40 });
  });

  it('a planned wait for the window absorbs the delay downstream', () => {
    // Stop 2 planned at 09:00 but unloading from 09:30 (its window): a truck 20 min late still starts at 09:30.
    const stops = [stop(1, 480, 20, { arrivedMin: 500, endMin: 520, hasOutcome: true }), stop(2, 540, 20, { serviceStartMin: 570, departureMin: 590, windowStartMin: 570 }), stop(3, 630)];
    const p = projectLoad(base({ nowMin: 541, stops }));
    expect(p.next).toMatchObject({ sequence: 2, arrMin: 560, startMin: 570, depMin: 590, delayMin: 20 });
    expect(p.stops[2]).toMatchObject({ arrMin: 630, delayMin: 0 });
  });

  it('the stop in progress ends at max(now, start + planned unloading), the start not before the window', () => {
    const stops = [stop(1, 480, 30, { arrivedMin: 470, windowStartMin: 490 }), stop(2, 560), stop(3, 620)];
    const p = projectLoad(base({ nowMin: 500, stops }));
    expect(p.inProgress).toMatchObject({ sequence: 1, state: 'IN_PROGRESS', startMin: 490, depMin: 520 });
    expect(projectLoad(base({ nowMin: 545, stops })).inProgress).toMatchObject({ depMin: 545 });
  });

  it('a road break planned on the way is inside the leg: a late finish carries only its own delay', () => {
    // Stop 1 ends 08:40 (planned 08:20); the leg to stop 2 is 90 min (30 min drive + a 60 min break).
    const stops = [stop(1, 480, 20, { arrivedMin: 480, endMin: 520, hasOutcome: true }), stop(2, 590), stop(3, 650)];
    const p = projectLoad(base({ nowMin: 525, stops }));
    expect(p.next).toMatchObject({ sequence: 2, expectedArrMin: 610, delayMin: 20 });
  });

  it('a stop skipped while a later one has activity: out of order, the result is approximate', () => {
    const stops = [stop(1, 480, 20, { arrivedMin: 480, endMin: 500, hasOutcome: true }), stop(2, 540), stop(3, 600, 20, { arrivedMin: 530, endMin: 550, hasOutcome: true })];
    const p = projectLoad(base({ nowMin: 560, stops }));
    expect(p.stops.map((s) => s.state)).toEqual(['DONE', 'SKIPPED', 'DONE']);
    expect(p.approximate).toBe(true);
    expect(p.next).toBeNull();
  });

  it('an arrival without a departure, then the next stop: done, ending after its planned unloading', () => {
    const stops = [stop(1, 480, 20, { arrivedMin: 485 }), stop(2, 540, 20, { arrivedMin: 545 }), stop(3, 600)];
    const p = projectLoad(base({ nowMin: 550, stops }));
    expect(p.stops[0]).toMatchObject({ state: 'DONE', depMin: 505 });
    expect(p.inProgress).toMatchObject({ sequence: 2 });
  });

  it('an office result alone (no times) counts as done on schedule from the previous stop', () => {
    const stops = [stop(1, 480, 20, { hasOutcome: true }), stop(2, 540), stop(3, 600)];
    const p = projectLoad(base({ nowMin: 470, stops }));
    expect(p.stops[0]).toMatchObject({ state: 'DONE', arrMin: null, depMin: 500 });
    expect(p.next).toMatchObject({ sequence: 2, arrMin: 540, delayMin: 0 });
  });

  it('every stop done: no next stop; the return is the last end + the planned way back', () => {
    const stops = [stop(1, 480, 20, { arrivedMin: 480, endMin: 500, hasOutcome: true }), stop(2, 540, 20, { arrivedMin: 540, endMin: 560, hasOutcome: true }), stop(3, 600, 20, { arrivedMin: 610, endMin: 640, hasOutcome: true })];
    const p = projectLoad(base({ nowMin: 645, stops }));
    expect(p.next).toBeNull();
    expect(p.returnMin).toBe(640 + (660 - 620));
  });

  it('times past midnight (minutes over 1440) work the same', () => {
    const p = projectLoad({ departMin: 1380, returnMin: 1560, dispatchMin: 1380, nowMin: 1450, lateDispatchMin: 30, stops: [stop(1, 1420), stop(2, 1480)] });
    expect(p.next).toMatchObject({ sequence: 1, arrMin: 1450, delayMin: 30, clockBound: true });
  });
});
