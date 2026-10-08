/**
 * Outside benchmark of 8 Oct 2026 (findings F02 and F07): a same-day re-plan could leave priority 1-3
 * orders unserved while trucks it was given stood idle. The optimizer now recovers such work itself;
 * when a plan (first plan or re-plan) still leaves priority 1-3 orders out and one or more of its
 * trucks carry no load, the plan screen says so, so the dispatcher can search again or add them by hand.
 */

/** An unserved order of the plan: its priority, and the later day it was brought forward to (then it is planned there). */
export interface LeftOutOrder {
  priority: number;
  carriedTo?: string | null;
}

/**
 * The warning, or null when the plan leaves out no priority 1-3 order or uses every truck.
 * `plannedTruckIds`: the trucks the optimization was given (the plan's saved inputs); `usedTruckIds`:
 * the trucks of the plan's loads (new, locked and dispatched alike).
 */
export function idleTrucksNote(unserved: LeftOutOrder[], plannedTruckIds: Iterable<string>, usedTruckIds: Iterable<string>): string | null {
  const n = unserved.filter((u) => u.priority >= 1 && u.priority <= 3 && !u.carriedTo).length;
  const used = new Set(usedTruckIds);
  const m = new Set([...plannedTruckIds].filter((id) => !used.has(id))).size;
  if (n === 0 || m === 0) return null;
  const orders = n === 1 ? '1 priority 1-3 order is' : `${n} priority 1-3 orders are`;
  const trucks = m === 1 ? '1 truck is' : `${m} trucks are`;
  return `${orders} left out although ${trucks} unused. Run the search again (Thorough) or add them by hand.`;
}
