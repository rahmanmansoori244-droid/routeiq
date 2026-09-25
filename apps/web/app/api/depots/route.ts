import { withTenantApi, ok, parseBody } from '@/lib/api';
import { depotSchema } from '@/lib/schemas';
import { audit } from '@/lib/audit';

export const GET = withTenantApi(async (_req, { db }) => {
  const depots = await db.depot.findMany({
    orderBy: [{ active: 'desc' }, { code: 'asc' }],
    include: { _count: { select: { trucks: true, regions: true, runs: true } } },
  });
  return ok(depots);
});

export const POST = withTenantApi(
  async (req, { db, user, ip }) => {
    const input = await parseBody(req, depotSchema);
    const created = await db.depot.create({
      data: {
        tenantId: user.tenantId,
        code: input.code,
        name: input.name,
        lat: input.lat,
        lng: input.lng,
        address: input.address,
        openMin: input.openMin ?? null,
        closeMin: input.closeMin ?? null,
        active: input.active ?? true,
      },
    });
    await audit({
      tenantId: user.tenantId,
      userId: user.id,
      action: 'CREATE',
      entity: 'Depot',
      entityId: created.id,
      afterJson: created as never,
      ip,
    });
    return ok(created, 201);
  },
  { role: 'TENANT_ADMIN' },
);
