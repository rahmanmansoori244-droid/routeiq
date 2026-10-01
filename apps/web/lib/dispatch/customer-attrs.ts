/**
 * Effective delivery attributes of a customer branch, and the issues the dispatcher must (or
 * may) resolve before optimizing.
 *
 * Precedence for every attribute: the customer's own value > the customer-type default >
 * the tenant default. Priority 1 is the HIGHEST, 5 the LOWEST - everywhere.
 */
import { DEFAULT_SERVICE_AREA, SAVED_NOT_EXACT_MESSAGE, SAVED_OUTSIDE_AREA_MESSAGE, SAVED_SWAPPED_MESSAGE, type ServiceArea } from './location-input';
import { fmtWindow } from './time';

export interface CustomerForPlanning {
  id: string;
  code: string;
  branchCode: string | null;
  name: string;
  lat: number | null;
  lng: number | null;
  priority: number;
  priorityConfirmed: boolean;
  avgServiceTimeMin: number;
  serviceTimeConfirmed: boolean;
  customerType: string | null;
  hardWindowStartMin: number | null;
  hardWindowEndMin: number | null;
  prefWindowStartMin: number | null;
  prefWindowEndMin: number | null;
  locationVerified: boolean;
  createdFromUpload: boolean;
  /** HIGH / MEDIUM / LOW / MISSING (null or left out: not known). LOW and never confirmed blocks planning (audit PR A5). */
  geocodeConfidence?: string | null;
  /**
   * When a dispatcher or admin entered or confirmed the receiving hours (owner decision 1 Oct 2026,
   * "own confirmed window"); null or left out = not confirmed. Confirmed with all four window
   * columns empty = open all day (any time), and the customer-type default does not apply.
   */
  windowConfirmedAt?: Date | string | null;
}

export interface TypeProfileLike {
  customerType: string;
  defaultPriority: number | null;
  serviceTimeMin: number | null;
  hardWindowStartMin: number | null;
  hardWindowEndMin: number | null;
  prefWindowStartMin: number | null;
  prefWindowEndMin: number | null;
}

export type AttrSource = 'CUSTOMER' | 'TYPE' | 'DEFAULT';

export interface EffectiveAttrs {
  priority: number;
  prioritySource: AttrSource;
  serviceMin: number;
  serviceSource: AttrSource;
  hardStart: number | null;
  hardEnd: number | null;
  prefStart: number | null;
  prefEnd: number | null;
  windowSource: AttrSource;
  /** The customer's own receiving hours, confirmed by a dispatcher or admin (an own confirmed window). */
  windowConfirmed: boolean;
}

export function effectiveAttrs(
  c: CustomerForPlanning,
  profiles: Map<string, TypeProfileLike>,
  defaults: { serviceTimeMin: number },
): EffectiveAttrs {
  const p = c.customerType ? profiles.get(c.customerType) : undefined;
  let priority = c.priority;
  let prioritySource: AttrSource = 'CUSTOMER';
  if (!c.priorityConfirmed) {
    if (p?.defaultPriority) {
      priority = p.defaultPriority;
      prioritySource = 'TYPE';
    } else {
      prioritySource = 'DEFAULT';
    }
  }
  // Unloading time: a confirmed customer value (entered by a planner, or an imported column)
  // wins; else the customer type's; else the company default from Settings. An unconfirmed stored
  // value is only the column default (10 min) - it used to win over the Settings default, which
  // then changed nothing for normal customers (review F21).
  let serviceMin = c.avgServiceTimeMin;
  let serviceSource: AttrSource = 'CUSTOMER';
  if (!c.serviceTimeConfirmed) {
    if (p?.serviceTimeMin != null) {
      serviceMin = p.serviceTimeMin;
      serviceSource = 'TYPE';
    } else {
      serviceMin = defaults.serviceTimeMin;
      serviceSource = 'DEFAULT';
    }
  }
  // Own hours: some stored, or confirmed (all four empty and confirmed = open all day, any time: the
  // customer-type default does not apply to a customer who accepts deliveries at any time).
  const windowConfirmed = c.windowConfirmedAt != null;
  const own = windowConfirmed || [c.hardWindowStartMin, c.hardWindowEndMin, c.prefWindowStartMin, c.prefWindowEndMin].some((v) => v !== null);
  let windowSource: AttrSource = own ? 'CUSTOMER' : 'DEFAULT';
  let hardStart = c.hardWindowStartMin;
  let hardEnd = c.hardWindowEndMin;
  let prefStart = c.prefWindowStartMin;
  let prefEnd = c.prefWindowEndMin;
  if (!own && p && [p.hardWindowStartMin, p.hardWindowEndMin, p.prefWindowStartMin, p.prefWindowEndMin].some((v) => v !== null)) {
    hardStart = p.hardWindowStartMin;
    hardEnd = p.hardWindowEndMin;
    prefStart = p.prefWindowStartMin;
    prefEnd = p.prefWindowEndMin;
    windowSource = 'TYPE';
  }
  return { priority, prioritySource, serviceMin, serviceSource, hardStart, hardEnd, prefStart, prefEnd, windowSource, windowConfirmed };
}

