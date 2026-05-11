import { Suspense } from 'react';
import Link from 'next/link';
import { ResetForm } from './reset-form';

export const metadata = { title: 'Reset password — RouteIQ' };

export default function ResetPage() {
  return (
    <main className="flex min-h-screen items-center justify-center bg-muted/30 px-4">
      <div className="w-full max-w-sm space-y-6">
        <div className="text-center">
          <h1 className="text-2xl font-semibold tracking-tight">Set a new password</h1>
          <p className="mt-1 text-sm text-muted-foreground">Reset links are single-use and expire after 24 hours.</p>
        </div>
        <Suspense fallback={<div className="text-center text-sm text-muted-foreground">Loading…</div>}>
          <ResetForm />
        </Suspense>
        <p className="text-center text-sm text-muted-foreground">
          <Link className="text-primary hover:underline" href="/login">
            Back to sign in
          </Link>
        </p>
      </div>
    </main>
  );
}
