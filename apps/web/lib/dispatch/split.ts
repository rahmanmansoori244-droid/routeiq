/**
 * Split deliveries: a customer whose day is bigger than the largest truck (in cases or kg) is
 * delivered in several parts. Pure functions - the planner (plan-service) and the tests use them.
 *
 * The split is decided HERE, on real order lines, not inside the optimizer: every part carries
 * exactly which SKU lines (and how many cases of each) it contains, so loading manifests and
 * the case reconciliation stay exact. The optimizer just sees ordinary stops at the same place.
 *
 * Strategy: fill part 1 up to one full largest truck, then part 2, ... (lines in order, a line is
 * cut only when it does not fit). The last part is the remainder, which the optimizer can
 * combine with other customers.
 */

export interface OpenLine {
  lineId: string;
  orderId: string;
  cases: number; // cases still to plan (after any frozen portion)
  kgPerCase: number;
}

export interface LineAllocation {
  orderId: string;
  lineId: string;
  cases: number;
  weightKg: number;
}

export interface PartCapacity {
  cases: number;
  kg: number | null; // null = weight not constrained
}

/** One line's cases in a portion. `kgPerCase`: the case weight the part was planned with (0 = no
 * weight, counted as 0 kg); absent on portions planned before it was kept, and on unserved rows. */
export interface PortionLine {
  lineId: string;
  cases: number;
  kgPerCase?: number;
}

/** A part of an order that is planned (or unserved) on its own. */
export interface PortionRecord {
  orderId: string;
  lines: PortionLine[];
  cases: number;
  weightKg: number;
  part: number | null; // 1-based part of the customer's split delivery (null = not split)
  parts: number | null;
}

const r1 = (v: number) => Math.round(v * 10) / 10;

/** Fits one truck of `cap`? (tiny tolerance for float kg sums) */
export function fitsCapacity(cases: number, kg: number, cap: PartCapacity): boolean {
  return cases <= cap.cases && (cap.kg === null || kg <= cap.kg + 1e-6);
}

/**
 * Cut the lines into parts that each fit `cap`. Lines keep their order; a line is split only
 * when it does not fit the current part. A single case heavier than `cap.kg` still goes into a
 * part of its own, so the loop always ends. That part is sent with its true kg (partDemandKg):
 * the optimizer puts it on a truck that can carry it, or reports it as unserved. (Cases heavier
 * than every truck never get here: buildDispatchRequest leaves them unserved first, with
 * "check the product weight".)
 */
export function splitIntoParts(lines: OpenLine[], cap: PartCapacity): LineAllocation[][] {
  const kgPerCase = new Map(lines.map((l) => [l.lineId, l.kgPerCase] as const));
  if (!(cap.cases > 0)) {
    return [roundPart(lines.filter((l) => l.cases > 0).map((l) => ({ orderId: l.orderId, lineId: l.lineId, cases: l.cases, weightKg: 0 })), kgPerCase)];
  }
  const parts: LineAllocation[][] = [];
  let cur: LineAllocation[] = [];
  let curCases = 0;
  let curKg = 0;
  const flush = () => {
    if (cur.length) parts.push(cur);
    cur = [];
    curCases = 0;
    curKg = 0;
  };
  for (const l of lines) {
    let left = l.cases;
    while (left > 0) {
      const roomCases = cap.cases - curCases;
      const roomKg = cap.kg === null ? Number.POSITIVE_INFINITY : cap.kg - curKg;
      const byKg = l.kgPerCase > 0 ? Math.floor((roomKg + 1e-6) / l.kgPerCase) : Number.POSITIVE_INFINITY;
      let take = Math.min(left, roomCases, byKg);
      if (take <= 0) {
        if (cur.length) {
          flush();
          continue;
        }
        take = 1; // one case alone is over the payload: keep it visible rather than loop forever
      }
      const prev = cur[cur.length - 1];
      if (prev && prev.lineId === l.lineId) {
        prev.cases += take;
        prev.weightKg += take * l.kgPerCase;
      } else {
        cur.push({ orderId: l.orderId, lineId: l.lineId, cases: take, weightKg: take * l.kgPerCase });
      }
      curCases += take;
      curKg += take * l.kgPerCase;
      left -= take;
      if (curCases >= cap.cases || (cap.kg !== null && curKg >= cap.kg - 1e-6)) flush();
    }
  }
  flush();
  return parts.map((p) => roundPart(p, kgPerCase));
}

/**
 * The true kg of a part (to 0.1 kg), from the exact case weights of its lines. Never capped at
 * the payload the part was sized for: a part that fills its truck rounds to at most that
 * payload anyway (splitIntoParts only adds whole cases that fit), and a part holding one case
 * heavier than the payload must show its real weight so it is not planned onto that truck.
 */
export function partDemandKg(part: { lineId: string; cases: number }[], kgPerCase: Map<string, number>): number {
  return r1(part.reduce((a, x) => a + x.cases * (kgPerCase.get(x.lineId) ?? 0), 0));
}

