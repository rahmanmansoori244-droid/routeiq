"""Feasibility and trade-off explanations (DESIGN.md section 5; the exact oracle is exact.py).

- ``verdict``: why a run left stops out. PLANNED, PROVEN_INFEASIBLE (a proof), SEARCH_FAILURE (no proof: a
  longer search, a relaxation or a change could serve it) or MODEL_ERROR_SUSPECTED (the 14 Oct 2026
  signature: no plan at all well before the time limit while every stop can be served on its own, also when
  the engine's second search rescued the run).
- ``conflicts``: per unserved stop, the constraints that could bind. Its earliest arrival against its window
  (also at the truck speeds the IVMS report measured), its size against the largest room, its round trip
  against the shift, its allowed trucks, and the room and time left on the loads that pass nearby.
- ``rank_relaxations``: re-solves each candidate relaxation with the same budget and seeds, and ranks them
  by stops and cases gained, then by cash.
- ``frontier``: the non-dominated plans over (cash OMR, stops served, minutes late).

Ground rules (DESIGN.md section 0):
- Genuine closing times, breaks, capacity, small-truck-only and the one-customer rule are never relaxed.
- A window flexes only when it is labelled SALES_PREFERENCE, or UNKNOWN in a variant labelled HYPOTHETICAL.
- A longer shift is HYPOTHETICAL (it needs driver agreement). Faster unloading requires evidence; it is
  ranked apart, never with the levers that can be used today.
- Cash is DispatchScenario.operating_cost. Solver penalties are ARTIFICIAL and are never added to it.
- Minutes and km are HAVERSINE estimates. No plan here is claimed optimal.

Real days: anonymise the request first (history.anonymise). The outputs then hold anonymous labels only.
"""
from __future__ import annotations

import argparse
import functools
import json
import math
import os
import time
from collections import Counter
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import ClassVar, Protocol

import dispatch_solver as ds
import load_repack as LR
from dispatch_models import DAY_MIN, DispatchRequest, DispatchResponse, DispatchScenario, DispatchStop, DispatchTruck
from providers import HaversineProvider

from . import core, history, ivms, whatif
from .synth import CUSTOMER_HARD, SALES_PREFERENCE, SERVICE_PER_CASE, UNKNOWN

PLANNED, PROVEN_INFEASIBLE = "PLANNED", "PROVEN_INFEASIBLE"
SEARCH_FAILURE, MODEL_ERROR_SUSPECTED = "SEARCH_FAILURE", "MODEL_ERROR_SUSPECTED"
UNPROVEN_NOTE = "not proven impossible: a longer search, a relaxation or a change could serve it"
MODEL_ERROR_SEC = 1.0  # no plan this fast, with every stop optional, is not a search that ran out of time
# On a longer search, "this fast" is also anything under this share of its time limit: the solver's time
# includes building the model, which takes longer on a large day and a busy machine.
MODEL_ERROR_SHARE = 0.1
RESCUED = "SECOND_SEARCH"  # the engine's status of an option its main route search left with no plan
# Search statuses that mean the model itself is inconsistent: every stop is optional, so the empty plan is
# always feasible and "infeasible" cannot be about the stops.
MODEL_STATUSES = ("ROUTING_INFEASIBLE", "ROUTING_INVALID")
NEAR_KM = 5.0  # a load "passes nearby" when one of its stops is this close (estimated km)
MAX_NEARBY = 5
FLEX_MINUTES = (10, 20, 30)
SHIFT_MINUTES = 30
# Ranking tiers: levers usable today, levers that need a confirmation or an agreement, levers that need evidence.
TIERS = ("ACTIONABLE", "HYPOTHETICAL", "REQUIRES_EVIDENCE")
_TIER_PREFIX = {"ACTIONABLE": "", "HYPOTHETICAL": "[HYPOTHETICAL] ", "REQUIRES_EVIDENCE": "[REQUIRES EVIDENCE] "}
_SINGLE_STOP_KINDS = ("PREFILTER", "WINDOW")  # engine proofs that our own one-stop check can confirm


# ------------------------------------------------------------------------------------------------
# Context: labels the request does not carry, and the IVMS evidence
# ------------------------------------------------------------------------------------------------

@functools.lru_cache(maxsize=1)
def _aggregates() -> dict:
    """The committed IVMS / truck-evidence aggregates (ivms.DEFAULT_OUT); {} when the file is missing.
    Shared between contexts and never modified."""
    return ivms.load() if Path(ivms.DEFAULT_OUT).exists() else {}


@dataclass
class Context:
    """What the request does not say. ``window_provenance`` per stop id (CUSTOMER_HARD / SALES_PREFERENCE /
    UNKNOWN; a stop without one is UNKNOWN), ``genuine_hours`` of preference windows, the trucks the
    company can rent (``hire_options``: hire_candidate trucks with their real hire price), whether UNKNOWN
    windows may flex in HYPOTHETICAL variants, the per-case part of the service formula, and the IVMS
    aggregates."""

    window_provenance: dict[str, str] = field(default_factory=dict)
    genuine_hours: dict[str, tuple[int, int]] = field(default_factory=dict)
    hire_options: tuple[DispatchTruck, ...] = ()
    hypothetical: bool = False
    per_case_min: float = SERVICE_PER_CASE  # the web's service formula; the 13 Oct drop-size model gives 0.243-0.245
    aggregates: dict = field(default_factory=_aggregates)

    @classmethod
    def of(cls, day, **kw) -> "Context":
        """From a synth.SynthDay or a history.RealDay (their provenance and genuine hours)."""
        return cls(window_provenance=dict(day.window_provenance), genuine_hours=dict(day.genuine_hours), **kw)


def _context(ctx) -> Context:
    if ctx is None:
        return Context()
    if isinstance(ctx, Context):
        return ctx
    if hasattr(ctx, "window_provenance"):
        return Context.of(ctx)
    raise TypeError("ctx must be a Context, a SynthDay, a RealDay or None")


