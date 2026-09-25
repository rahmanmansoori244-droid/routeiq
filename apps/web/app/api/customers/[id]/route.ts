import { withTenantApi, ok, parseBody, notFoundIfNull, fail } from '@/lib/api';
import { customerPatchSchema, normalizeBranchKey } from '@/lib/schemas';
import { audit } from '@/lib/audit';
import { deactivateWarning, openOrders } from '@/lib/dispatch/open-orders';

interface Params { params: { id: string } }

export const GET = (req: Request, { params }: Params) =>
  withTenantApi(async (_r, { db }) => {
    const customer = notFoundIfNull(
      await db.customer.findUnique({
        where: { id: params.id },
        include: { region: { select: { id: true, code: true, name: true } } },
      }),
    );
    return ok(customer);
  })(req);

export const PATCH = (req: Request, { params }: Params) =>
  withTenantApi(
    async (r, { db, user, ip }) => {
      const before = notFoundIfNull(await db.customer.findUnique({ where: { id: params.id } }));
      const input = await parseBody(r, customerPatchSchema);
      // The schema checks a window only when both ends are in the request: validate the
      // merged record, so patching one end cannot leave an end before its start.
      const windows = [
        ['hardWindowStartMin', 'hardWindowEndMin', 'Hard window'],
        ['prefWindowStartMin', 'prefWindowEndMin', 'Preferred window'],
      ] as const;
      for (const [a, b, label] of windows) {
        const s = input[a] !== undefined ? input[a] : before[a];
        const e = input[b] !== undefined ? input[b] : before[b];
        if (typeof s === 'number' && typeof e === 'number' && e <= s) return fail(`${label}: end must be after start.`, 400);
      }
      if (input.regionId) {
        const region = await db.region.findUnique({ where: { id: input.regionId } });
        if (!region) return fail('Region not found in this tenant', 400);
      }

      const data: Record<string, unknown> = { ...input };
      if (Object.prototype.hasOwnProperty.call(input, 'branchCode')) {
        data.branchKey = normalizeBranchKey(input.branchCode);
      }
      const code = input.code ?? before.code;
      const branchKey = (data.branchKey as string | undefined) ?? before.branchKey;
      if (code !== before.code || branchKey !== before.branchKey) {
        // Codes are one customer whatever their letter case (the order intake matches them so).
        const twin = await db.customer.findFirst({
          where: { id: { not: before.id }, code: { equals: code, mode: 'insensitive' }, branchKey: { equals: branchKey, mode: 'insensitive' } },
          select: { code: true, branchCode: true },
        });
        if (twin) return fail(`Customer ${twin.code}${twin.branchCode ? ` / ${twin.branchCode}` : ''} already exists (codes are the same whatever the letter case).`, 409);
      }
      if (input.lat !== undefined && input.lng !== undefined) {
        data.geocodeConfidence = 'HIGH';
        data.locationSource = 'MANUAL_LATLNG';
        data.locationVerified = true;
        data.locationVerifiedById = user.id;
        data.locationVerifiedAt = new Date();
      }
      // A dispatcher setting these explicitly confirms them (no more "default" warnings).
      if (input.priority !== undefined) data.priorityConfirmed = true;
      if (input.avgServiceTimeMin !== undefined) data.serviceTimeConfirmed = true;

      const after = await db.customer.update({ where: { id: params.id }, data: data as never });
      await audit({
        tenantId: user.tenantId,
        userId: user.id,
        action: 'UPDATE',
        entity: 'Customer',
        entityId: after.id,
        beforeJson: before as never,
        afterJson: after as never,
        ip,
      });
      // Deactivating stops delivery of its open orders (left unserved at the next optimize).
      const warning = before.active && !after.active ? deactivateWarning('customer', await openOrders(user.tenantId, { customerId: after.id })) : null;
      return ok(warning ? { ...after, warning } : after);
    },
    { role: 'PLANNER' },
  )(req);

export const DELETE = (req: Request, { params }: Params) =>
  withTenantApi(
    async (_r, { db, user, ip }) => {
      const before = notFoundIfNull(await db.customer.findUnique({ where: { id: params.id } }));
      const orderCount = await db.order.count({ where: { customerId: params.id } });
      if (orderCount > 0) {
        const after = await db.customer.update({ where: { id: params.id }, data: { active: false } });
        await audit({
          tenantId: user.tenantId,
          userId: user.id,
          action: 'UPDATE',
          entity: 'Customer',
          entityId: after.id,
          beforeJson: before as never,
          afterJson: { ...(after as object), softDeleted: true } as never,
          ip,
        });
        const warning = before.active ? deactivateWarning('customer', await openOrders(user.tenantId, { customerId: after.id })) : null;
        return ok({ softDeleted: true, customer: after, ...(warning ? { warning } : {}) });
      }
      await db.customer.delete({ where: { id: params.id } });
      await audit({
        tenantId: user.tenantId,
        userId: user.id,
        action: 'DELETE',
        entity: 'Customer',
        entityId: params.id,
        beforeJson: before as never,
        ip,
      });
      return ok({ deleted: true });
    },
    { role: 'TENANT_ADMIN' },
  )(req);
