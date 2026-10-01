-- Owner decisions of 1 Oct 2026 (data collection rules, items 1 and 2). Additive only; no data is changed.

-- Item 2, "own confirmed window": who confirmed the customer's receiving hours, and when. NULL = not
-- confirmed (a company or customer-type default, or hours nobody checked). Existing customers start
-- unconfirmed: nobody recorded who entered their hours.
ALTER TABLE "Customer" ADD COLUMN     "windowConfirmedAt" TIMESTAMP(3),
ADD COLUMN     "windowConfirmedById" TEXT;

-- Item 1: a delivery time for one order (urgent / promised), set by the dispatcher with a reason. It
-- replaces the customer's receiving hours for that order only. NULL = none (the customer's hours apply).
ALTER TABLE "Order" ADD COLUMN     "deliveryEndMin" INTEGER,
ADD COLUMN     "deliveryStartMin" INTEGER,
ADD COLUMN     "deliveryTimeNote" TEXT,
ADD COLUMN     "deliveryTimeReason" TEXT,
ADD COLUMN     "deliveryTimeSetAt" TIMESTAMP(3),
ADD COLUMN     "deliveryTimeSetById" TEXT;

-- AddForeignKey
ALTER TABLE "Customer" ADD CONSTRAINT "Customer_windowConfirmedById_fkey" FOREIGN KEY ("windowConfirmedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Order" ADD CONSTRAINT "Order_deliveryTimeSetById_fkey" FOREIGN KEY ("deliveryTimeSetById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
