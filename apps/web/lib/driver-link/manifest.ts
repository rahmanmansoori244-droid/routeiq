/**
 * The driver page's data (GET /api/d/manifest, owner request 4 Oct 2026, spec section 6.2): a
 * PROJECTION of getPlanDetail for one truck-day's loads - the same source as the PDF driver sheets,
 * so stops, cases, split labels, promised times and notes cannot drift. Server only.
 *
 * - The plan detail is memoised per plan version for up to 60 s under a stamp read on every request
 *   (load count, newest load row, newest status change and driver change, the plan option in use),
 *   so a dispatch or a driver change shows at once.
 * - It never carries money (cost, fuel, sales value, margin, payment amounts), priorities, other
 *   trucks or other customers.
 * - Results (Part 2) are read live, never memoised.
 * - "Call dispatcher" (owner decision 3, 5 Oct 2026): the number of the depot of the trip the driver
 *   is on or goes on next, else the company number (dispatcherPhoneFor).
 */
import { prisma } from '../db';
import { getPlanDetail, type DetailLoad, type DetailStop, type PlanDetail } from '../dispatch/plan-detail';
import { coordText } from '../dispatch/driver-links';
import { DEFAULT_TZ } from '../dispatch/time';
import { truckDayResults } from '../delivery/event-service';
import { truckDayLoads } from './service';
import { dispatcherPhoneFor } from './dispatcher-phone';
import { DEFAULT_LOCATION_RETENTION_DAYS, DEFAULT_PHOTO_RETENTION_DAYS } from '../settings-fields';
import type { DriverManifest, DriverResults, LoadStatusName, ManifestLoad, ManifestOrder, ManifestStop } from './manifest-types';

export const MANIFEST_MEMO_MS = 60_000;
const MEMO_MAX = 200;

interface Memo {
  stamp: string;
  at: number;
  detail: PlanDetail | null;
}
const memo = ((globalThis as unknown as { __routeiqManifestMemo?: Map<string, Memo> }).__routeiqManifestMemo ??= new Map<string, Memo>());

/** Google Maps directions to the planned pin (the same pin as the sheet). */
export function navUrl(lat: number | null, lng: number | null): string | null {
  return lat !== null && lng !== null && Number.isFinite(lat) && Number.isFinite(lng)
    ? `https://www.google.com/maps/dir/?api=1&destination=${coordText(lat, lng)}&travelmode=driving`
    : null;
}

function ordersOf(s: DetailStop): ManifestOrder[] {
  const out = new Map<string, ManifestOrder>();
  for (const ln of s.orderLines ?? []) {
    const o = out.get(ln.orderId) ?? { orderId: ln.orderId, salesOrders: [], lines: [] };
    if (ln.salesOrderNo && !o.salesOrders.includes(ln.salesOrderNo)) o.salesOrders.push(ln.salesOrderNo);
    o.lines.push({ lineId: ln.lineId, productCode: ln.productCode, productName: ln.productName, cases: ln.cases });
    out.set(ln.orderId, o);
  }
  return [...out.values()];
}

function stopOf(l: DetailLoad, s: DetailStop): ManifestStop {
  return {
    key: `${l.loadNo}:${s.sequence}`,
    sequence: s.sequence,
    customerName: s.customerName,
    customerCode: s.customerCode,
    branchCode: s.branchCode,
    address: s.address,
    lat: s.lat,
    lng: s.lng,
    navUrl: navUrl(s.lat, s.lng),
    etaMin: s.etaMin,
    untilMin: s.departureMin,
    hours: s.plannedHours ?? null,
    promised: s.promisedWindow ?? null,
    cases: s.cases,
    orders: ordersOf(s),
    notes: [...s.notes],
    accessNotes: s.accessNotes,
    split: s.split ? { part: s.split.part, parts: s.split.parts } : null,
    carriedFrom: s.carriedFrom,
    changeNotes: s.masterChanged.map((c) => c.text),
    result: null,
  };
}

