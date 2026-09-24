"""NMWC daily dispatch optimizer (OR-Tools).

Answers: "what should we load, into which truck, and in what delivery sequence?"

Model (see docs/OPTIMIZER_DESIGN.md for the business explanation)
------------------------------------------------------------------
* Nodes: node 0 is the depot, nodes 1..n are delivery stops (one per customer branch).
* Vehicles: one routing vehicle per PHYSICAL truck. Extra loads are optional depot "reload"
  visits owned by that truck (``max_trips = 3`` -> two reload visits). A reload visit resets
  the truck's case/kg load and takes ``reload_min``. Because every load of a truck is on one
  route, loads can never overlap in time, load k+1 always departs after load k is back and
  reloaded, and the whole truck day (first departure -> last return) is bounded by
  ``shift_max_min``.
  Loads that are LOCKED/LOADING/DISPATCHED arrive as ``frozen_trips``: they are not
  re-optimized; they only push the truck's next departure after their return.
* Hard constraints: capacity in cases AND kg (when the truck has a payload), hard customer
  receiving windows (service must START inside the window), depot open hours, truck
  availability, trip linking, shift limit.
* Objective (single integer, 1 unit = 0.00001 OMR) built hierarchically by magnitude:
    1+2. Service: leaving a stop unserved costs ``priority_weight[p] x SERVICE_UNIT``.
         SERVICE_UNIT (100,000 OMR) dwarfs any realistic operating cost, so the solver
         always serves what it physically can, and P1 (weight 10,000) dominates P5 (1).
    3.   Contribution margin (only if every stop has a reliable margin): added to the
         service value x10, capped below one service unit so it breaks ties between stops
         of the SAME priority but can never outrank a higher priority.
    4.   Operating cost in real OMR: fixed truck cost (once per truck-day), per-load cost,
         distance cost (cost_per_km + fuel_price / km_per_litre - fuel is counted ONCE),
         driver time cost, overtime.
    5.   Fewer trucks/trips/km fall out of 4 (fixed + distance costs).
    6.   Soft preferences: preferred window deviation and an early-arrival preference for
         high priorities, in OMR per minute.
* Search: parallel cheapest insertion + guided local search with a time limit. The result
  is an OPTIMIZED plan (good, feasible), never claimed to be a proven optimum.
"""
from __future__ import annotations

import logging
import math
import os
import time
from concurrent.futures import ProcessPoolExecutor
from dataclasses import dataclass

from ortools.constraint_solver import pywrapcp, routing_enums_pb2

from dispatch_models import (
    DAY_MIN,
    DispatchConfig,
    DispatchRequest,
    DispatchResponse,
    DispatchScenario,
    DispatchScenarioName,
    DispatchStop,
    DispatchTruck,
    ObjectiveComponents,
    PlannedLoad,
    PlannedStop,
    UnservedStop,
)
from providers import MatrixResult, resolve_matrix

log = logging.getLogger("routeiq.dispatch")

COST_SCALE = 100_000  # 1 OMR = 100,000 objective units
SERVICE_UNIT = 10_000_000_000  # value of serving a P5 stop (= 100,000 OMR) in objective units
MARGIN_WEIGHT = 10  # margin is weighted 10x operating cost ...
MARGIN_CAP = int(SERVICE_UNIT * 0.4)  # ... but can never outweigh one service unit
HORIZON_S = 2 * DAY_MIN * 60
# Worker start-up + matrix pickling + extraction on top of an alternative's solver time limit.
ALT_GRACE_SEC = int(os.environ.get("SOLVER_ALT_GRACE_SEC", "20"))
ENGINE = "ortools-routing"


def auto_time_limit(n_stops: int) -> int:
    # A normal NMWC day (~150 stops) stays fast. Big days get much more time: at 300 stops 45 s
    # left feasible P5 stops unserved (search not converged) while 150 s served all of them.
    if n_stops <= 25:
        return 3
    if n_stops <= 80:
        return 8
    if n_stops <= 200:
        return 20
    if n_stops <= 350:
        return 150
    return 240


@dataclass(frozen=True)
class ScenarioWeights:
    fixed: float
    trip: float
    distance: float  # multiplier on true per-km cost
    time: float
    pure_distance: bool = False  # MIN_DISTANCE: cost = metres, ignore money
    # Soft time preferences (preferred windows, early arrival, overtime). Only the RECOMMENDED plan
    # uses them: alternatives answer one question each and must be warm-startable, and OR-Tools'
    # route restore can stall when soft cumul costs are present.
    soft_prefs: bool = True


SCENARIOS: dict[str, ScenarioWeights] = {
    "RECOMMENDED": ScenarioWeights(fixed=1.0, trip=1.0, distance=1.0, time=1.0),
    # MIN_TRUCKS answers "how few trucks/loads can do the day" inside the hard limits.
    "MIN_TRUCKS": ScenarioWeights(fixed=20.0, trip=5.0, distance=1.0, time=0.0, soft_prefs=False),
    "MIN_DISTANCE": ScenarioWeights(fixed=0.0, trip=0.0, distance=1.0, time=0.0, pure_distance=True, soft_prefs=False),
}


