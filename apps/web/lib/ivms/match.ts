/**
 * Truck-to-tracker mapping helpers of the IVMS live link (16 Oct 2026, design section 8.1): a tracker is
 * mapped by its IMEI only (owner decision D-2 recommendation); the plate digits only SUGGEST which
 * tracker is which truck. Pure and browser-safe.
 *
 * Privacy: the provider's object list carries names (often a driver's name) and plates. They are read
 * here in memory only to compute a plate key (digits and letters) and are never returned, stored or
 * logged: a suggestion carries the IMEI, how well it matches and how old the tracker's last fix is.
 */

/** Arabic-Indic (U+0660..0669) and Extended Arabic-Indic (U+06F0..06F9) digits as ASCII. */
export function asciiDigits(s: string): string {
  return s.replace(/[\u0660-\u0669]/g, (c) => String(c.charCodeAt(0) - 0x0660)).replace(/[\u06f0-\u06f9]/g, (c) => String(c.charCodeAt(0) - 0x06f0));
}

/**
 * A typed tracker IMEI: Arabic digits, spaces, dashes and dots allowed while typing; the result is
 * 10-20 ASCII digits (the database CHECK), else null.
 */
export function normalizeImei(raw: string): string | null {
  const s = asciiDigits(raw.normalize('NFKC')).replace(/[\s.\-_/]/g, '');
  return /^\d{10,20}$/.test(s) ? s : null;
}

/** "ends 1234" for an audit row or a message: never the whole IMEI in a log. */
export function imeiTail(imei: string | null | undefined): string {
  return imei ? `ends ${imei.slice(-4)}` : 'none';
}

export interface PlateKey {
  /** The digits in order. */
  digits: string;
  /** The letters, as a sorted multiset (Latin upper case and Arabic letters). */
  letters: string;
}

/** The plate key of a plate or truck code ("1234 AB", "AB-1234", Arabic digits): null without 3 digits. */
export function plateKey(raw: string | null | undefined): PlateKey | null {
  if (!raw) return null;
  const s = asciiDigits(raw.normalize('NFKC')).toUpperCase();
  const digits = (s.match(/\d/g) ?? []).join('');
  if (digits.length < 3) return null;
  const letters = (s.match(/[A-Z\u0621-\u064a]/g) ?? []).sort().join('');
  return { digits, letters };
}

/** One tracker of the provider's object list, reduced to what matching needs (no name, no plate text). */
export interface TrackerRow {
  imei: string;
  key: PlateKey | null;
  /** Minutes since the tracker's last fix; null = unknown. */
  fixAgeMin: number | null;
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v.trim() : typeof v === 'number' && Number.isFinite(v) ? String(v) : null;
}

/**
 * The trackers of a USER_GET_OBJECTS answer (an array of objects, or an object keyed by IMEI; '[]' when
 * empty), or null when the answer has neither shape. The plate key comes from plate_number, else from
 * the object's name; neither is kept. Times are UTC "YYYY-MM-DD HH:MM:SS" plus the API time offset.
 */
export function trackerRowsOf(body: unknown, now: Date, offsetMin = 0): TrackerRow[] | null {
  let items: [string | null, unknown][];
  if (Array.isArray(body)) items = body.map((o) => [null, o]);
  else if (body && typeof body === 'object') items = Object.entries(body as Record<string, unknown>);
  else return null;
  const out: TrackerRow[] = [];
  const seen = new Set<string>();
  for (const [k, o] of items) {
    if (!o || typeof o !== 'object') continue;
    const x = o as Record<string, unknown>;
    const imei = normalizeImei(str(x.imei) ?? k ?? '');
    if (!imei || seen.has(imei)) continue;
    seen.add(imei);
    const key = plateKey(str(x.plate_number)) ?? plateKey(str(x.name));
    const t = str(x.dt_tracker) ?? str(x.dt_server);
    const at = t && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(t) ? Date.parse(`${t.replace(' ', 'T')}Z`) + offsetMin * 60_000 : NaN;
    out.push({ imei, key, fixAgeMin: Number.isFinite(at) ? Math.max(0, Math.round((now.getTime() - at) / 60_000)) : null });
  }
  return out;
}

export type MatchKind = 'EXACT' | 'DIGITS' | 'AMBIGUOUS';

export interface TrackerSuggestion {
  truckId: string;
  imei: string;
  /** EXACT: same digits and letters (offered first); DIGITS: same digits only; AMBIGUOUS: several trackers have these digits. */
  match: MatchKind;
  fixAgeMin: number | null;
}

/**
 * Suggestions for the trucks without a tracker, from the trackers not mapped to any truck of the
 * company: same plate digits; EXACT with the same letters too; several trackers with the same digits
 * are all AMBIGUOUS (never offered as the one). Plus how many trackers matched no truck (a count only).
 */
export function suggestTrackers(trucks: readonly { id: string; code: string; ivmsImei: string | null }[], trackers: readonly TrackerRow[]): { suggestions: TrackerSuggestion[]; unmatchedTrackers: number; trackers: number } {
  const mapped = new Set(trucks.map((t) => t.ivmsImei).filter((x): x is string => !!x));
  const free = trackers.filter((t) => !mapped.has(t.imei) && t.key);
  const used = new Set<string>();
  const suggestions: TrackerSuggestion[] = [];
  for (const truck of trucks) {
    if (truck.ivmsImei) continue;
    const key = plateKey(truck.code);
    if (!key) continue;
    const same = free.filter((t) => t.key!.digits === key.digits);
    if (!same.length) continue;
    for (const t of same) {
      used.add(t.imei);
      const match: MatchKind = same.length > 1 ? 'AMBIGUOUS' : t.key!.letters && t.key!.letters === key.letters ? 'EXACT' : 'DIGITS';
      suggestions.push({ truckId: truck.id, imei: t.imei, match, fixAgeMin: t.fixAgeMin });
    }
  }
  const rank: Record<MatchKind, number> = { EXACT: 0, DIGITS: 1, AMBIGUOUS: 2 };
  suggestions.sort((a, b) => a.truckId.localeCompare(b.truckId) || rank[a.match] - rank[b.match] || a.imei.localeCompare(b.imei));
  return { suggestions, unmatchedTrackers: trackers.filter((t) => !mapped.has(t.imei) && !used.has(t.imei)).length, trackers: trackers.length };
}
