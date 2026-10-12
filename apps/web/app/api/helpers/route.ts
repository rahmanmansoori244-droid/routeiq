import { withTenantApi, ok, parseBody } from '@/lib/api';
import { helperSchema } from '@/lib/schemas';
import { audit } from '@/lib/audit';
import { HELPER_PUBLIC_SELECT } from '@/lib/dispatch/load-helpers';
import { codeTaken, withCodeCheck } from '@/lib/unique-code';

// Helpers (truck crew), owner request 13 Oct 2026: kept like drivers.

export const GET = withTenantApi(async (_req, { db }) => {
  // Every role reads this list (the plan screen's Helper(s) picker), as the drivers list.
  const helpers = await db.helper.findMany({ orderBy: [{ active: 'desc' }, { code: 'asc' }], select: HELPER_PUBLIC_SELECT });
  return ok(helpers);
});

// The dispatcher (PLANNER) adds helpers, as drivers. VIEWER: 403. A code already used: 409 CODE_TAKEN.
export const POST = withTenantApi(
  async (req, { db, user, ip }) => {
    const input = await parseBody(req, helperSchema);
    if (await db.helper.findFirst({ where: { code: input.code }, select: { id: true } })) throw codeTaken('Helper', input.code);
    const created = await withCodeCheck('Helper', input.code, () =>
      db.helper.create({
        data: { tenantId: user.tenantId, code: input.code, name: input.name, phone: input.phone ?? null, active: input.active ?? true },
        select: HELPER_PUBLIC_SELECT,
      }),
    );
    await audit({ tenantId: user.tenantId, userId: user.id, action: 'CREATE', entity: 'Helper', entityId: created.id, afterJson: created as never, ip });
    return ok(created, 201);
  },
  { role: 'PLANNER' },
);
