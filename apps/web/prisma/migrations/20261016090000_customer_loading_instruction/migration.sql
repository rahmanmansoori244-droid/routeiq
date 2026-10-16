-- Loading instruction per customer (owner request 16 Oct 2026): some customers need their order loaded on
-- the truck in a specific way, and the dispatcher and the warehouse must see it at the top of the load
-- sheet. One short text per customer row (lib/dispatch/loading-instruction.ts), printed in a
-- "SPECIAL LOADING" box on the warehouse load sheet, the driver sheet and the Excel load sheet of every load
-- with the customer, and shown on the plan screen.
--
-- Additive: one nullable column, no default, no index, no CHECK (the format - at most 200 characters on
-- one line - is checked by the app; the sheets fold and shorten a longer stored value, they never drop
-- it). No existing row needs a value: NULL = no instruction. A nullable column without a default changes
-- the catalog only (no table rewrite). Code from before this release never reads it, so an app rollback
-- is safe for the database at any time; but the old code prints no SPECIAL LOADING box, so after such a
-- rollback the warehouse must be told the instructions another way until the feature is back.
--
-- The lock (review of the design, M7, and the review of 16 Oct): ADD COLUMN needs a short ACCESS EXCLUSIVE
-- lock on "Customer", and Railway runs this while the old version still serves. A lock request that
-- queues behind a long transaction blocks every later read of "Customer" (plan screen, sheets) until it is
-- granted. So the lock is taken first, in two steps:
--  1. tried without waiting (NOWAIT, which never makes the app wait) for 6 minutes: longer than any
--     transaction of the app (the longest, Start fresh, may run 5 minutes; a hire check's apply 2), so a
--     busy app delays the deploy but never makes it fail and never waits for it;
--  2. then waited for at most 5 s per try, 6 tries (a steady stream of short reads that NOWAIT never
--     finds a gap in). Still not granted - something outside the app holds "Customer" (for example an
--     open transaction of a SQL client): the migration stops with "customer table busy", nothing is
--     changed, and the old version keeps serving (P3018; the next deploy answers P3009 until
--     `prisma migrate resolve --rolled-back 20261016090000_customer_loading_instruction`, then redeploy:
--     docs/PROJECT_HANDBOOK.md 5.11). Find and end that transaction first (pg_stat_activity).
-- Prisma runs this file as one transaction, so the lock is held until the column is added and is
-- released at the end (as in 20260930120000_orders_always_have_depot).
-- Rollback: ALTER TABLE "Customer" DROP COLUMN "loadingInstruction";

-- No statement or transaction time limit for this migration's transaction (is_local = true: nothing
-- outside it changes), so a limit set on the database or the role cannot cancel the lock step while it
-- waits (as in 20260930120000_orders_always_have_depot). transaction_timeout exists from PostgreSQL 17 on.
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
        LOCK TABLE "Customer" IN ACCESS EXCLUSIVE MODE NOWAIT;
      ELSE
        PERFORM set_config('lock_timeout', '5s', true);
        LOCK TABLE "Customer" IN ACCESS EXCLUSIVE MODE;
      END IF;
      EXIT;
    EXCEPTION WHEN lock_not_available OR deadlock_detected THEN
      IF waiting THEN
        waits := waits + 1;
        IF waits >= 6 THEN
          RAISE EXCEPTION 'customer table busy: could not lock "Customer" to add "loadingInstruction" in about 6.5 minutes (another transaction holds it); nothing was changed, end that transaction and deploy again';
        END IF;
      END IF;
    END;
    PERFORM pg_sleep(0.05 + random() * 0.1);
  END LOOP;
  PERFORM set_config('lock_timeout', '0', true);
END $$;

-- AlterTable
ALTER TABLE "Customer" ADD COLUMN     "loadingInstruction" TEXT;
