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
  /** The driver break planned with this load (PlanLoad.breakJson); absent = none recorded. */
  break_start_min?: number | null;
  break_min?: number | null;
  /** The pallet need the load was planned with (1/1000 pallet), for the record only. */
  pallet_units?: number | null;
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
  /**
   * Pallet positions (owner decision 4 Oct 2026), 1-40. Set: the truck is planned by pallets - room =
   * bays x config.pallet_fill_pct and the payload; capacity_cases is then not a limit. Absent / null:
   * planned by cases. Solvers without the field plan every truck by cases (and echo no pallet_unit).
   */
  bays?: number | null;
  /**
   * A truck the company could RENT for the day (owner request 6 Oct 2026, the hire suggestion's
   * what-if; never a truck already hired): fixed_cost is its hire, fuel included. The optimizer ranks it
   * in a hire tier between the P1-P3 and the P4/P5 stops, in proportion to its real money (hire +
   * driver_day_cost): own trucks go first, the cheapest set of rented trucks wins, P4/P5 stops alone
   * never rent one; the plan reports the real costs.
   */
  hire_candidate?: boolean;
  /**
   * A driver paid by the DAY (owner answer 6 Oct 2026: a rented truck's casual driver, the company's
   * daily driver day rate): this many OMR per truck day, fixed, instead of driver_cost_per_hour and
   * overtime. Absent / null: paid by the hour. Solvers without the field pay every driver by the hour.
   */
  driver_day_cost?: number | null;
}

