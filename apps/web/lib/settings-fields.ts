/**
 * The tenant settings the Settings page edits (review F21): exactly the fields of
 * tenantConfigSchema, i.e. the ones the daily dispatch planner reads. Kept in a plain module so
 * both the server page and the client form can import it.
 */
import type { TenantConfig } from '@prisma/client';

export const SETTINGS_FIELDS = [
  'shiftStartMin',
  'driverShiftMaxMinutes',
  'overtimeAfterMin',
  'reloadMinutes',
  'loadingMinPerCase',
  'serviceMinPerCase',
  'defaultServiceTimeMin',
  'maxTripsPerTruck',
  'splitDeliveries',
  'planningCutoffMin',
  'dateOrder',
  'fuelPricePerLitre',
  'driverCostPerHour',
  'overtimeCostPerHour',
  'prefWindowPenaltyPerMin',
  'distanceProvider',
  'roadTimeFactor',
  'distanceMultiplier',
  'avgSpeedKmh',
] as const satisfies readonly (keyof TenantConfig)[];

export type SettingsField = (typeof SETTINGS_FIELDS)[number];
export type EditableConfig = Pick<TenantConfig, SettingsField>;

export const TENANT_FIELDS = ['name', 'country', 'currency', 'primaryUnit'] as const;
export type TenantField = (typeof TENANT_FIELDS)[number];

/**
 * The fields of `current` that differ from `baseline`, and the baseline value of each (what the
 * page showed, sent as the save's precondition): { changes, expect }.
 */
export function changedFields<T extends Record<string, unknown>>(baseline: T, current: T): { changes: Partial<T>; expect: Partial<T> } {
  const changes: Partial<T> = {};
  const expect: Partial<T> = {};
  for (const k of Object.keys(current) as (keyof T)[]) {
    const a = baseline[k];
    const b = current[k];
    const same = typeof a === 'number' && typeof b === 'number' ? Math.abs(a - b) < 1e-9 : a === b;
    if (!same) {
      changes[k] = b;
      expect[k] = a;
    }
  }
  return { changes, expect };
}

/**
 * Overtime cannot start after the shift ends (checked on the merged settings, not only the patch).
 */
export function overtimeProblem(v: { overtimeAfterMin: number; driverShiftMaxMinutes: number }): string | null {
  return v.overtimeAfterMin > v.driverShiftMaxMinutes
    ? `Overtime after (${v.overtimeAfterMin} min) must be at most the driver shift maximum (${v.driverShiftMaxMinutes} min).`
    : null;
}

/**
 * The overtime rule as a save applies it (the settings route and the Settings form alike): only a
 * save that changes the overtime threshold or the shift maximum is held to it. A stored threshold
 * after a lowered shift maximum (possible before overtime was editable) is a planner warning
 * (planner-config.ts), never a reason to refuse saving the company name or another setting.
 */
export function overtimeSaveProblem(
  changed: Record<string, unknown>,
  merged: { overtimeAfterMin: number; driverShiftMaxMinutes: number },
): string | null {
  if (!('overtimeAfterMin' in changed) && !('driverShiftMaxMinutes' in changed)) return null;
  return overtimeProblem(merged);
}
