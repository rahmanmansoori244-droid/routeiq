/**
 * Effective customer attributes (customer > type profile > default) and pre-optimize issues.
 */
import { describe, expect, it } from 'vitest';
import {
  coordStatus,
  customerIssues,
  DEFAULT_PRIORITY_WEIGHTS,
  describeServiceTime,
  describeWindows,
  effectiveAttrs,
  parsePriorityWeights,
  parseServiceArea,
  type CustomerForPlanning,
  type TypeProfileLike,
} from '@/lib/dispatch/customer-attrs';
import { DEFAULT_SERVICE_AREA } from '@/lib/dispatch/location-input';

const DEFAULTS = { serviceTimeMin: 15 };

const C = (over: Partial<CustomerForPlanning> = {}): CustomerForPlanning => ({
  id: 'c1',
  code: 'C001',
  branchCode: null,
  name: 'Lulu Bawshar',
  lat: 23.5859,
  lng: 58.4059,
  priority: 3,
  priorityConfirmed: false,
  avgServiceTimeMin: 0,
  serviceTimeConfirmed: false,
  customerType: 'HYPERMARKET',
  hardWindowStartMin: null,
  hardWindowEndMin: null,
  prefWindowStartMin: null,
  prefWindowEndMin: null,
  locationVerified: true,
  createdFromUpload: false,
  ...over,
});

const HYPER: TypeProfileLike = {
  customerType: 'HYPERMARKET',
  defaultPriority: 1,
  serviceTimeMin: 40,
  hardWindowStartMin: 5 * 60,
  hardWindowEndMin: 11 * 60,
  prefWindowStartMin: 6 * 60,
  prefWindowEndMin: 9 * 60,
};

const EMPTY_PROFILE: TypeProfileLike = {
  customerType: 'GROCERY',
  defaultPriority: null,
  serviceTimeMin: null,
  hardWindowStartMin: null,
  hardWindowEndMin: null,
  prefWindowStartMin: null,
  prefWindowEndMin: null,
};

const PROFILES = new Map([
  ['HYPERMARKET', HYPER],
  ['GROCERY', EMPTY_PROFILE],
]);

describe('effectiveAttrs - priority', () => {
  it('a confirmed customer priority wins over the type default', () => {
    const e = effectiveAttrs(C({ priority: 4, priorityConfirmed: true }), PROFILES, DEFAULTS);
    expect(e.priority).toBe(4);
    expect(e.prioritySource).toBe('CUSTOMER');
  });

  it('an unconfirmed priority is replaced by the type default', () => {
    const e = effectiveAttrs(C({ priority: 3, priorityConfirmed: false }), PROFILES, DEFAULTS);
    expect(e.priority).toBe(1);
    expect(e.prioritySource).toBe('TYPE');
  });

  it('without a type default the (unconfirmed) customer value is kept, marked DEFAULT', () => {
    expect(effectiveAttrs(C({ priority: 3, customerType: 'GROCERY' }), PROFILES, DEFAULTS)).toMatchObject({ priority: 3, prioritySource: 'DEFAULT' });
    expect(effectiveAttrs(C({ priority: 3, customerType: null }), PROFILES, DEFAULTS)).toMatchObject({ priority: 3, prioritySource: 'DEFAULT' });
    expect(effectiveAttrs(C({ priority: 3, customerType: 'UNKNOWN' }), PROFILES, DEFAULTS)).toMatchObject({ priority: 3, prioritySource: 'DEFAULT' });
  });
});

describe('effectiveAttrs - service time', () => {
  it('a confirmed customer service time wins', () => {
    expect(effectiveAttrs(C({ avgServiceTimeMin: 20, serviceTimeConfirmed: true }), PROFILES, DEFAULTS)).toMatchObject({
      serviceMin: 20,
      serviceSource: 'CUSTOMER',
    });
  });

  it('an unconfirmed one is replaced by the type profile', () => {
    expect(effectiveAttrs(C({ avgServiceTimeMin: 20 }), PROFILES, DEFAULTS)).toMatchObject({ serviceMin: 40, serviceSource: 'TYPE' });
  });

  it('without a profile, an unconfirmed customer takes the tenant default (Settings), whatever its stored value (review F21)', () => {
    expect(effectiveAttrs(C({ customerType: null, avgServiceTimeMin: 25 }), PROFILES, DEFAULTS)).toMatchObject({ serviceMin: 15, serviceSource: 'DEFAULT' });
    expect(effectiveAttrs(C({ customerType: null, avgServiceTimeMin: 10 }), PROFILES, { serviceTimeMin: 30 })).toMatchObject({ serviceMin: 30, serviceSource: 'DEFAULT' });
    expect(effectiveAttrs(C({ customerType: null, avgServiceTimeMin: 25, serviceTimeConfirmed: true }), PROFILES, DEFAULTS)).toMatchObject({ serviceMin: 25, serviceSource: 'CUSTOMER' });
    expect(effectiveAttrs(C({ customerType: null, avgServiceTimeMin: 0 }), PROFILES, DEFAULTS)).toMatchObject({ serviceMin: 15, serviceSource: 'DEFAULT' });
    expect(effectiveAttrs(C({ customerType: 'GROCERY', avgServiceTimeMin: 0 }), PROFILES, DEFAULTS)).toMatchObject({ serviceMin: 15, serviceSource: 'DEFAULT' });
  });
});