export interface DispatchStop {
  stop_id: string;
  order_ids: string[];
  customer_id: string;
  lat: number;
  lng: number;
  demand_cases: number;
  demand_kg?: number;
  /**
   * The stop's pallet need in 1/1000 pallet: the sum over its order lines of ceil(cases x 1000 /
   * cases per pallet) (lib/dispatch/pallets.ts). Required on every stop when a truck has bays (the
   * solver answers 422 otherwise); absent on a day without bay trucks.
   */
  demand_pallet_units?: number | null;
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

/** Receiving-hours rule: 'FINISH' = unloading finished by closing; 'START' = the earlier rule. */
export type WindowRule = 'START' | 'FINISH';

export interface DispatchConfig {
  shift_start_min?: number;
  shift_max_min?: number;
  overtime_after_min?: number | null;
  overtime_cost_per_hour?: number;
  reload_min?: number;
  /** loading time per case of the NEXT load, on top of reload_min (0..1; default 0) */
  loading_min_per_case?: number;
  /**
   * A plan made on its own delivery day (stabilization PR8 review): when it was made (minutes after
   * midnight, company timezone). Loading cannot start before it, so every new load - on a truck
   * standing at the depot as on one coming back - leaves no earlier than it + reload_min +
   * loading_min_per_case x its cases. Absent / null: a plan for a later day (first loads are loaded
   * before the shift starts). Solvers without the field ignore it.
   */
  loading_from_min?: number | null;
  /**
   * Receiving hours (owner rule 29 Sep 2026). 'FINISH': unloading is finished by closing (service
   * start + service_min <= hard_end_min; a preferred end means "finished by" too). 'START' / absent:
   * the earlier rule, unloading only has to start by closing. hard_end_min stays the TRUE closing
   * time; only the solver subtracts the stop time. Solvers without the field plan the earlier way
   * and send no `window_rule` echo.
   */
  window_rule?: WindowRule;
  /**
   * The latest return (owner: "18:00 is the latest return"): every truck is back at the depot by
   * this minute of the day, whenever it leaves (the tenant's first departure + shift maximum, also
   * on a plan made on its delivery day). Absent: only the shift maximum from the first departure.
   * Echoed as `latest_return_min` on each scenario.
   */
  latest_return_min?: number;
  /**
   * Driver break (owner rule 29-30 Sep 2026): one break of break_min per truck-day, STARTING
   * between break_start_from_min and break_start_to_min; none for a truck-day back for good by the
   * latest start or leaving for the first time at the earliest start or later. 0 / absent = none.
   * Solvers without the fields plan no break and send no `break_rule` echo.
   */
  break_min?: number;
  break_start_from_min?: number;
  break_start_to_min?: number;
  max_trips_per_truck?: number;
  /** Pallet fill (owner decision 4 Oct 2026): percent of a bay truck's bays the planner may fill, 50-100 (default 100 = every bay). */
  pallet_fill_pct?: number;
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
  /**
   * How long to search (owner decision 29 Sep 2026, "night plans long, day re-plans quick"). QUICK
   * (default): the automatic time by day size, as before. THOROUGH: the whole request takes up to
   * max_search_sec (at most the solver's THOROUGH_MAX_SEC, 20 min) and the search stops early once
   * it stops improving. Solvers without the fields search QUICK.
   */
  search_mode?: SearchMode;
  max_search_sec?: number | null;
}

export type SearchMode = 'QUICK' | 'THOROUGH';

/**
 * How the recommended plan was searched (apps/solver dispatch_models.SearchReport). Never a claim
 * of optimality: no bound is computed, so no gap is known. stop_reason: TIME_LIMIT = QUICK (the
 * automatic time); CONVERGED = THOROUGH stopped once it stopped improving; CAP = THOROUGH reached
 * its time limit while still improving; STOPPED = a supervisor used the best plan found so far.
 * Either mode: NOT_SEARCHED = no search ran (every stop was left out before it); NO_PLAN = the search
 * ended without any plan.
 */
export interface SearchReport {
  mode: SearchMode;
  cap_sec: number;
  limit_sec: number;
  search_sec: number;
  used_sec: number;
  stop_reason: 'TIME_LIMIT' | 'CONVERGED' | 'CAP' | 'STOPPED' | 'NOT_SEARCHED' | 'NO_PLAN';
  last_improvement_sec?: number | null;
  stall_sec?: number | null;
  /**
   * At most 12 [seconds into the search, search score, stops not planned yet] points of the best plan
   * so far. The score is not money: the plan's cost and preferences plus a large penalty (1,000 OMR
   * or more on real days) for each stop not planned yet. Reports from before the count have two values.
   */
  best_over_time?: [number, number, number?][];
  solutions?: number | null;
  /** The second route search (PyVRP); absent from a solver before it. */
  pyvrp?: PyvrpReport | null;
}

/**
 * What the second route search (PyVRP) did in a solve (apps/solver dispatch_models.PyvrpReport). Its
 * plan is one more candidate of the load re-check, judged by the planner's own checks, timing and
 * costs. status: CHOSEN = its plan is used by the options in chosen_for; NOT_CHOSEN = the engine's own
 * plans were as good or better (or its plan was unusable: reason); SKIPPED = not run; FAILED = it
 * failed. The plans are then the engine's alone. best_over_time: [seconds, score] - a score, not money.
 */
export interface PyvrpReport {
  status: 'CHOSEN' | 'NOT_CHOSEN' | 'SKIPPED' | 'FAILED';
  reason?: string | null;
  version?: string | null;
  seed?: number | null;
  penalty_mode?: string | null;
  search_sec?: number | null;
  iterations?: number | null;
  stop_reason?: string | null;
  last_improvement_sec?: number | null;
  feasible?: boolean | null;
  routes?: number | null;
  loads?: number | null;
  missing?: number | null;
  chosen_for?: string[];
  best_over_time?: [number, number][];
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
  /** The stop's pallet need (1/1000 pallet); absent / null when the request sent none. */
  pallet_units?: number | null;
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
  /** The driver break planned with this load; absent / null = none on this load. */
  driver_break?: PlannedBreak | null;
  /**
   * Pallets, on a truck with bays only (null on a truck planned by cases, absent from an older
   * solver): the load's pallet need (the sum of its stops', 1/1000 pallet) and the truck's room
   * (bays x fill % x 10). utilization_pct is then max(pallets / bays, kg / payload).
   */
  pallet_units?: number | null;
  pallet_room_units?: number | null;
}

/**
 * A driver break. DEPOT: at the depot before the load leaves (it may overlap the reload and
 * loading). ROAD: after unloading stop `after_sequence` (0 = on the way to stop 1; = the number of
 * stops: on the way back), before the next unloading.
 */
export interface PlannedBreak {
  start_min: number;
  end_min: number;
  where: 'DEPOT' | 'ROAD';
  after_sequence?: number | null;
}

export type BreakStatus = 'PLANNED' | 'NOT_NEEDED' | 'IN_FROZEN_LOAD' | 'NOT_POSSIBLE';

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
  /** The truck-day's driver break; absent / null = no break rule (older solver, or none set). */
  break_status?: BreakStatus | null;
  break_start_min?: number | null;
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
  | 'CAPACITY_PALLETS'
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
  | 'FROZEN_OVERLAP'
  | 'BREAK';

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
  /**
   * Physical trucks of the day: the new loads' trucks + the trucks of locked / loading / dispatched
   * loads (PR7, B3). A solver before PR7 counted only the new loads' trucks.
   */
  trucks_used: number;
  /** The NEW loads this plan adds (frozen_loads are on top). */
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
  /** Of trucks_used, the trucks with frozen loads, and the frozen loads the plan was made around (PR7); absent from an older solver. */
  frozen_trucks?: number | null;
  frozen_loads?: number | null;
  /**
   * The weight and overtime rules the plan was made with (audit A6 review); absent from a solver
   * before them (its route search rounded each stop up to a whole kg and charged overtime already
   * worked by locked or dispatched loads again). 0.1: every kg check in 0.1 kg units, no margin.
   */
  weight_unit_kg?: number | null;
  /** true: only new overtime counts when the optimizer chooses a truck (audit E4). */
  new_overtime_only?: boolean | null;
  /**
   * The receiving-hours rule the plan was made with (config.window_rule, echoed). Absent / null:
   * a solver before it, so unloading only had to START by closing. The web takes the rule a load
   * was planned with ONLY from this echo, never from what it asked for.
   */
  window_rule?: WindowRule | null;
  /**
   * The driver-break rule the plan was made with (echoed). Absent / null: no break was planned (a
   * solver before the rule, or no break set). The web takes it ONLY from this echo.
   */
  break_rule?: { length_min: number; start_from_min: number; start_to_min: number } | null;
  /** The latest return the plan was made with (echoed); absent / null: none. The web takes it ONLY from this echo. */
  latest_return_min?: number | null;
  /**
   * The pallet rule the plan was made with (echoed when a truck of the request has bays): bay trucks
   * were checked by pallets in units of pallet_unit (0.001) at pallet_fill_pct. Absent / null: no bay
   * truck in the request, or a solver before the rule - the web then marks no load as planned by
   * pallets. total_pallet_units: the sum over the bay trucks' loads.
   */
  pallet_unit?: number | null;
  pallet_fill_pct?: number | null;
  total_pallet_units?: number | null;
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
  /** How the recommended plan was searched; absent from an older solver. */
  search?: SearchReport | null;
  /**
   * The hire suggestion's what-if only (a request with trucks to rent): how its rented trucks were
   * reduced after the search (apps/solver dispatch_solver._reduce_hire). Absent / null on every other
   * answer and from a solver before it.
   */
  hire_check?: HireCheck | null;
}

