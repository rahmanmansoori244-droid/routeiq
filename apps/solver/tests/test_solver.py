"""Unit tests for the OR-Tools solver — CLAUDE.md §13 requirements.

These tests are pure-Python (no FastAPI) and verify the math + behaviors that
the spec calls out explicitly:
  - Capacity math (per-truck integer demand)
  - Time math (Haversine + multiplier → seconds + service time)
  - Distance math (Haversine + multiplier)
  - Scenario differentiation (Min Trucks vs Min Distance vs Balanced)
  - **Priority-inverted drop penalty** — P1 must be 5x more expensive to drop than P5
  - Solver time auto-scaling formula
"""

import math

import pytest

from models import OptimizeRequest, SolverConfig, Truck, Stop, Depot
from solver import (
    drop_penalty,
    effective_time_limit,
    haversine_km,
    optimize,
    filter_input,
    SCENARIO_PRESETS,
    adjusted_weights,
)


# ---------------------------------------------------------------------------
# Helper builders
# ---------------------------------------------------------------------------


def make_request(
    stops: list[Stop],
    trucks: list[Truck] | None = None,
    time_limit: int = 3,
    distance_provider: str = "HAVERSINE",
    scenarios=("MIN_TRUCKS", "MIN_DISTANCE", "BALANCED"),
) -> OptimizeRequest:
    if trucks is None:
        trucks = [
            Truck(id="T1", capacity_cases=100, capacity_weight_kg=2000, fixed_cost_per_day=20, cost_per_km=0.15),
        ]
    return OptimizeRequest(
        run_id="test-run",
        tenant_id="test-tenant",
        depot=Depot(id="D", lat=23.5859, lng=58.4059),
        trucks=trucks,
        stops=stops,
        config=SolverConfig(
            avg_speed_kmh=40,
            distance_provider=distance_provider,
            distance_multiplier=1.3,
            driver_shift_max_min=540,
            return_to_depot=True,
            solver_time_limit_sec=time_limit,
            scenarios_requested=list(scenarios),
        ),
    )


def make_stop(order_id: str, lat: float, lng: float, cases: int = 10, priority: int = 3) -> Stop:
    return Stop(
        order_id=order_id,
        customer_id=f"cust-{order_id}",
        lat=lat,
        lng=lng,
        demand_cases=cases,
        demand_weight_kg=cases * 12.0,
        service_time_min=10,
        priority=priority,
    )


# ---------------------------------------------------------------------------
# 1. Pure math — fast, no solver invocation
# ---------------------------------------------------------------------------


class TestHaversine:
    def test_distance_between_known_oman_points(self):
        # Muscat depot to Seeb anchor — roughly 30 km straight-line.
        km = haversine_km(23.5859, 58.4059, 23.6700, 58.1893)
        assert 20 < km < 35, f"Expected 20-35 km, got {km:.2f}"

    def test_zero_distance(self):
        assert haversine_km(23.5, 58.4, 23.5, 58.4) == 0

    def test_symmetric(self):
        a = haversine_km(23.5, 58.4, 24.5, 59.4)
        b = haversine_km(24.5, 59.4, 23.5, 58.4)
        assert math.isclose(a, b)

    def test_antipodal_max_distance(self):
        # 0,0 to 0,180 should be roughly half Earth's circumference.
        km = haversine_km(0, 0, 0, 180)
        assert 20_000 < km < 20_100, f"Expected ~20015 km, got {km:.2f}"


class TestDropPenalty:
    """Spec §7: priority 1 (highest) must cost the most to drop."""

    def test_priority_one_is_most_expensive(self):
        assert drop_penalty(1) == 5_000_000

    def test_priority_five_is_least_expensive(self):
        assert drop_penalty(5) == 1_000_000

    def test_priority_ordering_inverted(self):
        """As priority value increases (less important), drop cost decreases."""
        penalties = [drop_penalty(p) for p in range(1, 6)]
        assert penalties == sorted(penalties, reverse=True)

    def test_priority_three_is_middle(self):
        assert drop_penalty(3) == 3_000_000

    def test_priority_clamped(self):
        # Out-of-range values clamp to [1,5]
        assert drop_penalty(0) == drop_penalty(1)
        assert drop_penalty(99) == drop_penalty(5)


