/**
 * Operations alerts by e-mail (owner request 16 Oct 2026; design PR-2 9.2 with the review's fixes M4,
 * M5, L5, L7, L9): after each sweep, one digest e-mail per company with what is new or worse since the
 * last e-mail. The sweep (lib/alerts/sweep.ts) calls sendAlertDigest(tenantId, now) for each company with
 * alerts on, after its rows are written.
 *
 * Nothing is sent unless ALL of these hold (digestGate):
 * - the company switched alerts on and has recipients (Settings > Operations alerts);
 * - "e-mail at most every N min" is not 0;
 * - the server has Resend set up (RESEND_API_KEY and RESEND_FROM: lib/email.ts plainEmailConfigured);
 * - the company is on the server's list ALERT_EMAIL_TENANTS (catalog.ts alertEmailAllowed; review of 16 Oct
 *   2026, H1: signup is open, so without it anyone could send to any address through our sender);
 * - it is not the company's quiet hours (22:00-06:00 by default; the alerts still show in RouteIQ, and
 *   what is still worth sending goes in the first e-mail after them - a HIGH of the evening closed at
 *   midnight as "day ended" and never e-mailed included, not what ended overnight).
 *
 * Then, in ONE transaction that holds the company's e-mail lock (pg_try_advisory_xact_lock: a second
 * sweep during a deploy overlap skips the company instead of sending twice): the throttle (no e-mail
 * within N min of the last), the daily cap (ALERT_EMAILS_PER_DAY, counted on OpsAlertDigest rows, not on
 * the alert rows a later e-mail overwrites: M5), the cap of all companies together (ALERT_EMAILS_ALL_PER_DAY
 * in any 24 h), and the claim of the rows (FOR UPDATE SKIP LOCKED):
 * - not acknowledged, allowed in an e-mail at their tier (mayEmail: never a history row, never unloading
 *   tier 1), of the company's minimum severity or above (HIGH by default), worse than what was last
 *   e-mailed (emailedTier < tier), seen in the last ALERT_EMAIL_LOOKBACK_H hours (lastSeenAt, so a row
 *   reopened or escalated counts: L5), fewer than ALERT_EMAIL_MAX_ATTEMPTS failed tries. lastSeenAt moves
 *   only when a row's tier, value or words change (fewer writes): a row that stayed the same for more
 *   than 12 h before an e-mail could go (the quiet hours, the daily cap) is not e-mailed any more; it
 *   still shows in RouteIQ (review L6 of 16 Oct 2026: documented, not changed);
 * - still open, or over by itself since the last e-mail ("(over at 10:50)"), not what ended during the
 *   quiet hours; a row closed because its load left the plan, its date passed, its rule was switched off,
 *   it is no longer followed or its result was corrected is not news;
 * - of the company's today or later (owner request 19 Oct 2026): after midnight the day before is history.
 *   The sweep closes its open rows as DAY_ENDED before this step runs (store.ts); a row of the day before
 *   still open (that company's sweep failed this tick) is not e-mailed as open. Two kinds of row of the day
 *   before are still e-mailed (review of the branch, 19 Oct 2026; nothing is sent twice):
 *   - a row closed as DAY_ENDED that was never e-mailed (emailedTier 0), once, marked "(day ended)" (finding
 *     1). Without it a HIGH raised at 21:50, after the 21:45 e-mail and before the quiet hours (22:00-06:00
 *     by default), was never e-mailed: closed at 00:02 and out of the date guard by 06:00. The same for a
 *     HIGH raised at 23:50 when the next e-mail is due after midnight, and for the rows left once the daily
 *     cap is reached (still within the 12 h above). A row e-mailed before at a lower tier is not sent again
 *     once its day ended (the owner's "e-mail digests must not re-send closed ones");
 *   - the day's follow-up raised after this midnight (Load not closed for a load planned back late: catalog.ts
 *     ALERT_AFTER_DAY_RULES, firstSeenAt at or after the day's start), as a row of today (finding 2);
 * - HIGH first by rank, never by the alphabet (L5), at most ALERT_DIGEST_MAX_ROWS.
 * The claimed rows get emailedTier = tier and the digest's id; then the transaction commits and the
 * e-mail goes out. A failure puts each row's emailedTier back, counts the attempt and keeps a short reason;
 * a digest left SENDING by a stopped process is failed the same way by the next run.
 *
 * Logs carry counts only, never an address or an alert text. The e-mail text removes any long digit run
 * once more, in every free text (the alert, the truck, the depot; lib/alerts/text.ts redactNumbers, any
 * script's digits). The subject carries no name a user typed (the counts and the day only). The send has an
 * Idempotency-Key over its content, so a message Resend accepted but answered too late is not sent twice.
 */
