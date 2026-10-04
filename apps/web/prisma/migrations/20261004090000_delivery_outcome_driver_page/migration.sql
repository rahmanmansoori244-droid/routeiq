-- Delivery outcome and the driver phone page (owner request 4 Oct 2026). Additive only: CREATE TYPE,
-- CREATE TABLE, CREATE INDEX, ADD CONSTRAINT and ADD COLUMN (nullable or with a default); no existing
-- data changes meaning. It holds every table, enum and column the three build parts need, so Parts 2
-- and 3 need no migration. No partial index (the drift check stays clean).
--
-- One driver link (QR) per truck and delivery date (DriverLink: only the SHA-256 of the token is kept);
-- arrivals, departures, results and photos are stop events (StopEvent) with the current state of each
-- physical stop in StopVisit; delivery photos (compressed JPEG) in DeliveryPhoto. TenantConfig gets the
-- five admin settings, and outcomesSince = the migration time for existing companies (the no-result
-- list and the outcome KPIs ignore deliveries before it). Driver.casual (daily drivers), Truck.hired
-- (hired trucks) and Order.carryBasisJson (Bring forward, Part 3) default to false / NULL.
--
-- Photos are kept 90 days by default (owner decision 1 of 5 Oct 2026, before this migration reached
-- production; it said 365 until then). A database where this migration already ran with 365 is moved
-- to 90 by 20261005090000_driver_page_owner_decisions.

-- CreateEnum
CREATE TYPE "StopEventKind" AS ENUM ('ARRIVED', 'DEPARTED', 'OUTCOME', 'PHOTO', 'BACK_AT_DEPOT', 'CARRY_CONFLICT');

-- CreateEnum
CREATE TYPE "PhotoPositionStatus" AS ENUM ('OK', 'POOR', 'DENIED', 'TIMEOUT', 'UNSUPPORTED');

-- CreateEnum
CREATE TYPE "StopEventSource" AS ENUM ('PHONE_AUTO', 'PHONE_MANUAL', 'DISPATCHER', 'AYUN', 'SYSTEM');

-- CreateEnum
CREATE TYPE "DeliveryOutcome" AS ENUM ('DELIVERED', 'PARTLY_DELIVERED', 'NOT_DELIVERED');

-- CreateEnum
CREATE TYPE "NotDeliveredReason" AS ENUM ('SHOP_CLOSED', 'CUSTOMER_REFUSED', 'NO_ONE_TO_RECEIVE', 'WRONG_LOCATION', 'NO_TIME_LEFT', 'PAYMENT_ISSUE', 'DAMAGED_GOODS', 'NOT_ON_TRUCK', 'OTHER');

-- AlterTable
ALTER TABLE "Driver" ADD COLUMN     "casual" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "Order" ADD COLUMN     "carryBasisJson" JSONB;

-- AlterTable
ALTER TABLE "TenantConfig" ADD COLUMN     "dispatcherPhone" TEXT,
ADD COLUMN     "geofenceRadiusM" INTEGER NOT NULL DEFAULT 100,
ADD COLUMN     "locationRetentionDays" INTEGER NOT NULL DEFAULT 90,
ADD COLUMN     "outcomesSince" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "photoProofRequired" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "photoRetentionDays" INTEGER NOT NULL DEFAULT 90;

