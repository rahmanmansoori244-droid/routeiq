"""Join small trips (join_trips.py; SOLVER_JOIN_TRIPS, off by default): after the load re-check, a company truck's
small load (at most 3 customer visits) rides on its other loads when that is cheaper by at least 0.5 OMR, costs no
more money, keeps every rule (exact timing, the driver break, bays), keeps the margins to the latest return and the
break window's end, and passes the independent check.

Synthetic days only (invented stops S1.. near the tests' depot, trucks T1..), in-process (SOLVER_PARALLEL=0 where the
engine is monkeypatched: a spawned worker would not see the patch), seconds each. Most end-to-end tests run the load
re-check (_post_solve) on hand-built plans with the repacks giving no answer, so its candidates are the plans as
given and only this step can join their loads.
"""
from __future__ import annotations

import dataclasses
import os
import re
import time

import pytest

import dispatch_solver as ds
import join_trips as JT
import load_repack as LR
from dispatch_models import (
    DispatchStop,
    FrozenTrip,
    JoinTripsMove,
    JoinTripsOption,
    JoinTripsReport,
    SearchReport,
)
from dispatch_solver import optimize_dispatch
from tests.test_dispatch import hm, rec, req, served_ids, stop, truck
from tests.test_repack import assert_plan_rules, matrix_for

SOLVER_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
S1, S2, S3 = 0, 1, 2
COSTS = dict(fixed_cost=20, trip_cost=3, cost_per_km=0.1)


@pytest.fixture(autouse=True)
def _join_off_unless_a_test_sets_it(monkeypatch):
    monkeypatch.delenv(JT.ENV_MODE, raising=False)


@pytest.fixture()
def plans_as_given(monkeypatch):
    """The load repacks give no answer: the stage's candidates are the plans as given (only the join joins)."""
    monkeypatch.setattr(LR, "repack", lambda *a, **kw: LR.RepackResult(None, "UNKNOWN", 0.0))


def three_stops(**kw):
    return [stop("S1", 23.620, 58.420, cases=30, **kw), stop("S2", 23.630, 58.430, cases=30, **kw),
            stop("S3", 23.625, 58.440, cases=20, **kw)]


def small_day(trucks=None, stops=None, **cfg):
    """Three stops 5-7 km north-east of the depot, 80 cases; T1 of 100 cases, two loads at most, 20 OMR a day,
    3 OMR a load, 0.1 OMR a km, the driver 2 OMR an hour, a 30 min turnaround."""
    cfg.setdefault("driver_cost_per_hour", 2.0)
    cfg.setdefault("reload_min", 30)
    cfg.setdefault("shift_start_min", hm("07:00"))
    return req(stops or three_stops(), trucks or [truck("T1", cap=100, max_trips=2, **COSTS)], **cfg)


TWO_LOADS = {0: [(S1, S2), (S3,)]}


def ctx_of(r):
    return ds._stage_ctx(r, r.stops, ds._truck_days(r), matrix_for(r), [])


def timed_of(r, plan):
    c = ctx_of(r)
    t = LR.time_plan(c.day, plan, c.rec_pricing)
    assert t is not None
    return c, t


def built(r, plan, name="RECOMMENDED"):
    """The scenario of ``plan`` (stop indices per truck index), timed exactly, as a route search plan."""
    c, t = timed_of(r, plan)
    return ds._build_scenario(name, r, r.stops, c.tds, c.mx, t, c.values, False, [], solver_status="ROUTING_SUCCESS",
                              elapsed=1.0, time_limit=2, objective_value=0)


def start(monkeypatch, mode: str | None):
    if mode is None:
        monkeypatch.delenv(JT.ENV_MODE, raising=False)
    else:
        monkeypatch.setenv(JT.ENV_MODE, mode)
    return JT.start()


def stage(r, plans, join, budget=60.0):
    """The load re-check (_post_solve, in-process) on the hand-built plans of ``plans`` (option -> plan)."""
    results = {n: built(r, p, n) for n, p in plans.items()}
    ds._post_solve(r, r.stops, ds._truck_days(r), matrix_for(r), 2, [], results, None, time.monotonic() + budget,
                   join=join)
    if join is not None:
        JT.finish(join)
    return results


def loads_of(sc) -> list[tuple[str, tuple[str, ...]]]:
    return [(ld.truck_id, tuple(st.stop_id for st in ld.stops)) for ld in sc.loads]


def notes(sc) -> list[str]:
    return [w for w in sc.warnings if w.startswith(JT.NOTE_HEAD)]


def option(join, name="RECOMMENDED") -> dict:
    return next(o for o in join.report["options"] if o["option"] == name)


# --------------------------------------------------------------------------------------
# The setting
# --------------------------------------------------------------------------------------

@pytest.mark.parametrize("value,mode", [("", "off"), ("off", "off"), ("0", "off"), ("false", "off"), ("no", "off"), ("report", "report"), ("REPORT", "report"), ("on", "on"), (" 1 ", "on"), ("true", "on"), ("yes", "on"), ("enable", "off")])
def test_setting_parses(value, mode, monkeypatch):
    monkeypatch.setenv(JT.ENV_MODE, value)
    assert JT.mode() == mode
    assert (JT.start() is None) is (mode == "off")
    assert [n for n, _, _ in JT.unread()] == (["SOLVER_JOIN_TRIPS"] if value == "enable" else [])


def test_ready_and_the_startup_line_name_join_trips(monkeypatch):
    """The post-deploy check: /ready's ``join_trips`` and the startup line say the mode and the rule; off by
    default; a value it does not read is named. Never changes ``ok``."""
    from fastapi.testclient import TestClient

    import main

    monkeypatch.setattr(main, "SOLVER_TOKEN", "unit-test-solver-token")
    client = TestClient(main.app)

    def ready() -> dict:
        body = client.get("/ready", headers={"X-Solver-Token": "unit-test-solver-token"}).json()
        assert body["ok"] is True
        return body["join_trips"]

    assert ready() == {"mode": "off", "min_gain_omr": 0.5, "slack_min": 20, "max_stops": 3, "across_trucks": False,
                       "unread": []}
    assert JT.startup_line() == "Join small trips: off (the default; SOLVER_JOIN_TRIPS unset or off)"
    monkeypatch.setenv(JT.ENV_MODE, "report")
    assert ready()["mode"] == "report"
    assert JT.startup_line().startswith("Join small trips: report (computed and reported in search.join_trips; plans "
                                        "unchanged; min gain 0.5 OMR, margin 20 min")
    monkeypatch.setenv(JT.ENV_MODE, "on")
    assert ready()["mode"] == "on"
    assert JT.startup_line().startswith("Join small trips: on (a small load of 1-3 stops rides on another load")
    assert JT.startup_line().endswith("moves onto other trucks: reported only)")
    monkeypatch.setenv(JT.ENV_MODE, "enable")
    assert ready()["mode"] == "off" and ready()["unread"] == ["SOLVER_JOIN_TRIPS"]
    assert JT.startup_line() == ("Join small trips: off (the default; SOLVER_JOIN_TRIPS unset or off; "
                                 "SOLVER_JOIN_TRIPS='enable' not read (off, report or on): off is used)")


# --------------------------------------------------------------------------------------
# Off: nothing changes
# --------------------------------------------------------------------------------------