import { createHash } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { prisma as defaultPrisma, type AppPrismaClient } from '../db';
import { addDaysIso, fmtDayMonth, fmtHhmm, isoOf, localMinutes, todayIso, zonedDayStart } from '../dispatch/time';
import { plainEmailConfigured, sendPlainEmail, type SendResult } from '../email';
import { resetBaseUrl } from '../password-reset';
import {
  ALERT_AFTER_DAY_RULES,
  ALERT_EMAIL_LOOKBACK_H,
  ALERT_EMAIL_MAX_ATTEMPTS,
  ALERT_EMAILS_ALL_PER_DAY,
  ALERT_EMAILS_PER_DAY,
  ALERT_RULE_SPECS,
  alertEmailAllowed,
  SEVERITY_ORDER_SQL,
  SEVERITY_RANK,
  emailSeverityPasses,
  inQuietHours,
  isAlertRule,
  readAlertEmails,
  type AlertSeverity,
} from './catalog';
import { redactNumbers } from './text';

/** At most this many alerts in one e-mail (HIGH first); the rest go in the next one. */
export const ALERT_DIGEST_MAX_ROWS = 50;
/** A digest still SENDING after this long was cut off (a restart between claim and send). */
export const DIGEST_STALE_MS = 5 * 60_000;

/** The company settings the digest reads (TenantConfig + Tenant). */
export interface DigestConfig {
  alertsEnabled: boolean;
  alertEmails: string | null;
  alertEmailEveryMin: number;
  alertEmailMinSeverity: string;
  alertQuietFromMin: number | null;
  alertQuietToMin: number | null;
  timezone: string;
  /** The company's slug: the server's ALERT_EMAIL_TENANTS list names it. */
  slug?: string;
}

export type DigestSkip =
  | 'ALERTS_OFF'
  | 'NO_RECIPIENTS'
  | 'EMAIL_OFF'
  | 'NOT_CONFIGURED'
  | 'NOT_ALLOWED'
  | 'QUIET_HOURS'
  | 'BUSY'
  | 'TOO_SOON'
  | 'DAILY_CAP'
  | 'ALL_COMPANIES_CAP'
  | 'NOTHING_NEW';

/** Whether the company may get a digest now, and to whom (no database read). */
export function digestGate(cfg: DigestConfig | null | undefined, now: Date, env: NodeJS.ProcessEnv = process.env): { ok: true; recipients: string[] } | { ok: false; skip: DigestSkip } {
  if (!cfg?.alertsEnabled) return { ok: false, skip: 'ALERTS_OFF' };
  const parsed = readAlertEmails(cfg.alertEmails);
  if (!parsed.ok || !parsed.emails.length) return { ok: false, skip: 'NO_RECIPIENTS' };
  if (!(cfg.alertEmailEveryMin > 0)) return { ok: false, skip: 'EMAIL_OFF' };
  if (!plainEmailConfigured(env)) return { ok: false, skip: 'NOT_CONFIGURED' };
  if (!alertEmailAllowed(cfg.slug, env)) return { ok: false, skip: 'NOT_ALLOWED' };
  if (inQuietHours(localMinutes(now, cfg.timezone), cfg.alertQuietFromMin, cfg.alertQuietToMin)) return { ok: false, skip: 'QUIET_HOURS' };
  return { ok: true, recipients: parsed.emails };
}

/** One claimed alert, as the e-mail needs it. */
export interface DigestRow {
  id: string;
  rule: string;
  severity: AlertSeverity;
  tier: number;
  /** The tier e-mailed before this digest (0 = never): put back if the e-mail fails. */
  emailedTier: number;
  depotId: string;
  deliveryDate: Date;
  truckCode: string;
  text: string;
  occurredAt: Date;
  resolvedAt: Date | null;
  /** Why it closed (null while open): "(day ended)" for DAY_ENDED, else "(over at 10:50)". */
  resolvedReason?: string | null;
}

