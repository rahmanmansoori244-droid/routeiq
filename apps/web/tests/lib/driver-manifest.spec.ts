/**
 * The driver page's manifest (owner request 4 Oct 2026, spec section 6.2): a projection of the plan
 * detail for one truck-day, built from plan-detail-fixture. Only the truck's loads, only DISPATCHED
 * loads actionable, never money or priorities; the order lines and the structured hours come from
 * the plan detail's additive fields (orderLines, plannedHours, promisedWindow), which getPlanDetail
 * builds from the row lines with no aggregation.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fixture } from './plan-detail-fixture';
import { resetDb, tables } from './fake-plan-db';
import type { PlanDetail } from '@/lib/dispatch/plan-detail';

vi.mock('@/lib/db', async () => ({ prisma: (await import('./fake-plan-db')).fakePrisma }));
vi.mock('@/lib/tenant', async () => {
  const m = await import('./fake-plan-db');
  return { tenantDb: () => m.fakePrisma };
});

import { mergeResults, navUrl, projectManifest, type ManifestInput } from '@/lib/driver-link/manifest';
import { getPlanDetail } from '@/lib/dispatch/plan-detail';
import { plannedStopOf } from '@/lib/delivery/planned-stop';
import { fakePrisma } from './fake-plan-db';

const input = (over: Partial<ManifestInput> = {}): ManifestInput => ({
  truckId: 't1',
  date: '2026-09-25',
  tz: 'Asia/Muscat',
  serverNow: new Date('2026-09-25T04:00:00Z'),
  tenantName: 'Synthetic Water Co',
  link: { expiresAt: new Date('2026-09-26T08:00:00Z'), uploadUntil: new Date('2026-09-29T08:00:00Z'), generation: 1 },
  truck: { code: 'T01', hired: false },
  casualOf: new Map([['drv1', false]]),
  settings: { radiusM: 100, photoRequired: true, locationRetentionDays: 90, photoRetentionDays: 90, dispatcherPhone: '+968 9000 0000' },
  office: null,
  ...over,
});

/** Every key of a value, at any depth. */
function keysOf(v: unknown, out: string[] = []): string[] {
  if (Array.isArray(v)) v.forEach((x) => keysOf(x, out));
  else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) out.push(k), keysOf(x, out);
  return out;
}

