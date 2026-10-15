"""Exact oracle for small dispatch days (DESIGN.md section 5).

``solve_small`` enumerates every plan of a day with at most 8 stops and at most 2 trucks of one load each:
each set of stops a truck could carry, in every order, timed exactly under the engine's own rules, and
every split of the stops between the trucks (or left out). When the enumeration completes, its best plan
is PROVEN optimal for the rules below. That is the only place this prototype claims optimality.
``compare_with_engine`` runs the engine (dispatch_solver.optimize_dispatch) on the same day and checks its
plan against the oracle.

The oracle reuses the engine's own functions wherever the engine has one:
- the matrix: dispatch_solver.resolve_matrix with the request's haversine_multiplier, avg_speed_kmh and
  road_time_factor (HAVERSINE, so every km is an estimated km);
- the truck days: dispatch_solver._truck_days (earliest departure, latest return, depot hours, truck hours,
  the driver-break state and window, pallet rooms);
- the window rule: load_repack.latest_start_s (START / FINISH); the turnaround before a first load from
  config.loading_from_min: load_repack.Day.gap_s;
- capacity: load_repack.fits_truck (cases, or pallet units at Pallet fill and the one-customer room, kg,
  allowed trucks);
- the service values (strict or weighted priorities): dispatch_solver._stage_ctx;
- the money: costing.truck_day_costs (cash only).

Only the timing of one load is computed here, in closed form, so that the ~100,000 orders of 8 stops can
all be timed. Each event time is max(D + a, b) for a departure D, and every hard rule bounds D. The rules
are those of the engine's exact timing (load_repack._truck_lp / timing_ok):
- the load leaves the depot just in time for its first stop (any waiting is done at the depot);
- waiting is allowed before any later stop;
- shift_max_min from departure to return, the latest return, the hard windows;
- the driver break, on a truck-day that needs one (TruckDay.break_state DUE): none when the truck is back
  by the break window's latest start or leaves at its earliest start or later; otherwise one break of
  break_min, starting inside its window, on one leg (never between two parts of one customer's order).
  On the first leg there is no waiting after the break. On the way back the break interrupts the drive
  and no waiting is added, but the last unloading may start later instead.
The cheapest timing of a load is its shortest paid day: costing pays the driver from departure to return
and overtime after departure + overtime_after_min, so with one load per truck the cash rises with the span.
The optimal plan is re-checked with the engine's own load_repack.timing_ok and fits_truck, and priced again
with load_repack.score (OracleResult.verified).

Objective, in order: the engine's service value of the served stops (with strict priorities one stop of a
priority outweighs every lower one; ARTIFICIAL ranks, never money), then the least cash (OMR).
objective="COUNT" ranks by the number of stops served first. The engine's RECOMMENDED also prices
preferred windows and early arrival (ARTIFICIAL); the oracle does not, so with equal service the oracle's
cash is a lower bound for the engine's.

Refused (OracleRefused): more than ``max_stops`` stops, more than 2 trucks, frozen loads, a truck that may
make more than one load (set max_trips 1), trucks to rent (hire_candidate: the engine's hire check changes
the plan after the search).

The owner's IVMS truck reports (the aggregates in data/ivms_aggregates.json) set the drive speed of the
random test days (``random_instance``: the median Muscat speed of a delivery-hours band) and the slow-day
stress test (``ivms_slow_factor``: the p75 travel multiplier of history.UncertaintyModel.from_aggregates).
"""
from __future__ import annotations

import argparse
import json
import math
import os
import platform
import random
import statistics
import sys
import time
from dataclasses import asdict, dataclass, field

import costing
import dispatch_solver as ds
import load_repack as LR
from dispatch_models import DispatchRequest, DispatchTruck

from . import core, history, ivms, synth

HARD_MAX_STOPS = 10  # max_stops may be raised to this; the enumeration grows like n! beyond it
MAX_TRUCKS = 2
OBJECTIVES = ("ENGINE", "COUNT")
TOL_OMR = 0.002  # the engine rounds each load's cash to the baisa
NEG = -(1 << 60)  # "no lower bound" for an event time
Z75 = 0.6745  # the 75th percentile of a standard normal
IVMS_BANDS = ("06-09", "09-12", "12-15")  # the IVMS speed bands of delivery hours
IVMS_REGION = "Muscat"  # the synthetic days are Muscat days
WHY = {"NO_TRUCK": "no truck can take a load today",
       "NO_ALLOWED_TRUCK": "none of its allowed trucks can take a load today",
       "CAPACITY": "it fits no truck it may go on (cases, pallets at the fill limit, kg)",
       "TIME": "no load reaches it inside its hours and returns within the shift, the latest return, the "
               "depot hours and the driver break"}
LABELS = {
    **core.LABELS,
    "service_value": "ARTIFICIAL: the engine's service values of the served stops (strict priority weights); a "
                     "rank, never money",
    "claim": "OPTIMAL only when the enumeration is complete, for the oracle's rules and estimated km",
}


class OracleRefused(ValueError):
    """The request is outside what the oracle solves exactly."""


class _OutOfTime(Exception):
    pass


@dataclass(frozen=True)
class _Rules:
    """One usable truck's hard rules for a single load, in seconds (dispatch_solver._truck_days)."""

    idx: int  # its position in the request's trucks (TruckDay.idx)
    truck_id: str
    first_s: int  # earliest departure
    ready_s: int | None  # loading starts then (config.loading_from_min): leave after it + turnaround
    latest_s: int  # latest return
    shift_s: int  # longest departure -> return
    due: bool  # the truck-day needs a driver break unless it is back early or leaves late enough
    may_break: bool  # a break can be placed (its window is not empty)
    brk_s: int
    brk_lo_s: int  # earliest break start
    brk_hi_s: int  # latest break start
    brk_from_s: int  # no break needed when leaving at or after this
    brk_to_s: int  # ... or when back by this
    rates: costing.TruckRates


