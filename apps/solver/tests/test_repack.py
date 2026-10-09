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

    def spy(*a, **kw):
        raw.update({n: sc.model_copy(deep=True) for n, sc in a[6].items()})
        return orig(*a, **kw)

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
                 loading_s_per_case=r.config.loading_min_per_case * 60, values=values,
                 window_rule=r.config.window_rule)
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


# --------------------------------------------------------------------------------------
# Strict priorities after the search on a clean shortage day (review solver-pipeline-1,
# scenario s3-shortage-hire): the route search's plan times exactly, but it carries a lower
# priority where a higher one left out fits in its place.
# --------------------------------------------------------------------------------------

def _named_raw(r, name, plan):
    """The route search's plan for option ``name``, timed exactly (a clean day: VERIFIED)."""
    day, tds = _day_for(r)
    timed = LR.time_plan(day, plan, ds._pricing("RECOMMENDED", r, tds, r.stops))
    assert timed is not None
    return ds._build_scenario(name, r, r.stops, tds, matrix_for(r), timed, day.values, False, [],
                              solver_status="ROUTING_SUCCESS", elapsed=1.0, time_limit=2, objective_value=0)


def test_a_clean_day_puts_a_left_out_p3_in_place_of_a_p4_in_every_option():
    """One truck with one 100-case load. The search's plan carries A (P1, 40 cases) and LOW (P4, 60
    cases) and leaves HIGH (P3, 60 cases) out: no room beside them and no trip left, so only a swap
    serves it. The plan times exactly, so before this review only the insert-only recovery ran (the
    swaps were for repair days) and every option delivered the P4 while the P3 stayed out, its reason
    saying "Lower priorities are left out first (this is P3)"."""
    stops = [stop("A", 23.600, 58.420, cases=40, priority=1), stop("LOW", 23.610, 58.425, cases=60, priority=4),
             stop("HIGH", 23.615, 58.430, cases=60, priority=3)]
    r = req(stops, [truck("T1", cap=100, max_trips=1)], scenarios=ALL)
    results = {n: _named_raw(r, n, {0: [(0, 1)]}) for n in ALL}
    assert all(sc.feasibility.status == "VERIFIED" for sc in results.values())
    ds._post_solve(r, r.stops, ds._truck_days(r), matrix_for(r), 2, [], results, None, time.monotonic() + 60)
    for name, sc in results.items():
        assert served_ids(sc) == {"A", "HIGH"}, (name, served_ids(sc))
        assert unserved_map(sc) == {"LOW": "SOLVER_DROPPED_LOW_PRIORITY"}, name
        # LOW is now the lowest priority left out, and nothing of a lower priority rides: no false claim.
        assert sc.unserved[0].reason_message.startswith("Fleet capacity shortage"), sc.unserved[0].reason_message
        assert "lower-priority stop" not in sc.unserved[0].reason_message
        assert any("1 stop(s) the route search had left out were planned after the search" in w for w in sc.warnings), sc.warnings
        assert_plan_rules(r, sc)


def test_a_swap_may_take_several_lower_priority_stops_off_one_load():
    """One 100-case load carrying a P4 and a P5 of 50 cases; the P3 left out needs 90 cases: it fits
    only with both of them off (the skeptic's seed 12: S027 in place of S145 and S005, two P4 orders).
    Before, a swap put one stop out only. A stop of the same or a higher priority is never taken off."""
    stops = [stop("P4", 23.600, 58.420, cases=50, priority=4), stop("P5", 23.605, 58.425, cases=50, priority=5),
             stop("P3", 23.610, 58.430, cases=90, priority=3)]
    r = req(stops, [truck("T1", cap=100, max_trips=1)])
    day, tds = _day_for(r)
    pricing = ds._pricing("RECOMMENDED", r, tds, r.stops)
    base = LR.time_plan(day, {0: [(0, 1)]}, pricing)
    got = LR.recover(day, pricing, base, [2], time.perf_counter() + 10, swaps=True)
    assert LR.served_of(got) == {2}
    assert LR.time_plan(day, LR.plan_of(got), pricing) is not None
    # With a P1 in the P4's place, taking the P5 off alone leaves no room: the P1 stays, the P3 stays out.
    stops[0] = stop("P1", 23.600, 58.420, cases=50, priority=1)
    r = req(stops, [truck("T1", cap=100, max_trips=1)])
    day, tds = _day_for(r)
    pricing = ds._pricing("RECOMMENDED", r, tds, r.stops)
    base = LR.time_plan(day, {0: [(0, 1)]}, pricing)
    assert LR.served_of(LR.recover(day, pricing, base, [2], time.perf_counter() + 10, swaps=True)) == {0, 1}


