"""Review F17: one cost model (costing.py), owner decision "the driver is paid for the whole truck
day" (TRUCK_DAY_SPAN), used alike by the post-solve score, each scenario's loads and truck days,
and (through the response) every figure the web shows.
"""
from __future__ import annotations

import random

import pytest

import costing
import dispatch_solver as ds
import load_repack as LR
from dispatch_models import FrozenTrip
from providers import resolve_matrix
from tests.test_dispatch import hm, nmwc_day, rec, req, stop, truck
from dispatch_solver import optimize_dispatch

RATES = costing.DayRates(driver_per_hour=6.0, overtime_per_hour=4.0, overtime_after_s=60 * 60)


def lt(dep_min: int, ret_min: int, km: float = 0.0) -> costing.LoadTiming:
    return costing.LoadTiming(depart_s=dep_min * 60, return_s=ret_min * 60, km=km)


def test_golden_whole_truck_day():
    """L1 06:00-06:30, L2 08:40-09:10, 6 OMR/h, overtime after 60 min at 4 OMR/h: the driver is
    paid 06:00-09:10 = 190 min (19.000: L1 3.000, L2 16.000, the 130 min between the loads with
    L2), overtime 09:10 - 07:00 = 130 min = 8.667 on L2. The day costs 27.667."""
    day = costing.truck_day_costs(costing.TruckRates(), RATES, [lt(360, 390), lt(520, 550)])
    l1, l2 = day.loads
    assert (l1.paid_s, l2.paid_s) == (30 * 60, 160 * 60)
    assert l1.driver == pytest.approx(3.0) and l2.driver == pytest.approx(16.0)
    assert l1.overtime == 0 and l2.overtime == pytest.approx(130 / 60 * 4)
    assert day.total == pytest.approx(27.6667, abs=1e-4)
    assert sum(l.paid_s for l in day.loads) == 190 * 60


def test_fixed_trip_distance_and_fuel():
    t = costing.TruckRates(fixed=25.0, trip=2.0, per_km=0.1, km_per_litre=4.0)
    day = costing.truck_day_costs(t, costing.DayRates(fuel_price_per_litre=0.2), [lt(360, 420, 40.0), lt(450, 500, 20.0)])
    l1, l2 = day.loads
    assert (l1.fixed, l2.fixed) == (25.0, 0.0)  # once per truck day, on load 1
    assert (l1.trip, l2.trip) == (2.0, 2.0)
    assert l1.distance == pytest.approx(4.0) and l1.fuel_litres == pytest.approx(10.0) and l1.fuel == pytest.approx(2.0)
    assert day.total == pytest.approx(25 + 2 + 4 + 2 + 2 + 2 + 1)


@pytest.mark.parametrize("frozen_return", [390, 500])
def test_frozen_plus_new_is_the_whole_day_without_double_overtime(frozen_return):
    """A re-plan: the frozen load keeps the cost it was planned with; the new load owns (frozen
    return, its return]. Together they are the whole-day recomputation, and overtime already on
    the frozen load (frozen return after 07:00) is not counted again."""
    whole = costing.truck_day_costs(costing.TruckRates(fixed=10.0), RATES, [lt(360, frozen_return), lt(520, 550)])
    frozen = costing.truck_day_costs(costing.TruckRates(fixed=10.0), RATES, [lt(360, frozen_return)])
    new = costing.truck_day_costs(costing.TruckRates(fixed=10.0), RATES, [lt(520, 550)], anchor_s=360 * 60,
                                  frozen_return_s=frozen_return * 60)
    assert new.loads[0].fixed == 0.0  # the frozen load 1 paid it
    assert new.loads[0].paid_from_s == frozen_return * 60
    assert frozen.total + new.total == pytest.approx(whole.total)
    ot = frozen.loads[0].overtime_s + new.loads[0].overtime_s
    assert ot == whole.loads[0].overtime_s + whole.loads[1].overtime_s == (550 - 420) * 60


