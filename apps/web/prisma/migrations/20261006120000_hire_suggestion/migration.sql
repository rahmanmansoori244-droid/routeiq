-- The hire suggestion (owner request 6 Oct 2026): when the day's orders are more than the fleet can
-- carry, RouteIQ says which trucks to RENT ("hire 1 x 10-ton + 1 x 3-ton"). Additive: two new tables,
-- two nullable columns on "Truck" and one setting with a default on "TenantConfig"; no existing row needs
-- a value, and NOTHING is seeded (a company admin enters the company's own hire options on the Trucks
-- page after the deploy, and its daily driver day rate on Settings).

-- AlterTable: the daily driver day rate (owner answer 4, 6 Oct 2026): the casual driver of a truck hired
-- for the day is paid this per day (OMR), fixed, instead of the hourly driver cost and overtime; own
-- trucks keep theirs. A rough 10 OMR for every company until its admin sets it.
ALTER TABLE "TenantConfig" ADD COLUMN     "dailyDriverDayRate" DOUBLE PRECISION NOT NULL DEFAULT 10;
ALTER TABLE "TenantConfig" ADD CONSTRAINT "TenantConfig_dailyDriverDayRate_range" CHECK ("dailyDriverDayRate" BETWEEN 0 AND 1000);

-- AlterTable: a one-day truck ("Use this plan" rents it for one delivery date only; every plan of
-- another day leaves it out and the janitor retires it once that day is over), and the hire option
-- it was rented from (its "max per day" counts it). Both NULL on every existing truck.
ALTER TABLE "Truck" ADD COLUMN     "hireOptionId" TEXT,
ADD COLUMN     "onlyOnDate" DATE;

-- CreateTable: the trucks a company can rent for a day, per depot (company admin).
CREATE TABLE "HireOption" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "depotId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "bays" INTEGER,
    "capacityCases" INTEGER NOT NULL DEFAULT 0,
    "payloadKg" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "costPerDay" DOUBLE PRECISION NOT NULL,
    "costPerKm" DOUBLE PRECISION,
    "maxPerDay" INTEGER NOT NULL DEFAULT 1,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "HireOption_pkey" PRIMARY KEY ("id")
);

-- The same bounds as the app's (lib/schemas.ts hireOptionSchema; the optimizer's DispatchTruck): a
-- direct database edit outside them is refused.
ALTER TABLE "HireOption" ADD CONSTRAINT "HireOption_values_range" CHECK (
  ("bays" IS NULL OR "bays" BETWEEN 1 AND 40)
  AND "capacityCases" BETWEEN 0 AND 100000
  AND "payloadKg" BETWEEN 0 AND 100000
  AND "costPerDay" > 0 AND "costPerDay" <= 100000
  AND ("costPerKm" IS NULL OR "costPerKm" BETWEEN 0 AND 1000)
  AND "maxPerDay" BETWEEN 1 AND 10
  AND ("bays" IS NOT NULL OR "capacityCases" > 0)
);

-- CreateTable: one what-if optimization of the hire suggestion per plan version (its own job state,
-- never the plan's RunJob: it never delays or changes the dispatcher's plan).
CREATE TABLE "HireSuggestion" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "status" "RunJobStatus" NOT NULL DEFAULT 'QUEUED',
    "trigger" TEXT NOT NULL,
    "message" TEXT,
    "basisJson" JSONB NOT NULL,
    "requestJson" JSONB,
    "responseJson" JSONB,
    "summaryJson" JSONB,
    "errorJson" JSONB,
    "createdById" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" TIMESTAMPTZ(3),
    "finishedAt" TIMESTAMPTZ(3),
    "heartbeatAt" TIMESTAMPTZ(3),
    "usedAt" TIMESTAMPTZ(3),
    "usedById" TEXT,
    "usedRunId" TEXT,

    CONSTRAINT "HireSuggestion_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "HireOption_tenantId_depotId_idx" ON "HireOption"("tenantId", "depotId");

-- CreateIndex
CREATE UNIQUE INDEX "HireOption_tenantId_depotId_label_key" ON "HireOption"("tenantId", "depotId", "label");

-- CreateIndex
CREATE INDEX "HireSuggestion_tenantId_runId_idx" ON "HireSuggestion"("tenantId", "runId");

-- CreateIndex
CREATE INDEX "HireSuggestion_tenantId_status_idx" ON "HireSuggestion"("tenantId", "status");

-- CreateIndex
CREATE INDEX "Truck_tenantId_onlyOnDate_idx" ON "Truck"("tenantId", "onlyOnDate");

-- AddForeignKey
ALTER TABLE "Truck" ADD CONSTRAINT "Truck_hireOptionId_fkey" FOREIGN KEY ("hireOptionId") REFERENCES "HireOption"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HireOption" ADD CONSTRAINT "HireOption_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HireOption" ADD CONSTRAINT "HireOption_depotId_fkey" FOREIGN KEY ("depotId") REFERENCES "Depot"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HireSuggestion" ADD CONSTRAINT "HireSuggestion_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey: a plan version's suggestions go with it (Start fresh deletes plans by id).
ALTER TABLE "HireSuggestion" ADD CONSTRAINT "HireSuggestion_runId_fkey" FOREIGN KEY ("runId") REFERENCES "RunPlan"("id") ON DELETE CASCADE ON UPDATE CASCADE;
