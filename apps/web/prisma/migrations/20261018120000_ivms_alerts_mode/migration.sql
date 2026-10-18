-- GPS alerts (owner request 18 Oct 2026: "build GPS alerts"; the owner believed TIMES already fed the
-- alerts). A fourth GPS tracking mode, ivmsMode 'ALERTS': everything TIMES does (live map, history pulls,
-- GPS arrival and departure times), and the operations alerts read those GPS times, the trail-confirmed
-- depot moves and, where it is fresh, the live position (lib/alerts/gps.ts; docs/PROJECT_HANDBOOK.md 3.21).
--
-- The only change: the CHECK "TenantConfig_ivmsMode_check" (migration 20261016200000_ivms_live) is replaced
-- by one that also allows 'ALERTS'. No column, default or row changes: every company keeps its mode (OFF by
-- default), so deploying changes nothing until a company admin picks ALERTS on Settings. Anything else
-- ('alerts', '', 'GPS', ...) is still refused, as before.
-- Code from before this release reads 'ALERTS' as OFF (lib/ivms/settings.ts ivmsModeOf: an unknown mode is
-- OFF), so an app rollback while a company is in ALERTS fails closed: GPS tracking stops for it (no call,
-- no write, its live positions purged) until the mode is set back to TIMES or lower. Set the mode to TIMES
-- (or lower) before rolling back to keep GPS times going.
--
-- The lock (as in 20261016200000_ivms_live): dropping and adding a CHECK needs a short ACCESS EXCLUSIVE lock
-- on "TenantConfig", which nearly every request reads (settings, the plan screen, the driver page, the
-- sweeps). Railway runs this while the old version still serves, and a lock request that queues behind a
-- long transaction blocks every later read of the table. So the lock is taken first, in two steps:
--  1. tried without waiting (NOWAIT, which never makes the app wait) for 6 minutes: longer than any
--     transaction of the app (the longest, Start fresh, may run 5 minutes), so a busy app delays the deploy
--     but never makes it fail and never waits for it;
--  2. then waited for at most 5 s per try, 6 tries. Still not granted - something outside the app holds
--     "TenantConfig" (for example an open transaction of a SQL client): the migration stops with "settings
--     table busy", nothing is changed, and the old version keeps serving (P3018; the next deploy answers
--     P3009 until `prisma migrate resolve --rolled-back 20261018120000_ivms_alerts_mode`, then redeploy:
--     docs/PROJECT_HANDBOOK.md 5.11). Find and end that transaction first (pg_stat_activity).
-- Prisma runs this file as one transaction, so the lock is held until the new CHECK is in place and is
-- released at the end (milliseconds: one row per company is checked; a failure leaves the old CHECK).
--
-- Rollback (in this order; the first line moves a company in ALERTS back to TIMES, which the old CHECK allows):
--   UPDATE "TenantConfig" SET "ivmsMode" = 'TIMES' WHERE "ivmsMode" = 'ALERTS';
--   ALTER TABLE "TenantConfig" DROP CONSTRAINT "TenantConfig_ivmsMode_check";
--   ALTER TABLE "TenantConfig" ADD CONSTRAINT "TenantConfig_ivmsMode_check" CHECK ("ivmsMode" IN ('OFF', 'MAP', 'TIMES'));
--   DELETE FROM "_prisma_migrations" WHERE migration_name = '20261018120000_ivms_alerts_mode';

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
        LOCK TABLE "TenantConfig" IN ACCESS EXCLUSIVE MODE NOWAIT;
      ELSE
        PERFORM set_config('lock_timeout', '5s', true);
        LOCK TABLE "TenantConfig" IN ACCESS EXCLUSIVE MODE;
      END IF;
      EXIT;
    EXCEPTION WHEN lock_not_available OR deadlock_detected THEN
      IF waiting THEN
        waits := waits + 1;
        IF waits >= 6 THEN
          RAISE EXCEPTION 'settings table busy: could not lock "TenantConfig" to allow the GPS alerts mode in about 6.5 minutes (another transaction holds it); nothing was changed, end that transaction and deploy again';
        END IF;
      END IF;
    END;
    PERFORM pg_sleep(0.05 + random() * 0.1);
  END LOOP;
  PERFORM set_config('lock_timeout', '0', true);
END $$;

-- The mode list: lib/ivms/types.ts IVMS_MODES, value for value (tests/lib/ivms-contract.spec.ts compares).
ALTER TABLE "TenantConfig" DROP CONSTRAINT "TenantConfig_ivmsMode_check";
ALTER TABLE "TenantConfig" ADD CONSTRAINT "TenantConfig_ivmsMode_check" CHECK ("ivmsMode" IN ('OFF', 'MAP', 'TIMES', 'ALERTS'));
