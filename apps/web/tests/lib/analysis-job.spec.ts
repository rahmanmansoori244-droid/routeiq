/**
 * The analysis dataset's nightly job (owner request 19 Oct 2026; lib/analysis/job.ts) and its retention
 * (lib/ivms/retention.ts purgeAnalysisFacts), on an in-memory stand-in for the fact tables
 * (analysis-fakes.ts factDb) with the day fed by the test (invented truck-days only):
 * - the schedule: the effective day turns at 03:00 company time; the day before is built, the 2nd to 4th days
 *   before are refreshed once a night, the 4th is frozen; a frozen row is never written again;
 * - idempotent: a second run the same night changes nothing; a run of another process (unique key) is skipped;
 * - bounded and safe: the time budget leaves the rest for the next run; one failing truck-day never stops the
 *   others; the 10-minute throttle, the kill switch;
 * - tenant-scoped: each company's rows carry its own id and another company's frozen rows are never touched;
 * - the retention deletes the facts older than analysisRetentionDays, frozen or not, per company.
 * The integration spec analysis-facts-db.spec.ts runs the same job on PostgreSQL with the real reader.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { _resetAnalysisJobState, analysisChanged, cycleStartOf, effectiveDay, freezesTonight, runAnalysisJob, truckDayAction, type DayReader } from '@/lib/analysis/job';
import { purgeAnalysisFacts } from '@/lib/ivms/retention';
import { addDaysIso } from '@/lib/dispatch/time';
import { atOn, dayOne, factDb } from './analysis-fakes';

const TZ = 'Asia/Muscat';
const CONFIG = {
  tenantId: 'tA', timezone: TZ, overtimeAfterMin: 540, serviceMinPerCase: 0.25, reloadMinutes: 30, loadingMinPerCase: 0.04, distanceMultiplier: 1.3,
  avgSpeedKmh: 40, roadTimeFactor: 1.25, ivmsStopRadiusM: 100, ivmsStopDwellMin: 3, ivmsDepotRadiusM: 300, analysisRetentionDays: 730,
};
/** The delivery date of the invented day, and 03:10 company time on the nights after it. */
const DAY = '2026-10-18';
const night = (n: number, hhmm = '03:10') => atOn(addDaysIso(DAY, n), hhmm);

/** A reader that gives the invented truck-day on DAY (and nothing on other dates), for the companies listed. */
function reader(perTenant: Record<string, ReturnType<typeof dayOne>['input'][]>): DayReader & { calls: string[] } {
  const calls: string[] = [];
  const read = (async (_db: unknown, tenantId: string, date: string) => {
    calls.push(`${tenantId}|${date}`);
    const out = new Map();
    if (date !== DAY) return out;
    for (const input of perTenant[tenantId] ?? []) out.set(input.truckId, { ...input, trailFrom: null });
    return out;
  }) as DayReader & { calls: string[] };
  read.calls = calls;
  return read;
}

beforeEach(() => _resetAnalysisJobState());
afterEach(() => {
  vi.unstubAllEnvs();
});

