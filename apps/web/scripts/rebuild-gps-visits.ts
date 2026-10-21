/**
 * GPS times win over late phone times (owner decision 21 Oct 2026, lib/delivery/visit.ts F1, F2, F4, F5): the
 * visits stored before the release keep their old times until something rebuilds them. This script rebuilds the
 * visits that have GPS (AYUN) events with the new rules, from their stored events (no trail needed: the GPS
 * events are kept after the trail is purged). Visits without a GPS event are never touched: their rebuild is
 * byte for byte the same (tests/lib/ivms-visit-golden.spec.ts).
 *
 * Run from apps/web (needs DATABASE_URL):
 *
 *   tsx scripts/rebuild-gps-visits.ts --tenant <company code> --from 2026-10-16 [--to YYYY-MM-DD] [--write]
 *
 * - Dry run (the default): every statement runs in a READ ONLY transaction. Prints per delivery date the visits
 *   with GPS events and how many would change their shown arrival or departure (by more than 2 and 5 min), and
 *   by which rule (F1 the GPS arrival wins, F2 the minutes after the result, F4 the phone's automatic departure,
 *   F5 the late taps). Counts only: never a customer, a truck, a driver or a time.
 * - --write: rebuilds them, one short transaction per depot and date in the driver path's lock order (the lock
 *   timeout, the outcome-day lock, then each visit read again and rebuilt: event-service.ts rebuildVisit). A
 *   busy lock skips that depot-date (run again). This is a production write: it needs the owner's OK
 *   (production access is read-only and owner-approved).
 * Rebuilt dates still in the analysis refresh window pick the new times up at the next nightly refresh; frozen
 * analysis rows keep theirs. The "4 stays" change (F3) needs the trail and cannot be applied to past days.
 */

/** A stored or rebuilt visit's shown times and what the new rules record (lib/delivery/visit.ts). */
export interface VisitTimesLite {
  arrivedAt: Date | null;
  arrivalSource: string | null;
  departedAt: Date | null;
  departureSource: string | null;
  ownArrivedAt?: Date | null;
  ownDepartureSource?: string | null;
  afterResultMinutes?: number | null;
}

export type RebuildRule = 'F1' | 'F2' | 'F4' | 'F5';

/** How a rebuild changes a visit: the shifts (minutes; null both sides = 0; one side null = Infinity) and the rules that apply after it. Pure. */
export function changeOf(before: VisitTimesLite, after: VisitTimesLite): { arrivalMin: number; departureMin: number; rules: RebuildRule[] } {
  const shift = (a: Date | null, b: Date | null) => (a === null && b === null ? 0 : a === null || b === null ? Infinity : Math.abs(a.getTime() - b.getTime()) / 60_000);
  const rules: RebuildRule[] = [];
  const tapAfterLeaving = !!after.ownArrivedAt && !!after.departedAt && after.departureSource === 'AYUN' && after.ownArrivedAt.getTime() > after.departedAt.getTime();
  if (after.arrivalSource === 'AYUN' && after.ownArrivedAt) rules.push(tapAfterLeaving ? 'F5' : 'F1');
  if (after.afterResultMinutes) rules.push('F2');
  if (after.departureSource === 'AYUN' && after.ownDepartureSource === 'PHONE_AUTO') rules.push('F4');
  return { arrivalMin: shift(before.arrivedAt, after.arrivedAt), departureMin: shift(before.departedAt, after.departedAt), rules };
}

/** One date's counts. */
export interface DateCounts {
  visits: number;
  arrivalOver2: number;
  arrivalOver5: number;
  departureOver2: number;
  departureOver5: number;
  rules: Record<RebuildRule, number>;
  written: number;
  busy: number;
}

export const emptyCounts = (): DateCounts => ({ visits: 0, arrivalOver2: 0, arrivalOver5: 0, departureOver2: 0, departureOver5: 0, rules: { F1: 0, F2: 0, F4: 0, F5: 0 }, written: 0, busy: 0 });

/** Add one visit's change to a date's counts. Pure. */
export function countChange(c: DateCounts, ch: ReturnType<typeof changeOf>): void {
  c.visits++;
  if (ch.arrivalMin > 2) c.arrivalOver2++;
  if (ch.arrivalMin > 5) c.arrivalOver5++;
  if (ch.departureMin > 2) c.departureOver2++;
  if (ch.departureMin > 5) c.departureOver5++;
  for (const r of ch.rules) c.rules[r]++;
}

function usage(): never {
  console.error('Usage (from apps/web): tsx scripts/rebuild-gps-visits.ts --tenant <company code> --from YYYY-MM-DD [--to YYYY-MM-DD] [--write]');
  process.exit(2);
}

function flag(args: string[], name: string): string | null {
  const i = args.indexOf(name);
  if (i < 0) return null;
  const v = args[i + 1];
  if (v === undefined || v.startsWith('--')) throw new Error(`${name} needs a value.`);
  return v;
}

