-- Stabilization PR5 (review F17): the cost breakdown of each load under the one cost model
-- (driver paid for the whole truck day). Additive only: one nullable JSONB column with no default,
-- a metadata-only change on PostgreSQL 11+ (no table rewrite, a brief lock). Existing rows stay
-- NULL: their stored operatingCost is kept and plans holding them are labelled as costed the
-- earlier way (without depot time and overtime). Old app code ignores the column, so a rollback
-- of the app is safe.
ALTER TABLE "PlanLoad" ADD COLUMN "costJson" JSONB;