export interface ManifestInput {
  truckId: string;
  date: string;
  tz: string;
  serverNow: Date;
  tenantName: string;
  link: { expiresAt: Date; uploadUntil: Date; generation: number };
  truck: { code: string; hired: boolean };
  /** Casual (daily) flag per driver id of the truck-day's loads. */
  casualOf: ReadonlyMap<string, boolean>;
  settings: { radiusM: number; photoRequired: boolean; locationRetentionDays: number; photoRetentionDays: number; dispatcherPhone: string | null };
  office: { userName: string } | null;
}

/**
 * The manifest from the plan details of the truck-day's live plans (normally one). Pure: only the
 * truck's own loads, in departure order; only a DISPATCHED load is actionable.
 */
export function projectManifest(details: readonly PlanDetail[], input: ManifestInput): DriverManifest {
  const loads = details
    .flatMap((d) => d.loads.filter((l) => l.truckId === input.truckId).map((l) => ({ d, l })))
    .sort((a, b) => a.l.departMin - b.l.departMin || a.l.loadNo - b.l.loadNo);
  const trips = loads.length;
  const first = loads[0];
  const depotSource = first?.d ?? details[0];
  const depot = depotSource
    ? { code: depotSource.run.depot.code, name: depotSource.run.depot.name, lat: first?.l.origin?.lat ?? depotSource.run.depot.lat, lng: first?.l.origin?.lng ?? depotSource.run.depot.lng }
    : { code: '', name: '', lat: 0, lng: 0 };
  const drivers = new Map<string, { name: string; casual: boolean }>();
  for (const { l } of loads) {
    if (l.driverId && l.driverName && !drivers.has(l.driverId)) drivers.set(l.driverId, { name: l.driverName, casual: input.casualOf.get(l.driverId) ?? false });
  }
  const manifestLoads: ManifestLoad[] = loads.map(({ l }) => ({
    loadNo: l.loadNo,
    trips,
    status: l.status as LoadStatusName,
    actionable: l.status === 'DISPATCHED',
    departMin: l.departMin,
    returnMin: l.returnMin,
    driverName: l.driverName,
    cases: l.cases,
    backAtDepotAt: null,
    stops: [...l.stops].sort((a, b) => a.sequence - b.sequence).map((s) => stopOf(l, s)),
  }));
  return {
    date: input.date,
    tz: input.tz,
    serverNow: input.serverNow.toISOString(),
    tenantName: input.tenantName,
    link: { expiresAt: input.link.expiresAt.toISOString(), uploadUntil: input.link.uploadUntil.toISOString(), generation: input.link.generation },
    truck: { id: input.truckId, code: first?.l.truckCode ?? input.truck.code, hired: input.truck.hired },
    drivers: [...drivers.values()],
    depot,
    settings: { ...input.settings, maxPhotos: 3 },
    office: input.office,
    loads: manifestLoads,
  };
}

/** The plan detail of one version, memoised for up to 60 s under a stamp of its loads (see the top). */
export async function memoPlanDetail(tenantId: string, runId: string, now: number = Date.now()): Promise<PlanDetail | null> {
  const [agg, run] = await Promise.all([
    prisma.planLoad.aggregate({
      where: { tenantId, runId },
      _count: { _all: true },
      _max: { statusChangedAt: true, driverSetAt: true, createdAt: true },
    }),
    prisma.runPlan.findFirst({ where: { id: runId, tenantId }, select: { chosenScenarioId: true, status: true } }),
  ]);
  if (!run) return null;
  const stamp = [
    agg._count._all,
    agg._max.statusChangedAt?.getTime() ?? 0,
    agg._max.driverSetAt?.getTime() ?? 0,
    agg._max.createdAt?.getTime() ?? 0,
    run.chosenScenarioId ?? '',
    run.status,
  ].join('|');
  const key = `${tenantId}|${runId}`;
  const hit = memo.get(key);
  if (hit && hit.stamp === stamp && now - hit.at < MANIFEST_MEMO_MS) return hit.detail;
  const detail = await getPlanDetail(tenantId, runId);
  memo.delete(key);
  memo.set(key, { stamp, at: now, detail });
  while (memo.size > MEMO_MAX) {
    const oldest = memo.keys().next().value;
    if (oldest === undefined) break;
    memo.delete(oldest);
  }
  return detail;
}

