/**
 * Zod schema unit tests — CLAUDE.md §13.
 * Pure-function tests, no DB or HTTP.
 */
import { describe, expect, it } from 'vitest';
import {
  depotSchema,
  truckSchema,
  driverSchema,
  regionSchema,
  productSchema,
  customerSchema,
  tenantConfigSchema,
  tenantSettingsSchema,
  userInviteSchema,
  normalizeBranchKey,
  isRealIsoDate,
  isoDateSchema,
  MAX_SERVICE_MIN,
} from '@/lib/schemas';

describe('normalizeBranchKey', () => {
  it('returns __MAIN__ for null', () => {
    expect(normalizeBranchKey(null)).toBe('__MAIN__');
  });
  it('returns __MAIN__ for undefined', () => {
    expect(normalizeBranchKey(undefined)).toBe('__MAIN__');
  });
  it('returns __MAIN__ for empty string', () => {
    expect(normalizeBranchKey('')).toBe('__MAIN__');
  });
  it('returns __MAIN__ for whitespace-only', () => {
    expect(normalizeBranchKey('   ')).toBe('__MAIN__');
  });
  it('returns the trimmed branch code for real values', () => {
    expect(normalizeBranchKey(' B1 ')).toBe('B1');
    expect(normalizeBranchKey('NORTH-WING')).toBe('NORTH-WING');
  });
});

describe('depotSchema', () => {
  const valid = { code: 'D1', name: 'Main depot', lat: 23.5859, lng: 58.4059 };

  it('accepts a minimal valid depot', () => {
    expect(depotSchema.safeParse(valid).success).toBe(true);
  });
  it('rejects empty code', () => {
    expect(depotSchema.safeParse({ ...valid, code: '' }).success).toBe(false);
  });
  it('rejects code with invalid chars', () => {
    expect(depotSchema.safeParse({ ...valid, code: 'has space' }).success).toBe(false);
    expect(depotSchema.safeParse({ ...valid, code: 'has/slash' }).success).toBe(false);
  });
  it('rejects out-of-range lat', () => {
    expect(depotSchema.safeParse({ ...valid, lat: 91 }).success).toBe(false);
    expect(depotSchema.safeParse({ ...valid, lat: -91 }).success).toBe(false);
  });
  it('rejects out-of-range lng', () => {
    expect(depotSchema.safeParse({ ...valid, lng: 181 }).success).toBe(false);
    expect(depotSchema.safeParse({ ...valid, lng: -181 }).success).toBe(false);
  });
  it('coerces string lat/lng to number', () => {
    const result = depotSchema.safeParse({ ...valid, lat: '23.5859', lng: '58.4059' } as never);
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.lat).toBe(23.5859);
  });
});

describe('truckSchema', () => {
  const valid = {
    code: 'T-101',
    depotId: 'depot-123',
    capacityCases: 200,
    capacityWeightKg: 3000,
    capacityVolumeL: 8000,
    fixedCostPerDay: 25,
    costPerKm: 0.18,
  };
  it('accepts a valid truck', () => {
    expect(truckSchema.safeParse(valid).success).toBe(true);
  });
  it('requires positive capacities', () => {
    expect(truckSchema.safeParse({ ...valid, capacityCases: -1 }).success).toBe(false);
  });
  it('caps capacity at 100k cases', () => {
    expect(truckSchema.safeParse({ ...valid, capacityCases: 100_001 }).success).toBe(false);
  });
  it('requires depotId', () => {
    expect(truckSchema.safeParse({ ...valid, depotId: '' }).success).toBe(false);
  });
  it('takes an optional default driver; blank or null clears it', () => {
    expect(truckSchema.parse({ ...valid, defaultDriverId: 'drv-1' }).defaultDriverId).toBe('drv-1');
    expect(truckSchema.parse({ ...valid, defaultDriverId: '' }).defaultDriverId).toBeNull();
    expect(truckSchema.parse({ ...valid, defaultDriverId: null }).defaultDriverId).toBeNull();
    expect('defaultDriverId' in truckSchema.parse(valid)).toBe(false);
  });
});

