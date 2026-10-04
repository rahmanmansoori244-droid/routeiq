import { z } from 'zod';
import { withTenantApi, ok, fail, parseBody } from '@/lib/api';
import { prisma } from '@/lib/db';
import { isoDateSchema, isRealIsoDate } from '@/lib/schemas';
import { previewStartFresh, runStartFresh, START_FRESH_LIMITS } from '@/lib/start-fresh';
import { startFreshConfirmMatches } from '@/lib/start-fresh-text';

/**
 * "Start fresh (remove test data)" (owner request 4 Oct 2026): a company admin removes the
 * company's test orders, plans and delivery results before the pilot (lib/start-fresh.ts). Company
 * admins only (TENANT_ADMIN; a platform admin on their own company): never the dispatcher. Both
 * act on the signed-in user's own company.
 *
 * GET ?before=YYYY-MM-DD (optional): the preview - what would be removed and kept, and what
 * refuses the run now. Changes nothing.
 */
export const GET = withTenantApi(
  async (req, { user }) => {
    const before = new URL(req.url).searchParams.get('before') || null;
    if (before && !isRealIsoDate(before)) return fail({ error: 'Use a real date as YYYY-MM-DD.', code: 'BAD_DATE' }, 400);
    return ok(await previewStartFresh(user.tenantId, before));
  },
  { role: 'TENANT_ADMIN', rateLimitKey: 'start-fresh-preview', rateLimitLimit: START_FRESH_LIMITS.preview.limit, rateLimitWindowMs: START_FRESH_LIMITS.preview.windowMs },
);

const runSchema = z
  .object({
    /** The company code (slug), typed by the admin. */
    confirm: z.string().max(64),
    /** null / absent: everything; else only data with a delivery date before this day. */
    before: isoDateSchema.nullable().optional(),
    /** The admin ticked "I have taken a Railway backup". */
    backupConfirmed: z.literal(true, { errorMap: () => ({ message: 'Take a Railway backup first, then tick that you did.' }) }),
  })
  .strict();

/**
 * POST { confirm, before?, backupConfirmed: true }: run it. 400 CONFIRM_MISMATCH when the typed code
 * is not the company's; 409 (nothing removed) while an optimization is queued or running, when the
 * date would split a Bring forward or a plan, or when orders or plans are being changed right now.
 * The answer is what was removed and kept; the audit log gets one TEST_DATA_CLEARED row.
 */
export const POST = withTenantApi(
  async (req, { user, ip }) => {
    const body = await parseBody(req, runSchema);
    const tenant = await prisma.tenant.findUnique({ where: { id: user.tenantId }, select: { slug: true } });
    if (!tenant) return fail('Tenant not found', 404);
    if (!startFreshConfirmMatches(body.confirm, tenant.slug)) {
      return fail({ error: `Type the company code ${tenant.slug} to confirm. Nothing was removed.`, code: 'CONFIRM_MISMATCH' }, 400);
    }
    return ok(await runStartFresh(user.tenantId, body.before ?? null, { id: user.id, name: user.name, email: user.email }, ip));
  },
  { role: 'TENANT_ADMIN', rateLimitKey: 'start-fresh', rateLimitLimit: START_FRESH_LIMITS.run.limit, rateLimitWindowMs: START_FRESH_LIMITS.run.windowMs },
);