/** Tests only. */
export function _clearManifestMemo(): void {
  memo.clear();
}

/** The manifest of a resolved link (the route reads it on every poll). */
export async function driverManifest(args: {
  tenantId: string;
  truckId: string;
  date: string;
  link: { expiresAt: Date; uploadUntil: Date; generation: number };
  office: { userName: string } | null;
  now: Date;
}): Promise<DriverManifest> {
  const { tenantId, truckId, date } = args;
  const [tenant, cfg, truck, dayLoads] = await Promise.all([
    prisma.tenant.findFirst({ where: { id: tenantId }, select: { name: true } }),
    prisma.tenantConfig.findFirst({
      where: { tenantId },
      select: { timezone: true, geofenceRadiusM: true, photoProofRequired: true, locationRetentionDays: true, photoRetentionDays: true, dispatcherPhone: true },
    }),
    prisma.truck.findFirst({ where: { id: truckId, tenantId }, select: { code: true, hired: true } }),
    truckDayLoads(prisma, tenantId, truckId, date),
  ]);
  const runIds = [...new Set(dayLoads.map((l) => l.runId))];
  const depotIds = [...new Set(dayLoads.map((l) => l.depotId).filter(Boolean))];
  const [details, depots] = await Promise.all([
    Promise.all(runIds.map((id) => memoPlanDetail(tenantId, id, args.now.getTime()))).then((all) => all.filter((d): d is PlanDetail => !!d)),
    depotIds.length ? prisma.depot.findMany({ where: { tenantId, id: { in: depotIds } }, select: { id: true, dispatcherPhone: true } }) : [],
  ]);
  const manifest = projectManifest(details, {
    truckId,
    date,
    tz: cfg?.timezone || DEFAULT_TZ,
    serverNow: args.now,
    tenantName: tenant?.name ?? '',
    link: args.link,
    truck: { code: truck?.code ?? '', hired: !!truck?.hired },
    casualOf: new Map(dayLoads.filter((l) => l.driverId).map((l) => [l.driverId!, l.driverCasual])),
    settings: {
      radiusM: Math.min(500, Math.max(50, cfg?.geofenceRadiusM ?? 100)),
      photoRequired: cfg?.photoProofRequired ?? true,
      locationRetentionDays: cfg?.locationRetentionDays ?? DEFAULT_LOCATION_RETENTION_DAYS,
      // The first-open location notice states both periods (photos 90 days by default, owner decision 1).
      photoRetentionDays: cfg?.photoRetentionDays ?? DEFAULT_PHOTO_RETENTION_DAYS,
      dispatcherPhone: dispatcherPhoneFor(dayLoads, new Map(depots.map((d) => [d.id, d.dispatcherPhone])), cfg?.dispatcherPhone ?? null),
    },
    office: args.office,
  });
  // Results are read live, never memoised (Part 2).
  const depotOf = new Map(dayLoads.map((l) => [l.loadNo, l.depotId]));
  const results = await truckDayResults(
    prisma,
    tenantId,
    truckId,
    date,
    manifest.loads.map((l) => ({
      loadNo: l.loadNo,
      depotId: depotOf.get(l.loadNo) ?? '',
      status: l.status,
      stops: l.stops.map((s) => ({ sequence: s.sequence, orderIds: s.orders.map((o) => o.orderId) })),
    })),
    args.office ? 'OFFICE' : 'DRIVER',
  );
  return mergeResults(manifest, results);
}

/** The manifest with the truck-day's results laid in: each stop's result and each trip's Back at depot. Pure. */
export function mergeResults(manifest: DriverManifest, results: DriverResults): DriverManifest {
  return {
    ...manifest,
    loads: manifest.loads.map((l) => ({
      ...l,
      backAtDepotAt: results.back[String(l.loadNo)] ?? null,
      stops: l.stops.map((s) => ({ ...s, result: results.stops[s.key] ?? null })),
    })),
  };
}
