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
 * Weights to the optimizer and on stored loads are whole units of 0.1 kg (audit F08, owner decision
 * 15: no hidden rounding margin). One rule on both sides: each order (or split portion) is rounded
 * to the NEAREST 0.1 kg, exactly as the solver's kg_units does (floor(kg x 10 + 0.5), the same
 * floating-point steps in both languages), and a payload is rounded DOWN to 0.1 kg (payload_units).
 * So the kg the optimizer planned a load with, the load's stored kg and the dispatch check's kg are
 * the same sum of the same tenths.
 */
export function kgTenths(kg: number): number {
  return kg > 0 ? Math.floor(kg * 10 + 0.5) : 0;
}

/** kg rounded to the nearest 0.1 kg (kgTenths / 10). */
export function roundKg(kg: number): number {
  return kgTenths(kg) / 10;
}

/** A payload in 0.1 kg units, rounded down (the solver's payload_units); 0 = no payload. */
export function payloadTenths(kg: number): number {
  return kg > 0 ? Math.floor(kg * 10 + 1e-6) : 0;
}

/**
 * The one tolerance for comparing a load's stored kg (a sum of order and portion kg, each kept to
 * 0.1 kg) with a payload or with the optimizer's own kg: applyScenario's kg cross-check, the
 * dispatch check's CAPACITY_KG (feasibility.ts) and the workbook's Kg check. Rounding can never
 * block a load the optimizer filled to its payload; a real overload is always far above it.
 */
export const KG_ROUNDING_TOL = 0.5;

/** kg as the plan screen shows them: to 0.1 kg, like the load's own kg (896.8, never 897; 2,303.6). */
export function kgText(kg: number): string {
  return kg.toLocaleString('en-US', { maximumFractionDigits: 1 });
}

/** A loading manifest's kg: its product lines added up, to 0.1 kg (the plan screen and the Excel). */
export function manifestKgOf(manifest: readonly { weightKg: number }[]): number {
  return Math.round(manifest.reduce((a, m) => a + m.weightKg, 0) * 10) / 10;
}

/** The manifest's kg differ from the load's recorded kg by more than rounding (KG_ROUNDING_TOL). */
export function manifestKgDiffers(manifestKg: number, loadKg: number): boolean {
  return Math.abs(manifestKg - loadKg) > KG_ROUNDING_TOL;
}

/**
 * The plan screen's line under a load's manifest when its products no longer add up to the load's
 * kg (A6 second review; the Excel load sheet says "MISMATCH: load records N kg (order weights
 * changed since planning)"). The products carry each order's kg now, the load the kg it was
 * planned with: only an older version, kept for the record, whose orders a later re-plan re-weighed
 * (a corrected product weight) can differ. null when they agree.
 */
export function manifestKgNote(l: { manifest: readonly { weightKg: number }[]; weightKg: number }): string | null {
  const productsKg = manifestKgOf(l.manifest);
  if (!manifestKgDiffers(productsKg, l.weightKg)) return null;
  return `The load was planned at ${kgText(l.weightKg)} kg. Order weights changed since planning, so the products add up to ${kgText(productsKg)} kg.`;
}

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
 * The case weight a line was planned with (`planned`; undefined = the row does not say) is not the
 * product's case weight now: 0 kg and a weight entered since, or a weight corrected since. The
 * open rest of an order partly on a frozen load is out of date only then (the day overview and
 * the plan view, second review of PR4): it is planned with the product's weight at every optimize
 * but never saved on the line it shares with the frozen part.
 */
export function plannedKgDiffers(planned: number | undefined, productKgPerCase: number): boolean {
  return planned !== undefined && Math.abs(planned - productKgPerCase) > 1e-3;
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
