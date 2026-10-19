import { z } from 'zod';
import type { Prisma } from '@prisma/client';
import { withTenantApi, ok, fail, parseBody, HttpError } from '@/lib/api';
import { audit } from '@/lib/audit';
import { DEFAULT_TZ, todayIso } from '@/lib/dispatch/time';
import { isLockBusy } from '@/lib/dispatch/plan-locks';
import {
  ALERT_ROW_USERS,
  REVIEW_ROW_SELECT,
  alertReviewCounts,
  listAlerts,
  readAlertListQuery,
  removeAlertReview,
  reviewAuditSubject,
  reviewAuditValue,
  saveAlertReview,
  storedReview,
  type ReviewRow,
  type ReviewSkipReason,
} from '@/lib/alerts/inbox';
import { alertSweepStatus } from '@/lib/alerts/sweep';
import { ALERT_REVIEW_BULK_MAX, ALERT_REVIEW_CODE_RE, normaliseReview, reviewFitsRule, sameReview } from '@/lib/alerts/review';
import { toOpsAlertRow } from '@/lib/alerts/types';
import type { TenantDb } from '@/lib/tenant';

export const dynamic = 'force-dynamic';

// GET /api/alerts?from=YYYY-MM-DD&to=YYYY-MM-DD (or date=)&depotId=&state=open|acked|resolved|all&rule=
// &review=all|missing|saved|followup - the operations alerts (owner request 16 Oct 2026) of the Alerts page and
// the day screen's Alerts card: today by default, at most 31 days, every state by default; open rows first, HIGH
// before WARN, at most 500 rows (`truncated`). Every role reads them, like the plan. `enabled`: alerts are
// switched on; checkedAt / checkStale / checkFailed: the company's last good sweep (review M2). Each row carries
// its cause & action (owner request 20 Oct 2026); `review=followup` lists the last 92 days whatever the dates
// (`listFrom` / `listTo`; the dates chosen are then not held to 31 days); `reviewCounts` counts the alerts of the
// dates chosen (Follow-up too), those with a cause & action and those saying Other, and the follow-ups of the last
// 92 days, each with the depot, rule and state chosen (lib/alerts/inbox.ts alertReviewCounts).
export const GET = withTenantApi(
  async (req, { db, user }) => {
    const cfg = await db.tenantConfig.findFirst({ select: { timezone: true, alertsEnabled: true, alertsEnabledAt: true } });
    const today = todayIso(cfg?.timezone ?? DEFAULT_TZ);
    const q = readAlertListQuery(new URL(req.url).searchParams, today);
    if (!q.ok) return fail(q.error, 400);
    const [{ rows, truncated }, reviewCounts] = await Promise.all([listAlerts(db, q.query), alertReviewCounts(db, q.query, today)]);
    const st = cfg?.alertsEnabled ? alertSweepStatus(user.tenantId, new Date(), cfg.alertsEnabledAt) : null;
    return ok({ enabled: !!cfg?.alertsEnabled, today, ...q.query, rows, truncated, reviewCounts, checkedAt: st?.checkedAt ?? null, checkStale: st?.stale ?? false, checkFailed: st?.failed ?? false });
  },
  { rateLimitKey: 'alerts' },
);

const id = z.string().min(1).max(64);
const code = z.string().regex(ALERT_REVIEW_CODE_RE, 'Unknown code.');
const base = z.string().datetime({ offset: true });
const text = (max: number) => z.string().max(max).nullish();
const patchSchema = z.union([
  z
    .object({
      id,
      // The last save the editor saw (null: none): another save since answers 409 REVIEW_CHANGED.
      baseReviewedAt: base.nullable(),
      cause: code,
      causeOther: text(400),
      action: code,
      actionOther: text(400),
      note: text(2000),
      followUp: z.boolean().optional(),
      // Other alerts of the same truck and day without a cause & action: filled with the same one (one incident).
      alsoIds: z.array(id).max(ALERT_REVIEW_BULK_MAX).optional(),
    })
    .strict(),
  z.object({ id, baseReviewedAt: base, remove: z.literal(true) }).strict(),
]);

