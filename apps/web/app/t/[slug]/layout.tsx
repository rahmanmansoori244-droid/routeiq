import { getCurrentTenant } from '@/lib/tenant';
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

  return (
    <div className="flex min-h-screen">
      <Sidebar slug={tenant.slug} tenantName={tenant.name} role={user.role} />
      <div className="flex flex-1 flex-col">
        <TopBar
          slug={tenant.slug}
          tenantName={tenant.name}
          role={user.role}
          userName={user.name}
          userEmail={user.email}
        />
        <main className="flex-1 p-6">{children}</main>
      </div>
    </div>
  );
}
