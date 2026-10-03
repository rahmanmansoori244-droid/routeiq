'use client';

import { CheckCircle2, CloudUpload, WifiOff } from 'lucide-react';
import { t, type Lang } from '@/lib/driver-page/i18n';

/**
 * The header chip (spec section 13.2): "All sent", "Waiting to send (n)" or "No signal". n counts the
 * results, arrivals and photos ready to go (arrivals kept for a trip not dispatched yet are not counted).
 */
export function SyncBadge({ lang, waiting, online }: { lang: Lang; waiting: number; online: boolean }) {
  if (!online) {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-red-600 px-2 py-1 text-xs font-semibold text-white" data-testid="sync-badge" data-state="offline">
        <WifiOff className="h-4 w-4" aria-hidden /> {t(lang, 'noSignal')}
        {waiting ? ` · ${waiting}` : ''}
      </span>
    );
  }
  if (waiting > 0) {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-amber-400 px-2 py-1 text-xs font-semibold text-amber-950" data-testid="sync-badge" data-state="waiting">
        <CloudUpload className="h-4 w-4" aria-hidden /> {t(lang, 'waitingToSend', { n: waiting })}
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-emerald-600 px-2 py-1 text-xs font-semibold text-white" data-testid="sync-badge" data-state="sent">
      <CheckCircle2 className="h-4 w-4" aria-hidden /> {t(lang, 'allSent')}
    </span>
  );
}
