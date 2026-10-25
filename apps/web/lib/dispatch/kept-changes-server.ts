/**
 * The one reader of the kept-load warning (kept-changes.ts): the LOCKED and LOADING loads of a live plan
 * version whose customer data changed after they were planned. Called by the day screen
 * (getDayOverview), the plan screen (GET /api/runs/:id/plan), GET /api/runs/:id/kept-changes, the
 * re-plan (its audit and answer) and an unlock from the warning (its LOAD_PLANNED audit row), so they
 * never disagree. It reads only, never refuses anything, and runs with the caller's client (a
 * transaction's too). Every model with a tenantId is read with it; the rows of a version through the
 * tenant-checked version.
 *
 * KEPT_CHANGES=off (any of off / 0 / false / no) switches it off - kill switch, read on every call:
 * every caller then answers as before the warning existed (no `kept`, no audit fields).
 */
import type { Prisma } from '@prisma/client';
import type { prisma } from '../db';
import { effectiveAttrs, locationBlocksDelivery, parseServiceArea, type TypeProfileLike } from './customer-attrs';
import type { ServiceArea } from './location-input';
import { NOT_CANCELLED } from './order-cancel-rules';
import type { OrderPlacement, OrderTimeColumns } from './order-window';
import { isSupersededRun } from './plan-status';
import { readHandAllowances, readStopSnapshot, readTruckSnapshot } from './snapshots';
import { isSmallTruck, smallTruckMaxBaysOf } from './small-truck';
import { readPortionLines, rowKeyOf, splitPartLabels } from './split';
import { shownTruckCode } from './hire';
import { stopsAtReplacedPoints } from './replaced-pin';
import { DEFAULT_TZ, isoOf, todayIso } from './time';
import { keptLoadLabel, keptReport, keptStopLive, type KeptLoadInput, type KeptReport, type KeptStopInput, type TruckLoadRef } from './kept-changes';

/** The client the caller reads with: the app's, or a transaction's (the unlock's, the plan screen's snapshot). */
type Db = Prisma.TransactionClient | typeof prisma;

const OFF = new Set(['off', '0', 'false', 'no']);
const ON = new Set(['on', '1', 'true', 'yes']);

/** KEPT_CHANGES: 'off' only when set to off / 0 / false / no (trimmed, any case); anything else is on (the default). */
export function keptChangesMode(env: NodeJS.ProcessEnv = process.env): 'on' | 'off' {
  return OFF.has((env.KEPT_CHANGES ?? '').trim().toLowerCase()) ? 'off' : 'on';
}

/** The startup line (startup-checks.ts): the warning switched off, or a value it does not read (then it stays on). */
export function keptChangesConfigProblem(env: NodeJS.ProcessEnv = process.env): string | null {
  const v = (env.KEPT_CHANGES ?? '').trim().toLowerCase();
  if (!v || ON.has(v)) return null;
  if (OFF.has(v)) {
    return 'KEPT_CHANGES=off: locked and loading loads planned with older customer data are not listed on Daily dispatch or in the re-plan dialog (the plan screen keeps its yellow note only). Kill switch - remove it to list them again.';
  }
  return 'KEPT_CHANGES is set to a value RouteIQ does not read (use on or off): the kept-load warning stays on.';
}

/**
 * The day's orders, as ordersInScopeWhere (plan-service.ts) reads them - not imported from there, as
 * plan-service imports this file (a spec holds both to the same answer).
 */
export function keptDayOrdersWhere(tenantId: string, depotId: string, runDate: Date): Prisma.OrderWhereInput {
  return { tenantId, deliveryDate: runDate, carriedToOrderId: null, ...NOT_CANCELLED, depotId };
}

export interface KeptOptions {
  /** The clock (the company's today: a day that is over has no report). */
  now?: Date;
  /** Only this load (the LOAD_PLANNED audit of an unlock from the warning); the unlock chains still read every load. */
  loadId?: string;
  /** Settings already read by the caller (the day overview); read here when absent. */
  cfg?: { timezone?: string | null; defaultServiceTimeMin?: number | null; smallTruckMaxBays?: number | null; serviceAreaJson?: unknown } | null;
  profiles?: Map<string, TypeProfileLike>;
  area?: ServiceArea;
}

