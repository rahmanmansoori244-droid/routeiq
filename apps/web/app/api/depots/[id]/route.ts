import { withTenantApi, ok, fail, parseBody, notFoundIfNull } from '@/lib/api';
import { depotSchema } from '@/lib/schemas';
import { audit } from '@/lib/audit';

interface Params { params: { id: string } }

export const GET = (req: Request, { params }: Params) =>
  withTenantApi(async (_r, { db }) => {
    const depot = notFoundIfNull(await db.depot.findUnique({ where: { id: params.id } }));
    return ok(depot);
  })(req);

export const PATCH = (req: Request, { params }: Params) =>
  withTenantApi(
    async (r, { db, user, ip }) => {
      const before = notFoundIfNull(await db.depot.findUnique({ where: { id: params.id } }));
      const input = await parseBody(r, depotSchema.partial());
      const after = await db.depot.update({ where: { id: params.id }, data: input });
      await audit({
        tenantId: user.tenantId,
        userId: user.id,
        action: 'UPDATE',
        entity: 'Depot',
        entityId: after.id,
        beforeJson: before as never,
        afterJson: after as never,
        ip,
      });
      return ok(after);
    },
    { role: 'TENANT_ADMIN' },
  )(req);

export const DELETE = (req: Request, { params }: Params) =>
  withTenantApi(
    async (_r, { db, user, ip }) => {
      const before = notFoundIfNull(await db.depot.findUnique({ where: { id: params.id } }));
      const refs = await db.depot.findUnique({
        where: { id: params.id },
        include: { _count: { select: { trucks: true, regions: true, runs: true } } },
      });
      if (refs && (refs._count.trucks > 0 || refs._count.runs > 0)) {
        // Soft-deactivate to preserve audit trail and referential integrity.
        const after = await db.depot.update({ where: { id: params.id }, data: { active: false } });
        await audit({
          tenantId: user.tenantId,
          userId: user.id,
          action: 'UPDATE',
          entity: 'Depot',
          entityId: after.id,
          beforeJson: before as never,
          afterJson: { ...(after as object), softDeleted: true } as never,
          ip,
        });
        return ok({ softDeleted: true, depot: after });
      }
      await db.depot.delete({ where: { id: params.id } });
      await audit({
        tenantId: user.tenantId,
        userId: user.id,
        action: 'DELETE',
        entity: 'Depot',
        entityId: params.id,
        beforeJson: before as never,
        ip,
      });
      return ok({ deleted: true });
    },
    { role: 'TENANT_ADMIN' },
  )(req);

export const PUT = () => fail('Use PATCH', 405);
