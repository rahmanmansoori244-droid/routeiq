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


def test_every_load_of_a_whole_day_rental_is_put_in_order_and_an_own_truck_never():
    # A rental is for the whole day (owner answer 2): each of its loads is put in order, the loads keep
    # their stops and their place in its day, and both come back earlier. An own truck's loads keep the
    # search's order (its km are priced as money in the search already), and a day without rented or
    # day-paid trucks keeps the very same plan. The km rate is the own trucks' average (A 0.2, B 0.6).
    stops = ring(r_km=10.0, priorities=(1, 3, 2))
    trucks = [own("A", bays=6, max_trips=2, cost_per_km=0.2), own("B", bays=1, cost_per_km=0.6),
              hire("H", 6, 50.0, driver_day_cost=10.0, max_trips=2)]
    r = req(stops, trucks)
    assert ds._order_km_rate(r) == pytest.approx(0.4)
    loads = [(0, 3, 1, 5, 2, 4), (6, 9, 7, 11, 8, 10)]
    _, idx, before, after = ordered_after_pick(r, {"H": loads})
    got = after.plan[idx["H"]]
    assert [set(tl.stops) for tl in got] == [set(l) for l in loads]
    assert [tl.stops for tl in got] == [(0, 1, 2, 3, 4, 5), (6, 7, 8, 9, 10, 11)]
    assert [tl.return_s < tl0.return_s for tl, tl0 in zip(got, before.plan[idx["H"]])] == [True, True]
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
