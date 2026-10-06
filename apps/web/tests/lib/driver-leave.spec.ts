/**
 * Driver leave (owner request 6 Oct 2026), the pure rules (lib/dispatch/driver-leave.ts): inside and
 * outside a period, the day's view (who is away, until when, who covers), no overlap for one driver,
 * what may be added, changed and removed (ended periods are kept for the record, a started one keeps
 * its first day), the cover checks and the texts the Drivers page and the plan screen show.
 * planDrivers with leave and cover is in dispatch-load-state.spec.ts.
 */
import { describe, expect, it } from 'vitest';
import {
  checkLeaveChange,
  checkLeaveRemove,
  checkNewLeave,
  coverAwayDuring,
  coverAwayWarning,
  coverCaveat,
  coverFor,
  coverOptionLabel,
  coverOptions,
  coverOwnTruckWarning,
  isOnLeave,
  keepTitle,
  leaveOnDay,
  leavePhase,
  leaveQuestion,
  loadLeaveNote,
  noDriverLeaveNote,
  onLeaveLabel,
  overlappingLeave,
  periodsOverlap,
  pickOnLeaveConfirm,
  upcomingLeave,
  type LeavePeriod,
} from '@/lib/dispatch/driver-leave';

const P = (id: string, driverId: string, fromIso: string, untilIso: string, coverDriverId: string | null = null, note: string | null = null): LeavePeriod => ({
  id,
  driverId,
  fromIso,
  untilIso,
  note,
  coverDriverId,
});
const TODAY = '2026-10-06';
const ACTIVE = { active: true, name: 'Bob' };
const codeOf = (c: ReturnType<typeof checkNewLeave>) => (c.ok ? 'OK' : c.code);

describe('inside and outside a period (both ends included)', () => {
  const p = P('L1', 'ALI', '2026-10-07', '2026-10-09');
  it.each([
    ['2026-10-06', false],
    ['2026-10-07', true],
    ['2026-10-08', true],
    ['2026-10-09', true],
    ['2026-10-10', false],
  ])('%s -> %s', (day, inside) => {
    expect(isOnLeave(p, day)).toBe(inside);
  });

  it('a one-day leave is that day only', () => {
    expect(isOnLeave(P('L', 'ALI', TODAY, TODAY), TODAY)).toBe(true);
    expect(isOnLeave(P('L', 'ALI', TODAY, TODAY), '2026-10-07')).toBe(false);
  });

  it('the phase: ended, now, coming', () => {
    expect(leavePhase(P('L', 'A', '2026-10-01', '2026-10-05'), TODAY)).toBe('ENDED');
    expect(leavePhase(P('L', 'A', '2026-10-01', TODAY), TODAY)).toBe('NOW');
    expect(leavePhase(P('L', 'A', TODAY, '2026-10-20'), TODAY)).toBe('NOW');
    expect(leavePhase(P('L', 'A', '2026-10-07', '2026-10-20'), TODAY)).toBe('COMING');
  });
});

describe("a delivery day's view: who is away, until when, and who covers", () => {
  const periods = [P('L1', 'ALI', '2026-10-07', '2026-11-06', 'BOB'), P('L2', 'SAM', '2026-10-01', '2026-10-07'), P('L3', 'ALI', '2026-12-01', '2026-12-05')];

  it('only the periods that hold the day', () => {
    expect([...leaveOnDay(periods, '2026-10-07')]).toEqual([
      ['ALI', { untilIso: '2026-11-06', coverDriverId: 'BOB' }],
      ['SAM', { untilIso: '2026-10-07', coverDriverId: null }],
    ]);
    expect([...leaveOnDay(periods, '2026-10-08')]).toEqual([['ALI', { untilIso: '2026-11-06', coverDriverId: 'BOB' }]]);
    expect(leaveOnDay(periods, '2026-11-07').size).toBe(0); // after the month: used again by himself
    expect([...leaveOnDay(periods, '2026-12-03').keys()]).toEqual(['ALI']);
  });

  it('the cover of a truck whose usual driver is away (none named: null; usual driver not away: null)', () => {
    const day = leaveOnDay(periods, '2026-10-07');
    expect(coverFor('ALI', day)).toBe('BOB');
    expect(coverFor('SAM', day)).toBeNull();
    expect(coverFor('BOB', day)).toBeNull();
    expect(coverFor(null, day)).toBeNull();
  });
});

