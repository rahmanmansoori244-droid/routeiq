/**
 * Plan map road shapes (GET /api/runs/:id/load-geometry, lib/dispatch/load-geometry.ts): loads are
 * asked 4 at a time within one deadline, one slow or failed load never turns the others straight
 * (only a clear "not configured" stops the calls), road shapes are cached (never estimates) with a
 * TTL and size caps, and callRouteGeometry (lib/solver-client.ts) reports why it has no shape.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  classifyReply,
  resolveLoadGeometries,
  RoadShapeCache,
  roadShapeKey,
  type LatLng,
  type LngLat,
  type LoadPath,
  type RouteGeometryCall,
  type RouteGeometryReply,
} from '@/lib/dispatch/load-geometry';
import { callRouteGeometry } from '@/lib/solver-client';

const DEPOT: LatLng = [23.6, 58.4];

function load(i: number, stops = 3): LoadPath {
  const pts: LatLng[] = [DEPOT];
  for (let s = 1; s <= stops; s++) pts.push([23.6 + i / 100 + s / 1000, 58.4 + s / 1000]);
  pts.push(DEPOT);
  return { loadId: `L${i}`, truckCode: `T${i}`, loadNo: 1, points: pts };
}
const loads = (n: number) => Array.from({ length: n }, (_, i) => load(i + 1));

/** A fake road shape: every point doubled with a small bend, so it differs from the straight line. */
function road(points: LatLng[]): LngLat[] {
  return points.flatMap(([lat, lng]) => [[lng, lat], [lng + 0.0001, lat + 0.0001]] as LngLat[]);
}
const answer = (points: LatLng[]): RouteGeometryReply => ({ kind: 'answer', provider: 'OSRM', isEstimated: false, coordinates: road(points), warning: null });
const solverFallback = (warning: string): RouteGeometryReply => ({ kind: 'answer', provider: 'HAVERSINE', isEstimated: true, coordinates: [], warning });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const spyCall = (impl: RouteGeometryCall) => vi.fn<Parameters<RouteGeometryCall>, ReturnType<RouteGeometryCall>>(impl);

describe('resolveLoadGeometries - concurrency and independence', () => {
  it('asks at most 4 loads at a time and keeps the order of the loads', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const call: RouteGeometryCall = async (pts) => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await sleep(5 + Math.random() * 10);
      inFlight--;
      return answer(pts);
    };
    const ls = loads(14);
    const rows = await resolveLoadGeometries(ls, { call, routingKey: 'k' });
    expect(maxInFlight).toBe(4);
    expect(rows.map((r) => r.loadId)).toEqual(ls.map((l) => l.loadId));
    expect(rows.every((r) => !r.estimated && r.reason === undefined)).toBe(true);
    expect(rows[0]).toEqual({ loadId: 'L1', truckCode: 'T1', loadNo: 1, estimated: false, coordinates: road(ls[0].points) });
  });

  it('honours a smaller concurrency', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const call: RouteGeometryCall = async (pts) => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await sleep(2);
      inFlight--;
      return answer(pts);
    };
    await resolveLoadGeometries(loads(6), { call, routingKey: 'k', concurrency: 2 });
    expect(maxInFlight).toBe(2);
  });

  it('a failed load is the only straight one (the old code turned every later load straight)', async () => {
    const ls = loads(14);
    const call: RouteGeometryCall = async (pts) => (pts === ls[0].points ? { kind: 'failed', status: 502 } : answer(pts));
    const rows = await resolveLoadGeometries(ls, { call, routingKey: 'k', concurrency: 1 });
    expect(rows[0]).toMatchObject({ estimated: true, reason: 'ROUTING_ERROR', coordinates: ls[0].points.map(([a, b]) => [b, a]) });
    expect(rows.slice(1).every((r) => !r.estimated)).toBe(true);
  });

  it('the solver saying OSRM was unavailable for one load does not stop the others', async () => {
    const ls = loads(5);
    const call: RouteGeometryCall = async (pts) =>
      pts === ls[1].points ? solverFallback('Road geometry unavailable (OSRM unavailable: ReadTimeout); straight lines shown.') : answer(pts);
    const rows = await resolveLoadGeometries(ls, { call, routingKey: 'k', concurrency: 1 });
    expect(rows.map((r) => r.reason ?? 'road')).toEqual(['road', 'ROUTING_ERROR', 'road', 'road', 'road']);
  });

  it('a call that throws or rejects is a ROUTING_ERROR for that load only', async () => {
    const ls = loads(3);
    const call: RouteGeometryCall = (pts) => {
      if (pts === ls[0].points) throw new Error('boom');
      if (pts === ls[1].points) return Promise.reject(new Error('boom'));
      return Promise.resolve(answer(pts));
    };
    const rows = await resolveLoadGeometries(ls, { call, routingKey: 'k' });
    expect(rows.map((r) => r.reason ?? 'road')).toEqual(['ROUTING_ERROR', 'ROUTING_ERROR', 'road']);
  });

  it('OSRM finding no road for a load is NOT_ROUTABLE, and the other loads still get their shapes', async () => {
    const ls = loads(3);
    const call: RouteGeometryCall = async (pts) =>
      pts === ls[2].points ? solverFallback("Road geometry unavailable (OSRM unavailable: OSRM returned code='NoRoute'); straight lines shown.") : answer(pts);
    const rows = await resolveLoadGeometries(ls, { call, routingKey: 'k' });
    expect(rows.map((r) => r.reason ?? 'road')).toEqual(['road', 'road', 'NOT_ROUTABLE']);
  });

  it('only a clear "not configured" answer stops further calls', async () => {
    for (const first of [{ kind: 'not_configured' } as RouteGeometryReply, solverFallback('Road routing (OSRM) is not configured; straight lines shown.')]) {
      const call = spyCall(async () => first);
      const rows = await resolveLoadGeometries(loads(14), { call, routingKey: 'k', concurrency: 1 });
      expect(call).toHaveBeenCalledTimes(1);
      expect(rows.every((r) => r.estimated && r.reason === 'NOT_CONFIGURED')).toBe(true);
    }
  });

  it('routing off for the company: every load straight with ROUTING_OFF, no solver call', async () => {
    const rows = await resolveLoadGeometries(loads(3), { call: null, routingKey: 'k' });
    expect(rows.every((r) => r.estimated && r.reason === 'ROUTING_OFF')).toBe(true);
    expect(rows[0].coordinates).toEqual(load(1).points.map(([a, b]) => [b, a]));
  });

  it('a load with no located stop (depot to depot) is not sent and not called an estimate', async () => {
    const call = spyCall(async (pts) => answer(pts));
    const empty: LoadPath = { loadId: 'E', truckCode: 'T', loadNo: 2, points: [DEPOT, DEPOT] };
    const [row] = await resolveLoadGeometries([empty], { call, routingKey: 'k' });
    expect(call).not.toHaveBeenCalled();
    expect(row).toEqual({ loadId: 'E', truckCode: 'T', loadNo: 2, estimated: false, coordinates: [[DEPOT[1], DEPOT[0]], [DEPOT[1], DEPOT[0]]] });
  });

  it('no loads: no call, empty answer', async () => {
    const call = spyCall(async (pts) => answer(pts));
    expect(await resolveLoadGeometries([], { call, routingKey: 'k' })).toEqual([]);
    expect(call).not.toHaveBeenCalled();
  });
});

