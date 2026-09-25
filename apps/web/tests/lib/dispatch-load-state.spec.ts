/**
 * Load lifecycle: allowed transitions, per-truck ordering (Load 1 before Load 2) and roles; the
 * driver rules of a re-plan or "Use instead" (planDrivers), Keep and the driver clash warning.
 */
import { describe, expect, it } from 'vitest';
import {
  checkDriverChange,
  checkTransition,
  driverClashes,
  driverPickLink,
  FROZEN,
  isFrozen,
  isDriverKeep,
  isHandSetDriver,
  ON_ROAD,
  planDrivers,
  timesClash,
  timesOverlap,
  type DriverNoteReason,
  type EvidenceLoad,
  type LoadRef,
  type LoadStatusName,
  type PlanTrip,
} from '@/lib/dispatch/load-state';

const L = (loadNo: number, status: LoadStatusName, id = `L${loadNo}`): LoadRef => ({ id, loadNo, status });
const ALL: LoadStatusName[] = ['PLANNED', 'LOCKED', 'LOADING', 'DISPATCHED', 'COMPLETED'];

describe('checkTransition - status graph (single load)', () => {
  const allowed: [LoadStatusName, LoadStatusName, 'PLANNER' | 'SUPERVISOR'][] = [
    ['PLANNED', 'LOCKED', 'PLANNER'],
    ['LOCKED', 'PLANNED', 'PLANNER'],
    ['LOCKED', 'LOADING', 'PLANNER'],
    ['LOADING', 'LOCKED', 'PLANNER'],
    ['LOCKED', 'DISPATCHED', 'SUPERVISOR'],
    ['LOADING', 'DISPATCHED', 'SUPERVISOR'],
    ['DISPATCHED', 'COMPLETED', 'SUPERVISOR'],
  ];

  it.each(allowed)('%s -> %s is allowed for %s', (from, to, role) => {
    const load = L(1, from);
    expect(checkTransition(load, [load], to)).toEqual({ ok: true, role });
  });

  it('every other move is rejected', () => {
    const ok = new Set(allowed.map(([f, t]) => `${f}->${t}`));
    for (const from of ALL) {
      for (const to of ALL) {
        if (from === to || ok.has(`${from}->${to}`)) continue;
        const r = checkTransition(L(1, from), [], to);
        expect(r.ok, `${from}->${to}`).toBe(false);
      }
    }
  });

  it('PLANNED -> DISPATCHED is rejected (must be locked first)', () => {
    expect(checkTransition(L(1, 'PLANNED'), [], 'DISPATCHED')).toEqual({ ok: false, reason: 'A PLANNED load cannot move to DISPATCHED.' });
    expect(checkTransition(L(1, 'PLANNED'), [], 'LOADING').ok).toBe(false);
    expect(checkTransition(L(1, 'PLANNED'), [], 'COMPLETED').ok).toBe(false);
  });

  it('DISPATCHED cannot go back to PLANNED / LOCKED / LOADING', () => {
    for (const to of ['PLANNED', 'LOCKED', 'LOADING'] as const) {
      expect(checkTransition(L(2, 'DISPATCHED'), [], to)).toEqual({ ok: false, reason: 'Load 2 is DISPATCHED and can no longer be changed.' });
    }
  });

  it('COMPLETED is final', () => {
    for (const to of ['PLANNED', 'LOCKED', 'LOADING', 'DISPATCHED'] as const) {
      const r = checkTransition(L(1, 'COMPLETED'), [], to);
      expect(r).toEqual({ ok: false, reason: 'Load 1 is COMPLETED and can no longer be changed.' });
    }
  });

  it('moving to the same status is rejected', () => {
    for (const s of ALL) {
      expect(checkTransition(L(1, s), [], s)).toEqual({ ok: false, reason: `Load is already ${s}.` });
    }
  });
});

