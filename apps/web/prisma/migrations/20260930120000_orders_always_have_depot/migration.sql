-- Audit PR A5 "Owner rules": every order and every order file has a depot. Owner decision of
-- 27 Sep 2026 ("all orders must have depots linked to them"): the database now enforces it.
-- "Order"."depotId" and "UploadBatch"."depotId" become NOT NULL; the foreign keys stay NO ACTION
-- (migration 20260930093000_master_data_no_orphans), so a depot with orders is never deleted.
--
-- Prisma runs this whole file as ONE transaction (checked with Prisma 5.22 on PostgreSQL 16: a
-- failure in the last statement rolled back the first one, and a lock taken early was still held
-- by the later statements). There is no BEGIN or COMMIT in this file on purpose: a COMMIT would
-- release the locks and split the migration.
--
-- What it does:
--   0. Locks first: "Order", "UploadBatch" and "Depot" in ACCESS EXCLUSIVE mode (SET NOT NULL needs
--      it anyway, so there is never a lock upgrade), "Tenant" in SHARE mode (no company is deleted
--      while a depot is added). It tries without waiting (NOWAIT) for about 30 s, then waits at most
--      5 s per try. A busy app delays the migration; it never makes it fail (no deadlock: a try that
--      cannot get every lock gives them all back and tries again).
--   1. "Depot"."historyOnly" (default false): a depot that only keeps old orders and files. It is
--      never active and never offered in a picker; the app refuses to make it active.
--   2. Gives every order and order file without a depot the best depot the data shows:
--      a. an order: the depot of its order file;
--      b. an order: the one depot of the plans that held it (its stops, its unserved rows, the
--         orders an option was made for, a manual baseline, the order it was brought forward to or
--         from). Two or more different depots: no answer here, counted as a conflict;
--      c. an order file: the one depot of its orders; then (a) again for the file's other orders;
--      d. both: the company's only active depot, else its only depot. With one active depot the
--         orders without a depot were already planned with it (ordersInScopeWhere before this PR),
--         so they stay on the same day's plan;
--      e. anything left: a depot "No depot (kept for history)" per company (code NO-DEPOT, or
--         NO-DEPOT-2, NO-DEPOT-3 ... when that code is taken, in any letter case), inactive and
--         history-only, at the coordinates of one of the company's depots (0, 0 when it has none).
--         Only for companies with two or more depots, or none.
--      Every depot written belongs to the row's own company. Rows that already have a depot are
--      never changed. Nothing is deleted.
--   3. One audit row per company that changed (action DEPOT_BACKFILL, entity Tenant) with the count
--      of each step, shown under Audit log; the totals are also sent as NOTICEs.
--   4. SET NOT NULL on both columns.
--
-- Safe on existing rows: each step only touches rows still without a depot, so a second run
-- changes nothing, and after step (e) no row is left without one. At NMWC's sizes the locks last
-- well under a second (NMWC has one depot and its orders already carry it: nothing to fill in).
-- Owner's read-only pre-check (what the migration will fill in, per company):
--   SELECT "tenantId", 'orders' AS what, count(*) FROM "Order" WHERE "depotId" IS NULL GROUP BY 1
--   UNION ALL
--   SELECT "tenantId", 'order files', count(*) FROM "UploadBatch" WHERE "depotId" IS NULL GROUP BY 1;
-- Rollback: ALTER TABLE "Order" ALTER COLUMN "depotId" DROP NOT NULL; and the same for
-- "UploadBatch". The filled-in depots, the history-only depots and the "historyOnly" column can
-- stay: old code ignores the column (but its Depots screen could switch a history-only depot on).

-- 0. Locks
DO $$
DECLARE
  tries integer := 0;
BEGIN
  PERFORM set_config('statement_timeout', '0', true);
  LOOP
    BEGIN
      IF tries < 300 THEN
        LOCK TABLE "Order", "UploadBatch", "Depot" IN ACCESS EXCLUSIVE MODE NOWAIT;
        LOCK TABLE "Tenant" IN SHARE MODE NOWAIT;
      ELSE
        PERFORM set_config('lock_timeout', '5s', true);
        LOCK TABLE "Order", "UploadBatch", "Depot" IN ACCESS EXCLUSIVE MODE;
        LOCK TABLE "Tenant" IN SHARE MODE;
      END IF;
      EXIT;
    EXCEPTION WHEN lock_not_available OR deadlock_detected THEN
      -- The locks of this try are given back with it; wait a little and try again.
      tries := tries + 1;
    END;
    PERFORM pg_sleep(0.05 + random() * 0.1);
  END LOOP;
  PERFORM set_config('lock_timeout', '0', true);
  RAISE NOTICE 'orders_always_have_depot: tables locked after % retries', tries;
END
$$;

