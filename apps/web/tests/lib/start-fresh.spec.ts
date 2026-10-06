/**
 * "Start fresh (remove test data)" (owner request 4 Oct 2026, the day before the pilot), on the
 * in-memory database (fake-plan-db.ts) with the database's own foreign keys modelled on top: a
 * delete that a RESTRICT / NO ACTION key would refuse throws here as it would on PostgreSQL, and
 * after a run no row may point at a row that is gone (the fake has no cascades, so everything the
 * database would cascade must be removed explicitly). Checked: the preview counts, the removal
 * order, another company untouched, the master data and the audit log kept (one TEST_DATA_CLEARED
 * row added), the refusal while an optimization is queued or running, "only before a date", daily
 * drivers, and the locks taken first. Synthetic data only.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fakePrisma, rawLog, resetDb, tables } from './fake-plan-db';

vi.mock('@/lib/db', async () => ({ prisma: (await import('./fake-plan-db')).fakePrisma }));
vi.mock('@/lib/tenant', async () => {
  const m = await import('./fake-plan-db');
  return { tenantDb: () => m.fakePrisma };
});
vi.mock('@/lib/audit', async () => {
  const m = await import('./fake-plan-db');
  return { audit: vi.fn(async (input: Record<string, unknown>, tx?: Record<string, any>) => (tx ?? m.fakePrisma).auditLog.create({ data: { ...input } })) };
});

import { previewStartFresh, runStartFresh, START_FRESH_DELETE_ORDER, startFreshSafeCutoffs } from '@/lib/start-fresh';
import {
  startFreshConfirmMatches,
  startFreshHasLive,
  startFreshLiveText,
  startFreshShown,
  startFreshStale,
  startFreshTotal,
  START_FRESH_KEPT,
  START_FRESH_REMOVED,
} from '@/lib/start-fresh-text';

type Row = Record<string, any>;
const day = (iso: string) => new Date(`${iso}T00:00:00.000Z`);
const actor = { id: 'uA', name: 'Owner', email: 'owner@a.example' };
/** 10:00 in Muscat on 4 Oct 2026: the seeded orders of the 6th are "today or later". */
const NOW = new Date('2026-10-04T06:00:00Z');
/** A run of company A as the panel sends it after a check: the live-data tick given, nothing compared unless `shown` is passed. */
const run = (before: string | null, extra: Parameters<typeof runStartFresh>[4] = {}, ip: string | null = null) =>
  runStartFresh('tA', before, actor, ip, { now: NOW, liveDataConfirmed: true, ...extra });
const preview = (before: string | null, tenantId = 'tA') => previewStartFresh(tenantId, before, { now: NOW });

/** The database's foreign keys among the tables Start fresh touches (prisma/migrations). */
const FKS: { child: string; field: string; parent: string; onDelete: 'RESTRICT' | 'NO_ACTION' | 'CASCADE' | 'SET_NULL' }[] = [
  { child: 'routeAssignment', field: 'orderId', parent: 'order', onDelete: 'RESTRICT' },
  { child: 'unservedOrder', field: 'orderId', parent: 'order', onDelete: 'NO_ACTION' },
  { child: 'order', field: 'carriedFromOrderId', parent: 'order', onDelete: 'NO_ACTION' },
  { child: 'order', field: 'carriedToOrderId', parent: 'order', onDelete: 'NO_ACTION' },
  { child: 'planLoad', field: 'driverId', parent: 'driver', onDelete: 'NO_ACTION' },
  { child: 'truck', field: 'defaultDriverId', parent: 'driver', onDelete: 'NO_ACTION' },
  { child: 'driverShift', field: 'driverId', parent: 'driver', onDelete: 'RESTRICT' },
  { child: 'orderLine', field: 'productId', parent: 'product', onDelete: 'RESTRICT' },
  { child: 'order', field: 'customerId', parent: 'customer', onDelete: 'RESTRICT' },
  { child: 'order', field: 'depotId', parent: 'depot', onDelete: 'NO_ACTION' },
  { child: 'uploadBatch', field: 'depotId', parent: 'depot', onDelete: 'NO_ACTION' },
  { child: 'stopVisit', field: 'customerId', parent: 'customer', onDelete: 'NO_ACTION' },
  { child: 'stopVisit', field: 'truckId', parent: 'truck', onDelete: 'NO_ACTION' },
  { child: 'driverLink', field: 'truckId', parent: 'truck', onDelete: 'NO_ACTION' },
  { child: 'planLoad', field: 'truckId', parent: 'truck', onDelete: 'RESTRICT' },
  { child: 'routeAssignment', field: 'truckId', parent: 'truck', onDelete: 'RESTRICT' },
  { child: 'driverShift', field: 'truckId', parent: 'truck', onDelete: 'RESTRICT' },
  { child: 'orderLine', field: 'orderId', parent: 'order', onDelete: 'CASCADE' },
  { child: 'intakeLineKey', field: 'orderLineId', parent: 'orderLine', onDelete: 'CASCADE' },
  { child: 'routeAssignment', field: 'runId', parent: 'runPlan', onDelete: 'CASCADE' },
  { child: 'routeAssignment', field: 'loadId', parent: 'planLoad', onDelete: 'CASCADE' },
  { child: 'planLoad', field: 'runId', parent: 'runPlan', onDelete: 'CASCADE' },
  { child: 'scenarioResult', field: 'runId', parent: 'runPlan', onDelete: 'CASCADE' },
  { child: 'unservedOrder', field: 'scenarioId', parent: 'scenarioResult', onDelete: 'CASCADE' },
  { child: 'runJob', field: 'runId', parent: 'runPlan', onDelete: 'CASCADE' },
  { child: 'manualBaseline', field: 'runId', parent: 'runPlan', onDelete: 'CASCADE' },
  { child: 'manualBaselineAssignment', field: 'baselineId', parent: 'manualBaseline', onDelete: 'CASCADE' },
  { child: 'manualBaselineAssignment', field: 'orderId', parent: 'order', onDelete: 'SET_NULL' },
  { child: 'deliveryProof', field: 'assignmentId', parent: 'routeAssignment', onDelete: 'CASCADE' },
  { child: 'deliveryProof', field: 'shiftId', parent: 'driverShift', onDelete: 'CASCADE' },
  { child: 'truckLocation', field: 'shiftId', parent: 'driverShift', onDelete: 'CASCADE' },
  { child: 'driverShift', field: 'runId', parent: 'runPlan', onDelete: 'SET_NULL' },
  { child: 'order', field: 'uploadBatchId', parent: 'uploadBatch', onDelete: 'SET_NULL' },
  { child: 'deliveryPhoto', field: 'visitId', parent: 'stopVisit', onDelete: 'CASCADE' },
  { child: 'deliveryPhoto', field: 'driverLinkId', parent: 'driverLink', onDelete: 'SET_NULL' },
  { child: 'stopEvent', field: 'visitId', parent: 'stopVisit', onDelete: 'CASCADE' },
  { child: 'stopEvent', field: 'driverLinkId', parent: 'driverLink', onDelete: 'SET_NULL' },
  { child: 'runPlan', field: 'parentRunId', parent: 'runPlan', onDelete: 'SET_NULL' },
];

