-- IVMS live link (16 Oct 2026), fixes of the pre-merge reviews: two facts the GPS times need.
--   IvmsState.providerSkewAt, providerSkewOffsetMin  when the provider's clock skew was measured and with
--       which AYUN_API_TIME_OFFSET_MIN: the history pulls and the GPS stop times run only while a skew
--       measured with the offset in use is within limits (lib/ivms/budget.ts clockCheck; first review H-1:
--       a wrong offset must never write GPS times shifted by hours).
--   IvmsTruckDay.trailFrom  the tracker was mapped to the truck at this time: no point from before it is
--       pulled or used (second review M-1: a tracker moved from another truck never brings that truck's
--       morning along).
--
-- Additive only: three nullable columns on two tables created by 20261016200000_ivms_live and read by no
-- code before this release (so the lock is uncontended). Code from before this release never reads them:
-- app rollback safe.
--
-- Rollback:
--   ALTER TABLE "IvmsTruckDay" DROP COLUMN "trailFrom";
--   ALTER TABLE "IvmsState" DROP COLUMN "providerSkewAt", DROP COLUMN "providerSkewOffsetMin";
--   DELETE FROM "_prisma_migrations" WHERE migration_name = '20261016220000_ivms_review_fixes';

-- The lock, as in 20261016210000_ivms_gps_facts: ADD COLUMN needs a short ACCESS EXCLUSIVE lock on
-- "IvmsState" and "IvmsTruckDay". Tried without waiting (NOWAIT) for 6 minutes, then waited for at most 5 s
-- per try, 6 tries; still busy: the migration stops with "tables busy" and nothing is changed (P3018;
-- `prisma migrate resolve --rolled-back 20261016220000_ivms_review_fixes`, then redeploy:
-- PROJECT_HANDBOOK.md 5.11). The serving version never reads these tables, so in practice the lock is
-- granted at once.
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
        LOCK TABLE "IvmsState", "IvmsTruckDay" IN ACCESS EXCLUSIVE MODE NOWAIT;
      ELSE
        PERFORM set_config('lock_timeout', '5s', true);
        LOCK TABLE "IvmsState", "IvmsTruckDay" IN ACCESS EXCLUSIVE MODE;
      END IF;
      EXIT;
    EXCEPTION WHEN lock_not_available OR deadlock_detected THEN
      -- The block's savepoint is rolled back: a lock it took before the one that failed is released too.
      IF waiting THEN
        waits := waits + 1;
        IF waits >= 6 THEN
          RAISE EXCEPTION 'tables busy: could not lock "IvmsState" and "IvmsTruckDay" for the IVMS review fixes in about 6.5 minutes (another transaction holds one of them); nothing was changed, end that transaction and deploy again';
        END IF;
      END IF;
    END;
    PERFORM pg_sleep(0.05 + random() * 0.1);
  END LOOP;
  PERFORM set_config('lock_timeout', '0', true);
END $$;

-- AlterTable
ALTER TABLE "IvmsState" ADD COLUMN     "providerSkewAt" TIMESTAMPTZ(3),
ADD COLUMN     "providerSkewOffsetMin" INTEGER;

-- AlterTable
ALTER TABLE "IvmsTruckDay" ADD COLUMN     "trailFrom" TIMESTAMPTZ(3);

-- The offset a skew was measured with is an AYUN_API_TIME_OFFSET_MIN value (lib/ivms/env.ts: -720..720).
ALTER TABLE "IvmsState" ADD CONSTRAINT "IvmsState_providerSkewOffsetMin_range" CHECK ("providerSkewOffsetMin" IS NULL OR "providerSkewOffsetMin" BETWEEN -720 AND 720);
