import { withTenantApi, ok, parseBody, notFoundIfNull, fail } from '@/lib/api';
import { customerPatchSchema, normalizeBranchKey } from '@/lib/schemas';
import { audit } from '@/lib/audit';
import { deactivateWarning, openOrders } from '@/lib/dispatch/open-orders';
import { CUSTOMER_SERVICE_COLUMN_DEFAULT, savedLocationLocked } from '@/lib/dispatch/customer-attrs';
import { customerKey, preferredCustomer } from '@/lib/dispatch/order-intake';
import { tenantServiceArea } from '@/lib/dispatch/service-area';
import { canManageMasterData } from '@/lib/rbac';

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
      // A location is set only through PUT /api/customers/:id/location, which checks the point
      // (owner's location rule, audit PR A5). This route used to store any pair as verified HIGH,
      // with no check at all (not 0,0, not the area). Refused, not dropped: the screen would think
      // it saved.
      if (input.lat !== undefined || input.lng !== undefined) {
        return fail(
          {
            code: 'USE_SET_LOCATION',
            message: 'A location is not changed here. Use Set location on the customer page, or ADD LOCATION on Daily dispatch: they check the point before saving it.',
          } as Record<string, unknown>,
          400,
        );
      }
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

      const { windowConfirmed, ...fields } = input;
      const data: Record<string, unknown> = { ...fields };
      // Owner decision 1 Oct 2026 ("own confirmed window"): receiving hours a dispatcher or admin
      // enters are confirmed by them (who and when are kept; the change is in the audit row below).
      // Explicit windowConfirmed true with no hours = open all day; all hours cleared = not confirmed
      // (the customer-type or company default applies again).
      const windowsSent = windows.some(([a, b]) => input[a] !== undefined || input[b] !== undefined);
      const anyHours = windows.some(([a, b]) => (input[a] !== undefined ? input[a] : before[a]) !== null || (input[b] !== undefined ? input[b] : before[b]) !== null);
      const confirm = windowConfirmed ?? (windowsSent ? anyHours : undefined);
      if (confirm !== undefined) {
        data.windowConfirmedAt = confirm ? new Date() : null;
        data.windowConfirmedById = confirm ? user.id : null;
      }
      if (Object.prototype.hasOwnProperty.call(input, 'branchCode')) {
        data.branchKey = normalizeBranchKey(input.branchCode);
      }
      const code = input.code ?? before.code;
      const branchKey = (data.branchKey as string | undefined) ?? before.branchKey;
      const isAdmin = canManageMasterData(user.role);
      // Owner decision 1 Oct 2026 (item 5, location admin-lock "on every write path"): orders are
      // matched to customers by code and branch (letter case aside). Renaming a customer with a usable
      // saved location away, then creating one (or letting an order file create one) under its old
      // code, would send every order of that code to a point the dispatcher chose: only an admin
      // changes the code or branch of such a customer.
      if (
        customerKey(code, branchKey) !== customerKey(before.code, before.branchKey) &&
        savedLocationLocked(isAdmin, before, await tenantServiceArea(user.tenantId))
      ) {
        return fail(
          {
            code: 'LOCATION_ADMIN_ONLY',
            message: `Only an admin can change the code or branch of a customer with a saved location: orders are matched to the customer by its code and branch. Ask your company admin. Nothing was saved.`,
          } as Record<string, unknown>,
          403,
        );
      }
      // The same rule for (de)activating one of two customers whose codes differ only in letter case
      // (third review): the order intake sends a code's orders to one of them (preferredCustomer: the
      // active one first, then the one with a location). Moving them away from the one with a usable
      // saved location, to a twin whose location a dispatcher may fill (or one saved elsewhere), changes
      // where they are delivered: only an admin does it. Moving them to the one with the saved point,
      // from a twin without a usable one, only fills a missing location and stays allowed.
      if (!isAdmin && input.active !== undefined && input.active !== before.active) {
        const key = customerKey(before.code, before.branchKey);
        const twins = (
          await db.customer.findMany({
            where: { id: { not: before.id }, code: { equals: before.code, mode: 'insensitive' }, branchKey: { equals: before.branchKey, mode: 'insensitive' } },
            select: { id: true, code: true, branchCode: true, branchKey: true, name: true, active: true, lat: true, lng: true, locationVerified: true, geocodeConfidence: true },
          })
        ).filter((t) => customerKey(t.code, t.branchKey) === key);
        const matched = twins.length ? preferredCustomer([before, ...twins]) : undefined;
        const next = twins.length ? preferredCustomer([{ ...before, active: input.active }, ...twins]) : undefined;
        if (matched && next && matched.id !== next.id && savedLocationLocked(isAdmin, matched, await tenantServiceArea(user.tenantId))) {
          const label = (c: { code: string; branchCode: string | null; name: string }) => `${c.code}${c.branchCode ? ` / ${c.branchCode}` : ''} (${c.name})`;
          return fail(
            {
              code: 'LOCATION_ADMIN_ONLY',
              message: `Only an admin can ${input.active ? 'reactivate' : 'deactivate'} this customer: new orders of its code would then go to ${label(next)} instead of ${label(matched)}, which has a saved location (codes are the same whatever the letter case). Ask your company admin. Nothing was saved.`,
            } as Record<string, unknown>,
            403,
          );
        }
      }
      if (code !== before.code || branchKey !== before.branchKey) {
        // Codes are one customer whatever their letter case (the order intake matches them so).
        const twin = await db.customer.findFirst({
          where: { id: { not: before.id }, code: { equals: code, mode: 'insensitive' }, branchKey: { equals: branchKey, mode: 'insensitive' } },
          select: { code: true, branchCode: true },
        });
        if (twin) return fail(`Customer ${twin.code}${twin.branchCode ? ` / ${twin.branchCode}` : ''} already exists (codes are the same whatever the letter case).`, 409);
      }
      // A dispatcher setting these explicitly confirms them (no more "default" warnings). Only the
      // fields sent: the Details dialog sends only what the dispatcher changed (audit F07).
      if (input.priority !== undefined) data.priorityConfirmed = true;
      if (input.avgServiceTimeMin === null) {
        // Unloading time cleared: no own time any more, the customer-type or Settings default applies
        // (owner decision 9). The column default is stored, as for a customer created without a time.
        data.avgServiceTimeMin = CUSTOMER_SERVICE_COLUMN_DEFAULT;
        data.serviceTimeConfirmed = false;
      } else if (input.avgServiceTimeMin !== undefined) data.serviceTimeConfirmed = true;

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