# A timing label of a partial load: its last event (a service start, or the departure) happens at
# max(D + a, b) for departure D, and the load is feasible for D in [lo, hi]; brk = the leg holding the
# driver break (0 = depot to first stop, n = the way back), None = none yet.
_Label = tuple  # (a, b, lo, hi, brk)
_Timing = tuple  # the cheapest timing of a load: (paid span, departure, return, break leg or None), seconds


@dataclass(frozen=True)
class OracleRoute:
    """One truck's load in the oracle's plan, timed for the least cash. Times in seconds of the day."""

    truck_id: str
    stop_ids: tuple[str, ...]
    depart_s: int
    starts_s: tuple[int, ...]  # service start per stop
    return_s: int
    break_start_s: int | None  # the driver break, when the load holds one
    break_leg: int | None  # 0 = before the first stop, len(stop_ids) = on the way back
    km: float  # estimated km
    cash: core.CashBreakdown


@dataclass
class OracleResult:
    """The oracle's answer for one day. ``complete``: every plan was enumerated, so the plan is optimal
    (``claim``); otherwise it is the best one found before ``max_sec`` and nothing is proven."""

    complete: bool
    objective: str
    routes: list[OracleRoute]
    served: tuple[str, ...]
    unserved: tuple[str, ...]
    cash: core.CashBreakdown  # OMR, the plan's cash
    service_value: int  # ARTIFICIAL rank units, never money
    served_by_priority: dict[int, int]
    max_served: int | None  # the most stops any feasible plan serves; None when not complete (nothing proven)
    # Stops no feasible load of any truck serves, with the reason (a WHY key); None when not complete.
    never_servable: dict[str, str] | None
    single_stop_infeasible: tuple[str, ...]  # stops no truck can serve alone (the cheap proof)
    verified: bool  # load_repack.timing_ok / fits_truck pass and load_repack.score gives the same cash
    loads_timed: int  # orders of stops the enumeration timed
    loads_feasible: int
    seconds: float
    oracle: "Oracle" = field(repr=False, compare=False)

    @property
    def claim(self) -> str:
        if self.complete:
            return "OPTIMAL (exact enumeration, complete)"
        return "BEST FOUND (enumeration stopped at max_sec; not proven optimal)"

    def cash_for(self, stop_ids) -> float | None:
        """The least cash (OMR) of a plan serving exactly these stops; None when no plan does, or when the
        enumeration stopped early (its tables then hold only the loads timed so far: nothing is proven)."""
        return self.oracle.cash_for(self.oracle.mask_of(stop_ids)) if self.complete else None

    def survives(self, factor: float) -> bool:
        """The plan's loads, in the same order on the same trucks, still meet every hard rule when every
        drive takes ``factor`` times as long (a uniformly slow day; ivms_slow_factor)."""
        return all(self.oracle.time_load(r.truck_id, r.stop_ids, factor) is not None for r in self.routes)

    def summary(self, labels: dict[str, str] | None = None) -> dict:
        """The result without stop ids (anonymous labels, core.label_stops) or coordinates."""
        lab = labels or core.label_stops(self.oracle.req)
        return {
            "claim": self.claim, "complete": self.complete, "objective": self.objective,
            "stops": len(self.served) + len(self.unserved), "served": len(self.served), "max_served": self.max_served,
            "served_by_priority": self.served_by_priority, "unserved": sorted(lab[s] for s in self.unserved),
            "cash": asdict(self.cash), "service_value": self.service_value,
            "never_servable": None if self.never_servable is None else dict(
                sorted((lab[s], why) for s, why in self.never_servable.items())),
            "single_stop_infeasible": sorted(lab[s] for s in self.single_stop_infeasible),
            "routes": [{"truck": r.truck_id, "stops": [lab[s] for s in r.stop_ids], "depart": _hhmm(r.depart_s),
                        "return": _hhmm(r.return_s), "break": _hhmm(r.break_start_s), "estimated_km": r.km,
                        "cash": round(r.cash.total, 3)} for r in self.routes],
            "verified": self.verified, "loads_timed": self.loads_timed, "loads_feasible": self.loads_feasible,
            "seconds": round(self.seconds, 3), "labels": dict(LABELS),
        }


def _hhmm(s: int | None) -> str | None:
    if s is None:
        return None
    m = int(round(s / 60))
    return f"{m // 60:02d}:{m % 60:02d}"


def _bits(mask: int) -> int:
    return bin(mask).count("1")


def _refuse(req: DispatchRequest, max_stops: int) -> None:
    if len(req.stops) > max_stops:
        raise OracleRefused(f"{len(req.stops)} stops: the oracle solves at most {max_stops}")
    if len(req.trucks) > MAX_TRUCKS:
        raise OracleRefused(f"{len(req.trucks)} trucks: the oracle solves at most {MAX_TRUCKS}")
    for t in req.trucks:
        if t.frozen_trips:
            raise OracleRefused(f"truck {t.id} has frozen loads: the oracle plans whole days only")
        if t.hire_candidate:
            raise OracleRefused(f"truck {t.id} is a truck to rent: the engine's hire check is not modelled")
    for td in ds._truck_days(req):
        if td.usable and td.trips_left > 1:
            raise OracleRefused(f"truck {td.truck.id} may make {td.trips_left} loads: set max_trips 1 (one load per truck)")