def test_the_closing_swap_gets_time_when_the_repacks_use_the_whole_budget(monkeypatch):
    """The reviewer's demo: the repacks used the job's whole budget, so the closing recovery never ran
    (no "recovery" line in the notes) and the P3 stayed out. A day whose plans leave a stop out while
    they carry a lower priority now keeps CLEAN_RECOVER_SEC of the job for it."""
    stops = [stop("A", 23.600, 58.420, cases=40, priority=1), stop("LOW", 23.610, 58.425, cases=60, priority=4),
             stop("HIGH", 23.615, 58.430, cases=60, priority=3)]
    r = req(stops, [truck("T1", cap=100, max_trips=1)])
    day, tds = _day_for(r)
    pricing = ds._pricing("RECOMMENDED", r, tds, r.stops)
    src = LR.Source("RECOMMENDED", LR.time_plan(day, {0: [(0, 1)]}, pricing))

    def slow(day_, pricing_, pool, required, optional, hint, time_limit, **kw):
        # A repack that uses its whole limit and ends without an answer (the demo's UNKNOWN): the plan
        # it started from stays the job's candidate.
        time.sleep(max(0.0, time_limit))
        return LR.RepackResult(None, "UNKNOWN", time_limit)

    monkeypatch.setattr(LR, "repack", slow)
    t = time.perf_counter()
    cands, notes = LR.build_candidates(day, pricing, "RECOMMENDED", pricing, [src], {2: 1}, cap_s=10.0, budget_s=4.0,
                                       time_raw=True, fit_weights=None)
    took = time.perf_counter() - t
    best = min(cands, key=lambda c: LR.GOALS["RECOMMENDED"](c.score))
    assert LR.served_of(best.plan) == {0, 2}, notes
    assert any("recovery" in n for n in notes), notes
    assert took < 4.0 + 1.5, took  # within the job's budget (CP-SAT's last phase may end up to 0.5 s late)


def test_the_closing_swap_still_runs_when_a_repack_overruns_its_limit(monkeypatch):
    """Review of the strict-priority fix: the real repack runs past its limit (a cold CP-SAT import of
    1.3-2 s before its clock started, CP-SAT's last phase up to 0.5 s), so on the reviewer's next-day
    150-stop plan under load the closing recovery's reserve was gone before it started, it never ran, and
    the P3 stayed out while the P4 rode (3 of 4 runs). A repack that overruns its limit by 2 s now still
    leaves the recovery its reserve from when it starts, and the job ends at most CLOSING_LATE_SEC past
    its budget."""
    stops = [stop("A", 23.600, 58.420, cases=40, priority=1), stop("LOW", 23.610, 58.425, cases=60, priority=4),
             stop("HIGH", 23.615, 58.430, cases=60, priority=3)]
    r = req(stops, [truck("T1", cap=100, max_trips=1)])
    day, tds = _day_for(r)
    pricing = ds._pricing("RECOMMENDED", r, tds, r.stops)
    src = LR.Source("RECOMMENDED", LR.time_plan(day, {0: [(0, 1)]}, pricing))

    def late(day_, pricing_, pool, required, optional, hint, time_limit, **kw):
        time.sleep(max(0.0, time_limit) + 2.0)  # 2 s past its limit, then no answer (UNKNOWN)
        return LR.RepackResult(None, "UNKNOWN", time_limit + 2.0)

    given: list[float] = []
    real_recover = LR.recover

    def spy(day_, pricing_, plan, missing, deadline, *a, **kw):
        given.append(deadline - time.perf_counter())
        return real_recover(day_, pricing_, plan, missing, deadline, *a, **kw)

    monkeypatch.setattr(LR, "repack", late)
    monkeypatch.setattr(LR, "recover", spy)
    t = time.perf_counter()
    cands, notes = LR.build_candidates(day, pricing, "RECOMMENDED", pricing, [src], {2: 1}, cap_s=10.0, budget_s=4.0,
                                       time_raw=True, fit_weights=None)
    took = time.perf_counter() - t
    best = min(cands, key=lambda c: LR.GOALS["RECOMMENDED"](c.score))
    assert LR.served_of(best.plan) == {0, 2}, notes
    assert any("recovery" in n for n in notes), notes
    closing = min(LR.CLEAN_RECOVER_SEC, LR.CLOSING_SHARE * 4.0)
    assert given and given[0] > closing - 0.5, given  # its reserve from when it started
    assert took < 4.0 + LR.CLOSING_LATE_SEC + 1.0, took


def _fresh_python(code: str) -> str:
    """Run ``code`` in a fresh Python process (nothing imported yet, like a new worker) from the solver
    directory; its last line of output."""
    import os
    import subprocess
    import sys

    solver_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    done = subprocess.run([sys.executable, "-c", code], cwd=solver_dir, capture_output=True, text=True, timeout=180)
    assert done.returncode == 0, done.stderr
    return done.stdout.strip().splitlines()[-1]


def test_a_cold_cp_sat_import_counts_in_the_repack_time():
    """Review of the strict-priority fix: repack() imported CP-SAT before its clock started, so a fresh
    worker's first solve ran 1.3-2 s past its limit, outside its seconds too."""
    out = _fresh_python(
        "import sys, time\n"
        "from tests.test_dispatch import req, stop, truck\n"
        "from tests.test_repack import _day_for\n"
        "import dispatch_solver as ds, load_repack as LR\n"
        "r = req([stop('A', 23.60, 58.42, cases=40)], [truck('T1', cap=100)])\n"
        "day, tds = _day_for(r)\n"
        "pricing = ds._pricing('RECOMMENDED', r, tds, r.stops)\n"
        "cold = 'ortools.sat.python.cp_model' not in sys.modules\n"
        "t = time.perf_counter()\n"
        "res = LR.repack(day, pricing, [(0,)], {0}, {}, None, 5.0)\n"
        "print(cold, res.plan is not None, round(time.perf_counter() - t - res.seconds, 3))\n")
    cold, planned, outside = out.split()  # cold: CP-SAT was not imported yet (1.3-2 s to import)
    assert planned == "True", out
    assert float(outside) < 0.5, out  # the import is inside res.seconds (and the limit)


