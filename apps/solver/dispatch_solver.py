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
  ``shift_max_min``. The turnaround between two loads is ``reload_min + loading_min_per_case x
  cases of the next load``; the route search cannot know the next load's size and uses 80% of a
  full truck, the final timing (load_repack) uses the exact value.
  Loads that are LOCKED/LOADING/DISPATCHED arrive as ``frozen_trips``: they are not
  re-optimized; they only push the truck's next departure after their return.
* Hard constraints: capacity in cases AND kg (when the truck has a payload), hard customer
  receiving windows (service must START inside the window), depot open hours, truck
  availability, trip linking, shift limit.
* Objective (single integer, 1 unit = 0.00001 OMR) built hierarchically by magnitude:
    1+2. Service. Strict priorities (default): leaving a stop of priority p unserved costs
         SERVICE_BASE (1,000 OMR) x w_p with w_5 = 1 and w_p = 1 + sum_{q>p} n_q x w_q
         (n_q = stops of priority q in this model), so ONE stop of a higher priority
         outweighs ALL lower-priority stops together, and even a P5 stop is worth far more
         than the cost of serving it. strict_priorities=false keeps the older weighted
         scheme (priority_weight[p] x SERVICE_UNIT), where e.g. 11 P3 stops outweigh one P2.
    3.   Contribution margin (only if every stop has a reliable margin): added to the
         service value x10 for small margins, saturating smoothly below 0.4 service unit
         (_margin_bonus) so it breaks ties between stops of the SAME priority but can never
         outrank a higher priority.
         A scenario that multiplies costs (MIN_TRUCKS: fixed x20, trip x5) multiplies the
         drop penalties as much (_drop_penalties), so leaving a stop out never gets cheaper
         than serving it there either.
    4.   Operating cost in real OMR: fixed truck cost (once per truck-day), per-load cost,
         distance cost (cost_per_km + fuel_price / km_per_litre - fuel is counted ONCE),
         driver time cost, overtime.
    5.   Fewer trucks/trips/km fall out of 4 (fixed + distance costs).
    6.   Soft preferences: preferred window deviation and an early-arrival preference for
         high priorities, in OMR per minute.
* Search: parallel cheapest insertion + guided local search with a time limit, then the
  post-solve stage (load_repack): the loads the searches built are re-assigned to trucks and
  departure times exactly (CP-SAT), every plan is re-timed exactly, and each scenario returns
  the best candidate for its own goal. The result is an OPTIMIZED plan (good, feasible), never
  claimed to be a proven optimum.