class Oracle:
    """One day prepared for the enumeration: the engine's matrix, truck days, service values and prices.
    Stops are taken in stop-id order, so the answer does not depend on the order of the request."""

    def __init__(self, req: DispatchRequest, max_stops: int = 8) -> None:
        if not 1 <= max_stops <= HARD_MAX_STOPS:
            raise ValueError(f"max_stops must be 1..{HARD_MAX_STOPS}")
        req = core.offline(req)
        _refuse(req, max_stops)
        cfg = req.config
        self.req = req
        self.stops = sorted(req.stops, key=lambda s: s.stop_id)
        self.n = len(self.stops)
        self.idx_of = {s.stop_id: k for k, s in enumerate(self.stops)}
        self.tds = ds._truck_days(req)
        coords = [(req.depot.lat, req.depot.lng)] + [(s.lat, s.lng) for s in self.stops]
        self.mx = ds.resolve_matrix(coords, provider="HAVERSINE", osrm_url=None,
                                    haversine_multiplier=cfg.haversine_multiplier, avg_speed_kmh=cfg.avg_speed_kmh,
                                    road_time_factor=cfg.road_time_factor)
        ctx = ds._stage_ctx(req, self.stops, self.tds, self.mx, [])
        self.day, self.pricing, self.values = ctx.day, ctx.rec_pricing, ctx.values
        self.T, self.D = self.mx.duration_s, self.mx.distance_m
        self.hs = [(s.hard_start_min or 0) * 60 for s in self.stops]
        self.he = [LR.latest_start_s(s, cfg.window_rule) for s in self.stops]
        self.svc = [s.service_min * 60 for s in self.stops]
        self.cust = [s.customer_id for s in self.stops]
        self.cases = [s.demand_cases for s in self.stops]
        self.day_rates = costing.DayRates.from_config(cfg)
        self.rules = [self._rules(td) for td in self.tds if td.usable]
        self.rules_of = {r.truck_id: r for r in self.rules}
        self._fits: dict[tuple[int, int], bool] = {}
        self._scaled: dict[float, list[list[int]]] = {1.0: self.T}
        # Per usable truck (as self.rules): stop mask -> (cash, metres, order, timing) of its cheapest load.
        self.tables: list[dict[int, tuple]] = []

    def _rules(self, td) -> _Rules:
        due = LR.break_due(td)
        return _Rules(idx=td.idx, truck_id=td.truck.id, first_s=td.earliest_depart_s, ready_s=td.ready_s,
                      latest_s=td.latest_return_s, shift_s=self.day.shift_max_s, due=due,
                      may_break=due and td.break_lo_s <= td.break_hi_s, brk_s=td.break_s, brk_lo_s=td.break_lo_s,
                      brk_hi_s=td.break_hi_s, brk_from_s=td.break_from_s, brk_to_s=td.break_to_s,
                      rates=costing.TruckRates.from_truck(td.truck))

    def mask_of(self, stop_ids) -> int:
        mask = 0
        for sid in stop_ids:
            mask |= 1 << self.idx_of[sid]
        return mask

    def _value(self, mask: int) -> int:
        return sum(v for k, v in enumerate(self.values) if mask >> k & 1)

    # ---- one load -----------------------------------------------------------------------------

    def _fit(self, r: _Rules, mask: int, seq) -> bool:
        """The stops fit the truck as one load (load_repack.fits_truck). It depends only on the set, and a
        set that does not fit has no superset that fits (the room never grows with more stops)."""
        key = (r.idx, mask)
        got = self._fits.get(key)
        if got is None:
            got = self._fits[key] = LR.fits_truck(LR.facts(self.day, tuple(seq)), self.tds[r.idx])
        return got

    def _first(self, r: _Rules, cases: int) -> int:
        """Earliest departure of a load of ``cases`` (load_repack._first_departure_s)."""
        return r.first_s if r.ready_s is None else max(r.first_s, r.ready_s + self.day.gap_s(cases))

    def _arrive(self, r: _Rules, labels: list[_Label], prev: int | None, k: int, pos: int, T) -> list[_Label]:
        """The labels after driving from ``prev`` (None: the depot) to stop k, the ``pos``-th stop of the
        load, and starting its service: without a break on this leg, and with one if none was taken yet."""
        if prev is None:
            pnode, psvc, may = 0, 0, r.may_break
        else:
            pnode, psvc = prev + 1, self.svc[prev]
            may = r.may_break and self.cust[prev] != self.cust[k]  # never between two parts of one order
        leg = T[pnode][k + 1]
        hs, he = self.hs[k], self.he[k]
        out = []
        for a, b, lo, hi, brk in labels:
            la, lb = a + psvc, b + psvc  # leaves the previous stop (or the depot)
            na, nb = la + leg, max(lb + leg, hs)
            nhi = min(hi, he - na)
            if nb <= he and lo <= nhi:
                out.append((na, nb, lo, nhi, brk))
            if not may or brk is not None:
                continue
            if prev is None:  # on the first leg: just in time, no waiting after the break
                na = leg + r.brk_s
                nlo, nhi = max(lo, r.brk_lo_s - leg, hs - na), min(hi, r.brk_hi_s, he - na)
                if nlo <= nhi:
                    out.append((na, NEG, nlo, nhi, 0))
            elif lb <= r.brk_hi_s:  # starts once the truck has left the previous stop and the window is open
                na = la + leg + r.brk_s
                nb = max(lb + leg + r.brk_s, r.brk_lo_s + r.brk_s, hs)
                nhi = min(hi, r.brk_hi_s - la, he - na)
                if nb <= he and lo <= nhi:
                    out.append((na, nb, lo, nhi, pos))
        return out

    def _close(self, r: _Rules, labels: list[_Label], last: int, n_stops: int, cases: int, T) -> _Timing | None:
        """The cheapest timing of the load that ends at stop ``last``: the shortest paid day over every
        label and break choice, departing as late as the rules allow (no waiting at the first stop)."""
        back = T[last + 1][0]
        svc = self.svc[last]
        first = self._first(r, cases)
        best = None
        for a, b, lo, hi, brk in labels:
            la, lb = a + svc, b + svc
            ra, rb = la + back, lb + back
            if brk is not None or not r.due:
                opts = [(ra, rb, lo, hi, brk)]
            else:
                opts = [(ra, rb, max(lo, r.brk_from_s), hi, None)]  # leaves at the break window's start or later
                if rb <= r.brk_to_s:
                    opts.append((ra, rb, lo, min(hi, r.brk_to_s - ra), None))  # back before it can start
                if r.may_break and lb <= r.brk_hi_s and self.he[last] + svc >= r.brk_lo_s - back:
                    # on the way back: the drive holds the break; the last unloading may start later
                    opts.append((ra + r.brk_s, max(rb + r.brk_s, r.brk_lo_s + r.brk_s), lo,
                                 min(hi, r.brk_hi_s - la), n_stops))
            for oa, ob, olo, ohi, obrk in opts:
                ohi = min(ohi, r.latest_s - oa)
                if ob > r.latest_s or max(olo, first) > ohi:
                    continue
                span = max(oa, ob - ohi)
                if span <= r.shift_s and (best is None or span < best[0]):
                    best = (span, ohi, max(ohi + oa, ob), obrk)
        return best

    def _time(self, r: _Rules, seq, T) -> _Timing | None:
        labels = [(0, NEG, r.first_s, LR.HORIZON_S, None)]
        prev = None
        for pos, k in enumerate(seq):
            labels = self._arrive(r, labels, prev, k, pos, T)
            if not labels:
                return None
            prev = k
        return self._close(r, labels, seq[-1], len(seq), sum(self.cases[k] for k in seq), T)

    def _matrix(self, factor: float) -> list[list[int]]:
        got = self._scaled.get(factor)
        if got is None:
            got = self._scaled[factor] = [[int(math.ceil(v * factor)) for v in row] for row in self.T]
        return got

    def time_load(self, truck_id: str, stop_ids, factor: float = 1.0) -> _Timing | None:
        """The cheapest timing (paid span, departure, return, break leg) of these stops in this order as one
        load of the truck, with every drive x ``factor``; None when no timing meets every hard rule or the
        load does not fit the truck."""
        r = self.rules_of.get(truck_id)
        if r is None or not stop_ids:
            return None
        seq = tuple(self.idx_of[s] for s in stop_ids)
        if len(set(seq)) != len(seq) or not self._fit(r, self.mask_of(stop_ids), seq):
            return None
        return self._time(r, seq, self._matrix(factor))

    def _load_cost(self, r: _Rules, timing: _Timing, metres: int) -> costing.LoadCost:
        return costing.truck_day_costs(r.rates, self.day_rates, [costing.LoadTiming(
            depart_s=timing[1], return_s=timing[2], km=metres / 1000.0)]).loads[0]

    def load_cash(self, truck_id: str, stop_ids) -> float | None:
        """The least cash (OMR) of these stops in this order as one load of the truck; None if infeasible."""
        timing = self.time_load(truck_id, stop_ids)
        if timing is None:
            return None
        metres = self.day.metres(tuple(self.idx_of[s] for s in stop_ids))
        return self._load_cost(self.rules_of[truck_id], timing, metres).total

    def _timetable(self, r: _Rules, seq, timing: _Timing) -> tuple[tuple[int, ...], int, int | None]:
        """Service starts, return and break start of the load departing at timing's departure."""
        _, depart, _, brk = timing
        T = self.T
        starts: list[int] = []
        leave, pnode, b_start = depart, 0, None
        for i, k in enumerate(seq):
            leg = T[pnode][k + 1]
            if brk == i:
                b_start = max(leave, r.brk_lo_s)
                arrive = max(leave + leg, b_start) + r.brk_s
            else:
                arrive = leave + leg
            starts.append(max(arrive, self.hs[k]))
            leave, pnode = starts[-1] + self.svc[k], k + 1
        back = T[pnode][0]
        if brk == len(seq):
            if leave < r.brk_lo_s - back:  # the last unloading starts later, so the break fits the drive back
                starts[-1] = r.brk_lo_s - back - self.svc[seq[-1]]
                leave = r.brk_lo_s - back
            b_start = max(leave, r.brk_lo_s)
            ret = leave + back + r.brk_s
        else:
            ret = leave + back
        return tuple(starts), ret, b_start

    # ---- the enumeration ----------------------------------------------------------------------

    def _enumerate(self, r: _Rules, best: dict[int, tuple], deadline: float | None, counts: list[int]) -> None:
        """Every order of every set of stops as one load of truck r (depth first; a partial load that breaks
        a rule or does not fit ends its branch, as no longer load can repair it). ``best`` gets, per set,
        the cheapest order: (cash, metres, order, timing)."""
        T, D, n = self.T, self.D, self.n
        best[0] = (0.0, 0, (), None)

        def visit(mask: int, seq: list[int], labels: list[_Label], cases: int, metres: int) -> None:
            last = seq[-1]
            counts[0] += 1
            if deadline is not None and counts[0] % 2048 == 0 and time.monotonic() > deadline:
                raise _OutOfTime
            timing = self._close(r, labels, last, len(seq), cases, T)
            if timing is not None:
                counts[1] += 1
                m = metres + D[last + 1][0]
                cash = self._load_cost(r, timing, m).total
                cur = best.get(mask)
                if cur is None or (cash, m) < (cur[0], cur[1]):
                    best[mask] = (cash, m, tuple(seq), timing)
            for k in range(n):
                if mask >> k & 1:
                    continue
                grow(mask | 1 << k, seq, labels, cases, metres, last, k)

        def grow(mask: int, seq: list[int], labels: list[_Label], cases: int, metres: int, prev: int | None,
                 k: int) -> None:
            nseq = seq + [k]
            if not self._fit(r, mask, nseq):
                return
            ncases = cases + self.cases[k]
            first = self._first(r, ncases)
            nl = [lab for lab in self._arrive(r, labels, prev, k, len(seq), T) if max(lab[2], first) <= lab[3]]
            if nl:
                visit(mask, nseq, nl, ncases, metres + D[0 if prev is None else prev + 1][k + 1])

        start = [(0, NEG, r.first_s, LR.HORIZON_S, None)]
        for k in range(n):
            grow(1 << k, [], start, 0, 0, None, k)

    def _combos(self):
        """Every plan: one stop set per usable truck (0 = the truck stays home), the sets disjoint."""
        if not self.tables:
            yield ()
        elif len(self.tables) == 1:
            for m in self.tables[0]:
                yield (m,)
        else:
            t1 = list(self.tables[1])
            for m0 in self.tables[0]:
                for m1 in t1:
                    if not m0 & m1:
                        yield (m0, m1)

    def cash_for(self, mask: int) -> float | None:
        """The least cash of a plan serving exactly the stops of ``mask`` (from the enumeration's tables)."""
        cash = [sum(t[m][0] for t, m in zip(self.tables, combo)) for combo in self._combos() if _union(combo) == mask]
        return min(cash) if cash else None

    def solve(self, objective: str = "ENGINE", max_sec: float | None = 300.0) -> OracleResult:
        """Enumerate every load of every usable truck, then every plan; the best plan by ``objective``."""
        if objective not in OBJECTIVES:
            raise ValueError(f"objective must be one of {OBJECTIVES}")
        started = time.perf_counter()
        deadline = time.monotonic() + max_sec if max_sec is not None else None
        complete = True
        counts = [0, 0]
        self.tables = []
        for r in self.rules:
            table: dict[int, tuple] = {}
            self.tables.append(table)
            if complete:
                try:
                    self._enumerate(r, table, deadline, counts)
                except _OutOfTime:
                    complete = False
            else:
                table[0] = (0.0, 0, (), None)

        def key(combo):
            union, cash, metres = 0, 0.0, 0
            for t, m in zip(self.tables, combo):
                union |= m
                cash += t[m][0]
                metres += t[m][1]
            ranked = (-self._value(union), round(cash, 9), metres, combo)
            return (-_bits(union),) + ranked if objective == "COUNT" else ranked

        best = min(self._combos(), key=key)
        max_served = max((_bits(_union(c)) for c in self._combos()), default=0) if complete else None
        routes = [self._route(r, t[m]) for r, t, m in zip(self.rules, self.tables, best) if m]
        served_mask = _union(best)
        served = tuple(s.stop_id for k, s in enumerate(self.stops) if served_mask >> k & 1)
        unserved = tuple(s.stop_id for k, s in enumerate(self.stops) if not served_mask >> k & 1)
        by_p = {p: 0 for p in range(1, 6)}
        for sid in served:
            by_p[self.stops[self.idx_of[sid]].priority] += 1
        return OracleResult(
            complete=complete, objective=objective, routes=routes, served=served,
            unserved=unserved,
            cash=_total(r.cash for r in routes), service_value=self._value(served_mask), served_by_priority=by_p,
            max_served=max_served, never_servable=self._never_servable() if complete else None,
            single_stop_infeasible=tuple(s.stop_id for s in self.stops
                                         if all(self.time_load(r.truck_id, (s.stop_id,)) is None for r in self.rules)),
            verified=self._verified(routes), loads_timed=counts[0], loads_feasible=counts[1],
            seconds=time.perf_counter() - started, oracle=self,
        )

    def _route(self, r: _Rules, entry: tuple) -> OracleRoute:
        _, metres, seq, timing = entry
        starts, ret, b_start = self._timetable(r, seq, timing)
        c = self._load_cost(r, timing, metres)
        return OracleRoute(
            truck_id=r.truck_id, stop_ids=tuple(self.stops[k].stop_id for k in seq), depart_s=timing[1],
            starts_s=starts, return_s=ret, break_start_s=b_start, break_leg=timing[3], km=round(metres / 1000.0, 3),
            cash=_total([c]))

    def _never_servable(self) -> dict[str, str]:
        servable = 0
        for t in self.tables:
            for m in t:
                servable |= m
        out: dict[str, str] = {}
        for k, s in enumerate(self.stops):
            if servable >> k & 1:
                continue
            allowed = [r for r in self.rules if ds.truck_allowed(s, self.tds[r.idx].truck)]
            if not self.rules:
                out[s.stop_id] = "NO_TRUCK"
            elif not allowed:
                out[s.stop_id] = "NO_ALLOWED_TRUCK"
            elif not any(self._fit(r, 1 << k, (k,)) for r in allowed):
                out[s.stop_id] = "CAPACITY"
            else:
                out[s.stop_id] = "TIME"
        return out

    def _verified(self, routes: list[OracleRoute]) -> bool:
        """The engine's own checks agree: every load fits (load_repack.fits_truck), its timetable meets every
        hard rule (load_repack.timing_ok) and load_repack.score prices it at the oracle's cash."""
        for route in routes:
            r = self.rules_of[route.truck_id]
            td = self.tds[r.idx]
            seq = tuple(self.idx_of[s] for s in route.stop_ids)
            brk = LR.BreakAt(route.break_start_s, "ROAD", route.break_leg) if route.break_leg is not None else None
            tl = LR.TimedLoad(stops=seq, depart_s=route.depart_s, starts=route.starts_s, return_s=route.return_s, brk=brk)
            if not (LR.fits_truck(LR.facts(self.day, seq), td) and LR.timing_ok(self.day, td, [tl])):
                return False
            money = LR.score(self.day, self.pricing, {r.idx: [tl]}).operating / costing.COST_SCALE
            if abs(money - route.cash.total) > 1e-4:
                return False
        return True