describe('projectManifest', () => {
  it('has only the truck\'s loads, in departure order, with trip k of n', () => {
    const m = projectManifest([fixture()], input());
    expect(m.loads.map((l) => [l.loadNo, l.trips, l.status])).toEqual([
      [1, 2, 'LOCKED'],
      [2, 2, 'PLANNED'],
    ]);
    expect(m.truck).toEqual({ id: 't1', code: 'T01', hired: false });
    expect(m.depot).toMatchObject({ code: 'MCT', name: 'Muscat Depot' });
    expect(m.drivers).toEqual([{ name: 'Salim Al Harthy', casual: false }]);
    // Another truck's customers never appear.
    expect(JSON.stringify(m)).not.toContain('Nesto Barka');
  });

  it('only a DISPATCHED load is actionable', () => {
    const d = fixture();
    d.loads[0] = { ...d.loads[0], status: 'DISPATCHED' };
    const m = projectManifest([d], input());
    expect(m.loads.map((l) => l.actionable)).toEqual([true, false]);
  });

  it('never carries money, priorities or weights (deep key scan)', () => {
    const m = projectManifest([fixture({ revenue: true })], input());
    const bad = keysOf(m).filter((k) => /cost|fuel|revenue|margin|payment|priority|amount|price|value|weight|kg|utili[sz]ation/i.test(k));
    expect(bad).toEqual([]);
    expect(JSON.stringify(m)).not.toMatch(/OMR/);
  });

  it('carries the order lines per order (no aggregation) and the structured hours', () => {
    const m = projectManifest([fixture()], input());
    const s1 = m.loads[0].stops[0];
    expect(s1).toMatchObject({ key: 'd1:1:1', sequence: 1, customerCode: 'C001', branchCode: 'B1', etaMin: 400, untilMin: 425, cases: 70 });
    expect(s1.orders).toEqual([
      {
        orderId: 'o1',
        salesOrders: ['SO-1001'],
        lines: [
          { lineId: 'o1-l1', productCode: 'TAN-500-24', productName: 'Tanuf 500ml x24', cases: 50 },
          { lineId: 'o1-l2', productCode: 'JAB-1500-6', productName: 'Jabal 1.5L x6', cases: 20 },
        ],
      },
    ]);
    expect(s1.hours).toEqual({ hardStart: 360, hardEnd: 840, prefStart: 420, prefEnd: 600 });
    expect(s1.promised).toBeNull();
    expect(s1.navUrl).toBe('https://www.google.com/maps/dir/?api=1&destination=23.5859,58.3829&travelmode=driving');
    expect(s1.accessNotes).toBe('Receiving at the back gate; forklift until 14:00');
    expect(m.loads[0].stops[1].notes).toEqual(['Call the store manager 30 min before']);
    expect(s1.result).toBeNull();
  });

  it('a split stop says which part, a brought-forward stop where from, a moved pin is a note', () => {
    const d = fixture();
    d.loads[0].stops[0] = {
      ...d.loads[0].stops[0],
      split: { part: 1, parts: 2, restUnserved: false },
      carriedFrom: '2026-09-24',
      masterChanged: [{ kind: 'LOCATION', text: 'Location updated after planning: new pin 23.60100, 58.39000', newLat: 23.601, newLng: 58.39, movedM: 1800 }],
      promisedWindow: { startMin: 600, endMin: 660 },
    };
    const s = projectManifest([d], input()).loads[0].stops[0];
    expect(s.split).toEqual({ part: 1, parts: 2 });
    expect(s.carriedFrom).toBe('2026-09-24');
    expect(s.changeNotes).toEqual(['Location updated after planning: new pin 23.60100, 58.39000']);
    expect(s.promised).toEqual({ startMin: 600, endMin: 660 });
    // The planned pin stays the Navigate target.
    expect(s.navUrl).toContain('destination=23.5859,58.3829');
  });

  it('a stop without a location has no Navigate link', () => {
    expect(navUrl(null, 58.4)).toBeNull();
    const d = fixture();
    d.loads[0].stops[1] = { ...d.loads[0].stops[1], lat: null, lng: null };
    expect(projectManifest([d], input()).loads[0].stops[1].navUrl).toBeNull();
  });

  it('two depots: the truck\'s loads of both plans, by departure', () => {
    const a = fixture();
    const b: PlanDetail = { ...fixture(), run: { ...fixture().run, id: 'run2', depot: { id: 'd2', code: 'SOH', name: 'Sohar Depot', lat: 24.3, lng: 56.7 } } };
    b.loads = [{ ...b.loads[0], id: 'S1', loadNo: 3, departMin: 900, returnMin: 1000 }];
    const m = projectManifest([b, a], input());
    expect(m.loads.map((l) => [l.loadNo, l.departMin])).toEqual([
      [1, 360],
      [2, 600],
      [3, 900],
    ]);
    expect(m.depot.code).toBe('MCT');
  });

  it('no plan in use: no trips', () => {
    const m = projectManifest([], input());
    expect(m.loads).toEqual([]);
    expect(m.truck.code).toBe('T01');
  });

  it('office is set only when a signed-in user opened the page', () => {
    expect(projectManifest([fixture()], input()).office).toBeNull();
    expect(projectManifest([fixture()], input({ office: { userName: 'Ali' } })).office).toEqual({ userName: 'Ali' });
  });

  it('settings and link facts for the page', () => {
    const m = projectManifest([fixture()], input({ truck: { code: 'T01', hired: true } }));
    expect(m.settings).toEqual({ radiusM: 100, photoRequired: true, maxPhotos: 3, locationRetentionDays: 90, photoRetentionDays: 90, dispatcherPhone: '+968 9000 0000' });
    expect(m.link).toEqual({ expiresAt: '2026-09-26T08:00:00.000Z', uploadUntil: '2026-09-29T08:00:00.000Z', generation: 1 });
    expect(m.truck.hired).toBe(true);
  });
});

