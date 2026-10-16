/**
 * The GPS stop detector of the IVMS live link (lib/ivms/stops.ts; design section 6.1 with the binding
 * review's H3/H4/M2/M11/M12). Synthetic trails only: an invented depot in empty desert and invented
 * pins as metre offsets from it; trucks and customers are made up.
 */
import { describe, expect, it } from 'vitest';
import { detectTruckDay, matchTripsToLoads, staysAt, trackerMismatch, trailDepotMoves, tripsOf, type DetectorInput, type DetectorLoad, type DetectorStop, type DetectedTrip } from '@/lib/ivms/stops';
import { DETECTOR_FIXED, type DetectorParams, type TrailPoint } from '@/lib/ivms/types';
import { T, Trail, at, hhmm } from './ivms-trail';

const DEPOT = { depotId: 'dep1', ...at(0) };
const P: DetectorParams = { stopRadiusM: 100, dwellMin: 3, depotRadiusM: 300, ...DETECTOR_FIXED };

const stop = (sequence: number, east: number, north = 0, over: Partial<DetectorStop> = {}): DetectorStop => ({ sequence, pin: at(east, north), resultAt: null, officeArrival: false, ...over });
const load = (loadNo: number, stops: DetectorStop[], over: Partial<DetectorLoad> = {}): DetectorLoad => ({
  depotId: 'dep1',
  loadNo,
  status: 'DISPATCHED',
  dispatchedAt: T('06:55'),
  plannedDepartAt: T('07:00'),
  stops,
  ...over,
});
const input = (points: TrailPoint[], loads: DetectorLoad[], over: Partial<DetectorInput> = {}): DetectorInput => ({ points, depots: [DEPOT], zoneMoves: [], loads, params: P, ...over });
const brief = (out: ReturnType<typeof detectTruckDay>) => out.candidates.map((c) => `L${c.loadNo}.${c.sequence} ${c.kind} ${hhmm(c.at)}${c.observed ? '' : ' (not observed)'}`);

describe('a clean trip', () => {
  const trail = new Trail('06:30').park(30).drive(3000).park(10).drive(6000).park(8).drive(0).park(20);
  const out = detectTruckDay(input(trail.pts, [load(1, [stop(1, 3000), stop(2, 6000)])]));

  it('finds the depot OUT and IN, one trip, matched to the load', () => {
    // OUT at the first point past the depot radius + 50 m (07:01, 667 m out), IN at the first inside.
    expect(out.trailMoves.map((m) => `${m.kind} ${hhmm(m.at)}`)).toEqual(['DEPOT_OUT 07:01', 'DEPOT_IN 07:36']);
    expect(out.trips).toHaveLength(1);
    expect(out.trips[0]).toMatchObject({ loadNo: 1, openStart: false });
  });

  it('gives each stop an observed arrival at the first point inside and a departure at the first point out', () => {
    expect(brief(out)).toEqual(['L1.1 ARRIVED 07:04', 'L1.1 DEPARTED 07:15', 'L1.2 ARRIVED 07:19', 'L1.2 DEPARTED 07:27']);
    expect(out.candidates[0]!.at).toEqual(T('07:04:30'));
    for (const c of out.candidates) {
      // The arrival is the first point inside the radius; the departure the first point past radius + 50 m.
      if (c.kind === 'ARRIVED') expect(c.distanceM).toBeLessThanOrEqual(100);
      else expect(c.distanceM).toBeGreaterThan(150);
      expect(c.segmentStartAt.getTime()).toBe(out.candidates.find((x) => x.sequence === c.sequence && x.kind === 'ARRIVED')!.at.getTime());
    }
    expect(out.ambiguities).toEqual([]);
  });
});

