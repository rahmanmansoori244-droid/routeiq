"""Decision support, historical adapters and IVMS aggregates (DESIGN.md 1.3, 1.4): anonymous ids, UNKNOWN
provenance on real days, a deterministic uncertainty model, and committed aggregates without personal data."""
from __future__ import annotations

import json
import re
from pathlib import Path

import pytest

from decision_support import history, ivms
from decision_support.history import UNKNOWN, UncertaintyModel
from tests.test_dispatch import hm, req, stop, truck

REAL_DAY = Path.home() / "ds-data" / "day-2026-10-15-v1-request.json"
FORBIDDEN_KEYS = {"name", "names", "preseller", "reg_no", "plate", "plates", "driver", "drivers", "customer", "customer_id",
                  "customer_key", "customers_list", "address", "geocoding", "end_geocoding", "lat", "lng", "phone",
                  "code", "branch_code", "erp_ship_to", "google_maps"}


def real_like():
    """A request with ids that look like real ones (customer codes, plates, invoice numbers)."""
    stops = [stop("XAA0001|BX9", 23.60, 58.40, cases=12, hard_start_min=hm("08:00"), hard_end_min=hm("12:00")),
             stop("XCC0002|ZQX", 23.65, 58.20, cases=40, previous_truck_id="12345 AB"),
             stop("XCN0003-Z01", 23.62, 58.54, cases=3, allowed_truck_ids=["12345 AB"])]
    for s in stops:
        s.customer_id, s.order_ids = f"CUST::{s.stop_id}", [f"INV-9{i}::{s.stop_id}" for i in range(2)]
    return req(stops, [truck("12345 AB", cap=500), truck("67890 CD", cap=500)])


def stamp(local_min: int) -> str:
    """A UTC timestamp of the 14 Oct for a minute of the Oman day (UTC + 4 h)."""
    return f"2026-10-14T{local_min // 60 - 4:02d}:{local_min % 60:02d}:00Z"


def walk_keys(obj):
    if isinstance(obj, dict):
        for k, v in obj.items():
            yield k
            yield from walk_keys(v)
    elif isinstance(obj, list):
        for v in obj:
            yield from walk_keys(v)


def test_anonymise_replaces_every_id_and_keeps_the_day():
    r = real_like()
    a = history.anonymise(r)
    text = a.model_dump_json()
    for s in r.stops:
        assert s.stop_id not in text and s.customer_id not in text and not any(o in text for o in s.order_ids)
    assert "12345 AB" not in text and "67890 CD" not in text and a.run_id == "anon"
    assert sorted(s.stop_id for s in a.stops) == ["stop-001", "stop-002", "stop-003"]
    assert [t.id for t in a.trucks] == ["truck-01", "truck-02"]
    by = {s.stop_id: s for s in a.stops}
    assert by["stop-002"].previous_truck_id == "truck-01" and by["stop-003"].allowed_truck_ids == ["truck-01"]
    assert [(s.lat, s.demand_cases, s.hard_end_min) for s in sorted(a.stops, key=lambda s: s.stop_id)] == \
           [(s.lat, s.demand_cases, s.hard_end_min) for s in sorted(r.stops, key=lambda s: s.stop_id)]
    assert len({o for s in a.stops for o in s.order_ids}) == 6


def test_a_real_day_has_unknown_provenance_on_every_window(tmp_path):
    path = tmp_path / "day.json"
    path.write_text(json.dumps({"request": json.loads(real_like().model_dump_json())}))
    day = history.load_real(path)
    assert day.window_provenance == {"XAA0001|BX9": UNKNOWN}
    assert not any(day.accepts_afternoon.values()) and not any(day.accepts_night.values()) and day.genuine_hours == {}
    assert day.source == "day.json" and len(day.digest) == 16
    anon = day.anonymised()
    assert anon.window_provenance == {"stop-001": UNKNOWN} and set(anon.accepts_night) == {"stop-001", "stop-002", "stop-003"}
    assert "XAA0001" not in anon.request.model_dump_json()


