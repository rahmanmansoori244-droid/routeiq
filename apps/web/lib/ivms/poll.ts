/**
 * IVMS live link (16 Oct 2026): the background calls to Ayun for the one company the account belongs to
 * (AYUN_TENANT_SLUG). Started from the in-process janitor (lib/jobs/janitor-loop.ts) on its own 15 s
 * timer, so a slow provider never delays the reaper, the returned-loads sweep or the retention; also run
 * by the cron route (`force`). Nothing at all happens while ivmsMode is OFF, the variables are not set,
 * or ROUTEIQ_DISABLE_IVMS=1: no call, no write (the timer is not even started without the variables).
 *
 * One tick, when something is due:
 * 1. Who is out. Only trucks with a tracker and a load out (LOCKED, LOADING or DISPATCHED on yesterday's
 *    or today's plan in use) are ever asked about (M7); after the operating hours only those with a
 *    DISPATCHED load. Nothing out: no call, and every live position of the company is deleted.
 * 2. The lease (lib/ivms/state in store.ts): one container at a time; a backoff refuses it.
 * 3. MAP (mode MAP and TIMES): one OBJECT_GET_LOCATIONS for those trucks' IMEIs, paced to the MAP share
 *    of the allowance (budget.ts). The fixes update the map's latest position per truck - and nothing
 *    else: live positions are never a source of times (H5). A stale fix stays what it is (the map shows
 *    its age), a fix whose clock runs ahead never moves the latest position forward.
 * 4. ROUTE (mode TIMES): OBJECT_GET_ROUTE per truck-day, from the operating hours' start of the delivery
 *    date: every ivmsRoutePullMin (30-60 min; longer when the ROUTE share would not last) while a load of
 *    that day is out, and once more, over the whole day, 10 minutes after its last load was completed
 *    (late buffered points included). The points are the trail (TruckTrailPoint), the only source of GPS
 *    arrival and departure times (H5); a suppressed truck-day (undo, mismatch) is not pulled.
 * 5. EVENTS (an allowance of 1,000 a day or more and a webhook secret set): every 15 min one
 *    OBJECT_GET_LAST_EVENTS, the backstop for missed depot webhooks; the same rows and keys as the webhook.
 * 6. The lease is released (M13: the admin's picker never waits behind it).
 * A failed call is counted (the provider counts it) and starts a backoff: doubling up to 15 min; the
 * allowance used up (LIMIT) waits for the provider's midnight; a wrong key (AUTH) an hour. Only kind codes
 * are stored and logged, never a URL, a key or an answer.
 *
 * What happens to the trail and the depot moves afterwards (trips by depot OUT/IN, stop times, H3/H4) is
 * the processing step's (lib/ivms/process.ts): it works on the truck-days whose IvmsTruckDay.lastPullAt is
 * newer than their processedAt. This file never writes a stop event, a result or a load status.
 */
import { randomUUID } from 'node:crypto';
import { callAyun, ROUTE_MAX_WINDOW_MS, type AyunCallOptions } from './ayun-client';
import {
  backoffUntil,
  callDue,
  classShares,
  eventsBackstopOn,
  EVENTS_EVERY_SEC,
  horizonSec,
  inOperatingHours,
  IVMS_LEASE_MS,
  IVMS_TICK_MS,
  mapIntervalSec,
  MAX_ROUTE_PULLS_PER_TICK,
  nextOpsStartOf,
  opsStartOf,
  routePullEveryMin,
  transientKind,
  type OperatingHours,
} from './budget';
import { ivmsApiReady, readIvmsEnv, type IvmsEnv } from './env';
import { zoneEventRow } from './events';
import { parseLastEvents, parseLocations, parseRoute, providerSkewSec } from './parse';
import { prismaIvmsStore, type FleetTruck, type IvmsCompany, type IvmsStateRow, type IvmsStore, type TruckDayRow } from './store';
import type { AyunErrorKind, IvmsMode } from './types';

