/**
 * Seed the NMWC daily-dispatch demo tenant ("nmwc") from prisma/nmwc-dispatch-data.ts:
 *   tenant + dispatch settings, 3 logins, depot MCT-GHALA, 7 regions, 12 drivers, 12 trucks,
 *   9 products, 8 customer-type profiles, 180 customer branches (8 without coordinates).
 *
 * Idempotent: everything is an upsert by code, so a second run changes nothing. Locations a
 * dispatcher set in the app (locationSource other than IMPORT) are kept; everything else is
 * reset to the seed values. Orders are NEVER inserted: the dispatcher uploads the file in the UI.
 *
 *   pnpm db:seed:dispatch
 *   pnpm db:seed:dispatch -- --orders=2026-09-25   # also write <repo>/.dev/orders-2026-09-25.xlsx
 *   pnpm db:seed:dispatch -- --customers=480       # benchmark master (needed by orders-large.csv)
 *
 * Passwords: SEED_PASSWORD (env) sets / resets the three demo logins. Without it, logins that do
 * not exist yet get a random 16-character password that is printed ONCE; existing logins keep
 * their password. No password is ever stored in the repo.
 */
import { randomInt } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import bcrypt from 'bcryptjs';
import { PrismaClient, type Prisma } from '@prisma/client';
import {
  NMWC_BASE_BRANCHES,
  NMWC_DISPATCH_CONFIG,
  NMWC_REGIONS,
  NMWC_TENANT,
  NMWC_USERS,
  ORDER_FILE_PRESETS,
  buildCustomers,
  buildDepot,
  buildDrivers,
  buildProducts,
  buildTrucks,
  buildTypeProfiles,
  generateOrderRows,
  rowsToXlsxBuffer,
  summarizeOrderRows,
} from './nmwc-dispatch-data';

// Fixed so re-runs are byte-for-byte idempotent (not "now").
const VERIFIED_AT = new Date('2026-09-01T06:00:00.000Z');

export interface SeedMasterOptions {
  /** Customer branches to seed: 180 (default) or more for the benchmark master. */
  customers?: number;
  /** User recorded as having verified the handful of verified locations. */
  verifiedById?: string | null;
  /** Also upsert TenantConfig dispatch settings (default true). */
  config?: boolean;
}

export interface SeedMasterResult {
  depotId: string;
  regions: number;
  drivers: number;
  trucks: number;
  products: number;
  profiles: number;
  customers: number;
  customersWithoutLocation: number;
  locationsPreserved: number;
}

/**
 * Upsert the NMWC master data into any tenant. Exported so integration tests / benchmarks can
 * load it into a throwaway tenant.
 */