describe('getPlanDetail: the additive stop fields (orderLines, plannedHours, promisedWindow)', () => {
  beforeEach(() => {
    resetDb();
    tables.runPlan = [{ id: 'P', tenantId: 'tA', depotId: 'D1', runDate: new Date('2026-10-05T00:00:00Z'), status: 'READY', version: 1, chosenScenarioId: null, supersededAt: null, createdAt: new Date('2026-10-04T10:00:00Z'), reason: 'INITIAL' }];
    tables.depot = [{ id: 'D1', code: 'D1', name: 'Depot', lat: 23.6, lng: 58.4 }];
    tables.truck = [{ id: 'T5', tenantId: 'tA', code: 'T05', capacityCases: 600, capacityWeightKg: 12000, hired: true }];
    tables.planLoad = [{ id: 'L1', tenantId: 'tA', runId: 'P', truckId: 'T5', loadNo: 1, status: 'DISPATCHED', driverId: null, departMin: 420, returnMin: 600, distanceKm: 10, durationMin: 180, cases: 30, weightKg: 300, utilizationPct: 5, fuelLitres: null, fuelCost: 0, operatingCost: 0, returnLegKm: 1, distanceIsEstimated: true, carriedFromLoadId: null, createdAt: new Date() }];
    const product = (code: string) => ({ code, name: `Product ${code}`, weightPerCaseKg: 10 });
    tables.order = [
      {
        id: 'O1', tenantId: 'tA', customerId: 'C1', totalCases: 30, totalWeightKg: 300, status: 'DISPATCHED', priority: 3, isLate: false, notes: null, carriedFromDate: null, carriedTo: null,
        customer: { id: 'C1', code: 'ACME', branchCode: null, name: 'ACME Store', lat: 23.61, lng: 58.41, address: null, accessNotes: null, active: true, avgServiceTimeMin: 10, serviceTimeConfirmed: true, hardWindowStartMin: 480, hardWindowEndMin: 780, prefWindowStartMin: null, prefWindowEndMin: null, customerType: null },
        lines: [
          { id: 'LN1', cases: 20, weightKg: 200, salesOrderNo: 'SO-1', weightFromMaster: false, product: product('A') },
          { id: 'LN2', cases: 10, weightKg: 100, salesOrderNo: 'SO-1', weightFromMaster: false, product: product('A') },
        ],
      },
    ];
    tables.routeAssignment = [
      { id: 'RA1', runId: 'P', truckId: 'T5', orderId: 'O1', sequenceInTruck: 1, loadId: 'L1', loadNo: 1, orderInStop: 0, etaMin: 450, serviceStartMin: 480, departureMin: 500, plannedDistanceFromPrevKm: 5, portionLinesJson: null, stopSnapshotJson: null },
    ];
  });

  it('one entry per order line even for the same product, and the hours of the customer without a snapshot', async () => {
    const d = (await getPlanDetail('tA', 'P'))!;
    const s = d.loads[0].stops[0];
    expect(s.orderLines).toEqual([
      { orderId: 'O1', lineId: 'LN1', salesOrderNo: 'SO-1', productCode: 'A', productName: 'Product A', cases: 20 },
      { orderId: 'O1', lineId: 'LN2', salesOrderNo: 'SO-1', productCode: 'A', productName: 'Product A', cases: 10 },
    ]);
    // The SKU list stays aggregated, as before.
    expect(s.skus).toEqual([expect.objectContaining({ productCode: 'A', cases: 30 })]);
    expect(s.plannedHours).toEqual({ hardStart: 480, hardEnd: 780, prefStart: null, prefEnd: null });
    expect(s.promisedWindow).toBeNull();
    expect(d.loads[0].hired).toBe(true);
  });

  it('a split portion lists only its own cases', async () => {
    tables.routeAssignment[0].portionLinesJson = [{ lineId: 'LN1', cases: 5 }];
    tables.routeAssignment[0].portionCases = 5;
    const s = (await getPlanDetail('tA', 'P'))!.loads[0].stops[0];
    expect(s.orderLines).toEqual([{ orderId: 'O1', lineId: 'LN1', salesOrderNo: 'SO-1', productCode: 'A', productName: 'Product A', cases: 5 }]);
  });

  it('Part 2: the planned stop of the driver API has exactly the manifest\'s order lines (whole and split), so the two paths cannot drift', async () => {
    for (const portion of [null, [{ lineId: 'LN1', cases: 5 }, { lineId: 'LN2', cases: 3 }]]) {
      tables.routeAssignment[0].portionLinesJson = portion;
      tables.routeAssignment[0].portionCases = portion ? 8 : null;
      const s = (await getPlanDetail('tA', 'P'))!.loads[0].stops[0];
      const planned = (await plannedStopOf(fakePrisma as never, { id: 'L1', breakJson: null }, 1))!;
      expect(planned.lines.map((l) => ({ orderId: l.orderId, lineId: l.lineId, cases: l.plannedCases }))).toEqual(s.orderLines.map((l) => ({ orderId: l.orderId, lineId: l.lineId, cases: l.cases })));
      expect(planned.casesPlanned).toBe(s.cases);
    }
  });
});

describe('Part 2: results merged into the manifest', () => {
  it('lays each stop\'s result and each trip\'s Back at depot into the projection', () => {
    const m = projectManifest([fixture()], input());
    const first = m.loads[0]!;
    const key = first.stops[0]!.key;
    const merged = mergeResults(m, {
      stops: { [key]: { state: 'DONE', arrivedAt: null, arrivalObserved: true, departedAt: null, minutes: null, outcome: 'DELIVERED', reason: null, note: null, outcomeAt: null, by: 'DRIVER', casesDelivered: 1, lines: null, photoIds: [], proofPhotos: 0, noPhotoReason: null, late: false, editable: true, carriedTo: null } },
      back: { [first.key]: '2026-10-05T12:00:00.000Z' },
    });
    expect(merged.loads[0]!.stops[0]!.result).toMatchObject({ outcome: 'DELIVERED' });
    expect(merged.loads[0]!.stops[1]?.result ?? null).toBeNull();
    expect(merged.loads[0]!.backAtDepotAt).toBe('2026-10-05T12:00:00.000Z');
  });
});