describe('one driver, no overlapping periods', () => {
  const existing = [P('L1', 'ALI', '2026-10-10', '2026-10-20'), P('L2', 'SAM', '2026-10-01', '2026-10-31')];

  it('touching end to start overlaps (both ends included); the day after does not', () => {
    expect(periodsOverlap({ fromIso: '2026-10-20', untilIso: '2026-10-25' }, existing[0]!)).toBe(true);
    expect(periodsOverlap({ fromIso: '2026-10-21', untilIso: '2026-10-25' }, existing[0]!)).toBe(false);
    expect(periodsOverlap({ fromIso: '2026-10-01', untilIso: '2026-10-09' }, existing[0]!)).toBe(false);
    expect(periodsOverlap({ fromIso: '2026-10-01', untilIso: '2026-10-31' }, existing[0]!)).toBe(true); // around it
  });

  it("another driver's periods never count", () => {
    expect(overlappingLeave(existing, { driverId: 'BOB', fromIso: '2026-10-01', untilIso: '2026-10-31' })).toBeNull();
    expect(overlappingLeave(existing, { driverId: 'ALI', fromIso: '2026-10-15', untilIso: '2026-10-16' })?.id).toBe('L1');
    // The period being changed is not compared with itself.
    expect(overlappingLeave(existing, { driverId: 'ALI', fromIso: '2026-10-15', untilIso: '2026-10-16' }, 'L1')).toBeNull();
  });

  it('a new overlapping period is refused (409 LEAVE_OVERLAP) and names the one already there', () => {
    const c = checkNewLeave({ driverId: 'ALI', fromIso: '2026-10-18', untilIso: '2026-10-25', coverDriverId: null }, existing, TODAY, null);
    expect(c).toEqual({ ok: false, status: 409, code: 'LEAVE_OVERLAP', reason: expect.stringContaining('already on leave from 10 Oct until 20 Oct') });
    expect(codeOf(checkNewLeave({ driverId: 'ALI', fromIso: '2026-10-21', untilIso: '2026-10-25', coverDriverId: null }, existing, TODAY, null))).toBe('OK');
  });

  it('a change that would overlap another period of the driver is refused too', () => {
    const two = [...existing, P('L3', 'ALI', '2026-11-01', '2026-11-05')];
    expect(codeOf(checkLeaveChange(two[2]!, { driverId: 'ALI', fromIso: '2026-10-19', untilIso: '2026-11-05', coverDriverId: null }, two, TODAY, null))).toBe('LEAVE_OVERLAP');
    expect(codeOf(checkLeaveChange(two[2]!, { driverId: 'ALI', fromIso: '2026-10-21', untilIso: '2026-11-05', coverDriverId: null }, two, TODAY, null))).toBe('OK');
  });
});

describe('what may be added', () => {
  const add = (fromIso: string, untilIso: string, coverDriverId: string | null = null, cover: { active: boolean; name: string } | null = ACTIVE) =>
    codeOf(checkNewLeave({ driverId: 'ALI', fromIso, untilIso, coverDriverId }, [], TODAY, coverDriverId ? cover : null));

  it('dates in order; a one-day leave is fine', () => {
    expect(add('2026-10-08', '2026-10-07')).toBe('LEAVE_DATES');
    expect(add('2026-10-08', '2026-10-08')).toBe('OK');
  });

  it('leave that would have ended already is refused; leave that started yesterday and goes on is fine', () => {
    expect(add('2026-10-01', '2026-10-05')).toBe('LEAVE_IN_PAST');
    expect(add('2026-10-05', TODAY)).toBe('OK');
  });

  it('the cover: not the driver himself, a driver of the company, active', () => {
    expect(add('2026-10-07', '2026-10-09', 'ALI')).toBe('LEAVE_COVER_SELF');
    expect(add('2026-10-07', '2026-10-09', 'GHOST', null)).toBe('LEAVE_COVER_UNKNOWN');
    expect(add('2026-10-07', '2026-10-09', 'BOB', { active: false, name: 'Bob' })).toBe('LEAVE_COVER_INACTIVE');
    expect(add('2026-10-07', '2026-10-09', 'BOB')).toBe('OK');
  });
});

