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
 *   cost per day, the rental's own km charge if any, max per day).
 * - Only P1-P3 orders justify renting (owner answer 1, 6 Oct 2026): when a plan leaves P1-P3 orders out
 *   for a reason a truck more may help (CAPACITY_REASONS: the fleet's space, its loads per truck, its
 *   time, receiving hours no own truck reaches in time), a what-if optimization runs with one truck per
 *   unit it may rent (hireTrucksForRequest). P4/P5 orders left out alone start nothing: the box says so
 *   plainly (lowPriorityText). The optimizer ranks a rented truck in a hire tier (apps/solver
 *   dispatch_solver._service_and_hire): own trucks first, the cheapest set of rented trucks in real
 *   money (hire + the driver's day rate), never one for P4/P5 orders alone - which still ride along
 *   in a rented truck's spare room. After its search it REDUCES the set (sixth review: on the real
 *   Muscat day Quick rented 2 x 10-ton where one carried every P1-P3 order): a rented truck with only
 *   P4/P5 orders is given back without a solve (its orders put back on the trucks kept where they fit, a
 *   P4 order in place of P5 orders where need be: tenth review, strict priorities; also from a plan kept
 *   as the search found it, and into free room: eleventh review; also on an idle own truck, and an order
 *   left out told that a truck is not rented for P4/P5 orders alone: twelfth review), then every cheaper
 *   set (as many trucks as it takes, another option's trucks too) is tried cheapest first, and the first
 *   that keeps every P1-P3 order delivered, with no truck for P4/P5 orders alone once given back, is the
 *   suggestion
 *   (seventh review: the cheapest set, not the one left after the dearest truck goes; eighth review:
 *   2 x 3-ton at 80 OMR beat 1 x 10-ton at 85); a set left after a give-back is solved once more when
 *   the limits allow and it was not solved already, and its plan is taken only when it passes every
 *   check, keeps every P1-P3 order and is cheaper, or as cheap and serving more by the day's priorities
 *   - so those P4/P5 orders may ride along in the trucks kept; otherwise they stay out
 *   (dispatch_solver._reduce_hire, DispatchResponse.hire_check). "One truck fewer" is such a solve; when
 *   it keeps every P1-P3 order it is the suggestion (tenth review). Every plan it judges, the search's
 *   own included, is first repaired with no solve: a P1-P3 order it leaves out goes back in place of
 *   lower priorities where it fits, or in place of one other order of a load that goes on elsewhere; a
 *   solve still leaving one out while a lower priority rides along is
 *   solved once more, or never rules its set out (thirteenth review: such a solve ruled 1 x 10-ton out
 *   and 2 x 3-ton was suggested, "complete").
 * - A rented truck is rented for the whole day (as many loads as its max loads per truck, owner answer
 *   2), its fuel is in the hire (no fuel, no km cost unless the option charges per km, answer 3), and
 *   its casual driver is paid the company's daily driver day rate (Settings, answer 4).
 * - summarizeHire reads which rented trucks the what-if used: that is the suggestion. It counts the
 *   orders from the request the what-if used (an order added after the plan counts, one gone since
 *   does not) and says when the own fleet carried them (a re-plan, no hire) or when the what-if drops
 *   an order the plan in use delivers.
 */
import type { Prisma } from '@prisma/client';
import type { DispatchRequest, DispatchScenario, DispatchStop, DispatchTruck, HireCheck } from '@routeiq/shared-types';
import { orderIdOf } from './split';
import { palletText } from './pallets';
import { fmtDayMonth } from './time';

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
  /**
   * The rental's own charge per km (OMR), if it has one; null = none (0). Fuel is always in the hire
   * (owner answer 3, 6 Oct 2026): a rented truck never costs fuel or the fleet's km rate.
   */
  costPerKm: number | null;
  maxPerDay: number;
}

/**
 * The company's "Daily driver day rate" until an admin sets it (owner answer 4, 6 Oct 2026: a rough
 * 10 OMR; TenantConfig.dailyDriverDayRate has the same default).
 */
export const DEFAULT_DRIVER_DAY_RATE = 10;

/** Owner answer 1 (6 Oct 2026): only P1-P3 orders justify renting a truck. */
export const HIRE_MAX_PRIORITY = 3;

/**
 * A truck hired for the day ("Use this plan": hired, Truck.onlyOnDate) is planned like the trucks the
 * what-if offered: its driver paid the company's day rate (driver_day_cost), never by the hour; its fuel
 * is in the hire (it was made without km per litre). Own trucks: nothing ({}).
 */
