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
  F08), hard customer
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
import threading
import time
from collections import Counter
from collections.abc import Callable
from dataclasses import dataclass

from ortools.constraint_solver import pywrapcp, routing_enums_pb2

import costing
import feasibility as FZ
import load_repack as LR
import pyvrp_candidate as PV
from dispatch_models import (
    DAY_MIN,
    MAX_STOPS,
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
    payload_units,
)
from providers import MatrixResult, matrix_quality, resolve_matrix

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
        """A worker pool's multiprocessing Event: set now if a stop was already asked for."""
        with self._lock:
            self._flags.append(flag)
        if self.stop_requested.is_set() or self.cancelled.is_set():
            self._raise_flags()

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

    def __post_init__(self) -> None:
        if self.max_kg_units < 0:
            self.max_kg_units = payload_units(self.max_kg)

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
                loading_from_s=cfg.loading_from_min * 60 if cfg.loading_from_min is not None else None,
                **brk,
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
    is unknown there, so loading is costed for 80% of a full truck. The final timing uses the
    exact ``reload_min + loading_min_per_case x cases`` of each load (load_repack)."""
    return int(round((cfg.reload_min + cfg.loading_min_per_case * td.max_cases * 0.8) * 60))


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


def _fits_capacity(stop: DispatchStop, td: TruckDay) -> bool:
    if stop.demand_cases > td.max_cases:
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


def _shortage_reason(priority: int, demand_cases: int, cap_cases: int, demand_kg: float, cap_kg: float,
                     short_cases: bool, short_kg: bool) -> str:
    """The unserved reason on a fleet-shortage day, in cases and / or kg - whichever the trucks are
    short of (scenario test S03: a weight-bound day was explained in cases only)."""
    tail = f" Lower priorities are left out first (this is P{priority})."
    if short_kg and not short_cases:
        return (f"Fleet capacity shortage by weight: {kg_text(demand_kg)} kg requested vs {kg_text(cap_kg)} kg across all "
                f"available loads (the {demand_cases} cases would fit by count; the weight does not)." + tail)
    if short_kg and short_cases:
        tighter = "weight" if demand_kg * cap_cases > demand_cases * cap_kg else "the case count"
        return (f"Fleet capacity shortage: {demand_cases} cases / {kg_text(demand_kg)} kg requested vs {cap_cases} cases / "
                f"{kg_text(cap_kg)} kg across all available loads; {tighter} is the tighter limit today." + tail)
    return f"Fleet capacity shortage: {demand_cases} cases requested vs {cap_cases} cases across all available loads." + tail


def _rooms(usable_tds: list[TruckDay], loads: list[PlannedLoad],
           takes_room: Callable[[PlannedStop], bool] | None = None) -> list[tuple[int, float]]:
    """The room left on each load of the plan and on each load slot a truck did not use (a full
    truck's room): (cases, kg in 0.1 kg units; inf when the truck has no payload). takes_room: which
    planned stops count as taking room (all by default; _no_room_reason counts only the stops of the
    same or a higher priority, since strict priorities drop lower ones first)."""
    by_truck: dict[str, list[PlannedLoad]] = {}
    for ld in loads:
        by_truck.setdefault(ld.truck_id, []).append(ld)
    rooms: list[tuple[int, float]] = []
    for td in usable_tds:
        mine = by_truck.get(td.truck.id, [])
        kg_cap = td.max_kg_units if td.max_kg_units > 0 else math.inf
        for ld in mine:
            taken = ld.stops if takes_room is None else [st for st in ld.stops if takes_room(st)]
            rooms.append((td.max_cases - sum(st.cases for st in taken), kg_cap - sum(kg_units(st.kg) for st in taken)))
        rooms += [(td.max_cases, kg_cap)] * max(0, td.trips_left - len(mine))
    return rooms


def _fits_room_left(left: list[DispatchStop], usable_tds: list[TruckDay], loads: list[PlannedLoad]) -> bool:
    """Whether any of the unserved stops fits, by cases AND by kg, the room left on a load of the
    plan or on a load slot a truck did not use (a full truck's room). False: every unserved stop
    is bigger than the room left anywhere, so a fleet shortage explains all of it, however many
    loads the room is spread over. In 0.1 kg units, with no margin (audit F08)."""
    rooms = _rooms(usable_tds, loads)
    return any(s.demand_cases <= rc and kg_units(s.demand_kg) <= rk for s in left for rc, rk in rooms)


def _no_packing_fits(s: DispatchStop, usable_tds: list[TruckDay], kept: list[PlannedStop]) -> bool:
    """Whether a sound check proves that no packing of the usable trips carries the stop together
    with `kept` (the stops of its priority or higher the plan serves). The room left on each load
    says only that THIS packing has none (A6 second review: 1,000 + 1,500 + 1,500 + 1,000 + 1,000 kg
    on 2 trucks x 1 load of 3,000 kg fit as {1,500, 1,500} and {1,000 x 3}, but the route search
    packed {1,000, 1,500} twice). Two checks, in cases and in kg (0.1 kg units, no margin):
    - they are more than all usable trips carry together;
    - more of them are over half the biggest truck than there are usable trips (no two such stops
      share a load, whatever the packing: 3 x 1,600 kg on 2 x 3,000 kg).
    Times and hours are not checked: a check that passes proves the stop cannot go, one that fails
    proves nothing."""
    if not usable_tds:
        return True
    trips = sum(td.trips_left for td in usable_tds)

    def proven(sizes: list[float], caps: list[tuple[float, int]]) -> bool:
        biggest = max(c for c, _ in caps)
        return sum(sizes) > sum(c * n for c, n in caps) or sum(2 * x > biggest for x in sizes) > trips

    if proven([st.cases for st in kept] + [s.demand_cases], [(td.max_cases, td.trips_left) for td in usable_tds]):
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
    if any(s.demand_cases <= rc and u <= rk for rc, rk in rooms):
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
    by_cases = [rk for rc, rk in rooms if s.demand_cases <= rc]
    if by_cases:  # its cases fit somewhere, its weight does not
        return (f"Not planned: no load or free trip has room for its {kg_text(u / 10)} kg{even} ({left} on a load "
                f"that takes its {s.demand_cases} cases is {kg_text(max(0.0, max(by_cases)) / 10)} kg)." + tail)
    most = max((rc for rc, _ in rooms), default=0)
    return (f"Not planned: no load or free trip has room for its {s.demand_cases} cases{even} ({left} is "
            f"{max(0, most)} cases)." + tail)


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
    for s in req.stops:
        if not any(_fits_capacity(s, td) for td in usable):
            max_c = max(td.max_cases for td in usable)
            kg_trucks = [td.max_kg_units for td in usable if td.max_kg_units > 0]
            detail = f"{s.demand_cases} cases vs largest truck {max_c} cases"
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
    reports it (the routing model can only bound the return time from the shift start). On a truck
    with frozen loads both count only NEW overtime, after the later of its day start + overtime_after
    and its last frozen return (load_repack.overtime_bound_s, audit E4). The exact OMR rates ride
    along, so the RECOMMENDED score's money equals the reported costs (costing.py)."""
    cfg = req.config
    w = SCENARIOS[name]
    trucks = {
        td.idx: LR.TruckPrice(
            # A truck with frozen loads is already out today: no "open a truck" cost again, in any
            # scenario (MIN_TRUCKS' x20 included), as in the routing model (PR7, B3).
            fixed=int(round(td.truck.fixed_cost * w.fixed * COST_SCALE)) if td.n_frozen == 0 else 0,
            trip=int(round(td.truck.trip_cost * w.trip * COST_SCALE)),
            per_m=_km_rate_omr(td.truck, cfg) * w.distance * COST_SCALE / 1000.0,
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
        return _empty_scenario(name, "NOTHING_TO_PLAN", pre_drops, time_limit, mx, tds)

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
        if td.n_frozen == 0:  # a truck with frozen loads is already out: never "opened" again (B3)
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
        if time_coeff:
            # Driver pay = the whole truck day (costing.py): the route's span, and for a truck with
            # frozen loads also the time from its last frozen return to the first new departure
            # (turnaround and waiting are paid too), i.e. last return - last frozen return.
            tdim.SetSpanCostCoefficientForVehicle(time_coeff, v)
            if td.frozen_return_s is not None:
                tdim.SetCumulVarSoftUpperBound(start, td.frozen_return_s, time_coeff)
        if ot_coeff and cfg.overtime_after_min is not None:
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
    total_cap_cases, total_cap_u, demand_cases, demand_u, kg_bound = _fleet_capacity(stops, tds)
    total_cap_kg, demand_kg = total_cap_u / 10, demand_u / 10
    short_cases, short_kg = _fleet_shortage(stops, tds)
    shortage = short_cases or short_kg
    priority_of = {st.stop_id: st.priority for st in stops}
    unserved_penalty = 0.0
    open_drops = 0
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
                                      f"Not planned: once every load was timed with the loading time between loads "
                                      f"({cfg.reload_min} min + {cfg.loading_min_per_case:g} min per case)"
                                      f"{brk_words}, the route search's "
                                      f"loads no longer fitted the truck days and this P{s.priority} stop was left out "
                                      "(lowest priorities first). Re-plan, add a truck, or check the loading time."))
        elif shortage:
            unserved.append(_unserved(s, "SOLVER_DROPPED_LOW_PRIORITY",
                                      _shortage_reason(s.priority, demand_cases, total_cap_cases, demand_kg, total_cap_kg,
                                                       short_cases, short_kg)))
        elif (no_room := _no_room_reason(s, usable_tds, loads, priority_of)) is not None:
            # No load of this plan and no free trip has room for it (cases or kg), even without
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
    left = [s for k, s in enumerate(stops) if k not in served]
    left_u = sum(kg_units(s.demand_kg) for s in left)
    short_by_cases = demand_cases - total_cap_cases
    short_by_u = demand_u - total_cap_u
    # The shortage explains leaving out about what the trucks are short of - in cases or in kg,
    # whichever is short - plus one order that does not split. Or: no unserved stop fits the room
    # left on any load (or on a load a truck did not use). Whole stops leave some room on EVERY
    # load, so over several loads the unserved amount can pass "short + one order" although no
    # re-plan can serve more (PR6 review: 6 loads each 116 kg short of full, every unserved stop 336 kg).
    explained = (short_cases and left_cases <= short_by_cases + max((s.demand_cases for s in left), default=0)) or (
        short_kg and left_u <= short_by_u + max((kg_units(s.demand_kg) for s in left), default=0)) or (
        shortage and not _fits_room_left(left, usable_tds, loads))
    if shortage and not explained:
        # Not everything: the rest did not fit by time, hours or the search's limit.
        what = " and ".join(
            ([f"{short_by_cases} cases"] if short_cases else []) + ([f"{kg_text(short_by_u / 10)} kg"] if short_kg else []))
        left_kg_text = f" ({kg_text(left_u / 10)} kg)" if kg_bound else ""
        warnings.append(
            f"The trucks are {what} short today, but {left_cases} cases{left_kg_text} are unserved: more than the "
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
    )
    _assert_reconciled(req, sc)
    # Without loading per case the search's turnaround is exact - but its times never hold a driver
    # break, so with the break rule only load_repack's timing is exact (the safety net re-times).
    exact = exact_timing or (cfg.loading_min_per_case == 0 and break_rule(cfg) is None)
    sc.feasibility = FZ.safe_check(req, sc, solvable=stops, mx=mx, timing="EXACT" if exact else "ESTIMATED")
    return sc


def _fleet_capacity(stops: list[DispatchStop], tds: list[TruckDay]) -> tuple[int, int, int, int, bool]:
    """(cases the usable trucks can carry in their loads left, their 0.1 kg units, cases asked for,
    0.1 kg units asked for, whether weight bounds the day). Weight bounds the day when every usable
    truck has a payload (0 = kg not limited): a day can be short of kg while the cases would fit
    (scenario test S03). In 0.1 kg units, no margin (audit F08): 3,000.1 kg on 3,000 kg is short."""
    usable_tds = [td for td in tds if td.usable]
    total_cap_cases = sum(td.truck.capacity_cases * td.trips_left for td in usable_tds)
    kg_bound = bool(usable_tds) and all(td.max_kg_units > 0 for td in usable_tds)
    total_cap_u = sum(td.max_kg_units * td.trips_left for td in usable_tds) if kg_bound else 0
    return (total_cap_cases, total_cap_u, sum(s.demand_cases for s in stops), sum(kg_units(s.demand_kg) for s in stops),
            kg_bound)


def _fleet_shortage(stops: list[DispatchStop], tds: list[TruckDay]) -> tuple[bool, bool]:
    """(short of cases, short of kg): the fleet-shortage test of _build_scenario, shared with the
    second search's penalty rule (pyvrp_candidate.build_model)."""
    cap_cases, cap_u, demand_cases, demand_u, kg_bound = _fleet_capacity(stops, tds)
    return demand_cases > cap_cases, kg_bound and demand_u > cap_u


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
    try:
        coords = [(req.depot.lat, req.depot.lng)] + [(s.lat, s.lng) for s in solvable]
        mx = resolve_matrix(
            coords,
            provider=cfg.distance_provider,
            osrm_url=cfg.osrm_url,
            haversine_multiplier=cfg.haversine_multiplier,
            avg_speed_kmh=cfg.avg_speed_kmh,
            road_time_factor=cfg.road_time_factor,
            osrm_client=osrm_client,
            deadline=started + matrix_budget_sec(budget),
        )
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
        if workers is not None:
            workers.close()  # already closed by _run_scenarios when it ran; a no-op then
        pv.close()
    for sc in scenarios:
        sc.window_rule = cfg.window_rule  # the echo, on empty and NO_SOLUTION scenarios too
        sc.break_rule = _break_echo(cfg)
        sc.latest_return_min = cfg.latest_return_min
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


def _worker_init(beacon, stop_flag=None, search_over=None) -> None:
    global _BEACON, _STOP_FLAG, _SEARCH_OVER
    # Test hook (rule 22): every worker process dies while starting, so the pool never runs a task.
    if os.environ.get("ROUTEIQ_TEST_WORKER_START_EXIT") == "1":
        os._exit(3)
    _BEACON = beacon
    _STOP_FLAG = stop_flag
    _SEARCH_OVER = search_over


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


class _Workers:
    """A spawn Pool with what the waits need, without Pool's private attributes where possible:
    its size (stored here, not read from Pool._processes) and which worker process runs which task
    (each task reports its pid when it starts). Worker pids come from Pool's private worker list;
    when that is gone, pids() is None and deaths are only seen at the deadline.

    Rule 22 (review): broken() says when the pool can no longer run tasks (the waits then stop at
    once, _await_all), and close() never holds the request for more than about POOL_CLOSE_SEC."""

    def __init__(self, size: int, control: SolveControl | None = None, *, run_id: str = "", what: str = "search",
                 search_over: bool = False):
        import multiprocessing as mp

        ctx = mp.get_context("spawn")
        self.size = max(1, int(size))
        self.run_id = run_id
        self.what = what  # "search", "load re-check" or "second search", for the administrator's log lines
        self._beacon = ctx.SimpleQueue()
        # The solve's "stop now" flag, seen by every THOROUGH search in these workers (_watch_search).
        # Every wait on these workers also watches the control (cancelled: SolveAborted, _await_all).
        self.control = control
        # The second search's pool: "the engine's searches are over" (pyvrp_candidate.Stopper).
        self.search_over = None
        try:
            stop_flag = ctx.Event() if control is not None else None
            self.search_over = ctx.Event() if search_over else None
            self.pool = ctx.Pool(processes=self.size, initializer=_worker_init,
                                 initargs=(self._beacon, stop_flag, self.search_over))
        except BaseException:
            # Nothing left behind by a failed start (rule 22; audit finding: the queue made above used
            # to stay open). Pool itself stops the worker processes it had started.
            self._beacon.close()
            raise
        if stop_flag is not None:
            control.attach(stop_flag)  # type: ignore[union-attr]
        self._pid_of: dict[str, int] = {}
        self._tasks: dict[str, object] = {}  # token -> AsyncResult of each task not seen finished yet
        self._seq = 0
        self._warned = False
        self._closed = False
        self._close_ok = True
        self._proved = False  # check_started saw a task run (before that, _start_workers alerts)
        self._broken: str | None = None

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
        """Start ``fn(arg)`` in a worker; returns (token, AsyncResult)."""
        self._seq += 1
        token = f"{name}#{self._seq}"
        fut = self.pool.apply_async(_tracked, (token, fn, arg))
        self._tasks[token] = fut
        return token, fut

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

    def close(self) -> bool:
        """Stop the workers (and any task still running past its deadline). Safe to call twice.

        Rule 22 (review): bounded. CPython's Pool.terminate() waited forever on a pool that broke
        (_stop_pool_processes), which held the request - its answer, its slot - for good. The worker
        processes are now stopped first, then terminate() runs in a background thread for at most
        POOL_CLOSE_SEC. False when it did not finish in that time: the administrator is alerted
        (an ERROR line, /ready) and the cleanup goes on in the background."""
        if self._closed:
            return self._close_ok
        self._closed = True
        pool = self.pool
        _stop_pool_processes(pool)
        finished = threading.Event()

        def cleanup() -> None:
            try:
                pool.terminate()
                pool.join()
            except Exception as exc:  # noqa: BLE001 - nothing to do about it but say so
                log.warning("run=%s worker pool cleanup failed: %s", self.run_id, exc)
            finally:
                finished.set()

        threading.Thread(target=cleanup, name="routeiq-pool-close", daemon=True).start()
        self._close_ok = finished.wait(POOL_CLOSE_SEC)
        if not self._close_ok:
            _workers_alert(self.run_id, f"a worker pool did not stop within {POOL_CLOSE_SEC:g} s after the {self.what} "
                           "and is left to stop in the background", "Pool.terminate() did not return", nothing_searched=False)
        try:
            self._beacon.close()
        except Exception:  # noqa: BLE001
            pass
        return self._close_ok


def _stop_pool_processes(pool) -> None:
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
    whatever still waits."""
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


@dataclass
class _PvRun:
    """The second route search of one solve. It runs in a one-process pool of its own, started after
    rule 22's proof and never part of it (critique C2): a machine that cannot start it still solves
    (SKIPPED / NO_PROCESS); a search or stage of it that fails, dies or hangs only loses its own
    candidates. ``report`` becomes SearchReport.pyvrp."""

    report: dict
    run_id: str = ""
    workers: _Workers | None = None
    inprocess: bool = False  # SOLVER_PARALLEL=0 (tests, development): after the engine's searches
    job: tuple | None = None  # (token, AsyncResult) of its search
    args: tuple | None = None  # (req, solvable, tds, mx, PvSettings)
    plan: LR.Plan | None = None  # its checked plan, for the load re-check

    @property
    def active(self) -> bool:
        return self.workers is not None or self.inprocess

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
        if self.workers is not None:
            workers, self.workers = self.workers, None
            try:
                workers.close()
            except Exception:  # noqa: BLE001 - never costs the engine's answer
                pass


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
            pv.workers = _Workers(1, control, run_id=req.run_id, what="second search", search_over=True)
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
    if pv.workers is not None:
        pv.job = pv.workers.submit(PV.solve_in_worker, pv.args, "PYVRP")


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
        if pv.workers.search_over is not None:  # type: ignore[union-attr]
            pv.workers.search_over.set()  # type: ignore[union-attr]
        deadline = limit if thorough and not stopped else min(now + PV.stop_grace_sec(), limit)
        kind, value = _await_all(pv.workers, {"PYVRP": pv.job}, max(deadline, now), control)["PYVRP"]  # type: ignore[arg-type]
        if kind != "ok":
            reason = {"lost": "LOST", "broken": "LOST", "timeout": "TIMEOUT"}.get(kind, "FAILED")
            detail = {"lost": "its worker process stopped", "broken": "its worker process stopped",
                      "timeout": "it did not answer in time"}.get(kind, f"{type(value).__name__}: {value}")
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
    RECOMMENDED's search limit, search time, status and its THOROUGH watch report (SearchReport).

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
                _post_solve(req, solvable, tds, mx, time_limit, drops, results, workers, budget_end, staged, **stage_kw)
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
# (priority value of the unserved stops), then:
_GOALS = {
    # the RECOMMENDED objective (operating cost + preferred hours, early arrival, continuity)
    "RECOMMENDED": lambda sc: (sc.unserved, sc.cost),
    # fewest trucks, then loads, then operating cost (like its search, it ignores preferences).
    # Physical trucks (PR7, B3): a truck with a frozen load counts whether or not it gets new loads,
    # so putting new loads on it never looks like one truck more than opening a fresh one.
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
    values, value_warnings = _service_values(solvable, cfg, use_margin)
    day = LR.Day(stops=solvable, trucks=[td for td in tds if td.usable], D=mx.distance_m, T=mx.duration_s,
                 shift_max_s=cfg.shift_max_min * 60, reload_s=cfg.reload_min * 60,
                 loading_s_per_case=cfg.loading_min_per_case * 60, values=values,
                 frozen_trucks=frozenset(td.idx for td in tds if td.n_frozen), window_rule=cfg.window_rule)
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
            sc.warnings.append(msg + f" Its times do not hold {what} and could not be re-timed exactly: "
                                     + ("the driver breaks could not be timed: re-plan." if brk else
                                        "check the timetable before dispatching, or re-plan."))
            continue
        sc.warnings.append(msg)


def _post_solve(req: DispatchRequest, solvable: list[DispatchStop], tds: list[TruckDay], mx: MatrixResult,
                time_limit: int, drops: list[UnservedStop], results: dict[str, DispatchScenario], pool,
                budget_end: float, done: set[str] | None = None, repack_cap: float | None = None,
                pv: "_PvRun | None" = None) -> None:
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
    Every scenario it replaces is added to ``done``. ``repack_cap``: seconds per CP-SAT solve
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
    optional = _repair_weights(solvable, left_out, cfg) if left_out else None
    rec_pricing = ctx.rec_pricing
    goals = _stage_goals(raw) if raw else []
    cap = repack_cap if repack_cap is not None else min(REPACK_CAP_SEC, max(REPACK_MIN_SEC, time_limit / 2))
    job_budget = min(cap * len(sources), budget_end - t0 - STAGE_GRACE_SEC - 5)
    fit_weights = _repair_weights(solvable, set(range(n_stops)), cfg)

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
                          optional=_repair_weights(solvable, set(range(n_stops)) - pv_carried, cfg) or None,
                          cap_s=cap, budget_s=pv_budget, fit_weights=fit_weights)
        else:
            pv.report.update(status="NOT_CHOSEN", reason="OUT_OF_TIME")  # type: ignore[union-attr]
    jobs = {g: dict(day=ctx.day, score_pricing=rec_pricing, goal=g,
                    goal_pricing=rec_pricing if g == "RECOMMENDED" else _pricing(g, req, tds, solvable),
                    sources=sources, optional=optional, cap_s=cap, budget_s=job_budget, time_raw=g == "RECOMMENDED",
                    fit_weights=fit_weights)
            for g in goals}
    outputs: dict[str, tuple[list[LR.Candidate], list[str]]] = {}
    pv_task = None
    if pv_job is not None and pv.workers is not None:  # type: ignore[union-attr]
        # Its own process (idle since its search ended): starts now, beside the engine's jobs.
        pv_task = pv.workers.submit(PV.stage_in_worker, pv_job, "stage:PYVRP")  # type: ignore[union-attr]
    pv_deadline = min(time.monotonic() + (pv_job["budget_s"] if pv_job else 0) + STAGE_GRACE_SEC, budget_end - 2)
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
    if pv_task is not None:
        kind, value = _await_all(pv.workers, {"PYVRP": pv_task}, max(pv_deadline, time.monotonic()))["PYVRP"]  # type: ignore[union-attr,arg-type]
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
        fits = [c for c in pool_c if c.score.unserved <= own]
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

    for name in list(raw) + rescue:
        sc = results[name]
        own_carried = carried.get(name, set())
        own = sum(v for k, v in enumerate(values) if k not in own_carried)
        # An option without a plan of its own is rescued only by the second search's plans (its
        # other options' plans are not offered to it, as without the second search).
        best, lost = pick(name, cands if name in raw else pvc, own)
        ref, ref_lost = pick(name, eng, own) if name in raw else (None, False)
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
            new.warnings.append(
                f"{len(timing_drops)} stop(s) the route search had planned are left out: with the loading time between "
                f"loads ({cfg.reload_min} min + {cfg.loading_min_per_case:g} min per case) its loads did not fit the truck "
                "days, so the lowest priorities were left out (see Unserved orders). Re-plan, add a truck, or check the "
                "loading time." + (f" {len(added)} stop(s) the route search had left out are planned instead." if added else "")
            )
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
    if b.unserved != r.unserved:
        if b.unserved > r.unserved:
            return None
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
