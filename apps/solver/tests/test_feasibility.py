"""Review F04: the independent feasibility check (feasibility.py), its place in every returned
scenario, and the safety net that re-times a plan exactly when the post-solve stage did not run.

Haversine only (no network). Tests that monkeypatch the engine run in-process
(SOLVER_PARALLEL=0): a spawned worker would not see the patch.
"""
from __future__ import annotations

import time

import pytest

import dispatch_solver as ds
import feasibility as FZ
import load_repack as LR
from dispatch_models import DispatchDepot, DispatchStop, FrozenTrip
from dispatch_solver import optimize_dispatch
from tests.test_dispatch import hm, nmwc_day, rec, req, stop, truck
from tests.test_repack import ALL, _day_for, assert_plan_rules, by_truck, half_load_day, matrix_for


def codes(report) -> set[str]:
    return {v.code for v in report.violations}


# --------------------------------------------------------------------------------------
# One valid plan, then one broken fact at a time
# --------------------------------------------------------------------------------------

def two_load_day(**cfg):
    """One 100-case truck (payload 1,000 kg), two customers of 60 cases (300 kg): two loads."""
    stops = [stop("A", 23.62, 58.45, cases=60, demand_kg=300, service_min=15, hard_start_min=hm("06:00"), hard_end_min=hm("14:00")),
             stop("B", 23.55, 58.30, cases=60, demand_kg=300, service_min=15)]
    cfg.setdefault("reload_min", 30)
    cfg.setdefault("loading_min_per_case", 0.5)
    return req(stops, [truck("T1", cap=100, capacity_kg=1000, max_trips=3)], shift_start_min=hm("07:00"), **cfg)


def valid(r):
    """RECOMMENDED's exact timetable for ``r`` (the loads A then B on T1)."""
    day, tds = _day_for(r)
    mx = matrix_for(r)
    timed = LR.time_plan(day, {0: [(0,), (1,)]}, ds._pricing("RECOMMENDED", r, tds, r.stops))
    assert timed is not None
    sc = ds._build_scenario("RECOMMENDED", r, r.stops, tds, mx, timed, day.values, False, [],
                            solver_status="ROUTING_SUCCESS", elapsed=0.0, time_limit=2, objective_value=0)
    return sc, mx


def check(r, sc, mx):
    return FZ.check_scenario(r, sc, solvable=r.stops, mx=mx)


def test_a_valid_plan_is_verified_and_exact():
    r = two_load_day()
    sc, mx = valid(r)
    assert sc.feasibility.status == "VERIFIED" and sc.feasibility.timing == "EXACT" and sc.feasibility.travel_checked
    assert check(r, sc, mx).violations == []


def shifted(sc, load_no: int, by: int):
    """The scenario with load ``load_no`` (its stops too) moved ``by`` minutes."""
    out = sc.model_copy(deep=True)
    for ld in out.loads:
        if ld.load_no != load_no:
            continue
        ld.depart_min += by
        ld.return_min += by
        for st in ld.stops:
            st.arrival_min += by
            st.service_start_min += by
            st.departure_min += by
    return out


def test_turnaround_short():
    r = two_load_day()
    sc, mx = valid(r)
    l1, l2 = sorted(sc.loads, key=lambda l: l.load_no)
    gap = l2.depart_min - l1.return_min
    assert gap >= 30 + 0.5 * 60 - 1
    bad = shifted(sc, 2, -(gap - 40))  # leaves 40 min after L1 is back; it needs 60
    rep = check(r, bad, mx)
    assert codes(rep) == {"TURNAROUND"}
    v = rep.violations[0]
    assert v.truck_id == "T1" and v.load_no == 2 and v.short_by_min == pytest.approx(20, abs=0.1)
    assert "needs 60 min to reload and load 60 cases" in v.message


def test_hard_window_missed():
    r = two_load_day()
    sc, mx = valid(r)
    late = r.model_copy(deep=True)
    late.stops[0].hard_end_min = sc.loads[0].stops[0].service_start_min - 10
    assert codes(check(late, sc, mx)) == {"HARD_WINDOW"}
    flagged = sc.model_copy(deep=True)
    flagged.loads[0].stops[0].hard_window_ok = False  # the engine's own flag counts too
    assert codes(check(r, flagged, mx)) == {"HARD_WINDOW"}


