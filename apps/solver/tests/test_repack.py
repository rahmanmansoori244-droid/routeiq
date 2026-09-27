"""Strict priorities, the post-solve load repack (load_repack), exact loading/turnaround time,
the warm start and honest unserved reasons.

Haversine only (no network). Tests that monkeypatch the engine run in-process
(SOLVER_PARALLEL=0): a spawned worker would not see the patch.
"""
from __future__ import annotations

import logging
import math
import random
import time

import pytest

import dispatch_solver as ds
import load_repack as LR
from dispatch_models import DispatchConfig, FrozenTrip
from providers import resolve_matrix
from tests.test_dispatch import assert_reconciled, hm, nmwc_day, rec, req, served_ids, stop, truck, unserved_map
from dispatch_solver import optimize_dispatch

ALL = ["RECOMMENDED", "MIN_TRUCKS", "MIN_DISTANCE"]


def matrix_for(r):
    c = r.config
    return resolve_matrix([(r.depot.lat, r.depot.lng)] + [(s.lat, s.lng) for s in r.stops], provider="HAVERSINE",
                          osrm_url=None, haversine_multiplier=c.haversine_multiplier, avg_speed_kmh=c.avg_speed_kmh,
                          road_time_factor=c.road_time_factor)


def by_truck(sc) -> dict[str, list]:
    out: dict[str, list] = {}
    for ld in sc.loads:
        out.setdefault(ld.truck_id, []).append(ld)
    for v in out.values():
        v.sort(key=lambda l: l.load_no)
    return out


def assert_plan_rules(r, sc) -> None:
    """Hard windows, capacity, no overlapping loads, exact turnaround, frozen loads, shift."""
    cfg = r.config
    trucks = {t.id: t for t in r.trucks}
    stops = {s.stop_id: s for s in r.stops}
    for tid, lds in by_truck(sc).items():
        t = trucks[tid]
        frozen = sorted(t.frozen_trips, key=lambda f: f.load_no)
        assert [l.load_no for l in lds] == list(range(len(frozen) + 1, len(frozen) + len(lds) + 1))
        if frozen:
            assert lds[0].depart_min >= max(f.return_min for f in frozen) + cfg.reload_min + cfg.loading_min_per_case * lds[0].cases - 1
        else:
            assert lds[0].depart_min >= cfg.shift_start_min
            assert lds[-1].return_min - lds[0].depart_min <= cfg.shift_max_min
        if cfg.loading_from_min is not None:  # a plan made on its delivery day: loading starts then
            for ld in lds:
                assert ld.depart_min >= cfg.loading_from_min + cfg.reload_min + cfg.loading_min_per_case * ld.cases - 1, ld
        for a, b in zip(lds, lds[1:]):
            assert b.depart_min >= a.return_min + cfg.reload_min + cfg.loading_min_per_case * b.cases - 1, (a, b)
        for ld in lds:
            assert ld.cases <= t.capacity_cases
            assert ld.return_min >= ld.depart_min
            for st in ld.stops:
                s = stops[st.stop_id]
                assert st.hard_window_ok
                assert (s.hard_start_min or 0) <= st.service_start_min <= (s.hard_end_min or 10**6)
                # The plan screen shows departure - start as the unloading time: exactly what was sent.
                assert st.departure_min - st.service_start_min == s.service_min, st
                assert st.wait_min == st.service_start_min - st.arrival_min
    assert_reconciled(r, sc)
    # The engine's own independent check (feasibility.py) must agree with these rules.
    assert sc.feasibility is not None and sc.feasibility.status == "VERIFIED", sc.feasibility


def spy_raw(monkeypatch) -> dict:
    """Copies of the route searches' own plans, taken just before the post-solve stage replaces
    them (in-process runs only: a spawned worker would not see the patch)."""
    raw: dict = {}
    orig = ds._post_solve

    def spy(*a):
        raw.update({n: sc.model_copy(deep=True) for n, sc in a[6].items()})
        return orig(*a)

    monkeypatch.setattr(ds, "_post_solve", spy)
    return raw


# --------------------------------------------------------------------------------------
# STRICT PRIORITIES
# --------------------------------------------------------------------------------------

def p2_vs_eleven_p3(**cfg):
    """One 110-case load: a P2 of 105 cases or eleven P3 of 10 cases (the bench probe)."""
    rnd = random.Random(5)
    stops = [stop("BIG_P2", 23.60, 58.45, cases=105, priority=2, service_min=20)]
    stops += [stop(f"P3_{i:02d}", 23.55 + rnd.random() * 0.08, 58.35 + rnd.random() * 0.12, cases=10, priority=3)
              for i in range(11)]
    return req(stops, [truck("T1", cap=110, fixed_cost=25, cost_per_km=0.12, max_trips=1)], **cfg)


def test_strict_priority_one_p2_beats_eleven_p3():
    r = p2_vs_eleven_p3(scenarios=ALL, fuel_price_per_litre=0.26, driver_cost_per_hour=2.5)
    resp = optimize_dispatch(r)
    for sc in resp.scenarios:
        assert served_ids(sc) == {"BIG_P2"}, sc.name
        assert len(sc.unserved) == 11
        assert_reconciled(r, sc)


def test_strict_values_of_the_probe():
    r = p2_vs_eleven_p3()
    strict, _ = ds._service_values(r.stops, r.config, use_margin=False)
    assert strict[0] > sum(strict[1:])  # one P2 > eleven P3
    weighted, _ = ds._service_values(r.stops, r.config.model_copy(update={"strict_priorities": False}), use_margin=False)
    assert weighted[0] < sum(weighted[1:])  # 1,000 < 11 x 100: the old scheme would drop the P2


@pytest.mark.parametrize("strict", [True, False])
def test_strict_ladder_under_shortage_drops_p5_first(strict):
    # Room for 60 cases: one P4 of 60 vs eleven small P5. Strict: the P4, and the P5s are left
    # out first. The weighted scheme (still available) serves the eleven P5 (11 x 1 > 10).
    stops = [stop("P4", 23.60, 58.45, cases=60, priority=4)]
    stops += [stop(f"P5_{i:02d}", 23.62 + i * 0.003, 58.40, cases=5, priority=5) for i in range(11)]
    sc = rec(optimize_dispatch(req(stops[::-1], [truck("T01", cap=60, max_trips=1)], strict_priorities=strict)))
    if strict:
        assert served_ids(sc) == {"P4"}
        assert all("shortage" in u.reason_message.lower() for u in sc.unserved)
    else:
        assert "P4" not in served_ids(sc) and len(served_ids(sc)) == 11
    assert_reconciled(r=req(stops, [truck("T01", cap=60, max_trips=1)]), sc=sc)