export async function seedNmwcMasterData(prisma: PrismaClient, tenantId: string, opts: SeedMasterOptions = {}): Promise<SeedMasterResult> {
  if (opts.config !== false) {
    const cfg = { ...NMWC_DISPATCH_CONFIG };
    await prisma.tenantConfig.upsert({ where: { tenantId }, update: cfg, create: { tenantId, ...cfg } });
  }

  const d = buildDepot();
  const depotData = { name: d.name, lat: d.lat, lng: d.lng, address: d.address, openMin: d.openMin, closeMin: d.closeMin, active: true };
  const depot = await prisma.depot.upsert({
    where: { tenantId_code: { tenantId, code: d.code } },
    update: depotData,
    create: { tenantId, code: d.code, ...depotData },
  });

  const regionIds = new Map<string, string>();
  for (const r of NMWC_REGIONS) {
    const row = await prisma.region.upsert({
      where: { tenantId_code: { tenantId, code: r.code } },
      update: { name: r.name, depotId: depot.id },
      create: { tenantId, code: r.code, name: r.name, depotId: depot.id },
    });
    regionIds.set(r.code, row.id);
  }

  const driverIds = new Map<string, string>();
  const drivers = buildDrivers();
  for (const dr of drivers) {
    const row = await prisma.driver.upsert({
      where: { tenantId_code: { tenantId, code: dr.code } },
      update: { name: dr.name, active: true },
      create: { tenantId, code: dr.code, name: dr.name },
    });
    driverIds.set(dr.code, row.id);
  }

  const trucks = buildTrucks();
  for (const t of trucks) {
    const data = {
      depotId: depot.id,
      description: t.description,
      capacityCases: t.capacityCases,
      capacityWeightKg: t.capacityWeightKg,
      fixedCostPerDay: t.fixedCostPerDay,
      costPerKm: t.costPerKm,
      kmPerLitre: t.kmPerLitre,
      tripCost: t.tripCost,
      maxTripsPerDay: null, // tenant maxTripsPerTruck applies
      defaultDriverId: driverIds.get(t.defaultDriverCode) ?? null,
      active: true,
    };
    await prisma.truck.upsert({
      where: { tenantId_code: { tenantId, code: t.code } },
      update: data,
      create: { tenantId, code: t.code, ...data },
    });
  }

  const products = buildProducts();
  for (const p of products) {
    const data = {
      name: p.name,
      weightPerCaseKg: p.weightPerCaseKg,
      volumePerCaseL: p.volumePerCaseL,
      unitsPerCase: p.unitsPerCase,
      casesPerPallet: p.casesPerPallet,
      createdFromUpload: false,
      active: true,
    };
    await prisma.product.upsert({
      where: { tenantId_code: { tenantId, code: p.code } },
      update: data,
      create: { tenantId, code: p.code, ...data },
    });
  }

  const profiles = buildTypeProfiles();
  for (const p of profiles) {
    const { customerType, ...data } = p;
    await prisma.customerTypeProfile.upsert({
      where: { tenantId_customerType: { tenantId, customerType } },
      update: data,
      create: { tenantId, customerType, ...data },
    });
  }

  // Customers: keep locations the dispatcher entered in the app; the seed only owns IMPORT ones.
  const customers = buildCustomers(Math.max(1, opts.customers ?? NMWC_BASE_BRANCHES));
  const existing = await prisma.customer.findMany({
    where: { tenantId, code: { in: [...new Set(customers.map((c) => c.code))] } },
    select: { code: true, branchKey: true, locationSource: true },
  });
  const manualLocation = new Set(existing.filter((e) => e.locationSource && e.locationSource !== 'IMPORT').map((e) => `${e.code}::${e.branchKey}`));
  let preserved = 0;
  const ops: Prisma.PrismaPromise<unknown>[] = [];
  for (const c of customers) {
    const attrs = {
      name: c.name,
      branchCode: c.branchCode,
      regionId: regionIds.get(c.regionCode) ?? null,
      address: c.address,
      customerType: c.customerType,
      priority: c.priority,
      priorityConfirmed: c.priorityConfirmed,
      avgServiceTimeMin: c.avgServiceTimeMin,
      serviceTimeConfirmed: c.serviceTimeConfirmed,
      hardWindowStartMin: c.hardWindowStartMin,
      hardWindowEndMin: c.hardWindowEndMin,
      prefWindowStartMin: c.prefWindowStartMin,
      prefWindowEndMin: c.prefWindowEndMin,
      paymentType: c.paymentType,
      accessNotes: c.accessNotes,
      active: true,
      createdFromUpload: false,
    };
    const location = {
      lat: c.lat,
      lng: c.lng,
      geocodeConfidence: c.geocodeConfidence,
      locationInput: null,
      locationSource: c.locationSource,
      locationVerified: c.locationVerified,
      locationVerifiedById: c.locationVerified ? opts.verifiedById ?? null : null,
      locationVerifiedAt: c.locationVerified ? VERIFIED_AT : null,
    };
    const keep = manualLocation.has(`${c.code}::${c.branchKey}`);
    if (keep) preserved++;
    ops.push(
      prisma.customer.upsert({
        where: { tenantId_code_branchKey: { tenantId, code: c.code, branchKey: c.branchKey } },
        update: keep ? attrs : { ...attrs, ...location },
        create: { tenantId, code: c.code, branchKey: c.branchKey, ...attrs, ...location },
      }),
    );
  }
  for (let i = 0; i < ops.length; i += 60) await prisma.$transaction(ops.slice(i, i + 60));

  return {
    depotId: depot.id,
    regions: NMWC_REGIONS.length,
    drivers: drivers.length,
    trucks: trucks.length,
    products: products.length,
    profiles: profiles.length,
    customers: customers.length,
    customersWithoutLocation: customers.filter((c) => c.lat === null).length,
    locationsPreserved: preserved,
  };
}

