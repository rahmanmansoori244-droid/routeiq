"""Moves by hand, part 2 (25 Oct 2026): ``POST /retime-truck-days`` v2 (retime.py) - several stops at once, whole
loads and swaps, and "allow anyway" (a late arrival, capacity up to 20% over the truck's own, the driver break).
Tests S-1..S-19 of the design; test_retime.py (v1) stays green unchanged apart from the version, the stop limit and
the mirror.

Synthetic data only (the repository is public): trucks T1..T9, stops A..Z / K0.. / S0.. at invented points near an
invented depot. A fixed matrix (``fixed_legs``) sets drive times to the second, so lateness is exact.
"""
from __future__ import annotations

import os
import subprocess
import sys
import textwrap
import time

import pytest
from fastapi.testclient import TestClient
from pydantic import ValidationError

import dispatch_solver as ds
import feasibility as FZ
import load_repack as LR
import main
import retime
from dispatch_models import (
    FeasibilityReport,
    FeasibilityViolation,
    FrozenTrip,
    RetimeBest,
    RetimeRelaxations,
    RetimeRelaxPolicy,
    RetimeRequest,
    RetimeResponse,
    RetimeTruckDay,
)
from providers import MatrixResult
from tests.test_dispatch import hm, req, stop, truck
from tests.test_feasibility import shifted, two_load_day, valid
from tests.test_repack import assert_plan_rules
from tests.test_retime import (
    BREAK,
    HEADERS,
    SOLVER_DIR,
    TOKEN,
    _bay_request,
    _no_break_place,
    _saved_key,
    _two_loads,
    codes,
    days,
    sub_request,
    town,
    truck_out,
)

# What the web sends when PLAN_EDIT_OVERRIDES is on (capacity_factor = 1 + OVERRIDE_CAPACITY_MAX_PCT / 100).
POLICY = RetimeRelaxPolicy(late=True, capacity_factor=1.2, no_break=True)


def call(r, after: dict, before: dict | None = None, best: RetimeBest | None = None, relax: RetimeRelaxPolicy | None = None,
         before_relax: RetimeRelaxations | None = None, **kw) -> RetimeResponse:
    return retime.retime_truck_days(RetimeRequest(request=r, truck_days=days(**after),
                                                  before=days(**before) if before is not None else None, best=best,
                                                  relax=relax, before_relax=before_relax), **kw)


def fixed_legs(monkeypatch, legs: dict | None = None, default: int = 600) -> None:
    """Every drive ``default`` seconds (10 km) except legs[(a, b)] (stop ids, None = the depot; both ways): lateness to
    the second."""
    legs = legs or {}

    def matrix(r, stops, deadline, osrm_client=None):
        ids = [None] + [s.stop_id for s in stops]
        n = len(ids)
        dur = [[0 if i == j else legs.get((ids[i], ids[j]), legs.get((ids[j], ids[i]), default)) for j in range(n)]
               for i in range(n)]
        dist = [[0 if i == j else 10_000 for j in range(n)] for i in range(n)]
        return MatrixResult(dist, dur, "HAVERSINE", True, [], all_estimated=True, quality="ESTIMATED")

    monkeypatch.setattr(retime, "_matrix", matrix)


def relaxed_key(out: RetimeResponse) -> dict:
    """The relaxed answer as the web's overrides hash reads it, and more (everything but the solve time)."""
    assert out.relaxed is not None
    return out.relaxed.model_dump(mode="json", exclude={"scenario": {"solver_time_sec"}})


def violations(out: RetimeResponse):
    return [v for t in out.trucks for v in t.violations]


def late_day(monkeypatch, late_s: int, rule: str = "START", **cfg):
    """A late by ``late_s`` seconds at the earliest (the truck leaves at 07:30, the drive is 600 s + late_s, its hours end
    07:40 - under FINISH 07:50 with 10 min of unloading); B after it, open all day."""
    fixed_legs(monkeypatch, {(None, "A"): 600 + late_s})
    end = hm("07:40") if rule == "START" else hm("07:50")
    a = stop("A", 23.60, 58.40, hard_start_min=hm("07:00"), hard_end_min=end, service_min=10)
    b = stop("B", 23.61, 58.41, hard_start_min=hm("07:00"), hard_end_min=hm("18:00"), service_min=10)
    return req([a, b], [truck("T1")], shift_start_min=hm("07:30"), window_rule=rule, **cfg)


# --------------------------------------------------------------------------------------
# S-1 A v1 request (the web deployed now) gets the v1 answer
# --------------------------------------------------------------------------------------

def test_a_v1_request_gets_the_v1_answer_with_the_v2_fields_defaulted():
    """S-1: no relaxed answer, nothing allowed, nothing judged for overrides, retime_version 2 and the layout."""
    r = town()
    after, before = {"T1": [["S0", "S1", "S2"]], "T2": [["S3"]]}, {"T1": [["S0", "S1"]], "T2": [["S2", "S3"]]}
    out = call(r, after, before)
    assert out.ok and out.retime_version == 2 and out.relaxed is None
    assert [(d.truck_id, d.loads) for d in out.loads] == list(after.items())
    assert out.scenario.feasibility.allowed == []
    for t in out.trucks:
        assert t.allowed == [] and t.before.allowed == []
    # A refused v1 move: the figures are filled (value / limit / late_s), never the override judgement.
    r = req([stop("A", 23.60, 58.40, cases=70), stop("B", 23.61, 58.41, cases=50)], [truck("T1", cap=100)],
            shift_start_min=hm("07:30"))
    [v] = violations(call(r, {"T1": [["A", "B"]]}))
    assert (v.code, v.value, v.limit, v.capacity, v.overridable) == ("CAPACITY_CASES", 120, 100, 100, None)


def test_a_v1_shaped_best_runs_v1_best_exactly(monkeypatch):
    """S-1 / F15: a best without any v2 field runs v1 _best (every position, 24 tries, 3 options), never the v2
    placement - also with ``relax`` when it finds a place."""
    seen = []
    real = retime._best
    monkeypatch.setattr(retime, "_best", lambda *a, **k: seen.append(1) or real(*a, **k))
    monkeypatch.setattr(retime, "_best_v2", lambda *a, **k: (_ for _ in ()).throw(AssertionError("v2 placement")))
    r = _two_loads()
    for relax in (None, POLICY):
        out = call(r, {"T8": [["K0", "K1", "K2", "K3"]]}, best=RetimeBest(stop_id="C7", truck_id="T8", load_index=0), relax=relax)
        assert out.ok and (out.best_total, out.best_tried) == (5, 5) and 1 <= len(out.options) <= 3 and out.relaxed is None
        assert out.loads[0].loads == out.options[0].loads
    assert len(seen) == 2


def test_the_deployed_web_s_json_without_v2_fields_is_answered_as_before(monkeypatch):
    """S-1 over HTTP: the JSON the web deployed now sends (no v2 key at all) answers 200 with the same v1 answer."""
    monkeypatch.setattr(main, "SOLVER_TOKEN", TOKEN)
    body = RetimeRequest(request=_two_loads(), truck_days=days(T8=[["K0", "K1", "K2", "K3"]]),
                         best=RetimeBest(stop_id="C7", truck_id="T8", load_index=0))
    payload = body.model_dump(mode="json")
    for key in ("relax", "before_relax"):
        payload.pop(key)
    for key in ("more_stop_ids", "keep_order", "new_load_at"):
        payload["best"].pop(key)
    res = TestClient(main.app).post("/retime-truck-days", json=payload, headers=HEADERS)
    assert res.status_code == 200
    got = RetimeResponse(**res.json())
    direct = retime.retime_truck_days(body)
    assert _saved_key(got) == _saved_key(direct) and [o.model_dump() for o in got.options] == [o.model_dump() for o in direct.options]
    assert got.retime_version == 2 and got.relaxed is None


