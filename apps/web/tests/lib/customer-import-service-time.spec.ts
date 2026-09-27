/**
 * Audit A2 review (27 Sep 2026): the handbook said a customer's unloading time could be put back on
 * the customer-type or Settings default "by an import". It cannot, and this pins what the docs now
 * say about POST /api/customers/import:
 *
 *  - a blank avg_service_time_min cell, or no such column, keeps the stored time and whether it is
 *    confirmed (a re-import never erases what a dispatcher entered);
 *  - a number always sets the time and confirms it (10, the column default, included);
 *  - text such as "default" or "-" is refused for the row, nothing is written.
 *
 * Only PATCH /api/customers/:id with avgServiceTimeMin null (the day screen's Details dialog with the
 * box emptied) puts a customer back on the default (dispatch-customer-details.spec.ts). The wrong
 * wording itself is refused by repo-guards.spec.ts. Adapted from the reviewer's experiment
 * (.dev/scratch-a2-v1/skeptic2-import-clear).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  stored: [] as Record<string, unknown>[],
  updates: [] as Record<string, unknown>[],
  creates: [] as Record<string, unknown>[],
}));
vi.mock('@/lib/auth', () => ({ auth: vi.fn(async () => ({ user: { id: 'u1', tenantId: 'tA', role: 'PLANNER' } })) }));
vi.mock('@/lib/audit', () => ({ audit: vi.fn(async () => undefined) }));
vi.mock('@/lib/rate-limit', () => ({ rateLimit: () => ({ ok: true }), LIMITS: { ordersUpload: { limit: 1000, windowMs: 1000 } } }));
vi.mock('@/lib/tenant', () => ({
  tenantDb: () => ({
    region: { findMany: async () => [] },
    customer: {
      findMany: async () => state.stored,
      update: async ({ data }: { data: Record<string, unknown> }) => {
        state.updates.push(data);
        return {};
      },
      create: async ({ data }: { data: Record<string, unknown> }) => {
        state.creates.push(data);
        return {};
      },
    },
  }),
}));

import { POST } from '@/app/api/customers/import/route';

async function importCsv(csv: string) {
  const fd = new FormData();
  fd.set('file', new File([csv], 'customers.csv', { type: 'text/csv' }));
  const res = await POST(new Request('http://localhost/api/customers/import', { method: 'POST', body: fd }));
  return { status: res.status, body: (await res.json()) as any };
}

beforeEach(() => {
  // A customer with its own confirmed 45 min.
  state.stored = [{ id: 'c1', code: 'C100', branchKey: '__MAIN__', active: true, lat: 23.6, lng: 58.4, locationVerified: true, avgServiceTimeMin: 45, serviceTimeConfirmed: true }];
  state.updates = [];
  state.creates = [];
});

describe('a customer import cannot put an unloading time back on the default', () => {
  it('a blank cell keeps the stored time and its confirmation', async () => {
    const r = await importCsv('code,name,priority,avg_service_time_min\nC100,Hyper,1,\n');
    expect(r.status).toBe(200);
    expect(state.updates).toHaveLength(1);
    expect(state.updates[0]).not.toHaveProperty('avgServiceTimeMin');
    expect(state.updates[0]).not.toHaveProperty('serviceTimeConfirmed');
  });

  it('a file without the column keeps them too', async () => {
    const r = await importCsv('code,name,priority\nC100,Hyper,1\n');
    expect(r.status).toBe(200);
    expect(state.updates[0]).not.toHaveProperty('avgServiceTimeMin');
    expect(state.updates[0]).not.toHaveProperty('serviceTimeConfirmed');
  });

  it("a number is the customer's own time, confirmed (10 min, the column default, as well)", async () => {
    await importCsv('code,name,priority,avg_service_time_min\nC100,Hyper,1,10\n');
    expect(state.updates[0]).toMatchObject({ avgServiceTimeMin: 10, serviceTimeConfirmed: true });
  });

  it('text such as "default", "-" or "null" is refused, nothing is written', async () => {
    for (const v of ['default', '-', 'null']) {
      const r = await importCsv(`code,name,priority,avg_service_time_min\nC100,Hyper,1,${v}\n`);
      expect(r.body.data.errorRows).toBe(1);
      expect(r.body.data.errors[0].message).toMatch(/whole number 0-480/);
    }
    expect(state.updates).toEqual([]);
  });

  it('never writes serviceTimeConfirmed false: a new customer without a time gets no confirmation either way', async () => {
    await importCsv('code,name,priority,avg_service_time_min\nC100,Hyper,1,\nN1,New shop,3,\n');
    expect(state.creates).toHaveLength(1);
    expect(state.creates[0]).not.toHaveProperty('avgServiceTimeMin');
    expect(state.creates[0]).not.toHaveProperty('serviceTimeConfirmed');
    expect([...state.updates, ...state.creates].some((d) => d.serviceTimeConfirmed === false)).toBe(false);
  });
});
