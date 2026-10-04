/**
 * GET / POST /api/tenant/start-fresh ("Start fresh (remove test data)", owner request 4 Oct 2026)
 * on the in-memory database (fake-plan-db.ts): company admins only (a dispatcher, supervisor or
 * viewer gets 403 and nothing is removed), the preview, the typed company code, the backup tick,
 * the preview the admin was shown (a run that would remove more answers 409 PREVIEW_STALE), the
 * extra tick for live-looking data, the date, the refusal while an optimization runs, the rate
 * limit (the real limiter: attempts that reach the run, with a plain answer), and the signed-in
 * user's own company only. Synthetic data only; the clock is 4 Oct 2026.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetDb, tables } from './fake-plan-db';

const state = vi.hoisted(() => ({ role: 'TENANT_ADMIN', tenantId: 'tA', userId: 'uA' }));
const rl = vi.hoisted(() => ({ limiter: null as null | { consume: (k: string, l: number, w: number) => unknown } }));

vi.mock('@/lib/auth', () => ({
  auth: vi.fn(async () => ({ user: { id: state.userId, tenantId: state.tenantId, role: state.role, name: 'Owner', email: 'owner@example.test' } })),
}));
vi.mock('@/lib/db', async () => ({ prisma: (await import('./fake-plan-db')).fakePrisma }));
vi.mock('@/lib/tenant', async () => {
  const m = await import('./fake-plan-db');
  return { tenantDb: () => m.fakePrisma };
});
vi.mock('@/lib/audit', async () => {
  const m = await import('./fake-plan-db');
  return { audit: vi.fn(async (input: Record<string, unknown>, tx?: Record<string, any>) => (tx ?? m.fakePrisma).auditLog.create({ data: { ...input } })) };
});
// The real limiter, not bypassed under the tests (NODE_ENV=test turns the shared one off).
vi.mock('@/lib/rate-limit', async (importOriginal) => {
  const m = await importOriginal<typeof import('@/lib/rate-limit')>();
  return { ...m, rateLimit: (k: string, l: number, w: number) => (rl.limiter ??= new m.RateLimiter()).consume(k, l, w) };
});

import { GET, POST } from '@/app/api/tenant/start-fresh/route';
import { START_FRESH_LIMITS } from '@/lib/start-fresh';
import { startFreshShown, type StartFreshShown } from '@/lib/start-fresh-text';

type Row = Record<string, any>;
const day = (iso: string) => new Date(`${iso}T00:00:00.000Z`);

function seed(tenantId: string, p: string) {
  const push = (model: string, rows: Row[]) => (tables[model] ??= []).push(...rows);
  push('tenant', [{ id: tenantId, slug: `${p}-co` }]);
  push('tenantConfig', [{ id: `${p}cfg`, tenantId, timezone: 'Asia/Muscat' }]);
  push('customer', [{ id: `${p}c1`, tenantId }]);
  push('product', [{ id: `${p}pr`, tenantId }]);
  push('truck', [{ id: `${p}t1`, tenantId, defaultDriverId: null }]);
  push('uploadBatch', [{ id: `${p}b1`, tenantId, deliveryDate: day('2026-10-02'), uploadedAt: new Date('2026-10-01T09:00:00Z') }]);
  push('order', [
    { id: `${p}o1`, tenantId, customerId: `${p}c1`, deliveryDate: day('2026-10-02'), uploadBatchId: `${p}b1`, isLate: false, carriedFromOrderId: null, carriedToOrderId: null },
    { id: `${p}o6`, tenantId, customerId: `${p}c1`, deliveryDate: day('2026-10-06'), uploadBatchId: null, isLate: true, carriedFromOrderId: null, carriedToOrderId: null },
  ]);
  push('orderLine', [{ id: `${p}l1`, orderId: `${p}o1`, productId: `${p}pr` }, { id: `${p}l6`, orderId: `${p}o6`, productId: `${p}pr` }]);
  push('runPlan', [{ id: `${p}p2`, tenantId, runDate: day('2026-10-02'), version: 1 }]);
  push('planLoad', [{ id: `${p}ld`, tenantId, runId: `${p}p2`, truckId: `${p}t1`, driverId: null, status: 'PLANNED' }]);
  push('routeAssignment', [{ id: `${p}ra`, runId: `${p}p2`, loadId: `${p}ld`, orderId: `${p}o1` }]);
  push('runJob', [{ id: `${p}j`, tenantId, runId: `${p}p2`, status: 'SUCCEEDED' }]);
  push('auditLog', [{ id: `${p}a1`, tenantId, action: 'LOGIN', entity: 'User' }]);
}

const get = (q = '') => GET(new Request(`http://localhost/api/tenant/start-fresh${q}`));
const post = (body: unknown) =>
  POST(new Request('http://localhost/api/tenant/start-fresh', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }));
/** What the panel shows after "Check what will be removed" (and sends back with the run). */
const shownNow = async (before?: string): Promise<StartFreshShown> => startFreshShown((await (await get(before ? `?before=${before}` : '')).json()).data);
/** A run of company A as the panel sends it: the code, the backup tick, the live-data tick (the order of the 6th is "today or later") and the preview shown. */
const okBody = async (extra: Row = {}) => ({ confirm: 'a-co', backupConfirmed: true, liveDataConfirmed: true, expect: await shownNow(extra.before), ...extra });
const ordersOf = (t: string) => (tables.order ?? []).filter((o) => o.tenantId === t).map((o) => o.id).sort();