describe('what may be changed and removed (past periods are kept for the record)', () => {
  const ended = P('E', 'ALI', '2026-09-20', '2026-10-05');
  const started = P('S', 'ALI', '2026-10-01', '2026-10-31');
  const fromToday = P('T', 'ALI', TODAY, '2026-10-10');
  const coming = P('C', 'ALI', '2026-10-12', '2026-10-15');
  const change = (before: LeavePeriod, fromIso: string, untilIso: string) =>
    codeOf(checkLeaveChange(before, { driverId: 'ALI', fromIso, untilIso, coverDriverId: null }, [before], TODAY, null));

  it('an ended period is not changed or removed', () => {
    expect(change(ended, ended.fromIso, '2026-10-10')).toBe('LEAVE_ENDED');
    expect(codeOf(checkLeaveRemove(ended, TODAY))).toBe('LEAVE_ENDED');
  });

  it('a started period keeps its first day; it ends early down to yesterday, or later; it is not removed', () => {
    expect(change(started, '2026-10-03', '2026-10-31')).toBe('LEAVE_STARTED');
    expect(change(started, started.fromIso, '2026-10-05')).toBe('OK'); // back today: until yesterday
    expect(change(started, started.fromIso, '2026-10-04')).toBe('LEAVE_IN_PAST');
    expect(change(started, started.fromIso, '2026-11-30')).toBe('OK');
    const r = checkLeaveRemove(started, TODAY);
    expect(r).toEqual({ ok: false, status: 409, code: 'LEAVE_STARTED', reason: expect.stringContaining('change Until to yesterday (5 Oct)') });
  });

  it('a period from today or later changes freely (not into the past) and can be removed', () => {
    expect(change(coming, '2026-10-13', '2026-10-20')).toBe('OK');
    expect(change(coming, '2026-10-05', '2026-10-20')).toBe('LEAVE_IN_PAST');
    expect(change(fromToday, '2026-10-08', '2026-10-09')).toBe('OK');
    expect(codeOf(checkLeaveRemove(coming, TODAY))).toBe('OK');
    expect(codeOf(checkLeaveRemove(fromToday, TODAY))).toBe('OK');
  });

  it('a cover deactivated after the save does not block the period: it ends early or its note changes; choosing an inactive cover is refused', () => {
    // Ali's leave 1-31 Oct with Bob; Bob deactivated on the 10th; on the 15th Ali is back.
    const withBob = P('S', 'ALI', '2026-10-01', '2026-10-31', 'BOB');
    const INACTIVE_BOB = { active: false, name: 'Bob' };
    const after = (untilIso: string, coverDriverId: string | null) => ({ driverId: 'ALI', fromIso: withBob.fromIso, untilIso, coverDriverId });
    expect(codeOf(checkLeaveChange(withBob, after('2026-10-14', 'BOB'), [withBob], '2026-10-15', INACTIVE_BOB))).toBe('OK');
    expect(codeOf(checkLeaveChange(withBob, after('2026-10-31', 'BOB'), [withBob], '2026-10-15', INACTIVE_BOB))).toBe('OK'); // only the note changed
    expect(codeOf(checkLeaveChange(withBob, after('2026-10-14', null), [withBob], '2026-10-15', null))).toBe('OK');
    // A cover chosen now must be active: on a change and on a new period.
    const withSam = P('S', 'ALI', '2026-10-01', '2026-10-31', 'SAM');
    expect(codeOf(checkLeaveChange(withSam, after('2026-10-31', 'BOB'), [withSam], '2026-10-15', INACTIVE_BOB))).toBe('LEAVE_COVER_INACTIVE');
    expect(codeOf(checkNewLeave({ driverId: 'ALI', fromIso: '2026-10-20', untilIso: '2026-10-22', coverDriverId: 'BOB' }, [], '2026-10-15', INACTIVE_BOB))).toBe('LEAVE_COVER_INACTIVE');
  });
});

