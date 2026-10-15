"""Stops that only some trucks may carry (DispatchStop.allowed_truck_ids).

Owner request 13 Oct 2026, after the first live night: "some customers have an unloading area only
suitable for 3-ton trucks; the plan gave them big trucks and the dispatcher had to re-do it by hand".
The web marks such a customer "Small truck only (3-ton)" and sends, on each of its stops, the day's
trucks with at most the company's "small truck" bays. The solver keeps that list in every engine - the
route search, the load re-check (repack, fit fallback, recovery), the hire what-if, the second search
(skipped while a list decides something) - and the independent check flags a stop on another truck.
A request without the field is planned exactly as before.
"""
from __future__ import annotations

import json
import os

import pytest

import dispatch_solver as ds
import feasibility as FZ
import load_repack as LR
from dispatch_models import DispatchStop, DispatchTruck
from dispatch_solver import optimize_dispatch
from tests.test_dispatch import assert_reconciled, rec, req, served_ids, stop, truck, unserved_map
from tests.test_pallets import ALL, _day_of, _pyvrp_in_process, assert_pallets_hold, btruck, pstop  # noqa: F401

SMALL = "a small truck (at most 6 bays)"


def where(sc) -> dict[str, str]:
    """stop id -> the truck it is on."""
    return {st.stop_id: ld.truck_id for ld in sc.loads for st in ld.stops}


def assert_allowed(r, sc) -> None:
    """Every limited stop of the plan is on one of its trucks, and the check agrees (VERIFIED)."""
    stops = {s.stop_id: s for s in r.stops}
    for sid, tid in where(sc).items():
        allowed = stops[sid].allowed_truck_ids
        assert allowed is None or tid in allowed, (sc.name, sid, tid, allowed)
    assert_pallets_hold(r, sc)


def day(limited_units: int = 1_500, **kw):
    """Six stops for anyone and one limited stop (HYPER: the 6-bay trucks only)."""
    stops = [pstop(f"S{i}", 23.58 + 0.01 * i, 58.40 + 0.01 * i, cases=40, units=1_000) for i in range(6)]
    stops.append(pstop("HYPER", 23.62, 58.45, cases=60, units=limited_units, allowed_truck_ids=["SMALL"],
                       allowed_trucks_label=SMALL, **kw))
    return stops


# ---------------------------------------------------------------------------------------------
# The route search and every option
# ---------------------------------------------------------------------------------------------

def test_a_limited_stop_is_on_an_allowed_truck_in_every_option():
    """The 12-bay truck is far cheaper and has room for the whole day: without the limit nothing stops it
    from taking HYPER; with it, every option puts HYPER on the 6-bay truck, and says so (echo)."""
    trucks = [btruck("BIG", bays=12, max_trips=2, fixed_cost=5), btruck("SMALL", bays=6, cap=570, max_trips=2, fixed_cost=40)]
    r = req(day(), trucks, scenarios=ALL, time_limit_sec=3)
    resp = optimize_dispatch(r)
    assert len(resp.scenarios) == 3
    for sc in resp.scenarios:
        assert where(sc).get("HYPER") == "SMALL", (sc.name, where(sc))
        assert sc.allowed_trucks_rule is True
        assert_allowed(r, sc)
    # The same day without the limit: no echo (a request without the field is planned as before).
    free = req([s.model_copy(update={"allowed_truck_ids": None, "allowed_trucks_label": None}) for s in day()], trucks)
    sc = rec(optimize_dispatch(free))
    assert sc.allowed_trucks_rule is None
    assert served_ids(sc) == {s.stop_id for s in free.stops}
    assert where(sc)["HYPER"] == "BIG"  # the cheap big truck carries the whole day


