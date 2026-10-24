import { z } from 'zod';
import {
  CapacityUnit,
  CustomerType,
  DistanceProvider,
  PaymentType,
  Role,
} from '@prisma/client';
import { MAX_SERVICE_MIN } from './dispatch/service-time';
import { DATA_COLLECT_DAYS_MAX } from './dispatch/data-collection';
import { PALLET_FACTOR_MAX } from './dispatch/pallets';
import { LEAVE_NOTE_MAX } from './dispatch/driver-leave';
import { CONFIG_BOUNDS, DEPOT_BOUNDS, TRUCK_BOUNDS, type Bound } from './planner-bounds';
import { COUNTRY_NAMES } from './countries';
import { ALERT_SETTING_BOUNDS, DELIVERY_SETTING_BOUNDS } from './settings-fields';
import { ALERT_EMAIL_SEVERITIES, readAlertEmails, type AlertThresholdColumn } from './alerts/catalog';
import { parseProductCode } from './product-code';
import { readCustomerPhone } from './dispatch/customer-phone';
import { readLoadingInstruction } from './dispatch/loading-instruction';
import { WINDOW_RULES } from './dispatch/window-rule';
import { IVMS_MODES } from './ivms/types';
import { IVMS_SETTING_BOUNDS, type IvmsNumberSetting } from './ivms/settings';
import { SITE_RADIUS_MAX_M, SITE_RADIUS_MIN_M } from './ivms/site-radius';
import { ANALYSIS_RETENTION_BOUNDS } from './analysis/types';

/** A number inside a planner bound (lib/planner-bounds.ts: never outside what the optimizer accepts). */
function bounded(b: Bound) {
  const n = z.coerce.number({ invalid_type_error: 'Enter a number' });
  return (b.int ? n.int('Enter a whole number') : n).min(b.min).max(b.max);
}

/** An optional bounded number: '' or null clears it (the truck / depot then has no own value). */
function optionalBounded(b: Bound): z.ZodOptional<z.ZodType<number | null, z.ZodTypeDef, unknown>> {
  return z.preprocess((v) => (v === '' ? null : v), bounded(b).nullable()).optional() as never;
}

/**
 * An optional text or reference in a form or PATCH body (owner decision 10, audit F26): left out
 * = unchanged (undefined); '' (or only spaces) or null = cleared (null); anything else is checked
 * by `inner`. On a create, cleared = not set. Before, '' either kept the old value ("saved", but a
 * driver's old phone stayed) or reached the database as an id that does not exist (a region's
 * "no depot" failed).
 */
export function clearable<T extends z.ZodTypeAny>(inner: T) {
  return z.preprocess((v) => (v === null || (typeof v === 'string' && v.trim() === '') ? null : v), inner.nullable()).optional();
}

const codeSchema = z
  .string()
  .trim()
  .min(1, 'Required')
  .max(32, 'Max 32 chars')
  .regex(/^[A-Za-z0-9._-]+$/, 'Letters, digits, dot, dash, underscore only');

const nameSchema = z.string().trim().min(1, 'Required').max(120);

/**
 * The customer's phone (owner request 12 Oct 2026, lib/dispatch/customer-phone.ts readCustomerPhone):
 * stored as the dialog shows it (spaces as one, Arabic-Indic digits as 0-9); anything else than
 * digits, spaces and + - ( ) /, or fewer than 6 or more than 20 digits, is refused with the reason.
 * Wrapped in clearable: '' or null clears it, left out keeps it.
 */
const customerPhoneSchema = z.string().transform((v, ctx) => {
  const r = readCustomerPhone(v);
  if (!r.ok) {
    ctx.addIssue({ code: 'custom', message: r.error });
    return z.NEVER;
  }
  return r.phone;
});

/**
 * The customer's loading instruction (owner request 16 Oct 2026, lib/dispatch/loading-instruction.ts):
 * stored folded to one line, at most 200 characters; refused with the reason otherwise.
 */