def test_cases_and_kg_over_the_truck():
    r = two_load_day()
    sc, mx = valid(r)
    small = r.model_copy(deep=True)
    small.trucks[0].capacity_cases = 50
    rep = check(small, sc, mx)
    assert codes(rep) == {"CAPACITY_CASES"} and len(rep.violations) == 2
    light = r.model_copy(deep=True)
    light.trucks[0].capacity_kg = 250  # each load weighs 300 kg
    rep = check(light, sc, mx)
    assert codes(rep) == {"CAPACITY_KG"}
    assert rep.violations[0].short_by_min == pytest.approx(50)
    unlimited = r.model_copy(deep=True)
    unlimited.trucks[0].capacity_kg = 0  # 0 = no payload set: kg not constrained
    assert check(unlimited, sc, mx).violations == []


def test_trips_over_the_limit():
    r = two_load_day()
    sc, mx = valid(r)
    one = r.model_copy(deep=True)
    one.trucks[0].max_trips = 1
    assert codes(check(one, sc, mx)) == {"TRIPS"}


def test_shift_span_depot_close_and_availability():
    r = two_load_day()
    sc, mx = valid(r)
    l1, l2 = sorted(sc.loads, key=lambda l: l.load_no)
    span = l2.return_min - l1.depart_min
    short = r.model_copy(deep=True)
    short.config.shift_max_min = span - 30
    assert codes(check(short, sc, mx)) == {"SHIFT_LIMIT"}
    closes = r.model_copy(deep=True)
    closes.depot = DispatchDepot(id="d", lat=r.depot.lat, lng=r.depot.lng, open_min=0, close_min=l2.return_min - 20)
    assert codes(check(closes, sc, mx)) == {"DEPOT_CLOSE"}
    until = r.model_copy(deep=True)
    until.trucks[0].available_to_min = l2.return_min - 20
    assert codes(check(until, sc, mx)) == {"TRUCK_AVAILABILITY"}
    later = r.model_copy(deep=True)
    later.trucks[0].available_from_min = l1.depart_min + 15
    assert codes(check(later, sc, mx)) == {"EARLY_DEPARTURE"}


def test_frozen_trip_overlap_and_turnaround_after_it():
    r = two_load_day()
    sc, mx = valid(r)
    l1 = min(sc.loads, key=lambda l: l.load_no)
    # A locked load 1 that is out while the new loads (now 2 and 3) run.
    frozen = r.model_copy(deep=True)
    frozen.trucks[0].frozen_trips = [FrozenTrip(load_no=1, depart_min=l1.depart_min - 30, return_min=l1.depart_min + 20, cases=50)]
    renumbered = sc.model_copy(deep=True)
    for ld in renumbered.loads:
        ld.load_no += 1
    rep = check(frozen, renumbered, mx)
    assert "FROZEN_OVERLAP" in codes(rep) and "TURNAROUND" in codes(rep)
    assert all(v.load_no in (2, 3) for v in rep.violations)
    # Same loads without renumbering: they would reuse the frozen load's number.
    assert "LOAD_NUMBER" in codes(check(frozen, sc, mx))


def test_travel_shortcut_service_time_and_return():
    r = two_load_day()
    sc, mx = valid(r)
    fast = sc.model_copy(deep=True)
    st = fast.loads[0].stops[0]
    st.service_start_min -= 20  # "arrives" 20 min before the drive from the depot allows
    st.departure_min -= 20
    assert "TRAVEL" in codes(check(r, fast, mx))
    rushed = sc.model_copy(deep=True)
    rushed.loads[0].stops[0].departure_min -= 5
    assert "SERVICE_TIME" in codes(check(r, rushed, mx))
    early = sc.model_copy(deep=True)
    early.loads[0].return_min -= 30
    assert "RETURN" in codes(check(r, early, mx))


def test_without_a_matrix_the_drive_times_are_not_claimed_checked():
    r = two_load_day()
    sc, _ = valid(r)
    rep = FZ.check_scenario(r, sc)
    assert rep.status == "VERIFIED" and rep.travel_checked is False


