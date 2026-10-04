/**
 * "Delivery actuals" Excel (owner request 4 Oct 2026, spec section 11.3, D9c): for a day or a range
 * (31 days at most), one row per stop of a load that left (DISPATCHED or COMPLETED) - planned against
 * actual arrival, the window and whether it was kept, planned against actual unloading, the result,
 * the reason, the cases delivered and not, the proof and who recorded it - plus a Summary sheet (the
 * KPIs of spec section 11.4) and a Reasons sheet. Per-driver performance data: PLANNER and above.
 * Money never appears. exceljs, like the dispatch workbook.
 */
import ExcelJS from 'exceljs';
import type { Prisma } from '@prisma/client';
import { prisma } from '../db';
import { daysBetween, fmtHhmm, isoOf, localMinutes } from '../dispatch/time';
import { arrivalIsObserved, arrivedInsideWindow, deliveryKpis, inOutcomeScope, minutesFromDayStart, type DeliveryKpis, type KpiVisit } from './kpis';
import { ACTUALS_MAX_DAYS, actualMinutes, arrivalByText, OUTCOME_LABEL, POSITION_TEXT, reasonLabel, timedByText } from './office-text';
import { keyOfVisit, kpiVisitOf, liveRunsInRange, loadsOfRuns, outcomeSettings, stopsOfLoads, truckDaysWithLinkOrVisit, visitKey, visitsInRange } from './day-results';

type Db = Prisma.TransactionClient | typeof prisma;

export { ACTUALS_MAX_DAYS } from './office-text';

/** One stop row (every value as the sheet shows it; null = empty cell). */
export interface ActualsRow {
  date: string;
  depot: string;
  truck: string;
  hired: string;
  trip: number;
  stop: number;
  customerCode: string;
  branch: string | null;
  customer: string;
  driver: string | null;
  dailyDriver: string;
  plannedEta: string | null;
  window: string | null;
  actualArrival: string | null;
  arrivalBy: string | null;
  insideWindow: string;
  earlyLateMin: number | null;
  plannedUnloadMin: number | null;
  actualUnloadMin: number | null;
  waitingMin: number | null;
  timedBy: string | null;
  unverified: string;
  result: string;
  reason: string | null;
  note: string | null;
  casesPlanned: number;
  casesDelivered: number | null;
  casesNotDelivered: number | null;
  broughtForwardTo: string | null;
  late: string;
  photos: number;
  noPhotoReason: string | null;
  photoLocation: string | null;
  photoDistanceM: number | null;
  arrivalDistanceM: number | null;
  recordedBy: string | null;
  resultTime: string | null;
}