/** The provider's minimum stop for history pulls: RouteIQ detects stops itself, so the largest keeps answers small. */
export const ROUTE_MIN_STOP_MIN = 60 as const;
/** A history pull overlaps the previous one by this much (points the provider received late). */
export const ROUTE_OVERLAP_MS = 10 * 60_000;
/** The final pull of a truck-day waits this long after its last load was completed. */
export const FINAL_PULL_DELAY_MS = 10 * 60_000;
/** ... and covers the day until this long after that completion (the drive back is already in it). */
export const FINAL_PULL_TAIL_MS = 30 * 60_000;

const OUT = new Set(['LOCKED', 'LOADING', 'DISPATCHED']);
const LEFT = new Set(['DISPATCHED', 'COMPLETED']);

/** A truck-day whose history is pulled: REGULAR while a load of it is out, FINAL once after the last one. */
export interface RouteDay {
  truckId: string;
  imei: string;
  date: string;
  kind: 'REGULAR' | 'FINAL';
  /** The newest completion of the day's loads (FINAL), or null. */
  lastCompletedAt: Date | null;
}

export interface TickPlan {
  inHours: boolean;
  /** Trucks whose live position is asked for (and kept). */
  mapTrucks: FleetTruck[];
  /** Truck-days whose history is pulled (TIMES only). */
  routeDays: RouteDay[];
  /** Trucks with any load on yesterday's or today's plans: the backstop keeps their zone events. */
  eventTrucks: FleetTruck[];
}

/**
 * Who is out and what may be asked now. Pure. Inside the operating hours a truck with a LOCKED, LOADING
 * or DISPATCHED load; after them only a DISPATCHED one (a load still out). History: a truck-day once one
 * of its loads left (DISPATCHED or COMPLETED); FINAL when none is out any more (outside the hours only
 * REGULAR pulls of a day with a DISPATCHED load).
 */
export function planTick(c: Pick<IvmsCompany, 'mode' | 'timezone' | 'fromMin' | 'toMin'>, fleet: readonly FleetTruck[], now: Date): TickPlan {
  const hours: OperatingHours = { timezone: c.timezone, fromMin: c.fromMin, toMin: c.toMin };
  const inHours = inOperatingHours(now, hours);
  const mapTrucks = fleet.filter((t) => t.days.some((d) => d.loads.some((l) => (inHours ? OUT.has(l.status) : l.status === 'DISPATCHED'))));
  const routeDays: RouteDay[] = [];
  if (c.mode === 'TIMES') {
    for (const t of fleet) {
      for (const d of t.days) {
        if (!d.loads.some((l) => LEFT.has(l.status))) continue;
        const out = d.loads.some((l) => OUT.has(l.status));
        if (!inHours && !d.loads.some((l) => l.status === 'DISPATCHED')) continue;
        const done = d.loads.filter((l) => l.status === 'COMPLETED' && l.statusChangedAt).map((l) => l.statusChangedAt!.getTime());
        routeDays.push({ truckId: t.truckId, imei: t.imei, date: d.date, kind: out ? 'REGULAR' : 'FINAL', lastCompletedAt: done.length ? new Date(Math.max(...done)) : null });
      }
    }
  }
  return { inHours, mapTrucks, routeDays, eventTrucks: fleet.filter((t) => t.days.some((d) => d.loads.length > 0)) };
}

/** The history window of a truck-day pull, or null when there is nothing to ask for. Pure. */
export function routeWindow(day: RouteDay, row: TruckDayRow | undefined, hours: OperatingHours, now: Date): { from: Date; to: Date } | null {
  const start = opsStartOf(day.date, hours).getTime();
  const hardEnd = nextOpsStartOf(day.date, hours).getTime();
  let to = Math.min(now.getTime(), hardEnd);
  let from = start;
  // A load left out past the next day's start (never closed): nothing new to ask for this truck-day.
  if (day.kind === 'REGULAR' && row?.pulledTo && row.pulledTo.getTime() >= hardEnd) return null;
  if (day.kind === 'FINAL') {
    if (day.lastCompletedAt) to = Math.min(to, day.lastCompletedAt.getTime() + FINAL_PULL_TAIL_MS);
  } else if (row?.pulledTo) {
    from = Math.max(start, row.pulledTo.getTime() - ROUTE_OVERLAP_MS);
  }
  from = Math.max(from, to - ROUTE_MAX_WINDOW_MS);
  return to > from ? { from: new Date(from), to: new Date(to) } : null;
}