describe('checkTransition - load order on one truck', () => {
  it('cannot lock Load 2 while Load 1 is still PLANNED', () => {
    const l1 = L(1, 'PLANNED');
    const l2 = L(2, 'PLANNED');
    expect(checkTransition(l2, [l1, l2], 'LOCKED')).toEqual({
      ok: false,
      reason: 'Lock Load 1 of this truck first - loads are loaded in order.',
    });
    // Lists every open earlier load.
    const r = checkTransition(L(3, 'PLANNED'), [l1, l2, L(3, 'PLANNED')], 'LOCKED');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/Lock Load 1, 2 of this truck first/);
  });

  it('can lock Load 2 once Load 1 is frozen (any frozen status)', () => {
    for (const s of ['LOCKED', 'LOADING', 'DISPATCHED', 'COMPLETED'] as const) {
      expect(checkTransition(L(2, 'PLANNED'), [L(1, s), L(2, 'PLANNED')], 'LOCKED'), s).toEqual({ ok: true, role: 'PLANNER' });
    }
  });

  it('a later PLANNED load does not block locking Load 1', () => {
    expect(checkTransition(L(1, 'PLANNED'), [L(1, 'PLANNED'), L(2, 'PLANNED')], 'LOCKED')).toEqual({ ok: true, role: 'PLANNER' });
  });

  it('cannot unlock Load 1 while Load 2 is LOCKED (or later)', () => {
    for (const s of ['LOCKED', 'LOADING', 'DISPATCHED'] as const) {
      const r = checkTransition(L(1, 'LOCKED'), [L(1, 'LOCKED'), L(2, s)], 'PLANNED');
      expect(r, s).toEqual({ ok: false, reason: 'Unlock Load 2 of this truck first.' });
    }
  });

  it('can unlock Load 1 when later loads are still PLANNED', () => {
    expect(checkTransition(L(1, 'LOCKED'), [L(1, 'LOCKED'), L(2, 'PLANNED')], 'PLANNED')).toEqual({ ok: true, role: 'PLANNER' });
  });

  it('can unlock Load 2 while Load 1 stays LOCKED', () => {
    expect(checkTransition(L(2, 'LOCKED'), [L(1, 'LOCKED'), L(2, 'LOCKED')], 'PLANNED')).toEqual({ ok: true, role: 'PLANNER' });
  });

  it('cannot dispatch Load 2 before Load 1 is dispatched', () => {
    for (const s of ['PLANNED', 'LOCKED', 'LOADING'] as const) {
      const r = checkTransition(L(2, 'LOCKED'), [L(1, s), L(2, 'LOCKED')], 'DISPATCHED');
      expect(r, s).toEqual({ ok: false, reason: 'Dispatch Load 1 of this truck first.' });
    }
  });

  it('can dispatch Load 2 once Load 1 is DISPATCHED or COMPLETED', () => {
    expect(checkTransition(L(2, 'LOCKED'), [L(1, 'DISPATCHED'), L(2, 'LOCKED')], 'DISPATCHED')).toEqual({ ok: true, role: 'SUPERVISOR' });
    expect(checkTransition(L(2, 'LOADING'), [L(1, 'COMPLETED'), L(2, 'LOADING')], 'DISPATCHED')).toEqual({ ok: true, role: 'SUPERVISOR' });
  });

  it('loads of other trucks are not passed in and so never block', () => {
    expect(checkTransition(L(2, 'PLANNED'), [], 'LOCKED')).toEqual({ ok: true, role: 'PLANNER' });
  });

  it('the load itself in sameTruckLoads is ignored (matched by id)', () => {
    const self = L(1, 'LOCKED');
    expect(checkTransition(self, [{ ...self }], 'PLANNED')).toEqual({ ok: true, role: 'PLANNER' });
  });
});

describe('frozen / on-road sets', () => {
  it('everything except PLANNED is frozen', () => {
    expect(ALL.filter(isFrozen)).toEqual(['LOCKED', 'LOADING', 'DISPATCHED', 'COMPLETED']);
    expect(FROZEN.has('PLANNED')).toBe(false);
  });

  it('only DISPATCHED and COMPLETED are on the road', () => {
    expect([...ON_ROAD].sort()).toEqual(['COMPLETED', 'DISPATCHED']);
  });
});

