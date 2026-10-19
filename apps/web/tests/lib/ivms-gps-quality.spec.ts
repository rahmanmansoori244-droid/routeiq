/**
 * GPS stop detection at big customers (owner request 19 Oct 2026: "at big customers the truck moves between
 * drop points and the model thinks it left"; the GPS study of 18-19 Oct 2026): the detector's new rules
 * (lib/ivms/stops.ts) and the writer's (lib/ivms/stop-events.ts) on synthetic trails:
 *  - a move between drop points within 500 m and back within 10 min is one stay (merged), never across another
 *    open stop; a trip beyond 500 m, or a stop at another customer, is not merged and carries the minutes away;
 *  - the departure is held back until the truck has been away 10 min, is beyond 500 m or reached the depot:
 *    a dock move never writes a DEPARTED, a real departure is written within about 10 min;
 *  - a customer's site radius (100-500 m) ends the stay instead of the stop radius (the arrival still needs it);
 *  - a frozen run (the same coordinates for 60 s or more at a moving speed) is a gap: the event after it is not
 *    observed; no point is dropped for its speed;
 *  - every GPS event's payload carries the stay's summary; the short stays are kept as SHORT_DWELL facts;
 *  - below TIMES nothing is written (as before).
 * Invented data only: an empty-desert depot, trucks T05, shops "Shop Example A/B/C" (ivms-trail.ts offsets).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanTrail, detectTruckDay, FROZEN_RUN_SEC, HOLD_DEPARTED_MIN, MERGE_GAP_MIN, mergeStays, SITE_MAX_M, staysAt, type DetectorInput, type DetectorLoad, type DetectorStop } from '@/lib/ivms/stops';
import { readSiteRadius, SITE_RADIUS_MAX_M, SITE_RADIUS_MIN_M, validSiteRadius } from '@/lib/ivms/site-radius';
import { gpsFactText } from '@/lib/ivms/live-map';
import { DETECTOR_FIXED, type DetectorParams, type TrailPoint } from '@/lib/ivms/types';
import { tables } from './fake-plan-db';
import { T, Trail, at, hhmm } from './ivms-trail';

vi.mock('@/lib/db', async () => ({ prisma: (await import('./fake-plan-db')).fakePrisma }));

const { processGpsTimes, gpsFactsOf, DETECTOR_VERSION, trailCompleteOf } = await import('@/lib/ivms/stop-events');
const { readLiveVehicles } = await import('@/lib/ivms/vehicles');
const { resetDb } = await import('./fake-plan-db');

const P: DetectorParams = { stopRadiusM: 100, dwellMin: 3, depotRadiusM: 300, ...DETECTOR_FIXED };
const DEPOT = { depotId: 'dep1', ...at(0) };
const stop = (sequence: number, east: number, north = 0, over: Partial<DetectorStop> = {}): DetectorStop => ({ sequence, pin: at(east, north), resultAt: null, officeArrival: false, ...over });
const load = (loadNo: number, stops: DetectorStop[], over: Partial<DetectorLoad> = {}): DetectorLoad => ({ depotId: 'dep1', loadNo, status: 'DISPATCHED', dispatchedAt: T('06:55'), plannedDepartAt: T('07:00'), stops, ...over });
const input = (points: TrailPoint[], loads: DetectorLoad[], over: Partial<DetectorInput> = {}): DetectorInput => ({ points, depots: [DEPOT], zoneMoves: [], loads, params: P, ...over });
const brief = (out: ReturnType<typeof detectTruckDay>) => out.candidates.map((c) => `L${c.loadNo}.${c.sequence} ${c.kind} ${hhmm(c.at)}${c.observed ? '' : ' (not observed)'}${c.final === false ? ' (held)' : ''}`);

/** A truck at shop A (3000 m east): 10 min at the pin, a move to a second drop point `north` m away, back to the pin. */
function dockMove(o: { north: number; parkThere: number; kmh?: number; after?: (t: Trail) => Trail }) {
  const t = new Trail('06:30').park(30).drive(3000).park(10).drive(3000, o.north, o.kmh ?? 15).park(o.parkThere).drive(3000, 0, o.kmh ?? 15).park(8);
  return (o.after ?? ((x: Trail) => x.drive(6000).park(10).drive(0).park(20)))(t);
}

