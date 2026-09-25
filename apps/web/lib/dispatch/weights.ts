/**
 * Order line weights. Pure functions - plan-service, the day overview, intake and the tests use them.
 *
 * Convention (the same as Product.weightPerCaseKg): a line weight of 0 means UNKNOWN, never
 * "weighs nothing". A line is weighed at intake from the file or, when the file has no weight
 * for it, from the product master (`OrderLine.weightFromMaster`). A line weighed from the master
 * follows it: when the case weight is entered or corrected under Products (e.g. 1500 typed for
 * 1.5), the next optimize or re-plan plans every open line with the product's weight now and
 * saves it on the line (ORDER_WEIGHTS_RESOLVED audit). Weights from the file are never changed.
 * Lines on frozen loads (locked, loading, dispatched, completed) keep what they were loaded with.
 *
 * Orders from before line weights existed carry their kg on the order only (every line 0 kg,
 * order total above 0). Their order kg is spread per case, as before.
 */

export interface WeightLineIn {
  id: string;
  cases: number;
  weightKg: number;
  /** The line was weighed from the product master (no file weight): it follows the master. */
  fromMaster: boolean;
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

/**
 * The one tolerance for comparing a load's stored kg (a sum of order and portion kg, each kept to
 * 0.1 kg) with a payload or with the optimizer's own kg: applyScenario's kg cross-check, the
 * dispatch check's CAPACITY_KG (feasibility.ts) and the workbook's Kg check. Rounding can never
 * block a load the optimizer filled to its payload; a real overload is always far above it.
 */
export const KG_ROUNDING_TOL = 0.5;

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

/**
 * The kg a line gets from the product's case weight now, or null when it keeps its own kg:
 * a line at 0 kg (unknown) or weighed from the master, whose product has a case weight that
 * gives another kg than the line has. A line with a file weight is never re-weighed.
 */
export function masterLineKg(line: { cases: number; weightKg: number; fromMaster: boolean }, productKgPerCase: number): number | null {
  if (!(productKgPerCase > 0) || !(line.cases > 0)) return null;
  if (line.weightKg > 0 && !line.fromMaster) return null;
  const kg = r3(line.cases * productKgPerCase);
  return Math.abs(kg - line.weightKg) > 0.0005 ? kg : null;
}

/**
 * How intake weighs one confirmed line (a line can merge several file rows of the same sales
 * order and product). Every row with a file weight: the file kg. Otherwise the line is weighed
 * from the product master and follows it - cases x the case weight, or 0 kg (unknown) when the
 * product has none yet. A partly weighed merged line is not kept at the kg of only some of its
 * cases: that figure would count as known and be too low for good.
 */
export function intakeLineWeight(
  line: { cases: number; weightKg: number | null; weightMissingCases?: number },
  productKgPerCase: number,
): { weightKg: number; fromMaster: boolean } {
  const missing = line.weightMissingCases ?? (line.weightKg === null ? line.cases : 0);
  if (missing <= 0 && line.weightKg !== null && line.weightKg > 0) return { weightKg: line.weightKg, fromMaster: false };
  return { weightKg: productKgPerCase > 0 ? r3(line.cases * productKgPerCase) : 0, fromMaster: true };
}

export type LineWeightStatus = 'KNOWN' | 'MASTER' | 'UNKNOWN';

/**
 * Weight status of one order line (line-based, never product-based):
 * - KNOWN: the line (or, for an old order, the order) carries its kg;
 * - MASTER: the product's case weight gives the line another kg than it has - 0 kg and the
 *   weight was entered since, or weighed from the master and the weight was corrected since.
 *   It is applied at the next optimize or re-plan;
 * - UNKNOWN: 0 kg and no case weight on the product: payload checks count it as 0 kg.
 */
export function lineWeightStatus(
  line: { cases: number; weightKg: number; fromMaster: boolean },
  productKgPerCase: number,
  orderLevelKg: boolean,
): LineWeightStatus {
  if (orderLevelKg) return 'KNOWN';
  if (masterLineKg(line, productKgPerCase) !== null) return 'MASTER';
  return line.weightKg > 0 ? 'KNOWN' : 'UNKNOWN';
}

/**
 * Lines whose kg now comes from the product master (see masterLineKg), and the new order
 * totals. Orders in `frozenOrderIds` (any part on a frozen load) and orders whose kg lives on
 * the order only are left as they are; lines with a file weight are never changed.
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
      const afterKg = masterLineKg(l, l.productKgPerCase);
      if (afterKg !== null) {
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
