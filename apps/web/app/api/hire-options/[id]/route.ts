import type { Prisma } from '@prisma/client';
import { withTenantApi, ok, parseBody, notFoundIfNull, fail } from '@/lib/api';
import { prisma } from '@/lib/db';
import { hireOptionPatchSchema, hireOptionSizeProblem } from '@/lib/schemas';
import { audit } from '@/lib/audit';
import { historyOnlyDepotLinkMessage } from '@/lib/master-data-delete';
import { liveRentalDays } from '@/lib/dispatch/hire-whatif';
import { isLockBusy, setLockTimeout } from '@/lib/dispatch/plan-locks';
import { fmtDayMonth } from '@/lib/dispatch/time';

interface Params { params: { id: string } }

/**
 * Third review of the hire branch: a truck hired from the option for today or a coming day keeps it
 * counted - its link is never cleared (delete) or moved to another depot under the rental, or the day
 * could be rented past the option's max per day. Switching it off is the way meanwhile.
 */
function inUse(days: string[], what: 'deleted' | 'moved to another depot') {
  return fail(
    {
      code: 'HIRE_OPTION_IN_USE',
      message: `Trucks are hired from this option for ${days.map(fmtDayMonth).join(', ')}: it cannot be ${what} until their day is over. Switch it off instead (Active) so it is not offered again.`,
    },
    409,
  );
}

/** "Use this plan" holds the option (FOR SHARE) for longer than a screen waits: nothing was changed. */
const BUSY = () =>
  fail({ code: 'HIRE_OPTION_BUSY', message: 'Trucks are being hired from this option right now (Use this plan). Try again in a moment.' }, 409);

/**
 * Review of ISSUE 7: a delete, or a move to another depot, decided under the option's row lock - a
 * "Use this plan" renting from it holds the row (FOR SHARE) until it commits, so this waits for it and
 * then counts its trucks: an option is never deleted or moved over trucks rented a moment before (the
 * check and the write were apart, and the delete cleared the new rentals' link). `write` runs only when
 * no truck is hired from it for today or a coming day; else the days. Null: no such option any more.
 */
async function underOptionLock<T>(tenantId: string, id: string, write: (tx: Prisma.TransactionClient) => Promise<T>): Promise<{ days: string[] } | { done: T } | null> {
  return prisma.$transaction(
    async (tx) => {
      await setLockTimeout(tx);
      const rows = await tx.$queryRaw<Array<{ id: string }>>`SELECT id FROM "HireOption" WHERE id = ${id} AND "tenantId" = ${tenantId} FOR UPDATE`;
      if (!rows.length) return null;
      const days = await liveRentalDays(tenantId, id, tx);
      if (days.length) return { days };
      return { done: await write(tx) };
    },
    { timeout: 30_000, maxWait: 10_000 },
  );
}

// One truck the company can rent for a day (the hire suggestion): company admin. A field left out
// stays as it is; null clears bays or the rental's km charge (= none: fuel is in the hire).
export const PATCH = (req: Request, { params }: Params) =>
  withTenantApi(
    async (r, { db, user, ip }) => {
      const before = notFoundIfNull(await db.hireOption.findUnique({ where: { id: params.id } }));
      const input = await parseBody(r, hireOptionPatchSchema);
      const size = hireOptionSizeProblem({ ...before, ...input });
      if (size) return fail(size, 400);
      if (input.depotId && input.depotId !== before.depotId) {
        const depot = await db.depot.findUnique({ where: { id: input.depotId } });
        if (!depot) return fail('Depot not found in this tenant', 400);
        if (depot.historyOnly) return fail({ code: 'DEPOT_HISTORY_ONLY', message: historyOnlyDepotLinkMessage(depot.code, 'truck') }, 422);
        let moved;
        try {
          moved = await underOptionLock(user.tenantId, params.id, async (tx) => {
            const after = await tx.hireOption.update({ where: { id: params.id }, data: input });
            await audit({ tenantId: user.tenantId, userId: user.id, action: 'UPDATE', entity: 'HireOption', entityId: after.id, beforeJson: before as never, afterJson: after as never, ip }, tx);
            return after;
          });
        } catch (e) {
          if (isLockBusy(e)) return BUSY();
          throw e;
        }
        const out = notFoundIfNull(moved); // deleted meanwhile: 404
        if ('days' in out) return inUse(out.days, 'moved to another depot');
        return ok(out.done);
      }
      const after = await db.hireOption.update({ where: { id: params.id }, data: input });
      await audit({ tenantId: user.tenantId, userId: user.id, action: 'UPDATE', entity: 'HireOption', entityId: after.id, beforeJson: before as never, afterJson: after as never, ip });
      return ok(after);
    },
    { role: 'TENANT_ADMIN' },
  )(req);

// Deleted at once - unless trucks are hired from it for today or a coming day (inUse). The one-day
// trucks of days that are over keep their own figures (their link is cleared).
export const DELETE = (req: Request, { params }: Params) =>
  withTenantApi(
    async (_r, { db, user, ip }) => {
      const before = notFoundIfNull(await db.hireOption.findUnique({ where: { id: params.id } }));
      let removed;
      try {
        removed = await underOptionLock(user.tenantId, params.id, async (tx) => {
          await tx.hireOption.delete({ where: { id: params.id } });
          await audit({ tenantId: user.tenantId, userId: user.id, action: 'DELETE', entity: 'HireOption', entityId: params.id, beforeJson: before as never, ip }, tx);
        });
      } catch (e) {
        if (isLockBusy(e)) return BUSY();
        throw e;
      }
      const out = notFoundIfNull(removed); // deleted meanwhile: 404
      if ('days' in out) return inUse(out.days, 'deleted');
      return ok({ deleted: true });
    },
    { role: 'TENANT_ADMIN' },
  )(req);
