-- Cause & action of an operations alert (owner request 20 Oct 2026: "add in the alerts a place where a note /
-- reason for the alert to have happened and the solution ... entered by someone after checking and finding a
-- solution ... will help us gather data for what decisions are made when alerts are made"). lib/alerts/review.ts
-- holds the pick-lists; PATCH /api/alerts writes the columns (PLANNER and up), never the sweep, the e-mail or
-- the acknowledgement.
--   "reviewCause", "reviewAction"            a code of the app's lists. The CHECK below holds the FORMAT only
--       (an upper-case word), like "rule" (checked in the app): a code added after reading the Other texts
--       needs no migration (critique of the design, 20 Oct 2026, item 9).
--   "reviewCauseOther", "reviewActionOther"  only with the code OTHER, 3-120 characters.
--   "reviewNote"                             optional, 1-500 characters (one line, digit runs removed).
--   "reviewFollowUp"                         needs follow-up (NOT NULL DEFAULT false: catalog only on PG 11+).
--   "reviewFirstAt", "reviewFirstById"       the first save; "reviewedAt", "reviewedById" the last one, which
--       the next save names (two editors: the second is refused with 409); SET NULL with the user.
--   "reviewSaves"                            how many saves (NOT NULL DEFAULT 0).
--   "reviewGroupId"                          the alert whose save also filled this one (one incident; no FK).
--   "reviewTier", "reviewOccurrences", "reviewCustomerId"  the alert as it was at the last save: the screens
--       and the export say when it came back, got worse or names another stop since.
--   "detailsRemovedAt"                       when the 90-day clean-up removed the alert's text, its facts (but
--       "by GPS") and the cause & action's free texts; the codes stay until the analysis data's retention.
-- A cause & action is whole or absent (CHECK OpsAlert_review_whole): every column NULL, follow-up false and
-- saves 0, or the codes, the times, the tier and occurrences set.
--
-- Additive only: sixteen columns, fourteen nullable and two NOT NULL with a constant default (no table rewrite), two foreign keys to
-- "User" and CHECKs (every existing row has no cause & action, so each check reads the table once: a few
-- thousand rows). No data change. Code from before this release never reads or writes the new columns (its
-- updates name their own columns only) and still deletes alert rows after 90 days: an app rollback is safe at
-- any time (rows it deletes lose their cause & action; the audit rows stay).
--
-- Rollback:
--   ALTER TABLE "OpsAlert" DROP CONSTRAINT "OpsAlert_reviewedById_fkey", DROP CONSTRAINT "OpsAlert_reviewFirstById_fkey",
--     DROP CONSTRAINT "OpsAlert_reviewCause_format", DROP CONSTRAINT "OpsAlert_reviewAction_format",
--     DROP CONSTRAINT "OpsAlert_review_whole", DROP CONSTRAINT "OpsAlert_review_other",
--     DROP CONSTRAINT "OpsAlert_review_lengths", DROP CONSTRAINT "OpsAlert_review_numbers",
--     DROP COLUMN "reviewCause", DROP COLUMN "reviewCauseOther", DROP COLUMN "reviewAction",
--     DROP COLUMN "reviewActionOther", DROP COLUMN "reviewNote", DROP COLUMN "reviewFollowUp",
--     DROP COLUMN "reviewFirstAt", DROP COLUMN "reviewFirstById", DROP COLUMN "reviewedAt", DROP COLUMN "reviewedById",
--     DROP COLUMN "reviewSaves", DROP COLUMN "reviewGroupId", DROP COLUMN "reviewTier", DROP COLUMN "reviewOccurrences",
--     DROP COLUMN "reviewCustomerId", DROP COLUMN "detailsRemovedAt";
--   DELETE FROM "_prisma_migrations" WHERE migration_name = '20261020000000_alert_notes';