def test_scenario_pays_the_turnaround_and_reports_truck_days():
    """End to end: two loads of one truck (it holds one stop's cases), driver pay covers the depot
    turnaround between them; loads add up to the truck day and to the scenario."""
    stops = [stop("A", 23.60, 58.45, cases=90), stop("B", 23.62, 58.47, cases=90)]
    r = req(stops, [truck("T01", cap=100, max_trips=2, fixed_cost=20.0, trip_cost=1.5)], driver_cost_per_hour=6.0,
            overtime_after_min=60, overtime_cost_per_hour=4.0, reload_min=45)
    sc = rec(optimize_dispatch(r))
    l1, l2 = sorted(sc.loads, key=lambda l: l.load_no)
    assert sc.cost_policy == "TRUCK_DAY_SPAN" and sc.cost_version == 2
    assert l2.paid_from_min == pytest.approx(l1.return_min, abs=1)
    assert l2.driver_paid_min >= l2.return_min - l2.depart_min + 45 - 1  # the turnaround is paid
    assert l1.fixed_cost == 20.0 and l2.fixed_cost == 0.0 and l1.trip_cost == l2.trip_cost == 1.5
    for ld in sc.loads:
        assert ld.total_cost == pytest.approx(ld.fixed_cost + ld.trip_cost + ld.distance_cost + ld.fuel_cost
                                              + ld.driver_cost + ld.overtime_cost, abs=0.002)
        assert ld.time_cost == ld.driver_cost
    [day] = sc.truck_days
    assert day.paid_min == pytest.approx(l2.return_min - l1.depart_min, abs=2)
    assert day.total_cost == pytest.approx(sum(l.total_cost for l in sc.loads), abs=1e-6)
    assert sc.operating_cost == pytest.approx(sum(l.total_cost for l in sc.loads), abs=1e-6)
    assert sc.objective.overtime_cost == pytest.approx(sum(l.overtime_cost for l in sc.loads), abs=1e-6)


def test_frozen_truck_is_paid_from_its_last_frozen_return():
    t = truck("T01", cap=500, frozen_trips=[FrozenTrip(load_no=1, depart_min=hm("06:00"), return_min=hm("07:00"), cases=100)])
    r = req([stop("A", 23.60, 58.45)], [t], driver_cost_per_hour=6.0, overtime_after_min=120, overtime_cost_per_hour=4.0)
    sc = rec(optimize_dispatch(r))
    [ld] = sc.loads
    assert ld.load_no == 2 and ld.fixed_cost == 0.0
    assert ld.paid_from_min == hm("07:00")
    assert ld.driver_paid_min == ld.return_min - hm("07:00")
    [day] = sc.truck_days
    assert day.day_start_min == hm("06:00") and day.frozen_loads == 1
    expected_ot = max(0, ld.return_min - (hm("06:00") + 120))
    assert ld.overtime_min == pytest.approx(expected_ot, abs=1)


def _stage(r):
    tds = ds._truck_days(r)
    solvable, drops, _ = ds._prefilter(r, tds)
    c = r.config
    mx = resolve_matrix([(r.depot.lat, r.depot.lng)] + [(s.lat, s.lng) for s in solvable], provider="HAVERSINE", osrm_url=None,
                        haversine_multiplier=c.haversine_multiplier, avg_speed_kmh=c.avg_speed_kmh, road_time_factor=c.road_time_factor)
    keep, wd = ds._window_prefilter(solvable, tds, mx, c)
    if len(keep) != len(solvable):
        solvable, mx = ds._submatrix(solvable, keep, mx)
    return tds, solvable, drops + wd, mx


