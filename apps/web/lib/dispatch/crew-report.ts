/**
 * The Crew report (owner request 13 Oct 2026): "management asked to track helpers in each truck. We
 * need to know who were the helpers in each truck and load." One row per load of the plan in use of
 * each depot and day of a range (31 days at most), whatever its status (planned, locked, loading,
 * dispatched, completed): date, depot, truck, trip, load status, driver, helpers 1-3, when it left
 * (the time it was marked Dispatched in RouteIQ, else the planned departure), Back at depot (the
 * driver's tap) when recorded, stops and cases. A second sheet totals each helper's loads, days and
 * trucks. Reads only; every query names the company. No money.
 */
import ExcelJS from 'exceljs';
import type { Prisma } from '@prisma/client';
import { prisma } from '../db';
import { findInParts } from '../in-parts';
import { backAtDepot, backKey, liveRunsInRange } from '../delivery/day-results';
import { shownTruckCode } from './hire';
import { daysBetween, DEFAULT_TZ, fmtHhmm, localDateIso, localMinutes } from './time';
import { CREW_COLUMNS, CREW_MAX_DAYS, helperTotals, NO_DRIVER_TEXT, type CrewRow } from './crew-report-view';

type Db = Prisma.TransactionClient | typeof prisma;

/** The loads that left the depot (their departure is the Dispatch time when it was recorded). */
const LEFT = new Set(['DISPATCHED', 'COMPLETED']);

/** A copied load points to the load it was copied from: at most this many versions are followed. */
const MAX_VERSIONS = 60;

/** "07:12" on the delivery day, "2026-10-12 21:40" on another day (local time of the company). */
export function crewTimeText(at: Date, dateIso: string, tz: string): string {
  const m = localMinutes(at, tz);
  const hhmm = fmtHhmm(m);
  const day = localDateIso(at, tz);
  return day === dateIso ? hhmm : `${day} ${hhmm}`;
}

/**
 * When each load was marked Dispatched: the LOAD_DISPATCHED audit row of the load, or of the load it
 * was copied from in an earlier plan version (a re-plan copies a dispatched load; the dispatch was
 * recorded on the original). The latest row of the nearest load in the chain wins.
 */
async function dispatchedAt(db: Db, tenantId: string, loads: readonly { id: string; carriedFromLoadId: string | null }[]): Promise<Map<string, Date>> {
  const parent = new Map<string, string | null>(loads.map((l) => [l.id, l.carriedFromLoadId]));
  let frontier = [...new Set(loads.map((l) => l.carriedFromLoadId).filter((x): x is string => !!x && !parent.has(x)))];
  for (let i = 0; i < MAX_VERSIONS && frontier.length; i++) {
    const rows = await findInParts(frontier, (part) => db.planLoad.findMany({ where: { tenantId, id: { in: part } }, select: { id: true, carriedFromLoadId: true } }));
    for (const r of rows) parent.set(r.id, r.carriedFromLoadId ?? null);
    for (const id of frontier) if (!parent.has(id)) parent.set(id, null);
    frontier = [...new Set(rows.map((r) => r.carriedFromLoadId).filter((x): x is string => !!x && !parent.has(x)))];
  }
  const audits = await findInParts([...parent.keys()], (part) =>
    db.auditLog.findMany({ where: { tenantId, action: 'LOAD_DISPATCHED', entity: 'PlanLoad', entityId: { in: part } }, select: { entityId: true, createdAt: true } }),
  );
  const latest = new Map<string, Date>();
  for (const a of audits) {
    if (!a.entityId) continue;
    const cur = latest.get(a.entityId);
    if (!cur || a.createdAt > cur) latest.set(a.entityId, a.createdAt);
  }
  const out = new Map<string, Date>();
  for (const l of loads) {
    let id: string | null = l.id;
    for (let i = 0; id && i <= MAX_VERSIONS; i++) {
      const at = latest.get(id);
      if (at) {
        out.set(l.id, at);
        break;
      }
      id = parent.get(id) ?? null;
    }
  }
  return out;
}