/** The order of the deleteMany calls, by model. */
let deletes: string[] = [];

const plainDeleteMany = new Map<string, (a?: Row) => Promise<{ count: number }>>();

/** deleteMany as PostgreSQL would answer it: refused while a RESTRICT / NO ACTION child row still names a deleted row. */
function enforceForeignKeys() {
  const parents = new Set(FKS.map((f) => f.parent));
  for (const model of Object.keys(fakePrisma)) {
    const d = fakePrisma[model];
    if (!d || typeof d.deleteMany !== 'function') continue;
    if (!plainDeleteMany.has(model)) plainDeleteMany.set(model, d.deleteMany);
    const orig = plainDeleteMany.get(model)!;
    d.deleteMany = async (a: Row = {}) => {
      deletes.push(model);
      if (parents.has(model)) {
        const doomed = new Set((await d.findMany({ where: a.where })).map((r: Row) => r.id));
        for (const fk of FKS.filter((f) => f.parent === model && (f.onDelete === 'RESTRICT' || f.onDelete === 'NO_ACTION'))) {
          const blocking = (tables[fk.child] ?? []).filter((r) => doomed.has(r[fk.field]) && !(fk.child === model && doomed.has(r.id)));
          if (blocking.length) throw Object.assign(new Error(`FK ${fk.child}.${fk.field} -> ${model} (${blocking.map((r) => r.id).join(', ')})`), { code: 'P2003' });
        }
      }
      return orig(a);
    };
  }
}

/** Rows that point at a row that is not there (what a missing explicit delete leaves in the fake). */
function danglingReferences(): string[] {
  const out: string[] = [];
  for (const fk of FKS) {
    const ids = new Set((tables[fk.parent] ?? []).map((r) => r.id));
    for (const r of tables[fk.child] ?? []) {
      if (r[fk.field] != null && !ids.has(r[fk.field])) out.push(`${fk.child} ${r.id}.${fk.field} -> ${fk.parent} ${r[fk.field]}`);
    }
  }
  return out;
}

/**
 * One company's data, ids prefixed with `p`: masters, two order files, orders on 2, 3 and 6 Oct
 * (a late one, one brought forward from the 2nd to the 3rd with a delivery time of its own), plans
 * (two versions on the 2nd), loads, stops, an unserved row, jobs, driver links, delivery results,
 * photos, the retired driver app's rows, a comparison baseline, daily drivers and audit rows.
 */
