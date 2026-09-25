/**
 * Load lifecycle: allowed transitions, per-truck ordering (Load 1 before Load 2) and roles.
 */
import { describe, expect, it } from 'vitest';
import {
  assignReplanDrivers,
  checkDriverChange,
  checkTransition,
  driverClashes,
  FROZEN,
  isFrozen,
  isDriverKeep,
  isHandSetDriver,
  ON_ROAD,
  ownDriverEvidence,
  pickLoadDriver,
  planReplanDrivers,
  timesClash,
  type LoadRef,
  type LoadStatusName,
  type ReplanLoad,
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

describe('pickLoadDriver - drivers stay with their truck across re-plans', () => {
  const usable = new Set(['A', 'B', 'C']);
  const loads = [
    { truckId: 't1', loadNo: 1, driverId: 'A' },
    { truckId: 't1', loadNo: 3, driverId: 'C' },
    { truckId: 't2', loadNo: 1, driverId: 'B' },
    { truckId: 't2', loadNo: 2, driverId: null },
  ];

  it('takes the same trip first, else the nearest trip of the same truck (earlier on a tie)', () => {
    expect(pickLoadDriver(loads, 't1', 1, usable)).toBe('A');
    expect(pickLoadDriver(loads, 't1', 3, usable)).toBe('C');
    expect(pickLoadDriver(loads, 't1', 2, usable)).toBe('A'); // Load 1 and 3 equally near
    expect(pickLoadDriver(loads, 't1', 4, usable)).toBe('C');
    expect(pickLoadDriver(loads, 't2', 2, usable)).toBe('B'); // Load 2 had none: Load 1's driver
  });

  it('never picks another truck, an inactive driver or nobody', () => {
    expect(pickLoadDriver(loads, 't3', 1, usable)).toBeNull();
    expect(pickLoadDriver(loads, 't1', 1, new Set(['C']))).toBe('C');
    expect(pickLoadDriver(loads, 't2', 1, new Set(['A']))).toBeNull();
    expect(pickLoadDriver([], 't1', 1, usable)).toBeNull();
  });
});

describe('pickLoadDriver with exactOnly', () => {
  it('takes only the same trip', () => {
    const loads = [{ truckId: 't1', loadNo: 1, driverId: 'A' }];
    expect(pickLoadDriver(loads, 't1', 2, new Set(['A']), { exactOnly: true })).toBeNull();
    expect(pickLoadDriver(loads, 't1', 1, new Set(['A']), { exactOnly: true })).toBe('A');
  });
});

describe('assignReplanDrivers - drivers across re-plans', () => {
  const usable = new Set(['D', 'E', 'F']);
  // Trip k of a truck: out 06:00 + 4 h per trip, back 3.5 h later.
  const trip = (truckId: string, loadNo: number, defaultDriverId: string | null = null, shiftMin = 0): ReplanLoad => ({
    key: `${truckId}:${loadNo}`,
    truckId,
    loadNo,
    departMin: 360 + (loadNo - 1) * 240 + shiftMin,
    returnMin: 360 + (loadNo - 1) * 240 + shiftMin + 210,
    defaultDriverId,
  });
  const kept = (l: ReplanLoad, driverId: string | null) => ({ truckId: l.truckId, driverId, departMin: l.departMin, returnMin: l.returnMin });
  const on = (truckId: string, loadNo: number, driverId: string | null) => ({ truckId, loadNo, driverId });

  it('the same trip in the parent version beats another trip of this version (late order after trip 1 was locked)', () => {
    // v1: trip 1 locked with D, trip 2 given to E by hand. v2 carries only trip 1.
    const now = [on('A', 1, 'D')];
    const parent = [on('A', 1, 'D'), on('A', 2, 'E')];
    const got = assignReplanDrivers([trip('A', 2, 'D'), trip('A', 3, 'D')], now, parent, [kept(trip('A', 1), 'D')], usable);
    expect(got.get('A:2')).toBe('E');
    // A new trip 3 follows the nearest trip of either version (trip 2: E), not the carried trip 1.
    expect(got.get('A:3')).toBe('E');
  });

  it('this version wins for the same trip, and its nearest trip for a new one', () => {
    const now = [on('A', 1, 'F'), on('A', 2, 'D')];
    const parent = [on('A', 1, 'E'), on('A', 2, 'E'), on('A', 3, 'E')];
    const got = assignReplanDrivers([trip('A', 1), trip('A', 2), trip('A', 3)], now, parent, [], usable);
    expect([got.get('A:1'), got.get('A:2'), got.get('A:3')]).toEqual(['F', 'D', 'E']);
    // "Use instead" on the same version (no parent): the nearest trip of this version.
    const same = assignReplanDrivers([trip('A', 1), trip('A', 2), trip('A', 3)], now, [], [], usable);
    expect([same.get('A:1'), same.get('A:2'), same.get('A:3')]).toEqual(['F', 'D', 'D']);
  });

  it('never guesses one driver onto two trucks at the same time', () => {
    // Truck A (default D) was not used in v1; the dispatcher put D on truck B. v2 uses both.
    const parent = [on('B', 1, 'D')];
    const got = assignReplanDrivers([trip('A', 1, 'D'), trip('B', 1, null, 15)], [], parent, [], usable);
    expect(got.get('B:1')).toBe('D'); // stronger evidence (B's own trip) wins, whatever the order of the loads
    expect(got.get('A:1')).toBeNull(); // left for the dispatcher, not a second sheet for D
    // Two trucks with the same default driver: only one of them gets D while their times overlap...
    const shared = assignReplanDrivers([trip('A', 1, 'D'), trip('B', 1, 'D', 30)], [], [], [], usable);
    expect([shared.get('A:1'), shared.get('B:1')].filter(Boolean)).toEqual(['D']);
    // ...and both when they do not (A back 09:30, B out 10:00).
    const later = assignReplanDrivers([trip('A', 1, 'D'), trip('B', 2, 'D')], [], [], [], usable);
    expect([later.get('A:1'), later.get('B:2')]).toEqual(['D', 'D']);
    // The same driver on consecutive trips of one truck is normal.
    const own = assignReplanDrivers([trip('A', 1, 'D'), trip('A', 2, 'D')], [], [], [], usable);
    expect([own.get('A:1'), own.get('A:2')]).toEqual(['D', 'D']);
  });

  it('counts kept (frozen) loads of other trucks as busy', () => {
    const lockedC = kept(trip('C', 1), 'D'); // 06:00-09:30 on truck C
    const got = assignReplanDrivers([trip('A', 1, 'D', 60), trip('A', 2, 'D', 60)], [on('C', 1, 'D')], [], [lockedC], usable);
    expect(got.get('A:1')).toBeNull(); // 07:00-10:30 overlaps truck C
    expect(got.get('A:2')).toBe('D'); // 11:00-14:30 does not
  });

  it("keeps a clash the dispatcher made by hand (a plan warning); two drivers RouteIQ filled in: the trip that moved loses", () => {
    const at = (l: ReplanLoad) => ({ departMin: l.departMin, returnMin: l.returnMin });
    const byHand = { driverSetById: 'u1', driverSetAt: new Date('2026-09-26T05:00:00Z') };
    // The dispatcher put D on B:1 by hand while D was on A:1 at the same hours (warned, kept).
    const now = [{ ...on('A', 1, 'D'), ...at(trip('A', 1)) }, { ...on('B', 1, 'D'), ...at(trip('B', 1, null, 30)), ...byHand }];
    const got = assignReplanDrivers([trip('A', 1), trip('B', 1, null, 15)], now, [], [], usable);
    expect([got.get('A:1'), got.get('B:1')]).toEqual(['D', 'D']);
    // Both filled in by RouteIQ (no hand-set marker): B:1 moved (by 30 min), so B:1 loses D.
    const filled = now.map((l) => ({ truckId: l.truckId, loadNo: l.loadNo, driverId: l.driverId, departMin: l.departMin, returnMin: l.returnMin }));
    const auto = assignReplanDrivers([trip('A', 1), trip('B', 1, null, 15)], filled, [], [], usable);
    expect([auto.get('A:1'), auto.get('B:1')]).toEqual(['D', null]);
  });

  describe('"Use instead" re-times a trip onto the hours of another trip of its driver (third review of PR3)', () => {
    // The re-plan job applied RECOMMENDED: from the parent it gave Ali T02 L1 09:30-11:00 and T03 L1
    // 12:00-14:00 (no clash at those times). Both are this version's loads now, so "Use instead"
    // reads them as this version's drivers (step 1); MIN_COST moves T03 L1 to 10:00-12:00.
    const load = (truckId: string, departMin: number, returnMin: number, defaultDriverId: string | null = null): ReplanLoad => ({
      key: `${truckId}:1`,
      truckId,
      loadNo: 1,
      departMin,
      returnMin,
      defaultDriverId,
    });
    const job = [
      { truckId: 'T02', loadNo: 1, driverId: 'ALI', departMin: 570, returnMin: 660 },
      { truckId: 'T03', loadNo: 1, driverId: 'ALI', departMin: 720, returnMin: 840 },
    ];
    const withDrivers = (loads: ReplanLoad[], got: Map<string, string | null>) =>
      loads.map((l) => ({ id: l.key, truckId: l.truckId, departMin: l.departMin, returnMin: l.returnMin, driverId: got.get(l.key) ?? null }));

    it('the trip that moved loses the driver, whatever the order of the loads; no driver clash', () => {
      const useInstead = [load('T02', 570, 660), load('T03', 600, 720)];
      for (const loads of [useInstead, [...useInstead].reverse()]) {
        const got = assignReplanDrivers(loads, job, [], [], new Set(['ALI']));
        expect(Object.fromEntries(got)).toEqual({ 'T02:1': 'ALI', 'T03:1': null });
        expect(driverClashes(withDrivers(loads, got))).toHaveLength(0);
      }
    });

    it("the moved trip gets the truck's default driver when that one is free", () => {
      const loads = [load('T03', 600, 720, 'SAM'), load('T02', 570, 660)];
      const got = assignReplanDrivers(loads, job, [], [], new Set(['ALI', 'SAM']));
      expect(Object.fromEntries(got)).toEqual({ 'T02:1': 'ALI', 'T03:1': 'SAM' });
    });

    it('trips that do not overlap after the re-time keep their driver', () => {
      const loads = [load('T02', 570, 660), load('T03', 690, 810)];
      const got = assignReplanDrivers(loads, job, [], [], new Set(['ALI']));
      expect(Object.fromEntries(got)).toEqual({ 'T02:1': 'ALI', 'T03:1': 'ALI' });
    });
  });

  describe('copy-forward re-plans (review: untouched copies are the parent\'s evidence, checked for clashes)', () => {
    // A re-plan copies every load of the parent into the new version (copy-forward), PLANNED ones
    // too, with their drivers. Those copies must not count as this version's own choice.
    const copy = (id: string, truckId: string, loadNo: number, driverId: string | null, status = 'PLANNED', from: string | null = `p-${truckId}${loadNo}`) => ({
      id,
      truckId,
      loadNo,
      driverId,
      status,
      carriedFromLoadId: from,
    });
    const parentLoad = (truckId: string, loadNo: number, driverId: string | null) => ({ id: `p-${truckId}${loadNo}`, truckId, loadNo, driverId });

    it("the reviewer's case: D1 on A:1 and B:1 in v2, the late-order re-plan re-times them to overlap - D1 is not given both", () => {
      const parent = [parentLoad('A', 1, 'D1'), parentLoad('B', 1, 'D1')];
      const copies = [copy('c1', 'A', 1, 'D1'), copy('c2', 'B', 1, 'D1')];
      const newLoads: ReplanLoad[] = [
        { key: 'A:1', truckId: 'A', loadNo: 1, departMin: 360, returnMin: 580, defaultDriverId: null },
        { key: 'B:1', truckId: 'B', loadNo: 1, departMin: 540, returnMin: 720, defaultDriverId: 'D9' },
      ];
      const now = ownDriverEvidence(copies, parent);
      expect(now).toEqual([]);
      const got = assignReplanDrivers(newLoads, now, parent, [], new Set(['D1', 'D9']));
      expect(Object.fromEntries(got)).toEqual({ 'A:1': 'D1', 'B:1': 'D9' });
      const clashes = driverClashes(newLoads.map((l) => ({ id: l.key, truckId: l.truckId, departMin: l.departMin, returnMin: l.returnMin, driverId: got.get(l.key) ?? null })));
      expect(clashes).toHaveLength(0);
    });

    it('a PLANNED copy re-timed to clash with a kept LOCKED load of the same driver does not get that driver', () => {
      // T01 L1 Ali 06:00-09:00 stays LOCKED; T02 L1 (Ali, 09:30-11:00 in v1) is re-timed 08:00-11:00.
      const parent = [parentLoad('T01', 1, 'ALI'), parentLoad('T02', 1, 'ALI')];
      const copies = [copy('c1', 'T01', 1, 'ALI', 'LOCKED'), copy('c2', 'T02', 1, 'ALI')];
      const kept = [{ truckId: 'T01', driverId: 'ALI', departMin: 360, returnMin: 540 }];
      const now = ownDriverEvidence(copies, parent);
      expect(now.map((l) => l.id)).toEqual(['c1']); // the frozen copy still counts
      const got = assignReplanDrivers([{ key: 'T02:1', truckId: 'T02', loadNo: 1, departMin: 480, returnMin: 660, defaultDriverId: null }], now, parent, kept, new Set(['ALI']));
      expect(got.get('T02:1')).toBeNull(); // left for the dispatcher instead of a second sheet for Ali
    });

    it('"Use instead" after the re-plan re-times a trip onto a kept LOCKED load of its driver: that load gets no driver', () => {
      // v1: T01 L1 Ali 06:00-09:00 LOCKED, T02 L1 Ali 09:30-11:00 PLANNED. Re-plan to v2 (copies).
      const parent = [parentLoad('T01', 1, 'ALI'), parentLoad('T02', 1, 'ALI')];
      const kept = [{ truckId: 'T01', driverId: 'ALI', departMin: 360, returnMin: 540 }];
      const usableAli = new Set(['ALI']);
      const t02 = (departMin: number): ReplanLoad => ({ key: 'T02:1', truckId: 'T02', loadNo: 1, departMin, returnMin: 660, defaultDriverId: null });
      // 1. The job applies RECOMMENDED, which keeps T02 L1 at 09:30: Ali from the parent (no clash).
      const job = assignReplanDrivers([t02(570)], ownDriverEvidence([copy('c1', 'T01', 1, 'ALI', 'LOCKED'), copy('c2', 'T02', 1, 'ALI')], parent), parent, kept, usableAli);
      expect(job.get('T02:1')).toBe('ALI');
      // 2. "Use instead" MIN_COST moves T02 L1 to 08:00, while Ali's LOCKED T01 load is out until 09:00.
      //    The job's new load (not a copy) is this version's own evidence (step 1) - still no second sheet.
      const versionLoads = [copy('c1', 'T01', 1, 'ALI', 'LOCKED'), copy('n1', 'T02', 1, 'ALI', 'PLANNED', null)];
      const useInstead = assignReplanDrivers([t02(480)], ownDriverEvidence(versionLoads, parent), parent, kept, usableAli);
      expect(useInstead.get('T02:1')).toBeNull();
      const all = [
        { id: 'c1', ...kept[0]! },
        { id: 'T02:1', truckId: 'T02', departMin: 480, returnMin: 660, driverId: useInstead.get('T02:1') ?? null },
      ];
      expect(driverClashes(all)).toHaveLength(0);
      // The truck's default driver still fills it when free.
      const withDefault = assignReplanDrivers([{ ...t02(480), defaultDriverId: 'SAM' }], ownDriverEvidence(versionLoads, parent), parent, kept, new Set(['ALI', 'SAM']));
      expect(withDefault.get('T02:1')).toBe('SAM');
    });

    it('a driver the dispatcher changed on a copy (after a failed re-plan) is this version\'s own choice', () => {
      const parent = [parentLoad('A', 1, 'D1')];
      const copies = [copy('c1', 'A', 1, 'D2')];
      expect(ownDriverEvidence(copies, parent).map((l) => l.id)).toEqual(['c1']);
      // New PLANNED loads of an applied optimization have no carriedFromLoadId: they always count.
      expect(ownDriverEvidence([copy('n1', 'A', 1, 'D1', 'PLANNED', null)], parent).map((l) => l.id)).toEqual(['n1']);
    });
  });

  it('skips inactive drivers, and "No driver" falls back to the next source', () => {
    const got = assignReplanDrivers([trip('A', 1, 'D'), trip('B', 1, 'X', 300)], [on('A', 1, null), on('B', 1, 'X')], [], [], usable);
    expect(got.get('A:1')).toBe('D'); // "No driver" is not kept: the truck default comes back
    expect(got.get('B:1')).toBeNull(); // X is not active
  });
});

describe('hand-set drivers and the trip that moved (fourth review of PR3)', () => {
  // T02's default driver is Ali, T03's is Sam. Minutes: 570 = 09:30, 600 = 10:00, 720 = 12:00.
  const at = new Date('2026-09-26T05:00:00Z');
  const byHand = { driverSetById: 'u1', driverSetAt: at };
  const trip = (truckId: string, departMin: number, returnMin: number, defaultDriverId: string | null = null, loadNo = 1): ReplanLoad => ({
    key: `${truckId}:${loadNo}`,
    truckId,
    loadNo,
    departMin,
    returnMin,
    defaultDriverId,
  });
  const had = (truckId: string, driverId: string | null, departMin: number, returnMin: number, extra: object = {}, loadNo = 1) => ({ truckId, loadNo, driverId, departMin, returnMin, ...extra });
  const clashesOf = (loads: ReplanLoad[], got: Map<string, string | null>, kept: { truckId: string; driverId: string | null; departMin: number; returnMin: number }[] = []) =>
    driverClashes([
      ...loads.map((l) => ({ id: l.key, truckId: l.truckId, departMin: l.departMin, returnMin: l.returnMin, driverId: got.get(l.key) ?? null })),
      ...kept.map((k, i) => ({ id: `kept${i}`, ...k })),
    ]);
  const both = <T,>(list: T[]) => [list, [...list].reverse()];
  const usable = new Set(['ALI', 'SAM']);

  describe('D1: a re-plan moves a trip onto the hours of a trip the dispatcher gave the same driver by hand', () => {
    // v1: T02 L1 Ali (its default, filled in) 12:00-14:00; T03 L1 Ali set by hand 09:30-11:00.
    // The re-plan moves T02 L1 to 10:00-12:00; T03 L1 does not move.
    const evidence = [had('T02', 'ALI', 720, 840), had('T03', 'ALI', 570, 660, byHand)];
    const newLoads = [trip('T02', 600, 720, 'ALI'), trip('T03', 570, 660, 'SAM')];

    it('the re-plan job (parent evidence) keeps the hand-set Ali on T03, whatever the order of the loads; the overlap is the yellow warning', () => {
      for (const loads of both(newLoads)) {
        const r = planReplanDrivers(loads, [], evidence, [], usable);
        expect(r.drivers.get('T03:1')).toEqual({ driverId: 'ALI', driverSetById: 'u1', driverSetAt: at }); // carried with its marker
        expect(r.drivers.get('T02:1')).toEqual({ driverId: 'ALI', driverSetById: null, driverSetAt: null }); // its own trip's driver, filled in
        expect(clashesOf(loads, assignReplanDrivers(loads, [], evidence, [], usable))).toHaveLength(1);
        expect(r.changes).toEqual([]);
      }
    });

    it('"Use instead" (this version\'s evidence) gives the same answer for the same trips', () => {
      for (const loads of both(newLoads)) {
        expect(Object.fromEntries(assignReplanDrivers(loads, evidence, [], [], usable))).toEqual({ 'T02:1': 'ALI', 'T03:1': 'ALI' });
        expect(Object.fromEntries(assignReplanDrivers(loads, [], evidence, [], usable))).toEqual({ 'T02:1': 'ALI', 'T03:1': 'ALI' });
      }
    });

    it('both drivers filled in by RouteIQ: the trip that moved (T02) loses Ali, in the job and in "Use instead", whatever the order', () => {
      const filled = [had('T02', 'ALI', 720, 840), had('T03', 'ALI', 570, 660)];
      for (const loads of both(newLoads)) {
        for (const [now, parent] of [[[], filled], [filled, []]] as const) {
          const r = planReplanDrivers(loads, [...now], [...parent], [], usable);
          expect(r.drivers.get('T03:1')!.driverId).toBe('ALI');
          expect(r.drivers.get('T02:1')!.driverId).toBeNull(); // Ali is T02's default too: still on T03
          expect(r.changes).toEqual([{ key: 'T02:1', truckId: 'T02', loadNo: 1, fromDriverId: 'ALI', toDriverId: null, reason: 'OTHER_TRIP', other: { truckId: 'T03', loadNo: 1 } }]);
        }
      }
    });
  });

  describe('D2: "Use instead" re-times the trip the dispatcher gave a driver by hand onto another trip of that driver', () => {
    // Version R: T02 L1 Ali (default, filled in) 09:30-11:00; T03 L1 Ali set by hand 12:00-14:00.
    // MIN_COST moves T03 L1 to 10:00-12:00.
    const now = [had('T02', 'ALI', 570, 660), had('T03', 'ALI', 720, 840, byHand)];

    it('the hand-set Ali stays on T03 (with its marker) and T02 keeps Ali: the overlap shows as the yellow warning, as before 1740cb3', () => {
      for (const loads of both([trip('T02', 570, 660, 'ALI'), trip('T03', 600, 720, 'SAM')])) {
        const r = planReplanDrivers(loads, now, [], [], usable);
        expect(r.drivers.get('T03:1')).toEqual({ driverId: 'ALI', driverSetById: 'u1', driverSetAt: at });
        expect(r.drivers.get('T02:1')!.driverId).toBe('ALI');
        expect(clashesOf(loads, assignReplanDrivers(loads, now, [], [], usable))).toHaveLength(1);
        expect(r.changes).toEqual([]);
      }
    });

    it('switching back to the first option restores the plan: Ali on both, still hand-set on T03, no clash', () => {
      const afterUseInstead = [had('T02', 'ALI', 570, 660), had('T03', 'ALI', 600, 720, byHand)];
      const loads = [trip('T02', 570, 660, 'ALI'), trip('T03', 720, 840, 'SAM')];
      const r = planReplanDrivers(loads, afterUseInstead, [], [], usable);
      expect(r.drivers.get('T03:1')).toEqual({ driverId: 'ALI', driverSetById: 'u1', driverSetAt: at });
      expect(r.drivers.get('T02:1')!.driverId).toBe('ALI');
      expect(clashesOf(loads, assignReplanDrivers(loads, afterUseInstead, [], [], usable))).toHaveLength(0);
    });
  });

  it('a hand-set driver on a planned trip that now overlaps their kept (locked) load stays, with the warning; a filled-in one does not', () => {
    const kept = [{ truckId: 'T01', loadNo: 1, driverId: 'ALI', departMin: 360, returnMin: 540 }];
    const loads = [trip('T02', 480, 660)];
    const hand = planReplanDrivers(loads, [had('T02', 'ALI', 570, 660, byHand)], [], kept, usable);
    expect(hand.drivers.get('T02:1')).toEqual({ driverId: 'ALI', driverSetById: 'u1', driverSetAt: at });
    expect(clashesOf(loads, new Map([['T02:1', 'ALI']]), kept)).toHaveLength(1);
    const auto = planReplanDrivers(loads, [had('T02', 'ALI', 570, 660)], [], kept, usable);
    expect(auto.drivers.get('T02:1')!.driverId).toBeNull();
    expect(auto.changes).toEqual([{ key: 'T02:1', truckId: 'T02', loadNo: 1, fromDriverId: 'ALI', toDriverId: null, reason: 'KEPT_LOAD', other: { truckId: 'T01', loadNo: 1 } }]);
  });

  it('two trips the dispatcher gave the same driver by hand both keep it', () => {
    const now = [had('T02', 'ALI', 570, 660, byHand), had('T03', 'ALI', 720, 840, byHand)];
    const got = assignReplanDrivers([trip('T02', 600, 720), trip('T03', 630, 750)], now, [], [], usable);
    expect(Object.fromEntries(got)).toEqual({ 'T02:1': 'ALI', 'T03:1': 'ALI' });
  });

  it('a guess (nearest trip, default driver) never overlaps a trip the dispatcher gave that driver by hand', () => {
    // T04 is a new trip (no evidence); its default driver Ali is on T03 by hand at the same hours.
    const r = planReplanDrivers([trip('T03', 570, 660), trip('T04', 600, 720, 'ALI')], [had('T03', 'ALI', 570, 660, byHand)], [], [], usable);
    expect(r.drivers.get('T03:1')!.driverId).toBe('ALI');
    expect(r.drivers.get('T04:1')!.driverId).toBeNull();
    expect(r.changes).toEqual([]); // T04 L1 is a new trip: nothing to compare with
  });

  it("a truck's trip 1 and trip 2 with the same driver are not a clash with itself", () => {
    const now = [had('T01', 'ALI', 360, 540, byHand, 1), had('T01', 'ALI', 560, 700, {}, 2)];
    const loads = [trip('T01', 360, 560, null, 1), trip('T01', 540, 700, null, 2)]; // re-timed to touch
    const got = assignReplanDrivers(loads, now, [], [], usable);
    expect(Object.fromEntries(got)).toEqual({ 'T01:1': 'ALI', 'T01:2': 'ALI' });
    expect(clashesOf(loads, got)).toHaveLength(0);
  });

  it('the first optimization of a day is unaffected: default drivers, in the optimizer\'s order, no marker, no change', () => {
    const loads = [trip('T02', 570, 660, 'ALI'), trip('T03', 600, 720, 'ALI'), trip('T04', 700, 800, 'ALI'), trip('T05', 600, 700, 'SAM')];
    const r = planReplanDrivers(loads, [], [], [], usable);
    expect(Object.fromEntries([...r.drivers].map(([k, v]) => [k, v.driverId]))).toEqual({ 'T02:1': 'ALI', 'T03:1': null, 'T04:1': 'ALI', 'T05:1': 'SAM' });
    expect([...r.drivers.values()].every((v) => v.driverSetAt === null && v.driverSetById === null)).toBe(true);
    expect(r.changes).toEqual([]);
  });

  it('reports every trip whose driver changed, and why', () => {
    const now = [had('T01', 'OLD', 360, 480), had('T02', null, 360, 480), had('T03', 'ALI', 360, 480)];
    const r = planReplanDrivers(
      [trip('T01', 360, 480, 'SAM'), trip('T02', 360, 480), trip('T03', 360, 480)],
      now,
      [had('T02', 'ALI', 360, 480)],
      [],
      usable,
    );
    // OLD is inactive: T01's default Sam; T02 had "No driver": the parent's Ali, but Ali is on T03 at that time.
    expect(r.changes).toEqual([{ key: 'T01:1', truckId: 'T01', loadNo: 1, fromDriverId: 'OLD', toDriverId: 'SAM', reason: 'INACTIVE', other: null }]);
    const filled = planReplanDrivers([trip('T02', 360, 480, 'SAM')], [had('T02', null, 360, 480)], [], [], usable);
    expect(filled.changes).toEqual([{ key: 'T02:1', truckId: 'T02', loadNo: 1, fromDriverId: null, toDriverId: 'SAM', reason: 'FILLED', other: null }]);
  });

  it('ownDriverEvidence: an untouched copy (same driver and marker as the parent) is parent evidence; a driver set again by hand on this version counts', () => {
    const parent = [{ id: 'p1', ...had('A', 'D1', 360, 480, byHand) }];
    const copy = { id: 'c1', status: 'PLANNED', carriedFromLoadId: 'p1', ...had('A', 'D1', 360, 480, byHand) };
    expect(ownDriverEvidence([copy], parent)).toEqual([]);
    const again = { ...copy, driverSetAt: new Date('2026-09-26T06:00:00Z') };
    expect(ownDriverEvidence([again], parent).map((l) => l.id)).toEqual(['c1']);
    expect(isHandSetDriver(again)).toBe(true);
    expect(isHandSetDriver({ driverId: null, driverSetAt: at })).toBe(false);
  });
});

describe('hand-set drivers whose trip is not in the plan; moved-least in every step (fifth review of PR3)', () => {
  // T02's default driver is Ali, T03's is Sam. Minutes: 480 = 08:00, 600 = 10:00, 620 = 10:20, 740 = 12:20.
  const at = new Date('2026-09-26T05:00:00Z');
  const byHand = { driverSetById: 'u1', driverSetAt: at };
  const trip = (truckId: string, departMin: number, returnMin: number, defaultDriverId: string | null = null, loadNo = 1): ReplanLoad => ({
    key: `${truckId}:${loadNo}`,
    truckId,
    loadNo,
    departMin,
    returnMin,
    defaultDriverId,
  });
  const had = (truckId: string, driverId: string | null, departMin: number, returnMin: number, extra: object = {}, loadNo = 1) => ({ truckId, loadNo, driverId, departMin, returnMin, ...extra });
  const both = <T,>(list: T[]) => [list, [...list].reverse()];
  const usable = new Set(['ALI', 'SAM', 'BOB']);
  const ids = (m: Map<string, { driverId: string | null }>) => Object.fromEntries([...m].map(([k, v]) => [k, v.driverId]));
  const bobParked = { truckId: 'T03', loadNo: 1, driverId: 'BOB', departMin: 480, returnMin: 600, driverSetById: 'u1', driverSetAt: at };

  describe('"Use instead" to an option without the truck and trip of a hand-set driver, then back', () => {
    // RECOMMENDED: T02 L1 Ali (filled in) 08:00-10:00, T03 L1 Bob by hand 08:00-10:00.
    // MIN_TRUCKS: T02 L1 08:00-10:00 and T02 L2 10:20-12:20; T03 is not used.
    const rec = [had('T02', 'ALI', 480, 600), had('T03', 'BOB', 480, 600, byHand)];
    const minTrucks = [trip('T02', 480, 600, 'ALI'), trip('T02', 620, 740, 'ALI', 2)];

    it('the hand-set choice is parked (returned, never dropped), whatever the order of the loads', () => {
      for (const loads of both(minTrucks)) {
        const r = planReplanDrivers(loads, rec, [], [], usable);
        expect(ids(r.drivers)).toEqual({ 'T02:1': 'ALI', 'T02:2': 'ALI' });
        expect(r.parked).toEqual([bobParked]);
        expect(r.changes).toEqual([]);
      }
    });

    it('switching back gives Bob back on T03 L1 with the marker; nothing is parked any more', () => {
      const afterMinTrucks = [had('T02', 'ALI', 480, 600), had('T02', 'ALI', 620, 740, {}, 2)];
      for (const loads of both([trip('T02', 480, 600, 'ALI'), trip('T03', 480, 600, 'SAM')])) {
        const r = planReplanDrivers(loads, afterMinTrucks, [], [], usable, [bobParked]);
        expect(r.drivers.get('T03:1')).toEqual({ driverId: 'BOB', driverSetById: 'u1', driverSetAt: at });
        expect(r.drivers.get('T02:1')!.driverId).toBe('ALI');
        expect(r.parked).toEqual([]);
        expect(r.changes).toEqual([]);
        // Without the parked choice, T03 L1 would get Sam (its default) with no note.
        expect(planReplanDrivers(loads, afterMinTrucks, [], [], usable).drivers.get('T03:1')!.driverId).toBe('SAM');
      }
    });

    it('an option that keeps T03 but only one trip parks the hand-set choice of its trip 2', () => {
      const now = [had('T03', 'SAM', 360, 470), had('T03', 'BOB', 480, 600, byHand, 2)];
      const r = planReplanDrivers([trip('T03', 360, 600, 'SAM')], now, [], [], usable);
      expect(r.parked).toEqual([{ ...bobParked, loadNo: 2 }]);
    });

    it('the re-plan job parks the parent\'s hand-set choice too; a trip still there as a kept load is not parked', () => {
      const r = planReplanDrivers(minTrucks, [], rec, [], usable);
      expect(r.parked).toEqual([bobParked]);
      const kept = [{ truckId: 'T03', loadNo: 1, driverId: 'BOB', departMin: 480, returnMin: 600 }];
      expect(planReplanDrivers(minTrucks, [{ ...rec[1] }], rec, kept, usable).parked).toEqual([]);
    });

    it('this version\'s own trip beats a parked choice for the same truck and trip', () => {
      const r = planReplanDrivers([trip('T03', 480, 600, 'SAM')], [had('T03', null, 480, 600)], [], [], usable, [bobParked]);
      expect(r.drivers.get('T03:1')!.driverId).toBe('SAM'); // "No driver" on this version: the next source decides
      expect(r.parked).toEqual([]);
    });

    it('a parked driver who is no longer active: RouteIQ\'s pick and an INACTIVE change when the trip is back', () => {
      const r = planReplanDrivers([trip('T03', 480, 600, 'SAM')], [], [], [], new Set(['SAM']), [bobParked]);
      expect(r.drivers.get('T03:1')).toEqual({ driverId: 'SAM', driverSetById: null, driverSetAt: null });
      expect(r.changes).toEqual([{ key: 'T03:1', truckId: 'T03', loadNo: 1, fromDriverId: 'BOB', toDriverId: 'SAM', reason: 'INACTIVE', other: null }]);
    });
  });

  it('a hand-set driver who is no longer active is replaced by RouteIQ\'s pick, without the marker, with an INACTIVE change', () => {
    const r = planReplanDrivers([trip('T03', 480, 600, 'SAM')], [had('T03', 'BOB', 480, 600, byHand)], [], [], new Set(['ALI', 'SAM']));
    expect(r.drivers.get('T03:1')).toEqual({ driverId: 'SAM', driverSetById: null, driverSetAt: null });
    expect(r.changes).toEqual([{ key: 'T03:1', truckId: 'T03', loadNo: 1, fromDriverId: 'BOB', toDriverId: 'SAM', reason: 'INACTIVE', other: null }]);
    expect(r.parked).toEqual([]);
  });

  describe('steps 3 and 4 also take the trips that moved least first, in the job and in "Use instead"', () => {
    it('step 4 (default driver): T02 L1 did not move, T03 L1 moved onto it; both trips had no driver - T02 gets Ali', () => {
      // T02 and T03 both have default Ali. T02 L1 stays 08:00-10:00; T03 L1 moves from 12:00-14:00 to 09:00-11:00.
      const before = [had('T02', null, 480, 600), had('T03', null, 720, 840)];
      for (const loads of both([trip('T02', 480, 600, 'ALI'), trip('T03', 540, 660, 'ALI')])) {
        for (const [now, parent] of [[before, []], [[], before]] as const) {
          const r = planReplanDrivers(loads, [...now], [...parent], [], usable);
          expect(ids(r.drivers)).toEqual({ 'T02:1': 'ALI', 'T03:1': null });
        }
      }
    });

    it('step 3 (nearest trip): T02 L1 did not move, T03 L1 moved onto it; each truck\'s trip 2 has Ali - T02 L1 gets Ali', () => {
      // Trip 2 of each truck keeps Ali (step 1 / 2); trip 1 of each had no driver: step 3 guesses Ali from trip 2.
      const before = [had('T02', null, 480, 600), had('T03', null, 720, 840), had('T02', 'ALI', 840, 900, {}, 2), had('T03', 'ALI', 960, 1020, {}, 2)];
      const loads = [trip('T02', 480, 600, null), trip('T03', 540, 660, null), trip('T02', 840, 900, null, 2), trip('T03', 960, 1020, null, 2)];
      for (const list of both(loads)) {
        for (const [now, parent] of [[before, []], [[], before]] as const) {
          const r = planReplanDrivers(list, [...now], [...parent], [], usable);
          expect(ids(r.drivers)).toEqual({ 'T02:1': 'ALI', 'T03:1': null, 'T02:2': 'ALI', 'T03:2': 'ALI' });
        }
      }
    });
  });

  it('isDriverKeep: re-sending the driver RouteIQ filled in on a load still at the depot', () => {
    expect(isDriverKeep({ status: 'PLANNED', driverId: 'ALI', driverSetAt: null }, 'ALI')).toBe(true);
    expect(isDriverKeep({ status: 'LOCKED', driverId: 'ALI', driverSetAt: null }, 'ALI')).toBe(true);
    expect(isDriverKeep({ status: 'PLANNED', driverId: 'ALI', driverSetAt: at }, 'ALI')).toBe(false); // already the dispatcher's
    expect(isDriverKeep({ status: 'PLANNED', driverId: 'ALI', driverSetAt: null }, 'SAM')).toBe(false); // a change
    expect(isDriverKeep({ status: 'PLANNED', driverId: null, driverSetAt: null }, null)).toBe(false);
    expect(isDriverKeep({ status: 'DISPATCHED', driverId: 'ALI', driverSetAt: null }, 'ALI')).toBe(false); // out: nothing changes
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
