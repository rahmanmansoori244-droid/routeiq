# Lifecycle, job recovery and legacy mutation audit

Reviewed commit: `83d8174836deb339d54f90e65b803550ed34c20d`.

This is a read-only focused audit. No production database, HTTP write, migration, repository edit or commit was performed. The probes call real repository functions with controlled I/O; the repository's fake Prisma has no actual transaction isolation, row locks or PostgreSQL engine. Consequently these probes establish the shown application control flow, not a PostgreSQL concurrency benchmark.

## LIF-01 — Interrupted janitor repair leaves a day permanently OPTIMIZING

Severity: medium; recovery/availability defect, with high operational impact if the affected day is needed for dispatch.

Confirmed with an actual-function bounded failure-injection probe.

- `apps/web/lib/jobs/optimize-job.ts:92–107`: `RunJob.status=FAILED` commits before a separate `RunPlan.status=FAILED` statement. There is no surrounding transaction.
- `apps/web/lib/jobs/optimize-job.ts:73–79`: subsequent sweeps select only RUNNING and QUEUED jobs.
- `apps/web/lib/dispatch/start-optimize.ts:244–249`: an OPTIMIZING plan without any active job is nevertheless answered as `202 RUNNING`, pointing at its failed current job.
- `apps/web/lib/dispatch/start-optimize.ts:361–362`: a copied/applied version in the same state is refused for replanning as still optimizing.

Failure scenario: a server restart leaves an orphaned job. The janitor commits the job as FAILED. A transient database error or another process interruption occurs before the plan repair. The next sweep cannot find the now-FAILED job. The original version stays OPTIMIZING, so retry cannot start work and load changes remain blocked.

Probe result: first sweep returned `reaped:0` after the injected second-write error; second sweep also returned `reaped:0`; stored states were job FAILED and plan OPTIMIZING. Calling real `startDispatchOptimize` with the same failed job returned `{status:202, body:{runJobId:'J1',status:'RUNNING',runId:'R1'}}` without scheduling anything. Control case with both statements succeeding repaired the plan to FAILED.

Fix: perform the conditional job transition and conditional plan repair in one transaction, taking the plan lock before the job lock consistently with finalization. Add an idempotent reconciliation branch for OPTIMIZING plans whose current job is terminal/missing, so existing inconsistent states can heal. Include a regression that fails between the two writes and retries, plus a real PostgreSQL finalization-versus-reaper interleaving test.

Evidence: `lifecycle-probes.mjs`, `lifecycle-probes-results.json`.

## LIF-02 — Legacy assignment DELETE bypasses locks and can erase delivery proof

Severity: medium; historical tenant-data integrity and privilege boundary defect. This is confined to legacy runs; current load-based dispatch plans are rejected by the API guard.

Confirmed application deletion behavior; cascading proof removal follows directly from the schema, but was not run against PostgreSQL.

- `apps/web/app/api/runs/[id]/routes/[assignmentId]/route.ts:68–87`: a PLANNER may call DELETE; the transaction verifies tenancy but not run status or assignment lock.
- `apps/web/lib/route-adjust.ts:417–430`: unassign reads the run but never refuses DISPATCHED/ARCHIVED, and does not even select `lockedByUserId` before deleting.
- `apps/web/prisma/schema.prisma:438–445`: `DeliveryProof.assignment` uses `onDelete: Cascade`.
- Compare the move path, which refuses a locked assignment and closed run; legacy run unlock itself requires SUPERVISOR.

Failure scenario: a planner sends DELETE for an assignment in a previously dispatched or archived legacy run, including a locked assignment. The row is deleted and remaining stops are resequenced, bypassing the explicit supervisor unlock procedure. If that legacy assignment has a delivery proof, the database cascade removes it too. This affects preserved historical tenant data, which the handbook explicitly leaves in review scope even though the legacy optimizer is retired.

Probe result: real `unassignAssignment` accepted and deleted a locked assignment for both DISPATCHED and ARCHIVED fixtures. `moveAssignment` refused the same locked assignment as a control. The probe called the service directly; the API's PLANNER authorization and missing guards were verified in source, not through an authenticated HTTP request.

Fix: preferably make retired legacy mutations read-only. If retained, acquire a run row lock and check run state and assignment lock inside every mutator; require the existing supervisor unlock action before any dispatched-run edit. Preserve proof-bearing assignments or use audited soft removal. Add API-level tests for PLANNER DELETE of locked, dispatched, archived and proof-bearing rows.

Evidence: `lifecycle-probes.mjs`, `lifecycle-probes-results.json`.

## LIF-OBS-01 — Deactivation is not an operational dispatch hold

Classification: confirmed behavior/design concern, not a claimed regression. Customer retention and frozen-driver preservation are explicitly documented.

