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
from multiprocessing.context import BaseContext, SpawnContext, SpawnProcess

import pytest
from fastapi.testclient import TestClient

import dispatch_solver as ds
from dispatch_solver import PLANNER_UNAVAILABLE_MSG, WorkersUnavailable, optimize_dispatch
from tests.test_dispatch import assert_reconciled, nmwc_day, rec, req, stop, truck

TOKEN = "unit-test-solver-token"


@pytest.fixture(autouse=True)
def _production_defaults(monkeypatch):
    """Production settings: worker processes, no in-process fallback. (conftest.py gives every test
    a fresh worker health.)"""
    monkeypatch.delenv("SOLVER_PARALLEL", raising=False)
    monkeypatch.delenv("SOLVER_ALLOW_INPROCESS_FALLBACK", raising=False)
    monkeypatch.delenv("SOLVER_WORKER_START_SEC", raising=False)


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


def _day(scenarios=("RECOMMENDED", "MIN_TRUCKS", "MIN_DISTANCE"), time_limit_sec=2, **cfg):
    stops, trucks = nmwc_day(20)
    return req(stops, trucks, time_limit_sec=time_limit_sec, scenarios=list(scenarios), **cfg)


def _process_starts_refused(monkeypatch, *, after: int | None = None) -> dict:
    """multiprocessing's spawn Process.start raises OSError (EAGAIN: the process limit) from its
    (after + 1)-th call on, or once state["refuse"] is set. A Pool then has its first processes but
    cannot start a replacement: its worker-handler thread dies with that error."""
    real = SpawnProcess._Popen
    state = {"refuse": False, "starts": 0}

    def popen(process_obj):
        state["starts"] += 1
        if state["refuse"] or (after is not None and state["starts"] > after):
            raise OSError(errno.EAGAIN, "Resource temporarily unavailable (test: the process limit)")
        return real(process_obj)

    monkeypatch.setattr(SpawnProcess, "_Popen", staticmethod(popen))
    return state


def _process_starts_counted(monkeypatch) -> dict:
    """Counts multiprocessing's spawn process starts (each worker process a Pool starts, or starts
    to replace one that died): state["n"]; state["seen"] is set at each one."""
    real = SpawnProcess._Popen
    state = {"n": 0, "seen": threading.Event()}

    def popen(process_obj):
        state["n"] += 1
        state["seen"].set()
        return real(process_obj)

    monkeypatch.setattr(SpawnProcess, "_Popen", staticmethod(popen))
    return state


def _ready(monkeypatch) -> dict:
    """The solver's GET /ready, as the web's /api/health reads it."""
    import main

    monkeypatch.setattr(main, "SOLVER_TOKEN", TOKEN)
    r = TestClient(main.app).get("/ready", headers={"X-Solver-Token": TOKEN})
    assert r.status_code == 200, r.text
    return r.json()


def _pools_made(monkeypatch) -> list:
    """Every _Workers made from now on (to check that its processes and threads all stopped)."""
    made: list = []
    real = ds._Workers.__init__

    def init(self, *a, **k):
        made.append(self)
        real(self, *a, **k)

    monkeypatch.setattr(ds._Workers, "__init__", init)
    return made


def _all_stopped(made: list) -> None:
    """Each pool was really cleaned up, not just given up on: closed and released (it holds no Pool
    any more, CI PR #50), no worker process alive in this process, and no Pool helper thread left."""
    import multiprocessing as mp

    for w in made:
        assert w.closed and w.pool is None
    assert mp.active_children() == []
    assert [t.name for t in threading.enumerate() if t.is_alive() and "_handle_" in t.name] == []


