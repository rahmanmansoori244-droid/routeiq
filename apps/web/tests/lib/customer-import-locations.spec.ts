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
 * existing one keeps what it has when the file's pair points at the same place (within the file's
 * own precision), else its saved point is marked LOW (not used until the pin is placed by hand), and
 * the row is listed in `locationsNotSaved` with the reason in the import's words; the rest of the row
 * and of the file is imported. An Excel number cell counts the decimals it shows (23.5850 in a cell
 * formatted with 4 decimals is 4 decimals, not the 23.585 the number holds).
 *
 * A5 third review: an exact pair that replaces a saved point that was not usable writes a
 * CUSTOMER_LOCATION_SET row (the point it replaced), which LOCK reads (plan-service locationGate).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as XLSX from 'xlsx';
import { locationBlocksDelivery } from '@/lib/dispatch/customer-attrs';
import { MAX_SHOWN_FORMAT, MAX_SHOWN_FORMATS, parseUpload } from '@/lib/csv';

interface Row { id: string; code: string; branchKey: string; active: boolean; lat: number | null; lng: number | null; locationVerified: boolean; avgServiceTimeMin: number; serviceTimeConfirmed: boolean; geocodeConfidence?: string | null; locationSource?: string | null }
const S = vi.hoisted(() => ({
  rows: [] as Row[],
  /** Runs after the import has read the customers, before it writes (a dispatcher verifying a pin). */
  afterRead: null as null | (() => void),
  updates: [] as { where: Record<string, unknown>; data: Record<string, unknown> }[],
  updateManys: [] as { where: Record<string, unknown>; data: Record<string, unknown> }[],
  creates: [] as Record<string, unknown>[],
  /** Raw SQL the import ran (the row lock). */
  raw: [] as string[],
}));
// The company admin: A5's import rules. A dispatcher's import never changes a usable saved location
// (location admin-lock, 1 Oct 2026: tests/lib/data-collection-rules.spec.ts).
vi.mock('@/lib/auth', () => ({ auth: vi.fn(async () => ({ user: { id: 'u1', tenantId: 'tA', role: 'TENANT_ADMIN', name: 'P', email: 'p@a.example' } })) }));
vi.mock('@/lib/audit', () => ({ audit: vi.fn(async () => ({})) }));
// The company's delivery area: Oman + UAE (the NMWC default).
vi.mock('@/lib/dispatch/service-area', async () => {
  const { DEFAULT_SERVICE_AREA } = await import('@/lib/dispatch/location-input');
  return { tenantServiceArea: async () => DEFAULT_SERVICE_AREA };
});
vi.mock('@/lib/tenant', () => ({
  getCurrentTenant: async () => ({ user: { id: 'u1', role: 'PLANNER' } }),
  tenantDb: () => ({
    // An interactive transaction: the rows are put back when the callback throws (rollback).
    async $transaction(cb: (tx: unknown) => Promise<unknown>) {
      const saved = S.rows.map((r) => ({ ...r }));
      try {
        return await cb(this);
      } catch (e) {
        S.rows.splice(0, S.rows.length, ...saved);
        throw e;
      }
    },
    $queryRaw: async (strings: TemplateStringsArray) => {
      S.raw.push(strings.join('?').replace(/\s+/g, ' ').trim());
      return [];
    },
    region: { findMany: async () => [] },
    customer: {
      findMany: async () => {
        const snapshot = S.rows.map((r) => ({ ...r }));
        S.afterRead?.();
        return snapshot;
      },
      findFirst: async (args: { where: { id: string } }) => {
        const r = S.rows.find((x) => x.id === args.where.id);
        return r ? { ...r } : null;
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
      updateMany: async (args: { where: Record<string, unknown> & { id: string }; data: Record<string, unknown> }) => {
        S.updateManys.push(args);
        // Every condition given is checked on the row as it is now (a missing field is null).
        const r = S.rows.find((x) => Object.entries(args.where).every(([k, v]) => v === undefined || ((x as unknown as Record<string, unknown>)[k] ?? null) === v));
        if (!r) return { count: 0 };
        Object.assign(r, args.data);
        return { count: 1 };
      },
    },
  }),
}));

import { POST } from '@/app/api/customers/import/route';
import { audit } from '@/lib/audit';
import CustomerImportPage from '@/app/t/[slug]/customers/import/page';
import { locationNotSavedLine, locationsNotSavedSummary } from '@/app/t/[slug]/customers/import/import-form';
import { elements, typeName } from './hook-host';

async function importFile(file: File, dryRun = false) {
  const fd = new FormData();
  fd.set('file', file);
  if (dryRun) fd.set('dryRun', '1');
  const res = await POST(new Request('http://localhost/api/customers/import', { method: 'POST', body: fd }));
  return { status: res.status, body: (await res.json()) as { data: any } };
}
const importCsv = (csv: string, dryRun = false) => importFile(new File([csv], 'customers.csv', { type: 'text/csv' }), dryRun);
/** An Excel file whose lat / lng are number cells; `formats` gives a cell its number format (e.g. D2: '0.0000'). */
function xlsx(rows: unknown[][], formats: Record<string, string> = {}): File {
  const ws = XLSX.utils.aoa_to_sheet([['code', 'name', 'priority', 'lat', 'lng'], ...rows]);
  for (const [cell, z] of Object.entries(formats)) ws[cell]!.z = z;
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Customers');
  const buf = XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer;
  return new File([buf], 'customers.xlsx', { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
}
/** The reason for a pair shown or written with more decimals than it counts (A5 fifth review). */
const ZEROS = 'Fewer than 4 decimals (only one zero at the end counts).';
const cust = (id: string, over: Partial<Row> = {}): Row => ({
  id, code: id, branchKey: '__MAIN__', active: true, lat: 23.5, lng: 58.3, locationVerified: false, avgServiceTimeMin: 10, serviceTimeConfirmed: false, ...over,
});

beforeEach(() => {
  S.rows = [cust('K1'), cust('K2'), cust('K3', { locationVerified: true, lat: 23.9, lng: 58.9 })];
  S.afterRead = null;
  S.updates = [];
  S.updateManys = [];
  S.creates = [];
  S.raw = [];
  vi.mocked(audit).mockReset();
  vi.mocked(audit).mockImplementation(async () => ({}) as never);
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
    // A5 fifth review: and on the point and confidence the import read, so that "no location-change
    // row needed" is judged on the customer as it is when written (else the locked path below).
    expect(S.updateManys).toEqual([
      { where: { id: 'K1', locationVerified: false, lat: 23.5, lng: 58.3 }, data: { lat: 23.7001, lng: 58.5001, geocodeConfidence: 'HIGH', locationSource: 'IMPORT' } },
    ]);
    expect(S.raw).toEqual([]);
  });

  it('a file without coordinates writes no location and counts nothing as kept', async () => {
    const r = await importCsv('code,name,priority\nK3,K3,3\n');
    expect(S.updateManys).toEqual([]);
    expect(r.body.data.keptVerifiedLocations).toBe(0);
  });
});

describe("owner's location rule (audit PR A5): a location that is not exact is never saved", () => {
  // The reason in the import's own words: what is wrong with the pair, nothing about a pin or a map
  // this screen does not have. Before: the Read dialog's warnings ("...they were swapped back. Please
  // confirm on the map.", "Confirm the pin.") although nothing was swapped back or saved.
  const NOT_EXACT = [
    ['fewer than 4 decimals', '23.58,58.40', 'Fewer than 4 decimals.'],
    ['swapped', '58.4059,23.5859', 'Latitude and longitude look swapped.'],
    ['outside the delivery area', '19.0760,72.8777', 'Outside the delivery area.'],
    ['0,0', '0,0', '0,0 is not a location.'],
    ['swapped, with fewer than 4 decimals', '58.40,23.58', 'Latitude and longitude look swapped. Fewer than 4 decimals.'],
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
    expect(r.body.data.locationsNotSaved).toEqual([{ row: 2, code: 'N1', branchCode: null, reason, kept: null }]);
    expect(r.body.data.warnings.join(' ')).toMatch(/1 location\(s\) in the file are not exact and were not saved\. Set them on the map/);
  });

  it('an existing customer keeps the location it has when the file points at the same place; its other fields are updated', async () => {
    S.rows[0] = cust('K1', { lat: 23.5859, lng: 58.4059, geocodeConfidence: 'HIGH' });
    // 3 decimals: 23.586 stands for 23.5855 to 23.5865, and the saved 23.5859 is in it.
    const r = await importCsv('code,name,priority,lat,lng\nK1,Renamed,1,23.586,58.406\n');
    expect(r.status).toBe(200);
    expect(S.updateManys).toEqual([]);
    expect(S.updates[0]!.data).toMatchObject({ name: 'Renamed', priority: 1 });
    expect(S.rows[0]).toMatchObject({ lat: 23.5859, lng: 58.4059, locationVerified: false, geocodeConfidence: 'HIGH' });
    expect(r.body.data.locationsNotSaved).toEqual([{ row: 2, code: 'K1', branchCode: null, reason: 'Fewer than 4 decimals.', kept: 'SAVED_LOCATION' }]);
  });

  it.each([
    ['the same point with a trailing zero dropped (23.5850 read as 23.585)', '23.585,58.4059', 23.585, 58.4059],
    ['the same point, latitude and longitude swapped', '58.4059,23.5859', 23.5859, 58.4059],
    ['2 decimals around the saved point', '23.59,58.41', 23.5859, 58.4059],
  ])('the file agrees with the saved point: kept and still used (%s)', async (_what, pair, lat, lng) => {
    S.rows[0] = cust('K1', { lat, lng, geocodeConfidence: 'HIGH' });
    const r = await importCsv(`code,name,priority,lat,lng\nK1,K1,3,${pair}\n`);
    expect(r.body.data.locationsNotSaved[0]).toMatchObject({ code: 'K1', kept: 'SAVED_LOCATION' });
    expect(S.updateManys).toEqual([]);
    expect(locationBlocksDelivery(S.rows[0]!)).toBe(false);
  });

  it('the file points somewhere else: the saved point is kept on the map but marked LOW, so it is not used until the pin is placed by hand', async () => {
    // The customer moved: the new master file has it about 12 km away, with 2 decimals.
    S.rows[0] = cust('K1', { lat: 23.5859, lng: 58.4059, geocodeConfidence: 'HIGH' });
    const r = await importCsv('code,name,priority,lat,lng\nK1,K1,3,23.61,58.52\n');
    expect(r.status).toBe(200);
    // Before: kept as it was, HIGH, and planned at the old point (LOCATION_UNVERIFIED does not block).
    expect(r.body.data.locationsNotSaved).toEqual([
      { row: 2, code: 'K1', branchCode: null, reason: 'Fewer than 4 decimals. The file points about 12 km from the saved location.', kept: 'SAVED_LOCATION_NEEDS_PIN' },
    ]);
    // Only while it is still not verified and still at the point that was compared (F05).
    expect(S.updateManys).toEqual([{ where: { id: 'K1', locationVerified: false, lat: 23.5859, lng: 58.4059 }, data: { geocodeConfidence: 'LOW' } }]);
    expect(S.rows[0]).toMatchObject({ lat: 23.5859, lng: 58.4059, geocodeConfidence: 'LOW', locationVerified: false });
    expect(locationBlocksDelivery(S.rows[0]!)).toBe(true);
    expect(r.body.data.warnings).toContain(
      '1 saved location(s) are not used until the pin is placed by hand: the file points somewhere else. Their orders are not planned or sent out until then. Drop the pin on each one (ADD LOCATION on Daily dispatch, or Set location on the customer page).',
    );
  });

  it('the file points somewhere else, and the pair is outside the area: marked LOW too; the dry run lists it and writes nothing', async () => {
    S.rows[0] = cust('K1', { lat: 23.5859, lng: 58.4059, geocodeConfidence: 'HIGH' });
    const dry = await importCsv('code,name,priority,lat,lng\nK1,K1,3,24.7136,46.6753\n', true);
    expect(dry.body.data).toMatchObject({
      dryRun: true,
      locationsNotSaved: [{ code: 'K1', kept: 'SAVED_LOCATION_NEEDS_PIN', reason: expect.stringMatching(/^Outside the delivery area\. The file points about [0-9,]+ km from the saved location\.$/) }],
    });
    expect(S.updateManys).toEqual([]);
    expect(S.rows[0]!.geocodeConfidence).toBe('HIGH');
  });

  it('a saved point that is itself not usable is kept but reported as not used, and not marked again (A5 second review)', async () => {
    S.rows[0] = cust('K1', { lat: 23.5859, lng: 58.4059, geocodeConfidence: 'HIGH' });
    // Import 1 points elsewhere: the saved point is marked LOW.
    await importCsv('code,name,priority,lat,lng\nK1,K1,3,23.61,58.52\n');
    expect(S.rows[0]).toMatchObject({ geocodeConfidence: 'LOW', locationVerified: false });
    S.updateManys = [];
    // Import 2 agrees with the saved point, which is still LOW: before, "The location it already has
    // is kept." with no warning, although nothing is delivered to it.
    const r = await importCsv('code,name,priority,lat,lng\nK1,K1,3,23.59,58.41\n');
    expect(r.body.data.locationsNotSaved).toEqual([{ row: 2, code: 'K1', branchCode: null, reason: 'Fewer than 4 decimals.', kept: 'SAVED_LOCATION_NOT_USABLE' }]);
    expect(r.body.data.warnings).toContain(
      '1 saved location(s) are not used until the pin is placed by hand: the saved location is not exact or is outside the delivery area, and nobody confirmed it. Their orders are not planned or sent out until then. Drop the pin on each one (ADD LOCATION on Daily dispatch, or Set location on the customer page).',
    );
    expect(S.updateManys).toEqual([]);
    expect(S.rows[0]).toMatchObject({ lat: 23.5859, lng: 58.4059, geocodeConfidence: 'LOW' });
  });

  it.each([
    ['outside the delivery area, never confirmed (coarse file pair)', { lat: 19.076, lng: 72.8777, geocodeConfidence: 'HIGH' }, '19.076,72.878', 'Outside the delivery area. Fewer than 4 decimals.'],
    ['outside the delivery area, never confirmed (exact file pair)', { lat: 19.076, lng: 72.8777, geocodeConfidence: 'HIGH' }, '19.0760,72.8777', 'Outside the delivery area.'],
    ['LOW, never confirmed (Validate only)', { lat: 23.5859, lng: 58.4059, geocodeConfidence: 'LOW' }, '23.586,58.406', 'Fewer than 4 decimals.'],
  ])('a saved point %s: SAVED_LOCATION_NOT_USABLE', async (_what, saved, pair, reason) => {
    S.rows[0] = cust('K1', saved);
    const r = await importCsv(`code,name,priority,lat,lng\nK1,K1,3,${pair}\n`, true);
    expect(r.body.data.locationsNotSaved).toEqual([{ row: 2, code: 'K1', branchCode: null, reason, kept: 'SAVED_LOCATION_NOT_USABLE' }]);
    expect(r.body.data.warnings.join(' ')).toMatch(/^.*1 saved location\(s\) are not used until the pin is placed by hand: the saved location is not exact/);
    expect(locationBlocksDelivery(S.rows[0]!)).toBe(true);
  });

  it('a saved point that was not usable, replaced by an exact pair from the file, is recorded as a location change (A5 third review)', async () => {
    S.rows[0] = cust('K1', { lat: 23.5859, lng: 58.4059, geocodeConfidence: 'LOW', locationSource: 'IMPORT' });
    S.rows[1] = cust('K2', { lat: 23.5901, lng: 58.4101, geocodeConfidence: 'HIGH' });
    vi.mocked(audit).mockClear();
    const r = await importCsv('code,name,priority,lat,lng\nK1,K1,3,23.6012,58.4201\nK2,K2,3,23.6013,58.4202\nK3,K3,3,23.6014,58.4203\n');
    expect(r.status).toBe(200);
    expect(S.rows[0]).toMatchObject({ lat: 23.6012, lng: 58.4201, geocodeConfidence: 'HIGH' });
    // Before: no row, so LOCK could not tell that a stop still planned at 23.5859, 58.4059 goes to
    // a point that was not usable (plan-service locationGate reads these rows).
    const changes = vi.mocked(audit).mock.calls.map((c) => c[0]).filter((a) => a.action === 'CUSTOMER_LOCATION_SET');
    expect(changes).toEqual([
      expect.objectContaining({
        entity: 'Customer',
        entityId: 'K1',
        beforeJson: { lat: 23.5859, lng: 58.4059, source: 'IMPORT', verified: false, confidence: 'LOW' },
        afterJson: { lat: 23.6012, lng: 58.4201, source: 'IMPORT', confidence: 'HIGH', check: 'IMPORT', fileName: 'customers.csv' },
      }),
    ]);
    // Control: K2's usable point and K3's confirmed one (kept) write no such row.
    expect(S.rows[2]).toMatchObject({ lat: 23.9, lng: 58.9 });
  });

  // A5 fifth review: the coordinates were written by one call and the row by another, after it, and
  // whether to write the row was judged on the customer as the import had read it at the start.
  it('the new pair and its location-change row are written together, with the customer locked: no row, no change', async () => {
    S.rows[0] = cust('K1', { lat: 23.5859, lng: 58.4059, geocodeConfidence: 'LOW', locationSource: 'IMPORT' });
    vi.mocked(audit).mockImplementation(async (a) => {
      if (a.action === 'CUSTOMER_LOCATION_SET') throw new Error('simulated: the row could not be written');
      return {} as never;
    });
    const file = 'code,name,priority,lat,lng\nK1,K1,3,23.6012,58.4201\n';
    await expect(importCsv(file)).rejects.toThrow('simulated');
    // Before: the customer was at the new pair with no row, so a stop still planned at the flagged
    // point locked, loaded and went out; importing the file again did not write the row either.
    expect(S.rows[0]).toMatchObject({ lat: 23.5859, lng: 58.4059, geocodeConfidence: 'LOW' });
    expect(S.raw).toEqual(['SELECT id FROM "Customer" WHERE id = ? AND "tenantId" = ? FOR UPDATE']);
    vi.mocked(audit).mockClear();
    vi.mocked(audit).mockImplementation(async () => ({}) as never);
    expect((await importCsv(file)).status).toBe(200);
    expect(S.rows[0]).toMatchObject({ lat: 23.6012, lng: 58.4201, geocodeConfidence: 'HIGH' });
    expect(vi.mocked(audit).mock.calls.map((c) => c[0]).filter((a) => a.action === 'CUSTOMER_LOCATION_SET')).toEqual([
      expect.objectContaining({ entityId: 'K1', beforeJson: { lat: 23.5859, lng: 58.4059, source: 'IMPORT', verified: false, confidence: 'LOW' } }),
    ]);
    // The row is written in the transaction of the change.
    expect(vi.mocked(audit).mock.calls.find((c) => c[0].action === 'CUSTOMER_LOCATION_SET')![1]).toBeDefined();
  });

  it('the row is judged on the customer as it is when the pair is written, not as the import read it at the start', async () => {
    S.rows[0] = cust('K1', { lat: 23.5859, lng: 58.4059, geocodeConfidence: 'HIGH', locationSource: 'IMPORT' });
    // Another customer file marks K1's saved point LOW after this import read the customers.
    S.afterRead = () => Object.assign(S.rows[0]!, { geocodeConfidence: 'LOW' });
    expect((await importCsv('code,name,priority,lat,lng\nK1,K1,3,23.6012,58.4201\n')).status).toBe(200);
    expect(S.rows[0]).toMatchObject({ lat: 23.6012, lng: 58.4201, geocodeConfidence: 'HIGH' });
    // Before: no row (the import's own read said the point was usable), so LOCK let a stop still
    // planned at the flagged point go.
    expect(vi.mocked(audit).mock.calls.map((c) => c[0]).filter((a) => a.action === 'CUSTOMER_LOCATION_SET')).toEqual([
      expect.objectContaining({ entityId: 'K1', beforeJson: { lat: 23.5859, lng: 58.4059, source: 'IMPORT', verified: false, confidence: 'LOW' } }),
    ]);
  });

  // A5 fifth review: the warning and the result box told the dispatcher to set on the map every row
  // listed, also the customers that keep a usable saved location (an Excel re-save that dropped a
  // trailing zero: every row of the master list), and said "No item is delivered" for them.
  it('rows whose customer keeps a usable saved location are counted apart: nothing to do for them', async () => {
    S.rows[0] = cust('K1', { lat: 23.585, lng: 58.4059, geocodeConfidence: 'HIGH' });
    const kept = await importCsv('code,name,priority,lat,lng\nK1,K1,3,23.585,58.4059\nK3,K3,3,23.9,58.9\n');
    expect(kept.body.data.locationsNotSaved.map((l: { kept: string }) => l.kept)).toEqual(['SAVED_LOCATION', 'SAVED_LOCATION']);
    expect(kept.body.data.warnings.join(' ')).not.toMatch(/Set them on the map|not planned or sent out/);
    expect(kept.body.data.warnings).toContain(
      '2 location(s) in the file are not exact, but each of these customers keeps the location it already has, which is used as before: nothing to do. To correct the file, type or paste each coordinate with all the decimals it really has (at least 4).',
    );
    // Mixed: only the rows that need a pin are counted in the instruction.
    const mixed = await importCsv('code,name,priority,lat,lng\nK1,K1,3,23.585,58.4059\nN1,New,3,23.58,58.40\n');
    const w = mixed.body.data.warnings.join(' | ');
    expect(w).toMatch(/^1 location\(s\) in the file are not exact and were not saved\. Set them on the map/);
    expect(w).toContain('1 location(s) in the file are not exact, but each of these customers keeps the location it already has');
  });

  it('control: a LOW point a dispatcher confirmed is usable: kept as SAVED_LOCATION, no warning', async () => {
    S.rows[0] = cust('K1', { lat: 23.5859, lng: 58.4059, geocodeConfidence: 'LOW', locationVerified: true });
    const r = await importCsv('code,name,priority,lat,lng\nK1,K1,3,23.586,58.406\n');
    expect(r.body.data.locationsNotSaved[0]).toMatchObject({ kept: 'SAVED_LOCATION' });
    expect(r.body.data.warnings.join(' ')).not.toMatch(/not used until the pin/);
  });

  it('a location a dispatcher confirmed is never changed, whatever the file says (F05)', async () => {
    const r = await importCsv('code,name,priority,lat,lng\nK3,K3,3,23.61,58.52\n');
    expect(r.body.data.locationsNotSaved[0]).toMatchObject({ code: 'K3', kept: 'SAVED_LOCATION' });
    expect(S.updateManys).toEqual([]);
    expect(S.rows[2]).toMatchObject({ lat: 23.9, lng: 58.9, locationVerified: true });
  });

  it('the check (Validate only) lists them too, and saves nothing', async () => {
    const { body } = await importCsv('code,name,priority,lat,lng\nN1,New,3,23.58,58.40\n', true);
    expect(body.data).toMatchObject({ dryRun: true, errorRows: 0, locationsNotSaved: [{ row: 2, code: 'N1', kept: null }] });
    expect(S.creates).toEqual([]);
  });

  it('Excel: a number cell counts the decimals it shows, so 23.5850 formatted with 4 decimals is exact', async () => {
    const r = await importFile(
      xlsx(
        [
          ['X1', 'Shown 23.5850', 3, 23.585, 58.4059], // the number is 23.585; the cell shows 23.5850
          ['X2', 'More decimals than shown', 3, 23.58591234, 58.40591234], // shown 23.5859: the number's own 8 decimals count
          ['X3', 'General format', 3, 23.585, 58.4059], // shows 23.585: 3 decimals, as the sheet shows it
        ],
        { D2: '0.0000', D3: '0.0000', E3: '0.0000' },
      ),
    );
    expect(r.status).toBe(200);
    // Before: X1 lost its trailing zero (the number 23.585 read as "23.585"): "fewer than 4 decimals", no location.
    expect(S.creates.map((c) => [c.code, c.lat, c.lng, c.geocodeConfidence])).toEqual([
      ['X1', 23.585, 58.4059, 'HIGH'],
      ['X2', 23.585912, 58.405912, 'HIGH'],
      ['X3', null, null, 'MISSING'],
    ]);
    expect(r.body.data.locationsNotSaved).toEqual([{ row: 4, code: 'X3', branchCode: null, reason: 'Fewer than 4 decimals.', kept: null }]);
  });

  // A5 fourth review: the screen said "format the cell ... to show 4 decimals". A number holds no
  // trailing zeros, so a cell of 23.58 formatted 0.0000 shows 23.5800: the padding counted as
  // precision, and every rough pair became exact. A number format now adds at most one zero.
  it('Excel: a number format adds at most one zero, so a rough 1- or 2-decimal pair formatted to show 4 or 6 decimals stays not exact', async () => {
    const r = await importFile(
      xlsx(
        [
          ['R2', 'Two decimals shown as 4', 3, 23.58, 58.41],
          ['R1', 'One decimal shown as 4', 3, 23.6, 58.4],
          ['R6', 'Two decimals shown as 6', 3, 23.58, 58.41],
          ['X6', 'Three decimals shown as 6', 3, 23.585, 58.406],
        ],
        { D2: '0.0000', E2: '0.0000', D3: '0.0000', E3: '0.0000', D4: '0.000000', E4: '0.000000', D5: '0.000000', E5: '0.000000' },
      ),
    );
    expect(r.status).toBe(200);
    // Before: R2, R1 and R6 stored as exact (HIGH, from the import) at 23.58, 58.41 and 23.6, 58.4.
    expect(S.creates.map((c) => [c.code, c.lat, c.lng, c.geocodeConfidence])).toEqual([
      ['R2', null, null, 'MISSING'],
      ['R1', null, null, 'MISSING'],
      ['R6', null, null, 'MISSING'],
      // 23.585 shown with 6 decimals reads as 23.5850 (one zero more), like 0.0000: exact.
      ['X6', 23.585, 58.406, 'HIGH'],
    ]);
    // A5 fifth review: the reason says why a pair shown with 4 or 6 decimals has fewer.
    expect(r.body.data.locationsNotSaved.map((l: { code: string; reason: string }) => [l.code, l.reason])).toEqual([
      ['R2', ZEROS],
      ['R1', ZEROS],
      ['R6', ZEROS],
    ]);
  });

  // A5 fifth review: the one-zero rule held only for Excel number formats. A CSV (typed, or saved by
  // Excel from cells formatted to show 4 decimals, which writes each cell as it shows) and an Excel
  // Text cell were read as written, so 23.5800 was 4 decimals and a point good to about 1 km was
  // stored as exact: the same sheet was refused as .xlsx and stored as CSV.
  it('a pair written with zeros at the end counts one of them, whatever the file: 23.5800 is not exact, 23.5850 is', async () => {
    const csv = 'code,name,priority,lat,lng\nT1,Typed with padding,3,23.5800,58.4100\nT2,One zero,3,23.5850,58.4150\nT3,Six decimals,3,23.585000,58.415012\nT4,Padded to 6,3,23.580000,58.410000\n';
    const textCells = XLSX.utils.aoa_to_sheet([['code', 'name', 'priority', 'lat', 'lng'], ...csv.trim().split('\n').slice(1).map((l) => l.split(','))]);
    expect(textCells.D2).toMatchObject({ t: 's', v: '23.5800' }); // Text cells, as typed
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, textCells, 'Customers');
    const files = [
      new File([csv], 'customers.csv', { type: 'text/csv' }),
      new File([csv], 'customers.csv', { type: 'application/vnd.ms-excel' }),
      new File([XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer], 'customers.xlsx', { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }),
    ];
    for (const file of files) {
      S.creates = [];
      const r = await importFile(file);
      expect(S.creates.map((c) => [c.code, c.lat, c.lng, c.geocodeConfidence]), file.type).toEqual([
        ['T1', null, null, 'MISSING'],
        ['T2', 23.585, 58.415, 'HIGH'],
        ['T3', 23.585, 58.415012, 'HIGH'],
        ['T4', null, null, 'MISSING'],
      ]);
      expect(r.body.data.locationsNotSaved, file.type).toEqual([
        { row: 2, code: 'T1', branchCode: null, reason: ZEROS, kept: null },
        { row: 5, code: 'T4', branchCode: null, reason: ZEROS, kept: null },
      ]);
    }
  });

  it('the CSV Excel saves from cells formatted to show 4 decimals is read like the workbook, sent as CSV or as Excel', async () => {
    const ws = XLSX.utils.aoa_to_sheet([['code', 'name', 'priority', 'lat', 'lng'], ['C1', 'Rough', 2, 23.58, 58.41], ['C2', 'Exact, ends in 0', 2, 23.585, 58.4105]]);
    for (const c of ['D2', 'E2', 'D3', 'E3']) ws[c]!.z = '0.0000';
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Customers');
    // Excel, like SheetJS, writes each cell of a CSV as it shows.
    const csv = XLSX.write(wb, { type: 'string', bookType: 'csv' }) as string;
    expect(csv.split('\n').slice(1, 3)).toEqual(['C1,Rough,2,23.5800,58.4100', 'C2,"Exact, ends in 0",2,23.5850,58.4105']);
    const files = [
      new File([XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer], 'customers.xlsx', { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }),
      new File([csv], 'customers.csv', { type: 'text/csv' }),
      new File([csv], 'customers.csv', { type: 'application/vnd.ms-excel' }),
    ];
    for (const file of files) {
      S.creates = [];
      const r = await importFile(file);
      // Before: the CSV stored C1 as exact (HIGH, from the import) at 23.58, 58.41, on both paths.
      expect(S.creates.map((c) => [c.code, c.lat, c.lng, c.geocodeConfidence]), file.type).toEqual([
        ['C1', null, null, 'MISSING'],
        ['C2', 23.585, 58.4105, 'HIGH'],
      ]);
      expect(r.body.data.locationsNotSaved, file.type).toEqual([{ row: 2, code: 'C1', branchCode: null, reason: ZEROS, kept: null }]);
    }
  });

  it('the warning says what the check will do on Validate only, and what the import did (A5 fourth review)', async () => {
    const csv = 'code,name,priority,lat,lng\nN1,New,3,23.58,58.40\n';
    const advice =
      'Set them on the map (ADD LOCATION on Daily dispatch, or Set location on the customer page), or fix the file: type or paste each coordinate with all the decimals it really has (at least 4); if Excel drops a trailing zero, format the lat and lng columns as Text before typing or pasting.';
    // Before: "were not saved" also on Validate only, and "in Excel format the lat and lng cells as text".
    expect((await importCsv(csv, true)).body.data.warnings).toContain(`1 location(s) in the file are not exact and will not be saved. ${advice}`);
    expect((await importCsv(csv)).body.data.warnings).toContain(`1 location(s) in the file are not exact and were not saved. ${advice}`);
    // A file with errors (here a row without a name) saves nothing either.
    const withError = await importCsv(`${csv}N2,,3,23.5859,58.4059\n`);
    expect(withError.body.data.errorRows).toBe(1);
    expect(withError.body.data.warnings).toContain(`1 location(s) in the file are not exact and will not be saved. ${advice}`);
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

describe('the decimals a lat / lng cell shows, with A1 merged (SheetJS reads with cellText: false)', () => {
  it('a CSV sent as Excel (Chrome and Edge on a PC with Excel send a .csv as application/vnd.ms-excel) keeps the decimals in the file', async () => {
    const r = await importFile(
      new File(['code,name,priority,lat,lng\nX1,Saved by Excel,3,23.5850,58.4059\nX2,Three decimals,3,23.585,58.4059\n'], 'customers.csv', { type: 'application/vnd.ms-excel' }),
    );
    expect(r.status).toBe(200);
    // SheetJS reads this file with its CSV reader. Without the cell's own text (A1 reads with
    // cellText: false) X1 would be the number 23.585: "Fewer than 4 decimals", no location.
    expect(S.creates.map((c) => [c.code, c.lat, c.lng, c.geocodeConfidence])).toEqual([
      ['X1', 23.585, 58.4059, 'HIGH'],
      ['X2', null, null, 'MISSING'],
    ]);
    expect(r.body.data.locationsNotSaved).toEqual([{ row: 3, code: 'X2', branchCode: null, reason: 'Fewer than 4 decimals.', kept: null }]);
  });

  // A5 fifth review: a CSV whose first header is "ID" goes through SheetJS's SYLK reader before its
  // CSV reader, and was read without its own text, so a trailing zero was lost only when the browser
  // sent it as Excel (Chrome and Edge on a PC with Excel): 23.5850 became "Fewer than 4 decimals.".
  it.each([
    ['semicolons', 'ID;code;name;priority;lat;lng\n1;C1;Shop;2;23.5850;58.4150\n'],
    ['semicolons, CRLF', 'ID;code;name;priority;lat;lng\r\n1;C1;Shop;2;23.5850;58.4150\r\n'],
    ['commas', 'ID,code,name,priority,lat,lng\n1,C1,Shop,2,23.5850,58.4150\n'],
  ])('a CSV whose first header is "ID" (%s) keeps the decimals in the file, sent as CSV or as Excel', async (_what, csv) => {
    for (const type of ['text/csv', 'application/vnd.ms-excel']) {
      S.creates = [];
      const r = await importFile(new File([csv], 'customers.csv', { type }));
      expect(S.creates.map((c) => [c.code, c.lat, c.lng, c.geocodeConfidence]), type).toEqual([['C1', 23.585, 58.415, 'HIGH']]);
      expect(r.body.data.locationsNotSaved, type).toEqual([]);
    }
  });

  it(`only the lat and lng cells are formatted, and only with a format of at most ${MAX_SHOWN_FORMAT} characters`, async () => {
    const at64 = `0.0000${'""'.repeat(29)}`; // shows 23.5850
    const at66 = `0.0000${'""'.repeat(30)}`; // shows 23.5850 too, but is longer than the cap
    expect([at64.length, at66.length]).toEqual([MAX_SHOWN_FORMAT, MAX_SHOWN_FORMAT + 2]);
    const format = vi.spyOn(XLSX.SSF, 'format');
    try {
      const r = await importFile(
        xlsx(
          [
            ['X1', 'Format of 64 characters', 3, 23.585, 58.4059],
            ['X2', 'Format of 66 characters', 3, 23.585, 58.4059],
          ],
          { C2: '0.00', D2: at64, C3: '0.00', D3: at66, E3: at66 },
        ),
      );
      expect(r.status).toBe(200);
      // One cell formatted: D2. Not the priority cells (C2, C3), not E2 (General), not D3 or E3.
      expect(format.mock.calls.map((c) => c[0])).toEqual([at64]);
      expect(S.creates.map((c) => [c.code, c.priority, c.lat, c.geocodeConfidence])).toEqual([
        ['X1', 3, 23.585, 'HIGH'],
        ['X2', 3, null, 'MISSING'],
      ]);
    } finally {
      format.mockRestore();
    }
  });

  // A5 fourth review: SheetJS parses a format again for every cell it formats, and a 64-character
  // format it cannot apply cost about 50 microseconds a cell. Every lat / lng cell of every sheet was
  // formatted, also the sheets that are not read and every column named "lat", "LAT", "lat " ... that
  // the rows then fold into one: a 83 KB file of ten sheets took 40 s, a 222 KB one with 44 such
  // columns 108 s, with the app answering nothing meanwhile.
  describe('the work is bounded per upload, not per cell (A5 fourth review)', () => {
    const THROWS = '#,'.repeat(32); // 64 characters: within MAX_SHOWN_FORMAT, and SheetJS cannot apply it
    /** A workbook of sheets [name, rows (header first), number format by column letter]. */
    function book(sheets: [string, unknown[][], Record<string, string>][]): File {
      const wb = XLSX.utils.book_new();
      for (const [name, rows, formats] of sheets) {
        const ws = XLSX.utils.aoa_to_sheet(rows);
        for (const [col, z] of Object.entries(formats)) {
          for (let r = 2; r <= rows.length; r++) if (ws[`${col}${r}`]) ws[`${col}${r}`]!.z = z;
        }
        XLSX.utils.book_append_sheet(wb, ws, name);
      }
      return new File([XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer], 'customers.xlsx', {
        type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      });
    }
    const rowsOf = (n: number, row: (i: number) => unknown[]) => Array.from({ length: n }, (_, i) => row(i));

    it('each number format is tried once per upload, not once per cell (also one SheetJS cannot apply)', async () => {
      const file = book([['Customers', [['code', 'name', 'priority', 'lat', 'lng'], ...rowsOf(300, (i) => [`C${i}`, 'n', 3, 23.585, 58.4059])], { D: THROWS, E: '0.0000' }]]);
      const format = vi.spyOn(XLSX.SSF, 'format');
      try {
        const parsed = await parseUpload(file, { decimalTextColumns: ['lat', 'lng'] });
        // Before: 600 calls, one per cell (300 of them throwing).
        expect(format.mock.calls.map((c) => c[0]).sort()).toEqual([THROWS, '0.0000'].sort());
        expect(parsed.rows).toHaveLength(300);
        // The format that cannot be applied: the number's own decimals count.
        expect(parsed.rows[0]).toMatchObject({ lat: '23.585', lng: '58.4059' });
      } finally {
        format.mockRestore();
      }
    });

    it('only the sheet that is read, and only the one column per name the rows keep, are formatted', async () => {
      const other = '0.0000000';
      const file = book([
        // "lat", "LAT" and "Lat " all become "lat" in the rows, which keep the last one (F).
        ['Customers', [['code', 'name', 'priority', 'lat', 'LAT', 'Lat ', 'lng'], ['C1', 'n', 3, 23.1, 23.2, 23.585, 58.4059]], { D: '0.00000', E: '0.000000', F: '0.0000' }],
        ...Array.from({ length: 9 }, (_, i): [string, unknown[][], Record<string, string>] => [`Other${i + 1}`, [['lat', 'lng'], ...rowsOf(50, () => [23.5, 58.4])], { A: other, B: THROWS }]),
      ]);
      const format = vi.spyOn(XLSX.SSF, 'format');
      try {
        const parsed = await parseUpload(file, { decimalTextColumns: ['lat', 'lng'] });
        // Before: D2, E2 and F2, and every lat / lng cell of the nine sheets that are not read.
        expect(format.mock.calls.map((c) => c[0])).toEqual(['0.0000']);
        expect(parsed.sheetName).toBe('Customers');
        expect(parsed.rows).toEqual([{ code: 'C1', name: 'n', priority: '3', lat: '23.5850', lng: '58.4059' }]);
        expect(parsed.warnings.join(' ')).toMatch(/Only sheet "Customers" was read/);
      } finally {
        format.mockRestore();
      }
    });

    it(`at most ${MAX_SHOWN_FORMATS} different formats are tried in one upload; a cell in any other counts its number's own decimals`, async () => {
      // Formats that all show 4 decimals, each written differently.
      const formats = Array.from({ length: MAX_SHOWN_FORMATS + 5 }, (_, i) => `0.0000${'""'.repeat(i)}`);
      const wb = XLSX.utils.book_new();
      const ws = XLSX.utils.aoa_to_sheet([['code', 'name', 'priority', 'lat', 'lng'], ...formats.map((_, i) => [`C${i}`, 'n', 3, 23.585, 58.4059])]);
      formats.forEach((z, i) => (ws[`D${i + 2}`]!.z = z));
      XLSX.utils.book_append_sheet(wb, ws, 'Customers');
      const file = new File([XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer], 'customers.xlsx', {
        type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      });
      const format = vi.spyOn(XLSX.SSF, 'format');
      try {
        const parsed = await parseUpload(file, { decimalTextColumns: ['lat', 'lng'] });
        expect(format).toHaveBeenCalledTimes(MAX_SHOWN_FORMATS);
        expect(parsed.rows.map((r) => r.lat)).toEqual(formats.map((_, i) => (i < MAX_SHOWN_FORMATS ? '23.5850' : '23.585')));
      } finally {
        format.mockRestore();
      }
    });
  });

  it('every other cell reads exactly as without the lat / lng columns: a date format on another column is not applied', async () => {
    const ws = XLSX.utils.aoa_to_sheet([
      ['code', 'since', 'lat', 'lng'],
      ['X1', 45000, 23.585, 58.4059],
    ]);
    ws.B2!.z = 'yyyy-mm-dd';
    ws.C2!.z = '0.0000';
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Customers');
    const file = new File([XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer], 'customers.xlsx', {
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    });
    const withDecimals = await parseUpload(file, { decimalTextColumns: ['lat', 'lng'] });
    // The cells keep their number formats for this read (cellNF): a "since" read as a date here
    // would be a date string, not the Excel serial the rows always hold.
    expect(withDecimals.rows).toEqual([{ code: 'X1', since: '45000', lat: '23.5850', lng: '58.4059' }]);
    expect((await parseUpload(file)).rows).toEqual([{ code: 'X1', since: '45000', lat: '23.585', lng: '58.4059' }]);
  });
});

describe('the import screen says the location rule in plain words (A5 review)', () => {
  it('the lat and lng hints give the rule before the file is imported', async () => {
    const tree = await CustomerImportPage({ params: { slug: 'nmwc' } });
    const hints = Object.fromEntries(elements(tree).filter((e) => typeName(e) === 'Field').map((e) => [e.props.name, e.props.hint]));
    // Before: "-90 to 90; leave blank to fix on the map later." and "-180 to 180." - nothing about the rule.
    // A5 fourth review: before, "In Excel, format the cell as text or to show 4 decimals" - and a cell
    // of 23.58 formatted to show 4 decimals shows 23.5800, which made a rough point exact.
    expect(hints.lat).toBe(
      'At least 4 decimals, inside the delivery area. Type or paste each coordinate with all the decimals it really has; if Excel drops a trailing zero, format the column as Text before typing or pasting. Leave blank to set the location on the map later.',
    );
    expect(Object.values(hints).join(' ')).not.toMatch(/show 4 decimals/);
    expect(hints.lng).toBe('At least 4 decimals. A pair that is not exact is not saved: the row is imported without it and listed after the check.');
  });

  it('each row listed says what happens to the customer\'s location', () => {
    const row = (kept: 'SAVED_LOCATION' | 'SAVED_LOCATION_NEEDS_PIN' | 'SAVED_LOCATION_NOT_USABLE' | null) => ({ row: 2, code: 'K1', branchCode: null, reason: 'Fewer than 4 decimals.', kept });
    expect(locationNotSavedLine(row(null), false)).toBe('Fewer than 4 decimals. It has no location until you set one.');
    expect(locationNotSavedLine(row('SAVED_LOCATION'), false)).toBe('Fewer than 4 decimals. The location it already has is kept.');
    // A5 second review: what happens to its orders, in the words of the rule the system enforces
    // (before: "nothing is delivered to it", also for a load already on the road).
    expect(locationNotSavedLine(row('SAVED_LOCATION_NEEDS_PIN'), false)).toBe(
      'Fewer than 4 decimals. Its saved location is no longer used: its orders are not planned or sent out until someone drops the pin on the map.',
    );
    expect(locationNotSavedLine(row('SAVED_LOCATION_NEEDS_PIN'), true)).toBe(
      'Fewer than 4 decimals. Its saved location will no longer be used: its orders are not planned or sent out until someone drops the pin on the map.',
    );
    // A kept point that is itself not usable (before: "The location it already has is kept.").
    for (const dryRun of [false, true]) {
      expect(locationNotSavedLine(row('SAVED_LOCATION_NOT_USABLE'), dryRun)).toBe(
        'Fewer than 4 decimals. Its saved location is not exact or is outside the delivery area, so it is not used either: its orders are not planned or sent out until someone drops the pin on the map.',
      );
    }
  });

  // A5 fifth review: the box told the dispatcher to set every listed row on the map and that "No item
  // is delivered without a correct location", also for customers that keep a usable saved location.
  it('the result box asks for a pin only for the rows that need one; the others are counted apart', () => {
    const row = (kept: 'SAVED_LOCATION' | 'SAVED_LOCATION_NEEDS_PIN' | 'SAVED_LOCATION_NOT_USABLE' | null, n: number) => ({ row: n, code: `K${n}`, branchCode: null, reason: 'Fewer than 4 decimals.', kept });
    const advice =
      'Set each one on the map (ADD LOCATION on Daily dispatch, or Set location on the customer page), or fix the file and import it again: type or paste each coordinate with all the decimals it really has (at least 4); if Excel drops a trailing zero, format the lat and lng columns as Text before typing or pasting.';
    const keptOnly = locationsNotSavedSummary([row('SAVED_LOCATION', 2), row('SAVED_LOCATION', 3)], false);
    expect(keptOnly).toEqual({
      needPin: null,
      kept: '2 location(s) are not exact, but each of these customers keeps the location it already has, which is used as before: nothing to do.',
    });
    const mixed = locationsNotSavedSummary([row('SAVED_LOCATION', 2), row(null, 3), row('SAVED_LOCATION_NEEDS_PIN', 4), row('SAVED_LOCATION_NOT_USABLE', 5)], false);
    expect(mixed).toEqual({
      needPin: { heading: '3 location(s) are not exact, so they are not saved. No item is delivered without a correct location.', advice },
      kept: '1 location(s) are not exact, but each of these customers keeps the location it already has, which is used as before: nothing to do.',
    });
    expect(locationsNotSavedSummary([row(null, 2)], true)).toEqual({
      needPin: { heading: '1 location(s) are not exact, so they are not going to be saved. No item is delivered without a correct location.', advice },
      kept: null,
    });
  });
});
