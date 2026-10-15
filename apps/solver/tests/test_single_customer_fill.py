"""One customer on a truck may use every bay (config.single_customer_fill_pct).

Owner rule 13 Oct 2026, after a large single-customer order was split in two: "keep 90% for trucks with several
customers, but let a truck that carries only one customer be filled to 100%. A big single order then
goes whole on one truck." The order: 300 cases of a 143-per-pallet product + 500 of a 56-per-pallet one =
2,098 + 8,929 = 11,027 units (11.03 pallets). At Pallet fill 90% the largest truck (12 bays) holds 10,800,
so the web split it into 9.89 + 1.13 pallets. With the rule a load whose stops are all ONE customer holds
bays x 100% (12,000 on 12 bays); every other load keeps bays x 90%. The web sends 100 (no setting) and
keeps a customer that fits no truck at 90% but one at 100% as ONE stop; the solver then plans it alone,
on a truck big enough, in every engine (route search: the "Solo" dimension and allowed vehicles; load
re-check: fits_truck by the load's customers; the second search: skipped), and the independent check
measures each load by its own customers. Weight is not a limit (NMWC: payload 0, owner decision).

Haversine only (no network)."""
from __future__ import annotations

import json

import pytest

import dispatch_solver as ds
import feasibility as FZ
import load_repack as LR
from dispatch_models import DispatchConfig, load_room_units, pallet_room_units
from dispatch_solver import optimize_dispatch
from tests.test_dispatch import assert_reconciled, rec, req, served_ids, unserved_map
from tests.test_pallets import ALL, _day_of, _pyvrp_in_process, btruck, pstop  # noqa: F401

TRUCKLOAD_UNITS = 2_098 + 8_929  # SS250ML 300 @ 143 + JA1.5L 500 @ 56, each line rounded up
FILL = 90


def truckload(units: int = TRUCKLOAD_UNITS, sid: str = "TRUCKLOAD", **kw):
    return pstop(sid, 23.62, 58.47, cases=800, units=units, **kw)


def others(n: int = 5, units: int = 2_400):
    """Small customers near the depot, each its own customer."""
    return [pstop(f"O{i}", 23.590 + 0.004 * i, 58.40 + 0.006 * i, cases=60, units=units) for i in range(n)]


def fleet(max_trips: int = 2):
    """An 11-bay truck and two 12-bay trucks (as NMWC's 11-bay truck and its 10-ton trucks), no payload."""
    return [btruck("R11", bays=11, cap=1_045, max_trips=max_trips), btruck("R12A", bays=12, max_trips=max_trips),
            btruck("R12B", bays=12, max_trips=max_trips)]


def rq(stops, trucks, single: int | None = 100, **cfg):
    cfg.setdefault("time_limit_sec", 3)
    return req(stops, trucks, pallet_fill_pct=FILL, single_customer_fill_pct=single, **cfg)


def load_of(sc, sid: str):
    return next(ld for ld in sc.loads if any(st.stop_id == sid for st in ld.stops))


def assert_rule_holds(r, sc) -> None:
    """Every load on a bay truck is within its own room - bays x 100% when its stops are one customer,
    bays x 90% otherwise - records it (echo), the stops add up, and the independent check agrees."""
    trucks = {t.id: t for t in r.trucks}
    stops = {s.stop_id: s for s in r.stops}
    for ld in sc.loads:
        t = trucks[ld.truck_id]
        customers = {stops[st.stop_id].customer_id for st in ld.stops}
        room = load_room_units(t.bays, r.config.pallet_fill_pct, r.config.single_customer_fill_pct, len(customers))
        assert ld.pallet_room_units == room, (ld.truck_id, ld.load_no, ld.pallet_room_units, room)
        assert ld.pallet_units == sum(stops[st.stop_id].demand_pallet_units for st in ld.stops)
        assert ld.pallet_units <= room, (ld.truck_id, ld.load_no, ld.pallet_units, room)
        if len(customers) > 1:
            assert ld.pallet_units <= pallet_room_units(t.bays, FILL)
    assert_reconciled(r, sc)
    assert sc.single_customer_fill_pct == r.config.single_customer_fill_pct
    assert sc.feasibility is not None and sc.feasibility.status == "VERIFIED", sc.feasibility