describe('a move between drop points of one site (owner request 19 Oct 2026)', () => {
  it('within 500 m and back within 10 min: one stay - the first arrival, the last departure', () => {
    const out = detectTruckDay(input(dockMove({ north: 350, parkThere: 5 }).pts, [load(1, [stop(1, 3000), stop(2, 6000)])]));
    expect(brief(out)).toEqual(['L1.1 ARRIVED 07:04', 'L1.1 DEPARTED 07:31', 'L1.2 ARRIVED 07:35', 'L1.2 DEPARTED 07:45']);
    expect(out.candidates[0]!.stay).toMatchObject({ merged: 1, maxDistM: 350, awayMin: null, exitRule: 'FAST', radiusM: 100 });
    expect(MERGE_GAP_MIN).toBe(10);
    expect(SITE_MAX_M).toBe(500);
  });

  it('back after 10 min or more: two stays, the second with no time away (it stayed on the site)', () => {
    const out = detectTruckDay(input(dockMove({ north: 350, parkThere: 12 }).pts, [load(1, [stop(1, 3000), stop(2, 6000)])]));
    expect(brief(out).filter((x) => x.startsWith('L1.1'))).toEqual(['L1.1 ARRIVED 07:04', 'L1.1 DEPARTED 07:15', 'L1.1 ARRIVED 07:29', 'L1.1 DEPARTED 07:38']);
    expect(out.candidates.filter((c) => c.sequence === 1).map((c) => c.stay!.awayMin)).toEqual([null, null, 0, 0]);
  });

  it('a trip beyond 500 m and back within 10 min is not merged: the second stay carries the minutes away', () => {
    const trail = new Trail('06:30').park(30).drive(3000).park(10).drive(4200, 0, 40).park(4).drive(3000, 0, 40).park(8).drive(6000).park(10).drive(0).park(20);
    const out = detectTruckDay(input(trail.pts, [load(1, [stop(1, 3000), stop(2, 6000)])]));
    const a = out.candidates.filter((c) => c.sequence === 1);
    expect(a.map((c) => `${c.kind} ${hhmm(c.at)}`)).toEqual(['ARRIVED 07:04', 'DEPARTED 07:15', 'ARRIVED 07:22', 'DEPARTED 07:31']);
    // Gone 7.5 min, of which 6.5 beyond 500 m: the minute driving out and back within 500 m is on site.
    expect(a[2]!.stay).toMatchObject({ merged: 0, awayMin: 6.5 });
  });

  it('a long trip to another customer and back: two stays, the minutes away between them', () => {
    // Shop A at 3000 m; the truck drives 6 km away, stands 20 min at another customer of a later load, comes back.
    const trail = new Trail('06:30').park(30).drive(3000).park(30).drive(9000, 0, 40).park(20).drive(3000, 0, 40).park(90).drive(0).park(20);
    const out = detectTruckDay(input(trail.pts, [load(1, [stop(1, 3000)]), load(2, [stop(1, 9000)], { dispatchedAt: T('12:00'), plannedDepartAt: T('12:00') })]));
    const a = out.candidates.filter((c) => c.loadNo === 1);
    expect(a.map((c) => `${c.kind} ${hhmm(c.at)}`)).toEqual(['ARRIVED 07:04', 'DEPARTED 07:35', 'ARRIVED 08:12', 'DEPARTED 09:43']);
    // Gone 37.5 min (07:35-08:12), beyond 500 m for 36.5 of them.
    expect((a[2]!.at.getTime() - a[1]!.at.getTime()) / 60_000).toBeCloseTo(37.5, 0);
    expect(a[2]!.stay!.awayMin).toBe(36.5);
  });

  it('never across a stay at another open stop: not merged, and the next stay counts the time away (stopped at another customer)', () => {
    // Shop B's pin is 250 m from shop A's: the truck stands at B for 5 min between two stays at A.
    const out = detectTruckDay(input(dockMove({ north: 250, parkThere: 5 }).pts, [load(1, [stop(1, 3000), stop(2, 3000, 250), stop(3, 6000)])]));
    const a = out.candidates.filter((c) => c.sequence === 1);
    expect(a.map((c) => `${c.kind} ${hhmm(c.at)}`)).toEqual(['ARRIVED 07:04', 'DEPARTED 07:15', 'ARRIVED 07:21', 'DEPARTED 07:30']);
    // The time standing at shop B (within 500 m of A, but another customer) is away from A.
    expect(a[2]!.stay).toMatchObject({ merged: 0, awayMin: 6 });
    expect(out.candidates.filter((c) => c.sequence === 2).map((c) => c.kind)).toEqual(['ARRIVED', 'DEPARTED']);
  });

  it('a stop whose other customer already has its result is not open: the move past its pin merges', () => {
    const out = detectTruckDay(input(dockMove({ north: 250, parkThere: 5 }).pts, [load(1, [stop(1, 3000), stop(2, 3000, 250, { resultAt: T('06:00') }), stop(3, 6000)])]));
    expect(out.candidates.filter((c) => c.sequence === 1).map((c) => `${c.kind} ${hhmm(c.at)}`)).toEqual(['ARRIVED 07:04', 'DEPARTED 07:30']);
  });

  it('only stops merge: a drive past the pin after leaving never stretches the stay', () => {
    // Left at 07:15 to a point 400 m away, then drove back past the pin at speed (no slow point) and on.
    const trail = new Trail('06:30').park(30).drive(3000).park(10).drive(3000, 400, 15).park(3).drive(3000, -400, 40).drive(6000, -400, 40).park(10).drive(0).park(20);
    const out = detectTruckDay(input(trail.pts, [load(1, [stop(1, 3000)])]));
    expect(brief(out)).toEqual(['L1.1 ARRIVED 07:04', 'L1.1 DEPARTED 07:15']);
  });

  it('mergeStays is the rule alone: gap, distance and the other stops', () => {
    const trail = dockMove({ north: 350, parkThere: 5 });
    const raw = staysAt(trail.pts, trail.pts, at(3000), 1, P).filter((s) => s.hasSlowPoint);
    expect(raw).toHaveLength(2);
    expect(mergeStays(raw, trail.pts, at(3000), [], P)).toHaveLength(1);
    // A stay of another open stop in the gap blocks it; so does a point beyond 500 m.
    expect(mergeStays(raw, trail.pts, at(3000), [{ ...raw[0]!, first: { ...raw[0]!.exit! }, exit: null, lastIn: { ...raw[1]!.first, fixAt: new Date(raw[1]!.first.fixAt.getTime() - 60_000) } }], P)).toHaveLength(2);
    expect(mergeStays(raw, trail.pts, at(3000, 1000), [], P)).toHaveLength(2);
  });
});

