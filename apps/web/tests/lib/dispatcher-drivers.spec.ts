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
import { readFileSync } from 'node:fs';
import path from 'node:path';
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
import { planDrivers, type EvidenceLoad } from '@/lib/dispatch/load-state';
import { leaveOnDay } from '@/lib/dispatch/driver-leave';
import { usualDriverChangedMessage } from '@/app/t/[slug]/drivers/usual-drivers';

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

  it("the Edit form gives the company admin what only he may change - the Code field and the Daily switch of a regular driver - and the dispatcher neither (review of 6 Oct 2026)", () => {
    const form = readFileSync(path.join(__dirname, '../../app/t/[slug]/drivers/driver-form.tsx'), 'utf8');
    // The code: editable on a new driver, and on an edit for the admin only.
    expect(form).toContain("disabled={mode === 'edit' && !canAdmin}");
    expect(form).not.toMatch(/disabled=\{mode === 'edit'\}\s*$/m);
    // The Daily switch: on a daily driver for everyone who edits (make him regular), on a regular one for the admin.
    expect(form).toContain("mode === 'edit' && (driver?.casual || canAdmin) ? (");
    expect(form).toContain('disabled={!driver?.casual && !canAdmin}');
    // The form sends the whole row on an edit, so both reach the server (driverChangesRefused decides).
    expect(form).toContain("body: JSON.stringify(mode === 'edit' ? form :");
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

  it("the message after a usual-driver change promises only what a re-plan of a plan already made does (review of 6 Oct 2026, two rounds)", () => {
    // The owner's case: Ali is away for a month and Bob covers him; Sam and Carl are free. The dispatcher makes Sam the
    // usual driver of T1 (or clears it). T1 runs trip 1 (08:00-10:00) and trip 2 (11:00-13:00).
    const leave = leaveOnDay([{ id: 'L1', driverId: 'ALI', fromIso: '2026-10-10', untilIso: '2026-11-09', note: null, coverDriverId: 'BOB' }], '2026-10-15');
    const usable = new Set(['ALI', 'BOB', 'SAM', 'CARL']);
    type Was = { driver: string | null; status?: string; byHand?: boolean; cover?: boolean };
    const none: Was = { driver: null };
    const given = (driver: string): Was => ({ driver });
    const cover: Was = { driver: 'BOB', cover: true };
    const byHand = (driver: string): Was => ({ driver, byHand: true });
    const HOURS = [
      [480, 600],
      [660, 780],
    ];
    // T1's trips on the plan already made, re-planned at the same times with T1's usual driver `usual`: every trip's
    // driver after the re-plan (a frozen trip is not re-planned and keeps its driver).
    const replan = (usual: string | null, was: Was[]) => {
      const evidence: EvidenceLoad[] = was.map((w, i) => ({
        truckId: 'T1',
        loadNo: i + 1,
        driverId: w.driver,
        departMin: HOURS[i][0],
        returnMin: HOURS[i][1],
        status: w.status ?? 'PLANNED',
        driverSetById: w.byHand ? 'u-PLANNER' : null,
        driverSetAt: w.byHand ? new Date('2026-10-14T06:00:00Z') : null,
        driverIsCover: w.cover ?? false,
      }));
      const trips = evidence
        .filter((e) => e.status === 'PLANNED')
        .map((e) => ({ key: `T1:${e.loadNo}`, truckId: 'T1', loadNo: e.loadNo, departMin: e.departMin, returnMin: e.returnMin, defaultDriverId: usual }));
      const { drivers } = planDrivers(trips, evidence, usable, leave);
      return evidence.map((e) => (e.status === 'PLANNED' ? drivers.get(`T1:${e.loadNo}`)!.driverId : e.driverId));
    };
    // What the message says a re-plan can do with trip i: a driver picked by hand stays (he is active here); a trip
    // without a driver, a trip a cover drove and a trip whose driver is on leave that day go to the usual driver or to
    // the driver of another trip of the truck (cleared: to the driver of another trip, or to nobody). It promises
    // nothing about other trips (here: a free driver RouteIQ gave keeps it; a frozen trip never changes).
    const allowed = (usual: string | null, was: Was[], after: (string | null)[], i: number): (string | null)[] => {
      const w = was[i];
      const others = after.filter((_, j) => j !== i);
      if ((w.status ?? 'PLANNED') !== 'PLANNED' || w.byHand) return [w.driver];
      if (w.driver === null || w.cover || leave.has(w.driver)) return usual ? [usual, ...others] : [...others, null];
      return [w.driver];
    };
    const cases: [string, Was[], (string | null)[], (string | null)[]][] = [
      // what T1's trips had, then every trip's driver after a re-plan with Sam made the usual driver, and with it cleared
      ['the cover drove it', [cover], ['SAM'], [null]],
      ['no driver', [none], ['SAM'], [null]],
      ['RouteIQ gave Carl', [given('CARL')], ['CARL'], ['CARL']],
      ['RouteIQ gave Ali before his leave was entered', [given('ALI')], ['SAM'], [null]],
      ['Carl picked by hand on trip 1, trip 2 without a driver', [byHand('CARL'), none], ['CARL', 'CARL'], ['CARL', 'CARL']],
      ['Carl picked by hand on trip 1, the cover on trip 2', [byHand('CARL'), cover], ['CARL', 'CARL'], ['CARL', 'CARL']],
      ['trip 1 dispatched with Bob, the cover on trip 2', [{ driver: 'BOB', status: 'DISPATCHED' }, cover], ['BOB', 'BOB'], ['BOB', 'BOB']],
      ['trip 1 without a driver, RouteIQ gave Carl trip 2', [none, given('CARL')], ['SAM', 'CARL'], [null, 'CARL']],
      ['Ali picked by hand, on leave', [byHand('ALI')], ['ALI'], ['ALI']],
    ];
    for (const [name, was, withSam, cleared] of cases) {
      for (const [usual, want] of [
        ['SAM', withSam],
        [null, cleared],
      ] as const) {
        const after = replan(usual, was);
        expect(after, `${name}, usual driver ${usual}`).toEqual(want);
        after.forEach((d, i) => expect(allowed(usual, was, after, i), `${name}, usual driver ${usual}, trip ${i + 1}`).toContain(d));
      }
    }

    expect(usualDriverChangedMessage('T01', 'Sam')).toBe(
      'T01: usual driver Sam. New plans use him. On plans already made, a re-plan can give a trip without a driver, a trip a cover drove and a trip whose driver is on leave that day to Sam or to the driver of another trip of T01; a driver you picked by hand stays while he is active. Check the drivers after the re-plan.',
    );
    expect(usualDriverChangedMessage('T01', null)).toBe(
      'T01: usual driver cleared. On plans already made, a re-plan can give a trip without a driver, a trip a cover drove and a trip whose driver is on leave that day to the driver of another trip of T01, or leave it without a driver (pick one on the load); a driver you picked by hand stays while he is active. Check the drivers after the re-plan.',
    );
    // The earlier promises the cases above break: the other trips keep their driver / a cover always comes off / the new usual driver gets them.
    for (const m of [usualDriverChangedMessage('T01', 'Sam'), usualDriverChangedMessage('T01', null)]) {
      expect(m).not.toMatch(/keep their driver|keeps the other drivers|takes a cover off|gives him the trips|pick a driver for those trips/);
    }
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

  it("a cover who is another active truck's usual driver: saved, with a warning naming the truck (an inactive truck does not count)", async () => {
    tables.truck!.push({ ...row('truck', 'T1'), id: 'T3', code: 'T03', defaultDriverId: 'BOB' }, { ...row('truck', 'T1'), id: 'T4', code: 'T04', defaultDriverId: 'BOB', active: false });
    const r = await answer(await postLeave(json('POST', { from: day(1), until: day(5), coverDriverId: 'BOB' }), ali));
    expect(r.status).toBe(201);
    expect(r.body.data.warnings).toEqual([
      'Bob is the usual driver of T03: RouteIQ gives him T03 first, so he covers only on days T03 does not run. Name another cover, or pick the driver on the plan.',
    ]);
  });

  it('a cover deactivated after the save: the period still ends early (the same cover is kept, audited); choosing him anew is refused', async () => {
    tables.driverLeave!.push({ id: 'S', tenantId: T, driverId: 'ALI', fromDate: new Date(`${day(-5)}T00:00:00.000Z`), untilDate: new Date(`${day(20)}T00:00:00.000Z`), note: null, coverDriverId: 'BOB', createdAt: new Date(), updatedAt: new Date() });
    row('driver', 'BOB').active = false;
    const s = { params: { id: 'ALI', leaveId: 'S' } };
    const ended = await answer(await patchLeave(json('PATCH', { from: day(-5), until: day(-1), coverDriverId: 'BOB', note: 'back early' }), s));
    expect(ended.status).toBe(200);
    expect(ended.body.data.leave).toMatchObject({ until: day(-1), coverDriverId: 'BOB', note: 'back early' });
    expect(audits('DRIVER_LEAVE_CHANGED')).toEqual([expect.objectContaining({ userId: 'u-PLANNER', afterJson: expect.objectContaining({ until: day(-1), coverName: 'Bob' }) })]);
    const fresh = await answer(await postLeave(json('POST', { from: day(30), until: day(31), coverDriverId: 'BOB' }), ali));
    expect(fresh.body.error).toMatchObject({ code: 'LEAVE_COVER_INACTIVE' });
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