const SERVICE_SOURCE_TEXT: Record<AttrSource, string> = {
  CUSTOMER: "this customer's confirmed time",
  TYPE: 'customer type default',
  DEFAULT: 'Settings default service time',
};

/**
 * The `Customer.avgServiceTimeMin` column default (schema.prisma `@default(10)`). A customer
 * created without a time - from an order upload, a late order, or a form left empty - holds it
 * although nobody entered it. Migration `20260928090100_keep_imported_service_times` treats it the
 * same way (`<> 10`: not a time from a file or a form); a unit test keeps the schema, the
 * migration and this constant equal.
 */
export const CUSTOMER_SERVICE_COLUMN_DEFAULT = 10;

export interface ServiceTimeView {
  minutes: number;
  source: string;
  note: string | null;
  /** 'warning' (amber): a stored time someone entered is not used; 'info' (neutral): nothing to fix. */
  noteLevel: 'warning' | 'info' | null;
}

/**
 * The unloading time the planner uses for a customer and where it comes from, for the customer
 * page (which used to show only the stored value, even when the planner used another).
 *
 * A stored time that was never confirmed is not used. When it is a real value (from an earlier
 * import or a form), an amber note says so and how to give the customer its own time. The column
 * default (10 min) is not a time anyone entered (PR5 review): under a customer type's own time
 * there is no note at all (the type's time applied before and after PR5), and under the Settings
 * default a neutral line says the customer has no confirmed time of its own - it may still be an
 * earlier import's 10 min, which the pre-deploy check (handbook 5.12 check 11) asks to confirm.
 */
export function describeServiceTime(
  c: Pick<CustomerForPlanning, 'avgServiceTimeMin' | 'serviceTimeConfirmed' | 'customerType'>,
  eff: Pick<EffectiveAttrs, 'serviceMin' | 'serviceSource'>,
): ServiceTimeView {
  const source = eff.serviceSource === 'TYPE' && c.customerType ? `${SERVICE_SOURCE_TEXT.TYPE} (${c.customerType})` : SERVICE_SOURCE_TEXT[eff.serviceSource];
  const view = (note: string | null, noteLevel: ServiceTimeView['noteLevel']): ServiceTimeView => ({ minutes: eff.serviceMin, source, note, noteLevel });
  if (c.serviceTimeConfirmed || c.avgServiceTimeMin === eff.serviceMin) return view(null, null);
  if (c.avgServiceTimeMin === CUSTOMER_SERVICE_COLUMN_DEFAULT) {
    if (eff.serviceSource === 'TYPE') return view(null, null);
    return view(
      `No confirmed unloading time of its own (${c.avgServiceTimeMin} min stored: the column default, or an earlier import); the Settings default is used. If this customer really needs ${c.avgServiceTimeMin} min, set it in the customer details on Daily dispatch.`,
      'info',
    );
  }
  return view(
    `The stored ${c.avgServiceTimeMin} min was never confirmed, so the planner does not use it. To use a time of this customer's own, set it in the customer details on Daily dispatch or in a customer import.`,
    'warning',
  );
}

