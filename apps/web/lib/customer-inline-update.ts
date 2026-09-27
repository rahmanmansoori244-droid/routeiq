/**
 * The Customers table's inline Active / Priority change (audit F24). The row changes at once
 * (optimistic); then one of three things happened:
 *
 * - SAVED: the server answered OK - the row takes the server's saved values;
 * - REFUSED: the app refused it (a 4xx answer with the app's JSON error: not allowed, invalid,
 *   not found, a conflict) - nothing was saved, the row goes back and the app's message is shown;
 * - NOT CONFIRMED: no answer (offline, connection reset), a server error (5xx: the app, or the
 *   proxy in front of it during a redeploy or a timeout) or an answer that is not the app's JSON.
 *   The change may or may not have been saved: the customer PATCH stores the change before it
 *   writes the audit entry and counts open orders, and a gateway can time out after the app saved.
 *   It is never sent again automatically (it may have been saved already); the row is reloaded
 *   from the server instead (RECONCILED). If that fails too, the row goes back and is marked
 *   "not confirmed" until the page is reloaded, with an error saying so (UNKNOWN). The message
 *   never says "nothing was saved" in these cases.
 *
 * Before, a request that never reached the server was not handled at all: the page switched to
 * its error card, or kept showing a change that was never saved. And a 5xx was taken as a refusal:
 * the row went back with "nothing was saved" although the server had saved it.
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

/** Why the change is not confirmed: no answer at all, or an answer that does not say what happened. */
export const NO_ANSWER = 'No answer from the server';
export function serverErrorCause(status: number): string {
  return `The server answered with an error (${status})`;
}
export function unreadableAnswerCause(status: number): string {
  return `The server's answer could not be read (${status})`;
}

export function unconfirmedReloaded(cause: string): string {
  return `${cause}: the change may or may not have been saved. The row now shows what the server has saved.`;
}
export function unconfirmedUnknown(cause: string): string {
  return `${cause}: the change may or may not have been saved. The row is marked "not confirmed" - reload the page to see what is saved.`;
}
export const UNCONFIRMED_RELOADED = unconfirmedReloaded(NO_ANSWER);
export const UNCONFIRMED_UNKNOWN = unconfirmedUnknown(NO_ANSWER);

/** The body as JSON, or `undefined` when it is not JSON (an HTML error page from a proxy, an empty body). */
async function jsonOrUndefined(res: Response): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    return undefined;
  }
}

/** The app always answers `{ data, error }`; anything else did not come from it. */
function isAppEnvelope(body: unknown): body is { data?: unknown; error?: unknown } {
  return !!body && typeof body === 'object' && ('data' in body || 'error' in body);
}

/**
 * Send one inline change of a customer (PATCH /api/customers/:id, never repeated) and put the
 * row in the state the server has. `before` is the row before the optimistic change.
 */
export async function runInlineUpdate<R extends { id: string }>(before: R, patch: Partial<R>, deps: InlineUpdateDeps<R>): Promise<InlineUpdateResult> {
  const url = `/api/customers/${before.id}`;

  // NOT CONFIRMED: reload the row (a GET is safe to repeat; the PATCH is not).
  const reconcile = async (cause: string): Promise<InlineUpdateResult> => {
    try {
      const fresh = await deps.fetchImpl(url);
      if (!fresh.ok) throw new Error(String(fresh.status));
      const data = ((await fresh.json()) as { data?: unknown } | null)?.data;
      // Only a row that carries every changed field says what is saved.
      if (!data || typeof data !== 'object' || !Object.keys(patch).every((k) => k in data)) throw new Error('no row');
      deps.setRow(serverValues(before, patch, data));
      deps.setUncertain(false);
      deps.notify.error(unconfirmedReloaded(cause));
      return 'RECONCILED';
    } catch {
      deps.setRow(before);
      deps.setUncertain(true);
      deps.notify.error(unconfirmedUnknown(cause));
      return 'UNKNOWN';
    }
  };

  let res: Response;
  try {
    res = await deps.fetchImpl(url, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(patch) });
  } catch {
    return reconcile(NO_ANSWER);
  }
  const body = await jsonOrUndefined(res);
  // A 5xx does not mean nothing was saved, and an answer that is not the app's JSON (a proxy's
  // HTML page, an empty body) says nothing about what the app did: read what the server has.
  if (res.status >= 500) return reconcile(serverErrorCause(res.status));
  if (!isAppEnvelope(body)) return reconcile(unreadableAnswerCause(res.status));
  if (!res.ok) {
    // REFUSED: the app answered 4xx before storing anything.
    deps.setRow(before);
    deps.setUncertain(false);
    deps.notify.error(errorMessage(body, 'Update failed: nothing was saved.'));
    return 'REFUSED';
  }
  deps.setRow(serverValues({ ...before, ...patch }, patch, body.data));
  deps.setUncertain(false);
  deps.notify.success('Customer updated');
  const warning = (body.data as { warning?: unknown } | null | undefined)?.warning;
  if (typeof warning === 'string') deps.notify.warning(warning);
  return 'SAVED';
}
