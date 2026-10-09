"""Post-solve stage of the NMWC dispatch engine: re-assign whole loads, time plans exactly.

Why this exists
---------------
The routing search (dispatch_solver) keeps every load of a truck on ONE OR-Tools route,
separated by optional depot "reload" visits. Its moves relocate a stop or a short chain at a
time, so they cannot move a WHOLE load onto another truck (that needs a reload visit and the
load's stops to move together). On NMWC's real day this left every truck with one short morning
load: 13 trucks / 21 loads / ~754 OMR, while the search's own loads fit on 5-7 trucks doing 2-3
loads each (~490-560 OMR, benchmark in docs/OPTIMIZER_BENCHMARK.md). More search time barely
helps.

What it does
------------
* ``repack()``: keeps each load exactly as the search built it (same stops, same order) and
  decides, exactly (CP-SAT), which truck carries it and when it departs, for one scenario's
  prices. Stops the search left unplanned can enter as OPTIONAL one-stop loads, so a free truck
  or trip picks them up (served value first, then cost).
* ``time_plan()``: times any plan exactly with one small LP per truck: hard windows, depot
  hours, truck availability, shift limit, frozen loads, and the turnaround between two loads =
  ``reload_min + loading_min_per_case x cases of the NEXT load``. Preferred windows, early
  arrival, driver time and overtime are minimised as in RECOMMENDED. Every plan the engine
  returns is timed here, so times and costs are computed one way.
* ``score()``: the one RECOMMENDED objective every candidate plan is compared on.
* Fit fallback (``build_candidates`` with ``fit_weights``): the route search only estimates the
  loading time between loads (80% of a full truck). On a day without slack a plan of fuller loads
  then breaks the exact turnaround, and no re-assignment keeping all its stops exists. It is
  repacked once more with every stop optional (fit_pool: whole loads, every stop alone, loads
  shortened by one or two stops or cut in two), so phase 1 keeps the most strict-priority value that
  fits.
* Recovery (``trim``, ``recover``; benchmark of 8 Oct 2026, F01 / F02 / F07): such a plan is first cut
  to the part that times exactly, and the stops it loses are inserted again in strict priority order
  wherever exact timing still passes (an idle truck, spare time after a truck's last return, an
  existing load) - a fully timed incumbent before the fit repack, which starts from it. Every job's
  best candidate gets the same recovery of the stops it leaves out, where a stop that fits nowhere may
  take the place of stops of a lower priority on one load (strict priorities; review solver-pipeline-1).

Driver break (config.break_min; TruckDay.break_state DUE)
-------------------------------------------------------
``time_truck`` places it exactly: the break-free LP first (a lower bound; taken when its timetable
already meets the rule), then one LP per position - no break needed (back by the window's end /
first departure at its start or later), at the depot before a load (it may overlap the
turnaround), or on the road after stop i (first leg and way back included) - until a position
reaches the bound; ties go to no break, then the depot, then the road; on the road the break
starts right after the previous unloading unless the window starts later. ``timing_ok`` re-checks
it. The CP-SAT repack gets a depot break interval per DUE truck and road-break variants of loads
(a fixed pause on chosen legs); it is only a proposal (stricter than the LP), retried with the
break as a penalty when it proves a plan infeasible.

dispatch_solver decides WHICH plans are candidates (each raw scenario plan and its repacks),
picks the best per scenario and turns it into loads. This module knows nothing about scenarios:
it gets prices (``Pricing``) and service values in objective units (1 unit = 0.00001 OMR).

Load model used by the repack
-----------------------------
A load visiting stops k1..km in order has no-wait offsets off_i (departure -> service start at
stop i), a no-wait duration d (departure -> return) and a departure interval [lo, hi] in which no
stop waits and every hard window holds: lo = max_i(hard_start_i - off_i), hi = min_i(latest_i -
off_i), latest_i = the latest service start (latest_start_s: closing - stop time when unloading
must be finished by closing, config.window_rule FINISH; closing under the earlier START rule). Departing before lo only moves the waiting onto the road (return = max(e, lo) + d), so
the repack departs in [lo, hi]. When lo > hi the load must wait on the road; it then departs at
hi (the latest time that still meets every window) and occupies the truck until lo + d. Before
a load departs the truck needs its turnaround (reload + loading of THIS load's cases) after the
previous load's return; the first load of the day is loaded before the shift starts, except on a
plan made on its delivery day (config.loading_from_min): loading starts then at the earliest, so
every load also departs no earlier than that time + its turnaround (TruckDay.ready_s). The LP
timing afterwards may still improve the timetable (e.g. waiting on the road for a preferred
window); the repack only chooses trucks and the order of loads.
"""
from __future__ import annotations

import logging
import time
from collections import defaultdict
from dataclasses import dataclass, field, replace
from typing import TYPE_CHECKING, Iterable

import costing
from dispatch_models import DAY_MIN, DispatchStop, kg_units

if TYPE_CHECKING:  # pragma: no cover
    from dispatch_solver import TruckDay

log = logging.getLogger("routeiq.dispatch.repack")

HORIZON_S = 2 * DAY_MIN * 60
NO_END_S = DAY_MIN * 2 * 60  # hard_end_min None = open until the end of the horizon


# --------------------------------------------------------------------------------------------
# Plans
# --------------------------------------------------------------------------------------------

Load = tuple[int, ...]  # indices into Day.stops, in delivery order


@dataclass(frozen=True)
class BreakAt:
    """The driver break held by one load. DEPOT: at the depot before the load leaves (it may
    overlap the reload and loading). ROAD: after ``after`` stops were unloaded (0 = on the way to
    the first stop; = the number of stops: on the way back), before the next unloading."""

    start_s: int
    where: str  # "DEPOT" | "ROAD"
    after: int | None = None


@dataclass(frozen=True)
class TimedLoad:
    stops: Load
    depart_s: int  # leaves the depot (just in time for the first stop, never before the truck is ready)
    starts: tuple[int, ...]  # service start per stop
    return_s: int  # back at the depot
    brk: BreakAt | None = None  # the truck-day's driver break, when this load holds it


# truck idx (position in the request's truck list) -> its new loads in time order
TimedPlan = dict[int, list[TimedLoad]]
Plan = dict[int, list[Load]]


def plan_of(timed: TimedPlan) -> Plan:
    return {idx: [tl.stops for tl in loads] for idx, loads in timed.items() if loads}


def plan_signature(plan: Plan) -> tuple:
    """Same trucks carrying the same loads in the same order = the same plan."""
    return tuple(sorted((idx, tuple(loads)) for idx, loads in plan.items() if loads))


# --------------------------------------------------------------------------------------------
# The day and its prices
# --------------------------------------------------------------------------------------------

@dataclass(frozen=True)
class TruckPrice:
    fixed: int  # once per truck day (0 when the truck already has frozen loads today)
    trip: int  # per load
    per_m: float  # per metre driven (non-fuel cost + fuel)
    # A driver paid by the day (DispatchTruck.driver_day_cost; owner answer 6 Oct 2026): its pay per
    # truck day in these units - once, with the day's first new load, unless the truck has frozen
    # loads - and no per-second driver pay or overtime on this truck. None: paid by the hour (span).
    driver_day: int | None = None
    # A truck to rent (the hire suggestion): its HIRE TIER (dispatch_solver._service_and_hire), search
    # only, never money. score() counts it with the service value lost (Score.hire): above every P4/P5
    # order together, below one P1-P3 order, in proportion to the real money of renting it. hire_w: the
    # same rank on the repack's small phase-1 weights (dispatch_solver._hire_repair_weights).
    hire: int = 0
    hire_w: int = 0
    # The search's tie-breaker on a truck to rent or one whose driver is paid by the day (third review
    # of the hire branch: with its fuel in the hire it cost nothing per km or per hour, and its stops were
    # left in any order): tie_m per metre on top of per_m, and tie_span (a day-paid driver) per second of
    # its paid day - both TINY (dispatch_solver.HIRE_TIE_KM_OMR / _tie_span_units; fourth review: at
    # the own fleet's rates they outweighed real money).
    # Never money: score() keeps them apart (Score.tie), compared after the cost; the reported costs
    # are the real ones.
    tie_m: float = 0.0
    tie_span: int = 0

    @property
    def hourly(self) -> bool:
        return self.driver_day is None

    def per_s(self, span: int) -> int:
        """Objective units per second of its paid day in the search: an hourly driver's pay ``span``
        (Pricing.span), or a day-paid driver's tie-breaker (tie_span)."""
        return span if self.driver_day is None else self.tie_span


@dataclass(frozen=True)
class Pricing:
    """One scenario's prices in objective units (1 unit = 0.00001 OMR).

    Driver time is paid for the whole truck day (costing.py, policy TRUCK_DAY_SPAN): from the
    first departure - for a truck with frozen loads, from its last frozen return, the frozen part
    before it being fixed - to the last return, turnarounds and waiting included."""

    trucks: dict[int, TruckPrice]
    span: int = 0  # per second of paid truck day (driver), for the search models (integer)
    overtime: int = 0  # per second of truck day beyond overtime_after_s ...
    # ... counted from the first departure (frozen: first frozen one; its new loads pay only the
    # overtime after their last frozen return too, overtime_bound_s - audit E4).
    overtime_after_s: int | None = None
    pref: int = 0  # per second outside a preferred window
    early: dict[int, int] = field(default_factory=dict)  # priority -> per second after shift start
    shift_start_s: int = 0
    change: int = 0  # per stop on another truck than in the previous plan version
    # The exact rates in OMR per hour (span / overtime above are rounded to whole units per
    # second). score() prices money with these, so it equals the reported costs; None = derived
    # from span / overtime.
    driver_per_hour: float | None = None
    overtime_per_hour: float | None = None

    def day_rates(self) -> costing.DayRates:
        drv = self.driver_per_hour if self.driver_per_hour is not None else self.span * 3600.0 / costing.COST_SCALE
        ot = self.overtime_per_hour if self.overtime_per_hour is not None else self.overtime * 3600.0 / costing.COST_SCALE
        return costing.DayRates(driver_per_hour=drv, overtime_per_hour=ot, overtime_after_s=self.overtime_after_s)

    def truck_rates(self, idx: int) -> costing.TruckRates:
        p = self.trucks[idx]
        # per_m holds the whole per-metre rate (non-fuel + fuel): priced here as distance.
        return costing.TruckRates(fixed=p.fixed / costing.COST_SCALE, trip=p.trip / costing.COST_SCALE,
                                  per_km=p.per_m * 1000.0 / costing.COST_SCALE,
                                  driver_day=p.driver_day / costing.COST_SCALE if p.driver_day is not None else None)


@dataclass
class Day:
    """Everything the repack and the timing need about one planning day. Picklable: it is sent
    to a worker process."""

    stops: list[DispatchStop]  # the solvable stops; matrix node = index + 1, node 0 = depot
    trucks: list["TruckDay"]  # usable trucks only
    D: list[list[int]]  # metres
    T: list[list[int]]  # seconds
    shift_max_s: int
    reload_s: int
    loading_s_per_case: float
    values: list[int]  # objective units lost when stop k is not served
    # Truck idx of every truck with frozen (locked / loading / dispatched) loads today, usable for
    # new loads or not: they are physical trucks of the day whatever a plan adds (score().trucks).
    frozen_trucks: frozenset[int] = field(default_factory=frozenset)
    # config.window_rule: "FINISH" = unloading finished by closing (latest_start_s).
    window_rule: str = "START"

    def __post_init__(self) -> None:
        self.by_idx = {td.idx: td for td in self.trucks}
        # (truck idx, loads, pricing) -> timetable: a repack moves few loads, so most trucks of a
        # candidate plan were timed already (the break positions cost one LP each).
        self.timing_cache: dict[tuple, tuple[object, list | None]] = {}

    def gap_s(self, cases: int) -> int:
        """Turnaround at the depot before a load of ``cases`` departs (after the previous load)."""
        return int(round(self.reload_s + self.loading_s_per_case * cases))

    def metres(self, load: Load) -> int:
        prev, m = 0, 0
        for k in load:
            m += self.D[prev][k + 1]
            prev = k + 1
        return m + self.D[prev][0]


def overtime_bound_s(td: "TruckDay", overtime_after_s: int) -> int | None:
    """When NEW loads of a truck with frozen (locked / loading / dispatched) loads start paying
    overtime: the later of its day start (first frozen departure) + ``overtime_after_s`` and its
    last frozen return. Audit E4, owner decision 14 (count only new cost): the overtime the frozen
    loads already work was charged again by the search models, so a truck already out in overtime
    looked dearer than opening an idle one. The canonical cost (costing.truck_day_costs) and so
    every reported cost already counted it this way. None for a truck without frozen loads (its
    day starts at its first new departure)."""
    if td.shift_anchor_s is None:
        return None
    bound = td.shift_anchor_s + overtime_after_s
    return bound if td.frozen_return_s is None else max(bound, td.frozen_return_s)


def _hs(s: DispatchStop) -> int:
    return (s.hard_start_min or 0) * 60


def latest_start_s(s: DispatchStop, rule: str | None) -> int:
    """The latest service start that meets the stop's receiving hours, in seconds. Under
    config.window_rule "FINISH" unloading must be FINISHED by closing (closing - stop time);
    otherwise ("START", the earlier rule) it must only start by closing. No closing time = open
    until the end of the horizon. The ONE place this rule lives: the route search, the prefilter,
    the repack, the LP timing, timing_ok and the output all call it (feasibility.py re-derives
    it on purpose, as the independent check)."""
    if s.hard_end_min is None:
        return NO_END_S
    he = s.hard_end_min * 60
    return he - s.service_min * 60 if rule == "FINISH" else he


def pref_end_bound_s(s: DispatchStop, rule: str | None) -> int | None:
    """The service start after which a preferred window costs: the preferred end, or under
    "FINISH" the preferred end minus the stop time (unloading finished by then), never below 0."""
    if s.pref_end_min is None:
        return None
    pe = s.pref_end_min * 60
    return max(0, pe - s.service_min * 60) if rule == "FINISH" else pe


