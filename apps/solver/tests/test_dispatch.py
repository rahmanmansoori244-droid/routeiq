"""Deterministic correctness tests for the NMWC dispatch optimizer (OR-Tools).

All tests use the Haversine provider (no network) unless they are explicitly about OSRM,
where the HTTP layer is replaced by httpx.MockTransport.
"""
from __future__ import annotations

import json
import math
import random
import time

import httpx
import pytest
from pydantic import ValidationError

from dispatch_models import (
    DispatchConfig,
    DispatchDepot,
    DispatchRequest,
    DispatchStop,
    DispatchTruck,
    FrozenTrip,
)
from dispatch_solver import optimize_dispatch

DEPOT = DispatchDepot(id="ghala", lat=23.5850, lng=58.3900)


def hm(s: str) -> int:
    h, m = s.split(":")
    return int(h) * 60 + int(m)


def stop(sid: str, lat: float, lng: float, cases: int = 10, **kw) -> DispatchStop:
    return DispatchStop(stop_id=sid, order_ids=[f"o-{sid}"], customer_id=f"c-{sid}", lat=lat, lng=lng,
                        demand_cases=cases, **kw)


def truck(tid: str, cap: int = 500, **kw) -> DispatchTruck:
    return DispatchTruck(id=tid, code=tid, capacity_cases=cap, **kw)


def req(stops, trucks, **cfg) -> DispatchRequest:
    cfg.setdefault("distance_provider", "HAVERSINE")
    cfg.setdefault("scenarios", ["RECOMMENDED"])
    cfg.setdefault("time_limit_sec", 2)
    return DispatchRequest(run_id="r", tenant_id="t", depot=DEPOT, trucks=trucks, stops=stops,
                           config=DispatchConfig(**cfg))


def rec(resp):
    return next(s for s in resp.scenarios if s.name == "RECOMMENDED")


def served_ids(sc) -> set[str]:
    return {st.stop_id for ld in sc.loads for st in ld.stops}


def unserved_map(sc) -> dict[str, str]:
    return {u.stop_id: u.reason_code for u in sc.unserved}


def assert_reconciled(r: DispatchRequest, sc) -> None:
    ids = [st.stop_id for ld in sc.loads for st in ld.stops] + [u.stop_id for u in sc.unserved]
    assert sorted(ids) == sorted(s.stop_id for s in r.stops), "every stop exactly once"
    planned = sum(ld.cases for ld in sc.loads)
    unserved = sum(next(s.demand_cases for s in r.stops if s.stop_id == u.stop_id) for u in sc.unserved)
    assert planned + unserved == sum(s.demand_cases for s in r.stops)
    for ld in sc.loads:
        assert ld.cases == sum(st.cases for st in ld.stops)


# --------------------------------------------------------------------------------------
# PRIORITY — mandatory: P1 must win a capacity conflict against an identical P5
# --------------------------------------------------------------------------------------

@pytest.mark.parametrize("p5_first", [True, False])
def test_priority_p1_beats_identical_p5(p5_first):
    a = stop("P1", 23.60, 58.45, cases=80, priority=1)
    b = stop("P5", 23.60, 58.45, cases=80, priority=5)
    stops = [b, a] if p5_first else [a, b]
    r = req(stops, [truck("T01", cap=100, max_trips=1)])
    sc = rec(optimize_dispatch(r))
    assert served_ids(sc) == {"P1"}, "PRIORITY LOGIC IS BROKEN: P5 was selected over P1"
    assert unserved_map(sc) == {"P5": "SOLVER_DROPPED_LOW_PRIORITY"}
    assert_reconciled(r, sc)


def test_priority_ladder_under_shortage():
    # Five identical stops P1..P5, room for three -> P1, P2, P3 served; P4, P5 unserved.
    stops = [stop(f"S{p}", 23.60 + p * 0.001, 58.45, cases=50, priority=p) for p in (5, 3, 1, 4, 2)]
    r = req(stops, [truck("T01", cap=150, max_trips=1)])
    sc = rec(optimize_dispatch(r))
    assert served_ids(sc) == {"S1", "S2", "S3"}
    assert set(unserved_map(sc)) == {"S4", "S5"}


def test_p1_beats_many_low_priority_stops_and_extra_cost():
    # One far P1 stop vs. three close P5 stops; truck holds 100 cases. P1 must be served even
    # though serving the three P5s would deliver more cases for less km.
    far_p1 = stop("FAR_P1", 23.90, 58.10, cases=100, priority=1)
    near = [stop(f"N{i}", 23.586 + i * 0.001, 58.391, cases=33, priority=5) for i in range(3)]
    r = req([*near, far_p1], [truck("T01", cap=100, max_trips=1)])
    sc = rec(optimize_dispatch(r))
    assert "FAR_P1" in served_ids(sc)


def test_inverted_priority_weights_rejected():
    with pytest.raises(ValidationError):
        DispatchConfig(priority_weights={1: 1, 2: 10, 3: 100, 4: 1000, 5: 10000})


# --------------------------------------------------------------------------------------
# TIME WINDOWS
# --------------------------------------------------------------------------------------

