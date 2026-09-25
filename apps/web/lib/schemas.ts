import { z } from 'zod';
import {
  CapacityUnit,
  CustomerType,
  DistanceProvider,
  PaymentType,
  Role,
} from '@prisma/client';
import { MAX_SERVICE_MIN } from './dispatch/service-time';
import { CONFIG_BOUNDS, DEPOT_BOUNDS, TRUCK_BOUNDS, type Bound } from './planner-bounds';
import { COUNTRY_NAMES } from './countries';

/** A number inside a planner bound (lib/planner-bounds.ts: never outside what the optimizer accepts). */
function bounded(b: Bound) {
  const n = z.coerce.number({ invalid_type_error: 'Enter a number' });
  return (b.int ? n.int('Enter a whole number') : n).min(b.min).max(b.max);
}

/** An optional bounded number: '' or null clears it (the truck / depot then has no own value). */
function optionalBounded(b: Bound): z.ZodOptional<z.ZodType<number | null, z.ZodTypeDef, unknown>> {
  return z.preprocess((v) => (v === '' ? null : v), bounded(b).nullable()).optional() as never;
}

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

const depotFields = z.object({
    code: codeSchema,
    name: nameSchema,
    lat: latSchema,
    lng: lngSchema,
    address: z.string().trim().max(500).optional().or(z.literal('').transform(() => undefined)),
    active: z.boolean().optional(),
    // Depot hours (minutes from midnight; null = 00:00 / 24:00): no truck leaves before it opens or
    // returns after it closes (review F21: these were planner inputs no screen could set).
    openMin: optionalBounded(DEPOT_BOUNDS.openMin),
    closeMin: optionalBounded(DEPOT_BOUNDS.closeMin),
  });

/** "closes before it opens" for a depot (the merged row on a PATCH), or null. */
export function depotHoursProblem(v: { openMin?: number | null; closeMin?: number | null }): string | null {
  return typeof v.openMin === 'number' && typeof v.closeMin === 'number' && v.closeMin <= v.openMin ? 'The depot must close after it opens.' : null;
}
const depotHoursRefine = (v: { openMin?: number | null; closeMin?: number | null }, ctx: z.RefinementCtx) => {
  const p = depotHoursProblem(v);
  if (p) ctx.addIssue({ code: 'custom', path: ['closeMin'], message: p });
};
export const depotSchema = depotFields.superRefine(depotHoursRefine);
export const depotPatchSchema = depotFields.partial().superRefine(depotHoursRefine);
export type DepotInput = z.infer<typeof depotSchema>;

const truckFields = z.object({
    code: codeSchema,
    description: z.string().trim().max(200).optional().or(z.literal('').transform(() => undefined)),
    depotId: z.string().min(1, 'Depot is required'),
    capacityCases: bounded(TRUCK_BOUNDS.capacityCases),
    capacityWeightKg: bounded(TRUCK_BOUNDS.capacityWeightKg),
    capacityVolumeL: z.coerce.number().min(0).max(100_000),
    fixedCostPerDay: bounded(TRUCK_BOUNDS.fixedCostPerDay),
    costPerKm: bounded(TRUCK_BOUNDS.costPerKm),
    // Review F21: planner inputs that used to be database-only.
    tripCost: bounded(TRUCK_BOUNDS.tripCost).optional(),
    kmPerLitre: optionalBounded(TRUCK_BOUNDS.kmPerLitre),
    maxTripsPerDay: optionalBounded(TRUCK_BOUNDS.maxTripsPerDay),
    availableFromMin: optionalBounded(TRUCK_BOUNDS.availableFromMin),
    availableToMin: optionalBounded(TRUCK_BOUNDS.availableToMin),
    // Driver who usually drives this truck: new plans put them on its loads. null / '' = none.
    defaultDriverId: z.union([z.string().min(1), z.literal('').transform(() => null), z.null()]).optional(),
    active: z.boolean().optional(),
  });

/** "available until before available from" for a truck (the merged row on a PATCH), or null. */
export function truckHoursProblem(v: { availableFromMin?: number | null; availableToMin?: number | null }): string | null {
  return typeof v.availableFromMin === 'number' && typeof v.availableToMin === 'number' && v.availableToMin <= v.availableFromMin
    ? 'Available until must be after available from.'
    : null;
}
const truckHoursRefine = (v: { availableFromMin?: number | null; availableToMin?: number | null }, ctx: z.RefinementCtx) => {
  const p = truckHoursProblem(v);
  if (p) ctx.addIssue({ code: 'custom', path: ['availableToMin'], message: p });
};
export const truckSchema = truckFields.superRefine(truckHoursRefine);
export const truckPatchSchema = truckFields.partial().superRefine(truckHoursRefine);
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

/**
 * The tenant settings Settings can change: exactly the ones the daily dispatch planner uses
 * (review F21), each within the optimizer's own bounds (lib/planner-bounds.ts). Strict: the old
 * controls that changed nothing (solver time limit, objective weights, cost defaults, "return to
 * depot", "label estimated distances", Mapbox) are refused with 400 instead of being stored.
 * Timezone, the routing server, the service area and priority weights stay operations settings.
 */
export const tenantConfigSchema = z
  .object({
    // Timing
    shiftStartMin: bounded(CONFIG_BOUNDS.shiftStartMin),
    driverShiftMaxMinutes: bounded(CONFIG_BOUNDS.driverShiftMaxMinutes),
    overtimeAfterMin: bounded(CONFIG_BOUNDS.overtimeAfterMin),
    reloadMinutes: bounded(CONFIG_BOUNDS.reloadMinutes),
    loadingMinPerCase: bounded(CONFIG_BOUNDS.loadingMinPerCase),
    serviceMinPerCase: bounded(CONFIG_BOUNDS.serviceMinPerCase),
    defaultServiceTimeMin: bounded(CONFIG_BOUNDS.defaultServiceTimeMin),
    maxTripsPerTruck: bounded(CONFIG_BOUNDS.maxTripsPerTruck),
    splitDeliveries: z.boolean(),
    planningCutoffMin: bounded(CONFIG_BOUNDS.planningCutoffMin),
    dateOrder: z.enum(['DMY', 'MDY']),
    // Money (OMR)
    fuelPricePerLitre: bounded(CONFIG_BOUNDS.fuelPricePerLitre),
    driverCostPerHour: bounded(CONFIG_BOUNDS.driverCostPerHour),
    overtimeCostPerHour: bounded(CONFIG_BOUNDS.overtimeCostPerHour),
    prefWindowPenaltyPerMin: bounded(CONFIG_BOUNDS.prefWindowPenaltyPerMin),
    // Distances
    distanceProvider: z.enum([DistanceProvider.OSRM, DistanceProvider.HAVERSINE]),
    roadTimeFactor: bounded(CONFIG_BOUNDS.roadTimeFactor),
    distanceMultiplier: bounded(CONFIG_BOUNDS.distanceMultiplier),
    avgSpeedKmh: bounded(CONFIG_BOUNDS.avgSpeedKmh),
  })
  .strict();
export type TenantConfigInput = z.infer<typeof tenantConfigSchema>;

export { overtimeProblem, overtimeSaveProblem } from './settings-fields';

export const tenantSettingsSchema = z.object({
  name: z.string().trim().min(2).max(120),
  // A pick-list (review F21): the country decides road routing, so a typo cannot switch it silently.
  country: z.enum(COUNTRY_NAMES, { errorMap: () => ({ message: `Choose one of: ${COUNTRY_NAMES.join(', ')}` }) }),
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