-- The lock, as in 20261016200000_ivms_live and 20261019120000_gps_site_radius_away: ADD COLUMN and the CHECKs
-- need a short ACCESS EXCLUSIVE lock on "OpsAlert" (the sweep every 2 min, the bell every 60 s, the e-mail
-- claim), and the foreign keys a SHARE ROW EXCLUSIVE lock on "User". Tried without waiting (NOWAIT) for 6
-- minutes (a sweep's transaction holds the alert rows for at most a minute), then waited for at most 5 s per
-- try, 6 tries; still busy: the migration stops with "tables busy" and nothing is changed (P3018;
-- `prisma migrate resolve --rolled-back 20261020000000_alert_notes`, then redeploy: PROJECT_HANDBOOK.md
-- 5.11). "User" first, then "OpsAlert", in both steps, so the step never holds one while waiting for the other
-- in another order.
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
        LOCK TABLE "User" IN SHARE ROW EXCLUSIVE MODE NOWAIT;
        LOCK TABLE "OpsAlert" IN ACCESS EXCLUSIVE MODE NOWAIT;
      ELSE
        PERFORM set_config('lock_timeout', '5s', true);
        LOCK TABLE "User" IN SHARE ROW EXCLUSIVE MODE;
        LOCK TABLE "OpsAlert" IN ACCESS EXCLUSIVE MODE;
      END IF;
      EXIT;
    EXCEPTION WHEN lock_not_available OR deadlock_detected THEN
      IF waiting THEN
        waits := waits + 1;
        IF waits >= 6 THEN
          RAISE EXCEPTION 'tables busy: could not lock "User" and "OpsAlert" to add the alerts'' cause & action in about 6.5 minutes (another transaction holds them); nothing was changed, end that transaction and deploy again';
        END IF;
      END IF;
    END;
    PERFORM pg_sleep(0.05 + random() * 0.1);
  END LOOP;
  PERFORM set_config('lock_timeout', '0', true);
END $$;

-- AlterTable
ALTER TABLE "OpsAlert" ADD COLUMN     "reviewCause" TEXT,
ADD COLUMN     "reviewCauseOther" TEXT,
ADD COLUMN     "reviewAction" TEXT,
ADD COLUMN     "reviewActionOther" TEXT,
ADD COLUMN     "reviewNote" TEXT,
ADD COLUMN     "reviewFollowUp" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "reviewFirstAt" TIMESTAMPTZ(3),
ADD COLUMN     "reviewFirstById" TEXT,
ADD COLUMN     "reviewedAt" TIMESTAMPTZ(3),
ADD COLUMN     "reviewedById" TEXT,
ADD COLUMN     "reviewSaves" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "reviewGroupId" TEXT,
ADD COLUMN     "reviewTier" INTEGER,
ADD COLUMN     "reviewOccurrences" INTEGER,
ADD COLUMN     "reviewCustomerId" TEXT,
ADD COLUMN     "detailsRemovedAt" TIMESTAMPTZ(3);

-- AddForeignKey
ALTER TABLE "OpsAlert" ADD CONSTRAINT "OpsAlert_reviewFirstById_fkey" FOREIGN KEY ("reviewFirstById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OpsAlert" ADD CONSTRAINT "OpsAlert_reviewedById_fkey" FOREIGN KEY ("reviewedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- The codes' format (lib/alerts/review.ts ALERT_REVIEW_CODE_RE); the lists themselves are the app's.
ALTER TABLE "OpsAlert" ADD CONSTRAINT "OpsAlert_reviewCause_format" CHECK ("reviewCause" IS NULL OR "reviewCause" ~ '^[A-Z][A-Z_]{1,39}$');
ALTER TABLE "OpsAlert" ADD CONSTRAINT "OpsAlert_reviewAction_format" CHECK ("reviewAction" IS NULL OR "reviewAction" ~ '^[A-Z][A-Z_]{1,39}$');

-- Whole or absent. The users (SET NULL when one is deleted) are left out; a removed cause & action clears them.
ALTER TABLE "OpsAlert" ADD CONSTRAINT "OpsAlert_review_whole" CHECK (
  ("reviewedAt" IS NULL AND "reviewCause" IS NULL AND "reviewAction" IS NULL AND "reviewCauseOther" IS NULL
    AND "reviewActionOther" IS NULL AND "reviewNote" IS NULL AND "reviewFirstAt" IS NULL AND "reviewFollowUp" = false
    AND "reviewSaves" = 0 AND "reviewGroupId" IS NULL AND "reviewTier" IS NULL AND "reviewOccurrences" IS NULL
    AND "reviewCustomerId" IS NULL)
  OR ("reviewedAt" IS NOT NULL AND "reviewCause" IS NOT NULL AND "reviewAction" IS NOT NULL AND "reviewFirstAt" IS NOT NULL
    AND "reviewFirstAt" <= "reviewedAt" AND "reviewSaves" >= 1 AND "reviewTier" IS NOT NULL AND "reviewOccurrences" IS NOT NULL)
);

-- An Other text only with OTHER, and always with it - until the 90-day clean-up removed it (detailsRemovedAt).
ALTER TABLE "OpsAlert" ADD CONSTRAINT "OpsAlert_review_other" CHECK (
  ("reviewCauseOther" IS NULL OR "reviewCause" IS NOT DISTINCT FROM 'OTHER')
  AND ("reviewActionOther" IS NULL OR "reviewAction" IS NOT DISTINCT FROM 'OTHER')
  AND ("detailsRemovedAt" IS NOT NULL
    OR (("reviewCause" IS DISTINCT FROM 'OTHER' OR "reviewCauseOther" IS NOT NULL)
      AND ("reviewAction" IS DISTINCT FROM 'OTHER' OR "reviewActionOther" IS NOT NULL)))
);

-- Lengths in characters (lib/alerts/review.ts ALERT_REVIEW_OTHER_MIN / _MAX, ALERT_REVIEW_NOTE_MAX); NULL passes.
ALTER TABLE "OpsAlert" ADD CONSTRAINT "OpsAlert_review_lengths" CHECK (
  ("reviewCauseOther" IS NULL OR char_length("reviewCauseOther") BETWEEN 3 AND 120)
  AND ("reviewActionOther" IS NULL OR char_length("reviewActionOther") BETWEEN 3 AND 120)
  AND ("reviewNote" IS NULL OR char_length("reviewNote") BETWEEN 1 AND 500)
);

ALTER TABLE "OpsAlert" ADD CONSTRAINT "OpsAlert_review_numbers" CHECK (
  "reviewSaves" >= 0 AND ("reviewTier" IS NULL OR "reviewTier" BETWEEN 1 AND 3) AND ("reviewOccurrences" IS NULL OR "reviewOccurrences" >= 1)
);
