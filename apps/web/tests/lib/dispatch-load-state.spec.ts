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
  ON_ROAD,
  ownDriverEvidence,
  pickLoadDriver,
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

  it("keeps this version's own choice for the trip even if it now overlaps (shown as a warning instead)", () => {
    const now = [on('A', 1, 'D'), on('B', 1, 'D')];
    const got = assignReplanDrivers([trip('A', 1), trip('B', 1)], now, [], [], usable);
    expect([got.get('A:1'), got.get('B:1')]).toEqual(['D', 'D']);
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