export type CoordStatus = 'OK' | 'MISSING' | 'INVALID' | 'OUTSIDE_AREA';

export function coordStatus(lat: number | null, lng: number | null, area: ServiceArea = DEFAULT_SERVICE_AREA): CoordStatus {
  if (lat === null || lng === null || lat === undefined || lng === undefined) return 'MISSING';
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180) return 'INVALID';
  if (Math.abs(lat) < 1e-6 && Math.abs(lng) < 1e-6) return 'INVALID';
  if (lat < area.minLat || lat > area.maxLat || lng < area.minLng || lng > area.maxLng) return 'OUTSIDE_AREA';
  return 'OK';
}

/**
 * A saved location that is not exact (a LOW reading) and that no dispatcher confirmed: treated like
 * an invalid location (owner's rule, audit PR A5: "no item will be delivered without location").
 * The order is not planned until the pin is placed by hand. A confirmed location, and a HIGH or
 * MEDIUM import not confirmed yet (LOCATION_UNVERIFIED, a note), are planned as before.
 */
export function isUnverifiedLowLocation(c: Pick<CustomerForPlanning, 'locationVerified' | 'geocodeConfidence'>): boolean {
  return !c.locationVerified && c.geocodeConfidence === 'LOW';
}

export const LOW_LOCATION_MESSAGE = "Saved location is not exact (low confidence). Drop the pin on the customer's exact location.";

/**
 * A saved point outside the delivery area that no dispatcher confirmed (the day card and the unserved
 * reason). It says to drop the pin: the dialog never confirms such a point as it is (A5 review); a
 * pin placed by hand that is still outside the area is then confirmed with "Confirm & save".
 */
export const OUTSIDE_AREA_LOCATION_MESSAGE = "Saved location is outside Oman/UAE and was never confirmed. Drop the pin on the customer's exact location.";

/**
 * Why the customer's saved point cannot be saved again as it is (ADD LOCATION opens on it, and Save
 * without a hand pin sends it back unchanged, which confirms it), in plain words; null = it can.
 * The dialog (to keep Save off, with this note) and PUT /api/customers/:id/location (to refuse it)
 * use this one test, both with the company's delivery area:
 *  - confirmed by a dispatcher: it can (outside the area the save still asks "Confirm & save");
 *  - outside the area, latitude and longitude swapped included: drop the pin (the reason is named);
 *  - not HIGH (MEDIUM, LOW or unknown): not exact, drop the pin.
 * The decimals of the stored number are never counted (A5 review): "23.5850" is stored as 23.585,
 * so a point read as exact would look coarse whenever it ends in 0 (about 1 in 5). Since audit PR A5
 * only an exact reading or a pin placed by hand is stored HIGH.
 */
export function savedPointProblem(
  c: { lat: number | null; lng: number | null; locationVerified?: boolean | null; geocodeConfidence?: string | null },
  area: ServiceArea = DEFAULT_SERVICE_AREA,
): string | null {
  if (c.locationVerified === true) return null;
  const cs = coordStatus(c.lat, c.lng, area);
  if (cs === 'OUTSIDE_AREA') return coordStatus(c.lng, c.lat, area) === 'OK' ? SAVED_SWAPPED_MESSAGE : SAVED_OUTSIDE_AREA_MESSAGE;
  if (cs !== 'OK' || c.geocodeConfidence !== 'HIGH') return SAVED_NOT_EXACT_MESSAGE;
  return null;
}

/**
 * A customer with no usable location, whose orders are never put on a truck (owner's rule, audit PR
 * A5): no coordinates, 0,0 or out of range, outside the delivery area and never confirmed, or a LOW
 * reading never confirmed. The same test as the blocking location issues of `customerIssues`.
 */
