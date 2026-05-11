import { withTenantApi, ok, parseBody } from '@/lib/api';
import { truckSchema } from '@/lib/schemas';
import { audit } from '@/lib/audit';

export const GET = withTenantApi(async (_req, { db }) => {
  const trucks = await db.truck.findMany({
    orderBy: [{ active: 'desc' }, { code: 'asc' }],
    include: { depot: { select: { id: true, code: true, name: true } } },
  });
  return ok(trucks);
});

export const POST = withTenantApi(
  async (req, { db, user, ip }) => {
    const input = await parseBody(req, truckSchema);
    const depot = await db.depot.findUnique({ where: { id: input.depotId } });
    if (!depot) return ok({ error: 'Depot not found in this tenant' }, 400);
    const created = await db.truck.create({
      data: {
        tenantId: user.tenantId,
        code: input.code,
        description: input.description,
        depotId: input.depotId,
        capacityCases: input.capacityCases,
        capacityWeightKg: input.capacityWeightKg,
        capacityVolumeL: input.capacityVolumeL,
        fixedCostPerDay: input.fixedCostPerDay,
        costPerKm: input.costPerKm,
        active: input.active ?? true,
      },
    });
    await audit({
      tenantId: user.tenantId,
      userId: user.id,
      action: 'CREATE',
      entity: 'Truck',
      entityId: created.id,
      afterJson: created as never,
      ip,
    });
    return ok(created, 201);
  },
  { role: 'TENANT_ADMIN' },
);
