"""Worker processes leave nothing behind (GitHub CI, PR #50, 30 Sep 2026).

CI crashed the solver API with "Fatal Python error: Segmentation fault" while the garbage collector
ran in the event-loop thread (a solve's thread was waiting for RECOMMENDED), and the resource tracker
then reported ~41 leaked semaphores. Every multiprocessing object a solve makes - worker pools, their
queues, locks and events, worker processes, pipes - is now closed and released by the solve itself
before optimize_dispatch returns or raises, on every path: nothing is left for the garbage collector
(which may run in any thread, the event loop's included), nor held by a long-lived structure (the
solve's control, multiprocessing's own list of child processes).

How it is checked: the garbage collector is off during the solve, so anything only it would free - an
object in a reference cycle - is still there afterwards, like anything still referenced."""
from __future__ import annotations

import gc
import multiprocessing as mp
import multiprocessing.connection as mpc
import multiprocessing.pool as mpp
import multiprocessing.process as mpproc
import multiprocessing.queues as mpq
import multiprocessing.synchronize as mps
import os
import subprocess
import sys
import textwrap
import threading
import time

import pytest

import dispatch_solver as ds
import pyvrp_candidate as PV
from tests.test_dispatch import nmwc_day, req

SOLVER_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ALL3 = ["RECOMMENDED", "MIN_TRUCKS", "MIN_DISTANCE"]
MP_TYPES = (mpp.Pool, mpp.ApplyResult, mpproc.BaseProcess, mpc._ConnectionBase, mpq.SimpleQueue, mps.SemLock,
            mps.Event, mps.Condition)


@pytest.fixture(autouse=True)
def _production_with_the_second_search(monkeypatch):
    """Production settings (worker processes, no in-process fallback) with PyVRP on."""
    monkeypatch.delenv("SOLVER_PARALLEL", raising=False)
    monkeypatch.delenv("SOLVER_ALLOW_INPROCESS_FALLBACK", raising=False)
    monkeypatch.delenv("SOLVER_WORKER_START_SEC", raising=False)
    monkeypatch.setenv("SOLVER_PYVRP", "on")
    monkeypatch.setenv("SOLVER_PYVRP_STOP_GRACE_SEC", "3")
    monkeypatch.setattr(PV, "effective_cpus", lambda: 4)


def _mp_objects() -> list:
    """Every multiprocessing object alive in this process (the main process object aside)."""
    me = mp.current_process()
    return [o for o in gc.get_objects() if isinstance(o, MP_TYPES) and o is not me]


def _pool_threads() -> list[str]:
    """Threads of a worker pool or of its cleanup that are still running."""
    return [t.name for t in threading.enumerate()
            if t.is_alive() and ("_handle_" in t.name or t.name.startswith("routeiq-"))]


def _run(fn) -> tuple[object, list, list]:
    """fn() with the garbage collector off: (its result, or its exception - kept with its traceback,
    whose frames must hold nothing either), the multiprocessing objects it left alive, and what a
    garbage collection then finds of them."""
    gc.collect()
    before = _mp_objects()
    known = {id(o) for o in before}
    gc.disable()
    try:
        try:
            out = fn()
        except Exception as exc:  # noqa: BLE001 - returned to the test
            out = exc
        left = [o for o in _mp_objects() if id(o) not in known]
    finally:
        gc.enable()
    gc.set_debug(gc.DEBUG_SAVEALL)
    try:
        gc.collect()
        garbage = [o for o in gc.garbage if isinstance(o, MP_TYPES)]
    finally:
        gc.set_debug(0)
        gc.garbage.clear()
    return out, left, garbage


def _names(objs: list) -> list[str]:
    return sorted(type(o).__name__ for o in objs)


# Every way a solve ends: (env, config, what it raises, a control action after N seconds). The test's
# parametrize list names each one (a literal: the handbook's test count reads it).
PATHS = {
    "normal": ({}, dict(scenarios=ALL3), None, None),
    "stall": ({"THOROUGH_STALL_SEC": "0.5", "SOLVER_PYVRP_STALL_SEC": "1"},
              dict(scenarios=["RECOMMENDED"], search_mode="THOROUGH", max_search_sec=60), None, None),
    "stop_request": ({}, dict(scenarios=ALL3, search_mode="THOROUGH", max_search_sec=120), None, ("request_stop", 4.0)),
    "cancel": ({}, dict(scenarios=ALL3, time_limit_sec=30), ds.SolveAborted, ("cancel", 3.0)),
    "second_search_killed": ({"ROUTEIQ_TEST_KILL_PYVRP": "1"}, dict(scenarios=ALL3), None, None),
    "second_search_stage_killed": ({"ROUTEIQ_TEST_KILL_PYVRP_STAGE": "1"}, dict(scenarios=ALL3), None, None),
    "second_search_deadline": ({"ROUTEIQ_TEST_HANG_PYVRP": "1"}, dict(scenarios=ALL3), None, None),
    "second_search_fails": ({"ROUTEIQ_TEST_FAIL_PYVRP": "1"}, dict(scenarios=ALL3), None, None),
    "alternative_worker_killed": ({"ROUTEIQ_TEST_KILL_SCENARIO": "MIN_TRUCKS"}, dict(scenarios=ALL3), None, None),
    "alternative_deadline": ({"ROUTEIQ_TEST_HANG_SCENARIO": "MIN_DISTANCE", "SOLVER_ALT_GRACE_SEC": "3"},
                             dict(scenarios=ALL3), None, None),
    "recommended_worker_killed": ({"ROUTEIQ_TEST_KILL_SCENARIO": "RECOMMENDED"}, dict(scenarios=ALL3), ds.SolveAborted, None),
    "rule22_refused": ({"ROUTEIQ_TEST_WORKER_START_EXIT": "1", "SOLVER_WORKER_START_SEC": "3"}, dict(scenarios=ALL3),
                       ds.WorkersUnavailable, None),
}


