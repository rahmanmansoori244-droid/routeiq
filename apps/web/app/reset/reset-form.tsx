'use client';

import { useState, useTransition } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

export function ResetForm() {
  const router = useRouter();
  const params = useSearchParams();
  const token = params.get('token') ?? '';
  const [pwd, setPwd] = useState('');
  const [confirm, setConfirm] = useState('');
  const [pending, startTransition] = useTransition();

  if (!token) {
    return (
      <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-4 text-sm">
        Missing reset token. Open the link from your email — it must include a <code>?token=…</code> parameter.
      </div>
    );
  }

  function submit(e: React.FormEvent) {
    e.preventDefault();
    if (pwd.length < 8) {
      toast.error('Password must be at least 8 characters.');
      return;
    }
    if (pwd !== confirm) {
      toast.error('Passwords do not match.');
      return;
    }
    startTransition(async () => {
      const res = await fetch('/api/auth/reset', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token, newPassword: pwd }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(typeof body.error === 'string' ? body.error : 'Reset failed.');
        return;
      }
      toast.success('Password updated. Sign in with your new password.');
      router.replace('/login');
    });
  }

  return (
    <form onSubmit={submit} className="space-y-4 rounded-lg border bg-card p-6 shadow-sm">
      <div className="space-y-2">
        <Label htmlFor="pwd">New password</Label>
        <Input
          id="pwd"
          type="password"
          autoComplete="new-password"
          required
          minLength={8}
          value={pwd}
          onChange={(e) => setPwd(e.target.value)}
          disabled={pending}
        />
        <p className="text-xs text-muted-foreground">Minimum 8 characters.</p>
      </div>
      <div className="space-y-2">
        <Label htmlFor="confirm">Confirm password</Label>
        <Input
          id="confirm"
          type="password"
          autoComplete="new-password"
          required
          minLength={8}
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          disabled={pending}
        />
      </div>
      <Button type="submit" className="w-full" disabled={pending}>
        {pending ? 'Updating…' : 'Reset password'}
      </Button>
    </form>
  );
}
