import { withTenantApi, ok, parseBody, notFoundIfNull, fail } from '@/lib/api';
import { customerPatchSchema, normalizeBranchKey } from '@/lib/schemas';
import { audit } from '@/lib/audit';

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
      return ok(after);
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
        return ok({ softDeleted: true, customer: after });
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
