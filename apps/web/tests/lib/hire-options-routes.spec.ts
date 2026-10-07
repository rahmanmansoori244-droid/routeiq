/**
 * The hire options routes (third review of the hire branch): an option's max per day is counted by the
 * option, and the link from a rented truck to its option is never cleared or moved under a live rental -
 * deleting the option, or moving it to another depot, is refused while trucks are hired from it for
 * today or a coming day (switch it off instead). A day that is over never blocks. Synthetic data only.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resetDb, row, tables } from './fake-plan-db';

const { auth } = vi.hoisted(() => ({
  auth: async () => ({ user: { id: 'u1', tenantId: 'tA', role: 'TENANT_ADMIN', name: 'A', email: 'a@a.example' } }),
}));
vi.mock('@/lib/auth', () => ({ auth }));
vi.mock('@/lib/db', async () => ({ prisma: (await import('./fake-plan-db')).fakePrisma }));
vi.mock('@/lib/tenant', async () => {
  const m = await import('./fake-plan-db');
  return { tenantDb: () => m.fakePrisma };
});
vi.mock('@/lib/audit', async () => {
  const m = await import('./fake-plan-db');
  return { audit: vi.fn(async (input: Record<string, unknown>, tx?: Record<string, any>) => (tx ?? m.fakePrisma).auditLog.create({ data: { ...input } })) };
});

import { DELETE, PATCH } from '@/app/api/hire-options/[id]/route';

const COMING = new Date('2099-10-07T00:00:00Z');
const OVER = new Date('2020-01-07T00:00:00Z');

beforeEach(() => {
  resetDb();
  tables.tenantConfig = [{ id: 'cfg', tenantId: 'tA', timezone: 'Asia/Muscat' }];
  tables.depot = [
    { id: 'D1', tenantId: 'tA', code: 'D1', name: 'Depot 1', historyOnly: false },
    { id: 'D2', tenantId: 'tA', code: 'D2', name: 'Depot 2', historyOnly: false },
  ];
  tables.hireOption = [{ id: 'o10', tenantId: 'tA', depotId: 'D1', label: '10-ton', bays: 12, capacityCases: 1140, payloadKg: 0, costPerDay: 50, costPerKm: null, maxPerDay: 1, active: true }];
  tables.truck = [{ id: 'H1', tenantId: 'tA', depotId: 'D1', code: 'HIRE-10T-0710-1', active: true, hired: true, onlyOnDate: COMING, hireOptionId: 'o10' }];
});

const call = (handler: (r: Request, p: { params: { id: string } }) => Promise<Response>, method: string, body?: unknown) =>
  handler(new Request('http://x/api/hire-options/o10', { method, headers: { 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) }), { params: { id: 'o10' } });

describe('the hire options routes keep a live rental counted (review)', () => {
  it('deleting an option a truck is hired from for a coming day is refused: switch it off instead', async () => {
    const r = await call(DELETE, 'DELETE');
    expect(r.status).toBe(409);
    const body = await r.json();
    expect(body.error).toMatchObject({ code: 'HIRE_OPTION_IN_USE' });
    // The day as the rest of the screen says it (sixth review of the hire branch: "2099-10-07").
    expect(body.error.message).toMatch(/hired from this option for 7 Oct: .*switch it off instead/i);
    expect(tables.hireOption).toHaveLength(1);
    expect(row('truck', 'H1').hireOptionId).toBe('o10');
    // Switching it off is allowed (its rented truck stays counted).
    const off = await call(PATCH, 'PATCH', { active: false });
    expect(off.status).toBe(200);
    expect(row('hireOption', 'o10').active).toBe(false);
  });

  it('moving an option with a live rental to another depot is refused; other changes are not', async () => {
    const r = await call(PATCH, 'PATCH', { depotId: 'D2' });
    expect(r.status).toBe(409);
    expect((await r.json()).error).toMatchObject({ code: 'HIRE_OPTION_IN_USE' });
    expect(row('hireOption', 'o10').depotId).toBe('D1');
    const cost = await call(PATCH, 'PATCH', { costPerDay: 55 });
    expect(cost.status).toBe(200);
  });

  it('a rental whose day is over never blocks a delete or a move', async () => {
    row('truck', 'H1').onlyOnDate = OVER;
    expect((await call(PATCH, 'PATCH', { depotId: 'D2' })).status).toBe(200);
    expect((await call(DELETE, 'DELETE')).status).toBe(200);
    expect(tables.hireOption).toHaveLength(0);
  });
});
