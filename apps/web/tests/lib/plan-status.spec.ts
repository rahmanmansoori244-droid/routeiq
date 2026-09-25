/**
 * Stabilization PR3 - the shared plan status rules (lib/dispatch/plan-status.ts), the load changes
 * a version without an applied plan allows (load-state.ts) and the version copy helper
 * (prisma-copy.ts).
 */
import { Prisma } from '@prisma/client';
import { describe, expect, it } from 'vitest';
import { canStepBack, isCarriedFrozen, scenariolessTransitionAllowed, type LoadStatusName } from '@/lib/dispatch/load-state';
import { noPlanApplied } from '@/lib/dispatch/plan-service';
import { nothingToPlan } from '@/lib/dispatch/start-optimize';
import { appliedPlanStatus, isSupersededRun, nothingToReplan } from '@/lib/dispatch/plan-status';
import { copyRowData, jsonFieldsOf } from '@/lib/dispatch/prisma-copy';
import { driverPackModel } from '@/lib/dispatch/driver-pack';
import { REPLACED_LINE, whatsappText } from '@/lib/dispatch/driver-links';
import { fixture } from './plan-detail-fixture';

describe('isSupersededRun (review F07: status alone is not enough)', () => {
  it('is superseded by status, or by supersededAt whatever the status says', () => {
    expect(isSupersededRun({ status: 'SUPERSEDED' })).toBe(true);
    expect(isSupersededRun({ status: 'READY', supersededAt: new Date() })).toBe(true);
    expect(isSupersededRun({ status: 'READY', supersededAt: '2026-09-25T10:00:00.000Z' })).toBe(true);
    expect(isSupersededRun({ status: 'READY', supersededAt: null })).toBe(false);
    expect(isSupersededRun({ status: 'READY' })).toBe(false);
  });

  it('driver sheets and WhatsApp messages of a version written READY over its supersede say DO NOT USE', () => {
    const d = fixture();
    const resurrected = { ...d, run: { ...d.run, status: 'READY', supersededAt: '2026-09-25T10:00:00.000Z' } };
    expect(driverPackModel(resurrected, { tenantName: 'NMWC' }).superseded).toBe(true);
    expect(driverPackModel(d, { tenantName: 'NMWC' }).superseded).toBe(false);
    expect(whatsappText(resurrected.run, d.loads[0]!, 2)).toContain(REPLACED_LINE);
  });
});

describe('appliedPlanStatus', () => {
  it('DISPATCHED only when every load is out', () => {
    expect(appliedPlanStatus(['DISPATCHED', 'COMPLETED'])).toBe('DISPATCHED');
    expect(appliedPlanStatus(['DISPATCHED', 'LOCKED'])).toBe('READY');
    expect(appliedPlanStatus([])).toBe('READY');
  });
});

describe('nothingToReplan (review F03)', () => {
  it('only when no load is PLANNED, nothing is unserved and no order waits', () => {
    expect(nothingToReplan({ loadStatuses: ['LOCKED', 'DISPATCHED'], unservedOrders: 0, pendingOrders: 0 })).toBe(true);
    expect(nothingToReplan({ loadStatuses: ['LOCKED', 'PLANNED'], unservedOrders: 0, pendingOrders: 0 })).toBe(false);
    expect(nothingToReplan({ loadStatuses: ['LOCKED'], unservedOrders: 1, pendingOrders: 0 })).toBe(false);
    expect(nothingToReplan({ loadStatuses: ['LOCKED'], unservedOrders: 0, pendingOrders: 2 })).toBe(false);
  });
});

describe('scenariolessTransitionAllowed (review F03 / L14)', () => {
  const all: LoadStatusName[] = ['PLANNED', 'LOCKED', 'LOADING', 'DISPATCHED', 'COMPLETED'];
  it('allows unlock, back-to-locked and completing a load that is out - nothing that needs a plan', () => {
    const allowed = all.flatMap((from) => all.filter((to) => scenariolessTransitionAllowed(from, to)).map((to) => `${from}->${to}`));
    expect(allowed).toEqual(['LOCKED->PLANNED', 'LOADING->LOCKED', 'DISPATCHED->COMPLETED']);
  });

  it('canStepBack: only a LOCKED or LOADING load can be unlocked (a dispatched one cannot)', () => {
    expect(canStepBack(['DISPATCHED', 'LOCKED'])).toBe(true);
    expect(canStepBack(['LOADING'])).toBe(true);
    expect(canStepBack(['DISPATCHED', 'COMPLETED', 'PLANNED'])).toBe(false);
    expect(canStepBack([])).toBe(false);
  });

  it('NO_PLAN_APPLIED advises only what can be done on the version', () => {
    expect(noPlanApplied(['PLANNED', 'LOCKED']).message).toMatch(/OPTIMIZE the day first/);
    expect(noPlanApplied(['LOCKED', 'DISPATCHED']).message).toMatch(/unlock a load, then OPTIMIZE/);
    const out = noPlanApplied(['DISPATCHED', 'COMPLETED']);
    expect(out.message).not.toMatch(/unlock/i);
    expect(out.details).toMatchObject({ code: 'NO_PLAN_APPLIED' });
  });

  it('NOTHING_TO_PLAN advises unlocking only when a LOCKED or LOADING load exists', () => {
    expect(String(nothingToPlan(true, true).body.error)).toMatch(/unlock it first/);
    expect(String(nothingToPlan(false, true).body.error)).toMatch(/unlock one load, then OPTIMIZE/);
    for (const applied of [true, false]) {
      const r = nothingToPlan(applied, false);
      expect(r.status).toBe(409);
      expect(r.body.code).toBe('NOTHING_TO_PLAN');
      expect(String(r.body.error)).not.toMatch(/unlock/i);
      expect(String(r.body.error)).toMatch(/left the depot/);
    }
  });
});

describe('isCarriedFrozen (review: PLANNED copies of a re-plan are not "kept")', () => {
  it('only a carried load that is locked, loading or out is kept from the previous version', () => {
    expect(isCarriedFrozen({ status: 'LOCKED', carriedFromLoadId: 'p1' })).toBe(true);
    expect(isCarriedFrozen({ status: 'DISPATCHED', carriedFromLoadId: 'p1' })).toBe(true);
    expect(isCarriedFrozen({ status: 'PLANNED', carriedFromLoadId: 'p1' })).toBe(false);
    expect(isCarriedFrozen({ status: 'LOCKED', carriedFromLoadId: null })).toBe(false);
  });
});

describe('copyRowData', () => {
  it('finds the Json columns of a model from the Prisma schema', () => {
    expect([...jsonFieldsOf('RouteAssignment')]).toEqual(['portionLinesJson']);
    expect(jsonFieldsOf('ScenarioResult').has('detailsJson')).toBe(true);
    expect(jsonFieldsOf('PlanLoad').has('driverId')).toBe(false);
  });

  it('drops the omitted keys, maps a null Json column to DbNull and keeps other nulls', () => {
    const out = copyRowData('RouteAssignment', { id: 'a', runId: 'r', loadId: 'l', orderId: 'o', portionLinesJson: null, etaMin: null }, ['id', 'runId', 'loadId'], { runId: 'r2', loadId: 'l2' });
    expect(out).toEqual({ orderId: 'o', portionLinesJson: Prisma.DbNull, etaMin: null, runId: 'r2', loadId: 'l2' });
    const kept = copyRowData('RouteAssignment', { portionLinesJson: [{ lineId: 'x', cases: 1 }] }, [], {});
    expect(kept.portionLinesJson).toEqual([{ lineId: 'x', cases: 1 }]);
  });
});
