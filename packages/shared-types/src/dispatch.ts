/**
 * Wire contract for the NMWC dispatch planner: web -> solver `POST /optimize-dispatch`.
 * Mirrors apps/solver/dispatch_models.py field-for-field. Times are MINUTES FROM LOCAL
 * MIDNIGHT of the delivery day (06:30 -> 390); money is OMR; distances in responses are km.
 *
 * The bounds the web accepts for the planner settings it sends are in ./planner-bounds.json
 * (checked against the Pydantic models by apps/solver/tests and apps/web/tests).
 */

// Types only: the web imports this package with `import type` (it is not transpiled at runtime).
// The most stops one optimization supports (600, DispatchRequest.stops max_length) is in
// ./planner-bounds.json with the setting bounds.

export type DispatchScenarioName = 'RECOMMENDED' | 'MIN_TRUCKS' | 'MIN_DISTANCE';

export type DispatchUnservedReason =
  | 'MISSING_COORDINATES'
  | 'INVALID_LOCATION'
  | 'UNKNOWN_CUSTOMER'
  | 'UNKNOWN_PRODUCT'
  | 'EXCEEDS_ANY_TRUCK_CAPACITY'
  | 'NO_AVAILABLE_TRUCK'
  | 'HARD_WINDOW_INFEASIBLE'
  | 'SHIFT_LIMIT'
  | 'TRIP_LIMIT'
  | 'LOCKED_PLAN_CONFLICT'
  | 'LATE_ORDER_NO_CAPACITY'
  | 'SOLVER_DROPPED_LOW_PRIORITY'
  | 'ROUTING_PROVIDER_FAILURE'
  | 'INFEASIBLE'
  | 'UNKNOWN';

export interface DispatchDepot {
  id: string;
  lat: number;
  lng: number;
  open_min?: number;
  close_min?: number;
}

export interface FrozenTrip {
  load_no: number;
  depart_min: number;
  return_min: number;
  cases?: number;
}

export interface DispatchTruck {
  id: string;
  code?: string;
  capacity_cases: number;
  capacity_kg?: number;
  fixed_cost?: number;
  trip_cost?: number;
  cost_per_km?: number;
  km_per_litre?: number | null;
  available_from_min?: number | null;
  available_to_min?: number | null;
  max_trips?: number | null;
  frozen_trips?: FrozenTrip[];
}

export interface DispatchStop {
  stop_id: string;
  order_ids: string[];
  customer_id: string;
  lat: number;
  lng: number;
  demand_cases: number;
  demand_kg?: number;
  service_min?: number;
  priority?: number; // 1 = HIGHEST .. 5 = LOWEST
  hard_start_min?: number | null;
  hard_end_min?: number | null;
  pref_start_min?: number | null;
  pref_end_min?: number | null;
  margin?: number | null;
  revenue?: number | null;
  late?: boolean;
  /** re-plans: truck of this stop in the previous plan version (plan continuity) */
  previous_truck_id?: string | null;
}

export interface DispatchConfig {
  shift_start_min?: number;
  shift_max_min?: number;
  overtime_after_min?: number | null;
  overtime_cost_per_hour?: number;
  reload_min?: number;
  /** loading time per case of the NEXT load, on top of reload_min (0..1; default 0) */
  loading_min_per_case?: number;
  max_trips_per_truck?: number;
  fuel_price_per_litre?: number;
  /**
   * OMR per hour of the WHOLE truck day: first departure (or first frozen departure) to last
   * return, depot turnaround and waiting included (policy TRUCK_DAY_SPAN, apps/solver/costing.py).
   * Overtime (overtime_cost_per_hour after overtime_after_min from that first departure) is on top.
   */
  driver_cost_per_hour?: number;
  /** true (default): a higher priority always wins over any number of lower-priority stops */
  strict_priorities?: boolean;
  /** relative stop values when strict_priorities is false; must be strictly decreasing */
  priority_weights?: Record<number, number>;
  pref_window_penalty_per_min?: number;
  early_preference_per_min?: Record<number, number>;
  use_margin?: boolean;
  change_penalty_per_stop?: number;
  distance_provider?: 'OSRM' | 'HAVERSINE';
  osrm_url?: string | null;
  haversine_multiplier?: number;
  avg_speed_kmh?: number;
  road_time_factor?: number;
  time_limit_sec?: number | null;
  scenarios?: DispatchScenarioName[];
}

export interface DispatchRequest {
  run_id: string;
  tenant_id: string;
  depot: DispatchDepot;
  trucks: DispatchTruck[];
  stops: DispatchStop[];
  config: DispatchConfig;
}

export interface PlannedStop {
  sequence: number;
  stop_id: string;
  order_ids: string[];
  customer_id: string;
  arrival_min: number;
  service_start_min: number;
  departure_min: number;
  wait_min: number;
  leg_km: number;
  cum_km: number;
  leg_min: number;
  cases: number;
  kg: number;
  hard_window_ok: boolean;
  pref_window_ok: boolean;
  /** The leg into this stop is an estimate (straight line x multiplier), not a road distance. */
  leg_estimated?: boolean;
}

