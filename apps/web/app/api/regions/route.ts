import { withTenantApi, ok, parseBody, fail } from '@/lib/api';
import { regionSchema } from '@/lib/schemas';
import { audit } from '@/lib/audit';

export const GET = withTenantApi(async (_req, { db }) => {
  const regions = await db.region.findMany({
    orderBy: { code: 'asc' },
    include: {
      depot: { select: { id: true, code: true, name: true } },
      _count: { select: { customers: true } },
    },
  });
  return ok(regions);
});

export const POST = withTenantApi(
  async (req, { db, user, ip }) => {
    const input = await parseBody(req, regionSchema);
    if (input.depotId) {
      const depot = await db.depot.findUnique({ where: { id: input.depotId } });
      if (!depot) return fail('Depot not found in this tenant', 400);
    }
    const created = await db.region.create({
      data: { tenantId: user.tenantId, code: input.code, name: input.name, depotId: input.depotId },
    });
    await audit({
      tenantId: user.tenantId,
      userId: user.id,
      action: 'CREATE',
      entity: 'Region',
      entityId: created.id,
      afterJson: created as never,
      ip,
    });
    return ok(created, 201);
  },
  { role: 'TENANT_ADMIN' },
);