@pytest.mark.parametrize("job", ["engine", "pyvrp"])
def test_the_stage_jobs_import_cp_sat_before_their_clocks_start(job):
    """Review of the strict-priority fix: the stage's workers had imported only the routing modules, so
    the first repack of every stage job paid the cold CP-SAT import (1.3-2 s) inside the job's budget,
    and the closing recovery's reserve was gone. Each stage job (the engine's, the second search's) now
    imports it when it starts, before its clock: worker start-up, inside the stage's grace."""
    call = ("ds._stage_worker(dict(day=None, score_pricing=None, goal='RECOMMENDED', goal_pricing=None, sources=[],\n"
            "                     optional=None, cap_s=1.0, budget_s=1.0, time_raw=True))\n" if job == "engine" else
            "PV.stage_in_worker({'day': None, 'plan': None, 'score_pricing': None})\n")
    out = _fresh_python(
        "import sys, time\n"
        "import dispatch_solver as ds, pyvrp_candidate as PV\n"
        "MOD = 'ortools.sat.python.cp_model'\n"
        "cold = MOD not in sys.modules\n"
        "seen = []\n"
        "class Clock(Exception):\n"
        "    pass\n"
        "def clock():\n"
        "    seen.append(MOD in sys.modules)\n"
        "    raise Clock\n"
        "time.perf_counter = clock  # the job's clock starts at its first reading\n"
        "try:\n"
        "    " + call +
        "except Clock:\n"
        "    pass\n"
        "print(cold, seen)\n")
    assert out.endswith(" [True]"), out  # imported when the job's clock starts (cold: the modules had not imported it)


@pytest.mark.xfail(strict=True, reason="known limit, note (b) of the first strict-priority review: recover() keeps "
                   "the first swap that times; choosing among several (least value put out, or the stops that go back in) "
                   "was about even on random days without a deadline and clearly worse when the closing recovery's 2 s "
                   "run out (third and fourth reviews)")
def test_a_swap_takes_off_the_least_valuable_stop_first():
    """Review of the strict-priority fix, note (b): the swaps are tried by the number of stops taken off,
    then the km change, and recover() keeps the first that serves more. T1 carries FAR (P4, 100 cases,
    20 km out), T2 carries X (P1) and NEAR5 (P5). P3 (40 cases, by the depot) fits in FAR's place, the
    cheapest km by far, or in NEAR5's: FAR comes off, and fits nowhere again (NEAR5's place is too small),
    so the plan delivers the P5 and leaves the P4 out (no 1-for-1 inversion: FAR does not fit in NEAR5's
    place). Two fixes that chose among the swaps were tried and dropped (see the reason);
    this test stays as the record of the case, strict, so a fix that serves it shows up."""
    stops = [stop("FAR", 23.585, 58.590, cases=100, priority=4), stop("X", 23.600, 58.420, cases=60, priority=1),
             stop("NEAR5", 23.602, 58.422, cases=40, priority=5), stop("P3", 23.590, 58.395, cases=40, priority=3)]
    r = req(stops, [truck("T1", cap=100, max_trips=1), truck("T2", cap=100, max_trips=1)])
    day, tds = _day_for(r)
    pricing = ds._pricing("RECOMMENDED", r, tds, r.stops)
    base = LR.time_plan(day, {0: [(0,)], 1: [(1, 2)]}, pricing)
    assert base is not None
    swaps = LR._swaps(day, base, 3)
    assert [o[3] for o in swaps][:1] == [(0,)], swaps  # FAR's place is tried first (cheapest km) ...
    got = LR.recover(day, pricing, base, [3], time.perf_counter() + 10, swaps=True)
    assert LR.served_of(got) == {0, 1, 3}  # ... but NEAR5 comes off: FAR still rides
    assert LR.time_plan(day, LR.plan_of(got), pricing) is not None