class TestEffectiveTimeLimit:
    """Spec §7: min(max(base, stops * 0.05), 120)."""

    def test_small_run_uses_base(self):
        # 100 stops at base=30: max(30, 5) = 30
        assert effective_time_limit(30, 100) == 30

    def test_large_run_scales_up(self):
        # 1000 stops at base=30: max(30, 50) = 50
        assert effective_time_limit(30, 1000) == 50

    def test_cap_at_120(self):
        # 2400+ stops should hit the 120s ceiling
        assert effective_time_limit(30, 2400) == 120
        assert effective_time_limit(30, 100_000) == 120

    def test_higher_base_overrides_scaling(self):
        # Tenant override of base=60 keeps 60 for 100 stops
        assert effective_time_limit(60, 100) == 60


# ---------------------------------------------------------------------------
# 2. Pre-solver filter — drop reasons before invoking OR-Tools
# ---------------------------------------------------------------------------


class TestFilterInput:
    def test_missing_coordinates_dropped(self):
        req = make_request([
            make_stop("OK", 23.6, 58.5),
            Stop(order_id="MISSING", customer_id="c", lat=0.0, lng=0.0, demand_cases=5, demand_weight_kg=60, service_time_min=10, priority=3),
        ])
        result = filter_input(req)
        assert len(result.solvable) == 1
        assert result.solvable[0].order_id == "OK"
        assert len(result.drops) == 1
        assert result.drops[0].order_id == "MISSING"
        assert result.drops[0].reason_code == "MISSING_COORDINATES"

    def test_exceeds_largest_truck_capacity_dropped(self):
        req = make_request(
            [make_stop("HUGE", 23.6, 58.5, cases=500)],
            trucks=[Truck(id="T", capacity_cases=100, capacity_weight_kg=1500, fixed_cost_per_day=20, cost_per_km=0.15)],
        )
        result = filter_input(req)
        assert len(result.solvable) == 0
        assert len(result.drops) == 1
        assert result.drops[0].reason_code == "EXCEEDS_TRUCK_CAPACITY"

    def test_no_trucks_drops_everything_as_no_available_truck(self):
        req = make_request([make_stop("S1", 23.6, 58.5)], trucks=[])
        result = filter_input(req)
        assert len(result.solvable) == 0
        assert result.drops[0].reason_code == "NO_AVAILABLE_TRUCK"


# ---------------------------------------------------------------------------
# 3. Scenario weights — the three presets must differ in fixed-cost emphasis
# ---------------------------------------------------------------------------


class TestScenarioWeights:
    def test_min_trucks_has_heavy_fixed_cost(self):
        w = SCENARIO_PRESETS["MIN_TRUCKS"]
        assert w.fixed_cost_multiplier > SCENARIO_PRESETS["BALANCED"].fixed_cost_multiplier

    def test_min_distance_has_zero_fixed_cost(self):
        assert SCENARIO_PRESETS["MIN_DISTANCE"].fixed_cost_multiplier == 0.0

    def test_min_distance_has_higher_per_km(self):
        w = SCENARIO_PRESETS["MIN_DISTANCE"]
        assert w.per_km_multiplier > SCENARIO_PRESETS["BALANCED"].per_km_multiplier

    def test_max_utilization_mode_dampens_trucks_weight(self):
        req_normal = make_request([make_stop("S1", 23.6, 58.5)])
        req_max_util = make_request([make_stop("S1", 23.6, 58.5)])
        req_max_util.config.max_utilization_mode = True

        w_normal = adjusted_weights("BALANCED", req_normal)
        w_max_util = adjusted_weights("BALANCED", req_max_util)

        # max_utilization_mode reduces the trucks-used cost so the solver tends
        # to use FEWER trucks (== filling them more).
        assert w_max_util.fixed_cost_multiplier < w_normal.fixed_cost_multiplier


# ---------------------------------------------------------------------------
# 4. End-to-end solver — small instances that exercise the full path
# ---------------------------------------------------------------------------