@pytest.mark.parametrize("seed", [1, 2, 3])
def test_score_money_equals_the_reported_cost(seed, monkeypatch):
    """Property (random NMWC-like days): the post-solve score's money is exactly the scenario's
    operating cost (within the 0.001 OMR rounding per load), and each truck day equals its loads."""
    monkeypatch.setenv("SOLVER_PARALLEL", "0")
    stops, trucks = nmwc_day(40, seed=seed)
    for t in trucks:
        t.km_per_litre = 3.5
        t.trip_cost = 1.25
    r = req(stops, trucks, time_limit_sec=2, driver_cost_per_hour=2.5, overtime_after_min=240, overtime_cost_per_hour=4.0,
            fuel_price_per_litre=0.23, loading_min_per_case=0.02)
    sc = rec(optimize_dispatch(r))
    assert sc.operating_cost == pytest.approx(sum(l.total_cost for l in sc.loads), abs=1e-6)
    for d in sc.truck_days:
        mine = [l for l in sc.loads if l.truck_id == d.truck_id]
        assert d.total_cost == pytest.approx(sum(l.total_cost for l in mine), abs=1e-6)
        assert d.paid_min == sum(l.driver_paid_min for l in mine)
        assert d.paid_min == pytest.approx(max(l.return_min for l in mine) - min(l.depart_min for l in mine), abs=len(mine))

    tds, solvable, drops, mx = _stage(r)
    ctx = ds._stage_ctx(r, solvable, tds, mx, drops)
    timed = LR.time_plan(ctx.day, LR.plan_of(ds._timed_from_scenario(sc, ctx.stop_idx, ctx.truck_idx)), ctx.rec_pricing)
    assert timed is not None
    again = ds._build_scenario("RECOMMENDED", r, solvable, tds, mx, timed, ctx.values, ctx.use_margin, drops,
                               solver_status="TEST", elapsed=0, time_limit=1, objective_value=0)
    score = LR.score(ctx.day, ctx.rec_pricing, timed)
    assert score.operating / costing.COST_SCALE == pytest.approx(again.operating_cost, abs=0.001 * len(again.loads) + 1e-6)


def test_score_prices_frozen_trucks_from_their_frozen_return():
    """The optimizer (score) and the report agree on a re-plan: waiting before the first new load
    after frozen loads is paid, so leaving later never looks cheaper."""
    t = truck("T01", cap=500, frozen_trips=[FrozenTrip(load_no=1, depart_min=hm("06:00"), return_min=hm("07:00"), cases=10)])
    r = req([stop("A", 23.60, 58.45)], [t], driver_cost_per_hour=6.0)
    tds, solvable, drops, mx = _stage(r)
    ctx = ds._stage_ctx(r, solvable, tds, mx, drops)
    idx = tds[0].idx
    early = {idx: [LR.TimedLoad(stops=(0,), depart_s=hm("07:30") * 60, starts=(hm("07:30") * 60 + mx.duration_s[0][1],),
                                return_s=hm("07:30") * 60 + mx.duration_s[0][1] + 600 + mx.duration_s[1][0])]}
    late = {idx: [LR.TimedLoad(stops=(0,), depart_s=hm("09:30") * 60, starts=(hm("09:30") * 60 + mx.duration_s[0][1],),
                               return_s=hm("09:30") * 60 + mx.duration_s[0][1] + 600 + mx.duration_s[1][0])]}
    se, sl = LR.score(ctx.day, ctx.rec_pricing, early), LR.score(ctx.day, ctx.rec_pricing, late)
    assert sl.operating - se.operating == pytest.approx(costing.to_units(2 * 6.0), abs=2)


# ---------------------------------------------------------------------------------------------
# Rounding: the parts, the load totals and the day total agree (PR5 review: a check tighter than
# the per-part rounding failed 1-3 load optimizations - typically late-order re-plans - with a 500)
# ---------------------------------------------------------------------------------------------

def test_round_parts_add_up_exactly_and_stay_within_a_baisa():
    rnd = random.Random(5)
    for _ in range(5000):
        exact = {k: (0.0 if rnd.random() < 0.2 else rnd.uniform(0, 40)) for k in ("fixed", "trip", "distance", "fuel", "time", "overtime")}
        parts, total = costing.round_parts(exact)
        assert list(parts) == list(exact)
        assert total == round(sum(exact.values()), 3)
        assert round(sum(parts.values()), 3) == total
        for k, v in parts.items():
            assert abs(v - exact[k]) < 0.001 + 1e-9, (k, v, exact[k])
            assert v >= 0
            if exact[k] == 0.0:
                assert v == 0.0


def test_round_parts_review_case():
    """The review's one-load day (19.61 km at 0.15 OMR/km, 5.603 l at 0.23 OMR, 39.4 min at 2.5
    OMR/h): the parts rounded one by one added up to 25.873, the exact money is 25.8718."""
    exact = dict(fixed=20.0, trip=0.0, distance=2.9415, fuel=1.2886571428571427, time=1.6416666666666666, overtime=0.0)
    assert round(sum(round(v, 3) for v in exact.values()), 3) == 25.873  # the old way
    parts, total = costing.round_parts(exact)
    assert total == 25.872
    assert round(sum(parts.values()), 3) == 25.872
    assert parts["fixed"] == 20.0 and parts["trip"] == 0.0 and parts["overtime"] == 0.0