/**
 * One load. Costs (cost_version 2, policy TRUCK_DAY_SPAN): total_cost = fixed_cost + trip_cost +
 * distance_cost + fuel_cost + driver_cost + overtime_cost; driver and overtime are this load's share
 * of the whole truck day (the paid interval from the truck's previous return to this load's return).
 * Without cost_version (older solver): fixed_cost included the trip cost and total_cost excluded
 * turnarounds and overtime.
 */
export interface PlannedLoad {
  truck_id: string;
  load_no: number;
  depart_min: number;
  return_min: number;
  distance_km: number;
  duration_min: number;
  cases: number;
  kg: number;
  utilization_pct: number;
  fuel_litres: number | null;
  fuel_cost: number;
  distance_cost: number;
  time_cost: number;
  fixed_cost: number;
  total_cost: number;
  return_leg_km: number;
  stops: PlannedStop[];
  trip_cost?: number | null;
  /** = time_cost */
  driver_cost?: number | null;
  overtime_cost?: number | null;
  /** Minutes of paid truck day this load owns, and where that interval starts. */
  driver_paid_min?: number | null;
  paid_from_min?: number | null;
  overtime_min?: number | null;
  /** Legs of this load (return included) whose distance is an estimate. */
  estimated_legs?: number | null;
}

export interface UnservedStop {
  stop_id: string;
  order_ids: string[];
  reason_code: DispatchUnservedReason;
  reason_message: string;
}

export interface ObjectiveComponents {
  unserved_penalty: number;
  fixed_cost: number;
  distance_cost: number;
  fuel_cost: number;
  time_cost: number;
  overtime_cost: number;
  window_penalty: number;
  margin_served: number | null;
  trip_cost?: number | null;
}

/** The new loads' part of one truck day (apps/solver/costing.py): each figure = the sum of its loads. */
export interface TruckDayCost {
  truck_id: string;
  loads: number;
  frozen_loads: number;
  day_start_min: number;
  paid_from_min: number;
  last_return_min: number;
  paid_min: number;
  overtime_min: number;
  fixed_cost: number;
  trip_cost: number;
  distance_cost: number;
  fuel_cost: number;
  driver_cost: number;
  overtime_cost: number;
  total_cost: number;
}

/** Soft preferences in OMR-equivalent (not money). */
export interface PreferencePenalties {
  window: number;
  early: number;
  continuity: number;
}

export type FeasibilityCode =
  | 'UNKNOWN_TRUCK'
  | 'UNKNOWN_STOP'
  | 'LOAD_NUMBER'
  | 'LOAD_TOTALS'
  | 'CAPACITY_CASES'
  | 'CAPACITY_KG'
  | 'HARD_WINDOW'
  | 'TRAVEL'
  | 'SERVICE_TIME'
  | 'RETURN'
  | 'TURNAROUND'
  | 'EARLY_DEPARTURE'
  | 'DEPOT_CLOSE'
  | 'TRUCK_AVAILABILITY'
  | 'SHIFT_LIMIT'
  | 'TRIPS'
  | 'FROZEN_OVERLAP';

export interface FeasibilityViolation {
  code: FeasibilityCode;
  truck_id?: string | null;
  load_no?: number | null;
  stop_id?: string | null;
  message: string;
  short_by_min?: number | null;
}

/** The solver's independent re-check of a scenario's timetable (apps/solver/feasibility.py). */
export interface FeasibilityReport {
  status: 'VERIFIED' | 'VIOLATED' | 'UNVERIFIED';
  timing: 'EXACT' | 'ESTIMATED';
  violations: FeasibilityViolation[];
  checked_at_version?: number;
  travel_checked?: boolean;
  note?: string | null;
}

export interface DispatchScenario {
  name: DispatchScenarioName;
  status: 'OPTIMIZED' | 'NO_SOLUTION' | 'NOTHING_TO_PLAN';
  solver_status: string;
  solver_time_sec: number;
  time_limit_sec: number;
  objective_value: number;
  objective: ObjectiveComponents;
  trucks_used: number;
  trips: number;
  total_distance_km: number;
  total_duration_min: number;
  total_cases: number;
  total_kg: number;
  avg_utilization_pct: number;
  fuel_litres: number;
  fuel_cost: number;
  operating_cost: number;
  loads: PlannedLoad[];
  unserved: UnservedStop[];
  warnings: string[];
  /** Optional: a solver older than the stabilization release sends none (treated as not checked). */
  feasibility?: FeasibilityReport | null;
  /** Cost model (review F17); absent from a solver before it. */
  cost_policy?: 'TRUCK_DAY_SPAN' | string | null;
  cost_version?: number | null;
  truck_days?: TruckDayCost[];
  paid_driver_min?: number | null;
  preference_penalties?: PreferencePenalties | null;
  estimated_legs?: number | null;
}

export interface DispatchResponse {
  run_id: string;
  engine: string;
  matrix_provider: string;
  /** True only when every leg is an estimate (distance_quality ESTIMATED). */
  distance_is_estimated: boolean;
  /** ROAD / MIXED (some legs estimated) / ESTIMATED; absent from an older solver. */
  distance_quality?: 'ROAD' | 'MIXED' | 'ESTIMATED' | null;
  scenarios: DispatchScenario[];
  warnings: string[];
}
