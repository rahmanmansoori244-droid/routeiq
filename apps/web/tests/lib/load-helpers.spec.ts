/**
 * Helpers (truck crew), owner request 13 Oct 2026: "management asked to track helpers in each truck,
 * so add that like drivers too. We need to know who were the helpers in each truck and load."
 *
 * On the in-memory database (fake-plan-db.ts; only the session is faked):
 *  - the schemas (code rule, the drivers' phone rule, 0-3 helpers per load, each once);
 *  - the rules (pure): planHelpers (usual helper, hand-set kept, inactive and overlapping refused),
 *    checkHelpersChange (as the driver: until dispatch), the texts;
 *  - the Helpers routes: PLANNER adds and edits, VIEWER is refused, a new code is the admin's, a code
 *    already used is a 409 with the code - for drivers too (the live bug of 12 Oct 2026: a 500);
 *  - a truck's usual helper (PLANNER, audited TRUCK_USUAL_HELPER_SET);
 *  - a load's helpers (updateLoad): set, audited LOAD_HELPERS_CHANGED with names, refused after
 *    dispatch, copied into the next plan version with the hand-set marker.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fakePrisma, resetDb, row, tables } from './fake-plan-db';

type Role = 'SUPER_ADMIN' | 'TENANT_ADMIN' | 'SUPERVISOR' | 'PLANNER' | 'VIEWER';
const session = vi.hoisted(() => ({ role: 'PLANNER' as Role, tenantId: 'tA' }));
vi.mock('@/lib/auth', () => ({ auth: vi.fn(async () => ({ user: { id: `u-${session.role}`, tenantId: session.tenantId, role: session.role, name: 'Hamad', email: 'hamad@a.example' } })) }));
vi.mock('@/lib/db', async () => ({ prisma: (await import('./fake-plan-db')).fakePrisma }));
vi.mock('@/lib/tenant', async () => {
  const m = await import('./fake-plan-db');
  return { tenantDb: () => m.fakePrisma };
});

import { POST as createHelper, GET as listHelpers } from '@/app/api/helpers/route';
import { PATCH as patchHelper } from '@/app/api/helpers/[id]/route';
import { POST as createDriver } from '@/app/api/drivers/route';
import { PATCH as patchDriver } from '@/app/api/drivers/[id]/route';
import { PATCH as patchTruck } from '@/app/api/trucks/[id]/route';
import { PATCH as patchLoad } from '@/app/api/runs/[id]/loads/[loadId]/route';
import { handleError } from '@/lib/api';
import { helperPatchSchema, helperSchema, loadHelperIdsSchema, truckPatchSchema } from '@/lib/schemas';
import { helperChangesRefused, truckFieldsRefused } from '@/lib/rbac';
import { codeTakenMessage, isUniqueViolation } from '@/lib/unique-code';
import {
  checkHelpersChange,
  helperChangeText,
  helperChangeWarnings,
  helperClashes,
  helperDeactivatedWarning,
  helpersText,
  isHandSetHelpers,
  planHelpers,
  usualHelperChangedMessage,
  type HelperChangeNote,
  type HelperEvidence,
  type HelperTrip,
} from '@/lib/dispatch/load-helpers';
import { createNextVersion, updateLoad } from '@/lib/dispatch/plan-service';
import { AUDIT_ACTIONS, AUDIT_ENTITIES } from '@/lib/audit-catalog';
import { visibleNavItems } from '@/lib/nav';

const T = 'tA';
const json = (method: string, body?: unknown) =>
  new Request('http://localhost/x', { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
const answer = async (res: Response) => ({ status: res.status, body: (await res.json()) as { data: any; error: any } });
const as = (role: Role) => {
  session.role = role;
};
const audits = (action: string) => (tables.auditLog ?? []).filter((a) => a.action === action);

function seed() {
  resetDb();
  tables.tenantConfig = [{ id: 'cfg', tenantId: T, timezone: 'Asia/Muscat' }];
  tables.depot = [{ id: 'D1', tenantId: T, code: 'MCT', name: 'Muscat', active: true, historyOnly: false, lat: 23.6, lng: 58.4 }];
  tables.driver = [{ id: 'ALI', tenantId: T, code: 'D01', name: 'Ali', phone: null, active: true, casual: false }];
  tables.helper = [
    { id: 'SAIF', tenantId: T, code: 'H01', name: 'Saif', phone: '+968 9000 0011', active: true },
    { id: 'OMAR', tenantId: T, code: 'H02', name: 'Omar', phone: null, active: true },
    { id: 'NASR', tenantId: T, code: 'H03', name: 'Nasr', phone: null, active: true },
    { id: 'OLD', tenantId: T, code: 'H09', name: 'Old', phone: null, active: false },
  ];
  tables.truck = [
    { id: 'T1', tenantId: T, code: 'T01', depotId: 'D1', capacityCases: 1000, capacityWeightKg: 0, capacityVolumeL: 0, fixedCostPerDay: 20, costPerKm: 0.1, tripCost: 0, bays: null, availableFromMin: null, availableToMin: null, defaultDriverId: 'ALI', defaultHelperId: null, active: true, hired: false },
  ];
  tables.auditLog = [];
  tables.planLoad = [];
  tables.planLoadHelper = [];
}

beforeEach(() => {
  seed();
  as('PLANNER');
});

describe('schemas: a helper like a driver, 0 to 3 helpers on a load', () => {
  it('code: letters, digits and . _ -; the phone: the drivers\' rule, empty clears it; nothing else is accepted', () => {
    expect(helperSchema.parse({ code: 'H01', name: ' Saif ', phone: '+968 9123 4567' })).toEqual({ code: 'H01', name: 'Saif', phone: '+968 9123 4567' });
    expect(helperSchema.parse({ code: 'H-02', name: 'Omar', phone: '' })).toMatchObject({ phone: null });
    expect(helperSchema.safeParse({ code: 'H 01', name: 'x' }).success).toBe(false);
    expect(helperSchema.safeParse({ code: 'H01', name: '' }).success).toBe(false);
    expect(helperSchema.safeParse({ code: 'H01', name: 'x', phone: 'call me' }).success).toBe(false);
    expect(helperSchema.safeParse({ code: 'H01', name: 'x', casual: true }).success).toBe(false);
    expect(helperPatchSchema.parse({ active: false })).toEqual({ active: false });
    expect(helperPatchSchema.parse({ phone: null })).toEqual({ phone: null });
  });

  it('a load takes 0 to 3 helpers, each once', () => {
    expect(loadHelperIdsSchema.parse([])).toEqual([]);
    expect(loadHelperIdsSchema.parse(['a', 'b', 'c'])).toEqual(['a', 'b', 'c']);
    expect(loadHelperIdsSchema.safeParse(['a', 'b', 'c', 'd']).success).toBe(false);
    expect(loadHelperIdsSchema.safeParse(['a', 'a']).success).toBe(false);
  });

  it('the dispatcher may send a truck\'s usual helper alone; a helper code change is the admin\'s', () => {
    expect(truckPatchSchema.parse({ defaultHelperId: '' })).toEqual({ defaultHelperId: null });
    expect(truckFieldsRefused('PLANNER', { defaultHelperId: 'SAIF' })).toEqual([]);
    expect(truckFieldsRefused('PLANNER', { defaultHelperId: 'SAIF', defaultDriverId: 'ALI', bays: 4 })).toEqual(['bays']);
    expect(helperChangesRefused('PLANNER', { code: 'H01' }, { code: 'H01' })).toEqual([]);
    expect(helperChangesRefused('PLANNER', { code: 'H01' }, { code: 'H07' })).toEqual(['code']);
    expect(helperChangesRefused('TENANT_ADMIN', { code: 'H01' }, { code: 'H07' })).toEqual([]);
  });

  it('the audit catalog, the menu and the words', () => {
    expect(AUDIT_ACTIONS.LOAD_HELPERS_CHANGED.label).toBe('Load helpers changed');
    expect(AUDIT_ACTIONS.TRUCK_USUAL_HELPER_SET.label).toBe('Usual helper of a truck changed');
    expect(AUDIT_ENTITIES.Helper.label).toBe('Helper');
    for (const role of ['VIEWER', 'PLANNER', 'TENANT_ADMIN'] as const) expect(visibleNavItems(role).map((i) => i.label)).toContain('Helpers');
    expect(helpersText(['Saif', null, ' ', 'Omar'])).toBe('Saif, Omar');
    expect(helpersText([])).toBeNull();
    expect(usualHelperChangedMessage('T01', 'Saif')).toBe('Usual helper of T01 is now Saif. Re-plan days already planned to use him.');
    expect(usualHelperChangedMessage('T01', null)).toBe('Usual helper of T01 cleared. Re-plan days already planned to apply it.');
    expect(helperDeactivatedWarning([])).toBeNull();
    expect(helperDeactivatedWarning(['T01'])).toContain('usual helper of truck T01');
  });
});

describe('planHelpers: the usual helper, the dispatcher\'s pick, never two trips at once', () => {
  const trip = (truckId: string, loadNo: number, departMin: number, returnMin: number, defaultHelperId: string | null): HelperTrip => ({
    key: `${truckId}:${loadNo}`,
    truckId,
    loadNo,
    departMin,
    returnMin,
    defaultHelperId,
  });
  const ev = (truckId: string, loadNo: number, status: string, helperIds: string[], handSet = false, departMin = 360, returnMin = 480): HelperEvidence => ({
    truckId,
    loadNo,
    status,
    departMin,
    returnMin,
    helperIds,
    helpersSetById: handSet ? 'u1' : null,
    helpersSetAt: handSet ? new Date('2026-10-13T10:00:00Z') : null,
  });
  const active = new Set(['SAIF', 'OMAR', 'NASR']);

  it('a new trip gets the truck\'s usual helper; both trips of one truck get him (they never overlap)', () => {
    const { helpers: out } = planHelpers([trip('T1', 1, 360, 480, 'SAIF'), trip('T1', 2, 500, 620, 'SAIF'), trip('T2', 1, 360, 480, null)], [], active);
    expect(out.get('T1:1')).toEqual({ helperIds: ['SAIF'], helpersSetById: null, helpersSetAt: null });
    expect(out.get('T1:2')!.helperIds).toEqual(['SAIF']);
    expect(out.get('T2:1')!.helperIds).toEqual([]);
  });

  it('helpers set by hand stay on their truck and trip with the marker (the inactive ones dropped); RouteIQ\'s are re-decided', () => {
    const evidence = [ev('T1', 1, 'PLANNED', ['OMAR', 'NASR'], true), ev('T1', 2, 'PLANNED', ['OLD'], true), ev('T2', 1, 'PLANNED', ['NASR'], false)];
    const { helpers: out } = planHelpers([trip('T1', 1, 380, 500, 'SAIF'), trip('T1', 2, 520, 640, 'SAIF'), trip('T2', 1, 700, 800, 'SAIF')], evidence, active);
    expect(out.get('T1:1')).toMatchObject({ helperIds: ['OMAR', 'NASR'], helpersSetById: 'u1' });
    // Only an inactive helper was picked: the trip is filled in like any other.
    expect(out.get('T1:2')).toEqual({ helperIds: ['SAIF'], helpersSetById: null, helpersSetAt: null });
    expect(out.get('T2:1')!.helperIds).toEqual(['SAIF']);
  });

  it('"No helpers" set by hand is not kept (as "No driver"): the usual helper again', () => {
    const { helpers: out } = planHelpers([trip('T1', 1, 360, 480, 'SAIF')], [ev('T1', 1, 'PLANNED', [], true)], active);
    expect(out.get('T1:1')!.helperIds).toEqual(['SAIF']);
  });

  it('a usual helper inactive, on a frozen load or on a hand-set trip at an overlapping time is not given', () => {
    expect(planHelpers([trip('T1', 1, 360, 480, 'OLD')], [], active).helpers.get('T1:1')!.helperIds).toEqual([]);
    // T2's frozen load 06:00-08:00 has Saif: T1's trip 07:00 does not get him; 08:00 does (back at 08:00).
    const frozen = [ev('T2', 1, 'LOCKED', ['SAIF'], false, 360, 480)];
    expect(planHelpers([trip('T1', 1, 420, 540, 'SAIF')], frozen, active).helpers.get('T1:1')!.helperIds).toEqual([]);
    expect(planHelpers([trip('T1', 1, 480, 540, 'SAIF')], frozen, active).helpers.get('T1:1')!.helperIds).toEqual(['SAIF']);
    // Two trucks with the same usual helper at the same time: the first trip listed gets him.
    const { helpers: two } = planHelpers([trip('T1', 1, 360, 480, 'SAIF'), trip('T2', 1, 400, 500, 'SAIF')], [], active);
    expect([two.get('T1:1')!.helperIds, two.get('T2:1')!.helperIds]).toEqual([['SAIF'], []]);
  });

  it('a usual helper on a load of another depot at that time (the drive included) is not given', () => {
    const away = [{ helperId: 'SAIF', departMin: 330, returnMin: 500 }];
    expect(planHelpers([trip('T1', 1, 420, 540, 'SAIF')], [], active, away).helpers.get('T1:1')!.helperIds).toEqual([]);
    expect(planHelpers([trip('T1', 1, 500, 600, 'SAIF')], [], active, away).helpers.get('T1:1')!.helperIds).toEqual(['SAIF']);
    // A helper set by hand stays (the dispatcher's choice), as a hand-set driver.
    expect(planHelpers([trip('T1', 1, 420, 540, 'OMAR')], [ev('T1', 1, 'PLANNED', ['SAIF'], true)], active, away).helpers.get('T1:1')!.helperIds).toEqual(['SAIF']);
  });

  it('a hand-set helper the plan drops is a note: TRIP_GONE (no such trip now) or INACTIVE; the usual helper RouteIQ gave is no note', () => {
    const evidence = [
      ev('T2', 2, 'PLANNED', ['SAIF', 'NASR'], true, 600, 700),
      ev('T1', 1, 'PLANNED', ['OMAR', 'OLD'], true),
      ev('T1', 2, 'PLANNED', ['NASR'], false, 500, 620),
    ];
    const { helpers, notes } = planHelpers([trip('T1', 1, 360, 480, 'SAIF')], evidence, active);
    expect(helpers.get('T1:1')!.helperIds).toEqual(['OMAR']);
    expect(notes).toEqual([
      { truckId: 'T1', loadNo: 1, departMin: 360, returnMin: 480, helperId: 'OLD', reason: 'INACTIVE' },
      { truckId: 'T2', loadNo: 2, departMin: 600, returnMin: 700, helperId: 'SAIF', reason: 'TRIP_GONE' },
      { truckId: 'T2', loadNo: 2, departMin: 600, returnMin: 700, helperId: 'NASR', reason: 'TRIP_GONE' },
    ]);
  });

  it('helper notes are plan warnings until the helper is on a load again (or the trip is back / its helpers set again)', () => {
    const at = '2026-10-13T10:00:00.000Z';
    const gone: HelperChangeNote = { truckId: 'T2', truckCode: 'T02', loadNo: 2, departMin: 600, returnMin: 700, helper: { id: 'SAIF', name: 'Saif' }, reason: 'TRIP_GONE', at };
    const inactive: HelperChangeNote = { ...gone, truckId: 'T1', truckCode: 'T01', loadNo: 1, departMin: 360, returnMin: 480, helper: { id: 'OLD', name: 'Old' }, reason: 'INACTIVE' };
    const t11 = { truckId: 'T1', loadNo: 1, helperIds: ['OMAR'], helpersSetAt: new Date('2026-10-13T09:00:00Z') };
    expect(helperChangeWarnings([gone, inactive], [t11])).toEqual([
      'Helper Saif was set by hand on T02 · L2 (10:00–11:40). This plan has no such trip, so he is on no load: set him on a load if he goes out.',
      'Helper Old was set by hand on T01 · L1 (06:00–08:00) but is inactive, so this plan left him off. Check the helpers of that load.',
    ]);
    expect(helperChangeText(gone)).toContain('Saif');
    // Saif is on a load again; the dispatcher set T01 L1's helpers after the plan.
    const later = { ...t11, helperIds: ['OMAR', 'SAIF'], helpersSetAt: new Date('2026-10-13T11:00:00Z') };
    expect(helperChangeWarnings([gone, inactive], [later])).toEqual([]);
    // The trip is back in a later load change: the TRIP_GONE note ends.
    expect(helperChangeWarnings([gone], [{ truckId: 'T2', loadNo: 2, helperIds: [], helpersSetAt: null }])).toEqual([]);
  });
  it('checkHelpersChange: as the driver - any time until dispatch; the same list is no change', () => {
    expect(checkHelpersChange({ status: 'PLANNED', helperIds: ['A'] }, ['A'])).toEqual({ ok: true, unchanged: true });
    for (const s of ['PLANNED', 'LOCKED', 'LOADING'] as const) expect(checkHelpersChange({ status: s, helperIds: [] }, ['A'])).toEqual({ ok: true, unchanged: false });
    for (const s of ['DISPATCHED', 'COMPLETED'] as const) expect(checkHelpersChange({ status: s, helperIds: ['A'] }, [])).toEqual({ ok: false, reason: 'Helpers cannot change after dispatch.' });
    // The order is part of the list (Helper 1, 2, 3).
    expect(checkHelpersChange({ status: 'PLANNED', helperIds: ['A', 'B'] }, ['B', 'A'])).toEqual({ ok: true, unchanged: false });
    expect(isHandSetHelpers({ helperIds: ['A'], helpersSetById: 'u', helpersSetAt: null })).toBe(true);
    expect(isHandSetHelpers({ helperIds: [], helpersSetById: 'u', helpersSetAt: new Date() })).toBe(false);
  });

  it('helperClashes: a helper on another load at the same time is named', () => {
    const loads = [
      { id: 'L1', truckCode: 'T01', loadNo: 1, departMin: 360, returnMin: 480, helpers: [{ id: 'SAIF', name: 'Saif' }] },
      { id: 'L2', truckCode: 'T02', loadNo: 1, departMin: 400, returnMin: 500, helpers: [{ id: 'SAIF', name: 'Saif' }] },
      { id: 'L3', truckCode: 'T03', loadNo: 1, departMin: 480, returnMin: 600, helpers: [{ id: 'SAIF', name: 'Saif' }] },
    ];
    expect(helperClashes('L1', loads)).toEqual(['Saif is also on T02 · L1 at that time.']);
    expect(helperClashes('L3', loads)).toEqual(['Saif is also on T02 · L1 at that time.']);
  });
});

describe('the Helpers routes: the dispatcher keeps them, the viewer reads, a used code is a 409', () => {
  it('PLANNER adds a helper (201, CREATE audit row); every role lists them; VIEWER cannot add', async () => {
    const res = await answer(await createHelper(json('POST', { code: 'H10', name: 'Khalid', phone: '+968 9555 1234' })));
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ code: 'H10', name: 'Khalid', phone: '+968 9555 1234', active: true });
    expect(audits('CREATE')).toEqual([expect.objectContaining({ entity: 'Helper', userId: 'u-PLANNER', entityId: res.body.data.id })]);
    as('VIEWER');
    expect((await answer(await listHelpers(json('GET')))).body.data.map((h: { code: string }) => h.code)).toContain('H10');
    expect((await createHelper(json('POST', { code: 'H11', name: 'Nope' }))).status).toBe(403);
    expect((await patchHelper(json('PATCH', { name: 'x' }), { params: { id: 'SAIF' } })).status).toBe(403);
    expect(tables.helper!.some((h) => h.code === 'H11')).toBe(false);
  });

  it('a code already used: 409 CODE_TAKEN "Helper code H01 is already used", nothing saved', async () => {
    const res = await answer(await createHelper(json('POST', { code: 'H01', name: 'Another Saif' })));
    expect(res.status).toBe(409);
    expect(res.body.error).toMatchObject({ code: 'CODE_TAKEN', field: 'code', value: 'H01' });
    expect(res.body.error.error).toBe('Helper code H01 is already used. Use another code, or edit that helper.');
    expect(tables.helper!.filter((h) => h.code === 'H01')).toHaveLength(1);
    // The admin renaming a code to one another helper has: the same 409.
    as('TENANT_ADMIN');
    const renamed = await answer(await patchHelper(json('PATCH', { code: 'H02' }), { params: { id: 'SAIF' } }));
    expect(renamed.status).toBe(409);
    expect(renamed.body.error.error).toBe(codeTakenMessage('Helper', 'H02'));
    expect(row('helper', 'SAIF').code).toBe('H01');
  });

  it('two saves at the same instant: the unique key\'s P2002 is answered 409 with the code, not 500', async () => {
    const create = fakePrisma.helper.create;
    fakePrisma.helper.create = async () => {
      throw Object.assign(new Error('Unique constraint failed on the fields: (`tenantId`,`code`)'), { code: 'P2002' });
    };
    try {
      const res = await answer(await createHelper(json('POST', { code: 'H20', name: 'Race' })));
      expect(res.status).toBe(409);
      expect(res.body.error).toMatchObject({ code: 'CODE_TAKEN', value: 'H20' });
    } finally {
      fakePrisma.helper.create = create;
    }
  });

  it('PLANNER edits name, phone and Active (the trucks that keep him are named); a new code is the admin\'s', async () => {
    tables.truck![0]!.defaultHelperId = 'SAIF';
    const ctx = { params: { id: 'SAIF' } };
    expect((await patchHelper(json('PATCH', { code: 'H01', name: 'Saif Al Hinai', phone: '', active: true }), ctx)).status).toBe(200);
    expect(row('helper', 'SAIF')).toMatchObject({ name: 'Saif Al Hinai', phone: null });
    const off = await answer(await patchHelper(json('PATCH', { active: false }), ctx));
    expect(off.status).toBe(200);
    expect(off.body.data.warning).toContain('usual helper of truck T01');
    expect((await patchHelper(json('PATCH', { active: true }), ctx)).status).toBe(200);
    const code = await answer(await patchHelper(json('PATCH', { code: 'H77' }), ctx));
    expect(code.status).toBe(403);
    expect(code.body.error).toMatchObject({ code: 'ADMIN_ONLY_HELPER_FIELD' });
    expect(audits('UPDATE').filter((a) => a.entity === 'Helper')).toHaveLength(3);
  });
});

describe('drivers: a code already used is a 409 too (live bug of 12 Oct 2026: a 500)', () => {
  it('POST a used code: 409 CODE_TAKEN "Driver code D01 is already used"; a race\'s P2002 the same', async () => {
    const res = await answer(await createDriver(json('POST', { code: 'D01', name: 'Second Ali' })));
    expect(res.status).toBe(409);
    expect(res.body.error).toMatchObject({ code: 'CODE_TAKEN', field: 'code', value: 'D01' });
    expect(res.body.error.error).toBe('Driver code D01 is already used. Use another code, or edit that driver.');
    expect(tables.driver!.filter((d) => d.code === 'D01')).toHaveLength(1);
    const create = fakePrisma.driver.create;
    fakePrisma.driver.create = async () => {
      throw Object.assign(new Error('Unique constraint failed'), { code: 'P2002' });
    };
    try {
      expect((await answer(await createDriver(json('POST', { code: 'D02', name: 'Race' })))).body.error).toMatchObject({ code: 'CODE_TAKEN', value: 'D02' });
    } finally {
      fakePrisma.driver.create = create;
    }
  });

  it('the admin renames a driver code to a used one: 409, nothing saved', async () => {
    tables.driver!.push({ id: 'BOB', tenantId: T, code: 'D02', name: 'Bob', phone: null, active: true, casual: false });
    as('TENANT_ADMIN');
    const res = await answer(await patchDriver(json('PATCH', { code: 'D02' }), { params: { id: 'ALI' } }));
    expect(res.status).toBe(409);
    expect(res.body.error.error).toBe(codeTakenMessage('Driver', 'D02'));
    expect(row('driver', 'ALI').code).toBe('D01');
  });

  it('handleError: a P2002 Prisma\'s class was not recognised as is still 409, never 500', async () => {
    const err = Object.assign(new Error('Unique constraint failed'), { code: 'P2002' });
    expect(isUniqueViolation(err)).toBe(true);
    expect(isUniqueViolation(new Error('x'))).toBe(false);
    expect(handleError(err).status).toBe(409);
  });
});

describe("a truck's usual helper: the dispatcher sets it, audited with names", () => {
  it('PLANNER sets and clears it (TRUCK_USUAL_HELPER_SET from / to by name); an inactive helper is refused; VIEWER 403', async () => {
    const ctx = { params: { id: 'T1' } };
    expect((await patchTruck(json('PATCH', { defaultHelperId: 'SAIF' }), ctx)).status).toBe(200);
    expect(row('truck', 'T1').defaultHelperId).toBe('SAIF');
    expect(audits('TRUCK_USUAL_HELPER_SET')[0]!.afterJson).toEqual({ truck: 'T01', from: 'none', to: 'Saif', truckId: 'T1', fromHelperId: null, toHelperId: 'SAIF' });
    const inactive = await answer(await patchTruck(json('PATCH', { defaultHelperId: 'OLD' }), ctx));
    expect(inactive.status).toBe(400);
    expect(row('truck', 'T1').defaultHelperId).toBe('SAIF');
    expect((await patchTruck(json('PATCH', { defaultHelperId: null }), ctx)).status).toBe(200);
    expect(audits('TRUCK_USUAL_HELPER_SET')[1]!.afterJson).toMatchObject({ from: 'Saif', to: 'none' });
    as('VIEWER');
    expect((await patchTruck(json('PATCH', { defaultHelperId: 'SAIF' }), ctx)).status).toBe(403);
  });
});

describe("a load's helpers: set like the driver, audited, kept by the next version", () => {
  const DAY = new Date('2026-10-14T00:00:00Z');
  const load = (id: string, loadNo: number, status: string, extra: Record<string, unknown> = {}) => ({
    id,
    tenantId: T,
    runId: 'P',
    truckId: 'T1',
    loadNo,
    status,
    driverId: 'ALI',
    departMin: 360 + loadNo * 120,
    returnMin: 450 + loadNo * 120,
    distanceKm: 10,
    durationMin: 90,
    cases: 20,
    weightKg: 200,
    utilizationPct: 50,
    fuelLitres: null,
    fuelCost: 1,
    operatingCost: 5,
    returnLegKm: 2,
    distanceIsEstimated: true,
    carriedFromLoadId: null,
    statusChangedAt: null,
    statusChangedById: null,
    helpersSetById: null,
    helpersSetAt: null,
    createdAt: new Date(),
    ...extra,
  });
  function seedPlan() {
    tables.runPlan = [
      {
        id: 'P', tenantId: T, depotId: 'D1', runDate: DAY, status: 'READY', version: 1, reason: 'INITIAL', optimizationMode: 'BALANCED', chosenScenarioId: null,
        parentRunId: null, supersededAt: null, currentJobId: null, finalizedAt: null, totalOrders: 0, unservedCount: 0, summaryJson: null, reconciliationJson: null,
        changeSummaryJson: null, createdById: 'u1', createdAt: new Date(),
      },
    ];
    tables.planLoad = [load('L1', 1, 'LOCKED'), load('L2', 2, 'PLANNED'), load('L3', 3, 'DISPATCHED')];
    tables.planLoadHelper = [{ id: 'h1', tenantId: T, loadId: 'L3', helperId: 'NASR', position: 1, createdAt: new Date() }];
    tables.routeAssignment = [];
    tables.scenarioResult = [];
    tables.runJob = [];
  }
  const user = { id: 'u-PLANNER', role: 'PLANNER' };
  const helpersOn = (loadId: string) => (tables.planLoadHelper ?? []).filter((h) => h.loadId === loadId).sort((a, b) => a.position - b.position).map((h) => h.helperId);

  it('sets 1-3 helpers in order on a planned or locked load, marked as the dispatcher\'s, audited with names', async () => {
    seedPlan();
    await updateLoad(T, 'P', 'L1', { helperIds: ['OMAR', 'SAIF'] }, user, () => true);
    expect(helpersOn('L1')).toEqual(['OMAR', 'SAIF']);
    expect(row('planLoad', 'L1').helpersSetById).toBe('u-PLANNER');
    const a = audits('LOAD_HELPERS_CHANGED')[0]!;
    expect(a).toMatchObject({ entity: 'PlanLoad', entityId: 'L1', userId: 'u-PLANNER' });
    expect(a.beforeJson).toMatchObject({ helperIds: [], helperNames: [] });
    expect(a.afterJson).toMatchObject({ helperIds: ['OMAR', 'SAIF'], helperNames: ['Omar', 'Saif'], runId: 'P', truckId: 'T1', loadNo: 1 });
    await updateLoad(T, 'P', 'L1', { helperIds: [] }, user, () => true);
    expect(helpersOn('L1')).toEqual([]);
    expect(audits('LOAD_HELPERS_CHANGED')[1]!.afterJson).toMatchObject({ helperIds: [], helperNames: [] });
  });

  it('re-sending the same helpers is no change; re-sending ones RouteIQ filled in makes them the dispatcher\'s (kept)', async () => {
    seedPlan();
    tables.planLoadHelper!.push({ id: 'h2', tenantId: T, loadId: 'L2', helperId: 'SAIF', position: 1, createdAt: new Date() });
    await updateLoad(T, 'P', 'L2', { helperIds: ['SAIF'] }, user, () => true);
    expect(row('planLoad', 'L2').helpersSetById).toBe('u-PLANNER');
    expect(audits('LOAD_HELPERS_CHANGED')[0]!.afterJson).toMatchObject({ kept: true });
    await updateLoad(T, 'P', 'L2', { helperIds: ['SAIF'] }, user, () => true);
    expect(audits('LOAD_HELPERS_CHANGED')).toHaveLength(1);
  });

  it('refuses after dispatch (409), an unknown helper (400) and a new inactive one (400); nothing changes', async () => {
    seedPlan();
    await expect(updateLoad(T, 'P', 'L3', { helperIds: [] }, user, () => true)).rejects.toMatchObject({ status: 409, details: { code: 'HELPERS_AFTER_DISPATCH' } });
    expect(helpersOn('L3')).toEqual(['NASR']);
    await expect(updateLoad(T, 'P', 'L2', { helperIds: ['NOPE'] }, user, () => true)).rejects.toMatchObject({ status: 400 });
    await expect(updateLoad(T, 'P', 'L2', { helperIds: ['OLD'] }, user, () => true)).rejects.toMatchObject({ status: 400, message: 'Helper Old is inactive.' });
    expect(helpersOn('L2')).toEqual([]);
    expect(audits('LOAD_HELPERS_CHANGED')).toHaveLength(0);
  });

  it('the route refuses a fourth helper or a helper twice (400) and VIEWER (403)', async () => {
    seedPlan();
    const ctx = { params: { id: 'P', loadId: 'L2' } };
    expect((await patchLoad(json('PATCH', { helperIds: ['SAIF', 'OMAR', 'NASR', 'OLD'] }), ctx)).status).toBe(400);
    expect((await patchLoad(json('PATCH', { helperIds: ['SAIF', 'SAIF'] }), ctx)).status).toBe(400);
    expect((await patchLoad(json('PATCH', { helperIds: ['SAIF', 'OMAR', 'NASR'] }), ctx)).status).toBe(200);
    expect(helpersOn('L2')).toEqual(['SAIF', 'OMAR', 'NASR']);
    as('VIEWER');
    expect((await patchLoad(json('PATCH', { helperIds: [] }), ctx)).status).toBe(403);
    expect(helpersOn('L2')).toEqual(['SAIF', 'OMAR', 'NASR']);
  });

  it('operations alerts (16 Oct 2026): the route takes `loaded: true` only, answers 409 NOT_LOADING on a load not Loading, and VIEWER 403', async () => {
    seedPlan();
    const ctx = { params: { id: 'P', loadId: 'L1' } };
    expect((await patchLoad(json('PATCH', { loaded: false }), ctx)).status).toBe(400);
    expect((await patchLoad(json('PATCH', {}), ctx)).status).toBe(400);
    const locked = await answer(await patchLoad(json('PATCH', { loaded: true }), ctx));
    expect(locked.status).toBe(409);
    expect(locked.body.error).toMatchObject({ code: 'NOT_LOADING' });
    row('planLoad', 'L1').status = 'LOADING';
    const ok = await answer(await patchLoad(json('PATCH', { loaded: true }), ctx));
    expect(ok.status).toBe(200);
    expect(row('planLoad', 'L1').loadedById).toBe('u-PLANNER');
    expect(audits('LOAD_LOADED')).toHaveLength(1);
    as('VIEWER');
    expect((await patchLoad(json('PATCH', { loaded: true }), ctx)).status).toBe(403);
  });

  it('a new plan version copies each load\'s helpers and the hand-set marker with the load', async () => {
    seedPlan();
    await updateLoad(T, 'P', 'L1', { helperIds: ['OMAR', 'SAIF'] }, user, () => true);
    const { child } = await createNextVersion(T, 'P', 'REOPTIMIZE', null, 'u1');
    const copies = tables.planLoad!.filter((l) => l.runId === child.id);
    const copyOf = (from: string) => copies.find((c) => c.carriedFromLoadId === from)!;
    expect(helpersOn(copyOf('L1').id)).toEqual(['OMAR', 'SAIF']);
    expect(copyOf('L1').helpersSetById).toBe('u-PLANNER');
    expect(helpersOn(copyOf('L3').id)).toEqual(['NASR']);
    expect(helpersOn(copyOf('L2').id)).toEqual([]);
    // The parent's rows are untouched.
    expect(helpersOn('L1')).toEqual(['OMAR', 'SAIF']);
  });
});
