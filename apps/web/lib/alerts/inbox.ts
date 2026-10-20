/**
 * Operations alerts in the app (owner request 16 Oct 2026; design PR-2 9.1 with the review's fixes H4,
 * L5, L10): what the bell, the day screen's Alerts card and the Alerts page read, and the acknowledgement.
 * Server only. Reads go through the tenant-scoped client; the acknowledgement is one UPDATE that names
 * the company and returns the rows it changed (the audit row lists them).
 *
 * States (lib/alerts/types.ts): OPEN needs someone to look (it counts on the bell), ACKED was seen,
 * RESOLVED is history. The bell counts the OPEN rows of today and tomorrow only (owner request 19 Oct 2026:
 * "the bell shows only today's open alerts"): the first sweep after midnight closes what is still open of
 * the day before (DAY_ENDED, store.ts), and between midnight and that sweep - or while the sweep is not
 * running - a row of yesterday is not counted either. One exception (review of the branch, 19 Oct 2026,
 * finding 2): yesterday's follow-up raised after this midnight (Load not closed for a load planned back
 * late: catalog.ts ALERT_AFTER_DAY_RULES) is open and counts, under its day ("Yesterday, 18 Oct"). Every day
 * stays on the Alerts page. The summary carries the company's today, so the bell labels another day's
 * alert with its day (view.ts alertWhen).
 */
import { Prisma, type OpsAlert } from '@prisma/client';
import { prisma, type AppPrismaClient } from '../db';
import type { TenantDb } from '../tenant';
import { addDaysIso, dateOnly, daysBetween, todayIso, zonedDayStart } from '../dispatch/time';
import { isRealIsoDate } from '../schemas';
import {
  ALERT_ACK_MAX_IDS,
  ALERT_AFTER_DAY_RULES,
  ALERT_DAYS_AHEAD,
  ALERT_DAYS_BACK,
  ALERT_LATEST_COUNT,
  ALERT_MAX_TIER,
  SEVERITY_RANK,
  isAlertRule,
  type AlertRule,
} from './catalog';
import { ALERT_ROW_USERS, toOpsAlertRow, type AlertState, type AlertSummary, type OpsAlertRow, type SweepCheck } from './types';
export { ALERT_ROW_USERS } from './types';
import { ALERT_FOLLOWUP_DAYS, charCount, type AlertReviewValue } from './review';
import { setLockTimeout } from '../dispatch/plan-locks';
import { capWhere, emailCapReached, lockTenantDigest } from './notify';
import { lockTenantAlerts } from './locks';

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

/**
 * The cause & action filter (owner request 20 Oct 2026, lib/alerts/review.ts): every alert, those without one,
 * those with one, and those that need follow-up. "followup" LISTS the last ALERT_FOLLOWUP_DAYS days (and
 * tomorrow) whatever dates were chosen, so a follow-up of five weeks ago is not lost (critique item 12); the
 * count line still counts the dates chosen (review of the branch, 20 Oct 2026, findings 3 and 9).
 */
export const ALERT_REVIEW_FILTERS = ['all', 'missing', 'saved', 'followup'] as const;
export type AlertReviewFilter = (typeof ALERT_REVIEW_FILTERS)[number];

export interface AlertListQuery {
  /** The dates chosen (the count line's "of these dates"). */
  from: string;
  to: string;
  /** The dates the list reads: the dates chosen, or the follow-up window with review=followup. */
  listFrom: string;
  listTo: string;
  depotId: string | null;
  state: AlertStateFilter;
  rule: AlertRule | null;
  review: AlertReviewFilter;
}

/** The dates the "followup" filter reads: the last ALERT_FOLLOWUP_DAYS days up to tomorrow. */
export function followUpWindow(today: string): { from: string; to: string } {
  return { from: addDaysIso(today, -(ALERT_FOLLOWUP_DAYS - 1)), to: addDaysIso(today, ALERT_DAYS_AHEAD) };
}

