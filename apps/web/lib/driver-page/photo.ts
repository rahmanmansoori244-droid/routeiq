/**
 * Delivery photos on the phone (owner request 4 Oct 2026, spec section 12.1). Browser-safe.
 *
 * 1. The camera opens straight from <input type="file" accept="image/*" capture="environment">.
 * 2. takenAt = Date.now() when the input's change event fires (the device clock, like every time the
 *    page sends; the server corrects a wrong clock once).
 * 3. EXIF (GPS, DateTimeOriginal) is read from the original file first - only for the "taken earlier"
 *    check; EXIF GPS is rarely present (most camera apps and browsers remove it).
 * 4. The photo is compressed without decoding the full image where the browser can: long side at most
 *    1600 px, JPEG 0.7 (0.6 and 0.5 when still over 400 KB); over 1.5 MB: "Photo too large, retake".
 * 5. The position: a fresh high-accuracy fix when the camera returns, or the tracker's last fix from
 *    no more than 30 s before the camera opened, whichever is more accurate. Save never waits for it.
 */
import type { PhotoPositionStatusName } from '../driver-link/manifest-types';
import { jpegSize, readExif } from '../delivery/jpeg';

export const MAX_SIDE = 1600;
export const QUALITIES = [0.7, 0.6, 0.5] as const;
export const TARGET_BYTES = 400 * 1024;
export const MAX_BYTES = 1_500_000;
export const OK_ACCURACY_M = 100;
export const OLD_PHOTO_MS = 15 * 60_000;
/** The tracker's last fix counts for a photo when it is at most this old when the camera opened. */
export const LAST_FIX_MS = 30_000;

export class PhotoTooLargeError extends Error {
  constructor() {
    super('Photo too large');
    this.name = 'PhotoTooLargeError';
  }
}

/** The size to draw: the long side at most `max`, never upscaled (pure). */
export function targetSize(width: number, height: number, max = MAX_SIDE): { width: number; height: number } {
  if (!(width > 0) || !(height > 0)) return { width: max, height: max };
  const scale = Math.min(1, max / Math.max(width, height));
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

export interface PosFix {
  lat: number;
  lng: number;
  accuracyM: number;
  at: number;
}

/** The better (smaller accuracy) of the fresh fix and the tracker's recent fix (pure). */
export function betterFix(fresh: PosFix | null, last: PosFix | null, cameraOpenedAt: number): PosFix | null {
  const recent = last && cameraOpenedAt - last.at <= LAST_FIX_MS && last.at <= cameraOpenedAt + 120_000 ? last : null;
  if (fresh && recent) return fresh.accuracyM <= recent.accuracyM ? fresh : recent;
  return fresh ?? recent;
}

/** The position status of a photo (pure). */
export function positionStatus(fix: PosFix | null, error: 'DENIED' | 'TIMEOUT' | 'UNSUPPORTED' | null): PhotoPositionStatusName {
  if (fix) return fix.accuracyM <= OK_ACCURACY_M ? 'OK' : 'POOR';
  return error ?? 'TIMEOUT';
}

/** "Taken earlier": the EXIF time or the file time more than 15 min before the arrival (or the dispatch) (pure). */
export function isOldPhoto(exifTakenAt: number | null, fileLastModified: number | null, reference: number | null): boolean {
  if (reference === null) return false;
  return [exifTakenAt, fileLastModified].some((t) => t !== null && Number.isFinite(t) && t < reference - OLD_PHOTO_MS);
}

/** EXIF of the original file (its first 256 KB hold the APP1 block), or null. */
export async function exifOfFile(file: Blob, tz: string): Promise<{ lat: number | null; lng: number | null; takenAt: number | null } | null> {
  try {
    const head = new Uint8Array(await file.slice(0, 256 * 1024).arrayBuffer());
    const e = readExif(head, tz);
    return e ? { lat: e.lat, lng: e.lng, takenAt: e.takenAt ? e.takenAt.getTime() : null } : null;
  } catch {
    return null;
  }
}

async function headerSize(file: Blob): Promise<{ width: number; height: number } | null> {
  try {
    return jpegSize(new Uint8Array(await file.slice(0, 256 * 1024).arrayBuffer()));
  } catch {
    return null;
  }
}

type Drawable = { width: number; height: number; close?: () => void };

async function decode(file: Blob, size: { width: number; height: number } | null): Promise<{ source: CanvasImageSource & Drawable; width: number; height: number } | null> {
  const cib = (globalThis as { createImageBitmap?: typeof createImageBitmap }).createImageBitmap;
  if (cib) {
    try {
      // Only the width is given, so the aspect ratio is kept even when the EXIF orientation turns the
      // picture; the canvas scales the result down again if a turned picture is still too tall.
      const opts: ImageBitmapOptions = size
        ? { resizeWidth: targetSize(size.width, size.height).width, resizeQuality: 'medium', imageOrientation: 'from-image' }
        : { imageOrientation: 'from-image' };
      const bmp = await cib(file, opts);
      const t = targetSize(bmp.width, bmp.height);
      return { source: bmp, width: t.width, height: t.height };
    } catch {
      // fall through to the <img> path
    }
  }
  if (typeof document === 'undefined') return null;
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const i = new Image();
      i.onload = () => resolve(i);
      i.onerror = () => reject(new Error('decode'));
      i.src = url;
    });
    const t = targetSize(img.naturalWidth, img.naturalHeight);
    return { source: img as unknown as CanvasImageSource & Drawable, width: t.width, height: t.height };
  } catch {
    return null;
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  }
}

