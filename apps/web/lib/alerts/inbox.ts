/**
 * Operations alerts in the app (owner request 16 Oct 2026; design PR-2 9.1 with the review's fixes H4,
 * L5, L10): what the bell, the day screen's Alerts card and the Alerts page read, and the acknowledgement.
 * Server only. Reads go through the tenant-scoped client; the acknowledgement is one UPDATE that names
 * the company and returns the rows it changed (the audit row lists them).
 *
 * States (lib/alerts/types.ts): OPEN needs someone to look (it counts on the bell), ACKED was seen,
 * RESOLVED is history. The bell counts the OPEN rows of the sweep's dates (yesterday, today, tomorrow):
 * an event of an older day that nobody acknowledged stays OPEN on the Alerts page, not on the bell.
 */
import { Prisma, type OpsAlert } from '@prisma/client';
import { prisma } from '../db';
import type { TenantDb } from '../tenant';
import { addDaysIso, dateOnly, daysBetween, todayIso } from '../dispatch/time';
import { isRealIsoDate } from '../schemas';
import {
  ALERT_ACK_MAX_IDS,
  ALERT_DAYS_AHEAD,
  ALERT_DAYS_BACK,
  ALERT_LATEST_COUNT,
  ALERT_MAX_TIER,
  SEVERITY_RANK,
  isAlertRule,
  type AlertRule,
} from './catalog';
import { toOpsAlertRow, type AlertState, type AlertSummary, type OpsAlertRow } from './types';
import { capWhere, emailCapReached } from './notify';

/** The Alerts page lists at most this many rows (open ones first). */
export const ALERT_LIST_MAX = 500;
/** The longest date range the Alerts page reads at once. */
export const ALERT_LIST_MAX_DAYS = 31;

export const ALERT_STATE_FILTERS = ['open', 'acked', 'resolved', 'all'] as const;
export type AlertStateFilter = (typeof ALERT_STATE_FILTERS)[number];

const STATE_RANK: Record<AlertState, number> = { OPEN: 0, ACKED: 1, RESOLVED: 2 };

/** Open first, then acknowledged, then history; HIGH before WARN (by rank, L5); the latest first. */
export function compareAlertRows(a: OpsAlertRow, b: OpsAlertRow): number {
  return (
    STATE_RANK[a.state] - STATE_RANK[b.state] ||
    SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] ||
    b.lastSeenAt.localeCompare(a.lastSeenAt) ||
    a.id.localeCompare(b.id)
  );
}

export interface AlertListQuery {
  from: string;
  to: string;
  depotId: string | null;
  state: AlertStateFilter;
  rule: AlertRule | null;
}

/** The Alerts page's filters from the URL: today by default, at most ALERT_LIST_MAX_DAYS days. */
export function readAlertListQuery(params: URLSearchParams, today: string): { ok: true; query: AlertListQuery } | { ok: false; error: string } {
  const from = params.get('from') || params.get('date') || today;
  const to = params.get('to') || params.get('date') || from;
  if (!isRealIsoDate(from) || !isRealIsoDate(to)) return { ok: false, error: 'Dates are YYYY-MM-DD.' };
  if (daysBetween(from, to) < 0) return { ok: false, error: 'The end date is before the start date.' };
  if (daysBetween(from, to) >= ALERT_LIST_MAX_DAYS) return { ok: false, error: `At most ${ALERT_LIST_MAX_DAYS} days at once.` };
  const state = (params.get('state') || 'all') as AlertStateFilter;
  if (!(ALERT_STATE_FILTERS as readonly string[]).includes(state)) return { ok: false, error: 'state is open, acked, resolved or all.' };
  const ruleRaw = params.get('rule');
  if (ruleRaw && !isAlertRule(ruleRaw)) return { ok: false, error: 'Unknown rule.' };
  const depotId = params.get('depotId') || params.get('depot') || null;
  return { ok: true, query: { from, to, depotId, state, rule: (ruleRaw as AlertRule | null) ?? null } };
}

function stateWhere(state: AlertStateFilter): Prisma.OpsAlertWhereInput {
  if (state === 'open') return { resolvedAt: null, ackedAt: null };
  if (state === 'acked') return { resolvedAt: null, ackedAt: { not: null } };
  if (state === 'resolved') return { resolvedAt: { not: null } };
  return {};
}

type RowWithUser = OpsAlert & { ackedBy: { name: string } | null };
const withUser = { ackedBy: { select: { name: true } } } as const;

/** The rows of the Alerts page (and the day screen's card: one date and depot). */
export async function listAlerts(db: TenantDb, q: AlertListQuery): Promise<{ rows: OpsAlertRow[]; truncated: boolean }> {
  const found = (await db.opsAlert.findMany({
    where: {
      deliveryDate: { gte: dateOnly(q.from), lte: dateOnly(q.to) },
      ...(q.depotId ? { depotId: q.depotId } : {}),
      ...(q.rule ? { rule: q.rule } : {}),
      ...stateWhere(q.state),
    },
    include: withUser,
    // Open and acknowledged rows before history, so a long history never pushes them out of the list.
    orderBy: [{ resolvedAt: { sort: 'desc', nulls: 'first' } }, { lastSeenAt: 'desc' }],
    take: ALERT_LIST_MAX + 1,
  })) as RowWithUser[];
  const rows = found.slice(0, ALERT_LIST_MAX).map(toOpsAlertRow).sort(compareAlertRows);
  return { rows, truncated: found.length > ALERT_LIST_MAX };
}

