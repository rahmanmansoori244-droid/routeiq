"""Rule 22 (owner decision, audit policy 22): when the solver cannot start its worker processes it
stops within seconds with "The planner is busy or restarting - try again in a minute" (HTTP 503),
never searches inside its API process, and says so to an administrator (an ERROR line, /ready).

Before rule 22 a pool that could not start made the whole search run inside the API process with
no deadline: the planner stopped answering anything else for the length of the search (up to 20
minutes and more for a thorough one). That fallback is kept for development and tests only, behind
SOLVER_ALLOW_INPROCESS_FALLBACK=1; SOLVER_PARALLEL=0 (in-process on purpose) is unchanged."""
from __future__ import annotations

import errno
import logging
import multiprocessing.queues as mpq
import threading
import time
from multiprocessing.context import BaseContext, SpawnContext

import pytest
from fastapi.testclient import TestClient

import dispatch_solver as ds
from dispatch_solver import PLANNER_UNAVAILABLE_MSG, WorkersUnavailable, optimize_dispatch
from tests.test_dispatch import assert_reconciled, nmwc_day, rec, req, stop, truck

TOKEN = "unit-test-solver-token"


@pytest.fixture(autouse=True)
def _production_defaults(monkeypatch):
    """Production settings: worker processes, no in-process fallback; a fresh worker health."""
    monkeypatch.delenv("SOLVER_PARALLEL", raising=False)
    monkeypatch.delenv("SOLVER_ALLOW_INPROCESS_FALLBACK", raising=False)
    monkeypatch.delenv("SOLVER_WORKER_START_SEC", raising=False)
    ds.WORKER_HEALTH.started()
    yield
    ds.WORKER_HEALTH.started()


def _pools_fail(monkeypatch, *, after: int = 0) -> dict:
    """multiprocessing's spawn Pool raises OSError (EAGAIN, as when the process limit or the memory
    is reached) from its (after + 1)-th start on, while state["fail"] is true."""
    state = {"fail": True, "starts": 0}

    def pool(self, *a, **k):
        state["starts"] += 1
        if state["fail"] and state["starts"] > after:
            raise OSError(errno.EAGAIN, "Resource temporarily unavailable (test)")
        return BaseContext.Pool(self, *a, **k)

    monkeypatch.setattr(SpawnContext, "Pool", pool, raising=False)
    return state


def _no_search_here(monkeypatch) -> list:
    """Every search entry point fails the test when it runs in this (the API) process. Worker
    processes import the module afresh, so they never see these."""
    ran: list = []

    def here(name):
        def f(*_a, **_k):
            ran.append(name)
            raise AssertionError(f"{name} ran inside the API process")
        return f

    for name in ("_searched", "_scenario_worker", "_stage_worker", "_solve_scenario"):
        monkeypatch.setattr(ds, name, here(name))
    return ran


def _day(scenarios=("RECOMMENDED", "MIN_TRUCKS", "MIN_DISTANCE"), **cfg):
    stops, trucks = nmwc_day(20)
    return req(stops, trucks, time_limit_sec=2, scenarios=list(scenarios), **cfg)


def test_a_pool_that_cannot_start_refuses_within_seconds_and_searches_nothing(monkeypatch, caplog):
    """A thorough night plan (a 20-minute cap) whose workers cannot start: refused at once - before
    the road matrix is even fetched - never searched inside the API process."""
    _pools_fail(monkeypatch)
    ran = _no_search_here(monkeypatch)
    matrix_calls: list = []
    real_matrix = ds.resolve_matrix
    monkeypatch.setattr(ds, "resolve_matrix", lambda *a, **k: matrix_calls.append(1) or real_matrix(*a, **k))
    caplog.set_level(logging.WARNING, logger="routeiq.dispatch")

    t0 = time.perf_counter()
    with pytest.raises(WorkersUnavailable) as exc:
        optimize_dispatch(_day(search_mode="THOROUGH", max_search_sec=1200))
    elapsed = time.perf_counter() - t0

    assert elapsed < 5, elapsed
    assert str(exc.value) == PLANNER_UNAVAILABLE_MSG == "The planner is busy or restarting - try again in a minute."
    assert exc.value.code == "WORKERS_UNAVAILABLE"
    assert "Resource temporarily unavailable" in exc.value.cause
    assert ran == [] and matrix_calls == []
    # The administrator's alert: one ERROR line with a stable code to search or alert on ...
    errors = [r for r in caplog.records if r.levelno == logging.ERROR]
    assert len(errors) == 1 and "WORKERS_UNAVAILABLE" in errors[0].getMessage() and "rule 22" in errors[0].getMessage()
    # ... and /ready's workers status (the web's /api/health: degraded).
    assert ds.WORKER_HEALTH.status()["status"] == "failed"


