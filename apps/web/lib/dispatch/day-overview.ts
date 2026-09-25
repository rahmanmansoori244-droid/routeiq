/**
 * The dispatcher's starting point for one depot + delivery date: what was uploaded, what must
 * be fixed before optimizing (LOCATION REQUIRED ...), and the state of the plan.
 */
import { prisma } from '../db';
import { tenantDb } from '../tenant';
import {
  coordStatus,
  customerIssues,
  describeWindows,
  effectiveAttrs,
  inactiveCustomerIssue,
  parseServiceArea,
  type CustomerIssue,
  type TypeProfileLike,
} from './customer-attrs';
import { currentPlan, ordersInScopeWhere, type ScenarioDetails } from './plan-service';
import { dateOnly, fmtHhmm, isoOf, todayIso, tomorrowIso } from './time';
import { isRealIsoDate } from '../schemas';
import { lineWeightStatus, orderUsesLineWeights } from './weights';
import { readPortionLines } from './split';
import { plannedLoadsMasterChanged } from './snapshots';

export interface IssueCustomer {
  customerId: string;
  code: string;
  branchCode: string | null;
  name: string;
  customerType: string | null;
  priority: number;
  prioritySource: string;
  serviceMin: number;
  window: string;
  hardWindowStartMin: number | null;
  hardWindowEndMin: number | null;
  prefWindowStartMin: number | null;
  prefWindowEndMin: number | null;
  lat: number | null;
  lng: number | null;
  locationVerified: boolean;
  orders: number;
  cases: number;
  issues: CustomerIssue[];
  blocking: boolean;
  /** Deactivated after its orders were confirmed: its open orders are left unserved. */
  inactive: boolean;
}

/** Products whose order lines have no weight yet (per product: lines and cases). */
export interface WeightGap {
  code: string;
  name: string;
  lines: number;
  cases: number;
}

