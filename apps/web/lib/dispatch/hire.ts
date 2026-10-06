/**
 * The hire suggestion (owner request 6 Oct 2026): "when the day's orders are more than the fleet can
 * carry, RouteIQ should not only list the undeliverable orders; it should tell the dispatcher how many
 * and which trucks to RENT, e.g. hire 1 x 10-ton + 1 x 3-ton".
 *
 * Pure (no server imports): the request's trucks to rent, the suggestion worked out from a what-if
 * answer, and the words the dispatcher reads. The server side (the what-if job, "Use this plan") is in
 * hire-whatif.ts and hire-use.ts.
 *
 * - A company admin enters the trucks the depot can rent (HireOption: label, bays or cases, payload,
 *   cost per day, cost per km, max per day).
 * - When a plan leaves orders out for a reason a truck more can help (CAPACITY_REASONS: the fleet's
 *   space, its loads per truck, its time), a what-if optimization runs with one truck per unit it may
 *   rent (hireTrucksForRequest). The optimizer weighs a rented truck's hire (apps/solver
 *   dispatch_solver.hire_weight): own trucks go first, a stop left out still costs more than any hire,
 *   and the cheapest set of rented trucks wins.
 * - summarizeHire reads which rented trucks the what-if used: that is the suggestion.
 */
import type { Prisma } from '@prisma/client';
import type { DispatchRequest, DispatchScenario, DispatchStop, DispatchTruck } from '@routeiq/shared-types';
import { orderIdOf } from './split';
import { palletText } from './pallets';

/**
 * Unserved reasons a truck to rent can help: the fleet's space (a fleet shortage, no room on any load,
 * an order bigger than any truck), its loads per truck, its trucks' time. A reason no truck changes -
 * no usable location, receiving hours no truck can reach - never starts a what-if.
 */
export const CAPACITY_REASONS: readonly string[] = [
  'SOLVER_DROPPED_LOW_PRIORITY',
  'LATE_ORDER_NO_CAPACITY',
  'TRIP_LIMIT',
  'NO_AVAILABLE_TRUCK',
  'SHIFT_LIMIT',
  'EXCEEDS_ANY_TRUCK_CAPACITY',
];

/** A hire option as the request and the suggestion use it. */
export interface HireOptionFacts {
  id: string;
  label: string;
  /** Pallet positions; null = planned by capacityCases. */
  bays: number | null;
  capacityCases: number;
  /** 0 = no weight limit. */
  payloadKg: number;
  costPerDay: number;
  /** OMR per km, fuel included; null = the depot's fleet average. */
  costPerKm: number | null;
  maxPerDay: number;
}

/** The ids the what-if gives its trucks to rent: never a real truck's id. */
export const HIRE_ID_PREFIX = 'hire~';

export function virtualHireId(optionId: string, n: number): string {
  return `${HIRE_ID_PREFIX}${optionId}~${n}`;
}

export function parseVirtualHireId(id: string): { optionId: string; n: number } | null {
  if (!id.startsWith(HIRE_ID_PREFIX)) return null;
  const rest = id.slice(HIRE_ID_PREFIX.length);
  const at = rest.lastIndexOf('~');
  if (at <= 0) return null;
  const n = Number(rest.slice(at + 1));
  return Number.isInteger(n) && n > 0 ? { optionId: rest.slice(0, at), n } : null;
}

/**
 * A short tag of the option's label for truck codes: "10-ton" / "10 Ton" / "10t" -> "10T", "3.5 ton"
 * -> "3.5T", "Box truck" -> "BOXTRU". Letters, digits and dots only (truck codes allow . _ -).
 */
export function hireTag(label: string): string {
  const ton = /(\d+(?:\.\d+)?)\s*-?\s*(?:t|ton|tons|tonne|tonnes)\b/i.exec(label);
  if (ton) return `${ton[1]}T`;
  const plain = label.toUpperCase().replace(/[^A-Z0-9]/g, '');
  return (plain || 'TRUCK').slice(0, 6);
}

/** "HIRE-10T-0710-1": the code of the n-th truck of an option rented for a delivery date (DDMM). */
export function hireTruckCode(label: string, dateIso: string, n: number): string {
  const [, mm, dd] = dateIso.split('-');
  return `HIRE-${hireTag(label)}-${dd}${mm}-${n}`;
}

