"""Decision support, core layer (DESIGN.md 1.1): equal budgets, seeds, metrics with cash kept apart from the
ARTIFICIAL solver penalties, and the summary / diff arithmetic."""
from __future__ import annotations

import json
import os

import pytest

from decision_support import core
from decision_support.core import Budget, CashBreakdown, Metrics, RunResult
from dispatch_models import UnservedStop
import dispatch_solver as ds
from tests.test_dispatch import hm, req, stop, truck


def tiny_day(**cfg):
    """Ten stops on two one-trip trucks of 400 cases: six small ones, one no truck can reach in its hours (a
    proof), one with a preferred window it cannot meet (soft), and two of 380 cases, so the day is 90 cases
    short and its P5 380-case stop stays out (a day-level shortage, not a proof about that stop)."""
    stops = [stop(f"s{i}", 23.58 + 0.01 * i, 58.40 + 0.01 * i, cases=20, priority=1 + i % 5) for i in range(6)]
    stops.append(stop("far", 23.95, 58.95, cases=10, priority=2, hard_start_min=hm("06:00"), hard_end_min=hm("06:30")))
    stops.append(stop("pref", 23.66, 58.48, cases=10, priority=3, pref_start_min=hm("06:00"), pref_end_min=hm("06:05")))
    stops += [stop("big4", 23.60, 58.45, cases=380, priority=4), stop("big5", 23.61, 58.46, cases=380, priority=5)]
    cfg.setdefault("max_trips_per_truck", 1)
    return req(stops, [truck("T1", cap=400, fixed_cost=20, cost_per_km=0.1, km_per_litre=4.0),
                       truck("T2", cap=400, fixed_cost=20, cost_per_km=0.1, km_per_litre=4.0)],
               fuel_price_per_litre=0.26, driver_cost_per_hour=2.5, **cfg)


def stop_records(r) -> list[str]:
    return sorted(s.model_dump_json() for s in r.stops)


def test_budget_checks_its_fields():
    assert Budget() == Budget(time_limit_sec=20, search_mode="QUICK", seeds=(1, 2, 3))
    for bad in (dict(time_limit_sec=0), dict(search_mode="FAST"), dict(seeds=()), dict(seeds=(1, 1)), dict(seeds=(-1,))):
        with pytest.raises(ValueError):
            Budget(**bad)


def test_seeded_permutes_only_the_stop_order_and_seed_0_keeps_it():
    r = tiny_day()
    assert [s.stop_id for s in core.seeded(r, 0).stops] == [s.stop_id for s in r.stops]
    a, b, c = core.seeded(r, 1), core.seeded(r, 1), core.seeded(r, 2)
    assert [s.stop_id for s in a.stops] == [s.stop_id for s in b.stops]  # deterministic
    assert [s.stop_id for s in a.stops] != [s.stop_id for s in c.stops]
    # The same day: identical stops (as sets of full records), trucks and config.
    assert stop_records(a) == stop_records(r) and a.trucks == r.trucks and a.config == r.config
    # The order depends on (seed, stop id) only, not on the incoming order.
    assert [s.stop_id for s in core.seeded(c, 1).stops] == [s.stop_id for s in a.stops]
    assert r.stops[0].stop_id == "s0"  # the original is untouched


def test_offline_never_calls_osrm_and_leaves_the_request_alone():
    r = tiny_day(distance_provider="OSRM", osrm_url="http://router.invalid")
    o = core.offline(r)
    assert (o.config.distance_provider, o.config.osrm_url) == ("HAVERSINE", None)
    assert (r.config.distance_provider, r.config.osrm_url) == ("OSRM", "http://router.invalid")


def test_load_request_reads_a_raw_or_wrapped_request(tmp_path):
    r = tiny_day()
    (tmp_path / "raw.json").write_text(r.model_dump_json())
    (tmp_path / "wrapped.json").write_text(json.dumps({"request": json.loads(r.model_dump_json())}))
    assert core.load_request(tmp_path / "raw.json") == r == core.load_request(tmp_path / "wrapped.json")


def test_labels_are_anonymous_and_do_not_depend_on_the_order():
    r = tiny_day()
    labels = core.label_stops(r)
    assert labels == core.label_stops(core.seeded(r, 5))
    assert sorted(labels.values()) == [f"stop-{i:03d}" for i in range(1, 11)]


