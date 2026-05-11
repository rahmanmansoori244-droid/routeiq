import { redirect } from 'next/navigation';
import { auth } from '@/lib/auth';
import { prisma } from '@/lib/db';

export default async function RootPage() {
  const session = await auth();
  if (!session?.user) redirect('/login');

  if (session.user.role === 'SUPER_ADMIN') redirect('/admin');

  if (!session.user.tenantId) redirect('/login');

  const tenant = await prisma.tenant.findUnique({
    where: { id: session.user.tenantId },
    select: { slug: true, active: true },
  });

  if (!tenant || !tenant.active) redirect('/login');
  redirect(`/t/${tenant.slug}`);
}