/**
 * The trucks a depot's plan for `runDate` may use: its active trucks, a one-day truck ("Use this plan",
 * Truck.onlyOnDate) only on its own date - so it is never planned on another day, whatever its active
 * flag says (the janitor retires it after its day).
 */
export function trucksOfDayWhere(depotId: string, runDate: Date): Prisma.TruckWhereInput {
  return { depotId, active: true, OR: [{ onlyOnDate: null }, { onlyOnDate: runDate }] };
}

/**
 * The code a load shows for its truck: the code it was planned with (its snapshot) - except on a
 * one-day hired truck, whose code the dispatcher changes to the real plate after "Use this plan": the
 * plate is what the driver sheets, the driver page and the plan must say.
 */
export function shownTruckCode(snapshotCode: string | null | undefined, truck: { code: string; onlyOnDate?: Date | string | null }): string {
  if (truck.onlyOnDate) return truck.code;
  return snapshotCode || truck.code;
}

/** The depot's own trucks' averages a rented truck is costed with when its option names none. */
export interface FleetAverages {
  /** OMR per km, fuel included (cost per km + fuel price / km per litre). */
  costPerKm: number;
  tripCost: number;
}

/** Averages over the request's own trucks (never a truck to rent). Fuel at the request's fuel price. */
export function fleetAverages(trucks: readonly DispatchTruck[], fuelPricePerLitre: number): FleetAverages {
  const own = trucks.filter((t) => !t.hire_candidate);
  if (!own.length) return { costPerKm: 0, tripCost: 0 };
  const perKm = own.map((t) => (t.cost_per_km ?? 0) + (t.km_per_litre && fuelPricePerLitre > 0 ? fuelPricePerLitre / t.km_per_litre : 0));
  const round = (x: number) => Math.round(x * 10_000) / 10_000;
  return {
    costPerKm: round(perKm.reduce((a, x) => a + x, 0) / own.length),
    tripCost: round(own.reduce((a, t) => a + (t.trip_cost ?? 0), 0) / own.length),
  };
}

/**
 * The trucks to rent the what-if adds to the request: one per unit of each active option the day can
 * still rent (its max per day less the one-day trucks already rented from it for that day). Each is a
 * plain truck of the option's size, its hire as the day cost, the option's cost per km (else the
 * fleet's average, fuel included) and the fleet's average trip cost; `hire_candidate` lets the
 * optimizer weigh the hire.
 */
export function hireTrucksForRequest(
  options: readonly HireOptionFacts[],
  avg: FleetAverages,
  alreadyRented: Readonly<Record<string, number>> = {},
): DispatchTruck[] {
  const out: DispatchTruck[] = [];
  for (const o of options) {
    const units = Math.max(0, o.maxPerDay - (alreadyRented[o.id] ?? 0));
    for (let n = 1; n <= units; n++) {
      out.push({
        id: virtualHireId(o.id, n),
        code: `HIRE-${hireTag(o.label)}-${n}`,
        capacity_cases: o.capacityCases,
        capacity_kg: o.payloadKg,
        fixed_cost: o.costPerDay,
        trip_cost: avg.tripCost,
        cost_per_km: o.costPerKm ?? avg.costPerKm,
        km_per_litre: null,
        ...(o.bays !== null ? { bays: o.bays } : {}),
        hire_candidate: true,
      });
    }
  }
  return out;
}

/** Orders (and their cases, pallets and kg) of some unserved stops. */
export interface LeftOut {
  orders: number;
  cases: number;
  /** null when the day is not planned by pallets. */
  palletUnits: number | null;
  kg: number;
  /** The optimizer's stop ids (for the what-if's own comparisons). */
  stopIds: string[];
}

type UnservedLike = { stop_id: string; order_ids: string[]; reason_code: string };

/** The stops of `stopIds` as one LeftOut, from the request's stops (their demand). */
export function leftOutOf(stopIds: Iterable<string>, stops: readonly DispatchStop[], orderIdsOf?: Map<string, string[]>): LeftOut {
  const byId = new Map(stops.map((s) => [s.stop_id, s]));
  const ids = [...new Set(stopIds)].sort();
  const orders = new Set<string>();
  let cases = 0;
  let units = 0;
  let anyUnits = false;
  let kgTenths = 0;
  for (const id of ids) {
    const s = byId.get(id);
    for (const ref of s?.order_ids ?? orderIdsOf?.get(id) ?? []) orders.add(orderIdOf(ref));
    if (!s) continue;
    cases += s.demand_cases;
    kgTenths += Math.round((s.demand_kg ?? 0) * 10);
    if (typeof s.demand_pallet_units === 'number') {
      anyUnits = true;
      units += s.demand_pallet_units;
    }
  }
  return { orders: orders.size, cases, palletUnits: anyUnits ? units : null, kg: kgTenths / 10, stopIds: ids };
}

