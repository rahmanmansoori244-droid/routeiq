-- The analysis dataset (owner request 19 Oct 2026: "build on more data for our analysis later and improvement";
-- the GPS study of 19 Oct 2026). lib/analysis/*; docs/PROJECT_HANDBOOK.md 3.22.
--
-- The trucks' GPS trail is deleted ivmsTrailDays (2 by default) after each fix and a StopVisit keeps only its
-- final rebuilt times, so what the study could measure (a second drop point, a pin 200 m off, a late result
-- tap, a trip out and back in the middle of a visit) is gone two days later. Four fact tables keep it, per
-- delivery date, for TenantConfig.analysisRetentionDays (730 by default):
--   FactTruckDay    per truck and date: time out, km, time at customer sites, moving, idle, overtime, loads.
--   FactVisit       per planned stop (the StopVisit key + customerId): plan against actual, wait, unloading on
--                   site (GPS) and by taps, the GPS sub-stays (distance and bearing from the pin only), the
--                   result and its changes, a late result tap, a pin offset.
--   FactLeg         per drive of a load: planned against actual drive minutes and km, the time of day.
--   FactDepotTurn   per return to the depot between loads: back to leave by GPS and by taps, cases loaded.
-- Each row keeps the plan values and the settings in force when it was built. No raw position anywhere: no
-- latitude or longitude column in these tables.
-- Written only by the nightly job (lib/analysis/job.ts, in the janitor); read only by GET /api/analysis/export.
--
-- Additive only: one column with a constant default on "TenantConfig" (catalog-only on PostgreSQL 11+, no
-- table rewrite) and its CHECK, four new empty tables with their CHECKs, no enum change, no data change. Code
-- from before this release never reads any of it: an app rollback is safe for the database at any time (the
-- rows stay unread).
--
-- The CHECKs (lib/analysis/types.ts holds the same lists; tests/lib/analysis-contract.spec.ts compares):
-- the retention 30-3650 days; unloading, waiting, on-site and away minutes never negative (the study's
-- prototype stored -49.6 min for a stop served before its window: the window was clipped on one side only);
-- the flags, the unload source, where the last depot IN came from and the GPS note from fixed lists; the two
-- JSON columns are arrays of at most 8 KB; a frozen row was built before it was frozen.
--
-- The lock (as in 20261016200000_ivms_live): ADD COLUMN and its CHECK need a short ACCESS EXCLUSIVE lock on
-- "TenantConfig", and the new tables' foreign keys a SHARE ROW EXCLUSIVE lock on "Tenant". Railway runs this
-- while the old version still serves, and a lock request that queues behind a long transaction blocks every
-- later read of the table. So the locks are taken first, together: tried without waiting (NOWAIT) for
-- 6 minutes (longer than any transaction of the app: Start fresh may run 5 minutes), then waited for at most
-- 5 s per try, 6 tries. Still busy: the migration stops with "tables busy", nothing is changed, and the old
-- version keeps serving (P3018; prisma migrate resolve --rolled-back 20261019090000_analysis_facts, then
-- redeploy: PROJECT_HANDBOOK.md 5.11). Prisma runs this file as one transaction, so the locks are held to
-- the end (milliseconds: "TenantConfig" has one row per company and the new tables are empty).
--
-- Rollback (in this order):
--   DROP TABLE "FactDepotTurn"; DROP TABLE "FactLeg"; DROP TABLE "FactVisit"; DROP TABLE "FactTruckDay";
--   ALTER TABLE "TenantConfig" DROP CONSTRAINT "TenantConfig_analysisRetentionDays_range",
--     DROP COLUMN "analysisRetentionDays";
--   DELETE FROM "_prisma_migrations" WHERE migration_name = '20261019090000_analysis_facts';

-- No statement or transaction time limit for this migration's transaction (is_local = true: nothing outside
-- it changes), so a limit set on the database or the role cannot cancel the lock step while it waits.
SELECT set_config('statement_timeout', '0', true);
SELECT set_config('transaction_timeout', '0', true) WHERE current_setting('server_version_num')::int >= 170000;

DO $$
DECLARE
  nowait_until timestamptz := clock_timestamp() + interval '6 minutes';
  waiting boolean := false;
  waits integer := 0;
BEGIN
  LOOP
    waiting := clock_timestamp() >= nowait_until;
    BEGIN
      IF NOT waiting THEN
        LOCK TABLE "Tenant" IN SHARE ROW EXCLUSIVE MODE NOWAIT;
        LOCK TABLE "TenantConfig" IN ACCESS EXCLUSIVE MODE NOWAIT;
      ELSE
        PERFORM set_config('lock_timeout', '5s', true);
        LOCK TABLE "Tenant" IN SHARE ROW EXCLUSIVE MODE;
        LOCK TABLE "TenantConfig" IN ACCESS EXCLUSIVE MODE;
      END IF;
      EXIT;
    EXCEPTION WHEN lock_not_available OR deadlock_detected THEN
      -- The block's savepoint is rolled back: a lock it took before the one that failed is released too.
      IF waiting THEN
        waits := waits + 1;
        IF waits >= 6 THEN
          RAISE EXCEPTION 'tables busy: could not lock "Tenant" and "TenantConfig" for the analysis dataset in about 6.5 minutes (another transaction holds one of them); nothing was changed, end that transaction and deploy again';
        END IF;
      END IF;
    END;
    PERFORM pg_sleep(0.05 + random() * 0.1);
  END LOOP;
  PERFORM set_config('lock_timeout', '0', true);
END $$;

-- AlterTable
ALTER TABLE "TenantConfig" ADD COLUMN     "analysisRetentionDays" INTEGER NOT NULL DEFAULT 730;

-- CreateTable
CREATE TABLE "FactTruckDay" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "depotId" TEXT NOT NULL,
    "deliveryDate" DATE NOT NULL,
    "truckId" TEXT NOT NULL,
    "truckCode" TEXT NOT NULL,
    "tracked" BOOLEAN NOT NULL DEFAULT false,
    "loads" INTEGER NOT NULL,
    "stopsPlanned" INTEGER NOT NULL,
    "stopsWithResult" INTEGER NOT NULL,
    "delivered" INTEGER NOT NULL,
    "partlyDelivered" INTEGER NOT NULL,
    "notDelivered" INTEGER NOT NULL,
    "casesPlanned" INTEGER NOT NULL,
    "casesDelivered" INTEGER NOT NULL,
    "plannedDepartMin" INTEGER,
    "plannedReturnMin" INTEGER,
    "plannedOutMin" INTEGER,
    "plannedKm" DOUBLE PRECISION,
    "firstOutAt" TIMESTAMPTZ(3),
    "lastInAt" TIMESTAMPTZ(3),
    "lastInFrom" TEXT,
    "outMin" DOUBLE PRECISION,
    "overtimeMin" DOUBLE PRECISION,
    "kmGps" DOUBLE PRECISION,
    "movingMin" DOUBLE PRECISION,
    "atSitesMin" DOUBLE PRECISION,
    "idleStops" INTEGER,
    "idleMin" DOUBLE PRECISION,
    "gpsTrips" INTEGER,
    "trailPoints" INTEGER NOT NULL DEFAULT 0,
    "trailFrom" TIMESTAMPTZ(3),
    "trailTo" TIMESTAMPTZ(3),
    "maxGapMin" DOUBLE PRECISION,
    "gapMinOver5" DOUBLE PRECISION,
    "frozenRuns" INTEGER,
    "frozenMin" DOUBLE PRECISION,
    "spikes" INTEGER,
    "ignitionSeen" BOOLEAN,
    "gpsNote" TEXT,
    "overtimeAfterMin" INTEGER NOT NULL,
    "serviceMinPerCase" DOUBLE PRECISION NOT NULL,
    "reloadMinutes" INTEGER NOT NULL,
    "loadingMinPerCase" DOUBLE PRECISION NOT NULL,
    "distanceMultiplier" DOUBLE PRECISION NOT NULL,
    "avgSpeedKmh" DOUBLE PRECISION NOT NULL,
    "roadTimeFactor" DOUBLE PRECISION NOT NULL,
    "stopRadiusM" INTEGER NOT NULL,
    "dwellMin" INTEGER NOT NULL,
    "detectorVersion" TEXT NOT NULL,
    "analysisVersion" TEXT NOT NULL,
    "builtAt" TIMESTAMPTZ(3) NOT NULL,
    "gpsBuiltAt" TIMESTAMPTZ(3),
    "refreshedAt" TIMESTAMPTZ(3) NOT NULL,
    "frozenAt" TIMESTAMPTZ(3),

    CONSTRAINT "FactTruckDay_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FactVisit" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "depotId" TEXT NOT NULL,
    "deliveryDate" DATE NOT NULL,
    "truckId" TEXT NOT NULL,
    "loadNo" INTEGER NOT NULL,
    "sequence" INTEGER NOT NULL,
    "customerId" TEXT NOT NULL,
    "visitId" TEXT,
    "truckCode" TEXT NOT NULL,
    "customerCode" TEXT NOT NULL,
    "customerType" TEXT,
    "baseServiceMin" INTEGER,
    "plannedEtaMin" INTEGER,
    "plannedServiceMin" INTEGER,
    "windowStartMin" INTEGER,
    "windowEndMin" INTEGER,
    "plannedKmFromPrev" DOUBLE PRECISION,
    "casesPlanned" INTEGER NOT NULL,
    "actualOrder" INTEGER,
    "arrivedAt" TIMESTAMPTZ(3),
    "arrivalSource" TEXT,
    "departedAt" TIMESTAMPTZ(3),
    "departureSource" TEXT,
    "departedAtOutcome" BOOLEAN NOT NULL DEFAULT false,
    "arrivalVsEtaMin" DOUBLE PRECISION,
    "outcome" TEXT,
    "reason" TEXT,
    "outcomeAt" TIMESTAMPTZ(3),
    "outcomeSource" TEXT,
    "firstOutcome" TEXT,
    "firstOutcomeAt" TIMESTAMPTZ(3),
    "outcomeEvents" INTEGER NOT NULL DEFAULT 0,
    "resultChanged" BOOLEAN NOT NULL DEFAULT false,
    "casesDelivered" INTEGER,
    "resultTapAt" TIMESTAMPTZ(3),
    "truckDistAtResultM" DOUBLE PRECISION,
    "lateResultTap" BOOLEAN,
    "siteStartAt" TIMESTAMPTZ(3),
    "siteEndAt" TIMESTAMPTZ(3),
    "onSiteMin" DOUBLE PRECISION,
    "awayCount" INTEGER,
    "awayMin" DOUBLE PRECISION,
    "awayJson" JSONB,
    "substays" INTEGER,
    "substaysJson" JSONB,
    "dropPoints" INTEGER,
    "maxDistM" DOUBLE PRECISION,
    "closestM" DOUBLE PRECISION,
    "standDistM" DOUBLE PRECISION,
    "standBearingDeg" DOUBLE PRECISION,
    "pinOffset" BOOLEAN,
    "detectorStays" INTEGER,
    "servedBeforeWindow" BOOLEAN,
    "waitMin" DOUBLE PRECISION,
    "unloadSiteMin" DOUBLE PRECISION,
    "unloadVisitMin" DOUBLE PRECISION,
    "unloadTapMin" DOUBLE PRECISION,
    "unloadMin" DOUBLE PRECISION,
    "unloadSource" TEXT,
    "usableForRate" BOOLEAN NOT NULL DEFAULT false,
    "minPerCase" DOUBLE PRECISION,
    "flags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "serviceMinPerCase" DOUBLE PRECISION NOT NULL,
    "reloadMinutes" INTEGER NOT NULL,
    "stopRadiusM" INTEGER NOT NULL,
    "dwellMin" INTEGER NOT NULL,
    "detectorVersion" TEXT NOT NULL,
    "analysisVersion" TEXT NOT NULL,
    "builtAt" TIMESTAMPTZ(3) NOT NULL,
    "gpsBuiltAt" TIMESTAMPTZ(3),
    "refreshedAt" TIMESTAMPTZ(3) NOT NULL,
    "frozenAt" TIMESTAMPTZ(3),

    CONSTRAINT "FactVisit_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FactLeg" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "depotId" TEXT NOT NULL,
    "deliveryDate" DATE NOT NULL,
    "truckId" TEXT NOT NULL,
    "truckCode" TEXT NOT NULL,
    "loadNo" INTEGER NOT NULL,
    "legNo" INTEGER NOT NULL,
    "fromSeq" INTEGER,
    "toSeq" INTEGER,
    "inPlanOrder" BOOLEAN,
    "leftAt" TIMESTAMPTZ(3),
    "arrivedAt" TIMESTAMPTZ(3),
    "leftMin" INTEGER,
    "hourOfDay" INTEGER,
    "driveMin" DOUBLE PRECISION,
    "driveMinVisit" DOUBLE PRECISION,
    "plannedDriveMin" INTEGER,
    "kmGps" DOUBLE PRECISION,
    "plannedKm" DOUBLE PRECISION,
    "kmStraight" DOUBLE PRECISION,
    "note" TEXT,
    "serviceMinPerCase" DOUBLE PRECISION NOT NULL,
    "reloadMinutes" INTEGER NOT NULL,
    "distanceMultiplier" DOUBLE PRECISION NOT NULL,
    "avgSpeedKmh" DOUBLE PRECISION NOT NULL,
    "roadTimeFactor" DOUBLE PRECISION NOT NULL,
    "stopRadiusM" INTEGER NOT NULL,
    "dwellMin" INTEGER NOT NULL,
    "detectorVersion" TEXT NOT NULL,
    "analysisVersion" TEXT NOT NULL,
    "builtAt" TIMESTAMPTZ(3) NOT NULL,
    "gpsBuiltAt" TIMESTAMPTZ(3),
    "refreshedAt" TIMESTAMPTZ(3) NOT NULL,
    "frozenAt" TIMESTAMPTZ(3),

    CONSTRAINT "FactLeg_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FactDepotTurn" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "depotId" TEXT NOT NULL,
    "deliveryDate" DATE NOT NULL,
    "truckId" TEXT NOT NULL,
    "truckCode" TEXT NOT NULL,
    "afterLoadNo" INTEGER NOT NULL,
    "nextLoadNo" INTEGER NOT NULL,
    "backGpsAt" TIMESTAMPTZ(3),
    "leaveGpsAt" TIMESTAMPTZ(3),
    "turnMinGps" DOUBLE PRECISION,
    "backTapAt" TIMESTAMPTZ(3),
    "leaveTapAt" TIMESTAMPTZ(3),
    "turnMinTaps" DOUBLE PRECISION,
    "casesLoaded" INTEGER NOT NULL,
    "plannedTurnMin" INTEGER,
    "minPerCaseLoading" DOUBLE PRECISION,
    "serviceMinPerCase" DOUBLE PRECISION NOT NULL,
    "reloadMinutes" INTEGER NOT NULL,
    "loadingMinPerCase" DOUBLE PRECISION NOT NULL,
    "stopRadiusM" INTEGER NOT NULL,
    "dwellMin" INTEGER NOT NULL,
    "detectorVersion" TEXT NOT NULL,
    "analysisVersion" TEXT NOT NULL,
    "builtAt" TIMESTAMPTZ(3) NOT NULL,
    "gpsBuiltAt" TIMESTAMPTZ(3),
    "refreshedAt" TIMESTAMPTZ(3) NOT NULL,
    "frozenAt" TIMESTAMPTZ(3),

    CONSTRAINT "FactDepotTurn_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "FactTruckDay_tenantId_deliveryDate_idx" ON "FactTruckDay"("tenantId", "deliveryDate");

-- CreateIndex
CREATE UNIQUE INDEX "FactTruckDay_tenantId_deliveryDate_truckId_key" ON "FactTruckDay"("tenantId", "deliveryDate", "truckId");

-- CreateIndex
CREATE INDEX "FactVisit_tenantId_deliveryDate_idx" ON "FactVisit"("tenantId", "deliveryDate");

-- CreateIndex
CREATE INDEX "FactVisit_tenantId_customerId_deliveryDate_idx" ON "FactVisit"("tenantId", "customerId", "deliveryDate");

-- CreateIndex
CREATE UNIQUE INDEX "FactVisit_tenantId_depotId_deliveryDate_truckId_loadNo_sequ_key" ON "FactVisit"("tenantId", "depotId", "deliveryDate", "truckId", "loadNo", "sequence");

-- CreateIndex
CREATE INDEX "FactLeg_tenantId_deliveryDate_idx" ON "FactLeg"("tenantId", "deliveryDate");

-- CreateIndex
CREATE UNIQUE INDEX "FactLeg_tenantId_depotId_deliveryDate_truckId_loadNo_legNo_key" ON "FactLeg"("tenantId", "depotId", "deliveryDate", "truckId", "loadNo", "legNo");

-- CreateIndex
CREATE INDEX "FactDepotTurn_tenantId_deliveryDate_idx" ON "FactDepotTurn"("tenantId", "deliveryDate");

-- CreateIndex
CREATE UNIQUE INDEX "FactDepotTurn_tenantId_depotId_deliveryDate_truckId_afterLo_key" ON "FactDepotTurn"("tenantId", "depotId", "deliveryDate", "truckId", "afterLoadNo");

-- AddForeignKey
ALTER TABLE "FactTruckDay" ADD CONSTRAINT "FactTruckDay_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FactVisit" ADD CONSTRAINT "FactVisit_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FactLeg" ADD CONSTRAINT "FactLeg_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FactDepotTurn" ADD CONSTRAINT "FactDepotTurn_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- The retention of the facts (company admin, Settings): 30 days to 10 years.
ALTER TABLE "TenantConfig" ADD CONSTRAINT "TenantConfig_analysisRetentionDays_range" CHECK ("analysisRetentionDays" BETWEEN 30 AND 3650);

-- Where the last depot IN came from, and why the GPS columns are empty (lib/analysis/types.ts).
ALTER TABLE "FactTruckDay" ADD CONSTRAINT "FactTruckDay_lastInFrom_check" CHECK ("lastInFrom" IS NULL OR "lastInFrom" IN ('TRAIL', 'DEVICE_EVENT'));
ALTER TABLE "FactTruckDay" ADD CONSTRAINT "FactTruckDay_gpsNote_check" CHECK ("gpsNote" IS NULL OR "gpsNote" IN ('NO_TRACKER', 'NO_TRAIL', 'SUPPRESSED'));
ALTER TABLE "FactTruckDay" ADD CONSTRAINT "FactTruckDay_minutes_nonneg" CHECK (
  ("outMin" IS NULL OR "outMin" >= 0) AND ("overtimeMin" IS NULL OR "overtimeMin" >= 0) AND ("kmGps" IS NULL OR "kmGps" >= 0)
  AND ("movingMin" IS NULL OR "movingMin" >= 0) AND ("atSitesMin" IS NULL OR "atSitesMin" >= 0) AND ("idleMin" IS NULL OR "idleMin" >= 0)
);
ALTER TABLE "FactTruckDay" ADD CONSTRAINT "FactTruckDay_frozen_after_built" CHECK ("frozenAt" IS NULL OR "frozenAt" >= "builtAt");

-- Unloading is never negative: the window is clipped on both sides (a stop served before its window opened
-- counts from the arrival), and the time away from the site is never in it.
ALTER TABLE "FactVisit" ADD CONSTRAINT "FactVisit_minutes_nonneg" CHECK (
  ("waitMin" IS NULL OR "waitMin" >= 0) AND ("onSiteMin" IS NULL OR "onSiteMin" >= 0) AND ("awayMin" IS NULL OR "awayMin" >= 0)
  AND ("unloadSiteMin" IS NULL OR "unloadSiteMin" >= 0) AND ("unloadVisitMin" IS NULL OR "unloadVisitMin" >= 0)
  AND ("unloadTapMin" IS NULL OR "unloadTapMin" >= 0) AND ("unloadMin" IS NULL OR "unloadMin" >= 0) AND ("minPerCase" IS NULL OR "minPerCase" >= 0)
);
ALTER TABLE "FactVisit" ADD CONSTRAINT "FactVisit_unloadSource_check" CHECK ("unloadSource" IS NULL OR "unloadSource" IN ('GPS_SITE', 'VISIT'));
ALTER TABLE "FactVisit" ADD CONSTRAINT "FactVisit_flags_check" CHECK ("flags" <@ ARRAY['LATE_RESULT_TAP', 'PIN_OFFSET', 'MULTI_DROP', 'LEFT_AND_RETURNED', 'PREMATURE_DEP', 'SPLIT_STAYS', 'SHARED_SITE', 'NEAR_DEPOT', 'RESULT_CHANGED', 'PHOTO_FAR', 'NO_GPS', 'GPS_NOT_SEEN']::TEXT[]);
-- Distances and bearings from the pin only (never a position), as JSON arrays of at most 8 KB.
ALTER TABLE "FactVisit" ADD CONSTRAINT "FactVisit_awayJson_shape" CHECK ("awayJson" IS NULL OR (jsonb_typeof("awayJson") = 'array' AND octet_length("awayJson"::text) <= 8192));
ALTER TABLE "FactVisit" ADD CONSTRAINT "FactVisit_substaysJson_shape" CHECK ("substaysJson" IS NULL OR (jsonb_typeof("substaysJson") = 'array' AND octet_length("substaysJson"::text) <= 8192));
ALTER TABLE "FactVisit" ADD CONSTRAINT "FactVisit_frozen_after_built" CHECK ("frozenAt" IS NULL OR "frozenAt" >= "builtAt");

ALTER TABLE "FactLeg" ADD CONSTRAINT "FactLeg_legNo_range" CHECK ("legNo" >= 1);
ALTER TABLE "FactLeg" ADD CONSTRAINT "FactLeg_minutes_nonneg" CHECK (("driveMin" IS NULL OR "driveMin" >= 0) AND ("kmGps" IS NULL OR "kmGps" >= 0));
ALTER TABLE "FactLeg" ADD CONSTRAINT "FactLeg_frozen_after_built" CHECK ("frozenAt" IS NULL OR "frozenAt" >= "builtAt");

ALTER TABLE "FactDepotTurn" ADD CONSTRAINT "FactDepotTurn_minutes_nonneg" CHECK (("turnMinGps" IS NULL OR "turnMinGps" >= 0) AND ("turnMinTaps" IS NULL OR "turnMinTaps" >= 0));
ALTER TABLE "FactDepotTurn" ADD CONSTRAINT "FactDepotTurn_frozen_after_built" CHECK ("frozenAt" IS NULL OR "frozenAt" >= "builtAt");
