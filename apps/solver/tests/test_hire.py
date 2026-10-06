"""The hire suggestion (owner request 6 Oct 2026): "tell the dispatcher how many and which trucks to
RENT". The web's what-if adds one truck per unit the company may rent (DispatchTruck.hire_candidate,
fixed_cost = the hire for the day) and asks the recommended plan. The search adds a premium to a
rented truck's hire (dispatch_solver.hire_premium), so:
- an own truck is always used before a rented one, also when the own truck costs more per day, and
  whatever the dearest option costs;
- a truck is rented only for stops the own fleet cannot carry, and the cheapest set of rented trucks
  that carries them wins, their km counted in real money with the hire;
- the plan reports the real costs (the premium is search-only);
- a cancelled solve stops waiting for road routing at once (its slot frees).

Haversine only (no network, the cancelled road matrix aside); every truck one load a day so the
packing is exact."""
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


def second_search(monkeypatch, on: str) -> None:
    """The second route search (PyVRP) off or on: it prices a rented truck as the engine does."""
    if on == "on":
        import pyvrp_candidate as PV

        monkeypatch.setenv("SOLVER_PYVRP", "on")
        monkeypatch.setenv("SOLVER_PARALLEL", "0")
        monkeypatch.setenv("SOLVER_PYVRP_MAX_ITERS", "500")
        monkeypatch.setattr(PV, "effective_cpus", lambda: 4)


def solve(stops, trucks, **cfg):
    r = req(stops, trucks, time_limit_sec=3, **cfg)
    sc = rec(optimize_dispatch(r))
    assert_pallets_hold(r, sc)
    return r, sc


def test_the_search_premium_of_a_rented_truck_keeps_own_trucks_first_and_any_stop_worth_a_hire():
    r = req(stops_of([1]), [own("T1", cost=60.0)] + hire_options() + [hire("H24-1", 24, 600.0)])
    p = ds.hire_premium(r)
    assert p == pytest.approx(60.0 + ds.HIRE_PREMIUM_MARGIN_OMR)  # the dearest own truck's day + the margin
    by_id = {t.id: t for t in r.trucks}
    assert ds.hire_extra_omr(by_id["T1"], p) == 0.0  # an own truck never gets it
    # The same premium on every usual hire: between rented trucks the hire counts in real money ...
    assert ds.hire_extra_omr(by_id["H10-1"], p) == pytest.approx(p)
    assert ds.hire_extra_omr(by_id["H3-1"], p) == pytest.approx(p)
    # ... and a rented truck weighs at most HIRE_SEARCH_CAP_OMR (half a P5 stop), unless its hire alone
    # is more: the dear option's premium shrinks, never the others'.
    assert ds.hire_extra_omr(by_id["H24-1"], p) == 0.0
    assert ds.hire_extra_omr(hire("H", 12, 450.0), p) == pytest.approx(50.0)
    assert ds.hire_premium(req(stops_of([1]), [own("T1")])) == 0.0  # no truck to rent: nothing changes


def test_the_routing_model_prices_an_own_truck_exactly_as_before():
    # Own trucks: day cost x the scenario's weight + the first load's trip cost (MIN DISTANCE: none),
    # whether or not the request carries trucks to rent; a truck to rent: its hire + the premium.
    r = req(stops_of([1]), [own("T1", cost=35.0, trip_cost=3.0)] + hire_options())
    tds = ds._truck_days(r)
    hp = ds.hire_premium(r)
    assert hp == pytest.approx(35.0 + ds.HIRE_PREMIUM_MARGIN_OMR)
    for name, w in ds.SCENARIOS.items():
        before = (0.0 if w.pure_distance else 35.0 * w.fixed + 3.0 * w.trip)
        assert ds._vehicle_fixed_omr(tds[0], w, hp) == pytest.approx(before), name
        hired = ds._vehicle_fixed_omr(tds[1], w, hp)
        assert hired == pytest.approx(50.0 + hp if w.pure_distance else (50.0 + hp) * w.fixed + tds[1].truck.trip_cost * w.trip), name
    frozen = ds.TruckDay(**{**tds[0].__dict__, "n_frozen": 1})
    assert ds._vehicle_fixed_omr(frozen, ds.SCENARIOS["RECOMMENDED"], hp) == pytest.approx(3.0)


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