@dataclass
class TruckDay:
    truck: DispatchTruck
    idx: int
    n_frozen: int
    trips_left: int
    earliest_depart_s: int
    latest_return_s: int
    shift_anchor_s: int | None  # first frozen departure, if any
    max_cases: int
    max_kg: float  # 0 = unconstrained

    @property
    def usable(self) -> bool:
        return self.trips_left > 0 and self.latest_return_s > self.earliest_depart_s


def _truck_days(req: DispatchRequest) -> list[TruckDay]:
    cfg = req.config
    out: list[TruckDay] = []
    for i, t in enumerate(req.trucks):
        max_trips = t.max_trips or cfg.max_trips_per_truck
        frozen = sorted(t.frozen_trips, key=lambda f: f.load_no)
        earliest = max(cfg.shift_start_min, req.depot.open_min, t.available_from_min or 0)
        anchor = None
        if frozen:
            anchor = min(f.depart_min for f in frozen)
            earliest = max(earliest, max(f.return_min for f in frozen) + cfg.reload_min)
        latest = min(req.depot.close_min if req.depot.close_min > 0 else DAY_MIN, t.available_to_min or DAY_MIN * 2)
        if anchor is not None:
            latest = min(latest, anchor + cfg.shift_max_min)
        out.append(
            TruckDay(
                truck=t,
                idx=i,
                n_frozen=len(frozen),
                trips_left=max(0, max_trips - len(frozen)),
                earliest_depart_s=earliest * 60,
                latest_return_s=latest * 60,
                shift_anchor_s=anchor * 60 if anchor is not None else None,
                max_cases=t.capacity_cases,
                max_kg=t.capacity_kg,
            )
        )
    return out


def _fits_capacity(stop: DispatchStop, td: TruckDay) -> bool:
    if stop.demand_cases > td.max_cases:
        return False
    if td.max_kg > 0 and stop.demand_kg > td.max_kg:
        return False
    return True


def _unserved(stop: DispatchStop, code: str, msg: str) -> UnservedStop:
    return UnservedStop(stop_id=stop.stop_id, order_ids=list(stop.order_ids), reason_code=code, reason_message=msg)  # type: ignore[arg-type]


def _prefilter(req: DispatchRequest, tds: list[TruckDay]) -> tuple[list[DispatchStop], list[UnservedStop], list[str]]:
    """Capacity / availability checks that do not need the matrix."""
    warnings: list[str] = []
    drops: list[UnservedStop] = []
    usable = [td for td in tds if td.usable]
    if not req.trucks:
        return [], [_unserved(s, "NO_AVAILABLE_TRUCK", "No active trucks at this depot.") for s in req.stops], [
            "No trucks available."
        ]
    if not usable:
        trip_exhausted = all(td.trips_left == 0 for td in tds)
        code = "TRIP_LIMIT" if trip_exhausted else "SHIFT_LIMIT"
        msg = (
            "Every truck has already used its maximum number of loads (locked/dispatched)."
            if trip_exhausted
            else "No truck has shift time left after its locked/dispatched loads."
        )
        return [], [_unserved(s, code, msg) for s in req.stops], ["No truck has capacity left for new loads."]
    solvable: list[DispatchStop] = []
    for s in req.stops:
        if not any(_fits_capacity(s, td) for td in usable):
            max_c = max(td.max_cases for td in usable)
            kg_trucks = [td.max_kg for td in usable if td.max_kg > 0]
            detail = f"{s.demand_cases} cases vs largest truck {max_c} cases"
            if kg_trucks and s.demand_kg > max(kg_trucks):
                detail += f"; {s.demand_kg:.0f} kg vs largest payload {max(kg_trucks):.0f} kg"
            drops.append(_unserved(s, "EXCEEDS_ANY_TRUCK_CAPACITY",
                                   f"Order is larger than any available truck ({detail}). Split it or use a bigger truck."))
            continue
        solvable.append(s)
    return solvable, drops, warnings


def _window_prefilter(
    stops: list[DispatchStop], tds: list[TruckDay], mx: MatrixResult, cfg: DispatchConfig
) -> tuple[list[int], list[UnservedStop]]:
    """Drop stops that no truck could ever reach inside its hard window / shift. Returns the
    indices (into ``stops``) that stay solvable."""
    keep: list[int] = []
    drops: list[UnservedStop] = []
    usable = [td for td in tds if td.usable]
    for k, s in enumerate(stops):
        node = k + 1
        out_s = mx.duration_s[0][node]
        back_s = mx.duration_s[node][0]
        hs = (s.hard_start_min or 0) * 60
        he = (s.hard_end_min if s.hard_end_min is not None else DAY_MIN * 2) * 60
        window_ok = False
        shift_ok = False
        for td in usable:
            if not _fits_capacity(s, td):
                continue
            arrive = td.earliest_depart_s + out_s
            start = max(arrive, hs)
            if start > he:
                continue
            window_ok = True
            finish = start + s.service_min * 60 + back_s
            shift_limit = td.latest_return_s
            if td.shift_anchor_s is None:
                # Leaving later than needed only makes the day longer - the tightest check is
                # a truck that leaves just in time to arrive at the window start.
                depart = max(td.earliest_depart_s, start - out_s)
                shift_limit = min(shift_limit, depart + cfg.shift_max_min * 60)
            if finish <= shift_limit:
                shift_ok = True
                break
        if not window_ok:
            hw = f"{_hhmm(s.hard_start_min)}-{_hhmm(s.hard_end_min)}"
            drops.append(_unserved(s, "HARD_WINDOW_INFEASIBLE",
                                   f"No truck can reach this customer inside its receiving window {hw} "
                                   f"(earliest possible arrival {_hhmm(min(td.earliest_depart_s for td in usable) // 60 + out_s // 60)})."))
        elif not shift_ok:
            drops.append(_unserved(s, "SHIFT_LIMIT",
                                   "A round trip to this customer does not fit inside the truck shift / depot hours."))
        else:
            keep.append(k)
    return keep, drops