# ---------------------------------------------------------------------------------------------
# The rule and its numbers
# ---------------------------------------------------------------------------------------------

def test_room_of_a_load_by_its_customers():
    assert TRUCKLOAD_UNITS == 11_027
    assert load_room_units(12, 90, 100, 1) == 12_000  # one customer: every bay
    assert load_room_units(12, 90, 100, 2) == 10_800  # several customers: the fill
    assert load_room_units(11, 90, 100, 1) == 11_000  # the 11-bay truck is too small for 11,027
    assert load_room_units(12, 90, None, 1) == 10_800  # no rule (an older web): as before
    assert load_room_units(12, 95, 90, 1) == 11_400  # never less than the fill
    assert DispatchConfig().single_customer_fill_pct is None
    with pytest.raises(ValueError):
        DispatchConfig(pallet_fill_pct=95, single_customer_fill_pct=90)
    r = rq([truckload()], fleet())
    r11, r12, _ = ds._truck_days(r)
    assert (r11.max_pallet_units, r11.solo_pallet_units) == (9_900, 11_000)
    assert (r12.max_pallet_units, r12.solo_pallet_units) == (10_800, 12_000)
    assert ds.full_truck(r.stops[0], [r11, r12]) and not ds.full_truck(r.stops[0], [r11])
    assert ds._fits_capacity(r.stops[0], r12) and not ds._fits_capacity(r.stops[0], r11)
    assert not ds._fits_shared(r.stops[0], r12)
    # Without the rule nothing changes: same rooms, no full truck.
    old = ds._truck_days(rq([truckload()], fleet(), single=None))
    assert [(td.max_pallet_units, td.solo_pallet_units) for td in old] == [(9_900, 9_900), (10_800, 10_800), (10_800, 10_800)]


def test_the_truckload_goes_whole_alone_on_a_12_bay_truck_in_every_option():
    """The truckload order: 11,027 units, one stop, planned alone on a 12-bay truck (never the 11-bay,
    never with another customer) in every option; every mixed load stays at or under 90%; the check
    agrees, and the load's room is echoed as 12,000."""
    r = rq([truckload()] + others(), fleet(), scenarios=ALL)
    resp = optimize_dispatch(r)
    assert len(resp.scenarios) == 3
    for sc in resp.scenarios:
        assert served_ids(sc) == {s.stop_id for s in r.stops}, (sc.name, unserved_map(sc))
        ld = load_of(sc, "TRUCKLOAD")
        assert [st.stop_id for st in ld.stops] == ["TRUCKLOAD"], (sc.name, [st.stop_id for st in ld.stops])
        assert ld.truck_id in ("R12A", "R12B"), (sc.name, ld.truck_id)
        assert (ld.pallet_units, ld.pallet_room_units) == (11_027, 12_000)
        assert ld.utilization_pct == pytest.approx(91.9, abs=0.05)  # against the physical bays
        assert_rule_holds(r, sc)


def test_without_the_rule_the_truckload_is_larger_than_any_truck():
    """An older web sends no single_customer_fill_pct: exactly the old rule (bays x 90% for every load),
    so the 11,027-unit stop fits no truck, and nothing echoes the rule."""
    r = rq([truckload()] + others(2), fleet(), single=None)
    sc = rec(optimize_dispatch(r))
    assert unserved_map(sc) == {"TRUCKLOAD": "EXCEEDS_ANY_TRUCK_CAPACITY"}
    msg = next(u.reason_message for u in sc.unserved)
    assert "11.0 pallets vs largest truck 10.8 pallets: 12 bays at 90% fill" in msg, msg
    assert sc.single_customer_fill_pct is None
    for ld in sc.loads:
        assert ld.pallet_room_units == pallet_room_units({"R11": 11}.get(ld.truck_id, 12), FILL)


