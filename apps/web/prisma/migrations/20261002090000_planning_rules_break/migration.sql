-- Planning rules phase B: the driver break (owner rule 29-30 Sep 2026).
-- Additive only. The break is off (0) until the dispatcher sets it in Settings; no data is changed.
ALTER TABLE "TenantConfig"
  ADD COLUMN "driverBreakMinutes" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "driverBreakFromMin" INTEGER NOT NULL DEFAULT 720,
  ADD COLUMN "driverBreakToMin" INTEGER NOT NULL DEFAULT 840;

-- The driver break planned with each load (NULL = none on this load).
ALTER TABLE "PlanLoad" ADD COLUMN "breakJson" JSONB;