def _hhmm(m: int | None) -> str:
    if m is None:
        return "--:--"
    m = int(m)
    return f"{(m // 60) % 24:02d}:{m % 60:02d}" + ("+1" if m >= DAY_MIN else "")


def _stop_value(s: DispatchStop, cfg: DispatchConfig, use_margin: bool) -> int:
    w = cfg.priority_weights
    base = int(round(SERVICE_UNIT * (w[s.priority] / w[5])))
    if use_margin and s.margin is not None and s.margin > 0:
        base += min(MARGIN_CAP, int(round(s.margin * COST_SCALE * MARGIN_WEIGHT)))
    return base


def _km_rate_omr(t: DispatchTruck, cfg: DispatchConfig) -> float:
    """OMR per km for this truck: non-fuel variable cost + fuel (fuel counted exactly once)."""
    rate = t.cost_per_km
    if t.km_per_litre and cfg.fuel_price_per_litre > 0:
        rate += cfg.fuel_price_per_litre / t.km_per_litre
    return rate


@dataclass
class _Model:
    """Node layout for one scenario.

    node 0            depot (route start/end)
    nodes 1..n        delivery stops
    nodes n+1..       reload visits: truck T with trips_left = 3 owns two reload nodes. Visiting
                      one means "back at the depot, unload/reload for reload_min, start the next
                      load". They reset the Cases/Kg dimensions via slack (OR-Tools cvrp_reload
                      pattern), so every load of a truck lives on ONE routing vehicle - loads can
                      never overlap in time and the truck day is a single span.
    """

    n_stops: int
    reload_owner: list[int]  # reload node k -> vehicle index
    vehicles: list[TruckDay]

    def loc(self, node: int) -> int:
        return node if 1 <= node <= self.n_stops else 0

    def is_reload(self, node: int) -> bool:
        return node > self.n_stops

    @property
    def n_nodes(self) -> int:
        return 1 + self.n_stops + len(self.reload_owner)


