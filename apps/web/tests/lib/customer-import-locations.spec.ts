/**
 * Audit of 27 Sep 2026, F05: a customer import never overwrites a location a dispatcher verified,
 * also one verified while the import runs (between the import's read of the customers and its
 * write). The coordinates are written by their own update, conditional on the row still being
 * unverified (PostgreSQL checks it on the row as it is then), and "kept verified locations"
 * counts what those updates did, not the stale read. The real race on PostgreSQL is in
 * tests/integration/master-data-db.spec.ts.
 *
 * Audit PR A5 (owner's location rule, L3): a pair that is not exact (fewer than 4 decimals, swapped,
 * outside the delivery area, 0,0) is never stored as a usable location. A new customer gets none, an
 * existing one keeps what it has, and the row is listed in `locationsNotSaved` with the reason; the
 * rest of the row and of the file is imported.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

interface Row { id: string; code: string; branchKey: string; active: boolean; lat: number | null; lng: number | null; locationVerified: boolean; avgServiceTimeMin: number; serviceTimeConfirmed: boolean }
const S = vi.hoisted(() => ({
  rows: [] as Row[],
  /** Runs after the import has read the customers, before it writes (a dispatcher verifying a pin). */
  afterRead: null as null | (() => void),
  updates: [] as { where: Record<string, unknown>; data: Record<string, unknown> }[],
  updateManys: [] as { where: Record<string, unknown>; data: Record<string, unknown> }[],
  creates: [] as Record<string, unknown>[],
}));
vi.mock('@/lib/auth', () => ({ auth: vi.fn(async () => ({ user: { id: 'u1', tenantId: 'tA', role: 'PLANNER', name: 'P', email: 'p@a.example' } })) }));
vi.mock('@/lib/audit', () => ({ audit: vi.fn(async () => ({})) }));
// The company's delivery area: Oman + UAE (the NMWC default).
vi.mock('@/lib/dispatch/service-area', async () => {
  const { DEFAULT_SERVICE_AREA } = await import('@/lib/dispatch/location-input');
  return { tenantServiceArea: async () => DEFAULT_SERVICE_AREA };
});
vi.mock('@/lib/tenant', () => ({
  tenantDb: () => ({
    region: { findMany: async () => [] },
    customer: {
      findMany: async () => {
        const snapshot = S.rows.map((r) => ({ ...r }));
        S.afterRead?.();
        return snapshot;
      },
      create: async (args: { data: Record<string, unknown> }) => {
        S.creates.push(args.data);
        return {};
      },
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
  S.creates = [];
});

describe('customer import and verified locations (audit F05)', () => {
  it('a pin verified after the import read the customers is kept, and counted as kept', async () => {
    S.afterRead = () => Object.assign(S.rows[1]!, { lat: 23.8123, lng: 58.7123, locationVerified: true });
    const r = await importCsv('code,name,priority,lat,lng\nK1,K1,3,23.7001,58.5001\nK2,K2,3,23.7001,58.5001\nK3,K3,3,23.7001,58.5001\n');
    expect(r.status).toBe(200);
    expect(S.rows.map((x) => [x.id, x.lat, x.lng, x.locationVerified])).toEqual([
      ['K1', 23.7001, 58.5001, false],
      ['K2', 23.8123, 58.7123, true],
      ['K3', 23.9, 58.9, true],
    ]);
    expect(r.body.data.keptVerifiedLocations).toBe(2);
    expect(r.body.data.warnings).toContain('2 customer location(s) confirmed by a dispatcher were kept (file coordinates ignored).');
  });

  it('coordinates are only written by an update conditional on "not verified"; the other fields by their own update', async () => {
    await importCsv('code,name,priority,lat,lng\nK1,New name,2,23.7001,58.5001\n');
    expect(S.updates[0]!.data).not.toHaveProperty('lat');
    expect(S.updates[0]!.data).toMatchObject({ name: 'New name', priority: 2 });
    expect(S.updateManys).toEqual([{ where: { id: 'K1', locationVerified: false }, data: { lat: 23.7001, lng: 58.5001, geocodeConfidence: 'HIGH', locationSource: 'IMPORT' } }]);
  });

  it('a file without coordinates writes no location and counts nothing as kept', async () => {
    const r = await importCsv('code,name,priority\nK3,K3,3\n');
    expect(S.updateManys).toEqual([]);
    expect(r.body.data.keptVerifiedLocations).toBe(0);
  });
});

describe("owner's location rule (audit PR A5): a location that is not exact is never saved", () => {
  const NOT_EXACT = [
    ['fewer than 4 decimals', '23.58,58.40', /fewer than 4 decimals/],
    ['swapped', '58.4059,23.5859', /swapped/],
    ['outside the delivery area', '19.0760,72.8777', /outside the delivery area/],
    ['0,0', '0,0', /0,0 is not a real delivery location/],
  ] as const;

  it.each(NOT_EXACT)('a new customer (%s): created without coordinates (LOCATION REQUIRED), listed with the reason, the row imported', async (_what, pair, reason) => {
    const r = await importCsv(`code,name,priority,lat,lng\nN1,New one,2,${pair}\nN2,Exact one,3,23.5859,58.4059\n`);
    expect(r.status).toBe(200);
    expect(r.body.data.errorRows).toBe(0);
    expect(r.body.data.upserted).toBe(2);
    const n1 = S.creates.find((c) => c.code === 'N1')!;
    expect(n1).toMatchObject({ name: 'New one', priority: 2, lat: null, lng: null, geocodeConfidence: 'MISSING' });
    expect(n1.locationSource).toBeUndefined();
    // The exact pair is stored as read: HIGH, from the import, not verified.
    expect(S.creates.find((c) => c.code === 'N2')).toMatchObject({ lat: 23.5859, lng: 58.4059, geocodeConfidence: 'HIGH', locationSource: 'IMPORT' });
    expect(r.body.data.locationsNotSaved).toEqual([{ row: 2, code: 'N1', branchCode: null, reason: expect.stringMatching(reason), kept: null }]);
    expect(r.body.data.warnings.join(' ')).toMatch(/1 location\(s\) in the file are not exact and were not saved\. Set them on the map/);
  });

  it('an existing customer keeps the location it has; its other fields are updated', async () => {
    const r = await importCsv('code,name,priority,lat,lng\nK1,Renamed,1,23.7,58.5\n');
    expect(r.status).toBe(200);
    expect(S.updateManys).toEqual([]);
    expect(S.updates[0]!.data).toMatchObject({ name: 'Renamed', priority: 1 });
    expect(S.rows[0]).toMatchObject({ lat: 23.5, lng: 58.3, locationVerified: false });
    expect(r.body.data.locationsNotSaved).toEqual([{ row: 2, code: 'K1', branchCode: null, reason: expect.stringMatching(/fewer than 4 decimals/), kept: 'SAVED_LOCATION' }]);
  });

  it('the check (Validate only) lists them too, and saves nothing', async () => {
    const fd = new FormData();
    fd.set('file', new File(['code,name,priority,lat,lng\nN1,New,3,23.58,58.40\n'], 'customers.csv', { type: 'text/csv' }));
    fd.set('dryRun', '1');
    const res = await POST(new Request('http://localhost/api/customers/import', { method: 'POST', body: fd }));
    const body = (await res.json()) as { data: any };
    expect(body.data).toMatchObject({ dryRun: true, errorRows: 0, locationsNotSaved: [{ row: 2, code: 'N1', kept: null }] });
    expect(S.creates).toEqual([]);
  });

  it('control: exact pairs with 4 to 6 decimals are stored as read (like the NMWC master data)', async () => {
    const r = await importCsv('code,name,priority,lat,lng\nA1,A,3,23.5859,58.4059\nA2,B,3,23.58591,58.40591\nA3,C,3,23.585912,58.405912\n');
    expect(r.body.data.locationsNotSaved).toEqual([]);
    expect(S.creates.map((c) => [c.lat, c.lng, c.geocodeConfidence])).toEqual([
      [23.5859, 58.4059, 'HIGH'],
      [23.58591, 58.40591, 'HIGH'],
      [23.585912, 58.405912, 'HIGH'],
    ]);
  });
});