export type ClaimResult =
  | { ok: true; digestId: string; rows: DigestRow[] }
  | { ok: false; skip: Extract<DigestSkip, 'BUSY' | 'TOO_SOON' | 'DAILY_CAP' | 'ALL_COMPANIES_CAP' | 'NOTHING_NEW'> };

/** The database side of the digest (prismaDigestStore; a fake in the unit tests). */
export interface DigestStore {
  readConfig(tenantId: string): Promise<(DigestConfig & { name: string; slug: string }) | null>;
  claim(tenantId: string, now: Date, opts: { everyMin: number; minSeverity: string; dayStart: Date; today: string; recipients: number; quietEndedAt?: Date | null }): Promise<ClaimResult>;
  depotLabels(tenantId: string, depotIds: string[]): Promise<Map<string, string>>;
  finish(tenantId: string, digestId: string, rows: DigestRow[], now: Date, result: SendResult): Promise<void>;
}

export interface DigestOutcome {
  sent: boolean;
  skip?: DigestSkip;
  /** The e-mail failed (REJECTED / FAILED): its short reason. */
  error?: string;
  alerts: number;
  high: number;
  digestId?: string;
}

/** A run of ALERT_REDACT_DIGITS_MIN or more digits of any script (spaces, + - / . ( ) inside) is a number to hide (text.ts redactNumbers). */
export function scrubNumbers(text: string): string {
  return redactNumbers(text);
}

const ONE_LINE = (s: string) => s.replace(/\s+/g, ' ').trim();
/** Every free text of the e-mail: one line, long digit runs removed (review L4: the truck and the depot too). */
const SAFE = (s: string) => scrubNumbers(ONE_LINE(s));

/**
 * When the company's last quiet hours ended, at or before `now` (null: no quiet hours). The first e-mail
 * after them leaves out what ended overnight (review L5: "over at 23:10" at 06:00 is not news).
 */
export function lastQuietEnd(now: Date, tz: string, fromMin: number | null | undefined, toMin: number | null | undefined): Date | null {
  if (fromMin == null || toMin == null || fromMin === toMin) return null;
  const today = todayIso(tz, now);
  const end = new Date(zonedDayStart(today, tz).getTime() + toMin * 60_000);
  return end.getTime() <= now.getTime() ? end : new Date(zonedDayStart(addDaysIso(today, -1), tz).getTime() + toMin * 60_000);
}

/** The Idempotency-Key of one e-mail: its company, recipients and content (the same e-mail again within 24 h is sent once). */
export function digestIdempotencyKey(tenantId: string, to: readonly string[], subject: string, text: string): string {
  return `routeiq-alerts-${createHash('sha256').update(JSON.stringify([tenantId, [...to].sort(), subject, text])).digest('hex').slice(0, 48)}`;
}

/**
 * The digest e-mail: grouped by depot and date (with a link to that day's screen), then by truck (the
 * truck with the worst alert first), HIGH first within a truck. Pure.
 */
