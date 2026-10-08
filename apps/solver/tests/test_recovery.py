"""Recovery of work lost at the exact timing (outside benchmark of 8 Oct 2026, findings F01, F02, F07).

* F02 (P02): a stop the route search carried, on a load that did not survive the exact timing, was
  never offered back on its own, so it stayed unserved while a truck stood idle.
* F07 (D5): a same-day re-plan whose search plan broke the driver breaks kept 84 of 180 stops.
* F01 (D3 at 60 s): with no timed candidate the option kept a plan that breaks the rules (VIOLATED).

Fast synthetic days only (seconds); the saved benchmark requests replay in test_benchmark_replay.py.
"""
from __future__ import annotations

import time

import dispatch_solver as ds
import load_repack as LR
import pyvrp_candidate as PV
from dispatch_models import FrozenTrip
from tests.test_dispatch import hm, req, served_ids, stop, truck, unserved_map
from tests.test_repack import _day_for, assert_plan_rules, matrix_for


# --------------------------------------------------------------------------------------
# The fit pool (F02)
# --------------------------------------------------------------------------------------

def test_fit_pool_offers_every_carried_stop_back_as_a_one_stop_load():
    """A stop the search carried gets a load of its own in the pool, not only the stops it left out."""
    pool = LR.fit_pool([(0, 1, 2), (3, 4)])
    assert all((k,) in pool for k in range(5))
    assert (0, 1, 2) in pool and (3, 4) in pool


def test_fit_pool_shortens_a_load_by_two_stops_and_cuts_it_in_two():
    pool = LR.fit_pool([(0, 1, 2, 3, 4)])
    assert (0, 2, 4) in pool  # without two of its stops (1 and 3)
    assert (0, 1) in pool and (2, 3, 4) in pool  # cut in two: its first stops, its last stops
    assert (0, 1, 3, 4) in pool  # without one stop, as before
    # The pairs of least value go first when the pool is capped: with room for one pair after the
    # load, its 5 stops alone, its 5 shortened by one and its 4 new halves, it drops 1 and 3 (the P5s).
    weights = {0: 9, 1: 1, 2: 9, 3: 1, 4: 9}
    capped = LR.fit_pool([(0, 1, 2, 3, 4)], weights=weights, cap=1 + 5 + 5 + 4 + 1)
    assert capped[-1] == (0, 2, 4) and (2, 3, 4) in capped


def test_fit_pool_is_bounded_and_keeps_the_most_useful_entries_first():
    loads = [tuple(range(i * 20, i * 20 + 20)) for i in range(10)]  # 200 stops in ten 20-stop loads
    pool = LR.fit_pool(loads, extra=[500, 501])
    assert len(pool) <= LR.FIT_POOL_PER_STOP * 202 + 10 + LR.FIT_POOL_MIN
    assert len(set(pool)) == len(pool)
    head = pool[:10 + 202]
    assert all(l in head for l in loads)
    assert all((k,) in head for k in [*range(200), 500, 501])


# --------------------------------------------------------------------------------------
# The P02 mechanism: an idle truck, and a stop lost at the exact timing (F02)
# --------------------------------------------------------------------------------------

def idle_truck_day():
    """T1 (130 cases, 3 trips) and T2 (40 cases, idle). The search put three loads on T1: A, B (125
    cases, P3 each) and C+D+E (35 + 45 + 45 cases). Timed exactly (reload 20 min + 0.5 min per case,
    3 h 20 min day) the third load does not fit T1 after A and B, but D alone does (a short third
    trip), and C (P5, 35 cases) fits the idle T2 alone. The old fit pool offered neither: one-stop
    loads only for stops the search had left out, and loads shortened by one stop (C+D, C+E, D+E)."""
    stops = [stop("A", 23.600, 58.420, cases=125, priority=3), stop("B", 23.570, 58.420, cases=125, priority=3),
             stop("C", 23.610, 58.400, cases=35, priority=5), stop("D", 23.615, 58.405, cases=45, priority=4),
             stop("E", 23.620, 58.410, cases=45, priority=4)]
    trucks = [truck("T1", cap=130, fixed_cost=20, cost_per_km=0.1, max_trips=3),
              truck("T2", cap=40, fixed_cost=20, cost_per_km=0.1, max_trips=1)]
    return req(stops, trucks, shift_start_min=hm("07:00"), shift_max_min=200, reload_min=20, loading_min_per_case=0.5)


def _raw(r, plan):
    """The search's plan as it would come back: its own (estimated) times, never timed exactly."""
    day, tds = _day_for(r)
    timed = PV._asap(day, plan, {td.idx: 0 for td in day.trucks})
    mx = matrix_for(r)
    sc = ds._build_scenario("RECOMMENDED", r, r.stops, tds, mx, timed, day.values, False, [], solver_status="ROUTING_SUCCESS",
                            elapsed=1.0, time_limit=2, objective_value=0, exact_timing=False)
    return day, tds, mx, sc


