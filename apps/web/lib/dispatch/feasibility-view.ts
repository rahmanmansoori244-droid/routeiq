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

/** The plain remedy when nothing blocking is on a locked or loading load. */
export const REPLAN_REMEDY = 'Re-plan to get a timetable that keeps every rule.';

/**
 * What the dispatcher can do about blocking violations. Re-plan re-times PLANNED loads only: a
 * LOCKED or LOADING load is carried over unchanged (its problem comes back on the new version),
 * so such a load must first be put back to Planned - "Back to locked" if it is loading, then
 * "Unlock" - and then the day re-planned. `unlockFirst` names those loads ("T01 L1").
 */
export function timingRemedy(violations: Pick<PlanViolation, 'severity' | 'frozen' | 'truckCode' | 'loadNo'>[]): { text: string; unlockFirst: string[] } {
  const unlockFirst = [
    ...new Set(violations.filter((x) => x.severity === 'BLOCK' && x.frozen && x.loadNo !== null).map((x) => `${x.truckCode ?? '?'} L${x.loadNo}`)),
  ];
  if (!unlockFirst.length) return { text: REPLAN_REMEDY, unlockFirst };
  const which = unlockFirst.length === 1 ? `load ${unlockFirst[0]}` : `loads ${unlockFirst.join(', ')}`;
  return {
    text: `A re-plan keeps locked and loading loads exactly as they are, so put ${which} back to Planned first ("Back to locked" if it is loading, then "Unlock"), then re-plan.`,
    unlockFirst,
  };
}

/** Short dispatcher wording of a truck-day's timing status. */
export const TIMING_TEXT: Record<TruckTiming, string> = {
  VERIFIED: 'Times checked',
  VIOLATED: 'Times break a rule',
  UNVERIFIED: 'Times not verified',
  STRUCTURAL_ONLY: 'Checked without optimizer report',
};
