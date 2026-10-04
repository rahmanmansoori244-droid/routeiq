/**
 * The delivery-outcome retention janitor (owner request 4 Oct 2026, spec section 12.4, D10). Three
 * sweeps, from the in-process janitor loop (at most every 10 min) and the cron route:
 *
 * - purgeOldPhotos: photo BYTES older than photoRetentionDays (default 365) are dropped; the metadata
 *   stays (time, position status, distance). Keyed on the SERVER time `receivedAt`, so a phone with a
 *   wrong clock can neither keep a photo forever nor lose it the next day.
 * - purgeOldLocations: after locationRetentionDays (default 90, never more than the photo retention)
 *   the positions, accuracies, speeds, IP addresses and browser ids of driver events, visits and
 *   photos are erased. Every distance from the pin is kept: the KPIs, the actuals Excel and the pin
 *   check need only distances. The planned pin is company data and stays.
 * - clearIdleCasualDrivers (once a day): a daily driver with no load dated within the last 30 days (or
 *   later) is hidden from the Driver list (active false; the quick add finds and reactivates them by
 *   phone); after locationRetentionDays without a load their phone number is erased (the name stays:
 *   plans and audit rows show it).
 *
 * Each sweep works per company in batches of 200, at most 5 batches, and writes one audit row per
 * company per sweep that changed something. The deletions reach the live database only: Railway's
 * backups keep the old data until they expire (docs/admin.md, SECURITY.md).
 */
import type { Prisma } from '@prisma/client';
import { prisma } from '../db';
import { audit } from '../audit';
import { addDaysIso, dateOnly, DEFAULT_TZ, isoOf, todayIso } from '../dispatch/time';

type Db = Prisma.TransactionClient | typeof prisma;

export const JANITOR_BATCH = 200;
export const JANITOR_MAX_BATCHES = 5;
export const DELIVERY_SWEEP_EVERY_MS = 10 * 60_000;
export const CASUAL_IDLE_DAYS = 30;
const DAY_MS = 24 * 60 * 60_000;

interface TenantRetention {
  tenantId: string;
  photoRetentionDays: number;
  locationRetentionDays: number;
  timezone: string;
}

async function tenants(db: Db): Promise<TenantRetention[]> {
  const rows = await db.tenantConfig.findMany({ select: { tenantId: true, photoRetentionDays: true, locationRetentionDays: true, timezone: true } });
  return rows.map((r) => ({
    tenantId: r.tenantId,
    photoRetentionDays: Math.max(30, r.photoRetentionDays ?? 365),
    // Never kept longer than the photos (spec section 3).
    locationRetentionDays: Math.max(30, Math.min(r.locationRetentionDays ?? 90, r.photoRetentionDays ?? 365)),
    timezone: r.timezone || DEFAULT_TZ,
  }));
}

/** Photo bytes older than the retention (by receivedAt): bytes NULL, purgedAt set. */
export async function purgeOldPhotos(now: Date = new Date(), db: Db = prisma): Promise<{ count: number }> {
  let total = 0;
  for (const t of await tenants(db)) {
    const cutoff = new Date(now.getTime() - t.photoRetentionDays * DAY_MS);
    let count = 0;
    for (let i = 0; i < JANITOR_MAX_BATCHES; i++) {
      const ids = (
        await db.deliveryPhoto.findMany({
          where: { tenantId: t.tenantId, purgedAt: null, receivedAt: { lt: cutoff } },
          orderBy: [{ receivedAt: 'asc' }],
          take: JANITOR_BATCH,
          select: { id: true },
        })
      ).map((p) => p.id);
      if (!ids.length) break;
      const r = await db.deliveryPhoto.updateMany({ where: { tenantId: t.tenantId, id: { in: ids } }, data: { bytes: null, purgedAt: now } });
      count += r.count;
      if (ids.length < JANITOR_BATCH) break;
    }
    if (count > 0) {
      await audit({ tenantId: t.tenantId, userId: null, action: 'DELIVERY_PHOTOS_PURGED', entity: 'Tenant', entityId: t.tenantId, afterJson: { count, olderThanDays: t.photoRetentionDays } as never });
      total += count;
    }
  }
  return { count: total };
}

