"""Moves by hand, PR M1: ``POST /retime-truck-days`` (retime.py) re-times a few truck days exactly from a fresh request
and the edited trucks' new loads, says which hard rule a move breaks and by how much, times the trucks' current loads
in the same call (the cost change), and finds the best place for one stop. No search, no CP-SAT, no worker process.

Synthetic data only (the repository is public): trucks T1..T9, stops A..Z / S0.. at invented points near an invented
depot. Haversine (no network) unless a test mocks OSRM.
"""
from __future__ import annotations

import os
import re
import subprocess
import sys
import textwrap
import threading
import time

import httpx
import pytest
from fastapi.testclient import TestClient

import dispatch_solver as ds
import load_repack as LR
import main
import retime
from dispatch_models import (
    FeasibilityReport,
    FrozenTrip,
    RetimeBest,
    RetimeOption,
    RetimeRequest,
    RetimeResponse,
    RetimeTruckBefore,
    RetimeTruckDay,
    RetimeTruckOut,
)
from tests.test_dispatch import _osrm_ok_transport, hm, rec, req, stop, truck
from tests.test_repack import assert_plan_rules, matrix_for

SOLVER_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TOKEN = "unit-test-solver-token"
HEADERS = {"X-Solver-Token": TOKEN}
# The production shape of the rules (synthetic values): shift 07:30, 60-min break starting 14:00-15:00.
BREAK = dict(break_min=60, break_start_from_min=hm("14:00"), break_start_to_min=hm("15:00"))


def days(**loads) -> list[RetimeTruckDay]:
    return [RetimeTruckDay(truck_id=t, loads=l) for t, l in loads.items()]


def body(r, after: dict, before: dict | None = None, best: RetimeBest | None = None) -> RetimeRequest:
    return RetimeRequest(request=r, truck_days=days(**after), before=days(**before) if before is not None else None, best=best)


def run(r, after: dict, before: dict | None = None, best: RetimeBest | None = None, **kw) -> RetimeResponse:
    return retime.retime_truck_days(body(r, after, before, best), **kw)


def truck_out(out: RetimeResponse, tid: str) -> RetimeTruckOut:
    return next(t for t in out.trucks if t.truck_id == tid)


def codes(t: RetimeTruckOut) -> set[str]:
    return {v.code for v in t.violations}


def sub_request(r, ids: list[str]):
    """The request of only the stops a scenario carries (what assert_plan_rules reconciles against)."""
    keep = set(ids)
    return r.model_copy(update={"stops": [s for s in r.stops if s.stop_id in keep]})


