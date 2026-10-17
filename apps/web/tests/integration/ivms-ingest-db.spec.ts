/**
 * IVMS LIVE LINK, INGEST (16 Oct 2026) on real PostgreSQL, library level: lib/ivms/store.ts (the SQL of
 * the lease, the claims and the counters), lib/ivms/poll.ts with a fake Ayun (an injected fetch: never a
 * real call), the webhook route handler (app/api/ivms/ayun/[secret]/route.ts, its variables stubbed) and
 * the retention. Needs DATABASE_URL (migrated, with 20261016200000_ivms_live); no web server, no solver.
 * Invented data only: the vendor documentation's dummy IMEIs, made-up codes, an invented origin.
 *
 *  1. Who is out: only the company's own active trucks with a tracker, with their loads of yesterday and
 *     today on the plans in use; another company's truck (same IMEI) never.
 *  2. The allowance in the database: two ticks at once make one call and count one; the counters reset on
 *     the provider's next day; a class stops at its share; the admin's claim does not wait for the lease.
 *  3. Positions: only a newer fix moves the latest; trucks no longer out lose theirs. History: the same
 *     point twice is one row; IvmsTruckDay records the pull.
 *  4. The webhook: nothing in MAP; in TIMES one row per event (twice = one), an unknown IMEI or another company's stores nothing,
 *     ivmsMode OFF stores nothing and writes no counter.
 *  5. Retention: the trail after ivmsTrailDays, positions when OFF.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { prisma as libPrisma } from '@/lib/db';
import { prismaIvmsStore } from '@/lib/ivms/store';
import { _resetIvmsProcessState, runIvmsTick } from '@/lib/ivms/poll';
import { purgeIvmsData } from '@/lib/ivms/retention';
import { _resetWebhookCache } from '@/lib/ivms/webhook';
import { utcDay } from '@/lib/ivms/budget';
import { todayIso } from '@/lib/dispatch/time';
import { GET as webhookGet, POST as webhookPost } from '@/app/api/ivms/ayun/[secret]/route';
import { fakeAyun, IMEI_A, IMEI_B, ivmsTestEnv, KEY, SECRET } from '../lib/ivms-fakes';
import { cleanupTenant, prisma, uniqueSuffix } from './helpers';

const slug = `ivmsi-${uniqueSuffix()}`.toLowerCase().slice(0, 32);
const slugOther = `ivmsj-${uniqueSuffix()}`.toLowerCase().slice(0, 32);
let tenantId = '';
let otherId = '';
let depotId = '';
let truckA = '';
let truckB = '';
let otherTruck = '';
/** The poller's variables, without a webhook secret: no backstop call joins the ones under test. */
const env = () => ivmsTestEnv({ AYUN_TENANT_SLUG: slug, AYUN_WEBHOOK_SECRET: undefined });

