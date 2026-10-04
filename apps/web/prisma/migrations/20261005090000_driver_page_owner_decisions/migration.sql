-- Owner decisions of 5 Oct 2026 on the driver page. Additive: one nullable column and a new column
-- default; the only data change is the photo retention of companies still on the old default.

-- Decision 3, "Call dispatcher": one number per depot. NULL = the company number
-- (TenantConfig.dispatcherPhone), as before for every depot.
ALTER TABLE "Depot" ADD COLUMN     "dispatcherPhone" TEXT;

-- Decision 1, photos: keep 90 days. 20261004090000 now creates the column with DEFAULT 90, so a database
-- that runs both migrations in one deploy never has 365 and the UPDATE below changes nothing (no audit
-- row either). This line and the UPDATE are for a database where 20261004090000 already ran with the
-- old DEFAULT 365.
ALTER TABLE "TenantConfig" ALTER COLUMN "photoRetentionDays" SET DEFAULT 90;

-- On such a database a company still on 365 moves to 90, unless an admin saved "Keep delivery photos"
-- in Settings (an audited change of photoRetentionDays: an explicit 365 is kept). Driver positions are
-- never kept longer than the photos (the Settings rule and the janitor's clamp), so they go to at most
-- 90 too. A company that chose another value keeps it. Each change is in the audit log the way a
-- Settings save writes it (UPDATE TenantConfig, entityId = the company, { tenant, config } with only
-- the changed fields), marked as made by this migration.
WITH old AS (
  SELECT c."id", c."tenantId", c."locationRetentionDays"
    FROM "TenantConfig" c
   WHERE c."photoRetentionDays" = 365
     AND NOT EXISTS (
       SELECT 1
         FROM "AuditLog" a
        WHERE a."tenantId" = c."tenantId"
          AND a."entity" = 'TenantConfig'
          AND a."afterJson" -> 'config' -> 'photoRetentionDays' IS NOT NULL
     )
), changed AS (
  UPDATE "TenantConfig" t
     SET "photoRetentionDays" = 90,
         "locationRetentionDays" = LEAST(t."locationRetentionDays", 90)
    FROM old
   WHERE t."id" = old."id"
  RETURNING t."tenantId", old."locationRetentionDays" AS "oldLocationDays", t."locationRetentionDays" AS "newLocationDays"
)
INSERT INTO "AuditLog" ("id", "tenantId", "action", "entity", "entityId", "beforeJson", "afterJson", "createdAt")
SELECT 'mig' || replace(gen_random_uuid()::text, '-', ''),
       c."tenantId",
       'UPDATE',
       'TenantConfig',
       c."tenantId",
       jsonb_build_object(
         'tenant', '{}'::jsonb,
         'config', jsonb_build_object('photoRetentionDays', 365)
           || CASE WHEN c."oldLocationDays" <> c."newLocationDays" THEN jsonb_build_object('locationRetentionDays', c."oldLocationDays") ELSE '{}'::jsonb END
       ),
       jsonb_build_object(
         'tenant', '{}'::jsonb,
         'config', jsonb_build_object('photoRetentionDays', 90)
           || CASE WHEN c."oldLocationDays" <> c."newLocationDays" THEN jsonb_build_object('locationRetentionDays', c."newLocationDays") ELSE '{}'::jsonb END,
         'by', 'migration 20261005090000 (owner decision of 5 Oct 2026: photos 90 days)'
       ),
       CURRENT_TIMESTAMP
  FROM changed c;