/** 16 chars, letters + digits without look-alikes (0/O, 1/l/I), at least one of each class. */
function generatePassword(): string {
  const lower = 'abcdefghijkmnopqrstuvwxyz';
  const upper = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  const digits = '23456789';
  const all = lower + upper + digits;
  for (;;) {
    let pw = '';
    for (let i = 0; i < 16; i++) pw += all[randomInt(all.length)];
    if (/[a-z]/.test(pw) && /[A-Z]/.test(pw) && /[0-9]/.test(pw)) return pw;
  }
}

interface UserSeedResult {
  ids: Map<string, string>;
  created: string[];
  reset: string[];
  kept: string[];
  skipped: string[];
  generatedPassword: string | null;
}

async function seedUsers(prisma: PrismaClient, tenantId: string): Promise<UserSeedResult> {
  const envPw = process.env.SEED_PASSWORD?.trim() || null;
  if (envPw && envPw.length < 8) throw new Error('SEED_PASSWORD must be at least 8 characters (the login form rejects shorter ones).');
  const existing = await prisma.user.findMany({ where: { email: { in: NMWC_USERS.map((u) => u.email) } } });
  const byEmail = new Map(existing.map((u) => [u.email, u]));
  const needsNew = NMWC_USERS.some((u) => !byEmail.has(u.email));
  const generatedPassword = !envPw && needsNew ? generatePassword() : null;
  const pw = envPw ?? generatedPassword;
  const hash = pw ? await bcrypt.hash(pw, 12) : null;

  const res: UserSeedResult = { ids: new Map(), created: [], reset: [], kept: [], skipped: [], generatedPassword };
  for (const u of NMWC_USERS) {
    const cur = byEmail.get(u.email);
    if (cur && cur.tenantId !== tenantId) {
      // Emails are global; never move a login that belongs to another tenant.
      res.skipped.push(u.email);
      continue;
    }
    if (!cur) {
      const row = await prisma.user.create({ data: { tenantId, email: u.email, name: u.name, role: u.role, passwordHash: hash!, active: true } });
      res.ids.set(u.email, row.id);
      res.created.push(u.email);
    } else {
      await prisma.user.update({
        where: { id: cur.id },
        data: { name: u.name, role: u.role, active: true, ...(envPw ? { passwordHash: hash! } : {}) },
      });
      res.ids.set(u.email, cur.id);
      (envPw ? res.reset : res.kept).push(u.email);
    }
  }
  return res;
}

interface Cli {
  ordersDate: string | null;
  customers: number;
}

function parseArgs(argv: string[]): Cli {
  const cli: Cli = { ordersDate: null, customers: NMWC_BASE_BRANCHES };
  for (const a of argv) {
    let m = /^--orders=(.+)$/.exec(a);
    if (m) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(m[1]) || Number.isNaN(Date.parse(`${m[1]}T00:00:00Z`))) throw new Error(`--orders expects YYYY-MM-DD (got "${m[1]}")`);
      cli.ordersDate = m[1];
      continue;
    }
    m = /^--customers=(\d+)$/.exec(a);
    if (m) {
      cli.customers = Math.max(NMWC_BASE_BRANCHES, Number(m[1]));
      continue;
    }
    if (a === '--') continue;
    throw new Error(`Unknown option "${a}". Use --orders=YYYY-MM-DD and/or --customers=<n>.`);
  }
  return cli;
}

