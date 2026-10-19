/**
 * The "Analysis data" Excel (owner request 19 Oct 2026: "build on more data for our analysis later and
 * improvement"): the fact tables of lib/analysis/* for a range of delivery dates (at most 92), one depot or
 * every depot. GET /api/analysis/export, company admin and dispatcher (PLANNER and up), never a VIEWER: the
 * "Pins to review" sheet holds standing points (positions worked out from the customer's pin and the stored
 * distance and bearing), office data that must never be shared outside the company. Reads only, every query
 * through the caller's company (tenantDb). exceljs streamed like the Delivery actuals (lib/delivery/actuals-workbook.ts).
 *
 * Sheets: ReadMe; Truck days; Visits; Sub-stays (and the trips away from a site); Legs; Depot turns; Pins to
 * review (customers with a pin offset on 2 or more visits - the truck unloaded 120-500 m from the pin, longer
 * than it stood near it - with the median standing point: the GPS study found 7 such pins, an office data fix;
 * a big site's second drop point is never listed: review of 19 Oct 2026); Late result taps (the truck more than
 * 500 m from the pin when the driver saved the result); Alert causes & actions (owner request 20 Oct 2026: every
 * operations alert of the range with the cause & action the office recorded after checking it; also alone,
 * `only=alerts`, from the Alerts page, up to 366 days). Never the raw trail, a driver, a phone or an IP address.
 */
import { PassThrough } from 'node:stream';
import ExcelJS from 'exceljs';
import type { FactDepotTurn, FactLeg, FactTruckDay, FactVisit } from '@prisma/client';
import { findInParts } from '../in-parts';
import { dateOnly, DEFAULT_TZ, fmtHhmm, isoOf, localDateIso, localMinutes } from '../dispatch/time';
import { distanceM } from '../dispatch/snapshots';
import { ALERT_RULE_SPECS, RESOLVED_REASON_TEXT, SEVERITY_LABEL, isAlertRule, type ResolvedReason } from '../alerts/catalog';
import { ALERT_FOLLOWUP_DAYS, REVIEW_FAMILY_LABEL, actionLabel, causeLabel, reviewFamilyOf } from '../alerts/review';
import { destinationOf, median } from './gps';
import type { AwayJson, SubstayJson } from './types';

/**
 * An operations alert as the "Alert causes & actions" sheet reads it (an explicit select: never the e-mail
 * state, never a user id; the names of who acknowledged and who saved the cause & action).
 */
export interface AlertExportRow {
  id: string;
  depotId: string;
  deliveryDate: Date;
  rule: string;
  truckCode: string;
  loadNo: number | null;
  sequence: number | null;
  customerId: string | null;
  severity: string;
  tier: number;
  value: number;
  threshold: number;
  text: string;
  factsJson: unknown;
  occurredAt: Date;
  firstSeenAt: Date;
  lastSeenAt: Date;
  resolvedAt: Date | null;
  resolvedReason: string | null;
  occurrences: number;
  ackedAt: Date | null;
  ackedBy: { name: string } | null;
  reviewCause: string | null;
  reviewCauseOther: string | null;
  reviewAction: string | null;
  reviewActionOther: string | null;
  reviewNote: string | null;
  reviewFollowUp: boolean;
  reviewFirstAt: Date | null;
  reviewFirstBy: { name: string } | null;
  reviewedAt: Date | null;
  reviewedBy: { name: string } | null;
  reviewSaves: number;
  reviewGroupId: string | null;
  reviewTier: number | null;
  reviewOccurrences: number | null;
  reviewCustomerId: string | null;
  detailsRemovedAt: Date | null;
}

/** The select of AlertExportRow (lib/alerts: OpsAlert). */
export const ALERT_EXPORT_SELECT = {
  id: true,
  depotId: true,
  deliveryDate: true,
  rule: true,
  truckCode: true,
  loadNo: true,
  sequence: true,
  customerId: true,
  severity: true,
  tier: true,
  value: true,
  threshold: true,
  text: true,
  factsJson: true,
  occurredAt: true,
  firstSeenAt: true,
  lastSeenAt: true,
  resolvedAt: true,
  resolvedReason: true,
  occurrences: true,
  ackedAt: true,
  ackedBy: { select: { name: true } },
  reviewCause: true,
  reviewCauseOther: true,
  reviewAction: true,
  reviewActionOther: true,
  reviewNote: true,
  reviewFollowUp: true,
  reviewFirstAt: true,
  reviewFirstBy: { select: { name: true } },
  reviewedAt: true,
  reviewedBy: { select: { name: true } },
  reviewSaves: true,
  reviewGroupId: true,
  reviewTier: true,
  reviewOccurrences: true,
  reviewCustomerId: true,
  detailsRemovedAt: true,
} as const;

/** The reads the export makes (tenantDb in the route; a fake in the tests). */
export interface AnalysisDb {
  factTruckDay: { findMany(args: unknown): Promise<FactTruckDay[]> };
  factVisit: { findMany(args: unknown): Promise<FactVisit[]> };
  factLeg: { findMany(args: unknown): Promise<FactLeg[]> };
  factDepotTurn: { findMany(args: unknown): Promise<FactDepotTurn[]> };
  opsAlert: { findMany(args: unknown): Promise<AlertExportRow[]> };
  customer: { findMany(args: unknown): Promise<{ id: string; code: string; branchCode: string | null; name: string; lat: number | null; lng: number | null }[]> };
  depot: { findMany(args: unknown): Promise<{ id: string; code: string }[]> };
  stopVisit: { findMany(args: unknown): Promise<{ id: string; plannedLat: number | null; plannedLng: number | null }[]> };
  tenantConfig: { findFirst(args: unknown): Promise<{ timezone: string } | null> };
}

export interface AnalysisData {
  tz: string;
  truckDays: FactTruckDay[];
  visits: FactVisit[];
  legs: FactLeg[];
  turns: FactDepotTurn[];
  /** The operations alerts of the range with their cause & action (owner request 20 Oct 2026). */
  alerts: AlertExportRow[];
  customers: Map<string, { code: string; branchCode: string | null; name: string; lat: number | null; lng: number | null }>;
  depots: Map<string, string>;
  /** The pin each pin-offset visit was planned with (StopVisit.plannedLat/Lng), by visit id. */
  plannedPins: Map<string, { lat: number; lng: number }>;
}