describe('the schedule (pure)', () => {
  it('the effective day turns at 03:00 company time; the night starts then', () => {
    expect(effectiveDay(atOn('2026-10-19', '02:59'), TZ)).toBe('2026-10-18');
    expect(effectiveDay(atOn('2026-10-19', '03:00'), TZ)).toBe('2026-10-19');
    expect(cycleStartOf('2026-10-19', TZ)).toEqual(atOn('2026-10-19', '03:00'));
  });

  it('built the day after, refreshed once a night until the 4th day, frozen then, never again', () => {
    const E = '2026-10-19';
    const cs = cycleStartOf(E, TZ);
    const before = new Date(cs.getTime() - 60_000);
    const after = new Date(cs.getTime() + 60_000);
    expect(truckDayAction('2026-10-18', E, null, cs)).toBe('BUILD');
    expect(truckDayAction('2026-10-18', E, { refreshedAt: after, frozenAt: null }, cs)).toBe('SKIP'); // built tonight
    expect(truckDayAction('2026-10-17', E, { refreshedAt: before, frozenAt: null }, cs)).toBe('REFRESH');
    expect(truckDayAction('2026-10-17', E, { refreshedAt: after, frozenAt: null }, cs)).toBe('SKIP'); // refreshed tonight
    expect(truckDayAction('2026-10-15', E, { refreshedAt: after, frozenAt: null }, cs)).toBe('REFRESH'); // the 4th day: refresh and freeze
    expect(truckDayAction('2026-10-15', E, { refreshedAt: before, frozenAt: before }, cs)).toBe('SKIP');
    expect(truckDayAction('2026-10-12', E, null, cs)).toBe('BUILD'); // a missed night, within the catch-up
    expect(truckDayAction(E, E, null, cs)).toBe('SKIP'); // today is never built
    expect([freezesTonight('2026-10-16', E), freezesTonight('2026-10-15', E), freezesTonight('2026-10-12', E)]).toEqual([false, true, true]);
  });
});