function seedCompany(tenantId: string, p: string) {
  const push = (model: string, rows: Row[]) => (tables[model] ??= []).push(...rows.map((r) => ({ tenantId, ...r })));
  push('tenant', [{ id: tenantId, slug: `${p}-co` }]);
  tables.tenant!.forEach((t) => delete t.tenantId);
  push('tenantConfig', [{ id: `${p}cfg`, timezone: 'Asia/Muscat' }]);
  push('user', [{ id: `${p}u1` }, { id: `${p}u2` }]);
  push('depot', [{ id: `${p}dep` }]);
  push('region', [{ id: `${p}reg` }]);
  push('customer', [{ id: `${p}c1` }, { id: `${p}c2` }]);
  push('product', [{ id: `${p}pr1` }]);
  push('driver', [
    { id: `${p}reg1`, casual: false, active: true },
    { id: `${p}cas1`, casual: true, active: true }, // only on a load of the 2nd
    { id: `${p}cas2`, casual: true, active: true }, // a truck's default driver
    { id: `${p}cas3`, casual: true, active: false }, // on no load at all
    { id: `${p}cas4`, casual: true, active: true }, // on a load of the 6th
  ]);
  push('truck', [{ id: `${p}t1`, depotId: `${p}dep`, defaultDriverId: `${p}cas2` }]);
  push('uploadBatch', [
    { id: `${p}b1`, depotId: `${p}dep`, deliveryDate: day('2026-10-02'), uploadedAt: new Date('2026-10-01T10:00:00Z'), isLate: false },
    { id: `${p}b6`, depotId: `${p}dep`, deliveryDate: day('2026-10-06'), uploadedAt: new Date('2026-10-05T10:00:00Z'), isLate: false },
    { id: `${p}bx`, depotId: `${p}dep`, deliveryDate: null, uploadedAt: new Date('2026-09-30T10:00:00Z'), isLate: false }, // a deleted file, no orders
  ]);
  const order = (id: string, date: string, extra: Row = {}) => ({
    id: `${p}${id}`, customerId: `${p}c1`, depotId: `${p}dep`, deliveryDate: day(date), isLate: false,
    carriedFromOrderId: null, carriedToOrderId: null, deliveryStartMin: null, deliveryEndMin: null, uploadBatchId: null, ...extra,
  });
  push('order', [
    order('o1', '2026-10-02', { uploadBatchId: `${p}b1`, isLate: true }),
    order('o2', '2026-10-02', { uploadBatchId: `${p}b1`, carriedToOrderId: `${p}o3` }),
    order('o3', '2026-10-03', { carriedFromOrderId: `${p}o2`, deliveryStartMin: 480, deliveryEndMin: 600 }),
    order('o6', '2026-10-06', { uploadBatchId: `${p}b6` }),
  ]);
  push('orderLine', ['o1', 'o2', 'o3', 'o6'].map((o) => ({ id: `${p}l-${o}`, orderId: `${p}${o}`, productId: `${p}pr1`, tenantId: undefined })));
  push('intakeLineKey', ['o1', 'o2', 'o6'].map((o) => ({ id: `${p}k-${o}`, orderLineId: `${p}l-${o}` })));
  push('runPlan', [
    { id: `${p}p2a`, depotId: `${p}dep`, runDate: day('2026-10-02'), version: 1, parentRunId: null },
    { id: `${p}p2b`, depotId: `${p}dep`, runDate: day('2026-10-02'), version: 2, parentRunId: `${p}p2a` },
    { id: `${p}p3`, depotId: `${p}dep`, runDate: day('2026-10-03'), version: 1, parentRunId: null },
    { id: `${p}p6`, depotId: `${p}dep`, runDate: day('2026-10-06'), version: 1, parentRunId: null },
  ]);
  push('scenarioResult', [
    { id: `${p}s2a`, runId: `${p}p2a`, tenantId: undefined },
    { id: `${p}s2b`, runId: `${p}p2b`, tenantId: undefined },
    { id: `${p}s3`, runId: `${p}p3`, tenantId: undefined },
    { id: `${p}s6`, runId: `${p}p6`, tenantId: undefined },
  ]);
  push('unservedOrder', [{ id: `${p}un1`, scenarioId: `${p}s2b`, orderId: `${p}o2`, tenantId: undefined }]);
  push('planLoad', [
    { id: `${p}ld2`, runId: `${p}p2b`, truckId: `${p}t1`, loadNo: 1, driverId: `${p}cas1`, status: 'COMPLETED' },
    { id: `${p}ld3`, runId: `${p}p3`, truckId: `${p}t1`, loadNo: 1, driverId: `${p}reg1`, status: 'DISPATCHED' },
    { id: `${p}ld6`, runId: `${p}p6`, truckId: `${p}t1`, loadNo: 1, driverId: `${p}cas4`, status: 'PLANNED' },
  ]);
  push('routeAssignment', [
    { id: `${p}ra1`, runId: `${p}p2b`, loadId: `${p}ld2`, orderId: `${p}o1`, truckId: `${p}t1`, tenantId: undefined },
    { id: `${p}ra3`, runId: `${p}p3`, loadId: `${p}ld3`, orderId: `${p}o3`, truckId: `${p}t1`, tenantId: undefined },
    { id: `${p}ra6`, runId: `${p}p6`, loadId: `${p}ld6`, orderId: `${p}o6`, truckId: `${p}t1`, tenantId: undefined },
  ]);
  push('runJob', [
    { id: `${p}j2`, runId: `${p}p2b`, status: 'SUCCEEDED' },
    { id: `${p}j3`, runId: `${p}p3`, status: 'FAILED' },
    { id: `${p}j6`, runId: `${p}p6`, status: 'SUCCEEDED' },
  ]);
  push('manualBaseline', [{ id: `${p}mb`, runId: `${p}p2a`, createdAt: new Date('2026-10-02T12:00:00Z') }]);
  push('manualBaselineAssignment', [{ id: `${p}mba`, baselineId: `${p}mb`, orderId: `${p}o1`, tenantId: undefined }]);
  push('driverLink', [
    { id: `${p}dl2`, truckId: `${p}t1`, deliveryDate: day('2026-10-02') },
    { id: `${p}dl6`, truckId: `${p}t1`, deliveryDate: day('2026-10-06') },
  ]);
  push('stopVisit', [
    { id: `${p}v2`, depotId: `${p}dep`, truckId: `${p}t1`, customerId: `${p}c1`, deliveryDate: day('2026-10-02') },
    { id: `${p}v3`, depotId: `${p}dep`, truckId: `${p}t1`, customerId: `${p}c1`, deliveryDate: day('2026-10-03') },
    { id: `${p}v6`, depotId: `${p}dep`, truckId: `${p}t1`, customerId: `${p}c2`, deliveryDate: day('2026-10-06') },
  ]);
  const ev = { depotId: `${p}dep`, truckId: `${p}t1` };
  push('stopEvent', [
    { id: `${p}e2`, ...ev, visitId: `${p}v2`, driverLinkId: `${p}dl2`, deliveryDate: day('2026-10-02') },
    { id: `${p}e2d`, ...ev, visitId: null, driverLinkId: `${p}dl2`, deliveryDate: day('2026-10-02') }, // back at the depot (load level)
    { id: `${p}e3`, ...ev, visitId: `${p}v3`, driverLinkId: null, deliveryDate: day('2026-10-03') },
    { id: `${p}e6`, ...ev, visitId: `${p}v6`, driverLinkId: `${p}dl6`, deliveryDate: day('2026-10-06') },
  ]);
  push('deliveryPhoto', [
    { id: `${p}ph2`, visitId: `${p}v2`, driverLinkId: `${p}dl2` },
    { id: `${p}ph6`, visitId: `${p}v6`, driverLinkId: `${p}dl6` },
  ]);
  push('driverShift', [{ id: `${p}sh`, driverId: `${p}reg1`, truckId: `${p}t1`, runId: `${p}p2b`, startedAt: new Date('2026-10-02T03:00:00Z') }]);
  push('truckLocation', [{ id: `${p}tl`, shiftId: `${p}sh` }]);
  push('deliveryProof', [{ id: `${p}dp`, shiftId: `${p}sh`, assignmentId: `${p}ra1` }]);
  push('auditLog', [
    { id: `${p}a1`, action: 'LOAD_DISPATCHED', entity: 'PlanLoad' },
    { id: `${p}a2`, action: 'CASUAL_DRIVER_ADDED', entity: 'Driver' },
  ]);
  push('customerTypeProfile', [{ id: `${p}ctp` }]);
  // The hire suggestion: no check running (a running one refuses the run).
  tables.hireSuggestion ??= [];
}