@pytest.mark.parametrize("path", ["normal", "stall", "stop_request", "cancel", "second_search_killed", "second_search_stage_killed", "second_search_deadline", "second_search_fails", "alternative_worker_killed", "alternative_deadline", "recommended_worker_killed", "rule22_refused"])  # noqa: E501 - one line: the handbook guard sizes it
def test_a_solve_releases_every_process_pipe_and_lock_itself(path, monkeypatch):
    """Normal end, THOROUGH stall, stop request, cancel, a worker killed (the second search's, its
    load re-check's, an alternative's, RECOMMENDED's), a deadline (the second search's, an
    alternative's), a failure, rule 22's refusal: after optimize_dispatch returns or raises, no
    multiprocessing object of the solve is alive, the garbage collector finds none, no child process
    and no pool thread is left, and the solve's control keeps no flag."""
    env, cfg, raises, action = PATHS[path]
    for k, v in env.items():
        monkeypatch.setenv(k, v)
    control = ds.SolveControl()
    timer = None
    if action is not None:
        timer = threading.Timer(action[1], getattr(control, action[0]), args=("test",) if action[0] == "cancel" else ())
        timer.start()
    r = req(*nmwc_day(20), **{"time_limit_sec": 2, **cfg})
    try:
        out, left, garbage = _run(lambda: ds.optimize_dispatch(r, control=control))
    finally:
        if timer is not None:
            timer.cancel()
            timer.join(10)
    if raises is None:
        assert not isinstance(out, BaseException), repr(out)
    else:
        assert isinstance(out, raises), repr(out)
    assert _names(left) == [], f"left alive after the solve (only the garbage collector could free them): {_names(left)}"
    assert _names(garbage) == [], f"freed only by the garbage collector: {_names(garbage)}"
    assert mp.active_children() == []
    assert _pool_threads() == []
    assert control._flags == []  # no pool's or process's flag outlives it in the solve's control


def _open_handles() -> int | None:
    """Open file descriptors (POSIX) or handles (Windows) of this process."""
    if sys.platform == "win32":
        import ctypes

        count = ctypes.c_ulong()
        k32 = ctypes.windll.kernel32
        return count.value if k32.GetProcessHandleCount(k32.GetCurrentProcess(), ctypes.byref(count)) else None
    for d in ("/proc/self/fd", "/dev/fd"):
        if os.path.isdir(d):
            return len(os.listdir(d))
    return None


def test_thirty_small_solves_leave_no_process_and_no_open_handle(monkeypatch):
    """A loop of 30 small solves with the second search on: after each one no child process is left,
    and the process's open file descriptors / handles do not grow (a pool or a process per solve that
    kept its pipes open would add at least 6 each time: 180)."""
    monkeypatch.setenv("SOLVER_PYVRP_MAX_ITERS", "300")
    r = req(*nmwc_day(8), scenarios=["RECOMMENDED"], time_limit_sec=1)
    for _ in range(2):  # warm up: imports, the resource tracker, logging
        ds.optimize_dispatch(r)
    gc.collect()
    base_handles, base_objects = _open_handles(), len(_mp_objects())
    for i in range(30):
        resp = ds.optimize_dispatch(r)
        assert resp.search.pyvrp.status in ("CHOSEN", "NOT_CHOSEN"), (i, resp.search.pyvrp)
        assert mp.active_children() == [], i
    gc.collect()
    assert len(_mp_objects()) == base_objects
    assert _pool_threads() == []
    if base_handles is not None:
        grown = _open_handles() - base_handles
        assert grown <= 8, f"{grown} more open handles after 30 solves"