describe('the departure is held back while the truck may still come back (owner request 19 Oct 2026)', () => {
  it('a truck 300 m away 5 min after leaving: the departure is not final yet', () => {
    const trail = new Trail('06:30').park(30).drive(3000).park(10).drive(3000, 300, 15).park(5);
    expect(brief(detectTruckDay(input(trail.pts, [load(1, [stop(1, 3000)])])))).toEqual(['L1.1 ARRIVED 07:04', 'L1.1 DEPARTED 07:15 (held)']);
  });

  it('final once the trail followed it 10 min, once beyond 500 m, or once at the depot', () => {
    const parked = new Trail('06:30').park(30).drive(3000).park(10).drive(3000, 300, 15).park(HOLD_DEPARTED_MIN + 1);
    expect(brief(detectTruckDay(input(parked.pts, [load(1, [stop(1, 3000)])])))).toEqual(['L1.1 ARRIVED 07:04', 'L1.1 DEPARTED 07:15']);
    const away = new Trail('06:30').park(30).drive(3000).park(10).drive(5000, 0, 40);
    expect(detectTruckDay(input(away.pts, [load(1, [stop(1, 3000)])])).candidates.find((c) => c.kind === 'DEPARTED')!.final).toBe(true);
    // A pin 450 m from the depot: driving back to the depot ends the trip, the departure is final at once.
    const home = new Trail('06:30').park(30).drive(450).park(10).drive(0, 0, 20).park(6);
    const out = detectTruckDay(input(home.pts, [load(1, [stop(1, 450)])], { params: { ...P, depotRadiusM: 200 } }));
    expect(out.candidates.find((c) => c.kind === 'DEPARTED')).toMatchObject({ final: true });
  });

  it('a return to the pin that is still too short to be a stop keeps it held; one that is a stop merges', () => {
    const back = new Trail('06:30').park(30).drive(3000).park(10).drive(3000, 300, 15).park(3).drive(3000, 0, 15).park(2);
    expect(brief(detectTruckDay(input(back.pts, [load(1, [stop(1, 3000)])])))).toEqual(['L1.1 ARRIVED 07:04', 'L1.1 DEPARTED 07:15 (held)']);
    const stayed = new Trail('06:30').park(30).drive(3000).park(10).drive(3000, 300, 15).park(3).drive(3000, 0, 15).park(15);
    expect(brief(detectTruckDay(input(stayed.pts, [load(1, [stop(1, 3000)])])))).toEqual(['L1.1 ARRIVED 07:04']);
  });
});

describe("a customer's site radius (Customer.siteRadiusM)", () => {
  // At the pin 40 min, then a second drop point 370 m north for 30 min (the study's big customer), then away.
  const site = new Trail('06:30').park(30).drive(3000).park(40).drive(3000, 370, 14).park(30).drive(6000, 370, 40).park(10).drive(0).park(20);

  it('without one the move to the second drop point is the departure; with 400 m the stay ends when the truck leaves the site', () => {
    expect(brief(detectTruckDay(input(site.pts, [load(1, [stop(1, 3000)])])))).toEqual(['L1.1 ARRIVED 07:04', 'L1.1 DEPARTED 07:45']);
    const out = detectTruckDay(input(site.pts, [load(1, [stop(1, 3000, 0, { siteRadiusM: 400 })])]));
    expect(brief(out)).toEqual(['L1.1 ARRIVED 07:04', 'L1.1 DEPARTED 08:17']);
    expect(out.candidates[1]!.stay).toMatchObject({ radiusM: 400, exitRule: 'FAST' });
    expect(out.candidates[1]!.stay!.exitDistM).toBeGreaterThan(400);
  });

  it('the arrival still needs the stop radius: a truck only at the second drop point has no stay', () => {
    const only = new Trail('06:30').park(30).drive(3000, 370).park(30).drive(6000, 370).park(10).drive(0).park(20);
    expect(detectTruckDay(input(only.pts, [load(1, [stop(1, 3000, 0, { siteRadiusM: 400 })])])).candidates).toEqual([]);
  });

  it('a value outside 100-500 (or not whole metres) is the stop radius; empty is today', () => {
    for (const bad of [50, 99, 501, 1000, 250.5, Number.NaN]) {
      expect(validSiteRadius(bad), String(bad)).toBeNull();
      expect(brief(detectTruckDay(input(site.pts, [load(1, [stop(1, 3000, 0, { siteRadiusM: bad })])])))).toEqual(['L1.1 ARRIVED 07:04', 'L1.1 DEPARTED 07:45']);
    }
    expect([SITE_RADIUS_MIN_M, SITE_RADIUS_MAX_M]).toEqual([100, 500]);
    expect(readSiteRadius('')).toEqual({ ok: true, radiusM: null });
    expect(readSiteRadius(' 400 ')).toEqual({ ok: true, radiusM: 400 });
    for (const bad of ['99', '501', '400 m', '-1', '1e3', '350.5']) expect(readSiteRadius(bad).ok, bad).toBe(false);
  });
});

