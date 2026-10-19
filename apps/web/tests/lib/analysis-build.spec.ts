/**
 * The analysis dataset's builder (owner request 19 Oct 2026; lib/analysis/build.ts and gps.ts), pure, on
 * invented truck-days: a depot and shops in empty desert near 20.1, 55.1, truck T-100, customers TST0001...
 * Each fact of the four tables, and the study's corrections:
 * - a second drop point 350 m from the pin is still on the site (the prototype's 300 m ended it early);
 * - a trip away and back in the middle of a visit is never unloading (its count and minutes are kept apart);
 * - the window is clipped on both sides: a stop served before its window opened is never negative;
 * - crawling alone never makes a standstill; a single-point spike is no trip away and no km;
 * - the truck more than 500 m away at the driver's result tap is a late result tap; standing 120-500 m from
 *   the pin is a pin offset; no position is ever in a row;
 * - a refresh rebuilds what does not come from the trail and copies the trail's columns and the settings.
 */
import { describe, expect, it } from 'vitest';
import { buildTruckDayFacts, clippedMinutes, type EventIn, type LoadIn, type TruckDayIn, type VisitIn } from '@/lib/analysis/build';
import { bearingDeg, destinationOf, frozenRunsOf, kmBetween, runsOf, siteOf, spikesOf } from '@/lib/analysis/gps';
import { ANALYSIS_VERSION } from '@/lib/analysis/types';
import { distanceM } from '@/lib/dispatch/snapshots';
import { prevIndexOf } from '@/lib/ivms/stops';
import { DETECTOR_VERSION, type TrailPoint } from '@/lib/ivms/types';
import { A, atOn, B, dayOne as dayOneOn, DEPOT, ev, load as loadOf, off, SETTINGS, stop, Trail, truckDayOf, visit } from './analysis-fakes';

const D = '2026-10-18';
/** Local HH:MM in Muscat (UTC+4) on D. */
const L = (hhmm: string, sec = 0) => atOn(D, hhmm, sec);
const NOW = new Date('2026-10-19T00:00:00Z');
const load = (loadNo: number, stops: Parameters<typeof loadOf>[1], extra: Partial<LoadIn> = {}) => loadOf(loadNo, stops, { dispatchedAt: L('06:50'), ...extra });
const day = (loads: LoadIn[], visits: VisitIn[], events: EventIn[], extra: Partial<TruckDayIn> = {}) => truckDayOf(D, loads, visits, events, extra);
const dayOne = () => dayOneOn(D);
const minutes = (a: Date | null, b: Date | null) => (a && b ? (b.getTime() - a.getTime()) / 60_000 : NaN);

