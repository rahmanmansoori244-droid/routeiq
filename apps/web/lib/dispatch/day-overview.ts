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
  parseServiceArea,
  type CustomerIssue,
  type TypeProfileLike,
} from './customer-attrs';
import { currentPlan, ordersInScopeWhere, type ScenarioDetails } from './plan-service';
import { dateOnly, fmtHhmm, isoOf, todayIso, tomorrowIso } from './time';

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
}

export async function getDayOverview(tenantId: string, opts: { date?: string | null; depotId?: string | null }) {
  const db = tenantDb(tenantId);
  const cfg = await db.tenantConfig.findUniqueOrThrow({ where: { tenantId } });
  const depots = await db.depot.findMany({ where: { active: true }, orderBy: { code: 'asc' }, select: { id: true, code: true, name: true, lat: true, lng: true } });
  const depot = depots.find((d) => d.id === opts.depotId) ?? depots[0] ?? null;
  const date = opts.date && /^\d{4}-\d{2}-\d{2}$/.test(opts.date) ? opts.date : tomorrowIso(cfg.timezone);
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
    return { ...base, orders: { count: 0, cases: 0, customers: 0, late: 0, weightKg: 0 }, customers: [] as IssueCustomer[], productsWithoutWeight: [], plan: null, pending: { orderIds: [] as string[], count: 0, cases: 0, late: 0 }, trucks: { active: 0, capacityCases: 0 }, batches: [] };
  }
  const profiles = new Map<string, TypeProfileLike>((await db.customerTypeProfile.findMany()).map((p) => [p.customerType, p]));
  const area = parseServiceArea(cfg.serviceAreaJson);
  const where = await ordersInScopeWhere(tenantId, depot.id, dateOnly(date));
  const orders = await prisma.order.findMany({
    where,
    include: { customer: true, lines: { include: { product: { select: { code: true, name: true, weightPerCaseKg: true } } } } },
  });
  const byCustomer = new Map<string, IssueCustomer>();
  const noWeight = new Map<string, { code: string; name: string }>();
  for (const o of orders) {
    for (const l of o.lines) if (!(l.product.weightPerCaseKg > 0) && !(l.weightKg > 0)) noWeight.set(l.product.code, { code: l.product.code, name: l.product.name });
    const c = o.customer;
    const cur = byCustomer.get(c.id);
    if (cur) {
      cur.orders++;
      cur.cases += o.totalCases;
      continue;
    }
    const eff = effectiveAttrs(c, profiles, { serviceTimeMin: cfg.defaultServiceTimeMin });
    const issues = customerIssues(c, eff, area);
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
    });
  }
  const customers = [...byCustomer.values()].sort(
    (a, b) => Number(b.blocking) - Number(a.blocking) || b.issues.length - a.issues.length || a.priority - b.priority || b.cases - a.cases,
  );

  const plan = await currentPlan(tenantId, depot.id, date);
  let pending = { orderIds: [] as string[], count: 0, cases: 0, late: 0 };
  let planInfo = null;
  if (plan) {
    const job = await db.runJob.findFirst({ where: { runId: plan.id }, orderBy: { attemptNo: 'desc' } });
    const chosen = plan.chosenScenarioId ? await prisma.scenarioResult.findUnique({ where: { id: plan.chosenScenarioId } }) : null;
    const d = chosen?.detailsJson as unknown as ScenarioDetails | undefined;
    if (d?.scope) {
      const inPlan = new Set([...d.scope.orderIds, ...d.scope.frozenOrderIds]);
      const p = orders.filter((o) => !inPlan.has(o.id));
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
    missingLocation: customers.filter((c) => coordStatus(c.lat, c.lng, area) === 'MISSING').length,
    productsWithoutWeight: [...noWeight.values()],
    plan: planInfo,
    pending,
    trucks: { active: trucks.length, capacityCases: trucks.reduce((a, t) => a + t.capacityCases, 0) },
    batches: batches.map((b) => ({ ...b, uploadedAt: b.uploadedAt.toISOString() })),
    serviceArea: area,
    runDateIso: isoOf(dateOnly(date)),
  };
}
