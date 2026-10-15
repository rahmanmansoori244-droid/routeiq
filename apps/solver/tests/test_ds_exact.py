"""Decision support, exact oracle (DESIGN.md section 5): every plan of a small day enumerated under the engine's
rules. The oracle is checked against a brute force that times every plan with the ENGINE's own exact timing
(load_repack.time_plan, one LP per truck) and prices it with load_repack.score, and the engine is checked
against the oracle on random small synthetic days (never a zero cash gap: only that it never beats it)."""
from __future__ import annotations

import itertools

import pytest

import costing
import dispatch_solver as ds
import load_repack as LR
from decision_support import core, exact, ivms
from dispatch_models import FrozenTrip
from tests.test_dispatch import hm, req, stop, truck

NO_EARLY = {1: 0.0, 2: 0.0, 3: 0.0, 4: 0.0, 5: 0.0}  # no ARTIFICIAL time prices: the engine's LP then times for cash


def brute_force(r) -> tuple[int, float, int]:
    """(service value, cash OMR, stops served) of the best plan of a tiny day, found by timing EVERY plan
    (every split of the stops between the trucks or left out, every order) with load_repack.time_plan and
    pricing it with load_repack.score: the engine's own exact machinery, independent of the oracle's timing."""
    rr = core.offline(r)
    cfg = rr.config
    tds = ds._truck_days(rr)
    stops = sorted(rr.stops, key=lambda s: s.stop_id)
    mx = ds.resolve_matrix([(rr.depot.lat, rr.depot.lng)] + [(s.lat, s.lng) for s in stops], provider="HAVERSINE",
                           osrm_url=None, haversine_multiplier=cfg.haversine_multiplier,
                           avg_speed_kmh=cfg.avg_speed_kmh, road_time_factor=cfg.road_time_factor)
    ctx = ds._stage_ctx(rr, stops, tds, mx, [])
    usable = [td.idx for td in tds if td.usable]
    n = len(stops)
    best = None
    for slots in itertools.product(range(len(usable) + 1), repeat=n):
        groups = [[k for k in range(n) if slots[k] == i] for i in range(len(usable))]
        for orders in itertools.product(*(itertools.permutations(g) for g in groups)):
            plan = {usable[i]: [tuple(o)] for i, o in enumerate(orders) if o}
            timed = LR.time_plan(ctx.day, plan, ctx.rec_pricing)
            if timed is None:
                continue
            sc = LR.score(ctx.day, ctx.rec_pricing, timed)
            key = (sc.unserved, sc.operating, -sum(len(o) for o in orders))
            if best is None or key < best:
                best = key
    unserved, operating, served = best
    return sum(ctx.values) - unserved, operating / costing.COST_SCALE, -served


def two_trucks():
    """Five stops, two one-load trucks of 100 and 60 cases: windows, priorities, overtime after 4 hours."""
    stops = [
        stop("a", 23.600, 58.450, cases=40, priority=1, service_min=20, hard_start_min=hm("07:00"), hard_end_min=hm("09:00")),
        stop("b", 23.620, 58.500, cases=30, priority=2, service_min=15),
        stop("c", 23.650, 58.300, cases=30, priority=3, service_min=15, hard_start_min=hm("10:00"), hard_end_min=hm("11:00")),
        stop("d", 23.550, 58.200, cases=20, priority=4, service_min=10, hard_start_min=hm("07:00"), hard_end_min=hm("08:00")),
        stop("e", 23.700, 58.600, cases=40, priority=5, service_min=25),
    ]
    trucks = [truck("T1", cap=100, fixed_cost=10, cost_per_km=0.08, km_per_litre=4.0, max_trips=1),
              truck("T2", cap=60, fixed_cost=6, cost_per_km=0.05, km_per_litre=5.0, max_trips=1)]
    return req(stops, trucks, shift_start_min=hm("06:30"), shift_max_min=360, latest_return_min=hm("13:00"),
               overtime_after_min=240, overtime_cost_per_hour=4.0, driver_cost_per_hour=2.5, fuel_price_per_litre=0.26,
               early_preference_per_min=NO_EARLY)


