"""The hire suggestion (owner request 6 Oct 2026): "tell the dispatcher how many and which trucks to
RENT". The web's what-if adds one truck per unit the company may rent (DispatchTruck.hire_candidate,
fixed_cost = the hire for the day) and asks the recommended plan. The search weighs a rented truck's
hire (dispatch_solver.hire_weight), so:
- an own truck is always used before a rented one, also when the own truck costs more per day;
- a truck is rented only for stops the own fleet cannot carry, and the cheapest set of rented trucks
  that carries them wins;
- the plan reports the real costs (the weighted hire is search-only).

Haversine only (no network); every truck one load a day so the packing is exact."""
from __future__ import annotations

import pytest

import dispatch_solver as ds
from dispatch_models import DispatchTruck
from dispatch_solver import optimize_dispatch
from tests.test_dispatch import rec, req, served_ids, unserved_map
from tests.test_pallets import assert_pallets_hold, btruck, pstop


def hire(tid: str, bays: int, cost: float, **kw) -> DispatchTruck:
    """A truck the company could rent for the day (one unit of a hire option)."""
    return btruck(tid, bays=bays, fixed_cost=cost, hire_candidate=True, max_trips=1, **kw)


def own(tid: str, bays: int = 12, cost: float = 35.0, **kw) -> DispatchTruck:
    return btruck(tid, bays=bays, fixed_cost=cost, max_trips=1, **kw)


# NMWC's rough figures (owner, 6 Oct 2026): a 10-ton (12 bays) for 50 OMR a day, at most 3; a 3-ton
# (6 bays) for 30 OMR a day, at most 2.
def hire_options() -> list[DispatchTruck]:
    return [hire(f"H10-{n}", 12, 50.0) for n in (1, 2, 3)] + [hire(f"H3-{n}", 6, 30.0) for n in (1, 2)]


def stops_of(pallets: list[float], prefix: str = "S") -> list:
    """Stops close to the depot, each with its pallet need (1/1000 pallet units)."""
    return [pstop(f"{prefix}{i}", 23.60 + 0.002 * i, 58.42 + 0.002 * i, cases=20, units=int(round(p * 1000))) for i, p in enumerate(pallets)]


def hired_used(sc) -> dict[str, int]:
    """Rented trucks used by the plan: option prefix ("H10", "H3") -> how many."""
    out: dict[str, int] = {}
    for tid in sorted({ld.truck_id for ld in sc.loads if ld.truck_id.startswith("H")}):
        key = tid.split("-")[0]
        out[key] = out.get(key, 0) + 1
    return out


def solve(stops, trucks, **cfg):
    r = req(stops, trucks, time_limit_sec=3, **cfg)
    sc = rec(optimize_dispatch(r))
    assert_pallets_hold(r, sc)
    return r, sc


def test_hire_weight_keeps_any_stop_worth_a_hire():
    r = req(stops_of([1]), [own("T1")] + hire_options())
    assert ds.hire_weight(r) == 10.0  # 50 OMR x 10 = 500 OMR: half of one P5 stop (1,000 OMR)
    dear = req(stops_of([1]), [own("T1"), hire("H", 12, 125.0)])
    assert ds.hire_weight(dear) == pytest.approx(4.0)  # 125 x 4 = 500
    assert ds.hire_weight(req(stops_of([1]), [own("T1"), hire("H", 12, 900.0)])) == 1.0
    assert ds.hire_weight(req(stops_of([1]), [own("T1")])) == 1.0  # no truck to rent: nothing changes
    assert ds.hire_extra_omr(r.trucks[0], 10.0) == 0.0  # an own truck never gets it
    assert ds.hire_extra_omr(r.trucks[1], 10.0) == pytest.approx(450.0)


def test_the_routing_model_prices_an_own_truck_exactly_as_before():
    # Own trucks: day cost x the scenario's weight + the first load's trip cost (MIN DISTANCE: none),
    # whether or not the request carries trucks to rent; a truck to rent: its weighted hire on top.
    r = req(stops_of([1]), [own("T1", cost=35.0, trip_cost=3.0)] + hire_options())
    tds = ds._truck_days(r)
    hw = ds.hire_weight(r)
    for name, w in ds.SCENARIOS.items():
        before = (0.0 if w.pure_distance else 35.0 * w.fixed + 3.0 * w.trip)
        assert ds._vehicle_fixed_omr(tds[0], w, hw) == pytest.approx(before), name
        hired = ds._vehicle_fixed_omr(tds[1], w, hw)
        assert hired == pytest.approx(500.0 if w.pure_distance else 500.0 * w.fixed + tds[1].truck.trip_cost * w.trip), name
    frozen = ds.TruckDay(**{**tds[0].__dict__, "n_frozen": 1})
    assert ds._vehicle_fixed_omr(frozen, ds.SCENARIOS["RECOMMENDED"], hw) == pytest.approx(3.0)