/**
 * The facts of [from, to], one depot or all; every read names the company (and the db is the company's).
 * `only: 'alerts'`: the alerts alone (no fact is read).
 */
export async function readAnalysis(
  db: AnalysisDb,
  tenantId: string,
  range: { from: string; to: string },
  depotId: string | null,
  opts: { only?: 'alerts' } = {},
): Promise<AnalysisData> {
  const where = { tenantId, deliveryDate: { gte: dateOnly(range.from), lte: dateOnly(range.to) }, ...(depotId ? { depotId } : {}) };
  const facts = opts.only !== 'alerts';
  const none = <T>() => Promise.resolve([] as T[]);
  const [cfg, truckDays, visits, legs, turns, depots, alerts] = await Promise.all([
    db.tenantConfig.findFirst({ where: { tenantId }, select: { timezone: true } }),
    facts ? db.factTruckDay.findMany({ where, orderBy: [{ deliveryDate: 'asc' }, { truckCode: 'asc' }] }) : none<FactTruckDay>(),
    facts ? db.factVisit.findMany({ where, orderBy: [{ deliveryDate: 'asc' }, { truckCode: 'asc' }, { loadNo: 'asc' }, { sequence: 'asc' }] }) : none<FactVisit>(),
    facts ? db.factLeg.findMany({ where, orderBy: [{ deliveryDate: 'asc' }, { truckCode: 'asc' }, { loadNo: 'asc' }, { legNo: 'asc' }] }) : none<FactLeg>(),
    facts ? db.factDepotTurn.findMany({ where, orderBy: [{ deliveryDate: 'asc' }, { truckCode: 'asc' }, { afterLoadNo: 'asc' }] }) : none<FactDepotTurn>(),
    db.depot.findMany({ where: { tenantId }, select: { id: true, code: true } }),
    db.opsAlert.findMany({ where, select: ALERT_EXPORT_SELECT, orderBy: [{ deliveryDate: 'asc' }, { truckCode: 'asc' }, { occurredAt: 'asc' }, { id: 'asc' }] }),
  ]);
  // The alerts' customers now and when their cause & action was saved (a re-plan can put another customer at the stop).
  const alertCustomers = alerts.flatMap((a) => [a.customerId, a.reviewCustomerId]).filter((c): c is string => !!c);
  const customerIds = [...new Set([...visits.map((v) => v.customerId), ...alertCustomers])];
  const offsetVisitIds = [...new Set(visits.filter((v) => v.pinOffset && v.visitId).map((v) => v.visitId!))];
  const [customers, pins] = await Promise.all([
    findInParts(customerIds, (part) => db.customer.findMany({ where: { tenantId, id: { in: part } }, select: { id: true, code: true, branchCode: true, name: true, lat: true, lng: true } })),
    findInParts(offsetVisitIds, (part) => db.stopVisit.findMany({ where: { tenantId, id: { in: part } }, select: { id: true, plannedLat: true, plannedLng: true } })),
  ]);
  const plannedPins = new Map<string, { lat: number; lng: number }>();
  for (const p of pins) if (p.plannedLat !== null && p.plannedLng !== null) plannedPins.set(p.id, { lat: p.plannedLat, lng: p.plannedLng });
  return {
    tz: cfg?.timezone || DEFAULT_TZ,
    truckDays,
    visits,
    legs,
    turns,
    alerts,
    customers: new Map(customers.map((c) => [c.id, { code: c.code, branchCode: c.branchCode, name: c.name, lat: c.lat, lng: c.lng }])),
    depots: new Map(depots.map((d) => [d.id, d.code])),
    plannedPins,
  };
}

/** One customer of the "Pins to review" sheet. */
export interface PinReviewRow {
  customerCode: string;
  branch: string | null;
  customer: string;
  offsetVisits: number;
  siteVisits: number;
  firstDate: string;
  lastDate: string;
  trucks: string;
  medianStandM: number | null;
  standingPoint: string | null;
  pinNow: string | null;
  pinNowToStandingM: number | null;
}

/** At least this many visits with the truck standing 120-500 m off the pin before a customer is listed. */
export const PIN_REVIEW_MIN_VISITS = 2;

const latLngText = (p: { lat: number; lng: number }) => `${p.lat.toFixed(6)}, ${p.lng.toFixed(6)}`;

/**
 * The customers whose pin may be wrong: a pin offset (FactVisit.pinOffset: the truck unloaded 120-500 m from
 * it, standing there longer than within 120 m of it) on PIN_REVIEW_MIN_VISITS or more visits. A big site's
 * second drop point is never one (review of 19 Oct 2026). The standing point is the median of each visit's
 * standing spot (the pin it was planned with, moved by the stored distance and bearing). Only for the office
 * to check and move the pin; never a waiting spot picked by RouteIQ alone (the study: "do not move a pin to a
 * waiting spot").
 */
export function pinsToReview(data: Pick<AnalysisData, 'visits' | 'customers' | 'plannedPins'>): PinReviewRow[] {
  const by = new Map<string, FactVisit[]>();
  for (const v of data.visits) {
    if (!v.siteStartAt) continue;
    by.set(v.customerId, [...(by.get(v.customerId) ?? []), v]);
  }
  const out: PinReviewRow[] = [];
  for (const [customerId, list] of by) {
    const off = list.filter((v) => v.pinOffset && v.standDistM !== null && v.standBearingDeg !== null);
    if (off.length < PIN_REVIEW_MIN_VISITS) continue;
    const c = data.customers.get(customerId);
    const pinNow = c && c.lat !== null && c.lng !== null ? { lat: c.lat, lng: c.lng } : null;
    const points = off
      .map((v) => {
        const pin = (v.visitId ? data.plannedPins.get(v.visitId) : undefined) ?? pinNow;
        return pin ? destinationOf(pin, v.standDistM!, v.standBearingDeg!) : null;
      })
      .filter((p): p is { lat: number; lng: number } => !!p);
    const stand = points.length ? { lat: median(points.map((p) => p.lat))!, lng: median(points.map((p) => p.lng))! } : null;
    const dates = off.map((v) => isoOf(v.deliveryDate)).sort();
    out.push({
      customerCode: c?.code ?? off[0]!.customerCode,
      branch: c?.branchCode ?? null,
      customer: c?.name ?? '',
      offsetVisits: off.length,
      siteVisits: list.length,
      firstDate: dates[0]!,
      lastDate: dates[dates.length - 1]!,
      trucks: [...new Set(off.map((v) => v.truckCode))].sort().join(', '),
      medianStandM: Math.round(median(off.map((v) => v.standDistM!))!),
      standingPoint: stand ? latLngText(stand) : null,
      pinNow: pinNow ? latLngText(pinNow) : null,
      pinNowToStandingM: stand && pinNow ? Math.round(distanceM(pinNow, stand)) : null,
    });
  }
  return out.sort((a, b) => b.offsetVisits - a.offsetVisits || a.customerCode.localeCompare(b.customerCode));
}