describe('the customer site, the sub-stays and the drop points (lib/analysis/gps.ts)', () => {
  it('a second drop point 350 m from the pin is on the site; the standing spot is where the result was saved (a pin offset)', () => {
    const { tr, input, drop2 } = dayOne();
    const f = buildTruckDayFacts(input, SETTINGS, { kind: 'TRAIL', points: tr.pts, zoneMoves: [], deviceIn: [] }, { now: NOW });
    const a = f.visits.find((v) => v.sequence === 1)!;
    expect(a.siteStartAt).not.toBeNull();
    // The site ends with the standstill at 350 m (18 min from drop2), not when the truck left the 100 m circle.
    expect(minutes(drop2, a.siteEndAt)).toBeGreaterThan(17);
    expect(a.substays).toBe(2);
    expect(a.dropPoints).toBe(2);
    expect(a.flags).toEqual(expect.arrayContaining(['MULTI_DROP', 'PIN_OFFSET']));
    expect(a.standDistM).toBeGreaterThan(330);
    expect(a.standDistM).toBeLessThan(370);
    expect(a.standBearingDeg).toBeGreaterThan(80); // east of the pin
    expect(a.standBearingDeg).toBeLessThan(100);
    expect(a.pinOffset).toBe(true);
    expect(a.maxDistM).toBeGreaterThan(330);
    // The live detector (100 m) saw one stay only: the 350 m drop point is outside its circle.
    expect(a.detectorStays).toBe(1);
    expect(a.awayCount).toBe(0);
    // Sub-stays: from the site start and from the pin only; never a position.
    expect(a.substaysJson).toEqual([
      expect.objectContaining({ startOffsetSec: expect.any(Number), minutes: expect.any(Number), distM: expect.any(Number), bearingDeg: expect.any(Number) }),
      expect.objectContaining({ distM: expect.any(Number) }),
    ]);
    for (const s of a.substaysJson as Record<string, unknown>[]) expect(Object.keys(s).sort()).toEqual(['bearingDeg', 'distM', 'minutes', 'startOffsetSec']);
  });

  it('no position anywhere in the rows: no latitude or longitude key, no coordinate value', () => {
    const { tr, input } = dayOne();
    const f = buildTruckDayFacts(input, SETTINGS, { kind: 'TRAIL', points: tr.pts, zoneMoves: [], deviceIn: [] }, { now: NOW });
    const text = JSON.stringify(f);
    expect(text).not.toMatch(/"(lat|lng|latitude|longitude)"/i);
    for (const coord of [A.lat, A.lng, B.lat, B.lng, DEPOT.lat, DEPOT.lng]) expect(text).not.toContain(coord.toFixed(4));
  });

  it('crawling alone never makes a standstill (study: 0 of 71 GPS stops came from slow movement)', () => {
    const tr = new Trail(L('07:00'), off(A, -280, 0));
    tr.drive(off(A, 0, 0), 7).drive(off(A, 280, 0), 7).drive(off(A, 900, 0), 30);
    const site = siteOf({ window: tr.pts, pin: A, sequence: 1, others: [], resultTapAt: null, params: SETTINGS.params, all: tr.pts, prevIdx: prevIndexOf(tr.pts) });
    expect(site).toBeNull();
  });

  it('a stop the truck only crawled past is flagged GPS_NOT_SEEN; one with the trail gone is NO_GPS', () => {
    const tr = new Trail(L('06:40'), DEPOT).park(20).drive(off(A, -280, 0)).drive(off(A, 280, 0), 7).drive(off(A, 2000, 0)).drive(DEPOT).park(20);
    const v = [visit(1, 1, { arrivedAt: L('07:10'), arrivalSource: 'PHONE_MANUAL', outcome: 'DELIVERED', outcomeAt: L('07:20'), outcomeSource: 'PHONE_MANUAL', departedAt: L('07:20'), departureSource: 'PHONE_MANUAL', departedAtOutcome: true, casesDelivered: 40 })];
    const input = day([load(1, [stop(1, A)])], v, [ev(1, 1, 'ARRIVED', L('07:10')), ev(1, 1, 'OUTCOME', L('07:20'))]);
    const seen = buildTruckDayFacts(input, SETTINGS, { kind: 'TRAIL', points: tr.pts, zoneMoves: [], deviceIn: [] }, { now: NOW });
    expect(seen.visits[0]!.flags).toContain('GPS_NOT_SEEN');
    expect(seen.visits[0]!.siteStartAt).toBeNull();
    const none = buildTruckDayFacts(input, SETTINGS, { kind: 'NONE' }, { now: NOW });
    expect(none.visits[0]!.flags).toContain('NO_GPS');
    expect(none.truckDay.gpsNote).toBe('NO_TRAIL');
  });
});