/**
 * planDrivers: the simplified driver rules (owner decision after the sixth review of PR3).
 * Minutes from midnight: 360 = 06:00, 480 = 08:00, 570 = 09:30, 600 = 10:00, 660 = 11:00,
 * 720 = 12:00, 840 = 14:00.
 */
const AT = new Date('2026-09-26T05:00:00Z');
const HAND = { driverSetById: 'u1', driverSetAt: AT };
const USABLE = new Set(['ALI', 'SAM', 'BOB']);
/** A load of the version before the apply (the evidence); PLANNED and filled in unless `extra` says otherwise. */
const was = (truckId: string, loadNo: number, driverId: string | null, departMin: number, returnMin: number, extra: Partial<EvidenceLoad> = {}): EvidenceLoad => ({
  truckId,
  loadNo,
  driverId,
  departMin,
  returnMin,
  status: 'PLANNED',
  driverSetById: null,
  driverSetAt: null,
  ...extra,
});
/** A trip of the plan being applied. */
const trip = (truckId: string, loadNo: number, departMin: number, returnMin: number, defaultDriverId: string | null = null): PlanTrip => ({
  key: `${truckId}:${loadNo}`,
  truckId,
  loadNo,
  departMin,
  returnMin,
  defaultDriverId,
});
const both = <T,>(list: T[]) => [list, [...list].reverse()];
const ids = (r: ReturnType<typeof planDrivers>) => Object.fromEntries([...r.drivers].map(([k, v]) => [k, v.driverId]));
/** The yellow clash warnings of the plan: its trips with their new drivers, and its frozen loads. */
const clashesOf = (trips: PlanTrip[], r: ReturnType<typeof planDrivers>, evidence: EvidenceLoad[] = []) =>
  driverClashes([
    ...trips.map((t) => ({ id: t.key, truckId: t.truckId, departMin: t.departMin, returnMin: t.returnMin, driverId: r.drivers.get(t.key)!.driverId })),
    ...evidence.filter((e) => e.status !== 'PLANNED').map((e, i) => ({ id: `kept${i}`, ...e })),
  ]);
const note = (key: string, departMin: number, returnMin: number, fromDriverId: string, toDriverId: string | null, reason: DriverNoteReason, other: { truckId: string; loadNo: number } | null = null) => {
  const [truckId, loadNo] = key.split(':');
  return { key, truckId: truckId!, loadNo: Number(loadNo), departMin, returnMin, fromDriverId, toDriverId, reason, other };
};

