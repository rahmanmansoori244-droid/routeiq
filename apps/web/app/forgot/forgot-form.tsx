'use client';

import { useState, useTransition } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

export function ForgotForm() {
  const [email, setEmail] = useState('');
  const [pending, startTransition] = useTransition();
  const [sent, setSent] = useState(false);

  function submit(e: React.FormEvent) {
    e.preventDefault();
    startTransition(async () => {
      const res = await fetch('/api/auth/forgot', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email }),
      });
      // Server always returns 200 to prevent enumeration.
      if (!res.ok) {
        toast.error('Something went wrong. Try again.');
        return;
      }
      setSent(true);
    });
  }

  if (sent) {
    return (
      <div className="rounded-lg border bg-card p-6 text-center text-sm">
        <p className="font-medium">Check your inbox.</p>
        <p className="mt-1 text-muted-foreground">
          If <strong>{email}</strong> matches an account, a reset link is on its way. The link is valid for 24 hours.
        </p>
      </div>
    );
  }

  return (
    <form onSubmit={submit} className="space-y-4 rounded-lg border bg-card p-6 shadow-sm">
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
      <Button type="submit" className="w-full" disabled={pending}>
        {pending ? 'Sending…' : 'Send reset link'}
      </Button>
    </form>
  );
}