def _union(combo) -> int:
    out = 0
    for m in combo:
        out |= m
    return out


def _total(parts) -> core.CashBreakdown:
    """The cash parts added up (costing.LoadCost or core.CashBreakdown items), to 0.000001 OMR."""
    parts = list(parts)
    return core.CashBreakdown(**{f: round(sum(getattr(p, f) for p in parts), 6) for f in (
        "fixed", "trip", "distance", "fuel", "driver", "overtime", "total")})


def solve_small(req: DispatchRequest, max_stops: int = 8, *, objective: str = "ENGINE",
                max_sec: float | None = 300.0) -> OracleResult:
    """The exact plan of a small day (at most ``max_stops`` stops, 2 trucks, one load each): raises
    OracleRefused for anything larger. ``max_sec`` bounds the enumeration; when it stops early the result
    is not complete and claims nothing."""
    return Oracle(req, max_stops).solve(objective, max_sec)


# ---- the engine against the oracle ------------------------------------------------------------

@dataclass
class Comparison:
    """One engine run (one seed) against the oracle. Stop names are anonymous labels (core.label_stops).
    Cash in OMR; gaps are engine - oracle."""

    seed: int
    engine_status: str
    engine_feasibility: str  # the engine's own independent check (feasibility.check_scenario)
    oracle_complete: bool
    oracle_feasible: bool  # every engine load is a feasible load of its truck under the oracle's rules
    infeasible_loads: list[str]
    engine_served: int
    oracle_served: int
    oracle_max_served: int | None  # None when the oracle did not complete
    served_equal: bool  # as many stops as the oracle's optimum
    service_equal: bool  # the same service value (priorities) as the oracle's optimum
    engine_service_le_oracle: bool  # must hold
    engine_cash: float
    engine_loads_least_cash: float | None  # the engine's own loads, timed by the oracle for the least cash
    oracle_cash_same_stops: float | None  # the oracle's least cash serving exactly the engine's stops
    oracle_cash: float
    gap_omr: float | None  # engine - oracle optimum, when the service is equal
    gap_pct: float | None
    gap_same_stops_omr: float | None  # engine - the oracle's least cash for the engine's own stops
    gap_same_stops_pct: float | None
    # gap_same_stops = routing_gap + timing_gap. routing: the engine's loads (which trucks, which stops, in
    # which order), both sides timed for the least cash. timing: the engine's timetable of its own loads
    # against their least-cash timing; RECOMMENDED pays driver time for preferred windows and early arrival
    # (its ARTIFICIAL prices), which also steer its choice of loads.
    routing_gap_omr: float | None
    timing_gap_omr: float | None
    proven_but_served: list[str]  # stops the oracle proves never servable that the engine serves: must be []
    engine_false_proofs: list[str]  # engine PREFILTER / WINDOW proofs the oracle refutes: must be []
    engine_unproven_impossible: list[str]  # left out by the engine without proof; the oracle proves them impossible
    engine_survives_slow: bool | None  # its loads still fit when every drive takes the slow factor (None: not asked)
    wall_sec: float


