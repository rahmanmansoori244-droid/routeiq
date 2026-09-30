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
  'driverBreakMinutes',
  'driverBreakFromMin',
  'driverBreakToMin',
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

/**
 * The settings the dispatcher (PLANNER role and up) may change on Settings (owner decision 29 Sep
 * 2026): the driver shift - first departure, the shift maximum (the latest return is first
 * departure + shift maximum) and when overtime starts. Every other setting (cost rates, routing,
 * the company) stays company-admin data. Every save is in the audit log. Also the driver break
 * (length and the window it may start in).
 */
export const DISPATCHER_SETTINGS_FIELDS = [
  'shiftStartMin',
  'driverShiftMaxMinutes',
  'overtimeAfterMin',
  'driverBreakMinutes',
  'driverBreakFromMin',
  'driverBreakToMin',
] as const satisfies readonly SettingsField[];
export type DispatcherField = (typeof DISPATCHER_SETTINGS_FIELDS)[number];
export type DispatcherConfig = Pick<TenantConfig, DispatcherField>;

/** The fields of a settings save that only a company admin may change (empty: a dispatcher may save it). */
export function adminOnlyFields(tenantPatch: Record<string, unknown>, configPatch: Record<string, unknown>): string[] {
  const allowed = new Set<string>(DISPATCHER_SETTINGS_FIELDS);
  return [...Object.keys(tenantPatch), ...Object.keys(configPatch).filter((k) => !allowed.has(k))];
}

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

/**
 * The driver break as a save applies it (review FIX 8: the optimizer plans no break for settings
 * that cannot work, so they are refused here): the window must not end before it starts, and the
 * break must be shorter than the driver shift maximum. Only a save that changes one of them is
 * held to it.
 */
export function breakSaveProblem(
  changed: Record<string, unknown>,
  merged: { driverBreakMinutes: number; driverBreakFromMin: number; driverBreakToMin: number; driverShiftMaxMinutes: number },
): string | null {
  const keys = ['driverBreakMinutes', 'driverBreakFromMin', 'driverBreakToMin', 'driverShiftMaxMinutes'];
  if (!keys.some((k) => k in changed) || merged.driverBreakMinutes <= 0) return null;
  if (merged.driverBreakFromMin > merged.driverBreakToMin) {
    return `The driver break may start from ${merged.driverBreakFromMin} min, which is after its latest start (${merged.driverBreakToMin} min).`;
  }
  if (merged.driverBreakMinutes >= merged.driverShiftMaxMinutes) {
    return `The driver break (${merged.driverBreakMinutes} min) must be shorter than the driver shift maximum (${merged.driverShiftMaxMinutes} min).`;
  }
  return null;
}