export function buildDigestEmail(input: {
  companyName: string;
  slug: string;
  timezone: string;
  now: Date;
  rows: DigestRow[];
  depotLabels: Map<string, string>;
  baseUrl: string | null;
  minSeverity: string;
  full: boolean;
}): { subject: string; text: string } {
  const { rows, timezone: tz } = input;
  const high = rows.filter((r) => r.severity === 'HIGH').length;
  // No name a user typed in the subject (review H1: an open signup must not choose what our sender says).
  const subject = `RouteIQ alerts: ${rows.length} new (${high} high) - ${fmtDayMonth(todayIso(tz, input.now))}`;
  const hhmm = (d: Date) => fmtHhmm(localMinutes(d, tz));
  const groups = new Map<string, { depotId: string; date: string; trucks: Map<string, DigestRow[]> }>();
  for (const r of rows) {
    const date = isoOf(r.deliveryDate);
    const key = `${date}|${r.depotId}`;
    const g = groups.get(key) ?? { depotId: r.depotId, date, trucks: new Map() };
    groups.set(key, g);
    const list = g.trucks.get(r.truckCode) ?? [];
    list.push(r);
    g.trucks.set(r.truckCode, list);
  }
  const worst = (list: DigestRow[]) => Math.min(...list.map((r) => SEVERITY_RANK[r.severity] ?? 1));
  const byRow = (a: DigestRow, b: DigestRow) => (SEVERITY_RANK[a.severity] ?? 1) - (SEVERITY_RANK[b.severity] ?? 1) || a.occurredAt.getTime() - b.occurredAt.getTime();
  const lines: string[] = [];
  lines.push(`${rows.length} ${rows.length === 1 ? 'alert' : 'alerts'} since the last e-mail (${high} high).`);
  for (const g of [...groups.values()].sort((a, b) => a.date.localeCompare(b.date) || (input.depotLabels.get(a.depotId) ?? '').localeCompare(input.depotLabels.get(b.depotId) ?? ''))) {
    lines.push('');
    lines.push(`${SAFE(input.depotLabels.get(g.depotId) ?? 'Depot')} - ${fmtDayMonth(g.date)}`);
    if (input.baseUrl) lines.push(`Open the day in RouteIQ: ${input.baseUrl}/t/${encodeURIComponent(input.slug)}/dispatch?date=${g.date}&depot=${encodeURIComponent(g.depotId)}`);
    const trucks = [...g.trucks.entries()].sort((a, b) => worst(a[1]) - worst(b[1]) || a[0].localeCompare(b[0]));
    for (const [truck, list] of trucks) {
      lines.push(`  ${SAFE(truck)}`);
      for (const r of [...list].sort(byRow)) {
        const label = isAlertRule(r.rule) ? ALERT_RULE_SPECS[r.rule].label : r.rule;
        // A row closed at the end of its day was still open then: "day ended", not "over" (review of the branch, finding 1).
        const closed = r.resolvedReason === 'DAY_ENDED' ? 'day ended' : r.resolvedAt ? `over at ${hhmm(r.resolvedAt)}` : null;
        const notes = [r.emailedTier > 0 ? 'worse since the last e-mail' : null, closed].filter(Boolean);
        lines.push(`    [${r.severity}] ${hhmm(r.occurredAt)} ${label}: ${SAFE(r.text)}${notes.length ? ` (${notes.join('; ')})` : ''}`);
      }
    }
  }
  lines.push('');
  if (!input.full) lines.push(`At most ${ALERT_DIGEST_MAX_ROWS} alerts go in one e-mail: there may be more under Alerts in RouteIQ.`);
  lines.push('Acknowledge them in RouteIQ: the bell at the top, or the Alerts page.');
  lines.push(
    input.minSeverity === 'WARN'
      ? 'This e-mail lists warnings and high alerts. Change the rules, the recipients or the quiet hours: Settings > Operations alerts.'
      : 'This e-mail lists high alerts only; warnings show in RouteIQ. Change the rules, the recipients or the quiet hours: Settings > Operations alerts.',
  );
  return { subject, text: lines.join('\n') };
}

/**
 * Send the company's digest if it is due. Never throws (the sweep goes on with the next company); a
 * database error is logged with counts only and answers `sent: false`.
 */
