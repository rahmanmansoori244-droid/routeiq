/**
 * Seed realistic NMWC sample data:
 *   1 Muscat depot
 *   8 trucks (mixed capacity)
 *   5 regions (Muttrah, Ruwi, Seeb, Bawshar, Amerat)
 *   20 products
 *   150 customers with real-ish Muscat-area coordinates
 *
 * Idempotent: re-running upserts by code. Pass --tenant=<slug> to target a
 * specific tenant. Defaults to "nmwc".
 *
 *   pnpm db:seed:nmwc
 *   pnpm db:seed:nmwc --tenant=mytenant
 */

import bcrypt from 'bcryptjs';
import { CapacityUnit, PaymentType, PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

interface Cli { tenantSlug: string }
function parseArgs(): Cli {
  let slug = 'nmwc';
  for (const a of process.argv.slice(2)) {
    const m = /^--tenant=(.+)$/.exec(a);
    if (m) slug = m[1];
  }
  return { tenantSlug: slug };
}

async function main() {
  const { tenantSlug } = parseArgs();
  console.log(`Seeding NMWC sample data into tenant "${tenantSlug}"…`);

  // Find or create the tenant. If creating, also create a default admin
  // (admin@<slug>.test / Nmwc-Test-Password-12345).
  let tenant = await prisma.tenant.findUnique({ where: { slug: tenantSlug } });
  if (!tenant) {
    const pw = await bcrypt.hash('Nmwc-Test-Password-12345', 12);
    tenant = await prisma.tenant.create({
      data: {
        slug: tenantSlug,
        name: 'National Mineral Water Company',
        country: 'Oman',
        currency: 'OMR',
        primaryUnit: CapacityUnit.CASES,
        config: { create: {} },
        users: {
          create: {
            email: `admin@${tenantSlug}.test`,
            name: 'NMWC Admin',
            role: 'TENANT_ADMIN',
            passwordHash: pw,
          },
        },
      },
    });
    console.log(`  Created tenant + admin admin@${tenantSlug}.test`);
  } else {
    console.log(`  Reusing existing tenant ${tenant.slug}`);
  }
  const tenantId = tenant.id;

  // 1 Muscat depot (Rusayl industrial area)
  const depot = await prisma.depot.upsert({
    where: { tenantId_code: { tenantId, code: 'MCT-RUS' } },
    update: { name: 'Muscat — Rusayl', lat: 23.5859, lng: 58.4059, address: 'Rusayl Industrial Estate' },
    create: {
      tenantId,
      code: 'MCT-RUS',
      name: 'Muscat — Rusayl',
      lat: 23.5859,
      lng: 58.4059,
      address: 'Rusayl Industrial Estate, Muscat, Oman',
    },
  });
  console.log(`  Depot: ${depot.code}`);

  // 5 regions
  const regionSpecs = [
    { code: 'MUT', name: 'Muttrah' },
    { code: 'RUW', name: 'Ruwi' },
    { code: 'SEE', name: 'Seeb' },
    { code: 'BAW', name: 'Bawshar' },
    { code: 'AME', name: 'Amerat' },
  ];
  const regions = await Promise.all(
    regionSpecs.map((r) =>
      prisma.region.upsert({
        where: { tenantId_code: { tenantId, code: r.code } },
        update: { name: r.name, depotId: depot.id },
        create: { tenantId, code: r.code, name: r.name, depotId: depot.id },
      }),
    ),
  );
  console.log(`  Regions: ${regions.map((r) => r.code).join(', ')}`);

  // 8 trucks of mixed capacity
  const truckSpecs = [
    { code: 'T-101', description: '5-ton box', cap: 150, kg: 2500, vol: 6000, fixed: 18, perKm: 0.14 },
    { code: 'T-102', description: '5-ton box', cap: 150, kg: 2500, vol: 6000, fixed: 18, perKm: 0.14 },
    { code: 'T-103', description: '7-ton box', cap: 220, kg: 3500, vol: 9000, fixed: 22, perKm: 0.18 },
    { code: 'T-104', description: '7-ton box', cap: 220, kg: 3500, vol: 9000, fixed: 22, perKm: 0.18 },
    { code: 'T-105', description: '10-ton box', cap: 320, kg: 5000, vol: 12000, fixed: 28, perKm: 0.22 },
    { code: 'T-106', description: '10-ton box', cap: 320, kg: 5000, vol: 12000, fixed: 28, perKm: 0.22 },
    { code: 'T-107', description: '3-ton pickup', cap: 80, kg: 1500, vol: 3500, fixed: 12, perKm: 0.10 },
    { code: 'T-108', description: '3-ton pickup', cap: 80, kg: 1500, vol: 3500, fixed: 12, perKm: 0.10 },
  ];
  for (const t of truckSpecs) {
    await prisma.truck.upsert({
      where: { tenantId_code: { tenantId, code: t.code } },
      update: {
        description: t.description,
        depotId: depot.id,
        capacityCases: t.cap,
        capacityWeightKg: t.kg,
        capacityVolumeL: t.vol,
        fixedCostPerDay: t.fixed,
        costPerKm: t.perKm,
      },
      create: {
        tenantId,
        depotId: depot.id,
        code: t.code,
        description: t.description,
        capacityCases: t.cap,
        capacityWeightKg: t.kg,
        capacityVolumeL: t.vol,
        fixedCostPerDay: t.fixed,
        costPerKm: t.perKm,
      },
    });
  }
  console.log(`  Trucks: ${truckSpecs.length}`);

  // 20 products (FMCG / water / beverage SKUs)
  const productSpecs = [
    { code: 'NMW-500', name: '500ml water (24-pack)', kg: 12.5, l: 12.5 },
    { code: 'NMW-1L', name: '1L water (12-pack)', kg: 12.2, l: 12 },
    { code: 'NMW-1.5L', name: '1.5L water (12-pack)', kg: 18.5, l: 18.2 },
    { code: 'NMW-5L', name: '5L water (4-pack)', kg: 20.5, l: 20.2 },
    { code: 'NMW-19L', name: '19L water cooler bottle (single)', kg: 19.2, l: 19 },
    { code: 'NMW-S330', name: 'Sparkling 330ml (24-pack)', kg: 8.6, l: 8.3 },
    { code: 'NMW-S500', name: 'Sparkling 500ml (24-pack)', kg: 12.8, l: 12.5 },
    { code: 'NMW-FL-O', name: 'Flavored orange 500ml (24-pack)', kg: 12.7, l: 12.5 },
    { code: 'NMW-FL-L', name: 'Flavored lemon 500ml (24-pack)', kg: 12.7, l: 12.5 },
    { code: 'NMW-FL-M', name: 'Flavored mint 500ml (24-pack)', kg: 12.7, l: 12.5 },
    { code: 'NMW-PRM', name: 'Premium glass 750ml (12-pack)', kg: 14.6, l: 9.5 },
    { code: 'NMW-KID', name: 'Kids 330ml (24-pack)', kg: 8.5, l: 8.3 },
    { code: 'NMW-EX', name: 'Export PET 1.5L (12-pack)', kg: 18.7, l: 18.3 },
    { code: 'NMW-IND', name: 'Industrial 20L jerrycan', kg: 20.4, l: 20 },
    { code: 'NMW-COM', name: 'Commercial 10L jerrycan (2-pack)', kg: 20.8, l: 20.2 },
    { code: 'NMW-ION', name: 'Ionized 500ml (24-pack)', kg: 12.6, l: 12.4 },
    { code: 'NMW-ZRO', name: 'Zero-sodium 500ml (24-pack)', kg: 12.6, l: 12.4 },
    { code: 'NMW-VIT', name: 'Vitamin water 500ml (12-pack)', kg: 6.4, l: 6.2 },
    { code: 'NMW-ENR', name: 'Energy 250ml (24-pack)', kg: 6.5, l: 6.2 },
    { code: 'NMW-CAS', name: 'Mixed case (assorted)', kg: 15, l: 14 },
  ];
  for (const p of productSpecs) {
    await prisma.product.upsert({
      where: { tenantId_code: { tenantId, code: p.code } },
      update: { name: p.name, weightPerCaseKg: p.kg, volumePerCaseL: p.l },
      create: { tenantId, code: p.code, name: p.name, weightPerCaseKg: p.kg, volumePerCaseL: p.l },
    });
  }
  console.log(`  Products: ${productSpecs.length}`);

  // 150 customers seeded around Muscat with reproducible randomness.
  // Each region is anchored on a real-ish point; customers are jittered ±0.05° (~5km).
  const regionAnchors: Record<string, { lat: number; lng: number; name: string }> = {
    MUT: { lat: 23.6196, lng: 58.5916, name: 'Muttrah' },
    RUW: { lat: 23.5921, lng: 58.5419, name: 'Ruwi' },
    SEE: { lat: 23.6700, lng: 58.1893, name: 'Seeb' },
    BAW: { lat: 23.5760, lng: 58.4040, name: 'Bawshar' },
    AME: { lat: 23.5200, lng: 58.4910, name: 'Amerat' },
  };

  const segments = ['Cafe', 'Restaurant', 'Grocery', 'Mini-Mart', 'Hypermarket', 'Hotel', 'Office', 'School'];
  const paymentMix: PaymentType[] = ['CREDIT', 'CREDIT', 'CREDIT', 'CASH', 'PREPAID'];

  // Tiny mulberry32 PRNG for reproducibility.
  function rng(seed: number) {
    return () => {
      let t = (seed += 0x6d2b79f5);
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  const rand = rng(0xC0FFEE);

  const ops = [];
  let i = 0;
  for (const reg of regionSpecs) {
    const anchor = regionAnchors[reg.code];
    const target = 30; // 30 per region * 5 = 150
    for (let k = 0; k < target; k++) {
      i++;
      const code = `NMWC-${reg.code}-${String(k + 1).padStart(3, '0')}`;
      const seg = segments[Math.floor(rand() * segments.length)];
      const lat = anchor.lat + (rand() - 0.5) * 0.1;
      const lng = anchor.lng + (rand() - 0.5) * 0.1;
      const priority = 1 + Math.floor(rand() * 5);
      const service = 5 + Math.floor(rand() * 16); // 5-20 min
      const payment = paymentMix[Math.floor(rand() * paymentMix.length)];
      const region = regions.find((r) => r.code === reg.code)!;
      // Leave 5% with missing coords to exercise the geocode flow.
      const missingCoords = rand() < 0.05;
      ops.push(
        prisma.customer.upsert({
          where: { tenantId_code_branchKey: { tenantId, code, branchKey: '__MAIN__' } },
          update: {},
          create: {
            tenantId,
            code,
            name: `${seg} ${reg.name} #${k + 1}`,
            branchCode: null,
            branchKey: '__MAIN__',
            regionId: region.id,
            address: `${anchor.name}, Muscat`,
            lat: missingCoords ? null : lat,
            lng: missingCoords ? null : lng,
            geocodeConfidence: missingCoords ? 'MISSING' : 'HIGH',
            priority,
            avgServiceTimeMin: service,
            paymentType: payment,
          },
        }),
      );
    }
  }
  await prisma.$transaction(ops);
  console.log(`  Customers: ${i}`);

  console.log('Seed complete.');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
