-- Receiving hours rule per company (owner request 13 Oct 2026: "14:00 IS the latest arrival"). For NMWC the
-- end of a customer's receiving hours is the LATEST ARRIVAL at the store, not the time unloading must be
-- finished. Until now the web always asked the optimizer for unloading FINISHED by closing (owner rule
-- 29 Sep 2026); the optimizer already supports both rules (config.window_rule "START" / "FINISH").
--
-- Additive only:
-- - TenantConfig.windowRule: TEXT NOT NULL DEFAULT 'FINISH', CHECKed to 'START' or 'FINISH'. On PostgreSQL
--   11+ a constant default changes the catalog only (no table rewrite, no long lock); every existing company
--   keeps 'FINISH', so its plans are made exactly as before until a company admin changes the setting.
-- Plans already made keep the rule the optimizer echoed for them (PlanRules.windowRule in the load
-- snapshots); nothing stored is rewritten. Code from before this release never reads the column, so an app
-- rollback is safe at any time.
-- Rollback: ALTER TABLE "TenantConfig" DROP CONSTRAINT "TenantConfig_windowRule_check";
--           ALTER TABLE "TenantConfig" DROP COLUMN "windowRule";

-- AlterTable
ALTER TABLE "TenantConfig" ADD COLUMN     "windowRule" TEXT NOT NULL DEFAULT 'FINISH';
ALTER TABLE "TenantConfig" ADD CONSTRAINT "TenantConfig_windowRule_check" CHECK ("windowRule" IN ('START', 'FINISH'));