export function locationBlocksDelivery(
  c: Pick<CustomerForPlanning, 'lat' | 'lng' | 'locationVerified' | 'geocodeConfidence'>,
  area: ServiceArea = DEFAULT_SERVICE_AREA,
): boolean {
  const cs = coordStatus(c.lat, c.lng, area);
  return cs === 'MISSING' || cs === 'INVALID' || (cs === 'OUTSIDE_AREA' && !c.locationVerified) || isUnverifiedLowLocation(c);
}

export type IssueCode =
  | 'LOCATION_REQUIRED'
  | 'INVALID_LOCATION'
  | 'LOCATION_UNVERIFIED'
  | 'PRIORITY_UNCONFIRMED'
  | 'TYPE_MISSING'
  | 'NO_RECEIVING_WINDOW'
  | 'WINDOW_UNCONFIRMED'
  | 'NEW_CUSTOMER'
  | 'CUSTOMER_INACTIVE';

export interface CustomerIssue {
  code: IssueCode;
  blocking: boolean; // true = cannot be planned until fixed (or explicitly left unserved)
  message: string;
}

/**
 * A customer deactivated after its orders were confirmed: its open orders are left unserved at
 * optimize (reason "customer deactivated") until it is reactivated. Shown first on the day.
 */
/**
 * A deactivated customer that still has open orders (not on a frozen load). `onPlannedLoads`: the
 * plan in use was made before it was deactivated and still has them on trucks.
 */
export function inactiveCustomerIssue(onPlannedLoads = false): CustomerIssue {
  return {
    code: 'CUSTOMER_INACTIVE',
    blocking: true,
    message: onPlannedLoads
      ? 'Customer was deactivated after this plan was made: its orders are still on planned loads. RE-PLAN to leave them unserved, or reactivate it in Customers to deliver them.'
      : 'Customer is deactivated: its open orders are left unserved (not delivered). Reactivate it in Customers and re-plan to deliver them.',
  };
}

/**
 * The customer's location issue, the one the day card shows, or null (a usable point a dispatcher
 * confirmed). A blocking one is exactly `locationBlocksDelivery`. Also used by the customer page and
 * the customers list (A5 third review), so a point that blocks delivery says so there too.
 */
export function locationIssue(
  c: Pick<CustomerForPlanning, 'lat' | 'lng' | 'locationVerified' | 'geocodeConfidence'>,
  area: ServiceArea = DEFAULT_SERVICE_AREA,
): CustomerIssue | null {
  const cs = coordStatus(c.lat, c.lng, area);
  if (cs === 'MISSING') return { code: 'LOCATION_REQUIRED', blocking: true, message: 'Location missing - add a Google Maps link, coordinates or a map pin.' };
  if (cs === 'INVALID') return { code: 'INVALID_LOCATION', blocking: true, message: 'Saved location is not valid (0,0 or out of range). Set it again.' };
  if (cs === 'OUTSIDE_AREA' && !c.locationVerified) return { code: 'INVALID_LOCATION', blocking: true, message: OUTSIDE_AREA_LOCATION_MESSAGE };
  if (isUnverifiedLowLocation(c)) return { code: 'INVALID_LOCATION', blocking: true, message: LOW_LOCATION_MESSAGE };
  if (!c.locationVerified) return { code: 'LOCATION_UNVERIFIED', blocking: false, message: 'Location came from an import and was never confirmed by a dispatcher.' };
  return null;
}

export function customerIssues(c: CustomerForPlanning, eff: EffectiveAttrs, area: ServiceArea = DEFAULT_SERVICE_AREA): CustomerIssue[] {
  const out: CustomerIssue[] = [];
  const loc = locationIssue(c, area);
  if (loc) out.push(loc);
  if (c.createdFromUpload) out.push({ code: 'NEW_CUSTOMER', blocking: false, message: 'New customer created from the order file.' });
  if (eff.prioritySource === 'DEFAULT') {
    out.push({ code: 'PRIORITY_UNCONFIRMED', blocking: false, message: `Priority P${eff.priority} is a default - confirm it (P1 highest, P5 lowest).` });
  }
  if (!c.customerType) out.push({ code: 'TYPE_MISSING', blocking: false, message: 'Customer type not set (hypermarket, grocery, ...). Type defaults fill receiving hours.' });
  const w = windowIssue(eff);
  if (w) out.push(w);
  return out;
}