beforeAll(async () => {
  tenantId = (await prisma.tenant.create({ data: { slug, name: `IVMS ingest ${slug}`, country: 'Oman' } })).id;
  await prisma.tenantConfig.create({ data: { tenantId, ivmsMode: 'MAP', ivmsFromMin: 0, ivmsToMin: 1440, ivmsDailyCallBudget: 3000 } });
  otherId = (await prisma.tenant.create({ data: { slug: slugOther, name: `IVMS ingest other ${slugOther}`, country: 'Oman' } })).id;
  await prisma.tenantConfig.create({ data: { tenantId: otherId, ivmsMode: 'MAP' } });
  const adminId = (await prisma.user.create({ data: { tenantId, email: `admin@${slug}.test`, passwordHash: 'x', name: 'Admin', role: 'TENANT_ADMIN' } })).id;
  depotId = (await prisma.depot.create({ data: { tenantId, code: 'GD1', name: 'Example depot', lat: 10.5, lng: 20.5, ivmsZoneName: 'Example depot zone' } })).id;
  truckA = (await prisma.truck.create({ data: { tenantId, depotId, code: 'GT01', capacityCases: 500, ivmsImei: IMEI_A } })).id;
  truckB = (await prisma.truck.create({ data: { tenantId, depotId, code: 'GT02', capacityCases: 500, ivmsImei: IMEI_B } })).id;
  await prisma.truck.create({ data: { tenantId, depotId, code: 'GT03', capacityCases: 500 } }); // no tracker
  const otherDepot = await prisma.depot.create({ data: { tenantId: otherId, code: 'GD1', name: 'Other depot', lat: 10.6, lng: 20.6 } });
  otherTruck = (await prisma.truck.create({ data: { tenantId: otherId, depotId: otherDepot.id, code: 'GT01', capacityCases: 500, ivmsImei: IMEI_A } })).id;
  const run = await prisma.runPlan.create({ data: { tenantId, depotId, runDate: new Date(`${todayIso('Asia/Muscat')}T00:00:00Z`), createdById: adminId } });
  const load = { departMin: 360, returnMin: 600, distanceKm: 1, durationMin: 60, cases: 1, weightKg: 1, utilizationPct: 1 };
  await prisma.planLoad.create({ data: { tenantId, runId: run.id, truckId: truckA, loadNo: 1, status: 'DISPATCHED', ...load } });
  await prisma.planLoad.create({ data: { tenantId, runId: run.id, truckId: truckB, loadNo: 1, status: 'PLANNED', ...load } });
});

afterEach(() => {
  vi.unstubAllEnvs();
  _resetIvmsProcessState();
  _resetWebhookCache();
});

afterAll(async () => {
  await prisma.planLoad.deleteMany({ where: { tenantId: { in: [tenantId, otherId] } } });
  await cleanupTenant(slug);
  await cleanupTenant(slugOther);
  await prisma.$disconnect();
  await libPrisma.$disconnect();
});

describe('1. who is out', () => {
  it('the company\'s own trucks with a tracker and their loads; never another company\'s, never one without a tracker', async () => {
    const c = (await prismaIvmsStore.company(slug))!;
    expect(c).toMatchObject({ tenantId, mode: 'MAP', fromMin: 0, toMin: 1440, dailyBudget: 3000 });
    const fleet = await prismaIvmsStore.fleet(c, new Date());
    expect(fleet.map((t) => [t.truckId, t.imei, t.days.flatMap((d) => d.loads.map((l) => l.status))])).toEqual(
      [
        [truckA, IMEI_A, ['DISPATCHED']],
        [truckB, IMEI_B, ['PLANNED']],
      ].sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
    );
    expect(await prismaIvmsStore.truckByImei(tenantId, IMEI_A)).toEqual({ truckId: truckA, depotId });
    expect(await prismaIvmsStore.truckByImei(otherId, IMEI_A)).toMatchObject({ truckId: otherTruck });
    expect(await prismaIvmsStore.depotZones(tenantId)).toEqual([{ depotId, zoneName: 'Example depot zone', lat: 10.5, lng: 20.5 }]);
  });
});

