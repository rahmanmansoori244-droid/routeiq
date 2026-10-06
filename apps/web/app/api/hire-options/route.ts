import { withTenantApi, ok, parseBody, fail } from '@/lib/api';
import { hireOptionSchema } from '@/lib/schemas';
import { audit } from '@/lib/audit';
import { historyOnlyDepotLinkMessage } from '@/lib/master-data-delete';

export const dynamic = 'force-dynamic';

// The trucks a company can rent for a day (owner request 6 Oct 2026, the hire suggestion), per depot.
// GET: any signed-in user (the plan screen says whether a depot has any). POST: company admin.
export const GET = withTenantApi(async (_req, { db }) => {
  const options = await db.hireOption.findMany({
    orderBy: [{ active: 'desc' }, { label: 'asc' }],
    include: { depot: { select: { id: true, code: true, name: true } } },
  });
  return ok(options);
});

export const POST = withTenantApi(
  async (req, { db, user, ip }) => {
    const input = await parseBody(req, hireOptionSchema);
    const depot = await db.depot.findUnique({ where: { id: input.depotId } });
    if (!depot) return fail('Depot not found in this tenant', 400);
    if (depot.historyOnly) return fail({ code: 'DEPOT_HISTORY_ONLY', message: historyOnlyDepotLinkMessage(depot.code, 'truck') }, 422);
    const created = await db.hireOption.create({
      data: {
        tenantId: user.tenantId,
        depotId: input.depotId,
        label: input.label,
        bays: input.bays ?? null,
        capacityCases: input.capacityCases ?? 0,
        payloadKg: input.payloadKg ?? 0,
        costPerDay: input.costPerDay,
        costPerKm: input.costPerKm ?? null,
        maxPerDay: input.maxPerDay ?? 1,
        active: input.active ?? true,
      },
    });
    await audit({ tenantId: user.tenantId, userId: user.id, action: 'CREATE', entity: 'HireOption', entityId: created.id, afterJson: created as never, ip });
    return ok(created, 201);
  },
  { role: 'TENANT_ADMIN' },
);