/** The stops a plan option left out that a truck to rent may help (CAPACITY_REASONS). */
export function capacityLeftOutIds(unserved: readonly UnservedLike[]): string[] {
  return unserved.filter((u) => CAPACITY_REASONS.includes(u.reason_code)).map((u) => u.stop_id);
}

/** Whether a plan option leaves anything out that a truck to rent may help: the what-if's trigger. */
export function needsHireCheck(unserved: readonly UnservedLike[] | null | undefined): boolean {
  return !!unserved?.some((u) => CAPACITY_REASONS.includes(u.reason_code));
}

/** One option of the suggestion: how many of it to rent. */
export interface HireUse {
  optionId: string;
  label: string;
  bays: number | null;
  capacityCases: number;
  count: number;
  costPerDay: number;
  /** The what-if's truck ids (virtual) of these trucks. */
  truckIds: string[];
}

export interface HireSummary {
  v: 1;
  /** HIRE: rent `hires`; NO_HELP: no truck to rent delivers any of the orders left out. */
  status: 'HIRE' | 'NO_HELP';
  /** What the plan in use leaves out because of the fleet (its capacity reasons). */
  leftOut: LeftOut;
  hires: HireUse[];
  /** The hires' day costs added up. */
  hireCost: number;
  /** The other costs of the rented trucks' loads (km, fuel, trips, driver time), as the plan costs them. */
  runningCost: number;
  /** Of what was left out, delivered with the hires. */
  delivered: LeftOut;
  /** Still left out with the hires (also an order the what-if left out that the plan in use delivered). */
  stillLeft: LeftOut;
  /** One truck fewer: the rented truck whose stops matter least dropped, and what it carried left out. */
  alternative: { hires: HireUse[]; hireCost: number; leftOut: LeftOut; dropped: string } | null;
  /** The what-if's totals for the record. */
  trucksUsed: number;
  loads: number;
}

/**
 * The suggestion from a what-if answer (its recommended plan) and the plan in use's unserved stops.
 * Only the stops the plan in use left out for a capacity reason count as "cannot be delivered with
 * your fleet"; one it left out for another reason (receiving hours no truck can reach) stays out of
 * every count: no truck to rent changes it. The alternative is worked out
 * from the what-if's own loads (no other optimization): dropping the rented truck whose stops have the
 * lowest priorities (then the fewest cases) leaves those stops out - at most, since the other trucks
 * might take some of them.
 */