def _he(day: "Day", s: DispatchStop) -> int:
    return latest_start_s(s, day.window_rule)


# --------------------------------------------------------------------------------------------
# Load facts (no-wait profile)
# --------------------------------------------------------------------------------------------

@dataclass(frozen=True)
class Facts:
    stops: Load
    off: tuple[int, ...]  # departure -> service start of each stop, no waiting
    d: int  # departure -> return, no waiting
    lo: int  # earliest departure that needs no waiting on the road
    hi: int  # latest departure that meets every hard window
    cases: int
    kg_units: int  # 0.1 kg units, each stop to the nearest unit (dispatch_models.kg_units, audit F08)
    metres: int
    gap: int  # turnaround before this load departs, after the truck's previous load
    # Road-break variant (repack only): a pause of the break length on the leg after ``pause_after``
    # stops; the break may start pause_lo..pause_lo + pause_drive seconds after the departure.
    pause_after: int | None = None
    pause_lo: int = 0
    pause_drive: int = 0
    # The load's pallet need in 1/1000 pallet (the sum of its stops' demand_pallet_units; 0 when the
    # request sent none): what fits_truck compares on a truck with bays.
    pallet_units: int = 0

    @property
    def waits(self) -> bool:
        return self.lo > self.hi

    @property
    def occ(self) -> int:
        """Departure -> return (departing at hi when the load has to wait on the road)."""
        return self.d if not self.waits else self.lo + self.d - self.hi


def facts(day: Day, load: Load, pause_after: int | None = None, pause_s: int = 0) -> Facts:
    """No-wait profile of a load; with ``pause_after`` a pause of ``pause_s`` (the driver break) is
    taken on the leg after that many stops (0 = on the way to the first stop, len = on the way back)."""
    t, prev, off = 0, 0, []
    p_lo = p_drive = 0
    for i, k in enumerate(load):
        leg = day.T[prev][k + 1]
        if pause_after == i:
            p_lo, p_drive = t, leg
            t += pause_s
        t += leg
        off.append(t)
        t += day.stops[k].service_min * 60
        prev = k + 1
    if pause_after == len(load):
        p_lo, p_drive = t, day.T[prev][0]
        t += pause_s
    t += day.T[prev][0]
    ss = [day.stops[k] for k in load]
    return Facts(
        stops=tuple(load), off=tuple(off), d=t,
        lo=max(_hs(s) - o for s, o in zip(ss, off)), hi=min(_he(day, s) - o for s, o in zip(ss, off)),
        cases=sum(s.demand_cases for s in ss), kg_units=sum(kg_units(s.demand_kg) for s in ss), metres=day.metres(load),
        gap=day.gap_s(sum(s.demand_cases for s in ss)), pause_after=pause_after, pause_lo=p_lo, pause_drive=p_drive,
        pallet_units=sum(s.demand_pallet_units or 0 for s in ss),
    )


def _forward_starts(day: Day, f: Facts, depart: int) -> list[int]:
    """Service starts when departing at ``depart`` and waiting wherever a window demands it."""
    out, prev, t = [], 0, depart
    for i, k in enumerate(f.stops):
        s = day.stops[k]
        t = max(t + day.T[prev][k + 1], _hs(s))
        out.append(t)
        t += s.service_min * 60
        prev = k + 1
    return out


def _first_departure_s(day: Day, td: "TruckDay", f: Facts) -> int:
    """Earliest departure of load ``f`` on ``td``: after its turnaround (reload + loading of ITS
    cases) from the truck's last frozen return or the time a same-day plan was made (td.ready_s)."""
    first = td.earliest_depart_s
    if td.ready_s is not None:
        first = max(first, td.ready_s + f.gap)
    return first


def fits_truck(f: Facts, td: "TruckDay") -> bool:
    """The load fits the truck: its pallet units within bays x fill on a truck with bays
    (TruckDay.max_pallet_units; its case capacity is then not a limit), else its cases; and its kg
    in 0.1 kg units against the payload rounded down, with no margin either way (audit F08). Every
    repack path (depart_range, the optional one-stop loads, the fit fallback, time_plan) goes
    through here, so a load over its bays never gets a truck."""
    room = getattr(td, "max_pallet_units", 0)
    space_ok = f.pallet_units <= room if room > 0 else f.cases <= td.max_cases
    return space_ok and (td.max_kg_units <= 0 or f.kg_units <= td.max_kg_units)


def depart_range(day: Day, f: Facts, td: "TruckDay") -> tuple[int, int] | None:
    """Departure interval of this load on this truck (None: it can never go on it)."""
    if not fits_truck(f, td):
        return None
    first = _first_departure_s(day, td, f)
    if not f.waits:
        a, b = max(first, f.lo), min(f.hi, td.latest_return_s - f.d)
    else:
        a = b = f.hi
        if f.hi < first or f.lo + f.d > td.latest_return_s:
            return None
    if a > b:
        return None
    if td.shift_anchor_s is None and f.occ > day.shift_max_s:
        return None
    return a, b


def _entry_range(day: Day, f: Facts, td: "TruckDay") -> tuple[int, int] | None:
    """depart_range of a pool entry. A road-break variant goes only on a truck-day that needs a
    break, departing so that its pause can start inside the truck's break window."""
    r = depart_range(day, f, td)
    if r is None or f.pause_after is None:
        return r
    if not break_due(td):
        return None
    a = max(r[0], td.break_lo_s - f.pause_lo - f.pause_drive)
    b = min(r[1], td.break_hi_s - f.pause_lo)
    return (a, b) if a <= b else None


VARIANT_CAP = 3  # road-break variants per repack: at most this x the pool (+ 20)


def _break_variants(day: Day, pool: list[Load], F: list[Facts]) -> list[tuple[Load, int, Facts]]:
    """Road-break variants for the repack: loads whose road time may cover a DUE truck-day's break
    window, with the break as a pause on legs picked by coverage (the first and last leg that can
    meet the window and one every window-length in between), not on every leg. Loads that must
    cross the window (on some DUE truck they can neither be back by its end nor leave after a
    break at its start) come first; the count is capped."""
    due = [td for td in day.trucks if break_due(td)]
    if not due:
        return []
    L = due[0].break_s
    must: list[tuple[Load, int, Facts]] = []
    may: list[tuple[Load, int, Facts]] = []
    for load, f in zip(pool, F):
        ranges = [(td, r) for td in due if (r := depart_range(day, f, td)) is not None]
        if not ranges:
            continue
        lo = min(td.break_lo_s for td, _ in ranges)
        hi = max(td.break_hi_s for td, _ in ranges)
        a = min(r[0] for _, r in ranges)
        b = max(r[1] for _, r in ranges)
        if b + f.occ <= lo or a >= hi + L:
            continue  # never out on the road during any break window
        crosses = any(r[0] + f.occ > td.break_hi_s and r[1] < td.break_lo_s + L for td, r in ranges)
        # Leg i: the break may start pause_lo .. pause_lo + drive after the departure.
        legs = []
        for i in range(len(load) + 1):
            if _same_customer_leg(day, load, i):
                continue
            fv = facts(day, load, pause_after=i, pause_s=L)
            if a + fv.pause_lo <= hi and b + fv.pause_lo + fv.pause_drive >= lo:
                legs.append(fv)
        # Cover the legs: skip a leg only while the next one still starts within one window length
        # of the last one kept (so every departure that can meet the window keeps a leg that does).
        picked: list[Facts] = []
        for n, fv in enumerate(legs):
            nxt = legs[n + 1] if n + 1 < len(legs) else None
            if not picked or nxt is None or nxt.pause_lo - picked[-1].pause_lo > hi - lo:
                picked.append(fv)
        (must if crosses else may).extend((load, fv.pause_after, fv) for fv in picked)
    cap = VARIANT_CAP * len(pool) + 20
    out = (must + may)[:cap]
    if len(must) + len(may) > cap:
        log.info("repack: %d road-break variants (%d must cross), capped at %d", len(must) + len(may), len(must), cap)
    return out


def _soft_cost(day: Day, pricing: Pricing, k: int, start_s: int) -> int:
    """Preferred window + early-arrival cost of serving stop k at start_s (the engine's own
    coefficients: the upper preferred bound also carries the early-arrival push)."""
    s = day.stops[k]
    early = pricing.early.get(s.priority, 0)
    c = 0
    if s.pref_end_min is not None and pricing.pref > 0:
        c += (pricing.pref + early) * max(0, start_s - pref_end_bound_s(s, day.window_rule))
    elif early > 0:
        c += early * max(0, start_s - pricing.shift_start_s)
    if s.pref_start_min is not None and pricing.pref > 0:
        c += pricing.pref * max(0, s.pref_start_min * 60 - start_s)
    return c


def _moved(day: Day, k: int, td: "TruckDay") -> bool:
    prev = day.stops[k].previous_truck_id
    return bool(prev) and prev != td.truck.id


# --------------------------------------------------------------------------------------------
# Exact timing of a fixed plan (one LP per truck)
# --------------------------------------------------------------------------------------------

_TIE = 0.001  # objective units per second: compact day, wait at the depot rather than on the road
# Objective units per second of break start after the earliest place it can go: among equally dear
# timetables the break starts right after an unloading (or the return), never mid-drive by choice.
_EPS_B = 1e-6
# Timing LPs solved in this process and their seconds (the break positions are the extra ones):
# reported in the stage's log lines and the benchmark.
LP_STATS = {"lps": 0, "sec": 0.0}


def break_due(td: "TruckDay") -> bool:
    """The truck-day may need a driver break that its NEW loads must hold (TruckDay.break_state
    DUE, set by dispatch_solver._truck_days). OFF / NOT_NEEDED / IN_FROZEN_LOAD / NOT_POSSIBLE: none."""
    return getattr(td, "break_state", "OFF") == "DUE"


def _same_customer_leg(day: Day, load: Load, after: int) -> bool:
    """The leg after ``after`` stops joins two parts of one customer's split order: a break there
    sits in the middle of one unloading at the same dock, so it is never a break position."""
    return 0 < after < len(load) and day.stops[load[after - 1]].customer_id == day.stops[load[after]].customer_id


def _positions(day: Day, td: "TruckDay", loads: list[Load]) -> list[tuple]:
    """Every place the break of a DUE truck-day can go, in the order that wins a tie: no break
    needed (back for good by the end of the window; or, without frozen loads, first departure at
    the window start or later), then at the depot, then on the road."""
    out: list[tuple] = [("NONE_AFTER",)]
    if td.shift_anchor_s is None:
        out.append(("NONE_BEFORE",))
    else:
        out.append(("DEPOT", 0))  # after the last frozen return (and the time the plan was made)
    out += [("DEPOT", j) for j in range(1, len(loads))]
    out += [("ROAD", j, i) for j, load in enumerate(loads) for i in range(len(load) + 1)
            if not _same_customer_leg(day, load, i)]
    return out


def _truck_lp(day: Day, td: "TruckDay", loads: list[Load], pricing: Pricing,
              pos: tuple | None) -> tuple[float, list[TimedLoad]] | None:
    """One LP: the timetable of one truck's loads in the given order, minimising the RECOMMENDED
    time costs, with the driver break at ``pos`` (None: no break constraint). The constraint matrix
    only holds difference constraints with integer data, so rounding the optimum keeps it exactly
    feasible (timing_ok checks it again). Returns (objective, timetable) or None."""
    from ortools.linear_solver import pywraplp  # noqa: PLC0415

    t_lp = time.perf_counter()
    try:
        return _truck_lp_solve(pywraplp, day, td, loads, pricing, pos)
    finally:
        LP_STATS["lps"] += 1
        LP_STATS["sec"] += time.perf_counter() - t_lp