# --------------------------------------------------------------------------------------
# S-2 The check's figures (every caller)
# --------------------------------------------------------------------------------------

def test_capacity_figures_pallets_at_the_fill_and_one_customer_cases_and_kg():
    """S-2: CAPACITY_PALLETS against the room at 98% (several customers) or the one-customer room (100%), with the
    bays; CAPACITY_CASES and CAPACITY_KG against the truck's own capacity."""
    [v] = violations(call(_bay_request(), {"T1": [["A1", "A2", "B"]]}))
    assert (v.code, v.value, v.limit, v.capacity) == ("CAPACITY_PALLETS", 12.4, 11.76, 12)
    r = _bay_request()
    r.stops[1] = r.stops[1].model_copy(update={"demand_pallet_units": 6_100})  # one customer, 12.10 pallets
    [v] = violations(call(r, {"T1": [["A1", "A2"]]}))
    assert (v.code, v.value, v.limit, v.capacity) == ("CAPACITY_PALLETS", 12.1, 12.0, 12)
    stops = [stop("A", 23.60, 58.40, cases=70), stop("B", 23.61, 58.41, cases=50), stop("C", 23.62, 58.42, cases=10, demand_kg=700),
             stop("D", 23.63, 58.43, cases=10, demand_kg=500)]
    r = req(stops, [truck("T1", cap=100), truck("T2", cap=500, capacity_kg=1000)], shift_start_min=hm("07:30"))
    out = call(r, {"T1": [["A", "B"]], "T2": [["C", "D"]]})
    [c] = truck_out(out, "T1").violations
    [k] = truck_out(out, "T2").violations
    assert (c.code, c.value, c.limit, c.capacity) == ("CAPACITY_CASES", 120, 100, 100)
    assert (k.code, k.value, k.limit, k.capacity) == ("CAPACITY_KG", 1200.0, 1000.0, 1000.0)


@pytest.mark.parametrize("rule, late, value_over", [("START", 10, 0), ("START", 600, 10), ("FINISH", 10, 0), ("FINISH", 31, 1), ("FINISH", 600, 10)])
def test_hard_window_figures_start_finish_and_the_finish_case_under_30_s(monkeypatch, rule, late, value_over):
    """S-2: START - the service start against the end of the hours; FINISH - the end of unloading against it, also
    when it is late by under 30 s (its minutes round to the closing, only hard_window_ok says it: value == limit)."""
    r = late_day(monkeypatch, late, rule)
    [v] = violations(call(r, {"T1": [["A", "B"]]}))
    end = r.stops[0].hard_end_min
    assert (v.code, v.limit, v.value) == ("HARD_WINDOW", end, end + value_over)
    assert v.late_s == late


def test_hard_window_figures_of_an_early_service_start():
    """S-2: a service start before the opening: value = the start, limit = the opening (an early stop is never late)."""
    r = two_load_day()
    sc, mx = valid(r)
    early = shifted(sc, 1, -120)  # A (opens 06:00) served two hours earlier than planned
    rep = FZ.check_scenario(r, early, solvable=r.stops, mx=mx)
    [v] = [v for v in rep.violations if v.code == "HARD_WINDOW"]
    a = next(st for ld in early.loads for st in ld.stops if st.stop_id == "A")
    assert (v.value, v.limit) == (a.service_start_min, hm("06:00")) and v.value < v.limit
    assert v.late_s is None and v.overridable is None
    assert retime._late_s(r.stops[0], (hm("06:00") - 1) * 60, "START") is None
    assert not retime._overridable(v, POLICY, r.trucks[0], False)


# --------------------------------------------------------------------------------------
# S-3 Swaps, whole loads and the order of loads (explicit truck_days, no v2 field needed)
# --------------------------------------------------------------------------------------

def _town_with_frozen_l1():
    r = town()
    r.trucks[0] = r.trucks[0].model_copy(update={"frozen_trips": [FrozenTrip(load_no=1, depart_min=hm("07:30"),
                                                                             return_min=hm("09:00"), cases=60)]})
    return r


def test_two_loads_swapped_between_trucks_keep_their_order_and_follow_the_frozen_loads():
    """S-3: T1's planned load (after its locked L1) and T2's load change trucks: each keeps its stop order, is timed
    again on its new truck, and T1's new load is load 2 (after the locked one)."""
    r = _town_with_frozen_l1()
    before = {"T1": [["S0", "S1"]], "T2": [["S3", "S4"]]}
    out = call(r, {"T1": [["S3", "S4"]], "T2": [["S0", "S1"]]}, before)
    assert out.ok
    sc = out.scenario
    assert_plan_rules(sub_request(r, ["S0", "S1", "S3", "S4"]), sc)
    got = {(l.truck_id, l.load_no): [s.stop_id for s in l.stops] for l in sc.loads}
    assert got == {("T1", 2): ["S3", "S4"], ("T2", 1): ["S0", "S1"]}
    t1 = next(l for l in sc.loads if l.truck_id == "T1")
    assert t1.depart_min >= hm("09:00") + 35  # after the locked load and the turnaround
    assert all(t.before.feasible and t.delta_money_omr is not None for t in out.trucks)


def test_a_whole_load_moved_before_l1_of_another_truck_and_loads_reordered_on_one_truck():
    """S-3: T1's load moved before T2's L1 (T1 left with none), and T2's two loads put in the other order."""
    r = town()
    out = call(r, {"T1": [], "T2": [["S0", "S1"], ["S3", "S4"]]}, {"T1": [["S0", "S1"]], "T2": [["S3", "S4"]]})
    assert out.ok and truck_out(out, "T1").loads == 0
    t2 = sorted((l for l in out.scenario.loads if l.truck_id == "T2"), key=lambda l: l.load_no)
    assert [[s.stop_id for s in l.stops] for l in t2] == [["S0", "S1"], ["S3", "S4"]]
    assert t2[1].depart_min >= t2[0].return_min + 35
    out = call(r, {"T2": [["S3", "S4"], ["S0", "S1"]]}, {"T2": [["S0", "S1"], ["S3", "S4"]]})
    assert out.ok
    t2 = sorted(out.scenario.loads, key=lambda l: l.load_no)
    assert [[s.stop_id for s in l.stops] for l in t2] == [["S3", "S4"], ["S0", "S1"]]


def test_an_exchange_of_stops_between_two_full_loads_is_one_explicit_check():
    """D-19's solver side: the stops of two full loads exchanged in one change list are one explicit call."""
    r = town()
    out = call(r, {"T1": [["S3", "S1"]], "T2": [["S0", "S4"]]}, {"T1": [["S0", "S1"]], "T2": [["S3", "S4"]]})
    assert out.ok and out.relaxed is None and [d.loads for d in out.loads] == [[["S3", "S1"]], [["S0", "S4"]]]


# --------------------------------------------------------------------------------------
# S-4 / S-5 / S-6 Several stops at once and a whole load (best v2)
# --------------------------------------------------------------------------------------

def test_the_placement_order_earliest_end_then_farthest_then_id():
    """S-4: the stops go in by the earliest end of receiving hours (none last), then the farthest from the depot, then
    the stop id."""
    s = [stop("N1", 23.60, 58.40, hard_end_min=hm("12:00")), stop("F1", 23.80, 58.60, hard_end_min=hm("12:00")),
         stop("E", 23.60, 58.40, hard_end_min=hm("09:00")), stop("Z", 23.70, 58.50), stop("Y", 23.70, 58.50)]
    r = req(s, [truck("T1")], shift_start_min=hm("07:30"))
    tds = ds._truck_days(r)
    side = retime._side(r, tds, [x.stop_id for x in s], s, {x.stop_id: k for k, x in enumerate(s)}, retime._matrix(r, s, time.monotonic() + 5))
    order = retime._placement_order(side, [side.pos[x] for x in ("Z", "Y", "N1", "F1", "E")])
    assert [side.ids[k] for k in order] == ["E", "F1", "N1", "Y", "Z"]


