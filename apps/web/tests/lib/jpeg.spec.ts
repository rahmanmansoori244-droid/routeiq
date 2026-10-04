/**
 * The JPEG reader and metadata stripper (owner request 4 Oct 2026, spec sections 12.1, 12.2 and 18.1).
 * Every file is built byte by byte in this test: a minimal JPEG structure, EXIF blocks with GPS and
 * capture times, an embedded thumbnail and a comment payload. Synthetic data only.
 */
import { describe, expect, it } from 'vitest';
import { exifTime, inspectJpeg, jpegSize, readExif, startsLikeJpeg, stripJpeg } from '@/lib/delivery/jpeg';

const seg = (marker: number, payload: number[]) => [0xff, marker, (payload.length + 2) >> 8, (payload.length + 2) & 0xff, ...payload];
const ascii = (s: string) => [...s].map((c) => c.charCodeAt(0));

const JFIF = seg(0xe0, [...ascii('JFIF'), 0, 1, 1, 0, 0, 1, 0, 1, 0, 0]);
const DQT = seg(0xdb, [0, ...Array.from({ length: 64 }, () => 1)]);
const sof = (w: number, h: number) => seg(0xc0, [8, h >> 8, h & 0xff, w >> 8, w & 0xff, 1, 1, 0x11, 0]);
const DHT = seg(0xc4, [0, 1, ...Array.from({ length: 15 }, () => 0), 0]);
const SOS = seg(0xda, [1, 1, 0, 0, 63, 0]);
// Image data with a stuffed 0xFF00 and a restart marker inside, as real scans have.
const SCAN = [0x12, 0x34, 0xff, 0x00, 0x56, 0xff, 0xd0, 0x78, 0x9a];
const EOI = [0xff, 0xd9];

function jpeg(extra: number[][] = [], opts: { w?: number; h?: number; trailer?: number[] } = {}): Uint8Array {
  return Uint8Array.from([0xff, 0xd8, ...JFIF, ...extra.flat(), ...DQT, ...sof(opts.w ?? 640, opts.h ?? 480), ...DHT, ...SOS, ...SCAN, ...EOI, ...(opts.trailer ?? [])]);
}

/** A little- or big-endian TIFF block with IFD0 -> Exif IFD (times) and GPS IFD (point). */
function exifApp1(o: { lat?: [number, string]; lng?: [number, string]; time?: string; offset?: string; le?: boolean }): number[] {
  const le = o.le ?? true;
  const w16 = (v: number) => (le ? [v & 0xff, (v >> 8) & 0xff] : [(v >> 8) & 0xff, v & 0xff]);
  const w32 = (v: number) => (le ? [v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >>> 24) & 0xff] : [(v >>> 24) & 0xff, (v >> 16) & 0xff, (v >> 8) & 0xff, v & 0xff]);
  const out: number[] = [];
  const data: number[] = [];
  // Layout: header (8) | IFD0 (2 + 2*12 + 4 = 30) | Exif IFD (2 + 2*12 + 4 = 30) | GPS IFD (2 + 4*12 + 4 = 54) | data
  const IFD0 = 8;
  const EXIF = IFD0 + 30;
  const GPS = EXIF + 30;
  const DATA = GPS + 54;
  const put = (bytes: number[]) => {
    const at = DATA + data.length;
    data.push(...bytes);
    return at;
  };
  const entry = (tag: number, type: number, count: number, value: number[] | number) => [...w16(tag), ...w16(type), ...w32(count), ...(Array.isArray(value) ? [...value, 0, 0, 0, 0].slice(0, 4) : w32(value))];
  const dms = (deg: number) => {
    const d = Math.floor(deg);
    const mFull = (deg - d) * 60;
    const m = Math.floor(mFull);
    const s = Math.round((mFull - m) * 60 * 1000);
    return [...w32(d), ...w32(1), ...w32(m), ...w32(1), ...w32(s), ...w32(1000)];
  };
  out.push(...(le ? ascii('II') : ascii('MM')), ...w16(42), ...w32(IFD0));
  out.push(...w16(2), ...entry(0x8769, 4, 1, EXIF), ...entry(0x8825, 4, 1, GPS), ...w32(0));
  const time = o.time ? put([...ascii(o.time), 0]) : 0;
  const offs = o.offset ? put([...ascii(o.offset), 0]) : 0;
  out.push(...w16(2), ...(o.time ? entry(0x9003, 2, o.time.length + 1, time) : entry(0x0000, 1, 1, [0])), ...(o.offset ? entry(0x9011, 2, o.offset.length + 1, offs) : entry(0x0000, 1, 1, [0])), ...w32(0));
  const lat = o.lat ? put(dms(o.lat[0])) : 0;
  const lng = o.lng ? put(dms(o.lng[0])) : 0;
  out.push(
    ...w16(4),
    ...entry(0x0001, 2, 2, ascii((o.lat?.[1] ?? 'N') + '\0')),
    ...entry(0x0002, 5, o.lat ? 3 : 1, o.lat ? lat : [0]),
    ...entry(0x0003, 2, 2, ascii((o.lng?.[1] ?? 'E') + '\0')),
    ...entry(0x0004, 5, o.lng ? 3 : 1, o.lng ? lng : [0]),
    ...w32(0),
  );
  return seg(0xe1, [...ascii('Exif'), 0, 0, ...out, ...data]);
}

const TZ = 'Asia/Muscat';

