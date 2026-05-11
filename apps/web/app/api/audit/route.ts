import { withTenantApi, ok, fail } from '@/lib/api';

const ALLOWED_ACTIONS = new Set([
  'CREATE', 'UPDATE', 'DELETE', 'OVERRIDE', 'DISPATCH',
  'LOGIN', 'SIGNUP', 'LOGOUT',
  'OPTIMIZE_STARTED', 'OPTIMIZE_SUCCEEDED', 'OPTIMIZE_FAILED',
  'SCENARIO_CHOSEN', 'BASELINE_UPLOADED', 'ROUTE_MANUALLY_CHANGED',
  'DRIVER_LOGIN', 'DELIVERY_PROOF_CREATED',
]);

function parseFilterDate(input: string | null | undefined): Date | undefined {
  if (!input) return undefined;
  const d = new Date(input);
  // Reject NaN dates so a typo (e.g. ?from=invalid) returns 400 instead of
  // silently matching every row (NaN compares as never, but the WHERE still
  // sees an invalid Date object and the behavior is provider-dependent).
  if (Number.isNaN(d.getTime())) return null as never;
  return d;
}

export const GET = withTenantApi(async (req, { db }) => {
  const url = new URL(req.url);
  const action = url.searchParams.get('action') || undefined;
  const entity = url.searchParams.get('entity') || undefined;
  const fromRaw = url.searchParams.get('from');
  const toRaw = url.searchParams.get('to');
  const userId = url.searchParams.get('userId') || undefined;
  const limit = Math.min(Number(url.searchParams.get('limit') ?? 200), 1000);

  const from = parseFilterDate(fromRaw);
  const to = parseFilterDate(toRaw);
  if ((fromRaw && from === null) || (toRaw && to === null)) {
    return fail('Invalid `from` or `to` date — use YYYY-MM-DD or ISO 8601.', 400);
  }

  const where: Record<string, unknown> = {};
  if (action && ALLOWED_ACTIONS.has(action)) where.action = action;
  if (entity) where.entity = entity;
  if (userId) where.userId = userId;
  if (from || to) {
    where.createdAt = {} as Record<string, Date>;
    if (from) (where.createdAt as Record<string, Date>).gte = from;
    if (to) {
      // Inclusive end-of-day: add 1 day, < boundary.
      const d = new Date(to);
      d.setDate(d.getDate() + 1);
      (where.createdAt as Record<string, Date>).lt = d;
    }
  }

  const rows = await db.auditLog.findMany({
    where: where as never,
    orderBy: { createdAt: 'desc' },
    take: limit,
    include: { user: { select: { id: true, name: true, email: true } } },
  });
  return ok(rows);
});
