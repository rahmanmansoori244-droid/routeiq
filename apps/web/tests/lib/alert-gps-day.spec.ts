/**
 * GPS alerts end to end on the in-memory database (fake-plan-db.ts; owner request 18 Oct 2026): the IVMS
 * GPS writer (lib/ivms/stop-events.ts processGpsTimes) turns a stored trail into AYUN arrivals and
 * departures and trail depot moves, then the alerts' facts reader (lib/alerts/facts.ts readAlertFacts) and
 * the rules (lib/alerts/rules.ts) read them:
 *  - GPS tracking TIMES: the facts carry no GPS (the GPS-only visits are none), as before 18 Oct 2026;
 *  - ALERTS: the visits keep their GPS times, the truck-day gets its trail-confirmed depot moves (exact:
 *    a trail point just before each) - the long stop the trail saw is one unloading history row naming
 *    GPS, and "Load not closed" says the truck is back at the depot by GPS; a gap in the trail makes the
 *    times not exact (not measured); two trips without Back at depot or Leaving for next load: the depot IN
 *    and OUT the trail saw measure the time at the depot (R2, the detector's trips matched to the loads);
 *  - ALERTS with the truck-day's GPS undone (suppressed): read as with the link off;
 *  - review of 18 Oct 2026, finding 6: the trail moves are stored with whether their time is exact, so the
 *    alerts and the replay export keep it after the retention deletes the trail points.
 * Invented data: the empty-desert depot of tests/lib/ivms-trail.ts, truck T-100, shops "Shop Example A/B".
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resetDb, tables } from './fake-plan-db';
import { T, Trail, at, hhmm } from './ivms-trail';

vi.mock('@/lib/db', async () => ({ prisma: (await import('./fake-plan-db')).fakePrisma }));
vi.mock('@/lib/dispatch/plan-service', async (orig) => ({ ...(await orig<typeof import('@/lib/dispatch/plan-service')>()), completeLoadAsDriver: vi.fn(async () => ({ completed: true })) }));

const { fakePrisma } = await import('./fake-plan-db');
const { processGpsTimes, suppressGpsTimes } = await import('@/lib/ivms/stop-events');
const { readAlertFacts } = await import('@/lib/alerts/facts');
const { evaluate } = await import('@/lib/alerts/rules');
const { gpsAlertConfigOf } = await import('@/lib/alerts/gps');
const { exportAlertDay, exportGps } = await import('@/lib/alerts/replay-export');
const { factsAsOf } = await import('@/lib/alerts/replay');
const { thresholdsOf } = await import('@/lib/alerts/catalog');

const TEN = 'tA';
const DATE = '2026-10-20';
const TZ = 'Asia/Muscat';
const NOW = T('16:00');
const day = new Date(`${DATE}T00:00:00.000Z`);
const SHOP_A = at(3000);
const SHOP_B = at(6000);
const THRESHOLDS = thresholdsOf({ alertsEnabled: true, alertUnloadOverMin: 30, alertLoadingOverMin: 40, alertNotClosedMin: 120, alertEtaLateMin: 30, alertDepartLateMin: 30, alertAfterClosingMin: 15, alertSilentMin: 120 });

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
  serviceMin: 10,
  priority: 3,
  hardStartMin: 0,
  hardEndMin: 1439,
  prefStartMin: null,
  prefEndMin: null,
  source: 'PLAN',
  capturedAt: T('05:00').toISOString(),
});

function seed(mode: 'TIMES' | 'ALERTS') {
  resetDb();
  tables.tenant = [{ id: TEN, name: 'Synthetic Water Co', active: true }];
  tables.tenantConfig = [{ id: 'cfg', tenantId: TEN, timezone: TZ, geofenceRadiusM: 100, photoProofRequired: true, ivmsMode: mode, ivmsStopRadiusM: 100, ivmsStopDwellMin: 3, ivmsDepotRadiusM: 300, avgSpeedKmh: 40, distanceMultiplier: 1.3 }];
  tables.depot = [{ id: 'D1', tenantId: TEN, code: 'D1', name: 'Depot', ...at(0) }];
  tables.truck = [{ id: 't1', tenantId: TEN, code: 'T-100', hired: false, ivmsImei: '111111111111111', onlyOnDate: null }];
  tables.driver = [];
  tables.runPlan = [{ id: 'R1', tenantId: TEN, depotId: 'D1', runDate: day, status: 'DISPATCHED', version: 1, supersededAt: null, chosenScenarioId: 'sc', createdAt: T('04:00') }];
  tables.planLoad = [{ id: 'L1', tenantId: TEN, runId: 'R1', truckId: 't1', loadNo: 1, status: 'DISPATCHED', departMin: 420, returnMin: 600, driverId: null, statusChangedAt: T('06:55'), breakJson: null, truckSnapshotJson: null, carriedFromLoadId: null }];
  const line = (id: string, cases: number) => ({ id, cases, weightKg: cases * 10, product: { code: 'WATER-A' } });
  tables.order = [
    { id: 'O1', tenantId: TEN, customerId: 'C-A', carriedToOrderId: null, priority: 3, lines: [line('LA', 30)] },
    { id: 'O2', tenantId: TEN, customerId: 'C-B', carriedToOrderId: null, priority: 3, lines: [line('LB', 20)] },
  ];
  // Stop 1 planned 07:10 for 10 min, stop 2 07:20 for 10 min.
  const ra = (id: string, orderId: string, sequence: number, snap: unknown) => ({ id, runId: 'R1', loadId: 'L1', truckId: 't1', orderId, loadNo: 1, sequenceInTruck: sequence, orderInStop: 0, etaMin: 420 + sequence * 10, serviceStartMin: 420 + sequence * 10, departureMin: 430 + sequence * 10, portionLinesJson: null, stopSnapshotJson: snap });
  tables.routeAssignment = [ra('A1', 'O1', 1, snapshot('A', SHOP_A)), ra('A2', 'O2', 2, snapshot('B', SHOP_B))];
  tables.auditLog = [{ id: 'au1', tenantId: TEN, action: 'LOAD_DISPATCHED', entity: 'PlanLoad', entityId: 'L1', createdAt: T('06:55') }];
  tables.driverLink = [{ id: 'dl1', tenantId: TEN, truckId: 't1', deliveryDate: day, lastSeenAt: T('06:58') }];
  tables.stopVisit = [];
  tables.stopEvent = [];
  tables.deliveryPhoto = [];
  tables.ivmsEvent = [];
  tables.ivmsTruckDay = [];
  tables.opsAlert = [];
  // The trail from the history pulls: loading at the depot, an hour at shop A, 8 min at shop B, back.
  const trail = new Trail('06:30').park(30).drive(3000).park(60).drive(6000).park(8).drive(0).park(20);
  tables.truckTrailPoint = trail.pts.map((p, i) => ({ id: `tp${i}`, tenantId: TEN, truckId: 't1', ...p }));
}

async function sweepFacts() {
  const gps = gpsAlertConfigOf(tables.tenantConfig![0], false);
  const { facts } = await readAlertFacts(fakePrisma as never, TEN, { tz: TZ, now: NOW, thresholds: THRESHOLDS, gps });
  return { facts, ev: evaluate(facts, NOW, THRESHOLDS) };
}

let prevDisable: string | undefined;
beforeEach(() => {
  prevDisable = process.env.ROUTEIQ_DISABLE_IVMS;
  delete process.env.ROUTEIQ_DISABLE_IVMS;
  return () => {
    if (prevDisable === undefined) delete process.env.ROUTEIQ_DISABLE_IVMS;
    else process.env.ROUTEIQ_DISABLE_IVMS = prevDisable;
  };
});

describe('GPS tracking TIMES: the alerts read no GPS, as before', () => {
  it('the GPS writer fills the stops, the facts leave them out: no unloading alert, no Back at depot', async () => {
    seed('TIMES');
    expect(await processGpsTimes(TEN, 't1', DATE, NOW)).toMatchObject({ skipped: null, written: 4 });
    const { facts, ev } = await sweepFacts();
    expect(facts.gps).toBeUndefined();
    expect(facts.truckDays[0]!.gps).toBeUndefined();
    expect(facts.loads[0]!.stops.map((s) => s.visit)).toEqual([null, null]);
    expect(ev.active.find((c) => c.rule === 'UNLOAD_OVER')).toBeUndefined();
    expect(ev.active.find((c) => c.rule === 'LOAD_NOT_CLOSED')?.text).toMatch(/no Back at depot, 2 of 2 stops without a result/);
    for (const c of ev.active) expect(c.text).not.toContain('GPS');
  });
});

describe('GPS tracking ALERTS: the alerts read the GPS times and the depot moves', () => {
  it('the hour the trail saw at shop A is one unloading history row naming GPS; the truck is back by GPS', async () => {
    seed('ALERTS');
    expect(await processGpsTimes(TEN, 't1', DATE, NOW)).toMatchObject({ skipped: null, written: 4 });
    const { facts, ev } = await sweepFacts();
    expect(facts.gps).toMatchObject({ atStopRadiusM: 250, atDepotRadiusM: 450 });
    const gps = facts.truckDays[0]!.gps!;
    // The trail's own depot moves (no live fix in this day: not tracked), both exact.
    expect(gps).toMatchObject({ tracked: false, position: null });
    expect(gps.depotOut.map((m) => [hhmm(m.at), m.observed])).toEqual([['07:01', true]]);
    expect(gps.depotIn.map((m) => [hhmm(m.at), m.observed])).toEqual([[hhmm(gps.depotIn[0]!.at), true]]);
    expect(facts.loads[0]!.stops[0]!.visit).toMatchObject({ arrivalSource: 'AYUN', arrivalObserved: true, departureSource: 'AYUN', departureObserved: true });
    expect(facts.loads[0]!.stops[0]!.pin).toEqual(SHOP_A);

    const unload = ev.active.find((c) => c.rule === 'UNLOAD_OVER')!;
    expect(unload).toMatchObject({ sequence: 1, history: true, tier: 1, facts: { gps: true } });
    // The stay: from the first point inside the pin's radius to the first point that left it (about an hour).
    expect(unload.value).toBeGreaterThanOrEqual(50);
    expect(unload.value).toBeLessThanOrEqual(52);
    expect(unload.text).toMatch(/^T-100 L1 stop 1 Shop Example A \(A\): unloading took 1 h( 0\d min)? \(GPS arrival and departure\), planned 10 min \(5\d min over\)\.$/);
    const notClosed = ev.active.find((c) => c.rule === 'LOAD_NOT_CLOSED')!;
    expect(notClosed.text).toMatch(new RegExp(`back at the depot at ${hhmm(gps.depotIn[0]!.at)} \\(GPS\\), 2 of 2 stops without a result`));
    // Never a position in a text or the row's facts.
    for (const c of ev.active) expect(`${c.text} ${JSON.stringify(c.facts ?? {})}`).not.toMatch(/20\.1|55\.1/);
  });

  it('a GPS time the trail had a gap before is not measured', async () => {
    seed('ALERTS');
    // A coverage hole of 8 minutes before shop A: the GPS arrival is only an upper bound.
    tables.truckTrailPoint = tables.truckTrailPoint!.filter((p) => !(p.fixAt >= T('06:57') && p.fixAt < T('07:05:30')));
    await processGpsTimes(TEN, 't1', DATE, NOW);
    const { facts, ev } = await sweepFacts();
    expect(facts.loads[0]!.stops[0]!.visit).toMatchObject({ arrivalSource: 'AYUN', arrivalObserved: false });
    expect(ev.active.find((c) => c.rule === 'UNLOAD_OVER')).toBeUndefined();
    expect(ev.ended.find((e) => e.rule === 'UNLOAD_OVER' && e.subjectKey.endsWith('|1|1'))?.text).toMatch(/GPS arrival 07:05 is not certain/);
    // The depot OUT came after the hole: no trail point within 5 min before it, so its time is not exact either.
    expect(facts.truckDays[0]!.gps!.depotOut[0]).toMatchObject({ observed: false });
  });

  it('two trips, no Back at depot or Leaving tap: the depot IN and OUT the trail saw measure the time at the depot (R2), one history row naming GPS', async () => {
    /** L1 to shop A, back to the depot for an hour, L2 to shop B; both loads pressed Dispatch in the morning. */
    const twoTrips = (mode: 'TIMES' | 'ALERTS') => {
      seed(mode);
      tables.planLoad = [
        { ...tables.planLoad![0], createdAt: T('04:00') },
        { id: 'L2', tenantId: TEN, runId: 'R1', truckId: 't1', loadNo: 2, status: 'DISPATCHED', departMin: 510, returnMin: 600, driverId: null, statusChangedAt: T('06:56'), breakJson: null, truckSnapshotJson: null, carriedFromLoadId: null, createdAt: T('04:00') },
      ];
      tables.routeAssignment = [{ ...tables.routeAssignment![0] }, { ...tables.routeAssignment![1], id: 'B1', loadId: 'L2', loadNo: 2, sequenceInTruck: 1, etaMin: 540, serviceStartMin: 540, departureMin: 550 }];
      tables.auditLog = [...tables.auditLog!, { id: 'au2', tenantId: TEN, action: 'LOAD_DISPATCHED', entity: 'PlanLoad', entityId: 'L2', createdAt: T('06:56') }];
      const trail = new Trail('06:30').park(30).drive(3000).park(20).drive(0).park(60).drive(6000).park(10).drive(0).park(20);
      tables.truckTrailPoint = trail.pts.map((p, i) => ({ id: `tp${i}`, tenantId: TEN, truckId: 't1', ...p }));
    };
    twoTrips('TIMES');
    expect(await processGpsTimes(TEN, 't1', DATE, NOW)).toMatchObject({ skipped: null, written: 4 });
    const times = (await sweepFacts()).ev;
    expect(times.ended.find((e) => e.rule === 'LOADING_OVER' && e.subjectKey.endsWith('|2'))?.text).toMatch(/^T-100 L2: no Back at depot tapped for L1/);

    twoTrips('ALERTS');
    expect(await processGpsTimes(TEN, 't1', DATE, NOW)).toMatchObject({ skipped: null, written: 4 });
    const { facts, ev } = await sweepFacts();
    const gps = facts.truckDays[0]!.gps!;
    expect(gps.depotIn.length).toBeGreaterThanOrEqual(2);
    const back = hhmm(gps.depotIn[0]!.at);
    const left = hhmm(gps.depotOut[1]!.at);
    const r2 = ev.active.find((c) => c.rule === 'LOADING_OVER')!;
    expect(r2).toMatchObject({ loadNo: 2, history: true, tier: 1, facts: { how: 'GPS', gps: true } });
    expect(r2.value).toBeGreaterThan(55);
    expect(r2.value).toBeLessThan(65);
    expect(r2.text).toMatch(new RegExp(`^T-100 L2: 1 h( 0\\d min)? at the depot between L1 and L2 \\(back ${back} \\(GPS\\), left ${left}, by the GPS depot exit \\(no Leaving tap\\)\\), limit 40 min\\.$`));
  });

  it('review finding 6: the detector stores whether each trail move is exact; the alerts and the replay export keep it after the trail points are deleted', async () => {
    seed('ALERTS');
    await processGpsTimes(TEN, 't1', DATE, NOW);
    const trailMoves = tables.ivmsEvent!.filter((e) => e.origin === 'TRAIL');
    expect(trailMoves.length).toBeGreaterThanOrEqual(2);
    for (const e of trailMoves) expect(e).toMatchObject({ observed: true, depotId: 'D1' });
    // The retention deletes the trail points after ivmsTrailDays: the depot times stay exact.
    tables.truckTrailPoint = [];
    const gps = (await sweepFacts()).facts.truckDays[0]!.gps!;
    expect([...gps.depotOut, ...gps.depotIn].map((m) => [m.observed, m.depotId])).toEqual(trailMoves.map(() => [true, 'D1']));
    const later = new Date(NOW.getTime() + 3 * 24 * 3_600_000);
    const saved = (await exportGps(fakePrisma as never, TEN, DATE, TZ, ['t1'], later))!;
    expect(saved.truckDays[0]!.moves.map((m) => [m.observed, m.depotId])).toEqual(trailMoves.map(() => [true, 'D1']));
    expect(saved.warnings).toBeUndefined();
    // A trail move stored before the flag existed: read against the points, which are gone - saved as not exact, and said.
    for (const e of tables.ivmsEvent!) delete (e as { observed?: unknown }).observed;
    const legacy = (await exportGps(fakePrisma as never, TEN, DATE, TZ, ['t1'], later))!;
    expect(legacy.truckDays[0]!.moves.every((m) => !m.observed)).toBe(true);
    expect(legacy.warnings?.[0]).toMatch(/^\d+ GPS depot moves were stored before RouteIQ kept whether their time is exact, and the trail points of that time may be deleted already \(trail kept 2 days\)/);
  });

  it('review of 19 Oct 2026: a leave-and-return - the replay of the exported day measures UNLOAD_OVER on site, with the same words, as the live alerts do', async () => {
    seed('ALERTS');
    // Shop A: 20 min at the pin, a 6 km trip to stand 20 min elsewhere, back for 30 min, then shop B and the depot.
    const trail = new Trail('06:30').park(30).drive(3000).park(20).drive(9000, 0, 40).park(20).drive(3000, 0, 40).park(30).drive(6000).park(8).drive(0).park(20);
    tables.truckTrailPoint = trail.pts.map((p, i) => ({ id: `tp${i}`, tenantId: TEN, truckId: 't1', ...p }));
    // The driver tapped the arrival at 07:05 and the result at 08:25 (in the second stay).
    tables.stopVisit!.push({ id: 'v1', tenantId: TEN, depotId: 'D1', deliveryDate: day, truckId: 't1', loadNo: 1, sequence: 1, customerId: 'C-A', firstLoadId: 'L1', plannedLat: SHOP_A.lat, plannedLng: SHOP_A.lng, plannedServiceMin: 10, windowStartMin: null, windowEndMin: null, linesJson: [], casesPlanned: 30, arrivalSource: 'PHONE_MANUAL', locationPurgedAt: null });
    tables.stopEvent!.push(
      { id: 'tap', tenantId: TEN, depotId: 'D1', deliveryDate: day, truckId: 't1', loadNo: 1, sequence: 1, visitId: 'v1', kind: 'ARRIVED', source: 'PHONE_MANUAL', at: T('07:05'), receivedAt: T('07:05'), idempotencyKey: 'dl:tap', payloadJson: { mode: 'MANUAL' } },
      { id: 'res', tenantId: TEN, depotId: 'D1', deliveryDate: day, truckId: 't1', loadNo: 1, sequence: 1, visitId: 'v1', kind: 'OUTCOME', source: 'PHONE_MANUAL', at: T('08:25'), receivedAt: T('08:25'), idempotencyKey: 'dl:res', payloadJson: { outcome: 'DELIVERED' } },
    );
    await processGpsTimes(TEN, 't1', DATE, NOW);
    const visit = tables.stopVisit!.find((v) => v.id === 'v1')!;
    expect(visit.awayMinutes).toBeGreaterThan(30);
    const live = (await sweepFacts()).ev.active.find((c) => c.rule === 'UNLOAD_OVER' && c.sequence === 1)!;
    expect(live.text).toMatch(new RegExp(`\\(away ${Math.round(visit.awayMinutes)} min not counted, GPS\\)`));
    expect(live.facts).toMatchObject({ awayMin: Math.round(visit.awayMinutes) });
    // The day saved for the replay keeps each GPS event's stay start and minutes away (never a position) ...
    const exp = await exportAlertDay(fakePrisma as never, TEN, DATE, { now: NOW });
    const saved = exp.loads[0]!.stops[0]!.visit!.events.filter((e) => e.source === 'AYUN' && e.kind === 'ARRIVED');
    expect(saved.map((e) => e.payload)).toEqual([
      expect.objectContaining({ segmentStartAt: expect.any(String), stay: { awayMin: null } }),
      expect.objectContaining({ segmentStartAt: expect.any(String), stay: { awayMin: visit.awayMinutes } }),
    ]);
    // ... so the replayed UNLOAD_OVER is the live one: the same minutes, tier and words (before: the absence counted).
    const replayed = evaluate(factsAsOf(exp, NOW, [], 100, { gps: true }), NOW, THRESHOLDS).active.find((c) => c.rule === 'UNLOAD_OVER' && c.sequence === 1)!;
    expect({ text: replayed.text, value: replayed.value, tier: replayed.tier, facts: replayed.facts }).toEqual({ text: live.text, value: live.value, tier: live.tier, facts: live.facts });
  });

  it('the truck-day undone (suppressed): read as with the link off', async () => {
    seed('ALERTS');
    await processGpsTimes(TEN, 't1', DATE, NOW);
    await suppressGpsTimes(TEN, 't1', DATE, 'UNDO', { dryRun: false, now: NOW });
    const { facts, ev } = await sweepFacts();
    expect(facts.truckDays[0]!.gps).toBeNull();
    expect(ev.active.find((c) => c.rule === 'UNLOAD_OVER')).toBeUndefined();
    expect(ev.active.find((c) => c.rule === 'LOAD_NOT_CLOSED')?.text).toMatch(/no Back at depot/);
  });
});
