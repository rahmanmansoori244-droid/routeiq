/**
 * Audit PR A5, the owner's location rule (27 Sep 2026): "its a standing rule locations should
 * always be correct as part of sop no item will be delivered without location". Enforced, not
 * reported:
 *
 *  - L2 (server): a save that is not a pin placed by hand is read again with the same parser, with
 *    no network call (a short link through the address the Read found, `resolvedUrl`), and refused
 *    when that reading needs a pin or cannot be read (PIN_REQUIRED) or is not the point sent
 *    (LOCATION_MISMATCH); the source and confidence stored are the parser's;
 *  - L4 (planning): a saved location that is LOW and never confirmed is treated like an invalid one:
 *    blocking on the day screen, and its orders are left unserved with a reason that says to drop
 *    the pin. Confirmed locations and HIGH / MEDIUM imports not confirmed yet are planned as before.
 *
 * The routes, the customer page and the legacy run dispatch are in location-rule-routes.spec.ts and
 * (real PostgreSQL) tests/integration/location-rule-db.spec.ts; the dialog in
 * dispatch-location-dialog.spec.ts; the customer import in customer-import-locations.spec.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fake = vi.hoisted(() => ({ prisma: {} as Record<string, any>, tdb: {} as Record<string, any> }));
vi.mock('@/lib/db', () => ({ prisma: new Proxy({}, { get: (_t, k: string) => (k === 'then' ? undefined : fake.prisma[k]) }) }));
vi.mock('@/lib/tenant', () => ({ tenantDb: () => fake.tdb }));

import {
  checkManualLocation,
  DEFAULT_SERVICE_AREA,
  LOCATION_MISMATCH_MESSAGE,
  PIN_REQUIRED_MESSAGE,
  pinRequiredMessage,
  rereadSavedInput,
  samePoint,
  SAVED_NOT_EXACT_MESSAGE,
  SAVED_OUTSIDE_AREA_MESSAGE,
  SAVED_SWAPPED_MESSAGE,
} from '@/lib/dispatch/location-input';
import {
  customerIssues,
  effectiveAttrs,
  isUnverifiedLowLocation,
  locationBlocksDelivery,
  LOW_LOCATION_MESSAGE,
  OUTSIDE_AREA_LOCATION_MESSAGE,
  savedPointProblem,
  WHOLE_WORLD,
  type CustomerForPlanning,
} from '@/lib/dispatch/customer-attrs';
import { buildDispatchRequest } from '@/lib/dispatch/plan-service';

const fetchSpy = vi.fn(async () => {
  throw new Error('no network call is allowed when a location is saved');
});
beforeEach(() => {
  fetchSpy.mockClear();
  vi.stubGlobal('fetch', fetchSpy);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------------------------
// L2: the server reads the saved text again
// ---------------------------------------------------------------------------------------------

describe('checkManualLocation: a save that is not a hand pin is read again (L2)', () => {
  const check = (input: string | null, lat: number, lng: number, resolvedUrl?: string) => checkManualLocation({ input, lat, lng, resolvedUrl, area: DEFAULT_SERVICE_AREA });

  it.each([
    ['fewer than 4 decimals (MEDIUM)', '23.58, 58.40', 23.58, 58.4],
    ['degrees and minutes only (MEDIUM)', `23°35'N 58°24'E`, 23.583333, 58.4],
    ['whole degrees (LOW)', '23°N 58°E', 23, 58],
    ['swapped (MEDIUM)', '58.4059, 23.5859', 23.5859, 58.4059],
    ['outside the delivery area (LOW)', '19.0760, 72.8777', 19.076, 72.8777],
    ['the map centre only (MEDIUM)', 'https://www.google.com/maps/@23.5859,58.4059,17z', 23.5859, 58.4059],
  ])('a reading that needs a pin is refused: %s', (_what, input, lat, lng) => {
    const r = check(input, lat, lng);
    expect(r).toMatchObject({ ok: false, code: 'PIN_REQUIRED', message: PIN_REQUIRED_MESSAGE });
    expect(r.ok === false && r.parse?.needsPin).toBe(true);
  });

  it('text that cannot be read, or no text at all, is refused with what to do', () => {
    const place = check('https://www.google.com/maps/place/Lulu+Hypermarket', 23.5859, 58.4059);
    expect(place).toMatchObject({ ok: false, code: 'PIN_REQUIRED', message: expect.stringMatching(/only names a place/) });
    expect(check(`23°99'00"N 58°24'00"E`, 23.5859, 58.4059)).toMatchObject({
      ok: false,
      code: 'PIN_REQUIRED',
      message: "Latitude: minutes must be 0 to 59 (got 99'). Drop the pin on the customer's exact location, then save.",
    });
    for (const none of [null, '', '   ']) {
      expect(check(none, 23.5859, 58.4059)).toMatchObject({ ok: false, code: 'PIN_REQUIRED', message: expect.stringMatching(/press Read, or drop the pin/) });
    }
  });

  it('a point that is not the point the text reads as is refused (LOCATION_MISMATCH), to the 6th decimal', () => {
    expect(check('23.585912, 58.405912', 23.585913, 58.405912)).toMatchObject({ ok: false, code: 'LOCATION_MISMATCH', message: LOCATION_MISMATCH_MESSAGE });
    expect(check('23.5859, 58.4059', 23.6859, 58.4059)).toMatchObject({ ok: false, code: 'LOCATION_MISMATCH' });
    expect(check('23.585912, 58.405912', 23.585912, 58.405912)).toMatchObject({ ok: true });
  });

  it("an exact reading is accepted with the parser's source and confidence, never the client's", () => {
    expect(check('23.5859, 58.4059', 23.5859, 58.4059)).toEqual({ ok: true, lat: 23.5859, lng: 58.4059, source: 'MANUAL_LATLNG', confidence: 'HIGH' });
    expect(check('https://www.google.com/maps/place/X/data=!3d23.6703!4d58.1889', 23.6703, 58.1889)).toEqual({
      ok: true, lat: 23.6703, lng: 58.1889, source: 'GOOGLE_MAPS_URL', confidence: 'HIGH',
    });
  });

  it('a short link is read from the address the Read found, without opening it', () => {
    const link = 'https://maps.app.goo.gl/AbCdEf';
    const pinUrl = 'https://www.google.com/maps/place/Seeb/data=!3d23.6703!4d58.1889';
    expect(check(link, 23.6703, 58.1889, pinUrl)).toMatchObject({ ok: true, source: 'GOOGLE_MAPS_URL', confidence: 'HIGH' });
    expect(check('maps.app.goo.gl/AbCdEf', 23.6703, 58.1889, pinUrl)).toMatchObject({ ok: true });
    // The address found only gives the map centre: needs a pin.
    expect(check(link, 23.6703, 58.1889, 'https://www.google.com/maps/@23.6703,58.1889,17z')).toMatchObject({ ok: false, code: 'PIN_REQUIRED' });
    // No address, or one that is not a full Google Maps address: not read here.
    for (const bad of [undefined, 'https://maps.app.goo.gl/other', 'https://evil.example/maps/place/data=!3d23.6703!4d58.1889', 'javascript:alert(1)', 'not a url']) {
      expect(check(link, 23.6703, 58.1889, bad)).toMatchObject({ ok: false, code: 'PIN_REQUIRED', message: expect.stringMatching(/Press Read again, or drop the pin/) });
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('helpers: samePoint to the 6th decimal; a refusal always says to drop the pin, once', () => {
    expect(samePoint({ lat: 23.123456, lng: 58.1 }, { lat: 23.123456, lng: 58.1 })).toBe(true);
    expect(samePoint({ lat: 23.123456, lng: 58.1 }, { lat: 23.123457, lng: 58.1 })).toBe(false);
    expect(pinRequiredMessage({ ok: true })).toBe(PIN_REQUIRED_MESSAGE);
    expect(pinRequiredMessage({ ok: false, error: 'Google returned a consent page instead of the location. Drop a pin instead.' })).toBe(
      'Google returned a consent page instead of the location. Drop a pin instead.',
    );
    expect(rereadSavedInput('23.5859, 58.4059', undefined)).toMatchObject({ ok: true, needsPin: false });
  });
});

// ---------------------------------------------------------------------------------------------
// L1/L2: the customer's saved point, saved again as it is (the dialog opens on it)
// ---------------------------------------------------------------------------------------------

describe('savedPointProblem: when the saved point may be confirmed as it is (dialog and server share it)', () => {
  const saved = (lat: number, lng: number, over: { locationVerified?: boolean; geocodeConfidence?: string | null } = {}) => ({
    lat, lng, locationVerified: false, geocodeConfidence: 'HIGH' as string | null, ...over,
  });

  it.each([
    ['4 decimals, the last one 0 (23.5850 is stored as 23.585)', saved(23.585, 58.4059)],
    ['4 decimals, both ending in 0 (23.5800, 58.4000)', saved(23.58, 58.4)],
    ['6 decimals ending in 0 (58.405900)', saved(23.585012, 58.4059)],
    ['an exact 4-decimal point', saved(23.5851, 58.4059)],
  ])('a HIGH point is exact whatever digits the stored number shows: %s', (_what, c) => {
    // Before: the stored number was read again as text, "23.585" has 3 decimals: "not exact" (about 1 in 5 NMWC points).
    expect(savedPointProblem(c, DEFAULT_SERVICE_AREA)).toBeNull();
  });

  it('a HIGH point outside the delivery area, never confirmed, needs the pin, and says why', () => {
    expect(savedPointProblem(saved(24.7136, 46.6753), DEFAULT_SERVICE_AREA)).toBe(SAVED_OUTSIDE_AREA_MESSAGE);
    expect(SAVED_OUTSIDE_AREA_MESSAGE).toBe("This saved location is outside the delivery area and was never confirmed. Drop the pin on the customer's exact location, then save.");
    // Swapped latitude and longitude (a file with the columns the wrong way round).
    expect(savedPointProblem(saved(58.4059, 23.5859), DEFAULT_SERVICE_AREA)).toBe(SAVED_SWAPPED_MESSAGE);
    expect(SAVED_SWAPPED_MESSAGE).toBe("This saved location has latitude and longitude swapped. Drop the pin on the customer's exact location, then save.");
    // A company with no area check (outside Oman/UAE): the same point is inside.
    expect(savedPointProblem(saved(24.7136, 46.6753), WHOLE_WORLD)).toBeNull();
  });

  it.each([
    ['MEDIUM', { geocodeConfidence: 'MEDIUM' }],
    ['LOW', { geocodeConfidence: 'LOW' }],
    ['of unknown quality', { geocodeConfidence: null }],
  ])('a point that is not HIGH (%s) and never confirmed needs the pin', (_what, over) => {
    expect(savedPointProblem(saved(23.5859, 58.4059, over), DEFAULT_SERVICE_AREA)).toBe(SAVED_NOT_EXACT_MESSAGE);
  });

  it('a point a dispatcher confirmed may be confirmed again (outside the area, the save still asks "Confirm & save")', () => {
    expect(savedPointProblem(saved(24.7136, 46.6753, { locationVerified: true, geocodeConfidence: 'LOW' }), DEFAULT_SERVICE_AREA)).toBeNull();
    expect(savedPointProblem(saved(23.5859, 58.4059, { locationVerified: true, geocodeConfidence: 'MEDIUM' }), DEFAULT_SERVICE_AREA)).toBeNull();
  });

  it('the day card of a point outside the area never confirmed says to drop the pin (it said "Confirm", which the dialog refuses)', () => {
    const c = C({ lat: 24.7136, lng: 46.6753 });
    expect(issuesOf(c).find((i) => i.blocking)).toEqual({ code: 'INVALID_LOCATION', blocking: true, message: OUTSIDE_AREA_LOCATION_MESSAGE });
    expect(OUTSIDE_AREA_LOCATION_MESSAGE).toBe("Saved location is outside Oman/UAE and was never confirmed. Drop the pin on the customer's exact location.");
  });
});

// ---------------------------------------------------------------------------------------------
// L4: a LOW location never confirmed is not planned
// ---------------------------------------------------------------------------------------------

const C = (over: Partial<CustomerForPlanning> & Record<string, unknown> = {}) => ({
  id: 'c1', code: 'C1', branchCode: null, name: 'C1', lat: 23.5859, lng: 58.4059, priority: 3, priorityConfirmed: true, avgServiceTimeMin: 10,
  serviceTimeConfirmed: true, customerType: 'GROCERY', hardWindowStartMin: null, hardWindowEndMin: null, prefWindowStartMin: null, prefWindowEndMin: null,
  locationVerified: false, createdFromUpload: false, geocodeConfidence: 'HIGH' as string | null, active: true, ...over,
});
const issuesOf = (c: CustomerForPlanning) => customerIssues(c, effectiveAttrs(c, new Map(), { serviceTimeMin: 10 }));

describe('customerIssues and locationBlocksDelivery: LOW and never confirmed blocks (L4)', () => {
  it('an unverified LOW location is blocking INVALID_LOCATION, with the words to drop the pin', () => {
    const c = C({ geocodeConfidence: 'LOW' });
    expect(isUnverifiedLowLocation(c)).toBe(true);
    expect(locationBlocksDelivery(c)).toBe(true);
    const loc = issuesOf(c).filter((i) => i.code === 'INVALID_LOCATION' || i.code === 'LOCATION_UNVERIFIED');
    expect(loc).toEqual([{ code: 'INVALID_LOCATION', blocking: true, message: LOW_LOCATION_MESSAGE }]);
    expect(LOW_LOCATION_MESSAGE).toBe("Saved location is not exact (low confidence). Drop the pin on the customer's exact location.");
  });

  it.each([
    ['LOW, confirmed by a dispatcher', { geocodeConfidence: 'LOW', locationVerified: true }, null],
    ['MEDIUM import, not confirmed', { geocodeConfidence: 'MEDIUM' }, 'LOCATION_UNVERIFIED'],
    ['HIGH import, not confirmed', { geocodeConfidence: 'HIGH' }, 'LOCATION_UNVERIFIED'],
    ['quality unknown (null), not confirmed', { geocodeConfidence: null }, 'LOCATION_UNVERIFIED'],
    ['quality not given (older callers)', { geocodeConfidence: undefined }, 'LOCATION_UNVERIFIED'],
  ])('control: %s is planned as before', (_what, over, note) => {
    const c = C(over as never);
    expect(locationBlocksDelivery(c)).toBe(false);
    const loc = issuesOf(c).filter((i) => i.code === 'INVALID_LOCATION' || i.code === 'LOCATION_UNVERIFIED' || i.code === 'LOCATION_REQUIRED');
    expect(loc.map((i) => [i.code, i.blocking])).toEqual(note ? [[note, false]] : []);
  });

  it('locationBlocksDelivery is exactly "has a blocking location issue", over every case', () => {
    const cases = [
      C(), C({ lat: null, lng: null }), C({ lat: 0, lng: 0 }), C({ lat: 19.07, lng: 72.87 }), C({ lat: 19.07, lng: 72.87, locationVerified: true }),
      C({ geocodeConfidence: 'LOW' }), C({ geocodeConfidence: 'LOW', locationVerified: true }), C({ geocodeConfidence: 'MEDIUM' }), C({ locationVerified: true }),
      C({ lat: 0, lng: 0, locationVerified: true, geocodeConfidence: 'LOW' }),
    ];
    for (const c of cases) {
      const blocking = issuesOf(c).some((i) => i.blocking && (i.code === 'LOCATION_REQUIRED' || i.code === 'INVALID_LOCATION'));
      expect(locationBlocksDelivery(c), JSON.stringify(c)).toBe(blocking);
    }
  });
});

describe('buildDispatchRequest: an unverified LOW location is never sent to the optimizer (L4)', () => {
  const cfg = {
    avgSpeedKmh: 40, distanceProvider: 'HAVERSINE', distanceMultiplier: 1.3, driverShiftMaxMinutes: 660, shiftStartMin: 360, reloadMinutes: 30,
    loadingMinPerCase: 0.04, serviceMinPerCase: 0.05, maxTripsPerTruck: 3, splitDeliveries: true, defaultServiceTimeMin: 10, timezone: 'Asia/Muscat',
    planningCutoffMin: 1080, fuelPricePerLitre: 0.26, driverCostPerHour: 2.5, overtimeAfterMin: 540, overtimeCostPerHour: 4, prefWindowPenaltyPerMin: 0.05,
    roadTimeFactor: 1.25, osrmUrl: null, priorityWeightsJson: null, orderColumnMapJson: null, dateOrder: 'DMY', serviceAreaJson: null,
  };
  const order = (id: string, cust: ReturnType<typeof C>) => ({
    id, customerId: cust.id, customer: cust, totalCases: 10, totalWeightKg: 100, priority: 3, priorityFromFile: false, isLate: false, salesValue: null, marginValue: null,
    status: 'NEW', lines: [{ id: `${id}-l1`, cases: 10, weightKg: 100, weightFromMaster: false, salesValue: null, marginValue: null, product: { code: 'P', name: 'P', weightPerCaseKg: 10, active: true } }],
  });
  function wire(orders: unknown[]) {
    fake.tdb.runPlan = { findUniqueOrThrow: async () => ({ id: 'R1', depotId: 'D1', runDate: new Date('2026-09-29T00:00:00Z'), parentRunId: null, reason: 'INITIAL', depot: { id: 'D1', lat: 23.58, lng: 58.38, openMin: null, closeMin: null } }) };
    fake.tdb.tenantConfig = { findUniqueOrThrow: async () => ({ ...cfg }) };
    fake.tdb.customerTypeProfile = { findMany: async () => [] };
    fake.tdb.planLoad = { findMany: async () => [] };
    fake.tdb.truck = { findMany: async () => [{ id: 'T1', code: 'T1', capacityCases: 1000, capacityWeightKg: 10000, fixedCostPerDay: 20, tripCost: 0, costPerKm: 0.15, kmPerLitre: null, availableFromMin: null, availableToMin: null, maxTripsPerDay: null }] };
    fake.prisma.tenant = { findUniqueOrThrow: async () => ({ country: 'Oman' }) };
    fake.prisma.depot = { count: async () => 1 };
    fake.prisma.order = { findMany: async () => orders };
    fake.prisma.routeAssignment = { findMany: async () => [] };
  }

  it('its orders are left unserved (INVALID_LOCATION, "drop the pin") and it is blocking; the others are planned', async () => {
    const low = C({ id: 'LOW1', code: 'LOW1', geocodeConfidence: 'LOW' });
    const lowOk = C({ id: 'LOW2', code: 'LOW2', geocodeConfidence: 'LOW', locationVerified: true, lat: 23.6, lng: 58.41 });
    const medium = C({ id: 'MED1', code: 'MED1', geocodeConfidence: 'MEDIUM', lat: 23.61, lng: 58.42 });
    const high = C({ id: 'HI1', code: 'HI1', geocodeConfidence: 'HIGH', lat: 23.62, lng: 58.43 });
    wire([order('O1', low), order('O2', lowOk), order('O3', medium), order('O4', high)]);
    const b = await buildDispatchRequest('TEN', 'R1');
    expect(b.request.stops.map((s) => s.customer_id).sort()).toEqual(['HI1', 'LOW2', 'MED1']);
    expect(b.preDrops).toEqual([{ orderId: 'O1', reasonCode: 'INVALID_LOCATION', message: LOW_LOCATION_MESSAGE, portion: undefined }]);
    expect(b.blocking).toEqual([
      { customerId: 'LOW1', customerCode: 'LOW1', branchCode: null, customerName: 'C1', code: 'INVALID_LOCATION', message: LOW_LOCATION_MESSAGE, orderIds: ['O1'], cases: 10 },
    ]);
    // In the scope (left unserved with its reason), not lost.
    expect(b.scope.orderIds).toContain('O1');
  });
});