describe('driverSchema', () => {
  it('accepts valid phone formats', () => {
    expect(driverSchema.safeParse({ code: 'D1', name: 'John', phone: '+968 9123 4567' }).success).toBe(true);
    expect(driverSchema.safeParse({ code: 'D1', name: 'John', phone: '(555) 555-5555' }).success).toBe(true);
  });
  it('rejects phone with letters', () => {
    expect(driverSchema.safeParse({ code: 'D1', name: 'John', phone: 'not a phone' }).success).toBe(false);
  });
  it('allows omitted phone', () => {
    expect(driverSchema.safeParse({ code: 'D1', name: 'John' }).success).toBe(true);
  });
});

describe('regionSchema', () => {
  it('accepts empty depotId (downstream normalizes to null)', () => {
    // Schema accepts empty string as a valid value; the API route maps it to
    // null before write. The test guards both behaviors below the schema layer.
    const result = regionSchema.safeParse({ code: 'R1', name: 'Muttrah', depotId: '' });
    expect(result.success).toBe(true);
  });
  it('accepts missing depotId', () => {
    const result = regionSchema.safeParse({ code: 'R1', name: 'Muttrah' });
    expect(result.success).toBe(true);
  });
});

describe('productSchema', () => {
  const valid = { code: 'P1', name: 'Water', weightPerCaseKg: 12, volumePerCaseL: 12 };
  it('accepts valid', () => {
    expect(productSchema.safeParse(valid).success).toBe(true);
  });
  it('rejects negative weight', () => {
    expect(productSchema.safeParse({ ...valid, weightPerCaseKg: -1 }).success).toBe(false);
  });
});

describe('customerSchema', () => {
  const valid = {
    code: 'C1',
    name: 'Test',
    priority: 3,
    avgServiceTimeMin: 10,
    paymentType: 'CREDIT' as const,
  };
  it('accepts valid', () => {
    expect(customerSchema.safeParse(valid).success).toBe(true);
  });
  it('rejects priority out of range', () => {
    expect(customerSchema.safeParse({ ...valid, priority: 0 }).success).toBe(false);
    expect(customerSchema.safeParse({ ...valid, priority: 6 }).success).toBe(false);
  });
  it('rejects unknown payment type', () => {
    expect(customerSchema.safeParse({ ...valid, paymentType: 'BARTER' } as never).success).toBe(false);
  });
  it('accepts empty branchCode (normalizeBranchKey turns it into __MAIN__ at write time)', () => {
    const result = customerSchema.safeParse({ ...valid, branchCode: '' });
    expect(result.success).toBe(true);
  });
  it('accepts optional lat/lng', () => {
    const r1 = customerSchema.safeParse({ ...valid, lat: 23.5, lng: 58.4 });
    const r2 = customerSchema.safeParse(valid);
    expect(r1.success).toBe(true);
    expect(r2.success).toBe(true);
  });
});

