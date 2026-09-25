-- OrderLine.weightFromMaster (stabilization PR2 follow-up to review F02): true when the line's kg
-- is cases x the product's case weight because the file gave none. Such lines follow the product
-- master: a case weight entered or corrected later (e.g. 1500 typed for 1.5) is applied to open
-- lines at the next optimize or re-plan, audited as ORDER_WEIGHTS_RESOLVED. File weights stay.
-- Additive: one column with a constant default (no table rewrite). Rollback: DROP COLUMN.

-- AlterTable
ALTER TABLE "OrderLine" ADD COLUMN "weightFromMaster" BOOLEAN NOT NULL DEFAULT false;

-- Backfill, guarded and repeatable: lines still at 0 kg (unknown) and lines whose kg is exactly
-- cases x the product's current case weight (how intake weighed lines without a file weight).
UPDATE "OrderLine" AS l
SET "weightFromMaster" = true
FROM "Product" AS p
WHERE p."id" = l."productId"
  AND l."weightFromMaster" = false
  AND (
    l."weightKg" <= 0
    OR (p."weightPerCaseKg" > 0 AND abs(l."weightKg" - l."cases" * p."weightPerCaseKg") <= 0.01)
  );
