'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, ChevronDown, Clock, Info, Languages, MapPin, Navigation, Package, Phone, StickyNote, Truck } from 'lucide-react';
import type { DriverManifest, LinkStateCode, ManifestLoad, ManifestStop } from '@/lib/driver-link/manifest-types';
import { deviceId, fetchManifest, safeLocalStorage, tokenFromPath } from '@/lib/driver-page/api';
import { driverNames, openTripIndex, stopTitle, telHref, tripLine } from '@/lib/driver-page/format';
import { fmtDate, fmtHours, hhmm, LANG_TOGGLE, pickLang, statusLabel, t, type Lang } from '@/lib/driver-page/i18n';
import { LinkState } from './link-state';
import { WebviewGate } from './webview-gate';

/**
 * The driver's phone page (owner request 4 Oct 2026, spec section 6). Part 1: read-only - the
 * truck-day's trips in departure order with their status, and per stop the customer, the Navigate
 * button to the planned pin, the planned arrival and unloading end, the hours or promised time, the
 * cases per order line and the notes. Results, the stop timer and photos come in Part 2.
 *
 * Mobile first (360 x 640 and up): big buttons, few words, an icon next to each. English / Arabic
 * (RTL). The page polls every 60 s while visible; after a 404 or 410 it stops for good.
 */

const POLL_MS = 60_000;
const NOTICE_KEY = 'riq.d.notice';
const LANG_KEY = 'riq.d.lang';

type Phase =
  | { kind: 'loading' }
  | { kind: 'ready'; manifest: DriverManifest }
  | { kind: 'link'; code: LinkStateCode; date: string | null }
  | { kind: 'offline' };