def test_hard_windows_both_respected():
    a = stop("A", 23.62, 58.50, hard_start_min=hm("06:00"), hard_end_min=hm("09:00"))
    b = stop("B", 23.55, 58.30, hard_start_min=hm("09:00"), hard_end_min=hm("15:00"))
    r = req([b, a], [truck("T01", max_trips=1)], shift_start_min=hm("06:00"))
    sc = rec(optimize_dispatch(r))
    assert served_ids(sc) == {"A", "B"}
    for ld in sc.loads:
        for st in ld.stops:
            s = next(x for x in r.stops if x.stop_id == st.stop_id)
            assert s.hard_start_min <= st.service_start_min <= s.hard_end_min, st
            assert st.hard_window_ok


def test_hard_window_forces_order_against_distance():
    # B is on the way out but only opens at 11:00; A must be served before 08:00.
    a = stop("A", 23.70, 58.20, hard_start_min=hm("06:00"), hard_end_min=hm("08:00"))
    b = stop("B", 23.60, 58.35, hard_start_min=hm("11:00"), hard_end_min=hm("13:00"))
    r = req([a, b], [truck("T01", max_trips=1)], shift_start_min=hm("06:00"))
    sc = rec(optimize_dispatch(r))
    seq = [st.stop_id for st in sc.loads[0].stops]
    assert seq == ["A", "B"]
    b_st = sc.loads[0].stops[1]
    assert b_st.service_start_min >= hm("11:00")
    assert b_st.wait_min >= 0


def test_unreachable_hard_window_reported_not_hidden():
    # 06:00-06:10 window 60+ km away with a 06:00 departure: impossible.
    c = stop("C", 24.10, 58.00, hard_start_min=hm("06:00"), hard_end_min=hm("06:10"))
    ok = stop("OK", 23.60, 58.40)
    r = req([c, ok], [truck("T01")], shift_start_min=hm("06:00"))
    sc = rec(optimize_dispatch(r))
    assert unserved_map(sc) == {"C": "HARD_WINDOW_INFEASIBLE"}
    assert served_ids(sc) == {"OK"}
    assert_reconciled(r, sc)


def test_preferred_window_is_soft_and_honoured_when_possible():
    a = stop("A", 23.60, 58.42, pref_start_min=hm("10:00"), pref_end_min=hm("11:00"))
    r = req([a], [truck("T01")], shift_start_min=hm("06:00"))
    sc = rec(optimize_dispatch(r))
    st = sc.loads[0].stops[0]
    assert hm("10:00") <= st.service_start_min <= hm("11:00")
    assert st.pref_window_ok


def test_preferred_window_violation_allowed_but_penalised():
    # Two stops at the same spot share a narrow preferred window; one must go outside it.
    a = stop("A", 23.60, 58.42, service_min=40, pref_start_min=hm("07:00"), pref_end_min=hm("07:30"))
    b = stop("B", 23.6001, 58.4201, service_min=40, pref_start_min=hm("07:00"), pref_end_min=hm("07:30"))
    r = req([a, b], [truck("T01", max_trips=1)], shift_start_min=hm("06:00"))
    sc = rec(optimize_dispatch(r))
    assert served_ids(sc) == {"A", "B"}
    assert sum(not st.pref_window_ok for st in sc.loads[0].stops) >= 1
    assert sc.objective.window_penalty > 0


def test_morning_hypermarket_and_broad_grocery_mix():
    hyper = [stop(f"H{i}", 23.58 + i * 0.01, 58.40 + i * 0.01, cases=60, priority=1,
                  hard_start_min=hm("06:00"), hard_end_min=hm("10:00"), service_min=30) for i in range(3)]
    groc = [stop(f"G{i}", 23.60 - i * 0.01, 58.35 + i * 0.01, cases=20, priority=4,
                 hard_start_min=hm("08:00"), hard_end_min=hm("20:00")) for i in range(6)]
    r = req([*groc, *hyper], [truck("T01", cap=300), truck("T02", cap=300)], shift_start_min=hm("06:00"))
    sc = rec(optimize_dispatch(r))
    assert served_ids(sc) == {s.stop_id for s in r.stops}
    for ld in sc.loads:
        for st in ld.stops:
            if st.stop_id.startswith("H"):
                assert st.service_start_min <= hm("10:00")
    assert_reconciled(r, sc)


# --------------------------------------------------------------------------------------
# MULTI-LOAD PER PHYSICAL TRUCK
# --------------------------------------------------------------------------------------

def _loads_by_truck(sc):
    out: dict[str, list] = {}
    for ld in sc.loads:
        out.setdefault(ld.truck_id, []).append(ld)
    for v in out.values():
        v.sort(key=lambda l: l.load_no)
    return out


def test_one_truck_three_loads_sequential_with_reload():
    stops = [stop(f"S{i}", 23.60 + i * 0.02, 58.45, cases=90) for i in range(3)]
    r = req(stops, [truck("T01", cap=100)], shift_start_min=hm("07:00"), reload_min=30, max_trips_per_truck=3)
    sc = rec(optimize_dispatch(r))
    lds = _loads_by_truck(sc)["T01"]
    assert [l.load_no for l in lds] == [1, 2, 3]
    assert lds[0].depart_min >= hm("07:00")
    for a, b in zip(lds, lds[1:]):
        assert b.depart_min >= a.return_min + 30, (a.return_min, b.depart_min)
    assert_reconciled(r, sc)


