/**
 * "Reissue link?" after a driver change (owner request 4 Oct 2026, spec section 4.3; D11 refined by
 * C17). Pure and browser-safe: the plan screen decides with the links it loaded with the plan.
 *
 * The plan screen asks only when ALL of these hold:
 * 1. the link was made for a named driver (driverIdAtIssue) other than the new one;
 * 2. the changed load is the truck-day's earliest load that is not COMPLETED;
 * 3. no DISPATCHED load of the truck-day has a driver other than the new one (someone on the road
 *    holds the link).
 * A link made before any driver was chosen (the usual case for a hired truck or a daily driver)
 * takes the new driver silently (RECORD). In every other case nothing is asked.
 */

export type ReissueDecision = 'PROMPT' | 'RECORD' | 'NONE';

export interface PromptLink {
  driverIdAtIssue: string | null;
  revoked?: boolean;
  expired?: boolean;
}

export interface PromptLoad {
  id: string;
  loadNo: number;
  status: string;
  driverId: string | null;
  departMin: number;
}

/** The truck-day's earliest load that is not COMPLETED (by departure, then load number). */
export function earliestOpenLoad<L extends PromptLoad>(loads: readonly L[]): L | null {
  return [...loads].filter((l) => l.status !== 'COMPLETED').sort((a, b) => a.departMin - b.departMin || a.loadNo - b.loadNo)[0] ?? null;
}

export function reissuePrompt(link: PromptLink | null, loads: readonly PromptLoad[], changedLoadId: string, newDriverId: string | null): ReissueDecision {
  if (!link || link.revoked || link.expired || !newDriverId) return 'NONE';
  if (link.driverIdAtIssue === null) return 'RECORD';
  if (link.driverIdAtIssue === newDriverId) return 'NONE';
  if (earliestOpenLoad(loads)?.id !== changedLoadId) return 'NONE';
  if (loads.some((l) => l.status === 'DISPATCHED' && l.driverId !== null && l.driverId !== newDriverId)) return 'NONE';
  return 'PROMPT';
}

/** The question of the prompt ([Keep link] is the default answer). */
export function reissuePromptText(truckCode: string, dayLabel: string, oldName: string, newName: string): string {
  return `The driver link for ${truckCode} on ${dayLabel} was made for ${oldName}. Reissue it for ${newName}? Printed sheets and WhatsApp messages already sent for ${truckCode} stop working: print or send again.`;
}

/** Asked before a manual Reissue while a load of the truck-day is on the road with a driver. */
export function reissueOnRoadText(truckCode: string, loadNo: number, driverName: string): string {
  return `${truckCode} L${loadNo} is on the road with ${driverName}. His page stops working until he gets the new link: send it to him straight after.`;
}
