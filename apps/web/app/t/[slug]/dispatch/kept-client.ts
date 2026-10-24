'use client';

/**
 * The screens' calls for the kept-load warning (lib/dispatch/kept-changes.ts): the report read fresh
 * right before a re-plan's dialog (a READY plan does not poll), and the unlock from the warning - the
 * existing per-load Unlock, one load at a time, latest first, stopping at the first refusal.
 */
import { api } from './client-api';
import { unlockKeptLoads, type KeptLoadRef, type KeptReport } from '@/lib/dispatch/kept-changes';

/** The version's kept-load report; null when there is none, or it could not be read (never blocks a re-plan). */
export async function readKept(runId: string): Promise<KeptReport | null> {
  const r = await api<KeptReport | null>(`/api/runs/${runId}/kept-changes`);
  return r.ok && r.data && Array.isArray(r.data.loads) ? r.data : null;
}

/** Put `loads` back to Planned from the warning (the LOAD_PLANNED audit row says so: `via`). */
export function unlockKept(runId: string, loads: readonly KeptLoadRef[]) {
  return unlockKeptLoads(loads, (l) => api(`/api/runs/${runId}/loads/${l.loadId}`, { method: 'PATCH', json: { status: 'PLANNED', via: 'KEPT_DATA_CHANGED' } }));
}
