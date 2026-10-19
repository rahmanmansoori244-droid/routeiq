/**
 * Operations alerts (owner request 16 Oct 2026): the sweep (lib/alerts/sweep.ts) with its facts and lock
 * stubbed: only companies that switched alerts on, each in its own transaction under its alert lock (a
 * busy lock skips the company: M4), one company's failure never stops the others, the e-mail step after
 * each, the 2-minute throttle (the cron route forces it), no second sweep while one runs, the kill switch
 * ROUTEIQ_DISABLE_ALERTS=1, no backlog before the switch-on time (also when it was never stamped: review
 * L1), per rule too (review H2), and the "Checked" health each company's sweep leaves (review M2). And the
 * hooks: the janitor loop and the cron route run it. GPS alerts (owner request 18 Oct 2026): only a company
 * whose GPS tracking is ALERTS has its facts read with the GPS, never with ROUTEIQ_DISABLE_IVMS=1.
 * Synthetic data; invented names.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AlertFacts, FactLoad } from '@/lib/alerts/rules';

const state = vi.hoisted(() => ({
  facts: new Map<string, unknown>(),
  fail: new Set<string>(),
  busy: new Set<string>(),
  gate: null as null | Promise<void>,
}));
vi.mock('@/lib/db', () => ({ prisma: {} }));
vi.mock('@/lib/alerts/facts', () => ({
  readAlertFacts: vi.fn(async (_tx: unknown, tenantId: string) => {
    if (state.gate) await state.gate;
    if (state.fail.has(tenantId)) throw new Error('connection reset');
    return state.facts.get(tenantId);
  }),
}));
vi.mock('@/lib/alerts/locks', () => ({ tryLockTenantAlerts: vi.fn(async (_tx: unknown, tenantId: string) => !state.busy.has(tenantId)) }));

import { readAlertFacts } from '@/lib/alerts/facts';
import { alertSweepHealth, alertSweepStatus, resetAlertSweepClock, runAlertSweep } from '@/lib/alerts/sweep';
import { zonedDayStart } from '@/lib/dispatch/time';

const TZ = 'Asia/Muscat';
const D = '2026-10-20';
const at = (min: number) => new Date(zonedDayStart(D, TZ).getTime() + min * 60_000);
const NOW = at(8 * 60 + 15);

/** T05 L1 Locked, planned departure 07:30: 45 min late at 08:15 (DEPART_LATE). */
function lateFacts(): { facts: AlertFacts; rows: [] } {
  const load: FactLoad = {
    id: 'l1', depotId: 'D1', date: D, truckId: 'TR1', truckCode: 'T05', loadNo: 1, status: 'LOCKED', departMin: 450, returnMin: 720,
    statusChangedAt: at(300), windowRule: 'FINISH', breakMin: null, backAt: null, leftTapAt: null, stopCount: 3, stops: [],
  };
  return { facts: { tz: TZ, today: D, dates: ['2026-10-19', D, '2026-10-21'], loads: [load], truckDays: [], open: new Map() }, rows: [] };
}

const cfg = (tenantId: string, over: Record<string, unknown> = {}) => ({
  tenantId, timezone: TZ, alertsEnabled: true, alertsEnabledAt: at(6 * 60), alertDeliveredNote: true,
  alertUnloadOverMin: 30, alertLoadingOverMin: null, alertEtaLateMin: 30, alertDepartLateMin: 30, alertSilentMin: 120, alertPageNotOpenedMin: 30,
  alertAfterClosingMin: 15, alertPriorityMax: 2, alertProofFarM: 500, alertNotClosedMin: 120, ...over,
});

function stubDb(configs: Record<string, unknown>[]) {
  const created: Record<string, any>[] = [];
  const queries: Record<string, any>[] = [];
  const stamped: Record<string, any>[] = [];
  const tx = {
    $executeRawUnsafe: async () => 0,
    tenantConfig: { updateMany: async (a: Record<string, any>) => (stamped.push(a), { count: 1 }) },
    opsAlert: {
      createMany: async (a: Record<string, any>) => (created.push(...a.data), { count: a.data.length }),
      updateMany: async () => ({ count: 1 }),
    },
  };
  const db = {
    tenantConfig: { findMany: async (a: Record<string, any>) => (queries.push(a), configs) },
    $transaction: async (fn: (t: unknown) => Promise<unknown>) => fn(tx),
  };
  return { db: db as never, created, queries, stamped };
}

beforeEach(() => {
  resetAlertSweepClock();
  state.facts.clear();
  state.fail.clear();
  state.busy.clear();
  state.gate = null;
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.ROUTEIQ_DISABLE_ALERTS;
  delete process.env.ROUTEIQ_DISABLE_IVMS;
});

