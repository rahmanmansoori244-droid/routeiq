-- Helpers (truck crew), owner request 13 Oct 2026: "management asked to track helpers in each truck,
-- so add that like drivers too. We need to know who were the helpers in each truck and load."
--
-- Additive: two new tables and three nullable columns, no default that rewrites a table, no data
-- change. No existing row needs a value: a truck without a usual helper, a load without helpers.
-- Code from before this release never reads them, so an app rollback is safe.
--   Helper           the company's helpers (code unique per company), deactivated, never deleted.
--   PlanLoadHelper   the helpers on one load (0 to 3, position 1-3), copied with the load into every
--                    new plan version; removed with its load (CASCADE).
--   Truck.defaultHelperId          the truck's usual helper: new loads get him (NO ACTION, as the
--                                  default driver).
--   PlanLoad.helpersSetById / At   the dispatcher set the helpers by hand: a re-plan keeps them.
-- Rollback: DROP TABLE "PlanLoadHelper"; ALTER TABLE "Truck" DROP COLUMN "defaultHelperId";
--           ALTER TABLE "PlanLoad" DROP COLUMN "helpersSetById", DROP COLUMN "helpersSetAt"; DROP TABLE "Helper";

-- AlterTable
ALTER TABLE "Truck" ADD COLUMN     "defaultHelperId" TEXT;

-- AlterTable
ALTER TABLE "PlanLoad" ADD COLUMN     "helpersSetAt" TIMESTAMP(3),
ADD COLUMN     "helpersSetById" TEXT;

-- CreateTable
CREATE TABLE "Helper" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "phone" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Helper_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PlanLoadHelper" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "loadId" TEXT NOT NULL,
    "helperId" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PlanLoadHelper_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Helper_tenantId_idx" ON "Helper"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "Helper_tenantId_code_key" ON "Helper"("tenantId", "code");

-- CreateIndex
CREATE INDEX "PlanLoadHelper_tenantId_helperId_idx" ON "PlanLoadHelper"("tenantId", "helperId");

-- CreateIndex
CREATE UNIQUE INDEX "PlanLoadHelper_loadId_helperId_key" ON "PlanLoadHelper"("loadId", "helperId");

-- AddForeignKey
ALTER TABLE "Truck" ADD CONSTRAINT "Truck_defaultHelperId_fkey" FOREIGN KEY ("defaultHelperId") REFERENCES "Helper"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Helper" ADD CONSTRAINT "Helper_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PlanLoadHelper" ADD CONSTRAINT "PlanLoadHelper_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PlanLoadHelper" ADD CONSTRAINT "PlanLoadHelper_loadId_fkey" FOREIGN KEY ("loadId") REFERENCES "PlanLoad"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PlanLoadHelper" ADD CONSTRAINT "PlanLoadHelper_helperId_fkey" FOREIGN KEY ("helperId") REFERENCES "Helper"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PlanLoad" ADD CONSTRAINT "PlanLoad_helpersSetById_fkey" FOREIGN KEY ("helpersSetById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- At most three helpers on a load, shown in this order. Prisma's schema has no CHECK constraints;
-- `prisma migrate diff` leaves this alone. (The API refuses a fourth helper first: lib/schemas.ts.)
ALTER TABLE "PlanLoadHelper" ADD CONSTRAINT "PlanLoadHelper_position_range" CHECK ("position" BETWEEN 1 AND 3);
