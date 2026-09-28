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
 * It writes nothing and names no customer. A short link (maps.app.goo.gl) is counted apart: the address
 * it led to is not kept, and nothing here opens a link. A text RouteIQ wrote itself from the saved
 * number (a save sent without text) is read by the number's digits: a real "23.5850" saved that way
 * reads 23.585, not exact.
 *
 *   DATABASE_URL=... tsx prisma/check-saved-readings.ts
 */

import { PrismaClient } from '@prisma/client';
import { parseServiceArea } from '../lib/dispatch/customer-attrs';
import { parseLocationInput, FEW_DECIMALS_ZEROS_WARNING } from '../lib/dispatch/location-input';

const prisma = new PrismaClient();

type Reason = 'zeros' | 'fewDecimals' | 'roughDms' | 'other';

const REASON_TEXT: Record<Reason, string> = {
  zeros: 'the zeros at the end (only one counts)',
  fewDecimals: "fewer than 4 decimals as written (Google's pin included)",
  roughDms: 'degrees, minutes and seconds of a pair with fewer than 4 decimals',
  other: 'another reason (map centre, swapped, outside the area, whole degrees or minutes, not readable)',
};

function reasonOf(warnings: string[]): Reason {
  if (warnings.includes(FEW_DECIMALS_ZEROS_WARNING)) return 'zeros';
  if (warnings.some((w) => w.startsWith('These degrees, minutes and seconds are '))) return 'roughDms';
  if (warnings.some((w) => w.startsWith('Coordinates have fewer than 4 decimals'))) return 'fewDecimals';
  return 'other';
}

async function main() {
  const tenants = await prisma.tenant.findMany({ select: { id: true, slug: true, country: true }, orderBy: { slug: 'asc' } });
  let any = false;
  for (const t of tenants) {
    const cfg = await prisma.tenantConfig.findUnique({ where: { tenantId: t.id }, select: { serviceAreaJson: true } });
    const area = parseServiceArea(cfg?.serviceAreaJson, t.country);
    const rows = await prisma.customer.findMany({
      where: { tenantId: t.id, locationVerified: true, locationSource: { in: ['MANUAL_LATLNG', 'GOOGLE_MAPS_URL'] } },
      select: { locationInput: true },
    });
    if (rows.length === 0) continue;
    any = true;
    let notExact = 0;
    let shortLinks = 0;
    const byReason: Record<Reason, number> = { zeros: 0, fewDecimals: 0, roughDms: 0, other: 0 };
    for (const r of rows) {
      const p = parseLocationInput(r.locationInput ?? '', area);
      if (p.needsResolve) {
        shortLinks++;
        continue;
      }
      if (p.ok && !p.needsPin) continue;
      notExact++;
      byReason[p.ok ? reasonOf(p.warnings) : 'other']++;
    }
    console.log(`${t.slug}: ${rows.length} confirmed from a pasted reading; ${notExact} read as not exact today; ${shortLinks} short link(s) not read again`);
    for (const k of Object.keys(byReason) as Reason[]) {
      if (byReason[k]) console.log(`  ${byReason[k]} - ${REASON_TEXT[k]}`);
    }
  }
  if (!any) console.log('No customer was confirmed from a pasted reading.');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