def test_several_stops_into_an_existing_load_each_at_its_place_the_others_in_order():
    """S-4: three stops into T8's L1: every one placed, the load's own stops keep their order, one option whose loads
    are the truck's whole layout, and the answer's layout is that option."""
    r = _two_loads()
    out = call(r, {"T8": [["K0", "K3"], ["C7"]]}, best=RetimeBest(stop_id="K1", more_stop_ids=["K2"], truck_id="T8", load_index=0))
    assert out.ok and len(out.options) == 1
    o = out.options[0]
    assert o.load_index == 0 and o.new_load_at is None and o.loads[1] == ["C7"]
    assert sorted(o.loads[0]) == ["K0", "K1", "K2", "K3"] and [s for s in o.loads[0] if s in ("K0", "K3")] == ["K0", "K3"]
    assert o.loads[0][o.position] == "K1"
    assert out.loads[0].loads == o.loads and out.best_tried == 1


def test_several_stops_as_a_new_load_at_a_given_place_or_at_every_place():
    """S-5: the new load's inner order is chosen once; at new_load_at it is timed there only; without it every place of
    the day is timed (after the last load first) and up to 3 come back, best first, each with the same inner order."""
    r = _two_loads()
    best = dict(stop_id="K1", more_stop_ids=["C7", "K2"], truck_id="T8")
    at0 = call(r, {"T8": [["K0", "K3"]]}, best=RetimeBest(**best, new_load_at=0))
    assert at0.ok and at0.best_tried == 1 and [(o.new_load_at, o.load_index) for o in at0.options] == [(0, None)]
    inner = at0.options[0].loads[0]
    assert sorted(inner) == ["C7", "K1", "K2"] and at0.options[0].loads[1] == ["K0", "K3"]
    every = call(r, {"T8": [["K0", "K3"]]}, best=RetimeBest(**best))
    assert every.ok and every.best_total == 2 and every.best_tried == 2 and len(every.options) == 2
    assert {o.new_load_at for o in every.options} == {0, 1}
    assert all(o.loads[o.new_load_at] == inner for o in every.options)
    values = [o.money_omr + o.soft_omr for o in every.options]
    assert values == sorted(values)


def test_a_whole_load_keeps_its_order_at_every_place():
    """S-5: keep_order (a whole load moved): the order sent, never changed; every place timed, up to 3 options."""
    r = _two_loads()
    out = call(r, {"T8": [["K0", "K1"], ["K2"]]}, best=RetimeBest(stop_id="C7", more_stop_ids=["K3"], truck_id="T8", keep_order=True))
    assert out.ok and out.best_total == 3 and 1 <= len(out.options) <= 3
    assert all(o.loads[o.new_load_at] == ["C7", "K3"] for o in out.options)
    out = call(r, {"T8": [["K0", "K1"], ["K2"]]}, best=RetimeBest(stop_id="K3", more_stop_ids=["C7"], truck_id="T8", keep_order=True,
                                                                 new_load_at=1))
    assert out.ok and out.options[0].loads == [["K0", "K1"], ["K3", "C7"], ["K2"]]


V2_BESTS = [
    ({"T8": [["K0", "K3"], ["C7"]]}, RetimeBest(stop_id="K1", more_stop_ids=["K2"], truck_id="T8", load_index=0)),
    ({"T8": [["K0", "K3"]]}, RetimeBest(stop_id="K1", more_stop_ids=["C7", "K2"], truck_id="T8")),
    ({"T8": [["K0", "K3"]]}, RetimeBest(stop_id="K1", more_stop_ids=["C7", "K2"], truck_id="T8", new_load_at=0)),
    ({"T8": [["K0", "K1"], ["K2"]]}, RetimeBest(stop_id="C7", more_stop_ids=["K3"], truck_id="T8", keep_order=True)),
]


@pytest.mark.parametrize("case", range(4))
def test_a_v2_best_gives_exactly_the_timetable_of_the_explicit_call_a_save_sends(case):
    """S-6: the explicit call of options[0].loads gives the same loads, times, money and verdicts (a save of it finds
    the same preview hash)."""
    assert len(V2_BESTS) == 4
    after, best = V2_BESTS[case]
    r = _two_loads()
    before = {"T8": [["K0", "K1", "K2", "K3"], ["C7"]]}
    out = call(r, after, before=before, best=best)
    assert out.ok and out.options
    explicit = call(r, {"T8": out.options[0].loads}, before=before)
    assert _saved_key(explicit) == _saved_key(out)
    assert (explicit.delta_money_omr, explicit.delta_km) == (out.delta_money_omr, out.delta_km)


def test_the_repairs_of_a_placed_load_find_an_order_that_times(monkeypatch):
    """4.3 step 3: the screened order does not time (here: forced to put E, whose hours end early, last); the repairs move
    the placed stops to their next places, one exact timing each, and the first that times is the option."""
    fixed_legs(monkeypatch)
    s = [stop("K0", 23.60, 58.40), stop("E", 23.61, 58.41, hard_end_min=hm("07:45")), stop("F", 23.62, 58.42)]
    r = req(s, [truck("T1")], shift_start_min=hm("07:30"))
    real = retime._place_stops

    def bad(side, fit, idx, loads, j, ks):
        placed = real(side, fit, idx, loads, j, ks)
        load = tuple(k for k in placed[j] if side.ids[k] != "E") + (side.pos["E"],)
        return retime._with(placed, j, load)

    monkeypatch.setattr(retime, "_place_stops", bad)
    out = call(r, {"T1": [["K0"]]}, best=RetimeBest(stop_id="E", more_stop_ids=["F"], truck_id="T1", load_index=0))
    assert out.ok and out.options[0].loads[0][0] == "E" and out.best_tried >= 2


# --------------------------------------------------------------------------------------
# S-7 A late arrival (F1)
# --------------------------------------------------------------------------------------

@pytest.mark.parametrize("rule", ["START", "FINISH"])
@pytest.mark.parametrize("late", [1, 29, 31, 1200])
def test_a_late_arrival_to_the_second_can_be_allowed(monkeypatch, rule, late):
    """S-7: late by 1 s, 29 s, 31 s or 20 min: the strict answer refuses with late_s to the second, value >= limit and
    overridable; the relaxed answer allows exactly that (the same late_s), the stop's hard_window_ok is False, the check
    is VERIFIED with it allowed, B is never made late, and the lateness is no more than on the earliest timetable."""
    r = late_day(monkeypatch, late, rule)
    out = call(r, {"T1": [["A", "B"]]}, relax=POLICY)
    assert not out.ok
    [v] = violations(out)
    assert (v.code, v.stop_id, v.late_s, v.overridable) == ("HARD_WINDOW", "A", late, True)
    assert v.value >= v.limit and (v.value == v.limit) == (late < 30)
    rx = out.relaxed
    assert rx is not None and rx.ok and rx.relaxations.late_stop_ids == ["A"]
    [t] = rx.trucks
    assert t.feasible and t.violations == [] and t.money_omr is not None
    [a] = t.allowed
    assert (a.code, a.stop_id, a.late_s, a.overridable, a.value, a.limit) == ("HARD_WINDOW", "A", late, True, v.value, v.limit)
    sc = rx.scenario
    assert (sc.feasibility.status, sc.feasibility.timing, sc.feasibility.violations) == ("VERIFIED", "EXACT", [])
    assert [x.stop_id for x in sc.feasibility.allowed] == ["A"]
    stops = {s.stop_id: s for ld in sc.loads for s in ld.stops}
    assert stops["A"].hard_window_ok is False and stops["B"].hard_window_ok is True
    assert [x.code for x in rx.strict[0].violations] == ["HARD_WINDOW"] and rx.loads[0].loads == [["A", "B"]]