def midday_break():
    """One truck through the 12:00-13:00 break window (45 min), FINISH rule, and one customer's order split
    over two stops (no break between them)."""
    split = [stop(sid, 23.550, 58.330, cases=15, priority=3, service_min=20, hard_start_min=hm("13:00"),
                  hard_end_min=hm("16:00")).model_copy(update={"customer_id": "c-split"}) for sid in ("c1", "c2")]
    stops = [
        stop("a", 23.620, 58.480, cases=20, priority=1, service_min=30, hard_start_min=hm("09:00"), hard_end_min=hm("10:00")),
        stop("b", 23.660, 58.250, cases=20, priority=2, service_min=30, hard_start_min=hm("11:30"), hard_end_min=hm("13:15")),
        *split,
    ]
    return req(stops, [truck("T1", cap=200, fixed_cost=12, cost_per_km=0.06, km_per_litre=4.0, max_trips=1)],
               shift_start_min=hm("07:00"), shift_max_min=600, latest_return_min=hm("18:00"), window_rule="FINISH",
               break_min=45, break_start_from_min=hm("12:00"), break_start_to_min=hm("13:00"), overtime_after_min=420,
               driver_cost_per_hour=2.5, fuel_price_per_litre=0.26, early_preference_per_min=NO_EARLY)


def pallets():
    """Bay trucks at 90% fill with the one-customer rule (100%), a small-truck-only customer, and loading
    that starts at 08:00 (the first load leaves after reload + loading of its cases)."""
    stops = [
        stop("x1", 23.600, 58.440, cases=300, demand_pallet_units=3800, service_min=25, priority=2),
        stop("x2", 23.615, 58.560, cases=100, demand_pallet_units=1500, service_min=15, priority=3,
             allowed_truck_ids=["S"], hard_start_min=hm("09:00"), hard_end_min=hm("12:00")),
        stop("x3", 23.640, 58.330, cases=150, demand_pallet_units=2000, service_min=20, priority=3),
        stop("x4", 23.520, 58.480, cases=500, demand_pallet_units=6000, service_min=40, priority=4,
             hard_start_min=hm("10:00"), hard_end_min=hm("13:00")),
    ]
    trucks = [truck("S", cap=380, bays=4, fixed_cost=8, cost_per_km=0.04, km_per_litre=4.0, max_trips=1),
              truck("L", cap=1140, bays=12, fixed_cost=24, cost_per_km=0.07, km_per_litre=3.5, max_trips=1)]
    return req(stops, trucks, shift_start_min=hm("07:00"), latest_return_min=hm("16:00"), pallet_fill_pct=90,
               single_customer_fill_pct=100, loading_from_min=hm("08:00"), loading_min_per_case=0.05, reload_min=20,
               window_rule="FINISH", driver_cost_per_hour=2.5, fuel_price_per_litre=0.26, early_preference_per_min=NO_EARLY)


def two_breaks():
    """Two far customers that each force a 45-min break starting 12:00-13:00 at a different place: Quriyat
    (2 h away, open 13:00-13:30) only with the break on the way out, Bidbid (1 h away, open 11:30-12:30, a
    60-min unloading) only with the break on the way back."""
    stops = [stop("q", 23.263, 58.916, cases=20, priority=2, service_min=30, hard_start_min=hm("13:00"), hard_end_min=hm("13:30")),
             stop("m", 23.408, 58.128, cases=20, priority=2, service_min=60, hard_start_min=hm("11:30"), hard_end_min=hm("12:30"))]
    trucks = [truck(t, cap=200, fixed_cost=10, cost_per_km=0.06, km_per_litre=4.0, max_trips=1) for t in ("T1", "T2")]
    return req(stops, trucks, shift_start_min=hm("07:00"), shift_max_min=600, latest_return_min=hm("19:00"),
               break_min=45, break_start_from_min=hm("12:00"), break_start_to_min=hm("13:00"), overtime_after_min=480,
               driver_cost_per_hour=2.5, fuel_price_per_litre=0.26, early_preference_per_min=NO_EARLY)


DAYS = {"two_trucks": two_trucks, "midday_break": midday_break, "pallets": pallets, "two_breaks": two_breaks}


@pytest.mark.parametrize("name", ["two_trucks", "midday_break", "pallets", "two_breaks"])
def test_the_oracle_finds_the_brute_force_optimum_of_hand_made_days(name):
    r = DAYS[name]()
    res = exact.solve_small(r)
    value, cash, served = brute_force(r)
    assert res.complete and res.claim.startswith("OPTIMAL")
    assert res.verified  # the engine's timing_ok / fits_truck accept the plan and score prices it the same
    assert res.service_value == value
    assert res.cash.total == pytest.approx(cash, abs=1e-4)
    assert len(res.served) == served
    assert res.max_served >= served


