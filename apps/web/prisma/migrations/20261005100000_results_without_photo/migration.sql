-- Owner decision 2 of 5 Oct 2026, "Camera not working" is allowed but monitored: the driver's own last
-- Delivered or Partly result per stop, kept apart from the current result. A result the office records
-- (Record) replaces the current result but never these columns, so a result the driver saved without
-- a photo stays on the Deliveries card, the plan screen, the dashboard and the Excel after a correction
-- (lib/delivery/camera-exceptions.ts). Additive: four new columns (nullable, or 0 by default) and a
-- fill of those columns only; nothing else changes.

-- AlterTable
ALTER TABLE "StopVisit" ADD COLUMN     "driverNoPhotoReason" TEXT,
ADD COLUMN     "driverPhotoKeys" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "driverResultAt" TIMESTAMPTZ(3),
ADD COLUMN     "driverResultOutcome" "DeliveryOutcome";

-- The visits already stored (a database where 20261004090000 ran before this one): the same facts from
-- their events, as the rebuild writes them (lib/delivery/visit.ts, driverFacts). The driver's results
-- are the OUTCOME events not written by the office; the last one is the latest time, then the latest
-- received; the photo keys are those named by any of the driver's Delivered or Partly results.
WITH driver AS (
  SELECT e."visitId", e."at", e."receivedAt", e."payloadJson"
    FROM "StopEvent" e
   WHERE e."kind" = 'OUTCOME'
     AND e."source" <> 'DISPATCHER'
     AND e."visitId" IS NOT NULL
     AND e."payloadJson" ->> 'outcome' IN ('DELIVERED', 'PARTLY_DELIVERED')
), last AS (
  SELECT DISTINCT ON (d."visitId") d."visitId", d."at", d."payloadJson"
    FROM driver d
   ORDER BY d."visitId", d."at" DESC, d."receivedAt" DESC
), keys AS (
  SELECT d."visitId", COUNT(DISTINCT k.key)::int AS n
    FROM driver d
   CROSS JOIN LATERAL jsonb_array_elements_text(
           CASE WHEN jsonb_typeof(d."payloadJson" -> 'photoKeys') = 'array' THEN d."payloadJson" -> 'photoKeys' ELSE '[]'::jsonb END
         ) AS k(key)
   GROUP BY d."visitId"
)
UPDATE "StopVisit" v
   SET "driverResultAt" = last."at",
       "driverResultOutcome" = (last."payloadJson" ->> 'outcome')::"DeliveryOutcome",
       "driverNoPhotoReason" = NULLIF(last."payloadJson" ->> 'noPhotoReason', ''),
       "driverPhotoKeys" = COALESCE(keys.n, 0)
  FROM last
  LEFT JOIN keys ON keys."visitId" = last."visitId"
 WHERE v."id" = last."visitId";
