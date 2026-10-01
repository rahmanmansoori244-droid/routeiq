-- Owner decisions of 1 Oct 2026 (data collection rules, items 3, 4 and 6). Additive only; no data is changed.

-- Item 3, loading gate: off until the dispatcher or admin switches it on (Settings). Item 4: how many
-- days ahead the "data to collect" list looks (from today).
ALTER TABLE "TenantConfig" ADD COLUMN     "requireDataBeforeLoading" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "dataCollectDays" INTEGER NOT NULL DEFAULT 3;

-- Item 6, daily customer master: when a customer was created and last changed. Existing customers
-- keep NULL (nothing recorded when they were made): the column default is set after the column is
-- added, so only customers created from now on get a creation time.
ALTER TABLE "Customer" ADD COLUMN     "createdAt" TIMESTAMP(3),
ADD COLUMN     "updatedAt" TIMESTAMP(3);
ALTER TABLE "Customer" ALTER COLUMN "createdAt" SET DEFAULT CURRENT_TIMESTAMP;

-- CreateIndex
CREATE INDEX "Customer_tenantId_updatedAt_idx" ON "Customer"("tenantId", "updatedAt");