def test_a_swap_that_fits_is_not_starved_by_cheaper_value_options():
    """Second review of the strict-priority fix (rv-spt/swap_starve.py): sorting _swaps by the value taken
    off first let a load of many cheap stops use up recover()'s RECOVER_TRIES, so the one swap that times
    was never tried. T1 carries seven small P5 stops near the depot (received 06:00-07:30); T2 carries P4
    (60 cases) at exactly the P3's place, 14 km out. P3 (60 cases, received 06:00-06:40) fits T2 only in
    place of P4, and T1 only by taking a P5 off, which never times (the P5s' hours break). On that sort P3
    stayed out while P4 rode; now P3 goes in place of P4, and P4 goes on T1 after the P5s."""
    p5 = [stop(f"N{i}", 23.585 + 0.004 * (i + 1), 58.390 + 0.002 * (i % 3), cases=10, priority=5,
               hard_start_min=hm("06:00"), hard_end_min=hm("07:30")) for i in range(7)]
    far = (23.585 - 0.12, 58.39 - 0.05)
    stops = p5 + [stop("P4", *far, cases=60, priority=4),
                  stop("P3", *far, cases=60, priority=3, hard_start_min=hm("06:00"), hard_end_min=hm("06:40"))]
    r = req(stops, [truck("T1", cap=200, max_trips=1), truck("T2", cap=100, max_trips=1)])
    day, tds = _day_for(r)
    pricing = ds._pricing("RECOMMENDED", r, tds, r.stops)
    p4, p3 = 7, 8
    base = LR.time_plan(day, {0: [tuple(range(7))], 1: [(p4,)]}, pricing)
    assert base is not None
    swaps = LR._swaps(day, base, p3)
    assert len(swaps) > LR.RECOVER_TRIES and any(o[3] == (p4,) for o in swaps), [o[3] for o in swaps]
    got = LR.recover(day, pricing, base, [p3], time.perf_counter() + 10, swaps=True)
    assert LR.served_of(got) == set(range(9))
    assert LR.time_plan(day, LR.plan_of(got), pricing) is not None
    # The same day through a stage job: the closing recovery of the job's best plan serves P3 too.
    cands, _ = LR.build_candidates(day, pricing, "RECOMMENDED", pricing, [LR.Source("RECOMMENDED", base)], {p3: 1},
                                   cap_s=5.0, budget_s=6.0, time_raw=True, fit_weights=None)
    best = min(cands, key=lambda c: LR.GOALS["RECOMMENDED"](c.score))
    assert p3 in LR.served_of(best.plan), best.source


def _random_day(seed: int):
    """A random day and a random plan of it that times exactly (the third review's fuzz generator,
    rv-v3/fuzz_inv.py mode a): 25-50 stops, P1-P5, 40 % with a hard window, 2-4 trucks of 1-2 trips."""
    rnd = random.Random(seed)
    stops = []
    for i in range(rnd.randint(25, 50)):
        kw = {}
        if rnd.random() < 0.4:
            a = rnd.choice([hm("06:00"), hm("07:00"), hm("08:00"), hm("10:00")])
            kw = dict(hard_start_min=a, hard_end_min=a + rnd.choice([45, 60, 120, 240]))
        stops.append(stop(f"S{i}", 23.50 + rnd.random() * 0.2, 58.28 + rnd.random() * 0.25,
                          cases=rnd.randint(10, 60), priority=rnd.choice([1, 2, 3, 3, 4, 4, 5, 5, 5]), **kw))
    trucks = [truck(f"T{j}", cap=rnd.choice([150, 200, 300]), max_trips=rnd.randint(1, 2))
              for j in range(rnd.randint(2, 4))]
    r = req(stops, trucks)
    day, tds = _day_for(r)
    pricing = ds._pricing("RECOMMENDED", r, tds, r.stops)
    plan: dict = {}
    order = list(range(len(stops)))
    rnd.shuffle(order)
    for k in order:
        td = rnd.choice(day.trucks)
        loads = [list(l) for l in plan.get(td.idx, [])]
        if loads and (len(loads) >= td.trips_left or rnd.random() < 0.7):
            j = rnd.randrange(len(loads))
            loads[j].insert(rnd.randint(0, len(loads[j])), k)
        elif len(loads) < td.trips_left:
            loads.append([k])
        else:
            continue
        trial = [tuple(l) for l in loads]
        if all(LR.fits_truck(LR.facts(day, l), td) for l in trial) and LR.time_truck(day, td, trial, pricing) is not None:
            plan[td.idx] = trial
    return stops, day, pricing, LR.time_plan(day, plan, pricing)


def _one_for_one(day, pricing, stops, plan) -> list[tuple[str, str]]:
    """Every (left-out stop, riding stop of a strictly lower priority) where the first fits in the
    second's place at any position of its load, the truck's whole day timed exactly."""
    served = LR.served_of(plan)
    out = []
    for d in (k for k in range(len(stops)) if k not in served):
        for idx, tls in plan.items():
            td = day.by_idx[idx]
            loads = [tl.stops for tl in tls]
            for j, load in enumerate(loads):
                for q in load:
                    rest = [x for x in load if x != q]
                    if stops[q].priority <= stops[d].priority or not LR.fits_truck(LR.facts(day, tuple(rest) + (d,)), td):
                        continue
                    if any(LR.time_truck(day, td, loads[:j] + [tuple(rest[:p] + [d] + rest[p:])] + loads[j + 1:], pricing)
                           is not None for p in range(len(rest) + 1)):
                        out.append((f"{stops[d].stop_id} P{stops[d].priority}", f"{stops[q].stop_id} P{stops[q].priority}"))
    return out