describe('planDrivers pass 1: a hand-set driver stays on its truck and trip', () => {
  it('keeps the driver with its marker; the filled-in trip that now overlaps it loses the driver, with a CLASH note - in both truck orders', () => {
    // T03 L1 Ali by hand 09:30-11:00; T02 L1 Ali filled in 12:00-14:00, moved to 10:00-12:00.
    const evidence = [was('T02', 1, 'ALI', 720, 840), was('T03', 1, 'ALI', 570, 660, HAND)];
    for (const trips of both([trip('T02', 1, 600, 720, 'SAM'), trip('T03', 1, 570, 660, 'SAM')])) {
      const r = planDrivers(trips, evidence, USABLE);
      expect(r.drivers.get('T03:1')).toEqual({ driverId: 'ALI', driverSetById: 'u1', driverSetAt: AT });
      expect(r.drivers.get('T02:1')).toEqual({ driverId: 'SAM', driverSetById: null, driverSetAt: null }); // its default
      expect(r.notes).toEqual([note('T02:1', 600, 720, 'ALI', 'SAM', 'CLASH', { truckId: 'T03', loadNo: 1 })]);
      expect(clashesOf(trips, r)).toEqual([]);
    }
  });

  it('the hand-set trip wins even when it is the one that moved', () => {
    // T02 L1 Ali filled in 09:30-11:00 (does not move); T03 L1 Ali by hand 12:00-14:00, moved to 10:00-12:00.
    const evidence = [was('T02', 1, 'ALI', 570, 660), was('T03', 1, 'ALI', 720, 840, HAND)];
    for (const trips of both([trip('T02', 1, 570, 660), trip('T03', 1, 600, 720)])) {
      const r = planDrivers(trips, evidence, USABLE);
      expect(r.drivers.get('T03:1')).toEqual({ driverId: 'ALI', driverSetById: 'u1', driverSetAt: AT });
      expect(ids(r)['T02:1']).toBeNull();
      expect(r.notes).toEqual([note('T02:1', 570, 660, 'ALI', null, 'CLASH', { truckId: 'T03', loadNo: 1 })]);
    }
  });

  it('two hand-set trips of one driver that now overlap both keep it: the yellow clash warning shows it, no note', () => {
    const evidence = [was('T02', 1, 'ALI', 570, 660, HAND), was('T03', 1, 'ALI', 720, 840, HAND)];
    for (const trips of both([trip('T02', 1, 600, 720), trip('T03', 1, 630, 750)])) {
      const r = planDrivers(trips, evidence, USABLE);
      expect(ids(r)).toEqual({ 'T02:1': 'ALI', 'T03:1': 'ALI' });
      expect(clashesOf(trips, r)).toHaveLength(1);
      expect(r.notes).toEqual([]);
    }
  });

  it('a hand-set trip moved onto a frozen load of its driver keeps the driver (the warning); a filled-in one loses it (CLASH note)', () => {
    const locked = was('T01', 1, 'ALI', 360, 540, { status: 'LOCKED' });
    const trips = [trip('T02', 1, 480, 660)];
    const hand = planDrivers(trips, [locked, was('T02', 1, 'ALI', 570, 660, HAND)], USABLE);
    expect(hand.drivers.get('T02:1')).toEqual({ driverId: 'ALI', driverSetById: 'u1', driverSetAt: AT });
    expect(clashesOf(trips, hand, [locked])).toHaveLength(1);
    expect(hand.notes).toEqual([]);
    const filled = planDrivers(trips, [locked, was('T02', 1, 'ALI', 570, 660)], USABLE);
    expect(ids(filled)).toEqual({ 'T02:1': null });
    expect(filled.notes).toEqual([note('T02:1', 480, 660, 'ALI', null, 'CLASH', { truckId: 'T01', loadNo: 1 })]);
  });

  it('copies the marker as the evidence row has it (driverSetById null once that user was deleted); either column makes a driver hand-set', () => {
    const noUser = planDrivers([trip('T02', 1, 570, 660)], [was('T02', 1, 'ALI', 570, 660, { driverSetById: null, driverSetAt: AT })], USABLE);
    expect(noUser.drivers.get('T02:1')).toEqual({ driverId: 'ALI', driverSetById: null, driverSetAt: AT });
    const noTime = planDrivers([trip('T02', 1, 570, 660)], [was('T02', 1, 'ALI', 570, 660, { driverSetById: 'u1', driverSetAt: null })], USABLE);
    expect(noTime.drivers.get('T02:1')).toEqual({ driverId: 'ALI', driverSetById: 'u1', driverSetAt: null });
    expect(isHandSetDriver({ driverId: 'ALI', driverSetById: null, driverSetAt: AT })).toBe(true);
    expect(isHandSetDriver({ driverId: 'ALI', driverSetById: 'u1', driverSetAt: null })).toBe(true);
    expect(isHandSetDriver({ driverId: 'ALI', driverSetById: null, driverSetAt: null })).toBe(false);
    expect(isHandSetDriver({ driverId: null, driverSetById: 'u1', driverSetAt: AT })).toBe(false);
  });

  it('a hand-set driver who is no longer active is not kept: pass 2 fills the trip, without the marker, and an INACTIVE note says why', () => {
    const r = planDrivers([trip('T03', 1, 480, 600, 'SAM')], [was('T03', 1, 'BOB', 480, 600, HAND)], new Set(['ALI', 'SAM']));
    expect(r.drivers.get('T03:1')).toEqual({ driverId: 'SAM', driverSetById: null, driverSetAt: null });
    expect(r.notes).toEqual([note('T03:1', 480, 600, 'BOB', 'SAM', 'INACTIVE')]);
  });
});

