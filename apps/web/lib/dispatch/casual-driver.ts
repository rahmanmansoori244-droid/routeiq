/**
 * Daily (casual) drivers added from a load (owner rule 20, 30 Sep 2026: "a load never leaves
 * without a driver; daily drivers exist, so the dispatcher must be able to record a daily driver's
 * name quickly before dispatch"; owner request 4 Oct 2026). POST /api/dispatch/casual-driver.
 *
 * One load-change transaction (inLoadChange: the plan's row lock), then an advisory lock per company
 * and delivery date, then find or create the driver, then set it on the load (setDriverTx: the load
 * must still be at the depot). A refusal anywhere rolls the new driver back too.
 * - A new driver gets the code DAY-<yyMMdd>-<n> (the next n of that day, under the lock), `casual`,
 *   active, no account. A P2002 that still happens (an admin typed that code by hand) aborts the
 *   transaction: the answer is 409 CODE_TAKEN "Try again", never a retry inside the aborted one.
 * - Reuse by phone: a daily driver (active or not) with the same phone and the same name (case and
 *   spaces ignored) is used again, reactivated if needed. Another name, or a regular driver with that
 *   phone: 409 PHONE_BELONGS_TO, and the dialog asks "This phone belongs to <name>. Use <name>?"; the
 *   answer posts again with `useExisting`. The audit never names a driver the dispatcher did not choose.
 */
import { Prisma } from '@prisma/client';
import { audit } from '../audit';
import { DRIVER_PUBLIC_SELECT, type DriverPublic } from '../driver-fields';
import { PlanError } from './plan-errors';
import { inLoadChange } from './plan-service';
import { isoOf } from './time';

/** "2026-10-05" -> "261005". */
function yymmdd(dateIso: string): string {
  return `${dateIso.slice(2, 4)}${dateIso.slice(5, 7)}${dateIso.slice(8, 10)}`;
}

/** The next free DAY-<yyMMdd>-<n> code of a delivery date, given the codes of that day already used. */
export function casualCode(dateIso: string, existing: readonly string[]): string {
  const prefix = `DAY-${yymmdd(dateIso)}-`;
  let max = 0;
  for (const c of existing) {
    if (!c.startsWith(prefix)) continue;
    const n = Number(c.slice(prefix.length));
    if (Number.isInteger(n) && n > max) max = n;
  }
  return `${prefix}${max + 1}`;
}

/** A phone's digits without the international prefix and leading zeros ("+968 9123 4567" -> "96891234567"). */
export function phoneKey(phone: string | null | undefined): string {
  return (phone ?? '').replace(/\D/g, '').replace(/^00/, '').replace(/^0+/, '');
}

/**
 * The same phone: the same digits, or one number is the other with its country code (at least 8
 * digits on both sides: "9123 4567" and "+968 9123 4567").
 */
export function samePhone(a: string | null | undefined, b: string | null | undefined): boolean {
  const x = phoneKey(a);
  const y = phoneKey(b);
  if (!x || !y) return false;
  if (x === y) return true;
  return Math.min(x.length, y.length) >= 8 && (x.endsWith(y) || y.endsWith(x));
}

/** The same name, case and spaces ignored. */
export function sameName(a: string, b: string): boolean {
  return a.replace(/\s+/g, '').toLowerCase() === b.replace(/\s+/g, '').toLowerCase();
}

export interface AddCasualDriverInput {
  runId: string;
  loadId: string;
  name: string;
  phone?: string | null;
  useExisting?: string;
}

export interface AddCasualDriverResult {
  driver: DriverPublic;
  load: { id: string; driverId: string | null; truckId: string; loadNo: number; status: string };
  reused: boolean;
}

function isUniqueViolation(e: unknown): boolean {
  return e instanceof Prisma.PrismaClientKnownRequestError ? e.code === 'P2002' : (e as { code?: unknown } | null)?.code === 'P2002';
}

export async function addCasualDriver(tenantId: string, input: AddCasualDriverInput, user: { id: string }): Promise<AddCasualDriverResult> {
  try {
    return await inLoadChange(tenantId, input.runId, async (tx, run, setDriver) => {
      const load = await tx.planLoad.findFirst({ where: { id: input.loadId, runId: run.id, tenantId }, select: { id: true, status: true } });
      if (!load) throw new PlanError('Load not found.', 404);
      if (load.status === 'DISPATCHED' || load.status === 'COMPLETED') {
        throw new PlanError('The load has left: its driver cannot change any more.', 409, { code: 'LOAD_ON_ROAD' });
      }
      const date = isoOf(run.runDate);
      await tx.$queryRaw`SELECT 1 AS locked FROM pg_advisory_xact_lock(hashtextextended(${`casual-driver:${tenantId}|${date}`}, 0))`;

      let driver: DriverPublic | null = null;
      let reused = false;
      if (input.useExisting) {
        driver = await tx.driver.findFirst({ where: { id: input.useExisting, tenantId }, select: DRIVER_PUBLIC_SELECT });
        if (!driver) throw new PlanError('Driver not found.', 404);
        reused = true;
      } else if (input.phone) {
        const withPhone = await tx.driver.findMany({ where: { tenantId, phone: { not: null } }, select: DRIVER_PUBLIC_SELECT, orderBy: { code: 'asc' } });
        const matches = withPhone.filter((d) => samePhone(d.phone, input.phone));
        // A daily driver with this phone and this name: the same person, used again.
        const same = matches.find((d) => d.casual && sameName(d.name, input.name));
        if (same) {
          driver = same;
          reused = true;
        } else if (matches.length) {
          const other = matches.find((d) => d.casual) ?? matches[0]!;
          throw new PlanError(
            `This phone belongs to ${other.casual ? 'daily driver' : 'driver'} ${other.name}. Use ${other.name}, or change the phone.`,
            409,
            { code: 'PHONE_BELONGS_TO', driverId: other.id, name: other.name, casual: other.casual },
          );
        }
      }
      if (driver && !driver.active) {
        const before = driver;
        driver = await tx.driver.update({ where: { id: driver.id }, data: { active: true }, select: DRIVER_PUBLIC_SELECT });
        await audit({ tenantId, userId: user.id, action: 'UPDATE', entity: 'Driver', entityId: driver.id, beforeJson: before, afterJson: { ...driver, reactivatedFrom: 'daily driver quick add' } }, tx);
      }
      if (!driver) {
        const used = await tx.driver.findMany({ where: { tenantId, code: { startsWith: `DAY-${yymmdd(date)}-` } }, select: { code: true } });
        driver = await tx.driver.create({
          data: { tenantId, code: casualCode(date, used.map((d) => d.code)), name: input.name.trim(), phone: input.phone?.trim() || null, casual: true, active: true },
          select: DRIVER_PUBLIC_SELECT,
        });
        await audit({ tenantId, userId: user.id, action: 'CASUAL_DRIVER_ADDED', entity: 'Driver', entityId: driver.id, afterJson: { ...driver, runId: run.id, loadId: load.id, date } }, tx);
      }
      const updated = await setDriver(load.id, driver.id, user);
      return {
        driver,
        load: { id: updated.id, driverId: updated.driverId, truckId: updated.truckId, loadNo: updated.loadNo, status: updated.status },
        reused,
      };
    });
  } catch (e) {
    if (isUniqueViolation(e)) {
      throw new PlanError('Another driver got that code at the same moment. Try again.', 409, { code: 'CODE_TAKEN' });
    }
    throw e;
  }
}
