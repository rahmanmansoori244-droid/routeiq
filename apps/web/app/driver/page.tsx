/**
 * Driver PWA login screen.
 *
 * The driver enters: tenant slug, driver code, 6-digit PIN. On success we
 * store the session token in localStorage and route to /driver/manifest.
 *
 * Mobile-first — large tap targets, no zoom on input focus.
 */
'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { Truck } from 'lucide-react';
import { toast } from 'sonner';
import { errorMessage } from '@/lib/error-message';

export default function DriverLoginPage() {
  const router = useRouter();
  const [tenantSlug, setTenantSlug] = useState('');
  const [driverCode, setDriverCode] = useState('');
  const [pin, setPin] = useState('');
  const [submitting, setSubmitting] = useState(false);

  // If a token already exists, jump straight to the manifest.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (window.localStorage.getItem('riq.driver.token')) {
      router.replace('/driver/manifest');
    }
  }, [router]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (submitting) return;
    setSubmitting(true);
    try {
      const res = await fetch('/api/driver/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          tenantSlug: tenantSlug.trim().toLowerCase(),
          driverCode: driverCode.trim(),
          pin: pin.trim(),
        }),
      });
      const json = await res.json();
      if (!res.ok || !json.data) {
        toast.error(errorMessage(json, 'Sign-in failed.'));
        // Clear PIN so the next attempt starts fresh (avoids retrying with a
        // half-typed PIN and leaking the partial value in screen recordings /
        // shoulder-surfing scenarios).
        setPin('');
        return;
      }
      window.localStorage.setItem('riq.driver.token', json.data.sessionToken);
      window.localStorage.setItem('riq.driver.name', json.data.driverName);
      window.localStorage.setItem('riq.driver.truck', json.data.truckCode);
      toast.success(`Welcome, ${json.data.driverName}`);
      router.push('/driver/manifest');
    } catch (err) {
      toast.error('Network error. Try again.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center px-6 py-10">
      <div className="mb-8 flex flex-col items-center text-center">
        <div className="mb-3 rounded-full bg-blue-600 p-4 text-white">
          <Truck className="h-8 w-8" />
        </div>
        <h1 className="text-2xl font-semibold">RouteIQ Driver</h1>
        <p className="mt-1 text-sm text-slate-600">Sign in to see your manifest and start your route.</p>
      </div>

      <form onSubmit={submit} className="space-y-4">
        <label className="block">
          <span className="text-sm font-medium text-slate-700">Company</span>
          <input
            inputMode="text"
            autoComplete="off"
            spellCheck={false}
            autoFocus
            placeholder="e.g. nmwc"
            value={tenantSlug}
            onChange={(e) => setTenantSlug(e.target.value)}
            className="mt-1 w-full rounded-md border border-slate-300 px-4 py-3 text-base focus:border-blue-600 focus:outline-none"
          />
        </label>

        <label className="block">
          <span className="text-sm font-medium text-slate-700">Driver code</span>
          <input
            inputMode="text"
            autoComplete="off"
            spellCheck={false}
            placeholder="e.g. DR-001"
            value={driverCode}
            onChange={(e) => setDriverCode(e.target.value)}
            className="mt-1 w-full rounded-md border border-slate-300 px-4 py-3 text-base focus:border-blue-600 focus:outline-none"
          />
        </label>

        <label className="block">
          <span className="text-sm font-medium text-slate-700">PIN</span>
          <input
            inputMode="numeric"
            pattern="[0-9]*"
            autoComplete="off"
            type="password"
            maxLength={12}
            placeholder="••••••"
            value={pin}
            onChange={(e) => setPin(e.target.value)}
            className="mt-1 w-full rounded-md border border-slate-300 px-4 py-3 text-center text-2xl tracking-widest focus:border-blue-600 focus:outline-none"
          />
        </label>

        <button
          type="submit"
          disabled={submitting || !tenantSlug || !driverCode || !pin}
          className="w-full rounded-md bg-blue-600 px-4 py-3 text-base font-medium text-white shadow-sm hover:bg-blue-700 disabled:opacity-50"
        >
          {submitting ? 'Signing in…' : 'Start shift'}
        </button>
      </form>

      <p className="mt-8 text-center text-xs text-slate-500">
        Trouble signing in? Ask your dispatcher for your driver code and PIN.
      </p>
    </main>
  );
}
