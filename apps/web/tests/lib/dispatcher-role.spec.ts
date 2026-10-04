/**
 * Owner decision 4 (5 Oct 2026): "The dispatcher is the PLANNER; he just doesn't have the privileges
 * of an admin like changing a location." Every Daily dispatch action is PLANNER and above: Lock,
 * Loading, Dispatch, Back to locked, Unlock, Completed, Record outcome, the driver links, daily
 * drivers, the overrides with a reason, "Use the best plan found so far" and "Reset stuck plan" (and
 * the legacy run's Dispatch / Unlock). VIEWER stays read-only; the company admin's powers (a saved
 * location, the loading rule, users, depots, trucks, products, cost and routing settings, retention)
 * are unchanged. The solver debug JSON (revenue, margins) stays SUPERVISOR: it is not dispatch work.
 * Runtime checks go through the real route handlers with the session and the work behind them faked.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { apiRoleMatrix } from './api-role-matrix';

type Role = 'SUPER_ADMIN' | 'TENANT_ADMIN' | 'SUPERVISOR' | 'PLANNER' | 'VIEWER';
const session = vi.hoisted(() => ({ role: 'PLANNER' as Role }));
vi.mock('@/lib/auth', () => ({ auth: vi.fn(async () => ({ user: { id: 'u1', tenantId: 'tA', role: session.role, name: 'Ali', email: 'ali@a.example' } })) }));
vi.mock('@/lib/tenant', () => ({ tenantDb: () => ({}) }));
vi.mock('@/lib/db', () => ({ prisma: {} }));

const work = vi.hoisted(() => ({
  reset: vi.fn(async () => ({ status: 200, body: { status: 'FAILED', kind: 'JOB_ENDED' } })),
  stop: vi.fn(async () => ({ status: 202, body: { message: 'Stopping the search.' } })),
  updateLoad: vi.fn(),
}));
vi.mock('@/lib/dispatch/stuck-plan', () => ({ resetStuckPlan: work.reset }));
vi.mock('@/lib/jobs/optimize-job', () => ({ isOptimizing: () => false }));
vi.mock('@/lib/dispatch/stop-search', () => ({ stopSearch: work.stop }));
// The legacy run routes refuse a daily dispatch plan first (409): enough to see the role gate passed.
vi.mock('@/lib/dispatch/legacy-runs', () => ({ isDispatchPlan: async () => true, DISPATCH_PLAN_REFUSAL: { code: 'DISPATCH_PLAN' } }));
vi.mock('@/lib/dispatch/plan-service', () => ({ updateLoad: work.updateLoad }));

import { checkTransition, type LoadStatusName } from '@/lib/dispatch/load-state';
import { canApproveOverride, canManageMasterData, canPlan } from '@/lib/rbac';
import { POST as resetStuck } from '@/app/api/runs/[id]/reset-stuck/route';
import { POST as stopSearch } from '@/app/api/runs/[id]/stop-search/route';
import { POST as legacyDispatch } from '@/app/api/runs/[id]/dispatch/route';
import { POST as legacyUnlock } from '@/app/api/runs/[id]/unlock/route';
import { PATCH as patchLoad } from '@/app/api/runs/[id]/loads/[loadId]/route';

const WEB = path.resolve(__dirname, '../..');
const read = (p: string) => readFileSync(path.join(WEB, p), 'utf8');
const post = (body?: unknown) =>
  new Request('http://localhost/x', { method: 'POST', headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
const patch = (body: unknown) => new Request('http://localhost/x', { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const ctx = { params: { id: 'P1' } };

/** Every Daily dispatch action and the route behind it: PLANNER (the dispatcher) and above. */
const DISPATCH_WORK: Record<string, string> = {
  'PATCH /api/runs/[id]/loads/[loadId]': 'PLANNER', // Lock, Loading, Dispatch, Back to locked, Unlock, Completed, the driver
  'POST /api/runs/[id]/dispatch': 'PLANNER', // legacy run: Dispatch
  'POST /api/runs/[id]/unlock': 'PLANNER', // legacy run: Unlock
  'POST /api/runs/[id]/reset-stuck': 'PLANNER', // Reset stuck plan
  'POST /api/runs/[id]/stop-search': 'PLANNER', // Use the best plan found so far
  'POST /api/runs/[id]/optimize': 'PLANNER', // OPTIMIZE, and its overrides (optimize without locations / weights)
  'POST /api/runs/[id]/replan': 'PLANNER', // Re-plan with a reason, and the same overrides
  'POST /api/dispatch/outcomes': 'PLANNER', // Record outcome
  'GET /api/dispatch/driver-links': 'PLANNER',
  'POST /api/dispatch/driver-links': 'PLANNER', // create a driver link
  'PATCH /api/dispatch/driver-links/[id]': 'PLANNER', // reissue / revoke
  'POST /api/dispatch/casual-driver': 'PLANNER', // daily drivers
  'POST /api/dispatch/carry-over': 'PLANNER', // Bring forward
  'POST /api/dispatch/carry-over/undo': 'PLANNER',
  'POST /api/dispatch/late-order': 'PLANNER',
  'PUT /api/dispatch/delivery-time': 'PLANNER',
  'GET /api/dispatch/delivery-actuals': 'PLANNER',
};

