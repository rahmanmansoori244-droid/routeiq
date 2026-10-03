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
 * - PR9: "Bring forward" (POST /api/dispatch/carry-over) is PLANNER, like confirming a file and a
 *   late order; its preview (GET) is readable by every role, like the day overview.
 * - Audit PR A2 (27 Sep 2026) changed three routes, not their roles: PATCH /api/customers/[id]
 *   (PLANNER; avgServiceTimeMin null = back to the default, JSON numbers only), GET
 *   /api/runs/[id]/export/excel and /export/pdf (ANY; chosen by isDispatchPlan, PDF 404 NO_LOADS
 *   for a dispatch plan without loads).
 * - Audit PR "Intake and master data" (27 Sep 2026): behaviour changed, roles unchanged, on
 *   DELETE /api/depots/[id] (deactivates once anything refers to the depot), PATCH /api/depots/[id]
 *   (deactivation warning), DELETE and PATCH /api/drivers/[id] (always deactivates; names the trucks
 *   it stays default of; phone can be cleared), POST /api/regions and PATCH /api/regions/[id]
 *   (no depot / clear the depot), and the POST / PATCH of customers, depots, drivers and trucks
 *   (an empty optional text or reference clears it; a field left out is unchanged),
 *   POST /api/customers/import (verified pins kept under concurrency), POST /api/orders/upload and
 *   POST /api/orders/[batchId]/confirm (merged rows; depot and old-merge re-checks).
 * - audit PR4 (F09, owner decision 17): "Reset stuck plan" (POST /api/runs/[id]/reset-stuck) is
 *   SUPERVISOR and above; (F15) GET /api/health/live (liveness) is public like /api/health.
 * - Audit PR A5 "Owner rules" (every order has a depot): behaviour changed, roles unchanged, on
 *   POST /api/orders/upload (422 DEPOT_REQUIRED without a depot choice unless the company has
 *   exactly one active depot; 422 DEPOT_NOT_ACTIVE for a chosen depot that is not active),
 *   POST /api/orders/[batchId]/confirm (a file on the history-only depot is refused),
 *   PATCH /api/depots/[id] (422 DEPOT_HISTORY_ONLY: the history-only depot is never made active),
 *   POST /api/trucks, PATCH /api/trucks/[id], POST /api/regions and PATCH /api/regions/[id]
 *   (422 DEPOT_HISTORY_ONLY: never on the history-only depot).
 * - Audit PR A6 "Solver and plan-output accuracy": behaviour changed, roles unchanged, on
 *   GET /api/runs/[id]/load-geometry (each load routed from the depot pin it was planned from),
 *   GET /api/runs/[id]/plan (loads carry `origin`; options that break the timing rules are never
 *   described as cheaper), GET /api/dispatch/day (`outdated.depotMoved`), the Excel and PDF exports
 *   (loading-sheet kg = load kg; the planned depot pin) and POST /api/runs/[id]/replan (the copies
 *   keep each load's planned depot pin).
 * - Long searches (owner request 29 Sep 2026): POST /api/runs/[id]/stop-search ("Use the best plan
 *   found so far") is SUPERVISOR and above; the optimize / re-plan routes take an optional
 *   searchMode (roles unchanged).
 * - Delivery outcome and the driver page (owner request 4 Oct 2026), Part 1: GET /api/d/manifest is
 *   DRIVER_LINK (the driver link token in the Authorization header, withDriverLink; no session
 *   needed, a signed-in user of the link's company is the office); the driver links of a plan
 *   (GET / POST /api/dispatch/driver-links, PATCH /api/dispatch/driver-links/[id]) and the daily-driver
 *   quick add (POST /api/dispatch/casual-driver) are PLANNER, like the Driver list. Roles unchanged on
 *   GET /api/runs/[id]/export/pdf (prints the driver-link QR for PLANNER+ only), PATCH
 *   /api/runs/[id]/loads/[loadId] (409 DRIVER_REQUIRED: owner rule 20), GET|PATCH /api/tenant/config
 *   (five admin settings), POST /api/trucks + PATCH /api/trucks/[id] (`hired`) and PATCH
 *   /api/drivers/[id] (`casual`).
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
  // Owner decisions 1 Oct 2026 (items 4 and 6): the data to collect and the customer master (Excel).
  'GET /api/customers/data-to-collect': 'PLANNER',
  'GET /api/customers/master': 'PLANNER',
  // Owner request 4 Oct 2026: the driver page's API (token in a header) and the driver links.
  'GET /api/d/manifest': 'DRIVER_LINK',
  'GET /api/dashboard/kpis': 'ANY',
  'GET /api/depots': 'ANY',
  'POST /api/depots': 'TENANT_ADMIN',
  'GET /api/depots/[id]': 'ANY',
  'PUT /api/depots/[id]': '405',
  'PATCH /api/depots/[id]': 'TENANT_ADMIN',
  'DELETE /api/depots/[id]': 'TENANT_ADMIN',
  'GET /api/dispatch/carry-over': 'ANY',
  'POST /api/dispatch/carry-over': 'PLANNER',
  'POST /api/dispatch/casual-driver': 'PLANNER',
  'GET /api/dispatch/day': 'ANY',
  // Data collection rules (1 Oct 2026): a delivery time for one order (urgent / promised).
  'PUT /api/dispatch/delivery-time': 'PLANNER',
  'GET /api/dispatch/driver-links': 'PLANNER',
  'POST /api/dispatch/driver-links': 'PLANNER',
  'PATCH /api/dispatch/driver-links/[id]': 'PLANNER',
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
  'GET /api/health/live': 'PUBLIC',
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
  'POST /api/runs/[id]/reset-stuck': 'SUPERVISOR',
  'POST /api/runs/[id]/stop-search': 'SUPERVISOR',
  'GET /api/runs/[id]/route-geometries': 'ANY',
  'PATCH /api/runs/[id]/routes/[assignmentId]': 'PLANNER',
  'DELETE /api/runs/[id]/routes/[assignmentId]': 'PLANNER',
  'GET /api/runs/[id]/status': 'ANY',
  'POST /api/runs/[id]/unlock': 'SUPERVISOR',
  'GET /api/tenant/config': 'TENANT_ADMIN',
  'PATCH /api/tenant/config': 'PLANNER', // the dispatcher saves the driver shift only (adminOnlyFields)
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
