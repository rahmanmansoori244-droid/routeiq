-- CreateEnum
CREATE TYPE "Role" AS ENUM ('SUPER_ADMIN', 'TENANT_ADMIN', 'PLANNER', 'SUPERVISOR', 'VIEWER');

-- CreateEnum
CREATE TYPE "CapacityUnit" AS ENUM ('CASES', 'CARTONS', 'PALLETS', 'KG');

-- CreateEnum
CREATE TYPE "OptimizationMode" AS ENUM ('MIN_TRUCKS', 'MIN_DISTANCE', 'MIN_COST', 'BALANCED', 'MAX_UTILIZATION');

-- CreateEnum
CREATE TYPE "OrderStatus" AS ENUM ('UPLOADED', 'VALIDATED', 'ASSIGNED', 'DISPATCHED', 'DELIVERED', 'FAILED', 'UNSERVED');

-- CreateEnum
CREATE TYPE "RunStatus" AS ENUM ('DRAFT', 'OPTIMIZING', 'READY', 'FAILED', 'DISPATCHED', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "PaymentType" AS ENUM ('CASH', 'CREDIT', 'PREPAID');

-- CreateEnum
CREATE TYPE "UploadBatchStatus" AS ENUM ('PARSED', 'VALIDATED', 'CONFIRMED', 'REJECTED', 'DELETED');

-- CreateEnum
CREATE TYPE "RunJobStatus" AS ENUM ('QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "UnservedReasonCode" AS ENUM ('MISSING_COORDINATES', 'EXCEEDS_TRUCK_CAPACITY', 'NO_AVAILABLE_TRUCK', 'SHIFT_TIME_LIMIT', 'INVALID_CUSTOMER', 'SOLVER_DROPPED_LOW_PRIORITY', 'INFEASIBLE_ROUTE', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "DistanceProvider" AS ENUM ('HAVERSINE', 'MAPBOX_MATRIX');

-- CreateTable
CREATE TABLE "Tenant" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "country" TEXT NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'OMR',
    "primaryUnit" "CapacityUnit" NOT NULL DEFAULT 'CASES',
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Tenant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TenantConfig" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "avgSpeedKmh" DOUBLE PRECISION NOT NULL DEFAULT 40,
    "distanceProvider" "DistanceProvider" NOT NULL DEFAULT 'HAVERSINE',
    "distanceMultiplier" DOUBLE PRECISION NOT NULL DEFAULT 1.30,
    "labelEstimatedDistances" BOOLEAN NOT NULL DEFAULT true,
    "driverShiftMaxMinutes" INTEGER NOT NULL DEFAULT 540,
    "returnToDepot" BOOLEAN NOT NULL DEFAULT true,
    "defaultServiceTimeMin" INTEGER NOT NULL DEFAULT 10,
    "costPerKmDefault" DOUBLE PRECISION NOT NULL DEFAULT 0.15,
    "fixedTruckCostPerDayDefault" DOUBLE PRECISION NOT NULL DEFAULT 20,
    "latePenaltyPerMin" DOUBLE PRECISION NOT NULL DEFAULT 0.5,
    "underutilizationPenalty" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "solverTimeLimitSeconds" INTEGER NOT NULL DEFAULT 30,
    "weightObjectiveTrucks" DOUBLE PRECISION NOT NULL DEFAULT 1000,
    "weightObjectiveDistance" DOUBLE PRECISION NOT NULL DEFAULT 1,
    "weightObjectiveCost" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "weightObjectiveBalance" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "weightObjectiveUtilization" DOUBLE PRECISION NOT NULL DEFAULT 0,

    CONSTRAINT "TenantConfig_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "role" "Role" NOT NULL DEFAULT 'VIEWER',
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PasswordResetToken" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT,
    "userId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PasswordResetToken_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Depot" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "lat" DOUBLE PRECISION NOT NULL,
    "lng" DOUBLE PRECISION NOT NULL,
    "address" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "Depot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Truck" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "depotId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "description" TEXT,
    "capacityCases" INTEGER NOT NULL DEFAULT 0,
    "capacityWeightKg" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "capacityVolumeL" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "fixedCostPerDay" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "costPerKm" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "active" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "Truck_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Driver" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "phone" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "Driver_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Region" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "depotId" TEXT,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,

    CONSTRAINT "Region_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Customer" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "regionId" TEXT,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "branchCode" TEXT,
    "branchKey" TEXT NOT NULL DEFAULT '__MAIN__',
    "address" TEXT,
    "lat" DOUBLE PRECISION,
    "lng" DOUBLE PRECISION,
    "geocodeConfidence" TEXT,
    "priority" INTEGER NOT NULL DEFAULT 3,
    "avgServiceTimeMin" INTEGER NOT NULL DEFAULT 10,
    "paymentType" "PaymentType" NOT NULL DEFAULT 'CREDIT',
    "accessNotes" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "Customer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Product" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "weightPerCaseKg" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "volumePerCaseL" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "active" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "Product_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UploadBatch" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "fileType" TEXT NOT NULL,
    "uploadedById" TEXT NOT NULL,
    "uploadedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deliveryDate" DATE,
    "status" "UploadBatchStatus" NOT NULL DEFAULT 'PARSED',
    "totalRows" INTEGER NOT NULL DEFAULT 0,
    "validRows" INTEGER NOT NULL DEFAULT 0,
    "errorRows" INTEGER NOT NULL DEFAULT 0,
    "warningRows" INTEGER NOT NULL DEFAULT 0,
    "validationJson" JSONB,

    CONSTRAINT "UploadBatch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Order" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "deliveryDate" DATE NOT NULL,
    "totalCases" INTEGER NOT NULL DEFAULT 0,
    "totalWeightKg" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "totalVolumeL" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "totalServiceTimeMin" INTEGER NOT NULL DEFAULT 10,
    "priority" INTEGER NOT NULL DEFAULT 3,
    "paymentCollectionAmount" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "notes" TEXT,
    "status" "OrderStatus" NOT NULL DEFAULT 'UPLOADED',
    "uploadBatchId" TEXT,
    "uploadedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Order_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OrderLine" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "cases" INTEGER NOT NULL,

    CONSTRAINT "OrderLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RunPlan" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "depotId" TEXT NOT NULL,
    "runDate" DATE NOT NULL,
    "status" "RunStatus" NOT NULL DEFAULT 'DRAFT',
    "optimizationMode" "OptimizationMode" NOT NULL DEFAULT 'BALANCED',
    "chosenScenarioId" TEXT,
    "totalOrders" INTEGER NOT NULL DEFAULT 0,
    "unservedCount" INTEGER NOT NULL DEFAULT 0,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finalizedAt" TIMESTAMP(3),
    "currentJobId" TEXT,

    CONSTRAINT "RunPlan_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ScenarioResult" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "trucksUsed" INTEGER NOT NULL,
    "totalDistanceKm" DOUBLE PRECISION NOT NULL,
    "totalTimeMin" INTEGER NOT NULL,
    "totalCost" DOUBLE PRECISION NOT NULL,
    "avgUtilizationPct" DOUBLE PRECISION NOT NULL,
    "unservedCount" INTEGER NOT NULL,
    "detailsJson" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ScenarioResult_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RouteAssignment" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "truckId" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "sequenceInTruck" INTEGER NOT NULL,
    "plannedArrivalMin" INTEGER NOT NULL,
    "plannedDistanceFromPrevKm" DOUBLE PRECISION NOT NULL,
    "plannedLoadCases" INTEGER NOT NULL,
    "lockedByUserId" TEXT,
    "manualOverrideReason" TEXT,

    CONSTRAINT "RouteAssignment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RunJob" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "attemptNo" INTEGER NOT NULL DEFAULT 1,
    "status" "RunJobStatus" NOT NULL DEFAULT 'QUEUED',
    "progressPct" INTEGER NOT NULL DEFAULT 0,
    "message" TEXT,
    "requestJson" JSONB,
    "responseJson" JSONB,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "errorJson" JSONB,

    CONSTRAINT "RunJob_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ManualBaseline" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "runId" TEXT,
    "fileName" TEXT,
    "uploadedById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "totalTrucks" INTEGER NOT NULL DEFAULT 0,
    "totalDistanceKm" DOUBLE PRECISION,
    "totalTimeMin" INTEGER,
    "totalCost" DOUBLE PRECISION,
    "notes" TEXT,

    CONSTRAINT "ManualBaseline_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ManualBaselineAssignment" (
    "id" TEXT NOT NULL,
    "baselineId" TEXT NOT NULL,
    "orderId" TEXT,
    "truckCode" TEXT NOT NULL,
    "sequence" INTEGER,
    "customerCode" TEXT NOT NULL,
    "branchKey" TEXT NOT NULL DEFAULT '__MAIN__',
    "cases" INTEGER NOT NULL DEFAULT 0,
    "estimatedDistanceKm" DOUBLE PRECISION,
    "estimatedTimeMin" INTEGER,

    CONSTRAINT "ManualBaselineAssignment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UnservedOrder" (
    "id" TEXT NOT NULL,
    "scenarioId" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "reasonCode" "UnservedReasonCode" NOT NULL,
    "reasonMessage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UnservedOrder_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "userId" TEXT,
    "action" TEXT NOT NULL,
    "entity" TEXT NOT NULL,
    "entityId" TEXT,
    "beforeJson" JSONB,
    "afterJson" JSONB,
    "ip" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Tenant_slug_key" ON "Tenant"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "TenantConfig_tenantId_key" ON "TenantConfig"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE INDEX "User_tenantId_idx" ON "User"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "PasswordResetToken_tokenHash_key" ON "PasswordResetToken"("tokenHash");

-- CreateIndex
CREATE INDEX "PasswordResetToken_userId_idx" ON "PasswordResetToken"("userId");

-- CreateIndex
CREATE INDEX "PasswordResetToken_expiresAt_idx" ON "PasswordResetToken"("expiresAt");

-- CreateIndex
CREATE INDEX "Depot_tenantId_idx" ON "Depot"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "Depot_tenantId_code_key" ON "Depot"("tenantId", "code");

-- CreateIndex
CREATE INDEX "Truck_tenantId_depotId_idx" ON "Truck"("tenantId", "depotId");

-- CreateIndex
CREATE UNIQUE INDEX "Truck_tenantId_code_key" ON "Truck"("tenantId", "code");

-- CreateIndex
CREATE INDEX "Driver_tenantId_idx" ON "Driver"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "Driver_tenantId_code_key" ON "Driver"("tenantId", "code");

-- CreateIndex
CREATE INDEX "Region_tenantId_idx" ON "Region"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "Region_tenantId_code_key" ON "Region"("tenantId", "code");

-- CreateIndex
CREATE INDEX "Customer_tenantId_regionId_idx" ON "Customer"("tenantId", "regionId");

-- CreateIndex
CREATE UNIQUE INDEX "Customer_tenantId_code_branchKey_key" ON "Customer"("tenantId", "code", "branchKey");

-- CreateIndex
CREATE INDEX "Product_tenantId_idx" ON "Product"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "Product_tenantId_code_key" ON "Product"("tenantId", "code");

-- CreateIndex
CREATE INDEX "UploadBatch_tenantId_uploadedAt_idx" ON "UploadBatch"("tenantId", "uploadedAt");

-- CreateIndex
CREATE INDEX "Order_tenantId_deliveryDate_idx" ON "Order"("tenantId", "deliveryDate");

-- CreateIndex
CREATE INDEX "Order_tenantId_customerId_idx" ON "Order"("tenantId", "customerId");

-- CreateIndex
CREATE INDEX "OrderLine_orderId_idx" ON "OrderLine"("orderId");

-- CreateIndex
CREATE INDEX "RunPlan_tenantId_runDate_idx" ON "RunPlan"("tenantId", "runDate");

-- CreateIndex
CREATE INDEX "RunPlan_tenantId_currentJobId_idx" ON "RunPlan"("tenantId", "currentJobId");

-- CreateIndex
CREATE INDEX "ScenarioResult_runId_idx" ON "ScenarioResult"("runId");

-- CreateIndex
CREATE INDEX "RouteAssignment_runId_truckId_idx" ON "RouteAssignment"("runId", "truckId");

-- CreateIndex
CREATE UNIQUE INDEX "RouteAssignment_runId_truckId_sequenceInTruck_key" ON "RouteAssignment"("runId", "truckId", "sequenceInTruck");

-- CreateIndex
CREATE INDEX "RunJob_tenantId_status_idx" ON "RunJob"("tenantId", "status");

-- CreateIndex
CREATE INDEX "RunJob_tenantId_createdAt_idx" ON "RunJob"("tenantId", "createdAt");

-- CreateIndex
CREATE INDEX "RunJob_runId_idx" ON "RunJob"("runId");

-- CreateIndex
CREATE UNIQUE INDEX "RunJob_runId_attemptNo_key" ON "RunJob"("runId", "attemptNo");

-- CreateIndex
CREATE INDEX "ManualBaseline_tenantId_createdAt_idx" ON "ManualBaseline"("tenantId", "createdAt");

-- CreateIndex
CREATE INDEX "ManualBaseline_tenantId_runId_idx" ON "ManualBaseline"("tenantId", "runId");

-- CreateIndex
CREATE INDEX "ManualBaselineAssignment_baselineId_truckCode_idx" ON "ManualBaselineAssignment"("baselineId", "truckCode");

-- CreateIndex
CREATE INDEX "UnservedOrder_scenarioId_idx" ON "UnservedOrder"("scenarioId");

-- CreateIndex
CREATE INDEX "UnservedOrder_orderId_idx" ON "UnservedOrder"("orderId");

-- CreateIndex
CREATE INDEX "AuditLog_tenantId_createdAt_idx" ON "AuditLog"("tenantId", "createdAt");

-- CreateIndex
CREATE INDEX "AuditLog_tenantId_entity_entityId_idx" ON "AuditLog"("tenantId", "entity", "entityId");

-- AddForeignKey
ALTER TABLE "TenantConfig" ADD CONSTRAINT "TenantConfig_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "User" ADD CONSTRAINT "User_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PasswordResetToken" ADD CONSTRAINT "PasswordResetToken_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PasswordResetToken" ADD CONSTRAINT "PasswordResetToken_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Depot" ADD CONSTRAINT "Depot_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Truck" ADD CONSTRAINT "Truck_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Truck" ADD CONSTRAINT "Truck_depotId_fkey" FOREIGN KEY ("depotId") REFERENCES "Depot"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Driver" ADD CONSTRAINT "Driver_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Region" ADD CONSTRAINT "Region_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Region" ADD CONSTRAINT "Region_depotId_fkey" FOREIGN KEY ("depotId") REFERENCES "Depot"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Customer" ADD CONSTRAINT "Customer_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Customer" ADD CONSTRAINT "Customer_regionId_fkey" FOREIGN KEY ("regionId") REFERENCES "Region"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Product" ADD CONSTRAINT "Product_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UploadBatch" ADD CONSTRAINT "UploadBatch_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UploadBatch" ADD CONSTRAINT "UploadBatch_uploadedById_fkey" FOREIGN KEY ("uploadedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Order" ADD CONSTRAINT "Order_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Order" ADD CONSTRAINT "Order_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Order" ADD CONSTRAINT "Order_uploadBatchId_fkey" FOREIGN KEY ("uploadBatchId") REFERENCES "UploadBatch"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderLine" ADD CONSTRAINT "OrderLine_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderLine" ADD CONSTRAINT "OrderLine_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RunPlan" ADD CONSTRAINT "RunPlan_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RunPlan" ADD CONSTRAINT "RunPlan_depotId_fkey" FOREIGN KEY ("depotId") REFERENCES "Depot"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ScenarioResult" ADD CONSTRAINT "ScenarioResult_runId_fkey" FOREIGN KEY ("runId") REFERENCES "RunPlan"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RouteAssignment" ADD CONSTRAINT "RouteAssignment_runId_fkey" FOREIGN KEY ("runId") REFERENCES "RunPlan"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RouteAssignment" ADD CONSTRAINT "RouteAssignment_truckId_fkey" FOREIGN KEY ("truckId") REFERENCES "Truck"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RouteAssignment" ADD CONSTRAINT "RouteAssignment_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RouteAssignment" ADD CONSTRAINT "RouteAssignment_lockedByUserId_fkey" FOREIGN KEY ("lockedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RunJob" ADD CONSTRAINT "RunJob_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RunJob" ADD CONSTRAINT "RunJob_runId_fkey" FOREIGN KEY ("runId") REFERENCES "RunPlan"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RunJob" ADD CONSTRAINT "RunJob_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ManualBaseline" ADD CONSTRAINT "ManualBaseline_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ManualBaseline" ADD CONSTRAINT "ManualBaseline_runId_fkey" FOREIGN KEY ("runId") REFERENCES "RunPlan"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ManualBaseline" ADD CONSTRAINT "ManualBaseline_uploadedById_fkey" FOREIGN KEY ("uploadedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ManualBaselineAssignment" ADD CONSTRAINT "ManualBaselineAssignment_baselineId_fkey" FOREIGN KEY ("baselineId") REFERENCES "ManualBaseline"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ManualBaselineAssignment" ADD CONSTRAINT "ManualBaselineAssignment_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UnservedOrder" ADD CONSTRAINT "UnservedOrder_scenarioId_fkey" FOREIGN KEY ("scenarioId") REFERENCES "ScenarioResult"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UnservedOrder" ADD CONSTRAINT "UnservedOrder_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