/** The sweep's dates (yesterday, today, tomorrow): the bell's window. */
export function bellWindow(today: string): { from: Date; to: Date } {
  return { from: dateOnly(addDaysIso(today, -ALERT_DAYS_BACK)), to: dateOnly(addDaysIso(today, ALERT_DAYS_AHEAD)) };
}

export const DISABLED_SUMMARY: AlertSummary = { enabled: false, open: 0, high: 0, latest: [], emailCapReached: false };

/** The bell: how many rows need attention, how many of them are HIGH, the newest ones (HIGH first). */
export async function alertSummary(
  db: TenantDb,
  tenantId: string,
  cfg: { alertsEnabled: boolean; timezone: string; alertEmails: string | null; alertEmailEveryMin: number },
  now: Date,
): Promise<AlertSummary> {
  if (!cfg.alertsEnabled) return DISABLED_SUMMARY;
  const w = bellWindow(todayIso(cfg.timezone, now));
  const open: Prisma.OpsAlertWhereInput = { deliveryDate: { gte: w.from, lte: w.to }, resolvedAt: null, ackedAt: null };
  const [count, high, highRows, warnRows] = await Promise.all([
    db.opsAlert.count({ where: open }),
    db.opsAlert.count({ where: { ...open, severity: 'HIGH' } }),
    db.opsAlert.findMany({ where: { ...open, severity: 'HIGH' }, include: withUser, orderBy: [{ lastSeenAt: 'desc' }], take: ALERT_LATEST_COUNT }),
    db.opsAlert.findMany({ where: { ...open, severity: { not: 'HIGH' } }, include: withUser, orderBy: [{ lastSeenAt: 'desc' }], take: ALERT_LATEST_COUNT }),
  ]);
  const latest = [...(highRows as RowWithUser[]), ...(warnRows as RowWithUser[])].map(toOpsAlertRow).sort(compareAlertRows).slice(0, ALERT_LATEST_COUNT);
  const mails = !!cfg.alertEmails && cfg.alertEmailEveryMin > 0;
  return { enabled: true, open: count, high, latest, emailCapReached: mails ? await emailCapReached((since) => db.opsAlertDigest.count({ where: capWhere(tenantId, since) }), now, cfg.timezone) : false };
}

/** POST /api/alerts/ack: the ids shown (with the tier each was shown at), or every open row of a date / depot. */
export type AckRequest = { ids: string[]; seen?: Record<string, number> } | { all: { date?: string; depotId?: string } };

export interface AckedRow {
  id: string;
  rule: string;
  deliveryDate: Date;
}

/** What runs inside the acknowledgement's transaction once the rows are changed (the audit row). */
export type AfterAck = (tx: Prisma.TransactionClient, acked: AckedRow[]) => Promise<unknown>;

/**
 * Acknowledge open rows in one statement. A row is acknowledged only while it is open (not resolved,
 * not acknowledged) and, when the screen said which tier it showed, only up to that tier: a row that
 * became worse after the screen read it (a higher tier clears the acknowledgement) is left open, so the
 * news is not hidden. Returns the rows it changed, and for ids how many of them belong to the company
 * (0: none of them, which the route answers 404, like any other company's id).
 */
export async function ackAlerts(tenantId: string, userId: string, req: AckRequest, now: Date, afterAck?: AfterAck): Promise<{ acked: AckedRow[]; known: number | null }> {
  return prisma.$transaction(async (tx) => {
    let acked: AckedRow[];
    let known: number | null = null;
    if ('ids' in req) {
      const ids = [...new Set(req.ids)].slice(0, ALERT_ACK_MAX_IDS);
      const seen = ids.map((id) => {
        const t = req.seen?.[id];
        return typeof t === 'number' && Number.isInteger(t) && t >= 1 && t <= ALERT_MAX_TIER ? t : ALERT_MAX_TIER;
      });
      known = await tx.opsAlert.count({ where: { tenantId, id: { in: ids } } });
      if (!known) return { acked: [], known };
      acked = await tx.$queryRaw<AckedRow[]>`
        UPDATE "OpsAlert" AS a SET "ackedAt" = ${now}, "ackedById" = ${userId}
        FROM (SELECT unnest(${ids}::text[]) AS "id", unnest(${seen}::int[]) AS "seen") AS s
        WHERE a."id" = s."id" AND a."tenantId" = ${tenantId} AND a."ackedAt" IS NULL AND a."resolvedAt" IS NULL AND a."tier" <= s."seen"
        RETURNING a."id", a."rule", a."deliveryDate"`;
    } else {
      const { date, depotId } = req.all;
      acked = await tx.$queryRaw<AckedRow[]>`
        UPDATE "OpsAlert" SET "ackedAt" = ${now}, "ackedById" = ${userId}
        WHERE "tenantId" = ${tenantId} AND "ackedAt" IS NULL AND "resolvedAt" IS NULL
          ${date ? Prisma.sql`AND "deliveryDate" = ${date}::date` : Prisma.empty}
          ${depotId ? Prisma.sql`AND "depotId" = ${depotId}` : Prisma.empty}
        RETURNING "id", "rule", "deliveryDate"`;
    }
    if (acked.length && afterAck) await afterAck(tx, acked);
    return { acked, known };
  });
}