- `apps/web/lib/dispatch/plan-service.ts:1416–1430`: feasibility inputs do not read truck.active, driver.active or customer.active.
- `apps/web/lib/dispatch/plan-service.ts:1939–1964`: forward status transitions verify reconciliation and timetable, not current active flags.
- `apps/web/lib/dispatch/plan-service.ts:2055–2067`: assigning a different driver checks active status, but status-only dispatch does not.
- `apps/web/lib/dispatch/plan-detail.ts:644–677`: customer deactivation produces a warning on PLANNED loads; locking removes that open-load warning by design.
- `apps/web/app/t/[slug]/dispatch/plan-view.tsx:976–1005`: the existing inactive driver remains in the picker and is labelled inactive.
- Handbook lines 686, 691, 735 and Dispatcher Guide line 24 explicitly tell the dispatcher to replan deactivated customers; frozen customer work is retained. `tests/lib/dispatch-load-state.spec.ts:368` explicitly preserves frozen drivers even when inactive.

Actual `updateLoad` probes separately deactivated the truck, its already assigned driver and the customer before locking. All allowed PLANNED → LOCKED → LOADING → DISPATCHED with `FEASIBILITY_GATE=enforce` and VERIFIED, zero timing warnings. Truck and driver cases had no plan warning; customer case had the documented replan warning. A normal active control also passed.

Decision needed for NMWC: distinguish immutable plan/history from permission to execute the next physical action. If inactive means breakdown, on leave, business closed or administrative delivery hold, create an explicit operational hold checked before loading/dispatch. Preserve completed historical facts, but block or require a separately authorized, audited override for future movement. Customer warning-only treatment is currently intentional; changing it is a business-policy change.

Evidence: `deactivation-probe.mjs`, `deactivation-results.json`. No actual truck, driver or customer was changed.

## Reviewed protections and no additional confirmed defect

- Day advisory lock and plan row-lock ordering for initial-plan creation, version copy-forward, scenario application, status changes and job finalization.
- Replan preflight and admission ticket release on refused/no-op starts; copy-forward preserves a usable prior plan on solve failure.
- Finalization requires matching OPTIMIZING/currentJobId and RUNNING job; writes scenario, order weights, chosen plan and success audit transactionally.
- Frozen-load-ID comparison during start and scenario apply; distinction between wholly frozen orders and split portions.
- Conditional failJob updates avoid overwriting a successfully saved or superseded version. Its failure state writes are transactional, unlike the janitor defect.
- Solve-admission quota reservations, tenant/global concurrency, fair waiting queue and idempotent ticket release. Single-process storage is a documented deployment constraint, not a new issue.
- Real HTTP solver deadline and timer cleanup, queued-job handoff, in-flight promise tracking, legacy-plan refusal on optimize/replan.
- Current load changes reject superseded and optimizing versions; scenario switching takes the same plan lock; current load-based plans are refused by legacy manual edit/dispatch/unlock routes.

No additional concurrency bug is asserted from the in-memory probes. Actual row-lock/deadlock testing requires local PostgreSQL.

## Coverage

Substantive read-through: `apps/web/lib/dispatch/start-optimize.ts`, `plan-locks.ts`, `solve-admission.ts`, `load-state.ts`, `legacy-runs.ts`; `apps/web/lib/jobs/dispatch-job.ts`, `optimize-job.ts`, `janitor-loop.ts`, `shift-janitor.ts`; `apps/web/lib/solver-client.ts`, `route-adjust.ts`; `apps/web/app/api/dispatch/plan/route.ts`; `apps/web/app/api/runs/route.ts`; run routes `route.ts`, `status/route.ts`, `dispatch/route.ts`, `unlock/route.ts`, `baseline/route.ts`, `routes/[assignmentId]/route.ts`; truck and driver `[id]/route.ts`.

Focused read-through of `plan-service.ts`: request construction and scope/frozen portions; weight CAS persistence; scenario persistence/application; summary reconciliation; gate input assembly; current-plan predicate; initial/next version creation; locking/status/driver mutation (lines 1–674, 760–1168, 1277–2092). Plan settings/input serialization and snapshot source were not independently re-audited by this lane because the snapshot lane owns them.

Targeted supporting reads: `plan-errors.ts`, `http-error.ts`, `prisma-copy.ts`, relevant `plan-status.ts` imports; schema RunPlan/RouteAssignment/DeliveryProof; plan-detail outdated warnings; driver picker; handbook 7.3/7.4 and active-state/lifecycle sections; Dispatcher Guide customer and driver rules; existing fake DB and feasibility-gate/driver-state tests.

Unconfirmed lead forwarded to security owner: generic status response includes job.errorJson, which may contain SolverError.responseBody. No sensitive-data disclosure is claimed here; the dedicated debug endpoint has a stronger role gate and needs a separate boundary assessment.