def test_an_order_over_every_bay_is_still_larger_than_any_truck():
    """12,100 units do not fit 12 bays even at 100%: refused before the search, naming the one-customer room."""
    r = rq([truckload(12_100)] + others(2), fleet())
    sc = rec(optimize_dispatch(r))
    assert unserved_map(sc) == {"TRUCKLOAD": "EXCEEDS_ANY_TRUCK_CAPACITY"}
    msg = next(u.reason_message for u in sc.unserved)
    assert "12.1 pallets vs largest truck 12.0 pallets: 12 bays at 100% fill (one customer)" in msg, msg


def test_only_an_11_bay_truck_cannot_take_it():
    """With only the 11-bay truck (11,000 at 100%) the order is larger than any truck."""
    r = rq([truckload()], [btruck("R11", bays=11, cap=1_045, max_trips=3)])
    assert unserved_map(rec(optimize_dispatch(r))) == {"TRUCKLOAD": "EXCEEDS_ANY_TRUCK_CAPACITY"}


@pytest.mark.parametrize("name", ["RECOMMENDED", "MIN_TRUCKS", "MIN_DISTANCE"])
def test_the_route_search_alone_keeps_a_full_truck_stop_alone(name):
    """The route search's own plan (what the safety net keeps when the re-check runs out of time): the
    Solo dimension and the allowed vehicles hold by themselves - a full-truck stop alone, on a truck whose
    one-customer room holds it; mixed loads at bays x 90%."""
    r = rq([truckload()] + others(6), fleet())
    tds, solvable, drops, mx, _ = _day_of(r)
    sc = ds._solve_scenario(name, r, solvable, tds, mx, 2, list(drops))
    assert sc.status == "OPTIMIZED"
    ld = load_of(sc, "TRUCKLOAD")
    assert [st.stop_id for st in ld.stops] == ["TRUCKLOAD"] and ld.truck_id != "R11"
    assert_rule_holds(r, sc)


@pytest.mark.parametrize("name", ["RECOMMENDED", "MIN_TRUCKS", "MIN_DISTANCE"])
def test_the_route_search_decides_alone_per_truck(name):
    """Review 13 Oct 2026: "rides alone" is decided per truck. A 12-bay truck and two 6-bay trucks, one trip
    each; one customer split into 6,000 + 6,000 + 1,000 (parts sized for a 6-bay truck's every bay). A
    6,000 part fits the 12-bay truck at 90% (10,800), so it is no full-truck stop for the fleet - but on a
    6-bay truck (5,400 at 90%, 6,000 alone) it may ride, alone. The route search itself (not only the load
    re-check afterwards) serves all three; another customer never joins a 6-bay load holding a part."""
    parts = [pstop(sid, 23.62, 58.47, cases=300, units=u).model_copy(update={"customer_id": "c-BIG"})
             for sid, u in (("P1", 6_000), ("P2", 6_000), ("P3", 1_000))]
    trucks = [btruck("R12", bays=12, max_trips=1), btruck("S6A", bays=6, cap=570, max_trips=1),
              btruck("S6B", bays=6, cap=570, max_trips=1)]
    r = rq(parts, trucks)
    tds, solvable, drops, mx, _ = _day_of(r)
    usable = [td for td in tds if td.usable]
    assert not any(ds.full_truck(s, usable) for s in parts)  # no stop is full for the whole fleet
    sc = ds._solve_scenario(name, r, solvable, tds, mx, 2, list(drops))
    assert served_ids(sc) == {"P1", "P2", "P3"}, unserved_map(sc)
    assert_rule_holds(r, sc)
    # With a small customer that only a 6-bay truck can still take, a 6,000 part never shares a 6-bay load.
    o = others(1, units=2_000)
    r2 = rq(parts + o, trucks)
    tds, solvable, drops, mx, _ = _day_of(r2)
    sc2 = ds._solve_scenario(name, r2, solvable, tds, mx, 2, list(drops))
    stops = {s.stop_id: s for s in r2.stops}
    for ld in sc2.loads:
        if ld.truck_id.startswith("S6"):
            assert ld.pallet_units <= 5_400 or len({stops[st.stop_id].customer_id for st in ld.stops}) == 1, ld
    assert_rule_holds(r2, sc2)