describe("review of 19 Oct 2026: a site radius next to another customer's pin", () => {
  // Shop A has a 400 m site radius (3000 m east); shop B, the stop before it on the trip, is 235 m north of
  // A's pin (the real case: a big customer 235 m from its neighbour; with 400 m the drive-by opened a stay
  // that ran through both visits, so SEVERAL_PINS left both without GPS times).
  const A = (over: Partial<DetectorStop> = {}) => stop(2, 3000, 0, { siteRadiusM: 400, ...over });
  const B = (over: Partial<DetectorStop> = {}) => stop(1, 3000, 235, over);
  /**
   * Past A's pin at 15 km/h (a point every 5 s, the nearest 60-80 m from it, none slow) on the way to B; 40 min
   * at B; to A: 20 min at the pin, 15 min at a second drop point 370 m south; away.
   */
  const driveBy = () =>
    new Trail('06:30')
      .park(30)
      .drive(2900, -60, 40)
      .drive(3100, -60, 15, { stepSec: 5 })
      .drive(3000, 235, 15, { stepSec: 5 })
      .park(40)
      .drive(3000, 0, 15, { stepSec: 5 })
      .park(20)
      .drive(3000, -370, 14)
      .park(15)
      .drive(6000, -370, 40)
      .park(10)
      .drive(0)
      .park(20);

  it('a drive-by never opens a site stay: B and A both get their times (before: one 400 m stay over both, SEVERAL_PINS, nothing for either)', () => {
    const out = detectTruckDay(input(driveBy().pts, [load(1, [B({ resultAt: T('07:40') }), A()])]));
    expect(out.ambiguities.filter((a) => a.reason === 'SEVERAL_PINS')).toEqual([]);
    expect(brief(out)).toEqual(['L1.1 ARRIVED 07:06', 'L1.1 DEPARTED 07:47', 'L1.2 ARRIVED 07:47', 'L1.2 DEPARTED 08:25']);
    const [, bOut, aIn, aOut] = out.candidates;
    expect(aIn!.at.getTime()).toBeGreaterThan(bOut!.at.getTime());
    // A's stay is the visit at its pin and its second drop point, ended when the truck left the site.
    expect(aOut!.stay).toMatchObject({ radiusM: 400, exitRule: 'FAST', merged: 0 });
    expect(aOut!.stay!.exitDistM).toBeGreaterThan(400);
    // The drive-by alone (past the pin, then by it again on the turn to B): stays ended at the stop radius (no slow
    // point at the pin, so no site radius), never a stop, both over before the truck reached B.
    const bIn = out.candidates[0]!.at.getTime();
    const passing = staysAt(driveBy().pts, driveBy().pts, at(3000), 2, P, undefined, 400).filter((s) => s.first.fixAt.getTime() < bIn);
    expect(passing).toHaveLength(2);
    for (const s of passing) {
      expect(s).toMatchObject({ radiusM: 100, hasSlowPoint: false, exitRule: 'FAST' });
      expect(s.exit!.fixAt.getTime()).toBeLessThan(bIn);
    }
  });

  it('without the site radius the same day is as before; with it only where the truck left the site changes', () => {
    const plain = detectTruckDay(input(driveBy().pts, [load(1, [B({ resultAt: T('07:40') }), A({ siteRadiusM: null })])]));
    // Without it A's departure is the move to the second drop point (08:08), as before.
    expect(brief(plain)).toEqual(['L1.1 ARRIVED 07:06', 'L1.1 DEPARTED 07:47', 'L1.2 ARRIVED 07:47', 'L1.2 DEPARTED 08:08']);
  });

  it("a site stay ends where the truck reaches another open stop's pin (OTHER_STOP): the neighbour is never swallowed", () => {
    // 20 min at A's pin, then at 10 km/h to B (235 m: inside A's 400 m all the way), 30 min at B, away.
    const t = new Trail('06:30').park(30).drive(3000).park(20).drive(3000, 235, 10, { stepSec: 10 }).park(30).drive(6000, 235, 40).park(10).drive(0).park(20);
    const out = detectTruckDay(input(t.pts, [load(1, [stop(1, 3000, 0, { siteRadiusM: 400 }), stop(2, 3000, 235)])]));
    expect(out.ambiguities.filter((a) => a.reason === 'SEVERAL_PINS')).toEqual([]);
    const [aIn, aOut, bIn, bOut] = out.candidates;
    expect([aIn, aOut, bIn, bOut].map((c) => `${c!.sequence} ${c!.kind}`)).toEqual(['1 ARRIVED', '1 DEPARTED', '2 ARRIVED', '2 DEPARTED']);
    // A's departure is its last point before B's stop radius, never B's arrival itself (no overlap), and final.
    expect(aOut!.stay).toMatchObject({ exitRule: 'OTHER_STOP', radiusM: 400 });
    expect(aOut!.final).toBe(true);
    expect(bIn!.at.getTime() - aOut!.at.getTime()).toBe(10_000);
    expect(aOut!.stay!.exitDistM).toBeGreaterThan(100);
    expect(aOut!.stay!.exitDistM).toBeLessThan(135);
    // Without the site radius A ends at its stop radius (as before), a little earlier.
    const plain = detectTruckDay(input(t.pts, [load(1, [stop(1, 3000), stop(2, 3000, 235)])]));
    expect(plain.candidates.map((c) => `${c.sequence} ${c.kind}`)).toEqual(['1 ARRIVED', '1 DEPARTED', '2 ARRIVED', '2 DEPARTED']);
    expect(plain.candidates[1]!.at.getTime()).toBeLessThanOrEqual(aOut!.at.getTime());
    expect(plain.candidates[2]!.at).toEqual(bIn!.at);
  });
});

describe('review of 19 Oct 2026: a held departure is written once the trail is known complete past it', () => {
  // Left the pin at 07:15 for a point 300 m away; the tracker sends two more minutes, then nothing (ignition is never sent).
  const quiet = () => new Trail('06:30').park(30).drive(3000).park(10).drive(3000, 300, 15).park(2);
  const dep = (over: Partial<DetectorInput> = {}, trail = quiet()) => detectTruckDay(input(trail.pts, [load(1, [stop(1, 3000)])], over)).candidates.find((c) => c.kind === 'DEPARTED')!;

  it('the trail complete 10 min past the exit (the pulled history, less the overlap) makes it final; the clock alone does not', () => {
    expect(dep()).toMatchObject({ final: false });
    expect(hhmm(dep().at)).toBe('07:15');
    // `now` alone is not enough: the history of the last minutes may not be pulled yet.
    expect(dep({ now: T('07:45') })).toMatchObject({ final: false });
    expect(dep({ trailComplete: { to: T('07:24:30'), final: false } })).toMatchObject({ final: false });
    expect(dep({ trailComplete: { to: T('07:25'), final: false } })).toMatchObject({ final: true });
    // After the truck-day's final pull no point will come: final at once.
    expect(dep({ trailComplete: { to: T('07:17'), final: true } })).toMatchObject({ final: true });
  });

  it('a truck back at the pin when the tracker went quiet stays held (it may be unloading again) until the final pull', () => {
    const back = quiet().drive(3000, 0, 15).park(1);
    expect(dep({ trailComplete: { to: T('08:00'), final: false } }, back)).toMatchObject({ final: false });
    expect(dep({ trailComplete: { to: T('08:00'), final: true } }, back)).toMatchObject({ final: true });
  });
});

