'use client';

import { useEffect, useRef, useState } from 'react';
import { Camera, Check, RotateCcw } from 'lucide-react';
import { t, type Lang } from '@/lib/driver-page/i18n';
import { compressPhoto, exifOfFile, PhotoTooLargeError } from '@/lib/driver-page/photo';

/** A photo taken and compressed, before it is used. */
export interface TakenPhoto {
  key: string;
  blob: Blob;
  width: number;
  height: number;
  /** Date.now() when the camera returned (the device clock). */
  takenAt: number;
  cameraOpenedAt: number;
  exif: { lat: number | null; lng: number | null; takenAt: number | null } | null;
  fileLastModified: number | null;
}

/**
 * Take photo (spec section 12.1): the camera opens straight from the file input; the photo is read
 * (EXIF), compressed and previewed with Use photo / Retake. Before the camera opens the page saves the
 * stop's draft with the photo's key, so a phone that kills the tab while the camera is open loses
 * nothing but that photo (the draft says so when the page comes back).
 */
export function CameraButton({
  lang,
  tz,
  disabled,
  onBeforeOpen,
  onUse,
  onCameraSlow,
}: {
  lang: Lang;
  tz: string;
  disabled: boolean;
  /** Saves the draft and returns the new photo's key. */
  onBeforeOpen: () => Promise<string>;
  onUse: (p: TakenPhoto) => void;
  /** The file chooser did not open within 3 s of the tap (an in-app browser ignoring the camera). */
  onCameraSlow: () => void;
}) {
  const input = useRef<HTMLInputElement | null>(null);
  const pending = useRef<{ key: string; openedAt: number } | null>(null);
  const slowTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [preview, setPreview] = useState<{ photo: TakenPhoto; url: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const left = () => {
      if (slowTimer.current) clearTimeout(slowTimer.current);
      slowTimer.current = null;
    };
    const onVis = () => {
      if (document.visibilityState === 'hidden') left();
    };
    window.addEventListener('blur', left);
    document.addEventListener('visibilitychange', onVis);
    return () => {
      window.removeEventListener('blur', left);
      document.removeEventListener('visibilitychange', onVis);
      if (slowTimer.current) clearTimeout(slowTimer.current);
    };
  }, []);

  useEffect(() => () => (preview ? URL.revokeObjectURL(preview.url) : undefined), [preview]);

  const open = async () => {
    setError(null);
    const key = await onBeforeOpen();
    pending.current = { key, openedAt: Date.now() };
    if (slowTimer.current) clearTimeout(slowTimer.current);
    slowTimer.current = setTimeout(() => {
      slowTimer.current = null;
      onCameraSlow();
    }, 3_000);
    input.current?.click();
  };

  const onChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (slowTimer.current) clearTimeout(slowTimer.current);
    slowTimer.current = null;
    const p = pending.current;
    if (!file || !p) return;
    const takenAt = Date.now();
    setBusy(true);
    try {
      const exif = await exifOfFile(file, tz);
      const c = await compressPhoto(file);
      const photo: TakenPhoto = {
        key: p.key,
        blob: c.blob,
        width: c.width,
        height: c.height,
        takenAt,
        cameraOpenedAt: p.openedAt,
        exif,
        fileLastModified: Number.isFinite((file as File).lastModified) ? (file as File).lastModified : null,
      };
      setPreview({ photo, url: URL.createObjectURL(c.blob) });
    } catch (err) {
      setError(t(lang, err instanceof PhotoTooLargeError ? 'photoTooLarge' : 'photoFailed'));
    } finally {
      setBusy(false);
    }
  };

  if (preview) {
    return (
      <div className="space-y-2" data-testid="photo-preview">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={preview.url} alt="" className="max-h-72 w-full rounded-xl object-contain" />
        <div className="grid grid-cols-2 gap-2">
          <button
            type="button"
            className="flex min-h-14 items-center justify-center gap-2 rounded-xl bg-emerald-700 text-lg font-bold text-white"
            onClick={() => {
              onUse(preview.photo);
              setPreview(null);
            }}
          >
            <Check className="h-6 w-6" aria-hidden /> {t(lang, 'usePhoto')}
          </button>
          <button type="button" className="flex min-h-14 items-center justify-center gap-2 rounded-xl border border-slate-400 text-lg font-semibold" onClick={() => void open()}>
            <RotateCcw className="h-6 w-6" aria-hidden /> {t(lang, 'retake')}
          </button>
        </div>
        <input ref={input} type="file" accept="image/*" capture="environment" className="hidden" onChange={(e) => void onChange(e)} />
      </div>
    );
  }
  return (
    <div>
      <button
        type="button"
        disabled={disabled || busy}
        onClick={() => void open()}
        className="flex min-h-14 w-full items-center justify-center gap-2 rounded-xl bg-blue-700 text-lg font-bold text-white disabled:opacity-50"
        data-testid="take-photo"
      >
        <Camera className="h-6 w-6" aria-hidden /> {busy ? t(lang, 'loading') : t(lang, 'takePhoto')}
      </button>
      {error ? <p className="mt-1 text-sm font-semibold text-red-700">{error}</p> : null}
      <input ref={input} type="file" accept="image/*" capture="environment" className="hidden" onChange={(e) => void onChange(e)} />
    </div>
  );
}
