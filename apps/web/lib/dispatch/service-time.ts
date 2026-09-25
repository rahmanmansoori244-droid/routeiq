/**
 * Unloading (service) time of a stop sent to the optimizer. Pure function - plan-service and the
 * tests use it.
 *
 * A stop takes the customer's service time (customer / customer type / tenant default) plus an
 * optional time per case (tenant setting "Unloading minutes per case"): a 1,100-case hypermarket
 * drop at 0.05 min per case takes 55 min more than a 20-case grocery. A part of a split delivery
 * gets its share of the customer's base time (at least 5 min) plus the per-case time of its own
 * cases. The optimizer accepts at most 480 min per stop.
 */

export const MAX_SERVICE_MIN = 480;
const MIN_PART_SERVICE_MIN = 5;

export function stopServiceMin(
  baseMin: number,
  perCaseMin: number,
  cases: number,
  /** Split delivery: the customer's total cases (the part is `cases` of them). */
  totalCases?: number,
): number {
  const base = Math.max(0, Math.min(MAX_SERVICE_MIN, baseMin));
  const share =
    totalCases === undefined || totalCases <= 0
      ? base
      : Math.max(MIN_PART_SERVICE_MIN, Math.round((base * cases) / totalCases));
  const perCase = Math.max(0, perCaseMin) * Math.max(0, cases);
  return Math.max(0, Math.min(MAX_SERVICE_MIN, Math.round(share + perCase)));
}
