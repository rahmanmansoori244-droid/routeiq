"""Truck capacity in pallets (owner decision 4 Oct 2026; docs/OPTIMIZER_DESIGN.md section 1).

"All cases stay in cases, but when it comes to loading they are transformed to pallets, and in
total they should be less than the truck capacity." A truck with ``bays`` is planned by pallets:
a load fits when its pallet need (1/1000 pallet units, mixed pallets: the stops' needs added up) is
at most bays x Pallet fill (config.pallet_fill_pct, default 100 since the owner decisions of 4 Oct
2026; a company may keep a margin, e.g. 95) AND its kg at most the payload - a payload of 0 is no
weight limit (NMWC: weight is not a planning limit, every truck has payload 0); its case capacity is
then not a limit. A truck without bays keeps the case rule exactly as before.

Haversine only (no network)."""
from __future__ import annotations

import json
import os
from types import SimpleNamespace as NS

import pytest
from pydantic import ValidationError

import dispatch_solver as ds
import feasibility as FZ
import load_repack as LR
import pyvrp_candidate as PV
from dispatch_models import PALLET_FILL_DEFAULT, DispatchConfig, DispatchTruck, pallet_room_units, pallet_text
from dispatch_solver import optimize_dispatch
from tests.test_dispatch import assert_reconciled, rec, req, served_ids, stop, truck, unserved_map

ALL = ["RECOMMENDED", "MIN_TRUCKS", "MIN_DISTANCE"]


def pstop(sid: str, lat: float, lng: float, cases: int = 10, units: int = 100, **kw):
    """A stop with its pallet need in 1/1000 pallet (as the web sends it)."""
    return stop(sid, lat, lng, cases=cases, demand_pallet_units=units, **kw)


def req95(stops, trucks, **cfg):
    """A company that keeps a 5% margin (Pallet fill 95%: 12 bays = 11.4 pallets, 2 bays = 1.9): the
    mechanics below were first written with these figures (the default was 95 until the owner
    decisions of 4 Oct 2026 made it 100)."""
    return req(stops, trucks, pallet_fill_pct=95, **cfg)


def btruck(tid: str, bays: int = 12, cap: int = 1140, **kw) -> DispatchTruck:
    """A truck with bays (its case capacity is then not a limit)."""
    return truck(tid, cap=cap, bays=bays, **kw)


def assert_pallets_hold(r, sc) -> None:
    """Every load on a bay truck is within bays x fill, records the sum of its stops' units, and the
    independent check agrees."""
    trucks = {t.id: t for t in r.trucks}
    units_of = {s.stop_id: s.demand_pallet_units for s in r.stops}
    for ld in sc.loads:
        t = trucks[ld.truck_id]
        if t.bays is None:
            assert ld.pallet_units is None and ld.pallet_room_units is None
            continue
        room = pallet_room_units(t.bays, r.config.pallet_fill_pct)
        assert ld.pallet_room_units == room
        assert ld.pallet_units == sum(units_of[st.stop_id] for st in ld.stops)
        assert ld.pallet_units <= room, (ld.truck_id, ld.load_no, ld.pallet_units, room)
        for st in ld.stops:
            assert st.pallet_units == units_of[st.stop_id]
    assert_reconciled(r, sc)
    assert sc.feasibility is not None and sc.feasibility.status == "VERIFIED", sc.feasibility


# ---------------------------------------------------------------------------------------------
# Units and helpers
# ---------------------------------------------------------------------------------------------

def test_room_and_text_helpers():
    assert pallet_room_units(12, 95) == 11_400
    assert pallet_room_units(2, 95) == 1_900
    assert pallet_room_units(12, 100) == 12_000
    assert DispatchConfig().pallet_fill_pct == PALLET_FILL_DEFAULT == 100  # owner decision 4 Oct 2026: every bay
    assert pallet_text(11_400) == "11.4"
    assert pallet_text(2_513) == "2.5"  # the spec's worked example: 1,042 + 1,283 + 188 units
    assert pallet_text(2_550) == "2.6"  # halves up
    assert pallet_text(160_250) == "160.3"
    assert pallet_text(1_000) == "1.0" and pallet_text(0) == "0.0"


def test_truck_days_of_bay_trucks():
    stops = [pstop("A", 23.60, 58.45, cases=420, units=5_000), pstop("B", 23.61, 58.46, cases=420, units=5_000)]
    r = req(stops, [btruck("B12", bays=12, cap=1140), truck("C", cap=570)])
    b, c = ds._truck_days(r)
    assert b.by_pallets and b.bays == 12 and b.max_pallet_units == 12_000  # Pallet fill 100% (the default)
    assert b.max_cases == 841  # CASES_FREE: the request's cases + 1, so no case comparison ever binds
    assert not c.by_pallets and c.max_pallet_units == 0 and c.max_cases == 570 and c.full_cases == 570


