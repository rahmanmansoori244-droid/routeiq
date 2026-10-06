/**
 * Driver leave on the database (owner request 6 Oct 2026): list, add, change and remove a driver's
 * leave periods. The rules are pure (driver-leave.ts); this file reads, locks and writes. Every write
 * runs in one transaction under the driver's row lock (SELECT ... FOR UPDATE), so two saves for one
 * driver cannot both pass the overlap check, and is audited (DRIVER_LEAVE_ADDED / _CHANGED /
 * _REMOVED: who, when, the period before and after). "Today" is the company's date (its time zone).
 */
import type { Prisma } from '@prisma/client';
import { audit } from '@/lib/audit';
import { HttpError } from '@/lib/http-error';
import { tenantDb } from '@/lib/tenant';
import type { DriverLeaveInput } from '@/lib/schemas';
import {
  checkLeaveChange,
  checkLeaveRemove,
  checkNewLeave,
  coverAwayDuring,
  coverAwayWarning,
  leavePhase,
  type LeaveCheck,
  type LeavePeriod,
  type LeavePhase,
} from './driver-leave';
import { dateOnly, DEFAULT_TZ, fmtDayMonth, isoOf, todayIso } from './time';

/** One leave period as the Drivers page and the API show it. */
export interface LeaveView {
  id: string;
  driverId: string;
  from: string;
  until: string;
  note: string | null;
  coverDriverId: string | null;
  coverName: string | null;
  phase: LeavePhase;
  createdAt: string;
  updatedAt: string;
}

const LEAVE_SELECT = {
  id: true,
  driverId: true,
  fromDate: true,
  untilDate: true,
  note: true,
  coverDriverId: true,
  createdAt: true,
  updatedAt: true,
} as const satisfies Prisma.DriverLeaveSelect;

type LeaveRow = Prisma.DriverLeaveGetPayload<{ select: typeof LEAVE_SELECT }>;

export function toLeavePeriod(r: Pick<LeaveRow, 'id' | 'driverId' | 'fromDate' | 'untilDate' | 'note' | 'coverDriverId'>): LeavePeriod {
  return { id: r.id, driverId: r.driverId, fromIso: isoOf(r.fromDate), untilIso: isoOf(r.untilDate), note: r.note ?? null, coverDriverId: r.coverDriverId ?? null };
}

function toView(r: LeaveRow, names: ReadonlyMap<string, string>, today: string): LeaveView {
  const p = toLeavePeriod(r);
  return {
    id: p.id,
    driverId: p.driverId,
    from: p.fromIso,
    until: p.untilIso,
    note: p.note,
    coverDriverId: p.coverDriverId,
    coverName: p.coverDriverId ? (names.get(p.coverDriverId) ?? 'Unknown driver') : null,
    phase: leavePhase(p, today),
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  };
}

/** The tenant-scoped transaction client (typed as a plain transaction client, as plan-detail does). */
type Tx = Prisma.TransactionClient;

/** The company's date today (its time zone). */
async function companyToday(db: Pick<Tx, 'tenantConfig'>, tenantId: string, now: Date): Promise<string> {
  const cfg = await db.tenantConfig.findFirst({ where: { tenantId }, select: { timezone: true } });
  return todayIso(cfg?.timezone || DEFAULT_TZ, now);
}

function refuseUnless(check: LeaveCheck): void {
  if (!check.ok) throw new HttpError(check.reason, check.status, { code: check.code });
}

