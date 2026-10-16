/**
 * IVMS live link (16 Oct 2026): everything the ingest side (the poller, the webhook, the backstop) reads
 * and writes in the database, behind one interface so the orchestration (lib/ivms/poll.ts,
 * lib/ivms/webhook.ts) is tested on an in-memory store and this file on PostgreSQL
 * (tests/integration/ivms-ingest-db.spec.ts).
 *
 * Every statement names the company (tenantId): the background work runs outside a session, like the
 * other janitor sweeps. The IMEI and the depot zone are read by name (lib/db.ts omits them everywhere
 * else). Never a provider object name, plate or driver: those never reach this file.
 *
 * The daily allowance (IvmsState, one row per company, critique H2 / M13):
 * - the counters are per call class and per UTC day; any write that finds yesterday's day resets every
 *   daily counter first (the provider's day);
 * - a background tick takes the company's LEASE first (one container at a time, also during a deploy
 *   overlap), renews it with each call and releases it at the end; the lease also refuses while a backoff
 *   (nextTryAt) runs;
 * - a call is CLAIMED before it is made: one UPDATE that checks the lease, the class's share, the whole
 *   allowance and (for the paced classes) the wait since the last call, and counts it. No row = no call.
 *   Two containers can therefore never go over the allowance, and a restart never forgets a call;
 * - the admin's picker claims without the lease (budget only), so it never waits on the poller.
 */
import { randomUUID } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { prisma } from '../db';
import { addDaysIso, dateOnly, isoOf, todayIso } from '../dispatch/time';
import { liveRunsInRange } from '../delivery/day-results';
import type { LoadStatusName } from '../dispatch/load-state';
import { utcDay } from './budget';
import { MAX_EVENTS_PER_TRUCK_DAY, type DepotZone, type NewZoneEvent } from './events';
import { ivmsModeOf } from './settings';
import { CALL_CLASS_COUNTER, MOVING_KMH, type AyunErrorKind, type IvmsCallClass, type IvmsMode, type LiveFix, type TrailPoint } from './types';

/** The company the Ayun account belongs to (AYUN_TENANT_SLUG) and its IVMS settings. */
export interface IvmsCompany {
  tenantId: string;
  slug: string;
  timezone: string;
  mode: IvmsMode;
  pollSec: number;
  routePullMin: number;
  fromMin: number;
  toMin: number;
  dailyBudget: number;
  trailDays: number;
}

export interface FleetLoad {
  loadNo: number;
  status: LoadStatusName;
  /** For a COMPLETED load: when it was completed. */
  statusChangedAt: Date | null;
}

/** One delivery date of a truck with a tracker: its loads on the plans in use. */
export interface FleetTruckDay {
  /** The delivery date, YYYY-MM-DD. */
  date: string;
  loads: FleetLoad[];
}

/** An active, own (not one-day) truck with a tracker, and its loads of yesterday and today. */
export interface FleetTruck {
  truckId: string;
  imei: string;
  depotId: string;
  days: FleetTruckDay[];
}

/** IvmsState as a tick reads it, after the day rollover. */
export interface IvmsStateRow {
  usageDay: string;
  mapCalls: number;
  routeCalls: number;
  eventCalls: number;
  adminCalls: number;
  mapLastAt: Date | null;
  eventsLastAt: Date | null;
  failures: number;
  lastError: string | null;
}

/** IvmsTruckDay: how far a truck-day's history is pulled. */
export interface TruckDayRow {
  truckId: string;
  date: string;
  pulledTo: Date | null;
  lastPullAt: Date | null;
  pulls: number;
  finalPullAt: Date | null;
  suppressedAt: Date | null;
}

export type WebhookCounter = 'webhooksToday' | 'webhooksIgnored' | 'webhooksBadTime';

export interface ClaimLimits {
  /** The class's share of the day (budget.ts classShares). */
  share: number;
  /** The whole daily allowance. */
  budget: number;
  leaseMs: number;
  /** MAP / EVENTS: no claim before this many seconds after the class's last call (null: no wait). */
  minGapSec?: number | null;
}

