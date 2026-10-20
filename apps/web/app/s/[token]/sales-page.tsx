'use client';

import { useEffect, useState } from 'react';
import { AlertTriangle, RefreshCw, WifiOff } from 'lucide-react';
import type { SalesMeta, SalesRouteView } from '@/lib/sales-link/view-types';
import { busyText, isFutureDay, noticeText, pageTitle, staleText, tabText, untilText, viewTitle } from '@/lib/sales-page/format';
import { dayText, dirOf, pickSalesLang, st, type SalesLang } from '@/lib/sales-page/i18n';
import { saveLang, savedLang } from '@/lib/sales-page/api';
import { ChoiceList } from './choice-list';
import { LangSwitch } from './lang-switch';
import { LinkState } from './link-state';
import { RouteForm } from './route-form';
import { RouteView } from './route-view';
import { useSalesView, type SalesViewState } from './use-sales-view';

/**
 * The salesman link's page (owner request 19 Oct 2026; made simple on the owner's feedback of 20 Oct 2026): one
 * read-only page per company and delivery date for the salesmen's WhatsApp group. The salesman types his route code
 * (or opens "/s/<token>#R1") and sees his customers: first the status buttons (delivered, on the way, delayed, partly
 * delivered, not delivered, cancelled) with their counts, then the customers of the status he taps - each with one
 * status and one time (delivered at, or about when and how far). No truck, trip, map or reason. English, Arabic or
 * Urdu (the switch at the top; remembered on the phone; first the phone's language). A truck code ("1234-AB",
 * "1234") still lists that truck's customers of the day (owner decision of 20 Oct 2026). Phone first (360 px and up);
 * refreshed every minute while visible.
 */
export function SalesPage() {
  const { state: s, submit, changeRoute, refresh, retry } = useSalesView();
  const [lang, setLang] = useState<SalesLang>('en');
  useEffect(() => {
    setLang(pickSalesLang(savedLang(), typeof navigator !== 'undefined' ? navigator.language : null));
  }, []);
  // The title above the page (WhatsApp's in-app browser shows it) in the language picked; layout.tsx's stays for previewers.
  useEffect(() => {
    try {
      document.title = pageTitle(lang);
    } catch {
      // no document (never in a browser)
    }
  }, [lang]);
  const choose = (l: SalesLang) => {
    setLang(l);
    saveLang(l);
  };
  const [active, setActive] = useState<string | null>(null);
  // A truck picked from the choices: its tab is the one shown when the answer comes (it is the lookup's last code).
  const pick = (query: string) => {
    const codes = query.split(', ');
    setActive(codes[codes.length - 1] ?? null);
    submit(query);
  };
  const results = s.phase === 'ready' ? (s.lookup?.results ?? []) : [];
  const current = results.find((r) => r.query === active) ?? results[0] ?? null;
  const date = s.meta?.date ?? null;
  return (
    <div className="pb-16" dir={dirOf(lang)} lang={lang} data-sales-lang={lang} data-testid="sales-page" data-phase={s.phase}>
      <Header lang={lang} onLang={choose} meta={s.meta} view={s.phase === 'ready' ? current : null} state={s} onRefresh={refresh} onChange={changeRoute} />
      {s.phase === 'link' && s.linkCode ? (
        <LinkState lang={lang} code={s.linkCode} date={s.linkDate} />
      ) : (
        <main className="mx-auto w-full max-w-xl space-y-4 px-4 pt-4 text-base">
          {s.phase === 'loading' ? <Loading lang={lang} waitSec={s.waitSec} /> : null}
          {s.phase === 'offline' ? (
            <div className="space-y-3 rounded-lg bg-white p-4 text-center shadow-sm ring-1 ring-slate-200" data-testid="offline" data-server-error={s.serverError ? 'true' : undefined}>
              {s.serverError ? <AlertTriangle className="mx-auto h-10 w-10 text-slate-500" aria-hidden /> : <WifiOff className="mx-auto h-10 w-10 text-slate-500" aria-hidden />}
              <p className="font-medium" aria-live="polite">
                {s.serverError ? st(lang, 'serverError') : st(lang, 'offline')}
              </p>
              <button type="button" onClick={retry} disabled={s.working} className="min-h-12 w-full rounded-md bg-slate-900 px-4 font-semibold text-white disabled:opacity-60">
                {s.working ? st(lang, 'loading') : st(lang, 'tryAgain')}
              </button>
            </div>
          ) : null}
          {s.phase === 'form' ? (
            <>
              <ChoiceList lang={lang} choices={s.choices} working={s.working} onPick={pick} />
              <RouteForm lang={lang} initial={s.formText} error={s.formError} date={date} working={s.working} waitSec={s.waitSec} onSubmit={submit} />
            </>
          ) : null}
          {s.phase === 'ready' && current && s.meta ? (
            <>
              {results.length > 1 ? (
                <div className="flex flex-wrap gap-2" role="tablist" data-testid="route-tabs">
                  {results.map((r) => {
                    const on = r.query === current.query;
                    return (
                      <button
                        key={r.query}
                        type="button"
                        role="tab"
                        aria-selected={on}
                        onClick={() => setActive(r.query)}
                        className={`min-h-11 rounded-full px-4 text-sm font-semibold ring-1 ${on ? 'bg-slate-900 text-white ring-slate-900' : 'bg-white text-slate-900 ring-slate-300'}`}
                        data-kind={r.kind}
                      >
                        {tabText(lang, r)}
                      </button>
                    );
                  })}
                </div>
              ) : null}
              {s.notice ? (
                <p className="rounded-md bg-amber-50 p-2 text-sm text-amber-900 ring-1 ring-amber-200" data-testid="route-notice">
                  {noticeText(lang, s.notice, date)}
                </p>
              ) : null}
              <ChoiceList lang={lang} choices={s.choices} working={s.working} onPick={pick} />
              {s.staleSince ? (
                <p className="flex items-start gap-2 rounded-md bg-slate-200 p-2 text-sm text-slate-800" data-testid="stale" aria-live="polite">
                  <WifiOff className="mt-0.5 h-4 w-4 shrink-0" aria-hidden /> {staleText(lang, current.updated)}
                </p>
              ) : null}
              {s.waitSec ? <p className="rounded-md bg-amber-50 p-2 text-sm text-amber-900">{busyText(lang, s.waitSec)}</p> : null}
              <RouteView key={current.query} view={current} lang={lang} future={isFutureDay(s.meta)} date={s.meta.date} />
            </>
          ) : null}
          <Footer lang={lang} meta={s.meta} />
        </main>
      )}
    </div>
  );
}