async function main() {
  const args = process.argv.slice(2);
  const slug = flag(args, '--tenant');
  const from = flag(args, '--from');
  if (!slug || !from) usage();
  const write = args.includes('--write');
  const { PrismaClient } = await import('@prisma/client');
  const { dateOnly, DEFAULT_TZ, isoOf, todayIso, zonedDayStart } = await import('../lib/dispatch/time');
  const { derivedVisitOf, rebuildVisit } = await import('../lib/delivery/event-service');
  const { lockOutcomesDay } = await import('../lib/delivery/locks');
  const { isLockBusy, setLockTimeout } = await import('../lib/dispatch/plan-locks');
  const db = new PrismaClient();
  try {
    const tenant = await db.tenant.findFirst({ where: { slug }, select: { id: true } });
    if (!tenant) throw new Error(`No company with the code "${slug}".`);
    const tenantId = tenant.id;
    const cfg = await db.tenantConfig.findFirst({ where: { tenantId }, select: { timezone: true, geofenceRadiusM: true } });
    const tz = cfg?.timezone || DEFAULT_TZ;
    const to = flag(args, '--to') ?? todayIso(tz);
    for (const d of [from, to]) if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) throw new Error('--from and --to take YYYY-MM-DD.');
    if (to < from) throw new Error('--to must not be before --from.');
    const radiusM = Math.min(500, Math.max(50, cfg?.geofenceRadiusM ?? 100));
    // The visits with a GPS event (the others are never touched).
    const rows = await db.stopEvent.findMany({
      where: { tenantId, source: 'AYUN', visitId: { not: null }, deliveryDate: { gte: dateOnly(from), lte: dateOnly(to) } },
      select: { visitId: true, depotId: true, deliveryDate: true },
      distinct: ['visitId'],
    });
    const groups = new Map<string, { depotId: string; date: string; visitIds: string[] }>();
    for (const r of rows) {
      const date = isoOf(r.deliveryDate);
      const k = `${date}|${r.depotId}`;
      if (!groups.has(k)) groups.set(k, { depotId: r.depotId, date, visitIds: [] });
      groups.get(k)!.visitIds.push(r.visitId!);
    }
    const byDate = new Map<string, DateCounts>();
    const ctxOf = async (tx: Parameters<typeof derivedVisitOf>[0], v: { deliveryDate: Date; firstLoadId: string | null }) => {
      const load = v.firstLoadId ? await tx.planLoad.findFirst({ where: { id: v.firstLoadId, tenantId }, select: { breakJson: true } }) : null;
      const b = load?.breakJson as { v?: unknown; startMin?: unknown; endMin?: unknown } | null | undefined;
      const breakMin = b && b.v === 1 && typeof b.startMin === 'number' && typeof b.endMin === 'number' ? { startMin: b.startMin, endMin: b.endMin } : null;
      return { dayStart: zonedDayStart(isoOf(v.deliveryDate), tz), radiusM, breakMin };
    };
    for (const g of [...groups.values()].sort((a, b) => a.date.localeCompare(b.date) || a.depotId.localeCompare(b.depotId))) {
      const counts = byDate.get(g.date) ?? emptyCounts();
      byDate.set(g.date, counts);
      try {
        await db.$transaction(
          async (tx) => {
            if (!write) await tx.$executeRawUnsafe('SET TRANSACTION READ ONLY');
            else {
              await setLockTimeout(tx);
              await lockOutcomesDay(tx, tenantId, g.depotId, g.date);
            }
            for (const id of g.visitIds) {
              const v = await tx.stopVisit.findFirst({ where: { id, tenantId, depotId: g.depotId } });
              if (!v) continue;
              const ctx = await ctxOf(tx, v);
              const { v: after } = await derivedVisitOf(tx, v, ctx);
              countChange(counts, changeOf(v, after));
              if (write) {
                await rebuildVisit(tx, v, ctx);
                counts.written++;
              }
            }
          },
          { timeout: 120_000, maxWait: 10_000 },
        );
      } catch (e) {
        if (write && isLockBusy(e)) {
          counts.busy++;
          continue;
        }
        throw e;
      }
    }
    console.log(`${write ? 'Rebuilt' : 'Dry run (nothing written)'}: ${rows.length} visits with GPS events, ${from} to ${to}.`);
    console.log('date        visits  arr>2  arr>5  dep>2  dep>5   F1   F2   F4   F5' + (write ? '  written  busy' : ''));
    for (const [date, c] of [...byDate.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      const n = (x: number, w: number) => String(x).padStart(w);
      console.log(`${date}  ${n(c.visits, 6)} ${n(c.arrivalOver2, 6)} ${n(c.arrivalOver5, 6)} ${n(c.departureOver2, 6)} ${n(c.departureOver5, 6)} ${n(c.rules.F1, 4)} ${n(c.rules.F2, 4)} ${n(c.rules.F4, 4)} ${n(c.rules.F5, 4)}` + (write ? ` ${n(c.written, 8)} ${n(c.busy, 5)}` : ''));
    }
    if (write && [...byDate.values()].some((c) => c.busy)) console.log('Some depot-dates were busy and skipped: run again.');
  } finally {
    await db.$disconnect();
  }
}

// Run only as a script (the unit spec imports the counters).
if (process.argv[1] && /rebuild-gps-visits\.[cm]?[jt]s$/.test(process.argv[1])) {
  main().catch((e) => {
    console.error((e as Error)?.message ?? e);
    process.exit(1);
  });
}
