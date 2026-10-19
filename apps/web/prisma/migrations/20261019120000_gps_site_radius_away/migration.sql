-- GPS stop detection at big customers (owner request 19 Oct 2026: "at big customers the truck moves between
-- drop points and the model thinks it left"; the GPS study of 18-19 Oct 2026, 76 driver-tapped visits).
--   Customer.siteRadiusM   the customer's GPS site radius in metres, 100-500, or NULL (the default: the
--       company's stop radius, today's behaviour). The stop detector (lib/ivms/stops.ts) ends a stay at a
--       customer only when the truck leaves this radius (a second drop point 353-378 m from the pin was the
--       study's case), and the GPS alerts' "the truck is at the stop" (lib/alerts/gps.ts) uses it. Set by
--       the office in the customer's Details dialog (lib/ivms/site-radius.ts checks the same bounds).
--   StopVisit.awayMinutes  minutes the truck was away from the customer between the visit's shown arrival
--       and departure, by its GPS stays (beyond 500 m of the pin, or at another customer, and back: a 6.3 km
--       trip and a 94-minute park 1.2 km away in the study), or NULL (none: every visit without GPS). Written
--       by the visit rebuild (lib/delivery/visit.ts awayMinutesOf); every unloading time and the UNLOAD_OVER
--       alert take it off (on site = departure - arrival - awayMinutes).
--
-- Additive only: two nullable columns, no default (no row is rewritten, the catalog only), and a CHECK on
-- each (every existing row has NULL, so each check reads its table once, in milliseconds). Code from before
-- this release never reads or writes them: app rollback safe (an old version rebuilding a visit leaves its
-- awayMinutes as it was; the next rebuild by this version writes it again).
--
-- Rollback:
--   ALTER TABLE "StopVisit" DROP CONSTRAINT "StopVisit_awayMinutes_range", DROP COLUMN "awayMinutes";
--   ALTER TABLE "Customer" DROP CONSTRAINT "Customer_siteRadiusM_range", DROP COLUMN "siteRadiusM";
--   DELETE FROM "_prisma_migrations" WHERE migration_name = '20261019120000_gps_site_radius_away';

-- The lock, as in 20261016090000_customer_loading_instruction and 20261018130000_ivms_move_observed: ADD
-- COLUMN and the CHECKs need a short ACCESS EXCLUSIVE lock on "Customer" and "StopVisit", which the serving
-- version reads and writes (the plan screen, the sheets, the driver page's every tap, the stop detector).
-- Tried without waiting (NOWAIT) for 6 minutes, then waited for at most 5 s per try, 6 tries; still busy:
-- the migration stops with "tables busy" and nothing is changed (P3018; `prisma migrate resolve
-- --rolled-back 20261019120000_gps_site_radius_away`, then redeploy: PROJECT_HANDBOOK.md 5.11). The app's
-- writes to them are short transactions, so in practice the lock is granted within a few tries. Both
-- tables in one LOCK statement, in this order, so the step never holds one while waiting for the other.
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
        LOCK TABLE "Customer", "StopVisit" IN ACCESS EXCLUSIVE MODE NOWAIT;
      ELSE
        PERFORM set_config('lock_timeout', '5s', true);
        LOCK TABLE "Customer", "StopVisit" IN ACCESS EXCLUSIVE MODE;
      END IF;
      EXIT;
    EXCEPTION WHEN lock_not_available OR deadlock_detected THEN
      IF waiting THEN
        waits := waits + 1;
        IF waits >= 6 THEN
          RAISE EXCEPTION 'tables busy: could not lock "Customer" and "StopVisit" to add the GPS site radius and the minutes away in about 6.5 minutes (another transaction holds them); nothing was changed, end that transaction and deploy again';
        END IF;
      END IF;
    END;
    PERFORM pg_sleep(0.05 + random() * 0.1);
  END LOOP;
  PERFORM set_config('lock_timeout', '0', true);
END $$;

-- AlterTable
ALTER TABLE "Customer" ADD COLUMN     "siteRadiusM" INTEGER;

-- AlterTable
ALTER TABLE "StopVisit" ADD COLUMN     "awayMinutes" DOUBLE PRECISION;

-- A site radius is whole metres from 100 to 500 (lib/ivms/site-radius.ts SITE_RADIUS_MIN_M / SITE_RADIUS_MAX_M):
-- never smaller than the default stop radius, never past the 500 m the detector treats as the site.
ALTER TABLE "Customer" ADD CONSTRAINT "Customer_siteRadiusM_range" CHECK ("siteRadiusM" IS NULL OR ("siteRadiusM" >= 100 AND "siteRadiusM" <= 500));

-- Time away is NULL (none) or a positive number of minutes (the rebuild never stores 0).
ALTER TABLE "StopVisit" ADD CONSTRAINT "StopVisit_awayMinutes_range" CHECK ("awayMinutes" IS NULL OR "awayMinutes" > 0);