export async function getDayOverview(tenantId: string, opts: { date?: string | null; depotId?: string | null }) {
  const db = tenantDb(tenantId);
  const cfg = await db.tenantConfig.findUniqueOrThrow({ where: { tenantId } });
  const depots = await db.depot.findMany({ where: { active: true }, orderBy: { code: 'asc' }, select: { id: true, code: true, name: true, lat: true, lng: true } });
  const depot = depots.find((d) => d.id === opts.depotId) ?? depots[0] ?? null;
  const date = opts.date && isRealIsoDate(opts.date) ? opts.date : tomorrowIso(cfg.timezone);
  const base = {
    date,
    today: todayIso(cfg.timezone),
    tomorrow: tomorrowIso(cfg.timezone),
    timezone: cfg.timezone,
    cutoff: fmtHhmm(cfg.planningCutoffMin),
    depots,
    depot,
  };
  if (!depot) {
    return { ...base, orders: { count: 0, cases: 0, customers: 0, late: 0, weightKg: 0 }, customers: [] as IssueCustomer[], productsWithoutWeight: [] as WeightGap[], weightsToApply: [] as WeightGap[], inactiveCustomers: 0, plan: null, pending: { orderIds: [] as string[], count: 0, cases: 0, late: 0 }, openOrders: 0, outdated: { weightCases: 0, inactiveOrders: 0, masterChanged: 0, trucksChanged: 0 }, trucks: { active: 0, capacityCases: 0 }, batches: [] };
  }
  const profiles = new Map<string, TypeProfileLike>((await db.customerTypeProfile.findMany()).map((p) => [p.customerType, p]));
  const tenant = await prisma.tenant.findUnique({ where: { id: tenantId }, select: { country: true } });
  const area = parseServiceArea(cfg.serviceAreaJson, tenant?.country);
  const where = await ordersInScopeWhere(tenantId, depot.id, dateOnly(date));
  const orders = await prisma.order.findMany({
    where,
    include: { customer: true, lines: { include: { product: { select: { code: true, name: true, weightPerCaseKg: true } } } } },
  });
  const byCustomer = new Map<string, IssueCustomer>();
  const plan = await currentPlan(tenantId, depot.id, date);
  // Loads of the plan in use: what frozen loads carry (per line, as buildDispatchRequest counts
  // it: a split order can be partly on a frozen load) and which orders sit on PLANNED loads.
  const onPlan = plan && orders.length
    ? await prisma.routeAssignment.findMany({
        where: { runId: plan.id, orderId: { in: orders.map((o) => o.id) } },
        select: { orderId: true, portionLinesJson: true, stopSnapshotJson: true, load: { select: { status: true } } },
      })
    : [];
  const frozenWhole = new Set<string>();
  const frozenLineCases = new Map<string, number>();
  const onPlannedLoad = new Set<string>();
  for (const a of onPlan) {
    if (!a.load) continue;
    if (a.load.status === 'PLANNED') {
      onPlannedLoad.add(a.orderId);
      continue;
    }
    const pl = readPortionLines(a.portionLinesJson);
    if (!pl) frozenWhole.add(a.orderId);
    else for (const x of pl) frozenLineCases.set(x.lineId, (frozenLineCases.get(x.lineId) ?? 0) + x.cases);
  }
  const chosen = plan?.chosenScenarioId ? await prisma.scenarioResult.findUnique({ where: { id: plan.chosenScenarioId } }) : null;
  const d = chosen?.detailsJson as unknown as ScenarioDetails | undefined;
  const inScope = new Set(d?.scope ? [...d.scope.orderIds, ...d.scope.frozenOrderIds] : []);
  // Weights per order LINE (0 kg on a line = unknown), not per product: a product whose case
  // weight was entered or corrected after the orders were confirmed leaves those lines as they
  // are until the next optimize applies it. Only the open cases count: what frozen loads carry
  // keeps the kg it was loaded with (the same rule as the OPTIMIZE / RE-PLAN weight check).
  const noWeight = new Map<string, WeightGap & { kgPerCase: number }>();
  const toApply = new Map<string, WeightGap & { kgPerCase: number }>();
  // Why the plan in use is out of date although no new order is waiting (RE-PLAN enabled).
  const outdated = { weightCases: 0, inactiveOrders: 0, masterChanged: 0, trucksChanged: 0 };
  const openCasesOf = new Map<string, number>();
  for (const o of orders) {
    if (frozenWhole.has(o.id) || o.status === 'DISPATCHED' || o.status === 'DELIVERED') continue;
    const orderLevel = !orderUsesLineWeights(o);
    // The open rest of an order partly on a frozen load is planned with the product's weight at
    // every optimize but never saved (the frozen part shares the line): nothing to apply for it.
    const partlyFrozen = o.lines.some((l) => (frozenLineCases.get(l.id) ?? 0) > 0);
    let open = 0;
    for (const l of o.lines) {
      const cases = Math.max(0, l.cases - (frozenLineCases.get(l.id) ?? 0));
      if (cases <= 0) continue;
      open += cases;
      const st = lineWeightStatus({ cases: l.cases, weightKg: l.weightKg, fromMaster: l.weightFromMaster }, l.product.weightPerCaseKg, orderLevel);
      if (st === 'KNOWN' || (st === 'MASTER' && partlyFrozen)) continue;
      const m = st === 'UNKNOWN' ? noWeight : toApply;
      const g = m.get(l.product.code) ?? { code: l.product.code, name: l.product.name, lines: 0, cases: 0, kgPerCase: l.product.weightPerCaseKg };
      g.lines++;
      g.cases += cases;
      m.set(l.product.code, g);
      if (st === 'MASTER' && inScope.has(o.id)) outdated.weightCases += cases;
    }
    if (open > 0) openCasesOf.set(o.id, open);
  }
  // A deactivated customer matters only while it has open orders (frozen and dispatched loads
  // keep theirs). Orders of it still on PLANNED loads were planned before it was deactivated.
  const inactiveOpen = new Map<string, { orders: number; onPlannedLoads: number }>();
  for (const o of orders) {
    if (o.customer.active || !openCasesOf.has(o.id)) continue;
    const g = inactiveOpen.get(o.customerId) ?? { orders: 0, onPlannedLoads: 0 };
    g.orders++;
    if (onPlannedLoad.has(o.id)) g.onPlannedLoads++;
    inactiveOpen.set(o.customerId, g);
  }
  for (const g of inactiveOpen.values()) outdated.inactiveOrders += g.onPlannedLoads;
  // Review F08: customers on PLANNED loads whose pin or receiving hours were corrected after the
  // plan was made, and trucks with PLANNED loads whose capacity or payload was corrected since. The
  // plan keeps what it was planned with; a re-plan adopts the new data.
  const orderById = new Map(orders.map((o) => [o.id, o]));
  const plannedStops = onPlan.flatMap((a) => {
    const o = orderById.get(a.orderId);
    if (a.load?.status !== 'PLANNED' || !o) return [];
    const eff = effectiveAttrs(o.customer, profiles, { serviceTimeMin: cfg.defaultServiceTimeMin });
    return [{
      customerId: o.customerId,
      stopSnapshotJson: a.stopSnapshotJson,
      live: {
        name: o.customer.name, address: o.customer.address, lat: o.customer.lat, lng: o.customer.lng,
        hardStartMin: eff.hardStart, hardEndMin: eff.hardEnd, prefStartMin: eff.prefStart, prefEndMin: eff.prefEnd,
      },
    }];
  });
  const plannedLoads = plan?.chosenScenarioId
    ? await prisma.planLoad.findMany({
        where: { runId: plan.id, tenantId, status: 'PLANNED' },
        select: { truckId: true, truckSnapshotJson: true, truck: { select: { capacityCases: true, capacityWeightKg: true } } },
      })
    : [];
  const changed = plannedLoadsMasterChanged(
    plannedStops,
    plannedLoads.map((l) => ({ truckId: l.truckId, truckSnapshotJson: l.truckSnapshotJson, live: l.truck })),
  );
  outdated.masterChanged = changed.customers;
  outdated.trucksChanged = changed.trucks;
  for (const o of orders) {
    const c = o.customer;
    const cur = byCustomer.get(c.id);
    if (cur) {
      cur.orders++;
      cur.cases += o.totalCases;
      continue;
    }
    const eff = effectiveAttrs(c, profiles, { serviceTimeMin: cfg.defaultServiceTimeMin });
    // A deactivated customer's open orders are left unserved at optimize (not delivered): that is
    // the only thing to show for it; its location no longer matters.
    const inactive = !c.active ? inactiveOpen.get(c.id) : undefined;
    const issues = c.active ? customerIssues(c, eff, area) : inactive ? [inactiveCustomerIssue(inactive.onPlannedLoads > 0)] : [];
    byCustomer.set(c.id, {
      customerId: c.id,
      code: c.code,
      branchCode: c.branchCode,
      name: c.name,
      customerType: c.customerType,
      priority: eff.priority,
      prioritySource: eff.prioritySource,
      serviceMin: eff.serviceMin,
      window: describeWindows(eff),
      hardWindowStartMin: c.hardWindowStartMin,
      hardWindowEndMin: c.hardWindowEndMin,
      prefWindowStartMin: c.prefWindowStartMin,
      prefWindowEndMin: c.prefWindowEndMin,
      lat: c.lat,
      lng: c.lng,
      locationVerified: c.locationVerified,
      orders: 1,
      cases: o.totalCases,
      issues,
      blocking: issues.some((i) => i.blocking),
      inactive: !c.active,
    });
  }
  const customers = [...byCustomer.values()].sort(
    (a, b) => Number(b.blocking) - Number(a.blocking) || b.issues.length - a.issues.length || a.priority - b.priority || b.cases - a.cases,
  );

  let pending = { orderIds: [] as string[], count: 0, cases: 0, late: 0 };
  let planInfo = null;
  if (plan) {
    const job = await db.runJob.findFirst({ where: { runId: plan.id }, orderBy: { attemptNo: 'desc' } });
    if (d?.scope) {
      const p = orders.filter((o) => !inScope.has(o.id));
      pending = { orderIds: p.map((o) => o.id), count: p.length, cases: p.reduce((a, o) => a + o.totalCases, 0), late: p.filter((o) => o.isLate).length };
    }
    const loads = await db.planLoad.groupBy({ by: ['status'], where: { runId: plan.id }, _count: { _all: true } });
    planInfo = {
      id: plan.id,
      version: plan.version,
      status: plan.status,
      reason: plan.reason,
      chosen: !!plan.chosenScenarioId,
      job: job ? { id: job.id, status: job.status, message: job.message, progressPct: job.progressPct } : null,
      loadsByStatus: Object.fromEntries(loads.map((g) => [g.status, g._count._all])),
      summary: plan.summaryJson,
      reconciliationOk: (plan.reconciliationJson as { ok?: boolean } | null)?.ok ?? null,
    };
  }
  const trucks = await db.truck.findMany({ where: { depotId: depot.id, active: true }, select: { capacityCases: true } });
  const batches = await db.uploadBatch.findMany({
    where: { OR: [{ deliveryDate: dateOnly(date) }, { orders: { some: { deliveryDate: dateOnly(date) } } }], depotId: depot.id },
    orderBy: { uploadedAt: 'desc' },
    take: 20,
    select: { id: true, fileName: true, status: true, uploadedAt: true, validRows: true, errorRows: true, isLate: true, lateReason: true },
  });
  return {
    ...base,
    orders: {
      count: orders.length,
      cases: orders.reduce((a, o) => a + o.totalCases, 0),
      weightKg: Math.round(orders.reduce((a, o) => a + o.totalWeightKg, 0)),
      customers: byCustomer.size,
      late: orders.filter((o) => o.isLate).length,
    },
    customers,
    blockingCount: customers.filter((c) => c.blocking).length,
    missingLocation: customers.filter((c) => !c.inactive && coordStatus(c.lat, c.lng, area) === 'MISSING').length,
    /** Deactivated customers that still have open orders (not on a frozen load). */
    inactiveCustomers: customers.filter((c) => c.inactive && c.blocking).length,
    /** Lines with no weight at all (no case weight on the product either): counted as 0 kg. */
    productsWithoutWeight: [...noWeight.values()].sort((a, b) => b.cases - a.cases || a.code.localeCompare(b.code)),
    /** Lines whose product's case weight (entered or corrected since) gives them another kg: applied at the next optimize. */
    weightsToApply: [...toApply.values()].sort((a, b) => b.cases - a.cases || a.code.localeCompare(b.code)),
    plan: planInfo,
    pending,
    /**
     * Orders of the day with cases not yet on a locked, loading or dispatched load of the plan in
     * use. 0 while orders exist = nothing left to plan (OPTIMIZE / RE-PLAN answer NOTHING_TO_PLAN).
     */
    openOrders: openCasesOf.size,
    /**
     * The plan in use is out of date without a new order waiting: open cases on it whose case
     * weight was entered or corrected since, orders of customers deactivated since that are still
     * on planned loads, customers on planned loads whose pin or receiving hours were corrected
     * (masterChanged) and trucks with planned loads whose capacity or payload was corrected
     * (trucksChanged). RE-PLAN applies them all.
     */
    outdated: plan?.chosenScenarioId ? outdated : { weightCases: 0, inactiveOrders: 0, masterChanged: 0, trucksChanged: 0 },
    trucks: { active: trucks.length, capacityCases: trucks.reduce((a, t) => a + t.capacityCases, 0) },
    batches: batches.map((b) => ({ ...b, uploadedAt: b.uploadedAt.toISOString() })),
    serviceArea: area,
    runDateIso: isoOf(dateOnly(date)),
  };
}
