/**
 * Shared types between apps/web and (eventually) the Phase 7+ driver client.
 * Phase 0: solver request/response stubs. Phase 3 will fill in the optimizer
 * payload contract per CLAUDE.md section 7.
 */

export type DistanceProvider = 'HAVERSINE' | 'MAPBOX_MATRIX';

export type OptimizationScenarioName = 'MIN_TRUCKS' | 'MIN_DISTANCE' | 'BALANCED';

export type UnservedReasonCode =
  | 'MISSING_COORDINATES'
  | 'EXCEEDS_TRUCK_CAPACITY'
  | 'NO_AVAILABLE_TRUCK'
  | 'SHIFT_TIME_LIMIT'
  | 'INVALID_CUSTOMER'
  | 'SOLVER_DROPPED_LOW_PRIORITY'
  | 'INFEASIBLE_ROUTE'
  | 'UNKNOWN';

export interface SolverDepot {
  id: string;
  lat: number;
  lng: number;
}

export interface SolverTruck {
  id: string;
  capacity_cases: number;
  capacity_weight_kg: number;
  fixed_cost_per_day: number;
  cost_per_km: number;
}

export interface SolverStop {
  order_id: string;
  customer_id: string;
  lat: number;
  lng: number;
  demand_cases: number;
  demand_weight_kg: number;
  service_time_min: number;
  priority: number; // 1 (highest) .. 5 (lowest)
}

export interface SolverConfig {
  avg_speed_kmh: number;
  distance_provider: DistanceProvider;
  distance_multiplier: number;
  driver_shift_max_min: number;
  return_to_depot: boolean;
  solver_time_limit_sec: number;
  scenarios_requested: OptimizationScenarioName[];
  // When the RunPlan's optimizationMode is MAX_UTILIZATION, set this flag so
  // the solver re-weights the BALANCED scenario toward fuller trucks.
  // (CLAUDE.md §7 — does NOT add a 4th scenario.)
  max_utilization_mode?: boolean;
}

export interface OptimizeRequest {
  run_id: string;
  tenant_id: string;
  depot: SolverDepot;
  trucks: SolverTruck[];
  stops: SolverStop[];
  config: SolverConfig;
}

export interface SolverUnservedOrder {
  order_id: string;
  reason_code: UnservedReasonCode;
  reason_message?: string;
}

export interface SolverRouteStop {
  sequence: number;
  order_id: string;
  customer_id: string;
  planned_arrival_min: number;
  planned_distance_from_prev_km: number;
  planned_load_cases: number;
}

export interface SolverRoute {
  truck_id: string;
  stops: SolverRouteStop[];
  total_distance_km: number;
  total_time_min: number;
  load_cases: number;
  utilization_pct: number;
}

export interface SolverScenario {
  name: OptimizationScenarioName;
  trucks_used: number;
  total_distance_km: number;
  total_time_min: number;
  total_cost: number;
  avg_utilization_pct: number;
  distance_provider: DistanceProvider;
  distance_is_estimated: boolean;
  unserved_orders: SolverUnservedOrder[];
  routes: SolverRoute[];
}

export interface OptimizeResponse {
  run_id: string;
  scenarios: SolverScenario[];
  warnings: string[];
}
