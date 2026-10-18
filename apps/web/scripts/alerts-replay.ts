/**
 * Operations alerts (owner request 16 Oct 2026): which alerts a past day would have produced, to tune the
 * thresholds before the alerts are switched on (design §PR-2.16; the critique's acceptance gate: at most
 * a few alerts per rule per day). READ ONLY: nothing is written to any database and nothing is e-mailed.
 *
 * Two steps, run from apps/web:
 *
 *   1. Save a day (needs DATABASE_URL; every statement runs in a READ ONLY transaction):
 *        tsx scripts/alerts-replay.ts export --tenant <company code> --date 2026-10-15 --out <file> [--depot <depot code>]
 *      The file holds customer names and driver notes: it is refused inside the repository (the
 *      repository is public) - keep it in a private folder and delete it after use. Running this on
 *      production data needs the owner's OK (production access is read-only and owner-approved).
 *
 *   2. Replay it (no database at all):
 *        tsx scripts/alerts-replay.ts replay <file> [--from 05:00] [--to 23:59] [--step 5] [--switch-on 06:00]
 *            [--set alertEtaLateMin=40] [--set alertLoadingOverMin=off] [--gps | --no-gps] [--timeline] [--json]
 *      Times are of the saved date; "21:00-1" is the evening before, "00:30+1" the night after.
 *      --set tries another setting (any alert threshold column of TenantConfig, or alertDeliveredNote=true/false).
 *      --switch-on: alerts switched on at that time (nothing that began before it raises).
 *      --gps / --no-gps (GPS alerts, owner request 18 Oct 2026): replay with or without the GPS times and depot
 *      moves (lib/alerts/replay.ts); by default with them when the day was saved in GPS tracking ALERTS. A
 *      day saved in TIMES can be replayed with --gps to see what ALERTS would have raised. Live positions are
 *      never saved, so the live ETA and the "still at the stop / at the depot" checks are not replayed.
 *      Whether a GPS depot time is exact is saved as RouteIQ stored it with the move (review of 18 Oct 2026,
 *      finding 6); a move stored before 18 Oct 2026 is read against the trail points, which are deleted
 *      after ivmsTrailDays (default 2 days): export such a day within that time - the export warns when it
 *      may be too late, and the replay repeats the warning.
 *      Prints, per rule, how many alerts were raised, kept as history, escalated and reopened, the first
 *      time and up to three sample texts, and how many a HIGH-only e-mail would have carried. Its output
 *      holds customer names too: do not paste it into the repository, an issue or a commit.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { ALERT_THRESHOLD_COLUMNS, type AlertConfig } from '../lib/alerts/catalog';
import { readAlertDayExport, replayDay, replayText } from '../lib/alerts/replay';

function usage(): never {
  console.error(
    [
      'Usage (from apps/web):',
      '  tsx scripts/alerts-replay.ts export --tenant <company code> --date YYYY-MM-DD --out <file outside the repository> [--depot <depot code>]',
      '  tsx scripts/alerts-replay.ts replay <file> [--from HH:MM] [--to HH:MM] [--step N] [--switch-on HH:MM] [--set column=value] [--gps | --no-gps] [--timeline] [--json]',
    ].join('\n'),
  );
  process.exit(2);
}

/** "05:00" -> 300, "21:00-1" -> -180, "00:30+1" -> 1470. */
export function parseDayMinute(raw: string): number {
  const m = /^(\d{1,2}):(\d{2})([+-]1)?$/.exec(raw.trim());
  if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) throw new Error(`Not a time: "${raw}" (use HH:MM, HH:MM-1 or HH:MM+1).`);
  return Number(m[1]) * 60 + Number(m[2]) + (m[3] === '-1' ? -1440 : m[3] === '+1' ? 1440 : 0);
}

/** "alertEtaLateMin=40" -> { alertEtaLateMin: 40 }; "=off" turns a rule off. */
export function parseSetting(raw: string): Partial<AlertConfig> {
  const [key, value] = raw.split('=');
  if (!key || value === undefined) throw new Error(`Not a setting: "${raw}" (use column=value).`);
  if (key === 'alertDeliveredNote') {
    if (value !== 'true' && value !== 'false') throw new Error('alertDeliveredNote takes true or false.');
    return { alertDeliveredNote: value === 'true' };
  }
  if (!(ALERT_THRESHOLD_COLUMNS as readonly string[]).includes(key)) throw new Error(`Unknown alert setting "${key}". Known: ${ALERT_THRESHOLD_COLUMNS.join(', ')}, alertDeliveredNote.`);
  if (value === 'off' || value === 'null') return { [key]: null } as Partial<AlertConfig>;
  const n = Number(value);
  if (!Number.isInteger(n)) throw new Error(`${key} takes a whole number or off.`);
  return { [key]: n } as Partial<AlertConfig>;
}

