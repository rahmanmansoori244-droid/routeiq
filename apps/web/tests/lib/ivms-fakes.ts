/**
 * Test helpers for the IVMS live link (16 Oct 2026): an in-memory IvmsStore with the same rules as the
 * PostgreSQL one (lib/ivms/store.ts: day rollover, lease, per-class share, whole allowance, wait since the
 * last call, newer-fix-only positions, unique trail fixes, unique event keys, the per-truck-day event cap),
 * and a fake Ayun that answers like the GPS-Server.net user API 1.x. Invented data only: the vendor
 * documentation's dummy IMEIs, an invented origin (10.5 N, 20.5 E), made-up ids. Not a spec file.
 */
import { utcDay } from '@/lib/ivms/budget';
import { readIvmsEnv, type IvmsEnv } from '@/lib/ivms/env';
import { MAX_EVENTS_PER_TRUCK_DAY, type DepotZone, type NewZoneEvent } from '@/lib/ivms/events';
import type { ClaimLimits, FleetTruck, IvmsCompany, IvmsStateRow, IvmsStore, TruckDayRow, WebhookCounter } from '@/lib/ivms/store';
import type { GpsTimesSummary } from '@/lib/ivms/stop-events';
import { CALL_CLASS_COUNTER, MOVING_KMH, type AyunErrorKind, type IvmsCallClass, type LiveFix, type TrailPoint } from '@/lib/ivms/types';

export const IMEI_A = '111111111111111';
export const IMEI_B = '222222222222222';
/** More invented IMEIs, built at run time (no literal digit runs in the specs). */
export const imeiOf = (i: number) => `${'7'.repeat(13)}${String(i).padStart(2, '0')}`;
export const ORIGIN = { lat: 10.5, lng: 20.5 };
export const SECRET = 'S'.repeat(20) + '_example-secret-0';
export const KEY = 'test-key-abcdef';

/** The variables of a configured link (an invented provider origin). */
export function ivmsTestEnv(extra: Record<string, string | undefined> = {}): IvmsEnv {
  return readIvmsEnv({
    NODE_ENV: 'test',
    AYUN_BASE_URL: 'https://provider.example',
    AYUN_API_KEY: KEY,
    AYUN_TENANT_SLUG: 'example-co',
    AYUN_WEBHOOK_SECRET: SECRET,
    ...extra,
  } as NodeJS.ProcessEnv);
}

export function company(extra: Partial<IvmsCompany> = {}): IvmsCompany {
  return {
    tenantId: 'tA',
    slug: 'example-co',
    timezone: 'Asia/Muscat',
    mode: 'MAP',
    pollSec: 60,
    routePullMin: 60,
    fromMin: 300,
    toMin: 1380,
    dailyBudget: 100,
    trailDays: 2,
    ...extra,
  };
}

type FullState = IvmsStateRow & {
  leaseUntil: Date | null;
  leaseOwner: string | null;
  nextTryAt: Date | null;
  lastOkAt: Date | null;
  lastErrorAt: Date | null;
  providerSkewSec: number | null;
  webhooksToday: number;
  webhooksIgnored: number;
  webhooksBadTime: number;
};

export class MemoryIvmsStore implements IvmsStore {
  companyRow: IvmsCompany | null;
  fleetOf: (now: Date) => FleetTruck[] = () => [];
  depots: DepotZone[] = [];
  state: FullState | null = null;
  positions = new Map<string, { fix: LiveFix; receivedAt: Date; movedAt: Date | null }>();
  trail = new Map<string, Map<number, TrailPoint>>();
  days = new Map<string, TruckDayRow>();
  events: (NewZoneEvent & { tenantId: string; receivedAt: Date })[] = [];
  /** Every store call by name (the OFF tests: nothing at all beyond the company). */
  touched: string[] = [];
  /** The calls each class was allowed (claimed), with when. */
  claims: { cls: IvmsCallClass; at: Date }[] = [];
  /** When the processing step (TIMES) ran, and what it answers (a test may run the real one). */
  processed: Date[] = [];
  processImpl: (tenantId: string, now: Date) => Promise<GpsTimesSummary> = async () => ({ truckDays: 0, written: 0, corrected: 0, busy: 0, failed: 0, skipped: null });

