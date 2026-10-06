/**
 * A hired truck's plate after a later day's hired truck took it (third review of the hire branch): the
 * earlier day's truck is renamed "12345AB.261006" (hired-truck.ts freedCode) so the code stays unique,
 * and every place that shows that day's loads - the delivery results, the Bring forward list, the driver
 * link, the event messages - shows the plate it drove with ("12345AB"), as the plan screen does
 * (shownTruckCode). On the in-memory database (fake-plan-db.ts). Synthetic data only.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fakePrisma, resetDb, tables } from './fake-plan-db';

vi.mock('@/lib/db', async () => ({ prisma: (await import('./fake-plan-db')).fakePrisma }));
vi.mock('@/lib/tenant', async () => {
  const m = await import('./fake-plan-db');
  return { tenantDb: () => m.fakePrisma };
});

import { loadsOfRuns } from '@/lib/delivery/day-results';
import { dayFacts } from '@/lib/delivery/event-service';

const T = 'tA';
const DAY6 = new Date('2026-10-06T00:00:00Z');
const DAY7 = new Date('2026-10-07T00:00:00Z');

beforeEach(() => {
  resetDb();
  tables.tenantConfig = [{ id: 'cfg', tenantId: T, timezone: 'Asia/Muscat' }];
  tables.truck = [
    { id: 'H6', tenantId: T, depotId: 'D1', code: '12345AB.261006', hired: true, onlyOnDate: DAY6 },
    { id: 'H7', tenantId: T, depotId: 'D1', code: '12345AB', hired: true, onlyOnDate: DAY7 },
    { id: 'OWN', tenantId: T, depotId: 'D1', code: 'T01', hired: false, onlyOnDate: null },
  ];
  tables.runPlan = [{ id: 'R6', tenantId: T, depotId: 'D1', runDate: DAY6, status: 'READY', version: 1, supersededAt: null, chosenScenarioId: 'sc', createdAt: new Date() }];
  tables.planLoad = [
    { id: 'L1', tenantId: T, runId: 'R6', truckId: 'H6', loadNo: 1, status: 'DISPATCHED', departMin: 400, returnMin: 700, driverId: null, statusChangedAt: null, breakJson: null },
    { id: 'L2', tenantId: T, runId: 'R6', truckId: 'OWN', loadNo: 1, status: 'DISPATCHED', departMin: 400, returnMin: 700, driverId: null, statusChangedAt: null, breakJson: null },
  ];
});

describe("a past day's hired truck shows the plate it drove with (review)", () => {
  it('the delivery results and the Bring forward list of that day', async () => {
    const loads = await loadsOfRuns(fakePrisma as never, T, [{ id: 'R6', depotId: 'D1', date: '2026-10-06' }]);
    expect(loads.map((l) => [l.truckId, l.truckCode])).toEqual([
      ['H6', '12345AB'],
      ['OWN', 'T01'],
    ]);
  });

  it("the driver page's facts (and the messages built from them)", async () => {
    const facts = await dayFacts({ tenantId: T, truckId: 'H6', date: '2026-10-06', link: { driverIdAtIssue: null } as never }, fakePrisma as never);
    expect(facts.truckCode).toBe('12345AB');
  });
});
