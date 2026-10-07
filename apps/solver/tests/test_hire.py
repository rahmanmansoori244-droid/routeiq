"""The hire suggestion (owner request 6 Oct 2026): "tell the dispatcher how many and which trucks to
RENT". The web's what-if adds one truck per unit the company may rent (DispatchTruck.hire_candidate,
fixed_cost = the hire for the day, driver_day_cost = the casual driver's day rate) and asks the
recommended plan. Owner answers (6 Oct 2026) and the review of the hire branch:
- only P1-P3 orders justify renting: a rented truck is never taken for P4/P5 orders alone, but once
  it is rented for P1-P3 orders it carries P4/P5 orders in its spare room;
- own trucks go first: never a rented truck while an own truck can carry the orders (an idle own
  truck is never replaced by a rented one, however dear its day or its km);
- the cheapest set in real money (hire + the driver's day rate): two small trucks when they cost
  less than one big one, and the other way round;
- a rental is for the whole day (as many loads as its max loads per truck);
- fuel is included in the hire: a rented truck has no fuel or km cost (its option's cost per km, 0
  by default), and its driver is paid by the day, fixed, never by the hour or overtime;
- the plan reports the real costs (the hire tier is search-only);
- a cancelled solve stops waiting for road routing at once (its slot frees).

Haversine only (no network, the cancelled road matrix aside); every truck one load a day unless a
test says otherwise, so the packing is exact."""
from __future__ import annotations

import pytest

import costing
import dispatch_solver as ds
import load_repack as LR
from dispatch_models import DispatchTruck
from dispatch_solver import optimize_dispatch
from tests.test_dispatch import rec, req, served_ids, unserved_map
from tests.test_pallets import assert_pallets_hold, btruck, pstop
from tests.test_repack import matrix_for


def hire(tid: str, bays: int, cost: float, **kw) -> DispatchTruck:
    """A truck the company could rent for the day (one unit of a hire option)."""
    kw.setdefault("max_trips", 1)
    return btruck(tid, bays=bays, fixed_cost=cost, hire_candidate=True, **kw)


def own(tid: str, bays: int = 12, cost: float = 35.0, **kw) -> DispatchTruck:
    kw.setdefault("max_trips", 1)
    return btruck(tid, bays=bays, fixed_cost=cost, **kw)


# NMWC's rough figures (owner, 6 Oct 2026): a 10-ton (12 bays) for 50 OMR a day, at most 3; a 3-ton
# (6 bays) for 30 OMR a day, at most 2.
def hire_options() -> list[DispatchTruck]:
    return [hire(f"H10-{n}", 12, 50.0) for n in (1, 2, 3)] + [hire(f"H3-{n}", 6, 30.0) for n in (1, 2)]


def stops_of(pallets: list[float], prefix: str = "S", **kw) -> list:
    """Stops close to the depot, each with its pallet need (1/1000 pallet units)."""
    return [pstop(f"{prefix}{i}", 23.60 + 0.002 * i, 58.42 + 0.002 * i, cases=20, units=int(round(p * 1000)), **kw)
            for i, p in enumerate(pallets)]


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


# ---------------------------------------------------------------------------------------------
# The hire tier: between the P1-P3 orders and the P4/P5 orders, in proportion to the real money
# ---------------------------------------------------------------------------------------------

def test_the_hire_tier_sits_between_p1_p3_and_p4_p5_orders_in_proportion_to_the_money():
    stops = [pstop(f"P{p}-{i}", 23.60 + 0.002 * i, 58.42, cases=20, units=1000, priority=p) for p in (1, 2, 3, 4, 5) for i in range(3)]
    trucks = [own("T1"), hire("H10-1", 12, 50.0), hire("H3-1", 6, 30.0, driver_day_cost=10.0)]
    r = req(stops, trucks)
    for margin in (False, True):
        values, _, tier = ds._service_and_hire(r.stops, r.config, margin, r.trucks)
        value_of = {s.priority: values[k] for k, s in enumerate(r.stops)}
        low = sum(v for v, s in zip(values, r.stops) if s.priority >= 4)
        assert set(tier) == {"H10-1", "H3-1"}  # never an own truck
        # P4/P5 orders together never pay for a rented truck ...
        assert min(tier.values()) > low
        # ... one P3 order pays for the dearest one (and whatever happens to the P4/P5 orders), and
        # one P2 order outweighs every P3 order and the dearest rented truck: strict priorities hold.
        assert value_of[3] > max(tier.values()) + low
        assert value_of[2] > 3 * value_of[3] + max(tier.values()) + low
        assert value_of[1] > 3 * value_of[2] + 3 * value_of[3] + max(tier.values()) + low
        # In proportion to the real money of renting the truck for the day: its hire + the driver's day rate.
        assert tier["H10-1"] / tier["H3-1"] == pytest.approx(50.0 / 40.0, rel=1e-6)
    # Without trucks to rent the values are those of before, and there is no tier.
    plain, _ = ds._service_values(r.stops, r.config, False)
    r0 = req(stops, [own("T1")])
    v0, _, t0 = ds._service_and_hire(r0.stops, r0.config, False, r0.trucks)
    assert v0 == plain and t0 == {}
    # The repack's small weights rank the same way: a rented truck above every P4/P5 order, below one P3.
    small = ds._hire_repair_weights(r.stops, r.config, r.trucks)
    w = ds._repair_weights(r.stops, set(range(len(r.stops))), r.config, r.trucks)
    low_w = sum(w[k] for k, s in enumerate(r.stops) if s.priority >= 4)
    assert min(small.values()) > low_w
    assert min(w[k] for k, s in enumerate(r.stops) if s.priority == 3) > max(small.values()) + low_w


def test_weighted_priorities_keep_the_hire_tier_too():
    stops = [pstop(f"P{p}", 23.60, 58.42, cases=20, units=1000, priority=p) for p in (3, 4, 5)]
    r = req(stops, [own("T1"), hire("H3-1", 6, 30.0)], strict_priorities=False)
    values, _, tier = ds._service_and_hire(r.stops, r.config, False, r.trucks)
    assert tier["H3-1"] > values[1] + values[2]
    assert values[0] > tier["H3-1"] + values[1] + values[2]


def test_the_routing_model_prices_an_own_truck_exactly_as_before():
    # Own trucks: day cost x the scenario's weight + the first load's trip cost (MIN DISTANCE: none),
    # whatever the hire tier; a truck to rent: the same plus its hire tier, in every scenario.
    r = req(stops_of([1]), [own("T1", cost=35.0, trip_cost=3.0)] + hire_options())
    tds = ds._truck_days(r)
    tier = 7_000_000_000
    for name, w in ds.SCENARIOS.items():
        before = int(round((0.0 if w.pure_distance else 35.0 * w.fixed + 3.0 * w.trip) * ds.COST_SCALE))
        assert ds._vehicle_fixed_units(tds[0], w, 0) == before, name
        assert ds._vehicle_fixed_units(tds[0], w, tier) == before, name  # never on an own truck
        hired = int(round((0.0 if w.pure_distance else 50.0 * w.fixed + tds[1].truck.trip_cost * w.trip) * ds.COST_SCALE))
        assert ds._vehicle_fixed_units(tds[1], w, tier) == hired + tier, name
    frozen = ds.TruckDay(**{**tds[0].__dict__, "n_frozen": 1})
    assert ds._vehicle_fixed_units(frozen, ds.SCENARIOS["RECOMMENDED"], 0) == 3 * ds.COST_SCALE
    # A driver paid by the day: the day rate with the truck's day (weighted as driver time), once.
    rd = req(stops_of([1]), [own("T1", cost=35.0, driver_day_cost=10.0)])
    td = ds._truck_days(rd)[0]
    assert ds._vehicle_fixed_units(td, ds.SCENARIOS["RECOMMENDED"], 0) == 45 * ds.COST_SCALE
    assert ds._vehicle_fixed_units(td, ds.SCENARIOS["MIN_TRUCKS"], 0) == 35 * 20 * ds.COST_SCALE  # time weight 0


# ---------------------------------------------------------------------------------------------
# Small synthetic days
# ---------------------------------------------------------------------------------------------

def test_no_hire_when_the_fleet_suffices_even_if_the_own_truck_costs_more():
    # 9 pallets fit the own 10-ton; its day costs 60 OMR, a rented 10-ton 50: still the own truck.
    _, sc = solve(stops_of([3, 3, 3]), [own("T1", cost=60.0)] + hire_options())
    assert unserved_map(sc) == {}
    assert hired_used(sc) == {}


def test_a_p1_p3_shortage_rents_the_cheapest_truck_that_carries_it():
    # Own 10-ton: 12 pallets; the day has 17 -> 5 pallets left: one 3-ton (30 OMR), not a 10-ton (50).
    _, sc = solve(stops_of([3, 3, 3, 3, 2.5, 2.5]), [own("T1")] + hire_options())
    assert unserved_map(sc) == {}
    assert hired_used(sc) == {"H3": 1}


@pytest.mark.parametrize("pv", ["off", "on"])
def test_p4_p5_orders_alone_never_rent_a_truck(monkeypatch, pv):
    # Owner answer 1: the own 10-ton carries the 12 pallets of P3 orders; 5 pallets of P4/P5 orders do
    # not fit. A 3-ton would carry them for 30 OMR: never rented for them, they stay left out.
    second_search(monkeypatch, pv)
    stops = stops_of([3, 3, 3, 3]) + stops_of([2.5], "L", priority=4) + stops_of([2.5], "M", priority=5)
    _, sc = solve(stops, [own("T1")] + hire_options())
    assert hired_used(sc) == {}
    assert set(unserved_map(sc)) == {"L0", "M0"}
    assert {"S0", "S1", "S2", "S3"} <= served_ids(sc)


@pytest.mark.parametrize("pv", ["off", "on"])
def test_a_truck_rented_for_p1_p3_orders_carries_p4_p5_orders_in_its_spare_room(monkeypatch, pv):
    # 17 pallets of P3 orders: own 10-ton (12) + one 3-ton (6) -> 1 pallet spare, which takes the 1-pallet
    # P5 order. The other P5 orders (11 pallets) would need a 10-ton more: never rented for them.
    second_search(monkeypatch, pv)
    stops = stops_of([3, 3, 3, 3, 2.5, 2.5]) + stops_of([1, 4, 4, 3], "L", priority=5)
    _, sc = solve(stops, [own("T1")] + hire_options())
    assert hired_used(sc) == {"H3": 1}
    assert set(unserved_map(sc)) == {"L1", "L2", "L3"}
    assert "L0" in served_ids(sc)


@pytest.mark.parametrize("pv", ["off", "on"])
def test_two_small_rented_trucks_beat_one_big_when_they_cost_less(monkeypatch, pv):
    # Review of the hire branch: own T1 (35 OMR, 12 bays), 22 pallets; a 10-ton at 85 OMR or two 3-tons
    # at 30. The premium on every rented truck chose the 10-ton (85 OMR) although the two 3-tons carry
    # the 10 pallets left for 60 OMR.
    second_search(monkeypatch, pv)
    trucks = [own("T1"), hire("H10-1", 12, 85.0), hire("H3-1", 6, 30.0), hire("H3-2", 6, 30.0)]
    _, sc = solve(stops_of([3, 3, 3, 3, 2.5, 2.5, 2.5, 2.5]), trucks)
    assert unserved_map(sc) == {}
    assert hired_used(sc) == {"H3": 2}


def test_one_big_rented_truck_beats_two_small_when_it_costs_less():
    # 8 pallets left: two 3-tons (60 OMR) or one 10-ton (50 OMR) -> the 10-ton.
    _, sc = solve(stops_of([3, 3, 3, 3, 2, 2, 2, 2]), [own("T1")] + hire_options())
    assert unserved_map(sc) == {}
    assert hired_used(sc) == {"H10": 1}


def test_the_cheapest_combination():
    # 14 pallets left: 10-ton + 3-ton (80 OMR) beats two 10-tons (100 OMR); two 3-tons hold only 12.
    _, sc = solve(stops_of([3, 3, 3, 3] + [2] * 7), [own("T1")] + hire_options())
    assert unserved_map(sc) == {}
    assert hired_used(sc) == {"H10": 1, "H3": 1}


def test_the_drivers_day_rate_counts_in_the_cheapest_set():
    # 10 pallets left: two 3-tons (2 x 30) or one 10-ton (70). Without a driver to pay: the two 3-tons
    # (60 < 70). Owner answer 4: each rented truck brings a casual driver at a day rate, 15 OMR here:
    # 2 x 45 = 90 > 85 -> the 10-ton.
    stops = stops_of([3, 3, 3, 3, 2.5, 2.5, 2.5, 2.5])

    def options(rate):
        return [hire("H10-1", 12, 70.0, driver_day_cost=rate), hire("H3-1", 6, 30.0, driver_day_cost=rate),
                hire("H3-2", 6, 30.0, driver_day_cost=rate)]

    _, a = solve(stops, [own("T1")] + options(None))
    assert hired_used(a) == {"H3": 2}
    _, b = solve(stops, [own("T1")] + options(15.0))
    assert hired_used(b) == {"H10": 1}


@pytest.mark.parametrize("pv", ["off", "on"])
def test_an_idle_own_truck_is_used_before_any_rented_one(monkeypatch, pv):
    # Own T2 costs 150 OMR a day and 2 OMR a km plus fuel; a rented 10-ton 20 OMR, fuel included, its
    # driver 10 OMR a day - far cheaper in money. Still T2: never a rented truck while an own truck
    # can carry the orders.
    second_search(monkeypatch, pv)
    far = [pstop(f"N{i}", 24.00 + 0.002 * i, 58.40, cases=20, units=int(p * 1000)) for i, p in enumerate([3, 3, 3, 3, 2, 2, 2, 2, 2])]
    trucks = [own("T1"), own("T2", cost=150.0, cost_per_km=2.0, km_per_litre=3.0),
              hire("H10-1", 12, 20.0, driver_day_cost=10.0)]
    _, sc = solve(far, trucks, fuel_price_per_litre=0.3)
    assert unserved_map(sc) == {}
    assert hired_used(sc) == {}
    assert {ld.truck_id for ld in sc.loads} == {"T1", "T2"}


def test_a_dear_option_never_lets_a_rented_truck_stand_in_for_an_idle_own_truck():
    # Review: one active option at 600 OMR a day once made the what-if rent while the own truck stood
    # idle. The own truck (60 OMR a day) goes first whatever the options cost: own + one 3-ton.
    _, sc = solve(stops_of([3, 3, 3, 3, 2.5, 2.5]), [own("T1", cost=60.0)] + hire_options() + [hire("H24-1", 24, 600.0)])
    assert unserved_map(sc) == {}
    assert "T1" in {ld.truck_id for ld in sc.loads}
    assert hired_used(sc) == {"H3": 1}


def test_a_rental_is_for_the_whole_day_one_rented_truck_makes_two_loads():
    # Owner answer 2: a rented truck works the whole day, as many loads as its max loads per truck. 10
    # pallets left and a 3-ton may make 2 loads: one 3-ton twice (one hire, one day rate), never two.
    trucks = [own("T1")] + [hire(f"H3-{n}", 6, 30.0, driver_day_cost=10.0, max_trips=2) for n in (1, 2)]
    _, sc = solve(stops_of([3, 3, 3, 3, 2.5, 2.5, 2.5, 2.5]), trucks)
    assert unserved_map(sc) == {}
    assert hired_used(sc) == {"H3": 1}
    loads = sorted((ld for ld in sc.loads if ld.truck_id.startswith("H3")), key=lambda ld: ld.load_no)
    assert [ld.load_no for ld in loads] == [1, 2]
    assert [ld.driver_cost for ld in loads] == [pytest.approx(10.0), 0.0]  # the day rate once


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


# ---------------------------------------------------------------------------------------------
# The load re-check (post-solve repack) ranks a rented truck as the search does
# ---------------------------------------------------------------------------------------------

