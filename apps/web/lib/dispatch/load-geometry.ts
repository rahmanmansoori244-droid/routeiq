/**
 * Road shapes for the dispatch plan map (`GET /api/runs/:id/load-geometry`).
 *
 * Each load's path (depot -> stops in order -> depot) is sent to the solver's `/route-geometry`,
 * which asks the private OSRM for the road polyline. This module holds the logic, kept free of
 * Next.js, Prisma and `fetch` so it can be tested with a fake solver call:
 *
 * - **Bounded concurrency** (`concurrency`, default 4) and **one overall deadline** (`deadlineMs`,
 *   default 20 s). A load still waiting when the deadline passes is drawn straight with reason
 *   `TIMEOUT`; the loads already answered keep their road shapes.
 * - **One slow or failed load never turns the others into straight lines.** Only a clear "road
 *   routing is not configured" answer (web without `SOLVER_URL`/`SOLVER_TOKEN`, or a solver without
 *   an OSRM URL) stops further calls, because every other load would get the same answer.
 * - **Cache** of road shapes (never of straight-line estimates, so a hiccup does not stick), keyed by
 *   the routing namespace (the tenant's own OSRM URL, else the solver's default) and the exact
 *   coordinate list. The key holds coordinates only: a tenant gets a hit only for the exact points of
 *   its own run's loads, which the route reads through the tenant-scoped client. The cache is
 *   in-memory, per process: fine for the single web replica; a second replica just has its own.
 */

/** [lat, lng], the order the solver takes. */
export type LatLng = [number, number];
/** [lng, lat], GeoJSON order, what the map draws. */
export type LngLat = [number, number];

/** Why a load is drawn as straight segments instead of its road shape (sent as `reason`). */
export type EstimateReason =
  /** The company plans on straight-line distances (Settings), or its country is outside the routing map. */
  | 'ROUTING_OFF'
  /** No road routing configured: the web has no solver, or the solver has no OSRM URL. */
  | 'NOT_CONFIGURED'
  /** OSRM answered but could not route this load (a stop far from any road, or an invalid point). */
  | 'NOT_ROUTABLE'
  /** The solver or OSRM failed for this load (restart, overload, network). Worth a retry. */
  | 'ROUTING_ERROR'
  /** No answer before the per-call timeout or the overall deadline. Worth a retry. */
  | 'TIMEOUT';

/** What one solver `/route-geometry` call gave (see `callRouteGeometry` in `lib/solver-client.ts`). */
export type RouteGeometryReply =
  /** The solver answered 200. `isEstimated` = it fell back to straight segments; `warning` says why. */
  | { kind: 'answer'; provider: string; isEstimated: boolean; coordinates: LngLat[]; warning: string | null }
  /** The web has no `SOLVER_URL` or `SOLVER_TOKEN`: no call was made. */
  | { kind: 'not_configured' }
  /** No answer in time (per-call timeout or the caller's deadline). */
  | { kind: 'timeout' }
  /** Network error or a non-2xx answer. */
  | { kind: 'failed'; status?: number };

/** One solver call for one load; must give up when `signal` aborts (the deadline). */
export type RouteGeometryCall = (points: LatLng[], signal: AbortSignal) => Promise<RouteGeometryReply>;

export interface LoadPath {
  loadId: string;
  truckCode: string;
  loadNo: number;
  /** Depot, located stops in order, depot. */
  points: LatLng[];
}

/** One row of the API answer. The first five fields are the original shape; `reason` is new. */
export interface LoadGeometry {
  loadId: string;
  truckCode: string;
  loadNo: number;
  /** true = `coordinates` are straight segments between the points, not the road. */
  estimated: boolean;
  coordinates: LngLat[];
  /** Only when `estimated`. */
  reason?: EstimateReason;
}

export type ClassifiedReply =
  | { coordinates: LngLat[]; reason?: undefined; stopAll: false }
  /** `stopAll`: every other load would get the same answer, so the route stops calling. */
  | { coordinates?: undefined; reason: EstimateReason; stopAll: boolean };

