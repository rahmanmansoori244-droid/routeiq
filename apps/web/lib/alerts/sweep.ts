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
 * others still run; a rule that throws on a load holds its rows of that load and the other rules still
 * answer (rules.ts). A sweep still running when the next tick comes is not started twice in one process;
 * across the two processes of a deploy overlap the lock and the guarded writes keep one row per subject.
 * `ROUTEIQ_DISABLE_ALERTS=1` turns it off.
 *
 * "Checked" (review of 16 Oct 2026, M2: nobody could tell when the sweep stopped): each company's last
 * good sweep and last failure are kept in this process (one web replica; a restart starts empty and the
 * next tick fills it). The bell, the Alerts page and /api/health read them: a company with alerts on and
 * no good sweep for ALERT_SWEEP_STALE_MS shows a warning.
 *
 * A company switched on without the switch-on time (a support UPDATE of "alertsEnabled" alone) gets it
 * now, on its first sweep: nothing that began before raises an alert (review L1).
 *
 * GPS alerts (owner request 18 Oct 2026): a company whose GPS tracking is ALERTS (and the IVMS link not
 * switched off by ROUTEIQ_DISABLE_IVMS=1) has its facts read with the GPS (gps.ts gpsAlertConfigOf,
 * facts.ts); every other company exactly as before.
 */
import type { TenantConfig } from '@prisma/client';
import { prisma } from '../db';
import { DEFAULT_TZ, zonedDayStart } from '../dispatch/time';
import { setLockTimeout } from '../dispatch/plan-locks';
import { ALERT_SWEEP_EVERY_MS, ALERT_SWEEP_SLOW_MS, ALERT_SWEEP_STALE_MS, ALERT_THRESHOLD_COLUMNS, readRuleOnAt, rulesOn, thresholdsOf, type AlertConfig, type ResolvedReason } from './catalog';
import { readAlertFacts } from './facts';
import { gpsAlertConfigOf } from './gps';
import { readIvmsEnv } from '../ivms/env';
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
  /** Rules that threw on a load (their rows of that load were held). */
  ruleFailures: number;
  raised: number;
  history: number;
  escalated: number;
  updated: number;
  reopened: number;
  resolved: number;
  backlog: number;
  ms: number;
}

/** The company settings a sweep reads (the GPS ones only matter in GPS tracking ALERTS; absent: no GPS). */
export type AlertTenantConfig = Pick<TenantConfig, 'tenantId' | 'timezone'> &
  AlertConfig & { alertRuleOnAtJson?: unknown } & Partial<Pick<TenantConfig, 'ivmsMode' | 'ivmsStopRadiusM' | 'ivmsDepotRadiusM' | 'avgSpeedKmh' | 'distanceMultiplier'>>;

const CONFIG_SELECT = {
  tenantId: true,
  timezone: true,
  alertsEnabled: true,
  alertsEnabledAt: true,
  alertRuleOnAtJson: true,
  alertDeliveredNote: true,
  ...Object.fromEntries(ALERT_THRESHOLD_COLUMNS.map((c) => [c, true])),
  // GPS alerts (GPS tracking ALERTS only: gps.ts gpsAlertConfigOf).
  ivmsMode: true,
  ivmsStopRadiusM: true,
  ivmsDepotRadiusM: true,
  avgSpeedKmh: true,
  distanceMultiplier: true,
} as Record<string, true>;

interface TenantHealth {
  okAt: number | null;
  failedAt: number | null;
}

const g = globalThis as unknown as {
  __routeiqAlertSweepAt?: number;
  __routeiqAlertSweepRunning?: boolean;
  __routeiqAlertHealth?: Map<string, TenantHealth>;
  __routeiqAlertLastRunAt?: number;
  __routeiqAlertSince?: number;
};

const healthOf = () => (g.__routeiqAlertHealth ??= new Map());
/** When this process started following the sweep (a company with no good sweep since is stale only after ALERT_SWEEP_STALE_MS). */
g.__routeiqAlertSince ??= Date.now();

function noteHealth(tenantId: string, ok: boolean, at: number): void {
  const h = healthOf().get(tenantId) ?? { okAt: null, failedAt: null };
  if (ok) h.okAt = at;
  else h.failedAt = at;
  healthOf().set(tenantId, h);
}

/** Back to "never ran" (tests). */
export function resetAlertSweepClock(): void {
  g.__routeiqAlertSweepAt = undefined;
  g.__routeiqAlertSweepRunning = false;
  g.__routeiqAlertHealth = new Map();
  g.__routeiqAlertLastRunAt = undefined;
  g.__routeiqAlertSince = Date.now();
}

