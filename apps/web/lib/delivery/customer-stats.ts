/**
 * The data feed per customer (owner request 4 Oct 2026, spec sections 11.1 and 11.2). Server only.
 *
 * - customerDeliveryStats (GET /api/customers/delivery-stats): the measured unloading time next to the
 *   planned (effective) one, for the customer dialog on Daily dispatch and the Customers page.
 * - pinCheckList (GET /api/customers/pin-check, company admin): the customers whose pin may be wrong.
 *
 * Both read only the visits of the last 365 days; nothing changes by itself (the location lock and
 * "Use measured time" stay with people).
 */
import type { Prisma } from '@prisma/client';
import { prisma } from '../db';
import { effectiveAttrs, type TypeProfileLike } from '../dispatch/customer-attrs';
import { addDaysIso, dateOnly, DEFAULT_TZ, isoOf, todayIso } from '../dispatch/time';
import { MEASURED_MAX_MIN, measuredText, measuredUnloading, type MeasuredUnloading } from './measured';
import { pinCheck, suggestedMapsUrl, type PinVisit } from './pin-check';

type Db = Prisma.TransactionClient | typeof prisma;

/** How far back the per-customer feed looks. */
export const FEED_DAYS = 365;
export const MAX_STATS_IDS = 200;

export interface CustomerDeliveryStats {
  /** The effective base unloading time the plan uses (confirmed, else the type's, else Settings). */
  plannedMin: number;
  plannedSource: 'CUSTOMER' | 'TYPE' | 'DEFAULT';
  measured: MeasuredUnloading | null;
  /** "Unloading: 20 min planned · measured 34 min (median of 7 timed visits, 12 Sep - 3 Oct)". */
  text: string;
}

/** Per customer, the newest timed visits read (room for the outliers measuredUnloading leaves out of its last 10). */
export const TIMED_VISITS_PER_CUSTOMER = 20;
/** Customers read at the same time (each its own small indexed query). */
const STATS_PARALLEL = 8;

/**
 * The newest timed visits of EACH customer (at most TIMED_VISITS_PER_CUSTOMER), one query per
 * customer: a limit shared by many customers would let the busy ones push a monthly customer's
 * visits out, and its measured time would vanish from the Customers page.
 */
async function recentTimedVisits(db: Db, tenantId: string, ids: readonly string[], since: string) {
  const out = new Map<string, Awaited<ReturnType<typeof readOne>>>();
  async function readOne(customerId: string) {
    return db.stopVisit.findMany({
      where: {
        tenantId,
        customerId,
        deliveryDate: { gte: dateOnly(since) },
        outcome: { in: ['DELIVERED', 'PARTLY_DELIVERED'] },
        autoServiceMinutes: { not: null, gte: 1, lte: MEASURED_MAX_MIN },
        timingSuspect: false,
        outcomeLate: false,
      },
      select: { customerId: true, outcome: true, autoServiceMinutes: true, timingSuspect: true, outcomeLate: true, plannedServiceMin: true, casesDelivered: true, autoArrivedAt: true, deliveryDate: true },
      orderBy: [{ autoArrivedAt: 'desc' }],
      take: TIMED_VISITS_PER_CUSTOMER,
    });
  }
  for (let i = 0; i < ids.length; i += STATS_PARALLEL) {
    const part = ids.slice(i, i + STATS_PARALLEL);
    const rows = await Promise.all(part.map(readOne));
    part.forEach((id, k) => out.set(id, rows[k]!));
  }
  return out;
}