export function summarizeHire(input: {
  request: DispatchRequest;
  baseUnserved: readonly UnservedLike[];
  whatIf: Pick<DispatchScenario, 'loads' | 'unserved' | 'trucks_used' | 'trips'>;
  options: readonly HireOptionFacts[];
}): HireSummary {
  const { request, baseUnserved, whatIf, options } = input;
  const stops = request.stops;
  const orderIdsOf = new Map(baseUnserved.map((u) => [u.stop_id, u.order_ids]));
  const capIds = new Set(capacityLeftOutIds(baseUnserved));
  const otherIds = new Set(baseUnserved.filter((u) => !capIds.has(u.stop_id)).map((u) => u.stop_id));
  const leftOut = leftOutOf(capIds, stops, orderIdsOf);
  const served = new Set(whatIf.loads.flatMap((l) => l.stops.map((s) => s.stop_id)));
  const delivered = leftOutOf([...capIds].filter((id) => served.has(id)), stops, orderIdsOf);
  const stillLeft = leftOutOf(
    whatIf.unserved.map((u) => u.stop_id).filter((id) => !otherIds.has(id)),
    stops,
    new Map(whatIf.unserved.map((u) => [u.stop_id, u.order_ids])),
  );
  const optionOf = new Map(options.map((o) => [o.id, o]));
  // The rented trucks the what-if used, per option.
  const loadsByTruck = new Map<string, typeof whatIf.loads>();
  for (const l of whatIf.loads) {
    if (!parseVirtualHireId(l.truck_id)) continue;
    loadsByTruck.set(l.truck_id, [...(loadsByTruck.get(l.truck_id) ?? []), l]);
  }
  const hires = usesOf([...loadsByTruck.keys()], optionOf);
  const hireCost = round2(hires.reduce((a, h) => a + h.count * h.costPerDay, 0));
  const runningCost = round2([...loadsByTruck.values()].flat().reduce((a, l) => a + (l.total_cost - l.fixed_cost), 0));

  let alternative: HireSummary['alternative'] = null;
  const rented = [...loadsByTruck.keys()];
  if (rented.length >= 2) {
    const priorityOf = new Map(stops.map((s) => [s.stop_id, s.priority ?? 3]));
    const casesOf = (id: string) => loadsByTruck.get(id)!.reduce((a, l) => a + l.cases, 0);
    const best = (id: string) => Math.min(...loadsByTruck.get(id)!.flatMap((l) => l.stops.map((s) => priorityOf.get(s.stop_id) ?? 3)));
    // The truck whose most important stop matters least (P5 before P1), then the one carrying least.
    const drop = [...rented].sort((a, b) => best(b) - best(a) || casesOf(a) - casesOf(b) || a.localeCompare(b))[0]!;
    const altHires = usesOf(rented.filter((id) => id !== drop), optionOf);
    const droppedStops = loadsByTruck.get(drop)!.flatMap((l) => l.stops.map((s) => s.stop_id));
    const dropOption = optionOf.get(parseVirtualHireId(drop)!.optionId);
    alternative = {
      hires: altHires,
      hireCost: round2(altHires.reduce((a, h) => a + h.count * h.costPerDay, 0)),
      leftOut: leftOutOf([...stillLeft.stopIds, ...droppedStops], stops, orderIdsOf),
      dropped: dropOption?.label ?? 'truck',
    };
  }
  return {
    v: 1,
    status: hires.length && delivered.stopIds.length ? 'HIRE' : 'NO_HELP',
    leftOut,
    hires,
    hireCost,
    runningCost,
    delivered,
    stillLeft,
    alternative,
    trucksUsed: whatIf.trucks_used,
    loads: whatIf.trips,
  };
}

function usesOf(truckIds: string[], optionOf: Map<string, HireOptionFacts>): HireUse[] {
  const by = new Map<string, string[]>();
  for (const id of truckIds) {
    const v = parseVirtualHireId(id);
    if (v) by.set(v.optionId, [...(by.get(v.optionId) ?? []), id]);
  }
  // Biggest first (bays, then cases), as the dispatcher reads them: "1 x 10-ton + 1 x 3-ton".
  return [...by.entries()]
    .map(([optionId, ids]) => {
      const o = optionOf.get(optionId);
      return {
        optionId,
        label: o?.label ?? 'truck',
        bays: o?.bays ?? null,
        capacityCases: o?.capacityCases ?? 0,
        count: ids.length,
        costPerDay: o?.costPerDay ?? 0,
        truckIds: ids.sort(),
      };
    })
    .sort((a, b) => (b.bays ?? 0) - (a.bays ?? 0) || b.capacityCases - a.capacityCases || a.label.localeCompare(b.label));
}

function round2(x: number): number {
  return Math.round(x * 100) / 100;
}

// ---------------------------------------------------------------------------------------------
// Words
// ---------------------------------------------------------------------------------------------

const n = (x: number) => x.toLocaleString('en-US');
const plural = (k: number, one: string, many = `${one}s`) => `${n(k)} ${k === 1 ? one : many}`;

/** "14 orders (1,180 cases, 17.6 pallets)". */
export function leftOutText(l: LeftOut): string {
  const parts = [plural(l.cases, 'case')];
  if (l.palletUnits !== null) parts.push(`${palletText(l.palletUnits)} pallets`);
  return `${plural(l.orders, 'order')} (${parts.join(', ')})`;
}

/** "1 x 10-ton (12 bays) + 1 x 3-ton (6 bays)". */
export function hiresText(hires: readonly HireUse[]): string {
  return hires.map((h) => `${h.count} x ${h.label} (${h.bays !== null ? `${h.bays} bays` : `${n(h.capacityCases)} cases`})`).join(' + ');
}

/** "about 80 OMR". */
export function aboutMoney(x: number, currency = 'OMR'): string {
  return `about ${n(Math.round(x))} ${currency}`;
}

