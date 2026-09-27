"""Independent feasibility check of one dispatch scenario (review F04).

Every scenario the engine returns - the route search's own plan, a post-solve candidate, or a
fallback kept when the post-solve stage did not run - is re-checked here against the REQUEST and
the road matrix, from the emitted minutes alone. Nothing here trusts the engine's own timing code
(load_repack.timing_ok, _build_scenario): the rules are re-derived from the request, so a timing
bug or a fallback path shows up as a violation instead of a timetable no truck can drive.

Rules (all times in whole minutes, as the scenario reports them; TOL_MIN absorbs the rounding of
seconds to minutes in dispatch_solver._min_of):

* capacity: a load's cases (and kg, when the truck has a payload) from the request's stops;
* hard receiving windows: service starts inside the window;
* travel: each service start is at least the previous departure + the drive time (matrix), and
  the truck is back no earlier than the last departure + the drive back;
* unloading: departure - service start == the service time that was sent;
* turnaround: a load departs no earlier than the previous load's return + reload + loading time
  per case x ITS cases - also after the truck's last frozen (locked / dispatched) load;
* the truck day: first departure after shift start, depot opening and the truck's availability;
  every return before the depot closes and the truck's availability ends; first departure (the
  first frozen one when there is one) -> last return within the shift maximum;
* loads per truck: frozen + new <= max trips; new loads never overlap a frozen one and carry the
  load numbers after it.

Violation messages are for the dispatcher: plain words, clock times, minutes short.
"""
from __future__ import annotations

import logging
from typing import TYPE_CHECKING

from dispatch_models import (
    DAY_MIN,
    DispatchRequest,
    DispatchScenario,
    DispatchStop,
    FeasibilityReport,
    FeasibilityViolation,
)

if TYPE_CHECKING:  # pragma: no cover
    from providers import MatrixResult

log = logging.getLogger("routeiq.dispatch.feasibility")

TOL_MIN = 1  # minutes: every emitted time is rounded to a whole minute
KG_TOL = 0.05
CHECK_VERSION = 1


def _hhmm(m: float | int | None) -> str:
    if m is None:
        return "--:--"
    m = int(round(m))
    return f"{(m // 60) % 24:02d}:{m % 60:02d}" + ("+1" if m >= DAY_MIN else "")


def _short(x: float) -> float:
    return round(x, 1)