def test_proof_kinds_follow_the_engine_texts():
    def u(code, msg):
        return UnservedStop(stop_id="x", order_ids=["o"], reason_code=code, reason_message=msg)

    cases = [
        (u("EXCEEDS_ANY_TRUCK_CAPACITY", "Order is larger than any available truck"), "PREFILTER"),
        (u("HARD_WINDOW_INFEASIBLE", "No truck can reach this customer"), "WINDOW"),
        (u("SHIFT_LIMIT", "A round trip to this customer does not fit inside the truck shift"), "WINDOW"),
        (u("SHIFT_LIMIT", "No truck has shift time left after its locked/dispatched loads."), "PREFILTER"),
        (u("NO_ALLOWED_TRUCK", "Needs a small truck: no such truck can take a new load today"), "PREFILTER"),
        (u("NO_ALLOWED_TRUCK", "Needs a small truck: no such truck had room (T1); ... Not planned: no load"), "NO_ROOM"),
        (u("NO_ALLOWED_TRUCK", "Needs a small truck: no such truck had room or time left for this P3 stop"), "SEARCH"),
        (u("SOLVER_DROPPED_LOW_PRIORITY", "Not planned: no load or free trip has room for its 40 cases"), "NO_ROOM"),
        (u("SOLVER_DROPPED_LOW_PRIORITY", "Fleet capacity shortage: 900 cases requested vs 800"), "FLEET_SHORTAGE"),
        (u("SOLVER_DROPPED_LOW_PRIORITY", ds.TIMING_DROP_HEAD + " (30 min)"), "TIMING"),
        (u("SOLVER_DROPPED_LOW_PRIORITY", ds._hire_drop_reason(5)), "HIRE_POLICY"),
        (u("SOLVER_DROPPED_LOW_PRIORITY", "Not planned: the optimizer found no truck, trip or time slot"), "SEARCH"),
        (u("INFEASIBLE", ds._no_plan_message("ROUTING_FAIL_TIMEOUT")), "NO_PLAN"),
        (u("LATE_ORDER_NO_CAPACITY", "Late order (P2)"), "LATE"),
    ]
    assert [core.proof_kind(x) for x, _ in cases] == [k for _, k in cases]


def test_metrics_of_a_tiny_solved_day_keep_cash_and_penalties_apart(monkeypatch):
    monkeypatch.setenv("SOLVER_PARALLEL", "0")
    monkeypatch.setenv("SOLVER_PYVRP_SEED", "9")
    r = tiny_day()
    res = core.solve(r, Budget(time_limit_sec=1, seeds=(1,)), 1)
    assert os.environ["SOLVER_PYVRP_SEED"] == "9"  # restored after the run
    assert res.env["SOLVER_PYVRP_SEED"] == "1" and res.digest == core.digest(r)
    cfg = res.request.config
    assert (cfg.time_limit_sec, cfg.search_mode, cfg.scenarios, cfg.distance_provider) == (1, "QUICK", ["RECOMMENDED"], "HAVERSINE")
    sc = res.response.scenarios[0]
    m = res.metrics
    # Cash is the engine's operating cost, and its parts add up to it.
    assert m.cash.total == pytest.approx(sc.operating_cost, abs=1e-9) and m.cash.total > 0
    parts = m.cash.fixed + m.cash.trip + m.cash.distance + m.cash.fuel + m.cash.driver + m.cash.overtime
    assert parts == pytest.approx(m.cash.total, abs=0.001 * 6)
    # Penalties are separate and ARTIFICIAL: the left-out stop's large value (1,000+ OMR-equivalent) is not cash.
    assert set(m.penalties) == {"unserved_penalty", "window", "early", "continuity"}
    assert m.penalties["unserved_penalty"] == pytest.approx(sc.objective.unserved_penalty) and m.penalties["unserved_penalty"] >= 1000
    assert m.cash.total < 200
    # Minutes outside the preferred windows agree with the engine's own window penalty (0.05 OMR/min).
    assert m.minutes_outside_pref > 0
    assert m.penalties["window"] == pytest.approx(m.minutes_outside_pref * cfg.pref_window_penalty_per_min, abs=0.05)
    # The far stop is proven impossible by the window prefilter; the shortage proves nothing about big5.
    assert m.unserved_by_reason == {"HARD_WINDOW_INFEASIBLE": 1, "SOLVER_DROPPED_LOW_PRIORITY": 1}
    assert sorted(core.proof_kind(u) for u in sc.unserved) == ["FLEET_SHORTAGE", "WINDOW"] and m.proven_impossible == 1
    assert (m.stops_total, m.stops_served, m.cases_total, m.cases_served) == (10, 8, 900, 510)
    assert (m.unserved_by_priority[2], m.unserved_by_priority[5], sum(m.served_by_priority.values())) == (1, 1, 8)
    assert (m.late_stops, m.feasibility, m.status) == (0, "VERIFIED", "OPTIMIZED")
    # Late stops count against the windows of the request given: one that closes before its planned start is late.
    first = sc.loads[0].stops[0]
    shut = res.request.model_copy(deep=True)
    s0 = next(s for s in shut.stops if s.stop_id == first.stop_id)
    s0.hard_start_min, s0.hard_end_min = 0, first.service_start_min - 1
    assert core.metrics(shut, res.response).late_stops == 1
    assert m.km > 0 and m.trucks_used >= 1 and m.trips >= 1 and m.paid_driver_min > 0
    assert m.km == pytest.approx(sc.total_distance_km)


