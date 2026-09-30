/**
 * The plan map's decisions (lib/dispatch/plan-map-state.ts) and static guards that keep
 * components/plan-map.tsx on them (jsdom is not a dependency here, as in dispatch-screen-guards):
 * - no connector lines while the shapes load; a road shape is solid; anything else is dashed; a load
 *   with no located stop away from the depot gets no line;
 * - a row counts only for the load it was made for (same id and path fingerprint): the caption counts
 *   the lines drawn, and an answer for other content than the screen is stale (the plan is reloaded);
 * - a failed first request is "failed" (never an empty answer that reads as "all on the road"), and a
 *   failed retry keeps what was shown;
 * - the one automatic retry;
 * - the draw gate: ready once the map's STYLE has loaded ('style.load'), never waiting for the tiles.
 *   The map's 'load' event waits for every tile of the first view (a slow tile server left the map
 *   empty for seconds, a hanging tile until the map was moved, under an "OSRM" caption), and the older
 *   isStyleLoaded()/once('load') pattern parked a draw on an event that never came again.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  GEO_LOADING,
  afterFailedFetch,
  answerIsStale,
  autoRetryDue,
  createDrawGate,
  drawnShapes,
  linesToDraw,
  straightTour,
  type GeoRow,
  type GeoState,
  type MapLoadStops,
} from '@/lib/dispatch/plan-map-state';
import { loadPath, loadPathKey } from '@/lib/dispatch/load-path';
import { FAILED_TEXT, ROAD_TEXT, roadShapesCaption } from '@/lib/dispatch/map-caption';

const DEPOT = { lat: 23.6, lng: 58.4 };
const L1: MapLoadStops = { id: 'L1', stops: [{ lat: 23.61, lng: 58.41 }, { lat: null, lng: null }, { lat: 23.63, lng: 58.43 }] };
const L2: MapLoadStops = { id: 'L2', stops: [{ lat: 23.7, lng: 58.5 }] };
const ROAD1: [number, number][] = [[58.4, 23.6], [58.405, 23.602], [58.41, 23.61], [58.43, 23.63], [58.4, 23.6]];
const ready = (...rows: GeoRow[]): GeoState => ({ status: 'ready', rows });
/** The fingerprint the server sends for a load with these stops (the route builds the same path). */
const keyOf = (l: MapLoadStops) => loadPathKey(loadPath(DEPOT, l.stops));

