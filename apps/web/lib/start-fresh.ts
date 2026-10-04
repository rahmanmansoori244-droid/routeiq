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
 * no longer have any load (a daily driver who is a truck's default driver stays). Before a date, an
 * order file without orders goes only when every delivery date in it is before that day.
 * Kept: customers (locations, confirmed hours), products, trucks, regular drivers, depots, regions,
 * users, settings and customer type defaults, and the audit log, which is never deleted: the run
 * adds one TEST_DATA_CLEARED row with the counts and who did it.
 *
 * Safety: one transaction. It sets a lock timeout and takes, in the documented lock order
 * (plan-locks.ts: intake -> day locks -> outcome-day locks -> RunPlan rows -> PlanLoad rows):
 *  1. the company's intake lock (lib/dispatch/intake-server.ts: the optimize start, a confirmed order
 *     file, a late order and Bring forward take it too);
 *  2. the outcome-day lock of every depot-day in scope (lib/delivery/locks.ts: every driver or office
 *     result, arrival, departure and photo takes it first), so no delivery result is written for a
 *     day while it is removed; then the driver-link lock of every truck-day in scope
 *     (lib/driver-link/service.ts: a link issued, reissued or revoked takes it), so no link is issued
 *     for a day whose plan goes. Nobody else takes both kinds, so their order cannot deadlock;
 *  3. the plan rows it removes (FOR UPDATE), then the driver links it removes (FOR UPDATE: a result
 *     sent with a link waits on its key, then fails once the run commits);
 * and only then decides: refused (409, nothing removed) while an optimization of the company is
 * queued or running, in "before a date" mode when the date would split a Bring forward or a plan
 * from its orders, when there is more to remove than the preview the admin was shown
 * (PREVIEW_STALE), and when the removal includes loads that left or orders and links from today on
 * without the extra tick (LIVE_DATA_CONFIRM). Plans and orders are deleted by the exact ids read
 * under the locks, children first (START_FRESH_DELETE_ORDER), so RouteAssignment.orderId (RESTRICT),
 * UnservedOrder.orderId and the Bring forward links (NO ACTION) never refuse; delivery results and
 * driver links by the company and the date, so a row written before those statements goes too.
 * Every statement names the company (tenantId) or ids read for it. Lists are sent in parts
 * (IN_LIST_PART: PostgreSQL's bind parameter limit).
 */
import type { Prisma } from '@prisma/client';
import { prisma } from './db';
import { audit } from './audit';
import { HttpError } from './http-error';
import { inParts, lockIntake } from './dispatch/intake-server';
import { isLockBusy, setLockTimeout } from './dispatch/plan-locks';
import { FROZEN } from './dispatch/load-state';
import { DEFAULT_TZ, addDaysIso, dateOnly, isoOf, todayIso, zonedDayStart } from './dispatch/time';
import { outcomesLockKey } from './delivery/locks';
import { driverLinkLockKey } from './driver-link/service';
import {
  startFreshHasLive,
  startFreshLiveText,
  startFreshStale,
  startFreshStaleText,
  type StartFreshBlocker,
  type StartFreshKept,
  type StartFreshLive,
  type StartFreshRemoved,
  type StartFreshReport,
  type StartFreshShown,
} from './start-fresh-text';

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

/**
 * POST: ten attempts that reach the run (past the typed code) per admin per 10 minutes, refused ones
 * included, so a BUSY or PREVIEW_STALE answer leaves room to try again; GET (preview): 30 a minute.
 * In memory, per web process: the real brakes are the typed code, the backup tick, the preview
 * match and the live-data tick.
 */
export const START_FRESH_LIMITS = {
  run: { limit: 10, windowMs: 10 * 60_000 },
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
  'Someone is working on orders, plans or delivery results of this company right now (an order file, a late order, Bring forward, an optimization being started, a driver link or a result being saved). Nothing was removed: try again in a minute.';

interface Scope {
  tenantId: string;
  before: string | null;
  /** The DATE value of `before` (delivery dates, plan dates). */
  beforeDate: Date | null;
  /** Local midnight starting `before` in the company's time zone (upload times, old driver app shifts). */
  dayStart: Date | null;
  /** The company's today (its time zone): what counts as live-looking data. */
  today: string;
}

interface OrderRow {
  id: string;
  deliveryDate: Date;
  isLate: boolean;
  carriedFromOrderId: string | null;
  carriedToOrderId: string | null;
  deliveryStartMin: number | null;
  deliveryEndMin: number | null;
  uploadBatchId: string | null;
}

interface Sets {
  runIds: string[];
  scenarioIds: string[];
  orderIds: string[];
  batchIds: string[];
  shiftIds: string[];
  baselineIds: string[];
  casualIds: string[];
}

/** A Bring forward between two delivery days (lo < hi): a cutoff X splits it when lo < X <= hi. */
export interface CarrySpan {
  lo: string;
  hi: string;
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

async function scopeOf(db: Db, tenantId: string, before: string | null, now: Date): Promise<Scope> {
  const cfg = await db.tenantConfig.findFirst({ where: { tenantId }, select: { timezone: true } });
  const tz = cfg?.timezone || DEFAULT_TZ;
  return {
    tenantId,
    before,
    beforeDate: before ? dateOnly(before) : null,
    dayStart: before ? zonedDayStart(before, tz) : null,
    today: todayIso(tz, now),
  };
}

/** Delivery results and driver links in scope: the company, and before the date when one is chosen. */
function dayWhereOf(s: Scope) {
  return { tenantId: s.tenantId, ...(s.beforeDate ? { deliveryDate: { lt: s.beforeDate } } : {}) };
}

/**
 * Advisory locks for `keys`, sorted, in one statement per part (a company's test data can span many
 * depot-days and truck-days). Each key is the same text the owner of that lock hashes.
 */
async function advisoryLocks(tx: Db, keys: Iterable<string>): Promise<void> {
  const sorted = [...new Set(keys)].sort();
  for (const part of inParts(sorted)) {
    await tx.$queryRaw`SELECT 1 AS locked FROM unnest(${part}::text[]) AS k(key), LATERAL pg_advisory_xact_lock(hashtextextended(k.key, 0))`;
  }
}

/**
 * The outcome-day lock of every depot-day in scope (its plans, results and events), then the
 * driver-link lock of every truck-day in scope (its loads and links). A driver or office result
 * waiting on one of them finds the load gone once the run commits (STOP_NOT_FOUND); a link being
 * issued finds no load (NO_LIVE_LOAD).
 */
async function lockDeliveryDays(tx: Db, s: Scope): Promise<void> {
  const t = s.tenantId;
  const dayWhere = dayWhereOf(s);
  const plans = await tx.runPlan.findMany({
    where: { tenantId: t, ...(s.beforeDate ? { runDate: { lt: s.beforeDate } } : {}) },
    select: { id: true, depotId: true, runDate: true },
  });
  const outcomes = new Set<string>();
  const links = new Set<string>();
  const runDay = new Map<string, string>();
  for (const p of plans) {
    runDay.set(p.id, isoOf(p.runDate));
    outcomes.add(outcomesLockKey(t, p.depotId, isoOf(p.runDate)));
  }
  const day = { depotId: true, deliveryDate: true } as const;
  for (const v of await tx.stopVisit.findMany({ where: dayWhere, select: day, distinct: ['depotId', 'deliveryDate'] })) outcomes.add(outcomesLockKey(t, v.depotId, isoOf(v.deliveryDate)));
  for (const e of await tx.stopEvent.findMany({ where: dayWhere, select: day, distinct: ['depotId', 'deliveryDate'] })) outcomes.add(outcomesLockKey(t, e.depotId, isoOf(e.deliveryDate)));
  for (const part of inParts(ids(plans))) {
    for (const l of await tx.planLoad.findMany({ where: { tenantId: t, runId: { in: part } }, select: { runId: true, truckId: true } })) {
      const d = runDay.get(l.runId);
      if (d) links.add(driverLinkLockKey(t, l.truckId, d));
    }
  }
  for (const l of await tx.driverLink.findMany({ where: dayWhere, select: { truckId: true, deliveryDate: true } })) links.add(driverLinkLockKey(t, l.truckId, isoOf(l.deliveryDate)));
  await advisoryLocks(tx, outcomes);
  await advisoryLocks(tx, links);
}

/** Every delivery date an order file names (the lines to add, and every row's date including skipped ones). */
function fileDatesOf(json: unknown): string[] {
  const v = json as { totals?: { deliveryDates?: unknown }; fileDeliveryDates?: unknown } | null;
  const raw = [...(Array.isArray(v?.totals?.deliveryDates) ? v.totals.deliveryDates : []), ...(Array.isArray(v?.fileDeliveryDates) ? v.fileDeliveryDates : [])];
  return raw.filter((d): d is string => typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d));
}

/**
 * Order files to remove. Everything: all of them. Before a date: the files of earlier days (a file
 * without a date: uploaded before that day) that keep no order; and a file without any order (not
 * confirmed yet, or uploaded with errors) only when every delivery date in it is before the date,
 * because UploadBatch.deliveryDate is the file's EARLIEST date: a file for the 4th and the 5th
 * uploaded before the pilot day stays when the 5th is kept.
 */
async function removableBatches(db: Db, s: Scope, orders: OrderRow[]): Promise<string[]> {
  const t = s.tenantId;
  if (!s.beforeDate) return ids(await db.uploadBatch.findMany({ where: { tenantId: t }, select: { id: true } }));
  const candidates = ids(
    await db.uploadBatch.findMany({
      where: { tenantId: t, OR: [{ deliveryDate: { lt: s.beforeDate } }, { deliveryDate: null, uploadedAt: { lt: s.dayStart! } }] },
      select: { id: true },
    }),
  );
  if (!candidates.length) return [];
  const withRemovedOrders = new Set(orders.map((o) => o.uploadBatchId).filter((x): x is string => !!x));
  const keepsOrders = new Set<string>();
  for (const part of inParts(candidates)) {
    const kept = await db.order.findMany({ where: { tenantId: t, deliveryDate: { gte: s.beforeDate }, uploadBatchId: { in: part } }, select: { uploadBatchId: true } });
    for (const o of kept) if (o.uploadBatchId) keepsOrders.add(o.uploadBatchId);
  }
  const orderless = candidates.filter((id) => !withRemovedOrders.has(id) && !keepsOrders.has(id));
  const reachesKeptDay = new Set<string>();
  // The check of a file is large (every line): a few files per query.
  for (const part of inParts(orderless, 50)) {
    for (const b of await db.uploadBatch.findMany({ where: { tenantId: t, id: { in: part } }, select: { id: true, validationJson: true } })) {
      if (fileDatesOf(b.validationJson).some((d) => d >= s.before!)) reachesKeptDay.add(b.id);
    }
  }
  return candidates.filter((id) => !keepsOrders.has(id) && !reachesKeptDay.has(id));
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

/** Every Bring forward of the company as a span of days (orders can be carried more than once: a chain is several spans). */
async function carrySpans(db: Db, tenantId: string): Promise<CarrySpan[]> {
  const rows = await db.order.findMany({
    where: { tenantId, OR: [{ carriedFromOrderId: { not: null } }, { carriedToOrderId: { not: null } }] },
    select: { id: true, deliveryDate: true, carriedFromOrderId: true, carriedToOrderId: true },
  });
  const dateOf = new Map(rows.map((o) => [o.id, isoOf(o.deliveryDate)]));
  const missing = [...new Set(rows.flatMap((o) => [o.carriedFromOrderId, o.carriedToOrderId]).filter((x): x is string => !!x && !dateOf.has(x)))];
  for (const part of inParts(missing)) {
    for (const o of await db.order.findMany({ where: { tenantId, id: { in: part } }, select: { id: true, deliveryDate: true } })) dateOf.set(o.id, isoOf(o.deliveryDate));
  }
  const spans = new Map<string, CarrySpan>();
  for (const o of rows) {
    for (const other of [o.carriedFromOrderId, o.carriedToOrderId]) {
      const a = dateOf.get(o.id);
      const b = other ? dateOf.get(other) : undefined;
      if (!a || !b || a === b) continue;
      const span = a < b ? { lo: a, hi: b } : { lo: b, hi: a };
      spans.set(`${span.lo}|${span.hi}`, span);
    }
  }
  return [...spans.values()];
}

/**
 * The dates nearest to `before` that split no Bring forward: `earlier`, the latest one not after it
 * (every day of a chain kept), and `later`, the earliest one after it (every day of a chain removed).
 * A chain carried more than once is followed to its first day and its last copy, so the suggestion
 * is never refused again. Both equal `before` when it splits nothing.
 */
export function startFreshSafeCutoffs(spans: readonly CarrySpan[], before: string): { earlier: string; later: string } {
  const splitting = (x: string) => spans.filter((sp) => sp.lo < x && x <= sp.hi);
  let earlier = before;
  for (let cut = splitting(earlier); cut.length; cut = splitting(earlier)) earlier = cut.map((sp) => sp.lo).sort()[0]!;
  let later = before;
  for (let cut = splitting(later); cut.length; cut = splitting(later)) later = addDaysIso(cut.map((sp) => sp.hi).sort()[cut.length - 1]!, 1);
  return { earlier, later };
}

/** Why the run cannot go ahead now (empty: it can). */
async function blockersOf(db: Db, s: Scope, sets: Sets): Promise<StartFreshBlocker[]> {
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
  if (!s.before || !s.beforeDate || !sets.orderIds.length) return out;

  // An order that stays (on or after the date) brought forward from, or to, an order that goes.
  const crossing: { id: string; deliveryDate: Date }[] = [];
  for (const part of inParts(sets.orderIds)) {
    crossing.push(
      ...(await db.order.findMany({
        where: { tenantId: s.tenantId, deliveryDate: { gte: s.beforeDate }, OR: [{ carriedFromOrderId: { in: part } }, { carriedToOrderId: { in: part } }] },
        select: { id: true, deliveryDate: true },
      })),
    );
  }
  if (crossing.length) {
    const { earlier, later } = startFreshSafeCutoffs(await carrySpans(db, s.tenantId), s.before);
    const days = [...new Set(crossing.map((o) => isoOf(o.deliveryDate)))].sort();
    const one = crossing.length === 1;
    out.push({
      code: 'CARRIED_ACROSS_DATE',
      message:
        `${crossing.length} order${one ? '' : 's'} on ${days.join(', ')} ${one ? 'was' : 'were'} brought forward from a day before ${s.before}: removing only the earlier day would cut ${one ? 'it' : 'them'} from ${one ? 'its' : 'their'} original. ` +
        `Choose ${earlier} (keeps ${one ? 'it' : 'them'} with the original) or ${later} (removes ${one ? 'it' : 'them'} with the original), undo the Bring forward first, or remove everything.`,
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
  const dayWhere = dayWhereOf(s);

  const runIds = ids(await db.runPlan.findMany({ where: { tenantId: t, ...(onDay ? { runDate: onDay } : {}) }, select: { id: true } }));
  const scenarioIds: string[] = [];
  for (const part of inParts(runIds)) scenarioIds.push(...ids(await db.scenarioResult.findMany({ where: { runId: { in: part } }, select: { id: true } })));

  const orders: OrderRow[] = await db.order.findMany({
    where: { tenantId: t, ...(onDay ? { deliveryDate: onDay } : {}) },
    select: { id: true, deliveryDate: true, isLate: true, carriedFromOrderId: true, carriedToOrderId: true, deliveryStartMin: true, deliveryEndMin: true, uploadBatchId: true },
  });
  const orderIds = ids(orders);
  const batchIds = await removableBatches(db, s, orders);

  // Delivery results and links are removed by the company and the date (removeAll); read here for the counts.
  const visitIds = ids(await db.stopVisit.findMany({ where: dayWhere, select: { id: true } }));
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
  const sets: Sets = { runIds, scenarioIds, orderIds, batchIds, shiftIds, baselineIds, casualIds: casual.removable };

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
    driverLinks: await db.driverLink.count({ where: dayWhere }),
    stopVisits: visitIds.length,
    stopEvents: await db.stopEvent.count({ where: dayWhere }),
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
    orderFiles: (await db.uploadBatch.count({ where: { tenantId: t } })) - batchIds.length,
  };
  // What may already be real: loads that were locked or left, orders and links from today on.
  const live: StartFreshLive = {
    today: s.today,
    frozenLoads: await countIn(runIds, (part) => db.planLoad.count({ where: { tenantId: t, runId: { in: part }, status: { in: [...FROZEN] } } })),
    ordersFromToday: orders.filter((o) => isoOf(o.deliveryDate) >= s.today).length,
    driverLinksFromToday: await db.driverLink.count({ where: { tenantId: t, deliveryDate: { gte: dateOnly(s.today), ...(onDay ?? {}) } } }),
  };
  const dates = orders.map((o) => isoOf(o.deliveryDate)).sort();
  const report: StartFreshReport = {
    before: s.before,
    removed,
    kept,
    orderDates: dates.length ? { from: dates[0]!, to: dates[dates.length - 1]! } : null,
    live,
    blockers: await blockersOf(db, s, sets),
  };
  return { sets, report };
}

/** The preview: what a run would remove and keep now, and what would refuse it. Changes nothing. */
export async function previewStartFresh(tenantId: string, before: string | null, opts: { now?: Date } = {}): Promise<StartFreshReport> {
  const db = prisma as unknown as Db;
  return (await collect(db, await scopeOf(db, tenantId, before, opts.now ?? new Date()))).report;
}

/** Delete everything in `sets` and the delivery results in scope, children first (START_FRESH_DELETE_ORDER). The numbers actually deleted. */
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

  // 3. Delivery results by the company and the date, not by ids read earlier: a result written before
  // these statements goes too (the outcome-day, driver-link and link row locks keep new ones out until
  // the run commits). Photos and events before their stops, the driver links last (events and photos
  // name them). The visits are read again here, under the locks.
  const dayWhere = dayWhereOf(s);
  const visitIds = ids(await tx.stopVisit.findMany({ where: dayWhere, select: { id: true } }));
  const photos = s.beforeDate
    ? await deleteIn(visitIds, (part) => tx.deliveryPhoto.deleteMany({ where: { tenantId: t, visitId: { in: part } } }))
    : (await tx.deliveryPhoto.deleteMany({ where: { tenantId: t } })).count;
  let events = (await tx.stopEvent.deleteMany({ where: dayWhere })).count;
  events += await deleteIn(visitIds, (part) => tx.stopEvent.deleteMany({ where: { tenantId: t, visitId: { in: part } } }));
  const visits = (await tx.stopVisit.deleteMany({ where: dayWhere })).count;
  const links = (await tx.driverLink.deleteMany({ where: dayWhere })).count;

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

export interface StartFreshRunOptions {
  /**
   * What the admin was shown (the preview). A run that would remove more, or orders of other dates,
   * is refused with 409 PREVIEW_STALE. The route always passes it; absent: not compared.
   */
  shown?: StartFreshShown | null;
  /** The admin ticked that the live-looking data (StartFreshLive) is test data too. */
  liveDataConfirmed?: boolean;
  now?: Date;
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
  opts: StartFreshRunOptions = {},
): Promise<StartFreshReport> {
  const now = opts.now ?? new Date();
  try {
    return await prisma.$transaction(async (tx) => {
      await setLockTimeout(tx, LOCK_WAIT_MS);
      await lockIntake(tx, tenantId);
      const s = await scopeOf(tx, tenantId, before, now);
      await lockDeliveryDays(tx, s);
      if (before) {
        await tx.$queryRaw`SELECT id FROM "RunPlan" WHERE "tenantId" = ${tenantId} AND "runDate" < ${before}::date ORDER BY id FOR UPDATE`;
        await tx.$queryRaw`SELECT id FROM "DriverLink" WHERE "tenantId" = ${tenantId} AND "deliveryDate" < ${before}::date ORDER BY id FOR UPDATE`;
      } else {
        await tx.$queryRaw`SELECT id FROM "RunPlan" WHERE "tenantId" = ${tenantId} ORDER BY id FOR UPDATE`;
        await tx.$queryRaw`SELECT id FROM "DriverLink" WHERE "tenantId" = ${tenantId} ORDER BY id FOR UPDATE`;
      }
      const { sets, report } = await collect(tx, s);
      const blocker = report.blockers[0];
      if (blocker) throw new StartFreshRefused(blocker.message, blocker.code);
      if (opts.shown) {
        const grew = startFreshStale(opts.shown, report);
        if (grew.length) throw new StartFreshRefused(startFreshStaleText(grew), 'PREVIEW_STALE');
      }
      if (startFreshHasLive(report.live) && opts.liveDataConfirmed !== true) {
        throw new StartFreshRefused(`${startFreshLiveText(report.live)} Nothing was removed. If they are test data, tick that and press Remove again.`, 'LIVE_DATA_CONFIRM');
      }
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
            live: result.live,
            backupConfirmed: true,
            liveDataConfirmed: opts.liveDataConfirmed === true,
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