describe('2. the allowance in the database', () => {
  it('two ticks at once (a deploy overlap): one call, counted once, the lease released after', async () => {
    const now = new Date();
    const ayun = fakeAyun(() => now);
    await Promise.all([1, 2].map(() => runIvmsTick(now, {}, { env: env(), fetchImpl: ayun.fetch })));
    expect(ayun.calls.map((c) => c.cmd)).toEqual(['OBJECT_GET_LOCATIONS']);
    expect(ayun.calls[0]!.args[0]).toBe(IMEI_A); // the PLANNED truck is not asked about
    expect(new URL(ayun.calls[0]!.url).searchParams.get('key')).toBe(KEY);
    const s = await prisma.ivmsState.findUniqueOrThrow({ where: { tenantId } });
    expect(s).toMatchObject({ mapCalls: 1, routeCalls: 0, eventCalls: 0, adminCalls: 0, leaseUntil: null, leaseOwner: null, failures: 0 });
    expect(s.lastOkAt).not.toBeNull();
    expect(await prisma.truckPosition.count({ where: { tenantId } })).toBe(1);
  });

  it('the provider\'s next day resets every counter; a class stops at its share; the admin claim ignores the lease', async () => {
    const now = new Date();
    await prisma.ivmsState.update({ where: { tenantId }, data: { usageDay: new Date(`${utcDay(new Date(now.getTime() - 86_400_000))}T00:00:00Z`), mapCalls: 50, webhooksToday: 9 } });
    const row = await prismaIvmsStore.acquireLease(tenantId, 'owner-1', now, 30_000);
    expect(row).toMatchObject({ usageDay: utcDay(now), mapCalls: 0 });
    expect((await prisma.ivmsState.findUniqueOrThrow({ where: { tenantId } })).webhooksToday).toBe(0);
    // Another owner cannot take the lease while it runs; the admin's claim does not need it.
    expect(await prismaIvmsStore.acquireLease(tenantId, 'owner-2', now, 30_000)).toBeNull();
    expect(await prismaIvmsStore.claimAdmin(tenantId, now, { share: 2, budget: 3000 })).toBe(true);
    // MAP share of 2: two claims, then none; the wait since the last call is checked in the same statement.
    const lim = { share: 2, budget: 3000, leaseMs: 30_000 };
    expect(await prismaIvmsStore.claim(tenantId, 'owner-1', 'MAP', now, lim)).toBe(true);
    expect(await prismaIvmsStore.claim(tenantId, 'owner-1', 'MAP', now, { ...lim, minGapSec: 60 })).toBe(false);
    expect(await prismaIvmsStore.claim(tenantId, 'owner-1', 'MAP', now, lim)).toBe(true);
    expect(await prismaIvmsStore.claim(tenantId, 'owner-1', 'MAP', now, lim)).toBe(false);
    expect(await prismaIvmsStore.claim(tenantId, 'owner-2', 'ROUTE', now, lim)).toBe(false); // not the lease owner
    // The whole allowance counts every class.
    expect(await prismaIvmsStore.claim(tenantId, 'owner-1', 'ROUTE', now, { share: 10, budget: 3, leaseMs: 30_000 })).toBe(false);
    await prismaIvmsStore.releaseLease(tenantId, 'owner-1', now);
    expect(await prismaIvmsStore.acquireLease(tenantId, 'owner-2', now, 30_000)).not.toBeNull();
    await prismaIvmsStore.releaseLease(tenantId, 'owner-2', now);
  });

  it('a failure with a backoff refuses the lease until then; the error is a kind code only', async () => {
    const now = new Date();
    await prismaIvmsStore.recordFailure(tenantId, now, 'LIMIT', new Date(now.getTime() + 3600_000));
    expect(await prismaIvmsStore.acquireLease(tenantId, 'owner-3', now, 30_000)).toBeNull();
    expect(await prismaIvmsStore.claimAdmin(tenantId, now, { share: 20, budget: 3000 })).toBe(false); // LIMIT: no admin call either
    await prismaIvmsStore.recordOk(tenantId, now, { sec: 5, offsetMin: -240 });
    expect(await prisma.ivmsState.findUniqueOrThrow({ where: { tenantId } })).toMatchObject({ lastError: 'LIMIT', failures: 0, nextTryAt: null, providerSkewSec: 5, providerSkewAt: now, providerSkewOffsetMin: -240 });
    expect(await prismaIvmsStore.readSkew(tenantId)).toEqual({ skewSec: 5, skewAt: now, skewOffsetMin: -240 });
    // A call without a skew (history, backstop) keeps the last one.
    await prismaIvmsStore.recordOk(tenantId, new Date(now.getTime() + 1000));
    expect(await prismaIvmsStore.readSkew(tenantId)).toEqual({ skewSec: 5, skewAt: now, skewOffsetMin: -240 });
  });
});

