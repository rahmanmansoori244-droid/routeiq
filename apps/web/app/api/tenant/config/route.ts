import { z } from 'zod';
import { withTenantApi, ok, parseBody, fail } from '@/lib/api';
import { tenantConfigSchema, tenantSettingsSchema } from '@/lib/schemas';
import { audit } from '@/lib/audit';
import { prisma } from '@/lib/db';

// TENANT_ADMIN, like the Settings page (review F15): cost rates and the internal routing URL are
// admin data. No lower-role screen reads this.
export const GET = withTenantApi(
  async (_req, { user }) => {
    // Tenant + TenantConfig come from a fresh prisma read (not tenantDb) so we
    // can also project Tenant fields; tenantId is still scoped via the where clause.
    const tenant = await prisma.tenant.findUnique({
      where: { id: user.tenantId },
      include: { config: true },
    });
    if (!tenant) return fail('Tenant not found', 404);
    return ok(tenant);
  },
  { role: 'TENANT_ADMIN' },
);

const settingsPatchSchema = z.object({
  tenant: tenantSettingsSchema.partial().optional(),
  config: tenantConfigSchema.partial().optional(),
});

export const PATCH = withTenantApi(
  async (req, { user, ip }) => {
    const input = await parseBody(req, settingsPatchSchema);
    if (!input.tenant && !input.config) return fail('Nothing to update', 400);

    const before = await prisma.tenant.findUnique({
      where: { id: user.tenantId },
      include: { config: true },
    });

    const updated = await prisma.$transaction(async (tx) => {
      if (input.tenant) {
        await tx.tenant.update({ where: { id: user.tenantId }, data: input.tenant });
      }
      if (input.config) {
        await tx.tenantConfig.update({ where: { tenantId: user.tenantId }, data: input.config });
      }
      return tx.tenant.findUnique({ where: { id: user.tenantId }, include: { config: true } });
    });

    await audit({
      tenantId: user.tenantId,
      userId: user.id,
      action: 'UPDATE',
      entity: 'TenantConfig',
      entityId: user.tenantId,
      beforeJson: before as never,
      afterJson: updated as never,
      ip,
    });
    return ok(updated);
  },
  { role: 'TENANT_ADMIN' },
);
