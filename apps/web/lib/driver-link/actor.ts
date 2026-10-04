/**
 * Who a driver-link action is (spec section 16.4). Possession of the link is the only credential, so
 * the audit says whose truck-day it is, which generation of the link and whom it was made for. Pure.
 *
 *   "Driver link: Salim (T05, 5 Oct) · link #2"
 *   "Driver link: Khalid (T05, 5 Oct) · link #1 made for Salim"
 *   "Driver link: Salim (T05, 5 Oct) · link #1 made before a driver was set"
 *
 * No phone id and no IP: audit rows are kept for good, while the phone's browser id and IP of a
 * driver event or photo (StopEvent, DeliveryPhoto) are erased after locationRetentionDays.
 */
import { fmtDayMonth } from '../dispatch/time';

export interface ActorLink {
  generation: number;
  driverIdAtIssue: string | null;
  /** The name of driverIdAtIssue, when known. */
  driverNameAtIssue?: string | null;
}

export interface ActorLoad {
  truckCode: string;
  /** YYYY-MM-DD */
  date: string;
  driverId: string | null;
  driverName: string | null;
}

/**
 * The Audit log's "who" for a row without a user (spec section 16.4): the driver link's actor
 * ("Driver link: Salim (T05, 5 Oct) · link #2"), RouteIQ's own sweeps, else null.
 */
export function auditActorOf(afterJson: unknown): string | null {
  const a = afterJson && typeof afterJson === 'object' && !Array.isArray(afterJson) ? (afterJson as { actor?: unknown }).actor : null;
  return typeof a === 'string' && a.trim() ? a.trim().slice(0, 200) : null;
}

export function driverActor(link: ActorLink, load: ActorLoad): string {
  const who = `Driver link: ${load.driverName ?? 'no driver set'} (${load.truckCode}, ${fmtDayMonth(load.date)})`;
  const made =
    link.driverIdAtIssue === null
      ? ` · link #${link.generation} made before a driver was set`
      : link.driverIdAtIssue !== load.driverId
        ? ` · link #${link.generation} made for ${link.driverNameAtIssue ?? 'another driver'}`
        : ` · link #${link.generation}`;
  return `${who}${made}`;
}
