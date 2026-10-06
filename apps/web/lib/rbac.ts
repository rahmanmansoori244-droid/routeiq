import type { Role } from '@prisma/client';

const RANK: Record<Role, number> = {
  SUPER_ADMIN: 100,
  TENANT_ADMIN: 80,
  SUPERVISOR: 60,
  PLANNER: 50,
  VIEWER: 10,
};

export function canManageMasterData(role: Role): boolean {
  return RANK[role] >= RANK.TENANT_ADMIN;
}

export function canPlan(role: Role): boolean {
  return RANK[role] >= RANK.PLANNER;
}

export function canApproveOverride(role: Role): boolean {
  return RANK[role] >= RANK.SUPERVISOR;
}

export function canView(role: Role): boolean {
  return RANK[role] >= RANK.VIEWER;
}

export function requireRole(role: Role, min: Role): boolean {
  return RANK[role] >= RANK[min];
}

/**
 * The truck fields a dispatcher (PLANNER and SUPERVISOR) may change: the usual (default) driver only
 * (owner request 6 Oct 2026: drivers change a lot and the dispatcher follows them). Bays, costs,
 * capacity, availability, depot, code, active and hired stay the company admin's.
 */
export const DISPATCHER_TRUCK_FIELDS: readonly string[] = ['defaultDriverId'];

/** The fields of a truck change `role` may not make (empty: allowed). Fields left out (undefined) are not changes. */
export function truckFieldsRefused(role: Role, input: Record<string, unknown>): string[] {
  if (canManageMasterData(role)) return [];
  return Object.keys(input).filter((k) => input[k] !== undefined && !DISPATCHER_TRUCK_FIELDS.includes(k));
}

/**
 * The driver changes `role` may not make (empty: allowed). The dispatcher (PLANNER and up) adds
 * drivers, edits the name and the mobile, activates and deactivates them, and makes a daily driver a
 * regular one (owner request 6 Oct 2026). Changing a driver's code, or making a regular driver a
 * daily one, stays the company admin's. A field sent unchanged (the form sends every field) is not a change.
 */
export function driverChangesRefused(role: Role, before: { code: string; casual: boolean }, input: { code?: string; casual?: boolean }): string[] {
  if (canManageMasterData(role)) return [];
  const out: string[] = [];
  if (input.code !== undefined && input.code !== before.code) out.push('code');
  if (input.casual === true && !before.casual) out.push('casual');
  return out;
}