def _solve_scenario(
    name: DispatchScenarioName,
    req: DispatchRequest,
    stops: list[DispatchStop],
    tds: list[TruckDay],
    mx: MatrixResult,
    time_limit: int,
    pre_drops: list[UnservedStop],
    warm_start: list[PlannedLoad] | None = None,
) -> DispatchScenario:
    cfg = req.config
    w = SCENARIOS[name]
    use_margin = cfg.use_margin and bool(stops) and all(s.margin is not None for s in stops)
    started = time.perf_counter()
    if not stops:
        return _empty_scenario(name, "NOTHING_TO_PLAN", pre_drops, time_limit, mx)

    vehicles = [td for td in tds if td.usable]
    reload_owner: list[int] = []
    for v, td in enumerate(vehicles):
        reload_owner += [v] * max(0, td.trips_left - 1)
    m = _Model(n_stops=len(stops), reload_owner=reload_owner, vehicles=vehicles)
    N = m.n_nodes
    nv = len(vehicles)
    reload_s = cfg.reload_min * 60

    manager = pywrapcp.RoutingIndexManager(N, nv, 0)
    routing = pywrapcp.RoutingModel(manager)

    locs = [m.loc(i) for i in range(N)]
    service_s = [0] * N
    for k, s in enumerate(stops):
        service_s[k + 1] = s.service_min * 60
    for r in range(len(reload_owner)):
        service_s[1 + len(stops) + r] = reload_s

    # --- arc costs: per truck (rate differs by truck; reload arcs carry the per-load cost) ---
    # Plan continuity (re-plans, RECOMMENDED only): entering a stop that sat on another truck in
    # the previous version costs change_penalty. Exactly one arc enters each visited stop, so the
    # penalty is paid once per moved stop. Needs one matrix per truck when active.
    continuity = w.soft_prefs and cfg.change_penalty_per_stop > 0 and any(s.previous_truck_id for s in stops)
    change_units = int(round(cfg.change_penalty_per_stop * COST_SCALE))
    cost_cb: dict[tuple, int] = {}
    for v, td in enumerate(vehicles):
        rate = 1.0 if w.pure_distance else _km_rate_omr(td.truck, cfg) * w.distance * COST_SCALE / 1000.0
        trip_units = 0 if w.pure_distance else int(round(td.truck.trip_cost * w.trip * COST_SCALE))
        key = (int(round(rate * 1000)), trip_units, td.truck.id if continuity else None)
        if key not in cost_cb:
            moved = [False] * N
            if continuity:
                for k, s in enumerate(stops):
                    moved[k + 1] = bool(s.previous_truck_id) and s.previous_truck_id != td.truck.id
            mat = []
            for i in range(N):
                row = []
                li = locs[i]
                for j in range(N):
                    c = int(round(mx.distance_m[li][locs[j]] * key[0] / 1000.0)) if i != j else 0
                    if m.is_reload(j) and i != j:
                        c += key[1] + 1  # +1: never reload for nothing
                    if moved[j] and i != j:
                        c += change_units
                    row.append(c)
                mat.append(row)
            cost_cb[key] = routing.RegisterTransitMatrix(mat)
        routing.SetArcCostEvaluatorOfVehicle(cost_cb[key], v)
        fixed = 0.0
        if td.n_frozen == 0:
            fixed += td.truck.fixed_cost * (0.0 if w.pure_distance else w.fixed)
        if not w.pure_distance:
            fixed += td.truck.trip_cost * w.trip  # the first new load
        routing.SetFixedCostOfVehicle(int(round(fixed * COST_SCALE)), v)

    # --- capacity with reload reset (cases always, kg when any payload is set) --------------
    def add_capacity(name_: str, demand: list[int], caps: list[int]) -> None:
        vec = list(demand)
        for r, v in enumerate(reload_owner):
            vec[1 + len(stops) + r] = -caps[v]
        cb = routing.RegisterUnaryTransitVector(vec)
        routing.AddDimensionWithVehicleCapacity(cb, max(caps), caps, True, name_)
        dim = routing.GetDimensionOrDie(name_)
        for node in range(1, N):
            if not m.is_reload(node):
                dim.SlackVar(manager.NodeToIndex(node)).SetValue(0)
        for v in range(nv):
            dim.SlackVar(routing.Start(v)).SetValue(0)

    add_capacity("Cases", [0] + [s.demand_cases for s in stops] + [0] * len(reload_owner),
                 [td.truck.capacity_cases for td in vehicles])
    kg_active = any(td.max_kg > 0 for td in vehicles) and any(s.demand_kg > 0 for s in stops)
    if kg_active:
        big = 10**7
        add_capacity("Kg", [0] + [int(math.ceil(s.demand_kg)) for s in stops] + [0] * len(reload_owner),
                     [int(math.floor(td.max_kg)) if td.max_kg > 0 else big for td in vehicles])

    # --- time -----------------------------------------------------------------------------
    transit = [[(service_s[i] + mx.duration_s[locs[i]][locs[j]]) if i != j else 0 for j in range(N)] for i in range(N)]
    time_cb = routing.RegisterTransitMatrix(transit)
    routing.AddDimension(time_cb, HORIZON_S, HORIZON_S, False, "Time")
    tdim = routing.GetDimensionOrDie("Time")

    # MIN_DISTANCE is literally "fewest road km": hard windows and priorities still hold, soft
    # preferences (preferred windows, early arrival) are ignored so they cannot outweigh metres.
    pref_coeff = 0 if not w.soft_prefs else int(round(cfg.pref_window_penalty_per_min * COST_SCALE / 60.0))
    for k, s in enumerate(stops):
        idx = manager.NodeToIndex(k + 1)
        hs = (s.hard_start_min or 0) * 60
        he = (s.hard_end_min if s.hard_end_min is not None else DAY_MIN * 2) * 60
        tdim.CumulVar(idx).SetRange(hs, min(he, HORIZON_S))
        early_coeff = 0 if not w.soft_prefs else int(round(cfg.early_preference_per_min.get(s.priority, 0.0) * COST_SCALE / 60.0))
        if s.pref_end_min is not None and pref_coeff > 0:
            tdim.SetCumulVarSoftUpperBound(idx, s.pref_end_min * 60, pref_coeff + early_coeff)
        elif early_coeff > 0:
            tdim.SetCumulVarSoftUpperBound(idx, cfg.shift_start_min * 60, early_coeff)
        if s.pref_start_min is not None and pref_coeff > 0:
            tdim.SetCumulVarSoftLowerBound(idx, s.pref_start_min * 60, pref_coeff)
        routing.AddDisjunction([idx], _stop_value(s, cfg, use_margin))

    for r, v in enumerate(reload_owner):
        idx = manager.NodeToIndex(1 + len(stops) + r)
        routing.VehicleVar(idx).SetValues([-1, v])  # only its own truck (or unused)
        routing.AddDisjunction([idx], 0)
        td = vehicles[v]
        tdim.CumulVar(idx).SetRange(td.earliest_depart_s, td.latest_return_s)

    time_coeff = 0 if w.pure_distance else int(round(cfg.driver_cost_per_hour * w.time * COST_SCALE / 3600.0))
    ot_coeff = 0 if not w.soft_prefs else int(round(cfg.overtime_cost_per_hour * COST_SCALE / 3600.0))
    shift_s = cfg.shift_max_min * 60
    for v, td in enumerate(vehicles):
        start, end = routing.Start(v), routing.End(v)
        tdim.CumulVar(start).SetRange(td.earliest_depart_s, td.latest_return_s)
        tdim.CumulVar(end).SetRange(td.earliest_depart_s, td.latest_return_s)
        if td.shift_anchor_s is None:
            tdim.SetSpanUpperBoundForVehicle(shift_s, v)
        if time_coeff:
            tdim.SetSpanCostCoefficientForVehicle(time_coeff, v)
        if ot_coeff and cfg.overtime_after_min is not None:
            anchor = td.shift_anchor_s if td.shift_anchor_s is not None else td.earliest_depart_s
            tdim.SetCumulVarSoftUpperBound(end, anchor + cfg.overtime_after_min * 60, ot_coeff)

    params = pywrapcp.DefaultRoutingSearchParameters()
    params.first_solution_strategy = routing_enums_pb2.FirstSolutionStrategy.PARALLEL_CHEAPEST_INSERTION
    params.local_search_metaheuristic = routing_enums_pb2.LocalSearchMetaheuristic.GUIDED_LOCAL_SEARCH
    params.time_limit.seconds = max(1, int(time_limit))
    params.log_search = False

    assignment = None
    # Warm start only when the time dimension carries no cost at all (no span cost, no soft
    # bounds): OR-Tools' route restore (ReadAssignmentFromRoutes) can stall searching cumul values
    # under dimension costs - reproduced with a real OSRM matrix + overtime/preferred windows.
    if warm_start and time_coeff == 0 and not w.soft_prefs:
        initial = _initial_assignment(routing, m, stops, warm_start)
        if initial is not None:
            assignment = routing.SolveFromAssignmentWithParameters(initial, params)
    if assignment is None:
        assignment = routing.SolveWithParameters(params)
    elapsed = time.perf_counter() - started
    status_name = routing_enums_pb2.RoutingSearchStatus.Value.Name(routing.status())

    if assignment is None:
        drops = list(pre_drops) + [
            _unserved(s, "INFEASIBLE", f"The optimizer found no feasible plan ({status_name}).") for s in stops
        ]
        sc = _empty_scenario(name, "NO_SOLUTION", drops, time_limit, mx)
        sc.solver_status = status_name
        sc.solver_time_sec = round(elapsed, 2)
        return sc

    return _extract(name, req, stops, tds, m, manager, routing, assignment, mx, cfg,
                    use_margin, pre_drops, status_name, elapsed, time_limit)