describe('the Leave dialog and the Drivers page: the cover as the planner will see him', () => {
  const drivers = [
    { id: 'ALI', code: 'D01', name: 'Ali', active: true },
    { id: 'BOB', code: 'D02', name: 'Bob', active: false },
    { id: 'SAM', code: 'D03', name: 'Sam', active: true, casual: true },
  ];

  it("the cover list: the active drivers but the driver himself, plus the period's cover when he was deactivated since (marked inactive)", () => {
    expect(coverOptions(drivers, 'ALI', null).map((d) => d.id)).toEqual(['SAM']);
    expect(coverOptions(drivers, 'ALI', 'BOB')).toEqual([
      { id: 'BOB', code: 'D02', name: 'Bob', active: false },
      { id: 'SAM', code: 'D03', name: 'Sam', active: true, casual: true },
    ]);
    expect(coverOptionLabel(coverOptions(drivers, 'ALI', 'BOB')[0]!)).toBe('Bob (inactive)');
    expect(coverOptionLabel(coverOptions(drivers, 'ALI', 'BOB')[1]!)).toBe('Sam (daily)');
    // An unknown id (not in the list) is shown too, so the select never shows another choice than the one sent.
    expect(coverOptions(drivers, 'ALI', 'GONE', 'Unknown driver').map((d) => [d.id, d.name, d.active])).toEqual([
      ['GONE', 'Unknown driver', false],
      ['SAM', 'Sam', true],
    ]);
  });

  it("why a named cover will not drive: inactive, on leave himself, or another truck's usual driver; none: he covers", () => {
    expect(coverCaveat({ name: 'Bob', active: true }, {})).toBeNull();
    expect(coverCaveat({ name: 'Bob', active: false }, {})).toBe('inactive: he cannot cover');
    expect(coverCaveat({ name: 'Bob', active: true }, { away: { fromIso: '2026-10-15', untilIso: '2026-10-17' } })).toBe('on leave himself 15 Oct – 17 Oct: he cannot cover those days');
    expect(coverCaveat({ name: 'Bob', active: true }, { ownTrucks: ['T03'] })).toBe('usual driver of T03: he covers only on days T03 does not run');
    expect(coverCaveat({ name: 'Bob', active: true }, { ownTrucks: ['T03', 'T04'] })).toBe('usual driver of T03, T04: he covers only on days T03, T04 do not run');
    expect(coverCaveat({ name: 'Bob', active: false }, { ownTrucks: ['T03'] })).toBe('inactive: he cannot cover'); // the strongest reason
    expect(coverOwnTruckWarning('Bob', ['T03'])).toBe(
      'Bob is the usual driver of T03: RouteIQ gives him T03 first, so he covers only on days T03 does not run. Name another cover, or pick the driver on the plan.',
    );
    expect(coverOwnTruckWarning('Bob', [])).toBeNull();
  });

  it('the question before a driver on leave is put on a load: the Driver list, Keep and the daily driver all ask it; nobody on leave: none', () => {
    const onLeave = new Map([['ALI', '2026-10-12']]);
    expect(leaveQuestion('ALI', onLeave, 'Ali', 'T01 · L1')).toBe('Ali is on leave until 12 Oct. Put Ali on T01 · L1 anyway?');
    expect(leaveQuestion('SAM', onLeave, 'Sam', 'T01 · L1')).toBeNull();
    expect(leaveQuestion(null, onLeave, 'No driver', 'T01 · L1')).toBeNull();
    expect(keepTitle('Ali', null)).toBe('RouteIQ filled in Ali. Keep makes Ali your pick: a re-plan or Use instead then keeps Ali on this truck and trip.');
    expect(keepTitle('Ali', '2026-10-12')).toBe(
      'RouteIQ filled in Ali, who is on leave until 12 Oct. Keep asks first, then makes Ali your pick: a re-plan or Use instead then keeps Ali on this truck and trip, leave or not.',
    );
  });
});

