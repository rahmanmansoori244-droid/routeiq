'use client';

import { AlertTriangle, Clock, Link2Off, RefreshCw } from 'lucide-react';
import type { LinkStateCode } from '@/lib/driver-link/manifest-types';
import { fmtDate, t, type Lang } from '@/lib/driver-page/i18n';

/**
 * The full-page states of a link that does not work (spec section 6.3): not found or revoked,
 * replaced by a reissue, expired, or driver links switched off. The page stops polling after these.
 */
export function LinkState({ lang, code, date }: { lang: Lang; code: LinkStateCode; date: string | null }) {
  const day = date ? fmtDate(lang)(date) : '';
  const text =
    code === 'LINK_REPLACED'
      ? t(lang, 'linkReplaced')
      : code === 'LINK_EXPIRED' || code === 'UPLOAD_CLOSED'
        ? t(lang, 'linkExpired', { date: day })
        : code === 'DRIVER_LINKS_OFF'
          ? t(lang, 'linksOff')
          : t(lang, 'linkInvalid');
  const Icon = code === 'LINK_EXPIRED' || code === 'UPLOAD_CLOSED' ? Clock : code === 'LINK_REPLACED' ? RefreshCw : code === 'DRIVER_LINKS_OFF' ? AlertTriangle : Link2Off;
  return (
    <div className="mx-auto flex min-h-[60vh] max-w-md flex-col items-center justify-center gap-4 p-6 text-center" data-testid="link-state" data-code={code}>
      <Icon className="h-14 w-14 text-slate-500" aria-hidden />
      <p className="text-lg font-semibold leading-snug">{text}</p>
    </div>
  );
}
