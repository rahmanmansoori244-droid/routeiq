/**
 * The office side of delivery results through their route handlers (owner request 4 Oct 2026, Part 3,
 * spec sections 5 #9 to #14 and 10), on the in-memory database (fake-plan-db.ts):
 * - POST /api/dispatch/outcomes: a result recorded as the office (source DISPATCHER, the user's id,
 *   audited with before and after), optional Arrived / Left times, idempotent `disp:` keys, refusals;
 * - GET /api/runs/<id>/outcomes: progress per load, the stop's result, times and notes, the no-result
 *   list of a load that is back, the copy conflict chip and the Lock question;
 * - GET /api/delivery-photos/<id>: the company's photos only, purged photos say so;
 * - GET /api/customers/delivery-stats and /pin-check: roles and answers.
 * Synthetic data only: customers ACME and BETA, truck T05, driver Salim.
 */
import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resetDb, row, tables } from './fake-plan-db';

vi.mock('@/lib/db', async () => ({ prisma: (await import('./fake-plan-db')).fakePrisma }));
vi.mock('@/lib/tenant', async () => {
  const m = await import('./fake-plan-db');
  return { tenantDb: () => m.fakePrisma };
});
vi.mock('@/lib/audit', async () => {
  const m = await import('./fake-plan-db');
  return { audit: vi.fn(async (input: Record<string, unknown>) => m.fakePrisma.auditLog.create({ data: { ...input } })) };
});
const session = vi.hoisted(() => ({ role: 'PLANNER', id: 'u1' }));
vi.mock('@/lib/auth', () => ({ auth: vi.fn(async () => ({ user: { id: session.id, tenantId: 'tA', role: session.role, name: 'Dispatcher Ali', email: 'ali@a.example' } })) }));

import { POST as outcomeRoute } from '@/app/api/dispatch/outcomes/route';
import { GET as overlayRoute } from '@/app/api/runs/[id]/outcomes/route';
import { GET as photoRoute } from '@/app/api/delivery-photos/[id]/route';
import { GET as statsRoute } from '@/app/api/customers/delivery-stats/route';
import { GET as pinRoute } from '@/app/api/customers/pin-check/route';
import { todayIso, zonedDayStart } from '@/lib/dispatch/time';