def _pct(gap: float | None, base: float) -> float | None:
    return round(100.0 * gap / base, 3) if gap is not None and base > 0 else None


def _round(x: float | None, places: int = 3) -> float | None:
    return round(x, places) if x is not None else None


def compare_run(res: OracleResult, run: core.RunResult, slow_factor: float | None = None) -> Comparison:
    """One engine run against the oracle's result for the same day."""
    o = res.oracle
    labels = core.label_stops(o.req)
    sc = next(s for s in run.response.scenarios if s.name == "RECOMMENDED")
    feasible, bad, least, mask, used = True, [], 0.0, 0, set()
    survives = True
    for ld in sc.loads:
        ids = tuple(st.stop_id for st in ld.stops)
        mask |= o.mask_of(ids)
        cash = o.load_cash(ld.truck_id, ids) if ld.truck_id not in used else None
        used.add(ld.truck_id)
        if cash is None:
            feasible = False
            bad.append(f"{ld.truck_id}: " + " > ".join(labels[s] for s in ids))
        else:
            least += cash
        if slow_factor is not None and o.time_load(ld.truck_id, ids, slow_factor) is None:
            survives = False
    served = {st.stop_id for ld in sc.loads for st in ld.stops}
    value = o._value(mask)
    engine_cash = run.metrics.cash.total
    oracle_cash = res.cash.total
    same = o.cash_for(mask) if feasible and res.complete else None  # least cash only from a complete enumeration
    service_equal = value == res.service_value
    gap = engine_cash - oracle_cash if service_equal and res.complete else None
    gap_same = engine_cash - same if same is not None and res.complete else None
    never = res.never_servable or {}
    false_proofs, unproven = [], []
    for u in sc.unserved:
        kind = core.proof_kind(u)
        if res.never_servable is not None and kind in ("PREFILTER", "WINDOW") and u.stop_id not in never:
            false_proofs.append(labels[u.stop_id])
        if kind not in core.PROVEN_KINDS and u.stop_id in never:
            unproven.append(labels[u.stop_id])
    return Comparison(
        seed=run.seed, engine_status=sc.status, engine_feasibility=run.metrics.feasibility,
        oracle_complete=res.complete, oracle_feasible=feasible, infeasible_loads=bad,
        engine_served=len(served), oracle_served=len(res.served), oracle_max_served=res.max_served,
        served_equal=len(served) == len(res.served), service_equal=service_equal,
        engine_service_le_oracle=value <= res.service_value if res.complete else True,
        engine_cash=round(engine_cash, 3), engine_loads_least_cash=_round(least if feasible else None),
        oracle_cash_same_stops=_round(same), oracle_cash=round(oracle_cash, 3),
        gap_omr=_round(gap), gap_pct=_pct(gap, oracle_cash), gap_same_stops_omr=_round(gap_same),
        gap_same_stops_pct=_pct(gap_same, same or 0.0),
        routing_gap_omr=_round(least - same) if same is not None and res.complete else None,
        timing_gap_omr=_round(engine_cash - least) if feasible else None,
        proven_but_served=sorted(labels[s] for s in served if s in never),
        engine_false_proofs=sorted(false_proofs), engine_unproven_impossible=sorted(unproven),
        engine_survives_slow=survives if slow_factor is not None else None, wall_sec=run.wall_sec,
    )


