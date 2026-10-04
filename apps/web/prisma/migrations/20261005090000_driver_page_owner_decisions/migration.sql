-- Owner decisions of 5 Oct 2026 on the driver page. Additive: one nullable column and a new column
-- default; the only data change is the photo retention of companies still on the old default.

-- Decision 3, "Call dispatcher": one number per depot. NULL = the company number
-- (TenantConfig.dispatcherPhone), as before for every depot.
ALTER TABLE "Depot" ADD COLUMN     "dispatcherPhone" TEXT;

-- Decision 1, photos: keep 90 days (the default was 365).
ALTER TABLE "TenantConfig" ALTER COLUMN "photoRetentionDays" SET DEFAULT 90;

-- A company still on 365 (the default released with the driver page on 4 Oct 2026; nobody chose it)
-- moves to 90. Driver positions are never kept longer than the photos (the Settings rule and the
-- janitor's clamp), so they go to at most 90 too. A company that chose another value keeps it. Each
-- change is in the audit log (UPDATE TenantConfig, by the migration). No photo is older than 90 days
-- yet: the driver page went live on 4 Oct 2026, so the next clean-up removes nothing because of this.
WITH old AS (
  SELECT "id", "tenantId", "locationRetentionDays" FROM "TenantConfig" WHERE "photoRetentionDays" = 365
), changed AS (
  UPDATE "TenantConfig" t
     SET "photoRetentionDays" = 90,
         "locationRetentionDays" = LEAST(t."locationRetentionDays", 90)
    FROM old
   WHERE t."id" = old."id"
  RETURNING t."id", t."tenantId", old."locationRetentionDays" AS "oldLocationDays", t."locationRetentionDays" AS "newLocationDays"
)
INSERT INTO "AuditLog" ("id", "tenantId", "action", "entity", "entityId", "beforeJson", "afterJson", "createdAt")
SELECT 'mig' || replace(gen_random_uuid()::text, '-', ''),
       c."tenantId",
       'UPDATE',
       'TenantConfig',
       c."id",
       jsonb_build_object('photoRetentionDays', 365, 'locationRetentionDays', c."oldLocationDays"),
       jsonb_build_object('photoRetentionDays', 90, 'locationRetentionDays', c."newLocationDays", 'by', 'migration 20261005090000 (owner decision of 5 Oct 2026: photos 90 days)'),
       CURRENT_TIMESTAMP
  FROM changed c;