@pytest.mark.parametrize("seed", [304, 426, 817])
def test_a_stop_that_fits_nowhere_gets_another_turn(seed):
    """Third review of the strict-priority fix: recover() tried each left-out stop once. On these random days
    a P1 / P2 order failed its turn (its 24 cheapest swaps did not time), a later stop of a lower priority
    changed that truck's day, and the P1 / P2 then fitted in place of a P3-P5 order that rode: the plan kept
    the inversion, and the shortage reason said no load could take it. Now the stops that fit nowhere get
    another round once the queue is empty, those that failed before the last placement: the result has no
    such inversion, and a second recover() on it serves no more."""
    stops, day, pricing, base = _random_day(seed)
    assert base is not None
    missing = [k for k in range(len(stops)) if k not in LR.served_of(base)]
    got = LR.recover(day, pricing, base, missing, time.perf_counter() + 60, swaps=True)
    assert LR.time_plan(day, LR.plan_of(got), pricing) is not None
    assert _one_for_one(day, pricing, stops, got) == []
    again = LR.recover(day, pricing, got, [k for k in range(len(stops)) if k not in LR.served_of(got)],
                       time.perf_counter() + 60, swaps=True)
    assert LR.score(day, pricing, again).service == LR.score(day, pricing, got).service


def test_the_retry_rounds_cost_about_one_more_pass_on_a_shortage_day():
    """Fourth review of the strict-priority fix (rv-v4-hunt/stormday.py): retrying every failed stop after
    each placement of a lower stop cost failed stops x placements timings. Four trucks carry a full 06:00
    load of P1 stops each; 20 more P1 stops (07:00-07:20, 15-20 km out) fit nowhere, every truck is out
    then; 80 small P5 stops by the depot fit easily. That retry needed 40,614 timing LPs and placed 16 of
    the 80 P5 orders in the closing recovery's 2 s (the first pass alone: 404). Now the 20 get one more
    round after the queue empties: every P5 order is placed, none of the 20, in a few times the LPs of a
    single pass."""
    stops = []
    for t in range(4):
        for i in range(3):
            a = 2 * math.pi * (t * 3 + i) / 12
            stops.append(stop(f"B{t}{i}", 23.585 + 0.09 * math.sin(a), 58.39 + 0.09 * math.cos(a), cases=133, priority=1,
                              hard_start_min=hm("06:00"), hard_end_min=hm("07:40")))
    for i in range(20):
        a = 2 * math.pi * i / 20 + 0.3
        stops.append(stop(f"O{i}", 23.585 + 0.15 * math.sin(a), 58.39 + 0.17 * math.cos(a), cases=20, priority=1,
                          hard_start_min=hm("07:00"), hard_end_min=hm("07:20")))
    for i in range(80):
        a = 2 * math.pi * i / 80
        stops.append(stop(f"F{i}", 23.585 + 0.04 * math.sin(a) * (1 + i % 3) / 3, 58.39 + 0.04 * math.cos(a) * (1 + i % 2),
                          cases=12, priority=5))
    r = req(stops, [truck(f"T{j}", cap=400, max_trips=3, fixed_cost=20, cost_per_km=0.1) for j in range(4)],
            driver_cost_per_hour=2.5)
    day, tds = _day_for(r)
    pricing = ds._pricing("RECOMMENDED", r, tds, r.stops)
    base = LR.time_plan(day, {t: [(3 * t, 3 * t + 1, 3 * t + 2)] for t in range(4)}, pricing)
    assert base is not None
    missing = [k for k in range(len(stops)) if k not in LR.served_of(base)]
    lps = LR.LP_STATS["lps"]
    got = LR.recover(day, pricing, base, missing, time.perf_counter() + 60, swaps=True)
    used = LR.LP_STATS["lps"] - lps
    served = {stops[k].stop_id[0]: 0 for k in range(len(stops))}
    for k in LR.served_of(got):
        served[stops[k].stop_id[0]] += 1
    assert served == {"B": 12, "O": 0, "F": 80}, served
    assert LR.time_plan(day, LR.plan_of(got), pricing) is not None
    assert used <= 3000, used