describe('planDrivers pass 2: drivers RouteIQ fills in', () => {
  it('two filled-in trips of one driver that now overlap: the one that moved loses it, whatever the order (CLASH note)', () => {
    const evidence = [was('T02', 1, 'ALI', 570, 660), was('T03', 1, 'ALI', 720, 840)];
    for (const trips of both([trip('T02', 1, 570, 660), trip('T03', 1, 600, 720)])) {
      const r = planDrivers(trips, evidence, USABLE); // T03 moved
      expect(ids(r)).toEqual({ 'T02:1': 'ALI', 'T03:1': null });
      expect(r.notes).toEqual([note('T03:1', 600, 720, 'ALI', null, 'CLASH', { truckId: 'T02', loadNo: 1 })]);
      expect(clashesOf(trips, r)).toEqual([]);
    }
    for (const trips of both([trip('T02', 1, 700, 790), trip('T03', 1, 720, 840)])) {
      const r = planDrivers(trips, evidence, USABLE); // T02 moved
      expect(ids(r)).toEqual({ 'T02:1': null, 'T03:1': 'ALI' });
      expect(r.notes).toEqual([note('T02:1', 700, 790, 'ALI', null, 'CLASH', { truckId: 'T03', loadNo: 1 })]);
    }
  });

  it('"moved" is the change of departure; a trip without an evidence load comes last', () => {
    // T02 leaves 10 min later (and comes back 100 min later), T03 leaves 20 min later: T02 moved least.
    const r = planDrivers([trip('T03', 1, 640, 700), trip('T02', 1, 490, 700)], [was('T02', 1, 'ALI', 480, 600), was('T03', 1, 'ALI', 620, 700)], USABLE);
    expect(ids(r)).toEqual({ 'T03:1': null, 'T02:1': 'ALI' });
    // T04 is a new trip (no evidence) listed first, with Ali as its default: T02 (moved 30 min) goes first.
    for (const trips of both([trip('T04', 1, 580, 700, 'ALI'), trip('T02', 1, 600, 690)])) {
      const n = planDrivers(trips, [was('T02', 1, 'ALI', 570, 660)], USABLE);
      expect(ids(n)).toEqual({ 'T04:1': null, 'T02:1': 'ALI' });
      expect(n.notes).toEqual([]); // T04 L1 had no driver before: nothing lost
    }
  });

  it("candidates in order: (a) the trip's own driver, (b) the driver of the truck's nearest trip, (c) the truck's default", () => {
    // (a) beats (b) and (c).
    const own = planDrivers([trip('T02', 1, 480, 600, 'BOB'), trip('T02', 2, 700, 800, 'BOB')], [was('T02', 1, 'SAM', 480, 600), was('T02', 2, 'ALI', 700, 800)], USABLE);
    expect(ids(own)).toEqual({ 'T02:1': 'SAM', 'T02:2': 'ALI' });
    // T03 L1 moved onto T02 L1 (Ali, did not move): (a) Ali is taken, so (b) T03 L2's Bob.
    const evidence = [was('T02', 1, 'ALI', 480, 600), was('T03', 1, 'ALI', 700, 820), was('T03', 2, 'BOB', 900, 1000)];
    const trips = [trip('T03', 1, 520, 640, 'SAM'), trip('T02', 1, 480, 600), trip('T03', 2, 900, 1000)];
    const b = planDrivers(trips, evidence, USABLE);
    expect(ids(b)).toEqual({ 'T03:1': 'BOB', 'T02:1': 'ALI', 'T03:2': 'BOB' });
    expect(b.notes).toEqual([note('T03:1', 520, 640, 'ALI', 'BOB', 'CLASH', { truckId: 'T02', loadNo: 1 })]);
    // (b) is Ali too (busy): (c) the default Sam; no default: no driver.
    const onlyAli = [evidence[0]!, evidence[1]!, was('T03', 2, 'ALI', 900, 1000)];
    expect(ids(planDrivers(trips, onlyAli, USABLE))['T03:1']).toBe('SAM');
    expect(ids(planDrivers([{ ...trips[0]!, defaultDriverId: null }, trips[1]!, trips[2]!], onlyAli, USABLE))['T03:1']).toBeNull();
  });

  it("(b) is the truck's trip nearest in time that has a driver - a frozen one too - and only that one", () => {
    const t03 = [was('T03', 1, 'BOB', 360, 460), was('T03', 3, 'SAM', 900, 1000)];
    const trips = (l2: [number, number]) => [trip('T03', 1, 360, 460), trip('T03', 3, 900, 1000), trip('T03', 2, l2[0], l2[1])];
    expect(ids(planDrivers(trips([500, 600]), t03, USABLE))['T03:2']).toBe('BOB'); // 40 min after L1, 300 before L3
    expect(ids(planDrivers(trips([800, 880]), t03, USABLE))['T03:2']).toBe('SAM'); // 20 min before L3
    // Bob, the nearest, is on another truck at that time (by hand): no driver - not the next trip's Sam.
    const busy = planDrivers([...trips([500, 600]), trip('T05', 1, 500, 600)], [...t03, was('T05', 1, 'BOB', 500, 600, HAND)], USABLE);
    expect(ids(busy)['T03:2']).toBeNull();
    // The driver who took the truck's locked Load 1 gets its new Load 2.
    const locked = planDrivers([trip('T01', 2, 560, 700)], [was('T01', 1, 'ALI', 360, 540, { status: 'LOCKED' })], USABLE);
    expect(ids(locked)).toEqual({ 'T01:2': 'ALI' });
  });

  it('filling a trip that had no driver, or a new trip, is not a note; keeping the same driver is not either', () => {
    const r = planDrivers([trip('T03', 1, 480, 600, 'SAM'), trip('T04', 1, 480, 600, 'BOB'), trip('T02', 1, 480, 600)], [was('T03', 1, null, 480, 600), was('T02', 1, 'ALI', 480, 600)], USABLE);
    expect(ids(r)).toEqual({ 'T03:1': 'SAM', 'T04:1': 'BOB', 'T02:1': 'ALI' });
    expect(r.notes).toEqual([]);
  });

  it('a filled-in driver who is no longer active: the next candidate, and an INACTIVE note', () => {
    const r = planDrivers([trip('T01', 1, 360, 480, 'SAM')], [was('T01', 1, 'OLD', 360, 480)], USABLE);
    expect(ids(r)).toEqual({ 'T01:1': 'SAM' });
    expect(r.notes).toEqual([note('T01:1', 360, 480, 'OLD', 'SAM', 'INACTIVE')]);
  });
});

