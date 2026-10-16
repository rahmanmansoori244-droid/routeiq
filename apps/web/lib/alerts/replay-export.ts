/**
 * Operations alerts (owner request 16 Oct 2026): one company's delivery day saved for the replay
 * (replay.ts). Server only and READ ONLY: every statement is a SELECT, and scripts/alerts-replay.ts runs
 * it inside a `SET TRANSACTION READ ONLY` transaction, so even a mistake cannot write. Every query names
 * the company or takes ids read for it.
 *
 * What it saves: the plan in use of the date (every depot, or one), each load with its status moves
 * (the LOAD_<status> audit rows of the load and of the loads it was copied from: a
 * re-plan copies loads, the moves were recorded on the version that was in use then), its Back at depot
 * and Leaving for next load taps, its planned stops (priority, verified pin) with their visits' events and photos (times,
 * distances and the few payload keys the visit rebuild reads), and each truck-day's first and last page
 * open. Never a position, an IP, a device id or a phone number. It does hold customer names and driver
 * notes: the file must stay outside the repository (the script refuses a path inside it), and running it
 * on production data needs the owner's OK.
 */
import type { Prisma } from '@prisma/client';
import { prisma } from '../db';
import { findInParts } from '../in-parts';
import { dateOnly, isoOf } from '../dispatch/time';
import { echoedWindowRule } from '../dispatch/window-rule';
import { parseLoadBreak, readTruckSnapshot } from '../dispatch/snapshots';
import { readDevices } from '../driver-link/service';
import { keyOfVisit, liveRunsInRange, loadsOfRuns, stopsOfLoads, visitKey } from '../delivery/day-results';
import { pinCheckList } from '../delivery/customer-stats';
import { LOAD_STATUS_NAMES } from '../audit-catalog';
import { ALERT_THRESHOLD_COLUMNS, type AlertConfig } from './catalog';
import { pinMovedSince } from './facts';
import { ALERT_EXPORT_KIND, type AlertDayExport, type ExportEvent, type ExportLoad, type ExportPhoto, type ExportStop } from './replay';

type Db = Prisma.TransactionClient | typeof prisma;

/** The payload keys deriveVisit reads (never the photo keys, the lines or a GPS time). */
const PAYLOAD_KEYS = ['outcome', 'reason', 'note', 'late', 'observed', 'gap', 'resumed', 'chained', 'noPhotoReason', 'coerced'] as const;
const MAX_VERSIONS = 60;

function payloadOf(json: unknown): Record<string, unknown> | null {
  if (!json || typeof json !== 'object') return null;
  const src = json as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const k of PAYLOAD_KEYS) if (k in src) out[k] = src[k];
  return Object.keys(out).length ? out : null;
}

function eventOf(e: { kind: string; source: string; at: Date; receivedAt: Date; distanceM: number | null; accuracyM: number | null; payloadJson: unknown }): ExportEvent {
  return { kind: e.kind, source: e.source, at: e.at.toISOString(), receivedAt: e.receivedAt.toISOString(), distanceM: e.distanceM, accuracyM: e.accuracyM, payload: payloadOf(e.payloadJson) };
}

/** The status moves of each load: its own audit rows and those of the loads it was copied from. */
async function statusHistory(db: Db, tenantId: string, loads: readonly { id: string; carriedFromLoadId: string | null }[]): Promise<Map<string, { status: string; at: string }[]>> {
  const parent = new Map<string, string | null>(loads.map((l) => [l.id, l.carriedFromLoadId]));
  let frontier = [...new Set(loads.map((l) => l.carriedFromLoadId).filter((x): x is string => !!x && !parent.has(x)))];
  for (let i = 0; i < MAX_VERSIONS && frontier.length; i++) {
    const rows = await findInParts(frontier, (part) => db.planLoad.findMany({ where: { tenantId, id: { in: part } }, select: { id: true, carriedFromLoadId: true } }));
    for (const r of rows) parent.set(r.id, r.carriedFromLoadId ?? null);
    for (const id of frontier) if (!parent.has(id)) parent.set(id, null);
    frontier = [...new Set(rows.map((r) => r.carriedFromLoadId).filter((x): x is string => !!x && !parent.has(x)))];
  }
  const actions = LOAD_STATUS_NAMES.map((s) => `LOAD_${s}`);
  const audits = await findInParts([...parent.keys()], (part) =>
    db.auditLog.findMany({ where: { tenantId, entity: 'PlanLoad', entityId: { in: part }, action: { in: actions } }, select: { entityId: true, action: true, createdAt: true } }),
  );
  const byLoad = new Map<string, { status: string; at: string }[]>();
  for (const a of audits) {
    if (!a.entityId) continue;
    const list = byLoad.get(a.entityId) ?? [];
    list.push({ status: a.action.slice('LOAD_'.length), at: a.createdAt.toISOString() });
    byLoad.set(a.entityId, list);
  }
  const out = new Map<string, { status: string; at: string }[]>();
  for (const l of loads) {
    const all: { status: string; at: string }[] = [];
    let id: string | null = l.id;
    for (let i = 0; id && i <= MAX_VERSIONS; i++) {
      all.push(...(byLoad.get(id) ?? []));
      id = parent.get(id) ?? null;
    }
    out.set(l.id, all.sort((a, b) => a.at.localeCompare(b.at)));
  }
  return out;
}

