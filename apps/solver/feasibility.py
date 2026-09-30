"""Independent feasibility check of one dispatch scenario (review F04).

Every scenario the engine returns - the route search's own plan, a post-solve candidate, or a
fallback kept when the post-solve stage did not run - is re-checked here against the REQUEST and
the road matrix, from the emitted minutes alone. Nothing here trusts the engine's own timing code
(load_repack.timing_ok, _build_scenario): the rules are re-derived from the request, so a timing
bug or a fallback path shows up as a violation instead of a timetable no truck can drive.

Rules (all times in whole minutes, as the scenario reports them; TOL_MIN absorbs the rounding of
seconds to minutes in dispatch_solver._min_of):

* capacity: a load's cases (and kg, when the truck has a payload) from the request's stops; kg in
  0.1 kg units, each stop to the nearest unit, the payload rounded down - no margin (audit F08);
* hard receiving windows: service starts at or after opening, and unloading is finished by
  closing (departure <= closing) under config.window_rule FINISH; under START (the earlier rule,
  the default) service starts inside the window;
* travel: each service start is at least the previous departure + the drive time (matrix), and
  the truck is back no earlier than the last departure + the drive back;
* unloading: departure - service start == the service time that was sent;
* turnaround: a load departs no earlier than the previous load's return + reload + loading time
  per case x ITS cases - also after the truck's last frozen (locked / dispatched) load, and on a
  plan made on its delivery day (config.loading_from_min) after the time it was made, on a truck
  standing at the depot too;
* the truck day: first departure after shift start, depot opening and the truck's availability;
  every return before the depot closes and the truck's availability ends; first departure (the
  first frozen one when there is one) -> last return within the shift maximum;
* loads per truck: frozen + new <= max trips; new loads never overlap a frozen one and carry the
  load numbers after it;
* driver break (config.break_min > 0, _check_break): a truck-day whose first departure is before
  the break window and whose last return is after it holds one break of break_min, starting in the
  window, at the depot between loads or on the road between two unloadings - never over one.

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
    kg_text,
    kg_units,
    payload_units,
)

if TYPE_CHECKING:  # pragma: no cover
    from providers import MatrixResult

log = logging.getLogger("routeiq.dispatch.feasibility")

TOL_MIN = 1  # minutes: every emitted time is rounded to a whole minute
CHECK_VERSION = 2  # 2: the receiving-hours rule FINISH (unloading finished by closing) and the driver break


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
    # Receiving hours: FINISH = unloading finished by closing (re-derived here on purpose, not
    # load_repack.latest_start_s: this is the independent check).
    finish_rule = cfg.window_rule == "FINISH"
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
            # In 0.1 kg units, each stop to the nearest unit, against the payload rounded down: the
            # engine's own rule, with no margin either way (audit F08).
            kg_u = sum(kg_units(s.demand_kg) for s in known if s is not None)
            cap_u = payload_units(t.capacity_kg)
            if ld.cases != cases:
                add("LOAD_TOTALS", f"{code} load {lno} records {ld.cases} cases but its stops add up to {cases}.",
                    truck_id=tid, load_no=lno)
            if cases > t.capacity_cases:
                add("CAPACITY_CASES", f"{code} load {lno} carries {cases} cases; the truck takes {t.capacity_cases}.",
                    truck_id=tid, load_no=lno, short=cases - t.capacity_cases)
            if cap_u > 0 and kg_u > cap_u:
                add("CAPACITY_KG", f"{code} load {lno} weighs {kg_text(kg_u / 10)} kg; the truck's payload is {kg_text(cap_u / 10)} kg.",
                    truck_id=tid, load_no=lno, short=(kg_u - cap_u) / 10)

            # Departure: after the truck is ready (turnaround) and inside its day. On a plan made on
            # its delivery day loading starts no earlier than then: the later of the two counts.
            loading_from = cfg.loading_from_min
            if prev_return is not None and (loading_from is None or prev_return >= loading_from):
                ready = prev_return + turnaround(ld.cases)
                if ld.depart_min < ready - TOL_MIN:
                    add("TURNAROUND",
                        f"{code} load {lno} leaves at {_hhmm(ld.depart_min)}, but after {prev_what} (back {_hhmm(prev_return)}) "
                        f"the truck needs {turnaround(ld.cases):g} min to reload and load {ld.cases} cases: ready {_hhmm(ready)}.",
                        truck_id=tid, load_no=lno, short=ready - ld.depart_min)
            elif loading_from is not None:
                ready = loading_from + turnaround(ld.cases)
                if ld.depart_min < ready - TOL_MIN:
                    add("TURNAROUND",
                        f"{code} load {lno} leaves at {_hhmm(ld.depart_min)}, but the plan was made at {_hhmm(loading_from)} on its "
                        f"delivery day, so loading starts then: the truck needs {turnaround(ld.cases):g} min to reload and load "
                        f"{ld.cases} cases: ready {_hhmm(ready)}.",
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
                    if finish_rule and s.hard_end_min is not None and st.departure_min > he:
                        add("HARD_WINDOW", f"{code} load {lno}: {st.stop_id} finishes unloading at {_hhmm(st.departure_min)}, "
                                           f"after its receiving hours end ({_hhmm(s.hard_end_min)}).",
                            truck_id=tid, load_no=lno, stop_id=st.stop_id, short=st.departure_min - he)
                    elif not (hs <= st.service_start_min <= he) or not st.hard_window_ok:
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
            if cfg.latest_return_min is not None and ld.return_min > cfg.latest_return_min + TOL_MIN:
                add("SHIFT_LIMIT", f"{code} load {lno} is back at {_hhmm(ld.return_min)}, after the latest return "
                                   f"({_hhmm(cfg.latest_return_min)}).",
                    truck_id=tid, load_no=lno, short=ld.return_min - cfg.latest_return_min)
            if ld.return_min > avail_to + TOL_MIN:
                add("TRUCK_AVAILABILITY", f"{code} load {lno} is back at {_hhmm(ld.return_min)}, after the truck's availability ends "
                                          f"({_hhmm(avail_to)}).", truck_id=tid, load_no=lno, short=ld.return_min - avail_to)
            prev_return, prev_what = ld.return_min, f"load {lno}"

        _check_break(cfg, code, tid, frozen, loads, drive_min, add)

    status = "VIOLATED" if out else "VERIFIED"
    return FeasibilityReport(status=status, timing="EXACT" if timing == "EXACT" else "ESTIMATED", violations=out,  # type: ignore[arg-type]
                             checked_at_version=CHECK_VERSION, travel_checked=node_of is not None)


def _check_break(cfg, code: str, tid: str, frozen: list, loads: list, drive_min, add) -> None:
    """BREAK: the driver break of one truck-day, re-derived from the request and the emitted minutes
    (config.break_min > 0). Needed when the day's first departure (frozen loads included) is before
    the window start and its last return after the window end. Held by a recorded break of a frozen
    load, a depot gap of at least the break that starts inside the window (between two loads; after
    a frozen load only from the time the plan was made), or a declared break of a new load. Frozen
    loads that ran through the window with none recorded are a warning of the plan, not a violation
    (they were planned before the rule)."""
    L, bf, bt = cfg.break_min, cfg.break_start_from_min, cfg.break_start_to_min
    if L <= 0 or bf > bt or L >= cfg.shift_max_min:
        return  # no break rule (the solver plans none and says why)
    trips = sorted(frozen, key=lambda f: f.depart_min)
    seq = [(f.depart_min, f.return_min, True) for f in trips] + [(ld.depart_min, ld.return_min, False) for ld in loads]
    frozen_done = any(f.break_start_min is not None for f in trips) or any(
        max(bf, a.return_min) <= bt and max(bf, a.return_min) + L <= b.depart_min for a, b in zip(trips, trips[1:]))
    declared = [ld for ld in loads if ld.driver_break is not None]
    window = f"to start between {_hhmm(bf)} and {_hhmm(bt)}"
    if len(declared) > 1:
        add("BREAK", f"Truck {code} has {len(declared)} driver breaks planned; it takes one.", truck_id=tid,
            load_no=declared[1].load_no)
    if frozen_done and declared:
        add("BREAK", f"Truck {code} load {declared[0].load_no} plans a second driver break: its locked or dispatched loads "
                     "already hold one.", truck_id=tid, load_no=declared[0].load_no)
    last_frozen = max((f.return_min for f in trips), default=None)
    for ld in declared:
        b, lno = ld.driver_break, ld.load_no
        where = f"Truck {code} load {lno}: the driver break {_hhmm(b.start_min)}-{_hhmm(b.end_min)}"
        if not bf - TOL_MIN <= b.start_min <= bt + TOL_MIN:
            add("BREAK", f"{where} starts outside its window ({window}).", truck_id=tid, load_no=lno)
        if b.end_min - b.start_min < L:
            add("BREAK", f"{where} is shorter than {L} min.", truck_id=tid, load_no=lno, short=L - (b.end_min - b.start_min))
        if last_frozen is not None and b.start_min < last_frozen - TOL_MIN:
            add("BREAK", f"{where} starts before its locked or dispatched loads are back ({_hhmm(last_frozen)}).",
                truck_id=tid, load_no=lno)
        if b.where == "DEPOT":
            before = [r for d, r, _ in seq if r <= ld.depart_min + TOL_MIN and d < ld.depart_min]
            prev_frozen = not any(not fz and d < ld.depart_min for d, _, fz in seq)
            if before and b.start_min < max(before) - TOL_MIN:
                add("BREAK", f"{where} at the depot starts before the truck is back ({_hhmm(max(before))}).",
                    truck_id=tid, load_no=lno)
            if prev_frozen and cfg.loading_from_min is not None and b.start_min < cfg.loading_from_min - TOL_MIN:
                add("BREAK", f"{where} at the depot starts before this plan was made ({_hhmm(cfg.loading_from_min)}): "
                             "time already spent does not count.", truck_id=tid, load_no=lno)
            if b.start_min + L > ld.depart_min + TOL_MIN:
                add("BREAK", f"{where} at the depot ends after the load leaves ({_hhmm(ld.depart_min)}).", truck_id=tid,
                    load_no=lno, short=b.start_min + L - ld.depart_min)
            continue
        i, m = b.after_sequence, len(ld.stops)
        if i is None or not 0 <= i <= m:
            add("BREAK", f"{where} is not placed between two stops.", truck_id=tid, load_no=lno)
            continue
        a = ld.depart_min if i == 0 else ld.stops[i - 1].departure_min
        z = ld.stops[i].service_start_min if i < m else ld.return_min
        if b.start_min < a - TOL_MIN or b.start_min + L > z + TOL_MIN:
            add("BREAK", f"{where} overlaps unloading or leaves the leg it is on ({_hhmm(a)}-{_hhmm(z)}).",
                truck_id=tid, load_no=lno)
        leg = drive_min(ld.stops[i - 1].stop_id if i > 0 else None, ld.stops[i].stop_id if i < m else None)
        if leg is not None and z - a < leg + L - TOL_MIN:
            add("BREAK", f"{where} does not fit on its leg: the drive takes {leg:.0f} min and the leg only "
                         f"{z - a} min.", truck_id=tid, load_no=lno, short=leg + L - (z - a))
    first = min(d for d, _, _ in seq)
    last = max(r for _, r, _ in seq)
    if declared or frozen_done or not (first < bf and last > bt):
        return
    for (d0, r0, fz0), (d1, _r1, fz1) in zip(seq, seq[1:]):
        start = max(bf, r0, cfg.loading_from_min or 0) if (fz0 and not fz1) else max(bf, r0)
        if start <= bt + TOL_MIN and start + L <= d1 + TOL_MIN:
            return  # a depot gap that holds the break
    if trips and trips[0].depart_min < bf and max(f.return_min for f in trips) > bt:
        return  # frozen loads without a recorded break run through the window: a warning, not a violation
    add("BREAK", f"Truck {code} works {_hhmm(first)}-{_hhmm(last)} through midday without the {L}-min driver break "
                 f"({window}).", truck_id=tid)


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
