"""Decision support, synthetic NMWC-like days (DESIGN.md 1.2): shape, labels, determinism, assumptions, and a
small day that the engine plans and the independent check verifies."""
from __future__ import annotations

import math

import pytest

from decision_support import core, synth
from decision_support.synth import CUSTOMER_HARD, SALES_PREFERENCE, UNKNOWN


@pytest.fixture(scope="module")
def day():
    return synth.make_day(320, seed=1)


def km(a: tuple[float, float], b: tuple[float, float]) -> float:
    dlat = (a[0] - b[0]) * 110.574
    dlng = (a[1] - b[1]) * 111.32 * math.cos(math.radians(a[0]))
    return math.hypot(dlat, dlng)


def test_a_320_invoice_day_has_the_nmwc_shape(day):
    r = day.request
    assert len(day.invoice_stop) == 320 == sum(len(s.order_ids) for s in r.stops)
    assert {o for s in r.stops for o in s.order_ids} == set(day.invoice_stop)
    assert all(day.invoice_stop[o] == s.stop_id for s in r.stops for o in s.order_ids)
    # Invoices merged per stop as the web does: cases add up, several invoices on some stops.
    assert all(s.demand_cases == sum(day.invoice_cases[o] for o in s.order_ids) for s in r.stops)
    assert sum(len(s.order_ids) > 1 for s in r.stops) > 30
    # About 25% of invoices are 1-3 cases; the remote towns get small orders.
    assert len(day.small_invoices) == 80 and all(1 <= day.invoice_cases[i] <= 3 for i in day.small_invoices)
    remote = day.remote_stops
    assert {day.area[s] for s in remote} == set(synth.REMOTE_AREAS)
    assert all(next(s for s in r.stops if s.stop_id == sid).demand_cases <= 3 for sid in remote)
    # Clustered around the public district centres (within their jitter radius).
    for s in r.stops:
        centre = (synth.REMOTE_AREAS | synth.AREAS)[day.area[s.stop_id]]
        assert km((s.lat, s.lng), centre[:2]) <= centre[2] + 0.01
    # Mixed bays fleet, 2-3 trips each.
    assert {t.bays for t in r.trucks} == {4, 5, 6, 11, 12, 14} and {t.max_trips for t in r.trucks} == {2, 3}
    biggest = max(t.bays for t in r.trucks) * 1000
    assert all(s.demand_pallet_units <= biggest for s in r.stops)  # every stop fits some truck
    # Tight morning windows for hypermarkets; the web's service-time formula.
    hyper = [s for s in r.stops if day.customer_type[s.stop_id] == "HYPERMARKET"]
    assert hyper and all((s.hard_start_min, s.hard_end_min) in ((420, 660), (480, 720)) for s in hyper)
    for s in r.stops:
        base = synth.TYPES[day.customer_type[s.stop_id]].base_min
        assert s.service_min == min(480, math.floor(base + 0.25 * s.demand_cases + 0.5))
    assert {s.priority for s in r.stops} == {1, 2, 3, 4, 5}
    assert all(s.margin is None for s in r.stops)  # no margins unless asked for
    small_only = [s for s in r.stops if s.allowed_truck_ids is not None]
    assert small_only and all(day.area[s.stop_id] in synth.OLD_TOWN for s in small_only)


def test_every_stop_has_labels(day):
    ids = {s.stop_id for s in day.request.stops}
    assert set(day.window_provenance) == ids == set(day.accepts_afternoon) == set(day.accepts_night)
    assert set(day.window_provenance.values()) == {CUSTOMER_HARD, SALES_PREFERENCE, UNKNOWN}
    # Genuine opening hours are known for preference windows only, and contain the window.
    assert day.genuine_hours and all(day.window_provenance[sid] == SALES_PREFERENCE for sid in day.genuine_hours)
    by_id = {s.stop_id: s for s in day.request.stops}
    for sid, (start, end) in day.genuine_hours.items():
        assert start <= by_id[sid].hard_start_min and by_id[sid].hard_end_min <= end
    assert 0 < sum(day.accepts_afternoon.values()) < len(ids) and 0 < sum(day.accepts_night.values()) < len(ids)


def test_a_day_is_the_same_for_its_seed_and_differs_between_seeds(day):
    again = synth.make_day(320, seed=1)
    assert again.request.model_dump_json() == day.request.model_dump_json()
    assert again.window_provenance == day.window_provenance and again.invoice_cases == day.invoice_cases
    assert synth.make_day(320, seed=2).request.model_dump_json() != day.request.model_dump_json()


def test_every_invented_number_is_listed(day):
    a = day.assumptions
    for key in ("label", "depot", "areas", "remote_areas", "customer_types", "small_invoice_share", "service_per_case_min",
                "invoice_lines", "weights", "cases_per_bay", "fleet_bays", "truck_costs", "config", "margin_per_case"):
        assert key in a and "basis" in a[key] and "value" in a[key]
    assert a["service_per_case_min"]["value"] == 0.25 and a["margin_per_case"]["value"] is None
    assert day.label == "SYNTHETIC" and day.request.config.distance_provider == "HAVERSINE"
    with_margin = synth.make_day(40, seed=1, margin_per_case=0.5)
    assert all(s.margin == pytest.approx(0.5 * s.demand_cases) for s in with_margin.request.stops)
    assert with_margin.assumptions["margin_per_case"]["value"] == 0.5
    with pytest.raises(ValueError):
        synth.make_day(40, profile="other")


def test_a_small_synthetic_day_plans_and_passes_the_independent_check(monkeypatch):
    monkeypatch.setenv("SOLVER_PARALLEL", "0")
    small = synth.make_day(40, seed=3)
    assert len(small.invoice_stop) == 40 and len(small.request.trucks) == 3
    res = core.solve(small.request, core.Budget(time_limit_sec=2, seeds=(1,)), 1)
    m = res.metrics
    assert m.feasibility == "VERIFIED" and m.status == "OPTIMIZED" and m.late_stops == 0
    assert m.stops_served >= 0.8 * m.stops_total and m.cash.total > 0
    allowed = {s.stop_id: set(s.allowed_truck_ids) for s in small.request.stops if s.allowed_truck_ids is not None}
    sc = res.response.scenarios[0]
    assert all(ld.truck_id in allowed[st.stop_id] for ld in sc.loads for st in ld.stops if st.stop_id in allowed)