  constructor(c: IvmsCompany | null = company()) {
    this.companyRow = c;
  }

  private rollover(s: FullState, day: string) {
    if (s.usageDay === day) return;
    s.usageDay = day;
    s.mapCalls = s.routeCalls = s.eventCalls = s.adminCalls = 0;
    s.webhooksToday = s.webhooksIgnored = s.webhooksBadTime = 0;
  }

  private ensure(now: Date): FullState {
    this.state ??= {
      usageDay: utcDay(now),
      mapCalls: 0,
      routeCalls: 0,
      eventCalls: 0,
      adminCalls: 0,
      mapLastAt: null,
      eventsLastAt: null,
      failures: 0,
      lastError: null,
      leaseUntil: null,
      leaseOwner: null,
      nextTryAt: null,
      lastOkAt: null,
      lastErrorAt: null,
      providerSkewSec: null,
      webhooksToday: 0,
      webhooksIgnored: 0,
      webhooksBadTime: 0,
    };
    return this.state;
  }

  async company(slug: string) {
    this.touched.push('company');
    return this.companyRow && this.companyRow.slug === slug ? this.companyRow : null;
  }
  async fleet(_c: IvmsCompany, now: Date) {
    this.touched.push('fleet');
    return this.fleetOf(now);
  }
  async depotZones() {
    this.touched.push('depotZones');
    return this.depots;
  }
  async truckByImei(_t: string, imei: string) {
    this.touched.push('truckByImei');
    const t = this.fleetOf(new Date()).find((x) => x.imei === imei);
    return t ? { truckId: t.truckId, depotId: t.depotId } : null;
  }
  async acquireLease(_t: string, owner: string, now: Date, leaseMs: number) {
    this.touched.push('acquireLease');
    const s = this.ensure(now);
    if (s.leaseUntil && s.leaseUntil.getTime() >= now.getTime() && s.leaseOwner !== owner) return null;
    if (s.nextTryAt && s.nextTryAt.getTime() > now.getTime()) return null;
    this.rollover(s, utcDay(now));
    s.leaseUntil = new Date(now.getTime() + leaseMs);
    s.leaseOwner = owner;
    const { usageDay, mapCalls, routeCalls, eventCalls, adminCalls, mapLastAt, eventsLastAt, failures, lastError } = s;
    return { usageDay, mapCalls, routeCalls, eventCalls, adminCalls, mapLastAt, eventsLastAt, failures, lastError };
  }
  async claim(_t: string, owner: string, cls: Exclude<IvmsCallClass, 'ADMIN'>, now: Date, limits: ClaimLimits) {
    this.touched.push(`claim:${cls}`);
    const s = this.ensure(now);
    if (s.leaseOwner !== owner || !s.leaseUntil || s.leaseUntil.getTime() < now.getTime() || s.usageDay !== utcDay(now)) return false;
    const key = CALL_CLASS_COUNTER[cls];
    if (s[key] >= limits.share) return false;
    if (s.mapCalls + s.routeCalls + s.eventCalls + s.adminCalls >= limits.budget) return false;
    const last = cls === 'MAP' ? s.mapLastAt : cls === 'EVENTS' ? s.eventsLastAt : null;
    if (limits.minGapSec != null && last && last.getTime() > now.getTime() - limits.minGapSec * 1000) return false;
    s[key]++;
    if (cls === 'MAP') s.mapLastAt = now;
    if (cls === 'EVENTS') s.eventsLastAt = now;
    s.leaseUntil = new Date(now.getTime() + limits.leaseMs);
    this.claims.push({ cls, at: now });
    return true;
  }
  async claimAdmin(_t: string, now: Date, limits: Pick<ClaimLimits, 'share' | 'budget'>) {
    const s = this.ensure(now);
    this.rollover(s, utcDay(now));
    if (s.lastError === 'LIMIT' && s.nextTryAt && s.nextTryAt.getTime() > now.getTime()) return false;
    if (s.adminCalls >= limits.share || s.mapCalls + s.routeCalls + s.eventCalls + s.adminCalls >= limits.budget) return false;
    s.adminCalls++;
    this.claims.push({ cls: 'ADMIN', at: now });
    return true;
  }
  async releaseLease(_t: string, owner: string) {
    this.touched.push('releaseLease');
    const s = this.state;
    if (s && s.leaseOwner === owner) {
      s.leaseOwner = null;
      s.leaseUntil = null;
    }
  }
  async recordOk(_t: string, now: Date, skewSec: number | null = null) {
    const s = this.ensure(now);
    s.lastOkAt = now;
    s.failures = 0;
    s.nextTryAt = null;
    if (skewSec !== null) s.providerSkewSec = skewSec;
  }
  async recordFailure(_t: string, now: Date, kind: AyunErrorKind, nextTryAt: Date | null) {
    const s = this.ensure(now);
    s.lastError = kind;
    s.lastErrorAt = now;
    if (nextTryAt) {
      s.failures++;
      s.nextTryAt = nextTryAt;
    }
  }
  async writePositions(_t: string, rows: readonly { truckId: string; fix: LiveFix }[], now: Date) {
    this.touched.push('writePositions');
    let n = 0;
    for (const { truckId, fix } of rows) {
      const old = this.positions.get(truckId);
      if (old && old.fix.fixAt.getTime() >= fix.fixAt.getTime()) continue;
      const moved = fix.speedKmh !== null && fix.speedKmh >= MOVING_KMH ? fix.fixAt : null;
      this.positions.set(truckId, { fix, receivedAt: now, movedAt: moved ?? old?.movedAt ?? null });
      n++;
    }
    return n;
  }
  async clearPositions(_t: string, keep: readonly string[]) {
    this.touched.push('clearPositions');
    let n = 0;
    for (const id of [...this.positions.keys()]) {
      if (!keep.includes(id)) {
        this.positions.delete(id);
        n++;
      }
    }
    return n;
  }
  async truckDays(_t: string, keys: readonly { truckId: string; date: string }[]) {
    return keys.map((k) => this.days.get(`${k.truckId}|${k.date}`)).filter((r): r is TruckDayRow => !!r);
  }
  async writeTrail(_t: string, truckId: string, points: readonly TrailPoint[]) {
    this.touched.push('writeTrail');
    const m = this.trail.get(truckId) ?? new Map<number, TrailPoint>();
    this.trail.set(truckId, m);
    let n = 0;
    for (const p of points) {
      if (m.has(p.fixAt.getTime())) continue;
      m.set(p.fixAt.getTime(), p);
      n++;
    }
    return n;
  }
  async markPulled(_t: string, truckId: string, date: string, p: { pulledTo: Date; final: boolean; now: Date }) {
    const k = `${truckId}|${date}`;
    const old = this.days.get(k);
    this.days.set(k, {
      truckId,
      date,
      pulledTo: p.pulledTo,
      lastPullAt: p.now,
      pulls: (old?.pulls ?? 0) + 1,
      finalPullAt: p.final ? p.now : null,
      suppressedAt: old?.suppressedAt ?? null,
    });
  }
  async insertZoneEvents(tenantId: string, rows: readonly NewZoneEvent[], now: Date) {
    this.touched.push('insertZoneEvents');
    const out = { inserted: 0, duplicates: 0, capped: 0 };
    const dayStart = new Date(`${utcDay(now)}T00:00:00.000Z`).getTime();
    for (const r of rows) {
      if (this.events.filter((e) => e.truckId === r.truckId && e.receivedAt.getTime() >= dayStart).length >= MAX_EVENTS_PER_TRUCK_DAY) {
        out.capped++;
        continue;
      }
      if (this.events.some((e) => e.tenantId === tenantId && e.dedupeKey === r.dedupeKey)) {
        out.duplicates++;
        continue;
      }
      this.events.push({ ...r, tenantId, receivedAt: now });
      out.inserted++;
    }
    return out;
  }
  async processTimes(tenantId: string, now: Date) {
    this.touched.push('processTimes');
    this.processed.push(now);
    return this.processImpl(tenantId, now);
  }
  async bumpWebhookCounter(_t: string, field: WebhookCounter, now: Date) {
    this.touched.push(`bump:${field}`);
    const s = this.ensure(now);
    this.rollover(s, utcDay(now));
    s[field]++;
  }
}

