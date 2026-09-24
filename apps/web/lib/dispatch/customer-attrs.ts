/**
 * Effective delivery attributes of a customer branch, and the issues the dispatcher must (or
 * may) resolve before optimizing.
 *
 * Precedence for every attribute: the customer's own value > the customer-type default >
 * the tenant default. Priority 1 is the HIGHEST, 5 the LOWEST - everywhere.
 */
import { DEFAULT_SERVICE_AREA, type ServiceArea } from './location-input';
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
  let serviceMin = c.avgServiceTimeMin;
  let serviceSource: AttrSource = 'CUSTOMER';
  if (!c.serviceTimeConfirmed) {
    if (p?.serviceTimeMin != null) {
      serviceMin = p.serviceTimeMin;
      serviceSource = 'TYPE';
    } else if (c.avgServiceTimeMin > 0) {
      serviceSource = 'DEFAULT';
    } else {
      serviceMin = defaults.serviceTimeMin;
      serviceSource = 'DEFAULT';
    }
  }
  const own = [c.hardWindowStartMin, c.hardWindowEndMin, c.prefWindowStartMin, c.prefWindowEndMin].some((v) => v !== null);
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
  return { priority, prioritySource, serviceMin, serviceSource, hardStart, hardEnd, prefStart, prefEnd, windowSource };
}

export type CoordStatus = 'OK' | 'MISSING' | 'INVALID' | 'OUTSIDE_AREA';

export function coordStatus(lat: number | null, lng: number | null, area: ServiceArea = DEFAULT_SERVICE_AREA): CoordStatus {
  if (lat === null || lng === null || lat === undefined || lng === undefined) return 'MISSING';
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180) return 'INVALID';
  if (Math.abs(lat) < 1e-6 && Math.abs(lng) < 1e-6) return 'INVALID';
  if (lat < area.minLat || lat > area.maxLat || lng < area.minLng || lng > area.maxLng) return 'OUTSIDE_AREA';
  return 'OK';
}

export type IssueCode =
  | 'LOCATION_REQUIRED'
  | 'INVALID_LOCATION'
  | 'LOCATION_UNVERIFIED'
  | 'PRIORITY_UNCONFIRMED'
  | 'TYPE_MISSING'
  | 'NO_RECEIVING_WINDOW'
  | 'NEW_CUSTOMER';

export interface CustomerIssue {
  code: IssueCode;
  blocking: boolean; // true = cannot be planned until fixed (or explicitly left unserved)
  message: string;
}

export function customerIssues(c: CustomerForPlanning, eff: EffectiveAttrs, area: ServiceArea = DEFAULT_SERVICE_AREA): CustomerIssue[] {
  const out: CustomerIssue[] = [];
  const cs = coordStatus(c.lat, c.lng, area);
  if (cs === 'MISSING') out.push({ code: 'LOCATION_REQUIRED', blocking: true, message: 'Location missing - add a Google Maps link, coordinates or a map pin.' });
  else if (cs === 'INVALID') out.push({ code: 'INVALID_LOCATION', blocking: true, message: 'Saved location is not valid (0,0 or out of range). Set it again.' });
  else if (cs === 'OUTSIDE_AREA' && !c.locationVerified) {
    out.push({ code: 'INVALID_LOCATION', blocking: true, message: 'Saved location is outside Oman/UAE. Confirm or correct it on the map.' });
  } else if (!c.locationVerified) {
    out.push({ code: 'LOCATION_UNVERIFIED', blocking: false, message: 'Location came from an import and was never confirmed by a dispatcher.' });
  }
  if (c.createdFromUpload) out.push({ code: 'NEW_CUSTOMER', blocking: false, message: 'New customer created from the order file.' });
  if (eff.prioritySource === 'DEFAULT') {
    out.push({ code: 'PRIORITY_UNCONFIRMED', blocking: false, message: `Priority P${eff.priority} is a default - confirm it (P1 highest, P5 lowest).` });
  }
  if (!c.customerType) out.push({ code: 'TYPE_MISSING', blocking: false, message: 'Customer type not set (hypermarket, grocery, ...). Type defaults fill receiving hours.' });
  if (eff.hardStart === null && eff.hardEnd === null && eff.prefStart === null && eff.prefEnd === null) {
    out.push({ code: 'NO_RECEIVING_WINDOW', blocking: false, message: 'No receiving hours known - any time in the shift is allowed.' });
  }
  return out;
}

export function describeWindows(eff: EffectiveAttrs): string {
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
