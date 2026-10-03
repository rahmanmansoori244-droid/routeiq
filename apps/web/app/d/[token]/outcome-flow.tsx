'use client';

import { CameraOff, Minus, Plus, Save, X } from 'lucide-react';
import { NOT_DELIVERED_REASONS, type NotDeliveredReasonName, type OutcomeName, type PhotoPositionStatusName } from '@/lib/driver-link/manifest-types';
import { positionLabel, reasonLabel, t, type Lang } from '@/lib/driver-page/i18n';
import type { OverlayStop } from '@/lib/driver-page/overlay';
import type { Draft } from '@/lib/driver-page/queue';
import { CameraButton, type TakenPhoto } from './camera-button';

/** A photo of the result being entered, as the flow shows it. */
export interface DraftPhoto {
  key: string;
  url: string | null;
  positionStatus: PhotoPositionStatusName | null;
}

/** Whether the entered result can be saved (pure; the server checks the same rules again). */
export function canSave(stop: Pick<OverlayStop, 'orders'>, d: Draft, photoRequired: boolean): boolean {
  if (!d.outcome) return false;
  if (d.outcome !== 'DELIVERED') {
    if (!d.reason) return false;
    if (d.reason === 'OTHER' && d.note.trim().length < 3) return false;
  }
  if (d.note.trim().length > 300) return false;
  if (d.outcome === 'PARTLY_DELIVERED') {
    const lines = stop.orders.flatMap((o) => o.lines);
    const total = lines.reduce((a, l) => a + (d.lines[l.lineId] ?? l.cases), 0);
    if (total <= 0) return false;
  }
  if (photoRequired && d.outcome !== 'NOT_DELIVERED' && !d.photoKeys.length && !d.noPhoto) return false;
  return true;
}

/**
 * Delivered / Partly / Not delivered (spec section 6.3): big buttons, few words. Partly: a stepper per
 * order line (default all), then the reason; Not delivered: the reason; Other needs a note. A photo is
 * required for Delivered and Partly when the company says so (up to 3), with "Camera not working" as
 * the only way round it; optional for Not delivered. Every change is kept as a draft on the phone.
 */
