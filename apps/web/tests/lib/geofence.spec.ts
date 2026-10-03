/**
 * The automatic stop timer (owner request 4 Oct 2026, spec section 7.4): the 25 required cases on
 * synthetic tracks. Pins are synthetic points around 23.6 N, 58.4 E; distances are in metres east /
 * north of a pin. Customers ACME, BETA and the rest are synthetic.
 */
import { describe, expect, it } from 'vitest';
import {
  chooseCustomer,
  currentTrip,
  geofenceParams,
  initialTracker,
  manualArrive,
  restoreTracker,
  step,
  trackStops,
  zoneOf,
  type Fix,
  type TrackEvent,
  type TrackPrompt,
  type TrackStop,
  type TrackerState,
} from '@/lib/delivery/geofence';

const P = geofenceParams(100);
const BASE = { lat: 23.6, lng: 58.4 };
const M_LAT = 1 / 111_320;
const M_LNG = 1 / (111_320 * Math.cos((BASE.lat * Math.PI) / 180));
const T0 = Date.UTC(2026, 9, 5, 5, 0, 0); // 5 Oct 2026, 09:00 Asia/Muscat

/** A point `east` / `north` metres from `from`. */
const at = (east: number, north: number, from = BASE) => ({ lat: from.lat + north * M_LAT, lng: from.lng + east * M_LNG });

const ACME = at(0, 0);
const BETA = at(40, 0); // a neighbour shop 40 m away
const GAMMA = at(3000, 0);
const DEPOT = at(-5000, 0);

function stopAt(key: string, pin: { lat: number; lng: number }, over: Partial<TrackStop> = {}): TrackStop {
  const [loadNo, sequence] = key.split(':').map(Number) as [number, number];
  return { key, loadNo, sequence, lat: pin.lat, lng: pin.lng, doneAt: null, expected: false, nearDepot: false, ...over };
}

function fix(sec: number, pin: { lat: number; lng: number }, east = 0, north = 0, over: Partial<Fix> = {}): Fix {
  const p = at(east, north, pin);
  return { at: T0 + sec * 1000, gpsAt: T0 + sec * 1000, lat: p.lat, lng: p.lng, accuracyM: 10, speedMps: 0, ...over };
}

interface Run {
  state: TrackerState;
  events: TrackEvent[];
  prompts: TrackPrompt[];
}

/** Steps one fix per entry at its own time (now = fix.at unless given), collecting events and prompts. */
function feed(run: Run, fixes: (Fix | { now: number; fix: Fix | null; visible?: boolean })[], stops: TrackStop[] | (() => TrackStop[]), depot: { lat: number; lng: number } | null = DEPOT): Run {
  for (const f of fixes) {
    const input = 'now' in f ? f : { now: f.at, fix: f };
    const r = step(run.state, { now: input.now, fix: input.fix, visible: 'visible' in input ? input.visible !== false : true, stops: typeof stops === 'function' ? stops() : stops, depot }, P);
    run.state = r.state;
    run.events.push(...r.events);
    run.prompts.push(...r.prompts);
  }
  return run;
}

const fresh = (): Run => ({ state: initialTracker(), events: [], prompts: [] });
/** Fixes every `every` seconds from `from` to `to` (inclusive) at a point. */
function track(from: number, to: number, pin: { lat: number; lng: number }, east = 0, north = 0, every = 5, over: Partial<Fix> = {}): Fix[] {
  const out: Fix[] = [];
  for (let s = from; s <= to; s += every) out.push(fix(s, pin, east, north, over));
  return out;
}
const arrivals = (r: Run) => r.events.filter((e): e is Extract<TrackEvent, { type: 'ARRIVED' }> => e.type === 'ARRIVED');
const departures = (r: Run) => r.events.filter((e): e is Extract<TrackEvent, { type: 'DEPARTED' }> => e.type === 'DEPARTED');

describe('zone of one fix (spec section 7.2)', () => {
  it('5. d = 140 m with 60 m accuracy and R = 100 is IN (allowance 50); d = 160 m is NEAR', () => {
    expect(zoneOf(fix(0, ACME, 140, 0, { accuracyM: 60 }), ACME, P)).toBe('IN');
    expect(zoneOf(fix(0, ACME, 160, 0, { accuracyM: 60 }), ACME, P)).toBe('NEAR');
  });

  it('4. a fix with 300 m accuracy is ignored', () => {
    expect(zoneOf(fix(0, ACME, 0, 0, { accuracyM: 300 }), ACME, P)).toBe('IGNORED');
  });
});

