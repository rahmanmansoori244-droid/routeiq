/**
 * The plan map's decisions (lib/dispatch/plan-map-state.ts) and static guards that keep
 * components/plan-map.tsx on them (jsdom is not a dependency here, as in dispatch-screen-guards):
 * - no connector lines while the shapes load; a road shape is solid; anything else is dashed;
 * - a failed first request is "failed" (never an empty answer that reads as "all on the road"), and a
 *   failed retry keeps what was shown;
 * - the one automatic retry;
 * - the draw gate: a draw asked for after the map's one-time 'load', while tiles are still loading
 *   (map.isStyleLoaded() false), runs at once. The old isStyleLoaded()/once('load') pattern parked it
 *   on an event that never came again, so the road shapes arriving right after the map fitted itself
 *   to the stops were never drawn (straight or no lines under an "OSRM" caption).
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  GEO_LOADING,
  afterFailedFetch,
  autoRetryDue,
  createDrawGate,
  linesToDraw,
  straightTour,
  type GeoRow,
  type GeoState,
  type MapLoadStops,
} from '@/lib/dispatch/plan-map-state';

const DEPOT = { lat: 23.6, lng: 58.4 };
const L1: MapLoadStops = { id: 'L1', stops: [{ lat: 23.61, lng: 58.41 }, { lat: null, lng: null }, { lat: 23.63, lng: 58.43 }] };
const L2: MapLoadStops = { id: 'L2', stops: [{ lat: 23.7, lng: 58.5 }] };
const ROAD1: [number, number][] = [[58.4, 23.6], [58.405, 23.602], [58.41, 23.61], [58.43, 23.63], [58.4, 23.6]];
const ready = (...rows: GeoRow[]): GeoState => ({ status: 'ready', rows });

describe('linesToDraw', () => {
  it('while the shapes load: no lines at all (the depot and the stops are still drawn)', () => {
    expect(linesToDraw(GEO_LOADING, [L1, L2], DEPOT)).toEqual([]);
  });

  it('a road shape is solid; an estimated load is dashed with the straight segments the server sent', () => {
    const straight2: [number, number][] = [[58.4, 23.6], [58.5, 23.7], [58.4, 23.6]];
    expect(linesToDraw(ready({ loadId: 'L1', estimated: false, coordinates: ROAD1 }, { loadId: 'L2', estimated: true, coordinates: straight2, reason: 'TIMEOUT' }), [L1, L2], DEPOT)).toEqual([
      { loadId: 'L1', coordinates: ROAD1, dashed: false },
      { loadId: 'L2', coordinates: straight2, dashed: true },
    ]);
  });

  it('a load missing from the answer, or a road row without points, is dashed straight (never a solid straight line)', () => {
    const lines = linesToDraw(ready({ loadId: 'L1', estimated: false, coordinates: [] }), [L1, L2], DEPOT);
    expect(lines).toEqual([
      { loadId: 'L1', coordinates: straightTour(DEPOT, L1.stops), dashed: true },
      { loadId: 'L2', coordinates: straightTour(DEPOT, L2.stops), dashed: true },
    ]);
    expect(straightTour(DEPOT, L1.stops)).toEqual([[58.4, 23.6], [58.41, 23.61], [58.43, 23.63], [58.4, 23.6]]);
  });

  it('the request failed: every load dashed straight', () => {
    expect(linesToDraw({ status: 'failed' }, [L1, L2], DEPOT).map((l) => l.dashed)).toEqual([true, true]);
  });
});

describe('afterFailedFetch / autoRetryDue', () => {
  it('a failed first request is "failed"; a failed retry keeps the shown answer', () => {
    expect(afterFailedFetch(GEO_LOADING)).toEqual({ status: 'failed' });
    expect(afterFailedFetch({ status: 'failed' })).toEqual({ status: 'failed' });
    const shown = ready({ loadId: 'L1', estimated: true, coordinates: ROAD1, reason: 'ROUTING_ERROR' });
    expect(afterFailedFetch(shown)).toBe(shown);
  });

  it('once, not while a retry runs, and only for straight lines a retry is likely to fix', () => {
    const errored = ready({ loadId: 'L1', estimated: true, coordinates: ROAD1, reason: 'ROUTING_ERROR' });
    expect(autoRetryDue(errored, { retrying: false, alreadyRetried: false })).toBe(true);
    expect(autoRetryDue({ status: 'failed' }, { retrying: false, alreadyRetried: false })).toBe(true);
    expect(autoRetryDue(errored, { retrying: true, alreadyRetried: false })).toBe(false);
    expect(autoRetryDue(errored, { retrying: false, alreadyRetried: true })).toBe(false);
    expect(autoRetryDue(GEO_LOADING, { retrying: false, alreadyRetried: false })).toBe(false);
    expect(autoRetryDue(ready({ loadId: 'L1', estimated: false, coordinates: ROAD1 }), { retrying: false, alreadyRetried: false })).toBe(false);
  });
});

/** A MapLibre-like map: one 'load' event per map; isStyleLoaded() false while tiles are pending. */
function fakeMap() {
  const listeners = new Set<() => void>();
  const onceListeners = new Set<() => void>();
  let loaded = false;
  let tilesPending = 0;
  return {
    on: vi.fn((_t: 'load', fn: () => void) => listeners.add(fn)),
    off: vi.fn((_t: 'load', fn: () => void) => {
      listeners.delete(fn);
      onceListeners.delete(fn);
    }),
    once: (_t: 'load', fn: () => void) => onceListeners.add(fn),
    isStyleLoaded: () => loaded && tilesPending === 0,
    fireLoad() {
      if (loaded) return; // maplibre fires 'load' once per map
      loaded = true;
      for (const fn of [...listeners, ...onceListeners]) fn();
      onceListeners.clear();
    },
    setTilesPending(n: number) {
      tilesPending = n;
    },
    listenerCount: () => listeners.size + onceListeners.size,
  };
}