@pytest.mark.parametrize("priority, rented", [(5, False), (4, False), (3, True)])
def test_the_load_recheck_opens_a_rented_truck_for_p1_p3_orders_only(priority, rented):
    # The repack adds orders the search left out as one-stop loads, carrying the most value first: an
    # unused rented truck must not be opened for P4/P5 orders alone - it is for a P3 order.
    stops = stops_of([3, 3, 3, 3]) + stops_of([2, 2], "L", priority=priority)
    r = req(stops, [own("T1"), hire("H3-1", 6, 30.0)])
    tds = ds._truck_days(r)
    ctx = ds._stage_ctx(r, r.stops, tds, matrix_for(r), [])
    optional = ds._repair_weights(r.stops, {4, 5}, r.config, r.trucks)
    res = LR.repack(ctx.day, ctx.rec_pricing, [(0, 1, 2, 3), (4,), (5,)], {0, 1, 2, 3}, optional, None, 5.0)
    assert res.plan is not None
    h = next(td.idx for td in tds if td.truck.hire_candidate)
    assert (h in res.plan) is rented
    # The score ranks the same way: renting for the P3 orders is better service, for P4/P5 worse.
    timed = LR.time_plan(ctx.day, res.plan, ctx.rec_pricing)
    with_hire = LR.time_plan(ctx.day, {0: [(0, 1, 2, 3)], h: [(4, 5)]}, ctx.rec_pricing)
    without = LR.time_plan(ctx.day, {0: [(0, 1, 2, 3)]}, ctx.rec_pricing)
    a, b = LR.score(ctx.day, ctx.rec_pricing, with_hire), LR.score(ctx.day, ctx.rec_pricing, without)
    assert (a.service < b.service) is rented
    assert a.hire > 0 and b.hire == 0 and a.unserved < b.unserved
    assert timed is not None


# ---------------------------------------------------------------------------------------------
# Costs: fuel included in the hire, the driver paid by the day; the plan reports the real money
# ---------------------------------------------------------------------------------------------

def test_costing_pays_a_day_rate_driver_once_per_truck_day():
    rates = costing.DayRates(driver_per_hour=2.0, overtime_per_hour=4.0, overtime_after_s=3600, fuel_price_per_litre=0.3)
    day_rate = costing.TruckRates(fixed=30.0, trip=1.0, per_km=0.0, driver_day=10.0)
    lt = [costing.LoadTiming(depart_s=360 * 60, return_s=600 * 60, km=40.0), costing.LoadTiming(depart_s=660 * 60, return_s=900 * 60, km=30.0)]
    d = costing.truck_day_costs(day_rate, rates, lt)
    assert [l.driver for l in d.loads] == [10.0, 0.0]
    assert [l.overtime for l in d.loads] == [0.0, 0.0] and all(l.overtime_s == 0 for l in d.loads)
    assert [l.fixed for l in d.loads] == [30.0, 0.0]
    assert [l.fuel for l in d.loads] == [0.0, 0.0] and [l.distance for l in d.loads] == [0.0, 0.0]
    assert d.total == pytest.approx(30 + 10 + 2 * 1.0)
    # A truck already out today (frozen loads): its day rate was paid with them.
    later = costing.truck_day_costs(day_rate, rates, lt[1:], anchor_s=360 * 60, frozen_return_s=600 * 60)
    assert later.loads[0].driver == 0.0 and later.loads[0].fixed == 0.0
    # An own truck keeps its hourly driver (and overtime).
    hourly = costing.truck_day_costs(costing.TruckRates(fixed=30.0), rates, lt)
    assert hourly.loads[0].driver == pytest.approx(240 / 60 * 2.0) and hourly.loads[1].overtime > 0


def test_a_rented_truck_costs_no_fuel_and_pays_its_driver_by_the_day():
    # Owner answers 3 and 4: fuel at 0.3 OMR/l and drivers at 2 OMR/h (overtime after 1 h at 4 OMR/h) for
    # the own truck; the rented 3-ton: fuel in its hire (no km cost), its casual driver 10 OMR for the day.
    trucks = [own("T1", cost_per_km=0.1, km_per_litre=3.0), hire("H3-1", 6, 30.0, driver_day_cost=10.0, trip_cost=2.0)]
    r, sc = solve(stops_of([3, 3, 3, 3, 2.5, 2.5]), trucks, fuel_price_per_litre=0.3, driver_cost_per_hour=2.0,
                  overtime_cost_per_hour=4.0, overtime_after_min=60)
    assert hired_used(sc) == {"H3": 1}
    [h] = [ld for ld in sc.loads if ld.truck_id == "H3-1"]
    assert h.distance_km > 0
    assert (h.fuel_cost, h.distance_cost, h.overtime_cost) == (0.0, 0.0, 0.0)
    assert h.fuel_litres is None
    assert h.driver_cost == pytest.approx(10.0)
    assert h.total_cost == pytest.approx(30.0 + 2.0 + 10.0)
    day = next(d for d in sc.truck_days if d.truck_id == "H3-1")
    assert (day.fixed_cost, day.driver_cost, day.fuel_cost, day.distance_cost) == (pytest.approx(30.0), pytest.approx(10.0), 0.0, 0.0)
    [o] = [ld for ld in sc.loads if ld.truck_id == "T1"]
    assert o.fuel_cost > 0 and o.distance_cost > 0
    assert o.driver_cost == pytest.approx((o.return_min - o.depart_min) / 60 * 2.0, abs=0.01)
    assert sc.operating_cost == pytest.approx(sum(ld.total_cost for ld in sc.loads), abs=1e-6)


def test_the_plan_reports_the_real_hire_not_the_search_weight():
    _, sc = solve(stops_of([3, 3, 3, 3, 2, 2, 2, 2]), [own("T1")] + hire_options())
    hired = [ld for ld in sc.loads if ld.truck_id.startswith("H10")]
    assert len(hired) == 1 and hired[0].fixed_cost == pytest.approx(50.0)
    day = next(d for d in sc.truck_days if d.truck_id == hired[0].truck_id)
    assert day.fixed_cost == pytest.approx(50.0)
    assert sc.objective.fixed_cost == pytest.approx(35.0 + 50.0)
    assert sc.operating_cost == pytest.approx(sum(ld.total_cost for ld in sc.loads), abs=1e-6)
    # The service part of the objective is the orders left out only (none here), never the hire tier.
    assert sc.objective.unserved_penalty == 0


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


# ---------------------------------------------------------------------------------------------
# Third review of the hire branch
# ---------------------------------------------------------------------------------------------

def ring(n: int = 12, r_km: float = 25.0, priorities: tuple[int, ...] = (3,)) -> list:
    """``n`` one-pallet stops on a ring ``r_km`` round the depot, their ids out of the ring's order; their
    priorities take turns round the ring (all P3 by default)."""
    import math

    from tests.test_dispatch import DEPOT

    out = []
    for i in range(n):
        a = 2 * math.pi * i / n
        lat = DEPOT.lat + (r_km / 111.0) * math.sin(a)
        lng = DEPOT.lng + (r_km / (111.0 * math.cos(math.radians(DEPOT.lat)))) * math.cos(a)
        out.append(pstop(f"S{(i * 5) % n:02d}", lat, lng, cases=20, units=1000, priority=priorities[i % len(priorities)]))
    return out


@pytest.mark.parametrize("pv", ["off", "on"])
@pytest.mark.parametrize("kind", ["to rent", "hired"])
@pytest.mark.parametrize("priorities", [(3,), (1, 3, 2)], ids=["P3", "P1-P3-P2"])
def test_a_rented_truck_drives_its_stops_in_a_sensible_order(monkeypatch, pv, kind, priorities):
    # Review: a truck whose fuel is in the hire and whose driver is paid by the day cost nothing per km
    # or per hour in the search, so its stops were left in any order (358 km instead of 232). The own
    # T1 (2 bays, no km cost) cannot carry the day: the 12-bay truck - to rent (the what-if), or hired
    # for the day ("Use this plan": no km cost, its driver at the day rate) - drives as short a route
    # as an own 12-bay truck with a km cost on the same stops. Search only: its reported costs stay 0.
    # Fifth review: with P1, P3 and P2 orders taking turns round the ring, the default early-arrival
    # preference (P1 0.01, P2 0.005 OMR a minute) outweighed the tiny tie-breaker on its km - one minute
    # earlier at a P1 order was worth 10 km - and it drove the P1 orders first wherever they were: 340
    # km instead of 250, back at 16:30 instead of 14:16. Its km now weigh against the customers' time
    # preferences as an own truck's do (_order_km_rate), and it is back as early as the own truck.
    second_search(monkeypatch, pv)
    stops = ring(priorities=priorities)
    big = btruck("H10-1", bays=12, fixed_cost=50.0, driver_day_cost=10.0, max_trips=1, hire_candidate=kind == "to rent")
    _, sc = solve(stops, [own("T1", bays=2), big])
    assert unserved_map(sc) == {}
    [rented] = [ld for ld in sc.loads if ld.truck_id == "H10-1"]
    assert len(rented.stops) == 12
    _, mine = solve(stops, [own("O12", bays=12, cost_per_km=0.1)])
    [ref] = mine.loads
    assert rented.distance_km <= ref.distance_km * 1.02
    assert rented.return_min <= ref.return_min + 10
    assert (rented.distance_cost, rented.fuel_cost) == (0.0, 0.0)
    assert rented.driver_cost == pytest.approx(10.0)


def ordered_after_pick(r, plan: dict[str, list[tuple[int, ...]]]):
    """(the plan timed exactly, the same plan once the chosen plan's day-paid loads are put in order)."""
    import time

    tds = ds._truck_days(r)
    ctx = ds._stage_ctx(r, r.stops, tds, matrix_for(r), [])
    idx = {td.truck.id: td.idx for td in tds}
    timed = LR.time_plan(ctx.day, {idx[t]: loads for t, loads in plan.items()}, ctx.rec_pricing)
    assert timed is not None
    before = LR.Candidate("RECOMMENDED", timed, LR.score(ctx.day, ctx.rec_pricing, timed))
    after = ds._shorter_orders(ctx, before, time.monotonic() + 10)
    for i, loads in after.plan.items():
        assert LR.timing_ok(ctx.day, ctx.day.by_idx[i], loads)
    return ctx, idx, before, after


@pytest.mark.parametrize("early, shorter", [({1: 0.01, 2: 0.005}, True), ({1: 1.0, 2: 0.5}, False)],
                         ids=["default preference", "far above the km"])
