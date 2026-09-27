-- Bring forward (PR9): orders not delivered on their own day, carried to a later day's plan.
--
-- The copy on the later day links back to the order it came from (carriedFromOrderId, unique: an
-- order is carried at most once, so two concurrent "Bring forward" calls cannot both carry it) and
-- keeps the date the order was first due (carriedFromDate). The original is marked with its copy
-- (carriedToOrderId, unique), when (carriedAt) and by whom (carriedById): it is then no longer open,
-- unserved or pending on its own day. That day's plan versions are not changed.
--
-- Additive and safe on existing rows: five nullable columns (no default, no table rewrite), two
-- unique indexes over columns that are NULL on every existing row (NULLs never conflict), and three
-- foreign keys added NOT VALID and then validated so the lock on "Order" stays short; every existing
-- row is NULL, so validation cannot fail. The two order links are ON DELETE NO ACTION: neither side
-- of a carry can be deleted from under the other (the batch delete refuses a file whose orders were
-- carried). carriedById is ON DELETE SET NULL like lateRecordedById. No backfill.
-- Old app code ignores the columns, so an app rollback is safe (it would show carried originals as
-- open again). Rollback: DROP CONSTRAINT the three keys, DROP INDEX both, DROP COLUMN the five.

-- AlterTable
ALTER TABLE "Order" ADD COLUMN "carriedAt" TIMESTAMP(3),
ADD COLUMN "carriedById" TEXT,
ADD COLUMN "carriedFromDate" DATE,
ADD COLUMN "carriedFromOrderId" TEXT,
ADD COLUMN "carriedToOrderId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "Order_carriedFromOrderId_key" ON "Order"("carriedFromOrderId");

-- CreateIndex
CREATE UNIQUE INDEX "Order_carriedToOrderId_key" ON "Order"("carriedToOrderId");

-- AddForeignKey
ALTER TABLE "Order" ADD CONSTRAINT "Order_carriedFromOrderId_fkey" FOREIGN KEY ("carriedFromOrderId") REFERENCES "Order"("id") ON DELETE NO ACTION ON UPDATE CASCADE NOT VALID;

ALTER TABLE "Order" VALIDATE CONSTRAINT "Order_carriedFromOrderId_fkey";

-- AddForeignKey
ALTER TABLE "Order" ADD CONSTRAINT "Order_carriedToOrderId_fkey" FOREIGN KEY ("carriedToOrderId") REFERENCES "Order"("id") ON DELETE NO ACTION ON UPDATE CASCADE NOT VALID;

ALTER TABLE "Order" VALIDATE CONSTRAINT "Order_carriedToOrderId_fkey";

-- AddForeignKey
ALTER TABLE "Order" ADD CONSTRAINT "Order_carriedById_fkey" FOREIGN KEY ("carriedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE NOT VALID;

ALTER TABLE "Order" VALIDATE CONSTRAINT "Order_carriedById_fkey";
