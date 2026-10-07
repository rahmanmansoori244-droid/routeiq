# Bounded coverage-gap pass: drivers, account UI and dashboard

Commit: `83d8174836deb339d54f90e65b803550ed34c20d`. Read-only follow-up; no production calls or source changes. This note does not repeat A01/A02 from the main auth report.

## A03 — Driver delete races with dispatch and erases the dispatched load's driver

Severity: medium. A concurrency violation of the documented historical-driver invariant.

Sources:

- `apps/web/app/api/drivers/[id]/route.ts:46–65`: separate reference counts, then hard delete if both were zero; no transaction or shared lock.
- `apps/web/lib/dispatch/plan-service.ts:1909–1923`: `updateLoad` can assign a driver and dispatch in one transaction, under the RunPlan lock.
- `apps/web/lib/dispatch/plan-service.ts:2055–2075`: validates a live active driver and writes it onto the load; does not share a driver-delete serialization lock.
- `apps/web/prisma/schema.prisma:696`: deleting Driver sets `PlanLoad.driverId` to NULL.

Concrete failure schedule:

1. A driver has never appeared on a plan. An admin starts DELETE; its counts both return zero.
2. Before DELETE reaches the database, the dispatcher assigns that still-existing active driver to a LOADING load and dispatches it in the same successful `updateLoad` request.
3. The DELETE request continues down the already-selected hard-delete branch. It returns 200. The foreign-key action clears the driver from the now-DISPATCHED load.

This does not require changing a dispatched driver's assignment through the load API: the database deletion bypasses that normal immutability check.

Proof: `driver-delete-race-probe.mjs` invokes the actual DELETE route and actual `updateLoad`, driver checks, transition checks, reconciliation and timing gate through the repository's `fake-plan-db`. The count starts at 0; the real intervening mutation reaches `{status:'DISPATCHED',driverId:'DRV'}`; hard deletion leaves `{status:'DISPATCHED',driverId:null}`. The fake database has no FK implementation, so the schema's exact ON DELETE SET NULL effect is explicitly modeled at the delete boundary. A sequential already-used-driver control soft-deactivates correctly and retains history. This is not a real Postgres concurrency execution.

Fix: the simplest safe model is to deactivate every driver rather than hard-delete. If deleting never-used rows remains required, serialize the reference check/delete with assignment/dispatch and use a restrictive historical FK so deletion cannot silently erase existing references. Merely wrapping count+delete in an ordinary READ COMMITTED transaction is insufficient. Add a Postgres test that pauses DELETE after its zero count, then assigns/dispatches before allowing deletion to continue.

## Minor dashboard observations

**Premature cost-per-case rounding:** `lib/dashboard.ts:129` rounds to two decimals, then `app/t/[slug]/page.tsx:108` displays three decimals. Actual `rollupRows` execution with OMR900 / 20,000cases returns0.05 and the UI formats `0.050`; the correct three-decimal value is `0.045`. This visibly loses precision for small per-case costs and can make fleet/day comparisons misleading. Keep full precision through the aggregation and round at the declared presentation precision. Evidence: `dashboard-precision-probe.mjs` and `dashboard-precision-results.json`.

**Week label mismatch:** `lib/dashboard.ts:175–177` always uses today minus six days and the preceding seven days. The dashboard labels the first period "Week to date" (`app/t/[slug]/page.tsx:138`) rather than "Last 7 days". Rename the label, or calculate a configurable business-week start and compare equivalent elapsed periods.

**Old scope copy:** the dashboard says "time windows not enforced in v1" below Late deliveries, although the current planner enforces represented hard windows. Actual late-delivery recording remains outside RouteIQ's scope. Replace this text with "Actual delivery tracking is not recorded here" and label planned service figures accordingly.

**Metric-definition improvement:** `fetchRangeRows` averages depot-plan utilization percentages without load/capacity weights; weekly rollup averages daily percentages again. This may be a deliberately macro-averaged metric, so it is not a separate confirmed bug. Define whether the KPI means average load utilization, capacity-weighted utilization or equal-weight depot/day average and name it accurately.

## Driver auth, retired API and account checks: no further current vulnerability confirmed

- `/driver` and `/driver/manifest` render retirement notices. The client removes the three former localStorage values, including the shift token.
- All seven old driver/PIN/live endpoint handlers return410. Repository caller search finds no active app caller of `loginDriver`, `requireDriverShift`, `endShift`, `hashPin`, `verifyPin` or `generatePin`.
- The old auth helper would be insufficient for reactivation (it does not refresh driver/tenant activity for an existing shift, and its old run linkage/session lifecycle had pre-existing issues). Those are not current reachable defects and must not be reported as new vulnerabilities. Re-enabling this module would require a new design review.
- The retirement migration ends ACTIVE shifts and clears PIN hashes. This is verified in source; production migration outcome was not queried.
- The remaining shift janitor changes only stale ACTIVE shifts to ABANDONED. It does not update current loads, delivery proofs or order status, and therefore does not offer a backdoor into live dispatch mutations.
- Driver master-data APIs use public selects; driver deactivation is distinct from User login deactivation. Existing assigned-driver deactivation behavior is the lifecycle review's policy finding, not duplicated here.
- Users UI protects platform-admin controls for tenant admins and uses the standard sign-out path. Its foreign-tenant invite issue belongs to the already-proved foreign-page wrong-target UI finding. Temporary-password forced change is explicitly deferred policy, not new hidden behavior.
- Tenant dashboard SQL uses a tenant filter and the current plan per depot/day; no additional tenant data exposure was found in this pass.

## Additional files read in this pass

- `apps/web/lib/jobs/shift-janitor.ts`
- `apps/web/lib/dashboard.ts`
- `apps/web/lib/dispatch/plan-locks.ts`
- `apps/web/lib/dispatch/plan-service.ts` (targeted updateLoad/setDriverTx/status paths)
- `apps/web/app/api/drivers/[id]/route.ts`
- `apps/web/app/api/drivers/route.ts`
- `apps/web/app/api/dashboard/kpis/route.ts`
- `apps/web/app/api/runs/[id]/loads/[loadId]/route.ts`
- `apps/web/app/driver/layout.tsx`
- `apps/web/app/driver/page.tsx`
- `apps/web/app/driver/manifest/page.tsx`
- `apps/web/app/driver/retired-notice.tsx`
- `apps/web/app/t/[slug]/runs/[id]/live/page.tsx`
- `apps/web/app/t/[slug]/page.tsx`
- `apps/web/app/t/[slug]/users/page.tsx`
- `apps/web/app/t/[slug]/users/users-client.tsx`
- `apps/web/app/t/[slug]/layout.tsx`
- `apps/web/components/sidebar.tsx`
- `apps/web/components/mobile-sidebar.tsx`
- `apps/web/components/topbar.tsx`
- `apps/web/components/user-menu.tsx`
- `apps/web/prisma/migrations/20260926090000_retire_driver_app_scrub_secrets/migration.sql`
- `apps/web/prisma/schema.prisma` (Driver/DriverShift/PlanLoad relations)
- `apps/web/tests/lib/fake-plan-db.ts`
- `apps/web/tests/lib/plan-feasibility-gate.spec.ts` (fixture/transition tests)
- `apps/web/tests/integration/dashboard-db.spec.ts` (precision expectation reference)

Prior full reads of driver-auth, driver-app, user auth/reset handlers and the seven retired endpoint files were reused.