/** The report's rows for a range (31 days at most), one depot or every depot; sorted by date, depot, truck, trip. */
export async function readCrewReport(
  tenantId: string,
  range: { from: string; to: string },
  depotId: string | null,
  opts: { db?: Db } = {},
): Promise<{ rows: CrewRow[]; depot: string | null; tz: string }> {
  const db = opts.db ?? prisma;
  if (range.to < range.from || daysBetween(range.from, range.to) + 1 > CREW_MAX_DAYS) throw new Error('range');
  const cfg = await db.tenantConfig.findFirst({ where: { tenantId }, select: { timezone: true } });
  const tz = cfg?.timezone || DEFAULT_TZ;
  const depots = await db.depot.findMany({ where: { tenantId }, select: { id: true, code: true } });
  const depotCode = new Map(depots.map((d) => [d.id, d.code]));
  const depot = depotId ? (depotCode.get(depotId) ?? null) : null;
  const runs = await liveRunsInRange(db, tenantId, range.from, range.to, depotId);
  if (!runs.length) return { rows: [], depot, tz };
  const runOf = new Map(runs.map((r) => [r.id, r]));
  const loads = await findInParts(
    runs.map((r) => r.id),
    (part) =>
      db.planLoad.findMany({
        where: { tenantId, runId: { in: part } },
        select: { id: true, runId: true, truckId: true, loadNo: true, status: true, departMin: true, cases: true, driverId: true, carriedFromLoadId: true, truckSnapshotJson: true },
      }),
  );
  if (!loads.length) return { rows: [], depot, tz };
  const loadIds = loads.map((l) => l.id);
  const truckIds = [...new Set(loads.map((l) => l.truckId))];
  const driverIds = [...new Set(loads.map((l) => l.driverId).filter((x): x is string => !!x))];
  const [trucks, drivers, crew, stopsRows, backs, dispatched] = await Promise.all([
    db.truck.findMany({ where: { tenantId, id: { in: truckIds } }, select: { id: true, code: true, onlyOnDate: true } }),
    driverIds.length ? db.driver.findMany({ where: { tenantId, id: { in: driverIds } }, select: { id: true, name: true } }) : [],
    findInParts(loadIds, (part) =>
      db.planLoadHelper.findMany({ where: { tenantId, loadId: { in: part } }, orderBy: [{ loadId: 'asc' }, { position: 'asc' }], select: { loadId: true, position: true, helper: { select: { name: true } } } }),
    ),
    findInParts(loadIds, (part) => db.routeAssignment.findMany({ where: { loadId: { in: part } }, select: { loadId: true, sequenceInTruck: true } })),
    backAtDepot(db, tenantId, range.from, range.to, depotId),
    dispatchedAt(db, tenantId, loads.filter((l) => LEFT.has(l.status))),
  ]);
  const truckOf = new Map(trucks.map((t) => [t.id, t]));
  const driverName = new Map(drivers.map((d) => [d.id, d.name]));
  const crewOf = new Map<string, { position: number; name: string }[]>();
  for (const h of crew) {
    const list = crewOf.get(h.loadId) ?? [];
    list.push({ position: h.position, name: h.helper.name });
    crewOf.set(h.loadId, list);
  }
  const helpersOf = new Map([...crewOf].map(([id, list]) => [id, list.sort((a, b) => a.position - b.position).map((x) => x.name)]));
  const stopsOf = new Map<string, Set<number>>();
  for (const r of stopsRows) {
    if (!r.loadId) continue;
    const s = stopsOf.get(r.loadId) ?? new Set<number>();
    s.add(r.sequenceInTruck);
    stopsOf.set(r.loadId, s);
  }
  const rows: CrewRow[] = loads.map((l) => {
    const run = runOf.get(l.runId)!;
    const truck = truckOf.get(l.truckId);
    const snapCode = (l.truckSnapshotJson as { code?: string } | null)?.code ?? null;
    const helpers = helpersOf.get(l.id) ?? [];
    const left = dispatched.get(l.id);
    const back = backs.get(backKey({ depotId: run.depotId, date: run.date, truckId: l.truckId, loadNo: l.loadNo }));
    return {
      date: run.date,
      depot: depotCode.get(run.depotId) ?? '?',
      truck: truck ? shownTruckCode(snapCode, truck) : (snapCode ?? '?'),
      trip: l.loadNo,
      status: l.status,
      driver: (l.driverId && driverName.get(l.driverId)) || NO_DRIVER_TEXT,
      helper1: helpers[0] ?? '',
      helper2: helpers[1] ?? '',
      helper3: helpers[2] ?? '',
      departed: left ? crewTimeText(left, run.date, tz) : fmtHhmm(l.departMin),
      departedBasis: left ? 'Dispatched in RouteIQ' : 'Planned',
      backAtDepot: back ? crewTimeText(back, run.date, tz) : '',
      stops: stopsOf.get(l.id)?.size ?? 0,
      cases: l.cases,
    };
  });
  rows.sort((a, b) => a.date.localeCompare(b.date) || a.depot.localeCompare(b.depot) || a.truck.localeCompare(b.truck) || a.trip - b.trip);
  return { rows, depot, tz };
}