export async function sendAlertDigest(
  tenantId: string,
  now: Date,
  deps: { store?: DigestStore; env?: NodeJS.ProcessEnv; fetchImpl?: typeof fetch } = {},
): Promise<DigestOutcome> {
  const store = deps.store ?? prismaDigestStore(defaultPrisma);
  const env = deps.env ?? process.env;
  try {
    const cfg = await store.readConfig(tenantId);
    const gate = digestGate(cfg, now, env);
    if (!gate.ok) return { sent: false, skip: gate.skip, alerts: 0, high: 0 };
    if (!cfg) return { sent: false, skip: 'ALERTS_OFF', alerts: 0, high: 0 };
    const today = todayIso(cfg.timezone, now);
    const dayStart = zonedDayStart(today, cfg.timezone);
    const claim = await store.claim(tenantId, now, {
      everyMin: cfg.alertEmailEveryMin,
      minSeverity: cfg.alertEmailMinSeverity,
      dayStart,
      today,
      recipients: gate.recipients.length,
      quietEndedAt: lastQuietEnd(now, cfg.timezone, cfg.alertQuietFromMin, cfg.alertQuietToMin),
    });
    if (!claim.ok) return { sent: false, skip: claim.skip, alerts: 0, high: 0 };
    const { rows, digestId } = claim;
    const high = rows.filter((r) => r.severity === 'HIGH').length;
    const mail = buildDigestEmail({
      companyName: cfg.name,
      slug: cfg.slug,
      timezone: cfg.timezone,
      now,
      rows,
      depotLabels: await store.depotLabels(tenantId, [...new Set(rows.map((r) => r.depotId))]),
      baseUrl: resetBaseUrl(env),
      minSeverity: cfg.alertEmailMinSeverity,
      full: rows.length < ALERT_DIGEST_MAX_ROWS,
    });
    const result = await sendPlainEmail({ to: gate.recipients, ...mail, idempotencyKey: digestIdempotencyKey(tenantId, gate.recipients, mail.subject, mail.text) }, env, deps.fetchImpl);
    await store.finish(tenantId, digestId, rows, now, result);
    if (result.ok) {
      console.info('[alerts] e-mail sent', { tenantId, digestId, alerts: rows.length, high, recipients: gate.recipients.length });
      return { sent: true, alerts: rows.length, high, digestId };
    }
    console.warn('[alerts] e-mail not sent', { tenantId, digestId, alerts: rows.length, reason: result.reason, error: result.error });
    return { sent: false, error: result.error, alerts: rows.length, high, digestId };
  } catch (err) {
    console.error('[alerts] e-mail step failed', { tenantId, error: (err as Error)?.name ?? 'Error' });
    return { sent: false, error: 'internal error', alerts: 0, high: 0 };
  }
}

type Tx = Prisma.TransactionClient;

interface ClaimSqlRow {
  id: string;
  rule: string;
  severity: string;
  tier: number;
  emailedTier: number;
  depotId: string;
  deliveryDate: Date;
  truckCode: string;
  text: string;
  occurredAt: Date;
  resolvedAt: Date | null;
  resolvedReason: string | null;
}

/**
 * The claim query (exported for the unit test of its SQL). A row over by itself (ENDED) is news only when
 * it ended after `endedSince` (the last e-mail; for the first e-mail, the last "every N min"): the first
 * e-mail after recipients are added does not list what ended during the days alerts showed in RouteIQ only.
 * Open or over by itself only for rows of the company's `today` (YYYY-MM-DD) or later, or the day's
 * follow-up raised since `dayStart` (the start of that today: review of the branch, 19 Oct 2026, finding 2);
 * a row of yesterday still open because the sweep has not run since midnight is not e-mailed as open (owner
 * request 19 Oct 2026). A row closed as DAY_ENDED goes once if it was never e-mailed (finding 1: its
 * emailedTier becomes its tier, so it never goes again); one e-mailed before is not sent again.
 */
export function claimSql(tenantId: string, now: Date, minSeverity: string, endedSince: Date, today: string, dayStart: Date): Prisma.Sql {
  const lookback = new Date(now.getTime() - ALERT_EMAIL_LOOKBACK_H * 3_600_000);
  const anySeverity = minSeverity === 'WARN';
  return Prisma.sql`
    SELECT "id", "rule", "severity", "tier", "emailedTier", "depotId", "deliveryDate", "truckCode", "text", "occurredAt", "resolvedAt", "resolvedReason"
    FROM "OpsAlert"
    WHERE "tenantId" = ${tenantId}
      AND "ackedAt" IS NULL
      AND "mayEmail" = true
      AND "emailedTier" < "tier"
      AND "emailAttempts" < ${ALERT_EMAIL_MAX_ATTEMPTS}
      AND "lastSeenAt" > ${lookback}
      AND (
        (("deliveryDate" >= ${today}::date OR ("firstSeenAt" >= ${dayStart} AND "rule" IN (${Prisma.join([...ALERT_AFTER_DAY_RULES])})))
          AND ("resolvedAt" IS NULL OR ("resolvedReason" = 'ENDED' AND "resolvedAt" > ${endedSince})))
        OR ("resolvedReason" = 'DAY_ENDED' AND "emailedTier" = 0)
      )
      AND (${anySeverity} OR "severity" = 'HIGH')
    ORDER BY ${Prisma.raw(SEVERITY_ORDER_SQL)}, "firstSeenAt", "id"
    LIMIT ${ALERT_DIGEST_MAX_ROWS}
    FOR UPDATE SKIP LOCKED`;
}

