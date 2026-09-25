/**
 * The expected, user-facing failures of the plan service, with their HTTP status. Kept in their
 * own module so the lock helpers (plan-locks.ts) and the plan service can both use them without
 * a circular import. plan-service.ts re-exports PlanError.
 *
 * PlanError is an HttpError (review L16): thrown anywhere under withTenantApi it answers with its
 * status and detail fields, with no try/catch in the route.
 */
import { HttpError, httpErrorBody } from '../http-error';

export class PlanError extends HttpError {
  constructor(message: string, status = 400, details?: Record<string, unknown>) {
    super(message, status, details);
    this.name = 'PlanError';
  }
}

/**
 * The API error body for a PlanError: the message, plus a machine-readable `code` (and any other
 * detail fields) when the error carries them, e.g. { error, code: 'PLAN_BUSY' }.
 */
export function planErrorBody(e: PlanError): string | Record<string, unknown> {
  return httpErrorBody(e);
}