def test_the_shortage_reason_says_lower_priorities_go_first_only_when_true():
    """Scenario s3-shortage-hire-2 (the verifier's tenant A): one truck, one 100-case load. EAST and WEST
    (P1, 25 cases) are 20 km apart, both received 07:00-07:10, so one load cannot reach both; C1-C3 and
    D (P3) and E (P5) are near the depot, open all day. 175 cases on 100: a fleet shortage. The plan
    carries EAST and C1-C3. WEST's reason used to say "Lower priorities are left out first (this is
    P1)" while three P3 stops ride; E (P5, the lowest priority of the day) read the same tail."""
    win = dict(hard_start_min=hm("07:00"), hard_end_min=hm("07:10"))
    stops = [stop("EAST", 23.585, 58.490, cases=25, priority=1, **win),
             stop("WEST", 23.585, 58.290, cases=25, priority=1, **win)]
    stops += [stop(f"C{i}", 23.590 + 0.002 * i, 58.395, cases=25, priority=3) for i in range(1, 4)]
    stops += [stop("D", 23.580, 58.395, cases=25, priority=3), stop("E", 23.578, 58.392, cases=25, priority=5)]
    r = req(stops, [truck("T1", cap=100, max_trips=1)])
    sc = _named_raw(r, "RECOMMENDED", {0: [(0, 2, 3, 4)]})
    why = {u.stop_id: u.reason_message for u in sc.unserved}
    assert set(why) == {"WEST", "D", "E"}
    assert all(m.startswith("Fleet capacity shortage: 175 cases requested vs 100 cases") for m in why.values()), why
    # WEST is out while three lower-priority stops ride: never "lower priorities are left out first".
    assert "Lower priorities are left out first" not in why["WEST"], why["WEST"]
    assert "This P1 stop was left out although 3 lower-priority stops are planned" in why["WEST"], why["WEST"]
    # D (P3) is out, and the only lower priority of the day (E, P5) is out too: the claim is true.
    assert why["D"].endswith("Lower priorities are left out first (this is P3)."), why["D"]
    # E is of the lowest priority of the day: there is nothing lower to leave out first.
    assert "Lower priorities are left out first" not in why["E"] and why["E"].endswith("This P5 stop was left out."), why["E"]


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
        def post(*a, **kw):
            alt = a[6]["MIN_TRUCKS"]
            alt.feasibility = alt.feasibility.model_copy(update={"status": status, "violations": []})
        return post

    post_solve = ds._post_solve
    monkeypatch.setattr(ds, "_post_solve", mark("VERIFIED"))  # control: a verified alternative is offered
    assert any(note in w for w in rec(optimize_dispatch(r)).warnings)
    monkeypatch.setattr(ds, "_post_solve", mark("VIOLATED"))
    assert not any(note in w for w in rec(optimize_dispatch(r)).warnings)
    monkeypatch.setattr(ds, "_post_solve", post_solve)
    # The whole stage failing: RECOMMENDED keeps its (exact) plan; MIN_TRUCKS's three loads cannot be
    # re-timed exactly, so it keeps the part that times (benchmark F01: a checked partial plan), which
    # serves no more than RECOMMENDED - nothing is advertised.
    monkeypatch.setenv("ROUTEIQ_TEST_FAIL_REPACK", "1")
    resp = optimize_dispatch(r)
    by = {s.name: s for s in resp.scenarios}
    assert not any(note in w for w in rec(resp).warnings)
    assert by["MIN_TRUCKS"].feasibility.status == "VERIFIED"
    assert any(w.startswith(ds.PARTIAL_PLAN_NOTE) for w in by["MIN_TRUCKS"].warnings), by["MIN_TRUCKS"].warnings
    # And when nothing of it could be timed, the route search's three loads stay - reported, never advertised.
    monkeypatch.setattr(ds, "_trimmed", lambda *a, **kw: None)
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


# --------------------------------------------------------------------------------------
# OVERTIME ALREADY WORKED IS NOT CHARGED AGAIN (audit E4, owner decision 14)
# --------------------------------------------------------------------------------------

def overtime_day(frozen_return: str = "18:00", overtime_cost: float = 4.0):
    """Truck A is out on a locked load 06:00 -> ``frozen_return`` (overtime after 9 h: from 15:00);
    idle truck B costs 6 OMR to open. One small new stop near the depot. Only A's NEW overtime
    (after its frozen return) is a cost of the new load: ~0.8 h x 4 OMR = ~3.1 OMR < 6 OMR."""
    stops = [stop("N", 23.595, 58.40, cases=10, service_min=10)]
    a = truck("A", fixed_cost=6.0, frozen_trips=[FrozenTrip(load_no=1, depart_min=hm("06:00"), return_min=hm(frozen_return), cases=100)])
    return req(stops, [a, truck("B", fixed_cost=6.0)], shift_start_min=hm("06:00"), shift_max_min=14 * 60,
               overtime_after_min=9 * 60, overtime_cost_per_hour=overtime_cost, driver_cost_per_hour=0.0, reload_min=30,
               pref_window_penalty_per_min=0.0, early_preference_per_min={p: 0.0 for p in range(1, 6)}, time_limit_sec=2)


def test_overtime_bound_counts_only_new_overtime():
    r = overtime_day("18:00")
    a, b = ds._truck_days(r)
    assert LR.overtime_bound_s(a, 9 * 3600) == hm("18:00") * 60  # not 15:00: 06:00-18:00 was paid by the locked load
    assert LR.overtime_bound_s(ds._truck_days(overtime_day("14:00"))[0], 9 * 3600) == hm("15:00") * 60
    assert LR.overtime_bound_s(b, 9 * 3600) is None


