-- Customer phone (owner request 12 Oct 2026): "In the driver sheet add the phone number of the
-- customer, and add it to the list of data to be collected so that the driver can call the customer
-- before arrival to inform him of the delivery."
--
-- Additive: one nullable column, no default, no index, no CHECK (the format is checked by the app,
-- lib/dispatch/customer-phone.ts). No existing row needs a value: NULL = no phone known. A nullable
-- column without a default changes the catalog only (no table rewrite, no long lock). Code from
-- before this release never reads it, so an app rollback is safe.
-- Rollback: ALTER TABLE "Customer" DROP COLUMN "phone";

-- AlterTable
ALTER TABLE "Customer" ADD COLUMN     "phone" TEXT;