describe('runAlertSweep', () => {
  it('only companies with alerts on and active; raises, then the e-mail step; one company failing does not stop the others', async () => {
    state.facts.set('tA', lateFacts());
    state.fail.add('tB');
    const { db, created, queries } = stubDb([cfg('tA'), cfg('tB')]);
    const notified: string[] = [];
    const r = await runAlertSweep(NOW, { db, notify: async (t) => void notified.push(t) });
    expect(queries[0]!.where).toEqual({ alertsEnabled: true, tenant: { active: true } });
    expect(r).toMatchObject({ tenants: 2, failed: 1, busy: 0, raised: 1, backlog: 0 });
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({ tenantId: 'tA', rule: 'DEPART_LATE', tier: 1, severity: 'WARN', text: expect.stringMatching(/^T05 L1 not dispatched/) });
    expect(notified).toEqual(['tA', 'tB']);
    // The failure is logged with counts and the message only.
    expect(console.error).toHaveBeenCalledWith('alerts: sweep failed', { tenantId: 'tB', error: 'connection reset' });
  });

  it('M4: a company whose alert lock another process holds is skipped (nothing written)', async () => {
    state.facts.set('tA', lateFacts());
    state.busy.add('tA');
    const { db, created } = stubDb([cfg('tA')]);
    expect(await runAlertSweep(NOW, { db })).toMatchObject({ busy: 1, raised: 0 });
    expect(created).toEqual([]);
  });

  it('no backlog: switched on after the condition began, nothing is raised', async () => {
    state.facts.set('tA', lateFacts());
    const { db, created } = stubDb([cfg('tA', { alertsEnabledAt: at(8 * 60 + 10) })]);
    expect(await runAlertSweep(NOW, { db })).toMatchObject({ raised: 0, backlog: 1 });
    expect(created).toEqual([]);
  });

  it('review L1: alerts on without a switch-on time (a support UPDATE) get it now: nothing that began before raises', async () => {
    state.facts.set('tA', lateFacts());
    const { db, created, stamped } = stubDb([cfg('tA', { alertsEnabledAt: null })]);
    expect(await runAlertSweep(NOW, { db })).toMatchObject({ raised: 0, backlog: 1 });
    expect(created).toEqual([]);
    expect(stamped).toEqual([{ where: { tenantId: 'tA', alertsEnabledAt: null }, data: { alertsEnabledAt: NOW } }]);
  });

  it('review H2: a rule switched on after the master switch raises nothing that began before its own switch-on', async () => {
    state.facts.set('tA', lateFacts());
    const { db, created } = stubDb([cfg('tA', { alertRuleOnAtJson: { DEPART_LATE: at(8 * 60 + 10).toISOString() } })]);
    expect(await runAlertSweep(NOW, { db })).toMatchObject({ raised: 0, backlog: 1 });
    expect(created).toEqual([]);
  });

  it('review M2: each company\'s last good sweep is kept ("Checked"); a failure or 10 min without one says so; /api/health gets counts only', async () => {
    state.facts.set('tA', lateFacts());
    state.fail.add('tB');
    const { db } = stubDb([cfg('tA'), cfg('tB')]);
    await runAlertSweep(NOW, { db });
    expect(alertSweepStatus('tA', NOW)).toEqual({ checkedAt: NOW.toISOString(), failed: false, stale: false });
    expect(alertSweepStatus('tB', NOW)).toMatchObject({ checkedAt: null, failed: true });
    expect(alertSweepStatus('tA', new Date(NOW.getTime() + 10 * 60_000 + 1))).toMatchObject({ stale: true });
    // A company never swept yet: stale only 10 min after its switch-on (or this process's start).
    const later = new Date(Date.now() + 5 * 60_000);
    expect(alertSweepStatus('tC', later, later).stale).toBe(false);
    expect(alertSweepStatus('tC', new Date(Date.now() + 11 * 60_000), null).stale).toBe(true);
    const h = alertSweepHealth(NOW);
    // tB never had a good sweep and this process started more than 10 min before NOW: failing and overdue.
    expect(h).toEqual({ lastRunAt: NOW.toISOString(), companies: 2, failing: 1, stale: 1 });
    expect(JSON.stringify(h)).not.toMatch(/tA|tB/);
  });

  it('at most every 2 min (the cron route forces it); never twice at once; off with ROUTEIQ_DISABLE_ALERTS=1', async () => {
    state.facts.set('tA', lateFacts());
    const { db } = stubDb([cfg('tA')]);
    expect(await runAlertSweep(NOW, { db })).not.toBeNull();
    expect(await runAlertSweep(new Date(NOW.getTime() + 60_000), { db })).toBeNull();
    expect(await runAlertSweep(new Date(NOW.getTime() + 60_000), { db, force: true })).not.toBeNull();
    expect(await runAlertSweep(new Date(NOW.getTime() + 5 * 60_000), { db })).not.toBeNull();

    let open!: () => void;
    state.gate = new Promise<void>((r) => (open = r));
    const first = runAlertSweep(new Date(NOW.getTime() + 10 * 60_000), { db, force: true });
    await new Promise((r) => setTimeout(r, 5));
    expect(await runAlertSweep(new Date(NOW.getTime() + 10 * 60_000), { db, force: true })).toBeNull();
    open();
    expect(await first).not.toBeNull();

    process.env.ROUTEIQ_DISABLE_ALERTS = '1';
    expect(await runAlertSweep(new Date(NOW.getTime() + 20 * 60_000), { db, force: true })).toBeNull();
  });
});