def test_no_hire_when_the_fleet_suffices_even_if_the_own_truck_costs_more():
    # 9 pallets fit the own 10-ton; its day costs 60 OMR, a rented 10-ton 50: still the own truck.
    _, sc = solve(stops_of([3, 3, 3]), [own("T1", cost=60.0)] + hire_options())
    assert unserved_map(sc) == {}
    assert hired_used(sc) == {}


def test_a_small_shortage_rents_the_cheapest_truck_that_carries_it():
    # Own 10-ton: 12 pallets; the day has 17 -> 5 pallets left: one 3-ton (30 OMR), not a 10-ton (50).
    _, sc = solve(stops_of([3, 3, 3, 3, 2.5, 2.5]), [own("T1")] + hire_options())
    assert unserved_map(sc) == {}
    assert hired_used(sc) == {"H3": 1}


def test_one_ten_ton_beats_two_three_tons():
    # 8 pallets left: two 3-tons (60 OMR) or one 10-ton (50 OMR) -> the 10-ton.
    _, sc = solve(stops_of([3, 3, 3, 3, 2, 2, 2, 2]), [own("T1")] + hire_options())
    assert unserved_map(sc) == {}
    assert hired_used(sc) == {"H10": 1}


def test_the_cheapest_combination():
    # 14 pallets left: 10-ton + 3-ton (80 OMR) beats two 10-tons (100 OMR); two 3-tons hold only 12.
    _, sc = solve(stops_of([3, 3, 3, 3] + [2] * 7), [own("T1")] + hire_options())
    assert unserved_map(sc) == {}
    assert hired_used(sc) == {"H10": 1, "H3": 1}


def test_the_plan_reports_the_real_hire_not_the_search_weight():
    _, sc = solve(stops_of([3, 3, 3, 3, 2, 2, 2, 2]), [own("T1")] + hire_options())
    hired = [ld for ld in sc.loads if ld.truck_id.startswith("H10")]
    assert len(hired) == 1 and hired[0].fixed_cost == pytest.approx(50.0)
    day = next(d for d in sc.truck_days if d.truck_id == hired[0].truck_id)
    assert day.fixed_cost == pytest.approx(50.0)
    assert sc.objective.fixed_cost == pytest.approx(35.0 + 50.0)
    assert sc.operating_cost == pytest.approx(sum(ld.total_cost for ld in sc.loads), abs=1e-6)


def test_more_than_every_hire_can_carry_leaves_the_rest_out():
    # 12 own + 3 x 12 + 2 x 6 = 60 pallets of room (20 stops of 3 pallets); the day has 21 of them.
    r, sc = solve(stops_of([3] * 21), [own("T1")] + hire_options())
    assert hired_used(sc) == {"H10": 3, "H3": 2}
    assert len(served_ids(sc)) == 20 and len(unserved_map(sc)) == 1
    assert sum(ld.pallet_units for ld in sc.loads) == 60_000


def test_a_stop_no_truck_can_reach_in_time_rents_nothing():
    # The own truck carries the day; the extra stop's receiving hours end before any truck can be
    # there: a rented truck cannot help it, so none is rented.
    late = pstop("X", 23.70, 58.60, cases=20, units=1000, hard_start_min=300, hard_end_min=330)
    _, sc = solve(stops_of([3, 3]) + [late], [own("T1")] + hire_options(), shift_start_min=360)
    assert unserved_map(sc) == {"X": "HARD_WINDOW_INFEASIBLE"}
    assert hired_used(sc) == {}


def test_without_trucks_to_rent_nothing_changes():
    stops = stops_of([3, 3, 3, 3, 2.5, 2.5])
    _, base = solve(stops, [own("T1")])
    assert len(unserved_map(base)) == 2
    assert base.objective.fixed_cost == pytest.approx(35.0)