"""
from __future__ import annotations

import logging
import math
import os
import time
from collections import Counter
from dataclasses import dataclass

from ortools.constraint_solver import pywrapcp, routing_enums_pb2

import feasibility as FZ
import load_repack as LR
from dispatch_models import (
    DAY_MIN,
    DispatchConfig,
    DispatchRequest,
    DispatchResponse,
    DispatchScenario,
    DispatchScenarioName,
    DispatchStop,
    DispatchTruck,
    FeasibilityReport,
    ObjectiveComponents,
    PlannedLoad,
    PlannedStop,
    UnservedStop,
)
from providers import MatrixResult, resolve_matrix

log = logging.getLogger("routeiq.dispatch")

COST_SCALE = 100_000  # 1 OMR = 100,000 objective units
SERVICE_UNIT = 10_000_000_000  # weighted priorities: value of serving a P5 stop (= 100,000 OMR)
MARGIN_WEIGHT = 10  # margin is weighted 10x operating cost ...
MARGIN_CAP = int(SERVICE_UNIT * 0.4)  # ... but can never outweigh one service unit
# Strict priorities: one "weight unit" of service = 1,000 OMR, still far above the cost of
# serving any one stop (so every servable stop is served) but small enough that the strict
# weights of a big day fit in 64-bit integers.
SERVICE_BASE = 100_000_000
# OR-Tools' objective is int64: all drop penalties together stay below this (see _service_values).
PENALTY_LIMIT = 2**62
HORIZON_S = 2 * DAY_MIN * 60
# Worker start-up + matrix pickling + extraction on top of an alternative's solver time limit.
ALT_GRACE_SEC = int(os.environ.get("SOLVER_ALT_GRACE_SEC", "20"))
# RECOMMENDED may never be skipped, so its worker only gets a generous backstop deadline
# (2 x its time limit + this) against a search that never returns.
REC_GRACE_SEC = 60
# Worker start-up + model build + extraction around RECOMMENDED's search, kept free in the budget.
REC_OVERHEAD_SEC = 20
# Whole request (matrix + all scenarios) must answer before the web gives up (600 s): the
# alternatives are skipped rather than overrun it. Env SOLVER_BUDGET_SEC overrides.
SOLVER_BUDGET_SEC = 540
# Post-solve stage (load repack): each CP-SAT solve gets min(CAP, max(MIN, search limit / 2)).
REPACK_CAP_SEC = 15
REPACK_MIN_SEC = 3
# Worker start-up, exact timing of every candidate and pickling around the repack solves.
STAGE_GRACE_SEC = 20
ENGINE = "ortools-routing"


def auto_time_limit(n_stops: int) -> int:
    # A normal NMWC day (~150 stops) stays fast. Big days get much more time: at 300 stops 45 s
    # left feasible P5 stops unserved (search not converged) while 150 s served all of them.
    # Small days are cheap: 20 s instead of 8 s up to 80 stops is insurance against a search
    # stopped before it settled (the synthetic 60-stop days were 5-15% better at 20-30 s).
    if n_stops <= 25:
        return 5
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
    # Soft time preferences (preferred windows, early arrival, overtime, plan continuity). Only
    # the RECOMMENDED search uses them: alternatives answer one question each. (Every returned
    # plan is still TIMED with them afterwards - load_repack.time_plan.)
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
    # Last frozen return: the first new load leaves after it + reload + loading of ITS cases
    # (earliest_depart_s holds the reload part only).
    frozen_return_s: int | None = None

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
        anchor = frozen_return = None
        if frozen:
            anchor = min(f.depart_min for f in frozen)
            frozen_return = max(f.return_min for f in frozen)
            earliest = max(earliest, frozen_return + cfg.reload_min)
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
                frozen_return_s=frozen_return * 60 if frozen_return is not None else None,
            )
        )
    return out


def _approx_gap_s(cfg: DispatchConfig, td: TruckDay) -> int:
    """Turnaround before a truck's next load as the route search sees it: the next load's size
    is unknown there, so loading is costed for 80% of a full truck. The final timing uses the
    exact ``reload_min + loading_min_per_case x cases`` of each load (load_repack)."""
    return int(round((cfg.reload_min + cfg.loading_min_per_case * td.max_cases * 0.8) * 60))


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
    """Weighted priorities (strict_priorities=false): priority_weight[p] x SERVICE_UNIT."""
    w = cfg.priority_weights
    base = int(round(SERVICE_UNIT * (w[s.priority] / w[5])))
    if use_margin and s.margin is not None and s.margin > 0:
        base += min(MARGIN_CAP, int(round(s.margin * COST_SCALE * MARGIN_WEIGHT)))
    return base


def _strict_weights(counts: dict[int, int], with_margin: bool = False) -> dict[int, int]:
    """w_5 = 1, w_p = 1 + sum_{q>p} n_q x w_q: one stop of priority p is worth more than ALL
    lower-priority stops of the day together. With margins every lower stop may carry up to 0.4
    of a unit on top, so each counts as w_q + 1 and margins can never add up past a priority."""
    w = {5: 1}
    for p in (4, 3, 2, 1):
        w[p] = 1 + sum(counts.get(q, 0) * (w[q] + (1 if with_margin else 0)) for q in range(p + 1, 6))
    return w


def _service_values(stops: list[DispatchStop], cfg: DispatchConfig, use_margin: bool) -> tuple[list[int], list[str]]:
    """Objective units lost when each stop is left unserved (the drop penalty), plus warnings.

    Strict: SERVICE_BASE x w_p (see _strict_weights). The weights grow like the product of the
    per-priority counts; all penalties together must stay below PENALTY_LIMIT (int64 objective).
    Beyond it the base is scaled down (to no less than 100 OMR per weight unit, so service still
    dominates cost), and past that the weights are capped: priorities are then no longer strict
    between the capped levels, which is logged and reported. Real NMWC days (a few hundred stops)
    are orders of magnitude below the limit (400 stops with margins: ~7e17 of 4.6e18)."""
    if not cfg.strict_priorities:
        return [_stop_value(s, cfg, use_margin) for s in stops], []
    counts = Counter(s.priority for s in stops)
    w = _strict_weights(counts, use_margin)
    total = sum(w[s.priority] for s in stops) + (len(stops) if use_margin else 0)
    base, warnings = SERVICE_BASE, []
    if total * base > PENALTY_LIMIT:
        base = max(100 * COST_SCALE, PENALTY_LIMIT // max(1, total))
        if total * base > PENALTY_LIMIT:
            cap = max(1, PENALTY_LIMIT // (base * max(1, len(stops)) * 2))
            w = {p: min(v, cap - (p - 1)) for p, v in w.items()}  # P1 > P2 > ... still holds
            warnings.append(
                "This day has too many orders to rank priorities strictly; higher priorities still weigh "
                "much more, but a very large number of lower-priority orders can outweigh one higher."
            )
            log.warning("strict priority weights capped at %d (base %d, %d stops)", cap, base, len(stops))
        else:
            log.warning("strict priority base scaled to %d units (%d stops)", base, len(stops))
    margin_cap = int(base * 0.4)
    out = []
    for s in stops:
        v = base * w[s.priority]
        if use_margin and s.margin is not None and s.margin > 0:
            v += _margin_bonus(s.margin, margin_cap)
        out.append(v)
    return out, warnings


def _margin_bonus(margin: float, cap: int) -> int:
    """Margin tie-break between stops of the SAME priority (strict priorities). Worth 10x the
    operating cost for small margins (MARGIN_WEIGHT, as in the weighted scheme), then saturating
    smoothly towards ``cap`` (0.4 unit) without ever flattening: a linear bonus capped at 0.4 of the
    1,000 OMR unit stopped telling margins apart above 40 OMR, so a 300 OMR order tied with a 50 OMR
    one. Here 50 -> ~222 OMR and 300 -> ~353 OMR of objective; 4,000 vs 4,001 OMR still differ."""
    m = margin * COST_SCALE * MARGIN_WEIGHT
    return int(round(cap * m / (m + cap)))


def _drop_penalties(values: list[int], w: ScenarioWeights) -> list[int]:
    """Drop penalties of one scenario's search. Service values are sized against real money (a
    strict unit is 1,000 OMR, far above the cost of serving one stop); a scenario that multiplies
    the costs (MIN_TRUCKS: fixed x20, trip x5) multiplies them as much, or dropping a stop that
    needs its own truck (fixed 50+ OMR x 20 > 1,000) became cheaper than serving it. MIN_DISTANCE
    prices metres, which a unit outweighs anyway. The total stays below PENALTY_LIMIT."""
    mult = 1 if w.pure_distance else int(math.ceil(max(1.0, w.fixed, w.trip, w.distance, w.time)))
    mult = max(1, min(mult, PENALTY_LIMIT // max(1, sum(values))))
    return [v * mult for v in values]


def _repair_weights(stops: list[DispatchStop], ks: set[int], cfg: DispatchConfig) -> dict[int, int]:
    """Small weights that rank the stops ``ks`` the way their service values do (the repack's
    phase 1 maximises them; the full strict values would not fit CP-SAT's objective)."""
    if not ks:
        return {}
    if cfg.strict_priorities:
        w = _strict_weights(Counter(stops[k].priority for k in ks))
        return {k: w[stops[k].priority] for k in ks}
    pw = cfg.priority_weights
    return {k: max(1, int(round(100 * pw[stops[k].priority] / pw[5]))) for k in ks}


def _km_rate_omr(t: DispatchTruck, cfg: DispatchConfig) -> float:
    """OMR per km for this truck: non-fuel variable cost + fuel (fuel counted exactly once)."""
    rate = t.cost_per_km
    if t.km_per_litre and cfg.fuel_price_per_litre > 0:
        rate += cfg.fuel_price_per_litre / t.km_per_litre
    return rate


def _pricing(name: str, req: DispatchRequest, tds: list[TruckDay], stops: list[DispatchStop]) -> LR.Pricing:
    """A scenario's objective prices for the post-solve stage, in objective units and with the
    same weights as its OR-Tools model (arc, fixed, span, soft-bound costs). One deliberate
    difference: overtime counts from the truck's FIRST ACTUAL departure, exactly as the plan
    reports it (the routing model can only bound the return time from the shift start)."""
    cfg = req.config
    w = SCENARIOS[name]
    trucks = {
        td.idx: LR.TruckPrice(
            fixed=int(round(td.truck.fixed_cost * w.fixed * COST_SCALE)) if td.n_frozen == 0 else 0,
            trip=int(round(td.truck.trip_cost * w.trip * COST_SCALE)),
            per_m=_km_rate_omr(td.truck, cfg) * w.distance * COST_SCALE / 1000.0,
        )
        for td in tds if td.usable
    }
    if not w.soft_prefs:
        return LR.Pricing(trucks=trucks, span=int(round(cfg.driver_cost_per_hour * w.time * COST_SCALE / 3600.0)))
    continuity = cfg.change_penalty_per_stop > 0 and any(s.previous_truck_id for s in stops)
    return LR.Pricing(
        trucks=trucks,
        span=int(round(cfg.driver_cost_per_hour * w.time * COST_SCALE / 3600.0)),
        overtime=int(round(cfg.overtime_cost_per_hour * COST_SCALE / 3600.0)) if cfg.overtime_after_min is not None else 0,
        overtime_after_s=cfg.overtime_after_min * 60 if cfg.overtime_after_min is not None else None,
        pref=int(round(cfg.pref_window_penalty_per_min * COST_SCALE / 60.0)),
        early={p: int(round(v * COST_SCALE / 60.0)) for p, v in cfg.early_preference_per_min.items()},
        shift_start_s=cfg.shift_start_min * 60,
        change=int(round(cfg.change_penalty_per_stop * COST_SCALE)) if continuity else 0,
    )


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
    values, value_warnings = _service_values(stops, cfg, use_margin)
    penalties = _drop_penalties(values, w)

    manager = pywrapcp.RoutingIndexManager(N, nv, 0)
    routing = pywrapcp.RoutingModel(manager)

    locs = [m.loc(i) for i in range(N)]
    service_s = [0] * N
    for k, s in enumerate(stops):
        service_s[k + 1] = s.service_min * 60
    for r, v in enumerate(reload_owner):
        service_s[1 + len(stops) + r] = _approx_gap_s(cfg, vehicles[v])

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
        routing.AddDisjunction([idx], penalties[k])

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
        first = td.earliest_depart_s
        if td.frozen_return_s is not None:  # frozen loads: + loading of the first new load
            first = max(first, td.frozen_return_s + _approx_gap_s(cfg, td))
        tdim.CumulVar(start).SetRange(min(first, td.latest_return_s), td.latest_return_s)
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
    if warm_start:
        initial = _initial_assignment(routing, manager, m, stops, warm_start, params)
        if initial is not None:
            assignment = routing.SolveFromAssignmentWithParameters(initial, params)
        if assignment is None:
            # Rare (seen once in the benchmark: ROUTING_FAIL after 0.25 s): solve cold instead,
            # in the time that is left.
            log.info("scenario %s: warm start gave no solution; solving cold", name)
            params.time_limit.seconds = max(1, int(time_limit - (time.perf_counter() - started)))
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

    return _extract(name, req, stops, tds, m, manager, routing, assignment, mx,
                    values, use_margin, pre_drops, status_name, elapsed, time_limit, service_s, value_warnings)


def _extract(name, req, stops, tds, m: _Model, manager, routing, assignment, mx, values, use_margin,
             pre_drops, status_name, elapsed, time_limit, service_s, value_warnings) -> DispatchScenario:
    return _build_scenario(
        name, req, stops, tds, mx, _timed_from_assignment(m, manager, routing, assignment, mx, service_s),
        values, use_margin, pre_drops, solver_status=status_name, elapsed=elapsed, time_limit=time_limit,
        objective_value=int(assignment.ObjectiveValue()), extra_warnings=value_warnings, exact_timing=False,
    )


def _timed_from_assignment(m: _Model, manager, routing, assignment, mx, service_s) -> LR.TimedPlan:
    """The search's timetable: each truck route split into loads at its reload visits."""
    tdim = routing.GetDimensionOrDie("Time")
    out: LR.TimedPlan = {}
    for v, td in enumerate(m.vehicles):
        if not routing.IsVehicleUsed(assignment, v):
            continue
        trips: list[list[tuple[int, int]]] = [[]]  # (node, cumul_s) per stop
        ready = [assignment.Value(tdim.CumulVar(routing.Start(v)))]
        idx = assignment.Value(routing.NextVar(routing.Start(v)))
        while not routing.IsEnd(idx):
            node = manager.IndexToNode(idx)
            cum = assignment.Value(tdim.CumulVar(idx))
            if m.is_reload(node):
                trips.append([])
                ready.append(cum + service_s[node])
            else:
                trips[-1].append((node, cum))
            idx = assignment.Value(routing.NextVar(idx))
        loads: list[LR.TimedLoad] = []
        for trip, earliest in zip(trips, ready):
            if not trip:
                continue  # empty load (consecutive reloads) - not a real load
            # Leave just in time for the first delivery (no pointless waiting at stop 1), but
            # never before the truck is ready.
            depart = max(earliest, trip[0][1] - mx.duration_s[0][m.loc(trip[0][0])])
            prev, t, starts = 0, depart, []
            for node, cum in trip:
                start = max(cum, t + mx.duration_s[prev][node])
                starts.append(start)
                t = start + service_s[node]
                prev = node
            loads.append(LR.TimedLoad(stops=tuple(node - 1 for node, _ in trip), depart_s=depart,
                                      starts=tuple(starts), return_s=t + mx.duration_s[prev][0]))
        if loads:
            out[td.idx] = loads
    return out


def _min_of(seconds: int | float) -> int:
    """Seconds -> whole minutes, halves rounded up (Python's round() rounds halves to even, so a
    stop starting at hh:mm:30 showed a 25-min unload as 24 or 26 min)."""
    return int(math.floor(seconds / 60.0 + 0.5))


def _build_scenario(name, req: DispatchRequest, stops: list[DispatchStop], tds: list[TruckDay], mx: MatrixResult,
                    timed: LR.TimedPlan, values: list[int], use_margin: bool, pre_drops: list[UnservedStop], *,
                    solver_status: str, elapsed: float, time_limit: int, objective_value: int,
                    extra_warnings: list[str] | None = None, timing_drops: set[int] | None = None,
                    exact_timing: bool = True) -> DispatchScenario:
    """Loads, stop times, costs, unserved reasons and totals of a timed plan. The ONE place a
    plan becomes a scenario: the search's plans and the post-solve plans are reported alike, and
    every scenario gets its independent feasibility report here (feasibility.check_scenario).

    timing_drops: stops the route search planned that this plan leaves out because the search's
    loads did not fit the day once timed with the exact loading time (see _post_solve).
    exact_timing: the times come from load_repack.time_plan (the exact loading time between loads);
    False for the route search's own times (80% of a full truck per turnaround).

    The times are reported as the timing gave them: a service start earlier than the drive from
    the previous stop allows is NOT moved later here (that hid a timing error and could push the
    return past the next load's departure unchecked); the feasibility report flags it (TRAVEL)."""
    cfg = req.config
    timing_drops = timing_drops or set()
    loads: list[PlannedLoad] = []
    served: set[int] = set()
    comp = dict(fixed=0.0, distance=0.0, fuel=0.0, time=0.0, overtime=0.0, window=0.0)

    for idx in sorted(timed):
        td = tds[idx]
        t = td.truck
        load_no = td.n_frozen
        for tl in timed[idx]:
            load_no += 1
            depart_s = tl.depart_s
            prev_node, prev_dep = 0, depart_s
            cum_m, cases, kg, seq = 0, 0, 0.0, 0
            stops_out: list[PlannedStop] = []
            for k, start_s in zip(tl.stops, tl.starts):
                s = stops[k]
                node = k + 1
                served.add(k)
                leg_m = mx.distance_m[prev_node][node]
                leg_s = mx.duration_s[prev_node][node]
                arrival_s = prev_dep + leg_s
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
                # Rounded once: the shown unloading time (departure - start) is exactly the
                # service time that was sent, and the wait is exactly start - arrival.
                arrival_min, start_min = _min_of(arrival_s), _min_of(start_s)
                stops_out.append(PlannedStop(
                    sequence=seq, stop_id=s.stop_id, order_ids=list(s.order_ids), customer_id=s.customer_id,
                    arrival_min=arrival_min, service_start_min=start_min,
                    departure_min=start_min + s.service_min, wait_min=max(0, start_min - arrival_min),
                    leg_km=round(leg_m / 1000.0, 2), cum_km=round(cum_m / 1000.0, 2), leg_min=int(round(leg_s / 60)),
                    cases=s.demand_cases, kg=round(s.demand_kg, 1),
                    hard_window_ok=hs <= start_s <= he, pref_window_ok=pref_ok,
                ))
                prev_node, prev_dep = node, dep_s
            back_m = mx.distance_m[prev_node][0]
            back_s = mx.duration_s[prev_node][0]
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
            depart_min, return_min = _min_of(depart_s), _min_of(return_s)
            loads.append(PlannedLoad(
                truck_id=t.id, load_no=load_no, depart_min=depart_min,
                return_min=return_min, distance_km=round(km, 2), duration_min=return_min - depart_min,
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
    open_drops = 0
    left_cases = 0
    for k, s in enumerate(stops):
        if k in served:
            continue
        unserved_penalty += values[k] / COST_SCALE
        left_cases += s.demand_cases
        if s.late:
            unserved.append(_unserved(s, "LATE_ORDER_NO_CAPACITY",
                                      f"Late order (P{s.priority}): no unlocked truck/load had capacity or time left. "
                                      "Locked and dispatched loads were not changed."))
        elif k in timing_drops:
            unserved.append(_unserved(s, "SOLVER_DROPPED_LOW_PRIORITY",
                                      f"Not planned: once every load was timed with the loading time between loads "
                                      f"({cfg.reload_min} min + {cfg.loading_min_per_case:g} min per case), the route search's "
                                      f"loads no longer fitted the truck days and this P{s.priority} stop was left out "
                                      "(lowest priorities first). Re-plan, add a truck, or check the loading time."))
        elif shortage:
            unserved.append(_unserved(s, "SOLVER_DROPPED_LOW_PRIORITY",
                                      f"Fleet capacity shortage: {demand_cases} cases requested vs {total_cap_cases} "
                                      f"cases across all available loads. Lower priorities are left out first (this is P{s.priority})."))
        else:
            # Never claimed impossible: no prefilter ruled this stop out, and the search is a
            # time-limited heuristic (it always ends on its limit, whatever status it reports).
            open_drops += 1
            unserved.append(_unserved(s, "SOLVER_DROPPED_LOW_PRIORITY",
                                      f"Not planned: the optimizer found no truck, trip or time slot for this P{s.priority} "
                                      "stop within its time limit. Re-plan to search again, add a truck, or raise the "
                                      "loads-per-truck limit."))

    margin_served = round(sum(stops[k].margin or 0 for k in served), 3) if use_margin else None
    code_of = {t.id: (t.code or t.id) for t in req.trucks}
    loads.sort(key=lambda l: (code_of[l.truck_id], l.load_no))
    util = [ld.utilization_pct for ld in loads]
    warnings = list(mx.warnings) + list(extra_warnings or [])
    if open_drops:
        warnings.append(
            f"{open_drops} stop(s) could not be placed by the optimizer within its time limit; no check proves "
            "they are impossible. Re-plan to search again, add a truck, or raise the loads-per-truck limit."
        )
    short = demand_cases - total_cap_cases
    biggest_left = max((s.demand_cases for k, s in enumerate(stops) if k not in served), default=0)
    if shortage and left_cases > short + biggest_left:
        # The shortage explains leaving out about `short` cases (plus one order that does not
        # split), not everything: the rest did not fit by time, hours or the search's limit.
        warnings.append(
            f"The trucks are {short} cases short today, but {left_cases} cases are unserved: more than the shortage "
            "alone explains. Re-plan to search again, add a truck, or raise the loads-per-truck limit."
        )
    sc = DispatchScenario(
        name=name, status="OPTIMIZED", solver_status=solver_status, solver_time_sec=round(elapsed, 2),
        time_limit_sec=time_limit, objective_value=int(objective_value),
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
    exact = exact_timing or cfg.loading_min_per_case == 0  # without loading per case the search's turnaround is exact
    sc.feasibility = FZ.safe_check(req, sc, solvable=stops, mx=mx, timing="EXACT" if exact else "ESTIMATED")
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
        # No load, so no timetable that could break a rule.
        feasibility=FeasibilityReport(status="VERIFIED", timing="EXACT", checked_at_version=FZ.CHECK_VERSION),
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
    started = time.monotonic()
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
    budget = int(os.environ.get("SOLVER_BUDGET_SEC", SOLVER_BUDGET_SEC))
    scenarios = _run_scenarios(list(cfg.scenarios), req, solvable, tds, mx, time_limit, drops, started + budget)
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


def _initial_assignment(routing, manager, m: _Model, stops: list[DispatchStop], loads: list[PlannedLoad], params):
    """Rebuild a routing assignment from an existing plan (stops + reload visits per truck) so
    an alternative scenario starts from the recommended plan and can only improve its own goal.

    Only the Next variables are set (CloseModelWithParameters + RoutesToAssignment); the search
    then derives times itself. ReadAssignmentFromRoutes, used before, restores the cumul values
    too and could stall for over 100 s under time-dimension costs (preferred windows, overtime).
    Returns None when the plan cannot be loaded (the caller solves cold)."""
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
        routes.append([manager.NodeToIndex(n) for n in route])
    try:
        routing.CloseModelWithParameters(params)
        initial = routing.solver().Assignment()
        if not routing.RoutesToAssignment(routes, True, True, initial):
            return None
        return initial
    except Exception:  # noqa: BLE001
        return None


def _scenario_worker(args) -> DispatchScenario:
    # Test hooks: an OR-Tools call that never returns, one that raises, and a worker process
    # killed mid-solve (out of memory). See the deadline / failure tests.
    if os.environ.get("ROUTEIQ_TEST_HANG_SCENARIO") == args[0]:
        time.sleep(3600)
    if os.environ.get("ROUTEIQ_TEST_FAIL_SCENARIO") == args[0]:
        raise RuntimeError("test hook: scenario failed")
    if os.environ.get("ROUTEIQ_TEST_KILL_SCENARIO") == args[0]:
        os._exit(137)
    return _solve_scenario(*args)


class SolveAborted(RuntimeError):
    """The recommended plan could not be computed (worker died or ran out of time)."""


# ---------------------------------------------------------------------------------------------
# Worker processes (review L23)
# ---------------------------------------------------------------------------------------------

# multiprocessing.Pool silently replaces a dead worker (out of memory ...) and leaves its task
# pending forever. The only way to see a death is Pool's private list of worker processes; its
# name lives here so a test can take it away (an interpreter upgrade could): the waits then fall
# back to their deadlines, with one log warning, instead of failing every solve.
_POOL_ATTR = "_pool"
# In a worker process: where each task reports "started in process <pid>" (see _tracked).
_BEACON = None


def _worker_init(beacon) -> None:
    global _BEACON
    _BEACON = beacon


def _tracked(token: str, fn, arg):
    """Run ``fn(arg)`` in a pool worker after reporting which process runs it, so a dead worker
    loses only its own task (its siblings keep running)."""
    if _BEACON is not None:
        try:
            _BEACON.put((token, os.getpid()))
        except Exception:  # noqa: BLE001 - death detection then falls back to the deadline
            pass
    return fn(arg)


class _Workers:
    """A spawn Pool with what the waits need, without Pool's private attributes where possible:
    its size (stored here, not read from Pool._processes) and which worker process runs which task
    (each task reports its pid when it starts). Worker pids come from Pool's private worker list;
    when that is gone, pids() is None and deaths are only seen at the deadline."""

    def __init__(self, size: int):
        import multiprocessing as mp

        ctx = mp.get_context("spawn")
        self.size = max(1, int(size))
        self._beacon = ctx.SimpleQueue()
        self.pool = ctx.Pool(processes=self.size, initializer=_worker_init, initargs=(self._beacon,))
        self._pid_of: dict[str, int] = {}
        self._seq = 0
        self._warned = False

    def submit(self, fn, arg, name: str):
        """Start ``fn(arg)`` in a worker; returns (token, AsyncResult)."""
        self._seq += 1
        token = f"{name}#{self._seq}"
        return token, self.pool.apply_async(_tracked, (token, fn, arg))

    def started(self) -> dict[str, int]:
        """token -> pid of every task that has started so far."""
        try:
            while not self._beacon.empty():
                token, pid = self._beacon.get()
                self._pid_of[token] = pid
        except Exception:  # noqa: BLE001
            pass
        return self._pid_of

    def pids(self) -> frozenset[int] | None:
        try:
            return frozenset(p.pid for p in getattr(self.pool, _POOL_ATTR))
        except (AttributeError, TypeError):
            if not self._warned:
                self._warned = True
                log.warning("worker pool internals unavailable: a dead worker is only noticed at its deadline")
            return None

    def close(self) -> None:
        self.pool.terminate()  # stops any task still running past its deadline
        self.pool.join()


def _await_all(workers: _Workers, jobs: dict[str, tuple[str, object]], deadline: float) -> dict[str, tuple[str, object]]:
    """Wait for several pool tasks (name -> (token, AsyncResult)), in completion order, until
    ``deadline``. Returns name -> ("ok", value) | ("error", exception) | ("lost", None) (its worker
    process died) | ("timeout", None). A dead worker loses only the task it was running: a sibling
    that is still computing is never aborted because another worker died (review L23). A task
    whose worker died before it could report its start is only noticed at the deadline."""
    out: dict[str, tuple[str, object]] = {}
    pending = dict(jobs)
    base = workers.pids()
    while pending:
        for name, (_tok, fut) in list(pending.items()):
            if fut.ready():  # type: ignore[attr-defined]
                try:
                    out[name] = ("ok", fut.get())  # type: ignore[attr-defined]
                except Exception as exc:  # noqa: BLE001
                    out[name] = ("error", exc)
                del pending[name]
        if not pending:
            break
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            for name in pending:
                out[name] = ("timeout", None)
            break
        next(iter(pending.values()))[1].wait(min(0.5, remaining))  # type: ignore[attr-defined]
        now = workers.pids()
        if base is None or now is None or now == base:
            continue
        dead = base - now
        started = workers.started()
        for name, (tok, fut) in list(pending.items()):
            if not fut.ready() and started.get(tok) in dead:  # type: ignore[attr-defined]
                out[name] = ("lost", None)
                del pending[name]
        base = now
    return out


def _await_worker(workers: _Workers, job: tuple[str, object], deadline: float, what: str):
    """Wait for one pool task; fail fast when ITS worker process dies (e.g. out of memory)."""
    kind, value = _await_all(workers, {what: job}, deadline)[what]
    if kind == "ok":
        return value
    if kind == "error":
        raise value  # type: ignore[misc]
    if kind == "lost":
        raise SolveAborted(f"The optimizer process stopped unexpectedly while computing the {what} (out of memory?). Try again.")
    raise SolveAborted(f"The optimizer did not finish the {what} in time. Try again, or plan fewer stops at once.")


def _run_scenarios(names, req, solvable, tds, mx, time_limit, drops, budget_end: float | None = None) -> list[DispatchScenario]:
    """RECOMMENDED is solved first with the full time budget. Alternatives are then warm-started
    from it with half the budget. Finally the post-solve stage (_post_solve) re-assigns the
    searches' loads and picks each scenario's plan from all of them, so unless it serves more,
    MIN_DISTANCE never drives more km and MIN_TRUCKS never uses more trucks than the
    recommendation.

    Every scenario runs in a worker process. OR-Tools holds the GIL for the whole search, so a
    solve inside the API process froze it completely - /health, /route-geometry and every other
    request - for up to four minutes; threads would not run scenarios concurrently either.

    Safety net: alternatives are optional. Each worker gets a hard wall-clock deadline; a worker
    that overruns (OR-Tools occasionally ignores its own time limit inside internal restores),
    fails, dies or would run past the request's time budget is terminated / not started and the
    alternative is skipped with a warning. The RECOMMENDED plan is never lost because of an
    alternative. Every returned scenario carries its feasibility report (_build_scenario).

    SOLVER_PARALLEL=0 solves everything in-process WITHOUT any deadline or time budget: for local
    development and tests only (main.py logs a warning at startup when it is set).
    """
    if budget_end is None:
        budget_end = time.monotonic() + SOLVER_BUDGET_SEC
    results: dict[str, DispatchScenario] = {}
    alt_names = [n for n in names if n != "RECOMMENDED"]
    workers: _Workers | None = None
    if solvable and os.environ.get("SOLVER_PARALLEL", "1") != "0":
        try:
            # One process per alternative (at most two), even on 1-2 vCPU servers: with a shared
            # worker a stuck alternative starved the next one, which then hit the same deadline
            # without ever starting. OR-Tools limits are wall-clock, so sharing a core only
            # lowers quality, never the deadline. RECOMMENDED runs first in one of them, so the
            # alternatives' workers have finished starting by the time they are needed.
            workers = _Workers(max(1, len(alt_names)))
        except Exception as exc:  # noqa: BLE001 - e.g. restricted environments without processes
            log.warning("worker processes unavailable (%s); solving in-process", exc)
    skipped: list[str] = []
    staged: set[str] = set()  # scenarios the post-solve stage replaced by an exactly timed plan
    try:
        warm = None
        if "RECOMMENDED" in names:
            # A slow road matrix eats into the budget: shorten the search rather than overrun it.
            rec_limit = max(1, min(time_limit, int(budget_end - time.monotonic()) - REC_OVERHEAD_SEC))
            job = ("RECOMMENDED", req, solvable, tds, mx, rec_limit, drops)
            if workers is None:
                results["RECOMMENDED"] = _scenario_worker(job)
            else:
                deadline = min(time.monotonic() + rec_limit * 2 + REC_GRACE_SEC, budget_end)
                results["RECOMMENDED"] = _await_worker(workers, workers.submit(_scenario_worker, job, "RECOMMENDED"),
                                                       deadline, "recommended plan")
            warm = results["RECOMMENDED"].loads or None
        alt_limit = max(2, time_limit // 2) if warm else time_limit
        grace = int(os.environ.get("SOLVER_ALT_GRACE_SEC", ALT_GRACE_SEC))
        if alt_names:
            # Never run past the request budget: shorten the alternatives, or skip them.
            room = int(budget_end - time.monotonic()) - grace
            if room < 2:
                skipped.extend(alt_names)
                alt_names = []
                log.warning("time budget used up by the recommended plan; alternatives skipped")
            else:
                alt_limit = min(alt_limit, room)
        jobs = [(n, req, solvable, tds, mx, alt_limit, drops, warm) for n in alt_names]
        overran = False
        if jobs and workers is not None:
            deadline = time.monotonic() + alt_limit + grace
            done = _await_all(workers, {j[0]: workers.submit(_scenario_worker, j, j[0]) for j in jobs}, deadline)
            for name in alt_names:
                # A dead worker or a failing one only loses this alternative - it is never solved
                # again in-process.
                kind, value = done[name]
                if kind == "ok":
                    results[value.name] = value  # type: ignore[union-attr]
                    continue
                skipped.append(name)
                if kind == "timeout":
                    overran = True
                    log.warning("alternative %s exceeded %ss; skipped", name, alt_limit + grace)
                else:
                    log.warning("alternative %s %s (%s); skipped", name, "lost its worker" if kind == "lost" else "failed", value)
        else:
            for j in jobs:
                try:
                    results[j[0]] = _scenario_worker(j)
                except Exception as exc:  # noqa: BLE001 - an alternative never costs the recommended plan
                    skipped.append(j[0])
                    log.warning("alternative %s failed (%s); skipped", j[0], exc)
        if overran and workers is not None:
            # A skipped alternative still runs in its worker (a stuck OR-Tools call does not stop
            # on request): the post-solve jobs would queue behind it and time out, and RECOMMENDED
            # would lose its load re-check. Give the stage fresh workers.
            workers.close()
            workers = None
            try:
                workers = _Workers(len(_stage_goals(results)))
            except Exception as exc:  # noqa: BLE001
                log.warning("worker processes unavailable (%s); load re-check in-process", exc)
        try:
            _post_solve(req, solvable, tds, mx, time_limit, drops, results, workers, budget_end, staged)
        except Exception as exc:  # noqa: BLE001 - the search's own plans stay valid
            log.exception("post-solve stage failed: %s", exc)
            # Only the scenarios the stage had not replaced yet: one it already re-timed exactly
            # keeps its plan and gets no false "not re-checked" note (the note used to be inferred
            # from warning texts, review: exact-timing status never exposed per scenario).
            _retime_fallback(req, solvable, tds, mx, drops, results, "internal error", skip=staged)
    finally:
        if workers is not None:
            workers.close()
    rec = results.get("RECOMMENDED")
    if skipped and rec:
        rec.warnings.append(
            f"Alternative plan(s) {', '.join(skipped)} were skipped (out of time, or they failed); the recommended plan is complete."
        )
    if rec:
        # Service comes first. If the (time-limited) recommendation left out stops that an
        # alternative serves, say so - the dispatcher decides; nothing switches automatically.
        # Only alternatives whose timetable passed the independent check are offered: a plan that
        # breaks the loading time between loads (or any other hard rule) serves more only on paper.
        for alt in results.values():
            if alt is rec or alt.status != "OPTIMIZED" or alt.feasibility is None or alt.feasibility.status != "VERIFIED":
                continue
            gained = len(rec.unserved) - len(alt.unserved)
            if gained > 0:
                rec.warnings.append(
                    f"The {alt.name.replace('_', ' ')} option serves {gained} more stop(s) than this plan. "
                    "Review it under Plan options and choose 'Use instead' if it suits."
                )
    return [results[n] for n in names if n in results]


# ---------------------------------------------------------------------------------------------
# Post-solve stage: load repack + candidate selection (see load_repack)
# ---------------------------------------------------------------------------------------------

# Each scenario returns the best candidate for its OWN goal. Service comes first everywhere
# (priority value of the unserved stops), then:
_GOALS = {
    # the RECOMMENDED objective (operating cost + preferred hours, early arrival, continuity)
    "RECOMMENDED": lambda sc: (sc.unserved, sc.cost),
    # fewest trucks, then loads, then operating cost (like its search, it ignores preferences)
    "MIN_TRUCKS": lambda sc: (sc.unserved, sc.trucks, sc.loads, sc.operating, sc.cost),
    # fewest km, then the RECOMMENDED objective
    "MIN_DISTANCE": lambda sc: (sc.unserved, sc.metres, sc.cost),
}


def _stage_worker(job: dict) -> tuple[list[LR.Candidate], list[str]]:
    # Test hooks: a stage that raises, one that never returns, and one goal's worker process
    # killed mid-stage (out of memory; see the fallback and sibling-death tests).
    if os.environ.get("ROUTEIQ_TEST_FAIL_REPACK"):
        raise RuntimeError("test hook: post-solve stage failed")
    if os.environ.get("ROUTEIQ_TEST_HANG_REPACK"):
        time.sleep(3600)
    if os.environ.get("ROUTEIQ_TEST_KILL_REPACK") == job.get("goal"):
        os._exit(137)
    return LR.build_candidates(**job)


def _timed_from_scenario(sc: DispatchScenario, stop_idx: dict[str, int], truck_idx: dict[str, int]) -> LR.TimedPlan:
    out: LR.TimedPlan = {}
    for ld in sorted(sc.loads, key=lambda l: (l.truck_id, l.load_no)):
        out.setdefault(truck_idx[ld.truck_id], []).append(LR.TimedLoad(
            stops=tuple(stop_idx[st.stop_id] for st in ld.stops), depart_s=ld.depart_min * 60,
            starts=tuple(st.service_start_min * 60 for st in ld.stops), return_s=ld.return_min * 60))
    return out


def _stage_goals(results: dict[str, DispatchScenario]) -> list[str]:
    """The post-solve stage's jobs: RECOMMENDED's prices always (it also times every raw plan),
    MIN_TRUCKS' when that scenario has a plan. One worker process each."""
    return ["RECOMMENDED"] + (["MIN_TRUCKS"] if "MIN_TRUCKS" in results and results["MIN_TRUCKS"].status == "OPTIMIZED" else [])


@dataclass
class _StageCtx:
    """What the post-solve stage and its fallback share about one request."""

    req: DispatchRequest
    solvable: list[DispatchStop]
    tds: list[TruckDay]
    mx: MatrixResult
    drops: list[UnservedStop]
    values: list[int]
    value_warnings: list[str]
    use_margin: bool
    stop_idx: dict[str, int]
    truck_idx: dict[str, int]
    day: LR.Day
    rec_pricing: LR.Pricing


def _stage_ctx(req: DispatchRequest, solvable: list[DispatchStop], tds: list[TruckDay], mx: MatrixResult,
               drops: list[UnservedStop]) -> _StageCtx:
    cfg = req.config
    use_margin = cfg.use_margin and all(s.margin is not None for s in solvable)
    values, value_warnings = _service_values(solvable, cfg, use_margin)
    day = LR.Day(stops=solvable, trucks=[td for td in tds if td.usable], D=mx.distance_m, T=mx.duration_s,
                 shift_max_s=cfg.shift_max_min * 60, reload_s=cfg.reload_min * 60,
                 loading_s_per_case=cfg.loading_min_per_case * 60, values=values)
    return _StageCtx(req=req, solvable=solvable, tds=tds, mx=mx, drops=drops, values=values, value_warnings=value_warnings,
                     use_margin=use_margin, stop_idx={s.stop_id: k for k, s in enumerate(solvable)},
                     truck_idx={td.truck.id: td.idx for td in tds}, day=day,
                     rec_pricing=_pricing("RECOMMENDED", req, tds, solvable))


def _retime(ctx: _StageCtx, name: str, sc: DispatchScenario) -> DispatchScenario | None:
    """The safety net when the post-solve stage did not re-check a plan (out of time, a failed or
    lost worker, an internal error): the SAME loads, re-timed exactly with the loading time between
    loads (load_repack.time_plan: one small LP per truck, milliseconds, in-process). None when no
    timetable keeps every hard rule with these loads."""
    try:
        timed = LR.time_plan(ctx.day, LR.plan_of(_timed_from_scenario(sc, ctx.stop_idx, ctx.truck_idx)), ctx.rec_pricing)
    except Exception as exc:  # noqa: BLE001 - the raw plan stays, flagged by its feasibility report
        log.warning("re-timing %s failed: %s", name, exc)
        return None
    if timed is None:
        return None
    return _build_scenario(
        name, ctx.req, ctx.solvable, ctx.tds, ctx.mx, timed, ctx.values, ctx.use_margin, ctx.drops,
        solver_status=sc.solver_status, elapsed=sc.solver_time_sec, time_limit=sc.time_limit_sec,
        objective_value=LR.score(ctx.day, ctx.rec_pricing, timed).objective, extra_warnings=ctx.value_warnings,
        exact_timing=True,
    )


def _retime_fallback(req: DispatchRequest, solvable: list[DispatchStop], tds: list[TruckDay], mx: MatrixResult,
                     drops: list[UnservedStop], results: dict[str, DispatchScenario], why: str,
                     skip: set[str] | None = None, ctx: _StageCtx | None = None) -> None:
    """The post-solve stage did not check these plans: say so, and re-time each one exactly
    (_retime). A plan that cannot be re-timed stays as the route search found it; its feasibility
    report says what it breaks (VIOLATED), so the web never lets it be locked or dispatched."""
    skip = skip or set()
    raw = {n: sc for n, sc in results.items() if sc.status == "OPTIMIZED" and n not in skip}
    if not raw or not solvable:
        return
    cfg = req.config
    msg = f"Loads were not re-checked for fewer trucks ({why}); this is the route search result as found."
    try:
        ctx = ctx or _stage_ctx(req, solvable, tds, mx, drops)
    except Exception as exc:  # noqa: BLE001
        log.warning("safety net unavailable: %s", exc)
        ctx = None
    for name, sc in raw.items():
        if cfg.loading_min_per_case > 0 and ctx is not None and (sc.feasibility is None or sc.feasibility.timing != "EXACT"):
            new = _retime(ctx, name, sc)
            if new is not None:
                new.warnings.append(msg + " Departure times were re-timed exactly with the loading time between loads.")
                results[name] = new
                continue
            sc.warnings.append(msg + " Departure times use an estimated loading time between loads and could not be re-timed "
                                     "exactly: check the timetable before dispatching, or re-plan.")
            continue
        sc.warnings.append(msg)


def _post_solve(req: DispatchRequest, solvable: list[DispatchStop], tds: list[TruckDay], mx: MatrixResult,
                time_limit: int, drops: list[UnservedStop], results: dict[str, DispatchScenario], pool,
                budget_end: float, done: set[str] | None = None) -> None:
    """Replace each OPTIMIZED scenario in ``results`` by the best candidate for its goal.

    Candidates = every raw scenario plan (re-timed exactly) + its repacks: whole loads
    re-assigned to trucks and departure times by CP-SAT, for RECOMMENDED's prices (and for
    MIN_TRUCKS' when that scenario was asked for), with drop repair (stops a plan left out enter
    as optional one-stop loads; on fleet-shortage days too - phase 1 of the repack maximises the
    strict priority value, which is the shortage ladder). All are scored on the one RECOMMENDED
    objective (load_repack.score). A scenario never serves less, by priority value, than its own
    raw plan - unless that plan breaks the exact loading time between loads and nothing serving
    as much fits: then it gets the fitting candidate that keeps the most priority value, and the
    stops it loses are reported as left out for loading time. Runs in the worker pool (CP-SAT and
    the LPs hold the GIL; the API must keep answering) under a deadline inside the request budget.
    ``pool``: a _Workers, or None to run in-process.

    When the stage cannot run or check a plan (out of time, its job failed, died or timed out),
    the raw plans get the safety net (_retime_fallback): re-timed exactly when possible, otherwise
    kept with a warning and a VIOLATED / VERIFIED feasibility report from the independent check.
    Every scenario it replaces is added to ``done``."""
    done = done if done is not None else set()
    raw = {n: sc for n, sc in results.items() if sc.status == "OPTIMIZED"}
    if not raw or not solvable:
        return
    cfg = req.config
    t0 = time.monotonic()
    ctx = _stage_ctx(req, solvable, tds, mx, drops)
    values, value_warnings, use_margin = ctx.values, ctx.value_warnings, ctx.use_margin
    sources = [LR.Source(n, _timed_from_scenario(sc, ctx.stop_idx, ctx.truck_idx)) for n, sc in raw.items()]
    carried = {src.name: {k for loads in src.plan.values() for tl in loads for k in tl.stops} for src in sources}
    left_out = set(range(len(solvable))) - set.intersection(*carried.values())
    optional = _repair_weights(solvable, left_out, cfg) if left_out else None
    rec_pricing = ctx.rec_pricing
    goals = _stage_goals(raw)
    cap = min(REPACK_CAP_SEC, max(REPACK_MIN_SEC, time_limit / 2))
    job_budget = min(cap * len(sources), budget_end - t0 - STAGE_GRACE_SEC - 5)

    def fallback(why: str) -> None:
        before = dict(results)
        _retime_fallback(req, solvable, tds, mx, drops, results, why, ctx=ctx)
        done.update(n for n in raw if results[n] is not before[n])

    if job_budget < REPACK_MIN_SEC:
        log.warning("post-solve stage skipped: request time budget used up")
        return fallback("out of time")
    jobs = {g: dict(day=ctx.day, score_pricing=rec_pricing, goal=g,
                    goal_pricing=rec_pricing if g == "RECOMMENDED" else _pricing(g, req, tds, solvable),
                    sources=sources, optional=optional, cap_s=cap, budget_s=job_budget, time_raw=g == "RECOMMENDED",
                    fit_weights=_repair_weights(solvable, set(range(len(solvable))), cfg))
            for g in goals}
    outputs: dict[str, tuple[list[LR.Candidate], list[str]]] = {}
    if pool is None:
        for g, job in jobs.items():
            try:
                outputs[g] = _stage_worker(job)
            except Exception as exc:  # noqa: BLE001 - the raw plans stay valid
                log.warning("post-solve %s failed: %s", g, exc)
    else:
        rounds = -(-len(jobs) // max(1, pool.size))
        deadline = min(time.monotonic() + rounds * job_budget + STAGE_GRACE_SEC, budget_end - 2)
        # In completion order: a MIN_TRUCKS job whose worker dies (out of memory) no longer costs
        # RECOMMENDED its exact re-check, nor the rest of the budget (review L23).
        got = _await_all(pool, {g: pool.submit(_stage_worker, job, f"stage:{g}") for g, job in jobs.items()}, deadline)
        for g in goals:
            kind, value = got[g]
            if kind == "ok":
                outputs[g] = value  # type: ignore[assignment]
            else:
                log.warning("post-solve %s %s%s", g, {"lost": "lost its worker process", "timeout": "timed out"}.get(kind, "failed"),
                            f": {value}" if value is not None else "")
    stage_sec = time.monotonic() - t0
    if "RECOMMENDED" not in outputs:  # the raw plans were not re-timed either
        return fallback("the check failed or ran out of time")
    cands = [c for g in goals if g in outputs for c in outputs[g][0]]
    log.info("post-solve run=%s %.1fs: %s", req.run_id, stage_sec,
             "; ".join(n for g in goals if g in outputs for n in outputs[g][1]))
    for name, sc in raw.items():
        own = sum(v for k, v in enumerate(values) if k not in carried[name])
        fits = [c for c in cands if c.score.unserved <= own]
        lost = not fits and bool(cands)
        if lost:
            # This search's plan breaks the exact loading time between loads (its own timing is
            # an estimate) and nothing serving as much fits the day: take the fitting plan that
            # keeps the most priority value, never departure times no truck can make.
            fits = cands
        if not fits:
            # No plan of this day could be timed exactly (not even this one): kept as found. Its
            # feasibility report (built with the raw plan) lists what it breaks.
            sc.warnings.append(
                f"This plan does not leave the loading time of {cfg.loading_min_per_case:g} min per case between loads "
                "everywhere; some later loads may be timed too early. Re-plan, add a truck, or check the loading time."
                if cfg.loading_min_per_case > 0 else
                "The final timing check failed for this plan; check load times before dispatching."
            )
            continue
        goal = _GOALS[name]
        best = min(fits, key=lambda c: (goal(c.score), c.source.split("+")[0] != name))
        served_now = {k for loads in best.plan.values() for tl in loads for k in tl.stops}
        added = served_now - carried[name]
        timing_drops = carried[name] - served_now if lost else set()
        new = _build_scenario(
            name, req, solvable, tds, mx, best.plan, values, use_margin, drops, solver_status=sc.solver_status,
            elapsed=sc.solver_time_sec + stage_sec, time_limit=sc.time_limit_sec,
            objective_value=best.score.objective, extra_warnings=value_warnings, timing_drops=timing_drops,
            exact_timing=True,
        )
        changed = (new.trucks_used, new.trips) != (sc.trucks_used, sc.trips) or abs(new.operating_cost - sc.operating_cost) >= 0.5
        if timing_drops:
            new.warnings.append(
                f"{len(timing_drops)} stop(s) the route search had planned are left out: with the loading time between "
                f"loads ({cfg.reload_min} min + {cfg.loading_min_per_case:g} min per case) its loads did not fit the truck "
                "days, so the lowest priorities were left out (see Unserved orders). Re-plan, add a truck, or check the "
                "loading time." + (f" {len(added)} stop(s) the route search had left out are planned instead." if added else "")
            )
        elif "+repack" in best.source and changed:
            new.warnings.append(
                f"Loads were re-assigned after the route search: {sc.trucks_used} -> {new.trucks_used} trucks, "
                f"{sc.trips} -> {new.trips} loads, {sc.operating_cost:.0f} -> {new.operating_cost:.0f} OMR operating cost"
                + (f"; this also plans {len(added)} stop(s) the route search had left out." if added else ".")
            )
        elif added:
            new.warnings.append(f"{len(added)} stop(s) the route search had left out were planned after the search.")
        log.info("post-solve run=%s %s: %s -> %s trucks, %s -> %s loads, %.1f -> %.1f OMR, +%d/-%d stops (from %s)",
                 req.run_id, name, sc.trucks_used, new.trucks_used, sc.trips, new.trips, sc.operating_cost,
                 new.operating_cost, len(added), len(timing_drops), best.source)
        results[name] = new
        done.add(name)


def _submatrix(stops: list[DispatchStop], keep: list[int], mx: MatrixResult) -> tuple[list[DispatchStop], MatrixResult]:
    nodes = [0] + [k + 1 for k in keep]
    dist = [[mx.distance_m[i][j] for j in nodes] for i in nodes]
    dur = [[mx.duration_s[i][j] for j in nodes] for i in nodes]
    return [stops[k] for k in keep], MatrixResult(dist, dur, mx.provider_name, mx.is_estimated, list(mx.warnings), mx.patched_cells)
