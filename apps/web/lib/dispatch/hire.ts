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
 * - When a plan leaves orders out for a reason a truck more may help (CAPACITY_REASONS: the fleet's
 *   space, its loads per truck, its time, receiving hours no own truck reaches in time), a what-if
 *   optimization runs with one truck per unit it may rent (hireTrucksForRequest). The optimizer adds
 *   a premium to a rented truck's hire (apps/solver dispatch_solver.hire_premium): own trucks go
 *   first, a stop left out still costs more than any hire, and between rented trucks the hire counts
 *   in real money with their km.
 * - summarizeHire reads which rented trucks the what-if used: that is the suggestion. It counts the
 *   orders from the request the what-if used (an order added after the plan counts, one gone since
 *   does not) and says when the own fleet carried them (a re-plan, no hire) or when the what-if drops
 *   an order the plan in use delivers.
 */
import type { Prisma } from '@prisma/client';
import type { DispatchRequest, DispatchScenario, DispatchStop, DispatchTruck } from '@routeiq/shared-types';
import { orderIdOf } from './split';
import { palletText } from './pallets';

/**
 * Unserved reasons a truck to rent may help: the fleet's space (a fleet shortage, no room on any load,
 * an order bigger than any truck), its loads per truck, its trucks' time - also receiving hours: the
 * optimizer's window check tries the depot's OWN trucks from when each is free (after its locked or
 * dispatched loads, inside its hours), so a late order whose customer closes before any own truck is
 * back reads HARD_WINDOW_INFEASIBLE although a rented truck, free from the start of the day, reaches
 * it (review of the hire branch). The what-if's own check decides: a stop no truck reaches stays left
 * out there too ("Hiring does not help"). A reason no truck changes - no usable location, a conflict
 * with a locked plan - never starts a what-if.
 */
export const CAPACITY_REASONS: readonly string[] = [
  'SOLVER_DROPPED_LOW_PRIORITY',
  'LATE_ORDER_NO_CAPACITY',
  'TRIP_LIMIT',
  'NO_AVAILABLE_TRUCK',
  'SHIFT_LIMIT',
  'HARD_WINDOW_INFEASIBLE',
  'EXCEEDS_ANY_TRUCK_CAPACITY',
];

/** The reasons a stop the what-if still leaves out is about time, not trucks: receiving hours or the shift. */
const TIME_REASONS: readonly string[] = ['HARD_WINDOW_INFEASIBLE', 'SHIFT_LIMIT'];

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

/** "2026-10-07" (or its DATE value) -> ".261007": the suffix of a plate freed from a past day's hired truck. */
function freedSuffix(day: Date | string): string {
  const iso = typeof day === 'string' ? day.slice(0, 10) : day.toISOString().slice(0, 10);
  return `.${iso.slice(2, 4)}${iso.slice(5, 7)}${iso.slice(8, 10)}`;
}

/**
 * The code a past day's one-day hired truck takes when a later day's hired truck gets its plate
 * (the rental company sent the same truck again): "12345AB.261007" (hired-truck.ts). At most 32
 * characters, as every truck code.
 */
export function freedCode(code: string, day: Date | string): string {
  const suffix = freedSuffix(day);
  return `${code.slice(0, 32 - suffix.length)}${suffix}`;
}

/**
 * The code a load shows for its truck: the code it was planned with (its snapshot) - except on a
 * one-day hired truck, whose code the dispatcher changes to the real plate after "Use this plan": the
 * plate is what the driver sheets, the driver page and the plan must say. A past day's hired truck
 * whose plate a later day's truck took ("12345AB.261007", freedCode) still shows the plate it drove
 * with on its own plans.
 */
export function shownTruckCode(snapshotCode: string | null | undefined, truck: { code: string; onlyOnDate?: Date | string | null }): string {
  if (truck.onlyOnDate) {
    const suffix = freedSuffix(truck.onlyOnDate);
    return truck.code.length > suffix.length && truck.code.endsWith(suffix) ? truck.code.slice(0, -suffix.length) : truck.code;
  }
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
  /**
   * HIRE: rent `hires`. OWN_FLEET: the what-if delivers orders left out with the own trucks alone,
   * renting nothing (the plan's search missed them, or the day changed since): re-plan, no hire.
   * NO_HELP: the what-if delivers none of the orders left out.
   */
  status: 'HIRE' | 'OWN_FLEET' | 'NO_HELP';
  /**
   * What the plan in use does not deliver that a truck more may help, counted on the request the
   * what-if used: the stops it left out for a capacity reason that are still to plan, and the orders
   * added after it was made (newOrders of them).
   */
  leftOut: LeftOut;
  /** Of leftOut, orders the plan in use does not have at all (added after it was made); absent before the review. */
  newOrders?: number;
  hires: HireUse[];
  /** The hires' day costs added up. */
  hireCost: number;
  /** The other costs of the rented trucks' loads (km, fuel, trips, driver time), as the plan costs them. */
  runningCost: number;
  /** Of what was left out, delivered with the hires. */
  delivered: LeftOut;
  /** Of what was left out, still left out with the hires. */
  stillLeft: LeftOut;
  /**
   * Orders the plan in use delivers that the what-if leaves out (a Quick what-if after a Thorough
   * plan, say): never "still left out" - said on their own, and "Use this plan" then re-plans instead
   * of applying the what-if as it is (hire-use.ts). Absent before the review.
   */
  dropped?: LeftOut;
  /** The what-if's reasons for the stops still left out (reason code -> stops). */
  stillLeftReasons?: Record<string, number>;
  /** Trucks the what-if could rent, and how many of them it used. */
  unitsOffered?: number;
  unitsUsed?: number;
  /** One truck fewer: the rented truck whose stops matter least dropped, and what it carried left out. */
  alternative: { hires: HireUse[]; hireCost: number; leftOut: LeftOut; dropped: string } | null;
  /** The what-if's totals for the record. */
  trucksUsed: number;
  loads: number;
}

