import { withTenantApi, ok, parseBody, notFoundIfNull, fail } from '@/lib/api';
import { productSchema } from '@/lib/schemas';
import { audit } from '@/lib/audit';
import { caseWeightChangedNote, deactivateWarning, openMasterWeighedLines, openOrders } from '@/lib/dispatch/open-orders';

interface Params { params: { id: string } }

export const PATCH = (req: Request, { params }: Params) =>
  withTenantApi(
    async (r, { db, user, ip }) => {
      const before = notFoundIfNull(await db.product.findUnique({ where: { id: params.id } }));
      const input = await parseBody(r, productSchema.partial());
      if (input.code !== undefined && input.code !== before.code) {
        const twin = await db.product.findFirst({ where: { code: { equals: input.code, mode: 'insensitive' }, id: { not: before.id } }, select: { code: true } });
        if (twin) return fail(`Product ${twin.code} already exists (codes are the same whatever the letter case).`, 409);
      }
      const after = await db.product.update({ where: { id: params.id }, data: input });
      await audit({
        tenantId: user.tenantId,
        userId: user.id,
        action: 'UPDATE',
        entity: 'Product',
        entityId: after.id,
        beforeJson: before as never,
        afterJson: after as never,
        ip,
      });
      // A deactivated product's open orders are still delivered as ordered (warned here).
      const deactivated = before.active && !after.active ? deactivateWarning('product', await openOrders(user.tenantId, { productId: after.id })) : null;
      // A new or corrected case weight reaches the open lines weighed from it at the next
      // optimize or re-plan (say how many, so a correction is not expected to show at once).
      const weightNote =
        after.weightPerCaseKg > 0 && after.weightPerCaseKg !== before.weightPerCaseKg ? caseWeightChangedNote(await openMasterWeighedLines(user.tenantId, after.id)) : null;
      const warning = [deactivated, weightNote].filter(Boolean).join(' ') || null;
      return ok(warning ? { ...after, warning } : after);
    },
    { role: 'TENANT_ADMIN' },
  )(req);

export const DELETE = (req: Request, { params }: Params) =>
  withTenantApi(
    async (_r, { db, user, ip }) => {
      const before = notFoundIfNull(await db.product.findUnique({ where: { id: params.id } }));
      const usage = await db.orderLine.count({ where: { productId: params.id } });
      if (usage > 0) {
        const after = await db.product.update({ where: { id: params.id }, data: { active: false } });
        await audit({
          tenantId: user.tenantId,
          userId: user.id,
          action: 'UPDATE',
          entity: 'Product',
          entityId: after.id,
          beforeJson: before as never,
          afterJson: { ...(after as object), softDeleted: true } as never,
          ip,
        });
        const warning = before.active ? deactivateWarning('product', await openOrders(user.tenantId, { productId: after.id })) : null;
        return ok({ softDeleted: true, product: after, ...(warning ? { warning } : {}) });
      }
      await db.product.delete({ where: { id: params.id } });
      await audit({
        tenantId: user.tenantId,
        userId: user.id,
        action: 'DELETE',
        entity: 'Product',
        entityId: params.id,
        beforeJson: before as never,
        ip,
      });
      return ok({ deleted: true });
    },
    { role: 'TENANT_ADMIN' },
  )(req);
