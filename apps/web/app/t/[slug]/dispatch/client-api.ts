'use client';

export interface ApiResult<T> {
  ok: boolean;
  status: number;
  data: T | null;
  error: string | null;
  errorBody: Record<string, unknown> | null;
}

/** fetch wrapper for the { data, error } envelope used by every RouteIQ API route. */
export async function api<T>(url: string, init?: RequestInit & { json?: unknown }): Promise<ApiResult<T>> {
  const { json, ...rest } = init ?? {};
  const res = await fetch(url, {
    ...rest,
    headers: json !== undefined ? { 'content-type': 'application/json', ...(rest.headers ?? {}) } : rest.headers,
    body: json !== undefined ? JSON.stringify(json) : rest.body,
    cache: 'no-store',
  });
  if (res.status === 401 && typeof window !== 'undefined') {
    // The server no longer accepts this session (signed out elsewhere, deactivated, password
    // reset, or the 12 h limit). Clear the cookie and go to sign-in instead of failing silently.
    window.location.assign('/api/auth/end-session');
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

export function hhmm(min: number | null | undefined): string {
  if (min === null || min === undefined) return '—';
  const m = Math.round(min);
  return `${String(Math.floor(m / 60) % 24).padStart(2, '0')}:${String(((m % 60) + 60) % 60).padStart(2, '0')}${m >= 1440 ? ' +1' : ''}`;
}

export function toMinutes(v: string): number | null {
  const s = v.trim();
  if (!s) return null;
  const m = /^(\d{1,2}):?(\d{2})$/.exec(s);
  if (!m) return NaN;
  return Number(m[1]) * 60 + Number(m[2]);
}

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
