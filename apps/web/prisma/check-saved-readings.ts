/**
 * Read-only count for the owner's check before the audit PR A5 deploy (handbook 5.12, step 13; A5
 * sixth review). A customer saved in ADD LOCATION from what the dispatcher pasted (locationSource
 * MANUAL_LATLNG or GOOGLE_MAPS_URL, confirmed) keeps that text in Customer.locationInput. Some of
 * those texts read as exact before A5 and do not now: a pair padded with zeros ("23.5800, 58.4100"),
 * Google's pin or degrees, minutes and seconds of a rough pair, and, before A5, any reading the old
 * screen let through (a map centre, fewer than 4 decimals). Those customers stay usable: a confirmed
 * point is not judged again. This counts them per company, with the parser of the commit it runs on
 * and the company's delivery area, so the owner can decide whether to flag them.
 *
 * Only a text the saved point was read from is judged (A5 seventh review). Main's customer page
 * saved a map click or two typed numbers (PATCH { lat, lng }) as MANUAL_LATLNG, confirmed and HIGH,
 * and left locationInput as it was: empty, or an older ADD LOCATION text for another point. So a
 * text counts only when it reads back to the saved point (to the 6 decimals the parser keeps), or
 * when it holds the saved point as numbers but reads otherwise today (read differently before A5,
 * such as a directions link main read at its start). The other customers are listed apart, never
 * judged by their text: no text kept, a text that reads as another point, the saved numbers as
 * RouteIQ writes them (`${lat}, ${lng}`, written when a saved point is confirmed as it is; only
 * those that read as not exact are apart, since an exact one is exact whoever wrote it), and a text
 * that cannot be read and does not hold the saved point ("map pin"). For them the count says how
 * many have fewer than 4 decimals as stored: a stored number cannot tell a rough 23.58 typed on the
 * customer page from an exact 23.5800.
 *
 * It writes nothing and names no customer. A customer with no saved point is not counted (it is not
 * planned). A short link (maps.app.goo.gl) is counted apart: the address it led to is not kept, and
 * nothing here opens a link.
 *
 *   DATABASE_URL=... tsx prisma/check-saved-readings.ts
 */

import { PrismaClient } from '@prisma/client';
import { parseServiceArea } from '../lib/dispatch/customer-attrs';
import {
  decimalPlaces,
  parseLocationInput,
  samePoint,
  FEW_DECIMALS_ZEROS_WARNING,
  type ServiceArea,
} from '../lib/dispatch/location-input';

/** Why a text the saved point was read from is not exact today. */
export type Reason = 'zeros' | 'fewDecimals' | 'roughDms' | 'other' | 'readDifferently';

const REASON_TEXT: Record<Reason, string> = {
  zeros: 'the zeros at the end (only one counts)',
  fewDecimals: "fewer than 4 decimals as written (Google's pin included)",
  roughDms: 'degrees, minutes and seconds of a pair with fewer than 4 decimals',
  other: 'another reason (map centre, swapped, outside the area, whole degrees or minutes)',
  readDifferently:
    'the text reads as another point today, or cannot be read, but holds the saved point: it was read differently before A5 (for example a directions link read at its start)',
};

/** The customers not judged by their text: the saved point was not read from it, or the text cannot say. */
type Apart = 'noText' | 'otherPoint' | 'storedNumbers' | 'unreadable';

const APART_TEXT: Record<Apart, string> = {
  noText: 'no text kept (set on the map or with typed numbers on the customer page before A5)',
  otherPoint:
    'the text reads as another point (the point was set after it, on the customer page before A5; or, before audit A2, the text in the box was changed after Read)',
  storedNumbers:
    'the text is the saved numbers as RouteIQ writes them and reads as not exact (written when a saved point was confirmed as it was, so a stored 23.5850 reads 23.585; a pair typed exactly so looks the same)',
  unreadable: 'the text cannot be read today and does not hold the saved point (for example "map pin")',
};

export type SavedReadingKind =
  | { kind: 'reading'; exact: true }
  | { kind: 'reading'; exact: false; reason: Reason }
  | { kind: 'shortLink' }
  | { kind: Apart; roughAsStored: boolean };

function reasonOf(warnings: string[]): Reason {
  if (warnings.includes(FEW_DECIMALS_ZEROS_WARNING)) return 'zeros';
  if (warnings.some((w) => w.startsWith('These degrees, minutes and seconds are '))) return 'roughDms';
  if (warnings.some((w) => w.startsWith('Coordinates have fewer than 4 decimals'))) return 'fewDecimals';
  return 'other';
}

const round6 = (v: number) => Math.round(v * 1e6) / 1e6;

/**
 * Does the text hold the saved point as two numbers next to each other (either order, rounded to the
 * 6 decimals the parser keeps), as a link's start, pin or centre, or a pair?
 */
function holdsPoint(text: string, point: { lat: number; lng: number }): boolean {
  let t = text;
  try {
    t = decodeURIComponent(text.replace(/\+/g, ' '));
  } catch {
    /* the text as it is */
  }
  const nums = [...t.matchAll(/(?<![\d.])[-+]?\d{1,3}\.\d+/g)].map((m) => round6(Number(m[0])));
  for (let i = 0; i + 1 < nums.length; i++) {
    const a = nums[i]!;
    const b = nums[i + 1]!;
    if (samePoint({ lat: a, lng: b }, point) || samePoint({ lat: b, lng: a }, point)) return true;
  }
  return false;
}

