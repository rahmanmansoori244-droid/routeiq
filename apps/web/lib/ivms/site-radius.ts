/**
 * A customer's GPS site radius (Customer.siteRadiusM; owner request 19 Oct 2026: "at big customers the
 * truck moves between drop points and the model thinks it left"). Pure and browser-safe: the customer
 * Details dialog, the API schema, the stop detector (lib/ivms/stops.ts) and the GPS alerts
 * (lib/alerts/gps.ts) read the same rule.
 *
 * What it does: the truck ARRIVES at the customer as before (the first trail point within the company's
 * stop radius, Settings ivmsStopRadiusM, default 100 m, of the pin), but its stay ENDS only when it leaves
 * the site radius (beyond it at 10 km/h or more, or two points beyond it + 50 m), so a second drop point
 * 353-378 m from the pin (the GPS study of 18-19 Oct 2026, one big customer) is still the same visit. The
 * live "the truck is at the stop" of the GPS alerts uses it too, never narrower than the company's own.
 *
 * Empty (NULL, the default) = the company's stop radius: today's behaviour. 100 to 500 m, whole metres
 * (database CHECK "Customer_siteRadiusM_range", migration 20261019120000_gps_site_radius_away): at most
 * the 500 m within which the detector merges the stays of one site (stops.ts SITE_MAX_M), so a site
 * radius never reaches past what counts as "on the site". Set it only for a customer whose trucks
 * really unload at several points of one site: a bigger radius for everyone made the study's results
 * worse (two customers' pins inside one circle: nothing written for either).
 *
 * Neighbours (review of 19 Oct 2026, real data: a big customer 235 m from the next customer on the same
 * trip): the site radius takes over only once the truck stood at the pin, and a site stay ends where the
 * truck reaches another open stop's pin (stops.ts staysAt), so a neighbour is not swallowed; still, when
 * another active customer's pin lies within the site radius + the stop radius, the save says so
 * (siteRadiusWarning, PATCH /api/customers/:id): the office then checks that the trucks really unload that
 * far out, or sets a smaller radius.
 */
import { distanceM } from '../dispatch/snapshots';

/** The smallest and largest site radius the office can set (metres). */
export const SITE_RADIUS_MIN_M = 100;
export const SITE_RADIUS_MAX_M = 500;

/** The Details dialog's label and the hint under it. */
export const SITE_RADIUS_FIELD_LABEL = 'GPS site radius (m)';
export const SITE_RADIUS_HINT = `Big sites only (several drop points): GPS tracking counts the truck as still at this customer until it is this far from the pin. ${SITE_RADIUS_MIN_M}-${SITE_RADIUS_MAX_M} m; empty = the company's stop radius (Settings). Keep it smaller than the distance to a neighbouring customer: the save warns when another customer's pin is inside it.`;

/** A stored or sent site radius that the detector may use: a whole number of metres in range, else null (the company's radius). */
export function validSiteRadius(v: unknown): number | null {
  return typeof v === 'number' && Number.isInteger(v) && v >= SITE_RADIUS_MIN_M && v <= SITE_RADIUS_MAX_M ? v : null;
}

export type SiteRadiusParse = { ok: true; radiusM: number | null } | { ok: false; error: string };

/** The dialog's box as typed: empty = none (null), else whole metres from 100 to 500, or why not. */
export function readSiteRadius(raw: string | null | undefined): SiteRadiusParse {
  const s = (raw ?? '').trim();
  if (!s) return { ok: true, radiusM: null };
  if (!/^\d+$/.test(s)) return { ok: false, error: `${SITE_RADIUS_FIELD_LABEL} "${s}": enter whole metres, e.g. 400. Leave it empty to use the company's stop radius.` };
  const n = Number(s);
  if (n < SITE_RADIUS_MIN_M || n > SITE_RADIUS_MAX_M) return { ok: false, error: `${SITE_RADIUS_FIELD_LABEL}: from ${SITE_RADIUS_MIN_M} to ${SITE_RADIUS_MAX_M} m, or empty.` };
  return { ok: true, radiusM: n };
}

/** Another active customer near a customer with a site radius (the save's warning). */
export interface SiteNeighbour {
  code: string;
  branchCode: string | null;
  name: string;
  /** Pin to pin, whole metres. */
  distanceM: number;
}

/**
 * The other customers whose pin lies within the site radius + the stop radius of this customer's pin, nearest
 * first (review of 19 Oct 2026): a truck at one of them is inside this customer's site circle, or arrives
 * there within the stop radius. Pure; `others` without a pin are skipped.
 */
export function siteRadiusNeighbours(
  pin: { lat: number; lng: number },
  siteRadiusM: number,
  stopRadiusM: number,
  others: readonly { code: string; branchCode?: string | null; name: string; lat: number | null; lng: number | null }[],
): SiteNeighbour[] {
  const reach = siteRadiusM + stopRadiusM;
  const out: SiteNeighbour[] = [];
  for (const o of others) {
    if (o.lat === null || o.lng === null || !Number.isFinite(o.lat) || !Number.isFinite(o.lng)) continue;
    const d = distanceM(pin, { lat: o.lat, lng: o.lng });
    if (d <= reach) out.push({ code: o.code, branchCode: o.branchCode ?? null, name: o.name, distanceM: Math.round(d) });
  }
  return out.sort((a, b) => a.distanceM - b.distanceM || a.code.localeCompare(b.code));
}

/** At most this many neighbours are named in the warning. */
export const SITE_NEIGHBOURS_NAMED = 3;

/**
 * The save's warning for a site radius with neighbours (null: none). Plain words for the office: what GPS
 * does with the neighbour, and what to check.
 */
export function siteRadiusWarning(siteRadiusM: number, stopRadiusM: number, neighbours: readonly SiteNeighbour[]): string | null {
  if (!neighbours.length) return null;
  const named = neighbours
    .slice(0, SITE_NEIGHBOURS_NAMED)
    .map((n) => `${n.code}${n.branchCode ? ` / ${n.branchCode}` : ''} (${n.name}, ${n.distanceM} m)`)
    .join(', ');
  const more = neighbours.length > SITE_NEIGHBOURS_NAMED ? ` and ${neighbours.length - SITE_NEIGHBOURS_NAMED} more` : '';
  const one = neighbours.length === 1;
  return (
    `GPS site radius ${siteRadiusM} m saved. Check it: the pin of ${named}${more} ${one ? 'is' : 'are'} within ${siteRadiusM + stopRadiusM} m of this customer's pin (the site radius + the stop radius ${stopRadiusM} m). ` +
    `When a truck visits ${one ? 'that customer' : 'them'} on the same trip, GPS ends this customer's stay where the truck reaches ${one ? 'its' : 'their'} pin; a stay that still overlaps gets no GPS times for either. ` +
    `Keep the site radius only if trucks really unload that far from this pin, else make it smaller or empty.`
  );
}
