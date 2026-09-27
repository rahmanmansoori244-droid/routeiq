/**
 * AUDIT PR4 "Recovery, races, readiness" ON REAL POSTGRESQL (library level: the web server and the
 * solver are not used; the optimizer and next-auth's session are faked in this process).
 * Needs DATABASE_URL (migrated). Each group reproduces the verifiers' own schedule of the
 * 27 Sep 2026 audit (.dev/audit-verify/{authv2,auth-v1,lifecycle1,lifecyclev2}) and asserts the
 * fixed outcome; each one fails on the code before the fix.
 *
 * Interleavings are forced with a Prisma query extension that pauses a chosen model operation (a
 * barrier) without changing what it does - installed as the application's client (lib/db.ts
 * honours globalThis.__prisma), so the real routes and helpers run unmodified. Faults are real
 * PostgreSQL errors raised by a temporary trigger on one row. Postgres does all the locking.
 *
 *  - F10: a reset link used while an admin resets the same user - the retired link never
 *    overwrites the admin's password, a newer link is not killed, and the two never deadlock;
 *  - F11: two admins deactivating or demoting each other at the same instant always leave one
 *    active admin;
 *  - F09: the janitor's writes fail together (a stranded plan cannot be created), a plan stranded
 *    before the fix is repaired by the sweep, a retry of OPTIMIZE / RE-PLAN starts real work, the
 *    job failure is one transaction, and "Reset stuck plan" is serialized by the plan row lock;
 *  - F21: a plan read or an Excel export racing "Use instead" returns one revision (summary,
 *    chosen option, loads and reconciliation agree), and the read stays tenant-scoped.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { PrismaClient } from '@prisma/client';
import type { DispatchRequest, DispatchResponse, DispatchScenario, PlannedLoad } from '@routeiq/shared-types';
import { cleanupTenant, prisma, uniqueSuffix } from './helpers';

// ---------------------------------------------------------------------------------------------
// Fakes: the session (per call) and the optimizer.

const m = vi.hoisted(() => ({
  auth: vi.fn(),
  hashPassword: vi.fn(async (plain: string) => `ADMIN_TEMP:${plain}`),
}));
vi.mock('@/lib/auth', () => m);

const solver = vi.hoisted(() => ({ calls: 0 }));
vi.mock('@/lib/solver-client', () => {
  class SolverError extends Error {
    constructor(
      message: string,
      public status = 0,
      public responseBody: unknown = null,
    ) {
      super(message);
    }
  }
  /** Stop i on truck i % n; RECOMMENDED 12 km / 2.5 OMR per load, MIN_DISTANCE 25 km / 5 OMR, 30 min later. */
  function loadsFor(req: DispatchRequest, km: number, cost: number, shift: number): PlannedLoad[] {
    const frozenNos = new Map(req.trucks.map((t) => [t.id, (t.frozen_trips ?? []).length]));
    return req.stops.map((s, i) => {
      const truck = req.trucks[i % req.trucks.length]!;
      const loadNo = (frozenNos.get(truck.id) ?? 0) + Math.floor(i / req.trucks.length) + 1;
      const depart = 360 + loadNo * 150 + shift;
      return {
        truck_id: truck.id, load_no: loadNo, depart_min: depart, return_min: depart + 90, distance_km: km, duration_min: 90,
        cases: s.demand_cases, kg: s.demand_kg ?? 0, utilization_pct: 10, fuel_litres: 2, fuel_cost: 0.5, distance_cost: 1, time_cost: 1,
        fixed_cost: 0, total_cost: cost, return_leg_km: km / 2,
        stops: [
          { sequence: 1, stop_id: s.stop_id, order_ids: s.order_ids, customer_id: s.customer_id, arrival_min: depart + 20, service_start_min: depart + 20, departure_min: depart + 40, wait_min: 0, leg_km: km / 2, cum_km: km / 2, leg_min: 20, cases: s.demand_cases, kg: s.demand_kg ?? 0, hard_window_ok: true, pref_window_ok: true },
        ],
      } as PlannedLoad;
    });
  }
  function scenario(name: string, loads: PlannedLoad[]): DispatchScenario {
    return {
      name, status: 'OPTIMIZED', solver_status: 'ROUTING_SUCCESS', solver_time_sec: 0.1, time_limit_sec: 5, objective_value: 1,
      objective: { unserved_penalty: 0, fixed_cost: 0, distance_cost: 0, fuel_cost: 0, time_cost: 0, overtime_cost: 0, window_penalty: 0, margin_served: null },
      trucks_used: new Set(loads.map((l) => l.truck_id)).size, trips: loads.length,
      total_distance_km: loads.reduce((a, l) => a + l.distance_km, 0), total_duration_min: loads.length * 90,
      total_cases: loads.reduce((a, l) => a + l.cases, 0), total_kg: 0, avg_utilization_pct: 10, fuel_litres: 0, fuel_cost: 0,
      operating_cost: loads.reduce((a, l) => a + l.total_cost, 0), loads, unserved: [], warnings: [],
    } as unknown as DispatchScenario;
  }
  return {
    SolverError,
    callDispatchSolver: vi.fn(async (req: DispatchRequest): Promise<DispatchResponse> => {
      solver.calls++;
      const a = scenario('RECOMMENDED', loadsFor(req, 12, 2.5, 0));
      const b = scenario('MIN_DISTANCE', loadsFor(req, 25, 5, 30));
      return { run_id: req.run_id, engine: 'test', matrix_provider: 'HAVERSINE', distance_is_estimated: true, scenarios: [a, b], warnings: [] } as DispatchResponse;
    }),
    callRouteGeometry: vi.fn(async () => ({ kind: 'not_configured' })),
  };
});