def compare_with_engine(req: DispatchRequest, budget: core.Budget, *, result: OracleResult | None = None,
                        slow_factor: float | None = None) -> list[Comparison]:
    """The engine on ``req`` once per seed of the budget (core.solve_seeds: offline, RECOMMENDED only), each
    run compared with the oracle (``result``, or solve_small(req)). Callers outside pytest need an
    ``if __name__ == "__main__":`` guard or SOLVER_PARALLEL=0 (core.solve)."""
    res = result if result is not None else solve_small(req)
    return [compare_run(res, run, slow_factor) for run in core.solve_seeds(req, budget)]


# ---- IVMS evidence and random small days ------------------------------------------------------

def ivms_speed_kmh(band: str, path=ivms.DEFAULT_OUT) -> tuple[float, str]:
    """The median IVMS speed of MOVING segments in Muscat in one time band (km/h) and its basis."""
    raw = ivms.load(path)["ivms_raw"]
    row = raw["travel_speed_kmh"]["by_region_band"][IVMS_REGION][band]
    return float(row["p50"]), (f"IVMS {raw.get('period')}: p50 speed of {IVMS_REGION} MOVING segments of 1 km or "
                               f"more, {band} band, n={row['n']}")


def ivms_slow_factor(path=ivms.DEFAULT_OUT) -> tuple[float, str]:
    """A slow day's drive-time multiplier, the p75 of history.UncertaintyModel.from_aggregates (lognormal:
    median x exp(0.6745 sigma)), and its basis. Applied to every drive at once: a stress test, not a
    simulation of one day."""
    m = history.UncertaintyModel.from_aggregates(path)
    factor = round(m.travel_median * math.exp(Z75 * m.travel_sigma), 3)
    return factor, (f"p75 travel multiplier {factor} = {m.travel_median} x exp(0.6745 x {m.travel_sigma}); median: "
                    f"{m.basis['travel_median']}; sigma: {m.basis['travel_sigma']}")