export function OutcomeFlow({
  lang,
  tz,
  stop,
  draft,
  photos,
  maxPhotos,
  photoRequired,
  onDraft,
  onBeforeCamera,
  onPhoto,
  onRemovePhoto,
  onSave,
  onCancel,
  onCameraSlow,
}: {
  lang: Lang;
  tz: string;
  stop: OverlayStop;
  draft: Draft;
  photos: DraftPhoto[];
  maxPhotos: number;
  photoRequired: boolean;
  onDraft: (d: Draft) => void;
  onBeforeCamera: () => Promise<string>;
  onPhoto: (p: TakenPhoto) => void;
  onRemovePhoto: (key: string) => void;
  onSave: () => void;
  onCancel: () => void;
  onCameraSlow: () => void;
}) {
  const outcome = draft.outcome as OutcomeName;
  const set = (patch: Partial<Draft>) => onDraft({ ...draft, ...patch, savedAt: Date.now() });
  const lines = stop.orders.flatMap((o) => o.lines);
  const needsReason = outcome !== 'DELIVERED';
  const photoNeeded = photoRequired && outcome !== 'NOT_DELIVERED';
  const ok = canSave(stop, draft, photoRequired);
  const total = lines.reduce((a, l) => a + (draft.lines[l.lineId] ?? l.cases), 0);
  const title = outcome === 'DELIVERED' ? t(lang, 'delivered') : outcome === 'PARTLY_DELIVERED' ? t(lang, 'partly') : t(lang, 'notDelivered');
  const tone = outcome === 'DELIVERED' ? 'bg-emerald-700' : outcome === 'PARTLY_DELIVERED' ? 'bg-amber-500' : 'bg-red-700';

  return (
    <section className="space-y-4 rounded-xl bg-white p-4 shadow-sm" data-testid="outcome-flow" data-outcome={outcome}>
      <p className={`rounded-lg px-3 py-2 text-lg font-bold text-white ${tone}`}>{title}</p>

      {outcome === 'PARTLY_DELIVERED' ? (
        <div className="space-y-2">
          <p className="font-bold">{t(lang, 'casesDelivered')}</p>
          {lines.map((l) => {
            const v = draft.lines[l.lineId] ?? l.cases;
            const put = (n: number) => set({ lines: { ...draft.lines, [l.lineId]: Math.max(0, Math.min(l.cases, n)) } });
            return (
              <div key={l.lineId} className="flex items-center gap-2 border-b pb-2" data-testid={`line-${l.lineId}`}>
                <span className="min-w-0 flex-1 text-sm" dir="auto">
                  <span className="font-mono">{l.productCode}</span> {l.productName}
                </span>
                <button type="button" aria-label="-" onClick={() => put(v - 1)} className="flex h-12 w-12 items-center justify-center rounded-lg border border-slate-400">
                  <Minus className="h-5 w-5" aria-hidden />
                </button>
                <input
                  inputMode="numeric"
                  value={v}
                  onChange={(e) => put(Number(e.target.value.replace(/\D/g, '')) || 0)}
                  className="h-12 w-16 rounded-lg border border-slate-400 text-center text-lg font-bold"
                  aria-label={t(lang, 'casesDelivered')}
                />
                <button type="button" aria-label="+" onClick={() => put(v + 1)} className="flex h-12 w-12 items-center justify-center rounded-lg border border-slate-400">
                  <Plus className="h-5 w-5" aria-hidden />
                </button>
                <span className="w-10 text-end text-sm text-slate-600">/{l.cases}</span>
              </div>
            );
          })}
          <p className="text-sm font-semibold">{t(lang, 'deliveredOf', { n: total, m: stop.cases })}</p>
        </div>
      ) : null}

      {needsReason ? (
        <div className="space-y-2">
          <p className="font-bold">{t(lang, 'reason')}</p>
          <div className="grid grid-cols-1 gap-2">
            {NOT_DELIVERED_REASONS.map((r: NotDeliveredReasonName) => (
              <button
                key={r}
                type="button"
                onClick={() => set({ reason: r })}
                className={`min-h-12 rounded-xl border px-3 text-start font-semibold ${draft.reason === r ? 'border-slate-900 bg-slate-900 text-white' : 'border-slate-300 bg-white'}`}
                aria-pressed={draft.reason === r}
              >
                {reasonLabel(lang, r)}
              </button>
            ))}
          </div>
        </div>
      ) : null}

      <div>
        <label className="font-bold" htmlFor="result-note">
          {draft.reason === 'OTHER' ? t(lang, 'noteRequired') : t(lang, 'notes')}
        </label>
        <textarea
          id="result-note"
          dir="auto"
          maxLength={300}
          value={draft.note}
          onChange={(e) => set({ note: e.target.value })}
          className="mt-1 min-h-20 w-full rounded-lg border border-slate-400 p-2 text-base"
        />
      </div>

      <div className="space-y-2">
        <p className="font-bold">
          {photoNeeded ? t(lang, 'photoRequired') : t(lang, 'photosLabel', { n: photos.length })} · {t(lang, 'photoLimit', { n: maxPhotos })}
        </p>
        {photos.length ? (
          <div className="grid grid-cols-3 gap-2">
            {photos.map((p) => (
              <div key={p.key} className="relative">
                {p.url ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={p.url} alt="" className="aspect-square w-full rounded-lg object-cover" />
                ) : (
                  <div className="aspect-square w-full rounded-lg bg-slate-200" />
                )}
                <button
                  type="button"
                  onClick={() => onRemovePhoto(p.key)}
                  aria-label={t(lang, 'cancel')}
                  className="absolute end-1 top-1 flex h-8 w-8 items-center justify-center rounded-full bg-black/70 text-white"
                >
                  <X className="h-4 w-4" aria-hidden />
                </button>
                {p.positionStatus && p.positionStatus !== 'OK' ? (
                  <p className="mt-1 text-xs font-semibold text-amber-800">
                    {positionLabel(lang, p.positionStatus)}. {t(lang, 'locationNotCaptured')}
                  </p>
                ) : null}
              </div>
            ))}
          </div>
        ) : null}
        {photos.length < maxPhotos ? <CameraButton lang={lang} tz={tz} disabled={false} onBeforeOpen={onBeforeCamera} onUse={onPhoto} onCameraSlow={onCameraSlow} /> : null}
        {photoNeeded && !photos.length ? (
          <button
            type="button"
            onClick={() => set({ noPhoto: !draft.noPhoto })}
            className={`flex min-h-12 w-full items-center justify-center gap-2 rounded-lg text-sm font-semibold underline ${draft.noPhoto ? 'bg-amber-100' : ''}`}
            aria-pressed={draft.noPhoto}
            data-testid="camera-not-working"
          >
            <CameraOff className="h-5 w-5" aria-hidden /> {draft.noPhoto ? t(lang, 'noPhotoCamera') : t(lang, 'cameraNotWorking')}
          </button>
        ) : null}
      </div>

      <div className="grid grid-cols-2 gap-2">
        <button
          type="button"
          disabled={!ok}
          onClick={onSave}
          className="flex min-h-14 items-center justify-center gap-2 rounded-xl bg-slate-900 text-lg font-bold text-white disabled:opacity-40"
          data-testid="save-result"
        >
          <Save className="h-6 w-6" aria-hidden /> {t(lang, 'save')}
        </button>
        <button type="button" onClick={onCancel} className="min-h-14 rounded-xl border border-slate-400 text-lg font-semibold">
          {t(lang, 'cancel')}
        </button>
      </div>
    </section>
  );
}
