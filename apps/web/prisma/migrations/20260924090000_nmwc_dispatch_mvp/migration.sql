-- NMWC daily dispatch MVP: customer windows/type/location provenance, truck economics,
-- sales-order detail on order lines, plan versions, per-truck loads with lock states.
-- Additive except for the RouteAssignment unique key, which gains loadNo + orderInStop.

-- CreateEnum
CREATE TYPE "LoadStatus" AS ENUM ('PLANNED', 'LOCKED', 'LOADING', 'DISPATCHED', 'COMPLETED');

-- CreateEnum
CREATE TYPE "PlanReason" AS ENUM ('INITIAL', 'LATE_ORDER', 'MANUAL_ADJUSTMENT', 'REOPTIMIZE');

-- CreateEnum
CREATE TYPE "CustomerType" AS ENUM ('HYPERMARKET', 'SUPERMARKET', 'TRADING', 'CATERING', 'HORECA', 'GROCERY', 'WHOLESALE', 'OTHER');

-- CreateEnum
CREATE TYPE "LocationSource" AS ENUM ('IMPORT', 'MANUAL_LATLNG', 'GOOGLE_MAPS_URL', 'MAP_PIN', 'GEOCODER', 'CRM');

-- AlterEnum
ALTER TYPE "DistanceProvider" ADD VALUE 'OSRM';

-- AlterEnum
ALTER TYPE "RunStatus" ADD VALUE 'SUPERSEDED';

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "UnservedReasonCode" ADD VALUE 'INVALID_LOCATION';
ALTER TYPE "UnservedReasonCode" ADD VALUE 'UNKNOWN_CUSTOMER';
ALTER TYPE "UnservedReasonCode" ADD VALUE 'UNKNOWN_PRODUCT';
ALTER TYPE "UnservedReasonCode" ADD VALUE 'EXCEEDS_ANY_TRUCK_CAPACITY';
ALTER TYPE "UnservedReasonCode" ADD VALUE 'HARD_WINDOW_INFEASIBLE';
ALTER TYPE "UnservedReasonCode" ADD VALUE 'SHIFT_LIMIT';
ALTER TYPE "UnservedReasonCode" ADD VALUE 'TRIP_LIMIT';
ALTER TYPE "UnservedReasonCode" ADD VALUE 'LOCKED_PLAN_CONFLICT';
ALTER TYPE "UnservedReasonCode" ADD VALUE 'LATE_ORDER_NO_CAPACITY';
ALTER TYPE "UnservedReasonCode" ADD VALUE 'ROUTING_PROVIDER_FAILURE';
ALTER TYPE "UnservedReasonCode" ADD VALUE 'INFEASIBLE';

-- DropIndex
DROP INDEX "RouteAssignment_runId_truckId_sequenceInTruck_key";

-- AlterTable
ALTER TABLE "Customer" ADD COLUMN     "createdFromUpload" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "customerType" "CustomerType",
ADD COLUMN     "hardWindowEndMin" INTEGER,
ADD COLUMN     "hardWindowStartMin" INTEGER,
ADD COLUMN     "locationInput" TEXT,
ADD COLUMN     "locationSource" "LocationSource",
ADD COLUMN     "locationVerified" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "locationVerifiedAt" TIMESTAMP(3),
ADD COLUMN     "locationVerifiedById" TEXT,
ADD COLUMN     "prefWindowEndMin" INTEGER,
ADD COLUMN     "prefWindowStartMin" INTEGER,
ADD COLUMN     "priorityConfirmed" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "serviceTimeConfirmed" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "Depot" ADD COLUMN     "closeMin" INTEGER,
ADD COLUMN     "openMin" INTEGER;

-- AlterTable
ALTER TABLE "Order" ADD COLUMN     "depotId" TEXT,
ADD COLUMN     "isLate" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "lateReason" TEXT,
ADD COLUMN     "lateRecordedById" TEXT,
ADD COLUMN     "marginValue" DOUBLE PRECISION,
ADD COLUMN     "salesValue" DOUBLE PRECISION;