const pad = (n: number) => String(n).padStart(2, '0');
/** A provider time (UTC "YYYY-MM-DD HH:MM:SS"). */
export function providerTime(d: Date): string {
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
}
/** "20261016050000" -> the instant. */
function compact(t: string): Date {
  return new Date(Date.UTC(+t.slice(0, 4), +t.slice(4, 6) - 1, +t.slice(6, 8), +t.slice(8, 10), +t.slice(10, 12), +t.slice(12, 14)));
}

export type FakeReply = { status?: number; body: string; headers?: Record<string, string> };

/**
 * A fake Ayun: answers OBJECT_GET_LOCATIONS (a fresh fix near the origin per IMEI asked for, every value a
 * string), OBJECT_GET_ROUTE (a point a minute over the window, at most 30), OBJECT_GET_LAST_EVENTS ([])
 * and the listings ([]) unless `override` answers first. Records every call (the command only, never the
 * key: it is checked apart).
 */
export function fakeAyun(clock: () => Date, override?: (cmd: string, args: string[]) => FakeReply | undefined) {
  const calls: { cmd: string; args: string[]; url: string; init?: RequestInit }[] = [];
  const f = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    const u = new URL(url);
    const [cmd, ...args] = (u.searchParams.get('cmd') ?? '').split(',');
    calls.push({ cmd: cmd!, args, url, init });
    const o = override?.(cmd!, args);
    if (o) return new Response(o.body, { status: o.status ?? 200, headers: o.headers });
    const now = clock();
    if (cmd === 'OBJECT_GET_LOCATIONS') {
      const imeis = args[0] === '*' ? [] : (args[0] ?? '').split(';');
      const body: Record<string, unknown> = {};
      imeis.forEach((imei, i) => {
        body[imei] = {
          name: `Example object ${i}`,
          dt_server: providerTime(new Date(now.getTime() - 5_000)),
          dt_tracker: providerTime(new Date(now.getTime() - 10_000)),
          lat: (ORIGIN.lat + i * 0.01).toFixed(6),
          lng: (ORIGIN.lng + i * 0.01).toFixed(6),
          altitude: '10',
          angle: '90',
          speed: '30',
          params: { acc: '1' },
          loc_valid: '1',
        };
      });
      return new Response(JSON.stringify(Object.keys(body).length ? body : []), { status: 200 });
    }
    if (cmd === 'OBJECT_GET_ROUTE') {
      const from = compact(args[1]!).getTime();
      const to = compact(args[2]!).getTime();
      const route: unknown[] = [];
      for (let t = from, i = 0; t <= to && i < 30; t += 60_000, i++) {
        route.push([providerTime(new Date(t)), (ORIGIN.lat + i * 0.001).toFixed(6), ORIGIN.lng.toFixed(6), '10', '0', String(i % 2 ? 30 : 0), { acc: '1' }]);
      }
      return new Response(JSON.stringify({ route, stops: [], drives: [], events: [] }), { status: 200 });
    }
    return new Response('[]', { status: 200 });
  };
  return { fetch: f as unknown as typeof fetch, calls };
}