describe('the visit: unloading, the wait, the result', () => {
  it('unloading on site by GPS, as RouteIQ holds it, and by taps; the late result tap', () => {
    const { tr, input, resultB } = dayOne();
    const f = buildTruckDayFacts(input, SETTINGS, { kind: 'TRAIL', points: tr.pts, zoneMoves: [], deviceIn: [] }, { now: NOW });
    const a = f.visits.find((v) => v.sequence === 1)!;
    expect(a.unloadSource).toBe('GPS_SITE');
    expect(a.unloadSiteMin).toBeCloseTo(minutes(a.siteStartAt, a.siteEndAt), 0);
    expect(a.unloadVisitMin).toBeCloseTo(minutes(a.arrivedAt, a.departedAt), 1);
    expect(a.unloadTapMin).toBe(a.unloadVisitMin); // no GPS time on the visit: the taps are what RouteIQ holds
    expect(a.unloadMin).toBe(a.unloadSiteMin);
    expect(a.usableForRate).toBe(true);
    expect(a.minPerCase).toBeCloseTo(a.unloadMin! / 40, 2);
    expect(a.lateResultTap).toBe(false);
    expect(a.truckDistAtResultM).toBeGreaterThan(330); // saved at the second drop point
    const b = f.visits.find((v) => v.sequence === 2)!;
    // B's result was saved 10 min after the truck left: it was back at the depot, 4.2 km away.
    expect(b.resultTapAt).toEqual(resultB);
    expect(b.lateResultTap).toBe(true);
    expect(b.truckDistAtResultM).toBeGreaterThan(4000);
    expect(b.flags).toEqual(expect.arrayContaining(['LATE_RESULT_TAP', 'PHOTO_FAR']));
    expect(b.usableForRate).toBe(false); // the photo was far away
    expect(b.actualOrder).toBe(2);
    expect(b.plannedEtaMin).toBe(470);
  });

  it('a trip away and back in the middle of a visit is never unloading (the check of the study: 94 min parked 1.2 km away)', () => {
    const C = A;
    const tr = new Trail(L('06:40'), DEPOT).park(20).drive(off(C, 0, 25)).park(20);
    const leftAt = tr.at;
    tr.drive(off(C, 1200, 0)).park(30).drive(off(C, 0, 25));
    const backAt = tr.at;
    tr.park(20).drive(DEPOT).park(20);
    const result = new Date(backAt.getTime() + 15 * 60_000);
    const v = [visit(1, 1, { arrivedAt: L('07:08'), arrivalSource: 'PHONE_MANUAL', departedAt: result, departureSource: 'PHONE_MANUAL', departedAtOutcome: true, outcome: 'DELIVERED', outcomeAt: result, outcomeSource: 'PHONE_MANUAL', casesDelivered: 40 })];
    const input = day([load(1, [stop(1, C)])], v, [ev(1, 1, 'ARRIVED', L('07:08')), ev(1, 1, 'OUTCOME', result)]);
    const f = buildTruckDayFacts(input, SETTINGS, { kind: 'TRAIL', points: tr.pts, zoneMoves: [], deviceIn: [] }, { now: NOW });
    const c = f.visits[0]!;
    expect(c.awayCount).toBe(1);
    expect(c.awayMin).toBeGreaterThan(30);
    expect(c.awayMin).toBeLessThan(minutes(leftAt, backAt) + 1);
    expect(c.flags).toContain('LEFT_AND_RETURNED');
    // On site: the site span less the time away; the taps (arrival to result) keep the time away in them.
    expect(c.onSiteMin).toBeCloseTo(minutes(c.siteStartAt, c.siteEndAt) - c.awayMin!, 0);
    expect(c.unloadSiteMin).toBeLessThan(c.unloadTapMin! - 25);
    expect((c.awayJson as { minutes: number; maxDistM: number }[])[0]!.maxDistM).toBeGreaterThan(1100);
  });

  it('the window is clipped on both sides: a stop served before its window opened counts from its arrival (the prototype stored -49.6 min)', () => {
    expect(clippedMinutes(L('07:00'), L('07:30'), L('09:00'))).toBe(30);
    expect(clippedMinutes(L('07:00'), L('09:30'), L('09:00'))).toBe(30);
    expect(clippedMinutes(L('09:10'), L('09:30'), L('09:00'))).toBe(20);
    expect(clippedMinutes(L('09:10'), L('09:00'), L('09:00'))).toBeNull();
    expect(clippedMinutes(L('09:10'), L('09:30'), null)).toBe(20);
    // In the builder: served 07:08-07:58 against a window from 09:00, with and without GPS.
    const tr = new Trail(L('06:40'), DEPOT).park(20).drive(off(A, 0, 25)).park(50).drive(DEPOT).park(20);
    const v = [visit(1, 1, { arrivedAt: L('07:08'), arrivalSource: 'PHONE_MANUAL', departedAt: L('07:58'), departureSource: 'PHONE_MANUAL', departedAtOutcome: true, outcome: 'DELIVERED', outcomeAt: L('07:58'), outcomeSource: 'PHONE_MANUAL', casesDelivered: 40 })];
    const input = day([load(1, [stop(1, A, { windowStartMin: 540 })])], v, [ev(1, 1, 'ARRIVED', L('07:08')), ev(1, 1, 'OUTCOME', L('07:58'))]);
    for (const gps of [{ kind: 'TRAIL' as const, points: tr.pts, zoneMoves: [], deviceIn: [] }, { kind: 'NONE' as const }]) {
      const row = buildTruckDayFacts(input, SETTINGS, gps, { now: NOW }).visits[0]!;
      expect(row.servedBeforeWindow).toBe(true);
      expect(row.waitMin).toBe(0);
      expect(row.unloadVisitMin).toBe(50);
      expect(row.unloadTapMin).toBe(50);
      for (const k of ['waitMin', 'onSiteMin', 'unloadSiteMin', 'unloadVisitMin', 'unloadTapMin', 'unloadMin'] as const) expect(row[k] ?? 0, k).toBeGreaterThanOrEqual(0);
    }
    // Arrived before the window, unloaded after it opened: the wait is apart.
    const v2 = [visit(1, 1, { arrivedAt: L('08:30'), arrivalSource: 'PHONE_MANUAL', departedAt: L('09:20'), departureSource: 'PHONE_MANUAL', departedAtOutcome: true, outcome: 'DELIVERED', outcomeAt: L('09:20'), outcomeSource: 'PHONE_MANUAL', casesDelivered: 40 })];
    const row = buildTruckDayFacts(day([load(1, [stop(1, A, { windowStartMin: 540 })])], v2, []), SETTINGS, { kind: 'NONE' }, { now: NOW }).visits[0]!;
    expect(row).toMatchObject({ servedBeforeWindow: false, waitMin: 30, unloadVisitMin: 20, unloadSource: 'VISIT' });
  });

  it('the result and its changes: the first saved, the final, the number of events', () => {
    const { tr, input } = dayOne();
    const first = new Date(input.visits[1]!.outcomeAt!.getTime() - 5 * 60_000);
    input.events.push(ev(1, 2, 'OUTCOME', first, { payload: { outcome: 'NOT_DELIVERED', reason: 'SHOP_CLOSED' } }));
    const b = buildTruckDayFacts(input, SETTINGS, { kind: 'TRAIL', points: tr.pts, zoneMoves: [], deviceIn: [] }, { now: NOW }).visits.find((v) => v.sequence === 2)!;
    expect(b).toMatchObject({ outcome: 'DELIVERED', firstOutcome: 'NOT_DELIVERED', firstOutcomeAt: first, outcomeEvents: 2, resultChanged: true });
    expect(b.flags).toContain('RESULT_CHANGED');
    expect(b.usableForRate).toBe(false);
  });
});

