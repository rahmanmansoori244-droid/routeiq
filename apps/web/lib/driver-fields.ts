/**
 * The Driver columns any screen or API may send (review F13). Never select a whole Driver row for
 * a response, a page prop or an audit row: it carries `accessPinHash` (legacy driver-app PIN).
 * tests/lib/repo-guards.spec.ts fails on a `driver.find*` / `driver.create|update` under app/
 * without a `select`.
 */
import type { Prisma } from '@prisma/client';

export const DRIVER_PUBLIC_SELECT = {
  id: true,
  tenantId: true,
  code: true,
  name: true,
  phone: true,
  active: true,
} as const satisfies Prisma.DriverSelect;

export type DriverPublic = Prisma.DriverGetPayload<{ select: typeof DRIVER_PUBLIC_SELECT }>;