def _kill_a_worker_during_recommended(monkeypatch, which: str, before_kill=None) -> dict:
    """While RECOMMENDED searches in one of the pool's two worker processes, kill (as the
    out-of-memory killer would) RECOMMENDED's own worker ("busy") or the other one ("idle": it
    waits for a task holding the task queue's read lock). The killer learns which process runs
    RECOMMENDED from the pool's start reports (a blocking read, shared with the solve's own reads
    under one lock). Returns {"pid", "at"} once it has killed."""
    real_submit = ds._Workers.submit
    real_started = ds._Workers.started
    beacon = threading.Lock()
    done: dict = {}

    def started(self):
        with beacon:
            return real_started(self)

    def kill(w, token):
        with beacon:
            while token not in w._pid_of:  # blocks until the next task reports its start
                tok, pid = w._beacon.get()
                w._pid_of[tok] = pid
        rec_pid = w._pid_of[token]
        time.sleep(1.0)  # RECOMMENDED is searching
        victim = next(p for p in list(w.pool._pool) if (p.pid == rec_pid) == (which == "busy"))
        if before_kill is not None:
            before_kill()
        victim.kill()
        done.update(pid=victim.pid, at=time.monotonic())

    def submit(self, fn, arg, name):
        token, fut = real_submit(self, fn, arg, name)
        if name == "RECOMMENDED" and not done:
            threading.Thread(target=kill, args=(self, token), daemon=True).start()
        return token, fut

    monkeypatch.setattr(ds._Workers, "started", started)
    monkeypatch.setattr(ds._Workers, "submit", submit)
    return done


def _within(seconds: float, fn) -> dict:
    """fn() in a thread: {"value" | "error", "at"} (when it returned), or a failed test when it has
    not returned after ``seconds`` - the hang these tests catch (the thread is then left behind)."""
    out: dict = {}

    def run():
        try:
            out["value"] = fn()
        except BaseException as exc:  # noqa: BLE001
            out["error"] = exc
        out["at"] = time.monotonic()

    t = threading.Thread(target=run, daemon=True)
    t.start()
    t.join(seconds)
    if t.is_alive():
        pytest.fail(f"no answer within {seconds:g} s: it hangs")
    return out


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


@pytest.mark.filterwarnings("ignore::pytest.PytestUnhandledThreadExceptionWarning")
def test_workers_that_die_while_starting_with_no_replacement_refuse_within_seconds(monkeypatch, caplog):
    """(review) The out-of-memory / process-limit case itself: the pool's two processes die while
    starting, and no replacement can start (OSError EAGAIN), so Pool's worker-handler thread dies.
    Closing that pool used to wait forever (its task handler never got the stop sentinel): no 503,
    no ERROR line, the slot held for good. Now: refused at once - the dead worker handler is seen,
    long before the start wait runs out (20 s here, so the two cannot be confused) - the
    administrator alerted, and the pool really cleaned up."""
    monkeypatch.setenv("ROUTEIQ_TEST_WORKER_START_EXIT", "1")
    monkeypatch.setenv("SOLVER_WORKER_START_SEC", "20")
    _process_starts_refused(monkeypatch, after=2)  # the pool's two processes start; no replacement can
    pools = _pools_made(monkeypatch)
    ran = _no_search_here(monkeypatch)
    caplog.set_level(logging.WARNING, logger="routeiq.dispatch")
    t0 = time.monotonic()
    out = _within(60, lambda: optimize_dispatch(_day(search_mode="THOROUGH", max_search_sec=1200)))
    assert isinstance(out.get("error"), WorkersUnavailable), out
    assert out["at"] - t0 < 10, out["at"] - t0  # about 2 s; the start wait would be 20 s
    assert ran == []
    assert ds.WORKER_HEALTH.status()["status"] == "failed"
    errors = [r.getMessage() for r in caplog.records if r.levelno == logging.ERROR]
    assert len(errors) == 1 and errors[0].startswith("WORKERS_UNAVAILABLE run=r:"), errors
    assert len(pools) == 1
    _all_stopped(pools)


# --------------------------------------------------------------------------------------
# The pool dies during a solve (rule 22: "the process pool fails to start or dies")
# --------------------------------------------------------------------------------------

