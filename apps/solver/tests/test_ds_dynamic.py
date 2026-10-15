"""Decision support, dynamic multi-trip planning (DESIGN.md section 4): the discrete-event day simulator.
A tiny world - one truck, two loads of two stops, a late order at 11:00 - checks that delays push the next
load, that the planner never sees the future, that a departed load is never changed, and that the policies
behave as defined."""
from __future__ import annotations

import json
import math
from types import SimpleNamespace

import pytest

from decision_support import core
from decision_support import dynamic as dyn
from decision_support.dynamic import AT_RETURN, EVENTS, STATIC, NewOrder, Settings, World
from decision_support.history import UncertaintyModel
from decision_support.synth import CUSTOMER_HARD, SALES_PREFERENCE
from tests.test_dispatch import hm, req, stop, truck

# Actual = planned unless a test overrides a multiplier.
FLAT = UncertaintyModel(travel_sigma=0.0, unload_sigma=0.0, assumed=(), basis={})
BUDGET = core.Budget(time_limit_sec=1, seeds=(1,))
WIDE = dict(hard_start_min=hm("07:00"), hard_end_min=hm("21:00"))


def tiny_request():
    """Two clusters of two 45-case stops and one 100-case truck: load 1 serves one cluster, load 2 the other."""
    stops = [stop("A1", 23.620, 58.430, cases=45, priority=2, **WIDE), stop("A2", 23.625, 58.440, cases=45, priority=2, **WIDE),
             stop("B1", 23.550, 58.350, cases=45, priority=2, **WIDE), stop("B2", 23.545, 58.340, cases=45, priority=2, **WIDE)]
    return req(stops, [truck("T1", cap=100, max_trips=3)], shift_start_min=hm("07:30"), reload_min=30,
               latest_return_min=hm("19:00"), time_limit_sec=1)


NEW = NewOrder(stop("N", 23.600, 58.450, cases=10, priority=2, late=True, **WIDE), hm("11:00"))


@pytest.fixture(scope="module")
def solver_env():
    mp = pytest.MonkeyPatch()
    mp.setenv("SOLVER_PARALLEL", "0")
    mp.setenv("SOLVER_PYVRP", "off")
    yield
    mp.undo()


@pytest.fixture(scope="module")
def day(solver_env):
    """The tiny day solved once: the morning plan, then the policies on a world where load 1's first stop
    unloads 4x slower (a 30-min overrun) and a late order arrives at 11:00."""
    r = tiny_request()
    morning = dyn.morning_plan(r, BUDGET)
    loads = sorted(morning.scenario.loads, key=lambda l: l.load_no)
    first = loads[0].stops[0].stop_id
    slow = {f"unload:{first}": 4.0}
    world = World(r, 1, FLAT, [NEW], overrides=slow)
    runs = {p.name: dyn.simulate(world, p, morning, budget=BUDGET) for p in (STATIC, AT_RETURN, EVENTS)}
    # The same world with no late order and a slow stop on load 2: identical until load 2 is on the road.
    last2 = loads[1].stops[-1].stop_id
    other = World(r, 1, FLAT, [], overrides={**slow, f"unload:{last2}": 3.0})
    return dict(request=r, morning=morning, loads=loads, world=world, runs=runs,
                other=dyn.simulate(other, EVENTS, morning, budget=BUDGET),
                again=dyn.simulate(World(r, 1, FLAT, [NEW], overrides=slow), EVENTS, morning, budget=BUDGET))


def by_load(res, load_no):
    return next(ld for ld in res.loads if ld.load_no == load_no)


def test_the_morning_plan_is_two_loads_and_the_forecast_reproduces_its_times(day):
    loads = day["loads"]
    assert [l.load_no for l in loads] == [1, 2] and {len(l.stops) for l in loads} == {2}
    stops = {s.stop_id: s for s in day["request"].stops}
    legs = dyn._Legs(day["request"])
    for pl in dyn._plan_loads(day["morning"].scenario)["T1"]:
        run = dyn._drive(pl, pl.depart_min, stops=stops, legs=legs, rule="START")
        planned = next(l for l in loads if l.load_no == pl.load_no)
        for v, st in zip(run.visits, planned.stops):
            assert abs(v.arrival - st.arrival_min) <= 1 and abs(v.departure - st.departure_min) <= 1
        assert abs(run.ret - planned.return_min) <= 1


