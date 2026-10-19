'use client';

import { Ban, Clock, Link2Off, RefreshCw, UserX } from 'lucide-react';
import type { SalesLinkStateCode } from '@/lib/sales-link/view-types';
import { LINK_STATE_TEXT, shortDayText } from '@/lib/sales-page/format';

/**
 * The full-page states of a salesman link that does not work: unknown, replaced by a newer link, turned off,
 * expired (06:00 the day after delivery), links off on the server, or a RouteIQ session of another company in
 * this browser. The page stops asking after these.
 */
export function LinkState({ code, date }: { code: SalesLinkStateCode; date: string | null }) {
  const Icon = code === 'LINK_EXPIRED' ? Clock : code === 'LINK_REPLACED' ? RefreshCw : code === 'LINK_REVOKED' ? Ban : code === 'SIGNED_IN_OTHER_TENANT' ? UserX : Link2Off;
  return (
    <main className="mx-auto flex min-h-[70vh] max-w-md flex-col items-center justify-center gap-4 p-6 text-center" dir="ltr" data-testid="link-state" data-code={code}>
      <Icon className="h-14 w-14 text-slate-500" aria-hidden />
      <p className="text-lg font-semibold leading-snug">{LINK_STATE_TEXT[code]}</p>
      {date ? <p className="text-sm text-slate-600">Link of {shortDayText(date)}</p> : null}
    </main>
  );
}
