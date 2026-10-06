/**
 * A one-day hired truck (the hire suggestion's "Use this plan", owner request 6 Oct 2026): the
 * dispatcher (PLANNER and above) enters its real plate - the truck's code - and may set its default
 * driver. Every other truck field stays with the company admin (Trucks page). Server only.
 *
 * A rental company may send the same truck again on another day: a plate already used by a one-day
 * hired truck of a day that is OVER is freed for it (that truck's code becomes "<plate>.<YYMMDD>",
 * audited on that truck too; its own plans still show the plate, hire.ts shownTruckCode). A plate of an
 * own truck, or of a hired truck whose day is not over - today's, possibly out on a dispatched load,
 * or a coming day's - is refused (review of the hire branch: today's truck was renamed mid-shift):
 * the answer suggests "<plate>-2".
 */
import { prisma } from '../db';
import { audit } from '../audit';
import { HttpError } from '../http-error';
import { freedCode } from './hire';
import { DEFAULT_TZ, isoOf, todayIso } from './time';

export class HiredTruckRefused extends HttpError {
  constructor(message: string, code: string, status = 409) {
    super(message, status, { code });
  }
}

export { freedCode };

export async function setHiredTruck(
  tenantId: string,
  truckId: string,
  input: { code?: string; defaultDriverId?: string | null },
  user: { id: string },
  ip: string | null,
) {
  return prisma.$transaction(async (tx) => {
    const truck = await tx.truck.findFirst({ where: { id: truckId, tenantId } });
    if (!truck) throw new HiredTruckRefused('Truck not found.', 'NOT_FOUND', 404);
    if (!truck.hired || !truck.onlyOnDate) {
      throw new HiredTruckRefused('Only a one-day hired truck can be changed here. A company admin changes other trucks on the Trucks page.', 'NOT_ONE_DAY', 403);
    }
    const cfg = await tx.tenantConfig.findFirst({ where: { tenantId }, select: { timezone: true } });
    const today = todayIso(cfg?.timezone || DEFAULT_TZ);
    if (isoOf(truck.onlyOnDate) < today) {
      throw new HiredTruckRefused(`This truck was hired for ${isoOf(truck.onlyOnDate)}, a day that is over.`, 'DAY_OVER');
    }
    const data: { code?: string; defaultDriverId?: string | null } = {};
    const freed: { id: string; from: string; to: string }[] = [];
    if (input.code !== undefined && input.code !== truck.code) {
      const other = await tx.truck.findFirst({ where: { tenantId, code: input.code } });
      if (other) {
        // Only from a hired truck whose day is over: today's may be out on a dispatched load (its
        // sheets, driver page and WhatsApp name it), a coming day's is still to drive.
        const dayOver = other.hired && !!other.onlyOnDate && isoOf(other.onlyOnDate) < today;
        if (!dayOver) {
          throw new HiredTruckRefused(
            other.onlyOnDate
              ? `Truck code ${input.code} is used by the truck hired for ${isoOf(other.onlyOnDate)}, a day that is not over. Use another code for this day (e.g. ${input.code}-2).`
              : `Truck code ${input.code} is already one of your trucks. Enter the hired truck's own plate.`,
            'CODE_TAKEN',
          );
        }
        const to = freedCode(other.code, other.onlyOnDate!);
        await tx.truck.update({ where: { id: other.id }, data: { code: to } });
        freed.push({ id: other.id, from: other.code, to });
        // The renamed truck's own audit row: its code changed too.
        await audit(
          {
            tenantId,
            userId: user.id,
            action: 'HIRED_TRUCK_CHANGED',
            entity: 'Truck',
            entityId: other.id,
            beforeJson: { code: other.code } as never,
            afterJson: { code: to, date: isoOf(other.onlyOnDate!), plateTakenBy: { id: truck.id, date: isoOf(truck.onlyOnDate) } } as never,
            ip,
          },
          tx,
        );
      }
      data.code = input.code;
    }
    if (input.defaultDriverId !== undefined && input.defaultDriverId !== truck.defaultDriverId) {
      if (input.defaultDriverId) {
        const driver = await tx.driver.findFirst({ where: { id: input.defaultDriverId, tenantId }, select: { id: true, name: true, active: true } });
        if (!driver) throw new HiredTruckRefused('Driver not found.', 'DRIVER_NOT_FOUND', 400);
        if (!driver.active) throw new HiredTruckRefused(`Driver ${driver.name} is inactive.`, 'DRIVER_INACTIVE', 400);
      }
      data.defaultDriverId = input.defaultDriverId;
    }
    if (!Object.keys(data).length) return truck;
    const after = await tx.truck.update({ where: { id: truck.id }, data });
    await audit(
      {
        tenantId,
        userId: user.id,
        action: 'HIRED_TRUCK_CHANGED',
        entity: 'Truck',
        entityId: truck.id,
        beforeJson: { code: truck.code, defaultDriverId: truck.defaultDriverId } as never,
        afterJson: { code: after.code, defaultDriverId: after.defaultDriverId, date: isoOf(truck.onlyOnDate), ...(freed.length ? { codeFreedFrom: freed } : {}) } as never,
        ip,
      },
      tx,
    );
    return after;
  });
}
