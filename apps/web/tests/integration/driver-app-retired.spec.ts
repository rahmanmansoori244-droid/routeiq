/**
 * Integration (stabilization PR1, owner decision DISABLE): the legacy driver phone app is retired.
 * Every /api/driver/* route, the PIN route and the live route answer 410 - without a token, with
 * a junk token and with a VALID shift token - and write nothing (DriverShift, TruckLocation and
 * DeliveryProof counts unchanged). /driver says "retired".
 *
 * NMWC regression: the Drivers API (GET, POST, PATCH) keeps working, and deleting a driver who is
 * on a DISPATCHED load deactivates the driver instead, leaving PlanLoad.driverId unchanged.
 *
 * Requires: web server (RATE_LIMITS_DISABLED=1) + Postgres. No solver needed.
 */
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BASE, cleanupTenant, fetchWith, freshTenant, prisma, type TenantHandle } from './helpers';

let t: TenantHandle;
let driverId = '';
let truckId = '';
let depotId = '';
let validToken = '';
const PIN_HASH = '$2a$12$' + 'Q'.repeat(53);

const j = (body: unknown, method = 'POST') => ({ method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

async function counts() {
  const [shifts, pings, proofs] = await Promise.all([
    prisma.driverShift.count({ where: { tenantId: t.tenantId } }),
    prisma.truckLocation.count({ where: { tenantId: t.tenantId } }),
    prisma.deliveryProof.count({ where: { tenantId: t.tenantId } }),
  ]);
  return { shifts, pings, proofs };
}

beforeAll(async () => {
  t = await freshTenant('drvgone');
  depotId = (await prisma.depot.create({ data: { tenantId: t.tenantId, code: 'D1', name: 'Depot', lat: 23.58, lng: 58.39 } })).id;
  truckId = (await prisma.truck.create({ data: { tenantId: t.tenantId, depotId, code: 'T1', capacityCases: 100 } })).id;
  driverId = (await prisma.driver.create({ data: { tenantId: t.tenantId, code: 'D1', name: 'Salim', accessPinHash: PIN_HASH } })).id;
  validToken = randomBytes(32).toString('base64url');
  await prisma.driverShift.create({ data: { tenantId: t.tenantId, driverId, truckId, sessionToken: validToken, status: 'ACTIVE' } });
});

afterAll(async () => {
  if (t) await cleanupTenant(t.slug);
  await prisma.$disconnect();
});

const DRIVER_ROUTES: Array<[string, string, unknown]> = [
  ['POST', '/api/driver/login', { tenantSlug: 'x', driverCode: 'D1', pin: '123456' }],
  ['GET', '/api/driver/manifest', undefined],
  ['POST', '/api/driver/ping', { lat: 23.6, lng: 58.4, ts: Date.now() }],
  ['POST', '/api/driver/stop', { assignmentId: 'x' }],
  ['POST', '/api/driver/shift/end', {}],
];

describe('retired driver app routes', () => {
  it.each(DRIVER_ROUTES)('%s %s answers 410 with no token, a junk token and a valid token, and writes nothing', async (method, path, body) => {
    const before = await counts();
    for (const token of [null, 'junk-token', validToken]) {
      const headers: Record<string, string> = { 'content-type': 'application/json' };
      if (token) headers['x-driver-token'] = token;
      const res = await fetch(`${BASE}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
      expect(res.status, `${path} token=${token ? 'set' : 'none'}`).toBe(410);
      expect(res.headers.get('cache-control')).toContain('no-store');
    }
    expect(await counts()).toEqual(before);
    // The valid shift was not ended by the retired end-shift route.
    expect((await prisma.driverShift.findUniqueOrThrow({ where: { sessionToken: validToken } })).status).toBe('ACTIVE');
  });

  it('POST /api/drivers/:id/pin is 410 for an admin and leaves the stored hash unchanged', async () => {
    const res = await fetchWith(t.cookieJar, `${BASE}/api/drivers/${driverId}/pin`, { method: 'POST' });
    expect(res.status).toBe(410);
    expect((await prisma.driver.findUniqueOrThrow({ where: { id: driverId } })).accessPinHash).toBe(PIN_HASH);
  });

  it('GET /api/runs/:id/live is 410', async () => {
    const run = await prisma.runPlan.create({ data: { tenantId: t.tenantId, depotId, runDate: new Date(), status: 'READY', createdById: t.userId } });
    expect((await fetchWith(t.cookieJar, `${BASE}/api/runs/${run.id}/live`)).status).toBe(410);
  });

  it('/driver and /driver/manifest show the retired notice', async () => {
    for (const p of ['/driver', '/driver/manifest']) {
      const res = await fetch(`${BASE}${p}`);
      expect(res.status).toBe(200);
      expect(await res.text()).toContain('driver app is retired');
    }
  });
});

describe('NMWC drivers keep working', () => {
  it('GET, POST and PATCH /api/drivers', async () => {
    const list = await fetchWith(t.cookieJar, `${BASE}/api/drivers`);
    expect(list.status).toBe(200);
    const created = await fetchWith(t.cookieJar, `${BASE}/api/drivers`, j({ code: 'D2', name: 'Khalid', phone: '+968 9000 0002', active: true }));
    expect(created.status).toBe(201);
    const id = ((await created.json()) as { data: { id: string } }).data.id;
    const patched = await fetchWith(t.cookieJar, `${BASE}/api/drivers/${id}`, j({ phone: '+968 9000 0003' }, 'PATCH'));
    expect(patched.status).toBe(200);
    expect(((await patched.json()) as { data: { phone: string } }).data.phone).toBe('+968 9000 0003');
  });

  it('deleting a driver on a DISPATCHED load deactivates it and keeps the load driver', async () => {
    const d = await prisma.driver.create({ data: { tenantId: t.tenantId, code: 'D9', name: 'On the road' } });
    const run = await prisma.runPlan.create({ data: { tenantId: t.tenantId, depotId, runDate: new Date(), status: 'DISPATCHED', createdById: t.userId } });
    const load = await prisma.planLoad.create({
      data: {
        tenantId: t.tenantId, runId: run.id, truckId, loadNo: 1, status: 'DISPATCHED', driverId: d.id,
        departMin: 420, returnMin: 600, distanceKm: 40, durationMin: 180, cases: 50, weightKg: 600, utilizationPct: 50,
      },
    });
    const res = await fetchWith(t.cookieJar, `${BASE}/api/drivers/${d.id}`, { method: 'DELETE' });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { data: { softDeleted?: boolean } }).data.softDeleted).toBe(true);
    expect((await prisma.driver.findUniqueOrThrow({ where: { id: d.id } })).active).toBe(false);
    expect((await prisma.planLoad.findUniqueOrThrow({ where: { id: load.id } })).driverId).toBe(d.id);
  });

  it('deleting a driver never used on a load really deletes it', async () => {
    const d = await prisma.driver.create({ data: { tenantId: t.tenantId, code: 'D8', name: 'Unused' } });
    const res = await fetchWith(t.cookieJar, `${BASE}/api/drivers/${d.id}`, { method: 'DELETE' });
    expect(res.status).toBe(200);
    expect(await prisma.driver.findUnique({ where: { id: d.id } })).toBeNull();
  });
});