def _search_returns(monkeypatch, r, plan):
    """The route search's plan is ``plan`` (timed exactly, VERIFIED) in every option; the repacks give no answer."""
    monkeypatch.setenv("SOLVER_PARALLEL", "0")
    raw = built(r, plan)

    def search(name, *a, **kw):
        out = raw.model_copy(deep=True)
        out.name = name
        return out

    monkeypatch.setattr(ds, "_solve_scenario", search)
    monkeypatch.setattr(LR, "repack", lambda *a, **kw: LR.RepackResult(None, "UNKNOWN", 0.0))
    monkeypatch.setattr(LR, "EXTENDED_MAX_SEC", 0)


def test_off_never_calls_the_step(monkeypatch):
    r = small_day()
    _search_returns(monkeypatch, r, TWO_LOADS)
    monkeypatch.setattr(JT, "join_plan", lambda *a, **kw: pytest.fail("the step ran with SOLVER_JOIN_TRIPS off"))
    resp = optimize_dispatch(r)
    sc = rec(resp)
    assert loads_of(sc) == [("T1", ("S1", "S2")), ("T1", ("S3",))] and not notes(sc)
    assert resp.search is not None and resp.search.join_trips is None
    assert_plan_rules(r, sc)


def test_flag_unset_builds_exactly_as_before(monkeypatch, plans_as_given):
    """Critique J6: with the flag unset every option is built once; report mode makes the same first call, with the
    same arguments as with the flag unset, then one more for the joined plan, and keeps the first."""
    r = small_day(scenarios=["RECOMMENDED", "MIN_TRUCKS", "MIN_DISTANCE"])
    calls: list = []
    real = ds._build_scenario

    def spy(*a, **kw):
        # The stage's wall-clock seconds (``elapsed``) differ between two runs; every other argument must not.
        calls.append((a[0], LR.plan_signature(LR.plan_of(a[5])),
                      sorted((k, repr(v)) for k, v in kw.items() if k != "elapsed"), kw))
        return real(*a, **kw)

    plans = {n: TWO_LOADS for n in ("RECOMMENDED", "MIN_TRUCKS", "MIN_DISTANCE")}
    built_first = {n: built(r, p, n) for n, p in plans.items()}
    monkeypatch.setattr(ds, "_build_scenario", spy)

    def run(join):
        calls.clear()
        results = {n: sc.model_copy(deep=True) for n, sc in built_first.items()}
        ds._post_solve(r, r.stops, ds._truck_days(r), matrix_for(r), 2, [], results, None, time.monotonic() + 60, join=join)
        return list(calls), results

    off_calls, off = run(None)
    assert [c[0] for c in off_calls] == ["RECOMMENDED", "MIN_TRUCKS", "MIN_DISTANCE"]
    rep_calls, rep = run(start(monkeypatch, "report"))
    assert [c[:3] for c in rep_calls[0::2]] == [c[:3] for c in off_calls]  # the same build, the same arguments
    for first, joined in zip(rep_calls[0::2], rep_calls[1::2]):
        assert len(joined[1][0][1]) == 1  # then the joined plan, one load ...
        # ... with exactly the arguments of the build it replaces but its objective (critique J1).
        assert {k: v for k, v in joined[3].items() if k != "objective_value"} == \
               {k: v for k, v in first[3].items() if k != "objective_value"}
    for n in off:
        assert loads_of(rep[n]) == loads_of(off[n]) and rep[n].warnings == off[n].warnings


# --------------------------------------------------------------------------------------
# The step on one plan
# --------------------------------------------------------------------------------------

def test_two_loads_of_one_truck_become_one():
    r = small_day()
    c, t = timed_of(r, TWO_LOADS)
    res = JT.join_plan(c.day, c.rec_pricing, t, {0}, "RECOMMENDED", time.monotonic() + 5)
    assert res.outcome == "JOINED" and res.changed and len(res.plan[0]) == 1
    assert LR.served_of(res.plan) == LR.served_of(t) == {S1, S2, S3}
    assert LR.timing_ok(c.day, c.day.by_idx[0], res.plan[0])
    (m,) = res.moves
    assert (m.kind, m.truck_id, m.stop_ids, m.cases, m.loads_before, m.loads_after) == ("JOIN", "T1", ("S3",), 20, 2, 1)
    assert m.gain >= JT.MIN_GAIN_UNITS and m.gain_op >= 0 and m.back_after_s < m.back_before_s
    assert res.tried >= 1 and res.timings >= 1 and res.lps >= 1 and res.seconds < 2
    assert t[0][1].stops == (S3,)  # the plan given is never modified


def test_report_mode_changes_nothing_and_reports(monkeypatch, plans_as_given):
    r = small_day()
    off = stage(r, {"RECOMMENDED": TWO_LOADS}, None)["RECOMMENDED"]
    join = start(monkeypatch, "report")
    sc = stage(r, {"RECOMMENDED": TWO_LOADS}, join)["RECOMMENDED"]
    assert loads_of(sc) == loads_of(off) == [("T1", ("S1", "S2")), ("T1", ("S3",))]
    assert sc.warnings == off.warnings and not notes(sc)
    o = option(join)
    assert join.report["status"] == "WOULD_JOIN" and o["outcome"] == "WOULD_JOIN" and o["verified"] is True
    assert (o["loads_before"], o["loads_after"]) == (2, 1) and o["gain_omr"] >= 0.5 and o["gain_operating_omr"] >= 0
    assert [m["applied"] for m in o["moves"]] == [False]
    # What a dispatcher reviews before the switch goes on: the truck's loads as the join would make them.
    (stops_after,) = [m["stops_after"] for m in o["moves"]]
    assert len(stops_after) == 1 and sorted(stops_after[0]) == ["S1", "S2", "S3"]
    assert JT.report_or_none(join.report).status == "WOULD_JOIN"


def test_on_mode_joins_and_keeps_every_rule(monkeypatch, plans_as_given):
    r = small_day()
    off = stage(r, {"RECOMMENDED": TWO_LOADS}, None)["RECOMMENDED"]
    join = start(monkeypatch, "on")
    sc = stage(r, {"RECOMMENDED": TWO_LOADS}, join)["RECOMMENDED"]
    assert len(sc.loads) == 1 and served_ids(sc) == {"S1", "S2", "S3"} and sc.trips == 1
    assert sc.operating_cost <= off.operating_cost - 0.5
    assert_plan_rules(r, sc)  # VERIFIED, every rule
    (note,) = notes(sc)
    assert re.fullmatch(r"Small loads joined after the load re-check: T1 2 -> 1 loads \(back \d\d:\d\d instead of "
                        r"\d\d:\d\d\)\. In all 2 -> 1 loads, \d+ -> \d+ OMR operating cost\. Each joined day was timed "
                        r"again with every rule and checked independently\.", note), note
    o = option(join)
    assert join.report["status"] == "JOINED" and o["outcome"] == "JOINED" and o["verified"] is True
    assert [m["applied"] for m in o["moves"]] == [True]
    rep = JT.report_or_none(join.report)
    assert rep is not None and rep.options[0].moves[0].stop_ids == ["S3"]
    assert rep.options[0].moves[0].stops_after == [[st.stop_id for st in sc.loads[0].stops]]


