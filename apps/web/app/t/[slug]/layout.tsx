import { getCurrentTenant } from '@/lib/tenant';
import { prisma } from '@/lib/db';
import { canPlan } from '@/lib/rbac';
import { Sidebar } from '@/components/sidebar';
import { TopBar } from '@/components/topbar';

export default async function TenantLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: { slug: string };
}) {
  const { tenant, user } = await getCurrentTenant(params.slug);
  // Operations alerts (owner request 16 Oct 2026): the bell and the Alerts menu item show only while the
  // company has them on, so nothing polls and nothing new shows when they are off; a platform admin looking
  // at another company sees neither (the alert API answers for the session's own company).
  const own = user.tenantId === tenant.id;
  const alertCfg = own ? await prisma.tenantConfig.findUnique({ where: { tenantId: tenant.id }, select: { alertsEnabled: true, timezone: true } }) : null;

  return (
    <div className="flex min-h-screen">
      <Sidebar slug={tenant.slug} tenantName={tenant.name} role={user.role} alertsOn={!!alertCfg?.alertsEnabled} />
      {/* min-w-0: the column may be narrower than its widest content (a wide table scrolls inside its own
          overflow-x-auto box), so on a phone the page, its sticky bars and dialogs stay at the screen width (review F6). */}
      <div className="flex min-w-0 flex-1 flex-col">
        <TopBar
          slug={tenant.slug}
          tenantName={tenant.name}
          role={user.role}
          userName={user.name}
          userEmail={user.email}
          alerts={alertCfg?.alertsEnabled ? { enabled: true, canAck: canPlan(user.role), timezone: alertCfg.timezone } : undefined}
        />
        <main className="flex-1 p-6">{children}</main>
      </div>
    </div>
  );
}