def test_strict_weights_formula():
    assert ds._strict_weights({2: 1, 3: 11}) == {5: 1, 4: 1, 3: 1, 2: 12, 1: 24}
    w = ds._strict_weights({1: 2, 2: 3, 3: 4, 4: 5, 5: 6})
    assert w[4] == 1 + 6 and w[3] == 1 + 5 * 7 + 6 and w[1] == 1 + 3 * w[2] + 4 * w[3] + 5 * w[4] + 6
    # With margins every lower stop counts one unit more (its margin bonus is < 0.4 unit).
    wm = ds._strict_weights({3: 1, 4: 10}, with_margin=True)
    assert wm[3] == 1 + 10 * (1 + 1)


def test_strict_values_dominate_and_fit_int64():
    cfg = DispatchConfig()
    stops = [stop(f"S{i}", 23.6, 58.4, priority=1 + i % 5, margin=50.0) for i in range(400)]
    values, warnings = ds._service_values(stops, cfg, use_margin=True)
    assert not warnings
    assert sum(values) < ds.PENALTY_LIMIT
    for p in range(1, 5):
        one = min(v for s, v in zip(stops, values) if s.priority == p)
        lower = sum(v for s, v in zip(stops, values) if s.priority > p)
        assert one > lower, p
    assert min(values) >= ds.SERVICE_BASE  # a P5 stop is still worth 1,000 OMR


def test_strict_values_overflow_guard_scales_then_caps():
    cfg = DispatchConfig()
    big = [stop(f"S{i}", 23.6, 58.4, priority=1 + i % 5) for i in range(2500)]
    values, warnings = ds._service_values(big, cfg, use_margin=False)
    assert sum(values) < ds.PENALTY_LIMIT
    by_p = {p: max(v for s, v in zip(big, values) if s.priority == p) for p in range(1, 6)}
    assert by_p[1] > by_p[2] > by_p[3] > by_p[4] > by_p[5] > 0
    assert warnings and "strictly" in warnings[0]


def test_inverted_weights_still_rejected_with_strict_on():
    with pytest.raises(Exception):
        DispatchConfig(strict_priorities=True, priority_weights={1: 1, 2: 10, 3: 100, 4: 1000, 5: 10000})