def test_second_load_not_before_return_plus_reload_example():
    # Business example: Load 1 07:00 -> ~09:30, reload 30 min => Load 2 not before ~10:00.
    far = stop("FAR", 23.95, 57.95, cases=100, service_min=20)  # long first trip
    near = stop("NEAR", 23.59, 58.40, cases=100)
    r = req([far, near], [truck("T01", cap=100)], shift_start_min=hm("07:00"), reload_min=30)
    sc = rec(optimize_dispatch(r))
    lds = _loads_by_truck(sc)["T01"]
    assert len(lds) == 2
    assert lds[1].depart_min >= lds[0].return_min + 30


def test_two_loads_two_trucks_never_overlap_per_truck():
    stops = [stop(f"S{i}", 23.55 + (i % 5) * 0.03, 58.30 + (i // 5) * 0.05, cases=45) for i in range(10)]
    r = req(stops, [truck("T01", cap=100), truck("T02", cap=100)], reload_min=20)
    sc = rec(optimize_dispatch(r))
    for tid, lds in _loads_by_truck(sc).items():
        for a, b in zip(lds, lds[1:]):
            assert b.depart_min >= a.return_min + 20
            assert b.load_no == a.load_no + 1
    assert_reconciled(r, sc)


def test_trip_limit_leaves_order_unserved_with_reason():
    stops = [stop(f"S{i}", 23.60 + i * 0.01, 58.45, cases=100, priority=3) for i in range(3)]
    r = req(stops, [truck("T01", cap=100, max_trips=2)])
    sc = rec(optimize_dispatch(r))
    assert len(sc.loads) == 2
    assert len(sc.unserved) == 1
    assert sc.unserved[0].reason_code == "SOLVER_DROPPED_LOW_PRIORITY"
    assert "capacity" in sc.unserved[0].reason_message.lower()


def test_shift_limit_bounds_truck_day():
    # Each round trip ~3h; shift 5h => at most one load fits even though max_trips=3.
    stops = [stop(f"F{i}", 24.30 + i * 0.01, 57.60, cases=100) for i in range(3)]
    r = req(stops, [truck("T01", cap=100)], shift_max_min=5 * 60, max_trips_per_truck=3)
    sc = rec(optimize_dispatch(r))
    lds = sc.loads
    if lds:
        day = max(l.return_min for l in lds) - min(l.depart_min for l in lds)
        assert day <= 5 * 60
    assert len(sc.unserved) >= 1
    assert_reconciled(r, sc)


def test_round_trip_longer_than_shift_is_shift_limit():
    far = stop("FAR", 26.20, 56.25)  # Musandam-ish, very far
    r = req([far], [truck("T01")], shift_max_min=4 * 60)
    sc = rec(optimize_dispatch(r))
    assert unserved_map(sc) == {"FAR": "SHIFT_LIMIT"}


# --------------------------------------------------------------------------------------
# LOCKED / DISPATCHED (frozen) loads during replanning
# --------------------------------------------------------------------------------------

def test_frozen_trip_blocks_truck_until_return_plus_reload():
    s = stop("NEW", 23.60, 58.45, cases=50, priority=1, late=True)
    t = truck("T01", cap=100, frozen_trips=[FrozenTrip(load_no=1, depart_min=hm("07:00"), return_min=hm("09:30"), cases=90)])
    r = req([s], [t], reload_min=30)
    sc = rec(optimize_dispatch(r))
    assert len(sc.loads) == 1
    ld = sc.loads[0]
    assert ld.load_no == 2, "new load must be numbered after the frozen load"
    assert ld.depart_min >= hm("10:00")


def test_frozen_trips_exhaust_trip_limit():
    s = stop("NEW", 23.60, 58.45, cases=10, late=True)
    t = truck("T01", cap=100, max_trips=1, frozen_trips=[FrozenTrip(load_no=1, depart_min=hm("07:00"), return_min=hm("09:00"))])
    r = req([s], [t])
    sc = rec(optimize_dispatch(r))
    assert unserved_map(sc) == {"NEW": "TRIP_LIMIT"}


def test_late_order_goes_to_other_truck_when_first_is_frozen():
    late = stop("LATE", 23.60, 58.45, cases=40, priority=1, late=True)
    t1 = truck("T01", cap=100, max_trips=1, frozen_trips=[FrozenTrip(load_no=1, depart_min=hm("06:30"), return_min=hm("10:00"))])
    t2 = truck("T02", cap=100)
    r = req([late], [t1, t2])
    sc = rec(optimize_dispatch(r))
    assert [(l.truck_id, l.load_no) for l in sc.loads] == [("T02", 1)]


def test_late_order_without_capacity_gets_late_reason():
    base = stop("BASE", 23.60, 58.45, cases=100, priority=1)
    late = stop("LATE", 23.61, 58.45, cases=100, priority=5, late=True)
    r = req([base, late], [truck("T01", cap=100, max_trips=1)])
    sc = rec(optimize_dispatch(r))
    assert unserved_map(sc) == {"LATE": "LATE_ORDER_NO_CAPACITY"}


# --------------------------------------------------------------------------------------
# CAPACITY
# --------------------------------------------------------------------------------------

def test_case_capacity_is_hard():
    stops = [stop(f"S{i}", 23.60 + i * 0.001, 58.45, cases=60) for i in range(5)]
    r = req(stops, [truck("T01", cap=200, max_trips=1)])
    sc = rec(optimize_dispatch(r))
    assert all(ld.cases <= 200 for ld in sc.loads)
    assert sum(ld.cases for ld in sc.loads) == 180
    assert_reconciled(r, sc)


def test_weight_capacity_is_hard_when_payload_set():
    # 3 x 40 cases fits the 200-case limit, but 3 x 900 kg exceeds a 2000 kg payload.
    stops = [stop(f"S{i}", 23.60 + i * 0.001, 58.45, cases=40, demand_kg=900) for i in range(3)]
    r = req(stops, [truck("T01", cap=200, capacity_kg=2000, max_trips=1)])
    sc = rec(optimize_dispatch(r))
    assert all(ld.kg <= 2000 for ld in sc.loads)
    assert len(sc.unserved) == 1


def test_order_bigger_than_any_truck():
    big = stop("BIG", 23.60, 58.45, cases=900)
    r = req([big], [truck("T01", cap=500), truck("T02", cap=600)])
    sc = rec(optimize_dispatch(r))
    assert unserved_map(sc) == {"BIG": "EXCEEDS_ANY_TRUCK_CAPACITY"}


def test_single_case_heavier_than_every_payload_is_reported():
    # Review F01: a split part holding one 120 kg case is now sent with its true weight. With
    # 100 kg trucks it must come back EXCEEDS_ANY_TRUCK_CAPACITY, not be planned over payload.
    heavy = stop("HEAVY", 23.60, 58.45, cases=1, demand_kg=120)
    r = req([heavy], [truck("T01", cap=100, capacity_kg=100), truck("T02", cap=100, capacity_kg=100)])
    sc = rec(optimize_dispatch(r))
    assert unserved_map(sc) == {"HEAVY": "EXCEEDS_ANY_TRUCK_CAPACITY"}
    assert "120 kg vs largest payload 100 kg" in sc.unserved[0].reason_message


def test_heavy_cases_go_only_on_the_truck_that_can_carry_them():
    # SMALL has trips to spare but a 100 kg payload; only BIG may carry a 120 kg case.
    stops = [stop(f"H{i}", 23.60 + i * 0.001, 58.45, cases=1, demand_kg=120) for i in range(3)]
    r = req(stops, [truck("SMALL", cap=100, capacity_kg=100, max_trips=5), truck("BIG", cap=100, capacity_kg=1000, max_trips=1)])
    sc = rec(optimize_dispatch(r))
    assert sc.loads, "BIG can carry all three"
    for ld in sc.loads:
        assert ld.truck_id == "BIG"
        assert ld.kg <= 1000
    assert_reconciled(r, sc)


def test_fleet_capacity_shortage_reason():
    stops = [stop(f"S{i}", 23.60 + i * 0.002, 58.45, cases=100, priority=3) for i in range(5)]
    r = req(stops, [truck("T01", cap=100, max_trips=2)])
    sc = rec(optimize_dispatch(r))
    assert len(sc.unserved) == 3
    assert all("shortage" in u.reason_message.lower() for u in sc.unserved)


def test_no_trucks():
    r = req([stop("A", 23.6, 58.4)], [])
    sc = rec(optimize_dispatch(r))
    assert unserved_map(sc) == {"A": "NO_AVAILABLE_TRUCK"}


# --------------------------------------------------------------------------------------
# ECONOMICS
# --------------------------------------------------------------------------------------

def test_fuel_counted_once_and_costs_reconcile():
    s = stop("A", 23.70, 58.20)
    t = truck("T01", cost_per_km=0.10, km_per_litre=5.0, fixed_cost=20)
    r = req([s], [t], fuel_price_per_litre=0.25, driver_cost_per_hour=2.0)
    sc = rec(optimize_dispatch(r))
    ld = sc.loads[0]
    assert ld.fuel_litres == pytest.approx(ld.distance_km / 5.0, abs=0.1)
    assert ld.fuel_cost == pytest.approx(ld.distance_km / 5.0 * 0.25, abs=0.01)
    assert ld.distance_cost == pytest.approx(ld.distance_km * 0.10, abs=0.01)
    assert ld.total_cost == pytest.approx(ld.fixed_cost + ld.distance_cost + ld.fuel_cost + ld.time_cost, abs=0.01)
    assert ld.fixed_cost == 20


def test_margin_breaks_ties_within_same_priority():
    lo = stop("LO", 23.60, 58.45, cases=80, priority=3, margin=5.0)
    hi = stop("HI", 23.60, 58.45, cases=80, priority=3, margin=40.0)
    r = req([lo, hi], [truck("T01", cap=100, max_trips=1)])
    sc = rec(optimize_dispatch(r))
    assert served_ids(sc) == {"HI"}
    assert sc.objective.margin_served == pytest.approx(40.0)


def test_margin_never_outranks_priority():
    p2 = stop("P2", 23.60, 58.45, cases=80, priority=2, margin=1.0)
    p3 = stop("P3", 23.60, 58.45, cases=80, priority=3, margin=5000.0)
    r = req([p3, p2], [truck("T01", cap=100, max_trips=1)])
    sc = rec(optimize_dispatch(r))
    assert served_ids(sc) == {"P2"}


def test_no_profit_claim_without_margin_data():
    a = stop("A", 23.60, 58.45, margin=10.0)
    b = stop("B", 23.61, 58.45)  # no margin
    r = req([a, b], [truck("T01")])
    sc = rec(optimize_dispatch(r))
    assert sc.objective.margin_served is None


def test_scenarios_min_trucks_not_more_trucks_than_min_distance():
    rnd = random.Random(7)
    stops = [stop(f"S{i}", 23.50 + rnd.random() * 0.2, 58.20 + rnd.random() * 0.4, cases=rnd.randint(10, 60))
             for i in range(25)]
    trucks = [truck(f"T{i:02d}", cap=300, fixed_cost=25, cost_per_km=0.2) for i in range(1, 6)]
    r = req(stops, trucks, scenarios=["RECOMMENDED", "MIN_TRUCKS", "MIN_DISTANCE"], time_limit_sec=2)
    resp = optimize_dispatch(r)
    by = {s.name: s for s in resp.scenarios}
    assert by["MIN_TRUCKS"].trucks_used <= by["MIN_DISTANCE"].trucks_used
    for sc in resp.scenarios:
        assert_reconciled(r, sc)
        assert sc.status == "OPTIMIZED"


# --------------------------------------------------------------------------------------
# ROAD DISTANCE PROVIDER
# --------------------------------------------------------------------------------------

def _osrm_ok_transport(calls: list, snap_m: dict[int, float] | None = None):
    """Fake OSRM table. ``snap_m`` = {coordinate index in the request: metres it was moved to reach a road}."""
    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(str(request.url))
        path = request.url.path
        coords = path.split("/")[-1].split(";")
        n_all = len(coords)
        src = [int(x) for x in request.url.params.get("sources", ";".join(map(str, range(n_all)))).split(";")]
        dst = [int(x) for x in request.url.params.get("destinations", ";".join(map(str, range(n_all)))).split(";")]
        # synthetic "road" = 2 km per index step, 3 min per index step
        dist = [[abs(i - j) * 2000.0 for j in dst] for i in src]
        dur = [[abs(i - j) * 180.0 for j in dst] for i in src]
        wp = lambda k: {"distance": (snap_m or {}).get(k, 12.0), "location": [0, 0]}  # noqa: E731
        return httpx.Response(200, json={"code": "Ok", "distances": dist, "durations": dur,
                                         "sources": [wp(k) for k in src], "destinations": [wp(k) for k in dst]})
    return httpx.MockTransport(handler)


def test_osrm_point_far_from_any_road_uses_estimated_legs():
    """A stop OSRM had to move 250 km to reach a road (outside the map, or a wrong pin) must not
    get a fake 'road' distance: its legs fall back to the estimate, with a warning."""
    from providers import OSRMProvider

    calls: list = []
    # 0 = depot (Ghala), 1 = Muscat customer, 2 = Riyadh customer (outside the Oman+UAE map).
    coords = [(23.568, 58.392), (23.600, 58.450), (24.710, 46.680)]
    osrm = OSRMProvider("http://osrm.local:5000", client=httpx.Client(transport=_osrm_ok_transport(calls, snap_m={2: 250_000.0})))
    mx = osrm.get_matrix(coords)
    assert mx.distance_m[0][1] == 2000 and mx.distance_m[1][0] == 2000  # road legs kept
    # Riyadh legs: the ~1,200 km estimate, not the fake 2-4 km "road" OSRM returned after snapping.
    for i, j in [(0, 2), (2, 0), (1, 2), (2, 1)]:
        assert mx.distance_m[i][j] > 1_000_000
    assert mx.patched_cells == 4
    assert any("from any road in the routing map" in w for w in mx.warnings)

    # End to end: the response carries the warning.
    r = req([stop("A", 23.60, 58.45), stop("B", 24.71, 46.68)], [truck("T01")],
            distance_provider="OSRM", osrm_url="http://osrm.local:5000")
    resp = optimize_dispatch(r, osrm_client=httpx.Client(transport=_osrm_ok_transport([], snap_m={2: 250_000.0})))
    assert any("from any road in the routing map" in w for w in resp.warnings)


def test_failing_alternative_is_skipped_not_resolved_in_process(monkeypatch):
    monkeypatch.delenv("SOLVER_PARALLEL", raising=False)
    monkeypatch.setenv("ROUTEIQ_TEST_FAIL_SCENARIO", "MIN_TRUCKS")
    stops = [stop(f"S{i}", 23.55 + i * 0.01, 58.40, cases=20) for i in range(6)]
    r = req(stops, [truck("T01"), truck("T02")], time_limit_sec=2, scenarios=["RECOMMENDED", "MIN_TRUCKS", "MIN_DISTANCE"])
    resp = optimize_dispatch(r)
    assert [s.name for s in resp.scenarios] == ["RECOMMENDED", "MIN_DISTANCE"]
    assert any("MIN_TRUCKS" in w and "skipped" in w for w in rec(resp).warnings)


def test_killed_recommended_worker_fails_fast(monkeypatch):
    """A worker killed mid-solve (e.g. out of memory) must fail the request within seconds,
    not hang until the backstop deadline (2 x time limit + 60 s)."""
    from dispatch_solver import SolveAborted

    monkeypatch.delenv("SOLVER_PARALLEL", raising=False)
    monkeypatch.setenv("ROUTEIQ_TEST_KILL_SCENARIO", "RECOMMENDED")
    stops = [stop(f"S{i}", 23.55 + i * 0.01, 58.40, cases=20) for i in range(6)]
    r = req(stops, [truck("T01")], time_limit_sec=30, scenarios=["RECOMMENDED", "MIN_DISTANCE"])
    t0 = time.perf_counter()
    with pytest.raises(SolveAborted, match="stopped unexpectedly"):
        optimize_dispatch(r)
    assert time.perf_counter() - t0 < 20


def _die(_):
    import os

    os._exit(137)


def _nap(sec):
    time.sleep(sec)
    return sec


@pytest.mark.parametrize("internals", [True, False])
def test_a_dead_worker_loses_only_its_own_task(internals, monkeypatch):
    """Review L23: the pid-diff check aborted EVERY pending task when ANY worker died (a healthy
    6 s task was aborted after 2 s because its sibling died), and the lost task itself was noticed
    only at its deadline. Now each task reports its worker, so only the dead worker's task is lost,
    at once. Canary (internals=False): without Pool's private worker list (an interpreter upgrade
    could remove it) nothing fails - a death is then only noticed at the deadline."""
    import dispatch_solver as ds

    if not internals:
        monkeypatch.setattr(ds, "_POOL_ATTR", "_not_there_any_more")
    w = ds._Workers(2)
    try:
        jobs = {"dies": w.submit(_die, None, "dies"), "naps": w.submit(_nap, 4.0, "naps")}
        t0 = time.monotonic()
        out = ds._await_all(w, jobs, time.monotonic() + 15)
        elapsed = time.monotonic() - t0
        assert out["naps"] == ("ok", 4.0)  # the healthy sibling was never aborted
        if internals:
            assert out["dies"][0] == "lost"
            assert elapsed < 12, elapsed
        else:
            assert w.pids() is None
            assert out["dies"][0] == "timeout" and elapsed >= 14
    finally:
        w.close()


def test_sibling_stage_worker_death_keeps_the_recommended_recheck(monkeypatch):
    """Review L23 end to end: the MIN_TRUCKS post-solve job's worker is killed (out of memory).
    RECOMMENDED's exact re-check, running next to it, is kept (no 'not re-checked' fallback), and
    the request does not wait for the lost job until the end of its budget."""
    monkeypatch.delenv("SOLVER_PARALLEL", raising=False)
    monkeypatch.setenv("ROUTEIQ_TEST_KILL_REPACK", "MIN_TRUCKS")
    monkeypatch.setenv("SOLVER_BUDGET_SEC", "300")
    stops = [stop(f"S{i}", 23.55 + i * 0.01, 58.40, cases=45) for i in range(8)]
    r = req(stops, [truck("T01", cap=100), truck("T02", cap=100)], time_limit_sec=2, loading_min_per_case=0.2,
            scenarios=["RECOMMENDED", "MIN_TRUCKS", "MIN_DISTANCE"])
    t0 = time.perf_counter()
    resp = optimize_dispatch(r)
    assert time.perf_counter() - t0 < 120
    sc = rec(resp)
    assert not any("not re-checked" in w for w in sc.warnings), sc.warnings
    assert sc.feasibility.status == "VERIFIED" and sc.feasibility.timing == "EXACT"
    assert_reconciled(r, sc)


def test_alternatives_skipped_when_the_time_budget_is_used(monkeypatch):
    """The whole request must answer before the web gives up: alternatives are skipped, with a
    warning, when the recommended plan used the budget."""
    monkeypatch.delenv("SOLVER_PARALLEL", raising=False)
    # Room for the recommended plan (3 s search + worker start-up), not for the alternatives
    # (they need their search time + a 20 s grace on top).
    monkeypatch.setenv("SOLVER_BUDGET_SEC", "12")
    stops, trucks = nmwc_day(60)
    r = req(stops, trucks, time_limit_sec=3, scenarios=["RECOMMENDED", "MIN_TRUCKS", "MIN_DISTANCE"])
    t0 = time.perf_counter()
    resp = optimize_dispatch(r)
    assert time.perf_counter() - t0 < 25
    assert [s.name for s in resp.scenarios] == ["RECOMMENDED"]
    assert any("skipped" in w for w in rec(resp).warnings)
    assert_reconciled(r, rec(resp))


def test_osrm_road_matrix_used_when_configured():
    calls: list = []
    client = httpx.Client(transport=_osrm_ok_transport(calls))
    stops = [stop("A", 23.60, 58.45), stop("B", 23.61, 58.46)]
    r = req(stops, [truck("T01")], distance_provider="OSRM", osrm_url="http://osrm.local:5000",
            road_time_factor=1.0)
    resp = optimize_dispatch(r, osrm_client=client)
    assert calls and calls[0].startswith("http://osrm.local:5000/table/v1/driving/")
    assert resp.matrix_provider == "OSRM"
    assert resp.distance_is_estimated is False
    sc = rec(resp)
    # A and B are nodes 1 and 2: depot->A->B->depot or reverse = 2 + 2 + 4 = 8 km
    assert sc.total_distance_km == pytest.approx(8.0, abs=0.01)


def test_osrm_failure_falls_back_to_haversine_with_warning():
    def boom(request):
        raise httpx.ConnectError("unreachable")
    client = httpx.Client(transport=httpx.MockTransport(boom))
    r = req([stop("A", 23.60, 58.45)], [truck("T01")], distance_provider="OSRM", osrm_url="http://osrm.local:5000")
    resp = optimize_dispatch(r, osrm_client=client)
    assert resp.matrix_provider == "HAVERSINE"
    assert resp.distance_is_estimated is True
    assert any("ROUTING_PROVIDER_FAILURE" in w for w in resp.warnings)
    assert served_ids(rec(resp)) == {"A"}


def test_osrm_not_configured_is_labelled_estimated(monkeypatch):
    monkeypatch.delenv("OSRM_URL", raising=False)
    r = req([stop("A", 23.60, 58.45)], [truck("T01")], distance_provider="OSRM", osrm_url=None)
    resp = optimize_dispatch(r)
    assert resp.distance_is_estimated is True
    assert any("not configured" in w for w in resp.warnings)


def test_osrm_tiles_large_matrices():
    calls: list = []
    client = httpx.Client(transport=_osrm_ok_transport(calls))
    stops = [stop(f"S{i}", 23.5 + i * 0.001, 58.3, cases=1) for i in range(120)]
    r = req(stops, [truck("T01", cap=1000)], distance_provider="OSRM", osrm_url="http://osrm.local")
    resp = optimize_dispatch(r, osrm_client=client)
    assert len(calls) > 1  # 121 coords exceed one default OSRM table request
    assert resp.matrix_provider == "OSRM"


# --------------------------------------------------------------------------------------
# REALISTIC DAY / PERFORMANCE / RECONCILIATION
# --------------------------------------------------------------------------------------

def nmwc_day(n: int, seed: int = 1):
    rnd = random.Random(seed)
    stops = []
    for i in range(n):
        kind = rnd.random()
        kw: dict = {}
        if kind < 0.12:  # hypermarket, morning only
            kw = dict(priority=rnd.choice([1, 2]), hard_start_min=hm("06:00"), hard_end_min=hm("11:00"), service_min=30)
            cases = rnd.randint(80, 200)
        elif kind < 0.3:  # trading / catering, closes at noon
            kw = dict(priority=rnd.choice([2, 3]), hard_start_min=hm("07:00"), hard_end_min=hm("12:30"), service_min=15)
            cases = rnd.randint(20, 80)
        else:  # grocery, broad hours
            kw = dict(priority=rnd.choice([3, 4, 5]), hard_start_min=hm("07:00"), hard_end_min=hm("21:00"),
                      pref_start_min=hm("09:00"), pref_end_min=hm("17:00"), service_min=10)
            cases = rnd.randint(5, 40)
        stops.append(stop(f"S{i:03d}", 23.45 + rnd.random() * 0.25, 58.10 + rnd.random() * 0.5, cases=cases, **kw))
    trucks = [truck(f"T{i:02d}", cap=rnd.choice([450, 600, 800]), fixed_cost=25, cost_per_km=0.12, km_per_litre=4.5)
              for i in range(1, 13)]
    return stops, trucks


def test_150_stop_day_is_fast_feasible_and_reconciled():
    stops, trucks = nmwc_day(150)
    r = req(stops, trucks, time_limit_sec=None, fuel_price_per_litre=0.26, driver_cost_per_hour=2.5)
    t0 = time.perf_counter()
    resp = optimize_dispatch(r)
    elapsed = time.perf_counter() - t0
    sc = rec(resp)
    assert elapsed < 60, elapsed
    assert sc.status == "OPTIMIZED"
    assert_reconciled(r, sc)
    for ld in sc.loads:
        t = next(x for x in trucks if x.id == ld.truck_id)
        assert ld.cases <= t.capacity_cases
        for st in ld.stops:
            assert st.hard_window_ok
    for tid, lds in _loads_by_truck(sc).items():
        for a, b in zip(lds, lds[1:]):
            assert b.depart_min >= a.return_min + 30
    served_p1 = [s for s in stops if s.priority == 1 and s.stop_id in served_ids(sc)]
    all_p1 = [s for s in stops if s.priority == 1]
    assert len(served_p1) == len(all_p1), "all P1 must be served on a normal day"
    print(f"\n150-stop day: {elapsed:.1f}s, loads={sc.trips}, trucks={sc.trucks_used}, km={sc.total_distance_km}, "
          f"unserved={len(sc.unserved)}, util={sc.avg_utilization_pct}%")


def test_request_validation_rejects_duplicate_orders_across_stops():
    a = DispatchStop(stop_id="A", order_ids=["o1"], customer_id="c", lat=23.6, lng=58.4, demand_cases=1)
    b = DispatchStop(stop_id="B", order_ids=["o1"], customer_id="c2", lat=23.6, lng=58.4, demand_cases=1)
    with pytest.raises(ValidationError):
        DispatchRequest(run_id="r", tenant_id="t", depot=DEPOT, trucks=[truck("T")], stops=[a, b])


def test_alternative_deadline_never_loses_the_recommended_plan(monkeypatch):
    """A worker that never returns (OR-Tools stall) is terminated; RECOMMENDED is still delivered."""
    monkeypatch.setenv("ROUTEIQ_TEST_HANG_SCENARIO", "MIN_TRUCKS")
    monkeypatch.setenv("SOLVER_ALT_GRACE_SEC", "3")
    monkeypatch.delenv("SOLVER_PARALLEL", raising=False)
    # Small servers (and GitHub's 2-vCPU runners) must not let one stuck alternative starve the
    # other: each alternative needs its own worker process.
    monkeypatch.setattr("os.cpu_count", lambda: 2)
    stops = [stop(f"S{i}", 23.55 + i * 0.01, 58.40, cases=20) for i in range(6)]
    r = req(stops, [truck("T01"), truck("T02")], time_limit_sec=2, scenarios=["RECOMMENDED", "MIN_TRUCKS", "MIN_DISTANCE"])
    t0 = time.perf_counter()
    resp = optimize_dispatch(r)
    elapsed = time.perf_counter() - t0
    names = [s.name for s in resp.scenarios]
    assert "RECOMMENDED" in names and "MIN_DISTANCE" in names
    assert "MIN_TRUCKS" not in names
    rec_sc = rec(resp)
    assert any("skipped" in w for w in rec_sc.warnings)
    assert_reconciled(r, rec_sc)
    assert elapsed < 30, elapsed


def test_api_process_stays_responsive_during_a_solve(monkeypatch):
    """OR-Tools holds the GIL for its whole search. Every scenario therefore runs in a worker
    process, so the API process (health checks, route geometry, other tenants) keeps answering."""
    import threading

    monkeypatch.delenv("SOLVER_PARALLEL", raising=False)
    stops, trucks = nmwc_day(60)  # realistic: the search runs its full time limit
    r = req(stops, trucks, time_limit_sec=4, scenarios=["RECOMMENDED"])
    out: dict = {}
    th = threading.Thread(target=lambda: out.setdefault("resp", optimize_dispatch(r)))
    th.start()
    worst, ticks = 0.0, 0
    while th.is_alive():
        t0 = time.perf_counter()
        time.sleep(0.2)
        worst = max(worst, time.perf_counter() - t0 - 0.2)
        ticks += 1
    assert_reconciled(r, rec(out["resp"]))
    assert ticks >= 15  # the solve really ran for seconds
    # With the search in-process, one 0.2 s sleep here lasted the whole 4 s search.
    assert worst < 0.5, worst


def test_replan_continuity_keeps_stops_on_their_previous_truck():
    """A late order must not reshuffle the whole unlocked plan: with previous_truck_id set,
    the re-plan keeps (nearly) every stop on the truck it had in the previous version."""
    rnd = random.Random(11)
    base = [stop(f"S{i}", 23.50 + rnd.random() * 0.2, 58.25 + rnd.random() * 0.35, cases=rnd.randint(20, 60)) for i in range(30)]
    trucks = [truck(f"T{i:02d}", cap=400, fixed_cost=20, cost_per_km=0.1) for i in range(1, 5)]
    r1 = req(base, trucks, time_limit_sec=3)
    sc1 = rec(optimize_dispatch(r1))
    prev = {st.stop_id: ld.truck_id for ld in sc1.loads for st in ld.stops}
    late = stop("LATE", 23.58, 58.42, cases=30, priority=1, late=True)
    again = [s.model_copy(update={"previous_truck_id": prev.get(s.stop_id)}) for s in base] + [late]
    r2 = req(again, trucks, time_limit_sec=3)
    sc2 = rec(optimize_dispatch(r2))
    now = {st.stop_id: ld.truck_id for ld in sc2.loads for st in ld.stops}
    moved = [sid for sid, t in prev.items() if now.get(sid) != t]
    assert "LATE" in now
    assert len(moved) <= 3, moved
    assert_reconciled(r2, sc2)


def test_health_reports_routing_status(monkeypatch):
    import main
    from fastapi.testclient import TestClient

    monkeypatch.delenv("OSRM_URL", raising=False)
    main._ROUTING_CACHE.update(at=0.0, value=None)
    body = TestClient(main.app).get("/health").json()
    assert body == {"ok": True, "routing": {"provider": "HAVERSINE", "status": "not_configured"}}

    monkeypatch.setenv("OSRM_URL", "http://127.0.0.1:9")  # nothing listens there
    main._ROUTING_CACHE.update(at=0.0, value=None)
    body = TestClient(main.app).get("/health").json()
    assert body["ok"] is True  # OSRM down never fails the solver
    assert body["routing"] == {"provider": "OSRM", "status": "down"}