def test_lateness_is_kept_to_the_minimum_and_never_spread(monkeypatch):
    """S-7: with a preferred window that pulls B later, the relaxed timing still keeps A no later than needed (the
    penalty outweighs every soft cost), and B on time."""
    fixed_legs(monkeypatch, {(None, "A"): 900})
    a = stop("A", 23.60, 58.40, hard_start_min=hm("07:00"), hard_end_min=hm("07:40"), service_min=10)
    b = stop("B", 23.61, 58.41, hard_start_min=hm("07:00"), hard_end_min=hm("09:00"), pref_start_min=hm("08:45"), service_min=10)
    r = req([a, b], [truck("T1")], shift_start_min=hm("07:30"), pref_window_penalty_per_min=0.05)
    out = call(r, {"T1": [["A", "B"]]}, relax=POLICY)
    [v] = violations(out)
    assert v.late_s == 300 and out.relaxed.ok
    [allowed] = out.relaxed.trucks[0].allowed
    assert allowed.late_s == 300 and [x.code for x in out.relaxed.trucks[0].allowed] == ["HARD_WINDOW"]


def test_lateness_is_not_judged_without_relax_and_not_allowed_when_late_is_off(monkeypatch):
    r = late_day(monkeypatch, 60)
    [v] = violations(call(r, {"T1": [["A", "B"]]}))
    assert v.late_s == 60 and v.overridable is None
    out = call(r, {"T1": [["A", "B"]]}, relax=RetimeRelaxPolicy(late=False, capacity_factor=1.2, no_break=True))
    [v] = violations(out)
    assert v.overridable is False and out.relaxed is None


# --------------------------------------------------------------------------------------
# S-8 Capacity up to 120% of the truck's own
# --------------------------------------------------------------------------------------

def test_the_cap_is_whole_units_of_the_truck_s_own_capacity():
    """S-8: floor(x * 120 / 100) on whole units, the same rule as the web."""
    assert [retime._cap_units(x, 1.2) for x in (1, 11, 100, 500, 12_000)] == [1, 13, 120, 600, 14_400]
    assert retime._cap_units(10_001, 1.2) == 10_001 * 120 // 100


@pytest.mark.parametrize("b_cases, ok", [(250, True), (300, True), (301, False)])
def test_cases_110_and_120_percent_are_allowed_and_one_case_more_is_not(b_cases, ok):
    """S-8: 550 and 600 cases on a 500-case truck can be allowed; 601 cannot (overridable False, no relaxed answer)."""
    r = req([stop("A", 23.60, 58.40, cases=300), stop("B", 23.61, 58.41, cases=b_cases)], [truck("T1", cap=500)],
            shift_start_min=hm("07:30"))
    out = call(r, {"T1": [["A", "B"]]}, relax=POLICY)
    [v] = violations(out)
    assert (v.code, v.value, v.capacity, v.overridable) == ("CAPACITY_CASES", 300 + b_cases, 500, ok)
    if not ok:
        assert out.relaxed is None
        return
    rx = out.relaxed
    assert rx.ok and rx.relaxations.over_capacity_truck_ids == ["T1"] and rx.relaxations.capacity_factor == 1.2
    assert [a.code for a in rx.trucks[0].allowed] == ["CAPACITY_CASES"] and rx.scenario.feasibility.status == "VERIFIED"


@pytest.mark.parametrize("units, ok", [(14_400, True), (14_401, False)])
def test_pallets_are_counted_from_the_bays_not_the_98_percent_room(units, ok):
    """S-8: 12 bays: 14.400 pallets of several customers is 120% of the bays (but 122% of the 11.76 room at 98%), so it
    can be allowed; one unit more cannot. The relaxed loads keep their real room."""
    r = _bay_request()
    r.stops[2] = r.stops[2].model_copy(update={"demand_pallet_units": units - 11_900})
    out = call(r, {"T1": [["A1", "A2", "B"]]}, relax=POLICY)
    [v] = violations(out)
    assert (v.code, v.limit, v.capacity, v.overridable) == ("CAPACITY_PALLETS", 11.76, 12, ok)
    assert (out.relaxed is not None and out.relaxed.ok) is ok
    if ok:
        assert out.relaxed.scenario.loads[0].pallet_room_units == 11_760


def test_one_customer_room_and_kg_can_be_allowed_within_the_cap():
    """S-8: one customer at 13 pallets on 12 bays (room 100%) and 1,150 kg on a 1,000 kg payload are allowed; 1,201 kg
    is not."""
    r = _bay_request()
    r.stops[1] = r.stops[1].model_copy(update={"demand_pallet_units": 7_000})  # A1 + A2 = 13.000 pallets, one customer
    out = call(r, {"T1": [["A1", "A2"]]}, relax=POLICY)
    assert out.relaxed.ok and out.relaxed.scenario.loads[0].pallet_room_units == 12_000
    for kg, ok in ((1_150, True), (1_201, False)):
        r = req([stop("C", 23.62, 58.42, cases=10, demand_kg=kg)], [truck("T2", cap=500, capacity_kg=1000)], shift_start_min=hm("07:30"))
        out = call(r, {"T2": [["C"]]}, relax=POLICY)
        [v] = violations(out)
        assert (v.code, v.value, v.capacity, v.overridable) == ("CAPACITY_KG", kg, 1000.0, ok)
        assert (out.relaxed is not None and out.relaxed.ok) is ok


# --------------------------------------------------------------------------------------
# S-9 The driver break (F5, F17, F18)
# --------------------------------------------------------------------------------------

def test_no_place_for_the_driver_break_can_be_allowed_and_the_day_is_timed_without_it():
    """S-9: "only the break has no place" is BREAK overridable; the relaxed day carries no driver_break and says
    SKIPPED_BY_HAND; the relaxations name the truck. With no_break off it cannot be allowed."""
    out = call(_no_break_place(), {"T1": [["P", "Q"]]}, relax=POLICY)
    [v] = violations(out)
    assert (v.code, v.overridable) == ("BREAK", True)
    rx = out.relaxed
    assert rx.ok and rx.relaxations.no_break_truck_ids == ["T1"] and rx.relaxations.late_stop_ids == []
    assert [a.code for a in rx.trucks[0].allowed] == ["BREAK"] and rx.trucks[0].break_start_min is None
    assert all(ld.driver_break is None for ld in rx.scenario.loads)
    assert rx.scenario.truck_days[0].break_status == "SKIPPED_BY_HAND" and rx.scenario.feasibility.status == "VERIFIED"
    out = call(_no_break_place(), {"T1": [["P", "Q"]]}, relax=RetimeRelaxPolicy(late=True, capacity_factor=1.2))
    assert violations(out)[0].overridable is False and out.relaxed is None


def _break_makes_late(monkeypatch):
    """A late by 5 min whatever happens (its hours end 07:35); then a chain C0..C8 every 20 min from 13:30 with 2-min
    windows: a 60-min break (to start 14:00-15:00) anywhere in it makes the stops after it late."""
    fixed_legs(monkeypatch)
    s = [stop("A", 23.60, 58.40, hard_start_min=hm("07:00"), hard_end_min=hm("07:35"), service_min=10)]
    s += [stop(f"C{i}", 23.60, 58.40 + 0.01 * i, hard_start_min=hm("13:30") + 20 * i, hard_end_min=hm("13:32") + 20 * i,
               service_min=10) for i in range(9)]
    return req(s, [truck("T1")], shift_start_min=hm("07:30"), shift_max_min=12 * 60, **BREAK), [["A"] + [f"C{i}" for i in range(9)]]


