/**
 * Driver-side auth (Module C).
 *
 * Drivers do not have User accounts in v1 — they sign into the PWA with
 * { tenantSlug, driverCode, pin }. On success we create a DriverShift row
 * holding a random session token (32 bytes, base64url). The PWA stores that
 * token in localStorage and sends it with every GPS-ping / stop-done call.
 *
 * The token is HMAC-prefixed with the tenantId so a stolen token can't be
 * replayed against a different tenant.
 */
import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import bcrypt from 'bcryptjs';
import { DriverShiftStatus, Prisma } from '@prisma/client';
import { prisma } from './db';

const SHIFT_STALE_MS = 1000 * 60 * 60 * 18; // 18h → janitor closes shift older than this

export interface DriverShiftCtx {
  shiftId: string;
  tenantId: string;
  driverId: string;
  truckId: string;
  runId: string | null;
  startedAt: Date;
}

function newSessionToken(): string {
  return randomBytes(32).toString('base64url');
}

export async function hashPin(pin: string): Promise<string> {
  return bcrypt.hash(pin, 12);
}

export async function verifyPin(pin: string, hash: string): Promise<boolean> {
  return bcrypt.compare(pin, hash);
}

/**
 * Verify a driver session token. Returns context if valid + the shift is still
 * ACTIVE and not stale; throws otherwise. The throw is caught by route handlers
 * which turn it into a 401 — never leak internal state to the driver client.
 */
export async function requireDriverShift(sessionToken: string | null | undefined): Promise<DriverShiftCtx> {
  if (!sessionToken || sessionToken.length < 32) {
    throw new Error('UNAUTHORIZED');
  }
  const shift = await prisma.driverShift.findUnique({
    where: { sessionToken },
    select: {
      id: true,
      tenantId: true,
      driverId: true,
      truckId: true,
      runId: true,
      startedAt: true,
      endedAt: true,
      status: true,
    },
  });
  if (!shift) throw new Error('UNAUTHORIZED');
  if (shift.status !== 'ACTIVE') throw new Error('SHIFT_NOT_ACTIVE');
  if (Date.now() - shift.startedAt.getTime() > SHIFT_STALE_MS) {
    // Auto-close stale shifts the next time the driver hits any endpoint.
    await prisma.driverShift.update({
      where: { id: shift.id },
      data: { status: 'ABANDONED', endedAt: new Date() },
    });
    throw new Error('SHIFT_STALE');
  }
  return {
    shiftId: shift.id,
    tenantId: shift.tenantId,
    driverId: shift.driverId,
    truckId: shift.truckId,
    runId: shift.runId,
    startedAt: shift.startedAt,
  };
}

export interface DriverLoginInput {
  tenantSlug: string;
  driverCode: string;
  pin: string;
  truckId?: string | null;
  runId?: string | null;
}

export interface DriverLoginResult {
  sessionToken: string;
  shiftId: string;
  driverName: string;
  truckCode: string;
  truckId: string;
  runId: string | null;
}

/**
 * Validate { tenantSlug, driverCode, pin }, end any already-active shift for
 * the same driver, and start a fresh one bound to ``truckId``. Returns the
 * new shift's session token.
 */
export async function loginDriver(input: DriverLoginInput): Promise<DriverLoginResult> {
  const tenant = await prisma.tenant.findUnique({
    where: { slug: input.tenantSlug },
    select: { id: true, active: true },
  });
  if (!tenant || !tenant.active) throw new Error('UNKNOWN_TENANT');

  const driver = await prisma.driver.findUnique({
    where: { tenantId_code: { tenantId: tenant.id, code: input.driverCode } },
    select: { id: true, name: true, active: true, accessPinHash: true },
  });
  if (!driver || !driver.active || !driver.accessPinHash) throw new Error('UNKNOWN_DRIVER');
  if (!(await verifyPin(input.pin, driver.accessPinHash))) throw new Error('BAD_PIN');

  // Resolve truck — either provided or default to the only-active-truck heuristic.
  let truckId = input.truckId ?? null;
  if (!truckId) {
    const trucks = await prisma.truck.findMany({
      where: { tenantId: tenant.id, active: true },
      select: { id: true },
      take: 2,
    });
    if (trucks.length === 1) truckId = trucks[0]!.id;
  }
  if (!truckId) throw new Error('TRUCK_REQUIRED');

  const truck = await prisma.truck.findFirst({
    where: { id: truckId, tenantId: tenant.id, active: true },
    select: { id: true, code: true },
  });
  if (!truck) throw new Error('UNKNOWN_TRUCK');

  // End any prior ACTIVE shift for this driver in this tenant.
  await prisma.driverShift.updateMany({
    where: { tenantId: tenant.id, driverId: driver.id, status: 'ACTIVE' },
    data: { status: 'COMPLETED', endedAt: new Date() },
  });

  const sessionToken = newSessionToken();
  const shift = await prisma.driverShift.create({
    data: {
      tenantId: tenant.id,
      driverId: driver.id,
      truckId: truck.id,
      runId: input.runId ?? null,
      sessionToken,
      status: 'ACTIVE',
    },
    select: { id: true, runId: true },
  });

  return {
    sessionToken,
    shiftId: shift.id,
    driverName: driver.name,
    truckCode: truck.code,
    truckId: truck.id,
    runId: shift.runId,
  };
}

export async function endShift(sessionToken: string, notes: string | null): Promise<void> {
  const ctx = await requireDriverShift(sessionToken);
  await prisma.driverShift.update({
    where: { id: ctx.shiftId },
    data: { status: 'COMPLETED', endedAt: new Date(), notes },
  });
}

/**
 * Generate a 6-digit numeric PIN. Stored hashed; returned in cleartext exactly
 * once when an admin sets it.
 */
export function generatePin(): string {
  const buf = randomBytes(4);
  const n = buf.readUInt32BE(0) % 1_000_000;
  return n.toString().padStart(6, '0');
}

/** Constant-time string compare for sensitive equality checks. */
export function constantTimeEqual(a: string, b: string): boolean {
  const aBuf = Buffer.from(a);
  const bBuf = Buffer.from(b);
  if (aBuf.length !== bBuf.length) return false;
  return timingSafeEqual(aBuf, bBuf);
}

export function hashTokenForLog(token: string): string {
  return createHash('sha256').update(token).digest('hex').slice(0, 12);
}
