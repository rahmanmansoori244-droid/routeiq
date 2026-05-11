"""OR-Tools VRP solver — produces three scenarios per RouteIQ spec §7.

The solver operates on an integer matrix of distances (meters × 100, i.e. cm
to keep precision while allowing OR-Tools' int-only costs). Time matrix uses
seconds. Capacities are in cases (always integer).

Drop disjunctions: priority 1 customers cost 5,000,000 to drop; priority 5
cost 1,000,000. The solver will always prefer to drop priority-5 first when
infeasible (CLAUDE.md §7 explicitly inverted this w.r.t. the v1.1 bug).

The web layer does NOT depend on this module — it talks to the FastAPI service
over HTTP with a shared-secret header.
"""
from __future__ import annotations

import math
import logging
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from typing import Iterable

from ortools.constraint_solver import pywrapcp, routing_enums_pb2

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


def haversine_km(lat1: float, lng1: float, lat2: float, lng2: float) -> float:
    rlat1, rlat2 = math.radians(lat1), math.radians(lat2)
    dlat = math.radians(lat2 - lat1)
    dlng = math.radians(lng2 - lng1)
    a = math.sin(dlat / 2) ** 2 + math.cos(rlat1) * math.cos(rlat2) * math.sin(dlng / 2) ** 2
    return 2 * EARTH_RADIUS_KM * math.asin(math.sqrt(a))


def effective_time_limit(base: int, stop_count: int) -> int:
    """CLAUDE.md §7 — auto-scale to keep small runs fast and let big runs breathe."""
    return min(max(base, int(stop_count * 0.05)), 120)


def drop_penalty(priority: int) -> int:
    """Higher priority → harder to drop. priority 1 → 5M, priority 5 → 1M."""
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
        # All stops are unservable.
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
        # Missing coordinates → drop.
        if s.lat is None or s.lng is None or (s.lat == 0 and s.lng == 0):
            drops.append(
                UnservedOrder(
                    order_id=s.order_id,
                    reason_code="MISSING_COORDINATES",
                    reason_message="Customer has no latitude/longitude.",
                )
            )
            continue
        # Demand exceeds the largest available truck.
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
    """Per-scenario tuning. Values map to fixed_cost / per_km multipliers on each truck."""

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
    # MAX_UTILIZATION mode bends the BALANCED scenario toward fuller trucks
    # (lower trucks-used weight, higher utilization weight).
    if req.config.max_utilization_mode:
        return ScenarioWeights(
            fixed_cost_multiplier=preset.fixed_cost_multiplier * 0.2,
            per_km_multiplier=preset.per_km_multiplier,
            description=preset.description + " (max-utilization weighting)",
        )
    return preset


# ---------------------------------------------------------------------------
# Core solve
# ---------------------------------------------------------------------------


def _build_distance_matrix(req: OptimizeRequest, solvable: list[Stop]) -> list[list[int]]:
    """Distance matrix in centimeters (int) — depot at index 0, then stops 1..N."""
    nodes = [(req.depot.lat, req.depot.lng)] + [(s.lat, s.lng) for s in solvable]
    mult = req.config.distance_multiplier
    size = len(nodes)
    mat = [[0] * size for _ in range(size)]
    for i in range(size):
        for j in range(size):
            if i == j:
                continue
            km = haversine_km(nodes[i][0], nodes[i][1], nodes[j][0], nodes[j][1]) * mult
            mat[i][j] = int(round(km * 100_000))  # km → cm (×100 000)
    return mat


def _build_time_matrix(
    distance_cm: list[list[int]],
    solvable: list[Stop],
    avg_speed_kmh: float,
) -> list[list[int]]:
    """Time matrix in SECONDS, includes service time at destination node."""
    # cm → km: /100_000. km / kmh → hours. hours * 3600 → seconds.
    speed = max(avg_speed_kmh, 1.0)
    size = len(distance_cm)
    service_secs = [0] + [s.service_time_min * 60 for s in solvable]
    out = [[0] * size for _ in range(size)]
    for i in range(size):
        for j in range(size):
            if i == j:
                continue
            travel_secs = int(round((distance_cm[i][j] / 100_000) / speed * 3600))
            out[i][j] = travel_secs + service_secs[j]
    return out


