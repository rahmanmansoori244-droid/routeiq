/**
 * Audit of 27 Sep 2026, F05: a customer import never overwrites a location a dispatcher verified,
 * also one verified while the import runs (between the import's read of the customers and its
 * write). The coordinates are written by their own update, conditional on the row still being
 * unverified (PostgreSQL checks it on the row as it is then), and "kept verified locations"
 * counts what those updates did, not the stale read. The real race on PostgreSQL is in
 * tests/integration/master-data-db.spec.ts.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

interface Row { id: string; code: string; branchKey: string; active: boolean; lat: number | null; lng: number | null; locationVerified: boolean; avgServiceTimeMin: number; serviceTimeConfirmed: boolean }
const S = vi.hoisted(() => ({
  rows: [] as Row[],
  /** Runs after the import has read the customers, before it writes (a dispatcher verifying a pin). */
  afterRead: null as null | (() => void),
  updates: [] as { where: Record<string, unknown>; data: Record<string, unknown> }[],
  updateManys: [] as { where: Record<string, unknown>; data: Record<string, unknown> }[],
}));
vi.mock('@/lib/auth', () => ({ auth: vi.fn(async () => ({ user: { id: 'u1', tenantId: 'tA', role: 'PLANNER', name: 'P', email: 'p@a.example' } })) }));
vi.mock('@/lib/audit', () => ({ audit: vi.fn(async () => ({})) }));
vi.mock('@/lib/tenant', () => ({
  tenantDb: () => ({
    region: { findMany: async () => [] },
    customer: {
      findMany: async () => {
        const snapshot = S.rows.map((r) => ({ ...r }));
        S.afterRead?.();
        return snapshot;
      },
      create: async () => ({}),
      update: async (args: { where: { id: string }; data: Record<string, unknown> }) => {
        S.updates.push(args);
        const r = S.rows.find((x) => x.id === args.where.id)!;
        Object.assign(r, args.data);
        return r;
      },
      updateMany: async (args: { where: { id: string; locationVerified?: boolean }; data: Record<string, unknown> }) => {
        S.updateManys.push(args);
        const r = S.rows.find((x) => x.id === args.where.id && (args.where.locationVerified === undefined || x.locationVerified === args.where.locationVerified));
        if (!r) return { count: 0 };
        Object.assign(r, args.data);
        return { count: 1 };
      },
    },
  }),
}));

import { POST } from '@/app/api/customers/import/route';

async function importCsv(csv: string) {
  const fd = new FormData();
  fd.set('file', new File([csv], 'customers.csv', { type: 'text/csv' }));
  const res = await POST(new Request('http://localhost/api/customers/import', { method: 'POST', body: fd }));
  return { status: res.status, body: (await res.json()) as { data: any } };
}
const cust = (id: string, over: Partial<Row> = {}): Row => ({
  id, code: id, branchKey: '__MAIN__', active: true, lat: 23.5, lng: 58.3, locationVerified: false, avgServiceTimeMin: 10, serviceTimeConfirmed: false, ...over,
});

beforeEach(() => {
  S.rows = [cust('K1'), cust('K2'), cust('K3', { locationVerified: true, lat: 23.9, lng: 58.9 })];
  S.afterRead = null;
  S.updates = [];
  S.updateManys = [];
});

describe('customer import and verified locations (audit F05)', () => {
  it('a pin verified after the import read the customers is kept, and counted as kept', async () => {
    S.afterRead = () => Object.assign(S.rows[1]!, { lat: 23.8123, lng: 58.7123, locationVerified: true });
    const r = await importCsv('code,name,priority,lat,lng\nK1,K1,3,23.7,58.5\nK2,K2,3,23.7,58.5\nK3,K3,3,23.7,58.5\n');
    expect(r.status).toBe(200);
    expect(S.rows.map((x) => [x.id, x.lat, x.lng, x.locationVerified])).toEqual([
      ['K1', 23.7, 58.5, false],
      ['K2', 23.8123, 58.7123, true],
      ['K3', 23.9, 58.9, true],
    ]);
    expect(r.body.data.keptVerifiedLocations).toBe(2);
    expect(r.body.data.warnings).toContain('2 customer location(s) confirmed by a dispatcher were kept (file coordinates ignored).');
  });

  it('coordinates are only written by an update conditional on "not verified"; the other fields by their own update', async () => {
    await importCsv('code,name,priority,lat,lng\nK1,New name,2,23.7,58.5\n');
    expect(S.updates[0]!.data).not.toHaveProperty('lat');
    expect(S.updates[0]!.data).toMatchObject({ name: 'New name', priority: 2 });
    expect(S.updateManys).toEqual([{ where: { id: 'K1', locationVerified: false }, data: { lat: 23.7, lng: 58.5, geocodeConfidence: 'HIGH', locationSource: 'IMPORT' } }]);
  });

  it('a file without coordinates writes no location and counts nothing as kept', async () => {
    const r = await importCsv('code,name,priority\nK3,K3,3\n');
    expect(S.updateManys).toEqual([]);
    expect(r.body.data.keptVerifiedLocations).toBe(0);
  });
});