def _truck_lp_solve(pywraplp, day: Day, td: "TruckDay", loads: list[Load], pricing: Pricing,
                    pos: tuple | None) -> tuple[float, list[TimedLoad]] | None:
    lp = pywraplp.Solver.CreateSolver("GLOP")
    inf = lp.infinity()
    obj = lp.Objective()
    obj.SetMinimization()
    L = getattr(td, "break_s", 0)
    kind = pos[0] if pos else None
    road = (pos[1], pos[2]) if kind == "ROAD" else None
    B = lp.NumVar(td.break_lo_s, td.break_hi_s, "B") if kind in ("DEPOT", "ROAD") else None

    def diff(a, b, lo, hi=None):  # lo <= a - b <= hi
        c = lp.Constraint(lo, inf if hi is None else hi)
        c.SetCoefficient(a, 1)
        c.SetCoefficient(b, -1)

    def eps(start_var=None):  # _EPS_B x (B - start_var)
        obj.SetCoefficient(B, obj.GetCoefficient(B) + _EPS_B)
        if start_var is not None:
            obj.SetCoefficient(start_var, obj.GetCoefficient(start_var) - _EPS_B)

    fs = [facts(day, l) for l in loads]
    Dv, Rv, tv = [], [], []
    for j, (load, f) in enumerate(zip(loads, fs)):
        lb = _first_departure_s(day, td, f) if j == 0 else td.earliest_depart_s
        D = lp.NumVar(lb, HORIZON_S, f"D{j}")
        R = lp.NumVar(0, td.latest_return_s, f"R{j}")
        if j > 0:
            diff(D, Rv[-1], f.gap)  # D_j - R_{j-1} >= turnaround
        if kind == "DEPOT" and pos[1] == j:
            diff(D, B, L)  # the load leaves after the break (the loading may overlap it)
            if j > 0:
                diff(B, Rv[-1], 0)
                eps(Rv[-1])
            else:
                eps()
        ts, prev, prev_svc, prev_t = [], 0, 0, None
        for i, k in enumerate(load):
            s = day.stops[k]
            t = lp.NumVar(_hs(s), min(_he(day, s), HORIZON_S), f"t{j}_{i}")
            extra = L if road == (j, i) else 0
            leave = D if i == 0 else prev_t
            if i == 0:
                diff(t, D, day.T[0][k + 1] + extra, day.T[0][k + 1] + extra)  # leave just in time
            else:
                diff(t, prev_t, prev_svc + day.T[prev][k + 1] + extra)
            if extra:  # the break between the previous departure and this unloading
                diff(B, leave, prev_svc if i > 0 else 0)
                diff(t, B, L)
                eps(leave)
            for coef, bound, sign in _soft_terms(day, pricing, k):
                u = lp.NumVar(0, inf, "")
                # u >= sign * (t - bound)
                c = lp.Constraint(-sign * bound, inf)
                c.SetCoefficient(u, 1)
                c.SetCoefficient(t, -sign)
                obj.SetCoefficient(u, coef)
            ts.append(t)
            prev, prev_svc, prev_t = k + 1, s.service_min * 60, t
        extra = L if road == (j, len(load)) else 0
        diff(R, prev_t, prev_svc + day.T[prev][0] + extra, prev_svc + day.T[prev][0] + extra)  # R = last start + service + drive back
        if extra:  # the break on the way back
            diff(B, prev_t, prev_svc)
            diff(R, B, L)
            eps(prev_t)
        obj.SetCoefficient(R, obj.GetCoefficient(R) + _TIE)
        obj.SetCoefficient(D, obj.GetCoefficient(D) - _TIE)
        Dv.append(D)
        Rv.append(R)
        tv.append(ts)
    first, last = Dv[0], Rv[-1]
    if kind == "NONE_AFTER":
        c = lp.Constraint(-inf, td.break_to_s)
        c.SetCoefficient(last, 1)
    elif kind == "NONE_BEFORE":
        c = lp.Constraint(td.break_from_s, inf)
        c.SetCoefficient(first, 1)
    if td.shift_anchor_s is None:
        c = lp.Constraint(-inf, day.shift_max_s)
        c.SetCoefficient(last, 1)
        c.SetCoefficient(first, -1)
    # Driver pay (whole truck day): last return - first departure. With frozen loads the day
    # started at the first frozen departure, so the paid time added here is last return - last
    # frozen return (a constant start): an earlier or later first new departure costs the same. A
    # driver paid by the day (TruckPrice.driver_day): no pay per second (its tiny tie-breaker only),
    # no overtime.
    price = pricing.trucks.get(td.idx)
    hourly = price is None or price.hourly
    per_s = pricing.span if price is None else price.per_s(pricing.span)
    span = per_s + _TIE
    obj.SetCoefficient(last, obj.GetCoefficient(last) + span)
    paid_first = per_s if td.shift_anchor_s is None else 0
    obj.SetCoefficient(first, obj.GetCoefficient(first) - paid_first - _TIE + 1e-6)  # ties: earliest day
    if hourly and pricing.overtime and pricing.overtime_after_s is not None:
        u = lp.NumVar(0, inf, "ot")
        bound = overtime_bound_s(td, pricing.overtime_after_s)
        if bound is None:  # u - last + first >= -after
            c = lp.Constraint(-pricing.overtime_after_s, inf)
            c.SetCoefficient(first, 1)
        else:  # only new overtime (audit E4): u >= last - max(anchor + after, last frozen return)
            c = lp.Constraint(-bound, inf)
        c.SetCoefficient(u, 1)
        c.SetCoefficient(last, -1)
        obj.SetCoefficient(u, pricing.overtime)
    if lp.Solve() != pywraplp.Solver.OPTIMAL:
        return None
    brk = None
    if B is not None:
        b = int(round(B.solution_value()))
        brk = BreakAt(b, "DEPOT") if kind == "DEPOT" else BreakAt(b, "ROAD", pos[2])
    out: list[TimedLoad] = []
    for j, (load, D, R, ts) in enumerate(zip(loads, Dv, Rv, tv)):
        out.append(TimedLoad(stops=tuple(load), depart_s=int(round(D.solution_value())),
                             starts=tuple(int(round(t.solution_value())) for t in ts),
                             return_s=int(round(R.solution_value())),
                             brk=brk if (brk is not None and pos[1] == j) else None))
    return obj.Value(), out


def _held_break(day: Day, td: "TruckDay", timed: list[TimedLoad]) -> list[TimedLoad] | None:
    """The break-free timetable of a DUE truck-day, when it already meets the break rule: no break
    needed, or a depot gap / a wait on the road of at least the break inside the window (the break
    is then placed there). None when it does not."""
    L, lo, hi = td.break_s, td.break_lo_s, td.break_hi_s
    if timed[-1].return_s <= td.break_to_s or (td.shift_anchor_s is None and timed[0].depart_s >= td.break_from_s):
        return timed
    for j, tl in enumerate(timed):
        if j == 0 and td.shift_anchor_s is None:
            continue
        b = lo if j == 0 else max(lo, timed[j - 1].return_s)
        if b <= hi and b + L <= tl.depart_s:
            return [replace(x, brk=BreakAt(b, "DEPOT")) if i == j else x for i, x in enumerate(timed)]
    for j, tl in enumerate(timed):
        prev, t = 0, tl.depart_s
        for q, (k, start) in enumerate(zip(tl.stops, tl.starts)):
            leg = day.T[prev][k + 1]
            b = max(lo, t)
            if start - t >= leg + L and b <= min(hi, start - L) and not _same_customer_leg(day, tl.stops, q):
                return [replace(x, brk=BreakAt(b, "ROAD", q)) if i == j else x for i, x in enumerate(timed)]
            t = start + day.stops[k].service_min * 60
            prev = k + 1
    return None


def time_truck(day: Day, td: "TruckDay", loads: list[Load], pricing: Pricing) -> list[TimedLoad] | None:
    """Timetable of one truck's loads, in the given order, minimising the RECOMMENDED time costs;
    on a truck-day that needs a driver break, with the break at the cheapest place. None when no
    timetable meets every hard rule."""
    if not loads:
        return []
    key = (td.idx, tuple(tuple(l) for l in loads), id(pricing))
    cache = getattr(day, "timing_cache", None)
    if cache is not None and key in cache and cache[key][0] is pricing:
        hit = cache[key][1]
        return list(hit) if hit is not None else None
    out = _time_truck(day, td, loads, pricing)
    if cache is not None:
        cache[key] = (pricing, out)  # the pricing is kept alive, so its id is never reused meanwhile
    return list(out) if out is not None else None


def _time_truck(day: Day, td: "TruckDay", loads: list[Load], pricing: Pricing) -> list[TimedLoad] | None:
    free = _truck_lp(day, td, loads, pricing, None)
    if free is None:
        return None
    if not break_due(td):
        return free[1] if timing_ok(day, td, free[1]) else None
    # The break-free LP is a relaxation of every break position (each adds constraints), so its
    # objective is a lower bound: when its timetable already meets the rule it is optimal, and the
    # positions are tried only until one reaches the bound (in whole objective units). Never a
    # dearer timetable than the cheapest position (review: no early stop on "no break" alone).
    held = _held_break(day, td, free[1])
    if held is not None and timing_ok(day, td, held):
        return held
    bound = round(free[0])
    best: tuple[tuple[int, int], list[TimedLoad]] | None = None
    for rank, pos in enumerate(_positions(day, td, loads)):
        got = _truck_lp(day, td, loads, pricing, pos)
        if got is None or not timing_ok(day, td, got[1]):
            continue
        key = (round(got[0]), rank)
        if best is None or key < best[0]:
            best = (key, got[1])
        if key[0] <= bound:
            break
    return best[1] if best is not None else None


def _soft_terms(day: Day, pricing: Pricing, k: int) -> Iterable[tuple[int, int, int]]:
    """(coefficient, bound, sign): cost coefficient x max(0, sign x (start - bound))."""
    s = day.stops[k]
    early = pricing.early.get(s.priority, 0)
    if s.pref_end_min is not None and pricing.pref > 0:
        yield pricing.pref + early, pref_end_bound_s(s, day.window_rule), 1
    elif early > 0:
        yield early, pricing.shift_start_s, 1
    if s.pref_start_min is not None and pricing.pref > 0:
        yield pricing.pref, s.pref_start_min * 60, -1


def timing_ok(day: Day, td: "TruckDay", loads: list[TimedLoad]) -> bool:
    """Every hard rule of one truck's timetable, in integer seconds - the driver break included:
    at most one, only on a DUE truck-day, starting inside [break_lo_s, break_hi_s], never over an
    unloading; a DUE truck-day without one must need none (back by the window's end, or - without
    frozen loads - first departure at the window's start or later)."""
    L = getattr(td, "break_s", 0)
    due = break_due(td)
    held = [tl.brk for tl in loads if tl.brk is not None]
    if held and (not due or len(held) > 1):
        return False
    prev_return = None
    for j, tl in enumerate(loads):
        f_gap = day.gap_s(sum(day.stops[k].demand_cases for k in tl.stops))
        if j == 0:
            if tl.depart_s < td.earliest_depart_s:
                return False
            if td.ready_s is not None and tl.depart_s < td.ready_s + f_gap:
                return False
        elif tl.depart_s < prev_return + f_gap:
            return False
        brk = tl.brk
        road_at = None
        if brk is not None:
            if not td.break_lo_s <= brk.start_s <= td.break_hi_s:
                return False
            if brk.where == "DEPOT":
                if brk.start_s + L > tl.depart_s or (j > 0 and brk.start_s < prev_return) or (
                        j == 0 and td.shift_anchor_s is None):
                    return False
            elif brk.where == "ROAD" and brk.after is not None and 0 <= brk.after <= len(tl.stops):
                road_at = brk.after
                if _same_customer_leg(day, tl.stops, road_at):
                    return False
            else:
                return False
        prev, t = 0, tl.depart_s
        for q, (k, start) in enumerate(zip(tl.stops, tl.starts)):
            s = day.stops[k]
            extra = L if road_at == q else 0
            if extra and not (t <= brk.start_s and brk.start_s + L <= start):
                return False
            if start < t + day.T[prev][k + 1] + extra or not _hs(s) <= start <= _he(day, s):
                return False
            t = start + s.service_min * 60
            prev = k + 1
        # The return is exact: last departure + the drive back (+ the break when it is on the way back).
        extra = L if road_at == len(tl.stops) else 0
        if extra and not (t <= brk.start_s and brk.start_s + L <= tl.return_s):
            return False
        if tl.return_s != t + day.T[prev][0] + extra or tl.return_s > td.latest_return_s:
            return False
        prev_return = tl.return_s
    if due and not held and loads and not (
            loads[-1].return_s <= td.break_to_s or (td.shift_anchor_s is None and loads[0].depart_s >= td.break_from_s)):
        return False
    if td.shift_anchor_s is None and loads and loads[-1].return_s - loads[0].depart_s > day.shift_max_s:
        return False
    return len(loads) <= td.trips_left


def time_plan(day: Day, plan: Plan, pricing: Pricing) -> TimedPlan | None:
    out: TimedPlan = {}
    for idx, loads in plan.items():
        if not loads:
            continue
        td = day.by_idx.get(idx)
        if td is None or len(loads) > td.trips_left:
            return None
        for l in loads:
            if not fits_truck(facts(day, l), td):
                return None
        timed = time_truck(day, td, loads, pricing)
        if timed is None:
            return None
        out[idx] = timed
    return out


# --------------------------------------------------------------------------------------------
# The one objective candidates are compared on
# --------------------------------------------------------------------------------------------

@dataclass(frozen=True)
class Score:
    unserved: int  # service value lost (strict or weighted priority values), objective units
    cost: int  # the rest of the RECOMMENDED objective, objective units
    # Physical trucks of the day: trucks with new loads + trucks with frozen loads (PR7, B3). A
    # truck that already carries a locked or dispatched load is never counted as one more truck.
    trucks: int
    loads: int  # new loads (the frozen ones are the same in every plan of the day)
    metres: int
    operating: int = 0  # the money part of cost: fixed + trip + km + driver span + overtime
    # The hire tier of the rented trucks the plan uses (the hire suggestion's what-if; search only,
    # never money): ranked with the service, between the P1-P3 and the P4/P5 orders (TruckPrice.hire).
    hire: int = 0
    # The search's tie-breaker on day-paid trucks' km and time (TruckPrice.tie_m / tie_span): never
    # money and never in `cost`, compared LAST in every goal (dispatch_solver._GOALS).
    tie: int = 0

    @property
    def service(self) -> int:
        """What every goal compares first: the service value lost and the rented trucks' hire tier."""
        return self.unserved + self.hire

    @property
    def objective(self) -> int:
        return self.unserved + self.hire + self.cost + self.tie


def score(day: Day, pricing: Pricing, plan: TimedPlan) -> Score:
    """RECOMMENDED objective of a timed plan: unserved value + operating cost + preferred-window /
    early-arrival costs + plan-continuity changes. The operating cost (money) is the canonical
    cost model, costing.truck_day_costs - fixed, trip, distance and fuel, driver pay for the whole
    truck day and overtime - so it is exactly what the plan reports (dispatch_solver._build_scenario)."""
    served: set[int] = set()
    soft = n_loads = metres = hire = tie = 0
    used: set[int] = set(day.frozen_trucks)
    money = 0.0
    rates = pricing.day_rates()
    for idx, loads in plan.items():
        if not loads:
            continue
        td = day.by_idx[idx]
        used.add(idx)
        # A rented truck's hire tier (never money, so `operating` stays the plan's cost).
        price = pricing.trucks.get(idx)
        hire += price.hire if price is not None else 0
        timings = []
        for tl in loads:
            n_loads += 1
            m = day.metres(tl.stops)
            metres += m
            if price is not None and price.tie_m:
                tie += int(round(price.tie_m * m))
            timings.append(costing.LoadTiming(depart_s=tl.depart_s, return_s=tl.return_s, km=m / 1000.0))
            for k, start in zip(tl.stops, tl.starts):
                served.add(k)
                soft += _soft_cost(day, pricing, k, start)
                if pricing.change and _moved(day, k, td):
                    soft += pricing.change
        money += costing.truck_day_costs(pricing.truck_rates(idx), rates, timings, anchor_s=td.shift_anchor_s,
                                         frozen_return_s=td.frozen_return_s).total
        if price is not None and not price.hourly and price.tie_span:
            # Its paid day as an hourly driver's would run (from its last frozen return, if any).
            first = td.frozen_return_s if td.shift_anchor_s is not None and td.frozen_return_s is not None else min(tl.depart_s for tl in loads)
            tie += price.tie_span * max(0, max(tl.return_s for tl in loads) - first)
    op = costing.to_units(money)
    unserved = sum(v for k, v in enumerate(day.values) if k not in served)
    return Score(unserved=unserved, cost=op + soft, trucks=len(used), loads=n_loads, metres=metres, operating=op, hire=hire, tie=tie)


