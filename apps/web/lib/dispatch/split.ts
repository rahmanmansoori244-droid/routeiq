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

/** A part of an order that is planned (or unserved) on its own. */
export interface PortionRecord {
  orderId: string;
  lines: { lineId: string; cases: number }[];
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
 * when it does not fit the current part. A single case heavier than the payload still goes
 * into a part of its own (the optimizer then reports it as bigger than any truck).
 */
export function splitIntoParts(lines: OpenLine[], cap: PartCapacity): LineAllocation[][] {
  if (!(cap.cases > 0)) return [lines.filter((l) => l.cases > 0).map((l) => ({ orderId: l.orderId, lineId: l.lineId, cases: l.cases, weightKg: l.cases * l.kgPerCase }))];
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
  for (const p of parts) for (const a of p) a.weightKg = r1(a.weightKg);
  return parts;
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
 * choose from. Otherwise the size that can deliver the most cases. Parts then fit several
 * trucks, not only the single biggest one.
 */
export function choosePartCapacity(cases: number, kg: number, fleet: FleetTruck[]): { cap: PartCapacity; truckCode: string } | null {
  const usable = fleet.filter((t) => t.cases > 0);
  if (!usable.length) return null;
  const carries = (t: FleetTruck, c: FleetTruck) => t.cases >= c.cases && (t.kg === null || (c.kg !== null && t.kg >= c.kg));
  const ranked = usable.map((c) => {
    const parts = Math.max(Math.ceil(cases / c.cases), c.kg !== null && c.kg > 0 ? Math.ceil(kg / c.kg) : 1);
    const trips = usable.filter((t) => carries(t, c)).reduce((a, t) => a + Math.max(0, t.tripsLeft), 0);
    return { c, parts, trips, feasible: parts <= trips, deliverable: Math.min(parts, trips) * c.cases };
  });
  ranked.sort(
    (a, b) =>
      Number(b.feasible) - Number(a.feasible) ||
      (a.feasible ? a.parts - b.parts || b.trips - a.trips : b.deliverable - a.deliverable || a.parts - b.parts) ||
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

/** Group a part's line allocations into one portion per order. */
export function portionsOfPart(part: LineAllocation[], partNo: number | null, parts: number | null): PortionRecord[] {
  const byOrder = new Map<string, PortionRecord>();
  for (const a of part) {
    const p = byOrder.get(a.orderId) ?? { orderId: a.orderId, lines: [], cases: 0, weightKg: 0, part: partNo, parts };
    p.lines.push({ lineId: a.lineId, cases: a.cases });
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
