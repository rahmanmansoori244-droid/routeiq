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
 * - Two orders of one stop brought forward (to 6 and 7 Oct), all or nothing: every copy is checked
 *   before anything changes. With the 7 Oct copy planned, "Undo the bring forward and record this
 *   result" removes nothing and records no result (before, the 6 Oct copy was removed and committed,
 *   then the request was refused); the refusal names the planned copy, each copy keeps a
 *   CARRY_CONFLICT (both copies warn). With both copies unplanned, both are removed and the result
 *   recorded together; an error after the removals rolls all of it back.
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
import { carryOverPreview, undoCarry } from '@/lib/dispatch/carry-over';
import { carryBases } from '@/lib/delivery/event-service';
import { copyConflicts } from '@/lib/delivery/carry-conflicts';
import { recordOfficeOutcome } from '@/lib/delivery/office-service';
import { carriedRefusalText } from '@/lib/delivery/office-text';

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

  it('a copy brought forward again (O2 -> C2 -> C3) is not offered for undo and is refused COPY_CARRIED_AGAIN, nothing changed', async () => {
    const D7 = '2026-10-07';
    Object.assign(row('order', 'C2'), { carriedToOrderId: 'C3', carriedTo: { deliveryDate: day(D7) } });
    tables.order.push({ id: 'C3', tenantId: T, depotId: 'DA', customerId: 'c-BETA', deliveryDate: day(D7), status: 'VALIDATED', totalCases: 6, carriedFromOrderId: 'C2', customer: { id: 'c-BETA', code: 'BETA', branchCode: null, name: 'BETA' }, lines: [] });
    const e = await undoCarry(T, 'O2', { id: 'u1' }).catch((x) => x);
    expect(e.status).toBe(409);
    expect(e.details).toMatchObject({ code: 'COPY_CARRIED_AGAIN', copyId: 'C2', copyDate: D6 });
    expect(e.message).toContain('7 Oct');
    expect(row('order', 'O2').carriedToOrderId).toBe('C2');
    expect(tables.order.some((o) => o.id === 'C2')).toBe(true);
    // 6 Oct's panel does not list C2 under "Brought forward to 6 Oct, not planned yet".
    expect((await carryOverPreview(T, 'DA', D6, { now: new Date('2026-10-06T05:00:00Z') })).undoable).toEqual([]);
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

  it('the carry basis is read again under the outcome-day lock, never from the stop read before it (a Bring forward committed meanwhile)', async () => {
    // The planned stop as read before the lock: O2 not brought forward yet.
    const stale = { orders: [{ orderId: 'O2', carriedToOrderId: null }] } as unknown as Parameters<typeof carryBases>[2];
    const bases = await carryBases(fakePrisma as never, T, stale);
    expect(bases).toEqual([{ copyId: 'C2', copyDate: D6, originalId: 'O2', basis: { visits: [{ visitId: 'V2', lines: [{ lineId: 'O2-b', notDelivered: 6 }] }] } }]);
  });

  it('a change that keeps or grows the carried shortfall is stored (the basis rule refuses only a shrink)', async () => {
    const r = await post(outcomeRoute, correction({ outcome: 'NOT_DELIVERED', reason: 'CUSTOMER_REFUSED' }));
    expect(r.status).toBe(200);
    expect(row('stopVisit', 'V2')).toMatchObject({ outcome: 'NOT_DELIVERED', reason: 'CUSTOMER_REFUSED', casesDelivered: 0 });
    expect(tables.order.some((o) => o.id === 'C2')).toBe(true);
  });
});