export interface CrewMeta {
  tenantName: string;
  from: string;
  to: string;
  /** The depot's code, or null: every depot. */
  depot: string | null;
  generatedAt: Date;
  generatedBy: string;
}

/** The Crew report workbook: "Loads" (one row per load) and "Helpers" (each helper's loads, days, trucks). */
export async function buildCrewWorkbook(rows: readonly CrewRow[], meta: CrewMeta): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'RouteIQ';
  wb.created = meta.generatedAt;
  const ws = wb.addWorksheet('Loads', { views: [{ state: 'frozen', ySplit: 3 }] });
  ws.columns = CREW_COLUMNS.map((c) => ({ key: c.key, width: c.width }));
  ws.getCell(1, 1).value = `${meta.tenantName} · Crew report · ${meta.from === meta.to ? meta.from : `${meta.from} to ${meta.to}`} · ${meta.depot ? `depot ${meta.depot}` : 'every depot'}`;
  ws.getCell(1, 1).font = { bold: true, size: 13 };
  ws.getCell(2, 1).value = `Made ${meta.generatedAt.toISOString().slice(0, 16).replace('T', ' ')} UTC by ${meta.generatedBy}. One row per load of the plan in use. Departed: when the load was marked Dispatched, else the planned departure.`;
  ws.getCell(2, 1).font = { italic: true, color: { argb: 'FF666666' } };
  const head = ws.getRow(3);
  head.values = CREW_COLUMNS.map((c) => c.header);
  head.font = { bold: true };
  ws.autoFilter = { from: { row: 3, column: 1 }, to: { row: 3, column: CREW_COLUMNS.length } };
  if (!rows.length) ws.getCell(4, 1).value = 'No loads in this range.';
  rows.forEach((r, i) => {
    ws.getRow(4 + i).values = CREW_COLUMNS.map((c) => r[c.key]);
  });

  const hs = wb.addWorksheet('Helpers', { views: [{ state: 'frozen', ySplit: 1 }] });
  hs.columns = [
    { header: 'Helper', key: 'helper', width: 24 },
    { header: 'Loads', key: 'loads', width: 8 },
    { header: 'Days', key: 'days', width: 8 },
    { header: 'Trucks', key: 'trucks', width: 40 },
  ];
  hs.getRow(1).font = { bold: true };
  const totals = helperTotals(rows);
  if (!totals.length) hs.addRow({ helper: 'No helpers on these loads.' });
  for (const t of totals) hs.addRow(t);
  return Buffer.from(await wb.xlsx.writeBuffer());
}