describe('what is not a stop', () => {
  it('a drive-by, a traffic jam shorter than the dwell, a stop with no slow point', () => {
    const driveBy = new Trail('06:30').park(30).drive(3000).drive(6000).park(30);
    expect(detectTruckDay(input(driveBy.pts, [load(1, [stop(1, 3000)])])).candidates).toEqual([]);
    const jam = new Trail('06:30').park(30).drive(2950).park(2).drive(6000).park(30);
    expect(detectTruckDay(input(jam.pts, [load(1, [stop(1, 3000)])])).candidates).toEqual([]);
  });

  it('a stop whose result was recorded before the stay, or that the office set an arrival for', () => {
    const trail = new Trail('06:30').park(30).drive(3000).park(10).drive(6000).park(30);
    expect(detectTruckDay(input(trail.pts, [load(1, [stop(1, 3000, 0, { resultAt: T('07:00') })])])).candidates).toEqual([]);
    expect(detectTruckDay(input(trail.pts, [load(1, [stop(1, 3000, 0, { officeArrival: true })])])).candidates).toEqual([]);
    // A result recorded during the stay: the stop was pending when the truck arrived.
    expect(brief(detectTruckDay(input(trail.pts, [load(1, [stop(1, 3000, 0, { resultAt: T('07:10') })])])))).toEqual(['L1.1 ARRIVED 07:04', 'L1.1 DEPARTED 07:15']);
  });

  it('a load that is not DISPATCHED or COMPLETED gets nothing (GPS never presses Dispatch)', () => {
    const trail = new Trail('06:30').park(30).drive(3000).park(10).drive(6000).park(30);
    for (const status of ['PLANNED', 'LOCKED', 'LOADING']) expect(detectTruckDay(input(trail.pts, [load(1, [stop(1, 3000)], { status })])).candidates).toEqual([]);
  });
});

describe('observed or not (the budget links precision to the allowance)', () => {
  it('a gap of more than 5 minutes before the first point inside makes the arrival an upper bound', () => {
    const trail = new Trail('06:30').park(30).drive(2000).silent(8).jump(3000).park(10).drive(6000).park(30);
    const out = detectTruckDay(input(trail.pts, [load(1, [stop(1, 3000)])]));
    expect(brief(out)).toEqual(['L1.1 ARRIVED 07:11 (not observed)', 'L1.1 DEPARTED 07:21']);
  });

  it('points every 10 minutes (polling at a low allowance): every arrival and departure is not observed', () => {
    const trail = new Trail('06:30', 0, 0, 600).park(30).drive(3000, 0, 40).park(20).drive(9000, 0, 40).park(60);
    const out = detectTruckDay(input(trail.pts, [load(1, [stop(1, 3000)])]));
    expect(out.candidates.length).toBeGreaterThan(0);
    expect(out.candidates.every((c) => !c.observed)).toBe(true);
  });

  it('a long silence of a parked truck does not end its stay (M11); the departure after it is not observed', () => {
    const trail = new Trail('06:30').park(30).drive(3000).park(5).silent(20).park(5, { ignition: false }).silent(9).drive(6000).park(30);
    const out = detectTruckDay(input(trail.pts, [load(1, [stop(1, 3000)])]));
    // Parked 07:04:30-07:09, silent 20 min, 5 more min with the ignition off, silent 9 min, then away.
    expect(brief(out)).toEqual(['L1.1 ARRIVED 07:04', 'L1.1 DEPARTED 07:44 (not observed)']);
  });
});

describe('a parked truck drifting, one outlier point (a single point never ends a stay)', () => {
  it('drift inside the exit band and one point 200 m off keep one stay', () => {
    const trail = new Trail('06:30').park(30).drive(3000).park(4, { jitterM: 80 }).point(3200).park(4).drive(6000).park(30);
    const out = detectTruckDay(input(trail.pts, [load(1, [stop(1, 3000)])]));
    expect(out.candidates.filter((c) => c.kind === 'ARRIVED')).toHaveLength(1);
    expect(brief(out)).toEqual(['L1.1 ARRIVED 07:04', 'L1.1 DEPARTED 07:13']);
  });
});