/**
 * The Alerts page's filters from the URL: today by default, at most ALERT_LIST_MAX_DAYS days. With
 * review=followup the list reads the follow-up window (listFrom / listTo) and the dates chosen only feed the
 * count line, so they are not held to the 31 days (they are still real dates in order).
 */
export function readAlertListQuery(params: URLSearchParams, today: string): { ok: true; query: AlertListQuery } | { ok: false; error: string } {
  const from = params.get('from') || params.get('date') || today;
  const to = params.get('to') || params.get('date') || from;
  if (!isRealIsoDate(from) || !isRealIsoDate(to)) return { ok: false, error: 'Dates are YYYY-MM-DD.' };
  if (daysBetween(from, to) < 0) return { ok: false, error: 'The end date is before the start date.' };
  const review = (params.get('review') || 'all') as AlertReviewFilter;
  if (!(ALERT_REVIEW_FILTERS as readonly string[]).includes(review)) return { ok: false, error: 'review is all, missing, saved or followup.' };
  if (review !== 'followup' && daysBetween(from, to) >= ALERT_LIST_MAX_DAYS) return { ok: false, error: `At most ${ALERT_LIST_MAX_DAYS} days at once.` };
  const state = (params.get('state') || 'all') as AlertStateFilter;
  if (!(ALERT_STATE_FILTERS as readonly string[]).includes(state)) return { ok: false, error: 'state is open, acked, resolved or all.' };
  const ruleRaw = params.get('rule');
  if (ruleRaw && !isAlertRule(ruleRaw)) return { ok: false, error: 'Unknown rule.' };
  const depotId = params.get('depotId') || params.get('depot') || null;
  const list = review === 'followup' ? followUpWindow(today) : { from, to };
  return { ok: true, query: { from, to, listFrom: list.from, listTo: list.to, depotId, state, rule: (ruleRaw as AlertRule | null) ?? null, review } };
}

function stateWhere(state: AlertStateFilter): Prisma.OpsAlertWhereInput {
  if (state === 'open') return { resolvedAt: null, ackedAt: null };
  if (state === 'acked') return { resolvedAt: null, ackedAt: { not: null } };
  if (state === 'resolved') return { resolvedAt: { not: null } };
  return {};
}

function reviewWhere(review: AlertReviewFilter): Prisma.OpsAlertWhereInput {
  if (review === 'missing') return { reviewedAt: null };
  if (review === 'saved') return { reviewedAt: { not: null } };
  if (review === 'followup') return { reviewFollowUp: true };
  return {};
}

type UserName = { name: string } | null;
type RowWithUser = OpsAlert & { ackedBy: UserName; reviewedBy?: UserName; reviewFirstBy?: UserName };
const withUser = ALERT_ROW_USERS;

/** The where of the dates `from`..`to` with the depot, rule and state chosen (no cause & action filter). */
function filterWhere(q: AlertListQuery, from: string, to: string): Prisma.OpsAlertWhereInput {
  return {
    deliveryDate: { gte: dateOnly(from), lte: dateOnly(to) },
    ...(q.depotId ? { depotId: q.depotId } : {}),
    ...(q.rule ? { rule: q.rule } : {}),
    ...stateWhere(q.state),
  };
}

/** The where of the list: its dates (the follow-up window with review=followup) and every filter. */
export function listWhere(q: AlertListQuery): Prisma.OpsAlertWhereInput {
  return { ...filterWhere(q, q.listFrom, q.listTo), ...reviewWhere(q.review) };
}

