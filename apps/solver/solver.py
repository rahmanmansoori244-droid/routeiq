"""PyVRP-based VRP solver — produces three scenarios per RouteIQ spec §7.

Migrated from OR-Tools (v1) to PyVRP (Hybrid Genetic Search) for state-of-the-
art solution quality. PyVRP routinely beats OR-Tools by 2–4% on capacitated
VRP benchmarks (CVRPLIB) and is the highest-scoring open-source solver on
"best-known solutions found" leaderboards.

Public API preserved:
  - ``optimize(req: OptimizeRequest) -> OptimizeResponse``
  - ``haversine_km``, ``effective_time_limit``, ``drop_penalty``
  - ``filter_input``, ``SCENARIO_PRESETS``, ``adjusted_weights``

Internal model
  - PyVRP uses integer distance, duration, cost, and prize values.
  - Distance: meters (km × 1000).
  - Duration: seconds.
  - Cost unit: 1 cost-unit = 0.00001 OMR ("millicent OMR"). So a truck doing
    ``cost_per_km = 0.18`` OMR/km translates to ``unit_distance_cost = 18`` per
    meter. A ``fixed_cost_per_day = 25`` OMR becomes ``2_500_000``.
  - Prize for client served = ``drop_penalty(priority) × PRIZE_SCALE`` so
    priority 1 (highest) costs the solver the most to drop, exactly inverted
    by spec §7. With PRIZE_SCALE = 10 a priority-1 drop is roughly 10× a
    daily truck cost — the solver will use an extra truck before dropping.

Drop disjunctions: priority 1 customers cost 50,000,000 cost-units to drop;
priority 5 cost 10,000,000. The solver always prefers to drop priority 5
first when infeasible.
"""
from __future__ import annotations

import math
import logging
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from typing import Iterable

from pyvrp import Model, PenaltyParams, SolveParams
from pyvrp.stop import MaxRuntime

from models import (
    OptimizeRequest,
    OptimizeResponse,
    Route,
    RouteStop,
    Scenario,
    ScenarioName,
    Stop,
    Truck,
    UnservedOrder,
)


log = logging.getLogger("routeiq.solver")


# ---------------------------------------------------------------------------
# Pre-solver validation & matrix construction
# ---------------------------------------------------------------------------

EARTH_RADIUS_KM = 6371.0088

# Scaling: 1 cost unit = 0.00001 OMR (so 1 OMR = 100_000 units).
COST_SCALE = 100_000
# Prize multiplier on top of drop_penalty(priority). The ratio between
# prize(P=1) and prize(P=5) is fixed at 5:1 by the linear drop_penalty formula
# (spec §7); the absolute magnitude is what we tune here. With PRIZE_SCALE=30,
# prize(P=1) = 150M and prize(P=5) = 30M — about 50× a daily truck cost — so
# the solver always uses an extra truck before dropping a high-priority stop,
# but still cleanly drops low-priority stops when the fleet is over capacity.
PRIZE_SCALE = 100

# PyVRP's default capacity-violation penalty caps at 100_000 (PenaltyParams.max_penalty).
# With our prize scale that's not enough — solver could prefer overloading a truck to
# dropping a priority-1 client. We raise the cap so capacity violation is always more
# expensive than dropping; the solver then cleanly drops low-priority stops when it
# can't fit them in the fleet.
_PYVRP_PARAMS = SolveParams(
    penalty=PenaltyParams(
        max_penalty=10_000_000_000.0,
    ),
)


def haversine_km(lat1: float, lng1: float, lat2: float, lng2: float) -> float:
    rlat1, rlat2 = math.radians(lat1), math.radians(lat2)
    dlat = math.radians(lat2 - lat1)
    dlng = math.radians(lng2 - lng1)
    a = math.sin(dlat / 2) ** 2 + math.cos(rlat1) * math.cos(rlat2) * math.sin(dlng / 2) ** 2
    return 2 * EARTH_RADIUS_KM * math.asin(math.sqrt(a))