def check_scenario(
    req: DispatchRequest,
    sc: DispatchScenario,
    *,
    solvable: list[DispatchStop] | None = None,
    mx: "MatrixResult | None" = None,
    timing: str = "EXACT",
) -> FeasibilityReport:
    """Check ``sc`` against ``req``. ``solvable`` + ``mx``: the matrix the scenario was planned on
    (node 0 = depot, node k + 1 = solvable[k]); without them drive times are not re-checked."""
    cfg = req.config
    trucks = {t.id: t for t in req.trucks}
    stops = {s.stop_id: s for s in req.stops}
    node_of = {s.stop_id: k + 1 for k, s in enumerate(solvable)} if (solvable is not None and mx is not None) else None
    out: list[FeasibilityViolation] = []

    def add(code: str, message: str, *, truck_id=None, load_no=None, stop_id=None, short=None) -> None:
        out.append(FeasibilityViolation(code=code, message=message, truck_id=truck_id, load_no=load_no, stop_id=stop_id,  # type: ignore[arg-type]
                                        short_by_min=_short(short) if short is not None else None))

    def drive_min(a: str | None, b: str | None) -> float | None:
        """Drive time in minutes between two stops (None = depot); None when not checkable."""
        if node_of is None or mx is None:
            return None
        i = 0 if a is None else node_of.get(a)
        j = 0 if b is None else node_of.get(b)
        if i is None or j is None:
            return None
        return mx.duration_s[i][j] / 60.0

    def turnaround(cases: int) -> float:
        return cfg.reload_min + cfg.loading_min_per_case * cases

    by_truck: dict[str, list] = {}
    for ld in sc.loads:
        by_truck.setdefault(ld.truck_id, []).append(ld)

    depot_close = req.depot.close_min if req.depot.close_min > 0 else DAY_MIN
    for tid, loads in by_truck.items():
        t = trucks.get(tid)
        if t is None:
            add("UNKNOWN_TRUCK", f"Truck {tid} is not in the request.", truck_id=tid)
            continue
        code = t.code or t.id
        loads = sorted(loads, key=lambda l: (l.load_no, l.depart_min))
        frozen = sorted(t.frozen_trips, key=lambda f: f.load_no)
        max_trips = t.max_trips or cfg.max_trips_per_truck

        # Loads per day and load numbers (new loads follow the frozen ones).
        if len(frozen) + len(loads) > max_trips:
            add("TRIPS", f"Truck {code} has {len(frozen) + len(loads)} loads ({len(frozen)} locked or out); at most {max_trips} per day.",
                truck_id=tid)
        expected = list(range(len(frozen) + 1, len(frozen) + len(loads) + 1))
        if [l.load_no for l in loads] != expected:
            add("LOAD_NUMBER", f"Truck {code} load numbers {[l.load_no for l in loads]} do not follow its "
                               f"{len(frozen)} locked or dispatched load(s) (expected {expected}).", truck_id=tid)

        # The truck day's bounds.
        earliest = max(cfg.shift_start_min, req.depot.open_min, t.available_from_min or 0)
        why_earliest = ("the shift start" if earliest == cfg.shift_start_min else
                        "the depot opening" if earliest == req.depot.open_min else "the truck's availability")
        avail_to = t.available_to_min if t.available_to_min is not None else DAY_MIN * 2
        anchor = min([f.depart_min for f in frozen] + [l.depart_min for l in loads])
        last_return = max(l.return_min for l in loads)
        if last_return - anchor > cfg.shift_max_min + TOL_MIN:
            add("SHIFT_LIMIT", f"Truck {code} is out from {_hhmm(anchor)} to {_hhmm(last_return)}: longer than the "
                               f"{cfg.shift_max_min // 60}h{cfg.shift_max_min % 60:02d} shift maximum.",
                truck_id=tid, short=last_return - anchor - cfg.shift_max_min)

        prev_return: int | None = max((f.return_min for f in frozen), default=None)
        prev_what = "its last locked or dispatched load"
        for ld in loads:
            lno = ld.load_no
            # Capacity: from the request's stops, not from the load's own totals.
            known = [stops.get(st.stop_id) for st in ld.stops]
            for st, s in zip(ld.stops, known):
                if s is None:
                    add("UNKNOWN_STOP", f"Stop {st.stop_id} on {code} load {lno} is not in the request.", truck_id=tid,
                        load_no=lno, stop_id=st.stop_id)
            cases = sum(s.demand_cases for s in known if s is not None)
            kg = sum(s.demand_kg for s in known if s is not None)
            if ld.cases != cases:
                add("LOAD_TOTALS", f"{code} load {lno} records {ld.cases} cases but its stops add up to {cases}.",
                    truck_id=tid, load_no=lno)
            if cases > t.capacity_cases:
                add("CAPACITY_CASES", f"{code} load {lno} carries {cases} cases; the truck takes {t.capacity_cases}.",
                    truck_id=tid, load_no=lno, short=cases - t.capacity_cases)
            if t.capacity_kg > 0 and kg > t.capacity_kg + KG_TOL:
                add("CAPACITY_KG", f"{code} load {lno} weighs {kg:.0f} kg; the truck's payload is {t.capacity_kg:.0f} kg.",
                    truck_id=tid, load_no=lno, short=kg - t.capacity_kg)

            # Departure: after the truck is ready (turnaround) and inside its day.
            if prev_return is not None:
                ready = prev_return + turnaround(ld.cases)
                if ld.depart_min < ready - TOL_MIN:
                    add("TURNAROUND",
                        f"{code} load {lno} leaves at {_hhmm(ld.depart_min)}, but after {prev_what} (back {_hhmm(prev_return)}) "
                        f"the truck needs {turnaround(ld.cases):g} min to reload and load {ld.cases} cases: ready {_hhmm(ready)}.",
                        truck_id=tid, load_no=lno, short=ready - ld.depart_min)
            if ld.depart_min < earliest - TOL_MIN:
                add("EARLY_DEPARTURE", f"{code} load {lno} leaves at {_hhmm(ld.depart_min)}, before {why_earliest} ({_hhmm(earliest)}).",
                    truck_id=tid, load_no=lno, short=earliest - ld.depart_min)
            for f in frozen:
                if ld.depart_min < f.return_min and f.depart_min < ld.return_min:
                    add("FROZEN_OVERLAP", f"{code} load {lno} ({_hhmm(ld.depart_min)}-{_hhmm(ld.return_min)}) overlaps its locked or "
                                          f"dispatched load {f.load_no} ({_hhmm(f.depart_min)}-{_hhmm(f.return_min)}).",
                        truck_id=tid, load_no=lno)

            # The stops: drive, window, unloading.
            prev_stop: str | None = None
            prev_dep = ld.depart_min
            for st in ld.stops:
                s = stops.get(st.stop_id)
                leg = drive_min(prev_stop, st.stop_id)
                if leg is not None and st.service_start_min < prev_dep + leg - TOL_MIN:
                    add("TRAVEL", f"{code} load {lno}: {st.stop_id} starts at {_hhmm(st.service_start_min)}, but the drive from "
                                  f"{'the depot' if prev_stop is None else prev_stop} ({_hhmm(prev_dep)}) takes {leg:.0f} min.",
                        truck_id=tid, load_no=lno, stop_id=st.stop_id, short=prev_dep + leg - st.service_start_min)
                if s is not None:
                    hs = s.hard_start_min or 0
                    he = s.hard_end_min if s.hard_end_min is not None else DAY_MIN * 2
                    if not (hs <= st.service_start_min <= he) or not st.hard_window_ok:
                        add("HARD_WINDOW", f"{code} load {lno}: {st.stop_id} is served at {_hhmm(st.service_start_min)}, outside its "
                                           f"receiving hours {_hhmm(s.hard_start_min)}-{_hhmm(s.hard_end_min)}.",
                            truck_id=tid, load_no=lno, stop_id=st.stop_id,
                            short=max(hs - st.service_start_min, st.service_start_min - he, 0))
                    if st.departure_min - st.service_start_min != s.service_min:
                        add("SERVICE_TIME", f"{code} load {lno}: {st.stop_id} is given {st.departure_min - st.service_start_min} min to "
                                            f"unload; its service time is {s.service_min} min.",
                            truck_id=tid, load_no=lno, stop_id=st.stop_id,
                            short=s.service_min - (st.departure_min - st.service_start_min))
                prev_stop, prev_dep = st.stop_id, st.departure_min
            back = drive_min(prev_stop, None) if ld.stops else None
            if back is not None and ld.return_min < prev_dep + back - TOL_MIN:
                add("RETURN", f"{code} load {lno} is back at {_hhmm(ld.return_min)}, but the drive back from the last stop "
                              f"({_hhmm(prev_dep)}) takes {back:.0f} min.",
                    truck_id=tid, load_no=lno, short=prev_dep + back - ld.return_min)
            if ld.return_min > depot_close + TOL_MIN:
                add("DEPOT_CLOSE", f"{code} load {lno} is back at {_hhmm(ld.return_min)}, after the depot closes ({_hhmm(depot_close)}).",
                    truck_id=tid, load_no=lno, short=ld.return_min - depot_close)
            if ld.return_min > avail_to + TOL_MIN:
                add("TRUCK_AVAILABILITY", f"{code} load {lno} is back at {_hhmm(ld.return_min)}, after the truck's availability ends "
                                          f"({_hhmm(avail_to)}).", truck_id=tid, load_no=lno, short=ld.return_min - avail_to)
            prev_return, prev_what = ld.return_min, f"load {lno}"

    status = "VIOLATED" if out else "VERIFIED"
    return FeasibilityReport(status=status, timing="EXACT" if timing == "EXACT" else "ESTIMATED", violations=out,  # type: ignore[arg-type]
                             checked_at_version=CHECK_VERSION, travel_checked=node_of is not None)


def safe_check(req: DispatchRequest, sc: DispatchScenario, **kw) -> FeasibilityReport:
    """check_scenario that never fails the request: an error in the check itself gives an
    UNVERIFIED report (not dispatchable on the web) and a log line."""
    try:
        return check_scenario(req, sc, **kw)
    except Exception as exc:  # noqa: BLE001
        log.exception("feasibility check failed for %s: %s", sc.name, exc)
        return FeasibilityReport(status="UNVERIFIED", timing="EXACT" if kw.get("timing", "EXACT") == "EXACT" else "ESTIMATED",
                                 checked_at_version=CHECK_VERSION, travel_checked=False,
                                 note="The timetable check could not run for this plan.")
