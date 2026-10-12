-- Cancel order (owner request of the first live night, 12 Oct 2026: "we need the option to postpone
-- an order or cancel it - there were orders we knew would be cancelled but we could not cancel or
-- postpone them").
--
-- Additive: four nullable columns on "Order" and one foreign key, no default, no index, no CHECK
-- (the reason codes are checked by the app, lib/dispatch/order-cancel.ts). No existing row needs a
-- value: NULL = not cancelled. Nullable columns without a default change the catalog only (no table
-- rewrite, no long lock). The foreign key is checked at once: every row is NULL, so the check is
-- quick.
--
-- "cancelledById" -> "User" ON DELETE SET NULL, like the other "who did it" keys of an order
-- (carriedById, deliveryTimeSetById, lateRecordedById): a user row is never deleted in practice.
--
-- Postpone needs no column: it reuses the Bring forward copy (carriedFromOrderId / carriedToOrderId).
--
-- Rollback: the app before this release ignores the columns, so cancelled orders would be planned
-- again (re-cancel them after the redeploy). Then, if wanted:
--   ALTER TABLE "Order" DROP CONSTRAINT "Order_cancelledById_fkey";
--   ALTER TABLE "Order" DROP COLUMN "cancelledAt", DROP COLUMN "cancelledById", DROP COLUMN "cancelReason", DROP COLUMN "cancelNote";

-- AlterTable
ALTER TABLE "Order" ADD COLUMN     "cancelNote" TEXT,
ADD COLUMN     "cancelReason" TEXT,
ADD COLUMN     "cancelledAt" TIMESTAMP(3),
ADD COLUMN     "cancelledById" TEXT;

-- AddForeignKey
ALTER TABLE "Order" ADD CONSTRAINT "Order_cancelledById_fkey" FOREIGN KEY ("cancelledById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
