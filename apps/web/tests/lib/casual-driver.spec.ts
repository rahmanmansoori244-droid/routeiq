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

import { addCasualDriver, casualCode, maskPhone, phoneKey, sameName, samePhone } from '@/lib/dispatch/casual-driver';
import { casualDriverDialogText, casualDriverPlan, casualDriverToast, loadsText } from '@/lib/dispatch/casual-driver-words';
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
  it('maskPhone keeps only the last 3 digits (a short number is masked completely, none stays none)', () => {
    expect(maskPhone('+968 9000 1111')).toBe('***111');
    expect(maskPhone('0096890001111')).toBe('***111');
    expect(maskPhone('9000-1111')).toBe('***111');
    expect(maskPhone('12345')).toBe('***');
    expect(maskPhone('')).toBeNull();
    expect(maskPhone(null)).toBeNull();
    expect(maskPhone(undefined)).toBeNull();
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
    // Privacy (demo fix, 4 Oct 2026): the driver row keeps the mobile until the janitor erases it, the audit row
    // lives for ever - it keeps only the last 3 digits, never the whole number.
    const added = tables.auditLog.find((a) => a.action === 'CASUAL_DRIVER_ADDED')!;
    expect(added.afterJson).toMatchObject({ code: 'DAY-261005-1', name: 'Salim', phone: '***111', casual: true });
    expect(JSON.stringify(tables.auditLog)).not.toMatch(/9000\s?1111/);
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
    // The reactivation's audit row masks the mobile too (before and after).
    const reactivated = tables.auditLog.find((a) => a.entityId === 'old')!;
    expect(reactivated.beforeJson).toMatchObject({ phone: '***111', active: false });
    expect(reactivated.afterJson).toMatchObject({ phone: '***111', active: true });
    expect(JSON.stringify(tables.auditLog)).not.toMatch(/9000\s?1111/);
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

  it('driver leave (6 Oct 2026): a daily driver on leave that day is never reused silently - 409 DRIVER_ON_LEAVE, nothing saved; confirmed, he is used', async () => {
    tables.driver.push({ id: 'old', tenantId: T, code: 'DAY-260901-1', name: 'Salim', phone: '+968 9000 1111', casual: true, active: true });
    tables.driverLeave = [{ id: 'LV', tenantId: T, driverId: 'old', fromDate: new Date('2026-10-04T00:00:00Z'), untilDate: new Date('2026-10-07T00:00:00Z'), note: null, coverDriverId: null }];
    // The same phone and name (the silent reuse before): asked first.
    await expect(addCasualDriver(T, { runId: 'P', loadId: 'L1', name: 'Salim', phone: '9000 1111' }, user)).rejects.toMatchObject({
      status: 409,
      details: { code: 'DRIVER_ON_LEAVE', driverId: 'old', name: 'Salim', until: '2026-10-07' },
    });
    expect(row('planLoad', 'L1').driverId).toBeNull();
    expect(tables.auditLog ?? []).toHaveLength(0);
    // "Use Salim" sent by id without the answer: asked again.
    await expect(addCasualDriver(T, { runId: 'P', loadId: 'L1', name: 'Salim', useExisting: 'old' }, user)).rejects.toMatchObject({ details: { code: 'DRIVER_ON_LEAVE' } });
    const r = await addCasualDriver(T, { runId: 'P', loadId: 'L1', name: 'Salim', useExisting: 'old', leaveConfirmed: true }, user);
    expect(r).toMatchObject({ reused: true, driver: { id: 'old' } });
    expect(row('planLoad', 'L1').driverId).toBe('old');
    // Another day (his leave over): no question.
    tables.driverLeave[0]!.untilDate = new Date('2026-10-04T00:00:00Z');
    Object.assign(row('planLoad', 'L1'), { driverId: null, driverSetById: null, driverSetAt: null });
    expect((await addCasualDriver(T, { runId: 'P', loadId: 'L1', name: 'Salim', phone: '9000 1111' }, user)).driver.id).toBe('old');
  });

  it('driver leave: "This phone belongs to ..." says he is on leave that day, so "Use <name>" is the answer to both', async () => {
    tables.driverLeave = [{ id: 'LV', tenantId: T, driverId: 'reg', fromDate: new Date('2026-10-05T00:00:00Z'), untilDate: new Date('2026-10-09T00:00:00Z'), note: null, coverDriverId: null }];
    await expect(addCasualDriver(T, { runId: 'P', loadId: 'L1', name: 'Khalid', phone: '9000 2222' }, user)).rejects.toMatchObject({
      details: { code: 'PHONE_BELONGS_TO', driverId: 'reg', name: 'Hamad', casual: false, leaveUntil: '2026-10-09' },
    });
    expect(casualDriverSchema.safeParse({ runId: 'P', loadId: 'L1', name: 'Khalid', useExisting: 'reg', leaveConfirmed: true }).success).toBe(true);
    const r = await addCasualDriver(T, { runId: 'P', loadId: 'L1', name: 'Khalid', useExisting: 'reg', leaveConfirmed: true }, user);
    expect(r.driver.id).toBe('reg');
  });

  it('refused on a load on the road; a load of another plan is not found', async () => {
    await expect(addCasualDriver(T, { runId: 'P', loadId: 'L2', name: 'Salim' }, user)).rejects.toMatchObject({ status: 409, details: { code: 'LOAD_ON_ROAD' } });
    await expect(addCasualDriver(T, { runId: 'P', loadId: 'nope', name: 'Salim' }, user)).rejects.toMatchObject({ status: 404 });
    expect(tables.driver).toHaveLength(1);
  });
});

