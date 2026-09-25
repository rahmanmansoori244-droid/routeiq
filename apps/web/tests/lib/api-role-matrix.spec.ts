/**
 * Review F15: the API role matrix, checked in. Every exported handler of app/api/**\/route.ts is
 * classified by tests/lib/api-role-matrix.ts; a new route, a removed role option or a changed
 * role fails here until this table is updated on purpose (and reviewed).
 *
 * Decided in the stabilization release (owner defaults):
 * - users, audit and tenant-config READS are TENANT_ADMIN, like their pages;
 * - the job debug JSON (full solver request: revenue, margins, coordinates) is SUPERVISOR+;
 * - plan detail and the exports stay readable by VIEWER (the dispatch team reads plans);
 * - the legacy driver app routes are GONE (410);
 * - an admin password reset (a new one-time password for a user) is TENANT_ADMIN, like invites.
 */
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { apiRoleMatrix } from './api-role-matrix';

const EXPECTED: Record<string, string> = {
  'GET /api/audit': 'TENANT_ADMIN',
  'GET /api/auth/[...nextauth]': 'PUBLIC',
  'POST /api/auth/[...nextauth]': 'PUBLIC',
  'GET /api/auth/end-session': 'PUBLIC',
  'POST /api/auth/forgot': 'PUBLIC',
  'POST /api/auth/reset': 'PUBLIC',
  'POST /api/auth/signup': 'PUBLIC',
  'GET /api/cron/janitor': 'TOKEN',
  'POST /api/cron/janitor': 'TOKEN',
  'GET /api/customers': 'ANY',
  'POST /api/customers': 'PLANNER',
  'GET /api/customers/[id]': 'ANY',
  'PATCH /api/customers/[id]': 'PLANNER',
  'DELETE /api/customers/[id]': 'TENANT_ADMIN',
  'PUT /api/customers/[id]/location': 'PLANNER',
  'POST /api/customers/import': 'SESSION:PLANNER',
  'GET /api/dashboard/kpis': 'ANY',
  'GET /api/depots': 'ANY',
  'POST /api/depots': 'TENANT_ADMIN',
  'GET /api/depots/[id]': 'ANY',
  'PUT /api/depots/[id]': '405',
  'PATCH /api/depots/[id]': 'TENANT_ADMIN',
  'DELETE /api/depots/[id]': 'TENANT_ADMIN',
  'GET /api/dispatch/day': 'ANY',
  'POST /api/dispatch/late-order': 'PLANNER',
  'POST /api/dispatch/plan': 'PLANNER',
  'POST /api/driver/login': 'GONE',
  'GET /api/driver/manifest': 'GONE',
  'POST /api/driver/ping': 'GONE',
  'POST /api/driver/shift/end': 'GONE',
  'POST /api/driver/stop': 'GONE',
  'GET /api/drivers': 'ANY',
  'POST /api/drivers': 'TENANT_ADMIN',
  'GET /api/drivers/[id]': 'ANY',
  'PATCH /api/drivers/[id]': 'TENANT_ADMIN',
  'DELETE /api/drivers/[id]': 'TENANT_ADMIN',
  'POST /api/drivers/[id]/pin': 'GONE',
  'GET /api/health': 'PUBLIC',
  'POST /api/locations/parse': 'PLANNER',
  'GET /api/orders': 'ANY',
  'GET /api/orders/[batchId]': 'ANY',
  'DELETE /api/orders/[batchId]': 'PLANNER',
  'POST /api/orders/[batchId]/confirm': 'PLANNER',
  'GET /api/orders/batches': 'ANY',
  'GET /api/orders/sample': 'ANY',
  'POST /api/orders/upload': 'SESSION:PLANNER',
  'GET /api/products': 'ANY',
  'POST /api/products': 'TENANT_ADMIN',
  'PATCH /api/products/[id]': 'TENANT_ADMIN',
  'DELETE /api/products/[id]': 'TENANT_ADMIN',
  'GET /api/regions': 'ANY',
  'POST /api/regions': 'TENANT_ADMIN',
  'PATCH /api/regions/[id]': 'TENANT_ADMIN',
  'DELETE /api/regions/[id]': 'TENANT_ADMIN',
  'GET /api/runs': 'ANY',
  'POST /api/runs': 'PLANNER',
  'GET /api/runs/[id]': 'ANY',
  'GET /api/runs/[id]/baseline': 'SESSION:ANY',
  'POST /api/runs/[id]/baseline': 'SESSION:PLANNER',
  'POST /api/runs/[id]/choose-scenario': 'PLANNER',
  'POST /api/runs/[id]/dispatch': 'SUPERVISOR',
  'GET /api/runs/[id]/export/excel': 'ANY',
  'GET /api/runs/[id]/export/pdf': 'ANY',
  'GET /api/runs/[id]/jobs/[jobId]/debug': 'SUPERVISOR',
  'GET /api/runs/[id]/live': 'GONE',
  'GET /api/runs/[id]/load-geometry': 'ANY',
  'PATCH /api/runs/[id]/loads/[loadId]': 'PLANNER',
  'POST /api/runs/[id]/optimize': 'PLANNER',
  'GET /api/runs/[id]/plan': 'ANY',
  'POST /api/runs/[id]/replan': 'PLANNER',
  'GET /api/runs/[id]/route-geometries': 'ANY',
  'PATCH /api/runs/[id]/routes/[assignmentId]': 'PLANNER',
  'DELETE /api/runs/[id]/routes/[assignmentId]': 'PLANNER',
  'GET /api/runs/[id]/status': 'ANY',
  'POST /api/runs/[id]/unlock': 'SUPERVISOR',
  'GET /api/tenant/config': 'TENANT_ADMIN',
  'PATCH /api/tenant/config': 'TENANT_ADMIN',
  'GET /api/trucks': 'ANY',
  'POST /api/trucks': 'TENANT_ADMIN',
  'GET /api/trucks/[id]': 'ANY',
  'PATCH /api/trucks/[id]': 'TENANT_ADMIN',
  'DELETE /api/trucks/[id]': 'TENANT_ADMIN',
  'GET /api/users': 'TENANT_ADMIN',
  'POST /api/users': 'TENANT_ADMIN',
  'PATCH /api/users/[id]': 'TENANT_ADMIN',
  'POST /api/users/[id]/reset-password': 'TENANT_ADMIN',
};

describe('API role matrix', () => {
  const actual = apiRoleMatrix(path.resolve(__dirname, '../..'));

  it('matches the checked-in matrix exactly (no new, removed or re-gated handler)', () => {
    expect(actual).toEqual(EXPECTED);
  });

  it('admin data reads are TENANT_ADMIN and solver debug JSON is SUPERVISOR+', () => {
    expect(actual['GET /api/users']).toBe('TENANT_ADMIN');
    expect(actual['GET /api/audit']).toBe('TENANT_ADMIN');
    expect(actual['GET /api/tenant/config']).toBe('TENANT_ADMIN');
    expect(actual['GET /api/runs/[id]/jobs/[jobId]/debug']).toBe('SUPERVISOR');
    expect(actual['POST /api/users/[id]/reset-password']).toBe('TENANT_ADMIN');
  });

  it('no write handler is open to every role', () => {
    const openWrites = Object.entries(actual).filter(([k, v]) => !k.startsWith('GET ') && (v === 'ANY' || v === 'SESSION:ANY'));
    expect(openWrites).toEqual([]);
  });
});
