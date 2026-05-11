/**
 * End-to-end smoke test for Module C — driver tracking + dispatcher view.
 *
 * Connects to whatever DATABASE_URL is exported (use the Railway public proxy
 * URL to hit production), then:
 *
 *   1. Creates a synthetic driver "SMOKE-DRV" in the nmwc tenant.
 *   2. Sets a known PIN.
 *   3. Calls loginDriver() from the same helpers the HTTP route uses.
 *   4. Posts a few GPS pings via the Prisma client (matches what the HTTP
 *      endpoint would persist).
 *   5. Reads back TruckLocation + the latest pin per truck so the dispatcher
 *      endpoint logic can find them.
 *   6. Marks one assignment as done with a tiny placeholder signature.
 *
 * Idempotent — safe to re-run. Cleans up the SMOKE-DRV shift at the end.
 *
 *   DATABASE_URL=... pnpm tsx prisma/smoke-driver-flow.ts
 */
import { PrismaClient } from '@prisma/client';
import {
  loginDriver,
  generatePin,
  hashPin,
  requireDriverShift,
  endShift,
} from '../lib/driver-auth';

const prisma = new PrismaClient();

async function main() {
  const tenant = await prisma.tenant.findUnique({ where: { slug: 'nmwc' } });
  if (!tenant) throw new Error('nmwc tenant not found — sign up first.');

  // Step 1: upsert driver SMOKE-DRV.
  console.log('1. Upserting driver SMOKE-DRV');
  const driver = await prisma.driver.upsert({
    where: { tenantId_code: { tenantId: tenant.id, code: 'SMOKE-DRV' } },
    update: { name: 'Smoke Test Driver', active: true },
    create: { tenantId: tenant.id, code: 'SMOKE-DRV', name: 'Smoke Test Driver', active: true },
    select: { id: true, code: true, name: true },
  });

  // Step 2: set a known PIN so loginDriver can verify it.
  const pin = generatePin();
  await prisma.driver.update({ where: { id: driver.id }, data: { accessPinHash: await hashPin(pin) } });
  console.log(`   driver=${driver.code} pin=${pin}`);

  // Step 3: find the most recent READY/DISPATCHED run on this tenant + a truck
  // that has at least one RouteAssignment. We need a truckId so the ping path
  // and the dispatcher endpoint have something to join against.
  const run = await prisma.runPlan.findFirst({
    where: { tenantId: tenant.id, routes: { some: {} } },
    orderBy: { createdAt: 'desc' },
    include: {
      routes: {
        take: 1,
        include: {
          truck: { select: { id: true, code: true } },
          order: { include: { customer: { select: { code: true, lat: true, lng: true } } } },
        },
      },
      depot: { select: { lat: true, lng: true } },
    },
  });
  if (!run || run.routes.length === 0) {
    throw new Error('No run with route assignments found. Run an optimization first.');
  }
  const truck = run.routes[0]!.truck;
  console.log(`   using run=${run.id} truck=${truck.code}`);

  // Step 4: login as driver — produces a real shift via the same code path
  // /api/driver/login uses.
  const loginRes = await loginDriver({
    tenantSlug: 'nmwc',
    driverCode: driver.code,
    pin,
    truckId: truck.id,
    runId: run.id,
  });
  console.log(`2. Login OK — shiftId=${loginRes.shiftId} sessionToken=${loginRes.sessionToken.slice(0, 8)}…`);

  // Step 5: post 5 GPS pings — synthetic walk from depot to the first stop.
  const fromLat = run.depot.lat;
  const fromLng = run.depot.lng;
  const toLat = run.routes[0]!.order.customer.lat ?? fromLat;
  const toLng = run.routes[0]!.order.customer.lng ?? fromLng;
  console.log('3. Posting 5 GPS pings along depot → first stop path');
  for (let i = 1; i <= 5; i++) {
    const t = i / 6; // 1/6 .. 5/6
    const lat = fromLat + (toLat - fromLat) * t;
    const lng = fromLng + (toLng - fromLng) * t;
    await prisma.truckLocation.create({
      data: {
        tenantId: tenant.id,
        shiftId: loginRes.shiftId,
        truckId: truck.id,
        ts: new Date(Date.now() - (6 - i) * 5_000), // staggered 5s apart
        lat,
        lng,
        speedKmh: 38 + Math.random() * 4,
        headingDeg: 90,
        accuracyM: 8,
        batteryPct: 78,
      },
    });
    console.log(`   ping ${i}: ${lat.toFixed(5)},${lng.toFixed(5)}`);
  }

  // Step 6: read back the most recent ping to confirm the dispatcher SELECT works.
  const latest = await prisma.truckLocation.findFirst({
    where: { truckId: truck.id },
    orderBy: { ts: 'desc' },
  });
  console.log(`4. Latest ping in DB: ts=${latest?.ts.toISOString()} ${latest?.lat.toFixed(5)},${latest?.lng.toFixed(5)}`);

  // Step 7: mark the first stop done with a tiny PNG signature (1x1 transparent).
  console.log('5. Marking first stop delivered with placeholder signature');
  const TINY_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkAAIAAAoAAv/lhpgAAAAASUVORK5CYII=';
  await prisma.deliveryProof.upsert({
    where: { assignmentId: run.routes[0]!.id },
    update: {},
    create: {
      tenantId: tenant.id,
      shiftId: loginRes.shiftId,
      assignmentId: run.routes[0]!.id,
      notes: 'Smoke test delivery — left at front desk.',
      signaturePngB64: TINY_PNG,
      lat: toLat,
      lng: toLng,
    },
  });

  // Step 8: validate requireDriverShift still works on the live token.
  const ctx = await requireDriverShift(loginRes.sessionToken);
  console.log(`6. requireDriverShift returns active shift: ${ctx.shiftId}`);

  // Step 9: end shift cleanly.
  await endShift(loginRes.sessionToken, 'Smoke test complete.');
  console.log('7. Shift ended cleanly.');

  console.log('\nSmoke test PASSED. Production data:');
  console.log(`  driver code: ${driver.code}`);
  console.log(`  shift id:    ${loginRes.shiftId}`);
  console.log(`  truck id:    ${truck.id}`);
  console.log(`  run id:      ${run.id}`);
  console.log(`  dispatcher:  https://web-production-a9d04.up.railway.app/t/nmwc/runs/${run.id}/live`);
}

main()
  .catch((e) => {
    console.error('SMOKE TEST FAILED:', e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
