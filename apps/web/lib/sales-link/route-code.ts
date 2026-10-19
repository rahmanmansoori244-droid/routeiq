/**
 * The route or truck code a salesman types on the salesman link's page (owner request 19 Oct 2026; critique
 * item 18; the truck lookup: owner decision of 20 Oct 2026). Pure and browser-safe. The code is a FILTER, not a
 * password (the owner's choice: docs/SECURITY.md).
 *
 * Phones type codes in many ways, so the lookup is forgiving:
 * - each code is put through NFKC (full-width letters and digits become plain ones), Arabic-Indic and
 *   Eastern Arabic-Indic digits become 0-9, then the stored rule (lib/dispatch/sales-route.ts
 *   normSalesRoute: ends trimmed, inner spaces collapsed, upper-case, at most 40 characters);
 * - a code the day has exactly (after that) is that route; else the day's routes with the same COMPACT key
 *   (no spaces, hyphens, dots, slashes or underscores: "r 1", "R-1" and "r1" are one key) - every one of
 *   them when several share it (the salesman sees both and picks his);
 * - a code that is no route of the day is looked up among the day's TRUCKS, each by the code the plan shows (a
 *   day-hired truck by its plate: lib/dispatch/hire.ts shownTruckCode): the truck whose code is exactly the code
 *   typed (after the rule above: "1234-ab" is truck 1234-AB even when 1234.AB runs the same day), else the truck
 *   with the same compact key ("5678xy", "5678 XY" and "5678-XY" are one key), else, for a code of digits only,
 *   the ONE truck whose code has exactly those digits ("5678" for "5678-XY"). Several trucks with the same compact
 *   key, or with the digits, are not shown but offered as choices (SEVERAL_TRUCKS: one typed code never shows two
 *   trucks a pick could tell apart). Only trucks whose codes differ in letter case alone ("ab-1" and "AB-1": a
 *   pick could not tell them apart) are each shown, the code listed as ambiguous;
 * - a route code that is also a truck's code shows the ROUTE (the route is preferred) and offers the truck as a
 *   choice (ALSO_TRUCK); "Truck 5678-XY" (also "truck: 5678xy") looks among the trucks only: the page sends that
 *   form for a truck it shows or the salesman picks;
 * - several codes at once, "R1, R2X" or "C1, 5678" (two routes; a route and a truck): split on commas and
 *   semicolons (the Arabic comma too), at most MAX_CODES.
 * The only lists of codes are the day's own: its lines' routes (OrderLine.salesRoute) and the trucks of its plans
 * in use. An unknown code and a code without deliveries that day cannot be told apart, and the answer is the same.
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

/** A truck code's compact key: the same rule as a route's ("5678-xy", "5678 XY" and "٥٦٧٨XY" -> "5678XY"). */
export const compactTruckKey = compactRouteKey;

/** The digits of a code ("5678-XY" -> "5678"; Arabic-Indic digits as 0-9); "" without any. */
export function codeDigits(code: string): string {
  return compactRouteKey(code).replace(/\D+/g, '');
}

/** The explicit truck form: what the page sends for a truck it shows or offers ("Truck 5678-XY"). */
export function truckQuery(truckCode: string): string {
  return `Truck ${truckCode}`;
}

const TRUCK_FORM = /^TRUCK(?:\s*:\s*|\s+)(\S.*)$/;