@pytest.mark.parametrize("frozen_return", ["16:00", "18:00"])
def test_a_truck_already_in_overtime_is_not_charged_its_old_overtime_again(frozen_return, monkeypatch):
    """Audit E4, confirmed end to end: the repack charged truck A overtime from 15:00 (the ~3 h its
    locked load already worked: ~15 OMR) and the route search did the same, so they opened idle B
    for 6 OMR although A costs ~3 OMR (the reported cost was right). Now the repack, the raw route
    search and the final plan all put the new load on A."""
    monkeypatch.setenv("SOLVER_PARALLEL", "0")
    r = overtime_day(frozen_return)
    tds = ds._truck_days(r)
    ctx = ds._stage_ctx(r, r.stops, tds, matrix_for(r), [])
    day, pricing = ctx.day, ctx.rec_pricing
    on_a, on_b = LR.time_plan(day, {0: [(0,)]}, pricing), LR.time_plan(day, {1: [(0,)]}, pricing)
    cost_a, cost_b = LR.score(day, pricing, on_a).operating, LR.score(day, pricing, on_b).operating
    assert cost_b == 6 * ds.COST_SCALE and cost_a < cost_b, (cost_a, cost_b)
    res = LR.repack(day, pricing, [(0,)], {0}, {}, None, 5.0)
    assert res.plan == {0: [(0,)]}, res
    raw = spy_raw(monkeypatch)
    sc = rec(optimize_dispatch(r))
    assert [ld.truck_id for ld in raw["RECOMMENDED"].loads] == ["A"]
    assert [ld.truck_id for ld in sc.loads] == ["A"] and sc.operating_cost == pytest.approx(cost_a / ds.COST_SCALE, abs=0.01)
    assert sc.operating_cost < 6.0
    assert_plan_rules(r, sc)


@pytest.mark.parametrize("frozen_return,overtime_cost", [("14:00", 4.0), ("18:00", 0.0)])
def test_new_load_stays_on_the_truck_already_out_without_old_overtime(frozen_return, overtime_cost, monkeypatch):
    """Controls: back before the overtime starts (14:00), or overtime not priced: A was chosen
    before too, and still is, at no extra cost but its own overtime."""
    monkeypatch.setenv("SOLVER_PARALLEL", "0")
    raw = spy_raw(monkeypatch)
    sc = rec(optimize_dispatch(overtime_day(frozen_return, overtime_cost)))
    assert [ld.truck_id for ld in raw["RECOMMENDED"].loads] == ["A"]
    assert [ld.truck_id for ld in sc.loads] == ["A"] and sc.operating_cost < 6.0


# --------------------------------------------------------------------------------------
# THE REPACK NEVER GIVES UP BEFORE ITS FIRST ANSWER (audit E5)
# --------------------------------------------------------------------------------------

class _SlowFirstSolution:
    """A stand-in CP-SAT solver whose first solution comes after ``first_at`` seconds and which
    then stops at its limit (or when told to): what the watchdog sees on a hard model."""

    def __init__(self, first_at: float, limit: float):
        self.first_at, self.limit, self.stopped = first_at, limit, False

    def StopSearch(self):
        self.stopped = True

    def Solve(self, model, cb):
        from ortools.sat.python import cp_model

        t0, found = time.perf_counter(), False
        while not self.stopped and time.perf_counter() - t0 < self.limit:
            if not found and time.perf_counter() - t0 >= self.first_at:
                cb.on_solution_callback()
                found = True
            time.sleep(0.01)
        return cp_model.FEASIBLE if found else cp_model.UNKNOWN


def test_the_stall_watchdog_waits_for_the_first_solution():
    """Audit E5: the stall clock (a quarter of the limit, at least 1 s) started before the first
    solution, so a first answer at 1.5 s of a 4 s limit was stopped at ~1.1 s with none (UNKNOWN).
    Now the solve gets its answer, and the watchdog still stops it once nothing better comes."""
    from ortools.sat.python import cp_model

    s = _SlowFirstSolution(first_at=1.5, limit=4.0)
    t0 = time.perf_counter()
    assert LR._solve_until_stalled(s, None, 4.0) == cp_model.FEASIBLE
    took = time.perf_counter() - t0
    # Stopped by the watchdog about 1 s after the first solution (not at the 4 s limit).
    assert s.stopped and 2.4 <= took < 3.5, took
    # No solution at all: only the solver's own limit ends the search.
    s = _SlowFirstSolution(first_at=99, limit=1.6)
    t0 = time.perf_counter()
    assert LR._solve_until_stalled(s, None, 1.6) == cp_model.UNKNOWN
    assert not s.stopped and time.perf_counter() - t0 >= 1.55


def test_a_repack_with_no_answer_keeps_the_plan_it_started_from(monkeypatch, caplog):
    """Audit E5: a repack that ends without an answer (UNKNOWN) never makes the plan worse: the
    plan it started from stays a candidate of every goal's job, with a WARNING in the log."""
    from ortools.sat.python import cp_model

    stops, trucks = half_load_day(n=12)
    r = req(stops, trucks, time_limit_sec=2, scenarios=["RECOMMENDED", "MIN_TRUCKS"])
    monkeypatch.setenv("SOLVER_PARALLEL", "0")
    monkeypatch.setattr(LR, "_solve_until_stalled", lambda solver, model, limit: cp_model.UNKNOWN)
    stage: list = []
    orig = LR.build_candidates
    monkeypatch.setattr(LR, "build_candidates", lambda **kw: stage.append((kw["goal"], orig(**kw))) or stage[-1][1])
    with caplog.at_level(logging.WARNING, logger="routeiq.dispatch.repack"):
        resp = optimize_dispatch(r)
    by_goal = dict(stage)
    assert set(by_goal) == {"RECOMMENDED", "MIN_TRUCKS"}
    # MIN_TRUCKS' job does not time the raw plans itself: its candidates are the plans its repacks started from.
    assert by_goal["MIN_TRUCKS"][0] and all("+" not in c.source for c in by_goal["MIN_TRUCKS"][0])
    assert any("repack UNKNOWN" in m and "kept the plan it started from" in m for m in caplog.messages), caplog.messages
    for sc in resp.scenarios:
        assert sc.status == "OPTIMIZED" and sc.feasibility.status == "VERIFIED"
        assert_plan_rules(r, sc)


