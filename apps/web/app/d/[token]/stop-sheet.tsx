'use client';

import { useEffect, useState, type ReactNode } from 'react';
import { ArrowLeft, ArrowRight, CheckCircle2, Clock, Hand, MapPin, Navigation, Package, Phone, StickyNote, Timer, Truck, Undo2, XCircle } from 'lucide-react';
import type { DriverManifest, OutcomeName } from '@/lib/driver-link/manifest-types';
import { stopTitle, telHref } from '@/lib/driver-page/format';
import { clockTime, fmtDate, fmtHours, hhmm, reasonLabel, t, type Lang } from '@/lib/driver-page/i18n';
import type { OverlayLoad, OverlayStop } from '@/lib/driver-page/overlay';

const minutesSince = (from: number, to: number) => Math.max(0, Math.floor((to - from) / 60_000));

/** The chip of a stop's result, for the stop list and the sheet. */
export function ResultChip({ lang, stop }: { lang: Lang; stop: OverlayStop }) {
  const v = stop.view;
  if (v.pending && v.outcome) return <span className="rounded-full bg-amber-300 px-2 py-0.5 text-xs font-semibold text-amber-950">{t(lang, 'savedOnPhone')}</span>;
  if (v.changedByOffice) return <span className="rounded-full bg-purple-200 px-2 py-0.5 text-xs font-semibold text-purple-950">{t(lang, 'changedByOffice')}</span>;
  if (v.outcome === 'DELIVERED') return <span className="rounded-full bg-emerald-600 px-2 py-0.5 text-xs font-semibold text-white">{t(lang, 'delivered')}</span>;
  if (v.outcome === 'PARTLY_DELIVERED') return <span className="rounded-full bg-amber-500 px-2 py-0.5 text-xs font-semibold text-white">{t(lang, 'partly')}</span>;
  if (v.outcome === 'NOT_DELIVERED') return <span className="rounded-full bg-red-700 px-2 py-0.5 text-xs font-semibold text-white">{t(lang, 'notDelivered')}</span>;
  if (v.arrivedAt !== null && v.state === 'ARRIVED') return <span className="rounded-full bg-blue-600 px-2 py-0.5 text-xs font-semibold text-white">{t(lang, 'atStopMin', { mm: minutesSince(v.arrivedAt, Date.now()) })}</span>;
  return null;
}

/**
 * One stop (spec section 6.3): the big Navigate button, the plan (arrival, unloading end, hours or
 * promised time), cases per order line, notes; on a trip that is on the road the timer area and the
 * three result buttons; after a result the result, its photos and Change result.
 */