@pytest.mark.parametrize("name", ["RECOMMENDED", "MIN_TRUCKS", "MIN_DISTANCE"])
def test_a_day_that_must_leave_stops_out_still_plans(name):
    """Production 14 Oct 2026 (the 15 Oct plan): with the rule on, the route search counts per truck (the
    Pallets per truck and the Solo dimension). While those per-truck demands were unary vectors, OR-Tools
    9.15 refused every unperformed stop, so a day where any stop had to be left out found NO plan at all
    (ROUTING_FAIL in 0.1 s, every stop INFEASIBLE). One trip per truck, the truckload and ten small customers of
    2.4 pallets: the three trucks cannot carry everything (the truckload alone fills a 12-bay truck, the other
    two hold four small ones each), so the route search must leave some out - and still plans the rest."""
    r = rq([truckload()] + others(10), fleet(max_trips=1))
    tds, solvable, drops, mx, _ = _day_of(r)
    sc = ds._solve_scenario(name, r, solvable, tds, mx, 2, list(drops))
    assert sc.status == "OPTIMIZED", (sc.status, sc.solver_status)
    served = served_ids(sc)
    assert len(served) >= 5 and 0 < len(sc.unserved) <= 7, unserved_map(sc)
    assert "INFEASIBLE" not in set(unserved_map(sc).values()), unserved_map(sc)
    if "TRUCKLOAD" in served:  # MIN_DISTANCE may leave the truckload out instead of two small customers
        ld = load_of(sc, "TRUCKLOAD")
        assert [st.stop_id for st in ld.stops] == ["TRUCKLOAD"] and ld.truck_id != "R11"
    assert_rule_holds(r, sc)


def test_the_whole_engine_plans_a_day_that_must_leave_stops_out():
    """The same day through optimize_dispatch: a plan (not NO_SOLUTION), the truckload alone, the rest checked."""
    r = rq([truckload()] + others(10), fleet(max_trips=1))
    sc = rec(optimize_dispatch(r))
    assert sc.status == "OPTIMIZED", (sc.status, sc.solver_status)
    assert "TRUCKLOAD" in served_ids(sc) and sc.unserved, unserved_map(sc)
    assert "INFEASIBLE" not in set(unserved_map(sc).values()), unserved_map(sc)
    assert [st.stop_id for st in load_of(sc, "TRUCKLOAD").stops] == ["TRUCKLOAD"]
    assert_rule_holds(r, sc)


def test_two_full_truck_customers_each_get_a_truck_of_their_own():
    """Two customers of 11.5 pallets: one each on the two 12-bay trucks (one trip each), never together,
    never on the 11-bay; the small stops ride the 11-bay truck."""
    big = [pstop("X", 23.62, 58.47, cases=700, units=11_500), pstop("Y", 23.63, 58.46, cases=700, units=11_500)]
    r = rq(big + others(3), fleet(max_trips=1))
    sc = rec(optimize_dispatch(r))
    assert served_ids(sc) == {s.stop_id for s in r.stops}, unserved_map(sc)
    assert {load_of(sc, "X").truck_id, load_of(sc, "Y").truck_id} == {"R12A", "R12B"}
    assert_rule_holds(r, sc)