describe('the nightly job', () => {
  it('builds the day before at 03:10 with its trail, is idempotent, refreshes on the next nights and freezes on the 4th', async () => {
    const one = dayOne(DAY);
    const db = factDb({ configs: [CONFIG], trail: one.tr.pts.map((p) => ({ ...p, tenantId: 'tA', truckId: 'truck-1' })) });
    const read = reader({ tA: [one.input] });
    // Before 03:00 on the next day nothing of DAY is built (its trucks may still be out).
    const early = await runAnalysisJob(night(1, '02:30'), { db: db as never, read, force: true });
    expect(early).toMatchObject({ built: 0 });
    expect(db.tables.factTruckDay).toHaveLength(0);

    const r1 = await runAnalysisJob(night(1), { db: db as never, read, force: true });
    expect(r1).toMatchObject({ tenants: 1, built: 1, refreshed: 0, frozen: 0, failed: 0, unfinished: false });
    expect(analysisChanged(r1)).toBe(true);
    const t = db.tables.factTruckDay[0]!;
    expect(t).toMatchObject({ tenantId: 'tA', truckCode: 'T-100', gpsNote: null, frozenAt: null, builtAt: night(1), gpsBuiltAt: night(1) });
    expect(t.kmGps).toBeGreaterThan(9);
    expect(db.tables.factVisit).toHaveLength(2);
    expect(db.tables.factLeg).toHaveLength(3);
    expect(db.tables.factVisit.every((v) => v.tenantId === 'tA')).toBe(true);
    const snapshot = JSON.stringify(db.tables);
    const site2 = db.tables.factVisit.find((x) => x.sequence === 2)!.siteStartAt;
    expect(site2).toBeInstanceOf(Date);

    // The same night again (another tick, a forced cron call): nothing written.
    const r2 = await runAnalysisJob(new Date(night(1).getTime() + 20 * 60_000), { db: db as never, read, force: true });
    expect(r2).toMatchObject({ built: 0, refreshed: 0, frozen: 0 });
    expect(analysisChanged(r2)).toBe(false);
    expect(JSON.stringify(db.tables)).toBe(snapshot);

    // The next nights: the trail is gone (the retention), a result is corrected; the GPS columns stay.
    one.input.visits[1]!.outcome = 'PARTLY_DELIVERED';
    one.input.visits[1]!.casesDelivered = 30;
    const gone = factDb({ configs: [CONFIG] });
    Object.assign(gone.tables, db.tables);
    for (const n of [2, 3]) {
      const r = await runAnalysisJob(night(n), { db: gone as never, read, force: true });
      expect(r, `night ${n}`).toMatchObject({ built: 0, refreshed: 1, frozen: 0 });
    }
    const v = gone.tables.factVisit.find((x) => x.sequence === 2)!;
    expect(v).toMatchObject({ outcome: 'PARTLY_DELIVERED', casesDelivered: 30, frozenAt: null, builtAt: night(1), refreshedAt: night(3) });
    expect(v.siteStartAt).toEqual(site2);
    expect(gone.tables.factTruckDay[0]!.kmGps).toBe(t.kmGps);
    // The 4th day after the delivery date: refreshed a last time and frozen.
    const r4 = await runAnalysisJob(night(4), { db: gone as never, read, force: true });
    expect(r4).toMatchObject({ refreshed: 1, frozen: 1 });
    for (const m of ['factTruckDay', 'factVisit', 'factLeg'] as const) expect(gone.tables[m]!.every((r) => r.frozenAt?.getTime() === night(4).getTime()), m).toBe(true);
    // Frozen: a later change and later nights never write it again.
    one.input.visits[1]!.outcome = 'NOT_DELIVERED';
    const frozen = JSON.stringify(gone.tables);
    for (const n of [5, 6, 9]) await runAnalysisJob(night(n), { db: gone as never, read, force: true });
    expect(JSON.stringify(gone.tables)).toBe(frozen);
  });

  it('a truck without a tracker is built without GPS; a truck-day whose loads went is removed (never a frozen one)', async () => {
    const one = dayOne(DAY);
    const db = factDb({ configs: [CONFIG] });
    const input = { ...one.input, tracked: false };
    await runAnalysisJob(night(1), { db: db as never, read: reader({ tA: [input] }), force: true });
    expect(db.tables.factTruckDay[0]).toMatchObject({ gpsNote: 'NO_TRACKER', gpsBuiltAt: null, kmGps: null });
    expect(db.tables.factVisit.every((v) => v.flags.includes('NO_GPS'))).toBe(true);
    // The next night the load is no longer on the plan in use (moved back): its rows go.
    const r = await runAnalysisJob(night(2), { db: db as never, read: reader({ tA: [] }), force: true });
    expect(r).toMatchObject({ removed: 1 });
    expect(db.tables.factTruckDay).toHaveLength(0);
    expect(db.tables.factVisit).toHaveLength(0);
  });

  it('bounded: an exhausted time budget leaves the rest for the next run; one failing truck-day never stops the others', async () => {
    const one = dayOne(DAY);
    const two = { ...dayOne(DAY).input, truckId: 'truck-2', truckCode: 'T-200' };
    const db = factDb({ configs: [CONFIG], trail: one.tr.pts.map((p) => ({ ...p, tenantId: 'tA', truckId: 'truck-1' })), failTrailOf: 'truck-1' });
    const read = reader({ tA: [one.input, two] });
    const none = await runAnalysisJob(night(1), { db: db as never, read, force: true, budgetMs: -1 });
    expect(none).toMatchObject({ built: 0, unfinished: true });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const r = await runAnalysisJob(night(1), { db: db as never, read, force: true });
    expect(r).toMatchObject({ built: 1, failed: 1, unfinished: false });
    expect(db.tables.factTruckDay.map((x) => x.truckCode)).toEqual(['T-200']);
    // Logged by its code only, never a message (a Prisma message can quote positions).
    expect(warn).toHaveBeenCalledWith('[analysis] truck-day not built', 'P1001');
    warn.mockRestore();
  });

  it('tenant-scoped: each company reads and writes its own rows; another company\'s frozen rows are never touched', async () => {
    const a = dayOne(DAY);
    const db = factDb({ configs: [CONFIG, { ...CONFIG, tenantId: 'tB' }] });
    db.tables.factTruckDay.push({ id: 'b-frozen', tenantId: 'tB', depotId: 'dep-1', deliveryDate: new Date(`${DAY}T00:00:00Z`), truckId: 'truck-1', refreshedAt: night(0), builtAt: night(0), frozenAt: night(0) });
    const read = reader({ tA: [a.input], tB: [a.input] });
    await runAnalysisJob(night(1), { db: db as never, read, force: true });
    expect(read.calls.filter((c) => c.endsWith(`|${DAY}`)).sort()).toEqual([`tA|${DAY}`, `tB|${DAY}`]);
    expect(db.tables.factTruckDay.filter((x) => x.tenantId === 'tA')).toHaveLength(1);
    // Company B's truck-day of that date was frozen: left exactly as it was, no visit written beside it.
    expect(db.tables.factTruckDay.filter((x) => x.tenantId === 'tB')).toEqual([expect.objectContaining({ id: 'b-frozen', frozenAt: night(0) })]);
    expect(db.tables.factVisit.filter((x) => x.tenantId === 'tB')).toHaveLength(0);
  });

  it('the throttle (10 min) and the kill switch', async () => {
    const db = factDb({ configs: [CONFIG] });
    const read = reader({});
    expect(await runAnalysisJob(night(1), { db: db as never, read })).not.toBeNull();
    expect(await runAnalysisJob(new Date(night(1).getTime() + 5 * 60_000), { db: db as never, read })).toBeNull();
    expect(await runAnalysisJob(new Date(night(1).getTime() + 11 * 60_000), { db: db as never, read })).not.toBeNull();
    vi.stubEnv('ROUTEIQ_DISABLE_ANALYSIS', '1');
    expect(await runAnalysisJob(night(2), { db: db as never, read, force: true })).toBeNull();
  });

  it('a company finished tonight is not read again by the next ticks (only a forced run reads it)', async () => {
    const db = factDb({ configs: [CONFIG] });
    const read = reader({});
    await runAnalysisJob(night(1), { db: db as never, read });
    const n = read.calls.length;
    expect(n).toBeGreaterThan(0);
    await runAnalysisJob(new Date(night(1).getTime() + 15 * 60_000), { db: db as never, read });
    expect(read.calls.length).toBe(n);
  });
});