/**
 * The receiving-hours note of a customer without an own confirmed window (owner decision 1 Oct
 * 2026), or null. Planning still uses the hours shown (a default, or hours nobody confirmed).
 */
export function windowIssue(eff: Pick<EffectiveAttrs, 'hardStart' | 'hardEnd' | 'prefStart' | 'prefEnd' | 'windowSource' | 'windowConfirmed'>): CustomerIssue | null {
  if (eff.windowConfirmed) return null;
  if (eff.hardStart === null && eff.hardEnd === null && eff.prefStart === null && eff.prefEnd === null) {
    return {
      code: 'NO_RECEIVING_WINDOW',
      blocking: false,
      message: 'No receiving hours known - any time in the shift is allowed. Ask the customer and enter them in Details (or tick "Open all day").',
    };
  }
  return {
    code: 'WINDOW_UNCONFIRMED',
    blocking: false,
    message:
      eff.windowSource === 'TYPE'
        ? `Receiving hours (${describeWindows(eff)}) are the customer-type default - not confirmed. Confirm them in Details.`
        : `Receiving hours (${describeWindows(eff)}) were never confirmed by a dispatcher - confirm them in Details.`,
  };
}

/**
 * The receiving hours as the day screen shows them, with where they come from: "hard 06:00–10:00
 * (confirmed)", "Open all day (confirmed)", "... (not confirmed)" or "... (default - not confirmed)".
 */
export function windowLabel(eff: Pick<EffectiveAttrs, 'hardStart' | 'hardEnd' | 'prefStart' | 'prefEnd' | 'windowSource' | 'windowConfirmed'>): string {
  const hours = describeWindows(eff);
  if (eff.windowConfirmed) return hours === 'Any time' ? 'Open all day (confirmed)' : `${hours} (confirmed)`;
  if (eff.windowSource === 'CUSTOMER') return `${hours} (not confirmed)`;
  return `${hours} (default - not confirmed)`;
}

/** The refusal when a dispatcher tries to change a saved location (owner decision 1 Oct 2026, item 5). */
export const LOCATION_ADMIN_ONLY_MESSAGE = 'Only an admin can change a saved location.';

/**
 * Owner decision 1 Oct 2026 (item 5, location admin-lock): a dispatcher may set a location only while
 * the customer has no usable location (`locationBlocksDelivery`: none, 0,0 or out of range, outside
 * the area and never confirmed, or a LOW reading never confirmed). Changing a usable one needs the
 * company admin (`isAdmin`: TENANT_ADMIN or SUPER_ADMIN, rbac canManageMasterData). Confirming the
 * saved point as it is changes nothing and stays allowed (the callers compare the points).
 */
export function savedLocationLocked(
  isAdmin: boolean,
  c: Pick<CustomerForPlanning, 'lat' | 'lng' | 'locationVerified' | 'geocodeConfidence'>,
  area: ServiceArea = DEFAULT_SERVICE_AREA,
): boolean {
  return !isAdmin && !locationBlocksDelivery(c, area);
}

export function describeWindows(eff: Pick<EffectiveAttrs, 'hardStart' | 'hardEnd' | 'prefStart' | 'prefEnd'>): string {
  const hard = eff.hardStart !== null || eff.hardEnd !== null ? `hard ${fmtWindow(eff.hardStart, eff.hardEnd)}` : null;
  const pref = eff.prefStart !== null || eff.prefEnd !== null ? `preferred ${fmtWindow(eff.prefStart, eff.prefEnd)}` : null;
  return [hard, pref].filter(Boolean).join(', ') || 'Any time';
}

