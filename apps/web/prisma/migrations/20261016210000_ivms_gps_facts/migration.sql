-- IVMS live link (16 Oct 2026), GPS stop times: what the stop detector saw but must not write by itself
-- (lib/ivms/stops.ts, binding review H4): two pending customers with stays at the same time (the phone
-- asks "Which customer?"), a customer pin near the depot, a stay out of sequence that was too short, or
-- several loads with no depot boundary to tell their trips apart. Stored per truck-day as a fact for the
-- office (the day screen's live map shows it); never a time, never a result.
--
-- Additive only: one nullable JSONB column on "IvmsTruckDay", a table created by 20261016200000_ivms_live
-- and read by no code before this release (so the lock it needs is uncontended), plus a CHECK on its
-- shape (a JSON array, at most 8 KB). Code from before this release never reads it: app rollback safe.
--
-- Rollback:
--   ALTER TABLE "IvmsTruckDay" DROP CONSTRAINT "IvmsTruckDay_gpsFactsJson_shape", DROP COLUMN "gpsFactsJson";
--   DELETE FROM "_prisma_migrations" WHERE migration_name = '20261016210000_ivms_gps_facts';

-- The lock, as in 20261016090000_customer_loading_instruction: ADD COLUMN and the CHECK need a short ACCESS
-- EXCLUSIVE lock on "IvmsTruckDay". Tried without waiting (NOWAIT) for 6 minutes, then waited for at most
-- 5 s per try, 6 tries; still busy: the migration stops with "table busy" and nothing is changed (P3018;
-- `prisma migrate resolve --rolled-back 20261016210000_ivms_gps_facts`, then redeploy: PROJECT_HANDBOOK.md
-- 5.11). The serving version never reads this table, so in practice the lock is granted at once.
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
        LOCK TABLE "IvmsTruckDay" IN ACCESS EXCLUSIVE MODE NOWAIT;
      ELSE
        PERFORM set_config('lock_timeout', '5s', true);
        LOCK TABLE "IvmsTruckDay" IN ACCESS EXCLUSIVE MODE;
      END IF;
      EXIT;
    EXCEPTION WHEN lock_not_available OR deadlock_detected THEN
      IF waiting THEN
        waits := waits + 1;
        IF waits >= 6 THEN
          RAISE EXCEPTION 'table busy: could not lock "IvmsTruckDay" to add "gpsFactsJson" in about 6.5 minutes (another transaction holds it); nothing was changed, end that transaction and deploy again';
        END IF;
      END IF;
    END;
    PERFORM pg_sleep(0.05 + random() * 0.1);
  END LOOP;
  PERFORM set_config('lock_timeout', '0', true);
END $$;

-- AlterTable
ALTER TABLE "IvmsTruckDay" ADD COLUMN     "gpsFactsJson" JSONB;

ALTER TABLE "IvmsTruckDay" ADD CONSTRAINT "IvmsTruckDay_gpsFactsJson_shape" CHECK (
  "gpsFactsJson" IS NULL OR (jsonb_typeof("gpsFactsJson") = 'array' AND octet_length("gpsFactsJson"::text) <= 8192)
);