/** The rows of the Alerts page (and the day screen's card: one date and depot). */
export async function listAlerts(db: TenantDb, q: AlertListQuery): Promise<{ rows: OpsAlertRow[]; truncated: boolean }> {
  const found = (await db.opsAlert.findMany({
    where: listWhere(q),
    include: withUser,
    // Open and acknowledged rows before history, so a long history never pushes them out of the list.
    orderBy: [{ resolvedAt: { sort: 'desc', nulls: 'first' } }, { lastSeenAt: 'desc' }],
    take: ALERT_LIST_MAX + 1,
  })) as RowWithUser[];
  const rows = found.slice(0, ALERT_LIST_MAX).map(toOpsAlertRow).sort(compareAlertRows);
  return { rows, truncated: found.length > ALERT_LIST_MAX };
}

/**
 * The Alerts page's count line (critique item 12: counted on the server, not from the rows shown, which a
 * filter or the 500-row cap would make wrong): the alerts of the DATES CHOSEN with the depot, rule and state
 * chosen (whatever the cause & action filter, Follow-up included: review of the branch, 20 Oct 2026, findings 3
 * and 9), how many have a cause & action, how many of those say Other; and how many alerts need follow-up over
 * the last ALERT_FOLLOWUP_DAYS days with the same depot, rule and state (what the Follow-up filter lists).
 */
export interface AlertReviewCounts {
  alerts: number;
  saved: number;
  other: number;
  followUp: number;
}

export async function alertReviewCounts(db: TenantDb, q: AlertListQuery, today: string): Promise<AlertReviewCounts> {
  const base = filterWhere(q, q.from, q.to);
  const w = followUpWindow(today);
  const [alerts, saved, other, followUp] = await Promise.all([
    db.opsAlert.count({ where: base }),
    db.opsAlert.count({ where: { ...base, reviewedAt: { not: null } } }),
    db.opsAlert.count({ where: { ...base, OR: [{ reviewCause: 'OTHER' }, { reviewAction: 'OTHER' }] } }),
    db.opsAlert.count({ where: { ...filterWhere(q, w.from, w.to), reviewFollowUp: true } }),
  ]);
  return { alerts, saved, other, followUp };
}

/**
 * The bell's window: today and tomorrow (a load of tomorrow out already). Yesterday is no longer in it
 * (owner request 19 Oct 2026: before, the bell counted yesterday's open rows the whole of the next day,
 * shown with their time only, so they looked like today's).
 */
export function bellWindow(today: string): { from: Date; to: Date } {
  return { from: dateOnly(today), to: dateOnly(addDaysIso(today, ALERT_DAYS_AHEAD)) };
}

/**
 * The bell's open rows: those of bellWindow, and yesterday's follow-up raised after this midnight (review of
 * the branch, 19 Oct 2026, finding 2: Load not closed for a load planned back late, which the sweep raises
 * open for a day that is over: catalog.ts ALERT_AFTER_DAY_RULES; the bell shows it under "Yesterday, 18
 * Oct"). Every other row of yesterday is closed by the first sweep after midnight, and is not counted before
 * it either (it was raised before `todayStart`, the start of the company's today).
 */
export function bellOpenWhere(today: string, todayStart: Date): Prisma.OpsAlertWhereInput {
  const w = bellWindow(today);
  return {
    resolvedAt: null,
    ackedAt: null,
    OR: [
      { deliveryDate: { gte: w.from, lte: w.to } },
      { deliveryDate: dateOnly(addDaysIso(today, -ALERT_DAYS_BACK)), rule: { in: [...ALERT_AFTER_DAY_RULES] }, firstSeenAt: { gte: todayStart } },
    ],
  };
}

export const DISABLED_SUMMARY: AlertSummary = { enabled: false, open: 0, high: 0, latest: [], emailCapReached: false, checkedAt: null, checkStale: false, checkFailed: false };