describe('the legs, the depot turns and the truck-day', () => {
  it('legs in the order driven: depot -> 1 -> 2 -> depot, planned against GPS', () => {
    const { tr, input } = dayOne();
    const f = buildTruckDayFacts(input, SETTINGS, { kind: 'TRAIL', points: tr.pts, zoneMoves: [], deviceIn: [] }, { now: NOW });
    expect(f.legs.map((l) => [l.legNo, l.fromSeq, l.toSeq, l.inPlanOrder])).toEqual([
      [1, null, 1, null],
      [2, 1, 2, true],
      [3, 2, null, null],
    ]);
    const [l1, l2, l3] = f.legs;
    expect(l1!.plannedDriveMin).toBe(10); // ETA 07:10 - planned departure 07:00
    expect(l1!.kmStraight).toBeCloseTo(3, 1);
    // From the depot OUT (350 m out) to the site start (300 m before the pin).
    expect(l1!.kmGps).toBeGreaterThan(2.2);
    expect(l1!.kmGps).toBeLessThan(2.5);
    expect(l1!.hourOfDay).toBe(7);
    expect(l2!.plannedDriveMin).toBe(10); // ETA 07:50 - departure 07:40
    expect(l2!.plannedKm).toBe(3.9);
    expect(l2!.kmGps).toBeGreaterThan(2.2); // from the 350 m drop point to B's site (300 m before its pin)
    expect(l2!.kmGps).toBeLessThan(3);
    expect(l2!.driveMin).toBeGreaterThan(4);
    expect(l3!.plannedKm).toBe(4.5); // the load's return leg
    expect(l3!.kmStraight).toBeCloseTo(4.24, 1);
    // The plan's last leg holds 50 min for 4.2 km (straight 5 km/h): idle time in the plan, not a slow drive.
    expect(f.legs.map((l) => l.note)).toEqual([null, null, 'PLAN_HAS_IDLE']);
  });

  it('the truck-day: out, km, moving, at sites, overtime against the setting, the trail quality', () => {
    const { tr, input } = dayOne();
    const f = buildTruckDayFacts(input, SETTINGS, { kind: 'TRAIL', points: tr.pts, zoneMoves: [], deviceIn: [] }, { now: NOW });
    const t = f.truckDay;
    expect(t).toMatchObject({ truckCode: 'T-100', tracked: true, loads: 1, stopsPlanned: 2, stopsWithResult: 2, delivered: 2, casesPlanned: 80, casesDelivered: 80, gpsTrips: 1, lastInFrom: 'TRAIL', overtimeMin: 0, overtimeAfterMin: 540, gpsNote: null });
    expect(t.plannedOutMin).toBe(120);
    expect(t.outMin).toBeGreaterThan(70);
    expect(t.kmGps).toBeGreaterThan(9);
    expect(t.kmGps).toBeLessThan(11);
    expect(t.atSitesMin).toBeGreaterThan(65);
    expect(t.idleStops).toBe(0);
    expect(t.trailPoints).toBe(tr.pts.length);
    expect(t).toMatchObject({ frozenRuns: 0, spikes: 0, ignitionSeen: false });
    // The settings in force are on every row, with the builder's and the detector's versions.
    for (const row of [t, ...f.visits, ...f.legs]) expect(row).toMatchObject({ serviceMinPerCase: 0.25, reloadMinutes: 30, stopRadiusM: 100, dwellMin: 3, detectorVersion: DETECTOR_VERSION, analysisVersion: ANALYSIS_VERSION, builtAt: NOW, refreshedAt: NOW, frozenAt: null });
  });

  it('a trail that ended before the truck came back is closed by the tracker\'s own depot IN', () => {
    const { tr, input } = dayOne();
    const cut = tr.pts.filter((p) => p.fixAt.getTime() < L('08:10').getTime());
    const f = buildTruckDayFacts(input, SETTINGS, { kind: 'TRAIL', points: cut, zoneMoves: [], deviceIn: [L('08:25')] }, { now: NOW });
    expect(f.truckDay.lastInAt).toEqual(L('08:25'));
    expect(f.truckDay.lastInFrom).toBe('DEVICE_EVENT');
    expect(f.legs.at(-1)!.note).toContain('TRAIL_ENDED');
  });

  it('two loads: the depot turn by GPS and by the driver\'s taps, with the cases loaded', () => {
    const E = off(DEPOT, 0, 2000);
    const F = off(DEPOT, 0, -2000);
    const tr = new Trail(L('06:40'), DEPOT).park(20).drive(off(E, 15, 0)).park(15).drive(DEPOT).park(30).drive(off(F, 15, 0)).park(15).drive(DEPOT).park(20);
    const loads = [
      load(1, [stop(1, E, { etaMin: 425, departureMin: 440 })], { returnMin: 460, cases: 120 }),
      load(2, [{ ...stop(1, F, { etaMin: 495, departureMin: 510 }), customerId: 'cust-F', customerCode: 'TST0009' }], { departMin: 490, returnMin: 530, cases: 300, dispatchedAt: L('08:05') }),
    ];
    const events = [ev(1, null, 'BACK_AT_DEPOT', L('07:32')), ev(2, null, 'DEPOT_DEPART', L('07:55')), ev(2, 1, 'ARRIVED', L('08:02'))];
    const visits = [visit(1, 1, { arrivedAt: L('07:06'), arrivalSource: 'PHONE_MANUAL' }), visit(2, 1, { arrivedAt: L('08:02'), arrivalSource: 'PHONE_MANUAL' })];
    const f = buildTruckDayFacts(day(loads, visits, events), SETTINGS, { kind: 'TRAIL', points: tr.pts, zoneMoves: [], deviceIn: [] }, { now: NOW });
    expect(f.truckDay.gpsTrips).toBe(2);
    expect(f.turns).toHaveLength(1);
    const turn = f.turns[0]!;
    expect(turn).toMatchObject({ afterLoadNo: 1, nextLoadNo: 2, casesLoaded: 300, plannedTurnMin: 30, backTapAt: L('07:32'), leaveTapAt: L('07:55'), turnMinTaps: 23, loadingMinPerCase: 0.04 });
    expect(turn.turnMinGps).toBeGreaterThan(25);
    expect(turn.turnMinGps).toBeLessThan(35);
    expect(turn.minPerCaseLoading).toBeCloseTo(turn.turnMinGps! / 300, 1);
  });

  it('without a tracker: the visit\'s own times, NO_GPS, and the depot turn by taps only', () => {
    const { input } = dayOne();
    const f = buildTruckDayFacts({ ...input, tracked: false }, SETTINGS, { kind: 'NONE' }, { now: NOW });
    expect(f.truckDay).toMatchObject({ gpsNote: 'NO_TRACKER', kmGps: null, outMin: null, gpsBuiltAt: null });
    expect(f.visits.every((v) => v.flags.includes('NO_GPS') && v.siteStartAt === null && v.unloadSource === 'VISIT')).toBe(true);
    expect(f.legs.find((l) => l.fromSeq === 1 && l.toSeq === 2)).toMatchObject({ note: 'NO_GPS', kmGps: null, driveMin: f.legs[1]!.driveMinVisit });
    const sup = buildTruckDayFacts({ ...input, suppressed: true }, SETTINGS, { kind: 'NONE' }, { now: NOW });
    expect(sup.truckDay.gpsNote).toBe('SUPPRESSED');
  });
});