@pytest.mark.filterwarnings("ignore::pytest.PytestUnhandledThreadExceptionWarning")
def test_recommended_worker_killed_with_no_replacement_answers_503_within_seconds(monkeypatch, caplog):
    """(review) RECOMMENDED searches in worker A. A is killed (the out-of-memory killer picks the
    biggest process) and the pool cannot start a replacement (the process limit), so its
    worker-handler thread dies. The lost plan was noticed, but closing the pool then waited
    forever (its idle sibling held the task queue's lock and was never told to stop): no answer,
    the slot and the running entry held for good, /ready still ok. Now: 503 WORKERS_UNAVAILABLE
    within seconds of the kill, the slot back, /ready failed, every worker process stopped."""
    import main

    monkeypatch.setattr(main, "SOLVER_TOKEN", TOKEN)
    monkeypatch.setattr(main, "_DISPATCH_SLOTS", threading.BoundedSemaphore(1))
    monkeypatch.delenv("OSRM_URL", raising=False)
    starts = _process_starts_refused(monkeypatch)
    killed = _kill_a_worker_during_recommended(monkeypatch, "busy", before_kill=lambda: starts.update(refuse=True))
    pools = _pools_made(monkeypatch)
    caplog.set_level(logging.WARNING)
    client = TestClient(main.app)
    headers = {"X-Solver-Token": TOKEN}
    body = _day(time_limit_sec=8).model_dump(mode="json")

    out = _within(60, lambda: client.post("/optimize-dispatch", json=body, headers=headers))
    r = out["value"]
    assert killed, "the worker was never killed"
    assert out["at"] - killed["at"] < 10, out["at"] - killed["at"]
    assert r.status_code == 503, r.text
    assert r.json() == {"detail": PLANNER_UNAVAILABLE_MSG, "code": "WORKERS_UNAVAILABLE"}
    assert r.headers["retry-after"] == "60"
    assert main._DISPATCH_SLOTS._value == 1 and main._RUNNING == {}
    ready = client.get("/ready", headers=headers).json()
    assert ready["ok"] is False and ready["workers"]["status"] == "failed"
    alerts = [m.getMessage() for m in caplog.records if m.levelno == logging.ERROR and m.name == "routeiq.dispatch"]
    assert any(a.startswith("WORKERS_UNAVAILABLE run=r:") for a in alerts), alerts
    _all_stopped(pools)


def test_idle_worker_killed_during_recommended_keeps_the_plan_within_seconds(monkeypatch, caplog):
    """(review) RECOMMENDED searches in worker A; the idle worker B, waiting for a task and holding
    the task queue's read lock, is killed. The pool starts a replacement, but no worker can take a
    task again: RECOMMENDED finished, the alternatives never started, and closing the pool then
    waited forever - the finished plan never came back. Now the stuck pool is noticed within
    SOLVER_WORKER_START_SEC (not at the alternatives' deadline), the alternatives are skipped, the
    load re-check gets fresh workers, and the recommended plan comes back re-checked.

    The administrator is still told (second review): the ERROR line, and /ready failed after the
    solve. The load re-check's fresh pool starts seconds after the alert and used to clear /ready
    at once, so monitoring polling the web's /api/health never saw the pool that broke."""
    monkeypatch.setenv("SOLVER_WORKER_START_SEC", "3")
    monkeypatch.setenv("SOLVER_ALT_GRACE_SEC", "120")  # the alternatives' own deadline is minutes away
    killed = _kill_a_worker_during_recommended(monkeypatch, "idle")
    pools = _pools_made(monkeypatch)
    caplog.set_level(logging.WARNING, logger="routeiq.dispatch")
    r = _day(time_limit_sec=6)

    out = _within(120, lambda: optimize_dispatch(r))
    assert killed, "the worker was never killed"
    assert "value" in out, out.get("error")
    assert out["at"] - killed["at"] < 60, out["at"] - killed["at"]
    resp = out["value"]
    sc = rec(resp)
    assert sc.status == "OPTIMIZED"
    assert_reconciled(r, sc)
    assert [s.name for s in resp.scenarios] == ["RECOMMENDED"]
    assert any("MIN_TRUCKS, MIN_DISTANCE were skipped" in w for w in sc.warnings), sc.warnings
    assert not any("not re-checked" in w for w in sc.warnings), sc.warnings  # the fresh workers re-checked it
    assert len(pools) == 2  # the stuck one, and the load re-check's
    _all_stopped(pools)
    alerts = [m.getMessage() for m in caplog.records if m.levelno == logging.ERROR]
    assert len(alerts) == 1 and alerts[0].startswith(
        "WORKERS_UNAVAILABLE run=r: the solver's worker processes stopped working during the search"), alerts
    assert ds.WORKER_HEALTH.status()["status"] == "failed"
    ready = _ready(monkeypatch)
    assert ready["ok"] is False and ready["workers"]["status"] == "failed", ready