describe('two orders of one stop brought forward: undo all or nothing (spec 9.4)', () => {
  const D7 = '2026-10-07';
  /** BETA's stop on 5 Oct had a second order, O3 (20 cases, none delivered), brought forward to 7 Oct as C3. */
  function seedTwo() {
    seed();
    tables.order.push(
      {
        id: 'O3', tenantId: T, depotId: 'DA', customerId: 'c-BETA', deliveryDate: day(D5), status: 'DISPATCHED', totalCases: 20,
        customer: { id: 'c-BETA', code: 'BETA', branchCode: null, name: 'BETA', lat: 23.6, lng: 58.4 },
        lines: [{ id: 'O3-a', cases: 20, weightKg: 200, product: { code: 'A' } }],
        carriedToOrderId: 'C3', carriedAt: new Date('2026-10-05T15:00:00Z'), carriedById: 'u1', carriedTo: { deliveryDate: day(D7) },
      },
      {
        id: 'C3', tenantId: T, depotId: 'DA', customerId: 'c-BETA', deliveryDate: day(D7), status: 'VALIDATED', totalCases: 20, carriedFromOrderId: 'O3',
        customer: { id: 'c-BETA', code: 'BETA', branchCode: null, name: 'BETA' },
        carryBasisJson: { visits: [{ visitId: 'V2', lines: [{ lineId: 'O3-a', notDelivered: 20 }] }] },
        lines: [{ id: 'C3-a', cases: 20, weightKg: 200, product: { code: 'A' } }],
      },
    );
    tables.routeAssignment.push({
      id: 'ra5b', runId: 'P5', loadId: 'L5', orderId: 'O3', sequenceInTruck: 1, orderInStop: 1, etaMin: 600, serviceStartMin: 600, departureMin: 620, portionLinesJson: null,
      stopSnapshotJson: { v: 1, customerId: 'c-BETA', code: 'BETA', branchCode: null, name: 'BETA', lat: 23.6, lng: 58.4, hardStartMin: null, hardEndMin: null },
    });
    Object.assign(row('stopVisit', 'V2'), {
      linesJson: [...row('stopVisit', 'V2').linesJson, { orderId: 'O3', lineId: 'O3-a', productCode: 'A', plannedCases: 20, deliveredCases: 0 }],
      casesPlanned: 60,
    });
  }
  /** C3 is already planned on 7 Oct (a route row of a plan that has not left). */
  const planC3 = () => {
    tables.runPlan.push({ id: 'P7', tenantId: T, depotId: 'DA', runDate: day(D7), status: 'READY', version: 1, chosenScenarioId: 'sc7', supersededAt: null, createdAt: new Date('2026-10-06T16:00:00Z') });
    tables.routeAssignment.push({ id: 'ra7', runId: 'P7', loadId: 'L7', orderId: 'C3', sequenceInTruck: 1, load: { status: 'PLANNED' } });
  };
  const correction = (over: Record<string, unknown> = {}) => ({ key: randomUUID(), depotId: 'DA', date: D5, truckId: 'T1', loadNo: 1, sequence: 1, outcome: 'DELIVERED', ...over });
  /** Nothing removed and no result recorded: only refusals (CARRY_CONFLICT events and their audit rows) may be kept. */
  const unchanged = () => {
    expect(tables.order.map((o) => o.id).sort()).toEqual(['C2', 'C3', 'O2', 'O3']);
    expect([row('order', 'O2').carriedToOrderId, row('order', 'O3').carriedToOrderId]).toEqual(['C2', 'C3']);
    expect(row('stopVisit', 'V2')).toMatchObject({ outcome: 'PARTLY_DELIVERED', casesDelivered: 34, outcomeSource: 'PHONE_MANUAL' });
    expect(tables.stopEvent.filter((e) => e.kind !== 'CARRY_CONFLICT')).toEqual([]);
    expect(tables.auditLog.filter((a) => a.action !== 'DELIVERY_CARRY_CONFLICT')).toEqual([]);
  };
  beforeEach(seedTwo);

  it('the 7 Oct copy is planned: "Undo and record" removes nothing and records nothing; the refusal names the planned copy; both copies warn', async () => {
    planC3();
    // The reported case: "Undo the bring forward and record this result", and the 6 Oct copy (read
    // first) could be removed alone. Before, it was removed and committed, then the 7 Oct copy refused.
    const key = randomUUID();
    const r = await post(outcomeRoute, correction({ key, undoCarry: true }));
    expect(r.status).toBe(409);
    unchanged();
    const body = (await r.json()).error;
    expect(body).toMatchObject({
      code: 'OUTCOME_CARRIED',
      undoable: false,
      copyId: 'C3',
      copyDate: D7,
      copies: [
        { copyId: 'C2', copyDate: D6, undoable: true },
        { copyId: 'C3', copyDate: D7, undoable: false, code: 'COPY_PLANNED' },
      ],
    });
    expect(body.error).toBe(
      'This result was not recorded and nothing was changed: it would shrink 2 orders brought forward from this stop (to 6 Oct and 7 Oct). ' +
        'BETA was brought forward to 7 Oct with 20 cases and 7 Oct is already planned with it. A planned order cannot be removed in the app yet: ask an administrator to remove the copy. ' +
        'The copy on 6 Oct is not planned yet, but the bring forward can only be undone for all the copies together.',
    );
    // A plain try (no undo) is refused not undoable: one copy cannot be removed, so the dialog offers no undo.
    const plain = await post(outcomeRoute, correction());
    expect(plain.status).toBe(409);
    expect((await plain.json()).error).toMatchObject({ code: 'OUTCOME_CARRIED', undoable: false, copyId: 'C3', copyDate: D7 });
    // Nothing deleted, no result recorded: only the refusals are kept, one CARRY_CONFLICT per copy each time.
    unchanged();
    expect(tables.stopEvent.map((e) => [e.kind, e.payloadJson.copyId])).toEqual([
      ['CARRY_CONFLICT', 'C2'],
      ['CARRY_CONFLICT', 'C3'],
      ['CARRY_CONFLICT', 'C2'],
      ['CARRY_CONFLICT', 'C3'],
    ]);
    expect(tables.auditLog.map((a) => [a.action, a.afterJson.copyDate])).toEqual([
      ['DELIVERY_CARRY_CONFLICT', D6],
      ['DELIVERY_CARRY_CONFLICT', D7],
      ['DELIVERY_CARRY_CONFLICT', D6],
      ['DELIVERY_CARRY_CONFLICT', D7],
    ]);
    // Both copies' days warn ("May not be needed ..."), not only the first one's.
    expect([...(await copyConflicts(fakePrisma as never, T, ['C2', 'C3'])).keys()].sort()).toEqual(['C2', 'C3']);
    // The same request again (a double click): answered from the stored refusal, still nothing changed.
    const again = await post(outcomeRoute, correction({ key, undoCarry: true }));
    expect(again.status).toBe(409);
    expect((await again.json()).error).toMatchObject({ code: 'OUTCOME_CARRIED', undoable: false, copies: [{ copyId: 'C2' }, { copyId: 'C3' }] });
    unchanged();
    expect(tables.stopEvent).toHaveLength(4);
  });

  it('the planned copy read first: the same refusal, nothing changed', async () => {
    tables.order.sort((a, b) => (a.id === 'C3' ? -1 : b.id === 'C3' ? 1 : 0));
    planC3();
    const e = await recordOfficeOutcome(T, { id: 'u1', name: 'Dispatcher Ali' }, correction({ undoCarry: true }) as never).catch((x) => x);
    expect(e.status).toBe(409);
    expect(e.details).toMatchObject({ code: 'OUTCOME_CARRIED', undoable: false, copyId: 'C3', copies: [{ copyId: 'C3', undoable: false }, { copyId: 'C2', undoable: true }] });
    expect(e.message).toContain('7 Oct is already planned with it');
    unchanged();
  });

  it('both copies unplanned: refused undoable at first, then both removed and the result recorded in one transaction', async () => {
    const first = await post(outcomeRoute, correction());
    expect(first.status).toBe(409);
    const refused = (await first.json()).error;
    expect(refused).toMatchObject({ code: 'OUTCOME_CARRIED', undoable: true, copyId: 'C2', copies: [{ copyId: 'C2', undoable: true }, { copyId: 'C3', undoable: true }] });
    expect(refused.error).toBe(
      'These cases were brought forward in 2 orders (to 6 Oct and 7 Oct) and none of the copies is planned yet. Undo the bring forward to record this result: all 2 copies are removed together.',
    );
    unchanged();
    const done = await post(outcomeRoute, correction({ undoCarry: true }));
    expect(done.status).toBe(200);
    expect((await done.json()).data).toMatchObject({
      result: 'ok',
      visitId: 'V2',
      carryUndone: { copyId: 'C2', copyDate: D6 },
      carriesUndone: [
        { copyId: 'C2', copyDate: D6, originalOrderId: 'O2', cases: 6 },
        { copyId: 'C3', copyDate: D7, originalOrderId: 'O3', cases: 20 },
      ],
    });
    expect(tables.order.map((o) => o.id).sort()).toEqual(['O2', 'O3']);
    expect([row('order', 'O2').carriedToOrderId, row('order', 'O3').carriedToOrderId]).toEqual([null, null]);
    expect(row('stopVisit', 'V2')).toMatchObject({ outcome: 'DELIVERED', casesDelivered: 60, outcomeSource: 'DISPATCHER', outcomeById: 'u1' });
    expect(tables.auditLog.map((a) => [a.action, a.entityId])).toEqual([
      ['DELIVERY_CARRY_CONFLICT', 'V2'],
      ['DELIVERY_CARRY_CONFLICT', 'V2'],
      ['ORDERS_CARRY_UNDONE', 'O2'],
      ['ORDERS_CARRY_UNDONE', 'O3'],
      ['DELIVERY_OUTCOME_SET', 'V2'],
    ]);
    expect(tables.auditLog.at(-1)!.afterJson).toMatchObject({ carriesUndone: [{ copyId: 'C2', copyDate: D6 }, { copyId: 'C3', copyDate: D7 }] });
  });

  it('an error after the copies were removed rolls all of it back: no copy removed, no result', async () => {
    const create = fakePrisma.stopEvent.create;
    fakePrisma.stopEvent.create = async (a: { data: { kind: string } }) => {
      if (a.data.kind === 'OUTCOME') throw new Error('database went away');
      return create(a);
    };
    try {
      const e = await recordOfficeOutcome(T, { id: 'u1', name: 'Dispatcher Ali' }, correction({ undoCarry: true }) as never).catch((x) => x);
      expect(e.message).toBe('database went away');
    } finally {
      fakePrisma.stopEvent.create = create;
    }
    unchanged();
    expect(tables.stopEvent).toEqual([]);
    expect(tables.auditLog).toEqual([]);
  });

  it('the refusal words: one copy as before; several name each copy that blocks and why', () => {
    const c = (copyDate: string, undoable: boolean, text = '') => ({ copyId: copyDate, copyDate, undoable, text });
    expect(carriedRefusalText([c(D6, true)])).toBe('These cases were brought forward to 6 Oct and that copy is not planned yet. Undo the bring forward to record this result.');
    expect(carriedRefusalText([c(D6, false, 'Planned.')])).toBe('Planned.');
    expect(carriedRefusalText([c(D6, false)])).toBe('These cases were brought forward to 6 Oct: the result cannot shrink them.');
    expect(carriedRefusalText([c(D6, true), c(D7, false, 'BETA is on the road on 7 Oct.'), c('2026-10-08', false, 'The 8 Oct plan is being optimized.')])).toBe(
      'This result was not recorded and nothing was changed: it would shrink 3 orders brought forward from this stop (to 6 Oct, 7 Oct and 8 Oct). ' +
        'BETA is on the road on 7 Oct. The 8 Oct plan is being optimized. The copy on 6 Oct is not planned yet, but the bring forward can only be undone for all the copies together.',
    );
    expect(carriedRefusalText([c(D6, false, 'A.'), c(D6, false, 'B.')])).toBe(
      'This result was not recorded and nothing was changed: it would shrink 2 orders brought forward from this stop (to 6 Oct). A. B.',
    );
  });
});
