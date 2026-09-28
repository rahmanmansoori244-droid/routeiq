'use client';

import { endSessionUrl } from '@/lib/safe-redirect';

export interface ApiResult<T> {
  ok: boolean;
  status: number;
  data: T | null;
  error: string | null;
  errorBody: Record<string, unknown> | null;
}

/**
 * fetch wrapper for the { data, error } envelope used by every RouteIQ API route. It never rejects:
 * a request that does not reach the server (offline, a connection reset while the app is being
 * updated) answers { ok: false, status: 0 } with a message like any refused request. A rejected
 * promise skipped the caller's clean-up, so one network error left OPTIMIZE and every plan action
 * disabled until the page was reloaded (review of PR3).
 */
export async function api<T>(url: string, init?: RequestInit & { json?: unknown }): Promise<ApiResult<T>> {
  const { json, ...rest } = init ?? {};
  let res: Response;
  try {
    res = await fetch(url, {
      ...rest,
      headers: json !== undefined ? { 'content-type': 'application/json', ...(rest.headers ?? {}) } : rest.headers,
      body: json !== undefined ? JSON.stringify(json) : rest.body,
      cache: 'no-store',
    });
  } catch (e) {
    return { ok: false, status: 0, data: null, error: unreachable(e), errorBody: null };
  }
  if (res.status === 401 && typeof window !== 'undefined') {
    // The server no longer accepts this session (signed out elsewhere, deactivated, password
    // reset, or the 12 h limit). Clear the cookie and sign in again, then come back to this page
    // (same day and depot). The page is being replaced, so this call never settles: no caller
    // shows an "Unauthorized" error on the way out.
    window.location.assign(endSessionUrl(window.location.pathname + window.location.search));
    return new Promise<ApiResult<T>>(() => {});
  }
  const body = await res.json().catch(() => ({}));
  const err = body?.error ?? null;
  let message: string | null = null;
  let errorBody: Record<string, unknown> | null = null;
  if (typeof err === 'string') message = err;
  else if (err && typeof err === 'object') {
    errorBody = err as Record<string, unknown>;
    message =
      (typeof errorBody.message === 'string' && errorBody.message) ||
      (typeof errorBody.error === 'string' && errorBody.error) ||
      (errorBody.fieldErrors ? Object.values(errorBody.fieldErrors as Record<string, string[]>).flat().join(' ') : null) ||
      (Array.isArray(errorBody.formErrors) && (errorBody.formErrors as string[]).join(' ')) ||
      'Request failed';
  }
  return { ok: res.ok, status: res.status, data: res.ok ? (body?.data as T) : null, error: res.ok ? null : message ?? `HTTP ${res.status}`, errorBody };
}

/** The message for a request that never got an answer (status 0). */
function unreachable(e: unknown): string {
  return `The server could not be reached (${e instanceof Error && e.message ? e.message : 'network error'}). Check the connection and try again.`;
}

/** What the dispatcher explicitly accepted when optimizing or re-planning. */
export interface OptimizeOverrides {
  allowMissingLocations?: boolean;
  allowMissingWeights?: boolean;
}

/**
 * Where a missing case weight gets fixed, for the user's role: only company admins can edit
 * products, so planners and supervisors are told to ask one.
 */
export function weightFixText(canEditProducts: boolean): string {
  return canEditProducts ? 'add the case weight under Products' : 'ask a company admin to add the case weight under Products';
}

/**
 * The question before optimizing without some customers' locations, from the blocking list (A5 third
 * review): LOCATION_REQUIRED is a customer with no location (its orders are unserved as "location
 * missing"); INVALID_LOCATION is a saved point that cannot be used - LOW and never confirmed, outside
 * the delivery area and never confirmed, or 0,0 (unserved as "Invalid location", with what to fix).
 * The question used to call every one of them "no location ... location missing".
 */
function locationQuestion(blocking: { code?: unknown }[], verb: 'Optimize' | 'Re-plan'): string {
  const n = blocking.length;
  const missing = blocking.filter((b) => b.code === 'LOCATION_REQUIRED').length;
  const notUsable = n - missing;
  if (notUsable === 0) return `${n} customer(s) still have no location. Their orders will be UNSERVED with reason "location missing". ${verb} anyway?`;
  const who =
    missing === 0
      ? `${n} customer(s) have a saved location that cannot be used (not exact, outside the delivery area, or not valid).`
      : `${n} customer(s) have no usable location (${missing} missing, ${notUsable} not exact or not valid).`;
  return `${who} Their orders will be UNSERVED until the pin is placed on each one. ${verb} anyway?`;
}

