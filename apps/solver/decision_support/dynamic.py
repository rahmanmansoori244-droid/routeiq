"""Dynamic multi-trip planning: a discrete-event simulator of one delivery day (DESIGN.md section 4).

A ``World`` is the hidden truth of a day: the actual travel and unloading times of every leg and stop
(planned time x a multiplier drawn from ``history.UncertaintyModel``, optionally shaped by the IVMS
time-of-day speeds) and the orders that arrive during the day, each with the minute it becomes known.

The day is played out event by event. Trucks follow their loads; a load that has left the depot is
never changed (the engine cannot re-route a load on the road, and the stock is on the truck). The
dispatcher (the planner) sees an event only when it happens:

- ``LOAD_DEPARTED``: a load leaves; its stops are now fixed;
- ``STOP_COMPLETED``: a stop is done, with its actual arrival and departure (the driver page's taps);
- ``DELAY``: the load's forecast return slipped by more than the threshold (20 min) since it was last
  forecast; the forecast uses only past events and the plan's own times;
- ``NEW_ORDER``: a late order arrives;
- ``DEPOT_RETURN``: a truck is back at the depot.

Information boundary (owner rule: no future information): the simulator keeps the future events in a
private queue and hands the planner a ``PlannerView`` built from past events only. ``build_request``
turns that view into the re-plan request, so a re-plan can depend on nothing else.

A re-plan sends the orders that are not on a committed load, the committed loads as ``FrozenTrip``s
(actual departure, actual return when back, otherwise the forecast return), ``previous_truck_id`` from
the plan it replaces (so ``config.change_penalty_per_stop`` keeps routes stable) and the web's
same-day timing: ``loading_from_min`` = now and ``shift_start_min`` = now + turnaround. A load whose
loading has started (and, by default, every truck's first load, loaded the night before) is committed.

Policies: A static (the morning plan executed as is: it never serves an order revealed later and never
retries a stop the morning plan left out), B re-plan at each depot return, C event-triggered (depot
return, delay over the threshold, new order).

Money is cash only: each executed day is re-costed with ``costing.truck_day_costs`` on the actual
times and the plan's estimated km (HAVERSINE). Late stops are still delivered and counted; nothing is
relaxed. Late means after the genuine closing time (World.closing_min): the window as sent, except a
window labelled SALES_PREFERENCE, measured against the customer's genuine hours (a missed preference is
counted apart); by more than LATE_TOLERANCE_MIN, the plan's own whole-minute resolution. Solver
penalties are not reported here.
"""
from __future__ import annotations

import argparse
import heapq
import itertools
import json
import math
import random
import sys
import time
from dataclasses import asdict, dataclass, field, fields
from pathlib import Path
from typing import Callable, Mapping, NamedTuple, Sequence

import costing
from dispatch_models import DispatchRequest, DispatchResponse, DispatchScenario, DispatchStop, FrozenTrip
from providers import HaversineProvider

from . import core, ivms
from .history import MULTIPLIER_BOUNDS, UncertaintyModel
from .synth import AREAS, SALES_PREFERENCE, make_day

__all__ = ["LOAD_DEPARTED", "STOP_COMPLETED", "DELAY", "NEW_ORDER", "DEPOT_RETURN", "EVENT_KINDS", "Event",
           "NewOrder", "World", "Policy", "STATIC", "AT_RETURN", "EVENTS", "POLICIES", "Settings", "PlanLoad",
           "Visit", "LoadView", "PlannerView", "build_request", "Morning", "morning_plan", "engine", "Replan",
           "ExecutedLoad", "Outcome", "SimResult", "simulate", "compare", "format_report", "synthetic_case",
           "synthetic_windows", "ivms_band_factors", "DataNeed", "data_requirements", "main", "LATE_TOLERANCE_MIN"]

LOAD_DEPARTED, STOP_COMPLETED, DELAY, NEW_ORDER, DEPOT_RETURN = (
    "LOAD_DEPARTED", "STOP_COMPLETED", "DELAY", "NEW_ORDER", "DEPOT_RETURN")
EVENT_KINDS = (LOAD_DEPARTED, STOP_COMPLETED, DELAY, NEW_ORDER, DEPOT_RETURN)
# Events at the same minute are handled in this order (a stop before the truck's return, both before a
# new order), then by truck and arrival order.
_RANK = {STOP_COMPLETED: 0, DEPOT_RETURN: 1, NEW_ORDER: 2}
DEPOT = "depot"  # the depot's node id in legs
INF = float("inf")
# A visit counts as late only beyond this: the plan's times are whole minutes (a departure rounded by up to half
# a minute shifts every replayed stop of the load), so a stop planned exactly at its closing is not "late" by 0.5.
LATE_TOLERANCE_MIN = 0.5


@dataclass(frozen=True)
class Event:
    """Something the dispatcher sees happen, at minute ``at`` of the day (actual time)."""

    at: float
    kind: str
    truck_id: str | None = None
    load_no: int | None = None
    stop_id: str | None = None
    info: dict = field(default_factory=dict)


@dataclass(frozen=True)
class NewOrder:
    """An order the dispatcher learns about only at ``reveal_min``. Its stop is sent with late=True, as
    the web marks an order that arrives after the plan."""

    stop: DispatchStop
    reveal_min: int