// Tenant.country is free text ("Oman", "Sultanate of Oman", "OM", "UAE", "Émirats arabes unis",
// "عمان", "الامارات", ...). Keep in sync with migration 20260924093000_osrm_default_provider.
const OMAN_UAE = /(^|[^a-z])(oman|om|omn|uae|u\.a\.e|ae|are|muscat|dubai|abu dhabi|sharjah)([^a-z]|$)|[eé]mira[td]|عمان|عُمان|ال[اإ]مارات/i;

/** Tenant based in Oman or the UAE (blank / unknown counts as Oman, the NMWC default). */
export function isOmanUae(country: string | null | undefined): boolean {
  const c = (country ?? '').trim();
  return !c || OMAN_UAE.test(c);
}

const UAE = /(^|[^a-z])(uae|u\.a\.e|ae|are|dubai|abu dhabi|sharjah)([^a-z]|$)|[eé]mira[td]|ال[اإ]مارات/i;

/**
 * Calling code for phones saved without one (WhatsApp links): 971 in the UAE, 968 in Oman (and
 * for a blank country, the NMWC default - as isOmanUae), null elsewhere (no guess).
 */
export function phoneCountryCode(country: string | null | undefined): string | null {
  if (!isOmanUae(country)) return null;
  return UAE.test((country ?? '').trim()) ? '971' : '968';
}

/** No area check: every valid coordinate is inside. */
export const WHOLE_WORLD: ServiceArea = { minLat: -90, maxLat: 90, minLng: -180, maxLng: 180 };

/**
 * Tenant service area. A configured box wins. Otherwise Oman + UAE for tenants based there,
 * or no area check for tenants in other countries, whose customers would all look "outside".
 * `country` omitted = Oman + UAE (the NMWC default).
 */
export function parseServiceArea(json: unknown, country?: string | null): ServiceArea {
  const j = json as Partial<ServiceArea> | null;
  if (j && [j.minLat, j.maxLat, j.minLng, j.maxLng].every((v) => typeof v === 'number')) return j as ServiceArea;
  if (country != null && !isOmanUae(country)) return WHOLE_WORLD;
  return DEFAULT_SERVICE_AREA;
}

/**
 * Distance provider actually used. The shared routing server (OSRM_URL) holds Oman + UAE roads
 * only: a tenant elsewhere plans on straight-line estimates unless it configured its own OSRM,
 * otherwise its stops would be snapped onto Omani roads and reported as road km.
 */
export function routingProviderFor(
  cfg: { distanceProvider: string; osrmUrl?: string | null },
  country: string | null | undefined,
): { provider: 'HAVERSINE' | 'OSRM'; outsideCoverage: boolean } {
  if (cfg.distanceProvider === 'HAVERSINE') return { provider: 'HAVERSINE', outsideCoverage: false };
  if (!cfg.osrmUrl && !isOmanUae(country)) return { provider: 'HAVERSINE', outsideCoverage: true };
  return { provider: 'OSRM', outsideCoverage: false };
}

export const DEFAULT_PRIORITY_WEIGHTS: Record<number, number> = { 1: 10000, 2: 1000, 3: 100, 4: 10, 5: 1 };

/** Validates a tenant priority-weight table: must exist for P1..P5 and strictly decrease. */
export function parsePriorityWeights(json: unknown): Record<number, number> {
  const j = (json ?? null) as Record<string, number> | null;
  if (!j) return DEFAULT_PRIORITY_WEIGHTS;
  const w: Record<number, number> = {};
  for (let p = 1; p <= 5; p++) {
    const v = Number(j[String(p)]);
    if (!Number.isFinite(v) || v <= 0) return DEFAULT_PRIORITY_WEIGHTS;
    w[p] = v;
  }
  for (let p = 1; p < 5; p++) if (!(w[p] > w[p + 1])) return DEFAULT_PRIORITY_WEIGHTS;
  return w;
}