function toJpeg(canvas: HTMLCanvasElement, quality: number): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob((b) => resolve(b), 'image/jpeg', quality));
}

/**
 * The compressed photo: long side at most 1600 px, JPEG 0.7 (then 0.6, 0.5 above 400 KB). When the
 * browser cannot draw it, the original JPEG is sent as it is if small enough (the server strips its
 * metadata). Throws PhotoTooLargeError above 1.5 MB.
 */
export async function compressPhoto(file: Blob): Promise<{ blob: Blob; width: number; height: number }> {
  const size = await headerSize(file);
  const d = await decode(file, size);
  if (d && typeof document !== 'undefined') {
    const canvas = document.createElement('canvas');
    canvas.width = d.width;
    canvas.height = d.height;
    const g = canvas.getContext('2d');
    if (g) {
      g.drawImage(d.source, 0, 0, d.width, d.height);
      d.source.close?.();
      let out: Blob | null = null;
      for (const q of QUALITIES) {
        out = await toJpeg(canvas, q);
        if (out && out.size <= TARGET_BYTES) break;
      }
      canvas.width = 0;
      canvas.height = 0;
      if (out) {
        if (out.size > MAX_BYTES) throw new PhotoTooLargeError();
        return { blob: out, width: d.width, height: d.height };
      }
    }
  }
  if (size && file.size <= MAX_BYTES && file.type === 'image/jpeg') return { blob: file, width: size.width, height: size.height };
  throw new PhotoTooLargeError();
}

/** A fresh high-accuracy fix (at most 15 s), or why there is none. Never rejects. */
export function freshFix(timeoutMs = 15_000): Promise<{ fix: PosFix | null; error: 'DENIED' | 'TIMEOUT' | 'UNSUPPORTED' | null }> {
  const geo = typeof navigator !== 'undefined' ? navigator.geolocation : undefined;
  if (!geo) return Promise.resolve({ fix: null, error: 'UNSUPPORTED' });
  return new Promise((resolve) => {
    try {
      geo.getCurrentPosition(
        (p) => resolve({ fix: { lat: p.coords.latitude, lng: p.coords.longitude, accuracyM: p.coords.accuracy, at: Date.now() }, error: null }),
        (e) => resolve({ fix: null, error: e.code === 1 ? 'DENIED' : 'TIMEOUT' }),
        { enableHighAccuracy: true, maximumAge: 0, timeout: timeoutMs },
      );
    } catch {
      resolve({ fix: null, error: 'UNSUPPORTED' });
    }
  });
}
