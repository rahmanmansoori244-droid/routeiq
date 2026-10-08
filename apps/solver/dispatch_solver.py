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
  re-optimized; they only push the truck's next departure after their return. A plan made on its
  own delivery day sends ``loading_from_min`` (when it was made): loading cannot start before it,
  so a truck's first new load leaves no earlier than it + the turnaround of that load, on a truck
  standing at the depot as on one coming back (``TruckDay.ready_s``).
* Hard constraints: capacity in cases AND kg (when the truck has a payload; kg in whole 0.1 kg
  units, each stop to the nearest unit and the payload rounded down - no hidden margin, audit
  F08) - or, on a truck with bays (owner decision 4 Oct 2026), in PALLETS AND kg: the load's pallet
  need (1/1000 pallet units; mixed pallets: the stops' needs as the web sent them, added up) at most
  bays x config.pallet_fill_pct, its case capacity then not a limit (a "Pallets" routing dimension
  beside or instead of "Cases"; TruckDay.by_pallets), hard customer
  receiving windows (config.window_rule FINISH: unloading FINISHED by closing, i.e. service starts
  by closing - stop time; START, the earlier rule and the default: service STARTS inside the
  window; load_repack.latest_start_s), depot open hours, truck
  availability, trip linking, shift limit.
* Driver break (config.break_min, owner rule 29-30 Sep 2026): one break per truck-day, STARTING in
  [break_start_from_min, break_start_to_min], on the road between two unloadings or at the depot
  (it may overlap a reload), never while unloading, inside the shift. Needed (TruckDay.break_state
  DUE) only when the day's first departure is before the window start and its last return after
  the window end - by times, never by load status (_break_state). The route search stays
  break-free and keeps the break's length free of the shift of a DUE truck (search-only margin);
  load_repack places the break exactly (time_truck) and the CP-SAT repack models it (depot
  interval + road-break variants); feasibility.check_scenario re-checks it (BREAK).
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
         Trucks to RENT (the hire suggestion's what-if, DispatchTruck.hire_candidate) are ranked
         in a HIRE TIER between the P1-P3 and the P4/P5 stops, in proportion to their real money
         - hire, driver day rate, the option's own km charge over a rough day's km - (_service_and_hire,
         _hire_tier): own trucks first, the cheapest set of rented trucks, never one for P4/P5 stops
         alone, never less strict priorities than without them. Search only; without trucks to rent
         nothing changes.
    4.   Operating cost in real OMR: fixed truck cost (once per truck-day), per-load cost,
         distance cost (cost_per_km + fuel_price / km_per_litre - fuel is counted ONCE),
         driver time cost, overtime (a driver paid by the day, driver_day_cost: that rate once
         per truck-day instead of the time cost and overtime; its km and time get a tiny
         search-only tie-breaker, _search_km_rate / _tie_span_units, compared after the cost in
         every goal and never reported as money).
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

import heapq
import itertools
import logging
import math
import os
import threading
import time
from collections import Counter
from collections.abc import Callable
from dataclasses import dataclass
from fractions import Fraction

from ortools.constraint_solver import pywrapcp, routing_enums_pb2

import costing
import feasibility as FZ
import load_repack as LR
import pyvrp_candidate as PV
from dispatch_models import (
    DAY_MIN,
    MAX_STOPS,
    PALLET_FILL_DEFAULT,
    PALLET_UNIT,
    WEIGHT_UNIT_KG,
    BreakRule,
    DispatchConfig,
    DispatchRequest,
    DispatchResponse,
    DispatchScenario,
    DispatchScenarioName,
    DispatchStop,
    DispatchTruck,
    FeasibilityReport,
    HireCheck,
    HireOneFewer,
    ObjectiveComponents,
    PlannedBreak,
    PlannedLoad,
    PlannedStop,
    PreferencePenalties,
    PyvrpReport,
    SearchReport,
    TruckDayCostOut,
    UnservedStop,
    kg_text,
    kg_units,
    pallet_room_units,
    pallet_text,
    payload_units,
)
from providers import MatrixCancelled, MatrixResult, haversine_km, matrix_quality, resolve_matrix

log = logging.getLogger("routeiq.dispatch")

COST_SCALE = costing.COST_SCALE  # 1 OMR = 100,000 objective units
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
# Road routing gets at most this much of the budget (review F19): 90 s, or 20% of the budget if
# that is less. Env MATRIX_BUDGET_SEC overrides. After it the matrix is estimated, with a warning.
MATRIX_BUDGET_CAP_SEC = 90
MATRIX_BUDGET_SHARE = 0.2
# Above this many stops the search gets its longest automatic time limit; a warning says so.
LARGE_DAY_STOPS = 350
# Each load's total cost is its exact money rounded to 0.001 OMR (costing.round_parts): the loads of a
# scenario add up to its exact truck-day money within half a baisa per load.
COST_TOLERANCE_PER_LOAD = 0.0005
# Post-solve stage (load repack): each CP-SAT solve gets min(CAP, max(MIN, search limit / 2)).
REPACK_CAP_SEC = 15
REPACK_MIN_SEC = 3
# Worker start-up, exact timing of every candidate and pickling around the repack solves.
STAGE_GRACE_SEC = 20
ENGINE = "ortools-routing"

# THOROUGH search (owner decision 29 Sep 2026: "night plans long, day re-plans quick"; see
# docs/OPTIMIZER_BENCHMARK.md section 11 for the measurements behind these values). The whole
# request - road matrix, every search, the load re-check - answers within the cap: env
# THOROUGH_MAX_SEC (default 20 min); a request's config.max_search_sec may only lower it.
THOROUGH_MAX_SEC = 1200
# RECOMMENDED's search stops once its best plan has not improved for max(STALL_FLOOR_SEC,
# STALL_SHARE x the time searched so far) - and never before QUICK's time for the day (T1).
# Env THOROUGH_STALL_SEC / THOROUGH_STALL_SHARE override.
THOROUGH_STALL_FLOOR_SEC = 300
THOROUGH_STALL_SHARE = 0.5
# The alternatives (warm-started from RECOMMENDED, in parallel) get at least this long, and the
# load re-check (CP-SAT) this long per solve; both are kept free at the end of the cap.
THOROUGH_ALT_MIN_SEC = 60
THOROUGH_REPACK_CAP_SEC = 30

# Rule 22 (owner decision, audit policy 22): the worker processes are started, and proven to run a
# task, before the road matrix is fetched. A pool that cannot start (an OSError: out of memory, the
# process limit) or whose first task does not run within WORKER_START_SEC (its processes die while
# starting) refuses the solve at once: WorkersUnavailable, which main.py answers with 503 and
# PLANNER_UNAVAILABLE_MSG. Nothing is then searched inside the API process: that used to freeze
# the whole API with no deadline for the length of the search (20 minutes and more for THOROUGH).
# Env SOLVER_WORKER_START_SEC overrides the wait; SOLVER_ALLOW_INPROCESS_FALLBACK=1 keeps the old
# in-process fallback for development and tests only. After a failed start (or a pool that broke),
# /ready reports the workers as failed for WORKER_ALERT_SEC, or until a pool starts at least
# WORKER_ALERT_MIN_SEC after the failure: the web's /api/health is then "degraded" with
# SOLVER_WORKERS_FAILED. Second review: a pool that starts sooner - the load re-check's fresh one,
# seconds after the pool broke, or another company's solve - used to clear it at once, so
# monitoring that polls /api/health every few minutes never saw the failure.
WORKER_START_SEC = 30
WORKER_ALERT_SEC = 900
WORKER_ALERT_MIN_SEC = 300
PLANNER_UNAVAILABLE_MSG = "The planner is busy or restarting - try again in a minute."
# Rule 22 (review): the longest a request waits for a worker pool to close. CPython's Pool.terminate
# can wait forever on a pool that broke (see _stop_pool_processes); past this the cleanup goes on
# in a background thread and the administrator is alerted, and the answer is not held back.
POOL_CLOSE_SEC = 10.0
# Why the loads were not re-checked when the load re-check could not get worker processes (rule
# 22): the dispatcher's note on the plan, in plain words; the technical cause is in the ERROR line.
NO_WORKERS_NOTE = "the planner was short of resources"

# The hire suggestion (owner request 6 Oct 2026; the owner's answers and the review of the hire branch,
# 6 Oct 2026): a request may carry trucks the company could rent for the day (DispatchTruck.
# hire_candidate; the web's what-if, one per unit it may rent). Each is ranked in the HIRE TIER, a level
# of the strict service values between the P1-P3 and the P4/P5 stops (_service_and_hire):
# - a rented truck weighs more than every P4/P5 stop of the day together: P4/P5 stops alone never rent
#   one (owner answer 1), and once it is rented for P1-P3 stops it carries P4/P5 stops in its spare room;
# - one P1-P3 stop weighs more than the dearest rented truck (and every P4/P5 stop): a stop the own
#   fleet cannot carry is always worth a rented truck;
# - within the tier a rented truck weighs in proportion to its real money for the day - its hire, its
#   driver's day rate and its option's own km charge over a rough day's km (hire_money, _hire_day_km;
#   review: an option at 50 OMR + 1 OMR/km beat one at 60 OMR with no km charge on a far day, 238 OMR
#   instead of 70) - each unit of money (1 OMR) above every P4/P5 stop together: the cheapest set wins,
#   two small trucks or one big one, never fewer trucks for their own sake (review: a premium on every
#   rented truck chose a 10-ton at 85 OMR over two 3-tons at 60);
# - the tier never makes a day's priorities less strict than the plan's own: on a day of several
#   hundred stops the money is counted in coarser units (2, 5, 10 ... OMR, _hire_tier) before the strict
#   weights would have to be capped (review: 450 stops, one P1 worth about 7 P2 in the what-if only);
# - own trucks always go first: their whole day's money is far below one unit of the tier, so an idle
#   own truck is never replaced by a rented one, however dear its day or its km;
# - search only: every plan reports each truck's real costs (costing.py) - a rented truck's fuel is in
#   its hire (no km cost unless its option charges per km) and its driver is paid by the day.
# A request without trucks to rent is planned exactly as before. The search, the load re-check (its
# phase 1, _hire_repair_weights) and the second search (PyVRP) rank a rented truck alike.
#
# A truck whose driver is paid by the DAY (driver_day_cost: a truck to rent, or one hired for the day)
# costs nothing per hour, and with its fuel in the hire nothing per km either: the search would leave
# its stops in any order (review: 358 km instead of 232, two hours of its driver's day). Its km and
# time therefore carry a TINY price in the search (HIRE_TIE_KM_OMR, HIRE_TIE_HOUR_OMR): enough to drive
# its stops in a sensible order and keep its day compact, far too little to outweigh real money (fourth
# review: priced at the own fleet's average km rate and the hourly driver rate, and added to the cost,
# it kept a 10-ton hired for the day on the near stops and sent an own truck 160 km at 0.2 OMR/km -
# 139 OMR instead of 103). It is never money: the plans report its real costs (no km cost, the day
# rate), and the load re-check's score keeps it apart (LR.Score.tie), compared after the cost in every
# goal (_GOALS).
# That tiny price decides which truck carries what; it cannot order a truck's stops against the
# customers' time preferences (fifth review: with the default early-arrival preference one minute
# earlier at a P1 order, 0.01 OMR, was worth 10 km, and a hired truck drove its P1 orders first wherever
# they were - 340 km instead of 250, back at 16:30 instead of 14:16). Once an option's plan is chosen,
# such a truck's day is routed again with the same per-km and per-hour costs as an own truck's
# (_order_km_rate, the hourly driver rate; LR.shorter_orders): WHICH of its stops go on which of its
# loads (sixth review: a rented truck making two loads still criss-crossed the area, 249 km where an own
# truck drives 185 - only the stops inside each load were put in order), then the order inside each
# load. Fewer km, no more money, the same truck and stops, every hard rule timed exactly
# (_shorter_orders); these costs are never money and never decide which truck carries what.
#
# The REDUCTION (sixth review: on the real Muscat day the Quick search rented 2 x 10-ton where one
# carried every P1-P3 order - the second only P4/P5 orders, and the set was not the cheapest): emptying
# a rented truck needs all its stops moved at once and each move alone gains nothing, so the search
# stops in such a local optimum. After it (_reduce_hire), first without any solve, every rented truck
# whose loads carry no P1-P3 stop is given back - its loads deleted, its stops left out, every other load
# as it was. Then the CHEAPEST set (seventh review: leaving the dearest truck out first kept 2 x 3-ton for
# 80 OMR where the 10-ton alone, 60 OMR, delivered every order, and never swapped a rented truck for a
# cheaper one the plan did not use): every set of the trucks to rent - units of one option are alike -
# cheaper in real money than the plan's (hire_money; as much money with fewer trucks), with as many
# trucks as it takes (eighth review: capped at the plan's count, 1 x 10-ton at 85 OMR stayed where
# 2 x 3-ton at 80 delivered every order), is tried cheapest first (fewer trucks first on a tie), and the
# first that delivers every P1-P3 stop the plan delivered and passes every check, its load re-check
# included, is the suggestion. With a km charge (BUG 5, 7 Oct 2026: the rough day of the tier priced a
# rental for a near customer as if it drove to the far ones, 123.13 OMR kept where 87.59 delivered the
# same) "cheaper" is by each set's LEAST cost (_hire_floor_money, _hire_km_floor) and a plan is judged by
# the real cost of its routed km (_hire_routed_money): a set is kept only when no untried set's least
# cost is below the best real cost found; a flat-rate option costs the same in all three. A set whose trucks cannot hold those stops even full on every load they
# may make is ruled out without a solve (_hire_room_short). When trucks were given back, the set left is
# solved once more if the limits allow and that set was not solved already (eighth review: their P4/P5
# orders were dropped although the trucks kept had room and loads to spare - they may ride along); its
# plan replaces the give-back only when it passes every check, keeps every P1-P3 stop and is cheaper, or
# as cheap and serving more by the day's priorities (ninth review: money was never compared, and two P5
# orders outweighed one P4) - otherwise the give-back stays. At most HIRE_REDUCE_MAX_SOLVES solves
# within the window (_hire_reduce_window); a solve starts only with room for its search, its worker and
# its load re-check's whole reserve (_hire_trial_need), and searches as long as the what-if up to
# HIRE_TRIAL_FULL_SEC, half as long above it, so a big day gets solves too. "One truck fewer" is such a
# solve.

# A day-paid or rented truck's km in the search, on top of its own km charge (if any): 1 OMR per
# 1,000 km - its route is the short one, and a whole day's km weigh well under 1 OMR (search only).
HIRE_TIE_KM_OMR = 0.001
# OMR per km a day-paid or rented truck's km weigh against its customers' time preferences when its
# day is routed again after the pick (_order_km_rate) on a day none of the own trucks has a km rate.
HIRE_ORDER_KM_OMR = 0.1
# Seconds each chosen plan of a request may spend on routing those trucks' days again (in-process, after
# the pick; all of them together three times that; LR.shorter_orders keeps what it has when the time is up).
HIRE_ORDER_SEC = 3.0
# The reduction of a what-if's rented trucks (_reduce_hire): at most this many extra solves of the day,
# within this many seconds or the time of HIRE_REDUCE_WINDOW_SOLVES solves, whichever is longer (and
# never past the request's own budget; _hire_reduce_window).
HIRE_REDUCE_MAX_SOLVES = 6
HIRE_REDUCE_SEC = 180.0
HIRE_REDUCE_WINDOW_SOLVES = 2
# The sets of trucks to rent the reduction lists at most (cheaper than the plan's, any number of trucks;
# each option has up to 10 units a day): past it the set found stays, not proven the cheapest.
HIRE_REDUCE_MAX_SETS = 20000
# A reduction solve searches as long as the what-if on a day searched up to this many seconds (NMWC's
# usual 80-120-stop days), half as long above it but never less; with less time left in the window it
# is shortened down to half of that again (never under this) - or not started (_hire_trial_limit).
HIRE_TRIAL_FULL_SEC = 20
# A reduction solve's own worker pool and second search start before its search (on top of
# REC_OVERHEAD_SEC, which covers the search's model build and extraction).
HIRE_TRIAL_START_SEC = 5
# A day-paid driver's time in the search: 1 objective unit a second (0.036 OMR an hour, the smallest
# whole rate the routing models take) - a compact day, room for its next load (search only).
HIRE_TIE_HOUR_OMR = 0.036
# OMR of hire money per unit of the hire tier, finest first (_hire_tier): 1 OMR, coarser only when the
# strict priorities would otherwise have to be capped (a day of several hundred stops).
HIRE_RESOLUTIONS = (1.0, 2.0, 5.0, 10.0, 20.0, 50.0, 100.0, 200.0, 500.0, 1000.0)


def _hire_day_km(stops: list[DispatchStop], cfg: DispatchConfig, depot, t: DispatchTruck) -> float:
    """A rough day's km of a truck to rent, for its option's own km charge in the hire tier (search
    only): a round trip of the day's average road distance from the depot (straight line x the road
    factor) for every load it may make - it is rented for the whole day. 0 without a depot or stops."""
    if depot is None or not stops:
        return 0.0
    mean = sum(haversine_km(depot.lat, depot.lng, s.lat, s.lng) for s in stops) / len(stops) * cfg.haversine_multiplier
    return 2.0 * mean * (t.max_trips or cfg.max_trips_per_truck)


def hire_money(t: DispatchTruck, cfg: DispatchConfig | None = None, day_km: float = 0.0) -> float:
    """What renting the truck costs for the day in real money (OMR): its hire, its driver's day rate
    and its option's own km charge over ``day_km`` (_hire_day_km; fuel is in the hire)."""
    km = _km_rate_omr(t, cfg) * day_km if cfg is not None and day_km > 0 else 0.0
    return float(t.fixed_cost) + float(t.driver_day_cost or 0.0) + km


def _hire_money_of(stops: list[DispatchStop], cfg: DispatchConfig, trucks, depot=None) -> dict[str, float]:
    """hire_money of every truck to rent among ``trucks`` (its km charge over its rough day's km)."""
    return {t.id: hire_money(t, cfg, _hire_day_km(stops, cfg, depot, t) if t.cost_per_km or t.km_per_litre else 0.0)
            for t in trucks if t.hire_candidate}


# Km taken off the reduction's floor of a rented truck's day (_hire_km_floor): a plan reports each load's
# km to the metre x 10 (0.01 km), so the floor stays under the km a plan reports.
HIRE_KM_FLOOR_SLACK = 0.01


def _hire_km_floor(mx: MatrixResult) -> float:
    """The fewest km a rented truck drives for the day if it carries any stop (the reduction's lower bound,
    BUG 5 of 7 Oct 2026): out of the depot to the stop nearest to it and back from the stop nearest to it,
    on the request's own road matrix. Every load leaves the depot for one of the day's stops and comes back
    from one, whatever its order (no triangle rule needed), so no truck that carries a stop drives less.
    0 without stops."""
    n = len(mx.distance_m)
    if n <= 1:
        return 0.0
    out = min(mx.distance_m[0][i] for i in range(1, n))
    back = min(mx.distance_m[i][0] for i in range(1, n))
    return max(0.0, (out + back) / 1000.0 - HIRE_KM_FLOOR_SLACK)


def _km_charged(t: DispatchTruck) -> bool:
    """The truck to rent has a km charge (its option's cost per km; a km per litre is never sent for one)."""
    return bool(t.cost_per_km or t.km_per_litre)


def _hire_floor_money(trucks, cfg: DispatchConfig, km_floor: float) -> dict[str, float]:
    """Per truck to rent among ``trucks``, the LEAST its day can cost if it is used (hire_money over the
    floor of its km, _hire_km_floor): never above what any plan that uses it pays for it. A flat-rate
    truck (no km charge): its hire + its driver's day rate, exactly as _hire_money_of."""
    return {t.id: hire_money(t, cfg, km_floor if _km_charged(t) else 0.0) for t in trucks if t.hire_candidate}


def _hire_routed_money(sc: DispatchScenario, hires: dict[str, DispatchTruck], cfg: DispatchConfig) -> dict[str, float]:
    """Per rented truck ``sc`` uses, what its day really costs in that plan: its hire, its driver's day rate
    and its km charge over the km its loads drive (hire_money over the routed km; a flat-rate truck: its
    hire + its driver's day rate)."""
    km: dict[str, float] = {}
    for ld in sc.loads:
        if ld.truck_id in hires:
            km[ld.truck_id] = km.get(ld.truck_id, 0.0) + ld.distance_km
    return {tid: hire_money(hires[tid], cfg, k if _km_charged(hires[tid]) else 0.0) for tid, k in km.items()}


@dataclass(frozen=True)
class _HireTier:
    """The hire tier in strict weight units (_hire_tier)."""

    units: dict[str, float]  # per truck to rent: u x max(1, its money / res)
    top: int  # the dearest truck's units rounded up: every P1-P3 weight carries it on top
    res: float  # OMR of hire money per unit of money (HIRE_RESOLUTIONS)
    u: int  # one unit of money: 1 + the weight of every P4/P5 stop


def _strict_total(counts: Counter, w: dict[int, int], n_stops: int, with_margin: bool) -> int:
    """The strict weights of a day added up (each stop once; with margins one unit more each)."""
    return sum(n * w[p] for p, n in counts.items()) + (n_stops if with_margin else 0)


def _strict_fits(total: int) -> bool:
    """True when strict weights adding up to ``total`` stay strict: _service_and_hire scales the base
    down at most to 100 OMR per weight unit before it must cap the weights."""
    if total * SERVICE_BASE <= PENALTY_LIMIT:
        return True
    return total * max(100 * COST_SCALE, PENALTY_LIMIT // max(1, total)) <= PENALTY_LIMIT


def _hire_tier(stops: list[DispatchStop], trucks, with_margin: bool, money: dict[str, float]) -> _HireTier | None:
    """The hire tier: per truck to rent, u x its money in units of ``res`` OMR (at least one unit), where
    u = 1 + the weight of every P4/P5 stop (with margins each counts one unit more, as in
    _strict_weights) - one unit of money weighs more than every P4/P5 stop together; and the dearest
    truck's units rounded up (top), which every P1-P3 weight carries on top. ``res`` is 1 OMR, or the
    finest coarser one (HIRE_RESOLUTIONS) that keeps the strict weights uncapped when the day's own
    weights are (review: the tier multiplied them by 60-150, and a 450-stop day got capped priorities
    in the what-if only). None without trucks to rent."""
    hires = [t for t in trucks if t.hire_candidate]
    if not hires:
        return None
    counts = Counter(s.priority for s in stops)
    w0 = _strict_weights(counts, with_margin)
    m = 1 if with_margin else 0
    u = 1 + sum(counts.get(q, 0) * (w0[q] + m) for q in (4, 5))
    own_fits = _strict_fits(_strict_total(counts, w0, len(stops), with_margin))
    dearest = max(max(money[t.id] for t in hires), 1.0)
    tier = None
    for res in [r for r in HIRE_RESOLUTIONS if r < dearest] + [dearest]:
        units = {t.id: u * max(1.0, money[t.id] / res) for t in hires}
        top = int(math.ceil(max(units.values())))
        total = _strict_total(counts, _strict_weights(counts, with_margin, top), len(stops), with_margin) + int(math.ceil(sum(units.values())))
        tier = _HireTier(units, top, res, u)
        # A day already capped without trucks to rent keeps 1 OMR (it is capped either way).
        if not own_fits or _strict_fits(total):
            break
    return tier


def _hire_repair_weights(stops: list[DispatchStop], cfg: DispatchConfig, trucks, depot=None) -> dict[str, int]:
    """The hire tier on the load re-check's small phase-1 weights (_repair_weights): per truck to rent,
    (1 + every P4/P5 stop's weight) x its money in the search's units (_hire_tier), rounded up - above
    every P4/P5 stop together, and every P1-P3 weight carries the dearest on top. {} without trucks to
    rent."""
    hires = [t for t in trucks if t.hire_candidate]
    if not hires:
        return {}
    money = _hire_money_of(stops, cfg, trucks, depot)
    res = 1.0
    if cfg.strict_priorities:
        counts = Counter(s.priority for s in stops)
        w = _strict_weights(counts)
        u = 1 + sum(counts.get(q, 0) * w[q] for q in (4, 5))
        use_margin = cfg.use_margin and bool(stops) and all(s.margin is not None for s in stops)
        tier = _hire_tier(stops, trucks, use_margin, money)
        res = tier.res if tier is not None else 1.0
    else:
        pw = cfg.priority_weights
        u = 1 + sum(max(1, int(round(100 * pw[s.priority] / pw[5]))) for s in stops if s.priority >= 4)
    return {t.id: int(math.ceil(u * max(1.0, money[t.id] / res))) for t in hires}


def _hired_km(t: DispatchTruck) -> bool:
    """A truck whose km the search prices with the tie-breaker: its driver is paid by the day (a truck to
    rent, or one hired for the day) or it is a truck to rent (its fuel is in the hire)."""
    return t.driver_day_cost is not None or t.hire_candidate


def _search_km_rate(t: DispatchTruck, cfg: DispatchConfig) -> float:
    """The truck's km rate in the search: its own (_km_rate_omr), and for a rented truck or one whose
    driver is paid by the day HIRE_TIE_KM_OMR on top - the tie-breaker between plans of the same cost,
    never enough to outweigh real money (fourth review: the own fleet's average rate kept it off the far
    stops it carries for free). Its loads' order against the time preferences: _shorter_orders."""
    rate = _km_rate_omr(t, cfg)
    return rate + HIRE_TIE_KM_OMR if _hired_km(t) else rate


def _order_km_rate(req: DispatchRequest) -> float:
    """OMR per km a rented or day-paid truck's km weigh against its customers' time preferences when its
    loads are put in order after the pick (_shorter_orders; never money, never which truck carries
    what): the average km rate (km cost + fuel) of the request's own trucks - paid by the hour, never
    rented - as their own km weigh in the search, or HIRE_ORDER_KM_OMR when none of them has one."""
    own = [_km_rate_omr(t, req.config) for t in req.trucks if not _hired_km(t)]
    avg = sum(own) / len(own) if own else 0.0
    return avg if avg > 0 else HIRE_ORDER_KM_OMR


def _tie_span_units(t: DispatchTruck, w: "ScenarioWeights") -> int:
    """Objective units per second of a day-paid driver's day in the search (HIRE_TIE_HOUR_OMR, at least
    1): the tie-breaker that keeps its day compact - never money, never the hourly rate. 0 for a driver
    paid by the hour (its real pay prices its day) and in a scenario that does not price driver time."""
    if t.driver_day_cost is None or w.pure_distance or w.time <= 0:
        return 0
    return max(1, int(round(HIRE_TIE_HOUR_OMR * w.time * COST_SCALE / 3600.0)))


def _vehicle_fixed_units(td: "TruckDay", w: "ScenarioWeights", hire_units: int) -> int:
    """The routing model's cost of using a truck-day at all (objective units): its day cost x the
    scenario's weight and a day-rate driver's pay x the driver-time weight (a truck with frozen loads
    is already out: never "opened" again, B3), and its first load's trip cost; MIN DISTANCE prices
    metres only. A truck to rent adds ``hire_units``, its hire tier as the drop penalties are scaled,
    in every scenario: even MIN DISTANCE never rents a truck to save a few metres."""
    t = td.truck
    fixed = 0.0
    if not w.pure_distance:
        if td.n_frozen == 0:
            fixed += t.fixed_cost * w.fixed
            if t.driver_day_cost is not None:
                fixed += t.driver_day_cost * w.time
        fixed += t.trip_cost * w.trip  # the first new load
    units = int(round(fixed * COST_SCALE))
    if t.hire_candidate and td.n_frozen == 0:
        units += hire_units
    return units


# The automatic search time between 120 and 200 stops (PR7, T1): straight lines through these
# (stops, seconds) points. Up to 120 stops 20 s, from 200 to LARGE_DAY_STOPS 150 s, above 240 s.
# No day size gets less than before PR7 (test_auto_time_limit_never_below_the_pre_pr7_schedule).
# The web's Settings page states this schedule from packages/shared-types/src/planner-bounds.json
# (searchTimeSec): change both together (test_web_search_time_schedule_is_the_solver_schedule).
TIME_LIMIT_POINTS: tuple[tuple[int, int], ...] = ((120, 20), (150, 50), (200, 150))


def auto_time_limit(n_stops: int) -> int:
    """RECOMMENDED's search time in seconds for a day of ``n_stops`` solvable stops.

    Small days are cheap: 20 s instead of 8 s from 26 stops is insurance against a search stopped
    before it settled (the synthetic 60-stop days were 5-15% better at 20-30 s). Big days need much
    more: at 300 stops 45 s left feasible P5 stops unserved (search not converged) while 150 s
    served all of them. Between them the time rises in straight lines (TIME_LIMIT_POINTS): NMWC's
    usual 80-120-stop days keep their 20 s, then +1 s per stop to 50 s at 150 stops and +2 s per
    stop to 150 s at 200 stops (175 stops: 100 s); 150 s from 200 up to LARGE_DAY_STOPS. Until PR7
    it jumped from 20 s at 200 stops to 150 s at 201, so a 200-stop day got 20 s and visibly
    different plans from run to run. Monotone, and never less than that pre-PR7 schedule for any
    day size (201-299-stop days, such as the re-test's S03 at 240 stops, had not converged even on
    150 s); above LARGE_DAY_STOPS (the "Large day" warning) it stays 240 s, and every value fits the
    request budget (SOLVER_BUDGET_SEC, see test_auto_time_limit_schedule)."""
    if n_stops <= 25:
        return 5
    if n_stops > LARGE_DAY_STOPS:
        return 240
    (x0, y0) = TIME_LIMIT_POINTS[0]
    if n_stops <= x0:
        return y0
    for (xa, ya), (xb, yb) in zip(TIME_LIMIT_POINTS, TIME_LIMIT_POINTS[1:]):
        if n_stops <= xb:
            return int(math.floor(ya + (yb - ya) * (n_stops - xa) / (xb - xa) + 0.5))
    return TIME_LIMIT_POINTS[-1][1]


# ---------------------------------------------------------------------------------------------
# Search modes (owner decision 29 Sep 2026): QUICK = the automatic time above, exactly as before;
# THOROUGH = up to THOROUGH_MAX_SEC for the whole request, stopping once the search stops improving
# ---------------------------------------------------------------------------------------------

def _env_num(name: str, default: float, *, lo: float, hi: float) -> float:
    try:
        value = float(os.environ.get(name, ""))
    except ValueError:
        return default
    return value if lo <= value <= hi else default


def thorough_cap_sec(cfg: DispatchConfig) -> int:
    """THOROUGH: the whole request's time budget. The solver's THOROUGH_MAX_SEC (env, default 20
    min) is the ceiling; a request's max_search_sec may only lower it."""
    hard = int(_env_num("THOROUGH_MAX_SEC", THOROUGH_MAX_SEC, lo=10, hi=3600))
    return min(hard, cfg.max_search_sec) if cfg.max_search_sec else hard


@dataclass(frozen=True)
class StallRule:
    """Stop a search whose best plan has not improved for max(floor_sec, share x the time searched
    so far) - never before min_sec, QUICK's time for the day (THOROUGH never searches less, T1).
    The share makes the patience grow with the search: a plan last improved at minute 8 is given
    until minute 16 (share 0.5) to improve again."""

    min_sec: float
    floor_sec: float
    share: float

    def stall_sec(self, elapsed: float) -> float:
        return max(self.floor_sec, self.share * elapsed)

    def should_stop(self, elapsed: float, last_improvement: float) -> bool:
        return elapsed >= self.min_sec and elapsed - last_improvement >= self.stall_sec(elapsed)


def stall_rule(min_sec: float) -> StallRule:
    """The THOROUGH stall rule (env THOROUGH_STALL_SEC / THOROUGH_STALL_SHARE override the values)."""
    return StallRule(min_sec=float(min_sec),
                     floor_sec=_env_num("THOROUGH_STALL_SEC", THOROUGH_STALL_FLOOR_SEC, lo=0.1, hi=3600),
                     share=_env_num("THOROUGH_STALL_SHARE", THOROUGH_STALL_SHARE, lo=0.0, hi=10.0))


def _repack_cap_sec(time_limit: float, thorough: bool) -> float:
    """Each CP-SAT solve of the post-solve stage: QUICK min(15, max(3, limit / 2)) as before;
    THOROUGH at least THOROUGH_REPACK_CAP_SEC (the repack stops earlier when it stops improving)."""
    quick = min(REPACK_CAP_SEC, max(REPACK_MIN_SEC, time_limit / 2))
    return max(quick, THOROUGH_REPACK_CAP_SEC) if thorough else quick


def _thorough_alt_sec(time_limit: int) -> int:
    """THOROUGH alternatives (warm-started from RECOMMENDED): QUICK's half limit, at least
    THOROUGH_ALT_MIN_SEC."""
    return max(max(2, time_limit // 2), THOROUGH_ALT_MIN_SEC)


@dataclass(frozen=True)
class ThoroughTail:
    """THOROUGH: what RECOMMENDED's search leaves free at the end of the cap, and how it is used."""

    alt_sec: int  # each alternative's search limit (0 without alternatives)
    repack_cap: float  # each CP-SAT solve of the load re-check
    stage_sec: int  # kept free for the load re-check (post-solve stage): three sources in one round, and its grace
    total: int  # alternatives + their grace (when asked for) + the re-check

    @staticmethod
    def of(alt_sec: int, repack_cap: float, n_alternatives: int) -> "ThoroughTail":
        stage = int(math.ceil(round(repack_cap * 3, 6) + STAGE_GRACE_SEC + 5))
        alt = alt_sec if n_alternatives else 0
        return ThoroughTail(alt, repack_cap, stage, (alt + ALT_GRACE_SEC if n_alternatives else 0) + stage)


def thorough_tail(time_limit: int, n_alternatives: int, cap: float | None = None) -> ThoroughTail:
    """THOROUGH's tail: the alternatives (in parallel, warm-started) with their grace, then the load
    re-check with its grace - at least 60 s per alternative and 30 s per CP-SAT solve. A ``cap`` below
    20 min where that is more than 30% of the cap shrinks the alternatives' and the re-check's times
    in proportion to fit 30%, never below QUICK's own (half the limit; min(15, max(3, limit / 2))).
    Review of the long-search PR: only the total used to be cut, while the alternatives were still
    charged the full re-check reserve, so under ~7 min they were always skipped and up to a third
    of the cap went unused."""
    alt_full = _thorough_alt_sec(time_limit)
    repack_full = _repack_cap_sec(time_limit, True)
    full = ThoroughTail.of(alt_full, repack_full, n_alternatives)
    budget = int(0.3 * cap) if cap is not None else full.total
    if full.total <= budget:
        return full
    quick_alt, quick_repack = max(2, time_limit // 2), _repack_cap_sec(time_limit, False)
    grace = ALT_GRACE_SEC if n_alternatives else 0
    # The alternatives' share of what the graces leave; the re-check gets the rest (three solves);
    # neither below QUICK's. When the re-check is at QUICK's, the alternatives give back the excess.
    share = max(0, budget - grace - STAGE_GRACE_SEC - 5) / ((alt_full if n_alternatives else 0) + 3 * repack_full)
    alt = max(quick_alt, int(alt_full * share)) if n_alternatives else 0
    rest = max(0.0, (budget - alt - grace - STAGE_GRACE_SEC - 5) / 3)
    repack = min(repack_full, max(quick_repack, math.floor(rest * 10) / 10))
    stage = ThoroughTail.of(0, repack, 0).stage_sec
    if n_alternatives:
        alt = max(quick_alt, min(alt, budget - grace - stage))
    return ThoroughTail.of(alt, repack, n_alternatives)


def thorough_tail_sec(time_limit: int, n_alternatives: int, cap: float | None = None) -> int:
    """THOROUGH: what RECOMMENDED's search leaves free at the end of the cap (thorough_tail)."""
    return thorough_tail(time_limit, n_alternatives, cap).total


def rec_limit_sec(mode: str, time_limit: int, left: float, n_alternatives: int, cap: float | None = None) -> int:
    """RECOMMENDED's search limit with ``left`` seconds of the request budget left. QUICK: exactly as
    before - the automatic limit, shortened only when a slow road matrix ate the budget. THOROUGH:
    everything up to the tail (thorough_tail: the alternatives and the load re-check, in proportion
    to a ``cap`` set below 20 min), never less than QUICK."""
    quick = max(1, min(time_limit, int(left) - REC_OVERHEAD_SEC))
    if mode != "THOROUGH":
        return quick
    return max(quick, int(left) - REC_OVERHEAD_SEC - thorough_tail_sec(time_limit, n_alternatives, cap))


class SolveControl:
    """A running solve's remote control (main.py keeps one per request).

    cancel(): the caller is gone (the web app restarted mid-solve). The solve is abandoned at its
    next check (within a second): SolveAborted, its worker processes stop, its slot frees.
    request_stop(): a supervisor wants the best plan found so far. A THOROUGH search returns it at
    its next check, the alternatives are skipped and the load re-check runs with QUICK's time."""

    def __init__(self) -> None:
        import threading

        self.cancelled = threading.Event()
        self.stop_requested = threading.Event()
        self.why = ""
        self._flags: list = []  # the "stop now" flags of the solve's worker pools
        self._lock = threading.Lock()

    def cancel(self, why: str) -> None:
        self.why = why
        self.cancelled.set()
        self._raise_flags()

    def request_stop(self) -> None:
        self.stop_requested.set()
        self._raise_flags()

    def attach(self, flag) -> None:
        """A worker pool's or process's "stop now" flag (anything with set()): set now if a stop was
        already asked for. Its owner detaches it when it closes."""
        with self._lock:
            self._flags.append(flag)
        if self.stop_requested.is_set() or self.cancelled.is_set():
            self._raise_flags()

    def detach(self, flag) -> None:
        """A closed pool's or process's flag: never raised again, and no longer kept alive by this
        control (CI, PR #50: the control outlives its solve in main.py, and every pool's multiprocessing
        Event it kept - 5 semaphores each - was then freed by the garbage collector in the event-loop
        thread). Waits for a _raise_flags that is running."""
        with self._lock:
            self._flags = [f for f in self._flags if f is not flag]

    def _raise_flags(self) -> None:
        with self._lock:
            for flag in self._flags:
                try:
                    flag.set()
                except Exception:  # noqa: BLE001 - a pool already closed
                    pass


# In a worker process (or in-process with SOLVER_PARALLEL=0): the pool's "stop now" flag.
_STOP_FLAG = None
# The THOROUGH searches' watches in this process, by scenario (read by _searched).
_WATCHES: dict = {}


class _SearchWatch:
    """THOROUGH: follows a search's best objective over time and ends the search once it stops
    improving (StallRule, RECOMMENDED only) or when a stop is asked for. Both happen in OR-Tools'
    at-solution callback, called for every solution the guided local search accepts (tens a second
    on NMWC days, improving or not): Solver.FinishCurrentSearch() then ends the search within
    milliseconds and it returns its best plan. A CustomLimit was measured too: OR-Tools calls it
    35,000-110,000 times a second, which cost 3-12% of the search's solutions
    (docs/OPTIMIZER_BENCHMARK.md section 11). The time limit stays the backstop.

    Each point of the best objective over time also counts the stops that plan had not planned yet
    (``stops``: the stops' routing indices; an unplanned stop is its own successor). The objective
    holds a large penalty for each of them (1,000 OMR or more on real days), so a score in the thousands
    is not money (skeptic review of the long-search PR). Counted on improvements only."""

    def __init__(self, routing, rule: StallRule | None, flag, stops: list[int] | None = None) -> None:
        self.routing = routing
        self.rule = rule
        self.flag = flag
        self.stops = list(stops or [])
        self.t0 = time.perf_counter()
        self.best: int | None = None
        self.last = 0.0
        self.points: list[tuple[float, int, int]] = []
        self.solutions = 0
        self.reason: str | None = None
        self.ended_at: float | None = None

    def on_solution(self) -> None:
        value = int(self.routing.CostVar().Max())
        self.solutions += 1
        t = time.perf_counter() - self.t0
        if self.best is None or value < self.best:
            self.best, self.last = value, t
            nxt = self.routing.NextVar
            self.points.append((t, value, sum(1 for i in self.stops if nxt(i).Value() == i)))
        if self.reason is not None:
            return
        stop = self.flag is not None and self.flag.is_set()
        if stop or (self.rule is not None and self.rule.should_stop(t, self.last)):
            self.reason, self.ended_at = ("STOPPED" if stop else "CONVERGED"), t
            self.routing.solver().FinishCurrentSearch()

    def report(self) -> dict:
        pts = self.points
        if len(pts) > 12:
            end = pts[-1][0]
            keep = [pts[0]]
            for k in range(1, 11):
                upto = [p for p in pts if p[0] <= end * k / 11]
                if upto and upto[-1] is not keep[-1]:
                    keep.append(upto[-1])
            if keep[-1] is not pts[-1]:
                keep.append(pts[-1])
            pts = keep
        elapsed = self.ended_at if self.ended_at is not None else time.perf_counter() - self.t0
        return {
            "reason": self.reason,
            "last_improvement_sec": round(self.last, 1) if self.points else None,
            # No plan seen, no stall to report ("no better plan for 5 min" after a 1 s search).
            "stall_sec": round(self.rule.stall_sec(elapsed), 1) if self.rule is not None and self.points else None,
            "points": [(round(t, 1), round(v / COST_SCALE, 2), left) for t, v, left in pts],
            "solutions": self.solutions,
        }


def _watch_search(name: str, cfg: DispatchConfig, n_stops: int, routing, manager=None) -> None:
    """THOROUGH only - a QUICK search gets nothing attached and runs exactly as before. RECOMMENDED
    gets the stall rule (never before QUICK's time for the day); the alternatives only the stop flag.
    ``manager``: the stops are nodes 1..n_stops (_solve_scenario), counted on each progress point."""
    if cfg.search_mode != "THOROUGH":
        return
    rule = stall_rule(cfg.time_limit_sec or auto_time_limit(n_stops)) if name == "RECOMMENDED" else None
    stops = [manager.NodeToIndex(k + 1) for k in range(n_stops)] if manager is not None else None
    watch = _SearchWatch(routing, rule, _STOP_FLAG, stops)
    # The callback is kept on the watch (and the watch in _WATCHES) for the whole search.
    watch.callback = watch.on_solution
    routing.AddAtSolutionCallback(watch.callback)
    _WATCHES[name] = watch


def _searched(args) -> tuple[DispatchScenario, dict | None]:
    """_scenario_worker, and the THOROUGH watch's report of that search (None for QUICK)."""
    _WATCHES.pop(args[0], None)
    sc = _scenario_worker(args)
    watch = _WATCHES.pop(args[0], None)
    return sc, (watch.report() if watch is not None else None)


def _stop_reason(mode: str, watch: dict | None, search_sec: float, limit: int, status: str | None = None) -> str:
    """Why RECOMMENDED's search stopped (SearchReport.stop_reason). ``status``: RECOMMENDED's own.
    In either mode, no search (every stop left out before it: NOTHING_TO_PLAN) is NOT_SEARCHED and a
    search that found no plan (NO_SOLUTION) is NO_PLAN - never "stopped when it stopped improving"
    nor QUICK's "automatic time" (skeptic review of the long-search PR)."""
    if status == "NOTHING_TO_PLAN":
        return "NOT_SEARCHED"
    if status == "NO_SOLUTION":
        return "NO_PLAN"
    if mode != "THOROUGH":
        return "TIME_LIMIT"
    if watch and watch.get("reason"):
        return str(watch["reason"])
    # Ended without the watch: on its time limit (the cap), or by itself before it.
    return "CAP" if search_sec >= limit - 1 else "CONVERGED"


def _search_report(mode: str, cap: int, state: dict, started: float) -> SearchReport:
    watch = state.get("watch")
    limit = int(state.get("limit") or 0)
    search_sec = float(state.get("search_sec") or 0.0)
    return SearchReport(
        mode=mode,  # type: ignore[arg-type]
        cap_sec=int(cap),
        limit_sec=limit,
        search_sec=round(search_sec, 1),
        used_sec=round(time.monotonic() - started, 1),
        stop_reason=_stop_reason(mode, watch, search_sec, limit, state.get("status")),  # type: ignore[arg-type]
        last_improvement_sec=(watch or {}).get("last_improvement_sec"),
        stall_sec=(watch or {}).get("stall_sec"),
        best_over_time=list((watch or {}).get("points") or []),
        solutions=(watch or {}).get("solutions"),
        pyvrp=PyvrpReport(**state["pyvrp"]) if state.get("pyvrp") else None,
    )


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
    # config.loading_from_min (a plan made on its delivery day): loading cannot start before it.
    loading_from_s: int | None = None
    # The payload in 0.1 kg units (payload_units; 0 = unconstrained): what every kg check compares
    # with (audit F08). Derived from max_kg when not given.
    max_kg_units: int = -1
    # Driver break (config.break_min; _break_state). DUE: the new loads must hold the break unless
    # the truck-day needs none (load_repack.time_truck / timing_ok / repack); OFF (no rule),
    # NOT_NEEDED, IN_FROZEN_LOAD, NOT_POSSIBLE: nothing to plan. break_lo_s: the earliest start -
    # the window start, the last frozen return and the time a same-day plan was made (idle time
    # before the plan does not count); break_hi_s = break_to_s: the window end.
    break_state: str = "OFF"
    break_s: int = 0
    break_lo_s: int = 0
    break_hi_s: int = 0
    break_from_s: int = 0
    break_to_s: int = 0
    break_note: str | None = None  # a warning for the dispatcher (NOT_POSSIBLE, too late for a break)
    # Pallets (owner decision 4 Oct 2026). A truck with bays is planned by pallets: max_pallet_units =
    # bays x config.pallet_fill_pct x 10 (1/1000 pallet); its max_cases is then the request's cases + 1
    # (CASES_FREE: no case limit, so every case comparison holds unchanged). 0 / None: by cases.
    bays: int | None = None
    max_pallet_units: int = 0
    # A full truck in cases for the search's turnaround estimate (_approx_gap_s): max_cases, or on a
    # bay truck its pallet room x the day's cases per pallet. Derived from max_cases when not given.
    full_cases: int = -1

    def __post_init__(self) -> None:
        if self.max_kg_units < 0:
            self.max_kg_units = payload_units(self.max_kg)
        if self.full_cases < 0:
            self.full_cases = self.max_cases

    @property
    def by_pallets(self) -> bool:
        """Planned by pallets (the truck has bays): pallet units and kg are its limits, not cases."""
        return self.max_pallet_units > 0

    @property
    def usable(self) -> bool:
        return self.trips_left > 0 and self.latest_return_s > self.earliest_depart_s

    @property
    def ready_s(self) -> int | None:
        """When loading of the truck's first new load can start: the later of its last frozen return
        and the time a same-day plan was made (loading_from_s). The first new load leaves no earlier
        than this + reload + loading of ITS cases. None: loaded before the shift starts (a plan for a
        later day, no frozen loads). Driver pay does not use it (costing.py: frozen_return_s)."""
        if self.frozen_return_s is None:
            return self.loading_from_s
        if self.loading_from_s is None:
            return self.frozen_return_s
        return max(self.frozen_return_s, self.loading_from_s)


def _new_load_start_min(req: DispatchRequest) -> int:
    """The earliest any new load may leave, before a truck's own hours and frozen loads: the later
    of the first departure (shift_start_min; on a plan made on its delivery day the web sends now +
    turnaround), the depot opening and, with loading_from_min, that time + the turnaround."""
    cfg = req.config
    start = max(cfg.shift_start_min, req.depot.open_min)
    if cfg.loading_from_min is not None:
        start = max(start, cfg.loading_from_min + cfg.reload_min)
    return start


def _depot_close_min(req: DispatchRequest) -> int:
    """The depot's closing time; 0 (not set) is the end of the day."""
    return req.depot.close_min if req.depot.close_min > 0 else DAY_MIN


def _truck_hours(req: DispatchRequest, t: DispatchTruck) -> tuple[int, int]:
    """The truck's time for new loads before its frozen loads are counted: from the day's start
    (``_new_load_start_min``) or its own availability, to the depot closing, its own end or the
    latest return (config.latest_return_min, an absolute time: 18:00 whenever the truck leaves)."""
    cfg = req.config
    latest = min(_depot_close_min(req), t.available_to_min or DAY_MIN * 2)
    if cfg.latest_return_min is not None:
        latest = min(latest, cfg.latest_return_min)
    return max(_new_load_start_min(req), t.available_from_min or 0), latest


def _truck_days(req: DispatchRequest) -> list[TruckDay]:
    cfg = req.config
    out: list[TruckDay] = []
    # Pallets: a bay truck has no case limit (CASES_FREE, more than the whole request); its full load
    # in cases for the search's turnaround estimate uses the day's average cases per pallet.
    cases_free = sum(s.demand_cases for s in req.stops) + 1
    day_units = sum(s.demand_pallet_units or 0 for s in req.stops)
    day_cases = sum(s.demand_cases for s in req.stops)
    for i, t in enumerate(req.trucks):
        max_trips = t.max_trips or cfg.max_trips_per_truck
        frozen = sorted(t.frozen_trips, key=lambda f: f.load_no)
        earliest, latest = _truck_hours(req, t)
        anchor = frozen_return = None
        if frozen:
            anchor = min(f.depart_min for f in frozen)
            frozen_return = max(f.return_min for f in frozen)
            earliest = max(earliest, frozen_return + cfg.reload_min)
        if anchor is not None:
            latest = min(latest, anchor + cfg.shift_max_min)
        brk = _break_state(cfg, t, frozen, earliest, latest)
        if brk.pop("latest", None) is not None:
            latest = min(latest, cfg.break_start_to_min)
        pal: dict = {}
        if t.bays is not None:
            room = pallet_room_units(t.bays, cfg.pallet_fill_pct)
            full = int(round(room * day_cases / day_units)) if day_units > 0 else 0
            pal = dict(bays=t.bays, max_pallet_units=room, full_cases=full)
        out.append(
            TruckDay(
                truck=t,
                idx=i,
                n_frozen=len(frozen),
                trips_left=max(0, max_trips - len(frozen)),
                earliest_depart_s=earliest * 60,
                latest_return_s=latest * 60,
                shift_anchor_s=anchor * 60 if anchor is not None else None,
                max_cases=cases_free if t.bays is not None else t.capacity_cases,
                max_kg=t.capacity_kg,
                frozen_return_s=frozen_return * 60 if frozen_return is not None else None,
                loading_from_s=cfg.loading_from_min * 60 if cfg.loading_from_min is not None else None,
                **brk,
                **pal,
            )
        )
    return out


def break_rule(cfg: DispatchConfig) -> tuple[int, int, int] | None:
    """(length, earliest start, latest start) in minutes of the driver break, or None: no break
    (break_min 0, or settings that cannot work - break_rule_problem says which)."""
    if cfg.break_min <= 0 or break_rule_problem(cfg):
        return None
    return cfg.break_min, cfg.break_start_from_min, cfg.break_start_to_min


def break_rule_problem(cfg: DispatchConfig) -> str | None:
    """Break settings that cannot work plan no break, with this warning (never a 422)."""
    if cfg.break_min <= 0:
        return None
    if cfg.break_start_from_min > cfg.break_start_to_min:
        return (f"No driver break was planned: the break may start from {_hhmm(cfg.break_start_from_min)}, which is after "
                f"its latest start {_hhmm(cfg.break_start_to_min)}. Correct it in Settings.")
    if cfg.break_min >= cfg.shift_max_min:
        return (f"No driver break was planned: the {cfg.break_min}-min break is not shorter than the driver shift maximum "
                f"({cfg.shift_max_min} min). Correct it in Settings.")
    return None


def _break_state(cfg: DispatchConfig, t: DispatchTruck, frozen: list, earliest: int, latest: int) -> dict:
    """The driver-break fields of one truck-day (TruckDay.break_*), decided by TIMES only, never by
    load status: a truck-day needs a break when its first departure (frozen loads included) is
    before the window start and it is still out after the window end. "latest" in the result: new
    loads must be back by the window end (the break can no longer be planned)."""
    rule = break_rule(cfg)
    if rule is None:
        return {}
    L, bf, bt = rule
    out: dict = dict(break_s=L * 60, break_from_s=bf * 60, break_to_s=bt * 60, break_hi_s=bt * 60, break_lo_s=bf * 60)
    code = t.code or t.id
    if frozen:
        trips = sorted(frozen, key=lambda f: f.depart_min)
        anchor = trips[0].depart_min
        last = max(f.return_min for f in frozen)
        if any(f.break_start_min is not None for f in frozen):
            return {**out, "break_state": "IN_FROZEN_LOAD"}
        if anchor >= bf:
            return {**out, "break_state": "NOT_NEEDED"}  # the day started at the window start or later
        for a, b in zip(trips, trips[1:]):  # a depot gap between locked loads that holds the break
            start = max(bf, a.return_min)
            if start <= bt and start + L <= b.depart_min:
                return {**out, "break_state": "IN_FROZEN_LOAD"}
        if last > bt:
            return {**out, "break_state": "NOT_POSSIBLE", "break_note": (
                f"{code}: no driver break is recorded for its locked or dispatched loads ({_hhmm(anchor)}-{_hhmm(last)}), and "
                "they run past the break window; no break can be added now.")}
        lo = max(bf, last, cfg.loading_from_min or 0)
        if lo > bt:
            return {**out, "break_state": "NOT_NEEDED", "latest": bt, "break_note": (
                f"{code}: its driver break can no longer start by {_hhmm(bt)} (the time before this plan does not count), "
                "so it takes no new load after its locked or dispatched loads.")}
        return {**out, "break_state": "DUE", "break_lo_s": lo * 60}
    if earliest >= bf or latest <= bt:
        return {**out, "break_state": "NOT_NEEDED"}  # starts at the window start or later / back by its end
    return {**out, "break_state": "DUE", "break_lo_s": max(bf, cfg.loading_from_min or 0) * 60}


def _approx_gap_s(cfg: DispatchConfig, td: TruckDay) -> int:
    """Turnaround before a truck's next load as the route search sees it: the next load's size
    is unknown there, so loading is costed for 80% of a full truck (TruckDay.full_cases: its case
    capacity, or on a truck with bays its pallet room x the day's average cases per pallet). The
    final timing uses the exact ``reload_min + loading_min_per_case x cases`` of each load (load_repack)."""
    return int(round((cfg.reload_min + cfg.loading_min_per_case * td.full_cases * 0.8) * 60))


def _search_day_end(td: TruckDay, first_s: int, shift_s: int) -> tuple[int, int]:
    """(latest route end, longest route span) in seconds that the route searches give a truck-day
    whose first new load may leave at ``first_s``. Driver break: the searches stay break-free
    (breaks in the search found far fewer plans in the design runs); a truck-day that may need one
    (DUE) keeps the break's length free of its shift, so the exact stages (load_repack) can insert
    it. The span shrinks, and so does the latest return when frozen loads anchor the shift or the
    depot closing / the truck's hours end the day before the shift does. The exact stages use the
    true shift. One rule for the engine's search and the second search (pyvrp_candidate)."""
    margin = td.break_s if td.break_state == "DUE" else 0
    end_max = td.latest_return_s
    if margin and (td.shift_anchor_s is not None or td.latest_return_s - td.earliest_depart_s < shift_s):
        end_max = max(min(first_s, td.latest_return_s), td.latest_return_s - margin)
    return max(td.earliest_depart_s, end_max), shift_s - margin


def _need_in(s: DispatchStop, by_pallets: bool) -> int:
    """A stop's space in one measure: its pallet units (1/1000 pallet) or its cases."""
    return (s.demand_pallet_units or 0) if by_pallets else s.demand_cases


def _room(td: TruckDay) -> int:
    """A truck's space per load in its own measure: pallet units on a truck with bays, else cases."""
    return td.max_pallet_units if td.by_pallets else td.max_cases


def _space_text(by_pallets: bool, amount: int) -> str:
    """An amount of space for a message: "11.4 pallets" or "570 cases"."""
    return f"{pallet_text(amount)} pallets" if by_pallets else f"{amount} cases"


def _fits_capacity(stop: DispatchStop, td: TruckDay) -> bool:
    """The stop alone fits the truck: its pallets (a truck with bays) or cases, and its kg."""
    if _need_in(stop, td.by_pallets) > _room(td):
        return False
    if td.max_kg_units > 0 and kg_units(stop.demand_kg) > td.max_kg_units:
        return False
    return True


def _unserved(stop: DispatchStop, code: str, msg: str) -> UnservedStop:
    return UnservedStop(stop_id=stop.stop_id, order_ids=list(stop.order_ids), reason_code=code, reason_message=msg)  # type: ignore[arg-type]


# The route search's own status (OR-Tools RoutingSearchStatus) in plain words for the dispatcher
# (scenario tests, PR6): the raw name stays in solver_status only.
_NO_PLAN_WORDS = {
    "ROUTING_FAIL_TIMEOUT": "no plan was found in the time allowed",
    "ROUTING_FAIL": "the search found no way to plan these stops with these trucks and limits",
    "ROUTING_INFEASIBLE": "no plan is possible with these trucks and limits",
    "ROUTING_INVALID": "the route search could not start with this day's data",
    "ROUTING_NOT_SOLVED": "the route search did not run",
}


def _no_plan_message(status_name: str) -> str:
    """The unserved reason when the route search returned no plan at all."""
    why = _NO_PLAN_WORDS.get(status_name, "no plan was found")
    return f"The optimizer found no feasible plan: {why}. Re-plan to search again, or check trucks and customer hours."


@dataclass(frozen=True)
class _Fleet:
    """What the usable trucks can carry in their loads left, against what the stops ask for.

    space: the measure a space shortage can be claimed in - "cases" when no usable truck has bays,
    "pallets" when every usable truck has bays, None for a mixed fleet (a stop may go on a truck of
    either measure, so no space total exists: a shortage is claimed only when _mixed_space_proven
    shows that the stops' smallest shares of a truck need more loads than the usable trips, never a
    false "shortage"). Weight bounds the day when every usable truck has a payload (0 = kg not
    limited): a day can be short of kg while its space would fit (scenario test S03). In 0.1 kg
    units, no margin (audit F08): 3,000.1 kg on 3,000 kg is short. trips: the usable trips (loads
    left) of the day."""

    space: str | None
    cap_space: int
    demand_space: int
    cap_kg_u: int
    demand_kg_u: int
    kg_bound: bool
    fill_pct: int = PALLET_FILL_DEFAULT
    trips: int = 0

    @property
    def by_pallets(self) -> bool:
        return self.space == "pallets"

    def stop_space(self, s: DispatchStop) -> int:
        return _need_in(s, self.by_pallets)

    def text(self, amount: int) -> str:
        return _space_text(self.by_pallets, amount)


def _fleet(stops: list[DispatchStop], tds: list[TruckDay], fill_pct: int = PALLET_FILL_DEFAULT) -> _Fleet:
    usable_tds = [td for td in tds if td.usable]
    kg_bound = bool(usable_tds) and all(td.max_kg_units > 0 for td in usable_tds)
    cap_u = sum(td.max_kg_units * td.trips_left for td in usable_tds) if kg_bound else 0
    demand_u = sum(kg_units(s.demand_kg) for s in stops)
    trips = sum(td.trips_left for td in usable_tds)
    if usable_tds and all(td.by_pallets for td in usable_tds):
        return _Fleet("pallets", sum(td.max_pallet_units * td.trips_left for td in usable_tds),
                      sum(s.demand_pallet_units or 0 for s in stops), cap_u, demand_u, kg_bound, fill_pct, trips)
    if not any(td.by_pallets for td in usable_tds):
        return _Fleet("cases", sum(td.max_cases * td.trips_left for td in usable_tds), sum(s.demand_cases for s in stops),
                      cap_u, demand_u, kg_bound, fill_pct, trips)
    return _Fleet(None, 0, 0, cap_u, demand_u, kg_bound, fill_pct, trips)


def _mixed_space_proven(needs: list[tuple[int, int | None]], usable_tds: list[TruckDay], halves: bool) -> bool:
    """A sound proof, for a fleet that mixes trucks with and without bays, that no packing of the
    usable trips carries every one of `needs` ((cases, pallet units) per stop). A stop's share of a
    truck is its need in that truck's own measure (pallet units on a truck with bays, cases on the
    others) over the truck's room per load; a trip carries at most 1 in total, whichever truck it is:
    - the stops' smallest shares add up to more than the usable trips (the space total of a fleet of
      one measure, in shares);
    - halves: more stops are over half of every usable truck than there are usable trips (no two such
      stops share a load, whatever the packing: 3 stops of 90 cases / 1.0 pallet on a 2-bay truck and
      a 90-case truck, one load each).
    Exact fractions, no margin. Times and kg are not checked: a check that passes proves the stops
    cannot all go, one that fails proves nothing."""
    trips = sum(td.trips_left for td in usable_tds)
    rooms = {(td.by_pallets, _room(td)) for td in usable_tds if td.trips_left > 0}
    if not rooms:
        return bool(needs)

    def shares(cases: int, units: int | None) -> list[Fraction]:
        out = []
        for bp, room in rooms:
            need = (units or 0) if bp else cases
            # A truck with no room carries only a stop that needs none.
            out.append(Fraction(need, room) if room > 0 else Fraction(0 if need <= 0 else trips + 1))
        return out

    total, big = Fraction(0), 0
    for cases, units in needs:
        sh = shares(cases, units)
        total += min(sh)
        big += all(2 * x > 1 for x in sh)
    return total > trips or (halves and big > trips)


def _shortage_reason(priority: int, f: _Fleet, short_space: bool, short_kg: bool, demand_cases: int) -> str:
    """The unserved reason on a fleet-shortage day, in cases / pallets and / or kg - whichever the
    trucks are short of (scenario test S03: a weight-bound day was explained in cases only)."""
    tail = f" Lower priorities are left out first (this is P{priority})."
    demand_kg, cap_kg = f.demand_kg_u / 10, f.cap_kg_u / 10
    fill = f" (the bays at {f.fill_pct}% Pallet fill)" if f.by_pallets else ""
    if f.space is None and short_space:
        # A mixed fleet has no space total: what is proven is that the loads left cannot carry every stop.
        kg = (f" Also by weight: {kg_text(demand_kg)} kg requested vs {kg_text(cap_kg)} kg across all available loads."
              if short_kg else "")
        return (f"Fleet capacity shortage: the {f.trips} load{'' if f.trips == 1 else 's'} the trucks have left cannot carry "
                "every stop of the day (measured in pallets on the trucks with bays and in cases on the others)." + kg + tail)
    if short_kg and not short_space:
        if f.space is None:  # a mixed fleet: nothing is claimed about its space
            return (f"Fleet capacity shortage by weight: {kg_text(demand_kg)} kg requested vs {kg_text(cap_kg)} kg across all "
                    "available loads." + tail)
        fits = (f"the {f.text(f.demand_space)} would fit in the bays" if f.by_pallets else
                f"the {demand_cases} cases would fit by count")
        return (f"Fleet capacity shortage by weight: {kg_text(demand_kg)} kg requested vs {kg_text(cap_kg)} kg across all "
                f"available loads ({fits}; the weight does not)." + tail)
    if short_kg and short_space:
        tighter = "weight" if demand_kg * f.cap_space > f.demand_space * cap_kg else (
            "the bays" if f.by_pallets else "the case count")
        return (f"Fleet capacity shortage: {f.text(f.demand_space)} / {kg_text(demand_kg)} kg requested vs "
                f"{f.text(f.cap_space)} / {kg_text(cap_kg)} kg across all available loads{fill}; {tighter} is the tighter "
                "limit today." + tail)
    return (f"Fleet capacity shortage: {f.text(f.demand_space)} requested vs {f.text(f.cap_space)} across all available "
            f"loads{fill}." + tail)


Room = tuple[bool, int, float]  # (by pallets, space left in that measure, kg left in 0.1 kg units)


def _rooms(usable_tds: list[TruckDay], loads: list[PlannedLoad],
           takes_room: Callable[[PlannedStop], bool] | None = None) -> list[Room]:
    """The room left on each load of the plan and on each load slot a truck did not use (a full
    truck's room): (by pallets, space - pallet units on a truck with bays, else cases -, kg in 0.1 kg
    units; inf when the truck has no payload). takes_room: which planned stops count as taking room
    (all by default; _no_room_reason counts only the stops of the same or a higher priority, since
    strict priorities drop lower ones first)."""
    by_truck: dict[str, list[PlannedLoad]] = {}
    for ld in loads:
        by_truck.setdefault(ld.truck_id, []).append(ld)
    rooms: list[Room] = []
    for td in usable_tds:
        mine = by_truck.get(td.truck.id, [])
        kg_cap = td.max_kg_units if td.max_kg_units > 0 else math.inf
        bp, cap = td.by_pallets, _room(td)
        for ld in mine:
            taken = ld.stops if takes_room is None else [st for st in ld.stops if takes_room(st)]
            used = sum((st.pallet_units or 0) for st in taken) if bp else sum(st.cases for st in taken)
            rooms.append((bp, cap - used, kg_cap - sum(kg_units(st.kg) for st in taken)))
        rooms += [(bp, cap, kg_cap)] * max(0, td.trips_left - len(mine))
    return rooms


def _fits_room_left(left: list[DispatchStop], usable_tds: list[TruckDay], loads: list[PlannedLoad]) -> bool:
    """Whether any of the unserved stops fits, by space (cases, or pallets on a truck with bays) AND
    by kg, the room left on a load of the plan or on a load slot a truck did not use (a full truck's
    room). False: every unserved stop is bigger than the room left anywhere, so a fleet shortage
    explains all of it, however many loads the room is spread over. In 0.1 kg units, with no margin
    (audit F08)."""
    rooms = _rooms(usable_tds, loads)
    return any(_need_in(s, bp) <= rs and kg_units(s.demand_kg) <= rk for s in left for bp, rs, rk in rooms)


def _no_packing_fits(s: DispatchStop, usable_tds: list[TruckDay], kept: list[PlannedStop]) -> bool:
    """Whether a sound check proves that no packing of the usable trips carries the stop together
    with `kept` (the stops of its priority or higher the plan serves). The room left on each load
    says only that THIS packing has none (A6 second review: 1,000 + 1,500 + 1,500 + 1,000 + 1,000 kg
    on 2 trucks x 1 load of 3,000 kg fit as {1,500, 1,500} and {1,000 x 3}, but the route search
    packed {1,000, 1,500} twice). Two checks, in space and in kg (0.1 kg units, no margin):
    - they are more than all usable trips carry together;
    - more of them are over half the biggest truck than there are usable trips (no two such stops
      share a load, whatever the packing: 3 x 1,600 kg on 2 x 3,000 kg).
    Space is cases when no usable truck has bays and pallet units when every one has bays; a mixed
    fleet is measured per truck in its own measure (_mixed_space_proven: each stop's share of each
    truck, the same two checks in shares - pallets review: a stop no load could take was told to
    "re-plan to search again").
    Times and hours are not checked: a check that passes proves the stop cannot go, one that fails
    proves nothing."""
    if not usable_tds:
        return True
    trips = sum(td.trips_left for td in usable_tds)

    def proven(sizes: list[float], caps: list[tuple[float, int]]) -> bool:
        biggest = max(c for c, _ in caps)
        return sum(sizes) > sum(c * n for c, n in caps) or sum(2 * x > biggest for x in sizes) > trips

    if not any(td.by_pallets for td in usable_tds) and proven(
            [st.cases for st in kept] + [s.demand_cases], [(td.max_cases, td.trips_left) for td in usable_tds]):
        return True
    if all(td.by_pallets for td in usable_tds) and proven(
            [st.pallet_units or 0 for st in kept] + [s.demand_pallet_units or 0],
            [(td.max_pallet_units, td.trips_left) for td in usable_tds]):
        return True
    if any(td.by_pallets for td in usable_tds) and not all(td.by_pallets for td in usable_tds) and _mixed_space_proven(
            [(st.cases, st.pallet_units) for st in kept] + [(s.demand_cases, s.demand_pallet_units)], usable_tds, halves=True):
        return True
    # kg bounds every packing only when every usable truck has a payload (0 = kg not limited).
    return all(td.max_kg_units > 0 for td in usable_tds) and proven(
        [kg_units(st.kg) for st in kept] + [kg_units(s.demand_kg)], [(td.max_kg_units, td.trips_left) for td in usable_tds])


def _no_room_reason(s: DispatchStop, usable_tds: list[TruckDay], loads: list[PlannedLoad],
                    priority_of: dict[str, int]) -> str | None:
    """The true reason a stop that no load and no free trip has room for is left out (audit F08
    verifiers: such a stop said "the optimizer found no truck, trip or time slot ... Re-plan to
    search again", as if more search time could serve it). The room on a load counts only its stops
    of the same or a higher priority (A6 review): strict priorities drop lower ones first, so a stop
    left out by TIME while P5 stops fill the loads is not "left out for its weight". None when some
    load or free trip has room for it that way, by cases AND kg, or when no check proves that another
    packing of those stops could not carry it (A6 second review, `_no_packing_fits`): then nothing
    proves it could not go, and the time-limited search's own reason (and its warning) stays."""
    def same_or_higher(st: PlannedStop) -> bool:
        return priority_of[st.stop_id] <= s.priority

    rooms = _rooms(usable_tds, loads, same_or_higher)
    u = kg_units(s.demand_kg)
    if any(_need_in(s, bp) <= rs and u <= rk for bp, rs, rk in rooms):
        return None
    if not _no_packing_fits(s, usable_tds, [st for ld in loads for st in ld.stops if same_or_higher(st)]):
        return None
    # "Lowest priorities first" only when the day has lower-priority stops and none of them rides.
    lower_served = any(priority_of[st.stop_id] > s.priority for ld in loads for st in ld.stops)
    lower_on_day = any(p > s.priority for p in priority_of.values())
    even, left = (", even with every lower-priority stop taken off", "then the most room") if lower_served else (
        "", "the most room left")
    tail = (f" This P{s.priority} stop was left out{' (lowest priorities first)' if lower_on_day and not lower_served else ''}. "
            "Add a truck or raise the loads-per-truck limit.")
    kinds = sorted({bp for bp, _, _ in rooms})  # [False] cases only, [True] pallets only, both: mixed
    its = " / ".join(_space_text(bp, _need_in(s, bp)) for bp in kinds) or f"{s.demand_cases} cases"
    by_space = [rk for bp, rs, rk in rooms if _need_in(s, bp) <= rs]
    if by_space:  # its cases / pallets fit somewhere, its weight does not
        return (f"Not planned: no load or free trip has room for its {kg_text(u / 10)} kg{even} ({left} on a load "
                f"that takes its {its} is {kg_text(max(0.0, max(by_space)) / 10)} kg)." + tail)
    most = " / ".join(_space_text(bp, max(0, max((rs for k, rs, _ in rooms if k == bp), default=0))) for bp in kinds) or "0 cases"
    return (f"Not planned: no load or free trip has room for its {its}{even} ({left} is {most})." + tail)


def _day_hhmm(m: int) -> str:
    """A time of the delivery day; 24:00 and later read "24:00", the end of the day (as the web's
    "Planned from" warning)."""
    return "24:00" if m >= DAY_MIN else _hhmm(m)


def _no_usable_truck(req: DispatchRequest, tds: list[TruckDay]) -> tuple[str, str, str]:
    """Why no truck can take a new load (no TruckDay is usable): the reason code and text every stop
    gets, and the plan warning. Each truck is blamed for what actually closes it (PR8 rebase review):
    a plan whose start (a same-day plan: now + turnaround) is at or after the depot closing, or a
    truck outside its available hours, is not reported as busy with locked/dispatched loads - only a
    truck that has such loads is."""
    if all(td.trips_left == 0 for td in tds):
        return ("TRIP_LIMIT", "Every truck has already used its maximum number of loads (locked/dispatched).",
                "No truck has capacity left for new loads.")
    start, close = _new_load_start_min(req), _depot_close_min(req)
    same_day = req.config.loading_from_min is not None
    if start >= close:  # nothing can leave, whatever a truck's hours or loads
        closing = f"the depot closes at {_day_hhmm(close)}" if close < DAY_MIN else "the delivery day ends at 24:00"
        msg = (f"Planned on the delivery day from {_day_hhmm(start)}: {closing}, so no new load can leave today."
               if same_day else f"The first departure is {_day_hhmm(start)} and {closing}, so no new load can leave.")
        return "SHIFT_LIMIT", msg, msg
    # Trucks with loads left whose own hours hold no time for a new load (frozen loads aside). Every
    # other unusable truck has frozen loads: its time after them (or its shift) is what is gone.
    hours = {td.idx: _truck_hours(req, td.truck) for td in tds}
    off_hours = [td for td in tds if td.trips_left > 0 and hours[td.idx][0] >= hours[td.idx][1]]
    if not off_hours:
        return ("SHIFT_LIMIT", "No truck has shift time left after its locked/dispatched loads.",
                "No truck has capacity left for new loads.")
    span = f"between {_day_hhmm(start)} and " + (f"the depot closing at {_day_hhmm(close)}" if close < DAY_MIN else "24:00")
    msg = (f"No truck is available for a new load {span}: every truck's available hours are outside that time."
           if len(off_hours) == len(tds) else
           f"No truck has time left for a new load {span}: some are taken up by their locked/dispatched loads, "
           "the others are outside their available hours.")
    if same_day:
        msg = f"Planned on the delivery day from {_day_hhmm(start)}. {msg}"
    return "SHIFT_LIMIT", msg, msg


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
        code, msg, warning = _no_usable_truck(req, tds)
        return [], [_unserved(s, code, msg) for s in req.stops], [warning]
    solvable: list[DispatchStop] = []
    bay_tds = [td for td in usable if td.by_pallets]
    case_tds = [td for td in usable if not td.by_pallets]
    for s in req.stops:
        if not any(_fits_capacity(s, td) for td in usable):
            kg_trucks = [td.max_kg_units for td in usable if td.max_kg_units > 0]
            parts = []
            if bay_tds:  # the measure of the largest trucks, pallets and / or cases (mixed fleet)
                big = max(bay_tds, key=lambda td: td.max_pallet_units)
                parts.append(f"{pallet_text(s.demand_pallet_units or 0)} pallets vs largest truck "
                             f"{pallet_text(big.max_pallet_units)} pallets: {big.bays} bays at {req.config.pallet_fill_pct}% fill")
            if case_tds:
                parts.append(f"{s.demand_cases} cases vs largest truck{' without bays' if bay_tds else ''} "
                             f"{max(td.max_cases for td in case_tds)} cases")
            detail = "; ".join(parts)
            if kg_trucks and kg_units(s.demand_kg) > max(kg_trucks):
                detail += f"; {kg_text(s.demand_kg)} kg vs largest payload {kg_text(max(kg_trucks) / 10)} kg"
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
        he = LR.latest_start_s(s, cfg.window_rule)  # FINISH: closing - stop time
        finish_rule = cfg.window_rule == "FINISH" and s.hard_end_min is not None
        if finish_rule and he < hs:
            # Unloading is longer than the receiving hours: it can never finish by closing. It
            # must be dropped here - an empty time range fails the whole route model.
            drops.append(_unserved(s, "HARD_WINDOW_INFEASIBLE",
                                   f"Unloading takes {s.service_min} min, but the receiving hours "
                                   f"{_hhmm(s.hard_start_min or 0)}-{_hhmm(s.hard_end_min)} are only "
                                   f"{s.hard_end_min - (s.hard_start_min or 0)} min long: it can never finish before closing."))
            continue
        window_ok = False
        shift_ok = False
        # These are the only reasons presented as proof of impossibility: say when the proof
        # rests on an estimated distance (review F18, new issue 27).
        est = " (based on estimated distance)" if (mx.leg_estimated(0, node) or mx.leg_estimated(node, 0)) else ""
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
            earliest = _hhmm(min(td.earliest_depart_s for td in usable) // 60 + out_s // 60)
            if finish_rule:
                msg = (f"No truck can reach this customer early enough to finish unloading ({s.service_min} min) "
                       f"by closing ({_hhmm(s.hard_end_min)}): earliest possible arrival {earliest}{est}.")
            else:
                msg = (f"No truck can reach this customer inside its receiving window {hw} "
                       f"(earliest possible arrival {earliest}){est}.")
            drops.append(_unserved(s, "HARD_WINDOW_INFEASIBLE", msg))
        elif not shift_ok:
            drops.append(_unserved(s, "SHIFT_LIMIT",
                                   f"A round trip to this customer does not fit inside the truck shift / depot hours{est}."))
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


def _strict_weights(counts: dict[int, int], with_margin: bool = False, hire_top: int = 0) -> dict[int, int]:
    """w_5 = 1, w_p = 1 + sum_{q>p} n_q x w_q: one stop of priority p is worth more than ALL
    lower-priority stops of the day together. With margins every lower stop may carry up to 0.4
    of a unit on top, so each counts as w_q + 1 and margins can never add up past a priority.
    ``hire_top`` (the hire suggestion's what-if, _hire_tier): every P1-P3 weight carries the dearest
    rented truck's tier on top, so one P1-P3 stop outweighs it and every lower stop."""
    w = {5: 1}
    for p in (4, 3, 2, 1):
        w[p] = 1 + sum(counts.get(q, 0) * (w[q] + (1 if with_margin else 0)) for q in range(p + 1, 6)) + (hire_top if p <= 3 else 0)
    return w


def _service_values(stops: list[DispatchStop], cfg: DispatchConfig, use_margin: bool, trucks=(),
                    depot=None) -> tuple[list[int], list[str]]:
    """Objective units lost when each stop is left unserved (the drop penalty), plus warnings
    (_service_and_hire without the hire tier itself)."""
    values, warnings, _ = _service_and_hire(stops, cfg, use_margin, trucks, depot)
    return values, warnings


def _service_and_hire(stops: list[DispatchStop], cfg: DispatchConfig, use_margin: bool,
                      trucks=(), depot=None) -> tuple[list[int], list[str], dict[str, int]]:
    """Objective units lost when each stop is left unserved (the drop penalty), plus warnings, and the
    hire tier of each truck to rent among ``trucks`` (truck id -> objective units; {} without any).
    ``depot``: for the options' own km charge in the tier (_hire_day_km); None counts none.

    Strict: SERVICE_BASE x w_p (see _strict_weights). The weights grow like the product of the
    per-priority counts; all penalties together must stay below PENALTY_LIMIT (int64 objective).
    Beyond it the base is scaled down (to no less than 100 OMR per weight unit, so service still
    dominates cost), and past that the weights are capped: priorities are then no longer strict
    between the capped levels, which is logged and reported. Real NMWC days (a few hundred stops)
    are orders of magnitude below the limit (400 stops with margins: ~7e17 of 4.6e18).

    The hire tier (trucks to rent, the hire suggestion): a level between the P1-P3 and the P4/P5 stops
    (_hire_tier), counted in the total, so the drop penalties and every rented truck's tier together
    stay below the limit - in money units coarse enough that a day whose own weights stay strict stays
    strict with them."""
    money = _hire_money_of(stops, cfg, trucks, depot)
    if not cfg.strict_priorities:
        return _weighted_hire(stops, [_stop_value(s, cfg, use_margin) for s in stops], trucks, money)
    counts = Counter(s.priority for s in stops)
    tier = _hire_tier(stops, trucks, use_margin, money)
    units, top = (tier.units, tier.top) if tier is not None else ({}, 0)
    w = _strict_weights(counts, use_margin, top)
    total = sum(w[s.priority] for s in stops) + (len(stops) if use_margin else 0) + int(math.ceil(sum(units.values())))
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
    # A rented truck never weighs more than a P3 stop, also when the weights had to be capped.
    hire = {tid: min(int(round(base * u)), base * max(1, w[3] - 1)) for tid, u in units.items()}
    return out, warnings, hire


def _weighted_hire(stops: list[DispatchStop], values: list[int], trucks,
                   money: dict[str, float] | None = None) -> tuple[list[int], list[str], dict[str, int]]:
    """The hire tier with weighted priorities (strict_priorities=false; the web always sends strict):
    1 OMR of hire weighs more than every P4/P5 stop together (+ one service unit), and every P1-P3 stop
    carries the dearest rented truck and every P4/P5 stop on top. Scaled down together when the total
    would pass PENALTY_LIMIT."""
    hires = [t for t in trucks if t.hire_candidate]
    if not hires:
        return values, [], {}
    low = sum(v for v, s in zip(values, stops) if s.priority >= 4)
    unit = low + SERVICE_UNIT
    hire = {t.id: int(math.ceil(unit * max(1.0, (money or {}).get(t.id, hire_money(t))))) for t in hires}
    top = max(hire.values())
    out = [v + top + low if s.priority <= 3 else v for v, s in zip(values, stops)]
    total = sum(out) + sum(hire.values())
    if total > PENALTY_LIMIT:
        f = -(-total // (PENALTY_LIMIT // 2))
        out = [max(1, v // f) for v in out]
        hire = {k: max(1, v // f) for k, v in hire.items()}
    return out, [], hire


def _margin_bonus(margin: float, cap: int) -> int:
    """Margin tie-break between stops of the SAME priority (strict priorities). Worth 10x the
    operating cost for small margins (MARGIN_WEIGHT, as in the weighted scheme), then saturating
    smoothly towards ``cap`` (0.4 unit) without ever flattening: a linear bonus capped at 0.4 of the
    1,000 OMR unit stopped telling margins apart above 40 OMR, so a 300 OMR order tied with a 50 OMR
    one. Here 50 -> ~222 OMR and 300 -> ~353 OMR of objective; 4,000 vs 4,001 OMR still differ."""
    m = margin * COST_SCALE * MARGIN_WEIGHT
    return int(round(cap * m / (m + cap)))


def _penalty_mult(values: list[int], w: ScenarioWeights, extra: int = 0) -> int:
    """How much one scenario's search multiplies the service values (_drop_penalties) - and the hire
    tier (``extra``: every rented truck's tier together, which the search scales alike)."""
    mult = 1 if w.pure_distance else int(math.ceil(max(1.0, w.fixed, w.trip, w.distance, w.time)))
    return max(1, min(mult, PENALTY_LIMIT // max(1, sum(values) + extra)))


def _drop_penalties(values: list[int], w: ScenarioWeights, extra: int = 0) -> list[int]:
    """Drop penalties of one scenario's search. Service values are sized against real money (a
    strict unit is 1,000 OMR, far above the cost of serving one stop); a scenario that multiplies
    the costs (MIN_TRUCKS: fixed x20, trip x5) multiplies them as much, or dropping a stop that
    needs its own truck (fixed 50+ OMR x 20 > 1,000) became cheaper than serving it. MIN_DISTANCE
    prices metres, which a unit outweighs anyway. The total stays below PENALTY_LIMIT."""
    mult = _penalty_mult(values, w, extra)
    return [v * mult for v in values]


def _repair_weights(stops: list[DispatchStop], ks: set[int], cfg: DispatchConfig, trucks=(), depot=None) -> dict[int, int]:
    """Small weights that rank the stops ``ks`` the way their service values do (the repack's
    phase 1 maximises them; the full strict values would not fit CP-SAT's objective). With trucks
    to rent (the hire suggestion) every P1-P3 weight carries the dearest rented truck's small tier
    (_hire_repair_weights) on top: phase 1 opens a rented truck for P1-P3 stops, never for P4/P5."""
    if not ks:
        return {}
    small = _hire_repair_weights(stops, cfg, trucks, depot)
    top = max(small.values(), default=0)
    if cfg.strict_priorities:
        w = _strict_weights(Counter(stops[k].priority for k in ks), hire_top=top)
        return {k: w[stops[k].priority] for k in ks}
    pw = cfg.priority_weights
    base = {k: max(1, int(round(100 * pw[stops[k].priority] / pw[5]))) for k in ks}
    if top:
        low = sum(max(1, int(round(100 * pw[s.priority] / pw[5]))) for s in stops if s.priority >= 4)
        base = {k: v + top + low if stops[k].priority <= 3 else v for k, v in base.items()}
    return base


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
    reports it (the routing model can only bound the return time from the shift start). On a truck
    with frozen loads both count only NEW overtime, after the later of its day start + overtime_after
    and its last frozen return (load_repack.overtime_bound_s, audit E4). The exact OMR rates ride
    along, so the RECOMMENDED score's money equals the reported costs (costing.py). A truck whose
    driver is paid by the day gets the search's tiny tie-breaker apart from its money (tie_m, tie_span:
    HIRE_TIE_KM_OMR on its km, _tie_span_units on its day; never in score().operating or cost)."""
    cfg = req.config
    w = SCENARIOS[name]
    # Trucks to rent (the hire suggestion): their hire tier with the service values (score) and on the
    # repack's small phase-1 weights - search only, never money.
    use_margin = cfg.use_margin and bool(stops) and all(s.margin is not None for s in stops)
    _, _, tier = _service_and_hire(stops, cfg, use_margin, req.trucks, req.depot)
    small = _hire_repair_weights(stops, cfg, req.trucks, req.depot)
    trucks = {
        td.idx: LR.TruckPrice(
            # A truck with frozen loads is already out today: no "open a truck" cost again, in any
            # scenario (MIN_TRUCKS' x20 included), as in the routing model (PR7, B3).
            fixed=int(round(td.truck.fixed_cost * w.fixed * COST_SCALE)) if td.n_frozen == 0 else 0,
            trip=int(round(td.truck.trip_cost * w.trip * COST_SCALE)),
            per_m=_km_rate_omr(td.truck, cfg) * w.distance * COST_SCALE / 1000.0,
            # A driver paid by the day: its rate as driver time (no hourly pay, no overtime) - and the
            # search's tiny tie-breaker on its km and time, never money (review: its stops in any order).
            driver_day=(int(round(td.truck.driver_day_cost * w.time * COST_SCALE)) if td.truck.driver_day_cost is not None else None),
            tie_m=(_search_km_rate(td.truck, cfg) - _km_rate_omr(td.truck, cfg)) * w.distance * COST_SCALE / 1000.0,
            tie_span=_tie_span_units(td.truck, w),
            hire=tier.get(td.truck.id, 0) if td.n_frozen == 0 else 0,
            hire_w=small.get(td.truck.id, 0) if td.n_frozen == 0 else 0,
        )
        for td in tds if td.usable
    }
    if not w.soft_prefs:
        return LR.Pricing(trucks=trucks, span=int(round(cfg.driver_cost_per_hour * w.time * COST_SCALE / 3600.0)),
                          driver_per_hour=cfg.driver_cost_per_hour * w.time, overtime_per_hour=0.0)
    continuity = cfg.change_penalty_per_stop > 0 and any(s.previous_truck_id for s in stops)
    return LR.Pricing(
        trucks=trucks,
        span=int(round(cfg.driver_cost_per_hour * w.time * COST_SCALE / 3600.0)),
        driver_per_hour=cfg.driver_cost_per_hour * w.time,
        overtime=int(round(cfg.overtime_cost_per_hour * COST_SCALE / 3600.0)) if cfg.overtime_after_min is not None else 0,
        overtime_per_hour=cfg.overtime_cost_per_hour if cfg.overtime_after_min is not None else 0.0,
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
                      load". They reset the Cases/Pallets/Kg dimensions via slack (OR-Tools cvrp_reload
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
        return _empty_scenario(name, "NOTHING_TO_PLAN", pre_drops, time_limit, mx, tds)

    vehicles = [td for td in tds if td.usable]
    reload_owner: list[int] = []
    for v, td in enumerate(vehicles):
        reload_owner += [v] * max(0, td.trips_left - 1)
    m = _Model(n_stops=len(stops), reload_owner=reload_owner, vehicles=vehicles)
    N = m.n_nodes
    nv = len(vehicles)
    values, value_warnings, tier = _service_and_hire(stops, cfg, use_margin, req.trucks, req.depot)
    # The hire tier is scaled like the drop penalties (a scenario that multiplies costs multiplies both).
    mult = _penalty_mult(values, w, sum(tier.values()))
    penalties = [v * mult for v in values]

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
    # A rented or day-paid truck's km with the search's tiny tie-breaker on top (_search_km_rate).
    for v, td in enumerate(vehicles):
        rate = 1.0 if w.pure_distance else _search_km_rate(td.truck, cfg) * w.distance * COST_SCALE / 1000.0
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
        routing.SetFixedCostOfVehicle(_vehicle_fixed_units(td, w, tier.get(td.truck.id, 0) * mult), v)

    # --- capacity with reload reset (cases and / or pallets, kg when any payload is set) -----
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

    # Cases for the trucks without bays (a truck with bays gets CASES_FREE: TruckDay.max_cases);
    # Pallets in 1/1000 pallet for the trucks with bays (bays x fill; a truck without bays gets room
    # for the whole day). An all-bay fleet has Pallets + Kg, as an all-case fleet has Cases + Kg.
    if any(not td.by_pallets for td in vehicles):
        add_capacity("Cases", [0] + [s.demand_cases for s in stops] + [0] * len(reload_owner),
                     [td.max_cases for td in vehicles])
    if any(td.by_pallets for td in vehicles):
        units = [s.demand_pallet_units or 0 for s in stops]
        add_capacity("Pallets", [0] + units + [0] * len(reload_owner),
                     [td.max_pallet_units if td.by_pallets else sum(units) + 1 for td in vehicles])
    # Kg in 0.1 kg units, each stop to the nearest unit, the payload rounded down (audit F08): a load
    # that weighs exactly the payload fits it. A truck without a payload gets room for the whole day.
    demand_u = [kg_units(s.demand_kg) for s in stops]
    kg_active = any(td.max_kg_units > 0 for td in vehicles) and any(demand_u)
    if kg_active:
        unlimited = sum(demand_u) + 1
        add_capacity("Kg", [0] + demand_u + [0] * len(reload_owner),
                     [td.max_kg_units if td.max_kg_units > 0 else unlimited for td in vehicles])

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
        he = LR.latest_start_s(s, cfg.window_rule)  # FINISH: unloading finished by closing
        assert hs <= he, f"stop {s.stop_id}: empty receiving window (the window prefilter drops it)"
        tdim.CumulVar(idx).SetRange(hs, min(he, HORIZON_S))
        early_coeff = 0 if not w.soft_prefs else int(round(cfg.early_preference_per_min.get(s.priority, 0.0) * COST_SCALE / 60.0))
        if s.pref_end_min is not None and pref_coeff > 0:
            tdim.SetCumulVarSoftUpperBound(idx, LR.pref_end_bound_s(s, cfg.window_rule), pref_coeff + early_coeff)
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
        if td.ready_s is not None:  # frozen loads / same-day plan: + loading of the first new load
            first = max(first, td.ready_s + _approx_gap_s(cfg, td))
        tdim.CumulVar(start).SetRange(min(first, td.latest_return_s), td.latest_return_s)
        # Driver break: a DUE truck-day keeps the break's length free of its shift (_search_day_end).
        end_max, span_max = _search_day_end(td, first, shift_s)
        tdim.CumulVar(end).SetRange(td.earliest_depart_s, end_max)
        if td.shift_anchor_s is None:
            tdim.SetSpanUpperBoundForVehicle(span_max, v)
        if td.truck.driver_day_cost is not None:
            # A driver paid by the day costs no hourly pay: its span carries the search's tiny
            # tie-breaker only (a short day, room for its next load; never money, _tie_span_units).
            tie_span = _tie_span_units(td.truck, w)
            if tie_span:
                tdim.SetSpanCostCoefficientForVehicle(tie_span, v)
        elif time_coeff:
            # Driver pay = the whole truck day (costing.py): the route's span, and for a truck with
            # frozen loads also the time from its last frozen return to the first new departure
            # (turnaround and waiting are paid too), i.e. last return - last frozen return.
            tdim.SetSpanCostCoefficientForVehicle(time_coeff, v)
            if td.frozen_return_s is not None:
                tdim.SetCumulVarSoftUpperBound(start, td.frozen_return_s, time_coeff)
        if ot_coeff and cfg.overtime_after_min is not None and td.truck.driver_day_cost is None:
            # Audit E4 (owner decision 14): only NEW overtime costs. A truck with frozen loads pays
            # overtime for its new loads after the later of its day start + overtime_after and its
            # last frozen return (costing.truck_day_costs): the overtime its locked or dispatched
            # loads already work is not charged again, so it does not look dearer than an idle truck.
            bound = LR.overtime_bound_s(td, cfg.overtime_after_min * 60)
            if bound is None:
                bound = td.earliest_depart_s + cfg.overtime_after_min * 60
            tdim.SetCumulVarSoftUpperBound(end, bound, ot_coeff)

    params = pywrapcp.DefaultRoutingSearchParameters()
    params.first_solution_strategy = routing_enums_pb2.FirstSolutionStrategy.PARALLEL_CHEAPEST_INSERTION
    params.local_search_metaheuristic = routing_enums_pb2.LocalSearchMetaheuristic.GUIDED_LOCAL_SEARCH
    params.time_limit.seconds = max(1, int(time_limit))
    params.log_search = False
    _watch_search(name, cfg, len(stops), routing, manager)  # THOROUGH only: stop once it stops improving

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
            _unserved(s, "INFEASIBLE", _no_plan_message(status_name)) for s in stops
        ]
        sc = _empty_scenario(name, "NO_SOLUTION", drops, time_limit, mx, tds)
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


# The start of the reason of a stop the load re-check left out for the loading time between loads
# (_build_scenario's timing_drops), and of the plan's warning about them (_timing_drop_warning): a plan
# built again from a checked one (_without_low_hires) finds its timing drops by them.
TIMING_DROP_HEAD = "Not planned: once every load was timed with the loading time between loads"
TIMING_DROP_NOTE = " stop(s) the route search had planned are left out: with the loading time between loads"


def _timing_drop_warning(cfg: DispatchConfig, n: int, added: int) -> str:
    """The plan's warning about the ``n`` stops the load re-check left out for the loading time between
    loads (``added``: the stops the route search had left out that it plans instead)."""
    return (
        f"{n}{TIMING_DROP_NOTE} ({cfg.reload_min} min + {cfg.loading_min_per_case:g} min per case) its loads did not fit "
        "the truck days, so the lowest priorities were left out (see Unserved orders). Re-plan, add a truck, or check "
        "the loading time." + (f" {added} stop(s) the route search had left out are planned instead." if added else "")
    )


def _timing_drops_of(sc: DispatchScenario, stop_idx: dict[str, int]) -> set[int]:
    """The stops of ``sc`` the load re-check left out for the loading time between loads (by their reason)."""
    return {stop_idx[u.stop_id] for u in sc.unserved
            if u.stop_id in stop_idx and u.reason_message.startswith(TIMING_DROP_HEAD)}


# The start of the reason of a P4/P5 stop a give-back of the hire reduction left out (_build_scenario's
# hire_drops: a rented truck carrying only P4/P5 orders given back, and no place for it left on the
# trucks used, _without_low_hires), and of the plan's warning about them (_hire_drop_warning). Twelfth
# review of the hire branch: they read "the optimizer found no truck ... Re-plan to search again, add a
# truck", counted among the stops the search could not place - and asked for the truck just given back.
HIRE_DROP_HEAD = "Not planned: a truck is not rented for P4/P5 orders alone"
HIRE_DROP_NOTE = " P4/P5 stop(s) are left out because a truck is not rented for P4/P5 orders alone"


def _hire_drop_reason(priority: int) -> str:
    """The unserved reason of a P4/P5 stop a give-back left out."""
    return (f"{HIRE_DROP_HEAD}, and the trucks used had no room or time left for this P{priority} stop (higher "
            "priorities go first). Re-plan when a truck of your own is free.")


def _hire_drop_warning(n: int) -> str:
    """The plan's warning about the ``n`` P4/P5 stops a give-back left out."""
    return (f"{n}{HIRE_DROP_NOTE}, and the trucks used had no room or time left for them (see Unserved orders). "
            "Re-plan when a truck of your own is free.")


def _hire_drops_of(sc: DispatchScenario, stop_idx: dict[str, int]) -> set[int]:
    """The stops of ``sc`` a give-back left out (by their reason)."""
    return {stop_idx[u.stop_id] for u in sc.unserved
            if u.stop_id in stop_idx and u.reason_message.startswith(HIRE_DROP_HEAD)}


def _build_scenario(name, req: DispatchRequest, stops: list[DispatchStop], tds: list[TruckDay], mx: MatrixResult,
                    timed: LR.TimedPlan, values: list[int], use_margin: bool, pre_drops: list[UnservedStop], *,
                    solver_status: str, elapsed: float, time_limit: int, objective_value: int,
                    extra_warnings: list[str] | None = None, timing_drops: set[int] | None = None,
                    exact_timing: bool = True, hire_drops: set[int] | None = None) -> DispatchScenario:
    """Loads, stop times, costs, unserved reasons and totals of a timed plan. The ONE place a
    plan becomes a scenario: the search's plans and the post-solve plans are reported alike, and
    every scenario gets its independent feasibility report here (feasibility.check_scenario).

    timing_drops: stops the route search planned that this plan leaves out because the search's
    loads did not fit the day once timed with the exact loading time (see _post_solve).
    hire_drops: P4/P5 stops a give-back of the hire reduction leaves out (_without_low_hires: a truck is
    not rented for P4/P5 orders alone); those this plan does not serve get that reason and one warning,
    never counted among the stops the optimizer could not place (twelfth review of the hire branch).
    exact_timing: the times come from load_repack.time_plan (the exact loading time between loads);
    False for the route search's own times (80% of a full truck per turnaround).

    The times are reported as the timing gave them: a service start earlier than the drive from
    the previous stop allows is NOT moved later here (that hid a timing error and could push the
    return past the next load's departure unchecked); the feasibility report flags it (TRAVEL)."""
    cfg = req.config
    timing_drops = timing_drops or set()
    hire_drops = hire_drops or set()
    loads: list[PlannedLoad] = []
    served: set[int] = set()
    comp = dict(fixed=0.0, trip=0.0, distance=0.0, fuel=0.0, time=0.0, overtime=0.0, window=0.0, early=0.0, continuity=0.0)
    rates = costing.DayRates.from_config(cfg)
    truck_days: list[TruckDayCostOut] = []
    money_exact = 0.0
    continuity = cfg.change_penalty_per_stop > 0 and any(s.previous_truck_id for s in stops)

    for idx in sorted(timed):
        td = tds[idx]
        t = td.truck
        # Stops, km and legs of each load first; the money of the whole truck day after (costing.py).
        built: list[tuple[LR.TimedLoad, list[PlannedStop], float, int, int, float, int, int]] = []
        for tl in timed[idx]:
            depart_s = tl.depart_s
            prev_node, prev_dep = 0, depart_s
            cum_m, cases, kg, seq, est_legs = 0, 0, 0, 0, 0  # kg in 0.1 kg units (audit F08)
            stops_out: list[PlannedStop] = []
            road = tl.brk if (tl.brk is not None and tl.brk.where == "ROAD") else None
            brk_len = td.break_s
            for q, (k, start_s) in enumerate(zip(tl.stops, tl.starts)):
                s = stops[k]
                node = k + 1
                served.add(k)
                leg_m = mx.distance_m[prev_node][node]
                leg_s = mx.duration_s[prev_node][node]
                leg_est = mx.leg_estimated(prev_node, node)
                est_legs += int(leg_est)
                arrival_s = prev_dep + leg_s
                rest_s = 0  # break minutes spent standing at this customer before unloading
                if road is not None and road.after == q:
                    # The break on this leg: still on the way when it started -> arrives after it;
                    # otherwise it arrived first and rested here (the break overlaps waiting).
                    if road.start_s < arrival_s:
                        arrival_s += brk_len
                    else:
                        rest_s = brk_len
                dep_s = start_s + s.service_min * 60
                cum_m += leg_m
                cases += s.demand_cases
                kg += kg_units(s.demand_kg)
                seq += 1
                hs = (s.hard_start_min or 0) * 60
                # FINISH: the latest start is closing - stop time, and a preferred end means
                # "finished by" (load_repack.latest_start_s / pref_end_bound_s: one meaning in the
                # search, the repack, the LP timing and this report).
                he = LR.latest_start_s(s, cfg.window_rule)
                ps = s.pref_start_min * 60 if s.pref_start_min is not None else None
                pe = LR.pref_end_bound_s(s, cfg.window_rule)
                pref_ok = (ps is None or start_s >= ps) and (pe is None or start_s <= pe)
                if not pref_ok:
                    dev = (max(0, ps - start_s) if ps is not None else 0) + (max(0, start_s - pe) if pe is not None else 0)
                    comp["window"] += dev / 60.0 * cfg.pref_window_penalty_per_min
                early = cfg.early_preference_per_min.get(s.priority, 0.0)
                if early > 0:
                    # As the RECOMMENDED search prices it (load_repack._soft_cost).
                    after = pe if (pe is not None and cfg.pref_window_penalty_per_min > 0) else cfg.shift_start_min * 60
                    comp["early"] += max(0, start_s - after) / 60.0 * early
                if continuity and s.previous_truck_id and s.previous_truck_id != t.id:
                    comp["continuity"] += cfg.change_penalty_per_stop
                # Rounded once: the shown unloading time (departure - start) is exactly the
                # service time that was sent, and the wait is exactly start - arrival.
                arrival_min, start_min = _min_of(arrival_s), _min_of(start_s)
                stops_out.append(PlannedStop(
                    sequence=seq, stop_id=s.stop_id, order_ids=list(s.order_ids), customer_id=s.customer_id,
                    arrival_min=arrival_min, service_start_min=start_min,
                    departure_min=start_min + s.service_min, wait_min=max(0, start_min - arrival_min - _min_of(rest_s)),
                    leg_km=round(leg_m / 1000.0, 2), cum_km=round(cum_m / 1000.0, 2), leg_min=int(round(leg_s / 60)),
                    cases=s.demand_cases, kg=kg_units(s.demand_kg) / 10,
                    hard_window_ok=hs <= start_s <= he, pref_window_ok=pref_ok, leg_estimated=leg_est,
                    pallet_units=s.demand_pallet_units,
                ))
                prev_node, prev_dep = node, dep_s
            back_m = mx.distance_m[prev_node][0]
            est_legs += int(mx.leg_estimated(prev_node, 0))
            cum_m += back_m
            return_s = prev_dep + mx.duration_s[prev_node][0]
            if road is not None and road.after == len(tl.stops):
                return_s += brk_len  # the break on the way back
            built.append((tl, stops_out, cum_m / 1000.0, cases, return_s, kg, back_m, est_legs))
        day_cost = costing.truck_day_costs(
            costing.TruckRates.from_truck(t), rates,
            [costing.LoadTiming(depart_s=tl.depart_s, return_s=ret, km=km) for tl, _, km, _, ret, _, _, _ in built],
            anchor_s=td.shift_anchor_s, frozen_return_s=td.frozen_return_s,
        )
        money_exact += day_cost.total
        load_no = td.n_frozen
        mine: list[PlannedLoad] = []
        for (tl, stops_out, km, cases, return_s, kg, back_m, est_legs), c in zip(built, day_cost.loads):
            load_no += 1
            # A truck with bays: its pallets against the physical bays (a load at a 95% fill limit
            # shows 95%, never 100%), and kg when it has a payload; otherwise cases and kg as before.
            units = sum(st.pallet_units or 0 for st in stops_out) if td.by_pallets else None
            if units is not None:
                util_parts = [units / (td.bays * 1000)] if td.bays else [0.0]
            else:
                util_parts = [cases / t.capacity_cases if t.capacity_cases else 0.0]
            if t.capacity_kg > 0:
                util_parts.append(kg / 10 / t.capacity_kg)
            depart_min, return_min = _min_of(tl.depart_s), _min_of(return_s)
            # To the baisa, and the parts add up exactly to the load's total (= its exact money
            # rounded once): the loads then add up to the truck days and the scenario within the
            # rounding of one total per load (costing.round_parts).
            parts, load_total = costing.round_parts(dict(fixed=c.fixed, trip=c.trip, distance=c.distance, fuel=c.fuel,
                                                         time=c.driver, overtime=c.overtime))
            for key, v in parts.items():
                comp[key] += v
            mine.append(PlannedLoad(
                truck_id=t.id, load_no=load_no, depart_min=depart_min,
                return_min=return_min, distance_km=round(km, 2), duration_min=return_min - depart_min,
                cases=cases, kg=kg / 10, utilization_pct=round(100.0 * max(util_parts), 1),
                fuel_litres=round(c.fuel_litres, 1) if c.fuel_litres is not None else None, fuel_cost=parts["fuel"],
                distance_cost=parts["distance"], time_cost=parts["time"], fixed_cost=parts["fixed"],
                total_cost=load_total,
                return_leg_km=round(back_m / 1000.0, 2), stops=stops_out,
                trip_cost=parts["trip"], driver_cost=parts["time"], overtime_cost=parts["overtime"],
                driver_paid_min=_min_of(c.paid_s), paid_from_min=_min_of(c.paid_from_s), overtime_min=_min_of(c.overtime_s),
                estimated_legs=est_legs, driver_break=_planned_break(tl.brk, td),
                pallet_units=units, pallet_room_units=td.max_pallet_units if td.by_pallets else None,
            ))
        loads += mine
        planned_brk = next((ld.driver_break for ld in mine if ld.driver_break is not None), None)
        truck_days.append(TruckDayCostOut(
            truck_id=t.id, loads=len(mine), frozen_loads=td.n_frozen,
            day_start_min=_min_of(day_cost.day_start_s), paid_from_min=_min_of(day_cost.paid_from_s),
            last_return_min=_min_of(day_cost.last_return_s), paid_min=sum(l.driver_paid_min or 0 for l in mine),
            overtime_min=sum(l.overtime_min or 0 for l in mine),
            fixed_cost=round(sum(l.fixed_cost for l in mine), 3), trip_cost=round(sum(l.trip_cost or 0 for l in mine), 3),
            distance_cost=round(sum(l.distance_cost for l in mine), 3), fuel_cost=round(sum(l.fuel_cost for l in mine), 3),
            driver_cost=round(sum(l.driver_cost or 0 for l in mine), 3), overtime_cost=round(sum(l.overtime_cost or 0 for l in mine), 3),
            total_cost=round(sum(l.total_cost for l in mine), 3),
            break_status=_break_status(td, planned_brk), break_start_min=planned_brk.start_min if planned_brk else None,
        ))

    unserved = list(pre_drops)
    usable_tds = [td for td in tds if td.usable]
    fleet = _fleet(stops, tds, cfg.pallet_fill_pct)
    demand_cases = sum(s.demand_cases for s in stops)
    short_space, short_kg = _fleet_shortage(stops, tds)
    shortage = short_space or short_kg
    priority_of = {st.stop_id: st.priority for st in stops}
    unserved_penalty = 0.0
    open_drops = 0
    hire_left = 0
    brk_words = " and the drivers' midday break" if break_rule(cfg) else ""
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
                                      f"{TIMING_DROP_HEAD} "
                                      f"({cfg.reload_min} min + {cfg.loading_min_per_case:g} min per case)"
                                      f"{brk_words}, the route search's "
                                      f"loads no longer fitted the truck days and this P{s.priority} stop was left out "
                                      "(lowest priorities first). Re-plan, add a truck, or check the loading time."))
        elif k in hire_drops:
            hire_left += 1
            unserved.append(_unserved(s, "SOLVER_DROPPED_LOW_PRIORITY", _hire_drop_reason(s.priority)))
        elif shortage:
            unserved.append(_unserved(s, "SOLVER_DROPPED_LOW_PRIORITY",
                                      _shortage_reason(s.priority, fleet, short_space, short_kg, demand_cases)))
        elif (no_room := _no_room_reason(s, usable_tds, loads, priority_of)) is not None:
            # No load of this plan and no free trip has room for it (cases / pallets or kg), even without
            # its lower-priority stops, and a check proves no other packing could carry it (A6
            # second review): say so, not "re-plan to search again" (audit F08 verifiers).
            # The code stays (a reason code is a database enum); the words are what the dispatcher reads.
            unserved.append(_unserved(s, "SOLVER_DROPPED_LOW_PRIORITY", no_room))
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
    warnings += [td.break_note for td in tds if td.break_note]
    if (problem := break_rule_problem(cfg)) is not None:
        warnings.append(problem)
    if open_drops:
        warnings.append(
            f"{open_drops} stop(s) could not be placed by the optimizer within its time limit; no check proves "
            "they are impossible. Re-plan to search again, add a truck, or raise the loads-per-truck limit."
        )
    if hire_left:
        warnings.append(_hire_drop_warning(hire_left))
    left = [s for k, s in enumerate(stops) if k not in served]
    left_u = sum(kg_units(s.demand_kg) for s in left)
    left_space = sum(fleet.stop_space(s) for s in left)
    short_by_space = fleet.demand_space - fleet.cap_space
    short_by_u = fleet.demand_kg_u - fleet.cap_kg_u
    # The shortage explains leaving out about what the trucks are short of - in cases / pallets or in
    # kg, whichever is short - plus one order that does not split. Or: no unserved stop fits the room
    # left on any load (or on a load a truck did not use). Whole stops leave some room on EVERY
    # load, so over several loads the unserved amount can pass "short + one order" although no
    # re-plan can serve more (PR6 review: 6 loads each 116 kg short of full, every unserved stop 336 kg).
    # A mixed fleet has no space total (_fleet): only the room check explains its space shortage.
    explained = (short_space and fleet.space is not None
                 and left_space <= short_by_space + max((fleet.stop_space(s) for s in left), default=0)) or (
        short_kg and left_u <= short_by_u + max((kg_units(s.demand_kg) for s in left), default=0)) or (
        shortage and not _fits_room_left(left, usable_tds, loads))
    if shortage and not explained:
        # Not everything: the rest did not fit by time, hours or the search's limit.
        kg_short = [f"{kg_text(short_by_u / 10)} kg"] if short_kg else []
        if short_space and fleet.space is None:
            head = "The trucks' loads left cannot carry every stop today" + (f" (and are {kg_short[0]} short)" if kg_short else "")
        else:
            head = "The trucks are " + " and ".join(([fleet.text(short_by_space)] if short_space else []) + kg_short) + " short today"
        left_extra = ([f"{pallet_text(left_space)} pallets"] if fleet.by_pallets else []) + (
            [f"{kg_text(left_u / 10)} kg"] if fleet.kg_bound else [])
        left_kg_text = f" ({', '.join(left_extra)})" if left_extra else ""
        warnings.append(
            f"{head}, but {left_cases} cases{left_kg_text} are unserved: more than the "
            "shortage alone explains. Re-plan to search again, add a truck, or raise the loads-per-truck limit."
        )
    # The day's operating cost is the sum of its loads' costs, so the web's sums of stored load costs
    # equal it exactly. Each load's total is its exact money rounded once to 0.001 OMR, so the sum
    # is within 0.0005 OMR per load of the exact truck-day money. A larger gap is a costing bug: it is
    # logged and shown, never a failed optimization (the plan itself is sound).
    operating = round(sum(ld.total_cost for ld in loads), 3)
    if abs(operating - money_exact) > COST_TOLERANCE_PER_LOAD * max(1, len(loads)) + 1e-6:
        log.error("scenario %s: loads add up to %.3f OMR, the truck days to %.4f OMR", name, operating, money_exact)
        warnings.append(
            f"Cost check: the loads of this option add up to {operating:.3f} OMR but its truck days to {money_exact:.3f} OMR. "
            "The plan itself is valid; report this to the administrator."
        )
    frozen_ids = _frozen_truck_ids(tds)
    sc = DispatchScenario(
        name=name, status="OPTIMIZED", solver_status=solver_status, solver_time_sec=round(elapsed, 2),
        time_limit_sec=time_limit, objective_value=int(objective_value),
        objective=ObjectiveComponents(
            unserved_penalty=round(unserved_penalty, 1), fixed_cost=round(comp["fixed"], 3),
            distance_cost=round(comp["distance"], 3), fuel_cost=round(comp["fuel"], 3),
            time_cost=round(comp["time"], 3), overtime_cost=round(comp["overtime"], 3),
            window_penalty=round(comp["window"], 3), margin_served=margin_served, trip_cost=round(comp["trip"], 3),
        ),
        # Physical trucks of the day (PR7, B3): the new loads' trucks + the trucks of the frozen loads.
        trucks_used=len({ld.truck_id for ld in loads} | frozen_ids), trips=len(loads),
        frozen_trucks=len(frozen_ids), frozen_loads=sum(td.n_frozen for td in tds),
        total_distance_km=round(sum(ld.distance_km for ld in loads), 2),
        total_duration_min=sum(ld.duration_min for ld in loads),
        total_cases=sum(ld.cases for ld in loads), total_kg=round(sum(ld.kg for ld in loads), 1),
        avg_utilization_pct=round(sum(util) / len(util), 1) if util else 0.0,
        fuel_litres=round(sum(ld.fuel_litres or 0 for ld in loads), 1), fuel_cost=round(comp["fuel"], 3),
        operating_cost=operating,
        loads=loads, unserved=unserved, warnings=warnings,
        cost_policy=costing.COST_POLICY, cost_version=costing.COST_VERSION,
        truck_days=sorted(truck_days, key=lambda d: code_of[d.truck_id]),
        paid_driver_min=sum(d.paid_min for d in truck_days),
        preference_penalties=PreferencePenalties(window=round(comp["window"], 3), early=round(comp["early"], 3),
                                                 continuity=round(comp["continuity"], 3)),
        estimated_legs=sum(ld.estimated_legs or 0 for ld in loads),
        # The rules this plan was made with (audit A6 review; the ASSUMPTIONS sheet states them).
        weight_unit_kg=WEIGHT_UNIT_KG, new_overtime_only=True, window_rule=cfg.window_rule, break_rule=_break_echo(cfg),
        latest_return_min=cfg.latest_return_min,
        **_pallet_echo(req, loads),
    )
    _assert_reconciled(req, sc)
    # Without loading per case the search's turnaround is exact - but its times never hold a driver
    # break, so with the break rule only load_repack's timing is exact (the safety net re-times).
    exact = exact_timing or (cfg.loading_min_per_case == 0 and break_rule(cfg) is None)
    sc.feasibility = FZ.safe_check(req, sc, solvable=stops, mx=mx, timing="EXACT" if exact else "ESTIMATED")
    return sc


def _fleet_shortage(stops: list[DispatchStop], tds: list[TruckDay]) -> tuple[bool, bool]:
    """(short of space, short of kg): the fleet-shortage test of _build_scenario, shared with the
    second search's penalty rule (pyvrp_candidate.build_model). Space is cases when no usable truck
    has bays and pallets when every one has bays (_fleet); a mixed fleet is short of space when the
    stops' smallest shares of a truck need more loads than the usable trips (_mixed_space_proven,
    pallets review: such a day kept the second search's default penalty)."""
    f = _fleet(stops, tds)
    if f.space is None:
        usable = [td for td in tds if td.usable]
        short_space = _mixed_space_proven([(s.demand_cases, s.demand_pallet_units) for s in stops], usable, halves=False)
    else:
        short_space = f.demand_space > f.cap_space
    return short_space, f.kg_bound and f.demand_kg_u > f.cap_kg_u


def _pallet_echo(req: DispatchRequest, loads: list[PlannedLoad] | None = None) -> dict:
    """The pallet rule a plan was made with (DispatchScenario.pallet_*): set when a truck of the
    request has bays, else None (the web marks loads as planned by pallets ONLY from this echo)."""
    if not any(t.bays is not None for t in req.trucks):
        return dict(pallet_unit=None, pallet_fill_pct=None, total_pallet_units=None)
    return dict(pallet_unit=PALLET_UNIT, pallet_fill_pct=req.config.pallet_fill_pct,
                total_pallet_units=sum(ld.pallet_units or 0 for ld in loads or []))


def _frozen_truck_ids(tds: list[TruckDay]) -> set[str]:
    """Trucks that carry locked / loading / dispatched loads today, usable for new loads or not."""
    return {td.truck.id for td in tds if td.n_frozen}


def _empty_scenario(name, status, drops, time_limit, mx: MatrixResult, tds: list[TruckDay] | None = None) -> DispatchScenario:
    frozen = _frozen_truck_ids(tds or [])
    return DispatchScenario(
        name=name,
        status=status,
        solver_status="NOT_RUN",
        solver_time_sec=0.0,
        time_limit_sec=time_limit,
        objective_value=0,
        objective=ObjectiveComponents(unserved_penalty=0, fixed_cost=0, distance_cost=0, fuel_cost=0,
                                      time_cost=0, overtime_cost=0, window_penalty=0, margin_served=None),
        # No new load: the day's trucks are those of its frozen loads (PR7, B3).
        trucks_used=len(frozen), frozen_trucks=len(frozen), frozen_loads=sum(td.n_frozen for td in tds or []),
        trips=0, total_distance_km=0.0, total_duration_min=0, total_cases=0, total_kg=0.0,
        avg_utilization_pct=0.0, fuel_litres=0.0, fuel_cost=0.0, operating_cost=0.0,
        loads=[], unserved=list(drops), warnings=list(mx.warnings) if mx else [],
        # No load, so no timetable that could break a rule.
        feasibility=FeasibilityReport(status="VERIFIED", timing="EXACT", checked_at_version=FZ.CHECK_VERSION),
        cost_policy=costing.COST_POLICY, cost_version=costing.COST_VERSION, paid_driver_min=0, estimated_legs=0,
        weight_unit_kg=WEIGHT_UNIT_KG, new_overtime_only=True,
    )


def _break_echo(cfg: DispatchConfig) -> BreakRule | None:
    rule = break_rule(cfg)
    return BreakRule(length_min=rule[0], start_from_min=rule[1], start_to_min=rule[2]) if rule else None


def _planned_break(brk: "LR.BreakAt | None", td: TruckDay) -> PlannedBreak | None:
    if brk is None:
        return None
    start = _min_of(brk.start_s)
    return PlannedBreak(start_min=start, end_min=start + td.break_s // 60, where=brk.where,  # type: ignore[arg-type]
                        after_sequence=brk.after if brk.where == "ROAD" else None)


def _break_status(td: TruckDay, planned: PlannedBreak | None) -> str | None:
    if td.break_state == "OFF":
        return None
    if planned is not None:
        return "PLANNED"
    return "NOT_NEEDED" if td.break_state == "DUE" else td.break_state


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
    if any(s.demand_pallet_units is not None for s in req.stops):
        # Pallets: the planned stops' units + the unserved stops' units = the request's, and every
        # load planned by pallets records the sum of its stops'.
        units_of = {s.stop_id: s.demand_pallet_units or 0 for s in req.stops}
        planned_u = sum(st.pallet_units or 0 for ld in sc.loads for st in ld.stops)
        unserved_u = sum(units_of[u.stop_id] for u in sc.unserved)
        total_u = sum(units_of.values())
        if planned_u + unserved_u != total_u:
            raise ReconciliationError(f"scenario {sc.name}: pallet units {planned_u}+{unserved_u} != {total_u}")
        for ld in sc.loads:
            if ld.pallet_units is not None and ld.pallet_units != sum(st.pallet_units or 0 for st in ld.stops):
                raise ReconciliationError(f"scenario {sc.name}: {ld.truck_id} load {ld.load_no} records {ld.pallet_units} "
                                          "pallet units, not the sum of its stops'")


def matrix_budget_sec(budget: float) -> float:
    """Seconds road routing may take within a request budget of ``budget`` seconds."""
    env = os.environ.get("MATRIX_BUDGET_SEC")
    if env:
        try:
            return max(1.0, float(env))
        except ValueError:
            pass
    return max(1.0, min(MATRIX_BUDGET_CAP_SEC, MATRIX_BUDGET_SHARE * budget))


def optimize_dispatch(req: DispatchRequest, *, osrm_client=None, control: SolveControl | None = None) -> DispatchResponse:
    started = time.monotonic()
    cfg = req.config
    tds = _truck_days(req)
    solvable, drops, warnings = _prefilter(req, tds)
    # QUICK: the request budget as before. THOROUGH: the cap, for everything (one deadline).
    budget = thorough_cap_sec(cfg) if cfg.search_mode == "THOROUGH" else int(os.environ.get("SOLVER_BUDGET_SEC", SOLVER_BUDGET_SEC))
    if len(req.stops) > LARGE_DAY_STOPS:
        warnings.append(
            f"Large day: {len(req.stops)} stops in one optimization (the planner supports up to {MAX_STOPS}). "
            "The search is time-limited, so check the unserved orders; planning by depot or area keeps days smaller."
        )

    # Rule 22: the worker processes first, before the road matrix (which may take up to 90 s): a
    # solver that cannot start them refuses within seconds (WorkersUnavailable -> 503), and nothing
    # is searched inside the API process. None: SOLVER_PARALLEL=0, nothing to search, or the
    # in-process fallback allowed for development (SOLVER_ALLOW_INPROCESS_FALLBACK=1).
    workers: _Workers | None = None
    pv: _PvRun | None = None
    # CI (PR #50): every worker pool and process of this solve is closed - its processes joined, its
    # pipes and locks released - in the finally below, in this thread, whatever happens after it
    # started (the second search's start included). Nothing is left for the garbage collector.
    try:
        if solvable and _parallel():
            # One process per alternative (at most two), even on 1-2 vCPU servers: with a shared
            # worker a stuck alternative starved the next one, which then hit the same deadline
            # without ever starting. OR-Tools limits are wall-clock, so sharing a core only lowers
            # quality, never the deadline. RECOMMENDED runs first in one of them.
            workers = _start_workers(max(1, len([n for n in cfg.scenarios if n != "RECOMMENDED"])), control, req.run_id,
                                     "search")
        # The second route search (PyVRP): its own optional process, after rule 22's proof (a machine
        # that cannot start it still solves). Not waited for here.
        pv = _pv_start(req, solvable, control, workers is not None)
        coords = [(req.depot.lat, req.depot.lng)] + [(s.lat, s.lng) for s in solvable]
        try:
            mx = resolve_matrix(
                coords,
                provider=cfg.distance_provider,
                osrm_url=cfg.osrm_url,
                haversine_multiplier=cfg.haversine_multiplier,
                avg_speed_kmh=cfg.avg_speed_kmh,
                road_time_factor=cfg.road_time_factor,
                osrm_client=osrm_client,
                deadline=started + matrix_budget_sec(budget),
                # Cancelled (the caller is gone) while road routing answers: stop waiting at once, so
                # the slot frees within a second (a hire check preempted by a dispatcher's solve).
                cancelled=control.cancelled.is_set if control is not None else None,
            )
        except MatrixCancelled:
            raise SolveAborted(f"The optimization was cancelled ({control.why if control is not None and control.why else 'the caller is gone'}).") from None
        log.info("dispatch run=%s matrix provider=%s quality=%s points=%d estimated_cells=%d seconds=%.2f",
                 req.run_id, mx.provider_name, mx.quality, len(coords), mx.patched_cells if not mx.all_estimated else -1, mx.seconds)
        keep, window_drops = _window_prefilter(solvable, tds, mx, cfg)
        drops += window_drops
        if len(keep) != len(solvable):
            solvable, mx = _submatrix(solvable, keep, mx)

        time_limit = cfg.time_limit_sec or auto_time_limit(len(solvable))
        state: dict = {}
        scenarios = _run_scenarios(list(cfg.scenarios), req, solvable, tds, mx, time_limit, drops, started + budget,
                                   control=control, state=state, workers=workers, pv=pv)
    finally:
        if pv is not None:
            pv.close()  # already closed by _run_scenarios when it ran; a no-op then
        if workers is not None:
            workers.close()  # likewise
    # The hire suggestion's what-if: the cheapest set of rented trucks that delivers every P1-P3 stop its
    # plan delivers.
    hire_check = None
    if any(t.hire_candidate for t in req.trucks):
        scenarios, hire_check = _reduce_hire(req, solvable, mx, drops, time_limit, started + budget, control, scenarios)
    for sc in scenarios:
        sc.window_rule = cfg.window_rule  # the echo, on empty and NO_SOLUTION scenarios too
        sc.break_rule = _break_echo(cfg)
        sc.latest_return_min = cfg.latest_return_min
        for key, value in _pallet_echo(req, sc.loads).items():
            setattr(sc, key, value)
        log.info("dispatch run=%s scenario=%s status=%s loads=%d unserved=%d km=%.1f t=%.1fs",
                 req.run_id, sc.name, sc.solver_status, sc.trips, len(sc.unserved), sc.total_distance_km,
                 sc.solver_time_sec)
    search = _search_report(cfg.search_mode, budget, state, started)
    log.info("dispatch run=%s search mode=%s limit=%ss searched=%.1fs used=%.1fs stop=%s last_improvement=%s",
             req.run_id, search.mode, search.limit_sec, search.search_sec, search.used_sec, search.stop_reason,
             search.last_improvement_sec)

    return DispatchResponse(
        run_id=req.run_id,
        engine=ENGINE,
        matrix_provider=mx.provider_name,
        distance_is_estimated=mx.is_estimated,
        distance_quality=mx.quality,  # type: ignore[arg-type]
        scenarios=scenarios,
        warnings=warnings + list(mx.warnings),
        search=search,
        hire_check=hire_check,
    )


# ---------------------------------------------------------------------------------------------
# The reduction of a what-if's rented trucks (sixth and seventh reviews of the hire branch)
# ---------------------------------------------------------------------------------------------

# Only P1-P3 orders justify renting a truck (owner answer 1, 6 Oct 2026).
HIRE_MAX_PRIORITY = 3
# The hire check's words when its limits stopped it before every set of trucks to rent that might cost less
# on its km charge was tried or ruled out (HireCheck.note; BUG 5, 7 Oct 2026).
HIRE_NOT_PROVEN_NOTE = ("Not proven the cheapest: the hire check ran out of time or tries before it could check every "
                        "set of trucks to rent that might cost less once its km charge is counted. A cheaper set may "
                        "exist - press Check hire options to check again.")


def _rented_of(sc: DispatchScenario, hire_ids: set[str]) -> list[str]:
    """The rented trucks a plan uses (sorted)."""
    return sorted({ld.truck_id for ld in sc.loads if ld.truck_id in hire_ids})


def _served_of(sc: DispatchScenario) -> set[str]:
    return {st.stop_id for ld in sc.loads for st in ld.stops}


def _low_hires(sc: DispatchScenario, hire_ids: set[str], high) -> set[str]:
    """The rented trucks of a plan whose loads carry no P1-P3 stop (``high``): owner answer 1, never a
    reason to rent."""
    return {tid for tid in _rented_of(sc, hire_ids)
            if not any(high(st.stop_id) for ld in sc.loads if ld.truck_id == tid for st in ld.stops)}


def _service_rank(sc: DispatchScenario, stop_of: dict[str, DispatchStop], cfg: DispatchConfig) -> tuple:
    """How well a plan serves the day, as the day's own priorities rank it (ninth review of the hire
    branch: raw stop counts let two P5 orders outweigh one P4). Strict priorities (the default; the web
    always sends them): the stops served per priority, P1 first - compared in that order, one stop of a
    priority outweighs every lower one together. Weighted (strict_priorities=false): the served stops'
    priority weights added up. A larger rank serves better."""
    prios = [stop_of[sid].priority if sid in stop_of else 5 for sid in _served_of(sc)]
    if cfg.strict_priorities:
        return tuple(sum(1 for p in prios if p == q) for q in range(1, 6))
    return (round(sum(cfg.priority_weights[p] for p in prios), 6),)


def _passes_checks(sc: DispatchScenario | None) -> bool:
    """A plan the reduction may keep: optimized, and its timetable verified by the independent check
    (the one "Use this plan" applies it with)."""
    return (sc is not None and sc.status == "OPTIMIZED"
            and (sc.feasibility is None or sc.feasibility.status == "VERIFIED"))


def _no_worse_checks(a: DispatchScenario | None, b: DispatchScenario) -> bool:
    """``a`` passes the checks, or breaks only what ``b`` breaks too (the same violations: the same rule,
    truck, load and stop) - a give-back of a plan kept as found, whose other trucks' days are unchanged
    (eleventh review of the hire branch)."""
    if _passes_checks(a):
        return True
    if (a is None or a.status != "OPTIMIZED" or a.feasibility is None or b.feasibility is None
            or a.feasibility.status != "VIOLATED" or b.feasibility.status != "VIOLATED"):
        return False

    def broken(sc: DispatchScenario) -> set[tuple]:
        return {(v.code, v.truck_id, v.load_no, v.stop_id) for v in sc.feasibility.violations}  # type: ignore[union-attr]

    return broken(a) <= broken(b)


def _hire_trial_overhead(lim: int) -> int:
    """Seconds a reduction solve searching ``lim`` seconds needs besides its search: its worker pool's start
    (HIRE_TRIAL_START_SEC), the search's model build and extraction (REC_OVERHEAD_SEC: rec_limit_sec keeps
    it free) and the load re-check's whole reserve - _post_solve skips the re-check with less than
    STAGE_GRACE_SEC + 5 s + its CP-SAT time left (seventh review of the hire branch: a solve started with
    its search time + 23 s had no re-check, and its raw search plan became the suggestion)."""
    cap = math.ceil(min(REPACK_CAP_SEC, max(REPACK_MIN_SEC, lim / 2)))
    return HIRE_TRIAL_START_SEC + REC_OVERHEAD_SEC + STAGE_GRACE_SEC + 5 + cap


def _hire_trial_need(lim: int) -> int:
    """Seconds a reduction solve searching ``lim`` seconds needs, its load re-check included."""
    return lim + _hire_trial_overhead(lim)


def _hire_trial_full(time_limit: int) -> int:
    """A reduction solve's search time: the what-if's own (``time_limit``) up to HIRE_TRIAL_FULL_SEC,
    half of it above, never less (seventh review: a 200-350-stop day, searched 150 s, had room for one
    solve at most, a day above 350 stops for none)."""
    return time_limit if time_limit <= HIRE_TRIAL_FULL_SEC else max(HIRE_TRIAL_FULL_SEC, time_limit // 2)


def _hire_trial_limit(time_limit: int, left: float) -> int | None:
    """The search time of the reduction's next solve with ``left`` seconds of its window left: its full
    time (_hire_trial_full), shortened to what the window still holds besides the solve's other needs
    (_hire_trial_overhead), down to half of the full time but never under HIRE_TRIAL_FULL_SEC (nor over
    the full time); None: no solve fits (a shorter search would only find a poorer plan)."""
    full = _hire_trial_full(time_limit)
    floor = min(full, max(HIRE_TRIAL_FULL_SEC, time_limit // 4))
    lim = min(full, int(left) - _hire_trial_overhead(full))
    return lim if lim >= floor else None


def _hire_reduce_window(time_limit: int) -> float:
    """Seconds the reduction may take (the request's budget aside): HIRE_REDUCE_SEC, or the time of
    HIRE_REDUCE_WINDOW_SOLVES full solves when that is longer (a big day)."""
    return float(max(HIRE_REDUCE_SEC, HIRE_REDUCE_WINDOW_SOLVES * _hire_trial_need(_hire_trial_full(time_limit))))


def _hire_room_short(tds: list[TruckDay], keep: set[str], stops: list[DispatchStop]) -> bool:
    """The own trucks and the trucks to rent ``keep`` cannot hold ``stops`` even with every load they may
    make full (trips_left x their room): by pallets (every truck by bays), by cases (every truck by cases)
    or by kg (every truck with a payload). Each is a bound no plan can pass, so such a set is ruled out
    without a solve (seventh review of the hire branch)."""
    days = [td for td in tds if td.usable and (not td.truck.hire_candidate or td.truck.id in keep)]
    if all(td.by_pallets for td in days) and all(s.demand_pallet_units is not None for s in stops):
        if sum(s.demand_pallet_units or 0 for s in stops) > sum(td.trips_left * td.max_pallet_units for td in days):
            return True
    elif not any(td.by_pallets for td in days):
        if sum(s.demand_cases for s in stops) > sum(td.trips_left * td.max_cases for td in days):
            return True
    return (all(td.max_kg_units > 0 for td in days)
            and sum(kg_units(s.demand_kg) for s in stops) > sum(td.trips_left * td.max_kg_units for td in days))


def _hire_room(tds: list[TruckDay]) -> dict[str, int]:
    """Per truck to rent, the room of every load it may make (trips_left x one load's room) in ONE measure
    for all of them (eighth review of the hire branch: pallet units for a truck by bays, cases for one by
    cases - a truck entered by its case capacity always looked the smallest): its pallet units when every
    truck to rent has bays, else its cases (TruckDay.full_cases: a bay truck's pallet room in the day's
    cases per pallet)."""
    hires = [td for td in tds if td.truck.hire_candidate]
    by_pallets = all(td.by_pallets for td in hires)
    return {td.truck.id: td.trips_left * (td.max_pallet_units if by_pallets else td.full_cases) for td in hires}


def _outranks(cfg: DispatchConfig, s: DispatchStop, others: list[DispatchStop]) -> bool:
    """Serving ``s`` in place of ``others`` serves the day better as its own priorities rank it
    (_service_rank): strictly, ``s`` has a higher priority than each of them (one stop of a priority
    outweighs every lower one together); weighted, its weight is more than theirs together."""
    if cfg.strict_priorities:
        return all(o.priority > s.priority for o in others)
    w = cfg.priority_weights
    return w[s.priority] > sum(w[o.priority] for o in others)


# Truck days the give-back's swap (_swap_riders) may time - one small LP each, about 0.25 ms, a day timed
# once is cached. Each stop it puts back has timings of its own, HIRE_SWAP_TIMINGS_PER for each load the
# trucks hold (a load to spare counted too); beyond them it draws on a pool all of them share, that many
# for each stop given back, never fewer than HIRE_SWAP_MIN_TIMINGS. Its places are timed cheapest first,
# so a stop usually takes one (eleventh review of the hire branch: every load kept was timed for every
# stop, and a fixed 400 ran out on a give-back of 30 P4 orders with 17 loads kept). Twelfth review: the
# budget was one pool, and 30 P4 orders received only after the own trucks' day ends timed each of their
# 40 places and used it up, so a P4 order that fit was cut while the P5 orders it outranks rode along - a
# place whose truck day cannot hold the stop's receiving hours is now never timed, and a stop no place of
# which can be timed never uses up the timings of another.
HIRE_SWAP_MIN_TIMINGS = 400
HIRE_SWAP_TIMINGS_PER = 2


def _swap_riders(ctx: _StageCtx, plan: LR.Plan, dropped: list[int],
                 untimed: set[int] | frozenset[int] = frozenset(),
                 min_pool: int | None = None) -> tuple[LR.Plan, list[int], list[int]]:
    """A give-back's plan (``plan``: the loads of the trucks kept) with the stops it left out (``dropped``:
    the stops of the trucks given back, P4/P5 orders) put back on those trucks, with NO solve (tenth review
    of the hire branch: the give-back left a P4 order out while the 10-ton kept carried two P5 orders it had
    the room for in their place - strict priorities never drop a higher priority to carry lower ones;
    eleventh review: a P4/P5 order went into free room only when a lower priority on the trucks kept let
    it - they may ride along) - or on an own truck the plan leaves idle (twelfth review: own trucks first;
    they were left out while one stood idle), never on a truck to rent that is not kept. Highest priority
    first, each where it costs the least: into a load of such a truck with the fewest stops taken off -
    none when it fits as the load is; else only stops it outranks (_outranks), the lowest priority first,
    the biggest first, never a P1-P3 stop -, or on a load of its own when the truck has one to spare; then
    the fewest metres added. The places are timed in that order - the truck's whole day timed exactly again
    (load_repack.time_plan) - and the first that can be timed is taken (eleventh review: every load kept
    was timed for every stop, and the budget ran out). A place is never timed when the load it makes cannot
    leave and be back within the truck's day for the receiving hours of its stops (load_repack.depart_range)
    - nor any place on a truck whose day cannot hold the stop's receiving hours at all (twelfth review) - and
    on a truck of ``untimed`` (its day as the plan has it cannot be timed: a plan kept as the search found
    it) only a place that takes stops off, when its day with every stop the stop may take off it taken off
    can be timed (a stop more only adds to a day). A stop taken off is put back the same way, with nothing
    taken off for it. A stop no load holds even with those stops off stays out: they do not keep it out, and
    they stay on. Each stop may time HIRE_SWAP_TIMINGS_PER places for each load the trucks hold (a load to
    spare counted too), then draws on a pool shared by all (HIRE_SWAP_MIN_TIMINGS at least), so a stop that
    fits nowhere never cuts another (twelfth review); ``min_pool`` lowers that floor (the repair's chain of
    moves, _in_chain, tries many places, each a swap of a few stops). The new plan, the stops of ``dropped``
    it puts back, and the stops it had no timing left to try (a place for them may have been missed)."""
    day, cfg, stops = ctx.day, ctx.req.config, ctx.solvable
    plan = {i: list(loads) for i, loads in plan.items()}
    for td in day.trucks:  # an idle own truck: a load of its own (a truck to rent not kept: never)
        if td.idx not in plan and not td.truck.hire_candidate:
            plan[td.idx] = []
    untimed = set(untimed)
    put: list[int] = []
    cut: list[int] = []
    per = HIRE_SWAP_TIMINGS_PER * sum(len(loads) + 1 for loads in plan.values())  # each stop's own
    pool = max(HIRE_SWAP_MIN_TIMINGS if min_pool is None else min_pool, per * len(dropped))  # shared, after a stop's own
    D, T = day.D, day.T
    every_node = range(len(stops) + 1)

    def loss(off: list[int]) -> tuple:
        """What taking ``off`` off costs, as _service_rank ranks it (smaller is better)."""
        if cfg.strict_priorities:
            return tuple(sum(1 for k in off if stops[k].priority == p) for p in range(1, 6))
        return (sum(cfg.priority_weights[stops[k].priority] for k in off),)

    def riders_of(sd: DispatchStop, td, ld: tuple) -> list[int]:
        """The stops of load ``ld`` that ``sd`` may take off (lower priorities), the lowest priority first,
        the biggest first."""
        return sorted((k for k in ld if stops[k].priority > sd.priority),
                      key=lambda k: (-stops[k].priority, -_need_in(stops[k], td.by_pallets), stops[k].stop_id))

    def places(d: int):
        """Every place of stop ``d`` on the trucks kept (and the idle own ones), cheapest first - (the loss,
        the metres added, the truck, the load, the position) -, lazily: the next is worked out only when the
        one before could not be timed. Each as (truck idx, that truck's new loads, the stops taken off)."""
        sd = stops[d]
        heap: list = []
        tie = itertools.count()
        # The shortest drive into the stop and out of it, from and to anywhere: no load reaches it sooner
        # after leaving, nor is back sooner after its unloading, whatever its order.
        into = min(T[i][d + 1] for i in every_node if i != d + 1)
        out = min(T[d + 1][i] for i in every_node if i != d + 1)
        hs, he = (sd.hard_start_min or 0) * 60, LR.latest_start_s(sd, day.window_rule)

        def reaches(td) -> bool:
            """The stop's receiving hours can fall inside the day of ``td`` at all."""
            start = max(hs, td.earliest_depart_s + into)
            return start <= he and start + sd.service_min * 60 + out <= td.latest_return_s

        def relaxed(idx: int, td) -> bool:
            """The day of truck ``idx`` (untimed) with every stop ``d`` may take off it taken off can be timed."""
            loads = []
            for ld in plan[idx]:
                riders = riders_of(sd, td, ld)
                r = len(riders)
                while r and not _outranks(cfg, sd, [stops[k] for k in riders[:r]]):
                    r -= 1
                if base := tuple(k for k in ld if k not in riders[:r]):
                    loads.append(base)
            return LR.time_plan(day, {idx: loads}, ctx.rec_pricing) is not None

        def level(idx: int, td, j: int, ld: tuple, riders: list[int], r: int) -> None:
            """Load ``j`` of truck ``idx`` with the fewest of ``riders`` (``r`` at least) taken off that lets
            ``d`` fit, queued at its cheapest position."""
            old = day.metres(ld)
            while r <= len(riders):
                off = riders[:r]
                if r and not _outranks(cfg, sd, [stops[k] for k in off]):
                    return  # more of them off never does (their weight only grows)
                base = [k for k in ld if k not in off]
                if LR.fits_truck(LR.facts(day, tuple(base + [d])), td):
                    nodes = [0] + [k + 1 for k in base] + [0]
                    m = day.metres(tuple(base)) - old
                    spots = sorted((m + D[nodes[p]][d + 1] + D[d + 1][nodes[p + 1]] - D[nodes[p]][nodes[p + 1]], p)
                                   for p in range(len(base) + 1))
                    heapq.heappush(heap, ((loss(off), spots[0][0], idx, j, spots[0][1]), next(tie),
                                          (idx, td, j, ld, riders, r, base, spots, 0)))
                    return
                r += 1  # one more off

        alone = LR.facts(day, (d,))  # a load of its own
        for idx in sorted(plan):
            td = day.by_idx.get(idx)
            if td is None or not reaches(td):
                continue  # no place on it can be timed: its hours fall outside the truck's day
            bad = idx in untimed  # nothing added alone lets its day be timed
            if bad and not relaxed(idx, td):
                continue
            loads = plan[idx]
            if not bad and len(loads) < td.trips_left and LR.depart_range(day, alone, td) is not None:
                heapq.heappush(heap, ((loss([]), alone.metres, idx, len(loads), 0), next(tie), (idx, None)))
            for j, ld in enumerate(loads):
                level(idx, td, j, ld, riders_of(sd, td, ld), 1 if bad else 0)
        while heap:
            _, _, at = heapq.heappop(heap)
            idx, loads = at[0], plan[at[0]]
            if at[1] is None:  # a load of its own
                yield idx, loads + [(d,)], []
                continue
            _, td, j, ld, riders, r, base, spots, q = at
            pos = spots[q][1]
            new = tuple(base[:pos] + [d] + base[pos:])
            if q + 1 < len(spots):  # the next position in this load
                heapq.heappush(heap, ((loss(riders[:r]), spots[q + 1][0], idx, j, spots[q + 1][1]), next(tie),
                                      (idx, td, j, ld, riders, r, base, spots, q + 1)))
            else:
                level(idx, td, j, ld, riders, r + 1)
            if LR.depart_range(day, LR.facts(day, new), td) is not None:  # else it can never be timed
                yield idx, loads[:j] + [new] + loads[j + 1:], riders[:r]

    todo = [(stops[k].priority, stops[k].stop_id, k) for k in dropped]
    heapq.heapify(todo)
    given = set(dropped)
    while todo:
        _, _, d = heapq.heappop(todo)
        mine = per  # this stop's own timings; then the shared pool
        for idx, new, off in places(d):
            if mine <= 0 and pool <= 0:
                cut.append(d)
                break
            if mine > 0:
                mine -= 1
            else:
                pool -= 1
            if LR.time_plan(day, {idx: new}, ctx.rec_pricing) is not None:
                plan[idx] = new
                untimed.discard(idx)
                if d in given:
                    put.append(d)
                for k in off:  # put back the same way, nothing taken off for it
                    heapq.heappush(todo, (stops[k].priority, stops[k].stop_id, k))
                break
    return {i: loads for i, loads in plan.items() if loads}, put, cut


def _rebuilt(ctx: _StageCtx, sc: DispatchScenario, plan: LR.Plan, as_is: LR.TimedPlan | None,
             timing: set[int], hire: set[int]) -> DispatchScenario | None:
    """The scenario of ``plan`` in place of ``sc`` (its name, status and times), checked as every plan is
    (_build_scenario). ``as_is``: a truck whose loads in ``plan`` are exactly its loads there keeps those
    times (its day as it was: exact when ``sc``'s timing was), any other truck is timed exactly; None: the
    whole plan is timed exactly (load_repack.time_plan). ``timing``: the stops the load re-check of ``sc``
    left out for the loading time between loads (that reason and its warning kept, eighth review of the
    hire branch); ``hire``: the P4/P5 stops a give-back leaves out (_without_low_hires). None when a day
    cannot be timed."""
    timed: LR.TimedPlan | None
    exact = True
    if as_is is None:
        timed = LR.time_plan(ctx.day, plan, ctx.rec_pricing)
    else:
        sc_exact = sc.feasibility is not None and sc.feasibility.timing == "EXACT"
        timed = {}
        for idx, loads in plan.items():
            if not loads:
                continue
            if idx in as_is and [tl.stops for tl in as_is[idx]] == list(loads):
                timed[idx], exact = as_is[idx], exact and sc_exact
                continue
            one = LR.time_plan(ctx.day, {idx: loads}, ctx.rec_pricing)
            if one is None:
                return None
            timed.update(one)
    if timed is None:
        return None
    out = _build_scenario(
        sc.name, ctx.req, ctx.solvable, ctx.tds, ctx.mx, timed, ctx.values, ctx.use_margin, ctx.drops,
        solver_status=sc.solver_status, elapsed=sc.solver_time_sec, time_limit=sc.time_limit_sec,
        objective_value=LR.score(ctx.day, ctx.rec_pricing, timed).objective, extra_warnings=ctx.value_warnings,
        timing_drops=timing, exact_timing=exact, hire_drops=hire,
    )
    if timing:
        out.warnings += [w for w in sc.warnings if TIMING_DROP_NOTE in w and w not in out.warnings]
    return out


# Seconds the repair of one plan (_repair_lost) may spend on its places with every lower priority off a
# truck's day (_in_place_of_riders), besides the swap's own timings (thirteenth review of the hire branch).
HIRE_REPAIR_SEC = 10.0


def _in_place_of_riders(ctx: _StageCtx, plan: LR.Plan, d: int, untimed: set[int],
                        deadline: float) -> tuple[LR.Plan | None, bool]:
    """Stop ``d`` (a P1-P3 stop ``plan`` leaves out) on a truck of ``plan`` with EVERY stop of that truck's
    day it outranks taken off - as _outranks ranks them together, the lowest priority first, the biggest
    first - not only those of the load it goes on, as the swap takes off (_swap_riders): a load can be
    held up by another load of the same day (thirteenth review of the hire branch). Its places, the fewest
    metres added first over every such truck: into a load of that truck that then holds it, or a load of
    its own when the truck has one to spare - each timed exactly with the truck's whole day
    (load_repack.time_plan); never on a truck of ``untimed`` (its day as the plan has it cannot be timed).
    The first that can be timed is taken, and the stops taken off are put back where they fit
    (_swap_riders). (the new plan, True) then; (None, True) when no place can be timed; (None, False) when
    ``deadline`` came first."""
    day, cfg, stops = ctx.day, ctx.req.config, ctx.solvable
    sd, D = stops[d], ctx.day.D
    alone = LR.facts(day, (d,))
    places: list[tuple[int, int, int, int, list[tuple[int, ...]], set[int]]] = []
    for idx in sorted(plan):
        td = day.by_idx.get(idx)
        if td is None or idx in untimed:
            continue
        lower = sorted((k for ld in plan[idx] for k in ld if stops[k].priority > sd.priority),
                       key=lambda k: (-stops[k].priority, -_need_in(stops[k], td.by_pallets), stops[k].stop_id))
        r = len(lower)
        while r and not _outranks(cfg, sd, [stops[k] for k in lower[:r]]):
            r -= 1
        if not r:
            continue
        off = set(lower[:r])
        bare = [b for ld in plan[idx] if (b := tuple(k for k in ld if k not in off))]
        for j, ld in enumerate(bare):
            if LR.fits_truck(LR.facts(day, ld + (d,)), td):
                nodes = [0] + [k + 1 for k in ld] + [0]
                places += [(D[nodes[p]][d + 1] + D[d + 1][nodes[p + 1]] - D[nodes[p]][nodes[p + 1]], idx, j, p, bare, off)
                           for p in range(len(ld) + 1)]
        if len(bare) < td.trips_left and LR.fits_truck(alone, td):
            places.append((alone.metres, idx, len(bare), 0, bare, off))
    for _, idx, j, p, bare, off in sorted(places, key=lambda x: x[:4]):
        if time.monotonic() >= deadline:
            return None, False
        td = day.by_idx[idx]
        new = bare[j][:p] + (d,) + bare[j][p:] if j < len(bare) else (d,)
        if LR.depart_range(day, LR.facts(day, new), td) is None:
            continue  # it can never be timed
        loads = bare[:j] + [new] + bare[j + 1:]
        if LR.time_plan(day, {idx: loads}, ctx.rec_pricing) is not None:
            back, _, _ = _swap_riders(ctx, {**plan, idx: loads}, sorted(off, key=lambda k: stops[k].stop_id), untimed)
            return back, True
    return None, True


def _in_chain(ctx: _StageCtx, plan: LR.Plan, d: int, untimed: set[int],
              deadline: float) -> tuple[LR.Plan | None, bool]:
    """Stop ``d`` (a P1-P3 stop ``plan`` leaves out) into a load of ``plan`` in place of ONE other stop of
    that load, of any priority, and the stops of that load it outranks (as _outranks ranks them together) -
    the stop taken out going on another place where it fits (_swap_riders): a chain of two moves (thirteenth
    review of the hire branch: in a replay of the real day under load, CAA8362 - 1.95 pallets - fitted no
    load even with every P4/P5 order of a truck's day off, and went into an own truck's last load in place
    of its P4 order and a 0.14-pallet P3 order, which fitted on another load). The places: the smallest stop
    taken out first, then the truck, the load and the fewest metres added; each timed exactly with the
    truck's whole day (load_repack.time_plan), never on a truck of ``untimed``, then the stop taken out
    placed with a few timings of its own - the first where it can be is taken, and the stops ``d`` took the
    place of are put back where they fit too. (the new plan, True) then; (None, True) when none can be;
    (None, False) when ``deadline`` came first."""
    day, cfg, stops = ctx.day, ctx.req.config, ctx.solvable
    sd, D = stops[d], ctx.day.D
    places: list[tuple[int, int, int, int, int, tuple[int, ...], int, tuple[int, ...]]] = []
    for idx in sorted(plan):
        td = day.by_idx.get(idx)
        if td is None or idx in untimed:
            continue
        for j, ld in enumerate(plan[idx]):
            lower = sorted((k for k in ld if stops[k].priority > sd.priority),
                           key=lambda k: (-stops[k].priority, -_need_in(stops[k], td.by_pallets), stops[k].stop_id))
            r = len(lower)
            while r and not _outranks(cfg, sd, [stops[k] for k in lower[:r]]):
                r -= 1
            off = tuple(lower[:r])
            base = [k for k in ld if k not in off]
            for x in base:
                rest = [k for k in base if k != x]
                if not LR.fits_truck(LR.facts(day, tuple(rest + [d])), td):
                    continue
                nodes = [0] + [k + 1 for k in rest] + [0]
                m, p = min((D[nodes[q]][d + 1] + D[d + 1][nodes[q + 1]] - D[nodes[q]][nodes[q + 1]], q)
                           for q in range(len(rest) + 1))
                places.append((_need_in(stops[x], td.by_pallets), idx, j, m, p, tuple(rest), x, off))
    for _, idx, j, _, p, rest, x, off in sorted(places, key=lambda c: c[:5]):
        if time.monotonic() >= deadline:
            return None, False
        td = day.by_idx[idx]
        new = rest[:p] + (d,) + rest[p:]
        if LR.depart_range(day, LR.facts(day, new), td) is None:
            continue  # it can never be timed
        loads = plan[idx][:j] + [new] + plan[idx][j + 1:]
        if LR.time_plan(day, {idx: loads}, ctx.rec_pricing) is None:
            continue
        back, put, _ = _swap_riders(ctx, {**plan, idx: loads}, [x, *off], untimed, min_pool=0)
        if x in put:
            return back, True
    return None, True


def _repair_lost(req: DispatchRequest, solvable: list[DispatchStop], mx: MatrixResult, drops: list[UnservedStop],
                 sc: DispatchScenario, lost: set[str], deadline: float, hired_idle: bool) -> tuple[DispatchScenario, set[str]]:
    """``sc`` (a plan of ``req``) with its P1-P3 stops ``lost`` (left out) put back where they fit, in place
    of lower priorities where need be, with NO solve (thirteenth review of the hire branch: on the real
    Muscat day the reduction's solve of 1 x 10-ton came back with a P3 order left out while it carried a
    P4/P5 order more in its place - the time-limited repack after the search made that swap - and that solve
    ruled the 10-ton out: 2 x 3-ton was suggested, "complete"). First the give-back's swap (_swap_riders:
    into free room, or in place of the stops of one load it outranks, the truck's whole day timed exactly
    again); then, for a P1-P3 stop still out - of ``lost``, or of ``sc`` with a higher priority in its
    place now -, every stop it outranks taken off one truck's whole day (_in_place_of_riders), and failing
    that a chain of two moves: in place of one other stop of a load, which goes on elsewhere (_in_chain);
    each such stop tried once, highest priority first, until ``deadline``. Its trucks: those of ``sc``, the
    own trucks it leaves idle, and with
    ``hired_idle`` the trucks to rent of ``req`` it leaves idle (a reduction solve's set is all of them).
    The plan so repaired is built and checked as every plan (_build_scenario, a truck it does not change
    keeping its times) and replaces ``sc`` only when it passes the checks and serves the day better
    (_service_rank). Returns the plan (``sc`` itself when nothing is put back) and the P1-P3 stops it leaves
    out (of ``lost``, or of ``sc`` with a higher priority in their place) while a stop they outrank rides on
    its trucks: a plan that serves a lower priority in place of a higher one proves nothing about them,
    even when no single move puts them back (thirteenth review: in a replay of the real day the solve of
    1 x 10-ton left another P3 order out while a P4/P5 order more rode along, and no truck's day took it
    even with every lower priority off - it needed a P3 order of one truck moved to another; the next
    solve delivered every P1-P3 order)."""
    cfg = req.config
    stop_of = {s.stop_id: s for s in req.stops}

    def kept_out(left, riding) -> set[str]:
        """The stops of ``left`` that a stop of ``riding`` (stop ids) they outrank rides along with."""
        return {sid for sid in left if any(_outranks(cfg, stop_of[sid], [stop_of[o]]) for o in riding if o in stop_of)}

    try:
        tds = _truck_days(req)
        ctx = _stage_ctx(req, solvable, tds, mx, drops)
        stops = ctx.solvable
        as_is = _timed_from_scenario(sc, ctx.stop_idx, ctx.truck_idx)
        start = LR.plan_of(as_is)
        if hired_idle:
            for td in ctx.day.trucks:
                if td.truck.hire_candidate and td.idx not in start:
                    start[td.idx] = []
        untimed = {i for i, loads in start.items() if loads and LR.time_plan(ctx.day, {i: loads}, ctx.rec_pricing) is None}
        out = sorted((ctx.stop_idx[sid] for sid in lost if sid in ctx.stop_idx), key=lambda k: (stops[k].priority, stops[k].stop_id))
        plan, put, _ = _swap_riders(ctx, start, out, untimed)
        changed = bool(put)
        # The P1-P3 stops to place: those of ``lost``, and any of ``sc`` a higher priority took the place of.
        targets = set(out) | {k for loads in start.values() for ld in loads for k in ld if stops[k].priority <= HIRE_MAX_PRIORITY}

        def missing() -> list[int]:
            on = {k for loads in plan.values() for ld in loads for k in ld}
            return sorted((k for k in targets if k not in on), key=lambda k: (stops[k].priority, stops[k].stop_id))

        tried: set[int] = set()
        while (todo := [k for k in missing() if k not in tried]) and time.monotonic() < deadline:
            d = todo[0]
            tried.add(d)
            still = {i for i in untimed if plan.get(i) == start.get(i)}
            new, done = _in_place_of_riders(ctx, plan, d, still, deadline)
            if new is None and done:
                new, done = _in_chain(ctx, plan, d, still, deadline)
            if new is not None:
                plan, changed = new, True
            elif not done:
                break
        riding = {stops[k].stop_id for loads in plan.values() for ld in loads for k in ld}
        open_ = kept_out([stops[d].stop_id for d in missing()], riding)
        if not changed:
            return sc, open_
        rep = _rebuilt(ctx, sc, plan, as_is, _timing_drops_of(sc, ctx.stop_idx), _hire_drops_of(sc, ctx.stop_idx))
    except Exception as exc:  # noqa: BLE001 - the plan stays as it is, its stops not settled
        log.warning("run=%s hire check: putting %s back failed: %s", req.run_id, sorted(lost), exc)
        return sc, kept_out(lost, _served_of(sc))
    if not _passes_checks(rep) or _service_rank(rep, stop_of, cfg) <= _service_rank(sc, stop_of, cfg):  # type: ignore[arg-type]
        log.warning("run=%s hire check: the plan with %s put back does not pass the checks; kept as it was",
                    req.run_id, sorted(lost & _served_of(rep)) if rep is not None else sorted(lost))
        return sc, kept_out(lost, _served_of(sc))
    return rep, open_  # type: ignore[return-value]


def _without_low_hires(req: DispatchRequest, solvable: list[DispatchStop], mx: MatrixResult, drops: list[UnservedStop],
                       sc: DispatchScenario, hire_ids: set[str], high, cut: list[str] | None = None) -> DispatchScenario:
    """``sc`` without its rented trucks whose loads carry no P1-P3 stop (``high``: owner answer 1, P4/P5
    orders never justify a truck - they only ride along in one rented for P1-P3 orders), with NO solve
    (seventh review of the hire branch: on a big day the budget allows one solve or none, and such a truck
    stayed in the suggestion): their loads deleted, their stops left out, every other load as it was - the
    same stops in the same order, timed exactly again (each truck's day is timed on its own, so theirs do
    not change) and checked as every plan (_build_scenario) - but for the stops of theirs that fit on the
    trucks kept or an own truck the plan leaves idle: those are put back on them, with nothing taken off,
    or in place of stops they outrank where need be (_swap_riders; tenth review of the hire branch: strict
    priorities never drop a P4 order to carry two P5s; eleventh review: P4/P5 orders ride along in free
    room; twelfth review: own trucks first), when that plan breaks no check the plan without them passes
    and serves the day better (_service_rank). A P4/P5 stop the plan given back leaves out says a truck is
    not rented for P4/P5 orders alone (_hire_drop_reason, and one warning; twelfth review: it read "could
    not be placed by the optimizer ... add a truck", counted with the stops the search left). A plan that
    cannot be timed again, or fails the checks so (a plan the post-solve stage kept as the search found it,
    VIOLATED), is given back from its own times instead - every other truck's day exactly as it was, so
    it breaks nothing ``sc`` does not (eleventh review: such a plan kept its truck for P4/P5 orders alone,
    counted in the box with its money); a truck the swap changes is still timed exactly. The stops the
    load re-check of ``sc`` left out for the loading time between loads keep that reason and its warning
    (eighth review: they read "the optimizer found no truck ... Re-plan to search again"). ``cut``: the
    stops the swap had no timing left to try are added to it (logged; the set is then not complete).
    ``sc`` itself when there is no such truck, or when the plan without them cannot be built. _reduce_hire
    may solve the set left once more (its step 3); this plan stays whenever that solve does not run or
    does not replace it."""
    gone = _low_hires(sc, hire_ids, high)
    if not gone:
        return sc
    stop_of = {s.stop_id: s for s in req.stops}
    as_found = False
    try:
        tds = _truck_days(req)
        ctx = _stage_ctx(req, solvable, tds, mx, drops)
        timed_sc = _timed_from_scenario(sc, ctx.stop_idx, ctx.truck_idx)
        own = {i: loads for i, loads in timed_sc.items() if tds[i].truck.id not in gone}
        kept = LR.plan_of(own)
        dropped = [k for i, loads in timed_sc.items() if tds[i].truck.id in gone for tl in loads for k in tl.stops]
        timing = _timing_drops_of(sc, ctx.stop_idx)
        # The P4/P5 stops ``sc`` serves: one the plan given back leaves out is told why (twelfth review).
        hire = {k for loads in timed_sc.values() for tl in loads for k in tl.stops if not high(solvable[k].stop_id)}
        hire |= _hire_drops_of(sc, ctx.stop_idx)
        untimed: set[int] = set()  # the trucks kept whose day as ``sc`` has it cannot be timed

        def built(plan: LR.Plan, from_own: bool) -> DispatchScenario | None:
            """The scenario of ``plan``, timed exactly; ``from_own``: a truck whose loads are the plan's own
            keeps the plan's own times (its day as it was), any other is timed exactly."""
            return _rebuilt(ctx, sc, plan, own if from_own else None, timing, hire)

        new = built(kept, False)
        if not _passes_checks(new):
            # Kept as the search found it (eleventh review): the plan's own times, every other day unchanged.
            back = built(kept, True)
            if back is not None and (_passes_checks(back) or not _passes_checks(sc)):
                new, as_found = back, True
                untimed = {i for i, loads in kept.items() if LR.time_plan(ctx.day, {i: loads}, ctx.rec_pricing) is None}
                log.info("run=%s hire check: the plan without %s cannot be timed again or fails the checks so; "
                         "given back from its own times", req.run_id, sorted(gone))
    except Exception as exc:  # noqa: BLE001 - the plan stays as it is; the solves may still leave them out
        log.warning("run=%s hire check: the plan without %s could not be built: %s", req.run_id, sorted(gone), exc)
        return sc
    try:
        swapped, put, short = _swap_riders(ctx, kept, dropped, untimed)
        if short:
            log.warning("run=%s hire check: after the give-back of %s, no timing was left to try %s on the trucks kept; "
                        "not proven the cheapest", req.run_id, sorted(gone), sorted(solvable[k].stop_id for k in short))
            if cut is not None:
                cut += sorted(solvable[k].stop_id for k in short)
        alt = built(swapped, as_found) if put else None
        if alt is not None and ((_passes_checks(alt) and not _passes_checks(new)) or (
                new is not None and _no_worse_checks(alt, new)
                and _service_rank(alt, stop_of, req.config) > _service_rank(new, stop_of, req.config))):
            log.info("run=%s hire check: %s put back on the trucks kept, in place of lower priorities where need be, "
                     "after the give-back of %s", req.run_id, sorted(solvable[k].stop_id for k in put), sorted(gone))
            new = alt
    except Exception as exc:  # noqa: BLE001 - the give-back stays as it is
        log.warning("run=%s hire check: putting the stops of %s back on the trucks kept failed: %s", req.run_id, sorted(gone), exc)
    if new is None or not (_passes_checks(new) or as_found):
        log.warning("run=%s hire check: the plan without %s does not pass the checks; kept", req.run_id, sorted(gone))
        return sc
    log.info("run=%s hire check: %s carried only P4/P5 orders: given back without a solve", req.run_id, sorted(gone))
    return new


@dataclass
class _HireTrial:
    """One conclusive solve of the reduction that did not keep every P1-P3 stop: the trucks to rent
    ``offered`` (with every own truck)."""

    offered: tuple[str, ...]
    sc: DispatchScenario | None  # None: the plan did not pass the checks
    lost: int  # P1-P3 stops the plan delivered that this one does not (a large number when it failed the checks)
    # False: once repaired (_repair_lost) it still leaves a P1-P3 stop out while a lower priority rides on
    # its trucks - it proves nothing, so it never rules its set out (thirteenth review of the hire branch).
    proven: bool = True


def _hire_trial(req: DispatchRequest, solvable: list[DispatchStop], mx: MatrixResult, drops: list[UnservedStop],
                time_limit: int, budget_end: float, control: SolveControl | None) -> tuple[DispatchScenario | None, bool]:
    """The recommended plan of ``req`` (the what-if with other trucks to rent) on the request's own road
    matrix and stops, searched as the what-if was (its own worker pool and second search, rule 22), and
    whether the load re-check checked it (seventh review of the hire branch: a plan the re-check skipped -
    out of time - is the raw search plan, which neither replaces the plan nor proves a set too small).
    (None, False) when it cannot run (no worker processes, or it failed - the reduction then stops); a
    cancelled solve raises SolveAborted as the what-if's own search does."""
    tds = _truck_days(req)
    workers: _Workers | None = None
    pv: _PvRun | None = None
    try:
        if _parallel():
            workers = _start_workers(1, control, req.run_id, "hire check")
        pv = _pv_start(req, solvable, control, workers is not None)
        state: dict = {}
        scs = _run_scenarios(["RECOMMENDED"], req, solvable, tds, mx, time_limit, list(drops), budget_end,
                             control=control, state=state, workers=workers, pv=pv)
        sc = scs[0] if scs else None
        return sc, sc is not None and "RECOMMENDED" in state.get("rechecked", ())
    except SolveAborted:
        if control is not None and control.cancelled.is_set():
            raise
        log.warning("run=%s hire check: a solve with other trucks to rent did not finish; the set found is kept", req.run_id)
        return None, False
    except WorkersUnavailable:
        log.warning("run=%s hire check: no worker processes for a solve with other trucks to rent; the set found is kept", req.run_id)
        return None, False
    finally:
        if pv is not None:
            pv.close()
        if workers is not None:
            workers.close()


def _reduce_hire(req: DispatchRequest, solvable: list[DispatchStop], mx: MatrixResult, drops: list[UnservedStop],
                 time_limit: int, budget_end: float, control: SolveControl | None,
                 scenarios: list[DispatchScenario]) -> tuple[list[DispatchScenario], HireCheck]:
    """The what-if's RECOMMENDED plan with the CHEAPEST set of rented trucks that still delivers every
    P1-P3 stop it delivers (sixth review of the hire branch: the Quick search rented 2 x 10-ton where one
    carried all 25 P1-P3 orders left out - the second only P4/P5 orders).

    0. Every plan judged here - the plan found (when it passes the checks) and every solve's plan below -
       is first repaired with no solve (_repair_lost): a P1-P3 stop it leaves out goes back where it fits,
       in place of lower priorities where need be (thirteenth review: the solve of 1 x 10-ton left a P3
       order out while it carried a P4/P5 order more in its place, and ruled the 10-ton out: 2 x 3-ton
       was suggested, "complete"). A solve that still leaves one out while a lower priority rides on its
       trucks proves nothing (no single move may put it back, a chain of them may): it is solved once
       more if the limits allow, and while it stays so it never rules its set out (nor tells "one truck
       fewer").
    1. With no solve, every rented truck whose loads carry no P1-P3 stop is given back (_without_low_hires;
       owner answer 1: P4/P5 orders never justify a truck). A stop of theirs goes back on the trucks kept,
       or an own truck left idle, where it fits, with nothing taken off or in place of stops it outranks
       where need be (_swap_riders; tenth review: the give-back left a P4 order out while the truck kept
       carried two P5 orders in its room; eleventh review: a P4/P5 order went into free room only when a
       lower priority let it, and the swap's timings ran out on a mid-size give-back; twelfth review: P4
       orders that fit nowhere used up the timings of one that fit, and an idle own truck never took
       them); one it leaves out says a truck is not rented for P4/P5 orders alone. A plan kept as the
       search found it (VIOLATED, it cannot be timed again) is given back from its own times (eleventh
       review: it kept its truck for P4/P5 orders alone, counted in the box with its money). Every
       give-back below is this one.
    2. Every set of the trucks to rent (units of one option are alike; the request's units each option
       has) cheaper in real money than the plan's (hire_money; with as much money, fewer trucks), with as
       many trucks as it takes, is tried cheapest first, with fewer trucks first on a tie (seventh review:
       leaving the dearest truck out first kept 2 x 3-ton for 80 OMR, "complete", where the 10-ton alone
       delivered every order for 60 - and a removal was never a swap, so 1 x 10-ton stayed where 1 x 3-ton
       sufficed; eighth review: a set was capped at the plan's count of trucks, so 1 x 10-ton at 85 OMR
       stayed where 2 x 3-ton at 80 delivered every order). A set that cannot hold those stops even full is
       ruled out by its room (_hire_room_short); any other is solved with exactly the own trucks and that
       set (_hire_trial). The first plan that passes every check (OPTIMIZED, feasibility VERIFIED, its load
       re-check run) and delivers every P1-P3 stop the plan delivers - its P4/P5 stops may stay out - is
       the suggestion (once more without its trucks that then carry only P4/P5 orders) - unless such a
       truck cannot be given back while the plan held has none (tenth review: that plan, renting a truck
       for P5 orders alone, was the suggestion, "complete"): the walk then goes on. A solve whose load
       re-check was skipped neither replaces the plan nor rules its set out. At most HIRE_REDUCE_MAX_SETS
       sets are listed. Money (BUG 5, 7 Oct 2026): "cheaper" before a solve is a set's LEAST cost (its
       hire, day rates and km charge over the fewest km a used truck drives, _hire_floor_money), never the
       search's rough day of a rental; a plan is judged by what its rented trucks really cost on their
       routed km (_hire_routed_money). With a km charge the walk goes on past a set that delivers while an
       untried set's least cost is below the best real cost found, and keeps the cheapest by real cost; a
       flat-rate day (the three costs alike) stops right after the first set that delivers, as before.
    3. When trucks were given back (step 1, or the plan of step 2), the set left is solved exactly once
       more if the limits allow, every earlier solve could run, and no solve of a set alike was made
       (eighth review: the give-back alone dropped the P4/P5 orders of the truck given back although the
       trucks kept had room and loads to spare - they may ride along). Its plan must pass every check and
       deliver every P1-P3 stop the plan delivered; then, without its trucks that carry only P4/P5
       orders, it replaces the give-back when its set is cheaper in real money (ninth review: that solve
       proved one 10-ton enough and the give-back's two stayed, "complete") - also when it serves fewer
       P4/P5 orders -, or as cheap and serving more as the day's priorities rank it (_service_rank:
       strictly, one P4 order outweighs every P5 order), or as cheap at all when the give-back fails the
       checks (a plan kept as found, given back from its own times: eleventh review - its set was then
       no cheaper set of step 2). A plan that still has such a truck (its
       give-back could not be built) never replaces it, and the set is then not proven the cheapest.
       Otherwise the give-back stays.
    4. "One truck fewer" (HireCheck.one_fewer) is a solve of the suggested set less one of its trucks: the
       one whose removal lost the fewest P1-P3 stops, then the dearest; when the solves so far hold none for
       its least useful truck (the least room, _hire_room), that set is solved once more if the limits
       allow. When that solve passes every check and keeps every P1-P3 stop, it proves the cheaper set:
       its plan (given back as in step 2) is the suggestion (tenth review: it was thrown away), and "one
       truck fewer" is then told from the solves so far only.

    ``complete``, worked out for the set suggested: every set whose least cost is below its real cost was
    listed and ruled out (by its room, or a checked solve of it or a set alike that lost a P1-P3 stop - once
    repaired, with no lower priority riding on its trucks - or failed the checks, or that delivered at a
    real cost no lower); ``note`` (HIRE_NOT_PROVEN_NOTE) says so plainly when such a set was left untried
    and an option charges per km; no plan a solve
    proved had cheaper trucks for P1-P3 orders and a truck for P4/P5 orders alone it could not give back
    (steps 2-4); the suggestion rents no truck for P4/P5 orders alone (a give-back that could not be
    built: tenth review); and its give-back's swap had a timing for every stop it tried to put back
    (eleventh review). At most HIRE_REDUCE_MAX_SOLVES solves within
    _hire_reduce_window (and the request's budget); each starts only with room for its load re-check
    (_hire_trial_limit). A stop request ("use the best plan found so far") ends it, a cancel raises
    SolveAborted. Deterministic in its choices."""
    hires = {t.id: t for t in req.trucks if t.hire_candidate}
    rec_i = next((i for i, sc in enumerate(scenarios) if sc.name == "RECOMMENDED"), None)
    found = scenarios[rec_i] if rec_i is not None else None
    if found is None or found.status != "OPTIMIZED":
        return scenarios, HireCheck()
    first = _rented_of(found, set(hires))
    if not first:
        return scenarios, HireCheck(first=[], used=[], solves=0, complete=True)
    stop_of = {s.stop_id: s for s in req.stops}

    def high(sid: str) -> bool:
        return (stop_of[sid].priority if sid in stop_of else 5) <= HIRE_MAX_PRIORITY

    def repaired(rq: DispatchRequest, sc: DispatchScenario, lost: set[str], hired_idle: bool,
                 what: str) -> tuple[DispatchScenario, set[str]]:
        """``sc`` with its P1-P3 stops ``lost`` put back in place of lower priorities where they fit, with no
        solve (_repair_lost), and those still out while a lower priority rides on its trucks."""
        new, open_ = _repair_lost(rq, solvable, mx, drops, sc, lost,
                                  min(time.monotonic() + HIRE_REPAIR_SEC, budget_end - STAGE_GRACE_SEC), hired_idle)
        if new is not sc:
            log.info("run=%s hire check: %s left %s out while it carried lower priorities: put back with no solve",
                     req.run_id, what, sorted(lost & _served_of(new)))
        if open_:
            log.warning("run=%s hire check: %s leaves %s out while lower priorities ride on its trucks; not a proof",
                        req.run_id, what, sorted(open_))
        return new, open_

    # 0. The plan found: a P1-P3 stop it leaves out while it carries lower priorities goes back in their
    # place where it fits (thirteenth review), so every set is judged against every P1-P3 stop it can carry.
    if _passes_checks(found):
        lost_first = {s.stop_id for s in solvable if high(s.stop_id)} - _served_of(found)
        if lost_first:
            found, _ = repaired(req, found, lost_first, False, "the plan found")
    must = {sid for sid in _served_of(found) if high(sid)}
    must_stops = [stop_of[sid] for sid in sorted(must)]
    # BUG 5 (7 Oct 2026): a set is ruled out or ordered before its solve by the LEAST its trucks can cost
    # (_hire_floor_money: a km charge over the floor of a rented truck's km, never the rough day of the
    # search's tier, which priced a rental for a near customer as if it drove to the far ones - 123.13 OMR
    # kept where 87.59 delivered the same), and a plan is judged by what its trucks really cost on the km
    # they drive (_hire_routed_money). A flat-rate option costs the same in both: as before.
    money = _hire_floor_money(req.trucks, req.config, _hire_km_floor(mx))
    tds = _truck_days(req)
    room = _hire_room(tds)

    # The give-backs whose swap had no timing left to try a stop on the trucks kept (_swap_riders): a place
    # for it may have been missed, so such a suggestion is never complete (eleventh review).
    cut_short: list[DispatchScenario] = []

    def give_back(sc: DispatchScenario) -> DispatchScenario:
        cut: list[str] = []
        new = _without_low_hires(req, solvable, mx, drops, sc, set(hires), high, cut=cut)
        if cut:
            cut_short.append(new)
        return new

    # 1. No solve: the rented trucks that carry only P4/P5 orders. ``given`` is the plan given back from
    # (step 3 solves the set left).
    best = give_back(found)
    given = found
    current = _rented_of(best, set(hires))

    # 2. The cheapest set. Units of one option are the same truck but for their id and code: a set is how
    # many of each option, made of the plan's own units first.
    kinds: dict[str, list[str]] = {}
    for tid in sorted(hires, key=lambda u: (u not in first, u)):
        kinds.setdefault(hires[tid].model_dump_json(exclude={"id", "code"}), []).append(tid)
    groups = sorted(kinds.values(), key=lambda ids: min(ids))
    kind_of = {tid: k for k, ids in enumerate(groups) for tid in ids}

    def price(ids) -> float:
        return round(sum(money.get(t, 0.0) for t in ids), 6)

    def shape(ids) -> tuple[int, ...]:
        return tuple(sorted(kind_of[t] for t in ids))

    def cost(sc: DispatchScenario) -> float:
        """What the rented trucks of ``sc`` really cost: hire, driver day rate, km charge on their routed km."""
        routed = _hire_routed_money(sc, hires, req.config)
        return round(sum(routed[t] for t in _rented_of(sc, set(hires))), 6)

    best_cost = cost(best)
    top = (best_cost, len(current))
    cands: list[tuple[str, ...]] = []
    listed = 0  # the sets the walk reached (HIRE_REDUCE_MAX_SETS)

    def walk(k: int, chosen: tuple[str, ...]) -> None:
        """Every set whose least cost (``price``) is below ``top`` - what the plan's trucks really cost - (or
        as much with fewer trucks), as many units of each option as the request has - bounded by the price,
        never by the plan's count of trucks (eighth review)."""
        nonlocal listed
        if k == len(groups):
            listed += 1
            if (price(chosen), len(chosen)) < top and listed <= HIRE_REDUCE_MAX_SETS:
                cands.append(chosen)
            return
        for c in range(len(groups[k]) + 1):
            nxt = chosen + tuple(groups[k][:c])
            if price(nxt) > top[0] or listed > HIRE_REDUCE_MAX_SETS:
                break  # more units of this option never cost less
            walk(k + 1, nxt)

    walk(0, ())
    cands.sort(key=lambda ids: (price(ids), len(ids), -sum(room.get(t, 0) for t in ids), ids))

    trials: list[_HireTrial] = []
    # The sets solved to a plan that delivers every P1-P3 stop the plan delivers and passes every check:
    # their real cost was weighed, so none of them is left untried (BUG 5).
    tried: list[tuple[str, ...]] = []
    solves = 0
    broken = False  # a solve could not run (no worker processes, it failed): no more solves
    t0 = time.monotonic()
    end = min(budget_end - STAGE_GRACE_SEC, t0 + _hire_reduce_window(time_limit))

    def offer(ids: tuple[str, ...]) -> DispatchRequest:
        """The request with exactly the own trucks and the trucks to rent ``ids``."""
        keep = set(ids)
        return req.model_copy(update={"trucks": [t for t in req.trucks if not t.hire_candidate or t.id in keep]})

    def solve(ids: tuple[str, ...]) -> tuple[DispatchScenario | None, bool] | None:
        """A solve with exactly the own trucks and ``ids``; None when none may start (the solve limit, the
        window, a stop request)."""
        nonlocal solves
        if control is not None and control.cancelled.is_set():
            raise SolveAborted(f"The optimization was cancelled ({control.why or 'the caller is gone'}).")
        if control is not None and control.stop_requested.is_set():
            return None
        lim = _hire_trial_limit(time_limit, end - time.monotonic())
        if solves >= HIRE_REDUCE_MAX_SOLVES or lim is None:
            return None
        solves += 1
        return _hire_trial(offer(ids), solvable, mx, drops, lim, end, control)

    def judge(ids: tuple[str, ...], got: tuple[DispatchScenario | None, bool], again: bool = True) -> DispatchScenario | None:
        """The plan - repaired first (_repair_lost: a P1-P3 stop it leaves out goes back in place of lower
        priorities where it fits, thirteenth review) - when it keeps every P1-P3 stop and passes the checks;
        else the solve is recorded. One that still leaves a P1-P3 stop out while a lower priority rides on its
        trucks proves nothing: it is solved once more (``again``) if the limits allow, and recorded as
        unproven (it never rules its set out)."""
        nonlocal broken
        sc, rechecked = got
        ok = rechecked and _passes_checks(sc)
        open_: set[str] = set()
        if ok and not must <= _served_of(sc):  # type: ignore[arg-type]
            sc, open_ = repaired(offer(ids), sc, must - _served_of(sc), True, f"the solve of {list(ids)}")  # type: ignore[arg-type]
        if ok and must <= _served_of(sc):  # type: ignore[arg-type]
            return sc
        if sc is not None and rechecked:
            trials.append(_HireTrial(offered=ids, sc=sc if ok else None,
                                     lost=len(must - _served_of(sc)) if ok else 10**9, proven=not open_))
        if open_ and again:
            more = solve(ids)
            if more is not None and more[0] is None:
                broken = True
            elif more is not None:
                log.info("run=%s hire check: %s solved once more (its plan proved nothing)", req.run_id, list(ids))
                return judge(ids, more, again=False)
        return None

    def low(sc: DispatchScenario) -> set[str]:
        return _low_hires(sc, set(hires), high)

    # The trucks for P1-P3 orders of each plan a solve proved whose trucks for P4/P5 orders alone could
    # not be given back (_without_low_hires failed): that set may be cheaper than the one suggested.
    unbuilt: list[tuple[float, int]] = []

    def not_given(ids: tuple[str, ...], step: str, new: DispatchScenario) -> None:
        p1_3 = [t for t in _rented_of(new, set(hires)) if t not in low(new)]
        unbuilt.append((price(p1_3), len(p1_3)))
        log.warning("run=%s hire check: the plan of %s (%s) still rents %s for P4/P5 orders alone (its give-back "
                    "could not be built); not the suggestion", req.run_id, list(ids), step, sorted(low(new)))

    for ids in cands:
        if (price(ids), len(ids)) >= (best_cost, len(current)):
            # No set left can cost less than the plan held (BUG 5: with a km charge the first set that
            # delivers is not always the cheapest; a flat-rate day stops right after it, as before).
            break
        if shape(ids) == shape(current):
            continue  # the set held (its least cost is below its real cost when it has a km charge)
        if _hire_room_short(tds, set(ids), must_stops):
            continue  # ruled out by its room alone
        got = solve(ids)
        if got is None or got[0] is None:
            broken = got is not None  # out of solves or time, or it could not run: the set found stays
            break
        sc = judge(ids, got)
        if sc is None:
            if broken:
                break  # its solve once more could not run: the set found stays
            continue  # it lost a P1-P3 stop or failed the checks; or no load re-check: neither kept nor ruled out
        new = give_back(sc)
        if low(new) and not low(best):
            # A truck for P4/P5 orders alone (owner answer 1) is never suggested while a plan without one
            # is at hand (tenth review: this plan was, and called complete).
            not_given(ids, "the cheapest set", new)
            continue
        tried.append(ids)
        kept, paid = _rented_of(new, set(hires)), cost(new)
        if (paid, len(kept)) >= (best_cost, len(current)):
            log.info("run=%s hire check: %s delivers every P1-P3 stop but costs %.2f OMR on its routed km "
                     "(%.2f held); kept looking", req.run_id, list(ids), paid, best_cost)
            continue
        log.info("run=%s hire check: %s delivers every P1-P3 stop (%s before, %.2f -> %.2f OMR)", req.run_id,
                 list(ids), current, best_cost, paid)
        best, given = new, sc
        current, best_cost = kept, paid

    # 3. Trucks given back: the set left, solved - the P4/P5 orders they carried may ride along in the
    # trucks kept (owner answer 1; eighth review: the give-back alone left them out). Its plan replaces the
    # give-back when its set is cheaper (ninth review: the money was never compared, so a cheaper set this
    # solve proved was thrown away), or as cheap and serving more by the day's priorities (ninth review:
    # raw stop counts let two P5 orders outweigh one P4) - or as cheap at all when the give-back fails the
    # checks (a plan kept as the search found it: eleventh review; its set was tried here only); never with
    # a truck for P4/P5 orders alone.
    if best is not given and not broken and not any(shape(tr.offered) == shape(current) for tr in trials):
        ids = tuple(current)
        got = solve(ids)
        if got is not None and got[0] is None:
            broken = True
        elif got is not None and (sc := judge(ids, got)) is not None:
            tried.append(ids)
            again = give_back(sc)
            kept = _rented_of(again, set(hires))
            paid, was = (cost(again), len(kept)), (best_cost, len(current))
            rank = (_service_rank(again, stop_of, req.config), _service_rank(best, stop_of, req.config))
            if low(again):
                # Its plan without them could not be built: its trucks for P1-P3 orders may be a cheaper
                # set than the one kept, which is then not proven the cheapest.
                not_given(ids, "solved again after the give-back", again)
            elif paid < was or (paid == was and (rank[0] > rank[1] or not _passes_checks(best))):
                log.info("run=%s hire check: %s solved again after the give-back: %s at %.2f OMR (%.2f before), "
                         "served by priority %s -> %s", req.run_id, list(ids), kept, paid[0], was[0], rank[1], rank[0])
                best = again
                current, best_cost = kept, paid[0]

    # 4. One truck fewer than the suggested set, solved. A plan of it that keeps every P1-P3 stop and
    # passes every check proves that cheaper set: it is the suggestion (tenth review: it was thrown away).
    def fewer(u: str) -> list[_HireTrial]:
        """The checked solves of the suggested set less ``u`` (or a unit alike) - each lost a P1-P3 stop or
        failed the checks (a solve that did neither is the suggestion)."""
        want = shape([t for t in current if t != u])
        return [tr for tr in trials if shape(tr.offered) == want]

    if len(current) >= 2 and not broken:
        least = min(current, key=lambda u: (room.get(u, 0), -money.get(u, 0.0), u))
        if not fewer(least):
            rest = tuple(t for t in current if t != least)
            got = solve(rest)
            if got is not None and got[0] is not None and (sc := judge(rest, got)) is not None:
                new = give_back(sc)
                kept, paid = _rented_of(new, set(hires)), cost(new)
                if low(new) and not low(best):
                    not_given(rest, "one truck fewer", new)
                elif (paid, len(kept)) >= (best_cost, len(current)):
                    # Fewer trucks but more km at their charge (BUG 5): it costs more. A flat-rate set with a
                    # truck fewer always costs less.
                    tried.append(rest)
                    log.info("run=%s hire check: one truck fewer, %s, delivers every P1-P3 stop but costs %.2f OMR "
                             "on its routed km (%.2f held)", req.run_id, list(rest), paid, best_cost)
                else:
                    tried.append(rest)
                    log.info("run=%s hire check: one truck fewer, %s, delivers every P1-P3 stop (%.2f -> %.2f OMR)",
                             req.run_id, list(rest), best_cost, paid)
                    best = new
                    current, best_cost = kept, paid
    one: tuple[int, float, str, _HireTrial] | None = None
    if len(current) >= 2:
        for u in current:
            # Never from a solve that proved nothing (thirteenth review): its orders left out may fit.
            tr = next((t for t in fewer(u) if t.sc is not None and t.proven), None)
            if tr is not None and (one is None or (tr.lost, -money.get(u, 0.0), u) < one[:3]):
                one = (tr.lost, -money.get(u, 0.0), u, tr)

    # Complete: the set suggested is proven the cheapest - every set cheaper than it was listed and ruled
    # out by its room or by a checked solve (of it or a set alike) that lost a P1-P3 stop - once repaired,
    # with no lower priority riding on its trucks (thirteenth review) - or failed the checks;
    # no plan a solve proved has cheaper trucks for P1-P3 orders whose give-back could not be built; it
    # rents no truck for P4/P5 orders alone (tenth review: such a plan was "complete"); and its give-back's
    # swap had a timing for every stop it tried to put back (eleventh review).
    final = (best_cost, len(current))
    swap_cut = any(best is s for s in cut_short)
    # The sets whose least cost is below what the suggestion really costs and that nothing ruled out: not
    # tried (the solve limit, the window, a stop request) or tried with no proof (BUG 5: they may cost less).
    untried = [ids for ids in cands if (price(ids), len(ids)) < final and shape(ids) != shape(current)
               and not _hire_room_short(tds, set(ids), must_stops)
               and not any(shape(tr.offered) == shape(ids) and tr.proven for tr in trials)
               and not any(shape(t) == shape(ids) for t in tried)]
    complete = (listed <= HIRE_REDUCE_MAX_SETS and not low(best) and not any(u < final for u in unbuilt) and not swap_cut
                and not untried)
    # Said plainly when a km charge leaves sets that may cost less untried (BUG 5); a flat-rate day says
    # nothing new (``complete`` as before).
    note = HIRE_NOT_PROVEN_NOTE if untried and any(_km_charged(t) for t in hires.values()) else None
    if note:
        log.warning("run=%s hire check: %d set(s) that may cost less on their km were not tried or ruled out "
                    "(solves=%d); not proven the cheapest", req.run_id, len(untried), solves)
    if low(best):
        log.warning("run=%s hire check: the suggestion still rents %s for P4/P5 orders alone (its give-back could not "
                    "be built); not complete", req.run_id, sorted(low(best)))
    if swap_cut:
        log.warning("run=%s hire check: the suggestion's give-back ran out of timings putting its stops back; not complete",
                    req.run_id)
    check = HireCheck(
        first=first,
        used=sorted(current),
        solves=solves,
        complete=complete,
        note=note,
        one_fewer=HireOneFewer(without=one[2], unserved=sorted(u.stop_id for u in one[3].sc.unserved))  # type: ignore[union-attr]
        if one is not None else None,
    )
    log.info("run=%s hire check: rented first=%s used=%s solves=%d complete=%s one_fewer=%s (%.1fs)", req.run_id,
             check.first, check.used, check.solves, check.complete, check.one_fewer.without if check.one_fewer else None,
             time.monotonic() - t0)
    if best is not scenarios[rec_i]:
        scenarios = list(scenarios)
        scenarios[rec_i] = best
    return scenarios, check


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


class WorkersUnavailable(RuntimeError):
    """Rule 22: the solver could not start its worker processes, so nothing was searched. main.py
    answers 503 (Retry-After 60, code WORKERS_UNAVAILABLE) with PLANNER_UNAVAILABLE_MSG; the web
    keeps the previous plan and the dispatcher tries again. ``cause`` is the technical reason (logs
    and /ready only)."""

    code = "WORKERS_UNAVAILABLE"

    def __init__(self, cause: str):
        super().__init__(PLANNER_UNAVAILABLE_MSG)
        self.cause = cause


def _parallel() -> bool:
    """False only with SOLVER_PARALLEL=0 (tests and local debugging: every search in-process)."""
    return os.environ.get("SOLVER_PARALLEL", "1") != "0"


def inprocess_fallback_allowed() -> bool:
    """SOLVER_ALLOW_INPROCESS_FALLBACK=1: a worker pool that cannot start makes the solve run inside
    the API process, as before rule 22 (no deadline; the API does not answer meanwhile). Development
    and tests only; main.py logs a warning at startup when it is set (an error on Railway)."""
    return os.environ.get("SOLVER_ALLOW_INPROCESS_FALLBACK", "") == "1"


def worker_start_sec() -> float:
    """How long a new worker pool may take to run its first task (env SOLVER_WORKER_START_SEC)."""
    return _env_num("SOLVER_WORKER_START_SEC", WORKER_START_SEC, lo=1, hi=600)


class _WorkerHealth:
    """Whether this solver process's worker pools failed recently, for /ready (rule 22): "failed"
    from a failed start (or a pool that broke, or did not close) until WORKER_ALERT_SEC after the
    last failure, or until a pool starts at least WORKER_ALERT_MIN_SEC after it (started())."""

    def __init__(self) -> None:
        import threading

        self._lock = threading.Lock()
        self._failed_mono: float | None = None
        self._failed_at = ""
        self._cause = ""

    def failed(self, cause: str) -> None:
        from datetime import datetime, timezone

        with self._lock:
            self._failed_mono = time.monotonic()
            self._failed_at = datetime.now(timezone.utc).isoformat(timespec="seconds")
            self._cause = cause[:300]

    def started(self) -> None:
        """A pool started and ran its first task. That is a recovery only WORKER_ALERT_MIN_SEC or
        more after the last failure (second review): sooner, it is usually the same solve's load
        re-check or another company's solve, and clearing then hid the failure from monitoring."""
        with self._lock:
            if self._failed_mono is not None and time.monotonic() - self._failed_mono >= WORKER_ALERT_MIN_SEC:
                self._failed_mono = None

    def reset(self) -> None:
        """Forget any failure (tests: each one starts from a clean state)."""
        with self._lock:
            self._failed_mono = None

    def status(self) -> dict:
        with self._lock:
            if self._failed_mono is not None and time.monotonic() - self._failed_mono < WORKER_ALERT_SEC:
                return {"status": "failed", "failed_at": self._failed_at, "cause": self._cause}
            return {"status": "ok"}


WORKER_HEALTH = _WorkerHealth()


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


# In the second search's worker process: set when the engine's searches have ended (QUICK: PyVRP
# then returns its best plan within a fraction of a second, pyvrp_candidate.Stopper).
_SEARCH_OVER = None

# Linux: how readily the kernel's out-of-memory killer takes this process (-1000..1000). The second
# search's worker sets the maximum at start (CI 30 Sep 2026: the API process vanished, killed without
# a traceback, as the second search's worker started - and every later solve failed). With it, a
# machine or container short of memory loses the optional second search first (LOST: the engine's
# plans are used), never the API process for it. Raising one's own value needs no privilege.
OOM_SCORE_ADJ_PATH = "/proc/self/oom_score_adj"
SECOND_SEARCH_OOM_SCORE_ADJ = 1000


def _prefer_as_oom_victim(score: int) -> bool:
    """This process asks to be the kernel's first out-of-memory victim; False where it cannot (no
    /proc: Windows, macOS; a read-only /proc). Best effort: never stops a worker from starting."""
    try:
        if not os.path.exists(OOM_SCORE_ADJ_PATH):
            return False
        with open(OOM_SCORE_ADJ_PATH, "w", encoding="ascii") as f:
            f.write(str(score))
        return True
    except OSError:
        return False


def _worker_init(beacon, stop_flag=None, search_over=None) -> None:
    global _BEACON, _STOP_FLAG, _SEARCH_OVER
    # Test hook (rule 22): every worker process dies while starting, so the pool never runs a task.
    if os.environ.get("ROUTEIQ_TEST_WORKER_START_EXIT") == "1":
        os._exit(3)
    _BEACON = beacon
    _STOP_FLAG = stop_flag
    _SEARCH_OVER = search_over
    if search_over is not None:  # the second search's own process (_PvProcess): optional, so taken first
        _prefer_as_oom_victim(SECOND_SEARCH_OOM_SCORE_ADJ)


def _ping(_arg=None) -> int:
    """A new pool's first task (_Workers.check_started): proves a worker process runs tasks."""
    return os.getpid()


def _tracked(token: str, fn, arg):
    """Run ``fn(arg)`` in a pool worker after reporting which process runs it, so a dead worker
    loses only its own task (its siblings keep running)."""
    if _BEACON is not None:
        try:
            _BEACON.put((token, os.getpid()))
        except Exception:  # noqa: BLE001 - death detection then falls back to the deadline
            pass
    return fn(arg)


_ALERT_ADVICE = "If this repeats, check the solver service's memory and process limits and restart it."


def _workers_alert(run_id: str, happened: str, cause: str, *, nothing_searched: bool = True) -> None:
    """Rule 22: tell the administrator. /ready reports the workers as failed (WORKER_HEALTH, the
    web's /api/health: degraded) and one ERROR line whose message starts with the stable code
    WORKERS_UNAVAILABLE (after the log format's timestamp, level and logger name: alert on a
    line that contains the code, not on the cause text, which depends on the error)."""
    WORKER_HEALTH.failed(cause)
    log.error("WORKERS_UNAVAILABLE run=%s: %s (%s).%s %s", run_id, happened, cause,
              " Nothing is searched inside the API process (rule 22)." if nothing_searched else "", _ALERT_ADVICE)


class _Task:
    """One pool task, as the waits see it: ready(), get(), wait(). The pool's own AsyncResult never
    leaves _Workers: close() cuts every task loose, so a frame or a traceback that still holds one (an
    exception's, which main.py keeps) keeps nothing of the pool alive. An AsyncResult references the
    Pool, its task cache and its queues; one that never finished is even a cycle with the Pool, which
    only the garbage collector frees (CI, PR #50)."""

    __slots__ = ("_ar",)

    def __init__(self, ar) -> None:
        self._ar = ar

    def ready(self) -> bool:
        ar = self._ar
        return ar is not None and ar.ready()

    def get(self):
        ar = self._ar
        if ar is None:
            raise RuntimeError("the worker pool was closed")
        return ar.get()

    def wait(self, timeout: float) -> None:
        ar = self._ar
        if ar is not None:
            ar.wait(timeout)
        else:  # closed (_await_all stops at its next check)
            time.sleep(max(0.0, min(timeout, 0.5)))


class _Workers:
    """A spawn Pool with what the waits need, without Pool's private attributes where possible:
    its size (stored here, not read from Pool._processes) and which worker process runs which task
    (each task reports its pid when it starts). Worker pids come from Pool's private worker list;
    when that is gone, pids() is None and deaths are only seen at the deadline.

    Rule 22 (review): broken() says when the pool can no longer run tasks (the waits then stop at
    once, _await_all), and close() never holds the request for more than about POOL_CLOSE_SEC.

    CI (PR #50, a segmentation fault while the garbage collector ran in the API's event-loop thread):
    everything the pool made - its queues' pipes and locks, its worker processes, the stop flag, the
    tasks' results - is closed and released by close(), in the thread that calls it, before the solve
    returns; after close() this object holds nothing of multiprocessing, so nothing is left for the
    garbage collector even when a traceback keeps it."""

    def __init__(self, size: int, control: SolveControl | None = None, *, run_id: str = "", what: str = "search"):
        import multiprocessing as mp

        ctx = mp.get_context("spawn")
        self.size = max(1, int(size))
        self.run_id = run_id
        self.what = what  # "search" or "load re-check", for the administrator's log lines
        self.pool = None
        # The solve's "stop now" flag, seen by every THOROUGH search in these workers (_watch_search).
        # Every wait on these workers also watches the control (cancelled: SolveAborted, _await_all).
        self.control = control
        self._stop_flag = None
        self._beacon = ctx.SimpleQueue()
        try:
            self._stop_flag = ctx.Event() if control is not None else None
            self.pool = ctx.Pool(processes=self.size, initializer=_worker_init, initargs=(self._beacon, self._stop_flag))
        except BaseException as exc:
            # Nothing left behind by a failed start (rule 22; audit finding: the queue made above used
            # to stay open). Pool itself stops the worker processes it had started; the traceback is
            # cut here so that it does not keep Pool's half-made queues alive (CI, PR #50).
            self._beacon.close()
            self._beacon = self._stop_flag = None
            raise exc.with_traceback(None)  # noqa: B904 - the same exception, without Pool's frames
        if self._stop_flag is not None:
            control.attach(self._stop_flag)  # type: ignore[union-attr]
        self._pid_of: dict[str, int] = {}
        self._tasks: dict[str, _Task] = {}  # token -> each task not seen finished yet
        self._handles: list[_Task] = []  # every task given out (close() cuts them loose)
        self._seq = 0
        self._warned = False
        self._closed = False
        self._close_ok = True
        self._proved = False  # check_started saw a task run (before that, _start_workers alerts)
        self._broken: str | None = None

    @property
    def closed(self) -> bool:
        return self._closed

    def check_started(self, timeout: float) -> None:
        """Rule 22: the pool runs a task within ``timeout`` seconds, or RuntimeError. Catches a pool
        whose processes die while starting (Pool starts them again and again, and a task would wait
        for its deadline - up to the whole THOROUGH cap), at once when no replacement can start
        (broken()). A cancelled control: SolveAborted."""
        kind, value = _await_all(self, {"start": self.submit(_ping, None, "start")}, time.monotonic() + timeout)["start"]
        if kind == "ok":
            self._proved = True
            return
        if kind == "timeout":
            raise RuntimeError(f"no worker process ran a task within {timeout:g} s (they may be dying while starting)")
        if kind == "broken":
            raise RuntimeError(str(value))
        raise RuntimeError(f"the first worker task {'lost its process' if kind == 'lost' else 'failed'}: {value}")

    def submit(self, fn, arg, name: str):
        """Start ``fn(arg)`` in a worker; returns (token, _Task)."""
        if self._closed:
            raise RuntimeError(f"the worker pool for the {self.what} was closed")
        self._seq += 1
        token = f"{name}#{self._seq}"
        task = _Task(self.pool.apply_async(_tracked, (token, fn, arg)))  # type: ignore[union-attr]
        self._tasks[token] = task
        self._handles.append(task)
        return token, task

    def busy(self, live: frozenset[int]) -> int:
        """How many worker processes are running a task now: tasks that reported their start (see
        started()) in a process still alive (``live``, from pids()) and have not finished."""
        for tok in [t for t, fut in self._tasks.items() if fut.ready()]:  # type: ignore[attr-defined]
            del self._tasks[tok]
        return sum(1 for tok in self._tasks if self._pid_of.get(tok) in live)

    def broken(self, settle: float = 0.0) -> str | None:
        """Rule 22 (review): why this pool can no longer run new tasks, or None. Pool's worker-handler
        thread replaces every worker process that dies; when it cannot (Process.start raised: out of
        memory, the process limit) that thread dies, and no process is ever replaced again. Also set
        by _await_all when no process takes a task although one is free (mark_broken). ``settle``:
        after a worker died, wait up to that long for the handler's attempt to replace it."""
        if self._broken is None and not self._closed:
            handler = getattr(self.pool, "_worker_handler", None)
            try:
                if handler is not None and settle > 0 and handler.is_alive():
                    handler.join(settle)
                if handler is not None and not handler.is_alive():
                    self.mark_broken("a worker process stopped and no replacement could start: out of memory or the "
                                     "process limit?")
            except Exception:  # noqa: BLE001 - Pool internals changed: the deadlines still hold
                pass
        return self._broken

    def mark_broken(self, cause: str) -> str:
        """Record that the pool broke (the first cause stays). A pool that had run a task alerts the
        administrator here; a new one does in _start_workers, which then refuses the solve."""
        if self._broken is None:
            self._broken = cause
            if self._proved:
                _workers_alert(self.run_id, f"the solver's worker processes stopped working during the {self.what}", cause)
        return self._broken

    def started(self) -> dict[str, int]:
        """token -> pid of every task that has started so far."""
        try:
            while self._beacon is not None and not self._beacon.empty():
                token, pid = self._beacon.get()
                self._pid_of[token] = pid
        except Exception:  # noqa: BLE001
            pass
        return self._pid_of

    def pids(self) -> frozenset[int] | None:
        if self._closed:
            return frozenset()
        try:
            return frozenset(p.pid for p in getattr(self.pool, _POOL_ATTR))
        except (AttributeError, TypeError):
            if not self._warned:
                self._warned = True
                log.warning("worker pool internals unavailable: a dead worker is only noticed at its deadline")
            return None

    def close(self) -> bool:
        """Stop the workers (and any task still running past its deadline), then release everything
        the pool made. Safe to call twice.

        Rule 22 (review): bounded. CPython's Pool.terminate() waited forever on a pool that broke
        (_stop_pool_processes), which held the request - its answer, its slot - for good. The worker
        processes are now stopped first, then terminate() and join() run in a helper thread for at
        most POOL_CLOSE_SEC. False when they did not finish in that time: the administrator is
        alerted (an ERROR line, /ready) and the cleanup goes on in the background.

        CI (PR #50): once terminate() and join() returned, this thread (the one that waits) closes the
        pool's queues and worker processes (_release_pool), cuts its tasks loose, closes the start
        reports' queue and detaches the stop flag from the solve's control; the Pool and every lock
        it made are then freed here, by reference counting, when this returns - never later by the
        garbage collector in another thread. When the cleanup is left to the background, the helper
        thread releases the pool the same way as soon as terminate() returns."""
        if self._closed:
            return self._close_ok
        self._closed = True
        pool = self.pool
        procs = _stop_pool_processes(pool)
        run_id = self.run_id
        gate = threading.Lock()
        state = {"done": False, "left": False}  # terminate() returned / the caller stopped waiting
        finished = threading.Event()

        def cleanup() -> None:
            try:
                pool.terminate()
                pool.join()
            except Exception as exc:  # noqa: BLE001 - nothing to do about it but say so
                log.warning("run=%s worker pool cleanup failed: %s", run_id, exc)
            with gate:
                state["done"] = True
                left = state["left"]
            finished.set()
            if left:  # the caller stopped waiting (POOL_CLOSE_SEC): released here, still explicitly
                _release_pool(pool, procs)

        helper = threading.Thread(target=cleanup, name="routeiq-pool-close", daemon=True)
        helper.start()
        finished.wait(POOL_CLOSE_SEC)
        with gate:
            done = state["done"]
            state["left"] = not done
        if done:
            helper.join(POOL_CLOSE_SEC)  # it has done its work: it ends at once
            _release_pool(pool, procs)
        self._close_ok = done
        if not done:
            _workers_alert(self.run_id, f"a worker pool did not stop within {POOL_CLOSE_SEC:g} s after the {self.what} "
                           "and is left to stop in the background", "Pool.terminate() did not return", nothing_searched=False)
        self._forget()
        return self._close_ok

    def _forget(self) -> None:
        """close(): hold nothing of multiprocessing any more - the tasks' results, the start reports'
        queue, the stop flag (detached from the solve's control, which outlives the solve in main.py)
        and the pool itself."""
        for task in self._handles:
            task._ar = None
        self._handles = []
        self._tasks = {}
        if self._beacon is not None:
            try:
                self._beacon.close()
            except Exception:  # noqa: BLE001
                pass
        if self._stop_flag is not None and self.control is not None:
            self.control.detach(self._stop_flag)
        self._beacon = self._stop_flag = None
        self.pool = None


def _release_pool(pool, procs: list) -> None:
    """After Pool.terminate() and join() (_Workers.close): close what the Pool made, in this thread -
    its three queues' pipes and its worker processes (their handles, and their place in
    multiprocessing's list of children) - and forget its tasks that never finished: each is an
    AsyncResult -> Pool -> task cache -> AsyncResult cycle that only the garbage collector would free,
    in whatever thread it happens to run (CI, PR #50: the API's event-loop thread). The Pool, and every
    lock it made, is then freed as soon as its owner drops it. Best effort on Pool's private
    attributes, like _stop_pool_processes."""
    import multiprocessing as mp

    try:
        pool._cache.clear()
    except Exception:  # noqa: BLE001
        pass
    for name in ("_inqueue", "_outqueue", "_change_notifier"):
        try:
            getattr(pool, name).close()
        except Exception:  # noqa: BLE001
            pass
    workers: list = []
    for p in [*procs, *list(getattr(pool, _POOL_ATTR, None) or [])]:
        if not any(p is q for q in workers):
            workers.append(p)
    for p in workers:
        _close_process(p)
    try:
        getattr(pool, _POOL_ATTR).clear()
    except Exception:  # noqa: BLE001
        pass
    # Worker processes that died earlier and were replaced (no longer in the pool's list): forgotten
    # by multiprocessing's list of children now, and so freed here.
    mp.active_children()


def _close_process(p) -> None:
    """Process.close() on a process that has ended: its handles closed and multiprocessing's list of
    children forgets it. A process still running (it could not be killed) is left as it is, with a
    warning."""
    try:
        if p.exitcode is None and getattr(p, "_popen", None) is not None:
            log.warning("worker process %s did not stop; its handles stay open", p.pid)
            return
        p.close()
    except (ValueError, AttributeError):  # never started, or already closed
        pass


def _stop_pool_processes(pool) -> list:
    """Rule 22 (review): let Pool.terminate() finish on a pool that broke. CPython's terminate()
    waits forever when (1) Pool's worker-handler thread died - it could not start a replacement
    process (out of memory, the process limit) - so its task-handler thread never gets the stop
    sentinel (terminate waits in task_handler.join()), or (2) a worker process died while it waited
    for a task, holding the task queue's read lock (terminate first takes that lock). So, first:
    the worker handler is told to stop (as terminate does first: no replacement starts behind our
    back), every worker process is killed, the stop sentinel a dead handler never sent is sent, and
    the queue locks a dead worker left held are released (the task queue's read lock; on Linux also
    the result queue's write lock, held while a worker sends a result: killing the workers first
    must not create a new way to hang). Best effort on Pool's private attributes; close() bounds
    whatever still waits. Returns the worker processes it stopped (_release_pool closes them)."""
    import multiprocessing.pool as mpp

    handler = getattr(pool, "_worker_handler", None)
    try:
        if handler is not None and handler.is_alive():
            handler._state = mpp.TERMINATE
            pool._change_notifier.put(None)  # wakes it: it stops without starting a replacement
            handler.join(1.0)
    except Exception:  # noqa: BLE001
        pass
    procs = list(getattr(pool, _POOL_ATTR, None) or [])
    for p in procs:
        try:
            if p.exitcode is None:
                p.kill()
        except Exception:  # noqa: BLE001
            pass
    end = time.monotonic() + 3.0
    for p in procs:
        try:
            p.join(max(0.0, end - time.monotonic()))
        except Exception:  # noqa: BLE001
            pass
    try:
        if handler is not None and not handler.is_alive():
            pool._taskqueue.put(None)  # a second sentinel after a normal stop is harmless
            pool._task_handler.join(1.0)  # it sends its own sentinels and ends (unless a queue is stuck)
    except Exception:  # noqa: BLE001
        pass
    if procs and all(p.exitcode is not None for p in procs):
        # Every worker process is dead, so none of them can hold a lock legitimately: the task
        # queue's read lock (an idle worker holds it while it waits for a task) and, on Linux, the
        # result queue's write lock (held while a worker sends a result; Windows has none).
        for owner, name in ((getattr(pool, "_inqueue", None), "_rlock"), (getattr(pool, "_outqueue", None), "_wlock")):
            try:
                _free_lock_of_dead(getattr(owner, name, None))
            except Exception:  # noqa: BLE001
                pass
    return procs


def _free_lock_of_dead(lock) -> None:
    """A multiprocessing lock that a killed process held stays held for good (a semaphore has no
    owner): give it back for it. Only for locks no live process uses any more (_stop_pool_processes)."""
    if lock is None:
        return
    if lock.acquire(False):
        lock.release()  # it was free: taken and given back
    else:
        lock.release()  # held by a dead process, which never gives it back


def _start_workers(size: int, control: SolveControl | None, run_id: str, what: str) -> _Workers | None:
    """Rule 22: a worker pool that has run its first task, or no search at all.

    A pool that cannot start (an OSError: out of memory, the process limit) or whose first task
    does not run within worker_start_sec() - or at once, when its processes die and no replacement
    can start - is closed again and the solve is refused: WorkersUnavailable (main.py: 503 "The
    planner is busy or restarting - try again in a minute"), with an ERROR line for the
    administrator and /ready reporting the workers as failed, both before the pool is closed (the
    alert stays even if closing misbehaves). Nothing is searched inside the API process. Only with
    SOLVER_ALLOW_INPROCESS_FALLBACK=1 (development and tests) is None returned instead: the caller
    then solves in-process, as before rule 22."""
    workers: _Workers | None = None
    try:
        workers = _Workers(size, control, run_id=run_id, what=what)
        workers.check_started(worker_start_sec())
    except SolveAborted:
        if workers is not None:
            workers.close()
        raise  # cancelled while waiting: the caller is gone
    except Exception as exc:  # noqa: BLE001 - every way a pool fails to start
        cause = f"{type(exc).__name__}: {exc}"
        fallback = inprocess_fallback_allowed()
        if fallback:
            WORKER_HEALTH.failed(cause)
            log.warning("run=%s worker processes unavailable for the %s (%s); SOLVER_ALLOW_INPROCESS_FALLBACK=1: "
                        "running it inside the API process (development and tests only)", run_id, what, cause)
        else:
            _workers_alert(run_id, f"the solver could not start its worker processes for the {what}", cause)
        if workers is not None:
            try:
                workers.close()
            except Exception:  # noqa: BLE001
                pass
        if fallback:
            return None
        raise WorkersUnavailable(cause) from exc
    WORKER_HEALTH.started()
    return workers


def _await_all(workers: _Workers, jobs: dict[str, tuple[str, object]], deadline: float,
               control: SolveControl | None = None) -> dict[str, tuple[str, object]]:
    """Wait for several pool tasks (name -> (token, AsyncResult)), in completion order, until
    ``deadline``. Returns name -> ("ok", value) | ("error", exception) | ("lost", None) (its worker
    process died) | ("broken", cause) (the pool can no longer run it, below) | ("timeout", None).
    A dead worker loses only the task it was running: a sibling that is still computing is never
    aborted because another worker died (review L23). ``control`` cancelled (the caller is gone):
    SolveAborted within half a second.

    Rule 22 (review): a broken pool is noticed at once, not at the deadline (for a thorough plan
    the 20-minute cap). A task that has not started, or lost its process, is "broken" when the pool
    can no longer start a replacement process (_Workers.broken), or when it has waited to start for
    worker_start_sec() while a worker process was free: a worker that died waiting for a task left
    the task queue locked, and no process can take a task again. A task still running in a live
    worker process goes on."""
    out: dict[str, tuple[str, object]] = {}
    pending = dict(jobs)
    base = workers.pids()
    control = control if control is not None else getattr(workers, "control", None)
    free_since: float | None = None  # since when a task waits to start while a worker is free
    while pending:
        if control is not None and control.cancelled.is_set():
            raise SolveAborted(f"The optimization was cancelled ({control.why or 'the caller is gone'}).")
        if getattr(workers, "closed", False):  # its tasks were cut loose (close): none can finish now
            for name in pending:
                out[name] = ("broken", f"the worker pool for the {workers.what} was closed")
            break
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
        started = workers.started()
        lost_now: list[str] = []
        if base is not None and now is not None:
            # A task whose process is gone - during this wait, or before it began (critique of the
            # PyVRP spec: a second search that died while RECOMMENDED was awaited used to be seen
            # only at its deadline, as a timeout).
            for name, (tok, fut) in list(pending.items()):
                pid = started.get(tok)
                if pid is not None and pid not in now and not fut.ready():  # type: ignore[attr-defined]
                    out[name] = ("lost", None)
                    del pending[name]
                    lost_now.append(name)
            base = now
        cause = workers.broken(settle=0.5 if lost_now else 0.0)
        if cause is None and now is not None:
            waiting = any(tok not in started and not fut.ready() for tok, fut in pending.values())  # type: ignore[attr-defined]
            if waiting and workers.busy(now) < workers.size:
                free_since = time.monotonic() if free_since is None else free_since
                if time.monotonic() - free_since >= worker_start_sec():
                    cause = workers.mark_broken(
                        f"no worker process took a task for {worker_start_sec():g} s although one was free: a worker "
                        "process that died may have left the task queue locked")
            else:
                free_since = None
        if cause is None:
            continue
        for name in lost_now:
            out[name] = ("broken", cause)
        for name, (tok, fut) in list(pending.items()):
            pid = started.get(tok)
            if not fut.ready() and (pid is None or (now is not None and pid not in now)):  # type: ignore[attr-defined]
                out[name] = ("broken", cause)
                del pending[name]
    return out


# How the log says why a pool task was not run (_await_all's "lost" and "broken").
_NOT_RUN = {"lost": "lost its worker", "broken": "could not run, the worker pool broke"}


def _await_worker(workers: _Workers, job: tuple[str, object], deadline: float, what: str):
    """Wait for one pool task; fail fast when ITS worker process dies (e.g. out of memory), and with
    rule 22's WorkersUnavailable (503) when the pool broke (_await_all)."""
    kind, value = _await_all(workers, {what: job}, deadline)[what]
    if kind == "ok":
        return value
    if kind == "broken":
        raise WorkersUnavailable(str(value))
    if kind == "error":
        raise value  # type: ignore[misc]
    if kind == "lost":
        raise SolveAborted(f"The optimizer process stopped unexpectedly while computing the {what} (out of memory?). Try again.")
    raise SolveAborted(f"The optimizer did not finish the {what} in time. Try again, or plan fewer stops at once.")


# ---------------------------------------------------------------------------------------------
# The second route search (PyVRP, pyvrp_candidate.py): its own optional process
# ---------------------------------------------------------------------------------------------

# THOROUGH: PyVRP's own backstop ends this long before the load re-check's reserve, so its answer is
# in before the re-check starts.
PV_MARGIN_SEC = 3.0


class _PipeFlag:
    """A "stop now" / "the engine's searches are over" flag for the second search's process, made of
    one pipe: set() writes one byte, the process polls for it (_FlagReader). No lock and no semaphore
    (a multiprocessing Event is five semaphores, and its set() waits on a lock that a killed process
    may hold for good). set() may come from any thread (SolveControl: the stop endpoint, the event
    loop on a cancel); close() from the solve's own thread, after SolveControl.detach."""

    def __init__(self, ctx) -> None:
        self.reader, self._writer = ctx.Pipe(duplex=False)
        self._lock = threading.Lock()
        self._set = False

    def set(self) -> None:
        with self._lock:
            if self._set or self._writer is None:
                return
            self._set = True
            try:
                self._writer.send_bytes(b"1")
            except OSError:  # the process is gone
                pass

    def drop_reader(self) -> None:
        """After the process started (it has its own copy of the reading end)."""
        reader, self.reader = self.reader, None
        if reader is not None:
            reader.close()

    def close(self) -> None:
        with self._lock:
            writer, self._writer = self._writer, None
        self.drop_reader()
        if writer is not None:
            writer.close()


class _FlagReader:
    """The second search's process's side of a _PipeFlag (pyvrp_candidate.Stopper calls is_set()):
    set once a byte is there - or once the pipe ended, the API process gone."""

    def __init__(self, conn) -> None:
        self._conn = conn
        self._set = False

    def is_set(self) -> bool:
        if not self._set:
            try:
                self._set = bool(self._conn.poll())
            except (EOFError, OSError):
                self._set = True
        return self._set


def _pv_main(jobs, results, stop, over) -> None:
    """The second search's process (_PvProcess): runs each (fn, arg) it receives on ``jobs`` and
    answers on ``results`` with ("ok", value) or ("error", "Type: message") - an exception goes back
    as text, so the API process never unpickles a class of this process's libraries (PyVRP, numpy) -
    until the API process closes its end or kills it."""
    _worker_init(None, _FlagReader(stop) if stop is not None else None, _FlagReader(over))
    try:
        while True:
            try:
                fn, arg = jobs.recv()
            except (EOFError, OSError):
                return
            except Exception as exc:  # noqa: BLE001 - a job this process cannot read
                answer: tuple = ("error", f"{type(exc).__name__}: {exc}")
            else:
                try:
                    answer = ("ok", fn(arg))
                except Exception as exc:  # noqa: BLE001 - its answer
                    answer = ("error", f"{type(exc).__name__}: {exc}")
            try:
                results.send(answer)
            except (EOFError, OSError):
                return
            except Exception as exc:  # noqa: BLE001 - the answer could not be pickled
                results.send(("error", f"its answer could not be sent back: {type(exc).__name__}: {exc}"))
    finally:
        for conn in (jobs, results, stop, over):
            if conn is not None:
                conn.close()


class _PvProcess:
    """The second search's own worker: ONE spawn process and its pipes - no Pool, no queue, no lock,
    no semaphore, no helper thread but the short one that hands a job over (CI, PR #50: a
    segmentation fault while the garbage collector ran in the API's event-loop thread; the second
    search used to be a second Pool, with three threads, three queues and two Events). One job at a
    time: its search, then its own load re-check.

    submit() hands a job over in a short thread: a job larger than a pipe's buffer would otherwise
    hold the solve until the process has started. wait() reads the answer, or sees the process die,
    the deadline or a cancel. close() kills the process and joins it, joins that thread, closes every
    pipe and the process object and detaches its stop flag from the solve's control - in the calling
    thread, before the solve returns. Afterwards this object holds nothing of multiprocessing."""

    def __init__(self, control: SolveControl | None, *, run_id: str = "") -> None:
        import multiprocessing as mp

        ctx = mp.get_context("spawn")
        self.run_id = run_id
        self.control = control
        self.proc = None
        self._jobs = self._results = None
        # The solve's "stop now" (THOROUGH: a stop or a cancel) and "the engine's searches are over".
        self.stop_flag: _PipeFlag | None = None
        self.search_over: _PipeFlag | None = None
        self._sender: threading.Thread | None = None
        self._send_failed: list[str] = []  # why the job in hand could not be handed over
        self._closed = False
        ends: list = []  # the process's ends of the pipes: closed here once it has its own copies
        try:
            jobs_r, self._jobs = ctx.Pipe(duplex=False)
            ends.append(jobs_r)
            self._results, results_w = ctx.Pipe(duplex=False)
            ends.append(results_w)
            self.stop_flag = _PipeFlag(ctx) if control is not None else None
            self.search_over = _PipeFlag(ctx)
            stop_r = self.stop_flag.reader if self.stop_flag is not None else None
            self.proc = ctx.Process(target=_pv_main, args=(jobs_r, results_w, stop_r, self.search_over.reader),
                                    name="routeiq-second-search", daemon=True)
            self.proc.start()
        except BaseException as exc:
            for conn in ends:
                conn.close()
            self._release()
            raise exc.with_traceback(None)  # noqa: B904 - the same exception, without the frames holding the pipes
        for conn in ends:
            conn.close()
        for flag in (self.stop_flag, self.search_over):
            if flag is not None:
                flag.drop_reader()
        if self.stop_flag is not None:
            control.attach(self.stop_flag)  # type: ignore[union-attr]

    @property
    def closed(self) -> bool:
        return self._closed

    def submit(self, fn, arg) -> None:
        """Hand ``fn(arg)`` to the process; its answer comes with wait()."""
        if self._closed or self._jobs is None:
            raise RuntimeError("the second search's process was closed")
        if self._sender is not None:
            self._sender.join(POOL_CLOSE_SEC)  # the previous job was answered, so it was read long ago
        failed: list[str] = []
        self._send_failed = failed
        jobs = self._jobs

        def send() -> None:
            try:
                jobs.send((fn, arg))
            except Exception as exc:  # noqa: BLE001 - the process is gone (broken pipe), or the job cannot be pickled
                failed.append(f"{type(exc).__name__}: {exc}")

        self._sender = threading.Thread(target=send, name="routeiq-second-search-send", daemon=True)
        self._sender.start()

    def wait(self, deadline: float, control: SolveControl | None) -> tuple[str, object]:
        """The answer to the job in hand: ("ok", value) | ("error", text) | ("lost", None) (the
        process died, even before this wait) | ("timeout", None) at ``deadline``. ``control``
        cancelled: SolveAborted within half a second."""
        from multiprocessing.connection import wait as ready

        if self._closed or self._results is None or self.proc is None:
            return "lost", None
        while True:
            if control is not None and control.cancelled.is_set():
                raise SolveAborted(f"The optimization was cancelled ({control.why or 'the caller is gone'}).")
            try:
                if self._results.poll():
                    kind, value = self._results.recv()
                    return str(kind), value
            except (EOFError, OSError):
                return "lost", None
            except Exception as exc:  # noqa: BLE001 - an answer this process cannot read
                return "error", f"{type(exc).__name__}: {exc}"
            if self.proc.exitcode is not None:
                return "lost", None
            if self._send_failed:
                return "error", f"the job could not be handed over: {self._send_failed[0]}"
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                return "timeout", None
            ready([self._results, self.proc.sentinel], min(0.5, remaining))

    def close(self) -> None:
        """Kill the process (a running PyVRP search does not stop at once) and join it, join the
        hand-over thread (it ends once the process is gone), then release everything. Bounded: about
        2 x POOL_CLOSE_SEC at most. Safe to call twice."""
        if self._closed:
            return
        self._closed = True
        proc = self.proc
        if proc is not None:
            try:
                if proc.exitcode is None:
                    proc.kill()
                proc.join(POOL_CLOSE_SEC)
            except Exception as exc:  # noqa: BLE001 - never costs the engine's answer
                log.warning("pyvrp run=%s its process could not be stopped: %s", self.run_id, exc)
        if self._sender is not None:
            self._sender.join(POOL_CLOSE_SEC)
            if self._sender.is_alive():
                log.warning("pyvrp run=%s the job hand-over did not end", self.run_id)
        self._release()

    def _release(self) -> None:
        """Close every pipe and the process object, detach the stop flag from the solve's control:
        nothing is left for the garbage collector."""
        if self.stop_flag is not None and self.control is not None:
            self.control.detach(self.stop_flag)
        for flag in (self.stop_flag, self.search_over):
            if flag is not None:
                flag.close()
        for conn in (self._jobs, self._results):
            if conn is not None:
                conn.close()
        if self.proc is not None:
            _close_process(self.proc)
        self.proc = self._jobs = self._results = self._sender = None
        self.stop_flag = self.search_over = None
        self._send_failed = []


@dataclass
class _PvRun:
    """The second route search of one solve. It runs in a process of its own (_PvProcess), started
    after rule 22's proof and never part of it (critique C2): a machine that cannot start it still
    solves (SKIPPED / NO_PROCESS); a search or stage of it that fails, dies or hangs only loses its own
    candidates. ``report`` becomes SearchReport.pyvrp."""

    report: dict
    run_id: str = ""
    proc: _PvProcess | None = None
    inprocess: bool = False  # SOLVER_PARALLEL=0 (tests, development): after the engine's searches
    args: tuple | None = None  # (req, solvable, tds, mx, PvSettings)
    plan: LR.Plan | None = None  # its checked plan, for the load re-check

    @property
    def active(self) -> bool:
        return self.proc is not None or self.inprocess

    def fail(self, status: str, reason: str, detail: str = "") -> None:
        """SKIPPED / FAILED / NOT_CHOSEN with ``reason``: one log line, and its process stops."""
        self.report.update(status=status, reason=reason)
        quiet = reason in ("OFF", "NOTHING_TO_PLAN")
        (log.info if quiet else log.warning)("pyvrp run=%s %s: %s%s%s", self.run_id,
                                            {"SKIPPED": "skipped", "FAILED": "failed"}.get(status, "not used"), reason,
                                            f" ({detail})" if detail else "", "" if quiet else "; the engine's plans are used")
        self.close()
        self.inprocess = False

    def close(self) -> None:
        if self.proc is not None:
            proc, self.proc = self.proc, None
            try:
                proc.close()
            except Exception as exc:  # noqa: BLE001 - never costs the engine's answer
                log.warning("pyvrp run=%s closing its process failed: %s", self.run_id, exc)


def _pv_start(req: DispatchRequest, solvable: list[DispatchStop], control: SolveControl | None,
              main_pool: bool) -> _PvRun:
    """The second search's switch, CPU gate and process (started before the road matrix, like the
    engine's, but without waiting for it: it is optional). ``main_pool``: the engine's pool started
    (worker processes); False with SOLVER_PARALLEL=0, when it runs in-process."""
    on, why = PV.enabled(req.config.search_mode)
    pv = _PvRun(report={"status": "SKIPPED", "reason": why, "version": PV.installed_version(), "seed": PV.seed(),
                        "chosen_for": []}, run_id=req.run_id)
    if not on:
        detail = f"effective CPUs {PV.effective_cpus()} < {PV.min_cpus()}" if why == "CPU_GATE" else ""
        pv.fail("SKIPPED", why or "OFF", detail)
    elif not solvable:
        pv.fail("SKIPPED", "NOTHING_TO_PLAN")
    elif main_pool:
        try:
            pv.proc = _PvProcess(control, run_id=req.run_id)
        except Exception as exc:  # noqa: BLE001 - optional: the engine alone answers
            pv.fail("SKIPPED", "NO_PROCESS", f"{type(exc).__name__}: {exc}")
    elif not _parallel():
        pv.inprocess = True
    else:
        pv.fail("SKIPPED", "NO_PROCESS", "the worker processes are unavailable")
    return pv


def _quick_stage_need(time_limit: int) -> float:
    """QUICK: what the engine's load re-check may need at most (three sources), kept free after the
    second search's answer so that its budget is never cut by the wait (critique C3)."""
    return min(REPACK_CAP_SEC, max(REPACK_MIN_SEC, time_limit / 2)) * 3 + STAGE_GRACE_SEC + 5


def _pv_submit(pv: _PvRun, req, solvable, tds, mx, time_limit: int, rec_limit: int, n_alt: int,
               tail: ThoroughTail | None, budget_end: float) -> None:
    """Start the second search (after RECOMMENDED was submitted: the engine never queues behind it,
    critique C4). QUICK: until the engine's searches end (search_over), backstop the planned search
    time + ALT_GRACE_SEC; THOROUGH (D3): until the load re-check's reserve, a stop, a cancel or - once
    the engine's searches ended - its timed stall (pyvrp_candidate.STALL_FLOOR_SEC)."""
    if not pv.active or pv.args is not None:
        return
    if not solvable:
        pv.fail("SKIPPED", "NOTHING_TO_PLAN")
        return
    now = time.monotonic()
    if pv.inprocess:
        runtime = float(rec_limit)
    elif tail is not None:
        runtime = budget_end - tail.stage_sec - PV_MARGIN_SEC - now
    else:
        planned = rec_limit + (max(2, time_limit // 2) + ALT_GRACE_SEC if n_alt else 0)
        runtime = min(planned + ALT_GRACE_SEC, budget_end - _quick_stage_need(time_limit) - now)
    settings = PV.PvSettings(mode="THOROUGH" if tail is not None else "QUICK", seed=PV.seed(), max_runtime=max(1.0, runtime),
                             min_sec=float(time_limit), stall_floor_sec=PV.stall_floor_sec(), stall_share=PV.stall_share(),
                             max_iters=PV.max_iters())
    pv.args = (req, solvable, tds, mx, settings)
    pv.report.update(status="NOT_CHOSEN", reason=None, seed=settings.seed)
    if pv.proc is not None:
        pv.proc.submit(PV.solve_in_worker, pv.args)


def _pv_collect(pv: _PvRun, *, thorough: bool, stopped: bool, stage_need: float, budget_end: float,
                control: SolveControl | None) -> None:
    """The second search's answer, collected before the engine's pool may be closed (critique C5)
    and never later than ``budget_end - stage_need``, so the engine's load re-check keeps its time.
    It is told the engine's searches are over. QUICK (or after a stop): it answers within about a
    second (SOLVER_PYVRP_STOP_GRACE_SEC at most). THOROUGH: it answers once its timed stall is reached
    (at once when it has not improved for that long) or at its reserve, never past ``limit``. A worker
    that died - even before this wait - is LOST at once; one that does not answer is TIMEOUT, and only
    its own process is stopped."""
    if pv.args is None or not pv.active:
        return
    if pv.inprocess:
        try:
            result = PV.solve_in_worker(pv.args)
        except Exception as exc:  # noqa: BLE001
            return pv.fail("FAILED", "FAILED", f"{type(exc).__name__}: {exc}")
    else:
        now = time.monotonic()
        limit = budget_end - stage_need
        proc: _PvProcess = pv.proc  # type: ignore[assignment]
        if proc.search_over is not None:
            proc.search_over.set()
        deadline = limit if thorough and not stopped else min(now + PV.stop_grace_sec(), limit)
        kind, value = proc.wait(max(deadline, now), control)
        if kind != "ok":
            reason = {"lost": "LOST", "timeout": "TIMEOUT"}.get(kind, "FAILED")
            detail = {"lost": "its worker process stopped", "timeout": "it did not answer in time"}.get(kind, str(value))
            return pv.fail("FAILED", reason, detail)
        result = value  # type: ignore[assignment]
    r: dict = result  # type: ignore[assignment]
    pv.report.update({k: r.get(k) for k in ("version", "seed", "penalty_mode", "search_sec", "iterations", "stop_reason",
                                            "last_improvement_sec", "feasible", "missing")})
    pv.report.update(routes=r.get("routes_used"), loads=r.get("loads"), best_over_time=r.get("points") or [])
    if r.get("summary"):
        log.info("pyvrp run=%s model: %s", pv.run_id, " ".join(f"{k}={v}" for k, v in r["summary"].items()))
    if r.get("status") != "OK":
        return pv.fail(str(r.get("status")), str(r.get("reason")), str(r.get("error") or ""))
    log.info("pyvrp run=%s done: stop=%s search=%ss iters=%s feasible=%s routes=%s loads=%s missing=%s last_improvement=%ss",
             pv.run_id, r.get("stop_reason"), r.get("search_sec"), r.get("iterations"), "yes" if r.get("feasible") else "no",
             r.get("routes_used"), r.get("loads"), r.get("missing"), r.get("last_improvement_sec"))
    if not r.get("feasible"):
        return pv.fail("NOT_CHOSEN", "NO_FEASIBLE_PLAN")
    plan, why = PV.plan_of(r, pv.args[2], pv.args[1])
    if plan is None:
        return pv.fail("NOT_CHOSEN", why or "INVALID_PLAN")
    pv.plan = plan


def _run_scenarios(names, req, solvable, tds, mx, time_limit, drops, budget_end: float | None = None, *,
                   control: SolveControl | None = None, state: dict | None = None,
                   workers: _Workers | None = None, pv: _PvRun | None = None) -> list[DispatchScenario]:
    """RECOMMENDED is solved first with the full time budget. Alternatives are then warm-started
    from it with half the budget. Finally the post-solve stage (_post_solve) re-assigns the
    searches' loads and picks each scenario's plan from all of them, so unless it serves more,
    MIN_DISTANCE never drives more km and MIN_TRUCKS never uses more trucks than the
    recommendation.

    THOROUGH (config.search_mode): the same steps inside one deadline, the cap (budget_end).
    RECOMMENDED searches until thorough_tail_sec before it - or less, once it stops improving
    (_watch_search) - and the alternatives and the load re-check then get THOROUGH's longer times,
    shortened to what is left. ``control``: cancel (SolveAborted) or "use the best plan found so
    far" (the alternatives are skipped, the re-check runs as QUICK's). ``state`` receives
    RECOMMENDED's search limit, search time, status and its THOROUGH watch report (SearchReport), and
    ``rechecked``: the scenarios whose plan the load re-check made (_post_solve).

    Every scenario runs in a worker process of ``workers``, the pool optimize_dispatch started (and
    proved to run a task) before the road matrix, rule 22. OR-Tools holds the GIL for the whole
    search, so a solve inside the API process froze it completely - /health, /route-geometry and
    every other request - for up to four minutes (20 and more for THOROUGH); threads would not run
    scenarios concurrently either. This function closes the pool when it ends.

    Safety net: alternatives are optional. Each worker gets a hard wall-clock deadline; a worker
    that overruns (OR-Tools occasionally ignores its own time limit inside internal restores),
    fails, dies or would run past the request's time budget is terminated / not started and the
    alternative is skipped with a warning. The RECOMMENDED plan is never lost because of an
    alternative. Every returned scenario carries its feasibility report (_build_scenario). When
    the fresh workers for the load re-check cannot start, the plans found are kept, re-timed
    exactly (_retime_fallback, milliseconds): no CP-SAT solve runs in the API process.

    ``workers`` None solves everything in-process WITHOUT any deadline or time budget: nothing to
    search, SOLVER_PARALLEL=0, or SOLVER_ALLOW_INPROCESS_FALLBACK=1 after a failed pool start - for
    local development and tests only (main.py logs a warning at startup when either is set).

    ``pv``: the second route search (PyVRP; _pv_start). It is submitted right after RECOMMENDED, in
    its own process, and collected once the alternatives are in (_pv_collect); its plan is one more
    source of the load re-check (_post_solve). ``state["pyvrp"]`` receives its report.
    """
    global _STOP_FLAG
    if budget_end is None:
        budget_end = time.monotonic() + SOLVER_BUDGET_SEC
    mode = req.config.search_mode
    thorough = mode == "THOROUGH"
    state = state if state is not None else {}
    results: dict[str, DispatchScenario] = {}
    alt_names = [n for n in names if n != "RECOMMENDED"]
    no_stage_workers = False  # rule 22: the load re-check's fresh workers could not start
    skipped: list[str] = []
    staged: set[str] = set()  # scenarios the post-solve stage replaced by an exactly timed plan
    stop_flag_before = _STOP_FLAG
    if workers is None and control is not None:
        _STOP_FLAG = control.stop_requested  # in-process searches see a stop request too
    stopped = False
    # THOROUGH: the alternatives' and the load re-check's times, the ones RECOMMENDED's limit keeps free.
    tail = thorough_tail(time_limit, len(alt_names), thorough_cap_sec(req.config)) if thorough else None
    pv = pv if pv is not None else _PvRun(report={"status": "SKIPPED", "reason": "OFF", "chosen_for": []})
    state["pyvrp"] = pv.report
    try:
        warm = None
        if "RECOMMENDED" in names:
            # A slow road matrix eats into the budget: shorten the search rather than overrun it.
            rec_limit = rec_limit_sec(mode, time_limit, budget_end - time.monotonic(), len(alt_names),
                                      thorough_cap_sec(req.config) if thorough else None)
            job = ("RECOMMENDED", req, solvable, tds, mx, rec_limit, drops)
            if workers is None:
                results["RECOMMENDED"], watch = _searched(job)
                _pv_submit(pv, req, solvable, tds, mx, time_limit, rec_limit, len(alt_names), tail, budget_end)
            else:
                deadline = min(time.monotonic() + rec_limit * 2 + REC_GRACE_SEC, budget_end)
                rec_job = workers.submit(_searched, job, "RECOMMENDED")
                _pv_submit(pv, req, solvable, tds, mx, time_limit, rec_limit, len(alt_names), tail, budget_end)
                results["RECOMMENDED"], watch = _await_worker(workers, rec_job, deadline, "recommended plan")
            state.update(limit=rec_limit, search_sec=results["RECOMMENDED"].solver_time_sec, watch=watch,
                         status=results["RECOMMENDED"].status)
            warm = results["RECOMMENDED"].loads or None
        stopped = thorough and control is not None and control.stop_requested.is_set()
        if tail is not None:
            alt_limit = tail.alt_sec if warm else time_limit
        else:
            alt_limit = max(2, time_limit // 2) if warm else time_limit
        grace = int(os.environ.get("SOLVER_ALT_GRACE_SEC", ALT_GRACE_SEC))
        if alt_names and stopped:
            # "Use the best plan found so far": the recommended plan now, no more searching.
            skipped.extend(alt_names)
            alt_names = []
            log.info("search stopped on request; alternatives skipped")
        if alt_names:
            # Never run past the request budget: shorten the alternatives, or skip them. THOROUGH
            # also keeps the load re-check's time free (it has one deadline, the cap) - the same
            # time the tail kept for it, so the alternatives get the rest of the tail.
            room = int(budget_end - time.monotonic()) - grace - (tail.stage_sec if tail is not None else 0)
            if room < 2:
                skipped.extend(alt_names)
                alt_names = []
                log.warning("time budget used up by the recommended plan; alternatives skipped")
            else:
                alt_limit = min(alt_limit, room)
        jobs = [(n, req, solvable, tds, mx, alt_limit, drops, warm) for n in alt_names]
        _pv_submit(pv, req, solvable, tds, mx, time_limit, alt_limit, len(alt_names), tail, budget_end)  # no RECOMMENDED asked for
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
                    log.warning("alternative %s %s (%s); skipped", name, _NOT_RUN.get(kind, "failed"), value)
        else:
            for j in jobs:
                try:
                    results[j[0]] = _scenario_worker(j)
                except Exception as exc:  # noqa: BLE001 - an alternative never costs the recommended plan
                    skipped.append(j[0])
                    log.warning("alternative %s failed (%s); skipped", j[0], exc)
        # The second search's answer, before the engine's pool may be closed below (critique C5).
        _pv_collect(pv, thorough=thorough, stopped=thorough and control is not None and control.stop_requested.is_set(),
                    stage_need=tail.stage_sec if tail is not None else _quick_stage_need(time_limit),
                    budget_end=budget_end, control=control)
        if workers is not None and (overran or workers.broken()):
            # A skipped alternative still runs in its worker (a stuck OR-Tools call does not stop
            # on request), or the pool broke (rule 22: no process can take a task any more): the
            # post-solve jobs would queue behind it and time out, and RECOMMENDED would lose its
            # load re-check. Give the stage fresh workers. Closing the old pool is bounded; when it
            # does not finish, the stage still starts (or the plans are re-timed, below).
            workers.close()
            workers = None
            try:
                # None: the in-process fallback is allowed (development and tests only).
                workers = _start_workers(len(_stage_goals(results)), control, req.run_id, "load re-check")
            except WorkersUnavailable:
                # Rule 22: never a CP-SAT solve in the API process. Failing the request would throw
                # the finished recommended plan away: it is kept, re-timed exactly (below).
                no_stage_workers = True
                log.warning("run=%s load re-check skipped (no worker processes); the plans found are kept and "
                            "re-timed exactly", req.run_id)
        # THOROUGH: longer CP-SAT solves in the load re-check (QUICK's after a stop request).
        stopped = stopped or (thorough and control is not None and control.stop_requested.is_set())
        stage_kw = {"repack_cap": _repack_cap_sec(time_limit, False) if stopped else tail.repack_cap} if tail is not None else {}
        try:
            if no_stage_workers:
                # The dispatcher's note in plain words; the technical cause is in the ERROR line.
                _retime_fallback(req, solvable, tds, mx, drops, results, NO_WORKERS_NOTE, skip=staged)
            else:
                if pv.plan:  # the second search's plan, when there is one to judge
                    stage_kw["pv"] = pv
                _post_solve(req, solvable, tds, mx, time_limit, drops, results, workers, budget_end, staged, **stage_kw,
                            rechecked=state.setdefault("rechecked", set()))
        except SolveAborted:
            raise  # cancelled: the caller is gone, nothing to fall back to
        except Exception as exc:  # noqa: BLE001 - the search's own plans stay valid
            log.exception("post-solve stage failed: %s", exc)
            # Only the scenarios the stage had not replaced yet: one it already re-timed exactly
            # keeps its plan and gets no false "not re-checked" note (the note used to be inferred
            # from warning texts, review: exact-timing status never exposed per scenario).
            _retime_fallback(req, solvable, tds, mx, drops, results, "internal error", skip=staged)
    finally:
        _STOP_FLAG = stop_flag_before
        if workers is not None:
            workers.close()
        pv.close()
    if pv.plan and pv.report.get("status") == "NOT_CHOSEN" and pv.report.get("reason") is None:
        pv.report.update(reason="NO_STAGE")  # the load re-check did not run (rule 22, out of time)
    if state.get("status") == "NO_SOLUTION" and results.get("RECOMMENDED") and results["RECOMMENDED"].status == "OPTIMIZED":
        # Rescued by the second search: the search report must not say "found no plan" (critique C8).
        state["status"] = "OPTIMIZED"
    rec = results.get("RECOMMENDED")
    if skipped and rec:
        rec.warnings.append(
            f"Alternative plan(s) {', '.join(skipped)} were skipped: the search was stopped early to use the best plan found so far; the recommended plan is complete."
            if stopped else
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
# (priority value of the unserved stops), then the goal's own measures (load_repack.GOALS: the
# worker-side recovery chooses its insertions on the same comparison).
_GOALS = LR.GOALS


def _plan_hire(ctx: "_StageCtx", sc: DispatchScenario) -> int:
    """The hire tier of the rented trucks a scenario's loads use (0 without trucks to rent)."""
    out = 0
    for tid in {ld.truck_id for ld in sc.loads}:
        price = ctx.rec_pricing.trucks.get(ctx.truck_idx.get(tid, -1))
        out += price.hire if price is not None else 0
    return out


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
        b = ld.driver_break
        out.setdefault(truck_idx[ld.truck_id], []).append(LR.TimedLoad(
            stops=tuple(stop_idx[st.stop_id] for st in ld.stops), depart_s=ld.depart_min * 60,
            starts=tuple(st.service_start_min * 60 for st in ld.stops), return_s=ld.return_min * 60,
            brk=LR.BreakAt(b.start_min * 60, b.where, b.after_sequence) if b is not None else None))
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
    values, value_warnings = _service_values(solvable, cfg, use_margin, req.trucks, req.depot)
    day = LR.Day(stops=solvable, trucks=[td for td in tds if td.usable], D=mx.distance_m, T=mx.duration_s,
                 shift_max_s=cfg.shift_max_min * 60, reload_s=cfg.reload_min * 60,
                 loading_s_per_case=cfg.loading_min_per_case * 60, values=values,
                 frozen_trucks=frozenset(td.idx for td in tds if td.n_frozen), window_rule=cfg.window_rule)
    return _StageCtx(req=req, solvable=solvable, tds=tds, mx=mx, drops=drops, values=values, value_warnings=value_warnings,
                     use_margin=use_margin, stop_idx={s.stop_id: k for k, s in enumerate(solvable)},
                     truck_idx={td.truck.id: td.idx for td in tds}, day=day,
                     rec_pricing=_pricing("RECOMMENDED", req, tds, solvable))


def _shorter_orders(ctx: _StageCtx, cand: LR.Candidate, deadline: float) -> LR.Candidate:
    """The chosen candidate with the day of each rented or day-paid truck routed again where its km and
    hours, weighed as an own truck's (_order_km_rate, the hourly driver rate), outweigh what its
    customers' time preferences lose (LR.shorter_orders; fifth and sixth reviews of the hire branch):
    which of its stops go on which of its loads, then the order inside each load. Each truck keeps its
    stops (never more loads), no more money, fewer km, every hard rule timed exactly. The same candidate
    when nothing changes - always on a day without such trucks (planned exactly as before)."""
    idxs = [td.idx for td in ctx.day.trucks if _hired_km(td.truck) and cand.plan.get(td.idx)]
    if not idxs or time.monotonic() > deadline:
        return cand
    km_per_m = _order_km_rate(ctx.req) * SCENARIOS["RECOMMENDED"].distance * COST_SCALE / 1000.0
    try:
        plan = LR.shorter_orders(ctx.day, ctx.rec_pricing, cand.plan, idxs, km_per_m, deadline)
    except Exception as exc:  # noqa: BLE001 - the chosen plan stays as it is
        log.warning("ordering the loads of rented or day-paid trucks failed: %s", exc)
        return cand
    if plan is cand.plan:
        return cand
    return LR.Candidate(cand.source, plan, LR.score(ctx.day, ctx.rec_pricing, plan))


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


# Benchmark F01 (8 Oct 2026): the safety net's trim (load_repack.trim) runs in the API process, so it
# is bounded: about one timing per stop it leaves out, never longer than this.
TRIM_FALLBACK_SEC = 1.5
PARTIAL_PLAN_NOTE = ("The complete plan could not be timed with every rule, so this option is the part of it that "
                     "can: ")


def _trimmed(ctx: _StageCtx, name: str, sc: DispatchScenario, why: str) -> DispatchScenario | None:
    """Benchmark F01: the raw plan ``sc`` cannot be timed exactly. The part of it that can (load_repack.
    trim: each truck that breaks a rule loses its least valuable stops until it keeps every rule), as
    a checked partial plan whose left-out stops say why (TIMING_DROP_HEAD). None when nothing of it
    can be timed (the raw plan then stays, flagged VIOLATED: never dispatched)."""
    try:
        plan = LR.plan_of(_timed_from_scenario(sc, ctx.stop_idx, ctx.truck_idx))
        timed = LR.trim(ctx.day, ctx.rec_pricing, plan, time.perf_counter() + TRIM_FALLBACK_SEC)
    except Exception as exc:  # noqa: BLE001 - the raw plan stays, flagged by its feasibility report
        log.warning("trimming %s failed: %s", name, exc)
        return None
    if not LR.served_of(timed):
        return None
    own = LR.served_of(plan)
    drops = own - LR.served_of(timed)
    new = _build_scenario(
        name, ctx.req, ctx.solvable, ctx.tds, ctx.mx, timed, ctx.values, ctx.use_margin, ctx.drops,
        solver_status=sc.solver_status, elapsed=sc.solver_time_sec, time_limit=sc.time_limit_sec,
        objective_value=LR.score(ctx.day, ctx.rec_pricing, timed).objective, extra_warnings=ctx.value_warnings,
        timing_drops=drops, exact_timing=True,
    )
    if drops:
        new.warnings.append(PARTIAL_PLAN_NOTE + why + " " + _timing_drop_warning(ctx.req.config, len(drops), 0))
    return new


def _retime_fallback(req: DispatchRequest, solvable: list[DispatchStop], tds: list[TruckDay], mx: MatrixResult,
                     drops: list[UnservedStop], results: dict[str, DispatchScenario], why: str,
                     skip: set[str] | None = None, ctx: _StageCtx | None = None) -> None:
    """The post-solve stage did not check these plans: say so, and re-time each one exactly
    (_retime). A plan that cannot be re-timed is trimmed to the part that can (_trimmed, benchmark F01:
    a checked partial plan whose left-out stops say why); only when nothing of it can be timed does it
    stay as the route search found it, its feasibility report saying what it breaks (VIOLATED), so the
    web never lets it be locked or dispatched."""
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
        # The search's times are estimates with a loading time per case, and never hold a driver
        # break: re-time them exactly then (review: with 0 min per case and the break rule too).
        brk = break_rule(cfg) is not None
        if (cfg.loading_min_per_case > 0 or brk) and ctx is not None and (
                sc.feasibility is None or sc.feasibility.timing != "EXACT"):
            new = _retime(ctx, name, sc)
            what = "the loading time between loads" + (" and the drivers' midday break" if brk else "")
            if new is not None:
                new.warnings.append(msg + f" Departure times were re-timed exactly with {what}.")
                results[name] = new
                continue
            part = _trimmed(ctx, name, sc, f"its times did not hold {what}.")
            if part is not None:
                part.warnings.append(msg)
                results[name] = part
                continue
            sc.warnings.append(msg + f" Its times do not hold {what} and could not be re-timed exactly: "
                                     + ("the driver breaks could not be timed: re-plan." if brk else
                                        "check the timetable before dispatching, or re-plan."))
            continue
        sc.warnings.append(msg)


def _post_solve(req: DispatchRequest, solvable: list[DispatchStop], tds: list[TruckDay], mx: MatrixResult,
                time_limit: int, drops: list[UnservedStop], results: dict[str, DispatchScenario], pool,
                budget_end: float, done: set[str] | None = None, repack_cap: float | None = None,
                pv: "_PvRun | None" = None, rechecked: set[str] | None = None) -> None:
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
    Every scenario it replaces is added to ``done``; ``rechecked`` receives those it replaced with a
    plan of its own re-check (never the safety net's: the hire reduction keeps no plan the re-check
    skipped, seventh review of the hire branch). ``repack_cap``: seconds per CP-SAT solve
    (THOROUGH, _repack_cap_sec); None = QUICK's min(REPACK_CAP_SEC, max(REPACK_MIN_SEC, limit / 2)).

    ``pv``: the second search (PyVRP) with its checked plan, or None. Its plan is one more source,
    kept apart from the engine's (critique of the PyVRP spec): the engine's sources, their repair
    weights, budget and jobs are exactly as without it, and its own stage job (pyvrp_candidate.
    stage_in_worker) runs in its own process, never longer than the engine's. Its candidates join the
    pick after the engine's; a tie keeps the engine's plan, and so does a gain the dispatcher's note
    could not show (_goal_measure: under 1 OMR or 1 km, no fewer trucks or loads, no more service).
    An option rescued from no plan gets the status SECOND_SEARCH. So each option is never worse on its
    own goal than the engine alone would have chosen from the same search. A plan from it that fails
    the independent check is replaced by the engine's (a WARNING line). An option whose own search
    found no plan (NO_SOLUTION) takes the second search's best plan for its goal."""
    done = done if done is not None else set()
    raw = {n: sc for n, sc in results.items() if sc.status == "OPTIMIZED"}
    pv_plan = pv.plan if pv is not None else None
    rescue = [n for n, sc in results.items() if sc.status == "NO_SOLUTION"] if pv_plan else []
    if (not raw and not rescue) or not solvable:
        return
    cfg = req.config
    t0 = time.monotonic()
    ctx = _stage_ctx(req, solvable, tds, mx, drops)
    values, value_warnings, use_margin = ctx.values, ctx.value_warnings, ctx.use_margin
    n_stops = len(solvable)
    sources = [LR.Source(n, _timed_from_scenario(sc, ctx.stop_idx, ctx.truck_idx)) for n, sc in raw.items()]
    carried = {src.name: {k for loads in src.plan.values() for tl in loads for k in tl.stops} for src in sources}
    left_out = set(range(n_stops)) - set.intersection(*carried.values()) if carried else set()
    optional = _repair_weights(solvable, left_out, cfg, req.trucks, req.depot) if left_out else None
    rec_pricing = ctx.rec_pricing
    goals = _stage_goals(raw) if raw else []
    cap = repack_cap if repack_cap is not None else min(REPACK_CAP_SEC, max(REPACK_MIN_SEC, time_limit / 2))
    job_budget = min(cap * len(sources), budget_end - t0 - STAGE_GRACE_SEC - 5)
    fit_weights = _repair_weights(solvable, set(range(n_stops)), cfg, req.trucks, req.depot)
    # Benchmark F07 (8 Oct 2026): a repair that still leaves out P1-P3 stops, or whose fit repack proved
    # no bound, may use the rest of the request's time (up to the cap minus the grace), shared by the
    # rounds of jobs. A job uses it only then (build_candidates): a day whose plans time cleanly, or
    # whose repair keeps every P1-P3 stop with a proven fit, ends as before.
    rounds_of = (lambda n: -(-n // max(1, pool.size))) if pool is not None else (lambda n: max(1, n))
    stage_room = max(0.0, budget_end - t0 - STAGE_GRACE_SEC - 5)

    def fallback(why: str) -> None:
        if pv_plan:
            pv.report.update(status="NOT_CHOSEN", reason="NO_STAGE")  # type: ignore[union-attr]
        before = dict(results)
        _retime_fallback(req, solvable, tds, mx, drops, results, why, ctx=ctx)
        done.update(n for n in raw if results[n] is not before[n])

    if sources and job_budget < REPACK_MIN_SEC:
        log.warning("post-solve stage skipped: request time budget used up")
        return fallback("out of time")
    # The second search's own job: RECOMMENDED's prices, and MIN_TRUCKS' when that option has a plan
    # or is rescued; never more time than the engine's job (they run side by side).
    pv_job = None
    if pv_plan:
        pv_goals = ["RECOMMENDED"] + (["MIN_TRUCKS"] if "MIN_TRUCKS" in goals or "MIN_TRUCKS" in rescue else [])
        pv_budget = min(cap * len(pv_goals), job_budget if sources else budget_end - t0 - STAGE_GRACE_SEC - 5)
        if pv_budget >= REPACK_MIN_SEC:
            pv_carried = {k for loads in pv_plan.values() for load in loads for k in load}
            pv_job = dict(day=ctx.day, score_pricing=rec_pricing, plan=pv_plan,
                          gaps={td.idx: _approx_gap_s(cfg, td) for td in ctx.day.trucks},
                          goals=[(g, rec_pricing if g == "RECOMMENDED" else _pricing(g, req, tds, solvable)) for g in pv_goals],
                          optional=_repair_weights(solvable, set(range(n_stops)) - pv_carried, cfg, req.trucks, req.depot) or None,
                          cap_s=cap, budget_s=pv_budget, fit_weights=fit_weights,
                          # Its own process, beside the engine's jobs: the same extension, never longer.
                          extra_s=max(0.0, stage_room - pv_budget) / max(1, len(pv_goals)))
        else:
            pv.report.update(status="NOT_CHOSEN", reason="OUT_OF_TIME")  # type: ignore[union-attr]
    extra = max(0.0, stage_room / rounds_of(len(goals)) - job_budget) if goals else 0.0
    jobs = {g: dict(day=ctx.day, score_pricing=rec_pricing, goal=g,
                    goal_pricing=rec_pricing if g == "RECOMMENDED" else _pricing(g, req, tds, solvable),
                    sources=sources, optional=optional, cap_s=cap, budget_s=job_budget, time_raw=g == "RECOMMENDED",
                    fit_weights=fit_weights, extra_s=extra,
                    # The constructive fallback (one per request): RECOMMENDED's job builds it.
                    fallback=g == "RECOMMENDED")
            for g in goals}
    outputs: dict[str, tuple[list[LR.Candidate], list[str]]] = {}
    pv_proc: _PvProcess | None = pv.proc if pv_job is not None and pv is not None else None
    if pv_proc is not None:
        # Its own process (idle since its search ended): starts now, beside the engine's jobs.
        pv_proc.submit(PV.stage_in_worker, pv_job)
    pv_deadline = min(time.monotonic() + (pv_job["budget_s"] + len(pv_job["goals"]) * pv_job["extra_s"] if pv_job else 0)
                      + STAGE_GRACE_SEC, budget_end - 2)
    if pool is None:
        for g, job in jobs.items():
            try:
                outputs[g] = _stage_worker(job)
            except Exception as exc:  # noqa: BLE001 - the raw plans stay valid
                log.warning("post-solve %s failed: %s", g, exc)
    else:
        rounds = rounds_of(len(jobs))
        deadline = min(time.monotonic() + rounds * (job_budget + extra) + STAGE_GRACE_SEC, budget_end - 2)
        # In completion order: a MIN_TRUCKS job whose worker dies (out of memory) no longer costs
        # RECOMMENDED its exact re-check, nor the rest of the budget (review L23).
        got = _await_all(pool, {g: pool.submit(_stage_worker, job, f"stage:{g}") for g, job in jobs.items()}, deadline) if jobs else {}
        for g in goals:
            kind, value = got[g]
            if kind == "ok":
                outputs[g] = value  # type: ignore[assignment]
            else:
                log.warning("post-solve %s %s%s", g, {"lost": "lost its worker process", "timeout": "timed out",
                                                      "broken": _NOT_RUN["broken"]}.get(kind, "failed"),
                            f": {value}" if value is not None else "")
    pv_out: tuple[list[LR.Candidate], list[str]] | None = None
    if pv_proc is not None:
        kind, value = pv_proc.wait(max(pv_deadline, time.monotonic()), pv_proc.control)
        if kind == "ok":
            pv_out = value  # type: ignore[assignment]
        else:
            log.warning("pyvrp run=%s stage %s%s; the engine's plans are used", req.run_id,
                        {"lost": "lost its worker process", "timeout": "timed out"}.get(kind, "failed"),
                        f": {value}" if value is not None else "")
            pv.report.update(status="NOT_CHOSEN", reason="STAGE_FAILED")  # type: ignore[union-attr]
            pv.close()  # type: ignore[union-attr]
    elif pv_job is not None:
        try:  # SOLVER_PARALLEL=0: in-process, after the engine's jobs
            pv_out = PV.stage_in_worker(pv_job)
        except Exception as exc:  # noqa: BLE001 - only the second search's candidates are lost
            log.warning("pyvrp run=%s stage failed: %s; the engine's plans are used", req.run_id, exc)
            pv.report.update(status="NOT_CHOSEN", reason="STAGE_FAILED")  # type: ignore[union-attr]
    stage_sec = time.monotonic() - t0
    if sources and "RECOMMENDED" not in outputs:  # the raw plans were not re-timed either
        return fallback("the check failed or ran out of time")
    eng = [c for g in goals if g in outputs for c in outputs[g][0]]
    pvc = list(pv_out[0]) if pv_out else []
    cands = eng + pvc  # the engine's first: a tie keeps the engine's plan
    log.info("post-solve run=%s %.1fs: %s", req.run_id, stage_sec,
             "; ".join([n for g in goals if g in outputs for n in outputs[g][1]] + (list(pv_out[1]) if pv_out else [])))
    if pv_plan and not pvc and pv.report.get("reason") is None:  # type: ignore[union-attr]
        pv.report.update(status="NOT_CHOSEN", reason="NO_FEASIBLE_PLAN")  # type: ignore[union-attr]

    def pick(name: str, pool_c: list[LR.Candidate], own: int) -> tuple[LR.Candidate | None, bool]:
        """The option's best candidate for its goal among ``pool_c``: service first; a tie keeps the
        option's own source, then any engine source before the second search's (critique C7)."""
        fits = [c for c in pool_c if c.score.service <= own]
        lost = not fits and bool(pool_c)
        if lost:
            # This search's plan breaks the exact loading time between loads (its own timing is
            # an estimate) and nothing serving as much fits the day: take the fitting plan that
            # keeps the most priority value, never departure times no truck can make.
            fits = pool_c
        if not fits:
            return None, False
        goal = _GOALS[name]
        return min(fits, key=lambda c: (goal(c.score), c.source.split("+")[0] != name, c.source.startswith("PYVRP"))), lost

    def served(c: LR.Candidate) -> set[int]:
        return {k for loads in c.plan.values() for tl in loads for k in tl.stops}

    # The chosen plans' rented or day-paid trucks get their day routed again (_shorter_orders, fifth and
    # sixth reviews): after the pick, so it never changes which truck carries what; each candidate once,
    # each with up to HIRE_ORDER_SEC, all of them together with up to three times that (the second
    # search's plan and the engine's own are compared after it, so neither may starve the other).
    orders_end = min(time.monotonic() + 3 * HIRE_ORDER_SEC, budget_end - 2)
    in_order: dict[int, LR.Candidate] = {}

    def ordered(c: LR.Candidate | None) -> LR.Candidate | None:
        if c is None:
            return None
        if id(c) not in in_order:
            in_order[id(c)] = _shorter_orders(ctx, c, min(time.monotonic() + HIRE_ORDER_SEC, orders_end))
        return in_order[id(c)]

    for name in list(raw) + rescue:
        sc = results[name]
        own_carried = carried.get(name, set())
        # Its own service: the stops it leaves out and the rented trucks it uses (the hire tier).
        own = sum(v for k, v in enumerate(values) if k not in own_carried) + _plan_hire(ctx, sc)
        # An option without a plan of its own is rescued only by the second search's plans (its
        # other options' plans are not offered to it, as without the second search).
        best, lost = pick(name, cands if name in raw else pvc, own)
        ref, ref_lost = pick(name, eng, own) if name in raw else (None, False)
        best, ref = ordered(best), ordered(ref)
        if (best is not None and ref is not None and best.source.startswith("PYVRP")
                and _goal_gain(name, ref.score, best.score, len(served(best)) - len(served(ref))) is None):
            # Better only by less than the note can show (under 1 OMR or 1 km, same trucks and loads):
            # the engine's own plan is kept (review: "529 -> 529 OMR" was called a better plan).
            best, lost = ref, ref_lost
        new = None
        while best is not None:
            timing_drops = own_carried - served(best) if lost else set()
            from_pv = best.source.startswith("PYVRP")
            try:
                new = _build_scenario(
                    name, req, solvable, tds, mx, best.plan, values, use_margin, drops,
                    # A rescued option has its own status: never the failed search's "no plan found".
                    solver_status="SECOND_SEARCH" if name in rescue else sc.solver_status,
                    elapsed=sc.solver_time_sec + stage_sec, time_limit=sc.time_limit_sec,
                    objective_value=best.score.objective, extra_warnings=value_warnings, timing_drops=timing_drops,
                    exact_timing=True,
                )
            except Exception:
                if not from_pv:
                    raise
                log.exception("pyvrp run=%s %s: its plan could not be built", req.run_id, name)
                new = None
            if not from_pv or (new is not None and new.feasibility is not None and new.feasibility.status == "VERIFIED"):
                break
            # Belt and braces: never an unchecked plan from the second search.
            log.warning("pyvrp run=%s %s: candidate failed the independent check (%d violations); the engine's plan is used",
                        req.run_id, name, len(new.feasibility.violations) if new is not None and new.feasibility else 0)
            pv.report.update(reason="NOT_VERIFIED")  # type: ignore[union-attr]
            best, lost, new = ref, ref_lost, None
            ref = None
        if best is None or new is None:
            part = _trimmed(ctx, name, sc, "no re-assignment of its loads could be timed in the time available.") \
                if name in raw else None
            if part is not None:
                # Benchmark F01: a checked partial plan, never only one that breaks the rules.
                results[name] = part
                done.add(name)
                continue
            if name in raw:
                # No plan of this day could be timed exactly (not even this one): kept as found. Its
                # feasibility report (built with the raw plan) lists what it breaks.
                sc.warnings.append(
                    "The driver breaks could not be timed for this plan: re-plan, or add a truck."
                    if break_rule(cfg) is not None else
                    f"This plan does not leave the loading time of {cfg.loading_min_per_case:g} min per case between loads "
                    "everywhere; some later loads may be timed too early. Re-plan, add a truck, or check the loading time."
                    if cfg.loading_min_per_case > 0 else
                    "The final timing check failed for this plan; check load times before dispatching."
                )
            continue
        served_now = served(best)
        added = served_now - own_carried
        timing_drops = own_carried - served_now if lost else set()
        changed = (new.trucks_used, new.trips) != (sc.trucks_used, sc.trips) or abs(new.operating_cost - sc.operating_cost) >= 0.5
        if timing_drops:
            new.warnings.append(_timing_drop_warning(cfg, len(timing_drops), len(added)))
        if best.source.startswith("PYVRP"):
            new.warnings.append(_second_search_note(name, name in rescue, ref, best, served(ref) if ref else set(), served_now))
            pv.report["chosen_for"] = [*pv.report.get("chosen_for", []), name]  # type: ignore[union-attr]
        elif timing_drops:
            pass
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
        if rechecked is not None:
            rechecked.add(name)
    if pv_plan:
        if pv.report.get("chosen_for"):  # type: ignore[union-attr]
            pv.report.update(status="CHOSEN", reason=None)  # type: ignore[union-attr]
        elif pv.report.get("reason") is None:  # type: ignore[union-attr]
            pv.report.update(status="NOT_CHOSEN", reason="NOT_BETTER")  # type: ignore[union-attr]


MIN_SHOWN_GAIN_OMR = 1.0  # the second search's plan must be better by at least this much on the option's goal ...
MIN_SHOWN_GAIN_KM = 1.0  # ... (or plan more, or use fewer trucks / loads) to be used: a gain the note can show


def _shown(a: float, b: float, fmt: str, min_gain: float) -> bool:
    """``b`` is lower than ``a`` by at least ``min_gain``, and still lower once both are printed."""
    return a - b >= min_gain and format(b, fmt) != format(a, fmt)


def _goal_measure(name: str, r: LR.Score, b: LR.Score, more: int) -> tuple[str, str] | None:
    """(plain words, the figure it names) for how ``b`` (the second search's plan) beats ``r`` (the
    engine's final plan) on the option's own goal (_GOALS) - service first, then km for MIN_DISTANCE,
    trucks, loads and operating cost for MIN_TRUCKS, the total cost with the customer time preferences
    for RECOMMENDED - or None when the gain is not one the dispatcher can see."""
    if b.service != r.service:
        if b.service > r.service:
            return None
        if b.unserved == r.unserved:  # the same stops with cheaper trucks to rent (the hire suggestion)
            return ("cheaper trucks to hire", "")
        return (f"{more} more stop(s) planned", "") if more > 0 else ("more of the higher-priority stops planned", "")
    if name == "MIN_DISTANCE":
        km_r, km_b = r.metres / 1000, b.metres / 1000
        return (f"fewer km, {km_r:,.1f} -> {km_b:,.1f} km", "km") if _shown(km_r, km_b, ",.1f", MIN_SHOWN_GAIN_KM) else None
    if name == "MIN_TRUCKS":
        if b.trucks != r.trucks:
            return (f"fewer trucks, {r.trucks} -> {b.trucks}", "trucks") if b.trucks < r.trucks else None
        if b.loads != r.loads:
            return (f"fewer loads, {r.loads} -> {b.loads}", "loads") if b.loads < r.loads else None
        o_r, o_b = r.operating / COST_SCALE, b.operating / COST_SCALE
        return ((f"a lower operating cost, {o_r:,.0f} -> {o_b:,.0f} OMR", "operating")
                if _shown(o_r, o_b, ",.0f", MIN_SHOWN_GAIN_OMR) else None)
    c_r, c_b = r.cost / COST_SCALE, b.cost / COST_SCALE
    return ((f"a lower total cost including the customer time preferences, {c_r:,.0f} -> {c_b:,.0f} OMR", "")
            if _shown(c_r, c_b, ",.0f", MIN_SHOWN_GAIN_OMR) else None)


def _goal_gain(name: str, r: LR.Score, b: LR.Score, more: int) -> str | None:
    """The second search's gain on the option's goal in plain words; None: not a better plan."""
    m = _goal_measure(name, r, b, more)
    return m[0] if m else None


def _second_search_note(name: str, rescued: bool, ref: LR.Candidate | None, best: LR.Candidate, ref_served: set[int],
                        served_now: set[int]) -> str:
    """The one dispatcher's note on an option whose plan came from the second search (decision D4), in
    plain words. Compared with the engine's own final plan for that option - its best candidate
    after the load re-check - never with the raw search plan (critique C8: the re-check alone often
    saves trucks). "Better" names the option's own goal only; trucks, loads, km and operating cost
    follow neutrally, when they changed."""
    checked = "It passed the planner's own checks, timing and costs."
    if rescued:
        return f"The main route search found no plan for this option; this plan comes from a second route search. {checked}"
    if ref is None:
        return f"This plan comes from a second route search: the main search's plan could not be timed exactly. {checked}"
    m = _goal_measure(name, ref.score, best.score, len(served_now) - len(ref_served))
    if m is None:  # not reached: such a plan is not chosen (_post_solve)
        return f"This plan comes from a second route search. {checked}"
    r, b = ref.score, best.score
    figures = [("trucks", f"trucks {r.trucks} -> {b.trucks}", r.trucks != b.trucks),
               ("loads", f"loads {r.loads} -> {b.loads}", r.loads != b.loads),
               ("km", f"km {r.metres / 1000:,.1f} -> {b.metres / 1000:,.1f}", f"{r.metres / 1000:,.1f}" != f"{b.metres / 1000:,.1f}"),
               ("operating", f"operating cost {r.operating / COST_SCALE:,.0f} -> {b.operating / COST_SCALE:,.0f} OMR",
                f"{r.operating / COST_SCALE:,.0f}" != f"{b.operating / COST_SCALE:,.0f}")]
    also = [text for key, text, changed in figures if changed and key != m[1]]
    return (f"A second route search found a better plan for this option than the main search: {m[0]}."
            + (f" Also changed: {', '.join(also)}." if also else "") + f" {checked}")


def _submatrix(stops: list[DispatchStop], keep: list[int], mx: MatrixResult) -> tuple[list[DispatchStop], MatrixResult]:
    """The matrix of the kept stops, with which of its legs are estimates (review F18). Its quality
    is derived again from the kept legs: when the only estimated legs belonged to a stop the window
    prefilter dropped, every planned leg is a road leg and the response says ROAD, not MIXED."""
    nodes = [0] + [k + 1 for k in keep]
    pos = {old: new for new, old in enumerate(nodes)}
    dist = [[mx.distance_m[i][j] for j in nodes] for i in nodes]
    dur = [[mx.duration_s[i][j] for j in nodes] for i in nodes]
    est = {(pos[i], pos[j]) for i, j in mx.estimated if i in pos and j in pos}
    quality = matrix_quality(len(nodes), len(est), mx.all_estimated)
    return [stops[k] for k in keep], MatrixResult(dist, dur, mx.provider_name, quality == "ESTIMATED", list(mx.warnings), len(est),
                                                  estimated=est, all_estimated=mx.all_estimated, quality=quality,
                                                  seconds=mx.seconds)
