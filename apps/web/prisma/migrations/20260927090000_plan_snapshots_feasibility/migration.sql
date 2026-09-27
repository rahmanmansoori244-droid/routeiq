-- Stabilization PR4 (review F08, F04): the facts each plan was made with, and its timetable check.
-- Additive only: three nullable JSONB columns with no default. On PostgreSQL 11+ this is a
-- metadata-only change (no table rewrite, a brief lock). Existing rows stay NULL: the app then
-- shows the live master data, labelled as such, and computes the timetable check on the next load
-- change. Old app code ignores the columns, so a rollback of the app is safe.

-- The customer facts each stop was planned with (pin, receiving hours, service time, name, address).
ALTER TABLE "RouteAssignment" ADD COLUMN "stopSnapshotJson" JSONB;

-- The truck and planning rules each load was timed with (capacities, costs, turnaround, shift).
ALTER TABLE "PlanLoad" ADD COLUMN "truckSnapshotJson" JSONB;

-- The timetable check of the version per truck-day (what LOCK / LOADING / DISPATCH are gated on).
ALTER TABLE "RunPlan" ADD COLUMN "feasibilityJson" JSONB;