describe('describeServiceTime - the customer page shows what the planner uses (PR5 review)', () => {
  const show = (c: CustomerForPlanning) => describeServiceTime(c, effectiveAttrs(c, PROFILES, DEFAULTS));

  it("a confirmed time is the customer's own", () => {
    expect(show(C({ customerType: null, avgServiceTimeMin: 45, serviceTimeConfirmed: true }))).toEqual({
      minutes: 45,
      source: "this customer's confirmed time",
      note: null,
    });
  });

  it('the customer type default, named', () => {
    expect(show(C({ avgServiceTimeMin: 40 }))).toMatchObject({ minutes: 40, source: 'customer type default (HYPERMARKET)', note: null });
  });

  it('an unconfirmed stored time the planner does not use is shown as such, with the Settings default in use', () => {
    const d = show(C({ customerType: null, avgServiceTimeMin: 45 }));
    expect(d).toMatchObject({ minutes: 15, source: 'Settings default service time' });
    expect(d.note).toMatch(/stored 45 min was never confirmed, so the planner does not use it/);
    expect(show(C({ customerType: null, avgServiceTimeMin: 15 })).note).toBeNull();
  });
});

describe('effectiveAttrs - receiving windows', () => {
  it('any window set on the customer wins, and is not mixed with the profile', () => {
    const e = effectiveAttrs(C({ hardWindowEndMin: 10 * 60 }), PROFILES, DEFAULTS);
    expect(e).toMatchObject({ windowSource: 'CUSTOMER', hardStart: null, hardEnd: 600, prefStart: null, prefEnd: null });
  });

  it('otherwise the type profile windows apply', () => {
    const e = effectiveAttrs(C(), PROFILES, DEFAULTS);
    expect(e).toMatchObject({ windowSource: 'TYPE', hardStart: 300, hardEnd: 660, prefStart: 360, prefEnd: 540 });
  });

  it('otherwise no window (DEFAULT = any time)', () => {
    for (const customerType of [null, 'GROCERY']) {
      const e = effectiveAttrs(C({ customerType }), PROFILES, DEFAULTS);
      expect(e).toMatchObject({ windowSource: 'DEFAULT', hardStart: null, hardEnd: null, prefStart: null, prefEnd: null });
    }
  });

  it('describeWindows', () => {
    expect(describeWindows(effectiveAttrs(C(), PROFILES, DEFAULTS))).toBe('hard 05:00–11:00, preferred 06:00–09:00');
    expect(describeWindows(effectiveAttrs(C({ hardWindowEndMin: 600 }), PROFILES, DEFAULTS))).toBe('hard 00:00–10:00');
    expect(describeWindows(effectiveAttrs(C({ customerType: null }), PROFILES, DEFAULTS))).toBe('Any time');
  });
});

describe('coordStatus', () => {
  it('classifies coordinates', () => {
    expect(coordStatus(23.5859, 58.4059)).toBe('OK');
    expect(coordStatus(25.2048, 55.2708)).toBe('OK'); // Dubai
    expect(coordStatus(null, 58.4)).toBe('MISSING');
    expect(coordStatus(23.5, null)).toBe('MISSING');
    expect(coordStatus(0, 0)).toBe('INVALID');
    expect(coordStatus(95, 58)).toBe('INVALID');
    expect(coordStatus(23, 200)).toBe('INVALID');
    expect(coordStatus(Number.NaN, 58)).toBe('INVALID');
    expect(coordStatus(51.5, -0.12)).toBe('OUTSIDE_AREA');
    expect(coordStatus(58.4059, 23.5859)).toBe('OUTSIDE_AREA'); // swapped
  });

  it('uses the given service area', () => {
    const area = { minLat: 20, maxLat: 30, minLng: 40, maxLng: 50 };
    expect(coordStatus(24.7, 46.7, area)).toBe('OK');
    expect(coordStatus(23.5859, 58.4059, area)).toBe('OUTSIDE_AREA');
  });
});