/**
 * Each allocation's kg to 0.1 kg such that they add up EXACTLY to the part's kg sent to the
 * optimizer (partDemandKg): every value is its exact kg rounded down or up, and the tenths the
 * part total needs go to the largest remainders. Rounding each allocation on its own could make
 * the stored portions of a part filled to its payload weigh 0.1 kg more than the payload (12.35 kg
 * cases: 12.4 + 9867.7 = 9880.1 on a 9880 kg truck the optimizer was right to fill), which the
 * dispatch check would then refuse on every re-plan (stabilization PR4 review).
 */
function roundPart(part: LineAllocation[], kgPerCase: Map<string, number>): LineAllocation[] {
  const exact = part.map((a) => a.cases * (kgPerCase.get(a.lineId) ?? 0) * 10); // tenths of a kg
  const units = exact.map((e) => Math.floor(e + 1e-9));
  const target = Math.round(partDemandKg(part, kgPerCase) * 10);
  let left = Math.min(part.length, Math.max(0, target - units.reduce((a, u) => a + u, 0)));
  const byRemainder = exact.map((e, i) => ({ i, rem: e - units[i] })).sort((a, b) => b.rem - a.rem || a.i - b.i);
  for (const { i } of byRemainder) {
    if (left <= 0) break;
    units[i] += 1;
    left--;
  }
  return part.map((a, i) => ({ ...a, weightKg: units[i] / 10 }));
}

export interface FleetTruck {
  code: string;
  cases: number;
  kg: number | null; // null = payload not set
  tripsLeft: number; // loads it can still do today (max trips minus frozen loads)
}

/**
 * Part size for a customer that fits no truck. Each truck's capacity is a candidate size; a
 * size is carried by every truck at least that big, and it is feasible when those trucks have
 * enough trips left for all parts. Feasible sizes: fewest parts wins, then more trips to
 * choose from. Otherwise the size that can deliver the largest share of the customer's cases
 * AND kg. Parts then fit several trucks, not only the single biggest one.
 *
 * `maxCaseKg` is the heaviest single case of the customer: sizes whose payload cannot carry it
 * are used only when no truck can (a part sized for a small truck would hold cases that only a
 * bigger truck may legally carry).
 */
export function choosePartCapacity(
  cases: number,
  kg: number,
  fleet: FleetTruck[],
  maxCaseKg = 0,
): { cap: PartCapacity; truckCode: string } | null {
  const usable = fleet.filter((t) => t.cases > 0);
  if (!usable.length) return null;
  const carries = (t: FleetTruck, c: FleetTruck) => t.cases >= c.cases && (t.kg === null || (c.kg !== null && t.kg >= c.kg));
  // Compared on the whole-kg payload the part is sized for (see the floor below).
  const carriesHeaviestCase = (c: FleetTruck) => c.kg === null || !(c.kg > 0) || Math.floor(c.kg) + 1e-6 >= maxCaseKg;
  const candidates = usable.some(carriesHeaviestCase) ? usable.filter(carriesHeaviestCase) : usable;
  const ranked = candidates.map((c) => {
    const parts = Math.max(Math.ceil(cases / c.cases), c.kg !== null && c.kg > 0 ? Math.ceil(kg / c.kg) : 1);
    const trips = usable.filter((t) => carries(t, c)).reduce((a, t) => a + Math.max(0, t.tripsLeft), 0);
    // Share of the demand the trips can carry: the binding one of cases and kg.
    const share = Math.min(1, cases > 0 ? (trips * c.cases) / cases : 1, c.kg !== null && c.kg > 0 && kg > 0 ? (trips * c.kg) / kg : 1);
    return { c, parts, trips, feasible: parts <= trips, share };
  });
  ranked.sort(
    (a, b) =>
      Number(b.feasible) - Number(a.feasible) ||
      (a.feasible ? a.parts - b.parts || b.trips - a.trips : b.share - a.share || a.parts - b.parts) ||
      b.c.cases - a.c.cases ||
      (b.c.kg ?? Infinity) - (a.c.kg ?? Infinity) ||
      a.c.code.localeCompare(b.c.code),
  );
  const best = ranked[0].c;
  // Whole kilograms: the optimizer compares loads in whole kg, so a part filled to a fractional
  // payload could otherwise miss the very truck it was sized for.
  return { cap: { cases: best.cases, kg: best.kg !== null && best.kg > 0 ? Math.floor(best.kg) : null }, truckCode: best.code };
}

/**
 * Money of part of an order: from its own lines when every line of the order carries the value
 * (a high-value SKU part is worth more), else the order value pro rata by cases.
 */
export function portionMoney(
  orderValue: number | null,
  orderCases: number,
  lines: { id: string; cases: number; value: number | null }[],
  portion: { lineId: string; cases: number }[],
): number | null {
  if (orderValue === null) return null;
  if (lines.length && lines.every((l) => l.value !== null)) {
    const byId = new Map(lines.map((l) => [l.id, l]));
    return portion.reduce((a, p) => {
      const l = byId.get(p.lineId);
      return a + (l && l.cases > 0 ? ((l.value as number) * p.cases) / l.cases : 0);
    }, 0);
  }
  const cases = portion.reduce((a, p) => a + p.cases, 0);
  return orderCases > 0 ? (orderValue * cases) / orderCases : orderValue;
}

