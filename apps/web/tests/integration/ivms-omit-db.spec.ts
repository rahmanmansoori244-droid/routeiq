/**
 * IVMS LIVE LINK, DAY-0 CONTRACT (16 Oct 2026) on real PostgreSQL, library level: the real route
 * handlers, tenantDb, the app's Prisma client (lib/db.ts, with its global omit) and the migration's
 * defaults and CHECKs; only the session is faked (vi.mock of auth). Needs DATABASE_URL (migrated, with
 * 20261016200000_ivms_live); the web server and the solver are not used. No call is made to Ayun.
 * Invented data only: the vendor documentation's dummy IMEIs, made-up codes and coordinates.
 *
 *  1. A company gets the IVMS settings OFF, with the documented defaults.
 *  2. A truck with a tracker and a depot with an Ayun zone read exactly as before everywhere: the Trucks
 *     and Depots APIs (any role, whole rows), a truck read with its depot, a load read with its truck,
 *     and the before/after rows of a truck change in the audit log never carry the IMEI or the zone.
 *     Only a read that asks for them by name gets them.
 *  3. The database refuses what the app refuses: an IMEI that is not digits, a tracker on a one-day hired
 *     truck, the same tracker on two trucks of one company (another company may have it), a mode outside
 *     OFF / MAP / TIMES, operating hours across midnight, a stored error that is not a kind code.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const session = vi.hoisted(() => ({ user: null as null | Record<string, unknown> }));
vi.mock('@/lib/auth', () => ({ auth: vi.fn(async () => (session.user ? { user: session.user } : null)) }));

import { GET as listTrucks } from '@/app/api/trucks/route';
import { GET as getTruck, PATCH as patchTruck } from '@/app/api/trucks/[id]/route';
import { GET as listDepots } from '@/app/api/depots/route';
import { prisma as libPrisma } from '@/lib/db';
import { IVMS_SETTING_DEFAULTS } from '@/lib/ivms/settings';
import { cleanupTenant, prisma, uniqueSuffix } from './helpers';

const IMEI_A = '111111111111111';
const IMEI_B = '222222222222222';
const ZONE = 'Example depot zone';
const slug = `ivms0-${uniqueSuffix()}`.toLowerCase().slice(0, 32);
const slugOther = `ivms0b-${uniqueSuffix()}`.toLowerCase().slice(0, 32);
let tenantId = '';
let otherId = '';
let adminId = '';
let depotId = '';
let truckId = '';

const as = (role: 'TENANT_ADMIN' | 'PLANNER' | 'VIEWER') => {
  session.user = { id: adminId, tenantId, role, name: 'Admin', email: `admin@${slug}.test` };
};
const jreq = (url: string, method: string, body?: unknown) =>
  new Request(`http://localhost${url}`, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
const refused = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch {
    return true;
  }
  return false;
};

beforeAll(async () => {
  const t = await prisma.tenant.create({ data: { slug, name: `IVMS day 0 ${slug}`, country: 'Oman' } });
  tenantId = t.id;
  await prisma.tenantConfig.create({ data: { tenantId } });
  otherId = (await prisma.tenant.create({ data: { slug: slugOther, name: `IVMS day 0 other ${slugOther}`, country: 'Oman' } })).id;
  adminId = (await prisma.user.create({ data: { tenantId, email: `admin@${slug}.test`, passwordHash: 'x', name: 'Admin', role: 'TENANT_ADMIN' } })).id;
  depotId = (await prisma.depot.create({ data: { tenantId, code: 'GD1', name: 'Example depot', lat: 23.5, lng: 58.3, ivmsZoneName: ZONE } })).id;
  truckId = (await prisma.truck.create({ data: { tenantId, depotId, code: 'GT05', capacityCases: 500, ivmsImei: IMEI_A } })).id;
});

afterAll(async () => {
  await prisma.planLoad.deleteMany({ where: { tenantId: { in: [tenantId, otherId] } } });
  await cleanupTenant(slug);
  await cleanupTenant(slugOther);
  await prisma.$disconnect();
  await libPrisma.$disconnect();
});

describe('1. defaults', () => {
  it('a company gets ivmsMode OFF and the documented defaults', async () => {
    const cfg = await prisma.tenantConfig.findUniqueOrThrow({ where: { tenantId } });
    for (const [k, v] of Object.entries(IVMS_SETTING_DEFAULTS)) expect((cfg as Record<string, unknown>)[k], k).toBe(v);
  });
});

describe('2. no existing read sees the IMEI or the zone', () => {
  it('the Trucks and Depots APIs answer as before, for every role', async () => {
    for (const role of ['VIEWER', 'PLANNER', 'TENANT_ADMIN'] as const) {
      as(role);
      for (const res of [await listTrucks(jreq('/api/trucks', 'GET')), await getTruck(jreq(`/api/trucks/${truckId}`, 'GET'), { params: { id: truckId } }), await listDepots(jreq('/api/depots', 'GET'))]) {
        expect(res.status, role).toBe(200);
        const text = await res.text();
        expect(text, role).not.toContain(IMEI_A);
        expect(text, role).not.toContain('ivmsImei');
        expect(text, role).not.toContain('ivmsZoneName');
        expect(text, role).not.toContain(ZONE);
      }
    }
  });

  it('whole-row and nested reads of the app client leave them out; a read that names them gets them', async () => {
    const truck = await libPrisma.truck.findUniqueOrThrow({ where: { id: truckId }, include: { depot: true } });
    expect('ivmsImei' in truck).toBe(false);
    expect('ivmsZoneName' in truck.depot).toBe(false);
    const run = await libPrisma.runPlan.create({ data: { tenantId, depotId, runDate: new Date('2026-10-16T00:00:00Z'), createdById: adminId } });
    await libPrisma.planLoad.create({ data: { tenantId, runId: run.id, truckId, loadNo: 1, departMin: 360, returnMin: 480, distanceKm: 1, durationMin: 60, cases: 1, weightKg: 1, utilizationPct: 1 } });
    const load = await libPrisma.planLoad.findFirstOrThrow({ where: { runId: run.id }, include: { truck: true, run: { include: { depot: true } } } });
    expect(JSON.stringify(load)).not.toMatch(/ivmsImei|ivmsZoneName|111111111111111/);
    expect((await libPrisma.truck.findUniqueOrThrow({ where: { id: truckId }, select: { ivmsImei: true } })).ivmsImei).toBe(IMEI_A);
    expect((await libPrisma.truck.findUniqueOrThrow({ where: { id: truckId }, omit: { ivmsImei: false } })).ivmsImei).toBe(IMEI_A);
    expect((await libPrisma.depot.findUniqueOrThrow({ where: { id: depotId }, select: { ivmsZoneName: true } })).ivmsZoneName).toBe(ZONE);
  });

  it('a truck change by the admin is audited without the IMEI, and keeps it', async () => {
    as('TENANT_ADMIN');
    const res = await patchTruck(jreq(`/api/trucks/${truckId}`, 'PATCH', { description: 'changed' }), { params: { id: truckId } });
    expect(res.status).toBe(200);
    expect(await res.text()).not.toContain(IMEI_A);
    const row = await prisma.auditLog.findFirstOrThrow({ where: { tenantId, entity: 'Truck', entityId: truckId }, orderBy: { createdAt: 'desc' } });
    expect(JSON.stringify([row.beforeJson, row.afterJson])).not.toMatch(/ivmsImei|111111111111111/);
    expect((await prisma.truck.findUniqueOrThrow({ where: { id: truckId } })).ivmsImei).toBe(IMEI_A);
  });
});

describe('3. the database refuses what the app refuses', () => {
  it('Truck.ivmsImei: digits only, unique per company, never on a one-day hired truck', async () => {
    expect(await refused(prisma.truck.update({ where: { id: truckId }, data: { ivmsImei: '12345-ABC' } }))).toBe(true);
    expect(await refused(prisma.truck.create({ data: { tenantId, depotId, code: 'GT06', ivmsImei: IMEI_A } }))).toBe(true);
    expect(await refused(prisma.truck.create({ data: { tenantId, depotId, code: 'GT07', ivmsImei: IMEI_B, onlyOnDate: new Date('2026-10-16T00:00:00Z') } }))).toBe(true);
    // Another company may map the same tracker id (it is unique per company only).
    const otherDepot = await prisma.depot.create({ data: { tenantId: otherId, code: 'GD1', name: 'Other depot', lat: 23.5, lng: 58.3 } });
    expect(await refused(prisma.truck.create({ data: { tenantId: otherId, depotId: otherDepot.id, code: 'GT05', ivmsImei: IMEI_A } }))).toBe(false);
    // Many trucks without a tracker (NULLs never collide).
    expect(await refused(prisma.truck.create({ data: { tenantId, depotId, code: 'GT08' } }))).toBe(false);
    expect(await refused(prisma.truck.create({ data: { tenantId, depotId, code: 'GT09' } }))).toBe(false);
  });

  it('TenantConfig: the mode list, the bounds and the hours order', async () => {
    for (const data of [{ ivmsMode: 'ALERTS' }, { ivmsPollSec: 10 }, { ivmsTrailDays: 0 }, { ivmsDailyCallBudget: 5 }, { ivmsFromMin: 600, ivmsToMin: 600 }]) {
      expect(await refused(prisma.tenantConfig.update({ where: { tenantId }, data })), JSON.stringify(data)).toBe(true);
    }
    expect(await refused(prisma.tenantConfig.update({ where: { tenantId }, data: { ivmsMode: 'MAP' } }))).toBe(false);
    await prisma.tenantConfig.update({ where: { tenantId }, data: { ivmsMode: 'OFF' } });
  });

  it('IvmsState keeps a kind code only as the last error; IvmsEvent kinds and origins are the listed ones', async () => {
    const usageDay = new Date('2026-10-16T00:00:00Z');
    expect(await refused(prisma.ivmsState.create({ data: { tenantId, usageDay, lastError: 'https://x.example.test/?key=abc' } }))).toBe(true);
    expect(await refused(prisma.ivmsState.create({ data: { tenantId, usageDay, mapCalls: -1 } }))).toBe(true);
    expect(await refused(prisma.ivmsState.create({ data: { tenantId, usageDay, lastError: 'HTTP_ERROR' } }))).toBe(false);
    const at = new Date('2026-10-16T06:00:00Z');
    expect(await refused(prisma.ivmsEvent.create({ data: { tenantId, truckId, kind: 'STOPPED', origin: 'WEBHOOK', eventAt: at, dedupeKey: 'ayun:test-key-1' } }))).toBe(true);
    expect(await refused(prisma.ivmsEvent.create({ data: { tenantId, truckId, kind: 'DEPOT_IN', origin: 'POLL', eventAt: at, dedupeKey: 'ayun:test-key-2' } }))).toBe(true);
    expect(await refused(prisma.ivmsEvent.create({ data: { tenantId, truckId, kind: 'DEPOT_IN', origin: 'WEBHOOK', eventAt: at, dedupeKey: 'ayun:test-key-3' } }))).toBe(false);
    // The same event twice (a webhook and the backstop) is one row.
    expect(await refused(prisma.ivmsEvent.create({ data: { tenantId, truckId, kind: 'DEPOT_IN', origin: 'BACKSTOP', eventAt: at, dedupeKey: 'ayun:test-key-3' } }))).toBe(true);
  });
});