def _raw_days():
    """Two days where, without the limit, a cheap big truck would take the limited stops: a bay day
    (HYPER on the 6-bay truck only) and a case-only day (every third stop on T2/T3 only)."""
    bays = req(day(), [btruck("BIG", bays=12, max_trips=2, fixed_cost=5), btruck("SMALL", bays=6, cap=570, max_trips=2, fixed_cost=40)])
    cases = req([stop(f"C{i}", 23.56 + (i % 4) * 0.015, 58.36 + (i // 4) * 0.03, cases=30 + 5 * i,
                      **({"allowed_truck_ids": ["T2", "T3"], "allowed_trucks_label": SMALL} if i % 3 == 0 else {}))
                 for i in range(12)],
                [truck("T1", cap=1_000, fixed_cost=5), truck("T2", cap=300, fixed_cost=40), truck("T3", cap=300, fixed_cost=40)])
    return {"bays": bays, "cases": cases}


@pytest.mark.parametrize("which", ["bays", "cases"])
def test_the_route_search_alone_keeps_the_limit_in_every_option(which):
    """The route search's own plan (before the load re-check, which would also move a stop back onto an
    allowed truck): it is what the safety net keeps when the re-check runs out of time, so the routing
    model's allowed vehicles must hold by themselves, for every option."""
    r = _raw_days()[which]
    tds, solvable, drops, mx, _ = _day_of(r)
    assert any(ds._limited(s, [td for td in tds if td.usable]) for s in solvable)
    for name in ALL:
        sc = ds._solve_scenario(name, r, solvable, tds, mx, 2, list(drops))
        assert sc.status == "OPTIMIZED", (name, sc.status)
        stops = {s.stop_id: s for s in r.stops}
        on = where(sc)
        assert on, name
        for sid, tid in on.items():
            allowed = stops[sid].allowed_truck_ids
            assert allowed is None or tid in allowed, (name, sid, tid, allowed)


def test_the_safety_net_plan_keeps_the_limit(monkeypatch):
    """The load re-check never runs (out of time): every option is the route search's plan as found
    (no loading time per case, no break rule: kept unchanged), and still no limited stop is on a truck it
    may not use; the independent check finds no TRUCK_NOT_ALLOWED."""
    monkeypatch.setenv("SOLVER_PARALLEL", "0")
    calls = {"n": 0}

    def no_stage(req_, solvable, tds, mx, time_limit, drops, results, *a, **kw):
        calls["n"] += 1
        ds._retime_fallback(req_, solvable, tds, mx, drops, results, "out of time")

    monkeypatch.setattr(ds, "_post_solve", no_stage)
    for r in _raw_days().values():
        r = r.model_copy(update={"config": r.config.model_copy(update={"scenarios": ALL})})
        resp = optimize_dispatch(r)
        assert len(resp.scenarios) == 3
        for sc in resp.scenarios:
            assert any("not re-checked" in w for w in sc.warnings), sc.warnings
            stops = {s.stop_id: s for s in r.stops}
            for sid, tid in where(sc).items():
                allowed = stops[sid].allowed_truck_ids
                assert allowed is None or tid in allowed, (sc.name, sid, tid, allowed)
            assert sc.feasibility is not None
            assert not [v for v in sc.feasibility.violations if v.code == "TRUCK_NOT_ALLOWED"], sc.feasibility.violations
    assert calls["n"] >= 2


def test_old_requests_carry_no_field_and_plan_as_before():
    """Backward compatible: the field is optional (None = any truck), the request JSON of an older web
    validates, and the plan is the same with or without an explicit None."""
    s = stop("A", 23.60, 58.45)
    assert s.allowed_truck_ids is None and s.allowed_trucks_label is None
    body = json.loads(req([stop("A", 23.60, 58.45)], [truck("T")]).model_dump_json())
    del body["stops"][0]["allowed_truck_ids"]
    del body["stops"][0]["allowed_trucks_label"]
    old = ds.DispatchRequest.model_validate(body)
    assert old.stops[0].allowed_truck_ids is None
    a = rec(optimize_dispatch(old))
    b = rec(optimize_dispatch(req([stop("A", 23.60, 58.45, allowed_truck_ids=None)], [truck("T")])))
    assert where(a) == where(b) == {"A": "T"}
    assert a.allowed_trucks_rule is None and not a.unserved


def test_split_parts_of_a_limited_customer_each_go_on_an_allowed_truck():
    """The web splits an order bigger than one small truck into parts sized for the small trucks (each
    part a stop with the same list): every part goes on a small truck, never the big one beside them."""
    parts = [pstop(f"MT#{k}", 23.62, 58.45, cases=200, units=5_000, allowed_truck_ids=["S1", "S2"], allowed_trucks_label=SMALL)
             for k in (1, 2, 3)]
    others = [pstop(f"O{i}", 23.59 + 0.01 * i, 58.41, cases=30, units=800) for i in range(3)]
    trucks = [btruck("BIG", bays=12, max_trips=2, fixed_cost=1), btruck("S1", bays=6, cap=570, max_trips=2, fixed_cost=30),
              btruck("S2", bays=6, cap=570, max_trips=2, fixed_cost=30)]
    r = req(parts + others, trucks, scenarios=ALL, time_limit_sec=3)
    for sc in optimize_dispatch(r).scenarios:
        w = where(sc)
        assert all(w.get(f"MT#{k}") in ("S1", "S2") for k in (1, 2, 3)), (sc.name, w)
        assert_allowed(r, sc)


def test_continuity_never_keeps_a_limited_stop_on_a_truck_it_may_not_use():
    """A re-plan steers a stop to its previous truck (a soft penalty); the limit is a hard rule."""
    stops = day(previous_truck_id="BIG")
    r = req(stops, [btruck("BIG", bays=12, max_trips=2), btruck("SMALL", bays=6, cap=570, max_trips=2)], change_penalty_per_stop=50)
    sc = rec(optimize_dispatch(r))
    assert where(sc)["HYPER"] == "SMALL"
    assert_allowed(r, sc)


# ---------------------------------------------------------------------------------------------
# Left out, with the reason
# ---------------------------------------------------------------------------------------------

def test_no_allowed_truck_today_leaves_it_out_with_the_reason():
    r = req(day(), [btruck("BIG", bays=12, max_trips=2)])
    sc = rec(optimize_dispatch(r))
    u = {x.stop_id: x for x in sc.unserved}
    assert u["HYPER"].reason_code == "NO_ALLOWED_TRUCK"
    assert u["HYPER"].reason_message.startswith(f"Needs {SMALL}: no such truck can take a new load today"), u["HYPER"].reason_message
    assert "HYPER" not in where(sc)
    assert served_ids(sc) == {f"S{i}" for i in range(6)}  # the others are planned
    assert_reconciled(r, sc)
    # An empty list: no truck may take it.
    r2 = req([pstop("X", 23.60, 58.45, allowed_truck_ids=[])], [btruck("BIG")])
    assert unserved_map(rec(optimize_dispatch(r2))) == {"X": "NO_ALLOWED_TRUCK"}


def test_an_allowed_truck_that_cannot_take_a_new_load_counts_as_none():
    """SMALL has used its loads (frozen); the reason is the limit, not "larger than any truck"."""
    from dispatch_models import FrozenTrip

    small = btruck("SMALL", bays=6, cap=570, max_trips=1, frozen_trips=[FrozenTrip(load_no=1, depart_min=400, return_min=600, cases=50)])
    r = req(day(), [btruck("BIG", bays=12, max_trips=2), small])
    assert unserved_map(rec(optimize_dispatch(r)))["HYPER"] == "NO_ALLOWED_TRUCK"


def test_an_order_larger_than_every_allowed_truck_names_the_largest_one():
    """Without split deliveries a limited order bigger than its largest truck cannot go at all; a big truck
    would carry it, so it is not "larger than any truck"."""
    r = req(day(limited_units=7_000), [btruck("BIG", bays=12, max_trips=2), btruck("SMALL", bays=6, cap=570, max_trips=2)])
    sc = rec(optimize_dispatch(r))
    u = {x.stop_id: x for x in sc.unserved}["HYPER"]
    assert u.reason_code == "NO_ALLOWED_TRUCK"
    assert u.reason_message == (f"Needs {SMALL}: the order is larger than the largest such truck (7.0 pallets vs largest truck "
                                "6.0 pallets: 6 bays at 100% fill); the other trucks may not deliver here. Turn on split "
                                "deliveries, or add or hire such a truck."), u.reason_message


def test_allowed_trucks_full_leaves_it_out_naming_them_while_a_big_truck_has_room():
    """Two limited stops of 4 pallets, one 6-bay truck with one load: one goes, the other is left out with
    NO_ALLOWED_TRUCK naming the truck; the 12-bay truck has room but may not take it. The rest is planned."""
    limited = [pstop(f"L{i}", 23.62 + 0.002 * i, 58.45, cases=80, units=4_000, priority=2, allowed_truck_ids=["SMALL"],
                     allowed_trucks_label=SMALL) for i in range(2)]
    others = [pstop(f"O{i}", 23.59 + 0.01 * i, 58.41, cases=30, units=800) for i in range(3)]
    r = req(limited + others, [btruck("BIG", bays=12, max_trips=2), btruck("SMALL", bays=6, cap=570, max_trips=1)], time_limit_sec=3)
    sc = rec(optimize_dispatch(r))
    left = [u for u in sc.unserved if u.stop_id.startswith("L")]
    assert len(left) == 1 and left[0].reason_code == "NO_ALLOWED_TRUCK"
    assert left[0].reason_message.startswith(f"Needs {SMALL}: no such truck had room (SMALL)"), left[0].reason_message
    assert {f"O{i}" for i in range(3)} <= served_ids(sc)
    assert_allowed(r, sc)


def test_a_receiving_window_only_a_bigger_truck_could_reach_says_the_limit():
    """The window check judges a limited stop on its own trucks: SMALL starts at 10:00, BIG at 06:00, the
    customer closes at 07:00 - left out by its hours, and the reason says only a small truck may deliver."""
    s = pstop("C", 23.60, 58.42, units=500, hard_start_min=360, hard_end_min=420, allowed_truck_ids=["SMALL"], allowed_trucks_label=SMALL)
    r = req([s], [btruck("BIG", bays=12), btruck("SMALL", bays=6, cap=570, available_from_min=600)])
    u = rec(optimize_dispatch(r)).unserved[0]
    assert u.reason_code == "HARD_WINDOW_INFEASIBLE"
    assert u.reason_message.endswith(f"Only {SMALL} may deliver here."), u.reason_message


# ---------------------------------------------------------------------------------------------
# The load re-check (repack, fit fallback, recovery) and the independent check
# ---------------------------------------------------------------------------------------------

def test_repack_never_puts_a_limited_stop_on_another_truck():
    stops = [pstop("A", 23.60, 58.45, cases=50, units=1_000, allowed_truck_ids=["R2"]),
             pstop("B", 23.605, 58.455, cases=50, units=1_000),
             pstop("C", 23.61, 58.46, cases=50, units=1_000, allowed_truck_ids=["R1", "R2"])]
    r = req(stops, [btruck("R1", bays=12, max_trips=3), btruck("R2", bays=12, max_trips=3)])
    tds, solvable, _, mx, ctx = _day_of(r)
    d = ctx.day
    r1, r2 = d.trucks[0], d.trucks[1]
    assert LR.facts(d, (1,)).allowed is None  # B: any truck
    assert LR.facts(d, (0, 1)).allowed == frozenset({"R2"})
    assert LR.facts(d, (0, 2)).allowed == frozenset({"R2"})  # the intersection
    assert LR.facts(d, (1, 2)).allowed == frozenset({"R1", "R2"})
    assert not LR.fits_truck(LR.facts(d, (0, 1)), r1) and LR.fits_truck(LR.facts(d, (0, 1)), r2)
    assert LR.depart_range(d, LR.facts(d, (0,)), r1) is None
    assert LR.time_plan(d, {r1.idx: [(0,)]}, ctx.rec_pricing) is None  # no timetable on a truck it may not use
    assert LR.time_plan(d, {r2.idx: [(0,)], r1.idx: [(1, 2)]}, ctx.rec_pricing) is not None
    # Two trucks alike in every other way are not interchangeable when a stop may go on one only.
    assert LR._identical_trucks(d, ctx.rec_pricing) == {}
    free = req([s.model_copy(update={"allowed_truck_ids": None}) for s in stops], [btruck("R1", bays=12, max_trips=3),
                                                                                    btruck("R2", bays=12, max_trips=3)])
    _, _, _, _, ctx2 = _day_of(free)
    assert len(LR._identical_trucks(ctx2.day, ctx2.rec_pricing)) == 2


def test_the_fit_fallback_and_every_option_keep_the_limit():
    """A tight day (loading time per case, small loads per truck): whatever path makes each option - the
    search, the repack, the fit fallback - the limited stops stay on their trucks."""
    stops = [pstop(f"S{i}", 23.56 + (i % 5) * 0.012, 58.36 + (i // 5) * 0.03, cases=60 + 7 * i, units=900 + 130 * i,
                   service_min=15, **({"allowed_truck_ids": ["R2"], "allowed_trucks_label": SMALL} if i % 3 == 0 else {}))
             for i in range(14)]
    r = req(stops, [btruck("R1", bays=12, cap=1140, max_trips=3), btruck("R2", bays=6, cap=570, max_trips=3)],
            scenarios=ALL, loading_min_per_case=0.05, time_limit_sec=3)
    for sc in optimize_dispatch(r).scenarios:
        assert_allowed(r, sc)
        for u in sc.unserved:
            if u.stop_id in {f"S{i}" for i in range(0, 14, 3)}:
                assert u.reason_code in ("NO_ALLOWED_TRUCK", "SOLVER_DROPPED_LOW_PRIORITY"), u


def test_the_independent_check_flags_a_stop_on_a_truck_it_may_not_use():
    stops = [pstop("A", 23.60, 58.45, cases=50, units=1_000), pstop("B", 23.61, 58.46, cases=50, units=1_000)]
    r = req(stops, [btruck("BIG", bays=12, max_trips=1)])
    sc = rec(optimize_dispatch(r))
    assert sc.feasibility.status == "VERIFIED" and sc.feasibility.checked_at_version == FZ.CHECK_VERSION == 5
    # The same plan checked against a request where B takes the 6-bay trucks only (a limit set later).
    later = r.model_copy(deep=True)
    later.stops[1].allowed_truck_ids = ["SMALL"]
    later.stops[1].allowed_trucks_label = SMALL
    rep = FZ.check_scenario(later, sc)
    assert rep.status == "VIOLATED"
    assert [(v.code, v.stop_id) for v in rep.violations] == [("TRUCK_NOT_ALLOWED", "B")]
    assert rep.violations[0].message == f"BIG load 1 visits B, which needs {SMALL}."


# ---------------------------------------------------------------------------------------------
# The hire what-if and the second search
# ---------------------------------------------------------------------------------------------

def test_the_hire_what_if_rents_a_small_truck_for_a_limited_order():
    """The own fleet is one 12-bay truck; a P2 order takes small trucks only. The what-if offers a 10-ton
    (12 bays, 40 OMR) and a 3-ton (6 bays, 60 OMR); only the 3-ton is on the order's list (the web adds the
    small trucks to rent to it): the 3-ton is rented although the 10-ton is cheaper."""
    s = pstop("C", 23.61, 58.43, cases=40, units=2_000, priority=2, allowed_truck_ids=["H3-1"], allowed_trucks_label=SMALL)
    others = [pstop(f"O{i}", 23.60 + 0.002 * i, 58.42, cases=20, units=1_000, priority=3) for i in range(3)]
    trucks = [btruck("OWN", bays=12, max_trips=1, fixed_cost=35),  # big, with room: C may not go on it
              btruck("H10-1", bays=12, fixed_cost=40, max_trips=1, hire_candidate=True),
              btruck("H3-1", bays=6, cap=570, fixed_cost=60, max_trips=1, hire_candidate=True)]
    r = req([s] + others, trucks, time_limit_sec=3)
    sc = rec(optimize_dispatch(r))
    assert where(sc).get("C") == "H3-1", where(sc)
    assert "H10-1" not in {ld.truck_id for ld in sc.loads}
    assert_allowed(r, sc)


def test_the_second_search_is_skipped_while_a_limit_decides_something(_pyvrp_in_process):
    r = req(day(), [btruck("BIG", bays=12, max_trips=2), btruck("SMALL", bays=6, cap=570, max_trips=2)], time_limit_sec=2)
    resp = optimize_dispatch(r)
    assert resp.search.pyvrp is not None
    assert (resp.search.pyvrp.status, resp.search.pyvrp.reason) == ("SKIPPED", "ALLOWED_TRUCKS")
    assert_allowed(r, rec(resp))
    # A list that holds every truck of the day decides nothing: the second search runs.
    moot = req(day(), [btruck("SMALL", bays=6, cap=570, max_trips=3)], time_limit_sec=2)
    resp2 = optimize_dispatch(moot)
    assert resp2.search.pyvrp.status in ("CHOSEN", "NOT_CHOSEN"), resp2.search.pyvrp
    assert_allowed(moot, rec(resp2))
    # Nor does one that leaves out only a truck that cannot take a load today (its one trip is used):
    # only the trucks that can still load count, as everywhere else the limit is judged.
    from dispatch_models import FrozenTrip

    gone = btruck("BIG", bays=12, max_trips=1, frozen_trips=[FrozenTrip(load_no=1, depart_min=400, return_min=600, cases=50)])
    spent = req(day(), [gone, btruck("SMALL", bays=6, cap=570, max_trips=3)], time_limit_sec=2)
    assert not ds._limits_decide(spent, spent.stops)
    assert ds._limits_decide(r, r.stops)
    resp3 = optimize_dispatch(spent)
    assert resp3.search.pyvrp.status in ("CHOSEN", "NOT_CHOSEN"), resp3.search.pyvrp
    assert_allowed(spent, rec(resp3))


# ---------------------------------------------------------------------------------------------
# Contract
# ---------------------------------------------------------------------------------------------

def test_contract_bounds_and_the_small_truck_setting():
    """The label is text of at most 120 characters; the web's "small truck = at most N bays" setting
    (planner-bounds.json config.smallTruckMaxBays) lies inside the trucks' bays range it is compared with."""
    with pytest.raises(Exception):
        DispatchStop(stop_id="s", order_ids=["o"], customer_id="c", lat=23.6, lng=58.4, demand_cases=1, allowed_trucks_label="x" * 121)
    p = os.path.join(os.path.dirname(__file__), "..", "..", "..", "packages", "shared-types", "src", "planner-bounds.json")
    if not os.path.exists(p):
        pytest.skip("planner-bounds.json is not next to the solver (image build)")
    with open(p, encoding="utf-8") as f:
        b = json.load(f)
    small, bays = b["config"]["smallTruckMaxBays"], b["truck"]["bays"]
    assert small["solver"] == "stop.allowed_truck_ids" and small.get("int") is True
    assert bays["min"] <= small["min"] <= small["max"] <= bays["max"]
    for v in (small["min"], small["max"]):
        DispatchTruck(id="t", capacity_cases=1, bays=v)


def test_the_reason_code_and_check_code_are_in_the_shared_types():
    """The web's copy of the contract (packages/shared-types/src/dispatch.ts) knows the new codes and
    fields, so a plan that carries them is typed and stored (the reason is a database enum)."""
    p = os.path.join(os.path.dirname(__file__), "..", "..", "..", "packages", "shared-types", "src", "dispatch.ts")
    if not os.path.exists(p):
        pytest.skip("shared-types is not next to the solver (image build)")
    with open(p, encoding="utf-8") as f:
        ts = f.read()
    for word in ("'NO_ALLOWED_TRUCK'", "'TRUCK_NOT_ALLOWED'", "allowed_truck_ids?:", "allowed_trucks_label?:", "allowed_trucks_rule?:"):
        assert word in ts, word