const loadingInstructionSchema = z.string().transform((v, ctx) => {
  const r = readLoadingInstruction(v);
  if (!r.ok) {
    ctx.addIssue({ code: 'custom', message: r.error });
    return z.NEVER;
  }
  return r.text;
});

/** Cases per pallet (lib/dispatch/pallets.ts validPalletFactor): a whole number 1-10,000; '' / null = not set; left out = unchanged. */
export const casesPerPalletSchema = z
  .preprocess(
    (v) => (v === '' || (typeof v === 'string' && v.trim() === '') ? null : v),
    z.coerce.number().int('Cases per pallet must be a whole number').min(1, 'Cases per pallet must be at least 1').max(PALLET_FACTOR_MAX).nullable(),
  )
  .optional();

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

/** Quick or Thorough on an OPTIMIZE / RE-PLAN (lib/dispatch/search-mode.ts). */
export const searchModeSchema = z.enum(['QUICK', 'THOROUGH']);

/** Longest unloading time one stop can have: the optimizer's limit (lib/dispatch/service-time). */
export { MAX_SERVICE_MIN };

/** A phone number as typed (drivers, the dispatcher phones): digits, spaces and +-() only. */
const driverPhoneSchema = z.string().trim().max(40).regex(/^[+0-9 ()-]+$/, 'Digits, spaces, +-() only');