def _extract(name, req, stops, tds, m: _Model, manager, routing, assignment, mx, cfg,
             use_margin, pre_drops, status_name, elapsed, time_limit) -> DispatchScenario:
    tdim = routing.GetDimensionOrDie("Time")
    reload_s = cfg.reload_min * 60
    loads: list[PlannedLoad] = []
    served: set[int] = set()
    comp = dict(fixed=0.0, distance=0.0, fuel=0.0, time=0.0, overtime=0.0, window=0.0)

    for v, td in enumerate(m.vehicles):
        if not routing.IsVehicleUsed(assignment, v):
            continue
        t = td.truck
        # Split the single route into loads at reload visits.
        trips: list[list[tuple[int, int]]] = [[]]  # (node, cumul_s) per stop
        idx = assignment.Value(routing.NextVar(routing.Start(v)))
        start_cumul = assignment.Value(tdim.CumulVar(routing.Start(v)))
        trip_starts = [start_cumul]
        while not routing.IsEnd(idx):
            node = manager.IndexToNode(idx)
            cum = assignment.Value(tdim.CumulVar(idx))
            if m.is_reload(node):
                trips.append([])
                trip_starts.append(cum + reload_s)
            else:
                trips[-1].append((node, cum))
            idx = assignment.Value(routing.NextVar(idx))

        load_no = td.n_frozen
        for trip, earliest_depart in zip(trips, trip_starts):
            if not trip:
                continue  # empty load (consecutive reloads) - not a real load
            load_no += 1
            first_node = trip[0][0]
            # Leave just in time for the first delivery (no pointless waiting at stop 1), but
            # never before the truck is ready.
            depart_s = max(earliest_depart, trip[0][1] - mx.duration_s[0][m.loc(first_node)])
            prev_node, prev_dep = 0, depart_s
            cum_m, cases, kg, seq = 0, 0, 0.0, 0
            stops_out: list[PlannedStop] = []
            for node, start_s in trip:
                s = stops[node - 1]
                served.add(node - 1)
                leg_m = mx.distance_m[m.loc(prev_node)][node]
                leg_s = mx.duration_s[m.loc(prev_node)][node]
                arrival_s = prev_dep + leg_s
                start_s = max(start_s, arrival_s)
                dep_s = start_s + s.service_min * 60
                cum_m += leg_m
                cases += s.demand_cases
                kg += s.demand_kg
                seq += 1
                hs = (s.hard_start_min or 0) * 60
                he = (s.hard_end_min if s.hard_end_min is not None else DAY_MIN * 2) * 60
                ps = s.pref_start_min * 60 if s.pref_start_min is not None else None
                pe = s.pref_end_min * 60 if s.pref_end_min is not None else None
                pref_ok = (ps is None or start_s >= ps) and (pe is None or start_s <= pe)
                if not pref_ok:
                    dev = (max(0, ps - start_s) if ps is not None else 0) + (max(0, start_s - pe) if pe is not None else 0)
                    comp["window"] += dev / 60.0 * cfg.pref_window_penalty_per_min
                stops_out.append(PlannedStop(
                    sequence=seq, stop_id=s.stop_id, order_ids=list(s.order_ids), customer_id=s.customer_id,
                    arrival_min=int(round(arrival_s / 60)), service_start_min=int(round(start_s / 60)),
                    departure_min=int(round(dep_s / 60)), wait_min=int(round((start_s - arrival_s) / 60)),
                    leg_km=round(leg_m / 1000.0, 2), cum_km=round(cum_m / 1000.0, 2), leg_min=int(round(leg_s / 60)),
                    cases=s.demand_cases, kg=round(s.demand_kg, 1),
                    hard_window_ok=hs <= start_s <= he, pref_window_ok=pref_ok,
                ))
                prev_node, prev_dep = node, dep_s
            back_m = mx.distance_m[m.loc(prev_node)][0]
            back_s = mx.duration_s[m.loc(prev_node)][0]
            cum_m += back_m
            return_s = prev_dep + back_s
            km = cum_m / 1000.0
            dur_min = (return_s - depart_s) / 60.0
            litres = km / t.km_per_litre if t.km_per_litre else None
            fuel_cost = (litres or 0.0) * cfg.fuel_price_per_litre
            dist_cost = km * t.cost_per_km
            time_cost = dur_min / 60.0 * cfg.driver_cost_per_hour
            fixed_cost = (t.fixed_cost if load_no == 1 else 0.0) + t.trip_cost
            util_parts = [cases / t.capacity_cases if t.capacity_cases else 0.0]
            if t.capacity_kg > 0:
                util_parts.append(kg / t.capacity_kg)
            comp["fixed"] += fixed_cost
            comp["distance"] += dist_cost
            comp["fuel"] += fuel_cost
            comp["time"] += time_cost
            loads.append(PlannedLoad(
                truck_id=t.id, load_no=load_no, depart_min=int(round(depart_s / 60)),
                return_min=int(round(return_s / 60)), distance_km=round(km, 2), duration_min=int(round(dur_min)),
                cases=cases, kg=round(kg, 1), utilization_pct=round(100.0 * max(util_parts), 1),
                fuel_litres=round(litres, 1) if litres is not None else None, fuel_cost=round(fuel_cost, 3),
                distance_cost=round(dist_cost, 3), time_cost=round(time_cost, 3), fixed_cost=round(fixed_cost, 3),
                total_cost=round(fixed_cost + dist_cost + fuel_cost + time_cost, 3),
                return_leg_km=round(back_m / 1000.0, 2), stops=stops_out,
            ))

    if cfg.overtime_after_min is not None:
        by_truck: dict[str, list[PlannedLoad]] = {}
        for ld in loads:
            by_truck.setdefault(ld.truck_id, []).append(ld)
        for tid, lds in by_truck.items():
            td = next(x for x in tds if x.truck.id == tid)
            first_dep = td.shift_anchor_s / 60 if td.shift_anchor_s is not None else min(l.depart_min for l in lds)
            over = max(0.0, max(l.return_min for l in lds) - first_dep - cfg.overtime_after_min)
            comp["overtime"] += over / 60.0 * cfg.overtime_cost_per_hour

    unserved = list(pre_drops)
    total_cap_cases = sum(td.truck.capacity_cases * td.trips_left for td in tds if td.usable)
    demand_cases = sum(s.demand_cases for s in stops)
    shortage = demand_cases > total_cap_cases
    unserved_penalty = 0.0
    # PARTIAL_SUCCESS_LOCAL_OPTIMUM_NOT_REACHED = stopped by the time limit mid-improvement.
    converged = status_name in ("ROUTING_SUCCESS", "ROUTING_OPTIMAL")
    dropped_unconverged = 0
    for k, s in enumerate(stops):
        if k in served:
            continue
        if not converged and not shortage and not s.late:
            dropped_unconverged += 1
        unserved_penalty += _stop_value(s, cfg, use_margin) / COST_SCALE
        if s.late:
            unserved.append(_unserved(s, "LATE_ORDER_NO_CAPACITY",
                                      f"Late order (P{s.priority}): no unlocked truck/load had capacity or time left. "
                                      "Locked and dispatched loads were not changed."))
        elif shortage:
            unserved.append(_unserved(s, "SOLVER_DROPPED_LOW_PRIORITY",
                                      f"Fleet capacity shortage: {demand_cases} cases requested vs {total_cap_cases} "
                                      f"cases across all available loads. Lower priorities are left out first (this is P{s.priority})."))
        elif not converged:
            unserved.append(_unserved(s, "SOLVER_DROPPED_LOW_PRIORITY",
                                      f"Not planned yet: the optimizer reached its {time_limit}s time limit before fitting "
                                      f"this P{s.priority} stop (search not finished). Re-plan, or give the solver more time."))
        else:
            unserved.append(_unserved(s, "SOLVER_DROPPED_LOW_PRIORITY",
                                      f"Could not be fitted with the higher-priority stops inside truck time, shift, "
                                      f"trip and receiving-window limits (P{s.priority})."))

    margin_served = round(sum(stops[k].margin or 0 for k in served), 3) if use_margin else None
    code_of = {t.id: (t.code or t.id) for t in req.trucks}
    loads.sort(key=lambda l: (code_of[l.truck_id], l.load_no))
    util = [ld.utilization_pct for ld in loads]
    warnings = list(mx.warnings)
    if dropped_unconverged:
        warnings.append(
            f"The search stopped at its {time_limit}s limit before converging; {dropped_unconverged} stop(s) left unserved "
            "might fit with more time. Re-plan to continue."
        )
    sc = DispatchScenario(
        name=name, status="OPTIMIZED", solver_status=status_name, solver_time_sec=round(elapsed, 2),
        time_limit_sec=time_limit, objective_value=int(assignment.ObjectiveValue()),
        objective=ObjectiveComponents(
            unserved_penalty=round(unserved_penalty, 1), fixed_cost=round(comp["fixed"], 3),
            distance_cost=round(comp["distance"], 3), fuel_cost=round(comp["fuel"], 3),
            time_cost=round(comp["time"], 3), overtime_cost=round(comp["overtime"], 3),
            window_penalty=round(comp["window"], 3), margin_served=margin_served,
        ),
        trucks_used=len({ld.truck_id for ld in loads}), trips=len(loads),
        total_distance_km=round(sum(ld.distance_km for ld in loads), 2),
        total_duration_min=sum(ld.duration_min for ld in loads),
        total_cases=sum(ld.cases for ld in loads), total_kg=round(sum(ld.kg for ld in loads), 1),
        avg_utilization_pct=round(sum(util) / len(util), 1) if util else 0.0,
        fuel_litres=round(sum(ld.fuel_litres or 0 for ld in loads), 1), fuel_cost=round(comp["fuel"], 3),
        operating_cost=round(comp["fixed"] + comp["distance"] + comp["fuel"] + comp["time"] + comp["overtime"], 3),
        loads=loads, unserved=unserved, warnings=warnings,
    )
    _assert_reconciled(req, sc)
    return sc


