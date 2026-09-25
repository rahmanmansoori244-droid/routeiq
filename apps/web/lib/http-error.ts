/**
 * An expected, user-facing failure with its HTTP status (review L16). Throw it - or a subclass:
 * PlanError, RouteAdjustError, BatchRaceError - anywhere under withTenantApi and the caller gets
 * `{ data: null, error }` with that status instead of a 500; `details` (an object, e.g. a
 * machine-readable `code`) is merged into the error object. Anything else that is thrown is an
 * unexpected fault: 500 "Internal server error", its message never sent to the client.
 *
 * Its own module with no dependencies, so domain code (lib/dispatch/*) can use it without pulling
 * in the auth and database layers of lib/api.ts, which re-exports it.
 */
export class HttpError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

/** The API error body of an HttpError: its message, plus its detail fields when it has any. */
export function httpErrorBody(e: HttpError): string | Record<string, unknown> {
  const d = e.details;
  return d && typeof d === 'object' && !Array.isArray(d) && Object.keys(d).length ? { error: e.message, ...d } : e.message;
}
