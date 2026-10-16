-- Operations alerts (owner request 16 Oct 2026: "notify me when a rule I set is broken: unloading longer
-- than planned by 30 min, loading in the warehouse longer than 40 min, a driver's ETA more than 30 min
-- late, plus any other rule you find important"). lib/alerts/catalog.ts holds the rules, their defaults
-- and the bounds the CHECKs below repeat (tests/lib/alert-catalog.spec.ts compares them).
--
-- Additive only, and nothing changes until a company admin switches alerts on:
-- - TenantConfig: the master switch "alertsEnabled" (NOT NULL DEFAULT false: every company stays off),
--   "alertsEnabledAt" (set by the save that switches alerts on: nothing older raises an alert),
--   "alertRuleOnAtJson" (the same stamp per rule, when a rule is switched on or set to catch more), one
--   nullable threshold per rule (NULL = the rule is off; "alertLoadingOverMin" is NULL, off, until the
--   warehouse records loading start and end per truck), "alertDeliveredNote" (on/off), the e-mail
--   settings (recipients NULL = in the app only; HIGH alerts only; quiet hours 22:00-06:00). Constant
--   defaults: on PostgreSQL 11+ a catalog change only, no table rewrite.
-- - PlanLoad."loadedAt" / "loadedById" (FK User ON DELETE SET NULL): the warehouse's "Loaded" action
--   (allowed only while the load is LOADING). Nullable, no default: a catalog change only.
-- - New table "OpsAlert": one row per rule and physical subject (UNIQUE tenantId, rule, subjectKey: two
--   sweeps during a deploy overlap raise one row), CASCADE with the company, SET NULL with the user who
--   acknowledged it. "rule" is checked in the app (a new rule needs no migration); kind, severity and the
--   tiers are CHECKed here.
-- - New table "OpsAlertDigest": one row per alert e-mail (counts only, never an address): the e-mail
--   throttle and the daily cap count them.
-- Nothing existing is rewritten. Code from before this release never reads the new columns or tables, so
-- an app rollback is safe at any time.
--
-- Railway runs migrations while the previous version still serves (docs/PROJECT_HANDBOOK.md 5.6). The
-- ALTER TABLEs need a short exclusive lock on "TenantConfig" and "PlanLoad"; waiting behind a long
-- transaction would queue every reader of those tables behind it. So the migration waits at most 5 s
-- for each lock: if a lock is not free, the deploy fails, nothing is applied (Prisma runs this file as
-- one transaction: see 20260930120000_orders_always_have_depot) and the old version keeps serving.
-- Deploy again later. SET LOCAL ends with this migration's transaction, so later migrations are not
-- affected. "PlanLoad" is altered first: a re-plan can hold it for seconds, and while the migration
-- waits for it, it holds nothing else; "TenantConfig" (read by every page, in short reads) comes second,
-- so it is held only for that short second wait. Deploy outside the busy hours anyway (not 06:00-07:30
-- Dispatch, not the evening planning, not the 21:00 loading).
--
-- Rollback: DROP TABLE "OpsAlertDigest"; DROP TABLE "OpsAlert";
--           ALTER TABLE "PlanLoad" DROP COLUMN "loadedAt", DROP COLUMN "loadedById";
--           ALTER TABLE "TenantConfig" DROP COLUMN "alertsEnabled", DROP COLUMN "alertsEnabledAt",
--             DROP COLUMN "alertUnloadOverMin", DROP COLUMN "alertLoadingOverMin", DROP COLUMN "alertEtaLateMin",
--             DROP COLUMN "alertDepartLateMin", DROP COLUMN "alertSilentMin", DROP COLUMN "alertPageNotOpenedMin",
--             DROP COLUMN "alertAfterClosingMin", DROP COLUMN "alertPriorityMax", DROP COLUMN "alertDeliveredNote",
--             DROP COLUMN "alertProofFarM", DROP COLUMN "alertNotClosedMin", DROP COLUMN "alertEmails",
--             DROP COLUMN "alertEmailEveryMin", DROP COLUMN "alertEmailMinSeverity", DROP COLUMN "alertQuietFromMin",
--             DROP COLUMN "alertQuietToMin", DROP COLUMN "alertRuleOnAtJson";
--           (each CHECK below goes with its columns or table).

SET LOCAL lock_timeout = '5s';

-- AlterTable
ALTER TABLE "PlanLoad" ADD COLUMN     "loadedAt" TIMESTAMP(3),
ADD COLUMN     "loadedById" TEXT;

-- AlterTable
ALTER TABLE "TenantConfig" ADD COLUMN     "alertAfterClosingMin" INTEGER DEFAULT 15,
ADD COLUMN     "alertDeliveredNote" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "alertDepartLateMin" INTEGER DEFAULT 30,
ADD COLUMN     "alertEmailEveryMin" INTEGER NOT NULL DEFAULT 15,
ADD COLUMN     "alertEmailMinSeverity" TEXT NOT NULL DEFAULT 'HIGH',
ADD COLUMN     "alertEmails" TEXT,
ADD COLUMN     "alertEtaLateMin" INTEGER DEFAULT 30,
ADD COLUMN     "alertLoadingOverMin" INTEGER,
ADD COLUMN     "alertNotClosedMin" INTEGER DEFAULT 120,
ADD COLUMN     "alertPageNotOpenedMin" INTEGER DEFAULT 30,
ADD COLUMN     "alertPriorityMax" INTEGER DEFAULT 2,
ADD COLUMN     "alertProofFarM" INTEGER DEFAULT 500,
ADD COLUMN     "alertQuietFromMin" INTEGER DEFAULT 1320,
ADD COLUMN     "alertQuietToMin" INTEGER DEFAULT 360,
ADD COLUMN     "alertRuleOnAtJson" JSONB,
ADD COLUMN     "alertSilentMin" INTEGER DEFAULT 120,
ADD COLUMN     "alertUnloadOverMin" INTEGER DEFAULT 30,
ADD COLUMN     "alertsEnabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "alertsEnabledAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "OpsAlert" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "depotId" TEXT NOT NULL,
    "deliveryDate" DATE NOT NULL,
    "rule" TEXT NOT NULL,
    "subjectKey" TEXT NOT NULL,
    "truckId" TEXT NOT NULL,
    "truckCode" TEXT NOT NULL,
    "loadNo" INTEGER,
    "sequence" INTEGER,
    "customerId" TEXT,
    "kind" TEXT NOT NULL,
    "severity" TEXT NOT NULL,
    "tier" INTEGER NOT NULL DEFAULT 1,
    "value" INTEGER NOT NULL,
    "threshold" INTEGER NOT NULL,
    "text" TEXT NOT NULL,
    "factsJson" JSONB,
    "mayToast" BOOLEAN NOT NULL DEFAULT true,
    "mayEmail" BOOLEAN NOT NULL DEFAULT true,
    "occurredAt" TIMESTAMPTZ(3) NOT NULL,
    "firstSeenAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMPTZ(3),
    "resolvedReason" TEXT,
    "occurrences" INTEGER NOT NULL DEFAULT 1,
    "ackedAt" TIMESTAMPTZ(3),
    "ackedById" TEXT,
    "emailedTier" INTEGER NOT NULL DEFAULT 0,
    "emailedAt" TIMESTAMPTZ(3),
    "digestId" TEXT,
    "emailAttempts" INTEGER NOT NULL DEFAULT 0,
    "emailError" TEXT,

    CONSTRAINT "OpsAlert_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OpsAlertDigest" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "status" TEXT NOT NULL DEFAULT 'SENDING',
    "alertCount" INTEGER NOT NULL,
    "highCount" INTEGER NOT NULL,
    "recipientCount" INTEGER NOT NULL,
    "sentAt" TIMESTAMPTZ(3),
    "error" TEXT,

    CONSTRAINT "OpsAlertDigest_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "OpsAlert_tenantId_deliveryDate_idx" ON "OpsAlert"("tenantId", "deliveryDate");

-- CreateIndex
CREATE INDEX "OpsAlert_tenantId_resolvedAt_ackedAt_idx" ON "OpsAlert"("tenantId", "resolvedAt", "ackedAt");

-- CreateIndex
CREATE INDEX "OpsAlert_tenantId_lastSeenAt_idx" ON "OpsAlert"("tenantId", "lastSeenAt");

-- CreateIndex
CREATE UNIQUE INDEX "OpsAlert_tenantId_rule_subjectKey_key" ON "OpsAlert"("tenantId", "rule", "subjectKey");

-- CreateIndex
CREATE INDEX "OpsAlertDigest_tenantId_createdAt_idx" ON "OpsAlertDigest"("tenantId", "createdAt");

-- AddForeignKey
ALTER TABLE "PlanLoad" ADD CONSTRAINT "PlanLoad_loadedById_fkey" FOREIGN KEY ("loadedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OpsAlert" ADD CONSTRAINT "OpsAlert_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OpsAlert" ADD CONSTRAINT "OpsAlert_ackedById_fkey" FOREIGN KEY ("ackedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OpsAlertDigest" ADD CONSTRAINT "OpsAlertDigest_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- The bounds of lib/alerts/catalog.ts (the API refuses values outside them first: lib/schemas.ts).
-- Prisma's schema has no CHECK constraints; `prisma migrate diff` leaves these alone.
ALTER TABLE "TenantConfig" ADD CONSTRAINT "TenantConfig_alertUnloadOverMin_range" CHECK ("alertUnloadOverMin" IS NULL OR "alertUnloadOverMin" BETWEEN 5 AND 480);
ALTER TABLE "TenantConfig" ADD CONSTRAINT "TenantConfig_alertLoadingOverMin_range" CHECK ("alertLoadingOverMin" IS NULL OR "alertLoadingOverMin" BETWEEN 5 AND 480);
ALTER TABLE "TenantConfig" ADD CONSTRAINT "TenantConfig_alertEtaLateMin_range" CHECK ("alertEtaLateMin" IS NULL OR "alertEtaLateMin" BETWEEN 10 AND 480);
ALTER TABLE "TenantConfig" ADD CONSTRAINT "TenantConfig_alertDepartLateMin_range" CHECK ("alertDepartLateMin" IS NULL OR "alertDepartLateMin" BETWEEN 5 AND 480);
ALTER TABLE "TenantConfig" ADD CONSTRAINT "TenantConfig_alertSilentMin_range" CHECK ("alertSilentMin" IS NULL OR "alertSilentMin" BETWEEN 30 AND 600);
ALTER TABLE "TenantConfig" ADD CONSTRAINT "TenantConfig_alertPageNotOpenedMin_range" CHECK ("alertPageNotOpenedMin" IS NULL OR "alertPageNotOpenedMin" BETWEEN 10 AND 240);
ALTER TABLE "TenantConfig" ADD CONSTRAINT "TenantConfig_alertAfterClosingMin_range" CHECK ("alertAfterClosingMin" IS NULL OR "alertAfterClosingMin" BETWEEN 0 AND 240);
ALTER TABLE "TenantConfig" ADD CONSTRAINT "TenantConfig_alertPriorityMax_range" CHECK ("alertPriorityMax" IS NULL OR "alertPriorityMax" BETWEEN 1 AND 5);
ALTER TABLE "TenantConfig" ADD CONSTRAINT "TenantConfig_alertProofFarM_range" CHECK ("alertProofFarM" IS NULL OR "alertProofFarM" BETWEEN 150 AND 20000);
ALTER TABLE "TenantConfig" ADD CONSTRAINT "TenantConfig_alertNotClosedMin_range" CHECK ("alertNotClosedMin" IS NULL OR "alertNotClosedMin" BETWEEN 30 AND 720);
ALTER TABLE "TenantConfig" ADD CONSTRAINT "TenantConfig_alertEmails_length" CHECK ("alertEmails" IS NULL OR char_length("alertEmails") <= 500);
ALTER TABLE "TenantConfig" ADD CONSTRAINT "TenantConfig_alertEmailEveryMin_range" CHECK ("alertEmailEveryMin" BETWEEN 0 AND 240);
ALTER TABLE "TenantConfig" ADD CONSTRAINT "TenantConfig_alertEmailMinSeverity_check" CHECK ("alertEmailMinSeverity" IN ('HIGH', 'WARN'));
-- Quiet hours: both set (from <> to; minutes from local midnight, may pass midnight: 22:00-06:00) or both NULL.
ALTER TABLE "TenantConfig" ADD CONSTRAINT "TenantConfig_alertQuietHours_check" CHECK (
  ("alertQuietFromMin" IS NULL AND "alertQuietToMin" IS NULL)
  OR ("alertQuietFromMin" BETWEEN 0 AND 1439 AND "alertQuietToMin" BETWEEN 0 AND 1439 AND "alertQuietFromMin" <> "alertQuietToMin")
);
ALTER TABLE "OpsAlert" ADD CONSTRAINT "OpsAlert_kind_check" CHECK ("kind" IN ('CONDITION', 'EVENT'));
ALTER TABLE "OpsAlert" ADD CONSTRAINT "OpsAlert_severity_check" CHECK ("severity" IN ('WARN', 'HIGH'));
ALTER TABLE "OpsAlert" ADD CONSTRAINT "OpsAlert_tier_range" CHECK ("tier" BETWEEN 1 AND 3);
ALTER TABLE "OpsAlert" ADD CONSTRAINT "OpsAlert_emailedTier_range" CHECK ("emailedTier" BETWEEN 0 AND 3);
ALTER TABLE "OpsAlertDigest" ADD CONSTRAINT "OpsAlertDigest_status_check" CHECK ("status" IN ('SENDING', 'SENT', 'FAILED'));
