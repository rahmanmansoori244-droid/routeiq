/**
 * Browser-safe helpers for the timetable check (feasibility.ts holds the check itself and uses
 * node:crypto, so client components import only these and the types).
 */
import type { PlanFeasibility, PlanViolation, TruckTiming } from './feasibility';

/** The truck-day of `truckId` may be locked, loaded and dispatched. */
export function truckDayOk(f: PlanFeasibility, truckId: string): boolean {
  const t = f.trucks[truckId];
  return t ? t.ok : f.ok;
}

/** The violations to show for one truck (its own, plus plan-wide ones). */
export function truckViolations(f: PlanFeasibility, truckId: string): PlanViolation[] {
  return f.violations.filter((x) => x.truckId === truckId || x.truckId === null);
}

/** Short dispatcher wording of a truck-day's timing status. */
export const TIMING_TEXT: Record<TruckTiming, string> = {
  VERIFIED: 'Times checked',
  VIOLATED: 'Times break a rule',
  UNVERIFIED: 'Times not verified',
  STRUCTURAL_ONLY: 'Checked without optimizer report',
};