/** Positions, IPs and browser ids older than the location retention: erased; distances kept. */
export async function purgeOldLocations(now: Date = new Date(), db: Db = prisma): Promise<{ events: number; visits: number; photos: number }> {
  const out = { events: 0, visits: 0, photos: 0 };
  for (const t of await tenants(db)) {
    const cutoff = new Date(now.getTime() - t.locationRetentionDays * DAY_MS);
    const cutoffDay = dateOnly(addDaysIso(todayIso(t.timezone, now), -t.locationRetentionDays));
    const mine = { events: 0, visits: 0, photos: 0 };
    for (let i = 0; i < JANITOR_MAX_BATCHES; i++) {
      const rows = await db.stopEvent.findMany({
        where: {
          tenantId: t.tenantId,
          receivedAt: { lt: cutoff },
          OR: [{ lat: { not: null } }, { lng: { not: null } }, { accuracyM: { not: null } }, { speedMps: { not: null } }, { clientIp: { not: null } }, { deviceId: { not: null } }],
        },
        orderBy: [{ receivedAt: 'asc' }],
        take: JANITOR_BATCH,
        select: { id: true, payloadJson: true },
      });
      if (!rows.length) break;
      const cleared = { lat: null, lng: null, accuracyM: null, speedMps: null, clientIp: null, deviceId: null };
      const withGps = rows.filter((r) => r.payloadJson && typeof r.payloadJson === 'object' && 'gpsAt' in (r.payloadJson as object));
      const plain = rows.filter((r) => !withGps.includes(r)).map((r) => r.id);
      if (plain.length) mine.events += (await db.stopEvent.updateMany({ where: { tenantId: t.tenantId, id: { in: plain } }, data: cleared })).count;
      for (const r of withGps) {
        const { gpsAt: _gone, ...rest } = r.payloadJson as Record<string, unknown>;
        void _gone;
        await db.stopEvent.updateMany({ where: { tenantId: t.tenantId, id: r.id }, data: { ...cleared, payloadJson: rest as Prisma.InputJsonValue } });
        mine.events++;
      }
      if (rows.length < JANITOR_BATCH) break;
    }
    for (let i = 0; i < JANITOR_MAX_BATCHES; i++) {
      const ids = (await db.stopVisit.findMany({ where: { tenantId: t.tenantId, deliveryDate: { lt: cutoffDay }, locationPurgedAt: null }, take: JANITOR_BATCH, select: { id: true } })).map((v) => v.id);
      if (!ids.length) break;
      mine.visits += (
        await db.stopVisit.updateMany({ where: { tenantId: t.tenantId, id: { in: ids } }, data: { outcomeLat: null, outcomeLng: null, outcomeAccuracyM: null, arrivalAccuracyM: null, locationPurgedAt: now } })
      ).count;
      if (ids.length < JANITOR_BATCH) break;
    }
    for (let i = 0; i < JANITOR_MAX_BATCHES; i++) {
      const ids = (
        await db.deliveryPhoto.findMany({ where: { tenantId: t.tenantId, receivedAt: { lt: cutoff }, locationPurgedAt: null }, orderBy: [{ receivedAt: 'asc' }], take: JANITOR_BATCH, select: { id: true } })
      ).map((p) => p.id);
      if (!ids.length) break;
      mine.photos += (
        await db.deliveryPhoto.updateMany({
          where: { tenantId: t.tenantId, id: { in: ids } },
          data: { lat: null, lng: null, accuracyM: null, exifLat: null, exifLng: null, clientIp: null, deviceId: null, locationPurgedAt: now },
        })
      ).count;
      if (ids.length < JANITOR_BATCH) break;
    }
    const count = mine.events + mine.visits + mine.photos;
    if (count > 0) {
      await audit({ tenantId: t.tenantId, userId: null, action: 'DELIVERY_LOCATIONS_PURGED', entity: 'Tenant', entityId: t.tenantId, afterJson: { count, ...mine, olderThanDays: t.locationRetentionDays } as never });
    }
    out.events += mine.events;
    out.visits += mine.visits;
    out.photos += mine.photos;
  }
  return out;
}