const depotFields = z.object({
    code: codeSchema,
    name: nameSchema,
    lat: latSchema,
    lng: lngSchema,
    address: clearable(z.string().trim().max(500)),
    active: z.boolean().optional(),
    // Depot hours (minutes from midnight; null = 00:00 / 24:00): no truck leaves before it opens or
    // returns after it closes (review F21: these were planner inputs no screen could set).
    openMin: optionalBounded(DEPOT_BOUNDS.openMin),
    closeMin: optionalBounded(DEPOT_BOUNDS.closeMin),
    // Owner decision 3 (5 Oct 2026): the depot's own number for the driver page's "Call dispatcher";
    // '' or null clears it (the company number in Settings is then used).
    dispatcherPhone: clearable(driverPhoneSchema),
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
    description: clearable(z.string().trim().max(200)),
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
    // Pallet positions (owner decision 4 Oct 2026): set = planned by pallets; '' or null = by cases.
    bays: optionalBounded(TRUCK_BOUNDS.bays),
    // Driver who usually drives this truck: new plans put them on its loads. null / '' = none.
    defaultDriverId: z.union([z.string().min(1), z.literal('').transform(() => null), z.null()]).optional(),
    // Helper who usually goes out on this truck (owner request 13 Oct 2026): new loads get him. null / '' = none.
    defaultHelperId: z.union([z.string().min(1), z.literal('').transform(() => null), z.null()]).optional(),
    active: z.boolean().optional(),
    // Hired from outside (owner request 4 Oct 2026): a badge only; the planner never reads it.
    hired: z.boolean().optional(),
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

/**
 * A truck the company can rent for a day (owner request 6 Oct 2026, the hire suggestion), per depot,
 * company admin. Bays (pallet positions) or a case capacity; payload 0 = no weight limit; the hire for
 * one day, fuel included; the rental's own charge per km if it has one (empty = none; owner answer 3);
 * at most maxPerDay a day. The same bounds as a truck's (and the database CHECK of migration
 * 20261006120000).
 */
const hireOptionFields = z.object({
  depotId: z.string().min(1, 'Depot is required'),
  label: z.string().trim().min(1, 'Required').max(40, 'Max 40 chars'),
  bays: optionalBounded(TRUCK_BOUNDS.bays),
  capacityCases: bounded(TRUCK_BOUNDS.capacityCases).optional(),
  payloadKg: bounded(TRUCK_BOUNDS.capacityWeightKg).optional(),
  costPerDay: z.coerce.number().gt(0, 'The hire for one day must be more than 0').max(TRUCK_BOUNDS.fixedCostPerDay.max),
  costPerKm: optionalBounded(TRUCK_BOUNDS.costPerKm),
  maxPerDay: z.coerce.number().int().min(1).max(10).optional(),
  active: z.boolean().optional(),
});
/** A hire option needs bays or a case capacity: the optimizer has nothing else to load it by. */
export function hireOptionSizeProblem(v: { bays?: number | null; capacityCases?: number | null }): string | null {
  return (v.bays ?? null) === null && !((v.capacityCases ?? 0) > 0) ? 'Enter its bays (pallet positions) or its capacity in cases.' : null;
}
export const hireOptionSchema = hireOptionFields.strict().superRefine((v, ctx) => {
  const p = hireOptionSizeProblem(v);
  if (p) ctx.addIssue({ code: 'custom', path: ['bays'], message: p });
});
export const hireOptionPatchSchema = hireOptionFields.partial().strict();
export type HireOptionInput = z.infer<typeof hireOptionSchema>;

/**
 * PATCH /api/dispatch/hired-trucks/[id] (PLANNER): a one-day hired truck's real plate (its code) and
 * its default driver. Every other truck field stays with the company admin (Trucks page).
 */
export const hiredTruckPatchSchema = z
  .object({
    code: codeSchema.optional(),
    defaultDriverId: z.union([z.string().min(1), z.literal('').transform(() => null), z.null()]).optional(),
  })
  .strict();

/** POST /api/runs/[id]/hire-suggestion/use: the suggestion shown, the day on screen, the re-plan's answers. */
export const hireUseSchema = z
  .object({
    suggestionId: z.string().min(1),
    expect: z.object({ date: isoDateSchema, depotId: z.string().min(1) }).optional(),
    allowMissingLocations: z.boolean().optional(),
    allowMissingWeights: z.boolean().optional(),
  })
  .strict();

/** Moves by hand (lib/dispatch/plan-edit-view.ts): a stop of a PLANNED load, and where stops go. */
const editId = z.string().min(1).max(64);
const editSourceSchema = z.object({ loadId: editId, sequence: z.number().int().min(0).max(10_000) }).strict();
/** A stop of a PLANNED load, or a whole unserved customer visit (one of its order ids). */
const editStopRefSchema = z.union([editSourceSchema, z.object({ orderId: editId }).strict()]);
const editTargetSchema = z
  .object({
    truckId: editId,
    loadId: editId.nullable(),
    position: z.union([z.number().int().min(0).max(1_000), z.literal('BEST')]).optional(),
    // 'BEST' passes as an id.
    before: z.union([editId, z.null()]).optional(),
    // v2: the explicit layout (an existing load's whole order, or the new load's stops in order).
    order: z.array(editStopRefSchema).min(1).max(120).optional(),
  })
  .strict();
export const planEditMoveSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('MOVE'), from: editSourceSchema, to: editTargetSchema }).strict(),
  z.object({ kind: z.literal('REMOVE'), from: editSourceSchema }).strict(),
  z.object({ kind: z.literal('PLACE'), orderId: editId, to: editTargetSchema }).strict(),
]);
/**
 * One operation of a change list (v1 MOVE / REMOVE / PLACE, and v2 several stops, a whole load, a swap). A swap
 * of a load with itself and an `order` with `before: 'BEST'` are refused by the check (SAME_LOAD, BAD_ORDER): a
 * discriminated union takes only plain objects.
 */
export const planEditOpSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('MOVE'), from: editSourceSchema, to: editTargetSchema }).strict(),
  z.object({ kind: z.literal('REMOVE'), from: editSourceSchema }).strict(),
  z.object({ kind: z.literal('PLACE'), orderId: editId, to: editTargetSchema }).strict(),
  z.object({ kind: z.literal('MOVE_STOPS'), stops: z.array(editStopRefSchema).min(1).max(40), to: editTargetSchema }).strict(),
  z.object({ kind: z.literal('REMOVE_STOPS'), stops: z.array(editSourceSchema).min(1).max(40) }).strict(),
  z.object({ kind: z.literal('MOVE_LOAD'), loadId: editId, to: z.object({ truckId: editId, before: z.union([editId, z.null()]) }).strict() }).strict(),
  z.object({ kind: z.literal('SWAP_LOADS'), a: editId, b: editId }).strict(),
]);
const expectDaySchema = z.object({ date: isoDateSchema, depotId: z.string().min(1) });
/** A rule allowed by hand at Save: the issue's override id and the reason (3-300 characters). */
const overrideSchema = z.object({ id: z.string().regex(/^ovr_[0-9a-f]{16}$/), reason: z.string().trim().min(3).max(300) }).strict();