export interface IvmsStore {
  company(slug: string): Promise<IvmsCompany | null>;
  fleet(c: IvmsCompany, now: Date): Promise<FleetTruck[]>;
  depotZones(tenantId: string): Promise<DepotZone[]>;
  truckByImei(tenantId: string, imei: string): Promise<{ truckId: string; depotId: string } | null>;
  /** Take (or renew) the lease; null while another tick holds it or a backoff runs. */
  acquireLease(tenantId: string, owner: string, now: Date, leaseMs: number): Promise<IvmsStateRow | null>;
  /** Count one background call of `cls` if the lease, the share, the allowance and the wait allow it. */
  claim(tenantId: string, owner: string, cls: Exclude<IvmsCallClass, 'ADMIN'>, now: Date, limits: ClaimLimits): Promise<boolean>;
  /** Count one admin call (the tracker and zone pickers): budget only, no lease (M13). */
  claimAdmin(tenantId: string, now: Date, limits: Pick<ClaimLimits, 'share' | 'budget'>): Promise<boolean>;
  releaseLease(tenantId: string, owner: string, now: Date): Promise<void>;
  recordOk(tenantId: string, now: Date, skewSec?: number | null): Promise<void>;
  /** A failed call: its kind (a code only); with `nextTryAt` a backoff starts and the failure is counted. */
  recordFailure(tenantId: string, now: Date, kind: AyunErrorKind, nextTryAt: Date | null): Promise<void>;
  /** The latest live fix per truck: moved forward only by a newer fix. The number written. */
  writePositions(tenantId: string, rows: readonly { truckId: string; fix: LiveFix }[], now: Date): Promise<number>;
  /** Delete the live positions of every tracked truck of the company except these (no load out: M7). */
  clearPositions(tenantId: string, keepTruckIds: readonly string[]): Promise<number>;
  truckDays(tenantId: string, keys: readonly { truckId: string; date: string }[]): Promise<TruckDayRow[]>;
  /** Add history points (the same fix twice is one row). The number of new rows. */
  writeTrail(tenantId: string, truckId: string, points: readonly TrailPoint[]): Promise<number>;
  markPulled(tenantId: string, truckId: string, date: string, p: { pulledTo: Date; final: boolean; now: Date }): Promise<void>;
  insertZoneEvents(tenantId: string, rows: readonly NewZoneEvent[], now: Date): Promise<{ inserted: number; duplicates: number; capped: number }>;
  bumpWebhookCounter(tenantId: string, field: WebhookCounter, now: Date): Promise<void>;
}

// ---------------------------------------------------------------------------------------------------
// PostgreSQL

const DAILY_COUNTERS = ['mapCalls', 'routeCalls', 'eventCalls', 'adminCalls', 'webhooksToday', 'webhooksIgnored', 'webhooksBadTime'] as const;
const col = (name: string) => Prisma.raw(`"${name}"`);

/** SET items that reset every daily counter when the row is from an earlier UTC day (except `skip`). */
function rollover(day: string, skip: string | null = null): Prisma.Sql {
  const items = DAILY_COUNTERS.filter((c) => c !== skip).map((c) => Prisma.sql`${col(c)} = CASE WHEN "usageDay" = ${day}::date THEN ${col(c)} ELSE 0 END`);
  return Prisma.join([...items, Prisma.sql`"usageDay" = ${day}::date`], ', ');
}

async function ensureStateRow(tenantId: string, now: Date): Promise<void> {
  await prisma.$executeRaw`INSERT INTO "IvmsState" ("tenantId", "usageDay", "updatedAt") VALUES (${tenantId}, ${utcDay(now)}::date, ${now}) ON CONFLICT ("tenantId") DO NOTHING`;
}

const LOAD_STATUSES: LoadStatusName[] = ['PLANNED', 'LOCKED', 'LOADING', 'DISPATCHED', 'COMPLETED'];

