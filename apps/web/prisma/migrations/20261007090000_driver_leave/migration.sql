-- Driver leave (owner request 6 Oct 2026): "give the dispatcher access to the Drivers page, because
-- our drivers change a lot, or one of them is on leave and we bring another one, or they take a whole
-- month of leave; it will be his job to monitor those."
--
-- Additive: one new table and one new column with a default. No existing row needs a value; code from
-- before this release never reads them. A leave period is a driver, a FROM and an UNTIL delivery
-- date (both included), an optional note and an optional cover driver. On those days the planner
-- never puts the driver on a load; a truck whose usual (default) driver is away gets the cover driver
-- when he is free that day (lib/dispatch/driver-leave.ts, planDrivers in lib/dispatch/load-state.ts).
-- PlanLoad.driverIsCover marks a load whose driver RouteIQ gave as such a cover: a re-plan offers him
-- again only as the cover (so he goes when the leave ends early or another cover is named).

-- CreateTable
CREATE TABLE "DriverLeave" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "driverId" TEXT NOT NULL,
    "fromDate" DATE NOT NULL,
    "untilDate" DATE NOT NULL,
    "note" TEXT,
    "coverDriverId" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedById" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DriverLeave_pkey" PRIMARY KEY ("id")
);

-- CreateIndex: the leave of a delivery day / the coming days (by company), and one driver's periods.
CREATE INDEX "DriverLeave_tenantId_untilDate_idx" ON "DriverLeave"("tenantId", "untilDate");
CREATE INDEX "DriverLeave_driverId_fromDate_idx" ON "DriverLeave"("driverId", "fromDate");

-- AddForeignKey. The driver and the cover: NO ACTION, as every other reference to a driver
-- (20260930093000_master_data_no_orphans). A driver is only ever deleted by Start fresh (a daily
-- driver with nothing left), which keeps one named by any leave period, so a period or its cover never
-- changes or goes without an audit row; deleting a whole company still removes both (end of statement).
-- The users who added or changed a period: SET NULL.
ALTER TABLE "DriverLeave" ADD CONSTRAINT "DriverLeave_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "DriverLeave" ADD CONSTRAINT "DriverLeave_driverId_fkey" FOREIGN KEY ("driverId") REFERENCES "Driver"("id") ON DELETE NO ACTION ON UPDATE CASCADE;
ALTER TABLE "DriverLeave" ADD CONSTRAINT "DriverLeave_coverDriverId_fkey" FOREIGN KEY ("coverDriverId") REFERENCES "Driver"("id") ON DELETE NO ACTION ON UPDATE CASCADE;
ALTER TABLE "DriverLeave" ADD CONSTRAINT "DriverLeave_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "DriverLeave" ADD CONSTRAINT "DriverLeave_updatedById_fkey" FOREIGN KEY ("updatedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- The dates in order, and nobody covers his own leave. Prisma's schema has no CHECK constraints;
-- `prisma migrate diff` leaves these alone. (Overlapping periods of one driver are refused by the
-- server under the driver's row lock: lib/dispatch/driver-leave-service.ts.)
ALTER TABLE "DriverLeave" ADD CONSTRAINT "DriverLeave_dates_in_order" CHECK ("untilDate" >= "fromDate");
ALTER TABLE "DriverLeave" ADD CONSTRAINT "DriverLeave_cover_not_self" CHECK ("coverDriverId" IS NULL OR "coverDriverId" <> "driverId");

-- AlterTable: the "given as the cover" marker of a load's driver (planDrivers, pass 3). A constant
-- default: no table rewrite.
ALTER TABLE "PlanLoad" ADD COLUMN "driverIsCover" BOOLEAN NOT NULL DEFAULT false;