@pytest.mark.parametrize("slow_phase_one", [0.0, 0.2])
def test_repack_phase_limits_stay_inside_the_solve_limit(monkeypatch, slow_phase_one):
    """Audit E5, keeping the budget honest: phase 1 ends by the solve's own limit (the job's share
    of its budget), and phase 2 too, unless phase 1 left it less than its floor (60 % of the limit,
    at most 0.5 s): then phase 2 runs up to that floor past the limit (E5 follow-up). Each phase had
    a fixed 0.5 s floor, which pushed a short solve past its limit. Each phase's limit is checked
    against the rule from the moment it started, so a slow phase 1 (CP-SAT's presolve on a busy
    machine, here a 0.2 s pause) does not fail it (A6 third review: the old check, that both phases
    end by the limit, failed at random under load)."""
    from ortools.sat.python import cp_model  # noqa: F401 - imported before the clock starts (repack imports it)

    calls: list[tuple[float, float]] = []
    orig = LR._solve_until_stalled

    def record(solver, model, limit):
        calls.append((time.perf_counter(), limit))
        if len(calls) == 1:
            time.sleep(slow_phase_one)
        return orig(solver, model, limit)

    monkeypatch.setattr(LR, "_solve_until_stalled", record)
    stops = [stop(f"S{i}", 23.585 + 0.05 * math.sin(i), 58.39 + 0.05 * math.cos(i), cases=40) for i in range(6)]
    r = req(stops, [truck(f"T{i}", cap=100, fixed_cost=30, cost_per_km=0.1) for i in range(3)])
    day, tds = _day_for(r)
    pricing = ds._pricing("RECOMMENDED", r, tds, r.stops)
    t0 = time.perf_counter()
    res = LR.repack(day, pricing, [(i,) for i in range(6)], set(range(3)), {k: 1 for k in range(3, 6)}, None, time_limit=0.3)
    assert len(calls) == 2, calls
    deadline, floor = t0 + 0.3, min(0.5, 0.6 * 0.3)
    (at1, lim1), (at2, lim2) = calls
    # Each limit was taken a moment before its phase started, and repack's own clock starts just
    # after t0: a limit may be a little MORE than the rule at its start, never less.
    rule1 = max(0.05, 0.4 * (deadline - at1))  # 40 % of the time left
    rule2 = max(deadline - at2, floor)  # the rest of the time, at least the floor
    assert rule1 - 1e-9 <= lim1 <= rule1 + 0.05, (at1 - t0, lim1)
    assert rule2 - 1e-9 <= lim2 <= rule2 + 0.05, (at2 - t0, lim2)
    assert at1 + lim1 <= max(deadline, at1 + 0.05) + 0.05, (at1 - t0, lim1)  # phase 1 ends by the limit
    assert at2 + lim2 <= max(deadline, at2 + floor) + 0.05, (at2 - t0, lim2)  # phase 2 by the limit or its floor
    if slow_phase_one:
        assert lim2 == pytest.approx(floor), (at2 - t0, lim2)  # less than the floor was left
    assert res.plan is not None


def test_repack_phase_two_keeps_a_real_chance_when_phase_one_overran(monkeypatch):
    """When phase 1 runs past the solve's limit (CP-SAT's presolve on a loaded machine), phase 2
    still gets 60 % of the limit, at most 0.5 s, not a few hundredths of a second that end with no
    plan (seen once in the A6 benchmark: a 0.6 s repack UNKNOWN)."""
    from ortools.sat.python import cp_model

    limits: list[float] = []
    orig = LR._solve_until_stalled

    def slow_phase_one(solver, model, limit):
        limits.append(limit)
        if len(limits) == 1:
            time.sleep(0.6)  # past the whole 0.5 s limit
            return cp_model.UNKNOWN
        return orig(solver, model, limit)

    monkeypatch.setattr(LR, "_solve_until_stalled", slow_phase_one)
    stops = [stop(f"S{i}", 23.585 + 0.05 * math.sin(i), 58.39 + 0.05 * math.cos(i), cases=40) for i in range(6)]
    r = req(stops, [truck(f"T{i}", cap=100, fixed_cost=30, cost_per_km=0.1) for i in range(3)])
    day, tds = _day_for(r)
    pricing = ds._pricing("RECOMMENDED", r, tds, r.stops)
    res = LR.repack(day, pricing, [(i,) for i in range(6)], set(range(3)), {k: 1 for k in range(3, 6)}, None, time_limit=0.5)
    assert len(limits) == 2 and limits[1] == pytest.approx(0.3), limits
    assert res.plan is not None
