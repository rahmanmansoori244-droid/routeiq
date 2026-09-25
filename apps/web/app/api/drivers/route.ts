import { withTenantApi, ok, parseBody } from '@/lib/api';
import { driverSchema } from '@/lib/schemas';
import { audit } from '@/lib/audit';
import { DRIVER_PUBLIC_SELECT } from '@/lib/driver-fields';

export const GET = withTenantApi(async (_req, { db }) => {
  // Every role reads this list (the plan screen's driver picker): never send the PIN hash.
  const drivers = await db.driver.findMany({
    orderBy: [{ active: 'desc' }, { code: 'asc' }],
    select: DRIVER_PUBLIC_SELECT,
  });
  return ok(drivers);
});

export const POST = withTenantApi(
  async (req, { db, user, ip }) => {
    const input = await parseBody(req, driverSchema);
    const created = await db.driver.create({
      data: { tenantId: user.tenantId, code: input.code, name: input.name, phone: input.phone, active: input.active ?? true },
      select: DRIVER_PUBLIC_SELECT,
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
