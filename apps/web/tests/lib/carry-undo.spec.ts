/**
 * "Undo bring forward" and the carry basis rule on the dispatcher's side (owner request 4 Oct 2026,
 * spec sections 9.3 E6 and 9.4), on the in-memory database (fake-plan-db.ts):
 * - undoCarry removes a copy that no plan refers to, clearing the original's carry fields first;
 *   refused COPY_PLANNED (a route row or an unserved row refers to the copy), COPY_ON_ROAD (the copy is
 *   on a locked / loading / dispatched load) and PLAN_BUSY (the copy's day is being optimized); the
 *   lock order (intake, day locks in date order, outcome-day lock); the audit row;
 * - E6: the dispatcher's correction that would shrink cases brought forward is refused 409
 *   OUTCOME_CARRIED (undoable while the copy is not planned) and kept as a CARRY_CONFLICT event; with
 *   undoCarry the copy is removed and the result recorded in one transaction.
 * Synthetic data only: customer BETA, truck T02.
 */
import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fakePrisma, resetDb, row, tables } from './fake-plan-db';

vi.mock('@/lib/db', async () => ({ prisma: (await import('./fake-plan-db')).fakePrisma }));
vi.mock('@/lib/tenant', async () => {
  const m = await import('./fake-plan-db');
  return { tenantDb: () => m.fakePrisma };
});
vi.mock('@/lib/audit', async () => {
  const m = await import('./fake-plan-db');
  return { audit: vi.fn(async (input: Record<string, unknown>) => m.fakePrisma.auditLog.create({ data: { ...input } })) };
});
const session = vi.hoisted(() => ({ role: 'PLANNER' }));
vi.mock('@/lib/auth', () => ({ auth: vi.fn(async () => ({ user: { id: 'u1', tenantId: 'tA', role: session.role, name: 'Dispatcher Ali', email: 'ali@a.example' } })) }));

import { POST as undoRoute } from '@/app/api/dispatch/carry-over/undo/route';
import { POST as outcomeRoute } from '@/app/api/dispatch/outcomes/route';
import { undoCarry } from '@/lib/dispatch/carry-over';

const T = 'tA';
const D5 = '2026-10-05';
const D6 = '2026-10-06';
const day = (iso: string) => new Date(`${iso}T00:00:00Z`);

function seed() {
  resetDb();
  session.role = 'PLANNER';
  tables.tenantConfig = [{ id: 'cfg', tenantId: T, timezone: 'Asia/Muscat', geofenceRadiusM: 100 }];
  tables.depot = [{ id: 'DA', tenantId: T, code: 'A1', active: true }];
  tables.truck = [{ id: 'T1', tenantId: T, code: 'T02', hired: false }];
  tables.order = [
    {
      id: 'O2', tenantId: T, depotId: 'DA', customerId: 'c-BETA', deliveryDate: day(D5), status: 'DISPATCHED', totalCases: 40,
      customer: { id: 'c-BETA', code: 'BETA', branchCode: null, name: 'BETA', lat: 23.6, lng: 58.4 },
      lines: [
        { id: 'O2-a', cases: 30, weightKg: 300, product: { code: 'A' } },
        { id: 'O2-b', cases: 10, weightKg: 100, product: { code: 'B' } },
      ],
      carriedToOrderId: 'C2', carriedAt: new Date('2026-10-05T15:00:00Z'), carriedById: 'u1', carriedTo: { deliveryDate: day(D6) },
    },
    {
      id: 'C2', tenantId: T, depotId: 'DA', customerId: 'c-BETA', deliveryDate: day(D6), status: 'VALIDATED', totalCases: 6, carriedFromOrderId: 'O2',
      customer: { id: 'c-BETA', code: 'BETA', branchCode: null, name: 'BETA' },
      carryBasisJson: { visits: [{ visitId: 'V2', lines: [{ lineId: 'O2-b', notDelivered: 6 }] }] },
      lines: [{ id: 'C2-b', cases: 6, weightKg: 60, product: { code: 'B' } }],
    },
  ];
  tables.runPlan = [
    { id: 'P5', tenantId: T, depotId: 'DA', runDate: day(D5), status: 'DISPATCHED', version: 1, chosenScenarioId: 'sc5', supersededAt: null, createdAt: new Date('2026-10-04T12:00:00Z') },
    { id: 'P6', tenantId: T, depotId: 'DA', runDate: day(D6), status: 'READY', version: 1, chosenScenarioId: 'sc6', supersededAt: null, createdAt: new Date('2026-10-05T16:00:00Z') },
  ];
  tables.planLoad = [{ id: 'L5', tenantId: T, runId: 'P5', truckId: 'T1', loadNo: 1, status: 'COMPLETED', departMin: 420, returnMin: 900, driverId: null, breakJson: null }];
  tables.routeAssignment = [
    {
      id: 'ra5', runId: 'P5', loadId: 'L5', orderId: 'O2', sequenceInTruck: 1, orderInStop: 0, etaMin: 600, serviceStartMin: 600, departureMin: 620, portionLinesJson: null,
      stopSnapshotJson: { v: 1, customerId: 'c-BETA', code: 'BETA', branchCode: null, name: 'BETA', lat: 23.6, lng: 58.4, hardStartMin: null, hardEndMin: null },
    },
  ];
  tables.unservedOrder = [];
  tables.stopVisit = [
    {
      id: 'V2', tenantId: T, depotId: 'DA', deliveryDate: day(D5), truckId: 'T1', loadNo: 1, sequence: 1, customerId: 'c-BETA', firstLoadId: 'L5',
      plannedEtaMin: 600, plannedServiceMin: 20, plannedLat: 23.6, plannedLng: 58.4, windowStartMin: null, windowEndMin: null,
      linesJson: [
        { orderId: 'O2', lineId: 'O2-a', productCode: 'A', plannedCases: 30, deliveredCases: 30 },
        { orderId: 'O2', lineId: 'O2-b', productCode: 'B', plannedCases: 10, deliveredCases: 4 },
      ],
      casesPlanned: 40, casesDelivered: 34, outcome: 'PARTLY_DELIVERED', reason: 'DAMAGED_GOODS', outcomeSource: 'PHONE_MANUAL', locationPurgedAt: null,
    },
  ];
  tables.stopEvent = [];
  tables.deliveryPhoto = [];
  tables.driverLink = [];
  tables.auditLog = [];
}