def test_a_small_truck_only_customer_may_fill_its_small_truck():
    """Composes with "small truck only" (allowed_truck_ids): 5.6 pallets on a 6-bay truck is over 90%
    (5.4) but within every bay (6.0): one stop, alone on the 6-bay truck, never on a 12-bay one."""
    s = pstop("HYPER", 23.61, 58.43, cases=300, units=5_600, allowed_truck_ids=["S6"],
              allowed_trucks_label="a small truck (at most 6 bays)")
    trucks = [btruck("R12A", bays=12, max_trips=2, fixed_cost=5), btruck("S6", bays=6, cap=570, max_trips=2, fixed_cost=40)]
    r = rq([s] + others(3), trucks)
    tds, *_ = _day_of(r)
    usable = [td for td in tds if td.usable]
    assert ds.full_truck(s, usable)  # judged on the trucks it may go on: 12 bays at 90% would hold it
    sc = rec(optimize_dispatch(r))
    ld = load_of(sc, "HYPER")
    assert (ld.truck_id, [st.stop_id for st in ld.stops], ld.pallet_room_units) == ("S6", ["HYPER"], 6_000)
    assert_rule_holds(r, sc)


# ---------------------------------------------------------------------------------------------
# Load re-check (repack), independent check, second search
# ---------------------------------------------------------------------------------------------

def test_repack_never_adds_a_stop_to_a_full_truck_load():
    r = rq([truckload()] + others(3), fleet())
    tds, solvable, _, mx, ctx = _day_of(r)
    day = ctx.day
    k = next(i for i, s in enumerate(day.stops) if s.stop_id == "TRUCKLOAD")
    small = next(i for i, s in enumerate(day.stops) if s.stop_id == "O0")
    r11, r12 = day.trucks[0], day.trucks[1]
    assert LR.facts(day, (k,)).customers == 1
    assert LR.fits_truck(LR.facts(day, (k,)), r12)  # alone: 11,027 <= 12,000
    assert not LR.fits_truck(LR.facts(day, (k,)), r11)  # 11,027 > 11,000
    assert not LR.fits_truck(LR.facts(day, (k, small)), r12)  # two customers: 13,427 > 10,800
    assert LR.time_plan(day, {r12.idx: [(k, small)]}, ctx.rec_pricing) is None
    assert LR.time_plan(day, {r12.idx: [(k,)]}, ctx.rec_pricing) is not None
    # Two loads of different customers are judged at 90% each, as before.
    a, b = (i for i, s in enumerate(day.stops) if s.stop_id in ("O1", "O2"))
    assert LR.fits_truck(LR.facts(day, (a, b)), r12) and LR.facts(day, (a, b)).customers == 2
    # The same truck days without the rule: the truckload fits nowhere.
    _, _, _, _, old = _day_of(rq([truckload(10_700)] + others(3), fleet(), single=None))
    assert getattr(old.day.trucks[1], "solo_pallet_units") == old.day.trucks[1].max_pallet_units == 10_800


