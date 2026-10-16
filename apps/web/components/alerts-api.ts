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
