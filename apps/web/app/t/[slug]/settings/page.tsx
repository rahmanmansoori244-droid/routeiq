import { redirect } from 'next/navigation';
import { getCurrentTenant } from '@/lib/tenant';
import { canManageMasterData } from '@/lib/rbac';
import { prisma } from '@/lib/db';
import { PageShell } from '@/components/page-shell';
import { effectivePlannerValues } from '@/lib/dispatch/planner-config';
import { SETTINGS_FIELDS, type EditableConfig } from '@/lib/settings-fields';
import { SettingsForm } from './settings-form';

export const metadata = { title: 'Settings — RouteIQ' };
export const dynamic = 'force-dynamic';

export default async function SettingsPage({ params }: { params: { slug: string } }) {
  const { tenant: t, user } = await getCurrentTenant(params.slug);
  if (!canManageMasterData(user.role)) redirect(`/t/${params.slug}`);

  const tenant = await prisma.tenant.findUnique({
    where: { id: t.id },
    include: { config: true },
  });
  if (!tenant || !tenant.config) redirect(`/t/${params.slug}`);
  const profiles = await prisma.customerTypeProfile.findMany({ where: { tenantId: t.id }, orderBy: { customerType: 'asc' } });

  // Only the settings the dispatch planner uses are sent to the page (review F21).
  const cfg = tenant.config;
  const editable = Object.fromEntries(SETTINGS_FIELDS.map((k) => [k, cfg[k]])) as unknown as EditableConfig;

  return (
    <PageShell
      title="Tenant settings"
      description="What the daily dispatch planner plans with. Changes apply to the next optimization; plans already made keep the settings they were made with."
    >
      <SettingsForm
        initial={{
          tenant: {
            name: tenant.name,
            country: tenant.country,
            currency: tenant.currency,
            primaryUnit: tenant.primaryUnit,
          },
          config: editable,
        }}
        effective={effectivePlannerValues(cfg, tenant.country, tenant.currency)}
        profiles={profiles.map((p) => ({
          customerType: p.customerType,
          defaultPriority: p.defaultPriority,
          serviceTimeMin: p.serviceTimeMin,
          hardWindowStartMin: p.hardWindowStartMin,
          hardWindowEndMin: p.hardWindowEndMin,
          prefWindowStartMin: p.prefWindowStartMin,
          prefWindowEndMin: p.prefWindowEndMin,
        }))}
      />
    </PageShell>
  );
}
