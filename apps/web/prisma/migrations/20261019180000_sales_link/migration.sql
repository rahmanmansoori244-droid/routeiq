-- The salesman link (owner request 19 Oct 2026): one no-login, read-only link per company and delivery date
-- for the salesmen's WhatsApp group (app/s/[token], lib/sales-link/*). Each salesman types his route code and
-- follows his customers' deliveries live. Only the SHA-256 of the token is kept (tokenHash; prevTokenHash for
-- the generation before a reissue, which answers "replaced"); the token itself is never stored.
--
-- Additive only: one new table, its indexes and foreign keys (the company CASCADE, the users who issued or
-- turned off a link SET NULL), no change to an existing table. Code from before this release never reads it:
-- app rollback safe. The foreign keys take a short lock on "Tenant" and "User" while they are checked (the new
-- table is empty, so the check reads nothing).
--
-- CHECKs (each reads the new, empty table only):
--   generation >= 1; tokenHash and prevTokenHash are SHA-256 hex and differ; keyId is 8 hex; the expiry is after
--   the issue; a link turned off by someone has the time it was turned off; the device and route lists are
--   JSON arrays (or NULL).
--
-- Rollback:
--   DROP TABLE "SalesLink";
--   DELETE FROM "_prisma_migrations" WHERE migration_name = '20261019180000_sales_link';

-- CreateTable
CREATE TABLE "SalesLink" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "deliveryDate" DATE NOT NULL,
    "generation" INTEGER NOT NULL DEFAULT 1,
    "salt" TEXT NOT NULL,
    "keyId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "prevTokenHash" TEXT,
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,
    "issuedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "issuedById" TEXT,
    "revokedAt" TIMESTAMPTZ(3),
    "revokedById" TEXT,
    "lastSeenAt" TIMESTAMPTZ(3),
    "devicesJson" JSONB,
    "routesJson" JSONB,

    CONSTRAINT "SalesLink_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "SalesLink_tokenHash_key" ON "SalesLink"("tokenHash");

-- CreateIndex
CREATE UNIQUE INDEX "SalesLink_prevTokenHash_key" ON "SalesLink"("prevTokenHash");

-- CreateIndex
CREATE UNIQUE INDEX "SalesLink_tenantId_deliveryDate_key" ON "SalesLink"("tenantId", "deliveryDate");

-- AddForeignKey
ALTER TABLE "SalesLink" ADD CONSTRAINT "SalesLink_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SalesLink" ADD CONSTRAINT "SalesLink_issuedById_fkey" FOREIGN KEY ("issuedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SalesLink" ADD CONSTRAINT "SalesLink_revokedById_fkey" FOREIGN KEY ("revokedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Checks
ALTER TABLE "SalesLink" ADD CONSTRAINT "SalesLink_generation_positive" CHECK ("generation" >= 1);
ALTER TABLE "SalesLink" ADD CONSTRAINT "SalesLink_tokenHash_shape" CHECK ("tokenHash" ~ '^[0-9a-f]{64}$');
ALTER TABLE "SalesLink" ADD CONSTRAINT "SalesLink_prevTokenHash_shape" CHECK ("prevTokenHash" IS NULL OR ("prevTokenHash" ~ '^[0-9a-f]{64}$' AND "prevTokenHash" <> "tokenHash"));
ALTER TABLE "SalesLink" ADD CONSTRAINT "SalesLink_keyId_shape" CHECK ("keyId" ~ '^[0-9a-f]{8}$');
ALTER TABLE "SalesLink" ADD CONSTRAINT "SalesLink_expiry_after_issue" CHECK ("expiresAt" > "issuedAt");
ALTER TABLE "SalesLink" ADD CONSTRAINT "SalesLink_revoked_pair" CHECK ("revokedById" IS NULL OR "revokedAt" IS NOT NULL);
ALTER TABLE "SalesLink" ADD CONSTRAINT "SalesLink_lists_are_arrays" CHECK (("devicesJson" IS NULL OR jsonb_typeof("devicesJson") = 'array') AND ("routesJson" IS NULL OR jsonb_typeof("routesJson") = 'array'));