const MASTERS = ['tenant', 'tenantConfig', 'user', 'depot', 'region', 'customer', 'product', 'truck', 'customerTypeProfile'];
/** Every row of one company: its tenant row, rows with its tenantId, and its child rows without one (ids start with its prefix). */
const companyRows = (tenantId: string, prefix: string) =>
  Object.fromEntries(
    Object.entries(tables).map(([m, rows]) => [m, structuredClone(rows.filter((r) => r.id === tenantId || r.tenantId === tenantId || String(r.id).startsWith(prefix)))]),
  );
const idsOf = (model: string, prefix: string) => (tables[model] ?? []).map((r) => r.id).filter((id: string) => id.startsWith(prefix)).sort();

beforeEach(() => {
  resetDb();
  seedCompany('tA', 'a');
  seedCompany('tB', 'b');
  deletes = [];
  enforceForeignKeys();
});

describe('the test database', () => {
  it('refuses a delete the real foreign keys refuse (orders still on a plan, a driver still on a load)', async () => {
    await expect(fakePrisma.order.deleteMany({ where: { id: 'ao1' } })).rejects.toThrow(/routeAssignment\.orderId/);
    await expect(fakePrisma.driver.deleteMany({ where: { id: 'acas1' } })).rejects.toThrow(/planLoad\.driverId/);
    await expect(fakePrisma.order.deleteMany({ where: { id: 'ao2' } })).rejects.toThrow(/unservedOrder\.orderId|order\.carriedFromOrderId/);
    expect(danglingReferences()).toEqual([]);
  });
});

describe('pure parts', () => {
  it('the typed confirmation is the company code, case and outer spaces ignored; never an empty code', () => {
    expect(startFreshConfirmMatches(' A-CO ', 'a-co')).toBe(true);
    expect(startFreshConfirmMatches('a-c0', 'a-co')).toBe(false);
    expect(startFreshConfirmMatches('', '')).toBe(false);
    expect(startFreshConfirmMatches(undefined, 'a-co')).toBe(false);
  });
  it('the total does not count the "of which" lines twice; every key has a label', () => {
    const removed = Object.fromEntries(START_FRESH_REMOVED.map((r) => [r.key, 1]));
    expect(startFreshTotal(removed)).toBe(START_FRESH_REMOVED.filter((r) => !('sub' in r)).length);
    expect(new Set(START_FRESH_REMOVED.map((r) => r.key)).size).toBe(START_FRESH_REMOVED.length);
    expect(new Set(START_FRESH_KEPT.map((r) => r.key)).size).toBe(START_FRESH_KEPT.length);
  });
});

describe('preview (nothing is changed)', () => {
  it('counts everything of this company only, and what is kept', async () => {
    const before = structuredClone(tables);
    const r = await preview(null);
    expect(tables).toEqual(before);
    expect(r.before).toBeNull();
    expect(r.blockers).toEqual([]);
    expect(r.removed).toEqual({
      uploadBatches: 3,
      orders: 4,
      lateOrders: 1,
      broughtForward: 1,
      deliveryTimes: 1,
      orderLines: 4,
      planVersions: 4,
      planOptions: 4,
      optimizationJobs: 3,
      loads: 3,
      stops: 3,
      unserved: 1,
      driverLinks: 2,
      stopVisits: 3,
      stopEvents: 4,
      deliveryPhotos: 2,
      dailyDrivers: 3, // cas1, cas3, cas4: cas2 is a truck's default driver
      hiredTrucks: 0,
      baselines: 1,
      oldDriverApp: 3, // a shift, its position and its proof
    });
    expect(r.kept).toEqual({ customers: 2, products: 1, trucks: 1, drivers: 1, dailyDrivers: 1, depots: 1, regions: 1, users: 2, auditRows: 2, orderFiles: 0 });
    expect(r.orderDates).toEqual({ from: '2026-10-02', to: '2026-10-06' });
    // Live-looking data in "Everything": the completed load of the 2nd, the dispatched one of the 3rd,
    // the order and the driver link of the 6th (today is the 4th).
    expect(r.live).toEqual({ today: '2026-10-04', frozenLoads: 2, ordersFromToday: 1, driverLinksFromToday: 1 });
  });

  it('only before a date: what is on or after it stays', async () => {
    const r = await preview('2026-10-04');
    expect(r.blockers).toEqual([]);
    expect(r.removed).toMatchObject({
      uploadBatches: 2, // b1 (2 Oct) and the deleted file uploaded 30 Sep; b6 stays
      orders: 3,
      orderLines: 3,
      planVersions: 3,
      loads: 2,
      stops: 2,
      optimizationJobs: 2,
      driverLinks: 1,
      stopVisits: 2,
      stopEvents: 3,
      deliveryPhotos: 1,
      dailyDrivers: 2, // cas1 and cas3; cas4 is on the load of the 6th, cas2 a default driver
      baselines: 1,
      oldDriverApp: 3,
    });
    expect(r.kept.dailyDrivers).toBe(2);
    expect(r.kept.orderFiles).toBe(1); // b6
    expect(r.orderDates).toEqual({ from: '2026-10-02', to: '2026-10-03' });
    expect(r.live).toEqual({ today: '2026-10-04', frozenLoads: 2, ordersFromToday: 0, driverLinksFromToday: 0 });
  });
});