export async function customerDeliveryStats(tenantId: string, ids: readonly string[], opts: { db?: Db; now?: Date } = {}): Promise<Record<string, CustomerDeliveryStats>> {
  const db = opts.db ?? prisma;
  const want = [...new Set(ids)].slice(0, MAX_STATS_IDS);
  if (!want.length) return {};
  const cfg = await db.tenantConfig.findFirst({ where: { tenantId }, select: { timezone: true, serviceMinPerCase: true, defaultServiceTimeMin: true } });
  const tz = cfg?.timezone || DEFAULT_TZ;
  const since = addDaysIso(todayIso(tz, opts.now ?? new Date()), -FEED_DAYS);
  const [customers, profiles, visits] = await Promise.all([
    db.customer.findMany({ where: { tenantId, id: { in: want } } }),
    db.customerTypeProfile.findMany({ where: { tenantId } }),
    recentTimedVisits(db, tenantId, want, since),
  ]);
  const prof = new Map<string, TypeProfileLike>(profiles.map((p) => [p.customerType, p]));
  const out: Record<string, CustomerDeliveryStats> = {};
  for (const c of customers) {
    const eff = effectiveAttrs(c, prof, { serviceTimeMin: cfg?.defaultServiceTimeMin ?? 10 });
    const mine = (visits.get(c.id) ?? []).map((v) => ({ ...v, deliveryDate: isoOf(v.deliveryDate) }));
    const measured = measuredUnloading(mine, cfg?.serviceMinPerCase ?? 0);
    out[c.id] = { plannedMin: eff.serviceMin, plannedSource: eff.serviceSource, measured, text: measuredText(eff.serviceMin, measured) };
  }
  return out;
}

/**
 * The Customers page: the measured unloading time of every customer that has one (3 timed visits or
 * more in the last 365 days), with the planned (effective) time. Customers without one are left out.
 */
export async function measuredByCustomer(tenantId: string, opts: { db?: Db; now?: Date } = {}): Promise<Record<string, CustomerDeliveryStats>> {
  const db = opts.db ?? prisma;
  const cfg = await db.tenantConfig.findFirst({ where: { tenantId }, select: { timezone: true } });
  const since = addDaysIso(todayIso(cfg?.timezone || DEFAULT_TZ, opts.now ?? new Date()), -FEED_DAYS);
  const rows = await db.stopVisit.groupBy({
    by: ['customerId'],
    where: { tenantId, deliveryDate: { gte: dateOnly(since) }, outcome: { in: ['DELIVERED', 'PARTLY_DELIVERED'] }, autoServiceMinutes: { not: null }, timingSuspect: false, outcomeLate: false },
    _count: { _all: true },
  });
  const ids = rows.filter((r) => r._count._all >= 3).map((r) => r.customerId);
  const out: Record<string, CustomerDeliveryStats> = {};
  for (let i = 0; i < ids.length; i += MAX_STATS_IDS) Object.assign(out, await customerDeliveryStats(tenantId, ids.slice(i, i + MAX_STATS_IDS), opts));
  for (const [id, s] of Object.entries(out)) if (!s.measured) delete out[id];
  return out;
}

export interface PinCheckRow {
  customerId: string;
  code: string;
  branchCode: string | null;
  name: string;
  /** "412 m (3 Oct)", "wrong location (1 Oct)". */
  far: { date: string; distanceM: number | null; wrongLocation: boolean }[];
  /** "Driver said: wrong location (3 Oct)". */
  wrongLocationDates: string[];
  suggested: { lat: number; lng: number; mapsUrl: string } | null;
}