describe('two pins inside together, out of sequence, coming back (H4)', () => {
  it('two pending pins with stays at the same time: nothing automatic, a fact for the office', () => {
    const trail = new Trail('06:30').park(30).drive(3000).park(10).drive(6000).park(30);
    const out = detectTruckDay(input(trail.pts, [load(1, [stop(1, 3000, 40), stop(2, 3000, -40)])]));
    expect(out.candidates).toEqual([]);
    expect(out.ambiguities).toEqual([expect.objectContaining({ reason: 'SEVERAL_PINS', loadNo: 1, sequences: [1, 2] })]);
  });

  it('a stop out of sequence needs the longer dwell (6 min); the next in sequence 3 min', () => {
    const short = new Trail('06:30').park(30).drive(6000).park(4).drive(3000).park(4).drive(0).park(30);
    const out = detectTruckDay(input(short.pts, [load(1, [stop(1, 3000), stop(2, 6000)])]));
    expect(out.ambiguities).toEqual([expect.objectContaining({ reason: 'OUT_OF_SEQUENCE_SHORT', sequences: [2] })]);
    expect(brief(out)).toEqual(['L1.1 ARRIVED 07:17', 'L1.1 DEPARTED 07:22']);
    const long = new Trail('06:30').park(30).drive(6000).park(7).drive(3000).park(4).drive(0).park(30);
    expect(brief(detectTruckDay(input(long.pts, [load(1, [stop(1, 3000), stop(2, 6000)])])))).toEqual([
      'L1.2 ARRIVED 07:09',
      'L1.2 DEPARTED 07:16',
      'L1.1 ARRIVED 07:20',
      'L1.1 DEPARTED 07:25',
    ]);
  });

  it('coming back to a stop gives a second stay; never more than two', () => {
    const trail = new Trail('06:30').park(30).drive(3000).park(5).drive(4000).park(5).drive(3000).park(5).drive(4000).park(5).drive(3000).park(5).drive(9000).park(30);
    const out = detectTruckDay(input(trail.pts, [load(1, [stop(1, 3000)])]));
    expect(out.candidates.filter((c) => c.kind === 'ARRIVED')).toHaveLength(2);
    expect(out.candidates.filter((c) => c.kind === 'DEPARTED')).toHaveLength(2);
  });

  it('a stay still in progress at the end of the trail gives an arrival only', () => {
    const trail = new Trail('06:30').park(30).drive(3000).park(6);
    expect(brief(detectTruckDay(input(trail.pts, [load(1, [stop(1, 3000)])])))).toEqual(['L1.1 ARRIVED 07:04']);
  });
});

describe('the depot (H4) and its moves', () => {
  it('a pin near the depot never gets an automatic arrival, also while the truck is loading', () => {
    const trail = new Trail('06:00').park(60).drive(200).park(10).drive(3000).park(10).drive(0).park(30);
    const out = detectTruckDay(input(trail.pts, [load(1, [stop(1, 200), stop(2, 3000)])]));
    expect(out.candidates.every((c) => c.sequence === 2)).toBe(true);
    expect(out.candidates.length).toBe(2);
  });

  it('a truck at the zone edge (290-340 m) does not flap', () => {
    const trail = new Trail('06:00').park(30);
    for (let i = 0; i < 20; i++) trail.point(i % 2 ? 290 : 340);
    trail.drive(3000).park(30);
    const moves = trailDepotMoves(trail.pts, [DEPOT], P).moves;
    expect(moves.map((m) => m.kind)).toEqual(['DEPOT_OUT']);
  });

  it('a provider zone move confirmed by the trail is used (its time); an unconfirmed one (forged) is never a boundary (M6)', () => {
    const trail = new Trail('06:30').park(30).drive(3000).park(10).drive(6000).park(8).drive(0).park(20);
    const out = detectTruckDay(
      input(trail.pts, [load(1, [stop(1, 3000), stop(2, 6000)])], {
        zoneMoves: [
          { id: 'z1', kind: 'DEPOT_OUT', at: T('06:59'), depotId: 'dep1' },
          { id: 'z2', kind: 'DEPOT_IN', at: T('07:15'), depotId: 'dep1' },
        ],
      }),
    );
    expect(out.zoneOutcomes).toEqual([
      { id: 'z1', outcome: 'USED' },
      { id: 'z2', outcome: 'UNCONFIRMED' },
    ]);
    expect(out.trips).toHaveLength(1);
    expect(hhmm(out.trips[0]!.outAt)).toBe('06:59');
    expect(out.trailMoves.map((m) => m.kind)).toEqual(['DEPOT_IN']);
    expect(brief(out)).toHaveLength(4);
  });
});