// ---------------------------------------------------------------------------------------------
// The application's client with barriers.

type Hook = { before?: () => Promise<void>; after?: () => Promise<void> };
const hooks = new Map<string, Hook>();
const appBase = new PrismaClient();
const appClient = appBase.$extends({
  name: 'raceBarrier',
  query: {
    $allModels: {
      async $allOperations({ model, operation, args, query }) {
        const h = hooks.get(`${model}.${operation}`);
        if (h?.before) await h.before();
        const r = await query(args);
        if (h?.after) await h.after();
        return r;
      },
    },
  },
});
/** Pause the next `model.operation` once, before or after it runs, until released. */
function barrier(key: string, when: 'before' | 'after') {
  const reached = deferred();
  const release = deferred();
  hooks.set(key, {
    [when]: async () => {
      hooks.delete(key);
      reached.resolve();
      await release.promise;
    },
  });
  return { reached: reached.promise, release: () => release.resolve() };
}

function deferred<T = void>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** True once a backend of this database waits on a row lock of these tables (up to `ms`). */
async function someoneWaitsOnLock(ms = 3000): Promise<boolean> {
  for (let t = 0; t < ms; t += 25) {
    const rows = await prisma.$queryRaw<Array<{ n: bigint }>>`
      SELECT count(*)::bigint AS n FROM pg_stat_activity
      WHERE datname = current_database() AND wait_event_type = 'Lock'
        AND (query LIKE '%"User"%' OR query LIKE '%"PasswordResetToken"%' OR query LIKE '%"Tenant"%' OR query LIKE '%"RunPlan"%')`;
    if (Number(rows[0]?.n ?? 0) > 0) return true;
    await sleep(25);
  }
  return false;
}

// ---------------------------------------------------------------------------------------------
// Modules under test, imported after the barrier client is installed.

/* eslint-disable @typescript-eslint/consistent-type-imports */
let pr: typeof import('@/lib/password-reset');
let resetRoute: typeof import('@/app/api/users/[id]/reset-password/route');
let userRoute: typeof import('@/app/api/users/[id]/route');
let planService: typeof import('@/lib/dispatch/plan-service');
let planDetail: typeof import('@/lib/dispatch/plan-detail');
let start: typeof import('@/lib/dispatch/start-optimize');
let jobs: typeof import('@/lib/jobs/optimize-job');
let dispatchJob: typeof import('@/lib/jobs/dispatch-job');
let resetStuckRoute: typeof import('@/app/api/runs/[id]/reset-stuck/route');
let exportRoute: typeof import('@/app/api/runs/[id]/export/excel/route');
/* eslint-enable @typescript-eslint/consistent-type-imports */

const g = globalThis as unknown as { __prisma?: unknown; __routeiqInflight?: Map<string, Promise<void>> };
const previousClient = g.__prisma;
const slugs: string[] = [];
const triggers: string[] = [];

beforeAll(async () => {
  g.__prisma = appClient;
  pr = await import('@/lib/password-reset');
  resetRoute = await import('@/app/api/users/[id]/reset-password/route');
  userRoute = await import('@/app/api/users/[id]/route');
  planService = await import('@/lib/dispatch/plan-service');
  planDetail = await import('@/lib/dispatch/plan-detail');
  start = await import('@/lib/dispatch/start-optimize');
  jobs = await import('@/lib/jobs/optimize-job');
  dispatchJob = await import('@/lib/jobs/dispatch-job');
  resetStuckRoute = await import('@/app/api/runs/[id]/reset-stuck/route');
  exportRoute = await import('@/app/api/runs/[id]/export/excel/route');
});

afterAll(async () => {
  hooks.clear();
  for (const t of triggers) {
    await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS ${t} ON "RunPlan"`).catch(() => undefined);
    await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS ${t} ON "AuditLog"`).catch(() => undefined);
    await prisma.$executeRawUnsafe(`DROP FUNCTION IF EXISTS ${t}()`).catch(() => undefined);
  }
  for (const s of slugs) await cleanupTenant(s);
  if (previousClient === undefined) delete g.__prisma;
  else g.__prisma = previousClient;
  await appBase.$disconnect();
  await prisma.$disconnect();
});

// ---------------------------------------------------------------------------------------------
// Seeding.

