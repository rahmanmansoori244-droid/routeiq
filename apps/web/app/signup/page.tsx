import Link from 'next/link';
import { SignupForm } from './signup-form';
import { signupOpen } from '@/lib/signup-policy';

export const metadata = { title: 'Create tenant — RouteIQ' };
export const dynamic = 'force-dynamic';

export default function SignupPage() {
  const open = signupOpen();
  return (
    <main className="flex min-h-screen items-center justify-center bg-muted/30 px-4 py-12">
      <div className="w-full max-w-lg space-y-6">
        <div className="text-center">
          <h1 className="text-2xl font-semibold tracking-tight">Create your RouteIQ tenant</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {open
              ? 'One tenant per company. You will be the first admin.'
              : 'New companies are not being signed up here right now.'}
          </p>
        </div>
        {open ? (
          <SignupForm />
        ) : (
          <div className="rounded-lg border bg-card p-6 text-sm text-muted-foreground shadow-sm">
            To use RouteIQ for your company, contact the RouteIQ team. If your company already uses
            RouteIQ, ask your company&apos;s RouteIQ admin to invite you.
          </div>
        )}
        <p className="text-center text-sm text-muted-foreground">
          Already have an account?{' '}
          <Link className="text-primary hover:underline" href="/login">
            Sign in
          </Link>
        </p>
      </div>
    </main>
  );
}