describe('the trail quality: spikes, jitter and frozen positions (study item 6)', () => {
  it('a single spike is no trip away and no km; timestamp jitter is never a spike', () => {
    const { tr, input } = dayOne();
    const i = tr.pts.findIndex((p) => p.fixAt.getTime() === L('07:15').getTime());
    expect(i).toBeGreaterThan(0);
    const spiked = tr.pts.map((p, k) => (k === i ? { ...p, ...off(A, 5000, 0) } : p));
    expect([...spikesOf(spiked)]).toEqual([i]);
    expect(kmBetween(spiked, tr.pts[0]!.fixAt, tr.pts.at(-1)!.fixAt, spikesOf(spiked))).toBeCloseTo(kmBetween(tr.pts, tr.pts[0]!.fixAt, tr.pts.at(-1)!.fixAt, new Set())!, 3);
    const f = buildTruckDayFacts(input, SETTINGS, { kind: 'TRAIL', points: spiked, zoneMoves: [], deviceIn: [] }, { now: NOW });
    expect(f.truckDay.spikes).toBe(1);
    expect(f.visits[0]!.awayCount).toBe(0);
    // Jitter: points 1 s apart on a straight road at 85 km/h (150 km/h+ between two of them, but the next agrees).
    const road: TrailPoint[] = [0, 16, 17, 33, 49].map((s, k) => ({ fixAt: L('09:00', s), ...off(DEPOT, 0, [0, 378, 420, 755, 1133][k]!), speedKmh: 85, ignition: null }));
    expect(spikesOf(road).size).toBe(0);
  });

  it('frozen-position runs: the same coordinates for 60 s or more while moving are counted, never deleted', () => {
    const pts: TrailPoint[] = [0, 30, 60, 90, 120].map((s) => ({ fixAt: L('10:00', s), ...A, speedKmh: 60, ignition: null }));
    expect(frozenRunsOf(pts)).toEqual({ runs: 1, minutes: 2 });
    expect(frozenRunsOf(pts.map((p) => ({ ...p, speedKmh: 0 })))).toEqual({ runs: 0, minutes: 0 }); // parked: not frozen
  });

  it('runs tolerate one isolated refused point, never two; bearings and destinations agree', () => {
    const ok = [true, true, false, true, false, false, true];
    expect(runsOf(ok.length, (i) => ok[i]!)).toEqual([
      [0, 3],
      [6, 6],
    ]);
    const p = destinationOf(A, 350, 90);
    expect(distanceM(A, p)).toBeCloseTo(350, 0);
    expect(bearingDeg(A, p)).toBeCloseTo(90, 0);
  });
});

