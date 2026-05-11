'use client';

import { useEffect } from 'react';
import Link from 'next/link';
import { Button } from '@/components/ui/button';

export default function GlobalError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <main className="flex min-h-screen items-center justify-center bg-muted/30 px-4">
      <div className="max-w-md space-y-4 text-center">
        <p className="text-sm font-medium uppercase tracking-wide text-destructive">Something went wrong</p>
        <h1 className="text-xl font-semibold tracking-tight">An unexpected error occurred</h1>
        {error.digest ? (
          <p className="text-xs text-muted-foreground">Error ID: {error.digest}</p>
        ) : null}
        <div className="flex justify-center gap-2">
          <Button onClick={() => reset()} variant="outline">
            Try again
          </Button>
          <Button asChild>
            <Link href="/">Go home</Link>
          </Button>
        </div>
      </div>
    </main>
  );
}
