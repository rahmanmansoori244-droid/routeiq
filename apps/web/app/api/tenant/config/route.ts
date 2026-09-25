import { z } from 'zod';
import { withTenantApi, ok, parseBody, fail } from '@/lib/api';
import { overtimeSaveProblem, tenantConfigSchema, tenantSettingsSchema } from '@/lib/schemas';
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

const scalar = z.union([z.string(), z.number(), z.boolean(), z.null()]);

/**
 * Settings are saved field by field (review F21). The page sends only the fields it changed, and
 * for each one the value it showed (`expect`): if another admin or tab saved a different value
 * meanwhile, nothing is saved and the answer is 409 SETTINGS_CHANGED with the fields concerned -
 * never a silent overwrite of someone else's change. Unknown fields (the old controls that did
 * nothing) are refused with 400.
 */
const settingsPatchSchema = z
  .object({
    tenant: tenantSettingsSchema.partial().strict().optional(),
    config: tenantConfigSchema.partial().optional(),
    expect: z
      .object({
        tenant: z.record(scalar).optional(),
        config: z.record(scalar).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

const same = (a: unknown, b: unknown) => (typeof a === 'number' && typeof b === 'number' ? Math.abs(a - b) < 1e-9 : (a ?? null) === (b ?? null));

export const PATCH = withTenantApi(
  async (req, { user, ip }) => {
    const input = await parseBody(req, settingsPatchSchema);
    const tenantPatch = input.tenant ?? {};
    const configPatch = input.config ?? {};
    if (!Object.keys(tenantPatch).length && !Object.keys(configPatch).length) return fail('Nothing to update', 400);

    const result = await prisma.$transaction(async (tx) => {
      // The row lock orders concurrent saves: the second one sees the first one's values.
      await tx.$queryRaw`SELECT id FROM "TenantConfig" WHERE "tenantId" = ${user.tenantId} FOR UPDATE`;
      const before = await tx.tenant.findUnique({ where: { id: user.tenantId }, include: { config: true } });
      if (!before?.config) return { status: 404 as const };
      const beforeTenant = before as unknown as Record<string, unknown>;
      const beforeConfig = before.config as unknown as Record<string, unknown>;
      const changedMeanwhile = [
        ...Object.entries(input.expect?.tenant ?? {}).filter(([k, v]) => k in tenantPatch && !same(beforeTenant[k], v)).map(([k]) => k),
        ...Object.entries(input.expect?.config ?? {}).filter(([k, v]) => k in configPatch && !same(beforeConfig[k], v)).map(([k]) => k),
      ];
      if (changedMeanwhile.length) return { status: 409 as const, fields: changedMeanwhile };
      // Only when this save changes the threshold or the shift maximum: a stored threshold after a
      // lowered shift maximum is a planner warning and must not block saving the company name.
      const overtime = overtimeSaveProblem(configPatch, { ...before.config, ...configPatch });
      if (overtime) return { status: 400 as const, error: overtime };
      if (Object.keys(tenantPatch).length) await tx.tenant.update({ where: { id: user.tenantId }, data: tenantPatch });
      if (Object.keys(configPatch).length) await tx.tenantConfig.update({ where: { tenantId: user.tenantId }, data: configPatch });
      const after = await tx.tenant.findUnique({ where: { id: user.tenantId }, include: { config: true } });
      return { status: 200 as const, before, after };
    });
    if (result.status === 404) return fail('Tenant not found', 404);
    if (result.status === 409) {
      return fail(
        {
          error: `Someone else changed ${result.fields.join(', ')} since this page was opened. Nothing was saved: reload the page to see the current settings, then make your change again.`,
          code: 'SETTINGS_CHANGED',
          fields: result.fields,
        },
        409,
      );
    }
    if (result.status === 400) return fail(result.error, 400);

    // Only what changed: the audit row names the fields and their old and new values.
    const pick = (row: Record<string, unknown> | null | undefined, keys: string[]) => Object.fromEntries(keys.map((k) => [k, row?.[k] ?? null]));
    const tKeys = Object.keys(tenantPatch);
    const cKeys = Object.keys(configPatch);
    await audit({
      tenantId: user.tenantId,
      userId: user.id,
      action: 'UPDATE',
      entity: 'TenantConfig',
      entityId: user.tenantId,
      beforeJson: { tenant: pick(result.before as never, tKeys), config: pick(result.before.config as never, cKeys) } as never,
      afterJson: { tenant: pick(result.after as never, tKeys), config: pick(result.after?.config as never, cKeys) } as never,
      ip,
    });
    return ok(result.after);
  },
  { role: 'TENANT_ADMIN' },
);