def test_the_hand_made_days_use_what_they_were_built_for():
    brk = exact.solve_small(midday_break())
    assert len(brk.served) == 4 and any(r.break_start_s is not None for r in brk.routes)
    pal = exact.solve_small(pallets())
    loads = {r.truck_id: set(r.stop_ids) for r in pal.routes}
    assert "x2" not in loads.get("L", set())  # small truck only
    assert "x4" not in loads.get("S", set())  # 6 pallets fit only the big truck
    two = exact.solve_small(two_trucks())
    assert two.served_by_priority[1] == 1 and two.cash.total > 0
    res = exact.solve_small(two_breaks())
    far = {r.stop_ids: r for r in res.routes}
    assert set(far) == {("q",), ("m",)}
    assert far[("q",)].break_leg == 0 and far[("m",)].break_leg == 1  # on the way out / on the way back
    back = res.oracle.T[res.oracle.idx_of["m"] + 1][0]
    assert far[("m",)].return_s - far[("m",)].starts_s[0] == (60 + 45) * 60 + back  # unload, drive back with the break


@pytest.mark.parametrize("seed", [2, 19, 22, 27])
def test_the_oracle_finds_the_brute_force_optimum_of_random_small_days(seed):
    """Late starts with a driver break, a tight return with a small-truck-only customer, two small trucks."""
    r, _ = exact.random_instance(seed, max_stops=5)
    r.config.pref_window_penalty_per_min = 0.0  # the brute force's LP then times for cash alone
    r.config.early_preference_per_min = dict(NO_EARLY)
    res = exact.solve_small(r)
    value, cash, served = brute_force(r)
    assert res.complete and res.verified
    assert (res.service_value, len(res.served)) == (value, served)
    assert res.cash.total == pytest.approx(cash, abs=1e-4)


def test_stops_no_truck_can_serve_are_proven_never_servable_and_the_engine_leaves_them_out(monkeypatch):
    monkeypatch.setenv("SOLVER_PARALLEL", "0")
    stops = [stop("near", 23.600, 58.420, cases=30, priority=3),
             stop("near2", 23.610, 58.470, cases=40, priority=4),
             stop("far", 23.950, 58.950, cases=10, priority=1, hard_start_min=hm("06:00"), hard_end_min=hm("06:30")),
             stop("huge", 23.605, 58.430, cases=900, priority=2)]
    r = req(stops, [truck("T1", cap=400, fixed_cost=10, cost_per_km=0.1, max_trips=1)], driver_cost_per_hour=2.5)
    res = exact.solve_small(r)
    assert res.never_servable == {"far": "TIME", "huge": "CAPACITY"}
    assert set(res.single_stop_infeasible) == {"far", "huge"}
    assert set(res.served) == {"near", "near2"} and res.max_served == 2
    (c,) = exact.compare_with_engine(r, core.Budget(time_limit_sec=1, seeds=(1,)), result=res)
    assert c.oracle_feasible and c.proven_but_served == [] and c.engine_false_proofs == []
    assert c.engine_served == 2 and c.service_equal
    assert c.gap_omr is not None and c.gap_omr >= -exact.TOL_OMR


def test_days_the_oracle_cannot_solve_exactly_are_refused():
    one = [truck("T1", max_trips=1)]
    with pytest.raises(exact.OracleRefused, match="at most 8"):
        exact.solve_small(req([stop(f"s{i}", 23.60, 58.40 + 0.01 * i) for i in range(9)], one))
    small = [stop("s1", 23.60, 58.42)]
    with pytest.raises(exact.OracleRefused, match="trucks"):
        exact.solve_small(req(small, [truck(f"T{i}", max_trips=1) for i in range(3)]))
    with pytest.raises(exact.OracleRefused, match="max_trips 1"):
        exact.solve_small(req(small, [truck("T1")]))  # the config allows 3 loads per truck
    with pytest.raises(exact.OracleRefused, match="frozen"):
        exact.solve_small(req(small, [truck("T1", max_trips=2, frozen_trips=[FrozenTrip(load_no=1, depart_min=400, return_min=500)])]))
    with pytest.raises(exact.OracleRefused, match="rent"):
        exact.solve_small(req(small, [truck("T1", max_trips=1, hire_candidate=True)]))
    assert exact.solve_small(req(small, one), max_stops=1).complete


def test_the_answer_does_not_depend_on_the_order_of_the_stops():
    r = two_trucks()
    a, b = exact.solve_small(r), exact.solve_small(core.seeded(r, 7))
    assert (a.served, a.cash, a.routes, a.never_servable) == (b.served, b.cash, b.routes, b.never_servable)


