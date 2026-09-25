"""Strict priorities, the post-solve load repack (load_repack), exact loading/turnaround time,
the warm start and honest unserved reasons.

Haversine only (no network). Tests that monkeypatch the engine run in-process
(SOLVER_PARALLEL=0): a spawned worker would not see the patch.
"""
from __future__ import annotations

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
        for a, b in zip(lds, lds[1:]):
            assert b.depart_min >= a.return_min + cfg.reload_min + cfg.loading_min_per_case * b.cases - 1, (a, b)
        for ld in lds:
            assert ld.cases <= t.capacity_cases
            assert ld.return_min >= ld.depart_min
            for st in ld.stops:
                s = stops[st.stop_id]
                assert st.hard_window_ok
                assert (s.hard_start_min or 0) <= st.service_start_min <= (s.hard_end_min or 10**6)
    assert_reconciled(r, sc)


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
    raw: dict = {}
    orig = ds._post_solve

    def spy(req_, solvable, tds, mx, time_limit, drops, results, pool, budget_end):
        raw.update({n: sc.model_copy(deep=True) for n, sc in results.items()})
        return orig(req_, solvable, tds, mx, time_limit, drops, results, pool, budget_end)

    monkeypatch.setattr(ds, "_post_solve", spy)
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
    assert_plan_rules(r, sc)


def test_repack_failure_falls_back_to_the_search_plan(monkeypatch):
    monkeypatch.setenv("SOLVER_PARALLEL", "0")
    stops, trucks = half_load_day(n=24)
    r = req(stops, trucks, time_limit_sec=2, scenarios=["RECOMMENDED", "MIN_TRUCKS"])

    def boom(*a, **kw):
        raise RuntimeError("CP-SAT failed")

    monkeypatch.setattr(LR, "_solve_until_stalled", boom)
    resp = optimize_dispatch(r)
    for sc in resp.scenarios:
        assert sc.status == "OPTIMIZED"
        assert not any("re-assigned" in w for w in sc.warnings)
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


# --------------------------------------------------------------------------------------
# LOADING / TURNAROUND TIME PER CASE
# --------------------------------------------------------------------------------------

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
    first = ds._solve_scenario("MIN_TRUCKS", r, r.stops, tds, mx, 2, [])
    calls = []
    orig = ds._initial_assignment
    monkeypatch.setattr(ds, "_initial_assignment", lambda *a: calls.append(orig(*a)) or calls[-1])
    t0 = time.perf_counter()
    sc = ds._solve_scenario("RECOMMENDED", r, r.stops, tds, mx, 2, [], warm_start=first.loads)
    assert time.perf_counter() - t0 < 10
    assert calls and calls[0] is not None, "the warm start was not loaded"
    assert sc.status == "OPTIMIZED"
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
    assert ds.auto_time_limit(25) == 5
    assert ds.auto_time_limit(26) == 20
    assert ds.auto_time_limit(80) == 20
    assert ds.auto_time_limit(150) == 20
    assert ds.auto_time_limit(300) == 150


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