/**
 * The sticky header: the company and the language switch, then the route (or truck), the day and "Updated", Refresh
 * and Change route. Its first row is left to right in every language, so the switch stays at the top right when the
 * page turns right to left (review of 20 Oct 2026: a salesman who tapped the wrong language found it in the other
 * corner); the company's name keeps its own direction (dir="auto").
 */
export function Header({
  lang,
  onLang,
  meta,
  view,
  state,
  onRefresh,
  onChange,
}: {
  lang: SalesLang;
  onLang: (lang: SalesLang) => void;
  meta: SalesMeta | null;
  view: SalesRouteView | null;
  state: SalesViewState;
  onRefresh: () => void;
  onChange: () => void;
}) {
  return (
    <header className="sticky top-0 z-10 bg-slate-900 text-white shadow">
      <div className="mx-auto w-full max-w-xl space-y-2 px-4 py-3">
        <div className="flex items-center justify-between gap-2" dir="ltr" data-testid="header-top">
          <p className="min-w-0 truncate text-xs text-slate-300" dir="auto">
            {meta?.company || 'RouteIQ'}
          </p>
          <LangSwitch lang={lang} onPick={onLang} />
        </div>
        <div className="flex items-end justify-between gap-3">
          <div className="min-w-0">
            <h1 className="text-xl font-bold leading-tight" data-testid="sales-heading">
              {view ? viewTitle(lang, view) : st(lang, 'appTitle')}
            </h1>
            <p className="text-sm text-slate-300">
              {meta ? dayText(lang, meta.date) : null}
              {view ? <span data-testid="sales-updated">{` · ${st(lang, 'updated', { time: view.updated })}`}</span> : null}
            </p>
          </div>
          {view ? (
            <div className="flex shrink-0 items-center gap-2">
              <button
                type="button"
                onClick={onRefresh}
                disabled={state.working}
                aria-label={st(lang, 'refresh')}
                className="inline-flex h-11 w-11 items-center justify-center rounded-md bg-white/10 disabled:opacity-60"
                data-testid="sales-refresh"
              >
                <RefreshCw className={`h-5 w-5 ${state.working ? 'animate-spin' : ''}`} aria-hidden />
              </button>
              <button type="button" onClick={onChange} className="min-h-11 rounded-md bg-white px-3 text-sm font-semibold text-slate-900" data-testid="change-route">
                {st(lang, 'changeRoute')}
              </button>
            </div>
          ) : null}
        </div>
      </div>
    </header>
  );
}

function Loading({ lang, waitSec }: { lang: SalesLang; waitSec: number | null }) {
  return (
    <div className="space-y-3" aria-busy="true" data-testid="loading">
      {waitSec ? <p className="rounded-md bg-amber-50 p-2 text-sm text-amber-900">{busyText(lang, waitSec)}</p> : <p className="text-sm text-slate-600">{st(lang, 'loading')}</p>}
      <div className="h-24 animate-pulse rounded-lg bg-slate-200" />
      <div className="h-20 animate-pulse rounded-lg bg-slate-200" />
      <div className="h-20 animate-pulse rounded-lg bg-slate-200" />
    </div>
  );
}

function Footer({ lang, meta }: { lang: SalesLang; meta: SalesMeta | null }) {
  if (!meta) return null;
  const until = untilText(lang, meta);
  return (
    <footer className="space-y-1 px-1 pt-2 text-xs text-slate-500">
      <p>{st(lang, 'footerTimes')}</p>
      {until ? <p>{until}</p> : null}
    </footer>
  );
}
