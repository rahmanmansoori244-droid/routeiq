-- CreateEnum
CREATE TYPE "DriverShiftStatus" AS ENUM ('ACTIVE', 'COMPLETED', 'ABANDONED');

-- AlterTable
ALTER TABLE "Driver" ADD COLUMN     "accessPinHash" TEXT;

-- CreateTable
CREATE TABLE "DriverShift" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "driverId" TEXT NOT NULL,
    "truckId" TEXT NOT NULL,
    "runId" TEXT,
    "sessionToken" TEXT NOT NULL,
    "status" "DriverShiftStatus" NOT NULL DEFAULT 'ACTIVE',
    "startedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endedAt" TIMESTAMPTZ(3),
    "notes" TEXT,

    CONSTRAINT "DriverShift_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TruckLocation" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "shiftId" TEXT NOT NULL,
    "truckId" TEXT NOT NULL,
    "ts" TIMESTAMPTZ(3) NOT NULL,
    "lat" DOUBLE PRECISION NOT NULL,
    "lng" DOUBLE PRECISION NOT NULL,
    "speedKmh" DOUBLE PRECISION,
    "headingDeg" DOUBLE PRECISION,
    "accuracyM" DOUBLE PRECISION,
    "batteryPct" INTEGER,

    CONSTRAINT "TruckLocation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DeliveryProof" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "shiftId" TEXT NOT NULL,
    "assignmentId" TEXT NOT NULL,
    "completedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "notes" TEXT,
    "signaturePngB64" TEXT,
    "lat" DOUBLE PRECISION,
    "lng" DOUBLE PRECISION,

    CONSTRAINT "DeliveryProof_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "DriverShift_sessionToken_key" ON "DriverShift"("sessionToken");

-- CreateIndex
CREATE INDEX "DriverShift_tenantId_status_idx" ON "DriverShift"("tenantId", "status");

-- CreateIndex
CREATE INDEX "DriverShift_truckId_status_idx" ON "DriverShift"("truckId", "status");

-- CreateIndex
CREATE INDEX "DriverShift_driverId_status_idx" ON "DriverShift"("driverId", "status");

-- CreateIndex
CREATE INDEX "DriverShift_runId_idx" ON "DriverShift"("runId");

-- CreateIndex
CREATE INDEX "TruckLocation_tenantId_truckId_ts_idx" ON "TruckLocation"("tenantId", "truckId", "ts");

-- CreateIndex
CREATE INDEX "TruckLocation_shiftId_ts_idx" ON "TruckLocation"("shiftId", "ts");

-- CreateIndex
CREATE UNIQUE INDEX "DeliveryProof_assignmentId_key" ON "DeliveryProof"("assignmentId");

-- CreateIndex
CREATE INDEX "DeliveryProof_tenantId_completedAt_idx" ON "DeliveryProof"("tenantId", "completedAt");

-- CreateIndex
CREATE INDEX "DeliveryProof_shiftId_idx" ON "DeliveryProof"("shiftId");

-- AddForeignKey
ALTER TABLE "DriverShift" ADD CONSTRAINT "DriverShift_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DriverShift" ADD CONSTRAINT "DriverShift_driverId_fkey" FOREIGN KEY ("driverId") REFERENCES "Driver"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DriverShift" ADD CONSTRAINT "DriverShift_truckId_fkey" FOREIGN KEY ("truckId") REFERENCES "Truck"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DriverShift" ADD CONSTRAINT "DriverShift_runId_fkey" FOREIGN KEY ("runId") REFERENCES "RunPlan"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TruckLocation" ADD CONSTRAINT "TruckLocation_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TruckLocation" ADD CONSTRAINT "TruckLocation_shiftId_fkey" FOREIGN KEY ("shiftId") REFERENCES "DriverShift"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TruckLocation" ADD CONSTRAINT "TruckLocation_truckId_fkey" FOREIGN KEY ("truckId") REFERENCES "Truck"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeliveryProof" ADD CONSTRAINT "DeliveryProof_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeliveryProof" ADD CONSTRAINT "DeliveryProof_shiftId_fkey" FOREIGN KEY ("shiftId") REFERENCES "DriverShift"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeliveryProof" ADD CONSTRAINT "DeliveryProof_assignmentId_fkey" FOREIGN KEY ("assignmentId") REFERENCES "RouteAssignment"("id") ON DELETE CASCADE ON UPDATE CASCADE;