PROFILES = {"MORNING": 0.4, "TIGHT_RETURN": 0.3, "LATE_START": 0.3}
INSTANCE_ASSUMPTIONS = {
    "label": "SYNTHETIC: customers of synth.make_day (public Muscat district centres and remote towns), cut down "
             "to a few stops; every number of synth.make_day's assumptions applies",
    "stops": "3..max_stops stops drawn from synth.make_day(2 x stops + 2 invoices, seed)",
    "trucks": "1 truck (25% of days) or 2, bays drawn from synth.FLEET_BAYS, synth's costs, one load each "
              "(max_trips 1); a small-truck-only customer may use the day's trucks of at most "
              f"{synth.SMALL_TRUCK_MAX_BAYS} bays",
    "speed": "avg_speed_kmh = the IVMS median Muscat speed of a band drawn from " + ", ".join(IVMS_BANDS),
    "profiles": {"MORNING": "synth's config (07:30 start, back by 19:00, 60-min break starting 14:00-15:00)",
                 "TIGHT_RETURN": "back by 12:00, 13:00 or 14:00 (latest_return_min)",
                 "LATE_START": "a plan made at 10:00, 11:00 or 12:00 (loading_from_min): the morning windows "
                               "close, the break falls inside the day"},
    "profile_shares": PROFILES,
}


def random_instance(seed: int, max_stops: int = 7, *, time_limit_sec: int = 2) -> tuple[DispatchRequest, dict]:
    """A small SYNTHETIC day for the oracle, deterministic for ``seed``, and its labels (INSTANCE_ASSUMPTIONS)."""
    if not 3 <= max_stops <= HARD_MAX_STOPS:
        raise ValueError(f"max_stops must be 3..{HARD_MAX_STOPS}")
    rnd = random.Random(f"exact-instance:{seed}")
    n_stops = rnd.randint(3, max_stops)
    day = synth.make_day(n_invoices=2 * n_stops + 2, seed=seed)
    pool = sorted(day.request.stops, key=lambda s: s.stop_id)
    picked = sorted(rnd.sample(pool, min(n_stops, len(pool))), key=lambda s: s.stop_id)
    trucks = []
    for i, bays in enumerate(sorted(rnd.choice(synth.FLEET_BAYS) for _ in range(1 if rnd.random() < 0.25 else 2)), 1):
        fixed, per_km, km_l, _ = synth._truck_costs(bays)
        trucks.append(DispatchTruck(id=f"T{i:02d}", code=f"SYN-{bays}B-{i:02d}", capacity_cases=bays * synth.CASES_PER_BAY,
                                    bays=bays, fixed_cost=fixed, cost_per_km=per_km, km_per_litre=km_l, max_trips=1))
    small = [t.id for t in trucks if t.bays <= synth.SMALL_TRUCK_MAX_BAYS]
    stops = [s.model_copy(update={"allowed_truck_ids": small}) if s.allowed_truck_ids is not None else s for s in picked]
    profile = rnd.choices(sorted(PROFILES), weights=[PROFILES[k] for k in sorted(PROFILES)])[0]
    band = rnd.choice(IVMS_BANDS)
    speed, basis = ivms_speed_kmh(band)
    update: dict = dict(max_trips_per_truck=1, time_limit_sec=time_limit_sec, avg_speed_kmh=speed)
    if profile == "TIGHT_RETURN":
        update["latest_return_min"] = rnd.choice((720, 780, 840))
    elif profile == "LATE_START":
        update["loading_from_min"] = rnd.choice((600, 660, 720))
    req = day.request.model_copy(deep=True, update=dict(
        run_id=f"exact-s{seed}", stops=stops, trucks=trucks, config=day.request.config.model_copy(update=update)))
    info = {"seed": seed, "stops": len(stops), "trucks": len(trucks), "bays": [t.bays for t in trucks],
            "profile": profile, "latest_return": _hhmm(update["latest_return_min"] * 60) if "latest_return_min" in update
            else None, "loading_from": _hhmm(update["loading_from_min"] * 60) if "loading_from_min" in update else None,
            "ivms_band": band, "avg_speed_kmh": speed, "speed_basis": basis, "label": "SYNTHETIC"}
    return req, info


def _stats(values: list[float]) -> dict:
    if not values:
        return {"n": 0}
    return {"n": len(values), "median": round(statistics.median(values), 3), "mean": round(statistics.fmean(values), 3),
            "min": round(min(values), 3), "max": round(max(values), 3)}


def _share(flags: list[bool]) -> dict:
    return {"n": len(flags), "true": sum(flags), "share": round(sum(flags) / len(flags), 3) if flags else None}


