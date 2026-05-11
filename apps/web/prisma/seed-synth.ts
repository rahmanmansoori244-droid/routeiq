/**
 * Load the synthetic NMWC dataset (5-day Muscat simulation) into a tenant.
 *
 * Reads CSVs from --data=<path> (defaults to ./prisma/synth-data) and seeds:
 *   - 1 depot (MCT-DEPOT)
 *   - 15 regions
 *   - 5 products
 *   - 8 trucks
 *   - 150 customers
 *   - 5 days of orders (each upload wrapped in a CONFIRMED UploadBatch)
 *
 * Idempotent: re-running upserts by code/branchKey/date. Use --tenant=<slug>
 * to target a tenant other than "nmwc". Use --reset-orders to wipe existing
 * synth orders for the same dates first.
 *
 *   pnpm db:seed:synth
 *   pnpm db:seed:synth -- --tenant=demo --reset-orders
 *
 * DB target is whichever DATABASE_URL is exported. Point at the public Railway
 * proxy URL (Postgres → Variables → DATABASE_PUBLIC_URL) to seed production.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import Papa from 'papaparse';
import { PaymentType, PrismaClient, UploadBatchStatus } from '@prisma/client';

const prisma = new PrismaClient();

interface Cli {
  tenantSlug: string;
  dataDir: string;
  resetOrders: boolean;
}

function parseArgs(): Cli {
  let slug = 'nmwc';
  let dir = path.join(__dirname, 'synth-data');
  let resetOrders = false;
  for (const a of process.argv.slice(2)) {
    const t = /^--tenant=(.+)$/.exec(a);
    if (t) slug = t[1];
    const d = /^--data=(.+)$/.exec(a);
    if (d) dir = d[1];
    if (a === '--reset-orders') resetOrders = true;
  }
  return { tenantSlug: slug, dataDir: dir, resetOrders };
}

function readCsv<T = Record<string, string>>(file: string): T[] {
  const text = fs.readFileSync(file, 'utf8');
  const parsed = Papa.parse<T>(text, { header: true, skipEmptyLines: true });
  if (parsed.errors.length) {
    throw new Error(`CSV parse errors in ${file}: ${JSON.stringify(parsed.errors.slice(0, 3))}`);
  }
  return parsed.data;
}

function normalizeBranchKey(branchCode: string | null | undefined): { branchCode: string | null; branchKey: string } {
  const v = (branchCode ?? '').trim();
  if (!v) return { branchCode: null, branchKey: '__MAIN__' };
  return { branchCode: v, branchKey: v };
}

function toPaymentType(v: string | undefined): PaymentType {
  const u = (v ?? '').trim().toLowerCase();
  if (u === 'cash') return 'CASH';
  if (u === 'prepaid') return 'PREPAID';
  return 'CREDIT';
}

async function findOrFailUser(tenantId: string): Promise<string> {
  // Use any tenant user as the uploadedBy. Prefer SUPER_ADMIN or TENANT_ADMIN.
  const u = await prisma.user.findFirst({
    where: { tenantId, role: { in: ['SUPER_ADMIN', 'TENANT_ADMIN'] } },
  });
  if (!u) throw new Error(`No SUPER_ADMIN/TENANT_ADMIN user found for tenant ${tenantId}`);
  return u.id;
}

async function main() {
  const cli = parseArgs();
  console.log(`Seed-synth: tenant=${cli.tenantSlug} data=${cli.dataDir}`);

  const tenant = await prisma.tenant.findUnique({ where: { slug: cli.tenantSlug } });
  if (!tenant) throw new Error(`Tenant "${cli.tenantSlug}" not found. Sign up first at /signup.`);
  const tenantId = tenant.id;
  const uploaderId = await findOrFailUser(tenantId);
  console.log(`  Tenant ${tenant.name} (${tenantId}); uploader=${uploaderId}`);

  // ---------- Depot ----------
  const depot = await prisma.depot.upsert({
    where: { tenantId_code: { tenantId, code: 'MCT-DEPOT' } },
    update: { lat: 23.5859, lng: 58.4059, active: true, name: 'NMWC Muscat Main Depot' },
    create: {
      tenantId,
      code: 'MCT-DEPOT',
      name: 'NMWC Muscat Main Depot',
      lat: 23.5859,
      lng: 58.4059,
      address: 'Ruwi Industrial Area, Muscat, Oman',
      active: true,
    },
  });
  console.log(`  Depot ${depot.code} upserted (${depot.id})`);

  // ---------- Regions ----------
  const regionRows = readCsv<{ code: string; name: string; depot_code: string }>(
    path.join(cli.dataDir, 'master', 'regions.csv'),
  );
  for (const r of regionRows) {
    await prisma.region.upsert({
      where: { tenantId_code: { tenantId, code: r.code } },
      update: { name: r.name, depotId: depot.id },
      create: { tenantId, code: r.code, name: r.name, depotId: depot.id },
    });
  }
  const regions = await prisma.region.findMany({ where: { tenantId } });
  const regionByCode = new Map(regions.map((r) => [r.code, r]));
  console.log(`  Regions: ${regionRows.length} upserted`);

  // ---------- Products ----------
  const productRows = readCsv<{ code: string; name: string; weight_per_case_kg: string; volume_per_case_l: string }>(
    path.join(cli.dataDir, 'master', 'products.csv'),
  );
  for (const p of productRows) {
    await prisma.product.upsert({
      where: { tenantId_code: { tenantId, code: p.code } },
      update: {
        name: p.name,
        weightPerCaseKg: Number(p.weight_per_case_kg),
        volumePerCaseL: Number(p.volume_per_case_l),
        active: true,
      },
      create: {
        tenantId,
        code: p.code,
        name: p.name,
        weightPerCaseKg: Number(p.weight_per_case_kg),
        volumePerCaseL: Number(p.volume_per_case_l),
        active: true,
      },
    });
  }
  const products = await prisma.product.findMany({ where: { tenantId } });
  const productByCode = new Map(products.map((p) => [p.code, p]));
  console.log(`  Products: ${productRows.length} upserted`);

  // ---------- Trucks ----------
  const truckRows = readCsv<{
    code: string; description: string; capacity_cases: string; capacity_weight_kg: string;
    fixed_cost_per_day: string; cost_per_km: string; depot_code: string;
  }>(path.join(cli.dataDir, 'master', 'trucks.csv'));
  for (const t of truckRows) {
    await prisma.truck.upsert({
      where: { tenantId_code: { tenantId, code: t.code } },
      update: {
        description: t.description,
        capacityCases: Number(t.capacity_cases),
        capacityWeightKg: Number(t.capacity_weight_kg),
        fixedCostPerDay: Number(t.fixed_cost_per_day),
        costPerKm: Number(t.cost_per_km),
        depotId: depot.id,
        active: true,
      },
      create: {
        tenantId,
        code: t.code,
        description: t.description,
        capacityCases: Number(t.capacity_cases),
        capacityWeightKg: Number(t.capacity_weight_kg),
        capacityVolumeL: 0,
        fixedCostPerDay: Number(t.fixed_cost_per_day),
        costPerKm: Number(t.cost_per_km),
        depotId: depot.id,
        active: true,
      },
    });
  }
  console.log(`  Trucks: ${truckRows.length} upserted`);

  // ---------- Drivers ----------
  // One driver per truck so the driver PWA has someone to log in as. PINs are
  // NOT seeded — operators rotate them from the Drivers admin UI before the
  // driver actually signs in.
  const driverNames = [
    'Ahmed Al-Hinai',
    'Khalid Al-Balushi',
    'Salim Al-Lawati',
    'Faisal Al-Maamari',
    'Yousef Al-Saadi',
    'Hamad Al-Mahrouqi',
    'Mohammed Al-Kindi',
    'Omar Al-Battashi',
  ];
  for (let i = 0; i < truckRows.length; i++) {
    const code = `DR-${(i + 1).toString().padStart(3, '0')}`;
    const name = driverNames[i] ?? `Driver ${i + 1}`;
    await prisma.driver.upsert({
      where: { tenantId_code: { tenantId, code } },
      update: { name, active: true },
      create: { tenantId, code, name, active: true },
    });
  }
  console.log(`  Drivers: ${truckRows.length} upserted (PINs not set — rotate them from /t/${cli.tenantSlug}/drivers).`);

  // ---------- Customers ----------
  interface CustomerRow {
    code: string; name: string; branch_code: string; region_code: string; address: string;
    lat: string; lng: string; priority: string; avg_service_time_min: string; payment_type: string;
  }
  const customerRows = readCsv<CustomerRow>(path.join(cli.dataDir, 'master', 'customers.csv'));
  for (const c of customerRows) {
    const region = regionByCode.get(c.region_code);
    if (!region) {
      console.warn(`  ! Customer ${c.code} references unknown region ${c.region_code}; skipping`);
      continue;
    }
    const { branchCode, branchKey } = normalizeBranchKey(c.branch_code);
    const lat = c.lat ? Number(c.lat) : null;
    const lng = c.lng ? Number(c.lng) : null;
    await prisma.customer.upsert({
      where: { tenantId_code_branchKey: { tenantId, code: c.code, branchKey } },
      update: {
        name: c.name,
        regionId: region.id,
        address: c.address,
        lat,
        lng,
        geocodeConfidence: lat == null || lng == null ? 'MISSING' : 'HIGH',
        priority: Number(c.priority),
        avgServiceTimeMin: Number(c.avg_service_time_min),
        paymentType: toPaymentType(c.payment_type),
        active: true,
      },
      create: {
        tenantId,
        code: c.code,
        branchCode,
        branchKey,
        name: c.name,
        regionId: region.id,
        address: c.address,
        lat,
        lng,
        geocodeConfidence: lat == null || lng == null ? 'MISSING' : 'HIGH',
        priority: Number(c.priority),
        avgServiceTimeMin: Number(c.avg_service_time_min),
        paymentType: toPaymentType(c.payment_type),
        active: true,
      },
    });
  }
  const customers = await prisma.customer.findMany({ where: { tenantId } });
  const customerByCodeBranch = new Map(customers.map((c) => [`${c.code}|${c.branchKey}`, c]));
  console.log(`  Customers: ${customerRows.length} upserted`);

  // ---------- Orders (per day) ----------
  interface OrderRow {
    customer_code: string; branch_code: string; delivery_date: string; product_code: string;
    cases: string; priority: string; notes: string; payment_collection_amount: string;
  }
  const ordersDir = path.join(cli.dataDir, 'orders');
  const orderFiles = fs.readdirSync(ordersDir).filter((f) => f.endsWith('.csv')).sort();

  for (const file of orderFiles) {
    const fullPath = path.join(ordersDir, file);
    const rows = readCsv<OrderRow>(fullPath);
    if (rows.length === 0) continue;
    const deliveryDateStr = rows[0]!.delivery_date;
    const deliveryDate = new Date(`${deliveryDateStr}T00:00:00.000Z`);

    if (cli.resetOrders) {
      const deleted = await prisma.order.deleteMany({
        where: { tenantId, deliveryDate, uploadBatch: { fileName: file } },
      });
      if (deleted.count) console.log(`    reset: removed ${deleted.count} prior orders for ${file}`);
    }

    // Skip if a batch for this filename + delivery date already exists with confirmed orders
    const existingBatch = await prisma.uploadBatch.findFirst({
      where: { tenantId, fileName: file, deliveryDate, status: 'CONFIRMED' },
    });
    if (existingBatch) {
      console.log(`    skip ${file} (already imported as batch ${existingBatch.id})`);
      continue;
    }

    // Group rows by (customer_code|branchKey) → many product lines per order
    const grouped = new Map<string, { customerKey: string; rows: OrderRow[] }>();
    for (const r of rows) {
      const { branchKey } = normalizeBranchKey(r.branch_code);
      const key = `${r.customer_code}|${branchKey}`;
      if (!grouped.has(key)) grouped.set(key, { customerKey: key, rows: [] });
      grouped.get(key)!.rows.push(r);
    }

    const batch = await prisma.uploadBatch.create({
      data: {
        tenantId,
        fileName: file,
        fileType: 'text/csv',
        uploadedById: uploaderId,
        uploadedAt: new Date(),
        deliveryDate,
        status: UploadBatchStatus.CONFIRMED,
        totalRows: rows.length,
        validRows: rows.length,
        errorRows: 0,
        warningRows: 0,
      },
    });

    let inserted = 0;
    let skipped = 0;
    for (const { customerKey, rows: customerRowsForOrder } of grouped.values()) {
      const customer = customerByCodeBranch.get(customerKey);
      if (!customer) {
        skipped++;
        continue;
      }
      // Aggregate totals
      let totalCases = 0;
      let totalWeightKg = 0;
      let totalVolumeL = 0;
      const lines: { productId: string; cases: number }[] = [];
      for (const r of customerRowsForOrder) {
        const product = productByCode.get(r.product_code);
        if (!product) continue;
        const cases = Math.max(0, Number(r.cases) || 0);
        if (cases === 0) continue;
        totalCases += cases;
        totalWeightKg += cases * product.weightPerCaseKg;
        totalVolumeL += cases * product.volumePerCaseL;
        lines.push({ productId: product.id, cases });
      }
      if (lines.length === 0) {
        skipped++;
        continue;
      }
      const firstRow = customerRowsForOrder[0]!;
      const priority = Number(firstRow.priority) || customer.priority;
      const paymentAmt = Number(firstRow.payment_collection_amount) || 0;
      const notes = firstRow.notes || null;
      await prisma.order.create({
        data: {
          tenantId,
          customerId: customer.id,
          deliveryDate,
          totalCases,
          totalWeightKg,
          totalVolumeL,
          totalServiceTimeMin: customer.avgServiceTimeMin,
          priority,
          paymentCollectionAmount: paymentAmt,
          notes,
          status: 'VALIDATED',
          uploadBatchId: batch.id,
          lines: { create: lines },
        },
      });
      inserted++;
    }
    console.log(`    ${file}: batch ${batch.id} — ${inserted} orders, ${skipped} skipped (unknown customer/product)`);
  }

  console.log('Seed-synth complete.');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
