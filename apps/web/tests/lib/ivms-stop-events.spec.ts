/**
 * The GPS stop-time writer of the IVMS live link (lib/ivms/stop-events.ts; design section 6.2 with the
 * binding review's H1/H3/H4/M2/M10) on the in-memory database (fake-plan-db.ts): it runs only in TIMES,
 * writes AYUN arrivals and departures with natural keys, never a result, a Back at depot or a
 * completion, never twice for the same stay, leaves the driver room, gives nothing to a stop the office
 * timed, honours the kill switch and the "GPS suppressed" marker, and undoes cleanly. Invented data: an
 * empty-desert depot, trucks T05/T06, shops "Shop Example A/B".
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakePrisma, resetDb, tables } from './fake-plan-db';
import { T, Trail, at } from './ivms-trail';

vi.mock('@/lib/db', async () => ({ prisma: (await import('./fake-plan-db')).fakePrisma }));
const { completeLoad } = vi.hoisted(() => ({ completeLoad: vi.fn(async () => ({ completed: true })) }));
vi.mock('@/lib/dispatch/plan-service', async (orig) => ({ ...(await orig<typeof import('@/lib/dispatch/plan-service')>()), completeLoadAsDriver: completeLoad }));

const { processGpsTimes, processGpsTimesForCompany, suppressGpsTimes, gpsEventKey, clampEventAt, MAX_AYUN_EVENTS_PER_VISIT } = await import('@/lib/ivms/stop-events');
const { completeReturnedLoads } = await import('@/lib/delivery/event-service');

const TEN = 'tA';
const DATE = '2026-10-20';
const NOW = T('16:00');
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

function seed(mode = 'TIMES') {
  resetDb();
  completeLoad.mockClear();
  tables.tenant = [{ id: TEN, name: 'Synthetic Water Co', active: true }];
  tables.tenantConfig = [{ id: 'cfg', tenantId: TEN, timezone: 'Asia/Muscat', geofenceRadiusM: 100, photoProofRequired: true, ivmsMode: mode, ivmsStopRadiusM: 100, ivmsStopDwellMin: 3, ivmsDepotRadiusM: 300 }];
  tables.depot = [{ id: 'D1', tenantId: TEN, code: 'D1', name: 'Depot', ...at(0) }];
  tables.truck = [{ id: 't5', tenantId: TEN, code: 'T05', hired: false, ivmsImei: '111111111111111', onlyOnDate: null }];
  tables.driver = [];
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
  // The trail from the history pulls: loading at the depot, shop A, shop B, back.
  const trail = new Trail('06:30').park(30).drive(3000).park(10).drive(6000).park(8).drive(0).park(20);
  tables.truckTrailPoint = trail.pts.map((p, i) => ({ id: `tp${i}`, tenantId: TEN, truckId: 't5', ...p }));
}

const events = () => tables.stopEvent!;
const visitOf = (seq: number) => tables.stopVisit!.find((v) => v.sequence === seq);

let prevDisable: string | undefined;
beforeEach(() => {
  prevDisable = process.env.ROUTEIQ_DISABLE_IVMS;
  delete process.env.ROUTEIQ_DISABLE_IVMS;
  seed();
});
afterEach(() => {
  if (prevDisable === undefined) delete process.env.ROUTEIQ_DISABLE_IVMS;
  else process.env.ROUTEIQ_DISABLE_IVMS = prevDisable;
});

describe('nothing happens unless the company is in TIMES', () => {
  it('OFF and MAP write nothing; the kill switch stops everything', async () => {
    for (const mode of ['OFF', 'MAP']) {
      seed(mode);
      expect(await processGpsTimes(TEN, 't5', DATE, NOW)).toMatchObject({ skipped: 'MODE', written: 0 });
      expect(events()).toEqual([]);
      expect(tables.ivmsEvent).toEqual([]);
    }
    seed('TIMES');
    process.env.ROUTEIQ_DISABLE_IVMS = '1';
    expect(await processGpsTimes(TEN, 't5', DATE, NOW)).toMatchObject({ skipped: 'DISABLED' });
    expect(await processGpsTimesForCompany(TEN, NOW)).toMatchObject({ skipped: 'DISABLED', truckDays: 0 });
    expect(events()).toEqual([]);
  });

  it('a load that is not on the road (LOADING) gets nothing: GPS never presses Dispatch', async () => {
    tables.planLoad![0]!.status = 'LOADING';
    expect(await processGpsTimes(TEN, 't5', DATE, NOW)).toMatchObject({ skipped: 'NO_LOAD' });
    expect(events()).toEqual([]);
  });
});

describe('a dispatched load with a trail', () => {
  it('writes AYUN arrivals and departures with natural keys, rebuilds the visits, and nothing else', async () => {
    const r = await processGpsTimes(TEN, 't5', DATE, NOW);
    expect(r).toMatchObject({ skipped: null, written: 4, busy: false });
    expect(events().map((e) => `${e.sequence} ${e.kind} ${e.source}`)).toEqual(['1 ARRIVED AYUN', '1 DEPARTED AYUN', '2 ARRIVED AYUN', '2 DEPARTED AYUN']);
    const a1 = events()[0]!;
    expect(a1.idempotencyKey).toBe(gpsEventKey({ kind: 'ARRIVED', loadNo: 1, sequence: 1, segmentStartAt: T('07:04:30') }, 'D1', DATE, 't5'));
    expect(a1.idempotencyKey).toMatch(/^ayun:A:D1:2026-10-20:t5:1:1:\d+$/);
    expect(a1.payloadJson).toMatchObject({ observed: true, detector: 'ivms-v1', segmentStartAt: T('07:04:30').toISOString() });
    // No driver link, no user, no browser: GPS is nobody's tap.
    expect([a1.driverLinkId ?? null, a1.userId ?? null, a1.clientIp ?? null, a1.deviceId ?? null, a1.accuracyM]).toEqual([null, null, null, null, null]);
    // Never a result, a Back at depot, a completion or an audit row.
    expect(events().some((e) => e.kind === 'OUTCOME' || e.kind === 'BACK_AT_DEPOT')).toBe(false);
    expect(completeLoad).not.toHaveBeenCalled();
    expect(tables.auditLog!.filter((a) => a.action !== 'LOAD_DISPATCHED')).toEqual([]);
    expect(tables.planLoad![0]!.status).toBe('DISPATCHED');
    // The visits carry the GPS times, and stay without a result.
    expect(visitOf(1)).toMatchObject({ arrivalSource: 'AYUN', departureSource: 'AYUN', outcome: null, autoServiceMinutes: null });
    expect(visitOf(1)!.arrivedAt).toEqual(T('07:04:30'));
    // The depot moves from the trail are kept as facts (origin TRAIL).
    expect(tables.ivmsEvent!.map((e) => `${e.kind} ${e.origin} ${e.outcome}`)).toEqual(['DEPOT_OUT TRAIL USED', 'DEPOT_IN TRAIL USED']);
    expect(tables.ivmsTruckDay![0]).toMatchObject({ truckId: 't5', processedAt: NOW, gpsFactsJson: [] });
  });

  it('a second run writes nothing (first write wins), also after a delayed point moved the stay start', async () => {
    await processGpsTimes(TEN, 't5', DATE, NOW);
    expect(await processGpsTimes(TEN, 't5', DATE, NOW)).toMatchObject({ written: 0, kept: { DUPLICATE: 4 } });
    tables.truckTrailPoint!.push({ id: 'late', tenantId: TEN, truckId: 't5', fixAt: T('07:04:15'), ...at(2995), speedKmh: 3, ignition: true });
    expect((await processGpsTimes(TEN, 't5', DATE, NOW)).written).toBe(0);
    expect(events()).toHaveLength(4);
    expect(tables.ivmsEvent).toHaveLength(2);
  });

  it("the driver's tap stays the arrival; the GPS departure fills the gap the phone left", async () => {
    tables.stopVisit!.push({ id: 'v1', tenantId: TEN, depotId: 'D1', deliveryDate: day, truckId: 't5', loadNo: 1, sequence: 1, customerId: 'C-A', firstLoadId: 'L1', plannedLat: SHOP_A.lat, plannedLng: SHOP_A.lng, windowStartMin: null, windowEndMin: null, linesJson: [], casesPlanned: 30, arrivalSource: 'PHONE_MANUAL', locationPurgedAt: null });
    tables.stopEvent!.push({ id: 'tap', tenantId: TEN, depotId: 'D1', deliveryDate: day, truckId: 't5', loadNo: 1, sequence: 1, visitId: 'v1', kind: 'ARRIVED', source: 'PHONE_MANUAL', at: T('07:06'), receivedAt: T('07:06'), idempotencyKey: 'dl:tap', payloadJson: { mode: 'MANUAL' } });
    await processGpsTimes(TEN, 't5', DATE, NOW);
    expect(visitOf(1)).toMatchObject({ arrivalSource: 'PHONE_MANUAL', departureSource: 'AYUN' });
    expect(visitOf(1)!.arrivedAt).toEqual(T('07:06'));
  });

  it('a stop the office timed gets nothing', async () => {
    tables.stopVisit!.push({ id: 'v1', tenantId: TEN, depotId: 'D1', deliveryDate: day, truckId: 't5', loadNo: 1, sequence: 1, customerId: 'C-A', firstLoadId: 'L1', plannedLat: SHOP_A.lat, plannedLng: SHOP_A.lng, windowStartMin: null, windowEndMin: null, linesJson: [], casesPlanned: 30, arrivalSource: 'DISPATCHER', locationPurgedAt: null });
    await processGpsTimes(TEN, 't5', DATE, NOW);
    expect(events().filter((e) => e.sequence === 1)).toEqual([]);
    expect(events().filter((e) => e.sequence === 2)).toHaveLength(2);
  });

  it('leaves the driver room: never past 4 AYUN events, never once the stop holds 36 events', async () => {
    tables.stopVisit!.push({ id: 'v1', tenantId: TEN, depotId: 'D1', deliveryDate: day, truckId: 't5', loadNo: 1, sequence: 1, customerId: 'C-A', firstLoadId: 'L1', plannedLat: SHOP_A.lat, plannedLng: SHOP_A.lng, windowStartMin: null, windowEndMin: null, linesJson: [], casesPlanned: 30, arrivalSource: null, locationPurgedAt: null });
    for (let i = 0; i < 36; i++) tables.stopEvent!.push({ id: `x${i}`, tenantId: TEN, depotId: 'D1', deliveryDate: day, truckId: 't5', loadNo: 1, sequence: 1, visitId: 'v1', kind: i % 2 ? 'DEPARTED' : 'ARRIVED', source: 'PHONE_AUTO', at: T('05:00'), receivedAt: T('05:00'), idempotencyKey: `dl:x${i}`, payloadJson: {} });
    const r = await processGpsTimes(TEN, 't5', DATE, NOW);
    expect(r.kept.ROOM).toBe(2);
    expect(events().filter((e) => e.source === 'AYUN' && e.sequence === 1)).toEqual([]);
    expect(MAX_AYUN_EVENTS_PER_VISIT).toBe(4);
  });

  it('an unconfirmed (forged) depot webhook never cuts the trip; a confirmed one is marked USED', async () => {
    tables.ivmsEvent!.push(
      { id: 'w1', tenantId: TEN, truckId: 't5', depotId: 'D1', kind: 'DEPOT_OUT', origin: 'WEBHOOK', eventAt: T('06:59'), dedupeKey: 'ayun:w1xxxxxxxx', processedAt: null, outcome: null },
      { id: 'w2', tenantId: TEN, truckId: 't5', depotId: 'D1', kind: 'DEPOT_IN', origin: 'WEBHOOK', eventAt: T('07:10'), dedupeKey: 'ayun:w2xxxxxxxx', processedAt: null, outcome: null },
    );
    const r = await processGpsTimes(TEN, 't5', DATE, NOW);
    expect(r.written).toBe(4);
    expect(tables.ivmsEvent!.find((e) => e.id === 'w1')).toMatchObject({ outcome: 'USED', processedAt: NOW });
    expect(tables.ivmsEvent!.find((e) => e.id === 'w2')).toMatchObject({ outcome: 'UNCONFIRMED' });
  });
});

describe('a swapped tracker and a late webhook (M8, M12)', () => {
  it("the driver's phone far from the trail: the truck-day is suppressed MISMATCH and nothing is written", async () => {
    const ev = (t: string, east: number) => ({ id: `ph${t}`, tenantId: TEN, depotId: 'D1', deliveryDate: day, truckId: 't5', loadNo: 1, sequence: 1, visitId: null, kind: 'ARRIVED', source: 'PHONE_AUTO', at: T(t), receivedAt: T(t), ...at(east), idempotencyKey: `dl:${t}`, payloadJson: {} });
    tables.stopEvent!.push(ev('07:05', 20_000), ev('07:10', 20_000), ev('07:20', 25_000));
    expect(await processGpsTimes(TEN, 't5', DATE, NOW)).toMatchObject({ skipped: 'MISMATCH', written: 0 });
    expect(tables.stopEvent!.filter((e) => e.source === 'AYUN')).toEqual([]);
    expect(tables.ivmsTruckDay![0]).toMatchObject({ suppressReason: 'MISMATCH', suppressedAt: NOW });
  });

  it('a trail move stored before the webhook of the same move arrived becomes a DUPLICATE', async () => {
    await processGpsTimes(TEN, 't5', DATE, NOW);
    expect(tables.ivmsEvent!.map((e) => `${e.kind} ${e.origin} ${e.outcome}`)).toEqual(['DEPOT_OUT TRAIL USED', 'DEPOT_IN TRAIL USED']);
    tables.ivmsEvent!.push({ id: 'late', tenantId: TEN, truckId: 't5', depotId: 'D1', kind: 'DEPOT_OUT', origin: 'WEBHOOK', eventAt: T('06:59:30'), dedupeKey: 'ayun:latexxxxxx', processedAt: null, outcome: null });
    await processGpsTimes(TEN, 't5', DATE, NOW);
    expect(tables.ivmsEvent!.map((e) => `${e.kind} ${e.origin} ${e.outcome}`)).toEqual(['DEPOT_OUT TRAIL DUPLICATE', 'DEPOT_IN TRAIL USED', 'DEPOT_OUT WEBHOOK USED']);
    expect(tables.stopEvent!.filter((e) => e.source === 'AYUN')).toHaveLength(4);
  });
});

describe('the company run and the GPS suppressed marker (M10)', () => {
  it('runs a truck-day whose history was pulled since the last run, and not again until the next pull', async () => {
    tables.ivmsTruckDay!.push({ id: 'td', tenantId: TEN, truckId: 't5', deliveryDate: day, lastPullAt: T('15:00'), processedAt: null, suppressedAt: null });
    expect(await processGpsTimesForCompany(TEN, NOW)).toMatchObject({ truckDays: 1, written: 4, failed: 0 });
    expect(await processGpsTimesForCompany(TEN, NOW)).toMatchObject({ truckDays: 0, written: 0 });
  });

  it('undo: a dry run only counts; then the AYUN events go, the visits are rebuilt, and the next run writes nothing', async () => {
    await processGpsTimes(TEN, 't5', DATE, NOW);
    expect(await suppressGpsTimes(TEN, 't5', DATE, 'UNDO')).toEqual({ events: 4, visits: 2, dryRun: true });
    expect(events()).toHaveLength(4);
    expect(await suppressGpsTimes(TEN, 't5', DATE, 'UNDO', { dryRun: false, now: NOW })).toEqual({ events: 4, visits: 2, dryRun: false });
    expect(events()).toEqual([]);
    expect(visitOf(1)).toMatchObject({ arrivedAt: null, arrivalSource: null, departedAt: null });
    expect(tables.ivmsTruckDay![0]).toMatchObject({ suppressedAt: NOW, suppressReason: 'UNDO' });
    expect(await processGpsTimes(TEN, 't5', DATE, NOW)).toMatchObject({ skipped: 'SUPPRESSED', written: 0 });
    expect(events()).toEqual([]);
  });
});

describe('a GPS return to the depot never completes a load (H1)', () => {
  it('the returned-loads sweep ignores a Back at depot of source AYUN; only the driver or the office close a trip', async () => {
    tables.driver = [{ id: 'drv', tenantId: TEN, code: 'D', name: 'Driver A', phone: null, casual: false, active: true }];
    tables.planLoad![0]!.driverId = 'drv';
    const back = (source: string, id: string) => ({ id, tenantId: TEN, depotId: 'D1', deliveryDate: day, truckId: 't5', loadNo: 1, sequence: null, visitId: null, kind: 'BACK_AT_DEPOT', source, at: new Date(Date.now() - 600_000), receivedAt: new Date(Date.now() - 600_000), idempotencyKey: `k:${id}` });
    tables.runPlan![0]!.runDate = new Date(`${new Date().toISOString().slice(0, 10)}T00:00:00.000Z`);
    tables.stopEvent!.push({ ...back('AYUN', 'gps'), deliveryDate: tables.runPlan![0]!.runDate });
    expect(await completeReturnedLoads()).toEqual({ completed: 0 });
    expect(completeLoad).not.toHaveBeenCalled();
    tables.stopEvent!.push({ ...back('PHONE_MANUAL', 'tap'), deliveryDate: tables.runPlan![0]!.runDate });
    expect(await completeReturnedLoads()).toEqual({ completed: 1 });
    expect(completeLoad).toHaveBeenCalledTimes(1);
  });
});

describe('small rules', () => {
  it('an event time is clamped to the day minus 2 h and to now + 1 min', () => {
    const dayStart = T('00:00');
    expect(clampEventAt(T('07:00'), dayStart, NOW)).toEqual(T('07:00'));
    expect(clampEventAt(new Date(dayStart.getTime() - 5 * 3600_000), dayStart, NOW)).toEqual(new Date(dayStart.getTime() - 2 * 3600_000));
    expect(clampEventAt(T('18:00'), dayStart, NOW)).toEqual(new Date(NOW.getTime() + 60_000));
  });
  it('fakePrisma is the client under test', () => {
    expect(typeof fakePrisma.truckTrailPoint.findMany).toBe('function');
  });
});