def without_preference_prices(req: DispatchRequest) -> DispatchRequest:
    """A copy with no ARTIFICIAL time prices (preferred windows, early arrival): the engine's RECOMMENDED then
    ranks plans by service and cash alone, like the oracle. Hard rules are untouched."""
    cfg = req.config.model_copy(update={"pref_window_penalty_per_min": 0.0,
                                        "early_preference_per_min": {p: 0.0 for p in range(1, 6)}})
    return req.model_copy(update={"config": cfg}, deep=True)


def run_suite(n: int = 60, max_stops: int = 7, budget: core.Budget = core.Budget(time_limit_sec=3, seeds=(1,)),
              first_seed: int = 1, max_sec: float | None = 300.0, preference_prices: bool = True) -> dict:
    """E5: ``n`` random small days (random_instance), each solved by the oracle and by the engine once per
    seed of ``budget``; the summary and one anonymous row per day. ``preference_prices`` False: every day
    without_preference_prices (variant PREFERENCES_OFF). Needs an ``if __name__ == "__main__":`` guard or
    SOLVER_PARALLEL=0 (the engine's worker processes)."""
    factor, factor_basis = ivms_slow_factor()
    rows: list[dict] = []
    comps: list[Comparison] = []
    oracles: list[OracleResult] = []
    for seed in range(first_seed, first_seed + n):
        req, info = random_instance(seed, max_stops, time_limit_sec=budget.time_limit_sec)
        if not preference_prices:
            req = without_preference_prices(req)
        res = solve_small(req, max_stops=max_stops, max_sec=max_sec)
        mine = compare_with_engine(req, budget, result=res, slow_factor=factor)
        oracles.append(res)
        comps += mine
        summary = res.summary()
        summary.pop("labels")
        rows.append({**info, "oracle": summary, "oracle_survives_slow": res.survives(factor),
                     "comparisons": [asdict(c) for c in mine]})
    eq = [c for c in comps if c.gap_omr is not None]
    same = [c for c in comps if c.gap_same_stops_omr is not None]
    out = {
        "variant": "DEFAULT" if preference_prices else "PREFERENCES_OFF (no preferred-window or early-arrival "
                                                       "prices: the engine ranks by service and cash, like the oracle)",
        "instances": n, "engine_runs": len(comps), "max_stops": max_stops,
        "budget": asdict(budget), "first_seed": first_seed,
        "complete_enumerations": sum(r.complete for r in oracles),
        "oracle_verified": sum(r.verified for r in oracles),
        "oracle_seconds": _stats([r.seconds for r in oracles]),
        "engine_wall_sec": _stats([c.wall_sec for c in comps]),
        "engine_plans_oracle_feasible": _share([c.oracle_feasible for c in comps]),
        "served_equal": _share([c.served_equal for c in comps]),
        "service_equal": _share([c.service_equal for c in comps]),
        "engine_service_le_oracle": _share([c.engine_service_le_oracle for c in comps]),
        "engine_service_below_oracle": sum(not c.service_equal for c in comps),
        "stops_short_of_oracle": sum(max(0, c.oracle_served - c.engine_served) for c in comps if c.oracle_complete),
        "proven_but_served": sum(len(c.proven_but_served) for c in comps),
        "engine_false_proofs": sum(len(c.engine_false_proofs) for c in comps),
        "engine_unproven_impossible": sum(len(c.engine_unproven_impossible) for c in comps),
        "oracle_never_servable": sum(len(r.never_servable or {}) for r in oracles),
        "cash_gap_omr": _stats([c.gap_omr for c in eq]),
        "cash_gap_pct": _stats([c.gap_pct for c in eq if c.gap_pct is not None]),
        "cash_gap_zero_share": _share([abs(c.gap_omr) <= TOL_OMR for c in eq]),
        "cash_gap_same_stops_omr": _stats([c.gap_same_stops_omr for c in same]),
        "routing_gap_omr": _stats([c.routing_gap_omr for c in comps if c.routing_gap_omr is not None]),
        "timing_gap_omr": _stats([c.timing_gap_omr for c in comps if c.timing_gap_omr is not None]),
        "ivms_slow_factor": factor, "ivms_slow_basis": factor_basis,
        "oracle_plans_survive_slow": _share([r["oracle_survives_slow"] for r in rows]),
        "engine_plans_survive_slow": _share([c.engine_survives_slow for c in comps if c.engine_survives_slow is not None]),
        "ivms_speeds": {b: ivms_speed_kmh(b)[1] for b in IVMS_BANDS},
        "instance_assumptions": INSTANCE_ASSUMPTIONS,
        "machine": {"node": platform.node(), "cpus": os.cpu_count(), "python": platform.python_version()},
        "env": {k: os.environ[k] for k in ("SOLVER_PARALLEL", "SOLVER_PYVRP") if k in os.environ},
        "labels": dict(LABELS),
    }
    return {"summary": out, "rows": rows}


def main(argv: list[str] | None = None) -> None:
    p = argparse.ArgumentParser(description="E5: the exact oracle against the engine on random small SYNTHETIC days.")
    p.add_argument("--n", type=int, default=60)
    p.add_argument("--max-stops", type=int, default=7)
    p.add_argument("--time-limit", type=int, default=3, help="engine time_limit_sec per run")
    p.add_argument("--seeds", type=int, nargs="+", default=[1], help="engine seeds per day (core.seeded)")
    p.add_argument("--first-seed", type=int, default=1)
    p.add_argument("--no-preferences", action="store_true", help="variant PREFERENCES_OFF (without_preference_prices)")
    p.add_argument("--out", help="write the summary and the per-day rows (anonymous) to this JSON file")
    a = p.parse_args(argv)
    got = run_suite(a.n, a.max_stops, core.Budget(time_limit_sec=a.time_limit, seeds=tuple(a.seeds)), a.first_seed,
                    preference_prices=not a.no_preferences)
    if a.out:
        with open(a.out, "w", encoding="utf-8") as f:
            json.dump(got, f, indent=1)
    json.dump(got["summary"], sys.stdout, indent=1)
    print()


if __name__ == "__main__":
    main()
