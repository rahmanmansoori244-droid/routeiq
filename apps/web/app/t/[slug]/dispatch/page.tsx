import { getCurrentTenant } from '@/lib/tenant';
import { canManageMasterData, canPlan } from '@/lib/rbac';
import { phoneCountryCode } from '@/lib/dispatch/customer-attrs';
import { readIvmsEnv } from '@/lib/ivms/env';
import { ivmsModeAtLeast, ivmsModeOf } from '@/lib/ivms/settings';
import { PageShell } from '@/components/page-shell';
import { DispatchClient } from './dispatch-client';

export const metadata = { title: 'Daily dispatch — RouteIQ' };
export const dynamic = 'force-dynamic';

export default async function DispatchPage({ params, searchParams }: { params: { slug: string }; searchParams: { date?: string; depot?: string } }) {
  const { tenant, user, db } = await getCurrentTenant(params.slug);
  // Live trucks on the map (IVMS live link, 16 Oct 2026): GPS tracking MAP or TIMES, PLANNER and up
  // (positions of people at work). OFF (the default) or the kill switch: nothing changes on this screen.
  const ivms = await db.tenantConfig.findFirst({ select: { ivmsMode: true } });
  const liveMap = canPlan(user.role) && !readIvmsEnv().disabled && ivmsModeAtLeast(ivmsModeOf(ivms), 'MAP');
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
        liveMap={liveMap}
      />
    </PageShell>
  );
}
