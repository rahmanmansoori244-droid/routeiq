-- Review fixes db-schema-1 and db-schema-2: four indexes. Additive only: no column, key or row
-- changes.
--
-- 1. "RouteAssignment"("orderId"). The key from a plan stop to its order is ON DELETE RESTRICT, so
--    deleting an order makes PostgreSQL look in this table once per order. No index started with
--    "orderId", and every plan version copies all the stops of the one before (nothing prunes
--    them), so each look read the whole table. Deleting a wrong 400-order file before optimizing
--    took from about 30 s to well over a minute at 250,000 to 440,000 stops (a few months of
--    NMWC): past the route's 30 s limit, so it answered INTAKE_BUSY and the orders stayed, while
--    the company's intake lock held every depot's uploads and late orders. With the index the same
--    delete took about 0.1 s.
-- 2. "ManualBaselineAssignment"("orderId"): the other key to "Order" without an index (ON DELETE
--    SET NULL, so also looked up once per order deleted).
-- 3. "Order"("uploadBatchId"): an order file's orders. The file delete reads them, the order files
--    list counts them, and the key is ON DELETE SET NULL (looked up when a file row is deleted).
-- 4. "AuditLog"("tenantId", "userId", "createdAt"): the Audit log page counts each user's rows for
--    its user filter from this index alone, instead of reading every audit row with its JSON, and
--    the audit API's filter by user reads that user's newest rows directly.
--
-- Plain CREATE INDEX in the one transaction Prisma runs this file in: each table can still be read
-- while its index is built, and writes to it wait until the build ends. At today's sizes each build
-- takes well under a second. Not CREATE INDEX CONCURRENTLY: it cannot run inside a transaction, so
-- it would need one migration file per index, and a build that fails leaves an invalid index.
-- On a database that has already grown large, the indexes can be built beforehand without holding
-- writes, under the same names, for example
--   CREATE INDEX CONCURRENTLY "RouteAssignment_orderId_idx" ON "RouteAssignment"("orderId");
-- (then check that pg_index.indisvalid is true for it; if not, drop it and build it again). This
-- migration then keeps them (IF NOT EXISTS).
-- Old code ignores the indexes, so an app rollback is safe. Rollback: DROP INDEX the four.

-- No statement or transaction time limit for this migration's transaction (is_local = true:
-- nothing outside it changes), so a limit set on the database or the role cannot cancel a build
-- (as in 20260930120000_orders_always_have_depot, A5 second review). transaction_timeout exists
-- from PostgreSQL 17 on; on older servers the second statement does nothing.
SELECT set_config('statement_timeout', '0', true);
SELECT set_config('transaction_timeout', '0', true) WHERE current_setting('server_version_num')::int >= 170000;

-- CreateIndex
CREATE INDEX IF NOT EXISTS "RouteAssignment_orderId_idx" ON "RouteAssignment"("orderId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "ManualBaselineAssignment_orderId_idx" ON "ManualBaselineAssignment"("orderId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Order_uploadBatchId_idx" ON "Order"("uploadBatchId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "AuditLog_tenantId_userId_createdAt_idx" ON "AuditLog"("tenantId", "userId", "createdAt");
