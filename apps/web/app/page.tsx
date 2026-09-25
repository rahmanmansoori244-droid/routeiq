import { redirect } from 'next/navigation';
import { auth } from '@/lib/auth';
import { prisma } from '@/lib/db';
import { END_SESSION_PATH, redirectToSignIn } from '@/lib/session-redirect';

export default async function RootPage() {
  const session = await auth();
  // No usable session. If the browser still holds a cookie the edge middleware accepts, going to
  // /login would bounce straight back here (the old redirect loop), so clear it first.
  if (!session?.user) redirectToSignIn();

  if (session.user.role === 'SUPER_ADMIN') redirect('/admin');

  // A session only survives lib/session-principal.ts with an active tenant; these are backstops.
  if (!session.user.tenantId) redirect(END_SESSION_PATH);

  const tenant = await prisma.tenant.findUnique({
    where: { id: session.user.tenantId },
    select: { slug: true, active: true },
  });

  if (!tenant || !tenant.active) redirect(END_SESSION_PATH);
  redirect(`/t/${tenant.slug}`);
}