def test_skipping_the_break_from_the_start_removes_the_lateness_it_caused(monkeypatch):
    """S-9: timed with its break, the late chain needs more late stops; with seed_no_break (the user's "Skip the driver
    break instead") only A is late and the break is allowed instead. The solver never drops it on its own."""
    r, loads = _break_makes_late(monkeypatch)
    out = call(r, {"T1": loads}, relax=POLICY)
    assert [(v.code, v.stop_id) for v in violations(out)] == [("HARD_WINDOW", "A")]
    rx = out.relaxed
    assert rx.ok and rx.relaxations.no_break_truck_ids == [] and len(rx.relaxations.late_stop_ids) > 1
    assert rx.scenario.truck_days[0].break_status == "PLANNED"
    out = call(r, {"T1": loads}, relax=POLICY.model_copy(update={"seed_no_break": ["T1"]}))
    rx = out.relaxed
    assert rx.ok and rx.relaxations.late_stop_ids == ["A"] and rx.relaxations.no_break_truck_ids == ["T1"]
    assert sorted(a.code for a in rx.trucks[0].allowed) == ["BREAK", "HARD_WINDOW"]
    assert rx.scenario.truck_days[0].break_status == "SKIPPED_BY_HAND"


def test_a_truck_still_untimed_gets_no_break_from_its_earliest_timetable_and_a_break_alternative(monkeypatch):
    """S-9 / F5: even with A late, the day with its break ends after the latest return; the relaxed attempt fails, its
    earliest timetable's BREAK is never a reason (NO_TIMETABLE says it), the truck is not made no-break, but is named
    in break_alternative because it would time without its break."""
    fixed_legs(monkeypatch)
    s = [stop("A", 23.60, 58.40, hard_start_min=hm("07:00"), hard_end_min=hm("07:35"), service_min=60)]
    s += [stop(f"S{i}", 23.60, 58.40 + 0.01 * i, service_min=60) for i in range(6)]
    r = req(s, [truck("T1")], shift_start_min=hm("07:30"), shift_max_min=12 * 60, latest_return_min=hm("16:30"), **BREAK)
    loads = [["A"] + [f"S{i}" for i in range(6)]]
    out = call(r, {"T1": loads}, relax=POLICY)
    rx = out.relaxed
    assert not rx.ok and rx.break_alternative == ["T1"] and rx.relaxations.no_break_truck_ids == []
    [t] = rx.trucks
    assert not t.feasible and "BREAK" not in codes(t) and "NO_TIMETABLE" in codes(t)
    assert t.allowed == []
    nt = next(v for v in t.violations if v.code == "NO_TIMETABLE")
    assert nt.overridable is False and "cannot be allowed by hand for T1" in nt.message
    out = call(r, {"T1": loads}, relax=POLICY.model_copy(update={"seed_no_break": ["T1"]}))
    assert out.relaxed.ok and out.relaxed.break_alternative == []


def test_the_break_note_of_a_truck_with_no_time_left_cannot_be_allowed():
    """S-9 / F17: a truck whose break can no longer start (a plan made at 15:30 after its locked load) refuses with its
    break note as BREAK, never overridable."""
    frozen = [FrozenTrip(load_no=1, depart_min=hm("07:00"), return_min=hm("12:00"), cases=40)]
    r = req([stop("A", 23.60, 58.40)], [truck("T1", frozen_trips=frozen)], shift_start_min=hm("07:00"),
            loading_from_min=hm("15:30"), **BREAK)
    out = call(r, {"T1": [["A"]]}, relax=POLICY)
    [v] = violations(out)
    assert (v.code, v.overridable) == ("BREAK", False) and "no longer start" in v.message and out.relaxed is None


# --------------------------------------------------------------------------------------
# S-10 What cannot be allowed stays (F4)
# --------------------------------------------------------------------------------------

def _not_allowed_cases():
    small = req([stop("A", 23.60, 58.40, allowed_truck_ids=["T2"], allowed_trucks_label="a small truck"), stop("B", 23.61, 58.41)],
                [truck("T1"), truck("T2", cap=100)], shift_start_min=hm("07:30"))
    late_return = req([stop("F", 23.585 + 0.15, 58.39, hard_start_min=hm("11:30"), hard_end_min=hm("12:30"))], [truck("T1")],
                      shift_start_min=hm("07:30"), latest_return_min=hm("12:00"))
    frozen = [FrozenTrip(load_no=1, depart_min=hm("07:30"), return_min=hm("09:00"), cases=40)]
    trips = req([stop("A", 23.60, 58.40), stop("B", 23.61, 58.41)], [truck("T1", max_trips=2, frozen_trips=frozen)],
                shift_start_min=hm("07:30"))
    gone = req([stop("A", 23.60, 58.40)], [truck("T1", available_to_min=hm("07:00"))], shift_start_min=hm("07:30"))
    return [(small, {"T1": [["B", "A"]]}, "TRUCK_NOT_ALLOWED"), (late_return, {"T1": [["F"]]}, "SHIFT_LIMIT"),
            (trips, {"T1": [["A"], ["B"]]}, "TRIPS"), (gone, {"T1": [["A"]]}, "TRUCK_AVAILABILITY")]


@pytest.mark.parametrize("case", range(4))
def test_rules_that_cannot_be_allowed_give_no_relaxed_answer(case):
    """S-10: small truck only, the latest return, loads a day and a truck with no time left: overridable False, no
    relaxed answer (the change cannot be saved even with overrides)."""
    r, after, code = _not_allowed_cases()[case]
    out = call(r, after, relax=POLICY)
    assert code in codes(out.trucks[0]) and all(v.overridable is False for v in violations(out))
    assert out.relaxed is None


def test_one_issue_that_cannot_be_allowed_blocks_the_ones_that_can(monkeypatch):
    """S-10: a late stop (could be allowed) on a load with a small-truck-only customer on a big truck: no relaxed answer."""
    fixed_legs(monkeypatch, {(None, "A"): 900})
    s = [stop("A", 23.60, 58.40, hard_end_min=hm("07:40")), stop("B", 23.61, 58.41, allowed_truck_ids=["T2"])]
    r = req(s, [truck("T1"), truck("T2")], shift_start_min=hm("07:30"))
    out = call(r, {"T1": [["A", "B"]]}, relax=POLICY)
    assert {(v.code, v.overridable) for v in violations(out)} == {("HARD_WINDOW", True), ("TRUCK_NOT_ALLOWED", False)}
    assert out.relaxed is None


def _f4_day(monkeypatch):
    """T1's L1 is A (opens 11:00, 2 h of unloading); X closes 07:55 and is 30 min away. X before L1: 5 min late and
    every other rule kept. X after L1 (the strict fallback, after the last load): hours late and back after the latest
    return (14:00)."""
    fixed_legs(monkeypatch, {(None, "X"): 1800})
    s = [stop("A", 23.60, 58.40, hard_start_min=hm("11:00"), hard_end_min=hm("18:00"), service_min=120),
         stop("X", 23.70, 58.50, hard_start_min=hm("07:00"), hard_end_min=hm("07:55"), service_min=10)]
    return req(s, [truck("T1")], shift_start_min=hm("07:30"), latest_return_min=hm("14:00"), reload_min=30)


