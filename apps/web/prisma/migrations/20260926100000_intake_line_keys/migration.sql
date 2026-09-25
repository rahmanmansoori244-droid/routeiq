-- Durable identity of a confirmed sales-order line (review F05): one key per
-- (tenant, delivery date, sales order, customer, product), so the same line cannot be
-- confirmed twice from two files, two browser tabs or a late order.
-- Additive: one new table. Nothing else changes. Rollback: DROP TABLE "IntakeLineKey".

-- CreateTable
CREATE TABLE "IntakeLineKey" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "deliveryDate" DATE NOT NULL,
    "salesOrderNorm" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "orderLineId" TEXT NOT NULL,
    "uploadBatchId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "IntakeLineKey_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "IntakeLineKey_orderLineId_key" ON "IntakeLineKey"("orderLineId");

-- CreateIndex
CREATE INDEX "IntakeLineKey_tenantId_salesOrderNorm_idx" ON "IntakeLineKey"("tenantId", "salesOrderNorm");

-- CreateIndex
CREATE UNIQUE INDEX "IntakeLineKey_tenantId_deliveryDate_salesOrderNorm_customer_key" ON "IntakeLineKey"("tenantId", "deliveryDate", "salesOrderNorm", "customerId", "productId");

-- AddForeignKey
ALTER TABLE "IntakeLineKey" ADD CONSTRAINT "IntakeLineKey_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IntakeLineKey" ADD CONSTRAINT "IntakeLineKey_orderLineId_fkey" FOREIGN KEY ("orderLineId") REFERENCES "OrderLine"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Backfill: every existing order line that carries a sales-order number gets its key.
-- The normalization matches the app (trimmed, upper-case sales order; customer and product
-- by id). Production may already hold the same line twice (a double intake): the OLDEST line
-- keeps the key and ON CONFLICT DO NOTHING skips the later copies, which are left exactly as
-- they are. Run the read-only duplicate query from docs/PROJECT_HANDBOOK.md (section 5.5)
-- before deploying to list them. The id is derived from the line id, so it is unique.
INSERT INTO "IntakeLineKey" ("id", "tenantId", "deliveryDate", "salesOrderNorm", "customerId", "productId", "orderLineId", "uploadBatchId", "createdAt")
SELECT
    'ilk' || md5(ol."id"),
    o."tenantId",
    o."deliveryDate",
    upper(btrim(ol."salesOrderNo")),
    o."customerId",
    ol."productId",
    ol."id",
    o."uploadBatchId",
    o."uploadedAt"
FROM "OrderLine" ol
JOIN "Order" o ON o."id" = ol."orderId"
WHERE ol."salesOrderNo" IS NOT NULL
  AND btrim(ol."salesOrderNo") <> ''
ORDER BY o."uploadedAt" ASC, o."id" ASC, ol."id" ASC
ON CONFLICT DO NOTHING;
