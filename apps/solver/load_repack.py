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

dispatch_solver decides WHICH plans are candidates (each raw scenario plan and its repacks),
picks the best per scenario and turns it into loads. This module knows nothing about scenarios:
it gets prices (``Pricing``) and service values in objective units (1 unit = 0.00001 OMR).

Load model used by the repack
-----------------------------
A load visiting stops k1..km in order has no-wait offsets off_i (departure -> service start at
stop i), a no-wait duration d (departure -> return) and a departure interval [lo, hi] in which no
stop waits and every hard window holds: lo = max_i(hard_start_i - off_i), hi = min_i(hard_end_i -
off_i). Departing before lo only moves the waiting onto the road (return = max(e, lo) + d), so
the repack departs in [lo, hi]. When lo > hi the load must wait on the road; it then departs at
hi (the latest time that still meets every window) and occupies the truck until lo + d. Before
a load departs the truck needs its turnaround (reload + loading of THIS load's cases) after the
previous load's return; the first load of the day is loaded before the shift starts. The LP
timing afterwards may still improve the timetable (e.g. waiting on the road for a preferred
window); the repack only chooses trucks and the order of loads.
"""
from __future__ import annotations

import logging
import time
from collections import defaultdict
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Iterable

from dispatch_models import DAY_MIN, DispatchStop

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
class TimedLoad:
    stops: Load
    depart_s: int  # leaves the depot (just in time for the first stop, never before the truck is ready)
    starts: tuple[int, ...]  # service start per stop
    return_s: int  # back at the depot


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


@dataclass(frozen=True)
class Pricing:
    """One scenario's prices in objective units (1 unit = 0.00001 OMR)."""

    trucks: dict[int, TruckPrice]
    span: int = 0  # per second from the truck's first departure to its last return (driver)
    overtime: int = 0  # per second of truck day beyond overtime_after_s ...
    overtime_after_s: int | None = None  # ... counted from the first departure (frozen: first frozen one)
    pref: int = 0  # per second outside a preferred window
    early: dict[int, int] = field(default_factory=dict)  # priority -> per second after shift start
    shift_start_s: int = 0
    change: int = 0  # per stop on another truck than in the previous plan version


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

    def __post_init__(self) -> None:
        self.by_idx = {td.idx: td for td in self.trucks}

    def gap_s(self, cases: int) -> int:
        """Turnaround at the depot before a load of ``cases`` departs (after the previous load)."""
        return int(round(self.reload_s + self.loading_s_per_case * cases))

    def metres(self, load: Load) -> int:
        prev, m = 0, 0
        for k in load:
            m += self.D[prev][k + 1]
            prev = k + 1
        return m + self.D[prev][0]


def _hs(s: DispatchStop) -> int:
    return (s.hard_start_min or 0) * 60


def _he(s: DispatchStop) -> int:
    return s.hard_end_min * 60 if s.hard_end_min is not None else NO_END_S


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
    kg: float
    metres: int
    gap: int  # turnaround before this load departs, after the truck's previous load

    @property
    def waits(self) -> bool:
        return self.lo > self.hi

    @property
    def occ(self) -> int:
        """Departure -> return (departing at hi when the load has to wait on the road)."""
        return self.d if not self.waits else self.lo + self.d - self.hi


def facts(day: Day, load: Load) -> Facts:
    t, prev, off = 0, 0, []
    for k in load:
        t += day.T[prev][k + 1]
        off.append(t)
        t += day.stops[k].service_min * 60
        prev = k + 1
    t += day.T[prev][0]
    ss = [day.stops[k] for k in load]
    return Facts(
        stops=tuple(load), off=tuple(off), d=t,
        lo=max(_hs(s) - o for s, o in zip(ss, off)), hi=min(_he(s) - o for s, o in zip(ss, off)),
        cases=sum(s.demand_cases for s in ss), kg=sum(s.demand_kg for s in ss), metres=day.metres(load),
        gap=day.gap_s(sum(s.demand_cases for s in ss)),
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
    first = td.earliest_depart_s
    if td.frozen_return_s is not None:
        first = max(first, td.frozen_return_s + f.gap)
    return first


def depart_range(day: Day, f: Facts, td: "TruckDay") -> tuple[int, int] | None:
    """Departure interval of this load on this truck (None: it can never go on it)."""
    if f.cases > td.max_cases or (td.max_kg > 0 and f.kg > td.max_kg + 0.01):
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


def _soft_cost(day: Day, pricing: Pricing, k: int, start_s: int) -> int:
    """Preferred window + early-arrival cost of serving stop k at start_s (the engine's own
    coefficients: the upper preferred bound also carries the early-arrival push)."""
    s = day.stops[k]
    early = pricing.early.get(s.priority, 0)
    c = 0
    if s.pref_end_min is not None and pricing.pref > 0:
        c += (pricing.pref + early) * max(0, start_s - s.pref_end_min * 60)
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


def time_truck(day: Day, td: "TruckDay", loads: list[Load], pricing: Pricing) -> list[TimedLoad] | None:
    """Timetable of one truck's loads, in the given order, minimising the RECOMMENDED time costs.
    None when no timetable meets every hard rule. The constraint matrix only holds difference
    constraints with integer data, so rounding the LP optimum keeps it exactly feasible (checked
    again below)."""
    from ortools.linear_solver import pywraplp  # noqa: PLC0415

    if not loads:
        return []
    lp = pywraplp.Solver.CreateSolver("GLOP")
    inf = lp.infinity()
    obj = lp.Objective()
    obj.SetMinimization()
    fs = [facts(day, l) for l in loads]
    Dv, Rv, tv = [], [], []
    for j, (load, f) in enumerate(zip(loads, fs)):
        lb = _first_departure_s(day, td, f) if j == 0 else td.earliest_depart_s
        D = lp.NumVar(lb, HORIZON_S, f"D{j}")
        R = lp.NumVar(0, td.latest_return_s, f"R{j}")
        if j > 0:
            c = lp.Constraint(f.gap, inf)  # D_j - R_{j-1} >= turnaround
            c.SetCoefficient(D, 1)
            c.SetCoefficient(Rv[-1], -1)
        ts, prev, prev_svc, prev_t = [], 0, 0, None
        for i, k in enumerate(load):
            s = day.stops[k]
            t = lp.NumVar(_hs(s), min(_he(s), HORIZON_S), f"t{j}_{i}")
            if i == 0:
                c = lp.Constraint(day.T[0][k + 1], day.T[0][k + 1])  # leave just in time
                c.SetCoefficient(t, 1)
                c.SetCoefficient(D, -1)
            else:
                c = lp.Constraint(prev_svc + day.T[prev][k + 1], inf)
                c.SetCoefficient(t, 1)
                c.SetCoefficient(prev_t, -1)
            for coef, bound, sign in _soft_terms(day, pricing, k):
                u = lp.NumVar(0, inf, "")
                # u >= sign * (t - bound)
                c = lp.Constraint(-sign * bound, inf)
                c.SetCoefficient(u, 1)
                c.SetCoefficient(t, -sign)
                obj.SetCoefficient(u, coef)
            ts.append(t)
            prev, prev_svc, prev_t = k + 1, s.service_min * 60, t
        c = lp.Constraint(prev_svc + day.T[prev][0], prev_svc + day.T[prev][0])  # R = last start + service + drive back
        c.SetCoefficient(R, 1)
        c.SetCoefficient(prev_t, -1)
        obj.SetCoefficient(R, obj.GetCoefficient(R) + _TIE)
        obj.SetCoefficient(D, obj.GetCoefficient(D) - _TIE)
        Dv.append(D)
        Rv.append(R)
        tv.append(ts)
    first, last = Dv[0], Rv[-1]
    if td.shift_anchor_s is None:
        c = lp.Constraint(-inf, day.shift_max_s)
        c.SetCoefficient(last, 1)
        c.SetCoefficient(first, -1)
    span = pricing.span + _TIE
    obj.SetCoefficient(last, obj.GetCoefficient(last) + span)
    obj.SetCoefficient(first, obj.GetCoefficient(first) - span + 1e-6)  # ties: earliest day
    if pricing.overtime and pricing.overtime_after_s is not None:
        u = lp.NumVar(0, inf, "ot")
        if td.shift_anchor_s is None:  # u - last + first >= -after
            c = lp.Constraint(-pricing.overtime_after_s, inf)
            c.SetCoefficient(first, 1)
        else:
            c = lp.Constraint(-(td.shift_anchor_s + pricing.overtime_after_s), inf)
        c.SetCoefficient(u, 1)
        c.SetCoefficient(last, -1)
        obj.SetCoefficient(u, pricing.overtime)
    if lp.Solve() != pywraplp.Solver.OPTIMAL:
        return None
    out: list[TimedLoad] = []
    for load, D, R, ts in zip(loads, Dv, Rv, tv):
        out.append(TimedLoad(stops=tuple(load), depart_s=int(round(D.solution_value())),
                             starts=tuple(int(round(t.solution_value())) for t in ts),
                             return_s=int(round(R.solution_value()))))
    return out if timing_ok(day, td, out) else None


def _soft_terms(day: Day, pricing: Pricing, k: int) -> Iterable[tuple[int, int, int]]:
    """(coefficient, bound, sign): cost coefficient x max(0, sign x (start - bound))."""
    s = day.stops[k]
    early = pricing.early.get(s.priority, 0)
    if s.pref_end_min is not None and pricing.pref > 0:
        yield pricing.pref + early, s.pref_end_min * 60, 1
    elif early > 0:
        yield early, pricing.shift_start_s, 1
    if s.pref_start_min is not None and pricing.pref > 0:
        yield pricing.pref, s.pref_start_min * 60, -1


def timing_ok(day: Day, td: "TruckDay", loads: list[TimedLoad]) -> bool:
    """Every hard rule of one truck's timetable, in integer seconds."""
    prev_return = None
    for j, tl in enumerate(loads):
        f_gap = day.gap_s(sum(day.stops[k].demand_cases for k in tl.stops))
        if j == 0:
            if tl.depart_s < td.earliest_depart_s:
                return False
            if td.frozen_return_s is not None and tl.depart_s < td.frozen_return_s + f_gap:
                return False
        elif tl.depart_s < prev_return + f_gap:
            return False
        prev, t = 0, tl.depart_s
        for k, start in zip(tl.stops, tl.starts):
            s = day.stops[k]
            if start < t + day.T[prev][k + 1] or not _hs(s) <= start <= _he(s):
                return False
            t = start + s.service_min * 60
            prev = k + 1
        if tl.return_s != t + day.T[prev][0] or tl.return_s > td.latest_return_s:
            return False
        prev_return = tl.return_s
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
            f = facts(day, l)
            if f.cases > td.max_cases or (td.max_kg > 0 and f.kg > td.max_kg + 0.01):
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
    trucks: int
    loads: int
    metres: int
    operating: int = 0  # the money part of cost: fixed + trip + km + driver span + overtime

    @property
    def objective(self) -> int:
        return self.unserved + self.cost


def score(day: Day, pricing: Pricing, plan: TimedPlan) -> Score:
    """RECOMMENDED objective of a timed plan: unserved value + fixed + trip + km x truck rate +
    driver cost on the truck span + overtime (from the first actual departure, as reported) +
    preferred-window / early-arrival costs + plan-continuity changes."""
    served: set[int] = set()
    op = soft = trucks = n_loads = metres = 0
    for idx, loads in plan.items():
        if not loads:
            continue
        td = day.by_idx[idx]
        price = pricing.trucks[idx]
        trucks += 1
        op += price.fixed
        for tl in loads:
            n_loads += 1
            m = day.metres(tl.stops)
            metres += m
            op += price.trip + int(round(price.per_m * m))
            for k, start in zip(tl.stops, tl.starts):
                served.add(k)
                soft += _soft_cost(day, pricing, k, start)
                if pricing.change and _moved(day, k, td):
                    soft += pricing.change
        first, last = loads[0].depart_s, loads[-1].return_s
        op += pricing.span * (last - first)
        if pricing.overtime and pricing.overtime_after_s is not None:
            base = td.shift_anchor_s if td.shift_anchor_s is not None else first
            op += pricing.overtime * max(0, last - base - pricing.overtime_after_s)
    unserved = sum(v for k, v in enumerate(day.values) if k not in served)
    return Score(unserved=unserved, cost=op + soft, trucks=trucks, loads=n_loads, metres=metres, operating=op)


# --------------------------------------------------------------------------------------------
# CP-SAT load repack
# --------------------------------------------------------------------------------------------

@dataclass
class RepackResult:
    plan: Plan | None
    status: str
    seconds: float


def repack(day: Day, pricing: Pricing, pool: list[Load], required: set[int], optional: dict[int, int],
           hint: TimedPlan | None, time_limit: float, workers: int = 2) -> RepackResult:
    """Assign the loads of ``pool`` to trucks and departure times, exactly, for ``pricing``.

    required: stops that must be carried (exactly one chosen load holds each).
    optional: stop -> phase-1 weight; carried at most once. When any optional stop can be
      carried, phase 1 maximises the carried weight first, phase 2 then minimises cost without
      carrying less (lexicographic: service before cost).
    hint: a plan built from the same loads (normally the plan being repacked): CP-SAT starts
      from it, so the answer is never worse on these prices.
    Returns plan None when CP-SAT found no solution in time (the caller keeps its plan).
    """
    from ortools.sat.python import cp_model  # noqa: PLC0415

    t0 = time.perf_counter()
    m = cp_model.CpModel()
    F = [facts(day, l) for l in pool]
    x: dict[tuple[int, int], object] = {}
    ranges: dict[tuple[int, int], tuple[int, int]] = {}
    e: list = []
    sel: list = []
    on_truck: dict[int, list[int]] = defaultdict(list)
    classes = _identical_trucks(day, pricing)
    seen_in_class: dict[int, int] = defaultdict(int)
    for j, f in enumerate(F):
        opts = [(td, r) for td in day.trucks if (r := depart_range(day, f, td)) is not None]
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
    for j, l in enumerate(pool):
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
    for td in day.trucks:
        js = on_truck.get(td.idx, [])
        if not js:
            continue
        price = pricing.trucks[td.idx]
        xs = [x[j, td.idx] for j in js]
        used = m.NewBoolVar(f"used{td.idx}")
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
        # Redundant, for strong bounds: a truck's loads and the turnarounds between them fit in
        # its day, so the day lasts at least their sum (less the first load's turnaround, which
        # happens before the first departure).
        busy = sum((F[j].occ + F[j].gap) * x[j, td.idx] for j in js)
        gmax = max(F[j].gap for j in js)
        if td.shift_anchor_s is None:
            m.Add(busy <= (day.shift_max_s + gmax) * used)
        else:
            m.Add(busy <= (td.latest_return_s - td.earliest_depart_s + gmax) * used)
        if price.fixed:
            cost_terms.append(price.fixed * used)
        for j in js:
            c = price.trip + int(round(price.per_m * F[j].metres))
            if pricing.change:
                c += pricing.change * sum(1 for k in F[j].stops if _moved(day, k, td))
            if c:
                cost_terms.append(c * x[j, td.idx])
        if pricing.span:
            sp = m.NewIntVar(0, HORIZON_S, "")
            m.Add(sp >= en - st).OnlyEnforceIf(used)
            m.Add(sp >= busy - gmax * used)
            cost_terms.append(pricing.span * sp)
        if pricing.overtime and pricing.overtime_after_s is not None:
            ot = m.NewIntVar(0, HORIZON_S, "")
            if td.shift_anchor_s is None:
                m.Add(ot >= en - st - pricing.overtime_after_s).OnlyEnforceIf(used)
                m.Add(ot >= busy - gmax * used - pricing.overtime_after_s)
            else:
                m.Add(ot >= en - td.shift_anchor_s - pricing.overtime_after_s).OnlyEnforceIf(used)
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
    hinted = _add_hint(m, x, e, ranges, pool, _relabel(hint, pool, classes) if hint else None)

    served_terms = [w * v for k, w in optional.items() for v in covering.get(k, [])]
    deadline = t0 + time_limit
    if served_terms:
        m.Maximize(sum(served_terms))
        solver.parameters.max_time_in_seconds = max(0.5, (deadline - time.perf_counter()) * 0.4)
        st1 = _solve_until_stalled(solver, m, solver.parameters.max_time_in_seconds)
        if st1 in (cp_model.OPTIMAL, cp_model.FEASIBLE):
            m.Add(sum(served_terms) >= int(round(solver.ObjectiveValue())))
            m.ClearHints()
            for (j, idx), xv in x.items():
                m.AddHint(xv, bool(solver.Value(xv)))
            for j, ej in enumerate(e):
                if ej is not None:
                    m.AddHint(ej, solver.Value(ej))
            hinted = True
    m.Minimize(sum(cost_terms))
    solver.parameters.max_time_in_seconds = max(0.5, deadline - time.perf_counter())
    status = _solve_until_stalled(solver, m, solver.parameters.max_time_in_seconds)
    name = solver.StatusName(status)
    if status not in (cp_model.OPTIMAL, cp_model.FEASIBLE):
        return RepackResult(None, name + ("" if hinted else " (no hint)"), time.perf_counter() - t0)
    plan: Plan = {}
    for td in day.trucks:
        mine = sorted((solver.Value(e[j]), pool[j]) for j in on_truck.get(td.idx, []) if solver.Value(x[j, td.idx]))
        if mine:
            plan[td.idx] = [l for _, l in mine]
    if status == cp_model.FEASIBLE and solver.ObjectiveValue() > 0:
        name += f" gap {100.0 * (solver.ObjectiveValue() - solver.BestObjectiveBound()) / solver.ObjectiveValue():.1f}%"
    return RepackResult(plan, name, time.perf_counter() - t0)


def _solve_until_stalled(solver, model, limit: float):
    """Solve, but stop once no better plan has been found for a quarter of the limit (at least
    1 s). On the real day CP-SAT had its final plan after 1-3 s and spent the rest of a 10 s
    limit tightening the bound (3-6% gap), which does not change the plan."""
    import threading  # noqa: PLC0415

    from ortools.sat.python import cp_model  # noqa: PLC0415

    class Progress(cp_model.CpSolverSolutionCallback):
        def __init__(self) -> None:
            super().__init__()
            self.last = time.perf_counter()

        def on_solution_callback(self) -> None:
            self.last = time.perf_counter()

    cb = Progress()
    stall = max(1.0, limit / 4)
    done = threading.Event()

    def watch() -> None:
        while not done.wait(0.1):
            if time.perf_counter() - cb.last > stall:
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
                td.shift_anchor_s, td.frozen_return_s, pricing.trucks[td.idx])].append(td.idx)
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