describe('3. positions and history', () => {
  it('only a newer fix moves the latest position; trucks no longer out lose theirs', async () => {
    const t0 = new Date(Date.now() - 60_000);
    const fix = (at: Date, speed: number) => ({ imei: IMEI_B, fixAt: at, serverAt: at, lat: 10.51, lng: 20.51, speedKmh: speed, heading: 90, ignition: true, flags: [] as never[] });
    expect(await prismaIvmsStore.writePositions(tenantId, [{ truckId: truckB, fix: fix(t0, 30) }], new Date())).toBe(1);
    expect(await prismaIvmsStore.writePositions(tenantId, [{ truckId: truckB, fix: fix(new Date(t0.getTime() - 1000), 0) }], new Date())).toBe(0);
    expect(await prismaIvmsStore.writePositions(tenantId, [{ truckId: truckB, fix: fix(new Date(t0.getTime() + 1000), 0) }], new Date())).toBe(1);
    const p = await prisma.truckPosition.findUniqueOrThrow({ where: { truckId: truckB } });
    expect(p.movedAt).toEqual(t0); // parked since the last moving fix
    // Read again with no newer fix (a parked, silent truck): only the read time moves (second review L-5).
    const later = new Date(Date.now() + 5_000);
    expect(await prismaIvmsStore.writePositions(tenantId, [{ truckId: truckB, fix: fix(new Date(t0.getTime() + 1000), 0) }], later)).toBe(0);
    expect(await prisma.truckPosition.findUniqueOrThrow({ where: { truckId: truckB } })).toMatchObject({ receivedAt: later, fixAt: new Date(t0.getTime() + 1000) });
    expect(await prismaIvmsStore.clearPositions(tenantId, [truckA])).toBe(1);
    expect(await prisma.truckPosition.count({ where: { truckId: truckB } })).toBe(0);
  });

  it('the same history point twice is one row; the pull is recorded per truck-day', async () => {
    const at = new Date(Date.now() - 3600_000);
    const pts = [0, 1, 2].map((i) => ({ fixAt: new Date(at.getTime() + i * 60_000), lat: 10.5, lng: 20.5 + i * 0.001, speedKmh: 10, ignition: true }));
    expect(await prismaIvmsStore.writeTrail(tenantId, truckA, pts)).toBe(3);
    expect(await prismaIvmsStore.writeTrail(tenantId, truckA, pts)).toBe(0);
    const date = todayIso('Asia/Muscat');
    await prismaIvmsStore.markPulled(tenantId, truckA, date, { pulledTo: at, final: false, now: at });
    await prismaIvmsStore.markPulled(tenantId, truckA, date, { pulledTo: new Date(), final: true, now: new Date() });
    const [row] = await prismaIvmsStore.truckDays(tenantId, [{ truckId: truckA, date }]);
    expect(row).toMatchObject({ truckId: truckA, date, pulls: 2, trailFrom: null });
    expect(row!.finalPullAt).not.toBeNull();
    // The tracker mapping time (second review M-1) is read with the row.
    const from = new Date(Date.now() - 600_000);
    await prisma.ivmsTruckDay.update({ where: { tenantId_truckId_deliveryDate: { tenantId, truckId: truckA, deliveryDate: new Date(`${date}T00:00:00Z`) } }, data: { trailFrom: from } });
    expect((await prismaIvmsStore.truckDays(tenantId, [{ truckId: truckA, date }]))[0]).toMatchObject({ trailFrom: from });
  });
});

