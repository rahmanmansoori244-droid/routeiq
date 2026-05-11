import { withTenantApi, ok, parseBody } from '@/lib/api';
import { productSchema } from '@/lib/schemas';
import { audit } from '@/lib/audit';

export const GET = withTenantApi(async (_req, { db }) => {
  const products = await db.product.findMany({ orderBy: [{ active: 'desc' }, { code: 'asc' }] });
  return ok(products);
});

export const POST = withTenantApi(
  async (req, { db, user, ip }) => {
    const input = await parseBody(req, productSchema);
    const created = await db.product.create({
      data: {
        tenantId: user.tenantId,
        code: input.code,
        name: input.name,
        weightPerCaseKg: input.weightPerCaseKg,
        volumePerCaseL: input.volumePerCaseL,
        active: input.active ?? true,
      },
    });
    await audit({
      tenantId: user.tenantId,
      userId: user.id,
      action: 'CREATE',
      entity: 'Product',
      entityId: created.id,
      afterJson: created as never,
      ip,
    });
    return ok(created, 201);
  },
  { role: 'TENANT_ADMIN' },
);
