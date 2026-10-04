/**
 * Results saved without a photo (owner decision 2, 5 Oct 2026): the driver may save Delivered or
 * Partly delivered without a photo when the camera fails ("Camera not working"), "but it needs to be
 * monitored and documented well". Pure and browser-safe: the day screen's Deliveries card, the plan
 * screen, the dashboard and the "Delivery actuals" Excel all read these words and rules, so the same
 * fact never reads two ways.
 *
 * - The monitor reads the driver's OWN last Delivered or Partly result at the stop (StopVisit
 *   driverResultAt / driverResultOutcome / driverNoPhotoReason / driverPhotoKeys, rebuilt from the
 *   driver's events: visit.ts driverFacts). An office Record replaces the current result but never
 *   these, so a corrected stop stays on every list, the KPI, the Excel and its link's count, marked
 *   "corrected by office"; the audit (DELIVERY_OUTCOME_SET before / after) keeps both sides.
 * - Two kinds, counted together as "saved without a photo":
 *   - CAMERA_FAILED: that result was saved with "Camera not working" (Not delivered needs no photo);
 *   - PHOTO_NOT_RECEIVED: it named a photo, none of the stop's photos arrived, and none can be
 *     expected any more (photoWaitOver: the link was reissued or revoked after the result, its upload
 *     time is over, or the trip has been COMPLETED for PHOTO_WAIT_AFTER_COMPLETED_MIN). Otherwise a
 *     driver could skip "Camera not working" by letting an upload fail. A photo that still arrives
 *     takes the stop off the lists (it then has its proof).
 * - Every one is listed: stop, customer, driver, the time the driver saved it, and what changed after.
 * - One driver link is one truck-day: a link with CAMERA_ALERT_PER_DAY (3) or more in a day is
 *   highlighted ("check the phone's camera with the driver").
 */
import { countOf, OUTCOME_LABEL } from './office-text';
import { fmtDayMonth, fmtHhmm, localMinutes } from '../dispatch/time';

/** A driver link (truck-day) with this many results saved without a photo in one day is highlighted. */
export const CAMERA_ALERT_PER_DAY = 3;
/** A photo still missing this long after its trip was completed is "not received". */
export const PHOTO_WAIT_AFTER_COMPLETED_MIN = 60;

export type NoPhotoKind = 'CAMERA_FAILED' | 'PHOTO_NOT_RECEIVED';

/** What a visit keeps of the driver's own last Delivered / Partly result (StopVisit), and its photos. */
export interface DriverNoPhotoFacts {
  driverResultOutcome?: string | null;
  driverNoPhotoReason?: string | null;
  /** Photo keys named by the driver's Delivered and Partly results. */
  driverPhotoKeys?: number | null;
  /** Photos of the stop that arrived (StopVisit.photoCount). */
  photoCount?: number | null;
}

const deliveredLike = (o: string | null | undefined) => o === 'DELIVERED' || o === 'PARTLY_DELIVERED';

/** The driver's Delivered or Partly delivered saved without a photo because the camera did not work. */
export function isCameraException(v: DriverNoPhotoFacts): boolean {
  return deliveredLike(v.driverResultOutcome) && v.driverNoPhotoReason === 'CAMERA_FAILED';
}

/** The driver's Delivered or Partly named a photo and no photo of the stop has arrived (yet). */
export function awaitsPhoto(v: DriverNoPhotoFacts): boolean {
  return deliveredLike(v.driverResultOutcome) && v.driverNoPhotoReason !== 'CAMERA_FAILED' && (v.driverPhotoKeys ?? 0) >= 1 && (v.photoCount ?? 0) === 0;
}

/** Why a stop counts as saved without a photo, or null. `waitOver`: photoWaitOver of the stop. */
export function noPhotoKind(v: DriverNoPhotoFacts, waitOver: boolean): NoPhotoKind | null {
  if (isCameraException(v)) return 'CAMERA_FAILED';
  if (waitOver && awaitsPhoto(v)) return 'PHOTO_NOT_RECEIVED';
  return null;
}

/**
 * Can the photo a driver's result named no longer arrive? True when the truck-day has no link, the
 * link was revoked, or reissued after the result (the old phone's uploads are refused; only that same
 * phone opening the new link would still send them), its upload time (expiry + 72 h) is over, or the
 * load has been COMPLETED for PHOTO_WAIT_AFTER_COMPLETED_MIN minutes.
 */
export function photoWaitOver(args: {
  resultAt: Date | string | null;
  link: { issuedAt: Date | string; revokedAt: Date | string | null; uploadUntil: Date | string } | null;
  load: { status: string; statusChangedAt: Date | string | null } | null;
  now: Date;
}): boolean {
  const ms = (d: Date | string) => new Date(d).getTime();
  const { link, load, now } = args;
  if (!link || link.revokedAt) return true;
  if (args.resultAt && ms(link.issuedAt) > ms(args.resultAt)) return true;
  if (now.getTime() >= ms(link.uploadUntil)) return true;
  return !!load && load.status === 'COMPLETED' && !!load.statusChangedAt && now.getTime() - ms(load.statusChangedAt) >= PHOTO_WAIT_AFTER_COMPLETED_MIN * 60_000;
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
  kind: NoPhotoKind;
  /** The driver's result, when he saved it (ISO), and as HH:MM in the company's time. */
  outcome: 'DELIVERED' | 'PARTLY_DELIVERED';
  outcomeAt: string | null;
  time: string | null;
  /** What changed after: "corrected by office: Not delivered", "photo received later"; null = nothing. */
  after: string | null;
}

/** A driver link (truck-day) with CAMERA_ALERT_PER_DAY or more results saved without a photo. */
export interface CameraLinkAlert {
  date: string;
  truckId: string;
  truckCode: string;
  drivers: string[];
  /** Results of that truck-day saved without a photo (every depot). */
  count: number;
  /** Of the listed ones, how many are "photo not received" (the others: Camera not working). */
  notReceived: number;
}