/** The driver's row, locked for this transaction (404 when the company has no such driver). */
async function lockDriver(tx: Tx, tenantId: string, driverId: string): Promise<{ id: string; name: string; active: boolean }> {
  const rows = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM "Driver" WHERE id = ${driverId} AND "tenantId" = ${tenantId} FOR UPDATE`;
  const driver = rows.length ? await tx.driver.findFirst({ where: { id: driverId, tenantId }, select: { id: true, name: true, active: true } }) : null;
  if (!driver) throw new HttpError('Driver not found.', 404);
  return driver;
}

async function coverOf(tx: Tx, tenantId: string, coverDriverId: string | null | undefined): Promise<{ id: string; name: string; active: boolean } | null> {
  if (!coverDriverId) return null;
  return tx.driver.findFirst({ where: { id: coverDriverId, tenantId }, select: { id: true, name: true, active: true } });
}

/** What the audit row keeps of a period: its dates, note and cover, with the names at that time. */
function auditPeriod(p: LeavePeriod, driverName: string, coverName: string | null) {
  return { driverId: p.driverId, driverName, from: p.fromIso, until: p.untilIso, note: p.note, coverDriverId: p.coverDriverId, coverName };
}

/**
 * Warnings saved with a period (the save goes through): the cover is on leave himself part of the
 * time, and the driver is still on loads planned on those days (live plan versions, loads not out yet).
 */
async function leaveWarnings(tx: Tx, tenantId: string, period: LeavePeriod, driverName: string, cover: { name: string } | null): Promise<string[]> {
  const out: string[] = [];
  if (period.coverDriverId && cover) {
    const coverPeriods = (await tx.driverLeave.findMany({ where: { tenantId, driverId: period.coverDriverId }, select: LEAVE_SELECT })).map(toLeavePeriod);
    const away = coverAwayDuring(coverPeriods, period);
    if (away) out.push(coverAwayWarning(cover.name, away));
  }
  const loads = await tx.planLoad.findMany({
    where: {
      tenantId,
      driverId: period.driverId,
      status: { in: ['PLANNED', 'LOCKED', 'LOADING'] },
      run: { runDate: { gte: dateOnly(period.fromIso), lte: dateOnly(period.untilIso) }, status: { not: 'SUPERSEDED' }, supersededAt: null },
    },
    select: { loadNo: true, truck: { select: { code: true } }, run: { select: { runDate: true } } },
    orderBy: [{ run: { runDate: 'asc' } }, { truck: { code: 'asc' } }, { loadNo: 'asc' }],
  });
  // The fake database of the unit tests ignores the relation filter: keep the loads of those days only.
  const inside = loads.filter((l) => {
    const day = l.run?.runDate ? isoOf(l.run.runDate) : null;
    return day !== null && day >= period.fromIso && day <= period.untilIso;
  });
  if (inside.length) {
    const list = inside
      .slice(0, 5)
      .map((l) => `${l.truck?.code ?? 'truck'} · L${l.loadNo} on ${fmtDayMonth(isoOf(l.run!.runDate))}`)
      .join(', ');
    out.push(
      `${driverName} is still the driver of ${inside.length} load(s) planned on those days (${list}${inside.length > 5 ? ', ...' : ''}): pick another driver on the plan, or re-plan (a driver picked by hand stays).`,
    );
  }
  return out;
}

/** A driver's leave periods, the latest first (ended ones included: kept for the record). */
export async function listDriverLeave(tenantId: string, driverId: string, now = new Date()): Promise<{ driver: { id: string; name: string }; today: string; periods: LeaveView[] }> {
  const db = tenantDb(tenantId);
  const driver = await db.driver.findFirst({ where: { id: driverId, tenantId }, select: { id: true, name: true } });
  if (!driver) throw new HttpError('Driver not found.', 404);
  const today = await companyToday(db as unknown as Tx, tenantId, now);
  const rows = await db.driverLeave.findMany({ where: { tenantId, driverId }, select: LEAVE_SELECT, orderBy: { fromDate: 'desc' } });
  const covers = [...new Set(rows.map((r) => r.coverDriverId).filter((x): x is string => !!x))];
  const names = new Map((await db.driver.findMany({ where: { tenantId, id: { in: covers } }, select: { id: true, name: true } })).map((d) => [d.id, d.name]));
  return { driver, today, periods: rows.map((r) => toView(r, names, today)) };
}

export interface LeaveSaveResult {
  leave: LeaveView;
  warnings: string[];
}

export async function addDriverLeave(tenantId: string, driverId: string, input: DriverLeaveInput, user: { id: string }, now = new Date()): Promise<LeaveSaveResult> {
  const db = tenantDb(tenantId);
  return db.$transaction(async (scoped) => {
    const tx = scoped as unknown as Tx;
    const driver = await lockDriver(tx, tenantId, driverId);
    const today = await companyToday(tx, tenantId, now);
    const cover = await coverOf(tx, tenantId, input.coverDriverId);
    const existing = (await tx.driverLeave.findMany({ where: { tenantId, driverId }, select: LEAVE_SELECT })).map(toLeavePeriod);
    const cand = { driverId, fromIso: input.from, untilIso: input.until, coverDriverId: input.coverDriverId ?? null };
    refuseUnless(checkNewLeave(cand, existing, today, cover));
    const row = await tx.driverLeave.create({
      data: {
        tenantId,
        driverId,
        fromDate: dateOnly(input.from),
        untilDate: dateOnly(input.until),
        note: input.note ?? null,
        coverDriverId: input.coverDriverId ?? null,
        createdById: user.id,
        updatedById: user.id,
      },
      select: LEAVE_SELECT,
    });
    const period = toLeavePeriod(row);
    await audit(
      { tenantId, userId: user.id, action: 'DRIVER_LEAVE_ADDED', entity: 'DriverLeave', entityId: row.id, afterJson: auditPeriod(period, driver.name, cover?.name ?? null) },
      tx,
    );
    const names = new Map(cover ? [[cover.id, cover.name]] : []);
    return { leave: toView(row, names, today), warnings: await leaveWarnings(tx, tenantId, period, driver.name, cover) };
  });
}

export async function changeDriverLeave(
  tenantId: string,
  driverId: string,
  leaveId: string,
  input: DriverLeaveInput,
  user: { id: string },
  now = new Date(),
): Promise<LeaveSaveResult> {
  const db = tenantDb(tenantId);
  return db.$transaction(async (scoped) => {
    const tx = scoped as unknown as Tx;
    const driver = await lockDriver(tx, tenantId, driverId);
    const today = await companyToday(tx, tenantId, now);
    const beforeRow = await tx.driverLeave.findFirst({ where: { id: leaveId, tenantId, driverId }, select: LEAVE_SELECT });
    if (!beforeRow) throw new HttpError('Leave period not found.', 404);
    const before = toLeavePeriod(beforeRow);
    const cover = await coverOf(tx, tenantId, input.coverDriverId);
    const existing = (await tx.driverLeave.findMany({ where: { tenantId, driverId }, select: LEAVE_SELECT })).map(toLeavePeriod);
    const cand = { driverId, fromIso: input.from, untilIso: input.until, coverDriverId: input.coverDriverId ?? null };
    refuseUnless(checkLeaveChange(before, cand, existing, today, cover));
    const row = await tx.driverLeave.update({
      where: { id: leaveId },
      data: { fromDate: dateOnly(input.from), untilDate: dateOnly(input.until), note: input.note ?? null, coverDriverId: input.coverDriverId ?? null, updatedById: user.id },
      select: LEAVE_SELECT,
    });
    const period = toLeavePeriod(row);
    const beforeCover = before.coverDriverId ? await coverOf(tx, tenantId, before.coverDriverId) : null;
    await audit(
      {
        tenantId,
        userId: user.id,
        action: 'DRIVER_LEAVE_CHANGED',
        entity: 'DriverLeave',
        entityId: row.id,
        beforeJson: auditPeriod(before, driver.name, beforeCover?.name ?? null),
        afterJson: auditPeriod(period, driver.name, cover?.name ?? null),
      },
      tx,
    );
    const names = new Map(cover ? [[cover.id, cover.name]] : []);
    return { leave: toView(row, names, today), warnings: await leaveWarnings(tx, tenantId, period, driver.name, cover) };
  });
}

export async function removeDriverLeave(tenantId: string, driverId: string, leaveId: string, user: { id: string }, now = new Date()): Promise<{ removed: true; id: string }> {
  const db = tenantDb(tenantId);
  return db.$transaction(async (scoped) => {
    const tx = scoped as unknown as Tx;
    const driver = await lockDriver(tx, tenantId, driverId);
    const today = await companyToday(tx, tenantId, now);
    const beforeRow = await tx.driverLeave.findFirst({ where: { id: leaveId, tenantId, driverId }, select: LEAVE_SELECT });
    if (!beforeRow) throw new HttpError('Leave period not found.', 404);
    const before = toLeavePeriod(beforeRow);
    refuseUnless(checkLeaveRemove(before, today));
    await tx.driverLeave.delete({ where: { id: leaveId } });
    const cover = before.coverDriverId ? await coverOf(tx, tenantId, before.coverDriverId) : null;
    await audit(
      { tenantId, userId: user.id, action: 'DRIVER_LEAVE_REMOVED', entity: 'DriverLeave', entityId: leaveId, beforeJson: auditPeriod(before, driver.name, cover?.name ?? null) },
      tx,
    );
    return { removed: true as const, id: leaveId };
  });
}

/**
 * Who is on leave on `dayIso`, with their cover (planDrivers and the plan screen read it). `db` is a
 * transaction or tenant client; the where carries the company too.
 */
export async function leaveRowsOn(db: Pick<Tx, 'driverLeave'>, tenantId: string, day: Date): Promise<LeavePeriod[]> {
  return (await db.driverLeave.findMany({ where: { tenantId, fromDate: { lte: day }, untilDate: { gte: day } }, select: LEAVE_SELECT })).map(toLeavePeriod);
}

/** The periods that touch [today, today + days]: the Drivers page's "Drivers on leave". */
export async function upcomingLeaveRows(tenantId: string, todayIsoValue: string, lastIso: string): Promise<LeavePeriod[]> {
  const db = tenantDb(tenantId);
  return (
    await db.driverLeave.findMany({
      where: { tenantId, fromDate: { lte: dateOnly(lastIso) }, untilDate: { gte: dateOnly(todayIsoValue) } },
      select: LEAVE_SELECT,
      orderBy: [{ fromDate: 'asc' }, { untilDate: 'asc' }],
    })
  ).map(toLeavePeriod);
}