-- 1. AlterTable
ALTER TABLE "Depot" ADD COLUMN IF NOT EXISTS "historyOnly" BOOLEAN NOT NULL DEFAULT false;

-- 2. Backfill. The counts go to a temporary table (dropped at the end) for the audit rows.
CREATE TEMP TABLE IF NOT EXISTS "_depot_backfill" ("tenantId" TEXT NOT NULL, "step" TEXT NOT NULL, "n" INTEGER NOT NULL, "note" TEXT);

-- 2a. An order: the depot of its order file.
WITH filled AS (
  UPDATE "Order" o
     SET "depotId" = b."depotId"
    FROM "UploadBatch" b
    JOIN "Depot" d ON d."id" = b."depotId"
   WHERE o."depotId" IS NULL
     AND o."uploadBatchId" = b."id"
     AND b."tenantId" = o."tenantId"
     AND d."tenantId" = o."tenantId"
  RETURNING o."tenantId"
)
INSERT INTO pg_temp."_depot_backfill" ("tenantId", "step", "n")
SELECT "tenantId", 'ordersFromFile', count(*)::int FROM filled GROUP BY 1;

-- 2b. An order: the one depot of the plans that held it.
WITH open_orders AS MATERIALIZED (
  SELECT "id", "tenantId", "deliveryDate" FROM "Order" WHERE "depotId" IS NULL
),
open_days AS (
  SELECT DISTINCT "tenantId", "deliveryDate" FROM open_orders
),
evidence AS (
  -- a stop on a plan
  SELECT ra."orderId", r."tenantId", r."depotId"
    FROM "RouteAssignment" ra
    JOIN open_orders oo ON oo."id" = ra."orderId"
    JOIN "RunPlan" r ON r."id" = ra."runId"
  UNION
  -- unserved in an option of a plan
  SELECT u."orderId", r."tenantId", r."depotId"
    FROM "UnservedOrder" u
    JOIN open_orders oo ON oo."id" = u."orderId"
    JOIN "ScenarioResult" s ON s."id" = u."scenarioId"
    JOIN "RunPlan" r ON r."id" = s."runId"
  UNION
  -- among the orders an option was made for (orders left out before the optimizer are only there)
  SELECT x."id", r."tenantId", r."depotId"
    FROM "ScenarioResult" s
    JOIN "RunPlan" r ON r."id" = s."runId"
    JOIN open_days od ON od."tenantId" = r."tenantId" AND od."deliveryDate" = r."runDate"
    CROSS JOIN LATERAL unnest(ARRAY['orderIds', 'frozenOrderIds', 'frozenLoadOrderIds']) AS k("key")
    CROSS JOIN LATERAL jsonb_array_elements_text(
      CASE WHEN jsonb_typeof(s."detailsJson" -> 'scope' -> k."key") = 'array'
           THEN s."detailsJson" -> 'scope' -> k."key"
           ELSE '[]'::jsonb END
    ) AS x("id")
  UNION
  -- a manual baseline of a plan
  SELECT m."orderId", r."tenantId", r."depotId"
    FROM "ManualBaselineAssignment" m
    JOIN open_orders oo ON oo."id" = m."orderId"
    JOIN "ManualBaseline" mb ON mb."id" = m."baselineId"
    JOIN "RunPlan" r ON r."id" = mb."runId"
  UNION
  -- the order it was brought forward to, or from
  SELECT oo."id", c."tenantId", c."depotId"
    FROM open_orders oo
    JOIN "Order" o ON o."id" = oo."id"
    JOIN "Order" c ON c."id" = o."carriedToOrderId"
   WHERE c."depotId" IS NOT NULL
  UNION
  SELECT oo."id", c."tenantId", c."depotId"
    FROM open_orders oo
    JOIN "Order" o ON o."id" = oo."id"
    JOIN "Order" c ON c."id" = o."carriedFromOrderId"
   WHERE c."depotId" IS NOT NULL
),
answer AS (
  SELECT oo."id", oo."tenantId", min(e."depotId") AS "depotId", count(DISTINCT e."depotId") AS depots
    FROM open_orders oo
    JOIN evidence e ON e."orderId" = oo."id" AND e."tenantId" = oo."tenantId"
    JOIN "Depot" d ON d."id" = e."depotId" AND d."tenantId" = oo."tenantId"
   GROUP BY oo."id", oo."tenantId"
),
filled AS (
  UPDATE "Order" o
     SET "depotId" = a."depotId"
    FROM answer a
   WHERE o."id" = a."id"
     AND a.depots = 1
     AND o."depotId" IS NULL
  RETURNING o."tenantId"
)
INSERT INTO pg_temp."_depot_backfill" ("tenantId", "step", "n")
SELECT "tenantId", 'ordersFromPlans', count(*)::int FROM filled GROUP BY 1
UNION ALL
SELECT "tenantId", 'ordersInPlansOfTwoDepots', count(*)::int FROM answer WHERE depots > 1 GROUP BY 1;

