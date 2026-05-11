import { redirect } from 'next/navigation';
import { getCurrentTenant } from '@/lib/tenant';
import { canManageMasterData } from '@/lib/rbac';
import { prisma } from '@/lib/db';
import { PageShell } from '@/components/page-shell';
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

  return (
    <PageShell
      title="Tenant settings"
      description="Tenant-wide configuration. Changes apply immediately to new optimization runs."
    >
      <SettingsForm
        initial={{
          tenant: {
            name: tenant.name,
            country: tenant.country,
            currency: tenant.currency,
            primaryUnit: tenant.primaryUnit,
          },
          config: tenant.config,
        }}
      />
    </PageShell>
  );
}