/** The lock key of a company's e-mail claim (another key than the sweep's own lock). */
export const digestLockKey = (tenantId: string) => `ops-alerts-mail:${tenantId}`;

/**
 * Waits for the company's e-mail lock (the transaction's lock timeout applies). A cause & action save takes it
 * before it writes a row (lib/alerts/inbox.ts lockForReview; review of the branch, 20 Oct 2026, finding 1): a
 * claim that starts meanwhile answers BUSY and creates no digest, so the next claim still reads what ended
 * since the last e-mail. Without it the claim's FOR UPDATE SKIP LOCKED skipped the row the save held, and an
 * alert over by itself (ENDED, news in one e-mail only) was never e-mailed once a digest of other rows moved
 * the "ended since" time past it.
 */
export async function lockTenantDigest(tx: Tx, tenantId: string): Promise<void> {
  await tx.$queryRaw`SELECT 1 AS locked FROM pg_advisory_xact_lock(hashtext(${digestLockKey(tenantId)}))`;
}

/** Fail the digests a stopped process left SENDING: their rows are e-mailed again (emailedTier 0). */
async function failStaleDigests(tx: Tx, tenantId: string, now: Date) {
  const stale = await tx.opsAlertDigest.findMany({
    where: { tenantId, status: 'SENDING', createdAt: { lt: new Date(now.getTime() - DIGEST_STALE_MS) } },
    select: { id: true },
  });
  for (const d of stale) {
    await tx.opsAlertDigest.update({ where: { id: d.id }, data: { status: 'FAILED', error: 'interrupted before it was sent' } });
    await tx.opsAlert.updateMany({
      where: { tenantId, digestId: d.id },
      data: { emailedTier: 0, emailAttempts: { increment: 1 }, emailError: 'interrupted before it was sent' },
    });
  }
}