// A plain object first: a refined schema cannot be extended.
const planEditBodyBase = z
  .object({
    /** v1 body: one change. */
    move: planEditMoveSchema.optional(),
    /** v2 body: a change list, applied in order. */
    ops: z.array(planEditOpSchema).min(1).max(10).optional(),
    expect: expectDaySchema.optional(),
    /** Trucks whose driver break is skipped (the dialog's "Skip the driver break instead"). */
    skipBreak: z.array(editId).max(6).optional(),
  })
  .strict();
const oneChange = (b: { move?: unknown; ops?: unknown }) => !!b.move !== !!b.ops;

/** POST /api/runs/[id]/edit/check: one change (`move`) or a change list (`ops`), and the day on screen. */
export const planEditCheckSchema = planEditBodyBase.refine(oneChange, 'Send move or ops');

/**
 * POST /api/runs/[id]/edit: the change as the check answered it (a best place resolved), its hash and when the
 * day was read. `overrides` present (even empty) = save WITH the issues allowed by hand (the overrides hash),
 * absent = save keeping every rule (the strict hash).
 */
export const planEditSaveSchema = planEditBodyBase
  .extend({
    previewHash: z.string().regex(/^[0-9a-f]{64}$/),
    builtAt: z.string().datetime(),
    overrides: z.array(overrideSchema).max(200).optional(),
  })
  .strict()
  .refine(oneChange, 'Send move or ops')
  .refine((b) => !b.overrides || new Set(b.overrides.map((o) => o.id)).size === b.overrides.length, 'An override is listed twice');

export const driverSchema = z.object({
  code: codeSchema,
  name: nameSchema,
  // '' or null clears the phone (audit F26): WhatsApp links then have no number to use.
  phone: clearable(driverPhoneSchema),
  active: z.boolean().optional(),
});
export type DriverInput = z.infer<typeof driverSchema>;

/**
 * PATCH /api/drivers/[id]: any driver field, and `casual` - a daily driver added from a load is made a
 * regular driver by clearing it (owner request 4 Oct 2026). The dispatcher (PLANNER) may change the
 * name, phone and active switch and clear `casual`; a new code or `casual: true` stays the company
 * admin's (driverChangesRefused, owner request 6 Oct 2026).
 */
export const driverPatchSchema = driverSchema.partial().extend({ casual: z.boolean().optional() });

/**
 * A helper (truck crew), owner request 13 Oct 2026: kept like a driver - code (letters, digits and
 * . _ -, unique per company), name, optional phone (the drivers' phone rule; '' or null clears it), active.
 * POST /api/helpers and PATCH /api/helpers/[id] (only the fields sent change; a new code is the
 * company admin's: helperChangesRefused).
 */
export const helperSchema = z
  .object({
    code: codeSchema,
    name: nameSchema,
    phone: clearable(driverPhoneSchema),
    active: z.boolean().optional(),
  })
  .strict();
export type HelperInput = z.infer<typeof helperSchema>;
export const helperPatchSchema = helperSchema.partial().strict();

/** At most this many helpers go out on one load (the database CHECK position 1-3 and UNIQUE (loadId, position) of migration 20261013150000). */
export const MAX_HELPERS_PER_LOAD = 3;

/**
 * A load's helpers in the order shown (PATCH /api/runs/[id]/loads/[loadId] `helperIds`): 0 to 3 ids,
 * each once; [] = no helpers.
 */
export const loadHelperIdsSchema = z
  .array(z.string().min(1))
  .max(MAX_HELPERS_PER_LOAD, `At most ${MAX_HELPERS_PER_LOAD} helpers on a load.`)
  .refine((ids) => new Set(ids).size === ids.length, 'A helper is listed twice.');