describe('live-looking data (loads that left, orders and links from today on)', () => {
  it('the preview names them in one line; a run without the extra tick is refused (409 LIVE_DATA_CONFIRM), nothing removed', async () => {
    const r = await preview(null);
    expect(startFreshHasLive(r.live)).toBe(true);
    expect(startFreshLiveText(r.live)).toMatch(/2 loads already locked, loading, dispatched or completed/);
    expect(startFreshLiveText(r.live)).toMatch(/1 order dated today \(2026-10-04\) or later/);
    expect(startFreshLiveText(r.live)).toMatch(/1 driver link/);
    const snapshot = structuredClone(tables);
    await expect(runStartFresh('tA', null, actor, null, { now: NOW })).rejects.toMatchObject({ status: 409, details: { code: 'LIVE_DATA_CONFIRM' } });
    await expect(runStartFresh('tA', null, actor, null, { now: NOW, liveDataConfirmed: false })).rejects.toMatchObject({ details: { code: 'LIVE_DATA_CONFIRM' } });
    expect(tables).toEqual(snapshot);
  });

  it('with the tick it runs, and the audit row records the tick and what was live', async () => {
    const r = await run(null);
    expect(r.live).toEqual({ today: '2026-10-04', frozenLoads: 2, ordersFromToday: 1, driverLinksFromToday: 1 });
    expect(startFreshLiveText(r.live, true)).toBe(
      'This included 2 loads already locked, loading, dispatched or completed, 1 order dated today (2026-10-04) or later and 1 driver link (QR codes) for today or later.',
    );
    expect(tables.auditLog!.filter((a) => a.tenantId === 'tA').at(-1)!.afterJson).toMatchObject({ liveDataConfirmed: true, live: r.live });
  });

  it('nothing live in scope: no tick needed', async () => {
    for (const l of tables.planLoad!) if (l.tenantId === 'tA') l.status = 'PLANNED';
    const r = await preview('2026-10-04');
    expect(startFreshHasLive(r.live)).toBe(false);
    expect(startFreshLiveText(r.live)).toBeNull();
    await runStartFresh('tA', '2026-10-04', actor, null, { now: NOW });
    expect(idsOf('order', 'a')).toEqual(['ao6']);
  });
});

describe('the run removes only what the preview showed (PREVIEW_STALE)', () => {
  it('more orders (or other dates) than shown: 409 PREVIEW_STALE, nothing removed; the same numbers run', async () => {
    const shown = startFreshShown(await preview(null));
    tables.order!.push({ id: 'anew', tenantId: 'tA', customerId: 'ac1', depotId: 'adep', deliveryDate: day('2026-10-01'), isLate: false, carriedFromOrderId: null, carriedToOrderId: null, uploadBatchId: null });
    const fresh = await preview(null);
    expect(startFreshStale(shown, fresh)).toEqual(['Orders: 4 shown, now 5', 'Order dates: 2026-10-02 to 2026-10-06 shown, now 2026-10-01 to 2026-10-06']);
    const snapshot = structuredClone(tables);
    await expect(run(null, { shown })).rejects.toMatchObject({ status: 409, details: { code: 'PREVIEW_STALE' } });
    expect(tables).toEqual(snapshot);
    // Checked again: the new numbers run.
    const r = await run(null, { shown: startFreshShown(fresh) });
    expect(r.removed.orders).toBe(5);
  });

  it('a new live load since the check is stale too; fewer rows than shown is not', async () => {
    const shown = startFreshShown(await preview(null));
    tables.planLoad!.find((l) => l.id === 'ald6')!.status = 'DISPATCHED';
    expect(startFreshStale(shown, await preview(null))).toEqual(['Loads already locked, loading, dispatched or completed: 2 shown, now 3']);
    await expect(run(null, { shown })).rejects.toMatchObject({ details: { code: 'PREVIEW_STALE' } });
    tables.planLoad!.find((l) => l.id === 'ald6')!.status = 'PLANNED';
    tables.deliveryPhoto = tables.deliveryPhoto!.filter((p) => p.id !== 'aph2');
    await run(null, { shown });
    expect(idsOf('order', 'a')).toEqual([]);
  });
});

