/**
 * "Start fresh (remove test data)" (owner request 4 Oct 2026, the day before the pilot). A company
 * admin (TENANT_ADMIN, or a platform admin on their own company) removes the company's test
 * activity so the pilot starts clean. The coordinator (PLANNER) cannot: the owner clicks it.
 * Route: app/api/tenant/start-fresh/route.ts (GET = preview, POST = run). Panel: Settings.
 *
 * Removed, for this company only (optionally only data with a delivery date before a chosen day):
 * order files, orders and their lines (late orders, Bring forward copies and per-order delivery
 * times are orders too), plan versions with their options, optimization jobs, loads, stops and
 * unserved rows, driver links, delivery results (stops, events, photos), manual comparison
 * baselines, the retired driver app's shifts / positions / proofs, and daily (casual) drivers that
 * no longer have any load (a daily driver who is a truck's default driver stays).
 * Kept: customers (locations, confirmed hours), products, trucks, regular drivers, depots, regions,
 * users, settings and customer type defaults, and the audit log, which is never deleted: the run
 * adds one TEST_DATA_CLEARED row with the counts and who did it.
 *
 * Safety: one transaction. It first sets a lock timeout, then takes the company's intake lock
 * (lib/dispatch/intake-server.ts: the optimize start, a confirmed order file, a late order and Bring
 * forward take it too), then locks the plan rows it removes (the documented lock order, plan-locks.ts),
 * and only then decides: refused (409, nothing removed) while an optimization of the company is
 * queued or running, and in "before a date" mode when the date would split a Bring forward or a plan
 * from its orders. Rows are deleted by the exact ids read under the locks, children first
 * (START_FRESH_DELETE_ORDER), so RouteAssignment.orderId (RESTRICT), UnservedOrder.orderId and the
 * Bring forward links (NO ACTION) never refuse. Every statement names the company (tenantId) or
 * ids read for it. Lists are sent in parts (IN_LIST_PART: PostgreSQL's bind parameter limit).
 */
import type { Prisma } from '@prisma/client';
import { prisma } from './db';
import { audit } from './audit';
import { HttpError } from './http-error';
import { inParts, lockIntake } from './dispatch/intake-server';
import { isLockBusy, setLockTimeout } from './dispatch/plan-locks';
import { DEFAULT_TZ, dateOnly, isoOf, zonedDayStart } from './dispatch/time';
import type { StartFreshBlocker, StartFreshKept, StartFreshRemoved, StartFreshReport } from './start-fresh-text';

type Db = Prisma.TransactionClient;

/** The tables Start fresh deletes from, in the order it deletes (children before the rows they point at). */
export const START_FRESH_DELETE_ORDER = [
  'unservedOrder',
  'deliveryProof',
  'truckLocation',
  'driverShift',
  'routeAssignment',
  'scenarioResult',
  'planLoad',
  'runJob',
  'manualBaselineAssignment',
  'manualBaseline',
  'runPlan',
  'intakeLineKey',
  'orderLine',
  'order',
  'uploadBatch',
  'deliveryPhoto',
  'stopEvent',
  'stopVisit',
  'driverLink',
  'driver',
] as const;

/** The run may hold its locks this long for big test data; a lock it waits for longer than LOCK_WAIT_MS answers 409. */
export const START_FRESH_TX = { timeout: 300_000, maxWait: 15_000 } as const;
const LOCK_WAIT_MS = 10_000;

/** POST: three runs per admin per 10 minutes; GET (preview): 30 a minute. */
export const START_FRESH_LIMITS = {
  run: { limit: 3, windowMs: 10 * 60_000 },
  preview: { limit: 30, windowMs: 60_000 },
} as const;

/** A refusal: nothing was removed. */
export class StartFreshRefused extends HttpError {
  constructor(message: string, code: string, status = 409) {
    super(message, status, { code });
    this.name = 'StartFreshRefused';
  }
}

export const START_FRESH_BUSY =
  'Someone is working on orders or plans of this company right now (an order file, a late order, Bring forward or an optimization being started). Nothing was removed: try again in a minute.';