@pytest.mark.filterwarnings("ignore::pytest.PytestUnhandledThreadExceptionWarning")
def test_a_pool_killed_during_the_road_matrix_refuses_a_thorough_plan_within_seconds(monkeypatch, caplog):
    """(review) The pool starts before the road matrix, which may take up to 90 s, and every worker
    is idle meanwhile. Killed then (one of them held the task queue's read lock), the pool starts
    replacements that can never take a task: RECOMMENDED waited for its deadline - for a thorough
    plan the whole 20-minute cap - and got a misleading 504. Now: WorkersUnavailable (503) within
    SOLVER_WORKER_START_SEC of the search's start."""
    monkeypatch.setenv("SOLVER_WORKER_START_SEC", "3")
    pools = _pools_made(monkeypatch)
    real_matrix = ds.resolve_matrix
    searched: dict = {}

    def matrix(*a, **k):
        for w in pools:
            procs = list(w.pool._pool)
            for p in procs:
                p.kill()
            for p in procs:
                p.join(10)
        searched["at"] = time.monotonic()
        return real_matrix(*a, **k)

    monkeypatch.setattr(ds, "resolve_matrix", matrix)
    caplog.set_level(logging.WARNING, logger="routeiq.dispatch")
    out = _within(90, lambda: optimize_dispatch(_day(search_mode="THOROUGH", max_search_sec=1200)))
    assert isinstance(out.get("error"), WorkersUnavailable), out
    assert out["at"] - searched["at"] < 3 + 12, out["at"] - searched["at"]
    assert ds.WORKER_HEALTH.status()["status"] == "failed"
    assert any(m.getMessage().startswith("WORKERS_UNAVAILABLE run=r:") for m in caplog.records if m.levelno == logging.ERROR)
    _all_stopped(pools)


def _take_and_die(lock) -> None:
    lock.acquire()
    import os

    os._exit(0)


def test_a_queue_lock_left_held_by_a_dead_process_is_given_back():
    """What lets close() finish after killing the workers: a multiprocessing lock (a semaphore, no
    owner) that a killed process held stays held for good; _free_lock_of_dead gives it back, and
    leaves a free lock free."""
    import multiprocessing as mp

    ctx = mp.get_context("spawn")
    lock = ctx.Lock()
    ds._free_lock_of_dead(lock)  # free: stays free
    assert lock.acquire(False)
    lock.release()
    p = ctx.Process(target=_take_and_die, args=(lock,))
    p.start()
    p.join(60)
    assert p.exitcode == 0
    assert not lock.acquire(False)  # held by a dead process
    ds._free_lock_of_dead(lock)
    assert lock.acquire(False)
    lock.release()
    ds._free_lock_of_dead(None)  # Windows' result queue has no write lock


def test_closing_a_pool_is_bounded_and_alerts_when_its_cleanup_hangs(monkeypatch, caplog):
    """Whatever else stops Pool.terminate() from finishing, the request thread waits at most
    POOL_CLOSE_SEC for it: the answer is not held back, and the administrator gets the ERROR line
    and /ready failed. The cleanup goes on in the background."""
    monkeypatch.setattr(ds, "POOL_CLOSE_SEC", 1.0)
    caplog.set_level(logging.WARNING, logger="routeiq.dispatch")
    w = ds._Workers(1, run_id="r")
    real_terminate = w.pool.terminate
    release = threading.Event()
    w.pool.terminate = lambda: release.wait(60) and real_terminate()
    try:
        t0 = time.perf_counter()
        assert w.close() is False
        assert time.perf_counter() - t0 < 5
        errors = [m.getMessage() for m in caplog.records if m.levelno == logging.ERROR]
        assert len(errors) == 1 and errors[0].startswith("WORKERS_UNAVAILABLE run=r:") and "did not stop" in errors[0], errors
        assert ds.WORKER_HEALTH.status()["status"] == "failed"
        w.close()  # a second call does nothing: no wait, no second alert
        assert time.perf_counter() - t0 < 5
        assert len([m for m in caplog.records if m.levelno == logging.ERROR]) == 1
    finally:
        release.set()
    for t in threading.enumerate():
        if t.name == "routeiq-pool-close":
            t.join(10)
    _all_stopped([w])