def test_a_best_place_is_decided_on_the_place_the_relaxed_search_chose_not_the_strict_fallback(monkeypatch):
    """S-10 / F4: no place keeps every rule; the strict fallback (after the last load) breaks the latest return, which
    cannot be allowed; the relaxed best finds X before L1, which needs only 5 min late: relaxed ok there."""
    r = _f4_day(monkeypatch)
    out = call(r, {"T1": [["A"]]}, best=RetimeBest(stop_id="X", truck_id="T1"), relax=POLICY)
    assert not out.ok and out.options == [] and out.loads[0].loads == [["A"], ["X"]]
    assert {v.code for v in violations(out)} == {"HARD_WINDOW", "SHIFT_LIMIT"}
    rx = out.relaxed
    assert rx.ok and rx.loads[0].loads == [["X"], ["A"]] and rx.relaxations.late_stop_ids == ["X"]
    [a] = rx.trucks[0].allowed
    assert a.late_s == 300 and [v.code for v in rx.strict[0].violations] == ["HARD_WINDOW"]


# --------------------------------------------------------------------------------------
# S-11 Determinism: a best's relaxed answer is the explicit call's (F16, F17)
# --------------------------------------------------------------------------------------

def test_a_best_s_relaxed_answer_equals_the_explicit_call_of_its_loads(monkeypatch):
    """S-11: Check (a best) and Save (the explicit relaxed.loads) get the same relaxed answer - everything the
    overrides hash reads and more - so the hashes agree."""
    r = _f4_day(monkeypatch)
    best = call(r, {"T1": [["A"]]}, before={"T1": [["A"]]}, best=RetimeBest(stop_id="X", truck_id="T1"), relax=POLICY)
    explicit = call(r, {d.truck_id: d.loads for d in best.relaxed.loads}, before={"T1": [["A"]]}, relax=POLICY)
    assert relaxed_key(explicit) == relaxed_key(best)
    assert explicit.relaxed.delta_money_omr is not None


def test_several_stops_with_relax_equal_the_explicit_call(monkeypatch):
    """S-11 for a v2 best (several stops into a load that goes over its cases): the relaxed best's place, saved
    explicitly, gives the same relaxed answer."""
    fixed_legs(monkeypatch)
    s = [stop(f"L{i}", 23.60, 58.40 + 0.01 * i, cases=90) for i in range(4)] + [stop("M1", 23.7, 58.5, cases=50),
                                                                                 stop("M2", 23.7, 58.6, cases=40)]
    r = req(s, [truck("T1", cap=400)], shift_start_min=hm("07:30"))
    out = call(r, {"T1": [["L0", "L1", "L2", "L3"]]}, best=RetimeBest(stop_id="M1", more_stop_ids=["M2"], truck_id="T1", load_index=0),
               relax=POLICY)
    assert not out.ok and out.best_tried == 0 and out.relaxed.ok
    assert out.relaxed.relaxations.over_capacity_truck_ids == ["T1"]
    explicit = call(r, {d.truck_id: d.loads for d in out.relaxed.loads}, relax=POLICY)
    assert relaxed_key(explicit) == relaxed_key(out)


def test_a_strict_no_timetable_truck_gets_a_relaxed_attempt(monkeypatch):
    """S-11 / F17: NO_TIMETABLE (nothing names the reason) does not stop the relaxed attempt."""
    fixed_legs(monkeypatch, {(None, "F"): 1800})
    r = req([stop("F", 23.7, 58.4, hard_start_min=hm("07:00"), hard_end_min=hm("07:50"))], [truck("T1")], shift_start_min=hm("07:30"))
    monkeypatch.setattr(ds.FZ, "safe_check", lambda *_a, **_k: FeasibilityReport(status="VERIFIED", timing="EXACT", violations=[]))
    out = call(r, {"T1": [["F"]]}, relax=POLICY)
    [v] = violations(out)
    assert v.code == "NO_TIMETABLE" and v.overridable is False
    assert out.relaxed is not None and out.relaxed.trucks[0].feasible


# --------------------------------------------------------------------------------------
# S-12 before_relax: the current loads timed with the allowances they carry
# --------------------------------------------------------------------------------------

def test_current_loads_with_allowances_are_feasible_with_money_and_deltas(monkeypatch):
    """S-12: a truck whose current loads were allowed by hand earlier (a late stop; capacity; no break - which the web
    sends also for a NO_BREAK allowance on a frozen load) is feasible before, with its money and the cost change."""
    r = late_day(monkeypatch, 120)
    plain = call(r, {"T1": [["B"]]}, before={"T1": [["A", "B"]]})
    assert not plain.trucks[0].before.feasible and plain.trucks[0].delta_money_omr is None
    out = call(r, {"T1": [["B"]]}, before={"T1": [["A", "B"]]}, before_relax=RetimeRelaxations(late_stop_ids=["A"]))
    bf = out.trucks[0].before
    assert bf.feasible and bf.money_omr is not None and bf.violations == [] and out.trucks[0].delta_money_omr is not None
    assert [(a.code, a.stop_id, a.late_s) for a in bf.allowed] == [("HARD_WINDOW", "A", 120)]
    r = req([stop("A", 23.60, 58.40, cases=300), stop("B", 23.61, 58.41, cases=250)], [truck("T1", cap=500)],
            shift_start_min=hm("07:30"))
    out = call(r, {"T1": [["A"]]}, before={"T1": [["A", "B"]]},
               before_relax=RetimeRelaxations(over_capacity_truck_ids=["T1"], capacity_factor=1.2))
    assert out.trucks[0].before.feasible and [a.code for a in out.trucks[0].before.allowed] == ["CAPACITY_CASES"]


def test_current_loads_without_their_break_allowed_by_hand_are_feasible():
    """S-12: no_break_truck_ids (the web sends it for a NO_BREAK allowance on any load of the truck-day, a frozen one
    included): the current loads are timed without the break, feasible, with the BREAK allowed."""
    r = _no_break_place()
    plain = call(r, {"T1": [["P"]]}, before={"T1": [["P", "Q"]]})
    assert not plain.trucks[0].before.feasible
    out = call(r, {"T1": [["P"]]}, before={"T1": [["P", "Q"]]}, before_relax=RetimeRelaxations(no_break_truck_ids=["T1"]))
    bf = out.trucks[0].before
    assert bf.feasible and [a.code for a in bf.allowed] == ["BREAK"] and out.delta_money_omr is not None
    assert all(v.overridable is None for v in bf.violations)


# --------------------------------------------------------------------------------------
# S-13 Requests that cannot be read: 422
# --------------------------------------------------------------------------------------

def _json(r, after: dict, **kw) -> dict:
    return RetimeRequest(request=r, truck_days=days(**after), **kw).model_dump(mode="json")


def _many():
    return req([stop(f"S{i:03d}", 23.60 + 0.001 * i, 58.40) for i in range(121)], [truck("T1")])


