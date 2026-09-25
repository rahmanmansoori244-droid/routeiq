'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { signIn } from 'next-auth/react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { errorMessage } from '@/lib/error-message';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { COUNTRY_NAMES, countryRoutingNote } from '@/lib/countries';

interface FormState {
  companyName: string;
  slug: string;
  country: string;
  currency: string;
  primaryUnit: 'CASES' | 'CARTONS' | 'PALLETS' | 'KG';
  name: string;
  email: string;
  password: string;
}

const INITIAL: FormState = {
  companyName: '',
  slug: '',
  country: 'Oman',
  currency: 'OMR',
  primaryUnit: 'CASES',
  name: '',
  email: '',
  password: '',
};

export function SignupForm() {
  const router = useRouter();
  const [form, setForm] = useState<FormState>(INITIAL);
  const [pending, startTransition] = useTransition();

  function update<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm((prev) => ({ ...prev, [key]: value }));
  }

  function suggestSlug(company: string) {
    return company
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 32);
  }

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    startTransition(async () => {
      const res = await fetch('/api/auth/signup', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(form),
      });
      const body = (await res.json()) as { data?: { tenantSlug: string }; error?: unknown };
      if (!res.ok || !body.data) {
        toast.error(errorMessage(body, 'Signup failed.'));
        return;
      }
      const signinRes = await signIn('credentials', {
        email: form.email,
        password: form.password,
        redirect: false,
      });
      if (!signinRes || signinRes.error) {
        toast.error('Account created, but auto sign-in failed. Please log in.');
        router.replace('/login');
        return;
      }
      router.replace(`/t/${body.data.tenantSlug}/onboard`);
      router.refresh();
    });
  }

  return (
    <form onSubmit={onSubmit} className="space-y-4 rounded-lg border bg-card p-6 shadow-sm">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div className="space-y-2">
          <Label htmlFor="companyName">Company name</Label>
          <Input
            id="companyName"
            required
            value={form.companyName}
            onChange={(e) => {
              update('companyName', e.target.value);
              if (!form.slug) update('slug', suggestSlug(e.target.value));
            }}
            disabled={pending}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="slug">Tenant slug</Label>
          <Input
            id="slug"
            required
            value={form.slug}
            onChange={(e) => update('slug', e.target.value.toLowerCase())}
            placeholder="nmwc"
            pattern="[a-z][a-z0-9-]{2,31}"
            disabled={pending}
          />
          <p className="text-xs text-muted-foreground">Used in URLs: /t/{form.slug || 'your-slug'}</p>
        </div>
        <div className="space-y-2">
          <Label htmlFor="country">Country</Label>
          <Select value={form.country} onValueChange={(v) => update('country', v)} disabled={pending}>
            <SelectTrigger id="country">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {COUNTRY_NAMES.map((n) => (
                <SelectItem key={n} value={n}>
                  {n}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="text-xs text-muted-foreground">{countryRoutingNote(form.country)}</p>
        </div>
        <div className="space-y-2">
          <Label htmlFor="currency">Currency</Label>
          <Input
            id="currency"
            required
            value={form.currency}
            onChange={(e) => update('currency', e.target.value.toUpperCase())}
            maxLength={5}
            disabled={pending}
          />
        </div>
        <div className="space-y-2 sm:col-span-2">
          <Label htmlFor="primaryUnit">Primary unit</Label>
          <select
            id="primaryUnit"
            className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
            value={form.primaryUnit}
            onChange={(e) => update('primaryUnit', e.target.value as FormState['primaryUnit'])}
            disabled={pending}
          >
            <option value="CASES">Cases</option>
            <option value="CARTONS">Cartons</option>
            <option value="PALLETS">Pallets</option>
            <option value="KG">Kilograms</option>
          </select>
        </div>
      </div>

      <div className="border-t pt-4">
        <p className="mb-2 text-sm font-medium">Admin user</p>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="name">Your name</Label>
            <Input
              id="name"
              required
              value={form.name}
              onChange={(e) => update('name', e.target.value)}
              disabled={pending}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="email">Email</Label>
            <Input
              id="email"
              type="email"
              autoComplete="email"
              required
              value={form.email}
              onChange={(e) => update('email', e.target.value)}
              disabled={pending}
            />
          </div>
          <div className="space-y-2 sm:col-span-2">
            <Label htmlFor="password">Password</Label>
            <Input
              id="password"
              type="password"
              autoComplete="new-password"
              required
              minLength={8}
              value={form.password}
              onChange={(e) => update('password', e.target.value)}
              disabled={pending}
            />
            <p className="text-xs text-muted-foreground">Minimum 8 characters.</p>
          </div>
        </div>
      </div>

      <Button type="submit" className="w-full" disabled={pending}>
        {pending ? 'Creating tenant…' : 'Create tenant'}
      </Button>
    </form>
  );
}