# ---------------------------------------------------------------------------------------------
# Backward compatible: no bays = planned exactly as before
# ---------------------------------------------------------------------------------------------

def _golden_day(with_units: bool):
    pts = [(23.600, 58.450, 120), (23.610, 58.420, 200), (23.570, 58.360, 90), (23.620, 58.480, 300),
           (23.590, 58.300, 150), (23.640, 58.400, 60), (23.555, 58.430, 240), (23.605, 58.335, 110)]
    stops = [stop(f"S{i}", lat, lng, cases=c, demand_kg=c * 9.5, service_min=15,
                  **({"demand_pallet_units": c * 12} if with_units else {})) for i, (lat, lng, c) in enumerate(pts)]
    trucks = [truck("T1", cap=600, capacity_kg=6000, fixed_cost=25, cost_per_km=0.12, km_per_litre=4.5, max_trips=2),
              truck("T2", cap=450, capacity_kg=4500, fixed_cost=20, cost_per_km=0.10, km_per_litre=5.0, max_trips=2)]
    return req(stops, trucks, scenarios=ALL, fuel_price_per_litre=0.26, driver_cost_per_hour=2.5)


def _shape(sc):
    return ([(ld.truck_id, ld.load_no, ld.depart_min, ld.return_min, [st.stop_id for st in ld.stops]) for ld in sc.loads],
            sc.total_distance_km, sc.operating_cost, sorted(u.stop_id for u in sc.unserved))


def test_no_truck_with_bays_plans_exactly_as_before():
    """Golden: without bays the pallet need a request may carry changes nothing (same loads, km and
    cost as the same day without it, and as main daa5eae before this change), and every new field
    is None."""
    plain = optimize_dispatch(_golden_day(False))
    with_units = optimize_dispatch(_golden_day(True))
    for a, b in zip(plain.scenarios, with_units.scenarios):
        assert _shape(a) == _shape(b), a.name
        for sc in (a, b):
            assert sc.pallet_unit is None and sc.pallet_fill_pct is None and sc.total_pallet_units is None
            assert all(ld.pallet_units is None and ld.pallet_room_units is None for ld in sc.loads)
            assert sc.feasibility.status == "VERIFIED"
        assert all(st.pallet_units is None for ld in a.loads for st in ld.stops)
    # The day as main daa5eae (before pallets) plans it, in every option.
    for sc in plain.scenarios:
        got = (sc.trucks_used, sc.trips, round(sc.total_distance_km, 1), round(sc.operating_cost, 2),
               [(ld.truck_id, ld.load_no, ld.depart_min, [st.stop_id for st in ld.stops]) for ld in sc.loads])
        assert got == GOLDEN, (sc.name, got)


# _golden_day as main daa5eae plans it (all three options alike): trucks, loads, km, operating cost
# OMR, and (truck, load, departure, stops) per load.
GOLDEN = (2, 3, 78.4, 68.9, [("T1", 1, 360, ["S0", "S3", "S5"]), ("T2", 1, 360, ["S6", "S1"]),
                             ("T2", 2, 450, ["S2", "S4", "S7"])])


# ---------------------------------------------------------------------------------------------
# Routing, fill, kg, cases
# ---------------------------------------------------------------------------------------------

def test_the_route_search_respects_the_bays():
    """5 + 5 + 2.5 pallets on one 12-bay truck at the default 100% (12.0 pallets): two loads, never one."""
    stops = [pstop("A", 23.60, 58.45, cases=100, units=5_000), pstop("B", 23.605, 58.455, cases=100, units=5_000),
             pstop("C", 23.61, 58.46, cases=100, units=2_500)]
    r = req(stops, [btruck("R1", bays=12, max_trips=3)], scenarios=ALL)
    for sc in optimize_dispatch(r).scenarios:
        assert served_ids(sc) == {"A", "B", "C"}, sc.name
        assert len(sc.loads) == 2, sc.name
        assert_pallets_hold(r, sc)


def test_fill_is_the_limit_to_one_unit():
    def one(units, **fill):
        return req([pstop("A", 23.60, 58.45, cases=900, units=units)], [btruck("R1", bays=12, max_trips=1)], **fill)
    # The default, Pallet fill 100%: every bay, 12.0 pallets.
    sc = rec(optimize_dispatch(one(12_000)))
    assert served_ids(sc) == {"A"} and sc.loads[0].pallet_units == 12_000 and sc.loads[0].pallet_room_units == 12_000
    assert sc.loads[0].utilization_pct == 100.0
    sc = rec(optimize_dispatch(one(12_001)))
    assert unserved_map(sc) == {"A": "EXCEEDS_ANY_TRUCK_CAPACITY"}
    # A company that keeps a margin: 95% = 11.4 pallets.
    sc = rec(optimize_dispatch(one(11_400, pallet_fill_pct=95)))
    assert served_ids(sc) == {"A"} and sc.loads[0].pallet_units == 11_400
    assert sc.loads[0].utilization_pct == 95.0  # against the physical bays: the 95% limit shows 95%
    sc = rec(optimize_dispatch(one(11_401, pallet_fill_pct=95)))
    assert unserved_map(sc) == {"A": "EXCEEDS_ANY_TRUCK_CAPACITY"}


