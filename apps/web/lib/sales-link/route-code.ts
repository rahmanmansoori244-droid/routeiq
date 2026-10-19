/**
 * The route code a salesman types on the salesman link's page (owner request 19 Oct 2026; critique item 18).
 * Pure and browser-safe. The code is a FILTER, not a password (the owner's choice: docs/SECURITY.md).
 *
 * Phones type codes in many ways, so the lookup is forgiving:
 * - each code is put through NFKC (full-width letters and digits become plain ones), Arabic-Indic and
 *   Eastern Arabic-Indic digits become 0-9, then the stored rule (lib/dispatch/sales-route.ts
 *   normSalesRoute: ends trimmed, inner spaces collapsed, upper-case, at most 40 characters);
 * - a code the day has exactly (after that) is that route; else the day's routes with the same COMPACT key
 *   (no spaces, hyphens, dots, slashes or underscores: "r 1", "R-1" and "r1" are one key) - every one of
 *   them when several share it (the salesman sees both and picks his);
 * - several codes at once, "R1, R2X" (a salesman with two routes): split on commas and semicolons (the
 *   Arabic comma too), at most MAX_CODES.
 * The only list of codes is the day's own lines (OrderLine.salesRoute): an unknown code and a code without
 * deliveries that day cannot be told apart, and the answer is the same.
 */
import { normSalesRoute, SALES_ROUTE_MAX, compareSalesRoutes } from '../dispatch/sales-route';

/** At most this many codes in one lookup ("R1, R2X"). */
export const MAX_CODES = 5;
/** The longest text the lookup reads (more is refused: 400 ROUTE_CODE_TOO_LONG). */
export const MAX_QUERY_CHARS = (SALES_ROUTE_MAX + 2) * MAX_CODES;

const ARABIC_INDIC_ZERO = 0x0660;
const EASTERN_ARABIC_INDIC_ZERO = 0x06f0;

/** Arabic-Indic (U+0660-0669) and Eastern Arabic-Indic (U+06F0-06F9) digits as 0-9; other characters unchanged. */
export function asciiDigits(s: string): string {
  let out = '';
  for (const ch of s) {
    const c = ch.codePointAt(0)!;
    if (c >= ARABIC_INDIC_ZERO && c <= ARABIC_INDIC_ZERO + 9) out += String(c - ARABIC_INDIC_ZERO);
    else if (c >= EASTERN_ARABIC_INDIC_ZERO && c <= EASTERN_ARABIC_INDIC_ZERO + 9) out += String(c - EASTERN_ARABIC_INDIC_ZERO);
    else out += ch;
  }
  return out;
}

/** A typed code as the stored codes are written (NFKC, ASCII digits, then normSalesRoute); null when empty. */
export function normTypedRoute(raw: string | null | undefined): string | null {
  return normSalesRoute(asciiDigits(String(raw ?? '').normalize('NFKC')));
}

/** The compact key of a code: the normalised code without spaces, hyphens, dots, slashes and underscores. */
export function compactRouteKey(code: string): string {
  return (normTypedRoute(code) ?? '').replace(/[\s\-._/\\]+/g, '');
}

export type RouteQuery = { ok: true; codes: string[] } | { ok: false; code: 'ROUTE_CODE_MISSING' | 'ROUTE_CODE_TOO_LONG' | 'TOO_MANY_CODES' };

/** The codes of a typed text ("r1, R2x" -> ["R1", "R2X"]): normalised, distinct, in the order typed. */
export function parseRouteQuery(raw: string | null | undefined): RouteQuery {
  const text = String(raw ?? '');
  if (text.length > MAX_QUERY_CHARS) return { ok: false, code: 'ROUTE_CODE_TOO_LONG' };
  const parts = text
    .normalize('NFKC')
    .split(/[,;،؛]+/)
    .map((p) => p.trim())
    .filter(Boolean);
  if (parts.some((p) => Array.from(p).length > SALES_ROUTE_MAX)) return { ok: false, code: 'ROUTE_CODE_TOO_LONG' };
  const codes: string[] = [];
  for (const p of parts) {
    const c = normTypedRoute(p);
    if (c && !codes.includes(c)) codes.push(c);
  }
  if (!codes.length) return { ok: false, code: 'ROUTE_CODE_MISSING' };
  if (codes.length > MAX_CODES) return { ok: false, code: 'TOO_MANY_CODES' };
  return { ok: true, codes };
}

export interface RouteMatch {
  /** The day's routes the codes matched, in natural order, each once. */
  routes: string[];
  /** The typed codes (normalised) that matched no route of the day. */
  notFound: string[];
  /** Typed codes whose compact key matched more than one of the day's routes (each of them is in `routes`). */
  ambiguous: string[];
}

/**
 * The day's routes (`known`: every distinct OrderLine.salesRoute of the date, normalised as stored) that
 * the typed codes name: an exact match first, else every route with the same compact key.
 */
export function matchRoutes(codes: readonly string[], known: Iterable<string>): RouteMatch {
  const exact = new Set<string>();
  const byCompact = new Map<string, string[]>();
  for (const k of known) {
    exact.add(k);
    const key = compactRouteKey(k);
    if (!key) continue;
    const list = byCompact.get(key);
    if (list) {
      if (!list.includes(k)) list.push(k);
    } else byCompact.set(key, [k]);
  }
  const routes = new Set<string>();
  const notFound: string[] = [];
  const ambiguous: string[] = [];
  for (const c of codes) {
    if (exact.has(c)) {
      routes.add(c);
      continue;
    }
    const same = byCompact.get(compactRouteKey(c)) ?? [];
    if (!same.length) {
      notFound.push(c);
      continue;
    }
    if (same.length > 1) ambiguous.push(c);
    for (const r of same) routes.add(r);
  }
  return { routes: [...routes].sort(compareSalesRoutes), notFound, ambiguous };
}