describe('run: everything', () => {
  it('removes the test data in foreign-key order, keeps masters and the audit log, adds one audit row; the other company is untouched', async () => {
    const other = companyRows('tB', 'b');
    const mastersA = Object.fromEntries(MASTERS.map((m) => [m, structuredClone((tables[m] ?? []).filter((r) => r.tenantId === 'tA' || r.id === 'tA'))]));
    const r = await run(null, {}, '10.0.0.1');

    // Nothing left of the activity data of company A.
    for (const m of ['uploadBatch', 'order', 'orderLine', 'intakeLineKey', 'runPlan', 'scenarioResult', 'unservedOrder', 'planLoad', 'routeAssignment', 'runJob', 'manualBaseline', 'manualBaselineAssignment', 'driverLink', 'stopVisit', 'stopEvent', 'deliveryPhoto', 'driverShift', 'truckLocation', 'deliveryProof']) {
      expect(idsOf(m, 'a'), m).toEqual([]);
    }
    // Daily drivers: only the truck's default driver stays; the regular driver stays.
    expect(idsOf('driver', 'a')).toEqual(['acas2', 'areg1']);
    // Masters unchanged.
    for (const m of MASTERS) expect((tables[m] ?? []).filter((x) => x.tenantId === 'tA' || x.id === 'tA'), m).toEqual(mastersA[m]);
    // Company B exactly as it was.
    expect(companyRows('tB', 'b')).toEqual(other);
    // No row anywhere points at a row that is gone.
    expect(danglingReferences()).toEqual([]);
    // Audit: the old rows stay, one TEST_DATA_CLEARED row with the counts and who did it.
    const auditA = tables.auditLog!.filter((a) => a.tenantId === 'tA');
    expect(auditA.map((a) => a.action)).toEqual(['LOAD_DISPATCHED', 'CASUAL_DRIVER_ADDED', 'TEST_DATA_CLEARED']);
    const row = auditA[2]!;
    expect(row).toMatchObject({ userId: 'uA', entity: 'Tenant', entityId: 'tA', ip: '10.0.0.1' });
    expect(row.afterJson).toMatchObject({ before: null, removed: r.removed, kept: r.kept, backupConfirmed: true, by: { name: 'Owner', email: 'owner@a.example' } });
    expect(r.removed).toMatchObject({ orders: 4, planVersions: 4, dailyDrivers: 3, stopEvents: 4, oldDriverApp: 3 });
  });

  it('deletes children before the rows they point at (the documented order)', async () => {
    await run(null);
    const first = (m: string) => deletes.indexOf(m);
    const last = (m: string) => deletes.lastIndexOf(m);
    expect(first('unservedOrder')).toBeGreaterThanOrEqual(0);
    expect(last('unservedOrder')).toBeLessThan(first('order'));
    expect(last('routeAssignment')).toBeLessThan(first('order'));
    expect(last('routeAssignment')).toBeLessThan(first('planLoad'));
    expect(last('planLoad')).toBeLessThan(first('runPlan'));
    expect(last('runJob')).toBeLessThan(first('runPlan'));
    expect(last('scenarioResult')).toBeLessThan(first('runPlan'));
    expect(last('intakeLineKey')).toBeLessThan(first('orderLine'));
    expect(last('orderLine')).toBeLessThan(first('order'));
    expect(last('deliveryPhoto')).toBeLessThan(first('stopVisit'));
    expect(last('stopEvent')).toBeLessThan(first('stopVisit'));
    expect(last('stopVisit')).toBeLessThan(first('driverLink'));
    expect(last('planLoad')).toBeLessThan(first('driver'));
    expect(last('driverShift')).toBeLessThan(first('driver'));
    // The list the handbook documents is the order the code follows.
    const seen = START_FRESH_DELETE_ORDER.filter((m) => deletes.includes(m));
    expect(seen).toEqual(START_FRESH_DELETE_ORDER);
    expect([...new Set(deletes)]).toEqual(START_FRESH_DELETE_ORDER);
  });

  it('takes the locks first: lock timeout, the intake lock, the outcome-day and driver-link locks of the days in scope, then the plan rows and the driver links', async () => {
    const calls: { sql: string; values: unknown[] }[] = [];
    const raw = fakePrisma.$queryRaw;
    fakePrisma.$queryRaw = async (s: TemplateStringsArray, ...v: unknown[]) => {
      calls.push({ sql: s.join('?').replace(/\s+/g, ' ').trim(), values: v });
      return raw(s, ...v);
    };
    rawLog.length = 0;
    try {
      await run('2026-10-04');
    } finally {
      fakePrisma.$queryRaw = raw;
    }
    expect(rawLog[0]).toMatch(/SET LOCAL lock_timeout = '\d+ms'/);
    expect(calls[0]!.sql).toMatch(/pg_advisory_xact_lock\(hashtextextended\(\?, 0\)\)/); // intake
    // Every depot-day in scope (lib/delivery/locks.ts: every driver and office result, arrival and photo
    // takes it first), then every truck-day (lib/driver-link/service.ts: a link issued, reissued or revoked).
    expect(calls[1]!.sql).toMatch(/unnest\(\?::text\[\]\).*pg_advisory_xact_lock\(hashtextextended\(k\.key, 0\)\)/);
    expect(calls[1]!.values[0]).toEqual(['outcomes:tA|adep|2026-10-02', 'outcomes:tA|adep|2026-10-03']);
    expect(calls[2]!.sql).toMatch(/unnest\(\?::text\[\]\).*pg_advisory_xact_lock/);
    expect(calls[2]!.values[0]).toEqual(['driver-link:tA|at1|2026-10-02', 'driver-link:tA|at1|2026-10-03']);
    expect(calls[3]!.sql).toMatch(/SELECT id FROM "RunPlan" WHERE "tenantId" = \? AND "runDate" < \?::date ORDER BY id FOR UPDATE/);
    expect(calls[4]!.sql).toMatch(/SELECT id FROM "DriverLink" WHERE "tenantId" = \? AND "deliveryDate" < \?::date ORDER BY id FOR UPDATE/);
    expect(calls).toHaveLength(5);
  });

  it('everything: the same locks for every day of the company', async () => {
    rawLog.length = 0;
    await run(null);
    expect(rawLog.slice(1)).toEqual([
      'SELECT 1 AS locked FROM pg_advisory_xact_lock(hashtextextended(?, 0))',
      'SELECT 1 AS locked FROM unnest(?::text[]) AS k(key), LATERAL pg_advisory_xact_lock(hashtextextended(k.key, 0))',
      'SELECT 1 AS locked FROM unnest(?::text[]) AS k(key), LATERAL pg_advisory_xact_lock(hashtextextended(k.key, 0))',
      'SELECT id FROM "RunPlan" WHERE "tenantId" = ? ORDER BY id FOR UPDATE',
      'SELECT id FROM "DriverLink" WHERE "tenantId" = ? ORDER BY id FOR UPDATE',
    ]);
  });

  it('delivery results, photos and driver links written after the check go too (removed by company and date, not by ids read earlier)', async () => {
    // A driver's phone (or the office) records a result between the counting and the removal: a new
    // stop result with an event and a photo on a link of the 2nd, and a link issued for the 3rd.
    let injected = false;
    const fkDelete = fakePrisma.unservedOrder.deleteMany;
    fakePrisma.unservedOrder.deleteMany = async (a: Row) => {
      if (!injected) {
        injected = true;
        const at = { tenantId: 'tA', depotId: 'adep', truckId: 'at1', deliveryDate: day('2026-10-02') };
        tables.stopVisit!.push({ id: 'avlate', ...at, customerId: 'ac2', loadNo: 1, sequence: 2 });
        tables.stopEvent!.push({ id: 'aelate', ...at, visitId: 'avlate', driverLinkId: 'adl2' });
        tables.deliveryPhoto!.push({ id: 'aphlate', tenantId: 'tA', visitId: 'avlate', driverLinkId: 'adl2' });
        tables.driverLink!.push({ id: 'adl3', tenantId: 'tA', truckId: 'at1', deliveryDate: day('2026-10-03') });
      }
      return fkDelete(a);
    };
    const r = await run('2026-10-04');
    expect(injected).toBe(true);
    expect(idsOf('stopVisit', 'a')).toEqual(['av6']);
    expect(idsOf('stopEvent', 'a')).toEqual(['ae6']);
    expect(idsOf('deliveryPhoto', 'a')).toEqual(['aph6']);
    expect(idsOf('driverLink', 'a')).toEqual(['adl6']);
    expect(danglingReferences()).toEqual([]);
    // The summary counts what was really deleted.
    expect(r.removed).toMatchObject({ stopVisits: 3, stopEvents: 4, deliveryPhotos: 2, driverLinks: 2 });
  });

  it('a second run finds nothing left to remove (the daily driver who is a truck default stays) and still writes its audit row', async () => {
    await run(null);
    const again = await run(null);
    expect(startFreshTotal(again.removed)).toBe(0);
    expect(tables.auditLog!.filter((a) => a.tenantId === 'tA' && a.action === 'TEST_DATA_CLEARED')).toHaveLength(2);
  });
});