-- AlterTable
ALTER TABLE "Truck" ADD COLUMN     "hired" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "DriverLink" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "truckId" TEXT NOT NULL,
    "deliveryDate" DATE NOT NULL,
    "generation" INTEGER NOT NULL DEFAULT 1,
    "salt" TEXT NOT NULL,
    "keyId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "prevTokenHash" TEXT,
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,
    "issuedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "issuedById" TEXT,
    "driverIdAtIssue" TEXT,
    "revokedAt" TIMESTAMPTZ(3),
    "revokedById" TEXT,
    "lastSeenAt" TIMESTAMPTZ(3),
    "devicesJson" JSONB,

    CONSTRAINT "DriverLink_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StopVisit" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "depotId" TEXT NOT NULL,
    "deliveryDate" DATE NOT NULL,
    "truckId" TEXT NOT NULL,
    "loadNo" INTEGER NOT NULL,
    "sequence" INTEGER NOT NULL,
    "customerId" TEXT NOT NULL,
    "firstLoadId" TEXT,
    "plannedEtaMin" INTEGER,
    "plannedServiceMin" INTEGER,
    "plannedLat" DOUBLE PRECISION,
    "plannedLng" DOUBLE PRECISION,
    "windowStartMin" INTEGER,
    "windowEndMin" INTEGER,
    "linesJson" JSONB NOT NULL,
    "casesPlanned" INTEGER NOT NULL,
    "casesDelivered" INTEGER,
    "arrivedAt" TIMESTAMPTZ(3),
    "arrivalSource" "StopEventSource",
    "arrivalDistanceM" DOUBLE PRECISION,
    "arrivalAccuracyM" DOUBLE PRECISION,
    "departedAt" TIMESTAMPTZ(3),
    "departureSource" "StopEventSource",
    "departedAtOutcome" BOOLEAN NOT NULL DEFAULT false,
    "arrivalObserved" BOOLEAN NOT NULL DEFAULT true,
    "autoArrivedAt" TIMESTAMPTZ(3),
    "autoDepartedAt" TIMESTAMPTZ(3),
    "autoBasis" TEXT,
    "autoMinutes" DOUBLE PRECISION,
    "autoServiceMinutes" DOUBLE PRECISION,
    "timingSuspect" BOOLEAN NOT NULL DEFAULT false,
    "outcome" "DeliveryOutcome",
    "reason" "NotDeliveredReason",
    "reasonNote" TEXT,
    "outcomeAt" TIMESTAMPTZ(3),
    "outcomeSource" "StopEventSource",
    "outcomeById" TEXT,
    "outcomeLat" DOUBLE PRECISION,
    "outcomeLng" DOUBLE PRECISION,
    "outcomeAccuracyM" DOUBLE PRECISION,
    "outcomeDistanceM" DOUBLE PRECISION,
    "outcomeLate" BOOLEAN NOT NULL DEFAULT false,
    "noPhotoReason" TEXT,
    "photoKeysJson" JSONB,
    "photoCount" INTEGER NOT NULL DEFAULT 0,
    "locationPurgedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "StopVisit_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StopEvent" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "depotId" TEXT NOT NULL,
    "deliveryDate" DATE NOT NULL,
    "truckId" TEXT NOT NULL,
    "loadNo" INTEGER NOT NULL,
    "sequence" INTEGER,
    "visitId" TEXT,
    "kind" "StopEventKind" NOT NULL,
    "source" "StopEventSource" NOT NULL,
    "at" TIMESTAMPTZ(3) NOT NULL,
    "receivedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lat" DOUBLE PRECISION,
    "lng" DOUBLE PRECISION,
    "accuracyM" DOUBLE PRECISION,
    "distanceM" DOUBLE PRECISION,
    "speedMps" DOUBLE PRECISION,
    "driverLinkId" TEXT,
    "linkGeneration" INTEGER,
    "userId" TEXT,
    "clientIp" TEXT,
    "deviceId" TEXT,
    "idempotencyKey" TEXT NOT NULL,
    "payloadJson" JSONB,

    CONSTRAINT "StopEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DeliveryPhoto" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "visitId" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "source" "StopEventSource" NOT NULL,
    "driverLinkId" TEXT,
    "userId" TEXT,
    "clientIp" TEXT,
    "deviceId" TEXT,
    "takenAt" TIMESTAMPTZ(3) NOT NULL,
    "rawTakenAt" TIMESTAMPTZ(3),
    "receivedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "positionStatus" "PhotoPositionStatus" NOT NULL,
    "lat" DOUBLE PRECISION,
    "lng" DOUBLE PRECISION,
    "accuracyM" DOUBLE PRECISION,
    "distanceM" DOUBLE PRECISION,
    "exifLat" DOUBLE PRECISION,
    "exifLng" DOUBLE PRECISION,
    "exifTakenAt" TIMESTAMPTZ(3),
    "exifDistanceM" DOUBLE PRECISION,
    "oldPhoto" BOOLEAN NOT NULL DEFAULT false,
    "contentType" TEXT NOT NULL DEFAULT 'image/jpeg',
    "byteSize" INTEGER NOT NULL,
    "width" INTEGER,
    "height" INTEGER,
    "sha256" TEXT NOT NULL,
    "bytes" BYTEA,
    "purgedAt" TIMESTAMPTZ(3),
    "locationPurgedAt" TIMESTAMPTZ(3),

    CONSTRAINT "DeliveryPhoto_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "DriverLink_tokenHash_key" ON "DriverLink"("tokenHash");

