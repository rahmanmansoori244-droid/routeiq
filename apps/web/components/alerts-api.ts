'use client';

import { toast } from 'sonner';
import { api } from '@/app/t/[slug]/dispatch/client-api';
import { ackBody } from '@/lib/alerts/view';
import type { OpsAlertRow } from '@/lib/alerts/types';

/**
 * Acknowledge these rows (the open ones, each at the tier it was shown at: a row that became worse since
 * stays open). Says what happened; true when the request was answered.
 */
export async function acknowledgeAlerts(rows: OpsAlertRow[]): Promise<boolean> {
  const body = ackBody(rows);
  if (!body) return true;
  const r = await api<{ acked: number }>('/api/alerts/ack', { method: 'POST', json: body });
  if (!r.ok) {
    toast.error(r.error ?? 'Could not acknowledge the alerts.');
    return false;
  }
  const n = r.data?.acked ?? 0;
  const left = body.ids.length - n;
  if (left > 0) toast.warning(`${n} acknowledged. ${left} became worse or changed meanwhile and ${left === 1 ? 'stays' : 'stay'} open: have a look.`);
  else toast.success(n === 1 ? 'Alert acknowledged.' : `${n} alerts acknowledged.`);
  return true;
}

/** The cause & action dialog's fields (owner request 20 Oct 2026, lib/alerts/review.ts). */
export interface ReviewDraft {
  cause: string;
  causeOther: string;
  action: string;
  actionOther: string;
  note: string;
  followUp: boolean;
}

/** PATCH /api/alerts's answer, as the dialog handles it. */
export type ReviewAnswer =
  | { kind: 'saved'; row: OpsAlertRow; changed: boolean; also: string[]; skipped: { id: string; reason: string }[] }
  /** Someone saved (or removed) it meanwhile: the row as it is now; the draft stays. */
  | { kind: 'changed'; row: OpsAlertRow }
  /** The sweep held the alert rows: save again in a moment (the draft stays). */
  | { kind: 'busy'; message: string }
  /** The alert no longer exists (Start fresh, retention). */
  | { kind: 'gone' }
  /** Older than 90 days: read-only. */
  | { kind: 'locked'; message: string }
  | { kind: 'error'; message: string };

/** The body of a save: the codes, the texts when they apply, and the other alerts of the incident. */
export function reviewSaveBody(id: string, base: string | null, d: ReviewDraft, alsoIds: string[]) {
  return {
    id,
    baseReviewedAt: base,
    cause: d.cause,
    ...(d.cause === 'OTHER' ? { causeOther: d.causeOther } : {}),
    action: d.action,
    ...(d.action === 'OTHER' ? { actionOther: d.actionOther } : {}),
    note: d.note.trim() ? d.note : null,
    followUp: d.followUp,
    ...(alsoIds.length ? { alsoIds } : {}),
  };
}

type Saved = { row: OpsAlertRow; changed: boolean; also: string[]; skipped: { id: string; reason: string }[] };

async function patch(json: unknown): Promise<ReviewAnswer> {
  const r = await api<Saved>('/api/alerts', { method: 'PATCH', json });
  if (r.ok && r.data) return { kind: 'saved', row: r.data.row, changed: r.data.changed, also: r.data.also ?? [], skipped: r.data.skipped ?? [] };
  const code = r.errorBody?.code;
  if (r.status === 409 && code === 'REVIEW_CHANGED' && r.errorBody?.row) return { kind: 'changed', row: r.errorBody.row as OpsAlertRow };
  if (r.status === 409 && code === 'ALERT_BUSY') return { kind: 'busy', message: r.error ?? 'The alerts are being checked right now: save again in a moment.' };
  if (r.status === 409 && code === 'REVIEW_LOCKED') return { kind: 'locked', message: r.error ?? 'This alert can no longer be changed.' };
  if (r.status === 404) return { kind: 'gone' };
  return { kind: 'error', message: r.error ?? 'Could not save the cause & action.' };
}

/** Save the cause & action of an alert (PLANNER and up), naming the last save the editor saw. */
export function sendAlertReview(id: string, base: string | null, draft: ReviewDraft, alsoIds: string[] = []): Promise<ReviewAnswer> {
  return patch(reviewSaveBody(id, base, draft, alsoIds));
}

/** Remove a cause & action saved on the wrong alert. */
export function sendAlertReviewRemove(id: string, base: string): Promise<ReviewAnswer> {
  return patch({ id, baseReviewedAt: base, remove: true });
}
