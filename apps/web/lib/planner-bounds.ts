/**
 * Bounds of the planner settings the web accepts (Settings, Trucks, Depots), each inside the
 * optimizer's own contract (apps/solver/dispatch_models.py), so a saved value can never make an
 * optimization fail with 422 (review F21). The contract copy is
 * packages/shared-types/src/planner-bounds.json: tests/lib/tenant-settings.spec.ts checks this file
 * against it, and apps/solver/tests checks the JSON against the Pydantic models.
 *
 * Pure: shared by the server (schemas, request building) and the browser (form hints).
 */

export interface Bound {
  /** The optimizer field the setting feeds (null: web only, e.g. the planning cutoff). */
  solver: string | null;
  min: number;
  max: number;
  int?: boolean;
}

export const MAX_DISPATCH_STOPS = 600;
/** Above this many stops the optimizer uses its longest automatic search (a warning says so). */
export const LARGE_DAY_STOPS = 350;

export const CONFIG_BOUNDS = {
  shiftStartMin: { solver: 'shift_start_min', min: 0, max: 1439, int: true },
  driverShiftMaxMinutes: { solver: 'shift_max_min', min: 60, max: 1440, int: true },
  overtimeAfterMin: { solver: 'overtime_after_min', min: 0, max: 1440, int: true },
  overtimeCostPerHour: { solver: 'overtime_cost_per_hour', min: 0, max: 100 },
  reloadMinutes: { solver: 'reload_min', min: 0, max: 240, int: true },
  loadingMinPerCase: { solver: 'loading_min_per_case', min: 0, max: 1 },
  maxTripsPerTruck: { solver: 'max_trips_per_truck', min: 1, max: 10, int: true },
  fuelPricePerLitre: { solver: 'fuel_price_per_litre', min: 0, max: 10 },
  driverCostPerHour: { solver: 'driver_cost_per_hour', min: 0, max: 100 },
  prefWindowPenaltyPerMin: { solver: 'pref_window_penalty_per_min', min: 0, max: 100 },
  distanceMultiplier: { solver: 'haversine_multiplier', min: 1, max: 3 },
  avgSpeedKmh: { solver: 'avg_speed_kmh', min: 5, max: 120 },
  roadTimeFactor: { solver: 'road_time_factor', min: 1, max: 3 },
  defaultServiceTimeMin: { solver: 'stop.service_min', min: 0, max: 480, int: true },
  serviceMinPerCase: { solver: 'stop.service_min', min: 0, max: 1 },
  planningCutoffMin: { solver: null, min: 0, max: 1439, int: true },
} as const satisfies Record<string, Bound>;

export const TRUCK_BOUNDS = {
  capacityCases: { solver: 'capacity_cases', min: 0, max: 100_000, int: true },
  capacityWeightKg: { solver: 'capacity_kg', min: 0, max: 100_000 },
  fixedCostPerDay: { solver: 'fixed_cost', min: 0, max: 100_000 },
  tripCost: { solver: 'trip_cost', min: 0, max: 10_000 },
  costPerKm: { solver: 'cost_per_km', min: 0, max: 1_000 },
  kmPerLitre: { solver: 'km_per_litre', min: 0.1, max: 100 },
  maxTripsPerDay: { solver: 'max_trips', min: 1, max: 10, int: true },
  availableFromMin: { solver: 'available_from_min', min: 0, max: 1440, int: true },
  availableToMin: { solver: 'available_to_min', min: 0, max: 1440, int: true },
} as const satisfies Record<string, Bound>;

export const DEPOT_BOUNDS = {
  openMin: { solver: 'open_min', min: 0, max: 1440, int: true },
  closeMin: { solver: 'close_min', min: 0, max: 1440, int: true },
} as const satisfies Record<string, Bound>;

export type ConfigBoundKey = keyof typeof CONFIG_BOUNDS;

/** "between 0 and 100" / "a whole number between 1 and 10". */
export function boundText(b: Bound): string {
  return `${b.int ? 'a whole number ' : ''}between ${b.min} and ${b.max}`;
}

/** Whether a value lies inside its bound (null / undefined = not set, always fine). */
export function inBound(b: Bound, v: number | null | undefined): boolean {
  if (v === null || v === undefined) return true;
  return Number.isFinite(v) && v >= b.min && v <= b.max && (!b.int || Number.isInteger(v));
}

/**
 * Stored values outside the bounds (settings written straight into the database): one line each,
 * naming the setting, its value and what is accepted. Empty when every value is fine.
 */
export function outOfBounds<K extends string>(bounds: Record<K, Bound>, values: Partial<Record<K, number | null | undefined>>, label: (k: K) => string = (k) => k): string[] {
  const out: string[] = [];
  for (const k of Object.keys(bounds) as K[]) {
    const v = values[k];
    if (!inBound(bounds[k], v)) out.push(`${label(k)} is ${v}; it must be ${boundText(bounds[k])}`);
  }
  return out;
}