-- AlterTable
ALTER TABLE "OrderLine" ADD COLUMN     "marginValue" DOUBLE PRECISION,
ADD COLUMN     "notes" TEXT,
ADD COLUMN     "orderDate" DATE,
ADD COLUMN     "productDescription" TEXT,
ADD COLUMN     "salesOrderNo" TEXT,
ADD COLUMN     "salesValue" DOUBLE PRECISION,
ADD COLUMN     "sourceRow" INTEGER,
ADD COLUMN     "weightKg" DOUBLE PRECISION NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "Product" ADD COLUMN     "casesPerPallet" DOUBLE PRECISION,
ADD COLUMN     "createdFromUpload" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "unitsPerCase" INTEGER;

-- AlterTable
ALTER TABLE "RouteAssignment" ADD COLUMN     "cumulativeKm" DOUBLE PRECISION,
ADD COLUMN     "departureMin" INTEGER,
ADD COLUMN     "etaMin" INTEGER,
ADD COLUMN     "hardWindowOk" BOOLEAN,
ADD COLUMN     "loadId" TEXT,
ADD COLUMN     "loadNo" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN     "orderInStop" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "prefWindowOk" BOOLEAN,
ADD COLUMN     "serviceStartMin" INTEGER,
ADD COLUMN     "waitMin" INTEGER;

-- AlterTable
ALTER TABLE "RunPlan" ADD COLUMN     "changeSummaryJson" JSONB,
ADD COLUMN     "parentRunId" TEXT,
ADD COLUMN     "reason" "PlanReason" NOT NULL DEFAULT 'INITIAL',
ADD COLUMN     "reasonNote" TEXT,
ADD COLUMN     "reconciliationJson" JSONB,
ADD COLUMN     "summaryJson" JSONB,
ADD COLUMN     "supersededAt" TIMESTAMP(3),
ADD COLUMN     "version" INTEGER NOT NULL DEFAULT 1;

-- AlterTable
ALTER TABLE "TenantConfig" ADD COLUMN     "dateOrder" TEXT NOT NULL DEFAULT 'DMY',
ADD COLUMN     "driverCostPerHour" DOUBLE PRECISION NOT NULL DEFAULT 0,
ADD COLUMN     "fuelPricePerLitre" DOUBLE PRECISION NOT NULL DEFAULT 0,
ADD COLUMN     "maxTripsPerTruck" INTEGER NOT NULL DEFAULT 3,
ADD COLUMN     "orderColumnMapJson" JSONB,
ADD COLUMN     "osrmUrl" TEXT,
ADD COLUMN     "overtimeAfterMin" INTEGER NOT NULL DEFAULT 540,
ADD COLUMN     "overtimeCostPerHour" DOUBLE PRECISION NOT NULL DEFAULT 0,
ADD COLUMN     "planningCutoffMin" INTEGER NOT NULL DEFAULT 1080,
ADD COLUMN     "prefWindowPenaltyPerMin" DOUBLE PRECISION NOT NULL DEFAULT 0.05,
ADD COLUMN     "priorityWeightsJson" JSONB,
ADD COLUMN     "reloadMinutes" INTEGER NOT NULL DEFAULT 30,
ADD COLUMN     "roadTimeFactor" DOUBLE PRECISION NOT NULL DEFAULT 1.25,
ADD COLUMN     "serviceAreaJson" JSONB,
ADD COLUMN     "shiftStartMin" INTEGER NOT NULL DEFAULT 360,
ADD COLUMN     "timezone" TEXT NOT NULL DEFAULT 'Asia/Muscat';

-- AlterTable
ALTER TABLE "Truck" ADD COLUMN     "availableFromMin" INTEGER,
ADD COLUMN     "availableToMin" INTEGER,
ADD COLUMN     "defaultDriverId" TEXT,
ADD COLUMN     "kmPerLitre" DOUBLE PRECISION,
ADD COLUMN     "maxTripsPerDay" INTEGER,
ADD COLUMN     "palletCapacity" INTEGER,
ADD COLUMN     "tripCost" DOUBLE PRECISION NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "UploadBatch" ADD COLUMN     "depotId" TEXT,
ADD COLUMN     "fileHash" TEXT,
ADD COLUMN     "isLate" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "lateReason" TEXT;