type Col<R> = { header: string; width: number; value: (r: R) => string | number | boolean | null };

const yesNo = (b: boolean | null | undefined) => (b === null || b === undefined ? null : b ? 'Yes' : 'No');

/** A time in the company's zone: "07:42" on the delivery date, else "2026-10-19 00:12". */
function at(d: Date | null, date: string, tz: string): string | null {
  if (!d) return null;
  const day = localDateIso(d, tz);
  const hm = fmtHhmm(localMinutes(d, tz));
  return day === date ? hm : `${day} ${hm}`;
}

const SOURCE_TEXT: Record<string, string> = { PHONE_AUTO: 'Phone (automatic)', PHONE_MANUAL: 'Driver tap', DISPATCHER: 'Office', AYUN: 'GPS (Ayun)', SYSTEM: 'RouteIQ' };
const source = (s: string | null) => (s ? (SOURCE_TEXT[s] ?? s) : null);

export const README_LINES: string[] = [
  'RouteIQ analysis data (owner request 19 Oct 2026). Facts kept per delivery date for later analysis and plan calibration; built every night at about 03:00 for the day before, refreshed until 4 days after the date, then frozen.',
  'Times are company time. Minutes and km as measured; an empty cell means not known. Each row keeps the settings in force when it was built (the last columns).',
  'Truck days: time out (first depot OUT to last depot IN by GPS, over the trips of the delivery date only: a trip that left the evening before is the day before\'s, a truck out overnight with the day\'s load counts from its first move after midnight; "Back from" says when the trail ended before the truck came back and the tracker\'s own depot IN was used), km, moving, at customer sites, idle elsewhere (standstills of 3 min or more away from every customer and the depot: count and minutes only), overtime against the setting. GPS note PARTIAL_TRAIL: the day was built late (RouteIQ down that night) after the start of its trail was already deleted, so no GPS column is kept.',
  'Visits: one row per planned stop of a load that left. Site start and end: the truck on the customer site by GPS (within 300 m of the pin, or standing within 500 m: a second drop point). Trips away from the site and back are never counted as unloading (Minutes away).',
  'Unloading: on site by GPS (after the window opened, the time away left out), as RouteIQ holds the stop (arrival to departure), and by taps (the driver\'s and the office\'s own times, GPS left out). All three are clipped at the window on both sides: a stop served before its window opened counts from its arrival.',
  'Base unloading min: the time the plan gave the stop before the time per case (the customer\'s confirmed unloading time, else its customer type\'s, else the company default). Planned unloading min = base + unloading min per case x cases.',
  'Usable for rate: Delivered or Partly, cases delivered, an unloading time, a base known, the result not changed, no other stop within 300 m, no photo more than 500 m away. Min per case = (unloading - base unloading) / cases delivered, 0 when the unloading was shorter than the base: compare it with "Setting: unloading min per case".',
  'Builder analysis-v1 (rows frozen before the fix of 19 Oct 2026 was deployed): Base unloading min is the customer\'s stored time even when not confirmed (the plan used another), and Min per case = unloading / cases delivered (base not taken off). Use analysis-v2 rows for the rate.',
  'Flags: LATE_RESULT_TAP (truck more than 500 m from the pin at the driver\'s result tap), PIN_OFFSET (truck stood 120-500 m from the pin to unload, longer than within 120 m of it: a big site\'s second drop point is not one), MULTI_DROP (drop points more than 50 m apart), LEFT_AND_RETURNED, PREMATURE_DEP (the GPS departure RouteIQ holds is more than 5 min before the truck left the site), SPLIT_STAYS (the live GPS detector saw more than one stay inside the site), SHARED_SITE, NEAR_DEPOT, RESULT_CHANGED, PHOTO_FAR, NO_GPS, GPS_NOT_SEEN (the stop\'s window was searched on the trail and the truck was not seen on site; a stop with no arrival and no result when the facts were built is never searched).',
  'Sub-stays: each standstill of 2 min or more on a site (STANDING), and each trip away from it (AWAY), from the site start, as distance and bearing from the pin (0 = north). No position of the truck is kept anywhere.',
  'Legs: each drive in the order driven (from the depot, between stops, back to the depot): drive minutes and km by GPS, against the plan where the two stops are consecutive in it; the straight line between the pins for the distance multiplier.',
  'Depot turns: each return to the depot between two loads: back to leaving by GPS and by the driver\'s taps (Back at depot, Leaving for next load), and the cases loaded for the next load.',
  'Pins to review (office use only, do not share): customers with PIN_OFFSET on 2 or more visits (the truck unloaded 120-500 m from the pin, longer than it stood near it), with the median standing point. Check it before moving a pin: a waiting spot is not the delivery point.',
  'Late result taps: the driver saved the result more than 500 m from the pin (after leaving): the departure time of those stops is late.',
];

const SETTINGS_COLS = <R extends { serviceMinPerCase: number; reloadMinutes: number; stopRadiusM: number; dwellMin: number; detectorVersion: string; analysisVersion: string; builtAt: Date; frozenAt: Date | null }>(): Col<R>[] => [
  { header: 'Setting: unloading min per case', width: 10, value: (r) => r.serviceMinPerCase },
  { header: 'Setting: reload min', width: 8, value: (r) => r.reloadMinutes },
  { header: 'Setting: GPS stop radius m', width: 8, value: (r) => r.stopRadiusM },
  { header: 'Setting: GPS dwell min', width: 8, value: (r) => r.dwellMin },
  { header: 'Detector', width: 9, value: (r) => r.detectorVersion },
  { header: 'Builder', width: 11, value: (r) => r.analysisVersion },
  { header: 'Built', width: 17, value: (r) => r.builtAt.toISOString().slice(0, 16).replace('T', ' ') },
  { header: 'Frozen', width: 17, value: (r) => (r.frozenAt ? r.frozenAt.toISOString().slice(0, 16).replace('T', ' ') : null) },
];