describe('the retention (lib/ivms/retention.ts purgeAnalysisFacts)', () => {
  it('deletes the facts older than analysisRetentionDays before the company\'s today, frozen or not, per company', async () => {
    const db = factDb({ configs: [{ ...CONFIG, analysisRetentionDays: 30 }, { ...CONFIG, tenantId: 'tB', analysisRetentionDays: 730 }] });
    const d = (iso: string) => new Date(`${iso}T00:00:00Z`);
    for (const tenantId of ['tA', 'tB']) {
      for (const [m, date] of [
        ['factTruckDay', '2026-09-10'],
        ['factVisit', '2026-09-10'],
        ['factLeg', '2026-09-30'],
        ['factDepotTurn', '2026-09-18'],
      ] as const) db.tables[m]!.push({ id: `${tenantId}-${m}`, tenantId, deliveryDate: d(date), frozenAt: night(0) });
    }
    const r = await purgeAnalysisFacts(night(1), db as never);
    // Company A keeps 30 days (today 2026-10-19: everything before 2026-09-19 goes); company B keeps 2 years.
    expect(r).toEqual({ truckDays: 1, visits: 1, legs: 0, turns: 1 });
    expect(Object.values(db.tables).flat().filter((x) => x.tenantId === 'tA').map((x) => x.id)).toEqual(['tA-factLeg']);
    expect(Object.values(db.tables).flat().filter((x) => x.tenantId === 'tB')).toHaveLength(4);
    // One company only (the nightly job purges the company it just built).
    expect(await purgeAnalysisFacts(night(1), db as never, 'tB')).toEqual({ truckDays: 0, visits: 0, legs: 0, turns: 0 });
  });

  it('the nightly run purges after building', async () => {
    const db = factDb({ configs: [{ ...CONFIG, analysisRetentionDays: 30 }] });
    db.tables.factVisit.push({ id: 'old', tenantId: 'tA', deliveryDate: new Date('2026-08-01T00:00:00Z'), frozenAt: night(0) });
    const r = await runAnalysisJob(night(1), { db: db as never, read: reader({}), force: true });
    expect(r!.purged).toEqual({ truckDays: 0, visits: 1, legs: 0, turns: 0 });
    expect(db.tables.factVisit).toHaveLength(0);
  });
});