def test_the_independent_check_measures_each_load_by_its_customers():
    """feasibility.check_scenario re-derives the room from the request's stops: the truckload alone is fine at
    11.0 / 12.0; the same load with another customer is CAPACITY_PALLETS at 10.8; without the rule its
    load alone is over 10.8."""
    r = rq([truckload()] + others(2), fleet())
    sc = rec(optimize_dispatch(r))
    assert sc.feasibility.status == "VERIFIED" and sc.feasibility.checked_at_version == FZ.CHECK_VERSION == 5
    assert FZ.check_scenario(r, sc).violations == []
    # Move O0 onto the truckload's load (the totals kept right): two customers, 13.4 pallets > 10.8.
    bad = sc.model_copy(deep=True)
    tl = load_of(bad, "TRUCKLOAD")
    ol = load_of(bad, "O0")
    st = next(x for x in ol.stops if x.stop_id == "O0")
    if ol is not tl:
        ol.stops = [x for x in ol.stops if x.stop_id != "O0"]
        ol.cases -= st.cases
        ol.pallet_units -= st.pallet_units
        tl.stops = tl.stops + [st]
        tl.cases += st.cases
        tl.pallet_units += st.pallet_units
    caps = [v for v in FZ.check_scenario(r, bad).violations if v.code == "CAPACITY_PALLETS"]
    assert len(caps) == 1 and caps[0].message.endswith("(12 bays at 90% fill)."), caps
    # Without the rule (an older web's request), the truckload's load in the same plan is over its room on its own.
    old = r.model_copy(deep=True)
    old.config.single_customer_fill_pct = None
    v = [v for v in FZ.check_scenario(old, sc).violations if v.code == "CAPACITY_PALLETS"]
    assert len(v) == 1 and "needs 11.0 pallets; the truck takes 10.8 (12 bays at 90% fill)" in v[0].message, v
    # A load of one customer over every bay: named with the one-customer room.
    over = r.model_copy(deep=True)
    next(s for s in over.stops if s.stop_id == "TRUCKLOAD").demand_pallet_units = 12_100
    over_sc = sc.model_copy(deep=True)
    load_of(over_sc, "TRUCKLOAD").pallet_units = 12_100
    next(x for x in load_of(over_sc, "TRUCKLOAD").stops if x.stop_id == "TRUCKLOAD").pallet_units = 12_100
    v = [v for v in FZ.check_scenario(over, over_sc).violations if v.code == "CAPACITY_PALLETS"]
    assert len(v) == 1 and "the truck takes 12.0 (12 bays at 100% fill, one customer)" in v[0].message, v


def test_the_second_search_is_skipped_on_a_full_truck_day(_pyvrp_in_process):
    r = rq([truckload()] + others(3), fleet(), time_limit_sec=2)
    resp = optimize_dispatch(r)
    assert (resp.search.pyvrp.status, resp.search.pyvrp.reason) == ("SKIPPED", "FULL_TRUCK")
    assert_rule_holds(r, rec(resp))
    # The rule on, but no customer needs it: the second search runs, and the plan keeps the rule.
    small = rq(others(4), fleet(), time_limit_sec=2)
    assert not ds._full_truck_day(small, small.stops)
    resp2 = optimize_dispatch(small)
    assert resp2.search.pyvrp.status in ("CHOSEN", "NOT_CHOSEN"), resp2.search.pyvrp
    assert_rule_holds(small, rec(resp2))


# ---------------------------------------------------------------------------------------------
# Shortage proofs and the hire check: never a false shortage
# ---------------------------------------------------------------------------------------------

def test_no_false_shortage_when_a_stop_may_ride_alone():
    """An 11-bay and a 12-bay truck, one trip each, at 90%: 9,900 + 10,800 = 20,700. A = 11,000 (fills the
    11-bay truck alone at 100%) and B = 9,800: 20,800 in all, more than the 90% rooms - but A alone on the
    11-bay and B on the 12-bay is a plan. The proofs count A at the 9,900 it uses, so no shortage is
    claimed, the hire check does not rule the fleet out, and both are served."""
    a = pstop("A", 23.62, 58.47, cases=700, units=11_000)
    b = pstop("B", 23.60, 58.42, cases=500, units=9_800)
    trucks = [btruck("R11", bays=11, cap=1_045, max_trips=1), btruck("R12", bays=12, max_trips=1)]
    r = rq([a, b], trucks)
    tds = ds._truck_days(r)
    assert ds._space_charges([a, b], tds) == {"A": 9_900, "B": 9_800}
    assert ds._fleet_shortage([a, b], tds) == (False, False)
    assert not ds._hire_room_short(tds, set(), [a, b])
    f = ds._fleet([a, b], tds, FILL)
    assert (f.demand_space, f.charged_space, f.cap_space) == (20_800, 19_700, 20_700)
    sc = rec(optimize_dispatch(r))
    assert served_ids(sc) == {"A", "B"}, unserved_map(sc)

    assert_rule_holds(r, sc)
    # Without the rule (an older request) every stop counts its own pallets, as before: 20,800 > 20,700 is short.
    old = rq([a, b], trucks, single=None)
    old_tds = ds._truck_days(old)
    assert ds._space_charges(old.stops, old_tds) is None
    assert ds._fleet_shortage(old.stops, old_tds) == (True, False)