interface Scope {
  tenantId: string;
  before: string | null;
  /** The DATE value of `before` (delivery dates, plan dates). */
  beforeDate: Date | null;
  /** Local midnight starting `before` in the company's time zone (upload times, old driver app shifts). */
  dayStart: Date | null;
}

interface OrderRow {
  id: string;
  deliveryDate: Date;
  isLate: boolean;
  carriedFromOrderId: string | null;
  carriedToOrderId: string | null;
  deliveryStartMin: number | null;
  deliveryEndMin: number | null;
}

interface Sets {
  runIds: string[];
  scenarioIds: string[];
  orderIds: string[];
  batchIds: string[];
  visitIds: string[];
  linkIds: string[];
  shiftIds: string[];
  baselineIds: string[];
  casualIds: string[];
}

const ids = (rows: { id: string }[]) => rows.map((r) => r.id);

/** The sum of `count` over the parts of `values` (nothing is asked for an empty list). */
async function countIn(values: string[], q: (part: string[]) => Promise<number>): Promise<number> {
  let n = 0;
  for (const part of inParts(values)) n += await q(part);
  return n;
}

/** deleteMany over the parts of `values`; the number of rows deleted. */
async function deleteIn(values: string[], q: (part: string[]) => Promise<{ count: number }>): Promise<number> {
  let n = 0;
  for (const part of inParts(values)) n += (await q(part)).count;
  return n;
}

async function scopeOf(db: Db, tenantId: string, before: string | null): Promise<Scope> {
  if (!before) return { tenantId, before: null, beforeDate: null, dayStart: null };
  const cfg = await db.tenantConfig.findFirst({ where: { tenantId }, select: { timezone: true } });
  return { tenantId, before, beforeDate: dateOnly(before), dayStart: zonedDayStart(before, cfg?.timezone || DEFAULT_TZ) };
}

/**
 * Daily drivers that will have no load left once the plans in `runIds` are gone: not a truck's
 * default driver, and not named by an old driver app shift that stays.
 */
async function removableCasualDrivers(db: Db, s: Scope, runIds: string[], shiftIds: string[]): Promise<{ casual: number; removable: string[] }> {
  const casual = ids(await db.driver.findMany({ where: { tenantId: s.tenantId, casual: true }, select: { id: true } }));
  if (!casual.length) return { casual: 0, removable: [] };
  const used = new Set<string>();
  for (const part of inParts(casual)) {
    const loads = await db.planLoad.findMany({
      where: { tenantId: s.tenantId, driverId: { in: part }, ...(runIds.length ? { runId: { notIn: runIds } } : {}) },
      select: { driverId: true },
    });
    for (const l of loads) if (l.driverId) used.add(l.driverId);
    const trucks = await db.truck.findMany({ where: { tenantId: s.tenantId, defaultDriverId: { in: part } }, select: { defaultDriverId: true } });
    for (const t of trucks) if (t.defaultDriverId) used.add(t.defaultDriverId);
    const shifts = await db.driverShift.findMany({
      where: { tenantId: s.tenantId, driverId: { in: part }, ...(shiftIds.length ? { id: { notIn: shiftIds } } : {}) },
      select: { driverId: true },
    });
    for (const sh of shifts) used.add(sh.driverId);
  }
  return { casual: casual.length, removable: casual.filter((id) => !used.has(id)) };
}