def test_a_delay_on_load_1_pushes_load_2_and_the_frozen_return_is_respected(day):
    planned2 = day["loads"][1]
    a = day["runs"]["A"]
    l1, l2 = by_load(a, 1), by_load(a, 2)
    assert l1.ret > day["loads"][0].return_min + 25  # the 30-min overrun
    assert l2.depart >= l1.ret + 30 - 1e-9 and l2.depart > planned2.depart_min
    assert l2.stops == tuple(st.stop_id for st in planned2.stops)  # static: the same load, later
    # B re-plans at the return: the frozen load carries the ACTUAL return; load 2 leaves after it + reload.
    b = day["runs"]["B"]
    rp = b.replans[0]
    assert rp.triggers == (dyn.DEPOT_RETURN,) and rp.at == pytest.approx(by_load(b, 1).ret)
    (frozen,) = rp.request.trucks[0].frozen_trips
    assert frozen.load_no == 1 and frozen.return_min == math.ceil(by_load(b, 1).ret)
    assert rp.request.config.loading_from_min == math.ceil(rp.at)
    assert rp.request.config.shift_start_min == math.ceil(rp.at) + 30
    assert by_load(b, 2).depart >= frozen.return_min + 30


def test_a_delay_is_an_event_only_beyond_the_threshold(day):
    c = day["runs"]["C"]
    delays = [e for e in c.events if e.kind == dyn.DELAY]
    assert len(delays) == 1 and delays[0].load_no == 1 and delays[0].info["slip_min"] > 20
    # The first re-plan of C is that delay, while load 1 is still out: its return is a forecast.
    rp = c.replans[0]
    assert rp.triggers == (dyn.DELAY,) and rp.at < by_load(c, 1).ret
    assert rp.request.trucks[0].frozen_trips[0].return_min == pytest.approx(by_load(c, 1).ret, abs=1)


def test_a_new_order_at_11_is_not_visible_before_11(day):
    assert "N" not in {s.stop_id for s in day["request"].stops}  # the 07:00 plan never had it
    c = day["runs"]["C"]
    reveal = next(e for e in c.events if e.kind == dyn.NEW_ORDER)
    assert (reveal.stop_id, reveal.at) == ("N", hm("11:00"))
    for rp in c.replans:
        sent = {s.stop_id for s in rp.request.stops}
        assert ("N" in sent) == (rp.at >= hm("11:00")), rp.at
        if "N" in sent:
            assert rp.triggers == (dyn.NEW_ORDER,)
    for rp in day["runs"]["B"].replans:
        assert "N" not in {s.stop_id for s in rp.request.stops}
    # Every event the planner saw at a re-plan had happened by then (the events are logged in time order).
    assert [e.at for e in c.events] == sorted(e.at for e in c.events)


def test_the_planner_cannot_read_future_samples(day):
    """A world that differs only after 09:00 (no late order, a slow stop on load 2) gives exactly the same
    re-plan requests up to then: nothing the planner used depended on the future."""
    c, other = day["runs"]["C"], day["other"]
    before = [rp for rp in c.replans if rp.at < hm("11:00")]
    assert len(before) == 2 and len(other.replans) == 2
    for x, y in zip(before, other.replans):
        assert x.at == y.at and x.request.model_dump_json() == y.request.model_dump_json()
    assert by_load(c, 2).depart == by_load(other, 2).depart
    assert by_load(other, 2).ret > by_load(c, 2).ret + 15  # the slow stop shows only once load 2 is out
    assert not hasattr(dyn.PlannerView, "world")