describe('customerIssues', () => {
  const issues = (c: CustomerForPlanning) => customerIssues(c, effectiveAttrs(c, PROFILES, DEFAULTS));
  const codes = (c: CustomerForPlanning) => issues(c).map((i) => i.code);
  const blocking = (c: CustomerForPlanning) => issues(c).filter((i) => i.blocking).map((i) => i.code);

  it('a complete, verified customer has no issues', () => {
    expect(issues(C({ priorityConfirmed: true }))).toEqual([]);
  });

  it('missing location is blocking', () => {
    expect(blocking(C({ lat: null, lng: null }))).toEqual(['LOCATION_REQUIRED']);
  });

  it('0,0 and out-of-range locations are blocking', () => {
    expect(blocking(C({ lat: 0, lng: 0 }))).toEqual(['INVALID_LOCATION']);
    expect(blocking(C({ lat: 123, lng: 58 }))).toEqual(['INVALID_LOCATION']);
    // ...even when someone ticked "verified".
    expect(blocking(C({ lat: 0, lng: 0, locationVerified: true }))).toEqual(['INVALID_LOCATION']);
  });

  it('outside the service area and unverified is blocking', () => {
    const list = issues(C({ lat: 51.5, lng: -0.12, locationVerified: false }));
    expect(list.filter((i) => i.blocking).map((i) => i.code)).toEqual(['INVALID_LOCATION']);
    expect(list[0].message).toMatch(/outside Oman\/UAE/);
  });

  it('outside the service area but verified by a dispatcher is accepted', () => {
    expect(codes(C({ lat: 51.5, lng: -0.12, locationVerified: true, priorityConfirmed: true }))).toEqual([]);
  });

  it('an unverified in-area location is a non-blocking warning', () => {
    const list = issues(C({ locationVerified: false, priorityConfirmed: true }));
    expect(list).toEqual([expect.objectContaining({ code: 'LOCATION_UNVERIFIED', blocking: false })]);
  });

  it('new customer, default priority, missing type and missing windows are non-blocking', () => {
    const c = C({ createdFromUpload: true, customerType: null, locationVerified: true });
    const list = issues(c);
    expect(list.map((i) => i.code)).toEqual(['NEW_CUSTOMER', 'PRIORITY_UNCONFIRMED', 'TYPE_MISSING', 'NO_RECEIVING_WINDOW']);
    expect(list.every((i) => !i.blocking)).toBe(true);
    expect(list.find((i) => i.code === 'PRIORITY_UNCONFIRMED')?.message).toMatch(/Priority P3 is a default.*P1 highest, P5 lowest/);
  });

  it('a type default priority is not reported as unconfirmed', () => {
    expect(codes(C())).not.toContain('PRIORITY_UNCONFIRMED');
  });

  it('uses the given service area', () => {
    const area = { minLat: 20, maxLat: 30, minLng: 40, maxLng: 50 };
    const c = C({ locationVerified: false, priorityConfirmed: true });
    expect(customerIssues(c, effectiveAttrs(c, PROFILES, DEFAULTS), area).map((i) => [i.code, i.blocking])).toEqual([['INVALID_LOCATION', true]]);
  });
});

describe('parsePriorityWeights', () => {
  it('accepts a strictly decreasing P1..P5 table (JSON string keys)', () => {
    expect(parsePriorityWeights({ '1': 500, '2': 200, '3': 50, '4': 5, '5': 1 })).toEqual({ 1: 500, 2: 200, 3: 50, 4: 5, 5: 1 });
    expect(parsePriorityWeights({ 1: '90', 2: '40', 3: '20', 4: '10', 5: '1' })).toEqual({ 1: 90, 2: 40, 3: 20, 4: 10, 5: 1 });
  });

  it('falls back to defaults for missing, inverted, flat, incomplete or non-positive tables', () => {
    for (const bad of [
      null,
      undefined,
      {},
      { 1: 1, 2: 10, 3: 100, 4: 1000, 5: 10000 }, // inverted: P5 would beat P1
      { 1: 100, 2: 100, 3: 50, 4: 10, 5: 1 }, // not strictly decreasing
      { 1: 100, 2: 50 }, // incomplete
      { 1: 100, 2: 50, 3: 20, 4: 10, 5: 0 },
      { 1: 100, 2: 50, 3: 20, 4: 10, 5: -1 },
      { 1: 'high', 2: 50, 3: 20, 4: 10, 5: 1 },
    ]) {
      expect(parsePriorityWeights(bad), JSON.stringify(bad)).toEqual(DEFAULT_PRIORITY_WEIGHTS);
    }
  });

  it('the defaults make P1 the highest', () => {
    for (let p = 1; p < 5; p++) expect(DEFAULT_PRIORITY_WEIGHTS[p]).toBeGreaterThan(DEFAULT_PRIORITY_WEIGHTS[p + 1]);
  });
});

describe('parseServiceArea', () => {
  it('accepts a complete numeric box', () => {
    const a = { minLat: 20, maxLat: 30, minLng: 40, maxLng: 50 };
    expect(parseServiceArea(a)).toEqual(a);
  });

  it('falls back to Oman/UAE for anything else', () => {
    for (const bad of [null, undefined, {}, { minLat: 20, maxLat: 30, minLng: 40 }, { minLat: '20', maxLat: 30, minLng: 40, maxLng: 50 }, 'x']) {
      expect(parseServiceArea(bad), JSON.stringify(bad)).toEqual(DEFAULT_SERVICE_AREA);
    }
  });
});