-- 2c. An order file: the one depot of its orders.
WITH answer AS (
  SELECT b."id", b."tenantId", min(o."depotId") AS "depotId", count(DISTINCT o."depotId") AS depots
    FROM "UploadBatch" b
    JOIN "Order" o ON o."uploadBatchId" = b."id" AND o."tenantId" = b."tenantId"
    JOIN "Depot" d ON d."id" = o."depotId" AND d."tenantId" = b."tenantId"
   WHERE b."depotId" IS NULL
   GROUP BY b."id", b."tenantId"
),
filled AS (
  UPDATE "UploadBatch" b
     SET "depotId" = a."depotId"
    FROM answer a
   WHERE b."id" = a."id"
     AND a.depots = 1
     AND b."depotId" IS NULL
  RETURNING b."tenantId"
)
INSERT INTO pg_temp."_depot_backfill" ("tenantId", "step", "n")
SELECT "tenantId", 'filesFromOrders', count(*)::int FROM filled GROUP BY 1
UNION ALL
SELECT "tenantId", 'filesWithOrdersOfTwoDepots', count(*)::int FROM answer WHERE depots > 1 GROUP BY 1;

-- 2a again: the other orders of a file that step 2c gave a depot.
WITH filled AS (
  UPDATE "Order" o
     SET "depotId" = b."depotId"
    FROM "UploadBatch" b
    JOIN "Depot" d ON d."id" = b."depotId"
   WHERE o."depotId" IS NULL
     AND o."uploadBatchId" = b."id"
     AND b."tenantId" = o."tenantId"
     AND d."tenantId" = o."tenantId"
  RETURNING o."tenantId"
)
INSERT INTO pg_temp."_depot_backfill" ("tenantId", "step", "n")
SELECT "tenantId", 'ordersFromFile', count(*)::int FROM filled GROUP BY 1;

-- 2d. Both: the company's only active depot, else its only depot.
WITH depots AS (
  SELECT d."tenantId",
         count(*) FILTER (WHERE d."active") AS active_n,
         min(d."id") FILTER (WHERE d."active") AS active_id,
         count(*) AS all_n,
         min(d."id") AS any_id
    FROM "Depot" d
   WHERE NOT d."historyOnly"
   GROUP BY d."tenantId"
),
only_depot AS (
  SELECT "tenantId", CASE WHEN active_n = 1 THEN active_id WHEN all_n = 1 THEN any_id END AS "depotId"
    FROM depots
),
orders_filled AS (
  UPDATE "Order" o
     SET "depotId" = od."depotId"
    FROM only_depot od
   WHERE o."depotId" IS NULL
     AND od."tenantId" = o."tenantId"
     AND od."depotId" IS NOT NULL
  RETURNING o."tenantId"
),
files_filled AS (
  UPDATE "UploadBatch" b
     SET "depotId" = od."depotId"
    FROM only_depot od
   WHERE b."depotId" IS NULL
     AND od."tenantId" = b."tenantId"
     AND od."depotId" IS NOT NULL
  RETURNING b."tenantId"
)
INSERT INTO pg_temp."_depot_backfill" ("tenantId", "step", "n")
SELECT "tenantId", 'ordersOnlyDepot', count(*)::int FROM orders_filled GROUP BY 1
UNION ALL
SELECT "tenantId", 'filesOnlyDepot', count(*)::int FROM files_filled GROUP BY 1;

-- 2e. Anything left: the company's history-only depot (created once, reused by a second run).
DO $$
DECLARE
  t record;
  hid text;
  hcode text;
  k integer;
  hlat double precision;
  hlng double precision;
  n_orders integer;
  n_files integer;