def test_kg_still_binds_on_a_bay_truck():
    """Light pallets fit; heavy ones do not, whatever the bays say."""
    light = [pstop(f"L{i}", 23.60 + i * 0.001, 58.45, cases=80, units=1_000, demand_kg=400) for i in range(5)]
    r = req(light, [btruck("R1", bays=12, capacity_kg=10_000, max_trips=1)])
    sc = rec(optimize_dispatch(r))
    assert served_ids(sc) == {f"L{i}" for i in range(5)}
    heavy = [pstop(f"H{i}", 23.60 + i * 0.001, 58.45, cases=80, units=1_000, demand_kg=2_600) for i in range(5)]
    r = req(heavy, [btruck("R1", bays=12, capacity_kg=10_000, max_trips=1)])
    sc = rec(optimize_dispatch(r))
    assert len(sc.unserved) == 2 and all(ld.kg <= 10_000 for ld in sc.loads)
    assert all("kg" in u.reason_message for u in sc.unserved), [u.reason_message for u in sc.unserved]
    assert_pallets_hold(r, sc)


def test_payload_0_is_no_weight_limit():
    """Owner decisions of 4 Oct 2026: weight is not a planning limit for NMWC - every truck has payload
    0, and 0 means no limit everywhere: the route search, the prefilters (no "kg vs largest payload"),
    the fleet total, the second search (no kg dimension), the independent check and the utilization.
    The heavy pallets kg_still_binds leaves out (5 x 2,600 kg on a 10,000 kg truck) all ride."""
    heavy = [pstop(f"H{i}", 23.60 + i * 0.001, 58.45, cases=80, units=1_000, demand_kg=2_600) for i in range(5)]
    r = req(heavy, [btruck("R1", bays=12, max_trips=1), btruck("R0", bays=2, cap=190, max_trips=1)], scenarios=ALL)
    assert all(t.capacity_kg == 0 for t in r.trucks)
    resp = optimize_dispatch(r)
    for sc in resp.scenarios:
        assert served_ids(sc) == {f"H{i}" for i in range(5)} and not sc.unserved, sc.name
        assert sum(ld.kg for ld in sc.loads) == 13_000
        for ld in sc.loads:
            # Utilization against the bays only (5.0 pallets on 12 bays = 41.7%; 2.0 on 2 = 100%), never kg.
            assert ld.utilization_pct == round(100 * ld.pallet_units / (12_000 if ld.truck_id == "R1" else 2_000), 1), (sc.name, ld)
        assert not any("kg" in w or "payload" in w for w in sc.warnings), sc.warnings
        assert_pallets_hold(r, sc)
    tds = ds._truck_days(r)
    assert all(td.max_kg_units == 0 for td in tds)
    assert not ds._fleet(r.stops, tds, r.config.pallet_fill_pct).kg_bound
    # The second search has no kg dimension when no truck has a payload.
    tds2, solvable, _, mx, _ = _day_of(r)
    assert [c["delivery"] for c in PV.build_model(r, solvable, tds2, mx).clients] == [[1_000]] * 5
    # A truck without bays and payload 0: cases only.
    plain = req([stop(f"C{i}", 23.60 + i * 0.001, 58.45, cases=100, demand_kg=4_000) for i in range(5)], [truck("C", cap=570, max_trips=1)])
    sc = rec(optimize_dispatch(plain))
    assert len(sc.loads) == 1 and sc.loads[0].kg == 20_000 and sc.loads[0].utilization_pct == round(100 * 500 / 570, 1)
    assert sc.feasibility.status == "VERIFIED"


def test_cases_are_not_a_limit_on_a_bay_truck():
    """1,400 light cases (10 pallets) on a 12-bay truck whose case capacity is 1,140."""
    stops = [pstop("A", 23.60, 58.45, cases=700, units=5_000), pstop("B", 23.61, 58.46, cases=700, units=5_000)]
    r = req(stops, [btruck("R1", bays=12, cap=1140, max_trips=1)])
    sc = rec(optimize_dispatch(r))
    assert served_ids(sc) == {"A", "B"} and sc.loads[0].cases == 1_400
    assert_pallets_hold(r, sc)