describe('resolveLoadGeometries - one overall deadline', () => {
  it('loads answered in time keep their road shape; the rest are TIMEOUT when the deadline passes', async () => {
    const ls = loads(8);
    const signals: AbortSignal[] = [];
    // Loads 1 and 2 answer at once; every other call hangs and even ignores the abort signal.
    const call: RouteGeometryCall = (pts, signal) => {
      signals.push(signal);
      return pts === ls[0].points || pts === ls[1].points ? Promise.resolve(answer(pts)) : new Promise<RouteGeometryReply>(() => {});
    };
    const t0 = Date.now();
    const rows = await resolveLoadGeometries(ls, { call, routingKey: 'k', deadlineMs: 80 });
    expect(Date.now() - t0).toBeLessThan(1_000);
    expect(rows.map((r) => r.reason ?? 'road')).toEqual(['road', 'road', 'TIMEOUT', 'TIMEOUT', 'TIMEOUT', 'TIMEOUT', 'TIMEOUT', 'TIMEOUT']);
    // The solver calls got the deadline's signal, aborted once the deadline passed.
    expect(signals.length).toBeGreaterThan(0);
    expect(signals.every((s) => s.aborted)).toBe(true);
  });

  it('a slow first load does not block the others behind it (4 lanes)', async () => {
    const ls = loads(6);
    const call: RouteGeometryCall = (pts) => (pts === ls[0].points ? new Promise<RouteGeometryReply>(() => {}) : Promise.resolve(answer(pts)));
    const rows = await resolveLoadGeometries(ls, { call, routingKey: 'k', deadlineMs: 60 });
    expect(rows.map((r) => r.reason ?? 'road')).toEqual(['TIMEOUT', 'road', 'road', 'road', 'road', 'road']);
  });
});