def _solve_one_scenario(
    name: ScenarioName,
    req: OptimizeRequest,
    solvable: list[Stop],
    distance_cm: list[list[int]],
    time_secs: list[list[int]],
    time_limit_sec: int,
) -> tuple[Scenario, list[UnservedOrder]]:
    """Returns (scenario, dropped_orders_from_solver)."""
    n_stops = len(solvable)
    if n_stops == 0:
        return (
            Scenario(
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
            ),
            [],
        )

    n_nodes = n_stops + 1  # +1 for depot
    n_trucks = len(req.trucks)
    weights = adjusted_weights(name, req)

    manager = pywrapcp.RoutingIndexManager(n_nodes, n_trucks, 0)
    routing = pywrapcp.RoutingModel(manager)

    # Distance callback (in cm).
    def distance_cb(from_idx: int, to_idx: int) -> int:
        f = manager.IndexToNode(from_idx)
        t = manager.IndexToNode(to_idx)
        return distance_cm[f][t]

    transit_idx = routing.RegisterTransitCallback(distance_cb)

    # Per-vehicle cost: per-km × scenario multiplier. cm → cost scale.
    # OR-Tools' SetArcCostEvaluatorOfVehicle expects integer cost per transit.
    # We bake "cost per cm" using truck.cost_per_km * per_km_multiplier.
    per_km_multiplier = weights.per_km_multiplier

    def make_arc_cost_cb(truck: Truck):
        # cm → km is /100_000; cost = (cm/100_000) * cost_per_km * multiplier.
        # Pre-compute the integer scaling factor.
        cost_per_cm_scaled = int(round(truck.cost_per_km * per_km_multiplier * 100))  # tiny ratio
        # We'll scale by 1e-3 at the end of accumulation; OR-Tools just needs ordering-correct ints.
        def cb(from_idx: int, to_idx: int) -> int:
            f = manager.IndexToNode(from_idx)
            t = manager.IndexToNode(to_idx)
            return distance_cm[f][t] * cost_per_cm_scaled // 100_000  # scaled cost
        return cb

    truck_cost_callbacks = [routing.RegisterTransitCallback(make_arc_cost_cb(t)) for t in req.trucks]
    for v_idx, t in enumerate(req.trucks):
        routing.SetArcCostEvaluatorOfVehicle(truck_cost_callbacks[v_idx], v_idx)

    # Fixed cost per vehicle.
    for v_idx, t in enumerate(req.trucks):
        fixed = int(round(t.fixed_cost_per_day * weights.fixed_cost_multiplier * 100))
        routing.SetFixedCostOfVehicle(fixed, v_idx)

    # Capacity (cases) dimension.
    def demand_cb(from_idx: int) -> int:
        node = manager.IndexToNode(from_idx)
        if node == 0:
            return 0
        return solvable[node - 1].demand_cases

    demand_idx = routing.RegisterUnaryTransitCallback(demand_cb)
    routing.AddDimensionWithVehicleCapacity(
        demand_idx,
        0,
        [t.capacity_cases for t in req.trucks],
        True,  # start cumul to zero
        "Cases",
    )

    # Time dimension — includes service time. Driver shift max in seconds.
    def time_cb(from_idx: int, to_idx: int) -> int:
        f = manager.IndexToNode(from_idx)
        t = manager.IndexToNode(to_idx)
        return time_secs[f][t]

    time_idx = routing.RegisterTransitCallback(time_cb)
    shift_max_secs = req.config.driver_shift_max_min * 60
    routing.AddDimension(time_idx, 0, shift_max_secs, True, "Time")

    # Disjunctions — allow drops with priority-inverted penalty.
    for i, s in enumerate(solvable, start=1):
        routing.AddDisjunction([manager.NodeToIndex(i)], drop_penalty(s.priority))

    # Search params.
    search = pywrapcp.DefaultRoutingSearchParameters()
    search.first_solution_strategy = routing_enums_pb2.FirstSolutionStrategy.PATH_CHEAPEST_ARC
    search.local_search_metaheuristic = routing_enums_pb2.LocalSearchMetaheuristic.GUIDED_LOCAL_SEARCH
    search.time_limit.seconds = max(1, time_limit_sec)

    solution = routing.SolveWithParameters(search)
    if solution is None:
        # Whole solve failed — every stop becomes INFEASIBLE_ROUTE.
        return (
            Scenario(
                name=name,
                trucks_used=0,
                total_distance_km=0.0,
                total_time_min=0,
                total_cost=0.0,
                avg_utilization_pct=0.0,
                distance_provider=req.config.distance_provider,
                distance_is_estimated=req.config.distance_provider == "HAVERSINE",
                unserved_orders=[
                    UnservedOrder(
                        order_id=s.order_id,
                        reason_code="INFEASIBLE_ROUTE",
                        reason_message="Solver could not find any feasible route.",
                    )
                    for s in solvable
                ],
                routes=[],
            ),
            [],
        )

    # Extract routes per vehicle.
    routes_out: list[Route] = []
    served_indices: set[int] = set()
    total_distance_km = 0.0
    total_time_min = 0
    total_cost = 0.0
    trucks_used = 0
    util_pct_sum = 0.0
    util_pct_count = 0

    time_dim = routing.GetDimensionOrDie("Time")

    for v in range(n_trucks):
        idx = routing.Start(v)
        if routing.IsEnd(solution.Value(routing.NextVar(idx))):
            continue  # vehicle unused
        trucks_used += 1
        truck = req.trucks[v]
        seq = 0
        route_distance_km = 0.0
        route_load = 0
        stops_out: list[RouteStop] = []
        prev_distance_cm = 0
        while not routing.IsEnd(idx):
            node = manager.IndexToNode(idx)
            if node != 0:
                served_indices.add(node)
                seq += 1
                stop = solvable[node - 1]
                arrival_secs = solution.Value(time_dim.CumulVar(idx))
                stops_out.append(
                    RouteStop(
                        sequence=seq,
                        order_id=stop.order_id,
                        customer_id=stop.customer_id,
                        planned_arrival_min=int(round(arrival_secs / 60)),
                        planned_distance_from_prev_km=round(prev_distance_cm / 100_000, 3),
                        planned_load_cases=route_load + stop.demand_cases,
                    )
                )
                route_load += stop.demand_cases
            next_idx = solution.Value(routing.NextVar(idx))
            prev_distance_cm = distance_cm[manager.IndexToNode(idx)][manager.IndexToNode(next_idx)]
            route_distance_km += prev_distance_cm / 100_000
            idx = next_idx
        # Final time at end node.
        end_arrival_secs = solution.Value(time_dim.CumulVar(idx))
        route_time_min = int(round(end_arrival_secs / 60))

        route_cost = truck.fixed_cost_per_day + truck.cost_per_km * route_distance_km
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
        total_cost += route_cost
        util_pct_sum += util_pct
        util_pct_count += 1

    # Identify dropped stops (not visited by any vehicle).
    dropped_by_solver: list[UnservedOrder] = []
    for i in range(1, n_nodes):
        if i not in served_indices:
            s = solvable[i - 1]
            dropped_by_solver.append(
                UnservedOrder(
                    order_id=s.order_id,
                    reason_code="SOLVER_DROPPED_LOW_PRIORITY",
                    reason_message=(
                        f"Solver dropped this stop to keep the rest feasible "
                        f"(priority {s.priority})."
                    ),
                )
            )

    return (
        Scenario(
            name=name,
            trucks_used=trucks_used,
            total_distance_km=round(total_distance_km, 2),
            total_time_min=total_time_min,
            total_cost=round(total_cost, 2),
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
        "run=%s stops=%d trucks=%d pre_drops=%d time_limit=%ds",
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

    # Run scenarios in parallel — OR-Tools' native solver releases the GIL,
    # so the elapsed time is ~max(per-scenario), not sum(per-scenario).
    def _runner(name: ScenarioName) -> Scenario:
        scenario, _ = _solve_one_scenario(
            name=name,
            req=req,
            solvable=pre.solvable,
            distance_cm=distance_cm,
            time_secs=time_secs,
            time_limit_sec=time_limit,
        )
        # Merge pre-solver drops (missing coords etc.) with solver drops.
        scenario.unserved_orders = _merge_unserved(pre.drops, scenario.unserved_orders)
        return scenario

    n_threads = min(len(req.config.scenarios_requested), 3)
    with ThreadPoolExecutor(max_workers=n_threads) as pool:
        scenarios = list(pool.map(_runner, req.config.scenarios_requested))

    return OptimizeResponse(run_id=req.run_id, scenarios=scenarios, warnings=pre.warnings)
