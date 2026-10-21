-- GPS times win over late phone times (owner decision 21 Oct 2026: "GPS arrival should win of course"; the GPS
-- timing study of 19-20 Oct 2026: Ayun's own detection was right, the times shown were wrong on about 15% of the
-- visits because the driver's late taps always won). The visit rebuild (lib/delivery/visit.ts) now REPLACES a
-- phone arrival made late in a GPS stay (F1), the phone's automatic departure (F4), the arrival and the result of
-- taps made after the truck left (F5), and the result standing in for a departure up to 60 min after it (F2).
-- The times it replaced can no longer be read back from the row, so they are stored:
--   StopVisit.ownArrivedAt, ownArrivalSource, ownArrivalDistanceM, ownArrivalAccuracyM, ownArrivalObserved
--       the arrival the driver's and the office's events alone gave, set only when the shown arrival is the GPS
--       one (arrivalSource AYUN) and an own arrival existed. The driver page, the photo old-check, the office's
--       "Left" check and the on-time KPI read it (ownArrivalOf); ownArrivalAccuracyM is erased with the positions.
--   StopVisit.ownDepartedAt, ownDepartureSource, ownDepartedAtOutcome
--       the own departure (a real one, or the result standing in for it), set only when the shown departure is
--       the GPS one and an own departure existed. With the arrival fields, withoutGpsTimes gives back exactly the
--       visit the driver and the office made (the alerts below ALERTS, the turnaround, the analysis by taps).
--   StopVisit.afterResultMinutes
--       F2: the minutes the truck still stood at the stop after the driver's result (the GPS departure shown is
--       more than 15 min after it), never unloading: every unloading time ends at the result.
--
-- Additive only: nine nullable columns, no default (no row is rewritten, the catalog only), and CHECKs on the new
-- columns alone (every existing row has NULL, so each check reads the table once, in milliseconds). No CHECK ties
-- them to the other columns: code from before this release never reads or writes them, and an app rollback
-- rebuilds visits with the old rules and leaves them stale, which the readers ignore (they read them only under an
-- AYUN source): app rollback safe. The next rebuild by this version writes them again.
--
-- Rollback:
--   ALTER TABLE "StopVisit" DROP CONSTRAINT "StopVisit_ownArrival_pair", DROP CONSTRAINT "StopVisit_ownArrival_notGps", DROP CONSTRAINT "StopVisit_ownDeparture_pair", DROP CONSTRAINT "StopVisit_ownDeparture_notGps", DROP CONSTRAINT "StopVisit_afterResultMinutes_range";
--   ALTER TABLE "StopVisit" DROP COLUMN "ownArrivedAt", DROP COLUMN "ownArrivalSource", DROP COLUMN "ownArrivalDistanceM", DROP COLUMN "ownArrivalAccuracyM", DROP COLUMN "ownArrivalObserved", DROP COLUMN "ownDepartedAt", DROP COLUMN "ownDepartureSource", DROP COLUMN "ownDepartedAtOutcome", DROP COLUMN "afterResultMinutes";
--   DELETE FROM "_prisma_migrations" WHERE migration_name = '20261022090000_gps_times_win';

-- The lock, as in 20261019120000_gps_site_radius_away: ADD COLUMN and the CHECKs need a short ACCESS EXCLUSIVE
-- lock on "StopVisit", which the serving version reads and writes (the plan screen, the sheets, the driver page's
-- every tap, the stop detector). Tried without waiting (NOWAIT) for 6 minutes, then waited for at most 5 s per
-- try, 6 tries; still busy: the migration stops with "tables busy" and nothing is changed (P3018; `prisma migrate
-- resolve --rolled-back 20261022090000_gps_times_win`, then redeploy: PROJECT_HANDBOOK.md 5.11). The app's
-- writes to it are short transactions, so in practice the lock is granted within a few tries.
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
        LOCK TABLE "StopVisit" IN ACCESS EXCLUSIVE MODE NOWAIT;
      ELSE
        PERFORM set_config('lock_timeout', '5s', true);
        LOCK TABLE "StopVisit" IN ACCESS EXCLUSIVE MODE;
      END IF;
      EXIT;
    EXCEPTION WHEN lock_not_available OR deadlock_detected THEN
      IF waiting THEN
        waits := waits + 1;
        IF waits >= 6 THEN
          RAISE EXCEPTION 'tables busy: could not lock "StopVisit" to add the own times the GPS replaced in about 6.5 minutes (another transaction holds it); nothing was changed, end that transaction and deploy again';
        END IF;
      END IF;
    END;
    PERFORM pg_sleep(0.05 + random() * 0.1);
  END LOOP;
  PERFORM set_config('lock_timeout', '0', true);
END $$;

-- AlterTable
ALTER TABLE "StopVisit" ADD COLUMN     "afterResultMinutes" DOUBLE PRECISION,
ADD COLUMN     "ownArrivalAccuracyM" DOUBLE PRECISION,
ADD COLUMN     "ownArrivalDistanceM" DOUBLE PRECISION,
ADD COLUMN     "ownArrivalObserved" BOOLEAN,
ADD COLUMN     "ownArrivalSource" "StopEventSource",
ADD COLUMN     "ownArrivedAt" TIMESTAMPTZ(3),
ADD COLUMN     "ownDepartedAt" TIMESTAMPTZ(3),
ADD COLUMN     "ownDepartedAtOutcome" BOOLEAN,
ADD COLUMN     "ownDepartureSource" "StopEventSource";

-- An own time and its source are stored together, and the source is never the GPS (AYUN): the own times are the
-- driver's and the office's (lib/delivery/visit.ts withOwnTimes).
ALTER TABLE "StopVisit" ADD CONSTRAINT "StopVisit_ownArrival_pair" CHECK (("ownArrivedAt" IS NULL) = ("ownArrivalSource" IS NULL));
ALTER TABLE "StopVisit" ADD CONSTRAINT "StopVisit_ownArrival_notGps" CHECK ("ownArrivalSource" IS NULL OR "ownArrivalSource" <> 'AYUN');
ALTER TABLE "StopVisit" ADD CONSTRAINT "StopVisit_ownDeparture_pair" CHECK (("ownDepartedAt" IS NULL) = ("ownDepartureSource" IS NULL));
ALTER TABLE "StopVisit" ADD CONSTRAINT "StopVisit_ownDeparture_notGps" CHECK ("ownDepartureSource" IS NULL OR "ownDepartureSource" <> 'AYUN');

-- The minutes after the result are NULL (none) or a positive number of minutes, at most a day (the rebuild never
-- stores 0; the GPS departure it measures to is at most 60 min after the result).
ALTER TABLE "StopVisit" ADD CONSTRAINT "StopVisit_afterResultMinutes_range" CHECK ("afterResultMinutes" IS NULL OR ("afterResultMinutes" > 0 AND "afterResultMinutes" <= 1440));
