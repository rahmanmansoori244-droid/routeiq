import { Prisma } from '@prisma/client';
import { withTenantApi, ok, fail, parseBody, notFoundIfNull } from '@/lib/api';
import { depotHoursProblem, depotPatchSchema } from '@/lib/schemas';
import { audit } from '@/lib/audit';
import { prisma } from '@/lib/db';
import { deactivateWarning, openOrders } from '@/lib/dispatch/open-orders';
import { DEPOT_REF_COUNT, depotDeleteOutcome, depotReferenceText, type DepotRefCounts } from '@/lib/master-data-delete';

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
      const input = await parseBody(r, depotPatchSchema);
      const hours = depotHoursProblem({ ...before, ...input });
      if (hours) return fail(hours, 400);
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
      // Deactivating keeps the depot's orders on it; they wait until it is active again (audit F03).
      const warning = before.active && !after.active ? deactivateWarning('depot', await openOrders(user.tenantId, { depotId: after.id })) : null;
      return ok(warning ? { ...after, warning } : after);
    },
    { role: 'TENANT_ADMIN' },
  )(req);

/**
 * "Delete" a depot (audit F03, owner decision 7). A depot that anything refers to - trucks,
 * regions, plans, orders, order files - is DEACTIVATED: its orders keep their depot, so they
 * never move into another depot's plan or out of every plan. Only a depot nothing refers to is
 * deleted. The depot row is locked while the references are counted, so an order file confirmed
 * at the same moment is either counted or waits; and the database refuses a delete that would
 * leave an order or order file without its depot (NO ACTION keys): that is answered by
 * deactivating too.
 */
export const DELETE = (req: Request, { params }: Params) =>
  withTenantApi(
    async (_r, { user, ip }) => {
      const tenantId = user.tenantId;
      const deactivate = async (tx: Prisma.TransactionClient, before: Record<string, unknown> & { active: boolean }, counts: DepotRefCounts) => {
        const after = await tx.depot.update({ where: { id: params.id }, data: { active: false } });
        const references = depotReferenceText(counts);
        await audit(
          {
            tenantId,
            userId: user.id,
            action: 'UPDATE',
            entity: 'Depot',
            entityId: after.id,
            beforeJson: before as never,
            afterJson: { ...(after as object), softDeleted: true, references: counts } as never,
            ip,
          },
          tx,
        );
        return { softDeleted: true as const, depot: after, references, wasActive: before.active };
      };
      const loadBefore = async (tx: Prisma.TransactionClient) => {
        const locked = await tx.$queryRaw<Array<{ id: string }>>`
          SELECT "id" FROM "Depot" WHERE "id" = ${params.id} AND "tenantId" = ${tenantId} FOR UPDATE`;
        if (!locked.length) return null;
        const row = await tx.depot.findUniqueOrThrow({ where: { id: params.id }, include: { _count: { select: DEPOT_REF_COUNT } } });
        const { _count: counts, ...before } = row;
        return { before, counts };
      };
      let result;
      try {
        result = await prisma.$transaction(
          async (tx) => {
            const found = await loadBefore(tx);
            if (!found) return null;
            if (depotDeleteOutcome(found.counts) === 'DEACTIVATE') return deactivate(tx, found.before, found.counts);
            await tx.depot.delete({ where: { id: params.id } });
            await audit({ tenantId, userId: user.id, action: 'DELETE', entity: 'Depot', entityId: params.id, beforeJson: found.before as never, ip }, tx);
            return { deleted: true as const };
          },
          { timeout: 15_000, maxWait: 5_000 },
        );
      } catch (e) {
        // The database refused the delete (a reference the count did not see): deactivate instead.
        if (!(e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2003')) throw e;
        result = await prisma.$transaction(async (tx) => {
          const found = await loadBefore(tx);
          return found ? deactivate(tx, found.before, found.counts) : null;
        });
      }
      if (!result) return fail('Not found.', 404);
      if (!('softDeleted' in result)) return ok({ deleted: true });
      const { wasActive, ...answer } = result;
      const warning = wasActive ? deactivateWarning('depot', await openOrders(tenantId, { depotId: params.id })) : null;
      return ok(warning ? { ...answer, warning } : answer);
    },
    { role: 'TENANT_ADMIN' },
  )(req);

export const PUT = () => fail('Use PATCH', 405);