def _empty_scenario(name, status, drops, time_limit, mx: MatrixResult) -> DispatchScenario:
    return DispatchScenario(
        name=name,
        status=status,
        solver_status="NOT_RUN",
        solver_time_sec=0.0,
        time_limit_sec=time_limit,
        objective_value=0,
        objective=ObjectiveComponents(unserved_penalty=0, fixed_cost=0, distance_cost=0, fuel_cost=0,
                                      time_cost=0, overtime_cost=0, window_penalty=0, margin_served=None),
        trucks_used=0, trips=0, total_distance_km=0.0, total_duration_min=0, total_cases=0, total_kg=0.0,
        avg_utilization_pct=0.0, fuel_litres=0.0, fuel_cost=0.0, operating_cost=0.0,
        loads=[], unserved=list(drops), warnings=list(mx.warnings) if mx else [],
    )


class ReconciliationError(AssertionError):
    pass


def _assert_reconciled(req: DispatchRequest, sc: DispatchScenario) -> None:
    """Every input stop must appear exactly once: in one load, or unserved with a reason."""
    seen: dict[str, int] = {}
    for ld in sc.loads:
        for st in ld.stops:
            seen[st.stop_id] = seen.get(st.stop_id, 0) + 1
    for u in sc.unserved:
        seen[u.stop_id] = seen.get(u.stop_id, 0) + 1
    expected = {s.stop_id for s in req.stops}
    dup = [k for k, c in seen.items() if c != 1]
    missing = expected - set(seen)
    extra = set(seen) - expected
    if dup or missing or extra:
        raise ReconciliationError(f"scenario {sc.name}: duplicated={dup} missing={sorted(missing)} unknown={sorted(extra)}")
    planned_cases = sum(ld.cases for ld in sc.loads)
    unserved_cases = sum(next(s.demand_cases for s in req.stops if s.stop_id == u.stop_id) for u in sc.unserved)
    total = sum(s.demand_cases for s in req.stops)
    if planned_cases + unserved_cases != total:
        raise ReconciliationError(f"scenario {sc.name}: cases {planned_cases}+{unserved_cases} != {total}")