/** Why the run cannot go ahead now (empty: it can). */
async function blockersOf(db: Db, s: Scope, sets: Sets, orders: OrderRow[]): Promise<StartFreshBlocker[]> {
  const out: StartFreshBlocker[] = [];
  const live = await db.runJob.findMany({ where: { tenantId: s.tenantId, status: { in: ['QUEUED', 'RUNNING'] } }, select: { runId: true } });
  if (live.length) {
    const plans = await db.runPlan.findMany({ where: { tenantId: s.tenantId, id: { in: [...new Set(live.map((j) => j.runId))] } }, select: { runDate: true } });
    const days = [...new Set(plans.map((p) => isoOf(p.runDate)))].sort();
    out.push({
      code: 'OPTIMIZATION_RUNNING',
      message: `An optimization is queued or running for this company${days.length ? ` (plan of ${days.join(', ')})` : ''}. Nothing can be removed while it runs: wait until it has finished, or stop it, then try again.`,
    });
  }
  if (!s.beforeDate || !sets.orderIds.length) return out;

  // An order that stays (on or after the date) brought forward from, or to, an order that goes.
  const crossing: { id: string; deliveryDate: Date; carriedFromOrderId: string | null; carriedToOrderId: string | null }[] = [];
  for (const part of inParts(sets.orderIds)) {
    crossing.push(
      ...(await db.order.findMany({
        where: { tenantId: s.tenantId, deliveryDate: { gte: s.beforeDate }, OR: [{ carriedFromOrderId: { in: part } }, { carriedToOrderId: { in: part } }] },
        select: { id: true, deliveryDate: true, carriedFromOrderId: true, carriedToOrderId: true },
      })),
    );
  }
  if (crossing.length) {
    const linked = new Set(crossing.flatMap((o) => [o.carriedFromOrderId, o.carriedToOrderId]).filter((x): x is string => !!x));
    const originals = orders.filter((o) => linked.has(o.id)).map((o) => isoOf(o.deliveryDate)).sort();
    const days = [...new Set(crossing.map((o) => isoOf(o.deliveryDate)))].sort();
    out.push({
      code: 'CARRIED_ACROSS_DATE',
      message: `${crossing.length} order${crossing.length === 1 ? '' : 's'} on ${days.join(', ')} ${crossing.length === 1 ? 'was' : 'were'} brought forward from before ${s.before}: removing the earlier day would cut ${crossing.length === 1 ? 'it' : 'them'} from the original. Remove everything, or choose ${originals[0] ?? s.before} or an earlier date.`,
    });
  }

  // A plan that stays naming an order that goes (plans hold only their own day's orders: a safety net).
  let planRows = 0;
  for (const part of inParts(sets.orderIds)) {
    planRows += await db.routeAssignment.count({ where: { orderId: { in: part }, ...(sets.runIds.length ? { runId: { notIn: sets.runIds } } : {}) } });
    planRows += await db.unservedOrder.count({ where: { orderId: { in: part }, ...(sets.scenarioIds.length ? { scenarioId: { notIn: sets.scenarioIds } } : {}) } });
  }
  if (planRows) {
    out.push({
      code: 'PLAN_ACROSS_DATE',
      message: `A plan on or after ${s.before} includes orders from before it, so they cannot be removed on their own. Remove everything, or choose another date.`,
    });
  }
  return out;
}