-- CreateIndex
CREATE UNIQUE INDEX "DriverLink_prevTokenHash_key" ON "DriverLink"("prevTokenHash");

-- CreateIndex
CREATE INDEX "DriverLink_tenantId_deliveryDate_idx" ON "DriverLink"("tenantId", "deliveryDate");

-- CreateIndex
CREATE UNIQUE INDEX "DriverLink_tenantId_truckId_deliveryDate_key" ON "DriverLink"("tenantId", "truckId", "deliveryDate");

-- CreateIndex
CREATE INDEX "StopVisit_tenantId_deliveryDate_idx" ON "StopVisit"("tenantId", "deliveryDate");

-- CreateIndex
CREATE INDEX "StopVisit_tenantId_customerId_deliveryDate_idx" ON "StopVisit"("tenantId", "customerId", "deliveryDate");

-- CreateIndex
CREATE UNIQUE INDEX "StopVisit_tenantId_depotId_deliveryDate_truckId_loadNo_sequ_key" ON "StopVisit"("tenantId", "depotId", "deliveryDate", "truckId", "loadNo", "sequence");

-- CreateIndex
CREATE INDEX "StopEvent_tenantId_deliveryDate_truckId_idx" ON "StopEvent"("tenantId", "deliveryDate", "truckId");

-- CreateIndex
CREATE INDEX "StopEvent_visitId_at_idx" ON "StopEvent"("visitId", "at");

-- CreateIndex
CREATE INDEX "StopEvent_kind_receivedAt_idx" ON "StopEvent"("kind", "receivedAt");

-- CreateIndex
CREATE INDEX "StopEvent_tenantId_receivedAt_idx" ON "StopEvent"("tenantId", "receivedAt");

-- CreateIndex
CREATE UNIQUE INDEX "StopEvent_tenantId_idempotencyKey_key" ON "StopEvent"("tenantId", "idempotencyKey");

-- CreateIndex
CREATE INDEX "DeliveryPhoto_visitId_idx" ON "DeliveryPhoto"("visitId");

-- CreateIndex
CREATE INDEX "DeliveryPhoto_tenantId_receivedAt_idx" ON "DeliveryPhoto"("tenantId", "receivedAt");

-- CreateIndex
CREATE INDEX "DeliveryPhoto_driverLinkId_idx" ON "DeliveryPhoto"("driverLinkId");

-- CreateIndex
CREATE UNIQUE INDEX "DeliveryPhoto_tenantId_idempotencyKey_key" ON "DeliveryPhoto"("tenantId", "idempotencyKey");

-- AddForeignKey
ALTER TABLE "DriverLink" ADD CONSTRAINT "DriverLink_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DriverLink" ADD CONSTRAINT "DriverLink_truckId_fkey" FOREIGN KEY ("truckId") REFERENCES "Truck"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DriverLink" ADD CONSTRAINT "DriverLink_issuedById_fkey" FOREIGN KEY ("issuedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DriverLink" ADD CONSTRAINT "DriverLink_revokedById_fkey" FOREIGN KEY ("revokedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StopVisit" ADD CONSTRAINT "StopVisit_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StopVisit" ADD CONSTRAINT "StopVisit_truckId_fkey" FOREIGN KEY ("truckId") REFERENCES "Truck"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StopVisit" ADD CONSTRAINT "StopVisit_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StopVisit" ADD CONSTRAINT "StopVisit_outcomeById_fkey" FOREIGN KEY ("outcomeById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StopEvent" ADD CONSTRAINT "StopEvent_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StopEvent" ADD CONSTRAINT "StopEvent_visitId_fkey" FOREIGN KEY ("visitId") REFERENCES "StopVisit"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StopEvent" ADD CONSTRAINT "StopEvent_driverLinkId_fkey" FOREIGN KEY ("driverLinkId") REFERENCES "DriverLink"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StopEvent" ADD CONSTRAINT "StopEvent_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeliveryPhoto" ADD CONSTRAINT "DeliveryPhoto_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeliveryPhoto" ADD CONSTRAINT "DeliveryPhoto_visitId_fkey" FOREIGN KEY ("visitId") REFERENCES "StopVisit"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeliveryPhoto" ADD CONSTRAINT "DeliveryPhoto_driverLinkId_fkey" FOREIGN KEY ("driverLinkId") REFERENCES "DriverLink"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeliveryPhoto" ADD CONSTRAINT "DeliveryPhoto_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