describe('planDrivers: frozen loads, one truck, trips gone, first optimization', () => {
  it('frozen loads are untouched (never in the result, no note even with an inactive driver); their times take their drivers', () => {
    const evidence = [was('T01', 1, 'ALI', 360, 540, { status: 'LOCKED' }), was('T05', 1, 'OLD', 360, 540, { status: 'DISPATCHED', ...HAND }), was('T02', 1, 'ALI', 570, 660)];
    const r = planDrivers([trip('T02', 1, 480, 660)], evidence, USABLE);
    expect([...r.drivers.keys()]).toEqual(['T02:1']);
    expect(ids(r)).toEqual({ 'T02:1': null });
    expect(r.notes).toEqual([note('T02:1', 480, 660, 'ALI', null, 'CLASH', { truckId: 'T01', loadNo: 1 })]);
  });

  it("trip 1 and trip 2 of one truck share a driver: no clash unless their times really overlap", () => {
    for (const marker of [HAND, {}]) {
      const evidence = [was('T01', 1, 'ALI', 360, 540, marker), was('T01', 2, 'ALI', 560, 700)];
      const touching = [trip('T01', 1, 360, 560), trip('T01', 2, 560, 700)]; // back at 09:20, out again at 09:20
      for (const trips of both(touching)) {
        const r = planDrivers(trips, evidence, USABLE);
        expect(ids(r)).toEqual({ 'T01:1': 'ALI', 'T01:2': 'ALI' });
        expect(r.notes).toEqual([]);
      }
    }
    // Not a valid plan, but the rule is the times: trip 2 (moved) does not get Ali on top of trip 1.
    const overlap = planDrivers([trip('T01', 1, 360, 560), trip('T01', 2, 540, 700)], [was('T01', 1, 'ALI', 360, 540), was('T01', 2, 'ALI', 560, 700)], USABLE);
    expect(ids(overlap)).toEqual({ 'T01:1': 'ALI', 'T01:2': null });
  });

  it('TRIP_GONE: a hand-set driver whose trip the plan does not have is a note; a filled-in driver, "No driver" and a frozen load are not', () => {
    const evidence = [
      was('T02', 1, 'ALI', 480, 600),
      was('T03', 1, 'BOB', 480, 600, HAND),
      was('T02', 2, 'SAM', 620, 740),
      was('T04', 1, null, 480, 600),
      was('T01', 1, 'SAM', 360, 470, { status: 'LOCKED', ...HAND }),
    ];
    for (const usable of [USABLE, new Set(['ALI', 'SAM'])]) {
      const r = planDrivers([trip('T02', 1, 480, 600)], evidence, usable); // Bob inactive or not: still a note
      expect(r.notes).toEqual([{ key: null, truckId: 'T03', loadNo: 1, departMin: 480, returnMin: 600, fromDriverId: 'BOB', toDriverId: null, reason: 'TRIP_GONE', other: null }]);
      expect(Object.keys(r)).toEqual(['drivers', 'notes']); // nothing is kept to bring Bob back
    }
  });

  it('nothing brings a hand-set driver back: the next plan with that trip reads only the loads in use', () => {
    // After the plan without T03, the version's loads are T02 L1 (Ali) and T02 L2 (Ali): T03 L1 gets its default.
    const after = [was('T02', 1, 'ALI', 480, 600), was('T02', 2, 'ALI', 620, 740)];
    const r = planDrivers([trip('T02', 1, 480, 600, 'ALI'), trip('T03', 1, 480, 600, 'SAM')], after, USABLE);
    expect(r.drivers.get('T03:1')).toEqual({ driverId: 'SAM', driverSetById: null, driverSetAt: null });
    expect(r.notes).toEqual([]);
  });

  it("the first optimization of a day (no evidence): the trucks' default drivers in the optimizer's order, never one driver on two overlapping trips", () => {
    const trips = [trip('T02', 1, 570, 660, 'ALI'), trip('T03', 1, 600, 720, 'ALI'), trip('T04', 1, 700, 800, 'ALI'), trip('T05', 1, 600, 700, 'SAM'), trip('T05', 2, 720, 800, 'SAM')];
    const r = planDrivers(trips, [], USABLE);
    expect(ids(r)).toEqual({ 'T02:1': 'ALI', 'T03:1': null, 'T04:1': 'ALI', 'T05:1': 'SAM', 'T05:2': 'SAM' });
    expect([...r.drivers.values()].every((v) => v.driverSetById === null && v.driverSetAt === null)).toBe(true);
    expect(r.notes).toEqual([]);
    // An inactive default driver is left out.
    expect(ids(planDrivers([trip('T02', 1, 570, 660, 'OLD')], [], USABLE))).toEqual({ 'T02:1': null });
  });
});