export interface AnalysisMeta {
  tenantName: string;
  from: string;
  to: string;
  depot: string | null;
  generatedAt: Date;
  generatedBy: string;
}

const ROWS_PER_TURN = 200;
const nextTurn = () => new Promise<void>((resolve) => setImmediate(resolve));

/** The name of the alerts' sheet (owner request 20 Oct 2026); always the last sheet of the Analysis data. */
export const ALERT_SHEET = 'Alert causes & actions';

/** The ReadMe lines of the alerts' sheet (in both workbooks). */
export const README_ALERTS_LINES: string[] = [
  `${ALERT_SHEET} (owner request 20 Oct 2026): every operations alert of the range - one row per rule and subject (a stop, a load or a truck-day) per day - with the cause & action the office recorded after checking it (empty when nobody did), so the share of alerts with one, the causes per rule and the decisions taken can be counted. An alert that closed and came back keeps one cause & action ("Came back after the save").`,
  'Incident: the alerts of one truck and day saved together with one cause & action share a number (count incidents, not alerts). Minutes from first seen to first save: from when the alert was first shown (empty when saved before, which happens when it came back). "Saved while the alert was open" tells live decisions from labelling after the fact.',
  'Customer: the customer of the stop now; "Customer when saved" is the one the cause & action was saved for (a re-plan can put another customer at the same stop: count causes per customer with that column).',
  'Retention: an alert is deleted with its cause & action 90 days after its date (keep this file to count older ones). Only where the company keeps alerts as long as the analysis data does the row stay, its text, facts (but "By GPS"), note and Other texts removed ("Details removed"). Today\'s alerts can still change after the download.',
  'Other: read the Other causes and actions once a month; tell RouteIQ support when one comes back often: it can become a choice of its own.',
];

/** One workbook streamed sheet by sheet with a turn for the web process every 200 rows (rows in, bytes out). */
function workbookWriter(meta: AnalysisMeta, tz: string) {
  const out = new PassThrough();
  const chunks: Buffer[] = [];
  out.on('data', (c: Buffer) => chunks.push(c));
  const ended = new Promise<void>((resolve, reject) => {
    out.on('end', resolve);
    out.on('error', reject);
  });
  ended.catch(() => undefined);
  const wb = new ExcelJS.stream.xlsx.WorkbookWriter({ stream: out, useStyles: true, useSharedStrings: true, zip: { zlib: { level: 6 } } });
  wb.creator = 'RouteIQ';
  wb.lastModifiedBy = 'RouteIQ';
  wb.created = meta.generatedAt;

  const sheet = async <R>(name: string, cols: Col<R>[], rows: readonly R[]) => {
    const ws = wb.addWorksheet(name, { views: [{ state: 'frozen', ySplit: 1 }] });
    ws.columns = cols.map((c, i) => ({ header: c.header, key: `c${i}`, width: c.width }));
    ws.getRow(1).font = { bold: true };
    ws.getRow(1).alignment = { wrapText: true, vertical: 'top' };
    if (cols.length) ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: cols.length } };
    let n = 0;
    for (const r of rows) {
      ws.addRow(Object.fromEntries(cols.map((c, i) => [`c${i}`, c.value(r)]))).commit();
      if (++n % ROWS_PER_TURN === 0) await nextTurn();
    }
    ws.commit();
  };

  /** The ReadMe: its title, the company, days, depot and who made it, then `lines`. */
  const readme = (title: string, lines: readonly string[]) => {
    const ws = wb.addWorksheet('ReadMe');
    ws.columns = [{ header: title, key: 'a', width: 160 }];
    ws.getRow(1).font = { bold: true };
    ws.addRow({ a: `Company: ${meta.tenantName}. Days: ${meta.from === meta.to ? meta.from : `${meta.from} to ${meta.to}`}. Depot: ${meta.depot ?? 'all'}. Made ${localDateIso(meta.generatedAt, tz)} ${fmtHhmm(localMinutes(meta.generatedAt, tz))} by ${meta.generatedBy}.` }).commit();
    for (const line of lines) ws.addRow({ a: line }).commit();
    ws.commit();
  };

  const finish = async () => {
    await wb.commit();
    await ended;
    return Buffer.concat(chunks);
  };
  return { sheet, readme, finish };
}

const STATE_WORD = (r: Pick<AlertExportRow, 'resolvedAt' | 'ackedAt'>) => (r.resolvedAt ? 'Over' : r.ackedAt ? 'Acknowledged' : 'Open');
const minutesBetween = (a: Date, b: Date) => Math.round(((b.getTime() - a.getTime()) / 60_000) * 10) / 10;