/**
 * A driver's leave period (owner request 6 Oct 2026; lib/dispatch/driver-leave.ts): POST
 * /api/drivers/[id]/leave and PATCH /api/drivers/[id]/leave/[leaveId] (the whole period is sent).
 * From and until are delivery dates, both included; the cover driver is optional ('' or null = none).
 */
export const driverLeaveSchema = z
  .object({
    from: isoDateSchema,
    until: isoDateSchema,
    note: clearable(z.string().trim().max(LEAVE_NOTE_MAX, `Note: at most ${LEAVE_NOTE_MAX} characters`)),
    coverDriverId: clearable(z.string().min(1)),
  })
  .strict();
export type DriverLeaveInput = z.infer<typeof driverLeaveSchema>;

/**
 * POST /api/dispatch/casual-driver: a daily (casual) driver added from a load (owner rule 20: a
 * load never leaves without a driver). `useExisting`: the dispatcher answered "Use <name>?" when the
 * phone belongs to another driver. `leaveConfirmed`: he answered "<name> is on leave until ... Put
 * <name> on ... anyway?" (driver leave, 6 Oct 2026; else 409 DRIVER_ON_LEAVE).
 */
export const casualDriverSchema = z
  .object({
    runId: z.string().min(1),
    loadId: z.string().min(1),
    name: z.string().trim().min(2, 'Name: at least 2 characters').max(80, 'Name: at most 80 characters'),
    phone: clearable(driverPhoneSchema),
    useExisting: z.string().min(1).optional(),
    leaveConfirmed: z.boolean().optional(),
  })
  .strict();
export type CasualDriverInput = z.infer<typeof casualDriverSchema>;

export const regionSchema = z.object({
  code: codeSchema,
  name: nameSchema,
  // No depot: '' or null (audit F26: a region can be created without a depot, and its depot cleared).
  depotId: clearable(z.string().min(1)),
});
export type RegionInput = z.infer<typeof regionSchema>;

/**
 * A product code as the NMWC ERP writes it ("JA1.5L(6)", "TN1.5L (6)", "SS5GB NRB"): letters, digits,
 * spaces and . ( ) - _ / + & , tidied (spaces at the ends cut, runs of spaces inside made one), up to
 * 40 long (lib/product-code.ts). Products only: customer, depot, truck, driver and region codes keep
 * `codeSchema`.
 */
export const productCodeSchema = z
  .string({ required_error: 'Required', invalid_type_error: 'A product code is text' })
  .transform((raw, ctx) => {
    const r = parseProductCode(raw);
    if (!r.ok) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: r.message });
      return z.NEVER;
    }
    return r.code;
  });

export const productSchema = z.object({
  code: productCodeSchema,
  name: nameSchema,
  weightPerCaseKg: z.coerce.number().min(0).max(10_000),
  volumePerCaseL: z.coerce.number().min(0).max(10_000),
  // The ERP pallet factor (owner decision 4 Oct 2026): cases of the product on one pallet, a whole
  // number 1-10,000; '' or null = not set (a day planned with trucks that have bays is then refused).
  casesPerPallet: casesPerPalletSchema,
  active: z.boolean().optional(),
});
export type ProductInput = z.infer<typeof productSchema>;
/**
 * PATCH /api/products/[id]: any field of productSchema, and `clearWeight` - a known case weight is
 * cleared (saved as 0 = unknown) only with it (the Edit product dialog's "Weight not known").
 */
export const productPatchSchema = productSchema.partial().extend({ clearWeight: z.boolean().optional() });