describe('createDrawGate', () => {
  it('waits for the map, then runs only the newest draw once', () => {
    const m = fakeMap();
    const g = createDrawGate(m);
    const a = vi.fn();
    const b = vi.fn();
    g.run(a);
    g.run(b);
    expect(a).not.toHaveBeenCalled();
    expect(b).not.toHaveBeenCalled();
    m.fireLoad();
    expect(a).not.toHaveBeenCalled();
    expect(b).toHaveBeenCalledTimes(1);
  });

  it('after load, a draw runs at once even while tiles are still loading (the race that left straight lines)', () => {
    const m = fakeMap();
    const g = createDrawGate(m);
    m.fireLoad();
    m.setTilesPending(6); // fitBounds to the stops asked for new tiles
    expect(m.isStyleLoaded()).toBe(false);
    const roadShapes = vi.fn();
    g.run(roadShapes);
    expect(roadShapes).toHaveBeenCalledTimes(1);

    // The pattern it replaces, on the same map: the draw is parked on an event that never comes.
    const old = vi.fn();
    if (m.isStyleLoaded()) old();
    else m.once('load', old);
    m.setTilesPending(0);
    m.fireLoad();
    expect(old).not.toHaveBeenCalled();
  });

  it('cancel drops a waiting draw; dispose also stops listening to the map', () => {
    const m = fakeMap();
    const g = createDrawGate(m);
    const a = vi.fn();
    g.run(a);
    g.cancel();
    m.fireLoad();
    expect(a).not.toHaveBeenCalled();

    const m2 = fakeMap();
    const g2 = createDrawGate(m2);
    const b = vi.fn();
    g2.run(b);
    expect(m2.listenerCount()).toBe(1);
    g2.dispose();
    expect(m2.listenerCount()).toBe(0);
    m2.fireLoad();
    expect(b).not.toHaveBeenCalled();
  });
});

describe('components/plan-map.tsx stays on these rules (static guards)', () => {
  const src = readFileSync(path.resolve(__dirname, '../../components/plan-map.tsx'), 'utf8');
  const count = (re: RegExp) => [...src.matchAll(re)].length;

  it('draws only through the draw gate, never through isStyleLoaded()/once("load")', () => {
    expect(src).not.toMatch(/isStyleLoaded|\.once\(\s*'load'/);
    expect(src).toMatch(/const g = createDrawGate\(m\);/);
    expect(src).toMatch(/g\.run\(draw\);\s*return \(\) => g\.cancel\(\);/);
    expect(src).toMatch(/g\.dispose\(\);/);
  });

  it('the lines come from linesToDraw (no connector drawn while loading, dashed when not a road shape)', () => {
    expect(count(/linesToDraw\(geo, loads,/g)).toBe(1);
    expect(count(/m\.addSource\(/g)).toBe(1);
    expect(src).toMatch(/if \(line\) \{\s*m\.addSource\(/);
    expect(src).toMatch(/line\.dashed \? \{ 'line-dasharray'/);
    expect(src).not.toMatch(/row\?\.coordinates \?\?/);
  });

  it('a failed request goes through afterFailedFetch (never an empty answer); the auto-retry through autoRetryDue; the caption through roadShapesCaption', () => {
    expect(src).toMatch(/\.catch\(\(\) => \{\s*if \(alive\) setShapes\(\(prev\) => \(\{ key, geo: afterFailedFetch\(/);
    expect(src).not.toMatch(/setShapes\(\{[^}]*rows: \[\]/);
    expect(src).toMatch(/if \(!autoRetryDue\(geo, \{ retrying, alreadyRetried: autoRetried\.current \}\)\) return;/);
    expect(src).toMatch(/const caption = roadShapesCaption\(geo, \{ retrying \}\);/);
    expect(src).toMatch(/\{caption\.canRetry \? \(/);
    expect(src).toMatch(/\{caption\.text\}/);
  });

  it('an answer for other plan content is never drawn: the shapes are keyed by run and stops', () => {
    expect(src).toMatch(/const geo = shapes\.key === contentKey \? shapes\.geo : GEO_LOADING;/);
  });
});