beforeAll(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-04T06:00:00Z'));
});
afterAll(() => {
  vi.useRealTimers();
});

beforeEach(() => {
  resetDb();
  seed('tA', 'a');
  seed('tB', 'b');
  state.role = 'TENANT_ADMIN';
  state.tenantId = 'tA';
  state.userId = 'uA';
  rl.limiter = null;
});

describe('who may use it', () => {
  it.each(['PLANNER', 'SUPERVISOR', 'VIEWER'])('%s: 403 on the preview and the run, nothing removed', async (role) => {
    const body = await okBody();
    state.role = role;
    expect((await get()).status).toBe(403);
    expect((await post(body)).status).toBe(403);
    expect(ordersOf('tA')).toEqual(['ao1', 'ao6']);
    expect(tables.auditLog!.filter((a) => a.action === 'TEST_DATA_CLEARED')).toEqual([]);
  });

  it('a company admin previews and runs it; a platform admin may too (on their own company)', async () => {
    const res = await get();
    expect(res.status).toBe(200);
    expect((await res.json()).data).toMatchObject({
      before: null,
      removed: { orders: 2, planVersions: 1, stops: 1, uploadBatches: 1 },
      live: { today: '2026-10-04', frozenLoads: 0, ordersFromToday: 1, driverLinksFromToday: 0 },
      blockers: [],
    });
    state.role = 'SUPER_ADMIN';
    const run = await post(await okBody());
    expect(run.status).toBe(200);
    expect((await run.json()).data.removed).toMatchObject({ orders: 2, orderLines: 2, planVersions: 1, loads: 1, stops: 1, optimizationJobs: 1, uploadBatches: 1, lateOrders: 1 });
    expect(ordersOf('tA')).toEqual([]);
    expect(ordersOf('tB')).toEqual(['bo1', 'bo6']);
    const audit = tables.auditLog!.filter((a) => a.action === 'TEST_DATA_CLEARED');
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ tenantId: 'tA', userId: 'uA', entity: 'Tenant', entityId: 'tA', afterJson: { liveDataConfirmed: true } });
    // The audit log of the company is kept.
    expect(tables.auditLog!.filter((a) => a.tenantId === 'tA').map((a) => a.action)).toEqual(['LOGIN', 'TEST_DATA_CLEARED']);
  });
});