def test_mixed_fleet_puts_the_big_order_on_the_bay_truck():
    """A 1,000-case / 2.0-pallet stop only fits the bay truck (the case truck takes 570 cases); the
    small one may go on either."""
    stops = [pstop("BIG", 23.60, 58.45, cases=1_000, units=2_000), pstop("SMALL", 23.62, 58.40, cases=50, units=600)]
    r = req(stops, [truck("C570", cap=570, max_trips=1), btruck("B12", bays=12, max_trips=1)], scenarios=ALL)
    for sc in optimize_dispatch(r).scenarios:
        assert served_ids(sc) == {"BIG", "SMALL"}, sc.name
        big = next(ld for ld in sc.loads if "BIG" in [st.stop_id for st in ld.stops])
        assert big.truck_id == "B12", sc.name
        assert_pallets_hold(r, sc)


# ---------------------------------------------------------------------------------------------
# Reasons: larger than any truck, fleet shortage, no room
# ---------------------------------------------------------------------------------------------

def test_order_larger_than_every_truck_names_pallets():
    r = req([pstop("BIG", 23.60, 58.45, cases=1_020, units=16_300, demand_kg=15_355)],
            [btruck("R1", bays=12, capacity_kg=10_000), btruck("R2", bays=2, cap=190, capacity_kg=3_000)])
    sc = rec(optimize_dispatch(r))
    assert unserved_map(sc) == {"BIG": "EXCEEDS_ANY_TRUCK_CAPACITY"}
    msg = sc.unserved[0].reason_message
    assert ("Order is larger than any available truck (16.3 pallets vs largest truck 12.0 pallets: 12 bays at 100% fill; "
            "15,355 kg vs largest payload 10,000 kg). Split it or use a bigger truck.") == msg, msg
    # A mixed fleet names both measures.
    r = req([pstop("BIG", 23.60, 58.45, cases=1_250, units=16_300)], [btruck("R1", bays=12), truck("C", cap=570)])
    msg = rec(optimize_dispatch(r)).unserved[0].reason_message
    assert "16.3 pallets vs largest truck 12.0 pallets: 12 bays at 100% fill; 1250 cases vs largest truck without bays 570 cases" in msg, msg
    # Payload 0 (no weight limit): the bays alone, no kg named.
    r = req([pstop("BIG", 23.60, 58.45, cases=1_020, units=16_300, demand_kg=15_355)], [btruck("R1", bays=12), btruck("R2", bays=2, cap=190)])
    msg = rec(optimize_dispatch(r)).unserved[0].reason_message
    assert msg == ("Order is larger than any available truck (16.3 pallets vs largest truck 12.0 pallets: 12 bays at 100% fill). "
                   "Split it or use a bigger truck."), msg


def test_fleet_shortage_in_pallets_and_none_claimed_in_a_mixed_fleet():
    stops = [pstop(f"S{i}", 23.60 + i * 0.002, 58.45, cases=90, units=1_000, priority=3) for i in range(3)]
    r = req95(stops, [btruck("R0", bays=2, cap=190, max_trips=1)])
    sc = rec(optimize_dispatch(r))
    assert len(sc.unserved) == 2 and len(sc.loads) == 1 and sc.loads[0].pallet_units == 1_000
    for u in sc.unserved:
        assert ("Fleet capacity shortage: 3.0 pallets requested vs 1.9 pallets across all available loads "
                "(the bays at 95% Pallet fill).") in u.reason_message, u.reason_message
    assert not any("short today" in w for w in sc.warnings), sc.warnings
    tds = ds._truck_days(r)
    assert ds._fleet_shortage(r.stops, tds) == (True, False)
    # The same stops with a case truck beside it: no sound space total exists, none is claimed.
    mixed = req95(stops, [btruck("R0", bays=2, cap=190, max_trips=1), truck("C", cap=90, max_trips=1)])
    assert ds._fleet_shortage(mixed.stops, ds._truck_days(mixed)) == (False, False)