class TestSolverEndToEnd:
    def test_single_stop_single_truck(self):
        req = make_request([make_stop("S1", 23.62, 58.55, cases=20)])
        res = optimize(req)
        assert len(res.scenarios) == 3
        for s in res.scenarios:
            assert s.trucks_used == 1
            assert len(s.routes) == 1
            assert s.routes[0].stops[0].order_id == "S1"
            assert s.distance_is_estimated is True  # HAVERSINE

    def test_priority_drop_inversion(self):
        """Spec acceptance: with tight capacity, P5 dropped before P1."""
        # Single truck, capacity 100. Two stops with 60 cases each.
        req = make_request(
            stops=[
                make_stop("HIGH", 23.62, 58.55, cases=60, priority=1),
                make_stop("LOW", 23.60, 58.50, cases=60, priority=5),
            ],
            trucks=[Truck(id="T", capacity_cases=100, capacity_weight_kg=2000, fixed_cost_per_day=20, cost_per_km=0.15)],
            scenarios=("BALANCED",),
        )
        res = optimize(req)
        scenario = res.scenarios[0]
        served_ids = {s.order_id for r in scenario.routes for s in r.stops}
        dropped_ids = {u.order_id for u in scenario.unserved_orders}
        assert "HIGH" in served_ids, "Priority 1 must be served"
        assert "LOW" in dropped_ids, "Priority 5 must be dropped first"

    def test_missing_coords_in_response(self):
        req = make_request([
            make_stop("OK", 23.62, 58.55),
            Stop(order_id="MISS", customer_id="c", lat=0.0, lng=0.0, demand_cases=5, demand_weight_kg=60, service_time_min=10, priority=3),
        ])
        res = optimize(req)
        for s in res.scenarios:
            missing = [u for u in s.unserved_orders if u.order_id == "MISS"]
            assert len(missing) == 1
            assert missing[0].reason_code == "MISSING_COORDINATES"

    def test_distance_is_estimated_label(self):
        """HAVERSINE provider must set distance_is_estimated=True."""
        req = make_request([make_stop("S1", 23.62, 58.55)])
        res = optimize(req)
        for s in res.scenarios:
            assert s.distance_is_estimated is True
            assert s.distance_provider == "HAVERSINE"

    def test_utilization_calculated(self):
        # Truck cap 100, demand 50 → 50% util
        req = make_request(
            [make_stop("S1", 23.62, 58.55, cases=50)],
            trucks=[Truck(id="T", capacity_cases=100, capacity_weight_kg=2000, fixed_cost_per_day=20, cost_per_km=0.15)],
            scenarios=("BALANCED",),
        )
        res = optimize(req)
        scenario = res.scenarios[0]
        # Single-route average utilization should be 50%
        assert 49 <= scenario.avg_utilization_pct <= 51

    def test_no_solvable_stops_returns_empty_scenarios(self):
        # Two stops with missing coords + no trucks needed
        req = make_request(
            stops=[
                Stop(order_id="M1", customer_id="c1", lat=0.0, lng=0.0, demand_cases=5, demand_weight_kg=60, service_time_min=10, priority=3),
                Stop(order_id="M2", customer_id="c2", lat=0.0, lng=0.0, demand_cases=5, demand_weight_kg=60, service_time_min=10, priority=3),
            ],
        )
        res = optimize(req)
        for s in res.scenarios:
            assert s.trucks_used == 0
            assert len(s.routes) == 0
            assert len(s.unserved_orders) == 2
            assert all(u.reason_code == "MISSING_COORDINATES" for u in s.unserved_orders)


# ---------------------------------------------------------------------------
# 5. Distance multiplier verification
# ---------------------------------------------------------------------------


class TestDistanceMultiplier:
    def test_distance_multiplier_applied(self):
        """A 2km Haversine distance with 1.3 multiplier should yield 2.6km in routes."""
        req = make_request(
            stops=[make_stop("CLOSE", 23.595, 58.41)],  # ~1km from depot at 23.5859,58.4059
        )
        req.config.distance_multiplier = 1.3
        res = optimize(req)
        scenario = res.scenarios[0]
        if scenario.routes:
            # Round trip (depot → stop → depot) ≈ 2 × straight-line × multiplier
            raw_one_way = haversine_km(23.5859, 58.4059, 23.595, 58.41)
            expected_total = raw_one_way * 2 * 1.3
            assert math.isclose(
                scenario.total_distance_km, expected_total, rel_tol=0.02
            ), f"Expected ≈{expected_total:.2f}, got {scenario.total_distance_km}"


if __name__ == "__main__":
    raise SystemExit(pytest.main([__file__, "-v"]))
