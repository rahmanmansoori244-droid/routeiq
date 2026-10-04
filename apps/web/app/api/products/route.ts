import { withTenantApi, ok, parseBody, fail } from '@/lib/api';
import { productSchema } from '@/lib/schemas';
import { audit } from '@/lib/audit';
import { twinsOf } from '@/lib/product-code';

export const GET = withTenantApi(async (_req, { db }) => {
  const products = await db.product.findMany({ orderBy: [{ active: 'desc' }, { code: 'asc' }] });
  return ok(products);
});

export const POST = withTenantApi(
  async (req, { db, user, ip }) => {
    const input = await parseBody(req, productSchema);
    // One product whatever the letter case of its code (the order intake matches it that way), and
    // whatever the spacing it was saved with. Matched on the code in the program: the database's
    // case-insensitive equals is an ILIKE, which reads "_" as "any character" (lib/product-code.ts).
    const twin = twinsOf(await db.product.findMany({ select: { id: true, code: true } }), input.code)[0];
    if (twin) return fail(`Product ${twin.code} already exists (codes are the same whatever the letter case).`, 409);
    const created = await db.product.create({
      data: {
        tenantId: user.tenantId,
        code: input.code,
        name: input.name,
        weightPerCaseKg: input.weightPerCaseKg,
        volumePerCaseL: input.volumePerCaseL,
        // The ERP pallet factor (owner decision 4 Oct 2026); not set = null.
        casesPerPallet: input.casesPerPallet ?? null,
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
