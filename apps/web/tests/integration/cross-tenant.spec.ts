/**
 * Cross-tenant isolation matrix — CLAUDE.md §13 mandatory.
 *
 * For every tenant-scoped API endpoint that returns or mutates data:
 *   1. Log in as Tenant A.
 *   2. Attempt the operation against a resource ID belonging to Tenant B.
 *   3. Assert HTTP 404 (NOT 403 — 403 would leak existence).
 *   4. Assert no row in Tenant B was modified.
 *
 * The endpoints are tested via real HTTP against the running dev server. Two
 * fresh tenants per test session keep the matrix self-contained.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  BASE,
  cleanupTenant,
  fetchWith,
  freshTenant,
  prisma,
  seedMinimal,
  tomorrowIso,
  type SeededIds,
  type TenantHandle,
} from './helpers';

let tenantA: TenantHandle;
let tenantB: TenantHandle;
let seedA: SeededIds;
let seedB: SeededIds;
const createdSlugs = new Set<string>();

beforeAll(async () => {
  tenantA = await freshTenant('xt-a');
  tenantB = await freshTenant('xt-b');
  createdSlugs.add(tenantA.slug);
  createdSlugs.add(tenantB.slug);
  seedA = await seedMinimal(tenantA.tenantId);
  seedB = await seedMinimal(tenantB.tenantId);

  // Park a confirmed upload batch + a run in each tenant so we have resource
  // IDs of every type to probe.
  const tomorrow = new Date(tomorrowIso());

  for (const t of [
    { handle: tenantA, seeded: seedA },
    { handle: tenantB, seeded: seedB },
  ]) {
    await prisma.uploadBatch.create({
      data: {
        tenantId: t.handle.tenantId,
        fileName: 'xt-test.csv',
        fileType: 'csv',
        uploadedById: t.handle.userId,
        status: 'CONFIRMED',
        totalRows: 1,
        validRows: 1,
      },
    });
    const order = await prisma.order.create({
      data: {
        tenantId: t.handle.tenantId,
        customerId: t.seeded.customerIds[0],
        deliveryDate: tomorrow,
        totalCases: 5,
        totalWeightKg: 60,
        totalVolumeL: 60,
        totalServiceTimeMin: 10,
        priority: 3,
        status: 'VALIDATED',
      },
    });
    await prisma.orderLine.create({
      data: { orderId: order.id, productId: t.seeded.productId, cases: 5 },
    });
    await prisma.runPlan.create({
      data: {
        tenantId: t.handle.tenantId,
        depotId: t.seeded.depotId,
        runDate: tomorrow,
        status: 'DRAFT',
        totalOrders: 1,
        createdById: t.handle.userId,
      },
    });
  }
}, 60_000);

afterAll(async () => {
  for (const slug of createdSlugs) await cleanupTenant(slug);
  await prisma.$disconnect();
});

interface ProbeCase {
  label: string;
  /** Endpoint URL — uses tenant B's resource ID; we hit it with tenant A's session. */
  build: () => Promise<string>;
  method: 'GET' | 'PATCH' | 'DELETE' | 'POST';
  body?: () => Record<string, unknown>;
}