def optimize_dispatch(req: DispatchRequest, *, osrm_client=None) -> DispatchResponse:
    cfg = req.config
    tds = _truck_days(req)
    solvable, drops, warnings = _prefilter(req, tds)

    coords = [(req.depot.lat, req.depot.lng)] + [(s.lat, s.lng) for s in solvable]
    mx = resolve_matrix(
        coords,
        provider=cfg.distance_provider,
        osrm_url=cfg.osrm_url,
        haversine_multiplier=cfg.haversine_multiplier,
        avg_speed_kmh=cfg.avg_speed_kmh,
        road_time_factor=cfg.road_time_factor,
        osrm_client=osrm_client,
    )
    keep, window_drops = _window_prefilter(solvable, tds, mx, cfg)
    drops += window_drops
    if len(keep) != len(solvable):
        solvable, mx = _submatrix(solvable, keep, mx)

    time_limit = cfg.time_limit_sec or auto_time_limit(len(solvable))
    scenarios = _run_scenarios(list(cfg.scenarios), req, solvable, tds, mx, time_limit, drops)
    for sc in scenarios:
        log.info("dispatch run=%s scenario=%s status=%s loads=%d unserved=%d km=%.1f t=%.1fs",
                 req.run_id, sc.name, sc.solver_status, sc.trips, len(sc.unserved), sc.total_distance_km,
                 sc.solver_time_sec)

    return DispatchResponse(
        run_id=req.run_id,
        engine=ENGINE,
        matrix_provider=mx.provider_name,
        distance_is_estimated=mx.is_estimated,
        scenarios=scenarios,
        warnings=warnings + list(mx.warnings),
    )