describe('one-day hired trucks (the hire suggestion, review of the hire branch)', () => {
  /** "Use this plan" during the tests rented trucks for the 2nd and the 7th; one of the 2nd also sits on a kept load. */
  function rent() {
    tables.hireOption = [{ id: 'aopt', tenantId: 'tA', depotId: 'adep', label: '10-ton', maxPerDay: 2, active: true }];
    tables.truck!.push(
      { id: 'ah2', tenantId: 'tA', depotId: 'adep', code: 'HIRE-10T-0210-1', hired: true, onlyOnDate: day('2026-10-02'), hireOptionId: 'aopt', active: true, defaultDriverId: 'acas3' },
      { id: 'ah7', tenantId: 'tA', depotId: 'adep', code: 'HIRE-10T-0710-1', hired: true, onlyOnDate: day('2026-10-07'), hireOptionId: 'aopt', active: true },
      { id: 'ah2b', tenantId: 'tA', depotId: 'adep', code: 'HIRE-10T-0210-2', hired: true, onlyOnDate: day('2026-10-02'), hireOptionId: 'aopt', active: true },
    );
    // ah2 carried the load of the 2nd (removed with its plan).
    row('planLoad', 'ald2').truckId = 'ah2';
    // ah2b is named by a load of the 6th (a plan that stays when only before the 4th is removed).
    tables.planLoad!.push({ id: 'ald6b', tenantId: 'tA', runId: 'ap6', truckId: 'ah2b', loadNo: 2, driverId: null, status: 'PLANNED' });
  }
  const row = (m: string, id: string) => tables[m]!.find((r) => r.id === id)!;

  it('everything: the one-day trucks go with the test data (never planned on their date as fleet, never counted against max per day)', async () => {
    rent();
    const p = await preview(null);
    expect(p.removed.hiredTrucks).toBe(3);
    expect(p.kept.trucks).toBe(1);
    const r = await run(null);
    expect(r.removed.hiredTrucks).toBe(3);
    expect(idsOf('truck', 'a')).toEqual(['at1']);
    expect(danglingReferences()).toEqual([]);
    // The daily driver who was only the rented truck's default driver goes too.
    expect(idsOf('driver', 'a')).toEqual(['acas2', 'areg1']);
    expect(tables.auditLog!.filter((a) => a.tenantId === 'tA').at(-1)!.afterJson).toMatchObject({ removed: { hiredTrucks: 3 } });
  });

  it('only before a date: the trucks of those days go; one still named by a kept load is retired (never planned again); later ones stay', async () => {
    rent();
    const r = await run('2026-10-04');
    expect(r.removed.hiredTrucks).toBe(2);
    expect(idsOf('truck', 'a')).toEqual(['ah2b', 'ah7', 'at1']);
    expect(row('truck', 'ah2b').active).toBe(false);
    expect(row('truck', 'ah7').active).toBe(true);
    expect(danglingReferences()).toEqual([]);
  });

  it('refused while a hire check of this company waits or runs', async () => {
    tables.hireSuggestion = [{ id: 'hs', tenantId: 'tA', runId: 'ap6', status: 'RUNNING' }];
    const p = await preview(null);
    expect(p.blockers.map((b) => b.code)).toEqual(['HIRE_CHECK_RUNNING']);
    await expect(run(null)).rejects.toMatchObject({ status: 409, details: { code: 'HIRE_CHECK_RUNNING' } });
  });
});

