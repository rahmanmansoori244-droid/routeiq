'use client';

import { useEffect } from 'react';

// Keys the retired driver app kept in the phone's browser storage (including the shift token).
const DRIVER_APP_KEYS = ['riq.driver.token', 'riq.driver.name', 'riq.driver.truck'];

/** Shown at /driver and /driver/manifest: the driver phone app is retired (lib/driver-app.ts). */
export function DriverAppRetiredNotice() {
  useEffect(() => {
    try {
      for (const k of DRIVER_APP_KEYS) window.localStorage.removeItem(k);
    } catch {
      // Storage blocked (private mode): nothing to clear.
    }
  }, []);

  return (
    <main className="flex min-h-screen items-center justify-center px-6">
      <div className="max-w-sm space-y-3 text-center">
        <h1 className="text-xl font-semibold">The RouteIQ driver app is retired</h1>
        <p className="text-sm text-slate-600">
          Your loads, stops and customer locations now come from the driver sheet or the WhatsApp message
          your dispatcher sends you. You can close this page.
        </p>
      </div>
    </main>
  );
}