def test_mixed_fleet_a_stop_no_load_can_take_is_told_so_not_re_plan():
    """Third review: a fleet that mixes a truck with bays (B: 2 bays = 1.9 pallets) and one without
    (C: 90 cases), one load each, and 3 stops of 90 cases / 1.0 pallet. B takes one, C takes one; the
    third fits no load, and no packing of the two loads carries all three (each stop is over half of
    both trucks, so no two share a load). It was told "the optimizer found no truck, trip or time slot
    ... Re-plan to search again", with a warning that no check proves it impossible."""
    stops = [pstop(f"S{i}", 23.60 + i * 0.002, 58.45, cases=90, units=1_000, priority=3) for i in range(3)]
    r = req95(stops, [btruck("B", bays=2, cap=190, max_trips=1), truck("C", cap=90, max_trips=1)], scenarios=ALL)
    for sc in optimize_dispatch(r).scenarios:
        assert len(sc.loads) == 2 and len(sc.unserved) == 1, sc.name
        u = sc.unserved[0]
        assert u.reason_code == "SOLVER_DROPPED_LOW_PRIORITY"
        assert u.reason_message == (
            "Not planned: no load or free trip has room for its 90 cases / 1.0 pallets (the most room left is 0 cases / "
            "0.9 pallets). This P3 stop was left out. Add a truck or raise the loads-per-truck limit."), (sc.name, u.reason_message)
        assert not any("no check proves" in w for w in sc.warnings), sc.warnings
        assert_pallets_hold(r, sc)


def test_mixed_fleet_proofs_are_sound():
    """The mixed-fleet proofs (each stop measured on each truck in that truck's own measure):
    - more stops over half of every truck than usable trips: no packing carries them all;
    - the stops' smallest shares add up to more than the usable trips: the fleet is short (the
      second search then uses its raised penalty), with its own reason.
    Neither claims anything when a packing exists."""
    mixed = [btruck("B", bays=2, cap=190, max_trips=1), truck("C", cap=90, max_trips=1)]
    three = req95([pstop(f"S{i}", 23.60 + i * 0.002, 58.45, cases=90, units=1_000) for i in range(3)], mixed)
    usable = ds._truck_days(three)
    needs = [(s.demand_cases, s.demand_pallet_units) for s in three.stops]
    assert ds._mixed_space_proven(needs, usable, halves=True)  # 3 stops over half of both trucks, 2 trips
    assert not ds._mixed_space_proven(needs, usable, halves=False)  # 0.526 x 3 = 1.58 trips <= 2
    assert ds._fleet_shortage(three.stops, usable) == (False, False)
    # Two of them: B and C take one each (a packing exists), nothing is proven.
    assert not ds._mixed_space_proven(needs[:2], usable, halves=True)
    # Small stops share a load: 0.4 pallet / 40 cases each, 4 of them fit (B takes 4 x 0.4 = 1.6).
    small = [(40, 400)] * 4
    assert not ds._mixed_space_proven(small, usable, halves=True)
    # Six stops of 80 cases / 1.0 pallet: at least 6 x 0.526 = 3.2 loads of 2 - short, in both measures.
    six = req95([pstop(f"S{i}", 23.60 + i * 0.002, 58.45, cases=80, units=1_000, priority=3) for i in range(6)], mixed)
    assert ds._fleet_shortage(six.stops, ds._truck_days(six)) == (True, False)
    sc = rec(optimize_dispatch(six))
    assert len(sc.unserved) == 4 and len(sc.loads) == 2
    for u in sc.unserved:
        assert u.reason_message == (
            "Fleet capacity shortage: the 2 loads the trucks have left cannot carry every stop of the day (measured in "
            "pallets on the trucks with bays and in cases on the others). Lower priorities are left out first (this is P3)."), u.reason_message
    assert not any("short today" in w or "no check proves" in w for w in sc.warnings), sc.warnings
    assert_pallets_hold(six, sc)


def test_the_no_room_reason_in_pallets():
    """3 x 1.2 pallets on 2 trucks x 1 load of 2 bays (1.9 pallets): no two share a load."""
    two = [btruck("R0", bays=2, cap=190, max_trips=1), btruck("R1", bays=2, cap=190, max_trips=1)]
    r = req95([pstop(f"P{i}", 23.60 + i * 0.001, 58.45, cases=100, units=1_200, priority=1) for i in range(3)], two)
    by_id = {s.stop_id: s for s in r.stops}
    loads = [NS(truck_id=tid, stops=[NS(stop_id=k, cases=by_id[k].demand_cases, kg=0.0, pallet_units=by_id[k].demand_pallet_units)
                                     for k in ids]) for tid, ids in (("R0", ["P0"]), ("R1", ["P1"]))]
    msg = ds._no_room_reason(r.stops[2], ds._truck_days(r), loads, {f"P{i}": 1 for i in range(3)})
    assert msg == ("Not planned: no load or free trip has room for its 1.2 pallets (the most room left is 0.7 pallets). "
                   "This P1 stop was left out. Add a truck or raise the loads-per-truck limit."), msg
    # Two 0.9-pallet stops share a load: nothing proves the third cannot go.
    small = req95([pstop(f"Q{i}", 23.60 + i * 0.001, 58.45, cases=40, units=900, priority=1) for i in range(3)], two)
    by_id = {s.stop_id: s for s in small.stops}
    loads = [NS(truck_id="R0", stops=[NS(stop_id="Q0", cases=40, kg=0.0, pallet_units=900)])]
    assert ds._no_room_reason(small.stops[2], ds._truck_days(small), loads, {f"Q{i}": 1 for i in range(3)}) is None


