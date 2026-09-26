/**
 * The expected, user-facing failures of the plan service, with their HTTP status. Kept in their
 * own module so the lock helpers (plan-locks.ts) and the plan service can both use them without
 * a circular import. plan-service.ts re-exports PlanError.
 */
export class PlanError extends Error {
  constructor(message: string, public status = 400, public details?: unknown) {
    super(message);
  }
}

/**
 * The API error body for a PlanError: the message, plus a machine-readable `code` (and any other
 * detail fields) when the error carries them, e.g. { error, code: 'PLAN_BUSY' }.
 */
export function planErrorBody(e: PlanError): string | Record<string, unknown> {
  const d = e.details;
  if (d && typeof d === 'object' && !Array.isArray(d)) return { error: e.message, ...(d as Record<string, unknown>) };
  return e.message;
}
