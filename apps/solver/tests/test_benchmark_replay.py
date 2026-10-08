"""Replays of the outside benchmark of 8 Oct 2026 (findings F01, F02, F07) through the production
worker path. SLOW (2-6 minutes each, several CPUs): skipped unless ROUTEIQ_BENCH_REPLAY=1. With
ROUTEIQ_BENCH_OUT=<dir> each response is written there with its request and road matrix, ready for
the benchmark bundle's independent checker (fixtures/benchmark-2026-10-08/README.md).

The requests are the bundle's synthetic inputs (fictional customers, straight-line distances).
"""
from __future__ import annotations

import json
import os
from pathlib import Path

import pytest

import dispatch_solver as ds
from dispatch_models import DispatchRequest

FIXTURES = Path(__file__).parent / "fixtures" / "benchmark-2026-10-08"
REPLAY = os.environ.get("ROUTEIQ_BENCH_REPLAY") == "1"
pytestmark = pytest.mark.skipif(not REPLAY, reason="slow benchmark replay: set ROUTEIQ_BENCH_REPLAY=1")


def _replay(monkeypatch, name: str, *, time_limit: int | None, budget: int, seed: int = 17):
    """One request as production runs it: worker processes, the second search on, the request budget."""
    for k in list(os.environ):
        if k.startswith("ROUTEIQ_TEST_") or k in ("SOLVER_ALLOW_INPROCESS_FALLBACK", "SOLVER_PYVRP_MAX_ITERS"):
            monkeypatch.delenv(k, raising=False)
    monkeypatch.setenv("SOLVER_PARALLEL", "1")
    monkeypatch.setenv("SOLVER_PYVRP", "on")
    monkeypatch.setenv("SOLVER_PYVRP_SEED", str(seed))
    monkeypatch.setenv("SOLVER_BUDGET_SEC", str(budget))
    r = DispatchRequest.model_validate_json((FIXTURES / f"{name}.request.json").read_text())
    r.config.time_limit_sec = time_limit
    captured: dict = {}
    original = ds.resolve_matrix

    def capture(*args, **kwargs):
        mx = original(*args, **kwargs)
        captured.update(distance_m=mx.distance_m, duration_s=mx.duration_s)
        return mx

    monkeypatch.setattr(ds, "resolve_matrix", capture)
    resp = ds.optimize_dispatch(r)
    out = os.environ.get("ROUTEIQ_BENCH_OUT")
    if out:
        d = Path(out) / f"{name}-{time_limit or 'auto'}-{budget}-s{seed}"
        d.mkdir(parents=True, exist_ok=True)
        (d / "request.json").write_text(r.model_dump_json(indent=1))
        (d / "response.json").write_text(resp.model_dump_json(indent=1))
        (d / "matrix-used.json").write_text(json.dumps(captured, separators=(",", ":")))
    sc = next(s for s in resp.scenarios if s.name == "RECOMMENDED")
    served = {st.stop_id for ld in sc.loads for st in ld.stops}
    by_p = [sum(1 for s in r.stops if s.priority == p and s.stop_id in served) for p in range(1, 6)]
    return r, sc, served, by_p


def test_d5_native_replan_serves_every_stop(monkeypatch):
    """F07: the native QUICK re-plan (110 s search, 540 s cap) served 84 of 180 stops (3 P1 and 20 P2
    left out) while a checked greedy plan serves all 180 / 320 invoices / 4,826 cases."""
    r, sc, served, by_p = _replay(monkeypatch, "D5_late_frozen", time_limit=None, budget=540)
    assert sc.feasibility is not None and sc.feasibility.status == "VERIFIED", sc.feasibility
    assert by_p == [13, 36, 39, 51, 41]  # the greedy witness's service: every stop
    assert sum(len(s.order_ids) for s in r.stops if s.stop_id in served) == 320
    assert sc.total_cases == 4826


def test_p02_replan_serves_c3_on_an_unused_truck(monkeypatch):
    """F02: a 721-case load frozen, a 40-case P1 order added at 11:00; C3 (54 cases, three invoices)
    stayed unserved while trucks stood unused."""
    r, sc, served, by_p = _replay(monkeypatch, "P02_frozen_late_vip", time_limit=None, budget=540, seed=1)
    assert sc.feasibility is not None and sc.feasibility.status == "VERIFIED", sc.feasibility
    assert "C3" in served
    assert served == {s.stop_id for s in r.stops}
    assert sc.total_cases + sum(f.cases for t in r.trucks for f in t.frozen_trips) == 6862


def test_d3_short_budget_gives_a_checked_plan(monkeypatch):
    """F01: at 60 s search / 240 s cap every answer was VIOLATED. Now a checked plan (partial allowed)
    serving at least every P1-P3 stop the greedy reference serves (it serves all of them)."""
    r, sc, served, by_p = _replay(monkeypatch, "D3_tight_receiving", time_limit=60, budget=240)
    assert sc.feasibility is not None and sc.feasibility.status == "VERIFIED", sc.feasibility
    assert by_p[:3] == [10, 22, 58]