def test_drop_penalties_follow_the_scenario_cost_multipliers():
    vals = [ds.SERVICE_BASE, 3 * ds.SERVICE_BASE]
    assert ds._drop_penalties(vals, ds.SCENARIOS["RECOMMENDED"]) == vals
    assert ds._drop_penalties(vals, ds.SCENARIOS["MIN_TRUCKS"]) == [20 * v for v in vals]  # fixed cost x20
    assert ds._drop_penalties(vals, ds.SCENARIOS["MIN_DISTANCE"]) == vals  # metres: a unit outweighs any day
    huge = [ds.PENALTY_LIMIT // 4] * 2
    assert sum(ds._drop_penalties(huge, ds.SCENARIOS["MIN_TRUCKS"])) <= ds.PENALTY_LIMIT


def test_min_trucks_search_never_drops_a_stop_to_save_a_truck(monkeypatch):
    """A P5 stop is worth 1,000 OMR; MIN_TRUCKS prices a truck at 20 x its fixed cost, so at 60 OMR
    per truck its search dropped the stop that needed a second truck (1,200 > 1,000). The drop
    penalties scale with the scenario's cost multipliers, so no search plan leaves it out, and
    neither does the fallback when the post-solve stage fails."""
    monkeypatch.setenv("SOLVER_PARALLEL", "0")
    a = stop("A", 23.60, 58.45, cases=90, priority=3)
    b = stop("B", 23.62, 58.47, cases=90, priority=5)
    trucks = [truck(f"T0{i}", cap=100, fixed_cost=60, cost_per_km=0.15, max_trips=1) for i in (1, 2)]
    r = req([a, b], trucks, scenarios=ALL)
    raw = spy_raw(monkeypatch)
    resp = optimize_dispatch(r)
    assert set(raw) == set(ALL)
    for name, sc in raw.items():
        assert served_ids(sc) == {"A", "B"}, name
    monkeypatch.setenv("ROUTEIQ_TEST_FAIL_REPACK", "1")
    resp = optimize_dispatch(r)
    for sc in resp.scenarios:
        assert served_ids(sc) == {"A", "B"}, sc.name
        assert_reconciled(r, sc)


def test_margin_tie_break_still_tells_large_margins_apart():
    """Strict mode caps the margin bonus below 0.4 of a 1,000 OMR unit. A linear bonus hit that
    cap at 40 OMR of margin, so a 300 OMR and a 50 OMR order tied and km decided."""
    lo = stop("LO", 23.60, 58.45, cases=80, priority=3, margin=50.0)
    hi = stop("HI", 23.64, 58.49, cases=80, priority=3, margin=300.0)  # further out: more km
    r = req([lo, hi], [truck("T01", cap=100, max_trips=1, cost_per_km=0.5)])
    sc = rec(optimize_dispatch(r))
    assert served_ids(sc) == {"HI"}
    assert sc.objective.margin_served == pytest.approx(300.0)
    cap = int(ds.SERVICE_BASE * 0.4)
    bonus = [ds._margin_bonus(m, cap) for m in (1, 40, 50, 300, 4000, 4001, 1e6)]
    assert bonus == sorted(bonus) and len(set(bonus)) == len(bonus) and bonus[-1] < cap
    # Small margins still count 10x operating cost, as in the weighted scheme.
    assert bonus[0] == pytest.approx(ds.COST_SCALE * ds.MARGIN_WEIGHT, rel=0.03)


# --------------------------------------------------------------------------------------
# LOAD REPACK
# --------------------------------------------------------------------------------------

def half_load_day(seed: int = 2, n: int = 36, frozen: bool = False):
    """Loads of two stops (45 cases each, 100-case trucks): 18 loads, 3 per truck at most, so 6
    trucks is the minimum. The route search typically spreads them over 7-8 trucks: it cannot move
    a whole load (two stops + a reload visit) onto another truck."""
    rnd = random.Random(seed)
    stops = []
    for i in range(n):
        kw = {}
        if i % 6 == 0:  # some morning receivers
            kw = dict(hard_start_min=hm("07:00"), hard_end_min=hm("12:00"))
        stops.append(stop(f"S{i:02d}", 23.585 + rnd.uniform(-0.2, 0.2), 58.39 + rnd.uniform(-0.2, 0.2), cases=45, **kw))
    trucks = [truck(f"T{i:02d}", cap=100, fixed_cost=30, cost_per_km=0.1) for i in range(1, 13)]
    if frozen:
        trucks[0] = truck("T01", cap=100, fixed_cost=30, cost_per_km=0.1,
                          frozen_trips=[FrozenTrip(load_no=1, depart_min=hm("06:00"), return_min=hm("08:10"), cases=90)])
    return stops, trucks


@pytest.mark.parametrize("frozen", [False, True])
def test_repack_reduces_trucks_on_a_day_the_search_spreads_out(frozen, monkeypatch):
    stops, trucks = half_load_day(frozen=frozen)
    r = req(stops, trucks, time_limit_sec=2, scenarios=ALL, driver_cost_per_hour=2.0)
    # In-process, to see the search's own plans before the post-solve stage replaces them.
    monkeypatch.setenv("SOLVER_PARALLEL", "0")
    raw = spy_raw(monkeypatch)
    resp = optimize_dispatch(r)
    by = {s.name: s for s in resp.scenarios}
    new = by["RECOMMENDED"]
    assert served_ids(new) == {s.stop_id for s in stops}
    # Never worse than the search's own plans, on their own goals.
    assert new.trucks_used <= raw["RECOMMENDED"].trucks_used
    assert new.operating_cost <= raw["RECOMMENDED"].operating_cost + 0.01
    assert by["MIN_TRUCKS"].trucks_used <= min(new.trucks_used, raw["MIN_TRUCKS"].trucks_used)
    assert by["MIN_DISTANCE"].total_distance_km <= min(new.total_distance_km, raw["MIN_DISTANCE"].total_distance_km) + 0.01
    if not frozen:
        # 18 two-stop loads, at most 3 per truck: 6 trucks is the floor, and the repack reaches it
        # (the search alone typically ends on 7-8 trucks at this limit).
        assert new.trips == 18
        assert new.trucks_used == 6, [(l.truck_id, l.load_no) for l in new.loads]
        if raw["RECOMMENDED"].trucks_used > 6:
            assert new.operating_cost < raw["RECOMMENDED"].operating_cost
            assert any("re-assigned" in w for w in new.warnings)
    for sc in resp.scenarios:
        assert_plan_rules(r, sc)


def _day_for(r):
    tds = ds._truck_days(r)
    mx = matrix_for(r)
    values, _ = ds._service_values(r.stops, r.config, False)
    day = LR.Day(stops=r.stops, trucks=[t for t in tds if t.usable], D=mx.distance_m, T=mx.duration_s,
                 shift_max_s=r.config.shift_max_min * 60, reload_s=r.config.reload_min * 60,
                 loading_s_per_case=r.config.loading_min_per_case * 60, values=values)
    return day, tds


def test_repack_is_exact_on_one_load_per_truck():
    # Six full loads on six trucks; three loads fit a truck day: the repack needs 2 trucks.
    stops = [stop(f"S{i}", 23.585 + 0.12 * math.sin(i), 58.39 + 0.12 * math.cos(i), cases=100) for i in range(6)]
    r = req(stops, [truck(f"T{i}", cap=100, fixed_cost=30, cost_per_km=0.1) for i in range(6)], driver_cost_per_hour=2.0)
    day, tds = _day_for(r)
    pricing = ds._pricing("RECOMMENDED", r, tds, r.stops)
    spread = {i: [(i,)] for i in range(6)}
    timed = LR.time_plan(day, spread, pricing)
    res = LR.repack(day, pricing, [(i,) for i in range(6)], set(range(6)), {}, timed, time_limit=10)
    assert res.plan is not None and res.status.startswith("OPTIMAL")
    assert len(res.plan) == 2 and sorted(len(v) for v in res.plan.values()) == [3, 3]
    repacked = LR.time_plan(day, res.plan, pricing)
    assert LR.score(day, pricing, repacked).cost < LR.score(day, pricing, timed).cost


def test_repack_picks_up_a_stop_the_search_left_out():
    """Drop repair: a stop left out (no shortage) is offered as an optional one-stop load; a free
    trip carries it, and every returned plan is checked again."""
    a = stop("A", 23.60, 58.45, cases=90)
    b = stop("B", 23.62, 58.47, cases=90, priority=5)
    r = req([a, b], [truck("T01", cap=100)], scenarios=["RECOMMENDED"])
    day, tds = _day_for(r)
    mx = matrix_for(r)
    values = day.values
    # A raw plan that carries A only (as a time-limited search might return it).
    pricing = ds._pricing("RECOMMENDED", r, tds, r.stops)
    timed = LR.time_plan(day, {0: [(0,)]}, pricing)
    raw = ds._build_scenario("RECOMMENDED", r, r.stops, tds, mx, timed, values, False, [], solver_status="ROUTING_SUCCESS",
                             elapsed=1.0, time_limit=2, objective_value=0)
    assert unserved_map(raw) == {"B": "SOLVER_DROPPED_LOW_PRIORITY"}
    results = {"RECOMMENDED": raw}
    ds._post_solve(r, r.stops, tds, mx, 2, [], results, None, time.monotonic() + 120)
    sc = results["RECOMMENDED"]
    assert served_ids(sc) == {"A", "B"}
    assert [l.load_no for l in sc.loads] == [1, 2]
    # The note says why a load (and cost) was added: an order the search had left out.
    assert any("this also plans 1 stop(s) the route search had left out" in w for w in sc.warnings), sc.warnings
    assert not any("could not be placed" in w for w in sc.warnings)
    assert_plan_rules(r, sc)


def test_drop_repair_also_runs_on_fleet_shortage_days():
    """310 cases for 300 of capacity (1 truck x 3 loads): only 10 cases are really short. A search
    plan carrying one load leaves 220 cases out; the stage fills the free loads (strict priority
    value first), and only what is left carries the shortage reason."""
    stops = [stop("A", 23.60, 58.45, cases=90), stop("B", 23.62, 58.47, cases=90, priority=5),
             stop("C", 23.58, 58.43, cases=90, priority=5), stop("D", 23.61, 58.44, cases=40, priority=5)]
    r = req(stops, [truck("T01", cap=100, fixed_cost=25, cost_per_km=0.1, max_trips=3)])
    day, tds = _day_for(r)
    mx = matrix_for(r)
    pricing = ds._pricing("RECOMMENDED", r, tds, r.stops)
    raw = ds._build_scenario("RECOMMENDED", r, r.stops, tds, mx, LR.time_plan(day, {0: [(0,)]}, pricing), day.values,
                             False, [], solver_status="ROUTING_SUCCESS", elapsed=1.0, time_limit=2, objective_value=0)
    # 220 unserved cases against a 10-case shortage: the plan says the shortage does not explain it.
    assert any("10 cases short today, but 220 cases are unserved" in w for w in raw.warnings), raw.warnings
    results = {"RECOMMENDED": raw}
    ds._post_solve(r, r.stops, tds, mx, 2, [], results, None, time.monotonic() + 120)
    sc = results["RECOMMENDED"]
    assert len(sc.loads) == 3 and sum(l.cases for l in sc.loads) == 220
    assert len(sc.unserved) == 1 and "shortage" in sc.unserved[0].reason_message.lower()
    assert not any("cases short today" in w for w in sc.warnings)
    assert any("this also plans 2 stop(s)" in w for w in sc.warnings), sc.warnings
    assert_plan_rules(r, sc)


def _kg_day(n_stops: int, n_trucks: int):
    """n_trucks x 1 load of 150 cases / 1,500 kg; stops of 30 cases / 336 kg near the depot."""
    stops = [stop(f"S{i:02d}", 23.60 + (i % 6) * 0.002, 58.45 + (i // 6) * 0.002, cases=30, demand_kg=336)
             for i in range(n_stops)]
    return req(stops, [truck(f"T{k}", cap=150, capacity_kg=1500, max_trips=1) for k in range(n_trucks)])


def _raw_scenario(r, plan):
    day, tds = _day_for(r)
    timed = LR.time_plan(day, plan, ds._pricing("RECOMMENDED", r, tds, r.stops))
    assert timed is not None
    return ds._build_scenario("RECOMMENDED", r, r.stops, tds, matrix_for(r), timed, day.values, False, [],
                              solver_status="ROUTING_SUCCESS", elapsed=1.0, time_limit=2, objective_value=0)


def test_shortage_warning_counts_the_room_left_on_every_load():
    """PR6 review: 6 loads of 4 stops (1,344 of 1,500 kg): 156 kg of room on each, 936 kg in all,
    and every unserved stop is 336 kg. The 12 unserved stops (4,032 kg) are more than "short +
    one order" (3,096 + 336 kg), but none fits anywhere: the shortage explains them, no warning."""
    r = _kg_day(36, 6)
    sc = _raw_scenario(r, {k: [tuple(range(4 * k, 4 * k + 4))] for k in range(6)})
    assert len(sc.unserved) == 12
    assert all("weight is the tighter limit" in u.reason_message for u in sc.unserved)
    assert not any("short today" in w for w in sc.warnings), sc.warnings


def test_shortage_warning_stays_when_an_unserved_stop_fits_a_load():
    """The same day with one load carrying 3 stops (492 kg of room): an unserved stop fits it, so
    the shortage does not explain everything and the plan says so (a re-plan can serve more)."""
    r = _kg_day(36, 6)
    plan = {k: [tuple(range(4 * k, 4 * k + 4))] for k in range(5)}
    plan[5] = [(20, 21, 22)]
    sc = _raw_scenario(r, plan)
    assert len(sc.unserved) == 13
    assert any("180 cases and 3,096 kg short today, but 390 cases (4,368 kg) are unserved" in w for w in sc.warnings), sc.warnings
    # A truck that did not load at all: its whole load is room, so the warning stays too.
    sc = _raw_scenario(r, {k: [tuple(range(4 * k, 4 * k + 4))] for k in range(5)})
    assert any("more than the shortage alone explains" in w for w in sc.warnings), sc.warnings


def test_repack_failure_falls_back_to_the_search_plan(monkeypatch):
    monkeypatch.setenv("SOLVER_PARALLEL", "0")
    stops, trucks = half_load_day(n=24)
    r = req(stops, trucks, time_limit_sec=2, scenarios=["RECOMMENDED", "MIN_TRUCKS"])

    def boom(*a, **kw):
        raise RuntimeError("CP-SAT failed")

    monkeypatch.setattr(LR, "_solve_until_stalled", boom)
    stage: list = []
    orig = LR.build_candidates
    monkeypatch.setattr(LR, "build_candidates", lambda **kw: stage.append(orig(**kw)) or stage[-1])
    resp = optimize_dispatch(r)
    # One failed CP-SAT solve only loses that candidate: both stage jobs still ran, and the
    # RECOMMENDED job re-timed the search plans exactly (they are its candidates).
    assert len(stage) == 2
    assert all(any("repack failed" in n for n in notes) for _, notes in stage)
    assert stage[0][0] and all("+" not in c.source for c in stage[0][0])
    for sc in resp.scenarios:
        assert sc.status == "OPTIMIZED"
        assert not any("re-assigned" in w or "not re-checked" in w for w in sc.warnings), sc.warnings
        assert_plan_rules(r, sc)
    # The whole stage failing: the search's plans, with a note.
    monkeypatch.setenv("ROUTEIQ_TEST_FAIL_REPACK", "1")
    resp = optimize_dispatch(r)
    assert all(any("not re-checked" in w for w in sc.warnings) for sc in resp.scenarios)
    for sc in resp.scenarios:
        assert_reconciled(r, sc)


def test_stuck_repack_worker_is_abandoned_in_time(monkeypatch):
    monkeypatch.delenv("SOLVER_PARALLEL", raising=False)
    monkeypatch.setenv("ROUTEIQ_TEST_HANG_REPACK", "1")
    monkeypatch.setattr(ds, "STAGE_GRACE_SEC", 2)
    stops, trucks = half_load_day(n=12)
    r = req(stops, trucks, time_limit_sec=2, scenarios=["RECOMMENDED"])
    t0 = time.perf_counter()
    sc = rec(optimize_dispatch(r))
    assert time.perf_counter() - t0 < 40
    assert any("not re-checked" in w for w in sc.warnings)
    assert_reconciled(r, sc)


def test_hung_alternative_does_not_starve_the_load_recheck(monkeypatch):
    """A skipped alternative keeps running in its worker (a stuck OR-Tools call does not stop on
    request). With one worker for [RECOMMENDED, MIN_TRUCKS] the stage queued behind it, timed out,
    and RECOMMENDED lost its load re-check. The stage now gets fresh workers."""
    monkeypatch.delenv("SOLVER_PARALLEL", raising=False)
    monkeypatch.setenv("ROUTEIQ_TEST_HANG_SCENARIO", "MIN_TRUCKS")
    monkeypatch.setenv("SOLVER_ALT_GRACE_SEC", "3")
    stops, trucks = half_load_day(n=24)
    r = req(stops, trucks, time_limit_sec=2, scenarios=["RECOMMENDED", "MIN_TRUCKS"])
    t0 = time.perf_counter()
    resp = optimize_dispatch(r)
    assert time.perf_counter() - t0 < 45
    assert [s.name for s in resp.scenarios] == ["RECOMMENDED"]
    sc = rec(resp)
    assert any("MIN_TRUCKS" in w and "skipped" in w for w in sc.warnings)
    assert not any("not re-checked" in w for w in sc.warnings), sc.warnings
    assert_plan_rules(r, sc)


def test_shown_unloading_time_is_exactly_the_service_time_sent():
    """Start and departure were rounded separately with Python's round() (halves to even): a
    25-min unload starting at hh:mm:30 showed as 24 or 26 min on the plan screen and in Excel."""
    r = req([stop("A", 23.60, 58.45, cases=40, service_min=25)], [truck("T01")])
    day, tds = _day_for(r)
    mx = matrix_for(r)
    for start in (hm("07:00") * 60 + 30, hm("07:01") * 60 + 30):  # even and odd minute, both at :30
        tl = LR.TimedLoad(stops=(0,), depart_s=start - mx.duration_s[0][1], starts=(start,),
                          return_s=start + 25 * 60 + mx.duration_s[1][0])
        sc = ds._build_scenario("RECOMMENDED", r, r.stops, tds, mx, {0: [tl]}, day.values, False, [],
                                solver_status="ROUTING_SUCCESS", elapsed=0.0, time_limit=2, objective_value=0)
        st = sc.loads[0].stops[0]
        assert st.service_start_min == start // 60 + 1  # halves round up
        assert st.departure_min - st.service_start_min == 25
        assert st.wait_min == 0 and st.arrival_min == st.service_start_min
        assert sc.loads[0].duration_min == sc.loads[0].return_min - sc.loads[0].depart_min


# --------------------------------------------------------------------------------------
# LOADING / TURNAROUND TIME PER CASE
# --------------------------------------------------------------------------------------

def full_load_day(**cfg):
    """One 100-case truck, three 95-case loads (S2 is the P5), reload 20 min + 0.5 min per case,
    5 h day. The route search prices each turnaround for 80 cases (60 min) and fits all three
    loads (~288 min); timed exactly (67.5 min each) they need ~303 min: only two fit."""
    stops = [stop(f"S{i}", 23.58 + 0.036 * (i - 1), 58.50, cases=95, service_min=10, priority=3 if i < 2 else 5)
             for i in range(3)]
    cfg.setdefault("scenarios", ALL)
    return req(stops, [truck("T1", cap=100, fixed_cost=20, cost_per_km=0.1, max_trips=3)], shift_start_min=hm("07:00"),
               shift_max_min=300, reload_min=20, loading_min_per_case=0.5, **cfg)


def test_full_loads_that_break_the_loading_time_leave_out_the_lowest_priority(monkeypatch):
    """Every plan used to come back with the search's three loads, departing 7.5 min too early
    after each turnaround: the repack had to keep every stop the search carried. Now the lowest
    priority is left out (with its own reason) and every plan keeps the loading time."""
    monkeypatch.setenv("SOLVER_PARALLEL", "0")
    r = full_load_day()
    raw = spy_raw(monkeypatch)
    resp = optimize_dispatch(r)
    assert raw["RECOMMENDED"].trips == 3  # the search planned all three, on its estimate
    for sc in resp.scenarios:
        assert sc.trips == 2, sc.name
        assert unserved_map(sc) == {"S2": "SOLVER_DROPPED_LOW_PRIORITY"}, sc.name
        assert sc.unserved[0].reason_message.startswith("Not planned: once every load was timed with the loading time")
        assert any("1 stop(s) the route search had planned are left out" in w for w in sc.warnings), sc.warnings
        assert not any("does not leave the loading time" in w for w in sc.warnings)
        assert_plan_rules(r, sc)


def test_alternative_that_breaks_the_loading_time_is_never_advertised(monkeypatch):
    """RECOMMENDED plans two loads; the alternatives' searches plan three on the estimated
    turnaround. RECOMMENDED used to say 'The MIN TRUCKS option serves 1 more stop(s) ... Use
    instead', pointing at departure times no truck can make."""
    monkeypatch.setenv("SOLVER_PARALLEL", "0")
    r = full_load_day()
    day, tds = _day_for(r)
    mx = matrix_for(r)
    two = LR.time_plan(day, {0: [(0,), (1,)]}, ds._pricing("RECOMMENDED", r, tds, r.stops))
    fake = ds._build_scenario("RECOMMENDED", r, r.stops, tds, mx, two, day.values, False, [],
                              solver_status="ROUTING_SUCCESS", elapsed=1.0, time_limit=2, objective_value=0)
    real = ds._solve_scenario
    monkeypatch.setattr(ds, "_solve_scenario",
                        lambda name, *a, **kw: fake.model_copy(deep=True) if name == "RECOMMENDED" else real(name, *a, **kw))
    raw = spy_raw(monkeypatch)
    resp = optimize_dispatch(r)
    assert raw["MIN_TRUCKS"].trips == 3 and not raw["MIN_TRUCKS"].unserved  # serves one more, on paper
    assert not any("more stop(s)" in w for w in rec(resp).warnings), rec(resp).warnings
    for sc in resp.scenarios:
        assert len(sc.unserved) == 1, sc.name
        assert_plan_rules(r, sc)


def test_recommended_only_points_to_verified_alternatives(monkeypatch):
    """_run_scenarios compares service only with alternatives whose timetable passed the
    independent check (feasibility VERIFIED): never with one that breaks a hard rule, such as the
    loading time between loads, whichever path produced it (the stage, its fallback, a failure).
    It used to rely on a separate 'unverified' set that never reached the response (review F04)."""
    monkeypatch.setenv("SOLVER_PARALLEL", "0")
    r = full_load_day(scenarios=["RECOMMENDED", "MIN_TRUCKS"])
    day, tds = _day_for(r)
    mx = matrix_for(r)
    two = LR.time_plan(day, {0: [(0,), (1,)]}, ds._pricing("RECOMMENDED", r, tds, r.stops))
    fake = ds._build_scenario("RECOMMENDED", r, r.stops, tds, mx, two, day.values, False, [],
                              solver_status="ROUTING_SUCCESS", elapsed=1.0, time_limit=2, objective_value=0)
    real = ds._solve_scenario
    monkeypatch.setattr(ds, "_solve_scenario",
                        lambda name, *a, **kw: fake.model_copy(deep=True) if name == "RECOMMENDED" else real(name, *a, **kw))
    note = "The MIN TRUCKS option serves 1 more stop(s)"

    def mark(status):
        def post(*a):
            alt = a[6]["MIN_TRUCKS"]
            alt.feasibility = alt.feasibility.model_copy(update={"status": status, "violations": []})
        return post

    post_solve = ds._post_solve
    monkeypatch.setattr(ds, "_post_solve", mark("VERIFIED"))  # control: a verified alternative is offered
    assert any(note in w for w in rec(optimize_dispatch(r)).warnings)
    monkeypatch.setattr(ds, "_post_solve", mark("VIOLATED"))
    assert not any(note in w for w in rec(optimize_dispatch(r)).warnings)
    monkeypatch.setattr(ds, "_post_solve", post_solve)
    # The whole stage failing: RECOMMENDED keeps its (exact) plan; MIN_TRUCKS keeps the route
    # search's three loads, which cannot be re-timed exactly - reported, never advertised.
    monkeypatch.setenv("ROUTEIQ_TEST_FAIL_REPACK", "1")
    resp = optimize_dispatch(r)
    by = {s.name: s for s in resp.scenarios}
    assert not any(note in w for w in rec(resp).warnings)
    assert by["MIN_TRUCKS"].feasibility.status == "VIOLATED"
    assert {v.code for v in by["MIN_TRUCKS"].feasibility.violations} == {"TURNAROUND"}
    assert any("could not be re-timed" in w for w in by["MIN_TRUCKS"].warnings), by["MIN_TRUCKS"].warnings
    assert_plan_rules(r, rec(resp))


@pytest.mark.parametrize("per_case", [0.0, 0.1])
def test_loading_time_per_case_sets_the_gap_between_loads_exactly(per_case):
    stops = [stop("A", 23.62, 58.45, cases=90), stop("B", 23.60, 58.47, cases=50), stop("C", 23.64, 58.42, cases=70)]
    r = req(stops, [truck("T01", cap=100)], reload_min=30, loading_min_per_case=per_case,
            scenarios=["RECOMMENDED"], shift_start_min=hm("07:00"))
    sc = rec(optimize_dispatch(r))
    lds = by_truck(sc)["T01"]
    assert len(lds) == 3
    for a, b in zip(lds, lds[1:]):
        # Nothing forces waiting at the depot, so the gap is exactly the turnaround.
        assert b.depart_min - a.return_min == 30 + per_case * b.cases, (a.return_min, b.depart_min, b.cases)
    assert_plan_rules(r, sc)


def test_loading_time_after_a_frozen_load():
    t = truck("T01", cap=100, frozen_trips=[FrozenTrip(load_no=1, depart_min=hm("07:00"), return_min=hm("09:00"), cases=90)])
    r = req([stop("NEW", 23.60, 58.45, cases=80, late=True)], [t], reload_min=20, loading_min_per_case=0.25)
    ld = rec(optimize_dispatch(r)).loads[0]
    assert ld.load_no == 2
    assert ld.depart_min == hm("09:00") + 20 + 20  # 80 cases x 0.25 min


def test_loading_time_on_a_same_day_plan_counts_from_when_it_was_made():
    """PR8 review: loading_from_min (a plan made at 09:00 on its delivery day, first departure 09:30).
    Every scenario, through the route search, the repack and the exact timing: each new load leaves
    no earlier than 09:00 + 30 min + 0.2 min x its cases - on the idle trucks, on T02 back at 09:40
    and on T03 back at 08:00 - and every later load after the previous return + its turnaround."""
    rnd = random.Random(5)
    stops = [stop(f"S{i:02d}", 23.585 + rnd.uniform(-0.15, 0.15), 58.39 + rnd.uniform(-0.15, 0.15), cases=45) for i in range(12)]
    trucks = [
        truck("T01", cap=100),
        truck("T02", cap=100, frozen_trips=[FrozenTrip(load_no=1, depart_min=hm("06:00"), return_min=hm("09:40"), cases=90)]),
        truck("T03", cap=100, frozen_trips=[FrozenTrip(load_no=1, depart_min=hm("06:00"), return_min=hm("08:00"), cases=90)]),
        truck("T04", cap=100),
    ]
    r = req(stops, trucks, scenarios=ALL, shift_start_min=hm("09:30"), reload_min=30, loading_min_per_case=0.2,
            loading_from_min=hm("09:00"))
    resp = optimize_dispatch(r)
    for sc in resp.scenarios:
        assert sc.loads, sc.name
        for ld in sc.loads:
            assert ld.depart_min >= hm("09:30") + 0.2 * ld.cases - 1, (sc.name, ld.truck_id, ld.load_no, ld.depart_min, ld.cases)
        assert_plan_rules(r, sc)


def test_config_rejects_unrealistic_loading_time():
    with pytest.raises(Exception):
        DispatchConfig(loading_min_per_case=2)


# --------------------------------------------------------------------------------------
# WARM START / TIME LIMITS / REASONS
# --------------------------------------------------------------------------------------

def test_warm_start_with_time_costs_does_not_stall(monkeypatch):
    """ReadAssignmentFromRoutes could stall for over 100 s when the time dimension carries costs
    (preferred windows, overtime, driver time). RoutesToAssignment must not."""
    stops, trucks = nmwc_day(60, seed=3)
    r = req(stops, trucks, time_limit_sec=2, fuel_price_per_litre=0.26, driver_cost_per_hour=2.5)
    tds = ds._truck_days(r)
    mx = matrix_for(r)
    calls = []
    orig = ds._initial_assignment
    monkeypatch.setattr(ds, "_initial_assignment", lambda *a: calls.append(orig(*a)) or calls[-1])
    first = ds._solve_scenario("RECOMMENDED", r, r.stops, tds, mx, 2, [])
    # Production: the alternatives start from the recommended plan ...
    for name in ("MIN_TRUCKS", "MIN_DISTANCE"):
        t0 = time.perf_counter()
        sc = ds._solve_scenario(name, r, r.stops, tds, mx, 2, [], warm_start=first.loads)
        assert time.perf_counter() - t0 < 10, name
        assert calls and calls[-1] is not None, f"the warm start of {name} was not loaded"
        assert sc.status == "OPTIMIZED"
        assert_reconciled(r, sc)
    # ... and a start under time-dimension costs (RECOMMENDED's preferred windows, overtime,
    # driver time), where ReadAssignmentFromRoutes stalled.
    t0 = time.perf_counter()
    sc = ds._solve_scenario("RECOMMENDED", r, r.stops, tds, mx, 2, [], warm_start=sc.loads)
    assert time.perf_counter() - t0 < 10
    assert calls[-1] is not None, "the warm start was not loaded"
    assert sc.status == "OPTIMIZED"
    assert_reconciled(r, sc)


def test_warm_start_that_returns_no_solution_solves_cold(monkeypatch, caplog):
    """Seen once in the benchmark: the warm-started search came back with no solution. The
    scenario must then solve cold in the time that is left, not come back empty."""
    from ortools.constraint_solver import pywrapcp

    stops, trucks = nmwc_day(30, seed=4)
    r = req(stops, trucks, time_limit_sec=2)
    tds = ds._truck_days(r)
    mx = matrix_for(r)
    first = ds._solve_scenario("RECOMMENDED", r, r.stops, tds, mx, 2, [])
    tried: list = []
    monkeypatch.setattr(pywrapcp.RoutingModel, "SolveFromAssignmentWithParameters", lambda self, a, p: tried.append(a))
    with caplog.at_level(logging.INFO, logger="routeiq.dispatch"):
        sc = ds._solve_scenario("MIN_DISTANCE", r, r.stops, tds, mx, 2, [], warm_start=first.loads)
    assert tried and tried[0] is not None, "the warm start was not built"
    assert any("solving cold" in m for m in caplog.messages)
    assert sc.status == "OPTIMIZED" and sc.trips > 0
    assert_reconciled(r, sc)


def test_warm_start_that_cannot_load_solves_cold(monkeypatch):
    stops, trucks = nmwc_day(30, seed=4)
    r = req(stops, trucks, time_limit_sec=2)
    tds = ds._truck_days(r)
    mx = matrix_for(r)
    first = ds._solve_scenario("RECOMMENDED", r, r.stops, tds, mx, 2, [])
    monkeypatch.setattr(ds, "_initial_assignment", lambda *a: None)
    sc = ds._solve_scenario("MIN_DISTANCE", r, r.stops, tds, mx, 2, [], warm_start=first.loads)
    assert sc.status == "OPTIMIZED"
    assert_reconciled(r, sc)


def test_auto_time_limits():
    assert ds.auto_time_limit(1) == 5
    assert ds.auto_time_limit(25) == 5
    assert ds.auto_time_limit(26) == 20
    assert ds.auto_time_limit(80) == 20
    assert ds.auto_time_limit(100) == 20
    assert ds.auto_time_limit(120) == 20
    assert ds.auto_time_limit(135) == 35
    assert ds.auto_time_limit(150) == 50
    assert ds.auto_time_limit(175) == 100
    assert ds.auto_time_limit(200) == 150
    assert ds.auto_time_limit(201) == 150
    assert ds.auto_time_limit(240) == 150
    assert ds.auto_time_limit(299) == 150
    assert ds.auto_time_limit(300) == 150
    assert ds.auto_time_limit(350) == 150
    assert ds.auto_time_limit(351) == 240
    assert ds.auto_time_limit(600) == 240


def _pre_pr7_time_limit(n_stops: int) -> int:
    """The automatic search time before stabilization PR7: 5 s up to 25 stops, 20 s up to 200,
    150 s up to 350, 240 s above."""
    if n_stops <= 25:
        return 5
    if n_stops <= 200:
        return 20
    if n_stops <= 350:
        return 150
    return 240


def test_auto_time_limit_never_below_the_pre_pr7_schedule():
    """PR7 (T1), owner decision: the new schedule may give a day more search time, never less. PR7's
    first version reached 150 s only at 300 stops, so 201-299-stop days got less than the old flat
    150 s (240 stops: 102 s), and those sizes (the re-test's S03, 240 stops) had not converged even
    on 150 s."""
    below = [n for n in range(1, ds.MAX_STOPS + 1) if ds.auto_time_limit(n) < _pre_pr7_time_limit(n)]
    # (stops, now, before) of the first sizes that lost time.
    assert below == [], [(n, ds.auto_time_limit(n), _pre_pr7_time_limit(n)) for n in below[:10]]


def test_auto_time_limit_schedule():
    """PR7 (T1): the search time rises steadily with the day. It used to jump from 20 s at 200 stops
    to 150 s at 201, so a 200-stop day got 20 s and visibly different plans run to run."""
    limits = {n: ds.auto_time_limit(n) for n in range(1, ds.MAX_STOPS + 1)}
    # Monotone: one more stop never gets less time.
    assert [n for n in range(2, ds.MAX_STOPS + 1) if limits[n] < limits[n - 1]] == []
    # NMWC's typical 80-120-stop days keep the 20 s they had.
    assert all(limits[n] == 20 for n in range(26, 121))
    # 200-350 stops keep the 150 s that served big days fully (and the 200 -> 201 jump is gone).
    assert all(limits[n] == 150 for n in range(200, ds.LARGE_DAY_STOPS + 1))
    # Inside the request budget, which is inside the web's 600 s wait: with the slowest road matrix,
    # RECOMMENDED + its overhead + the alternatives (half the limit, in parallel) + their grace + the
    # post-solve stage (three sources) + its grace. Above LARGE_DAY_STOPS (240 s) the alternatives are
    # shortened to fit, but RECOMMENDED itself never is.
    matrix = ds.matrix_budget_sec(ds.SOLVER_BUDGET_SEC)
    for n in range(1, ds.LARGE_DAY_STOPS + 1):
        t = limits[n]
        stage = min(ds.REPACK_CAP_SEC, max(ds.REPACK_MIN_SEC, t / 2)) * 3 + ds.STAGE_GRACE_SEC
        assert matrix + t + ds.REC_OVERHEAD_SEC + max(2, t // 2) + ds.ALT_GRACE_SEC + stage <= ds.SOLVER_BUDGET_SEC, n
    assert matrix + ds.auto_time_limit(ds.MAX_STOPS) + ds.REC_OVERHEAD_SEC <= ds.SOLVER_BUDGET_SEC < 600


def test_dropped_stop_reason_is_honest_when_nothing_proves_it_impossible():
    # One truck, 5 h shift, three stops of a full load each ~2 h round trip away: each fits alone
    # (no prefilter drop) and the fleet has room for 300 cases (no shortage), yet only two round
    # trips fit the day. Nothing PROVED the third impossible: never say it "could not be fitted".
    stops = [stop(f"F{i}", 23.835 + i * 0.005, 58.39, cases=100) for i in range(3)]
    r = req(stops, [truck("T01", cap=100)], shift_max_min=5 * 60, max_trips_per_truck=3)
    sc = rec(optimize_dispatch(r))
    assert len(sc.loads) == 2 and len(sc.unserved) == 1
    for u in sc.unserved:
        assert u.reason_code == "SOLVER_DROPPED_LOW_PRIORITY"
        assert u.reason_message.startswith("Not planned: the optimizer found no truck, trip or time slot for this P3 stop")
        assert "could not be fitted" not in u.reason_message.lower()
    assert any("no check proves they are impossible" in w for w in sc.warnings)


# --------------------------------------------------------------------------------------
# PHYSICAL TRUCKS WITH FROZEN LOADS (PR7, B3)
# --------------------------------------------------------------------------------------

def frozen_two_trucks_day():
    """F1 and F2 are already out with a locked morning load (one load left each); G1 is fresh and
    could carry both new loads alone."""
    def out(tid: str):
        return truck(tid, cap=100, fixed_cost=30, cost_per_km=0.1, max_trips=2,
                     frozen_trips=[FrozenTrip(load_no=1, depart_min=hm("06:00"), return_min=hm("07:30"), cases=90)])
    stops = [stop("A", 23.60, 58.45, cases=90), stop("B", 23.62, 58.47, cases=90)]
    return req(stops, [out("F1"), out("F2"), truck("G1", cap=100, fixed_cost=30, cost_per_km=0.1)], scenarios=ALL)


def test_score_counts_the_trucks_of_frozen_loads():
    """MIN_TRUCKS ranks candidates by score().trucks. Counting only the trucks of the NEW loads made
    "both loads on fresh G1" (1 truck) beat "one load each on F1 and F2" (2 trucks), although the
    first uses 3 physical trucks and pays G1's day. Both trucks with locked loads are out anyway."""
    r = frozen_two_trucks_day()
    tds = ds._truck_days(r)
    ctx = ds._stage_ctx(r, r.stops, tds, matrix_for(r), [])
    day, pricing = ctx.day, ctx.rec_pricing
    assert day.frozen_trucks == frozenset({0, 1})
    on_frozen = LR.time_plan(day, {0: [(0,)], 1: [(1,)]}, pricing)
    on_fresh = LR.time_plan(day, {2: [(0,), (1,)]}, pricing)
    assert on_frozen is not None and on_fresh is not None
    s_frozen, s_fresh = LR.score(day, pricing, on_frozen), LR.score(day, pricing, on_fresh)
    assert (s_frozen.trucks, s_frozen.loads) == (2, 2)
    assert (s_fresh.trucks, s_fresh.loads) == (3, 2)
    assert s_frozen.operating < s_fresh.operating  # G1's fixed cost
    assert ds._GOALS["MIN_TRUCKS"](s_frozen) < ds._GOALS["MIN_TRUCKS"](s_fresh)
    # MIN_TRUCKS' prices never charge a truck with frozen loads for "opening" it (x20 fixed).
    mt = ds._pricing("MIN_TRUCKS", r, tds, r.stops)
    assert (mt.trucks[0].fixed, mt.trucks[1].fixed, mt.trucks[2].fixed) == (0, 0, 30 * 20 * ds.COST_SCALE)


def test_min_trucks_uses_the_trucks_already_out(monkeypatch):
    """End to end, MIN_TRUCKS' selection. The same day, but the trucks already out cost 3 OMR/km and
    fresh G1 0.1: RECOMMENDED puts both new loads on G1 (G1's 30 OMR day is cheaper than the km on
    F1/F2), so "both loads on G1" is among the candidates MIN_TRUCKS picks from. Counting only the
    trucks of the new loads, that plan was 1 truck against 2 for "one load each on F1 and F2", so
    MIN_TRUCKS picked it although the day then uses 3 physical trucks. Counted physically it is 3
    against 2, and MIN_TRUCKS keeps G1 at the depot. Every option reports the day's physical trucks."""
    monkeypatch.setenv("SOLVER_PARALLEL", "0")
    r = frozen_two_trucks_day()
    for t in r.trucks:
        if t.frozen_trips:
            t.cost_per_km = 3.0
    r.config.time_limit_sec = 2
    resp = optimize_dispatch(r)
    by = {s.name: s for s in resp.scenarios}
    assert set(by) == set(ALL)
    rec_sc, mt = by["RECOMMENDED"], by["MIN_TRUCKS"]
    # The candidate that leaves the trucks already out idle exists: it is the recommendation.
    assert {ld.truck_id for ld in rec_sc.loads} == {"G1"}, [(l.truck_id, l.load_no) for l in rec_sc.loads]
    # MIN_TRUCKS: fewest physical trucks = the two trucks already out, not one more.
    assert {ld.truck_id for ld in mt.loads} == {"F1", "F2"}, [(l.truck_id, l.load_no) for l in mt.loads]
    assert (mt.trucks_used, mt.trips) == (2, 2)
    assert (rec_sc.trucks_used, rec_sc.trips) == (3, 2)  # G1 + F1 + F2 (before: 1)
    for sc in by.values():
        assert served_ids(sc) == {"A", "B"}
        assert sc.trucks_used == len({ld.truck_id for ld in sc.loads} | {"F1", "F2"}), (sc.name, sc.trucks_used)
        assert (sc.frozen_trucks, sc.frozen_loads) == (2, 2)
        assert_plan_rules(r, sc)