def effective_time_limit(base: int, stop_count: int) -> int:
    """Module A bump: floor 60s (was 30), max 300s (was 120).

    Larger budget lets PyVRP's HGS run more generations of local search. The UI
    is async/polling-based, so the longer wall-clock doesn't hurt UX.
    """
    return min(max(base, int(stop_count * 0.05)), 300)


def drop_penalty(priority: int) -> int:
    """Higher priority → harder to drop. priority 1 → 5_000_000, priority 5 → 1_000_000.

    Unchanged from v1 — formula remains ``1_000_000 × (6 − priority)``. The
    PyVRP layer multiplies by ``PRIZE_SCALE`` before feeding it as the prize.
    """
    return 1_000_000 * (6 - max(1, min(5, priority)))


@dataclass
class StopFilter:
    """Result of pre-solver validation: solvable stops + structured drop reasons."""

    solvable: list[Stop]
    drops: list[UnservedOrder]
    warnings: list[str]


def filter_input(req: OptimizeRequest) -> StopFilter:
    drops: list[UnservedOrder] = []
    solvable: list[Stop] = []
    warnings: list[str] = []
    if not req.trucks:
        for s in req.stops:
            drops.append(
                UnservedOrder(
                    order_id=s.order_id,
                    reason_code="NO_AVAILABLE_TRUCK",
                    reason_message="No trucks configured for this depot.",
                )
            )
        return StopFilter(solvable=[], drops=drops, warnings=["No trucks configured"])

    max_truck_cases = max(t.capacity_cases for t in req.trucks)
    for s in req.stops:
        if s.lat is None or s.lng is None or (s.lat == 0 and s.lng == 0):
            drops.append(
                UnservedOrder(
                    order_id=s.order_id,
                    reason_code="MISSING_COORDINATES",
                    reason_message="Customer has no latitude/longitude.",
                )
            )
            continue
        if s.demand_cases > max_truck_cases:
            drops.append(
                UnservedOrder(
                    order_id=s.order_id,
                    reason_code="EXCEEDS_TRUCK_CAPACITY",
                    reason_message=f"Demand {s.demand_cases} > largest truck capacity {max_truck_cases}.",
                )
            )
            continue
        solvable.append(s)
    return StopFilter(solvable=solvable, drops=drops, warnings=warnings)


# ---------------------------------------------------------------------------
# Scenario weight presets
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class ScenarioWeights:
    """Per-scenario tuning. Multipliers applied to each truck's fixed_cost and per_km."""

    fixed_cost_multiplier: float
    per_km_multiplier: float
    description: str


SCENARIO_PRESETS: dict[ScenarioName, ScenarioWeights] = {
    "MIN_TRUCKS": ScenarioWeights(
        fixed_cost_multiplier=10.0,
        per_km_multiplier=0.5,
        description="Heavy per-vehicle penalty; consolidate aggressively.",
    ),
    "MIN_DISTANCE": ScenarioWeights(
        fixed_cost_multiplier=0.0,
        per_km_multiplier=2.0,
        description="Only per-km cost; may use more trucks for shorter routes.",
    ),
    "BALANCED": ScenarioWeights(
        fixed_cost_multiplier=1.0,
        per_km_multiplier=1.0,
        description="Default — weighted sum of fixed-cost and distance.",
    ),
}


def adjusted_weights(name: ScenarioName, req: OptimizeRequest) -> ScenarioWeights:
    preset = SCENARIO_PRESETS[name]
    if name != "BALANCED":
        return preset
    if req.config.max_utilization_mode:
        return ScenarioWeights(
            fixed_cost_multiplier=preset.fixed_cost_multiplier * 0.2,
            per_km_multiplier=preset.per_km_multiplier,
            description=preset.description + " (max-utilization weighting)",
        )
    return preset


# ---------------------------------------------------------------------------
# Matrix builders (kept compatible with v1 helpers — distance in cm, time in s)
# ---------------------------------------------------------------------------