describe('the request', () => {
  it('only before a date: the preview and the run take it; a date that does not exist is refused', async () => {
    const res = await get('?before=2026-10-05');
    expect((await res.json()).data).toMatchObject({ before: '2026-10-05', removed: { orders: 1 }, live: { ordersFromToday: 0 } });
    expect((await get('?before=2026-02-31')).status).toBe(400);
    expect((await post({ ...(await okBody()), before: '2026-13-01' })).status).toBe(400);
    // Nothing live before the 5th: the extra tick is not needed.
    const run = await post({ ...(await okBody({ before: '2026-10-05' })), liveDataConfirmed: false });
    expect(run.status).toBe(200);
    expect(ordersOf('tA')).toEqual(['ao6']);
  });

  it('the typed company code must match: 400 CONFIRM_MISMATCH, nothing removed', async () => {
    const res = await post(await okBody({ confirm: 'b-co' }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatchObject({ code: 'CONFIRM_MISMATCH' });
    expect(ordersOf('tA')).toEqual(['ao1', 'ao6']);
    expect(ordersOf('tB')).toEqual(['bo1', 'bo6']);
  });

  it('the backup tick and the preview shown are required, and nothing else is accepted', async () => {
    const body = await okBody();
    expect((await post({ ...body, backupConfirmed: undefined })).status).toBe(400);
    expect((await post({ ...body, backupConfirmed: false })).status).toBe(400);
    expect((await post({ ...body, expect: undefined })).status).toBe(400);
    expect((await post({ ...body, tenantId: 'tB' })).status).toBe(400);
    expect(ordersOf('tA')).toEqual(['ao1', 'ao6']);
  });

  it("an admin of another company typing this company's code removes nothing here (only their own company is ever touched)", async () => {
    const body = await okBody();
    state.tenantId = 'tB';
    state.userId = 'uB';
    const res = await post(body);
    expect(res.status).toBe(400);
    expect(ordersOf('tA')).toEqual(['ao1', 'ao6']);
    expect(ordersOf('tB')).toEqual(['bo1', 'bo6']);
  });

  it('409 OPTIMIZATION_RUNNING while an optimization of the company is queued or running; the preview says why', async () => {
    tables.runJob!.push({ id: 'live', tenantId: 'tA', runId: 'ap2', status: 'RUNNING' });
    const preview = (await (await get()).json()).data;
    expect(preview.blockers.map((b: Row) => b.code)).toEqual(['OPTIMIZATION_RUNNING']);
    const res = await post(await okBody());
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatchObject({ code: 'OPTIMIZATION_RUNNING' });
    expect(ordersOf('tA')).toEqual(['ao1', 'ao6']);
  });

  it('409 PREVIEW_STALE when there is more to remove than the admin was shown (a real order file confirmed meanwhile): nothing removed', async () => {
    const body = await okBody();
    tables.order!.push({ id: 'areal', tenantId: 'tA', customerId: 'ac1', deliveryDate: day('2026-10-05'), uploadBatchId: null, isLate: false, carriedFromOrderId: null, carriedToOrderId: null });
    const res = await post(body);
    expect(res.status).toBe(409);
    const err = (await res.json()).error;
    expect(err).toMatchObject({ code: 'PREVIEW_STALE' });
    expect(err.error).toMatch(/Orders: 2 shown, now 3/);
    expect(err.error).toMatch(/Nothing was removed/);
    expect(ordersOf('tA')).toEqual(['ao1', 'ao6', 'areal']);
    expect(tables.auditLog!.filter((a) => a.action === 'TEST_DATA_CLEARED')).toEqual([]);
  });

  it('409 LIVE_DATA_CONFIRM without the extra tick when orders of today or later (or loads that left) would go: nothing removed', async () => {
    const res = await post({ ...(await okBody()), liveDataConfirmed: undefined });
    expect(res.status).toBe(409);
    const err = (await res.json()).error;
    expect(err).toMatchObject({ code: 'LIVE_DATA_CONFIRM' });
    expect(err.error).toMatch(/1 order dated today \(2026-10-04\) or later/);
    expect(ordersOf('tA')).toEqual(['ao1', 'ao6']);
  });

  it(`rate limited: ${START_FRESH_LIMITS.run.limit} attempts that reach the run per admin per 10 minutes (a mistyped code does not count), then 429 with a plain answer`, async () => {
    expect(START_FRESH_LIMITS.run).toEqual({ limit: 10, windowMs: 10 * 60_000 });
    const body = await okBody();
    for (let i = 0; i < 5; i++) expect((await post({ ...body, confirm: 'wrong' })).status).toBe(400);
    tables.runJob!.push({ id: 'live', tenantId: 'tA', runId: 'ap2', status: 'RUNNING' });
    for (let i = 0; i < START_FRESH_LIMITS.run.limit; i++) expect((await post(body)).status).toBe(409);
    const res = await post(body);
    expect(res.status).toBe(429);
    expect(Number(res.headers.get('retry-after'))).toBeGreaterThan(0);
    const err = (await res.json()).error;
    expect(err).toMatchObject({ code: 'TOO_MANY_ATTEMPTS' });
    expect(err.error).toMatch(/Too many attempts\. Wait \d+ minutes?, then check again\. Nothing was removed\./);
    expect(ordersOf('tA')).toEqual(['ao1', 'ao6']);
    // Another admin of the company is not locked out.
    state.userId = 'uA2';
    expect((await post(body)).status).toBe(409);
  });
});