function recordRaw() {
  const calls: unknown[] = [];
  const orig = fakePrisma.$queryRaw;
  fakePrisma.$queryRaw = async (strings: TemplateStringsArray, ...values: unknown[]) => {
    calls.push(values[0]);
    return orig(strings, ...values);
  };
  return { calls, restore: () => (fakePrisma.$queryRaw = orig) };
}

const post = (route: (req: Request) => Promise<Response>, body: unknown) =>
  route(new Request('http://x/api', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }));

describe('Undo bring forward (spec 9.4)', () => {
  beforeEach(seed);

  it('removes a copy no plan refers to: the original is cleared first, then the copy deleted; locks in order; audited', async () => {
    const order: string[] = [];
    const upd = fakePrisma.order.updateMany;
    const del = fakePrisma.order.deleteMany;
    fakePrisma.order.updateMany = async (a: { where: { id?: unknown } }) => (order.push(`clear ${String(a.where.id)}`), upd(a));
    fakePrisma.order.deleteMany = async (a: { where: { id?: unknown } }) => (order.push(`delete ${String(a.where.id)}`), del(a));
    const raw = recordRaw();
    try {
      const res = await undoCarry(T, 'O2', { id: 'u1' });
      expect(res).toEqual({ undone: true, replanNeeded: false, originalOrderId: 'O2', copyId: 'C2', copyDate: D6, cases: 6 });
    } finally {
      raw.restore();
      fakePrisma.order.updateMany = upd;
      fakePrisma.order.deleteMany = del;
    }
    expect(order).toEqual(['clear O2', 'delete C2']);
    expect(row('order', 'O2')).toMatchObject({ carriedToOrderId: null, carriedAt: null, carriedById: null });
    expect(tables.order.some((o) => o.id === 'C2')).toBe(false);
    const locks = raw.calls.filter((v) => typeof v === 'string');
    expect(locks).toEqual(['intake:tA', `planday:tA|DA|${D5}`, `planday:tA|DA|${D6}`, `outcomes:tA|DA|${D5}`]);
    expect(tables.auditLog.map((a) => [a.action, a.entityId, a.afterJson])).toEqual([['ORDERS_CARRY_UNDONE', 'O2', { originalOrderId: 'O2', copyId: 'C2', copyDate: D6, cases: 6, customer: 'BETA' }]]);
  });

  it('refused while a plan refers to the copy (route row or unserved row), while it is loaded or out, and while its day is being optimized', async () => {
    tables.routeAssignment.push({ id: 'ra6', runId: 'P6', loadId: 'L6', orderId: 'C2', sequenceInTruck: 2, load: { status: 'PLANNED' } });
    let e = await undoCarry(T, 'O2', { id: 'u1' }).catch((x) => x);
    expect(e.details).toMatchObject({ code: 'COPY_PLANNED', copyId: 'C2', copyDate: D6 });
    expect(e.message).toContain('A planned order cannot be removed in the app yet: ask an administrator to remove the copy.');
    tables.routeAssignment.at(-1)!.load = { status: 'LOCKED' };
    e = await undoCarry(T, 'O2', { id: 'u1' }).catch((x) => x);
    expect(e.details).toMatchObject({ code: 'COPY_ON_ROAD' });
    tables.routeAssignment.pop();
    tables.unservedOrder = [{ id: 'u6', scenarioId: 'sc6', orderId: 'C2', reasonCode: 'TRIP_LIMIT' }];
    e = await undoCarry(T, 'O2', { id: 'u1' }).catch((x) => x);
    expect(e.details).toMatchObject({ code: 'COPY_PLANNED' });
    tables.unservedOrder = [];
    row('runPlan', 'P6').status = 'OPTIMIZING';
    e = await undoCarry(T, 'O2', { id: 'u1' }).catch((x) => x);
    expect(e.details).toMatchObject({ code: 'PLAN_BUSY' });
    // Nothing changed by any refusal.
    expect(row('order', 'O2').carriedToOrderId).toBe('C2');
    expect(tables.order.some((o) => o.id === 'C2')).toBe(true);
    expect(tables.auditLog).toEqual([]);
  });

  it('the route: PLANNER, 404 when there is nothing to undo, 403 for a viewer', async () => {
    session.role = 'VIEWER';
    expect((await post(undoRoute, { originalOrderId: 'O2' })).status).toBe(403);
    session.role = 'PLANNER';
    expect((await post(undoRoute, { originalOrderId: 'NOPE' })).status).toBe(404);
    const ok = await post(undoRoute, { originalOrderId: 'O2' });
    expect(ok.status).toBe(200);
    expect((await ok.json()).data).toMatchObject({ undone: true, copyId: 'C2' });
    expect((await post(undoRoute, { originalOrderId: 'O2', extra: 1 })).status).toBe(400);
  });
});