describe('isDriverKeep: re-sending the driver RouteIQ filled in on a load still at the depot', () => {
  it('only a filled-in driver, re-sent, on a load that has not left', () => {
    expect(isDriverKeep({ status: 'PLANNED', driverId: 'ALI', driverSetAt: null }, 'ALI')).toBe(true);
    expect(isDriverKeep({ status: 'LOCKED', driverId: 'ALI', driverSetAt: null }, 'ALI')).toBe(true);
    expect(isDriverKeep({ status: 'PLANNED', driverId: 'ALI', driverSetAt: AT }, 'ALI')).toBe(false); // already the dispatcher's
    expect(isDriverKeep({ status: 'PLANNED', driverId: 'ALI', driverSetById: 'u1', driverSetAt: null }, 'ALI')).toBe(false);
    expect(isDriverKeep({ status: 'PLANNED', driverId: 'ALI', driverSetAt: null }, 'SAM')).toBe(false); // a change
    expect(isDriverKeep({ status: 'PLANNED', driverId: null, driverSetAt: null }, null)).toBe(false);
    expect(isDriverKeep({ status: 'DISPATCHED', driverId: 'ALI', driverSetAt: null }, 'ALI')).toBe(false); // out: nothing changes
  });
});

describe('driverPickLink: "picked by hand" or Keep next to a driver on the plan screen', () => {
  const statuses: LoadStatusName[] = ['PLANNED', 'LOCKED', 'LOADING', 'DISPATCHED', 'COMPLETED'];

  it('Keep shows exactly when the server takes the re-sent driver as a Keep (isDriverKeep) and the dispatcher can change this load to that active driver', () => {
    for (const status of statuses) {
      for (const driverId of [null, 'ALI']) {
        for (const driverHandSet of [false, true]) {
          for (const editable of [false, true]) {
            for (const driverActive of [false, true]) {
              const got = driverPickLink({ status, driverId, driverHandSet: driverHandSet && driverId !== null }, { editable, driverActive });
              const serverKeeps = isDriverKeep({ status, driverId, driverSetAt: driverHandSet ? new Date() : null }, driverId);
              const label = JSON.stringify({ status, driverId, driverHandSet, editable, driverActive });
              expect(got === 'KEEP', label).toBe(serverKeeps && editable && driverActive);
              expect(got === 'HAND_SET', label).toBe(driverId !== null && driverHandSet && !ON_ROAD.has(status));
            }
          }
        }
      }
    }
  });
});

