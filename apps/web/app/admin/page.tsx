import { notFound } from 'next/navigation';
import { auth } from '@/lib/auth';
import { prisma } from '@/lib/db';
import { redirectToSignIn } from '@/lib/session-redirect';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

export const metadata = { title: 'Platform admin — RouteIQ' };

export default async function AdminPage() {
  const session = await auth();
  if (!session?.user) redirectToSignIn();
  if (session.user.role !== 'SUPER_ADMIN') notFound();

  const tenants = await prisma.tenant.findMany({
    orderBy: { createdAt: 'desc' },
    select: {
      id: true,
      slug: true,
      name: true,
      country: true,
      active: true,
      createdAt: true,
      _count: { select: { users: true } },
    },
  });

  return (
    <main className="mx-auto max-w-5xl space-y-6 p-8">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Platform admin</h1>
        <p className="text-sm text-muted-foreground">
          Tenant list. Suspend/restore controls land in Phase 5.
        </p>
      </div>
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Tenants ({tenants.length})</CardTitle>
          <CardDescription>Read-only in Phase 0.</CardDescription>
        </CardHeader>
        <CardContent>
          {tenants.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">No tenants yet.</p>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-left text-xs uppercase text-muted-foreground">
                  <th className="py-2 pe-3">Slug</th>
                  <th className="py-2 pe-3">Name</th>
                  <th className="py-2 pe-3">Country</th>
                  <th className="py-2 pe-3">Users</th>
                  <th className="py-2 pe-3">Active</th>
                  <th className="py-2">Created</th>
                </tr>
              </thead>
              <tbody>
                {tenants.map((t) => (
                  <tr key={t.id} className="border-b last:border-0">
                    <td className="py-2 pe-3 font-mono text-xs">{t.slug}</td>
                    <td className="py-2 pe-3">{t.name}</td>
                    <td className="py-2 pe-3">{t.country}</td>
                    <td className="py-2 pe-3">{t._count.users}</td>
                    <td className="py-2 pe-3">{t.active ? 'Yes' : 'No'}</td>
                    <td className="py-2 text-muted-foreground">
                      {t.createdAt.toISOString().slice(0, 10)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>
    </main>
  );
}
