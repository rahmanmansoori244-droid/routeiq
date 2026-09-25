/**
 * Order line weights. Pure functions - plan-service, the day overview and the tests use them.
 *
 * Convention (the same as Product.weightPerCaseKg): a line weight of 0 means UNKNOWN, never
 * "weighs nothing". A line is weighed at intake from the file or the product master. When the
 * master had no weight yet, the line stays at 0 kg; once a case weight is entered under
 * Products, the next optimize or re-plan applies it to every open line (resolveOrderWeights in
 * plan-service, audited as ORDER_WEIGHTS_RESOLVED). Lines on frozen loads (locked, loading,
 * dispatched, completed) are never changed: what was loaded stays as it was.
 *
 * Orders from before line weights existed carry their kg on the order only (every line 0 kg,
 * order total above 0). Their order kg is spread per case, as before.
 */

export interface WeightLineIn {
  id: string;
  cases: number;
  weightKg: number;
  /** The product's case weight now (0 = unknown). */
  productKgPerCase: number;
}

export interface WeightOrderIn {
  id: string;
  totalWeightKg: number;
  lines: WeightLineIn[];
}

export interface LineWeightChange {
  orderId: string;
  lineId: string;
  cases: number;
  beforeKg: number;
  afterKg: number;
}

export interface OrderWeightChange {
  orderId: string;
  beforeKg: number;
  afterKg: number;
}

const r3 = (v: number) => Math.round(v * 1000) / 1000;

/** Tolerance used when comparing an order's kg with the sum of its lines' kg (float sums). */
export function kgTolerance(totalKg: number): number {
  return 0.5 + 0.001 * Math.abs(totalKg);
}

/**
 * Whether an order's weight lives on its lines (every order confirmed since line weights) or
 * only on the order (older orders: every line 0 kg or lines that do not add up to the order).
 */
export function orderUsesLineWeights(o: { totalWeightKg: number; lines: { weightKg: number }[] }): boolean {
  if (!(o.totalWeightKg > 0)) return true;
  const linesKg = o.lines.reduce((a, l) => a + l.weightKg, 0);
  return linesKg > 0 && Math.abs(linesKg - o.totalWeightKg) <= kgTolerance(o.totalWeightKg);
}

export type LineWeightStatus = 'KNOWN' | 'MASTER' | 'UNKNOWN';

/**
 * Weight status of one order line (line-based, never product-based):
 * - KNOWN: the line (or, for an old order, the order) carries its kg;
 * - MASTER: 0 kg on the line, but the product master now has a case weight - it is applied at
 *   the next optimize or re-plan;
 * - UNKNOWN: 0 kg and no case weight on the product: payload checks count it as 0 kg.
 */
export function lineWeightStatus(line: { weightKg: number }, productKgPerCase: number, orderLevelKg: boolean): LineWeightStatus {
  if (orderLevelKg || line.weightKg > 0) return 'KNOWN';
  return productKgPerCase > 0 ? 'MASTER' : 'UNKNOWN';
}

/**
 * Lines whose unknown (0 kg) weight can now be taken from the product master, and the new order
 * totals. Orders in `frozenOrderIds` (any part on a frozen load) and orders whose kg lives on
 * the order only are left as they are; lines that already carry kg are never changed.
 */
export function resolveOrderLineWeights(
  orders: WeightOrderIn[],
  frozenOrderIds: Set<string>,
): { lines: LineWeightChange[]; orders: OrderWeightChange[] } {
  const lineChanges: LineWeightChange[] = [];
  const orderChanges: OrderWeightChange[] = [];
  for (const o of orders) {
    if (frozenOrderIds.has(o.id) || !orderUsesLineWeights(o)) continue;
    let total = 0;
    let changed = false;
    for (const l of o.lines) {
      if (!(l.weightKg > 0) && l.productKgPerCase > 0 && l.cases > 0) {
        const afterKg = r3(l.cases * l.productKgPerCase);
        lineChanges.push({ orderId: o.id, lineId: l.id, cases: l.cases, beforeKg: l.weightKg, afterKg });
        total += afterKg;
        changed = true;
      } else {
        total += l.weightKg;
      }
    }
    if (changed) orderChanges.push({ orderId: o.id, beforeKg: o.totalWeightKg, afterKg: r3(total) });
  }
  return { lines: lineChanges, orders: orderChanges };
}

export interface UnknownWeight {
  productCode: string;
  productName: string;
  lines: number;
  cases: number;
}

/** Group unknown-weight lines per product, biggest first (for the WEIGHT_REQUIRED answer). */
export function groupUnknownWeights(lines: { productCode: string; productName: string; cases: number }[]): UnknownWeight[] {
  const m = new Map<string, UnknownWeight>();
  for (const l of lines) {
    const g = m.get(l.productCode) ?? { productCode: l.productCode, productName: l.productName, lines: 0, cases: 0 };
    g.lines++;
    g.cases += l.cases;
    m.set(l.productCode, g);
  }
  return [...m.values()].sort((a, b) => b.cases - a.cases || a.productCode.localeCompare(b.productCode));
}

/** Plain-language list of unknown-weight products ("TAN-500-24 (40 cases), ..."). */
export function describeUnknownWeights(list: UnknownWeight[], max = 6): string {
  const shown = list.slice(0, max).map((u) => `${u.productCode} (${u.cases} cases)`);
  return list.length > max ? `${shown.join(', ')} and ${list.length - max} more` : shown.join(', ');
}