BAD_V2 = [
    (town, {"T1": [["S0"]]}, dict(best=RetimeBest(stop_id="S1", more_stop_ids=["S2", "S2"], truck_id="T1")), "listed twice in more_stop_ids"),
    (town, {"T1": [["S0"]]}, dict(best=RetimeBest(stop_id="S1", more_stop_ids=["ZZ"], truck_id="T1")), "Unknown stop ZZ"),
    (town, {"T1": [["S0"]]}, dict(best=RetimeBest(stop_id="S1", more_stop_ids=["S0"], truck_id="T1")), "Stop S0 is on more than one load"),
    (town, {"T1": [["S0"]]}, dict(best=RetimeBest(stop_id="S1", more_stop_ids=["S1"], truck_id="T1")), "Stop S1 is on more than one load"),
    (town, {"T1": [["S0"]]}, dict(best=RetimeBest(stop_id="S1", keep_order=True, truck_id="T1", load_index=0)), "for a new load only"),
    (town, {"T1": [["S0"]]}, dict(best=RetimeBest(stop_id="S1", new_load_at=0, truck_id="T1", load_index=0)), "for a new load only"),
    (town, {"T1": [["S0"]]}, dict(best=RetimeBest(stop_id="S1", new_load_at=2, truck_id="T1")), "new_load_at 2 is outside"),
    (town, {"T1": [["S0"]]}, dict(relax=RetimeRelaxPolicy(late=True, seed_no_break=["T2"])), "Truck T2 in seed_no_break"),
    (town, {"T1": [["S0"]]}, dict(before=days(T1=[["S1"]]), before_relax=RetimeRelaxations(late_stop_ids=["S0"])),
     "Stop S0 in before_relax is not in before"),
    (town, {"T1": [["S0"]]}, dict(before=days(T1=[["S1"]]), before_relax=RetimeRelaxations(no_break_truck_ids=["T2"])),
     "Truck T2 in before_relax"),
    (town, {"T1": [["S0"]]}, dict(before=days(T1=[["S1"]]), before_relax=RetimeRelaxations(over_capacity_truck_ids=["T1"])),
     "without its capacity_factor"),
    (_many, {"T1": [[f"S{i:03d}" for i in range(100)]]}, dict(best=RetimeBest(stop_id="S100", more_stop_ids=[f"S{i}" for i in range(101, 121)],
                                                                              truck_id="T1")), "At most 120 stops"),
]


@pytest.mark.parametrize("case", range(12))
def test_v2_requests_the_check_cannot_read_are_refused_with_422(monkeypatch, case):
    """S-13."""
    assert len(BAD_V2) == 12
    make, after, kw, words = BAD_V2[case]
    monkeypatch.setattr(main, "SOLVER_TOKEN", TOKEN)
    res = TestClient(main.app).post("/retime-truck-days", json=_json(make(), after, **kw), headers=HEADERS)
    assert res.status_code == 422 and words in res.json()["detail"], res.text


@pytest.mark.parametrize("factor", [1.0, 0.9, 1.51])
def test_a_capacity_factor_outside_1_to_1_5_is_refused(monkeypatch, factor):
    """S-13: capacity_factor above 1 and at most 1.5 (the model's bounds: 422 at the endpoint)."""
    with pytest.raises(ValidationError):
        RetimeRelaxPolicy(capacity_factor=factor)
    monkeypatch.setattr(main, "SOLVER_TOKEN", TOKEN)
    payload = _json(town(), {"T1": [["S0"]]})
    payload["relax"] = {"late": True, "capacity_factor": factor}
    assert TestClient(main.app).post("/retime-truck-days", json=payload, headers=HEADERS).status_code == 422


# --------------------------------------------------------------------------------------
# S-14 The budget (F13) and rule 22
# --------------------------------------------------------------------------------------

def _forty_into_a_full_day(monkeypatch):
    """T1: 3 loads of 5 stops each over a day that needs a driver break; 40 more stops into its L2 make that load 440 of
    400 cases (110%): no place keeps every rule, the relaxed one can be allowed."""
    fixed_legs(monkeypatch, default=300)
    base = [stop(f"L{j}_{i}", 23.60, 58.40, cases=10, service_min=15) for j in range(3) for i in range(5)]
    more = [stop(f"M{i:02d}", 23.60, 58.40, cases=10, service_min=3) for i in range(40)]
    r = req(base + more, [truck("T1", cap=400, max_trips=3)], shift_start_min=hm("06:30"), shift_max_min=14 * 60, reload_min=20,
            **BREAK)
    loads = [[f"L{j}_{i}" for i in range(5)] for j in range(3)]
    best = RetimeBest(stop_id="M00", more_stop_ids=[f"M{i:02d}" for i in range(1, 40)], truck_id="T1", load_index=1)
    return r, loads, best


def test_forty_stops_into_a_full_day_answer_within_the_budget(monkeypatch):
    """S-14: 40 stops into a truck with 3 loads that needs its break: the strict pass fails (over the cases, no LP), the
    relaxed pass succeeds, within RETIME_BUDGET_SEC and at most RETIME_BEST_TRIES exact timings per pass."""
    r, loads, best = _forty_into_a_full_day(monkeypatch)
    timed = []
    real = LR.time_truck
    monkeypatch.setattr(LR, "time_truck", lambda *a, **k: timed.append(1) or real(*a, **k))
    t0 = time.monotonic()
    out = call(r, {"T1": loads}, best=best, relax=POLICY)
    assert time.monotonic() - t0 < retime.budget_sec() + 1
    assert not out.ok and out.best_tried <= retime.best_tries() and out.relaxed is not None and out.relaxed.ok
    assert out.relaxed.relaxations.over_capacity_truck_ids == ["T1"]
    assert sorted(s for load in out.relaxed.loads[0].loads for s in load) == sorted([s for l in loads for s in l] + _best_stops(best))
    assert out.relaxed.scenario.truck_days[0].break_status == "PLANNED"
    # The strict best place, the relaxed best place (each within RETIME_BEST_TRIES), the strict and relaxed timings.
    assert len(timed) <= 2 * retime.best_tries() + 4


def _best_stops(b: RetimeBest) -> list[str]:
    return [b.stop_id] + b.more_stop_ids


def test_out_of_time_says_so_and_gives_no_relaxed_answer(monkeypatch):
    """S-14: a 1 s budget and slow timings: the strict best place runs out of time (the v1 warning), the relaxed phase
    gets none (relaxed None and its warning)."""
    monkeypatch.setenv("RETIME_BUDGET_SEC", "1")
    real = LR.time_truck

    def slow(*a, **kw):
        time.sleep(0.6)
        return real(*a, **kw)

    monkeypatch.setattr(LR, "time_truck", slow)
    r = _f4_day(monkeypatch)
    out = call(r, {"T1": [["A"]]}, best=RetimeBest(stop_id="X", truck_id="T1"), relax=POLICY)
    assert out.relaxed is None and retime.OUT_OF_TIME_RELAXED in out.warnings
    assert any(w.startswith("Out of time after 1 of 2 places for the stop") for w in out.warnings)


def test_the_strict_phase_keeps_to_its_share_of_the_budget_with_relax(monkeypatch):
    """4.8: with relax, the strict best place stops at RELAX_SHARE of the time left; without it, it has the whole
    budget (v1)."""
    monkeypatch.setenv("RETIME_BUDGET_SEC", "2")
    real = LR.time_truck

    def slow(*a, **kw):
        time.sleep(0.3)
        return real(*a, **kw)

    monkeypatch.setattr(LR, "time_truck", slow)
    r = _two_loads()
    best = RetimeBest(stop_id="C7", truck_id="T8", load_index=0)
    without = call(r, {"T8": [["K0", "K1", "K2", "K3"]]}, best=best)
    shared = call(r, {"T8": [["K0", "K1", "K2", "K3"]]}, best=best, relax=POLICY)
    assert shared.best_tried < without.best_tried


def test_rule_22_v2_paths_never_search_start_a_worker_or_cp_sat(monkeypatch):
    def forbidden(*_a, **_k):
        raise AssertionError("a move by hand must never search or start a worker")

    for name in ("_start_workers", "_start_extra_workers", "_solve_scenario", "_pv_start", "_run_scenarios", "_post_solve"):
        monkeypatch.setattr(ds, name, forbidden)
    for name in ("repack", "warm_up", "build_candidates", "recover", "trim"):
        monkeypatch.setattr(LR, name, forbidden)
    assert call(_no_break_place(), {"T1": [["P", "Q"]]}, relax=POLICY).relaxed.ok
    r, loads, best = _forty_into_a_full_day(monkeypatch)
    assert call(r, {"T1": loads}, best=best, relax=POLICY).relaxed.ok


