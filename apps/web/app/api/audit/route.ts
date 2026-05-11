import { withTenantApi, ok } from '@/lib/api';

const ALLOWED_ACTIONS = new Set([
  'CREATE', 'UPDATE', 'DELETE', 'OVERRIDE', 'DISPATCH',
  'LOGIN', 'SIGNUP', 'LOGOUT',
  'OPTIMIZE_STARTED', 'OPTIMIZE_SUCCEEDED', 'OPTIMIZE_FAILED',
  'SCENARIO_CHOSEN', 'BASELINE_UPLOADED', 'ROUTE_MANUALLY_CHANGED',
]);

export const GET = withTenantApi(async (req, { db }) => {
  const url = new URL(req.url);
  const action = url.searchParams.get('action') || undefined;
  const entity = url.searchParams.get('entity') || undefined;
  const from = url.searchParams.get('from') || undefined;
  const to = url.searchParams.get('to') || undefined;
  const userId = url.searchParams.get('userId') || undefined;
  const limit = Math.min(Number(url.searchParams.get('limit') ?? 200), 1000);

  const where: Record<string, unknown> = {};
  if (action && ALLOWED_ACTIONS.has(action)) where.action = action;
  if (entity) where.entity = entity;
  if (userId) where.userId = userId;
  if (from || to) {
    where.createdAt = {} as Record<string, Date>;
    if (from) (where.createdAt as Record<string, Date>).gte = new Date(from);
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
