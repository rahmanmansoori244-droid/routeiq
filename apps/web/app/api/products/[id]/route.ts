import { withTenantApi, ok, parseBody, notFoundIfNull, fail } from '@/lib/api';
import { productPatchSchema } from '@/lib/schemas';
import { audit } from '@/lib/audit';
import { twinsOf } from '@/lib/product-code';
import { caseWeightChangedNote, deactivateWarning, openMasterWeighedLines, openOrders } from '@/lib/dispatch/open-orders';
import { palletFactorChangedNote } from '@/lib/dispatch/pallets';

interface Params { params: { id: string } }

export const PATCH = (req: Request, { params }: Params) =>
  withTenantApi(
    async (r, { db, user, ip }) => {
      const before = notFoundIfNull(await db.product.findUnique({ where: { id: params.id } }));
      const { clearWeight, ...input } = await parseBody(r, productPatchSchema);
      // A known case weight becomes 0 (unknown) only on purpose: the Edit dialog's "Weight not known"
      // sends clearWeight. An emptied or 0 weight without it is refused, never saved: with payload 0
      // on every truck OPTIMIZE never asks for a weight (WEIGHT_REQUIRED), so a weight lost by
      // accident would go unnoticed (review of da76343).
      const clearsWeight = before.weightPerCaseKg > 0 && input.weightPerCaseKg !== undefined && !(input.weightPerCaseKg > 0);
      if (clearsWeight && clearWeight !== true) {
        return fail(
          {
            code: 'WEIGHT_CLEAR_UNCONFIRMED',
            message: `${before.code} has a case weight of ${before.weightPerCaseKg} kg. Enter the correct weight, or tick "Weight not known" to clear it.`,
          },
          422,
        );
      }
      if (input.code !== undefined && input.code !== before.code) {
        // Another product whose code is the same one (letter case, spacing: lib/product-code.ts).
        const twin = twinsOf(await db.product.findMany({ where: { id: { not: before.id } }, select: { id: true, code: true } }), input.code)[0];
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
      // A weight cleared on purpose: lines already weighed keep their kg (weights.ts masterLineKg),
      // new ones come in at 0 kg (unknown).
      const weightNote = clearsWeight
        ? `The case weight of ${after.code} was cleared (unknown). Order lines already weighed with it keep their kg; new order lines of it with no weight of their own come in at 0 kg (unknown) until a case weight is entered.`
        : after.weightPerCaseKg > 0 && after.weightPerCaseKg !== before.weightPerCaseKg
          ? caseWeightChangedNote(await openMasterWeighedLines(user.tenantId, after.id))
          : null;
      // Cases per pallet changed: loads already planned keep the pallets they were planned with.
      const palletNote = palletFactorChangedNote(before.casesPerPallet, after.casesPerPallet);
      const warning = [deactivated, weightNote, palletNote].filter(Boolean).join(' ') || null;
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
