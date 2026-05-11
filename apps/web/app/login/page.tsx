import { Suspense } from 'react';
import Link from 'next/link';
import { LoginForm } from './login-form';

export const metadata = { title: 'Sign in — RouteIQ' };

export default function LoginPage() {
  return (
    <main className="flex min-h-screen items-center justify-center bg-muted/30 px-4">
      <div className="w-full max-w-sm space-y-6">
        <div className="text-center">
          <h1 className="text-2xl font-semibold tracking-tight">RouteIQ</h1>
          <p className="mt-1 text-sm text-muted-foreground">Sign in to your tenant.</p>
        </div>
        <Suspense fallback={<div className="text-center text-sm text-muted-foreground">Loading…</div>}>
          <LoginForm />
        </Suspense>
        <p className="text-center text-sm text-muted-foreground">
          <Link className="text-primary hover:underline" href="/forgot">
            Forgot your password?
          </Link>
        </p>
        <p className="text-center text-sm text-muted-foreground">
          New tenant?{' '}
          <Link className="text-primary hover:underline" href="/signup">
            Create one
          </Link>
        </p>
      </div>
    </main>
  );
}