def _add_hint(m, x, e, ranges, pool: list[Load], hint: TimedPlan | None) -> bool:
    if not hint:
        return False
    pos = {l: j for j, l in enumerate(pool)}
    on: set[tuple[int, int]] = set()
    for idx, loads in hint.items():
        for tl in loads:
            j = pos.get(tl.stops)
            if j is None or (j, idx) not in x:
                continue
            on.add((j, idx))
            a, b = ranges[j, idx]
            m.AddHint(e[j], min(max(tl.depart_s, a), b))
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


def build_candidates(day: Day, score_pricing: Pricing, goal: str, goal_pricing: Pricing,
                     sources: list[Source], optional: dict[int, int] | None, cap_s: float,
                     budget_s: float, time_raw: bool) -> tuple[list[Candidate], list[str]]:
    """Repack every distinct raw plan with ``goal_pricing``; time every result (and the raw
    plans when ``time_raw``) exactly; score everything on ``score_pricing`` (RECOMMENDED).

    optional: stop -> phase-1 weight of the stops that may be added as one-stop loads (drop
      repair), or None. Only stops a plan does not already carry are optional for it.
    Returns (candidates, log lines)."""
    t0 = time.perf_counter()
    out: list[Candidate] = []
    notes: list[str] = []
    seen: set[tuple] = set()
    done_pools: set[frozenset] = set()

    def add(source: str, plan: Plan) -> None:
        sig = plan_signature(plan)
        if sig in seen:
            return
        seen.add(sig)
        timed = time_plan(day, plan, score_pricing)
        if timed is None:
            notes.append(f"{source}: infeasible when timed exactly; discarded")
            return
        out.append(Candidate(source, timed, score(day, score_pricing, timed)))

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
        key = frozenset(pool)
        if key in done_pools:
            continue
        done_pools.add(key)
        left = budget_s - (time.perf_counter() - t0)
        # Share what is left fairly with the plans still to come.
        limit = min(cap_s, left / max(1, len(order) - n))
        if limit < 0.5:
            notes.append(f"{src.name}: no time left for the {goal} repack")
            continue
        try:
            res = repack(day, goal_pricing, pool, carried, opt, src.plan, limit)
        except Exception as exc:  # noqa: BLE001 - a failed repack only loses this candidate
            log.warning("repack %s/%s failed: %s", src.name, goal, exc)
            notes.append(f"{src.name}: {goal} repack failed ({exc})")
            continue
        notes.append(f"{src.name}: {goal} repack {res.status} in {res.seconds:.1f}s")
        if res.plan is not None:
            add(f"{src.name}+repack:{goal}", res.plan)
    return out, notes