def test_a_crashing_check_is_unverified_never_an_error(monkeypatch):
    r = two_load_day()
    sc, mx = valid(r)

    def boom(*a, **kw):
        raise RuntimeError("bug in the check")

    monkeypatch.setattr(FZ, "check_scenario", boom)
    rep = FZ.safe_check(r, sc, solvable=r.stops, mx=mx)
    assert rep.status == "UNVERIFIED" and rep.note


def test_no_silent_repair_of_a_start_before_arrival():
    """_build_scenario used to move such a start later (max(start, arrival)) and derive the
    departure and return from the repaired chain: a timing error was hidden and the return could
    pass the next load's departure unchecked. Now the times stay as given and the report says so."""
    r = two_load_day()
    day, tds = _day_for(r)
    mx = matrix_for(r)
    good = LR.time_plan(day, {0: [(0,)]}, ds._pricing("RECOMMENDED", r, tds, r.stops))[0][0]
    broken = LR.TimedLoad(stops=good.stops, depart_s=good.depart_s, starts=(good.starts[0] - 15 * 60,), return_s=good.return_s - 15 * 60)
    sc = ds._build_scenario("RECOMMENDED", r, r.stops, tds, mx, {0: [broken]}, day.values, False, [],
                            solver_status="ROUTING_SUCCESS", elapsed=0.0, time_limit=2, objective_value=0)
    st = sc.loads[0].stops[0]
    assert st.service_start_min == ds._min_of(broken.starts[0])  # not moved
    assert sc.feasibility.status == "VIOLATED" and "TRAVEL" in codes(sc.feasibility)


# --------------------------------------------------------------------------------------
# The safety net: the stage failed or ran out of time, a loading time per case is set
# --------------------------------------------------------------------------------------

def f04_request(**cfg):
    """The review's reproduction: one 100-case truck, two 100-case customers, reload 30 min +
    1 min per case. The route search prices the turnaround at 30 + 0.8 x 100 = 110 min; the exact
    one for a 100-case load is 130 min."""
    stops = [stop("A", 23.62, 58.45, cases=100, service_min=10), stop("B", 23.55, 58.30, cases=100, service_min=10)]
    cfg.setdefault("scenarios", ["RECOMMENDED"])
    return req(stops, [truck("T1", cap=100, fixed_cost=10, trip_cost=2, cost_per_km=0.1, max_trips=3)],
               reload_min=30, loading_min_per_case=1.0, driver_cost_per_hour=2.5, overtime_after_min=540,
               overtime_cost_per_hour=4, **cfg)


def test_stage_failure_with_loading_time_is_retimed_or_flagged(monkeypatch):
    monkeypatch.setenv("SOLVER_PARALLEL", "0")
    monkeypatch.setenv("ROUTEIQ_TEST_FAIL_REPACK", "1")
    r = f04_request()
    sc = rec(optimize_dispatch(r))
    l1, l2 = by_truck(sc)["T1"]
    assert l2.depart_min >= l1.return_min + 130 - 1, (l1.return_min, l2.depart_min)
    assert sc.feasibility.status == "VERIFIED" and sc.feasibility.timing == "EXACT"
    assert any("re-timed exactly" in w for w in sc.warnings), sc.warnings
    assert_plan_rules(r, sc)
    # Without the safety net the route search's times come back - flagged, never passed off.
    monkeypatch.setattr(ds, "_retime", lambda *a, **kw: None)
    sc = rec(optimize_dispatch(r))
    l1, l2 = by_truck(sc)["T1"]
    assert l2.depart_min < l1.return_min + 130 - 1  # the search's 110-min estimate
    assert sc.feasibility.status == "VIOLATED" and sc.feasibility.timing == "ESTIMATED"
    assert codes(sc.feasibility) == {"TURNAROUND"}
    assert any("could not be re-timed" in w for w in sc.warnings)


def test_out_of_time_stage_is_retimed(monkeypatch):
    """The matrix (or the search) used the budget: the stage is skipped 'out of time', and the
    raw plan is still re-timed exactly (milliseconds, in-process) instead of being returned with
    the search's estimated turnaround."""
    monkeypatch.setenv("SOLVER_PARALLEL", "0")
    monkeypatch.setenv("SOLVER_BUDGET_SEC", "20")  # the stage needs its 20 s grace + 5 s: no room
    r = f04_request()
    t0 = time.perf_counter()
    sc = rec(optimize_dispatch(r))
    assert time.perf_counter() - t0 < 20
    assert any("out of time" in w and "re-timed exactly" in w for w in sc.warnings), sc.warnings
    assert sc.feasibility.status == "VERIFIED"
    assert_plan_rules(r, sc)