export function hiredTruckDriver(truck: { hired?: boolean | null; onlyOnDate?: Date | string | null }, dayRate: number | null | undefined): { driver_day_cost?: number } {
  return truck.hired && truck.onlyOnDate ? { driver_day_cost: dayRate ?? DEFAULT_DRIVER_DAY_RATE } : {};
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
 * The Trucks page badge of a one-day hired truck: "1 day: 11 Oct", as the rest of the screen says a day
 * (sixth review of the hire branch: it said "1 day: 2026-10-11").
 */
export function oneDayBadge(onlyOnDate: Date | string): string {
  const iso = typeof onlyOnDate === 'string' ? onlyOnDate.slice(0, 10) : onlyOnDate.toISOString().slice(0, 10);
  return `1 day: ${fmtDayMonth(iso)}`;
}

/**
 * The tooltip of a load's "hired" badge on the plan screen: "Hired for 11 Oct only (hire suggestion)" for a
 * truck rented for one day (eighth review of the hire branch: it said "Hired for 2026-10-11 only" beside
 * "11 Oct" everywhere else), "Hired from outside" for any other hired truck.
 */
export function hiredLoadBadgeTitle(oneDay: string | null | undefined): string {
  return oneDay ? `Hired for ${fmtDayMonth(oneDay)} only (hire suggestion)` : 'Hired from outside';
}

/**
 * The Trucks page's case capacity of a truck: "by bays" for a truck planned by pallets with no case
 * capacity of its own (a truck rented from a hire option with bays; sixth review: it read "0"), else
 * its cases.
 */
export function truckCapacityText(t: { capacityCases: number; bays?: number | null }): string {
  return t.bays && t.capacityCases <= 0 ? 'by bays' : t.capacityCases.toLocaleString('en-US');
}

/**
 * The description of a truck rented with the hire suggestion (hire-use.ts): "Hired 10-ton for 11 Oct (hire
 * suggestion)" - the day as its "1 day: 11 Oct" badge says it (seventh review of the hire branch: the
 * Trucks page row said "for 2026-10-11" beside it).
 */
export function hiredTruckDescription(label: string, dateIso: string): string {
  return `Hired ${label} for ${fmtDayMonth(dateIso)} (hire suggestion)`;
}

/**
 * A truck's description as the Trucks page shows it: a hired truck's stored before the seventh review
 * ("Hired 10-ton for 2026-10-11 (hire suggestion)") with its day as "11 Oct"; any other as typed; "—" none.
 */
export function truckDescriptionText(description: string | null | undefined): string {
  if (!description) return '—';
  const m = /^Hired (.+) for (\d{4}-\d{2}-\d{2}) \(hire suggestion\)$/.exec(description);
  return m ? hiredTruckDescription(m[1]!, m[2]!) : description;
}

/**
 * "Use this plan"'s question (the hire suggestion box), the day said "11 Oct" as the rest of the screen
 * says it (sixth review of the hire branch: "for 2026-10-11"). `dateIso` null: "this day". A hired truck
 * works its whole day with one driver (seventh review: it still said "pick the driver on each load").
 */
export function hireUseConfirmText(
  s: { hires: readonly Pick<HireUse, 'label' | 'count'>[]; dropped?: Pick<LeftOut, 'orders' | 'byPriority'> | null },
  dateIso: string | null,
): string {
  const trucks = s.hires.map((h) => `${h.count} x ${h.label}`).join(' + ');
  const day = dateIso ? fmtDayMonth(dateIso) : 'this day';
  const w = s.dropped?.orders ? ordersWords(s.dropped.orders, s.dropped.byPriority) : null;
  const drops = w
    ? `\n\nThe check's plan leaves out ${w.mix ? `${w.what} (${w.mix})` : w.what} your current plan delivers, so RouteIQ re-plans the day with the hired trucks instead of taking it as it is.`
    : '';
  return `Hire ${trucks} for ${day} and use this plan?\n\nThe trucks are added for ${day} only (codes HIRE-...; enter each one's real plate with Plate on its load). Each one is rented for the whole day with one driver: + Add daily driver on one of its loads puts that driver on its other loads still to plan too, and makes them its default driver. A new plan version is made with them; locked and dispatched loads stay exactly as they are. If the day changed since this was computed, RouteIQ re-plans with the hired trucks instead.${drops}`;
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

/** What a rented truck takes from the depot's own trucks: the loading cost per load (the depot's work, whatever truck). */
export interface FleetAverages {
  tripCost: number;
}

/**
 * The average loading cost per load of the request's own trucks (never a truck to rent). Never their
 * km or fuel: a rented truck's fuel is in its hire (owner answer 3, 6 Oct 2026).
 */
export function fleetAverages(trucks: readonly DispatchTruck[]): FleetAverages {
  const own = trucks.filter((t) => !t.hire_candidate);
  if (!own.length) return { tripCost: 0 };
  return { tripCost: Math.round((own.reduce((a, t) => a + (t.trip_cost ?? 0), 0) / own.length) * 10_000) / 10_000 };
}

/**
 * The trucks to rent the what-if adds to the request: one per unit of each active option the day can
 * still rent (its max per day less the one-day trucks already rented from it for that day). Each is a
 * plain truck of the option's size for the whole day (the company's max loads per truck): its hire as
 * the day cost, fuel included (no km per litre; only the option's own km charge, else 0), its casual
 * driver at the company's day rate (driver_day_cost) and the fleet's average loading cost per load;
 * `hire_candidate` puts it in the optimizer's hire tier. Placeholder codes are numbered per size tag
 * across the request (review of the hire branch: "10-ton curtain" and "10-ton box" both sent
 * HIRE-10T-1, and a finding about one named the other).
 */
export function hireTrucksForRequest(
  options: readonly HireOptionFacts[],
  avg: FleetAverages,
  alreadyRented: Readonly<Record<string, number>> = {},
  driverDayRate: number = DEFAULT_DRIVER_DAY_RATE,
): DispatchTruck[] {
  const out: DispatchTruck[] = [];
  const perTag = new Map<string, number>();
  for (const o of options) {
    const units = Math.max(0, o.maxPerDay - (alreadyRented[o.id] ?? 0));
    const tag = hireTag(o.label);
    for (let n = 1; n <= units; n++) {
      const k = (perTag.get(tag) ?? 0) + 1;
      perTag.set(tag, k);
      out.push({
        id: virtualHireId(o.id, n),
        code: `HIRE-${tag}-${k}`,
        capacity_cases: o.capacityCases,
        capacity_kg: o.payloadKg,
        fixed_cost: o.costPerDay,
        trip_cost: avg.tripCost,
        cost_per_km: o.costPerKm ?? 0,
        km_per_litre: null,
        driver_day_cost: driverDayRate,
        ...(o.bays !== null ? { bays: o.bays } : {}),
        hire_candidate: true,
      });
    }
  }
  return out;
}

/**
 * The trucks to rent of a what-if request as the request builder sizes a customer's parts with them
 * (buildDispatchRequest `splitFleet`, fix of 7 Oct 2026): every truck it may rent, so a customer that
 * fits one of them stays one visit. "Use this plan" reads the day again with the same trucks, so its
 * stops are the what-if's.
 */
export function hireSplitFleet(trucks: readonly DispatchTruck[]): { code: string; capacityCases: number; payloadKg: number | null; bays: number | null }[] {
  return trucks
    .filter((t) => t.hire_candidate)
    .map((t) => ({ code: t.code ?? t.id, capacityCases: t.capacity_cases, payloadKg: t.capacity_kg ?? null, bays: typeof t.bays === 'number' ? t.bays : null }));
}

/**
 * The plan in use's left-out stops in the stop ids of the request the what-if sent (pure). The what-if
 * sizes a customer's parts with the trucks to rent too (hireSplitFleet), so a customer the plan in use
 * split into parts ("C#1", "C#2", "C#3") can be one stop ("C") there. A left-out stop the request does
 * not have stands for the request's stops that hold one of its orders, with its reason; a stop the
 * request has keeps its own row.
 */
export function alignUnserved<U extends UnservedLike>(base: readonly U[], stops: readonly Pick<DispatchStop, 'stop_id' | 'order_ids'>[]): UnservedLike[] {
  const ids = new Set(stops.map((s) => s.stop_id));
  const out = new Map<string, UnservedLike>();
  for (const u of base) {
    if (ids.has(u.stop_id)) {
      if (!out.has(u.stop_id)) out.set(u.stop_id, { stop_id: u.stop_id, order_ids: u.order_ids, reason_code: u.reason_code });
      continue;
    }
    const orders = new Set(u.order_ids.map(orderIdOf));
    for (const s of stops) {
      if (out.has(s.stop_id) || !s.order_ids.some((o) => orders.has(orderIdOf(o)))) continue;
      out.set(s.stop_id, { stop_id: s.stop_id, order_ids: s.order_ids, reason_code: u.reason_code });
    }
  }
  return [...out.values()];
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
  /**
   * Orders per priority ("4" -> 1), where the words name them (HireSummary.dropped; ninth review of the
   * hire branch: the box said "1 order" for a P4 order the check leaves out). Absent elsewhere and on a
   * suggestion stored before.
   */
  byPriority?: Record<string, number>;
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

/**
 * The orders of `stopIds` per priority ("4" -> 1), counted as leftOutOf counts them: an order on stops of
 * two priorities counts once, at the higher (a stop without one is P3, as hireNeed reads it). Null when a
 * stop is not in the request (its priority is unknown).
 */
export function ordersByPriority(stopIds: Iterable<string>, stops: readonly DispatchStop[]): Record<string, number> | null {
  const byId = new Map(stops.map((s) => [s.stop_id, s]));
  const prio = new Map<string, number>();
  for (const id of new Set(stopIds)) {
    const s = byId.get(id);
    if (!s) return null;
    const p = s.priority ?? 3;
    for (const ref of s.order_ids) {
      const o = orderIdOf(ref);
      prio.set(o, Math.min(prio.get(o) ?? p, p));
    }
  }
  const out: Record<string, number> = {};
  for (const p of prio.values()) out[String(p)] = (out[String(p)] ?? 0) + 1;
  return out;
}

/** The stops a plan option left out that a truck to rent may help (CAPACITY_REASONS). */
export function capacityLeftOutIds(unserved: readonly UnservedLike[]): string[] {
  return unserved.filter((u) => CAPACITY_REASONS.includes(u.reason_code)).map((u) => u.stop_id);
}

/**
 * A left-out stop's priority from its orders as the plan was made (ScenarioDetails.scope.orderPriority;
 * a split part reads its order's): its most important order. 3 when none is on record (an older plan).
 */
export function unservedPriority(u: Pick<UnservedLike, 'order_ids'>, orderPriority?: Readonly<Record<string, number>> | null): number {
  const ps = u.order_ids.map((o) => orderPriority?.[orderIdOf(o)]).filter((p): p is number => typeof p === 'number');
  return ps.length ? Math.min(...ps) : 3;
}

/**
 * Whether a plan option leaves out a P1-P3 order a truck to rent may help: the what-if's trigger. Only
 * P1-P3 orders justify renting (owner answer 1, 6 Oct 2026); P4/P5 orders left out alone are said
 * plainly instead (lowPriorityOrders, lowPriorityText).
 */
export function needsHireCheck(unserved: readonly UnservedLike[] | null | undefined, orderPriority?: Readonly<Record<string, number>> | null): boolean {
  return !!unserved?.some((u) => CAPACITY_REASONS.includes(u.reason_code) && unservedPriority(u, orderPriority) <= HIRE_MAX_PRIORITY);
}

/** The P4/P5 orders a plan option leaves out for a reason a truck more may help (never a reason to rent). */
export function lowPriorityOrders(unserved: readonly UnservedLike[] | null | undefined, orderPriority?: Readonly<Record<string, number>> | null): number {
  const orders = new Set<string>();
  for (const u of unserved ?? []) {
    if (CAPACITY_REASONS.includes(u.reason_code) && unservedPriority(u, orderPriority) > HIRE_MAX_PRIORITY) for (const o of u.order_ids) orders.add(orderIdOf(o));
  }
  return orders.size;
}

/**
 * The owner's words for P4/P5 orders left out (answer 1, 6 Oct 2026): "Left out: 3 orders, all P4/P5 -
 * renting is not suggested for them." `also`: next to a suggestion for P1-P3 orders. `delivered`: of
 * them, the orders the check's plan still delivers (a rented truck's spare room).
 */
export function lowPriorityText(orders: number, opts: { also?: boolean; delivered?: number } = {}): string {
  if (orders <= 0) return '';
  const what = orders === 1 ? '1 order, P4/P5 - renting is not suggested for it' : `${n(orders)} orders, all P4/P5 - renting is not suggested for them`;
  const d = opts.delivered ?? 0;
  const carried = d > 0 ? `; this plan still delivers ${d >= orders ? (orders === 1 ? 'it' : 'all of them') : `${n(d)} of them`} with the hired trucks` : '';
  return `${opts.also ? 'Also left out' : 'Left out'}: ${what}${carried}.`;
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
  /** The other costs of the rented trucks' loads (their drivers' day rate, loading, the rental's km charge), as the plan costs them. */
  runningCost: number;
  /**
   * runningCost in parts (owner answers 3 and 4, 6 Oct 2026): the casual drivers at the company's day
   * rate, loading, the rental's own km charge (0 unless the option has one; fuel is in the hire).
   * Absent on a suggestion stored before them.
   */
  running?: { drivers: number; dayRate: number | null; driver: number; loading: number; km: number };
  /**
   * P4/P5 orders left out by the plan in use (or added since), never a reason to rent (owner answer 1),
   * and of them, those the check's plan still delivers (a rented truck's spare room). Absent before it.
   */
  low?: { leftOut: LeftOut; delivered: LeftOut };
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
  /**
   * One truck fewer, SOLVED (sixth review of the hire branch: the estimate of before said "up to 25 orders
   * stay undelivered" where none would): the optimizer planned the day with the suggested rented trucks
   * less the least useful one (DispatchResponse.hire_check.one_fewer). `leftOut`: the P1-P3 orders that
   * plan leaves out (those still left out with the hire included - `still` of them -, never one no truck
   * helps); `low`: the P4/P5 orders this plan delivers that it leaves out. Null when no such solve ran (no
   * line is shown).
   * `solved` marks it; a suggestion stored before (an estimate, `roomFor`) is never shown.
   */
  alternative: { hires: HireUse[]; hireCost: number; leftOut: LeftOut; dropped: string; solved?: true; still?: number; roomFor?: number; low?: LeftOut } | null;
  /**
   * The optimizer's reduction of the rented trucks after its search (hire_check): how many its search's
   * plan rented, how many the suggestion keeps, the extra solves, and whether every kept truck was tried
   * without. Absent from a solver before it. `note` (BUG 5, 7 Oct 2026): the optimizer's plain words when
   * its limits stopped it before every set of trucks that might cost less on its km charge was tried - the
   * set suggested is then not proven the cheapest (shown in the box); absent otherwise.
   */
  reduction?: { first: number; used: number; solves: number; complete: boolean; note?: string };
  /** The what-if's totals for the record. */
  trucksUsed: number;
  loads: number;
}

/** What the hire is for, counted on a request (hireNeed). */
export interface HireNeed {
  /** P1-P3 stops: those the plan in use left out for a capacity reason that are still to plan, and the stops of orders added since. */
  outIds: Set<string>;
  /** The same for P4/P5 stops: never a reason to rent (owner answer 1, 6 Oct 2026). */
  lowIds: Set<string>;
  /** Stops of orders the plan in use does not have at all (added after it was made), both priorities. */
  newIds: string[];
  /** Stops the plan in use left out for another reason (a conflict with a locked plan): no truck changes them. */
  otherIds: Set<string>;
  leftOut: LeftOut;
  low: LeftOut;
  /** Of leftOut, the orders added after the plan was made. */
  newOrders: number;
}

/**
 * What a truck to rent may be for, on the request the what-if uses (review of the hire branch: the day
 * may have changed since the plan): the stops the plan in use left out for a capacity reason that are
 * still to plan, plus - with `baseOrders`, the orders the plan in use delivers (its new and its frozen
 * loads) - every stop of an order it does not have at all (added after it was made). Split by priority:
 * P1-P3 (`outIds`, what the hire is for) and P4/P5 (`lowIds`). startHireCheck runs no check when
 * `leftOut` is empty (every order left out was brought forward, say).
 */
export function hireNeed(input: { request: Pick<DispatchRequest, 'stops'>; baseUnserved: readonly UnservedLike[]; baseOrders?: readonly string[] }): HireNeed {
  const stops = input.request.stops;
  const byId = new Map(stops.map((s) => [s.stop_id, s]));
  // In the request's stop ids: a customer split in the plan in use can be one stop here (alignUnserved).
  const baseUnserved = alignUnserved(input.baseUnserved, stops);
  const orderIdsOf = new Map(baseUnserved.map((u) => [u.stop_id, u.order_ids] as const));
  const baseOut = new Set(baseUnserved.map((u) => u.stop_id));
  const capIds = capacityLeftOutIds(baseUnserved).filter((id) => byId.has(id));
  const otherIds = new Set([...baseOut].filter((id) => !capIds.includes(id)));
  const baseOrders = input.baseOrders ? new Set(input.baseOrders.map(orderIdOf)) : null;
  const newIds = baseOrders ? stops.filter((s) => !baseOut.has(s.stop_id) && !s.order_ids.some((o) => baseOrders.has(orderIdOf(o)))).map((s) => s.stop_id) : [];
  const high = (id: string) => (byId.get(id)?.priority ?? 3) <= HIRE_MAX_PRIORITY;
  const all = [...new Set([...capIds, ...newIds])];
  const outIds = new Set(all.filter(high));
  const lowIds = new Set(all.filter((id) => !high(id)));
  return {
    outIds,
    lowIds,
    newIds,
    otherIds,
    leftOut: leftOutOf(outIds, stops, orderIdsOf),
    low: leftOutOf(lowIds, stops, orderIdsOf),
    newOrders: leftOutOf(newIds.filter((id) => outIds.has(id)), stops).orders,
  };
}

/**
 * The suggestion from a what-if answer (its recommended plan) and the plan in use. Counted on the
 * request the what-if used (hireNeed): "cannot be delivered with your fleet" = the P1-P3 orders the
 * plan in use left out for a capacity reason that are still to plan, and those added since; P4/P5
 * orders are counted apart (`low`: never a reason to rent, owner answer 1). A stop it left out for
 * another reason (a conflict with a locked plan) stays out of every count: no truck to rent changes
 * it. A stop the plan in use delivers that the what-if leaves out is `dropped`, never "still left
 * out". The what-if's plan is the optimizer's REDUCED set (sixth review: its search alone rented 2 x
 * 10-ton where one sufficed; `hireCheck`, apps/solver dispatch_solver._reduce_hire). The alternative
 * ("one truck fewer") is the optimizer's own solve of that set less its least useful truck
 * (`hireCheck.one_fewer`) - exact, or none at all (sixth review: an estimate said "up to 25 orders"
 * where none would stay out).
 */
export function summarizeHire(input: {
  request: DispatchRequest;
  baseUnserved: readonly UnservedLike[];
  /** The orders the plan in use delivers (HireBasis.baseOrders); absent: orders added since are not told apart. */
  baseOrders?: readonly string[];
  whatIf: Pick<DispatchScenario, 'loads' | 'unserved' | 'trucks_used' | 'trips'>;
  options: readonly HireOptionFacts[];
  /** The optimizer's reduction of the rented trucks (DispatchResponse.hire_check); absent from a solver before it. */
  hireCheck?: HireCheck | null;
}): HireSummary {
  const { request, whatIf, options } = input;
  const stops = request.stops;
  const baseUnserved = alignUnserved(input.baseUnserved, stops);
  const orderIdsOf = new Map([...baseUnserved.map((u) => [u.stop_id, u.order_ids] as const), ...whatIf.unserved.map((u) => [u.stop_id, u.order_ids] as const)]);
  const need = hireNeed(input);
  const { outIds, lowIds, otherIds } = need;
  const leftOut = leftOutOf(outIds, stops, orderIdsOf);
  const served = new Set(whatIf.loads.flatMap((l) => l.stops.map((s) => s.stop_id)));
  const delivered = leftOutOf([...outIds].filter((id) => served.has(id)), stops, orderIdsOf);
  const whatIfOut = whatIf.unserved.map((u) => u.stop_id);
  const stillLeft = leftOutOf(whatIfOut.filter((id) => outIds.has(id)), stops, orderIdsOf);
  const droppedIds = whatIfOut.filter((id) => !outIds.has(id) && !lowIds.has(id) && !otherIds.has(id));
  const droppedPrio = droppedIds.length ? ordersByPriority(droppedIds, stops) : null;
  const dropped: LeftOut = { ...leftOutOf(droppedIds, stops, orderIdsOf), ...(droppedPrio ? { byPriority: droppedPrio } : {}) };
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
  const rentedLoads = [...loadsByTruck.values()].flat();
  const runningCost = round2(rentedLoads.reduce((a, l) => a + (l.total_cost - l.fixed_cost), 0));
  const sum = (f: (l: (typeof rentedLoads)[number]) => number | null | undefined) => round2(rentedLoads.reduce((a, l) => a + (f(l) ?? 0), 0));
  const rates = request.trucks.filter((t) => loadsByTruck.has(t.id)).map((t) => t.driver_day_cost).filter((r): r is number => typeof r === 'number');
  const running = {
    drivers: loadsByTruck.size,
    dayRate: rates.length ? Math.max(...rates) : null,
    driver: sum((l) => (l.driver_cost ?? 0) + (l.overtime_cost ?? 0)),
    loading: sum((l) => l.trip_cost),
    km: sum((l) => (l.distance_cost ?? 0) + (l.fuel_cost ?? 0)),
  };

  // One truck fewer: only the optimizer's own solve of the suggested set less one of its trucks (sixth
  // review of the hire branch: the estimate said "up to 25 orders stay undelivered" where none would).
  let alternative: HireSummary['alternative'] = null;
  const rented = [...loadsByTruck.keys()];
  const fewer = input.hireCheck?.one_fewer ?? null;
  if (rented.length >= 2 && fewer && loadsByTruck.has(fewer.without)) {
    const byId = new Map(stops.map((s) => [s.stop_id, s]));
    const out = [...new Set(fewer.unserved)].filter((id) => byId.has(id));
    const prio = (id: string) => byId.get(id)?.priority ?? 3;
    const high = out.filter((id) => prio(id) <= HIRE_MAX_PRIORITY && !otherIds.has(id));
    const riders = out.filter((id) => prio(id) > HIRE_MAX_PRIORITY && served.has(id));
    const altHires = usesOf(rented.filter((id) => id !== fewer.without), optionOf);
    if (high.length) {
      const stillIds = new Set(stillLeft.stopIds);
      const still = leftOutOf(high.filter((id) => stillIds.has(id)), stops, orderIdsOf).orders;
      alternative = {
        hires: altHires,
        hireCost: round2(altHires.reduce((a, h) => a + h.count * h.costPerDay, 0)),
        leftOut: leftOutOf(high, stops, orderIdsOf),
        dropped: optionOf.get(parseVirtualHireId(fewer.without)!.optionId)?.label ?? 'truck',
        solved: true,
        ...(still ? { still } : {}),
        ...(riders.length ? { low: leftOutOf(riders, stops, orderIdsOf) } : {}),
      };
    }
  }
  const hc = input.hireCheck;
  return {
    v: 1,
    status: !delivered.stopIds.length ? 'NO_HELP' : hires.length ? 'HIRE' : 'OWN_FLEET',
    leftOut,
    newOrders: need.newOrders,
    hires,
    hireCost,
    runningCost,
    running,
    low: { leftOut: leftOutOf(lowIds, stops, orderIdsOf), delivered: leftOutOf([...lowIds].filter((id) => served.has(id)), stops, orderIdsOf) },
    delivered,
    stillLeft,
    dropped,
    stillLeftReasons,
    unitsOffered: request.trucks.filter((t) => t.hire_candidate).length,
    unitsUsed: rented.length,
    alternative,
    ...(hc
      ? { reduction: { first: hc.first.length, used: hc.used.length, solves: hc.solves, complete: hc.complete, ...(hc.note ? { note: hc.note } : {}) } }
      : {}),
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

/** Pallet units under which an amount is not said in pallets: it would read "0.0 pallets" (0.05 pallets, palletText rounds halves up). */
const PALLETS_SAID_FROM_UNITS = 50;

/**
 * Orders with their priorities when known (LeftOut.byPriority): all of one priority "1 P4 order"; several
 * "3 orders" with `mix` "2 P3, 1 P4" (P1 first); unknown "3 orders".
 */
function ordersWords(orders: number, byPriority?: Record<string, number> | null): { what: string; mix: string | null } {
  const prios = Object.entries(byPriority ?? {})
    .filter(([, k]) => k > 0)
    .sort(([a], [b]) => Number(a) - Number(b));
  if (prios.length === 1) return { what: plural(orders, `P${prios[0]![0]} order`), mix: null };
  return { what: plural(orders, 'order'), mix: prios.length > 1 ? prios.map(([p, k]) => `${n(k)} P${p}`).join(', ') : null };
}

/**
 * "14 orders (1,180 cases, 17.6 pallets)"; `added`: "...; 1 of them added after this plan was made)"; with
 * the priorities known (`byPriority`) "1 P4 order (3 cases)" or "2 orders (1 P3, 1 P4; 203 cases, 3.0
 * pallets)". Never "0.0 pallets" (ninth review of the hire branch: a 3-case order read so): under 0.05
 * pallets the cases only.
 */
export function leftOutText(l: LeftOut, added = 0): string {
  const parts = [plural(l.cases, 'case')];
  if (l.palletUnits !== null && l.palletUnits >= PALLETS_SAID_FROM_UNITS) parts.push(`${palletText(l.palletUnits)} pallets`);
  const late = added > 0 ? `; ${added === l.orders ? (l.orders === 1 ? 'added' : 'all added') : `${n(added)} of them added`} after this plan was made` : '';
  const w = ordersWords(l.orders, l.byPriority);
  return `${w.what} (${w.mix ? `${w.mix}; ` : ''}${parts.join(', ')}${late})`;
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
export function stillLeftWhy(s: Pick<HireSummary, 'stillLeftReasons' | 'unitsOffered' | 'unitsUsed' | 'reduction'>, orders: number): { backed: boolean; text: string } {
  const one = orders === 1;
  if (!s.stillLeftReasons || s.unitsOffered === undefined || s.unitsUsed === undefined) return { backed: true, text: STILL_LEFT_WHY };
  const has = (codes: readonly string[]) => codes.some((c) => (s.stillLeftReasons![c] ?? 0) > 0);
  const causes: string[] = [];
  if (has(TIME_REASONS)) causes.push('their receiving hours or the drivers’ shift');
  if (has(['EXCEEDS_ANY_TRUCK_CAPACITY'])) causes.push('bigger than any truck');
  // Every truck the day could rent in use - in the search's own plan, before the reduction gave back the
  // ones no P1-P3 order needed (sixth review of the hire branch).
  const searched = Math.max(s.unitsUsed, s.reduction?.first ?? 0);
  if (s.unitsOffered > 0 && searched >= s.unitsOffered) causes.push('how many trucks you can rent');
  if (causes.length) {
    const list = causes.length > 1 ? `${causes.slice(0, -1).join(', ')} or ${causes[causes.length - 1]}` : causes[0];
    return { backed: true, text: `even with every truck you can rent ${one ? 'it does' : 'they do'} not fit (${list})` };
  }
  return { backed: false, text: `the Quick search did not place ${one ? 'it' : 'them'} although trucks you can rent stayed unused - press Check hire options to search again` };
}

/**
 * Every order the plan in use left out is gone from the day to plan (brought forward to another day,
 * changed or cancelled) and none was added: there is nothing to hire for (review of the hire branch: the
 * box read "0 orders (0 cases) cannot be delivered" and asked to check again, forever).
 */
export const NOTHING_LEFT_TEXT =
  'Nothing is left out for lack of trucks any more: the orders this plan left out are no longer to plan (moved to another day, changed or cancelled). No truck needs to be hired.';

/**
 * The running-costs line of a suggestion (owner answers 3 and 4, 6 Oct 2026): the hired trucks' casual
 * drivers at the company's day rate, loading, and the rental's own km charge when its option has one -
 * never fuel or the fleet's km cost (fuel is in the hire). Null when there is nothing to say.
 */
function runningText(s: HireSummary, currency: string): string | null {
  if (s.runningCost < 0.5) return null;
  const r = s.running;
  // A suggestion stored before the owner's answers: its words of then.
  if (!r) return `Plus ${aboutMoney(s.runningCost, currency)} running costs on the hired trucks' loads (km, fuel, loading, driver time, as your plan costs them).`;
  const parts: string[] = [];
  if (r.driver >= 0.5) parts.push(r.dayRate !== null ? `${plural(r.drivers, 'driver')} at the day rate of ${n(r.dayRate)} ${currency}` : `the drivers ${aboutMoney(r.driver, currency)}`);
  if (r.loading >= 0.5) parts.push(`loading ${aboutMoney(r.loading, currency)}`);
  if (r.km >= 0.5) parts.push(`the rental's km charge ${aboutMoney(r.km, currency)}`);
  return `Plus ${aboutMoney(s.runningCost, currency)} running costs on the hired trucks${parts.length ? `: ${parts.join(', ')}` : ''}. Fuel is included in the hire.`;
}

/**
 * What the box says: the headline ("14 orders (...) cannot be delivered with your fleet. To deliver
 * them, hire 1 x 10-ton (12 bays) + 1 x 3-ton (6 bays): extra about 80 OMR. Still left out: none.")
 * and the detail lines (the running costs, one truck fewer, the P4/P5 orders left out). Counts P1-P3
 * orders only: P4/P5 orders are never what a truck is rented for (owner answer 1).
 */
export function hireSuggestionText(s: HireSummary, currency = 'OMR'): { headline: string; details: string[] } {
  const lowLeft = s.low?.leftOut.orders ?? 0;
  const lowLine = (hired: boolean) => (lowLeft ? [lowPriorityText(lowLeft, { also: true, delivered: hired ? s.low?.delivered.orders : 0 })] : []);
  // Nothing for a P1-P3 order to hire for (left out since, or only P4/P5 orders): said plainly.
  if (s.leftOut.orders === 0) return { headline: lowLeft ? lowPriorityText(lowLeft) : NOTHING_LEFT_TEXT, details: [] };
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
      details: lowLine(false),
    };
  }
  if (s.status === 'OWN_FLEET') {
    const all = s.delivered.orders === s.leftOut.orders;
    const them = all ? (one ? 'it' : 'them') : `${plural(s.delivered.orders, 'order')} of them`;
    const rest = s.stillLeft.orders ? ` Still left out: ${still()}.` : '';
    return {
      headline: `${what} ${one ? 'is' : 'are'} left out of this plan, but the hire check fits ${them} on your own trucks: no truck needs to be hired. Re-plan to put ${all && one ? 'it' : 'them'} on your trucks.${rest}`,
      details: lowLine(false),
    };
  }
  const headline = `${cannot} To deliver ${one ? 'it' : 'them'}, hire ${hiresText(s.hires)}: extra ${aboutMoney(s.hireCost, currency)}. Still left out: ${still()}.${dropped}`;
  const details: string[] = [];
  // Not proven the cheapest (BUG 5): a km charge left sets that might cost less untried - said first.
  if (s.reduction?.note) details.push(s.reduction.note);
  const running = runningText(s, currency);
  if (running) details.push(running);
  // One truck fewer: the optimizer's own solve only (`solved`); an estimate stored before is never shown
  // (sixth review of the hire branch: it said "up to 25 orders" where none would stay out).
  if (s.alternative?.solved && s.alternative.leftOut.orders > 0) {
    const a = s.alternative;
    const fewer = `With one truck fewer (${hiresText(a.hires)}, extra ${aboutMoney(a.hireCost, currency)})`;
    const stillOrders = a.still ?? 0;
    const riders = a.low?.orders ? ` ${plural(a.low.orders, 'P4/P5 order')} this plan delivers would stay out too.` : '';
    details.push(
      `${fewer}: ${leftOutText(a.leftOut)} would stay undelivered${stillOrders ? `, the ${plural(stillOrders, 'order')} still left out included` : ''} - planned without the ${a.dropped}.${riders}`,
    );
  }
  details.push(...lowLine(true));
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
