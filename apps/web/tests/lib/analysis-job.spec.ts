/**
 * The analysis dataset's nightly job (owner request 19 Oct 2026; lib/analysis/job.ts) and its retention
 * (lib/ivms/retention.ts purgeAnalysisFacts), on an in-memory stand-in for the fact tables
 * (analysis-fakes.ts factDb) with the day fed by the test (invented truck-days only):
 * - the schedule: the effective day turns at 03:00 company time; the day before is built, the 2nd to 4th days
 *   before are refreshed once a night, the 4th is frozen; a frozen row is never written again;
 * - idempotent: a second run the same night changes nothing; a run of another process (unique key) is skipped;
 * - bounded and safe: the time budget leaves the rest for the next run, and a date is read again until all of
 *   it was done; one failing truck-day never stops the others and is tried again at the next run the same
 *   night (at most 3 times); the 10-minute throttle, the kill switch;
 * - the trail: never used when its start was already deleted (PARTIAL_TRAIL); recomputed at a refresh when it
 *   was pulled again after the build and is still whole;
 * - tenant-scoped: each company's rows carry its own id and another company's frozen rows are never touched;
 * - the retention deletes the facts older than analysisRetentionDays, frozen or not, per company.
 * The integration spec analysis-facts-db.spec.ts runs the same job on PostgreSQL with the real reader.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TruckDayIn } from '@/lib/analysis/build';
import { _resetAnalysisJobState, analysisChanged, ANALYSIS_MAX_TRIES, cycleStartOf, effectiveDay, freezesTonight, runAnalysisJob, trailWhole, truckDayAction, type DayReader } from '@/lib/analysis/job';
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
function reader(perTenant: Record<string, (TruckDayIn & { lastPullAt?: Date | null })[]>): DayReader & { calls: string[] } {
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

  it('a catch-up whose trail start the GPS retention already deleted keeps no GPS column (PARTIAL_TRAIL), never the afternoon alone (review of 19 Oct 2026)', async () => {
    // The trail still whole: at 03:10 with the 2-day trail the day before and the day before that (pulls from 05:00).
    expect(trailWhole(DAY, null, { timezone: TZ }, night(1))).toBe(true);
    expect(trailWhole(DAY, null, { timezone: TZ }, night(2))).toBe(true);
    // A deploy at 14:00: the 2-day retention has deleted DAY's trail before 14:00 of that date.
    expect(trailWhole(DAY, null, { timezone: TZ }, night(2, '14:00'))).toBe(false);
    // One day kept: at 03:10 the day before is still whole (its pulls begin at 05:00), at 05:10 no longer.
    expect(trailWhole(DAY, null, { timezone: TZ, ivmsTrailDays: 1 }, night(1))).toBe(true);
    expect(trailWhole(DAY, null, { timezone: TZ, ivmsTrailDays: 1 }, night(1, '05:10'))).toBe(false);
    // A tracker mapped at 15:00 that day: its trail begins then, whole after the 14:00 cutoff.
    expect(trailWhole(DAY, atOn(DAY, '15:00'), { timezone: TZ }, night(2, '14:00'))).toBe(true);

    const one = dayOne(DAY);
    const db = factDb({ configs: [CONFIG], trail: one.tr.pts.map((p) => ({ ...p, tenantId: 'tA', truckId: 'truck-1' })) });
    const trailRead = vi.spyOn(db.truckTrailPoint, 'findMany');
    const r = await runAnalysisJob(night(2, '14:00'), { db: db as never, read: reader({ tA: [one.input] }), force: true });
    expect(r).toMatchObject({ built: 1, failed: 0 });
    expect(trailRead).not.toHaveBeenCalled();
    expect(db.tables.factTruckDay[0]).toMatchObject({ gpsNote: 'PARTIAL_TRAIL', gpsBuiltAt: null, firstOutAt: null, kmGps: null, outMin: null });
    expect(db.tables.factVisit.every((v) => v.flags.includes('NO_GPS') && v.siteStartAt === null && v.unloadSource === 'VISIT')).toBe(true);
    // Its refreshes keep the note and never read the trail.
    await runAnalysisJob(night(3), { db: db as never, read: reader({ tA: [{ ...one.input, lastPullAt: night(2, '15:00') }] }), force: true });
    expect(db.tables.factTruckDay[0]).toMatchObject({ gpsNote: 'PARTIAL_TRAIL', refreshedAt: night(3) });
    expect(trailRead).not.toHaveBeenCalled();
  });

  it('a refresh recomputes the GPS columns when the trail was pulled again after the build and is still whole (a late final pull)', async () => {
    const one = dayOne(DAY);
    // At 03:10 the trail had come to 07:30 only (the load left open, its final pull not yet made).
    const full = one.tr.pts.map((p) => ({ ...p, tenantId: 'tA', truckId: 'truck-1' }));
    const trail = full.filter((p) => p.fixAt.getTime() < atOn(DAY, '07:30').getTime());
    const db = factDb({ configs: [CONFIG], trail });
    await runAnalysisJob(night(1), { db: db as never, read: reader({ tA: [{ ...one.input, lastPullAt: night(1, '02:00') }] }), force: true });
    const built = { ...db.tables.factTruckDay[0]! };
    expect(built).toMatchObject({ lastInAt: null, gpsBuiltAt: night(1) });
    // The office completes the load at 09:00; the poller's final pull over the whole day follows.
    trail.push(...full.slice(trail.length));
    const pulled = reader({ tA: [{ ...one.input, lastPullAt: night(1, '09:10') }] });
    expect(await runAnalysisJob(night(2), { db: db as never, read: pulled, force: true })).toMatchObject({ refreshed: 1, failed: 0 });
    const t = db.tables.factTruckDay[0]!;
    expect(t).toMatchObject({ lastInFrom: 'TRAIL', builtAt: night(1), gpsBuiltAt: night(2), refreshedAt: night(2) });
    expect(t.lastInAt).toBeInstanceOf(Date);
    expect(t.kmGps).toBeGreaterThan(built.kmGps);
    // Not pulled again since: the next night copies the columns as they are.
    await runAnalysisJob(night(3), { db: db as never, read: pulled, force: true });
    expect(db.tables.factTruckDay[0]).toMatchObject({ gpsBuiltAt: night(2), refreshedAt: night(3), kmGps: t.kmGps });
  });

  it('the in-process janitor tries a failed truck-day again at its next run the same night, at most 3 times (review of 19 Oct 2026)', async () => {
    const one = dayOne(DAY);
    const two = { ...dayOne(DAY).input, truckId: 'truck-2', truckCode: 'T-200' };
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    // A deadlock at 03:10 on truck-1 only, once.
    const db = factDb({ configs: [CONFIG], trail: one.tr.pts.map((p) => ({ ...p, tenantId: 'tA', truckId: 'truck-1' })), failTrailOf: 'truck-1', failTimes: 1 });
    const read = reader({ tA: [one.input, two] });
    expect(await runAnalysisJob(night(1), { db: db as never, read })).toMatchObject({ built: 1, failed: 1 });
    // Before the fix the company was marked done: truck-1 waited for the next night (as the 2nd day back).
    expect(await runAnalysisJob(night(1, '03:21'), { db: db as never, read })).toMatchObject({ tenants: 1, built: 1, failed: 0 });
    expect(db.tables.factTruckDay.map((x) => x.truckCode).sort()).toEqual(['T-100', 'T-200']);
    expect(db.tables.factTruckDay.find((x) => x.truckCode === 'T-100')).toMatchObject({ gpsBuiltAt: night(1, '03:21'), gpsNote: null });
    // Done now: the next run reads nothing.
    const n = read.calls.length;
    expect(await runAnalysisJob(night(1, '03:32'), { db: db as never, read })).toMatchObject({ tenants: 0 });
    expect(read.calls.length).toBe(n);

    // A failure every time: tried ANALYSIS_MAX_TRIES times, then left for the next night (the company done).
    _resetAnalysisJobState();
    const bad = factDb({ configs: [CONFIG], trail: [], failTrailOf: 'truck-1' });
    const tries: number[] = [];
    for (let k = 0; k < ANALYSIS_MAX_TRIES + 2; k++) {
      const r = await runAnalysisJob(new Date(night(1).getTime() + k * 11 * 60_000), { db: bad as never, read });
      tries.push(r!.failed);
    }
    expect(tries).toEqual([1, 1, 1, 0, 0]);
    expect(bad.tables.factTruckDay.map((x) => x.truckCode)).toEqual(['T-200']);
    warn.mockRestore();
  });

  it('after a time-budget cut, a truck with no row yet on a date whose other rows are done is built at the next run (review of 19 Oct 2026)', async () => {
    const one = dayOne(DAY);
    const db = factDb({ configs: [CONFIG] });
    const a = { ...one.input, tracked: false };
    const b = { ...a, truckId: 'truck-2', truckCode: 'T-200' };
    await runAnalysisJob(night(1), { db: db as never, read: reader({ tA: [a, b] }), force: true });
    // The next night truck-3's load is on the plan as well (marked as left late): it needs a BUILD.
    const c = { ...a, truckId: 'truck-3', truckCode: 'T-300' };
    const read = reader({ tA: [a, b, c] });
    // The budget runs out after two truck-days: A and B refreshed, C not reached.
    let tick = 0;
    const r1 = await runAnalysisJob(night(2), { db: db as never, read, budgetMs: 2, clock: () => tick++ });
    expect(r1).toMatchObject({ refreshed: 2, built: 0, unfinished: true });
    // Ten minutes later: A and B are done tonight, but the date is read again and C is built.
    const r2 = await runAnalysisJob(night(2, '03:21'), { db: db as never, read });
    expect(r2).toMatchObject({ built: 1, refreshed: 0, unfinished: false });
    expect(db.tables.factTruckDay.map((x) => x.truckCode).sort()).toEqual(['T-100', 'T-200', 'T-300']);
    // Every date done: the next forced run reads only the day before, never DAY again tonight.
    const before = read.calls.length;
    await runAnalysisJob(night(2, '03:40'), { db: db as never, read, force: true });
    expect(read.calls.slice(before)).toEqual([`tA|${addDaysIso(DAY, 1)}`]);
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