def _build_distance_matrix(req: OptimizeRequest, solvable: list[Stop]) -> list[list[int]]:
    """Distance matrix in centimeters (int). Depot at index 0, then stops 1..N."""
    nodes = [(req.depot.lat, req.depot.lng)] + [(s.lat, s.lng) for s in solvable]
    mult = req.config.distance_multiplier
    size = len(nodes)
    mat = [[0] * size for _ in range(size)]
    for i in range(size):
        for j in range(size):
            if i == j:
                continue
            km = haversine_km(nodes[i][0], nodes[i][1], nodes[j][0], nodes[j][1]) * mult
            mat[i][j] = int(round(km * 100_000))  # km → cm
    return mat


def _build_time_matrix(
    distance_cm: list[list[int]],
    solvable: list[Stop],
    avg_speed_kmh: float,
) -> list[list[int]]:
    """Travel-time matrix in SECONDS (excluding service time — that's per-client)."""
    speed = max(avg_speed_kmh, 1.0)
    size = len(distance_cm)
    out = [[0] * size for _ in range(size)]
    for i in range(size):
        for j in range(size):
            if i == j:
                continue
            travel_secs = int(round((distance_cm[i][j] / 100_000) / speed * 3600))
            out[i][j] = travel_secs
    return out


# ---------------------------------------------------------------------------
# Core solve (PyVRP)
# ---------------------------------------------------------------------------


def _empty_scenario(name: ScenarioName, req: OptimizeRequest) -> Scenario:
    return Scenario(
        name=name,
        trucks_used=0,
        total_distance_km=0.0,
        total_time_min=0,
        total_cost=0.0,
        avg_utilization_pct=0.0,
        distance_provider=req.config.distance_provider,
        distance_is_estimated=req.config.distance_provider == "HAVERSINE",
        unserved_orders=[],
        routes=[],
    )


