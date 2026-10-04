/**
 * A small JPEG reader and metadata stripper (owner request 4 Oct 2026, spec sections 12.1 and 12.2).
 * Pure and browser-safe (Uint8Array only): the driver page reads the image size and EXIF before it
 * compresses a photo, and the server checks every upload and strips it before storing.
 *
 * - inspectJpeg: a JPEG by its bytes (FF D8 FF ...), a parseable frame (SOF) with its size, and an
 *   end-of-image marker after the image data (a truncated file is refused).
 * - readExif: GPS latitude / longitude, DateTimeOriginal and OffsetTimeOriginal. Malformed EXIF gives
 *   null, never a throw. EXIF GPS is rarely present (most camera apps and browsers remove it): a bonus.
 * - stripJpeg: rewrites the file with only SOI, DQT, DHT, DAC, DRI, SOFn, SOS with its image data,
 *   APP0 (JFIF), APP14 (Adobe) and EOI. Everything else (EXIF with GPS, maker data, serial numbers,
 *   embedded thumbnails, comments, data after the image) is dropped, so nothing beyond the picture is
 *   stored.
 */
import { zonedDayStart } from '../dispatch/time';

const SOF = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);
/** Kept by stripJpeg (besides SOFn, SOS and the APP0 / APP14 checks). */
const KEEP = new Set([0xdb, 0xc4, 0xcc, 0xdd]);
export const MAX_JPEG_SIDE = 4000;

interface Segment {
  marker: number;
  /** Offset of the 0xFF of the marker. */
  start: number;
  /** Offset just after the segment (after the image data for an SOS). */
  end: number;
  /** Offset of the payload (after the 2 length bytes). */
  data: number;
  length: number;
}

const u16 = (b: Uint8Array, o: number) => (b[o]! << 8) | b[o + 1]!;

/** The end of the entropy-coded data that starts at `o`: the next marker that is not a stuffed byte or a restart. */
function scanEnd(b: Uint8Array, o: number): number {
  let i = o;
  while (i < b.length - 1) {
    if (b[i] === 0xff) {
      const m = b[i + 1]!;
      if (m === 0x00 || (m >= 0xd0 && m <= 0xd7) || m === 0xff) {
        i += m === 0xff ? 1 : 2;
        continue;
      }
      return i;
    }
    i++;
  }
  return -1;
}

/** The segments of a JPEG up to its EOI, or null when the structure is broken or truncated. */
function segments(b: Uint8Array): { list: Segment[]; eoi: number } | null {
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8 || b[2] !== 0xff) return null;
  const list: Segment[] = [];
  let i = 2;
  let sawScan = false;
  while (i < b.length) {
    if (b[i] !== 0xff) return null;
    while (i < b.length && b[i] === 0xff) i++; // fill bytes
    if (i >= b.length) return null;
    const marker = b[i]!;
    const start = i - 1;
    i++;
    if (marker === 0xd9) return sawScan ? { list, eoi: start } : null;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue; // no length
    if (i + 2 > b.length) return null;
    const length = u16(b, i);
    if (length < 2 || i + length > b.length) return null;
    const seg: Segment = { marker, start, end: i + length, data: i + 2, length };
    if (marker === 0xda) {
      const e = scanEnd(b, seg.end);
      if (e < 0) return null;
      seg.end = e;
      sawScan = true;
    }
    list.push(seg);
    i = seg.end;
  }
  return null;
}

export interface JpegInfo {
  width: number;
  height: number;
}

/** The size of a JPEG from its frame header, or null when the bytes are not a whole, sane JPEG. */
export function inspectJpeg(bytes: Uint8Array): JpegInfo | null {
  try {
    const s = segments(bytes);
    if (!s) return null;
    const sof = s.list.find((x) => SOF.has(x.marker));
    if (!sof || sof.length < 8) return null;
    const height = u16(bytes, sof.data + 1);
    const width = u16(bytes, sof.data + 3);
    if (width < 1 || height < 1 || width > MAX_JPEG_SIDE || height > MAX_JPEG_SIDE) return null;
    return { width, height };
  } catch {
    return null;
  }
}