def test_workers_that_die_while_starting_refuse_after_the_start_wait(monkeypatch):
    """A pool whose processes die as they start (Pool starts them again and again): its first task
    never runs. Refused after SOLVER_WORKER_START_SEC, not at the search's deadline (up to 20 min)."""
    monkeypatch.setenv("ROUTEIQ_TEST_WORKER_START_EXIT", "1")
    monkeypatch.setenv("SOLVER_WORKER_START_SEC", "3")
    ran = _no_search_here(monkeypatch)
    t0 = time.perf_counter()
    with pytest.raises(WorkersUnavailable) as exc:
        optimize_dispatch(_day(search_mode="THOROUGH", max_search_sec=1200))
    elapsed = time.perf_counter() - t0
    assert 2.5 <= elapsed < 20, elapsed
    assert "within 3 s" in exc.value.cause
    assert ran == []
    assert ds.WORKER_HEALTH.status()["status"] == "failed"


def test_the_in_process_fallback_only_when_explicitly_allowed(monkeypatch, caplog):
    """SOLVER_ALLOW_INPROCESS_FALLBACK=1 (development and tests): the old behaviour, a plan solved
    inside this process, with a warning. Unset (production): refused, as above."""
    _pools_fail(monkeypatch)
    monkeypatch.setenv("SOLVER_ALLOW_INPROCESS_FALLBACK", "1")
    caplog.set_level(logging.WARNING, logger="routeiq.dispatch")
    r = _day(scenarios=["RECOMMENDED"])
    resp = optimize_dispatch(r)
    assert rec(resp).status == "OPTIMIZED"
    assert_reconciled(r, rec(resp))
    assert any("SOLVER_ALLOW_INPROCESS_FALLBACK=1" in m.getMessage() for m in caplog.records if m.levelno == logging.WARNING)
    assert not [m for m in caplog.records if m.levelno >= logging.ERROR]

    for off in ("0", "", "true"):  # only exactly "1" allows it
        monkeypatch.setenv("SOLVER_ALLOW_INPROCESS_FALLBACK", off)
        with pytest.raises(WorkersUnavailable):
            optimize_dispatch(r)


def test_solver_parallel_0_is_unchanged(monkeypatch):
    """SOLVER_PARALLEL=0 never starts worker processes (in-process on purpose, tests and debugging),
    so a pool that cannot start does not matter to it."""
    state = _pools_fail(monkeypatch)
    monkeypatch.setenv("SOLVER_PARALLEL", "0")
    r = _day(scenarios=["RECOMMENDED"])
    resp = optimize_dispatch(r)
    assert rec(resp).status == "OPTIMIZED"
    assert state["starts"] == 0
    assert ds.WORKER_HEALTH.status()["status"] == "ok"


def test_load_recheck_without_workers_keeps_the_recommended_plan(monkeypatch):
    """An alternative overran, so the load re-check gets fresh workers - and they cannot start. The
    finished recommended plan is kept (failing the request would throw it away), re-timed exactly
    in milliseconds; no CP-SAT solve runs inside the API process."""
    monkeypatch.setenv("ROUTEIQ_TEST_HANG_SCENARIO", "MIN_TRUCKS")
    monkeypatch.setenv("SOLVER_ALT_GRACE_SEC", "3")
    _pools_fail(monkeypatch, after=1)  # the search's pool starts; the re-check's does not
    stage_here: list = []
    monkeypatch.setattr(ds, "_stage_worker", lambda job: stage_here.append(job) or pytest.fail("CP-SAT in the API process"))
    stops = [stop(f"S{i}", 23.55 + i * 0.01, 58.40, cases=20) for i in range(6)]
    r = req(stops, [truck("T01"), truck("T02")], time_limit_sec=2, loading_min_per_case=0.2,
            scenarios=["RECOMMENDED", "MIN_TRUCKS", "MIN_DISTANCE"])
    t0 = time.perf_counter()
    resp = optimize_dispatch(r)
    assert time.perf_counter() - t0 < 60
    sc = rec(resp)
    assert sc.status == "OPTIMIZED"
    assert_reconciled(r, sc)
    assert stage_here == []
    assert any("the optimizer could not start its worker processes" in w for w in sc.warnings), sc.warnings
    assert "MIN_TRUCKS" not in [s.name for s in resp.scenarios]
    assert ds.WORKER_HEALTH.status()["status"] == "failed"


