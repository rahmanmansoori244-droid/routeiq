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
