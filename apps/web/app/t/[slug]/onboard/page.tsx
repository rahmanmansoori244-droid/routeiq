import { redirect } from 'next/navigation';
import { getCurrentTenant } from '@/lib/tenant';
import { canManageMasterData } from '@/lib/rbac';
import { OnboardWizard } from './onboard-wizard';

export const metadata = { title: 'Onboarding — RouteIQ' };
export const dynamic = 'force-dynamic';

export default async function OnboardPage({ params }: { params: { slug: string } }) {
  const { db, tenant, user } = await getCurrentTenant(params.slug);
  if (!canManageMasterData(user.role)) redirect(`/t/${params.slug}`);

  const [depotCount, truckCount, customerCount] = await Promise.all([
    db.depot.count({ where: { active: true } }),
    db.truck.count({ where: { active: true } }),
    db.customer.count({ where: { active: true } }),
  ]);

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Welcome to {tenant.name}</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Three steps to get ready to optimize a daily run. You can revisit this from the sidebar any time.
        </p>
      </div>
      <OnboardWizard
        slug={params.slug}
        mapboxToken={process.env.MAPBOX_TOKEN ?? ''}
        completion={{ depots: depotCount, trucks: truckCount, customers: customerCount }}
      />
    </div>
  );
}