/** What would be removed and kept, read with `db` (inside the run: under its locks). */
async function collect(db: Db, s: Scope): Promise<{ sets: Sets; report: StartFreshReport }> {
  const t = s.tenantId;
  const onDay = s.beforeDate ? { lt: s.beforeDate } : undefined;

  const runIds = ids(await db.runPlan.findMany({ where: { tenantId: t, ...(onDay ? { runDate: onDay } : {}) }, select: { id: true } }));
  const scenarioIds: string[] = [];
  for (const part of inParts(runIds)) scenarioIds.push(...ids(await db.scenarioResult.findMany({ where: { runId: { in: part } }, select: { id: true } })));

  const orders: OrderRow[] = await db.order.findMany({
    where: { tenantId: t, ...(onDay ? { deliveryDate: onDay } : {}) },
    select: { id: true, deliveryDate: true, isLate: true, carriedFromOrderId: true, carriedToOrderId: true, deliveryStartMin: true, deliveryEndMin: true },
  });
  const orderIds = ids(orders);

  // Order files: all of them; before a date, the files of earlier days (a file without a date: uploaded
  // before that day) that keep no order.
  let batchIds = ids(
    await db.uploadBatch.findMany({
      where: s.beforeDate ? { tenantId: t, OR: [{ deliveryDate: { lt: s.beforeDate } }, { deliveryDate: null, uploadedAt: { lt: s.dayStart! } }] } : { tenantId: t },
      select: { id: true },
    }),
  );
  if (s.beforeDate && batchIds.length) {
    const keepsOrders = new Set<string>();
    for (const part of inParts(batchIds)) {
      const kept = await db.order.findMany({ where: { tenantId: t, deliveryDate: { gte: s.beforeDate }, uploadBatchId: { in: part } }, select: { uploadBatchId: true } });
      for (const o of kept) if (o.uploadBatchId) keepsOrders.add(o.uploadBatchId);
    }
    batchIds = batchIds.filter((id) => !keepsOrders.has(id));
  }

  const visitIds = ids(await db.stopVisit.findMany({ where: { tenantId: t, ...(onDay ? { deliveryDate: onDay } : {}) }, select: { id: true } }));
  const linkIds = ids(await db.driverLink.findMany({ where: { tenantId: t, ...(onDay ? { deliveryDate: onDay } : {}) }, select: { id: true } }));
  const shiftIds = ids(
    await db.driverShift.findMany({
      where: s.dayStart ? { tenantId: t, OR: [{ startedAt: { lt: s.dayStart } }, ...(runIds.length ? [{ runId: { in: runIds } }] : [])] } : { tenantId: t },
      select: { id: true },
    }),
  );
  const baselineIds = ids(
    await db.manualBaseline.findMany({
      where: s.dayStart ? { tenantId: t, OR: [{ runId: null, createdAt: { lt: s.dayStart } }, ...(runIds.length ? [{ runId: { in: runIds } }] : [])] } : { tenantId: t },
      select: { id: true },
    }),
  );
  const casual = await removableCasualDrivers(db, s, runIds, shiftIds);
  const sets: Sets = { runIds, scenarioIds, orderIds, batchIds, visitIds, linkIds, shiftIds, baselineIds, casualIds: casual.removable };

  const removed: StartFreshRemoved = {
    uploadBatches: batchIds.length,
    orders: orderIds.length,
    lateOrders: orders.filter((o) => o.isLate).length,
    broughtForward: orders.filter((o) => o.carriedFromOrderId).length,
    deliveryTimes: orders.filter((o) => o.deliveryStartMin != null || o.deliveryEndMin != null).length,
    orderLines: await countIn(orderIds, (part) => db.orderLine.count({ where: { orderId: { in: part } } })),
    planVersions: runIds.length,
    planOptions: scenarioIds.length,
    optimizationJobs: await countIn(runIds, (part) => db.runJob.count({ where: { tenantId: t, runId: { in: part } } })),
    loads: await countIn(runIds, (part) => db.planLoad.count({ where: { tenantId: t, runId: { in: part } } })),
    stops: await countIn(runIds, (part) => db.routeAssignment.count({ where: { runId: { in: part } } })),
    unserved: await countIn(scenarioIds, (part) => db.unservedOrder.count({ where: { scenarioId: { in: part } } })),
    driverLinks: linkIds.length,
    stopVisits: visitIds.length,
    stopEvents: await db.stopEvent.count({ where: { tenantId: t, ...(onDay ? { deliveryDate: onDay } : {}) } }),
    deliveryPhotos: await countIn(visitIds, (part) => db.deliveryPhoto.count({ where: { tenantId: t, visitId: { in: part } } })),
    dailyDrivers: casual.removable.length,
    baselines: baselineIds.length,
    oldDriverApp:
      shiftIds.length +
      (await countIn(shiftIds, (part) => db.truckLocation.count({ where: { tenantId: t, shiftId: { in: part } } }))) +
      (await countIn(shiftIds, (part) => db.deliveryProof.count({ where: { tenantId: t, shiftId: { in: part } } }))),
  };
  const kept: StartFreshKept = {
    customers: await db.customer.count({ where: { tenantId: t } }),
    products: await db.product.count({ where: { tenantId: t } }),
    trucks: await db.truck.count({ where: { tenantId: t } }),
    drivers: await db.driver.count({ where: { tenantId: t, casual: false } }),
    dailyDrivers: casual.casual - casual.removable.length,
    depots: await db.depot.count({ where: { tenantId: t } }),
    regions: await db.region.count({ where: { tenantId: t } }),
    users: await db.user.count({ where: { tenantId: t } }),
    auditRows: await db.auditLog.count({ where: { tenantId: t } }),
  };
  const dates = orders.map((o) => isoOf(o.deliveryDate)).sort();
  const report: StartFreshReport = {
    before: s.before,
    removed,
    kept,
    orderDates: dates.length ? { from: dates[0]!, to: dates[dates.length - 1]! } : null,
    blockers: await blockersOf(db, s, sets, orders),
  };
  return { sets, report };
}

