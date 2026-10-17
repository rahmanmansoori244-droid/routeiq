-- Salesman ETA (owner request 17 Oct 2026): the owner prints, every evening after planning, one page per
-- sales route (salesman) with that salesman's customers of the next day and the expected arrival window, so
-- the salesmen can tell their customers. The order file's "route" column (the salesman's route code) was
-- ignored by the upload; it is now kept per invoice line (lib/dispatch/sales-route.ts, read only by the
-- export lib/exports/salesman-eta.ts).
--
-- Additive: one nullable column, no default, no index, no CHECK (the format - trimmed, upper-case, at most 40
-- characters - is set by the app). No existing row needs a value: NULL = no route given (the line is listed
-- under "Route not given"). A nullable column without a default changes the catalog only (no table rewrite).
-- Code from before this release never reads it, so an app rollback is safe for the database at any time;
-- lines added while the old code serves are stored without a route.
--
-- The lock, as in 20261016090000_customer_loading_instruction: ADD COLUMN needs a short ACCESS EXCLUSIVE lock
-- on "OrderLine", which the plan screen, the sheets and the day overview read all day, and Railway runs this
-- while the old version still serves. A lock request that queues behind a long transaction blocks every later
-- read of "OrderLine" until it is granted. So the lock is taken first, in two steps:
--  1. tried without waiting (NOWAIT, which never makes the app wait) for 6 minutes: longer than any
--     transaction of the app (the longest, Start fresh, may run 5 minutes), so a busy app delays the deploy
--     but never makes it fail and never waits for it;
--  2. then waited for at most 5 s per try, 6 tries. Still not granted - something outside the app holds
--     "OrderLine" (for example an open transaction of a SQL client): the migration stops with "order line
--     table busy", nothing is changed, and the old version keeps serving (P3018; the next deploy answers
--     P3009 until `prisma migrate resolve --rolled-back 20261017200000_order_line_sales_route`, then
--     redeploy: docs/PROJECT_HANDBOOK.md 5.11). Find and end that transaction first (pg_stat_activity).
-- Prisma runs this file as one transaction, so the lock is held until the column is added and is released at
-- the end.
-- Rollback: ALTER TABLE "OrderLine" DROP COLUMN "salesRoute";

-- No statement or transaction time limit for this migration's transaction (is_local = true: nothing outside
-- it changes), so a limit set on the database or the role cannot cancel the lock step while it waits.
-- transaction_timeout exists from PostgreSQL 17 on.
SELECT set_config('statement_timeout', '0', true);
SELECT set_config('transaction_timeout', '0', true) WHERE current_setting('server_version_num')::int >= 170000;

DO $$
DECLARE
  nowait_until timestamptz := clock_timestamp() + interval '6 minutes';
  waiting boolean := false;
  waits integer := 0;
BEGIN
  LOOP
    waiting := clock_timestamp() >= nowait_until;
    BEGIN
      IF NOT waiting THEN
        LOCK TABLE "OrderLine" IN ACCESS EXCLUSIVE MODE NOWAIT;
      ELSE
        PERFORM set_config('lock_timeout', '5s', true);
        LOCK TABLE "OrderLine" IN ACCESS EXCLUSIVE MODE;
      END IF;
      EXIT;
    EXCEPTION WHEN lock_not_available OR deadlock_detected THEN
      IF waiting THEN
        waits := waits + 1;
        IF waits >= 6 THEN
          RAISE EXCEPTION 'order line table busy: could not lock "OrderLine" to add "salesRoute" in about 6.5 minutes (another transaction holds it); nothing was changed, end that transaction and deploy again';
        END IF;
      END IF;
    END;
    PERFORM pg_sleep(0.05 + random() * 0.1);
  END LOOP;
  PERFORM set_config('lock_timeout', '0', true);
END $$;

-- AlterTable
ALTER TABLE "OrderLine" ADD COLUMN     "salesRoute" TEXT;