/**
 * The reduction of a what-if's rented trucks (sixth review of the hire branch: the Quick search rented
 * 2 x 10-ton where one carried every P1-P3 order left out). `first`: the rented trucks of the search's
 * plan; `used`: those of the RECOMMENDED plan returned - the cheapest set found (seventh review: the
 * trucks carrying only P4/P5 orders given back without a solve - their orders put back on the trucks
 * kept, or an own truck left idle (twelfth review: own trucks first), where they fit, in place of P5
 * orders where need be (tenth review: strict priorities; eleventh review: in free room too; twelfth
 * review: orders that fit nowhere never use up the tries of one that fits), one left out told that a
 * truck is not rented for P4/P5 orders alone (twelfth review), a plan kept as the search found it
 * given back from its own times (eleventh review) -, then every set
 * with less real money - as many trucks as it takes (eighth review) - tried cheapest first, another
 * option's units too; the first whose plan delivers every P1-P3 stop and passes every check, its load
 * re-check included, and rents no truck for P4/P5 orders alone once given back; the set left after a
 * give-back solved once more when the limits allow and it was not solved already, its plan taken only
 * when it passes every check, keeps every P1-P3 stop and is cheaper, or as cheap and serving more by the
 * day's priorities, or as cheap while the give-back fails the checks (eleventh review) - so the P4/P5
 * orders of the trucks given back may ride along in the trucks kept;
 * otherwise they stay out; the solve of one truck fewer taken when it keeps every P1-P3 stop and passes
 * every check, tenth review; every plan judged, the search's own included, first repaired with no
 * solve - a P1-P3 stop it leaves out put back in place of lower priorities where it fits, or by a chain
 * of two moves (in place of one other stop of a load, which goes on elsewhere), and a solve
 * still leaving one out while a lower priority rides on its trucks solved once more or never
 * counted: thirteenth review); `solves`: the extra solves;
 * `complete`: every set cheaper than `used` was ruled out (by a solve only when, once repaired, it
 * still lost a P1-P3 stop with no lower priority riding along), `used` rents no truck for P4/P5 orders
 * alone, and its give-back had a timing for every order it tried to put back (eleventh review);
 * `one_fewer`: the least useful truck of `used` left out, SOLVED with exactly the others - the
 * stops that plan leaves out (all priorities), as repaired.
 */
export interface HireCheck {
  first: string[];
  used: string[];
  solves: number;
  complete: boolean;
  one_fewer?: { without: string; unserved: string[] } | null;
}