describe('resolveLoadGeometries - road shape cache', () => {
  it('a second view of the same plan makes no solver call and gets the same shapes', async () => {
    const cache = new RoadShapeCache({ ttlMs: 60_000, maxEntries: 100, maxPoints: 100_000 });
    const call = spyCall(async (pts) => answer(pts));
    const ls = loads(5);
    const first = await resolveLoadGeometries(ls, { call, routingKey: 'solver-default', cache });
    expect(call).toHaveBeenCalledTimes(5);
    const second = await resolveLoadGeometries(ls, { call, routingKey: 'solver-default', cache });
    expect(call).toHaveBeenCalledTimes(5);
    expect(second).toEqual(first);
  });

  it('estimates are never cached: the next view asks again and gets the road shape', async () => {
    const cache = new RoadShapeCache({ ttlMs: 60_000, maxEntries: 100, maxPoints: 100_000 });
    let up = false;
    const call = spyCall(async (pts) => (up ? answer(pts) : { kind: 'failed' }));
    const ls = loads(2);
    expect((await resolveLoadGeometries(ls, { call, routingKey: 'k', cache })).every((r) => r.estimated)).toBe(true);
    up = true;
    expect((await resolveLoadGeometries(ls, { call, routingKey: 'k', cache })).every((r) => !r.estimated)).toBe(true);
    expect(call).toHaveBeenCalledTimes(4);
  });

  it('a cached shape is used even after routing stops answering, and a retry only asks for the missing loads', async () => {
    const cache = new RoadShapeCache({ ttlMs: 60_000, maxEntries: 100, maxPoints: 100_000 });
    const ls = loads(4);
    await resolveLoadGeometries(ls.slice(0, 2), { call: async (pts) => answer(pts), routingKey: 'k', cache });
    const call = spyCall(async () => ({ kind: 'timeout' }));
    const rows = await resolveLoadGeometries(ls, { call, routingKey: 'k', cache });
    expect(rows.map((r) => r.reason ?? 'road')).toEqual(['road', 'road', 'TIMEOUT', 'TIMEOUT']);
    expect(call).toHaveBeenCalledTimes(2);
  });

  it('the key is the routing namespace plus the exact coordinates', async () => {
    const cache = new RoadShapeCache({ ttlMs: 60_000, maxEntries: 100, maxPoints: 100_000 });
    const call = spyCall(async (pts) => answer(pts));
    const l = load(1);
    await resolveLoadGeometries([l], { call, routingKey: 'osrm:http://a', cache });
    await resolveLoadGeometries([l], { call, routingKey: 'osrm:http://b', cache });
    expect(call).toHaveBeenCalledTimes(2);
    const moved: LoadPath = { ...l, points: l.points.map(([a, b], i) => (i === 1 ? [a + 0.000001, b] : [a, b]) as LatLng) };
    await resolveLoadGeometries([moved], { call, routingKey: 'osrm:http://a', cache });
    expect(call).toHaveBeenCalledTimes(3);
    // Same points, another load id (or another tenant's load at the same places): a hit.
    await resolveLoadGeometries([{ ...l, loadId: 'other' }], { call, routingKey: 'osrm:http://a', cache });
    expect(call).toHaveBeenCalledTimes(3);
    expect(roadShapeKey('k', [[1, 2], [3, 4]])).toBe('k\n1,2;3,4');
  });
});

describe('RoadShapeCache - TTL and size caps', () => {
  const line = (n: number, x = 0): LngLat[] => Array.from({ length: n }, (_, i) => [x + i, x - i] as LngLat);

  it('expires entries after the TTL', () => {
    let now = 1_000;
    const c = new RoadShapeCache({ ttlMs: 100, maxEntries: 10, maxPoints: 1_000, now: () => now });
    c.set('a', line(3));
    now += 100;
    expect(c.get('a')).toEqual(line(3));
    now += 1;
    expect(c.get('a')).toBeNull();
    expect(c.size).toBe(0);
    expect(c.points).toBe(0);
  });

  it('evicts the least recently used entry beyond maxEntries', () => {
    const c = new RoadShapeCache({ ttlMs: 1e9, maxEntries: 2, maxPoints: 1_000 });
    c.set('a', line(2));
    c.set('b', line(2));
    c.get('a'); // a is now the most recently used
    c.set('c', line(2));
    expect(c.get('b')).toBeNull();
    expect(c.get('a')).not.toBeNull();
    expect(c.get('c')).not.toBeNull();
  });

  it('keeps the total points under maxPoints and skips a shape larger than the cap', () => {
    const c = new RoadShapeCache({ ttlMs: 1e9, maxEntries: 100, maxPoints: 10 });
    c.set('a', line(4));
    c.set('b', line(4));
    c.set('c', line(4)); // 12 points > 10: a goes
    expect(c.points).toBe(8);
    expect(c.get('a')).toBeNull();
    c.set('huge', line(11));
    expect(c.get('huge')).toBeNull();
    expect(c.points).toBe(8);
    c.set('b', line(2)); // replacing an entry adjusts the count
    expect(c.points).toBe(6);
  });

  it('hands out copies: changing an answer does not change the cache', () => {
    const c = new RoadShapeCache({ ttlMs: 1e9, maxEntries: 10, maxPoints: 1_000 });
    const src = line(3, 5);
    c.set('a', src);
    src[0][0] = 999;
    const got = c.get('a')!;
    got[1][1] = 999;
    expect(c.get('a')).toEqual(line(3, 5));
  });
});