-- CreateTable
CREATE TABLE "CustomerTypeProfile" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "customerType" "CustomerType" NOT NULL,
    "defaultPriority" INTEGER,
    "serviceTimeMin" INTEGER,
    "hardWindowStartMin" INTEGER,
    "hardWindowEndMin" INTEGER,
    "prefWindowStartMin" INTEGER,
    "prefWindowEndMin" INTEGER,

    CONSTRAINT "CustomerTypeProfile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PlanLoad" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "truckId" TEXT NOT NULL,
    "loadNo" INTEGER NOT NULL,
    "status" "LoadStatus" NOT NULL DEFAULT 'PLANNED',
    "driverId" TEXT,
    "departMin" INTEGER NOT NULL,
    "returnMin" INTEGER NOT NULL,
    "distanceKm" DOUBLE PRECISION NOT NULL,
    "durationMin" INTEGER NOT NULL,
    "cases" INTEGER NOT NULL,
    "weightKg" DOUBLE PRECISION NOT NULL,
    "utilizationPct" DOUBLE PRECISION NOT NULL,
    "fuelLitres" DOUBLE PRECISION,
    "fuelCost" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "operatingCost" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "returnLegKm" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "distanceIsEstimated" BOOLEAN NOT NULL DEFAULT true,
    "carriedFromLoadId" TEXT,
    "statusChangedAt" TIMESTAMP(3),
    "statusChangedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PlanLoad_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "CustomerTypeProfile_tenantId_customerType_key" ON "CustomerTypeProfile"("tenantId", "customerType");

-- CreateIndex
CREATE INDEX "PlanLoad_tenantId_runId_idx" ON "PlanLoad"("tenantId", "runId");

-- CreateIndex
CREATE UNIQUE INDEX "PlanLoad_runId_truckId_loadNo_key" ON "PlanLoad"("runId", "truckId", "loadNo");

-- CreateIndex
CREATE INDEX "Order_tenantId_depotId_deliveryDate_idx" ON "Order"("tenantId", "depotId", "deliveryDate");

-- CreateIndex
CREATE INDEX "OrderLine_salesOrderNo_idx" ON "OrderLine"("salesOrderNo");

-- CreateIndex
CREATE INDEX "RouteAssignment_loadId_idx" ON "RouteAssignment"("loadId");

-- CreateIndex
CREATE UNIQUE INDEX "RouteAssignment_runId_truckId_loadNo_sequenceInTruck_orderI_key" ON "RouteAssignment"("runId", "truckId", "loadNo", "sequenceInTruck", "orderInStop");

-- CreateIndex
CREATE INDEX "RunPlan_tenantId_depotId_runDate_version_idx" ON "RunPlan"("tenantId", "depotId", "runDate", "version");

-- CreateIndex
CREATE INDEX "UploadBatch_tenantId_fileHash_idx" ON "UploadBatch"("tenantId", "fileHash");

-- AddForeignKey
ALTER TABLE "CustomerTypeProfile" ADD CONSTRAINT "CustomerTypeProfile_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Truck" ADD CONSTRAINT "Truck_defaultDriverId_fkey" FOREIGN KEY ("defaultDriverId") REFERENCES "Driver"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Customer" ADD CONSTRAINT "Customer_locationVerifiedById_fkey" FOREIGN KEY ("locationVerifiedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UploadBatch" ADD CONSTRAINT "UploadBatch_depotId_fkey" FOREIGN KEY ("depotId") REFERENCES "Depot"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Order" ADD CONSTRAINT "Order_depotId_fkey" FOREIGN KEY ("depotId") REFERENCES "Depot"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Order" ADD CONSTRAINT "Order_lateRecordedById_fkey" FOREIGN KEY ("lateRecordedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RunPlan" ADD CONSTRAINT "RunPlan_parentRunId_fkey" FOREIGN KEY ("parentRunId") REFERENCES "RunPlan"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PlanLoad" ADD CONSTRAINT "PlanLoad_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PlanLoad" ADD CONSTRAINT "PlanLoad_runId_fkey" FOREIGN KEY ("runId") REFERENCES "RunPlan"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PlanLoad" ADD CONSTRAINT "PlanLoad_truckId_fkey" FOREIGN KEY ("truckId") REFERENCES "Truck"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PlanLoad" ADD CONSTRAINT "PlanLoad_driverId_fkey" FOREIGN KEY ("driverId") REFERENCES "Driver"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PlanLoad" ADD CONSTRAINT "PlanLoad_statusChangedById_fkey" FOREIGN KEY ("statusChangedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RouteAssignment" ADD CONSTRAINT "RouteAssignment_loadId_fkey" FOREIGN KEY ("loadId") REFERENCES "PlanLoad"("id") ON DELETE CASCADE ON UPDATE CASCADE;