describe('arrivals (spec section 7.4)', () => {
  const expected = () => [stopAt('1:1', ACME, { expected: true })];

  it('1. 25 s inside -> ARRIVED at the first inside fix, observed after outside fixes', () => {
    const r = feed(fresh(), [...track(-30, -5, ACME, 400), ...track(0, 25, ACME)], expected());
    expect(arrivals(r)).toEqual([expect.objectContaining({ key: '1:1', at: T0, observed: true })]);
    expect(r.state.phase).toBe('AT_STOP');
  });

  it('2. a 15 s drive-by -> nothing', () => {
    const r = feed(fresh(), [...track(-30, -5, ACME, 400), ...track(0, 15, ACME), ...track(20, 60, ACME, 500)], expected());
    expect(r.events).toEqual([]);
  });

  it('3. inside but at 4 m/s -> nothing', () => {
    const r = feed(fresh(), [...track(-30, -5, ACME, 400), ...track(0, 60, ACME, 0, 0, 5, { speedMps: 4 })], expected());
    expect(r.events).toEqual([]);
  });

  it('4. 300 m accuracy fixes -> ignored', () => {
    const r = feed(fresh(), [...track(-30, -5, ACME, 400), ...track(0, 60, ACME, 0, 0, 5, { accuracyM: 300 })], expected());
    expect(r.events).toEqual([]);
  });

  it('13. a fix older than 30 s never confirms', () => {
    const old = fix(0, ACME);
    const r = feed(fresh(), [...track(-60, -40, ACME, 400), { now: T0 + 31_000, fix: old }, { now: T0 + 45_000, fix: old }], expected());
    expect(r.events).toEqual([]);
  });

  it('14. a stop that already has a result is not picked again', () => {
    const r = feed(fresh(), [...track(-30, -5, ACME, 400), ...track(0, 120, ACME)], [stopAt('1:1', ACME, { doneAt: T0 - 600_000, expected: false })]);
    expect(r.events).toEqual([]);
  });

  it('18. outside fixes up to 10 s before the first inside fix -> observed; the page opened already inside -> not observed + "when?"', () => {
    const seen = feed(fresh(), [fix(-10, ACME, 400), ...track(0, 25, ACME)], expected());
    expect(arrivals(seen)[0]).toMatchObject({ observed: true });
    expect(seen.prompts).toEqual([]);
    const opened = feed(fresh(), track(0, 25, ACME), expected());
    expect(arrivals(opened)[0]).toMatchObject({ observed: false, resumed: true, at: T0 });
    expect(opened.prompts).toEqual([{ kind: 'ARRIVED_WHEN', key: '1:1' }]);
  });

  it('20. 25 s at a roundabout inside the radius of stop 9 while stop 3 is expected -> nothing (90 s rule); stop 3 then arrives after 20 s', () => {
    const STOP9 = at(1000, 0);
    const stops = [stopAt('1:3', ACME, { expected: true }), stopAt('1:9', STOP9)];
    const r = feed(fresh(), [...track(-30, -5, STOP9, 400), ...track(0, 25, STOP9), ...track(30, 55, ACME, 400), ...track(60, 85, ACME)], stops);
    expect(arrivals(r)).toEqual([expect.objectContaining({ key: '1:3', at: T0 + 60_000, observed: true })]);
  });

  it('21. a customer pin 120 m from the depot (R = 100) never arrives automatically', () => {
    const nearDepot = at(120, 0, DEPOT);
    const stops = trackStops(1, [{ key: '1:1', sequence: 1, lat: nearDepot.lat, lng: nearDepot.lng, doneAt: null, visited: false }], DEPOT, P);
    expect(stops[0]).toMatchObject({ nearDepot: true, expected: true });
    const r = feed(fresh(), [...track(-60, -5, nearDepot, 400), ...track(0, 180, nearDepot)], stops);
    expect(r.events).toEqual([]);
  });

  it('22. fixes whose gpsAt is 5 min off the device clock still arrive', () => {
    const skewed = (f: Fix) => ({ ...f, gpsAt: f.at - 300_000 });
    const r = feed(fresh(), [...track(-30, -5, ACME, 400), ...track(0, 25, ACME)].map(skewed), expected());
    expect(arrivals(r)).toHaveLength(1);
  });
});

