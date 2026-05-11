'use client';

import { useEffect } from 'react';
import { AlertCircle } from 'lucide-react';
import { captureError } from '@/lib/observability';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

/**
 * Per-tenant-segment error boundary. Catches render errors inside any
 * /t/[slug]/... route and renders a contained fallback so the sidebar + nav
 * stay usable while the user retries.
 */
export default function TenantError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    captureError(error, { scope: 'tenant-segment' });
  }, [error]);

  return (
    <Card className="border-destructive/40">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <AlertCircle className="h-5 w-5 text-destructive" />
          Something went wrong on this page
        </CardTitle>
        <CardDescription>
          {error.digest ? <>Error ID: <code>{error.digest}</code></> : 'No error ID — the failure happened before the request was tracked.'}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3 text-sm text-muted-foreground">
        <p>
          The rest of the app is still available via the sidebar. If the same error happens after retrying, copy the
          ID above when you contact support.
        </p>
        <Button onClick={() => reset()}>Try again</Button>
      </CardContent>
    </Card>
  );
}
