-- GPS alerts (owner request 18 Oct 2026), review of 18 Oct 2026, finding 6: whether a depot move the stop
-- detector derived from the trail (IvmsEvent origin TRAIL) has an exact time is decided when the move is
-- written, and kept on the row. Before, the alerts (lib/alerts/facts.ts) and the replay export
-- (lib/alerts/replay-export.ts) worked it out again from the TruckTrailPoint rows next to the move, which the
-- retention deletes after ivmsTrailDays (1-7 days, default 2): a day exported later had every trail move
-- "not exact" (the depot-based GPS alerts R2 and R4 then barely show in a replay), and the live alerts'
-- open rows of yesterday changed their words when the points went.
--   IvmsEvent.observed  TRAIL moves only: true = a trail point at most observedMaxGapSec (300 s) before it,
--       false = a gap before it (the time is only an upper bound). NULL: a zone move (webhook or backstop:
--       the device's own event, exact), or a trail move written before this release (read against the
--       trail points while they are kept, as before).
--
-- Additive only: one nullable column, no default (no row is rewritten), and a CHECK that only a TRAIL move
-- carries it (every existing row has NULL: the check reads the table once, in milliseconds). Code from
-- before this release never reads or writes it: app rollback safe.
--
-- Rollback:
--   ALTER TABLE "IvmsEvent" DROP CONSTRAINT "IvmsEvent_observed_trail_only", DROP COLUMN "observed";
--   DELETE FROM "_prisma_migrations" WHERE migration_name = '20261018130000_ivms_move_observed';

-- The lock, as in 20261016220000_ivms_review_fixes: ADD COLUMN and the CHECK need a short ACCESS EXCLUSIVE
-- lock on "IvmsEvent", which the serving version writes (the Ayun webhook, the poller's backstop, the stop
-- detector, the retention). Tried without waiting (NOWAIT) for 6 minutes, then waited for at most 5 s per
-- try, 6 tries; still busy: the migration stops with "table busy" and nothing is changed (P3018;
-- `prisma migrate resolve --rolled-back 20261018130000_ivms_move_observed`, then redeploy: PROJECT_HANDBOOK.md
-- 5.11). Those writes are single short statements, so in practice the lock is granted within a few tries.
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
        LOCK TABLE "IvmsEvent" IN ACCESS EXCLUSIVE MODE NOWAIT;
      ELSE
        PERFORM set_config('lock_timeout', '5s', true);
        LOCK TABLE "IvmsEvent" IN ACCESS EXCLUSIVE MODE;
      END IF;
      EXIT;
    EXCEPTION WHEN lock_not_available OR deadlock_detected THEN
      IF waiting THEN
        waits := waits + 1;
        IF waits >= 6 THEN
          RAISE EXCEPTION 'table busy: could not lock "IvmsEvent" to keep whether a GPS depot move is exact in about 6.5 minutes (another transaction holds it); nothing was changed, end that transaction and deploy again';
        END IF;
      END IF;
    END;
    PERFORM pg_sleep(0.05 + random() * 0.1);
  END LOOP;
  PERFORM set_config('lock_timeout', '0', true);
END $$;

-- AlterTable
ALTER TABLE "IvmsEvent" ADD COLUMN     "observed" BOOLEAN;

-- Only a move the detector derived from the trail says whether its time is exact.
ALTER TABLE "IvmsEvent" ADD CONSTRAINT "IvmsEvent_observed_trail_only" CHECK ("observed" IS NULL OR "origin" = 'TRAIL');