describe('GPS alerts (owner request 18 Oct 2026): only GPS tracking ALERTS gives the facts their GPS', () => {
  it('OFF, MAP and TIMES read no GPS; ALERTS reads it with the company settings; ROUTEIQ_DISABLE_IVMS=1 turns it off', async () => {
    const companies = { tOff: { ivmsMode: 'OFF' }, tMap: { ivmsMode: 'MAP' }, tTimes: { ivmsMode: 'TIMES' }, tAlerts: { ivmsMode: 'ALERTS', ivmsStopRadiusM: 100, ivmsDepotRadiusM: 300, avgSpeedKmh: 40, distanceMultiplier: 1.3 } };
    for (const t of Object.keys(companies)) state.facts.set(t, lateFacts());
    const { db, queries } = stubDb(Object.entries(companies).map(([t, c]) => cfg(t, c)));
    const calls = vi.mocked(readAlertFacts).mock.calls;
    const gpsOf = (from: number) => Object.fromEntries(calls.slice(from).map((c) => [c[1], (c[2] as { gps?: unknown }).gps]));
    let from = calls.length;
    await runAlertSweep(NOW, { db, force: true });
    expect(queries[0]!.select).toMatchObject({ ivmsMode: true, ivmsStopRadiusM: true, ivmsDepotRadiusM: true, avgSpeedKmh: true, distanceMultiplier: true });
    expect(gpsOf(from)).toEqual({ tOff: null, tMap: null, tTimes: null, tAlerts: { atStopRadiusM: 250, atDepotRadiusM: 450, avgSpeedKmh: 40, distanceMultiplier: 1.3 } });
    process.env.ROUTEIQ_DISABLE_IVMS = '1';
    from = calls.length;
    await runAlertSweep(new Date(NOW.getTime() + 5 * 60_000), { db, force: true });
    expect(gpsOf(from)).toEqual({ tOff: null, tMap: null, tTimes: null, tAlerts: null });
  });
});

describe('the hooks', () => {
  const read = (rel: string) => readFileSync(path.resolve(__dirname, '../..', rel), 'utf8');
  it('the janitor loop runs the sweep in its own try, skipped by ROUTEIQ_DISABLE_ALERTS=1; the cron route forces it, in its own try too, and answers `alerts`', () => {
    const loop = read('lib/jobs/janitor-loop.ts');
    expect(loop).toMatch(/if \(process\.env\.ROUTEIQ_DISABLE_ALERTS !== '1'\) \{\s+try \{\s+await runAlertSweep\(new Date\(\), \{ notify: sendAlertDigest \}\);/);
    expect(loop).toContain("import { sendAlertDigest } from '../alerts/notify';");
    const cron = read('app/api/cron/janitor/route.ts');
    // Merge with the IVMS live link (16 Oct 2026): the sweep is the route's last step, in its own try (the
    // route's `step`: a database error answers `alerts: { error }`, never a 500; tests/lib/ivms-off.spec.ts).
    expect(cron).toContain("const alerts = await step('alerts', () => runAlertSweep(new Date(), { force: true, notify: sendAlertDigest }));");
    expect(cron).toContain("import { sendAlertDigest } from '@/lib/alerts/notify';");
    // The analysis dataset (19 Oct 2026) runs after the sweep, its own step, in the answer only when it did something.
    expect(cron).toContain('return { jobs, shifts, returnedLoads, deliveryRetention, hire, alerts, ...(ivms ? { ivms } : {}), ...(analysis ? { analysis } : {}) };');
  });

  it('nothing in the driver, office or load-status paths calls the alerts engine', () => {
    for (const f of ['lib/delivery/event-service.ts', 'lib/delivery/office-service.ts', 'lib/delivery/photo-service.ts', 'app/api/d/actions/route.ts', 'lib/dispatch/plan-service.ts']) {
      expect(read(f), f).not.toMatch(/from ['"](\.\.\/|@\/lib\/)alerts\//);
    }
  });
});
