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
 *
 * Pallets (owner decision 4 Oct 2026): a truck with bays is measured in pallet units (1/1000 pallet,
 * pallets.ts), not cases. A part sized for such a truck is filled up to its room (bays x fill) by
 * each line's cases / its cases per pallet, rounded up per line; its case count is then no limit.
 * A customer that fits one truck in that truck's own measure is never split.
 */
import { palletUnits, validPalletFactor } from './pallets';
import { kgTenths, payloadTenths, roundKg } from './weights';

export interface OpenLine {
  lineId: string;
  orderId: string;
  cases: number; // cases still to plan (after any frozen portion)
  kgPerCase: number;
  /** The product's cases per pallet (a usable factor), when the day is planned by pallets; null / absent = none. */
  casesPerPallet?: number | null;
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
  /** Room in pallet units (a truck with bays: bays x fill x 10); null / absent = measured in cases. */
  palletUnits?: number | null;
}

/** One line's cases in a portion. `kgPerCase`: the case weight the part was planned with (0 = no
 * weight, counted as 0 kg); absent on portions planned before it was kept, and on unserved rows.
 * `casesPerPallet`: the factor the part was cut with (a day planned by pallets). */
export interface PortionLine {
  lineId: string;
  cases: number;
  kgPerCase?: number;
  casesPerPallet?: number;
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

/**
 * Fits one truck of `cap`? By its pallet units (`units`) when `cap` is measured in pallets, else by
 * cases; and kg in 0.1 kg units, the optimizer's rule (weights.ts kgTenths / payloadTenths, audit F08).
 */
export function fitsCapacity(cases: number, kg: number, cap: PartCapacity, units = 0): boolean {
  const space = cap.palletUnits != null ? units <= cap.palletUnits : cases <= cap.cases;
  return space && (cap.kg === null || !(cap.kg > 0) || kgTenths(kg) <= payloadTenths(cap.kg));
}

/** The pallet units of some lines (or allocations), each rounded up on its own (pallets.ts). */
export function linesPalletUnits(lines: { lineId: string; cases: number }[], cpp: Map<string, number | null | undefined>): number {
  return lines.reduce((a, l) => a + palletUnits(l.cases, cpp.get(l.lineId) ?? null), 0);
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
  // Measured in pallets (a part sized for a truck with bays): the room is pallet units, cases are free.
  const roomUnits = cap.palletUnits ?? null;
  if (roomUnits !== null ? !(roomUnits > 0) : !(cap.cases > 0)) {
    return [roundPart(lines.filter((l) => l.cases > 0).map((l) => ({ orderId: l.orderId, lineId: l.lineId, cases: l.cases, weightKg: 0 })), kgPerCase)];
  }
  const parts: LineAllocation[][] = [];
  let cur: LineAllocation[] = [];
  let curCases = 0;
  let curKg = 0;
  let curUnits = 0; // each take rounded up on its own: never less than the part's true need
  const flush = () => {
    if (cur.length) parts.push(cur);
    cur = [];
    curCases = 0;
    curKg = 0;
    curUnits = 0;
  };
  for (const l of lines) {
    let left = l.cases;
    const cpp = roomUnits !== null ? (l.casesPerPallet ?? null) : null;
    while (left > 0) {
      const roomCases = roomUnits !== null ? Number.POSITIVE_INFINITY : cap.cases - curCases;
      const roomKg = cap.kg === null ? Number.POSITIVE_INFINITY : cap.kg - curKg;
      const byKg = l.kgPerCase > 0 ? Math.floor((roomKg + 1e-6) / l.kgPerCase) : Number.POSITIVE_INFINITY;
      // Whole cases whose units fit the pallet room left: floor(room x cpp / 1000) cases need at most
      // `room` units, rounded up (integers). A line without a factor counts 0 (the day is refused first).
      const byPallets = roomUnits !== null && cpp ? Math.floor(((roomUnits - curUnits) * cpp) / 1000) : Number.POSITIVE_INFINITY;
      let take = Math.min(left, roomCases, byKg, byPallets);
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
      curUnits += palletUnits(take, cpp);
      left -= take;
      const spaceFull = roomUnits !== null ? curUnits >= roomUnits : curCases >= cap.cases;
      if (spaceFull || (cap.kg !== null && curKg >= cap.kg - 1e-6)) flush();
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
  return roundKg(part.reduce((a, x) => a + x.cases * (kgPerCase.get(x.lineId) ?? 0), 0));
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
  /** A truck with bays: its room in pallet units (bays x fill x 10); null / absent = measured in cases. */
  palletUnits?: number | null;
}

/** The truck has room in its own measure (pallet units with bays, else cases). */
export function hasRoom(t: FleetTruck): boolean {
  return t.palletUnits != null ? t.palletUnits > 0 : t.cases > 0;
}

/**
 * The largest payload a case may go on (buildDispatchRequest's "heavier than any truck" rule; the day
 * screen reads the same): over the trucks with room and a load left today - every truck when none has
 * one left - and null when one of them has no payload (kg not limited).
 */
export function maxCasePayloadKg(fleet: readonly FleetTruck[]): number | null {
  const available = fleet.filter((t) => hasRoom(t) && t.tripsLeft > 0);
  const usable = (available.length ? available : fleet).filter(hasRoom);
  return usable.length && usable.every((t) => t.kg !== null) ? Math.max(...usable.map((t) => t.kg as number)) : null;
}

/** One case of `kgPerCase` is heavier than every payload (maxCasePayloadKg), in 0.1 kg units: it is left unserved before the optimizer. */
export function caseHeavierThanAnyTruck(kgPerCase: number, maxPayloadKg: number | null): boolean {
  return maxPayloadKg !== null && kgTenths(kgPerCase) > payloadTenths(maxPayloadKg);
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
 *
 * Pallets: a truck with bays offers a size in pallet units (`units` = the customer's pallet need);
 * its parts = max(units / its room, kg / its payload). A truck carries a size only in the same
 * measure (in a mixed fleet the trips are counted conservatively).
 */
export function choosePartCapacity(
  cases: number,
  kg: number,
  fleet: FleetTruck[],
  maxCaseKg = 0,
  units = 0,
): { cap: PartCapacity; truckCode: string } | null {
  const usable = fleet.filter(hasRoom);
  if (!usable.length) return null;
  const pal = (t: FleetTruck) => t.palletUnits != null;
  const size = (t: FleetTruck) => (pal(t) ? (t.palletUnits as number) : t.cases);
  const need = (t: FleetTruck) => (pal(t) ? units : cases);
  const carries = (t: FleetTruck, c: FleetTruck) =>
    pal(t) === pal(c) && size(t) >= size(c) && (t.kg === null || (c.kg !== null && t.kg >= c.kg));
  // Compared on the payload the part is sized for, in 0.1 kg (see below).
  const carriesHeaviestCase = (c: FleetTruck) => c.kg === null || !(c.kg > 0) || payloadTenths(c.kg) >= kgTenths(maxCaseKg);
  const candidates = usable.some(carriesHeaviestCase) ? usable.filter(carriesHeaviestCase) : usable;
  const ranked = candidates.map((c) => {
    const parts = Math.max(Math.ceil(need(c) / size(c)), c.kg !== null && c.kg > 0 ? Math.ceil(kg / c.kg) : 1);
    const trips = usable.filter((t) => carries(t, c)).reduce((a, t) => a + Math.max(0, t.tripsLeft), 0);
    // Share of the demand the trips can carry: the binding one of space (cases or pallets) and kg.
    const share = Math.min(1, need(c) > 0 ? (trips * size(c)) / need(c) : 1, c.kg !== null && c.kg > 0 && kg > 0 ? (trips * c.kg) / kg : 1);
    return { c, parts, trips, feasible: parts <= trips, share };
  });
  ranked.sort(
    (a, b) =>
      Number(b.feasible) - Number(a.feasible) ||
      (a.feasible ? a.parts - b.parts || b.trips - a.trips : b.share - a.share || a.parts - b.parts) ||
      size(b.c) - size(a.c) ||
      (b.c.kg ?? Infinity) - (a.c.kg ?? Infinity) ||
      a.c.code.localeCompare(b.c.code),
  );
  const best = ranked[0].c;
  // The payload rounded down to 0.1 kg, as the optimizer compares it (audit F08: it compared in
  // whole kg, so parts were sized for the payload floored to a whole kg - a hidden margin).
  const capKg = best.kg !== null && best.kg > 0 ? payloadTenths(best.kg) / 10 : null;
  return { cap: pal(best) ? { cases: best.cases, kg: capKg, palletUnits: best.palletUnits as number } : { cases: best.cases, kg: capKg }, truckCode: best.code };
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
export function portionsOfPart(
  part: LineAllocation[],
  partNo: number | null,
  parts: number | null,
  kgPerCase?: Map<string, number>,
  casesPerPallet?: Map<string, number | null | undefined>,
): PortionRecord[] {
  const byOrder = new Map<string, PortionRecord>();
  for (const a of part) {
    const p = byOrder.get(a.orderId) ?? { orderId: a.orderId, lines: [], cases: 0, weightKg: 0, part: partNo, parts };
    const kg = kgPerCase?.get(a.lineId);
    const cpp = casesPerPallet?.get(a.lineId);
    p.lines.push({
      lineId: a.lineId,
      cases: a.cases,
      ...(kg === undefined ? {} : { kgPerCase: kg }),
      // The factor the part was cut with (a day planned by pallets): manifests keep it.
      ...(typeof cpp === 'number' ? { casesPerPallet: cpp } : {}),
    });
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
 * The SKU lines a plan row carries, each with its share of the row's PLANNED kg (audit E3): what the
 * loading manifests and the Excel loading sheet show, so they add up exactly to the stop's and the
 * load's kg. `rowKg` is the row's kg as planned (its portion's kg, else the order's kg, to 0.1 kg).
 * It is shared over the lines, in 0.1 kg with the largest remainders, by (in this order):
 * - the case weight each line was planned with, when the portion kept it (a product weight
 *   corrected since - the verifiers' 300 kg load showed 200 kg on its loading sheet);
 * - else, for an order weighed at order level (`orderLevel`: every line 0 kg, or lines that do not
 *   add up to the order), per case - as the planner spreads it (they showed 0 kg);
 * - else the lines' own kg.
 * rowLines spread the lines' CURRENT kg pro rata and ignored both.
 */
export function rowLinesKg<L extends { id: string; cases: number; weightKg: number }>(lines: L[], portionJson: unknown, rowKg: number, orderLevel: boolean): L[] {
  const pl = readPortionLines(portionJson);
  const byId = new Map(lines.map((l) => [l.id, l]));
  const rows: { l: L; cases: number }[] = pl
    ? pl.flatMap((p) => {
        const l = byId.get(p.lineId);
        return l && p.cases > 0 ? [{ l, cases: p.cases }] : [];
      })
    : lines.map((l) => ({ l, cases: l.cases }));
  const kept = readPortionLineKg(portionJson);
  const perCase = rows.map((r) => r.cases);
  const ownKg = rows.map((r) => (r.l.cases > 0 ? (r.l.weightKg * r.cases) / r.l.cases : 0));
  const sum = (xs: number[]) => xs.reduce((a, v) => a + v, 0);
  const basis = [kept ? rows.map((r) => (kept.get(r.l.id) ?? 0) * r.cases) : null, orderLevel ? perCase : ownKg, perCase].find(
    (b): b is number[] => !!b && sum(b) > 0,
  );
  const total = kgTenths(rowKg);
  if (!basis || total <= 0) return rows.map((r) => ({ ...r.l, cases: r.cases, weightKg: 0 }));
  const whole = sum(basis);
  const exact = basis.map((b) => (b * total) / whole);
  const units = exact.map((e) => Math.floor(e + 1e-9));
  let left = total - sum(units);
  const byRemainder = exact.map((e, i) => ({ i, rem: e - units[i] })).sort((a, b) => b.rem - a.rem || a.i - b.i);
  for (const { i } of byRemainder) {
    if (left <= 0) break;
    units[i] += 1;
    left--;
  }
  return rows.map((r, i) => ({ ...r.l, cases: r.cases, weightKg: units[i] / 10 }));
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

/**
 * The cases per pallet each line of a stored portion row was cut with (a day planned by pallets),
 * by line id; lines without it are left out. Empty for an order row that is not a portion.
 */
export function readPortionPalletFactors(json: unknown): Map<string, number> {
  const out = new Map<string, number>();
  if (!Array.isArray(json)) return out;
  for (const x of json) {
    const l = x as { lineId?: unknown; casesPerPallet?: unknown };
    if (typeof l.lineId === 'string' && typeof l.casesPerPallet === 'number' && Number.isInteger(l.casesPerPallet) && l.casesPerPallet > 0) {
      out.set(l.lineId, l.casesPerPallet);
    }
  }
  return out;
}

/**
 * A stored row's pallets with the cases per pallet known now, when they give other pallets than the
 * row was planned with (pallets review: a factor corrected under Products after planning never reached
 * the day screen or the dispatch check, so a load it puts over its bays was locked and dispatched).
 * The row's lines (a split part's own, else the whole order's) are worked out again with today's
 * factors, each line rounded up as the request builder does, so a row whose factors did not change
 * gives exactly its stored units and returns null. null too when the row has no units (planned by
 * cases) or a line's product has no usable factor now (the day's red list names it).
 * `products`: the products whose factor now differs from the one the row was planned with, as far as
 * the plan says (the factor a split part was cut with, else the option's `palletFactors`); empty when
 * it does not say (a load kept from an earlier version). `cases`: the cases of those lines (all the
 * row's cases when none is named).
 */
export function rowPalletUnitsNow(
  orderLines: readonly { id: string; cases: number; product: { code?: string; casesPerPallet?: number | null } }[],
  portionLinesJson: unknown,
  storedUnits: number | null | undefined,
  plannedFactors: Readonly<Record<string, number>>,
): { units: number; products: string[]; cases: number } | null {
  if (typeof storedUnits !== 'number') return null;
  const byId = new Map(orderLines.map((l) => [l.id, l]));
  const cut = readPortionPalletFactors(portionLinesJson);
  const lines = readPortionLines(portionLinesJson) ?? orderLines.map((l) => ({ lineId: l.id, cases: l.cases }));
  let units = 0;
  let all = 0;
  let namedCases = 0;
  const products = new Set<string>();
  for (const x of lines) {
    if (!(x.cases > 0)) continue;
    const l = byId.get(x.lineId);
    const live = validPalletFactor(l?.product.casesPerPallet);
    if (!l || live === null) return null;
    units += palletUnits(x.cases, live);
    all += x.cases;
    const code = l.product.code ?? '';
    const planned = cut.get(x.lineId) ?? validPalletFactor(code ? plannedFactors[code] : null);
    if (planned !== null && planned !== live) {
      products.add(code);
      namedCases += x.cases;
    }
  }
  if (units === storedUnits) return null;
  return { units, products: [...products].sort(), cases: products.size ? namedCases : all };
}

/**
 * The case weight each line of a stored portion row was PLANNED with, as far as the row says
 * (stabilization PR4 review; the timetable check and the day overview read the same rule):
 * - a part planned since kgPerCase is kept: every line's own kgPerCase (0 = planned with no weight);
 * - a part planned before that: only its lines with no kg on the order that the part's own kg shows
 *   were planned at 0 kg (the part weighs no more than its lines that have a kg) - those map to 0;
 *   other lines are not known (absent). An order weighed on the order only (`orderLevelKg`) says nothing.
 * Null when the row is not a portion (a whole order: its lines hold the kg it was planned with).
 */
export function portionPlannedKgPerCase(
  row: { portionLinesJson: unknown; portionWeightKg: number | null },
  lines: { id: string; cases: number; weightKg: number }[],
  orderLevelKg: boolean,
): Map<string, number> | null {
  const pl = readPortionLines(row.portionLinesJson);
  if (!pl) return null;
  const kept = readPortionLineKg(row.portionLinesJson);
  if (kept) return kept;
  const out = new Map<string, number>();
  if (orderLevelKg) return out;
  const byId = new Map(lines.map((l) => [l.id, l]));
  const zeroLines = pl.filter((x) => {
    const l = byId.get(x.lineId);
    return !!l && x.cases > 0 && !(l.weightKg > 0);
  });
  const knownKg = pl.reduce((s, x) => {
    const l = byId.get(x.lineId);
    return s + (l && l.weightKg > 0 && l.cases > 0 ? (l.weightKg * x.cases) / l.cases : 0);
  }, 0);
  // Each stored kg is rounded to 0.1 kg: a part planned at the product's weight weighs more.
  if (zeroLines.length && (row.portionWeightKg ?? 0) <= knownKg + 0.05 * (pl.length + 1)) for (const x of zeroLines) out.set(x.lineId, 0);
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