describe('several loads: trips by depot OUT/IN, matched in dispatch order (H3)', () => {
  // L1 (07:01-07:38) visits a customer at 3000 m (no result recorded there: still pending) and a shop
  // at 6000 m; L2 is dispatched EARLY at 11:00, the truck leaves at 11:39 to the same customer.
  const trail = new Trail('06:30')
    .park(30)
    .drive(3000)
    .park(10)
    .drive(6000)
    .park(10)
    .drive(0)
    .park(240)
    .drive(3000)
    .park(10)
    .drive(0)
    .park(30);
  const shared = (seq: number) => stop(seq, 3000);
  const l1 = load(1, [shared(1), stop(2, 6000)], { dispatchedAt: T('06:55') });
  const l2 = load(2, [shared(1)], { dispatchedAt: T('11:00'), plannedDepartAt: T('11:30') });

  it("each trip's stays go to its own load only", () => {
    const out = detectTruckDay(input(trail.pts, [l2, l1]));
    expect(out.trips.map((t) => t.loadNo)).toEqual([1, 2]);
    expect(out.trips.map((t) => `${hhmm(t.outAt)}-${hhmm(t.inAt!)}`)).toEqual(['07:01-07:38', '11:39-11:57']);
    expect(brief(out)).toEqual(['L1.1 ARRIVED 07:04', 'L1.1 DEPARTED 07:15', 'L1.2 ARRIVED 07:19', 'L1.2 DEPARTED 07:29', 'L2.1 ARRIVED 11:42', 'L2.1 DEPARTED 11:53']);
  });

  it('a COMPLETED load is ordered by its dispatch time, not its completion time', () => {
    const out = detectTruckDay(input(trail.pts, [{ ...l1, status: 'COMPLETED' }, l2]));
    expect(out.trips.map((t) => t.loadNo)).toEqual([1, 2]);
  });

  it('a fuel run between the loads gets no load', () => {
    const fuel = new Trail('06:30').park(30).drive(3000).park(10).drive(0).park(20).drive(1500).park(5).drive(0).park(20).drive(6000).park(10).drive(0).park(30);
    const out = detectTruckDay(input(fuel.pts, [load(1, [stop(1, 3000)]), load(2, [stop(1, 6000)], { dispatchedAt: T('07:40') })]));
    expect(out.trips.map((t) => t.loadNo)).toEqual([1, null, 2]);
    expect(out.candidates.map((c) => `L${c.loadNo}.${c.sequence} ${c.kind}`)).toEqual(['L1.1 ARRIVED', 'L1.1 DEPARTED', 'L2.1 ARRIVED', 'L2.1 DEPARTED']);
  });

  it('Dispatch pressed late, during the trip: the stays before the press are still found', () => {
    const out = detectTruckDay(input(trail.pts.slice(0, 120), [load(1, [stop(1, 3000), stop(2, 6000)], { dispatchedAt: T('07:30') })]));
    expect(brief(out).slice(0, 2)).toEqual(['L1.1 ARRIVED 07:04', 'L1.1 DEPARTED 07:15']);
  });

  it('several loads and no depot boundary at all: nothing is matched', () => {
    const noDepot = new Trail('07:10', 1000).drive(3000).park(10).drive(6000).park(10);
    const out = detectTruckDay(input(noDepot.pts, [load(1, [stop(1, 3000)]), load(2, [stop(1, 6000)], { dispatchedAt: T('08:00') })]));
    expect(out.candidates).toEqual([]);
    expect(out.notes).toEqual(['NO_DEPOT_BOUNDARY']);
    // One load and a trail that started outside: one open trip, matched.
    expect(brief(detectTruckDay(input(noDepot.pts, [load(1, [stop(1, 3000)])])))).toEqual(['L1.1 ARRIVED 07:13', 'L1.1 DEPARTED 07:23']);
  });
});