describe('a truck rented for the day: one day-rate driver for its whole day (sixth review of the hire branch)', () => {
  // The demo: "+ Add daily driver" on a hired truck's load put the driver on that load only, although the
  // truck is rented for the whole day with one casual driver at the day rate. Now on every load of that
  // truck still to plan, and as the one-day truck's default driver - each step audited.
  const day = new Date('2026-10-05T00:00:00Z');
  beforeEach(() => {
    tables.truck = [
      { id: 'T5', tenantId: T, code: 'T05' },
      { id: 'H1', tenantId: T, code: 'HIRE-10T-0510-1', hired: true, onlyOnDate: day, defaultDriverId: null },
    ];
    tables.planLoad.push(
      { id: 'H1', tenantId: T, runId: 'P', truckId: 'H1', loadNo: 1, status: 'PLANNED', driverId: null, departMin: 400, returnMin: 600 },
      { id: 'H2', tenantId: T, runId: 'P', truckId: 'H1', loadNo: 2, status: 'PLANNED', driverId: null, departMin: 630, returnMin: 800 },
      { id: 'H3', tenantId: T, runId: 'P', truckId: 'H1', loadNo: 3, status: 'PLANNED', driverId: 'reg', driverSetById: 'u2', driverSetAt: new Date('2026-10-05T05:00:00Z'), departMin: 830, returnMin: 950 },
      { id: 'HX', tenantId: T, runId: 'OTHER', truckId: 'H1', loadNo: 1, status: 'PLANNED', driverId: null, departMin: 400, returnMin: 600 },
    );
  });

  it('goes on every planned load of the hired truck and becomes its default driver', async () => {
    const r = await addCasualDriver(T, { runId: 'P', loadId: 'H1', name: 'Salim' }, user);
    expect(row('planLoad', 'H1').driverId).toBe(r.driver.id);
    expect(row('planLoad', 'H2').driverId).toBe(r.driver.id);
    // A driver the dispatcher chose for a load stays; another plan version's load is not touched.
    expect(row('planLoad', 'H3').driverId).toBe('reg');
    expect(row('planLoad', 'HX').driverId).toBeNull();
    expect(row('truck', 'H1').defaultDriverId).toBe(r.driver.id);
    expect(r.alsoOn).toEqual([{ loadId: 'H2', loadNo: 2 }]);
    expect(tables.auditLog.map((a) => a.action)).toEqual(['CASUAL_DRIVER_ADDED', 'LOAD_DRIVER_SET', 'LOAD_DRIVER_SET', 'HIRED_TRUCK_CHANGED']);
    const changed = tables.auditLog.find((a) => a.action === 'HIRED_TRUCK_CHANGED')!;
    expect(changed).toMatchObject({ entityId: 'H1', beforeJson: { defaultDriverId: null }, afterJson: { defaultDriverId: r.driver.id } });
  });

  it('only the load pressed is "picked by hand": the others are filled in by RouteIQ, audited as such (seventh review)', async () => {
    // Review: Loads 2 and 3 were written with the dispatcher's marker, so after a re-plan that left the
    // truck 2 trips the plan warned "Driver picked by hand, not in this plan: you picked Salim for ... L3",
    // a pick nobody made. Only the pressed load carries the marker; a re-plan refills the others anyway.
    const r = await addCasualDriver(T, { runId: 'P', loadId: 'H1', name: 'Salim' }, user);
    expect(row('planLoad', 'H1')).toMatchObject({ driverId: r.driver.id, driverSetById: 'u1' });
    expect(row('planLoad', 'H1').driverSetAt).toBeInstanceOf(Date);
    expect(row('planLoad', 'H2')).toMatchObject({ driverId: r.driver.id, driverSetById: null, driverSetAt: null });
    const sets = tables.auditLog.filter((a) => a.action === 'LOAD_DRIVER_SET');
    expect(sets.map((a) => a.entityId)).toEqual(['H1', 'H2']);
    expect((sets[0]!.afterJson as Record<string, unknown>).via).toBeUndefined();
    expect(sets[1]).toMatchObject({ userId: 'u1', afterJson: { driverId: r.driver.id, loadNo: 2, via: 'whole rental day', fromLoadId: 'H1' } });
  });

  it('a locked load of the hired truck stays as it is (frozen); the load pressed always gets the driver', async () => {
    row('planLoad', 'H2').status = 'LOCKED';
    const r = await addCasualDriver(T, { runId: 'P', loadId: 'H1', name: 'Salim' }, user);
    expect(row('planLoad', 'H2').driverId).toBeNull();
    expect(r.alsoOn).toEqual([]);
    expect(row('truck', 'H1').defaultDriverId).toBe(r.driver.id);
  });

  it('an own truck, or a hired truck of another day: the load only, as before', async () => {
    const own = await addCasualDriver(T, { runId: 'P', loadId: 'L1', name: 'Salim' }, user);
    expect(own.alsoOn).toEqual([]);
    row('truck', 'H1').onlyOnDate = new Date('2026-10-06T00:00:00Z');
    const other = await addCasualDriver(T, { runId: 'P', loadId: 'H1', name: 'Khalid' }, user);
    expect(other.alsoOn).toEqual([]);
    expect(row('planLoad', 'H2').driverId).toBeNull();
    expect(row('truck', 'H1').defaultDriverId).toBeNull();
  });
});