type Role = 'TENANT_ADMIN' | 'SUPERVISOR' | 'PLANNER' | 'VIEWER';
type U = { id: string; tenantId: string | null; role: string; name: string; email: string };

let seq = 0;
async function mkTenant(label: string) {
  const slug = `a4-${label}-${uniqueSuffix()}`.toLowerCase().slice(0, 32);
  slugs.push(slug);
  const t = await prisma.tenant.create({ data: { slug, name: `A4 ${label}`, country: 'Oman' } });
  await prisma.tenantConfig.create({ data: { tenantId: t.id, timezone: 'Asia/Muscat', distanceProvider: 'HAVERSINE', osrmUrl: null } });
  return t;
}
async function mkUser(tenantId: string, role: Role, label: string): Promise<U> {
  return prisma.user.create({
    data: { tenantId, role, name: label, email: `${label}-${Date.now().toString(36)}-${seq++}@a4.test`.toLowerCase(), passwordHash: 'ORIGINAL' },
    select: { id: true, tenantId: true, role: true, name: true, email: true },
  });
}
const sessionOf = (u: U) => ({ user: { id: u.id, tenantId: u.tenantId, role: u.role, name: u.name, email: u.email } });
const send = (url: string, method: string, body?: unknown) =>
  new Request(`http://localhost${url}`, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
const hashOf = async (id: string) => (await prisma.user.findUniqueOrThrow({ where: { id } })).passwordHash;

async function adminReset(admin: U, targetId: string) {
  m.auth.mockResolvedValueOnce(sessionOf(admin));
  const res = await resetRoute.POST(send(`/api/users/${targetId}/reset-password`, 'POST'), { params: { id: targetId } });
  const body = (await res.json()) as { data?: { tempPassword?: string } };
  return { status: res.status, tempPassword: body.data?.tempPassword ?? null };
}

// =============================================================================================
describe('F10: a reset link used while an admin resets the same user (real PostgreSQL)', () => {
  async function setup(label: string) {
    const t = await mkTenant(label);
    const admin = await mkUser(t.id, 'TENANT_ADMIN', `${label}-admin`);
    const target = await mkUser(t.id, 'PLANNER', `${label}-user`);
    const link = await pr.createResetTokenForEmail(target.email);
    expect(link.status).toBe('created');
    return { admin, target, raw: link.rawToken! };
  }

  it('control: a link retired before it is used is refused', async () => {
    const { admin, target, raw } = await setup('f10c');
    const a = await adminReset(admin, target.id);
    expect(a.status).toBe(200);
    expect(await pr.resetPasswordWithToken(raw, 'LINK_HASH')).toEqual({ ok: false, reason: 'used' });
    expect(await hashOf(target.id)).toBe(`ADMIN_TEMP:${a.tempPassword}`);
  });

  it("the auditor's schedule: the admin reset commits after the link was read - the link is refused, the admin's password stays", async () => {
    const { admin, target, raw } = await setup('f10a');
    const b = barrier('PasswordResetToken.findUnique', 'after');
    const consuming = pr.resetPasswordWithToken(raw, 'LINK_HASH');
    await b.reached; // the link was read as unused; its transaction is open
    const a = await adminReset(admin, target.id); // commits: new password, the link retired
    expect(a.status).toBe(200);
    b.release();
    expect(await consuming).toEqual({ ok: false, reason: 'used' });
    expect(await hashOf(target.id)).toBe(`ADMIN_TEMP:${a.tempPassword}`);
  });

  it('overlap: the admin reset holds the user and has retired the link - the link waits for it, then is refused', async () => {
    const { admin, target, raw } = await setup('f10b');
    const b = barrier('AuditLog.create', 'before'); // pauses the admin transaction after its writes
    const admin$ = adminReset(admin, target.id);
    await b.reached;
    const consuming = pr.resetPasswordWithToken(raw, 'LINK_HASH');
    expect(await someoneWaitsOnLock()).toBe(true); // the link waits behind the admin's lock
    b.release();
    const a = await admin$;
    expect(a.status).toBe(200);
    expect(await consuming).toEqual({ ok: false, reason: 'used' });
    expect(await hashOf(target.id)).toBe(`ADMIN_TEMP:${a.tempPassword}`);
  });

  it('the verifiers\' deadlock: the link holds its lock while the admin reset starts - no deadlock, both finish, the admin (last) wins', async () => {
    const { admin, target, raw } = await setup('f10d');
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {});
    const b = barrier('PasswordResetToken.deleteMany', 'after'); // the link consumed, its transaction still open
    const consuming = pr.resetPasswordWithToken(raw, 'LINK_HASH');
    await b.reached;
    const admin$ = adminReset(admin, target.id);
    await someoneWaitsOnLock(); // the admin reset queues behind the link
    b.release();
    const [linkResult, a] = await Promise.all([consuming, admin$]);
    quiet.mockRestore();
    expect(linkResult.ok).toBe(true); // committed first
    expect(a.status).toBe(200); // then the admin reset: not a deadlock victim (500)
    expect(await hashOf(target.id)).toBe(`ADMIN_TEMP:${a.tempPassword}`);
  });

  it('a newer link issued while an older one is being used: the older is refused, the newer still works', async () => {
    const { target, raw } = await setup('f10n');
    const b = barrier('PasswordResetToken.findUnique', 'after');
    const consuming = pr.resetPasswordWithToken(raw, 'OLD_LINK_HASH');
    await b.reached;
    const newer = await pr.createResetTokenForEmail(target.email);
    expect(newer.status).toBe('created');
    b.release();
    expect(await consuming).toEqual({ ok: false, reason: 'used' });
    expect(await hashOf(target.id)).toBe('ORIGINAL');
    expect(await pr.resetTokenUsable(newer.rawToken!)).toBe(true);
    expect((await pr.resetPasswordWithToken(newer.rawToken!, 'NEW_LINK_HASH')).ok).toBe(true);
    expect(await hashOf(target.id)).toBe('NEW_LINK_HASH');
  });

  it('natural timing (no barrier): the link never overwrites a committed admin reset, and nothing deadlocks', async () => {
    const t = await mkTenant('f10x');
    const admin = await mkUser(t.id, 'TENANT_ADMIN', 'f10x-admin');
    const outcomes: string[] = [];
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {});
    for (let i = 0; i < 16; i++) {
      const u = await mkUser(t.id, 'PLANNER', `f10x-u${i}`);
      const link = await pr.createResetTokenForEmail(u.email);
      const lead = (i % 4) - 1; // -1..2 ms
      let a$: ReturnType<typeof adminReset>;
      let l$: ReturnType<typeof pr.resetPasswordWithToken>;
      if (lead >= 0) {
        a$ = adminReset(admin, u.id);
        await sleep(lead);
        l$ = pr.resetPasswordWithToken(link.rawToken!, 'LINK_HASH');
      } else {
        l$ = pr.resetPasswordWithToken(link.rawToken!, 'LINK_HASH');
        await sleep(1);
        a$ = adminReset(admin, u.id);
      }
      const [a, l] = await Promise.all([a$, l$]);
      const final = await hashOf(u.id);
      if (a.status !== 200 || (!l.ok && l.reason === 'invalid')) outcomes.push('error-or-deadlock');
      else if (final !== `ADMIN_TEMP:${a.tempPassword}` && final !== 'LINK_HASH') outcomes.push('other');
      // A link that went through must have committed BEFORE the admin reset (which then wins); a
      // link password left at the end means it overwrote the admin's reset (the F10 fault).
      else if (l.ok && final === 'LINK_HASH') outcomes.push('link-overwrote-admin');
      else outcomes.push('ok');
    }
    quiet.mockRestore();
    expect(outcomes.filter((o) => o !== 'ok')).toEqual([]);
  });
});