/** The "Pin may be wrong" list (spec section 11.2). */
export async function pinCheckList(tenantId: string, opts: { db?: Db; now?: Date } = {}): Promise<PinCheckRow[]> {
  const db = opts.db ?? prisma;
  const cfg = await db.tenantConfig.findFirst({ where: { tenantId }, select: { timezone: true } });
  const since = addDaysIso(todayIso(cfg?.timezone || DEFAULT_TZ, opts.now ?? new Date()), -FEED_DAYS);
  const visits = await db.stopVisit.findMany({
    where: { tenantId, deliveryDate: { gte: dateOnly(since) }, timingSuspect: false, OR: [{ outcome: { not: null } }, { photoCount: { gt: 0 } }] },
    select: {
      id: true,
      customerId: true,
      deliveryDate: true,
      plannedLat: true,
      plannedLng: true,
      timingSuspect: true,
      reason: true,
      outcomeLat: true,
      outcomeLng: true,
      outcomeAccuracyM: true,
      outcomeDistanceM: true,
      locationPurgedAt: true,
    },
    orderBy: [{ deliveryDate: 'desc' }],
    take: 20_000,
  });
  if (!visits.length) return [];
  const ids = visits.map((v) => v.id);
  const [photos, arrivals] = await Promise.all([
    db.deliveryPhoto.findMany({
      where: { tenantId, visitId: { in: ids } },
      select: { visitId: true, positionStatus: true, lat: true, lng: true, accuracyM: true, distanceM: true, exifLat: true, exifLng: true, exifDistanceM: true, locationPurgedAt: true },
    }),
    db.stopEvent.findMany({
      where: { tenantId, visitId: { in: ids }, kind: 'ARRIVED', source: 'PHONE_MANUAL' },
      select: { visitId: true, lat: true, lng: true, accuracyM: true, distanceM: true, at: true },
      orderBy: [{ at: 'asc' }],
    }),
  ]);
  // One pass each (never a scan per visit: 20,000 visits x their photos would block the process).
  const photosOf = new Map<string, typeof photos>();
  for (const p of photos) {
    const list = photosOf.get(p.visitId);
    if (list) list.push(p);
    else photosOf.set(p.visitId, [p]);
  }
  const firstManual = new Map<string, (typeof arrivals)[number]>();
  for (const a of arrivals) if (a.visitId && !firstManual.has(a.visitId)) firstManual.set(a.visitId, a); // sorted by time: the first
  const input: PinVisit[] = visits.map((v) => {
    const arr = firstManual.get(v.id);
    return {
      visitId: v.id,
      customerId: v.customerId,
      deliveryDate: isoOf(v.deliveryDate),
      plannedLat: v.plannedLat,
      plannedLng: v.plannedLng,
      timingSuspect: v.timingSuspect,
      reason: v.reason,
      photos: (photosOf.get(v.id) ?? []).map((p) => ({
        positionStatus: p.positionStatus,
        lat: p.lat,
        lng: p.lng,
        accuracyM: p.accuracyM,
        distanceM: p.distanceM,
        exifLat: p.exifLat,
        exifLng: p.exifLng,
        exifDistanceM: p.exifDistanceM,
        purged: !!p.locationPurgedAt,
      })),
      manualArrival: arr ? { lat: arr.lat, lng: arr.lng, accuracyM: arr.accuracyM, distanceM: arr.distanceM, purged: arr.lat === null && arr.distanceM !== null } : null,
      result: v.outcomeDistanceM !== null || v.outcomeLat !== null ? { lat: v.outcomeLat, lng: v.outcomeLng, accuracyM: v.outcomeAccuracyM, distanceM: v.outcomeDistanceM, purged: !!v.locationPurgedAt } : null,
    };
  });
  const customerIds = [...new Set(input.map((v) => v.customerId))];
  const customers = await db.customer.findMany({ where: { tenantId, id: { in: customerIds } }, select: { id: true, code: true, branchCode: true, name: true, lat: true, lng: true } });
  const flags = pinCheck(input, new Map(customers.map((c) => [c.id, { lat: c.lat, lng: c.lng }])));
  const byId = new Map(customers.map((c) => [c.id, c]));
  return flags.flatMap((f) => {
    const c = byId.get(f.customerId);
    if (!c) return [];
    return [
      {
        customerId: c.id,
        code: c.code,
        branchCode: c.branchCode,
        name: c.name,
        far: f.far,
        wrongLocationDates: f.wrongLocationDates,
        suggested: f.suggested ? { ...f.suggested, mapsUrl: suggestedMapsUrl(f.suggested) } : null,
      },
    ];
  });
}