/** The truck code of an explicit truck lookup ("Truck 5678-XY" -> "5678-XY", "truck:5678xy" -> "5678XY"); else null. */
export function explicitTruck(code: string): string | null {
  const m = TRUCK_FORM.exec(normTypedRoute(code) ?? '');
  return m ? m[1]!.trim() || null : null;
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

/** One truck of the day: an id the server keeps (never sent) and its code as the plan shows it. */
export interface DayTruckRef {
  id: string;
  code: string;
}

/**
 * A typed code the page offers choices for: several trucks have its compact key or its digits (SEVERAL_TRUCKS:
 * none of them is shown), or a route code is also a truck's code (ALSO_TRUCK: the route is shown).
 */
export interface LookupChoice {
  asked: string;
  why: 'SEVERAL_TRUCKS' | 'ALSO_TRUCK';
  /** ALSO_TRUCK: the routes the code showed; else none. */
  routes: string[];
  /** The trucks to choose from (ids), in code order. */
  trucks: string[];
}

export interface LookupMatch extends RouteMatch {
  /** The day's trucks the codes matched (ids), in code order, each once. */
  trucks: string[];
  choices: LookupChoice[];
}

const byTruckCode = (a: DayTruckRef, b: DayTruckRef) => compareSalesRoutes(a.code, b.code) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/**
 * The day's routes and trucks the typed codes name (the file comment): per code, an explicit "Truck X" among the
 * trucks only; else a route (exact, else compact key) first, offering a truck with that code as a choice; else a
 * truck (exact code, else compact key, else a unique digits-only match; several: choices); else not found.
 */
export function matchLookup(codes: readonly string[], knownRoutes: Iterable<string>, knownTrucks: Iterable<DayTruckRef>): LookupMatch {
  const routeList = [...knownRoutes];
  const trucks = [...new Map([...knownTrucks].map((t) => [t.id, t])).values()].sort(byTruckCode);
  const normOf = new Map(trucks.map((t) => [t.id, normTypedRoute(t.code)]));
  const keyOf = new Map(trucks.map((t) => [t.id, compactTruckKey(t.code)]));
  const digitsOf = new Map(trucks.map((t) => [t.id, codeDigits(t.code)]));
  /**
   * The trucks a code names, the first rule that finds any: `same` the trucks whose code is the code typed
   * (normalised; several only when their codes differ in letter case alone), else `several` the trucks with the
   * same compact key, else (a code of digits only) the trucks with exactly those digits.
   */
  const truckHits = (code: string): { same: DayTruckRef[]; several: DayTruckRef[] } => {
    const norm = normTypedRoute(code);
    const key = compactTruckKey(code);
    if (!norm || !key) return { same: [], several: [] };
    const same = trucks.filter((t) => normOf.get(t.id) === norm);
    if (same.length) return { same, several: [] };
    const compact = trucks.filter((t) => keyOf.get(t.id) === key);
    if (compact.length || !/^\d+$/.test(key)) return { same: [], several: compact };
    return { same: [], several: trucks.filter((t) => digitsOf.get(t.id) === key) };
  };

  const routes = new Set<string>();
  const found = new Set<string>();
  const notFound: string[] = [];
  const ambiguous: string[] = [];
  const choices: LookupChoice[] = [];
  /**
   * A code among the trucks only: the truck shown (trucks whose codes differ in letter case alone: each, the code
   * ambiguous), several offered as choices (none shown), or false.
   */
  const asTruck = (asked: string, code: string): boolean => {
    const { same, several } = truckHits(code);
    if (same.length) {
      if (same.length > 1) ambiguous.push(asked);
      for (const t of same) found.add(t.id);
      return true;
    }
    if (several.length === 1) {
      found.add(several[0]!.id);
      return true;
    }
    if (several.length > 1) {
      choices.push({ asked, why: 'SEVERAL_TRUCKS', routes: [], trucks: several.map((t) => t.id) });
      return true;
    }
    return false;
  };
  for (const c of codes) {
    const truck = explicitTruck(c);
    if (truck !== null) {
      if (!asTruck(c, truck)) notFound.push(c);
      continue;
    }
    const r = matchRoutes([c], routeList);
    if (r.routes.length) {
      // The route is preferred; a truck with that code is offered.
      for (const x of r.routes) routes.add(x);
      ambiguous.push(...r.ambiguous);
      const { same, several } = truckHits(c);
      const also = same.length ? same : several;
      if (also.length) choices.push({ asked: c, why: 'ALSO_TRUCK', routes: r.routes, trucks: also.map((t) => t.id) });
      continue;
    }
    if (!asTruck(c, c)) notFound.push(c);
  }
  return {
    routes: [...routes].sort(compareSalesRoutes),
    trucks: trucks.filter((t) => found.has(t.id)).map((t) => t.id),
    notFound,
    ambiguous,
    choices,
  };
}
