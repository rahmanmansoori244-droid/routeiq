/**
 * Integration (stabilization PR1, reviews F13, F15, F23, L16): the role x endpoint matrix for
 * the admin-data reads, the job debug JSON and the runs GET, run as real VIEWER, PLANNER,
 * SUPERVISOR and TENANT_ADMIN sessions (invited through the users API). No response, and no
 * page HTML, may carry a driver PIN hash, whatever the role.
 *
 * Requires: web server (RATE_LIMITS_DISABLED=1) + Postgres. No solver needed.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  BASE,
  CookieJar,
  cleanupTenant,
  fetchWith,
  followRedirects,
  freshTenant,
  inviteUser,
  prisma,
  type InvitableRole,
  type TenantHandle,
} from './helpers';

const BCRYPT = /\$2[aby]\$\d\d\$/;
const FAKE_PIN_HASH = '$2a$12$' + 'P'.repeat(53);

let t: TenantHandle;
const jars: Record<InvitableRole, CookieJar> = {} as never;
let driverId = '';
let runId = '';
let otherRunId = '';
let jobId = '';

const j = (body: unknown, method = 'POST') => ({ method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

beforeAll(async () => {
  t = await freshTenant('roles');
  jars.TENANT_ADMIN = t.cookieJar;
  for (const r of ['SUPERVISOR', 'PLANNER', 'VIEWER'] as const) jars[r] = (await inviteUser(t, r)).jar;

  const created = await fetchWith(t.cookieJar, `${BASE}/api/drivers`, j({ code: 'D1', name: 'Salim', phone: '+968 9000 0001', active: true }));
  expect(created.status).toBe(201);
  driverId = ((await created.json()) as { data: { id: string } }).data.id;
  // A legacy PIN hash (the retired driver app) and a legacy audit row that still holds one.
  await prisma.driver.update({ where: { id: driverId }, data: { accessPinHash: FAKE_PIN_HASH } });
  await prisma.auditLog.create({
    data: { tenantId: t.tenantId, action: 'UPDATE', entity: 'Driver', entityId: driverId, beforeJson: { code: 'D1', accessPinHash: FAKE_PIN_HASH }, afterJson: { code: 'D1', accessPinHash: FAKE_PIN_HASH } },
  });

  const depot = await prisma.depot.create({ data: { tenantId: t.tenantId, code: 'D1', name: 'Depot', lat: 23.58, lng: 58.39 } });
  const mkRun = () => prisma.runPlan.create({ data: { tenantId: t.tenantId, depotId: depot.id, runDate: new Date(), status: 'FAILED', createdById: t.userId } });
  runId = (await mkRun()).id;
  otherRunId = (await mkRun()).id;
  jobId = (
    await prisma.runJob.create({
      data: {
        tenantId: t.tenantId,
        runId,
        attemptNo: 1,
        status: 'FAILED',
        createdById: t.userId,
        requestJson: { stops: [{ stop_id: 's1', revenue: 12.5, margin: 3.1, lat: 23.6, lng: 58.4 }] },
        responseJson: { detail: 'test' },
      },
    })
  ).id;
});

afterAll(async () => {
  if (t) await cleanupTenant(t.slug);
  await prisma.$disconnect();
});

const ROLES: InvitableRole[] = ['VIEWER', 'PLANNER', 'SUPERVISOR', 'TENANT_ADMIN'];

describe('admin data reads are TENANT_ADMIN only (F15, F23)', () => {
  it.each(ROLES)('%s', async (role) => {
    const expected = role === 'TENANT_ADMIN' ? 200 : 403;
    for (const path of ['/api/users', '/api/audit', '/api/tenant/config']) {
      const res = await fetchWith(jars[role], `${BASE}${path}`);
      expect(res.status, `${role} GET ${path}`).toBe(expected);
    }
  });
});

describe('job debug JSON is SUPERVISOR+ (F15), and 404 for a job of another run (L16)', () => {
  it.each(ROLES)('%s', async (role) => {
    const res = await fetchWith(jars[role], `${BASE}/api/runs/${runId}/jobs/${jobId}/debug`);
    expect(res.status).toBe(role === 'VIEWER' || role === 'PLANNER' ? 403 : 200);
  });

  it('a job id under the wrong run is 404, not 500', async () => {
    const res = await fetchWith(jars.SUPERVISOR, `${BASE}/api/runs/${otherRunId}/jobs/${jobId}/debug`);
    expect(res.status).toBe(404);
  });
});

describe('GET /api/runs/:id carries job status only (F15)', () => {
  it.each(ROLES)('%s', async (role) => {
    const res = await fetchWith(jars[role], `${BASE}/api/runs/${runId}`);
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain('requestJson');
    expect(text).not.toContain('responseJson');
    expect(text).not.toContain('"margin"');
  });
});

describe('no driver PIN hash in any response or page (F13)', () => {
  it.each(ROLES)('%s: drivers API, audit API and the Drivers page', async (role) => {
    const bodies: string[] = [];
    bodies.push(await (await fetchWith(jars[role], `${BASE}/api/drivers`)).text());
    bodies.push(await (await fetchWith(jars[role], `${BASE}/api/drivers/${driverId}`)).text());
    bodies.push(await (await fetchWith(jars[role], `${BASE}/api/audit?entity=Driver`)).text());
    const page = await fetchWith(jars[role], `${BASE}/t/${t.slug}/drivers`);
    expect(page.status).toBe(200);
    bodies.push(await page.text());
    for (const b of bodies) {
      expect(b).not.toContain('accessPinHash');
      expect(b).not.toMatch(BCRYPT);
    }
  });

  it('TENANT_ADMIN writes: POST and PATCH answer without the hash, and the new audit rows hold none', async () => {
    const created = await fetchWith(jars.TENANT_ADMIN, `${BASE}/api/drivers`, j({ code: 'D2', name: 'Khalid', active: true }));
    expect(created.status).toBe(201);
    const patched = await fetchWith(jars.TENANT_ADMIN, `${BASE}/api/drivers/${driverId}`, j({ name: 'Salim A.' }, 'PATCH'));
    expect(patched.status).toBe(200);
    for (const b of [await created.text(), await patched.text()]) {
      expect(b).not.toContain('accessPinHash');
      expect(b).not.toMatch(BCRYPT);
    }
    const rows = await prisma.auditLog.findMany({ where: { tenantId: t.tenantId, entity: 'Driver', entityId: driverId }, orderBy: { createdAt: 'desc' }, take: 1 });
    expect(JSON.stringify(rows[0])).not.toContain('accessPinHash');
  });
});

describe('page gates are unchanged', () => {
  it('VIEWER is sent from the Users page back to the dashboard', async () => {
    const nav = await followRedirects(jars.VIEWER, `/t/${t.slug}/users`, 3);
    expect(new URL(nav.urls.at(-1)!).pathname).toBe(`/t/${t.slug}`);
  });
});
