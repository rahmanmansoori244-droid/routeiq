import { withTenantApi, ok, parseBody } from '@/lib/api';
import { driverSchema } from '@/lib/schemas';
import { audit } from '@/lib/audit';

export const GET = withTenantApi(async (_req, { db }) => {
  // Every role reads this list (the plan screen's driver picker): never send the PIN hash.
  const drivers = await db.driver.findMany({
    orderBy: [{ active: 'desc' }, { code: 'asc' }],
    select: { id: true, tenantId: true, code: true, name: true, phone: true, active: true },
  });
  return ok(drivers);
});

export const POST = withTenantApi(
  async (req, { db, user, ip }) => {
    const input = await parseBody(req, driverSchema);
    const created = await db.driver.create({
      data: { tenantId: user.tenantId, code: input.code, name: input.name, phone: input.phone, active: input.active ?? true },
    });
    await audit({
      tenantId: user.tenantId,
      userId: user.id,
      action: 'CREATE',
      entity: 'Driver',
      entityId: created.id,
      afterJson: created as never,
      ip,
    });
    return ok(created, 201);
  },
  { role: 'TENANT_ADMIN' },
);