# --------------------------------------------------------------------------------------------
# A day-paid truck's day routed again, once the plan is chosen (fifth and sixth reviews of the hire
# branch)
# --------------------------------------------------------------------------------------------
# A truck to rent or one whose driver is paid by the day costs (almost) nothing per km in the search:
# its fuel is in the hire, and its km carry only a tiny tie-breaker, so that they never outweigh real
# money in WHICH truck carries what (fourth review). Within its day, though, the customers' time
# preferences then outweighed its km: one minute earlier at a P1 order (0.01 OMR) was worth 10 km, and
# it drove the P1 orders first wherever they were (340 km instead of 250, back 2 hours later); and a
# rented truck making two loads put stops from all over the area on each (sixth review: 249 km where an
# own truck drives 185).
# shorter_orders routes such a truck's day again afterwards, with the SAME per-km and per-hour costs as
# an own truck's (dispatch_solver._order_km_rate, the hourly driver rate) - for routing only, never money:
# first which of its stops go on which of its loads (no more loads than it has; _day_proposals: the
# shortest round of all its stops cut into loads that fit, and a local search moving and swapping stops
# between its loads), then the order inside each load. A new day is taken only when, timed exactly
# (time_truck: every hard rule, the driver break), it drives fewer km, costs no more money and is better
# on that trade-off. The plan's other trucks, its service and its money stay as they were.

ORDER_PASSES = 40  # improving passes of the local search, per load and start
DAY_PASSES = 200  # improving moves of the local search on a truck's whole day, per start


def _blocks(day: Day, load: Load) -> list[Load]:
    """The load's stops in runs of one customer: the parts of a split order stay together, in order."""
    out: list[list[int]] = []
    for k in load:
        if out and day.stops[out[-1][-1]].customer_id == day.stops[k].customer_id:
            out[-1].append(k)
        else:
            out.append([k])
    return [tuple(b) for b in out]


def _flat(blocks: list[Load]) -> Load:
    return tuple(k for b in blocks for k in b)


def _order_estimate(day: Day, pricing: Pricing, td: "TruckDay", depart: int, order: Load, per_m: float,
                    per_s: float) -> float:
    """A quick estimate of a load's stops in ``order`` departing at ``depart`` (waiting only for opening
    hours): its customers' time preferences + ``per_m`` a metre + ``per_s`` a second out. Infinite when it
    misses a closing time or the truck's latest return. Only to propose orders: time_truck decides."""
    t, prev, est, m = depart, 0, 0.0, 0
    for k in order:
        s = day.stops[k]
        m += day.D[prev][k + 1]
        t = max(t + day.T[prev][k + 1], _hs(s))
        if t > _he(day, s):
            return float("inf")
        est += _soft_cost(day, pricing, k, t)
        t += s.service_min * 60
        prev = k + 1
    m += day.D[prev][0]
    t += day.T[prev][0]
    if t > td.latest_return_s:
        return float("inf")
    return est + per_m * m + per_s * (t - depart)


def _improve(blocks: list[Load], cost, deadline: float) -> tuple[list[Load], float]:
    """First-improvement local search on ``cost`` of a block order: reverse a run of blocks (2-opt), or
    move one block to the other end of a run (or-opt). Stops at ``deadline`` (time.monotonic)."""
    best = list(blocks)
    val = cost(best)
    n = len(best)
    for _ in range(ORDER_PASSES):
        better = False
        for i in range(n - 1):
            if time.monotonic() > deadline:
                return best, val
            for j in range(i + 1, n):
                for c in (best[:i] + best[i:j + 1][::-1] + best[j + 1:],
                          best[:i] + best[i + 1:j + 1] + [best[i]] + best[j + 1:],
                          best[:i] + [best[j]] + best[i:j] + best[j + 1:]):
                    v = cost(c)
                    if v < val - 1e-9:
                        best, val, better = c, v, True
                        break
        if not better:
            break
    return best, val


def _nearest(day: Day, blocks: list[Load]) -> list[Load]:
    """The blocks in nearest-neighbour order from the depot (the start of the shortest order)."""
    left, out, prev = list(blocks), [], 0
    while left:
        b = min(left, key=lambda b: (day.D[prev][b[0] + 1], b))
        out.append(b)
        left.remove(b)
        prev = b[-1] + 1
    return out


def _orders(day: Day, pricing: Pricing, td: "TruckDay", tl: TimedLoad, per_m: float, per_s: float,
            deadline: float) -> list[Load]:
    """At most three other orders of a load's stops worth timing exactly, best estimate first: the
    shortest order found (by metres), and the local search on the estimate from it, from it driven the
    other way round and from the load's own order."""
    blocks = _blocks(day, tl.stops)
    if len(blocks) < 2:
        return []

    def est(bl: list[Load]) -> float:
        return _order_estimate(day, pricing, td, tl.depart_s, _flat(bl), per_m, per_s)

    short, _ = _improve(_nearest(day, blocks), lambda bl: float(day.metres(_flat(bl))), deadline)
    found: dict[Load, float] = {_flat(short): est(short)}
    for start in (short, short[::-1], blocks):
        got, v = _improve(start, est, deadline)
        found[_flat(got)] = v
    found.pop(tuple(tl.stops), None)
    return [o for o, v in sorted(found.items(), key=lambda kv: (kv[1], kv[0])) if v < float("inf")][:3]


def _order_value(day: Day, pricing: Pricing, idx: int, timed: list[TimedLoad], km_per_m: float,
                 span_per_s: float = 0.0) -> tuple[int, int, float]:
    """(money, metres, money + time preferences + tie-breaker + ``km_per_m`` x metres + ``span_per_s`` x
    its paid day) of one truck's timetable (score() of that truck alone: the rest of the plan is the same
    either way). ``span_per_s``: a day-paid driver's day weighed as an hourly driver's (routing only)."""
    sc = score(day, pricing, {idx: timed})
    v = sc.cost + sc.tie + km_per_m * sc.metres
    if span_per_s and timed:
        td = day.by_idx[idx]
        first = td.frozen_return_s if td.shift_anchor_s is not None and td.frozen_return_s is not None else timed[0].depart_s
        v += span_per_s * max(0, timed[-1].return_s - first)
    return sc.operating, sc.metres, v


def _day_estimate(day: Day, pricing: Pricing, td: "TruckDay", loads: list[Load], per_m: float, per_s: float,
                  cache: dict[Load, Facts]) -> float:
    """A quick estimate of a truck's day of ``loads`` (in this order): each load leaving as early as it
    can after its turnaround without waiting on the road (or at its latest when it must wait), its
    customers' time preferences + ``per_m`` a metre + ``per_s`` a second of the day. Infinite when a load
    does not fit the truck, misses a closing time, the truck's latest return or the shift. Only to
    propose days: time_truck decides (the driver break included)."""
    if len(loads) > td.trips_left:
        return float("inf")
    est, first, prev_ret = 0.0, None, None
    for j, load in enumerate(loads):
        f = cache.get(load)
        if f is None:
            f = cache[load] = facts(day, load)
        if not fits_truck(f, td):
            return float("inf")
        earliest = _first_departure_s(day, td, f) if j == 0 else max(td.earliest_depart_s, prev_ret + f.gap)
        if f.waits:
            dep = f.hi
            if dep < earliest:
                return float("inf")
        else:
            dep = max(earliest, f.lo)
            if dep > f.hi:
                return float("inf")
        t, prev = dep, 0
        for k in load:
            s = day.stops[k]
            t = max(t + day.T[prev][k + 1], _hs(s))
            est += _soft_cost(day, pricing, k, t)
            t += s.service_min * 60
            prev = k + 1
        t += day.T[prev][0]
        if t > td.latest_return_s:
            return float("inf")
        est += per_m * f.metres
        first = dep if first is None else first
        prev_ret = t
    if first is None:
        return float("inf")
    if td.shift_anchor_s is None and prev_ret - first > day.shift_max_s:
        return float("inf")
    return est + per_s * (prev_ret - first)


def _day_moves(ls: list[list[Load]]):
    """Every day one move away (lists of block lists, one per load): a block moved anywhere in the day,
    two blocks of two loads swapped, a run of a load reversed, the ends of two loads exchanged, two
    loads swapped in the day. A load may become empty (the day then has a load fewer)."""
    n_l = len(ls)
    for a in range(n_l):
        for i in range(len(ls[a])):
            blk, rest = ls[a][i], ls[a][:i] + ls[a][i + 1:]
            for b in range(n_l):
                tgt = rest if b == a else ls[b]
                for j in range(len(tgt) + 1):
                    if b == a and j == i:
                        continue
                    new = list(ls)
                    new[a] = rest
                    new[b] = tgt[:j] + [blk] + tgt[j:]
                    yield new
    for a in range(n_l):
        for b in range(a + 1, n_l):
            for i in range(len(ls[a])):
                for j in range(len(ls[b])):
                    na, nb = list(ls[a]), list(ls[b])
                    na[i], nb[j] = nb[j], na[i]
                    new = list(ls)
                    new[a], new[b] = na, nb
                    yield new
    for a in range(n_l):
        n = len(ls[a])
        for i in range(n - 1):
            for j in range(i + 1, n):
                new = list(ls)
                new[a] = ls[a][:i] + ls[a][i:j + 1][::-1] + ls[a][j + 1:]
                yield new
    for a in range(n_l):
        for b in range(a + 1, n_l):
            for i in range(len(ls[a]) + 1):
                for j in range(len(ls[b]) + 1):
                    if (i, j) in ((0, 0), (len(ls[a]), len(ls[b]))):
                        continue
                    new = list(ls)
                    new[a], new[b] = ls[a][:i] + ls[b][j:], ls[b][:j] + ls[a][i:]
                    yield new
            new = list(ls)
            new[a], new[b] = ls[b], ls[a]
            yield new


def _day_key(ls: list[list[Load]]) -> tuple[Load, ...]:
    return tuple(_flat(bl) for bl in ls if bl)


def _day_improve(day: Day, pricing: Pricing, td: "TruckDay", ls: list[list[Load]], per_m: float, per_s: float,
                 deadline: float, cache: dict[Load, Facts]) -> tuple[list[list[Load]], float]:
    """First-improvement local search on _day_estimate of a whole day (_day_moves), from ``ls``."""

    def est(x: list[list[Load]]) -> float:
        return _day_estimate(day, pricing, td, list(_day_key(x)), per_m, per_s, cache)

    best, val = [list(bl) for bl in ls], est(ls)
    for _ in range(DAY_PASSES):
        better = False
        for cand in _day_moves(best):
            if time.monotonic() > deadline:
                return best, val
            v = est(cand)
            if v < val - 1e-9:
                best, val, better = cand, v, True
                break
        if not better:
            break
    return best, val


def _split(day: Day, td: "TruckDay", tour: list[Load], k: int, cache: dict[Load, Facts]) -> list[list[Load]] | None:
    """``tour`` (blocks) cut into at most ``k`` consecutive loads that fit the truck, of fewest metres
    (route first, cluster second). None when no cut fits."""
    n, inf = len(tour), float("inf")
    best = [[inf] * (n + 1) for _ in range(k + 1)]
    cut = [[-1] * (n + 1) for _ in range(k + 1)]
    best[0][0] = 0.0
    for j in range(1, k + 1):
        for i in range(1, n + 1):
            for s in range(i - 1, -1, -1):
                load = _flat(tour[s:i])
                f = cache.get(load)
                if f is None:
                    f = cache[load] = facts(day, load)
                if not fits_truck(f, td):
                    break  # a longer run from further back fits even less
                if best[j - 1][s] + f.metres < best[j][i]:
                    best[j][i], cut[j][i] = best[j - 1][s] + f.metres, s
    j = min(range(1, k + 1), key=lambda q: (best[q][n], q))
    if best[j][n] == inf:
        return None
    out, i = [], n
    while j > 0:
        s = cut[j][i]
        out.append(list(tour[s:i]))
        i, j = s, j - 1
    return out[::-1]


def _day_proposals(day: Day, pricing: Pricing, td: "TruckDay", cur: list[TimedLoad], per_m: float, per_s: float,
                   deadline: float) -> list[list[Load]]:
    """At most three other days of the truck's stops (as many loads at most) worth timing exactly, best
    estimate first: the shortest round of all its stops cut into loads that fit (_split, the loads in
    their best order in the day) and the truck's own loads, each improved by the local search."""
    import itertools  # noqa: PLC0415

    cache: dict[Load, Facts] = {}
    own = [_blocks(day, tl.stops) for tl in cur]
    blocks = [b for bl in own for b in bl]
    if len(blocks) < 2:
        return []

    def est(x: list[list[Load]]) -> float:
        return _day_estimate(day, pricing, td, list(_day_key(x)), per_m, per_s, cache)

    starts: list[list[list[Load]]] = []
    tour, _ = _improve(_nearest(day, blocks), lambda bl: float(day.metres(_flat(bl))), deadline)
    split = _split(day, td, tour, len(cur), cache)
    if split is not None:
        orders = itertools.permutations(split) if len(split) <= 3 else (split, split[::-1])
        starts.append(min((list(p) for p in orders), key=lambda p: (est(p), _day_key(p))))
    starts.append(own)
    found: dict[tuple[Load, ...], float] = {}
    for start in starts:
        got, v = _day_improve(day, pricing, td, start, per_m, per_s, deadline, cache)
        key = _day_key(got)
        found[key] = min(found.get(key, float("inf")), v)
    found.pop(tuple(tl.stops for tl in cur), None)
    return [list(d) for d, v in sorted(found.items(), key=lambda kv: (kv[1], kv[0])) if v < float("inf")][:3]