const BUSY = 'The alerts are being checked right now: save again in a moment.';
const LOCKED = "This alert is older than 90 days: its details were removed and its cause & action can no longer be changed.";

async function readRow(db: TenantDb, alertId: string): Promise<ReviewRow | null> {
  return (await db.opsAlert.findFirst({ where: { id: alertId }, select: REVIEW_ROW_SELECT })) as ReviewRow | null;
}

async function rowAnswer(db: TenantDb, alertId: string) {
  const r = await db.opsAlert.findFirst({ where: { id: alertId }, include: ALERT_ROW_USERS });
  return r ? toOpsAlertRow(r) : null;
}

/** 409 REVIEW_CHANGED with the alert as it is now: the dialog keeps the draft and shows what was saved meanwhile. */
async function changed(db: TenantDb, alertId: string) {
  const row = await rowAnswer(db, alertId);
  if (!row) return fail('Not found.', 404);
  return fail({ message: 'Someone saved a cause & action for this alert meanwhile: check it, then save again to replace it.', code: 'REVIEW_CHANGED', row }, 409);
}

const iso = (d: Date | null) => (d ? d.toISOString() : null);

// PATCH /api/alerts { id, baseReviewedAt, cause, causeOther?, action, actionOther?, note?, followUp?, alsoIds? }
// | { id, baseReviewedAt, remove: true } - the cause & action of an operations alert (owner request 20 Oct 2026:
// "a place where a note / reason for the alert to have happened and the solution ... will help us gather data
// for what decisions are made when alerts are made"; lib/alerts/review.ts): what the office found after checking
// and what it decided, on an alert of any state and day (open, acknowledged, over, a day that ended), whether
// alerts are on or off. The dispatcher and up (PLANNER+); every role reads it on the rows of GET. The codes must be
// offered for the alert's rule (or be the ones it has: 400 REVIEW_CODE_NOT_FOR_RULE), Other needs its text (400
// REVIEW_OTHER_REQUIRED). The save names the last save the editor saw: another one since answers 409
// REVIEW_CHANGED with the row as it is. `alsoIds`: other alerts of the same truck and day WITHOUT a cause &
// action get the same one (one incident; one already saved, of another truck or day, or whose rule does not offer
// the codes is skipped and listed). A save that changes nothing writes nothing. `remove`: the cause & action goes
// (saved on the wrong alert). An alert whose details were removed after 90 days is read-only (409
// REVIEW_LOCKED). Another company's id answers 404. Never changes the alert itself (state, acknowledgement,
// e-mail). One audit row per alert written: ALERT_REVIEW_SAVED / ALERT_REVIEW_REMOVED with the version before and
// after (codes, follow-up, the free texts and their lengths: the history of an edit or a removal; the texts leave
// the audit rows 90 days after the alert's date, lib/alerts/inbox.ts scrubReviewAuditTexts). A save or a removal
// first waits for the company's alert and e-mail locks (inbox.ts lockForReview), so the sweep and the e-mail claim
// never meet its row locks.
export const PATCH = withTenantApi(
  async (req, { db, user }) => {
    const body = await parseBody(req, patchSchema);
    const row = await readRow(db, body.id);
    if (!row) return fail('Not found.', 404);
    if (row.detailsRemovedAt) throw new HttpError(LOCKED, 409, { code: 'REVIEW_LOCKED' });
    const stored = storedReview(row);

    try {
      if ('remove' in body) {
        if (!row.reviewedAt) return ok({ row: await rowAnswer(db, row.id), changed: false, also: [], skipped: [] });
        if (new Date(body.baseReviewedAt).getTime() !== row.reviewedAt.getTime()) return await changed(db, row.id);
        const r = await removeAlertReview({
          tenantId: user.tenantId,
          row,
          base: row.reviewedAt,
          afterRemove: (tx) =>
            audit(
              {
                tenantId: user.tenantId,
                userId: user.id,
                action: 'ALERT_REVIEW_REMOVED',
                entity: 'OpsAlert',
                entityId: row.id,
                beforeJson: { ...reviewAuditValue(stored), savedAt: iso(row.reviewedAt), byId: row.reviewedById } as Prisma.InputJsonValue,
                afterJson: reviewAuditSubject(row) as Prisma.InputJsonValue,
              },
              tx,
            ),
        });
        if (r === 'CHANGED') return await changed(db, row.id);
        return ok({ row: await rowAnswer(db, row.id), changed: true, also: [], skipped: [] });
      }

      const baseMs = body.baseReviewedAt === null ? null : new Date(body.baseReviewedAt).getTime();
      if (baseMs !== (row.reviewedAt?.getTime() ?? null)) return await changed(db, row.id);
      const n = normaliseReview(row.rule, body, stored);
      if (!n.ok) throw new HttpError(n.message, 400, { code: n.code, field: n.field });
      const value = n.value;

      // The other alerts of the incident: the same truck and day, none of their own, the codes offered for their rule.
      const skipped: { id: string; reason: ReviewSkipReason }[] = [];
      const alsoIds = [...new Set(body.alsoIds ?? [])].filter((x) => x !== row.id);
      const found = alsoIds.length
        ? ((await db.opsAlert.findMany({ where: { id: { in: alsoIds } }, select: REVIEW_ROW_SELECT })) as ReviewRow[])
        : [];
      const byId = new Map(found.map((a) => [a.id, a]));
      const also: ReviewRow[] = [];
      for (const aid of alsoIds) {
        const a = byId.get(aid);
        if (!a) skipped.push({ id: aid, reason: 'NOT_FOUND' });
        else if (a.truckId !== row.truckId || a.deliveryDate.getTime() !== row.deliveryDate.getTime()) skipped.push({ id: aid, reason: 'OTHER_TRUCK_OR_DAY' });
        else if (a.detailsRemovedAt) skipped.push({ id: aid, reason: 'DETAILS_REMOVED' });
        else if (a.reviewedAt) skipped.push({ id: aid, reason: 'ALREADY_SAVED' });
        else if (!reviewFitsRule(a.rule, value)) skipped.push({ id: aid, reason: 'NOT_FOR_RULE' });
        else also.push(a);
      }

      const unchanged = sameReview(stored, value);
      if (unchanged && !also.length) return ok({ row: await rowAnswer(db, row.id), changed: false, also: [], skipped });
      const r = await saveAlertReview({
        tenantId: user.tenantId,
        userId: user.id,
        row,
        value,
        base: row.reviewedAt ?? null,
        unchanged,
        also,
        afterSave: async (tx, saved) => {
          for (const s of saved) {
            const before = s.also ? null : stored;
            await audit(
              {
                tenantId: user.tenantId,
                userId: user.id,
                action: 'ALERT_REVIEW_SAVED',
                entity: 'OpsAlert',
                entityId: s.row.id,
                beforeJson: before ? ({ ...reviewAuditValue(before), savedAt: iso(row.reviewedAt), byId: row.reviewedById } as Prisma.InputJsonValue) : null,
                afterJson: {
                  ...reviewAuditSubject(s.row),
                  ...reviewAuditValue(s.value),
                  noteChanged: (before?.note ?? null) !== s.value.note,
                  groupId: s.groupId,
                  // Filled by the save of another alert of the same truck and day (one incident).
                  ...(s.also ? { savedWith: row.id } : {}),
                } as Prisma.InputJsonValue,
              },
              tx,
            );
          }
        },
      });
      if (r.result === 'CHANGED') return await changed(db, row.id);
      return ok({ row: await rowAnswer(db, row.id), changed: r.result === 'SAVED', also: r.also, skipped: [...skipped, ...r.skipped] });
    } catch (e) {
      if (isLockBusy(e)) throw new HttpError(BUSY, 409, { code: 'ALERT_BUSY' });
      throw e;
    }
  },
  { role: 'PLANNER', rateLimitKey: 'alerts' },
);