/** What stays the company admin's (owner: "like changing a location"). */
const ADMIN_ONLY: Record<string, string> = {
  'POST /api/depots': 'TENANT_ADMIN',
  'PATCH /api/depots/[id]': 'TENANT_ADMIN',
  'POST /api/trucks': 'TENANT_ADMIN',
  'PATCH /api/trucks/[id]': 'TENANT_ADMIN',
  'POST /api/products': 'TENANT_ADMIN',
  'PATCH /api/products/[id]': 'TENANT_ADMIN',
  'POST /api/drivers': 'TENANT_ADMIN',
  'PATCH /api/drivers/[id]': 'TENANT_ADMIN',
  'GET /api/users': 'TENANT_ADMIN',
  'POST /api/users': 'TENANT_ADMIN',
  'PATCH /api/users/[id]': 'TENANT_ADMIN',
  'GET /api/tenant/config': 'TENANT_ADMIN',
  'GET /api/customers/pin-check': 'TENANT_ADMIN',
  'DELETE /api/customers/[id]': 'TENANT_ADMIN',
};

describe('owner decision 4 (5 Oct 2026): the dispatcher (PLANNER) does every Daily dispatch action', () => {
  const matrix = apiRoleMatrix(WEB);

  it('every dispatch route admits PLANNER', () => {
    const actual = Object.fromEntries(Object.keys(DISPATCH_WORK).map((k) => [k, matrix[k]]));
    expect(actual).toEqual(DISPATCH_WORK);
  });

  it('no route needs SUPERVISOR any more except the solver debug JSON (revenue and margins: support, not dispatch)', () => {
    const supervisor = Object.entries(matrix).filter(([, v]) => v === 'SUPERVISOR' || v === 'SESSION:SUPERVISOR').map(([k]) => k);
    expect(supervisor).toEqual(['GET /api/runs/[id]/jobs/[jobId]/debug']);
  });

  it("the company admin's powers are unchanged", () => {
    const actual = Object.fromEntries(Object.keys(ADMIN_ONLY).map((k) => [k, matrix[k]]));
    expect(actual).toEqual(ADMIN_ONLY);
    // Changing a saved location stays the admin's inside the PLANNER route (the location admin-lock).
    expect(read('app/api/customers/[id]/location/route.ts')).toContain('const isAdmin = canManageMasterData(user.role);');
    // The loading rule, cost, routing and retention settings: adminOnlyFields (the dispatcher saves the driver shift only).
    expect(read('app/api/tenant/config/route.ts')).toContain("const admin = hasRole(user.role, 'TENANT_ADMIN');");
  });

  it('every load status change is the dispatcher\'s: Dispatch and Completed no longer ask for a supervisor', () => {
    const moves: [LoadStatusName, LoadStatusName][] = [
      ['PLANNED', 'LOCKED'],
      ['LOCKED', 'PLANNED'],
      ['LOCKED', 'LOADING'],
      ['LOADING', 'LOCKED'],
      ['LOCKED', 'DISPATCHED'],
      ['LOADING', 'DISPATCHED'],
      ['DISPATCHED', 'COMPLETED'],
    ];
    for (const [from, to] of moves) {
      const load = { id: 'L1', loadNo: 1, status: from };
      expect(checkTransition(load, [load], to), `${from} -> ${to}`).toEqual({ ok: true, role: 'PLANNER' });
    }
  });

  it('both plan screens and the legacy run page give the buttons to PLANNER (canPlan), the debug JSON stays SUPERVISOR', () => {
    expect(read('app/t/[slug]/dispatch/page.tsx')).toContain('canDispatch={canPlan(user.role)}');
    expect(read('app/t/[slug]/dispatch/plan/[id]/page.tsx')).toContain('canDispatch={canPlan(user.role)}');
    const run = read('app/t/[slug]/runs/[id]/page.tsx');
    expect(run).toContain('canDispatch={canPlan(user.role)}');
    expect(run).toContain('canDownloadDebug={canApproveOverride(user.role)}');
    expect(read('app/t/[slug]/runs/[id]/run-detail.tsx')).toContain('canDownloadDebug={canDownloadDebug}');
    // No screen grants dispatch work with the SUPERVISOR check any more.
    for (const p of ['app/t/[slug]/dispatch/page.tsx', 'app/t/[slug]/dispatch/plan/[id]/page.tsx']) expect(read(p)).not.toContain('canApproveOverride');
  });

  it('the role helpers: PLANNER plans and dispatches, VIEWER does neither, only an admin manages master data', () => {
    expect([canPlan('PLANNER'), canPlan('SUPERVISOR'), canPlan('TENANT_ADMIN'), canPlan('VIEWER')]).toEqual([true, true, true, false]);
    expect([canManageMasterData('PLANNER'), canManageMasterData('SUPERVISOR'), canManageMasterData('TENANT_ADMIN')]).toEqual([false, false, true]);
    expect([canApproveOverride('PLANNER'), canApproveOverride('SUPERVISOR')]).toEqual([false, true]);
  });
});