BEGIN
  FOR t IN
    SELECT "tenantId" FROM "Order" WHERE "depotId" IS NULL
    UNION
    SELECT "tenantId" FROM "UploadBatch" WHERE "depotId" IS NULL
    ORDER BY 1
  LOOP
    hid := NULL;
    hcode := NULL;
    SELECT d."id", d."code" INTO hid, hcode
      FROM "Depot" d
     WHERE d."tenantId" = t."tenantId" AND d."historyOnly"
     ORDER BY d."code", d."id"
     LIMIT 1;
    IF hid IS NULL THEN
      hcode := 'NO-DEPOT';
      k := 1;
      -- The unique key ("tenantId", "code") is case-sensitive; the app compares codes in any case.
      WHILE EXISTS (SELECT 1 FROM "Depot" d WHERE d."tenantId" = t."tenantId" AND upper(d."code") = upper(hcode)) LOOP
        k := k + 1;
        hcode := 'NO-DEPOT-' || k;
      END LOOP;
      hlat := NULL;
      hlng := NULL;
      SELECT d."lat", d."lng" INTO hlat, hlng
        FROM "Depot" d
       WHERE d."tenantId" = t."tenantId" AND NOT d."historyOnly"
       ORDER BY d."active" DESC, d."code", d."id"
       LIMIT 1;
      hid := 'mig' || replace(gen_random_uuid()::text, '-', '');
      INSERT INTO "Depot" ("id", "tenantId", "code", "name", "lat", "lng", "address", "active", "historyOnly")
      VALUES (hid, t."tenantId", hcode, 'No depot (kept for history)', coalesce(hlat, 0), coalesce(hlng, 0), NULL, false, true);
      INSERT INTO pg_temp."_depot_backfill" VALUES (t."tenantId", 'historyDepotCreated', 1, hcode);
    END IF;
    UPDATE "Order" SET "depotId" = hid WHERE "tenantId" = t."tenantId" AND "depotId" IS NULL;
    GET DIAGNOSTICS n_orders = ROW_COUNT;
    UPDATE "UploadBatch" SET "depotId" = hid WHERE "tenantId" = t."tenantId" AND "depotId" IS NULL;
    GET DIAGNOSTICS n_files = ROW_COUNT;
    INSERT INTO pg_temp."_depot_backfill" VALUES
      (t."tenantId", 'ordersHistoryDepot', n_orders, hcode),
      (t."tenantId", 'filesHistoryDepot', n_files, hcode);
  END LOOP;
END
$$;

-- 3. One audit row per company that changed, and the totals as NOTICEs.
INSERT INTO "AuditLog" ("id", "tenantId", "action", "entity", "entityId", "afterJson", "createdAt")
SELECT 'mig' || replace(gen_random_uuid()::text, '-', ''),
       l."tenantId",
       'DEPOT_BACKFILL',
       'Tenant',
       l."tenantId",
       jsonb_build_object(
         'ordersFromFile', coalesce(sum(l."n") FILTER (WHERE l."step" = 'ordersFromFile'), 0),
         'ordersFromPlans', coalesce(sum(l."n") FILTER (WHERE l."step" = 'ordersFromPlans'), 0),
         'ordersInPlansOfTwoDepots', coalesce(sum(l."n") FILTER (WHERE l."step" = 'ordersInPlansOfTwoDepots'), 0),
         'filesFromOrders', coalesce(sum(l."n") FILTER (WHERE l."step" = 'filesFromOrders'), 0),
         'filesWithOrdersOfTwoDepots', coalesce(sum(l."n") FILTER (WHERE l."step" = 'filesWithOrdersOfTwoDepots'), 0),
         'ordersOnlyDepot', coalesce(sum(l."n") FILTER (WHERE l."step" = 'ordersOnlyDepot'), 0),
         'filesOnlyDepot', coalesce(sum(l."n") FILTER (WHERE l."step" = 'filesOnlyDepot'), 0),
         'ordersHistoryDepot', coalesce(sum(l."n") FILTER (WHERE l."step" = 'ordersHistoryDepot'), 0),
         'filesHistoryDepot', coalesce(sum(l."n") FILTER (WHERE l."step" = 'filesHistoryDepot'), 0),
         'historyDepotCode', max(l."note") FILTER (WHERE l."step" IN ('ordersHistoryDepot', 'filesHistoryDepot')),
         'historyDepotCreated', coalesce(sum(l."n") FILTER (WHERE l."step" = 'historyDepotCreated'), 0) > 0,
         'reason', 'Owner rule: every order and order file has a depot. Those without one got the depot of their file, their plans or the company''s only depot; the rest went to the history-only depot.',
         'by', 'migration 20260930120000_orders_always_have_depot'
       ),
       NOW()
  FROM pg_temp."_depot_backfill" l
 GROUP BY l."tenantId"
HAVING sum(l."n") FILTER (WHERE l."step" NOT IN ('ordersInPlansOfTwoDepots', 'filesWithOrdersOfTwoDepots')) > 0;

DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT "step", sum("n")::int AS n, count(DISTINCT "tenantId")::int AS companies
      FROM pg_temp."_depot_backfill"
     GROUP BY "step"
     ORDER BY "step"
  LOOP
    RAISE NOTICE 'orders_always_have_depot: % = % (% companies)', r."step", r.n, r.companies;
  END LOOP;
END
$$;

DROP TABLE IF EXISTS pg_temp."_depot_backfill";

-- 4. AlterTable
ALTER TABLE "Order" ALTER COLUMN "depotId" SET NOT NULL;

-- AlterTable
ALTER TABLE "UploadBatch" ALTER COLUMN "depotId" SET NOT NULL;