def _band(minute: float) -> str:
    """The IVMS time band (ivms.BANDS) of a minute of the day."""
    hour = int(minute // 60) % 24
    for name, lo, hi in ivms.BANDS:
        if (lo <= hour < hi) if lo < hi else (hour >= lo or hour < hi):
            return name
    raise ValueError(minute)


def ivms_speeds(agg: dict, minute: float) -> dict | None:
    """IVMS moving speeds (km/h, MOVING segments of 5 km or more, Feb-Mar 2026) of the time band of
    ``minute``: {"band", "n", "p50", "p90"}; None without enough rows."""
    rows = (((agg.get("ivms_raw") or {}).get("travel_speed_kmh") or {}).get("by_band_5km_plus") or {})
    band = _band(minute)
    p = rows.get(band) or {}
    if p.get("n", 0) < ivms.MIN_TIER_N or not p.get("p90"):
        return None
    return {"band": band, "n": p["n"], "p50": p["p50"], "p90": p["p90"]}


def unloading_gap(agg: dict) -> tuple[float, int] | None:
    """How much shorter the best-quartile visits are than the median (whatif.unloading_gap, the one
    definition), as (share rounded to 2 decimals, visits); None without evidence."""
    gap = whatif.unloading_gap(agg)
    return (round(gap["p25_below_p50"], 2), gap["visits"]) if gap else None


def _fleet_value(agg: dict, head: str) -> str | None:
    """The "value to use" of the truck evidence's Fleet parameters row whose parameter starts with ``head``."""
    rows = (((agg.get("evidence_2026_10_12") or {}).get("fleet_parameters") or {}).get("rows") or [])
    return next((r.get("value_to_use") for r in rows if str(r.get("parameter", "")).startswith(head)), None)


def _window_claims(agg: dict) -> str | None:
    v = (((agg.get("evidence_2026_10_12") or {}).get("window_claims") or {}).get("verdicts") or {})
    late, same = v.get("CLOSE_EARLIER_THAN_PRACTICE"), v.get("CONSISTENT_WITH_PRACTICE")
    if late is None or same is None:
        return None
    return (f"13 Oct truck evidence: {late} of {late + same} RouteIQ hard windows with corroborated visits close "
            "earlier than practice")


# ------------------------------------------------------------------------------------------------
# Small helpers
# ------------------------------------------------------------------------------------------------

def _scenario(response: DispatchResponse, name: str) -> DispatchScenario:
    for sc in response.scenarios:
        if sc.name == name:
            return sc
    raise ValueError(f"the response has no {name} scenario")


def _served(sc: DispatchScenario) -> set[str]:
    return {st.stop_id for ld in sc.loads for st in ld.stops}


def _hhmm(minutes: float | None) -> str | None:
    if minutes is None:
        return None
    m = int(math.floor(minutes + 0.5))
    return f"{m // 60:02d}:{m % 60:02d}"


def _up_min(seconds: float) -> int:
    """Seconds to whole minutes, rounded up (a shortfall of 10 s is 1 minute short)."""
    return int(math.ceil(seconds / 60 - 1e-9))


def _mmm(values: list[float]) -> dict:
    return {"mean": round(sum(values) / len(values), 4), "min": round(min(values), 4), "max": round(max(values), 4),
            "values": [round(v, 4) for v in values]}


def _omr(x: float) -> str:
    return f"{round(x, 2) + 0.0:+.2f}"


def _pal(units: float) -> str:
    """Pallets from 1/1000 units: one decimal, two below one pallet (a 2-case stop is not "0.0")."""
    p = units / 1000
    return f"{p:.2f}" if 0 < p < 1 else f"{p:.1f}"


class _Geo:
    """The engine's HAVERSINE legs (estimated km x multiplier, the truck average speed)."""

    def __init__(self, req: DispatchRequest) -> None:
        self.hv = HaversineProvider(req.config.haversine_multiplier, req.config.avg_speed_kmh)
        self.depot = (req.depot.lat, req.depot.lng)

    def leg(self, a: tuple[float, float], b: tuple[float, float]) -> tuple[int, int]:
        """(metres, seconds)."""
        return self.hv.leg(a, b) if a != b else (0, 0)


def _pos(s: DispatchStop) -> tuple[float, float]:
    return (s.lat, s.lng)


# ------------------------------------------------------------------------------------------------
# Conflicts
# ------------------------------------------------------------------------------------------------

@dataclass
class Nearby:
    """A planned load passing near an unserved stop, and what it has left. Estimates: the stop is priced
    straight after the load's nearest stop, later stops are not re-timed, and breaks are ignored."""

    truck_id: str
    load_no: int
    near_stop: str  # anonymous label of the load's stop nearest to it
    km: float  # estimated km from that stop
    measure: str  # "pallets" or "cases"
    room_left: float  # what the load has left for this stop, in ``measure``
    fits: bool  # its need (and kg) fits the room left, and it may go on this truck
    time_left_min: int  # minutes after this load until the truck's next load must leave, or its day ends
    detour_min: int  # extra minutes it adds after the nearest stop: drive, waiting and unloading
    window_ok: bool  # arriving straight after the nearest stop meets its window


@dataclass
class Conflict:
    """The constraints that could keep one stop out. ``blocking`` lists those that rule it out on its own
    (NO_TRUCK, ALLOWED, SIZE, WINDOW, SHIFT): a proof, the same relaxed single round trip as the engine's
    prefilters. An empty list means it can be served on its own, so what keeps it out is the rest of the
    day (other stops, loads, breaks) or the search."""

    stop_id: str
    label: str
    priority: int
    cases: int
    pallets: float | None
    provenance: str  # of its window: CUSTOMER_HARD / SALES_PREFERENCE / UNKNOWN (unlabelled = UNKNOWN)
    window: str | None  # its receiving hours "07:00-08:22"; None = no closing time
    window_rule: str
    earliest_arrival: str | None  # on the trucks it may go on and fits alone
    latest_start: str | None
    window_short_min: int  # > 0: even the earliest truck arrives this many minutes too late
    ivms: dict | None  # the same arrival at IVMS moving speeds (p50, p90) of the departure's time band
    size: str  # its size against the largest truck it may go on
    size_fits: bool
    round_trip_min: int  # depot -> stop -> depot plus unloading, no waiting
    shift_short_min: int | None  # > 0: no round trip that meets its window fits the shift / return; None: none meets it
    allowed: list[str] | None  # trucks it may go on; None = any
    usable_trucks: int  # trucks that can take a new load today
    fitting_trucks: int  # of them: allowed, with room for it alone
    blocking: list[str]
    nearby: list[Nearby] = field(default_factory=list)

    @property
    def servable_alone(self) -> bool:
        return not self.blocking

    def text(self) -> str:
        """One line in plain words."""
        win = f"window {self.window} {self.provenance}" if self.window else "no closing time"
        head = f"{self.label} (P{self.priority}, {self.cases} cases, {win})"
        parts = [f"earliest arrival {self.earliest_arrival or '--:--'}"]
        if self.window_short_min > 0:
            parts[0] += f", {self.window_short_min} min after its latest start {self.latest_start}"
            if self.ivms:
                p90 = self.ivms["p90"]
                parts[0] += (f" (at the IVMS p90 moving speed {p90['kmh']:.0f} km/h: "
                             + (f"still {p90['short_min']} min late)" if p90["short_min"] > 0 else "in time - the proof rests on the speed estimate)"))
        parts.append(f"size {self.size}" + ("" if self.size_fits else " (too large)"))
        shift = ("no truck meets its window" if self.shift_short_min is None else
                 f"{self.shift_short_min} min over the shift" if self.shift_short_min > 0 else "fits the shift")
        parts.append(f"round trip {self.round_trip_min} min, {shift}")
        parts.append("any truck" if self.allowed is None else f"only {', '.join(self.allowed) or 'no truck'}")
        verdict = ("can be served on its own" if self.servable_alone else f"ruled out on its own by {', '.join(self.blocking)}")
        near = "; ".join(
            f"{n.truck_id} load {n.load_no} ({n.near_stop}, {n.km:.1f} km): {n.room_left:g} {n.measure} left"
            f"{'' if n.fits else ' (too little)'}, {n.time_left_min} min left, detour +{n.detour_min} min"
            f"{'' if n.window_ok else ', misses its window'}" for n in self.nearby)
        return f"{head}: {verdict}; " + "; ".join(parts) + (f". Nearby: {near}." if near else ".")


def _size_text(s: DispatchStop, tds: list[ds.TruckDay]) -> str:
    bay = [td for td in tds if td.by_pallets]
    case = [td for td in tds if not td.by_pallets]
    kg = [td.max_kg_units for td in tds if td.max_kg_units > 0]
    parts = []
    if bay:
        big = max(bay, key=ds._solo_room)
        parts.append(f"{_pal(s.demand_pallet_units or 0)} pallets vs largest {_pal(ds._solo_room(big))}")
    if case:
        parts.append(f"{s.demand_cases} cases vs largest {max(td.max_cases for td in case)}")
    if kg and s.demand_kg > 0:
        parts.append(f"{s.demand_kg:g} kg vs largest {max(kg) / 10:g}")
    return "; ".join(parts) or "no truck"


def _alone(req: DispatchRequest, tds: list[ds.TruckDay], geo: _Geo, s: DispatchStop, labels: dict[str, str],
           ctx: Context, ivms_agg: dict) -> Conflict:
    """The single-stop facts of ``s``: the engine's prefilter and window prefilter recomputed with their
    numbers (how far it misses), plus the IVMS speed check."""
    cfg = req.config
    usable = [td for td in tds if td.usable]
    allowed = [td for td in usable if ds.truck_allowed(s, td.truck)]
    fitting = [td for td in allowed if ds._fits_capacity(s, td)]
    out_m, out_s = geo.leg(geo.depot, _pos(s))
    back_s = geo.leg(_pos(s), geo.depot)[1]
    hs = (s.hard_start_min or 0) * 60
    he = LR.latest_start_s(s, cfg.window_rule)
    has_end = s.hard_end_min is not None
    blocking: list[str] = []
    if not usable:
        blocking.append("NO_TRUCK")
    elif not allowed:
        blocking.append("ALLOWED")
    elif not fitting:
        blocking.append("SIZE")
    trucks = fitting or allowed or usable
    depart = min((td.earliest_depart_s for td in trucks), default=None)
    arrive = depart + out_s if depart is not None else None
    short = max(0, _up_min(max(arrive, hs) - he)) if (arrive is not None and has_end) else 0
    if fitting and has_end and he < hs:  # FINISH rule: unloading longer than the receiving hours
        short = max(short, _up_min(hs - he))
    if fitting and short > 0:
        blocking.append("WINDOW")
    best: int | None = None
    for td in fitting:
        start = max(td.earliest_depart_s + out_s, hs)
        if start > he:
            continue
        limit = td.latest_return_s
        if td.shift_anchor_s is None:
            limit = min(limit, max(td.earliest_depart_s, start - out_s) + cfg.shift_max_min * 60)
        over = start + s.service_min * 60 + back_s - limit
        best = over if best is None else min(best, over)
    shift_short = max(0, _up_min(best)) if best is not None else None
    if fitting and short == 0 and shift_short is not None and shift_short > 0:
        blocking.append("SHIFT")
    ivms_check = None
    speeds = ivms_speeds(ivms_agg, depart / 60) if (ivms_agg and has_end and depart is not None) else None
    if speeds is not None:
        km = out_m / 1000
        ivms_check = {"band": speeds["band"], "n": speeds["n"], "basis": "IVMS Feb-Mar 2026, MOVING segments of 5 km+, "
                      "over the engine's estimated km"}
        for q in ("p50", "p90"):
            at = depart + km / speeds[q] * 3600
            ivms_check[q] = {"kmh": speeds[q], "arrival": _hhmm(at / 60), "short_min": max(0, _up_min(max(at, hs) - he))}
        ivms_check["robust"] = (ivms_check["p90"]["short_min"] > 0) if short > 0 else None
    return Conflict(
        stop_id=s.stop_id, label=labels[s.stop_id], priority=s.priority, cases=s.demand_cases,
        pallets=(s.demand_pallet_units / 1000) if s.demand_pallet_units is not None else None,
        provenance=ctx.window_provenance.get(s.stop_id, UNKNOWN),
        window=f"{_hhmm(s.hard_start_min or 0)}-{_hhmm(s.hard_end_min)}" if has_end else None,
        window_rule=cfg.window_rule, earliest_arrival=_hhmm(arrive / 60) if arrive is not None else None,
        latest_start=_hhmm(he / 60) if has_end else None, window_short_min=short, ivms=ivms_check,
        size=_size_text(s, allowed or usable), size_fits=bool(fitting),
        round_trip_min=_up_min(out_s + s.service_min * 60 + back_s), shift_short_min=shift_short,
        allowed=list(s.allowed_truck_ids) if s.allowed_truck_ids is not None else None,
        usable_trucks=len(usable), fitting_trucks=len(fitting), blocking=blocking,
    )


def _time_left(req: DispatchRequest, td: ds.TruckDay, loads: list, i: int) -> int:
    """Minutes the truck has after load ``i`` of ``loads`` (its new loads by departure): until its next load
    must leave (after the reload and loading), or until its day ends (latest return, shift from its first
    departure)."""
    cfg = req.config
    ld = loads[i]
    if i + 1 < len(loads):
        nxt = loads[i + 1]
        return int(nxt.depart_min - ld.return_min - cfg.reload_min - math.ceil(cfg.loading_min_per_case * nxt.cases))
    first = td.shift_anchor_s // 60 if td.shift_anchor_s is not None else loads[0].depart_min
    return int(min(td.latest_return_s // 60, first + cfg.shift_max_min) - ld.return_min)


def _nearby(req: DispatchRequest, sc: DispatchScenario, tds: list[ds.TruckDay], geo: _Geo, s: DispatchStop,
            labels: dict[str, str], near_km: float) -> list[Nearby]:
    by_id = {x.stop_id: x for x in req.stops}
    td_of = {td.truck.id: td for td in tds}
    hs = (s.hard_start_min or 0) * 60
    he = LR.latest_start_s(s, req.config.window_rule)
    by_truck: dict[str, list] = {}
    for ld in sc.loads:
        by_truck.setdefault(ld.truck_id, []).append(ld)
    out: list[Nearby] = []
    for truck_id, loads in by_truck.items():
        loads.sort(key=lambda x: x.depart_min)
        td = td_of[truck_id]
        for i, ld in enumerate(loads):
            if not ld.stops:
                continue
            dists = [geo.leg(_pos(by_id[st.stop_id]), _pos(s))[0] / 1000 for st in ld.stops]
            k = min(range(len(dists)), key=lambda j: (dists[j], j))
            if dists[k] > near_km:
                continue
            members = [by_id[st.stop_id] for st in ld.stops]
            need = ds._need_in(s, td.by_pallets)
            left = ds.load_room(td, members + [s]) - sum(ds._need_in(x, td.by_pallets) for x in members)
            kg_ok = td.max_kg_units <= 0 or (sum(x.demand_kg for x in members) + s.demand_kg) * 10 <= td.max_kg_units + 1e-9
            prev = members[k]
            nxt = _pos(members[k + 1]) if k + 1 < len(members) else geo.depot
            d1, d2, d0 = geo.leg(_pos(prev), _pos(s))[1], geo.leg(_pos(s), nxt)[1], geo.leg(_pos(prev), nxt)[1]
            arrive = ld.stops[k].departure_min * 60 + d1
            start = max(arrive, hs)
            out.append(Nearby(
                truck_id=truck_id, load_no=ld.load_no, near_stop=labels[prev.stop_id], km=round(dists[k], 1),
                measure="pallets" if td.by_pallets else "cases",
                room_left=round(left / 1000, 2) if td.by_pallets else left,
                fits=ds.truck_allowed(s, td.truck) and need <= left and kg_ok,
                time_left_min=_time_left(req, td, loads, i),
                detour_min=_up_min(d1 + (start - arrive) + s.service_min * 60 + d2 - d0), window_ok=start <= he,
            ))
    out.sort(key=lambda n: (n.km, n.truck_id, n.load_no))
    return out[:MAX_NEARBY]


def conflicts(req: DispatchRequest, response: DispatchResponse, name: str = "RECOMMENDED", *, ctx=None,
              near_km: float = NEAR_KM, stop_ids: list[str] | None = None) -> dict[str, Conflict]:
    """The binding-constraint candidates of every unserved stop of scenario ``name`` (or of ``stop_ids``),
    keyed by stop id in label order. Minutes are HAVERSINE estimates, as the engine's offline runs use."""
    c = _context(ctx)
    sc = _scenario(response, name)
    labels = core.label_stops(req)
    by_id = {s.stop_id: s for s in req.stops}
    ids = stop_ids if stop_ids is not None else [u.stop_id for u in sc.unserved]
    tds = ds._truck_days(req)
    geo = _Geo(req)
    out: dict[str, Conflict] = {}
    for sid in sorted(ids, key=lambda x: labels[x]):
        conflict = _alone(req, tds, geo, by_id[sid], labels, c, c.aggregates)
        conflict.nearby = _nearby(req, sc, tds, geo, by_id[sid], labels, near_km)
        out[sid] = conflict
    return out


# ------------------------------------------------------------------------------------------------
# Verdict
# ------------------------------------------------------------------------------------------------

_PROOF_NOTES = {
    "EXCEEDS_ANY_TRUCK_CAPACITY": "proven: larger than every truck that can take a load today",
    "NO_ALLOWED_TRUCK": "proven: none of the trucks it may go on can carry it today",
    "NO_AVAILABLE_TRUCK": "proven: no truck can take a new load today",
    "TRIP_LIMIT": "proven: no truck has a load left today",
    "HARD_WINDOW_INFEASIBLE": "proven: no truck can reach it inside its receiving hours (estimated drive times)",
    "NO_ROOM": "proven: with every stop of the same or higher priority on board, no packing has room for it "
               "(capacity only)",
    "FLEET_SHORTAGE": "proven for the day, not for this stop: the trucks cannot carry every stop; which stops "
                      "stay out is the search's choice",
}
_SHIFT_NOTES = {"WINDOW": "proven: no round trip to it fits the shift or depot hours (estimated drive times)",
                "PREFILTER": "proven: no truck has shift time left for a new load today"}
_UNPROVEN_DETAIL = {
    # A shortage proves only that some stops stay out; with a lower priority riding, not that this one must.
    "FLEET_SHORTAGE": " (the trucks cannot carry every stop, but which stops stay out is the search's choice)",
    "TIMING": " (cut when its truck's loads were timed exactly)",
    "HIRE_POLICY": " (no truck is rented for P4/P5 orders alone; not proven impossible on the own trucks)",
    "LATE": " (a late order, no room left)",
    "SEARCH": "",
}


@dataclass
class StopVerdict:
    """Why one stop is unserved. ``verdict``: PROVEN_INFEASIBLE, SEARCH_FAILURE or MODEL_ERROR_SUSPECTED.
    ``kind``: core.proof_kind. ``proof``: the engine reason a proof rests on (or NO_ROOM / FLEET_SHORTAGE),
    None when unproven. ``scope``: STOP (about this stop) or DAY (the day as a whole). ``confirmed``: our own
    one-stop check agrees with the engine's one-stop proof (None when it is not a one-stop proof).
    ``lower_served``: planned stops of a lower priority (with strict priorities, a sign that it may have been
    cut on one truck while lower priorities ride on others: the known per-truck trim issue)."""

    stop_id: str
    label: str
    priority: int
    cases: int
    verdict: str
    kind: str
    proof: str | None
    scope: str | None
    confirmed: bool | None
    reason_code: str
    lower_served: int
    note: str


@dataclass
class Verdict:
    """One run (scenario): PLANNED (nothing left out), PROVEN_INFEASIBLE (every stop left out has a proof),
    SEARCH_FAILURE (a stop left out without proof, or no plan with a timeout) or MODEL_ERROR_SUSPECTED."""

    verdict: str
    scenario: str
    status: str
    solver_status: str
    solver_time_sec: float
    time_limit_sec: int
    stops_total: int
    stops_served: int
    note: str
    stops: list[StopVerdict]

    def counts(self) -> dict[str, int]:
        return dict(sorted(Counter(v.verdict for v in self.stops).items()))

    def to_dict(self) -> dict:
        return asdict(self) | {"counts": self.counts()}

    def to_markdown(self) -> str:
        lines = [f"**{self.verdict}** ({self.scenario}: {self.status}, {self.solver_status}, solved in "
                 f"{self.solver_time_sec:.1f} s with the load re-check, search limit {self.time_limit_sec} s; "
                 f"{self.stops_served} of {self.stops_total} stops served). {self.note}"]
        if self.stops:
            lines += ["", "| stop | P | cases | verdict | proof | checked | note |", "|---|---|---|---|---|---|---|"]
            for v in self.stops:
                checked = {True: "agrees", False: "DISAGREES", None: "-"}[v.confirmed]
                lines.append(f"| {v.label} | {v.priority} | {v.cases} | {v.verdict} | {v.proof or '-'} "
                             f"({v.scope or v.kind}) | {checked} | {v.note} |")
        return "\n".join(lines)


def _fast(sec: float, limit: int) -> bool:
    """No plan well before the search's time limit: under MODEL_ERROR_SEC, or MODEL_ERROR_SHARE of the limit."""
    return sec < max(MODEL_ERROR_SEC, MODEL_ERROR_SHARE * limit)


def verdict(req: DispatchRequest, response: DispatchResponse, name: str = "RECOMMENDED") -> Verdict:
    """The verdict of scenario ``name`` of ``response`` for the request it answers. An option the engine's
    second search (PyVRP) rescued after its main route search found no plan is checked for the same model-error
    signature as a run with no plan at all."""
    sc = _scenario(response, name)
    labels = core.label_stops(req)
    by_id = {s.stop_id: s for s in req.stops}
    tds = ds._truck_days(req)
    geo = _Geo(req)
    ctx = Context(aggregates={})
    kinds = {u.stop_id: core.proof_kind(u) for u in sc.unserved}
    alone = {u.stop_id: _alone(req, tds, geo, by_id[u.stop_id], labels, ctx, {}) for u in sc.unserved}

    run = None
    if sc.status == "NO_SOLUTION":
        no_plan = [u.stop_id for u in sc.unserved if kinds[u.stop_id] == "NO_PLAN"]
        servable = bool(no_plan) and all(alone[sid].servable_alone for sid in no_plan)
        suspicious = _fast(sc.solver_time_sec, sc.time_limit_sec) or sc.solver_status in MODEL_STATUSES
        if servable and suspicious and sc.solver_status != "ROUTING_FAIL_TIMEOUT":
            run = MODEL_ERROR_SUSPECTED
            run_note = (f"The search returned no plan in {sc.solver_time_sec:.1f} s ({sc.solver_status}) while every "
                        "stop it searched can be served on its own, and every stop is optional, so an empty plan "
                        "is always feasible: a model error is suspected (the 14 Oct 2026 signature, fixed in PR #71).")
        else:
            run = SEARCH_FAILURE
            run_note = (f"The search returned no plan ({sc.solver_status}, {sc.solver_time_sec:.1f} s): "
                        f"{UNPROVEN_NOTE}.")

    served_p = Counter(by_id[sid].priority for sid in _served(sc))
    stops: list[StopVerdict] = []
    for u in sorted(sc.unserved, key=lambda x: labels[x.stop_id]):
        k, s, a = kinds[u.stop_id], by_id[u.stop_id], alone[u.stop_id]
        lower = sum(n for p, n in served_p.items() if p > s.priority)
        proof = scope = confirmed = None
        if k in core.PROVEN_KINDS:
            v, scope = PROVEN_INFEASIBLE, "STOP"
            proof = "NO_ROOM" if k == "NO_ROOM" else u.reason_code
            note = _SHIFT_NOTES[k] if u.reason_code == "SHIFT_LIMIT" else _PROOF_NOTES.get(proof, "proven")
            if k in _SINGLE_STOP_KINDS:
                confirmed = not a.servable_alone
        elif k == "FLEET_SHORTAGE" and not lower:
            v, scope, proof, note = PROVEN_INFEASIBLE, "DAY", "FLEET_SHORTAGE", _PROOF_NOTES["FLEET_SHORTAGE"]
        elif k == "NO_PLAN":
            v = run or SEARCH_FAILURE
            note = ("no plan at all; " + ("it can be served on its own" if a.servable_alone else
                                          f"ruled out on its own by {', '.join(a.blocking)}"))
        else:
            v, note = SEARCH_FAILURE, UNPROVEN_NOTE + _UNPROVEN_DETAIL.get(k, "")
            if lower:
                note += f"; {lower} lower-priority stop(s) are served"
        stops.append(StopVerdict(stop_id=u.stop_id, label=labels[u.stop_id], priority=s.priority, cases=s.demand_cases,
                                 verdict=v, kind=k, proof=proof, scope=scope, confirmed=confirmed,
                                 reason_code=u.reason_code, lower_served=lower, note=note))

    if run is None:
        unproven = [v for v in stops if v.verdict == SEARCH_FAILURE]
        if not stops:
            run, run_note = PLANNED, "Every stop is planned (the best plan found, not proven optimal)."
        elif unproven:
            run = SEARCH_FAILURE
            run_note = f"{len(unproven)} stop(s) left out without a proof, {UNPROVEN_NOTE}."
        else:
            run = PROVEN_INFEASIBLE
            run_note = f"Every stop left out ({len(stops)}) has a proof."
    if sc.solver_status == RESCUED:
        # The main route search found no plan; the engine's second search (on by default) found this one.
        search = response.search if name == "RECOMMENDED" else None
        main_sec = search.search_sec if search is not None else sc.solver_time_sec
        if _fast(main_sec, search.limit_sec if search is not None else sc.time_limit_sec):
            run = MODEL_ERROR_SUSPECTED
            run_note = (f"The main route search returned no plan in {main_sec:.1f} s, and every stop is optional, so "
                        "an empty plan is always feasible: a model error is suspected (the 14 Oct 2026 signature, "
                        "fixed in PR #71). The engine's second search (PyVRP) found the plan below, so the plan is "
                        "usable. " + run_note)
        else:
            run_note += " The main route search found no plan in its time; the engine's second search found this one."
    return Verdict(verdict=run, scenario=name, status=sc.status, solver_status=sc.solver_status,
                   solver_time_sec=round(sc.solver_time_sec, 2), time_limit_sec=sc.time_limit_sec,
                   stops_total=len(req.stops), stops_served=len(_served(sc)), note=run_note, stops=stops)


# ------------------------------------------------------------------------------------------------
# Relaxations (levers)
# ------------------------------------------------------------------------------------------------

class Relaxation(Protocol):
    """A change to the request. ``apply`` returns a new request and refuses (ValueError) anything the ground
    rules forbid."""

    kind: str
    hypothetical: bool
    requires_evidence: bool

    def label(self, labels: dict[str, str]) -> str: ...
    def phrase(self, labels: dict[str, str]) -> str: ...
    def basis(self, ctx: Context) -> str: ...
    def apply(self, req: DispatchRequest, ctx: Context) -> DispatchRequest: ...


def _tier(r: Relaxation) -> str:
    return "REQUIRES_EVIDENCE" if r.requires_evidence else "HYPOTHETICAL" if r.hypothetical else "ACTIONABLE"


@dataclass(frozen=True)
class WindowFlex:
    """A stop's closing time + ``minutes`` (START rule: the latest arrival; FINISH: the latest finish). Only a
    SALES_PREFERENCE window, or an UNKNOWN one in a variant labelled HYPOTHETICAL; never past the customer's
    genuine hours when they are known; never a CUSTOMER_HARD window."""

    stop_id: str
    minutes: int
    hypothetical: bool = False  # True: flexes an UNKNOWN window (needs confirmation that it is a preference)
    kind: ClassVar[str] = "WINDOW"
    requires_evidence: ClassVar[bool] = False

    def label(self, labels: dict[str, str]) -> str:
        what = "UNKNOWN, HYPOTHETICAL" if self.hypothetical else SALES_PREFERENCE
        return f"{labels[self.stop_id]} window +{self.minutes} min ({what})"

    def phrase(self, labels: dict[str, str]) -> str:
        return f"Extending {labels[self.stop_id]}'s window by {self.minutes} minutes"

    def basis(self, ctx: Context) -> str:
        if not self.hypothetical:
            return "the window is labelled SALES_PREFERENCE (a salesman's request, not the customer's closing time)"
        claims = _window_claims(ctx.aggregates)
        return "HYPOTHETICAL - needs confirmation that this window is a preference" + (f"; {claims}" if claims else "")

    def apply(self, req: DispatchRequest, ctx: Context) -> DispatchRequest:
        # An allow-list: only SALES_PREFERENCE flexes today; any other label (a misspelt or a new one) counts
        # as UNKNOWN and flexes only in a HYPOTHETICAL variant.
        prov = ctx.window_provenance.get(self.stop_id, UNKNOWN)
        if prov == CUSTOMER_HARD:
            raise ValueError(f"{self.stop_id}: a CUSTOMER_HARD window is a genuine closing time and is never relaxed")
        if prov != SALES_PREFERENCE and not self.hypothetical:
            raise ValueError(f"{self.stop_id}: a {prov} window is not a SALES_PREFERENCE; it flexes only in a variant "
                             "labelled HYPOTHETICAL")
        out = req.model_copy(deep=True)
        s = next((x for x in out.stops if x.stop_id == self.stop_id), None)
        if s is None or s.hard_end_min is None:
            raise ValueError(f"{self.stop_id}: no closing time to extend")
        end = s.hard_end_min + self.minutes
        genuine = ctx.genuine_hours.get(self.stop_id)
        if end > DAY_MIN or (genuine is not None and end > genuine[1]):
            raise ValueError(f"{self.stop_id}: +{self.minutes} min goes past the customer's genuine hours or the day")
        s.hard_end_min = end
        return out


@dataclass(frozen=True)
class ExtraTrip:
    """One more load for a truck (its max_trips + 1). Shift, return, break and capacity stay as they are."""

    truck_id: str
    kind: ClassVar[str] = "TRIP"
    hypothetical: ClassVar[bool] = False
    requires_evidence: ClassVar[bool] = False

    def label(self, labels: dict[str, str]) -> str:
        return f"{self.truck_id} +1 load"

    def phrase(self, labels: dict[str, str]) -> str:
        return f"Allowing {self.truck_id} one more load"

    def basis(self, ctx: Context) -> str:
        return "a company setting (loads per truck per day); shift, return and break limits unchanged"

    def apply(self, req: DispatchRequest, ctx: Context) -> DispatchRequest:
        out = req.model_copy(deep=True)
        t = next((x for x in out.trucks if x.id == self.truck_id), None)
        if t is None:
            raise ValueError(f"no truck {self.truck_id}")
        trips = (t.max_trips or out.config.max_trips_per_truck) + 1
        if trips > 10:
            raise ValueError(f"{self.truck_id}: already at 10 loads, the most a truck may have")
        t.max_trips = trips
        return out


def _truck_text(t: DispatchTruck) -> str:
    size = f"{t.bays} bays" if t.bays else f"{t.capacity_cases} cases"
    driver = f" + driver {t.driver_day_cost:.2f}" if t.driver_day_cost else ""
    return f"{size}, hire {t.fixed_cost:.2f} OMR/day{driver}"


def _hire_id(req: DispatchRequest) -> str:
    ids = {t.id for t in req.trucks}
    return next(f"hire-{i}" for i in range(1, len(ids) + 2) if f"hire-{i}" not in ids)


@dataclass(frozen=True)
class HireTruck:
    """One more rented truck, copied from an existing hire option (a hire_candidate truck with its real hire
    price): never an invented truck or price. The engine's hire rules apply (no truck is rented for P4/P5
    orders alone), and its hire check runs as in production (up to 6 extra solves)."""

    truck: DispatchTruck
    kind: ClassVar[str] = "HIRE"
    hypothetical: ClassVar[bool] = False
    requires_evidence: ClassVar[bool] = False

    def label(self, labels: dict[str, str]) -> str:
        return f"hire 1 truck ({_truck_text(self.truck)})"

    def phrase(self, labels: dict[str, str]) -> str:
        return f"Hiring one more truck ({_truck_text(self.truck)})"

    def basis(self, ctx: Context) -> str:
        return "an existing hire option at its own hire price; the engine's hire rules and hire check apply"

    def apply(self, req: DispatchRequest, ctx: Context) -> DispatchRequest:
        if not self.truck.hire_candidate:
            raise ValueError("only an existing hire option (hire_candidate) may be added")
        out = req.model_copy(deep=True)
        new = self.truck.model_copy(deep=True)
        new.id = new.code = _hire_id(out)
        new.frozen_trips = []
        out.trucks.append(new)
        return out


@dataclass(frozen=True)
class ShiftExtend:
    """HYPOTHETICAL (needs driver agreement): the shift and the latest return + ``minutes``. Depot hours,
    breaks and every customer's hours stay as they are."""

    minutes: int = SHIFT_MINUTES
    kind: ClassVar[str] = "SHIFT"
    hypothetical: ClassVar[bool] = True
    requires_evidence: ClassVar[bool] = False

    def label(self, labels: dict[str, str]) -> str:
        return f"shift and latest return +{self.minutes} min (HYPOTHETICAL)"

    def phrase(self, labels: dict[str, str]) -> str:
        return f"Extending the shift and the latest return by {self.minutes} minutes"

    def basis(self, ctx: Context) -> str:
        seen = _fleet_value(ctx.aggregates, "Latest return")
        return "HYPOTHETICAL - needs driver agreement" + (f"; truck evidence, latest return to depot: {seen}" if seen else "")

    def apply(self, req: DispatchRequest, ctx: Context) -> DispatchRequest:
        out = req.model_copy(deep=True)
        cfg = out.config
        cfg.shift_max_min = min(DAY_MIN, cfg.shift_max_min + self.minutes)
        if cfg.latest_return_min is not None:
            cfg.latest_return_min = min(2 * DAY_MIN, cfg.latest_return_min + self.minutes)
        return out


@dataclass(frozen=True)
class FasterUnloading:
    """REQUIRES EVIDENCE: every stop's per-case unloading part (``per_case_min`` x cases, at most its stop
    time) shortened by ``share``, by the same rule as the what-if lever (whatif.faster_service_min). The base
    part of the stop time is kept. Never part of a baseline."""

    share: float
    per_case_min: float = SERVICE_PER_CASE
    visits: int = 0  # the evidence behind ``share`` (0: given by the caller)
    kind: ClassVar[str] = "UNLOADING"
    hypothetical: ClassVar[bool] = False
    requires_evidence: ClassVar[bool] = True

    def label(self, labels: dict[str, str]) -> str:
        return f"unloading {self.share:.0%} faster per case (REQUIRES EVIDENCE)"

    def phrase(self, labels: dict[str, str]) -> str:
        return f"Unloading {self.share:.0%} faster per case"

    def basis(self, ctx: Context) -> str:
        src = (f"the best-quartile visits are {self.share:.0%} shorter than the median (13 Oct truck evidence, time "
               f"on site per chain, visit-weighted median of 1 - p25/p50 over {self.visits} visits)"
               if self.visits else "a caller assumption")
        return f"REQUIRES EVIDENCE - {src}; applied to the per-case part only ({self.per_case_min} min per case)"

    def apply(self, req: DispatchRequest, ctx: Context) -> DispatchRequest:
        if not 0 < self.share < 1:
            raise ValueError("share must be between 0 and 1")
        out = req.model_copy(deep=True)
        for s in out.stops:
            s.service_min = whatif.faster_service_min(s, self.per_case_min, self.share)
        return out


def candidates_for(req: DispatchRequest, responses: DispatchResponse | list[DispatchResponse], ctx=None, *,
                   minutes: tuple[int, ...] = FLEX_MINUTES, max_stops: int = 5, max_trucks: int = 3,
                   max_hires: int = 2, shift_min: int | None = SHIFT_MINUTES, unloading: bool = True,
                   name: str = "RECOMMENDED") -> list[Relaxation]:
    """The candidate relaxations for the stops the responses (one per seed) left out:
    - window +minutes for the highest-priority ``max_stops`` of them whose window is the only thing ruling
      them out on their own (or nothing does): SALES_PREFERENCE windows, UNKNOWN ones only when
      ctx.hypothetical (labelled HYPOTHETICAL); a minute value smaller than its shortfall is skipped;
    - +1 load on the trucks (at most ``max_trucks``) that used every load and could carry one of them;
    - one more rented truck of each hire option (ctx.hire_options and the request's hire_candidate trucks),
      cheapest first, that could carry one of them;
    - the shift + ``shift_min`` (HYPOTHETICAL);
    - faster unloading by the IVMS evidence gap (REQUIRES EVIDENCE).
    Nothing when every stop is served."""
    c = _context(ctx)
    scs = [_scenario(r, name) for r in (responses if isinstance(responses, list) else [responses])]
    labels = core.label_stops(req)
    by_id = {s.stop_id: s for s in req.stops}
    ids = sorted({u.stop_id for sc in scs for u in sc.unserved}, key=lambda x: (by_id[x].priority, labels[x]))
    if not ids:
        return []
    tds = ds._truck_days(req)
    geo = _Geo(req)
    out: list[Relaxation] = []
    for sid in ids[:max_stops]:
        s, a = by_id[sid], _alone(req, tds, geo, by_id[sid], labels, c, {})
        prov = c.window_provenance.get(sid, UNKNOWN)
        if s.hard_end_min is None or set(a.blocking) - {"WINDOW"} or prov == CUSTOMER_HARD:
            continue
        if prov != SALES_PREFERENCE and not c.hypothetical:
            continue
        end = min(DAY_MIN, (c.genuine_hours.get(sid) or (0, DAY_MIN))[1])
        out += [WindowFlex(sid, m, hypothetical=prov != SALES_PREFERENCE) for m in minutes
                if m >= a.window_short_min and s.hard_end_min + m <= end]
    unserved = [by_id[sid] for sid in ids]
    full = [td for td in tds if td.usable and (td.truck.max_trips or req.config.max_trips_per_truck) < 10
            and any(sum(1 for ld in sc.loads if ld.truck_id == td.truck.id) >= td.trips_left for sc in scs)
            and any(ds._fits_capacity(s, td) for s in unserved)]
    out += [ExtraTrip(td.truck.id) for td in full[:max_trucks]]
    options: dict[tuple, DispatchTruck] = {}
    for t in list(c.hire_options) + [t for t in req.trucks if t.hire_candidate]:
        key = (t.bays, t.capacity_cases, t.capacity_kg, t.fixed_cost, t.cost_per_km, t.driver_day_cost, t.max_trips)
        options.setdefault(key, t)
    hires = []
    for t in sorted(options.values(), key=lambda t: (t.fixed_cost + (t.driver_day_cost or 0), t.capacity_cases, t.bays or 0)):
        variant = HireTruck(t).apply(req, c)
        td = ds._truck_days(variant)[-1]
        if td.usable and any(ds._fits_capacity(s, td) for s in unserved):
            hires.append(HireTruck(t))
    out += hires[:max_hires]
    if shift_min:
        out.append(ShiftExtend(shift_min))
    gap = unloading_gap(c.aggregates) if unloading else None
    if gap is not None:
        out.append(FasterUnloading(gap[0], c.per_case_min, gap[1]))
    return out


# ------------------------------------------------------------------------------------------------
# Ranking
# ------------------------------------------------------------------------------------------------

def relaxation_sentence(phrase: str, cash: dict, n_seeds: int, gain: dict, gained: list[str], lost: list[str],
                        tier: str = "ACTIONABLE") -> str:
    """The plain-words result of one relaxation, e.g. "Extending stop-017's window by 10 minutes changes cash
    cost by +0.84 OMR (range +0.61..+1.02 over 3 seeds) and allows 2 more deliveries (stop-031, stop-044)."
    ``cash`` and ``gain`` are paired deltas (mean / min / max over the seeds); ``gained`` / ``lost`` the stops
    served in more / fewer seeds than the base. When the seeds disagree, or stops are also lost, the sentence
    gives the average and names both lists."""
    seeds = f"{n_seeds} seed{'' if n_seeds == 1 else 's'}"
    head = (f"{_TIER_PREFIX[tier]}{phrase} changes cash cost by {_omr(cash['mean'])} OMR (range {_omr(cash['min'])}.."
            f"{_omr(cash['max'])} over {seeds}) and ")
    mean, lo, hi = gain["mean"], gain["min"], gain["max"]
    same = lo == hi and float(mean).is_integer()
    if same and not lost and len(gained) == max(0, int(mean)):
        n = int(mean)
        if n == 0:
            return head + "allows no more deliveries."
        return head + f"allows {n} more deliver{'y' if n == 1 else 'ies'} ({', '.join(gained)})."
    count = f"changes deliveries by {int(mean):+d}" if same else f"changes deliveries by {mean:+g} on average (range {lo:+g}..{hi:+g})"
    parts = ([f"newly served: {', '.join(gained)}"] if gained else []) + ([f"no longer served: {', '.join(lost)}"] if lost else [])
    return head + count + (f" ({'; '.join(parts)})" if parts else "") + "."


def late_minutes(orig: DispatchRequest, sc: DispatchScenario) -> int:
    """Minutes the planned stops start after their ORIGINAL due time: the preferred end where one is set,
    else the closing time (the window rule's latest start). A relaxed window is measured against the
    window it had before."""
    by_id = {s.stop_id: s for s in orig.stops}
    rule = orig.config.window_rule
    total = 0
    for ld in sc.loads:
        for st in ld.stops:
            s = by_id[st.stop_id]
            due = [b for b in (LR.pref_end_bound_s(s, rule), LR.latest_start_s(s, rule) if s.hard_end_min is not None else None)
                   if b is not None]
            if due:
                total += max(0, st.service_start_min - min(due) // 60)
    return total


@dataclass
class RelaxationResult:
    """One relaxation re-solved with the base's budget and seeds. Deltas are variant - base, paired per seed:
    cash in OMR, stops and cases served, minutes late against the original windows."""

    relaxation: Relaxation = field(repr=False)
    label: str
    phrase: str
    kind: str
    tier: str
    basis: str
    seeds: list[int]
    stops_gained: dict
    cases_gained: dict
    cash_delta: dict
    late_min_delta: dict
    gained: list[str]  # stops it serves in more seeds than the base does
    lost: list[str]  # stops it serves in fewer seeds
    feasibility: dict[str, int]
    wall_sec: float
    runs: list[core.RunResult] = field(default_factory=list, repr=False)

    @property
    def sentence(self) -> str:
        return relaxation_sentence(self.phrase, self.cash_delta, len(self.seeds), self.stops_gained, self.gained,
                                   self.lost, self.tier)

    @property
    def gains_every_seed(self) -> bool:
        """It serves more stops in every seed: a gain that is not only search noise."""
        return self.stops_gained["min"] > 0

    def to_dict(self) -> dict:
        d = {k: v for k, v in asdict(self).items() if k not in ("relaxation", "runs")}
        return d | {"sentence": self.sentence, "gains_every_seed": self.gains_every_seed}


def _rank_key(r: RelaxationResult) -> tuple:
    """Tier first (usable today, then HYPOTHETICAL, then REQUIRES_EVIDENCE); a variant with a plan that fails
    the independent check after one that passes; then stops gained, cases gained (more first), cash delta
    (less first) and the label."""
    return (TIERS.index(r.tier), r.feasibility.get("VERIFIED", 0) != len(r.seeds), -r.stops_gained["mean"],
            -r.cases_gained["mean"], r.cash_delta["mean"], r.label)


def _result(cand: Relaxation, labels: dict[str, str], ctx: Context, orig: DispatchRequest,
            base_runs: list[core.RunResult], base_sum: dict, runs: list[core.RunResult]) -> RelaxationResult:
    summary = core.summarize(runs)
    d = core.diff(base_sum, summary)["metrics"]
    base_n = Counter(sid for r in base_runs for sid in _served(_scenario(r.response, "RECOMMENDED")))
    var_n = Counter(sid for r in runs for sid in _served(_scenario(r.response, "RECOMMENDED")))
    late = [late_minutes(orig, _scenario(v.response, "RECOMMENDED")) - late_minutes(orig, _scenario(b.response, "RECOMMENDED"))
            for b, v in zip(base_runs, runs)]
    return RelaxationResult(
        relaxation=cand, label=cand.label(labels), phrase=cand.phrase(labels), kind=cand.kind, tier=_tier(cand),
        basis=cand.basis(ctx), seeds=[r.seed for r in runs],
        stops_gained={k: d["stops_served"][k] for k in ("mean", "min", "max")},
        cases_gained={k: d["cases_served"][k] for k in ("mean", "min", "max")},
        cash_delta={k: d["cash.total"][k] for k in ("mean", "min", "max")},
        late_min_delta={k: v for k, v in _mmm(late).items() if k != "values"},
        gained=sorted(labels[s] for s in set(var_n) | set(base_n) if var_n[s] > base_n[s]),
        lost=sorted(labels[s] for s in set(var_n) | set(base_n) if var_n[s] < base_n[s]),
        feasibility=summary["feasibility"], wall_sec=round(sum(r.wall_sec for r in runs), 2), runs=runs,
    )


@dataclass
class Ranking:
    """The ranked relaxations (``rows``, best first) and the base they are measured against."""

    budget: core.Budget
    base: dict  # core.summarize of the base runs
    rows: list[RelaxationResult]
    base_runs: list[core.RunResult] = field(default_factory=list, repr=False)

    def known(self) -> dict[str, list[core.RunResult]]:
        """The runs already solved, by frontier label (frontier(..., known=...)): the base as RECOMMENDED."""
        return {"RECOMMENDED": self.base_runs} | {r.label: r.runs for r in self.rows}

    def configs(self, n: int | None = None, *, gaining: bool = True) -> list["FrontierConfig"]:
        """Frontier configurations of the first ``n`` rows (only those that serve more, by default)."""
        rows = [r for r in self.rows if r.stops_gained["mean"] > 0 or not gaining][:n]
        return [FrontierConfig(r.label, "RECOMMENDED", r.relaxation) for r in rows]

    def to_dict(self) -> dict:
        return {"budget": asdict(self.budget), "base": self.base, "rows": [r.to_dict() for r in self.rows],
                "labels": dict(core.LABELS)}

    def to_markdown(self) -> str:
        b = self.base["metrics"]
        lines = [f"Base: {b['stops_served']['mean']:g} of {b['stops_total']['mean']:g} stops served (range "
                 f"{b['stops_served']['min']:g}..{b['stops_served']['max']:g}), cash {b['cash.total']['mean']:.2f} OMR "
                 f"(range {b['cash.total']['min']:.2f}..{b['cash.total']['max']:.2f}); budget {self.budget.time_limit_sec} s "
                 f"{self.budget.search_mode}, seeds {list(self.budget.seeds)}. Deltas are paired per seed; a gain that "
                 "does not hold in every seed may be search noise. Plans are the best found, not proven optimal; km "
                 "are estimated."]
        titles = {"ACTIONABLE": "Relaxations usable today",
                  "HYPOTHETICAL": "HYPOTHETICAL (needs a confirmation or an agreement)",
                  "REQUIRES_EVIDENCE": "Operational improvement potential (requires evidence)"}
        for tier in TIERS:
            rows = [r for r in self.rows if r.tier == tier]
            if not rows:
                continue
            lines += ["", f"**{titles[tier]}**", "",
                      "| # | relaxation | stops | every seed | cases | cash OMR (range) | late min | gained | checks | basis |",
                      "|---|---|---|---|---|---|---|---|---|---|"]
            for i, r in enumerate(rows, start=1):
                cash = f"{_omr(r.cash_delta['mean'])} ({_omr(r.cash_delta['min'])}..{_omr(r.cash_delta['max'])})"
                checks = ", ".join(f"{k} {v}" for k, v in r.feasibility.items())
                lines.append(f"| {i} | {r.label} | {r.stops_gained['mean']:+g} | {'yes' if r.gains_every_seed else 'no'} | "
                             f"{r.cases_gained['mean']:+g} | {cash} | {r.late_min_delta['mean']:+g} | "
                             f"{', '.join(r.gained) or '-'} | {checks} | {r.basis} |")
            lines += [""] + [f"- {r.sentence}" for r in rows]
        lines += ["", f"Cash: {core.LABELS['cash']}. Penalties are {core.LABELS['penalties']}."]
        return "\n".join(lines)


def rank_relaxations(req: DispatchRequest, candidates: list[Relaxation], budget: core.Budget, ctx=None, *,
                     base: list[core.RunResult] | None = None) -> Ranking:
    """Re-solve each candidate with the same budget and seeds as the base (``base``: the base runs when
    already solved, one per budget seed), and rank them (_rank_key)."""
    c = _context(ctx)
    base_runs = base if base is not None else core.solve_seeds(req, budget)
    if [r.seed for r in base_runs] != list(budget.seeds):
        raise ValueError("the base runs must be one per budget seed, in order")
    base_sum = core.summarize(base_runs)
    labels = core.label_stops(req)
    rows = [_result(cand, labels, c, req, base_runs, base_sum, core.solve_seeds(cand.apply(req, c), budget))
            for cand in candidates]
    rows.sort(key=_rank_key)
    return Ranking(budget=budget, base=base_sum, rows=rows, base_runs=base_runs)


# ------------------------------------------------------------------------------------------------
# Frontier
# ------------------------------------------------------------------------------------------------

@dataclass(frozen=True)
class FrontierConfig:
    """One point to compare: an engine scenario (RECOMMENDED / MIN_TRUCKS / MIN_DISTANCE), on the request or
    on a relaxation of it."""

    label: str
    scenario: str = "RECOMMENDED"
    relaxation: Relaxation | None = None


def scenario_configs() -> list[FrontierConfig]:
    """The engine's three plan options on the request as it is."""
    return [FrontierConfig(n, n) for n in ("RECOMMENDED", "MIN_TRUCKS", "MIN_DISTANCE")]


@dataclass
class FrontierPoint:
    """Mean / min / max over the seeds. ``dominated_by``: a point at least as good on cash, stops served and
    minutes late, and better on one (None: on the frontier)."""

    label: str
    scenario: str
    flags: list[str]
    cash: dict  # OMR
    served: dict  # stops
    late_min: dict  # minutes late against the original windows (late_minutes)
    trucks: dict
    km: dict  # estimated km
    feasibility: dict[str, int]
    dominated_by: str | None = None


def dominates(a: FrontierPoint, b: FrontierPoint, eps: float = 1e-6) -> bool:
    """``a`` is at least as good as ``b`` on mean cash (lower), stops served (higher) and minutes late
    (lower), and strictly better on one. A point that needs something ``b`` does not (a flag: HYPOTHETICAL or
    REQUIRES_EVIDENCE) never dominates it: such a lever is not an option today (DESIGN.md section 0)."""
    if not set(a.flags) <= set(b.flags):
        return False
    no_worse = (a.cash["mean"] <= b.cash["mean"] + eps and a.served["mean"] >= b.served["mean"] - eps
                and a.late_min["mean"] <= b.late_min["mean"] + eps)
    better = (a.cash["mean"] < b.cash["mean"] - eps or a.served["mean"] > b.served["mean"] + eps
              or a.late_min["mean"] < b.late_min["mean"] - eps)
    return no_worse and better


def mark_dominated(points: list[FrontierPoint]) -> list[FrontierPoint]:
    """Set each point's ``dominated_by`` (the first point that dominates it); returns the non-dominated ones.
    Equal points do not dominate each other: both stay."""
    for p in points:
        p.dominated_by = next((q.label for q in points if q is not p and dominates(q, p)), None)
    return [p for p in points if p.dominated_by is None]


@dataclass
class Frontier:
    """Every point compared and which are non-dominated (the trade-off, not one score)."""

    budget: core.Budget
    points: list[FrontierPoint]

    @property
    def non_dominated(self) -> list[FrontierPoint]:
        return [p for p in self.points if p.dominated_by is None]

    def to_dict(self) -> dict:
        return {"budget": asdict(self.budget), "points": [asdict(p) for p in self.points],
                "non_dominated": [p.label for p in self.non_dominated], "labels": dict(core.LABELS)}

    def to_markdown(self) -> str:
        def table(points: list[FrontierPoint]) -> list[str]:
            lines = ["| point | flags | cash OMR (range) | stops served | min late | trucks | est. km | checks | frontier |",
                     "|---|---|---|---|---|---|---|---|---|"]
            for p in sorted(points, key=lambda x: (x.cash["mean"], -x.served["mean"], x.label)):
                front = "yes" if p.dominated_by is None else f"no (by {p.dominated_by})"
                lines.append(f"| {p.label} | {', '.join(p.flags) or '-'} | {p.cash['mean']:.2f} ({p.cash['min']:.2f}.."
                             f"{p.cash['max']:.2f}) | {p.served['mean']:g} | {p.late_min['mean']:g} | {p.trucks['mean']:g} | "
                             f"{p.km['mean']:.1f} | {', '.join(f'{k} {v}' for k, v in p.feasibility.items())} | {front} |")
            return lines

        today = [p for p in self.points if not p.flags]
        flagged = [p for p in self.points if p.flags]
        lines = table(today)
        if flagged:
            lines += ["", "Needs a confirmation, an agreement or evidence first (HYPOTHETICAL / REQUIRES_EVIDENCE): "
                          "shown apart, and never counted as beating an option of the table above.", "", *table(flagged)]
        lines += ["", f"Means over seeds {list(self.budget.seeds)} at {self.budget.time_limit_sec} s "
                      f"{self.budget.search_mode}. Minutes late are counted against the original windows (the "
                      "preferred end where set, else the closing time). Best found plans, not proven optimal."]
        return "\n".join(lines)


def _solve_as(req: DispatchRequest, budget: core.Budget, seed: int, scenario: str) -> core.RunResult:
    """core.solve for any one engine scenario (core.solve always asks for RECOMMENDED): the same offline,
    seeded request, search time and mode, the scenario alone (so it gets the whole time limit, as
    RECOMMENDED does), and the same SOLVER_PYVRP_SEED handling."""
    if scenario == "RECOMMENDED":
        return core.solve(req, budget, seed)
    run_req = core.offline(core.seeded(req, seed))
    cfg = run_req.config
    cfg.time_limit_sec = budget.time_limit_sec
    cfg.search_mode = budget.search_mode  # type: ignore[assignment]
    cfg.scenarios = [scenario]  # type: ignore[list-item]
    if budget.search_mode == "THOROUGH":
        cfg.max_search_sec = max(10, budget.time_limit_sec)
    saved = os.environ.get("SOLVER_PYVRP_SEED")
    if seed:
        os.environ["SOLVER_PYVRP_SEED"] = str(seed)
    try:
        env = {k: os.environ[k] for k in core._ENV_KEYS if k in os.environ}
        started = time.perf_counter()
        response = ds.optimize_dispatch(run_req)
        wall = time.perf_counter() - started
    finally:
        if saved is None:
            os.environ.pop("SOLVER_PYVRP_SEED", None)
        else:
            os.environ["SOLVER_PYVRP_SEED"] = saved
    return core.RunResult(seed=seed, digest=core.digest(req), request=run_req, response=response,
                          metrics=core.metrics(run_req, response, scenario), wall_sec=round(wall, 2), env=env)


def frontier(req: DispatchRequest, configs: list[FrontierConfig], budget: core.Budget, ctx=None, *,
             known: dict[str, list[core.RunResult]] | None = None) -> Frontier:
    """Solve every configuration with the same budget and seeds (or take its runs from ``known``, by label,
    e.g. Ranking.known()) and mark the non-dominated points over (cash OMR, stops served, minutes late)."""
    c = _context(ctx)
    points = []
    for cfg in configs:
        runs = (known or {}).get(cfg.label)
        if runs is None:
            variant = cfg.relaxation.apply(req, c) if cfg.relaxation is not None else req
            runs = [_solve_as(variant, budget, s, cfg.scenario) for s in budget.seeds]
        if [r.seed for r in runs] != list(budget.seeds):
            raise ValueError(f"{cfg.label}: the runs must be one per budget seed, in order")
        r = cfg.relaxation
        flags = [] if r is None else [t for t, on in (("HYPOTHETICAL", r.hypothetical),
                                                      ("REQUIRES_EVIDENCE", r.requires_evidence)) if on]
        points.append(FrontierPoint(
            label=cfg.label, scenario=cfg.scenario, flags=flags,
            cash=_mmm([x.metrics.cash.total for x in runs]), served=_mmm([x.metrics.stops_served for x in runs]),
            late_min=_mmm([late_minutes(req, _scenario(x.response, cfg.scenario)) for x in runs]),
            trucks=_mmm([x.metrics.trucks_used for x in runs]), km=_mmm([x.metrics.km for x in runs]),
            feasibility=dict(sorted(Counter(x.metrics.feasibility for x in runs).items())),
        ))
    mark_dominated(points)
    return Frontier(budget=budget, points=points)


# ------------------------------------------------------------------------------------------------
# A whole day
# ------------------------------------------------------------------------------------------------

@dataclass
class DayExplanation:
    """Verdicts of the base runs, conflicts of the stops they left out, the ranked relaxations and the
    frontier (the engine's three options plus the best relaxations that serve more)."""

    seeds: list[int]
    verdicts: list[Verdict]  # one per seed
    conflicts: dict[str, Conflict]
    ranking: Ranking | None
    frontier: Frontier

    def to_dict(self) -> dict:
        return {"seeds": self.seeds, "verdicts": [v.to_dict() for v in self.verdicts],
                "conflicts": {c.label: asdict(c) | {"text": c.text()} for c in self.conflicts.values()},
                "ranking": self.ranking.to_dict() if self.ranking else None, "frontier": self.frontier.to_dict()}

    def to_markdown(self) -> str:
        out = ["## Verdicts"]
        for seed, v in zip(self.seeds, self.verdicts):
            out += ["", f"Seed {seed}: " + v.to_markdown()]
        out += ["", "## Conflicts of the stops left out", ""]
        out += [f"- {c.text()}" for c in self.conflicts.values()] or ["- none"]
        out += ["", "## Ranked relaxations", "", self.ranking.to_markdown() if self.ranking else "Nothing to relax."]
        out += ["", "## Trade-off frontier", "", self.frontier.to_markdown()]
        return "\n".join(out)


def explain_day(req: DispatchRequest, budget: core.Budget, ctx=None, *, base: list[core.RunResult] | None = None,
                frontier_relaxations: int = 2, **candidate_kw) -> DayExplanation:
    """Everything for one day (anonymise a real request first): base runs, verdicts, conflicts (each stop
    left out, against the plan of the first seed that left it out), candidates (candidates_for,
    ``candidate_kw``), the ranking and the frontier."""
    c = _context(ctx)
    base_runs = base if base is not None else core.solve_seeds(req, budget)
    verdicts = [verdict(r.request, r.response) for r in base_runs]
    conf: dict[str, Conflict] = {}
    for r in base_runs:
        new = [u.stop_id for u in _scenario(r.response, "RECOMMENDED").unserved if u.stop_id not in conf]
        if new:
            conf |= conflicts(r.request, r.response, ctx=c, stop_ids=new)
    conf = dict(sorted(conf.items(), key=lambda kv: kv[1].label))
    cands = candidates_for(req, [r.response for r in base_runs], c, **candidate_kw)
    ranking = rank_relaxations(req, cands, budget, c, base=base_runs) if cands else None
    configs = scenario_configs() + (ranking.configs(frontier_relaxations) if ranking else [])
    known = ranking.known() if ranking else {"RECOMMENDED": base_runs}
    return DayExplanation(seeds=list(budget.seeds), verdicts=verdicts, conflicts=conf, ranking=ranking,
                          frontier=frontier(req, configs, budget, c, known=known))


def _hire_options(path: str, own_ids: set[str]) -> tuple[DispatchTruck, ...]:
    """Hire options from another request of the company (e.g. the same day's first version): its trucks
    that are hire_candidate or are not in this request (the trucks hired that day), as hire options with
    anonymous ids."""
    other = core.load_request(path)
    picked = [t for t in other.trucks if t.hire_candidate or t.id not in own_ids]
    return tuple(t.model_copy(update={"id": f"hire-option-{i}", "code": f"hire-option-{i}", "hire_candidate": True,
                                      "frozen_trips": []}) for i, t in enumerate(picked, start=1))


def main(argv: list[str] | None = None) -> None:
    ap = argparse.ArgumentParser(description="Verdicts, conflicts, ranked relaxations and the frontier of one day.")
    ap.add_argument("--request", required=True, help="a DispatchRequest JSON (kept outside the repository)")
    ap.add_argument("--time-limit", type=int, default=20)
    ap.add_argument("--mode", default="QUICK", choices=("QUICK", "THOROUGH"))
    ap.add_argument("--seeds", type=int, nargs="+", default=[1, 2, 3])
    ap.add_argument("--hypothetical", action="store_true", help="let UNKNOWN windows flex, labelled HYPOTHETICAL")
    ap.add_argument("--hire-from", help="another request whose extra or hire_candidate trucks are hire options")
    ap.add_argument("--max-stops", type=int, default=5, help="window candidates for at most this many stops left out")
    ap.add_argument("--minutes", type=int, nargs="+", default=list(FLEX_MINUTES), help="window extensions to try")
    ap.add_argument("--out", help="write the Markdown report here")
    ap.add_argument("--json", help="write the JSON report here")
    a = ap.parse_args(argv)
    day = history.load_real(a.request)
    hires = _hire_options(a.hire_from, {t.id for t in day.request.trucks}) if a.hire_from else ()
    anon = day.anonymised()
    ctx = Context.of(anon, hypothetical=a.hypothetical, hire_options=hires)
    budget = core.Budget(time_limit_sec=a.time_limit, search_mode=a.mode, seeds=tuple(a.seeds))
    started = time.perf_counter()
    result = explain_day(anon.request, budget, ctx, max_stops=a.max_stops, minutes=tuple(a.minutes))
    md = (f"# Explanation of {day.source} (anonymised, digest {day.digest})\n\n" + result.to_markdown()
          + f"\n\nWall time {time.perf_counter() - started:.0f} s.\n")
    print(md)
    if a.out:
        Path(a.out).write_text(md, encoding="utf-8")
    if a.json:
        Path(a.json).write_text(json.dumps(result.to_dict(), indent=1, default=str), encoding="utf-8")


if __name__ == "__main__":
    main()
