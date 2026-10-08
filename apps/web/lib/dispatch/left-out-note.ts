/**
 * Outside benchmark of 8 Oct 2026 (findings F02 and F07): a same-day re-plan could leave priority 1-3
 * orders unserved while trucks it was given stood idle. The optimizer now recovers such work itself;
 * when a plan (first plan or re-plan) still leaves priority 1-3 orders out and one or more of its
 * trucks carry no load, the plan screen says so, so the dispatcher can search again or add them by hand.
 *
 * Also the orders a plan left out for their customer's data (no usable location, a deactivated
 * customer) whose data was fixed since: the plan in use still leaves them out until a re-plan
 * (review of 9 Oct 2026: the day said "up to date" and RE-PLAN was off after the pin was added).
 * And which unserved orders a re-plan could place now (replanCouldPlace), for the day screen's Step 3.
 */
import { locationBlocksDelivery } from './customer-attrs';
import type { ServiceArea } from './location-input';

/**
 * An unserved order of the plan: its priority, the later day it was brought forward to (then it is
 * planned there), and why it was left out (UnservedOrder.reasonCode; absent = not known, counted).
 */
export interface LeftOutOrder {
  priority: number;
  carriedTo?: string | null;
  reasonCode?: string | null;
}

/**
 * The unserved reasons a longer search or one of the unused trucks could change: the search's own
 * drops (no room, no time slot found within its time limit, a late order without room), and no plan
 * found at all within the time limit. Not counted (review of 9 Oct 2026: the line told the dispatcher
 * to run a Thorough search of up to 20 minutes that could never place them):
 *  - orders never sent to the optimizer: no usable location (MISSING_COORDINATES, INVALID_LOCATION),
 *    a deactivated customer (INVALID_CUSTOMER), cases heavier than any truck (EXCEEDS_ANY_TRUCK_CAPACITY),
 *    an unknown customer or product;
 *  - what the optimizer proves against every usable truck, the unused ones included (free from the
 *    start of their day): no truck reaches the customer inside its receiving hours
 *    (HARD_WINDOW_INFEASIBLE), no round trip fits the shift, or no load can leave any more today
 *    (SHIFT_LIMIT);
 *  - a conflict with a locked plan, and a road routing failure.
 * The same idea as the hire check's CAPACITY_REASONS (hire.ts): a reason no truck changes never asks for one.
 */
export const IDLE_TRUCK_REASONS: readonly string[] = [
  'SOLVER_DROPPED_LOW_PRIORITY',
  'LATE_ORDER_NO_CAPACITY',
  'NO_AVAILABLE_TRUCK',
  'TRIP_LIMIT',
  'INFEASIBLE',
  'UNKNOWN',
];

/**
 * The warning, or null when the plan leaves out no priority 1-3 order a search could still place,
 * or uses every truck. `plannedTruckIds`: the trucks the optimization was given (the plan's saved
 * inputs); `usedTruckIds`: the trucks of the plan's loads (new, locked and dispatched alike).
 */
export function idleTrucksNote(unserved: LeftOutOrder[], plannedTruckIds: Iterable<string>, usedTruckIds: Iterable<string>): string | null {
  const n = unserved.filter((u) => u.priority >= 1 && u.priority <= 3 && !u.carriedTo && (!u.reasonCode || IDLE_TRUCK_REASONS.includes(u.reasonCode))).length;
  const used = new Set(usedTruckIds);
  const m = new Set([...plannedTruckIds].filter((id) => !used.has(id))).size;
  if (n === 0 || m === 0) return null;
  const orders = n === 1 ? '1 priority 1-3 order is' : `${n} priority 1-3 orders are`;
  const trucks = m === 1 ? '1 truck is' : `${m} trucks are`;
  return `${orders} left out although ${trucks} unused. Run the search again (Thorough) or add them by hand.`;
}

/**
 * The unserved reasons that end once the customer's data is fixed: a usable location saved (ADD
 * LOCATION, Set location), or the customer reactivated. buildDispatchRequest leaves such orders out
 * before the optimizer (plan-service), so only a re-plan plans them.
 */
export const CUSTOMER_DATA_REASONS: readonly string[] = ['MISSING_COORDINATES', 'INVALID_LOCATION', 'INVALID_CUSTOMER'];

/**
 * An order the plan left unserved for its customer's data that a re-plan would plan now: the customer
 * is active and its location usable (`locationBlocksDelivery`, the planner's own test, with the
 * company's delivery area). A reactivated customer still without a usable location is not.
 */
export function unservedNowPlannable(
  reasonCode: string,
  customer: { active: boolean; lat: number | null; lng: number | null; locationVerified: boolean; geocodeConfidence?: string | null },
  area: ServiceArea,
): boolean {
  return CUSTOMER_DATA_REASONS.includes(reasonCode) && customer.active && !locationBlocksDelivery(customer, area);
}

/**
 * Whether a re-plan could place an order the plan left unserved, as things are now: the day screen's
 * Step 3 keeps RE-PLAN on, and stays not done, only for these (review of 5614ba9: any unserved order
 * kept it on, so a day with a customer still without a pin never showed done). Not an order left out
 * for its customer's data until that is fixed (`nowPlannable`, unservedNowPlannable above), nor cases
 * heavier than any truck while they still are (`stillTooHeavy`: the case weight or the payloads now).
 * Any other reason is one a re-plan tries again: no room or no time slot found (a truck added since,
 * another search), receiving hours or the shift (a truck free from the start of the day may reach it).
 */
export function replanCouldPlace(reasonCode: string, nowPlannable: boolean, stillTooHeavy: boolean): boolean {
  if (CUSTOMER_DATA_REASONS.includes(reasonCode)) return nowPlannable;
  if (reasonCode === 'EXCEEDS_ANY_TRUCK_CAPACITY') return !stillTooHeavy;
  return true;
}