/**
 * Daily drivers without a load: hidden after 30 days, phone erased after the location retention. The
 * last load is the newest delivery date of any load (any plan version) with that driver; a driver on
 * no load at all counts from the day they were added (their CASUAL_DRIVER_ADDED audit row).
 */
export async function clearIdleCasualDrivers(now: Date = new Date(), db: Db = prisma): Promise<{ deactivated: number; phonesCleared: number }> {
  const out = { deactivated: 0, phonesCleared: 0 };
  for (const t of await tenants(db)) {
    const drivers = await db.driver.findMany({ where: { tenantId: t.tenantId, casual: true, OR: [{ active: true }, { phone: { not: null } }] }, select: { id: true, active: true, phone: true } });
    if (!drivers.length) continue;
    const ids = drivers.map((d) => d.id);
    const [loads, added] = await Promise.all([
      db.planLoad.findMany({ where: { tenantId: t.tenantId, driverId: { in: ids } }, select: { driverId: true, run: { select: { runDate: true } } } }),
      db.auditLog.findMany({ where: { tenantId: t.tenantId, action: 'CASUAL_DRIVER_ADDED', entityId: { in: ids } }, select: { entityId: true, createdAt: true } }),
    ]);
    const today = todayIso(t.timezone, now);
    const last = new Map<string, string>();
    const note = (id: string | null, d: string) => {
      if (!id) return;
      if (!last.has(id) || last.get(id)! < d) last.set(id, d);
    };
    for (const l of loads) if (l.run?.runDate) note(l.driverId, isoOf(l.run.runDate));
    for (const a of added) if (!last.has(a.entityId ?? '')) note(a.entityId, isoOf(a.createdAt));
    const hideBefore = addDaysIso(today, -CASUAL_IDLE_DAYS);
    const eraseBefore = addDaysIso(today, -t.locationRetentionDays);
    const mine = { deactivated: 0, phonesCleared: 0 };
    for (const d of drivers.slice(0, JANITOR_BATCH * JANITOR_MAX_BATCHES)) {
      const at = last.get(d.id);
      if (!at) continue; // unknown age: never touched
      const data: { active?: boolean; phone?: null } = {};
      if (d.active && at < hideBefore) data.active = false;
      if (d.phone && at < eraseBefore) data.phone = null;
      if (!Object.keys(data).length) continue;
      await db.driver.updateMany({ where: { tenantId: t.tenantId, id: d.id }, data });
      if (data.active === false) mine.deactivated++;
      if (data.phone === null) mine.phonesCleared++;
    }
    if (mine.deactivated || mine.phonesCleared) {
      await audit({ tenantId: t.tenantId, userId: null, action: 'CASUAL_DRIVERS_CLEARED', entity: 'Tenant', entityId: t.tenantId, afterJson: { ...mine, idleDays: CASUAL_IDLE_DAYS, phoneAfterDays: t.locationRetentionDays } as never });
    }
    out.deactivated += mine.deactivated;
    out.phonesCleared += mine.phonesCleared;
  }
  return out;
}

const g = globalThis as unknown as { __routeiqDeliverySweepAt?: number; __routeiqCasualSweepDay?: string };

/**
 * The three sweeps, at most every 10 min (the daily-driver clean-up once a day). `force`: the cron
 * route runs them now.
 */
export async function runDeliveryJanitor(now: Date = new Date(), opts: { force?: boolean } = {}) {
  if (!opts.force && g.__routeiqDeliverySweepAt && now.getTime() - g.__routeiqDeliverySweepAt < DELIVERY_SWEEP_EVERY_MS) return null;
  g.__routeiqDeliverySweepAt = now.getTime();
  const photos = await purgeOldPhotos(now);
  const locations = await purgeOldLocations(now);
  const dayKey = now.toISOString().slice(0, 10);
  let casual: { deactivated: number; phonesCleared: number } | null = null;
  if (opts.force || g.__routeiqCasualSweepDay !== dayKey) {
    g.__routeiqCasualSweepDay = dayKey;
    casual = await clearIdleCasualDrivers(now);
  }
  return { photos, locations, casual };
}