/** Only the frame header's size, without walking the image data (the page reads it before decoding). */
export function jpegSize(bytes: Uint8Array): JpegInfo | null {
  try {
    if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
    let i = 2;
    while (i + 9 < bytes.length) {
      if (bytes[i] !== 0xff) return null;
      const m = bytes[i + 1]!;
      if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7) || m === 0xff) {
        i += m === 0xff ? 1 : 2;
        continue;
      }
      const len = u16(bytes, i + 2);
      if (SOF.has(m)) return { height: u16(bytes, i + 5), width: u16(bytes, i + 7) };
      if (m === 0xda || len < 2) return null;
      i += 2 + len;
    }
    return null;
  } catch {
    return null;
  }
}

/** A copy without metadata: see the top of this file. Throws on a broken JPEG (check inspectJpeg first). */
export function stripJpeg(bytes: Uint8Array): Uint8Array {
  const s = segments(bytes);
  if (!s) throw new Error('Not a JPEG');
  const parts: Uint8Array[] = [Uint8Array.of(0xff, 0xd8)];
  for (const seg of s.list) {
    const m = seg.marker;
    const isJfif = m === 0xe0 && seg.length >= 7 && String.fromCharCode(...bytes.subarray(seg.data, seg.data + 4)) === 'JFIF';
    const isAdobe = m === 0xee && seg.length >= 7 && String.fromCharCode(...bytes.subarray(seg.data, seg.data + 5)) === 'Adobe';
    if (SOF.has(m) || KEEP.has(m) || m === 0xda || isJfif || isAdobe) parts.push(bytes.subarray(seg.start, seg.end));
  }
  parts.push(Uint8Array.of(0xff, 0xd9));
  const out = new Uint8Array(parts.reduce((a, p) => a + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

export interface ExifFacts {
  lat: number | null;
  lng: number | null;
  /** DateTimeOriginal with OffsetTimeOriginal, else read in the company's time zone. */
  takenAt: Date | null;
  /** takenAt came with its own offset (an instant); false = a local phone-clock time read in the company zone. */
  zoned: boolean;
}

interface Tiff {
  b: Uint8Array;
  base: number;
  le: boolean;
}

const rd16 = (t: Tiff, o: number) => (t.le ? t.b[t.base + o]! | (t.b[t.base + o + 1]! << 8) : (t.b[t.base + o]! << 8) | t.b[t.base + o + 1]!);
const rd32 = (t: Tiff, o: number) =>
  t.le
    ? (t.b[t.base + o]! | (t.b[t.base + o + 1]! << 8) | (t.b[t.base + o + 2]! << 16) | (t.b[t.base + o + 3]! << 24)) >>> 0
    : ((t.b[t.base + o]! << 24) | (t.b[t.base + o + 1]! << 16) | (t.b[t.base + o + 2]! << 8) | t.b[t.base + o + 3]!) >>> 0;

interface Entry {
  tag: number;
  type: number;
  count: number;
  /** Offset (from the TIFF base) of the value. */
  at: number;
}

const TYPE_SIZE: Record<number, number> = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 7: 1, 9: 4, 10: 8 };

function ifd(t: Tiff, off: number, limit: number): Map<number, Entry> {
  const out = new Map<number, Entry>();
  if (off + 2 > limit) return out;
  const n = rd16(t, off);
  if (n > 500) return out;
  for (let k = 0; k < n; k++) {
    const e = off + 2 + k * 12;
    if (e + 12 > limit) break;
    const tag = rd16(t, e);
    const type = rd16(t, e + 2);
    const count = rd32(t, e + 4);
    const size = (TYPE_SIZE[type] ?? 0) * count;
    if (!size || size > 1024) continue;
    const at = size <= 4 ? e + 8 : rd32(t, e + 8);
    if (at + size > limit) continue;
    out.set(tag, { tag, type, count, at });
  }
  return out;
}

function ascii(t: Tiff, e: Entry | undefined): string | null {
  if (!e || e.type !== 2) return null;
  let s = '';
  for (let i = 0; i < e.count; i++) {
    const c = t.b[t.base + e.at + i]!;
    if (c === 0) break;
    s += String.fromCharCode(c);
  }
  return s.trim() || null;
}

function rationals(t: Tiff, e: Entry | undefined): number[] | null {
  if (!e || (e.type !== 5 && e.type !== 10) || e.count < 3) return null;
  const out: number[] = [];
  for (let i = 0; i < 3; i++) {
    const num = rd32(t, e.at + i * 8);
    const den = rd32(t, e.at + i * 8 + 4);
    if (!den) return null;
    out.push(num / den);
  }
  return out;
}

function degrees(t: Tiff, val: Entry | undefined, ref: Entry | undefined, neg: string, max: number): number | null {
  const r = rationals(t, val);
  const dir = ascii(t, ref);
  if (!r || !dir) return null;
  const v = r[0]! + r[1]! / 60 + r[2]! / 3600;
  if (!Number.isFinite(v) || v > max) return null;
  return dir.toUpperCase().startsWith(neg) ? -v : v;
}

/** "2026:10:05 09:12:30" (+ "+04:00") as an instant; without an offset, read in `tz`. */
export function exifTime(dateTime: string | null, offset: string | null, tz: string): Date | null {
  const m = /^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(dateTime ?? '');
  if (!m) return null;
  const [y, mo, d, h, mi, s] = m.slice(1).map(Number) as [number, number, number, number, number, number];
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59 || s > 60) return null;
  const off = /^([+-])(\d{2}):(\d{2})$/.exec(offset ?? '');
  if (off) {
    const sign = off[1] === '-' ? -1 : 1;
    const ms = Date.UTC(y, mo - 1, d, h, mi, s) - sign * (Number(off[2]) * 60 + Number(off[3])) * 60_000;
    return Number.isFinite(ms) ? new Date(ms) : null;
  }
  const iso = `${String(y).padStart(4, '0')}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  try {
    return new Date(zonedDayStart(iso, tz).getTime() + ((h * 60 + mi) * 60 + s) * 1000);
  } catch {
    return null;
  }
}

/** The EXIF GPS point and capture time of a JPEG's APP1, or null. Never throws. */
export function readExif(bytes: Uint8Array, tz: string): ExifFacts | null {
  try {
    if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
    let i = 2;
    while (i + 4 < bytes.length) {
      if (bytes[i] !== 0xff) return null;
      const m = bytes[i + 1]!;
      if (m === 0xda || m === 0xd9) return null;
      const len = u16(bytes, i + 2);
      if (len < 2) return null;
      const data = i + 4;
      if (m === 0xe1 && len >= 16 && String.fromCharCode(...bytes.subarray(data, data + 6)) === 'Exif\0\0') {
        const base = data + 6;
        const limit = Math.min(bytes.length, i + 2 + len) - base;
        const order = String.fromCharCode(bytes[base]!, bytes[base + 1]!);
        if (order !== 'II' && order !== 'MM') return null;
        const t: Tiff = { b: bytes, base, le: order === 'II' };
        if (rd16(t, 2) !== 42) return null;
        const ifd0 = ifd(t, rd32(t, 4), limit);
        const exifPtr = ifd0.get(0x8769);
        const gpsPtr = ifd0.get(0x8825);
        let takenAt: Date | null = null;
        let zoned = false;
        if (exifPtr) {
          const ex = ifd(t, rd32(t, exifPtr.at), limit);
          const offset = ascii(t, ex.get(0x9011));
          takenAt = exifTime(ascii(t, ex.get(0x9003)), offset, tz);
          zoned = !!takenAt && /^[+-]\d{2}:\d{2}$/.test(offset ?? '');
        }
        let lat: number | null = null;
        let lng: number | null = null;
        if (gpsPtr) {
          const g = ifd(t, rd32(t, gpsPtr.at), limit);
          lat = degrees(t, g.get(0x0002), g.get(0x0001), 'S', 90);
          lng = degrees(t, g.get(0x0004), g.get(0x0003), 'W', 180);
          if (lat === null || lng === null || (lat === 0 && lng === 0)) {
            lat = null;
            lng = null;
          }
        }
        return lat === null && takenAt === null ? null : { lat, lng, takenAt, zoned };
      }
      i += 2 + len;
    }
    return null;
  } catch {
    return null;
  }
}

/** The SHA-256-free byte check the server runs first: starts like a JPEG. */
export function startsLikeJpeg(bytes: Uint8Array): boolean {
  return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
}