/** The preview: what a run would remove and keep now, and what would refuse it. Changes nothing. */
export async function previewStartFresh(tenantId: string, before: string | null): Promise<StartFreshReport> {
  const db = prisma as unknown as Db;
  return (await collect(db, await scopeOf(db, tenantId, before))).report;
}

/** Delete everything in `sets`, children first (START_FRESH_DELETE_ORDER). The numbers actually deleted. */
async function removeAll(tx: Db, s: Scope, sets: Sets): Promise<Partial<StartFreshRemoved>> {
  const t = s.tenantId;
  // 1. Plans: the rows that name orders (stops, unserved rows) and the retired driver app's rows first.
  const unserved = await deleteIn(sets.scenarioIds, (part) => tx.unservedOrder.deleteMany({ where: { scenarioId: { in: part } } }));
  const proofs = await deleteIn(sets.shiftIds, (part) => tx.deliveryProof.deleteMany({ where: { tenantId: t, shiftId: { in: part } } }));
  const positions = await deleteIn(sets.shiftIds, (part) => tx.truckLocation.deleteMany({ where: { tenantId: t, shiftId: { in: part } } }));
  const shifts = await deleteIn(sets.shiftIds, (part) => tx.driverShift.deleteMany({ where: { tenantId: t, id: { in: part } } }));
  const stops = await deleteIn(sets.runIds, (part) => tx.routeAssignment.deleteMany({ where: { runId: { in: part } } }));
  const options = await deleteIn(sets.runIds, (part) => tx.scenarioResult.deleteMany({ where: { runId: { in: part } } }));
  const loads = await deleteIn(sets.runIds, (part) => tx.planLoad.deleteMany({ where: { tenantId: t, runId: { in: part } } }));
  const jobs = await deleteIn(sets.runIds, (part) => tx.runJob.deleteMany({ where: { tenantId: t, runId: { in: part } } }));
  await deleteIn(sets.baselineIds, (part) => tx.manualBaselineAssignment.deleteMany({ where: { baselineId: { in: part } } }));
  const baselines = await deleteIn(sets.baselineIds, (part) => tx.manualBaseline.deleteMany({ where: { tenantId: t, id: { in: part } } }));
  const plans = await deleteIn(sets.runIds, (part) => tx.runPlan.deleteMany({ where: { tenantId: t, id: { in: part } } }));

  // 2. Orders: the Bring forward links between them first (NO ACTION both ways; the refusal above makes
  // sure no order that stays is linked to one that goes), then the lines' intake keys, the lines, the orders.
  for (const part of inParts(sets.orderIds)) {
    await tx.order.updateMany({
      where: { tenantId: t, id: { in: part }, OR: [{ carriedFromOrderId: { not: null } }, { carriedToOrderId: { not: null } }] },
      data: { carriedFromOrderId: null, carriedToOrderId: null },
    });
  }
  let lines = 0;
  let orders = 0;
  for (const part of inParts(sets.orderIds)) {
    const lineIds = ids(await tx.orderLine.findMany({ where: { orderId: { in: part } }, select: { id: true } }));
    await deleteIn(lineIds, (p) => tx.intakeLineKey.deleteMany({ where: { tenantId: t, orderLineId: { in: p } } }));
    lines += (await tx.orderLine.deleteMany({ where: { orderId: { in: part } } })).count;
    orders += (await tx.order.deleteMany({ where: { tenantId: t, id: { in: part } } })).count;
  }
  const batches = await deleteIn(sets.batchIds, (part) => tx.uploadBatch.deleteMany({ where: { tenantId: t, id: { in: part } } }));

  // 3. Delivery results: photos and events before their stops, the driver links last (events and photos name them).
  const photos = await deleteIn(sets.visitIds, (part) => tx.deliveryPhoto.deleteMany({ where: { tenantId: t, visitId: { in: part } } }));
  let events = (await tx.stopEvent.deleteMany({ where: { tenantId: t, ...(s.beforeDate ? { deliveryDate: { lt: s.beforeDate } } : {}) } })).count;
  events += await deleteIn(sets.visitIds, (part) => tx.stopEvent.deleteMany({ where: { tenantId: t, visitId: { in: part } } }));
  const visits = await deleteIn(sets.visitIds, (part) => tx.stopVisit.deleteMany({ where: { tenantId: t, id: { in: part } } }));
  const links = await deleteIn(sets.linkIds, (part) => tx.driverLink.deleteMany({ where: { tenantId: t, id: { in: part } } }));

  // 4. Daily drivers with no load left, decided again now that the loads are gone.
  const casual = (await removableCasualDrivers(tx, s, [], [])).removable;
  const drivers = await deleteIn(casual, (part) => tx.driver.deleteMany({ where: { tenantId: t, casual: true, id: { in: part } } }));

  return {
    uploadBatches: batches,
    orders,
    orderLines: lines,
    planVersions: plans,
    planOptions: options,
    optimizationJobs: jobs,
    loads,
    stops,
    unserved,
    driverLinks: links,
    stopVisits: visits,
    stopEvents: events,
    deliveryPhotos: photos,
    dailyDrivers: drivers,
    baselines,
    oldDriverApp: shifts + positions + proofs,
  };
}