/**
 * Optimize / re-plan answers that need the dispatcher's go-ahead (409 LOCATION_REQUIRED or
 * WEIGHT_REQUIRED): asks, and returns the override to send again, or null (not asked or declined).
 */
export function askOverride(errorBody: Record<string, unknown> | null, verb: 'Optimize' | 'Re-plan', opts: { canEditProducts?: boolean } = {}): OptimizeOverrides | null {
  if (errorBody?.code === 'LOCATION_REQUIRED') {
    const ok = window.confirm(locationQuestion((errorBody.blocking as { code?: unknown }[] | undefined) ?? [], verb));
    return ok ? { allowMissingLocations: true } : null;
  }
  if (errorBody?.code === 'WEIGHT_REQUIRED') {
    const list = (errorBody.unknownWeights as { productCode: string; lines: number; cases: number }[] | undefined) ?? [];
    const lines = list.reduce((a, u) => a + u.lines, 0);
    const skus = list.slice(0, 8).map((u) => `${u.productCode} (${u.cases} cases)`).join(', ') + (list.length > 8 ? ', ...' : '');
    const ok = window.confirm(
      `${lines} order line(s) have no weight: ${skus}.\nTruck payloads cannot be checked for them, so a load may be heavier than shown.\n\nCancel, and ${weightFixText(!!opts.canEditProducts)} - or ${verb.toLowerCase()} anyway (treated as 0 kg)?`,
    );
    return ok ? { allowMissingWeights: true } : null;
  }
  return null;
}

export function hhmm(min: number | null | undefined): string {
  if (min === null || min === undefined) return '—';
  const m = Math.round(min);
  return `${String(Math.floor(m / 60) % 24).padStart(2, '0')}:${String(((m % 60) + 60) % 60).padStart(2, '0')}${m >= 1440 ? ' +1' : ''}`;
}

// Times typed on the dispatch screen are read with parseHhmm (lib/dispatch/time.ts) only: the lax
// toMinutes that stood here read "06:90" as 07:30 (audit F07).

export function durH(min: number): string {
  return `${Math.floor(min / 60)}:${String(Math.round(min % 60)).padStart(2, '0')}`;
}

export const PRIORITY_LABEL: Record<number, string> = { 1: 'P1 highest', 2: 'P2', 3: 'P3', 4: 'P4', 5: 'P5 lowest' };

export const CUSTOMER_TYPES = ['HYPERMARKET', 'SUPERMARKET', 'TRADING', 'CATERING', 'HORECA', 'GROCERY', 'WHOLESALE', 'OTHER'] as const;

export const REASON_TEXT: Record<string, string> = {
  MISSING_COORDINATES: 'Location missing',
  INVALID_LOCATION: 'Invalid location',
  UNKNOWN_CUSTOMER: 'Unknown customer',
  UNKNOWN_PRODUCT: 'Unknown product',
  EXCEEDS_ANY_TRUCK_CAPACITY: 'Bigger than any truck',
  INVALID_CUSTOMER: 'Customer deactivated',
  EXCEEDS_TRUCK_CAPACITY: 'Bigger than any truck',
  NO_AVAILABLE_TRUCK: 'No truck available',
  HARD_WINDOW_INFEASIBLE: 'Receiving hours cannot be met',
  SHIFT_LIMIT: 'Does not fit the shift',
  SHIFT_TIME_LIMIT: 'Does not fit the shift',
  TRIP_LIMIT: 'Trucks out of loads',
  LOCKED_PLAN_CONFLICT: 'Conflicts with locked loads',
  LATE_ORDER_NO_CAPACITY: 'Late order - no capacity left',
  // One code for fleet shortage, not placed by the time-limited search and left out for loading
  // time: the message under the label says which (the label must be true for all three).
  SOLVER_DROPPED_LOW_PRIORITY: 'Not planned by the optimizer - see reason',
  ROUTING_PROVIDER_FAILURE: 'Road routing failed',
  INFEASIBLE: 'No feasible plan',
  INFEASIBLE_ROUTE: 'No feasible plan',
  UNKNOWN: 'Unknown',
};