// =============================================================================================
describe('F11: two admins deactivating or demoting each other at the same instant (real PostgreSQL)', () => {
  const patch = async (actor: U, id: string, body: unknown) => {
    m.auth.mockResolvedValueOnce(sessionOf(actor));
    const res = await userRoute.PATCH(send(`/api/users/${id}`, 'PATCH', body), { params: { id } });
    return res.status;
  };
  const activeAdmins = (tenantId: string) => prisma.user.count({ where: { tenantId, active: true, role: { in: ['TENANT_ADMIN', 'SUPER_ADMIN'] } } });

  /** Holds each request after its admin count until the other one has counted too (or 600 ms). */
  function bothCountFirst() {
    let arrivals = 0;
    const both = deferred();
    hooks.set('User.count', {
      after: async () => {
        if (++arrivals >= 2) both.resolve();
        await Promise.race([both.promise, sleep(600)]);
      },
    });
    return () => hooks.delete('User.count');
  }

  it('control: one after the other, the second is refused (400)', async () => {
    const t = await mkTenant('f11c');
    const a = await mkUser(t.id, 'TENANT_ADMIN', 'f11c-a');
    const b = await mkUser(t.id, 'TENANT_ADMIN', 'f11c-b');
    expect(await patch(a, b.id, { active: false })).toBe(200);
    expect(await patch(a, a.id, { active: false })).toBe(400);
    expect(await activeAdmins(t.id)).toBe(1);
  });

  it("the auditors' barrier - both counts before either update: deactivation keeps one admin", async () => {
    const t = await mkTenant('f11r');
    const a = await mkUser(t.id, 'TENANT_ADMIN', 'f11r-a');
    const b = await mkUser(t.id, 'TENANT_ADMIN', 'f11r-b');
    const off = bothCountFirst();
    const statuses = await Promise.all([patch(a, b.id, { active: false }), patch(b, a.id, { active: false })]);
    off();
    expect([...statuses].sort()).toEqual([200, 400]);
    expect(await activeAdmins(t.id)).toBe(1);
    // Each change that went through has its audit row; the refused one wrote nothing.
    expect(await prisma.auditLog.count({ where: { tenantId: t.id, entity: 'User', action: 'UPDATE' } })).toBe(1);
  });

  it('the same barrier with demotions (A demotes B while B demotes A) keeps one admin', async () => {
    const t = await mkTenant('f11d');
    const a = await mkUser(t.id, 'TENANT_ADMIN', 'f11d-a');
    const b = await mkUser(t.id, 'TENANT_ADMIN', 'f11d-b');
    const off = bothCountFirst();
    const statuses = await Promise.all([patch(a, b.id, { role: 'PLANNER' }), patch(b, a.id, { role: 'PLANNER' })]);
    off();
    expect([...statuses].sort()).toEqual([200, 400]);
    expect(await activeAdmins(t.id)).toBe(1);
  });

  it('natural timing (no barrier): never a company without an active admin', async () => {
    let zero = 0;
    for (let i = 0; i < 8; i++) {
      const t = await mkTenant(`f11n${i}`);
      const a = await mkUser(t.id, 'TENANT_ADMIN', `f11n${i}-a`);
      const b = await mkUser(t.id, 'TENANT_ADMIN', `f11n${i}-b`);
      await Promise.all([patch(a, b.id, { active: false }), patch(b, a.id, { active: false })]);
      if ((await activeAdmins(t.id)) === 0) zero++;
    }
    expect(zero).toBe(0);
  });
});