def test_count_objective_serves_more_stops_where_strict_priorities_serve_one_higher():
    stops = [stop("p1", 23.60, 58.42, cases=100, priority=1), stop("p3a", 23.61, 58.43, cases=50, priority=3),
             stop("p3b", 23.62, 58.44, cases=50, priority=3)]
    r = req(stops, [truck("T1", cap=100, max_trips=1)])
    engine_like = exact.solve_small(r)
    most = exact.solve_small(r, objective="COUNT")
    assert engine_like.served == ("p1",) and set(most.served) == {"p3a", "p3b"}
    assert engine_like.max_served == most.max_served == 2
    assert engine_like.service_value > most.service_value


def test_ivms_speeds_and_the_slow_factor_come_from_the_committed_aggregates():
    agg = ivms.load()
    for band in exact.IVMS_BANDS:
        speed, basis = exact.ivms_speed_kmh(band)
        assert speed == agg["ivms_raw"]["travel_speed_kmh"]["by_region_band"]["Muscat"][band]["p50"]
        assert "IVMS" in basis and band in basis
    factor, basis = exact.ivms_slow_factor()
    assert 1.0 < factor < 2.0 and "IVMS" in basis


def test_a_slow_day_breaks_a_tight_optimal_plan():
    res = exact.solve_small(two_trucks())
    assert res.survives(1.0)
    assert not res.survives(3.0)  # every drive three times as long: a window or the 13:00 return fails


def test_random_instances_are_small_synthetic_days_with_ivms_speeds():
    a, ia = exact.random_instance(5)
    b, ib = exact.random_instance(5)
    assert a == b and ia == ib
    for seed in range(1, 25):
        r, info = exact.random_instance(seed, max_stops=7)
        assert 3 <= len(r.stops) <= 7 and len(r.trucks) in (1, 2) and info["label"] == "SYNTHETIC"
        assert all(t.max_trips == 1 for t in r.trucks) and r.config.max_trips_per_truck == 1
        assert r.config.avg_speed_kmh == exact.ivms_speed_kmh(info["ivms_band"])[0]
        exact.Oracle(r, max_stops=7)  # inside what the oracle solves


@pytest.mark.parametrize("seed", range(15))
def test_the_engine_never_beats_the_oracle_on_random_small_days(seed, monkeypatch):
    monkeypatch.setenv("SOLVER_PARALLEL", "0")
    r, info = exact.random_instance(100 + seed, max_stops=6, time_limit_sec=1)
    res = exact.solve_small(r, max_stops=6)
    assert res.complete and res.verified
    (c,) = exact.compare_with_engine(r, core.Budget(time_limit_sec=1, seeds=(1,)), result=res)
    assert c.oracle_feasible, c.infeasible_loads
    assert c.proven_but_served == [] and c.engine_false_proofs == []
    assert c.engine_served <= res.max_served and c.engine_service_le_oracle
    assert c.engine_loads_least_cash <= c.engine_cash + exact.TOL_OMR  # the oracle times the engine's own loads
    assert c.oracle_cash_same_stops <= c.engine_loads_least_cash + exact.TOL_OMR
    if c.service_equal:
        assert c.gap_omr >= -exact.TOL_OMR
    # Reported, not asserted: the gap (pytest -s shows it).
    print(f"seed {info['seed']}: {info['stops']} stops, served engine {c.engine_served} / oracle {c.oracle_served}, "
          f"gap {c.gap_omr} OMR ({c.gap_pct}%), timing gap {c.timing_gap_omr} OMR")


def test_an_enumeration_stopped_early_claims_nothing(monkeypatch):
    monkeypatch.setenv("SOLVER_PARALLEL", "0")
    r, _ = exact.random_instance(20, max_stops=8, time_limit_sec=1)
    res = exact.solve_small(r, max_stops=8, max_sec=0.001)
    assert not res.complete and res.claim.startswith("BEST FOUND")
    # Best-found values are not "the least cash" or "the most served": nothing is proven.
    assert res.max_served is None and res.never_servable is None and res.cash_for(res.served) is None
    (c,) = exact.compare_with_engine(r, core.Budget(time_limit_sec=1, seeds=(1,)), result=res)
    assert not c.oracle_complete and c.oracle_max_served is None
    assert (c.oracle_cash_same_stops, c.gap_omr, c.gap_same_stops_omr, c.routing_gap_omr) == (None, None, None, None)