/** Is a truck-day's pull due? Pure. `everyMin` null: only final pulls are left today. */
export function routePullDue(day: RouteDay, row: TruckDayRow | undefined, everyMin: number | null, pullMin: number, now: Date, force = false): boolean {
  if (row?.suppressedAt) return false;
  if (day.kind === 'FINAL') {
    if (row?.finalPullAt) return false;
    return !day.lastCompletedAt || now.getTime() >= day.lastCompletedAt.getTime() + FINAL_PULL_DELAY_MS;
  }
  if (everyMin === null) return false;
  if (!row?.lastPullAt) return true;
  if (force && everyMin <= pullMin) return true;
  return now.getTime() - row.lastPullAt.getTime() >= everyMin * 60_000;
}

export interface IvmsTickDeps {
  store?: IvmsStore;
  env?: IvmsEnv;
  fetchImpl?: typeof fetch;
  random?: () => number;
  /** The lease owner (tests); by default unique per tick. */
  owner?: string;
}

export interface IvmsTickResult {
  mode: IvmsMode;
  /** Why nothing was called. */
  skipped?: 'NOTHING_OUT' | 'LEASE_OR_BACKOFF';
  /** notReturned: trackers asked for that the answer did not include (not visible with this key, or no fix). */
  map?: { trucks: number; intervalSec: number | null; called: boolean; written?: number; notReturned?: number; error?: AyunErrorKind };
  route?: { due: number; pulls: number; points: number; everyMin: number | null; errors: AyunErrorKind[] };
  events?: { called: boolean; inserted?: number; duplicates?: number; error?: AyunErrorKind };
}

interface ProcState {
  timer?: NodeJS.Timeout;
  inFlight?: boolean;
  stopping?: boolean;
  /** The calls in flight (the shutdown handler aborts them). */
  ctrls?: Set<AbortController>;
  /** After a NO_PERMISSION answer: the next live-position call asks for `*` (filtered to the mapped IMEIs). */
  starOnce?: boolean;
  /** The keep-set of the last position clean-up, and when (no DELETE every 15 s while nothing changes). */
  clearedKey?: string;
  clearedAt?: number;
  lastLogged?: string;
  seq?: number;
  pid?: string;
}
const g = globalThis as unknown as { __routeiqIvms?: ProcState };
const proc = (): ProcState => (g.__routeiqIvms ??= {});

function ownerId(): string {
  const p = proc();
  p.pid ??= randomUUID().slice(0, 8);
  p.seq = (p.seq ?? 0) + 1;
  return `${p.pid}:${p.seq}`;
}

/** One line per change of a call class's error kind (never a URL, a key or an answer). */
function logKind(cls: string, kind: AyunErrorKind | null): void {
  const p = proc();
  const key = `${cls}:${kind ?? 'OK'}`;
  if (p.lastLogged === key) return;
  p.lastLogged = key;
  if (kind) console.warn(`ivms: ${cls} call failed (${kind})`);
}

/** Delete the live positions of trucks that are no longer out (only when the set changed, or every 10 min). */
async function clearPositionsIfChanged(store: IvmsStore, tenantId: string, keep: readonly string[], now: Date): Promise<void> {
  const p = proc();
  const key = `${tenantId}|${[...keep].sort().join(',')}`;
  if (p.clearedKey === key && p.clearedAt && now.getTime() - p.clearedAt < 10 * 60_000) return;
  await store.clearPositions(tenantId, keep);
  p.clearedKey = key;
  p.clearedAt = now.getTime();
}