/**
 * One company's "Checked" line: its last good sweep in this process (null: none since the process
 * started), whether the last attempt failed, and whether it is stale: no good sweep for
 * ALERT_SWEEP_STALE_MS, counted from the last good one, else from the later of the process start and
 * the company's switch-on (`enabledAt`), so a fresh switch-on or a deploy does not warn at once.
 */
export function alertSweepStatus(tenantId: string, now: Date = new Date(), enabledAt: Date | null = null): { checkedAt: string | null; failed: boolean; stale: boolean } {
  const h = healthOf().get(tenantId);
  const okAt = h?.okAt ?? null;
  const failed = !!h?.failedAt && (!okAt || h.failedAt > okAt);
  const since = okAt ?? Math.max(g.__routeiqAlertSince ?? 0, enabledAt?.getTime() ?? 0);
  return { checkedAt: okAt ? new Date(okAt).toISOString() : null, failed, stale: now.getTime() - since > ALERT_SWEEP_STALE_MS };
}

/** For /api/health (counts only, never a company): when the sweep last ran, and how many companies' last attempt failed or went stale. */
export function alertSweepHealth(now: Date = new Date()): { lastRunAt: string | null; companies: number; failing: number; stale: number } {
  let failing = 0;
  let stale = 0;
  for (const tenantId of healthOf().keys()) {
    const st = alertSweepStatus(tenantId, now);
    if (st.failed) failing++;
    if (st.stale) stale++;
  }
  const last = g.__routeiqAlertLastRunAt;
  return { lastRunAt: last ? new Date(last).toISOString() : null, companies: healthOf().size, failing, stale };
}

/**
 * One company: facts, rules and the store in one transaction under its alert lock. Returns null when the
 * lock was busy (another process is sweeping it).
 */
export async function sweepTenant(cfg: AlertTenantConfig, now: Date, db: typeof prisma = prisma): Promise<(StoreCounts & { ruleFailures: number }) | null> {
  const tz = cfg.timezone || DEFAULT_TZ;
  const thresholds = thresholdsOf(cfg);
  const on = rulesOn(cfg);
  return db.$transaction(
    async (tx) => {
      await setLockTimeout(tx);
      if (!(await tryLockTenantAlerts(tx, cfg.tenantId))) return null;
      // Alerts on without the switch-on time (set by a support UPDATE, not the Settings save): now (review L1).
      let enabledAt = cfg.alertsEnabledAt ?? null;
      if (!enabledAt) {
        await tx.tenantConfig.updateMany({ where: { tenantId: cfg.tenantId, alertsEnabledAt: null }, data: { alertsEnabledAt: now } });
        enabledAt = now;
      }
      const gps = gpsAlertConfigOf(cfg, readIvmsEnv().disabled);
      const { facts, rows } = await readAlertFacts(tx, cfg.tenantId, { tz, now, thresholds, gps });
      const ev = evaluate(facts, now, thresholds);
      if (ev.failures?.length) {
        // The rule and the error's message only (never a customer, a note or a text of the facts).
        console.error('alerts: rule failed', { tenantId: cfg.tenantId, failures: ev.failures.slice(0, 5), count: ev.failures.length });
      }
      // today / todayStart: the company's; the day before's open rows close as DAY_ENDED, except the day's
      // follow-up raised after its midnight (owner request 19 Oct 2026; review of the branch, finding 2).
      const plan = planApply(rows, ev, {
        now,
        alertsEnabledAt: enabledAt,
        ruleOnAt: readRuleOnAt(cfg.alertRuleOnAtJson),
        windowFrom: facts.dates[0]!,
        today: facts.today,
        todayStart: zonedDayStart(facts.today, tz),
        rulesOn: on,
      });
      return { ...(await applyPlan(tx, cfg.tenantId, plan, now)), ruleFailures: ev.failures?.length ?? 0 };
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
  const report: AlertSweepReport = { tenants: 0, busy: 0, failed: 0, ruleFailures: 0, raised: 0, history: 0, escalated: 0, updated: 0, reopened: 0, resolved: 0, backlog: 0, ms: 0 };
  g.__routeiqAlertLastRunAt = now.getTime();
  try {
    const tenants = (await db.tenantConfig.findMany({ where: { alertsEnabled: true, tenant: { active: true } }, select: CONFIG_SELECT })) as unknown as AlertTenantConfig[];
    report.tenants = tenants.length;
    for (const cfg of tenants) {
      const t0 = Date.now();
      try {
        const r = await sweepTenant(cfg, now, db);
        if (!r) report.busy++;
        else {
          noteHealth(cfg.tenantId, r.ruleFailures === 0, now.getTime());
          report.ruleFailures += r.ruleFailures;
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
        noteHealth(cfg.tenantId, false, now.getTime());
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