describe('re-runs over a growing or re-segmented trail (M2)', () => {
  it('a later pull adds the departure; the arrival keeps its first inside fix as segmentStartAt', () => {
    const trail = new Trail('06:30').park(30).drive(3000).park(10).drive(6000).park(30);
    const first = detectTruckDay(input(trail.pts.filter((p) => p.fixAt < T('07:10')), [load(1, [stop(1, 3000)])]));
    const later = detectTruckDay(input(trail.pts, [load(1, [stop(1, 3000)])]));
    expect(brief(first)).toEqual(['L1.1 ARRIVED 07:04']);
    expect(later.candidates[0]!.segmentStartAt.getTime()).toBe(first.candidates[0]!.segmentStartAt.getTime());
  });

  it('a delayed point inside, earlier than the first one, moves the start (the writer keeps the first write)', () => {
    const trail = new Trail('06:30').park(30).drive(3000).park(10).drive(6000).park(30);
    const late: TrailPoint = { fixAt: T('07:04:15'), ...at(2995), speedKmh: 3, ignition: true };
    expect(detectTruckDay(input(trail.pts, [load(1, [stop(1, 3000)])])).candidates[0]!.segmentStartAt).toEqual(T('07:04:30'));
    expect(detectTruckDay(input([...trail.pts, late], [load(1, [stop(1, 3000)])])).candidates[0]!.segmentStartAt).toEqual(T('07:04:15'));
  });
});

describe('building blocks', () => {
  it('trips: a trail starting outside opens a trip; OUT while out and IN while in are ignored', () => {
    const b = (kind: 'DEPOT_IN' | 'DEPOT_OUT', t: string) => ({ kind, at: T(t), depotId: 'dep1' });
    expect(tripsOf([b('DEPOT_IN', '08:00'), b('DEPOT_OUT', '09:00'), b('DEPOT_OUT', '09:05'), b('DEPOT_IN', '10:00'), b('DEPOT_IN', '10:30')], false, T('07:00')).map((t) => `${hhmm(t.outAt)}-${t.inAt ? hhmm(t.inAt) : ''}${t.openStart ? '*' : ''}`)).toEqual([
      '07:00-08:00*',
      '09:00-10:00',
    ]);
  });

  it('matching is order-preserving and leaves a load unmatched rather than paying too much', () => {
    const trip = (out: string, back: string | null): DetectedTrip => ({ outAt: T(out), inAt: back ? T(back) : null, loadNo: null, depotId: 'dep1', openStart: false });
    const trips = [trip('07:00', '10:00'), trip('12:00', null)];
    const loads = [load(1, [], { dispatchedAt: T('06:50') }), load(2, [], { dispatchedAt: T('11:40') })];
    const cost = (l: DetectorLoad, t: DetectedTrip) => Math.abs(t.outAt.getTime() - l.dispatchedAt!.getTime()) / 60_000;
    expect(matchTripsToLoads(trips, loads, cost)).toEqual([0, 1]);
    expect(matchTripsToLoads(trips, loads, () => null)).toEqual([null, null]);
    expect(matchTripsToLoads([trips[1]!], loads, cost)).toEqual([null, 1 - 1]);
  });

  it('stays at a pin: two consecutive far points end it, at the first of them', () => {
    const trail = new Trail('07:00').point(3000).point(3000).point(3000).point(3000).point(3000).point(3000).point(3000).point(3200).point(3300).point(3400);
    const s = staysAt(trail.pts, trail.pts, at(3000), 1, P);
    expect(s).toHaveLength(1);
    expect(hhmm(s[0]!.exit!.fixAt)).toBe('07:03');
  });
});

describe('a tracker on another truck (M8)', () => {
  const trail = new Trail('06:30').park(30).drive(3000).park(10).drive(6000).park(30);
  const near = (t: string, east: number) => ({ at: T(t), ...at(east) });
  it("the driver's phone far from the trail at the same moments, over 10 minutes: mismatch", () => {
    expect(trackerMismatch([near('07:05', 9000), near('07:10', 9000), near('07:20', 12000)], trail.pts)).toBe(true);
  });
  it('agreeing positions, a single far one, a short burst, or no trail point near in time: no mismatch', () => {
    expect(trackerMismatch([near('07:05', 3000), near('07:10', 3010), near('07:20', 6000)], trail.pts)).toBe(false);
    expect(trackerMismatch([near('07:05', 9000), near('07:10', 3000), near('07:12', 3000)], trail.pts)).toBe(false);
    expect(trackerMismatch([near('07:05', 9000), near('07:06', 9000), near('07:07', 9000)], trail.pts)).toBe(false);
    expect(trackerMismatch([near('12:00', 9000), near('12:10', 9000), near('12:20', 9000)], trail.pts)).toBe(false);
  });
});