def test_a_stop_lost_at_the_exact_timing_goes_on_the_idle_truck():
    r = idle_truck_day()
    day, tds, mx, raw = _raw(r, {0: [(0,), (1,), (2, 3, 4)]})
    assert LR.time_plan(day, {0: [(0,), (1,), (2, 3, 4)]}, ds._pricing("RECOMMENDED", r, tds, r.stops)) is None
    results = {"RECOMMENDED": raw}
    ds._post_solve(r, r.stops, tds, mx, 2, [], results, None, time.monotonic() + 60)
    sc = results["RECOMMENDED"]
    assert served_ids(sc) == {"A", "B", "C", "D"}
    assert {st.stop_id for ld in sc.loads if ld.truck_id == "T2" for st in ld.stops} == {"C"}
    # E fits nowhere (T1 has no trip left, T2 no room): left out, and the plan says why.
    assert unserved_map(sc) == {"E": "SOLVER_DROPPED_LOW_PRIORITY"}
    assert sc.unserved[0].reason_message.startswith(ds.TIMING_DROP_HEAD)
    assert_plan_rules(r, sc)


# --------------------------------------------------------------------------------------
# recover(): strict priority, exact timing, frozen loads and rented trucks left as they are
# --------------------------------------------------------------------------------------

def _pricing(r, tds):
    return ds._pricing("RECOMMENDED", r, tds, r.stops)


def test_recovery_inserts_left_out_stops_in_strict_priority_order():
    """Room for one of two 60-case stops: the P1 goes in, although the P5 is nearer and cheaper."""
    r = req([stop("NEAR_P5", 23.590, 58.395, cases=60, priority=5), stop("FAR_P1", 23.650, 58.480, cases=60, priority=1)],
            [truck("T1", cap=100, max_trips=1)])
    day, tds = _day_for(r)
    got = LR.recover(day, _pricing(r, tds), {}, [0, 1], time.perf_counter() + 10)
    assert LR.served_of(got) == {1}
    assert LR.time_plan(day, LR.plan_of(got), _pricing(r, tds)) is not None


def test_recovery_uses_spare_time_after_a_frozen_load_and_leaves_other_trucks_alone():
    """T1 is out on a frozen load until 10:00; T2 carries a load of the plan. The stop left out goes
    on T1 after its frozen return (+ reload and loading); T2's load stays exactly as it was."""
    frozen = [FrozenTrip(load_no=1, depart_min=hm("07:00"), return_min=hm("10:00"), cases=80)]
    r = req([stop("A", 23.600, 58.420, cases=90), stop("B", 23.610, 58.430, cases=60, priority=2)],
            [truck("T1", cap=100, max_trips=2, frozen_trips=frozen), truck("T2", cap=100, max_trips=1)],
            shift_start_min=hm("07:00"), reload_min=20, loading_min_per_case=0.5)
    day, tds = _day_for(r)
    pricing = _pricing(r, tds)
    base = LR.time_plan(day, {1: [(0,)]}, pricing)
    got = LR.recover(day, pricing, base, [1], time.perf_counter() + 10)
    assert got[1] == base[1]
    assert [tl.stops for tl in got[0]] == [(1,)]
    assert got[0][0].depart_s >= hm("10:00") * 60 + day.gap_s(60)
    assert LR.timing_ok(day, day.by_idx[0], got[0])


def test_recovery_never_opens_a_rented_truck_for_a_p5_stop_alone():
    r = req([stop("P5", 23.600, 58.420, cases=60, priority=5), stop("P2", 23.610, 58.430, cases=60, priority=2)],
            [truck("RENT", cap=100, max_trips=1)])
    day, tds = _day_for(r)
    pricing = _pricing(r, tds)
    from dataclasses import replace
    # The hire tier ranks between the P1-P3 and the P4/P5 orders (TruckPrice.hire): above one P5.
    rented = replace(pricing, trucks={0: replace(pricing.trucks[0], hire=day.values[0] + 1)})
    assert LR.recover(day, rented, {}, [0], time.perf_counter() + 10) == {}
    assert LR.served_of(LR.recover(day, rented, {}, [0, 1], time.perf_counter() + 10)) == {1}


def test_deep_recovery_lets_a_p1_stop_take_the_place_of_a_p5_stop():
    """One trip with room for one 60-case stop, carrying a P5: the P1 left out fits nowhere else. A
    plain insertion cannot place it; with swaps it takes the P5's place (strict priority value)."""
    r = req([stop("P5", 23.600, 58.420, cases=60, priority=5), stop("P1", 23.610, 58.430, cases=60, priority=1)],
            [truck("T1", cap=100, max_trips=1)])
    day, tds = _day_for(r)
    pricing = _pricing(r, tds)
    base = LR.time_plan(day, {0: [(0,)]}, pricing)
    assert LR.served_of(LR.recover(day, pricing, base, [1], time.perf_counter() + 10)) == {0}
    got = LR.recover(day, pricing, base, [1], time.perf_counter() + 10, tries=None, swaps=True)
    assert LR.served_of(got) == {1}
    assert LR.time_plan(day, LR.plan_of(got), pricing) is not None


