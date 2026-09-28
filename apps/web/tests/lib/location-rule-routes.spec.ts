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
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetDb, row, tables } from './fake-plan-db';
import { Host, elements, typeName } from './hook-host';

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
import { PATCH as customerPatch } from '@/app/api/customers/[id]/route';
import { POST as customerPost } from '@/app/api/customers/route';
import { DEFAULT_SERVICE_AREA, PIN_REQUIRED_MESSAGE, SAVED_NOT_EXACT_MESSAGE, SAVED_OUTSIDE_AREA_MESSAGE, SAVED_SWAPPED_MESSAGE } from '@/lib/dispatch/location-input';
import { CustomerEditor } from '@/app/t/[slug]/customers/[id]/customer-editor';

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
    customer('ZERO', { lat: 23.585, lng: 58.4 }), // stored HIGH from "23.5850, 58.4000": the number drops the zeros
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
    // "23.5850, 58.4000" was accepted as exact (4 decimals) and stored as 23.585, 58.4.
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

  it('the text as sent is read: "23.5800" has 4 decimals; stored HIGH', async () => {
    const r = await create({ lat: '23.5800', lng: '58.4000' });
    expect(r.status).toBe(201);
    expect(tables.customer![0]).toMatchObject({ lat: 23.58, lng: 58.4, geocodeConfidence: 'HIGH' });
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
});
