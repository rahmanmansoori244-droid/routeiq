import Link from 'next/link';
import { SignupForm } from './signup-form';

export const metadata = { title: 'Create tenant — RouteIQ' };

export default function SignupPage() {
  return (
    <main className="flex min-h-screen items-center justify-center bg-muted/30 px-4 py-12">
      <div className="w-full max-w-lg space-y-6">
        <div className="text-center">
          <h1 className="text-2xl font-semibold tracking-tight">Create your RouteIQ tenant</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            One tenant per company. You will be the first admin.
          </p>
        </div>
        <SignupForm />
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