def test_a_departed_load_is_never_changed_by_a_re_plan(day):
    for res in day["runs"].values():
        departed = {(e.truck_id, e.load_no): e for e in res.events if e.kind == dyn.LOAD_DEPARTED}
        for ld in res.loads:
            assert ld.stops == departed[(ld.truck_id, ld.load_no)].info["stops"]
            assert tuple(v.stop_id for v in ld.visits) == ld.stops
        for rp in res.replans:
            sent = {s.stop_id for s in rp.request.stops}
            frozen = {f.load_no: f for f in rp.request.trucks[0].frozen_trips}
            for ld in res.loads:
                if ld.depart <= rp.at:
                    assert not sent & set(ld.stops)
                    assert frozen[ld.load_no].depart_min == math.floor(ld.depart)


def test_policies_differ_only_in_when_they_re_plan(day):
    a, b, c = (day["runs"][k].outcome for k in "ABC")
    assert (a.replans, b.replans, c.replans) == (0, 1, 3)
    assert c.replans >= b.replans
    assert [rp.triggers for rp in day["runs"]["C"].replans] == [(dyn.DELAY,), (dyn.DEPOT_RETURN,), (dyn.NEW_ORDER,)]
    # Only C serves the late order (B's last depot return came before it); nobody is late.
    assert (a.served_new, b.served_new, c.served_new) == (0, 0, 1)
    assert (a.served, c.served, c.stops_total, c.unserved) == (4, 5, 5, 0)
    assert a.late_stops == c.late_stops == 0 and a.unserved_by_priority[2] == 1
    # Policy A never serves an order revealed later, and says so; every morning stop is served by all three.
    assert "never serves an order revealed later" in STATIC.label
    assert (a.served_known, b.served_known, c.served_known) == (4, 4, 4)
    assert c.stops_moved_distinct <= c.stops_moved and c.cash_per_case == pytest.approx(c.cash.total / c.cases_served, abs=1e-4)
    # Cash is the executed day re-costed; C's third load costs its km.
    assert c.cash.total == pytest.approx(sum(getattr(c.cash, k) for k in ("fixed", "trip", "distance", "fuel", "driver", "overtime")), abs=0.002)
    assert c.km > a.km and c.loads == 3 and a.loads == 2


def test_the_simulation_is_deterministic_per_seed(day):
    x, y = day["runs"]["C"], day["again"]
    fx, fy = x.outcome.flat(), y.outcome.flat()
    fx.pop("solver_sec"), fy.pop("solver_sec")  # wall time, the only figure that may differ
    assert fx == fy and x.events == y.events and x.loads == y.loads


def test_world_draws_are_reproducible_and_order_free():
    r = tiny_request()
    model = UncertaintyModel.defaults()
    w1, w2, w3 = World(r, 7, model), World(r, 7, model), World(r, 8, model)
    keys = [("depot", "A1"), ("A1", "A2"), ("A2", "depot")]
    first = [w1._travel(a, b, 500) for a, b in keys]
    assert [w2._travel(a, b, 500) for a, b in reversed(keys)] == first[::-1]
    assert [w3._travel(a, b, 500) for a, b in keys] != first
    assert w1._unload("A1") == w2._unload("A1") != w3._unload("A1")
    shaped = World(r, 7, model, band_factors={b: 2.0 for b, _, _ in dyn.ivms.BANDS})
    assert shaped._travel("depot", "A1", 500) == pytest.approx(min(4.0, 2 * first[0]))
    assert World(r, 7, model, overrides={"travel:depot>A1": 1.5})._travel("depot", "A1", 500) == 1.5
    with pytest.raises(ValueError):
        World(r, 1, model, [NewOrder(r.stops[0], hm("10:00"))])  # a new order cannot repeat a stop