def _solve_one_scenario(
    name: ScenarioName,
    req: OptimizeRequest,
    solvable: list[Stop],
    distance_cm: list[list[int]],
    time_secs: list[list[int]],
    time_limit_sec: int,
) -> tuple[Scenario, list[UnservedOrder]]:
    """Solve a single scenario with PyVRP. Returns (scenario, solver_drops)."""
    n_stops = len(solvable)
    if n_stops == 0:
        return _empty_scenario(name, req), []

    weights = adjusted_weights(name, req)
    model = Model()

    # Locations: depot at index 0, then one per stop.
    # We use lat/lng × 1e6 as integer x/y purely for labelling — distances are
    # provided explicitly via edges below, so coordinate scale doesn't affect cost.
    depot_loc = model.add_depot(
        x=int(req.depot.lat * 1_000_000),
        y=int(req.depot.lng * 1_000_000),
        name=req.depot.id,
    )

    clients: list = []
    for s in solvable:
        c = model.add_client(
            x=int(s.lat * 1_000_000),
            y=int(s.lng * 1_000_000),
            delivery=s.demand_cases,
            service_duration=s.service_time_min * 60,
            prize=drop_penalty(s.priority) * PRIZE_SCALE,
            required=False,  # optional → solver may drop if cost > prize
            name=s.order_id,
        )
        clients.append(c)

    # One vehicle TYPE per truck (heterogeneous fleet). Each truck has its
    # own fixed-cost and per-km cost; combining into types would lose precision.
    shift_max_secs = req.config.driver_shift_max_min * 60
    for truck in req.trucks:
        fixed = int(round(truck.fixed_cost_per_day * weights.fixed_cost_multiplier * COST_SCALE))
        # cost_per_km OMR/km → cost per meter in COST_SCALE units.
        unit_dist_cost = int(round(truck.cost_per_km * weights.per_km_multiplier * (COST_SCALE / 1000)))
        model.add_vehicle_type(
            num_available=1,
            capacity=truck.capacity_cases,
            start_depot=depot_loc,
            end_depot=depot_loc,
            fixed_cost=fixed,
            unit_distance_cost=max(0, unit_dist_cost),
            shift_duration=shift_max_secs,
            name=truck.id,
        )

    # Edges — n × (n-1) directional edges. Distance in meters (cm/100), duration
    # in seconds. PyVRP requires explicit edges for every pair we want to allow.
    all_locs = [depot_loc] + clients
    n_nodes = len(all_locs)
    for i in range(n_nodes):
        for j in range(n_nodes):
            if i == j:
                continue
            dist_m = max(0, distance_cm[i][j] // 100)
            dur_s = max(0, time_secs[i][j])
            model.add_edge(all_locs[i], all_locs[j], distance=dist_m, duration=dur_s)

    try:
        result = model.solve(
            stop=MaxRuntime(max(1, time_limit_sec)),
            seed=42,
            display=False,
            params=_PYVRP_PARAMS,
        )
    except Exception as exc:  # noqa: BLE001 — surface as INFEASIBLE_ROUTE
        log.exception("PyVRP raised during solve for scenario %s: %s", name, exc)
        return (
            Scenario(
                **{
                    **_empty_scenario(name, req).model_dump(),
                    "unserved_orders": [
                        UnservedOrder(
                            order_id=s.order_id,
                            reason_code="INFEASIBLE_ROUTE",
                            reason_message=f"Solver error: {exc}",
                        )
                        for s in solvable
                    ],
                }
            ),
            [],
        )

    best = result.best
    if best is None or not best.is_feasible():
        return (
            Scenario(
                **{
                    **_empty_scenario(name, req).model_dump(),
                    "unserved_orders": [
                        UnservedOrder(
                            order_id=s.order_id,
                            reason_code="INFEASIBLE_ROUTE",
                            reason_message="Solver could not find any feasible route.",
                        )
                        for s in solvable
                    ],
                }
            ),
            [],
        )

    # --- Extract routes ---------------------------------------------------------
    served_client_indices: set[int] = set()
    routes_out: list[Route] = []
    total_distance_km = 0.0
    total_time_min = 0
    total_cost_omr = 0.0
    trucks_used = 0
    util_pct_sum = 0.0
    util_pct_count = 0

    for route in best.routes():
        vtype_idx = route.vehicle_type()
        truck = req.trucks[vtype_idx]
        visits = list(route.visits())  # PyVRP returns 1-indexed (depot=0, clients=1..N)
        if not visits:
            continue
        trucks_used += 1

        # Re-walk the route in cm/seconds for accurate kilometer & arrival math.
        # PyVRP returns route.distance() in METERS and route.duration() in seconds,
        # but we want km with cents-of-precision matching the v1 wire contract.
        prev_node = 0  # depot
        seq = 0
        route_load = 0
        route_distance_cm = 0
        arrival_secs = 0
        stops_out: list[RouteStop] = []
        for matrix_node in visits:
            client_idx = matrix_node - 1  # back to 0-indexed `solvable`
            served_client_indices.add(client_idx)
            leg_distance_cm = distance_cm[prev_node][matrix_node]
            leg_time_secs = time_secs[prev_node][matrix_node]
            arrival_secs += leg_time_secs
            stop = solvable[client_idx]
            seq += 1
            stops_out.append(
                RouteStop(
                    sequence=seq,
                    order_id=stop.order_id,
                    customer_id=stop.customer_id,
                    planned_arrival_min=int(round(arrival_secs / 60)),
                    planned_distance_from_prev_km=round(leg_distance_cm / 100_000, 3),
                    planned_load_cases=route_load + stop.demand_cases,
                )
            )
            route_load += stop.demand_cases
            route_distance_cm += leg_distance_cm
            arrival_secs += stop.service_time_min * 60  # service at stop
            prev_node = matrix_node

        # Return to depot
        return_distance_cm = distance_cm[prev_node][0]
        return_time_secs = time_secs[prev_node][0]
        route_distance_cm += return_distance_cm
        arrival_secs += return_time_secs

        route_distance_km = route_distance_cm / 100_000
        route_time_min = int(round(arrival_secs / 60))
        route_cost_omr = truck.fixed_cost_per_day + truck.cost_per_km * route_distance_km
        util_pct = round(100.0 * route_load / max(truck.capacity_cases, 1), 1)
        routes_out.append(
            Route(
                truck_id=truck.id,
                stops=stops_out,
                total_distance_km=round(route_distance_km, 2),
                total_time_min=route_time_min,
                load_cases=route_load,
                utilization_pct=util_pct,
            )
        )
        total_distance_km += route_distance_km
        total_time_min += route_time_min
        total_cost_omr += route_cost_omr
        util_pct_sum += util_pct
        util_pct_count += 1

    # Stops not in any route are the solver's drops.
    dropped_by_solver: list[UnservedOrder] = []
    for c_idx, stop in enumerate(solvable):
        if c_idx in served_client_indices:
            continue
        dropped_by_solver.append(
            UnservedOrder(
                order_id=stop.order_id,
                reason_code="SOLVER_DROPPED_LOW_PRIORITY",
                reason_message=(
                    f"Solver dropped this stop to keep the rest feasible "
                    f"(priority {stop.priority})."
                ),
            )
        )

    return (
        Scenario(
            name=name,
            trucks_used=trucks_used,
            total_distance_km=round(total_distance_km, 2),
            total_time_min=total_time_min,
            total_cost=round(total_cost_omr, 2),
            avg_utilization_pct=round(util_pct_sum / util_pct_count, 1) if util_pct_count > 0 else 0.0,
            distance_provider=req.config.distance_provider,
            distance_is_estimated=req.config.distance_provider == "HAVERSINE",
            unserved_orders=dropped_by_solver,
            routes=routes_out,
        ),
        dropped_by_solver,
    )


def _merge_unserved(
    pre_drops: Iterable[UnservedOrder],
    solver_drops: Iterable[UnservedOrder],
) -> list[UnservedOrder]:
    out: list[UnservedOrder] = list(pre_drops)
    seen = {u.order_id for u in out}
    for u in solver_drops:
        if u.order_id not in seen:
            out.append(u)
            seen.add(u.order_id)
    return out


def optimize(req: OptimizeRequest) -> OptimizeResponse:
    """Entry point for the FastAPI route."""
    pre = filter_input(req)
    n_solvable = len(pre.solvable)

    time_limit = effective_time_limit(req.config.solver_time_limit_sec, n_solvable)
    log.info(
        "run=%s stops=%d trucks=%d pre_drops=%d time_limit=%ds (PyVRP)",
        req.run_id, n_solvable, len(req.trucks), len(pre.drops), time_limit,
    )

    if n_solvable == 0:
        return OptimizeResponse(
            run_id=req.run_id,
            scenarios=[
                Scenario(
                    name=name,
                    trucks_used=0,
                    total_distance_km=0.0,
                    total_time_min=0,
                    total_cost=0.0,
                    avg_utilization_pct=0.0,
                    distance_provider=req.config.distance_provider,
                    distance_is_estimated=req.config.distance_provider == "HAVERSINE",
                    unserved_orders=pre.drops,
                    routes=[],
                )
                for name in req.config.scenarios_requested
            ],
            warnings=pre.warnings + ["No solvable stops — all were pre-dropped."],
        )

    distance_cm = _build_distance_matrix(req, pre.solvable)
    time_secs = _build_time_matrix(distance_cm, pre.solvable, req.config.avg_speed_kmh)

    def _runner(name: ScenarioName) -> Scenario:
        scenario, _ = _solve_one_scenario(
            name=name,
            req=req,
            solvable=pre.solvable,
            distance_cm=distance_cm,
            time_secs=time_secs,
            time_limit_sec=time_limit,
        )
        scenario.unserved_orders = _merge_unserved(pre.drops, scenario.unserved_orders)
        return scenario

    n_threads = min(len(req.config.scenarios_requested), 3)
    with ThreadPoolExecutor(max_workers=n_threads) as pool:
        scenarios = list(pool.map(_runner, req.config.scenarios_requested))

    return OptimizeResponse(run_id=req.run_id, scenarios=scenarios, warnings=pre.warnings)