export const ACTUALS_COLUMNS: { key: keyof ActualsRow; header: string; width: number }[] = [
  { key: 'date', header: 'Date', width: 11 },
  { key: 'depot', header: 'Depot', width: 8 },
  { key: 'truck', header: 'Truck', width: 8 },
  { key: 'hired', header: 'Hired', width: 6 },
  { key: 'trip', header: 'Trip', width: 5 },
  { key: 'stop', header: 'Stop', width: 5 },
  { key: 'customerCode', header: 'Customer code', width: 12 },
  { key: 'branch', header: 'Branch', width: 8 },
  { key: 'customer', header: 'Customer', width: 26 },
  { key: 'driver', header: 'Driver', width: 16 },
  { key: 'dailyDriver', header: 'Daily driver', width: 8 },
  { key: 'plannedEta', header: 'Planned ETA', width: 8 },
  { key: 'window', header: 'Window', width: 12 },
  { key: 'actualArrival', header: 'Actual arrival', width: 8 },
  { key: 'arrivalBy', header: 'Arrival by', width: 16 },
  { key: 'insideWindow', header: 'Inside window', width: 8 },
  { key: 'earlyLateMin', header: 'Minutes early(-)/late(+)', width: 10 },
  { key: 'plannedUnloadMin', header: 'Planned unloading min', width: 10 },
  // The plan screen's figure: automatic (from the service start when the truck waited), else the
  // office's or the manual arrival to departure; "Timed by" says which.
  { key: 'actualUnloadMin', header: 'Actual unloading min', width: 12 },
  { key: 'waitingMin', header: 'Waiting before the window (min)', width: 10 },
  { key: 'timedBy', header: 'Timed by', width: 16 },
  { key: 'unverified', header: 'Unverified timing', width: 9 },
  { key: 'result', header: 'Result', width: 14 },
  { key: 'reason', header: 'Reason', width: 22 },
  { key: 'note', header: 'Note', width: 24 },
  { key: 'casesPlanned', header: 'Cases planned', width: 8 },
  { key: 'casesDelivered', header: 'Cases delivered', width: 8 },
  { key: 'casesNotDelivered', header: 'Cases not delivered', width: 8 },
  { key: 'broughtForwardTo', header: 'Brought forward to', width: 11 },
  { key: 'late', header: 'Recorded after the trip closed', width: 9 },
  { key: 'photos', header: 'Photos', width: 6 },
  { key: 'noPhotoReason', header: 'No photo reason', width: 16 },
  { key: 'photoLocation', header: 'Photo location', width: 11 },
  { key: 'photoDistanceM', header: 'Photo distance from pin (m)', width: 10 },
  { key: 'arrivalDistanceM', header: 'Arrival distance from pin (m)', width: 10 },
  { key: 'recordedBy', header: 'Recorded by', width: 18 },
  { key: 'resultTime', header: 'Result time', width: 8 },
];

export interface ActualsMeta {
  tenantName: string;
  from: string;
  to: string;
  depot: string | null;
  generatedAt: Date;
  generatedBy: string;
  kpis: DeliveryKpis;
}

/** The workbook (pure: rows in, bytes out). */
export async function buildActualsWorkbook(rows: readonly ActualsRow[], meta: ActualsMeta): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'RouteIQ';
  wb.created = meta.generatedAt;
  const stops = wb.addWorksheet('Stops', { views: [{ state: 'frozen', ySplit: 1, xSplit: 3 }] });
  stops.columns = ACTUALS_COLUMNS.map((c) => ({ header: c.header, key: c.key, width: c.width }));
  stops.getRow(1).font = { bold: true };
  stops.getRow(1).alignment = { wrapText: true, vertical: 'top' };
  for (const r of rows) stops.addRow(r);
  stops.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: ACTUALS_COLUMNS.length } };

  const k = meta.kpis;
  const sum = wb.addWorksheet('Summary');
  sum.columns = [
    { header: 'Delivery actuals', key: 'a', width: 46 },
    { header: '', key: 'b', width: 22 },
  ];
  sum.getRow(1).font = { bold: true };
  const pct = (v: number | null) => (v === null ? '-' : `${v} %`);
  const lines: [string, string | number][] = [
    ['Company', meta.tenantName],
    ['Days', meta.from === meta.to ? meta.from : `${meta.from} to ${meta.to}`],
    ['Depot', meta.depot ?? 'all'],
    ['Made', `${meta.generatedAt.toISOString().slice(0, 16).replace('T', ' ')} UTC by ${meta.generatedBy}`],
    ['Dispatched stops', k.stops],
    ['With a result', k.withResult],
    ['Delivered in full', k.delivered],
    ['Partly delivered', k.partly],
    ['Not delivered', k.notDelivered],
    ['No result recorded (counted as delivered)', k.noResult],
    ['Delivered in full (of the results)', pct(k.deliveredInFullPct)],
    ['Cases delivered (of the cases with a result)', pct(k.casesDeliveredPct)],
    ['Observed arrivals at stops with a window', k.timedArrivals],
    ['Arrived inside the window', pct(k.insideWindowPct)],
    ['Unloading: measured minus planned, average min', k.avgUnloadDeltaMin === null ? '-' : k.avgUnloadDeltaMin],
    ['No photo: camera failed', k.cameraFailed],
    ['Recorded after the trip closed', k.late],
  ];
  for (const [a, b] of lines) sum.addRow({ a, b });
  sum.addRow({});
  sum.addRow({ a: 'Only observed arrivals count for "inside the window": an arrival found when the page was opened at the shop, or an unverified timing, does not.' });

  const rs = wb.addWorksheet('Reasons');
  rs.columns = [
    { header: 'Reason', key: 'reason', width: 34 },
    { header: 'Stops', key: 'stops', width: 8 },
    { header: 'Cases not delivered', key: 'cases', width: 12 },
  ];
  rs.getRow(1).font = { bold: true };
  for (const r of k.byReason) rs.addRow({ reason: reasonLabel(r.reason), stops: r.stops, cases: r.cases });
  const buf = await wb.xlsx.writeBuffer();
  return Buffer.from(buf as ArrayBuffer);
}