def test_trim_keeps_the_part_of_a_plan_that_times_and_drops_the_lowest_priority_first():
    r = idle_truck_day()
    day, tds = _day_for(r)
    kept = LR.trim(day, _pricing(r, tds), {0: [(0,), (1,), (2, 3, 4)]}, time.perf_counter() + 10)
    assert LR.served_of(kept) >= {0, 1}  # both P3 loads stay
    assert 2 not in LR.served_of(kept)  # the P5 goes first
    assert LR.time_plan(day, LR.plan_of(kept), _pricing(r, tds)) is not None


def test_the_constructive_fallback_plans_a_day_from_nothing():
    stops = [stop(f"S{i}", 23.56 + 0.01 * (i % 7), 58.36 + 0.012 * (i // 7), cases=40, priority=1 + i % 5,
                  hard_start_min=hm("07:00"), hard_end_min=hm("16:00")) for i in range(21)]
    r = req(stops, [truck(f"T{i}", cap=200, max_trips=2) for i in range(3)], shift_start_min=hm("07:00"),
            reload_min=20, loading_min_per_case=0.2)
    day, tds = _day_for(r)
    pricing = _pricing(r, tds)
    built = LR.recover(day, pricing, {}, range(len(stops)), time.perf_counter() + 20)
    assert LR.served_of(built) == set(range(len(stops)))
    assert LR.time_plan(day, LR.plan_of(built), pricing) is not None


# --------------------------------------------------------------------------------------
# F01: a plan that cannot be timed leaves a checked partial plan, never only a VIOLATED one
# --------------------------------------------------------------------------------------

def test_no_repack_in_time_still_gives_a_checked_partial_plan(monkeypatch):
    """D3 at 60 s: every repack ran out of time and the option kept the search's plan, which breaks
    the loading time (VIOLATED). Now the incumbent (trim + recover) is a checked plan."""
    r = idle_truck_day()
    day, tds, mx, raw = _raw(r, {0: [(0,), (1,), (2, 3, 4)]})
    assert raw.feasibility.status == "VIOLATED"
    monkeypatch.setattr(LR, "repack", lambda *a, **kw: LR.RepackResult(None, "UNKNOWN", 0.0))
    results = {"RECOMMENDED": raw}
    ds._post_solve(r, r.stops, tds, mx, 2, [], results, None, time.monotonic() + 60)
    sc = results["RECOMMENDED"]
    assert sc.feasibility.status == "VERIFIED"
    assert {"A", "B"} <= served_ids(sc)
    assert all(u.reason_message.startswith(ds.TIMING_DROP_HEAD) for u in sc.unserved)
    assert_plan_rules(r, sc)


def test_the_safety_net_keeps_the_part_of_a_plan_it_can_time(monkeypatch):
    """The stage did not run (out of time, a failed worker): the safety net used to keep a plan it
    could not re-time, flagged VIOLATED. Now it keeps the part that times, and says what is left out."""
    r = idle_truck_day()
    day, tds, mx, raw = _raw(r, {0: [(0,), (1,), (2, 3, 4)]})
    results = {"RECOMMENDED": raw}
    ds._retime_fallback(r, r.stops, tds, mx, [], results, "out of time")
    sc = results["RECOMMENDED"]
    assert sc.feasibility.status == "VERIFIED"
    assert {"A", "B"} <= served_ids(sc) and "C" not in served_ids(sc)
    assert any(w.startswith(ds.PARTIAL_PLAN_NOTE) for w in sc.warnings), sc.warnings
    assert all(u.reason_message.startswith(ds.TIMING_DROP_HEAD) for u in sc.unserved)
    assert_plan_rules(r, sc)


def test_a_plan_with_nothing_that_times_stays_flagged_violated(monkeypatch):
    """No valid plan at all (no stop of it can be timed): the search's plan stays, flagged VIOLATED,
    so the web never lets it be locked or dispatched."""
    r = idle_truck_day()
    day, tds, mx, raw = _raw(r, {0: [(0,), (1,), (2, 3, 4)]})
    monkeypatch.setattr(LR, "time_truck", lambda *a, **kw: None)
    results = {"RECOMMENDED": raw}
    ds._retime_fallback(r, r.stops, tds, mx, [], results, "out of time")
    assert results["RECOMMENDED"] is raw and raw.feasibility.status == "VIOLATED"