describe('4. the webhook', () => {
  const hook = (q: Record<string, string>, secret = SECRET) =>
    webhookGet(new Request(`https://routeiq.example/api/ivms/ayun/${secret}?${new URLSearchParams(q)}`, { headers: { 'x-forwarded-for': '203.0.113.7' } }), { params: { secret } });
  const event = (imei = IMEI_A, dt = new Date(Date.now() - 120_000)) => ({
    imei,
    type: 'zone_in',
    desc: 'Depot IN (Example depot zone)',
    zone_name: 'Example depot zone',
    lat: '10.5001',
    lng: '20.5001',
    dt_tracker: dt.toISOString().replace('T', ' ').slice(0, 19),
    driver_name: 'Example driver',
    plate_number: '0001 EX',
  });
  const stub = () => {
    vi.stubEnv('AYUN_WEBHOOK_SECRET', SECRET);
    vi.stubEnv('AYUN_TENANT_SLUG', slug);
    vi.stubEnv('ROUTEIQ_DISABLE_IVMS', '');
  };

  it('MAP never stores a depot move (only TIMES reads them): 200, counted as ignored', async () => {
    stub();
    expect((await hook(event())).status).toBe(200);
    expect(await prisma.ivmsEvent.count({ where: { tenantId } })).toBe(0);
    expect((await prisma.ivmsState.findUniqueOrThrow({ where: { tenantId } })).webhooksIgnored).toBeGreaterThanOrEqual(1);
  });

  it('one DEPOT_IN row per event (twice = one), in this company only; nothing it never reads is stored', async () => {
    stub();
    // Depot moves are stored in TIMES only, for a truck with a load on the plans in use (truck A: DISPATCHED).
    await prisma.tenantConfig.update({ where: { tenantId }, data: { ivmsMode: 'TIMES' } });
    const e = event();
    expect((await hook(e)).status).toBe(200);
    expect((await webhookPost(new Request(`https://routeiq.example/api/ivms/ayun/${SECRET}?${new URLSearchParams(e)}`, { method: 'POST' }), { params: { secret: SECRET } })).status).toBe(200);
    const rows = await prisma.ivmsEvent.findMany({ where: { tenantId, origin: 'WEBHOOK' } });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ truckId: truckA, depotId, kind: 'DEPOT_IN', zoneName: 'Example depot zone', processedAt: null });
    expect(JSON.stringify(rows)).not.toMatch(/Example driver|0001 EX/);
    expect(await prisma.ivmsEvent.count({ where: { tenantId: otherId } })).toBe(0);
    expect((await prisma.ivmsState.findUniqueOrThrow({ where: { tenantId } })).webhooksToday).toBe(2);
  });

  it('an unknown IMEI is counted, nothing stored; a wrong secret is 404', async () => {
    stub();
    const before = await prisma.ivmsEvent.count({ where: { tenantId } });
    expect((await hook(event(`${'3'.repeat(15)}`))).status).toBe(200);
    expect((await hook(event(), 'W'.repeat(40))).status).toBe(404);
    expect(await prisma.ivmsEvent.count({ where: { tenantId } })).toBe(before);
    expect((await prisma.ivmsState.findUniqueOrThrow({ where: { tenantId } })).webhooksIgnored).toBeGreaterThanOrEqual(1);
  });

  it('ivmsMode OFF: 200, no row and no counter', async () => {
    stub();
    vi.stubEnv('AYUN_TENANT_SLUG', slugOther);
    await prisma.tenantConfig.update({ where: { tenantId: otherId }, data: { ivmsMode: 'OFF' } });
    expect((await hook(event())).status).toBe(200);
    expect(await prisma.ivmsEvent.count({ where: { tenantId: otherId } })).toBe(0);
    expect(await prisma.ivmsState.count({ where: { tenantId: otherId } })).toBe(0);
  });
});

describe('5. retention', () => {
  it('the trail after ivmsTrailDays; every live position of a company whose mode is OFF', async () => {
    const old = new Date(Date.now() - 3 * 86_400_000);
    await prismaIvmsStore.writeTrail(tenantId, truckA, [{ fixAt: old, lat: 10.5, lng: 20.5, speedKmh: 0, ignition: null }]);
    await prisma.truckPosition.create({ data: { tenantId: otherId, truckId: otherTruck, fixAt: new Date(), receivedAt: new Date(), lat: 10.6, lng: 20.6 } });
    const r = await purgeIvmsData(new Date());
    expect(r).not.toBeNull();
    expect(await prisma.truckTrailPoint.count({ where: { tenantId, fixAt: { lt: new Date(Date.now() - 2 * 86_400_000) } } })).toBe(0);
    expect(await prisma.truckTrailPoint.count({ where: { tenantId } })).toBeGreaterThan(0);
    expect(await prisma.truckPosition.count({ where: { tenantId: otherId } })).toBe(0);
  });
});
