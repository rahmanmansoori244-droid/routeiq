/**
 * Unloading (service) time of a stop sent to the optimizer. Pure function - plan-service and the
 * tests use it.
 *
 * A stop takes the customer's service time (customer / customer type / tenant default) plus an
 * optional time per case (tenant setting "Unloading minutes per case"): a 1,100-case hypermarket
 * drop at 0.05 min per case takes 55 min more than a 20-case grocery. Every visit of a split
 * delivery gets the customer's FULL service time plus the per-case time of its own cases (owner
 * rule 29 Sep 2026: each truck is received, checked and signed for on its own; an explicit 0 min
 * stays 0). The optimizer accepts at most 480 min (8 h) per stop: a stop that needs more is
 * planned with 480 min and the plan carries a warning (stopService reports it as `capped`). Input
 * forms and the customer import accept at most 480 min for the same reason.
 */

export const MAX_SERVICE_MIN = 480;

export interface StopService {
  /** Minutes sent to the optimizer (0 to MAX_SERVICE_MIN). */
  min: number;
  /** The stop needs more than MAX_SERVICE_MIN: `min` is the cap, `neededMin` the real need. */
  capped: boolean;
  neededMin: number;
}

/** A whole delivery or ONE part of a split delivery: the full base time + `cases` x per case. */
export function stopService(baseMin: number, perCaseMin: number, cases: number): StopService {
  const base = Math.max(0, baseMin);
  const perCase = Math.max(0, perCaseMin) * Math.max(0, cases);
  const neededMin = Math.max(0, Math.round(base + perCase));
  return { min: Math.min(MAX_SERVICE_MIN, neededMin), capped: neededMin > MAX_SERVICE_MIN, neededMin };
}

export function stopServiceMin(baseMin: number, perCaseMin: number, cases: number): number {
  return stopService(baseMin, perCaseMin, cases).min;
}