function storeGet(key: string): string | null {
  try {
    return safeLocalStorage()?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

function storeSet(key: string, value: string): void {
  try {
    safeLocalStorage()?.setItem(key, value);
  } catch {
    // Private mode or blocked storage: the choice lasts for this page view only.
  }
}

const STATUS_TONE: Record<string, string> = {
  PLANNED: 'bg-slate-200 text-slate-800',
  LOCKED: 'bg-slate-300 text-slate-900',
  LOADING: 'bg-amber-200 text-amber-950',
  DISPATCHED: 'bg-emerald-600 text-white',
  COMPLETED: 'bg-slate-700 text-white',
};

export function DriverPage() {
  const [lang, setLang] = useState<Lang>('en');
  const [phase, setPhase] = useState<Phase>({ kind: 'loading' });
  const [openTrip, setOpenTrip] = useState<number | null>(null);
  const [openStop, setOpenStop] = useState<{ loadNo: number; key: string } | null>(null);
  const [notice, setNotice] = useState(false);
  const token = useRef<string | null>(null);
  const device = useRef<string>('');
  const stopped = useRef(false);
  const retryAt = useRef(0);

  useEffect(() => {
    setLang(pickLang(storeGet(LANG_KEY), navigator.language));
    token.current = tokenFromPath(window.location.pathname);
    device.current = deviceId();
  }, []);

  const load = useCallback(async () => {
    if (stopped.current || Date.now() < retryAt.current) return;
    if (!token.current) {
      stopped.current = true;
      setPhase({ kind: 'link', code: 'LINK_NOT_FOUND', date: null });
      return;
    }
    const a = await fetchManifest(token.current, device.current);
    if (a.kind === 'ok') {
      setPhase({ kind: 'ready', manifest: a.manifest });
      return;
    }
    if (a.kind === 'link') {
      // 404 / 410: stop polling and every retry (the upload-only grace matters from Part 2 on).
      stopped.current = true;
      setPhase({ kind: 'link', code: a.code, date: a.date });
      return;
    }
    if (a.kind === 'busy') {
      retryAt.current = Date.now() + (a.retryAfterSec ?? 60) * 1000;
      return;
    }
    setPhase((p) => (p.kind === 'ready' ? p : { kind: 'offline' }));
  }, []);

  useEffect(() => {
    void load();
    const tick = setInterval(() => {
      if (document.visibilityState === 'visible') void load();
    }, POLL_MS);
    const onVisible = () => {
      if (document.visibilityState === 'visible') void load();
    };
    window.addEventListener('online', onVisible);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      clearInterval(tick);
      window.removeEventListener('online', onVisible);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [load]);

  const manifest = phase.kind === 'ready' ? phase.manifest : null;

  // The location notice on the first open (and from the info button).
  useEffect(() => {
    if (manifest && storeGet(NOTICE_KEY) !== '1') setNotice(true);
  }, [manifest]);

  const tripIndex = useMemo(() => (manifest ? (openTrip ?? openTripIndex(manifest)) : -1), [manifest, openTrip]);

  const toggleLang = () => {
    const next: Lang = lang === 'en' ? 'ar' : 'en';
    setLang(next);
    storeSet(LANG_KEY, next);
  };

  const stop = manifest && openStop ? manifest.loads.find((l) => l.loadNo === openStop.loadNo)?.stops.find((s) => s.key === openStop.key) ?? null : null;
  const stopLoad = manifest && openStop ? manifest.loads.find((l) => l.loadNo === openStop.loadNo) ?? null : null;

  return (
    <div dir={lang === 'ar' ? 'rtl' : 'ltr'} lang={lang} className="mx-auto min-h-screen max-w-xl pb-10 text-base">
      <Header lang={lang} manifest={manifest} onLang={toggleLang} onInfo={() => setNotice(true)} />
      <WebviewGate lang={lang} />
      {manifest?.office ? (
        <div className="mx-3 mt-3 rounded-lg border border-yellow-500 bg-yellow-100 p-3 text-sm font-semibold" data-testid="office-banner">
          {t(lang, 'officeBanner', { name: manifest.office.userName })}
        </div>
      ) : null}

      {phase.kind === 'loading' ? <p className="p-6 text-center text-slate-600">{t(lang, 'loading')}</p> : null}
      {phase.kind === 'offline' ? (
        <div className="p-6 text-center">
          <p className="text-slate-700">{t(lang, 'networkError')}</p>
          <button type="button" className="mt-4 min-h-12 rounded-lg bg-slate-900 px-5 font-semibold text-white" onClick={() => void load()}>
            {t(lang, 'tryAgain')}
          </button>
        </div>
      ) : null}
      {phase.kind === 'link' ? <LinkState lang={lang} code={phase.code} date={phase.date} /> : null}

      {manifest && stop && stopLoad ? (
        <StopSheet lang={lang} manifest={manifest} load={stopLoad} stop={stop} onBack={() => setOpenStop(null)} />
      ) : manifest ? (
        <main className="space-y-3 p-3">
          {manifest.loads.length === 0 ? (
            <p className="rounded-xl bg-white p-5 text-center text-lg" data-testid="no-trips">
              {t(lang, 'noTrips', { truck: manifest.truck.code, date: fmtDate(lang)(manifest.date) })}
            </p>
          ) : null}
          {manifest.loads.map((l, i) => (
            <TripCard
              key={l.loadNo}
              lang={lang}
              manifest={manifest}
              load={l}
              open={i === tripIndex}
              onToggle={() => setOpenTrip(i === tripIndex ? -1 : i)}
              onStop={(s) => setOpenStop({ loadNo: l.loadNo, key: s.key })}
            />
          ))}
        </main>
      ) : null}

      {notice && manifest ? (
        <LocationNotice
          lang={lang}
          company={manifest.tenantName}
          days={manifest.settings.locationRetentionDays}
          onOk={() => {
            storeSet(NOTICE_KEY, '1');
            setNotice(false);
          }}
        />
      ) : null}
    </div>
  );
}

function Header({ lang, manifest, onLang, onInfo }: { lang: Lang; manifest: DriverManifest | null; onLang: () => void; onInfo: () => void }) {
  const names = manifest ? driverNames(manifest) : null;
  return (
    <header className="sticky top-0 z-20 bg-slate-900 px-3 py-2 text-white shadow">
      <div className="flex items-center gap-2">
        <Truck className="h-6 w-6 shrink-0" aria-hidden />
        <div className="min-w-0 flex-1">
          {manifest ? (
            <div data-testid="driver-header">
              <p className="text-sm font-semibold text-slate-300">{fmtDate(lang)(manifest.date)}</p>
              <p className="break-words text-base font-bold leading-tight">
                {t(lang, 'truck')} <bdi>{manifest.truck.code}</bdi>
                {names ? (
                  <>
                    {' · '}
                    <bdi>{names}</bdi>
                  </>
                ) : null}
              </p>
              {manifest.truck.hired ? <p className="text-xs font-semibold text-amber-300">{t(lang, 'hiredTruck')}</p> : null}
            </div>
          ) : (
            <p className="text-base font-bold">{t(lang, 'appTitle')}</p>
          )}
        </div>
        <button type="button" onClick={onInfo} aria-label={t(lang, 'aboutLocation')} className="flex h-12 w-12 items-center justify-center rounded-lg hover:bg-slate-800">
          <Info className="h-6 w-6" aria-hidden />
        </button>
        <button
          type="button"
          onClick={onLang}
          className="flex min-h-12 items-center gap-1 rounded-lg border border-slate-600 px-3 text-sm font-semibold"
          data-testid="lang-toggle"
          lang={lang === 'en' ? 'ar' : 'en'}
        >
          <Languages className="h-5 w-5" aria-hidden /> {LANG_TOGGLE[lang]}
        </button>
      </div>
    </header>
  );
}

function StatusChip({ lang, status }: { lang: Lang; status: ManifestLoad['status'] }) {
  return <span className={`inline-block rounded-full px-3 py-1 text-sm font-semibold ${STATUS_TONE[status] ?? 'bg-slate-200'}`}>{statusLabel(lang, status)}</span>;
}

function TripCard({
  lang,
  manifest,
  load,
  open,
  onToggle,
  onStop,
}: {
  lang: Lang;
  manifest: DriverManifest;
  load: ManifestLoad;
  open: boolean;
  onToggle: () => void;
  onStop: (s: ManifestStop) => void;
}) {
  const tel = telHref(manifest.settings.dispatcherPhone);
  const waiting = load.status === 'LOCKED' || load.status === 'LOADING';
  return (
    <section className="overflow-hidden rounded-xl bg-white shadow-sm" data-testid={`trip-${load.loadNo}`}>
      <button type="button" onClick={onToggle} className="flex min-h-16 w-full items-center gap-3 p-3 text-start" aria-expanded={open}>
        <div className="min-w-0 flex-1">
          <p className="font-bold">{tripLine(lang, load)}</p>
          <div className="mt-1">
            <StatusChip lang={lang} status={load.status} />
          </div>
        </div>
        <ChevronDown className={`h-6 w-6 shrink-0 transition-transform ${open ? 'rotate-180' : ''}`} aria-hidden />
      </button>
      {open ? (
        <div className="border-t">
          {waiting ? (
            <div className="space-y-3 bg-amber-50 p-3">
              <p className="text-sm">{t(lang, 'notDispatched')}</p>
              {tel ? (
                <a href={tel} className="flex min-h-12 items-center justify-center gap-2 rounded-lg bg-slate-900 font-semibold text-white">
                  <Phone className="h-5 w-5" aria-hidden /> {t(lang, 'callDispatcher')}
                </a>
              ) : null}
            </div>
          ) : null}
          <ol className="divide-y">
            {load.stops.map((s) => (
              <li key={s.key}>
                <button type="button" onClick={() => onStop(s)} className="flex min-h-16 w-full items-center gap-3 p-3 text-start" data-testid={`stop-${s.key}`}>
                  <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-slate-900 text-lg font-bold text-white">{s.sequence}</span>
                  <span className="min-w-0 flex-1">
                    <span className="block break-words font-semibold leading-snug" dir="auto">
                      {stopTitle(s)}
                    </span>
                    <span className="block text-sm text-slate-600">
                      <Clock className="me-1 inline h-4 w-4" aria-hidden />
                      {hhmm(s.etaMin)} · {fmtHours(lang, s.hours, s.promised)} · {t(lang, 'casesLabel', { n: s.cases })}
                    </span>
                  </span>
                  {lang === 'ar' ? <ArrowLeft className="h-5 w-5 shrink-0 text-slate-400" aria-hidden /> : <ArrowRight className="h-5 w-5 shrink-0 text-slate-400" aria-hidden />}
                </button>
              </li>
            ))}
          </ol>
        </div>
      ) : null}
    </section>
  );
}

function StopSheet({ lang, manifest, load, stop, onBack }: { lang: Lang; manifest: DriverManifest; load: ManifestLoad; stop: ManifestStop; onBack: () => void }) {
  useEffect(() => {
    window.scrollTo(0, 0);
  }, [stop.key]);
  const day = fmtDate(lang);
  return (
    <main className="space-y-3 p-3" data-testid="stop-sheet">
      <button type="button" onClick={onBack} className="flex min-h-12 items-center gap-2 rounded-lg px-2 font-semibold">
        {lang === 'ar' ? <ArrowRight className="h-5 w-5" aria-hidden /> : <ArrowLeft className="h-5 w-5" aria-hidden />}
        {t(lang, 'tripOf', { n: load.loadNo, m: Math.max(load.trips, load.loadNo) })}
      </button>
      <section className="rounded-xl bg-white p-4 shadow-sm">
        <p className="text-sm font-semibold text-slate-600">{t(lang, 'stopNo', { n: stop.sequence })}</p>
        <h1 className="text-xl font-bold leading-snug" dir="auto">
          {stopTitle(stop)}
        </h1>
        {stop.address ? (
          <p className="mt-1 flex items-start gap-1 text-sm text-slate-700" dir="auto">
            <MapPin className="mt-0.5 h-4 w-4 shrink-0" aria-hidden /> {stop.address}
          </p>
        ) : null}
        {stop.navUrl ? (
          <>
            <a
              href={stop.navUrl}
              target="_blank"
              rel="noreferrer noopener"
              className="mt-3 flex min-h-14 items-center justify-center gap-2 rounded-xl bg-blue-700 text-lg font-bold text-white"
              data-testid="navigate"
            >
              <Navigation className="h-6 w-6" aria-hidden /> {t(lang, 'navigate')}
            </a>
            <p className="mt-1 text-center text-sm text-slate-600">{t(lang, 'openAgainHint')}</p>
          </>
        ) : (
          <p className="mt-3 rounded-lg bg-red-50 p-3 font-semibold text-red-800">{t(lang, 'noLocation')}</p>
        )}
      </section>

      <section className="space-y-1 rounded-xl bg-white p-4 shadow-sm">
        <p className="flex items-center gap-2 font-semibold">
          <Clock className="h-5 w-5 shrink-0" aria-hidden /> {t(lang, 'plannedArrival', { time: hhmm(stop.etaMin) })}
        </p>
        {stop.untilMin !== null ? <p className="ps-7 text-slate-700">{t(lang, 'unloadUntil', { time: hhmm(stop.untilMin) })}</p> : null}
        <p className="ps-7 text-sm text-slate-700">{fmtHours(lang, stop.hours, stop.promised)}</p>
        {stop.split ? <p className="text-sm font-semibold">{t(lang, 'partOf', { n: stop.split.part, m: stop.split.parts })}</p> : null}
        {stop.carriedFrom ? <p className="text-sm font-semibold">{t(lang, 'carriedFrom', { date: day(stop.carriedFrom) })}</p> : null}
        {stop.changeNotes.length ? (
          <div className="mt-2 rounded-lg bg-amber-50 p-2 text-sm">
            <p className="font-semibold">{t(lang, 'changedAfterPlanning')}</p>
            {stop.changeNotes.map((n) => (
              <p key={n} dir="auto">
                {n}
              </p>
            ))}
          </div>
        ) : null}
      </section>

      <section className="rounded-xl bg-white p-4 shadow-sm">
        <p className="mb-2 flex items-center gap-2 font-bold">
          <Package className="h-5 w-5" aria-hidden /> {t(lang, 'casesLabel', { n: stop.cases })}
        </p>
        {stop.orders.map((o) => (
          <div key={o.orderId} className="border-t py-2 first:border-t-0">
            {o.salesOrders.length ? (
              <p className="text-sm text-slate-600">
                {t(lang, 'salesOrder')}: <span dir="ltr">{o.salesOrders.join(', ')}</span>
              </p>
            ) : null}
            <ul>
              {o.lines.map((ln) => (
                <li key={ln.lineId} className="flex items-baseline justify-between gap-3 py-0.5">
                  <span className="min-w-0" dir="auto">
                    <span className="font-mono text-sm">{ln.productCode}</span> {ln.productName}
                  </span>
                  <span className="shrink-0 text-lg font-bold">{ln.cases}</span>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </section>

      {stop.notes.length || stop.accessNotes ? (
        <section className="space-y-1 rounded-xl bg-white p-4 shadow-sm">
          <p className="flex items-center gap-2 font-bold">
            <StickyNote className="h-5 w-5" aria-hidden /> {t(lang, 'notes')}
          </p>
          {stop.accessNotes ? (
            <p className="text-sm" dir="auto">
              <span className="font-semibold">{t(lang, 'access')}:</span> {stop.accessNotes}
            </p>
          ) : null}
          {stop.notes.map((n) => (
            <p key={n} className="text-sm" dir="auto">
              {n}
            </p>
          ))}
        </section>
      ) : null}

      {load.status === 'LOCKED' || load.status === 'LOADING' ? (
        <p className="rounded-xl bg-amber-50 p-3 text-sm">{t(lang, 'notDispatched')}</p>
      ) : null}
      {manifest.settings.dispatcherPhone && telHref(manifest.settings.dispatcherPhone) ? (
        <a href={telHref(manifest.settings.dispatcherPhone)!} className="flex min-h-12 items-center justify-center gap-2 rounded-lg border border-slate-400 bg-white font-semibold">
          <Phone className="h-5 w-5" aria-hidden /> {t(lang, 'callDispatcher')}
        </a>
      ) : null}
    </main>
  );
}

function LocationNotice({ lang, company, days, onOk }: { lang: Lang; company: string; days: number; onOk: () => void }) {
  return (
    <div className="fixed inset-0 z-30 flex items-end justify-center bg-black/50 p-3 sm:items-center" role="dialog" aria-modal="true" aria-labelledby="loc-title">
      <div className="max-w-md rounded-2xl bg-white p-5 shadow-xl">
        <p id="loc-title" className="flex items-center gap-2 text-lg font-bold">
          <MapPin className="h-6 w-6" aria-hidden /> {t(lang, 'locationTitle')}
        </p>
        <p className="mt-2 text-sm leading-relaxed">{t(lang, 'locationNotice', { company: company || 'RouteIQ', days })}</p>
        <button type="button" onClick={onOk} className="mt-4 min-h-12 w-full rounded-lg bg-slate-900 text-lg font-semibold text-white" data-testid="notice-ok">
          {t(lang, 'ok')}
        </button>
      </div>
    </div>
  );
}
