/**
 * Plan version status rules shared by the server and the browser (no database access here).
 *
 * A version is superseded when its status is SUPERSEDED **or** supersededAt is set. Before the
 * stabilization release a race could write READY over a SUPERSEDED version and leave supersededAt
 * set (review F07); such a row must still be treated as replaced everywhere: no editing controls,
 * "do not use" on the driver sheets and in WhatsApp messages, and refused by every server-side
 * mutator.
 */
export interface SupersedeFields {
  status: string;
  supersededAt?: Date | string | null;
}

export function isSupersededRun(run: SupersedeFields): boolean {
  return run.status === 'SUPERSEDED' || (run.supersededAt !== undefined && run.supersededAt !== null);
}

/** The status a version with an applied plan takes after its loads change or a plan is applied. */
export function appliedPlanStatus(loadStatuses: string[]): 'DISPATCHED' | 'READY' {
  const allOut = loadStatuses.length > 0 && loadStatuses.every((s) => s === 'DISPATCHED' || s === 'COMPLETED');
  return allOut ? 'DISPATCHED' : 'READY';
}

/**
 * True when a re-plan of this version would have nothing to plan: every load is locked, loading
 * or dispatched, no order is unserved (an unserved order is tried again) and no new order waits.
 * The server checks the same thing on the real order data (409 NOTHING_TO_PLAN).
 */
export function nothingToReplan(p: { loadStatuses: string[]; unservedOrders: number; pendingOrders: number }): boolean {
  return !p.loadStatuses.some((s) => s === 'PLANNED') && p.unservedOrders === 0 && p.pendingOrders === 0;
}
