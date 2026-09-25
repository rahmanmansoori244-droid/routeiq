-- UnservedOrder.orderId: ON DELETE CASCADE -> ON DELETE NO ACTION (review F20).
-- Deleting an order that is unserved in any plan option used to remove its unserved rows
-- silently, so the plan's history and reconciliation lost that demand. Now such a delete
-- fails, like it already does for an order on a load (RouteAssignment is RESTRICT). Deleting a
-- whole tenant therefore has to remove its plan data first, as the test cleanup already does.
-- All existing rows reference existing orders, so validation cannot fail; NOT VALID +
-- VALIDATE keeps the lock on "UnservedOrder" short. Rollback: re-add the constraint with
-- ON DELETE CASCADE.

-- DropForeignKey
ALTER TABLE "UnservedOrder" DROP CONSTRAINT "UnservedOrder_orderId_fkey";

-- AddForeignKey
ALTER TABLE "UnservedOrder" ADD CONSTRAINT "UnservedOrder_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE NO ACTION ON UPDATE CASCADE NOT VALID;

ALTER TABLE "UnservedOrder" VALIDATE CONSTRAINT "UnservedOrder_orderId_fkey";
