import { z } from 'zod';
import { withTenantApi, ok, fail } from '@/lib/api';
import { redactForAudit } from '@/lib/audit';
import { AUDIT_ACTION_NAMES, AUDIT_ENTITY_NAMES } from '@/lib/audit-catalog';
import { isoDateSchema } from '@/lib/schemas';
import { addDaysIso, DEFAULT_TZ, zonedDayStart } from '@/lib/dispatch/time';

/**
 * The filters, all optional (review F23). An unknown action or entity is refused (400, with the
 * names that exist) instead of being dropped - which used to return every row as if it matched.
 * `from` / `to` are delivery-calendar days (YYYY-MM-DD) in the company timezone (Asia/Muscat):
 * from=2026-09-25 starts at 2026-09-25 00:00 Muscat, to=2026-09-25 ends at 24:00 Muscat.
 */
const querySchema = z
  .object({
    action: z.enum(AUDIT_ACTION_NAMES).optional(),
    entity: z.enum(AUDIT_ENTITY_NAMES).optional(),
    userId: z
      .string()
      .max(64)
      .regex(/^[A-Za-z0-9_-]+$/, 'Unknown user id')
      .optional(),
    from: isoDateSchema.optional(),
    to: isoDateSchema.optional(),
    limit: z.coerce.number().int().min(1).max(1000).optional(),
  })
  .strict();

// TENANT_ADMIN, like the Audit log page (reviews F15, F23): rows carry emails, IPs and master-data
// before/after values.
export const GET = withTenantApi(async (req, { db, user }) => {
  const url = new URL(req.url);
  const raw: Record<string, string> = {};
  for (const [k, v] of url.searchParams) if (v !== '') raw[k] = v;
  const parsed = querySchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.') || 'query'}: ${i.message}`);
    return fail({ error: `Invalid audit filter - ${issues.join('; ')}`, code: 'INVALID_FILTER', actions: AUDIT_ACTION_NAMES, entities: AUDIT_ENTITY_NAMES }, 400);
  }
  const q = parsed.data;
  if (q.from && q.to && q.to < q.from) return fail({ error: 'The "to" day is before the "from" day.', code: 'INVALID_FILTER' }, 400);

  const where: Record<string, unknown> = {};
  if (q.action) where.action = q.action;
  if (q.entity) where.entity = q.entity;
  if (q.userId) where.userId = q.userId;
  if (q.from || q.to) {
    const cfg = await db.tenantConfig.findUnique({ where: { tenantId: user.tenantId }, select: { timezone: true } });
    const tz = cfg?.timezone || DEFAULT_TZ;
    const createdAt: Record<string, Date> = {};
    if (q.from) createdAt.gte = zonedDayStart(q.from, tz);
    if (q.to) createdAt.lt = zonedDayStart(addDaysIso(q.to, 1), tz); // the whole "to" day
    where.createdAt = createdAt;
  }

  const rows = await db.auditLog.findMany({
    where: where as never,
    orderBy: { createdAt: 'desc' },
    take: q.limit ?? 200,
    include: { user: { select: { id: true, name: true, email: true } } },
  });
  // Older rows may still hold credential hashes (for example a driver PIN hash); never send them.
  return ok(rows.map((r) => ({ ...r, beforeJson: redactForAudit(r.beforeJson), afterJson: redactForAudit(r.afterJson) })));
}, { role: 'TENANT_ADMIN' });
