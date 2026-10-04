/**
 * "Camera not working" (owner decision 2, 5 Oct 2026): the driver may save Delivered or Partly
 * delivered without a photo when the camera fails, "but it needs to be monitored and documented
 * well". Pure and browser-safe: the day screen's Deliveries card, the plan screen, the dashboard and
 * the "Delivery actuals" Excel all read these words and rules, so the same fact never reads two ways.
 *
 * - A camera exception is a result Delivered or Partly delivered saved with noPhotoReason
 *   CAMERA_FAILED (the driver page's only exception to "photo required"; Not delivered needs no photo).
 * - Every one is listed: stop, customer, driver, time. The audit (DELIVERY_OUTCOME_SET, the stop
 *   events) keeps them too.
 * - One driver link is one truck-day: a link that used it CAMERA_ALERT_PER_DAY (3) times or more in a
 *   day is highlighted ("check the phone's camera with the driver").
 */
import { countOf } from './office-text';
import { fmtDayMonth, fmtHhmm, localMinutes } from '../dispatch/time';

/** A driver link (truck-day) with this many results saved without a photo in one day is highlighted. */
export const CAMERA_ALERT_PER_DAY = 3;

/** Delivered or Partly delivered saved without a photo because the camera did not work. */
export function isCameraException(v: { outcome: string | null | undefined; noPhotoReason: string | null | undefined }): boolean {
  return (v.outcome === 'DELIVERED' || v.outcome === 'PARTLY_DELIVERED') && v.noPhotoReason === 'CAMERA_FAILED';
}

/** The truck-day key of a driver link: `YYYY-MM-DD|truckId`. */
export const truckDayKey = (date: string, truckId: string) => `${date}|${truckId}`;

/** One result saved without a photo, as the lists show it. */
export interface CameraException {
  /** YYYY-MM-DD */
  date: string;
  depotId: string;
  truckId: string;
  truckCode: string;
  loadId: string;
  loadNo: number;
  sequence: number;
  customerCode: string;
  branchCode: string | null;
  customerName: string;
  /** The load's driver (null: none set). */
  driverName: string | null;
  outcome: 'DELIVERED' | 'PARTLY_DELIVERED';
  /** When the result was saved (ISO), and as HH:MM in the company's time. */
  outcomeAt: string | null;
  time: string | null;
}

/** A driver link (truck-day) that used "Camera not working" CAMERA_ALERT_PER_DAY times or more. */
export interface CameraLinkAlert {
  date: string;
  truckId: string;
  truckCode: string;
  drivers: string[];
  /** Results of that truck-day saved without a photo (every depot). */
  count: number;
}

/** A row of the list from a load, its planned stop and the stored result. */
export function cameraExceptionOf(
  load: { date: string; depotId: string; truckId: string; truckCode: string; id: string; loadNo: number; driverName: string | null },
  stop: { sequence: number; customerCode: string; branchCode: string | null; customerName: string },
  v: { outcome: string | null; outcomeAt: Date | string | null },
  tz: string,
): CameraException {
  const at = v.outcomeAt ? new Date(v.outcomeAt) : null;
  return {
    date: load.date,
    depotId: load.depotId,
    truckId: load.truckId,
    truckCode: load.truckCode,
    loadId: load.id,
    loadNo: load.loadNo,
    sequence: stop.sequence,
    customerCode: stop.customerCode,
    branchCode: stop.branchCode,
    customerName: stop.customerName,
    driverName: load.driverName,
    outcome: v.outcome === 'PARTLY_DELIVERED' ? 'PARTLY_DELIVERED' : 'DELIVERED',
    outcomeAt: at ? at.toISOString() : null,
    time: at ? fmtHhmm(localMinutes(at, tz)) : null,
  };
}

/** By date, truck, trip and stop. */
export function sortCameraExceptions(rows: readonly CameraException[]): CameraException[] {
  return [...rows].sort((a, b) => a.date.localeCompare(b.date) || a.truckCode.localeCompare(b.truckCode) || a.loadNo - b.loadNo || a.sequence - b.sequence);
}

/**
 * The driver links (truck-days) of these rows that used it CAMERA_ALERT_PER_DAY times or more.
 * `counts` (truckDayKey -> results without a photo, every depot) wins over the rows' own count: a
 * truck that loaded at two depots has one link for the day.
 */
export function cameraLinkAlerts(rows: readonly CameraException[], counts: ReadonlyMap<string, number> = new Map()): CameraLinkAlert[] {
  const groups = new Map<string, CameraException[]>();
  for (const r of rows) {
    const k = truckDayKey(r.date, r.truckId);
    groups.set(k, [...(groups.get(k) ?? []), r]);
  }
  const out: CameraLinkAlert[] = [];
  for (const [k, list] of groups) {
    const count = Math.max(counts.get(k) ?? 0, list.length);
    if (count < CAMERA_ALERT_PER_DAY) continue;
    const drivers = [...new Set(list.map((r) => r.driverName).filter((n): n is string => !!n))];
    out.push({ date: list[0]!.date, truckId: list[0]!.truckId, truckCode: list[0]!.truckCode, drivers, count });
  }
  return out.sort((a, b) => b.count - a.count || a.date.localeCompare(b.date) || a.truckCode.localeCompare(b.truckCode));
}

/** "3 results saved without a photo (Camera not working)", or null when there is none. */
export function cameraHeadline(n: number): string | null {
  return n > 0 ? `${countOf(n, 'result')} saved without a photo (Camera not working)` : null;
}

/** "T05 trip 1 stop 3 · ACME Store (ACME) · Salim · 10:42 · Delivered" */
export function cameraExceptionText(e: CameraException, opts: { withDate?: boolean } = {}): string {
  const customer = `${e.customerName} (${e.customerCode}${e.branchCode ? `/${e.branchCode}` : ''})`;
  return [
    `${opts.withDate ? `${fmtDayMonth(e.date)} ` : ''}${e.truckCode} trip ${e.loadNo} stop ${e.sequence}`,
    customer,
    e.driverName ?? 'no driver set',
    e.time ?? 'time not known',
    e.outcome === 'PARTLY_DELIVERED' ? 'Partly delivered' : 'Delivered',
  ].join(' · ');
}

/** "T05 (Salim): Camera not working used 3 times on 5 Oct - check the phone's camera with the driver." */
export function cameraAlertText(a: CameraLinkAlert): string {
  const who = a.drivers.length ? ` (${a.drivers.join(', ')})` : '';
  return `${a.truckCode}${who}: Camera not working used ${countOf(a.count, 'time')} on ${fmtDayMonth(a.date)} - check the phone's camera with the driver.`;
}

/** The dashboard and Summary line: "4 of 120 delivered results (3.3 %)". */
export function cameraShareText(k: { cameraFailed: number; delivered: number; partly: number; cameraFailedPct: number | null }): string {
  const of = k.delivered + k.partly;
  return `${k.cameraFailed} of ${countOf(of, 'delivered result')}${k.cameraFailedPct === null ? '' : ` (${k.cameraFailedPct} %)`}`;
}