/** One company's delivery day for the replay (read only; see the file comment). */
export async function exportAlertDay(db: Db, tenantId: string, date: string, opts: { depotId?: string | null; now?: Date } = {}): Promise<AlertDayExport> {
  const now = opts.now ?? new Date();
  const cfg = await db.tenantConfig.findFirst({
    where: { tenantId },
    select: { timezone: true, alertsEnabled: true, alertsEnabledAt: true, alertDeliveredNote: true, ...Object.fromEntries(ALERT_THRESHOLD_COLUMNS.map((c) => [c, true])) } as Record<string, true>,
  });
  if (!cfg) throw new Error('No settings for this company.');
  const tz = (cfg as unknown as { timezone: string }).timezone;
  const runs = await liveRunsInRange(db, tenantId, date, date, opts.depotId ?? null);
  const loads = await loadsOfRuns(db, tenantId, runs, { statuses: ['PLANNED', 'LOCKED', 'LOADING', 'DISPATCHED', 'COMPLETED'] });
  const ids = loads.map((l) => l.id);
  const left = loads.filter((l) => l.status === 'DISPATCHED' || l.status === 'COMPLETED');
  const extra = await findInParts(ids, (part) => db.planLoad.findMany({ where: { tenantId, id: { in: part } }, select: { id: true, truckSnapshotJson: true, carriedFromLoadId: true } }));
  const [rowsOfPlan, planned, history] = await Promise.all([
    findInParts(ids, (part) => db.routeAssignment.findMany({ where: { loadId: { in: part } }, select: { loadId: true, sequenceInTruck: true, orderId: true, serviceStartMin: true, departureMin: true }, orderBy: [{ sequenceInTruck: 'asc' }, { orderInStop: 'asc' }] })),
    stopsOfLoads(db, left),
    statusHistory(db, tenantId, extra),
  ]);
  const day = dateOnly(date);
  const depotWhere = opts.depotId ? { depotId: opts.depotId } : {};
  const [visits, events, links] = await Promise.all([
    db.stopVisit.findMany({ where: { tenantId, deliveryDate: day, ...depotWhere } }),
    db.stopEvent.findMany({
      where: { tenantId, deliveryDate: day, ...depotWhere },
      select: { visitId: true, depotId: true, truckId: true, loadNo: true, sequence: true, kind: true, source: true, at: true, receivedAt: true, distanceM: true, accuracyM: true, payloadJson: true },
    }),
    db.driverLink.findMany({ where: { tenantId, deliveryDate: day }, select: { truckId: true, lastSeenAt: true, devicesJson: true } }),
  ]);
  const photos = await findInParts(
    visits.map((v) => v.id),
    (part) =>
      db.deliveryPhoto.findMany({
        where: { tenantId, visitId: { in: part } },
        select: { visitId: true, source: true, positionStatus: true, distanceM: true, accuracyM: true, exifDistanceM: true, receivedAt: true, takenAt: true, oldPhoto: true },
      }),
  );
  const orderIds = [...new Set(rowsOfPlan.map((r) => r.orderId))];
  const customerIds = [...new Set([...planned.values()].flat().map((s) => s.customerId))];
  const [orders, customers, flagged] = await Promise.all([
    findInParts(orderIds, (part) => db.order.findMany({ where: { tenantId, id: { in: part } }, select: { id: true, priority: true } })),
    findInParts(customerIds, (part) => db.customer.findMany({ where: { tenantId, id: { in: part } }, select: { id: true, locationVerified: true, lat: true, lng: true } })),
    pinCheckList(tenantId, { db, now, customerIds }),
  ]);
  const prio = new Map(orders.map((o) => [o.id, o.priority]));
  const verified = new Set(customers.filter((c) => c.locationVerified).map((c) => c.id));
  const pinNow = new Map(customers.map((c) => [c.id, c]));
  const pinWrong = new Set(flagged.map((f) => f.customerId));
  const extraOf = new Map(extra.map((x) => [x.id, x]));
  const visitOf = new Map(visits.map((v) => [keyOfVisit(v), v]));
  const eventsOf = new Map<string, ExportEvent[]>();
  const backOf = new Map<string, ExportEvent[]>();
  const departOf = new Map<string, ExportEvent[]>();
  for (const e of events) {
    const ev = eventOf(e);
    if (e.kind === 'BACK_AT_DEPOT' || e.kind === 'DEPOT_DEPART') {
      const k = `${e.depotId}|${e.truckId}|${e.loadNo}`;
      const into = e.kind === 'BACK_AT_DEPOT' ? backOf : departOf;
      into.set(k, [...(into.get(k) ?? []), ev]);
    } else if (e.visitId) eventsOf.set(e.visitId, [...(eventsOf.get(e.visitId) ?? []), ev]);
  }
  const photosOf = new Map<string, ExportPhoto[]>();
  for (const p of photos) {
    const ph: ExportPhoto = {
      source: p.source,
      positionStatus: p.positionStatus,
      distanceM: p.distanceM,
      accuracyM: p.accuracyM,
      exifDistanceM: p.exifDistanceM,
      receivedAt: p.receivedAt.toISOString(),
      takenAt: p.takenAt.toISOString(),
      oldPhoto: p.oldPhoto,
    };
    photosOf.set(p.visitId, [...(photosOf.get(p.visitId) ?? []), ph]);
  }

  const outLoads: ExportLoad[] = loads.map((l) => {
    const x = extraOf.get(l.id);
    const own = rowsOfPlan.filter((r) => r.loadId === l.id);
    const brk = parseLoadBreak(l.breakJson);
    const stops: ExportStop[] = (planned.get(l.id) ?? []).map((s) => {
      const at = own.filter((r) => r.sequenceInTruck === s.sequence);
      const ps = at.map((r) => prio.get(r.orderId)).filter((p): p is number => typeof p === 'number');
      const v = visitOf.get(visitKey({ depotId: l.depotId, date: l.date, truckId: l.truckId, loadNo: l.loadNo, sequence: s.sequence }));
      return {
        sequence: s.sequence,
        customerId: s.customerId,
        customerCode: s.customerCode,
        branchCode: s.branchCode,
        customerName: s.customerName,
        etaMin: s.etaMin,
        serviceStartMin: at[0]?.serviceStartMin ?? null,
        departureMin: at[0]?.departureMin ?? null,
        plannedServiceMin: s.plannedServiceMin,
        windowStartMin: s.windowStartMin,
        windowEndMin: s.windowEndMin,
        priority: ps.length ? Math.min(...ps) : null,
        pinVerified: verified.has(s.customerId) && !pinWrong.has(s.customerId),
        pinMoved: pinMovedSince(v ?? null, pinNow.get(s.customerId) ?? null),
        visit: v
          ? { plannedServiceMin: v.plannedServiceMin, windowStartMin: v.windowStartMin, windowEndMin: v.windowEndMin, casesPlanned: v.casesPlanned, events: eventsOf.get(v.id) ?? [], photos: photosOf.get(v.id) ?? [] }
          : null,
      };
    });
    return {
      id: l.id,
      depotId: l.depotId,
      truckId: l.truckId,
      truckCode: l.truckCode,
      loadNo: l.loadNo,
      departMin: l.departMin,
      returnMin: l.returnMin,
      windowRule: echoedWindowRule(readTruckSnapshot(x?.truckSnapshotJson ?? null)?.rules?.windowRule) ?? 'START',
      breakMin: brk ? { startMin: brk.startMin, endMin: brk.endMin } : null,
      finalStatus: l.status,
      stopCount: new Set(own.map((r) => r.sequenceInTruck)).size,
      history: history.get(l.id) ?? [],
      backEvents: backOf.get(`${l.depotId}|${l.truckId}|${l.loadNo}`) ?? [],
      departEvents: departOf.get(`${l.depotId}|${l.truckId}|${l.loadNo}`) ?? [],
      stops,
    };
  });
  const truckDays = links
    .filter((x) => loads.some((l) => l.truckId === x.truckId))
    .map((x) => {
      const firsts = readDevices(x.devicesJson).map((d) => d.first).filter((s) => !Number.isNaN(Date.parse(s))).sort();
      return { truckId: x.truckId, firstSeenAt: firsts[0] ?? (x.lastSeenAt ? x.lastSeenAt.toISOString() : null), lastSeenAt: x.lastSeenAt ? x.lastSeenAt.toISOString() : null };
    });
  const config = Object.fromEntries(Object.entries(cfg).filter(([k]) => k !== 'timezone')) as Partial<AlertConfig>;
  return { v: 1, kind: ALERT_EXPORT_KIND, date: isoOf(day), tz, exportedAt: now.toISOString(), config, loads: outLoads, truckDays };
}
