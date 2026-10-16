-- IVMS live link (16 Oct 2026): live truck positions and GPS stop times from the trucks' trackers at the
-- provider Ayun (a GPS-Server.net tracking platform). lib/ivms/*; docs/PROJECT_HANDBOOK.md.
--
-- Off by default and inert while off: every company gets ivmsMode 'OFF', in which RouteIQ makes no call to
-- Ayun, writes none of the new tables and shows nothing new (only the admin's tracker field and settings).
-- ROUTEIQ_DISABLE_IVMS=1 stops all IVMS work whatever the setting.
--
-- Additive only: nullable columns and constant defaults (catalog-only on PostgreSQL 11+, no table rewrite),
-- five new tables, CHECKs, no enum change (StopEventSource.AYUN exists since 20261004090000), no data change.
--   TenantConfig.ivms*       the company's IVMS settings (company admin), each CHECKed below.
--   Depot.ivmsZoneName       the Ayun zone of the depot (NULL = the depot pin and radius only).
--   Truck.ivmsImei           the truck's tracker IMEI, digits only, unique per company, never on a one-day
--                            hired truck (NULL = no tracker: the phone only, as before).
--   TruckPosition            the latest live position per truck (the live map only, never times).
--   TruckTrailPoint          the trucks' history pulled from Ayun (the only source of GPS times).
--   IvmsEvent                depot and zone moves (webhook, backstop, or from the trail).
--   IvmsState                one row per company: calls per class per UTC day, lease, backoff, counters.
--   IvmsTruckDay             per truck and delivery date: how far the history is pulled; GPS suppressed.
-- The app hides Truck.ivmsImei and Depot.ivmsZoneName from every existing read (Prisma global omit,
-- lib/db.ts), so no existing response, page, sheet, export or audit row changes.
-- Code from before this release never reads any of it, so an app rollback is safe for the database at any
-- time (the new rows stay unread). Set ivmsMode to 'OFF' (or ROUTEIQ_DISABLE_IVMS=1) before rolling back.
--
-- The lock (as in 20261016090000_customer_loading_instruction): ADD COLUMN and the CHECKs need a short ACCESS
-- EXCLUSIVE lock on "TenantConfig", "Depot" and "Truck", and the new tables' foreign keys a SHARE ROW EXCLUSIVE
-- lock on "Tenant" and "Truck". Railway runs this while the old version still serves, and a lock request that
-- queues behind a long transaction blocks every later read of the table (plan screen, driver page). So the
-- locks are taken first, all together, in two steps:
--  1. tried without waiting (NOWAIT) for 6 minutes: longer than any transaction of the app (Start fresh
--     may run 5 minutes), so a busy app delays the deploy but never makes it fail and never waits for it;
--  2. then waited for at most 5 s per try, 6 tries. Still not granted - something outside the app holds one
--     of the tables: the migration stops with "tables busy", nothing is changed, and the old version keeps
--     serving (P3018; the next deploy answers P3009 until
--     `prisma migrate resolve --rolled-back 20261016200000_ivms_live`, then redeploy: PROJECT_HANDBOOK.md
--     5.11). Find and end that transaction first (pg_stat_activity).
-- Prisma runs this file as one transaction, so the locks are held until the end (milliseconds: the tables
-- touched hold a few dozen rows; the new tables are empty).
--
-- Rollback (in this order):
--   DROP TABLE "IvmsTruckDay"; DROP TABLE "IvmsState"; DROP TABLE "IvmsEvent";
--   DROP TABLE "TruckTrailPoint"; DROP TABLE "TruckPosition";
--   DROP INDEX "Truck_tenantId_ivmsImei_key";
--   ALTER TABLE "Truck" DROP CONSTRAINT "Truck_ivmsImei_format", DROP CONSTRAINT "Truck_ivmsImei_not_one_day",
--     DROP COLUMN "ivmsImei";
--   ALTER TABLE "Depot" DROP CONSTRAINT "Depot_ivmsZoneName_length", DROP COLUMN "ivmsZoneName";
--   ALTER TABLE "TenantConfig" DROP CONSTRAINT "TenantConfig_ivmsMode_check",
--     DROP CONSTRAINT "TenantConfig_ivmsPollSec_range", DROP CONSTRAINT "TenantConfig_ivmsRoutePullMin_range",
--     DROP CONSTRAINT "TenantConfig_ivmsFromMin_range", DROP CONSTRAINT "TenantConfig_ivmsToMin_range",
--     DROP CONSTRAINT "TenantConfig_ivmsHours_order", DROP CONSTRAINT "TenantConfig_ivmsDailyCallBudget_range",
--     DROP CONSTRAINT "TenantConfig_ivmsStopRadiusM_range", DROP CONSTRAINT "TenantConfig_ivmsStopDwellMin_range",
--     DROP CONSTRAINT "TenantConfig_ivmsDepotRadiusM_range", DROP CONSTRAINT "TenantConfig_ivmsTrailDays_range",
--     DROP COLUMN "ivmsMode", DROP COLUMN "ivmsPollSec", DROP COLUMN "ivmsRoutePullMin",
--     DROP COLUMN "ivmsFromMin", DROP COLUMN "ivmsToMin", DROP COLUMN "ivmsDailyCallBudget",
--     DROP COLUMN "ivmsStopRadiusM", DROP COLUMN "ivmsStopDwellMin", DROP COLUMN "ivmsDepotRadiusM",
--     DROP COLUMN "ivmsTrailDays";
--   DELETE FROM "_prisma_migrations" WHERE migration_name = '20261016200000_ivms_live';

-- No statement or transaction time limit for this migration's transaction (is_local = true: nothing outside
-- it changes), so a limit set on the database or the role cannot cancel the lock step while it waits (as in
-- 20260930120000_orders_always_have_depot). transaction_timeout exists from PostgreSQL 17 on.
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
        LOCK TABLE "TenantConfig", "Depot", "Truck" IN ACCESS EXCLUSIVE MODE NOWAIT;
      ELSE
        PERFORM set_config('lock_timeout', '5s', true);
        LOCK TABLE "Tenant" IN SHARE ROW EXCLUSIVE MODE;
        LOCK TABLE "TenantConfig", "Depot", "Truck" IN ACCESS EXCLUSIVE MODE;
      END IF;
      EXIT;
    EXCEPTION WHEN lock_not_available OR deadlock_detected THEN
      -- The block's savepoint is rolled back: a lock it took before the one that failed is released too.
      IF waiting THEN
        waits := waits + 1;
        IF waits >= 6 THEN
          RAISE EXCEPTION 'tables busy: could not lock "Tenant", "TenantConfig", "Depot" and "Truck" for the IVMS live link in about 6.5 minutes (another transaction holds one of them); nothing was changed, end that transaction and deploy again';
        END IF;
      END IF;
    END;
    PERFORM pg_sleep(0.05 + random() * 0.1);
  END LOOP;
  PERFORM set_config('lock_timeout', '0', true);
END $$;

-- AlterTable
ALTER TABLE "TenantConfig" ADD COLUMN     "ivmsDailyCallBudget" INTEGER NOT NULL DEFAULT 100,
ADD COLUMN     "ivmsDepotRadiusM" INTEGER NOT NULL DEFAULT 300,
ADD COLUMN     "ivmsFromMin" INTEGER NOT NULL DEFAULT 300,
ADD COLUMN     "ivmsMode" TEXT NOT NULL DEFAULT 'OFF',
ADD COLUMN     "ivmsPollSec" INTEGER NOT NULL DEFAULT 60,
ADD COLUMN     "ivmsRoutePullMin" INTEGER NOT NULL DEFAULT 60,
ADD COLUMN     "ivmsStopDwellMin" INTEGER NOT NULL DEFAULT 3,
ADD COLUMN     "ivmsStopRadiusM" INTEGER NOT NULL DEFAULT 100,
ADD COLUMN     "ivmsToMin" INTEGER NOT NULL DEFAULT 1380,
ADD COLUMN     "ivmsTrailDays" INTEGER NOT NULL DEFAULT 2;

-- AlterTable
ALTER TABLE "Depot" ADD COLUMN     "ivmsZoneName" TEXT;

-- AlterTable
ALTER TABLE "Truck" ADD COLUMN     "ivmsImei" TEXT;

-- CreateTable
CREATE TABLE "TruckPosition" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "truckId" TEXT NOT NULL,
    "fixAt" TIMESTAMPTZ(3) NOT NULL,
    "serverAt" TIMESTAMPTZ(3),
    "receivedAt" TIMESTAMPTZ(3) NOT NULL,
    "lat" DOUBLE PRECISION NOT NULL,
    "lng" DOUBLE PRECISION NOT NULL,
    "speedKmh" DOUBLE PRECISION,
    "heading" INTEGER,
    "ignition" BOOLEAN,
    "flags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "movedAt" TIMESTAMPTZ(3),

    CONSTRAINT "TruckPosition_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TruckTrailPoint" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "truckId" TEXT NOT NULL,
    "fixAt" TIMESTAMPTZ(3) NOT NULL,
    "lat" DOUBLE PRECISION NOT NULL,
    "lng" DOUBLE PRECISION NOT NULL,
    "speedKmh" DOUBLE PRECISION,
    "ignition" BOOLEAN,

    CONSTRAINT "TruckTrailPoint_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IvmsEvent" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "truckId" TEXT NOT NULL,
    "depotId" TEXT,
    "kind" TEXT NOT NULL,
    "origin" TEXT NOT NULL,
    "eventAt" TIMESTAMPTZ(3) NOT NULL,
    "serverAt" TIMESTAMPTZ(3),
    "receivedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "zoneName" TEXT,
    "lat" DOUBLE PRECISION,
    "lng" DOUBLE PRECISION,
    "dedupeKey" TEXT NOT NULL,
    "processedAt" TIMESTAMPTZ(3),
    "outcome" TEXT,

    CONSTRAINT "IvmsEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IvmsState" (
    "tenantId" TEXT NOT NULL,
    "usageDay" DATE NOT NULL,
    "mapCalls" INTEGER NOT NULL DEFAULT 0,
    "routeCalls" INTEGER NOT NULL DEFAULT 0,
    "eventCalls" INTEGER NOT NULL DEFAULT 0,
    "adminCalls" INTEGER NOT NULL DEFAULT 0,
    "leaseUntil" TIMESTAMPTZ(3),
    "leaseOwner" TEXT,
    "mapLastAt" TIMESTAMPTZ(3),
    "eventsLastAt" TIMESTAMPTZ(3),
    "lastOkAt" TIMESTAMPTZ(3),
    "nextTryAt" TIMESTAMPTZ(3),
    "failures" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "lastErrorAt" TIMESTAMPTZ(3),
    "webhooksToday" INTEGER NOT NULL DEFAULT 0,
    "webhooksIgnored" INTEGER NOT NULL DEFAULT 0,
    "webhooksBadTime" INTEGER NOT NULL DEFAULT 0,
    "providerSkewSec" INTEGER,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "IvmsState_pkey" PRIMARY KEY ("tenantId")
);

-- CreateTable
CREATE TABLE "IvmsTruckDay" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "truckId" TEXT NOT NULL,
    "deliveryDate" DATE NOT NULL,
    "pulledTo" TIMESTAMPTZ(3),
    "lastPullAt" TIMESTAMPTZ(3),
    "pulls" INTEGER NOT NULL DEFAULT 0,
    "finalPullAt" TIMESTAMPTZ(3),
    "processedAt" TIMESTAMPTZ(3),
    "suppressedAt" TIMESTAMPTZ(3),
    "suppressReason" TEXT,

    CONSTRAINT "IvmsTruckDay_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "TruckPosition_truckId_key" ON "TruckPosition"("truckId");

-- CreateIndex
CREATE INDEX "TruckPosition_tenantId_receivedAt_idx" ON "TruckPosition"("tenantId", "receivedAt");

-- CreateIndex
CREATE INDEX "TruckTrailPoint_tenantId_fixAt_idx" ON "TruckTrailPoint"("tenantId", "fixAt");

-- CreateIndex
CREATE UNIQUE INDEX "TruckTrailPoint_tenantId_truckId_fixAt_key" ON "TruckTrailPoint"("tenantId", "truckId", "fixAt");

-- CreateIndex
CREATE INDEX "IvmsEvent_tenantId_truckId_eventAt_idx" ON "IvmsEvent"("tenantId", "truckId", "eventAt");

-- CreateIndex
CREATE INDEX "IvmsEvent_tenantId_processedAt_idx" ON "IvmsEvent"("tenantId", "processedAt");

-- CreateIndex
CREATE INDEX "IvmsEvent_tenantId_receivedAt_idx" ON "IvmsEvent"("tenantId", "receivedAt");

-- CreateIndex
CREATE UNIQUE INDEX "IvmsEvent_tenantId_dedupeKey_key" ON "IvmsEvent"("tenantId", "dedupeKey");

-- CreateIndex
CREATE INDEX "IvmsTruckDay_tenantId_deliveryDate_idx" ON "IvmsTruckDay"("tenantId", "deliveryDate");

-- CreateIndex
CREATE UNIQUE INDEX "IvmsTruckDay_tenantId_truckId_deliveryDate_key" ON "IvmsTruckDay"("tenantId", "truckId", "deliveryDate");

-- CreateIndex (every existing truck has NULL: NULLs never collide, so this cannot fail)
CREATE UNIQUE INDEX "Truck_tenantId_ivmsImei_key" ON "Truck"("tenantId", "ivmsImei");

-- AddForeignKey
ALTER TABLE "TruckPosition" ADD CONSTRAINT "TruckPosition_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TruckPosition" ADD CONSTRAINT "TruckPosition_truckId_fkey" FOREIGN KEY ("truckId") REFERENCES "Truck"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TruckTrailPoint" ADD CONSTRAINT "TruckTrailPoint_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TruckTrailPoint" ADD CONSTRAINT "TruckTrailPoint_truckId_fkey" FOREIGN KEY ("truckId") REFERENCES "Truck"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IvmsEvent" ADD CONSTRAINT "IvmsEvent_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IvmsEvent" ADD CONSTRAINT "IvmsEvent_truckId_fkey" FOREIGN KEY ("truckId") REFERENCES "Truck"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IvmsState" ADD CONSTRAINT "IvmsState_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IvmsTruckDay" ADD CONSTRAINT "IvmsTruckDay_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IvmsTruckDay" ADD CONSTRAINT "IvmsTruckDay_truckId_fkey" FOREIGN KEY ("truckId") REFERENCES "Truck"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- CHECKs (Prisma's schema has no CHECK constraints; `prisma migrate diff` leaves these alone). The app
-- refuses the same values first (lib/ivms/settings.ts IVMS_SETTING_BOUNDS, lib/schemas.ts), so a save
-- never reaches them as a 500. The lists are lib/ivms/types.ts's.

-- The company's IVMS settings. Modes: OFF (default) | MAP | TIMES; a later PR adds ALERTS here.
ALTER TABLE "TenantConfig" ADD CONSTRAINT "TenantConfig_ivmsMode_check" CHECK ("ivmsMode" IN ('OFF', 'MAP', 'TIMES'));
ALTER TABLE "TenantConfig" ADD CONSTRAINT "TenantConfig_ivmsPollSec_range" CHECK ("ivmsPollSec" BETWEEN 30 AND 900);
ALTER TABLE "TenantConfig" ADD CONSTRAINT "TenantConfig_ivmsRoutePullMin_range" CHECK ("ivmsRoutePullMin" BETWEEN 30 AND 240);
ALTER TABLE "TenantConfig" ADD CONSTRAINT "TenantConfig_ivmsFromMin_range" CHECK ("ivmsFromMin" BETWEEN 0 AND 1439);
ALTER TABLE "TenantConfig" ADD CONSTRAINT "TenantConfig_ivmsToMin_range" CHECK ("ivmsToMin" BETWEEN 1 AND 1440);
-- Operating hours never cross midnight (a loading night that runs late is covered by "a load still out").
ALTER TABLE "TenantConfig" ADD CONSTRAINT "TenantConfig_ivmsHours_order" CHECK ("ivmsToMin" > "ivmsFromMin");
ALTER TABLE "TenantConfig" ADD CONSTRAINT "TenantConfig_ivmsDailyCallBudget_range" CHECK ("ivmsDailyCallBudget" BETWEEN 10 AND 100000);
ALTER TABLE "TenantConfig" ADD CONSTRAINT "TenantConfig_ivmsStopRadiusM_range" CHECK ("ivmsStopRadiusM" BETWEEN 50 AND 300);
ALTER TABLE "TenantConfig" ADD CONSTRAINT "TenantConfig_ivmsStopDwellMin_range" CHECK ("ivmsStopDwellMin" BETWEEN 1 AND 30);
ALTER TABLE "TenantConfig" ADD CONSTRAINT "TenantConfig_ivmsDepotRadiusM_range" CHECK ("ivmsDepotRadiusM" BETWEEN 100 AND 2000);
-- Never longer than a week, and never 0 (TIMES reads its times from the trail). locationRetentionDays is at
-- least 30, so the trail is never kept longer than the driver positions.
ALTER TABLE "TenantConfig" ADD CONSTRAINT "TenantConfig_ivmsTrailDays_range" CHECK ("ivmsTrailDays" BETWEEN 1 AND 7);

-- A tracker IMEI is digits only; a one-day hired truck never has one (it is retired with the day, and its
-- mapping would block the tracker's next truck).
ALTER TABLE "Truck" ADD CONSTRAINT "Truck_ivmsImei_format" CHECK ("ivmsImei" IS NULL OR "ivmsImei" ~ '^[0-9]{10,20}$');
ALTER TABLE "Truck" ADD CONSTRAINT "Truck_ivmsImei_not_one_day" CHECK ("ivmsImei" IS NULL OR "onlyOnDate" IS NULL);

ALTER TABLE "Depot" ADD CONSTRAINT "Depot_ivmsZoneName_length" CHECK ("ivmsZoneName" IS NULL OR char_length("ivmsZoneName") BETWEEN 1 AND 80);

ALTER TABLE "TruckPosition" ADD CONSTRAINT "TruckPosition_values" CHECK (
  "lat" BETWEEN -90 AND 90 AND "lng" BETWEEN -180 AND 180
  AND ("speedKmh" IS NULL OR "speedKmh" BETWEEN 0 AND 400)
  AND ("heading" IS NULL OR "heading" BETWEEN 0 AND 359)
  AND ("flags" IS NULL OR "flags" <@ ARRAY['INVALID_FIX', 'CLOCK_AHEAD', 'DELAYED']::TEXT[])
);

ALTER TABLE "TruckTrailPoint" ADD CONSTRAINT "TruckTrailPoint_values" CHECK (
  "lat" BETWEEN -90 AND 90 AND "lng" BETWEEN -180 AND 180
  AND ("speedKmh" IS NULL OR "speedKmh" BETWEEN 0 AND 400)
);

ALTER TABLE "IvmsEvent" ADD CONSTRAINT "IvmsEvent_kind_check" CHECK ("kind" IN ('DEPOT_IN', 'DEPOT_OUT', 'ZONE_IN', 'ZONE_OUT'));
ALTER TABLE "IvmsEvent" ADD CONSTRAINT "IvmsEvent_origin_check" CHECK ("origin" IN ('WEBHOOK', 'BACKSTOP', 'TRAIL'));
ALTER TABLE "IvmsEvent" ADD CONSTRAINT "IvmsEvent_values" CHECK (
  ("zoneName" IS NULL OR char_length("zoneName") BETWEEN 1 AND 80)
  AND char_length("dedupeKey") BETWEEN 8 AND 64
  AND ("outcome" IS NULL OR "outcome" ~ '^[A-Z_]{1,40}$')
  AND ("lat" IS NULL OR "lat" BETWEEN -90 AND 90) AND ("lng" IS NULL OR "lng" BETWEEN -180 AND 180)
);

-- The counters never go below 0, and the last error is a kind code only: never a URL, a key or a body.
ALTER TABLE "IvmsState" ADD CONSTRAINT "IvmsState_values" CHECK (
  "mapCalls" >= 0 AND "routeCalls" >= 0 AND "eventCalls" >= 0 AND "adminCalls" >= 0 AND "failures" >= 0
  AND "webhooksToday" >= 0 AND "webhooksIgnored" >= 0 AND "webhooksBadTime" >= 0
  AND ("lastError" IS NULL OR "lastError" ~ '^[A-Z0-9_]{1,40}$')
);

ALTER TABLE "IvmsTruckDay" ADD CONSTRAINT "IvmsTruckDay_values" CHECK (
  "pulls" >= 0
  AND ("suppressReason" IS NULL OR "suppressReason" IN ('UNDO', 'MISMATCH', 'REMAP'))
  AND (("suppressedAt" IS NULL) = ("suppressReason" IS NULL))
);