def town(**cfg):
    """Six stops around the depot, two trucks, costs and the break rule."""
    stops = [stop(f"S{i}", 23.585 + 0.02 * (i % 3), 58.39 + 0.03 * (i // 3) + 0.01 * i, cases=20,
                  hard_start_min=hm("07:00"), hard_end_min=hm("18:00")) for i in range(6)]
    base = dict(shift_start_min=hm("07:30"), shift_max_min=11 * 60 + 30, driver_cost_per_hour=2.5, reload_min=35,
                loading_min_per_case=0.02, **BREAK)
    base.update(cfg)
    return req(stops, [truck("T1", cap=100, fixed_cost=20, cost_per_km=0.1), truck("T2", cap=100, fixed_cost=20, cost_per_km=0.1)],
               **base)


# --------------------------------------------------------------------------------------
# Exact timing: the plan's own numbers
# --------------------------------------------------------------------------------------

def test_an_optimized_plan_is_retimed_to_the_same_loads_times_and_costs(monkeypatch):
    """Identity: re-timing an optimized plan's truck days gives its loads, times and money back, VERIFIED / EXACT,
    and a cost change of 0 against itself."""
    monkeypatch.setenv("SOLVER_PARALLEL", "0")
    r = town(time_limit_sec=2)
    sc = rec(ds.optimize_dispatch(r))
    assert sc.loads and not sc.unserved
    per: dict[str, list[list[str]]] = {}
    for ld in sorted(sc.loads, key=lambda l: (l.truck_id, l.load_no)):
        per.setdefault(ld.truck_id, []).append([st.stop_id for st in ld.stops])
    out = run(r, per, before=per)
    assert out.ok and out.scenario is not None
    assert (out.scenario.feasibility.status, out.scenario.feasibility.timing) == ("VERIFIED", "EXACT")
    got = {(l.truck_id, l.load_no): l for l in out.scenario.loads}
    for ld in sc.loads:
        g = got[(ld.truck_id, ld.load_no)]
        assert (g.depart_min, g.return_min, g.total_cost, g.distance_km) == (ld.depart_min, ld.return_min, ld.total_cost, ld.distance_km)
        assert [s.service_start_min for s in g.stops] == [s.service_start_min for s in ld.stops]
    assert out.scenario.operating_cost == sc.operating_cost
    for t in out.trucks:
        assert t.feasible and t.before is not None and t.before.feasible
        assert (t.delta_money_omr, t.delta_soft_omr, t.delta_km, t.delta_last_return_min) == (0.0, 0.0, 0.0, 0)
    assert out.delta_money_omr == 0.0 and out.timings >= 1


def test_a_move_between_two_trucks_keeps_every_rule_and_follows_the_frozen_loads():
    """S2 moves from T2 to T1, whose first load is locked: T1's new load is load 2, after the exact turnaround;
    the scenario passes every plan rule; the cost change is after - before per truck and in total."""
    r = town()
    r.trucks[0] = r.trucks[0].model_copy(update={"frozen_trips": [FrozenTrip(load_no=1, depart_min=hm("07:30"),
                                                                             return_min=hm("09:00"), cases=60)]})
    before = {"T1": [["S0", "S1"]], "T2": [["S2", "S3"]]}
    after = {"T1": [["S0", "S1", "S2"]], "T2": [["S3"]]}
    out = run(r, after, before)
    assert out.ok, out.trucks
    sc = out.scenario
    assert_plan_rules(sub_request(r, ["S0", "S1", "S2", "S3"]), sc)
    t1 = [l for l in sc.loads if l.truck_id == "T1"]
    assert [l.load_no for l in t1] == [2]
    assert t1[0].depart_min >= hm("09:00") + 35 + round(0.02 * 60)
    assert (sc.frozen_trucks, sc.frozen_loads, sc.trucks_used) == (1, 1, 2)
    for t in out.trucks:
        assert t.delta_money_omr == pytest.approx(t.money_omr - t.before.money_omr, abs=0.0011)
        assert t.delta_km == pytest.approx(t.km - t.before.km, abs=0.011)
    assert out.delta_money_omr == pytest.approx(sum(t.delta_money_omr for t in out.trucks), abs=0.0011)
    # The money is the plan's own cost model: the loads' costs add up to it, to the rounding of one total per load.
    for t in out.trucks:
        assert t.money_omr == pytest.approx(sum(l.total_cost for l in sc.loads if l.truck_id == t.truck_id), abs=0.0011)


def test_a_reorder_within_a_load_keeps_the_order_sent():
    r = town()
    out = run(r, {"T1": [["S2", "S0", "S1"]]})
    assert out.ok
    assert [s.stop_id for s in out.scenario.loads[0].stops] == ["S2", "S0", "S1"]


def test_a_stop_taken_off_the_plan_and_an_unserved_order_put_on_a_load():
    """Off the plan: T2 keeps S3 only (S2 is no longer in truck_days); on a load: S5, on no load before, rides T1.
    The scenario carries exactly the stops of truck_days and no unserved stop: the web keeps the rest."""
    r = town()
    out = run(r, {"T1": [["S0", "S1", "S5"]], "T2": [["S3"]]}, before={"T1": [["S0", "S1"]], "T2": [["S2", "S3"]]})
    assert out.ok
    assert sorted(st.stop_id for ld in out.scenario.loads for st in ld.stops) == ["S0", "S1", "S3", "S5"]
    assert out.scenario.unserved == []
    assert truck_out(out, "T2").delta_money_omr < 0 and truck_out(out, "T1").delta_money_omr > 0
    # The last stop of a truck taken off: no new load left, its money and km go to 0.
    out = run(r, {"T2": []}, before={"T2": [["S2"]]})
    t2 = truck_out(out, "T2")
    assert out.ok and t2.loads == 0 and t2.money_omr == 0.0 and t2.delta_money_omr == -t2.before.money_omr
    assert out.scenario.loads == []


# --------------------------------------------------------------------------------------
# Hard rules refuse, and say which and by how much
# --------------------------------------------------------------------------------------

def _bay_request(**cfg):
    stops = [stop("A1", 23.60, 58.40, cases=300, demand_pallet_units=6_000), stop("A2", 23.601, 58.401, cases=290, demand_pallet_units=5_900),
             stop("B", 23.61, 58.41, cases=30, demand_pallet_units=500)]
    stops[1] = stops[1].model_copy(update={"customer_id": stops[0].customer_id})  # A1 and A2: two parts of one customer
    return req(stops, [truck("T1", cap=2000, bays=12)], pallet_fill_pct=98, single_customer_fill_pct=100, shift_start_min=hm("07:30"), **cfg)


@pytest.mark.parametrize("load, ok", [(["A1", "A2"], True), (["A1", "A2", "B"], False), (["A1", "B"], True)])
def test_bays_at_98_percent_for_several_customers_and_100_for_one(load, ok):
    """12 bays: one customer may fill 12.00 pallets (100%), several customers 11.76 (98%). 11.90 pallets of one
    customer (two split parts) fit; the same with another customer's 0.50 is refused by 0.64 pallets."""
    out = run(_bay_request(), {"T1": [load]})
    t = truck_out(out, "T1")
    assert out.ok is ok and t.feasible is ok
    if not ok:
        [v] = t.violations
        assert v.code == "CAPACITY_PALLETS" and v.short_by_min == pytest.approx(0.6, abs=0.05)
        assert "11.8" in v.message and "98%" in v.message
        assert out.scenario is not None and out.scenario.feasibility.status == "VIOLATED"
    else:
        assert out.scenario.loads[0].pallet_room_units == (12_000 if len({s for s in load if s.startswith("A")}) == len(load) else 11_760)


def test_cases_and_kg_over_capacity_are_refused_with_how_much():
    stops = [stop("A", 23.60, 58.40, cases=70), stop("B", 23.61, 58.41, cases=50), stop("C", 23.62, 58.42, cases=10, demand_kg=700),
             stop("D", 23.63, 58.43, cases=10, demand_kg=500)]
    r = req(stops, [truck("T1", cap=100), truck("T2", cap=500, capacity_kg=1000)], shift_start_min=hm("07:30"))
    out = run(r, {"T1": [["A", "B"]], "T2": [["C", "D"]]})
    assert not out.ok
    [v1] = truck_out(out, "T1").violations
    [v2] = truck_out(out, "T2").violations
    assert (v1.code, v1.short_by_min, v1.load_no) == ("CAPACITY_CASES", 20, 1)
    assert (v2.code, v2.short_by_min) == ("CAPACITY_KG", 200)


def test_a_small_truck_only_customer_is_refused_on_a_big_truck():
    s = stop("A", 23.60, 58.40, allowed_truck_ids=["T2"], allowed_trucks_label="a small truck")
    r = req([s, stop("B", 23.61, 58.41)], [truck("T1"), truck("T2", cap=100)], shift_start_min=hm("07:30"))
    out = run(r, {"T1": [["B", "A"]]})
    [v] = truck_out(out, "T1").violations
    assert not out.ok and v.code == "TRUCK_NOT_ALLOWED" and v.stop_id == "A" and "a small truck" in v.message
    assert run(r, {"T2": [["B", "A"]]}).ok
    assert run(r, {"T2": [["B", "A"]]}).scenario.allowed_trucks_rule is True


@pytest.mark.parametrize("rule, late_by", [("START", 10), ("FINISH", 20)])
def test_receiving_hours_missed_name_the_stop_and_the_minutes(rule, late_by):
    """A stop about 32 min away that closes at 07:50: the truck leaves at 07:30 at the earliest, so under START it
    starts about 12 min late, under FINISH (10 min unloading) it finishes about 22 min late."""
    far = stop("F", 23.585 + 0.15, 58.39, hard_start_min=hm("07:00"), hard_end_min=hm("07:50"), service_min=10)
    r = req([far], [truck("T1")], shift_start_min=hm("07:30"), window_rule=rule)
    out = run(r, {"T1": [["F"]]})
    [v] = truck_out(out, "T1").violations
    assert not out.ok and v.code == "HARD_WINDOW" and v.stop_id == "F" and late_by <= v.short_by_min <= late_by + 5
    assert out.scenario.loads[0].depart_min == hm("07:30")  # the earliest timetable: it leaves at the shift start


def test_back_after_the_latest_return_is_refused():
    far = stop("F", 23.585 + 0.15, 58.39, hard_start_min=hm("11:30"), hard_end_min=hm("12:30"))
    r = req([far], [truck("T1")], shift_start_min=hm("07:30"), latest_return_min=hm("12:00"))
    out = run(r, {"T1": [["F"]]})
    [v] = truck_out(out, "T1").violations
    assert not out.ok and v.code == "SHIFT_LIMIT" and "latest return" in v.message and v.short_by_min >= 10


def test_a_day_longer_than_the_shift_maximum_is_refused():
    a = stop("A", 23.60, 58.40, hard_start_min=hm("07:30"), hard_end_min=hm("08:30"))
    b = stop("B", 23.60, 58.41, hard_start_min=hm("11:30"), hard_end_min=hm("12:00"))
    r = req([a, b], [truck("T1")], shift_start_min=hm("07:30"), shift_max_min=180)
    out = run(r, {"T1": [["A"], ["B"]]})
    assert not out.ok and "SHIFT_LIMIT" in codes(truck_out(out, "T1"))
    assert any("shift maximum" in v.message for v in truck_out(out, "T1").violations)


def test_more_loads_than_trips_left_and_a_truck_with_none_left():
    frozen = [FrozenTrip(load_no=1, depart_min=hm("07:30"), return_min=hm("09:00"), cases=40)]
    r = req([stop("A", 23.60, 58.40), stop("B", 23.61, 58.41)],
            [truck("T1", max_trips=2, frozen_trips=frozen), truck("T2", max_trips=1, frozen_trips=frozen)],
            shift_start_min=hm("07:30"))
    out = run(r, {"T1": [["A"], ["B"]]})
    assert not out.ok and codes(truck_out(out, "T1")) == {"TRIPS"}
    out = run(r, {"T2": [["A"]]})
    [v] = truck_out(out, "T2").violations
    assert not out.ok and v.code == "TRIPS" and "most loads a day (1)" in v.message


def test_a_frozen_load_pushes_the_new_load_and_a_window_it_misses_is_named():
    frozen = [FrozenTrip(load_no=1, depart_min=hm("07:30"), return_min=hm("10:00"), cases=60)]
    near = stop("N", 23.60, 58.40, cases=50, hard_start_min=hm("07:00"), hard_end_min=hm("10:15"))
    r = req([near], [truck("T1", frozen_trips=frozen)], shift_start_min=hm("07:30"), reload_min=30, loading_min_per_case=0.02)
    out = run(r, {"T1": [["N"]]})
    [v] = truck_out(out, "T1").violations
    assert not out.ok and v.code == "HARD_WINDOW" and v.stop_id == "N"
    ld = out.scenario.loads[0]
    assert (ld.load_no, ld.depart_min) == (2, hm("10:00") + 30 + 1)  # back 10:00 + reload 30 + 50 cases x 0.02
    r.stops[0] = near.model_copy(update={"hard_end_min": hm("12:00")})
    out = run(r, {"T1": [["N"]]})
    assert out.ok and out.scenario.loads[0].depart_min >= hm("10:31")


def test_a_move_on_the_delivery_day_leaves_after_the_plan_is_made():
    """loading_from_min (a same-day plan): loading starts then, so the new load leaves after it + the turnaround; a
    stop that closes before that is refused."""
    r = req([stop("A", 23.60, 58.40, cases=50), stop("B", 23.61, 58.41, cases=10, hard_end_min=hm("13:30"))], [truck("T1")],
            shift_start_min=hm("07:30"), reload_min=30, loading_min_per_case=0.04, loading_from_min=hm("13:00"))
    out = run(r, {"T1": [["A"]]})
    assert out.ok
    assert_plan_rules(sub_request(r, ["A"]), out.scenario)
    assert out.scenario.loads[0].depart_min >= hm("13:00") + 30 + 2
    out = run(r, {"T1": [["B"]]})
    assert not out.ok and codes(truck_out(out, "T1")) == {"HARD_WINDOW"}


def _no_break_place(**cfg):
    """P about an hour out, served at 14:20 sharp; Q a few minutes on, served the minute the drive allows, then 30
    min of unloading: no 60-min break can start between 14:00 and 15:00 anywhere in that day."""
    p = stop("P", 23.585 + 0.28, 58.39, hard_start_min=hm("14:20"), hard_end_min=hm("14:20"))
    q = stop("Q", 23.585 + 0.28, 58.42, service_min=30)
    base = dict(shift_start_min=hm("07:30"), shift_max_min=12 * 60, **BREAK)
    base.update(cfg)
    r = req([p, q], [truck("T1")], **base)
    mx = matrix_for(r)
    t_q = -(-(hm("14:30") * 60 + mx.duration_s[1][2]) // 60)  # the first minute Q can start
    r.stops[1] = q.model_copy(update={"hard_start_min": t_q, "hard_end_min": t_q})
    return r


def test_no_place_for_the_driver_break_is_refused_as_break():
    r = _no_break_place()
    out = run(r, {"T1": [["P", "Q"]]})
    [v] = truck_out(out, "T1").violations
    assert not out.ok and v.code == "BREAK" and "60-min break" in v.message and "14:00-15:00" in v.message
    # The same stops without the break rule keep every rule.
    assert run(_no_break_place(break_min=0), {"T1": [["P", "Q"]]}).ok
    # A break already recorded on a locked load is kept: none is needed again.
    r.trucks[0] = r.trucks[0].model_copy(update={"frozen_trips": [FrozenTrip(load_no=1, depart_min=hm("07:30"), return_min=hm("08:30"),
                                                                             break_start_min=hm("08:00"), break_min=60)]})
    out = run(r, {"T1": [["P", "Q"]]})
    assert out.ok and out.scenario.loads[0].load_no == 2
    assert out.scenario.truck_days[0].break_status == "IN_FROZEN_LOAD"


def test_a_truck_with_no_time_left_today_is_refused_as_truck_availability():
    """A truck whose own hours end before the day starts takes no load (trips are left, no break rule)."""
    r = req([stop("A", 23.60, 58.40)], [truck("T1", available_to_min=hm("07:00")), truck("T2")], shift_start_min=hm("07:30"))
    out = run(r, {"T1": [["A"]]})
    [v] = truck_out(out, "T1").violations
    assert not out.ok and v.code == "TRUCK_AVAILABILITY" and "no time left" in v.message and "07:00" in v.message
    assert run(r, {"T2": [["A"]]}).ok


def test_no_timetable_when_no_rule_is_named(monkeypatch):
    """No exact timetable exists, but neither the reasons found here nor the independent check (stubbed to find
    nothing) name a rule: the truck still refuses (NO_TIMETABLE), never ok."""
    far = stop("F", 23.585 + 0.15, 58.39, hard_start_min=hm("07:00"), hard_end_min=hm("07:50"), service_min=10)
    r = req([far], [truck("T1")], shift_start_min=hm("07:30"))
    monkeypatch.setattr(ds.FZ, "safe_check", lambda *_a, **_k: FeasibilityReport(status="VERIFIED", timing="ESTIMATED", violations=[]))
    out = run(r, {"T1": [["F"]]})
    [v] = truck_out(out, "T1").violations
    assert not out.ok and v.code == "NO_TIMETABLE" and "No timetable keeps every rule for T1" in v.message


def test_an_unverified_check_is_never_ok_and_says_so(monkeypatch):
    """The independent check could not run (UNVERIFIED): the move is not ok although every truck was timed, and the
    warning says it cannot be saved now."""
    monkeypatch.setattr(ds.FZ, "safe_check", lambda *_a, **_k: FeasibilityReport(status="UNVERIFIED", timing="EXACT", violations=[]))
    out = run(town(), {"T1": [["S0", "S1"]]})
    assert truck_out(out, "T1").feasible and not out.ok
    assert out.warnings == ["The independent timetable check could not run for these trucks: the move cannot be saved now."]


def test_current_loads_that_no_longer_keep_the_rules_are_reported():
    """before: T1's current load misses a receiving time that changed since planning (today's data). It is reported
    (not feasible, why, no money), and the cost change is then unknown; the move itself is checked as usual."""
    a = stop("A", 23.60, 58.40, hard_start_min=hm("07:00"), hard_end_min=hm("07:40"))
    b = stop("B", 23.585 + 0.15, 58.39, hard_start_min=hm("07:00"), hard_end_min=hm("07:50"))
    r = req([a, b], [truck("T1"), truck("T2")], shift_start_min=hm("07:30"))
    out = run(r, {"T1": [["A"]], "T2": [["B"]]}, before={"T1": [["A", "B"]], "T2": []})
    t1 = truck_out(out, "T1")
    assert t1.before is not None and not t1.before.feasible and t1.before.money_omr is None
    assert {v.code for v in t1.before.violations} == {"HARD_WINDOW"}
    assert t1.delta_money_omr is None and out.delta_money_omr is None
    assert not out.ok and codes(truck_out(out, "T2")) == {"HARD_WINDOW"}  # B is still too far for 07:50


# --------------------------------------------------------------------------------------
# Best place
# --------------------------------------------------------------------------------------

def _two_loads():
    """T8's day: L1 with four stops in the morning, L2 with one stop C7 alone in the afternoon (the shape of a load
    kept for a customer whose receiving hours were later corrected to the whole day)."""
    stops = [stop(f"K{i}", 23.60 + 0.012 * i, 58.40 + 0.01 * i, cases=40, hard_start_min=hm("07:00"), hard_end_min=hm("19:00"))
             for i in range(4)]
    stops.append(stop("C7", 23.63, 58.43, cases=13, hard_start_min=hm("09:00"), hard_end_min=hm("19:00")))
    return req(stops, [truck("T8", cap=400, fixed_cost=20, trip_cost=2, cost_per_km=0.1)], shift_start_min=hm("07:30"),
               driver_cost_per_hour=2.5, reload_min=35, **BREAK)


def test_best_place_puts_the_lone_stop_on_the_first_load_and_saves_money():
    r = _two_loads()
    before = {"T8": [["K0", "K1", "K2", "K3"], ["C7"]]}
    out = run(r, {"T8": [["K0", "K1", "K2", "K3"]]}, before=before, best=RetimeBest(stop_id="C7", truck_id="T8", load_index=0))
    assert out.ok and out.options and len(out.options) <= 3
    assert (out.best_total, out.best_tried) == (5, 5)
    best = out.options[0]
    assert best.load_index == 0 and best.new_load_at is None and len(best.loads) == 1 and "C7" in best.loads[0]
    assert best.loads[0][best.position] == "C7"
    t8 = truck_out(out, "T8")
    assert t8.loads == 1 and t8.delta_money_omr < 0 and t8.delta_last_return_min < 0
    assert [st.stop_id for st in out.scenario.loads[0].stops] == best.loads[0]
    # The options are in order, and the best is the cheapest of every position (each timed on its own).
    values = [o.money_omr + o.soft_omr for o in out.options]
    assert values == sorted(values)
    every = []
    for p in range(5):
        load = ["K0", "K1", "K2", "K3"]
        load.insert(p, "C7")
        one = run(r, {"T8": [load]})
        if one.ok:
            every.append(truck_out(one, "T8").money_omr + truck_out(one, "T8").soft_omr)
    assert values[0] == pytest.approx(min(every), abs=0.002)
    # Deterministic: the same request, the same answer.
    again = run(r, {"T8": [["K0", "K1", "K2", "K3"]]}, before=before, best=RetimeBest(stop_id="C7", truck_id="T8", load_index=0))
    assert [o.model_dump() for o in again.options] == [o.model_dump() for o in out.options]


def test_best_place_as_a_new_load_and_the_tries_limit(monkeypatch):
    """load_index None: the stop alone as a new load before, between or after the truck's loads. A truck with no
    load today opens its day for it (its fixed cost is in the money). RETIME_BEST_TRIES caps the places timed."""
    r = _two_loads()
    out = run(r, {"T8": [["K0", "K1"], ["K2", "K3"]]}, best=RetimeBest(stop_id="C7", truck_id="T8"))
    assert out.ok and out.best_total == 3 and all(o.new_load_at is not None and o.load_index is None for o in out.options)
    assert all(len(o.loads) == 3 and o.loads[o.new_load_at] == ["C7"] for o in out.options)
    r2 = r.model_copy(update={"trucks": r.trucks + [truck("T9", cap=100, fixed_cost=15, cost_per_km=0.1)]})
    out = run(r2, {"T9": []}, best=RetimeBest(stop_id="C7", truck_id="T9"))
    assert out.ok and out.options[0].loads == [["C7"]] and out.options[0].money_omr > 15
    monkeypatch.setenv("RETIME_BEST_TRIES", "1")
    out = run(r, {"T8": [["K0", "K1", "K2", "K3"]]}, best=RetimeBest(stop_id="C7", truck_id="T8", load_index=0))
    assert out.best_tried == 1 and len(out.options) == 1


def test_best_place_with_no_trip_left_says_why():
    r = _two_loads()
    r.trucks[0] = r.trucks[0].model_copy(update={"max_trips": 1})
    out = run(r, {"T8": [["K0", "K1", "K2", "K3"]]}, best=RetimeBest(stop_id="C7", truck_id="T8"))
    assert not out.ok and out.options == [] and out.best_tried == 0
    assert codes(truck_out(out, "T8")) == {"TRIPS"}


def _saved_key(out: RetimeResponse):
    """What the web's previewHash reads of an answer (the loads' times and money, each truck's verdict, ok, the
    matrix), plus each truck's money and km."""
    loads = [(l.truck_id, l.load_no, l.depart_min, l.return_min, l.total_cost, l.distance_km,
              [(s.stop_id, s.arrival_min, s.service_start_min) for s in l.stops]) for l in out.scenario.loads]
    trucks = [(t.truck_id, t.feasible, t.money_omr, t.km, t.last_return_min,
               [(v.code, v.load_no, v.stop_id, v.short_by_min) for v in t.violations]) for t in out.trucks]
    return loads, trucks, out.ok, out.distance_quality, out.scenario.feasibility.status


# (request, truck_days, before, best): in a load, as a new load, from another truck.
BEST_CASES = [
    (_two_loads, {"T8": [["K0", "K1", "K2", "K3"]]}, {"T8": [["K0", "K1", "K2", "K3"], ["C7"]]},
     RetimeBest(stop_id="C7", truck_id="T8", load_index=0)),
    (_two_loads, {"T8": [["K0", "K1"], ["K2", "K3"]]}, {"T8": [["K0", "K1"], ["K2", "K3"], ["C7"]]},
     RetimeBest(stop_id="C7", truck_id="T8")),
    (town, {"T1": [["S0", "S1"]], "T2": [["S3"]]}, {"T1": [["S0", "S1"]], "T2": [["S2", "S3"]]},
     RetimeBest(stop_id="S2", truck_id="T1", load_index=0)),
]


@pytest.mark.parametrize("case", range(3))
def test_a_best_place_gives_exactly_the_timetable_of_the_concrete_call_a_save_sends(case):
    """Save sends the best place as concrete loads (options[0].loads, no best) and must find the same preview hash:
    the best-place call and that concrete call give the same loads, times, money and verdicts."""
    assert len(BEST_CASES) == 3
    make, after, before, best = BEST_CASES[case]
    r = make()
    out = run(r, after, before=before, best=best)
    assert out.ok and out.options
    o = out.options[0]
    concrete = run(r, {**after, o.truck_id: o.loads}, before=before)
    assert _saved_key(concrete) == _saved_key(out)
    assert (concrete.delta_money_omr, concrete.delta_km) == (out.delta_money_omr, out.delta_km)


def test_out_of_time_before_any_place_is_found_says_so(monkeypatch):
    """The budget runs out before a place is timed (each timing slow and none keeping the rules): no option, the
    truck refuses and the warning says how many places were tried."""
    monkeypatch.setenv("RETIME_BUDGET_SEC", "1")

    def slow_none(*_a, **_k):
        time.sleep(0.6)
        return None

    monkeypatch.setattr(LR, "time_truck", slow_none)
    out = run(_two_loads(), {"T8": [["K0", "K1", "K2", "K3"]]}, best=RetimeBest(stop_id="C7", truck_id="T8", load_index=0))
    assert not out.ok and out.options == [] and out.best_tried < out.best_total == 5
    assert f"Out of time after {out.best_tried} of 5 places for the stop: try again." in out.warnings


def test_the_best_place_search_keeps_to_the_budget(monkeypatch):
    monkeypatch.setenv("RETIME_BUDGET_SEC", "1")
    real = LR.time_truck

    def slow(*a, **kw):
        time.sleep(0.4)
        return real(*a, **kw)

    monkeypatch.setattr(LR, "time_truck", slow)
    t0 = time.monotonic()
    out = run(_two_loads(), {"T8": [["K0", "K1", "K2", "K3"]]}, best=RetimeBest(stop_id="C7", truck_id="T8", load_index=0))
    assert out.best_tried < out.best_total and out.options
    assert time.monotonic() - t0 < 3.5


# --------------------------------------------------------------------------------------
# What the scenario carries
# --------------------------------------------------------------------------------------

def test_day_level_warnings_are_dropped_and_the_counts_are_the_edited_trucks():
    """Another truck's break note and the day's counts mean nothing for one or two trucks: only the edited trucks'
    notes, the matrix's own warning and their counts stay."""
    long_frozen = [FrozenTrip(load_no=1, depart_min=hm("07:00"), return_min=hm("16:00"), cases=40)]
    r = req([stop("A", 23.60, 58.40), stop("B", 23.61, 58.41)],
            [truck("T1"), truck("T2", frozen_trips=long_frozen), truck("T3", frozen_trips=long_frozen)],
            shift_start_min=hm("07:00"), shift_max_min=12 * 60, **BREAK)
    out = run(r, {"T1": [["A"]], "T2": [["B"]]})
    assert out.ok
    sc = out.scenario
    assert any(w.startswith("T2:") for w in sc.warnings) and not any(w.startswith("T3:") for w in sc.warnings)
    assert any("ESTIMATED" in w for w in sc.warnings)
    assert (sc.trucks_used, sc.frozen_trucks, sc.frozen_loads, sc.trips) == (2, 1, 1, 2)


def test_the_scenario_echoes_the_rules_and_the_split_part_ids():
    """Split parts keep the request's stop and order ids exactly (the web maps them back to the plan's portions), and
    the rule echoes are the whole request's, as optimize_dispatch sets them."""
    p1 = stop("C1#1", 23.60, 58.40, cases=40, demand_pallet_units=4_000)
    p2 = stop("C1#2", 23.60, 58.40, cases=40, demand_pallet_units=4_000)
    p1 = p1.model_copy(update={"customer_id": "c-C1", "order_ids": ["o-1~1"]})
    p2 = p2.model_copy(update={"customer_id": "c-C1", "order_ids": ["o-1~2"]})
    other = stop("D", 23.62, 58.42, demand_pallet_units=500, allowed_truck_ids=["T1"])
    r = req([p1, p2, other], [truck("T1", bays=12)], shift_start_min=hm("07:30"), window_rule="FINISH",
            latest_return_min=hm("19:00"), pallet_fill_pct=98, single_customer_fill_pct=100, **BREAK)
    out = run(r, {"T1": [["C1#1", "C1#2"]]})
    sc = out.scenario
    assert out.ok
    assert [(s.stop_id, s.order_ids) for s in sc.loads[0].stops] == [("C1#1", ["o-1~1"]), ("C1#2", ["o-1~2"])]
    assert (sc.window_rule, sc.latest_return_min, sc.pallet_fill_pct, sc.single_customer_fill_pct) == ("FINISH", hm("19:00"), 98, 100)
    assert sc.break_rule.length_min == 60 and sc.pallet_unit == 0.001 and sc.total_pallet_units == 8_000
    assert sc.allowed_trucks_rule is True  # D, a stop of the request on no edited truck, has the list


def test_plan_continuity_is_never_priced_in_a_move():
    r = town(change_penalty_per_stop=3.0)
    r.stops[2] = r.stops[2].model_copy(update={"previous_truck_id": "T2"})
    out = run(r, {"T1": [["S0", "S2"]]})
    plain = run(town(change_penalty_per_stop=0.0), {"T1": [["S0", "S2"]]})
    assert out.ok and out.scenario.preference_penalties.continuity == 0.0
    assert truck_out(out, "T1").soft_omr == truck_out(plain, "T1").soft_omr


# --------------------------------------------------------------------------------------
# Road matrix, rule 22, the API process
# --------------------------------------------------------------------------------------

def test_road_routing_for_the_named_points_only_and_its_fallback():
    calls: list = []
    r = town(distance_provider="OSRM", osrm_url="http://osrm.test:5000", road_time_factor=1.0)
    out = run(r, {"T1": [["S0", "S1"]]}, before={"T1": [["S0", "S2"]]}, osrm_client=httpx.Client(transport=_osrm_ok_transport(calls)))
    assert out.ok and (out.matrix_provider, out.distance_quality, out.distance_is_estimated) == ("OSRM", "ROAD", False)
    assert len(calls) == 1 and calls[0].split("/table/v1/driving/")[1].split("?")[0].count(";") == 3  # depot + S0, S1, S2

    def boom(request):
        raise httpx.ConnectError("unreachable")

    out = run(r, {"T1": [["S0", "S1"]]}, osrm_client=httpx.Client(transport=httpx.MockTransport(boom)))
    assert out.ok and (out.matrix_provider, out.distance_quality) == ("HAVERSINE", "ESTIMATED")
    assert any("ROUTING_PROVIDER_FAILURE" in w for w in out.scenario.warnings)


def test_rule_22_no_search_no_worker_process_no_cp_sat(monkeypatch):
    """Every path (a move, a refusal and its reasons, before, a best place) answers with no route search, no worker
    process and no CP-SAT: the API process only times loads."""
    def forbidden(*_a, **_k):
        raise AssertionError("a move by hand must never search or start a worker")

    for name in ("_start_workers", "_start_extra_workers", "_solve_scenario", "_pv_start", "_run_scenarios", "_post_solve"):
        monkeypatch.setattr(ds, name, forbidden)
    for name in ("repack", "warm_up", "build_candidates", "recover", "trim"):
        monkeypatch.setattr(LR, name, forbidden)
    out = run(_two_loads(), {"T8": [["K0", "K1", "K2", "K3"]]}, before={"T8": [["K0", "K1", "K2", "K3"], ["C7"]]},
              best=RetimeBest(stop_id="C7", truck_id="T8", load_index=0))
    assert out.ok
    assert not run(_no_break_place(), {"T1": [["P", "Q"]]}).ok


def test_the_api_process_loads_no_numpy_or_pyvrp_while_retiming():
    code = textwrap.dedent(
        """
        import sys
        import main  # noqa: F401 - the API module, as uvicorn loads it
        import retime
        from tests.test_retime import _two_loads, body
        from dispatch_models import RetimeBest
        out = retime.retime_truck_days(body(_two_loads(), {"T8": [["K0", "K1", "K2", "K3"]]}, {"T8": [["K0", "K1", "K2", "K3"], ["C7"]]},
                                            RetimeBest(stop_id="C7", truck_id="T8", load_index=0)))
        assert out.ok
        loaded = sorted(m for m in sys.modules if m.split(".")[0] in ("pyvrp", "numpy"))
        print("LOADED=" + ",".join(loaded))
        """
    )
    r = subprocess.run([sys.executable, "-c", code], cwd=SOLVER_DIR, capture_output=True, text=True, timeout=180)
    assert r.returncode == 0, r.stderr[-3000:]
    assert r.stdout.strip().endswith("LOADED="), r.stdout[-2000:]


# --------------------------------------------------------------------------------------
# The endpoint
# --------------------------------------------------------------------------------------

def _json(r, after: dict, **kw) -> dict:
    return body(r, after, **kw).model_dump(mode="json")


def _many_trucks():
    return req([stop("A", 23.60, 58.40)], [truck(f"T{i}") for i in range(1, 8)])


def _many_stops():
    return req([stop(f"S{i:02d}", 23.60 + 0.001 * i, 58.40) for i in range(81)], [truck("T1")])


# (request, truck_days, other fields, words of the 422's detail)
BAD = [
    (town, {"T1": [["S0", "ZZ"]]}, {}, "Unknown stop ZZ"),
    (town, {"T7": [["S0"]]}, {}, "Unknown truck T7"),
    (town, {"T1": [["S0"]], "T2": [["S0"]]}, {}, "Stop S0 is on more than one load"),
    (town, {"T1": [["S0"], []]}, {}, "load 2 in truck_days has no stop"),
    (_many_trucks, {f"T{i}": [] for i in range(1, 8)}, {}, "At most 6 trucks"),
    (_many_stops, {"T1": [[f"S{i:02d}" for i in range(81)]]}, {}, "At most 80 stops"),
    (town, {"T1": [["S0"]]}, {"best": RetimeBest(stop_id="S1", truck_id="T2")}, "not in truck_days"),
    (town, {"T1": [["S0"]]}, {"best": RetimeBest(stop_id="S0", truck_id="T1")}, "Stop S0 is on more than one load"),
    (town, {"T1": [["S0"]]}, {"best": RetimeBest(stop_id="S1", truck_id="T1", load_index=1)}, "has no load 2"),
    (town, {"T1": [["S0"]]}, {"before": {"T2": [["S0"]]}}, "exactly the trucks of truck_days"),
    (town, {"T1": [["S0"]]}, {"before": {"T1": [["S1", "S1"]]}}, "Stop S1 is on more than one load in before"),
]


@pytest.mark.parametrize("case", range(11))
def test_requests_the_check_cannot_read_are_refused_with_422(monkeypatch, case):
    make, after, kw, words = BAD[case]
    assert len(BAD) == 11
    monkeypatch.setattr(main, "SOLVER_TOKEN", TOKEN)
    res = TestClient(main.app).post("/retime-truck-days", json=_json(make(), after, **kw), headers=HEADERS)
    assert res.status_code == 422 and words in res.json()["detail"], res.text


def test_the_endpoint_checks_the_token_answers_busy_and_gives_its_slot_back(monkeypatch):
    monkeypatch.setattr(main, "SOLVER_TOKEN", TOKEN)
    monkeypatch.setattr(main, "_RETIME_SLOTS", threading.BoundedSemaphore(1))
    client = TestClient(main.app)
    payload = _json(town(), {"T1": [["S0", "S1"]]})
    assert client.post("/retime-truck-days", json=payload).status_code == 401
    assert client.post("/retime-truck-days", json=payload, headers={"X-Solver-Token": "wrong"}).status_code == 401
    assert main._RETIME_SLOTS.acquire(blocking=False)  # every slot taken
    try:
        busy = client.post("/retime-truck-days", json=payload, headers=HEADERS)
        assert busy.status_code == 503 and busy.json()["detail"] == retime.BUSY_TEXT and busy.headers["Retry-After"] == "5"
    finally:
        main._RETIME_SLOTS.release()
    ok = client.post("/retime-truck-days", json=payload, headers=HEADERS)
    assert ok.status_code == 200 and ok.json()["ok"] is True
    assert main._RETIME_SLOTS._value == 1
    # It takes no dispatch slot.
    assert main._DISPATCH_SLOTS._value == main.MAX_CONCURRENT_DISPATCH


def test_ready_and_the_startup_line_name_the_limits(monkeypatch):
    monkeypatch.setattr(main, "SOLVER_TOKEN", TOKEN)
    monkeypatch.delenv("OSRM_URL", raising=False)
    got = TestClient(main.app).get("/ready", headers=HEADERS).json()
    assert got["ok"] is True
    assert got["retime"] == {"version": 1, "max_concurrent": main.RETIME_MAX_CONCURRENT, "budget_sec": 10.0, "matrix_sec": 6.0,
                             "best_tries": 24}
    assert retime.startup_line() == ("Re-timing for moves by hand (/retime-truck-days v1): max 4 at once, budget 10 s, road matrix "
                                     "6 s, best place 24 tries")
    monkeypatch.setenv("RETIME_BUDGET_SEC", "fast")
    monkeypatch.setenv("RETIME_BEST_TRIES", "500")
    assert retime.budget_sec() == 10.0 and retime.best_tries() == 24
    line = retime.startup_line()
    assert "RETIME_BUDGET_SEC='fast' not read (a number from 1 to 60)" in line
    assert "RETIME_BEST_TRIES='500' not read (a whole number from 1 to 200)" in line


def test_the_typescript_mirror_has_every_field_of_the_contract():
    p = os.path.join(SOLVER_DIR, "..", "..", "packages", "shared-types", "src", "dispatch.ts")
    if not os.path.exists(p):
        pytest.skip("shared-types is not next to the solver (image build)")
    with open(p, encoding="utf-8") as f:
        ts = f.read().replace("\r\n", "\n")
    for model in (RetimeTruckDay, RetimeBest, RetimeRequest, RetimeTruckBefore, RetimeTruckOut, RetimeOption, RetimeResponse):
        block = ts.split(f"export interface {model.__name__} {{", 1)[1].split("\n}", 1)[0]
        assert set(re.findall(r"^\s+(\w+)\??:", block, re.M)) == set(model.model_fields), model.__name__
    assert "| 'NO_TIMETABLE'" in ts
    # The web refuses a check over the stop limit before calling (TOO_MANY_STOPS): the same number.
    with open(os.path.join(SOLVER_DIR, "..", "web", "lib", "dispatch", "plan-edit.ts"), encoding="utf-8") as f:
        assert f"export const RETIME_MAX_STOPS = {retime.RETIME_MAX_STOPS};" in f.read()