def test_gain_under_half_an_omr_is_not_taken():
    """Two stops by the depot, no day or trip cost, no driver cost, no turnaround: joining saves a few metres."""
    r = req([stop("S1", 23.586, 58.391, cases=30), stop("S2", 23.587, 58.392, cases=20)],
            [truck("T1", cap=100, max_trips=2, cost_per_km=0.01)], shift_start_min=hm("07:00"), reload_min=0)
    c, t = timed_of(r, {0: [(S1,), (S2,)]})
    res = JT.join_plan(c.day, c.rec_pricing, t, {0}, "RECOMMENDED", time.monotonic() + 5)
    assert res.outcome == "NOT_BETTER" and not res.changed and res.plan is t


def test_money_never_rises():
    g = JT.MIN_GAIN_UNITS
    assert JT.gain_ok("RECOMMENDED", (1000, 50, 5 * g), (1000, 60, 4 * g))  # 1 x the gain, same money, more metres
    assert not JT.gain_ok("RECOMMENDED", (1000, 50, 5 * g), (1001, 40, 3 * g))  # cheaper overall, but more money
    assert not JT.gain_ok("RECOMMENDED", (1000, 50, 5 * g), (900, 40, 5 * g - g + 1))  # a gain just under the minimum
    assert not JT.gain_ok("MIN_DISTANCE", (1000, 50, 5 * g), (1000, 51, 3 * g))  # MIN_DISTANCE: never more metres
    assert JT.gain_ok("MIN_DISTANCE", (1000, 50, 5 * g), (1000, 50, 3 * g))


def _tl(dep: str, ret: str, brk: tuple[str, str] | None = None):
    b = LR.BreakAt(hm(brk[0]) * 60, brk[1]) if brk else None
    return LR.TimedLoad(stops=(0,), depart_s=hm(dep) * 60, starts=(hm(dep) * 60 + 600,), return_s=hm(ret) * 60, brk=b)


def test_margin_to_the_latest_return():
    """At least 20 min to the latest return (18:00 here), or no tighter than the plan it replaces."""
    r = small_day(latest_return_min=hm("18:00"))
    c = ctx_of(r)
    td = c.day.by_idx[0]
    assert JT.margins(c.day, td, [_tl("07:00", "17:00")]) == (60 * 60, None)
    base = [_tl("07:00", "12:00"), _tl("12:30", "17:20")]  # back 40 min before 18:00
    assert not JT.slack_ok(c.day, td, base, [_tl("07:00", "17:50")])  # 10 min: SLACK
    assert JT.slack_ok(c.day, td, base, [_tl("07:00", "17:40")])  # 20 min
    tight = [_tl("07:00", "12:00"), _tl("12:30", "17:55")]  # the plan it replaces was back 5 min before
    assert JT.slack_ok(c.day, td, tight, [_tl("07:00", "17:55")]) and not JT.slack_ok(c.day, td, tight, [_tl("07:00", "17:56")])
    # Without frozen loads the shift maximum (11 h from the first departure) is a limit too.
    assert JT.margins(c.day, td, [_tl("06:30", "17:15")])[0] == 15 * 60


def test_margin_to_the_break_window_end():
    """A 60-min break starting 12:00-14:00: the joined day's break must start 20 min before 14:00, or no later than
    the plan's own; a day back by 14:00 without a break counts its return."""
    r = small_day(break_min=60, break_start_from_min=hm("12:00"), break_start_to_min=hm("14:00"))
    c = ctx_of(r)
    td = c.day.by_idx[0]
    assert LR.break_due(td)
    early = [_tl("07:00", "11:00"), _tl("13:00", "16:00", ("12:00", "DEPOT"))]  # its break 120 min before 14:00
    assert JT.margins(c.day, td, early)[1] == 120 * 60
    assert not JT.slack_ok(c.day, td, early, [_tl("07:00", "16:00", ("13:50", "ROAD"))])  # 10 min: SLACK
    assert JT.slack_ok(c.day, td, early, [_tl("07:00", "16:00", ("13:40", "ROAD"))])
    late = [_tl("07:00", "11:00"), _tl("15:00", "16:00", ("14:00", "DEPOT"))]  # the plan's own break at 14:00
    assert JT.slack_ok(c.day, td, late, [_tl("07:00", "16:00", ("14:00", "ROAD"))])
    assert JT.margins(c.day, td, [_tl("07:00", "13:30")])[1] == 30 * 60  # back by the window's end, no break


def _long_road_between(latest_return_min: int | None = None):
    """S1 and S2 on loads of their own; going on from S1 to S2 takes 15 min (and 2 km) longer than going back to
    the depot between them, and there is no turnaround: joined, the day is one load cheaper but back 15 min later."""
    kw = {} if latest_return_min is None else {"latest_return_min": latest_return_min}
    r = small_day(stops=three_stops()[:2], reload_min=0, **kw)
    c = ctx_of(r)
    D, T = c.day.D, c.day.T
    D[1][2] = D[2][1] = D[1][0] + D[0][2] + 2000
    T[1][2] = T[2][1] = T[1][0] + T[0][2] + 900
    t = LR.time_plan(c.day, {0: [(S1,), (S2,)]}, c.rec_pricing)
    assert t is not None
    return c, t