/** The digest store on PostgreSQL. Every query names the company (the sweep runs outside a session). */
// The app's client (lib/db.ts: with the IVMS link's global omit; merge of 16 Oct 2026).
export function prismaDigestStore(db: AppPrismaClient): DigestStore {
  return {
    async readConfig(tenantId) {
      const t = await db.tenant.findUnique({
        where: { id: tenantId },
        select: {
          name: true,
          slug: true,
          config: {
            select: {
              alertsEnabled: true,
              alertEmails: true,
              alertEmailEveryMin: true,
              alertEmailMinSeverity: true,
              alertQuietFromMin: true,
              alertQuietToMin: true,
              timezone: true,
            },
          },
        },
      });
      if (!t?.config) return null;
      return { name: t.name, slug: t.slug, ...t.config };
    },

    async claim(tenantId, now, opts) {
      return db.$transaction(async (tx) => {
        const lock = await tx.$queryRaw<{ locked: boolean }[]>`SELECT pg_try_advisory_xact_lock(hashtext(${digestLockKey(tenantId)})) AS "locked"`;
        if (!lock[0]?.locked) return { ok: false as const, skip: 'BUSY' as const };
        await failStaleDigests(tx, tenantId, now);
        const last = await tx.opsAlertDigest.findFirst({ where: { tenantId }, orderBy: { createdAt: 'desc' }, select: { createdAt: true } });
        if (last && now.getTime() - last.createdAt.getTime() < opts.everyMin * 60_000) return { ok: false as const, skip: 'TOO_SOON' as const };
        const today = await tx.opsAlertDigest.count({ where: capWhere(tenantId, opts.dayStart) });
        if (today >= ALERT_EMAILS_PER_DAY) return { ok: false as const, skip: 'DAILY_CAP' as const };
        // Every company together (the provider's free plan and the password reset share the sender): a
        // platform-wide count of digest rows (counts only, no company's data is read).
        const all = await tx.opsAlertDigest.count({ where: { createdAt: { gt: new Date(now.getTime() - 24 * 3_600_000) }, status: { not: 'FAILED' } } });
        if (all >= ALERT_EMAILS_ALL_PER_DAY) return { ok: false as const, skip: 'ALL_COMPANIES_CAP' as const };
        const sinceLast = last?.createdAt ?? new Date(now.getTime() - opts.everyMin * 60_000);
        // The first e-mail after the quiet hours leaves out what ended during them (L5).
        const endedSince = opts.quietEndedAt && opts.quietEndedAt > sinceLast ? opts.quietEndedAt : sinceLast;
        const found = await tx.$queryRaw<ClaimSqlRow[]>(claimSql(tenantId, now, opts.minSeverity, endedSince, opts.today, opts.dayStart));
        const rows: DigestRow[] = found
          .filter((r) => emailSeverityPasses(r.severity as AlertSeverity, opts.minSeverity))
          .map((r) => ({ ...r, severity: r.severity as AlertSeverity, tier: Number(r.tier), emailedTier: Number(r.emailedTier) }));
        if (!rows.length) return { ok: false as const, skip: 'NOTHING_NEW' as const };
        const digest = await tx.opsAlertDigest.create({
          data: {
            tenantId,
            createdAt: now,
            status: 'SENDING',
            alertCount: rows.length,
            highCount: rows.filter((r) => r.severity === 'HIGH').length,
            recipientCount: opts.recipients,
          },
          select: { id: true },
        });
        await tx.$executeRaw`UPDATE "OpsAlert" SET "emailedTier" = "tier", "emailedAt" = ${now}, "digestId" = ${digest.id}
          WHERE "tenantId" = ${tenantId} AND "id" IN (${Prisma.join(rows.map((r) => r.id))})`;
        return { ok: true as const, digestId: digest.id, rows };
      });
    },

    async depotLabels(tenantId, depotIds) {
      if (!depotIds.length) return new Map();
      const depots = await db.depot.findMany({ where: { tenantId, id: { in: depotIds } }, select: { id: true, code: true, name: true } });
      return new Map(depots.map((d) => [d.id, `${ONE_LINE(d.code)} ${ONE_LINE(d.name)}`.trim()]));
    },

    async finish(tenantId, digestId, rows, now, result) {
      await db.$transaction(async (tx) => {
        if (result.ok) {
          await tx.opsAlertDigest.update({ where: { id: digestId }, data: { status: 'SENT', sentAt: now } });
          await tx.opsAlert.updateMany({ where: { tenantId, digestId }, data: { emailError: null } });
          return;
        }
        await tx.opsAlertDigest.update({ where: { id: digestId }, data: { status: 'FAILED', error: result.error.slice(0, 200) } });
        // Each row back to the tier it had been e-mailed at before (0 = never): the next digest tries again.
        const byOld = new Map<number, string[]>();
        for (const r of rows) byOld.set(r.emailedTier, [...(byOld.get(r.emailedTier) ?? []), r.id]);
        for (const [emailedTier, ids] of byOld) {
          await tx.opsAlert.updateMany({
            where: { tenantId, digestId, id: { in: ids } },
            data: { emailedTier, emailAttempts: { increment: 1 }, emailError: result.error.slice(0, 200) },
          });
        }
      });
    },
  };
}

/**
 * Whether the company's e-mails of today reached ALERT_EMAILS_PER_DAY (the bell and the Alerts page say
 * so: alerts then show in RouteIQ only until tomorrow). `countSince` counts the company's digests that did
 * not fail, created since the given instant.
 */
export async function emailCapReached(countSince: (since: Date) => Promise<number>, now: Date, timezone: string): Promise<boolean> {
  return (await countSince(zonedDayStart(todayIso(timezone, now), timezone))) >= ALERT_EMAILS_PER_DAY;
}

/** The where of the digests the daily cap counts (sent or being sent since `since`). */
export const capWhere = (tenantId: string, since: Date): Prisma.OpsAlertDigestWhereInput => ({ tenantId, createdAt: { gte: since }, status: { not: 'FAILED' } });
