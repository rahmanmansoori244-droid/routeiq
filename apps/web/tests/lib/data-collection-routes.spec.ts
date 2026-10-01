/**
 * Data collection rules (owner decisions of 1 Oct 2026), on the routes (fake database, the real route
 * code; pure rules in data-collection-rules.spec.ts):
 *
 *  - item 5, location admin-lock: a dispatcher (PLANNER) sets a location only while the customer has
 *    no usable one; changing a usable one is 403 LOCATION_ADMIN_ONLY ("Only an admin can change a
 *    saved location") on PUT /api/customers/:id/location, and a dispatcher's customer import keeps
 *    every usable saved location (an admin's import works as before, under A5's rules);
 *  - item 2, own confirmed window: hours a dispatcher enters in PATCH /api/customers/:id are confirmed
 *    by them (who, when); "open all day" is confirmed with no hours; cleared hours are not confirmed;
 *  - item 1, a delivery time for one order: PUT /api/dispatch/delivery-time sets / clears it with a
 *    reason, audited, never on an order on a locked load or one brought forward to a later day.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resetDb, row, tables } from './fake-plan-db';

const session = vi.hoisted(() => ({ role: 'PLANNER' as string }));
vi.mock('@/lib/auth', () => ({
  auth: async () => ({ user: { id: 'u1', tenantId: 'tA', role: session.role, name: 'Dispatcher', email: 'd@a.example' } }),
}));
vi.mock('@/lib/db', async () => ({ prisma: (await import('./fake-plan-db')).fakePrisma }));
vi.mock('@/lib/tenant', async () => {
  const m = await import('./fake-plan-db');
  return { tenantDb: () => m.fakePrisma };
});
const audits = vi.hoisted(() => [] as Record<string, any>[]);
vi.mock('@/lib/audit', () => ({ audit: vi.fn(async (a: Record<string, any>) => void audits.push(a)) }));
vi.mock('@/lib/dispatch/service-area', async () => {
  const { DEFAULT_SERVICE_AREA } = await import('@/lib/dispatch/location-input');
  return { tenantServiceArea: async () => DEFAULT_SERVICE_AREA };
});

import { PUT as locationPut } from '@/app/api/customers/[id]/location/route';
import { PATCH as customerPatch } from '@/app/api/customers/[id]/route';
import { POST as customerImport } from '@/app/api/customers/import/route';
import { PUT as deliveryTimePut } from '@/app/api/dispatch/delivery-time/route';
import { LOCATION_ADMIN_ONLY_MESSAGE } from '@/lib/dispatch/customer-attrs';

const T = 'tA';
const customer = (id: string, over: Record<string, unknown> = {}) => ({
  id, tenantId: T, code: id, branchCode: null, branchKey: '__MAIN__', name: `Customer ${id}`, active: true,
  lat: 23.5859, lng: 58.4059, geocodeConfidence: 'HIGH', locationSource: 'IMPORT', locationInput: null,
  locationVerified: false, locationVerifiedById: null, locationVerifiedAt: null,
  hardWindowStartMin: null, hardWindowEndMin: null, prefWindowStartMin: null, prefWindowEndMin: null,
  windowConfirmedAt: null, windowConfirmedById: null, priority: 3, priorityConfirmed: false, avgServiceTimeMin: 10, serviceTimeConfirmed: false,
  ...over,
});
const json = (url: string, method: string, body: unknown) =>
  new Request(`http://localhost${url}`, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const answer = async (res: Response) => ({ status: res.status, body: (await res.json()) as { data: any; error: any } });
const putLocation = async (id: string, body: unknown) => answer(await locationPut(json(`/api/customers/${id}/location`, 'PUT', body), { params: { id } }));
const patchCustomer = async (id: string, body: unknown) => answer(await customerPatch(json(`/api/customers/${id}`, 'PATCH', body), { params: { id } }));
const putTime = async (body: unknown) => answer(await deliveryTimePut(json('/api/dispatch/delivery-time', 'PUT', body)));
const point = (id: string) => ({ lat: row('customer', id).lat, lng: row('customer', id).lng, verified: row('customer', id).locationVerified });

beforeEach(() => {
  resetDb();
  audits.length = 0;
  session.role = 'PLANNER';
  tables.customer = [
    customer('USABLE'), // an imported exact point, never confirmed: usable (planned)
    customer('CONFIRMED', { locationVerified: true, locationSource: 'MAP_PIN', locationInput: 'map pin' }),
    customer('NONE', { lat: null, lng: null, geocodeConfidence: 'MISSING', locationSource: null }),
    customer('LOW', { geocodeConfidence: 'LOW', lat: 23, lng: 58 }), // not usable: blocks delivery
  ];
});

describe('item 5: only an admin changes a saved location (PUT /api/customers/:id/location)', () => {
  const pin = { lat: 23.61234, lng: 58.45678, source: 'MAP_PIN' };

  it('a dispatcher moving a usable location: 403 with the plain refusal, nothing saved or audited', async () => {
    for (const id of ['USABLE', 'CONFIRMED']) {
      const before = point(id);
      const r = await putLocation(id, pin);
      expect(r.status, id).toBe(403);
      expect(r.body.error).toMatchObject({ code: 'LOCATION_ADMIN_ONLY' });
      expect(r.body.error.message).toContain(LOCATION_ADMIN_ONLY_MESSAGE);
      expect(point(id)).toEqual(before);
    }
    // A reading (a pasted pair) that is exact is refused the same way.
    expect((await putLocation('USABLE', { input: '23.612345, 58.456789' })).status).toBe(403);
    expect(audits).toEqual([]);
  });

  it('a dispatcher sets a location when the customer has none, or only one that is not usable', async () => {
    expect((await putLocation('NONE', pin)).status).toBe(200);
    expect(point('NONE')).toEqual({ lat: 23.61234, lng: 58.45678, verified: true });
    expect((await putLocation('LOW', pin)).status).toBe(200);
    expect(point('LOW')).toEqual({ lat: 23.61234, lng: 58.45678, verified: true });
    expect(audits.map((a) => a.action)).toEqual(['CUSTOMER_LOCATION_SET', 'CUSTOMER_LOCATION_SET']);
  });

  it('a dispatcher may still confirm the saved location as it is (nothing changes but "confirmed")', async () => {
    const r = await putLocation('USABLE', { lat: 23.5859, lng: 58.4059, source: 'MAP_PIN' });
    expect(r.status).toBe(200);
    expect(point('USABLE')).toEqual({ lat: 23.5859, lng: 58.4059, verified: true });
  });

  it('the company admin changes a usable location (A5 checks still apply)', async () => {
    session.role = 'TENANT_ADMIN';
    expect((await putLocation('CONFIRMED', pin)).status).toBe(200);
    expect(point('CONFIRMED')).toMatchObject({ lat: 23.61234, lng: 58.45678 });
    expect((await putLocation('USABLE', { lat: 23.58, lng: 58.4, source: 'GOOGLE_MAPS_URL', input: '23.58, 58.40' })).status).toBe(422);
  });
});

describe("item 5: a dispatcher's customer import never changes a usable saved location", () => {
  const importCsv = async (csv: string, dryRun = false) => {
    const fd = new FormData();
    fd.set('file', new File([csv], 'customers.csv', { type: 'text/csv' }));
    if (dryRun) fd.set('dryRun', '1');
    return answer(await customerImport(new Request('http://localhost/api/customers/import', { method: 'POST', body: fd })));
  };
  const file = ['code,name,priority,lat,lng', 'USABLE,Customer USABLE,3,23.7001,58.5001', 'NONE,Customer NONE,3,23.7002,58.5002', 'LOW,Customer LOW,3,23.7003,58.5003', 'CONFIRMED,Customer CONFIRMED,3,23.7004,58.5004'].join('\n');

  it('as a dispatcher: usable locations kept (warned), missing and unusable ones set from the file', async () => {
    const dry = await importCsv(file, true);
    expect(dry.status).toBe(200);
    expect(dry.body.data.warnings.join(' ')).toMatch(/2 location\(s\) in the file differ from the customer's saved location, which will be kept: Only an admin can change a saved location\./);
    const r = await importCsv(file);
    expect(r.status).toBe(200);
    expect(point('USABLE')).toMatchObject({ lat: 23.5859, lng: 58.4059 });
    expect(point('CONFIRMED')).toMatchObject({ lat: 23.5859, lng: 58.4059, verified: true });
    expect(point('NONE')).toMatchObject({ lat: 23.7002, lng: 58.5002 });
    expect(point('LOW')).toMatchObject({ lat: 23.7003, lng: 58.5003 });
    expect(r.body.data.warnings.join(' ')).toMatch(/which was kept: Only an admin can change a saved location/);
  });

  it('a pair that is not exact and points elsewhere does not mark a usable location LOW for a dispatcher', async () => {
    const r = await importCsv(['code,name,priority,lat,lng', 'USABLE,Customer USABLE,3,23.71,58.51'].join('\n'));
    expect(r.status).toBe(200);
    expect(row('customer', 'USABLE')).toMatchObject({ lat: 23.5859, lng: 58.4059, geocodeConfidence: 'HIGH' });
    expect(r.body.data.locationsNotSaved).toEqual([expect.objectContaining({ code: 'USABLE', kept: 'SAVED_LOCATION', reason: expect.stringContaining(LOCATION_ADMIN_ONLY_MESSAGE) })]);
  });

  it("as the admin: A5's import rules as before (an unconfirmed usable location is replaced; a confirmed one kept)", async () => {
    session.role = 'TENANT_ADMIN';
    const r = await importCsv(file);
    expect(r.status).toBe(200);
    expect(point('USABLE')).toMatchObject({ lat: 23.7001, lng: 58.5001 });
    expect(point('CONFIRMED')).toMatchObject({ lat: 23.5859, lng: 58.4059, verified: true });
  });
});

describe('item 2: own confirmed window (PATCH /api/customers/:id)', () => {
  it('hours a dispatcher enters are confirmed by them; cleared hours are not confirmed', async () => {
    expect((await patchCustomer('USABLE', { hardWindowStartMin: 360, hardWindowEndMin: 600 })).status).toBe(200);
    expect(row('customer', 'USABLE')).toMatchObject({ hardWindowStartMin: 360, hardWindowEndMin: 600, windowConfirmedById: 'u1' });
    expect(row('customer', 'USABLE').windowConfirmedAt).toBeInstanceOf(Date);
    expect((await patchCustomer('USABLE', { hardWindowStartMin: null, hardWindowEndMin: null })).status).toBe(200);
    expect(row('customer', 'USABLE')).toMatchObject({ hardWindowStartMin: null, windowConfirmedAt: null, windowConfirmedById: null });
  });

  it('"open all day" is confirmed with no hours; a change that is not about hours leaves the confirmation as it is', async () => {
    const body = { hardWindowStartMin: null, hardWindowEndMin: null, prefWindowStartMin: null, prefWindowEndMin: null, windowConfirmed: true };
    expect((await patchCustomer('NONE', body)).status).toBe(200);
    expect(row('customer', 'NONE')).toMatchObject({ hardWindowStartMin: null, windowConfirmedById: 'u1' });
    const at = row('customer', 'NONE').windowConfirmedAt;
    expect(at).toBeInstanceOf(Date);
    expect((await patchCustomer('NONE', { priority: 2 })).status).toBe(200);
    expect(row('customer', 'NONE').windowConfirmedAt).toBe(at);
  });
});

describe('item 1: a delivery time for one order (PUT /api/dispatch/delivery-time)', () => {
  const DAY = new Date('2026-10-02T00:00:00.000Z');
  beforeEach(() => {
    tables.order = [
      { id: 'O1', tenantId: T, customerId: 'USABLE', depotId: 'D1', deliveryDate: DAY, carriedToOrderId: null, carriedTo: null, deliveryStartMin: null, deliveryEndMin: null, deliveryTimeReason: null, deliveryTimeNote: null, customer: { code: 'USABLE', branchCode: null, name: 'Customer USABLE' } },
      { id: 'O2', tenantId: T, customerId: 'USABLE', depotId: 'D1', deliveryDate: DAY, carriedToOrderId: 'O9', carriedTo: { deliveryDate: new Date('2026-10-03T00:00:00.000Z') }, deliveryStartMin: null, deliveryEndMin: null, deliveryTimeReason: null, deliveryTimeNote: null, customer: { code: 'USABLE', branchCode: null, name: 'Customer USABLE' } },
    ];
  });

  it('sets a promised time with its reason (audited, the customer master unchanged), then clears it', async () => {
    const r = await putTime({ orderId: 'O1', startMin: 600, endMin: 660, reason: 'PROMISED', note: 'sales promised' });
    expect(r.status).toBe(200);
    expect(r.body.data.text).toBe('Promised 10:00–11:00');
    expect(row('order', 'O1')).toMatchObject({ deliveryStartMin: 600, deliveryEndMin: 660, deliveryTimeReason: 'PROMISED', deliveryTimeNote: 'sales promised', deliveryTimeSetById: 'u1' });
    expect(row('customer', 'USABLE')).toMatchObject({ hardWindowStartMin: null, windowConfirmedAt: null });
    expect(audits.at(-1)).toMatchObject({ action: 'ORDER_DELIVERY_TIME_SET', entity: 'Order', entityId: 'O1', afterJson: { deliveryTime: { startMin: 600, endMin: 660, reason: 'PROMISED' } } });
    expect((await putTime({ orderId: 'O1', clear: true })).status).toBe(200);
    expect(row('order', 'O1')).toMatchObject({ deliveryStartMin: null, deliveryEndMin: null, deliveryTimeReason: null });
    expect(audits.at(-1)).toMatchObject({ action: 'ORDER_DELIVERY_TIME_CLEARED', beforeJson: { deliveryTime: { startMin: 600 } }, afterJson: { deliveryTime: null } });
  });

  it('refuses a time that is not one (400), and "Other" without a note', async () => {
    for (const body of [{ startMin: 660, endMin: 600, reason: 'URGENT' }, { reason: 'URGENT' }, { startMin: 600, endMin: 1500, reason: 'URGENT' }, { startMin: 600, reason: 'SOON' }, { startMin: 600, reason: 'OTHER' }]) {
      expect((await putTime({ orderId: 'O1', ...body })).status, JSON.stringify(body)).toBe(400);
    }
    expect(row('order', 'O1').deliveryStartMin).toBeNull();
  });

  it('never on an order brought forward to a later day, nor on one on a locked load (frozen loads never change)', async () => {
    const carried = await putTime({ orderId: 'O2', startMin: 600, endMin: 660, reason: 'URGENT' });
    expect(carried.status).toBe(409);
    expect(carried.body.error).toMatchObject({ code: 'ORDER_CARRIED' });
    tables.runPlan = [{ id: 'R1', tenantId: T, depotId: 'D1', runDate: DAY, status: 'READY', supersededAt: null, version: 1, chosenScenarioId: 'S1', createdAt: new Date() }];
    tables.planLoad = [{ id: 'L1', tenantId: T, runId: 'R1', truckId: 'T1', loadNo: 1, status: 'LOCKED' }];
    tables.routeAssignment = [{ id: 'A1', runId: 'R1', orderId: 'O1', loadId: 'L1' }];
    const frozen = await putTime({ orderId: 'O1', startMin: 600, endMin: 660, reason: 'URGENT' });
    expect(frozen.status).toBe(409);
    expect(frozen.body.error).toMatchObject({ code: 'ORDER_ON_FROZEN_LOAD' });
    // On a PLANNED load it is saved, and the dispatcher is told to RE-PLAN.
    tables.planLoad[0]!.status = 'PLANNED';
    const ok = await putTime({ orderId: 'O1', startMin: 600, endMin: 660, reason: 'URGENT' });
    expect(ok.status).toBe(200);
    expect(ok.body.data.message).toMatch(/RE-PLAN to plan the order with it/);
  });

  it('a viewer cannot set it (403)', async () => {
    session.role = 'VIEWER';
    expect((await putTime({ orderId: 'O1', startMin: 600, endMin: 660, reason: 'URGENT' })).status).toBe(403);
  });
});