// =============================================================================================
// Dispatch fixtures (F09, F21).

function isoPlus(n: number) {
  const d = new Date(Date.now() + 4 * 3600_000);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

async function dispatchTenant(label: string) {
  const t = await mkTenant(label);
  const admin = await mkUser(t.id, 'TENANT_ADMIN', `${label}-admin`);
  const supervisor = await mkUser(t.id, 'SUPERVISOR', `${label}-sup`);
  const depot = await prisma.depot.create({ data: { tenantId: t.id, code: 'MCT', name: 'Muscat', lat: 23.568, lng: 58.392 } });
  for (const code of ['T01', 'T02']) {
    await prisma.truck.create({ data: { tenantId: t.id, depotId: depot.id, code, capacityCases: 200, capacityWeightKg: 3000, fixedCostPerDay: 20, costPerKm: 0.1 } });
  }
  const product = await prisma.product.create({ data: { tenantId: t.id, code: 'W-500', name: 'Water 500ml', weightPerCaseKg: 10 } });
  const customers: string[] = [];
  for (const [code, lat, lng] of [['C1', 23.588, 58.41], ['C2', 23.6, 58.372], ['C3', 23.555, 58.335], ['C4', 23.61, 58.45]] as const) {
    customers.push((await prisma.customer.create({ data: { tenantId: t.id, code, name: code, branchKey: '__MAIN__', lat, lng, geocodeConfidence: 'HIGH', locationVerified: true, priority: 3, priorityConfirmed: true } })).id);
  }
  const orders = async (day: string, n: number) => {
    for (let i = 0; i < n; i++) {
      await prisma.order.create({
        data: {
          tenantId: t.id, customerId: customers[i % customers.length]!, depotId: depot.id, deliveryDate: new Date(`${day}T00:00:00.000Z`),
          totalCases: 10, totalWeightKg: 100, status: 'VALIDATED', priority: 3,
          lines: { create: [{ productId: product.id, cases: 10, weightKg: 100, salesOrderNo: `SO-${day}-${i}` }] },
        },
      });
    }
  };
  return { tenantId: t.id, admin, supervisor, depotId: depot.id, orders };
}

async function jobsDone(runId: string) {
  for (let i = 0; i < 100; i++) {
    const p = g.__routeiqInflight?.get(runId);
    if (p) await p.catch(() => undefined);
    const run = await prisma.runPlan.findUniqueOrThrow({ where: { id: runId } });
    if (run.status !== 'OPTIMIZING') return run;
    await sleep(50);
  }
  throw new Error(`plan ${runId} still optimizing`);
}

/** A plan optimized to READY (two options: RECOMMENDED and a different MIN_DISTANCE). */
async function readyPlan(h: Awaited<ReturnType<typeof dispatchTenant>>, dayOffset: number) {
  const day = isoPlus(dayOffset);
  await h.orders(day, 4);
  const { run } = await planService.getOrCreatePlan(h.tenantId, h.depotId, day, h.admin.id);
  expect((await start.startDispatchOptimize(h.tenantId, run.id, { id: h.admin.id }, null)).status).toBe(202);
  expect((await jobsDone(run.id)).status).toBe('READY');
  return run.id;
}

/** The F09 state: the plan OPTIMIZING, its current job already FAILED (what the old janitor left). */
async function strand(tenantId: string, runId: string, userId: string) {
  const attempt = (await prisma.runJob.count({ where: { runId } })) + 1;
  const job = await prisma.runJob.create({
    data: { tenantId, runId, attemptNo: attempt, status: 'FAILED', createdById: userId, finishedAt: new Date(Date.now() - 10 * 60_000), message: 'No result after 15 minutes', errorJson: { reason: 'STUCK' } },
  });
  await prisma.runPlan.update({ where: { id: runId }, data: { status: 'OPTIMIZING', currentJobId: job.id } });
  return job.id;
}

/** A temporary trigger that raises a real PostgreSQL error on one row (dropped in afterAll). */
async function faultOn(table: 'RunPlan' | 'AuditLog', condition: string) {
  const name = `a4_fault_${Date.now().toString(36)}_${seq++}`;
  triggers.push(name);
  await prisma.$executeRawUnsafe(`CREATE FUNCTION ${name}() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'a4: injected transient failure'; END $$ LANGUAGE plpgsql`);
  await prisma.$executeRawUnsafe(`CREATE TRIGGER ${name} BEFORE ${table === 'RunPlan' ? 'UPDATE' : 'INSERT'} ON "${table}" FOR EACH ROW WHEN (${condition}) EXECUTE FUNCTION ${name}()`);
  return async () => {
    await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS ${name} ON "${table}"`);
  };
}
const safeId = (id: string) => {
  if (!/^[a-z0-9]+$/i.test(id)) throw new Error(`unexpected id ${id}`);
  return id;
};

// =============================================================================================
describe('F09: a plan can no longer be stranded on "optimizing" (real PostgreSQL)', () => {
  it("the janitor's writes fail together: a failed plan write leaves job and plan as they were; the next sweep reaps both", async () => {
    const h = await dispatchTenant('f09j');
    const day = isoPlus(2);
    const run = await prisma.runPlan.create({ data: { tenantId: h.tenantId, depotId: h.depotId, runDate: new Date(`${day}T00:00:00.000Z`), status: 'OPTIMIZING', createdById: h.admin.id } });
    const job = await prisma.runJob.create({ data: { tenantId: h.tenantId, runId: run.id, attemptNo: 1, status: 'RUNNING', createdById: h.admin.id } });
    await prisma.runPlan.update({ where: { id: run.id }, data: { currentJobId: job.id } });
    await prisma.$executeRawUnsafe(`UPDATE "RunJob" SET "startedAt" = NOW() - INTERVAL '20 minutes' WHERE id = $1`, job.id);
    const heal = await faultOn('RunPlan', `OLD.id = '${safeId(run.id)}' AND NEW.status::text = 'FAILED'`);

    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {});
    await jobs.reapStuckJobs();
    quiet.mockRestore();
    // The plan write failed: the job write rolled back with it (before the fix: job FAILED, plan
    // OPTIMIZING for ever, ignored by every later sweep).
    expect((await prisma.runJob.findUniqueOrThrow({ where: { id: job.id } })).status).toBe('RUNNING');
    expect((await prisma.runPlan.findUniqueOrThrow({ where: { id: run.id } })).status).toBe('OPTIMIZING');
    expect(await prisma.auditLog.count({ where: { tenantId: h.tenantId, action: 'OPTIMIZE_FAILED' } })).toBe(0);

    await heal(); // the database is healthy again
    await jobs.reapStuckJobs();
    expect((await prisma.runJob.findUniqueOrThrow({ where: { id: job.id } })).status).toBe('FAILED');
    expect((await prisma.runPlan.findUniqueOrThrow({ where: { id: run.id } })).status).toBe('FAILED');
    const rows = await prisma.auditLog.findMany({ where: { tenantId: h.tenantId, action: 'OPTIMIZE_FAILED' } });
    expect(rows.map((r) => (r.afterJson as { reason?: string }).reason)).toEqual(['STUCK']);
  });

  it('a plan stranded before the fix (OPTIMIZING behind a FAILED job) is repaired by the next sweep, audited', async () => {
    const h = await dispatchTenant('f09s');
    const runId = await readyPlan(h, 3);
    const dead = await strand(h.tenantId, runId, h.admin.id);
    // (A running web server's own janitor may do this sweep first: the end state is the same.)
    await jobs.reapStuckJobs();
    const plan = await prisma.runPlan.findUniqueOrThrow({ where: { id: runId } });
    expect(plan.status).toBe('FAILED');
    expect(plan.chosenScenarioId).toBeTruthy(); // its plan is kept, usable
    const row = await prisma.auditLog.findFirstOrThrow({ where: { tenantId: h.tenantId, action: 'OPTIMIZE_FAILED', entityId: runId } });
    expect(row.afterJson).toMatchObject({ reason: 'STUCK_PLAN', runJobId: dead, jobStatus: 'FAILED', repairedBy: 'JANITOR' });
  });

  it('OPTIMIZE on a stranded first version starts a new job and plans (never 202 with the dead job)', async () => {
    const h = await dispatchTenant('f09o');
    const day = isoPlus(4);
    await h.orders(day, 4);
    const { run } = await planService.getOrCreatePlan(h.tenantId, h.depotId, day, h.admin.id);
    const dead = await strand(h.tenantId, run.id, h.admin.id);
    const calls = solver.calls;
    const res = await start.startDispatchOptimize(h.tenantId, run.id, { id: h.admin.id }, null);
    expect(res.status).toBe(202);
    expect(res.body.runJobId).not.toBe(dead);
    expect(res.body.status).toBe('QUEUED');
    const done = await jobsDone(run.id);
    expect(done.status).toBe('READY');
    expect(solver.calls).toBe(calls + 1);
    expect(await prisma.runJob.count({ where: { runId: run.id } })).toBe(2);
  });

  it('RE-PLAN of a stranded version that holds a plan creates the next version (never 409 "optimizing" for ever)', async () => {
    const h = await dispatchTenant('f09r');
    const runId = await readyPlan(h, 5);
    await strand(h.tenantId, runId, h.admin.id);
    const res = await start.replan(h.tenantId, runId, 'REOPTIMIZE', null, { id: h.admin.id }, null);
    expect(res.status).toBe(202);
    expect(res.body.version).toBe(2);
    const child = await jobsDone(String(res.body.runId));
    expect(child.status).toBe('READY');
    expect((await prisma.runPlan.findUniqueOrThrow({ where: { id: runId } })).status).toBe('SUPERSEDED');
  });

  it('a job failure is one transaction: when its audit row cannot be written nothing changes (the janitor fails both later)', async () => {
    const h = await dispatchTenant('f09f');
    const day = isoPlus(6);
    const run = await prisma.runPlan.create({ data: { tenantId: h.tenantId, depotId: h.depotId, runDate: new Date(`${day}T00:00:00.000Z`), status: 'OPTIMIZING', createdById: h.admin.id } });
    const job = await prisma.runJob.create({ data: { tenantId: h.tenantId, runId: run.id, attemptNo: 1, status: 'RUNNING', createdById: h.admin.id, startedAt: new Date() } });
    await prisma.runPlan.update({ where: { id: run.id }, data: { currentJobId: job.id } });
    const heal = await faultOn('AuditLog', `NEW."entityId" = '${safeId(run.id)}' AND NEW.action = 'OPTIMIZE_FAILED'`);
    const args = { runId: run.id, runJobId: job.id, tenantId: h.tenantId, userId: h.admin.id, ip: null, built: {} as never };
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {});
    await dispatchJob.failJob(args, new Error('solver down'));
    quiet.mockRestore();
    expect((await prisma.runJob.findUniqueOrThrow({ where: { id: job.id } })).status).toBe('RUNNING');
    expect((await prisma.runPlan.findUniqueOrThrow({ where: { id: run.id } })).status).toBe('OPTIMIZING');
    await heal();
    await dispatchJob.failJob(args, new Error('solver down'));
    expect((await prisma.runJob.findUniqueOrThrow({ where: { id: job.id } })).status).toBe('FAILED');
    expect((await prisma.runPlan.findUniqueOrThrow({ where: { id: run.id } })).status).toBe('FAILED');
    expect(await prisma.auditLog.count({ where: { tenantId: h.tenantId, action: 'OPTIMIZE_FAILED', entityId: run.id } })).toBe(1);
  });

  it('"Reset stuck plan": a supervisor resets a job lost by a restart; two resets at once are serialized (one 200, one 409)', async () => {
    const h = await dispatchTenant('f09x');
    const day = isoPlus(7);
    const run = await prisma.runPlan.create({ data: { tenantId: h.tenantId, depotId: h.depotId, runDate: new Date(`${day}T00:00:00.000Z`), status: 'OPTIMIZING', createdById: h.admin.id } });
    const job = await prisma.runJob.create({ data: { tenantId: h.tenantId, runId: run.id, attemptNo: 1, status: 'RUNNING', createdById: h.admin.id } });
    await prisma.runPlan.update({ where: { id: run.id }, data: { currentJobId: job.id } });
    await prisma.$executeRawUnsafe(`UPDATE "RunJob" SET "startedAt" = NOW() - INTERVAL '5 minutes', "createdAt" = NOW() - INTERVAL '5 minutes' WHERE id = $1`, job.id);
    const planner = await mkUser(h.tenantId, 'PLANNER', 'f09x-planner');
    const call = async (u: U) => {
      m.auth.mockResolvedValueOnce(sessionOf(u));
      const res = await resetStuckRoute.POST(send(`/api/runs/${run.id}/reset-stuck`, 'POST', { note: 'deploy restarted it' }), { params: { id: run.id } });
      return { status: res.status, body: (await res.json()) as { data?: Record<string, unknown>; error?: { code?: string } } };
    };
    expect((await call(planner)).status).toBe(403);
    const both = await Promise.all([call(h.supervisor), call(h.supervisor)]);
    expect(both.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(both.find((r) => r.status === 409)?.body.error?.code).toBe('NOT_STUCK');
    expect((await prisma.runPlan.findUniqueOrThrow({ where: { id: run.id } })).status).toBe('FAILED');
    const j = await prisma.runJob.findUniqueOrThrow({ where: { id: job.id } });
    expect(j.status).toBe('FAILED');
    expect(j.errorJson).toMatchObject({ reason: 'RESET', userId: h.supervisor.id });
    const audits = await prisma.auditLog.findMany({ where: { tenantId: h.tenantId, action: 'PLAN_RESET' } });
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ userId: h.supervisor.id, entityId: run.id, afterJson: expect.objectContaining({ kind: 'JOB_LOST', jobFailed: true, note: 'deploy restarted it' }) });
  });
});

// =============================================================================================
describe('F21: a plan read or export racing "Use instead" returns one revision (real PostgreSQL)', () => {
  function facts(d: NonNullable<Awaited<ReturnType<typeof planDetail.getPlanDetail>>>) {
    const s = d.summary as unknown as { totalKm: number; operatingCost: number } | null;
    return {
      chosen: d.run.chosenScenario,
      chosenFlag: d.scenarios.find((x) => x.chosen)?.name ?? null,
      summaryKm: s?.totalKm ?? null,
      loadsKm: Math.round(d.loads.reduce((a, l) => a + l.distanceKm, 0) * 10) / 10,
      summaryCost: s?.operatingCost ?? null,
      loadsCost: Math.round(d.loads.reduce((a, l) => a + l.operatingCost, 0) * 1000) / 1000,
      reconciliationOk: (d.reconciliation as { ok?: boolean } | null)?.ok ?? null,
    };
  }
  function consistent(f: ReturnType<typeof facts>) {
    expect(f.chosenFlag).toBe(f.chosen);
    expect(f.loadsKm).toBe(f.summaryKm);
    expect(f.loadsCost).toBeCloseTo(f.summaryCost ?? NaN, 2);
    expect(f.reconciliationOk).toBe(true);
  }

  it('getPlanDetail: "Use instead" committing between the plan row and the loads does not mix the two options', async () => {
    const h = await dispatchTenant('f21p');
    const runId = await readyPlan(h, 8);
    const alt = await prisma.scenarioResult.findFirstOrThrow({ where: { runId, name: 'MIN_DISTANCE' } });
    const before = facts((await planDetail.getPlanDetail(h.tenantId, runId))!);
    consistent(before);
    expect(before.chosen).toBe('RECOMMENDED');

    let switched = false;
    hooks.set('PlanLoad.findMany', {
      before: async () => {
        hooks.delete('PlanLoad.findMany');
        await planService.chooseScenario(h.tenantId, runId, alt.id, h.admin.id); // commits now
        switched = true;
      },
    });
    const during = facts((await planDetail.getPlanDetail(h.tenantId, runId))!);
    expect(switched).toBe(true);
    consistent(during);
    expect(during).toEqual(before); // the revision the read started on
    const after = facts((await planDetail.getPlanDetail(h.tenantId, runId))!);
    consistent(after);
    expect(after.chosen).toBe('MIN_DISTANCE');
    expect(after.summaryKm).not.toBe(before.summaryKm);
  });

  it('the Excel export racing "Use instead": SUMMARY and LOAD PLAN show the same option', async () => {
    const h = await dispatchTenant('f21x');
    const runId = await readyPlan(h, 9);
    const alt = await prisma.scenarioResult.findFirstOrThrow({ where: { runId, name: 'MIN_DISTANCE' } });
    hooks.set('PlanLoad.findMany', {
      before: async () => {
        hooks.delete('PlanLoad.findMany');
        await planService.chooseScenario(h.tenantId, runId, alt.id, h.admin.id);
      },
    });
    m.auth.mockResolvedValueOnce(sessionOf(h.admin));
    const res = await exportRoute.GET(new Request(`http://localhost/api/runs/${runId}/export/excel`), { params: { id: runId } });
    expect(res.status).toBe(200);
    const ExcelJS = (await import('exceljs')).default;
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(await res.arrayBuffer());
    const cell = (v: unknown) => (v && typeof v === 'object' && 'result' in (v as object) ? (v as { result: unknown }).result : v);
    let summaryKm: unknown = null;
    wb.getWorksheet('SUMMARY')?.eachRow((row) => {
      const label = String(cell(row.getCell(1).value) ?? '');
      if (summaryKm === null && /^(Estimated km|Total road km)/.test(label)) summaryKm = cell(row.getCell(2).value);
    });
    let loadPlanKm: unknown = null;
    wb.getWorksheet('LOAD PLAN')?.eachRow((row) => {
      if (String(cell(row.getCell(1).value) ?? '') === 'TOTAL') loadPlanKm = cell(row.getCell(14).value);
    });
    expect(summaryKm).not.toBeNull();
    expect(Number(loadPlanKm)).toBeCloseTo(Number(summaryKm), 1);
    // It read the revision before the switch: RECOMMENDED's 4 loads x 12 km.
    expect(Number(summaryKm)).toBeCloseTo(48, 1);
  });

  it('the consistent read stays tenant-scoped: another company never reads this plan', async () => {
    const h = await dispatchTenant('f21t');
    const runId = await readyPlan(h, 10);
    const other = await mkTenant('f21o');
    expect(await planDetail.getPlanDetail(other.id, runId)).toBeNull();
    expect(await planDetail.getPlanDetail(h.tenantId, runId)).not.toBeNull();
  });
});
