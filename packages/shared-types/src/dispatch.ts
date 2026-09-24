/**
 * Wire contract for the NMWC dispatch planner: web -> solver `POST /optimize-dispatch`.
 * Mirrors apps/solver/dispatch_models.py field-for-field. Times are MINUTES FROM LOCAL
 * MIDNIGHT of the delivery day (06:30 -> 390); money is OMR; distances in responses are km.
 */

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
  max_trips_per_truck?: number;
  fuel_price_per_litre?: number;
  driver_cost_per_hour?: number;
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
}

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
}

export interface DispatchResponse {
  run_id: string;
  engine: string;
  matrix_provider: string;
  distance_is_estimated: boolean;
  scenarios: DispatchScenario[];
  warnings: string[];
}