export const customerSchema = z.object({
  code: codeSchema,
  name: nameSchema,
  branchCode: clearable(z.string().trim().max(32)),
  regionId: clearable(z.string().min(1)),
  address: clearable(z.string().trim().max(500)),
  lat: blankCoord.or(latSchema).optional(),
  lng: blankCoord.or(lngSchema).optional(),
  // Customer.priority and Customer.avgServiceTimeMin both have DB defaults
  // (3 and 10 respectively). Treat them as optional in the API so a form that
  // omits them — or a fuzz payload — falls back to defaults instead of 400ing
  // on "Expected number, received nan" from z.coerce against undefined.
  priority: z.coerce.number().int().min(1).max(5).optional().default(3),
  avgServiceTimeMin: z.coerce.number().int().min(0).max(MAX_SERVICE_MIN).optional().default(10),
  paymentType: z.nativeEnum(PaymentType).optional().default(PaymentType.CREDIT),
  accessNotes: clearable(z.string().trim().max(500)),
  // Owner request 12 Oct 2026: the phone the driver calls before arrival (optional).
  phone: clearable(customerPhoneSchema),
  // Owner request 13 Oct 2026: the unloading area takes small trucks only (3-ton): planned on trucks with
  // at most TenantConfig.smallTruckMaxBays bays (lib/dispatch/small-truck.ts). A JSON boolean only.
  smallTruckOnly: z.boolean().optional(),
  // Owner request 16 Oct 2026: what the warehouse must do when loading this customer's orders, printed in
  // the SPECIAL LOADING box of the load sheets (lib/dispatch/loading-instruction.ts). '' or null clears it.
  loadingInstruction: clearable(loadingInstructionSchema),
  // Owner request 19 Oct 2026: the customer's GPS site radius (lib/ivms/site-radius.ts), whole metres 100-500
  // (the database CHECK "Customer_siteRadiusM_range" has the same bounds); null = the company's stop radius.
  // A JSON number only: "400 m" or "" is refused, never read as something else.
  siteRadiusM: z.number().int().min(SITE_RADIUS_MIN_M).max(SITE_RADIUS_MAX_M).nullable().optional(),
  active: z.boolean().optional(),
});
export type CustomerInput = z.infer<typeof customerSchema>;

/**
 * Minutes from local midnight (06:30 = 390). 1440 = end of day. A JSON number only (audit F07): a
 * coerced "" used to become 0, i.e. midnight.
 */
const minuteOfDay = z.number().int().min(0).max(1440);

