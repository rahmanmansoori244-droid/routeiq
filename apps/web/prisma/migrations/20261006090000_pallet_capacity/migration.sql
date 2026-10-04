-- Truck capacity in pallets (owner decision 4 Oct 2026): a truck with bays (the existing, never used
-- column "Truck"."palletCapacity", named `bays` in the Prisma schema) is planned by pallets - mixed
-- pallets, each product's cases / its cases per pallet added up, at most bays x the company's Pallet
-- fill, and the payload when one is set (0 = no weight limit). Orders, invoices and driver sheets
-- stay in cases. Additive: one setting with a default and two nullable columns; nothing else
-- changes, and no existing row needs a value.

-- AlterTable: the Pallet fill setting (the percent of the bays the planner may fill), 50-100. Default
-- 100 = every bay (owner decision 4 Oct 2026); a company may lower it as a safety margin.
ALTER TABLE "TenantConfig" ADD COLUMN     "palletFillPct" INTEGER NOT NULL DEFAULT 100;
ALTER TABLE "TenantConfig" ADD CONSTRAINT "TenantConfig_palletFillPct_range" CHECK ("palletFillPct" BETWEEN 50 AND 100);

-- AlterTable: the pallet need a load / a plan row was planned with, in 1/1000 pallet. NULL = planned
-- without pallets (a truck without bays, or planned before this release).
ALTER TABLE "PlanLoad" ADD COLUMN     "palletUnits" INTEGER;
ALTER TABLE "RouteAssignment" ADD COLUMN     "palletUnits" INTEGER;
