import { getCurrentTenant } from '@/lib/tenant';
import { prisma } from '@/lib/db';
import { loadedActionOn } from '@/lib/alerts/view';
import { canManageMasterData, canPlan } from '@/lib/rbac';
import { phoneCountryCode } from '@/lib/dispatch/customer-attrs';
import { PageShell } from '@/components/page-shell';
import { DispatchClient } from './dispatch-client';

export const metadata = { title: 'Daily dispatch — RouteIQ' };
export const dynamic = 'force-dynamic';

export default async function DispatchPage({ params, searchParams }: { params: { slug: string }; searchParams: { date?: string; depot?: string } }) {
  const { tenant, user } = await getCurrentTenant(params.slug);
  // Operations alerts (owner request 16 Oct 2026): the day's Alerts card, only while they are on and in the
  // user's own company (the alert API answers for the session's company).
  const alerts = user.tenantId === tenant.id ? await prisma.tenantConfig.findUnique({ where: { tenantId: tenant.id }, select: { alertsEnabled: true, alertLoadingOverMin: true } }) : null;
  return (
    <PageShell
      title="Daily dispatch planning"
      description="Upload tomorrow's sales orders → fix missing customer locations → OPTIMIZE → review truck loads and routes → lock, export and dispatch."
    >
      <DispatchClient
        slug={params.slug}
        canPlan={canPlan(user.role)}
        // Owner decision 4 (5 Oct 2026): the dispatcher (PLANNER) dispatches, completes and resets a stuck plan.
        canDispatch={canPlan(user.role)}
        canEditProducts={canManageMasterData(user.role)}
        initialDate={searchParams.date ?? null}
        initialDepot={searchParams.depot ?? null}
        phoneCountryCode={phoneCountryCode(tenant.country)}
        alertsEnabled={!!alerts?.alertsEnabled}
        loadedAction={loadedActionOn(alerts)}
      />
    </PageShell>
  );
}
