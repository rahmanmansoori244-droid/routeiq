/**
 * Owner decision 3 (5 Oct 2026): "Call dispatcher" on the driver page is ONE NUMBER PER DEPOT. A depot
 * has its own dispatcher phone (Depot.dispatcherPhone, set by a company admin where depots are edited);
 * a depot without one falls back to the company number (TenantConfig.dispatcherPhone, Settings). The
 * driver page uses the depot of the truck-day's loads: the trip the driver is on or goes on next.
 * Synthetic data only; the manifest is read from the in-memory database (fake-plan-db.ts).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fakePrisma, resetDb, tables } from './fake-plan-db';

vi.mock('@/lib/db', async () => ({ prisma: (await import('./fake-plan-db')).fakePrisma }));
vi.mock('@/lib/tenant', async () => {
  const m = await import('./fake-plan-db');
  return { tenantDb: () => m.fakePrisma };
});

import { dispatcherPhoneFor } from '@/lib/driver-link/dispatcher-phone';
import { _clearManifestMemo, driverManifest } from '@/lib/driver-link/manifest';
import { depotPatchSchema, depotSchema } from '@/lib/schemas';

const WEB = path.resolve(__dirname, '../..');
const phones = (o: Record<string, string | null>) => new Map(Object.entries(o));
const COMPANY = '+968 9000 0000';

describe('dispatcherPhoneFor: the depot of the truck-day, else the company number', () => {
  it('one depot: its own number; without one (or only spaces) the company number; neither: none (the button is hidden)', () => {
    const loads = [{ depotId: 'D1', status: 'DISPATCHED' }];
    expect(dispatcherPhoneFor(loads, phones({ D1: '+968 2400 0001' }), COMPANY)).toBe('+968 2400 0001');
    expect(dispatcherPhoneFor(loads, phones({ D1: null }), COMPANY)).toBe(COMPANY);
    expect(dispatcherPhoneFor(loads, phones({ D1: '   ' }), COMPANY)).toBe(COMPANY);
    expect(dispatcherPhoneFor(loads, phones({}), COMPANY)).toBe(COMPANY);
    expect(dispatcherPhoneFor(loads, phones({ D1: null }), null)).toBeNull();
    expect(dispatcherPhoneFor(loads, phones({ D1: null }), '  ')).toBeNull();
  });

  it('no trip on the plan (yet): the company number', () => {
    expect(dispatcherPhoneFor([], phones({ D1: '+968 2400 0001' }), COMPANY)).toBe(COMPANY);
  });

  it('a truck on two depots the same day: the depot of the trip it is on or goes on next; after the last trip, the last one', () => {
    const p = phones({ D1: '+968 2400 0001', D2: '+968 2600 0002' });
    // Loads come in departure order (truckDayLoads).
    expect(dispatcherPhoneFor([{ depotId: 'D1', status: 'DISPATCHED' }, { depotId: 'D2', status: 'LOCKED' }], p, COMPANY)).toBe('+968 2400 0001');
    expect(dispatcherPhoneFor([{ depotId: 'D1', status: 'COMPLETED' }, { depotId: 'D2', status: 'DISPATCHED' }], p, COMPANY)).toBe('+968 2600 0002');
    expect(dispatcherPhoneFor([{ depotId: 'D1', status: 'COMPLETED' }, { depotId: 'D2', status: 'COMPLETED' }], p, COMPANY)).toBe('+968 2600 0002');
    // The next trip's depot has no number: the company's (never another depot's).
    expect(dispatcherPhoneFor([{ depotId: 'D1', status: 'COMPLETED' }, { depotId: 'D2', status: 'DISPATCHED' }], phones({ D1: '+968 2400 0001', D2: null }), COMPANY)).toBe(COMPANY);
  });
});

describe('the depot form and API take the phone (company admin, like the rest of the depot)', () => {
  const base = { code: 'MCT', name: 'Muscat', lat: 23.6, lng: 58.4 };

  it('a phone is checked like a driver phone; empty clears it; left out on a PATCH is unchanged', () => {
    expect(depotSchema.parse({ ...base, dispatcherPhone: ' +968 2400 0001 ' }).dispatcherPhone).toBe('+968 2400 0001');
    expect(depotSchema.parse({ ...base, dispatcherPhone: '' }).dispatcherPhone).toBeNull();
    expect(depotSchema.safeParse({ ...base, dispatcherPhone: 'call Ali' }).success).toBe(false);
    expect(depotPatchSchema.parse({ dispatcherPhone: null })).toEqual({ dispatcherPhone: null });
    expect(depotPatchSchema.parse({ name: 'Muscat 2' })).not.toHaveProperty('dispatcherPhone');
  });

  it('POST /api/depots stores it, the Depots form edits it, Settings calls the company number the fallback', () => {
    expect(readFileSync(path.join(WEB, 'app/api/depots/route.ts'), 'utf8')).toContain('dispatcherPhone: input.dispatcherPhone ?? null');
    const form = readFileSync(path.join(WEB, 'app/t/[slug]/depots/depot-form.tsx'), 'utf8');
    expect(form).toContain('id="dispatcherPhone"');
    expect(form).toContain('dispatcherPhone: form.dispatcherPhone');
    expect(readFileSync(path.join(WEB, 'app/t/[slug]/settings/settings-form.tsx'), 'utf8')).toContain('when the depot has no number of its own');
  });
});

describe('the driver page manifest: the depot\'s number, else the company\'s', () => {
  const now = new Date('2026-10-05T05:00:00Z');
  const read = () =>
    driverManifest({
      tenantId: 'tA',
      truckId: 'T5',
      date: '2026-10-05',
      link: { expiresAt: new Date('2026-10-06T08:00:00Z'), uploadUntil: new Date('2026-10-09T08:00:00Z'), generation: 1 },
      office: null,
      now,
    });

  beforeEach(() => {
    resetDb();
    _clearManifestMemo();
    // The manifest's memo stamp (the fake database has no aggregate).
    fakePrisma.planLoad.aggregate = async () => ({ _count: { _all: tables.planLoad?.length ?? 0 }, _max: { statusChangedAt: null, driverSetAt: null, createdAt: null } });
    tables.tenant = [{ id: 'tA', name: 'Synthetic Water Co' }];
    tables.tenantConfig = [{ tenantId: 'tA', timezone: 'Asia/Muscat', geofenceRadiusM: 100, photoProofRequired: true, locationRetentionDays: 90, dispatcherPhone: COMPANY }];
    tables.runPlan = [{ id: 'P', tenantId: 'tA', depotId: 'D1', runDate: new Date('2026-10-05T00:00:00Z'), status: 'READY', version: 1, chosenScenarioId: null, supersededAt: null, createdAt: new Date('2026-10-04T10:00:00Z'), reason: 'INITIAL' }];
    tables.depot = [{ id: 'D1', tenantId: 'tA', code: 'D1', name: 'Depot', lat: 23.6, lng: 58.4, dispatcherPhone: '+968 2400 0001' }];
    tables.truck = [{ id: 'T5', tenantId: 'tA', code: 'T05', capacityCases: 600, capacityWeightKg: 12000, hired: false }];
    tables.planLoad = [
      { id: 'L1', tenantId: 'tA', runId: 'P', truckId: 'T5', loadNo: 1, status: 'DISPATCHED', driverId: null, departMin: 420, returnMin: 600, distanceKm: 10, durationMin: 180, cases: 30, weightKg: 300, utilizationPct: 5, fuelLitres: null, fuelCost: 0, operatingCost: 0, returnLegKm: 1, distanceIsEstimated: true, carriedFromLoadId: null, createdAt: new Date() },
    ];
    tables.order = [];
    tables.routeAssignment = [];
    tables.stopVisit = [];
    tables.stopEvent = [];
  });

  it('the truck-day of a depot with its own number calls that number', async () => {
    expect((await read()).settings.dispatcherPhone).toBe('+968 2400 0001');
  });

  it('the depot has none: the company number (Settings)', async () => {
    tables.depot[0]!.dispatcherPhone = null;
    expect((await read()).settings.dispatcherPhone).toBe(COMPANY);
  });
});