describe('GPS cleaning: a frozen run is a gap (owner request 19 Oct 2026)', () => {
  /** `n` repeats of the last point's coordinates, every `stepSec`, at `kmh` (the tracker sending a stale position). */
  const freeze = (t: Trail, n: number, stepSec: number, kmh = 40) => {
    const last = t.pts[t.pts.length - 1]!;
    for (let i = 1; i <= n; i++) t.pts.push({ fixAt: new Date(last.fixAt.getTime() + i * stepSec * 1000), lat: last.lat, lng: last.lng, speedKmh: kmh, ignition: true });
    t.t = last.fixAt.getTime() + (n + 1) * stepSec * 1000;
    return t;
  };

  it('the repeats of 60 s or more are dropped and the point after them is marked; a shorter run stays as it is', () => {
    const t = freeze(new Trail('07:00').park(5), 4, 20);
    t.point(500, 0, 40);
    const c = cleanTrail(t.pts, 5);
    expect(c.frozen).toHaveLength(1);
    expect(c.points).toHaveLength(t.pts.length - 4);
    expect(c.afterGap.has(t.pts[t.pts.length - 1]!)).toBe(true);
    expect(FROZEN_RUN_SEC).toBe(60);
    const short = freeze(new Trail('07:00').park(5), 2, 20);
    short.point(500, 0, 40);
    expect(cleanTrail(short.pts, 5)).toMatchObject({ frozen: [], points: short.pts });
    // Repeated coordinates while parked (speed 0) are not frozen.
    const parked = new Trail('07:00').park(10);
    expect(cleanTrail(parked.pts, 5).frozen).toEqual([]);
  });

  it('a departure right after a frozen run is not observed (a case of the GPS study); the stay counts the run', () => {
    const t = freeze(new Trail('06:30').park(30).drive(3000).park(10), 6, 20);
    t.jump(3800).point(3800, 0, 40).drive(6000).park(10).drive(0).park(20);
    const out = detectTruckDay(input(t.pts, [load(1, [stop(1, 3000), stop(2, 6000)])]));
    const dep = out.candidates.find((c) => c.sequence === 1 && c.kind === 'DEPARTED')!;
    expect(dep).toMatchObject({ observed: false, final: true });
    expect(dep.stay!.frozenRuns).toBe(1);
    // The same trail without the frozen run: observed, as before.
    const clean = new Trail('06:30').park(30).drive(3000).park(10).jump(3800).point(3800, 0, 40).drive(6000).park(10).drive(0).park(20);
    expect(detectTruckDay(input(clean.pts, [load(1, [stop(1, 3000), stop(2, 6000)])])).candidates.find((c) => c.sequence === 1 && c.kind === 'DEPARTED')!.observed).toBe(true);
  });

  it('an arrival right after a frozen run is not observed; a depot move after one neither', () => {
    const t = new Trail('06:30').park(30).drive(2800, 0, 40);
    freeze(t, 5, 20);
    t.jump(2990).park(10).drive(6000).park(10).drive(0).park(20);
    const out = detectTruckDay(input(t.pts, [load(1, [stop(1, 3000), stop(2, 6000)])]));
    expect(out.candidates.find((c) => c.sequence === 1 && c.kind === 'ARRIVED')!.observed).toBe(false);
    const leave = freeze(new Trail('06:30').park(30).drive(150, 0, 30), 5, 20);
    leave.jump(900).point(900, 0, 40).drive(3000).park(10).drive(0).park(20);
    expect(detectTruckDay(input(leave.pts, [load(1, [stop(1, 3000)])])).trailMoves.map((m) => [m.kind, m.observed])).toEqual([
      ['DEPOT_OUT', false],
      ['DEPOT_IN', true],
    ]);
  });

  it('no point is dropped for its speed: two fixes a second apart that imply 900 km/h are both kept (timestamp jitter)', () => {
    const t = new Trail('06:30').park(30).drive(3000).park(10);
    const last = t.pts[t.pts.length - 1]!;
    t.pts.push({ fixAt: new Date(last.fixAt.getTime() + 1000), ...at(3250), speedKmh: 85, ignition: true });
    expect(cleanTrail(t.pts, 5).points).toHaveLength(t.pts.length);
  });
});