def test_a_pool_that_starts_soon_after_a_failure_does_not_clear_the_alert(monkeypatch, caplog):
    """(second review) A pool did not close in time: the ERROR line and /ready failed. A second
    later the next pool starts fine - this solve's load re-check, or another company's solve - and
    that start used to clear /ready at once, so monitoring polling the web's /api/health every few
    minutes never saw the failure. It stays reported for at least WORKER_ALERT_MIN_SEC (5 minutes)
    whatever pools start meanwhile; only a pool that starts after that clears it before
    WORKER_ALERT_SEC."""
    monkeypatch.setattr(ds, "POOL_CLOSE_SEC", 1.0)
    caplog.set_level(logging.WARNING, logger="routeiq.dispatch")
    w = ds._Workers(1, run_id="r")
    real_terminate = w.pool.terminate
    release = threading.Event()
    w.pool.terminate = lambda: release.wait(60) and real_terminate()
    try:
        assert w.close() is False
    finally:
        release.set()
    fresh = ds._start_workers(1, None, "r", "load re-check")
    assert fresh is not None and fresh.close() is True
    errors = [m.getMessage() for m in caplog.records if m.levelno == logging.ERROR]
    assert len(errors) == 1 and "did not stop within 1 s" in errors[0], errors
    assert ds.WORKER_HEALTH.status()["status"] == "failed"
    ready = _ready(monkeypatch)
    assert ready["ok"] is False and ready["workers"]["status"] == "failed", ready
    assert ready["workers"]["cause"] == "Pool.terminate() did not return"

    # Past the minimum window (made 0 here), a pool that starts is a recovery: /ready is ok again.
    assert ds.WORKER_ALERT_MIN_SEC == 300
    monkeypatch.setattr(ds, "WORKER_ALERT_MIN_SEC", 0)
    later = ds._start_workers(1, None, "r2", "search")
    assert later is not None and later.close() is True
    assert ds.WORKER_HEALTH.status() == {"status": "ok"}
    assert _ready(monkeypatch)["ok"] is True
    for t in threading.enumerate():
        if t.name == "routeiq-pool-close":
            t.join(10)
    _all_stopped([w, fresh, later])


def test_closing_a_pool_starts_no_replacement_process(monkeypatch):
    """(second review) close() first tells Pool's worker handler to stop, then kills the worker
    processes. In the other order the handler replaces each worker as it is killed: a new process
    started at the end of every solve, and - in the out-of-memory or process-limit case rule 22 is
    for - more attempts to start processes while cleaning up. Checked on a healthy pool, and on one
    whose idle worker was killed (the handler replaced it; the replacement must not be replaced)."""
    starts = _process_starts_counted(monkeypatch)
    w = ds._start_workers(2, None, "r", "search")
    assert w is not None and starts["n"] == 2
    starts["n"] = 0
    assert w.close() is True
    assert starts["n"] == 0, f"{starts['n']} replacement process(es) started while the pool was being closed"
    _all_stopped([w])

    broken = ds._start_workers(2, None, "r", "search")
    assert broken is not None
    starts["seen"].clear()
    victim = broken.pool._pool[0]
    victim.kill()
    victim.join(10)
    assert starts["seen"].wait(15), "the pool never replaced its killed worker"
    starts["n"] = 0
    assert broken.close() is True
    assert starts["n"] == 0, f"{starts['n']} replacement process(es) started while the pool was being closed"
    _all_stopped([broken])


