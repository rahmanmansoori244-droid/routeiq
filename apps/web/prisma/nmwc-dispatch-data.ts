/**
 * Deterministic NMWC demo master data + daily sales-order file generators for the dispatch MVP.
 *
 * Pure: no database, no filesystem. Used by
 *   - prisma/seed-nmwc-dispatch.ts      (local demo tenant "nmwc")
 *   - prisma/nmwc-dispatch-fixtures.ts  (committed sample files in tests/fixtures/nmwc/)
 *   - integration tests / benchmarks    (regenerate files for a future date at runtime)
 *
 * Everything is driven by a seeded PRNG (mulberry32), so the same inputs always give the same
 * customers, coordinates and order rows. All names are FICTIONAL; coordinates are real Muscat-area
 * neighbourhood centres with < 1.2 km jitter (biased inland next to the coast) so pins land on land.
 * Prices / margins are ILLUSTRATIVE demo values, not an NMWC price list.
 *
 * Priority: P1 = HIGHEST ... P5 = LOWEST. Times are minutes from local midnight (06:30 -> 390).
 */
import * as XLSX from 'xlsx';

// --------------------------------------------------------------------------------------
// PRNG helpers
// --------------------------------------------------------------------------------------

export type Rand = () => number;

/** mulberry32: tiny, fast, good enough for demo data; identical output on every platform. */
export function mulberry32(seed: number): Rand {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** FNV-1a 32-bit: turns a string (e.g. a date) into a PRNG seed. */
export function hashSeed(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export function randInt(rand: Rand, lo: number, hi: number): number {
  return lo + Math.floor(rand() * (hi - lo + 1));
}

export function pick<T>(rand: Rand, items: readonly T[]): T {
  return items[Math.floor(rand() * items.length)];
}

export function shuffle<T>(rand: Rand, items: readonly T[]): T[] {
  const a = [...items];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function weightedPick<T>(rand: Rand, items: readonly T[], weight: (t: T) => number): T {
  const total = items.reduce((a, t) => a + weight(t), 0);
  let r = rand() * total;
  for (const t of items) {
    r -= weight(t);
    if (r < 0) return t;
  }
  return items[items.length - 1];
}

const round = (v: number, dp: number) => {
  const f = 10 ** dp;
  return Math.round(v * f) / f;
};

// --------------------------------------------------------------------------------------
// Tenant, depot, users, config
// --------------------------------------------------------------------------------------

export const NMWC_TENANT = {
  slug: 'nmwc',
  name: 'National Mineral Water Co. (demo)',
  country: 'Oman',
  currency: 'OMR',
} as const;

export interface NmwcDepotSeed {
  code: string;
  name: string;
  lat: number;
  lng: number;
  address: string;
  openMin: number;
  closeMin: number;
}

export const NMWC_DEPOT: NmwcDepotSeed = {
  code: 'MCT-GHALA',
  name: 'Muscat Depot (Ghala)',
  lat: 23.568,
  lng: 58.392,
  address: 'Ghala Industrial Area, Muscat',
  openMin: 300, // 05:00
  closeMin: 1380, // 23:00
};

export function buildDepot(): NmwcDepotSeed {
  return { ...NMWC_DEPOT };
}

export type NmwcRole = 'PLANNER' | 'SUPERVISOR' | 'TENANT_ADMIN';

/** Demo logins. Passwords are NEVER part of the data: the seed reads SEED_PASSWORD or generates one. */
export const NMWC_USERS: { email: string; name: string; role: NmwcRole }[] = [
  { email: 'dispatcher@nmwc.local', name: 'NMWC Dispatcher', role: 'PLANNER' },
  { email: 'supervisor@nmwc.local', name: 'NMWC Supervisor', role: 'SUPERVISOR' },
  { email: 'admin@nmwc.local', name: 'NMWC Admin', role: 'TENANT_ADMIN' },
];

/**
 * Dispatch settings for the demo tenant (TenantConfig columns). Tenant-editable in the app.
 * ASSUMPTION: fuelPricePerLitre 0.26 OMR is an approximate Oman diesel pump price - confirm
 * with NMWC finance before quoting fuel costs.
 */
export const NMWC_DISPATCH_CONFIG = {
  timezone: 'Asia/Muscat',
  planningCutoffMin: 1080, // 18:00 the day before delivery
  shiftStartMin: 360, // 06:00 earliest departure
  driverShiftMaxMinutes: 660, // 11 h
  reloadMinutes: 30,
  maxTripsPerTruck: 3,
  fuelPricePerLitre: 0.26, // ASSUMPTION (see above)
  driverCostPerHour: 2.5,
  overtimeAfterMin: 540,
  overtimeCostPerHour: 4,
  prefWindowPenaltyPerMin: 0.05,
  roadTimeFactor: 1.25,
  distanceProvider: 'OSRM' as const,
  osrmUrl: null as string | null, // null = the solver's OSRM_URL env var
  distanceMultiplier: 1.3,
  avgSpeedKmh: 40,
  defaultServiceTimeMin: 10,
  dateOrder: 'DMY',
};

// --------------------------------------------------------------------------------------
// Drivers + trucks
// --------------------------------------------------------------------------------------

export interface NmwcDriverSeed {
  code: string;
  name: string;
}

export function buildDrivers(count = 12): NmwcDriverSeed[] {
  return Array.from({ length: count }, (_, i) => {
    const n = String(i + 1);
    return { code: `DR-${n.padStart(3, '0')}`, name: `Driver ${n.padStart(2, '0')}` };
  });
}

export type TruckClass = 'SMALL' | 'MEDIUM' | 'LARGE';

export interface NmwcTruckSeed {
  code: string;
  description: string;
  truckClass: TruckClass;
  capacityCases: number;
  capacityWeightKg: number;
  fixedCostPerDay: number;
  costPerKm: number; // excluding fuel (fuel = km / kmPerLitre x fuel price)
  kmPerLitre: number;
  tripCost: number;
  defaultDriverCode: string;
}

export const TRUCK_CLASSES: Record<TruckClass, Omit<NmwcTruckSeed, 'code' | 'defaultDriverCode' | 'truckClass'>> = {
  SMALL: { description: 'Small box truck (3.5 t)', capacityCases: 300, capacityWeightKg: 3500, fixedCostPerDay: 18, costPerKm: 0.06, kmPerLitre: 7, tripCost: 2 },
  MEDIUM: { description: 'Medium box truck (6.5 t)', capacityCases: 550, capacityWeightKg: 6500, fixedCostPerDay: 25, costPerKm: 0.08, kmPerLitre: 5, tripCost: 2 },
  LARGE: { description: 'Large box truck (10.5 t)', capacityCases: 900, capacityWeightKg: 10500, fixedCostPerDay: 35, costPerKm: 0.1, kmPerLitre: 3.5, tripCost: 3 },
};

// 3 large, 5 medium, 4 small: one fleet trip carries ~6,650 cases / 78 t.
const FLEET: TruckClass[] = ['LARGE', 'MEDIUM', 'SMALL', 'MEDIUM', 'LARGE', 'SMALL', 'MEDIUM', 'MEDIUM', 'SMALL', 'LARGE', 'MEDIUM', 'SMALL'];

export function buildTrucks(): NmwcTruckSeed[] {
  const drivers = buildDrivers(FLEET.length);
  return FLEET.map((cls, i) => ({
    code: `T${String(i + 1).padStart(2, '0')}`,
    truckClass: cls,
    ...TRUCK_CLASSES[cls],
    defaultDriverCode: drivers[i].code,
  }));
}

// --------------------------------------------------------------------------------------
// Products
// --------------------------------------------------------------------------------------

export interface NmwcProductSeed {
  code: string;
  name: string;
  weightPerCaseKg: number;
  unitsPerCase: number;
  volumePerCaseL: number; // approximate packed volume
  casesPerPallet: number; // approximate
  listPriceOmr: number; // ILLUSTRATIVE price per case, demo only
  marginPct: number; // ILLUSTRATIVE contribution margin share of net value
}

export const NMWC_PRODUCTS: NmwcProductSeed[] = [
  { code: 'TAN-330-24', name: 'Tanuf 330ml x24', weightPerCaseKg: 8.6, unitsPerCase: 24, volumePerCaseL: 9.5, casesPerPallet: 110, listPriceOmr: 2.3, marginPct: 0.22 },
  { code: 'TAN-500-24', name: 'Tanuf 500ml x24', weightPerCaseKg: 12.8, unitsPerCase: 24, volumePerCaseL: 14, casesPerPallet: 80, listPriceOmr: 2.6, marginPct: 0.25 },
  { code: 'TAN-1500-6', name: 'Tanuf 1.5L x6', weightPerCaseKg: 9.4, unitsPerCase: 6, volumePerCaseL: 10.5, casesPerPallet: 100, listPriceOmr: 1.45, marginPct: 0.2 },
  { code: 'TAN-5L-4', name: 'Tanuf 5L x4', weightPerCaseKg: 20.6, unitsPerCase: 4, volumePerCaseL: 22, casesPerPallet: 48, listPriceOmr: 2.1, marginPct: 0.18 },
  { code: 'TAN-19L', name: 'Tanuf 19L gallon', weightPerCaseKg: 20.5, unitsPerCase: 1, volumePerCaseL: 24, casesPerPallet: 40, listPriceOmr: 0.9, marginPct: 0.35 },
  { code: 'JAB-500-24', name: 'Jabal 500ml x24', weightPerCaseKg: 12.7, unitsPerCase: 24, volumePerCaseL: 14, casesPerPallet: 80, listPriceOmr: 2.1, marginPct: 0.16 },
  { code: 'JAB-1500-6', name: 'Jabal 1.5L x6', weightPerCaseKg: 9.3, unitsPerCase: 6, volumePerCaseL: 10.5, casesPerPallet: 100, listPriceOmr: 1.2, marginPct: 0.14 },
  { code: 'TIS-FAC-30', name: 'Tissue facial box x30', weightPerCaseKg: 6.2, unitsPerCase: 30, volumePerCaseL: 60, casesPerPallet: 30, listPriceOmr: 7.8, marginPct: 0.12 },
  { code: 'TIS-ROLL-10', name: 'Tissue roll x10', weightPerCaseKg: 4.8, unitsPerCase: 10, volumePerCaseL: 45, casesPerPallet: 40, listPriceOmr: 3.3, marginPct: 0.1 },
];

export function buildProducts(): NmwcProductSeed[] {
  return NMWC_PRODUCTS.map((p) => ({ ...p }));
}

/** An item code that is deliberately NOT in the product master (exercises "new product"). */
export const UNKNOWN_PRODUCT = { code: 'TAN-750-SC', name: 'Tanuf 750ml sports cap x12' } as const;

// --------------------------------------------------------------------------------------
// Customer type profiles (tenant-editable defaults, NOT universal rules)
// --------------------------------------------------------------------------------------

export type CustomerTypeName = 'HYPERMARKET' | 'SUPERMARKET' | 'TRADING' | 'CATERING' | 'HORECA' | 'GROCERY' | 'WHOLESALE' | 'OTHER';

export interface NmwcTypeProfileSeed {
  customerType: CustomerTypeName;
  defaultPriority: number;
  serviceTimeMin: number;
  hardWindowStartMin: number | null;
  hardWindowEndMin: number | null;
  prefWindowStartMin: number | null;
  prefWindowEndMin: number | null;
}

const hm = (h: number, m = 0) => h * 60 + m;

export const NMWC_TYPE_PROFILES: NmwcTypeProfileSeed[] = [
  { customerType: 'HYPERMARKET', defaultPriority: 1, serviceTimeMin: 35, hardWindowStartMin: hm(6), hardWindowEndMin: hm(11), prefWindowStartMin: hm(6, 30), prefWindowEndMin: hm(9, 30) },
  { customerType: 'SUPERMARKET', defaultPriority: 2, serviceTimeMin: 20, hardWindowStartMin: hm(6), hardWindowEndMin: hm(14), prefWindowStartMin: hm(7), prefWindowEndMin: hm(11) },
  { customerType: 'TRADING', defaultPriority: 3, serviceTimeMin: 15, hardWindowStartMin: hm(7), hardWindowEndMin: hm(12, 30), prefWindowStartMin: null, prefWindowEndMin: null },
  { customerType: 'CATERING', defaultPriority: 3, serviceTimeMin: 15, hardWindowStartMin: hm(7), hardWindowEndMin: hm(12), prefWindowStartMin: null, prefWindowEndMin: null },
  { customerType: 'HORECA', defaultPriority: 3, serviceTimeMin: 12, hardWindowStartMin: hm(8), hardWindowEndMin: hm(16), prefWindowStartMin: hm(9), prefWindowEndMin: hm(12) },
  { customerType: 'GROCERY', defaultPriority: 4, serviceTimeMin: 8, hardWindowStartMin: hm(7), hardWindowEndMin: hm(21), prefWindowStartMin: hm(9), prefWindowEndMin: hm(17) },
  { customerType: 'WHOLESALE', defaultPriority: 3, serviceTimeMin: 25, hardWindowStartMin: hm(7), hardWindowEndMin: hm(17), prefWindowStartMin: null, prefWindowEndMin: null },
  { customerType: 'OTHER', defaultPriority: 5, serviceTimeMin: 10, hardWindowStartMin: null, hardWindowEndMin: null, prefWindowStartMin: null, prefWindowEndMin: null },
];

export function buildTypeProfiles(): NmwcTypeProfileSeed[] {
  return NMWC_TYPE_PROFILES.map((p) => ({ ...p }));
}

const PROFILE_BY_TYPE = new Map(NMWC_TYPE_PROFILES.map((p) => [p.customerType, p]));

// --------------------------------------------------------------------------------------
// Areas + regions
// --------------------------------------------------------------------------------------

export interface NmwcRegionSeed {
  code: string;
  name: string;
}

export const NMWC_REGIONS: NmwcRegionSeed[] = [
  { code: 'MCT-CENTRAL', name: 'Muscat Central (Khuwair, Qurum, Ghubrah, Azaiba, Bawshar, Ansab)' },
  { code: 'MCT-OLD', name: 'Old Muscat (Ruwi, Muttrah, Wadi Kabir)' },
  { code: 'MCT-SOUTH', name: 'Al Amerat' },
  { code: 'SEEB', name: 'Seeb (Al Hail, Mawaleh, Mabellah)' },
  { code: 'RUSAYL', name: 'Rusayl / Halban' },
  { code: 'BATINAH', name: 'Barka (South Al Batinah)' },
  { code: 'QURIYAT', name: 'Quriyat' },
];

export interface NmwcArea {
  name: string;
  lat: number;
  lng: number;
  regionCode: string;
  weight: number; // relative share of customer branches
  maxKm: number; // jitter radius, < 1.2 km
  // Coastal centres: keep the jitter on the landward side so pins never land in the sea.
  inland?: 'S' | 'SW';
  city: string;
}

export const NMWC_AREAS: NmwcArea[] = [
  { name: 'Al Khuwair', lat: 23.588, lng: 58.408, regionCode: 'MCT-CENTRAL', weight: 14, maxKm: 1.0, city: 'Muscat' },
  { name: 'Ruwi', lat: 23.598, lng: 58.543, regionCode: 'MCT-OLD', weight: 14, maxKm: 1.1, city: 'Muscat' },
  { name: 'Seeb', lat: 23.67, lng: 58.189, regionCode: 'SEEB', weight: 14, maxKm: 0.9, inland: 'S', city: 'Seeb' },
  { name: 'Mabellah', lat: 23.642, lng: 58.11, regionCode: 'SEEB', weight: 10, maxKm: 1.1, city: 'Seeb' },
  { name: 'Bawshar', lat: 23.57, lng: 58.395, regionCode: 'MCT-CENTRAL', weight: 12, maxKm: 1.1, city: 'Muscat' },
  { name: 'Al Amerat', lat: 23.519, lng: 58.497, regionCode: 'MCT-SOUTH', weight: 10, maxKm: 1.1, city: 'Muscat' },
  { name: 'Qurum', lat: 23.614, lng: 58.475, regionCode: 'MCT-CENTRAL', weight: 10, maxKm: 0.6, inland: 'S', city: 'Muscat' },
  { name: 'Ghubrah', lat: 23.6, lng: 58.371, regionCode: 'MCT-CENTRAL', weight: 8, maxKm: 0.6, inland: 'S', city: 'Muscat' },
  { name: 'Al Hail', lat: 23.648, lng: 58.253, regionCode: 'SEEB', weight: 10, maxKm: 0.9, inland: 'S', city: 'Seeb' },
  { name: 'Mawaleh', lat: 23.617, lng: 58.237, regionCode: 'SEEB', weight: 10, maxKm: 1.1, city: 'Seeb' },
  { name: 'Azaiba', lat: 23.598, lng: 58.34, regionCode: 'MCT-CENTRAL', weight: 8, maxKm: 0.6, inland: 'S', city: 'Muscat' },
  { name: 'Muttrah', lat: 23.617, lng: 58.566, regionCode: 'MCT-OLD', weight: 8, maxKm: 0.5, inland: 'S', city: 'Muscat' },
  { name: 'Wadi Kabir', lat: 23.585, lng: 58.56, regionCode: 'MCT-OLD', weight: 8, maxKm: 1.0, city: 'Muscat' },
  { name: 'Rusayl', lat: 23.558, lng: 58.198, regionCode: 'RUSAYL', weight: 6, maxKm: 1.1, city: 'Seeb' },
  { name: 'Halban', lat: 23.607, lng: 58.08, regionCode: 'RUSAYL', weight: 4, maxKm: 1.1, city: 'Seeb' },
  { name: 'Al Ansab', lat: 23.555, lng: 58.335, regionCode: 'MCT-CENTRAL', weight: 6, maxKm: 1.0, city: 'Muscat' },
  { name: 'Barka', lat: 23.678, lng: 57.889, regionCode: 'BATINAH', weight: 4, maxKm: 1.0, inland: 'S', city: 'Barka' },
  { name: 'Quriyat', lat: 23.263, lng: 58.916, regionCode: 'QURIYAT', weight: 2, maxKm: 0.5, inland: 'SW', city: 'Quriyat' },
];

const AREA_BY_NAME = new Map(NMWC_AREAS.map((a) => [a.name, a]));

/** Random point within `area.maxKm` of the centre (uniform over the disc / half-disc). */
function jitter(rand: Rand, area: NmwcArea): { lat: number; lng: number } {
  const r = Math.sqrt(rand()) * area.maxKm;
  const theta = rand() * 2 * Math.PI;
  let dLatKm = r * Math.sin(theta);
  let dLngKm = r * Math.cos(theta);
  if (area.inland) dLatKm = -Math.abs(dLatKm);
  if (area.inland === 'SW') dLngKm = -Math.abs(dLngKm);
  const lat = area.lat + dLatKm / 110.574;
  const lng = area.lng + dLngKm / (111.32 * Math.cos((area.lat * Math.PI) / 180));
  return { lat: round(lat, 5), lng: round(lng, 5) };
}

// --------------------------------------------------------------------------------------
// Customers
// --------------------------------------------------------------------------------------

export type PaymentTypeName = 'CASH' | 'CREDIT' | 'PREPAID';

export interface NmwcCustomerSeed {
  code: string;
  branchCode: string | null;
  branchKey: string; // '__MAIN__' when there is no branch code (same rule as normalizeBranchKey)
  name: string;
  customerType: CustomerTypeName | null;
  area: string;
  regionCode: string;
  address: string;
  lat: number | null;
  lng: number | null;
  geocodeConfidence: string | null;
  priority: number; // own value; only used by planning when priorityConfirmed
  priorityConfirmed: boolean;
  avgServiceTimeMin: number;
  serviceTimeConfirmed: boolean;
  hardWindowStartMin: number | null; // own windows; null = use the type profile
  hardWindowEndMin: number | null;
  prefWindowStartMin: number | null;
  prefWindowEndMin: number | null;
  paymentType: PaymentTypeName;
  accessNotes: string | null;
  locationSource: 'IMPORT' | null;
  locationVerified: boolean;
  isChainBranch: boolean;
}

/** Master size used by the demo, fixtures and --orders (branches, not distinct codes). */
export const NMWC_BASE_BRANCHES = 180;
/** Extended master for the ~400-stop benchmark file (seed with --customers=480). */
export const NMWC_BENCHMARK_BRANCHES = 480;
export const NMWC_MISSING_LOCATION_COUNT = 8;
export const NMWC_UNCONFIRMED_PRIORITY_COUNT = 10;

interface ChainDef {
  brand: string;
  type: CustomerTypeName;
  areas: string[];
}

// Customers with 2-3 branches under the same code (branch codes B01, B02, ...).
const CHAINS: ChainDef[] = [
  { brand: 'Palm Grove Hypermarket', type: 'HYPERMARKET', areas: ['Bawshar', 'Seeb', 'Al Amerat'] },
  { brand: 'Al Waha Hypermarket', type: 'HYPERMARKET', areas: ['Al Khuwair', 'Mabellah', 'Ruwi'] },
  { brand: 'Crescent Hypermarket', type: 'HYPERMARKET', areas: ['Qurum', 'Al Hail'] },
  { brand: 'Sahil Fresh Supermarket', type: 'SUPERMARKET', areas: ['Azaiba', 'Wadi Kabir', 'Mawaleh'] },
  { brand: 'Bustan Supermarket', type: 'SUPERMARKET', areas: ['Ghubrah', 'Muttrah'] },
  { brand: 'Al Noor Grocery', type: 'GROCERY', areas: ['Ruwi', 'Al Ansab'] },
];

// Single-branch customers per type. With the 15 chain branches: 180 branches,
// ~8% hypermarket, 12% supermarket, 10% trading, 8% catering, 8% HORECA, 50% grocery, 4% wholesale.
const SINGLES: [CustomerTypeName | null, number][] = [
  ['HYPERMARKET', 6],
  ['SUPERMARKET', 17],
  ['TRADING', 18],
  ['CATERING', 14],
  ['HORECA', 14],
  ['GROCERY', 86],
  ['WHOLESALE', 7],
  ['OTHER', 1],
  [null, 2], // type not classified yet (exercises TYPE_MISSING / PRIORITY_UNCONFIRMED)
];

// Fictional, generic names only - never real retailer brands.
const NAME_POOLS: Record<string, { words: string[]; suffixes: string[] }> = {
  HYPERMARKET: { words: ['Najma', 'Rimal', 'Sadaf', 'Al Fajr', 'Dana', 'Zahra', 'Mirbat Gate'], suffixes: ['Hypermarket'] },
  SUPERMARKET: {
    words: ['Al Salam', 'Green Valley', 'Family Choice', 'Al Barakah', 'Sunrise', 'Al Amal', 'Wadi Fresh', 'City Basket', 'Al Nahda', 'Golden Palm', 'Al Rawda', 'Blue Coast', 'Al Qamar', 'Fresh Day', 'Al Murooj', 'Hilltop', 'Al Yasmeen', 'Oasis Corner', 'Al Shorouq'],
    suffixes: ['Supermarket'],
  },
  TRADING: {
    words: ['Al Bahja', 'Sea Breeze', 'Horizon', 'Al Hikma', 'Silver Line', 'Al Majd', 'Al Rayyan', 'Gulf Star', 'Al Ameen', 'Desert Rose', 'Al Wafa', 'Twin Palms'],
    suffixes: ['Trading LLC', 'General Trading', 'Trading & Services'],
  },
  CATERING: {
    words: ['Coastal', 'Al Mazaya', 'Golden Spoon', 'Royal Feast', 'Al Diyafa', 'Green Oasis', 'Al Sufra', 'Seaside', 'Prime Meal', 'Al Tayyib', 'Evergreen', 'Al Reef', 'Majlis', 'Harvest'],
    suffixes: ['Catering Co.', 'Catering Services'],
  },
  HORECA: {
    words: ['Seashell', 'Frankincense', 'Al Bahar', 'Date Palm', 'Dhow', 'Mountain View', 'Al Marsa', 'Karak Corner', 'Saffron', 'Olive Tree', 'Al Areesh', 'Corniche', 'Qahwa House', 'Palm Shade'],
    suffixes: ['Restaurant', 'Cafe', 'Hotel Apartments'],
  },
  GROCERY: {
    words: [
      'Al Salam', 'Al Barakah', 'Al Rahma', 'Al Fajr', 'Al Huda', 'Al Iman', 'Al Khair', 'Al Sabah', 'Al Nakheel', 'Al Wadi',
      'Al Shams', 'Al Qamar', 'Al Bader', 'Al Hilal', 'Al Manar', 'Al Rawdha', 'Al Safa', 'Al Marwa', 'Al Yusr', 'Al Anwar',
      'Al Ghaith', 'Al Sahwa', 'Al Nujoom', 'Al Rayan', 'Al Tawfiq', 'Al Bashayer', 'Al Ikhlas', 'Al Shifa', 'Al Mustaqbal',
    ],
    suffixes: ['Grocery', 'Mini Mart', 'Foodstuff', 'Baqala', 'Shopping Centre'],
  },
  WHOLESALE: { words: ['Gulf Pearl', 'Al Mawared', 'Northern Star', 'Al Wadi Central', 'Hayat', 'Coastline', 'Al Watan', 'Sahara Bulk'], suffixes: ['Wholesale Foodstuff'] },
  OTHER: { words: ['Community Club', 'Staff Village', 'Private School'], suffixes: ['Canteen'] },
  NONE: { words: ['Al Bayan', 'Al Furqan', 'Al Sadd', 'Al Fanar'], suffixes: ['Stores'] },
};

const ACCESS_NOTES = [
  'Receiving at the rear gate.',
  'Call the store manager 20 minutes before arrival.',
  'Narrow lane - park on the main road and trolley in.',
  'Loading bay shared with other suppliers; expect a short wait.',
  'Security pass needed at the gate.',
  'No deliveries during Friday prayers.',
];

function namesFor(rand: Rand, typeKey: string, n: number): string[] {
  const pool = NAME_POOLS[typeKey];
  const combos: string[] = [];
  for (const w of pool.words) for (const s of pool.suffixes) combos.push(`${w} ${s}`);
  const shuffled = shuffle(rand, combos);
  // Pools are sized for the base master; wrap with a number if a caller asks for more.
  return Array.from({ length: n }, (_, i) => (i < shuffled.length ? shuffled[i] : `${shuffled[i % shuffled.length]} ${Math.floor(i / shuffled.length) + 1}`));
}

function addressFor(rand: Rand, area: NmwcArea): string {
  return `Bldg ${randInt(rand, 100, 2999)}, Way ${randInt(rand, 1000, 9999)}, ${area.name}, ${area.city}`;
}

function basePaymentType(rand: Rand, type: CustomerTypeName | null): PaymentTypeName {
  const r = rand();
  if (r < 0.03) return 'PREPAID';
  if ((type === 'GROCERY' || type === null) && r < 0.4) return 'CASH';
  if (type === 'HORECA' && r < 0.2) return 'CASH';
  return 'CREDIT';
}

function newCustomer(
  rand: Rand,
  code: string,
  branchCode: string | null,
  name: string,
  type: CustomerTypeName | null,
  area: NmwcArea,
  isChainBranch: boolean,
): NmwcCustomerSeed {
  const prof = type ? PROFILE_BY_TYPE.get(type)! : null;
  const pos = jitter(rand, area);
  return {
    code,
    branchCode,
    branchKey: branchCode ?? '__MAIN__',
    name,
    customerType: type,
    area: area.name,
    regionCode: area.regionCode,
    address: addressFor(rand, area),
    lat: pos.lat,
    lng: pos.lng,
    geocodeConfidence: 'MEDIUM',
    priority: prof?.defaultPriority ?? 3,
    priorityConfirmed: true,
    avgServiceTimeMin: prof?.serviceTimeMin ?? 10,
    serviceTimeConfirmed: false,
    hardWindowStartMin: null,
    hardWindowEndMin: null,
    prefWindowStartMin: null,
    prefWindowEndMin: null,
    paymentType: basePaymentType(rand, type),
    accessNotes: null,
    locationSource: 'IMPORT',
    locationVerified: false,
    isChainBranch,
  };
}

let baseCache: NmwcCustomerSeed[] | null = null;

function buildBaseCustomers(): NmwcCustomerSeed[] {
  if (baseCache) return baseCache;
  const rand = mulberry32(hashSeed('nmwc-customers-v1'));

  type Entity = { type: CustomerTypeName | null; chain?: ChainDef; name?: string };
  const entities: Entity[] = CHAINS.map((c) => ({ type: c.type, chain: c }));
  for (const [type, n] of SINGLES) {
    const names = namesFor(rand, type ?? 'NONE', n);
    for (let i = 0; i < n; i++) entities.push({ type, name: names[i] });
  }

  // Shuffle so customer codes are not grouped by type (like a real ERP customer list).
  const out: NmwcCustomerSeed[] = [];
  shuffle(rand, entities).forEach((e, i) => {
    const code = `C${1001 + i}`;
    if (e.chain) {
      e.chain.areas.forEach((areaName, b) => {
        const area = AREA_BY_NAME.get(areaName)!;
        out.push(newCustomer(rand, code, `B${String(b + 1).padStart(2, '0')}`, `${e.chain!.brand} - ${areaName}`, e.type, area, true));
      });
    } else {
      const area = weightedPick(rand, NMWC_AREAS, (a) => a.weight);
      const name = e.type === 'HYPERMARKET' || e.type === 'OTHER' ? `${e.name} - ${area.name}` : e.name!;
      out.push(newCustomer(rand, code, null, name, e.type, area, false));
    }
  });

  const singles = (types: (CustomerTypeName | null)[]) => out.filter((c) => !c.isChainBranch && types.includes(c.customerType));
  const take = <T>(items: T[], n: number) => shuffle(rand, items).slice(0, n);

  // 8 branches WITHOUT coordinates -> "LOCATION REQUIRED" (7 singles + one chain branch).
  const noLoc = [
    ...take(singles(['GROCERY', 'HORECA', 'TRADING', 'CATERING']), NMWC_MISSING_LOCATION_COUNT - 1),
    out.find((c) => c.name.startsWith('Sahil Fresh') && c.branchCode === 'B03')!,
  ];
  for (const c of noLoc) {
    c.lat = null;
    c.lng = null;
    c.geocodeConfidence = null;
    c.locationSource = null;
  }

  // 10 with an unconfirmed priority: the 2 untyped + 8 others (the planner falls back to the type).
  const unconfirmed = [...singles([null]), ...take(singles(['GROCERY', 'HORECA', 'TRADING', 'SUPERMARKET', 'CATERING']), NMWC_UNCONFIRMED_PRIORITY_COUNT - 2)];
  for (const c of unconfirmed) {
    c.priorityConfirmed = false;
    c.priority = 3;
  }

  // Confirmed customer-specific priorities that differ from the type default (key accounts etc.).
  for (const c of take(out.filter((x) => x.priorityConfirmed && x.customerType && x.customerType !== 'HYPERMARKET'), 12)) {
    c.priority = Math.max(1, Math.min(5, c.priority + (rand() < 0.6 ? -1 : 1)));
  }

  // A handful of dispatcher-verified locations: all hypermarket chain branches + 4 others.
  const verified = [
    ...out.filter((c) => c.isChainBranch && c.customerType === 'HYPERMARKET'),
    ...take(out.filter((c) => c.lat !== null && !c.isChainBranch), 4),
  ];
  for (const c of verified) {
    c.locationVerified = true;
    c.geocodeConfidence = 'HIGH';
  }

  // Own receiving windows (override the type profile) for a few customers.
  const ownWindows: [CustomerTypeName, number, number, number | null, number | null][] = [
    ['HYPERMARKET', hm(6), hm(10), hm(6), hm(8)],
    ['SUPERMARKET', hm(6), hm(9), null, null],
    ['HORECA', hm(7), hm(10, 30), null, null],
    ['CATERING', hm(6, 30), hm(8, 30), null, null],
    ['GROCERY', hm(14), hm(21), hm(15), hm(18)], // shop only receives in the afternoon
    ['GROCERY', hm(14), hm(21), null, null],
    ['WHOLESALE', hm(8), hm(12), null, null],
  ];
  const usedWin = new Set<NmwcCustomerSeed>();
  for (const [type, hs, he, ps, pe] of ownWindows) {
    const c = shuffle(rand, singles([type]).filter((x) => x.lat !== null && !usedWin.has(x)))[0];
    if (!c) continue;
    usedWin.add(c);
    Object.assign(c, { hardWindowStartMin: hs, hardWindowEndMin: he, prefWindowStartMin: ps, prefWindowEndMin: pe });
  }

  // Confirmed own service times for ~15 customers.
  for (const c of take(out.filter((x) => x.customerType), 15)) {
    c.serviceTimeConfirmed = true;
    c.avgServiceTimeMin = Math.max(5, c.avgServiceTimeMin + randInt(rand, -5, 15));
  }

  for (const c of take(out, 16)) c.accessNotes = pick(rand, ACCESS_NOTES);

  baseCache = out;
  return out;
}

const EXT_TYPES: [CustomerTypeName, number][] = [
  ['GROCERY', 60],
  ['HORECA', 15],
  ['SUPERMARKET', 10],
  ['TRADING', 10],
  ['CATERING', 5],
];

/** Benchmark-only branch #i (i >= 180): its own PRNG stream, so every extension is prefix-stable. */
function extendedCustomer(i: number): NmwcCustomerSeed {
  const rand = mulberry32(hashSeed(`nmwc-ext-${i}`));
  const [type] = weightedPick(rand, EXT_TYPES, (t) => t[1]);
  const area = weightedPick(rand, NMWC_AREAS, (a) => a.weight);
  const pool = NAME_POOLS[type];
  const n = i - NMWC_BASE_BRANCHES + 1;
  const name = `${pick(rand, pool.words)} ${pick(rand, pool.suffixes)} - ${area.name} ${n}`;
  return newCustomer(rand, `C${2000 + n}`, null, name, type, area, false);
}

/**
 * Customer branches for the demo master. `count` 180 (default) = the demo master; larger
 * counts append benchmark-only branches C2001.. (all with coordinates). The first 180 are
 * identical whatever `count` is. Returns fresh copies (safe to mutate).
 */
export function buildCustomers(count: number = NMWC_BASE_BRANCHES): NmwcCustomerSeed[] {
  const base = buildBaseCustomers().slice(0, count).map((c) => ({ ...c }));
  for (let i = NMWC_BASE_BRANCHES; i < count; i++) base.push(extendedCustomer(i));
  return base;
}

/** Priority planning will use: own value when confirmed, else the type default (P1 highest). */
export function effectivePriority(c: NmwcCustomerSeed): number {
  if (c.priorityConfirmed) return c.priority;
  return (c.customerType && PROFILE_BY_TYPE.get(c.customerType)?.defaultPriority) || c.priority;
}

// --------------------------------------------------------------------------------------
// Daily sales-order files (NMWC ERP export shape)
// --------------------------------------------------------------------------------------

/** Exact headers of the NMWC ERP sales-order export. CM = contribution margin. */
export const ORDER_HEADERS = [
  'SO No',
  'SO Date',
  'Req. Delivery Date',
  'Customer Code',
  'Branch',
  'Customer Name',
  'Item Code',
  'Item Description',
  'Qty (Cases)',
  'Net Value',
  'CM',
] as const;

export type OrderRow = Record<string, string>;

/** 2026-09-25 -> 25/09/2026 (the ERP's DD/MM/YYYY). */
export function toDmy(iso: string): string {
  const [y, m, d] = iso.split('-');
  return `${d}/${m}/${y}`;
}

function addDays(iso: string, days: number): string {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

function defaultSoPrefix(dateIso: string): string {
  return `SO${dateIso.slice(2, 4)}${dateIso.slice(5, 7)}${dateIso.slice(8, 10)}-`;
}

// Total cases per customer per day, and SKUs per order, by type.
const CASES_BY_TYPE: Record<string, [number, number]> = {
  HYPERMARKET: [80, 250],
  SUPERMARKET: [40, 120],
  TRADING: [30, 100],
  CATERING: [20, 70],
  HORECA: [10, 40],
  GROCERY: [5, 40],
  WHOLESALE: [100, 280],
  OTHER: [5, 25],
  NONE: [5, 30],
};

const SKUS_BY_TYPE: Record<string, [number, number]> = {
  HYPERMARKET: [3, 4],
  SUPERMARKET: [2, 4],
  TRADING: [1, 3],
  CATERING: [1, 3],
  HORECA: [1, 3],
  GROCERY: [1, 3],
  WHOLESALE: [2, 4],
  OTHER: [1, 2],
  NONE: [1, 3],
};

// Relative likelihood of each SKU on an order, by customer type.
const SKU_MIX: Record<string, Record<string, number>> = {
  RETAIL: { 'TAN-330-24': 2, 'TAN-500-24': 3, 'TAN-1500-6': 3, 'TAN-5L-4': 2, 'TAN-19L': 1, 'JAB-500-24': 2, 'JAB-1500-6': 2, 'TIS-FAC-30': 1.5, 'TIS-ROLL-10': 1.5 },
  FOODSERVICE: { 'TAN-330-24': 3, 'TAN-500-24': 3, 'TAN-1500-6': 1, 'TAN-19L': 3, 'TIS-FAC-30': 1, 'TIS-ROLL-10': 1 },
  GROCERY: { 'TAN-330-24': 1, 'TAN-500-24': 3, 'TAN-1500-6': 3, 'TAN-5L-4': 1, 'TAN-19L': 1, 'JAB-500-24': 2, 'JAB-1500-6': 2, 'TIS-FAC-30': 1, 'TIS-ROLL-10': 1 },
  BULK: { 'TAN-500-24': 3, 'TAN-1500-6': 3, 'TAN-5L-4': 2, 'TAN-19L': 1, 'JAB-500-24': 2, 'JAB-1500-6': 2, 'TIS-ROLL-10': 1 },
};

function skuMixFor(type: string): Record<string, number> {
  if (type === 'HYPERMARKET' || type === 'SUPERMARKET') return SKU_MIX.RETAIL;
  if (type === 'HORECA' || type === 'CATERING' || type === 'OTHER') return SKU_MIX.FOODSERVICE;
  if (type === 'TRADING' || type === 'WHOLESALE') return SKU_MIX.BULK;
  return SKU_MIX.GROCERY;
}

const DISCOUNT_BY_TYPE: Record<string, number> = { HYPERMARKET: 0.08, SUPERMARKET: 0.05, WHOLESALE: 0.1, TRADING: 0.07 };

// How likely a customer of each type orders on a given day (hypermarkets almost daily).
const ORDER_LIKELIHOOD: Record<string, number> = {
  HYPERMARKET: 3,
  SUPERMARKET: 2.5,
  WHOLESALE: 2,
  TRADING: 1.5,
  CATERING: 1.5,
  HORECA: 1.2,
  GROCERY: 1,
  OTHER: 0.7,
  NONE: 1,
};

const PRODUCT_BY_CODE = new Map(NMWC_PRODUCTS.map((p) => [p.code, p]));

// Not in any master name pool, so an unknown code never looks like an existing customer.
const UNKNOWN_CUSTOMER_NAMES = ['Al Sidra Foodstuff', 'Green Leaf Cafe', 'Pearl Coast Mini Mart', 'Silver Sands Trading', 'Al Taif Baqala', 'Harbour View Restaurant', 'Al Kawthar Grocery', 'Sunset Catering Services'];

export interface OrderFileOptions {
  /** Requested delivery date, YYYY-MM-DD (written as DD/MM/YYYY). */
  date: string;
  /** Distinct delivery points (customer branches) in the file, unknown customers INCLUDED. */
  stops: number;
  /** Default: derived from date + stops, so each day differs but a day is reproducible. */
  seed?: number;
  /** Customer codes C9001.. that are not in the master (become "LOCATION REQUIRED" stubs). */
  includeUnknownCustomers?: number;
  /** Add one row with an item code not in the product master (UNKNOWN_PRODUCT). */
  includeUnknownProduct?: boolean;
  /** SO number prefix; default SO<yymmdd>- of the delivery date. */
  salesOrderPrefix?: string;
  /** Fill the CM (contribution margin) column. Default true; false leaves it blank. */
  withMargin?: boolean;
  /** Master to draw customers from. Default: buildCustomers(180), or the benchmark master when stops > 180. */
  customers?: NmwcCustomerSeed[];
}

interface DraftLine {
  productCode: string;
  productName: string;
  cases: number;
  secondSo: boolean;
}

/** Split `total` cases into `n` positive integer parts. */
function splitCases(rand: Rand, total: number, n: number): number[] {
  const k = Math.max(1, Math.min(n, total));
  const w = Array.from({ length: k }, () => 0.3 + rand());
  const sum = w.reduce((a, x) => a + x, 0);
  const parts = w.map((x) => Math.max(1, Math.floor((x / sum) * total)));
  let diff = total - parts.reduce((a, x) => a + x, 0);
  for (let i = 0; diff !== 0; i = (i + 1) % k) {
    if (diff > 0) {
      parts[i]++;
      diff--;
    } else if (parts[i] > 1) {
      parts[i]--;
      diff++;
    }
  }
  return parts;
}

function pickSkus(rand: Rand, type: string, n: number): string[] {
  const mix = Object.entries(skuMixFor(type));
  // Weighted sampling without replacement (Efraimidis-Spirakis keys).
  const keyed = mix.map(([code, w]) => ({ code, key: Math.pow(rand(), 1 / w) }));
  keyed.sort((a, b) => b.key - a.key);
  return keyed.slice(0, Math.min(n, keyed.length)).map((k) => k.code);
}

function draftLines(rand: Rand, type: string): DraftLine[] {
  const [lo, hi] = CASES_BY_TYPE[type];
  const [sLo, sHi] = SKUS_BY_TYPE[type];
  const total = randInt(rand, lo, hi);
  const skus = pickSkus(rand, type, randInt(rand, sLo, sHi));
  const parts = splitCases(rand, total, skus.length);
  // ~10% of multi-SKU customers send part of the order on a second sales order.
  const split = parts.length >= 2 && rand() < 0.1 ? randInt(rand, 1, parts.length - 1) : parts.length;
  return parts.map((cases, i) => {
    const p = PRODUCT_BY_CODE.get(skus[i])!;
    return { productCode: p.code, productName: p.name, cases, secondSo: i >= split };
  });
}

function money(rand: Rand, type: string, productCode: string, cases: number, withMargin: boolean): { net: string; cm: string } {
  const p = PRODUCT_BY_CODE.get(productCode);
  const price = p?.listPriceOmr ?? 2.5;
  const net = round(cases * price * (1 - (DISCOUNT_BY_TYPE[type] ?? 0)), 3);
  const pct = (p?.marginPct ?? 0.15) + (rand() - 0.5) * 0.04;
  return { net: net.toFixed(3), cm: withMargin ? round(net * pct, 3).toFixed(3) : '' };
}

/**
 * One day's sales-order export, NMWC ERP style (headers = ORDER_HEADERS). Several SKU rows per
 * customer, sometimes two sales orders for the same customer. Rows are sorted by SO number,
 * so a customer's second SO appears further down the file (like the real export).
 */
export function generateOrderRows(opts: OrderFileOptions): OrderRow[] {
  const unknownCount = Math.min(Math.max(0, opts.stops), Math.max(0, opts.includeUnknownCustomers ?? 0));
  const knownStops = Math.max(0, opts.stops - unknownCount);
  const master =
    opts.customers ?? buildCustomers(knownStops > NMWC_BASE_BRANCHES ? Math.max(NMWC_BENCHMARK_BRANCHES, knownStops) : NMWC_BASE_BRANCHES);
  if (knownStops > master.length) {
    throw new Error(`Asked for ${knownStops} known stops but the customer master has only ${master.length} branches.`);
  }
  const rand = mulberry32(opts.seed ?? hashSeed(`${opts.date}|${opts.stops}|${unknownCount}`));
  const withMargin = opts.withMargin ?? true;
  const prefix = opts.salesOrderPrefix ?? defaultSoPrefix(opts.date);
  const delivery = toDmy(opts.date);

  // Weighted sample of branches without replacement; order of selection = SO numbering order.
  const chosen = master
    .map((c) => ({ c, key: Math.pow(rand(), 1 / ORDER_LIKELIHOOD[c.customerType ?? 'NONE']) }))
    .sort((a, b) => b.key - a.key)
    .slice(0, knownStops)
    .map((x) => x.c);

  type Stop = { code: string; branch: string; name: string; type: string; lines: DraftLine[]; soDate: string };
  const stops: Stop[] = chosen.map((c) => {
    const type = c.customerType ?? 'NONE';
    return { code: c.code, branch: c.branchCode ?? '', name: c.name, type, lines: draftLines(rand, type), soDate: addDays(opts.date, rand() < 0.15 ? -2 : -1) };
  });
  for (let k = 0; k < unknownCount; k++) {
    const name = UNKNOWN_CUSTOMER_NAMES[k % UNKNOWN_CUSTOMER_NAMES.length];
    stops.push({ code: `C${9001 + k}`, branch: '', name, type: 'GROCERY', lines: draftLines(rand, 'GROCERY'), soDate: addDays(opts.date, -1) });
  }
  // Interleave the unknown customers into the list rather than always last; older SO dates
  // get the lower SO numbers (stable sort keeps the sampled order within a date).
  const ordered = (unknownCount ? shuffle(rand, stops) : stops).sort((a, b) => (a.soDate < b.soDate ? -1 : a.soDate > b.soDate ? 1 : 0));

  if (opts.includeUnknownProduct && ordered.length) {
    const host = ordered.find((s) => s.type === 'HYPERMARKET' || s.type === 'SUPERMARKET') ?? ordered[0];
    host.lines.push({ productCode: UNKNOWN_PRODUCT.code, productName: UNKNOWN_PRODUCT.name, cases: randInt(rand, 10, 24), secondSo: false });
  }

  const rows: { so: string; row: OrderRow }[] = [];
  let seq = 0;
  const soNo = () => `${prefix}${String(++seq).padStart(4, '0')}`;
  const emit = (s: Stop, so: string, lines: DraftLine[]) => {
    for (const l of lines) {
      const m = money(rand, s.type, l.productCode, l.cases, withMargin);
      rows.push({
        so,
        row: {
          'SO No': so,
          'SO Date': toDmy(s.soDate),
          'Req. Delivery Date': delivery,
          'Customer Code': s.code,
          Branch: s.branch,
          'Customer Name': s.name,
          'Item Code': l.productCode,
          'Item Description': l.productName,
          'Qty (Cases)': String(l.cases),
          'Net Value': m.net,
          CM: m.cm,
        },
      });
    }
  };
  for (const s of ordered) emit(s, soNo(), s.lines.filter((l) => !l.secondSo));
  // Second sales orders were raised later, so they get later numbers.
  for (const s of ordered) {
    const second = s.lines.filter((l) => l.secondSo);
    if (second.length) emit(s, soNo(), second);
  }
  rows.sort((a, b) => (a.so < b.so ? -1 : a.so > b.so ? 1 : 0));
  return rows.map((r) => r.row);
}

export interface LateOrderOptions {
  branch?: string | null;
  seed?: number;
  salesOrderNo?: string;
  withMargin?: boolean;
  /** Total cases (default 40-90). */
  cases?: number;
  customers?: NmwcCustomerSeed[];
}

/**
 * A single late P1 order (e.g. a hypermarket phoning at 22:15 for tomorrow): 1-2 SKU rows with
 * the ERP headers plus a "Priority" column set to P1 (the intake maps it to priority 1).
 */
export function generateLateOrderRows(date: string, customerCode: string, opts: LateOrderOptions = {}): OrderRow[] {
  const rand = mulberry32(opts.seed ?? hashSeed(`late|${date}|${customerCode}|${opts.branch ?? ''}`));
  const master = opts.customers ?? buildCustomers();
  const branch = opts.branch ?? null;
  const cust = master.find((c) => c.code === customerCode && (c.branchCode ?? null) === branch);
  const type = cust?.customerType ?? 'HYPERMARKET';
  const total = opts.cases ?? randInt(rand, 40, 90);
  const skus = pickSkus(rand, type, total >= 2 ? randInt(rand, 1, 2) : 1);
  const parts = splitCases(rand, total, skus.length);
  const so = opts.salesOrderNo ?? `${defaultSoPrefix(date)}L001`;
  return parts.map((cases, i) => {
    const p = PRODUCT_BY_CODE.get(skus[i])!;
    const m = money(rand, type, p.code, cases, opts.withMargin ?? true);
    return {
      'SO No': so,
      'SO Date': toDmy(addDays(date, -1)),
      'Req. Delivery Date': toDmy(date),
      'Customer Code': customerCode,
      Branch: branch ?? '',
      'Customer Name': cust?.name ?? `Customer ${customerCode}`,
      'Item Code': p.code,
      'Item Description': p.name,
      'Qty (Cases)': String(cases),
      'Net Value': m.net,
      CM: m.cm,
      Priority: 'P1',
    };
  });
}

/**
 * The customer for a late P1 order: a P1 branch with coordinates that is NOT already in `rows`
 * (so the late order adds a new stop to a locked plan), hypermarkets first. Falls back to a
 * P1 branch that is already in the file.
 */
export function pickLateP1Customer(rows: OrderRow[], customers: NmwcCustomerSeed[] = buildCustomers()): NmwcCustomerSeed {
  const inFile = new Set(rows.map((r) => `${r['Customer Code']}::${r.Branch ?? ''}`));
  const p1 = customers.filter((c) => c.lat !== null && effectivePriority(c) === 1);
  const fresh = p1.filter((c) => !inFile.has(`${c.code}::${c.branchCode ?? ''}`));
  const hyper = (list: NmwcCustomerSeed[]) => list.find((c) => c.customerType === 'HYPERMARKET');
  const c = hyper(fresh) ?? fresh[0] ?? hyper(p1) ?? p1[0];
  if (!c) throw new Error('No P1 customer with coordinates in the master.');
  return c;
}

/** JSON body for POST /api/dispatch/late-order built from generateLateOrderRows output. */
export function toLateOrderPayload(rows: OrderRow[], opts: { depotId: string; reason: string }) {
  const first = rows[0];
  const num = (s: string | undefined) => (s ? Number(s) : 0);
  const withMargin = rows.some((r) => r.CM);
  return {
    date: first['Req. Delivery Date'].split('/').reverse().join('-'),
    depotId: opts.depotId,
    customerCode: first['Customer Code'],
    branchCode: first.Branch || undefined,
    customerName: first['Customer Name'],
    priority: 1,
    reason: opts.reason,
    salesValue: round(rows.reduce((a, r) => a + num(r['Net Value']), 0), 3),
    margin: withMargin ? round(rows.reduce((a, r) => a + num(r.CM), 0), 3) : undefined,
    lines: rows.map((r) => ({
      productCode: r['Item Code'],
      productDescription: r['Item Description'],
      cases: Number(r['Qty (Cases)']),
      salesOrderNo: r['SO No'],
    })),
  };
}

export interface OrderFileSummary {
  rows: number;
  stops: number; // distinct customer code + branch
  salesOrders: number;
  cases: number;
  casesBySku: Record<string, number>;
  casesBySalesOrder: Record<string, number>;
  customerCodes: string[];
}

/** Expected totals for reconciliation tests (uploaded = planned + unserved). */
export function summarizeOrderRows(rows: OrderRow[]): OrderFileSummary {
  const casesBySku: Record<string, number> = {};
  const casesBySalesOrder: Record<string, number> = {};
  const stops = new Set<string>();
  let cases = 0;
  for (const r of rows) {
    const q = Number(r['Qty (Cases)']);
    cases += q;
    casesBySku[r['Item Code']] = (casesBySku[r['Item Code']] ?? 0) + q;
    casesBySalesOrder[r['SO No']] = (casesBySalesOrder[r['SO No']] ?? 0) + q;
    stops.add(`${r['Customer Code']}::${r.Branch ?? ''}`);
  }
  return {
    rows: rows.length,
    stops: stops.size,
    salesOrders: Object.keys(casesBySalesOrder).length,
    cases,
    casesBySku,
    casesBySalesOrder,
    customerCodes: [...new Set(rows.map((r) => r['Customer Code']))].sort(),
  };
}

// --------------------------------------------------------------------------------------
// File encoders (pure: return strings / buffers, the caller decides where they go)
// --------------------------------------------------------------------------------------

function csvCell(v: string): string {
  return /[",\r\n]/.test(v) || /^\s|\s$/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

/** RFC 4180 CSV with the given (or first row's) header order, LF line endings. */
export function rowsToCsv(rows: OrderRow[], headers: readonly string[] = rows.length ? Object.keys(rows[0]) : ORDER_HEADERS): string {
  const lines = [headers.map(csvCell).join(',')];
  for (const r of rows) lines.push(headers.map((h) => csvCell(r[h] ?? '')).join(','));
  return `${lines.join('\n')}\n`;
}

const NUMERIC_COLUMNS = new Set(['Qty (Cases)', 'Net Value', 'CM']);

/**
 * .xlsx bytes like the ERP export: quantities / values as real numbers, dates as DD/MM/YYYY
 * text, one sheet. `createdAt` pins the workbook metadata so output is reproducible.
 */
export function rowsToXlsxBuffer(rows: OrderRow[], opts: { sheetName?: string; createdAt?: Date } = {}): Buffer {
  const headers = rows.length ? Object.keys(rows[0]) : [...ORDER_HEADERS];
  const aoa: (string | number)[][] = [headers];
  for (const r of rows) {
    aoa.push(headers.map((h) => (NUMERIC_COLUMNS.has(h) && r[h] !== '' && r[h] !== undefined ? Number(r[h]) : r[h] ?? '')));
  }
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  ws['!cols'] = headers.map((h) => ({ wch: Math.max(10, h.length + 2, ...rows.slice(0, 200).map((r) => (r[h] ?? '').length + 1)) }));
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, opts.sheetName ?? 'Sales Orders');
  const when = opts.createdAt ?? new Date('2026-01-01T00:00:00Z');
  wb.Props = { Title: 'Sales orders', Author: 'NMWC ERP (demo)', CreatedDate: when, ModifiedDate: when };
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx', compression: true }) as Buffer;
}

// --------------------------------------------------------------------------------------
// Presets shared by the seed (--orders) and the fixtures CLI
// --------------------------------------------------------------------------------------

export const ORDER_FILE_PRESETS = {
  /** orders-20.csv: small, clean file for fast tests. */
  small: { stops: 20, includeUnknownCustomers: 0, includeUnknownProduct: false, withMargin: true },
  /** orders-150.xlsx and seed --orders: the realistic demo day. */
  demo: { stops: 150, includeUnknownCustomers: 3, includeUnknownProduct: true, withMargin: true },
  /** orders-large.csv: benchmark; needs the 480-branch master (seed --customers=480). */
  large: { stops: 400, includeUnknownCustomers: 0, includeUnknownProduct: false, withMargin: true },
} as const;