describe('linesToDraw', () => {
  it('while the shapes load: no lines at all (the depot and the stops are still drawn)', () => {
    expect(linesToDraw(GEO_LOADING, [L1, L2], DEPOT)).toEqual([]);
  });

  it('a road shape is solid; an estimated load is dashed with the straight segments the server sent', () => {
    const straight2: [number, number][] = [[58.4, 23.6], [58.5, 23.7], [58.4, 23.6]];
    expect(linesToDraw(ready({ loadId: 'L1', estimated: false, coordinates: ROAD1 }, { loadId: 'L2', estimated: true, coordinates: straight2, reason: 'TIMEOUT' }), [L1, L2], DEPOT)).toEqual([
      { loadId: 'L1', coordinates: ROAD1, dashed: false },
      { loadId: 'L2', coordinates: straight2, dashed: true, reason: 'TIMEOUT' },
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

  it('a row with the fingerprint of the stops shown is drawn; one for other stops (same load id) is not', () => {
    expect(linesToDraw(ready({ loadId: 'L1', estimated: false, coordinates: ROAD1, pointsKey: keyOf(L1) }), [L1], DEPOT)).toEqual([{ loadId: 'L1', coordinates: ROAD1, dashed: false }]);
    // The pin of L1's first stop moved on the server: its road shape is of other stops.
    const movedL1: MapLoadStops = { id: 'L1', stops: [{ lat: 23.65, lng: 58.45 }, ...L1.stops.slice(1)] };
    expect(linesToDraw(ready({ loadId: 'L1', estimated: false, coordinates: ROAD1, pointsKey: keyOf(movedL1) }), [L1], DEPOT)).toEqual([
      { loadId: 'L1', coordinates: straightTour(DEPOT, L1.stops), dashed: true },
    ]);
    // An older server sends no fingerprint: the row is taken by its load id.
    expect(linesToDraw(ready({ loadId: 'L1', estimated: false, coordinates: ROAD1 }), [L1], DEPOT)[0].dashed).toBe(false);
  });

  it('audit E1: a load planned from a depot pin moved since is drawn from that pin, and its road shape still matches', () => {
    const OLD = { lat: 23.58, lng: 58.39 };
    const kept: MapLoadStops = { ...L1, origin: OLD };
    // The road-shapes route builds its path from the load's origin: the same fingerprint as the map's.
    const row = { loadId: 'L1', estimated: false, coordinates: ROAD1, pointsKey: loadPathKey(loadPath(OLD, L1.stops)) };
    expect(linesToDraw(ready(row), [kept], DEPOT)).toEqual([{ loadId: 'L1', coordinates: ROAD1, dashed: false }]);
    expect(answerIsStale(ready(row), [kept], DEPOT)).toBe(false);
    // Drawn straight: from and back to the old pin, never the plan's depot.
    expect(linesToDraw({ status: 'failed' }, [kept], DEPOT)[0].coordinates).toEqual(straightTour(OLD, L1.stops));
    expect(straightTour(OLD, L1.stops)[0]).toEqual([58.39, 23.58]);
    // A row routed from the plan's depot is for other content than this load.
    expect(answerIsStale(ready({ ...row, pointsKey: keyOf(L1) }), [kept], DEPOT)).toBe(true);
  });

  it('a dashed line keeps the reason the server gave for that load, and only that', () => {
    const straight2: [number, number][] = [[58.4, 23.6], [58.5, 23.7], [58.4, 23.6]];
    const lines = linesToDraw(ready({ loadId: 'L2', estimated: true, coordinates: straight2, reason: 'NOT_ROUTABLE', pointsKey: keyOf(L2) }), [L1, L2], DEPOT);
    expect(lines).toEqual([
      { loadId: 'L1', coordinates: straightTour(DEPOT, L1.stops), dashed: true },
      { loadId: 'L2', coordinates: straight2, dashed: true, reason: 'NOT_ROUTABLE' },
    ]);
  });

  it('a load with no located stop away from the depot gets no line at all', () => {
    const onDepot: MapLoadStops = { id: 'D', stops: [{ lat: DEPOT.lat, lng: DEPOT.lng }] };
    const unlocated: MapLoadStops = { id: 'U', stops: [{ lat: null, lng: null }] };
    const rows = ready(
      { loadId: 'D', estimated: false, coordinates: straightTour(DEPOT, onDepot.stops), noPath: true, pointsKey: keyOf(onDepot) },
      { loadId: 'U', estimated: false, coordinates: straightTour(DEPOT, unlocated.stops), noPath: true, pointsKey: keyOf(unlocated) },
      { loadId: 'L1', estimated: false, coordinates: ROAD1, pointsKey: keyOf(L1) },
    );
    expect(linesToDraw(rows, [onDepot, unlocated, L1], DEPOT).map((l) => l.loadId)).toEqual(['L1']);
    expect(linesToDraw({ status: 'failed' }, [onDepot, unlocated], DEPOT)).toEqual([]);
  });
});

describe('drawnShapes - the caption counts the lines drawn, not the answer rows', () => {
  const old1: MapLoadStops = { id: 'old1', stops: [{ lat: 23.61, lng: 58.41 }] };
  const old2: MapLoadStops = { id: 'old2', stops: [{ lat: 23.7, lng: 58.5 }] };
  const road = (l: MapLoadStops, id = l.id): GeoRow => ({ loadId: id, estimated: false, coordinates: straightTour(DEPOT, l.stops), pointsKey: keyOf(l) });

  it("an answer for other load ids (another dispatcher's \"Use instead\" made new loads) never reads as OSRM over dashed lines", () => {
    // Review: rows for new1/new2 (both road shapes), loads old1/old2 on screen: both drawn dashed, and
    // the caption (which counted only the rows) said "Lines follow the road network (OSRM)."
    const geo = ready(road(old1, 'new1'), road(old2, 'new2'));
    expect(linesToDraw(geo, [old1, old2], DEPOT).map((l) => l.dashed)).toEqual([true, true]);
    const c = roadShapesCaption(drawnShapes(geo, [old1, old2], DEPOT));
    expect(c.text).not.toBe(ROAD_TEXT);
    expect(c).toEqual({ text: FAILED_TEXT, warn: true, canRetry: true });
  });

  it('partial overlap (a locked load keeps its id): counts the one without a row as straight', () => {
    const c = roadShapesCaption(drawnShapes(ready(road(old1), road(old2, 'new2')), [old1, old2], DEPOT));
    expect(c.text).toBe('1 load of 2 is drawn as a straight dashed line: its road shape could not be loaded. The other lines follow the road network (OSRM).');
  });

  it('same load id, other stops: straight, not the other content drawn solid under an OSRM caption', () => {
    const movedOld2: MapLoadStops = { id: 'old2', stops: [{ lat: 23.9, lng: 58.9 }] };
    const c = roadShapesCaption(drawnShapes(ready(road(old1), road(movedOld2)), [old1, old2], DEPOT));
    expect(c.text).toMatch(/^1 load of 2 is drawn as a straight dashed line/);
  });

  it('matching rows: exactly what the server said, reasons included', () => {
    expect(roadShapesCaption(drawnShapes(ready(road(old1), road(old2)), [old1, old2], DEPOT)).text).toBe(ROAD_TEXT);
    const notSetUp = ready({ ...road(old1), estimated: true, reason: 'NOT_CONFIGURED' }, { ...road(old2), estimated: true, reason: 'NOT_CONFIGURED' });
    expect(roadShapesCaption(drawnShapes(notSetUp, [old1, old2], DEPOT)).text).toBe('Straight dashed lines: road routing (OSRM) is not set up, so the map has no road shapes.');
  });

  it('loads with no line are in no count; loading and failed pass through', () => {
    const onDepot: MapLoadStops = { id: 'D', stops: [{ lat: DEPOT.lat, lng: DEPOT.lng }] };
    const geo = ready({ loadId: 'D', estimated: false, coordinates: [], noPath: true, pointsKey: keyOf(onDepot) }, { ...road(old1), estimated: true, reason: 'NOT_CONFIGURED' });
    expect(roadShapesCaption(drawnShapes(geo, [onDepot, old1], DEPOT)).text).toBe('Straight dashed lines: road routing (OSRM) is not set up, so the map has no road shapes.');
    expect(drawnShapes(GEO_LOADING, [old1], DEPOT)).toBe(GEO_LOADING);
    expect(drawnShapes({ status: 'failed' }, [old1], DEPOT)).toEqual({ status: 'failed' });
    expect(roadShapesCaption(drawnShapes({ status: 'failed' }, [onDepot], DEPOT)).text).toBe('No lines to show.');
  });
});

describe('answerIsStale - the answer is for other content than the screen', () => {
  const road = (l: MapLoadStops, id = l.id): GeoRow => ({ loadId: id, estimated: false, coordinates: ROAD1, pointsKey: keyOf(l) });

  it('other load ids, a load the screen does not have, or a load missing from the answer', () => {
    expect(answerIsStale(ready(road(L1, 'N1'), road(L2, 'N2')), [L1, L2], DEPOT)).toBe(true);
    expect(answerIsStale(ready(road(L1), road(L2), road(L2, 'N3')), [L1, L2], DEPOT)).toBe(true);
    expect(answerIsStale(ready(road(L1)), [L1, L2], DEPOT)).toBe(true);
  });

  it('same load id with other stops (the pin of a stop planned before snapshots moved on the server)', () => {
    const movedL2: MapLoadStops = { id: 'L2', stops: [{ lat: 23.71, lng: 58.5 }] };
    expect(answerIsStale(ready(road(L1), road(movedL2)), [L1, L2], DEPOT)).toBe(true);
  });

  it('not stale: matching rows (estimated or not), rows of an older server without fingerprints, loading, failed', () => {
    expect(answerIsStale(ready(road(L1), { ...road(L2), estimated: true, reason: 'TIMEOUT' }), [L1, L2], DEPOT)).toBe(false);
    expect(answerIsStale(ready({ loadId: 'L1', estimated: false, coordinates: ROAD1 }, { loadId: 'L2', estimated: false, coordinates: ROAD1 }), [L1, L2], DEPOT)).toBe(false);
    expect(answerIsStale(GEO_LOADING, [L1], DEPOT)).toBe(false);
    expect(answerIsStale({ status: 'failed' }, [L1], DEPOT)).toBe(false);
    expect(answerIsStale(ready(), [], DEPOT)).toBe(false);
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
    const due = { retrying: false, alreadyRetried: false, stale: false };
    expect(autoRetryDue(errored, due)).toBe(true);
    expect(autoRetryDue({ status: 'failed' }, due)).toBe(true);
    expect(autoRetryDue(errored, { ...due, retrying: true })).toBe(false);
    expect(autoRetryDue(errored, { ...due, alreadyRetried: true })).toBe(false);
    expect(autoRetryDue(GEO_LOADING, due)).toBe(false);
    expect(autoRetryDue(ready({ loadId: 'L1', estimated: false, coordinates: ROAD1 }), due)).toBe(false);
    // A stale answer: the plan is reloaded instead (asking for the same shapes again cannot help).
    expect(autoRetryDue(errored, { ...due, stale: true })).toBe(false);
  });
});

/**
 * A MapLibre-like map (maplibre-gl 4.7.1): 'style.load' fires once the style itself has loaded
 * (style._loaded), a frame after the map is made; 'load' fires once per map, and only when every tile
 * of the view has loaded or failed (Map._render -> loaded()); isStyleLoaded() is false while any tile
 * is pending. A tile that never answers keeps 'load' from firing.
 */
function fakeMap() {
  const listeners = { 'style.load': new Set<() => void>(), load: new Set<() => void>() };
  const onceLoad = new Set<() => void>();
  const style = { _loaded: false };
  let loadFired = false;
  let tilesPending = 0;
  const maybeFireLoad = () => {
    if (loadFired || !style._loaded || tilesPending > 0) return;
    loadFired = true;
    for (const fn of [...listeners.load, ...onceLoad]) fn();
    onceLoad.clear();
  };
  return {
    style,
    on: vi.fn((t: 'style.load' | 'load', fn: () => void) => listeners[t].add(fn)),
    off: vi.fn((t: 'style.load' | 'load', fn: () => void) => {
      listeners[t].delete(fn);
      onceLoad.delete(fn);
    }),
    once: (_t: 'load', fn: () => void) => onceLoad.add(fn),
    isStyleLoaded: () => style._loaded && tilesPending === 0,
    loadFired: () => loadFired,
    /** The style JSON is processed: the base map's first tiles are asked for (`tiles` of them). */
    fireStyleLoad(tiles = 0) {
      style._loaded = true;
      tilesPending = tiles;
      for (const fn of [...listeners['style.load']]) fn();
      maybeFireLoad();
    },
    setTilesPending(n: number) {
      tilesPending = n;
      maybeFireLoad();
    },
    listenerCount: () => listeners['style.load'].size + listeners.load.size + onceLoad.size,
  };
}

describe('createDrawGate', () => {
  it('waits for the style, then runs only the newest draw once', () => {
    const m = fakeMap();
    const g = createDrawGate(m);
    const a = vi.fn();
    const b = vi.fn();
    g.run(a);
    g.run(b);
    expect(a).not.toHaveBeenCalled();
    expect(b).not.toHaveBeenCalled();
    m.fireStyleLoad();
    expect(a).not.toHaveBeenCalled();
    expect(b).toHaveBeenCalledTimes(1);
  });

  it("draws as soon as the style has loaded while the first tiles are still on their way: never waits for the map's 'load'", () => {
    // Review: the gate waited for 'load', which waits for every tile of the first view. With 3 s tiles
    // the map stayed empty for 3 s; with one tile that never answers it stayed empty until the
    // dispatcher moved it, both under the caption "Lines follow the road network (OSRM)".
    const m = fakeMap();
    const g = createDrawGate(m);
    const draw = vi.fn();
    g.run(draw); // the depot and stops (and the shapes, when they came first)
    m.fireStyleLoad(8); // 8 base-map tiles asked for; one of them will never answer
    m.setTilesPending(1);
    expect(m.loadFired()).toBe(false);
    expect(draw).toHaveBeenCalledTimes(1);
    const roadShapes = vi.fn();
    g.run(roadShapes); // the shapes arrive while that tile still hangs
    expect(roadShapes).toHaveBeenCalledTimes(1);
    expect(m.loadFired()).toBe(false);
  });

  it('a map whose style had already loaded when the gate was made: draws at once', () => {
    const m = fakeMap();
    m.fireStyleLoad(4);
    const draw = vi.fn();
    createDrawGate(m).run(draw);
    expect(draw).toHaveBeenCalledTimes(1);
  });

  it('once ready, a draw runs at once while tiles load (the race that left straight lines)', () => {
    const m = fakeMap();
    const g = createDrawGate(m);
    m.fireStyleLoad(0);
    expect(m.loadFired()).toBe(true);
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
    expect(old).not.toHaveBeenCalled();
  });

  it('cancel drops a waiting draw; dispose also stops listening to the map', () => {
    const m = fakeMap();
    const g = createDrawGate(m);
    const a = vi.fn();
    g.run(a);
    g.cancel();
    m.fireStyleLoad();
    expect(a).not.toHaveBeenCalled();

    const m2 = fakeMap();
    const g2 = createDrawGate(m2);
    const b = vi.fn();
    g2.run(b);
    expect(m2.listenerCount()).toBe(1);
    expect(m2.on).toHaveBeenCalledWith('style.load', expect.any(Function));
    g2.dispose();
    expect(m2.listenerCount()).toBe(0);
    m2.fireStyleLoad();
    expect(b).not.toHaveBeenCalled();
  });
});

describe('components/plan-map.tsx stays on these rules (static guards)', () => {
  const src = readFileSync(path.resolve(__dirname, '../../components/plan-map.tsx'), 'utf8');
  const stateSrc = readFileSync(path.resolve(__dirname, '../../lib/dispatch/plan-map-state.ts'), 'utf8');
  const planView = readFileSync(path.resolve(__dirname, '../../app/t/[slug]/dispatch/plan-view.tsx'), 'utf8');
  const count = (re: RegExp) => [...src.matchAll(re)].length;

  it("draws only through the draw gate, which waits for the style only: never the map's 'load' event or isStyleLoaded()", () => {
    expect(src).not.toMatch(/isStyleLoaded|\.once\(\s*'load'|\.on\(\s*'load'/);
    expect(src).toMatch(/const g = createDrawGate\(m\);/);
    expect(src).toMatch(/g\.run\(draw\);\s*return \(\) => g\.cancel\(\);/);
    expect(src).toMatch(/g\.dispose\(\);/);
    expect(stateSrc).toMatch(/map\.on\('style\.load', onStyleLoad\);/);
    expect(stateSrc).toMatch(/let ready = !!map\.style\?\._loaded;/);
    expect(stateSrc).not.toMatch(/\.(on|once)\(\s*'load'/);
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
    expect(src).toMatch(/if \(!autoRetryDue\(geo, \{ retrying, alreadyRetried: autoRetried\.current, stale \}\)\) return;/);
    expect(src).toMatch(/const caption = roadShapesCaption\(drawnShapes\(geo, loads, depotAt\), \{ retrying \}\);/);
    expect(src).not.toMatch(/roadShapesCaption\(geo\b/);
    expect(src).toMatch(/\{caption\.canRetry \? \(/);
    expect(src).toMatch(/\{caption\.text\}/);
  });

  it('an answer for other plan content is never drawn: the shapes are keyed by run and stops', () => {
    expect(src).toMatch(/const geo = shapes\.key === contentKey \? shapes\.geo : GEO_LOADING;/);
  });

  it('a stale answer makes the map reload the plan once by itself, and Retry reloads it too; PlanView passes its reload', () => {
    expect(src).toMatch(/const stale = useMemo\(\(\) => answerIsStale\(geo, loads, depotAt\), \[geo, loads, depotAt\]\);/);
    expect(src).toMatch(/if \(!stale \|\| staleHandled\.current\) return;\s*staleHandled\.current = true;\s*autoRetried\.current = true;\s*catchUp\(\);/);
    expect(src).toMatch(/staleHandled\.current = false;/);
    // The reload first; the shapes again only when it brought the same loads.
    expect(src).toMatch(/\.then\(onStale\)\s*\.catch\(\(\) => null\)\s*\.then\(\(\) => setReloadedFor\(key\)\);/);
    expect(src).toMatch(/if \(reloadedFor === contentKey\) retry\(\);/);
    expect(src).toMatch(/onClick=\{stale \? catchUp : retry\}/);
    expect(planView).toMatch(/<PlanMap[^>]*\bonStale=\{load\}/);
  });
});