const yesNo = (b: boolean) => (b ? 'Yes' : 'No');

/** One row from a stop and its visit (pure: tests feed it). */
export function actualsRowOf(
  stop: { date: string; depot: string; truck: string; hired: boolean; loadNo: number; sequence: number; customerCode: string; branch: string | null; customer: string; driver: string | null; dailyDriver: boolean; etaMin: number | null; windowStartMin: number | null; windowEndMin: number | null; plannedServiceMin: number | null; casesPlanned: number; broughtForwardTo: string | null },
  v:
    | (KpiVisit & {
        autoBasis: string | null;
        autoMinutes?: number | null;
        departedAt?: Date | string | null;
        departureSource?: string | null;
        departedAtOutcome: boolean;
        outcomeSource: string | null;
        arrivalDistanceM: number | null;
        outcomeAt: Date | null;
        reasonNote: string | null;
        recordedBy: string | null;
      })
    | null,
  photos: readonly { positionStatus: string; distanceM: number | null }[],
  tz: string,
): ActualsRow {
  const window = stop.windowStartMin === null && stop.windowEndMin === null ? null : `${fmtHhmm(stop.windowStartMin ?? 0)}-${stop.windowEndMin === null ? '' : fmtHhmm(stop.windowEndMin)}`;
  const observed = !!v && arrivalIsObserved(v);
  const inside = v ? arrivedInsideWindow(v) : null;
  const arrMin = v?.arrivedAt ? minutesFromDayStart(v.arrivedAt, v.dayStart) : null;
  let earlyLate: number | null = null;
  if (observed && arrMin !== null) {
    if (stop.windowStartMin !== null && arrMin < stop.windowStartMin) earlyLate = arrMin - stop.windowStartMin;
    else if (stop.windowEndMin !== null && arrMin > stop.windowEndMin) earlyLate = arrMin - stop.windowEndMin;
    else if (window) earlyLate = 0;
  }
  const waiting = v?.autoArrivedAt && stop.windowStartMin !== null && v.autoServiceMinutes !== null ? Math.max(0, stop.windowStartMin - minutesFromDayStart(v.autoArrivedAt, v.dayStart)) : null;
  const okPhotos = photos.filter((p) => p.positionStatus === 'OK' && p.distanceM !== null);
  const status = photos.length ? (okPhotos.length ? 'OK' : (photos[0]!.positionStatus ?? '')) : null;
  const notDelivered = v?.outcome && v.casesDelivered !== null ? Math.max(0, v.casesPlanned - v.casesDelivered) : null;
  // The same figure as the plan screen's Unload cell: automatic, else the office's or the manual times.
  const toDate = (d: Date | string | null | undefined) => (d ? new Date(d) : null);
  const actual = v
    ? actualMinutes({
        autoServiceMinutes: v.autoServiceMinutes,
        autoMinutes: v.autoMinutes ?? null,
        arrivedAt: toDate(v.arrivedAt),
        departedAt: toDate(v.departedAt),
        departedAtOutcome: v.departedAtOutcome,
        outcomeSource: v.outcomeSource,
      })
    : { min: null, auto: false };
  const timedBy =
    v && actual.min !== null
      ? timedByText({ autoBasis: actual.auto ? v.autoBasis : null, arrivalSource: v.arrivalSource, departureSource: v.departureSource ?? null, departedAtOutcome: v.departedAtOutcome, outcomeSource: v.outcomeSource }) || null
      : null;
  return {
    date: stop.date,
    depot: stop.depot,
    truck: stop.truck,
    hired: yesNo(stop.hired),
    trip: stop.loadNo,
    stop: stop.sequence,
    customerCode: stop.customerCode,
    branch: stop.branch,
    customer: stop.customer,
    driver: stop.driver,
    dailyDriver: yesNo(stop.dailyDriver),
    plannedEta: stop.etaMin === null ? null : fmtHhmm(stop.etaMin),
    window,
    actualArrival: v?.arrivedAt ? fmtHhmm(localMinutes(new Date(v.arrivedAt), tz)) : null,
    arrivalBy: v?.arrivedAt ? arrivalByText(v.arrivalSource, v.arrivalObserved) || null : null,
    insideWindow: inside === null ? '-' : yesNo(inside),
    earlyLateMin: earlyLate,
    plannedUnloadMin: stop.plannedServiceMin,
    actualUnloadMin: actual.min,
    waitingMin: waiting,
    timedBy,
    unverified: yesNo(!!v?.timingSuspect),
    result: v?.outcome ? (OUTCOME_LABEL[v.outcome] ?? v.outcome) : 'No result',
    reason: v?.outcome && v.outcome !== 'DELIVERED' ? reasonLabel(v.reason) : null,
    note: v?.outcome ? v.reasonNote : null,
    casesPlanned: v?.casesPlanned ?? stop.casesPlanned,
    casesDelivered: v?.outcome ? v.casesDelivered : null,
    casesNotDelivered: notDelivered,
    broughtForwardTo: stop.broughtForwardTo,
    late: yesNo(!!v?.outcomeLate),
    photos: photos.length,
    noPhotoReason: v?.noPhotoReason === 'CAMERA_FAILED' ? 'Camera failed (driver)' : v?.outcome && v.outcome !== 'NOT_DELIVERED' && !photos.length && v.outcomeSource === 'DISPATCHER' ? 'Office result' : null,
    photoLocation: status ? (POSITION_TEXT[status] ?? status) : null,
    photoDistanceM: okPhotos.length ? Math.round(okPhotos[0]!.distanceM!) : null,
    arrivalDistanceM: v?.arrivalDistanceM !== null && v?.arrivalDistanceM !== undefined ? Math.round(v.arrivalDistanceM) : null,
    recordedBy: v?.outcome ? v.recordedBy : null,
    resultTime: v?.outcomeAt ? fmtHhmm(localMinutes(new Date(v.outcomeAt), tz)) : null,
  };
}