/** An order a kept stop may be judged with (plan-detail's visit orders). */
interface VisitOrder extends OrderTimeColumns {
  id: string;
  customerId: string;
  uploadedAt: Date | null;
  lines: { id: string; cases: number }[];
}

const STATUS_WORD: Record<string, string> ={ PLANNED: 'planned', LOCKED: 'locked', LOADING: 'loading', DISPATCHED: 'dispatched', COMPLETED: 'completed' };

/**
 * The kept-load report of a version, or null when there is none to give: the switch is off, the
 * version is not this company's, superseded, optimizing (its loads are a copy being replaced; the day
 * screen polls then - review W8), has no applied plan, or its day is over. An empty report (no load)
 * when nothing kept changed. Rows planned before snapshots existed say nothing.
 */
export async function keptChangesOf(db: Db, tenantId: string, runId: string, opts: KeptOptions = {}): Promise<KeptReport | null> {
  if (keptChangesMode() === 'off') return null;
  const run = await db.runPlan.findFirst({
    where: { id: runId, tenantId },
    select: { id: true, depotId: true, runDate: true, status: true, supersededAt: true, chosenScenarioId: true },
  });
  if (!run || isSupersededRun(run) || !run.chosenScenarioId || run.status === 'OPTIMIZING') return null;
  const cfg = opts.cfg !== undefined ? opts.cfg : await db.tenantConfig.findUnique({ where: { tenantId } });
  if (isoOf(run.runDate) < todayIso(cfg?.timezone || DEFAULT_TZ, opts.now ?? new Date())) return null;
  const loads = await db.planLoad.findMany({
    where: { runId: run.id, tenantId },
    include: { truck: { select: { code: true, bays: true, onlyOnDate: true } } },
  });
  const isKept = (s: string) => s === 'LOCKED' || s === 'LOADING';
  const keptLoads = loads.filter((l) => isKept(l.status) && (!opts.loadId || l.id === opts.loadId));
  if (!keptLoads.length) return keptReport([], []);
  const codeOf = new Map(loads.map((l) => [l.id, shownTruckCode(readTruckSnapshot(l.truckSnapshotJson)?.code, l.truck)]));
  const loadById = new Map(loads.map((l) => [l.id, l]));

  const rows = await db.routeAssignment.findMany({
    where: { runId: run.id },
    orderBy: [{ sequenceInTruck: 'asc' }, { orderInStop: 'asc' }],
    select: {
      loadId: true,
      sequenceInTruck: true,
      orderId: true,
      portionLinesJson: true,
      stopSnapshotJson: true,
      serviceStartMin: true,
      departureMin: true,
      order: {
        select: {
          id: true,
          customerId: true,
          uploadedAt: true,
          cancelledAt: true,
          carriedToOrderId: true,
          carriedTo: { select: { deliveryDate: true } },
          deliveryStartMin: true,
          deliveryEndMin: true,
          deliveryTimeReason: true,
          deliveryTimeNote: true,
          lines: { select: { id: true, cases: true } },
          customer: true,
        },
      },
    },
  });
  const keptIds = new Set(keptLoads.map((l) => l.id));
  const keptRows = rows.filter((a) => a.loadId && keptIds.has(a.loadId));
  const customerIds = [...new Set(keptRows.map((a) => a.order.customerId))];
  if (!customerIds.length) return keptReport([], []);

  const profiles = opts.profiles ?? new Map<string, TypeProfileLike>((await db.customerTypeProfile.findMany({ where: { tenantId } })).map((p) => [p.customerType, p]));
  const area = opts.area ?? parseServiceArea(cfg?.serviceAreaJson, (await db.tenant.findUnique({ where: { id: tenantId }, select: { country: true } }))?.country);
  const smallMax = smallTruckMaxBaysOf(cfg);

  // The orders each kept customer's stop is judged with (plan-detail's visit orders): on any load of
  // this version, and left unserved by its option - keptVisitOrders then keeps those it was planned with.
  const unservedIds = new Set(
    (await db.unservedOrder.findMany({ where: { scenarioId: run.chosenScenarioId }, select: { orderId: true } })).map((u) => u.orderId),
  );
  const unserved = unservedIds.size
    ? await db.order.findMany({
        where: { tenantId, id: { in: [...unservedIds] }, customerId: { in: customerIds } },
        select: { id: true, customerId: true, uploadedAt: true, deliveryStartMin: true, deliveryEndMin: true, deliveryTimeReason: true, deliveryTimeNote: true, lines: { select: { id: true, cases: true } } },
      })
    : [];
  const visit = new Map<string, Map<string, VisitOrder>>();
  const addVisit = (o: VisitOrder) => {
    const m = visit.get(o.customerId) ?? new Map<string, VisitOrder>();
    m.set(o.id, o);
    visit.set(o.customerId, m);
  };
  for (const a of rows) addVisit(a.order);
  for (const o of unserved) addVisit(o);
  const placements: OrderPlacement[] = rows.map((a) => ({
    orderId: a.orderId,
    frozen: !!a.loadId && loadById.get(a.loadId)?.status !== 'PLANNED',
    lines: readPortionLines(a.portionLinesJson),
    capturedAt: readStopSnapshot(a.stopSnapshotJson)?.capturedAt ?? null,
  }));

  // Where each order of the version is now, for a new order's line ("on T03 L1 (planned)").
  const whereOnPlan = new Map<string, string>();
  for (const a of rows) {
    const l = a.loadId ? loadById.get(a.loadId) : undefined;
    if (!l || whereOnPlan.has(a.orderId)) continue;
    whereOnPlan.set(a.orderId, `on ${keptLoadLabel(codeOf.get(l.id) ?? '?', l.loadNo)} (${STATUS_WORD[l.status] ?? l.status.toLowerCase()})`);
  }
  const dayOrders = await db.order.findMany({
    where: { ...keptDayOrdersWhere(tenantId, run.depotId, run.runDate), customerId: { in: customerIds } },
    select: { id: true, customerId: true, uploadedAt: true, totalCases: true },
  });
  const whereNow = (id: string) => whereOnPlan.get(id) ?? (unservedIds.has(id) ? 'left unserved by this plan' : 'not planned yet: RE-PLAN plans it');

  // The stops of every load (rows grouped by load and sequence), for the split part labels across the plan.
  const stopsOf = new Map<string, (typeof rows)[number][]>();
  for (const a of rows) {
    if (!a.loadId) continue;
    const key = `${a.loadId}|${a.sequenceInTruck}`;
    stopsOf.set(key, [...(stopsOf.get(key) ?? []), a]);
  }
  const portionStops = [...stopsOf.entries()].map(([key, group]) => {
    const l = loadById.get(group[0]!.loadId!)!;
    return { key, customerId: group[0]!.order.customerId, portion: group.some((a) => a.portionLinesJson !== null), departMin: l.departMin, truckCode: codeOf.get(l.id) ?? '?', sequence: group[0]!.sequenceInTruck };
  });
  const parts = splitPartLabels(portionStops);
  const partOf = new Map([...parts.entries()].map(([s, p]) => [s.key, p]));

  // Per kept load, the customers whose stop is still planned at a point that was not usable when a new
  // pin replaced it: the location gate refuses Loading and Dispatch of that load (STOP_PIN_REPLACED), so
  // the box must never call it "still OK" (review W-4). The gate's own check, per load as the gate reads it.
  const customersNow = new Map(keptRows.map((a) => [a.order.customerId, a.order.customer]));
  const pinReplacedOf = new Map<string, Set<string>>();
  for (const l of keptLoads) {
    const stops = keptRows.filter((a) => a.loadId === l.id).map((a) => ({ customerId: a.order.customerId, stopSnapshotJson: a.stopSnapshotJson }));
    pinReplacedOf.set(l.id, await stopsAtReplacedPoints(db, tenantId, stops, customersNow, area));
  }

  const inputs: KeptLoadInput[] = keptLoads.map((l) => {
    const stops: KeptStopInput[] = [];
    const lateAllowed = readHandAllowances(l.truckSnapshotJson).filter((a) => a.kind === 'LATE');
    for (const [key, group] of stopsOf) {
      if (group[0]!.loadId !== l.id) continue;
      const first = group[0]!;
      const snap = readStopSnapshot(first.stopSnapshotJson);
      if (!snap) continue;
      const c = first.order.customer;
      const eff = effectiveAttrs(c, profiles, { serviceTimeMin: cfg?.defaultServiceTimeMin ?? 10 });
      const own = new Map(group.map((a) => [a.order.id, a.order]));
      const at = Date.parse(snap.capturedAt);
      const cameAfter = (d: Date | null) => !!d && Number.isFinite(at) && d.getTime() > at;
      // A late arrival allowed by hand on this stop (matched by its rows: order and split lines).
      const keys = group.map((a) => rowKeyOf(a.orderId, a.portionLinesJson));
      const allowed = lateAllowed.find((a) => keys.every((k) => a.rowKeys.includes(k)) && typeof a.maxLateMin === 'number' && typeof a.windowEndMin === 'number');
      stops.push({
        sequence: first.sequenceInTruck,
        customerId: c.id,
        snapshot: snap,
        split: partOf.get(key) ?? null,
        serviceStartMin: first.serviceStartMin,
        departureMin: first.departureMin,
        ...(allowed ? { allowance: { maxLateMin: allowed.maxLateMin!, windowEndMin: allowed.windowEndMin!, reason: allowed.reason, ...(allowed.rule ? { rule: allowed.rule } : {}) } } : {}),
        live: keptStopLive(c, eff, [...(visit.get(c.id)?.values() ?? [first.order])], placements, snap.capturedAt),
        customer: {
          code: snap.code || c.code,
          branchCode: snap.branchCode,
          name: snap.name || c.name,
          active: c.active,
          smallTruckOnly: !!c.smallTruckOnly,
          locationUsable: !locationBlocksDelivery(c, area),
          pinReplaced: pinReplacedOf.get(l.id)?.has(c.id) ?? false,
        },
        orders: [...own.values()].map((o) => ({
          id: o.id,
          cancelled: !!o.cancelledAt,
          carriedTo: o.carriedToOrderId ? (o.carriedTo?.deliveryDate ? isoOf(o.carriedTo.deliveryDate) : 'a later day') : null,
        })),
        newOrders: dayOrders
          .filter((o) => o.customerId === c.id && !own.has(o.id) && cameAfter(o.uploadedAt))
          .map((o) => ({ id: o.id, cases: o.totalCases, where: whereNow(o.id) })),
      });
    }
    return {
      loadId: l.id,
      truckId: l.truckId,
      truckCode: codeOf.get(l.id) ?? l.truck.code,
      loadNo: l.loadNo,
      status: l.status as 'LOCKED' | 'LOADING',
      rules: readTruckSnapshot(l.truckSnapshotJson)?.rules ?? null,
      truckSmallNow: isSmallTruck(l.truck.bays, smallMax),
      stops,
    };
  });
  const all: TruckLoadRef[] = loads.map((l) => ({ loadId: l.id, truckId: l.truckId, truckCode: codeOf.get(l.id) ?? l.truck.code, loadNo: l.loadNo, status: l.status }));
  return keptReport(inputs, all);
}

/**
 * keptChangesOf for a screen, a re-plan or an audit row: an error is logged and read as "no report".
 * The warning only adds information, so an error of its own never stops the day screen, the plan
 * screen, a re-plan or an unlock. One limit (review N1 / W-11): on the caller's transaction (the
 * unlock, the plan screen's snapshot) a failed SQL statement aborts that transaction in Postgres, and
 * no catch here can undo that - the caller then fails as it would on any failed read. The report only
 * runs plain reads there. `where`: the caller, for the log line.
 */
export async function keptChangesOrNull(db: Db, tenantId: string, runId: string, opts: KeptOptions, where: string): Promise<KeptReport | null> {
  try {
    return await keptChangesOf(db, tenantId, runId, opts);
  } catch (e) {
    console.warn(`${where}: kept-load report not read`, { runId, error: e instanceof Error ? e.message : String(e) });
    return null;
  }
}