describe('inspectJpeg', () => {
  it('accepts a minimal JPEG and reads its frame size', () => {
    expect(inspectJpeg(jpeg())).toEqual({ width: 640, height: 480 });
    expect(jpegSize(jpeg([], { w: 1600, h: 1200 }))).toEqual({ width: 1600, height: 1200 });
    expect(startsLikeJpeg(jpeg())).toBe(true);
  });

  it('rejects PNG, GIF, HTML, an HTML-prefixed JPEG, a truncated file and a frame over 4000 px', () => {
    const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
    const gif = Uint8Array.from(ascii('GIF89a\x01\x00\x01\x00'));
    const html = Uint8Array.from(ascii('<!doctype html><script>alert(1)</script>'));
    const prefixed = Uint8Array.from([...ascii('<html>'), ...jpeg()]);
    const full = jpeg();
    const truncated = full.subarray(0, full.length - 6);
    for (const b of [png, gif, html, prefixed, truncated]) expect(inspectJpeg(b)).toBeNull();
    expect(startsLikeJpeg(png)).toBe(false);
    expect(inspectJpeg(jpeg([], { w: 5000, h: 3000 }))).toBeNull();
  });
});

describe('readExif', () => {
  it('reads GPS (N/E) and DateTimeOriginal with OffsetTimeOriginal', () => {
    const b = jpeg([exifApp1({ lat: [23.5859, 'N'], lng: [58.4059, 'E'], time: '2026:10:05 09:12:30', offset: '+04:00' })]);
    const e = readExif(b, TZ)!;
    expect(e.lat).toBeCloseTo(23.5859, 4);
    expect(e.lng).toBeCloseTo(58.4059, 4);
    expect(e.takenAt?.toISOString()).toBe('2026-10-05T05:12:30.000Z');
    expect(e.zoned).toBe(true);
  });

  it('reads S and W as negative, and a big-endian (MM) block', () => {
    const e = readExif(jpeg([exifApp1({ lat: [33.9, 'S'], lng: [18.4, 'W'], le: false })]), TZ)!;
    expect(e.lat).toBeCloseTo(-33.9, 4);
    expect(e.lng).toBeCloseTo(-18.4, 4);
    expect(e.takenAt).toBeNull();
  });

  it('an EXIF time without an offset is read in the company time zone', () => {
    const e = readExif(jpeg([exifApp1({ time: '2026:10:05 09:12:30' })]), TZ)!;
    expect(e.takenAt?.toISOString()).toBe('2026-10-05T05:12:30.000Z');
    // A local phone-clock time: not an instant (the "taken earlier" check ignores it).
    expect(e.zoned).toBe(false);
    expect(e.lat).toBeNull();
    expect(exifTime('2026:10:05 09:12:30', '-03:30', TZ)?.toISOString()).toBe('2026-10-05T12:42:30.000Z');
    expect(exifTime('not a time', null, TZ)).toBeNull();
  });

  it('malformed EXIF gives null, never a throw', () => {
    const broken = seg(0xe1, [...ascii('Exif'), 0, 0, ...ascii('II'), 42, 0, 0xff, 0xff, 0xff, 0x7f]);
    expect(readExif(jpeg([broken]), TZ)).toBeNull();
    const garbage = seg(0xe1, [...ascii('Exif'), 0, 0, ...Array.from({ length: 40 }, (_, i) => (i * 37) & 0xff)]);
    expect(() => readExif(jpeg([garbage]), TZ)).not.toThrow();
    expect(readExif(jpeg(), TZ)).toBeNull();
    expect(readExif(Uint8Array.from([1, 2, 3]), TZ)).toBeNull();
  });
});

describe('stripJpeg', () => {
  it('drops EXIF GPS, an embedded thumbnail, a COM payload and data after the image; keeps a valid JPEG with the same scan data', () => {
    const thumb = seg(0xe1, [...ascii('Exif'), 0, 0, ...ascii('THUMBNAIL'), 0xff, 0xd8, 0xff, 0xd9]);
    const com = seg(0xfe, ascii('serial 12345 <script>'));
    const app2 = seg(0xe2, ascii('ICC_PROFILE'));
    const input = jpeg([exifApp1({ lat: [23.5859, 'N'], lng: [58.4059, 'E'], time: '2026:10:05 09:12:30' }), thumb, com, app2], { trailer: ascii('SEFT trailer') });
    expect(readExif(input, TZ)?.lat).toBeCloseTo(23.5859, 4);
    const out = stripJpeg(input);
    expect(inspectJpeg(out)).toEqual({ width: 640, height: 480 });
    expect(readExif(out, TZ)).toBeNull();
    const text = String.fromCharCode(...out);
    for (const gone of ['Exif', 'THUMBNAIL', 'serial', 'ICC_PROFILE', 'SEFT']) expect(text).not.toContain(gone);
    expect(text).toContain('JFIF');
    // The scan data is unchanged and the file ends at its EOI.
    const scanAt = out.findIndex((_, i) => out[i] === 0xff && out[i + 1] === 0xda);
    const sosLen = (out[scanAt + 2]! << 8) | out[scanAt + 3]!;
    expect([...out.subarray(scanAt + 2 + sosLen, scanAt + 2 + sosLen + SCAN.length)]).toEqual(SCAN);
    expect([...out.subarray(out.length - 2)]).toEqual(EOI);
    expect(out.length).toBeLessThan(input.length);
  });

  it('keeps an Adobe APP14 and refuses a broken file', () => {
    const adobe = seg(0xee, [...ascii('Adobe'), 0, 100, 0, 0, 0, 0, 1]);
    expect(String.fromCharCode(...stripJpeg(jpeg([adobe])))).toContain('Adobe');
    expect(() => stripJpeg(Uint8Array.from(ascii('<html>')))).toThrow();
  });
});
