-- Loading instruction per customer (owner request 16 Oct 2026): some customers need their order loaded on
-- the truck in a specific way, and an order was cancelled because it was not; the dispatcher and the
-- warehouse must see it at the top of the load sheet. One short text per customer row
-- (lib/dispatch/loading-instruction.ts), printed in a "SPECIAL LOADING" box on the warehouse load sheet,
-- the driver sheet and the Excel load sheet of every load with the customer, and shown on the plan screen.
--
-- Additive: one nullable column, no default, no index, no CHECK (the format - at most 200 characters on
-- one line - is checked by the app; the sheets fold and shorten a longer stored value, they never drop
-- it). No existing row needs a value: NULL = no instruction. A nullable column without a default changes
-- the catalog only (no table rewrite). Code from before this release never reads it, so an app rollback
-- is safe at any time.
--
-- The lock (review of the design, M7): ADD COLUMN needs a short ACCESS EXCLUSIVE lock on "Customer", and
-- Railway runs this while the old version still serves. A lock request that queues behind a long
-- transaction blocks every later read of "Customer" (plan screen, sheets) until it is granted. So the lock
-- is taken first: tried without waiting (NOWAIT, which never makes the app wait) for about 30 s, then
-- waited for at most 5 s per try, 6 tries. Still not granted: the migration stops with "customer table
-- busy", nothing is changed, and the old version keeps serving (P3018; the next deploy answers P3009
-- until `prisma migrate resolve --rolled-back 20261016090000_customer_loading_instruction`, then redeploy:
-- docs/PROJECT_HANDBOOK.md 5.11). Prisma runs this file as one transaction, so the lock is held until the
-- column is added and is released at the end (as in 20260930120000_orders_always_have_depot).
-- Rollback: ALTER TABLE "Customer" DROP COLUMN "loadingInstruction";

-- No statement or transaction time limit for this migration's transaction (is_local = true: nothing
-- outside it changes), so a limit set on the database or the role cannot cancel the lock step while it
-- waits (as in 20260930120000_orders_always_have_depot). transaction_timeout exists from PostgreSQL 17 on.
SELECT set_config('statement_timeout', '0', true);
SELECT set_config('transaction_timeout', '0', true) WHERE current_setting('server_version_num')::int >= 170000;

DO $$
DECLARE
  tries integer := 0;
BEGIN
  LOOP
    BEGIN
      IF tries < 300 THEN
        LOCK TABLE "Customer" IN ACCESS EXCLUSIVE MODE NOWAIT;
      ELSE
        PERFORM set_config('lock_timeout', '5s', true);
        LOCK TABLE "Customer" IN ACCESS EXCLUSIVE MODE;
      END IF;
      EXIT;
    EXCEPTION WHEN lock_not_available THEN
      tries := tries + 1;
      IF tries >= 306 THEN
        RAISE EXCEPTION 'customer table busy: could not lock "Customer" to add "loadingInstruction" (about 60 s); nothing was changed, deploy again later';
      END IF;
    END;
    IF tries < 300 THEN
      PERFORM pg_sleep(0.05 + random() * 0.1);
    END IF;
  END LOOP;
  PERFORM set_config('lock_timeout', '0', true);
END $$;

-- AlterTable
ALTER TABLE "Customer" ADD COLUMN     "loadingInstruction" TEXT;