def test_a_failed_pool_start_leaves_nothing_behind(monkeypatch):
    """Audit finding: the queue made before the Pool stayed open when the Pool failed."""
    _pools_fail(monkeypatch)
    closed: list = []
    real_close = mpq.SimpleQueue.close
    monkeypatch.setattr(mpq.SimpleQueue, "close", lambda self: closed.append(self) or real_close(self))
    with pytest.raises(OSError):
        ds._Workers(2)
    assert len(closed) == 1


def test_a_started_pool_is_proved_and_closes_once(monkeypatch):
    w = ds._start_workers(1, None, "r", "search")
    try:
        assert w is not None
        assert ds.WORKER_HEALTH.status() == {"status": "ok"}
    finally:
        w.close()
    w.close()  # twice: a no-op (optimize_dispatch closes after _run_scenarios did)


def test_worker_health_expires_and_clears(monkeypatch):
    ds.WORKER_HEALTH.failed("OSError: test")
    s = ds.WORKER_HEALTH.status()
    assert s["status"] == "failed" and s["cause"] == "OSError: test" and s["failed_at"]
    monkeypatch.setattr(ds, "WORKER_ALERT_SEC", 0)
    assert ds.WORKER_HEALTH.status() == {"status": "ok"}
    monkeypatch.setattr(ds, "WORKER_ALERT_SEC", 900)
    assert ds.WORKER_HEALTH.status()["status"] == "failed"
    ds.WORKER_HEALTH.started()  # a pool started again
    assert ds.WORKER_HEALTH.status() == {"status": "ok"}


# --------------------------------------------------------------------------------------
# main.py: the 503, the slot, /ready, a retry, the startup warning
# --------------------------------------------------------------------------------------

def test_over_http_a_plain_503_the_slot_comes_back_ready_alerts_and_a_retry_works(monkeypatch):
    import main

    monkeypatch.setattr(main, "SOLVER_TOKEN", TOKEN)
    monkeypatch.setattr(main, "_DISPATCH_SLOTS", threading.BoundedSemaphore(1))
    monkeypatch.delenv("OSRM_URL", raising=False)
    state = _pools_fail(monkeypatch)
    client = TestClient(main.app)
    headers = {"X-Solver-Token": TOKEN}
    stops, trucks = nmwc_day(8)
    body = req(stops, trucks, time_limit_sec=1, scenarios=["RECOMMENDED"]).model_dump(mode="json")

    t0 = time.perf_counter()
    r = client.post("/optimize-dispatch", json=body, headers=headers)
    assert time.perf_counter() - t0 < 5
    assert r.status_code == 503
    assert r.json() == {"detail": "The planner is busy or restarting - try again in a minute.", "code": "WORKERS_UNAVAILABLE"}
    assert r.headers["retry-after"] == "60"
    # The slot came back (a second request is not "Solver busy") and nothing is left running.
    assert main._DISPATCH_SLOTS._value == 1
    assert main._RUNNING == {}
    ready = client.get("/ready", headers=headers).json()
    assert ready["ok"] is False and ready["workers"]["status"] == "failed"

    # The processes can start again (the solver recovered): the dispatcher's retry works, and
    # /ready is back to ok.
    state["fail"] = False
    again = client.post("/optimize-dispatch", json=body, headers=headers)
    assert again.status_code == 200, again.text
    assert again.json()["scenarios"][0]["status"] == "OPTIMIZED"
    ready = client.get("/ready", headers=headers).json()
    assert ready["ok"] is True and ready["workers"] == {"status": "ok"}


def test_startup_warning_for_the_in_process_fallback(monkeypatch):
    import main

    monkeypatch.delenv("SOLVER_ALLOW_INPROCESS_FALLBACK", raising=False)
    assert main.inprocess_fallback_warning() is None
    monkeypatch.setenv("SOLVER_ALLOW_INPROCESS_FALLBACK", "1")
    for k in ("RAILWAY_ENVIRONMENT_ID", "RAILWAY_PROJECT_ID", "RAILWAY_ENVIRONMENT_NAME", "RAILWAY_ENVIRONMENT"):
        monkeypatch.delenv(k, raising=False)
    assert "outside a deployment" in main.inprocess_fallback_warning()
    monkeypatch.setenv("RAILWAY_ENVIRONMENT_NAME", "production")
    text = main.inprocess_fallback_warning()
    assert "on Railway (production)" in text and "remove it from any deployed solver" in text