export const prismaIvmsStore: IvmsStore = {
  async company(slug) {
    const t = await prisma.tenant.findUnique({
      where: { slug },
      select: {
        id: true,
        slug: true,
        active: true,
        config: {
          select: {
            timezone: true,
            ivmsMode: true,
            ivmsPollSec: true,
            ivmsRoutePullMin: true,
            ivmsFromMin: true,
            ivmsToMin: true,
            ivmsDailyCallBudget: true,
            ivmsTrailDays: true,
          },
        },
      },
    });
    if (!t || !t.active || !t.config) return null;
    const c = t.config;
    return {
      tenantId: t.id,
      slug: t.slug,
      timezone: c.timezone,
      mode: ivmsModeOf(c),
      pollSec: c.ivmsPollSec,
      routePullMin: c.ivmsRoutePullMin,
      fromMin: c.ivmsFromMin,
      toMin: c.ivmsToMin,
      dailyBudget: c.ivmsDailyCallBudget,
      trailDays: c.ivmsTrailDays,
    };
  },

  async fleet(c, now) {
    const trucks = await prisma.truck.findMany({
      where: { tenantId: c.tenantId, active: true, onlyOnDate: null, ivmsImei: { not: null } },
      select: { id: true, depotId: true, ivmsImei: true },
      orderBy: { id: 'asc' },
    });
    if (!trucks.length) return [];
    const today = todayIso(c.timezone, now);
    const runs = await liveRunsInRange(prisma, c.tenantId, addDaysIso(today, -1), today);
    const dateOf = new Map(runs.map((r) => [r.id, r.date]));
    const loads = runs.length
      ? await prisma.planLoad.findMany({
          where: { tenantId: c.tenantId, runId: { in: runs.map((r) => r.id) }, truckId: { in: trucks.map((t) => t.id) }, status: { in: LOAD_STATUSES as never } },
          select: { runId: true, truckId: true, loadNo: true, status: true, statusChangedAt: true },
          orderBy: [{ truckId: 'asc' }, { loadNo: 'asc' }],
        })
      : [];
    return trucks.map((t) => {
      const days = new Map<string, FleetLoad[]>();
      for (const l of loads) {
        if (l.truckId !== t.id) continue;
        const date = dateOf.get(l.runId);
        if (!date) continue;
        if (!days.has(date)) days.set(date, []);
        days.get(date)!.push({ loadNo: l.loadNo, status: l.status as LoadStatusName, statusChangedAt: l.statusChangedAt ?? null });
      }
      return {
        truckId: t.id,
        imei: t.ivmsImei!,
        depotId: t.depotId,
        days: [...days.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([date, ls]) => ({ date, loads: ls })),
      };
    });
  },

  async depotZones(tenantId) {
    const rows = await prisma.depot.findMany({ where: { tenantId, ivmsZoneName: { not: null } }, select: { id: true, lat: true, lng: true, ivmsZoneName: true } });
    return rows.map((d) => ({ depotId: d.id, zoneName: d.ivmsZoneName!, lat: d.lat, lng: d.lng }));
  },

  async truckByImei(tenantId, imei) {
    const t = await prisma.truck.findFirst({ where: { tenantId, ivmsImei: imei, active: true, onlyOnDate: null }, select: { id: true, depotId: true } });
    return t ? { truckId: t.id, depotId: t.depotId } : null;
  },

  async acquireLease(tenantId, owner, now, leaseMs) {
    await ensureStateRow(tenantId, now);
    const day = utcDay(now);
    const rows = await prisma.$queryRaw<(Omit<IvmsStateRow, 'usageDay'> & { usageDay: string })[]>`
      UPDATE "IvmsState" SET ${rollover(day)}, "leaseUntil" = ${new Date(now.getTime() + leaseMs)}, "leaseOwner" = ${owner}, "updatedAt" = ${now}
      WHERE "tenantId" = ${tenantId}
        AND ("leaseUntil" IS NULL OR "leaseUntil" < ${now} OR "leaseOwner" = ${owner})
        AND ("nextTryAt" IS NULL OR "nextTryAt" <= ${now})
      RETURNING to_char("usageDay", 'YYYY-MM-DD') AS "usageDay", "mapCalls", "routeCalls", "eventCalls", "adminCalls", "mapLastAt", "eventsLastAt", "failures", "lastError"`;
    return rows[0] ?? null;
  },

  async claim(tenantId, owner, cls, now, limits) {
    const counter = col(CALL_CLASS_COUNTER[cls]);
    const lastAt = cls === 'MAP' ? col('mapLastAt') : cls === 'EVENTS' ? col('eventsLastAt') : null;
    const gap =
      lastAt && limits.minGapSec != null ? Prisma.sql`AND (${lastAt} IS NULL OR ${lastAt} <= ${new Date(now.getTime() - limits.minGapSec * 1000)})` : Prisma.empty;
    const setLast = lastAt ? Prisma.sql`, ${lastAt} = ${now}` : Prisma.empty;
    const rows = await prisma.$queryRaw<{ n: number }[]>`
      UPDATE "IvmsState" SET ${counter} = ${counter} + 1${setLast}, "leaseUntil" = ${new Date(now.getTime() + limits.leaseMs)}, "updatedAt" = ${now}
      WHERE "tenantId" = ${tenantId} AND "leaseOwner" = ${owner} AND "leaseUntil" >= ${now}
        AND "usageDay" = ${utcDay(now)}::date
        AND ${counter} < ${limits.share}
        AND ("mapCalls" + "routeCalls" + "eventCalls" + "adminCalls") < ${limits.budget}
        ${gap}
      RETURNING ${counter} AS n`;
    return rows.length === 1;
  },

  async claimAdmin(tenantId, now, limits) {
    await ensureStateRow(tenantId, now);
    const day = utcDay(now);
    const rows = await prisma.$queryRaw<{ n: number }[]>`
      UPDATE "IvmsState" SET ${rollover(day, 'adminCalls')}, "adminCalls" = (CASE WHEN "usageDay" = ${day}::date THEN "adminCalls" ELSE 0 END) + 1, "updatedAt" = ${now}
      WHERE "tenantId" = ${tenantId}
        AND NOT ("lastError" = 'LIMIT' AND "nextTryAt" IS NOT NULL AND "nextTryAt" > ${now})
        AND (CASE WHEN "usageDay" = ${day}::date THEN "adminCalls" ELSE 0 END) < ${limits.share}
        AND (CASE WHEN "usageDay" = ${day}::date THEN "mapCalls" + "routeCalls" + "eventCalls" + "adminCalls" ELSE 0 END) < ${limits.budget}
      RETURNING "adminCalls" AS n`;
    return rows.length === 1;
  },

  async releaseLease(tenantId, owner, now) {
    await prisma.$executeRaw`UPDATE "IvmsState" SET "leaseUntil" = NULL, "leaseOwner" = NULL, "updatedAt" = ${now} WHERE "tenantId" = ${tenantId} AND "leaseOwner" = ${owner}`;
  },

  async recordOk(tenantId, now, skewSec = null) {
    await prisma.$executeRaw`
      UPDATE "IvmsState" SET "lastOkAt" = ${now}, "failures" = 0, "nextTryAt" = NULL,
        "providerSkewSec" = COALESCE(${skewSec}::integer, "providerSkewSec"), "updatedAt" = ${now}
      WHERE "tenantId" = ${tenantId}`;
  },

  async recordFailure(tenantId, now, kind, nextTryAt) {
    const backoff = nextTryAt !== null;
    await prisma.$executeRaw`
      UPDATE "IvmsState" SET "lastError" = ${kind}, "lastErrorAt" = ${now},
        "failures" = CASE WHEN ${backoff} THEN "failures" + 1 ELSE "failures" END,
        "nextTryAt" = CASE WHEN ${backoff} THEN ${nextTryAt ?? now}::timestamptz ELSE "nextTryAt" END, "updatedAt" = ${now}
      WHERE "tenantId" = ${tenantId}`;
  },

  async writePositions(tenantId, rows, now) {
    let n = 0;
    for (const { truckId, fix } of rows) {
      const movedAt = fix.speedKmh !== null && fix.speedKmh >= MOVING_KMH ? fix.fixAt : null;
      n += await prisma.$executeRaw`
        INSERT INTO "TruckPosition" ("id", "tenantId", "truckId", "fixAt", "serverAt", "receivedAt", "lat", "lng", "speedKmh", "heading", "ignition", "flags", "movedAt")
        VALUES (${randomUUID()}, ${tenantId}, ${truckId}, ${fix.fixAt}, ${fix.serverAt}, ${now}, ${fix.lat}, ${fix.lng}, ${fix.speedKmh}::double precision,
                ${fix.heading}::integer, ${fix.ignition}::boolean, ${[...fix.flags]}::text[], ${movedAt}::timestamptz)
        ON CONFLICT ("truckId") DO UPDATE SET
          "fixAt" = EXCLUDED."fixAt", "serverAt" = EXCLUDED."serverAt", "receivedAt" = EXCLUDED."receivedAt",
          "lat" = EXCLUDED."lat", "lng" = EXCLUDED."lng", "speedKmh" = EXCLUDED."speedKmh", "heading" = EXCLUDED."heading",
          "ignition" = EXCLUDED."ignition", "flags" = EXCLUDED."flags", "movedAt" = COALESCE(EXCLUDED."movedAt", "TruckPosition"."movedAt")
        WHERE "TruckPosition"."tenantId" = EXCLUDED."tenantId" AND "TruckPosition"."fixAt" < EXCLUDED."fixAt"`;
    }
    return n;
  },

  async clearPositions(tenantId, keepTruckIds) {
    const r = await prisma.truckPosition.deleteMany({ where: { tenantId, ...(keepTruckIds.length ? { truckId: { notIn: [...keepTruckIds] } } : {}) } });
    return r.count;
  },

  async truckDays(tenantId, keys) {
    if (!keys.length) return [];
    const rows = await prisma.ivmsTruckDay.findMany({
      where: { tenantId, truckId: { in: [...new Set(keys.map((k) => k.truckId))] }, deliveryDate: { in: [...new Set(keys.map((k) => k.date))].map(dateOnly) } },
      select: { truckId: true, deliveryDate: true, pulledTo: true, lastPullAt: true, pulls: true, finalPullAt: true, suppressedAt: true },
    });
    return rows.map((r) => ({ truckId: r.truckId, date: isoOf(r.deliveryDate), pulledTo: r.pulledTo, lastPullAt: r.lastPullAt, pulls: r.pulls, finalPullAt: r.finalPullAt, suppressedAt: r.suppressedAt }));
  },

  async writeTrail(tenantId, truckId, points) {
    let n = 0;
    for (let i = 0; i < points.length; i += 1000) {
      const part = points.slice(i, i + 1000);
      n += (
        await prisma.truckTrailPoint.createMany({
          data: part.map((p) => ({ tenantId, truckId, fixAt: p.fixAt, lat: p.lat, lng: p.lng, speedKmh: p.speedKmh, ignition: p.ignition })),
          skipDuplicates: true,
        })
      ).count;
    }
    return n;
  },

  async markPulled(tenantId, truckId, date, p) {
    const deliveryDate = dateOnly(date);
    await prisma.ivmsTruckDay.upsert({
      where: { tenantId_truckId_deliveryDate: { tenantId, truckId, deliveryDate } },
      create: { tenantId, truckId, deliveryDate, pulledTo: p.pulledTo, lastPullAt: p.now, pulls: 1, finalPullAt: p.final ? p.now : null },
      update: { pulledTo: p.pulledTo, lastPullAt: p.now, pulls: { increment: 1 }, finalPullAt: p.final ? p.now : null },
    });
  },

  async insertZoneEvents(tenantId, rows, now) {
    const out = { inserted: 0, duplicates: 0, capped: 0 };
    const dayStart = new Date(`${utcDay(now)}T00:00:00.000Z`);
    const counts = new Map<string, number>();
    for (const r of rows) {
      if (!counts.has(r.truckId)) counts.set(r.truckId, await prisma.ivmsEvent.count({ where: { tenantId, truckId: r.truckId, receivedAt: { gte: dayStart } } }));
      if (counts.get(r.truckId)! >= MAX_EVENTS_PER_TRUCK_DAY) {
        out.capped++;
        continue;
      }
      try {
        await prisma.ivmsEvent.create({ data: { tenantId, ...r, receivedAt: now } });
        out.inserted++;
        counts.set(r.truckId, counts.get(r.truckId)! + 1);
      } catch (e) {
        if ((e as { code?: unknown } | null)?.code === 'P2002') out.duplicates++;
        else throw e;
      }
    }
    return out;
  },

  async bumpWebhookCounter(tenantId, field, now) {
    await ensureStateRow(tenantId, now);
    const day = utcDay(now);
    await prisma.$executeRaw`
      UPDATE "IvmsState" SET ${rollover(day, field)}, ${col(field)} = (CASE WHEN "usageDay" = ${day}::date THEN ${col(field)} ELSE 0 END) + 1, "updatedAt" = ${now}
      WHERE "tenantId" = ${tenantId}`;
  },
};
