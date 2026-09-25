/**
 * Stabilization PR3 - the shared plan status rules (lib/dispatch/plan-status.ts), the load changes
 * a version without an applied plan allows (load-state.ts) and the version copy helper
 * (prisma-copy.ts).
 */
import { Prisma } from '@prisma/client';
import { describe, expect, it } from 'vitest';
import { scenariolessTransitionAllowed, type LoadStatusName } from '@/lib/dispatch/load-state';
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
  it('allows only unlock and back-to-locked', () => {
    const allowed = all.flatMap((from) => all.filter((to) => scenariolessTransitionAllowed(from, to)).map((to) => `${from}->${to}`));
    expect(allowed).toEqual(['LOCKED->PLANNED', 'LOADING->LOCKED']);
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