describe('classifyReply', () => {
  it('maps every solver outcome to a road shape or a reason', () => {
    expect(classifyReply({ kind: 'answer', provider: 'OSRM', isEstimated: false, coordinates: [[1, 2], [3, 4]], warning: null })).toEqual({ coordinates: [[1, 2], [3, 4]], stopAll: false });
    expect(classifyReply({ kind: 'answer', provider: 'OSRM', isEstimated: false, coordinates: [], warning: null })).toEqual({ reason: 'ROUTING_ERROR', stopAll: false });
    expect(classifyReply({ kind: 'not_configured' })).toEqual({ reason: 'NOT_CONFIGURED', stopAll: true });
    expect(classifyReply({ kind: 'timeout' })).toEqual({ reason: 'TIMEOUT', stopAll: false });
    expect(classifyReply({ kind: 'failed', status: 503 })).toEqual({ reason: 'ROUTING_ERROR', stopAll: false });
    expect(classifyReply(solverFallback("Road geometry unavailable (OSRM unavailable: Client error '400 Bad Request' for url 'http://osrm/route'); straight lines shown."))).toEqual({ reason: 'NOT_ROUTABLE', stopAll: false });
    expect(classifyReply(solverFallback("OSRM returned code='NoSegment'"))).toEqual({ reason: 'NOT_ROUTABLE', stopAll: false });
    expect(classifyReply(solverFallback('Road geometry unavailable (OSRM unavailable: [Errno 111] Connection refused); straight lines shown.'))).toEqual({ reason: 'ROUTING_ERROR', stopAll: false });
    expect(classifyReply({ kind: 'answer', provider: 'HAVERSINE', isEstimated: true, coordinates: [], warning: null })).toEqual({ reason: 'ROUTING_ERROR', stopAll: false });
  });
});

describe('callRouteGeometry - why there is no road shape', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });
  const pts: [number, number][] = [DEPOT, [23.7, 58.5], DEPOT];

  it('not configured on the web: no request', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    vi.stubEnv('SOLVER_URL', '');
    vi.stubEnv('SOLVER_TOKEN', '');
    expect(await callRouteGeometry(pts)).toEqual({ kind: 'not_configured' });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('a solver answer, an HTTP error, a network error and an abort', async () => {
    vi.stubEnv('SOLVER_URL', 'http://solver.test');
    vi.stubEnv('SOLVER_TOKEN', 'tok');
    const fetchSpy = vi.fn(async (_url: string, init: RequestInit) => {
      expect(JSON.parse(String(init.body))).toEqual({ coords: pts, osrm_url: 'http://osrm.test' });
      return new Response(JSON.stringify({ provider: 'OSRM', is_estimated: false, coordinates: [[58.4, 23.6], [58.5, 23.7]] }), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchSpy);
    expect(await callRouteGeometry(pts, 'http://osrm.test')).toEqual({ kind: 'answer', provider: 'OSRM', isEstimated: false, coordinates: [[58.4, 23.6], [58.5, 23.7]], warning: null });
    expect(fetchSpy.mock.calls[0][0]).toBe('http://solver.test/route-geometry');

    vi.stubGlobal('fetch', vi.fn(async () => new Response('bad gateway', { status: 502 })));
    expect(await callRouteGeometry(pts)).toEqual({ kind: 'failed', status: 502 });

    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('fetch failed'); }));
    expect(await callRouteGeometry(pts)).toEqual({ kind: 'failed' });

    // Hangs until aborted: the caller's deadline signal ends it as a timeout.
    vi.stubGlobal('fetch', vi.fn((_u: string, init: RequestInit) => new Promise((_res, rej) => init.signal!.addEventListener('abort', () => rej(new Error('aborted'))))));
    const ctrl = new AbortController();
    const p = callRouteGeometry(pts, null, { signal: ctrl.signal });
    ctrl.abort();
    expect(await p).toEqual({ kind: 'timeout' });
    // Own per-call timeout.
    expect(await callRouteGeometry(pts, null, { timeoutMs: 20 })).toEqual({ kind: 'timeout' });
    // Already past the deadline: no request at all.
    const spy = vi.fn();
    vi.stubGlobal('fetch', spy);
    expect(await callRouteGeometry(pts, null, { signal: AbortSignal.abort() })).toEqual({ kind: 'timeout' });
    expect(spy).not.toHaveBeenCalled();
  });
});
