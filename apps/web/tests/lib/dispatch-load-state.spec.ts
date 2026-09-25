/**
 * Load lifecycle: allowed transitions, per-truck ordering (Load 1 before Load 2) and roles.
 */
import { describe, expect, it } from 'vitest';
import { checkTransition, FROZEN, isFrozen, ON_ROAD, pickLoadDriver, type LoadRef, type LoadStatusName } from '@/lib/dispatch/load-state';

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
