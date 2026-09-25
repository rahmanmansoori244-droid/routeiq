-- Stabilization PR5 (review of the default service time): keep the unloading times customers
-- already had.
--
-- Customer imports before stabilization PR2 stored the file's avg_service_time_min without marking
-- it confirmed (a missing value was stored as 10, the column default). Since PR5 an unconfirmed
-- time no longer wins over the Settings default service time, so those entered times would
-- silently switch to the default - and the Daily dispatch dialog would then save the default over
-- them. This marks them confirmed, so the planner keeps using them.
--
-- Only customers whose time the PR5 rule would change: unconfirmed, above 0 and different from the
-- 10 min column default (so it came from a file or a form, not from the default), and whose
-- customer type has no unloading time of its own (for the others the type's time applies, before
-- and after PR5). Each changed customer gets an audit row (UPDATE Customer, by this migration).
--
-- Data only, no schema change. Idempotent: a second run finds nothing to change. Safe on existing
-- rows; old app code reads the same column the same way (a confirmed time wins).
WITH kept AS (
  UPDATE "Customer" c
     SET "serviceTimeConfirmed" = true
   WHERE c."serviceTimeConfirmed" = false
     AND c."avgServiceTimeMin" > 0
     AND c."avgServiceTimeMin" <> 10
     AND NOT EXISTS (
       SELECT 1
         FROM "CustomerTypeProfile" p
        WHERE p."tenantId" = c."tenantId"
          AND p."customerType" = c."customerType"
          AND p."serviceTimeMin" IS NOT NULL
     )
  RETURNING c."id", c."tenantId", c."avgServiceTimeMin"
)
INSERT INTO "AuditLog" ("id", "tenantId", "action", "entity", "entityId", "beforeJson", "afterJson", "createdAt")
SELECT 'mig' || replace(gen_random_uuid()::text, '-', ''),
       k."tenantId",
       'UPDATE',
       'Customer',
       k."id",
       jsonb_build_object('serviceTimeConfirmed', false, 'avgServiceTimeMin', k."avgServiceTimeMin"),
       jsonb_build_object(
         'serviceTimeConfirmed', true,
         'avgServiceTimeMin', k."avgServiceTimeMin",
         'reason', 'Unloading time from an earlier customer import kept: it no longer gives way to the Settings default service time',
         'by', 'migration 20260928090100_keep_imported_service_times'
       ),
       NOW()
  FROM kept k;