# ---------------------------------------------------------------------------------------------
# Repack, timing estimate, independent check, second search
# ---------------------------------------------------------------------------------------------

def _day_of(r):
    tds = ds._truck_days(r)
    solvable, drops, _ = ds._prefilter(r, tds)
    mx = ds.resolve_matrix([(r.depot.lat, r.depot.lng)] + [(s.lat, s.lng) for s in solvable], provider="HAVERSINE",
                           osrm_url=None, haversine_multiplier=1.3, avg_speed_kmh=40, road_time_factor=1.25)
    return tds, solvable, drops, mx, ds._stage_ctx(r, solvable, tds, mx, drops)


def test_repack_fits_loads_by_pallets():
    stops = [pstop("A", 23.60, 58.45, cases=900, units=6_000), pstop("B", 23.605, 58.455, cases=100, units=5_400),
             pstop("C", 23.61, 58.46, cases=100, units=5_401)]
    r = req95(stops, [btruck("R1", bays=12, cap=1140, max_trips=3), btruck("R2", bays=12, cap=1140, max_trips=3)])
    tds, solvable, _, mx, ctx = _day_of(r)
    day = ctx.day
    td = day.trucks[0]
    assert LR.fits_truck(LR.facts(day, (0, 1)), td)  # 11.4 pallets, 1,000 cases: fits
    assert not LR.fits_truck(LR.facts(day, (0, 2)), td)  # 11.401 pallets
    assert LR.facts(day, (0, 1)).pallet_units == 11_400
    assert LR.time_plan(day, {td.idx: [(0, 2)]}, ctx.rec_pricing) is None  # no timetable for a load over its bays
    assert LR.time_plan(day, {td.idx: [(0, 1), (2,)]}, ctx.rec_pricing) is not None
    # Identical trucks only when their bays are the same.
    assert len(LR._identical_trucks(day, ctx.rec_pricing)) == 2
    r2 = req95(stops, [btruck("R1", bays=12, cap=1140, max_trips=3), btruck("R2", bays=10, cap=1140, max_trips=3)])
    _, _, _, _, ctx2 = _day_of(r2)
    assert LR._identical_trucks(ctx2.day, ctx2.rec_pricing) == {}