/**
 * The suggestion from a what-if answer (its recommended plan) and the plan in use. Counted on the
 * request the what-if used (review of the hire branch: the day may have changed since the plan):
 * "cannot be delivered with your fleet" = the stops the plan in use left out for a capacity reason
 * that are still to plan, plus - with `baseOrders`, the orders the plan in use delivers (its new and
 * its frozen loads) - every stop of an order it does not have at all (added after it was made). A stop
 * it left out for another reason (a conflict with a locked plan) stays out of every count: no truck to
 * rent changes it. A stop the plan in use delivers that the what-if leaves out is `dropped`, never
 * "still left out". The alternative is worked out from the what-if's own loads (no other
 * optimization): dropping the rented truck whose stops have the lowest priorities (then the fewest
 * cases) leaves those stops out - at most, since the other trucks might take some of them.
 */
export function summarizeHire(input: {
  request: DispatchRequest;
  baseUnserved: readonly UnservedLike[];
  /** The orders the plan in use delivers (HireBasis.baseOrders); absent: orders added since are not told apart. */
  baseOrders?: readonly string[];
  whatIf: Pick<DispatchScenario, 'loads' | 'unserved' | 'trucks_used' | 'trips'>;
  options: readonly HireOptionFacts[];
}): HireSummary {
  const { request, baseUnserved, whatIf, options } = input;
  const stops = request.stops;
  const inRequest = new Set(stops.map((s) => s.stop_id));
  const orderIdsOf = new Map([...baseUnserved.map((u) => [u.stop_id, u.order_ids] as const), ...whatIf.unserved.map((u) => [u.stop_id, u.order_ids] as const)]);
  const baseOut = new Set(baseUnserved.map((u) => u.stop_id));
  const capIds = new Set(capacityLeftOutIds(baseUnserved).filter((id) => inRequest.has(id)));
  const otherIds = new Set([...baseOut].filter((id) => !capIds.has(id)));
  const baseOrders = input.baseOrders ? new Set(input.baseOrders.map(orderIdOf)) : null;
  const newIds = baseOrders ? stops.filter((s) => !baseOut.has(s.stop_id) && !s.order_ids.some((o) => baseOrders.has(orderIdOf(o)))).map((s) => s.stop_id) : [];
  const outIds = new Set([...capIds, ...newIds]);
  const leftOut = leftOutOf(outIds, stops, orderIdsOf);
  const served = new Set(whatIf.loads.flatMap((l) => l.stops.map((s) => s.stop_id)));
  const delivered = leftOutOf([...outIds].filter((id) => served.has(id)), stops, orderIdsOf);
  const whatIfOut = whatIf.unserved.map((u) => u.stop_id);
  const stillLeft = leftOutOf(whatIfOut.filter((id) => outIds.has(id)), stops, orderIdsOf);
  const dropped = leftOutOf(whatIfOut.filter((id) => !outIds.has(id) && !otherIds.has(id)), stops, orderIdsOf);
  const stillLeftReasons: Record<string, number> = {};
  for (const u of whatIf.unserved) if (outIds.has(u.stop_id)) stillLeftReasons[u.reason_code] = (stillLeftReasons[u.reason_code] ?? 0) + 1;
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
    status: !delivered.stopIds.length ? 'NO_HELP' : hires.length ? 'HIRE' : 'OWN_FLEET',
    leftOut,
    newOrders: leftOutOf(newIds, stops).orders,
    hires,
    hireCost,
    runningCost,
    delivered,
    stillLeft,
    dropped,
    stillLeftReasons,
    unitsOffered: request.trucks.filter((t) => t.hire_candidate).length,
    unitsUsed: rented.length,
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

/** "14 orders (1,180 cases, 17.6 pallets)"; `added`: "...; 1 of them added after this plan was made)". */
export function leftOutText(l: LeftOut, added = 0): string {
  const parts = [plural(l.cases, 'case')];
  if (l.palletUnits !== null) parts.push(`${palletText(l.palletUnits)} pallets`);
  const late = added > 0 ? `; ${added === l.orders ? (l.orders === 1 ? 'added' : 'all added') : `${n(added)} of them added`} after this plan was made` : '';
  return `${plural(l.orders, 'order')} (${parts.join(', ')}${late})`;
}

/** "1 x 10-ton (12 bays) + 1 x 3-ton (6 bays)". */
export function hiresText(hires: readonly HireUse[]): string {
  return hires.map((h) => `${h.count} x ${h.label} (${h.bays !== null ? `${h.bays} bays` : `${n(h.capacityCases)} cases`})`).join(' + ');
}

/** "about 80 OMR". */
export function aboutMoney(x: number, currency = 'OMR'): string {
  return `about ${n(Math.round(x))} ${currency}`;
}

/** Why an order is still left out with every truck the company can rent (a suggestion stored before the reasons were kept). */
export const STILL_LEFT_WHY = 'even with every truck you can rent they do not fit (their receiving hours, the drivers’ shift or how many trucks you can rent)';

/**
 * Why the what-if still leaves orders out, said only as far as its answer backs it up (review of the
 * hire branch): its reasons (receiving hours or the shift; bigger than any truck) or every truck the
 * day could rent in use. Otherwise it is a search miss - trucks to rent stayed unused - and the words
 * say so: check again. `backed` false = that miss.
 */
export function stillLeftWhy(s: Pick<HireSummary, 'stillLeftReasons' | 'unitsOffered' | 'unitsUsed'>, orders: number): { backed: boolean; text: string } {
  const one = orders === 1;
  if (!s.stillLeftReasons || s.unitsOffered === undefined || s.unitsUsed === undefined) return { backed: true, text: STILL_LEFT_WHY };
  const has = (codes: readonly string[]) => codes.some((c) => (s.stillLeftReasons![c] ?? 0) > 0);
  const causes: string[] = [];
  if (has(TIME_REASONS)) causes.push('their receiving hours or the drivers’ shift');
  if (has(['EXCEEDS_ANY_TRUCK_CAPACITY'])) causes.push('bigger than any truck');
  if (s.unitsOffered > 0 && s.unitsUsed >= s.unitsOffered) causes.push('how many trucks you can rent');
  if (causes.length) {
    const list = causes.length > 1 ? `${causes.slice(0, -1).join(', ')} or ${causes[causes.length - 1]}` : causes[0];
    return { backed: true, text: `even with every truck you can rent ${one ? 'it does' : 'they do'} not fit (${list})` };
  }
  return { backed: false, text: `the Quick search did not place ${one ? 'it' : 'them'} although trucks you can rent stayed unused - press Check hire options to search again` };
}

/**
 * What the box says: the headline ("14 orders (...) cannot be delivered with your fleet. To deliver
 * them, hire 1 x 10-ton (12 bays) + 1 x 3-ton (6 bays): extra about 80 OMR. Still left out: none.")
 * and the detail lines (the running costs, one truck fewer).
 */
export function hireSuggestionText(s: HireSummary, currency = 'OMR'): { headline: string; details: string[] } {
  const what = leftOutText(s.leftOut, s.newOrders ?? 0);
  const cannot = `${what} cannot be delivered with your fleet.`;
  const one = s.leftOut.orders === 1;
  const still = () => {
    if (s.stillLeft.orders === 0) return 'none';
    return `${leftOutText(s.stillLeft)}: ${stillLeftWhy(s, s.stillLeft.orders).text}`;
  };
  const dropped = s.dropped?.orders
    ? ` But this check leaves out ${leftOutText(s.dropped)} your current plan delivers: Use this plan re-plans the day with the hired trucks instead.`
    : '';
  if (s.status === 'NO_HELP') {
    const why = stillLeftWhy(s, s.leftOut.orders);
    return {
      headline: why.backed
        ? `${cannot} Hiring does not help: ${why.text}.`
        : `${cannot} The hire check placed none of them although trucks you can rent stayed unused - press Check hire options to search again.`,
      details: [],
    };
  }
  if (s.status === 'OWN_FLEET') {
    const all = s.delivered.orders === s.leftOut.orders;
    const them = all ? (one ? 'it' : 'them') : `${plural(s.delivered.orders, 'order')} of them`;
    const rest = s.stillLeft.orders ? ` Still left out: ${still()}.` : '';
    return {
      headline: `${what} ${one ? 'is' : 'are'} left out of this plan, but the hire check fits ${them} on your own trucks: no truck needs to be hired. Re-plan to put ${all && one ? 'it' : 'them'} on your trucks.${rest}`,
      details: [],
    };
  }
  const headline = `${cannot} To deliver ${one ? 'it' : 'them'}, hire ${hiresText(s.hires)}: extra ${aboutMoney(s.hireCost, currency)}. Still left out: ${still()}.${dropped}`;
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