/**
 * One tick for the company of the Ayun account. Null when IVMS is not active (the variables are not set
 * or not usable, ROUTEIQ_DISABLE_IVMS=1, the company is unknown, or its ivmsMode is OFF): nothing was read
 * beyond the company's setting and nothing was called or written. Never throws for a provider problem; a
 * database error is thrown to the caller (the timer logs it, the next tick retries).
 */
export async function runIvmsTick(now: Date = new Date(), opts: { force?: boolean } = {}, deps: IvmsTickDeps = {}): Promise<IvmsTickResult | null> {
  const env = deps.env ?? readIvmsEnv();
  if (!ivmsApiReady(env) || !env.tenantSlug) return null;
  const store = deps.store ?? prismaIvmsStore;
  const c = await store.company(env.tenantSlug);
  if (!c || c.mode === 'OFF') return null;

  const fleet = await store.fleet(c, now);
  const plan = planTick(c, fleet, now);
  const result: IvmsTickResult = { mode: c.mode };
  const eventsOn = eventsBackstopOn(c.dailyBudget, env.webhookSecrets.length > 0) && plan.mapTrucks.length > 0;
  if (!plan.mapTrucks.length && !plan.routeDays.length) {
    await clearPositionsIfChanged(store, c.tenantId, [], now);
    result.skipped = 'NOTHING_OUT';
    return result;
  }

  const owner = deps.owner ?? ownerId();
  const state = await store.acquireLease(c.tenantId, owner, now, IVMS_LEASE_MS);
  if (!state) {
    result.skipped = 'LEASE_OR_BACKOFF';
    return result;
  }
  const p = proc();
  const ctrl = new AbortController();
  (p.ctrls ??= new Set()).add(ctrl);
  const callOpts: AyunCallOptions = { fetchImpl: deps.fetchImpl, signal: ctrl.signal };
  const hours: OperatingHours = { timezone: c.timezone, fromMin: c.fromMin, toMin: c.toMin };
  const shares = classShares(c.dailyBudget, c.mode, eventsOn);
  const horizon = horizonSec(now, hours);
  const limits = (share: number, minGapSec: number | null = null) => ({ share, budget: c.dailyBudget, leaseMs: IVMS_LEASE_MS, minGapSec });
  /** A failure that stops this tick (and starts a backoff); false = carry on. */
  const failed = async (cls: string, kind: AyunErrorKind, baseSec: number, s: IvmsStateRow): Promise<boolean> => {
    logKind(cls, kind);
    if (kind === 'NO_PERMISSION') {
      await store.recordFailure(c.tenantId, now, kind, null);
      return false;
    }
    if (kind === 'DISABLED' || kind === 'NOT_CONFIGURED') return true;
    const next = transientKind(kind) || kind === 'AUTH' || kind === 'LIMIT' ? backoffUntil(kind, s.failures + 1, now, baseSec, deps.random) : null;
    await store.recordFailure(c.tenantId, now, kind, next);
    return true;
  };

  try {
    // MAP: the live positions (the map only, never times).
    let stop = false;
    if (plan.mapTrucks.length) {
      const intervalSec = mapIntervalSec({ pollSec: c.pollSec, share: shares.MAP, used: state.mapCalls, horizonSec: horizon });
      result.map = { trucks: plan.mapTrucks.length, intervalSec, called: false };
      const skipWait = !!opts.force && intervalSec !== null && intervalSec <= c.pollSec;
      if (
        intervalSec !== null &&
        callDue({ lastAt: state.mapLastAt, intervalSec, settingSec: c.pollSec, now, force: opts.force }) &&
        (await store.claim(c.tenantId, owner, 'MAP', now, limits(shares.MAP, skipWait ? null : intervalSec)))
      ) {
        result.map.called = true;
        const star = !!p.starOnce;
        p.starOnce = false;
        const byImei = new Map(plan.mapTrucks.map((t) => [t.imei, t.truckId]));
        const r = await callAyun(env, { cmd: 'OBJECT_GET_LOCATIONS', imeis: star ? '*' : [...byImei.keys()] }, callOpts);
        const parsed = r.ok ? parseLocations(r.data, new Set(byImei.keys()), now, env.apiTimeOffsetMin) : null;
        if (r.ok && parsed) {
          const rows = parsed.fixes.filter((f) => !f.flags.includes('CLOCK_AHEAD')).map((fix) => ({ truckId: byImei.get(fix.imei)!, fix }));
          result.map.written = await store.writePositions(c.tenantId, rows, now);
          result.map.notReturned = Math.max(0, byImei.size - parsed.fixes.length - parsed.invalid);
          await store.recordOk(c.tenantId, now, providerSkewSec(parsed.fixes, now));
          logKind('MAP', null);
        } else {
          const kind: AyunErrorKind = r.ok ? 'PARSE' : r.kind;
          result.map.error = kind;
          if (kind === 'NO_PERMISSION' && !star) p.starOnce = true;
          stop = await failed('MAP', kind, intervalSec, state);
        }
      }
    }
    await clearPositionsIfChanged(store, c.tenantId, plan.mapTrucks.map((t) => t.truckId), now);

    // ROUTE: the trucks' history, the only source of GPS times (TIMES).
    if (!stop && plan.routeDays.length) {
      const rows = await store.truckDays(c.tenantId, plan.routeDays.map((d) => ({ truckId: d.truckId, date: d.date })));
      const rowOf = new Map(rows.map((r) => [`${r.truckId}|${r.date}`, r]));
      const trucksOut = plan.routeDays.filter((d) => d.kind === 'REGULAR').length;
      const everyMin = routePullEveryMin({ pullMin: c.routePullMin, share: shares.ROUTE, used: state.routeCalls, trucksOut, horizonSec: horizon });
      const due = plan.routeDays
        .filter((d) => routePullDue(d, rowOf.get(`${d.truckId}|${d.date}`), everyMin, c.routePullMin, now, opts.force))
        .sort((a, b) => {
          if (a.kind !== b.kind) return a.kind === 'FINAL' ? -1 : 1;
          const la = rowOf.get(`${a.truckId}|${a.date}`)?.lastPullAt?.getTime() ?? 0;
          const lb = rowOf.get(`${b.truckId}|${b.date}`)?.lastPullAt?.getTime() ?? 0;
          return la - lb || a.truckId.localeCompare(b.truckId) || a.date.localeCompare(b.date);
        });
      result.route = { due: due.length, pulls: 0, points: 0, everyMin, errors: [] };
      // Regular pulls never eat into the final pull kept for every truck still out.
      let regularLeft = shares.ROUTE - state.routeCalls - trucksOut;
      for (const day of due.slice(0, MAX_ROUTE_PULLS_PER_TICK)) {
        const row = rowOf.get(`${day.truckId}|${day.date}`);
        const final = day.kind === 'FINAL';
        if (!final && regularLeft <= 0) continue;
        const w = routeWindow(day, row, hours, now);
        if (!w) {
          await store.markPulled(c.tenantId, day.truckId, day.date, { pulledTo: row?.pulledTo ?? now, final, now });
          continue;
        }
        if (!(await store.claim(c.tenantId, owner, 'ROUTE', now, limits(shares.ROUTE)))) break;
        result.route.pulls++;
        if (!final) regularLeft--;
        const r = await callAyun(env, { cmd: 'OBJECT_GET_ROUTE', imei: day.imei, from: w.from, to: w.to, minStopMin: ROUTE_MIN_STOP_MIN }, callOpts);
        const parsed = r.ok ? parseRoute(r.data, now, env.apiTimeOffsetMin, w) : null;
        if (r.ok && parsed) {
          result.route.points += await store.writeTrail(c.tenantId, day.truckId, parsed.points);
          await store.markPulled(c.tenantId, day.truckId, day.date, { pulledTo: w.to, final, now });
          await store.recordOk(c.tenantId, now);
          logKind('ROUTE', null);
          continue;
        }
        const kind: AyunErrorKind = r.ok ? 'PARSE' : r.kind;
        result.route.errors.push(kind);
        if (kind === 'NO_PERMISSION') {
          // This tracker's history is not readable with the key: try again after the interval, never in a loop.
          await store.markPulled(c.tenantId, day.truckId, day.date, { pulledTo: row?.pulledTo ?? w.from, final, now });
        }
        if (await failed('ROUTE', kind, (everyMin ?? c.routePullMin) * 60, state)) {
          stop = true;
          break;
        }
      }
    }

    // EVENTS: the backstop for missed depot webhooks (allowance >= 1,000 a day and a webhook secret set).
    if (!stop && eventsOn && shares.EVENTS > 0 && callDue({ lastAt: state.eventsLastAt, intervalSec: EVENTS_EVERY_SEC, settingSec: EVENTS_EVERY_SEC, now })) {
      result.events = { called: false };
      if (await store.claim(c.tenantId, owner, 'EVENTS', now, limits(shares.EVENTS, EVENTS_EVERY_SEC))) {
        result.events.called = true;
        const byImei = new Map(plan.eventTrucks.map((t) => [t.imei, t]));
        const r = await callAyun(env, { cmd: 'OBJECT_GET_LAST_EVENTS' }, callOpts);
        const parsed = r.ok ? parseLastEvents(r.data, new Set(byImei.keys()), now, env.apiTimeOffsetMin) : null;
        if (r.ok && parsed) {
          const depots = parsed.events.length ? await store.depotZones(c.tenantId) : [];
          const rows = parsed.events.map((e) => zoneEventRow(e, byImei.get(e.imei)!, depots, 'BACKSTOP', now));
          const ins = await store.insertZoneEvents(c.tenantId, rows, now);
          result.events.inserted = ins.inserted;
          result.events.duplicates = ins.duplicates;
          await store.recordOk(c.tenantId, now);
          logKind('EVENTS', null);
        } else {
          const kind: AyunErrorKind = r.ok ? 'PARSE' : r.kind;
          result.events.error = kind;
          await failed('EVENTS', kind, EVENTS_EVERY_SEC, state);
        }
      }
    }
  } finally {
    p.ctrls?.delete(ctrl);
    await store.releaseLease(c.tenantId, owner, now);
  }
  return result;
}