def test_parts_of_one_customer_count_at_the_fill_share():
    """Two parts of one customer may share a one-customer load of up to 12.0: each counts 90% of itself,
    so 6.0 + 5.5 on one 12-bay trip is not proven short (10,350 <= 10,800)."""
    p1 = pstop("X#1", 23.62, 58.47, cases=300, units=6_000).model_copy(update={"customer_id": "c-X"})
    p2 = pstop("X#2", 23.62, 58.47, cases=270, units=5_500).model_copy(update={"customer_id": "c-X"})
    tds = ds._truck_days(rq([p1, p2], [btruck("R12", bays=12, max_trips=1)]))
    assert ds._space_charges([p1, p2], tds) == {"X#1": 5_400, "X#2": 4_950}
    assert ds._fleet_shortage([p1, p2], tds) == (False, False)
    td = tds[0]
    assert ds.load_room(td, [p1, p2]) == 12_000 and ds.load_room(td, [p1, others(1)[0]]) == 10_800


# ---------------------------------------------------------------------------------------------
# A split that cannot be avoided: the leftover rides with other customers (no extra truck for it)
# ---------------------------------------------------------------------------------------------

def test_a_small_leftover_joins_a_route_instead_of_opening_a_truck():
    """A customer bigger than 12 bays is split by the web into a full part (11,995, alone) and a leftover
    (1,238). Three 12-bay trucks, one trip each, a fixed cost per truck used: the optimizer already prices
    a truck (and a trip) it opens, so the leftover rides with the small customers on a second truck and
    the third stays home."""
    full = pstop("BIG#1", 23.62, 58.47, cases=900, units=11_995).model_copy(update={"customer_id": "c-BIG"})
    rest = pstop("BIG#2", 23.62, 58.47, cases=90, units=1_238).model_copy(update={"customer_id": "c-BIG"})
    trucks = [btruck(f"R12{x}", bays=12, max_trips=1, fixed_cost=50) for x in "ABC"]
    r = rq([full, rest] + others(3, units=3_000), trucks, scenarios=ALL)
    resp = optimize_dispatch(r)
    for sc in resp.scenarios:
        assert served_ids(sc) == {s.stop_id for s in r.stops}, (sc.name, unserved_map(sc))
        assert [st.stop_id for st in load_of(sc, "BIG#1").stops] == ["BIG#1"]
        assert len(load_of(sc, "BIG#2").stops) > 1, (sc.name, "the leftover rode alone")
        assert sc.trucks_used == 2, (sc.name, sc.trucks_used)
        assert_rule_holds(r, sc)


# ---------------------------------------------------------------------------------------------
# Contract and compatibility
# ---------------------------------------------------------------------------------------------

def test_old_requests_plan_as_before():
    """A request JSON without the field validates (None) and plans every load at the fill, echoing None."""
    body = json.loads(rq(others(3), fleet()).model_dump_json())
    del body["config"]["single_customer_fill_pct"]
    old = ds.DispatchRequest.model_validate(body)
    assert old.config.single_customer_fill_pct is None
    sc = rec(optimize_dispatch(old))
    assert sc.single_customer_fill_pct is None
    for ld in sc.loads:
        assert ld.pallet_room_units == pallet_room_units({"R11": 11}.get(ld.truck_id, 12), FILL)


def test_the_contract_carries_the_rule():
    import os

    p = os.path.join(os.path.dirname(__file__), "..", "..", "..", "packages", "shared-types", "src", "dispatch.ts")
    if not os.path.exists(p):
        pytest.skip("shared-types is not next to the solver (image build)")
    with open(p, encoding="utf-8") as f:
        ts = f.read()
    assert ts.count("single_customer_fill_pct?:") == 2  # DispatchConfig (asked) and DispatchScenario (echo)