def test_a_task_queued_behind_a_busy_worker_is_not_a_broken_pool(monkeypatch, caplog):
    """(second review) _await_all calls a pool broken when a task has waited to start for
    SOLVER_WORKER_START_SEC while a worker was free - never while every worker is busy (busy()).
    That is common in production: RECOMMENDED + MIN_TRUCKS get a 1-worker pool and two load
    re-check jobs, and a THOROUGH re-check job can run 30 s, the default start wait. Here: a
    1-worker pool, a 1 s start wait, a 4 s task and a quick one queued behind it. Both finish, and
    nobody is alerted."""
    caplog.set_level(logging.WARNING, logger="routeiq.dispatch")
    w = ds._start_workers(1, None, "r", "load re-check")  # started with the default wait (a cold start)
    assert w is not None
    monkeypatch.setenv("SOLVER_WORKER_START_SEC", "1")
    try:
        jobs = {"slow": w.submit(time.sleep, 4, "slow"), "quick": w.submit(ds._ping, None, "quick")}
        t0 = time.monotonic()
        out = ds._await_all(w, jobs, t0 + 30)
    finally:
        assert w.close() is True
    assert out["slow"] == ("ok", None), out
    assert out["quick"][0] == "ok", out
    assert time.monotonic() - t0 < 25
    assert [m.getMessage() for m in caplog.records if m.levelno >= logging.ERROR] == []
    assert ds.WORKER_HEALTH.status() == {"status": "ok"}
    _all_stopped([w])


def test_the_alert_is_written_before_the_failed_pool_is_closed(monkeypatch, caplog):
    """(second review) A pool that did not start: _start_workers writes the ERROR line and /ready's
    failed status before it closes that pool, so the alert exists even when closing misbehaves
    (closing can take about 15 s: its own waits plus POOL_CLOSE_SEC)."""
    monkeypatch.setenv("ROUTEIQ_TEST_WORKER_START_EXIT", "1")
    monkeypatch.setenv("SOLVER_WORKER_START_SEC", "2")
    caplog.set_level(logging.WARNING, logger="routeiq.dispatch")
    pools = _pools_made(monkeypatch)
    seen: list = []
    real_close = ds._Workers.close

    def close(self):
        alerted = any(m.levelno == logging.ERROR and m.getMessage().startswith("WORKERS_UNAVAILABLE run=r:")
                      for m in caplog.records)
        seen.append((ds.WORKER_HEALTH.status()["status"], alerted))
        return real_close(self)

    monkeypatch.setattr(ds._Workers, "close", close)
    with pytest.raises(WorkersUnavailable):
        ds._start_workers(2, None, "r", "search")
    assert seen == [("failed", True)], seen
    _all_stopped(pools)


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
    # The dispatcher's note in plain words (review: "worker processes" is not); the cause is logged.
    assert any("Loads were not re-checked for fewer trucks (the planner was short of resources)" in w
               for w in sc.warnings), sc.warnings
    assert not any("worker process" in w for w in sc.warnings), sc.warnings
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
    """/ready's failed status lasts WORKER_ALERT_SEC (15 minutes) after the last failure, or until a
    pool starts WORKER_ALERT_MIN_SEC (5 minutes) or more after it (second review: a pool that starts
    within those 5 minutes clears nothing)."""
    ds.WORKER_HEALTH.failed("OSError: test")
    s = ds.WORKER_HEALTH.status()
    assert s["status"] == "failed" and s["cause"] == "OSError: test" and s["failed_at"]
    ds.WORKER_HEALTH.started()  # a pool started seconds later: still reported
    assert ds.WORKER_HEALTH.status()["status"] == "failed"
    monkeypatch.setattr(ds, "WORKER_ALERT_SEC", 0)
    assert ds.WORKER_HEALTH.status() == {"status": "ok"}
    monkeypatch.setattr(ds, "WORKER_ALERT_SEC", 900)
    assert ds.WORKER_HEALTH.status()["status"] == "failed"
    monkeypatch.setattr(ds, "WORKER_ALERT_MIN_SEC", 0)  # the minimum window is over
    ds.WORKER_HEALTH.started()  # a pool started again
    assert ds.WORKER_HEALTH.status() == {"status": "ok"}
    ds.WORKER_HEALTH.failed("OSError: again")
    ds.WORKER_HEALTH.reset()  # tests start from a clean state
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

    # The processes can start again (the solver recovered): the dispatcher's retry works. /ready
    # still reports the failure a few seconds old (second review: it stays for WORKER_ALERT_MIN_SEC,
    # so monitoring sees it) ...
    state["fail"] = False
    again = client.post("/optimize-dispatch", json=body, headers=headers)
    assert again.status_code == 200, again.text
    assert again.json()["scenarios"][0]["status"] == "OPTIMIZED"
    ready = client.get("/ready", headers=headers).json()
    assert ready["ok"] is False and ready["workers"]["status"] == "failed"
    # ... and an optimization that starts its processes after that window clears it.
    monkeypatch.setattr(ds, "WORKER_ALERT_MIN_SEC", 0)
    assert client.post("/optimize-dispatch", json=body, headers=headers).status_code == 200
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


