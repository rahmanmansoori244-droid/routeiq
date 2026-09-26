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

/** A load of the plan version, for the remedy: `frozen` = LOCKED or LOADING (not yet out). */
export interface RemedyLoad {
  truckId: string;
  truckCode: string;
  loadNo: number;
  frozen: boolean;
}

/** The remedy's loads of a plan's rows (plan detail loads or the check's own loads). */
export function remedyLoads(loads: { truckId: string; truckCode: string; loadNo: number; status?: string; frozen?: boolean; onRoad?: boolean }[]): RemedyLoad[] {
  return loads.map((l) => ({
    truckId: l.truckId,
    truckCode: l.truckCode,
    loadNo: l.loadNo,
    frozen: l.status !== undefined ? l.status === 'LOCKED' || l.status === 'LOADING' : !!l.frozen && !l.onRoad,
  }));
}

/**
 * What the dispatcher can do about blocking violations. Re-plan re-times PLANNED loads only: a
 * LOCKED or LOADING load is carried over unchanged (its problem comes back on the new version),
 * so such a load must first be put back to Planned - "Back to locked" if it is loading, then
 * "Unlock" - and then the day re-planned. Unlock is refused while a later load of the same truck
 * is still locked or loading (checkTransition), so every later LOCKED / LOADING load of that
 * truck goes back first: `unlockFirst` lists them all, latest first per truck ("T01 L2",
 * "T01 L1"), in the order they can be unlocked. `replanNow`: a re-plan can fix at least one
 * blocking violation now (one is not on a locked or loading load); false when every one is.
 */
export function timingRemedy(
  violations: Pick<PlanViolation, 'severity' | 'frozen' | 'truckId' | 'truckCode' | 'loadNo'>[],
  loads: RemedyLoad[],
): { text: string; unlockFirst: string[]; replanNow: boolean } {
  const blocking = violations.filter((x) => x.severity === 'BLOCK');
  const back = new Map<string, { truckCode: string; loadNo: number }>();
  for (const v of blocking) {
    if (!v.frozen || v.loadNo === null) continue;
    const truckCode = v.truckCode ?? '?';
    const sameTruck = (l: RemedyLoad) => (v.truckId ? l.truckId === v.truckId : l.truckCode === v.truckCode);
    const later = loads.filter((l) => sameTruck(l) && l.frozen && l.loadNo > v.loadNo!).map((l) => l.loadNo);
    for (const loadNo of [v.loadNo, ...later]) back.set(`${v.truckId ?? truckCode}:${loadNo}`, { truckCode, loadNo });
  }
  const unlockFirst = [...back.values()]
    .sort((a, b) => a.truckCode.localeCompare(b.truckCode) || b.loadNo - a.loadNo)
    .map((x) => `${x.truckCode} L${x.loadNo}`);
  const replanNow = !blocking.length || blocking.some((v) => !v.frozen);
  if (!unlockFirst.length) return { text: REPLAN_REMEDY, unlockFirst, replanNow };
  const how = '"Back to locked" if it is loading, then "Unlock"';
  const which =
    unlockFirst.length === 1
      ? `load ${unlockFirst[0]} back to Planned first (${how})`
      : `loads ${unlockFirst.join(', ')} back to Planned first, in this order (a truck's later loads go first; ${how})`;
  return { text: `A re-plan keeps locked and loading loads exactly as they are, so put ${which}, then re-plan.`, unlockFirst, replanNow };
}

/** "put T01 L2, T01 L1 back to Planned first, in this order" - the loads of `unlockFirst`. */
export function unlockFirstText(unlockFirst: string[]): string {
  return `put ${unlockFirst.join(', ')} back to Planned first${unlockFirst.length > 1 ? ', in this order' : ''}`;
}

/**
 * Why the red box's Re-plan button is off, or null while it is on: nothing is left to plan (every
 * order is on a locked, loading or dispatched load), or a re-plan would change none of the
 * blocking problems (every one is on a locked or loading load, which a re-plan keeps as it is).
 */
export function timingReplanOff(remedy: { unlockFirst: string[]; replanNow: boolean }, nothingToPlan: boolean): string | null {
  const then = remedy.unlockFirst.length ? `: ${unlockFirstText(remedy.unlockFirst)}.` : '.';
  if (nothingToPlan) return `Re-plan is off while every order is on a locked, loading or dispatched load${then}`;
  if (!remedy.replanNow) return `Re-plan is off: it would keep these locked or loading loads exactly as they are${then}`;
  return null;
}

/** Short dispatcher wording of a truck-day's timing status. */
export const TIMING_TEXT: Record<TruckTiming, string> = {
  VERIFIED: 'Times checked',
  VIOLATED: 'Times break a rule',
  UNVERIFIED: 'Times not verified',
  STRUCTURAL_ONLY: 'Checked without optimizer report',
};