describe('tenantConfigSchema', () => {
  // Review F21: exactly the settings the dispatch planner uses.
  const valid = {
    avgSpeedKmh: 40,
    distanceProvider: 'HAVERSINE' as const,
    distanceMultiplier: 1.3,
    driverShiftMaxMinutes: 540,
    overtimeAfterMin: 480,
    shiftStartMin: 450,
    reloadMinutes: 20,
    loadingMinPerCase: 0.04,
    serviceMinPerCase: 0.05,
    maxTripsPerTruck: 3,
    splitDeliveries: true,
    defaultServiceTimeMin: 10,
    planningCutoffMin: 1080,
    dateOrder: 'DMY' as const,
    fuelPricePerLitre: 0.26,
    driverCostPerHour: 2.5,
    overtimeCostPerHour: 4,
    prefWindowPenaltyPerMin: 0.05,
    roadTimeFactor: 1.25,
  };
  it('refuses the old controls that changed nothing (strict), whole or partial', () => {
    for (const k of ['solverTimeLimitSeconds', 'labelEstimatedDistances', 'returnToDepot', 'weightObjectiveTrucks', 'costPerKmDefault']) {
      expect(tenantConfigSchema.safeParse({ ...valid, [k]: 1 }).success, k).toBe(false);
      expect(tenantConfigSchema.partial().safeParse({ [k]: 1 }).success, k).toBe(false);
    }
  });
  it('rejects negative avg speed', () => {
    const result = tenantConfigSchema.safeParse({ avgSpeedKmh: -5 } as never);
    expect(result.success).toBe(false);
  });
  it('accepts a complete valid config', () => {
    expect(tenantConfigSchema.safeParse(valid).success).toBe(true);
  });
  it('dispatch timing: accepts sensible values, rejects out-of-range ones', () => {
    const p = tenantConfigSchema.partial();
    expect(p.safeParse({ shiftStartMin: 0, reloadMinutes: 0, loadingMinPerCase: 0, serviceMinPerCase: 0, maxTripsPerTruck: 1 }).success).toBe(true);
    expect(p.safeParse({ shiftStartMin: 1439, reloadMinutes: 240, loadingMinPerCase: 1, serviceMinPerCase: 1, maxTripsPerTruck: 10 }).success).toBe(true);
    expect(p.safeParse({ shiftStartMin: 1440 }).success).toBe(false);
    expect(p.safeParse({ shiftStartMin: -1 }).success).toBe(false);
    expect(p.safeParse({ shiftStartMin: 450.5 }).success).toBe(false);
    expect(p.safeParse({ reloadMinutes: 241 }).success).toBe(false);
    expect(p.safeParse({ loadingMinPerCase: 1.5 }).success).toBe(false);
    expect(p.safeParse({ serviceMinPerCase: -0.1 }).success).toBe(false);
    expect(p.safeParse({ maxTripsPerTruck: 0 }).success).toBe(false);
    expect(p.safeParse({ maxTripsPerTruck: 11 }).success).toBe(false);
  });
  it('coerces form strings for the timing fields', () => {
    const r = tenantConfigSchema.partial().safeParse({ loadingMinPerCase: '0.04', maxTripsPerTruck: '3' } as never);
    expect(r.success).toBe(true);
    if (r.success) expect(r.data).toEqual({ loadingMinPerCase: 0.04, maxTripsPerTruck: 3 });
  });
  it('a complete config needs the timing fields too', () => {
    const { shiftStartMin: _s, ...withoutStart } = valid;
    expect(tenantConfigSchema.safeParse(withoutStart).success).toBe(false);
    // ... while a PATCH (partial) without them still validates.
    expect(tenantConfigSchema.partial().safeParse(withoutStart).success).toBe(true);
  });
});

describe('tenantSettingsSchema', () => {
  it('rejects too-short currency', () => {
    expect(
      tenantSettingsSchema.safeParse({ name: 'X Co', country: 'Oman', currency: 'Z', primaryUnit: 'CASES' }).success,
    ).toBe(false);
  });
});

describe('userInviteSchema', () => {
  it('rejects invalid email', () => {
    expect(userInviteSchema.safeParse({ email: 'not-an-email', name: 'A', role: 'PLANNER' }).success).toBe(false);
  });
  it('accepts valid invite', () => {
    expect(userInviteSchema.safeParse({ email: 'a@b.co', name: 'Alex', role: 'PLANNER' }).success).toBe(true);
  });
});

describe('isoDateSchema / isRealIsoDate (review L16)', () => {
  it('accepts real calendar dates', () => {
    expect(isRealIsoDate('2026-09-27')).toBe(true);
    expect(isRealIsoDate('2028-02-29')).toBe(true);
    expect(isoDateSchema.safeParse('2026-12-31').success).toBe(true);
  });
  it('rejects dates that would roll into another day or are not dates', () => {
    for (const bad of ['2026-02-31', '2026-13-01', '2026-02-29', '2026-9-27', '27/09/2026', '2026-09-27T00:00:00Z', '']) {
      expect(isRealIsoDate(bad)).toBe(false);
      expect(isoDateSchema.safeParse(bad).success).toBe(false);
    }
  });
});

describe('service time limit (480 min, the optimizer maximum)', () => {
  it('customer and tenant default service time accept at most 480 min', () => {
    const base = { code: 'C1', name: 'Test', priority: 3, paymentType: 'CREDIT' as const };
    expect(MAX_SERVICE_MIN).toBe(480);
    expect(customerSchema.safeParse({ ...base, avgServiceTimeMin: 480 }).success).toBe(true);
    expect(customerSchema.safeParse({ ...base, avgServiceTimeMin: 481 }).success).toBe(false);
    expect(tenantConfigSchema.partial().safeParse({ defaultServiceTimeMin: 480 }).success).toBe(true);
    expect(tenantConfigSchema.partial().safeParse({ defaultServiceTimeMin: 600 }).success).toBe(false);
  });
});