/** The bell: how many rows need attention, how many of them are HIGH, the newest ones (HIGH first). */
export async function alertSummary(
  db: TenantDb,
  tenantId: string,
  cfg: { alertsEnabled: boolean; timezone: string; alertEmails: string | null; alertEmailEveryMin: number },
  now: Date,
  check: SweepCheck = { checkedAt: null, checkStale: false, checkFailed: false },
): Promise<AlertSummary> {
  if (!cfg.alertsEnabled) return DISABLED_SUMMARY;
  const today = todayIso(cfg.timezone, now);
  const open = bellOpenWhere(today, zonedDayStart(today, cfg.timezone));
  const [count, high, highRows, warnRows] = await Promise.all([
    db.opsAlert.count({ where: open }),
    db.opsAlert.count({ where: { ...open, severity: 'HIGH' } }),
    db.opsAlert.findMany({ where: { ...open, severity: 'HIGH' }, include: withUser, orderBy: [{ lastSeenAt: 'desc' }], take: ALERT_LATEST_COUNT }),
    db.opsAlert.findMany({ where: { ...open, severity: { not: 'HIGH' } }, include: withUser, orderBy: [{ lastSeenAt: 'desc' }], take: ALERT_LATEST_COUNT }),
  ]);
  const latest = [...(highRows as RowWithUser[]), ...(warnRows as RowWithUser[])].map(toOpsAlertRow).sort(compareAlertRows).slice(0, ALERT_LATEST_COUNT);
  const mails = !!cfg.alertEmails && cfg.alertEmailEveryMin > 0;
  return {
    enabled: true,
    today,
    open: count,
    high,
    latest,
    emailCapReached: mails ? await emailCapReached((since) => db.opsAlertDigest.count({ where: capWhere(tenantId, since) }), now, cfg.timezone) : false,
    ...check,
  };
}

