import Link from 'next/link';
import { LoginForm } from './login-form';
import { safeCallbackUrl } from '@/lib/safe-redirect';
import { signupOpen } from '@/lib/signup-policy';

export const metadata = { title: 'Sign in — RouteIQ' };
export const dynamic = 'force-dynamic';

// Only the path matters server-side: relative values resolve against it, absolute ones for any
// other host fall back to '/'. The form checks again against the real browser origin.
const SERVER_ORIGIN = 'http://routeiq.internal';

function first(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

export default function LoginPage({ searchParams }: { searchParams: Record<string, string | string[] | undefined> }) {
  const callbackUrl = safeCallbackUrl(first(searchParams.callbackUrl), SERVER_ORIGIN);
  const sessionEnded = first(searchParams.reason) === 'session';
  const canSignUp = signupOpen();

  return (
    <main className="flex min-h-screen items-center justify-center bg-muted/30 px-4">
      <div className="w-full max-w-sm space-y-6">
        <div className="text-center">
          <h1 className="text-2xl font-semibold tracking-tight">RouteIQ</h1>
          <p className="mt-1 text-sm text-muted-foreground">Sign in to your tenant.</p>
        </div>
        {sessionEnded ? (
          <p className="rounded-md border bg-card px-3 py-2 text-center text-sm text-muted-foreground" role="status">
            Your session has ended. Please sign in again.
          </p>
        ) : null}
        <LoginForm callbackUrl={callbackUrl} />
        <p className="text-center text-sm text-muted-foreground">
          <Link className="text-primary hover:underline" href="/forgot">
            Forgot your password?
          </Link>
        </p>
        {canSignUp ? (
          <p className="text-center text-sm text-muted-foreground">
            New tenant?{' '}
            <Link className="text-primary hover:underline" href="/signup">
              Create one
            </Link>
          </p>
        ) : null}
      </div>
    </main>
  );
}
