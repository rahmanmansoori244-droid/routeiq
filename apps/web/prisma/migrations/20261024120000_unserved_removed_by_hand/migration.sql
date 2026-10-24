-- Moves by hand (PR M2/M3, owner decision 24 Oct 2026: "take a stop out of the plan" is in the first version).
-- A stop the dispatcher takes off a PLANNED load (Move -> Take off the plan) is kept on the option's unserved list
-- with its own reason, so the plan, the workbook and the hire suggestion never read it as a capacity problem
-- (lib/dispatch/hire.ts CAPACITY_REASONS does not list it), and "Put on a truck" can put it back.
--
-- Additive only: one enum value. ADD VALUE is not used in this migration's own statements (PostgreSQL 12+ allows
-- it inside the migration's transaction then), as in 20261013120000_small_truck_only.
-- Code from before this release never writes the value. An app rollback is safe only while no UnservedOrder row
-- has reasonCode REMOVED_BY_HAND: the previous release's Prisma client does not know the value and fails reading
-- such a row (the plan screen and the day overview read them). Before rolling the app back:
--   UPDATE "UnservedOrder" SET "reasonCode" = 'UNKNOWN' WHERE "reasonCode" = 'REMOVED_BY_HAND';
-- (the reason message keeps the words "Taken off the plan by hand ...").
-- Rollback: nothing else to undo (an enum value cannot be dropped; unused after the UPDATE above, it is harmless).

-- AlterEnum
ALTER TYPE "UnservedReasonCode" ADD VALUE 'REMOVED_BY_HAND';