def shorter_orders(day: Day, pricing: Pricing, plan: TimedPlan, trucks: Iterable[int], km_per_m: float,
                   deadline: float) -> TimedPlan:
    """``plan`` with the day of each of ``trucks`` (a truck to rent, or one whose driver is paid by the day)
    routed again where it is better (see above), its km priced at ``km_per_m`` (objective units a metre:
    an own truck's km rate) and its paid day at the hourly driver rate (Pricing.span), as an own truck's:
    first which of its stops go on which of its loads (_day_proposals; never more loads than it has),
    then the order inside each load (_orders). A new day is taken when, timed exactly (time_truck: every
    hard rule, the driver break), the truck drives fewer metres, costs no more money, and its time
    preferences + those km and hours are lower. Each truck keeps its stops; the other trucks are not
    touched. The same plan object when nothing changed. Stops at ``deadline`` (time.monotonic) with what
    it has, each truck getting its share of the time left."""
    out = dict(plan)
    changed = False
    idxs = sorted(set(trucks))
    for n_left, idx in zip(range(len(idxs), 0, -1), idxs):
        loads, td, price = plan.get(idx), day.by_idx.get(idx), pricing.trucks.get(idx)
        if not loads or td is None or price is None:
            continue
        now = time.monotonic()
        if now > deadline:
            break
        until = now + (deadline - now) / n_left
        # A day-paid driver's day weighed as an hourly driver's (an hourly one's pay is in its money).
        own_s = float(pricing.span) if not price.hourly else 0.0
        per_m = price.per_m + price.tie_m + km_per_m
        per_s = price.per_s(pricing.span) + own_s
        cur, cur_v = list(loads), _order_value(day, pricing, idx, list(loads), km_per_m, own_s)
        if len(cur) >= 2:
            for proposal in _day_proposals(day, pricing, td, cur, per_m, per_s, until):
                timed = time_truck(day, td, proposal, pricing)
                if timed is None:
                    continue
                v = _order_value(day, pricing, idx, timed, km_per_m, own_s)
                if v[0] <= cur_v[0] and v[1] < cur_v[1] and v[2] < cur_v[2]:
                    cur, cur_v, changed = timed, v, True
                    break
        for j in range(len(cur)):
            if time.monotonic() > until:
                break
            for order in _orders(day, pricing, td, cur[j], per_m, per_s, until):
                trial = [tl.stops for tl in cur]
                trial[j] = order
                timed = time_truck(day, td, trial, pricing)
                if timed is None:
                    continue
                v = _order_value(day, pricing, idx, timed, km_per_m, own_s)
                if v[0] <= cur_v[0] and v[1] < cur_v[1] and v[2] < cur_v[2]:
                    cur, cur_v, changed = timed, v, True
        out[idx] = cur
    return out if changed else plan


# --------------------------------------------------------------------------------------------
# CP-SAT load repack
# --------------------------------------------------------------------------------------------

@dataclass
class RepackResult:
    plan: Plan | None
    status: str
    seconds: float


def warm_up() -> None:
    """Import CP-SAT now. Cold, in a fresh worker process, it takes 1.3-2 s (review of the strict-priority
    fix: the stage's workers had imported only the routing modules, so the first repack of every stage job
    paid it, past its limit, and the closing recovery's reserve was gone). Each stage job calls this before
    its clock starts (dispatch_solver._stage_worker, pyvrp_candidate.stage_in_worker): worker start-up,
    inside the stage's grace."""
    from ortools.sat.python import cp_model  # noqa: F401, PLC0415


def repack(day: Day, pricing: Pricing, pool: list[Load], required: set[int], optional: dict[int, int],
           hint: TimedPlan | None, time_limit: float, workers: int = 2, soft_breaks: bool = False,
           model_breaks: bool = True) -> RepackResult:
    """Assign the loads of ``pool`` to trucks and departure times, exactly, for ``pricing``.

    required: stops that must be carried (exactly one chosen load holds each).
    optional: stop -> phase-1 weight; carried at most once. When any optional stop can be
      carried, phase 1 maximises the carried weight first, phase 2 then minimises cost without
      carrying less (lexicographic: service before cost).
    hint: a plan built from the same loads (normally the plan being repacked): CP-SAT starts
      from it, so the answer is never worse on these prices.
    Returns plan None when CP-SAT found no solution in time (the caller keeps its plan).
    soft_breaks: a truck-day without a modelled driver break costs a large penalty instead of being
      refused. CP-SAT's break model (no-wait profiles, a fixed pause on chosen legs) is stricter than
      the LP's, so when it proves a plan's loads INFEASIBLE the caller retries softly and lets
      time_plan judge each proposal.
    model_breaks: False = the break-free model (as before the break rule): much faster; time_plan
      then places the breaks where the proposal leaves room (build_candidates tries it first).
    """
    # The clock starts before the import: a cold CP-SAT import (1.3-2 s, see warm_up) counts in this
    # solve's limit and its seconds. It used to run before them, outside both.
    t0 = time.perf_counter()
    from ortools.sat.python import cp_model  # noqa: PLC0415

    m = cp_model.CpModel()
    # Pool entries: every load as it is, then road-break variants of loads that may have to hold a
    # truck-day's driver break on the road (the same stops, with the break as a pause on one leg).
    # A variant maps back to its plain load; time_plan then places the break exactly.
    F = [facts(day, l) for l in pool]
    entries: list[tuple[Load, int | None]] = [(l, None) for l in pool]
    for l, after, fv in (_break_variants(day, pool, F) if model_breaks else []):
        entries.append((l, after))
        F.append(fv)
    x: dict[tuple[int, int], object] = {}
    ranges: dict[tuple[int, int], tuple[int, int]] = {}
    e: list = []
    sel: list = []
    on_truck: dict[int, list[int]] = defaultdict(list)
    classes = _identical_trucks(day, pricing)
    seen_in_class: dict[int, int] = defaultdict(int)
    for j, f in enumerate(F):
        opts = [(td, r) for td in day.trucks if (r := _entry_range(day, f, td)) is not None]
        # Identical trucks are interchangeable: the i-th truck of a class may only take a load
        # that at least i earlier loads (in pool order) could also take (bin-packing symmetry
        # breaking). Any plan maps onto this by relabelling identical trucks; _add_hint does so.
        classes_here = {classes[td.idx][0] for td, _ in opts if td.idx in classes}
        opts = [(td, r) for td, r in opts if td.idx not in classes or classes[td.idx][1] <= seen_in_class[classes[td.idx][0]]]
        for c in classes_here:
            seen_in_class[c] += 1
        if not opts:
            e.append(None)
            sel.append(None)
            continue
        e_lo, e_hi = min(r[0] for _, r in opts), max(r[1] for _, r in opts)
        ej = m.NewIntVar(e_lo, e_hi, f"e{j}")
        sj = m.NewBoolVar(f"sel{j}")
        xs = []
        for td, (a, b) in opts:
            xv = m.NewBoolVar(f"x{j}_{td.idx}")
            if a > e_lo:
                m.Add(ej >= a).OnlyEnforceIf(xv)
            if b < e_hi:
                m.Add(ej <= b).OnlyEnforceIf(xv)
            x[j, td.idx] = xv
            ranges[j, td.idx] = (a, b)
            on_truck[td.idx].append(j)
            xs.append(xv)
        m.Add(sum(xs) == sj)
        e.append(ej)
        sel.append(sj)

    covering: dict[int, list] = defaultdict(list)
    for j, (l, _after) in enumerate(entries):
        if sel[j] is not None:
            for k in l:
                covering[k].append(sel[j])
    for k in required:
        if not covering[k]:
            return RepackResult(None, "REQUIRED_STOP_UNPLACEABLE", time.perf_counter() - t0)
        m.AddExactlyOne(covering[k])
    for k, vs in covering.items():
        if k not in required:
            m.AddAtMostOne(vs)

    cost_terms: list = []
    # Phase 1 (below): a rented truck's hire tier against the value carried, so an unused rented truck
    # is opened for P1-P3 orders, never for P4/P5 orders alone (TruckPrice.hire_w).
    hire_terms: list = []
    brk_vars: dict[int, tuple] = {}
    for td in day.trucks:
        js = on_truck.get(td.idx, [])
        if not js:
            continue
        price = pricing.trucks[td.idx]
        xs = [x[j, td.idx] for j in js]
        used = m.NewBoolVar(f"used{td.idx}")
        if price.hire_w:
            hire_terms.append(price.hire_w * used)
        for xv in xs:
            m.AddImplication(xv, used)
        m.AddBoolOr(xs).OnlyEnforceIf(used)
        m.Add(sum(xs) <= td.trips_left * used)
        m.AddNoOverlap([
            m.NewOptionalIntervalVar(e[j] - F[j].gap, F[j].gap + F[j].occ, e[j] + F[j].occ, x[j, td.idx], "")
            for j in js
        ])
        st = m.NewIntVar(0, HORIZON_S, f"st{td.idx}")
        en = m.NewIntVar(0, HORIZON_S, f"en{td.idx}")
        for j in js:
            m.Add(st <= e[j]).OnlyEnforceIf(x[j, td.idx])
            m.Add(en >= e[j] + F[j].occ).OnlyEnforceIf(x[j, td.idx])
        if td.shift_anchor_s is None:
            m.Add(en - st <= day.shift_max_s).OnlyEnforceIf(used)
        if model_breaks and break_due(td):
            # The driver break (a proposal: time_plan places it exactly and is the judge). At the
            # depot: an interval that no load's ROAD time may overlap - it may overlap a turnaround,
            # which the first NoOverlap holds. On the road: one chosen road-break variant. Or none
            # needed: back for good by the window's end, or (no frozen loads) first departure at
            # the window's start or later.
            db = m.NewBoolVar(f"db{td.idx}")
            b = m.NewIntVar(td.break_lo_s, td.break_hi_s, f"b{td.idx}")
            m.AddNoOverlap([m.NewOptionalIntervalVar(e[j], F[j].occ, e[j] + F[j].occ, x[j, td.idx], "") for j in js]
                           + [m.NewOptionalIntervalVar(b, td.break_s, b + td.break_s, db, "")])
            variants = [x[j, td.idx] for j in js if F[j].pause_after is not None]
            m.Add(db + sum(variants) <= 1)
            back = m.NewBoolVar("")
            m.Add(en <= td.break_to_s).OnlyEnforceIf(back)
            ways = [db, back] + variants
            if td.shift_anchor_s is None:
                later = m.NewBoolVar("")
                m.Add(st >= td.break_from_s).OnlyEnforceIf(later)
                ways.append(later)
            if soft_breaks:
                miss = m.NewBoolVar("")
                m.Add(sum(ways) + miss >= used)
                cost_terms.append(max(1_000_000, 10 * pricing.span * td.break_s) * miss)
            else:
                m.Add(sum(ways) >= used)
            brk_vars[td.idx] = (db, b)
        # Redundant, for strong bounds: a truck's loads and the turnarounds between them fit in
        # its day, so the day lasts at least their sum (less the first load's turnaround, which
        # happens before the first departure).
        busy = sum((F[j].occ + F[j].gap) * x[j, td.idx] for j in js)
        gmax = max(F[j].gap for j in js)
        if td.shift_anchor_s is None:
            m.Add(busy <= (day.shift_max_s + gmax) * used)
        else:
            m.Add(busy <= (td.latest_return_s - td.earliest_depart_s + gmax) * used)
        # The day's own costs: the truck's fixed cost (already 0 with frozen loads) and a day-rate
        # driver's pay (paid with the frozen loads, if any); a rented truck's hire tier is in phase 1.
        day_cost = price.fixed + ((price.driver_day or 0) if td.n_frozen == 0 else 0)
        if day_cost:
            cost_terms.append(day_cost * used)
        for j in js:
            c = price.trip + int(round((price.per_m + price.tie_m) * F[j].metres))
            if pricing.change:
                c += pricing.change * sum(1 for k in F[j].stops if _moved(day, k, td))
            if c:
                cost_terms.append(c * x[j, td.idx])
        per_s = price.per_s(pricing.span)
        if per_s:
            # Paid truck day (costing.py): first departure -> last return (a day-paid driver's: the
            # search's tiny tie-breaker, TruckPrice.tie_span). A truck with frozen loads
            # started its day earlier; the part added here runs from its last frozen return, which
            # every new load (and its turnaround) comes after.
            sp = m.NewIntVar(0, HORIZON_S, "")
            if td.shift_anchor_s is None or td.frozen_return_s is None:
                m.Add(sp >= en - st).OnlyEnforceIf(used)
                m.Add(sp >= busy - gmax * used)
            else:
                m.Add(sp >= en - td.frozen_return_s).OnlyEnforceIf(used)
                m.Add(sp >= busy)
            cost_terms.append(per_s * sp)
        if pricing.overtime and pricing.overtime_after_s is not None and price.hourly:
            ot = m.NewIntVar(0, HORIZON_S, "")
            bound = overtime_bound_s(td, pricing.overtime_after_s)
            if bound is None:
                m.Add(ot >= en - st - pricing.overtime_after_s).OnlyEnforceIf(used)
                m.Add(ot >= busy - gmax * used - pricing.overtime_after_s)
            else:
                # Only NEW overtime (audit E4, owner decision 14): after the later of the day start +
                # overtime_after and the last frozen return, as costing.truck_day_costs counts it.
                m.Add(ot >= en - bound).OnlyEnforceIf(used)
            cost_terms.append(pricing.overtime * ot)

    # Preferred windows / early arrival: convex in the load's departure (hinges), paid only
    # when the load is chosen. A load that must wait on the road has fixed times.
    if pricing.pref or any(pricing.early.values()):
        for j, f in enumerate(F):
            if sel[j] is None:
                continue
            if f.waits:
                const = sum(_soft_cost(day, pricing, k, t) for k, t in zip(f.stops, _forward_starts(day, f, f.hi)))
                if const:
                    cost_terms.append(const * sel[j])
                continue
            for i, k in enumerate(f.stops):
                for coef, bound, sign in _soft_terms(day, pricing, k):
                    h = m.NewIntVar(0, HORIZON_S, "")
                    m.Add(h >= sign * (e[j] + f.off[i] - bound)).OnlyEnforceIf(sel[j])
                    cost_terms.append(coef * h)

    solver = cp_model.CpSolver()
    solver.parameters.num_workers = workers
    hinted = _add_hint(m, x, e, ranges, entries, _relabel(hint, pool, classes) if hint else None, brk_vars)

    served_terms = [w * v for k, w in optional.items() for v in covering.get(k, [])]
    deadline = t0 + time_limit

    def left(share: float = 1.0) -> float:
        # The phases' limits come out of this solve's own limit (the job's share of its budget):
        # no fixed floor pushes a phase past it (audit E5; the floors were 0.5 s each, also when the
        # solve had used its time).
        return max(0.05, (deadline - time.perf_counter()) * share)

    # Phase 2 always keeps a real chance to reproduce the hinted plan: when phase 1 ran past its 40 %
    # (CP-SAT's presolve on a loaded machine), it still gets 60 % of the limit, at most 0.5 s. A
    # phase 2 of a few hundredths of a second returned no plan (UNKNOWN) and lost phase 1's work.
    # The overrun is bounded (at most 0.5 s per solve) and comes out of the next source's share.
    phase2_min = min(0.5, 0.6 * time_limit)

    if served_terms or hire_terms:
        # Service first: the value carried less the rented trucks' hire tier (the hire suggestion).
        phase1 = sum(served_terms) - sum(hire_terms)
        m.Maximize(phase1)
        solver.parameters.max_time_in_seconds = left(0.4)
        st1 = _solve_until_stalled(solver, m, solver.parameters.max_time_in_seconds)
        if st1 in (cp_model.OPTIMAL, cp_model.FEASIBLE):
            m.Add(phase1 >= int(round(solver.ObjectiveValue())))
            m.ClearHints()
            for (j, idx), xv in x.items():
                m.AddHint(xv, bool(solver.Value(xv)))
            for j, ej in enumerate(e):
                if ej is not None:
                    m.AddHint(ej, solver.Value(ej))
            hinted = True
    m.Minimize(sum(cost_terms))
    solver.parameters.max_time_in_seconds = max(left(), phase2_min)
    status = _solve_until_stalled(solver, m, solver.parameters.max_time_in_seconds)
    name = solver.StatusName(status)
    if status not in (cp_model.OPTIMAL, cp_model.FEASIBLE):
        return RepackResult(None, name + ("" if hinted else " (no hint)"), time.perf_counter() - t0)
    plan: Plan = {}
    for td in day.trucks:
        mine = sorted((solver.Value(e[j]), entries[j][0]) for j in on_truck.get(td.idx, []) if solver.Value(x[j, td.idx]))
        if mine:
            plan[td.idx] = [l for _, l in mine]
    if status == cp_model.FEASIBLE and solver.ObjectiveValue() > 0:
        name += f" gap {100.0 * (solver.ObjectiveValue() - solver.BestObjectiveBound()) / solver.ObjectiveValue():.1f}%"
    return RepackResult(plan, name, time.perf_counter() - t0)