def _initial_assignment(routing, m: _Model, stops: list[DispatchStop], loads: list[PlannedLoad]):
    """Rebuild a routing assignment from an existing plan (stops + reload visits per truck) so
    an alternative scenario starts from the recommended plan and can only improve its own goal."""
    node_of = {s.stop_id: k + 1 for k, s in enumerate(stops)}
    reloads_of: dict[int, list[int]] = {}
    for r, v in enumerate(m.reload_owner):
        reloads_of.setdefault(v, []).append(1 + m.n_stops + r)
    routes: list[list[int]] = []
    for v, td in enumerate(m.vehicles):
        mine = sorted((l for l in loads if l.truck_id == td.truck.id), key=lambda l: l.load_no)
        route: list[int] = []
        spare = list(reloads_of.get(v, []))
        for i, ld in enumerate(mine):
            if i > 0:
                if not spare:
                    return None
                route.append(spare.pop(0))
            route += [node_of[st.stop_id] for st in ld.stops if st.stop_id in node_of]
        routes.append(route)
    try:
        return routing.ReadAssignmentFromRoutes(routes, True)
    except Exception:  # noqa: BLE001
        return None


def _scenario_worker(args) -> DispatchScenario:
    # Test hook: simulate an OR-Tools call that never returns (see test_alternative_deadline).
    if os.environ.get("ROUTEIQ_TEST_HANG_SCENARIO") == args[0]:
        time.sleep(3600)
    return _solve_scenario(*args)


def _run_scenarios(names, req, solvable, tds, mx, time_limit, drops) -> list[DispatchScenario]:
    """RECOMMENDED is solved first with the full time budget. Alternatives are then warm-started
    from it (so MIN_DISTANCE never drives more km and MIN_TRUCKS never uses more trucks than the
    recommendation) with half the budget, in worker processes - OR-Tools holds the GIL, so
    threads would not run them concurrently.

    Safety net: alternatives are optional. Each worker gets a hard wall-clock deadline; a worker
    that overruns (OR-Tools occasionally ignores its own time limit inside internal restores) is
    terminated and the alternative is skipped with a warning. The RECOMMENDED plan is never lost
    because of an alternative. SOLVER_PARALLEL=0 solves alternatives sequentially (no deadline).
    """
    results: dict[str, DispatchScenario] = {}
    warm = None
    if "RECOMMENDED" in names:
        results["RECOMMENDED"] = _solve_scenario("RECOMMENDED", req, solvable, tds, mx, time_limit, drops)
        warm = results["RECOMMENDED"].loads or None
    alt_limit = max(2, time_limit // 2) if warm else time_limit
    jobs = [(n, req, solvable, tds, mx, alt_limit, drops, warm) for n in names if n not in results]
    skipped: list[str] = []
    if jobs and solvable and os.environ.get("SOLVER_PARALLEL", "1") != "0":
        import multiprocessing as mp

        grace = int(os.environ.get("SOLVER_ALT_GRACE_SEC", ALT_GRACE_SEC))
        deadline = time.monotonic() + alt_limit + grace
        try:
            # One process per alternative (at most two), even on 1-2 vCPU servers: with a shared
            # worker a stuck alternative starved the next one, which then hit the same deadline
            # without ever starting. OR-Tools limits are wall-clock, so sharing a core only
            # lowers quality, never the deadline.
            with mp.get_context("spawn").Pool(processes=len(jobs)) as pool:
                pending = [(j[0], pool.apply_async(_scenario_worker, (j,))) for j in jobs]
                for name, fut in pending:
                    try:
                        sc = fut.get(timeout=max(1.0, deadline - time.monotonic()))
                        results[sc.name] = sc
                    except mp.TimeoutError:
                        skipped.append(name)
                        log.warning("alternative %s exceeded %ss; skipped", name, alt_limit + grace)
                # leaving the with-block terminates any worker still running
        except Exception as exc:  # noqa: BLE001 - e.g. restricted environments without processes
            log.warning("parallel scenario solve failed (%s); solving sequentially", exc)
            for j in jobs:
                if j[0] not in results and j[0] not in skipped:
                    results[j[0]] = _scenario_worker(j)
    else:
        for j in jobs:
            results[j[0]] = _scenario_worker(j)
    rec = results.get("RECOMMENDED")
    if skipped and rec:
        rec.warnings.append(
            f"Alternative plan(s) {', '.join(skipped)} were skipped (took too long); the recommended plan is complete."
        )
    if rec:
        # Service comes first. If the (time-limited) recommendation left out stops that an
        # alternative serves, say so - the dispatcher decides; nothing switches automatically.
        for alt in results.values():
            if alt is rec or alt.status != "OPTIMIZED":
                continue
            gained = len(rec.unserved) - len(alt.unserved)
            if gained > 0:
                rec.warnings.append(
                    f"The {alt.name.replace('_', ' ')} option serves {gained} more stop(s) than this plan. "
                    "Review it under Plan options and choose 'Use instead' if it suits."
                )
    return [results[n] for n in names if n in results]


def _submatrix(stops: list[DispatchStop], keep: list[int], mx: MatrixResult) -> tuple[list[DispatchStop], MatrixResult]:
    nodes = [0] + [k + 1 for k in keep]
    dist = [[mx.distance_m[i][j] for j in nodes] for i in nodes]
    dur = [[mx.duration_s[i][j] for j in nodes] for i in nodes]
    return [stops[k] for k in keep], MatrixResult(dist, dur, mx.provider_name, mx.is_estimated, list(mx.warnings), mx.patched_cells)
