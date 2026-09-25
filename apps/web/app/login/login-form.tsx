'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { signIn } from 'next-auth/react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { safeCallbackUrl } from '@/lib/safe-redirect';

// Same text for every failure (wrong password, unknown email, inactive account, throttled), so the
// form never tells an attacker which case applies. Mirrors LOGIN_FAILED_MESSAGE in lib/auth-credentials.ts.
const LOGIN_FAILED = 'Invalid email or password. After several failed attempts, sign-in pauses for a few minutes.';

/** `callbackUrl` is already reduced to a same-origin path by the server; checked again here. */
export function LoginForm({ callbackUrl }: { callbackUrl: string }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    startTransition(async () => {
      const res = await signIn('credentials', { email, password, redirect: false });
      if (!res || res.error) {
        toast.error(LOGIN_FAILED);
        return;
      }
      router.replace(safeCallbackUrl(callbackUrl, window.location.origin));
      router.refresh();
    });
  }

  return (
    <form onSubmit={onSubmit} className="space-y-4 rounded-lg border bg-card p-6 shadow-sm">
      <div className="space-y-2">
        <Label htmlFor="email">Email</Label>
        <Input
          id="email"
          type="email"
          autoComplete="email"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          disabled={pending}
        />
      </div>
      <div className="space-y-2">
        <Label htmlFor="password">Password</Label>
        <Input
          id="password"
          type="password"
          autoComplete="current-password"
          required
          minLength={8}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          disabled={pending}
        />
      </div>
      <Button type="submit" className="w-full" disabled={pending}>
        {pending ? 'Signing in…' : 'Sign in'}
      </Button>
    </form>
  );
}
