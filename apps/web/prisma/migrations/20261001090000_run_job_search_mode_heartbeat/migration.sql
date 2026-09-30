-- Long searches (owner request 29 Sep 2026: "make sure the solver is giving an optimal solution even
-- if it runs for 20 mins"; decision "night plans long, day re-plans quick"). Additive and nullable:
-- no rewrite, no backfill, the previous release ignores both columns.
--
--   "searchMode"  QUICK or THOROUGH: how long the job's optimization may search. NULL on jobs from
--                 before search modes (they searched QUICK).
--   "heartbeatAt" the last sign of life of the web process running the job, written every 30 s while
--                 it waits for a solver slot or for the optimizer. The stuck-plan check (lost after 2
--                 min without one) and the janitor (fails the job 5 min after it) read it, so a job
--                 searching for 20 minutes is never taken for a lost one, and a lost one is found fast.
ALTER TABLE "RunJob" ADD COLUMN "searchMode" TEXT;
ALTER TABLE "RunJob" ADD COLUMN "heartbeatAt" TIMESTAMPTZ(3);