/** POST /api/alerts/ack: the ids shown (with the tier each was shown at), or every open row of one date (and depot). */
export type AckRequest = { ids: string[]; seen?: Record<string, number> } | { all: { date: string; depotId?: string } };

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
        WHERE "tenantId" = ${tenantId} AND "ackedAt" IS NULL AND "resolvedAt" IS NULL AND "deliveryDate" = ${date}::date
          ${depotId ? Prisma.sql`AND "depotId" = ${depotId}` : Prisma.empty}
        RETURNING "id", "rule", "deliveryDate"`;
    }
    if (acked.length && afterAck) await afterAck(tx, acked);
    return { acked, known };
  });
}

// ---------------------------------------------------------------------------------------------
// Cause & action (owner request 20 Oct 2026, lib/alerts/review.ts): PATCH /api/alerts
// ---------------------------------------------------------------------------------------------

/** The columns a cause & action save reads of an alert (and audits). */
export const REVIEW_ROW_SELECT = {
  id: true,
  rule: true,
  deliveryDate: true,
  truckId: true,
  truckCode: true,
  loadNo: true,
  sequence: true,
  customerId: true,
  tier: true,
  occurrences: true,
  reviewCause: true,
  reviewCauseOther: true,
  reviewAction: true,
  reviewActionOther: true,
  reviewNote: true,
  reviewFollowUp: true,
  reviewFirstAt: true,
  reviewedAt: true,
  reviewedById: true,
  reviewGroupId: true,
  detailsRemovedAt: true,
} as const;

/** An alert as a save reads it (REVIEW_ROW_SELECT). */
export interface ReviewRow {
  id: string;
  rule: string;
  deliveryDate: Date;
  truckId: string;
  truckCode: string;
  loadNo: number | null;
  sequence: number | null;
  customerId: string | null;
  tier: number;
  occurrences: number;
  reviewCause: string | null;
  reviewCauseOther: string | null;
  reviewAction: string | null;
  reviewActionOther: string | null;
  reviewNote: string | null;
  reviewFollowUp: boolean;
  reviewFirstAt: Date | null;
  reviewedAt: Date | null;
  reviewedById: string | null;
  reviewGroupId: string | null;
  detailsRemovedAt: Date | null;
}

/** The stored cause & action of a row (null: none). */
export function storedReview(r: ReviewRow): AlertReviewValue | null {
  if (!r.reviewedAt || !r.reviewCause || !r.reviewAction) return null;
  return { cause: r.reviewCause, causeOther: r.reviewCauseOther, action: r.reviewAction, actionOther: r.reviewActionOther, note: r.reviewNote, followUp: r.reviewFollowUp };
}

/** Why another alert of a save that also fills others was left as it was. */
export type ReviewSkipReason = 'NOT_FOUND' | 'OTHER_TRUCK_OR_DAY' | 'ALREADY_SAVED' | 'NOT_FOR_RULE' | 'DETAILS_REMOVED';

/** One row a save wrote (the audit row's matter). */
export interface ReviewSaved {
  row: ReviewRow;
  value: AlertReviewValue;
  groupId: string | null;
  /** Filled by the save of another alert of the incident (never overwrites: it had none). */
  also: boolean;
}

/** What runs inside the save's transaction once the rows are written (one audit row per alert). */
export type AfterReviewSave = (tx: Prisma.TransactionClient, saved: ReviewSaved[]) => Promise<unknown>;

/** The time of a save: now, and always after the row's last save (reviewedAt only grows: the next save names it). */
export function reviewSaveTime(lastSave: Date | null, now: Date = new Date()): Date {
  return new Date(Math.max(now.getTime(), (lastSave?.getTime() ?? 0) + 1));
}

function reviewData(row: ReviewRow, value: AlertReviewValue, userId: string, at: Date, groupId: string | null): Prisma.OpsAlertUncheckedUpdateManyInput {
  return {
    reviewCause: value.cause,
    reviewCauseOther: value.causeOther,
    reviewAction: value.action,
    reviewActionOther: value.actionOther,
    reviewNote: value.note,
    reviewFollowUp: value.followUp,
    reviewedAt: at,
    reviewedById: userId,
    // The first save stays (its time and who); an edit adds a save.
    ...(row.reviewFirstAt ? {} : { reviewFirstAt: at, reviewFirstById: userId }),
    reviewSaves: { increment: 1 },
    reviewGroupId: groupId,
    // The alert as the office saw it: the screens and the export say when it came back, got worse or names another stop since.
    reviewTier: row.tier,
    reviewOccurrences: row.occurrences,
    reviewCustomerId: row.customerId,
  };
}

/**
 * The locks a cause & action save or removal takes BEFORE it writes a row (review of the branch, 20 Oct 2026,
 * finding 1), each waiting under the transaction's 5 s lock timeout (then 409 ALERT_BUSY):
 * - the company's alert lock (locks.ts): a sweep in flight finishes first, and a sweep that starts meanwhile
 *   skips the company to its next run (2 min), so the two never hold each other's rows in opposite orders (a
 *   deadlock that could abort the sweep's whole run);
 * - then the company's e-mail lock (notify.ts lockTenantDigest): a claim in flight finishes first, and a claim
 *   that starts meanwhile answers BUSY and creates no digest. Before, the claim's FOR UPDATE SKIP LOCKED
 *   skipped the rows the save held and could e-mail the others: an alert over by itself (ENDED, news in one
 *   e-mail only, the next claim reading only what ended after that digest) was then never e-mailed.
 * The order is the same everywhere (alert lock, then e-mail lock; the claim takes the e-mail lock alone, the
 * sweep and Start fresh the alert lock alone), so the locks never close a cycle.
 */
export async function lockForReview(tx: Prisma.TransactionClient, tenantId: string): Promise<void> {
  await lockTenantAlerts(tx, tenantId);
  await lockTenantDigest(tx, tenantId);
}

/**
 * Save the cause & action of `row` (and fill it into `also`, other alerts of the same truck and day without one:
 * one incident, critique item 1). One transaction with a 5 s lock wait (lockForReview, then the rows; held longer,
 * the route answers 409 ALERT_BUSY). The row is written only while its last save is still `base` (the one the
 * editor saw; 'CHANGED' otherwise, nothing written) and its details were not removed; an alert of `also` only while it has
 * none (never overwritten: skipped as ALREADY_SAVED). `unchanged`: the row's own cause & action is already this
 * one (only the others are filled; the row gets the incident's group id when it had none). Never touches the
 * alert itself (state, tier, acknowledgement, e-mail).
 */
export async function saveAlertReview(args: {
  tenantId: string;
  userId: string;
  row: ReviewRow;
  value: AlertReviewValue;
  base: Date | null;
  unchanged: boolean;
  also: ReviewRow[];
  now?: Date;
  afterSave: AfterReviewSave;
}): Promise<{ result: 'SAVED' | 'UNCHANGED' | 'CHANGED'; also: string[]; skipped: { id: string; reason: ReviewSkipReason }[] }> {
  const { tenantId, userId, row, value, base } = args;
  return prisma.$transaction(async (tx) => {
    await setLockTimeout(tx);
    await lockForReview(tx, tenantId);
    const at = reviewSaveTime(row.reviewedAt, args.now);
    const groupId = args.also.length ? (row.reviewGroupId ?? row.id) : (row.reviewGroupId ?? null);
    const saved: ReviewSaved[] = [];
    const guard = { tenantId, id: row.id, reviewedAt: base ?? null, detailsRemovedAt: null };
    if (!args.unchanged) {
      const n = (await tx.opsAlert.updateMany({ where: guard, data: reviewData(row, value, userId, at, groupId) })).count;
      if (!n) return { result: 'CHANGED' as const, also: [], skipped: [] };
      saved.push({ row, value, groupId, also: false });
    } else if (groupId !== (row.reviewGroupId ?? null)) {
      const n = (await tx.opsAlert.updateMany({ where: guard, data: { reviewGroupId: groupId } })).count;
      if (!n) return { result: 'CHANGED' as const, also: [], skipped: [] };
    }
    const skipped: { id: string; reason: ReviewSkipReason }[] = [];
    const filled: string[] = [];
    for (const a of args.also) {
      const n = (await tx.opsAlert.updateMany({ where: { tenantId, id: a.id, reviewedAt: null, detailsRemovedAt: null }, data: reviewData(a, value, userId, at, groupId) })).count;
      if (n) {
        saved.push({ row: a, value, groupId, also: true });
        filled.push(a.id);
      } else skipped.push({ id: a.id, reason: 'ALREADY_SAVED' });
    }
    if (saved.length) await args.afterSave(tx, saved);
    return { result: args.unchanged ? ('UNCHANGED' as const) : ('SAVED' as const), also: filled, skipped };
  });
}

/** Every cause & action column back to "none" (the database CHECK OpsAlert_review_whole allows only all of them). */
export const REVIEW_CLEARED = {
  reviewCause: null,
  reviewCauseOther: null,
  reviewAction: null,
  reviewActionOther: null,
  reviewNote: null,
  reviewFollowUp: false,
  reviewFirstAt: null,
  reviewFirstById: null,
  reviewedAt: null,
  reviewedById: null,
  reviewSaves: 0,
  reviewGroupId: null,
  reviewTier: null,
  reviewOccurrences: null,
  reviewCustomerId: null,
} as const satisfies Prisma.OpsAlertUncheckedUpdateManyInput;

/**
 * Remove a cause & action saved on the wrong alert (critique item 13), while its last save is still `base`
 * and its details were not removed: 'CHANGED' otherwise, nothing written. Audited by `afterRemove`. The same
 * locks as a save first (lockForReview).
 */
export async function removeAlertReview(args: { tenantId: string; row: ReviewRow; base: Date; afterRemove: (tx: Prisma.TransactionClient) => Promise<unknown> }): Promise<'REMOVED' | 'CHANGED'> {
  return prisma.$transaction(async (tx) => {
    await setLockTimeout(tx);
    await lockForReview(tx, args.tenantId);
    const n = (await tx.opsAlert.updateMany({ where: { tenantId: args.tenantId, id: args.row.id, reviewedAt: args.base, detailsRemovedAt: null }, data: REVIEW_CLEARED })).count;
    if (!n) return 'CHANGED' as const;
    await args.afterRemove(tx);
    return 'REMOVED' as const;
  });
}

/** The keys of a cause & action's free texts in its audit rows: removed 90 days after the alert's date (scrubReviewAuditTexts). */
export const REVIEW_AUDIT_TEXT_KEYS = ['causeOther', 'actionOther', 'note'] as const;

/**
 * A cause & action as the audit row keeps it: the codes, follow-up, the free texts (the Other texts and the note)
 * and the LENGTH of each. The texts are the history of an edit or a removal (owner request 20 Oct 2026: "editable,
 * history kept in the audit log"; review of the branch, finding 2: before only the lengths were kept, so an edit
 * lost the earlier note). They go 90 days after the alert's date, like the alert's own text and free texts
 * (scrubReviewAuditTexts, the nightly retention); the codes, follow-up and lengths stay. Null: none.
 */
export function reviewAuditValue(v: AlertReviewValue | null): Record<string, string | number | boolean | null> | null {
  if (!v) return null;
  return {
    cause: v.cause,
    action: v.action,
    followUp: v.followUp,
    causeOther: v.causeOther,
    actionOther: v.actionOther,
    note: v.note,
    causeOtherChars: v.causeOther ? charCount(v.causeOther) : null,
    actionOtherChars: v.actionOther ? charCount(v.actionOther) : null,
    noteChars: v.note ? charCount(v.note) : null,
  };
}

/** The audit actions whose rows carry a cause & action's free texts. */
export const REVIEW_AUDIT_ACTIONS = ['ALERT_REVIEW_SAVED', 'ALERT_REVIEW_REMOVED'] as const;

/**
 * The free texts of the cause & action audit rows of alerts dated before `cutoffIso` (the company's today - 90
 * days), removed (the nightly alert retention, lib/jobs/delivery-janitor.ts purgeOldAlerts): the note and the
 * Other texts leave the audit log when they leave the alert row. The row stays, with the codes, follow-up and
 * the texts' lengths. The alert's date is the `deliveryDate` its audit rows name (reviewAuditSubject). Only JSON
 * objects are touched (the same guard as migration 20260926090000). Returns the rows changed.
 */
export async function scrubReviewAuditTexts(db: Prisma.TransactionClient | AppPrismaClient, tenantId: string, cutoffIso: string): Promise<number> {
  const keys = [...REVIEW_AUDIT_TEXT_KEYS];
  const actions = [...REVIEW_AUDIT_ACTIONS];
  return db.$executeRaw`
    UPDATE "AuditLog"
    SET "beforeJson" = CASE WHEN jsonb_typeof("beforeJson") = 'object' THEN "beforeJson" - ${keys}::text[] ELSE "beforeJson" END,
        "afterJson" = CASE WHEN jsonb_typeof("afterJson") = 'object' THEN "afterJson" - ${keys}::text[] ELSE "afterJson" END
    WHERE "tenantId" = ${tenantId}
      AND "entity" = 'OpsAlert'
      AND "action" = ANY(${actions}::text[])
      AND jsonb_typeof("afterJson") = 'object'
      AND ("afterJson"->>'deliveryDate') < ${cutoffIso}
      AND (("afterJson" - ${keys}::text[]) <> "afterJson" OR (jsonb_typeof("beforeJson") = 'object' AND ("beforeJson" - ${keys}::text[]) <> "beforeJson"))`;
}

/** The alert an audit row of a cause & action is about (the codes and numbers that name it, never its text). */
export function reviewAuditSubject(r: ReviewRow): Record<string, string | number | null> {
  return { rule: r.rule, deliveryDate: r.deliveryDate.toISOString().slice(0, 10), truckCode: r.truckCode, loadNo: r.loadNo, sequence: r.sequence, tier: r.tier, occurrences: r.occurrences };
}
