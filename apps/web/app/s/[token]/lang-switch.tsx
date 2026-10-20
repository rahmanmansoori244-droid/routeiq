'use client';

import { dirOf, LANG_NAME, SALES_LANGS, st, type SalesLang } from '@/lib/sales-page/i18n';

/**
 * The language switch at the top of the salesman page (owner feedback of 20 Oct 2026): English, Arabic and Urdu, each
 * in its own script, always in this order, 44 px at least (the page's rule for every button). The page remembers the
 * choice on this phone (riq.s.lang); without one it follows the phone's language. The header keeps the switch at the
 * top right in every language (sales-page.tsx).
 */
export function LangSwitch({ lang, onPick }: { lang: SalesLang; onPick: (lang: SalesLang) => void }) {
  return (
    // The same order in every direction: a salesman who taps the wrong one finds the others where they were.
    <div className="flex shrink-0 items-center gap-1.5" dir="ltr" role="group" aria-label={st(lang, 'language')} data-testid="lang-switch">
      {SALES_LANGS.map((l) => {
        const on = l === lang;
        return (
          <button
            key={l}
            type="button"
            lang={l}
            dir={dirOf(l)}
            aria-pressed={on}
            onClick={() => onPick(l)}
            className={`min-h-11 min-w-11 rounded-md px-2.5 text-sm font-semibold ${on ? 'bg-white text-slate-900' : 'bg-white/10 text-white'}`}
            data-testid={`lang-${l}`}
          >
            {LANG_NAME[l]}
          </button>
        );
      })}
    </div>
  );
}