def test_the_api_process_loads_no_numpy_or_pyvrp_on_v2_checks():
    code = textwrap.dedent(
        """
        import sys
        import main  # noqa: F401 - the API module, as uvicorn loads it
        import retime
        from tests.test_retime import _no_break_place, _two_loads
        from dispatch_models import RetimeBest, RetimeRelaxPolicy, RetimeRequest, RetimeTruckDay
        p = RetimeRelaxPolicy(late=True, capacity_factor=1.2, no_break=True)
        out = retime.retime_truck_days(RetimeRequest(request=_no_break_place(), truck_days=[RetimeTruckDay(truck_id="T1",
                                       loads=[["P", "Q"]])], relax=p))
        assert out.relaxed.ok
        out = retime.retime_truck_days(RetimeRequest(request=_two_loads(), truck_days=[RetimeTruckDay(truck_id="T8",
                                       loads=[["K0", "K3"]])], best=RetimeBest(stop_id="K1", more_stop_ids=["C7", "K2"],
                                       truck_id="T8"), relax=p))
        assert out.ok
        loaded = sorted(m for m in sys.modules if m.split(".")[0] in ("pyvrp", "numpy"))
        print("LOADED=" + ",".join(loaded))
        """
    )
    r = subprocess.run([sys.executable, "-c", code], cwd=SOLVER_DIR, capture_output=True, text=True, timeout=180)
    assert r.returncode == 0, r.stderr[-3000:]
    assert r.stdout.strip().endswith("LOADED="), r.stdout[-2000:]


# --------------------------------------------------------------------------------------
# S-16 A fresh day per relaxation set (F6)
# --------------------------------------------------------------------------------------

def test_every_relaxation_set_times_on_its_own_day_and_cache():
    """S-16: the strict day caches "no timetable" for the truck; a relaxed side without the break is a NEW day and
    times it (never the cached None); neither cache holds the other's entries."""
    r = _no_break_place()
    tds = ds._truck_days(r)
    ids = ["P", "Q"]
    mx = retime._matrix(r, r.stops, time.monotonic() + 5)
    side = retime._side(r, tds, ids, r.stops, {"P": 0, "Q": 1}, mx)
    loads = [(0, 1)]
    assert retime._time(side, side.ctx.tds[0], loads, retime._Count()) is None
    strict_keys = set(side.ctx.day.timing_cache)
    rside = retime._relaxed_side(side, retime._Rel(no_break=frozenset(["T1"])))
    assert rside.ctx.day is not side.ctx.day and rside.ctx.day.timing_cache is not side.ctx.day.timing_cache
    assert rside.ctx.tds[0].break_state == "OFF" and side.ctx.tds[0].break_state == "DUE"
    got = retime._time(rside, rside.ctx.tds[0], loads, retime._Count())
    assert got is not None and all(tl.brk is None for tl in got)
    assert set(side.ctx.day.timing_cache) == strict_keys
    other = retime._relaxed_side(side, retime._Rel(late=frozenset(["P"])))
    assert other.ctx.day.timing_cache == {} and other.ctx.day.late_soft and not side.ctx.day.late_soft
    assert other.ctx.solvable[0].hard_end_min is None and side.ctx.solvable[0].hard_end_min is not None


# --------------------------------------------------------------------------------------
# S-17 The layout an answer is for
# --------------------------------------------------------------------------------------

def test_the_answer_s_loads_are_truck_days_the_option_or_the_fallback():
    """S-17: explicit -> truck_days; best with a place -> options[0].loads for its truck and truck_days for the others;
    best with none -> the fallback layout the violations are about."""
    r = town()
    out = call(r, {"T1": [["S0", "S1"]], "T2": [["S3"]]}, best=RetimeBest(stop_id="S2", truck_id="T1", load_index=0))
    assert [(d.truck_id, d.loads) for d in out.loads] == [("T1", out.options[0].loads), ("T2", [["S3"]])]
    r = _two_loads()
    r.trucks[0] = r.trucks[0].model_copy(update={"max_trips": 1})
    out = call(r, {"T8": [["K0", "K1", "K2", "K3"]]}, best=RetimeBest(stop_id="C7", truck_id="T8"))
    assert not out.ok and out.options == [] and out.loads[0].loads == [["K0", "K1", "K2", "K3"], ["C7"]]
    assert [l.load_no for l in out.scenario.loads] == [1, 2]


# --------------------------------------------------------------------------------------
# S-18 How the relaxed best place ranks
# --------------------------------------------------------------------------------------

def test_the_relaxed_ranking_puts_no_overload_before_lateness_before_money(monkeypatch):
    """S-18: on a relaxed side, a place with no load over the planning room beats an overloaded one (although that one
    is on time), and less lateness beats more."""
    fixed_legs(monkeypatch)
    s = [stop("A", 23.60, 58.40, cases=60, hard_end_min=hm("08:00")), stop("B", 23.61, 58.41, cases=50, hard_end_min=hm("08:30"))]
    r = req(s, [truck("T1", cap=100)], shift_start_min=hm("07:30"), reload_min=30)
    tds = ds._truck_days(r)
    mx = retime._matrix(r, s, time.monotonic() + 5)
    side = retime._side(r, tds, ["A", "B"], s, {"A": 0, "B": 1}, mx)
    fit = retime._relaxed_side(side, retime._Rel(late=frozenset(["A", "B"]), over=frozenset(["T1"]), factor=1.2))
    b = RetimeBest(stop_id="A", truck_id="T1")
    over = retime._Cand([(0, 1)], None, 0, 0, 0)  # 110 cases on one load (100 + 20% allowed): both on time
    late = retime._Cand([(0,), (1,)], None, 0, 0, 1)  # A, then B after the turnaround: B 10 min late
    late_more = retime._Cand([(1,), (0,)], None, 0, 0, 2)  # B, then A: A 40 min late
    got = retime._every_place(side, fit, b, 0, [over, late_more, late], retime._Tries(24, time.monotonic() + 5), retime._Count())
    assert [o[1] for o in got.options] == [late.loads, late_more.loads, over.loads]
    keys = [retime._rank_key(side, fit, 0, o[1], retime._time(fit, fit.ctx.tds[0], o[1], retime._Count())) for o in got.options]
    assert [(k[0], k[1]) for k in keys] == [(0, 600), (0, 2400), (1, 0)]


# --------------------------------------------------------------------------------------
# S-19 A relaxed place that keeps every rule becomes the strict answer
# --------------------------------------------------------------------------------------

def test_a_relaxed_place_that_keeps_every_rule_becomes_the_only_option(monkeypatch):
    """S-19: the strict best place got no time (its share cut to nothing); the relaxed search finds a place that
    keeps every rule: it is the strict answer's only option, ok, and nothing needs allowing (relaxed None)."""
    monkeypatch.setattr(retime, "RELAX_SHARE", 0.0)
    r = _two_loads()
    after = {"T8": [["K0", "K1", "K2", "K3"]]}
    out = call(r, after, best=RetimeBest(stop_id="C7", truck_id="T8", load_index=0), relax=POLICY)
    assert out.ok and out.relaxed is None and len(out.options) == 1 and out.best_tried == 0
    o = out.options[0]
    assert o.load_index == 0 and o.loads[0][o.position] == "C7" and out.loads[0].loads == o.loads
    explicit = call(r, {"T8": o.loads})
    assert _saved_key(explicit) == _saved_key(out)