def _solve_until_stalled(solver, model, limit: float):
    """Solve, but stop once no better plan has been found for a quarter of the limit (at least
    1 s) AFTER THE FIRST ONE. On the real day CP-SAT had its final plan after 1-3 s and spent the
    rest of a 10 s limit tightening the bound (3-6% gap), which does not change the plan.

    Audit E5: the stall clock used to start before the first solution, so a search whose first
    answer needed longer than the stall time was stopped with none (UNKNOWN) - on a tight synthetic
    day in 3 of 12 solves. Until the first solution only the solver's own time limit
    (``max_time_in_seconds``, set by the caller from the job's budget) stops it."""
    import threading  # noqa: PLC0415

    from ortools.sat.python import cp_model  # noqa: PLC0415

    class Progress(cp_model.CpSolverSolutionCallback):
        def __init__(self) -> None:
            super().__init__()
            self.last: float | None = None  # no solution yet

        def on_solution_callback(self) -> None:
            self.last = time.perf_counter()

    cb = Progress()
    stall = max(1.0, limit / 4)
    done = threading.Event()

    def watch() -> None:
        while not done.wait(0.1):
            if cb.last is not None and time.perf_counter() - cb.last > stall:
                solver.StopSearch()
                return

    watcher = threading.Thread(target=watch, daemon=True)
    watcher.start()
    try:
        return solver.Solve(model, cb)
    finally:
        done.set()
        watcher.join()


def _identical_trucks(day: Day, pricing: Pricing) -> dict[int, tuple[int, int]]:
    """truck idx -> (class, position) for trucks that are interchangeable in every respect the
    repack sees (capacity, hours, trips, frozen state, prices). Not with plan continuity: there
    each stop prefers its previous truck."""
    if pricing.change:
        return {}
    groups: dict[tuple, list[int]] = defaultdict(list)
    for td in day.trucks:
        groups[(td.max_cases, td.max_kg, td.earliest_depart_s, td.latest_return_s, td.trips_left, td.n_frozen,
                td.shift_anchor_s, td.frozen_return_s, td.loading_from_s, pricing.trucks[td.idx],
                getattr(td, "break_state", "OFF"), getattr(td, "break_lo_s", 0), getattr(td, "break_hi_s", 0),
                getattr(td, "max_pallet_units", 0), getattr(td, "bays", None))].append(td.idx)
    out: dict[int, tuple[int, int]] = {}
    for c, members in enumerate(v for v in groups.values() if len(v) > 1):
        for i, idx in enumerate(sorted(members)):
            out[idx] = (c, i)
    return out


def _relabel(hint: TimedPlan, pool: list[Load], classes: dict[int, tuple[int, int]]) -> TimedPlan:
    """The same plan with identical trucks renumbered in the order of their first pool load, so
    it satisfies the repack's symmetry breaking."""
    pos = {l: j for j, l in enumerate(pool)}
    members: dict[int, list[int]] = defaultdict(list)
    for idx, (c, i) in classes.items():
        members[c].append(idx)
    out: TimedPlan = {idx: loads for idx, loads in hint.items() if idx not in classes}
    for c, ms in members.items():
        ms.sort()
        used = sorted((min(pos.get(tl.stops, len(pool)) for tl in hint[idx]), idx) for idx in ms if hint.get(idx))
        for new_idx, (_, old_idx) in zip(ms, used):
            out[new_idx] = hint[old_idx]
    return out


def _add_hint(m, x, e, ranges, entries: list[tuple[Load, int | None]], hint: TimedPlan | None,
              brk_vars: dict[int, tuple] | None = None) -> bool:
    """Start CP-SAT from ``hint``. A load holding a ROAD break is hinted as its variant on that leg
    when the pool has one; a DEPOT break as the truck's depot break interval. Pool entries are keyed
    by (stops, leg of the break), since a variant has the same stops as its load. CP-SAT is stricter
    than the LP (no-wait profiles, a fixed pause), so the hint is not always feasible: the plan it
    came from stays a candidate through time_plan (build_candidates)."""
    if not hint:
        return False
    pos = {entry: j for j, entry in enumerate(entries)}
    on: set[tuple[int, int]] = set()
    for idx, loads in hint.items():
        for tl in loads:
            road = tl.brk.after if tl.brk is not None and tl.brk.where == "ROAD" else None
            j = pos.get((tl.stops, road)) if road is not None else None
            if j is None or (j, idx) not in x:
                j = pos.get((tl.stops, None))
            if j is None or (j, idx) not in x:
                continue
            on.add((j, idx))
            a, b = ranges[j, idx]
            m.AddHint(e[j], min(max(tl.depart_s, a), b))
            if tl.brk is not None and tl.brk.where == "DEPOT" and brk_vars and idx in brk_vars:
                m.AddHint(brk_vars[idx][0], True)
                m.AddHint(brk_vars[idx][1], tl.brk.start_s)
    for key, xv in x.items():
        m.AddHint(xv, key in on)
    return bool(on)


# --------------------------------------------------------------------------------------------
# One goal's candidates (runs in a worker process)
# --------------------------------------------------------------------------------------------

@dataclass
class Candidate:
    source: str  # e.g. "MIN_DISTANCE" (the raw search plan) or "MIN_DISTANCE+repack:RECOMMENDED"
    plan: TimedPlan
    score: Score


@dataclass
class Source:
    """A raw scenario plan offered to the stage."""

    name: str
    plan: TimedPlan  # timetable as the search reported it (used as the repack hint)


# The fit pool holds at most this many entries per stop it covers, + one per load + FIT_POOL_MIN (a
# small day gets every variant): its CP-SAT model grows with trucks x entries, and the fit repack has
# seconds (benchmark of 8 Oct 2026, F02/F07).
FIT_POOL_PER_STOP = 3
FIT_POOL_MIN = 60


def fit_pool(loads: list[Load], extra: Iterable[int] = (), weights: dict[int, int] | None = None,
             cap: int | None = None) -> list[Load]:
    """The loads a plan can fall back to when it does not fit the day once timed exactly, most
    useful first, until the pool holds ``cap`` entries (default FIT_POOL_PER_STOP x its stops + its
    loads + FIT_POOL_MIN, so the CP-SAT model stays small enough to solve in the repair's seconds):

    1. each load as it is;
    2. a one-stop load for EVERY stop - those of the loads and the ``extra`` ones. Benchmark F02
       (8 Oct 2026, P02): a stop the route search carried whose load did not survive the exact
       timing used to have no load of its own here, so it stayed unserved while a truck was idle;
    3. each load without one of its stops (a shorter load, and a shorter loading time);
    4. each load cut in two: its first stops and its last stops (every prefix and suffix);
    5. each load without two of its stops - the pairs of least service value (``weights``) first.
    """
    pool: list[Load] = []
    seen: set[Load] = set()
    stops = {k for load in loads for k in load} | set(extra)
    limit = cap if cap is not None else FIT_POOL_PER_STOP * len(stops) + len(loads) + FIT_POOL_MIN
    w = weights or {}

    def put(load: Load) -> bool:
        if len(pool) >= limit:
            return False
        if load and load not in seen:
            seen.add(load)
            pool.append(load)
        return True

    for load in loads:
        put(load)
    for k in sorted(stops):
        put((k,))
    for load in loads:
        if len(load) > 1:
            for i in range(len(load)):
                put(load[:i] + load[i + 1:])
    for load in loads:
        for i in range(1, len(load)):
            put(load[:i])
            put(load[i:])
    pairs = [(w.get(load[a], 0) + w.get(load[b], 0), n, a, b) for n, load in enumerate(loads) if len(load) > 2
             for a in range(len(load)) for b in range(a + 1, len(load))]
    for _, n, a, b in sorted(pairs):
        load = loads[n]
        if not put(load[:a] + load[a + 1:b] + load[b + 1:]):
            break
    return pool


# --------------------------------------------------------------------------------------------
# Recovery after the exact stage (benchmark of 8 Oct 2026, F01 / F02 / F07)
# --------------------------------------------------------------------------------------------
# The repacks keep loads as the route search built them. When a search's plan breaks the exact timing
# (the loading time between loads, a driver break it never holds), the fit repack keeps what fits of its
# loads - and on a large same-day re-plan it could leave most of the pending work out while trucks
# stood idle (D5: 84 of 180 stops; P02: one customer with an unused truck), or find nothing in its
# seconds, so the option kept a plan that breaks the rules (D3 at 60 s). Three plain steps close that:
#   trim()    - a fully timed part of a plan: a truck whose loads cannot be timed loses its least
#               valuable stops, one at a time, until they can;
#   recover() - left-out stops in strict priority order (P1 first), each inserted where exact timing
#               still passes: into an existing load, as a new load before, between or after a truck's
#               loads (spare time after its last return), or on an idle truck;
#   recover() of an empty plan is the constructive fallback (the report's "greedy witness").
# Every insertion is re-timed exactly (time_truck: breaks, loading readiness and turnaround, shift,
# depot hours, frozen reservations) and fits the truck (fits_truck: pallets / cases / kg). Frozen
# (locked, loading, dispatched) loads are never in a plan: they are the trucks' reservations
# (TruckDay), so nothing here can move or change them.

RECOVER_TRIES = 24  # timed insertions tried per stop, cheapest estimate first
RECOVER_KEEP = 3  # feasible insertions compared per stop, on the goal
RECOVER_POSITIONS = 3  # positions kept per existing load (the cheapest detours)


def goal_key(goal: str):
    """The goal's comparison of two scored plans (dispatch_solver._GOALS): service first everywhere."""
    return GOALS[goal]


GOALS = {
    # Service first in every goal: the stops left out and the rented trucks' hire tier (Score.service).
    # the RECOMMENDED objective (operating cost + preferred hours, early arrival, continuity)
    # The search's tie-breaker on day-paid trucks (Score.tie, never money) LAST in every goal, only
    # between plans of the same cost (fourth review: added to the cost, it made plans dearer).
    "RECOMMENDED": lambda sc: (sc.service, sc.cost, sc.tie),
    # fewest trucks, then loads, then operating cost (like its search, it ignores preferences).
    # Physical trucks (PR7, B3): a truck with a frozen load counts whether or not it gets new loads,
    # so putting new loads on it never looks like one truck more than opening a fresh one.
    "MIN_TRUCKS": lambda sc: (sc.service, sc.trucks, sc.loads, sc.operating, sc.cost, sc.tie),
    # fewest km, then the RECOMMENDED objective
    "MIN_DISTANCE": lambda sc: (sc.service, sc.metres, sc.cost, sc.tie),
}


def served_of(plan: TimedPlan | Plan) -> set[int]:
    return {k for loads in plan.values() for l in loads for k in (l.stops if isinstance(l, TimedLoad) else l)}