describe('departures (spec section 7.4)', () => {
  const arrived = () => feed(fresh(), [...track(-30, -5, ACME, 400), ...track(0, 25, ACME)], [stopAt('1:1', ACME, { expected: true })]);

  it('6. after arrival: jitter between 120 and 160 m -> no departure', () => {
    const r = arrived();
    const jitter: Fix[] = [];
    for (let s = 30; s <= 300; s += 5) jitter.push(fix(s, ACME, s % 10 === 0 ? 120 : 160, 0, { accuracyM: 15 }));
    feed(r, jitter, [stopAt('1:1', ACME, { expected: true })]);
    expect(departures(r)).toEqual([]);
    expect(r.state.phase).toBe('AT_STOP');
  });

  it('7. 70 s at 200 m -> DEPARTED at the first outside fix', () => {
    const r = arrived();
    feed(r, track(30, 100, ACME, 200), [stopAt('1:1', ACME, { expected: true })]);
    expect(departures(r)).toEqual([expect.objectContaining({ key: '1:1', at: T0 + 30_000, reason: 'LEFT' })]);
    expect(departures(r)[0]!.gap).toBeUndefined();
    expect(r.state.phase).toBe('SEEKING');
  });

  it('8. a single outside fix then back inside -> no departure', () => {
    const r = arrived();
    feed(r, [fix(30, ACME, 300), ...track(35, 200, ACME)], [stopAt('1:1', ACME, { expected: true })]);
    expect(departures(r)).toEqual([]);
  });

  it('9. GPS lost while at the stop -> no events', () => {
    const r = arrived();
    const before = r.events.length;
    feed(
      r,
      [30, 60, 120, 300, 900].map((s) => ({ now: T0 + s * 1000, fix: null })),
      [stopAt('1:1', ACME, { expected: true })],
    );
    expect(r.events.length).toBe(before);
    expect(r.state).toMatchObject({ phase: 'AT_STOP', gap: true, cleanSince: null });
  });

  it('12. a false arrival in traffic, its departure, then the real arrival -> two cycles', () => {
    const stops = [stopAt('1:1', ACME, { expected: true })];
    const r = feed(fresh(), [...track(-30, -5, ACME, 400), ...track(0, 25, ACME, 60), ...track(30, 100, ACME, 300), ...track(105, 135, ACME)], stops);
    expect(r.events.map((e) => e.type)).toEqual(['ARRIVED', 'DEPARTED', 'ARRIVED']);
    expect(arrivals(r)[1]).toMatchObject({ at: T0 + 105_000, observed: true });
  });

  it('16. GPS lost 4 min (a tunnel) at the stop after its result, then an outside fix -> DEPARTED with gap; no chained arrival', () => {
    let doneAt: number | null = null;
    const stops = () => [stopAt('1:1', ACME, { doneAt, expected: doneAt === null }), stopAt('1:2', BETA, { expected: doneAt !== null })];
    const r = arrived();
    // At ACME until 590 s; then a tunnel: the result is recorded at 600 s without a fix; the
    // neighbour shop BETA is 40 m away.
    feed(r, track(30, 590, ACME, 0, 0, 10), stops);
    feed(r, [{ now: T0 + 595_000, fix: null }], stops);
    doneAt = T0 + 600_000;
    feed(r, [{ now: T0 + 700_000, fix: null }, { now: T0 + 830_000, fix: null }, fix(840, ACME, 0, 900)], stops);
    expect(departures(r)).toEqual([expect.objectContaining({ key: '1:1', at: T0 + 590_000, gap: true })]);
    expect(arrivals(r).filter((a) => a.chained)).toEqual([]);
  });

  it('15. hidden 25 min after a result at A (Maps in front), resumed at B 3 km away -> DEPARTED(A, last inside fix, gap) and ARRIVED(B) not observed; no chained arrival', () => {
    const doneAt = T0 + 300_000;
    const stops = () => [stopAt('1:1', ACME, { doneAt }), stopAt('1:2', GAMMA, { expected: true })];
    const r = arrived();
    feed(r, [...track(30, 310, ACME, 0, 0, 10), { now: T0 + 315_000, fix: fix(310, ACME), visible: false }], stops);
    const back = T0 + 315_000 + 25 * 60_000;
    feed(r, [{ now: back, fix: { ...fix(0, GAMMA), at: back } }, { now: back + 25_000, fix: { ...fix(0, GAMMA), at: back + 25_000 } }], stops);
    expect(departures(r)).toEqual([expect.objectContaining({ key: '1:1', at: T0 + 310_000, gap: true })]);
    expect(arrivals(r).at(-1)).toMatchObject({ key: '1:2', at: back, observed: false, resumed: true });
    expect(arrivals(r).filter((a) => a.chained)).toEqual([]);
    expect(r.prompts).toContainEqual({ kind: 'ARRIVED_WHEN', key: '1:2' });
  });
});