/** Id the optimizer sees for a portion of an order (order ids are cuids, never contain "~"). */
export function portionId(orderId: string, key: string | number): string {
  return `${orderId}~${key}`;
}

/** The order an optimizer order-id refers to: the id itself, or the order of a portion id. */
export function orderIdOf(id: string): string {
  const i = id.indexOf('~');
  return i < 0 ? id : id.slice(0, i);
}

/**
 * Group a part's line allocations into one portion per order. With `kgPerCase` (the planner's case
 * weights), each portion line also keeps the case weight it was planned with, so the dispatch
 * check can tell cases planned at 0 kg from the plan itself, not from today's product master.
 */
export function portionsOfPart(part: LineAllocation[], partNo: number | null, parts: number | null, kgPerCase?: Map<string, number>): PortionRecord[] {
  const byOrder = new Map<string, PortionRecord>();
  for (const a of part) {
    const p = byOrder.get(a.orderId) ?? { orderId: a.orderId, lines: [], cases: 0, weightKg: 0, part: partNo, parts };
    const kg = kgPerCase?.get(a.lineId);
    p.lines.push(kg === undefined ? { lineId: a.lineId, cases: a.cases } : { lineId: a.lineId, cases: a.cases, kgPerCase: kg });
    p.cases += a.cases;
    p.weightKg = r1(p.weightKg + a.weightKg);
    byOrder.set(a.orderId, p);
  }
  return [...byOrder.values()];
}

/** Merge several portions of the same order (e.g. two unserved parts) into one. */
export function mergePortions(list: PortionRecord[]): PortionRecord {
  const lines = new Map<string, number>();
  let weightKg = 0;
  for (const p of list) {
    for (const l of p.lines) lines.set(l.lineId, (lines.get(l.lineId) ?? 0) + l.cases);
    weightKg += p.weightKg;
  }
  return {
    orderId: list[0].orderId,
    lines: [...lines].map(([lineId, cases]) => ({ lineId, cases })),
    cases: list.reduce((a, p) => a + p.cases, 0),
    weightKg: r1(weightKg),
    part: null,
    parts: null,
  };
}

/** SKU lines a plan row carries: its portion's lines (kg pro rata), or every line of the order. */
export function rowLines<L extends { id: string; cases: number; weightKg: number }>(lines: L[], portionJson: unknown): L[] {
  const pl = readPortionLines(portionJson);
  if (!pl) return lines;
  const byId = new Map(lines.map((l) => [l.id, l]));
  return pl.flatMap((p) => {
    const l = byId.get(p.lineId);
    return l && p.cases > 0 ? [{ ...l, cases: p.cases, weightKg: l.cases > 0 ? r1((l.weightKg * p.cases) / l.cases) : 0 }] : [];
  });
}

/**
 * "Part k of n" for a customer delivered in several parts: numbered over the whole plan in
 * departure order (so a re-plan that keeps a dispatched part 1 still reads naturally).
 */
export function splitPartLabels<S extends { customerId: string; portion: boolean; departMin: number; truckCode: string; sequence: number }>(
  stops: S[],
): Map<S, { part: number; parts: number }> {
  const byCustomer = new Map<string, S[]>();
  for (const s of stops) if (s.portion) byCustomer.set(s.customerId, [...(byCustomer.get(s.customerId) ?? []), s]);
  const out = new Map<S, { part: number; parts: number }>();
  for (const list of byCustomer.values()) {
    list.sort((a, b) => a.departMin - b.departMin || a.truckCode.localeCompare(b.truckCode) || a.sequence - b.sequence);
    list.forEach((s, i) => out.set(s, { part: i + 1, parts: list.length }));
  }
  return out;
}

/**
 * The case weight each line of a stored portion was planned with (PortionLine.kgPerCase), or null
 * when the portion does not say (planned before it was kept): then only the portion's kg is known.
 */
export function readPortionLineKg(json: unknown): Map<string, number> | null {
  if (!Array.isArray(json) || !json.length) return null;
  const out = new Map<string, number>();
  for (const x of json) {
    const l = x as { lineId?: unknown; kgPerCase?: unknown };
    if (typeof l.lineId !== 'string' || typeof l.kgPerCase !== 'number' || !Number.isFinite(l.kgPerCase)) return null;
    out.set(l.lineId, l.kgPerCase);
  }
  return out;
}

/** Portion lines as stored in portionLinesJson (defensive: anything else = no portion). */
export function readPortionLines(json: unknown): { lineId: string; cases: number }[] | null {
  if (!Array.isArray(json)) return null;
  const out: { lineId: string; cases: number }[] = [];
  for (const x of json) {
    const l = x as { lineId?: unknown; cases?: unknown };
    if (typeof l.lineId === 'string' && typeof l.cases === 'number') out.push({ lineId: l.lineId, cases: l.cases });
  }
  return out;
}