const T = 'tA';
const TZ = 'Asia/Muscat';
// Yesterday: every load of the day is "back" for the no-result list.
const D = (() => {
  const t = todayIso(TZ);
  const d = new Date(`${t}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
})();
const day = (iso: string) => new Date(`${iso}T00:00:00Z`);
const PIN = { lat: 23.6, lng: 58.4 };

const snap = (code: string) => ({ v: 1, customerId: `c-${code}`, code, branchCode: null, name: code, lat: PIN.lat, lng: PIN.lng, hardStartMin: 480, hardEndMin: 720 });

function seed(loadStatus = 'DISPATCHED') {
  resetDb();
  session.role = 'PLANNER';
  session.id = 'u1';
  tables.tenantConfig = [{ id: 'cfg', tenantId: T, timezone: TZ, geofenceRadiusM: 100, outcomesSince: new Date('2026-01-01T00:00:00Z'), serviceMinPerCase: 0, defaultServiceTimeMin: 10, photoRetentionDays: 365 }];
  tables.depot = [{ id: 'DA', tenantId: T, code: 'A1', active: true }];
  tables.truck = [{ id: 'T5', tenantId: T, code: 'T05', hired: true }];
  tables.driver = [{ id: 'dr1', tenantId: T, name: 'Salim', casual: true, phone: null }];
  tables.user = [{ id: 'u1', name: 'Dispatcher Ali' }];
  tables.order = [
    { id: 'OA', tenantId: T, depotId: 'DA', customerId: 'c-ACME', deliveryDate: day(D), status: 'DISPATCHED', totalCases: 10, customer: { id: 'c-ACME', code: 'ACME', name: 'ACME', lat: PIN.lat, lng: PIN.lng }, lines: [{ id: 'OA-1', cases: 10, weightKg: 100, product: { code: 'W500' } }] },
    { id: 'OB', tenantId: T, depotId: 'DA', customerId: 'c-BETA', deliveryDate: day(D), status: 'DISPATCHED', totalCases: 20, customer: { id: 'c-BETA', code: 'BETA', name: 'BETA', lat: PIN.lat, lng: PIN.lng }, lines: [{ id: 'OB-1', cases: 20, weightKg: 200, product: { code: 'W500' } }] },
  ];
  tables.runPlan = [{ id: 'P1', tenantId: T, depotId: 'DA', runDate: day(D), status: 'DISPATCHED', version: 1, chosenScenarioId: 'sc1', supersededAt: null, createdAt: new Date() }];
  tables.planLoad = [{ id: 'L1', tenantId: T, runId: 'P1', truckId: 'T5', loadNo: 1, status: loadStatus, departMin: 420, returnMin: 840, driverId: 'dr1', breakJson: null, statusChangedAt: new Date() }];
  tables.routeAssignment = [
    { id: 'ra1', runId: 'P1', loadId: 'L1', orderId: 'OA', sequenceInTruck: 1, orderInStop: 0, etaMin: 500, serviceStartMin: 500, departureMin: 520, portionLinesJson: null, stopSnapshotJson: snap('ACME') },
    { id: 'ra2', runId: 'P1', loadId: 'L1', orderId: 'OB', sequenceInTruck: 2, orderInStop: 0, etaMin: 560, serviceStartMin: 560, departureMin: 590, portionLinesJson: null, stopSnapshotJson: snap('BETA') },
  ];
  tables.unservedOrder = [];
  tables.stopVisit = [];
  tables.stopEvent = [];
  tables.deliveryPhoto = [];
  tables.driverLink = [];
  tables.auditLog = [];
  tables.customer = [
    { id: 'c-ACME', tenantId: T, code: 'ACME', branchCode: null, name: 'ACME', lat: PIN.lat, lng: PIN.lng, priority: 3, priorityConfirmed: false, avgServiceTimeMin: 20, serviceTimeConfirmed: true, customerType: null, windowConfirmedAt: null, hardWindowStartMin: null, hardWindowEndMin: null, prefWindowStartMin: null, prefWindowEndMin: null },
  ];
  tables.customerTypeProfile = [];
}

const post = (body: unknown) => outcomeRoute(new Request('http://x/api/dispatch/outcomes', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }));
const record = (over: Record<string, unknown> = {}) => ({ key: randomUUID(), depotId: 'DA', date: D, truckId: 'T5', loadNo: 1, sequence: 1, outcome: 'NOT_DELIVERED', reason: 'SHOP_CLOSED', ...over });
const overlay = async () => (await (await overlayRoute(new Request('http://x/api/runs/P1/outcomes'), { params: { id: 'P1' } })).json()).data;

describe('POST /api/dispatch/outcomes: the dispatcher records a result', () => {
  beforeEach(() => seed());

  it('a result as the office, with times; audited with before and after; the same key again is a duplicate', async () => {
    const body = record({ arrivedAt: '08:10', departedAt: '08:35', note: 'shutters down' });
    const r = await post(body);
    expect(r.status).toBe(200);
    expect((await r.json()).data).toMatchObject({ result: 'ok' });
    const v = tables.stopVisit[0]!;
    expect(v).toMatchObject({ outcome: 'NOT_DELIVERED', reason: 'SHOP_CLOSED', reasonNote: 'shutters down', casesDelivered: 0, outcomeSource: 'DISPATCHER', outcomeById: 'u1', arrivalSource: 'DISPATCHER', departureSource: 'DISPATCHER' });
    const start = zonedDayStart(D, TZ).getTime();
    expect([(v.arrivedAt as Date).getTime() - start, (v.departedAt as Date).getTime() - start]).toEqual([(8 * 60 + 10) * 60_000, (8 * 60 + 35) * 60_000]);
    expect(tables.stopEvent.map((e) => [e.kind, e.source, e.idempotencyKey.startsWith('disp:')])).toEqual([
      ['ARRIVED', 'DISPATCHER', true],
      ['DEPARTED', 'DISPATCHER', true],
      ['OUTCOME', 'DISPATCHER', true],
    ]);
    const a = tables.auditLog.find((x) => x.action === 'DELIVERY_OUTCOME_SET')!;
    expect(a).toMatchObject({ userId: 'u1', entity: 'StopVisit', beforeJson: { outcome: null } });
    expect(a.afterJson).toMatchObject({ source: 'DISPATCHER', outcome: 'NOT_DELIVERED', correction: false });
    // A double click (the same key): recorded once.
    expect((await (await post(body)).json()).data).toMatchObject({ result: 'duplicate' });
    expect(tables.stopEvent).toHaveLength(3);
    // The same key from another user: refused, nothing echoed.
    session.id = 'u2';
    expect((await post(body)).status).toBe(409);
  });

  it('a correction later wins over the driver; "Clear result" clears it; the office is not held to "photo required"', async () => {
    expect((await post(record({ sequence: 2, outcome: 'DELIVERED' }))).status).toBe(200);
    expect((await post(record({ sequence: 2, outcome: 'PARTLY_DELIVERED', reason: 'DAMAGED_GOODS', lines: [{ lineId: 'OB-1', delivered: 12 }] }))).status).toBe(200);
    const v = tables.stopVisit.find((x) => x.sequence === 2)!;
    expect(v).toMatchObject({ outcome: 'PARTLY_DELIVERED', casesDelivered: 12 });
    expect(tables.auditLog.filter((x) => x.action === 'DELIVERY_OUTCOME_SET').at(-1)!.afterJson).toMatchObject({ correction: true });
    expect((await post(record({ sequence: 2, outcome: null, reason: null }))).status).toBe(200);
    expect(row('stopVisit', v.id)).toMatchObject({ outcome: null, casesDelivered: null });
  });

  it('refusals: a load that has not left, an unknown stop, a bad body, Other without a note, Left before Arrived, a viewer', async () => {
    seed('LOCKED');
    let r = await post(record());
    expect([r.status, (await r.json()).error.code]).toEqual([409, 'LOAD_NOT_DISPATCHED']);
    seed();
    r = await post(record({ sequence: 9 }));
    expect([r.status, (await r.json()).error.code]).toEqual([404, 'STOP_NOT_FOUND']);
    expect((await post(record({ key: 'not-a-uuid' }))).status).toBe(400);
    r = await post(record({ reason: 'OTHER' }));
    expect([r.status, (await r.json()).error.code]).toEqual([422, 'INVALID']);
    r = await post(record({ arrivedAt: '09:00', departedAt: '08:00' }));
    expect(r.status).toBe(422);
    session.role = 'VIEWER';
    expect((await post(record())).status).toBe(403);
    expect(tables.stopVisit).toEqual([]);
  });
});

describe('GET /api/runs/<id>/outcomes: the results on the plan', () => {
  beforeEach(() => seed());

  it('progress, the result with its notes, unloading planned / actual, the no-result list of a load that is back', async () => {
    await post(record({ arrivedAt: '08:10', departedAt: '08:35' }));
    const o = await overlay();
    expect(o.loads.L1).toMatchObject({ done: 1, total: 2, notDelivered: 1, noResult: 1, delivered: 0 });
    expect(o.stops['L1:1']).toMatchObject({
      outcome: 'NOT_DELIVERED',
      reasonText: 'Shop closed',
      source: 'dispatcher',
      by: 'Dispatcher Ali',
      arrivalNote: 'set by office',
      plannedMin: 20,
      actualMin: 25,
      actualLabel: 'arrival to departure',
      autoTimed: false,
      casesPlanned: 10,
    });
    expect(o.stops['L1:2']).toMatchObject({ outcome: null, state: 'PENDING', casesPlanned: 20, lines: [{ lineId: 'OB-1', plannedCases: 20 }] });
    // Yesterday's dispatched load counts as back: stop 2 has no result.
    expect(o.noOutcome.map((s: { truckCode: string; sequence: number; customerCode: string }) => [s.truckCode, s.sequence, s.customerCode])).toEqual([['T05', 2, 'BETA']]);
    expect(o.summary).toMatchObject({ stops: 2, withResult: 1, notDelivered: 1, noResult: 1 });
  });

  it('another company: 404; a copy whose original result changed after the carry warns on the stop and at Lock', async () => {
    tables.order.push({ id: 'C9', tenantId: T, depotId: 'DA', deliveryDate: day(D), carriedFromOrderId: 'OB', customer: { code: 'BETA', branchCode: null } });
    tables.order.find((o) => o.id === 'OB')!.deliveryDate = new Date(`2026-01-02T00:00:00Z`);
    tables.routeAssignment.push({ id: 'ra9', runId: 'P1', loadId: 'L1', orderId: 'C9', sequenceInTruck: 2, orderInStop: 1 });
    tables.stopEvent.push({ id: 'cc', tenantId: T, kind: 'CARRY_CONFLICT', deliveryDate: new Date('2026-01-02T00:00:00Z'), at: new Date(), payloadJson: { copyId: 'C9', refused: { outcome: 'DELIVERED' } } });
    const o = await overlay();
    expect(o.copyConflicts['L1:2']).toBe('May not be needed: the 2 Jan result was changed after it was brought forward (to Delivered)');
    expect(o.lockWarnings.L1).toEqual(["BETA's brought-forward order may not be needed (the 2 Jan result changed to Delivered)."]);
    tables.runPlan[0]!.tenantId = 'tB';
    expect((await overlayRoute(new Request('http://x'), { params: { id: 'P1' } })).status).toBe(404);
  });
});

describe('GET /api/delivery-photos/<id>', () => {
  beforeEach(() => {
    seed();
    tables.stopVisit = [{ id: 'V1', tenantId: T, truckId: 'T5', loadNo: 1, sequence: 1, deliveryDate: day(D) }];
    tables.deliveryPhoto = [
      { id: 'ph1', tenantId: T, visitId: 'V1', bytes: Buffer.from([0xff, 0xd8, 0xff, 0xd9]), purgedAt: null, takenAt: new Date(), receivedAt: new Date() },
      { id: 'ph2', tenantId: T, visitId: 'V1', bytes: null, purgedAt: new Date(), takenAt: new Date(Date.now() + 1000), receivedAt: new Date() },
      { id: 'phX', tenantId: 'tB', visitId: 'VX', bytes: Buffer.from([0xff, 0xd8]), purgedAt: null, takenAt: new Date(), receivedAt: new Date() },
    ];
  });
  const get = (id: string) => photoRoute(new Request(`http://x/api/delivery-photos/${id}`), { params: { id } });

  it('serves the company photo as a private JPEG with nosniff and a sandbox CSP; another company 404; purged 404 PHOTO_PURGED', async () => {
    const r = await get('ph1');
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toBe('image/jpeg');
    expect(r.headers.get('x-content-type-options')).toBe('nosniff');
    expect(r.headers.get('content-security-policy')).toBe("default-src 'none'; sandbox");
    expect(r.headers.get('cache-control')).toBe('private, max-age=86400');
    expect(r.headers.get('content-disposition')).toBe('inline; filename="T05-L1-stop1-1.jpg"');
    expect((await get('phX')).status).toBe(404);
    const gone = await get('ph2');
    expect([gone.status, (await gone.json()).error.code]).toEqual([404, 'PHOTO_PURGED']);
    // Every signed-in role may look (like the plan).
    session.role = 'VIEWER';
    expect((await get('ph1')).status).toBe(200);
  });
});

describe('customer feed routes', () => {
  beforeEach(() => seed());

  it('delivery-stats: the measured time next to the planned one; at most 200 ids', async () => {
    tables.stopVisit = [8, 9, 10].map((n, i) => ({
      id: `m${i}`, tenantId: T, customerId: 'c-ACME', deliveryDate: day(D), outcome: 'DELIVERED', autoServiceMinutes: 30 + i * 2, timingSuspect: false, outcomeLate: false, plannedServiceMin: 20, casesDelivered: 10, autoArrivedAt: new Date(Date.UTC(2026, 0, n)),
    }));
    const r = await statsRoute(new Request('http://x/api/customers/delivery-stats?ids=c-ACME'));
    const data = (await r.json()).data;
    expect(data['c-ACME']).toMatchObject({ plannedMin: 20, plannedSource: 'CUSTOMER', measured: { minutes: 32, n: 3 } });
    expect(data['c-ACME'].text).toMatch(/^Unloading: 20 min planned · measured 32 min \(median of 3 timed visits/);
    const many = Array.from({ length: 201 }, (_, i) => `c${i}`).join(',');
    expect((await statsRoute(new Request(`http://x/api/customers/delivery-stats?ids=${many}`))).status).toBe(400);
  });

  it('pin-check: company admin only', async () => {
    expect((await pinRoute(new Request('http://x/api/customers/pin-check'))).status).toBe(403);
    session.role = 'TENANT_ADMIN';
    const r = await pinRoute(new Request('http://x/api/customers/pin-check'));
    expect(r.status).toBe(200);
    expect((await r.json()).data).toEqual([]);
  });
});