describe('the quick add says what it does before saving, and its message after (seventh review of the hire branch)', () => {
  // Review: the dialog said "put on this load" while it also swapped the hired truck's other loads and its
  // default driver (D -> E) - the only sign a toast afterwards ("never a silent swap"). The toast read
  // "Load 2 and Load 1, Load 3" (the pressed load first, the joining wrong).
  const hired = { id: 'H2', truckId: 'H1', truckCode: 'HIRE-10T-1110-1', loadNo: 2, hired: true, oneDay: '2026-10-11' };
  const day = (over: Partial<Parameters<typeof casualDriverPlan>[1][number]>[] = []) =>
    [
      { id: 'H1', truckId: 'H1', loadNo: 1, status: 'PLANNED', driverId: 'd', driverName: 'Darwish', driverHandSet: false },
      { id: 'H2', truckId: 'H1', loadNo: 2, status: 'PLANNED', driverId: 'd', driverName: 'Darwish', driverHandSet: false },
      { id: 'H3', truckId: 'H1', loadNo: 3, status: 'PLANNED', driverId: null, driverName: null, driverHandSet: false },
      { id: 'T1', truckId: 'T5', loadNo: 1, status: 'PLANNED', driverId: null, driverName: null, driverHandSet: false },
    ].map((l, i) => ({ ...l, ...(over[i] ?? {}) }));

  it('loads said in order: "Load 2", "Loads 1 and 2", "Loads 1, 2 and 3"', () => {
    expect(loadsText([2])).toBe('Load 2');
    expect(loadsText([2, 1])).toBe('Loads 1 and 2');
    expect(loadsText([2, 1, 3, 1])).toBe('Loads 1, 2 and 3');
    expect(casualDriverToast('HIRE-10T-1110-1', [2, 1, 3], 'Salim', false)).toBe('HIRE-10T-1110-1 Loads 1, 2 and 3: daily driver Salim');
    expect(casualDriverToast('T05', [1], 'Salim', true)).toBe('T05 Load 1: daily driver Salim (already saved)');
  });

  it('a truck rented for the day: the other loads still to plan and the default driver, named before saving', () => {
    const plan = casualDriverPlan(hired, day(), '2026-10-11');
    expect(plan).toEqual({ wholeDay: true, alsoOn: [1, 3], replaces: [{ loadNo: 1, driverName: 'Darwish' }], keeps: [] });
    const text = casualDriverDialogText(hired, plan);
    expect(text.intro).toMatch(/^HIRE-10T-1110-1 L2\. /);
    expect(text.intro).toMatch(/rented for the whole day with one driver: the driver also goes on Loads 1 and 3 \(its other loads still to plan\) and becomes its default driver\./);
    expect(text.intro).toMatch(/This replaces Darwish on Load 1\.$/);
    expect(text.intro).not.toMatch(/put on this load/);
    expect(text.button).toBe('Add and put on Loads 1, 2 and 3');
  });

  it('a locked load keeps its driver; one whose driver the dispatcher chose keeps it, said so', () => {
    const plan = casualDriverPlan(hired, day([{ driverHandSet: true }, {}, { status: 'LOCKED' }]), '2026-10-11');
    expect(plan).toEqual({ wholeDay: true, alsoOn: [], replaces: [], keeps: [1] });
    const text = casualDriverDialogText(hired, plan);
    expect(text.intro).toMatch(/rented for the whole day with one driver: the driver becomes its default driver\. Load 1 keeps the driver you chose yourself\.$/);
    expect(text.button).toBe('Add and put on this load');
  });

  it('an own truck, or a hired truck of another day: this load only, as before', () => {
    for (const load of [{ ...hired, hired: false, oneDay: null }, { ...hired, oneDay: '2026-10-12' }]) {
      const plan = casualDriverPlan(load, day(), '2026-10-11');
      expect(plan).toEqual({ wholeDay: false, alsoOn: [], replaces: [], keeps: [] });
      const text = casualDriverDialogText(load, plan);
      expect(text.intro).toMatch(/Saved as a daily driver with no account, and put on this load\./);
      expect(text.button).toBe('Add and put on this load');
    }
  });
});