def test_uncertainty_sampling_is_deterministic_and_bounded():
    m = UncertaintyModel.defaults()
    assert m.assumed == ("travel_median", "travel_sigma", "unload_median", "unload_sigma")
    assert m.sample(7, 50) == m.sample(7, 50) and m.sample(7, 50) != m.sample(8, 50)
    assert m.draw(3, "stop-001") == m.draw(3, "stop-001") != m.draw(3, "stop-002")
    draws = m.sample(1, 4000)
    lo, hi = history.MULTIPLIER_BOUNDS
    assert all(lo <= d.travel <= hi and lo <= d.unload <= hi for d in draws)
    travel = sorted(d.travel for d in draws)
    assert travel[len(travel) // 2] == pytest.approx(m.travel_median, rel=0.05)


def test_the_uncertainty_model_reads_gps_confirmed_actuals(tmp_path):
    """A synthetic export in the shape of the 14 Oct actuals: 12 GPS-confirmed visits of one load, each 20%
    slower than planned for unloading and for the drive."""
    stops, visits = [], []
    for k in range(1, 13):
        eta = 480 + 25 * (k - 1)  # planned arrival (minute of the day), 10 min planned service, 15 min drive
        stops.append({"loadId": "L1", "sequenceInTruck": k, "etaMin": eta, "departureMin": eta + 10})
        arr = 8 * 60 + 30 * (k - 1)  # actual: 12 min unloading, 18 min drive
        visits.append({"firstLoadId": "L1", "sequence": k, "plannedEtaMin": eta, "plannedServiceMin": 10,
                       "arrivedAt": stamp(arr), "departedAt": stamp(arr + 12), "outcome": "DELIVERED", "casesDelivered": 5,
                       "timingSuspect": False, "arrivalSource": "PHONE_AUTO", "arrivalDistanceM": 20})
    path = tmp_path / "actuals.json"
    path.write_text(json.dumps({"config": {"geofenceRadiusM": 100}, "stops": stops, "visits": visits}))
    stats = ivms.actuals_stats(path)
    gps = stats["gps"]
    assert gps["unloading"]["actual_min"]["p50"] == 12 and gps["unloading"]["ratio_of_totals"] == 1.2
    assert gps["travel"]["actual_min"]["n"] == 11 and gps["travel"]["ratio_of_totals"] == 1.2
    assert gps["visit_cycle"]["lognormal"]["median"] == 1.2 and gps["arrival_minus_planned_min"]["p50"] == 27.5
    m = UncertaintyModel.from_actuals(path)
    assert (m.travel_median, m.unload_median) == (1.2, 1.2) and m.assumed == ()
    assert m.travel_sigma == history.SIGMA_BOUNDS[0]  # no spread at all: the lower bound


def test_committed_aggregates_load_and_hold_no_personal_data():
    agg = ivms.load()
    keys = {k.lower() for k in walk_keys(agg)}
    assert not keys & FORBIDDEN_KEYS
    text = json.dumps(agg, ensure_ascii=False)
    assert not re.search(r"\d+\.\d{4,}", text), "no coordinates (numbers with 4+ decimals)"
    raw = agg["ivms_raw"]
    assert set(raw["travel_speed_kmh"]["by_band"]) == {b for b, _, _ in ivms.BANDS}
    assert {"share_over_60", "share_over_120", "p50"} <= set(raw["stop_dwell_min"]["all"])
    assert raw["day_shape"]["vehicle_days"] > 100 and "p50" in raw["day_shape"]["first_departure"]
    chains = agg["evidence_2026_10_12"]["chain_unloading"]["chains"]
    assert chains and all(re.fullmatch(r"chain-\d\d|HOTEL|OTHER_MT", c["chain"]) for c in chains)
    assert all(r["chain"] in {c["chain"] for c in chains} for r in agg["evidence_2026_10_12"]["chain_unloading"]["by_drop_size"])
    assert all("[name removed]" in str(v) or not re.search(r"agree with [A-Z]", str(v))
               for row in agg["evidence_2026_10_12"]["fleet_parameters"]["rows"] for v in row.values())
    assert {"taps", "gps", "visits"} <= set(agg["actuals_2026_10_14"])


def test_no_region_figures_for_fewer_than_three_vehicles():
    """The repository is public: a region driven by one or two vehicles would describe one or two drivers, so the
    committed aggregates publish region figures only for regions with at least MIN_GROUP_VEHICLES vehicles; the same
    rule holds for customer segments, and the one-vehicle bus class has no published travel factor."""
    raw = ivms.load()["ivms_raw"]
    published = raw["regions"]["published"]
    assert published and all(v["vehicles"] >= ivms.MIN_GROUP_VEHICLES for v in published.values())
    assert set(raw["travel_speed_kmh"]["by_region_band"]) <= set(published)
    assert set(raw["stop_dwell_min"]["by_region"]) <= set(published)
    assert raw["regions"]["suppressed_regions"] >= 0 and "Muscat" in published
    ev = ivms.load()["evidence_2026_10_12"]
    assert all(v["customers"] >= ivms.MIN_GROUP_VEHICLES for v in ev["visit_frequency"]["by_segment"].values())
    assert not any(re.search(r"bus [0-9.]+-[0-9.]+", str(v)) for row in ev["fleet_parameters"]["rows"] for v in row.values())


def test_the_uncertainty_model_from_the_aggregates_names_its_assumptions():
    m = UncertaintyModel.from_aggregates()
    assert history.SIGMA_BOUNDS[0] <= m.travel_sigma <= history.SIGMA_BOUNDS[1]
    assert history.SIGMA_BOUNDS[0] <= m.unload_sigma <= history.SIGMA_BOUNDS[1]
    assert set(m.basis) == {"travel_median", "travel_sigma", "unload_median", "unload_sigma"}
    for p in m.assumed:
        assert "ASSUMPTION" in m.basis[p]
    # The IVMS / evidence spreads are used when the GPS-confirmed actuals are too few.
    assert "IVMS" in m.basis["travel_sigma"] or "plan vs actual" in m.basis["travel_sigma"]


def test_the_leak_check_refuses_names_plates_and_coordinates():
    secrets = {"Zorba Quillon Testname", "12345 AB", "HYPERMARKET"}
    ivms.check_no_leak('{"segment": "HYPERMARKET", "p50": 12.5}', secrets, {"hypermarket"})
    for text in ('{"note": "zorba quillon testname said"}', '{"truck": "12345 ab"}', '{"x": 23.58812}'):
        with pytest.raises(ivms.LeakError):
            ivms.check_no_leak(text, secrets, {"hypermarket"})


def test_percentiles_interpolate_like_numpy():
    p = ivms.percentiles([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
    assert (p["n"], p["p10"], p["p25"], p["p50"], p["p75"], p["p90"], p["mean"]) == (10, 1.9, 3.25, 5.5, 7.75, 9.1, 5.5)
    assert ivms.percentiles([]) == {"n": 0}


@pytest.mark.skipif(not REAL_DAY.exists(), reason="the real request is only on the codespace (~/ds-data)")
def test_the_real_15_oct_request_loads_with_unknown_windows():
    day = history.load_real(REAL_DAY)
    assert len(day.request.stops) == 86 and len(day.request.trucks) == 12
    assert set(day.window_provenance.values()) == {UNKNOWN}
    anon = day.anonymised().request
    assert all(s.stop_id.startswith("stop-") and s.customer_id.startswith("cust-") for s in anon.stops)