describe('refusals', () => {
  it('refused while an optimization of this company is queued or running: nothing removed, nothing audited', async () => {
    for (const status of ['QUEUED', 'RUNNING']) {
      resetDb();
      seedCompany('tA', 'a');
      seedCompany('tB', 'b');
      enforceForeignKeys();
      tables.runJob!.push({ id: 'live', tenantId: 'tA', runId: 'ap6', status });
      const snapshot = structuredClone(tables);
      const p = await preview(null);
      expect(p.blockers.map((b) => b.code)).toEqual(['OPTIMIZATION_RUNNING']);
      expect(p.blockers[0]!.message).toMatch(/2026-10-06/);
      await expect(run(null)).rejects.toMatchObject({ status: 409, details: { code: 'OPTIMIZATION_RUNNING' } });
      expect(tables).toEqual(snapshot);
    }
  });

  it("another company's optimization does not block this one", async () => {
    tables.runJob!.push({ id: 'liveB', tenantId: 'tB', runId: 'bp6', status: 'RUNNING' });
    expect((await preview(null)).blockers).toEqual([]);
    await run(null);
    expect(idsOf('runJob', 'b')).toEqual(['bj2', 'bj3', 'bj6']);
    expect(tables.runJob!.find((j) => j.id === 'liveB')).toBeTruthy();
  });

  it('only before a date that splits a Bring forward (original before, copy on or after): refused, the dates named, with a safe earlier and later date', async () => {
    const p = await preview('2026-10-03');
    expect(p.blockers.map((b) => b.code)).toEqual(['CARRIED_ACROSS_DATE']);
    expect(p.blockers[0]!.message).toMatch(/1 order on 2026-10-03 was brought forward from a day before 2026-10-03/);
    expect(p.blockers[0]!.message).toMatch(/Choose 2026-10-02 \(keeps .*\) or 2026-10-04 \(removes .*\), undo the Bring forward first, or remove everything/);
    const snapshot = structuredClone(tables);
    await expect(run('2026-10-03')).rejects.toMatchObject({ status: 409, details: { code: 'CARRIED_ACROSS_DATE' } });
    expect(tables).toEqual(snapshot);
    for (const safe of ['2026-10-02', '2026-10-04']) expect((await preview(safe)).blockers, safe).toEqual([]);
  });

  it('an order brought forward twice (2nd -> 3rd -> 4th): the suggested dates pass at once, never a date that is refused again', async () => {
    // ao3 (3 Oct, carried from ao2 of the 2nd) carried again to a new order on the 4th.
    tables.order!.push({ id: 'ao4', tenantId: 'tA', customerId: 'ac1', depotId: 'adep', deliveryDate: day('2026-10-04'), isLate: false, carriedFromOrderId: 'ao3', carriedToOrderId: null, uploadBatchId: null });
    tables.order!.find((o) => o.id === 'ao3')!.carriedToOrderId = 'ao4';
    const p = await preview('2026-10-04');
    expect(p.blockers.map((b) => b.code)).toEqual(['CARRIED_ACROSS_DATE']);
    // Not 2026-10-03 (the 3rd is itself a copy of the 2nd: refused again), but the chain's first day,
    // and the day after its last copy.
    expect(p.blockers[0]!.message).toMatch(/Choose 2026-10-02 \(.*\) or 2026-10-05 \(.*\)/);
    expect((await preview('2026-10-03')).blockers.map((b) => b.code)).toEqual(['CARRIED_ACROSS_DATE']);
    expect((await preview('2026-10-02')).blockers).toEqual([]);
    expect((await preview('2026-10-05')).blockers).toEqual([]);
  });

  it('the safe dates: the largest date not after the chosen one, and the smallest after it, that split no Bring forward', () => {
    const spans = [
      { lo: '2026-10-02', hi: '2026-10-03' },
      { lo: '2026-10-03', hi: '2026-10-04' },
      { lo: '2026-09-28', hi: '2026-10-02' }, // another chain that ends where the first starts
      { lo: '2026-10-10', hi: '2026-10-12' }, // far away: not in the way
    ];
    expect(startFreshSafeCutoffs(spans, '2026-10-04')).toEqual({ earlier: '2026-09-28', later: '2026-10-05' });
    expect(startFreshSafeCutoffs(spans, '2026-10-11')).toEqual({ earlier: '2026-10-10', later: '2026-10-13' });
    expect(startFreshSafeCutoffs(spans, '2026-10-07')).toEqual({ earlier: '2026-10-07', later: '2026-10-07' });
  });

  it('a plan on or after the date that names an order from before it: refused (never a broken plan)', async () => {
    tables.routeAssignment!.push({ id: 'odd', runId: 'ap6', loadId: 'ald6', orderId: 'ao1', truckId: 'at1' });
    const p = await preview('2026-10-04');
    expect(p.blockers.map((b) => b.code)).toEqual(['PLAN_ACROSS_DATE']);
    await expect(run('2026-10-04')).rejects.toMatchObject({ status: 409, details: { code: 'PLAN_ACROSS_DATE' } });
  });
});

describe('run: only before a date', () => {
  it('removes what is before the date; what is on or after it, and the other company, stay', async () => {
    const other = companyRows('tB', 'b');
    const r = await run('2026-10-04');
    expect(idsOf('order', 'a')).toEqual(['ao6']);
    expect(idsOf('orderLine', 'a')).toEqual(['al-o6']);
    expect(idsOf('intakeLineKey', 'a')).toEqual(['ak-o6']);
    expect(idsOf('uploadBatch', 'a')).toEqual(['ab6']);
    expect(idsOf('runPlan', 'a')).toEqual(['ap6']);
    expect(idsOf('planLoad', 'a')).toEqual(['ald6']);
    expect(idsOf('routeAssignment', 'a')).toEqual(['ara6']);
    expect(idsOf('scenarioResult', 'a')).toEqual(['as6']);
    expect(idsOf('runJob', 'a')).toEqual(['aj6']);
    expect(idsOf('driverLink', 'a')).toEqual(['adl6']);
    expect(idsOf('stopVisit', 'a')).toEqual(['av6']);
    expect(idsOf('stopEvent', 'a')).toEqual(['ae6']);
    expect(idsOf('deliveryPhoto', 'a')).toEqual(['aph6']);
    expect(idsOf('driver', 'a')).toEqual(['acas2', 'acas4', 'areg1']);
    expect(companyRows('tB', 'b')).toEqual(other);
    expect(danglingReferences()).toEqual([]);
    expect(tables.auditLog!.filter((a) => a.tenantId === 'tA').at(-1)!.afterJson).toMatchObject({ before: '2026-10-04', removed: r.removed });
  });

  it('an order file not confirmed yet whose lines reach the date or later is kept (counted as kept); one with every line before it goes', async () => {
    // Uploaded on the 3rd for the 3rd and the 4th (UploadBatch.deliveryDate is the file's earliest date),
    // not confirmed: no order yet. And one for the 2nd and 3rd only, uploaded with errors.
    tables.uploadBatch!.push(
      { id: 'abst', tenantId: 'tA', depotId: 'adep', deliveryDate: day('2026-10-03'), uploadedAt: new Date('2026-10-03T08:00:00Z'), status: 'VALIDATED', validationJson: { totals: { deliveryDates: ['2026-10-03', '2026-10-04'] }, fileDeliveryDates: ['2026-10-03', '2026-10-04'] } },
      { id: 'abold', tenantId: 'tA', depotId: 'adep', deliveryDate: day('2026-10-02'), uploadedAt: new Date('2026-10-01T08:00:00Z'), status: 'PARSED', validationJson: { totals: { deliveryDates: ['2026-10-02'] }, fileDeliveryDates: ['2026-10-02', '2026-10-03'] } },
      // Only skipped rows reached the 4th: still a file for the kept day.
      { id: 'abskip', tenantId: 'tA', depotId: 'adep', deliveryDate: null, uploadedAt: new Date('2026-10-02T08:00:00Z'), status: 'PARSED', validationJson: { totals: { deliveryDates: [] }, fileDeliveryDates: ['2026-10-04'] } },
    );
    const p = await preview('2026-10-04');
    expect(p.removed.uploadBatches).toBe(3); // b1, the deleted file of 30 Sep, abold
    expect(p.kept.orderFiles).toBe(3); // b6, abst, abskip
    await run('2026-10-04');
    expect(idsOf('uploadBatch', 'a')).toEqual(['ab6', 'abskip', 'abst']);
    // Everything removes them all.
    await run(null);
    expect(idsOf('uploadBatch', 'a')).toEqual([]);
  });
});