def trim(day: Day, pricing: Pricing, plan: Plan, deadline: float) -> TimedPlan:
    """A fully timed part of ``plan``: each truck's loads as they are when they can be timed exactly;
    otherwise the truck loses its least valuable stop (strict priority value; on a tie the one whose
    leaving out saves the most km), one at a time, until they can (a load left empty is dropped). Past
    ``deadline`` a truck that does not time is left out whole. Fast: about one timing per stop removed."""
    out: TimedPlan = {}
    for idx in sorted(plan):
        td = day.by_idx.get(idx)
        loads = [tuple(l) for l in plan[idx] if l]
        if td is None or not loads:
            continue
        loads = loads[:td.trips_left]
        while loads:
            ok = all(fits_truck(facts(day, l), td) for l in loads)
            timed = time_truck(day, td, loads, pricing) if ok else None
            if timed is not None:
                out[idx] = timed
                break
            if time.perf_counter() > deadline:
                break
            # The stop to leave out: least value first; on a tie, the longest detour.
            best = None
            for j, l in enumerate(loads):
                for i, k in enumerate(l):
                    a = l[i - 1] + 1 if i else 0
                    b = l[i + 1] + 1 if i + 1 < len(l) else 0
                    save = day.D[a][k + 1] + day.D[k + 1][b] - day.D[a][b]
                    key = (day.values[k], -save, -j)
                    if best is None or key < best[0]:
                        best = (key, j, i)
            _, j, i = best  # type: ignore[misc]
            rest = loads[j][:i] + loads[j][i + 1:]
            loads = loads[:j] + ([rest] if rest else []) + loads[j + 1:]
    return out


def _insertions(day: Day, pricing: Pricing, plan: TimedPlan, k: int) -> list[tuple[float, int, list[Load]]]:
    """Where stop ``k`` may go, cheapest estimate first: (estimate, truck idx, the truck's new loads).
    Into each load of a truck at its RECOVER_POSITIONS cheapest positions (the detour in km), or as a
    new one-stop load before, between or after the truck's loads (a free trip). A truck that cannot
    take ``k`` alone - over its room, or no departure meets its hours - gets no option at all."""
    out: list[tuple[float, int, list[Load]]] = []
    single = facts(day, (k,))
    node = k + 1
    for td in day.trucks:
        if not fits_truck(single, td) or depart_range(day, single, td) is None:
            continue
        price = pricing.trucks[td.idx]
        per_m = price.per_m + price.tie_m
        loads = [tl.stops for tl in plan.get(td.idx, [])]
        for j, load in enumerate(loads):
            if not fits_truck(facts(day, load + (k,)), td):
                continue
            pos = []
            for p in range(len(load) + 1):
                a = load[p - 1] + 1 if p else 0
                b = load[p] + 1 if p < len(load) else 0
                pos.append((day.D[a][node] + day.D[node][b] - day.D[a][b], p))
            for detour, p in sorted(pos)[:RECOVER_POSITIONS]:
                new = load[:p] + (k,) + load[p:]
                out.append((per_m * detour, td.idx, loads[:j] + [new] + loads[j + 1:]))
        if len(loads) < td.trips_left:
            opened = 0 if loads else price.fixed + ((price.driver_day or 0) if td.n_frozen == 0 else 0) + price.hire
            est = opened + price.trip + per_m * (day.D[0][node] + day.D[node][0])
            for q in range(len(loads), -1, -1):  # after the last load first: the spare time at the end
                out.append((est + 0.001 * (len(loads) - q), td.idx, loads[:q] + [(k,)] + loads[q:]))
    out.sort(key=lambda o: o[0])
    return out


def _swaps(day: Day, plan: TimedPlan, k: int) -> list[tuple[float, int, list[Load], tuple[int, ...]]]:
    """Where stop ``k`` may take the place of stops of lower service value: (estimate, truck idx, the
    truck's new loads, the stops it puts out), one stop out before two, then the smallest km change first:
    the order recover() tries them in, keeping the first that times. Sorting by the value put out first let
    the cheap options of far loads use up the tries, so a P3 order stayed out while the P4 order it fits
    in place of rode (second review of the strict-priority fix). ``k`` goes where
    the (first) other stop was, or at its cheapest position in that load without them. When one stop off
    leaves too little room, more of the load's lower stops come off, the least valuable first, then the
    biggest, as long as together they are worth less than ``k`` (review solver-pipeline-1, the skeptic's
    seed 12: a P3 order fitted only in place of two P4 orders, and a swap put one stop out only). A stop of
    the same or a higher value is never taken off."""
    out: list[tuple[float, int, list[Load], tuple[int, ...]]] = []
    seen: set[tuple] = set()
    single = facts(day, (k,))
    node = k + 1
    for td in day.trucks:
        if not fits_truck(single, td) or depart_range(day, single, td) is None:
            continue
        loads = [tl.stops for tl in plan.get(td.idx, [])]
        for j, load in enumerate(loads):
            lower = sorted((q for q in load if day.values[q] < day.values[k]),
                           key=lambda q: (day.values[q], -day.stops[q].demand_cases, q))
            for i, q in enumerate(load):
                if day.values[q] >= day.values[k]:
                    continue
                off = [q]
                more = [x for x in lower if x != q]
                rest = load[:i] + load[i + 1:]
                while not fits_truck(facts(day, rest + (k,)), td) and more:
                    x = more.pop(0)
                    off.append(x)
                    rest = tuple(y for y in rest if y != x)
                if not fits_truck(facts(day, rest + (k,)), td) or sum(day.values[x] for x in off) >= day.values[k]:
                    continue
                if (td.idx, j, frozenset(off)) in seen:
                    continue
                seen.add((td.idx, j, frozenset(off)))
                at = min(i, len(rest))
                detour = {p: day.D[rest[p - 1] + 1 if p else 0][node] + day.D[node][rest[p] + 1 if p < len(rest) else 0]
                          for p in range(len(rest) + 1)}
                for p in [at] + [p for p in sorted(detour, key=detour.get) if p != at][:RECOVER_POSITIONS]:
                    new = rest[:p] + (k,) + rest[p:]
                    out.append((float(day.metres(new) - day.metres(load)), td.idx, loads[:j] + [new] + loads[j + 1:],
                                tuple(off)))
    out.sort(key=lambda o: (len(o[3]), o[0]))
    return out


def recover(day: Day, pricing: Pricing, plan: TimedPlan, missing: Iterable[int], deadline: float,
            goal: str = "RECOMMENDED", tries: int | None = RECOVER_TRIES, swaps: bool = False,
            farthest_first: bool = False) -> TimedPlan:
    """``plan`` with as many of the ``missing`` stops as can be inserted, in strict priority order
    (service value, highest first; then the earliest latest start, then the most cases - or, with
    ``farthest_first`` (the constructive fallback), the farthest from the depot first). Each stop
    takes, among up to RECOVER_KEEP insertions that time exactly (of the ``tries`` cheapest estimates;
    None: all of them), the one best for ``goal``; one that does not serve more (Score.service: a
    rented truck is not opened for P4/P5 orders alone) is never taken. With ``swaps`` a stop that fits
    nowhere may take the place of stops of LOWER priority on one load (_swaps, in their order; the first
    that times and serves more by strict service value), and the stops put out then wait for their own
    turn to be inserted again. Stops that fit nowhere get another round after the queue empties, those
    that failed before the last placement. The plan's other trucks are not touched, and a stop that fits
    nowhere is left out. Every step serves strictly more, so this ends; it also stops at ``deadline``. A
    new dict; ``plan`` is unchanged."""
    cur: TimedPlan = {idx: list(v) for idx, v in plan.items() if v}
    key = goal_key(goal)
    base = score(day, pricing, cur)

    def rank(k: int) -> tuple:
        second = -day.D[0][k + 1] if farthest_first else _he(day, day.stops[k])
        return (-day.values[k], second, -day.stops[k].demand_cases, k)

    pending = sorted(set(missing) - served_of(cur), key=rank)
    # A stop that fits nowhere waits in `failed`, with the number of placements made before its turn.
    # Once the queue is empty, the failed stops that saw fewer placements than there are now get another
    # round: a later placement may have changed a truck's day so that one of them now fits, or now takes
    # the place of a stop placed after it (third review of the strict-priority fix: a P1 order failed its
    # turn, a P5 order went in later, and the P1 fitted in its place). A stop that failed after the last
    # placement would only fail again on the same plan. Retrying after every placement instead cost
    # failed stops x placements timings and ran the closing recovery out of its time on shortage days
    # (fourth review).
    failed: list[tuple[int, int]] = []
    placed = 0
    while pending or any(seen < placed for _, seen in failed):
        if not pending:
            pending = sorted((x for x, seen in failed if seen < placed), key=rank)
            failed = [(x, seen) for x, seen in failed if seen >= placed]
        k = pending.pop(0)
        if time.perf_counter() > deadline:
            break
        best: tuple[Score, int, list[TimedLoad], tuple[int, ...]] | None = None
        n = found = 0
        for _, idx, loads in _insertions(day, pricing, cur, k):
            if (tries is not None and n >= tries) or found >= RECOVER_KEEP or time.perf_counter() > deadline:
                break
            n += 1
            timed = time_truck(day, day.by_idx[idx], loads, pricing)
            if timed is None:
                continue
            trial = dict(cur)
            trial[idx] = timed
            sc = score(day, pricing, trial)
            if sc.service >= base.service:
                continue
            found += 1
            if best is None or key(sc) < key(best[0]):
                best = (sc, idx, timed, ())
        if best is None and swaps:
            n = 0
            for _, idx, loads, outs in _swaps(day, cur, k):
                if (tries is not None and n >= tries) or time.perf_counter() > deadline:
                    break
                n += 1
                timed = time_truck(day, day.by_idx[idx], loads, pricing)
                if timed is None:
                    continue
                trial = dict(cur)
                trial[idx] = timed
                sc = score(day, pricing, trial)
                if sc.service < base.service:
                    best = (sc, idx, timed, outs)
                    break
        if best is not None:
            base, cur[best[1]] = best[0], best[2]
            placed += 1
            if best[3]:
                pending.extend(best[3])
                pending.sort(key=rank)
        else:
            failed.append((k, placed))
    return cur


# The recovery's share of a source's repack time when the source's plan cannot be timed exactly (the
# incumbent: trim + recover), and the time the closing recovery may use on a day whose plans timed
# cleanly (a day short of trucks leaves stops out that fit nowhere: never slower for it).
INCUMBENT_SHARE = 0.4
CLEAN_RECOVER_SEC = 2.0
# Review solver-pipeline-1 (strict priorities on a clean shortage day): when a source's plan leaves a
# stop out while it carries a stop of a lower priority, the repacks leave the closing recovery exactly
# min(CLEAN_RECOVER_SEC, this share of the job's budget) (`closing` in build_candidates): in the
# reviewer's demo they used all of it, the recovery never ran, and a P3 order stayed out while a P4 order
# that it fits in place of rode.
CLOSING_SHARE = 1 / 3
# The closing recovery gets that time from when it actually starts: the repacks may end late (CP-SAT's
# last phase may run up to 0.5 s over its limit, then their plans are timed exactly). Under load the
# reserve was gone before it started (review of the strict-priority fix). It may then end up to this
# long past the job's budget, never later; _post_solve waits for it, inside the solve's deadline.
CLOSING_LATE_SEC = CLEAN_RECOVER_SEC
# Benchmark F07: a repair whose best plan still leaves stops out - P1-P3 stops, or any stop when its fit
# repack proved no bound - may use the request's remaining time (extra_s, _post_solve), never more: the
# deep recovery (every insertion, and swaps), then, while P1-P3 stops are still out, the constructive
# fallback and a longer fit repack, each at most this long.
EXTENDED_STEP_MAX_SEC = 60.0
# The most the extension can use (its four steps): what _post_solve grants and waits for, at most.
EXTENDED_MAX_SEC = 4 * EXTENDED_STEP_MAX_SEC