def _no_cost_check(sc) -> None:
    assert not [w for w in sc.warnings if w.startswith("Cost check")], sc.warnings
    for ld in sc.loads:
        parts = ld.fixed_cost + ld.trip_cost + ld.distance_cost + ld.fuel_cost + ld.driver_cost + ld.overtime_cost
        assert round(parts, 3) == ld.total_cost, (ld.truck_id, ld.load_no, parts, ld.total_cost)
    assert sc.operating_cost == round(sum(ld.total_cost for ld in sc.loads), 3)
    for d in sc.truck_days:
        assert d.total_cost == round(sum(ld.total_cost for ld in sc.loads if ld.truck_id == d.truck_id), 3)


def test_review_one_load_day_is_costed_without_error():
    """Reproduction from the review: this single-load day raised CostError (loads 25.873 OMR, truck
    day 25.8718 OMR) and /optimize-dispatch answered 500."""
    r = req([stop("A", 23.56244956432374, 58.320204284752904, cases=20)],
            [truck("T01", cap=500, fixed_cost=20.0, cost_per_km=0.15, km_per_litre=3.5)],
            driver_cost_per_hour=2.5, fuel_price_per_litre=0.23, time_limit_sec=1)
    sc = rec(optimize_dispatch(r))
    assert sc.status == "OPTIMIZED" and len(sc.loads) == 1
    _no_cost_check(sc)


@pytest.mark.parametrize("frozen", [False, True])
@pytest.mark.parametrize("seed", range(8))
def test_small_days_and_late_order_replans_never_fail_the_cost_check(seed, frozen, monkeypatch):
    """Random 1-load and 2-load days, fresh or re-planned around a locked 06:00-09:00 load, with
    distance, trip, fuel, driver and overtime all non-zero: every scenario comes back, its loads'
    parts add up to their totals, and the loads to the truck days and the scenario."""
    monkeypatch.setenv("SOLVER_PARALLEL", "0")
    rnd = random.Random(1000 * seed + frozen)
    n_stops = 1 + seed % 2
    stops = [stop(f"S{k}", 23.45 + rnd.random() * 0.25, 58.10 + rnd.random() * 0.5, cases=rnd.randint(5, 60),
                  service_min=rnd.choice([10, 15, 25])) for k in range(n_stops)]
    frozen_trips = [FrozenTrip(load_no=1, depart_min=hm("06:00"), return_min=hm("09:00"), cases=300)] if frozen else []
    # Room for one stop per load on the 2-stop days, so they make two loads.
    cap = 60 if n_stops == 2 and seed % 4 == 1 else 600
    t = [truck("T01", cap=cap, max_trips=3, fixed_cost=round(rnd.uniform(5, 30), 3), trip_cost=round(rnd.uniform(0.5, 3), 3),
               cost_per_km=round(rnd.uniform(0.03, 0.2), 4), km_per_litre=round(rnd.uniform(2.5, 5), 2), frozen_trips=frozen_trips)]
    r = req(stops, t, driver_cost_per_hour=round(rnd.uniform(1, 7), 3), overtime_after_min=rnd.choice([60, 120, 240]),
            overtime_cost_per_hour=round(rnd.uniform(0.5, 5), 3), fuel_price_per_litre=round(rnd.uniform(0.2, 0.3), 4),
            reload_min=rnd.choice([20, 45]), time_limit_sec=1)
    resp = optimize_dispatch(r)
    assert resp.scenarios
    for sc in resp.scenarios:
        _no_cost_check(sc)
    assert rec(resp).loads


def test_a_cost_mismatch_is_reported_never_a_failed_optimization(monkeypatch):
    """Should the loads ever disagree with the truck days again, the plan still comes back: the
    mismatch is logged and shown as a warning, instead of an error that fails the optimization."""
    monkeypatch.setattr(ds, "COST_TOLERANCE_PER_LOAD", -1.0)  # every scenario "mismatches"
    r = req([stop("A", 23.60, 58.45)], [truck("T01", fixed_cost=10.0)], driver_cost_per_hour=2.0, time_limit_sec=1)
    sc = rec(optimize_dispatch(r))
    assert sc.status == "OPTIMIZED" and sc.loads
    assert any(w.startswith("Cost check") for w in sc.warnings)