def test_stage_internal_error_keeps_what_it_already_rechecked(monkeypatch):
    """An exception inside the stage after it replaced RECOMMENDED: RECOMMENDED keeps its exact
    plan without a false 'not re-checked' note; the others get the safety net."""
    monkeypatch.setenv("SOLVER_PARALLEL", "0")
    r = f04_request(scenarios=["RECOMMENDED", "MIN_DISTANCE"])
    real = ds._post_solve

    def half_then_boom(*a):
        results = a[6]
        only = {"RECOMMENDED": results["RECOMMENDED"]}
        real(*a[:6], only, *a[7:])  # re-checks RECOMMENDED only (and records it as staged)
        results.update(only)
        raise RuntimeError("stage bug after RECOMMENDED")

    monkeypatch.setattr(ds, "_post_solve", half_then_boom)
    resp = optimize_dispatch(r)
    by = {s.name: s for s in resp.scenarios}
    assert not any("not re-checked" in w for w in by["RECOMMENDED"].warnings), by["RECOMMENDED"].warnings
    assert any("not re-checked" in w and "internal error" in w for w in by["MIN_DISTANCE"].warnings)
    for sc in resp.scenarios:
        assert sc.feasibility.status in ("VERIFIED", "VIOLATED")
        if sc.feasibility.status == "VERIFIED":
            assert_plan_rules(r, sc)


# --------------------------------------------------------------------------------------
# Property: VERIFIED always means the plan rules hold; nothing unverified is advertised
# --------------------------------------------------------------------------------------

@pytest.mark.parametrize("day_name", ["half_load", "nmwc", "stress"])
def test_verified_implies_plan_rules(day_name, monkeypatch):
    monkeypatch.setenv("SOLVER_PARALLEL", "0")
    if day_name == "half_load":
        stops, trucks = half_load_day(seed=4, n=24)
        r = req(stops, trucks, scenarios=ALL, loading_min_per_case=0.2, driver_cost_per_hour=2.0)
    elif day_name == "nmwc":
        stops, trucks = nmwc_day(40, seed=3)
        r = req(stops, trucks, scenarios=ALL, loading_min_per_case=0.05, time_limit_sec=2)
    else:
        # Few trucks, full loads, tight shift: the search's estimated turnaround is often wrong.
        stops = [stop(f"S{i}", 23.55 + 0.01 * (i % 7), 58.30 + 0.015 * (i // 7), cases=90, priority=3 + i % 3) for i in range(9)]
        r = req(stops, [truck("T1", cap=100, max_trips=3), truck("T2", cap=100, max_trips=3)], scenarios=ALL,
                reload_min=20, loading_min_per_case=0.4, shift_max_min=330, shift_start_min=hm("07:00"))
    resp = optimize_dispatch(r)
    by = {s.name: s for s in resp.scenarios}
    for sc in resp.scenarios:
        assert sc.feasibility is not None
        if sc.feasibility.status == "VERIFIED":
            assert_plan_rules(r, sc)
    for w in by["RECOMMENDED"].warnings:
        if "more stop(s) than this plan" in w:
            name = w.split("The ", 1)[1].split(" option", 1)[0].replace(" ", "_")
            assert by[name].feasibility.status == "VERIFIED", w


def test_empty_scenarios_carry_a_report():
    r = req([], [truck("T1")])
    sc = rec(optimize_dispatch(r))
    assert sc.status == "NOTHING_TO_PLAN" and sc.feasibility.status == "VERIFIED"


def test_report_round_trips_through_the_wire_contract():
    r = two_load_day()
    sc, _ = valid(r)
    body = sc.model_dump(mode="json")
    assert body["feasibility"]["status"] == "VERIFIED"
    from dispatch_models import DispatchScenario

    old = {k: v for k, v in body.items() if k != "feasibility"}  # an older solver sends none
    assert DispatchScenario.model_validate(old).feasibility is None
    assert DispatchStop  # imported for the fixtures' types