def _band(minute: float) -> str:
    """The IVMS time-of-day band (ivms.BANDS) of a minute of the day."""
    hour = int(minute // 60) % 24
    for name, lo, hi in ivms.BANDS:
        if (lo <= hour < hi) if lo < hi else (hour >= lo or hour < hi):
            return name
    raise ValueError(minute)


def ivms_band_factors(agg: dict | None = None, region: str | None = "Muscat") -> dict[str, float] | None:
    """Time-of-day travel factors from the IVMS report (DESIGN.md 1.4): a leg's drive time is multiplied
    by the factor of the band it starts in. Per band, the median speed of MOVING segments (of ``region``;
    with None, the 5 km+ segments of every region). factor = reference speed / band speed, where the
    reference is the segment-weighted geometric mean over the bands, so the factors shape the day (a
    slower midday, a faster early morning) and leave the overall level to the UncertaintyModel. A band
    with fewer than ivms.MIN_TIER_N segments gets 1.0. None when the aggregates hold no speeds.
    Note: the model's travel sigma (IVMS speeds across roads and hours) already holds part of this
    variation, so using both overstates the spread a little; that sigma is an upper bound anyway."""
    agg = ivms.load() if agg is None else agg
    speeds = ((agg.get("ivms_raw") or {}).get("travel_speed_kmh") or {})
    bands = (speeds.get("by_region_band") or {}).get(region) if region else speeds.get("by_band_5km_plus")
    usable = {b: p for b, p in (bands or {}).items() if p.get("n", 0) >= ivms.MIN_TIER_N and p.get("p50")}
    if not usable:
        return None
    n = sum(p["n"] for p in usable.values())
    ref = math.exp(sum(p["n"] * math.log(p["p50"]) for p in usable.values()) / n)
    return {b: round(ref / usable[b]["p50"], 3) if b in usable else 1.0 for b, _, _ in ivms.BANDS}


class World:
    """The hidden truth of one simulated day, reproducible for ``seed``: per leg a travel multiplier and
    per stop an unloading multiplier (``model.draw(seed, key)``, independent of the order they are read
    in), times the IVMS band factor of the leg's start when ``band_factors`` is given; and the new orders
    with their reveal times. ``overrides`` fixes chosen multipliers ("travel:<from>><to>" or
    "unload:<stop_id>"), for tests. ``window_provenance`` and ``genuine_hours`` (per stop id, e.g.
    synthetic_windows) say which windows are genuine closing times (closing_min); without them every window
    as sent counts as genuine (UNKNOWN, as on a real day). Only the simulator's road (a load leaving the
    depot) reads the truth; the planner gets a PlannerView."""

    def __init__(self, request: DispatchRequest, seed: int, model: UncertaintyModel | None = None,
                 new_orders: Sequence[NewOrder] = (), *, overrides: Mapping[str, float] | None = None,
                 band_factors: Mapping[str, float] | None = None, window_provenance: Mapping[str, str] | None = None,
                 genuine_hours: Mapping[str, tuple[int, int]] | None = None) -> None:
        known = {s.stop_id for s in request.stops}
        new_ids = [o.stop.stop_id for o in new_orders]
        if len(set(new_ids)) != len(new_ids) or known & set(new_ids):
            raise ValueError("a new order's stop id repeats a stop of the day")
        if any(t.frozen_trips for t in request.trucks):
            raise ValueError("the simulated day starts with no frozen loads")
        self.request = request
        self.seed = seed
        self.model = model or UncertaintyModel.defaults()
        self.band_factors = dict(band_factors) if band_factors else None
        self._new = tuple(sorted(new_orders, key=lambda o: (o.reveal_min, o.stop.stop_id)))
        self._overrides = dict(overrides or {})
        self.window_provenance = dict(window_provenance or {})
        self.genuine_hours = dict(genuine_hours or {})

    def describe(self) -> dict:
        """The world's model, for reports (no draws, no new-order details)."""
        return {"seed": self.seed, "model": asdict(self.model), "band_factors": self.band_factors,
                "new_orders": len(self._new),
                "windows": "provenance labels given: SALES_PREFERENCE windows are measured against the genuine hours"
                           if self.window_provenance else "no labels: every window as sent counts as genuine (UNKNOWN)"}

    def closing_min(self, s: DispatchStop) -> int | None:
        """The genuine closing time a visit is late against: the window's end as sent, except a window labelled
        SALES_PREFERENCE (a salesman's request), whose genuine closing is the end of the customer's genuine hours
        (None when they are not known)."""
        if self.window_provenance.get(s.stop_id) != SALES_PREFERENCE:
            return s.hard_end_min
        g = self.genuine_hours.get(s.stop_id)
        return g[1] if g else None

    def _travel(self, a: str, b: str, at_min: float) -> float:
        key = f"travel:{a}>{b}"
        if key in self._overrides:
            return self._overrides[key]
        m = self.model.draw(self.seed, key).travel
        if self.band_factors:
            m = min(max(m * self.band_factors.get(_band(at_min), 1.0), MULTIPLIER_BOUNDS[0]), MULTIPLIER_BOUNDS[1])
        return m

    def _unload(self, stop_id: str) -> float:
        key = f"unload:{stop_id}"
        if key in self._overrides:
            return self._overrides[key]
        return self.model.draw(self.seed, key).unload


@dataclass(frozen=True)
class Policy:
    """When the dispatcher re-plans: on any event whose kind is in ``triggers`` (none: never)."""

    name: str
    label: str
    triggers: frozenset[str]


STATIC = Policy("A", "static: the morning plan, executed as is (never serves an order revealed later, never "
                     "retries a stop the morning plan left out)", frozenset())
AT_RETURN = Policy("B", "re-plan at each depot return", frozenset({DEPOT_RETURN}))
EVENTS = Policy("C", "event-triggered: depot return, delay over the threshold, new order",
                frozenset({DEPOT_RETURN, DELAY, NEW_ORDER}))
POLICIES = (STATIC, AT_RETURN, EVENTS)


@dataclass(frozen=True)
class Settings:
    """How the day is run. ``preloaded_first_loads``: every truck's first load of the morning plan is
    loaded the night before (NMWC practice), so it is committed from the start. ``change_penalty_per_stop``
    None keeps the request's own value (the engine's default 3 OMR-equivalent, ARTIFICIAL)."""

    delay_threshold_min: float = 20.0
    preloaded_first_loads: bool = True
    change_penalty_per_stop: float | None = None
    solver_seed: int = 1
    morning_at_min: int | None = None  # None: shift start - reload (07:00 on the synthetic days)


class _Break(NamedTuple):
    where: str  # DEPOT (before the load leaves) or ROAD
    after: int | None  # ROAD: after this many stops (0 = on the way to stop 1)
    start: int  # planned start, minute of the day
    length: int


@dataclass(frozen=True)
class PlanLoad:
    """One planned load: its stops in order and the plan's own times (minutes of the day)."""

    truck_id: str
    load_no: int
    stops: tuple[str, ...]
    depart_min: int
    return_min: int
    cases: int
    pallet_units: int | None
    km: float  # estimated km
    brk: _Break | None = None


def _plan_loads(sc: DispatchScenario) -> dict[str, list[PlanLoad]]:
    """The scenario's (new) loads per truck, in load order."""
    out: dict[str, list[PlanLoad]] = {}
    for ld in sorted(sc.loads, key=lambda l: (l.truck_id, l.load_no)):
        b = ld.driver_break
        brk = _Break(b.where, b.after_sequence, b.start_min, b.end_min - b.start_min) if b is not None else None
        out.setdefault(ld.truck_id, []).append(PlanLoad(
            truck_id=ld.truck_id, load_no=ld.load_no, stops=tuple(st.stop_id for st in ld.stops),
            depart_min=ld.depart_min, return_min=ld.return_min, cases=ld.cases, pallet_units=ld.pallet_units,
            km=ld.distance_km, brk=brk))
    return out


class Visit(NamedTuple):
    """One delivered stop: actual minutes, and the minutes after its genuine closing time (0 = on time)."""

    stop_id: str
    arrival: float
    service_start: float
    departure: float
    late_min: float


class _Run(NamedTuple):
    visits: tuple[Visit, ...]
    break_start: float | None  # a ROAD break taken on the way
    ret: float


class _Legs:
    """The planned legs: the engine's HAVERSINE estimate (straight line x multiplier at avg_speed_kmh),
    the same numbers its matrix holds, so the plan's own times are reproduced exactly."""

    def __init__(self, req: DispatchRequest) -> None:
        cfg = req.config
        self._p = HaversineProvider(cfg.haversine_multiplier, cfg.avg_speed_kmh)
        self._xy = {DEPOT: (req.depot.lat, req.depot.lng)}
        for s in req.stops:
            self.add(s)

    def add(self, s: DispatchStop) -> None:
        self._xy[s.stop_id] = (s.lat, s.lng)

    def minutes(self, a: str, b: str) -> float:
        return self._p.leg(self._xy[a], self._xy[b])[1] / 60.0 if a != b else 0.0


def _after(close: int | None, start: float, end: float, rule: str) -> float:
    """Minutes a visit starts (START rule) or finishes (FINISH) after ``close``; 0 without one."""
    return 0.0 if close is None else max(0.0, (end if rule == "FINISH" else start) - close)


def _late_min(s: DispatchStop, start: float, end: float, rule: str) -> float:
    """Minutes after the window as sent."""
    return _after(s.hard_end_min, start, end, rule)


def _break_kept(cfg, loads: Sequence[tuple[float, float]], taken: Sequence[float | None]) -> str:
    """The driver break of one executed truck day (config.break_*, the engine's rule): NOT_NEEDED (no
    rule, first departure at the window start or later, or back for good by its end), OK (a break taken
    by the window end, or a depot gap between loads that holds it), LATE (taken after the window) or
    MISSING. ``loads``: (departure, return) in time order; ``taken``: the break start of each load."""
    if cfg.break_min <= 0 or cfg.break_start_from_min > cfg.break_start_to_min:
        return "NOT_NEEDED"
    length, lo, hi = cfg.break_min, cfg.break_start_from_min, cfg.break_start_to_min
    if loads[0][0] >= lo or loads[-1][1] <= hi:
        return "NOT_NEEDED"
    starts = [b for b in taken if b is not None]
    if starts:
        return "OK" if min(starts) <= hi else "LATE"
    for (_, back), (leave, _) in zip(loads, loads[1:]):
        if max(lo, back) <= hi and max(lo, back) + length <= leave:
            return "OK"
    return "MISSING"


def _one(*_args) -> float:
    return 1.0


def _drive(pl: PlanLoad, t: float, *, stops: Mapping[str, DispatchStop], legs: _Legs, rule: str,
           travel: Callable[[str, str, float], float] = _one, unload: Callable[[str], float] = _one,
           done: int = 0, node: str = DEPOT, not_before: float | None = None) -> _Run:
    """The rest of load ``pl`` after its first ``done`` stops, leaving ``node`` at minute ``t``: drive
    (planned leg x travel(a, b, start)), wait for the window to open, unload (service_min x unload(stop)),
    then back to the depot. A ROAD break is taken on the leg the plan put it on, as the engine times it
    (dispatch_solver's output, load_repack's timing): it starts at its planned start or when the truck leaves,
    whichever is later. Started before the truck arrives, it is taken on the way and the truck arrives that
    much later; otherwise the truck arrives first and rests there (the break overlaps any wait) before it
    unloads, or before it is back at the depot. With the default multipliers of 1 this is the plan's own times
    (the planner's forecast). With ``not_before`` (a forecast made at that minute) the next step ends no
    earlier: it has not been reported yet."""
    visits: list[Visit] = []
    brk_start = None
    b = pl.brk
    for i in range(done, len(pl.stops) + 1):
        nxt = pl.stops[i] if i < len(pl.stops) else DEPOT
        arrival = t + legs.minutes(node, nxt) * travel(node, nxt, t)
        ready = arrival
        if b is not None and b.where == "ROAD" and b.after == i:
            brk_start = max(float(b.start), t)
            if brk_start < arrival:  # on the way: the truck arrives after the break
                arrival = ready = arrival + b.length
            else:  # it arrived first and rests there
                ready = brk_start + b.length
        if nxt == DEPOT:
            return _Run(tuple(visits), brk_start, max(ready, not_before) if not_before is not None and i == done else ready)
        s = stops[nxt]
        start = max(ready, float(s.hard_start_min or 0))
        end = start + s.service_min * unload(nxt)
        if not_before is not None and i == done:
            end = max(end, not_before)
        visits.append(Visit(nxt, arrival, start, end, _late_min(s, start, end, rule)))
        node, t = nxt, end
    raise AssertionError("unreachable")


@dataclass(frozen=True)
class LoadView:
    """A committed load as the dispatcher knows it: LOADING (loading started, not left), ON_ROAD or DONE.
    ``depart`` / ``ret`` are actual when observed, otherwise forecasts (the plan's own times from the
    last event)."""

    truck_id: str
    load_no: int
    stops: tuple[str, ...]
    status: str
    depart: float
    ret: float
    returned: bool
    completed: tuple[str, ...]
    cases: int
    pallet_units: int | None
    break_start: float | None
    break_min: int | None


@dataclass(frozen=True)
class PlannerView:
    """Everything the dispatcher knows at ``now``: the past events, the committed loads per truck, the
    orders not on a committed load (known in the morning or revealed since) and, per stop, its truck in
    the plan being replaced."""

    now: float
    events: tuple[Event, ...]
    committed: Mapping[str, tuple[LoadView, ...]]
    pending: tuple[DispatchStop, ...]
    previous_truck: Mapping[str, str]


def build_request(base: DispatchRequest, view: PlannerView, *, change_penalty_per_stop: float | None = None
                  ) -> DispatchRequest:
    """The re-plan request at view.now, from the view alone (the web's same-day plan, plan-from.ts
    sameDayTiming): the pending orders with previous_truck_id, each truck's committed loads as FrozenTrips
    (departure rounded down, return up, so the engine's next load leaves after the actual or forecast
    return + turnaround), loading_from_min = now and shift_start_min = now + reload_min."""
    cfg = base.config
    now = int(math.ceil(view.now))
    upd: dict = {"loading_from_min": now, "shift_start_min": max(cfg.shift_start_min, now + cfg.reload_min)}
    if change_penalty_per_stop is not None:
        upd["change_penalty_per_stop"] = change_penalty_per_stop
    trucks = []
    for t in base.trucks:
        frozen = [FrozenTrip(load_no=i, depart_min=int(math.floor(lv.depart)), return_min=int(math.ceil(lv.ret)),
                             cases=lv.cases, pallet_units=lv.pallet_units,
                             break_start_min=int(math.floor(lv.break_start)) if lv.break_start is not None else None,
                             break_min=lv.break_min if lv.break_start is not None else None)
                  for i, lv in enumerate(view.committed.get(t.id, ()), start=1)]
        trucks.append(t.model_copy(update={"frozen_trips": frozen}))
    stops = [s.model_copy(update={"previous_truck_id": view.previous_truck.get(s.stop_id)}) for s in view.pending]
    return base.model_copy(update={"trucks": trucks, "stops": stops, "config": cfg.model_copy(update=upd)}, deep=True)


def _recommended(resp: DispatchResponse) -> DispatchScenario:
    return next(sc for sc in resp.scenarios if sc.name == "RECOMMENDED")


Solver = Callable[[DispatchRequest], "core.RunResult"]


def engine(budget: core.Budget, seed: int = 1) -> Solver:
    """The dispatch engine as a planner: core.solve with ``budget`` (offline, RECOMMENDED only) and
    solver seed ``seed`` for every plan of the day."""
    run_budget = core.Budget(time_limit_sec=budget.time_limit_sec, search_mode=budget.search_mode, seeds=(seed,))
    return lambda req: core.solve(req, run_budget, seed)


@dataclass
class Morning:
    """The morning plan of the known orders, made once and shared by every policy and world."""

    digest: str  # of the request as given
    scenario: DispatchScenario
    metrics: core.Metrics
    wall_sec: float


def morning_plan(request: DispatchRequest, budget: core.Budget, *, seed: int = 1) -> Morning:
    """Plan the known orders (a plan for the day: no loading_from_min, first loads loaded before the shift)."""
    rr = engine(budget, seed)(request)
    return Morning(digest=core.digest(request), scenario=_recommended(rr.response), metrics=rr.metrics,
                   wall_sec=rr.wall_sec)


@dataclass
class Replan:
    """One re-plan: when, why, the exact request (built from the PlannerView), and how much moved
    against the plan it replaced: ``moved`` = stops on another (truck, load number), ``truck_changes`` =
    stops on another truck, ``dropped`` = planned before and not now, ``added`` = the reverse."""

    at: float
    triggers: tuple[str, ...]
    request: DispatchRequest
    status: str
    feasibility: str
    solver_sec: float
    stops_sent: int
    moved: int
    truck_changes: int
    dropped: int
    added: int


@dataclass(frozen=True)
class ExecutedLoad:
    truck_id: str
    load_no: int
    stops: tuple[str, ...]
    depart: float
    ret: float
    km: float
    visits: tuple[Visit, ...]


@dataclass
class Outcome:
    """One policy on one world. Cash is the executed day re-costed (costing.truck_day_costs on actual
    times and estimated km); late figures are against the genuine closing times (World.closing_min) and
    limits, beyond LATE_TOLERANCE_MIN."""

    policy: str
    world: int
    stops_total: int  # known in the morning + new orders revealed
    new_orders: int
    served: int
    served_known: int  # stops known in the morning that were served
    served_new: int  # new orders served (policy A never serves one)
    unserved: int
    unserved_by_priority: dict[int, int]
    cases_served: int
    cash_per_case: float  # cash OMR per case served
    late_stops: int  # visits after the genuine closing time
    late_min: float
    pref_late_stops: int  # visits after a SALES_PREFERENCE window as sent, inside the genuine hours (not late)
    late_returns: int  # back after the latest return / depot closing / the truck's hours
    late_return_min: float
    late_breaks: int  # truck days whose driver break started after its window
    missing_breaks: int  # truck days that needed a break and had none (delays pushed it out of the plan)
    trucks_used: int
    loads: int
    km: float  # estimated km
    cash: core.CashBreakdown
    paid_driver_min: int
    overtime_min: int
    replans: int  # re-plans that searched (the engine had something it could plan)
    replans_skipped: int  # triggered with nothing it could plan: no pending order, or only unservable ones (NOTHING_TO_PLAN)
    replans_failed: int  # NO_SOLUTION or a plan the independent check marked VIOLATED
    stops_moved: int  # moves over all re-plans: a stop moved twice counts twice
    stops_moved_distinct: int  # stops moved at least once
    truck_changes: int
    dropped_from_plan: int
    solver_sec: float

    def flat(self) -> dict[str, float]:
        """The numeric figures as one flat dict ("cash.total", "unserved_by_priority.3", ...)."""
        out: dict[str, float] = {}
        for key, value in asdict(self).items():
            if isinstance(value, dict):
                for sub, v in value.items():
                    out[f"{key}.{sub}"] = float(v)
            elif isinstance(value, (int, float)) and not isinstance(value, bool) and key != "world":
                out[key] = float(value)
        return out


@dataclass
class SimResult:
    outcome: Outcome
    events: tuple[Event, ...]
    replans: tuple[Replan, ...]
    loads: tuple[ExecutedLoad, ...]


@dataclass
class _Load:
    plan: PlanLoad
    status: str = "LOADING"  # LOADING -> ON_ROAD -> DONE
    depart: float | None = None
    break_start: float | None = None  # a DEPOT break, known when the load leaves
    visits: list[Visit] = field(default_factory=list)
    ret: float | None = None
    ref_return: float = 0.0  # the last forecast return: a DELAY is a slip beyond it


class _Day:
    """One policy on one world. The future events of loads on the road and the new orders sit in
    ``_future`` (private); everything the planner uses comes from ``view()``."""

    def __init__(self, world: World, policy: Policy, morning: Morning, settings: Settings, solver: Solver | None):
        self.w, self.policy, self.settings, self.solver = world, policy, settings, solver
        self.base = world.request
        self.cfg = self.base.config
        self.legs = _Legs(self.base)
        self.stops = {s.stop_id: s for s in self.base.stops}
        self.new_ids: set[str] = set()
        self.truck_ids = [t.id for t in self.base.trucks]
        self.loads: dict[str, list[_Load]] = {tid: [] for tid in self.truck_ids}
        self.plan: dict[str, list[PlanLoad]] = _plan_loads(morning.scenario)
        self.pending: set[str] = set(self.stops)
        self.past: list[Event] = []
        self.replans: list[Replan] = []
        self.skipped = 0
        self.moved_ids: set[str] = set()
        self._future: list[tuple] = []
        self._truth: dict[tuple[str, int], _Run] = {}
        self._seq = itertools.count()
        self.now = float(settings.morning_at_min if settings.morning_at_min is not None
                         else self.cfg.shift_start_min - self.cfg.reload_min)
        for o in world._new:
            if o.reveal_min <= self.now:
                raise ValueError(f"new order {o.stop.stop_id} is revealed before the morning plan")
            self._push(Event(float(o.reveal_min), NEW_ORDER, stop_id=o.stop.stop_id,
                             info={"priority": o.stop.priority, "cases": o.stop.demand_cases}), o.stop)
        if settings.preloaded_first_loads:
            for tid in self.truck_ids:
                if self.plan.get(tid):
                    self._commit(tid)

    # --- the hidden queue -------------------------------------------------------------------------
    def _push(self, ev: Event, payload=None) -> None:
        tie = self.truck_ids.index(ev.truck_id) if ev.truck_id else -1
        heapq.heappush(self._future, (ev.at, _RANK[ev.kind], tie, next(self._seq), ev, payload))

    # --- what the planner knows -------------------------------------------------------------------
    def _turn(self, pl: PlanLoad) -> float:
        return self.cfg.reload_min + self.cfg.loading_min_per_case * pl.cases

    def _departure(self, tid: str, pl: PlanLoad) -> tuple[float, float | None]:
        """When ``pl`` leaves (and its DEPOT break starts): its planned time, or later when the truck came
        back late (return + turnaround, break)."""
        done = [ld for ld in self.loads[tid] if ld.status == "DONE"]
        last = done[-1].ret if done else None
        dep = float(pl.depart_min) if last is None else max(float(pl.depart_min), last + self._turn(pl))
        bs = None
        if pl.brk is not None and pl.brk.where == "DEPOT":
            bs = float(pl.brk.start) if last is None else max(float(pl.brk.start), last)
            dep = max(dep, bs + pl.brk.length)
        return dep, bs

    def _forecast(self, ld: _Load) -> _Run:
        """The rest of a committed load on the plan's own times from its last event (never the truth)."""
        kw = dict(stops=self.stops, legs=self.legs, rule=self.cfg.window_rule)
        if ld.status == "LOADING":
            return _drive(ld.plan, self._departure(ld.plan.truck_id, ld.plan)[0], **kw)
        k = len(ld.visits)
        t, node = (ld.visits[-1].departure, ld.visits[-1].stop_id) if k else (ld.depart, DEPOT)
        return _drive(ld.plan, t, done=k, node=node, not_before=self.now, **kw)

    def _load_view(self, ld: _Load) -> LoadView:
        pl, b = ld.plan, ld.plan.brk
        if ld.status == "DONE":
            dep, ret, brk = ld.depart, ld.ret, None
        else:
            fc = self._forecast(ld)
            dep = ld.depart if ld.status == "ON_ROAD" else self._departure(pl.truck_id, pl)[0]
            ret, brk = fc.ret, fc.break_start
        if b is not None and b.where == "DEPOT":
            brk = ld.break_start if ld.break_start is not None else self._departure(pl.truck_id, pl)[1]
        elif b is not None and brk is None:  # a ROAD break already behind: after its stop's departure
            before = ld.visits[b.after - 1].departure if 0 < b.after <= len(ld.visits) else ld.depart
            brk = max(float(b.start), before or float(b.start))
        return LoadView(truck_id=pl.truck_id, load_no=pl.load_no, stops=pl.stops, status=ld.status, depart=dep,
                        ret=ret, returned=ld.status == "DONE", completed=tuple(v.stop_id for v in ld.visits),
                        cases=pl.cases, pallet_units=pl.pallet_units, break_start=brk,
                        break_min=b.length if b is not None else None)

    def view(self) -> PlannerView:
        committed = {tid: tuple(self._load_view(ld) for ld in lds) for tid, lds in self.loads.items() if lds}
        previous = {s: tid for tid, pls in self.plan.items() for pl in pls for s in pl.stops}
        return PlannerView(now=self.now, events=tuple(self.past), committed=committed,
                           pending=tuple(self.stops[s] for s in sorted(self.pending)), previous_truck=previous)

    # --- loads ------------------------------------------------------------------------------------
    def _commit(self, tid: str) -> _Load:
        pl = self.plan[tid].pop(0)
        ld = _Load(plan=pl)
        self.loads[tid].append(ld)
        self.pending -= set(pl.stops)
        return ld

    def _next_departure(self) -> tuple[float, str | None]:
        best: tuple[float, str | None] = (INF, None)
        for tid in self.truck_ids:
            lds = self.loads[tid]
            if lds and lds[-1].status == "ON_ROAD":
                continue
            pl = lds[-1].plan if lds and lds[-1].status == "LOADING" else (self.plan.get(tid) or [None])[0]
            if pl is not None:
                best = min(best, (self._departure(tid, pl)[0], tid), key=lambda x: x[0])
        return best

    def _depart(self, tid: str) -> None:
        lds = self.loads[tid]
        ld = lds[-1] if lds and lds[-1].status == "LOADING" else self._commit(tid)
        dep, bs = self._departure(tid, ld.plan)
        ld.status, ld.depart, ld.break_start = "ON_ROAD", max(dep, self.now), bs
        # The road: the actual times of this load, now fixed. Its events are queued, unseen until due.
        run = _drive(ld.plan, ld.depart, stops=self.stops, legs=self.legs, rule=self.cfg.window_rule,
                     travel=self.w._travel, unload=self.w._unload)
        self._truth[(tid, ld.plan.load_no)] = run
        for v in run.visits:
            self._push(Event(v.departure, STOP_COMPLETED, tid, ld.plan.load_no, v.stop_id,
                             info={"arrival": v.arrival, "service_start": v.service_start, "late_min": v.late_min}))
        self._push(Event(run.ret, DEPOT_RETURN, tid, ld.plan.load_no))
        ld.ref_return = self._forecast(ld).ret
        self.past.append(Event(ld.depart, LOAD_DEPARTED, tid, ld.plan.load_no, info={"stops": ld.plan.stops}))

    def _load(self, tid: str, load_no: int) -> _Load:
        return next(ld for ld in self.loads[tid] if ld.plan.load_no == load_no)

    # --- events -----------------------------------------------------------------------------------
    def _observe(self, ev: Event, payload) -> list[Event]:
        out = [ev]
        if ev.kind == NEW_ORDER:
            self.stops[ev.stop_id] = payload
            self.legs.add(payload)
            self.new_ids.add(ev.stop_id)
            self.pending.add(ev.stop_id)
        elif ev.kind == STOP_COMPLETED:
            ld = self._load(ev.truck_id, ev.load_no)
            i = ev.info
            ld.visits.append(Visit(ev.stop_id, i["arrival"], i["service_start"], ev.at, i["late_min"]))
            fc = self._forecast(ld).ret
            if fc - ld.ref_return > self.settings.delay_threshold_min:
                out.append(Event(ev.at, DELAY, ev.truck_id, ev.load_no, ev.stop_id,
                                 info={"slip_min": round(fc - ld.ref_return, 2), "forecast_return": round(fc, 2)}))
                ld.ref_return = fc
        elif ev.kind == DEPOT_RETURN:
            ld = self._load(ev.truck_id, ev.load_no)
            ld.ret, ld.status = ev.at, "DONE"
        self.past.extend(out)
        return out

    # --- re-planning ------------------------------------------------------------------------------
    def _freeze_loading(self) -> None:
        """Commit each truck's next load whose loading has already started (the truck is at the depot
        and its departure is less than a turnaround away): it is being loaded, as a LOADING load."""
        for tid in self.truck_ids:
            lds = self.loads[tid]
            if not self.plan.get(tid) or (lds and lds[-1].status != "DONE"):
                continue
            pl = self.plan[tid][0]
            last = lds[-1].ret if lds else -INF
            if max(self._departure(tid, pl)[0] - self._turn(pl), last) < self.now:
                self._commit(tid)

    def _replan(self, triggers: tuple[str, ...]) -> None:
        self._freeze_loading()
        if not self.pending:
            self.skipped += 1
            return
        old = {s: (tid, pl.load_no) for tid, pls in self.plan.items() for pl in pls for s in pl.stops}
        req = build_request(self.base, self.view(), change_penalty_per_stop=self.settings.change_penalty_per_stop)
        rr = self.solver(req)
        sc = _recommended(rr.response)
        feas = sc.feasibility.status if sc.feasibility is not None else "UNVERIFIED"
        if sc.status != "NO_SOLUTION":
            self.plan = _plan_loads(sc)
        new = {s: (tid, pl.load_no) for tid, pls in self.plan.items() for pl in pls for s in pl.stops}
        both = old.keys() & new.keys()
        moved = {s for s in both if old[s] != new[s]}
        self.moved_ids |= moved
        self.replans.append(Replan(
            at=self.now, triggers=triggers, request=req, status=sc.status, feasibility=feas, solver_sec=rr.wall_sec,
            stops_sent=len(req.stops), moved=len(moved),
            truck_changes=sum(1 for s in both if old[s][0] != new[s][0]),
            dropped=len(old.keys() - new.keys()), added=len(new.keys() - old.keys())))

    # --- the day ----------------------------------------------------------------------------------
    def run(self) -> SimResult:
        while True:
            t_dep, _ = self._next_departure()
            t_evt = self._future[0][0] if self._future else INF
            t = min(t_dep, t_evt)
            if t == INF:
                break
            self.now = max(self.now, t)
            batch: list[Event] = []
            while self._future and self._future[0][0] <= self.now:
                *_, ev, payload = heapq.heappop(self._future)
                batch += self._observe(ev, payload)
            kinds = tuple(sorted({e.kind for e in batch} & self.policy.triggers))
            if kinds:
                self._replan(kinds)
            while True:
                t_dep, tid = self._next_departure()
                if tid is None or t_dep > self.now:
                    break
                self._depart(tid)
        return SimResult(outcome=self._outcome(), events=tuple(self.past), replans=tuple(self.replans),
                         loads=tuple(ExecutedLoad(ld.plan.truck_id, ld.plan.load_no, ld.plan.stops, ld.depart, ld.ret,
                                                  ld.plan.km, tuple(ld.visits))
                                     for tid in self.truck_ids for ld in self.loads[tid]))

    def _outcome(self) -> Outcome:
        cfg = self.cfg
        done = [(tid, ld) for tid in self.truck_ids for ld in self.loads[tid]]
        visits = [v for _, ld in done for v in ld.visits]
        served = {v.stop_id for v in visits}
        unserved_p = {p: 0 for p in range(1, 6)}
        for sid in self.pending:
            unserved_p[self.stops[sid].priority] += 1
        rates = costing.DayRates.from_config(cfg)
        parts = dict(fixed=0.0, trip=0.0, distance=0.0, fuel=0.0, driver=0.0, overtime=0.0)
        paid_s = overtime_s = 0
        late_returns, late_return_min = 0, 0.0
        breaks = {"LATE": 0, "MISSING": 0}
        close = self.base.depot.close_min or 1440
        for t in self.base.trucks:
            mine = [ld for tid, ld in done if tid == t.id]
            if not mine:
                continue
            day = costing.truck_day_costs(costing.TruckRates.from_truck(t), rates,
                                          [costing.LoadTiming(round(ld.depart * 60), round(ld.ret * 60), ld.plan.km)
                                           for ld in mine])
            for k in parts:
                parts[k] += day.sum(k)
            paid_s += sum(l.paid_s for l in day.loads)
            overtime_s += sum(l.overtime_s for l in day.loads)
            limit = min(cfg.latest_return_min or INF, close, t.available_to_min or INF)
            for ld in mine:
                if ld.ret > limit:
                    late_returns += 1
                    late_return_min += ld.ret - limit
            taken = [ld.break_start if ld.break_start is not None else self._truth[(t.id, ld.plan.load_no)].break_start
                     for ld in mine]
            kept = _break_kept(cfg, [(ld.depart, ld.ret) for ld in mine], taken)
            if kept in breaks:
                breaks[kept] += 1
        cash = core.CashBreakdown(**{k: round(v, 3) for k, v in parts.items()}, total=round(sum(parts.values()), 3))
        genuine = [_after(self.w.closing_min(self.stops[v.stop_id]), v.service_start, v.departure, cfg.window_rule)
                   for v in visits]
        late = [m for m in genuine if m > LATE_TOLERANCE_MIN]
        cases = sum(self.stops[s].demand_cases for s in served)
        searched = [r for r in self.replans if r.status != "NOTHING_TO_PLAN"]
        return Outcome(
            policy=self.policy.name, world=self.w.seed, stops_total=len(self.stops), new_orders=len(self.new_ids),
            served=len(served), served_known=len(served - self.new_ids), served_new=len(served & self.new_ids),
            unserved=len(self.pending), unserved_by_priority=unserved_p, cases_served=cases,
            cash_per_case=round(cash.total / cases, 4) if cases else 0.0,
            late_stops=len(late), late_min=round(sum(late), 1),
            pref_late_stops=sum(1 for v, m in zip(visits, genuine) if m <= LATE_TOLERANCE_MIN < v.late_min),
            late_returns=late_returns, late_return_min=round(late_return_min, 1), late_breaks=breaks["LATE"],
            missing_breaks=breaks["MISSING"],
            trucks_used=sum(1 for tid in self.truck_ids if self.loads[tid]), loads=len(done),
            km=round(sum(ld.plan.km for _, ld in done), 2), cash=cash, paid_driver_min=round(paid_s / 60),
            overtime_min=round(overtime_s / 60), replans=len(searched),
            replans_skipped=self.skipped + len(self.replans) - len(searched),
            replans_failed=sum(1 for r in self.replans if r.status == "NO_SOLUTION" or r.feasibility == "VIOLATED"),
            stops_moved=sum(r.moved for r in self.replans), stops_moved_distinct=len(self.moved_ids),
            truck_changes=sum(r.truck_changes for r in self.replans),
            dropped_from_plan=sum(r.dropped for r in self.replans),
            solver_sec=round(sum(r.solver_sec for r in self.replans), 2))


def simulate(world: World, policy: Policy, morning: Morning, *, budget: core.Budget | None = None,
             settings: Settings = Settings(), solver: Solver | None = None) -> SimResult:
    """Play one day of ``world`` under ``policy``, starting from ``morning`` (the plan of world.request).
    Re-plans use ``solver`` (default: the engine with ``budget`` and settings.solver_seed)."""
    if morning.digest != core.digest(world.request):
        raise ValueError("the morning plan is for another request")
    if policy.triggers and solver is None:
        if budget is None:
            raise ValueError("a re-planning policy needs a budget or a solver")
        solver = engine(budget, settings.solver_seed)
    return _Day(world, policy, morning, settings, solver).run()


def _stats(values: list[float]) -> dict:
    return {"mean": round(sum(values) / len(values), 3), "min": round(min(values), 3), "max": round(max(values), 3),
            "values": [round(v, 3) for v in values]}


def compare(worlds: Sequence[World], policies: Sequence[Policy] = POLICIES, *, budget: core.Budget,
            morning_budget: core.Budget | None = None, settings: Settings = Settings(),
            progress: Callable[[str], None] | None = None) -> dict:
    """Every policy on every world (all of one day), from one shared morning plan. Returns the morning
    plan's figures, each run's Outcome, per policy the mean / min / max over the worlds and the paired
    differences against the first policy."""
    if not worlds or len({core.digest(w.request) for w in worlds}) != 1:
        raise ValueError("compare needs worlds of one and the same day")
    say = progress or (lambda _m: None)
    morning = morning_plan(worlds[0].request, morning_budget or budget, seed=settings.solver_seed)
    say(f"morning plan: {morning.metrics.stops_served}/{morning.metrics.stops_total} stops, "
        f"{morning.metrics.trips} loads, {morning.wall_sec:.1f}s")
    runs: list[Outcome] = []
    logs: list[list[dict]] = []
    for w in worlds:
        for p in policies:
            started = time.perf_counter()
            res = simulate(w, p, morning, budget=budget, settings=settings)
            out = res.outcome
            runs.append(out)
            logs.append([{f.name: getattr(r, f.name) for f in fields(r) if f.name != "request"} for r in res.replans])
            say(f"world {w.seed} policy {p.name}: served {out.served}/{out.stops_total}, late {out.late_stops}, "
                f"cash {out.cash.total:.3f}, re-plans {out.replans}, {time.perf_counter() - started:.0f}s")
    seeds = [w.seed for w in worlds]
    by_policy = {p.name: [next(o for o in runs if o.policy == p.name and o.world == s) for s in seeds] for p in policies}
    summary = {}
    for name, outs in by_policy.items():
        flats = [o.flat() for o in outs]
        summary[name] = {k: _stats([f[k] for f in flats]) for k in sorted(flats[0])}
    first = policies[0].name
    paired = {name: {k: _stats([b - a for a, b in zip(summary[first][k]["values"], v["values"])])
                     for k, v in summary[name].items()} for name in by_policy if name != first}
    m = morning.metrics
    return {
        "label": "SIMULATION (no future information; distances are estimated km)",
        "budget": {"replan": asdict(budget), "morning": asdict(morning_budget or budget)},
        "settings": asdict(settings),
        "policies": {p.name: {"label": p.label, "triggers": sorted(p.triggers)} for p in policies},
        "worlds": [w.describe() for w in worlds],
        "morning": {"stops_known": m.stops_total, "stops_planned": m.stops_served, "loads": m.trips,
                    "trucks": m.trucks_used, "km": m.km, "planned_cash": asdict(m.cash), "feasibility": m.feasibility,
                    "wall_sec": morning.wall_sec},
        "runs": [{**asdict(o), "replan_log": log} for o, log in zip(runs, logs)],
        "summary": summary,
        f"vs_{first}": paired,
        "labels": {**core.LABELS, "cash": "OMR cash of the executed day (costing.truck_day_costs on actual times and "
                                          "estimated km), every load of the day",
                   "late": "minutes after the genuine closing time (window_rule), still delivered: the window as sent, "
                           "except a SALES_PREFERENCE window, measured against the customer's genuine hours (a missed "
                           "preference is counted apart); without window labels (a real day) every window counts as "
                           f"genuine. Only beyond {LATE_TOLERANCE_MIN} min, the plan's whole-minute resolution",
                   "replans": "re-plans that searched; those with nothing to plan (NOTHING_TO_PLAN) are counted as "
                              "skipped. Stop moves counts every move, distinct stops moved each stop once"},
    }


_ROWS = (("served", "stops served"), ("served_known", "morning stops served"), ("served_new", "new orders served"),
         ("unserved", "stops unserved"), ("late_stops", "late stops"), ("late_min", "late minutes"),
         ("pref_late_stops", "preferences missed"), ("late_returns", "late returns"),
         ("late_return_min", "late return minutes"), ("late_breaks", "late breaks"), ("missing_breaks", "missing breaks"),
         ("cash.total", "cash OMR (actual)"), ("cash_per_case", "cash OMR per case"), ("km", "estimated km"),
         ("loads", "loads"), ("overtime_min", "overtime min"), ("replans", "re-plans (searched)"),
         ("replans_skipped", "re-plans skipped"), ("stops_moved", "stop moves"),
         ("stops_moved_distinct", "distinct stops moved"), ("truck_changes", "truck changes"),
         ("solver_sec", "solver seconds"))


def format_report(report: dict) -> str:
    """The comparison as a plain-text table: mean [min..max] over the worlds per policy."""
    names = list(report["summary"])
    m = report["morning"]
    lines = [report["label"],
             f"morning plan: {m['stops_planned']}/{m['stops_known']} known stops on {m['loads']} loads, "
             f"{m['trucks']} trucks, planned cash {m['planned_cash']['total']:.3f} OMR, {m['feasibility']}",
             f"worlds: {[w['seed'] for w in report['worlds']]}; re-plan budget {report['budget']['replan']['time_limit_sec']} s",
             f"{'':22}" + "".join(f"{n:>26}" for n in names)]
    for key, text in _ROWS:
        cells = []
        for n in names:
            s = report["summary"][n].get(key)
            cells.append(f"{s['mean']:>10.2f} [{s['min']:.1f}..{s['max']:.1f}]" if s else "-")
        lines.append(f"{text:22}" + "".join(f"{c:>26}" for c in cells))
    return "\n".join(lines)


def synthetic_windows(n_invoices: int = 280, seed: int = 1) -> dict:
    """World keyword arguments for synthetic_case's day: synth.make_day's window provenance and genuine hours, so
    a late visit is measured against the genuine closing time (World.closing_min)."""
    day = make_day(n_invoices, seed)
    return {"window_provenance": dict(day.window_provenance), "genuine_hours": dict(day.genuine_hours)}


def synthetic_case(n_invoices: int = 280, seed: int = 1, *, n_new: int = 15, reveal: tuple[int, int] = (510, 780),
                   open_after_min: int = 120) -> tuple[DispatchRequest, tuple[NewOrder, ...]]:
    """A SYNTHETIC day (synth.make_day) split into the orders known in the morning and ``n_new`` late
    orders revealed during the day (uniform minutes in ``reveal``, 08:30-13:00 by default). The late
    orders are customers in the Muscat districts whose receiving hours stay open at least
    ``open_after_min`` after the last reveal, so each can still be served when it arrives. The same new
    orders come in every world (the worlds differ in their actual times)."""
    day = make_day(n_invoices, seed)
    rnd = random.Random(f"new-orders:{seed}")
    open_till = reveal[1] + open_after_min
    candidates = sorted(s.stop_id for s in day.request.stops
                        if day.area[s.stop_id] in AREAS and (s.hard_end_min is None or s.hard_end_min >= open_till))
    if len(candidates) < n_new:
        raise ValueError(f"only {len(candidates)} stops can be late orders")
    picked = rnd.sample(candidates, n_new)
    times = sorted(rnd.randint(*reveal) for _ in picked)
    by_id = {s.stop_id: s for s in day.request.stops}
    new = tuple(NewOrder(by_id[sid].model_copy(update={"late": True}), t) for sid, t in zip(picked, times))
    held = set(picked)
    known = day.request.model_copy(update={"run_id": f"{day.request.run_id}-known",
                                           "stops": [s for s in day.request.stops if s.stop_id not in held]}, deep=True)
    return known, new


class DataNeed(NamedTuple):
    item: str
    kind: str  # EVENT / DATA / INTEGRATION
    exists: str  # YES / PARTIAL / NO
    where: str
    needed_for: str


def data_requirements() -> list[DataNeed]:
    """What a live version needs, separating what RouteIQ has today from what is missing (code map of
    15 Oct 2026; paths in the routeiq repository)."""
    return [
        DataNeed("Stop arrival / departure / outcome taps", "EVENT", "YES",
                 "driver page: StopVisit, StopEvent (apps/web/prisma/schema.prisma:1350, :1432); POST /api/d/actions "
                 "(lib/delivery/event-service.ts)",
                 "STOP_COMPLETED with actual times; delay detection. Manual taps and timingSuspect rows are upper "
                 "bounds (14 Oct: 67 of 72 arrivals tapped by hand)"),
        DataNeed("Back at depot", "EVENT", "YES",
                 "StopEventKind BACK_AT_DEPOT; completeLoadAsDriver (lib/dispatch/plan-service.ts:2871)",
                 "DEPOT_RETURN: the actual return that the truck's next load must follow"),
        DataNeed("Load departed", "EVENT", "PARTIAL",
                 "PlanLoad status DISPATCHED + statusChangedAt (schema.prisma:1010-1079); departMin stays the planned time",
                 "LOAD_DEPARTED: the actual departure; the moment a load's stops become fixed"),
        DataNeed("New / late order with its arrival time", "EVENT", "YES",
                 "Order.uploadedAt, isLate, lateReason; POST /api/dispatch/late-order",
                 "NEW_ORDER and its reveal time (no future information)"),
        DataNeed("Actual or forecast return of frozen loads", "DATA", "NO",
                 "buildDispatchRequest sends the PLANNED departMin/returnMin as frozen_trips (plan-service.ts:941-950)",
                 "placing loads 2/3 after the real return: last departedAt + remaining planned legs (as here)"),
        DataNeed("Plan continuity on re-plans", "DATA", "PARTIAL",
                 "DispatchStop.previous_truck_id from a case-weighted vote (plan-service.ts:496-520); "
                 "change_penalty_per_stop is never sent (solver default 3, ARTIFICIAL)",
                 "route stability: stops moved between trucks and loads"),
        DataNeed("Live truck position (Ayun / IVMS GPS feed)", "INTEGRATION", "NO",
                 "StopEventSource AYUN reserved, no ingestion; IVMS only as an offline report (Feb-Mar 2026, "
                 "aggregates in decision_support/data/ivms_aggregates.json)",
                 "position between taps, an overdue truck before its next tap, live ETAs"),
        DataNeed("Onboard stock (what a truck still carries)", "DATA", "PARTIAL",
                 "implicit: a dispatched load's orders are its stock; StopVisit.linesJson deliveredCases; "
                 "buildDispatchRequest drops every order on a frozen load whatever its outcome",
                 "same-day re-delivery of failed drops; what a returning truck still has on board"),
        DataNeed("Stock availability at the depot", "DATA", "NO",
                 "no inventory model in schema.prisma, no ERP feed (orders arrive by Excel upload)",
                 "loads 2/3 and new orders can carry only stock the warehouse has at reload time (assumed "
                 "always available here)"),
        DataNeed("Per-stop locks", "DATA", "NO",
                 "locks exist per PlanLoad only (LOCKED/LOADING); per order only hard windows or allowed trucks",
                 "keeping a promised customer on its truck or load through re-plans"),
        DataNeed("Automatic re-plan trigger (event bus)", "INTEGRATION", "NO",
                 "re-plans start on a click (POST /api/runs/[id]/replan -> createNextVersion); DayOutdated only "
                 "flags a stale plan (lib/dispatch/day-overview.ts:131)",
                 "policies B and C; a shadow what-if job (the HireSuggestion pattern) never changes the live plan"),
        DataNeed("Re-routing a load on the road", "INTEGRATION", "NO",
                 "every routing vehicle starts and ends at the depot; FrozenTrip has no stops; DISPATCHED loads "
                 "cannot change (load-state.ts)",
                 "changing a departed load (not modelled: a departed load is never changed here)"),
        DataNeed("Measured turnaround (reload) times", "DATA", "PARTIAL",
                 "BACK_AT_DEPOT and the next DISPATCHED time give it; nothing aggregates it; reload_min is a setting",
                 "turnaround uncertainty (fixed at reload_min here)"),
        DataNeed("Travel and unloading uncertainty", "DATA", "PARTIAL",
                 "decision_support/data/ivms_aggregates.json: IVMS speeds (spread, time-of-day shape), 13 Oct "
                 "evidence unloading spreads, 14 Oct plan vs actual (too few GPS-confirmed rows for medians)",
                 "the World's actual times; the medians are labelled default assumptions"),
    ]


def main(argv: list[str] | None = None) -> None:
    """Compare the policies on a synthetic day: python -m decision_support.dynamic --worlds 1 2 3. The
    defaults with ``--json`` give data/dynamic_smoke.json (run on the codespace, 4 CPUs, about 25 min)."""
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--invoices", type=int, default=280)
    ap.add_argument("--day-seed", type=int, default=1)
    ap.add_argument("--new-orders", type=int, default=15)
    ap.add_argument("--worlds", type=int, nargs="+", default=[1, 2, 3])
    ap.add_argument("--budget", type=int, default=10, help="seconds per re-plan")
    ap.add_argument("--morning-budget", type=int, default=20, help="seconds for the morning plan")
    ap.add_argument("--policies", default="ABC")
    ap.add_argument("--no-ivms", action="store_true", help="labelled default spreads, no IVMS time-of-day shape")
    ap.add_argument("--json", help="write the full report to this file")
    args = ap.parse_args(argv)
    known, new = synthetic_case(args.invoices, args.day_seed, n_new=args.new_orders)
    if args.no_ivms:
        model, bands = UncertaintyModel.defaults(), None
    else:
        model, bands = UncertaintyModel.from_aggregates(), ivms_band_factors()
    worlds = [World(known, s, model, new, band_factors=bands, **synthetic_windows(args.invoices, args.day_seed))
              for s in args.worlds]
    policies = [p for p in POLICIES if p.name in args.policies]
    say = lambda m: print(m, file=sys.stderr, flush=True)  # noqa: E731
    say(f"SYNTHETIC day: {len(known.stops)} known stops + {len(new)} new orders, {len(known.trucks)} trucks")
    say(f"world model: {asdict(model)}; IVMS band factors: {bands}")
    report = compare(worlds, policies, budget=core.Budget(time_limit_sec=args.budget, seeds=(1,)),
                     morning_budget=core.Budget(time_limit_sec=args.morning_budget, seeds=(1,)), progress=say)
    report["day"] = {"label": "SYNTHETIC", "invoices": args.invoices, "seed": args.day_seed,
                     "stops_known": len(known.stops), "new_orders": len(new), "trucks": len(known.trucks)}
    if args.json:
        Path(args.json).write_text(json.dumps(report, indent=1), encoding="utf-8")
    print(format_report(report))


if __name__ == "__main__":
    main()
