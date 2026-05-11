import Link from 'next/link';
import { ForgotForm } from './forgot-form';

export const metadata = { title: 'Forgot password — RouteIQ' };

export default function ForgotPage() {
  return (
    <main className="flex min-h-screen items-center justify-center bg-muted/30 px-4">
      <div className="w-full max-w-sm space-y-6">
        <div className="text-center">
          <h1 className="text-2xl font-semibold tracking-tight">Reset your password</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            We'll email you a link if there's an account at that address.
          </p>
        </div>
        <ForgotForm />
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
