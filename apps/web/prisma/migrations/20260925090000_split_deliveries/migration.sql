-- Split deliveries: a customer bigger than the largest truck is delivered in several parts.
-- A RouteAssignment / UnservedOrder row with portion fields covers only part of its order
-- (exact SKU lines in portionLinesJson); NULL keeps the old meaning, the whole order.
ALTER TABLE "RouteAssignment" ADD COLUMN "portionCases" INTEGER,
    ADD COLUMN "portionWeightKg" DOUBLE PRECISION,
    ADD COLUMN "portionLinesJson" JSONB;

ALTER TABLE "UnservedOrder" ADD COLUMN "portionCases" INTEGER,
    ADD COLUMN "portionWeightKg" DOUBLE PRECISION,
    ADD COLUMN "portionLinesJson" JSONB;

ALTER TABLE "TenantConfig" ADD COLUMN "splitDeliveries" BOOLEAN NOT NULL DEFAULT true;