/** Why an order is still left out with every truck the company can rent. */
export const STILL_LEFT_WHY = 'even with every truck you can rent they do not fit (their receiving hours, the drivers’ shift or how many trucks you can rent)';

/**
 * What the box says: the headline ("14 orders (...) cannot be delivered with your fleet. To deliver
 * them, hire 1 x 10-ton (12 bays) + 1 x 3-ton (6 bays): extra about 80 OMR. Still left out: none.")
 * and the detail lines (the running costs, one truck fewer).
 */
export function hireSuggestionText(s: HireSummary, currency = 'OMR'): { headline: string; details: string[] } {
  const cannot = `${leftOutText(s.leftOut)} cannot be delivered with your fleet.`;
  if (s.status === 'NO_HELP') {
    return {
      headline: `${cannot} Hiring does not help: ${STILL_LEFT_WHY}.`,
      details: [],
    };
  }
  const still = s.stillLeft.orders === 0 ? 'none' : `${leftOutText(s.stillLeft)}: ${STILL_LEFT_WHY}`;
  const headline = `${cannot} To deliver them, hire ${hiresText(s.hires)}: extra ${aboutMoney(s.hireCost, currency)}. Still left out: ${still}.`;
  const details: string[] = [];
  if (s.runningCost >= 0.5) {
    details.push(`Plus ${aboutMoney(s.runningCost, currency)} running costs on the hired trucks' loads (km, fuel, loading, driver time, as your plan costs them).`);
  }
  if (s.alternative) {
    const a = s.alternative;
    details.push(
      `With one truck fewer (${hiresText(a.hires)}, extra ${aboutMoney(a.hireCost, currency)}): up to ${leftOutText(a.leftOut)} stay undelivered - what the ${a.dropped} would carry${s.stillLeft.orders ? ' and the orders still left out' : ''}.`,
    );
  }
  return { headline, details };
}

// ---------------------------------------------------------------------------------------------
// "Nothing changed since it was computed"
// ---------------------------------------------------------------------------------------------

/** Config fields that move with the clock or the search, never with the day's data. */
const VOLATILE_CONFIG = new Set(['shift_start_min', 'loading_from_min', 'search_mode', 'max_search_sec', 'scenarios', 'time_limit_sec', 'osrm_url']);

function canonical(x: unknown): unknown {
  if (Array.isArray(x)) return x.map(canonical);
  if (x && typeof x === 'object') {
    return Object.fromEntries(
      Object.keys(x as Record<string, unknown>)
        .filter((k) => (x as Record<string, unknown>)[k] !== undefined)
        .sort()
        .map((k) => [k, canonical((x as Record<string, unknown>)[k])]),
    );
  }
  return x;
}

/**
 * What the what-if was computed from, as one text: the depot, every stop, the own trucks (their frozen
 * loads included), the planner settings (without what moves with the clock or the search) and the
 * frozen loads' ids. Equal texts = nothing changed since (hash it on the server).
 */
export function requestBasisText(r: DispatchRequest, frozenLoadIds: readonly string[] = []): string {
  const config = Object.fromEntries(Object.entries(r.config ?? {}).filter(([k]) => !VOLATILE_CONFIG.has(k)));
  return JSON.stringify(
    canonical({
      depot: r.depot,
      stops: [...r.stops].sort((a, b) => a.stop_id.localeCompare(b.stop_id)),
      trucks: r.trucks.filter((t) => !t.hire_candidate).sort((a, b) => a.id.localeCompare(b.id)),
      config,
      frozenLoadIds: [...frozenLoadIds].sort(),
    }),
  );
}

/** A plan made on its delivery day may start this many minutes later than the what-if and still be used as it is. */
export const SAME_DAY_SLACK_MIN = 10;

/**
 * A same-day what-if planned its new loads from the time it was made (loading_from_min): used later, its
 * first loads would leave too early. True when the plan made now would start more than
 * SAME_DAY_SLACK_MIN later, or the day turned into the delivery day since.
 */
export function sameDayMovedOn(then: DispatchRequest['config'] | undefined, now: DispatchRequest['config'] | undefined): boolean {
  const a = then?.loading_from_min ?? null;
  const b = now?.loading_from_min ?? null;
  if (a === null && b === null) return false;
  if (a === null || b === null) return true;
  return b - a > SAME_DAY_SLACK_MIN;
}