describe('the cover away himself, and the list of the coming days', () => {
  it("the cover's own leave sharing a day with the period is found (the save warns, it is not refused)", () => {
    const periods = [P('B1', 'BOB', '2026-10-15', '2026-10-17'), P('S1', 'SAM', '2026-10-10', '2026-10-12')];
    const away = coverAwayDuring(periods, { fromIso: '2026-10-10', untilIso: '2026-10-20', coverDriverId: 'BOB' });
    expect(away?.id).toBe('B1');
    expect(coverAwayDuring(periods, { fromIso: '2026-10-18', untilIso: '2026-10-20', coverDriverId: 'BOB' })).toBeNull();
    expect(coverAwayDuring(periods, { fromIso: '2026-10-10', untilIso: '2026-10-20', coverDriverId: null })).toBeNull();
    expect(coverAwayWarning('Bob', away!)).toBe('Bob is on leave himself from 15 Oct until 17 Oct: on those days the truck gets no driver unless you pick one.');
  });

  it('today and the coming 14 days, the soonest first; ended and later periods are left out', () => {
    const periods = [
      P('LATER', 'A', '2026-10-21', '2026-10-25'),
      P('IN14', 'B', '2026-10-20', '2026-10-30'),
      P('NOW', 'C', '2026-10-01', '2026-10-06'),
      P('ENDED', 'D', '2026-09-01', '2026-10-05'),
      P('SOON', 'E', '2026-10-08', '2026-10-09'),
    ];
    expect(upcomingLeave(periods, TODAY).map((p) => p.id)).toEqual(['NOW', 'SOON', 'IN14']);
  });
});

describe('the texts on the plan screen', () => {
  const day = leaveOnDay([P('L1', 'ALI', '2026-10-07', '2026-10-12', 'BOB'), P('L2', 'SAM', '2026-10-07', '2026-10-08')], '2026-10-07');
  const name = (id: string) => ({ ALI: 'Ali', SAM: 'Sam', BOB: 'Bob', NAS: 'Nasser' })[id] ?? id;

  it('the labels and the question', () => {
    expect(onLeaveLabel('2026-10-12')).toBe('on leave until 12 Oct');
    expect(noDriverLeaveNote('Ali', '2026-10-12')).toBe('No driver: Ali is on leave until 12 Oct - pick a driver');
    expect(pickOnLeaveConfirm('Ali', '2026-10-12', 'T01 · L1')).toBe('Ali is on leave until 12 Oct. Put Ali on T01 · L1 anyway?');
  });

  it("a load's note: no driver because the usual driver is away; its driver is away; its driver covers; nothing", () => {
    expect(loadLeaveNote({ status: 'PLANNED', driverId: null }, 'SAM', day, name)).toBe('No driver: Sam is on leave until 8 Oct - pick a driver');
    expect(loadLeaveNote({ status: 'LOCKED', driverId: 'ALI' }, 'ALI', day, name)).toBe('Ali is on leave until 12 Oct');
    expect(loadLeaveNote({ status: 'PLANNED', driverId: 'BOB' }, 'ALI', day, name)).toBe('Covers Ali (on leave until 12 Oct)');
    expect(loadLeaveNote({ status: 'PLANNED', driverId: 'NAS' }, 'ALI', day, name)).toBeNull(); // someone else picked
    expect(loadLeaveNote({ status: 'PLANNED', driverId: null }, 'NAS', day, name)).toBeNull();
    expect(loadLeaveNote({ status: 'PLANNED', driverId: null }, null, day, name)).toBeNull();
  });

  it('a cover who also drives for another depot that day (that depot planned later gave him his own truck): his covering load says so', () => {
    expect(loadLeaveNote({ status: 'PLANNED', driverId: 'BOB' }, 'ALI', day, name, new Set(['BOB']))).toBe(
      'Covers Ali (on leave until 12 Oct) - but Bob also drives a truck of another depot that day: pick another driver',
    );
    expect(loadLeaveNote({ status: 'PLANNED', driverId: 'BOB' }, 'ALI', day, name, new Set(['SAM']))).toBe('Covers Ali (on leave until 12 Oct)');
    expect(loadLeaveNote({ status: 'PLANNED', driverId: 'NAS' }, 'ALI', day, name, new Set(['NAS']))).toBeNull(); // not the cover: not this note's business
  });

  it('a load that has left shows no leave note', () => {
    for (const status of ['DISPATCHED', 'COMPLETED']) {
      expect(loadLeaveNote({ status, driverId: 'ALI' }, 'ALI', day, name)).toBeNull();
      expect(loadLeaveNote({ status, driverId: null }, 'SAM', day, name)).toBeNull();
    }
  });
});
