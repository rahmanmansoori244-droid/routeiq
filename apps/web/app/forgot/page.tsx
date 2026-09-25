import Link from 'next/link';
import { resetByEmailAvailable } from '@/lib/password-reset';
import { ForgotForm } from './forgot-form';

export const metadata = { title: 'Forgot password — RouteIQ' };
// Reads the email settings at request time, not at build time.
export const dynamic = 'force-dynamic';

export default function ForgotPage() {
  // Without reset email (production with no RESEND_API_KEY), the form would send nothing: say so,
  // and point to the admin reset on the Users screen instead.
  const byEmail = resetByEmailAvailable();
  return (
    <main className="flex min-h-screen items-center justify-center bg-muted/30 px-4">
      <div className="w-full max-w-sm space-y-6">
        <div className="text-center">
          <h1 className="text-2xl font-semibold tracking-tight">Reset your password</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {byEmail ? "We'll email you a link if there's an account at that address." : 'Reset by email is not available.'}
          </p>
        </div>
        {byEmail ? (
          <ForgotForm />
        ) : (
          <p className="rounded-lg border bg-card p-6 text-center text-sm text-muted-foreground" role="status">
            Ask an admin of your company to reset your password (Users, then &quot;Reset password&quot;). They will give
            you a new temporary password.
          </p>
        )}
        <p className="text-center text-sm text-muted-foreground">
          Remembered it?{' '}
          <Link className="text-primary hover:underline" href="/login">
            Sign in
          </Link>
        </p>
      </div>
    </main>
  );
}
