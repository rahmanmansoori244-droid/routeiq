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
  id?: string; // needed when portions (split deliveries) refer to lines
  productCode: string;
  productName: string;
  salesOrderNo: string | null;
  cases: number;
}

/** Part of an order (split delivery): exact cases per order line. Absent = the whole order. */
export type ReconPortion = { lineId: string; cases: number }[] | null | undefined;

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
  lines?: ReconPortion;
}

export interface ReconUnserved {
  orderId: string;
  reasonCode: string;
  lines?: ReconPortion;
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
  plannedOrders: number; // orders with at least one planned case
  unservedOrders: number; // orders with at least one unserved case
  partialOrders: number; // split deliveries: some cases planned, the rest unserved
  problems: string[];
  bySku: ReconRow[];
  bySalesOrder: ReconRow[];
}

/**
 * `expectedOrderIds`: the orders the plan was made for (its scope). An expected order that no
 * longer exists (deleted after planning) is a problem: its cases would otherwise silently drop
 * out of both sides of the sum.
 */
export function reconcile(orders: ReconOrder[], planned: ReconPlanned[], unserved: ReconUnserved[], expectedOrderIds?: string[]): Reconciliation {
  const problems: string[] = [];
  const byId = new Map(orders.map((o) => [o.id, o]));
  for (const id of new Set(expectedOrderIds ?? [])) {
    if (!byId.has(id)) problems.push(`Order ${id} is in this plan but no longer exists (deleted after planning).`);
  }
  const lineIdOf = (o: ReconOrder, idx: number) => o.lines[idx].id ?? `${o.id}#${idx}`;
  // An order is either on the plan whole (once), or in portions whose cases add up per line.
  const whole = new Map<string, number>();
  const portions = new Map<string, number>();
  const seen = new Map<string, number>();
  for (const e of [...planned, ...unserved]) {
    seen.set(e.orderId, (seen.get(e.orderId) ?? 0) + 1);
    const m = e.lines ? portions : whole;
    m.set(e.orderId, (m.get(e.orderId) ?? 0) + 1);
  }

  for (const o of orders) {
    const n = seen.get(o.id) ?? 0;
    const w = whole.get(o.id) ?? 0;
    if (n === 0) problems.push(`Order ${o.id} (${o.customerKey}) is neither planned nor unserved.`);
    if (w > 1 || (w === 1 && n > 1)) problems.push(`Order ${o.id} (${o.customerKey}) appears ${n} times.`);
  }
  for (const id of seen.keys()) {
    if (!byId.has(id)) problems.push(`Order ${id} is in the plan but was never uploaded for this day.`);
  }
  // Cases per order line, planned and unserved. A whole-order entry counts every line in full.
  const plannedByLine = new Map<string, number>();
  const unservedByLine = new Map<string, number>();
  const add = (target: Map<string, number>, e: { orderId: string; lines?: ReconPortion }) => {
    const o = byId.get(e.orderId);
    if (!o) return;
    if (!e.lines) {
      o.lines.forEach((l, i) => target.set(lineIdOf(o, i), (target.get(lineIdOf(o, i)) ?? 0) + l.cases));
      return;
    }
    const known = new Set(o.lines.map((_, i) => lineIdOf(o, i)));
    for (const pl of e.lines) {
      if (!known.has(pl.lineId)) {
        problems.push(`Order ${o.id} (${o.customerKey}): a split portion refers to line ${pl.lineId}, which is not on the order.`);
        continue;
      }
      target.set(pl.lineId, (target.get(pl.lineId) ?? 0) + pl.cases);
    }
  };
  for (const p of planned) add(plannedByLine, p);
  for (const u of unserved) add(unservedByLine, u);
  for (const p of planned) {
    const o = byId.get(p.orderId);
    if (o && o.customerId !== p.customerId) {
      problems.push(`Order ${p.orderId} belongs to ${o.customerKey} but was planned for another customer/branch.`);
    }
  }
  for (const u of unserved) {
    if (!u.reasonCode) problems.push(`Unserved order ${u.orderId} has no reason.`);
  }

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
  let plannedOrders = 0;
  let unservedOrders = 0;
  let partialOrders = 0;
  for (const o of orders) {
    let orderPlanned = 0;
    let orderUnserved = 0;
    o.lines.forEach((l, i) => {
      const id = lineIdOf(o, i);
      // An order (wrongly) both planned and unserved counts twice on purpose, so the
      // arithmetic check fails loudly instead of hiding the duplicate.
      const p = plannedByLine.get(id) ?? 0;
      const u = unservedByLine.get(id) ?? 0;
      orderPlanned += p;
      orderUnserved += u;
      uploadedCases += l.cases;
      plannedCases += p;
      unservedCases += u;
      const soKey = l.salesOrderNo ?? `(no SO) ${o.customerKey}`;
      bump(sku, l.productCode, l.productName, 'uploaded', l.cases);
      bump(so, soKey, soKey, 'uploaded', l.cases);
      bump(sku, l.productCode, l.productName, 'planned', p);
      bump(so, soKey, soKey, 'planned', p);
      bump(sku, l.productCode, l.productName, 'unserved', u);
      bump(so, soKey, soKey, 'unserved', u);
      if ((portions.get(o.id) ?? 0) > 0 && p + u !== l.cases) {
        problems.push(`Order ${o.id} (${o.customerKey}) ${l.productCode}: uploaded ${l.cases} != planned ${p} + unserved ${u} across its split portions.`);
      }
    });
    if (orderPlanned > 0) plannedOrders++;
    if (orderUnserved > 0) unservedOrders++;
    if (orderPlanned > 0 && orderUnserved > 0 && (portions.get(o.id) ?? 0) > 0) partialOrders++;
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
    plannedOrders,
    unservedOrders,
    partialOrders,
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