def test_solve_seeds_runs_every_seed_on_the_same_day(monkeypatch):
    monkeypatch.setenv("SOLVER_PARALLEL", "0")
    r = tiny_day()
    runs = core.solve_seeds(r, Budget(time_limit_sec=1, seeds=(1, 2)))
    assert [x.seed for x in runs] == [1, 2] and len({x.digest for x in runs}) == 1
    assert [x.metrics.stops_served for x in runs] == [8, 8]
    assert [s.stop_id for s in runs[0].request.stops] != [s.stop_id for s in runs[1].request.stops]
    summary = core.summarize(runs)
    assert summary["feasibility"] == {"VERIFIED": 2} and summary["metrics"]["stops_served"]["mean"] == 8
    assert "ARTIFICIAL" in summary["labels"]["penalties"] and "estimated km" in summary["labels"]["km"]


def fake(seed: int, cash: float, served: int, reasons: dict[str, int], feas: str = "VERIFIED") -> RunResult:
    m = Metrics(status="OPTIMIZED", solver_status="ROUTING_SUCCESS", stops_total=10, stops_served=served,
                cases_served=served * 10, cases_total=100, served_by_priority={1: served}, unserved_by_priority={1: 10 - served},
                unserved_by_reason=reasons, proven_impossible=0, trucks_used=2, trips=3, km=50.0,
                cash=CashBreakdown(fixed=40.0, total=cash), penalties={"unserved_penalty": 1000.0 * (10 - served)},
                late_stops=0, minutes_outside_pref=0, paid_driver_min=600, feasibility=feas)
    return RunResult(seed=seed, digest="d", request=None, response=None, metrics=m, wall_sec=1.0)  # type: ignore[arg-type]


def test_summarize_takes_mean_min_max_and_counts_missing_reasons_as_zero():
    s = core.summarize([fake(1, 100.0, 8, {"SHIFT_LIMIT": 2}), fake(2, 110.0, 9, {}), fake(3, 120.0, 10, {}, "VIOLATED")])
    cash = s["metrics"]["cash.total"]
    assert (cash["mean"], cash["min"], cash["max"], cash["values"]) == (110.0, 100.0, 120.0, [100.0, 110.0, 120.0])
    assert s["metrics"]["unserved_by_reason.SHIFT_LIMIT"]["values"] == [2.0, 0.0, 0.0]
    assert s["metrics"]["penalties.unserved_penalty"]["mean"] == 1000.0
    assert s["seeds"] == [1, 2, 3] and s["digest"] == "d" and s["feasibility"] == {"VERIFIED": 2, "VIOLATED": 1}


def test_diff_pairs_seeds_or_gives_the_widest_range():
    base = core.summarize([fake(1, 100.0, 8, {}), fake(2, 110.0, 9, {})])
    same = core.diff(base, core.summarize([fake(1, 103.0, 9, {}), fake(2, 109.0, 9, {})]))
    assert same["paired"] and same["metrics"]["cash.total"] == {"mean": 1.0, "min": -1.0, "max": 3.0, "values": [3.0, -1.0]}
    assert same["metrics"]["stops_served"]["values"] == [1.0, 0.0]
    other = core.diff(base, core.summarize([fake(3, 103.0, 9, {"SHIFT_LIMIT": 1}), fake(4, 109.0, 9, {})]))
    assert not other["paired"]
    assert other["metrics"]["cash.total"] == {"mean": 1.0, "min": 103.0 - 110.0, "max": 109.0 - 100.0}
    assert other["metrics"]["unserved_by_reason.SHIFT_LIMIT"]["mean"] == 0.5