_RAILWAY_VARS = ("RAILWAY_ENVIRONMENT_ID", "RAILWAY_PROJECT_ID", "RAILWAY_ENVIRONMENT_NAME", "RAILWAY_ENVIRONMENT")


def test_startup_warnings_are_logged_an_error_on_railway(monkeypatch, caplog):
    """(review) The startup line is the only guard against SOLVER_ALLOW_INPROCESS_FALLBACK=1 (or
    SOLVER_PARALLEL=0) on a deployed solver, and the Railway doc's "verify after the deploy" step
    reads it: it must be logged, as an ERROR on Railway and a WARNING elsewhere - not only worded."""
    import main

    for k in _RAILWAY_VARS + ("SOLVER_PARALLEL", "SOLVER_ALLOW_INPROCESS_FALLBACK"):
        monkeypatch.delenv(k, raising=False)
    caplog.set_level(logging.DEBUG, logger="routeiq.api")

    def logged() -> list[tuple[int, str]]:
        caplog.clear()
        main.log_startup_warnings()
        return [(m.levelno, m.getMessage()) for m in caplog.records if m.name == "routeiq.api"]

    assert logged() == []
    monkeypatch.setenv("SOLVER_ALLOW_INPROCESS_FALLBACK", "1")
    [(level, text)] = logged()
    assert level == logging.WARNING and text.startswith("SOLVER_ALLOW_INPROCESS_FALLBACK=1 is set outside a deployment")
    monkeypatch.setenv("RAILWAY_ENVIRONMENT_NAME", "production")
    [(level, text)] = logged()
    assert level == logging.ERROR and text.startswith("SOLVER_ALLOW_INPROCESS_FALLBACK=1 is set on Railway (production)")
    monkeypatch.setenv("SOLVER_PARALLEL", "0")
    assert [(lv, t.split(" is set")[0]) for lv, t in logged()] == [
        (logging.ERROR, "SOLVER_PARALLEL=0"), (logging.ERROR, "SOLVER_ALLOW_INPROCESS_FALLBACK=1")]
    monkeypatch.delenv("SOLVER_ALLOW_INPROCESS_FALLBACK")
    monkeypatch.delenv("RAILWAY_ENVIRONMENT_NAME")
    [(level, text)] = logged()
    assert level == logging.WARNING and text.startswith("SOLVER_PARALLEL=0 is set outside a deployment")


def test_the_solver_logs_its_startup_warnings_when_it_starts(monkeypatch):
    """main.py runs log_startup_warnings() when it is imported (uvicorn's start): a fresh process
    with the fallback set on Railway writes the ERROR line to its log."""
    import os
    import subprocess
    import sys

    env = {k: v for k, v in os.environ.items() if k not in _RAILWAY_VARS + ("SOLVER_PARALLEL",)}
    env.update(SOLVER_ALLOW_INPROCESS_FALLBACK="1", RAILWAY_ENVIRONMENT_NAME="production")
    solver_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    done = subprocess.run([sys.executable, "-c", "import main"], cwd=solver_dir, env=env, capture_output=True,
                          text=True, timeout=120)
    assert done.returncode == 0, done.stderr
    lines = [ln for ln in done.stderr.splitlines() if "SOLVER_ALLOW_INPROCESS_FALLBACK=1 is set" in ln]
    assert len(lines) == 1 and " ERROR routeiq.api: SOLVER_ALLOW_INPROCESS_FALLBACK=1 is set on Railway" in lines[0], done.stderr
