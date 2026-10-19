'use client';

import { useState } from 'react';
import { AlertTriangle, RefreshCw, WifiOff } from 'lucide-react';
import type { SalesMeta, SalesRouteView } from '@/lib/sales-link/view-types';
import { UI } from '@/lib/sales-page/format';
import { LinkState } from './link-state';
import { RouteForm } from './route-form';
import { RouteView } from './route-view';
import { useSalesView, type SalesViewState } from './use-sales-view';

/**
 * The salesman link's page (owner request 19 Oct 2026): one read-only page per company and delivery date for the
 * salesmen's WhatsApp group. The salesman types his route code (or opens "/s/<token>#R1") and follows his
 * customers' deliveries live: delivered, on the way with the expected time, delayed against the printed window,
 * not delivered with the driver's reason, cancelled; the truck and, while it is on the road with his deliveries,
 * its approximate position. Mobile first (360 x 640 and up); refreshed every minute while visible.
 */
export function SalesPage() {
  const { state: s, submit, changeRoute, refresh, retry } = useSalesView();
  const [active, setActive] = useState<string | null>(null);
  if (s.phase === 'link' && s.linkCode) return <LinkState code={s.linkCode} date={s.linkDate} />;
  const routes = s.phase === 'ready' ? s.lookup?.routes ?? [] : [];
  const current = routes.find((r) => r.route === active) ?? routes[0] ?? null;
  return (
    <div className="pb-16" dir="ltr" data-testid="sales-page" data-phase={s.phase}>
      <Header meta={s.meta} view={current} state={s} onRefresh={refresh} onChange={changeRoute} />
      <main className="mx-auto w-full max-w-xl space-y-4 px-3 pt-4 text-base">
        {s.phase === 'loading' ? <Loading waitSec={s.waitSec} /> : null}
        {s.phase === 'offline' ? (
          <div className="space-y-3 rounded-lg bg-white p-4 text-center shadow-sm ring-1 ring-slate-200" data-testid="offline" data-server-error={s.serverError ? 'true' : undefined}>
            {s.serverError ? <AlertTriangle className="mx-auto h-10 w-10 text-slate-500" aria-hidden /> : <WifiOff className="mx-auto h-10 w-10 text-slate-500" aria-hidden />}
            <p className="font-medium" aria-live="polite">
              {s.serverError ? UI.serverError : UI.offline}
            </p>
            <button type="button" onClick={retry} disabled={s.working} className="min-h-12 w-full rounded-md bg-slate-900 px-4 font-semibold text-white disabled:opacity-60">
              {s.working ? UI.loading : UI.tryAgain}
            </button>
          </div>
        ) : null}
        {s.phase === 'form' ? <RouteForm initial={s.formText} hint={s.meta?.routeHint ?? null} error={s.formError} working={s.working} waitSec={s.waitSec} onSubmit={submit} /> : null}
        {s.phase === 'ready' && current ? (
          <>
            {routes.length > 1 ? (
              <div className="flex flex-wrap gap-2" role="tablist" aria-label="Your routes" data-testid="route-tabs">
                {routes.map((r) => {
                  const on = r.route === current.route;
                  return (
                    <button
                      key={r.route}
                      type="button"
                      role="tab"
                      aria-selected={on}
                      onClick={() => setActive(r.route)}
                      className={`min-h-11 rounded-full px-4 text-sm font-semibold ring-1 ${on ? 'bg-slate-900 text-white ring-slate-900' : 'bg-white text-slate-900 ring-slate-300'}`}
                    >
                      Route {r.route} · {r.deliveries.length}
                    </button>
                  );
                })}
              </div>
            ) : null}
            {s.notice ? (
              <p className="rounded-md bg-amber-50 p-2 text-sm text-amber-900 ring-1 ring-amber-200" data-testid="route-notice">
                {s.notice}
              </p>
            ) : null}
            {s.staleSince ? (
              <p className="flex items-start gap-2 rounded-md bg-slate-200 p-2 text-sm text-slate-800" data-testid="stale" aria-live="polite">
                <WifiOff className="mt-0.5 h-4 w-4 shrink-0" aria-hidden /> {UI.stale(current.updatedText)}
              </p>
            ) : null}
            {s.waitSec ? <p className="rounded-md bg-amber-50 p-2 text-sm text-amber-900">{UI.busy(s.waitSec)}</p> : null}
            <RouteView key={current.route} view={current} />
          </>
        ) : null}
        <Footer meta={s.meta} />
      </main>
    </div>
  );
}

function Header({ meta, view, state, onRefresh, onChange }: { meta: SalesMeta | null; view: SalesRouteView | null; state: SalesViewState; onRefresh: () => void; onChange: () => void }) {
  return (
    <header className="sticky top-0 z-10 bg-slate-900 text-white shadow">
      <div className="mx-auto flex w-full max-w-xl items-start justify-between gap-3 px-4 py-3">
        <div className="min-w-0">
          <p className="truncate text-xs uppercase tracking-wide text-slate-300">{meta?.company || 'RouteIQ'}</p>
          <h1 className="text-xl font-bold leading-tight" data-testid="sales-heading">
            {view ? `Route ${view.route}` : UI.title}
          </h1>
          <p className="text-sm text-slate-300">
            {meta ? (view ? meta.dayShort : meta.dayText) : null}
            {view ? <span data-testid="sales-updated">{` · ${view.updatedText}`}</span> : null}
          </p>
        </div>
        {view ? (
          <div className="flex shrink-0 flex-col items-end gap-2">
            <button
              type="button"
              onClick={onRefresh}
              disabled={state.working}
              aria-label={UI.refresh}
              className="inline-flex h-10 w-10 items-center justify-center rounded-md bg-white/10 disabled:opacity-60"
              data-testid="sales-refresh"
            >
              <RefreshCw className={`h-5 w-5 ${state.working ? 'animate-spin' : ''}`} aria-hidden />
            </button>
            <button type="button" onClick={onChange} className="min-h-9 rounded-md bg-white px-3 text-sm font-semibold text-slate-900" data-testid="change-route">
              {UI.changeRoute}
            </button>
          </div>
        ) : null}
      </div>
    </header>
  );
}

function Loading({ waitSec }: { waitSec: number | null }) {
  return (
    <div className="space-y-3" aria-busy="true" data-testid="loading">
      {waitSec ? <p className="rounded-md bg-amber-50 p-2 text-sm text-amber-900">{UI.busy(waitSec)}</p> : <p className="text-sm text-slate-600">{UI.loading}</p>}
      <div className="h-20 animate-pulse rounded-lg bg-slate-200" />
      <div className="h-28 animate-pulse rounded-lg bg-slate-200" />
      <div className="h-28 animate-pulse rounded-lg bg-slate-200" />
    </div>
  );
}

function Footer({ meta }: { meta: SalesMeta | null }) {
  if (!meta) return null;
  return (
    <footer className="space-y-1 px-1 pt-2 text-xs text-slate-500">
      <p>
        {UI.readOnly(meta.tz)} {UI.refreshes}
      </p>
      <p>{meta.expiryText}. For the sales team only - please do not forward.</p>
    </footer>
  );
}