describe('shops close together (spec section 7.4)', () => {
  it('10. two pending stops inside the radius together -> no automatic arrival; "Which customer?"; the chosen stop gets the first common inside fix', () => {
    const stops = [stopAt('1:1', ACME, { expected: true }), stopAt('1:2', BETA)];
    const r = feed(fresh(), [...track(-30, -5, ACME, 400), ...track(0, 60, ACME, 20)], stops);
    expect(r.events).toEqual([]);
    expect(r.prompts).toEqual([{ kind: 'WHICH_CUSTOMER', keys: ['1:1', '1:2'] }]);
    const c = chooseCustomer(r.state, '1:2');
    expect(c.events).toEqual([expect.objectContaining({ type: 'ARRIVED', key: '1:2', at: T0, observed: true, chosen: true })]);
    expect(c.state).toMatchObject({ phase: 'AT_STOP', key: '1:2' });
  });

  it('11. neighbour shops 40 m apart with continuous fixes after a result -> DEPARTED(A, result, NEXT_STOP) and ARRIVED(B, result, chained)', () => {
    let doneAt: number | null = null;
    const stops = () => [stopAt('1:1', ACME, { expected: doneAt === null, doneAt }), stopAt('1:2', BETA, { expected: doneAt !== null })];
    const r = feed(fresh(), [...track(-30, -5, ACME, 400), ...track(0, 30, ACME, 20)], stops);
    const chosen = chooseCustomer(r.state, '1:1');
    r.state = chosen.state;
    r.events.push(...chosen.events);
    feed(r, track(35, 300, ACME, 20), stops);
    doneAt = T0 + 300_000;
    feed(r, track(305, 330, ACME, 20), stops);
    expect(r.events.slice(1)).toEqual([
      expect.objectContaining({ type: 'DEPARTED', key: '1:1', at: doneAt, reason: 'NEXT_STOP' }),
      expect.objectContaining({ type: 'ARRIVED', key: '1:2', at: doneAt, chained: true, observed: true, from: '1:1' }),
    ]);
  });

  it('17. neighbour pins 300 m apart (more than R + 50) -> never chained, even with continuous fixes', () => {
    const FAR = at(300, 0);
    const doneAt = T0 + 120_000;
    const stops = () => [stopAt('1:1', ACME, { doneAt }), stopAt('1:2', FAR, { expected: true })];
    const r = feed(fresh(), [...track(-30, -5, ACME, 400), ...track(0, 25, ACME)], [stopAt('1:1', ACME, { expected: true }), stopAt('1:2', FAR)]);
    feed(r, [...track(30, 125, ACME), ...track(130, 160, FAR, 0, 0, 5), ...track(165, 260, FAR)], stops);
    expect(arrivals(r).filter((a) => a.chained)).toEqual([]);
    expect(departures(r)).toEqual([expect.objectContaining({ key: '1:1', reason: 'LEFT' })]);
    // The arrival at the next shop keeps the time it was first seen inside, observed.
    expect(arrivals(r).at(-1)).toMatchObject({ key: '1:2', at: T0 + 130_000, observed: true });
  });
});