/** The timer's tick: one at a time, never after a shutdown began, every error logged by kind only. */
async function timerTick(): Promise<void> {
  const p = proc();
  if (p.inFlight || p.stopping) return;
  p.inFlight = true;
  try {
    await runIvmsTick(new Date());
  } catch (err) {
    // A database error (the provider's never throw). Its name only: no statement values in the log.
    console.error('ivms: tick failed', (err as { code?: string; name?: string } | null)?.code ?? (err as Error)?.name ?? 'error');
  } finally {
    p.inFlight = false;
  }
}

/**
 * Start the IVMS timer (lib/jobs/janitor-loop.ts startJanitor, after its own ROUTEIQ_DISABLE_JANITOR
 * check). Not started at all while the variables are not set or usable, or ROUTEIQ_DISABLE_IVMS=1: a
 * company that never configured the link has no timer, no query, nothing. True when started.
 */
export function startIvmsTimer(env: IvmsEnv = readIvmsEnv()): boolean {
  const p = proc();
  if (p.timer || env.disabled || !ivmsApiReady(env)) return false;
  p.stopping = false;
  p.timer = setInterval(() => void timerTick(), IVMS_TICK_MS);
  p.timer.unref();
  return true;
}

/** The shutdown handler (lib/jobs/shutdown.ts): no new tick, and the call in flight is aborted (its lease expires by itself). */
export function stopIvms(): void {
  const p = proc();
  p.stopping = true;
  if (p.timer) clearInterval(p.timer);
  p.timer = undefined;
  for (const c of p.ctrls ?? []) c.abort();
}

/** Tests only: forget the in-process state (timer, flags). */
export function _resetIvmsProcessState(): void {
  const p = g.__routeiqIvms;
  if (p?.timer) clearInterval(p.timer);
  g.__routeiqIvms = {};
}