const PROBES: ProbeCase[] = [
  {
    label: 'GET /api/depots/{id-B}',
    method: 'GET',
    build: async () => {
      const d = await prisma.depot.findFirstOrThrow({ where: { tenantId: tenantB.tenantId } });
      return `${BASE}/api/depots/${d.id}`;
    },
  },
  {
    label: 'PATCH /api/depots/{id-B}',
    method: 'PATCH',
    body: () => ({ name: 'XT injection' }),
    build: async () => {
      const d = await prisma.depot.findFirstOrThrow({ where: { tenantId: tenantB.tenantId } });
      return `${BASE}/api/depots/${d.id}`;
    },
  },
  {
    label: 'DELETE /api/depots/{id-B}',
    method: 'DELETE',
    build: async () => {
      const d = await prisma.depot.findFirstOrThrow({ where: { tenantId: tenantB.tenantId } });
      return `${BASE}/api/depots/${d.id}`;
    },
  },
  {
    label: 'GET /api/trucks/{id-B}',
    method: 'GET',
    build: async () => {
      const t = await prisma.truck.findFirstOrThrow({ where: { tenantId: tenantB.tenantId } });
      return `${BASE}/api/trucks/${t.id}`;
    },
  },
  {
    label: 'PATCH /api/trucks/{id-B}',
    method: 'PATCH',
    body: () => ({ description: 'XT' }),
    build: async () => {
      const t = await prisma.truck.findFirstOrThrow({ where: { tenantId: tenantB.tenantId } });
      return `${BASE}/api/trucks/${t.id}`;
    },
  },
  {
    label: 'GET /api/customers/{id-B}',
    method: 'GET',
    build: async () => {
      const c = await prisma.customer.findFirstOrThrow({ where: { tenantId: tenantB.tenantId } });
      return `${BASE}/api/customers/${c.id}`;
    },
  },
  {
    label: 'PATCH /api/customers/{id-B}',
    method: 'PATCH',
    body: () => ({ priority: 1 }),
    build: async () => {
      const c = await prisma.customer.findFirstOrThrow({ where: { tenantId: tenantB.tenantId } });
      return `${BASE}/api/customers/${c.id}`;
    },
  },
  {
    label: 'PATCH /api/products/{id-B}',
    method: 'PATCH',
    body: () => ({ name: 'XT' }),
    build: async () => {
      const p = await prisma.product.findFirstOrThrow({ where: { tenantId: tenantB.tenantId } });
      return `${BASE}/api/products/${p.id}`;
    },
  },
  {
    label: 'PATCH /api/regions/{id-B}',
    method: 'PATCH',
    body: () => ({ name: 'XT' }),
    build: async () => {
      const r = await prisma.region.findFirstOrThrow({ where: { tenantId: tenantB.tenantId } });
      return `${BASE}/api/regions/${r.id}`;
    },
  },
  {
    label: 'GET /api/orders/{batchId-B}',
    method: 'GET',
    build: async () => {
      const b = await prisma.uploadBatch.findFirstOrThrow({ where: { tenantId: tenantB.tenantId } });
      return `${BASE}/api/orders/${b.id}`;
    },
  },
  {
    label: 'DELETE /api/orders/{batchId-B}',
    method: 'DELETE',
    build: async () => {
      const b = await prisma.uploadBatch.findFirstOrThrow({ where: { tenantId: tenantB.tenantId } });
      return `${BASE}/api/orders/${b.id}`;
    },
  },
  {
    label: 'GET /api/runs/{id-B}',
    method: 'GET',
    build: async () => {
      const r = await prisma.runPlan.findFirstOrThrow({ where: { tenantId: tenantB.tenantId } });
      return `${BASE}/api/runs/${r.id}`;
    },
  },
  {
    label: 'POST /api/runs/{id-B}/optimize',
    method: 'POST',
    build: async () => {
      const r = await prisma.runPlan.findFirstOrThrow({ where: { tenantId: tenantB.tenantId } });
      return `${BASE}/api/runs/${r.id}/optimize`;
    },
  },
  {
    label: 'GET /api/runs/{id-B}/status',
    method: 'GET',
    build: async () => {
      const r = await prisma.runPlan.findFirstOrThrow({ where: { tenantId: tenantB.tenantId } });
      return `${BASE}/api/runs/${r.id}/status`;
    },
  },
  {
    label: 'GET /api/runs/{id-B}/baseline',
    method: 'GET',
    build: async () => {
      const r = await prisma.runPlan.findFirstOrThrow({ where: { tenantId: tenantB.tenantId } });
      return `${BASE}/api/runs/${r.id}/baseline`;
    },
  },
];

describe('cross-tenant per-endpoint matrix', () => {
  it.each(PROBES)('blocks $label as 404 (not 403)', async (probe) => {
    const url = await probe.build();
    const init: RequestInit = { method: probe.method };
    if (probe.body) {
      init.headers = { 'content-type': 'application/json' };
      init.body = JSON.stringify(probe.body());
    }
    const res = await fetchWith(tenantA.cookieJar, url, init);
    expect(res.status, `${probe.label} should 404 cross-tenant but got ${res.status}`).toBe(404);
  });

  it('cross-tenant URL access via /t/{otherSlug} returns 404 in the page layer', async () => {
    const res = await fetchWith(tenantA.cookieJar, `${BASE}/t/${tenantB.slug}`, { method: 'GET' });
    expect(res.status).toBe(404);
  });

  it('also verifies the reverse direction (B cannot reach A resources)', async () => {
    const d = await prisma.depot.findFirstOrThrow({ where: { tenantId: tenantA.tenantId } });
    const res = await fetchWith(tenantB.cookieJar, `${BASE}/api/depots/${d.id}`, { method: 'GET' });
    expect(res.status).toBe(404);
  });

  it('confirms no rows were modified in tenant B during the matrix', async () => {
    // Spot-check: tenant B's depot name shouldn't have been changed to "XT injection".
    const depot = await prisma.depot.findFirstOrThrow({ where: { tenantId: tenantB.tenantId } });
    expect(depot.name).not.toBe('XT injection');
    const product = await prisma.product.findFirstOrThrow({ where: { tenantId: tenantB.tenantId } });
    expect(product.name).not.toBe('XT');
    const region = await prisma.region.findFirstOrThrow({ where: { tenantId: tenantB.tenantId } });
    expect(region.name).not.toBe('XT');
  });
});