describe('E6: a correction after the carry (spec 9.3)', () => {
  beforeEach(seed);
  const correction = (over: Record<string, unknown> = {}) => ({ key: randomUUID(), depotId: 'DA', date: D5, truckId: 'T1', loadNo: 1, sequence: 1, outcome: 'DELIVERED', ...over });

  it('copy not planned: 409 OUTCOME_CARRIED undoable, kept as a CARRY_CONFLICT; with undoCarry the copy goes and the result is recorded', async () => {
    const refused = await post(outcomeRoute, correction());
    expect(refused.status).toBe(409);
    const body = (await refused.json()).error;
    expect(body).toMatchObject({ code: 'OUTCOME_CARRIED', copyId: 'C2', copyDate: D6, undoable: true });
    expect(row('stopVisit', 'V2')).toMatchObject({ outcome: 'PARTLY_DELIVERED', casesDelivered: 34 });
    expect(tables.stopEvent.map((e) => [e.kind, e.source, e.userId])).toEqual([['CARRY_CONFLICT', 'DISPATCHER', 'u1']]);
    expect(tables.auditLog.map((a) => a.action)).toEqual(['DELIVERY_CARRY_CONFLICT']);
    // "Undo the bring forward and record this result": one transaction.
    const done = await post(outcomeRoute, correction({ undoCarry: true }));
    expect(done.status).toBe(200);
    expect((await done.json()).data).toMatchObject({ result: 'ok', visitId: 'V2', carryUndone: { copyId: 'C2', copyDate: D6 } });
    expect(tables.order.some((o) => o.id === 'C2')).toBe(false);
    expect(row('order', 'O2').carriedToOrderId).toBeNull();
    expect(row('stopVisit', 'V2')).toMatchObject({ outcome: 'DELIVERED', casesDelivered: 40, outcomeSource: 'DISPATCHER', outcomeById: 'u1' });
    expect(tables.auditLog.map((a) => a.action)).toEqual(['DELIVERY_CARRY_CONFLICT', 'ORDERS_CARRY_UNDONE', 'DELIVERY_OUTCOME_SET']);
  });

  it('copy already planned on 6 Oct: not undoable, the words say why; the visit is unchanged', async () => {
    tables.routeAssignment.push({ id: 'ra6', runId: 'P6', loadId: 'L6', orderId: 'C2', sequenceInTruck: 2, load: { status: 'PLANNED' } });
    const r = await post(outcomeRoute, correction({ undoCarry: true }));
    expect(r.status).toBe(409);
    const body = (await r.json()).error;
    expect(body).toMatchObject({ code: 'OUTCOME_CARRIED', undoable: false });
    expect(body.error).toContain('already planned with it');
    expect(row('stopVisit', 'V2').outcome).toBe('PARTLY_DELIVERED');
    expect(tables.order.some((o) => o.id === 'C2')).toBe(true);
  });

  it('a change that keeps or grows the carried shortfall is stored (the basis rule refuses only a shrink)', async () => {
    const r = await post(outcomeRoute, correction({ outcome: 'NOT_DELIVERED', reason: 'CUSTOMER_REFUSED' }));
    expect(r.status).toBe(200);
    expect(row('stopVisit', 'V2')).toMatchObject({ outcome: 'NOT_DELIVERED', reason: 'CUSTOMER_REFUSED', casesDelivered: 0 });
    expect(tables.order.some((o) => o.id === 'C2')).toBe(true);
  });
});
