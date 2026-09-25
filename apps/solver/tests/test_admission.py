"""Stabilization PR3 (review F16): the solver refuses more concurrent dispatch solves than
MAX_CONCURRENT_DISPATCH with 503 "solver busy", at once, instead of queueing them behind running
solves (which would push every solve past its deadline). The web's solve admission queues first;
this is defence in depth."""
from __future__ import annotations

import threading

from fastapi.testclient import TestClient

import main
from dispatch_models import DispatchConfig, DispatchDepot, DispatchRequest, DispatchStop, DispatchTruck
from dispatch_solver import SolveAborted

TOKEN = "unit-test-solver-token"
HEADERS = {"X-Solver-Token": TOKEN}


def _body() -> dict:
    req = DispatchRequest(
        run_id="r-admission",
        tenant_id="t",
        depot=DispatchDepot(id="d", lat=23.585, lng=58.39),
        trucks=[DispatchTruck(id="T1", code="T1", capacity_cases=100)],
        stops=[DispatchStop(stop_id="s1", order_ids=["o1"], customer_id="c1", lat=23.6, lng=58.4, demand_cases=5)],
        config=DispatchConfig(distance_provider="HAVERSINE", scenarios=["RECOMMENDED"], time_limit_sec=1),
    )
    return req.model_dump(mode="json")


def test_env_int_falls_back_on_bad_values(monkeypatch):
    monkeypatch.setenv("MAX_CONCURRENT_DISPATCH", "3")
    assert main._env_int("MAX_CONCURRENT_DISPATCH", 2) == 3
    for bad in ["", "0", "-1", "two"]:
        monkeypatch.setenv("MAX_CONCURRENT_DISPATCH", bad)
        assert main._env_int("MAX_CONCURRENT_DISPATCH", 2) == 2


def test_second_concurrent_dispatch_gets_503_and_the_slot_comes_back(monkeypatch):
    monkeypatch.setattr(main, "SOLVER_TOKEN", TOKEN)
    monkeypatch.setattr(main, "MAX_CONCURRENT_DISPATCH", 1)
    monkeypatch.setattr(main, "_DISPATCH_SLOTS", threading.BoundedSemaphore(1))
    entered = threading.Event()
    release = threading.Event()

    def blocking_solve(_req):
        entered.set()
        assert release.wait(20), "test did not release the first solve"
        raise SolveAborted("test: first solve released")

    monkeypatch.setattr(main, "optimize_dispatch", blocking_solve)
    client = TestClient(main.app)
    body = _body()
    first: dict = {}
    worker = threading.Thread(target=lambda: first.setdefault("res", client.post("/optimize-dispatch", json=body, headers=HEADERS)))
    worker.start()
    try:
        assert entered.wait(20), "the first solve never started"
        busy = client.post("/optimize-dispatch", json=body, headers=HEADERS)
        assert busy.status_code == 503
        assert "busy" in busy.json()["detail"].lower()
        assert busy.headers.get("retry-after") == "60"
    finally:
        release.set()
        worker.join(20)
    # The first solve ran (504 from its SolveAborted), not refused.
    assert first["res"].status_code == 504

    # Its slot was given back: the next solve is admitted again.
    calls = []

    def quick_solve(_req):
        calls.append(1)
        raise SolveAborted("test: quick")

    monkeypatch.setattr(main, "optimize_dispatch", quick_solve)
    again = client.post("/optimize-dispatch", json=body, headers=HEADERS)
    assert again.status_code == 504
    assert calls == [1]


def test_a_rejected_token_does_not_take_a_slot(monkeypatch):
    monkeypatch.setattr(main, "SOLVER_TOKEN", TOKEN)
    slots = threading.BoundedSemaphore(1)
    monkeypatch.setattr(main, "_DISPATCH_SLOTS", slots)
    client = TestClient(main.app)
    res = client.post("/optimize-dispatch", json=_body(), headers={"X-Solver-Token": "wrong"})
    assert res.status_code == 401
    assert slots.acquire(blocking=False)  # still free
    slots.release()