def _plain(value, where: str = "answer") -> None:
    """Only plain Python data (and load_repack's own dataclasses of it): no numpy, OR-Tools or PyVRP
    object ever reaches the API process from a worker."""
    if value is None or type(value) in (bool, int, float, str):
        return
    if type(value) in (list, tuple):
        for i, v in enumerate(value):
            _plain(v, f"{where}[{i}]")
        return
    if type(value) is dict:
        for k, v in value.items():
            _plain(k, f"{where} key")
            _plain(v, f"{where}[{k!r}]")
        return
    if type(value).__module__ == "load_repack" and hasattr(value, "__dataclass_fields__"):
        for name in value.__dataclass_fields__:
            _plain(getattr(value, name), f"{where}.{name}")
        return
    raise AssertionError(f"{where}: {type(value).__module__}.{type(value).__name__} is not plain data")


def test_the_second_search_process_answers_plain_data_and_is_released():
    """Its own process (one spawn Process, pipes, no pool): the search's answer and the load re-check's
    are plain data; a failure comes back as text (never an exception class of the worker's libraries);
    a killed process is LOST; close() leaves nothing."""
    import load_repack as LR
    from tests.test_pyvrp_candidate import _prepared, _settings

    r = req(*nmwc_day(20), scenarios=["RECOMMENDED"], time_limit_sec=2)
    tds, solvable, _drops, mx = _prepared(r)

    def work():
        proc = ds._PvProcess(None, run_id="r")
        try:
            proc.submit(PV.solve_in_worker, (r, solvable, tds, mx, _settings()))
            kind, result = proc.wait(time.monotonic() + 120, None)
            assert kind == "ok", (kind, result)
            _plain(result)
            plan, why = PV.plan_of(result, tds, solvable)
            assert plan is not None, why
            day = ds._stage_ctx(r, solvable, tds, mx, []).day
            pricing = ds._pricing("RECOMMENDED", r, tds, solvable)
            job = dict(day=day, score_pricing=pricing, plan=plan, gaps={td.idx: ds._approx_gap_s(r.config, td) for td in day.trucks},
                       goals=[("RECOMMENDED", pricing)], optional=None, cap_s=3.0, budget_s=10.0,
                       fit_weights=ds._repair_weights(solvable, set(range(len(solvable))), r.config))
            proc.submit(PV.stage_in_worker, job)
            kind, staged = proc.wait(time.monotonic() + 120, None)
            assert kind == "ok", (kind, staged)
            _plain(staged)
            assert staged[0] and all(isinstance(c, LR.Candidate) for c in staged[0])
            proc.submit(PV.stage_in_worker, {})  # a job that fails in the worker (KeyError)
            kind, text = proc.wait(time.monotonic() + 60, None)
            assert (kind, type(text)) == ("error", str) and text.startswith("KeyError"), (kind, text)
            proc.proc.kill()
            assert proc.wait(time.monotonic() + 30, None) == ("lost", None)
        finally:
            proc.close()
        assert proc.proc is None
        proc.close()  # twice: nothing

    out, left, garbage = _run(work)
    assert out is None, repr(out)
    assert _names(left) == [] and _names(garbage) == []
    assert mp.active_children() == []
    assert _pool_threads() == []


@pytest.mark.skipif(sys.platform == "win32", reason="POSIX: named semaphores and multiprocessing's resource tracker")
def test_the_resource_tracker_finds_no_leaked_semaphore():
    """CI's crash log ended with the resource tracker's "leaked semaphore objects" line. A process that
    ran solves (normal, thorough with a stall, cancelled) and then dies without any exit handler
    (os._exit) must have nothing still registered: every semaphore was released by its solve."""
    code = textwrap.dedent(
        """
        import os, sys, threading
        os.environ.update(SOLVER_PYVRP="on", SOLVER_PYVRP_MIN_CPUS="1", SOLVER_PYVRP_STOP_GRACE_SEC="3",
                          THOROUGH_STALL_SEC="0.5", SOLVER_PYVRP_STALL_SEC="1")
        import multiprocessing as mp
        import dispatch_solver as ds
        from tests.test_dispatch import nmwc_day, req
        ds.optimize_dispatch(req(*nmwc_day(20), scenarios=["RECOMMENDED", "MIN_TRUCKS"], time_limit_sec=2))
        ds.optimize_dispatch(req(*nmwc_day(20), scenarios=["RECOMMENDED"], time_limit_sec=2, search_mode="THOROUGH",
                                 max_search_sec=60))
        control = ds.SolveControl()
        threading.Timer(3.0, control.cancel, args=("test",)).start()
        try:
            ds.optimize_dispatch(req(*nmwc_day(20), scenarios=["RECOMMENDED"], time_limit_sec=30), control=control)
        except ds.SolveAborted as exc:
            kept = exc  # its traceback's frames stay alive
        assert mp.active_children() == []
        print("SOLVES DONE", flush=True)
        sys.stderr.flush()
        os._exit(0)
        """
    )
    r = subprocess.run([sys.executable, "-c", code], cwd=SOLVER_DIR, capture_output=True, text=True, timeout=600)
    assert r.returncode == 0 and "SOLVES DONE" in r.stdout, r.stderr[-3000:]
    assert "leaked" not in r.stderr, r.stderr[-3000:]
