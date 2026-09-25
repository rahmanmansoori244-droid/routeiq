/**
 * Review F21 / new issue 68: PATCH /api/tenant/config saves only the fields sent, refuses a save
 * that would overwrite another admin's newer value (409 SETTINGS_CHANGED), refuses the old
 * controls (400) and checks the overtime threshold against the merged settings - only on a save
 * that changes the threshold or the shift maximum (PR5 review: a stored threshold after a lowered
 * shift maximum blocked saving even the company name).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  role: 'TENANT_ADMIN',
  tenant: {} as Record<string, any>,
  config: {} as Record<string, any>,
  updates: [] as { model: string; data: Record<string, unknown> }[],
  audits: [] as Record<string, any>[],
}));
vi.mock('@/lib/auth', () => ({ auth: vi.fn(async () => ({ user: { id: 'u1', tenantId: 'tA', role: state.role, name: 'A', email: 'a@a.example' } })) }));
vi.mock('@/lib/audit', () => ({ audit: vi.fn(async (input: Record<string, any>) => state.audits.push(input)) }));
vi.mock('@/lib/tenant', () => ({ tenantDb: () => ({}) }));
vi.mock('@/lib/db', () => {
  const tx = {
    $queryRaw: vi.fn(async () => [{ id: 'cfg' }]),
    tenant: {
      findUnique: vi.fn(async () => ({ ...state.tenant, config: { ...state.config } })),
      update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        state.updates.push({ model: 'tenant', data });
        Object.assign(state.tenant, data);
      }),
    },
    tenantConfig: {
      update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        state.updates.push({ model: 'config', data });
        Object.assign(state.config, data);
      }),
    },
  };
  return { prisma: { ...tx, $transaction: vi.fn(async (fn: (t: typeof tx) => unknown) => fn(tx)) } };
});

import { PATCH } from '@/app/api/tenant/config/route';
import { overtimeSaveProblem } from '@/lib/settings-fields';

const patch = (body: unknown) => PATCH(new Request('http://localhost/api/tenant/config', { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }));

beforeEach(() => {
  state.role = 'TENANT_ADMIN';
  state.tenant = { id: 'tA', name: 'NMWC', country: 'Oman', currency: 'OMR', primaryUnit: 'CASES' };
  state.config = { tenantId: 'tA', driverCostPerHour: 2.5, overtimeAfterMin: 540, driverShiftMaxMinutes: 660, fuelPricePerLitre: 0.26, roadTimeFactor: 1.25 };
  state.updates = [];
  state.audits = [];
});

describe('PATCH /api/tenant/config (review F21)', () => {
  it('saves only the fields sent, and audits only them', async () => {
    const res = await patch({ config: { driverCostPerHour: 3 }, expect: { config: { driverCostPerHour: 2.5 } } });
    expect(res.status).toBe(200);
    expect(state.updates).toEqual([{ model: 'config', data: { driverCostPerHour: 3 } }]);
    expect(state.config.fuelPricePerLitre).toBe(0.26);
    expect(state.audits[0]!.beforeJson).toEqual({ tenant: {}, config: { driverCostPerHour: 2.5 } });
    expect(state.audits[0]!.afterJson).toEqual({ tenant: {}, config: { driverCostPerHour: 3 } });
  });

  it("refuses to overwrite another admin's newer value (409 SETTINGS_CHANGED), saving nothing", async () => {
    state.config.driverCostPerHour = 2.8; // saved by someone else after this page was opened at 2.5
    const res = await patch({ config: { driverCostPerHour: 3, fuelPricePerLitre: 0.3 }, expect: { config: { driverCostPerHour: 2.5, fuelPricePerLitre: 0.26 } } });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error.code).toBe('SETTINGS_CHANGED');
    expect(body.error.fields).toEqual(['driverCostPerHour']);
    expect(state.updates).toEqual([]);
  });

  it('two admins changing different fields do not overwrite each other', async () => {
    expect((await patch({ config: { driverCostPerHour: 3 }, expect: { config: { driverCostPerHour: 2.5 } } })).status).toBe(200);
    expect((await patch({ config: { fuelPricePerLitre: 0.3 }, expect: { config: { fuelPricePerLitre: 0.26 } } })).status).toBe(200);
    expect(state.config).toMatchObject({ driverCostPerHour: 3, fuelPricePerLitre: 0.3 });
  });

  it('refuses the old controls and out-of-range values (400)', async () => {
    for (const body of [{ config: { solverTimeLimitSeconds: 60 } }, { config: { labelEstimatedDistances: false } }, { config: { roadTimeFactor: 4 } }, { tenant: { country: 'Omaan' } }, { nope: 1 }]) {
      expect((await patch(body)).status, JSON.stringify(body)).toBe(400);
    }
    expect(state.updates).toEqual([]);
  });

  it('checks overtime against the merged settings', async () => {
    const res = await patch({ config: { overtimeAfterMin: 700 } });
    expect(res.status).toBe(400);
    expect(JSON.stringify(await res.json())).toMatch(/Overtime after/);
    expect((await patch({ config: { overtimeAfterMin: 600 } })).status).toBe(200);
  });

  it('a stored threshold after a lowered shift maximum does not block saving other fields', async () => {
    // Possible before overtime was editable: the shift was lowered to 8 h, overtime stayed at 9 h.
    state.config.driverShiftMaxMinutes = 480;
    state.config.overtimeAfterMin = 540;
    expect((await patch({ tenant: { name: 'NMWC Muscat' }, expect: { tenant: { name: 'NMWC' } } })).status).toBe(200);
    expect(state.tenant.name).toBe('NMWC Muscat');
    expect((await patch({ config: { driverCostPerHour: 3 } })).status).toBe(200);
    // A save that touches either field is held to the rule...
    const still = await patch({ config: { driverShiftMaxMinutes: 500 } });
    expect(still.status).toBe(400);
    expect(JSON.stringify(await still.json())).toMatch(/Overtime after \(540 min\)/);
    // ...and fixing the threshold in the same save works.
    expect((await patch({ config: { overtimeAfterMin: 480 } })).status).toBe(200);
    expect(state.config.overtimeAfterMin).toBe(480);
  });

  it('the Settings form applies the same rule (overtimeSaveProblem)', () => {
    const stored = { overtimeAfterMin: 540, driverShiftMaxMinutes: 480 };
    expect(overtimeSaveProblem({ driverCostPerHour: 3 }, stored)).toBeNull();
    expect(overtimeSaveProblem({}, stored)).toBeNull();
    expect(overtimeSaveProblem({ driverShiftMaxMinutes: 480 }, stored)).toMatch(/Overtime after/);
    expect(overtimeSaveProblem({ overtimeAfterMin: 540 }, stored)).toMatch(/Overtime after/);
    expect(overtimeSaveProblem({ overtimeAfterMin: 480 }, { ...stored, overtimeAfterMin: 480 })).toBeNull();
  });

  it('is TENANT_ADMIN only', async () => {
    state.role = 'SUPERVISOR';
    expect((await patch({ config: { driverCostPerHour: 3 } })).status).toBe(403);
  });
});