def build_candidates(day: Day, score_pricing: Pricing, goal: str, goal_pricing: Pricing,
                     sources: list[Source], optional: dict[int, int] | None, cap_s: float,
                     budget_s: float, time_raw: bool,
                     fit_weights: dict[int, int] | None = None, extra_s: float = 0.0,
                     fallback: bool = True) -> tuple[list[Candidate], list[str]]:
    """Repack every distinct raw plan with ``goal_pricing``; time every result (and the raw
    plans when ``time_raw``) exactly; score everything on ``score_pricing`` (RECOMMENDED).

    optional: stop -> phase-1 weight of the stops that may be added as one-stop loads (drop
      repair), or None. Only stops a plan does not already carry are optional for it.
    fit_weights: stop -> phase-1 weight of EVERY stop, ranked like the strict service values.
      When a raw plan breaks the exact timing (the route search only estimates the loading time
      between loads, and never holds a driver break) and no re-assignment of its loads carries all its
      stops, it is repaired (benchmark of 8 Oct 2026, F01 / F02 / F07):
      * first a fully timed incumbent, at once: the plan trimmed until it times (trim), then its
        left-out stops inserted again in strict priority order (recover; "+recover" candidates), so
        the option always has a plan that keeps every rule, partial if need be;
      * then repacked once more with every stop optional ("+fit" candidates), from a wider pool
        (fit_pool: every stop alone, loads shortened or cut in two) that also holds the incumbent's
        loads, with the incumbent as the hint: CP-SAT starts from it. None: no such repair.
    After the sources, the job's best candidate for ``goal`` gets the stops it leaves out inserted
    where they still fit (recover; on a day whose plans timed cleanly for CLEAN_RECOVER_SEC at most),
    and a stop that fits nowhere may take the place of stops of a lower priority on one load (swaps:
    strict priorities on every day, review solver-pipeline-1 - before, only a repair day's extension
    swapped, so a clean shortage day delivered P4 orders while a P3 order that fits in their place was
    left out). When a source's plan has such a stop, the repacks leave the closing recovery its time
    (min(CLEAN_RECOVER_SEC, CLOSING_SHARE of the budget)), and it gets that time from when it starts:
    when the repacks ended late it may end up to CLOSING_LATE_SEC past ``budget_s``, never later.
    extra_s: more seconds the job may use on a repair day whose best plan still leaves stops out - P1-P3
      stops, or any stop when its fit repack did not prove its answer (F07): a deep recovery (every
      insertion tried, and swaps: a stop may take the place of one of lower priority, which is then
      inserted again where it fits); then, while P1-P3 stops are still out, the constructive fallback
      (``fallback``: recover() of an empty plan, "FALLBACK" candidates; one job per request builds it)
      and a longer fit repack hinted with the best plan, each at most EXTENDED_STEP_MAX_SEC.
    Every candidate is fully timed and scored; the caller keeps the best by the goal's service-first
    comparison, so a later candidate replaces an earlier one only when it is better.
    Returns (candidates, log lines)."""
    t0 = time.perf_counter()
    lp0 = dict(LP_STATS)
    out: list[Candidate] = []
    notes: list[str] = []
    seen: set[tuple] = set()
    timed_of: dict[tuple, TimedPlan | None] = {}
    done_pools: set[frozenset] = set()
    key = goal_key(goal)
    repair_day = False  # a source's plan could not be timed exactly
    weak = False  # a fit repack ended without proving its answer (FEASIBLE with a gap, UNKNOWN, none)

    def timed(plan: Plan) -> TimedPlan | None:
        sig = plan_signature(plan)
        if sig not in timed_of:
            timed_of[sig] = time_plan(day, plan, score_pricing)
        return timed_of[sig]

    def add(source: str, plan: Plan) -> bool:
        """Add a candidate; True when the plan is (or already was) a valid candidate."""
        sig = plan_signature(plan)
        tp = timed(plan)
        if sig in seen:
            return tp is not None
        seen.add(sig)
        if tp is None:
            notes.append(f"{source}: infeasible when timed exactly; discarded")
            return False
        out.append(Candidate(source, tp, score(day, score_pricing, tp)))
        return True

    def add_timed(source: str, tp: TimedPlan) -> None:
        """Add a plan recover() / trim() timed already (each truck timed exactly by time_truck)."""
        plan = plan_of(tp)
        sig = plan_signature(plan)
        if not plan or sig in seen:
            return
        timed_of.setdefault(sig, {idx: v for idx, v in tp.items() if v})
        seen.add(sig)
        out.append(Candidate(source, timed_of[sig], score(day, score_pricing, timed_of[sig])))  # type: ignore[arg-type]

    everyone = range(len(day.stops))

    def outranked(plan: TimedPlan) -> bool:
        """The plan leaves a stop out while it carries one of a lower priority (strict priorities)."""
        on = served_of(plan)
        lowest = max((day.stops[k].priority for k in on), default=None)
        return lowest is not None and any(day.stops[k].priority < lowest for k in everyone if k not in on)

    # The closing recovery's time, kept out of the repacks' shares (review solver-pipeline-1).
    closing = min(CLEAN_RECOVER_SEC, CLOSING_SHARE * budget_s) if any(outranked(s.plan) for s in sources) else 0.0

    def share(n: int) -> float:
        # Share what is left fairly with the plans still to come.
        left = budget_s - closing - (time.perf_counter() - t0)
        return min(cap_s, left / max(1, len(order) - n))

    def best_of() -> Candidate | None:
        return min(out, key=lambda c: key(c.score)) if out else None

    def fit(src_name: str, loads: list[Load], opt: dict[int, int], hint: TimedPlan, limit: float, tag: str) -> None:
        nonlocal weak
        fp = fit_pool([tl.stops for v in hint.values() for tl in v] + loads, opt, fit_weights)
        try:
            res = repack(day, goal_pricing, fp, set(), {k: fit_weights[k] for l in fp for k in l}, hint, limit)  # type: ignore[index]
            notes.append(f"{src_name}: {goal} {tag}fit repack {res.status} in {res.seconds:.1f}s")
            weak = weak or not res.status.startswith("OPTIMAL")
            if res.plan is not None:
                add(f"{src_name}+fit:{goal}", res.plan)
            else:
                log.warning("fit repack %s after %.1fs (limit %.1fs) for %s/%s: no fitting plan from these loads",
                            res.status, res.seconds, limit, src_name, goal)
        except Exception as exc:  # noqa: BLE001
            weak = True
            log.warning("fit repack %s/%s failed: %s", src_name, goal, exc)
            notes.append(f"{src_name}: {goal} fit repack failed ({exc})")

    def gain(base: TimedPlan, got: TimedPlan) -> str:
        """The stops a recovery put in, and those it took off for them (swaps), for the notes."""
        put_in, put_out = served_of(got) - served_of(base), served_of(base) - served_of(got)
        return f"+{len(put_in)}" + (f" (-{len(put_out)} of a lower priority in their place)" if put_out else "")

    def recovered(name: str, base: TimedPlan, until: float) -> None:
        missing = [k for k in everyone if k not in served_of(base)]
        if not missing or time.perf_counter() >= until:
            return
        t = time.perf_counter()
        # Swaps on every day (review solver-pipeline-1): a stop that fits nowhere may take the place of
        # stops of a lower priority; recover() keeps only what serves more by strict priority value.
        got = recover(day, score_pricing, base, missing, until, goal, swaps=True)
        notes.append(f"{name}: {goal} recovery {gain(base, got)} of {len(missing)} stop(s) left out in "
                     f"{time.perf_counter() - t:.1f}s")
        if served_of(got) != served_of(base):
            add_timed(f"{name}+recover:{goal}", got)

    breaks = any(break_due(td) for td in day.trucks)
    if time_raw:
        for src in sources:
            add(src.name, plan_of(src.plan))
    # Fewest loads first: fewer, fuller loads leave the most room to share trucks.
    order = sorted(sources, key=lambda s: (sum(len(v) for v in s.plan.values()),
                                           sum(day.metres(tl.stops) for v in s.plan.values() for tl in v)))
    for n, src in enumerate(order):
        loads = [tl.stops for v in src.plan.values() for tl in v]
        carried = {k for l in loads for k in l}
        opt = {k: w for k, w in (optional or {}).items() if k not in carried}
        pool = loads + [(k,) for k in sorted(opt) if (k,) not in set(loads)]
        key_pool = frozenset(pool)
        if key_pool in done_pools:
            continue
        done_pools.add(key_pool)
        limit = share(n)
        if limit < 0.5:
            notes.append(f"{src.name}: no time left for the {goal} repack")
            continue
        raw_ok = timed(plan_of(src.plan)) is not None
        incumbent: TimedPlan | None = None
        if fit_weights and not raw_ok:
            # The search's plan breaks the exact timing: a fully timed incumbent first, in a fraction
            # of this source's time (benchmark F01: the option never keeps only a plan that breaks
            # the rules because the repacks below used the time up).
            repair_day = True
            until = time.perf_counter() + max(0.5, INCUMBENT_SHARE * limit)
            try:
                kept = trim(day, score_pricing, plan_of(src.plan), until)
                incumbent = recover(day, score_pricing, kept, everyone, until, goal)
                notes.append(f"{src.name}: {goal} incumbent keeps {len(served_of(kept))}, recovers to "
                             f"{len(served_of(incumbent))} of {len(day.stops)} stop(s)")
                add_timed(f"{src.name}+recover:{goal}", incumbent)
            except Exception as exc:  # noqa: BLE001 - only this candidate is lost
                log.warning("incumbent %s/%s failed: %s", src.name, goal, exc)
                notes.append(f"{src.name}: {goal} incumbent failed ({exc})")
                incumbent = None
            limit = share(n)
        ok = False
        # With driver breaks the search's own times hold none: hint the plan as time_plan places
        # its breaks (a DEPOT break as the depot interval, a ROAD break as its variant).
        hint = (timed(plan_of(src.plan)) or src.plan) if breaks else src.plan
        try:
            # With driver breaks: the break-free model first (fast); its proposal counts when
            # time_plan can place every break in it. Only when it cannot (a tight day) is the
            # break-aware model solved - speed on slack days, breaks modelled where they bind.
            res = repack(day, goal_pricing, pool, carried, opt, hint, limit, model_breaks=not breaks)
            notes.append(f"{src.name}: {goal} repack {res.status} in {res.seconds:.1f}s")
            if breaks and (res.plan is None or timed(res.plan) is None) and share(n) >= 0.5:
                if res.plan is not None:
                    add(f"{src.name}+repack:{goal}", res.plan)  # recorded as discarded (breaks do not fit)
                res = repack(day, goal_pricing, pool, carried, opt, hint, share(n))
                notes.append(f"{src.name}: {goal} break-aware repack {res.status} in {res.seconds:.1f}s")
            if breaks and res.plan is None and res.status.startswith("INFEASIBLE") and share(n) >= 0.5:
                # CP-SAT's break model is stricter than the LP's: propose without it being a hard rule.
                res = repack(day, goal_pricing, pool, carried, opt, hint, share(n), soft_breaks=True)
                notes.append(f"{src.name}: {goal} repack with soft breaks {res.status} in {res.seconds:.1f}s")
            if res.plan is None:
                # Audit E5: no answer (UNKNOWN, out of time). A repack never makes a plan worse: the
                # plan it started from stays a candidate of this job whenever it times exactly.
                kept_raw = add(src.name, plan_of(src.plan))
                log.warning("repack %s after %.1fs (limit %.1fs) for %s/%s: %s", res.status, res.seconds, limit, src.name, goal,
                            "kept the plan it started from" if kept_raw else
                            "the plan it started from breaks the exact loading time between loads")
            ok = res.plan is not None and add(f"{src.name}+repack:{goal}", res.plan)
        except Exception as exc:  # noqa: BLE001 - a failed repack only loses this candidate
            log.warning("repack %s/%s failed: %s", src.name, goal, exc)
            notes.append(f"{src.name}: {goal} repack failed ({exc})")
        if ok or not fit_weights or raw_ok:
            continue
        # The search's plan breaks the exact turnaround and keeping all its stops is impossible
        # (typically: loads over 80% full on a day without slack, or no room for a driver break). Keep
        # the most priority value that fits instead of returning departure times no truck can make.
        limit = share(n)
        if limit < 0.5:
            notes.append(f"{src.name}: no time left for the {goal} fit repack")
            weak = True
            continue
        fit(src.name, loads, opt, incumbent or hint, limit, "")
    # The job's best plan, with the stops it leaves out inserted where they still fit, or in place of
    # stops of a lower priority (swaps), within the job's budget: on a day whose plans timed cleanly for
    # CLEAN_RECOVER_SEC at most (the time `closing` kept for it when a source left a stop out while it
    # carried a lower priority).
    end = t0 + budget_s
    best = best_of()
    if best is not None:
        now = time.perf_counter()
        until = end if repair_day else min(end, now + CLEAN_RECOVER_SEC)
        if closing:
            # Its `closing` seconds from when it actually starts, also when the repacks ended late, but
            # never more than CLOSING_LATE_SEC past the job's budget (review of the strict-priority fix:
            # under load the recovery's time was gone before it started, and a P3 order stayed out while
            # a P4 order it fits in place of rode).
            until = max(until, min(now + closing, end + CLOSING_LATE_SEC))
        try:
            recovered(best.source, best.plan, until)
        except Exception as exc:  # noqa: BLE001
            log.warning("recovery %s/%s failed: %s", best.source, goal, exc)
            notes.append(f"{best.source}: {goal} recovery failed ({exc})")
    # Benchmark F07: on a repair day whose best plan still leaves stops out (P1-P3 stops, or any when the
    # fit repack proved no bound), use more of the request's time. A day whose plans timed cleanly, or
    # whose repair serves every stop, never gets here.
    def high_left(c: Candidate | None) -> bool:
        return c is None or any(day.stops[k].priority <= 3 for k in everyone if k not in served_of(c.plan))

    best = best_of()
    left_out = best is None or len(served_of(best.plan)) < len(day.stops)
    if repair_day and extra_s > 0 and fit_weights and left_out and (high_left(best) or weak):
        end = t0 + budget_s + extra_s
        notes.append(f"{goal}: repair extended by up to {extra_s:.0f}s (" +
                     ("P1-P3 stops left out" if high_left(best) else "the fit repack proved no bound") + ")")
        step = lambda: min(end, time.perf_counter() + EXTENDED_STEP_MAX_SEC)  # noqa: E731
        try:
            if best is not None:
                # Every insertion of each stop left out, and swaps: a P1-P3 stop may take the place of
                # lower priority ones, which are then inserted again where they fit.
                t = time.perf_counter()
                missing = [k for k in everyone if k not in served_of(best.plan)]
                deep = recover(day, score_pricing, best.plan, missing, step(), goal, tries=None, swaps=True)
                notes.append(f"{best.source}: {goal} deep recovery {gain(best.plan, deep)} "
                             f"of {len(missing)} stop(s) left out in {time.perf_counter() - t:.1f}s")
                add_timed(f"{best.source}+recover:{goal}", deep)
            if fallback and high_left(best_of()):
                t = time.perf_counter()
                built = recover(day, score_pricing, {}, everyone, step(), goal, swaps=True, farthest_first=True)
                notes.append(f"FALLBACK: {goal} constructive plan serves {len(served_of(built))} of {len(day.stops)} "
                             f"stop(s) in {time.perf_counter() - t:.1f}s")
                add_timed(f"FALLBACK:{goal}", built)
            best = best_of()
            if best is not None and high_left(best) and step() - time.perf_counter() >= 1.0:
                src0 = order[0] if order else None
                loads0 = [tl.stops for v in src0.plan.values() for tl in v] if src0 is not None else []
                fit(best.source.split("+")[0], loads0, dict.fromkeys(everyone, 0), best.plan,
                    step() - time.perf_counter(), "extended ")
                best = best_of()
                if best is not None:
                    recovered(best.source, best.plan, step())
        except Exception as exc:  # noqa: BLE001 - the candidates found so far stay
            log.warning("extended repair %s failed: %s", goal, exc)
            notes.append(f"{goal}: extended repair failed ({exc})")
    notes.append(f"{goal}: {LP_STATS['lps'] - lp0['lps']} timing LPs in {LP_STATS['sec'] - lp0['sec']:.2f}s")
    return out, notes