def test_the_fit_fallback_and_every_option_keep_the_bays():
    """A day whose search estimate is tight: every option's every load is within its bays."""
    stops = [pstop(f"S{i}", 23.56 + (i % 5) * 0.012, 58.36 + (i // 5) * 0.03, cases=60 + 7 * i, units=900 + 130 * i,
                   demand_kg=300 + 40 * i, service_min=15) for i in range(14)]
    r = req(stops, [btruck("R1", bays=6, cap=570, capacity_kg=6_000, max_trips=3),
                    btruck("R2", bays=6, cap=570, capacity_kg=6_000, max_trips=3)],
            scenarios=ALL, loading_min_per_case=0.05, time_limit_sec=3)
    for sc in optimize_dispatch(r).scenarios:
        assert_pallets_hold(r, sc)


def test_search_turnaround_estimate_uses_the_days_cases_per_pallet():
    stops = [pstop("A", 23.60, 58.45, cases=420, units=5_000), pstop("B", 23.61, 58.46, cases=420, units=5_000)]
    r = req(stops, [btruck("R1", bays=12)], reload_min=30, loading_min_per_case=0.04)
    td = ds._truck_days(r)[0]
    assert td.full_cases == round(12_000 * 840 / 10_000)  # 1,008 cases: 12.0 pallets (100% fill) x 84 cases per pallet
    assert ds._approx_gap_s(r.config, td) == int(round((30 + 0.04 * 1_008 * 0.8) * 60))
    case = ds._truck_days(req(stops, [truck("C", cap=1140)], reload_min=30, loading_min_per_case=0.04))[0]
    assert ds._approx_gap_s(r.config, case) == int(round((30 + 0.04 * 1140 * 0.8) * 60))  # unchanged


def test_independent_check_flags_pallets_and_wrong_totals():
    stops = [pstop("A", 23.60, 58.45, cases=900, units=6_000), pstop("B", 23.605, 58.455, cases=100, units=5_400)]
    r = req(stops, [btruck("R1", bays=12, cap=500, max_trips=1)])
    sc = rec(optimize_dispatch(r))
    assert sc.feasibility.status == "VERIFIED" and sc.feasibility.checked_at_version == FZ.CHECK_VERSION == 3
    assert sc.loads[0].cases == 1_000  # over the case capacity 500: not a violation on a bay truck
    # The same plan checked against 10 bays: 11.4 > 10.0 pallets (100% fill), and > 9.5 at 95%.
    fewer = r.model_copy(deep=True)
    fewer.trucks[0].bays = 10
    rep = FZ.check_scenario(fewer, sc)
    assert [v.code for v in rep.violations] == ["CAPACITY_PALLETS"], rep.violations
    v = rep.violations[0]
    assert v.message == "R1 load 1 needs 11.4 pallets; the truck takes 10.0 (10 bays at 100% fill).", v.message
    assert v.short_by_min == 1.4
    fewer.config.pallet_fill_pct = 95
    v = FZ.check_scenario(fewer, sc).violations[0]
    assert (v.message, v.short_by_min) == ("R1 load 1 needs 11.4 pallets; the truck takes 9.5 (10 bays at 95% fill).", 1.9), v.message
    # A load that records other units than its stops add up to.
    bad = sc.model_copy(deep=True)
    bad.loads[0].pallet_units = 11_000
    assert [v.code for v in FZ.check_scenario(r, bad).violations] == ["LOAD_TOTALS"]
    # A truck without bays is still checked by cases.
    cases = r.model_copy(deep=True)
    cases.trucks[0].bays = None
    for s in cases.stops:
        s.demand_pallet_units = None
    plain = sc.model_copy(deep=True)
    plain.loads[0].pallet_units = None
    assert [v.code for v in FZ.check_scenario(cases, plain).violations] == ["CAPACITY_CASES"]


def test_second_search_model_has_a_pallet_dimension_only_with_bays():
    stops = [pstop("A", 23.60, 58.45, cases=300, units=3_000, demand_kg=900),
             pstop("B", 23.61, 58.46, cases=200, units=2_500, demand_kg=500)]
    r = req(stops, [btruck("B12", bays=12, capacity_kg=10_000), truck("C", cap=570, capacity_kg=3_000)])
    tds, solvable, _, mx, _ = _day_of(r)
    m = PV.build_model(r, solvable, tds, mx)
    assert m.summary["pallets"] == "on"
    assert [c["delivery"] for c in m.clients] == [[300, 3_000, 9_000], [200, 2_500, 5_000]]  # cases, pallet units, kg
    by_truck = {tds[i].truck.id: v for v, ts in zip(m.vehicle_types, m.type_trucks) for i in ts}
    assert by_truck["B12"]["capacity"] == [501, 12_000, 100_000]  # CASES_FREE, bays x 100%, payload
    assert by_truck["C"]["capacity"] == [570, 5_501, 30_000]  # the whole day's pallets: not its limit
    # An all-bay fleet: pallets and kg only, as an all-case fleet has cases and kg.
    r2 = req(stops, [btruck("B12", bays=12, capacity_kg=10_000)])
    tds2, solvable2, _, mx2, _ = _day_of(r2)
    assert [c["delivery"] for c in PV.build_model(r2, solvable2, tds2, mx2).clients] == [[3_000, 9_000], [2_500, 5_000]]
    # No bays anywhere: no pallet dimension.
    r3 = req(stops, [truck("C", cap=570, capacity_kg=3_000)])
    tds3, solvable3, _, mx3, _ = _day_of(r3)
    m3 = PV.build_model(r3, solvable3, tds3, mx3)
    assert m3.summary["pallets"] == "off" and [c["delivery"] for c in m3.clients] == [[300, 9_000], [200, 5_000]]


def test_second_search_plans_over_the_bays_are_rejected():
    stops = [pstop("A", 23.60, 58.45, cases=300, units=6_000), pstop("B", 23.61, 58.46, cases=200, units=6_001)]
    r = req(stops, [btruck("B12", bays=12), truck("C", cap=1_000)])
    tds, solvable, _, _, _ = _day_of(r)
    plan, why = PV.plan_of({"plan": {"0": [[0, 1]]}}, tds, solvable)  # 12.001 pallets on 12.0
    assert plan is None and why == "INVALID_PLAN"
    plan, why = PV.plan_of({"plan": {"0": [[0]], "1": [[1]]}}, tds, solvable)  # the case truck by cases: 200 <= 1,000
    assert plan == {0: [(0,)], 1: [(1,)]} and why is None


@pytest.mark.usefixtures("_pyvrp_in_process")
def test_second_search_end_to_end_with_bays():
    stops = [pstop(f"S{i}", 23.56 + (i % 4) * 0.015, 58.36 + (i // 4) * 0.03, cases=80 + 10 * i, units=1_000 + 150 * i,
                   demand_kg=600 + 20 * i) for i in range(10)]
    r = req(stops, [btruck("R1", bays=6, cap=570, capacity_kg=6_000, max_trips=3), truck("C", cap=400, capacity_kg=4_000, max_trips=3)])
    resp = optimize_dispatch(r)
    assert resp.search.pyvrp is not None and resp.search.pyvrp.status in ("CHOSEN", "NOT_CHOSEN"), resp.search.pyvrp
    for sc in resp.scenarios:
        assert_pallets_hold(r, sc)


@pytest.fixture
def _pyvrp_in_process(monkeypatch):
    monkeypatch.setenv("SOLVER_PYVRP", "on")
    monkeypatch.setenv("SOLVER_PARALLEL", "0")
    monkeypatch.setenv("SOLVER_PYVRP_MAX_ITERS", "500")
    monkeypatch.setattr(PV, "effective_cpus", lambda: 4)


# ---------------------------------------------------------------------------------------------
# Contract: 422, echo, utilization, reconciliation, settings bounds
# ---------------------------------------------------------------------------------------------

def test_a_stop_without_a_pallet_need_is_refused_when_a_truck_has_bays():
    with pytest.raises(ValidationError, match="stop B has no pallet need; every stop needs demand_pallet_units when a truck has bays"):
        req([pstop("A", 23.60, 58.45), stop("B", 23.61, 58.46)], [btruck("R1")])
    req([stop("A", 23.60, 58.45)], [truck("C")])  # no bays: none needed
    with pytest.raises(ValidationError):
        req([pstop("A", 23.60, 58.45)], [btruck("R1", bays=0)])  # 1-40
    with pytest.raises(ValidationError):
        req([pstop("A", 23.60, 58.45)], [btruck("R1")], pallet_fill_pct=49)  # 50-100


def test_a_stop_without_a_pallet_need_is_422_over_http(monkeypatch):
    from fastapi.testclient import TestClient

    import main

    monkeypatch.setattr(main, "SOLVER_TOKEN", "t0k")
    body = req([pstop("A", 23.60, 58.45), pstop("B", 23.61, 58.46)], [btruck("R1")]).model_dump()
    body["stops"][1]["demand_pallet_units"] = None
    res = TestClient(main.app).post("/optimize-dispatch", json=body, headers={"X-Solver-Token": "t0k"})
    assert res.status_code == 422, res.text
    assert "no pallet need" in res.text


def test_echo_utilization_and_totals():
    stops = [pstop("A", 23.60, 58.45, cases=500, units=6_000, demand_kg=2_000),
             pstop("B", 23.61, 58.46, cases=300, units=3_000, demand_kg=8_000)]
    r = req(stops, [btruck("R1", bays=12, capacity_kg=10_000, max_trips=1)], pallet_fill_pct=90)
    sc = rec(optimize_dispatch(r))
    assert (sc.pallet_unit, sc.pallet_fill_pct, sc.total_pallet_units) == (0.001, 90, 9_000)
    ld = sc.loads[0]
    assert (ld.pallet_units, ld.pallet_room_units) == (9_000, 10_800)
    assert ld.utilization_pct == 100.0  # kg binds: 10,000 / 10,000 kg (pallets 9.0 / 12 = 75%)
    assert_pallets_hold(r, sc)
    # An empty day echoes the rule too.
    empty = rec(optimize_dispatch(req([], [btruck("R1")])))
    assert (empty.pallet_unit, empty.pallet_fill_pct, empty.total_pallet_units) == (0.001, 100, 0)


def test_reconciliation_counts_pallet_units():
    r = req([pstop("A", 23.60, 58.45, cases=50, units=600)], [btruck("R1", max_trips=1)])
    sc = rec(optimize_dispatch(r))
    ds._assert_reconciled(r, sc)
    bad = sc.model_copy(deep=True)
    bad.loads[0].pallet_units = 601
    with pytest.raises(ds.ReconciliationError, match="pallet units"):
        ds._assert_reconciled(r, bad)
    bad = sc.model_copy(deep=True)
    bad.loads[0].stops[0].pallet_units = 500
    bad.loads[0].pallet_units = 500
    with pytest.raises(ds.ReconciliationError, match="pallet units 500\\+0 != 600"):
        ds._assert_reconciled(r, bad)


def test_planner_bounds_carry_the_pallet_settings():
    p = os.path.join(os.path.dirname(__file__), "..", "..", "..", "packages", "shared-types", "src", "planner-bounds.json")
    if not os.path.exists(p):
        pytest.skip("planner-bounds.json is not next to the solver (image build)")
    with open(p, encoding="utf-8") as f:
        b = json.load(f)
    assert b["config"]["palletFillPct"] == {"solver": "pallet_fill_pct", "min": 50, "max": 100, "int": True}
    assert b["truck"]["bays"] == {"solver": "bays", "min": 1, "max": 40, "int": True}
