/**
 * GET /api/ivms/trucks/[id]/day (owner request 18 Oct 2026: a truck's day) on the in-memory database: the
 * dispatcher and up only (VIEWER 403, no session 401), another company's truck (or none) 404 with nothing
 * of it read, a date that is not YYYY-MM-DD 400; the loads of the plan version in use; the other
 * company's GPS rows never in the answer even for the same truck id; never an IMEI or an Ayun zone name;
 * the trail and the depot moves in TIMES only; the live position from MAP on, only while a load is out
 * (review of 18 Oct 2026); the Leaving tap rule R2 counts, with the phone's own photos read company by
 * company. Also the plan screen's truck link. Invented data only (a depot in empty desert, truck "T-100",
 * the vendor's dummy IMEI).
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetDb, tables } from './fake-plan-db';
import { at } from './ivms-trail';
import { addDaysIso, todayIso, zonedDayStart } from '@/lib/dispatch/time';
import type { TruckDayModel } from '@/lib/ivms/truck-day';

vi.mock('@/lib/db', async () => ({ prisma: (await import('./fake-plan-db')).fakePrisma }));
vi.mock('@/lib/tenant', async () => {
  const m = await import('./fake-plan-db');
  return { tenantDb: () => m.fakePrisma };
});
const { session } = vi.hoisted(() => ({ session: { value: null as null | { user: { id: string; name: string; role: string; tenantId: string; email: string } } } }));
vi.mock('@/lib/auth', () => ({ auth: vi.fn(async () => session.value) }));

const { GET } = await import('@/app/api/ivms/trucks/[id]/day/route');

const TEN = 'tA';
const OTHER = 'tB';
const TZ = 'Asia/Muscat';
const TODAY = todayIso(TZ);
const dateOnlyOf = (iso: string) => new Date(`${iso}T00:00:00.000Z`);
const dayStart = zonedDayStart(TODAY, TZ);
const local = (min: number) => new Date(dayStart.getTime() + min * 60_000);

const snapshot = (code: string, name: string, east: number) => ({
  v: 1,
  customerId: `C-${code}`,
  code,
  branchCode: null,
  name,
  customerType: null,
  ...at(east),
  address: null,
  accessNotes: null,
  serviceMin: 15,
  priority: 3,
  hardStartMin: 0,
  hardEndMin: 1439,
  prefStartMin: null,
  prefEndMin: null,
  source: 'PLAN',
  capturedAt: new Date().toISOString(),
});

function seed(mode = 'TIMES') {
  resetDb();
  session.value = { user: { id: 'u1', name: 'Planner', role: 'PLANNER', tenantId: TEN, email: 'planner@example.test' } };
  tables.tenantConfig = [
    { id: 'cfg', tenantId: TEN, timezone: TZ, ivmsMode: mode, avgSpeedKmh: 40, distanceMultiplier: 1.3, ivmsStopRadiusM: 100, ivmsTrailDays: 2 },
    { id: 'cfgB', tenantId: OTHER, timezone: TZ, ivmsMode: 'TIMES' },
  ];
  tables.depot = [
    { id: 'D1', tenantId: TEN, code: 'D1', name: 'Example depot', ivmsZoneName: 'Example zone name', ...at(0) },
    { id: 'DB', tenantId: OTHER, code: 'DB', name: 'Other depot', ...at(0) },
  ];
  tables.truck = [
    { id: 't1', tenantId: TEN, depotId: 'D1', code: 'T-100', description: 'Example 10-ton truck', hired: false, onlyOnDate: null, ivmsImei: '111111111111111' },
    { id: 'tX', tenantId: OTHER, depotId: 'DB', code: 'T-900', description: null, hired: false, onlyOnDate: null, ivmsImei: '222222222222222' },
  ];
  tables.driver = [{ id: 'dr1', tenantId: TEN, name: 'Driver Example', casual: false }];
  // Version 1 was replaced by version 2 (the plan in use): only version 2's load is the truck's day.
  tables.runPlan = [
    { id: 'R1', tenantId: TEN, depotId: 'D1', runDate: dateOnlyOf(TODAY), status: 'SUPERSEDED', version: 1, supersededAt: new Date() },
    { id: 'R2', tenantId: TEN, depotId: 'D1', runDate: dateOnlyOf(TODAY), status: 'DISPATCHED', version: 2, supersededAt: null },
    { id: 'R0', tenantId: TEN, depotId: 'D1', runDate: dateOnlyOf(addDaysIso(TODAY, -3)), status: 'DISPATCHED', version: 1, supersededAt: null },
    { id: 'RB', tenantId: OTHER, depotId: 'DB', runDate: dateOnlyOf(TODAY), status: 'DISPATCHED', version: 1, supersededAt: null },
  ];
  tables.planLoad = [
    { id: 'L-old', tenantId: TEN, runId: 'R1', truckId: 't1', loadNo: 1, status: 'PLANNED', departMin: 300, returnMin: 400, driverId: null, breakJson: null, truckSnapshotJson: null },
    { id: 'L1', tenantId: TEN, runId: 'R2', truckId: 't1', loadNo: 1, status: 'DISPATCHED', departMin: 420, returnMin: 720, driverId: 'dr1', statusChangedAt: local(415), breakJson: null, truckSnapshotJson: null },
    { id: 'L0', tenantId: TEN, runId: 'R0', truckId: 't1', loadNo: 1, status: 'COMPLETED', departMin: 420, returnMin: 720, driverId: 'dr1', breakJson: null, truckSnapshotJson: null },
    { id: 'LB', tenantId: OTHER, runId: 'RB', truckId: 'tX', loadNo: 1, status: 'DISPATCHED', departMin: 420, returnMin: 720, driverId: null, breakJson: null, truckSnapshotJson: null },
  ];
  tables.order = [
    { id: 'O1', tenantId: TEN, customerId: 'C-A', carriedToOrderId: null, lines: [{ id: 'LA', cases: 10, weightKg: 100, product: { code: 'W' } }] },
    { id: 'O2', tenantId: TEN, customerId: 'C-B', carriedToOrderId: null, lines: [{ id: 'LB2', cases: 12, weightKg: 120, product: { code: 'W' } }] },
  ];
  tables.routeAssignment = [
    { id: 'A1', runId: 'R2', loadId: 'L1', truckId: 't1', orderId: 'O1', loadNo: 1, sequenceInTruck: 1, orderInStop: 0, etaMin: 450, serviceStartMin: 450, departureMin: 465, portionLinesJson: null, stopSnapshotJson: snapshot('A', 'Shop Example A', 3000) },
    { id: 'A2', runId: 'R2', loadId: 'L1', truckId: 't1', orderId: 'O2', loadNo: 1, sequenceInTruck: 2, orderInStop: 0, etaMin: 480, serviceStartMin: 480, departureMin: 495, portionLinesJson: null, stopSnapshotJson: snapshot('B', 'Shop Example B', 6000) },
  ];
  tables.stopVisit = [
    {
      id: 'V1', tenantId: TEN, depotId: 'D1', deliveryDate: dateOnlyOf(TODAY), truckId: 't1', loadNo: 1, sequence: 1,
      arrivedAt: local(452), arrivalSource: 'PHONE_MANUAL', arrivalDistanceM: 20, arrivalAccuracyM: 8, arrivalObserved: true,
      departedAt: local(470), departureSource: 'AYUN', departedAtOutcome: false, outcome: 'DELIVERED', outcomeAt: local(468), outcomeSource: 'PHONE_MANUAL',
      reason: null, reasonNote: null, casesPlanned: 10, casesDelivered: 10, photoCount: 1, outcomeLate: false,
    },
  ];
  tables.stopEvent = [
    { id: 'E1', tenantId: TEN, depotId: 'D1', deliveryDate: dateOnlyOf(TODAY), truckId: 't1', loadNo: 1, sequence: 1, kind: 'DEPARTED', source: 'AYUN', at: local(470), receivedAt: local(480), payloadJson: { observed: true } },
  ];
  tables.auditLog = [{ id: 'AU1', tenantId: TEN, action: 'LOAD_DISPATCHED', entity: 'PlanLoad', entityId: 'L1', createdAt: local(415) }];
  tables.ivmsEvent = [
    { id: 'M1', tenantId: TEN, truckId: 't1', depotId: 'D1', kind: 'DEPOT_OUT', origin: 'TRAIL', eventAt: local(418), outcome: 'USED', zoneName: 'Example zone name', lat: 1, lng: 1 },
    // Another company's row with this truck's id: never read (every query names the company).
    { id: 'MB', tenantId: OTHER, truckId: 't1', depotId: 'DB', kind: 'DEPOT_IN', origin: 'WEBHOOK', eventAt: local(430), outcome: 'USED' },
  ];
  tables.truckTrailPoint = [
    { id: 'P1', tenantId: TEN, truckId: 't1', fixAt: local(420), ...at(100), speedKmh: 30 },
    { id: 'P2', tenantId: TEN, truckId: 't1', fixAt: local(440), ...at(2900), speedKmh: 0 },
    { id: 'PB', tenantId: OTHER, truckId: 't1', fixAt: local(441), ...at(9999), speedKmh: 0 },
  ];
  tables.ivmsTruckDay = [{ id: 'TD1', tenantId: TEN, truckId: 't1', deliveryDate: dateOnlyOf(TODAY), suppressedAt: null, suppressReason: null, gpsFactsJson: [], trailFrom: null }];
  tables.truckPosition = [{ id: 'POS', tenantId: TEN, truckId: 't1', fixAt: new Date(Date.now() - 60_000), receivedAt: new Date(), ...at(4500), speedKmh: 35, heading: 90, flags: [], movedAt: new Date(Date.now() - 60_000) }];
  tables.opsAlert = [
    {
      id: 'AL1', tenantId: TEN, depotId: 'D1', deliveryDate: dateOnlyOf(TODAY), rule: 'ETA_LATE', subjectKey: 'k', truckId: 't1', truckCode: 'T-100', loadNo: 1, sequence: 2, customerId: null,
      kind: 'CONDITION', severity: 'WARN', tier: 1, value: 35, threshold: 30, text: 'T-100 L1 stop 2, Shop Example B: expected 35 min late', mayToast: true, mayEmail: true,
      occurredAt: local(470), firstSeenAt: local(470), lastSeenAt: local(470), resolvedAt: null, resolvedReason: null, occurrences: 1, ackedAt: null, ackedById: null,
    },
    { id: 'ALB', tenantId: OTHER, depotId: 'DB', deliveryDate: dateOnlyOf(TODAY), rule: 'ETA_LATE', truckId: 't1', truckCode: 'T-900', kind: 'CONDITION', severity: 'HIGH', tier: 2, value: 90, threshold: 30, text: 'other company', occurredAt: local(470), firstSeenAt: local(470), lastSeenAt: local(470), occurrences: 1 },
  ];
}

const call = async (id = 't1', date: string | null = TODAY) => {
  const q = date === null ? '' : `?date=${encodeURIComponent(date)}`;
  const res = await GET(new Request(`https://routeiq.test/api/ivms/trucks/${id}/day${q}`), { params: { id } });
  const text = await res.text();
  return { status: res.status, text, body: JSON.parse(text) as { data: TruckDayModel | null; error?: unknown } };
};

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

describe('who may open a truck day', () => {
  it('PLANNER, SUPERVISOR and the company admin; VIEWER is refused; no session is 401', async () => {
    for (const role of ['PLANNER', 'SUPERVISOR', 'TENANT_ADMIN']) {
      session.value!.user.role = role;
      expect((await call()).status).toBe(200);
    }
    session.value!.user.role = 'VIEWER';
    expect((await call()).status).toBe(403);
    session.value = null;
    expect((await call()).status).toBe(401);
  });

  it("another company's truck, or no such truck, is 404 and nothing of it is answered", async () => {
    const r = await call('tX');
    expect(r.status).toBe(404);
    expect(r.text).not.toMatch(/T-900|other company|Other depot/);
    expect((await call('no-such-truck')).status).toBe(404);
  });

  it('a date that is not a calendar date YYYY-MM-DD is 400; no date is the company today', async () => {
    for (const bad of ['2026-02-30', 'today', '2026-10-1']) expect((await call('t1', bad)).status).toBe(400);
    const r = await call('t1', null);
    expect(r.status).toBe(200);
    expect(r.body.data!.date).toBe(TODAY);
  });
});

describe('what the answer holds', () => {
  it('the loads of the plan version in use (never the replaced version), its stops, the driver, the dates with a load', async () => {
    const m = (await call()).body.data!;
    expect(m.truck).toMatchObject({ id: 't1', code: 'T-100', description: 'Example 10-ton truck' });
    expect(m.loads.map((l) => `${l.id} ${l.status}`)).toEqual(['L1 DISPATCHED']);
    expect(m.drivers).toEqual(['Driver Example']);
    expect(m.stops.map((s) => `${s.sequence} ${s.customerName} ${s.result}`)).toEqual(['1 Shop Example A DELIVERED', '2 Shop Example B PENDING']);
    expect(m.dates).toEqual([TODAY, addDaysIso(TODAY, -3)]);
    expect(m.timeline[0]).toMatchObject({ kind: 'DISPATCHED', at: local(415).toISOString(), source: 'dispatcher (Dispatch)' });
    expect(m.depots).toEqual([{ id: 'D1', code: 'D1', name: 'Example depot', ...at(0) }]);
  });

  it('TIMES: the trail, the GPS depot move and the GPS departure; the other company rows with the same truck id never', async () => {
    const r = await call();
    const m = r.body.data!;
    expect(m.mode).toBe('TIMES');
    expect(m.trail.total).toBe(2);
    expect(m.timeline.filter((t) => t.source === 'GPS trail').map((t) => t.title)).toEqual(['Left the depot']);
    expect(m.timeline.some((t) => t.source === 'Ayun webhook')).toBe(false);
    expect(m.stops[0]).toMatchObject({ departureBy: 'GPS (Ayun)', arrivalBy: 'driver' });
    expect(m.timeline.filter((t) => t.kind === 'ALERT').map((t) => t.lines[0])).toEqual(['T-100 L1 stop 2, Shop Example B: expected 35 min late']);
    expect(r.text).not.toMatch(/other company|T-900/);
    expect(m.live).toMatchObject({ moving: true, speedKmh: 35, loadNo: 1 });
  });

  it('never an IMEI, an Ayun zone name or a depot move position', async () => {
    const r = await call();
    expect(r.text).not.toMatch(/111111111111111|222222222222222|imei|Example zone name|zoneName/i);
  });

  it('MAP: the live position, but no trail and no GPS time; OFF and the kill switch: neither', async () => {
    seed('MAP');
    let m = (await call()).body.data!;
    expect(m).toMatchObject({ mode: 'MAP', trail: { total: 0 } });
    expect(m.live).not.toBeNull();
    expect(m.stops[0]!.departureBy).toBe('driver'); // the result stands in for the GPS departure
    expect(m.timeline.some((t) => t.source === 'GPS trail')).toBe(false);
    seed('OFF');
    m = (await call()).body.data!;
    expect(m).toMatchObject({ mode: 'OFF', live: null, trail: { total: 0 } });
    expect(m.gps.notes[0]).toMatch(/GPS tracking is off/);
    seed('TIMES');
    process.env.ROUTEIQ_DISABLE_IVMS = '1';
    m = (await call()).body.data!;
    expect(m).toMatchObject({ mode: 'OFF', live: null, trail: { total: 0 } });
  });

  it('a past day: the plan and the results; no live position', async () => {
    const m = (await call('t1', addDaysIso(TODAY, -3))).body.data!;
    expect(m.loads.map((l) => l.id)).toEqual(['L0']);
    expect(m.live).toBeNull();
  });

  // Review of 18 Oct 2026: a position row the poller has not cleared yet (its last load Completed while the
  // poller is in a backoff) is never shown for a truck with no load out, as on the live map (review M7).
  it('today with every load Completed: no live position even with a position row stored', async () => {
    tables.planLoad.find((l) => l.id === 'L1')!.status = 'COMPLETED';
    const m = (await call()).body.data!;
    expect(m.loads.map((l) => l.status)).toEqual(['COMPLETED']);
    expect(m.live).toBeNull();
    expect(m.gps.live).toBe(false);
    expect(m.gps.notes.join(' ')).toMatch(/No live position now/);
  });

  // Review of 18 Oct 2026: the Leaving tap shown is the one rule R2 counts, the latest before the first sign
  // at a stop; the phone's own photo is a sign, an old gallery photo, an office upload or another
  // company's row is not.
  it("the Leaving tap shown is rule R2's: the phone's own photo is a first sign; an old, office or other company photo is not", async () => {
    tables.stopEvent.push(
      ...[425, 435, 445].map((min, k) => ({ id: `EL${k}`, tenantId: TEN, depotId: 'D1', deliveryDate: dateOnlyOf(TODAY), truckId: 't1', loadNo: 1, sequence: null, kind: 'DEPOT_DEPART', source: 'PHONE_MANUAL', at: local(min), receivedAt: local(min), payloadJson: null })),
    );
    tables.deliveryPhoto = [
      { id: 'PH1', tenantId: TEN, visitId: 'V1', source: 'PHONE_AUTO', takenAt: local(440), oldPhoto: false },
      { id: 'PH2', tenantId: TEN, visitId: 'V1', source: 'PHONE_MANUAL', takenAt: local(430), oldPhoto: true },
      { id: 'PH3', tenantId: TEN, visitId: 'V1', source: 'DISPATCHER', takenAt: local(432), oldPhoto: false },
      { id: 'PHB', tenantId: OTHER, visitId: 'V1', source: 'PHONE_AUTO', takenAt: local(426), oldPhoto: false },
    ];
    const m = (await call()).body.data!;
    const left = m.timeline.filter((t) => t.kind === 'DEPOT_OUT' && t.source === 'driver');
    // Photo 07:20 is the first sign (arrival 07:32): the 07:15 tap counts, 07:05 was corrected, 07:25 came after.
    expect(left.map((t) => t.at)).toEqual([local(435).toISOString()]);
    expect(left[0]!.lines).toEqual([
      '"Leaving for next load" (L1)',
      'Also tapped at 07:05: corrected by tapping again (the latest tap before the first stop counts)',
      'Tapped again at 07:25, after the truck had reached a stop: not counted',
    ]);
  });
});

describe('the plan screen links the truck code to its day (owner request 18 Oct 2026)', () => {
  it('the "Truck · load" cell is a link to the truck day of the plan date, for the dispatcher and up', () => {
    const src = readFileSync(path.resolve(__dirname, '../../app/t/[slug]/dispatch/plan-view.tsx'), 'utf8');
    expect(src).toContain('href={truckDayHref(slug, l.truckId, d.run.runDate)}');
    expect(src).toMatch(/\{canPlan \? \(\s*<Link\s+href=\{truckDayHref/);
    // A click on the link never opens or closes the load row under it.
    expect(src).toMatch(/title=\{TRUCK_DAY_LINK_TITLE\}\s+onClick=\{\(e\) => e\.stopPropagation\(\)\}/);
  });

  it('the page is PLANNER and up and 404s on another company truck; "Open Ayun" is a plain link in a new tab', () => {
    const page = readFileSync(path.resolve(__dirname, '../../app/t/[slug]/dispatch/truck/[truckId]/page.tsx'), 'utf8');
    expect(page).toMatch(/const truck = await db\.truck\.findFirst\(\{ where: \{ id: params\.truckId \}/);
    expect(page).toContain('if (!truck) notFound();');
    expect(page).toContain('!canPlan(user.role)');
    const client = readFileSync(path.resolve(__dirname, '../../app/t/[slug]/dispatch/truck/[truckId]/truck-day-client.tsx'), 'utf8');
    expect(client).toMatch(/<a href=\{model\.ayunUrl\} target="_blank" rel="noopener noreferrer"/);
  });
});
