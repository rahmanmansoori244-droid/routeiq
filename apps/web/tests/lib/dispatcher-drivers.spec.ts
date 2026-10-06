/**
 * Owner request 6 Oct 2026: "give access to the dispatcher to edit the drivers page, because our
 * drivers change a lot, or one of them is on leave and we bring another one, or they take a whole
 * month of leave; it will be his job to monitor those."
 *
 * The role matrix at run time, through the real route handlers on the in-memory database
 * (fake-plan-db.ts; only the session is faked):
 *  - PLANNER adds a driver, edits name / phone / Active, makes a daily driver regular; a new code or
 *    making a regular driver daily is refused (403 ADMIN_ONLY_DRIVER_FIELD); VIEWER is refused all
 *    of it; deleting a driver stays TENANT_ADMIN;
 *  - PLANNER sets and clears a truck's usual driver (audited TRUCK_USUAL_DRIVER_SET) and nothing else
 *    of a truck (403 ADMIN_ONLY_TRUCK_FIELD, nothing saved); the admin still changes every field;
 *  - driver leave: PLANNER adds, changes and removes (audited with who), every role reads, an overlap
 *    is refused 409, a started period is not removed;
 *  - every change is audited with the user.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resetDb, row, tables } from './fake-plan-db';

type Role = 'SUPER_ADMIN' | 'TENANT_ADMIN' | 'SUPERVISOR' | 'PLANNER' | 'VIEWER';
const session = vi.hoisted(() => ({ role: 'PLANNER' as Role, tenantId: 'tA' }));
vi.mock('@/lib/auth', () => ({ auth: vi.fn(async () => ({ user: { id: `u-${session.role}`, tenantId: session.tenantId, role: session.role, name: 'Hamad', email: 'hamad@a.example' } })) }));
vi.mock('@/lib/db', async () => ({ prisma: (await import('./fake-plan-db')).fakePrisma }));
vi.mock('@/lib/tenant', async () => {
  const m = await import('./fake-plan-db');
  return { tenantDb: () => m.fakePrisma };
});

import { POST as createDriver } from '@/app/api/drivers/route';
import { PATCH as patchDriver, DELETE as deleteDriver } from '@/app/api/drivers/[id]/route';
import { POST as postTruck } from '@/app/api/trucks/route';
import { PATCH as patchTruck } from '@/app/api/trucks/[id]/route';
import { GET as getLeave, POST as postLeave } from '@/app/api/drivers/[id]/leave/route';
import { PATCH as patchLeave, DELETE as deleteLeave } from '@/app/api/drivers/[id]/leave/[leaveId]/route';
import { driverChangesRefused, truckFieldsRefused } from '@/lib/rbac';
import { addDaysIso, todayIso } from '@/lib/dispatch/time';

const T = 'tA';
const json = (method: string, body?: unknown) =>
  new Request('http://localhost/x', { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
const answer = async (res: Response) => ({ status: res.status, body: (await res.json()) as { data: any; error: any } });
const as = (role: Role) => {
  session.role = role;
};
const TODAY = todayIso('Asia/Muscat');
const day = (n: number) => addDaysIso(TODAY, n);
const audits = (action: string) => (tables.auditLog ?? []).filter((a) => a.action === action);

function seed() {
  resetDb();
  tables.tenantConfig = [{ id: 'cfg', tenantId: T, timezone: 'Asia/Muscat' }];
  tables.depot = [{ id: 'D1', tenantId: T, code: 'MCT', name: 'Muscat', active: true, historyOnly: false, lat: 23.6, lng: 58.4 }];
  tables.driver = [
    { id: 'ALI', tenantId: T, code: 'D01', name: 'Ali', phone: '+968 9000 0001', active: true, casual: false },
    { id: 'BOB', tenantId: T, code: 'D02', name: 'Bob', phone: null, active: true, casual: false },
    { id: 'OLD', tenantId: T, code: 'D09', name: 'Old', phone: null, active: false, casual: false },
    { id: 'DAY', tenantId: T, code: 'DAY-261006-1', name: 'Salim', phone: null, active: true, casual: true },
  ];
  tables.truck = [
    { id: 'T1', tenantId: T, code: 'T01', depotId: 'D1', capacityCases: 1000, capacityWeightKg: 0, capacityVolumeL: 0, fixedCostPerDay: 20, costPerKm: 0.1, tripCost: 0, bays: null, availableFromMin: null, availableToMin: null, defaultDriverId: 'ALI', active: true, hired: false },
  ];
  tables.auditLog = [];
  tables.driverLeave = [];
  tables.planLoad = [];
}

beforeEach(() => {
  seed();
  as('PLANNER');
});

describe('the role rules (pure): the dispatcher changes drivers and the usual driver only', () => {
  it('truckFieldsRefused: PLANNER and SUPERVISOR may send defaultDriverId alone; the admin anything', () => {
    for (const role of ['PLANNER', 'SUPERVISOR'] as const) {
      expect(truckFieldsRefused(role, { defaultDriverId: 'ALI' })).toEqual([]);
      expect(truckFieldsRefused(role, { defaultDriverId: null })).toEqual([]);
      expect(truckFieldsRefused(role, { defaultDriverId: 'ALI', bays: 12, capacityCases: undefined })).toEqual(['bays']);
      expect(truckFieldsRefused(role, { fixedCostPerDay: 1, availableFromMin: 300, depotId: 'D2', code: 'X', active: false, hired: true })).toEqual([
        'fixedCostPerDay',
        'availableFromMin',
        'depotId',
        'code',
        'active',
        'hired',
      ]);
    }
    expect(truckFieldsRefused('TENANT_ADMIN', { bays: 12, costPerKm: 1 })).toEqual([]);
    expect(truckFieldsRefused('SUPER_ADMIN', { bays: 12 })).toEqual([]);
  });

  it('driverChangesRefused: a new code or regular -> daily stays the admin\'s; the same values sent back are no change', () => {
    const regular = { code: 'D01', casual: false };
    const daily = { code: 'DAY-1', casual: true };
    expect(driverChangesRefused('PLANNER', regular, { code: 'D01', casual: false })).toEqual([]);
    expect(driverChangesRefused('PLANNER', regular, { code: 'D99' })).toEqual(['code']);
    expect(driverChangesRefused('PLANNER', regular, { casual: true })).toEqual(['casual']);
    expect(driverChangesRefused('PLANNER', daily, { casual: false })).toEqual([]);
    expect(driverChangesRefused('TENANT_ADMIN', regular, { code: 'D99', casual: true })).toEqual([]);
  });
});

describe('drivers: the dispatcher adds and edits, the viewer reads, the admin keeps the code and the delete', () => {
  it('PLANNER adds a driver (code, name, mobile): 201 and a CREATE audit row with who; VIEWER 403', async () => {
    const res = await answer(await createDriver(json('POST', { code: 'D10', name: 'Nasser', phone: '+968 9555 1234' })));
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ code: 'D10', name: 'Nasser', phone: '+968 9555 1234', active: true });
    expect(audits('CREATE')).toEqual([expect.objectContaining({ entity: 'Driver', userId: 'u-PLANNER', entityId: res.body.data.id })]);
    as('VIEWER');
    expect((await createDriver(json('POST', { code: 'D11', name: 'Nope' }))).status).toBe(403);
    expect(tables.driver!.some((d) => d.code === 'D11')).toBe(false);
  });

  it('PLANNER edits the name and mobile, deactivates and reactivates (the trucks that keep him are named), audited UPDATE', async () => {
    const ctx = { params: { id: 'ALI' } };
    let r = await answer(await patchDriver(json('PATCH', { code: 'D01', name: 'Ali Al Harthy', phone: '+968 9111 2222', active: true, casual: false }), ctx));
    expect(r.status).toBe(200);
    expect(row('driver', 'ALI')).toMatchObject({ name: 'Ali Al Harthy', phone: '+968 9111 2222' });
    r = await answer(await patchDriver(json('PATCH', { active: false }), ctx));
    expect(r.status).toBe(200);
    expect(r.body.data.warning).toContain('usual driver on the Drivers page');
    expect(row('driver', 'ALI').active).toBe(false);
    expect((await patchDriver(json('PATCH', { active: true }), ctx)).status).toBe(200);
    expect(row('driver', 'ALI').active).toBe(true);
    expect(audits('UPDATE').filter((a) => a.entity === 'Driver' && a.userId === 'u-PLANNER')).toHaveLength(3);
  });

  it('PLANNER makes a daily driver a regular one; making a regular driver daily or a new code is refused (403, nothing saved)', async () => {
    expect((await patchDriver(json('PATCH', { casual: false }), { params: { id: 'DAY' } })).status).toBe(200);
    expect(row('driver', 'DAY').casual).toBe(false);
    const code = await answer(await patchDriver(json('PATCH', { code: 'D77', name: 'Ali 2' }), { params: { id: 'ALI' } }));
    expect(code.status).toBe(403);
    expect(code.body.error).toMatchObject({ code: 'ADMIN_ONLY_DRIVER_FIELD', fields: ['code'] });
    expect(row('driver', 'ALI')).toMatchObject({ code: 'D01', name: 'Ali' });
    const daily = await answer(await patchDriver(json('PATCH', { casual: true }), { params: { id: 'BOB' } }));
    expect(daily.status).toBe(403);
    expect(row('driver', 'BOB').casual).toBe(false);
    as('TENANT_ADMIN');
    expect((await patchDriver(json('PATCH', { code: 'D77' }), { params: { id: 'ALI' } })).status).toBe(200);
    expect(row('driver', 'ALI').code).toBe('D77');
  });

  it('VIEWER cannot edit; deleting (deactivating) a driver stays the admin\'s', async () => {
    as('VIEWER');
    expect((await patchDriver(json('PATCH', { name: 'X' }), { params: { id: 'ALI' } })).status).toBe(403);
    as('PLANNER');
    expect((await deleteDriver(json('DELETE'), { params: { id: 'ALI' } })).status).toBe(403);
    expect(row('driver', 'ALI')).toMatchObject({ name: 'Ali', active: true });
  });
});

describe("trucks: the dispatcher sets the usual driver and nothing else", () => {
  const ctx = { params: { id: 'T1' } };

  it('PLANNER sets and clears the usual driver: 200, audited TRUCK_USUAL_DRIVER_SET with who', async () => {
    expect((await patchTruck(json('PATCH', { defaultDriverId: 'BOB' }), ctx)).status).toBe(200);
    expect(row('truck', 'T1').defaultDriverId).toBe('BOB');
    expect((await patchTruck(json('PATCH', { defaultDriverId: null }), ctx)).status).toBe(200);
    expect(row('truck', 'T1').defaultDriverId).toBeNull();
    expect(audits('TRUCK_USUAL_DRIVER_SET')).toHaveLength(2);
    expect(audits('TRUCK_USUAL_DRIVER_SET')[0]).toMatchObject({ entity: 'Truck', entityId: 'T1', userId: 'u-PLANNER' });
  });

  it('an inactive driver cannot become the usual driver (400)', async () => {
    expect((await patchTruck(json('PATCH', { defaultDriverId: 'OLD' }), ctx)).status).toBe(400);
    expect(row('truck', 'T1').defaultDriverId).toBe('ALI');
  });

  it.each([
    [{ bays: 12 }, ['bays']],
    [{ capacityCases: 900 }, ['capacityCases']],
    [{ fixedCostPerDay: 25, costPerKm: 0.2 }, ['fixedCostPerDay', 'costPerKm']],
    [{ availableFromMin: 300 }, ['availableFromMin']],
    [{ depotId: 'D1' }, ['depotId']],
    [{ code: 'T99' }, ['code']],
    [{ active: false }, ['active']],
    [{ hired: true }, ['hired']],
    [{ defaultDriverId: 'BOB', bays: 10 }, ['bays']],
  ])('PLANNER sending %j is refused 403 ADMIN_ONLY_TRUCK_FIELD and nothing is saved', async (body, fields) => {
    const before = { ...row('truck', 'T1') };
    const r = await answer(await patchTruck(json('PATCH', body), ctx));
    expect(r.status).toBe(403);
    expect(r.body.error).toMatchObject({ code: 'ADMIN_ONLY_TRUCK_FIELD', fields });
    expect(row('truck', 'T1')).toEqual(before);
    expect(tables.auditLog).toEqual([]);
  });

  it('VIEWER changes nothing; the admin changes any field (audited UPDATE); adding a truck stays the admin\'s', async () => {
    as('VIEWER');
    expect((await patchTruck(json('PATCH', { defaultDriverId: 'BOB' }), ctx)).status).toBe(403);
    as('PLANNER');
    expect((await postTruck(json('POST', { code: 'T02', depotId: 'D1', capacityCases: 100, capacityWeightKg: 0, capacityVolumeL: 0, fixedCostPerDay: 1, costPerKm: 0.1 }))).status).toBe(403);
    as('TENANT_ADMIN');
    expect((await patchTruck(json('PATCH', { bays: 12, defaultDriverId: 'BOB' }), ctx)).status).toBe(200);
    expect(row('truck', 'T1')).toMatchObject({ bays: 12, defaultDriverId: 'BOB' });
    expect(audits('UPDATE')).toEqual([expect.objectContaining({ entity: 'Truck', userId: 'u-TENANT_ADMIN' })]);
  });
});

describe('driver leave through the routes', () => {
  const ali = { params: { id: 'ALI' } };

  it('PLANNER adds a period with a cover (201, audited DRIVER_LEAVE_ADDED with who); an overlapping one is refused 409; VIEWER reads but cannot add', async () => {
    const r = await answer(await postLeave(json('POST', { from: day(1), until: day(30), coverDriverId: 'BOB', note: 'annual leave' }), ali));
    expect(r.status).toBe(201);
    expect(r.body.data.leave).toMatchObject({ driverId: 'ALI', from: day(1), until: day(30), coverDriverId: 'BOB', coverName: 'Bob', note: 'annual leave', phase: 'COMING' });
    expect(audits('DRIVER_LEAVE_ADDED')).toEqual([
      expect.objectContaining({ entity: 'DriverLeave', userId: 'u-PLANNER', afterJson: expect.objectContaining({ driverName: 'Ali', from: day(1), until: day(30), coverName: 'Bob' }) }),
    ]);
    const clash = await answer(await postLeave(json('POST', { from: day(30), until: day(35) }), ali));
    expect(clash.status).toBe(409);
    expect(clash.body.error).toMatchObject({ code: 'LEAVE_OVERLAP' });
    expect(tables.driverLeave).toHaveLength(1);
    as('VIEWER');
    expect((await postLeave(json('POST', { from: day(40), until: day(41) }), ali)).status).toBe(403);
    const list = await answer(await getLeave(json('GET'), ali));
    expect(list.status).toBe(200);
    expect(list.body.data.periods.map((p: { from: string }) => p.from)).toEqual([day(1)]);
  });

  it('the cover cannot be the driver himself or inactive (400); unknown driver 404', async () => {
    expect((await answer(await postLeave(json('POST', { from: day(1), until: day(2), coverDriverId: 'ALI' }), ali))).body.error).toMatchObject({ code: 'LEAVE_COVER_SELF' });
    expect((await answer(await postLeave(json('POST', { from: day(1), until: day(2), coverDriverId: 'OLD' }), ali))).body.error).toMatchObject({ code: 'LEAVE_COVER_INACTIVE' });
    expect((await postLeave(json('POST', { from: day(1), until: day(2) }), { params: { id: 'NOPE' } })).status).toBe(404);
    expect(tables.driverLeave).toEqual([]);
  });

  it('a cover away himself part of the time, and loads already planned with the driver: saved, with warnings', async () => {
    tables.driverLeave!.push({ id: 'B1', tenantId: T, driverId: 'BOB', fromDate: new Date(`${day(3)}T00:00:00.000Z`), untilDate: new Date(`${day(4)}T00:00:00.000Z`), note: null, coverDriverId: null, createdAt: new Date(), updatedAt: new Date() });
    tables.runPlan = [{ id: 'P', tenantId: T, runDate: new Date(`${day(2)}T00:00:00.000Z`), status: 'READY', supersededAt: null }];
    tables.planLoad = [{ id: 'L', tenantId: T, runId: 'P', truckId: 'T1', loadNo: 1, status: 'PLANNED', driverId: 'ALI', run: { runDate: new Date(`${day(2)}T00:00:00.000Z`) }, truck: { code: 'T01' } }];
    const r = await answer(await postLeave(json('POST', { from: day(1), until: day(5), coverDriverId: 'BOB' }), ali));
    expect(r.status).toBe(201);
    expect(r.body.data.warnings).toEqual([expect.stringContaining('Bob is on leave himself'), expect.stringContaining('Ali is still the driver of 1 load(s) planned on those days (T01 · L1')]);
  });

  it('PLANNER changes and removes a coming period (audited with before and after); a started one is kept: end it early instead', async () => {
    const added = await answer(await postLeave(json('POST', { from: day(2), until: day(3) }), ali));
    const id = added.body.data.leave.id as string;
    const ch = await answer(await patchLeave(json('PATCH', { from: day(2), until: day(9), coverDriverId: 'BOB' }), { params: { id: 'ALI', leaveId: id } }));
    expect(ch.status).toBe(200);
    expect(ch.body.data.leave).toMatchObject({ until: day(9), coverName: 'Bob' });
    expect(audits('DRIVER_LEAVE_CHANGED')).toEqual([
      expect.objectContaining({ userId: 'u-PLANNER', beforeJson: expect.objectContaining({ until: day(3), coverDriverId: null }), afterJson: expect.objectContaining({ until: day(9), coverDriverId: 'BOB' }) }),
    ]);
    expect((await deleteLeave(json('DELETE'), { params: { id: 'ALI', leaveId: id } })).status).toBe(200);
    expect(tables.driverLeave).toEqual([]);
    expect(audits('DRIVER_LEAVE_REMOVED')).toEqual([expect.objectContaining({ userId: 'u-PLANNER', beforeJson: expect.objectContaining({ from: day(2), until: day(9) }) })]);

    // A period that started two days ago: not removed, its first day stays, it ends early down to yesterday.
    tables.driverLeave!.push({ id: 'S', tenantId: T, driverId: 'ALI', fromDate: new Date(`${day(-2)}T00:00:00.000Z`), untilDate: new Date(`${day(10)}T00:00:00.000Z`), note: null, coverDriverId: null, createdAt: new Date(), updatedAt: new Date() });
    const s = { params: { id: 'ALI', leaveId: 'S' } };
    expect((await answer(await deleteLeave(json('DELETE'), s))).body.error).toMatchObject({ code: 'LEAVE_STARTED' });
    expect((await answer(await patchLeave(json('PATCH', { from: day(-1), until: day(10) }), s))).body.error).toMatchObject({ code: 'LEAVE_STARTED' });
    expect((await patchLeave(json('PATCH', { from: day(-2), until: day(-1) }), s)).status).toBe(200);
    // Now ended: kept as it is.
    expect((await answer(await patchLeave(json('PATCH', { from: day(-2), until: day(5) }), s))).body.error).toMatchObject({ code: 'LEAVE_ENDED' });
    as('VIEWER');
    expect((await deleteLeave(json('DELETE'), s)).status).toBe(403);
  });

  it('another company\'s driver or period is not found (404)', async () => {
    session.tenantId = 'tB';
    try {
      expect((await postLeave(json('POST', { from: day(1), until: day(2) }), ali)).status).toBe(404);
    } finally {
      session.tenantId = T;
    }
  });
});