export function StopSheet({
  lang,
  manifest,
  load,
  stop,
  actionable,
  atThisStop,
  trackingOn,
  locationOff,
  flow,
  photoUrls,
  onBack,
  onArrive,
  onStartResult,
  onUndo,
}: {
  lang: Lang;
  manifest: DriverManifest;
  load: OverlayLoad;
  stop: OverlayStop;
  /** Results can be recorded (the trip is DISPATCHED, or done but still changeable here). */
  actionable: boolean;
  /** The tracker is at this stop. */
  atThisStop: boolean;
  trackingOn: boolean;
  locationOff: boolean;
  /** The result being entered (OutcomeFlow), or null. */
  flow: ReactNode;
  photoUrls: Record<string, string | null>;
  onBack: () => void;
  onArrive: () => void;
  onStartResult: (o: OutcomeName) => void;
  onUndo: () => void;
}) {
  const [now, setNow] = useState(Date.now());
  const [confirmUndo, setConfirmUndo] = useState(false);
  useEffect(() => {
    window.scrollTo(0, 0);
  }, [stop.key]);
  useEffect(() => {
    const i = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(i);
  }, []);
  const v = stop.view;
  const day = fmtDate(lang);
  const tz = manifest.tz;
  const time = (ms: number) => clockTime(new Date(ms).toISOString(), tz);
  const tel = telHref(manifest.settings.dispatcherPhone);
  const waiting = load.status === 'LOCKED' || load.status === 'LOADING';
  const showTimer = load.status === 'DISPATCHED' || (waiting && trackingOn);
  const canChange = actionable && v.editable && !v.carriedTo;

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
            <a href={stop.navUrl} target="_blank" rel="noreferrer noopener" className="mt-3 flex min-h-14 items-center justify-center gap-2 rounded-xl bg-blue-700 text-lg font-bold text-white" data-testid="navigate">
              <Navigation className="h-6 w-6" aria-hidden /> {t(lang, 'navigate')}
            </a>
            <p className="mt-1 text-center text-sm text-slate-600">{t(lang, 'openAgainHint')}</p>
          </>
        ) : (
          <p className="mt-3 rounded-lg bg-red-50 p-3 font-semibold text-red-800">{t(lang, 'noLocation')}</p>
        )}
      </section>

      {showTimer ? (
        <section className="space-y-2 rounded-xl bg-white p-4 shadow-sm" data-testid="timer-area">
          {locationOff ? <p className="rounded-lg bg-amber-100 p-2 text-sm font-semibold">{t(lang, 'locationOff')}</p> : null}
          {v.doneAt !== null ? (
            <p className="flex items-center gap-2 text-lg font-bold">
              <CheckCircle2 className="h-6 w-6 text-emerald-700" aria-hidden />
              {v.arrivedAt !== null ? t(lang, 'doneTimer', { time: time(v.doneAt), mm: minutesSince(v.arrivedAt, v.doneAt) }) : time(v.doneAt)}
            </p>
          ) : v.arrivedAt !== null ? (
            <>
              <p className="flex items-center gap-2 text-lg font-bold" data-testid="timer-running">
                <Timer className="h-6 w-6 text-blue-700" aria-hidden /> {t(lang, 'arrivedTimer', { time: time(v.arrivedAt), mm: minutesSince(v.arrivedAt, now) })}
              </p>
              {!v.arrivalObserved ? <p className="text-sm text-slate-600">{t(lang, 'arrivedFound', { time: time(v.arrivedAt) })}</p> : null}
              <p className="text-sm text-slate-600">{t(lang, 'keepOpen')}</p>
            </>
          ) : (
            <>
              <p className="flex items-center gap-2 font-semibold">
                <Clock className="h-5 w-5" aria-hidden /> {t(lang, 'waitingArrive', { m: manifest.settings.radiusM })}
              </p>
              <button type="button" onClick={onArrive} className="flex min-h-14 w-full items-center justify-center gap-2 rounded-xl border-2 border-slate-900 text-lg font-bold" data-testid="i-arrived">
                <Hand className="h-6 w-6" aria-hidden /> {t(lang, 'iArrived')}
              </button>
            </>
          )}
          {atThisStop && v.arrivedAt === null ? <p className="text-sm text-slate-600">{t(lang, 'waitingGps')}</p> : null}
        </section>
      ) : null}

      {flow ? (
        flow
      ) : actionable && v.doneAt === null && v.outcome === null ? (
        <section className="grid grid-cols-1 gap-2" data-testid="result-buttons">
          <button type="button" onClick={() => onStartResult('DELIVERED')} className="flex min-h-16 items-center justify-center gap-2 rounded-xl bg-emerald-700 text-xl font-bold text-white">
            <CheckCircle2 className="h-7 w-7" aria-hidden /> {t(lang, 'delivered')}
          </button>
          <button type="button" onClick={() => onStartResult('PARTLY_DELIVERED')} className="flex min-h-16 items-center justify-center gap-2 rounded-xl bg-amber-500 text-xl font-bold text-white">
            <Package className="h-7 w-7" aria-hidden /> {t(lang, 'partly')}
          </button>
          <button type="button" onClick={() => onStartResult('NOT_DELIVERED')} className="flex min-h-16 items-center justify-center gap-2 rounded-xl bg-red-700 text-xl font-bold text-white">
            <XCircle className="h-7 w-7" aria-hidden /> {t(lang, 'notDelivered')}
          </button>
        </section>
      ) : v.outcome ? (
        <section className="space-y-2 rounded-xl bg-white p-4 shadow-sm" data-testid="result-done">
          <p className="text-sm font-semibold text-slate-600">{t(lang, 'resultOf')}</p>
          <div className="flex flex-wrap items-center gap-2">
            <ResultChip lang={lang} stop={stop} />
            {v.reason ? <span className="font-semibold">{reasonLabel(lang, v.reason)}</span> : null}
            {v.outcome === 'PARTLY_DELIVERED' && v.casesDelivered !== null ? <span>{t(lang, 'deliveredOf', { n: v.casesDelivered, m: stop.cases })}</span> : null}
          </div>
          {v.note ? (
            <p className="text-sm" dir="auto">
              {v.note}
            </p>
          ) : null}
          {v.noPhotoReason === 'CAMERA_FAILED' ? <p className="text-sm text-amber-800">{t(lang, 'noPhotoCamera')}</p> : null}
          {v.late ? <p className="text-sm text-amber-800">{t(lang, 'recordedLate')}</p> : null}
          {v.carriedTo ? <p className="text-sm font-semibold">{t(lang, 'broughtForward', { date: day(v.carriedTo) })}</p> : null}
          {v.photoIds.length ? (
            <div className="grid grid-cols-3 gap-2">
              {v.photoIds.map((id) =>
                photoUrls[id] ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img key={id} src={photoUrls[id]!} alt="" className="aspect-square w-full rounded-lg object-cover" />
                ) : (
                  <div key={id} className="aspect-square w-full rounded-lg bg-slate-200" />
                ),
              )}
            </div>
          ) : null}
          {v.localPhotos ? <p className="text-sm text-amber-800">{t(lang, 'photosWaiting', { n: v.localPhotos })}</p> : null}
          {canChange ? (
            confirmUndo ? (
              <div className="space-y-2 rounded-lg bg-red-50 p-3">
                <p className="font-semibold">{t(lang, 'confirmUndo')}</p>
                <div className="grid grid-cols-2 gap-2">
                  <button
                    type="button"
                    className="min-h-12 rounded-lg bg-red-700 font-semibold text-white"
                    onClick={() => {
                      setConfirmUndo(false);
                      onUndo();
                    }}
                  >
                    {t(lang, 'yes')}
                  </button>
                  <button type="button" className="min-h-12 rounded-lg border border-slate-400 font-semibold" onClick={() => setConfirmUndo(false)}>
                    {t(lang, 'no')}
                  </button>
                </div>
              </div>
            ) : (
              <div className="grid grid-cols-2 gap-2">
                <button type="button" onClick={() => onStartResult(v.outcome!)} className="min-h-12 rounded-lg border-2 border-slate-900 font-semibold" data-testid="change-result">
                  {t(lang, 'changeResult')}
                </button>
                <button type="button" onClick={() => setConfirmUndo(true)} className="flex min-h-12 items-center justify-center gap-1 rounded-lg border border-slate-400 font-semibold">
                  <Undo2 className="h-5 w-5" aria-hidden /> {t(lang, 'undo')}
                </button>
              </div>
            )
          ) : v.outcome && actionable ? (
            <p className="text-sm text-slate-600">{t(lang, 'notEditable')}</p>
          ) : null}
        </section>
      ) : null}

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

      {waiting ? (
        <p className="flex items-start gap-2 rounded-xl bg-amber-50 p-3 text-sm">
          <Truck className="mt-0.5 h-5 w-5 shrink-0" aria-hidden /> {t(lang, 'notDispatched')}
        </p>
      ) : null}
      {tel ? (
        <a href={tel} className="flex min-h-12 items-center justify-center gap-2 rounded-lg border border-slate-400 bg-white font-semibold">
          <Phone className="h-5 w-5" aria-hidden /> {t(lang, 'callDispatcher')}
        </a>
      ) : null}
    </main>
  );
}