def test_a_late_arrival_is_still_delivered_and_counted(solver_env):
    s = stop("L", 23.620, 58.430, cases=20, hard_start_min=hm("07:00"), hard_end_min=hm("08:00"))
    r = req([s], [truck("T1", cap=100)], shift_start_min=hm("07:30"), reload_min=30, time_limit_sec=1)
    morning = dyn.morning_plan(r, BUDGET)
    planned = morning.scenario.loads[0].stops[0]
    assert planned.arrival_min <= hm("08:00")
    world = World(r, 1, FLAT, overrides={"travel:depot>L": 4.0})
    out = dyn.simulate(world, STATIC, morning).outcome
    assert (out.served, out.late_stops) == (1, 1) and out.late_min > 0
    assert out.replans == 0
    # Late is against the genuine closing time: a SALES_PREFERENCE window missed inside the customer's genuine
    # hours is a missed preference, not a late stop; a CUSTOMER_HARD one is late.
    labels = {"window_provenance": {"L": SALES_PREFERENCE}, "genuine_hours": {"L": (hm("07:00"), hm("12:00"))}}
    pref = dyn.simulate(World(r, 1, FLAT, overrides={"travel:depot>L": 4.0}, **labels), STATIC, morning).outcome
    assert (pref.late_stops, pref.late_min, pref.pref_late_stops) == (0, 0.0, 1)
    hard = World(r, 1, FLAT, overrides={"travel:depot>L": 4.0}, window_provenance={"L": CUSTOMER_HARD})
    assert dyn.simulate(hard, STATIC, morning).outcome.late_stops == 1
    assert hard.closing_min(s) == hm("08:00") and World(r, 1, FLAT, **labels).closing_min(s) == hm("12:00")


def test_a_road_break_is_replayed_as_the_engine_times_it(solver_env):
    """The engine drives first and rests at the customer while it waits for the window (a ROAD break that starts
    after the truck has arrived): with actual = planned times the replay reproduces the plan, on time."""
    s1 = stop("S1", 23.585, 58.81, cases=20, hard_start_min=hm("13:00"), hard_end_min=hm("13:20"))
    s2 = stop("S2", 23.585, 58.91, cases=20, hard_start_min=hm("15:00"), hard_end_min=hm("15:10"))
    r = req([s1, s2], [truck("T1", cap=500)], shift_start_min=hm("07:30"), shift_max_min=690,
            latest_return_min=hm("19:00"), reload_min=30, break_min=60, break_start_from_min=hm("14:00"),
            break_start_to_min=hm("15:00"), time_limit_sec=1)
    morning = dyn.morning_plan(r, BUDGET)
    (load,) = morning.scenario.loads
    (pl,) = dyn._plan_loads(morning.scenario)["T1"]
    assert pl.brk is not None and pl.brk.where == "ROAD" and len(load.stops) == 2
    run = dyn._drive(pl, pl.depart_min, stops={s.stop_id: s for s in r.stops}, legs=dyn._Legs(r), rule="START")
    for v, st in zip(run.visits, load.stops):
        assert abs(v.arrival - st.arrival_min) <= 1 and abs(v.service_start - st.service_start_min) <= 1
    assert abs(run.ret - load.return_min) <= 1 and abs(run.break_start - pl.brk.start) <= 1
    # Played out with actual = planned: nothing late (a stop planned at its closing minute is not late by the
    # plan's own rounding), the break kept.
    out = dyn.simulate(World(r, 1, FLAT), STATIC, morning).outcome
    assert (out.served, out.late_stops, out.late_breaks, out.missing_breaks) == (2, 0, 0, 0)


def test_a_re_plan_with_nothing_to_plan_is_counted_as_skipped(day):
    def nothing(_req):
        sc = SimpleNamespace(name="RECOMMENDED", status="NOTHING_TO_PLAN", feasibility=None, loads=[])
        return SimpleNamespace(wall_sec=0.0, response=SimpleNamespace(scenarios=[sc]))

    out = dyn.simulate(World(day["request"], 1, FLAT), AT_RETURN, day["morning"], solver=nothing).outcome
    assert (out.replans, out.replans_skipped, out.stops_moved, out.stops_moved_distinct) == (0, 1, 0, 0)