/**
 * Run Start fresh for one company. Throws StartFreshRefused (409) when it cannot run now; nothing
 * is removed then. Returns what was removed (the numbers deleted) and kept.
 */
export async function runStartFresh(
  tenantId: string,
  before: string | null,
  actor: { id: string; name?: string | null; email?: string | null },
  ip: string | null,
): Promise<StartFreshReport> {
  try {
    return await prisma.$transaction(async (tx) => {
      await setLockTimeout(tx, LOCK_WAIT_MS);
      await lockIntake(tx, tenantId);
      if (before) {
        await tx.$queryRaw`SELECT id FROM "RunPlan" WHERE "tenantId" = ${tenantId} AND "runDate" < ${before}::date ORDER BY id FOR UPDATE`;
      } else {
        await tx.$queryRaw`SELECT id FROM "RunPlan" WHERE "tenantId" = ${tenantId} ORDER BY id FOR UPDATE`;
      }
      const s = await scopeOf(tx, tenantId, before);
      const { sets, report } = await collect(tx, s);
      const blocker = report.blockers[0];
      if (blocker) throw new StartFreshRefused(blocker.message, blocker.code);
      const done = await removeAll(tx, s, sets);
      const result: StartFreshReport = { ...report, removed: { ...report.removed, ...done } };
      await audit(
        {
          tenantId,
          userId: actor.id,
          action: 'TEST_DATA_CLEARED',
          entity: 'Tenant',
          entityId: tenantId,
          afterJson: {
            before,
            removed: result.removed,
            kept: result.kept,
            orderDates: result.orderDates,
            backupConfirmed: true,
            by: { name: actor.name ?? null, email: actor.email ?? null },
          } as unknown as Prisma.InputJsonValue,
          ip,
        },
        tx,
      );
      return result;
    }, START_FRESH_TX);
  } catch (e) {
    if (e instanceof StartFreshRefused) throw e;
    if (isLockBusy(e)) throw new StartFreshRefused(START_FRESH_BUSY, 'BUSY');
    // A row added under a load or an order while the run was deciding (a foreign key refused): nothing was removed.
    if ((e as { code?: unknown } | null)?.code === 'P2003') {
      throw new StartFreshRefused('Something changed in the orders or plans while removing. Nothing was removed: check again and try once more.', 'CHANGED');
    }
    throw e;
  }
}