def test_a_join_that_leaves_too_little_margin_is_not_taken(monkeypatch):
    """The margin rule as the step applies it (owner decision 24 Oct 2026): with no latest return the later joined
    day is taken; with the latest return 25 min after the plan's own return it would leave 10 min - SLACK, the plan
    as it was. A move onto another truck keeps the rule on both trucks: with no margin kept, none is found."""
    c, t = _long_road_between()
    res = JT.join_plan(c.day, c.rec_pricing, t, {0}, "RECOMMENDED", time.monotonic() + 5)
    assert res.outcome == "JOINED" and res.moves[0].back_after_s > t[0][-1].return_s
    c, t = _long_road_between(latest_return_min=t[0][-1].return_s // 60 + 25)
    res = JT.join_plan(c.day, c.rec_pricing, t, {0}, "RECOMMENDED", time.monotonic() + 5)
    assert res.outcome == "SLACK" and not res.changed and res.plan is t
    trucks = [truck("T1", cap=100, max_trips=2, **COSTS), truck("T2", cap=100, max_trips=2, **COSTS)]
    c, t = timed_of(small_day(trucks=trucks), {0: [(S1, S2)], 1: [(S3,)]})
    assert [m.kind for m in JT.join_plan(c.day, c.rec_pricing, t, {0, 1}, "RECOMMENDED", time.monotonic() + 5).across] \
        == ["MOVE"]
    monkeypatch.setattr(JT, "slack_ok", lambda *a: False)
    res = JT.join_plan(c.day, c.rec_pricing, t, {0, 1}, "RECOMMENDED", time.monotonic() + 5)
    assert res.across == [] and res.plan is t


def test_break_due_day_is_timed_with_the_break(monkeypatch, plans_as_given):
    """A closes at 11:00, B (next to it) opens at 13:30: the plan's day holds its break at the depot between the
    loads; the joined load holds it on the road while it waits for B, inside the window - VERIFIED."""
    stops = [stop("A", 23.85, 58.10, cases=30, service_min=60, hard_end_min=hm("11:00")),
             stop("B", 23.86, 58.11, cases=30, service_min=60, hard_start_min=hm("13:30"))]
    r = small_day(stops=stops, break_min=60, break_start_from_min=hm("12:00"), break_start_to_min=hm("14:00"))
    sc = stage(r, {"RECOMMENDED": {0: [(0,), (1,)]}}, start(monkeypatch, "on"))["RECOMMENDED"]
    assert len(sc.loads) == 1 and served_ids(sc) == {"A", "B"}
    brk = sc.loads[0].driver_break
    assert brk is not None and brk.where == "ROAD" and hm("12:00") <= brk.start_min <= hm("13:40")
    assert notes(sc) and "with every rule, the driver break included, and checked independently." in notes(sc)[0]
    assert_plan_rules(r, sc)


def test_rented_and_day_paid_trucks_are_never_touched(monkeypatch, plans_as_given):
    """A truck whose driver is paid by the day (T1, hired for the day) and a truck to rent (H1) are not this step's
    (dispatch_solver._hired_km): the step is given the company truck T2 only, and T1's two loads stay as they are.
    Their day is routed again by _shorter_orders, which could merge them itself: here it returns the day as it is,
    so T1 keeps two loads the step could join if it were given T1."""
    monkeypatch.setattr(ds, "_shorter_orders", lambda ctx, cand, deadline: cand)
    trucks = [truck("T1", cap=100, max_trips=2, driver_day_cost=15.0, **COSTS), truck("T2", cap=100, max_trips=2, **COSTS),
              truck("H1", cap=100, max_trips=2, fixed_cost=40, hire_candidate=True)]
    r = small_day(trucks=trucks)
    off = stage(r, {"RECOMMENDED": TWO_LOADS}, None)["RECOMMENDED"]
    assert loads_of(off) == [("T1", ("S1", "S2")), ("T1", ("S3",))]
    given: list = []
    real = JT.join_plan
    monkeypatch.setattr(JT, "join_plan", lambda day, pricing, plan, trucks, *a: given.append(set(trucks))
                        or real(day, pricing, plan, trucks, *a))
    join = start(monkeypatch, "on")
    sc = stage(r, {"RECOMMENDED": TWO_LOADS}, join)["RECOMMENDED"]
    assert given == [{1}]  # T2 only
    assert loads_of(sc) == loads_of(off) and sc.warnings == off.warnings and not notes(sc)
    assert option(join)["outcome"] == "NO_SMALL_LOAD" and join.report["status"] == "NONE"
    # The company-truck filter is what keeps T1 out: given T1, the step would join its loads.
    c, t = timed_of(r, TWO_LOADS)
    assert [ds._hired_km(tr) for tr in r.trucks] == [True, False, True]
    assert real(c.day, c.rec_pricing, t, {0}, "RECOMMENDED", time.monotonic() + 5).outcome == "JOINED"


def test_frozen_loads_stay(monkeypatch, plans_as_given):
    """T1 is out 07:00-09:00 with a locked load: its two new loads become one after it, load 2 of its day."""
    trucks = [truck("T1", cap=100, max_trips=3, frozen_trips=[FrozenTrip(load_no=1, depart_min=hm("07:00"),
                                                                           return_min=hm("09:00"), cases=50)], **COSTS)]
    r = small_day(trucks=trucks)
    sc = stage(r, {"RECOMMENDED": TWO_LOADS}, start(monkeypatch, "on"))["RECOMMENDED"]
    assert [ld.load_no for ld in sc.loads] == [2] and sc.loads[0].depart_min >= hm("09:30")
    assert notes(sc)
    assert_plan_rules(r, sc)  # load numbers after the frozen one, departure after its return + turnaround


def test_a_same_day_plan_keeps_its_loading_start(monkeypatch, plans_as_given):
    """A plan made on its delivery day (loading from 10:00, 0.5 min a case): the joined load leaves no earlier than
    10:00 + the turnaround of its own 80 cases (ready_s binds)."""
    r = small_day(loading_from_min=hm("10:00"), loading_min_per_case=0.5)
    sc = stage(r, {"RECOMMENDED": TWO_LOADS}, start(monkeypatch, "on"))["RECOMMENDED"]
    assert len(sc.loads) == 1 and sc.loads[0].depart_min >= hm("10:00") + 30 + 40
    assert_plan_rules(r, sc)


def test_min_distance_never_gets_more_km():
    """The road between S1 and S2 is long (a matrix where going on costs 5 km more than going back to the depot):
    joining saves the trip and the turnaround but adds km - RECOMMENDED takes it, MIN_DISTANCE does not."""
    r = small_day(stops=three_stops()[:2])
    c, t = timed_of(r, {0: [(S1,), (S2,)]})
    D = c.day.D
    D[1][2] = D[2][1] = D[1][0] + D[0][2] + 5000
    t = LR.time_plan(c.day, {0: [(S1,), (S2,)]}, c.rec_pricing)
    got = JT.join_plan(c.day, c.rec_pricing, t, {0}, "RECOMMENDED", time.monotonic() + 5)
    assert got.outcome == "JOINED" and got.moves[0].gain_m < 0
    assert JT.join_plan(c.day, c.rec_pricing, t, {0}, "MIN_DISTANCE", time.monotonic() + 5).outcome == "NOT_BETTER"


def _bay_stop(sid: str, customer: str, units: int, **kw) -> DispatchStop:
    return DispatchStop(stop_id=sid, order_ids=[f"o-{sid}"], customer_id=customer, lat=23.62, lng=58.42,
                        demand_cases=50, demand_pallet_units=units, **kw)


def test_bays_98_and_100_percent():
    """10 bays at a 98% fill (9.8 pallets), one customer may fill every bay (10.0): two customers of 9.9 pallets
    together are never joined; two parts of ONE customer's order, 10.0 pallets, are, also when one part may only go
    on this truck (allowed_truck_ids)."""
    cfg = dict(pallet_fill_pct=98, single_customer_fill_pct=100)
    t1 = [truck("T1", cap=100, bays=10, max_trips=2, **COSTS)]
    two = small_day(trucks=t1, stops=[_bay_stop("X", "c-X", 5000), _bay_stop("Y", "c-Y", 4900)], **cfg)
    c, t = timed_of(two, {0: [(0,), (1,)]})
    assert JT.join_plan(c.day, c.rec_pricing, t, {0}, "RECOMMENDED", time.monotonic() + 5).outcome == "NONE_FITS"
    one = small_day(trucks=t1, stops=[_bay_stop("X1", "c-X", 5000), _bay_stop("X2", "c-X", 5000, allowed_truck_ids=["T1"])], **cfg)
    c, t = timed_of(one, {0: [(0,), (1,)]})
    res = JT.join_plan(c.day, c.rec_pricing, t, {0}, "RECOMMENDED", time.monotonic() + 5)
    assert res.outcome == "JOINED" and [tl.stops for tl in res.plan[0]] in ([(0, 1)], [(1, 0)])


def test_three_loads_become_two_and_spread():
    """N1 and S1 60 cases each, N2 + S2 30 + 30 on one load between them, 100 cases a load: no two loads fit
    together, but N2 rides with N1 and S2 with S1 (SPREAD, or the re-cut): 3 -> 2 loads."""
    stops = [stop("N1", 23.70, 58.39, cases=60), stop("N2", 23.71, 58.40, cases=30), stop("S2", 23.46, 58.40, cases=30),
             stop("S1", 23.45, 58.39, cases=60)]
    r = small_day(stops=stops, trucks=[truck("T1", cap=100, max_trips=3, **COSTS)], shift_start_min=hm("06:00"))
    c, t = timed_of(r, {0: [(0,), (1, 2), (3,)]})
    loads = [tl.stops for tl in t[0]]
    spread = [p for kind, _b, p in JT.proposals(c.day, c.day.by_idx[0], loads, time.monotonic() + 5, {}) if kind == "SPREAD"]
    assert any(sorted(map(set, p), key=min) == [{0, 1}, {2, 3}] for p in spread), spread
    res = JT.join_plan(c.day, c.rec_pricing, t, {0}, "RECOMMENDED", time.monotonic() + 5)
    assert res.outcome == "JOINED" and sorted(map(set, (tl.stops for tl in res.plan[0])), key=min) == [{0, 1}, {2, 3}]
    # Three loads of which two fit together: 3 -> 2 by JOIN, and no further (the two left do not fit together).
    stops = [stop("A", 23.62, 58.42, cases=30), stop("B", 23.63, 58.43, cases=30), stop("C", 23.625, 58.44, cases=60)]
    r = small_day(stops=stops, trucks=[truck("T1", cap=100, max_trips=3, **COSTS)])
    c, t = timed_of(r, {0: [(0,), (1,), (2,)]})
    res = JT.join_plan(c.day, c.rec_pricing, t, {0}, "RECOMMENDED", time.monotonic() + 5)
    assert res.outcome == "JOINED" and len(res.plan[0]) == 2 and [m.kind for m in res.moves] == ["JOIN"]
    assert LR.served_of(res.plan) == {0, 1, 2}


def test_split_parts_stay_together():
    """The two parts of one customer's split order are one visit: a load with them and two other customers is
    still small, and nothing is ever put between them."""
    parts = [DispatchStop(stop_id=f"P{i}", order_ids=[f"o-P{i}"], customer_id="c-P", lat=23.62, lng=58.42,
                          demand_cases=20) for i in (1, 2)]
    stops = parts + [stop("Q", 23.63, 58.43, cases=10), stop("R", 23.635, 58.425, cases=10),
                     stop("Z", 23.625, 58.44, cases=10)]
    r = small_day(stops=stops)
    c, t = timed_of(r, {0: [(0, 1, 2, 3), (4,)]})
    assert len(LR._blocks(c.day, (0, 1, 2, 3))) == 3
    props = JT.proposals(c.day, c.day.by_idx[0], [tl.stops for tl in t[0]], time.monotonic() + 5, {})
    assert props
    for _kind, _b, p in props:
        for load in p:
            if 0 in load or 1 in load:
                assert 0 in load and 1 in load and abs(load.index(0) - load.index(1)) == 1, p
    res = JT.join_plan(c.day, c.rec_pricing, t, {0}, "RECOMMENDED", time.monotonic() + 5)
    assert res.outcome == "JOINED" and len(res.plan[0]) == 1


def test_a_load_of_four_visits_is_not_small(monkeypatch):
    """Small = at most 3 customer visits (owner decision 24 Oct 2026): two loads of 4 visits that fit together on
    one load stay as they are (NO_SMALL_LOAD); with 4 allowed they are joined."""
    stops = [stop(f"V{i}", 23.620 + 0.002 * i, 58.420 + 0.002 * i, cases=10) for i in range(8)]
    c, t = timed_of(small_day(stops=stops), {0: [(0, 1, 2, 3), (4, 5, 6, 7)]})
    res = JT.join_plan(c.day, c.rec_pricing, t, {0}, "RECOMMENDED", time.monotonic() + 5)
    assert res.outcome == "NO_SMALL_LOAD" and not res.changed and res.tried == 0
    monkeypatch.setattr(JT, "MAX_STOPS", 4)
    res = JT.join_plan(c.day, c.rec_pricing, t, {0}, "RECOMMENDED", time.monotonic() + 5)
    assert res.outcome == "JOINED" and len(res.plan[0]) == 1


def test_moves_onto_other_trucks_are_reported_not_applied(monkeypatch, plans_as_given):
    """T2's one-stop load fits on T1's load (T2's day cost saved): reported (applied false), the plan unchanged;
    with ACROSS (the owner's later OK) it is applied, T2 leaves the plan, every rule kept."""
    trucks = [truck("T1", cap=100, max_trips=2, **COSTS), truck("T2", cap=100, max_trips=2, **COSTS)]
    r = small_day(trucks=trucks)
    plan = {0: [(S1, S2)], 1: [(S3,)]}
    join = start(monkeypatch, "on")
    sc = stage(r, {"RECOMMENDED": plan}, join)["RECOMMENDED"]
    assert sc.trucks_used == 2 and not notes(sc)
    o = option(join)
    assert o["outcome"] == "NO_SMALL_LOAD" and join.report["status"] == "NONE"
    (mv,) = o["moves"]
    assert (mv["kind"], mv["truck_id"], mv["to_truck_id"], mv["stop_ids"], mv["applied"]) == ("MOVE", "T2", "T1", ["S3"], False)
    assert mv["gain_omr"] >= 20  # T2's day cost
    assert sorted(mv["stops_after"][0]) == ["S1", "S2", "S3"]  # T1's load with S3 on it
    monkeypatch.setattr(JT, "ACROSS", True)
    join = start(monkeypatch, "on")
    sc = stage(r, {"RECOMMENDED": plan}, join)["RECOMMENDED"]
    assert sc.trucks_used == 1 and len(sc.loads) == 1 and served_ids(sc) == {"S1", "S2", "S3"}
    assert option(join)["outcome"] == "JOINED" and option(join)["moves"][0]["applied"] is True
    assert "T2's one-stop load onto T1" in notes(sc)[0]
    assert_plan_rules(r, sc)


def test_min_trucks_option_is_joined_on_its_own_goal(monkeypatch, plans_as_given):
    r = small_day(scenarios=["RECOMMENDED", "MIN_TRUCKS"])
    join = start(monkeypatch, "on")
    out = stage(r, {"RECOMMENDED": TWO_LOADS, "MIN_TRUCKS": TWO_LOADS}, join)
    for name in ("RECOMMENDED", "MIN_TRUCKS"):
        assert out[name].trips == 1 and option(join, name)["outcome"] == "JOINED", name
        assert_plan_rules(r, out[name])


def test_the_same_request_twice_joins_alike(monkeypatch, plans_as_given):
    stops = [stop("N1", 23.70, 58.39, cases=60), stop("N2", 23.71, 58.40, cases=30), stop("S2", 23.46, 58.40, cases=30),
             stop("S1", 23.45, 58.39, cases=60), stop("C", 23.60, 58.45, cases=20)]
    trucks = [truck("T1", cap=100, max_trips=3, **COSTS), truck("T2", cap=100, max_trips=3, **COSTS)]
    r = small_day(stops=stops, trucks=trucks, shift_start_min=hm("06:00"))
    plan = {0: [(0,), (1, 2), (3,)], 1: [(4,)]}
    runs = []
    for _ in range(2):
        join = start(monkeypatch, "report")
        sc = stage(r, {"RECOMMENDED": plan}, join)["RECOMMENDED"]
        o = {k: v for k, v in option(join).items()}
        runs.append((loads_of(sc), o))
    assert runs[0] == runs[1] and runs[0][1]["outcome"] == "WOULD_JOIN"


# --------------------------------------------------------------------------------------
# Notes, the hire check, failures
# --------------------------------------------------------------------------------------

def test_repack_note_numbers_are_the_unjoined_ones(monkeypatch):
    """Critique J2: the load re-check puts T2's load on T1 ("2 -> 1 trucks, 2 -> 2 loads"); the join then makes it
    one load. That note keeps the numbers of the plan before the join, and the join's own note says 2 -> 1 loads:
    nothing is counted twice."""
    trucks = [truck("T1", cap=100, max_trips=2, **COSTS), truck("T2", cap=100, max_trips=2, **COSTS)]
    r = small_day(trucks=trucks)
    join = start(monkeypatch, "on")
    sc = stage(r, {"RECOMMENDED": {0: [(S1, S2)], 1: [(S3,)]}}, join)["RECOMMENDED"]
    assert sc.trucks_used == 1 and sc.trips == 1
    repack = [w for w in sc.warnings if w.startswith("Loads were re-assigned after the route search")]
    assert len(repack) == 1 and "2 -> 1 trucks, 2 -> 2 loads" in repack[0], sc.warnings
    (note,) = notes(sc)
    assert "2 -> 1 loads (back" in note and "In all 2 -> 1 loads" in note
    assert sc.warnings.index(repack[0]) < sc.warnings.index(note)
    assert_plan_rules(r, sc)


def test_priority_repair_after_a_join_keeps_the_note(monkeypatch):
    """SOLVER_PRIORITY_REPAIR on after a join: the repair starts from the joined plan, keeps the join's note (which
    describes the plan before it, as its own note says), and the result is VERIFIED."""
    from tests.test_priority_repair import built as built_as_searched

    stops = [stop("A", 23.585, 58.690, cases=95, priority=1), stop("B", 22.965, 58.390, cases=95, priority=2),
             stop("L3", 23.590, 58.395, cases=40, priority=3), stop("L4", 23.580, 58.385, cases=40, priority=4)]
    trucks = [truck("T1", cap=100, max_trips=2, trip_cost=5), truck("T2", cap=100, max_trips=2, trip_cost=5)]
    r = req(stops, trucks, shift_start_min=hm("07:00"), shift_max_min=300, reload_min=20, loading_min_per_case=0.5)
    monkeypatch.setenv("SOLVER_PARALLEL", "0")
    raw = built_as_searched(r, {0: [(0,), (1,)], 1: [(2,), (3,)]}, exact=False)
    monkeypatch.setattr(ds, "_solve_scenario", lambda name, *a, **kw: raw.model_copy(deep=True))
    monkeypatch.setattr(LR, "repack", lambda *a, **kw: LR.RepackResult(None, "UNKNOWN", 0.0))
    monkeypatch.setattr(LR, "EXTENDED_MAX_SEC", 0)
    monkeypatch.setenv(JT.ENV_MODE, "on")
    joined = rec(optimize_dispatch(r))
    assert ("T2", ("L3", "L4")) in loads_of(joined) and notes(joined)  # the join alone
    monkeypatch.setenv(ds.PRIORITY_REPAIR_ENV, "on")
    resp = optimize_dispatch(r)
    sc = rec(resp)
    assert served_ids(sc) == {"A", "B", "L3", "L4"} and resp.search.join_trips.status == "JOINED"
    (note,) = notes(sc)
    repair = [w for w in sc.warnings if ds.PRIORITY_REPAIR_NOTE in w]
    assert repair and repair[0].endswith(ds.PRIORITY_REPAIR_BEFORE) and sc.warnings.index(note) < sc.warnings.index(repair[0])
    assert_plan_rules(r, sc)


def test_the_hire_check_never_joins(monkeypatch):
    """A what-if with a truck to rent: the step is SKIPPED (HIRE_CHECK) and no solve of it gets ``join`` - neither
    its own nor the hire check's trial solves - so its comparisons stay like for like."""
    monkeypatch.setenv("SOLVER_PARALLEL", "0")
    monkeypatch.setenv(JT.ENV_MODE, "on")
    seen: list = []
    real = ds._run_scenarios
    monkeypatch.setattr(ds, "_run_scenarios", lambda *a, **kw: seen.append(kw.get("join")) or real(*a, **kw))
    monkeypatch.setattr(ds, "_reduce_hire", lambda req_, solvable, mx, drops, lim, end, control, scenarios: (scenarios, None))
    r = small_day(trucks=[truck("T1", cap=100, max_trips=2, **COSTS), truck("H1", cap=100, fixed_cost=40, hire_candidate=True)])
    resp = optimize_dispatch(r)
    assert seen == [None] and resp.search.join_trips.status == "SKIPPED" and resp.search.join_trips.reason == "HIRE_CHECK"
    monkeypatch.setattr(ds, "_run_scenarios", lambda *a, **kw: seen.append(kw.get("join", "none given")) or [])
    assert ds._hire_trial(r, r.stops, matrix_for(r), [], 2, time.monotonic() + 60, None) == (None, False)
    assert seen[-1] == "none given"


def test_nothing_to_plan_and_no_stage_are_skipped(monkeypatch):
    monkeypatch.setenv(JT.ENV_MODE, "report")
    r = small_day(stops=[stop("BIG", 23.62, 58.42, cases=500)])  # more than any truck carries: nothing to plan
    resp = optimize_dispatch(r)
    assert (resp.search.join_trips.status, resp.search.join_trips.reason) == ("SKIPPED", "NOTHING_TO_PLAN")
    join = JT.start()
    JT.finish(join)  # the load re-check never reached the step (the safety net)
    assert (join.report["status"], join.report["reason"]) == ("SKIPPED", "NO_STAGE")


def test_a_joined_plan_that_fails_the_check_is_not_used(monkeypatch, plans_as_given, caplog):
    """A joined timetable that breaks a rule (every unloading 10 min before the truck can be there): NOT_VERIFIED,
    the plan without it, a WARNING line."""
    real = JT.join_plan

    def broken(*a, **kw):
        res = real(*a, **kw)
        res.plan = {i: [LR.TimedLoad(tl.stops, tl.depart_s, tuple(s - 600 for s in tl.starts), tl.return_s, tl.brk)
                        for tl in v] for i, v in res.plan.items()}
        return res

    monkeypatch.setattr(JT, "join_plan", broken)
    r = small_day()
    join = start(monkeypatch, "on")
    sc = stage(r, {"RECOMMENDED": TWO_LOADS}, join)["RECOMMENDED"]
    assert len(sc.loads) == 2 and not notes(sc)
    assert option(join)["outcome"] == "NOT_VERIFIED" and option(join)["verified"] is False
    assert join.report["status"] == "FAILED"
    assert "the joined plan failed the independent check" in caplog.text
    assert_plan_rules(r, sc)


def test_the_whole_joined_plan_is_checked_again(monkeypatch, plans_as_given, caplog):
    """Belt and braces (critique J1): a joined plan that leaves a stop out, or is no better on the option's goal, is
    ERROR and the plan stays; so is an error after the step itself (a plan that cannot even be scored)."""
    r = small_day()
    real = JT.join_plan
    cases = {
        "a stop left out": lambda plan: {0: [plan[0][0]]},
        "no better": lambda plan: {i: list(v) for i, v in plan.items()},
        "cannot be scored": lambda plan: {0: ["not a load"]},
    }
    changed: list = []  # checked here: an assertion inside the step would only be its ERROR
    for why, make in cases.items():
        def fake(day, pricing, plan, trucks, goal, deadline, make=make):
            res = real(day, pricing, plan, trucks, goal, deadline)
            changed.append(res.changed)
            res.plan = make(plan)
            return res

        monkeypatch.setattr(JT, "join_plan", fake)
        join = start(monkeypatch, "on")
        sc = stage(r, {"RECOMMENDED": TWO_LOADS}, join)["RECOMMENDED"]
        assert loads_of(sc) == [("T1", ("S1", "S2")), ("T1", ("S3",))] and not notes(sc), why
        assert option(join)["outcome"] == "ERROR" and join.report["status"] == "FAILED", why
        assert_plan_rules(r, sc)
    assert changed == [True] * 3
    assert "failed the whole-plan check" in caplog.text and "RECOMMENDED failed (" in caplog.text


def _stage_on(r, mx, plans, join):
    """stage() on the matrix ``mx`` (a test may lengthen one of its roads)."""
    c = ds._stage_ctx(r, r.stops, ds._truck_days(r), mx, [])
    results = {n: ds._build_scenario(n, r, r.stops, c.tds, mx, LR.time_plan(c.day, p, c.rec_pricing), c.values, False,
                                     [], solver_status="ROUTING_SUCCESS", elapsed=1.0, time_limit=2, objective_value=0)
               for n, p in plans.items()}
    ds._post_solve(r, r.stops, ds._truck_days(r), mx, 2, [], results, None, time.monotonic() + 60, join=join)
    JT.finish(join)
    return results


def test_each_whole_plan_rule_holds_on_its_own(monkeypatch, plans_as_given):
    """Three rules of the whole-plan check, each catching a joined plan that only it would refuse (ERROR, the plan
    stays): another stop served than the plan's (as much service, cheaper); more km for MIN_DISTANCE (the step run
    for RECOMMENDED's goal, cheaper); a gain under 0.5 OMR (the step's own minimum set aside). The fourth, no more
    money, repeats the step's own rule on each truck (test_money_never_rises)."""
    real = JT.join_plan

    def check(r, mx, plans, fake, name="RECOMMENDED"):
        monkeypatch.setattr(JT, "join_plan", fake)
        join = start(monkeypatch, "on")
        sc = _stage_on(r, mx, plans, join)[name]
        assert option(join, name)["outcome"] == "ERROR" and not notes(sc) and len(sc.loads) == 2, fake.__name__

    # Two loads of 60 cases at most a day: S3 (by the depot) is left out, S2 (20 km away) planned; the "joined" plan
    # carries S3 instead of S2 - as much service, much cheaper.
    r = small_day(stops=[stop("S1", 23.600, 58.420, cases=60), stop("S2", 23.760, 58.420, cases=60),
                         stop("S3", 23.590, 58.410, cases=60)])

    given: list = []  # checked here: an assertion inside the step would only be its ERROR

    def another_stop(day, pricing, plan, trucks, goal, deadline):
        res = real(day, pricing, plan, trucks, goal, deadline)
        given.append((res.changed, {k for tl in plan[0] for k in tl.stops}))
        swapped = LR.time_plan(day, {0: [(S1,), (S3,)]}, pricing)
        res.plan, res.moves = swapped, [JT._move("JOIN", day, day.by_idx[0], (S3,), plan[0], swapped[0], (0, 0, 0), (0, 0, 0))]
        return res

    check(r, matrix_for(r), {"RECOMMENDED": {0: [(S1,), (S2,)]}}, another_stop)
    assert given == [(False, {S1, S2})]
    # S1 to S2 the long way (_long_road_between): joined, 2 km more but one load cheaper.
    r = small_day(stops=three_stops()[:2], reload_min=0, scenarios=["MIN_DISTANCE"])
    mx = matrix_for(r)
    mx.distance_m[1][2] = mx.distance_m[2][1] = mx.distance_m[1][0] + mx.distance_m[0][2] + 2000
    mx.duration_s[1][2] = mx.duration_s[2][1] = mx.duration_s[1][0] + mx.duration_s[0][2] + 900

    def recommended_goal(day, pricing, plan, trucks, goal, deadline):
        return real(day, pricing, plan, trucks, "RECOMMENDED", deadline)

    check(r, mx, {"MIN_DISTANCE": {0: [(S1,), (S2,)]}}, recommended_goal, "MIN_DISTANCE")
    # Two stops by the depot, no day, load or driver cost: joining saves a few metres.
    r = req([stop("S1", 23.586, 58.391, cases=30), stop("S2", 23.587, 58.392, cases=20)],
            [truck("T1", cap=100, max_trips=2, cost_per_km=0.01)], shift_start_min=hm("07:00"), reload_min=0)

    def any_gain(day, pricing, plan, trucks, goal, deadline):
        with monkeypatch.context() as m:
            m.setattr(JT, "MIN_GAIN_UNITS", 0)
            return real(day, pricing, plan, trucks, goal, deadline)

    check(r, matrix_for(r), {"RECOMMENDED": {0: [(S1,), (S2,)]}}, any_gain)


def test_errors_and_time_never_cost_the_plan(monkeypatch, plans_as_given):
    r = small_day()
    real = JT.join_plan
    monkeypatch.setattr(JT, "join_plan", lambda *a, **kw: (_ for _ in ()).throw(RuntimeError("boom")))
    join = start(monkeypatch, "on")
    sc = stage(r, {"RECOMMENDED": TWO_LOADS}, join)["RECOMMENDED"]
    assert len(sc.loads) == 2 and option(join)["outcome"] == "ERROR" and join.report["status"] == "FAILED"
    monkeypatch.setattr(JT, "join_plan", real)
    # No time for the option at all: OUT_OF_TIME, the plan as it was.
    monkeypatch.setattr(JT, "OPTION_SEC", 0.0)
    join = start(monkeypatch, "on")
    sc = stage(r, {"RECOMMENDED": TWO_LOADS}, join)["RECOMMENDED"]
    assert len(sc.loads) == 2 and option(join)["outcome"] == "OUT_OF_TIME"
    monkeypatch.setattr(JT, "OPTION_SEC", 2.0)
    # The solve's total caps every option together: none left for any option.
    monkeypatch.setattr(JT, "TOTAL_SEC", 0.0)
    two = small_day(scenarios=["RECOMMENDED", "MIN_TRUCKS"])
    join = start(monkeypatch, "on")
    out = stage(two, {"RECOMMENDED": TWO_LOADS, "MIN_TRUCKS": TWO_LOADS}, join)
    assert [(option(join, n)["outcome"], len(out[n].loads)) for n in out] == [("OUT_OF_TIME", 2)] * 2
    # Every exact timing slow (0.2 s): the step stops at its cap (0.5 s here) give or take one timing.
    monkeypatch.setattr(JT, "OPTION_SEC", 0.5)
    slow_real = LR.time_truck

    def slow(*a, **kw):
        time.sleep(0.2)
        return slow_real(*a, **kw)

    monkeypatch.setattr(LR, "time_truck", slow)
    c, t = timed_of(r, TWO_LOADS)
    t0 = time.monotonic()
    res = JT.join_plan(c.day, c.rec_pricing, t, {0}, "RECOMMENDED", t0 + 0.5)
    assert time.monotonic() - t0 < 0.5 + 0.45 and res.timings <= 4


def test_the_step_and_the_orders_never_take_each_others_time(monkeypatch, plans_as_given):
    """The solve's seconds for the step start at the first option's step, so the rented and day-paid trucks' orders
    before it (_shorter_orders, up to 3 s a candidate) never use them up; and the step's own seconds are given back
    to the orders' window, so in report mode the next option's orders get the time they have without the step."""
    # Two trucks alike, each option's plan on its own: MIN_TRUCKS keeps its own (a tie), so its orders run after
    # RECOMMENDED's step (the same plan twice would be one candidate, its orders already done).
    r = small_day(scenarios=["RECOMMENDED", "MIN_TRUCKS"],
                  trucks=[truck("T1", cap=100, max_trips=2, **COSTS), truck("T2", cap=100, max_trips=2, **COSTS)])
    plans = {"RECOMMENDED": TWO_LOADS, "MIN_TRUCKS": {1: TWO_LOADS[0]}}
    real_orders, real_join = ds._shorter_orders, JT.join_plan

    def slow_orders(ctx, cand, deadline):
        time.sleep(0.7)
        return real_orders(ctx, cand, deadline)

    monkeypatch.setattr(ds, "_shorter_orders", slow_orders)
    monkeypatch.setattr(JT, "TOTAL_SEC", 0.6)
    join = start(monkeypatch, "report")
    stage(r, plans, join)
    assert option(join, "RECOMMENDED")["outcome"] == "WOULD_JOIN"  # its 0.6 s after 0.7 s or more of orders
    # The step slow (1.2 s) and the orders' window 3 x 0.3 s: the next option's orders still get their time.
    left: list[tuple[bool, float]] = []
    joined: list = []

    def spy_orders(ctx, cand, deadline):
        left.append((bool(joined), deadline - time.monotonic()))
        return real_orders(ctx, cand, deadline)

    def slow_join(*a):
        if not joined:
            time.sleep(1.2)
        joined.append(1)
        return real_join(*a)

    monkeypatch.setattr(ds, "_shorter_orders", spy_orders)
    monkeypatch.setattr(JT, "join_plan", slow_join)
    monkeypatch.setattr(ds, "HIRE_ORDER_SEC", 0.3)
    monkeypatch.setattr(JT, "TOTAL_SEC", 6.0)
    stage(r, plans, start(monkeypatch, "report"))
    after = [s for was_joined, s in left if was_joined]
    assert after and all(s > 0 for s in after), left


def test_the_status_names_any_failure_and_the_log_counts_the_changes():
    """The rollback check reads one field: FAILED whenever an option is NOT_VERIFIED or ERROR, whatever another
    option joined. The log line counts each option's changes by kind - a MOVE reported under NO_SMALL_LOAD too."""
    def run(*outcomes):
        j = JT.Run(mode="report", report=JT.new_report("report"))
        j.report["options"] = [{"option": f"O{i}", "outcome": o, "loads_before": 3, "loads_after": 3, "gain_omr": 0.0,
                                "moves": []} for i, o in enumerate(outcomes)]
        JT.finish(j)
        return j

    for outcomes, status in [(("JOINED", "NOT_VERIFIED"), "FAILED"), (("WOULD_JOIN", "ERROR"), "FAILED"),
                             (("JOINED", "WOULD_JOIN", "NO_SMALL_LOAD"), "JOINED"), (("SLACK", "WOULD_JOIN"), "WOULD_JOIN"),
                             (("NOT_BETTER", "OUT_OF_TIME"), "NONE")]:
        assert run(*outcomes).report["status"] == status, outcomes
    j = run("WOULD_JOIN", "NO_SMALL_LOAD")
    j.report["options"][0].update(loads_after=2, gain_omr=2.5, moves=[{"kind": "JOIN", "applied": False}])
    j.report["options"][1]["moves"] = [{"kind": "MOVE", "applied": False}]
    line = JT.summary(j)
    assert "O0: WOULD_JOIN 3->2 loads, +2.50 OMR, changes JOIN 1 (0 applied)" in line
    assert "O1: NO_SMALL_LOAD 3->3 loads, +0.00 OMR, changes MOVE 1 (0 applied)" in line


def test_the_note_says_as_before_when_the_return_is_unchanged():
    r = small_day()
    c, t = timed_of(r, TWO_LOADS)
    (m,) = JT.join_plan(c.day, c.rec_pricing, t, {0}, "RECOMMENDED", time.monotonic() + 5).moves
    same = dataclasses.replace(m, back_before_s=hm("16:45") * 60, back_after_s=hm("16:45") * 60 + 20)
    assert "T1 2 -> 1 loads (back at 16:45 as before)" in JT.note([same], 2, 1, 410.0, 402.0, False)
    later = dataclasses.replace(m, back_before_s=hm("15:10") * 60, back_after_s=hm("13:40") * 60)
    assert "T1 2 -> 1 loads (back 13:40 instead of 15:10)" in JT.note([later], 2, 1, 410.0, 402.0, False)
    move = dataclasses.replace(same, kind="MOVE", to_truck_id="T2", to_truck_code="T2")
    assert "T1's one-stop load onto T2 (T2 back at 16:45 as before)" in JT.note([move], 2, 1, 410.0, 402.0, False)


def test_report_contract_and_shared_types():
    """The three models validate and round-trip, SearchReport carries join_trips as an optional field, and the
    TypeScript mirror (packages/shared-types) has exactly their fields."""
    rep = JoinTripsReport(mode="on", status="JOINED", min_gain_omr=0.5, slack_min=20, max_stops=3,
                          options=[JoinTripsOption(option="RECOMMENDED", outcome="JOINED", moves=[JoinTripsMove(
                              kind="JOIN", truck_id="T1", stop_ids=["S3"], loads_before=2, loads_after=1, gain_omr=6.3,
                              gain_operating_omr=6.3, gain_km=15.7, applied=True)])])
    assert JoinTripsReport.model_validate_json(rep.model_dump_json()) == rep
    assert SearchReport.model_fields["join_trips"].default is None
    assert JT.report_or_none({"mode": "nonsense"}) is None  # a bad report is dropped, never the plan
    ts = open(os.path.join(SOLVER_DIR, "..", "..", "packages", "shared-types", "src", "dispatch.ts"), encoding="utf-8").read()
    ts = ts.replace("\r\n", "\n")
    for model in (JoinTripsReport, JoinTripsOption, JoinTripsMove):
        block = ts.split(f"export interface {model.__name__} {{", 1)[1].split("\n}", 1)[0]
        assert set(re.findall(r"^\s+(\w+)\??:", block, re.M)) == set(model.model_fields), model.__name__
    assert re.search(r"join_trips\?: JoinTripsReport \| null;", ts)
    # The module loads neither dispatch_solver, PyVRP nor numpy (it runs in the API process).
    src = open(os.path.join(SOLVER_DIR, "join_trips.py"), encoding="utf-8").read()
    assert not re.search(r"^\s*(import|from)\s+(dispatch_solver|pyvrp|numpy)\b", src, re.M)