@pytest.mark.parametrize("pv", ["off", "on"])
def test_a_dear_option_never_lets_a_rented_truck_stand_in_for_an_idle_own_truck(monkeypatch, pv):
    # Review: one active option at 600 OMR a day made the search weigh every hire at its real money
    # (one factor for the whole request, from the dearest option), so the what-if rented a 10-ton + a
    # 3-ton (80 OMR) while the own truck (60 OMR a day) stood idle. The own truck goes first whatever
    # the dearest option costs: the own truck + one 3-ton (30 OMR).
    second_search(monkeypatch, pv)
    _, sc = solve(stops_of([3, 3, 3, 3, 2.5, 2.5]), [own("T1", cost=60.0)] + hire_options() + [hire("H24-1", 24, 600.0)])
    assert unserved_map(sc) == {}
    assert "T1" in {ld.truck_id for ld in sc.loads}
    assert hired_used(sc) == {"H3": 1}


@pytest.mark.parametrize("pv", ["off", "on"])
def test_the_hires_are_compared_in_real_money_with_their_running_costs(monkeypatch, pv):
    # Review: a multiplied hire (x 500 / 85 here) chose two 3-tons (2 x 30 OMR) over one 10-ton
    # (85 OMR), although each 3-ton drives the long trip too: dearer in real money once the km count.
    # 12 + 10 pallets about 50 km north at 0.5 OMR a km: the own truck carries 12, one 10-ton the rest.
    second_search(monkeypatch, pv)
    far = [pstop(f"N{i}", 24.00 + 0.002 * i, 58.40, cases=20, units=int(p * 1000)) for i, p in enumerate([3, 3, 3, 3, 2, 2, 2, 2, 2])]
    km = {"cost_per_km": 0.5}
    trucks = [own("T1", **km), hire("H3-1", 6, 30.0, **km), hire("H3-2", 6, 30.0, **km), hire("H10-1", 12, 85.0, **km)]
    r, sc = solve(far, trucks)
    assert unserved_map(sc) == {}
    assert hired_used(sc) == {"H10": 1}
    # The suggested set is the cheaper one in real money: the 10-ton's hire and km below two 3-tons'.
    hired = [ld for ld in sc.loads if ld.truck_id.startswith("H")]
    assert sum(ld.total_cost for ld in hired) < 2 * 30.0 + 2 * (hired[0].total_cost - hired[0].fixed_cost)


def test_a_late_order_no_own_truck_reaches_in_time_is_delivered_by_a_rented_truck():
    # Review: the own truck is out on a LOCKED load 06:00-13:00 and a late order's customer receives
    # 07:00-11:00. The plan leaves it out as HARD_WINDOW_INFEASIBLE (no own truck is free in time); a
    # rented truck, free from the start of the day, delivers it: the web starts the what-if for it.
    late = pstop("X", 23.62, 58.43, cases=20, units=1000, hard_start_min=420, hard_end_min=660)
    t1 = btruck("T1", bays=12, fixed_cost=35.0, max_trips=2, frozen_trips=[{"load_no": 1, "depart_min": 360, "return_min": 780, "cases": 100}])
    _, base = solve([late], [t1])
    assert unserved_map(base) == {"X": "HARD_WINDOW_INFEASIBLE"}
    _, sc = solve([late], [t1] + hire_options())
    assert unserved_map(sc) == {}
    assert hired_used(sc) == {"H3": 1}


def test_a_cancelled_solve_stops_waiting_for_road_routing():
    # Review: the matrix phase never looked at the control, so a cancelled what-if (a dispatcher's
    # optimization took its slot) kept its optimizer slot until road routing answered or gave up
    # (up to 90 s). Cancelled: the matrix is abandoned within a fraction of a second, no estimate.
    import threading
    import time

    import httpx

    from providers import MatrixCancelled, resolve_matrix
    from tests.test_dispatch import _osrm_null_transport

    flag = threading.Event()
    threading.Timer(0.3, flag.set).start()
    t0 = time.monotonic()
    with pytest.raises(MatrixCancelled):
        resolve_matrix([(23.568 + i * 0.01, 58.392) for i in range(4)], provider="OSRM", osrm_url="http://osrm.local",
                       haversine_multiplier=1.3, avg_speed_kmh=40.0, deadline=time.monotonic() + 60,
                       osrm_client=httpx.Client(transport=_osrm_null_transport([], set(), sleep_s=10.0)), cancelled=flag.is_set)
    assert time.monotonic() - t0 < 2.0

    # The whole solve: SolveAborted (the endpoint frees its slot), never a plan on estimated distances.
    control = ds.SolveControl()
    threading.Timer(0.3, control.cancel, args=("the web app closed the connection",)).start()
    r = req(stops_of([1, 1]), [own("T1")] + hire_options(), distance_provider="OSRM", osrm_url="http://osrm.local")
    t0 = time.monotonic()
    with pytest.raises(ds.SolveAborted):
        optimize_dispatch(r, osrm_client=httpx.Client(transport=_osrm_null_transport([], set(), sleep_s=10.0)), control=control)
    assert time.monotonic() - t0 < 5.0