describe('the stay summary and the rejected candidates', () => {
  it('every candidate carries the summary: exit rule, speed and distance, standing, furthest point, points, frozen runs, merged, away', () => {
    const out = detectTruckDay(input(dockMove({ north: 350, parkThere: 5 }).pts, [load(1, [stop(1, 3000), stop(2, 6000)])]));
    const s = out.candidates[1]!.stay!;
    expect(Object.keys(s).sort()).toEqual(['awayMin', 'exitDistM', 'exitKmh', 'exitRule', 'frozenRuns', 'maxDistM', 'merged', 'points', 'radiusM', 'standMin'].sort());
    expect(s).toMatchObject({ exitRule: 'FAST', exitKmh: 40, merged: 1, frozenRuns: 0, maxDistM: 350, awayMin: null });
    expect(s.standMin).toBeGreaterThan(18);
    expect(s.points).toBeGreaterThan(40);
    // A stay still in progress: no exit yet.
    const open = detectTruckDay(input(new Trail('06:30').park(30).drive(3000).park(6).pts, [load(1, [stop(1, 3000)])]));
    expect(open.candidates[0]!.stay).toMatchObject({ exitRule: null, exitKmh: null, exitDistM: null });
  });

  it('a stay at a pending stop shorter than the dwell is kept as a SHORT_DWELL fact, never a time, never shown', () => {
    const out = detectTruckDay(input(new Trail('06:30').park(30).drive(3000).park(2).drive(6000).park(10).drive(0).park(20).pts, [load(1, [stop(1, 3000), stop(2, 6000)])]));
    expect(out.candidates.every((c) => c.sequence === 2)).toBe(true);
    expect(out.ambiguities).toEqual([expect.objectContaining({ reason: 'SHORT_DWELL', loadNo: 1, sequences: [1] })]);
    const facts = gpsFactsOf(out);
    expect(facts).toEqual([expect.objectContaining({ kind: 'SHORT_DWELL' })]);
    expect(gpsFactText(facts[0], 'Asia/Muscat')).toBeNull();
  });

  it('the short stays come after the other facts, so a long list cuts them first', () => {
    const short = Array.from({ length: 45 }, (_, i) => ({ reason: 'SHORT_DWELL' as const, loadNo: 1, sequences: [i + 1], from: T('07:00'), to: T('07:02') }));
    const facts = gpsFactsOf({ ambiguities: [...short, { reason: 'SEVERAL_PINS', loadNo: 1, sequences: [1, 2], from: T('08:00'), to: null }], notes: [] });
    expect(facts[0]).toMatchObject({ kind: 'SEVERAL_PINS' });
    expect(facts.length).toBeLessThanOrEqual(40);
  });
});

// ---------------------------------------------------------------------------------------------------
// The writer (lib/ivms/stop-events.ts) on the in-memory database

const TEN = 'tA';
const DATE = '2026-10-20';
const day = new Date(`${DATE}T00:00:00.000Z`);
const SHOP_A = at(3000);
const SHOP_B = at(6000);
const snapshot = (code: string, pin: { lat: number; lng: number }) => ({
  v: 1,
  customerId: `C-${code}`,
  code,
  branchCode: null,
  name: `Shop Example ${code}`,
  customerType: null,
  lat: pin.lat,
  lng: pin.lng,
  address: null,
  accessNotes: null,
  serviceMin: 20,
  priority: 3,
  hardStartMin: 0,
  hardEndMin: 1439,
  prefStartMin: null,
  prefEndMin: null,
  source: 'PLAN',
  capturedAt: T('05:00').toISOString(),
});

function seed(trail: Trail, o: { mode?: string; siteRadiusM?: number | null } = {}) {
  resetDb();
  tables.tenant = [{ id: TEN, name: 'Synthetic Water Co', active: true }];
  tables.tenantConfig = [{ id: 'cfg', tenantId: TEN, timezone: 'Asia/Muscat', geofenceRadiusM: 100, photoProofRequired: true, ivmsMode: o.mode ?? 'TIMES', ivmsStopRadiusM: 100, ivmsStopDwellMin: 3, ivmsDepotRadiusM: 300 }];
  tables.depot = [{ id: 'D1', tenantId: TEN, code: 'D1', name: 'Depot', ...at(0) }];
  tables.truck = [{ id: 't5', tenantId: TEN, code: 'T05', hired: false, ivmsImei: '111111111111111', onlyOnDate: null }];
  tables.customer = [
    { id: 'C-A', tenantId: TEN, code: 'A', name: 'Shop Example A', siteRadiusM: o.siteRadiusM ?? null },
    { id: 'C-B', tenantId: TEN, code: 'B', name: 'Shop Example B', siteRadiusM: null },
  ];
  tables.runPlan = [{ id: 'R1', tenantId: TEN, depotId: 'D1', runDate: day, status: 'DISPATCHED', version: 1, supersededAt: null, chosenScenarioId: 'sc', createdAt: T('04:00') }];
  tables.planLoad = [{ id: 'L1', tenantId: TEN, runId: 'R1', truckId: 't5', loadNo: 1, status: 'DISPATCHED', departMin: 420, returnMin: 600, driverId: null, statusChangedAt: T('06:55'), breakJson: null, truckSnapshotJson: null, carriedFromLoadId: null }];
  const line = (id: string, cases: number) => ({ id, cases, weightKg: cases * 10, product: { code: 'WATER-A' } });
  tables.order = [
    { id: 'O1', tenantId: TEN, customerId: 'C-A', carriedToOrderId: null, lines: [line('LA', 30)] },
    { id: 'O2', tenantId: TEN, customerId: 'C-B', carriedToOrderId: null, lines: [line('LB', 20)] },
  ];
  const ra = (id: string, orderId: string, sequence: number, snap: unknown) => ({ id, runId: 'R1', loadId: 'L1', truckId: 't5', orderId, loadNo: 1, sequenceInTruck: sequence, orderInStop: 0, etaMin: 420 + sequence * 10, serviceStartMin: 420 + sequence * 10, departureMin: 430 + sequence * 10, portionLinesJson: null, stopSnapshotJson: snap });
  tables.routeAssignment = [ra('A1', 'O1', 1, snapshot('A', SHOP_A)), ra('A2', 'O2', 2, snapshot('B', SHOP_B))];
  tables.auditLog = [{ id: 'au1', tenantId: TEN, action: 'LOAD_DISPATCHED', entity: 'PlanLoad', entityId: 'L1', createdAt: T('06:55') }];
  tables.stopVisit = [];
  tables.stopEvent = [];
  tables.deliveryPhoto = [];
  tables.ivmsEvent = [];
  tables.ivmsTruckDay = [];
  tables.truckTrailPoint = trail.pts.map((p, i) => ({ id: `tp${i}`, tenantId: TEN, truckId: 't5', ...p }));
}
const gps = (seq: number) => tables.stopEvent!.filter((e) => e.source === 'AYUN' && e.sequence === seq);
const visitOf = (seq: number) => tables.stopVisit!.find((v) => v.sequence === seq);

