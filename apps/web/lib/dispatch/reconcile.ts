/**
 * Exact case reconciliation - non-negotiable.
 *
 *   UPLOADED cases  ==  PLANNED cases  +  UNSERVED cases
 *
 * checked in total, per SKU and per sales order, and every order must appear exactly once
 * (in one load, or unserved with a reason). The optimizer must never lose, duplicate or
 * invent cases, and must never merge two customer branches.
 */

export interface ReconLine {
  productCode: string;
  productName: string;
  salesOrderNo: string | null;
  cases: number;
}

export interface ReconOrder {
  id: string;
  customerId: string;
  customerKey: string; // code::branchKey - two branches are two keys
  lines: ReconLine[];
}

export interface ReconPlanned {
  orderId: string;
  customerId: string; // the customer the stop was planned for
  truckId: string;
  loadNo: number;
}

export interface ReconUnserved {
  orderId: string;
  reasonCode: string;
}

export interface ReconRow {
  key: string;
  label: string;
  uploaded: number;
  planned: number;
  unserved: number;
  ok: boolean;
}

export interface Reconciliation {
  ok: boolean;
  uploadedCases: number;
  plannedCases: number;
  unservedCases: number;
  orders: number;
  plannedOrders: number;
  unservedOrders: number;
  problems: string[];
  bySku: ReconRow[];
  bySalesOrder: ReconRow[];
}

export function reconcile(orders: ReconOrder[], planned: ReconPlanned[], unserved: ReconUnserved[]): Reconciliation {
  const problems: string[] = [];
  const byId = new Map(orders.map((o) => [o.id, o]));
  const seen = new Map<string, number>();
  for (const p of planned) seen.set(p.orderId, (seen.get(p.orderId) ?? 0) + 1);
  for (const u of unserved) seen.set(u.orderId, (seen.get(u.orderId) ?? 0) + 1);

  for (const o of orders) {
    const n = seen.get(o.id) ?? 0;
    if (n === 0) problems.push(`Order ${o.id} (${o.customerKey}) is neither planned nor unserved.`);
    if (n > 1) problems.push(`Order ${o.id} (${o.customerKey}) appears ${n} times.`);
  }
  for (const id of seen.keys()) {
    if (!byId.has(id)) problems.push(`Order ${id} is in the plan but was never uploaded for this day.`);
  }
  for (const p of planned) {
    const o = byId.get(p.orderId);
    if (o && o.customerId !== p.customerId) {
      problems.push(`Order ${p.orderId} belongs to ${o.customerKey} but was planned for another customer/branch.`);
    }
  }
  for (const u of unserved) {
    if (!u.reasonCode) problems.push(`Unserved order ${u.orderId} has no reason.`);
  }

  const plannedIds = new Set(planned.map((p) => p.orderId));
  const unservedIds = new Set(unserved.map((u) => u.orderId));
  const sku = new Map<string, ReconRow>();
  const so = new Map<string, ReconRow>();
  let uploadedCases = 0;
  let plannedCases = 0;
  let unservedCases = 0;
  const bump = (m: Map<string, ReconRow>, key: string, label: string, kind: 'uploaded' | 'planned' | 'unserved', v: number) => {
    const r = m.get(key) ?? { key, label, uploaded: 0, planned: 0, unserved: 0, ok: true };
    r[kind] += v;
    m.set(key, r);
  };
  for (const o of orders) {
    const isPlanned = plannedIds.has(o.id);
    const isUnserved = unservedIds.has(o.id);
    for (const l of o.lines) {
      uploadedCases += l.cases;
      bump(sku, l.productCode, l.productName, 'uploaded', l.cases);
      const soKey = l.salesOrderNo ?? `(no SO) ${o.customerKey}`;
      bump(so, soKey, soKey, 'uploaded', l.cases);
      // An order that is (wrongly) both planned and unserved counts twice on purpose, so the
      // arithmetic check fails loudly instead of hiding the duplicate.
      if (isPlanned) {
        plannedCases += l.cases;
        bump(sku, l.productCode, l.productName, 'planned', l.cases);
        bump(so, soKey, soKey, 'planned', l.cases);
      }
      if (isUnserved) {
        unservedCases += l.cases;
        bump(sku, l.productCode, l.productName, 'unserved', l.cases);
        bump(so, soKey, soKey, 'unserved', l.cases);
      }
    }
  }
  const finish = (m: Map<string, ReconRow>) =>
    [...m.values()]
      .map((r) => ({ ...r, ok: r.uploaded === r.planned + r.unserved }))
      .sort((a, b) => a.key.localeCompare(b.key));
  const bySku = finish(sku);
  const bySalesOrder = finish(so);
  if (uploadedCases !== plannedCases + unservedCases) {
    problems.push(`Cases do not reconcile: uploaded ${uploadedCases} != planned ${plannedCases} + unserved ${unservedCases}.`);
  }
  for (const r of bySku) if (!r.ok) problems.push(`SKU ${r.key}: uploaded ${r.uploaded} != planned ${r.planned} + unserved ${r.unserved}.`);
  for (const r of bySalesOrder) if (!r.ok) problems.push(`Sales order ${r.key}: uploaded ${r.uploaded} != planned ${r.planned} + unserved ${r.unserved}.`);
  return {
    ok: problems.length === 0,
    uploadedCases,
    plannedCases,
    unservedCases,
    orders: orders.length,
    plannedOrders: plannedIds.size,
    unservedOrders: unservedIds.size,
    problems,
    bySku,
    bySalesOrder,
  };
}

/** SKU totals for one truck load (warehouse loading manifest). */
export function aggregateSkus(lines: { productCode: string; productName: string; cases: number; weightKg: number }[]) {
  const m = new Map<string, { productCode: string; productName: string; cases: number; weightKg: number }>();
  for (const l of lines) {
    const r = m.get(l.productCode) ?? { productCode: l.productCode, productName: l.productName, cases: 0, weightKg: 0 };
    r.cases += l.cases;
    r.weightKg += l.weightKg;
    m.set(l.productCode, r);
  }
  // Kg are summed floats (12.7 x 12 = 152.39999...) - round for display and export.
  return [...m.values()]
    .map((r) => ({ ...r, weightKg: Math.round(r.weightKg * 10) / 10 }))
    .sort((a, b) => b.cases - a.cases || a.productCode.localeCompare(b.productCode));
}
