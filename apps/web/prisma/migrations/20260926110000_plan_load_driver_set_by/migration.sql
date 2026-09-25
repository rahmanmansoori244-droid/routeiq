-- PlanLoad.driverSetById / driverSetAt (fourth review of PR3): who chose the load's driver by hand,
-- and when. setDriverTx (the dispatcher's driver change) sets them and clears them with the
-- driver; a re-plan's copies (copy-forward) keep them; applyScenario carries them to the new load
-- of the same truck and trip when the driver comes from such a hand-set choice. Null means RouteIQ
-- filled the driver in (previous trip, parent version, nearest trip, truck default). The re-plan
-- driver rules keep a hand-set driver on its trip even when the new times overlap another trip
-- of that driver (the plan then shows the yellow clash warning).
--
-- Additive and safe on existing rows: two nullable columns (no default, no table rewrite) and a
-- foreign key to "User" (ON DELETE SET NULL, like statusChangedById), added NOT VALID and then
-- validated so the lock on "PlanLoad" stays short; every existing row is NULL, so validation
-- cannot fail. No backfill: a driver set before this migration counts as filled in by RouteIQ
-- until the dispatcher sets it again (the LOAD_DRIVER_SET audit rows name the original load
-- only, not its copies in later versions). Rollback: DROP CONSTRAINT, then DROP COLUMN both.

-- AlterTable
ALTER TABLE "PlanLoad" ADD COLUMN "driverSetAt" TIMESTAMP(3),
ADD COLUMN "driverSetById" TEXT;

-- AddForeignKey
ALTER TABLE "PlanLoad" ADD CONSTRAINT "PlanLoad_driverSetById_fkey" FOREIGN KEY ("driverSetById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE NOT VALID;

ALTER TABLE "PlanLoad" VALIDATE CONSTRAINT "PlanLoad_driverSetById_fkey";