describe('refresh and freeze (the nightly job: lib/analysis/job.ts)', () => {
  it('a refresh rebuilds what does not come from the trail, copies the trail columns and the settings, keeps when it was built', () => {
    const { tr, input } = dayOne();
    const built = buildTruckDayFacts(input, SETTINGS, { kind: 'TRAIL', points: tr.pts, zoneMoves: [], deviceIn: [] }, { now: NOW });
    // The next nights: the office corrects B's result (its own time), a setting changed meanwhile.
    const later = new Date(NOW.getTime() + 86_400_000);
    const changed = { ...input, visits: input.visits.map((v) => (v.sequence === 2 ? { ...v, outcome: 'PARTLY_DELIVERED', casesDelivered: 30, outcomeSource: 'DISPATCHER' } : v)) };
    const refreshed = buildTruckDayFacts(changed, { ...SETTINGS, serviceMinPerCase: 0.5, params: { ...SETTINGS.params, dwellMin: 6 } }, { kind: 'STORED', rows: built }, { now: later, freeze: true });
    const b0 = built.visits.find((v) => v.sequence === 2)!;
    const b1 = refreshed.visits.find((v) => v.sequence === 2)!;
    expect(b1).toMatchObject({ outcome: 'PARTLY_DELIVERED', casesDelivered: 30, outcomeSource: 'DISPATCHER' });
    // The trail columns as built.
    for (const k of ['siteStartAt', 'siteEndAt', 'onSiteMin', 'substays', 'dropPoints', 'standDistM', 'unloadSiteMin', 'truckDistAtResultM', 'lateResultTap', 'detectorStays'] as const) expect(b1[k], k).toEqual(b0[k]);
    expect(refreshed.truckDay.kmGps).toBe(built.truckDay.kmGps);
    expect(refreshed.truckDay.firstOutAt).toEqual(built.truckDay.firstOutAt);
    expect(refreshed.legs.map((l) => l.kmGps)).toEqual(built.legs.map((l) => l.kmGps));
    // The settings it was first built with; built then, refreshed and frozen now.
    for (const row of [refreshed.truckDay, ...refreshed.visits, ...refreshed.legs]) {
      expect(row).toMatchObject({ serviceMinPerCase: 0.25, dwellMin: 3, builtAt: NOW, gpsBuiltAt: NOW, refreshedAt: later, frozenAt: later });
    }
  });

  it("a result tap that changed after the build keeps no distance (the trail is gone, the old one was another tap's)", () => {
    const { tr, input } = dayOne();
    const built = buildTruckDayFacts(input, SETTINGS, { kind: 'TRAIL', points: tr.pts, zoneMoves: [], deviceIn: [] }, { now: NOW });
    const tap = new Date(input.visits[0]!.outcomeAt!.getTime() + 60_000);
    const changed = { ...input, events: [...input.events, ev(1, 1, 'OUTCOME', tap)] };
    const a = buildTruckDayFacts(changed, SETTINGS, { kind: 'STORED', rows: built }, { now: NOW }).visits.find((v) => v.sequence === 1)!;
    expect(a.resultTapAt).toEqual(tap);
    expect(a.truckDistAtResultM).toBeNull();
    expect(a.lateResultTap).toBeNull();
  });
});