describe('driverClashes / timesClash', () => {
  const L = (id: string, truckId: string, driverId: string | null, departMin: number, returnMin: number) => ({ id, truckId, driverId, departMin, returnMin });

  it('finds one driver on two trucks at overlapping times only', () => {
    const loads = [L('a', 'A', 'D', 360, 570), L('b', 'B', 'D', 540, 700), L('c', 'A', 'D', 600, 800), L('d', 'C', 'D', 800, 900), L('e', 'C', null, 360, 900)];
    const c = driverClashes(loads);
    expect(c.map((x) => [x.a.id, x.b.id])).toEqual([
      ['a', 'b'],
      ['b', 'c'],
    ]);
    expect(timesClash(loads[2], loads[3])).toBe(false); // back 13:20 = out 13:20 is fine
    expect(timesClash(loads[0], loads[2])).toBe(false); // same truck: consecutive trips
    // The time rule alone (planDrivers): touching is not overlapping, whatever the trucks.
    expect(timesOverlap(loads[2], loads[3])).toBe(false);
    expect(timesOverlap(loads[0], loads[1])).toBe(true);
    expect(timesOverlap({ departMin: 360, returnMin: 560 }, { departMin: 540, returnMin: 700 })).toBe(true);
  });
});

describe('checkDriverChange', () => {
  it('re-sending the current driver is never an error, a change after dispatch is', () => {
    for (const status of ALL) {
      expect(checkDriverChange({ status, driverId: 'D' }, 'D')).toEqual({ ok: true, unchanged: true });
      expect(checkDriverChange({ status, driverId: null }, null)).toEqual({ ok: true, unchanged: true });
      const change = checkDriverChange({ status, driverId: 'D' }, 'E');
      if (ON_ROAD.has(status)) expect(change).toEqual({ ok: false, reason: 'Driver cannot change after dispatch.' });
      else expect(change).toEqual({ ok: true, unchanged: false });
    }
  });
});