function writeOrderFile(date: string): string {
  const rows = generateOrderRows({ date, ...ORDER_FILE_PRESETS.demo });
  const dir = path.resolve(__dirname, '..', '..', '..', '.dev');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `orders-${date}.xlsx`);
  fs.writeFileSync(file, rowsToXlsxBuffer(rows));
  const s = summarizeOrderRows(rows);
  console.log(`  Order file: ${file}`);
  console.log(`    ${s.rows} rows, ${s.stops} stops (incl. ${ORDER_FILE_PRESETS.demo.includeUnknownCustomers} unknown customers), ${s.salesOrders} sales orders, ${s.cases} cases; 1 unknown item code`);
  console.log('    Not inserted: upload it on the Dispatch screen. After 18:00 the day before delivery it counts as LATE.');
  return file;
}

async function main() {
  const cli = parseArgs(process.argv.slice(2));
  const prisma = new PrismaClient();
  try {
    console.log(`Seeding NMWC dispatch demo into tenant "${NMWC_TENANT.slug}"...`);
    const tenant = await prisma.tenant.upsert({
      where: { slug: NMWC_TENANT.slug },
      update: { name: NMWC_TENANT.name, country: NMWC_TENANT.country, currency: NMWC_TENANT.currency, active: true },
      create: { slug: NMWC_TENANT.slug, name: NMWC_TENANT.name, country: NMWC_TENANT.country, currency: NMWC_TENANT.currency, primaryUnit: 'CASES' },
    });
    const tenantId = tenant.id;

    const users = await seedUsers(prisma, tenantId);
    const master = await seedNmwcMasterData(prisma, tenantId, {
      customers: cli.customers,
      verifiedById: users.ids.get('supervisor@nmwc.local') ?? null,
    });

    const [trucks, products, customers, noCoords, drivers, profiles, userCount] = await Promise.all([
      prisma.truck.count({ where: { tenantId } }),
      prisma.product.count({ where: { tenantId } }),
      prisma.customer.count({ where: { tenantId } }),
      prisma.customer.count({ where: { tenantId, OR: [{ lat: null }, { lng: null }] } }),
      prisma.driver.count({ where: { tenantId } }),
      prisma.customerTypeProfile.count({ where: { tenantId } }),
      prisma.user.count({ where: { tenantId } }),
    ]);

    console.log(`  Tenant: ${tenant.name} (${tenant.slug})`);
    console.log(`  Depot: MCT-GHALA, ${master.regions} regions, ${master.drivers} drivers, ${master.trucks} trucks, ${master.products} products, ${master.profiles} type profiles`);
    console.log(`  Customers: ${master.customers} branches seeded (${master.customersWithoutLocation} without coordinates -> LOCATION REQUIRED)`);
    if (master.locationsPreserved) console.log(`  Kept ${master.locationsPreserved} location(s) entered by a dispatcher.`);
    console.log(`  Tenant totals: ${trucks} trucks, ${products} products, ${customers} customers (${noCoords} without coordinates), ${drivers} drivers, ${profiles} profiles, ${userCount} users`);
    if (trucks > master.trucks || products > master.products || customers > master.customers) {
      console.log('  Note: the tenant also holds records this seed does not manage (e.g. from seed-nmwc.ts or uploads).');
    }

    console.log('  Logins: ' + NMWC_USERS.map((u) => `${u.email} (${u.role})`).join(', '));
    if (users.created.length) console.log(`    created: ${users.created.join(', ')}`);
    if (users.reset.length) console.log(`    password reset from SEED_PASSWORD: ${users.reset.join(', ')}`);
    if (users.kept.length) console.log(`    unchanged (existing password kept; set SEED_PASSWORD to reset): ${users.kept.join(', ')}`);
    if (users.skipped.length) console.log(`    SKIPPED, email belongs to another tenant: ${users.skipped.join(', ')}`);
    if (users.generatedPassword) {
      console.log(`    Generated password for the new logins (shown once, stored nowhere): ${users.generatedPassword}`);
    } else if (users.created.length) {
      console.log('    New logins use SEED_PASSWORD.');
    }

    if (cli.ordersDate) writeOrderFile(cli.ordersDate);
    console.log('Done.');
  } finally {
    await prisma.$disconnect();
  }
}

// Run only as a script (tsx prisma/seed-nmwc-dispatch.ts), not when a test imports the helper.
if (/seed-nmwc-dispatch\.[cm]?[jt]s$/.test(process.argv[1] ?? '')) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
