/**
 * Daily (casual) drivers added from a load (owner rule 20 and the request of 4 Oct 2026, spec
 * section 14), on the in-memory database (fake-plan-db.ts): the DAY-<yyMMdd>-<n> code under the
 * advisory lock, a unique-key error answered 409 CODE_TAKEN without a retry inside the aborted
 * transaction, reuse by phone, the "This phone belongs to ..." question, validation, and a load on
 * the road refused. Synthetic names only.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fakePrisma, rawLog, resetDb, row, tables } from './fake-plan-db';

vi.mock('@/lib/db', async () => ({ prisma: (await import('./fake-plan-db')).fakePrisma }));
vi.mock('@/lib/tenant', async () => {
  const m = await import('./fake-plan-db');
  return { tenantDb: () => m.fakePrisma };
});
vi.mock('@/lib/audit', () => ({
  audit: vi.fn(async (input: Record<string, unknown>, tx?: typeof fakePrisma) => (tx ?? fakePrisma).auditLog.create({ data: { ...input } })),
}));

import { addCasualDriver, casualCode, phoneKey, sameName, samePhone } from '@/lib/dispatch/casual-driver';
import { casualDriverSchema } from '@/lib/schemas';

const T = 'tA';
const user = { id: 'u1' };

function seed() {
  resetDb();
  tables.runPlan = [{ id: 'P', tenantId: T, depotId: 'D1', runDate: new Date('2026-10-05T00:00:00Z'), status: 'READY', version: 1, chosenScenarioId: 'sc', supersededAt: null }];
  tables.truck = [{ id: 'T5', tenantId: T, code: 'T05' }];
  tables.planLoad = [
    { id: 'L1', tenantId: T, runId: 'P', truckId: 'T5', loadNo: 1, status: 'LOCKED', driverId: null, departMin: 430, returnMin: 700 },
    { id: 'L2', tenantId: T, runId: 'P', truckId: 'T5', loadNo: 2, status: 'DISPATCHED', driverId: null, departMin: 760, returnMin: 900 },
  ];
  tables.driver = [{ id: 'reg', tenantId: T, code: 'D01', name: 'Hamad', phone: '+968 9000 2222', casual: false, active: true }];
}

beforeEach(seed);

describe('pure rules', () => {
  it('codes DAY-<yyMMdd>-<n>, the next n of that day', () => {
    expect(casualCode('2026-10-05', [])).toBe('DAY-261005-1');
    expect(casualCode('2026-10-05', ['DAY-261005-1', 'DAY-261005-7', 'DAY-261004-9', 'D01'])).toBe('DAY-261005-8');
  });
  it('the same phone (with or without the country code) and the same name (case and spaces ignored)', () => {
    expect(phoneKey('+968 9000-1111')).toBe('96890001111');
    expect(samePhone('+968 9000 1111', '9000 1111')).toBe(true);
    expect(samePhone('00968 90001111', '+96890001111')).toBe(true);
    expect(samePhone('9000 1111', '9000 1112')).toBe(false);
    expect(samePhone('', '9000 1111')).toBe(false);
    expect(sameName('  Salim  Al Harthy', 'salim al harthy')).toBe(true);
    expect(sameName('Salim', 'Khalid')).toBe(false);
  });
  it('validation: name 2-80 characters, phone like the Drivers page', () => {
    const ok = { runId: 'P', loadId: 'L1', name: 'Salim' };
    expect(casualDriverSchema.safeParse(ok).success).toBe(true);
    expect(casualDriverSchema.safeParse({ ...ok, name: 'A' }).success).toBe(false);
    expect(casualDriverSchema.safeParse({ ...ok, name: 'x'.repeat(81) }).success).toBe(false);
    expect(casualDriverSchema.safeParse({ ...ok, phone: 'call me' }).success).toBe(false);
    expect(casualDriverSchema.safeParse({ ...ok, phone: '' }).success).toBe(true);
    expect(casualDriverSchema.safeParse({ ...ok, extra: 1 }).success).toBe(false);
  });
});

describe('addCasualDriver', () => {
  it('creates a casual driver with the day code under the advisory lock and puts them on the load', async () => {
    const r = await addCasualDriver(T, { runId: 'P', loadId: 'L1', name: 'Salim', phone: '+968 9000 1111' }, user);
    expect(r.reused).toBe(false);
    expect(r.driver).toMatchObject({ code: 'DAY-261005-1', name: 'Salim', phone: '+968 9000 1111', casual: true, active: true });
    expect(row('planLoad', 'L1').driverId).toBe(r.driver.id);
    expect(rawLog.filter((s) => /pg_advisory_xact_lock/.test(s))).toHaveLength(1);
    expect(tables.auditLog.map((a) => a.action)).toEqual(['CASUAL_DRIVER_ADDED', 'LOAD_DRIVER_SET']);
    // A second one the same day gets the next number.
    tables.planLoad.push({ id: 'L3', tenantId: T, runId: 'P', truckId: 'T5', loadNo: 3, status: 'PLANNED', driverId: null, departMin: 950, returnMin: 1050 });
    const r2 = await addCasualDriver(T, { runId: 'P', loadId: 'L3', name: 'Khalid' }, user);
    expect(r2.driver.code).toBe('DAY-261005-2');
    expect(r2.driver.phone).toBeNull();
  });

  it('a unique-key error answers 409 CODE_TAKEN, rolls back and is never retried inside the transaction', async () => {
    const real = fakePrisma.driver.create;
    let calls = 0;
    fakePrisma.driver.create = async () => {
      calls++;
      throw Object.assign(new Error('Unique constraint failed'), { code: 'P2002' });
    };
    try {
      await expect(addCasualDriver(T, { runId: 'P', loadId: 'L1', name: 'Salim' }, user)).rejects.toMatchObject({ status: 409, details: { code: 'CODE_TAKEN' } });
      expect(calls).toBe(1);
      expect(row('planLoad', 'L1').driverId).toBeNull();
    } finally {
      fakePrisma.driver.create = real;
    }
  });

  it('the same phone and the same name: that daily driver is used again, reactivated', async () => {
    tables.driver.push({ id: 'old', tenantId: T, code: 'DAY-260901-1', name: 'Salim', phone: '+968 9000 1111', casual: true, active: false });
    const r = await addCasualDriver(T, { runId: 'P', loadId: 'L1', name: ' salim', phone: '9000 1111' }, user);
    expect(r.reused).toBe(true);
    expect(r.driver.id).toBe('old');
    expect(row('driver', 'old').active).toBe(true);
    expect(tables.driver).toHaveLength(2); // nobody new
    expect(row('planLoad', 'L1').driverId).toBe('old');
  });

  it('the same phone with another name: 409 PHONE_BELONGS_TO, nothing saved; then "Use Salim" works', async () => {
    tables.driver.push({ id: 'old', tenantId: T, code: 'DAY-260901-1', name: 'Salim', phone: '+968 9000 1111', casual: true, active: true });
    await expect(addCasualDriver(T, { runId: 'P', loadId: 'L1', name: 'Khalid', phone: '+968 9000 1111' }, user)).rejects.toMatchObject({
      status: 409,
      details: { code: 'PHONE_BELONGS_TO', driverId: 'old', name: 'Salim', casual: true },
    });
    expect(tables.driver).toHaveLength(2);
    expect(row('planLoad', 'L1').driverId).toBeNull();
    const r = await addCasualDriver(T, { runId: 'P', loadId: 'L1', name: 'Khalid', phone: '+968 9000 1111', useExisting: 'old' }, user);
    expect(r).toMatchObject({ reused: true, driver: { id: 'old', name: 'Salim' } });
  });

  it('a regular driver with that phone: the same question, naming them', async () => {
    await expect(addCasualDriver(T, { runId: 'P', loadId: 'L1', name: 'Hamad', phone: '9000 2222' }, user)).rejects.toMatchObject({
      details: { code: 'PHONE_BELONGS_TO', driverId: 'reg', name: 'Hamad', casual: false },
    });
  });

  it('an inactive regular driver is never reactivated by the quick add (only an admin changes that)', async () => {
    tables.driver.push({ id: 'gone', tenantId: T, code: 'D07', name: 'Nasser', phone: '+968 9000 3333', casual: false, active: false });
    // Sent directly by id: refused, nothing changes.
    await expect(addCasualDriver(T, { runId: 'P', loadId: 'L1', name: 'Nasser', useExisting: 'gone' }, user)).rejects.toMatchObject({
      status: 409,
      details: { code: 'DRIVER_INACTIVE' },
    });
    expect(row('driver', 'gone').active).toBe(false);
    expect(row('planLoad', 'L1').driverId).toBeNull();
    // His phone is not offered ("Use Nasser?"): a new daily driver is made instead.
    const r = await addCasualDriver(T, { runId: 'P', loadId: 'L1', name: 'Nasser', phone: '9000 3333' }, user);
    expect(r.reused).toBe(false);
    expect(r.driver.id).not.toBe('gone');
    expect(row('driver', 'gone').active).toBe(false);
    expect(tables.auditLog.some((a) => a.entityId === 'gone')).toBe(false);
  });

  it('refused on a load on the road; a load of another plan is not found', async () => {
    await expect(addCasualDriver(T, { runId: 'P', loadId: 'L2', name: 'Salim' }, user)).rejects.toMatchObject({ status: 409, details: { code: 'LOAD_ON_ROAD' } });
    await expect(addCasualDriver(T, { runId: 'P', loadId: 'nope', name: 'Salim' }, user)).rejects.toMatchObject({ status: 404 });
    expect(tables.driver).toHaveLength(1);
  });
});
