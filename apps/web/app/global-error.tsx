'use client';

import * as Sentry from '@sentry/nextjs';
import { useEffect } from 'react';
import Link from 'next/link';

export default function GlobalError({ error }: { error: Error & { digest?: string } }) {
  useEffect(() => {
    Sentry.captureException(error);
    // Also log to console so dev sees the stack trace.
    console.error(error);
  }, [error]);

  return (
    <html>
      <body>
        <main style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16, fontFamily: 'system-ui' }}>
          <div style={{ maxWidth: 480, textAlign: 'center' }}>
            <p style={{ fontSize: 12, textTransform: 'uppercase', letterSpacing: '0.08em', color: '#b91c1c' }}>
              Something went wrong
            </p>
            <h1 style={{ fontSize: 20, fontWeight: 600, marginTop: 8, marginBottom: 12 }}>
              An unexpected error occurred
            </h1>
            {error.digest ? (
              <p style={{ fontSize: 12, color: '#64748b' }}>Error ID: {error.digest}</p>
            ) : null}
            <p style={{ marginTop: 16 }}>
              <Link href="/" style={{ color: '#2563eb', textDecoration: 'underline' }}>
                Go home
              </Link>
            </p>
          </div>
        </main>
      </body>
    </html>
  );
}