def test_a_day_paid_trucks_load_is_put_in_order_with_its_km_weighed_as_an_own_trucks(early, shorter):
    # Fifth review: the order the search left on the hired truck (its P1 orders first wherever they
    # are: 340 km, back at 16:30). Once the plan is chosen, its km weigh against the customers' time
    # preferences as an own truck's do (_order_km_rate: 0.1 OMR/km here, no own truck has a km rate).
    # With the default preference the ring wins (250 km, back at 14:16); with one far above the km (1
    # OMR a minute at a P1 order) the order stays. Same truck, stops and money either way; timed exactly.
    r = req(ring(priorities=(1, 3, 2)), [own("T1", bays=2), btruck("H", bays=12, fixed_cost=50.0, driver_day_cost=10.0, max_trips=1)],
            early_preference_per_min={1: 0.0, 2: 0.0, 3: 0.0, 4: 0.0, 5: 0.0, **early})
    assert ds._order_km_rate(r) == pytest.approx(ds.HIRE_ORDER_KM_OMR) == pytest.approx(0.1)
    zigzag = (6, 5, 3, 2, 0, 11, 10, 9, 8, 7, 4, 1)  # the search's order before the fix, by ring position
    ctx, idx, before, after = ordered_after_pick(r, {"H": [zigzag]})
    [b], [a] = before.plan[idx["H"]], after.plan[idx["H"]]
    assert sorted(a.stops) == sorted(b.stops) and list(after.plan) == list(before.plan)
    assert after.score.operating == before.score.operating == costing.to_units(60.0)
    assert after.score.service == before.score.service
    if shorter:
        assert after.score.metres < 252_000 < 340_000 < before.score.metres
        assert (a.return_s // 60, b.return_s // 60) == (855, 990)
        # Better on the trade-off: the time preferences lose less than its km at 0.1 OMR/km save.
        assert after.score.cost > before.score.cost
        km_omr = ds._order_km_rate(r) * (before.score.metres - after.score.metres) / 1000
        assert (after.score.cost - before.score.cost) / ds.COST_SCALE < km_omr
    else:
        assert after is before and a.stops == zigzag


def in_ring_order(stops: tuple[int, ...], n: int) -> bool:
    """A load driven round its arc of the ring one way, never back and forth."""
    steps = {(b - a) % n for a, b in zip(stops, stops[1:])}
    return steps <= {1} or steps <= {n - 1}


def test_every_load_of_a_whole_day_rental_is_put_in_order_and_an_own_truck_never():
    # A rental is for the whole day (owner answer 2): its day is routed again (sixth review: which stops
    # go on which load too) - each load one half of the ring, driven round it, the truck back earlier. An
    # own truck's loads keep the search's order (its km are priced as money in the search already), and a
    # day without rented or day-paid trucks keeps the very same plan. The km rate is the own trucks'
    # average (A 0.2, B 0.6).
    stops = ring(r_km=10.0, priorities=(1, 3, 2))
    trucks = [own("A", bays=6, max_trips=2, cost_per_km=0.2), own("B", bays=1, cost_per_km=0.6),
              hire("H", 6, 50.0, driver_day_cost=10.0, max_trips=2)]
    r = req(stops, trucks)
    assert ds._order_km_rate(r) == pytest.approx(0.4)
    loads = [(0, 3, 1, 5, 2, 4), (6, 9, 7, 11, 8, 10)]
    _, idx, before, after = ordered_after_pick(r, {"H": loads})
    got = after.plan[idx["H"]]
    assert sorted(k for tl in got for k in tl.stops) == list(range(12))
    assert len(got) == 2 and all(is_arc(set(tl.stops), 12) and in_ring_order(tl.stops, 12) for tl in got)
    assert got[-1].return_s < before.plan[idx["H"]][-1].return_s
    assert after.score.operating == before.score.operating and after.score.metres < before.score.metres
    # The own truck A: the same loads keep their order.
    _, idx, before, after = ordered_after_pick(r, {"A": loads})
    assert after is before
    r0 = req(stops, [own("A", bays=6, max_trips=2, cost_per_km=0.2)])
    _, _, before, after = ordered_after_pick(r0, {"A": loads})
    assert after is before


def test_the_search_prices_a_day_paid_trucks_km_and_time_at_a_tiny_tie_breaker_never_as_money():
    # The tie-breaker (fourth review): a tiny rate on a day-paid truck's km (HIRE_TIE_KM_OMR, on top of
    # its own km charge, if any) and time (HIRE_TIE_HOUR_OMR) - never the own fleet's rates, never
    # money (score().operating is the real cost), and compared after the cost in every goal.
    trucks = [own("T1", cost_per_km=0.1, km_per_litre=3.0), hire("H3-1", 6, 30.0, driver_day_cost=10.0),
              hire("H3-2", 6, 30.0, driver_day_cost=10.0, cost_per_km=0.5)]
    r = req(stops_of([3, 3]), trucks, fuel_price_per_litre=0.3, driver_cost_per_hour=2.0)
    assert ds.HIRE_TIE_KM_OMR <= 0.001 and ds.HIRE_TIE_HOUR_OMR <= 0.05
    assert ds._search_km_rate(r.trucks[0], r.config) == pytest.approx(0.2)  # an own truck: its own rate only
    assert ds._search_km_rate(r.trucks[1], r.config) == pytest.approx(ds.HIRE_TIE_KM_OMR)
    assert ds._search_km_rate(r.trucks[2], r.config) == pytest.approx(0.5 + ds.HIRE_TIE_KM_OMR)
    # A truck to rent has its fuel in the hire whoever pays its driver: its km get the tie-breaker too.
    assert ds._search_km_rate(hire("H3-9", 6, 30.0), r.config) == pytest.approx(ds.HIRE_TIE_KM_OMR)
    tds = ds._truck_days(r)
    p = ds._pricing("RECOMMENDED", r, tds, r.stops)
    own_p, h1, h2 = (p.trucks[td.idx] for td in tds)
    tie_m = ds.HIRE_TIE_KM_OMR * ds.COST_SCALE / 1000
    assert (own_p.tie_m, own_p.tie_span) == (0.0, 0)
    assert h1.per_m == 0.0 and h1.tie_m == pytest.approx(tie_m) and h1.tie_span == 1
    assert h2.per_m == pytest.approx(0.5 * ds.COST_SCALE / 1000) and h2.tie_m == pytest.approx(tie_m) and h2.tie_span == 1
    # 1 objective unit a second against the hourly driver's 2 OMR an hour (55.6 units a second).
    assert p.span == 56 and h1.tie_span * 50 < p.span
    ctx = ds._stage_ctx(r, r.stops, tds, matrix_for(r), [])
    h = tds[1].idx
    timed = LR.time_plan(ctx.day, {h: [(0, 1)]}, ctx.rec_pricing)
    sc = LR.score(ctx.day, ctx.rec_pricing, timed)
    money = costing.truck_day_costs(ctx.rec_pricing.truck_rates(h), ctx.rec_pricing.day_rates(),
                                    [costing.LoadTiming(depart_s=t.depart_s, return_s=t.return_s, km=ctx.day.metres(t.stops) / 1000) for t in timed[h]]).total
    assert sc.operating == costing.to_units(money)  # 30 + the day rate: no km, no hours
    assert money == pytest.approx(40.0)
    assert 0 < sc.tie < costing.to_units(0.1)  # far below a tenth of an OMR on this short load
    assert sc.objective == sc.unserved + sc.hire + sc.cost + sc.tie
    # Compared after the cost in every goal: a plan 0.01 OMR cheaper wins whatever its tie.
    cheap = LR.Score(unserved=0, cost=1_000_000, trucks=1, loads=1, metres=5000, operating=1_000_000, tie=10**9)
    dear = LR.Score(unserved=0, cost=1_001_000, trucks=1, loads=1, metres=5000, operating=1_001_000, tie=0)
    for goal in ds._GOALS.values():
        assert goal(cheap) < goal(dear)
    # A request without a day-paid truck: no tie anywhere (planned exactly as before).
    r0 = req(stops_of([3, 3]), [own("T1", cost_per_km=0.1)])
    tds0 = ds._truck_days(r0)
    p0 = ds._pricing("RECOMMENDED", r0, tds0, r0.stops)
    assert all((tp.tie_m, tp.tie_span) == (0.0, 0) for tp in p0.trucks.values())


def cluster(prefix: str, km: float, n: int = 12) -> list:
    """``n`` one-pallet P3 stops close together about ``km`` north of the depot."""
    from tests.test_dispatch import DEPOT

    return [pstop(f"{prefix}{i:02d}", DEPOT.lat + km / 111.0 + 0.002 * (i % 4), DEPOT.lng + 0.002 * (i // 4), cases=20, units=1000)
            for i in range(n)]


@pytest.mark.parametrize("pv", ["off", "on"])
@pytest.mark.parametrize("kind", ["to rent", "hired"])
def test_the_tie_breaker_never_makes_a_plan_dearer(monkeypatch, pv, kind):
    # Fourth review: the tie-breaker priced a day-paid truck's km at the own fleet's average rate (A 0.2
    # and B 0.6 OMR/km: 0.4) and its time at the hourly rate, and RECOMMENDED added it to the cost. A
    # drove the far stops (about 160 km: 32 OMR of km and 12 of driver) and H the near ones: about 139
    # OMR instead of 103. H (its fuel in the hire, its driver at the day rate) now drives the far stops,
    # and the plan reports the lower total - the what-if's plan too, which "Use this plan" applies.
    second_search(monkeypatch, pv)
    near, far = cluster("N", 5.0), cluster("F", 60.0)
    trucks = [own("A", cost_per_km=0.2), own("B", bays=1, cost_per_km=0.6),
              btruck("H", bays=12, fixed_cost=50.0, driver_day_cost=10.0, max_trips=1, hire_candidate=kind == "to rent")]
    _, sc = solve(near + far, trucks, driver_cost_per_hour=2.0)
    assert unserved_map(sc) == {}
    on = {ld.truck_id: {st.stop_id[0] for st in ld.stops} for ld in sc.loads}
    assert on == {"A": {"N"}, "H": {"F"}}
    [h] = [ld for ld in sc.loads if ld.truck_id == "H"]
    assert (h.distance_cost, h.fuel_cost, h.driver_cost) == (0.0, 0.0, pytest.approx(10.0))
    assert sc.operating_cost < 110.0


@pytest.mark.parametrize("pv", ["off", "on"])
def test_the_options_km_charge_counts_in_the_cheapest_set(monkeypatch, pv):
    # Review: the tier ranked an option by its hire + day rate only, so HA (50 OMR a day + 1 OMR a km)
    # beat HB (60 OMR, no km charge) on a day with far orders: 238 OMR instead of 70. The option's km
    # charge over a rough day's km now counts in the tier's money: HB.
    second_search(monkeypatch, pv)
    from tests.test_dispatch import DEPOT

    north = [pstop(f"N{i:02d}", DEPOT.lat + 0.8 + 0.003 * i, DEPOT.lng, cases=20, units=1000) for i in range(11)]
    west = [pstop(f"W{i:02d}", DEPOT.lat, DEPOT.lng - 0.8 - 0.003 * i, cases=20, units=1000) for i in range(11)]
    trucks = [own("T1"), hire("HA-1", 12, 50.0, cost_per_km=1.0, driver_day_cost=10.0), hire("HB-1", 12, 60.0, driver_day_cost=10.0)]
    _, sc = solve(north + west, trucks)
    assert unserved_map(sc) == {}
    assert hired_used(sc) == {"HB": 1}
    # The money the tier ranks by: the hire, the day rate and the km charge over the rough day's km.
    r = req(north + west, trucks)
    km = ds._hire_day_km(r.stops, r.config, r.depot, r.trucks[1])
    assert 150 < km < 260  # one load a day: a round trip of the day's average road distance
    assert ds.hire_money(r.trucks[1], r.config, km) == pytest.approx(60.0 + km)
    assert ds.hire_money(r.trucks[2], r.config, km) == pytest.approx(70.0)


@pytest.mark.parametrize("margin, n, cost", [(False, 90, 85.0), (True, 70, 150.0)])
def test_a_day_the_plan_ranks_strictly_stays_strict_with_trucks_to_rent(margin, n, cost):
    # Review: the tier multiplied the strict weights by the rented trucks' money (60-150 OMR), so a day
    # of 450 stops (no margins) or 350 (with margins) got capped priorities in the what-if only - one
    # P1 order was worth about 7 P2 orders. A coarser money resolution keeps it strict.
    stops = [pstop(f"P{p}-{i}", 23.60 + 0.0001 * i, 58.42 + 0.0001 * p, cases=20, units=1000, priority=p,
                   **({"margin": 0.2} if margin else {})) for p in (1, 2, 3, 4, 5) for i in range(n)]
    trucks = [own("T1")] + [hire(f"H10-{k}", 12, cost, driver_day_cost=10.0) for k in range(3)] + [hire("H3-1", 6, cost / 2, driver_day_cost=10.0)]
    r = req(stops, [own("T1")])
    plain, warn0 = ds._service_values(r.stops, r.config, margin)
    assert warn0 == []  # the plan in use ranks strictly
    rh = req(stops, trucks)
    values, warnings, tier = ds._service_and_hire(rh.stops, rh.config, margin, rh.trucks)
    assert warnings == []
    by = {p: [v for v, s in zip(values, rh.stops) if s.priority == p] for p in (1, 2, 3, 4, 5)}
    low = sum(by[4]) + sum(by[5])
    # One P1 order outweighs every lower order together and the dearest rented truck, and so on down.
    assert min(by[1]) > sum(by[2]) + sum(by[3]) + low + max(tier.values())
    assert min(by[2]) > sum(by[3]) + low + max(tier.values())
    assert min(by[3]) > max(tier.values()) + low
    assert min(tier.values()) > low
    # Still in proportion to the money: a 10-ton's day against a 3-ton's.
    assert tier["H10-0"] / tier["H3-1"] == pytest.approx((cost + 10.0) / (cost / 2 + 10.0), rel=1e-6)


# ---------------------------------------------------------------------------------------------
# The real-size demo and the last re-review (sixth review of the hire branch)
# ---------------------------------------------------------------------------------------------
# The real Muscat day (80 orders: P1 6, P2 20, P3 38, P4 10, P5 6; three own 10-tons): the what-if
# rented 2 x 10-ton, although the same request with ONE 10-ton to rent delivered all 25 P1-P3 orders
# left out and passed the timing check - the second truck only carried P4/P5 orders (owner answer 1),
# and the set was not the cheapest. The Quick search stops in a local optimum: emptying a rented truck
# needs every one of its stops moved at once, and each move alone saves nothing. After the search the
# set is REDUCED (dispatch_solver._reduce_hire; the cheapest set since the seventh review, below): a
# smaller or cheaper set is kept when every P1-P3 order the check's plan delivers is still delivered and
# the plan passes every check. The "one truck fewer" line comes from such a solve, never an estimate
# (DispatchResponse.hire_check.one_fewer).

def spread_day(seed: int, n: int = 30) -> list:
    """``n`` one-pallet stops 10-60 km round the depot, P1-P5 (mostly P3), from a fixed seed: a day the
    own truck (12 bays, two loads) cannot carry alone."""
    import math
    import random

    from tests.test_dispatch import DEPOT

    rnd = random.Random(seed)
    out = []
    for i in range(n):
        a, r = rnd.uniform(0, 2 * math.pi), rnd.uniform(10, 60)
        lat = DEPOT.lat + (r / 111.0) * math.sin(a)
        lng = DEPOT.lng + (r / (111.0 * math.cos(math.radians(DEPOT.lat)))) * math.cos(a)
        out.append(pstop(f"S{i:02d}", lat, lng, cases=20, units=1000, priority=rnd.choice((1, 2, 3, 3, 3, 4, 5))))
    return out


def ten_tons(n: int = 3, trips: int = 3) -> list[DispatchTruck]:
    """NMWC's 10-ton to rent (12 bays, 50 OMR a day, its driver 10 OMR), ``n`` units, ``trips`` loads a day."""
    return [hire(f"H10-{k}", 12, 50.0, driver_day_cost=10.0, max_trips=trips) for k in range(1, n + 1)]


def high_ids(stops) -> set[str]:
    return {s.stop_id for s in stops if s.priority <= 3}


@pytest.mark.parametrize("seed", [0, 1])
def test_a_day_quick_rents_two_trucks_for_gets_the_one_that_suffices(monkeypatch, seed):
    # The Quick search alone rented two 10-tons on this day when it got stuck within its 3 s (its first
    # plan, hire_check.first); one of them, with its whole day of loads, carries every P1-P3 order: the
    # suggestion is that one. Seventh review: a faster machine finds the one 10-ton within the 3 s, so
    # the first plan may rent one or two (test_the_cheapest_set_of_the_first_plan_... forces two); the
    # suggestion is one either way (from two: after the solve that found it). Thirteenth review: the solve of
    # the own truck alone - the one set cheaper than a 10-ton - may leave P3 orders out while it carries a P5
    # order; once repaired, such a solve proves nothing (it is solved once more), so the 10-ton is complete
    # exactly when no solve of the own truck alone stayed unproven.
    stops = spread_day(seed)
    r = req(stops, [own("T1", max_trips=2)] + ten_tons(), time_limit_sec=3)
    unproven: list[set[str]] = []
    orig = ds._repair_lost

    def watched(rq, *a, **kw):
        new, open_ = orig(rq, *a, **kw)
        if open_ and not any(t.hire_candidate for t in rq.trucks):
            unproven.append(open_)
        return new, open_

    monkeypatch.setattr(ds, "_repair_lost", watched)
    resp = optimize_dispatch(r)
    sc = rec(resp)
    assert_pallets_hold(r, sc)
    assert hired_used(sc) == {"H10": 1}
    assert high_ids(stops) <= served_ids(sc)
    hc = resp.hire_check
    assert hc is not None
    assert len(hc.first) in (1, 2) and len(hc.used) == 1 and set(hc.used) <= set(hc.first)
    assert hc.solves >= len(hc.first) - 1 and hc.complete == (not unproven)
    assert sc.feasibility is not None and sc.feasibility.status == "VERIFIED"
    # Reported as the real money: one hire and one day rate.
    assert sc.objective.fixed_cost == pytest.approx(35.0 + 50.0)


def first_search_sees(monkeypatch, change) -> None:
    """The search's FIRST plan of a request is made for ``change(request)``; every later solve - the
    reduction's - sees the request as it is."""
    orig = ds._run_scenarios
    calls = {"n": 0}

    def first_changed(names, rq, solvable, tds, mx, *a, **kw):
        calls["n"] += 1
        if calls["n"] == 1:
            other = change(rq)
            return orig(names, other, solvable, ds._truck_days(other), mx, *a, **kw)
        return orig(names, rq, solvable, tds, mx, *a, **kw)

    monkeypatch.setattr(ds, "_run_scenarios", first_changed)


def first_search_rents_smaller(monkeypatch, bays: int) -> None:
    """The search's FIRST plan of a request with trucks to rent is made as if each could hold only
    ``bays`` bays, so it rents more of them than the day needs (as the Quick search did on the real
    day); every later solve - the reduction's - sees the trucks as they are."""
    first_search_sees(monkeypatch, lambda rq: rq.model_copy(update={
        "trucks": [t.model_copy(update={"bays": bays}) if t.hire_candidate else t for t in rq.trucks]}))


@pytest.mark.parametrize("pv", ["off", "on"])
def test_a_rented_truck_only_p4_p5_orders_need_is_given_back(monkeypatch, pv):
    # Owner answer 1: the own 10-ton (12 pallets) + 10 pallets of P3 orders left + 3 pallets of P5
    # orders. The first plan rents two 10-tons (all 25 pallets delivered); with ONE 10-ton every P3
    # order is still delivered and only a P5 order stays out: one 10-ton is suggested (the solves of
    # the reduction run the second search too, as the what-if's own search does).
    second_search(monkeypatch, pv)
    stops = stops_of([3, 3, 3, 3] + [2.5] * 4) + stops_of([1.5, 1.5], "L", priority=5)
    first_search_rents_smaller(monkeypatch, bays=8)
    r = req(stops, [own("T1")] + ten_tons(2, trips=1), time_limit_sec=3)
    resp = optimize_dispatch(r)
    sc = rec(resp)
    assert hired_used(sc) == {"H10": 1}
    assert high_ids(stops) <= served_ids(sc)
    assert len([u for u in sc.unserved if u.stop_id.startswith("L")]) == 1
    hc = resp.hire_check
    assert sorted(hc.first) == ["H10-1", "H10-2"] and len(hc.used) == 1
    # The reported money is the reduced plan's: one hire.
    assert sc.objective.fixed_cost == pytest.approx(35.0 + 50.0)
    assert sc.feasibility is not None and sc.feasibility.status == "VERIFIED"


def test_the_reduction_never_gives_back_a_truck_a_p1_p3_order_needs():
    # 14 pallets of P3 orders left: a 10-ton + a 3-ton (test_the_cheapest_combination). Every cheaper
    # set - no truck, a 3-ton, a 10-ton, two 3-tons - holds 24 pallets at most for 26: both kept, and the
    # set is complete without a search solve (seventh review: ruled out by their room).
    stops = stops_of([3, 3, 3, 3] + [2] * 7)
    r = req(stops, [own("T1")] + hire_options(), time_limit_sec=3)
    resp = optimize_dispatch(r)
    sc = rec(resp)
    assert unserved_map(sc) == {}
    assert hired_used(sc) == {"H10": 1, "H3": 1}
    hc = resp.hire_check
    assert hc.complete and sorted(hc.used) == sorted(hc.first) and hc.solves == 1
    # One truck fewer, SOLVED (the one solve): the 3-ton (the least useful, the least room: one 2-pallet
    # order would stay out).
    of = hc.one_fewer
    assert of is not None and of.without.startswith("H3-")
    assert [s for s in of.unserved if s.startswith("S")] and len(of.unserved) == 1
    # Exactly what a plan with the 10-ton alone leaves out.
    ten = next(t for t in hc.used if t.startswith("H10"))
    alone = rec(optimize_dispatch(req(stops, [own("T1"), next(t for t in r.trucks if t.id == ten)], time_limit_sec=3)))
    assert len(alone.unserved) == len(of.unserved)


def test_one_rented_truck_the_own_fleet_can_replace_is_given_back(monkeypatch):
    # Never rent while an own truck could do the job: the first plan rents a 3-ton although the own
    # 10-ton carries the whole day (9 pallets). The reduction leaves it out: nothing to hire.
    import dispatch_solver

    stops = stops_of([3, 3, 3])
    orig = dispatch_solver._run_scenarios
    calls = {"n": 0}

    def own_too_small(names, rq, solvable, tds, mx, *a, **kw):
        calls["n"] += 1
        if calls["n"] == 1:
            small = rq.model_copy(update={"trucks": [t.model_copy(update={"bays": 4}) if not t.hire_candidate else t for t in rq.trucks]})
            return orig(names, small, solvable, ds._truck_days(small), mx, *a, **kw)
        return orig(names, rq, solvable, tds, mx, *a, **kw)

    monkeypatch.setattr(dispatch_solver, "_run_scenarios", own_too_small)
    r = req(stops, [own("T1"), hire("H3-1", 6, 30.0, driver_day_cost=10.0)], time_limit_sec=3)
    resp = optimize_dispatch(r)
    sc = rec(resp)
    assert hired_used(sc) == {} and unserved_map(sc) == {}
    assert resp.hire_check.first == ["H3-1"] and resp.hire_check.used == []


def test_no_trucks_to_rent_no_reduction():
    resp = optimize_dispatch(req(stops_of([3, 3]), [own("T1")], time_limit_sec=3))
    assert resp.hire_check is None


def test_the_reduction_stops_at_its_solve_limit(monkeypatch):
    # At most HIRE_REDUCE_MAX_SOLVES extra solves (and its time budget): the set is then reported as
    # not proven the cheapest, and no "one truck fewer" is given without a solve of that very set. The
    # first plan rents a 10-ton and both 3-tons; the 10-ton alone needs a solve to be tried.
    monkeypatch.setattr(ds, "HIRE_REDUCE_MAX_SOLVES", 0)
    first_search_rents_smaller(monkeypatch, bays=4)
    resp = optimize_dispatch(req(stops_of([3, 3, 3, 3] + [2.5] * 4), ten_and_two_threes(), time_limit_sec=3))
    hc = resp.hire_check
    assert hc.solves == 0 and not hc.complete
    assert hc.used == hc.first == ["H10-1", "H3-1", "H3-2"] and hc.one_fewer is None


# ---------------------------------------------------------------------------------------------
# The cheapest set, never the greedy one (seventh review of the hire branch)
# ---------------------------------------------------------------------------------------------
# The reduction left the dearest truck out first and kept each removal that still delivered every P1-P3
# order: it could end on a set bigger and dearer than one inside the first plan (2 x 3-ton for 80 OMR
# where 1 x 10-ton for 60 delivers every order, "complete"), and it never swapped a rented truck for a
# cheaper one the plan did not use (1 x 10-ton kept where 1 x 3-ton suffices). A rented truck carrying
# only P4/P5 orders stayed whenever the budget allowed one solve or none (every day of about 165 stops
# and more), and a solve that only just fitted the budget had no load re-check, yet replaced the plan.

def ten_and_two_threes() -> list[DispatchTruck]:
    """The review's trucks: the own 10-ton, a 10-ton to rent (50 OMR + its driver's day rate of 10) and
    two 3-tons (30 + 10 each)."""
    return [own("T1"), hire("H10-1", 12, 50.0, driver_day_cost=10.0), hire("H3-1", 6, 30.0, driver_day_cost=10.0),
            hire("H3-2", 6, 30.0, driver_day_cost=10.0)]


def given_plan(r, solvable, tds, mx, drops, loads: dict[str, list[tuple[str, ...]]], time_limit: int = 3):
    """The RECOMMENDED scenario of exactly ``loads`` (truck id -> the stop ids of each of its loads), timed
    exactly and checked as every plan is (_build_scenario)."""
    ctx = ds._stage_ctx(r, solvable, tds, mx, drops)
    plan = {ctx.truck_idx[t]: [tuple(ctx.stop_idx[s] for s in ld) for ld in lds] for t, lds in loads.items()}
    timed = LR.time_plan(ctx.day, plan, ctx.rec_pricing)
    assert timed is not None
    return ds._build_scenario("RECOMMENDED", r, solvable, tds, mx, timed, ctx.values, ctx.use_margin, drops,
                              solver_status="SUCCESS", elapsed=0.0, time_limit=time_limit,
                              objective_value=LR.score(ctx.day, ctx.rec_pricing, timed).objective,
                              extra_warnings=ctx.value_warnings, exact_timing=True)


def first_plan_is(monkeypatch, loads: dict[str, list[tuple[str, ...]]]) -> None:
    """The search's FIRST plan of a request is exactly ``loads`` (given_plan); every later solve - the
    reduction's - is the real search."""
    orig = ds._run_scenarios
    calls = {"n": 0}

    def given(names, rq, solvable, tds, mx, time_limit, drops, *a, **kw):
        calls["n"] += 1
        if calls["n"] > 1:
            return orig(names, rq, solvable, tds, mx, time_limit, drops, *a, **kw)
        if kw.get("state") is not None:
            kw["state"].update(limit=time_limit, search_sec=0.0, status="OPTIMIZED")
        return [given_plan(rq, solvable, tds, mx, drops, loads, time_limit)]

    monkeypatch.setattr(ds, "_run_scenarios", given)


def test_the_cheapest_set_of_the_first_plan_not_the_one_left_after_the_dearest_goes(monkeypatch):
    # The review's day: the own 10-ton (12 pallets) and 22 pallets of P3 orders. The first plan rents the
    # 10-ton and both 3-tons; leaving the dearest out first kept 2 x 3-ton (80 OMR, 2 trucks) and called
    # it complete, although the 10-ton alone (60 OMR, 1 truck) delivers every order. The sets are tried
    # cheapest first: no truck and one 3-ton cannot hold 22 pallets (12, 18: no solve), the 10-ton does.
    stops = stops_of([3, 3, 3, 3] + [2.5] * 4)
    first_search_rents_smaller(monkeypatch, bays=4)
    resp = optimize_dispatch(req(stops, ten_and_two_threes(), time_limit_sec=3))
    sc = rec(resp)
    hc = resp.hire_check
    assert hc.first == ["H10-1", "H3-1", "H3-2"]
    assert hc.used == ["H10-1"] and hired_used(sc) == {"H10": 1}
    assert unserved_map(sc) == {}
    assert sc.feasibility is not None and sc.feasibility.status == "VERIFIED"
    assert sc.objective.fixed_cost == pytest.approx(35.0 + 50.0)
    assert hc.complete and hc.solves == 1


def test_a_rented_truck_is_swapped_for_a_cheaper_one_the_first_plan_did_not_use(monkeypatch):
    # The review's day: the own 10-ton (12 pallets), 17 pallets of P3 orders (5 left over); two 10-tons
    # to rent (50 + 10) and a 3-ton (30 + 10). The first plan rents both 10-tons (as a search that never
    # looked at the 3-ton would); removals alone kept one 10-ton (60 OMR) where the 3-ton (40) suffices.
    stops = stops_of([3, 3, 3, 3, 2.5, 2.5])
    first_search_sees(monkeypatch, lambda rq: rq.model_copy(update={"trucks": [
        t.model_copy(update={"bays": 3}) if t.id.startswith("H10") else t for t in rq.trucks if t.id != "H3-1"]}))
    trucks = [own("T1")] + ten_tons(2, trips=1) + [hire("H3-1", 6, 30.0, driver_day_cost=10.0)]
    resp = optimize_dispatch(req(stops, trucks, time_limit_sec=3))
    sc = rec(resp)
    hc = resp.hire_check
    assert hc.first == ["H10-1", "H10-2"]
    assert hc.used == ["H3-1"] and hired_used(sc) == {"H3": 1}
    assert unserved_map(sc) == {}
    assert sc.feasibility is not None and sc.feasibility.status == "VERIFIED"
    assert sc.objective.fixed_cost == pytest.approx(35.0 + 30.0)
    assert hc.complete and hc.solves == 1


def test_a_rented_truck_with_only_p4_p5_orders_is_given_back_without_a_solve(monkeypatch):
    # Owner answer 1 on a big day (one solve in the budget, none above 350 stops): the first plan rents
    # a 10-ton for P3 orders and a 3-ton that carries only P5 orders. Not one solve is allowed here: the
    # 3-ton is still given back - its load deleted, its orders left out - and every other load stays as
    # it was, timed and checked. Nothing cheaper is left: no truck or one 3-ton cannot hold the 24 pallets
    # of P3 orders (12, 18).
    monkeypatch.setattr(ds, "HIRE_REDUCE_MAX_SOLVES", 0)
    stops = stops_of([3] * 8) + stops_of([1.5, 1.5], "L", priority=5)
    loads = {"T1": [("S0", "S1", "S2", "S3")], "H10-1": [("S4", "S5", "S6", "S7")], "H3-1": [("L0", "L1")]}
    first_plan_is(monkeypatch, loads)
    trucks = [own("T1"), hire("H10-1", 12, 50.0, driver_day_cost=10.0), hire("H3-1", 6, 30.0, driver_day_cost=10.0)]
    resp = optimize_dispatch(req(stops, trucks, time_limit_sec=3))
    sc = rec(resp)
    hc = resp.hire_check
    assert hc.first == ["H10-1", "H3-1"] and hc.used == ["H10-1"] and hc.solves == 0 and hc.complete
    assert set(unserved_map(sc)) == {"L0", "L1"}
    assert {ld.truck_id: [tuple(st.stop_id for st in ld.stops)] for ld in sc.loads} == {"T1": loads["T1"], "H10-1": loads["H10-1"]}
    assert sc.feasibility is not None and sc.feasibility.status == "VERIFIED"
    assert sc.objective.fixed_cost == pytest.approx(35.0 + 50.0)
    # Told why (twelfth review): left out because a truck is not rented for P4/P5 orders alone - never
    # "could not be placed by the optimizer ... add a truck", which asked for the truck just given back.
    assert all(u.reason_message.startswith(ds.HIRE_DROP_HEAD) for u in sc.unserved)
    assert not any("could not be placed by the optimizer" in w for w in sc.warnings)
    assert any(w.startswith(f"2{ds.HIRE_DROP_NOTE}") for w in sc.warnings)


# Eighth review of the hire branch: the give-back above was the whole step whenever it applied - the set
# it left was never solved again, so the P4/P5 orders of the truck given back were dropped although the
# truck kept had room and loads to spare (the real Muscat day: the second 10-ton carried only P4/P5
# orders); and the cheapest set never had more trucks than the plan's (1 x 10-ton at 85 OMR stayed where
# 2 x 3-ton at 80 deliver every order, "complete").

@pytest.mark.parametrize("trips", [1, 3])
def test_the_p4_p5_orders_of_a_truck_given_back_ride_along_in_the_truck_kept(monkeypatch, trips):
    # The own 10-ton full of P3 orders; the first plan rents a 10-ton for 6 pallets of P3 orders and a
    # second 10-ton for the two P5 orders alone. The second is given back (owner answer 1) and the set
    # left - the first 10-ton - is solved: its 6 free bays (and loads to spare, with 3 a day) carry the
    # P5 orders (they may ride along), so nothing is left out, for the same hire money.
    stops = stops_of([3] * 6) + stops_of([1.5, 1.5], "L", priority=5)
    loads = {"T1": [("S0", "S1", "S2", "S3")], "H10-1": [("S4", "S5")], "H10-2": [("L0", "L1")]}
    first_plan_is(monkeypatch, loads)
    r = req(stops, [own("T1")] + ten_tons(2, trips=trips), time_limit_sec=3)
    resp = optimize_dispatch(r)
    sc = rec(resp)
    assert_pallets_hold(r, sc)
    hc = resp.hire_check
    assert hc.first == ["H10-1", "H10-2"] and hc.used == ["H10-1"] and hc.complete
    # No truck to rent cannot hold the 18 pallets of P3 orders (12): the one solve is the set kept.
    assert hc.solves == 1
    assert unserved_map(sc) == {} and hired_used(sc) == {"H10": 1}
    assert not any("could not be placed by the optimizer" in w for w in sc.warnings)
    assert sc.feasibility is not None and sc.feasibility.status == "VERIFIED"
    # The hire of one 10-ton (with 3 loads a day it may carry the whole day: the own truck then stays in).
    assert sc.objective.fixed_cost == pytest.approx(35.0 + 50.0) if trips == 1 else sc.objective.fixed_cost <= 35.0 + 50.0


def test_the_cheapest_set_may_have_more_trucks_than_the_plans(monkeypatch):
    # The own 10-ton and 22 pallets of P3 orders; a 10-ton to rent for 75 + 10 = 85 OMR and two 3-tons
    # for 30 + 10 = 40 each. The first plan rents the 10-ton (as a stuck search would): 2 x 3-ton (80 OMR)
    # deliver every order too, and are cheaper. No truck (12 pallets) and one 3-ton (18) cannot hold 22.
    stops = stops_of([3, 3, 3, 3] + [2.5] * 4)
    first_plan_is(monkeypatch, {"T1": [("S0", "S1", "S2", "S3")], "H10-1": [("S4", "S5", "S6", "S7")]})
    trucks = [own("T1"), hire("H10-1", 12, 75.0, driver_day_cost=10.0), hire("H3-1", 6, 30.0, driver_day_cost=10.0),
              hire("H3-2", 6, 30.0, driver_day_cost=10.0)]
    r = req(stops, trucks, time_limit_sec=3)
    resp = optimize_dispatch(r)
    sc = rec(resp)
    assert_pallets_hold(r, sc)
    hc = resp.hire_check
    assert hc.first == ["H10-1"]
    assert hc.used == ["H3-1", "H3-2"] and hired_used(sc) == {"H3": 2} and hc.complete
    assert unserved_map(sc) == {}
    assert sc.feasibility is not None and sc.feasibility.status == "VERIFIED"
    assert sc.objective.fixed_cost == pytest.approx(35.0 + 60.0)


def test_a_cheaper_set_with_more_trucks_than_can_be_listed_is_never_called_complete(monkeypatch):
    # A safety bound on the sets listed (each option has up to 10 units a day): past it the set found
    # stays, never claimed the cheapest.
    import time

    monkeypatch.setattr(ds, "HIRE_REDUCE_MAX_SETS", 1)
    r = req(stops_of([3, 3, 3, 3] + [2.5] * 4), [own("T1"), hire("H10-1", 12, 75.0, driver_day_cost=10.0),
                                                 hire("H3-1", 6, 30.0, driver_day_cost=10.0),
                                                 hire("H3-2", 6, 30.0, driver_day_cost=10.0)], time_limit_sec=3)
    mx = matrix_for(r)
    first = given_plan(r, r.stops, ds._truck_days(r), mx, [], {"T1": [("S0", "S1", "S2", "S3")], "H10-1": [("S4", "S5", "S6", "S7")]})
    scs, hc = ds._reduce_hire(r, r.stops, mx, [], 3, time.monotonic() + 600, None, [first])
    assert hc.used == hc.first == ["H10-1"] and not hc.complete and hc.solves == 0
    assert scs[0] is first


def test_the_stops_a_load_re_check_left_out_for_loading_time_keep_their_reason_when_a_truck_is_given_back():
    # The plan without a rented truck that carries only P4/P5 orders is built again: a stop the load
    # re-check had left out for the loading time between loads keeps that reason (and its warning), not
    # "the optimizer found no truck ... Re-plan to search again".
    stops = stops_of([3] * 6) + stops_of([1.5], "L", priority=5)
    trucks = [own("T1"), hire("H10-1", 12, 50.0, driver_day_cost=10.0), hire("H3-1", 6, 30.0, driver_day_cost=10.0)]
    r = req(stops, trucks, time_limit_sec=3)
    mx = matrix_for(r)
    tds = ds._truck_days(r)
    ctx = ds._stage_ctx(r, r.stops, tds, mx, [])
    plan = {ctx.truck_idx["T1"]: [tuple(ctx.stop_idx[s] for s in ("S0", "S1", "S2", "S3"))],
            ctx.truck_idx["H10-1"]: [(ctx.stop_idx["S4"],)], ctx.truck_idx["H3-1"]: [(ctx.stop_idx["L0"],)]}
    timed = LR.time_plan(ctx.day, plan, ctx.rec_pricing)
    sc = ds._build_scenario("RECOMMENDED", r, r.stops, tds, mx, timed, ctx.values, ctx.use_margin, [],
                            solver_status="SUCCESS", elapsed=0.0, time_limit=3,
                            objective_value=LR.score(ctx.day, ctx.rec_pricing, timed).objective,
                            extra_warnings=ctx.value_warnings, timing_drops={ctx.stop_idx["S5"]}, exact_timing=True)
    sc.warnings.append(ds._timing_drop_warning(r.config, 1, 0))
    reason = {u.stop_id: u.reason_message for u in sc.unserved}["S5"]
    assert reason.startswith(ds.TIMING_DROP_HEAD)
    high = {s.stop_id: s.priority <= 3 for s in stops}
    new = ds._without_low_hires(r, r.stops, mx, [], sc, {"H10-1", "H3-1"}, lambda sid: high[sid])
    assert new is not sc and {ld.truck_id for ld in new.loads} == {"T1", "H10-1"}
    assert {u.stop_id: u.reason_message for u in new.unserved}["S5"] == reason
    assert ds._timing_drop_warning(r.config, 1, 0) in new.warnings
    # The P5 order of the truck given back rides along in H10-1's free room (eleventh review), so no stop
    # is "not placed": S5 is not counted as one (this is the give-back without a solve).
    assert stops_on(new)["H10-1"] == {"S4", "L0"}
    assert not any("could not be placed by the optimizer" in w for w in new.warnings)


def test_the_least_useful_truck_is_measured_alike_for_bays_and_cases(monkeypatch):
    # Review: a truck's room was its pallet units (1/1000 pallet) when it has bays, its cases when it has
    # a case capacity - so a truck to rent entered by cases always looked the smallest. One measure: a
    # 12-bay truck holds 240 cases of this day (20 cases a pallet), the 600-case truck more. "One truck
    # fewer" is solved without the 12-bay one.
    import time

    from dispatch_models import DispatchTruck as T

    stops = [pstop(f"S{i:02d}", 23.60 + 0.002 * i, 58.42, cases=20, units=1000) for i in range(20)]
    big = T(id="HC-1", code="HC-1", capacity_cases=600, fixed_cost=40.0, driver_day_cost=10.0, hire_candidate=True, max_trips=1)
    r = req(stops, [own("T1"), hire("H10-1", 12, 50.0, driver_day_cost=10.0), big], time_limit_sec=3)
    tds = ds._truck_days(r)
    room = ds._hire_room(tds)
    assert room["H10-1"] == 240 and room["HC-1"] == 600
    # Every truck by bays: by pallets (their bays).
    r2 = req(stops, [own("T1"), hire("H10-1", 12, 50.0), hire("H3-1", 6, 30.0)], time_limit_sec=3)
    assert ds._hire_room(ds._truck_days(r2)) == {"H10-1": 12000, "H3-1": 6000}
    mx = matrix_for(r)
    first = given_plan(r, r.stops, tds, mx, [], {"T1": [tuple(f"S{i:02d}" for i in range(12))],
                                                 "H10-1": [tuple(f"S{i:02d}" for i in range(12, 16))],
                                                 "HC-1": [tuple(f"S{i:02d}" for i in range(16, 20))]})
    offered: list[list[str]] = []

    def unchecked(rq, *a, **kw):
        offered.append(sorted(t.id for t in rq.trucks if t.hire_candidate))
        return first, False  # never re-checked: neither kept nor ruled out

    monkeypatch.setattr(ds, "_hire_trial", unchecked)
    _, hc = ds._reduce_hire(r, r.stops, mx, [], 3, time.monotonic() + 600, None, [first])
    assert hc.used == ["H10-1", "HC-1"] and not hc.complete
    assert offered[-1] == ["HC-1"]


def test_a_reduction_solve_starts_only_with_room_for_its_load_re_check(monkeypatch):
    # Review: a solve started with its search time + 23 s left, and its load re-check (about 29 s more)
    # was skipped - the raw search plan became the suggestion ("Loads were not re-checked ..."). With
    # that old need + 4 s left no solve starts, and the set found stays, not proven the cheapest.
    import time

    r = req(stops_of([3, 3, 3, 3] + [2.5] * 4), ten_and_two_threes(), time_limit_sec=3)
    tds = ds._truck_days(r)
    mx = matrix_for(r)
    first = given_plan(r, r.stops, tds, mx, [], {"T1": [("S0", "S1", "S2", "S3")], "H10-1": [("S4", "S5")],
                                                 "H3-1": [("S6",)], "H3-2": [("S7",)]})
    stage: list[float] = []
    orig = ds._post_solve

    def watched(*a, **kw):
        stage.append(a[8] - time.monotonic())  # the time left when the load re-check starts
        return orig(*a, **kw)

    monkeypatch.setattr(ds, "_post_solve", watched)
    old_need = 3 + ds.REPACK_MIN_SEC + ds.REC_OVERHEAD_SEC
    scs, hc = ds._reduce_hire(r, r.stops, mx, [], 3, time.monotonic() + ds.STAGE_GRACE_SEC + old_need + 4, None, [first])
    assert all(left >= ds.STAGE_GRACE_SEC + 5 + ds.REPACK_MIN_SEC for left in stage)
    assert hc.solves == 0 and not hc.complete and hc.used == hc.first == ["H10-1", "H3-1", "H3-2"]
    assert scs[0] is first


def test_a_solve_without_its_load_re_check_never_replaces_the_plan(monkeypatch):
    # The reduction's solves get no time for their load re-check (the plans are only re-timed): none of
    # them may replace the first plan, none counts as "loses an order", none gives "one truck fewer".
    import time

    first_search_rents_smaller(monkeypatch, bays=4)
    orig = ds._post_solve
    calls = {"n": 0}

    def out_of_time(*a, **kw):
        calls["n"] += 1
        if calls["n"] > 1:  # the reduction's solves
            a = (*a[:8], time.monotonic() + 1, *a[9:])
        return orig(*a, **kw)

    monkeypatch.setattr(ds, "_post_solve", out_of_time)
    monkeypatch.setattr(ds, "HIRE_REDUCE_MAX_SOLVES", 2)
    resp = optimize_dispatch(req(stops_of([3, 3, 3, 3] + [2.5] * 4), ten_and_two_threes(), time_limit_sec=3))
    sc = rec(resp)
    hc = resp.hire_check
    assert hc.solves == 2 and calls["n"] == 3
    assert hc.used == hc.first == ["H10-1", "H3-1", "H3-2"] and not hc.complete and hc.one_fewer is None
    assert hired_used(sc) == {"H10": 1, "H3": 2}
    assert not any("not re-checked" in w for w in sc.warnings)


@pytest.mark.parametrize("time_limit", [3, 20, 50, 150, 240])
def test_the_reductions_solves_fit_its_window_with_their_re_check_and_big_days_get_two(time_limit):
    # A solve needs its worker, its search, the search's overhead and the load re-check's whole reserve
    # (_hire_trial_need). Big days: a 200-350-stop day (150 s) got one solve at most, a day above 350
    # stops (240 s) none. A reduction solve searches as long as the what-if up to 20 s, half as long
    # above (never under 20 s), and the window holds two of them.
    lim = ds._hire_trial_limit(time_limit, ds._hire_reduce_window(time_limit))
    assert lim == (time_limit if time_limit <= 20 else max(20, time_limit // 2))
    assert ds._hire_reduce_window(time_limit) >= max(ds.HIRE_REDUCE_SEC, 2 * ds._hire_trial_need(lim))
    cap = min(ds.REPACK_CAP_SEC, max(ds.REPACK_MIN_SEC, lim / 2))
    assert ds._hire_trial_need(lim) >= lim + ds.REC_OVERHEAD_SEC + ds.STAGE_GRACE_SEC + 5 + cap
    # Less time left: a shorter search, down to half of it again (never under 20 s), then no solve.
    short = ds._hire_trial_limit(time_limit, ds._hire_trial_need(lim) - 10)
    assert short is None if lim - 10 < max(min(lim, 20), time_limit // 4) else short == lim - 10
    assert ds._hire_trial_limit(time_limit, 10) is None


# Ninth review of the hire branch: the solve of the set left after a give-back replaced the give-back
# only when it served more stops - money was never compared, so a cheaper set that solve had just proven
# was thrown away ("complete"), and stops were counted raw, so two P5 orders outweighed one P4.

def solves_are(monkeypatch, plans: dict[tuple[str, ...], dict[str, list[tuple[str, ...]]] | tuple[dict, bool]]) -> list[list[str]]:
    """The reduction's solves (_hire_trial) return exactly ``plans`` (the rented trucks offered -> the
    plan's loads, given_plan), every one with its load re-check run unless the loads come as (loads,
    False); the trucks offered, in order."""
    offered: list[list[str]] = []

    def given(rq, solvable, mx, drops, *a, **kw):
        ids = sorted(t.id for t in rq.trucks if t.hire_candidate)
        offered.append(ids)
        loads, rechecked = plans[tuple(ids)] if isinstance(plans[tuple(ids)], tuple) else (plans[tuple(ids)], True)
        return given_plan(rq, solvable, ds._truck_days(rq), mx, drops, loads), rechecked

    monkeypatch.setattr(ds, "_hire_trial", given)
    return offered


def three_ten_ton_day():
    """The own 10-ton, six 3-pallet P3 orders (18 pallets) and two P5 orders; three 10-tons to rent
    (50 + 10 OMR each). The search's plan rents all three: H10-1 and H10-2 one P3 order each, H10-3 the
    P5 orders alone."""
    import time

    stops = stops_of([3] * 6) + stops_of([1.5, 1.5], "L", priority=5)
    r = req(stops, [own("T1")] + ten_tons(3, trips=1), time_limit_sec=3)
    mx = matrix_for(r)
    first = given_plan(r, r.stops, ds._truck_days(r), mx, [], {"T1": [("S0", "S1", "S2", "S3")], "H10-1": [("S4",)],
                                                               "H10-2": [("S5",)], "H10-3": [("L0", "L1")]})
    return r, mx, first, time.monotonic() + 600


def test_a_cheaper_set_the_solve_after_a_give_back_proves_is_the_suggestion(monkeypatch):
    # H10-3 is given back (P5 orders only): 2 x 10-ton, 120 OMR. The one cheaper set left after the room
    # check, 1 x 10-ton, is solved, and that solve proves nothing (its load re-check is skipped; a stuck
    # solve that leaves S5 out with room for it is repaired since the thirteenth review). The set left is
    # solved: H10-1 carries both P3 orders, H10-2 only the P5 ones - given back, so ONE 10-ton (60 OMR)
    # delivers every P1-P3 order. It was discarded (it served no more stops): 2 x 10-ton for 120 OMR,
    # "complete", and "one truck fewer" said S5 stays out with one 10-ton.
    r, mx, first, end = three_ten_ton_day()
    offered = solves_are(monkeypatch, {
        ("H10-1",): ({"T1": [("S0", "S1", "S2", "S3")], "H10-1": [("S4",)]}, False),
        ("H10-1", "H10-2"): {"T1": [("S0", "S1", "S2", "S3")], "H10-1": [("S4", "S5")], "H10-2": [("L0", "L1")]},
    })
    scs, hc = ds._reduce_hire(r, r.stops, mx, [], 3, end, None, [first])
    assert offered == [["H10-1"], ["H10-1", "H10-2"]]
    assert hc.first == ["H10-1", "H10-2", "H10-3"] and hc.used == ["H10-1"] and hc.solves == 2 and hc.complete
    assert hc.one_fewer is None
    sc = scs[0]
    assert hired_used(sc) == {"H10": 1} and high_ids(r.stops) <= served_ids(sc)
    assert sc.feasibility is not None and sc.feasibility.status == "VERIFIED"
    assert sc.objective.fixed_cost == pytest.approx(35.0 + 50.0)


def test_a_solve_after_a_give_back_that_keeps_a_truck_for_p4_p5_orders_alone_never_replaces_it(monkeypatch):
    # The same day; the solve of the set left puts the P5 orders on H10-2 alone, and its plan without
    # H10-2 cannot be built (here: the give-back returns the plan as it is). That plan rents a truck for
    # P5 orders alone (owner answer 1): it never replaces the give-back - it did, as it served more stops -
    # and its trucks for the P1-P3 orders (H10-1 alone) may be a cheaper set: not proven the cheapest.
    # The give-back of H10-3 puts its P5 orders in the free room of the 10-tons kept (eleventh review).
    # The solves of one 10-ton prove nothing (their load re-check is skipped), so "one truck fewer" is
    # solved too and tells nothing.
    r, mx, first, end = three_ten_ton_day()
    solves_are(monkeypatch, {
        ("H10-1",): ({"T1": [("S0", "S1", "S2", "S3")], "H10-1": [("S4",)]}, False),
        ("H10-1", "H10-2"): {"T1": [("S0", "S1", "S2", "S3")], "H10-1": [("S4", "S5")], "H10-2": [("L0", "L1")]},
        ("H10-2",): ({"T1": [("S0", "S1", "S2", "S3")], "H10-2": [("S4",)]}, False),
    })
    orig = ds._without_low_hires
    calls = {"n": 0}

    def not_built_the_second_time(rq, solvable, mx_, drops, sc, *a, **kw):
        calls["n"] += 1
        return sc if calls["n"] == 2 else orig(rq, solvable, mx_, drops, sc, *a, **kw)

    monkeypatch.setattr(ds, "_without_low_hires", not_built_the_second_time)
    scs, hc = ds._reduce_hire(r, r.stops, mx, [], 3, end, None, [first])
    assert calls["n"] == 2 and hc.solves == 3
    assert hc.used == ["H10-1", "H10-2"] and not hc.complete and hc.one_fewer is None
    sc = scs[0]
    high = high_ids(r.stops)
    for tid in hc.used:  # every rented truck carries a P1-P3 order
        assert any(st.stop_id in high for ld in sc.loads if ld.truck_id == tid for st in ld.stops)
    assert unserved_map(sc) == {} and stops_on(sc)["H10-1"] | stops_on(sc)["H10-2"] == {"S4", "S5", "L0", "L1"}


TWO_P5_ABOVE_A_P4 = {1: 10000.0, 2: 1000.0, 3: 100.0, 4: 1.5, 5: 1.0}


@pytest.mark.parametrize("strict, weights, x0_kept", [(True, None, True), (False, None, True), (False, TWO_P5_ABOVE_A_P4, False)])
def test_the_solve_after_a_give_back_never_drops_a_p4_order_to_carry_two_p5_orders(monkeypatch, strict, weights, x0_kept):
    # The give-back plan (H10-2 carried the P5 orders alone) delivers the P4 order X0 (4 pallets) on the
    # own truck, 7 stops; neither 2.5-pallet P5 order fits the 2 pallets left. The solve of the set left
    # (the 10-ton kept, as cheap) drops X0 and carries both P5 orders: 8 stops. With strict priorities
    # one P4 order outweighs every P5 order together, so the give-back stays (it was replaced: 8 > 7
    # stops). The weighted scheme ranks by its weights: one P4 (10) over two P5 (1 each) by default, two
    # P5 orders over one P4 when the company weighs them so.
    import time

    stops = stops_of([3] * 6) + stops_of([4], "X", priority=4) + stops_of([2.5, 2.5], "L", priority=5)
    cfg = {"strict_priorities": strict} | ({"priority_weights": weights} if weights else {})
    r = req(stops, [own("T1")] + ten_tons(2, trips=1), time_limit_sec=3, **cfg)
    mx = matrix_for(r)
    first = given_plan(r, r.stops, ds._truck_days(r), mx, [], {"T1": [("S0", "S1", "X0")],
                                                               "H10-1": [("S2", "S3", "S4", "S5")], "H10-2": [("L0", "L1")]})
    solves_are(monkeypatch, {("H10-1",): {"T1": [("S0", "S1", "S2", "L0")], "H10-1": [("S3", "S4", "S5", "L1")]}})
    scs, hc = ds._reduce_hire(r, r.stops, mx, [], 3, time.monotonic() + 600, None, [first])
    # No truck to rent cannot hold the 18 pallets of P3 orders (12): the one solve is the set kept.
    assert hc.used == ["H10-1"] and hc.solves == 1 and hc.complete
    out = set(unserved_map(scs[0]))
    assert out == ({"L0", "L1"} if x0_kept else {"X0"})


# Tenth review of the hire branch: a give-back deletes the loads of a truck rented for P4/P5 orders alone
# with no solve, so the P4 order it carried stayed out while a truck kept still carried P5 orders it had
# room for in their place (strict priorities: never drop a higher priority to carry lower ones); the
# solve of the set less one truck proved a cheaper set and was thrown away; and a plan still renting a
# truck for P4/P5 orders alone (its give-back could not be built) became the suggestion, "complete".

def x_day(x_pallets: float = 4, n_hire: int = 3, **cfg):
    """The own 10-ton, six 3-pallet P3 orders (18 pallets), the P4 order X0 and two 1.5-pallet P5 orders;
    ``n_hire`` 10-tons to rent (50 + 10 OMR each, one load a day)."""
    stops = stops_of([3] * 6) + stops_of([x_pallets], "X", priority=4) + stops_of([1.5, 1.5], "L", priority=5)
    r = req(stops, [own("T1")] + ten_tons(n_hire, trips=1), time_limit_sec=3, **cfg)
    return r, matrix_for(r)


def stops_on(sc) -> dict[str, set[str]]:
    """Truck id -> the stops its loads carry."""
    out: dict[str, set[str]] = {}
    for ld in sc.loads:
        out.setdefault(ld.truck_id, set()).update(st.stop_id for st in ld.stops)
    return out


def test_the_give_back_after_the_solve_of_the_set_left_puts_a_p4_order_back_in_place_of_a_p5_order(monkeypatch):
    # The search's plan rents three 10-tons (H10-3 for the P5 orders alone; X0 left out). H10-3 is given
    # back; the solve of one 10-ton alone proves nothing (its load re-check is skipped); the set left (2 x
    # 10-ton) is solved: H10-1 carries two P3 orders and both P5 orders (9 pallets), H10-2 the P4 order X0
    # alone. H10-2 is given back - one 10-ton, the cheaper set - and X0 stayed out while H10-1 kept both P5
    # orders, although S4 + S5 + X0 + L1 (11.5 pallets) fit its 12 bays. X0 goes back on H10-1 in place of
    # ONE P5 order, with no solve.
    import time

    r, mx = x_day()
    first = given_plan(r, r.stops, ds._truck_days(r), mx, [], {"T1": [("S0", "S1", "S2", "S3")], "H10-1": [("S4",)],
                                                               "H10-2": [("S5",)], "H10-3": [("L0", "L1")]})
    offered = solves_are(monkeypatch, {
        ("H10-1",): ({"T1": [("S0", "S1", "S2", "S3")], "H10-1": [("S4",)]}, False),
        ("H10-1", "H10-2"): {"T1": [("S0", "S1", "S2", "S3")], "H10-1": [("S4", "S5", "L0", "L1")], "H10-2": [("X0",)]},
    })
    scs, hc = ds._reduce_hire(r, r.stops, mx, [], 3, time.monotonic() + 600, None, [first])
    sc = scs[0]
    assert offered == [["H10-1"], ["H10-1", "H10-2"]]
    # No truck to rent cannot hold the 18 pallets of P3 orders (12): one 10-ton is the cheapest set.
    assert hc.used == ["H10-1"] and hc.solves == 2 and hc.complete
    assert stops_on(sc) == {"T1": {"S0", "S1", "S2", "S3"}, "H10-1": {"S4", "S5", "X0", "L1"}}
    assert set(unserved_map(sc)) == {"L0"}
    assert_pallets_hold(r, sc)
    assert sc.feasibility is not None and sc.feasibility.status == "VERIFIED"
    assert sc.objective.fixed_cost == pytest.approx(35.0 + 50.0)


SWAP_CASES = {  # strict priorities, the weights, X0's pallets -> the orders left out
    "strict": (True, None, 5.5, {"L0", "L1"}),  # one P4 order outranks both P5 orders together
    "weighted": (False, None, 5.5, {"L0", "L1"}),  # by the default weights: 10 over 1 + 1
    "two-P5-above-a-P4": (False, TWO_P5_ABOVE_A_P4, 5.5, {"X0"}),  # weights that put two P5 orders above a P4
    "no-room-without-them": (True, None, 7, {"X0"}),  # 6 + 7 pallets even without both: they never kept it out
}


@pytest.mark.parametrize("case", ["strict", "weighted", "two-P5-above-a-P4", "no-room-without-them"])
def test_the_give_back_without_a_solve_puts_a_p4_order_back_in_place_of_p5_orders(monkeypatch, case):
    # Not one solve may start (a big day): the search's plan rents H10-2 for the P4 order X0 alone, and
    # H10-1 carries two P3 orders and both P5 orders (9 pallets). H10-2 is given back: X0 goes on H10-1
    # in place of both P5 orders (6 + 5.5 of 12 pallets) when the day's priorities rank it above them,
    # and stays out when it does not fit even without them (6 + 7): the P5 orders then stay on.
    import time

    strict, weights, x_pallets, out = SWAP_CASES[case]
    monkeypatch.setattr(ds, "HIRE_REDUCE_MAX_SOLVES", 0)
    cfg = {"strict_priorities": strict} | ({"priority_weights": weights} if weights else {})
    r, mx = x_day(x_pallets, n_hire=2, **cfg)
    first = given_plan(r, r.stops, ds._truck_days(r), mx, [], {"T1": [("S0", "S1", "S2", "S3")],
                                                               "H10-1": [("S4", "S5", "L0", "L1")], "H10-2": [("X0",)]})
    scs, hc = ds._reduce_hire(r, r.stops, mx, [], 3, time.monotonic() + 600, None, [first])
    sc = scs[0]
    # No truck to rent cannot hold the 18 pallets of P3 orders (12): one 10-ton, with no solve.
    assert hc.first == ["H10-1", "H10-2"] and hc.used == ["H10-1"] and hc.solves == 0 and hc.complete
    assert set(unserved_map(sc)) == out
    assert high_ids(r.stops) <= served_ids(sc)
    assert_pallets_hold(r, sc)
    assert sc.feasibility is not None and sc.feasibility.status == "VERIFIED"


def test_one_truck_fewer_that_delivers_every_p1_p3_order_is_the_suggestion(monkeypatch):
    # The search's plan rents two 10-tons for one P3 order each. The one cheaper set left after the room
    # check (1 x 10-ton) is solved, but that solve's load re-check is skipped: neither kept nor ruled
    # out. "One truck fewer" solves that set once more (H10-2), re-checked, and every P1-P3 order is
    # delivered: that cheaper set, proven, is the suggestion (it was thrown away: 2 x 10-ton, 120 OMR).
    import time

    r = req(stops_of([3] * 6), [own("T1")] + ten_tons(2, trips=1), time_limit_sec=3)
    mx = matrix_for(r)
    first = given_plan(r, r.stops, ds._truck_days(r), mx, [], {"T1": [("S0", "S1", "S2", "S3")], "H10-1": [("S4",)],
                                                               "H10-2": [("S5",)]})
    offered = solves_are(monkeypatch, {
        ("H10-1",): ({"T1": [("S0", "S1", "S2", "S3")], "H10-1": [("S4", "S5")]}, False),
        ("H10-2",): {"T1": [("S0", "S1", "S2", "S3")], "H10-2": [("S4", "S5")]},
    })
    scs, hc = ds._reduce_hire(r, r.stops, mx, [], 3, time.monotonic() + 600, None, [first])
    sc = scs[0]
    assert offered == [["H10-1"], ["H10-2"]]
    # No truck to rent cannot hold the 18 pallets (12): one 10-ton is proven the cheapest.
    assert hc.used == ["H10-2"] and hc.solves == 2 and hc.complete and hc.one_fewer is None
    assert unserved_map(sc) == {} and hired_used(sc) == {"H10": 1}
    assert sc.feasibility is not None and sc.feasibility.status == "VERIFIED"
    assert sc.objective.fixed_cost == pytest.approx(35.0 + 50.0)


def test_a_cheaper_set_whose_truck_for_p4_p5_orders_alone_cannot_be_given_back_never_becomes_the_suggestion(monkeypatch):
    # The search's plan: the 10-ton to rent (75 + 10 OMR) for two P3 orders and both P5 orders. The solve
    # of 1 x 3-ton proves nothing (its load re-check is skipped; one that left S5 out with room for it is
    # repaired); 2 x 3-ton (80 OMR) deliver every P3 order, H3-2 only the P5 orders - and its give-back
    # cannot be built (here: it returns the plan as it is). That plan rents a truck for P5 orders alone
    # (owner answer 1) and was the suggestion, "complete". The 10-ton stays; as the 3-ton carrying the P3
    # orders may be a cheaper set, it is not called complete.
    import time

    stops = stops_of([3] * 6) + stops_of([1.5, 1.5], "L", priority=5)
    trucks = [own("T1"), hire("H10-1", 12, 75.0, driver_day_cost=10.0), hire("H3-1", 6, 30.0, driver_day_cost=10.0),
              hire("H3-2", 6, 30.0, driver_day_cost=10.0)]
    r = req(stops, trucks, time_limit_sec=3)
    mx = matrix_for(r)
    first = given_plan(r, r.stops, ds._truck_days(r), mx, [], {"T1": [("S0", "S1", "S2", "S3")],
                                                               "H10-1": [("S4", "S5", "L0", "L1")]})
    offered = solves_are(monkeypatch, {
        ("H3-1",): ({"T1": [("S0", "S1", "S2", "S3")], "H3-1": [("S4",)]}, False),
        ("H3-1", "H3-2"): {"T1": [("S0", "S1", "S2", "S3")], "H3-1": [("S4", "S5")], "H3-2": [("L0", "L1")]},
    })
    orig = ds._without_low_hires

    def not_built(rq, solvable, mx_, drops, sc, hire_ids, high, **kw):
        return sc if "H3-2" in ds._low_hires(sc, hire_ids, high) else orig(rq, solvable, mx_, drops, sc, hire_ids, high, **kw)

    monkeypatch.setattr(ds, "_without_low_hires", not_built)
    scs, hc = ds._reduce_hire(r, r.stops, mx, [], 3, time.monotonic() + 600, None, [first])
    assert offered == [["H3-1"], ["H3-1", "H3-2"]]
    assert hc.used == ["H10-1"] and hc.solves == 2 and not hc.complete
    assert scs[0] is first


def test_a_truck_for_p4_p5_orders_alone_left_in_the_suggestion_is_never_called_complete(monkeypatch):
    # The give-back of H10-3 (the P5 orders alone) cannot be built and no solve may start, while every
    # cheaper set is ruled out by its room (here). The suggestion still rents a truck for P5 orders
    # alone: never "complete" (it was, as nothing cheaper was left untried).
    r, mx, first, end = three_ten_ton_day()
    monkeypatch.setattr(ds, "HIRE_REDUCE_MAX_SOLVES", 0)
    monkeypatch.setattr(ds, "_hire_room_short", lambda *a: True)
    monkeypatch.setattr(ds, "_without_low_hires", lambda rq, solvable, mx_, drops, sc, *a, **kw: sc)
    scs, hc = ds._reduce_hire(r, r.stops, mx, [], 3, end, None, [first])
    assert hc.used == ["H10-1", "H10-2", "H10-3"] and hc.solves == 0 and not hc.complete
    assert scs[0] is first


# Eleventh review of the hire branch: a give-back was built only from the loads kept timed again, so a plan
# the post-solve stage had kept as found (VIOLATED) kept its truck for P4/P5 orders alone, counted in the
# box with its money; the swap timed every load kept for each stop it put back, so its 400 timings ran out
# on a mid-size give-back and P4 orders stayed out while P5 orders rode; and a dropped P4/P5 order went
# into free room only when a lower priority on the trucks kept let it.

def test_a_truck_for_p4_p5_orders_alone_is_given_back_from_a_plan_that_cannot_be_timed_again(monkeypatch):
    # The search's plan was kept as found (VIOLATED: its load re-check skipped, its re-time failed - here
    # S0's receiving hours cannot be kept), and no solve may start (a big day). H10-3 carries the P5
    # orders alone: it is still given back, from the plan's own times - every other truck's day exactly
    # as it was, still VIOLATED by S0 (never dispatchable) - and its P5 orders ride along in the free room
    # of the 10-tons kept. It stayed: "hire 3 x 10-ton: extra about 150 OMR", one for P5 orders alone.
    monkeypatch.setattr(ds, "HIRE_REDUCE_MAX_SOLVES", 0)
    r, mx, first, end = three_ten_ton_day()
    broken = r.model_copy(update={"stops": [s.model_copy(update={"hard_start_min": 0, "hard_end_min": 1})
                                            if s.stop_id == "S0" else s for s in r.stops]})
    tds = ds._truck_days(broken)
    ctx = ds._stage_ctx(broken, broken.stops, tds, mx, [])
    timed = ds._timed_from_scenario(first, ctx.stop_idx, ctx.truck_idx)
    assert LR.time_plan(ctx.day, LR.plan_of(timed), ctx.rec_pricing) is None
    found = ds._build_scenario("RECOMMENDED", broken, broken.stops, tds, mx, timed, ctx.values, ctx.use_margin, [],
                               solver_status="SUCCESS", elapsed=0.0, time_limit=3,
                               objective_value=LR.score(ctx.day, ctx.rec_pricing, timed).objective,
                               extra_warnings=ctx.value_warnings, exact_timing=True)
    assert found.feasibility is not None and found.feasibility.status == "VIOLATED"
    scs, hc = ds._reduce_hire(broken, broken.stops, mx, [], 3, end, None, [found])
    sc = scs[0]
    assert hc.first == ["H10-1", "H10-2", "H10-3"] and hc.used == ["H10-1", "H10-2"] and hc.solves == 0
    assert not hc.complete  # one 10-ton was never tried
    on = stops_on(sc)
    assert set(on) == {"T1", "H10-1", "H10-2"} and on["T1"] == {"S0", "S1", "S2", "S3"}
    assert {"S4"} <= on["H10-1"] and {"S5"} <= on["H10-2"] and on["H10-1"] | on["H10-2"] == {"S4", "S5", "L0", "L1"}
    assert unserved_map(sc) == {}
    # The own truck's day exactly as the plan had it, flagged as it was; nothing else broken.
    t1 = [(ld.depart_min, ld.return_min, [st.service_start_min for st in ld.stops]) for ld in sc.loads if ld.truck_id == "T1"]
    assert t1 == [(ld.depart_min, ld.return_min, [st.service_start_min for st in ld.stops]) for ld in found.loads if ld.truck_id == "T1"]
    assert sc.feasibility is not None and sc.feasibility.status == "VIOLATED"
    assert {(v.truck_id, v.stop_id) for v in sc.feasibility.violations} <= {(v.truck_id, v.stop_id) for v in found.feasibility.violations}
    assert {v.truck_id for v in sc.feasibility.violations} == {"T1"}
    assert all(ld.pallet_units <= ld.pallet_room_units for ld in sc.loads)
    assert sc.objective.fixed_cost == pytest.approx(35.0 + 2 * 50.0)


def test_a_plan_kept_as_found_and_given_back_gives_way_to_a_checked_solve_of_the_set_left_as_cheap(monkeypatch):
    # The same plan kept as found, here VIOLATED because T1 cannot serve S0 (09:00-09:05) before S1
    # (06:00-07:30). H10-3 is given back from the plan's own times: 2 x 10-ton, still VIOLATED. One 10-ton
    # loses S5 - S0, S4 and S5 are all received 09:00-09:05, so two trucks never reach the three (a proof
    # since the thirteenth review: no move, nor chain of two, puts S5 back, and nothing lower rides along);
    # the set left, solved, serves S1 before S0 and passes every check, for the same money: it is the
    # suggestion (before the give-back that set was tried among the cheaper ones and taken; a give-back that
    # fails the checks must not keep it out at the same money).
    r, mx, first, end = three_ten_ton_day()
    windows = {"S0": (9 * 60, 9 * 60 + 5), "S1": (6 * 60, 7 * 60 + 30), "S4": (9 * 60, 9 * 60 + 5), "S5": (9 * 60, 9 * 60 + 5)}
    tight = r.model_copy(update={"stops": [s.model_copy(update={"hard_start_min": windows[s.stop_id][0], "hard_end_min": windows[s.stop_id][1]})
                                           if s.stop_id in windows else s for s in r.stops]})
    tds = ds._truck_days(tight)
    ctx = ds._stage_ctx(tight, tight.stops, tds, mx, [])
    timed = ds._timed_from_scenario(first, ctx.stop_idx, ctx.truck_idx)
    assert LR.time_plan(ctx.day, LR.plan_of(timed), ctx.rec_pricing) is None
    found = ds._build_scenario("RECOMMENDED", tight, tight.stops, tds, mx, timed, ctx.values, ctx.use_margin, [],
                               solver_status="SUCCESS", elapsed=0.0, time_limit=3,
                               objective_value=LR.score(ctx.day, ctx.rec_pricing, timed).objective,
                               extra_warnings=ctx.value_warnings, exact_timing=True)
    assert found.feasibility is not None and found.feasibility.status == "VIOLATED"
    offered = solves_are(monkeypatch, {
        ("H10-1",): {"T1": [("S1", "S0", "S2", "S3")], "H10-1": [("S4",)]},
        ("H10-1", "H10-2"): {"T1": [("S1", "S0", "S2", "S3")], "H10-1": [("S4", "L0")], "H10-2": [("S5", "L1")]},
    })
    scs, hc = ds._reduce_hire(tight, tight.stops, mx, [], 3, end, None, [found])
    sc = scs[0]
    assert offered == [["H10-1"], ["H10-1", "H10-2"]]
    assert hc.first == ["H10-1", "H10-2", "H10-3"] and hc.used == ["H10-1", "H10-2"] and hc.solves == 2 and hc.complete
    assert sc.feasibility is not None and sc.feasibility.status == "VERIFIED"
    assert [st.stop_id for ld in sc.loads if ld.truck_id == "T1" for st in ld.stops][:2] == ["S1", "S0"]
    assert unserved_map(sc) == {}


def many_riders_day(n_own: int = 16, n_x: int = 30):
    """``n_own`` own 10-tons, each with one load: a 6-pallet P3 order (S..) and a 1-pallet P5 order (L..);
    two 10-tons to rent (3 loads a day): H10-1 with one 6-pallet P3 load, H10-2 with ``n_x`` one-pallet P4
    orders (X..) alone, ten a load."""
    import time

    stops = (stops_of([6] * (n_own + 1)) + stops_of([1] * n_own, "L", priority=5)
             + [pstop(f"X{i:02d}", 23.60 + 0.002 * i, 58.42, cases=20, units=1000, priority=4) for i in range(n_x)])
    trucks = [own(f"T{k:02d}") for k in range(n_own)] + ten_tons(2, trips=3)
    r = req(stops, trucks, time_limit_sec=3)
    mx = matrix_for(r)
    loads = {f"T{k:02d}": [(f"S{k}", f"L{k}")] for k in range(n_own)} | {"H10-1": [(f"S{n_own}",)]}
    loads["H10-2"] = [tuple(f"X{i:02d}" for i in range(a, min(a + 10, n_x))) for a in range(0, n_x, 10)]
    first = given_plan(r, r.stops, ds._truck_days(r), mx, [], loads)
    return r, mx, first, time.monotonic() + 600


def test_the_give_back_puts_back_every_p4_order_a_load_kept_has_room_for_whatever_the_number_of_loads(monkeypatch):
    # No solve may start (a big day). H10-2 carries 30 P4 orders alone and is given back; the 16 own
    # loads and H10-1's keep about 86 free pallets, so every P4 order goes back on them, each where it
    # adds the fewest metres, with nothing taken off: every P5 order stays on. The swap timed every load
    # kept for each P4 order, so its 400 timings ran out and X28 and X29 stayed out while the P5 orders
    # rode along (strict priorities).
    monkeypatch.setattr(ds, "HIRE_REDUCE_MAX_SOLVES", 0)
    r, mx, first, end = many_riders_day()
    calls = {"n": 0}
    orig = LR.time_plan

    def counted(*a, **kw):
        calls["n"] += 1
        return orig(*a, **kw)

    monkeypatch.setattr(LR, "time_plan", counted)
    scs, hc = ds._reduce_hire(r, r.stops, mx, [], 3, end, None, [first])
    sc = scs[0]
    assert hc.first == ["H10-1", "H10-2"] and hc.used == ["H10-1"] and hc.solves == 0
    assert unserved_map(sc) == {}
    assert_pallets_hold(r, sc)
    assert sc.feasibility is not None and sc.feasibility.status == "VERIFIED"
    # The cheapest place is timed first: about one timing per order put back, never one per load kept.
    assert calls["n"] < 3 * 30


@pytest.mark.parametrize("case", ["P4", "P5", "no timings left"])
def test_a_dropped_p4_p5_order_rides_along_in_free_room_with_nothing_taken_off(monkeypatch, case):
    # No solve may start. The own 10-ton is full of P3 orders (A0-A3), H10-1 carries A4 and A5 (6 of its
    # 12 bays), H10-2 the two 1-pallet orders X0 and X1 alone: it is given back, and X0 and X1 ride along
    # in H10-1's free room - P4 or P5 orders alike, with no lower priority on the trucks kept. They were
    # left out (a dropped order went into free room only when it outranked a stop the trucks kept carry).
    # When the swap has no timing left it says so: the set is never called complete.
    monkeypatch.setattr(ds, "HIRE_REDUCE_MAX_SOLVES", 0)
    if case == "no timings left":
        monkeypatch.setattr(ds, "HIRE_SWAP_MIN_TIMINGS", 0)
        monkeypatch.setattr(ds, "HIRE_SWAP_TIMINGS_PER", 0)
    prio = 5 if case == "P5" else 4
    stops = stops_of([3] * 6, "A") + stops_of([1, 1], "X", priority=prio)
    r = req(stops, [own("T1")] + ten_tons(2, trips=1), time_limit_sec=3)
    mx = matrix_for(r)
    first = given_plan(r, r.stops, ds._truck_days(r), mx, [], {"T1": [("A0", "A1", "A2", "A3")], "H10-1": [("A4", "A5")],
                                                               "H10-2": [("X0", "X1")]})
    import time

    scs, hc = ds._reduce_hire(r, r.stops, mx, [], 3, time.monotonic() + 600, None, [first])
    sc = scs[0]
    assert hc.first == ["H10-1", "H10-2"] and hc.used == ["H10-1"] and hc.solves == 0
    if case == "no timings left":
        assert set(unserved_map(sc)) == {"X0", "X1"} and not hc.complete
    else:
        # No truck to rent cannot hold the 18 pallets of P3 orders (12): one 10-ton, proven with no solve.
        assert unserved_map(sc) == {} and stops_on(sc)["H10-1"] == {"A4", "A5", "X0", "X1"} and hc.complete
    assert_pallets_hold(r, sc)
    assert sc.feasibility is not None and sc.feasibility.status == "VERIFIED"


# Twelfth review of the hire branch: the give-back's swap shared one timing budget among every stop it put
# back, so P4 orders that fit nowhere (receiving hours only a truck rented for the whole day reaches) used
# it up trying each of their places, and a P4 order that fits was cut while the P5 orders it outranks
# rode along; and it put stops back only on trucks with loads, so an idle own truck never took them, and
# the orders a give-back left out read "could not be placed by the optimizer ... add a truck".

def evening_day():
    """Four own 10-tons (one load each, until 15:00), each full: nine P3 orders (9.5 pallets) and a
    2.5-pallet P5 order (L0-L3); H10-1 (rented, one load) an 11.7-pallet P3 order - 49.7 pallets of P3
    orders against 48 own bays; H10-2 (rented, two loads) the P4 orders alone: thirty 0.4-pallet ones
    (X00-X29, 1 min each, receiving 15:30-23:00) and the 2-pallet Y0 (no receiving hours)."""
    import time

    xs = [pstop(f"X{i:02d}", 23.60 + 0.002 * i, 58.43, cases=20, units=400, priority=4, service_min=1,
                hard_start_min=15 * 60 + 30, hard_end_min=23 * 60) for i in range(30)]
    stops = ([s for t in range(4) for s in stops_of([1] * 8 + [1.5], f"S{t}")] + stops_of([11.7], "R")
             + stops_of([2.5] * 4, "L", priority=5) + xs + stops_of([2], "Y", priority=4))
    trucks = [own(f"T{t}", available_to_min=15 * 60) for t in range(4)] + [
        hire("H10-1", 12, 50.0, driver_day_cost=10.0), hire("H10-2", 12, 50.0, driver_day_cost=10.0, max_trips=2)]
    r = req(stops, trucks, time_limit_sec=3)
    mx = matrix_for(r)
    loads = {f"T{t}": [tuple(f"S{t}{i}" for i in range(9)) + (f"L{t}",)] for t in range(4)} | {"H10-1": [("R0",)]}
    loads["H10-2"] = [("Y0",) + tuple(f"X{i:02d}" for i in range(15)), tuple(f"X{i:02d}" for i in range(15, 30))]
    first = given_plan(r, r.stops, ds._truck_days(r), mx, [], loads)
    return r, mx, first, time.monotonic() + 600


@pytest.mark.parametrize("case", ["receiving hours", "no timing"])
def test_a_p4_order_that_fits_is_put_back_however_many_orders_fit_nowhere(monkeypatch, case):
    # No solve may start (a big day). H10-2 carries P4 orders alone and is given back. Y0 fits on an own
    # truck in place of its P5 order; the thirty X orders fit nowhere - their receiving hours start after
    # the own trucks' day ends, and H10-1 has neither room nor a load to spare. The X orders are tried
    # first (their ids), and each timed all of its 40 places, so the shared budget ran out at X15 and Y0
    # was cut: a P4 order left out while the P5 orders it outranks rode along. A place whose hours the
    # truck's day cannot hold is now never timed; and each stop has timings of its own, so stops that
    # cannot be timed anywhere ("no timing": every place of an X fails its timing) never cut another.
    monkeypatch.setattr(ds, "HIRE_REDUCE_MAX_SOLVES", 0)
    r, mx, first, end = evening_day()
    xs = {k for k, s in enumerate(r.stops) if s.stop_id.startswith("X")}
    orig = LR.time_plan
    calls = {"n": 0}

    def timed(day, plan, pricing):
        calls["n"] += 1
        if case == "no timing" and any(k in xs for lds in plan.values() for ld in lds for k in ld):
            return None
        return orig(day, plan, pricing)

    if case == "no timing":  # the X orders without receiving hours: every place passes the hours check
        r = r.model_copy(update={"stops": [s.model_copy(update={"hard_start_min": None, "hard_end_min": None})
                                           if s.stop_id.startswith("X") else s for s in r.stops]})
    monkeypatch.setattr(LR, "time_plan", timed)
    scs, hc = ds._reduce_hire(r, r.stops, mx, [], 3, end, None, [first])
    sc = scs[0]
    # No truck to rent cannot hold the 49.7 pallets of P3 orders (48): one 10-ton, with no solve.
    assert hc.first == ["H10-1", "H10-2"] and hc.used == ["H10-1"] and hc.solves == 0
    out = set(unserved_map(sc))
    assert "Y0" in served_ids(sc) and {f"X{i:02d}" for i in range(30)} <= out
    assert len(out & {"L0", "L1", "L2", "L3"}) == 1 and len(out) == 31
    assert high_ids(r.stops) <= served_ids(sc)
    assert_pallets_hold(r, sc)
    assert sc.feasibility is not None and sc.feasibility.status == "VERIFIED"
    # Left out for the give-back - never "could not be placed by the optimizer ... add a truck".
    assert all(u.reason_message.startswith(ds.HIRE_DROP_HEAD) for u in sc.unserved)
    assert not any("could not be placed by the optimizer" in w for w in sc.warnings)
    assert sum(ds.HIRE_DROP_NOTE in w for w in sc.warnings) == 1
    if case == "receiving hours":
        # Every place of an X was ruled out by its hours with no timing: proven, so complete.
        assert hc.complete and calls["n"] < 20


def test_an_idle_own_truck_takes_the_p4_p5_orders_of_a_truck_given_back(monkeypatch):
    # No solve may start. T1 is full of P3 orders; T2 (an own 3-ton, from 12:00) stands idle; H10-1 carries
    # the P3 orders E0 and E1, received 06:00-08:00 (T2 cannot be there in time); H10-2 the P5 orders L0
    # and L1 alone. H10-2 is given back: L0 and L1 go on T2 (own trucks first), with no solve. They were
    # left out while T2 stood idle - the give-back only put stops back on trucks with loads - and told as
    # "could not be placed by the optimizer ... add a truck".
    import time

    monkeypatch.setattr(ds, "HIRE_REDUCE_MAX_SOLVES", 0)
    stops = (stops_of([3] * 4) + stops_of([6, 6], "E", hard_start_min=6 * 60, hard_end_min=8 * 60)
             + stops_of([1.5, 1.5], "L", priority=5))
    r = req(stops, [own("T1"), own("T2", bays=6, available_from_min=12 * 60)] + ten_tons(2, trips=1), time_limit_sec=3)
    mx = matrix_for(r)
    first = given_plan(r, r.stops, ds._truck_days(r), mx, [], {"T1": [("S0", "S1", "S2", "S3")], "H10-1": [("E0", "E1")],
                                                               "H10-2": [("L0", "L1")]})
    scs, hc = ds._reduce_hire(r, r.stops, mx, [], 3, time.monotonic() + 600, None, [first])
    sc = scs[0]
    # No truck to rent cannot hold the 24 pallets of P3 orders (12 + 6): one 10-ton, proven with no solve.
    assert hc.first == ["H10-1", "H10-2"] and hc.used == ["H10-1"] and hc.solves == 0 and hc.complete
    assert unserved_map(sc) == {} and stops_on(sc) == {"T1": {"S0", "S1", "S2", "S3"}, "H10-1": {"E0", "E1"},
                                                       "T2": {"L0", "L1"}}
    assert_pallets_hold(r, sc)
    assert sc.feasibility is not None and sc.feasibility.status == "VERIFIED"


@pytest.mark.parametrize("broken_by", ["L0", "S0"])
def test_a_truck_whose_day_cannot_be_timed_takes_a_p4_order_only_in_place_of_what_breaks_it(monkeypatch, broken_by):
    # The search's plan kept as found (VIOLATED): T1's day cannot be timed - ``broken_by`` cannot be received
    # in time (its hours here 00:00-00:01) - and no solve may start. H10-2 carries the P4 order X0 alone and
    # is given back; X0 fits only on T1, in place of its P5 order L0. When L0 breaks T1's day, X0 goes on in
    # its place and T1's day is timed again (VERIFIED). When a P3 order breaks it, no place on T1 can be
    # timed: T1 is never timed with X0 (a stop more never lets a day be timed), and X0 stays out.
    import time

    monkeypatch.setattr(ds, "HIRE_REDUCE_MAX_SOLVES", 0)
    stops = stops_of([3] * 7) + stops_of([3], "L", priority=5) + stops_of([3], "X", priority=4)
    r = req(stops, [own("T1")] + ten_tons(2, trips=1), time_limit_sec=3)
    mx = matrix_for(r)
    first = given_plan(r, r.stops, ds._truck_days(r), mx, [], {"T1": [("S0", "S1", "S2", "L0")],
                                                               "H10-1": [("S3", "S4", "S5", "S6")], "H10-2": [("X0",)]})
    broken = r.model_copy(update={"stops": [s.model_copy(update={"hard_start_min": 0, "hard_end_min": 1})
                                            if s.stop_id == broken_by else s for s in r.stops]})
    tds = ds._truck_days(broken)
    ctx = ds._stage_ctx(broken, broken.stops, tds, mx, [])
    timed = ds._timed_from_scenario(first, ctx.stop_idx, ctx.truck_idx)
    found = ds._build_scenario("RECOMMENDED", broken, broken.stops, tds, mx, timed, ctx.values, ctx.use_margin, [],
                               solver_status="SUCCESS", elapsed=0.0, time_limit=3,
                               objective_value=LR.score(ctx.day, ctx.rec_pricing, timed).objective,
                               extra_warnings=ctx.value_warnings, exact_timing=True)
    assert found.feasibility is not None and found.feasibility.status == "VIOLATED"
    x0, orig = ctx.stop_idx["X0"], LR.time_plan
    with_x0 = {"n": 0}

    def counted(day, plan, pricing):
        with_x0["n"] += any(x0 in ld for lds in plan.values() for ld in lds)
        return orig(day, plan, pricing)

    monkeypatch.setattr(LR, "time_plan", counted)
    scs, hc = ds._reduce_hire(broken, broken.stops, mx, [], 3, time.monotonic() + 600, None, [found])
    sc = scs[0]
    # No truck to rent cannot hold the 21 pallets of P3 orders (12): one 10-ton, with no solve.
    assert hc.first == ["H10-1", "H10-2"] and hc.used == ["H10-1"] and hc.solves == 0 and hc.complete
    assert sc.feasibility is not None
    if broken_by == "L0":
        assert stops_on(sc)["T1"] == {"S0", "S1", "S2", "X0"} and set(unserved_map(sc)) == {"L0"}
        assert sc.feasibility.status == "VERIFIED"
    else:
        assert stops_on(sc)["T1"] == {"S0", "S1", "S2", "L0"} and set(unserved_map(sc)) == {"X0"}
        assert with_x0["n"] == 0 and sc.feasibility.status == "VIOLATED"


# Thirteenth review of the hire branch (the real-size demo on 7c3115a): on the real Muscat day with two own
# loads locked, the reduction's solve of 1 x 10-ton came back with a P3 order left out while it carried a
# P4/P5 order more in its place (the time-limited repack after the search made that swap), and that solve
# ruled the 10-ton out: 2 x 3-ton (60 OMR + 2 day rates) was suggested, "complete", where 1 x 10-ton (50 + 1)
# delivered every P1-P3 order in 4 of 4 replays. A solve that leaves a P1-P3 order out while it carries
# lower priorities proves nothing: the order is put back in their place first, with no solve, and the plan
# so repaired is judged - in every step that judges a solve, and on the search's own plan.

def riders_day(**cfg):
    """The own 10-ton (one load) and seven 3-pallet P3 orders (21 pallets; S0-S3 fill it), four 1.5-pallet
    P5 orders; a 10-ton to rent (50 + 10 OMR) and two 3-tons (30 + 10 each), one load a day. The search's
    plan rents both 3-tons (80 OMR): H3-1 carries S4 and S5, H3-2 S6 and two P5 orders. No truck (12
    pallets) and one 3-ton (18) cannot hold the 21 pallets of P3 orders: the 10-ton alone (24) is the one
    cheaper set a solve tries."""
    import time

    stops = stops_of([3] * 7) + stops_of([1.5] * 4, "L", priority=5)
    r = req(stops, ten_and_two_threes(), time_limit_sec=3, **cfg)
    mx = matrix_for(r)
    first = given_plan(r, r.stops, ds._truck_days(r), mx, [], {"T1": [("S0", "S1", "S2", "S3")], "H3-1": [("S4", "S5")],
                                                               "H3-2": [("S6", "L0", "L1")]})
    return r, mx, first, time.monotonic() + 600


# The 10-ton's plan as the stuck repack left it: S6 out, the four P5 orders riding in its 12 bays.
STUCK_10T = {"T1": [("S0", "S1", "S2", "S3")], "H10-1": [("S4", "S5", "L0", "L1", "L2", "L3")]}


@pytest.mark.parametrize("strict", [True, False])
def test_a_solve_that_leaves_a_p3_order_out_while_p5_orders_ride_never_rules_the_cheaper_set_out(monkeypatch, strict):
    # The solve of the 10-ton comes back with S6 left out while H10-1 carries all four P5 orders. It ruled
    # the 10-ton out: 2 x 3-ton, 80 OMR, "complete". S6 goes on H10-1 in place of two P5 orders (strictly,
    # one P3 order outranks every lower one; weighted, its weight is more than theirs together), with no
    # solve: the 10-ton, 60 OMR, is the suggestion, proven the cheapest (both cheaper sets are ruled out
    # by their room).
    r, mx, first, end = riders_day(strict_priorities=strict)
    offered = solves_are(monkeypatch, {("H10-1",): STUCK_10T,
                                       ("H3-2",): {"T1": [("S0", "S1", "S2", "S3")], "H3-2": [("S4", "S5")]}})
    scs, hc = ds._reduce_hire(r, r.stops, mx, [], 3, end, None, [first])
    sc = scs[0]
    assert offered == [["H10-1"]]
    assert hc.first == ["H3-1", "H3-2"] and hc.used == ["H10-1"] and hc.solves == 1 and hc.complete
    assert hc.one_fewer is None
    assert high_ids(r.stops) <= served_ids(sc)
    assert stops_on(sc) == {"T1": {"S0", "S1", "S2", "S3"}, "H10-1": {"S4", "S5", "S6", "L2", "L3"}}
    assert set(unserved_map(sc)) == {"L0", "L1"}
    assert_pallets_hold(r, sc)
    assert sc.feasibility is not None and sc.feasibility.status == "VERIFIED"
    assert sc.objective.fixed_cost == pytest.approx(35.0 + 50.0)


def test_one_truck_fewer_whose_solve_leaves_a_p3_order_out_while_p5_orders_ride_is_repaired_too(monkeypatch):
    # The search's plan rents two 10-tons, one P3 order and two 2-pallet P5 orders each. The solve of one
    # 10-ton (H10-1) skips its load re-check (neither kept nor ruled out); "one truck fewer" solves H10-2:
    # S4 left out while its load carries all four P5 orders. S4 goes on in place of one of them: one 10-ton
    # is the suggestion. It was 2 x 10-ton, "complete", with "one truck fewer: S4 would stay undelivered".
    import time

    stops = stops_of([3] * 6) + stops_of([2] * 4, "L", priority=5)
    r = req(stops, [own("T1")] + ten_tons(2, trips=1), time_limit_sec=3)
    mx = matrix_for(r)
    first = given_plan(r, r.stops, ds._truck_days(r), mx, [], {"T1": [("S0", "S1", "S2", "S3")], "H10-1": [("S4", "L0", "L1")],
                                                               "H10-2": [("S5", "L2", "L3")]})
    offered = solves_are(monkeypatch, {
        ("H10-1",): ({"T1": [("S0", "S1", "S2", "S3")], "H10-1": [("S4", "S5")]}, False),
        ("H10-2",): {"T1": [("S0", "S1", "S2", "S3")], "H10-2": [("S5", "L0", "L1", "L2", "L3")]},
    })
    scs, hc = ds._reduce_hire(r, r.stops, mx, [], 3, time.monotonic() + 600, None, [first])
    sc = scs[0]
    assert offered == [["H10-1"], ["H10-2"]]
    # No truck to rent cannot hold the 18 pallets of P3 orders (12): one 10-ton is proven the cheapest.
    assert hc.used == ["H10-2"] and hc.solves == 2 and hc.complete and hc.one_fewer is None
    assert stops_on(sc) == {"T1": {"S0", "S1", "S2", "S3"}, "H10-2": {"S4", "S5", "L1", "L2", "L3"}}
    assert set(unserved_map(sc)) == {"L0"}
    assert_pallets_hold(r, sc)
    assert sc.feasibility is not None and sc.feasibility.status == "VERIFIED"


def test_a_p3_order_goes_back_in_place_of_p5_orders_on_another_load_of_the_trucks_day(monkeypatch):
    # The rented 10-ton makes two loads: (S4, L0) and (L1). S5 must go on its first load, and its day has
    # time for that only without L1 (here: the timing says so). Taking off the P5 order of the load S5
    # goes on (L0) is not enough, and S5 in place of L1 is on the wrong load: a swap inside one load never
    # places it. With every P5 order of that truck's day off, S5 goes on, and the P5 orders go back where
    # they fit (L0 does, L1 does not): one 10-ton, proven the cheapest. It ruled the 10-ton out.
    import time

    stops = stops_of([3] * 6) + stops_of([1.5, 1.5], "L", priority=5)
    r = req(stops, [own("T1")] + ten_tons(2, trips=2), time_limit_sec=3)
    mx = matrix_for(r)
    first = given_plan(r, r.stops, ds._truck_days(r), mx, [], {"T1": [("S0", "S1", "S2", "S3")],
                                                               "H10-1": [("S4", "L0"), ("L1",)], "H10-2": [("S5",)]})
    ctx = ds._stage_ctx(r, r.stops, ds._truck_days(r), mx, [])
    h10, s5, l1, orig = ctx.truck_idx["H10-1"], ctx.stop_idx["S5"], ctx.stop_idx["L1"], LR.time_plan

    def timed(day, plan, pricing):
        loads = plan.get(h10, [])
        if any(s5 in ld for ld in loads) and (s5 not in loads[0] or any(l1 in ld for ld in loads)):
            return None
        return orig(day, plan, pricing)

    monkeypatch.setattr(LR, "time_plan", timed)
    offered = solves_are(monkeypatch, {("H10-1",): {"T1": [("S0", "S1", "S2", "S3")], "H10-1": [("S4", "L0"), ("L1",)]}})
    scs, hc = ds._reduce_hire(r, r.stops, mx, [], 3, time.monotonic() + 600, None, [first])
    sc = scs[0]
    assert offered == [["H10-1"]]
    # No truck to rent cannot hold the 18 pallets of P3 orders (12): one 10-ton, proven the cheapest.
    assert hc.used == ["H10-1"] and hc.solves == 1 and hc.complete
    assert stops_on(sc) == {"T1": {"S0", "S1", "S2", "S3"}, "H10-1": {"S4", "S5", "L0"}}
    assert set(unserved_map(sc)) == {"L1"}
    assert sc.feasibility is not None and sc.feasibility.status == "VERIFIED"


def test_a_p3_order_goes_in_by_a_chain_of_two_moves_when_no_single_move_fits_it(monkeypatch):
    # The real day under load (thirteenth review): the solve of the 10-ton leaves C0 out (1.5 pallets,
    # received 06:00-08:00, so never on the own truck, free from 12:00). The 10-ton's load carries A0, B0,
    # the 1.2-pallet P3 order E0 and the P5 order L0 (11.5 pallets): even with L0 off C0 does not fit (12.6),
    # and no truck's day takes it with its lower priorities off. In place of L0 and E0 it fits (11.4), and
    # E0 goes on the own truck's free room: every P1-P3 order delivered, one 10-ton. It ruled the 10-ton out.
    import time

    stops = (stops_of([3, 3, 3]) + stops_of([5], "A") + stops_of([4.9], "B") + stops_of([1.2], "E")
             + stops_of([1.5], "C", hard_start_min=6 * 60, hard_end_min=8 * 60) + stops_of([0.4], "L", priority=5))
    r = req(stops, [own("T1", available_from_min=12 * 60)] + ten_tons(2, trips=1), time_limit_sec=3)
    mx = matrix_for(r)
    first = given_plan(r, r.stops, ds._truck_days(r), mx, [], {"T1": [("S0", "S1", "S2")], "H10-1": [("A0", "B0", "E0", "L0")],
                                                               "H10-2": [("C0",)]})
    offered = solves_are(monkeypatch, {("H10-1",): {"T1": [("S0", "S1", "S2")], "H10-1": [("A0", "B0", "E0", "L0")]}})
    scs, hc = ds._reduce_hire(r, r.stops, mx, [], 3, time.monotonic() + 600, None, [first])
    sc = scs[0]
    assert offered == [["H10-1"]]
    # No truck to rent cannot hold the 21.6 pallets of P3 orders (12): one 10-ton, proven the cheapest.
    assert hc.used == ["H10-1"] and hc.solves == 1 and hc.complete
    on = stops_on(sc)
    assert {"A0", "B0", "C0"} <= on["H10-1"] and {"S0", "S1", "S2", "E0"} <= on["T1"]
    assert unserved_map(sc) == {}
    assert_pallets_hold(r, sc)
    assert sc.feasibility is not None and sc.feasibility.status == "VERIFIED"


@pytest.mark.parametrize("case", ["solved once more", "no solve left"])
def test_a_solve_the_repair_cannot_fix_is_solved_once_more_or_its_set_is_never_called_ruled_out(monkeypatch, case):
    # The same stuck solve of the 10-ton, but the repair has neither timing nor time left to put S6 in place
    # of the P5 orders that ride on its trucks. That solve proves nothing: the 10-ton is solved once more
    # when the limits allow (here the same plan comes back), and while it stays unproven 2 x 3-ton is never
    # called complete, nor is "one truck fewer" told from such a solve.
    r, mx, first, end = riders_day()
    monkeypatch.setattr(ds, "HIRE_SWAP_MIN_TIMINGS", 0)
    monkeypatch.setattr(ds, "HIRE_SWAP_TIMINGS_PER", 0)
    monkeypatch.setattr(ds, "HIRE_REPAIR_SEC", 0.0)
    if case == "no solve left":
        monkeypatch.setattr(ds, "HIRE_REDUCE_MAX_SOLVES", 1)
    offered = solves_are(monkeypatch, {("H10-1",): STUCK_10T,
                                       ("H3-2",): {"T1": [("S0", "S1", "S2", "S3")], "H3-2": [("S4", "S5")]}})
    scs, hc = ds._reduce_hire(r, r.stops, mx, [], 3, end, None, [first])
    assert hc.used == hc.first == ["H3-1", "H3-2"] and not hc.complete
    assert scs[0] is first
    if case == "solved once more":
        # Then "one truck fewer": H3-2 alone leaves S6 out with no lower priority riding - a proof.
        assert offered == [["H10-1"], ["H10-1"], ["H3-2"]] and hc.solves == 3
        assert hc.one_fewer is not None and hc.one_fewer.without == "H3-1"
        assert hc.one_fewer.unserved == ["L0", "L1", "L2", "L3", "S6"]
    else:
        assert offered == [["H10-1"]] and hc.solves == 1 and hc.one_fewer is None


@pytest.mark.parametrize("riding", [False, True])
def test_a_solve_that_leaves_a_p3_order_out_rules_its_set_out_only_with_nothing_lower_riding(monkeypatch, riding):
    # Three 7-pallet P3 orders: the own 10-ton and one rented 10-ton hold two of them. The solve of one 10-ton
    # leaves S2 out, and no move of one order puts it back (7 + 7 pallets > 12 on every load). With nothing
    # of a lower priority on its trucks that solve proves one 10-ton too small: 2 x 10-ton, complete, and
    # one truck fewer leaves exactly S2 out. With two P5 orders riding on the own truck it proves nothing (a
    # plan carrying a lower priority in place of a P3 order is no proof, even when no single move fixes it:
    # on the real day a chain of two did): the 10-ton is solved once more (the same plan comes back), and
    # 2 x 10-ton is never called complete, nor is "one truck fewer" told from such a solve.
    import time

    stops = stops_of([7] * 3) + (stops_of([1, 1], "L", priority=5) if riding else [])
    r = req(stops, [own("T1")] + ten_tons(2, trips=1), time_limit_sec=3)
    mx = matrix_for(r)
    t1 = [("S0", "L0", "L1")] if riding else [("S0",)]
    first = given_plan(r, r.stops, ds._truck_days(r), mx, [], {"T1": t1, "H10-1": [("S1",)], "H10-2": [("S2",)]})
    offered = solves_are(monkeypatch, {("H10-1",): {"T1": t1, "H10-1": [("S1",)]}})
    scs, hc = ds._reduce_hire(r, r.stops, mx, [], 3, time.monotonic() + 600, None, [first])
    assert hc.used == ["H10-1", "H10-2"] and scs[0] is first
    if riding:
        assert offered == [["H10-1"], ["H10-1"]] and hc.solves == 2 and not hc.complete and hc.one_fewer is None
    else:
        assert offered == [["H10-1"]] and hc.solves == 1 and hc.complete
        assert hc.one_fewer is not None and hc.one_fewer.without == "H10-1" and hc.one_fewer.unserved == ["S2"]


def test_the_search_plan_that_leaves_a_p3_order_out_while_p5_orders_ride_is_repaired_first(monkeypatch):
    # No solve may start (a big day). The what-if's own plan rents the 10-ton and leaves S6 out while the
    # 10-ton carries all four P5 orders: S6 goes on in place of two of them, so the suggestion delivers
    # every P1-P3 order ("Still left out: none"; it said 1) - the 10-ton, proven the cheapest by room.
    monkeypatch.setattr(ds, "HIRE_REDUCE_MAX_SOLVES", 0)
    r, mx, _, end = riders_day()
    found = given_plan(r, r.stops, ds._truck_days(r), mx, [], STUCK_10T)
    scs, hc = ds._reduce_hire(r, r.stops, mx, [], 3, end, None, [found])
    sc = scs[0]
    assert hc.first == hc.used == ["H10-1"] and hc.solves == 0 and hc.complete
    assert high_ids(r.stops) <= served_ids(sc) and set(unserved_map(sc)) == {"L0", "L1"}
    assert_pallets_hold(r, sc)
    assert sc.feasibility is not None and sc.feasibility.status == "VERIFIED"


# A rented truck doing more than one load: which stops go on which load (the last re-review: only
# the stops inside each load were put in order, and its loads still criss-crossed the area).

def is_arc(ids: set[int], n: int) -> bool:
    """``ids`` are consecutive positions round a ring of ``n``."""
    return any(ids == {(k + i) % n for i in range(len(ids))} for k in range(n))


@pytest.mark.parametrize("kind", ["to rent", "hired"])
def test_a_rented_trucks_loads_share_its_stops_out_as_tidily_as_an_own_trucks(kind):
    # 16 one-pallet stops on a ring 15 km round the depot (P1, P3 and P2 orders taking turns), a 8-bay
    # truck to rent (or hired for the day) making two loads. Its two loads drove 249 km where an own
    # 8-bay truck with a km cost drives 185: each load went round half of the ring's stops picked all
    # over it. Its loads are now shared out as tidily as the own truck's (within 2%), its reported
    # costs unchanged (no km cost, the day rate).
    stops = ring(16, 15.0, (1, 3, 2))
    big = btruck("H", bays=8, fixed_cost=50.0, driver_day_cost=10.0, max_trips=2, hire_candidate=kind == "to rent")
    _, sc = solve(stops, [own("T1", bays=1), big])
    h = sorted((ld for ld in sc.loads if ld.truck_id == "H"), key=lambda ld: ld.load_no)
    assert len(h) == 2
    _, mine = solve(stops, [own("O", bays=8, max_trips=2, cost_per_km=0.1)])
    ref_km = sum(ld.distance_km for ld in mine.loads)
    assert sum(ld.distance_km for ld in h) <= ref_km * 1.02
    assert h[-1].return_min <= max(ld.return_min for ld in mine.loads) + 10
    assert all((ld.distance_cost, ld.fuel_cost) == (0.0, 0.0) for ld in h)
    assert h[0].driver_cost == pytest.approx(10.0) and h[1].driver_cost == 0.0


def test_the_stops_of_a_whole_day_rentals_loads_are_shared_out_by_area():
    # The loads the search left (every other stop round the ring on each): once the plan is chosen the
    # rented truck's stops are shared out again among its loads - each load one half of the ring - with
    # its km weighed as an own truck's. Same truck, same stops, no more money; an own truck's loads stay.
    stops = ring(16, 15.0, (1, 3, 2))
    trucks = [own("A", bays=8, max_trips=2, cost_per_km=0.2), hire("H", 8, 50.0, driver_day_cost=10.0, max_trips=2)]
    r = req(stops, trucks)
    loads = [tuple(range(0, 16, 2)), tuple(range(1, 16, 2))]
    _, idx, before, after = ordered_after_pick(r, {"H": loads})
    got = after.plan[idx["H"]]
    assert sorted(k for tl in got for k in tl.stops) == list(range(16))
    assert len(got) == 2 and all(is_arc(set(tl.stops), 16) and in_ring_order(tl.stops, 16) for tl in got)
    assert after.score.operating == before.score.operating
    assert after.score.metres < 0.85 * before.score.metres
    assert after.score.service == before.score.service
    _, idx, before, after = ordered_after_pick(r, {"A": loads})
    assert after is before