/** How the route turns a solver reply into a road shape or an estimate reason. */
export function classifyReply(reply: RouteGeometryReply): ClassifiedReply {
  switch (reply.kind) {
    case 'not_configured':
      return { reason: 'NOT_CONFIGURED', stopAll: true };
    case 'timeout':
      return { reason: 'TIMEOUT', stopAll: false };
    case 'failed':
      return { reason: 'ROUTING_ERROR', stopAll: false };
    case 'answer': {
      if (!reply.isEstimated) {
        if (Array.isArray(reply.coordinates) && reply.coordinates.length >= 2) return { coordinates: reply.coordinates, stopAll: false };
        return { reason: 'ROUTING_ERROR', stopAll: false };
      }
      const w = reply.warning ?? '';
      // apps/solver/main.py: "Road routing (OSRM) is not configured; straight lines shown."
      if (/not configured/i.test(w)) return { reason: 'NOT_CONFIGURED', stopAll: true };
      // OSRM refused this path: code NoRoute / NoSegment, or HTTP 400 for the request. Same answer on a retry.
      if (/noroute|no route|nosegment|\b400\b|bad request/i.test(w)) return { reason: 'NOT_ROUTABLE', stopAll: false };
      return { reason: 'ROUTING_ERROR', stopAll: false };
    }
  }
}

/** Straight segments through the points, in map order. */
export function straightLine(points: LatLng[]): LngLat[] {
  return points.map(([lat, lng]) => [lng, lat]);
}

export function roadShapeKey(routingKey: string, points: LatLng[]): string {
  // Exact numbers (no rounding): a moved pin is a different shape.
  return `${routingKey}\n${points.map(([lat, lng]) => `${lat},${lng}`).join(';')}`;
}

export interface RoadShapeCacheOptions {
  /** How long a road shape is reused. */
  ttlMs: number;
  /** At most this many shapes. */
  maxEntries: number;
  /** At most this many points over all shapes (a shape is stored as 16 bytes per point). */
  maxPoints: number;
  now?: () => number;
}

/** LRU of road shapes with a TTL and two size caps. Stores copies, hands out copies. */
export class RoadShapeCache {
  private readonly entries = new Map<string, { at: number; flat: Float64Array }>();
  private pointCount = 0;
  private readonly now: () => number;

  constructor(private readonly opts: RoadShapeCacheOptions) {
    this.now = opts.now ?? Date.now;
  }

  get size(): number {
    return this.entries.size;
  }

  get points(): number {
    return this.pointCount;
  }

  get(key: string): LngLat[] | null {
    const e = this.entries.get(key);
    if (!e) return null;
    if (this.now() - e.at > this.opts.ttlMs) {
      this.remove(key);
      return null;
    }
    this.entries.delete(key);
    this.entries.set(key, e); // most recently used goes last
    const out: LngLat[] = new Array(e.flat.length / 2);
    for (let i = 0; i < out.length; i++) out[i] = [e.flat[2 * i], e.flat[2 * i + 1]];
    return out;
  }

  set(key: string, coordinates: LngLat[]): void {
    const n = coordinates.length;
    if (n < 2 || n > this.opts.maxPoints) return;
    const flat = new Float64Array(n * 2);
    for (let i = 0; i < n; i++) {
      flat[2 * i] = coordinates[i][0];
      flat[2 * i + 1] = coordinates[i][1];
    }
    this.remove(key);
    this.entries.set(key, { at: this.now(), flat });
    this.pointCount += n;
    while (this.entries.size > this.opts.maxEntries || this.pointCount > this.opts.maxPoints) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.remove(oldest);
    }
  }

  clear(): void {
    this.entries.clear();
    this.pointCount = 0;
  }

  private remove(key: string): void {
    const e = this.entries.get(key);
    if (!e) return;
    this.entries.delete(key);
    this.pointCount -= e.flat.length / 2;
  }
}