/** The repository a path is in (a folder above it holds .git), or null. */
function repositoryOf(file: string): string | null {
  let dir = path.dirname(path.resolve(file));
  for (;;) {
    if (existsSync(path.join(dir, '.git'))) return dir;
    const up = path.dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
}

function flag(args: string[], name: string): string | null {
  const i = args.indexOf(name);
  if (i < 0) return null;
  const v = args[i + 1];
  if (v === undefined || v.startsWith('--')) throw new Error(`${name} needs a value.`);
  return v;
}

function flags(args: string[], name: string): string[] {
  const out: string[] = [];
  args.forEach((a, i) => {
    if (a === name && args[i + 1] !== undefined) out.push(args[i + 1]!);
  });
  return out;
}

async function runExport(args: string[]) {
  const slug = flag(args, '--tenant');
  const date = flag(args, '--date');
  const out = flag(args, '--out');
  const depotCode = flag(args, '--depot');
  if (!slug || !date || !out) usage();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('--date takes YYYY-MM-DD.');
  const repo = repositoryOf(out);
  if (repo) throw new Error(`Refused: ${out} is inside a git repository (${repo}). The export holds customer names and driver notes; save it in a private folder outside every repository.`);
  const { PrismaClient } = await import('@prisma/client');
  const { exportAlertDay } = await import('../lib/alerts/replay-export');
  const db = new PrismaClient();
  try {
    const day = await db.$transaction(
      async (tx) => {
        // Nothing below can write: PostgreSQL refuses any write in a read-only transaction.
        await tx.$executeRawUnsafe('SET TRANSACTION READ ONLY');
        const tenant = await tx.tenant.findFirst({ where: { slug }, select: { id: true } });
        if (!tenant) throw new Error(`No company with the code "${slug}".`);
        const depot = depotCode ? await tx.depot.findFirst({ where: { tenantId: tenant.id, code: depotCode }, select: { id: true } }) : null;
        if (depotCode && !depot) throw new Error(`No depot "${depotCode}" in that company.`);
        return exportAlertDay(tx, tenant.id, date, { depotId: depot?.id ?? null });
      },
      { timeout: 120_000, maxWait: 10_000 },
    );
    writeFileSync(out, JSON.stringify(day));
    console.error(`Saved ${day.loads.length} loads of ${date} to ${out} (read only). It holds customer names and driver notes: keep it private, delete it after use.`);
    for (const w of day.gps?.warnings ?? []) console.error(`Warning: ${w}`);
  } finally {
    await db.$disconnect();
  }
}

function runReplay(args: string[]) {
  const file = args.find((a, i) => !a.startsWith('--') && (i === 0 || !args[i - 1]!.startsWith('--')));
  if (!file) usage();
  const exp = readAlertDayExport(JSON.parse(readFileSync(file, 'utf8')));
  const from = flag(args, '--from');
  const to = flag(args, '--to');
  const step = flag(args, '--step');
  const switchOn = flag(args, '--switch-on');
  const overrides = Object.assign({}, ...flags(args, '--set').map(parseSetting)) as Partial<AlertConfig>;
  const report = replayDay(exp, {
    fromMin: from ? parseDayMinute(from) : undefined,
    toMin: to ? parseDayMinute(to) : undefined,
    stepMin: step ? Number(step) : undefined,
    switchOnMin: switchOn ? parseDayMinute(switchOn) : null,
    overrides,
    gps: args.includes('--gps') ? true : args.includes('--no-gps') ? false : undefined,
  });
  if (args.includes('--json')) {
    console.log(JSON.stringify({ date: report.date, from: report.from, to: report.to, steps: report.steps, gps: report.gps, warnings: report.warnings, rules: report.rules, timeline: args.includes('--timeline') ? report.timeline : undefined }, null, 2));
    return;
  }
  console.log(replayText(report));
  if (args.includes('--timeline')) {
    console.log('\nTimeline:');
    for (const e of report.timeline) console.log(`${e.at}  ${e.kind.padEnd(9)} ${e.rule} tier ${e.tier}${e.emailHigh ? ' (e-mail)' : ''}  ${e.text}`);
  }
}

async function main() {
  const [mode, ...rest] = process.argv.slice(2);
  if (mode === 'export') await runExport(rest);
  else if (mode === 'replay') runReplay(rest);
  else usage();
}

// Run only as a script (the unit spec imports the parsers).
if (process.argv[1] && /alerts-replay\.[cm]?[jt]s$/.test(process.argv[1])) {
  main().catch((e) => {
    console.error((e as Error)?.message ?? e);
    process.exit(1);
  });
}
