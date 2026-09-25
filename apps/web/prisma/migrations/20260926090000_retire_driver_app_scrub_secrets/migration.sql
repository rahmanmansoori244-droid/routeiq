-- Stabilization PR1 (security): retire the legacy driver phone app and remove credential
-- hashes from the audit history. DATA ONLY: no schema change, no table or column is dropped
-- (DriverShift, TruckLocation, DeliveryProof and Driver.accessPinHash stay until a later
-- contract migration).
--
-- Idempotent: every statement touches only rows that still need it, and the summary audit row
-- is written only for tenants where something changed. A second run changes nothing.
--
-- 1. End every driver-app shift still ACTIVE. The /api/driver/* routes now answer 410, so these
--    shifts (and their session tokens) are dead.
-- 2. Clear every driver PIN hash (Driver.accessPinHash). The PIN only unlocked the retired app;
--    re-enabling it would issue new PINs.
-- 3. Remove the keys accessPinHash / passwordHash / sessionToken / tokenHash from the top level
--    of AuditLog.beforeJson / afterJson. Only Driver rows ever held one (the full Driver row,
--    PIN hash included, was audited on PATCH and DELETE). The app also redacts these keys on
--    write and on read (lib/audit.ts redactForAudit).
-- 4. Per affected tenant, one SECURITY_CLEANUP audit row with the three counts.

WITH ended AS (
  UPDATE "DriverShift"
     SET "status" = 'COMPLETED',
         "endedAt" = COALESCE("endedAt", NOW())
   WHERE "status" = 'ACTIVE'
  RETURNING "tenantId"
),
pins AS (
  UPDATE "Driver"
     SET "accessPinHash" = NULL
   WHERE "accessPinHash" IS NOT NULL
  RETURNING "tenantId"
),
scrubbed AS (
  UPDATE "AuditLog"
     SET "beforeJson" = CASE
           WHEN jsonb_typeof("beforeJson") = 'object'
           THEN "beforeJson" - ARRAY['accessPinHash', 'passwordHash', 'sessionToken', 'tokenHash']
           ELSE "beforeJson"
         END,
         "afterJson" = CASE
           WHEN jsonb_typeof("afterJson") = 'object'
           THEN "afterJson" - ARRAY['accessPinHash', 'passwordHash', 'sessionToken', 'tokenHash']
           ELSE "afterJson"
         END
   WHERE (jsonb_typeof("beforeJson") = 'object'
          AND "beforeJson" ?| ARRAY['accessPinHash', 'passwordHash', 'sessionToken', 'tokenHash'])
      OR (jsonb_typeof("afterJson") = 'object'
          AND "afterJson" ?| ARRAY['accessPinHash', 'passwordHash', 'sessionToken', 'tokenHash'])
  RETURNING "tenantId"
),
counts AS (
  SELECT "tenantId",
         SUM(s)::int AS shifts,
         SUM(p)::int AS pins,
         SUM(a)::int AS audits
    FROM (
      SELECT "tenantId", 1 AS s, 0 AS p, 0 AS a FROM ended
      UNION ALL
      SELECT "tenantId", 0, 1, 0 FROM pins
      UNION ALL
      SELECT "tenantId", 0, 0, 1 FROM scrubbed
    ) x
   GROUP BY "tenantId"
)
INSERT INTO "AuditLog" ("id", "tenantId", "action", "entity", "entityId", "afterJson", "createdAt")
SELECT 'mig' || replace(gen_random_uuid()::text, '-', ''),
       c."tenantId",
       'SECURITY_CLEANUP',
       'Tenant',
       c."tenantId",
       jsonb_build_object(
         'driverShiftsEnded', c.shifts,
         'driverPinsCleared', c.pins,
         'auditRowsRedacted', c.audits,
         'reason', 'Driver phone app retired; credential hashes removed from the audit history',
         'by', 'migration 20260926090000_retire_driver_app_scrub_secrets'
       ),
       NOW()
  FROM counts c;