/** The rows and KPIs for [from, to] (31 days at most), one depot or all. */
export async function readActuals(tenantId: string, range: { from: string; to: string }, depotId: string | null, opts: { db?: Db } = {}): Promise<{ rows: ActualsRow[]; kpis: DeliveryKpis; depot: string | null }> {
  const db = opts.db ?? prisma;
  if (daysBetween(range.from, range.to) + 1 > ACTUALS_MAX_DAYS || range.to < range.from) throw new Error('range');
  const set = await outcomeSettings(db, tenantId);
  const runs = await liveRunsInRange(db, tenantId, range.from, range.to, depotId);
  const loads = await loadsOfRuns(db, tenantId, runs);
  const depots = await db.depot.findMany({ where: { tenantId }, select: { id: true, code: true } });
  const depotCode = new Map(depots.map((d) => [d.id, d.code]));
  if (!loads.length) return { rows: [], kpis: deliveryKpis([]), depot: depotId ? (depotCode.get(depotId) ?? null) : null };
  const [stopsBy, visits] = await Promise.all([stopsOfLoads(db, loads), visitsInRange(db, tenantId, range.from, range.to, depotId)]);
  const scoped = await truckDaysWithLinkOrVisit(db, tenantId, range.from, range.to, visits);
  const byKey = new Map(visits.map((v) => [keyOfVisit(v), v]));
  const visitIds = visits.map((v) => v.id);
  const [photos, users, carried] = await Promise.all([
    visitIds.length ? db.deliveryPhoto.findMany({ where: { tenantId, visitId: { in: visitIds } }, select: { visitId: true, positionStatus: true, distanceM: true, takenAt: true }, orderBy: [{ takenAt: 'asc' }] }) : [],
    (async () => {
      const ids = [...new Set(visits.map((v) => v.outcomeById).filter((x): x is string => !!x))];
      return ids.length ? db.user.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } }) : [];
    })(),
    (async () => {
      const ids = [...new Set([...stopsBy.values()].flat().flatMap((s) => s.orderIds))];
      return ids.length ? db.order.findMany({ where: { tenantId, id: { in: ids }, carriedToOrderId: { not: null } }, select: { id: true, carriedTo: { select: { deliveryDate: true } } } }) : [];
    })(),
  ]);
  const userName = new Map(users.map((u) => [u.id, u.name]));
  const carriedTo = new Map(carried.map((c) => [c.id, c.carriedTo ? isoOf(c.carriedTo.deliveryDate) : null]));
  const rows: ActualsRow[] = [];
  const kpiStops: (KpiVisit | null)[] = [];
  for (const l of [...loads].sort((a, b) => a.date.localeCompare(b.date) || a.truckCode.localeCompare(b.truckCode) || a.loadNo - b.loadNo)) {
    const inScope = inOutcomeScope(l.date, set.sinceLocal, scoped.has(`${l.date}|${l.truckId}`));
    for (const s of stopsBy.get(l.id) ?? []) {
      const v = byKey.get(visitKey({ depotId: l.depotId, date: l.date, truckId: l.truckId, loadNo: l.loadNo, sequence: s.sequence })) ?? null;
      const kv = v ? kpiVisitOf(v, set.tz) : null;
      if (inScope) kpiStops.push(kv);
      const recordedBy = v?.outcome ? (v.outcomeSource === 'DISPATCHER' ? (v.outcomeById ? (userName.get(v.outcomeById) ?? 'Office') : 'Office') : 'Driver link') : null;
      rows.push(
        actualsRowOf(
          {
            date: l.date,
            depot: depotCode.get(l.depotId) ?? '',
            truck: l.truckCode,
            hired: l.hired,
            loadNo: l.loadNo,
            sequence: s.sequence,
            customerCode: s.customerCode,
            branch: s.branchCode,
            customer: s.customerName,
            driver: l.driverName,
            dailyDriver: l.driverCasual,
            etaMin: s.etaMin,
            windowStartMin: v?.windowStartMin ?? s.windowStartMin,
            windowEndMin: v?.windowEndMin ?? s.windowEndMin,
            plannedServiceMin: v?.plannedServiceMin ?? s.plannedServiceMin,
            casesPlanned: s.casesPlanned,
            broughtForwardTo: s.orderIds.map((id) => carriedTo.get(id)).filter((x): x is string => !!x).sort().at(-1) ?? null,
          },
          v && kv
            ? {
                ...kv,
                autoBasis: v.autoBasis,
                autoMinutes: v.autoMinutes,
                departedAt: v.departedAt,
                departureSource: v.departureSource,
                departedAtOutcome: v.departedAtOutcome,
                outcomeSource: v.outcomeSource,
                arrivalDistanceM: v.arrivalDistanceM,
                outcomeAt: v.outcomeAt,
                reasonNote: v.reasonNote,
                recordedBy,
              }
            : null,
          v ? photos.filter((p) => p.visitId === v.id) : [],
          set.tz,
        ),
      );
    }
  }
  return { rows, kpis: deliveryKpis(kpiStops), depot: depotId ? (depotCode.get(depotId) ?? null) : null };
}