/** The columns of the alerts' sheet (owner request 20 Oct 2026; critique of the design, items 1, 5, 6, 8 and 14). */
export function alertSheetColumns(data: Pick<AnalysisData, 'tz' | 'depots' | 'customers' | 'alerts'>): Col<AlertExportRow>[] {
  const tz = data.tz;
  const d = (r: { deliveryDate: Date }) => isoOf(r.deliveryDate);
  const cust = (id: string | null) => (id ? data.customers.get(id) : undefined);
  const spec = (r: AlertExportRow) => (isAlertRule(r.rule) ? ALERT_RULE_SPECS[r.rule] : null);
  const saved = (r: AlertExportRow) => !!r.reviewedAt;
  const yes = (r: AlertExportRow, b: boolean) => (saved(r) ? yesNo(b) : null);
  // One number per incident (the alerts saved together), in the order the sheet lists them.
  const incident = new Map<string, number>();
  for (const a of data.alerts) if (a.reviewGroupId && !incident.has(a.reviewGroupId)) incident.set(a.reviewGroupId, incident.size + 1);
  return [
    { header: 'Date', width: 11, value: d },
    { header: 'Depot', width: 8, value: (r) => data.depots.get(r.depotId) ?? '' },
    { header: 'Truck', width: 10, value: (r) => r.truckCode },
    { header: 'Trip', width: 5, value: (r) => r.loadNo },
    { header: 'Stop', width: 5, value: (r) => r.sequence },
    { header: 'Customer code', width: 12, value: (r) => cust(r.customerId)?.code ?? null },
    { header: 'Customer', width: 26, value: (r) => cust(r.customerId)?.name ?? null },
    { header: 'Rule no', width: 6, value: (r) => (spec(r) ? `R${spec(r)!.no}` : null) },
    { header: 'Rule', width: 24, value: (r) => spec(r)?.label ?? r.rule },
    { header: 'Cause & action list', width: 16, value: (r) => (reviewFamilyOf(r.rule) ? REVIEW_FAMILY_LABEL[reviewFamilyOf(r.rule)!] : null) },
    { header: 'By GPS', width: 6, value: (r) => yesNo(!!r.factsJson && typeof r.factsJson === 'object' && (r.factsJson as Record<string, unknown>).gps === true) },
    { header: 'Severity', width: 8, value: (r) => SEVERITY_LABEL[r.severity as 'WARN' | 'HIGH'] ?? r.severity },
    { header: 'Tier', width: 5, value: (r) => r.tier },
    { header: 'Value', width: 7, value: (r) => r.value },
    { header: 'Threshold', width: 8, value: (r) => r.threshold },
    { header: 'Unit', width: 7, value: (r) => spec(r)?.unit ?? null },
    { header: 'Started', width: 8, value: (r) => at(r.occurredAt, d(r), tz) },
    { header: 'First seen', width: 8, value: (r) => at(r.firstSeenAt, d(r), tz) },
    { header: 'Last seen', width: 8, value: (r) => at(r.lastSeenAt, d(r), tz) },
    { header: 'Came back (times)', width: 7, value: (r) => r.occurrences - 1 },
    { header: 'State', width: 12, value: STATE_WORD },
    { header: 'Closed', width: 8, value: (r) => at(r.resolvedAt, d(r), tz) },
    { header: 'Closed as', width: 16, value: (r) => (r.resolvedReason ? (RESOLVED_REASON_TEXT[r.resolvedReason as ResolvedReason] ?? r.resolvedReason) : null) },
    { header: 'Acknowledged by', width: 16, value: (r) => (r.ackedAt ? (r.ackedBy?.name ?? null) : null) },
    { header: 'Acknowledged', width: 8, value: (r) => at(r.ackedAt, d(r), tz) },
    { header: 'What happened', width: 50, value: (r) => r.text || null },
    { header: 'Details removed (90 days)', width: 8, value: (r) => yesNo(!!r.detailsRemovedAt) },
    { header: 'Cause code', width: 16, value: (r) => r.reviewCause },
    { header: 'Cause', width: 30, value: (r) => (r.reviewCause ? causeLabel(r.reviewCause) : null) },
    { header: 'Cause (other)', width: 24, value: (r) => r.reviewCauseOther },
    { header: 'Action code', width: 16, value: (r) => r.reviewAction },
    { header: 'Action', width: 30, value: (r) => (r.reviewAction ? actionLabel(r.reviewAction) : null) },
    { header: 'Action (other)', width: 24, value: (r) => r.reviewActionOther },
    { header: 'Note', width: 40, value: (r) => r.reviewNote },
    { header: 'Follow-up', width: 7, value: (r) => yes(r, r.reviewFollowUp) },
    { header: 'First saved by', width: 16, value: (r) => (saved(r) ? (r.reviewFirstBy?.name ?? null) : null) },
    { header: 'First saved', width: 8, value: (r) => at(r.reviewFirstAt, d(r), tz) },
    { header: 'Last saved by', width: 16, value: (r) => (saved(r) ? (r.reviewedBy?.name ?? null) : null) },
    { header: 'Last saved', width: 8, value: (r) => at(r.reviewedAt, d(r), tz) },
    { header: 'Edited (times)', width: 6, value: (r) => (saved(r) ? Math.max(0, r.reviewSaves - 1) : null) },
    {
      header: 'Minutes from first seen to first save',
      width: 9,
      value: (r) => {
        if (!r.reviewFirstAt) return null;
        const m = minutesBetween(r.firstSeenAt, r.reviewFirstAt);
        return m >= 0 ? m : null;
      },
    },
    { header: 'Saved while the alert was open', width: 8, value: (r) => (r.reviewFirstAt ? yesNo(!r.resolvedAt || r.reviewFirstAt.getTime() < r.resolvedAt.getTime()) : null) },
    { header: 'Came back after the save', width: 8, value: (r) => yes(r, r.reviewOccurrences !== null && r.occurrences > r.reviewOccurrences) },
    { header: 'Got worse after the save', width: 8, value: (r) => yes(r, r.reviewTier !== null && r.tier > r.reviewTier) },
    { header: 'Now about another customer', width: 8, value: (r) => yes(r, (r.customerId ?? null) !== (r.reviewCustomerId ?? null)) },
    // The customer the cause & action was saved for (review of the branch, 20 Oct 2026, finding 10): the Customer
    // columns name the stop's customer now, which a re-plan can change.
    { header: 'Customer code when saved', width: 12, value: (r) => (saved(r) ? (cust(r.reviewCustomerId)?.code ?? null) : null) },
    { header: 'Customer when saved', width: 26, value: (r) => (saved(r) ? (cust(r.reviewCustomerId)?.name ?? null) : null) },
    { header: 'Incident', width: 7, value: (r) => (r.reviewGroupId ? (incident.get(r.reviewGroupId) ?? null) : null) },
  ];
}

/**
 * The alerts with their cause & action alone (`only=alerts`, the Alerts page's Excel link; critique of the
 * design, item 18: its own small builder): the ReadMe and the alerts' sheet.
 */
export async function buildAlertCausesWorkbook(data: AnalysisData, meta: AnalysisMeta): Promise<Buffer> {
  const w = workbookWriter(meta, data.tz);
  w.readme(ALERT_SHEET, [...README_ALERTS_LINES, `The Follow-up filter of the Alerts page reads the last ${ALERT_FOLLOWUP_DAYS} days whatever the dates; this file holds the dates above only.`]);
  await w.sheet(ALERT_SHEET, alertSheetColumns(data), data.alerts);
  return w.finish();
}

