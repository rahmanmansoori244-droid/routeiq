'use client';

import { useEffect, useState } from 'react';
import { Chrome, Compass, Copy } from 'lucide-react';
import { chromeIntentUrl, inAppBrowser, isAndroid, isIos } from '@/lib/driver-page/webview';
import { t, type Lang } from '@/lib/driver-page/i18n';

/**
 * The "open in your browser" card (spec section 6.1). Shown when the page runs inside an in-app
 * browser (detected by its user agent, or `failed`: a location refused without a prompt, a camera
 * input that never opened). Android: Open in Chrome (an intent link that falls back to the link
 * itself). iOS: how to open it in Safari, with Copy link. The page keeps working read-only below it.
 */
export function WebviewGate({ lang, failed = false }: { lang: Lang; failed?: boolean }) {
  const [ua, setUa] = useState<string | null>(null);
  const [href, setHref] = useState('');
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    setUa(navigator.userAgent);
    setHref(window.location.href);
  }, []);
  if (ua === null) return null;
  if (!inAppBrowser(ua) && !failed) return null;

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(href);
      setCopied(true);
    } catch {
      // Some in-app browsers refuse the clipboard: the link stays selectable below.
      setCopied(false);
    }
  };

  return (
    <div className="m-3 rounded-xl border-2 border-amber-500 bg-amber-50 p-4" data-testid="webview-gate" role="alert">
      <p className="text-base font-bold">{t(lang, 'inAppTitle')}</p>
      <p className="mt-1 text-sm">{t(lang, 'inAppBody')}</p>
      <div className="mt-3 flex flex-wrap gap-2">
        {isAndroid(ua) ? (
          <a
            href={chromeIntentUrl(href)}
            rel="noreferrer noopener"
            className="inline-flex min-h-12 items-center gap-2 rounded-lg bg-slate-900 px-4 text-base font-semibold text-white"
            data-testid="open-in-chrome"
          >
            <Chrome className="h-5 w-5" aria-hidden /> {t(lang, 'openInChrome')}
          </a>
        ) : null}
        {isIos(ua) ? (
          <p className="flex items-center gap-2 text-sm font-semibold">
            <Compass className="h-5 w-5 shrink-0" aria-hidden /> {t(lang, 'openInSafari')}
          </p>
        ) : null}
        {!isAndroid(ua) ? (
          <button type="button" onClick={copy} className="inline-flex min-h-12 items-center gap-2 rounded-lg border border-slate-400 bg-white px-4 text-base font-semibold">
            <Copy className="h-5 w-5" aria-hidden /> {copied ? t(lang, 'linkCopied') : t(lang, 'copyLink')}
          </button>
        ) : null}
      </div>
    </div>
  );
}