/**
 * The web process's road-shape cache. 12 h: the road map changes rarely and a plan's loads are
 * looked at all day. 500 shapes / 300,000 points (~5 MB) cover several busy days of ~15 loads of
 * ~1,000 points each.
 */
export const roadShapeCache = new RoadShapeCache({ ttlMs: 12 * 60 * 60 * 1000, maxEntries: 500, maxPoints: 300_000 });

export interface ResolveOptions {
  /** The solver call, or null when the company does not use road routing (every load `ROUTING_OFF`). */
  call: RouteGeometryCall | null;
  /** Cache namespace: which OSRM answers (the tenant's own URL, else the solver's default). */
  routingKey: string;
  cache?: RoadShapeCache | null;
  concurrency?: number;
  deadlineMs?: number;
}

export const LOAD_GEOMETRY_CONCURRENCY = 4;
export const LOAD_GEOMETRY_DEADLINE_MS = 20_000;

function distinctPoints(points: LatLng[]): number {
  return new Set(points.map(([lat, lng]) => `${lat},${lng}`)).size;
}

/** Resolves when `p` settles or `signal` aborts, whichever is first (then as a timeout). */
function untilAborted(p: Promise<RouteGeometryReply>, signal: AbortSignal): Promise<RouteGeometryReply> {
  if (signal.aborted) return Promise.resolve({ kind: 'timeout' });
  return new Promise((resolve) => {
    const onAbort = () => resolve({ kind: 'timeout' });
    signal.addEventListener('abort', onAbort, { once: true });
    p.then(
      (r) => {
        signal.removeEventListener('abort', onAbort);
        resolve(r);
      },
      () => {
        signal.removeEventListener('abort', onAbort);
        resolve({ kind: 'failed' });
      },
    );
  });
}

/** One row per load, in the order given. Never throws. */
export async function resolveLoadGeometries(loads: LoadPath[], opts: ResolveOptions): Promise<LoadGeometry[]> {
  const out: LoadGeometry[] = new Array(loads.length);
  const cache = opts.cache ?? null;
  const call = opts.call;
  const concurrency = Math.max(1, Math.floor(opts.concurrency ?? LOAD_GEOMETRY_CONCURRENCY));
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(), Math.max(0, opts.deadlineMs ?? LOAD_GEOMETRY_DEADLINE_MS));
  let stopReason: EstimateReason | null = null;

  const one = async (l: LoadPath): Promise<LoadGeometry> => {
    const base = { loadId: l.loadId, truckCode: l.truckCode, loadNo: l.loadNo };
    const straight = straightLine(l.points);
    const estimate = (reason: EstimateReason): LoadGeometry => ({ ...base, estimated: true, coordinates: straight, reason });
    if (!call) return estimate('ROUTING_OFF');
    // No located stop (depot -> depot): nothing to route, nothing to call it an estimate for.
    if (distinctPoints(l.points) < 2) return { ...base, estimated: false, coordinates: straight };
    const key = roadShapeKey(opts.routingKey, l.points);
    const hit = cache?.get(key);
    if (hit) return { ...base, estimated: false, coordinates: hit };
    if (stopReason) return estimate(stopReason);
    if (deadline.signal.aborted) return estimate('TIMEOUT');
    let reply: RouteGeometryReply;
    try {
      reply = await untilAborted(call(l.points, deadline.signal), deadline.signal);
    } catch {
      reply = { kind: 'failed' };
    }
    const c = classifyReply(reply);
    if (c.coordinates) {
      cache?.set(key, c.coordinates);
      return { ...base, estimated: false, coordinates: c.coordinates };
    }
    if (c.stopAll && !stopReason) stopReason = c.reason;
    return estimate(c.reason);
  };

  let next = 0;
  const worker = async () => {
    for (let i = next++; i < loads.length; i = next++) out[i] = await one(loads[i]);
  };
  try {
    await Promise.all(Array.from({ length: Math.min(concurrency, loads.length) }, worker));
  } finally {
    clearTimeout(timer);
  }
  return out;
}