def test_the_executed_day_keeps_the_driver_break_rule():
    cfg = tiny_request().config.model_copy(update=dict(break_min=60, break_start_from_min=hm("14:00"),
                                                       break_start_to_min=hm("15:00")))
    day_ = [(hm("07:30"), hm("16:40"))]
    assert dyn._break_kept(cfg, [(hm("07:30"), hm("14:50"))], [None]) == "NOT_NEEDED"  # back by 15:00
    assert dyn._break_kept(cfg, [(hm("14:10"), hm("18:00"))], [None]) == "NOT_NEEDED"  # starts in the window
    assert dyn._break_kept(cfg, day_, [hm("14:10")]) == "OK"
    assert dyn._break_kept(cfg, day_, [hm("15:20")]) == "LATE"
    assert dyn._break_kept(cfg, day_, [None]) == "MISSING"
    two = [(hm("07:30"), hm("14:05")), (hm("15:30"), hm("18:00"))]
    assert dyn._break_kept(cfg, two, [None, None]) == "OK"  # held at the depot between the loads
    assert dyn._break_kept(cfg, [(hm("07:30"), hm("14:30")), (hm("15:00"), hm("18:00"))], [None, None]) == "MISSING"
    assert dyn._break_kept(tiny_request().config, day_, [None]) == "NOT_NEEDED"  # no break rule


def test_synthetic_case_holds_back_servable_late_orders():
    known, new = dyn.synthetic_case(120, 3, n_new=5, reveal=(hm("09:00"), hm("12:00")))
    ids = {s.stop_id for s in known.stops}
    assert len(new) == 5 and not ids & {o.stop.stop_id for o in new}
    assert [o.reveal_min for o in new] == sorted(o.reveal_min for o in new)
    for o in new:
        assert hm("09:00") <= o.reveal_min <= hm("12:00") and o.stop.late
        assert o.stop.hard_end_min is None or o.stop.hard_end_min >= hm("14:00")
    again = dyn.synthetic_case(120, 3, n_new=5, reveal=(hm("09:00"), hm("12:00")))
    assert again[1] == new and core.digest(again[0]) == core.digest(known)


def test_ivms_band_factors_shape_the_day_around_one():
    f = dyn.ivms_band_factors()
    assert f is not None and set(f) == {b for b, _, _ in dyn.ivms.BANDS}
    bands = dyn.ivms.load()["ivms_raw"]["travel_speed_kmh"]["by_region_band"]["Muscat"]
    n = sum(p["n"] for p in bands.values())
    assert sum(p["n"] * math.log(f[b]) for b, p in bands.items()) / n == pytest.approx(0.0, abs=0.01)
    assert f["12-15"] > 1.0 > f["06-09"]  # midday is slower than early morning in Muscat
    assert dyn._band(hm("07:30")) == "06-09" and dyn._band(hm("23:00")) == "22-06"


def test_the_committed_smoke_report_is_synthetic_and_prints_as_a_table():
    path = dyn.ivms.DEFAULT_OUT.parent / "dynamic_smoke.json"
    report = json.loads(path.read_text(encoding="utf-8"))
    assert report["day"]["label"] == "SYNTHETIC" and set(report["summary"]) == {"A", "B", "C"}
    assert "syn-" not in path.read_text(encoding="utf-8")  # no stop ids, only figures
    text = dyn.format_report(report)
    assert "stops served" in text and "missing breaks" in text and text.count("\n") >= len(dyn._ROWS) + 3


def test_data_requirements_separate_what_exists_from_what_is_missing():
    needs = {n.item: n for n in dyn.data_requirements()}
    assert all(n.kind in ("EVENT", "DATA", "INTEGRATION") and n.exists in ("YES", "PARTIAL", "NO") for n in needs.values())
    assert needs["Stop arrival / departure / outcome taps"].exists == "YES"
    assert "StopVisit" in needs["Stop arrival / departure / outcome taps"].where
    assert needs["Live truck position (Ayun / IVMS GPS feed)"].exists == "NO"
    assert needs["Onboard stock (what a truck still carries)"].exists == "PARTIAL"
    assert needs["Stock availability at the depot"].exists == "NO"
    assert needs["Per-stop locks"].exists == "NO"