describe('the routes at run time: PLANNER passes, VIEWER is refused (403) before any work', () => {
  beforeEach(() => {
    work.reset.mockClear();
    work.stop.mockClear();
    work.updateLoad.mockReset();
    // The real lifecycle asks the route's role check for checkTransition's role.
    work.updateLoad.mockImplementation(async (_t: string, _r: string, loadId: string, change: { status: LoadStatusName }, _u: unknown, hasRole: (r: 'PLANNER') => boolean) => {
      const load = { id: loadId, loadNo: 1, status: (change.status === 'COMPLETED' ? 'DISPATCHED' : 'LOCKED') as LoadStatusName };
      const check = checkTransition(load, [load], change.status);
      if (!check.ok) throw new Error(check.reason);
      if (!hasRole(check.role)) return { refused: true };
      return { id: loadId, status: change.status };
    });
  });

  it('Reset stuck plan and Use the best plan found so far: a dispatcher does them, a viewer cannot', async () => {
    session.role = 'PLANNER';
    expect((await resetStuck(post({ note: 'stuck since the deploy' }), ctx)).status).toBe(200);
    expect(work.reset).toHaveBeenCalledTimes(1);
    expect((await stopSearch(post({}), ctx)).status).toBe(202);
    expect(work.stop).toHaveBeenCalledTimes(1);
    session.role = 'VIEWER';
    expect((await resetStuck(post({}), ctx)).status).toBe(403);
    expect((await stopSearch(post({}), ctx)).status).toBe(403);
    expect(work.reset).toHaveBeenCalledTimes(1);
    expect(work.stop).toHaveBeenCalledTimes(1);
  });

  it('Dispatch and Completed of a load: a dispatcher does them; a viewer is refused', async () => {
    session.role = 'PLANNER';
    for (const status of ['DISPATCHED', 'COMPLETED'] as const) {
      const res = await patchLoad(patch({ status }), { params: { id: 'P1', loadId: 'L1' } });
      expect(res.status, status).toBe(200);
      expect((await res.json()).data, status).toEqual({ id: 'L1', status });
    }
    session.role = 'VIEWER';
    expect((await patchLoad(patch({ status: 'DISPATCHED' }), { params: { id: 'P1', loadId: 'L1' } })).status).toBe(403);
    expect(work.updateLoad).toHaveBeenCalledTimes(2);
  });

  it('the legacy run Dispatch and Unlock pass the role gate for a dispatcher (a daily plan is then refused 409), never for a viewer', async () => {
    session.role = 'PLANNER';
    expect((await legacyDispatch(post(), ctx)).status).toBe(409);
    expect((await legacyUnlock(post(), ctx)).status).toBe(409);
    session.role = 'VIEWER';
    expect((await legacyDispatch(post(), ctx)).status).toBe(403);
    expect((await legacyUnlock(post(), ctx)).status).toBe(403);
  });
});
