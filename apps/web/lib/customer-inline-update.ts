/**
 * The Customers table's inline Active / Priority change (audit F24). The row changes at once
 * (optimistic); then one of three things happened:
 *
 * - SAVED: the server answered OK - the row takes the server's saved values;
 * - REFUSED: the server answered with an error - nothing was saved, the row goes back;
 * - UNKNOWN: no answer (offline, connection reset, a redeploy): the change may or may not have
 *   been saved. It is never sent again automatically (it may have been saved already); the row
 *   is reloaded from the server instead. If that fails too, the row goes back and is marked
 *   "not confirmed" until the page is reloaded, with an error saying so.
 *
 * Before, a request that never reached the server was not handled at all: the page switched to
 * its error card, or kept showing a change that was never saved.
 */
import { errorMessage } from './error-message';

export interface InlineUpdateDeps<R> {
  fetchImpl: typeof fetch;
  /** Replace the row on screen. */
  setRow: (row: R) => void;
  /** Mark the row as "not confirmed" (true) or confirmed again (false). */
  setUncertain: (uncertain: boolean) => void;
  notify: {
    success: (message: string) => void;
    error: (message: string) => void;
    warning: (message: string) => void;
  };
}

export type InlineUpdateResult = 'SAVED' | 'REFUSED' | 'RECONCILED' | 'UNKNOWN';

/** The server's values of the fields that were changed (the row keeps its other fields, e.g. the region name). */
function serverValues<R extends object>(row: R, patch: Partial<R>, server: unknown): R {
  if (!server || typeof server !== 'object') return row;
  const out = { ...row };
  for (const k of Object.keys(patch) as (keyof R)[]) {
    if (k in (server as object)) out[k] = (server as R)[k];
  }
  return out;
}

export const UNCONFIRMED_RELOADED =
  'No answer from the server: the change may not have been saved. The row now shows what the server has saved.';
export const UNCONFIRMED_UNKNOWN =
  'No answer from the server: the change may or may not have been saved. The row is marked "not confirmed" - reload the page to see what is saved.';

/**
 * Send one inline change of a customer (PATCH /api/customers/:id, never repeated) and put the
 * row in the state the server has. `before` is the row before the optimistic change.
 */
export async function runInlineUpdate<R extends { id: string }>(before: R, patch: Partial<R>, deps: InlineUpdateDeps<R>): Promise<InlineUpdateResult> {
  const url = `/api/customers/${before.id}`;
  let res: Response;
  try {
    res = await deps.fetchImpl(url, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(patch) });
  } catch {
    // UNKNOWN: reload the row (a GET is safe to repeat; the PATCH is not).
    try {
      const fresh = await deps.fetchImpl(url);
      if (!fresh.ok) throw new Error(String(fresh.status));
      const body = (await fresh.json()) as { data?: unknown };
      deps.setRow(serverValues(before, patch, body?.data));
      deps.setUncertain(false);
      deps.notify.error(UNCONFIRMED_RELOADED);
      return 'RECONCILED';
    } catch {
      deps.setRow(before);
      deps.setUncertain(true);
      deps.notify.error(UNCONFIRMED_UNKNOWN);
      return 'UNKNOWN';
    }
  }
  const body = (await res.json().catch(() => ({}))) as { data?: unknown };
  if (!res.ok) {
    deps.setRow(before);
    deps.setUncertain(false);
    deps.notify.error(errorMessage(body, 'Update failed: nothing was saved.'));
    return 'REFUSED';
  }
  deps.setRow(serverValues({ ...before, ...patch }, patch, body?.data));
  deps.setUncertain(false);
  deps.notify.success('Customer updated');
  const warning = (body?.data as { warning?: unknown } | undefined)?.warning;
  if (typeof warning === 'string') deps.notify.warning(warning);
  return 'SAVED';
}
