/**
 * Stabilization PR5:
 * - F23: one audit catalog - every event the code writes is in it, every load status has its
 *   LOAD_<status> event, the audit API filters exactly by it, refuses unknown filters (400) and
 *   reads from/to as Asia/Muscat days;
 * - L16: PlanError, RouteAdjustError and BatchRaceError are HttpErrors - an uncaught one answers
 *   its own status; any other error is a 500 that never leaks its message;
 * - F22: the legacy Map tab's geometry goes through the private solver only, and a dispatch plan
 *   is refused (409).
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { LoadStatus } from '@prisma/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ role: 'TENANT_ADMIN' as string, prismaFake: {} as Record<string, any>, db: {} as Record<string, any> }));
vi.mock('@/lib/auth', () => ({ auth: vi.fn(async () => ({ user: { id: 'me', tenantId: 'tA', role: state.role, name: 'Me', email: 'me@a.example' } })) }));
vi.mock('@/lib/db', () => ({ prisma: new Proxy(state.prismaFake, { get: (t, p: string) => (p === 'then' ? undefined : t[p]) }) }));
vi.mock('@/lib/tenant', () => ({ tenantDb: () => state.db }));
const prismaFake = state.prismaFake;
const db = state.db;

import { AUDIT_ACTIONS, AUDIT_ACTION_NAMES, AUDIT_ENTITY_NAMES, loadStatusAction } from '@/lib/audit-catalog';
import { handleError, HttpError } from '@/lib/api';
import { PlanError } from '@/lib/dispatch/plan-errors';
import { RouteAdjustError } from '@/lib/route-adjust';
import { zonedDayStart } from '@/lib/dispatch/time';

const WEB = path.resolve(__dirname, '../..');
const get = (url: string) => new Request(`http://localhost${url}`);

function files(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === '.next' || name === 'migrations') continue;
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) files(p, out);
    else if (/\.(ts|tsx)$/.test(name)) out.push(p);
  }
  return out;
}

beforeEach(() => {
  state.role = 'TENANT_ADMIN';
  for (const k of Object.keys(prismaFake)) delete prismaFake[k];
  for (const k of Object.keys(db)) delete db[k];
});

describe('audit catalog (review F23)', () => {
  it('every load status has its LOAD_<status> event', () => {
    for (const s of Object.values(LoadStatus)) {
      expect(AUDIT_ACTION_NAMES, s).toContain(`LOAD_${s}`);
      expect(loadStatusAction(s)).toBe(`LOAD_${s}`);
    }
  });

  it('every action literal written in the code is in the catalog', () => {
    const written = new Set<string>();
    for (const f of [...files(path.join(WEB, 'app')), ...files(path.join(WEB, 'lib')), ...files(path.join(WEB, 'prisma'))]) {
      const src = readFileSync(f, 'utf8');
      if (!/audit/i.test(src)) continue;
      for (const m of src.matchAll(/action:\s*'([A-Z][A-Z_]+)'/g)) written.add(m[1]!);
    }
    expect(written.size).toBeGreaterThan(10);
    for (const a of written) expect(AUDIT_ACTIONS, a).toHaveProperty(a);
  });

  it('the old names stay filterable and are marked legacy', () => {
    expect(AUDIT_ACTIONS.DRIVER_LOGIN).toMatchObject({ legacy: true });
    expect(AUDIT_ACTIONS.LOGOUT).toMatchObject({ legacy: true });
    expect(AUDIT_ENTITY_NAMES).toContain('PlanLoad');
    expect(AUDIT_ENTITY_NAMES).toContain('PasswordResetToken');
  });
});

describe('GET /api/audit (review F23)', () => {
  function wire() {
    db.auditLog = { findMany: vi.fn(async () => []) };
    db.tenantConfig = { findUnique: vi.fn(async () => ({ timezone: 'Asia/Muscat' })) };
  }

  it('every catalog action filters exactly by it', async () => {
    wire();
    const route = await import('@/app/api/audit/route');
    for (const a of AUDIT_ACTION_NAMES) {
      const res = await route.GET(get(`/api/audit?action=${a}`));
      expect(res.status, a).toBe(200);
      expect(db.auditLog.findMany.mock.lastCall![0].where).toEqual({ action: a });
    }
    await route.GET(get('/api/audit?entity=PlanLoad&action=LOAD_LOCKED'));
    expect(db.auditLog.findMany.mock.lastCall![0].where).toEqual({ action: 'LOAD_LOCKED', entity: 'PlanLoad' });
  });

  it('an unknown action, entity or date is refused (400), never answered with every row', async () => {
    wire();
    const route = await import('@/app/api/audit/route');
    for (const q of ['action=LOAD_DISPACHED', 'entity=Nope', 'from=2026-02-31', 'from=yesterday', 'userId=a%20b', 'limit=0', 'color=red']) {
      const res = await route.GET(get(`/api/audit?${q}`));
      expect(res.status, q).toBe(400);
      const body = await res.json();
      expect(body.error.code, q).toBe('INVALID_FILTER');
    }
    expect(db.auditLog.findMany).not.toHaveBeenCalled();
  });

  it('from / to are Asia/Muscat days', async () => {
    wire();
    const route = await import('@/app/api/audit/route');
    await route.GET(get('/api/audit?from=2026-09-25&to=2026-09-25'));
    const where = db.auditLog.findMany.mock.lastCall![0].where;
    expect(where.createdAt.gte.toISOString()).toBe('2026-09-24T20:00:00.000Z');
    expect(where.createdAt.lt.toISOString()).toBe('2026-09-25T20:00:00.000Z');
    expect(zonedDayStart('2026-09-25', 'UTC').toISOString()).toBe('2026-09-25T00:00:00.000Z');
  });

  it('passes the asked limit, and is TENANT_ADMIN only', async () => {
    wire();
    const route = await import('@/app/api/audit/route');
    await route.GET(get('/api/audit?limit=500'));
    expect(db.auditLog.findMany.mock.lastCall![0].take).toBe(500);
    state.role = 'VIEWER';
    expect((await route.GET(get('/api/audit'))).status).toBe(403);
  });
});

describe('error contract (review L16)', () => {
  it('a PlanError / RouteAdjustError answers its own status and code', async () => {
    const plan = handleError(new PlanError('Customer C1 is inactive.', 409, { code: 'CUSTOMER_INACTIVE' }));
    expect(plan.status).toBe(409);
    expect((await plan.json()).error).toEqual({ error: 'Customer C1 is inactive.', code: 'CUSTOMER_INACTIVE' });
    expect(new PlanError('x')).toBeInstanceOf(HttpError);
    const adj = handleError(new RouteAdjustError('Assignment is locked. Unlock before moving.', 409));
    expect(adj.status).toBe(409);
    expect((await adj.json()).error).toBe('Assignment is locked. Unlock before moving.');
  });

  it('a plain Error is a 500 that does not leak its message', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const res = handleError(new Error('connection string postgres://secret@db'));
    expect(res.status).toBe(500);
    const text = await res.text();
    expect(text).toContain('Internal server error');
    expect(text).not.toContain('secret');
    spy.mockRestore();
  });

  it('a refusal thrown by the plan service needs no try/catch in the route', async () => {
    vi.resetModules();
    vi.doMock('@/lib/dispatch/plan-service', async (orig) => {
      // The PlanError of the freshly loaded modules (the route's lib/api is fresh too).
      const { PlanError: FreshPlanError } = await import('@/lib/dispatch/plan-errors');
      return {
        ...(await orig<typeof import('@/lib/dispatch/plan-service')>()),
        chooseScenario: vi.fn(async () => {
          throw new FreshPlanError('Loads of this version are already locked.', 409, { code: 'LOADS_LOCKED' });
        }),
      };
    });
    const route = await import('@/app/api/runs/[id]/choose-scenario/route');
    state.role = 'PLANNER';
    const res = await route.POST(new Request('http://localhost/x', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ scenarioId: 's1' }) }), { params: { id: 'r1' } });
    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe('LOADS_LOCKED');
    vi.doUnmock('@/lib/dispatch/plan-service');
    vi.resetModules();
  });
});

describe('GET /api/runs/[id]/route-geometries (review F22)', () => {
  const fetchSpy = vi.fn();
  const env = { url: process.env.SOLVER_URL, token: process.env.SOLVER_TOKEN };

  function wireRun(dispatchPlan: boolean) {
    db.runPlan = {
      findUnique: vi.fn(async () => ({
        id: 'r1',
        depot: { lat: 23.58, lng: 58.39 },
        routes: [
          { truckId: 't1', sequenceInTruck: 1, truck: { id: 't1', code: 'T01' }, order: { customer: { lat: 23.6, lng: 58.45 } } },
          { truckId: 't1', sequenceInTruck: 2, truck: { id: 't1', code: 'T01' }, order: { customer: { lat: 23.62, lng: 58.47 } } },
        ],
      })),
    };
    db.tenantConfig = { findUnique: vi.fn(async () => ({ osrmUrl: null })) };
    prismaFake.runPlan = { findFirst: vi.fn(async () => (dispatchPlan ? { id: 'r1' } : null)) };
  }

  beforeEach(() => {
    fetchSpy.mockReset();
    vi.stubGlobal('fetch', fetchSpy);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    process.env.SOLVER_URL = env.url;
    process.env.SOLVER_TOKEN = env.token;
  });

  it('a dispatch plan answers 409 (its map is per load)', async () => {
    wireRun(true);
    const route = await import('@/app/api/runs/[id]/route-geometries/route');
    const res = await route.GET(get('/api/runs/r1/route-geometries'), { params: { id: 'r1' } });
    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe('USE_LOAD_GEOMETRY');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('a legacy run asks only the private solver (never a routing service directly)', async () => {
    wireRun(false);
    process.env.SOLVER_URL = 'http://solver.internal:8000';
    process.env.SOLVER_TOKEN = 'unit-test-token';
    fetchSpy.mockResolvedValue(new Response(JSON.stringify({ provider: 'OSRM', is_estimated: false, coordinates: [[58.39, 23.58], [58.45, 23.6]] }), { status: 200 }));
    const route = await import('@/app/api/runs/[id]/route-geometries/route');
    const res = await route.GET(get('/api/runs/r1/route-geometries'), { params: { id: 'r1' } });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.provider).toBe('osrm');
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    for (const [url] of fetchSpy.mock.calls) expect(String(url)).toMatch(/^http:\/\/solver\.internal:8000\/route-geometry$/);
  });

  it('without the solver: straight lines and no outbound call at all', async () => {
    wireRun(false);
    delete process.env.SOLVER_URL;
    const route = await import('@/app/api/runs/[id]/route-geometries/route');
    const res = await route.GET(get('/api/runs/r1/route-geometries'), { params: { id: 'r1' } });
    const body = await res.json();
    expect(body.data.provider).toBe('fallback');
    expect(body.data.trucks[0].coordinates).toHaveLength(4);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