describe('trips, the depot and reloads (spec section 7.4)', () => {
  it('19. trip 1 stop 7 without a result and trip 2 dispatched to the same customer -> the arrival goes to trip 2\'s stop', () => {
    const trip = currentTrip(
      [
        { loadNo: 1, status: 'DISPATCHED', departMin: 420, back: false },
        { loadNo: 2, status: 'DISPATCHED', departMin: 780, back: false },
      ],
      { started: true, nowMin: 800 },
    );
    expect(trip).toEqual({ loadNo: 2, held: false });
    const stops = trackStops(2, [{ key: '2:1', sequence: 1, lat: ACME.lat, lng: ACME.lng, doneAt: null, visited: false }], DEPOT, P);
    const r = feed(fresh(), [...track(-30, -5, ACME, 400), ...track(0, 25, ACME)], stops);
    expect(arrivals(r)).toEqual([expect.objectContaining({ key: '2:1' })]);
  });

  it('23. two minutes at the depot after the trip\'s stops -> the "Back at depot?" prompt, no event', () => {
    const stops = [stopAt('1:1', ACME, { doneAt: T0 - 600_000, visited: true })];
    const r = feed(fresh(), track(0, 130, DEPOT), stops);
    expect(r.events).toEqual([]);
    expect(r.prompts).toEqual([{ kind: 'BACK_AT_DEPOT' }]);
    // Before any stop of the trip was visited: nothing.
    const early = feed(fresh(), track(0, 130, DEPOT), [stopAt('1:1', ACME)]);
    expect(early.prompts).toEqual([]);
  });

  it('24. restoreTracker: a server ARRIVED stop and an unsent local arrival each come back AT_STOP with their arrival time', () => {
    const fromServer = restoreTracker({ key: '1:3', arrivedAt: T0, observed: true });
    expect(fromServer).toMatchObject({ phase: 'AT_STOP', key: '1:3', arrivedAt: T0, observed: true, cleanSince: null });
    const fromQueue = restoreTracker({ key: '1:4', arrivedAt: T0 + 60_000, observed: false });
    expect(fromQueue).toMatchObject({ phase: 'AT_STOP', key: '1:4', arrivedAt: T0 + 60_000, observed: false });
    expect(restoreTracker(null).phase).toBe('SEEKING');
    // The timer keeps counting: still at the stop after the reload, no new arrival.
    const r: Run = { state: fromServer, events: [], prompts: [] };
    feed(r, track(600, 660, ACME), [stopAt('1:3', ACME, { expected: true })]);
    expect(r.events).toEqual([]);
    expect(r.state).toMatchObject({ phase: 'AT_STOP', arrivedAt: T0 });
  });

  it('25. currentTrip: a LOCKED load after Start -> held; the highest DISPATCHED load wins over an earlier one with stops left', () => {
    const loads = [
      { loadNo: 1, status: 'LOCKED', departMin: 430, back: false },
      { loadNo: 2, status: 'PLANNED', departMin: 800, back: false },
    ];
    expect(currentTrip(loads, { started: false, nowMin: 420 })).toBeNull();
    expect(currentTrip(loads, { started: true, nowMin: 395 })).toBeNull(); // 35 min before departure
    expect(currentTrip(loads, { started: true, nowMin: 405 })).toEqual({ loadNo: 1, held: true });
    expect(
      currentTrip(
        [
          { loadNo: 1, status: 'DISPATCHED', departMin: 430, back: false },
          { loadNo: 2, status: 'DISPATCHED', departMin: 800, back: false },
        ],
        { started: false, nowMin: 820 },
      ),
    ).toEqual({ loadNo: 2, held: false });
    // Trip 2 back at the depot: trip 1 (still out) is the current trip again.
    expect(
      currentTrip(
        [
          { loadNo: 1, status: 'DISPATCHED', departMin: 430, back: false },
          { loadNo: 2, status: 'DISPATCHED', departMin: 800, back: true },
        ],
        { started: false, nowMin: 900 },
      ),
    ).toEqual({ loadNo: 1, held: false });
  });

  it('a manual arrival with a wrong pin never departs before its result', () => {
    const stops = () => [stopAt('1:1', ACME, { expected: true })];
    const r: Run = { state: manualArrive(feed(fresh(), track(-10, 0, ACME, 500), stops()).state, '1:1', T0), events: [], prompts: [] };
    feed(r, track(5, 300, ACME, 500), stops);
    expect(r.events).toEqual([]);
    expect(r.state).toMatchObject({ phase: 'AT_STOP', key: '1:1' });
  });
});