/** Fewer than 4 decimals in the saved number of either coordinate (the 5.12 query's test, in code). */
const roughAsStored = (p: { lat: number; lng: number }) => decimalPlaces(String(p.lat)) < 4 || decimalPlaces(String(p.lng)) < 4;

/** One confirmed customer's saved point and text, as the owner's count sees it. */
export function classifySavedReading(c: { lat: number; lng: number; locationInput: string | null }, area: ServiceArea): SavedReadingKind {
  const point = { lat: c.lat, lng: c.lng };
  const text = (c.locationInput ?? '').trim();
  if (!text) return { kind: 'noText', roughAsStored: roughAsStored(point) };
  const p = parseLocationInput(text, area);
  if (p.needsResolve) return { kind: 'shortLink' };
  const readsBack = p.ok && p.lat !== undefined && p.lng !== undefined && samePoint({ lat: p.lat, lng: p.lng }, point);
  if (readsBack && !p.needsPin) return { kind: 'reading', exact: true };
  // RouteIQ writes `${lat}, ${lng}` when a saved point is confirmed with no text (a swapped one too,
  // which the parser reads swapped back): not judged by that text.
  if (text === `${c.lat}, ${c.lng}`) return { kind: 'storedNumbers', roughAsStored: roughAsStored(point) };
  if (readsBack) return { kind: 'reading', exact: false, reason: reasonOf(p.warnings) };
  if (holdsPoint(text, point)) return { kind: 'reading', exact: false, reason: 'readDifferently' };
  return { kind: p.ok ? 'otherPoint' : 'unreadable', roughAsStored: roughAsStored(point) };
}

/** The reads the report makes (a PrismaClient, or a test's fake). */
export interface SavedReadingsDb {
  tenant: { findMany(args: object): Promise<Array<{ id: string; slug: string; country: string | null }>> };
  tenantConfig: { findUnique(args: object): Promise<{ serviceAreaJson: unknown } | null> };
  customer: { findMany(args: object): Promise<Array<{ lat: number | null; lng: number | null; locationInput: string | null }>> };
}

/** The report's lines, per company. */
export async function savedReadingsReport(db: SavedReadingsDb): Promise<string[]> {
  const out: string[] = [];
  const tenants = await db.tenant.findMany({ select: { id: true, slug: true, country: true }, orderBy: { slug: 'asc' } });
  for (const t of tenants) {
    const cfg = await db.tenantConfig.findUnique({ where: { tenantId: t.id }, select: { serviceAreaJson: true } });
    const area = parseServiceArea(cfg?.serviceAreaJson, t.country);
    const rows = await db.customer.findMany({
      where: {
        tenantId: t.id,
        locationVerified: true,
        locationSource: { in: ['MANUAL_LATLNG', 'GOOGLE_MAPS_URL'] },
        lat: { not: null },
        lng: { not: null },
      },
      select: { lat: true, lng: true, locationInput: true },
    });
    if (rows.length === 0) continue;
    let readings = 0;
    let shortLinks = 0;
    let rough = 0;
    const byReason: Record<Reason, number> = { zeros: 0, fewDecimals: 0, roughDms: 0, other: 0, readDifferently: 0 };
    const byApart: Record<Apart, number> = { noText: 0, otherPoint: 0, storedNumbers: 0, unreadable: 0 };
    for (const r of rows) {
      if (r.lat === null || r.lng === null) continue;
      const k = classifySavedReading({ lat: r.lat, lng: r.lng, locationInput: r.locationInput }, area);
      if (k.kind === 'reading') {
        readings++;
        if (!k.exact) byReason[k.reason]++;
      } else if (k.kind === 'shortLink') shortLinks++;
      else {
        byApart[k.kind]++;
        if (k.roughAsStored) rough++;
      }
    }
    const notExact = Object.values(byReason).reduce((a, b) => a + b, 0);
    const apart = Object.values(byApart).reduce((a, b) => a + b, 0);
    out.push(`${t.slug}: ${rows.length} confirmed customer(s) with a typed or pasted location (MANUAL_LATLNG, GOOGLE_MAPS_URL)`);
    out.push(`  ${readings} confirmed from a pasted reading (the saved text reads back to the saved point); ${notExact} read as not exact today${notExact ? ':' : ''}`);
    for (const k of Object.keys(byReason) as Reason[]) {
      if (byReason[k]) out.push(`    ${byReason[k]} - ${REASON_TEXT[k]}`);
    }
    if (shortLinks) out.push(`  ${shortLinks} short link(s) not read again (the address a short link led to is not kept)`);
    if (apart) {
      out.push(`  ${apart} not judged by their text (the saved point was not read from it, or the text cannot say); ${rough} with fewer than 4 decimals as stored:`);
      for (const k of Object.keys(byApart) as Apart[]) {
        if (byApart[k]) out.push(`    ${byApart[k]} - ${APART_TEXT[k]}`);
      }
    }
  }
  if (out.length === 0) out.push('No customer has a confirmed typed or pasted location.');
  return out;
}

async function main() {
  const prisma = new PrismaClient();
  try {
    for (const line of await savedReadingsReport(prisma)) console.log(line);
  } finally {
    await prisma.$disconnect();
  }
}

// Run only as a script, not when a test imports savedReadingsReport.
if (/check-saved-readings\.[cm]?[jt]s$/.test(process.argv[1] ?? '')) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