/**
 * What changed after the driver's result (pure): the office's correction, the driver's own later
 * result, a photo that arrived after all. Null when the current result is still the driver's.
 */
export function noPhotoAfterText(v: { driverResultOutcome?: string | null; outcome: string | null; outcomeSource: string | null; photoCount?: number | null }): string | null {
  const parts: string[] = [];
  const label = (o: string) => OUTCOME_LABEL[o] ?? o;
  // A cleared result has no source (the office's Clear or the driver's Undo): "result cleared".
  if (v.outcome === null) parts.push('result cleared');
  else if (v.outcomeSource === 'DISPATCHER') parts.push(v.outcome === v.driverResultOutcome ? 'corrected by office' : `corrected by office: ${label(v.outcome)}`);
  else if (v.outcome !== v.driverResultOutcome) parts.push(`changed by the driver: ${label(v.outcome)}`);
  if ((v.photoCount ?? 0) > 0) parts.push('photo received later');
  return parts.length ? parts.join(', ') : null;
}

/** A row of the list from a load, its planned stop, the visit and why it counts. */
export function cameraExceptionOf(
  load: { date: string; depotId: string; truckId: string; truckCode: string; id: string; loadNo: number; driverName: string | null },
  stop: { sequence: number; customerCode: string; branchCode: string | null; customerName: string },
  v: { driverResultOutcome: string | null; driverResultAt: Date | string | null; outcome: string | null; outcomeSource: string | null; photoCount?: number | null },
  kind: NoPhotoKind,
  tz: string,
): CameraException {
  const at = v.driverResultAt ? new Date(v.driverResultAt) : null;
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
    kind,
    outcome: v.driverResultOutcome === 'PARTLY_DELIVERED' ? 'PARTLY_DELIVERED' : 'DELIVERED',
    outcomeAt: at ? at.toISOString() : null,
    time: at ? fmtHhmm(localMinutes(at, tz)) : null,
    after: noPhotoAfterText(v),
  };
}

/** By date, truck, trip and stop. */
export function sortCameraExceptions(rows: readonly CameraException[]): CameraException[] {
  return [...rows].sort((a, b) => a.date.localeCompare(b.date) || a.truckCode.localeCompare(b.truckCode) || a.loadNo - b.loadNo || a.sequence - b.sequence);
}

/**
 * The driver links (truck-days) of these rows with CAMERA_ALERT_PER_DAY or more. `counts` (truckDayKey
 * -> results without a photo, every depot) wins over the rows' own count: a truck that loaded at two
 * depots has one link for the day.
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
    const notReceived = list.filter((r) => r.kind === 'PHOTO_NOT_RECEIVED').length;
    out.push({ date: list[0]!.date, truckId: list[0]!.truckId, truckCode: list[0]!.truckCode, drivers, count, notReceived });
  }
  return out.sort((a, b) => b.count - a.count || a.date.localeCompare(b.date) || a.truckCode.localeCompare(b.truckCode));
}

/**
 * "3 results saved without a photo (Camera not working)", "(2 Camera not working, 1 photo not
 * received)", or null when there is none. `notReceived`: how many of the n are "photo not received".
 */
export function cameraHeadline(n: number, notReceived = 0): string | null {
  if (n <= 0) return null;
  const camera = n - notReceived;
  const why = !notReceived ? 'Camera not working' : !camera ? 'photo not received' : `${camera} Camera not working, ${notReceived} photo not received`;
  return `${countOf(n, 'result')} saved without a photo (${why})`;
}

/** "T05 trip 1 stop 3 · ACME Store (ACME) · Salim · 10:42 · Delivered[ · photo not received][ · corrected by office]" */
export function cameraExceptionText(e: CameraException, opts: { withDate?: boolean } = {}): string {
  const customer = `${e.customerName} (${e.customerCode}${e.branchCode ? `/${e.branchCode}` : ''})`;
  return [
    `${opts.withDate ? `${fmtDayMonth(e.date)} ` : ''}${e.truckCode} trip ${e.loadNo} stop ${e.sequence}`,
    customer,
    e.driverName ?? 'no driver set',
    e.time ?? 'time not known',
    e.outcome === 'PARTLY_DELIVERED' ? 'Partly delivered' : 'Delivered',
    ...(e.kind === 'PHOTO_NOT_RECEIVED' ? ['photo not received'] : []),
    ...(e.after ? [e.after] : []),
  ].join(' · ');
}

/** "T05 (Salim): Camera not working used 3 times on 5 Oct - check the phone's camera with the driver." */
export function cameraAlertText(a: CameraLinkAlert): string {
  const who = a.drivers.length ? ` (${a.drivers.join(', ')})` : '';
  if (!a.notReceived) return `${a.truckCode}${who}: Camera not working used ${countOf(a.count, 'time')} on ${fmtDayMonth(a.date)} - check the phone's camera with the driver.`;
  return `${a.truckCode}${who}: ${countOf(a.count, 'result')} saved without a photo on ${fmtDayMonth(a.date)} (${a.count - a.notReceived} Camera not working, ${a.notReceived} photo not received) - check the phone's camera and signal with the driver.`;
}

/** The dashboard and Summary line: "4 of 120 delivered results (3.3 %)". */
export function cameraShareText(k: { withoutPhoto: number; delivered: number; partly: number; withoutPhotoPct: number | null }): string {
  const of = k.delivered + k.partly;
  return `${k.withoutPhoto} of ${countOf(of, 'delivered result')}${k.withoutPhotoPct === null ? '' : ` (${k.withoutPhotoPct} %)`}`;
}