export const customerPatchSchema = customerSchema
  .partial()
  .extend({
    // NMWC dispatch MVP - null clears the customer's own value (type default applies again).
    customerType: z.nativeEnum(CustomerType).nullable().optional(),
    // Audit F07 (owner decision 9): a whole number of minutes (0 allowed: an explicit "no unloading
    // time") confirms the customer's own time; null = no own time, the customer-type or Settings
    // default applies (not confirmed). A JSON number only: "" or "10 min" is refused, never 0.
    avgServiceTimeMin: z.number().int().min(0).max(MAX_SERVICE_MIN).nullable().optional(),
    hardWindowStartMin: minuteOfDay.nullable().optional(),
    hardWindowEndMin: minuteOfDay.nullable().optional(),
    prefWindowStartMin: minuteOfDay.nullable().optional(),
    prefWindowEndMin: minuteOfDay.nullable().optional(),
    // Owner decision 1 Oct 2026 ("own confirmed window"): true = the receiving hours, as stored after
    // this change, are confirmed by this user (all four empty = open all day, any time); false = not
    // confirmed any more. Left out: hours sent with a time are confirmed, hours all cleared are not.
    windowConfirmed: z.boolean().optional(),
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

/** An operations-alert threshold within its bounds (lib/alerts/catalog.ts), or null / '' = the rule is off. */
function alertThreshold(k: AlertThresholdColumn) {
  const b = ALERT_SETTING_BOUNDS[k];
  return z.preprocess(
    (v) => (v === '' ? null : v),
    z.number({ invalid_type_error: 'Enter a whole number' }).int('Enter a whole number').min(b.min).max(b.max).nullable(),
  );
}
/** A minute of the day (the alert quiet hours), or null / '' = none. */
const alertMinuteOfDay = z.preprocess(
  (v) => (v === '' ? null : v),
  z.number().int().min(ALERT_SETTING_BOUNDS.alertQuietFromMin.min).max(ALERT_SETTING_BOUNDS.alertQuietFromMin.max).nullable(),
);
/** The alert e-mail recipients: at most 5 addresses, stored "a@x.example, b@y.example"; '' or null = none. */
const alertEmailsSchema = z.union([z.string(), z.null()]).transform((v, ctx) => {
  const r = readAlertEmails(v);
  if (!r.ok) {
    ctx.addIssue({ code: 'custom', message: r.error });
    return z.NEVER;
  }
  return r.value;
});

/** A whole-number IVMS setting inside its bounds (lib/ivms/settings.ts, the database CHECKs). */
function ivmsSetting(k: IvmsNumberSetting) {
  return z.number().int().min(IVMS_SETTING_BOUNDS[k].min).max(IVMS_SETTING_BOUNDS[k].max);
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
    driverBreakMinutes: bounded(CONFIG_BOUNDS.driverBreakMinutes),
    driverBreakFromMin: bounded(CONFIG_BOUNDS.driverBreakFromMin),
    driverBreakToMin: bounded(CONFIG_BOUNDS.driverBreakToMin),
    reloadMinutes: bounded(CONFIG_BOUNDS.reloadMinutes),
    loadingMinPerCase: bounded(CONFIG_BOUNDS.loadingMinPerCase),
    serviceMinPerCase: bounded(CONFIG_BOUNDS.serviceMinPerCase),
    defaultServiceTimeMin: bounded(CONFIG_BOUNDS.defaultServiceTimeMin),
    maxTripsPerTruck: bounded(CONFIG_BOUNDS.maxTripsPerTruck),
    // Pallet fill (owner decision 4 Oct 2026): the share of a truck's bays the planner may fill.
    palletFillPct: bounded(CONFIG_BOUNDS.palletFillPct),
    // Owner decision 13 Oct 2026: "a small truck has at most N bays" (small-truck-only customers). Company admin.
    smallTruckMaxBays: bounded(CONFIG_BOUNDS.smallTruckMaxBays),
    splitDeliveries: z.boolean(),
    // Owner request 13 Oct 2026: the end of the receiving hours is the latest arrival (START) or the time
    // unloading must be finished (FINISH, the default). Company admin. lib/dispatch/window-rule.ts.
    windowRule: z.enum(WINDOW_RULES),
    planningCutoffMin: bounded(CONFIG_BOUNDS.planningCutoffMin),
    dateOrder: z.enum(['DMY', 'MDY']),
    // Money (OMR)
    fuelPricePerLitre: bounded(CONFIG_BOUNDS.fuelPricePerLitre),
    driverCostPerHour: bounded(CONFIG_BOUNDS.driverCostPerHour),
    overtimeCostPerHour: bounded(CONFIG_BOUNDS.overtimeCostPerHour),
    // Owner answer 4 (6 Oct 2026): the casual driver of a truck hired for the day, per day. Company admin.
    dailyDriverDayRate: bounded(CONFIG_BOUNDS.dailyDriverDayRate),
    prefWindowPenaltyPerMin: bounded(CONFIG_BOUNDS.prefWindowPenaltyPerMin),
    // Distances
    distanceProvider: z.enum([DistanceProvider.OSRM, DistanceProvider.HAVERSINE]),
    roadTimeFactor: bounded(CONFIG_BOUNDS.roadTimeFactor),
    distanceMultiplier: bounded(CONFIG_BOUNDS.distanceMultiplier),
    avgSpeedKmh: bounded(CONFIG_BOUNDS.avgSpeedKmh),
    // Customer data (owner decisions 1 Oct 2026, items 3 and 4): the loading gate, and how many days
    // ahead the data-to-collect list looks. Web only (the optimizer never reads them).
    requireDataBeforeLoading: z.boolean(),
    dataCollectDays: z.number().int().min(0).max(DATA_COLLECT_DAYS_MAX),
    // The driver page and delivery results (owner request 4 Oct 2026). Web only, company admin.
    geofenceRadiusM: z.number().int().min(DELIVERY_SETTING_BOUNDS.geofenceRadiusM.min).max(DELIVERY_SETTING_BOUNDS.geofenceRadiusM.max),
    photoProofRequired: z.boolean(),
    photoRetentionDays: z.number().int().min(DELIVERY_SETTING_BOUNDS.photoRetentionDays.min).max(DELIVERY_SETTING_BOUNDS.photoRetentionDays.max),
    locationRetentionDays: z.number().int().min(DELIVERY_SETTING_BOUNDS.locationRetentionDays.min).max(DELIVERY_SETTING_BOUNDS.locationRetentionDays.max),
    // The company number behind the driver page's "Call dispatcher" button, used when the truck's depot
    // has none of its own (owner decision 3, 5 Oct 2026); '' or null = none.
    dispatcherPhone: z.preprocess((v) => (typeof v === 'string' && v.trim() === '' ? null : v), driverPhoneSchema.nullable()),
    // Operations alerts (owner request 16 Oct 2026, lib/alerts/catalog.ts). Web only, company admin. A
    // threshold of null (or '') switches that rule off.
    alertsEnabled: z.boolean(),
    alertUnloadOverMin: alertThreshold('alertUnloadOverMin'),
    alertLoadingOverMin: alertThreshold('alertLoadingOverMin'),
    alertEtaLateMin: alertThreshold('alertEtaLateMin'),
    alertDepartLateMin: alertThreshold('alertDepartLateMin'),
    alertSilentMin: alertThreshold('alertSilentMin'),
    alertPageNotOpenedMin: alertThreshold('alertPageNotOpenedMin'),
    alertAfterClosingMin: alertThreshold('alertAfterClosingMin'),
    alertPriorityMax: alertThreshold('alertPriorityMax'),
    alertDeliveredNote: z.boolean(),
    alertProofFarM: alertThreshold('alertProofFarM'),
    alertNotClosedMin: alertThreshold('alertNotClosedMin'),
    alertEmails: alertEmailsSchema,
    alertEmailEveryMin: z.number().int().min(ALERT_SETTING_BOUNDS.alertEmailEveryMin.min).max(ALERT_SETTING_BOUNDS.alertEmailEveryMin.max),
    alertEmailMinSeverity: z.enum(ALERT_EMAIL_SEVERITIES),
    alertQuietFromMin: alertMinuteOfDay,
    alertQuietToMin: alertMinuteOfDay,
    // The IVMS live link (Ayun GPS trackers, 16 Oct 2026). Web only (the optimizer never reads them), company
    // admin. Bounds = the database CHECKs (lib/ivms/settings.ts); OFF = no call to Ayun, nothing new shown.
    ivmsMode: z.enum(IVMS_MODES),
    ivmsPollSec: ivmsSetting('ivmsPollSec'),
    ivmsRoutePullMin: ivmsSetting('ivmsRoutePullMin'),
    ivmsFromMin: ivmsSetting('ivmsFromMin'),
    ivmsToMin: ivmsSetting('ivmsToMin'),
    ivmsDailyCallBudget: ivmsSetting('ivmsDailyCallBudget'),
    ivmsStopRadiusM: ivmsSetting('ivmsStopRadiusM'),
    ivmsStopDwellMin: ivmsSetting('ivmsStopDwellMin'),
    ivmsDepotRadiusM: ivmsSetting('ivmsDepotRadiusM'),
    ivmsTrailDays: ivmsSetting('ivmsTrailDays'),
    // The analysis dataset (owner request 19 Oct 2026): days its facts are kept. Web only, company admin; the
    // bounds are the database CHECK (lib/analysis/types.ts, migration 20261019090000_analysis_facts).
    analysisRetentionDays: z.number().int().min(ANALYSIS_RETENTION_BOUNDS.min).max(ANALYSIS_RETENTION_BOUNDS.max),
  })
  .strict();
export type TenantConfigInput = z.infer<typeof tenantConfigSchema>;

export { alertQuietSaveProblem, breakSaveProblem, overtimeProblem, overtimeSaveProblem, retentionSaveProblem } from './settings-fields';

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
