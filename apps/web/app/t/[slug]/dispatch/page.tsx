import { getCurrentTenant } from '@/lib/tenant';
import { canApproveOverride, canManageMasterData, canPlan } from '@/lib/rbac';
import { phoneCountryCode } from '@/lib/dispatch/customer-attrs';
import { PageShell } from '@/components/page-shell';
import { DispatchClient } from './dispatch-client';

export const metadata = { title: 'Daily dispatch — RouteIQ' };
export const dynamic = 'force-dynamic';

export default async function DispatchPage({ params, searchParams }: { params: { slug: string }; searchParams: { date?: string; depot?: string } }) {
  const { tenant, user } = await getCurrentTenant(params.slug);
  return (
    <PageShell
      title="Daily dispatch planning"
      description="Upload tomorrow's sales orders → fix missing customer locations → OPTIMIZE → review truck loads and routes → lock, export and dispatch."
    >
      <DispatchClient
        slug={params.slug}
        canPlan={canPlan(user.role)}
        canDispatch={canApproveOverride(user.role)}
        canEditProducts={canManageMasterData(user.role)}
        initialDate={searchParams.date ?? null}
        initialDepot={searchParams.depot ?? null}
        phoneCountryCode={phoneCountryCode(tenant.country)}
      />
    </PageShell>
  );
}
