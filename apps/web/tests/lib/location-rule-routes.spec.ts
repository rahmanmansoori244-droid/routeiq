/**
 * Audit PR A5, the owner's location rule ("locations should always be correct ... no item will be
 * delivered without location"), on the routes that write a customer's coordinates (fake database,
 * the real route code; the same on real PostgreSQL in tests/integration/location-rule-db.spec.ts):
 *
 *  - PUT /api/customers/:id/location (ADD LOCATION and the customer page) checks every save itself
 *    (L2): a reading is read again with no network call and refused when it needs a pin or cannot be
 *    read (422 PIN_REQUIRED) or is not the point sent (422 LOCATION_MISMATCH); the source and
 *    confidence stored are the parser's; the customer's saved point sent back unchanged is confirmed
 *    only when it is exact; a "hand pin" exactly on a reading that needs a pin was not moved;
 *  - PATCH /api/customers/:id refuses coordinates (it stored any pair as verified HIGH, with no check);
 *  - POST /api/customers refuses a pair that needs a pin (it stored any pair as HIGH);
 *  - the customer page sets a location through the same dialog and route as ADD LOCATION.
 *
 * A5 third review: a directions link read as its start and a classic ?ll= link (the map centre) are
 * refused as read (422 PIN_REQUIRED); the location and its audit row commit together (LOCK reads the
 * row); the customer page and the customers list say when a saved point blocks delivery.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakePrisma, rawLog, resetDb, row, tables } from './fake-plan-db';
import { Host, elements, textOf, typeName } from './hook-host';

vi.mock('react', async (importActual) => (await import('./hook-host')).mockReactHooks(importActual));
vi.mock('@/lib/auth', () => ({
  auth: async () => ({ user: { id: 'u1', tenantId: 'tA', role: 'PLANNER', name: 'Planner One', email: 'p@a.example' } }),
}));
vi.mock('@/lib/db', async () => ({ prisma: (await import('./fake-plan-db')).fakePrisma }));
vi.mock('@/lib/tenant', async () => {
  const m = await import('./fake-plan-db');
  return { tenantDb: () => m.fakePrisma };
});
const audits = vi.hoisted(() => [] as Record<string, any>[]);
vi.mock('@/lib/audit', () => ({ audit: vi.fn(async (a: Record<string, any>) => void audits.push(a)) }));
vi.mock('@/lib/dispatch/service-area', async () => {
  const { DEFAULT_SERVICE_AREA } = await import('@/lib/dispatch/location-input');
  return { tenantServiceArea: async () => DEFAULT_SERVICE_AREA };
});
vi.mock('sonner', () => ({ toast: { success() {}, error() {}, warning() {}, info() {} } }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ replace() {}, refresh() {}, push() {} }) }));
vi.mock('next/dynamic', () => ({ default: () => function PinMapStub() { return null; } }));

import { PUT as locationPut } from '@/app/api/customers/[id]/location/route';
import { POST as locationParse } from '@/app/api/locations/parse/route';
import { audit } from '@/lib/audit';
import { PATCH as customerPatch } from '@/app/api/customers/[id]/route';
import { POST as customerPost } from '@/app/api/customers/route';
import { DEFAULT_SERVICE_AREA, PIN_REQUIRED_MESSAGE, SAVED_NOT_EXACT_MESSAGE, SAVED_OUTSIDE_AREA_MESSAGE, SAVED_SWAPPED_MESSAGE } from '@/lib/dispatch/location-input';
import { CustomerEditor } from '@/app/t/[slug]/customers/[id]/customer-editor';
import { CustomersClient } from '@/app/t/[slug]/customers/customers-client';
import { LOW_LOCATION_MESSAGE, OUTSIDE_AREA_LOCATION_MESSAGE } from '@/lib/dispatch/customer-attrs';

const T = 'tA';
const customer = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  tenantId: T,
  code: id,
  branchCode: null,
  branchKey: '__MAIN__',
  name: `Customer ${id}`,
  active: true,
  lat: 23.5859,
  lng: 58.4059,
  geocodeConfidence: 'HIGH',
  locationSource: 'IMPORT',
  locationInput: null,
  locationVerified: false,
  locationVerifiedById: null,
  locationVerifiedAt: null,
  hardWindowStartMin: null,
  hardWindowEndMin: null,
  prefWindowStartMin: null,
  prefWindowEndMin: null,
  ...over,
});
const json = (url: string, method: string, body: unknown) =>
  new Request(`http://localhost${url}`, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const answer = async (res: Response) => ({ status: res.status, body: (await res.json()) as { data: any; error: any } });
const put = async (id: string, body: unknown) => answer(await locationPut(json(`/api/customers/${id}/location`, 'PUT', body), { params: { id } }));
const stored = (id: string) => {
  const r = row('customer', id);
  return { lat: r.lat, lng: r.lng, verified: r.locationVerified, source: r.locationSource, confidence: r.geocodeConfidence, input: r.locationInput };
};

const fetchSpy = vi.fn(async () => {
  throw new Error('no network call is allowed when a location is saved with lat/lng');
});
beforeEach(() => {
  resetDb();
  audits.length = 0;
  fetchSpy.mockClear();
  vi.stubGlobal('fetch', fetchSpy);
  tables.customer = [
    customer('K1'),
    customer('MED', { geocodeConfidence: 'MEDIUM' }),
    customer('LOW', { geocodeConfidence: 'LOW', lat: 23, lng: 58 }),
    // Stored HIGH as 23.585, 58.4: the number drops the zeros (for example "23.5850, 58.4000" read
    // before the one-zero rule; that text now needs a pin).
    customer('ZERO', { lat: 23.585, lng: 58.4 }),
    customer('AWAY', { lat: 24.7136, lng: 46.6753 }), // HIGH import from before A5, outside Oman/UAE, never confirmed
    customer('SWAP', { lat: 58.4059, lng: 23.5859 }), // HIGH import from before A5, latitude and longitude swapped
    customer('OK', { locationVerified: true, locationSource: 'MAP_PIN', locationInput: 'map pin' }),
    customer('NONE', { lat: null, lng: null, geocodeConfidence: 'MISSING', locationSource: null }),
  ];
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('PUT /api/customers/:id/location: a reading is read again on the server (L2)', () => {
  it('a reading that needs a pin, sent as read: 422 PIN_REQUIRED, the customer unchanged', async () => {
    const before = stored('K1');
    for (const [input, lat, lng] of [['23.58, 58.40', 23.58, 58.4], ['23°N 58°E', 23, 58], ['https://www.google.com/maps/@23.61,58.41,17z', 23.61, 58.41], ['58.4059, 23.5859', 23.5859, 58.4059]] as const) {
      const r = await put('K1', { lat, lng, source: 'GOOGLE_MAPS_URL', input });
      // Before: 200, stored as the reading, verified, HIGH.
      expect(r.status, input).toBe(422);
      expect(r.body.error).toMatchObject({ code: 'PIN_REQUIRED', message: PIN_REQUIRED_MESSAGE });
    }
    expect(stored('K1')).toEqual(before);
    expect(audits).toEqual([]);
  });

  it('a directions link read as its start, and a classic ?ll= link (the map centre), sent as read: 422 PIN_REQUIRED (A5 third review)', async () => {
    const before = stored('K1');
    const dir = 'https://www.google.com/maps/dir/23.6100123,58.5400456/Lulu+Hypermarket+Bawshar/@23.59,58.42,13z/data=!4m8!4m7!1m0!1m5!1m1!1s0x3e8dfd:0x1!2m2!1d58.4059!2d23.5859';
    const cases: [string, Record<string, unknown>][] = [
      // Before: 200, the start of the route (the salesman's own position) stored as verified HIGH.
      ['directions link', { lat: 23.610012, lng: 58.540046, source: 'GOOGLE_MAPS_URL', input: dir }],
      ['directions link, as the map centre', { lat: 23.59, lng: 58.42, source: 'GOOGLE_MAPS_URL', input: dir }],
      ['short link that led to a directions link', { lat: 23.610012, lng: 58.540046, source: 'GOOGLE_MAPS_URL', input: 'https://maps.app.goo.gl/abc123', resolvedUrl: dir }],
      // Before: 200, the centre of the view stored as verified HIGH.
      ['?ll=', { lat: 23.585912, lng: 58.405912, source: 'GOOGLE_MAPS_URL', input: 'https://maps.google.com/maps?ll=23.585912,58.405912&z=15' }],
      ['?q=<place>&ll=', { lat: 23.585912, lng: 58.405912, source: 'GOOGLE_MAPS_URL', input: 'https://maps.google.com/maps?q=Lulu+Hypermarket&ll=23.585912,58.405912&z=15' }],
    ];
    for (const [what, body] of cases) {
      const r = await put('K1', body);
      expect(r.status, what).toBe(422);
      expect(r.body.error, what).toMatchObject({ code: 'PIN_REQUIRED', message: PIN_REQUIRED_MESSAGE });
    }
    // { input } alone is refused the same way.
    expect((await put('K1', { input: dir })).body.error, 'input only').toMatchObject({ code: 'PIN_REQUIRED' });
    expect(stored('K1')).toEqual(before);
    expect(audits).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
    // A pin placed by hand at the destination is the way to save it.
    expect((await put('K1', { lat: 23.5859, lng: 58.4061, source: 'MAP_PIN', input: dir })).status).toBe(200);
    expect(stored('K1')).toMatchObject({ lat: 23.5859, lng: 58.4061, verified: true, source: 'MAP_PIN', confidence: 'HIGH' });
  });

  it('the location and its audit row commit together: if the row cannot be written, nothing is saved (A5 third review)', async () => {
    // LOCK reads the row's "before" point (plan-service locationGate): a saved pin without its row
    // would let a stop planned at the old, flagged point go out.
    const before = stored('LOW');
    vi.mocked(audit).mockRejectedValueOnce(new Error('audit insert failed (simulated)'));
    const r = await put('LOW', { lat: 23.6011, lng: 58.4011, source: 'MAP_PIN' });
    expect(r.status).toBe(500);
    // Before: the pin was saved (verified HIGH) and only the audit row was missing.
    expect(stored('LOW')).toEqual(before);
    const ok = await put('LOW', { lat: 23.6011, lng: 58.4011, source: 'MAP_PIN' });
    expect(ok.status).toBe(200);
    expect(vi.mocked(audit).mock.calls.at(-1)![1]).toBeDefined(); // written in the save's transaction
    expect(audits.at(-1)).toMatchObject({ entityId: 'LOW', beforeJson: { lat: 23, lng: 58, verified: false, confidence: 'LOW' } });
  });

  it('the row records the point as it is when the change is written, with the customer locked (A5 fifth review)', async () => {
    // A customer file marks K1's saved point LOW after the route read the customer, before it writes.
    const tx = fakePrisma.$transaction;
    fakePrisma.$transaction = async (cb: (t: unknown) => Promise<unknown>) => {
      Object.assign(row('customer', 'K1'), { geocodeConfidence: 'LOW' });
      return tx(cb);
    };
    try {
      expect((await put('K1', { lat: 23.6011, lng: 58.4011, source: 'MAP_PIN' })).status).toBe(200);
    } finally {
      fakePrisma.$transaction = tx;
    }
    // Before: "confidence: HIGH", as the route had read it, so LOCK let a stop still planned at the
    // flagged point go (it reads this row's "before" point).
    expect(audits.at(-1)).toMatchObject({ entityId: 'K1', beforeJson: { lat: 23.5859, lng: 58.4059, verified: false, confidence: 'LOW' } });
    expect(rawLog).toContain('SELECT id FROM "Customer" WHERE id = ? AND "tenantId" = ? FOR UPDATE');
  });

  it('a point that is not where the text points: 422 LOCATION_MISMATCH', async () => {
    const r = await put('K1', { lat: 23.6, lng: 58.4059, source: 'MANUAL_LATLNG', input: '23.5859, 58.4059' });
    expect(r.status).toBe(422);
    expect(r.body.error.code).toBe('LOCATION_MISMATCH');
    expect(stored('K1').verified).toBe(false);
  });

  it("an exact reading is saved with the parser's source and confidence, never the client's", async () => {
    const r = await put('K1', { lat: 23.6001, lng: 58.4102, source: 'GOOGLE_MAPS_URL', input: '23.6001, 58.4102' });
    expect(r.status).toBe(200);
    expect(stored('K1')).toEqual({ lat: 23.6001, lng: 58.4102, verified: true, source: 'MANUAL_LATLNG', confidence: 'HIGH', input: '23.6001, 58.4102' });
    expect(audits[0]).toMatchObject({ action: 'CUSTOMER_LOCATION_SET', afterJson: { source: 'MANUAL_LATLNG', confidence: 'HIGH', check: 'READING' } });
  });

  it('a save that is not a hand pin needs the text it was read from', async () => {
    const r = await put('K1', { lat: 23.6001, lng: 58.4102, source: 'MANUAL_LATLNG' });
    expect(r.status).toBe(422);
    expect(r.body.error.code).toBe('PIN_REQUIRED');
  });

  it('a short link is read from the address the Read found, with no network call', async () => {
    const link = 'https://maps.app.goo.gl/AbCdEf';
    const ok = await put('K1', { lat: 23.6703, lng: 58.1889, source: 'GOOGLE_MAPS_URL', input: link, resolvedUrl: 'https://www.google.com/maps/place/Seeb/data=!3d23.6703!4d58.1889' });
    expect(ok.status).toBe(200);
    expect(stored('K1')).toMatchObject({ lat: 23.6703, lng: 58.1889, source: 'GOOGLE_MAPS_URL', confidence: 'HIGH', input: link });
    const none = await put('MED', { lat: 23.6703, lng: 58.1889, source: 'GOOGLE_MAPS_URL', input: link });
    expect(none.status).toBe(422);
    expect(none.body.error).toMatchObject({ code: 'PIN_REQUIRED', message: expect.stringMatching(/Press Read again/) });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('the client cannot claim a GEOCODER source (400)', async () => {
    expect((await put('K1', { lat: 23.6001, lng: 58.4102, source: 'GEOCODER', input: '23.6001, 58.4102' })).status).toBe(400);
  });

  it('{ input } alone that needs a pin: 422 PIN_REQUIRED (was CONFIRM_ON_MAP); an exact one is saved HIGH', async () => {
    const r = await put('K1', { input: '23.58, 58.40' });
    expect(r.status).toBe(422);
    expect(r.body.error.code).toBe('PIN_REQUIRED');
    expect((await put('K1', { input: '23.6001, 58.4102' })).status).toBe(200);
    expect(stored('K1')).toMatchObject({ lat: 23.6001, lng: 58.4102, confidence: 'HIGH', verified: true });
  });
});

// Owner decision of 28 Sep 2026, "Same rule everywhere": a pair a dispatcher types or pastes is judged
// like the customer import. Of the zeros at the end of a decimal coordinate only one counts, so
// "23.5800, 58.4100" (3 decimals as counted) is not exact. Before, it read as 4 decimals: HIGH, saved
// as a verified reading, planned and loaded at a point good to about 1 km.
describe('Same rule everywhere (owner decision of 28 Sep 2026): of the zeros at the end of a typed coordinate, one counts', () => {
  const ZEROS = 'Fewer than 4 decimals (only one zero at the end counts).';
  const ZEROS_PIN = "Fewer than 4 decimals (only one zero at the end counts). Drop the pin on the customer's exact location.";
  const read = async (input: string) => answer(await locationParse(json('/api/locations/parse', 'POST', { input })));

  it('ADD LOCATION Read (POST /api/locations/parse): a padded pair, typed or in a link, is not exact and says why', async () => {
    for (const input of ['23.5800, 58.4100', '23.580000, 58.410000', 'https://maps.google.com/?q=23.5800,58.4100', 'https://www.google.com/maps/search/23.5800,+58.4100', 'geo:23.580000,58.410000']) {
      const r = await read(input);
      expect(r.status, input).toBe(200);
      // Before: confidence HIGH, needsPin false, no warning.
      expect(r.body.data, input).toMatchObject({ ok: true, lat: 23.58, lng: 58.41, confidence: 'MEDIUM', needsPin: true, warnings: [ZEROS] });
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it.each([
    ['4 decimals, one zero at the end', '23.5850, 58.4105'],
    ['6 decimals', '23.585912, 58.405934'],
    ['6 decimals ending in 00 (5 count)', '23.585900, 58.405900'],
    ["Google's own pin, whose digits are Google's", 'https://www.google.com/maps/place/Seeb/data=!4m4!3m3!8m2!3d23.5850000!4d58.4105000'],
  ])('control, Read: %s still reads exact', async (_what, input) => {
    const r = await read(input);
    expect(r.body.data).toMatchObject({ ok: true, confidence: 'HIGH', needsPin: false, warnings: [] });
  });

  it('PUT /api/customers/:id/location checks again: a padded pair is refused with the reason, however it is sent; a hand pin saves the customer', async () => {
    const before = stored('K1');
    for (const body of [
      { lat: 23.58, lng: 58.41, source: 'MANUAL_LATLNG', input: '23.5800, 58.4100' },
      { lat: 23.58, lng: 58.41, source: 'GOOGLE_MAPS_URL', input: 'https://maps.google.com/?q=23.5800,58.4100' },
      { input: '23.5800, 58.4100' },
      // A "hand pin" exactly on the padded pair was never moved.
      { lat: 23.58, lng: 58.41, source: 'MAP_PIN', input: '23.580000, 58.410000' },
    ]) {
      const r = await put('K1', body);
      // Before: 200, stored as the reading, verified HIGH (the "hand pin" too).
      expect(r.status, JSON.stringify(body)).toBe(422);
      expect(r.body.error, JSON.stringify(body)).toMatchObject({ code: 'PIN_REQUIRED', message: ZEROS_PIN });
    }
    expect(stored('K1')).toEqual(before);
    expect(audits).toEqual([]);
    const pinned = await put('K1', { lat: 23.580123, lng: 58.410456, source: 'MAP_PIN', input: '23.5800, 58.4100' });
    expect(pinned.status).toBe(200);
    expect(stored('K1')).toEqual({ lat: 23.580123, lng: 58.410456, verified: true, source: 'MAP_PIN', confidence: 'HIGH', input: '23.5800, 58.4100' });
  });

  it.each([
    ['4 decimals, one zero at the end', '23.5850, 58.4105', 23.585, 58.4105],
    ['6 decimals', '23.585912, 58.405934', 23.585912, 58.405934],
    ['6 decimals ending in 00 (5 count)', '23.585900, 58.405900', 23.5859, 58.4059],
  ])('control, PUT: %s is saved as read (HIGH)', async (_what, input, lat, lng) => {
    const r = await put('MED', { lat, lng, source: 'MANUAL_LATLNG', input });
    expect(r.status).toBe(200);
    expect(stored('MED')).toEqual({ lat, lng, verified: true, source: 'MANUAL_LATLNG', confidence: 'HIGH', input });
  });
});

describe('PUT /api/customers/:id/location: hand pins and the saved point', () => {
  it('a pin placed by hand is saved: MAP_PIN, HIGH, verified', async () => {
    const r = await put('MED', { lat: 23.6011, lng: 58.4011, source: 'MAP_PIN', input: '23.58, 58.40' });
    expect(r.status).toBe(200);
    expect(stored('MED')).toEqual({ lat: 23.6011, lng: 58.4011, verified: true, source: 'MAP_PIN', confidence: 'HIGH', input: '23.58, 58.40' });
    expect(audits[0]!.afterJson).toMatchObject({ check: 'HAND_PIN', confidence: 'HIGH' });
    expect((await put('NONE', { lat: 23.6022, lng: 58.4022, source: 'MAP_PIN' })).status).toBe(200);
    expect(stored('NONE')).toMatchObject({ source: 'MAP_PIN', input: 'map pin', confidence: 'HIGH', verified: true });
  });

  it('a "hand pin" exactly on a reading that needs a pin was not moved: 422 PIN_REQUIRED', async () => {
    const r = await put('K1', { lat: 23.58, lng: 58.4, source: 'MAP_PIN', input: '23.58, 58.40' });
    expect(r.status).toBe(422);
    expect(r.body.error.code).toBe('PIN_REQUIRED');
  });

  it.each([
    ['a MEDIUM import', 'MED'],
    ['a LOW reading', 'LOW'],
  ])("the customer's saved point sent back unchanged is not confirmed when it is not exact: %s", async (_what, id) => {
    const before = stored(id);
    const r = await put(id, { lat: before.lat, lng: before.lng, source: 'MAP_PIN' });
    // Before: saved as a hand pin, verified HIGH, although nobody placed it.
    expect(r.status).toBe(422);
    expect(r.body.error).toMatchObject({ code: 'PIN_REQUIRED', message: SAVED_NOT_EXACT_MESSAGE });
    expect(stored(id)).toEqual(before);
  });

  it.each([
    ['outside the delivery area', 'AWAY', SAVED_OUTSIDE_AREA_MESSAGE],
    ['with latitude and longitude swapped', 'SWAP', SAVED_SWAPPED_MESSAGE],
  ])('a saved HIGH point %s, never confirmed, is refused with that reason, also with "confirm"', async (_what, id, message) => {
    const before = stored(id);
    for (const confirmOutsideArea of [undefined, true]) {
      const r = await put(id, { lat: before.lat, lng: before.lng, source: 'MAP_PIN', confirmOutsideArea });
      // Before: 422 PIN_REQUIRED "This saved location is not exact" - the wrong reason.
      expect(r.status).toBe(422);
      expect(r.body.error).toMatchObject({ code: 'PIN_REQUIRED', message });
    }
    expect(stored(id)).toEqual(before);
    // A pin placed by hand is the way out.
    if (id === 'AWAY') {
      // The customer really is abroad: the moved pin is asked about ("Confirm & save"), then saved.
      const moved = { lat: before.lat + 0.0001, lng: before.lng + 0.0001, source: 'MAP_PIN' };
      expect((await put(id, moved)).body.error).toMatchObject({ code: 'OUTSIDE_AREA' });
      expect((await put(id, { ...moved, confirmOutsideArea: true })).status).toBe(200);
    } else {
      expect((await put(id, { lat: 23.5859, lng: 58.4059, source: 'MAP_PIN' })).status).toBe(200);
    }
    expect(stored(id)).toMatchObject({ verified: true, source: 'MAP_PIN', confidence: 'HIGH' });
  });

  it('a saved HIGH point whose stored number ends in 0 is exact: confirmed as it is', async () => {
    // Stored as 23.585, 58.4 (the text it came from is not kept; the stored number cannot say how many
    // decimals it was written with, so its digits are never counted).
    const r = await put('ZERO', { lat: 23.585, lng: 58.4, source: 'MAP_PIN' });
    // Before: 422 PIN_REQUIRED, the stored number read again as text had "fewer than 4 decimals".
    expect(r.status).toBe(200);
    expect(stored('ZERO')).toMatchObject({ lat: 23.585, lng: 58.4, verified: true, source: 'IMPORT', confidence: 'HIGH' });
    expect(audits[0]!.afterJson).toMatchObject({ check: 'SAVED_POINT' });
  });

  it('an exact saved point is confirmed as it is, keeping where it came from; a verified one stays verified', async () => {
    const r = await put('K1', { lat: 23.5859, lng: 58.4059, source: 'MAP_PIN' });
    expect(r.status).toBe(200);
    expect(stored('K1')).toMatchObject({ lat: 23.5859, lng: 58.4059, verified: true, source: 'IMPORT', confidence: 'HIGH' });
    expect(audits[0]!.afterJson).toMatchObject({ check: 'SAVED_POINT' });
    expect((await put('OK', { lat: 23.5859, lng: 58.4059, source: 'MAP_PIN' })).status).toBe(200);
    expect(stored('OK')).toMatchObject({ verified: true, source: 'MAP_PIN', confidence: 'HIGH', input: 'map pin' });
  });
});

describe('PATCH /api/customers/:id never changes a location', () => {
  it('coordinates are refused (400 USE_SET_LOCATION) and nothing is written', async () => {
    const before = stored('MED');
    for (const body of [{ lat: 23.6, lng: 58.4 }, { lat: 23.6 }, { lng: 58.4 }, { lat: 58.4059, lng: 23.5859, name: 'Renamed' }]) {
      const r = await answer(await customerPatch(json('/api/customers/MED', 'PATCH', body), { params: { id: 'MED' } }));
      // Before: 200, stored as verified HIGH with no check at all.
      expect(r.status, JSON.stringify(body)).toBe(400);
      expect(r.body.error.code).toBe('USE_SET_LOCATION');
    }
    expect(stored('MED')).toEqual(before);
    expect(row('customer', 'MED').name).toBe('Customer MED');
  });

  it('control: other fields are still saved', async () => {
    const r = await answer(await customerPatch(json('/api/customers/MED', 'PATCH', { name: 'Renamed' }), { params: { id: 'MED' } }));
    expect(r.status).toBe(200);
    expect(row('customer', 'MED').name).toBe('Renamed');
  });
});

describe('POST /api/customers checks coordinates like a Read', () => {
  const create = async (body: Record<string, unknown>) => answer(await customerPost(json('/api/customers', 'POST', { code: 'NEW1', name: 'New', ...body })));
  beforeEach(() => {
    tables.customer = [];
  });

  it.each([
    ['fewer than 4 decimals', { lat: 23.58, lng: 58.4 }],
    ['swapped', { lat: 58.4059, lng: 23.5859 }],
    ['outside the delivery area', { lat: '19.0760', lng: '72.8777' }],
    ['0,0', { lat: 0, lng: 0 }],
  ])('a pair that needs a pin is refused (422 PIN_REQUIRED), nothing created: %s', async (_what, coords) => {
    const r = await create(coords);
    // Before: 201, stored as HIGH.
    expect(r.status).toBe(422);
    expect(r.body.error).toMatchObject({ code: 'PIN_REQUIRED', message: expect.stringMatching(/Create the customer without coordinates, then set its location on the map/) });
    expect(tables.customer).toEqual([]);
  });

  // Owner decision of 28 Sep 2026, "Same rule everywhere": the text as sent is read, and of the zeros
  // at the end only one counts, as in the customer import. This test said "23.5800" has 4 decimals and
  // expected 201, stored HIGH: a rough 23.58 padded to 4 decimals was created as an exact location.
  it.each([
    ['4 decimals ending in 00', { lat: '23.5800', lng: '58.4000' }],
    ['one side only', { lat: '23.5859', lng: '58.4100' }],
    ['6 decimals ending in 0000', { lat: '23.580000', lng: '58.410000' }],
  ])('the text as sent is read, and only one zero at the end counts: %s is refused with the reason (422 PIN_REQUIRED)', async (_what, coords) => {
    const r = await create(coords);
    // Before: 201, stored HIGH.
    expect(r.status).toBe(422);
    expect(r.body.error).toMatchObject({
      code: 'PIN_REQUIRED',
      message: 'This location is not exact. Fewer than 4 decimals (only one zero at the end counts). Create the customer without coordinates, then set its location on the map (Set location on the customer page).',
    });
    expect(tables.customer).toEqual([]);
  });

  it.each([
    ['4 decimals, one zero at the end', { lat: '23.5850', lng: '58.4105' }, 23.585, 58.4105],
    ['6 decimals', { lat: '23.585912', lng: '58.405934' }, 23.585912, 58.405934],
    ['6 decimals ending in 00 (5 count)', { lat: '23.585900', lng: '58.405900' }, 23.5859, 58.4059],
    ['JSON numbers with 4 decimals', { lat: 23.5851, lng: 58.4059 }, 23.5851, 58.4059],
  ])('control: %s is created with its location, HIGH', async (_what, coords, lat, lng) => {
    const r = await create(coords);
    expect(r.status).toBe(201);
    expect(tables.customer![0]).toMatchObject({ lat, lng, geocodeConfidence: 'HIGH' });
  });

  it('one coordinate without the other is refused; none at all is a customer without a location', async () => {
    expect((await create({ lat: '23.5859' })).status).toBe(400);
    const r = await create({});
    expect(r.status).toBe(201);
    expect(tables.customer![0]).toMatchObject({ geocodeConfidence: 'MISSING' });
    expect(tables.customer![0]!.lat).toBeUndefined();
  });
});

describe('the customer page sets a location through ADD LOCATION (the same dialog, route and checks)', () => {
  const props = {
    customer: { id: 'MED', code: 'MED', branchCode: null, name: 'Customer MED', lat: 23.5859, lng: 58.4059, locationVerified: false, geocodeConfidence: 'MEDIUM' },
    center: { lat: 23.58, lng: 58.39 },
    // The company's own delivery area (Settings), as the page loads it.
    serviceArea: { ...DEFAULT_SERVICE_AREA, maxLng: 61 },
    canEdit: true,
  };

  it('Set location opens the location dialog for this customer, with how exact its saved point is', () => {
    const host = new Host(CustomerEditor as any, props);
    host.render();
    const dialog = () => elements(host.tree).find((e) => typeName(e) === 'LocationDialog');
    // Before: a map with typed lat/lng boxes that saved through PATCH, verified HIGH, with no check.
    expect(dialog()).toBeDefined();
    expect(dialog().props.open).toBe(false);
    elements(host.tree).find((e) => e.props?.['data-testid'] === 'set-location').props.onClick();
    host.flush();
    expect(dialog().props.open).toBe(true);
    expect(dialog().props.customer).toEqual({
      customerId: 'MED', code: 'MED', branchCode: null, name: 'Customer MED', lat: 23.5859, lng: 58.4059, locationVerified: false, geocodeConfidence: 'MEDIUM',
    });
    // The company's area, so the dialog judges the saved point as the server does (before: none, the whole world).
    expect(dialog().props.serviceArea).toEqual({ ...DEFAULT_SERVICE_AREA, maxLng: 61 });
    // The map only shows the pin: no element of the page saves anything itself.
    expect(elements(host.tree).some((e) => typeName(e) === 'MapPicker')).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('a viewer sees the pin without the Set location button', () => {
    const host = new Host(CustomerEditor as any, { ...props, canEdit: false });
    host.render();
    expect(elements(host.tree).some((e) => e.props?.['data-testid'] === 'set-location')).toBe(false);
  });

  // A5 third review: a saved point that blocks delivery (an import marked it LOW, or it is outside the
  // area and nobody confirmed it) looked the same as a usable one on the customer page.
  const pageText = (customer: Record<string, unknown>) => {
    const host = new Host(CustomerEditor as any, { ...props, customer: { ...props.customer, ...customer } });
    host.render();
    const blocked = elements(host.tree).find((e) => e.props?.['data-testid'] === 'customer-location-blocked');
    return { line: textOf(elements(host.tree).find((e) => e.props?.['data-testid'] === 'customer-location-text')), blocked: blocked ? textOf(blocked) : null };
  };
  it('a saved point that blocks delivery says so, with what to do', () => {
    // Before: "Pin: 23.585900, 58.405900 (from an import, not confirmed)", the same as a usable HIGH import.
    expect(pageText({ geocodeConfidence: 'LOW' }).blocked).toBe(`${LOW_LOCATION_MESSAGE} Its orders are not planned or sent out until then.`);
    expect(pageText({ geocodeConfidence: 'LOW' }).line).toMatch(/not usable/);
    // Judged with the company's area (maxLng 61 here): 60.5 is inside it, 62 is not.
    expect(pageText({ lng: 62, geocodeConfidence: 'HIGH' }).blocked).toBe(`${OUTSIDE_AREA_LOCATION_MESSAGE} Its orders are not planned or sent out until then.`);
    expect(pageText({ lng: 60.5, geocodeConfidence: 'HIGH' }).blocked).toBeNull();
  });
  it.each([
    ['a HIGH import not confirmed', { geocodeConfidence: 'HIGH' }, 'from an import, not confirmed'],
    ['a MEDIUM import not confirmed', { geocodeConfidence: 'MEDIUM' }, 'from an import, not confirmed'],
    ['a LOW point confirmed by a dispatcher', { geocodeConfidence: 'LOW', locationVerified: true }, 'confirmed by a dispatcher'],
  ])('control: %s shows no block', (_what, customer, line) => {
    const t = pageText(customer);
    expect(t.blocked).toBeNull();
    expect(t.line).toContain(line);
  });
});

describe('the customers list flags saved points that need a pin (A5 third review)', () => {
  const listRow = (id: string, over: Record<string, unknown>) => ({
    ...customer(id, over),
    regionId: null,
    region: null,
    address: null,
    priority: 3,
    avgServiceTimeMin: 10,
    paymentType: 'CREDIT',
  });
  it('a LOW point nobody confirmed, one outside the area and 0,0 are flagged and counted; usable ones and missing ones are not', () => {
    const rows = [
      listRow('LOW', { geocodeConfidence: 'LOW' }),
      listRow('AWAY', { lat: 24.7136, lng: 46.6753 }),
      listRow('ZERO', { lat: 0, lng: 0 }),
      listRow('HIGH', {}),
      listRow('MED', { geocodeConfidence: 'MEDIUM' }),
      listRow('OKLOW', { geocodeConfidence: 'LOW', locationVerified: true }),
      listRow('NONE', { lat: null, lng: null, geocodeConfidence: 'MISSING' }),
    ];
    const host = new Host(CustomersClient as any, { slug: 'acme', initial: rows, regions: [], canEdit: false, serviceArea: DEFAULT_SERVICE_AREA });
    host.render();
    const flagged = elements(host.tree).filter((e) => e.props?.['data-testid'] === 'customer-needs-pin');
    // Before: the coordinates only, with no flag, and the header counted only the missing one.
    expect(flagged.map((e) => e.props['data-customer'])).toEqual(['LOW', 'AWAY', 'ZERO']);
    expect(flagged.map((e) => textOf(e))).toEqual(['needs pin', 'needs pin', 'needs pin']);
    expect(flagged[0]!.props.title).toBe(LOW_LOCATION_MESSAGE);
    const count = elements(host.tree).find((e) => e.props?.['data-testid'] === 'customers-need-pin');
    expect(textOf(count)).toBe('3 need a pin');
    expect(textOf(elements(host.tree).find((e) => e.props?.['data-testid'] === 'customers-missing-location'))).toBe('1 missing geocode');
  });
});
