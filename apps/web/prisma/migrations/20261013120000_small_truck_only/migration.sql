-- "Small truck only" customers (owner request after the first live night, 12 Oct 2026: "some customers
-- have an unloading area only suitable for 3-ton trucks; the plan gave them big trucks and the dispatcher
-- had to re-do it by hand"). Owner decisions 13 Oct 2026: one yes/no per customer, and one company setting
-- "a small truck has at most N bays" (6 by default: the 3-ton trucks have 4-6 bays, the 10-ton 11-12).
--
-- Additive only:
-- - Customer.smallTruckOnly: NOT NULL DEFAULT false. On PostgreSQL 11+ a constant default changes the
--   catalog only (no table rewrite, no long lock); every existing customer stays "any truck".
-- - TenantConfig.smallTruckMaxBays: NOT NULL DEFAULT 6, 1-40 (the trucks' own bays range), CHECKed.
-- - UnservedReasonCode NO_ALLOWED_TRUCK: the optimizer's reason for a small-truck-only order no small truck
--   could take (none today, none big enough, or none with room or time). ADD VALUE is not used in this
--   migration's own statements (PostgreSQL 12+ allows it inside the migration's transaction then).
-- Code from before this release never reads the columns and never writes the enum value, so an app
-- rollback is safe.
-- Rollback: ALTER TABLE "Customer" DROP COLUMN "smallTruckOnly";
--           ALTER TABLE "TenantConfig" DROP CONSTRAINT "TenantConfig_smallTruckMaxBays_range";
--           ALTER TABLE "TenantConfig" DROP COLUMN "smallTruckMaxBays";
--           (an enum value cannot be dropped; unused, it is harmless).

-- AlterEnum
ALTER TYPE "UnservedReasonCode" ADD VALUE 'NO_ALLOWED_TRUCK';

-- AlterTable
ALTER TABLE "Customer" ADD COLUMN     "smallTruckOnly" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "TenantConfig" ADD COLUMN     "smallTruckMaxBays" INTEGER NOT NULL DEFAULT 6;
ALTER TABLE "TenantConfig" ADD CONSTRAINT "TenantConfig_smallTruckMaxBays_range" CHECK ("smallTruckMaxBays" BETWEEN 1 AND 40);
