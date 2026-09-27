-- Audit of 27 Sep 2026, PR "Intake and master data" (F03, F20): the database refuses a delete that
-- would leave history without its depot or driver. Four foreign keys go from ON DELETE SET NULL
-- to ON DELETE NO ACTION:
--
--   "Order"."depotId"          -> "Depot"  (F03: an order kept its row but lost its depot, then fell
--   "UploadBatch"."depotId"    -> "Depot"   into another depot's plan or out of every plan)
--   "PlanLoad"."driverId"      -> "Driver" (F20: a load lost who drove it)
--   "Truck"."defaultDriverId"  -> "Driver" (F20: a truck's default driver was cleared silently)
--
-- The app no longer deletes such rows (a referenced depot and every driver are deactivated); this
-- makes the database enforce it. "Truck"."depotId" and "RunPlan"."depotId" are already RESTRICT.
-- NO ACTION (checked at the end of the statement) rather than RESTRICT, so deleting a whole tenant,
-- which cascades to both sides in one statement, still works as before.
--
-- Safe on existing rows: no column, type or data changes. Every existing value is NULL or points
-- at an existing row (the old constraints guaranteed it), so validation cannot fail. NOT VALID +
-- VALIDATE as in the earlier key changes; at NMWC's table sizes the locks last milliseconds.
-- Owner's read-only pre-check (all four counts must be 0; they are by construction):
--   SELECT
--     (SELECT count(*) FROM "Order" o WHERE o."depotId" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "Depot" d WHERE d.id = o."depotId")) AS orders,
--     (SELECT count(*) FROM "UploadBatch" b WHERE b."depotId" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "Depot" d WHERE d.id = b."depotId")) AS batches,
--     (SELECT count(*) FROM "PlanLoad" l WHERE l."driverId" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "Driver" r WHERE r.id = l."driverId")) AS loads,
--     (SELECT count(*) FROM "Truck" t WHERE t."defaultDriverId" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "Driver" r WHERE r.id = t."defaultDriverId")) AS trucks;
-- Rollback: re-add the four constraints with ON DELETE SET NULL (the old app code never relies on
-- NO ACTION, so an app rollback alone is safe too).

-- DropForeignKey
ALTER TABLE "Order" DROP CONSTRAINT "Order_depotId_fkey";

-- DropForeignKey
ALTER TABLE "PlanLoad" DROP CONSTRAINT "PlanLoad_driverId_fkey";

-- DropForeignKey
ALTER TABLE "Truck" DROP CONSTRAINT "Truck_defaultDriverId_fkey";

-- DropForeignKey
ALTER TABLE "UploadBatch" DROP CONSTRAINT "UploadBatch_depotId_fkey";

-- AddForeignKey
ALTER TABLE "Truck" ADD CONSTRAINT "Truck_defaultDriverId_fkey" FOREIGN KEY ("defaultDriverId") REFERENCES "Driver"("id") ON DELETE NO ACTION ON UPDATE CASCADE NOT VALID;

ALTER TABLE "Truck" VALIDATE CONSTRAINT "Truck_defaultDriverId_fkey";

-- AddForeignKey
ALTER TABLE "UploadBatch" ADD CONSTRAINT "UploadBatch_depotId_fkey" FOREIGN KEY ("depotId") REFERENCES "Depot"("id") ON DELETE NO ACTION ON UPDATE CASCADE NOT VALID;

ALTER TABLE "UploadBatch" VALIDATE CONSTRAINT "UploadBatch_depotId_fkey";

-- AddForeignKey
ALTER TABLE "Order" ADD CONSTRAINT "Order_depotId_fkey" FOREIGN KEY ("depotId") REFERENCES "Depot"("id") ON DELETE NO ACTION ON UPDATE CASCADE NOT VALID;

ALTER TABLE "Order" VALIDATE CONSTRAINT "Order_depotId_fkey";

-- AddForeignKey
ALTER TABLE "PlanLoad" ADD CONSTRAINT "PlanLoad_driverId_fkey" FOREIGN KEY ("driverId") REFERENCES "Driver"("id") ON DELETE NO ACTION ON UPDATE CASCADE NOT VALID;

ALTER TABLE "PlanLoad" VALIDATE CONSTRAINT "PlanLoad_driverId_fkey";
