import { z } from 'zod';
import {
  CapacityUnit,
  CustomerType,
  DistanceProvider,
  PaymentType,
  Role,
} from '@prisma/client';
import { MAX_SERVICE_MIN } from './dispatch/service-time';

const codeSchema = z
  .string()
  .trim()
  .min(1, 'Required')
  .max(32, 'Max 32 chars')
  .regex(/^[A-Za-z0-9._-]+$/, 'Letters, digits, dot, dash, underscore only');

const nameSchema = z.string().trim().min(1, 'Required').max(120);

const latSchema = z.coerce.number().min(-90).max(90);
const lngSchema = z.coerce.number().min(-180).max(180);
// z.coerce turns '' and null into 0 - a real-looking 0,0 location. For customers a blank
// coordinate means "not set", so try the blank branch before coercing.
const blankCoord = z.union([z.literal(''), z.null()]).transform(() => undefined);

/** A calendar date written YYYY-MM-DD that exists (2026-02-31 and 2026-13-01 do not). */
export function isRealIsoDate(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00.000Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

/** Delivery / plan date in API bodies: must round-trip, so it never rolls into another day. */
export const isoDateSchema = z.string().refine(isRealIsoDate, 'Use a real date as YYYY-MM-DD');

/** Longest unloading time one stop can have: the optimizer's limit (lib/dispatch/service-time). */
export { MAX_SERVICE_MIN };

export const depotSchema = z.object({
  code: codeSchema,
  name: nameSchema,
  lat: latSchema,
  lng: lngSchema,
  address: z.string().trim().max(500).optional().or(z.literal('').transform(() => undefined)),
  active: z.boolean().optional(),
});
export type DepotInput = z.infer<typeof depotSchema>;

export const truckSchema = z.object({
  code: codeSchema,
  description: z.string().trim().max(200).optional().or(z.literal('').transform(() => undefined)),
  depotId: z.string().min(1, 'Depot is required'),
  capacityCases: z.coerce.number().int().min(0).max(100_000),
  capacityWeightKg: z.coerce.number().min(0).max(100_000),
  capacityVolumeL: z.coerce.number().min(0).max(100_000),
  fixedCostPerDay: z.coerce.number().min(0).max(100_000),
  costPerKm: z.coerce.number().min(0).max(1_000),
  // Driver who usually drives this truck: new plans put them on its loads. null / '' = none.
  defaultDriverId: z.union([z.string().min(1), z.literal('').transform(() => null), z.null()]).optional(),
  active: z.boolean().optional(),
});
export type TruckInput = z.infer<typeof truckSchema>;

export const driverSchema = z.object({
  code: codeSchema,
  name: nameSchema,
  phone: z
    .string()
    .trim()
    .max(40)
    .regex(/^[+0-9 ()-]+$/, 'Digits, spaces, +-() only')
    .optional()
    .or(z.literal('').transform(() => undefined)),
  active: z.boolean().optional(),
});
export type DriverInput = z.infer<typeof driverSchema>;

export const regionSchema = z.object({
  code: codeSchema,
  name: nameSchema,
  depotId: z.string().optional().or(z.literal('').transform(() => undefined)),
});
export type RegionInput = z.infer<typeof regionSchema>;

export const productSchema = z.object({
  code: codeSchema,
  name: nameSchema,
  weightPerCaseKg: z.coerce.number().min(0).max(10_000),
  volumePerCaseL: z.coerce.number().min(0).max(10_000),
  active: z.boolean().optional(),
});
export type ProductInput = z.infer<typeof productSchema>;

export const customerSchema = z.object({
  code: codeSchema,
  name: nameSchema,
  branchCode: z.string().trim().max(32).optional().or(z.literal('').transform(() => undefined)),
  regionId: z.string().optional().or(z.literal('').transform(() => undefined)),
  address: z.string().trim().max(500).optional().or(z.literal('').transform(() => undefined)),
  lat: blankCoord.or(latSchema).optional(),
  lng: blankCoord.or(lngSchema).optional(),
  // Customer.priority and Customer.avgServiceTimeMin both have DB defaults
  // (3 and 10 respectively). Treat them as optional in the API so a form that
  // omits them — or a fuzz payload — falls back to defaults instead of 400ing
  // on "Expected number, received nan" from z.coerce against undefined.
  priority: z.coerce.number().int().min(1).max(5).optional().default(3),
  avgServiceTimeMin: z.coerce.number().int().min(0).max(MAX_SERVICE_MIN).optional().default(10),
  paymentType: z.nativeEnum(PaymentType).optional().default(PaymentType.CREDIT),
  accessNotes: z.string().trim().max(500).optional().or(z.literal('').transform(() => undefined)),
  active: z.boolean().optional(),
});
export type CustomerInput = z.infer<typeof customerSchema>;

/** Minutes from local midnight (06:30 = 390). 1440 = end of day. */
const minuteOfDay = z.coerce.number().int().min(0).max(1440);

export const customerPatchSchema = customerSchema
  .partial()
  .extend({
    // NMWC dispatch MVP - null clears the customer's own value (type default applies again).
    customerType: z.nativeEnum(CustomerType).nullable().optional(),
    hardWindowStartMin: minuteOfDay.nullable().optional(),
    hardWindowEndMin: minuteOfDay.nullable().optional(),
    prefWindowStartMin: minuteOfDay.nullable().optional(),
    prefWindowEndMin: minuteOfDay.nullable().optional(),
  })
  .superRefine((v, ctx) => {
    const pairs: [keyof typeof v, keyof typeof v, string][] = [
      ['hardWindowStartMin', 'hardWindowEndMin', 'Hard window'],
      ['prefWindowStartMin', 'prefWindowEndMin', 'Preferred window'],
    ];
    for (const [a, b, label] of pairs) {
      const s = v[a] as number | null | undefined;
      const e = v[b] as number | null | undefined;
      if (typeof s === 'number' && typeof e === 'number' && e <= s) {
        ctx.addIssue({ code: 'custom', path: [b as string], message: `${label}: end must be after start.` });
      }
    }
  });
export type CustomerPatchInput = z.infer<typeof customerPatchSchema>;

/**
 * Map blank/null branchCode to the magic `__MAIN__` branchKey for the
 * uniqueness constraint. See CLAUDE.md §6.
 */
export function normalizeBranchKey(branchCode: string | null | undefined): string {
  const trimmed = (branchCode ?? '').trim();
  return trimmed === '' ? '__MAIN__' : trimmed;
}

export const tenantConfigSchema = z.object({
  avgSpeedKmh: z.coerce.number().min(5).max(120),
  distanceProvider: z.nativeEnum(DistanceProvider),
  distanceMultiplier: z.coerce.number().min(1).max(3),
  labelEstimatedDistances: z.boolean(),
  driverShiftMaxMinutes: z.coerce.number().int().min(60).max(1440),
  // Dispatch timing (NMWC planner). First departure 00:00-23:59 as minutes from midnight.
  shiftStartMin: z.coerce.number().int().min(0).max(1439),
  reloadMinutes: z.coerce.number().int().min(0).max(240),
  loadingMinPerCase: z.coerce.number().min(0).max(1),
  serviceMinPerCase: z.coerce.number().min(0).max(1),
  maxTripsPerTruck: z.coerce.number().int().min(1).max(10),
  returnToDepot: z.boolean(),
  splitDeliveries: z.boolean(),
  defaultServiceTimeMin: z.coerce.number().int().min(0).max(MAX_SERVICE_MIN),
  costPerKmDefault: z.coerce.number().min(0).max(10),
  fixedTruckCostPerDayDefault: z.coerce.number().min(0).max(10_000),
  latePenaltyPerMin: z.coerce.number().min(0).max(100),
  underutilizationPenalty: z.coerce.number().min(0).max(1_000_000),
  solverTimeLimitSeconds: z.coerce.number().int().min(5).max(300),
  weightObjectiveTrucks: z.coerce.number().min(0).max(1_000_000),
  weightObjectiveDistance: z.coerce.number().min(0).max(1_000_000),
  weightObjectiveCost: z.coerce.number().min(0).max(1_000_000),
  weightObjectiveBalance: z.coerce.number().min(0).max(1_000_000),
  weightObjectiveUtilization: z.coerce.number().min(0).max(1_000_000),
});
export type TenantConfigInput = z.infer<typeof tenantConfigSchema>;

export const tenantSettingsSchema = z.object({
  name: z.string().trim().min(2).max(120),
  country: z.string().trim().min(2).max(64),
  currency: z.string().trim().min(3).max(8),
  primaryUnit: z.nativeEnum(CapacityUnit),
});
export type TenantSettingsInput = z.infer<typeof tenantSettingsSchema>;

export const userInviteSchema = z.object({
  email: z.string().email().max(254),
  name: z.string().trim().min(2).max(120),
  role: z.nativeEnum(Role),
});
export type UserInviteInput = z.infer<typeof userInviteSchema>;
