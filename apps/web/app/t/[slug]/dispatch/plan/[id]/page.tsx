import { notFound } from 'next/navigation';
import { getCurrentTenant } from '@/lib/tenant';
import { canApproveOverride, canPlan } from '@/lib/rbac';
import { phoneCountryCode } from '@/lib/dispatch/customer-attrs';
import { PageShell } from '@/components/page-shell';
import { PlanVersionClient } from './plan-version-client';

export const metadata = { title: 'Plan version — RouteIQ' };
export const dynamic = 'force-dynamic';

export default async function PlanVersionPage({ params }: { params: { slug: string; id: string } }) {
  const { db, tenant, user } = await getCurrentTenant(params.slug);
  const run = await db.runPlan.findUnique({ where: { id: params.id }, select: { id: true, version: true, runDate: true, depotId: true } });
  if (!run) notFound();
  return (
    <PageShell title={`Plan version ${run.version}`} description="Every optimization and re-plan is kept as its own version.">
      <PlanVersionClient
        slug={params.slug}
        runId={run.id}
        canPlan={canPlan(user.role)}
        canDispatch={canApproveOverride(user.role)}
        phoneCountryCode={phoneCountryCode(tenant.country)}
        dayHref={`/t/${params.slug}/dispatch?date=${run.runDate.toISOString().slice(0, 10)}&depot=${run.depotId}`}
      />
    </PageShell>
  );
}
