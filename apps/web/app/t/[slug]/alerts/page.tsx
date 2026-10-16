import { getCurrentTenant } from '@/lib/tenant';
import { prisma } from '@/lib/db';
import { canPlan } from '@/lib/rbac';
import { DEFAULT_TZ, todayIso } from '@/lib/dispatch/time';
import { PageShell } from '@/components/page-shell';
import { AlertsClient } from './alerts-client';

export const metadata = { title: 'Alerts — RouteIQ' };
export const dynamic = 'force-dynamic';

/**
 * Operations alerts (owner request 16 Oct 2026: "notify me when a rule I set is broken ... so we can
 * track with ease"): every alert by date, depot, state and rule. Every role reads it; the dispatcher and
 * up acknowledge. The rules are set by a company admin under Settings > Operations alerts.
 */
export default async function AlertsPage({ params, searchParams }: { params: { slug: string }; searchParams: { from?: string; to?: string; date?: string; depot?: string; state?: string } }) {
  const { tenant, user, db } = await getCurrentTenant(params.slug);
  const own = user.tenantId === tenant.id;
  const cfg = await prisma.tenantConfig.findUnique({ where: { tenantId: tenant.id }, select: { alertsEnabled: true, timezone: true } });
  const timezone = cfg?.timezone ?? DEFAULT_TZ;
  const depots = own ? await db.depot.findMany({ where: { active: true }, select: { id: true, code: true, name: true }, orderBy: { code: 'asc' } }) : [];
  const today = todayIso(timezone);
  return (
    <PageShell
      title="Operations alerts"
      description="When a rule set under Settings > Operations alerts is broken: unloading longer than planned, loading too long, running late, not dispatched, driver silent, after the delivery window, priority stop not delivered, delivered with a note, proof far from the pin, load not closed, driver page not opened. Open alerts first, high before warnings."
    >
      {own ? (
        <AlertsClient
          enabled={!!cfg?.alertsEnabled}
          canAck={canPlan(user.role)}
          isAdmin={user.role === 'TENANT_ADMIN' || user.role === 'SUPER_ADMIN'}
          slug={tenant.slug}
          timezone={timezone}
          today={today}
          depots={depots}
          initial={{
            from: searchParams.from ?? searchParams.date ?? today,
            to: searchParams.to ?? searchParams.date ?? searchParams.from ?? today,
            depotId: searchParams.depot ?? '',
            state: searchParams.state ?? 'all',
          }}
        />
      ) : (
        <p className="text-sm text-muted-foreground">Alerts are shown for your own company only.</p>
      )}
    </PageShell>
  );
}
