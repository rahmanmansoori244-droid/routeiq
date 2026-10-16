/**
 * Operations alerts (owner request 16 Oct 2026): the sweep. Run by the in-process janitor (every 60 s; at
 * most every ALERT_SWEEP_EVERY_MS, 2 min) and by the cron route (`force`), for every active company that
 * switched alerts on (TenantConfig.alertsEnabled; OFF by default: merging changes nothing). Per company,
 * in its own transaction under the company's alert lock (locks.ts; skipped while another process holds
 * it): read the facts (facts.ts), evaluate the rules (rules.ts), apply the result (store.ts). Then the
 * e-mail digest, when a notifier is passed (notify.ts, in its own transaction and lock).
 *
 * Nothing in the driver, office or load-status paths calls it: their requests never wait for alerts.
 * One company's failure is logged (counts and the error message only, never a name or a text) and the
 * others still run. A sweep still running when the next tick comes is not started twice in one process;
 * across the two processes of a deploy overlap the lock and the guarded writes keep one row per subject.
 * `ROUTEIQ_DISABLE_ALERTS=1` turns it off.
 */
import type { TenantConfig } from '@prisma/client';
import { prisma } from '../db';
import { DEFAULT_TZ } from '../dispatch/time';
import { setLockTimeout } from '../dispatch/plan-locks';
import { ALERT_SWEEP_EVERY_MS, ALERT_SWEEP_SLOW_MS, ALERT_THRESHOLD_COLUMNS, rulesOn, thresholdsOf, type AlertConfig, type ResolvedReason } from './catalog';
import { readAlertFacts } from './facts';
import { tryLockTenantAlerts } from './locks';
import { evaluate } from './rules';
import { applyPlan, planApply, type StoreCounts } from './store';

/** The e-mail step after a company's sweep (notify.ts sendAlertDigest). Its failure never stops the sweep. */
export type AlertNotifier = (tenantId: string, now: Date) => Promise<unknown>;

export interface AlertSweepReport {
  /** Companies with alerts on. */
  tenants: number;
  /** Skipped: another process held the company's alert lock. */
  busy: number;
  failed: number;
  raised: number;
  history: number;
  escalated: number;
  updated: number;
  reopened: number;
  resolved: number;
  backlog: number;
  ms: number;
}

/** The company settings a sweep reads. */
export type AlertTenantConfig = Pick<TenantConfig, 'tenantId' | 'timezone'> & AlertConfig;

const CONFIG_SELECT = {
  tenantId: true,
  timezone: true,
  alertsEnabled: true,
  alertsEnabledAt: true,
  alertDeliveredNote: true,
  ...Object.fromEntries(ALERT_THRESHOLD_COLUMNS.map((c) => [c, true])),
} as Record<string, true>;

const g = globalThis as unknown as { __routeiqAlertSweepAt?: number; __routeiqAlertSweepRunning?: boolean };

/** Back to "never ran" (tests). */
export function resetAlertSweepClock(): void {
  g.__routeiqAlertSweepAt = undefined;
  g.__routeiqAlertSweepRunning = false;
}

/**
 * One company: facts, rules and the store in one transaction under its alert lock. Returns null when the
 * lock was busy (another process is sweeping it).
 */
export async function sweepTenant(cfg: AlertTenantConfig, now: Date, db: typeof prisma = prisma): Promise<StoreCounts | null> {
  const tz = cfg.timezone || DEFAULT_TZ;
  const thresholds = thresholdsOf(cfg);
  const on = rulesOn(cfg);
  return db.$transaction(
    async (tx) => {
      await setLockTimeout(tx);
      if (!(await tryLockTenantAlerts(tx, cfg.tenantId))) return null;
      const { facts, rows } = await readAlertFacts(tx, cfg.tenantId, { tz, now, thresholds });
      const ev = evaluate(facts, now, thresholds);
      const plan = planApply(rows, ev, { now, alertsEnabledAt: cfg.alertsEnabledAt ?? null, windowFrom: facts.dates[0]!, rulesOn: on });
      return applyPlan(tx, cfg.tenantId, plan, now);
    },
    { timeout: 60_000, maxWait: 10_000 },
  );
}

const total = (r: Partial<Record<ResolvedReason, number>>) => Object.values(r).reduce((a, n) => a + (n ?? 0), 0);

/**
 * Every company with alerts on. `force` (the cron route) skips the 2-minute throttle, never the guard
 * against a sweep still running. Null when it did not run (turned off, throttled or already running).
 */
export async function runAlertSweep(now: Date = new Date(), opts: { force?: boolean; notify?: AlertNotifier; db?: typeof prisma } = {}): Promise<AlertSweepReport | null> {
  if (process.env.ROUTEIQ_DISABLE_ALERTS === '1') return null;
  if (g.__routeiqAlertSweepRunning) return null;
  if (!opts.force && g.__routeiqAlertSweepAt && now.getTime() - g.__routeiqAlertSweepAt < ALERT_SWEEP_EVERY_MS) return null;
  g.__routeiqAlertSweepAt = now.getTime();
  g.__routeiqAlertSweepRunning = true;
  const started = Date.now();
  const db = opts.db ?? prisma;
  const report: AlertSweepReport = { tenants: 0, busy: 0, failed: 0, raised: 0, history: 0, escalated: 0, updated: 0, reopened: 0, resolved: 0, backlog: 0, ms: 0 };
  try {
    const tenants = (await db.tenantConfig.findMany({ where: { alertsEnabled: true, tenant: { active: true } }, select: CONFIG_SELECT })) as unknown as AlertTenantConfig[];
    report.tenants = tenants.length;
    for (const cfg of tenants) {
      const t0 = Date.now();
      try {
        const r = await sweepTenant(cfg, now, db);
        if (!r) report.busy++;
        else {
          report.raised += r.raised;
          report.history += r.history;
          report.escalated += r.escalated;
          report.updated += r.updated;
          report.reopened += r.reopened;
          report.resolved += total(r.resolved);
          report.backlog += r.backlog;
          if (r.raised || r.escalated || r.reopened || total(r.resolved) || r.history) {
            // Counts only: never a customer, a driver note or an address in the logs.
            console.warn('alerts: sweep', { tenantId: cfg.tenantId, raised: r.raised, escalated: r.escalated, reopened: r.reopened, resolved: r.resolved, history: r.history, backlog: r.backlog, ms: Date.now() - t0 });
          }
        }
      } catch (err) {
        report.failed++;
        console.error('alerts: sweep failed', { tenantId: cfg.tenantId, error: (err as Error)?.message ?? String(err) });
      }
      if (opts.notify) {
        try {
          await opts.notify(cfg.tenantId, now);
        } catch (err) {
          console.error('alerts: e-mail step failed', { tenantId: cfg.tenantId, error: (err as Error)?.message ?? String(err) });
        }
      }
    }
  } finally {
    g.__routeiqAlertSweepRunning = false;
  }
  report.ms = Date.now() - started;
  if (report.ms > ALERT_SWEEP_SLOW_MS) console.warn('alerts: sweep slow', { tenants: report.tenants, ms: report.ms });
  return report;
}