let prevDisable: string | undefined;
beforeEach(() => {
  prevDisable = process.env.ROUTEIQ_DISABLE_IVMS;
  delete process.env.ROUTEIQ_DISABLE_IVMS;
});
afterEach(() => {
  if (prevDisable === undefined) delete process.env.ROUTEIQ_DISABLE_IVMS;
  else process.env.ROUTEIQ_DISABLE_IVMS = prevDisable;
});

describe('the writer: a dock move never writes a departure; a real one is written within about 10 minutes', () => {
  it('runs during the dock move write the arrival only; after the return and the real departure, the merged departure', async () => {
    const full = dockMove({ north: 350, parkThere: 5 });
    const upTo = (hhmmss: string) => {
      const t = new Trail('06:30');
      t.pts = full.pts.filter((p) => p.fixAt <= T(hhmmss));
      return t;
    };
    // 07:18: the truck left the pin at 07:15 and stands 350 m away.
    seed(upTo('07:18'));
    let r = await processGpsTimes(TEN, 't5', DATE, T('07:18'));
    expect(r).toMatchObject({ written: 1, kept: { HELD: 1 } });
    expect(gps(1).map((e) => e.kind)).toEqual(['ARRIVED']);
    // 07:28: back at the pin (merged): still no departure.
    tables.truckTrailPoint = full.pts.filter((p) => p.fixAt <= T('07:28')).map((p, i) => ({ id: `tp${i}`, tenantId: TEN, truckId: 't5', ...p }));
    r = await processGpsTimes(TEN, 't5', DATE, T('07:28'));
    expect(r.written).toBe(0);
    expect(gps(1).map((e) => e.kind)).toEqual(['ARRIVED']);
    // 07:33: the truck drove away (beyond 500 m): the departure of the whole visit, 07:31.
    tables.truckTrailPoint = full.pts.filter((p) => p.fixAt <= T('07:33')).map((p, i) => ({ id: `tp${i}`, tenantId: TEN, truckId: 't5', ...p }));
    r = await processGpsTimes(TEN, 't5', DATE, T('07:33'));
    expect(gps(1).map((e) => `${e.kind} ${hhmm(e.at)}`)).toEqual(['ARRIVED 07:04', 'DEPARTED 07:31']);
    expect(gps(1)[1]!.payloadJson).toMatchObject({ detector: DETECTOR_VERSION, observed: true, stay: { merged: 1, maxDistM: 350, exitRule: 'FAST' } });
    expect(DETECTOR_VERSION).toBe('ivms-v2');
    expect(visitOf(1)).toMatchObject({ arrivalSource: 'AYUN', departureSource: 'AYUN', awayMinutes: null });
    expect(visitOf(1)!.departedAt).toEqual(T('07:31'));
  });

  it('a truck that parks 300 m off and never comes back: the departure is written once the trail is 10 min past it', async () => {
    const trail = new Trail('06:30').park(30).drive(3000).park(10).drive(3000, 300, 15).park(20);
    seed(trail);
    tables.truckTrailPoint = tables.truckTrailPoint!.filter((p) => p.fixAt <= T('07:22'));
    expect(await processGpsTimes(TEN, 't5', DATE, T('07:22'))).toMatchObject({ kept: { HELD: 1 } });
    seed(trail);
    tables.truckTrailPoint = tables.truckTrailPoint!.filter((p) => p.fixAt <= T('07:26'));
    await processGpsTimes(TEN, 't5', DATE, T('07:26'));
    expect(gps(1).map((e) => `${e.kind} ${hhmm(e.at)}`)).toEqual(['ARRIVED 07:04', 'DEPARTED 07:15']);
  });

  it('review of 19 Oct 2026: a truck that parks 300 m off and goes quiet - the departure is written once the pulled history is 10 min past it', async () => {
    const trail = new Trail('06:30').park(30).drive(3000).park(10).drive(3000, 300, 15).park(2);
    const truckDay = (pulledTo: Date, finalPullAt: Date | null = null) => [{ id: 'td1', tenantId: TEN, truckId: 't5', deliveryDate: day, pulledTo, lastPullAt: pulledTo, finalPullAt, processedAt: null, suppressedAt: null, trailFrom: null }];
    seed(trail);
    // Pulled to 07:30: complete to 07:20 (the next pull reads the last 10 min again), only 5 min past the exit.
    tables.ivmsTruckDay = truckDay(T('07:30'));
    expect(await processGpsTimes(TEN, 't5', DATE, T('07:31'))).toMatchObject({ written: 1, kept: { HELD: 1 } });
    // The next pull (to 07:36, complete to 07:26) brings no point: the tracker went quiet with the truck away.
    tables.ivmsTruckDay![0]!.pulledTo = T('07:36');
    await processGpsTimes(TEN, 't5', DATE, T('07:37'));
    expect(gps(1).map((e) => `${e.kind} ${hhmm(e.at)}`)).toEqual(['ARRIVED 07:04', 'DEPARTED 07:15']);
    // Before the fix it stayed HELD at every run, the final pull included. Now the final pull writes it at once.
    seed(trail);
    tables.ivmsTruckDay = truckDay(T('07:20'), T('07:21'));
    await processGpsTimes(TEN, 't5', DATE, T('07:21'));
    expect(gps(1).map((e) => e.kind)).toEqual(['ARRIVED', 'DEPARTED']);
  });

  it('trailCompleteOf: the history pulled less the 10-min overlap; final after the final pull; never pulled = none', () => {
    expect(trailCompleteOf({ pulledTo: T('10:00'), finalPullAt: null })).toEqual({ to: T('09:50'), final: false });
    expect(trailCompleteOf({ pulledTo: T('10:00'), finalPullAt: T('10:05') })).toEqual({ to: T('09:50'), final: true });
    expect(trailCompleteOf({ pulledTo: null, finalPullAt: null })).toBeNull();
    expect(trailCompleteOf(null)).toBeNull();
  });

  it("review of 19 Oct 2026: the live map's 'at the stop' reaches the customer's site radius, as the GPS alerts do", async () => {
    // Arrived at shop A (the driver's tap), now unloading at a second drop point 370 m north of its pin.
    const live = async (siteRadiusM: number | null) => {
      seed(new Trail('06:30').park(1), { siteRadiusM });
      tables.ivmsState = [];
      tables.stopVisit!.push({ id: 'v1', tenantId: TEN, depotId: 'D1', deliveryDate: day, truckId: 't5', loadNo: 1, sequence: 1, customerId: 'C-A', outcome: null, arrivedAt: T('07:05'), departedAt: null });
      tables.truckPosition = [{ id: 'p1', tenantId: TEN, truckId: 't5', fixAt: T('07:29:30'), receivedAt: T('07:29:40'), ...at(3000, 370), speedKmh: 0, heading: null, flags: [], movedAt: T('07:20') }];
      const r = await readLiveVehicles(TEN, 'R1', T('07:30'));
      return r!.vehicles[0]!.next;
    };
    // The company's radius (100 m + the margin): the truck has left stop 1, the next stop is 2.
    expect(await live(null)).toMatchObject({ sequence: 2 });
    // The customer's 400 m site radius: still at stop 1 (the GPS alerts say the same: lib/alerts/gps.ts atStopRadiusOf).
    expect(await live(400)).toMatchObject({ sequence: 1 });
  });

  it("the customer's site radius reaches the detector: the departure is when the truck leaves the site", async () => {
    const site = new Trail('06:30').park(30).drive(3000).park(40).drive(3000, 370, 14).park(30).drive(6000, 370, 40).park(10).drive(0).park(20);
    seed(site, { siteRadiusM: 400 });
    await processGpsTimes(TEN, 't5', DATE, T('16:00'));
    expect(gps(1).map((e) => `${e.kind} ${hhmm(e.at)}`)).toEqual(['ARRIVED 07:04', 'DEPARTED 08:17']);
    expect(gps(1)[1]!.payloadJson).toMatchObject({ stay: { radiusM: 400 } });
    seed(site);
    await processGpsTimes(TEN, 't5', DATE, T('16:00'));
    expect(gps(1).map((e) => `${e.kind} ${hhmm(e.at)}`)).toEqual(['ARRIVED 07:04', 'DEPARTED 07:45']);
  });

  it('a leave-and-return: both stays written, the second one with the minutes away in its payload; the visit takes them off', async () => {
    const trail = new Trail('06:30').park(30).drive(3000).park(10).drive(4200, 0, 40).park(4).drive(3000, 0, 40).park(8).drive(6000).park(10).drive(0).park(20);
    seed(trail);
    // The driver tapped the arrival at 07:05 and the result at 07:28 (in the second stay).
    tables.stopVisit!.push({ id: 'v1', tenantId: TEN, depotId: 'D1', deliveryDate: day, truckId: 't5', loadNo: 1, sequence: 1, customerId: 'C-A', firstLoadId: 'L1', plannedLat: SHOP_A.lat, plannedLng: SHOP_A.lng, windowStartMin: null, windowEndMin: null, linesJson: [], casesPlanned: 30, arrivalSource: 'PHONE_MANUAL', locationPurgedAt: null });
    tables.stopEvent!.push(
      { id: 'tap', tenantId: TEN, depotId: 'D1', deliveryDate: day, truckId: 't5', loadNo: 1, sequence: 1, visitId: 'v1', kind: 'ARRIVED', source: 'PHONE_MANUAL', at: T('07:05'), receivedAt: T('07:05'), idempotencyKey: 'dl:tap', payloadJson: { mode: 'MANUAL' } },
      { id: 'res', tenantId: TEN, depotId: 'D1', deliveryDate: day, truckId: 't5', loadNo: 1, sequence: 1, visitId: 'v1', kind: 'OUTCOME', source: 'PHONE_MANUAL', at: T('07:28'), receivedAt: T('07:28'), idempotencyKey: 'dl:res', payloadJson: { outcome: 'DELIVERED' } },
    );
    await processGpsTimes(TEN, 't5', DATE, T('16:00'));
    expect(gps(1).map((e) => `${e.kind} ${hhmm(e.at)}`)).toEqual(['ARRIVED 07:04', 'DEPARTED 07:15', 'ARRIVED 07:22', 'DEPARTED 07:31']);
    expect(gps(1)[2]!.payloadJson).toMatchObject({ stay: { awayMin: 6.5 } });
    expect(visitOf(1)).toMatchObject({ arrivalSource: 'PHONE_MANUAL', departureSource: 'AYUN', awayMinutes: 6.5 });
    expect(visitOf(1)!.departedAt).toEqual(T('07:31'));
  });

  it('the SHORT_DWELL fact is stored with the others on the truck-day', async () => {
    seed(new Trail('06:30').park(30).drive(3000).park(2).drive(6000).park(10).drive(0).park(20));
    await processGpsTimes(TEN, 't5', DATE, T('16:00'));
    expect(tables.ivmsTruckDay![0]!.gpsFactsJson).toEqual([expect.objectContaining({ kind: 'SHORT_DWELL', loadNo: 1, sequences: [1] })]);
  });

  it('below TIMES nothing is written, as before', async () => {
    for (const mode of ['OFF', 'MAP']) {
      seed(dockMove({ north: 350, parkThere: 5 }), { mode });
      expect(await processGpsTimes(TEN, 't5', DATE, T('16:00'))).toMatchObject({ skipped: 'MODE', written: 0 });
      expect(tables.stopEvent).toEqual([]);
    }
  });
});