/** The workbook (rows in, bytes out), streamed sheet by sheet with a turn for the web process every 200 rows. */
export async function buildAnalysisWorkbook(data: AnalysisData, meta: AnalysisMeta): Promise<Buffer> {
  const tz = data.tz;
  const w = workbookWriter(meta, tz);
  const sheet = w.sheet;
  const depotCode = (id: string) => data.depots.get(id) ?? '';
  const cust = (id: string) => data.customers.get(id);

  w.readme('Analysis data', [...README_LINES, ...README_ALERTS_LINES]);

  type TD = FactTruckDay;
  const d = (r: { deliveryDate: Date }) => isoOf(r.deliveryDate);
  await sheet<TD>(
    'Truck days',
    [
      { header: 'Date', width: 11, value: d },
      { header: 'Depot', width: 8, value: (r) => depotCode(r.depotId) },
      { header: 'Truck', width: 10, value: (r) => r.truckCode },
      { header: 'GPS tracker', width: 7, value: (r) => yesNo(r.tracked) },
      { header: 'Loads', width: 6, value: (r) => r.loads },
      { header: 'Stops planned', width: 7, value: (r) => r.stopsPlanned },
      { header: 'With a result', width: 7, value: (r) => r.stopsWithResult },
      { header: 'Delivered', width: 7, value: (r) => r.delivered },
      { header: 'Partly', width: 7, value: (r) => r.partlyDelivered },
      { header: 'Not delivered', width: 7, value: (r) => r.notDelivered },
      { header: 'Cases planned', width: 8, value: (r) => r.casesPlanned },
      { header: 'Cases delivered', width: 8, value: (r) => r.casesDelivered },
      { header: 'Planned out', width: 8, value: (r) => (r.plannedDepartMin === null ? null : fmtHhmm(r.plannedDepartMin)) },
      { header: 'Planned back', width: 8, value: (r) => (r.plannedReturnMin === null ? null : fmtHhmm(r.plannedReturnMin)) },
      { header: 'Planned minutes out', width: 9, value: (r) => r.plannedOutMin },
      { header: 'Planned km', width: 8, value: (r) => r.plannedKm },
      { header: 'Out (GPS)', width: 8, value: (r) => at(r.firstOutAt, d(r), tz) },
      { header: 'Back (GPS)', width: 8, value: (r) => at(r.lastInAt, d(r), tz) },
      { header: 'Back from', width: 12, value: (r) => (r.lastInFrom === 'DEVICE_EVENT' ? "Tracker's depot IN" : r.lastInFrom === 'TRAIL' ? 'Trail' : null) },
      { header: 'Minutes out', width: 8, value: (r) => r.outMin },
      { header: 'Overtime min', width: 8, value: (r) => r.overtimeMin },
      { header: 'Setting: overtime after min', width: 9, value: (r) => r.overtimeAfterMin },
      { header: 'Km (GPS)', width: 8, value: (r) => r.kmGps },
      { header: 'Moving min', width: 8, value: (r) => r.movingMin },
      { header: 'At customer sites min', width: 9, value: (r) => r.atSitesMin },
      { header: 'Idle stops elsewhere', width: 8, value: (r) => r.idleStops },
      { header: 'Idle elsewhere min', width: 8, value: (r) => r.idleMin },
      { header: 'GPS trips', width: 6, value: (r) => r.gpsTrips },
      { header: 'Trail points', width: 7, value: (r) => r.trailPoints },
      { header: 'Longest gap min', width: 7, value: (r) => r.maxGapMin },
      { header: 'Minutes in gaps over 5 min', width: 8, value: (r) => r.gapMinOver5 },
      { header: 'Frozen-position runs', width: 7, value: (r) => r.frozenRuns },
      { header: 'Frozen min', width: 7, value: (r) => r.frozenMin },
      { header: 'Spikes', width: 6, value: (r) => r.spikes },
      { header: 'Ignition sent', width: 7, value: (r) => yesNo(r.ignitionSeen) },
      { header: 'GPS note', width: 11, value: (r) => r.gpsNote },
      { header: 'Setting: loading min per case', width: 9, value: (r) => r.loadingMinPerCase },
      { header: 'Setting: distance multiplier', width: 9, value: (r) => r.distanceMultiplier },
      { header: 'Setting: average km/h', width: 8, value: (r) => r.avgSpeedKmh },
      { header: 'Setting: road time factor', width: 8, value: (r) => r.roadTimeFactor },
      ...SETTINGS_COLS<TD>(),
    ],
    data.truckDays,
  );

  type V = FactVisit;
  const window = (r: V) => (r.windowStartMin === null && r.windowEndMin === null ? null : `${fmtHhmm(r.windowStartMin ?? 0)}-${r.windowEndMin === null ? '' : fmtHhmm(r.windowEndMin)}`);
  await sheet<V>(
    'Visits',
    [
      { header: 'Date', width: 11, value: d },
      { header: 'Depot', width: 8, value: (r) => depotCode(r.depotId) },
      { header: 'Truck', width: 10, value: (r) => r.truckCode },
      { header: 'Trip', width: 5, value: (r) => r.loadNo },
      { header: 'Stop', width: 5, value: (r) => r.sequence },
      { header: 'Order driven', width: 6, value: (r) => r.actualOrder },
      { header: 'Customer code', width: 12, value: (r) => cust(r.customerId)?.code ?? r.customerCode },
      { header: 'Branch', width: 8, value: (r) => cust(r.customerId)?.branchCode ?? null },
      { header: 'Customer', width: 26, value: (r) => cust(r.customerId)?.name ?? null },
      { header: 'Customer type', width: 12, value: (r) => r.customerType ?? 'UNTYPED' },
      { header: 'Base unloading min', width: 8, value: (r) => r.baseServiceMin },
      { header: 'Planned ETA', width: 8, value: (r) => (r.plannedEtaMin === null ? null : fmtHhmm(r.plannedEtaMin)) },
      { header: 'Window', width: 12, value: window },
      { header: 'Planned unloading min', width: 9, value: (r) => r.plannedServiceMin },
      { header: 'Cases planned', width: 8, value: (r) => r.casesPlanned },
      { header: 'Cases delivered', width: 8, value: (r) => r.casesDelivered },
      { header: 'Result', width: 14, value: (r) => r.outcome ?? 'No result' },
      { header: 'Reason', width: 16, value: (r) => r.reason },
      { header: 'First result', width: 14, value: (r) => r.firstOutcome },
      { header: 'First result at', width: 8, value: (r) => at(r.firstOutcomeAt, d(r), tz) },
      { header: 'Result changed', width: 7, value: (r) => yesNo(r.resultChanged) },
      { header: 'Result events', width: 6, value: (r) => r.outcomeEvents },
      { header: 'Arrival', width: 8, value: (r) => at(r.arrivedAt, d(r), tz) },
      { header: 'Arrival by', width: 14, value: (r) => source(r.arrivalSource) },
      { header: 'Departure', width: 8, value: (r) => at(r.departedAt, d(r), tz) },
      { header: 'Departure by', width: 14, value: (r) => source(r.departureSource) },
      { header: 'Departure = result time', width: 8, value: (r) => yesNo(r.departedAtOutcome) },
      { header: 'Result at', width: 8, value: (r) => at(r.outcomeAt, d(r), tz) },
      { header: 'Result by', width: 14, value: (r) => source(r.outcomeSource) },
      { header: 'Arrival minus ETA min', width: 8, value: (r) => r.arrivalVsEtaMin },
      { header: 'Site start (GPS)', width: 8, value: (r) => at(r.siteStartAt, d(r), tz) },
      { header: 'Site end (GPS)', width: 8, value: (r) => at(r.siteEndAt, d(r), tz) },
      { header: 'On site min', width: 8, value: (r) => r.onSiteMin },
      { header: 'Trips away', width: 6, value: (r) => r.awayCount },
      { header: 'Minutes away', width: 8, value: (r) => r.awayMin },
      { header: 'Waited for the window min', width: 8, value: (r) => r.waitMin },
      { header: 'Served before the window', width: 8, value: (r) => yesNo(r.servedBeforeWindow) },
      { header: 'Unloading on site (GPS) min', width: 9, value: (r) => r.unloadSiteMin },
      { header: 'Unloading as RouteIQ holds it min', width: 9, value: (r) => r.unloadVisitMin },
      { header: 'Unloading by taps min', width: 9, value: (r) => r.unloadTapMin },
      { header: 'Unloading min', width: 8, value: (r) => r.unloadMin },
      { header: 'Unloading from', width: 9, value: (r) => r.unloadSource },
      { header: 'Unloading minus plan min', width: 8, value: (r) => (r.unloadMin !== null && r.plannedServiceMin !== null ? Math.round((r.unloadMin - r.plannedServiceMin) * 10) / 10 : null) },
      { header: 'Usable for rate', width: 7, value: (r) => yesNo(r.usableForRate) },
      { header: 'Min per case', width: 7, value: (r) => r.minPerCase },
      { header: 'Sub-stays', width: 6, value: (r) => r.substays },
      { header: 'Drop points', width: 6, value: (r) => r.dropPoints },
      { header: 'Furthest standing m', width: 8, value: (r) => r.maxDistM },
      { header: 'Closest m', width: 7, value: (r) => r.closestM },
      { header: 'Standing spot m from pin', width: 8, value: (r) => r.standDistM },
      { header: 'Standing spot bearing', width: 8, value: (r) => r.standBearingDeg },
      { header: 'Pin offset', width: 6, value: (r) => yesNo(r.pinOffset) },
      { header: 'GPS detector stays', width: 7, value: (r) => r.detectorStays },
      { header: 'Result tap', width: 8, value: (r) => at(r.resultTapAt, d(r), tz) },
      { header: 'Truck m from pin at result tap', width: 9, value: (r) => r.truckDistAtResultM },
      { header: 'Late result tap', width: 7, value: (r) => yesNo(r.lateResultTap) },
      { header: 'Flags', width: 30, value: (r) => r.flags.join(' ') || null },
      ...SETTINGS_COLS<V>(),
    ],
    data.visits,
  );

  type S = { v: FactVisit; kind: 'STANDING' | 'AWAY'; n: number; startAt: Date; minutes: number; distM: number; bearingDeg: number | null };
  const subs: S[] = [];
  for (const v of data.visits) {
    if (!v.siteStartAt) continue;
    const start = v.siteStartAt.getTime();
    (Array.isArray(v.substaysJson) ? (v.substaysJson as unknown as SubstayJson[]) : []).forEach((s, i) =>
      subs.push({ v, kind: 'STANDING', n: i + 1, startAt: new Date(start + s.startOffsetSec * 1000), minutes: s.minutes, distM: s.distM, bearingDeg: s.bearingDeg }),
    );
    (Array.isArray(v.awayJson) ? (v.awayJson as unknown as AwayJson[]) : []).forEach((a, i) =>
      subs.push({ v, kind: 'AWAY', n: i + 1, startAt: new Date(start + a.startOffsetSec * 1000), minutes: a.minutes, distM: a.maxDistM, bearingDeg: null }),
    );
  }
  subs.sort((a, b) => a.v.deliveryDate.getTime() - b.v.deliveryDate.getTime() || a.v.truckCode.localeCompare(b.v.truckCode) || a.v.loadNo - b.v.loadNo || a.v.sequence - b.v.sequence || a.startAt.getTime() - b.startAt.getTime());
  await sheet<S>(
    'Sub-stays',
    [
      { header: 'Date', width: 11, value: (r) => d(r.v) },
      { header: 'Depot', width: 8, value: (r) => depotCode(r.v.depotId) },
      { header: 'Truck', width: 10, value: (r) => r.v.truckCode },
      { header: 'Trip', width: 5, value: (r) => r.v.loadNo },
      { header: 'Stop', width: 5, value: (r) => r.v.sequence },
      { header: 'Customer code', width: 12, value: (r) => cust(r.v.customerId)?.code ?? r.v.customerCode },
      { header: 'Customer type', width: 12, value: (r) => r.v.customerType ?? 'UNTYPED' },
      { header: 'Kind', width: 9, value: (r) => r.kind },
      { header: 'No.', width: 4, value: (r) => r.n },
      { header: 'Start', width: 8, value: (r) => at(r.startAt, d(r.v), tz) },
      { header: 'Minutes', width: 7, value: (r) => r.minutes },
      { header: 'Distance from pin m (AWAY: furthest)', width: 10, value: (r) => r.distM },
      { header: 'Bearing from pin', width: 7, value: (r) => r.bearingDeg },
    ],
    subs,
  );

  type L = FactLeg;
  await sheet<L>(
    'Legs',
    [
      { header: 'Date', width: 11, value: d },
      { header: 'Depot', width: 8, value: (r) => depotCode(r.depotId) },
      { header: 'Truck', width: 10, value: (r) => r.truckCode },
      { header: 'Trip', width: 5, value: (r) => r.loadNo },
      { header: 'Leg', width: 5, value: (r) => r.legNo },
      { header: 'From stop', width: 6, value: (r) => r.fromSeq ?? 'Depot' },
      { header: 'To stop', width: 6, value: (r) => r.toSeq ?? 'Depot' },
      { header: 'Consecutive in the plan', width: 8, value: (r) => yesNo(r.inPlanOrder) },
      { header: 'Left', width: 8, value: (r) => at(r.leftAt, d(r), tz) },
      { header: 'Arrived', width: 8, value: (r) => at(r.arrivedAt, d(r), tz) },
      { header: 'Hour of day', width: 6, value: (r) => r.hourOfDay },
      { header: 'Drive min', width: 7, value: (r) => r.driveMin },
      { header: 'Drive min (RouteIQ times)', width: 8, value: (r) => r.driveMinVisit },
      { header: 'Planned drive min', width: 8, value: (r) => r.plannedDriveMin },
      { header: 'Drive minus plan min', width: 8, value: (r) => (r.driveMin !== null && r.plannedDriveMin !== null ? Math.round((r.driveMin - r.plannedDriveMin) * 10) / 10 : null) },
      { header: 'Km (GPS)', width: 7, value: (r) => r.kmGps },
      { header: 'Planned km', width: 7, value: (r) => r.plannedKm },
      { header: 'Straight km', width: 7, value: (r) => r.kmStraight },
      { header: 'Road km / straight km', width: 8, value: (r) => (r.kmGps !== null && r.kmStraight !== null && r.kmStraight > 0.5 ? Math.round((r.kmGps / r.kmStraight) * 100) / 100 : null) },
      { header: 'Average km/h', width: 7, value: (r) => (r.kmGps !== null && r.driveMin ? Math.round((r.kmGps / r.driveMin) * 600) / 10 : null) },
      { header: 'Note', width: 18, value: (r) => r.note },
      { header: 'Setting: distance multiplier', width: 9, value: (r) => r.distanceMultiplier },
      { header: 'Setting: average km/h', width: 8, value: (r) => r.avgSpeedKmh },
      { header: 'Setting: road time factor', width: 8, value: (r) => r.roadTimeFactor },
      ...SETTINGS_COLS<L>(),
    ],
    data.legs,
  );

  type T = FactDepotTurn;
  await sheet<T>(
    'Depot turns',
    [
      { header: 'Date', width: 11, value: d },
      { header: 'Depot', width: 8, value: (r) => depotCode(r.depotId) },
      { header: 'Truck', width: 10, value: (r) => r.truckCode },
      { header: 'After trip', width: 6, value: (r) => r.afterLoadNo },
      { header: 'Next trip', width: 6, value: (r) => r.nextLoadNo },
      { header: 'Back (GPS)', width: 8, value: (r) => at(r.backGpsAt, d(r), tz) },
      { header: 'Left (GPS)', width: 8, value: (r) => at(r.leaveGpsAt, d(r), tz) },
      { header: 'Minutes (GPS)', width: 8, value: (r) => r.turnMinGps },
      { header: 'Back at depot (tap)', width: 8, value: (r) => at(r.backTapAt, d(r), tz) },
      { header: 'Leaving for next load (tap)', width: 8, value: (r) => at(r.leaveTapAt, d(r), tz) },
      { header: 'Minutes (taps)', width: 8, value: (r) => r.turnMinTaps },
      { header: 'Cases loaded', width: 8, value: (r) => r.casesLoaded },
      { header: 'Planned minutes', width: 8, value: (r) => r.plannedTurnMin },
      { header: 'Min per case loaded', width: 8, value: (r) => r.minPerCaseLoading },
      { header: 'Setting: loading min per case', width: 9, value: (r) => r.loadingMinPerCase },
      ...SETTINGS_COLS<T>(),
    ],
    data.turns,
  );

  await sheet<PinReviewRow>(
    'Pins to review',
    [
      { header: 'Customer code', width: 12, value: (r) => r.customerCode },
      { header: 'Branch', width: 8, value: (r) => r.branch },
      { header: 'Customer', width: 26, value: (r) => r.customer },
      { header: 'Visits standing 120-500 m off', width: 9, value: (r) => r.offsetVisits },
      { header: 'Visits seen on site (GPS)', width: 9, value: (r) => r.siteVisits },
      { header: 'First date', width: 11, value: (r) => r.firstDate },
      { header: 'Last date', width: 11, value: (r) => r.lastDate },
      { header: 'Trucks', width: 16, value: (r) => r.trucks },
      { header: 'Median standing m from pin', width: 9, value: (r) => r.medianStandM },
      { header: 'Median standing point (office use only)', width: 24, value: (r) => r.standingPoint },
      { header: 'Pin now', width: 24, value: (r) => r.pinNow },
      { header: 'Pin now to standing point m', width: 9, value: (r) => r.pinNowToStandingM },
    ],
    pinsToReview(data),
  );

  const late = data.visits.filter((v) => v.lateResultTap);
  await sheet<V>(
    'Late result taps',
    [
      { header: 'Date', width: 11, value: d },
      { header: 'Depot', width: 8, value: (r) => depotCode(r.depotId) },
      { header: 'Truck', width: 10, value: (r) => r.truckCode },
      { header: 'Trip', width: 5, value: (r) => r.loadNo },
      { header: 'Stop', width: 5, value: (r) => r.sequence },
      { header: 'Customer code', width: 12, value: (r) => cust(r.customerId)?.code ?? r.customerCode },
      { header: 'Customer', width: 26, value: (r) => cust(r.customerId)?.name ?? null },
      { header: 'Result', width: 14, value: (r) => r.outcome ?? 'No result' },
      { header: 'Result tap', width: 8, value: (r) => at(r.resultTapAt, d(r), tz) },
      { header: 'Truck m from pin at the tap', width: 9, value: (r) => r.truckDistAtResultM },
      { header: 'Left the site (GPS)', width: 8, value: (r) => at(r.siteEndAt, d(r), tz) },
      { header: 'Tap minutes after leaving', width: 8, value: (r) => (r.resultTapAt && r.siteEndAt ? Math.round(((r.resultTapAt.getTime() - r.siteEndAt.getTime()) / 60_000) * 10) / 10 : null) },
      { header: 'Departure RouteIQ holds', width: 8, value: (r) => at(r.departedAt, d(r), tz) },
      { header: 'Departure by', width: 14, value: (r) => source(r.departureSource) },
    ],
    late,
  );

  // Last, so the sheets before keep their places (owner request 20 Oct 2026).
  await sheet<AlertExportRow>(ALERT_SHEET, alertSheetColumns(data), data.alerts);

  return w.finish();
}
