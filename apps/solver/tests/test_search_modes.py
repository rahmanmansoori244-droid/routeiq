"""Search modes (owner request 29 Sep 2026: "make sure the solver is giving an optimal solution even
if it runs for 20 mins"; decision "night plans long, day re-plans quick").

QUICK must behave exactly as before: the same search parameters, limits and budgets, and nothing
attached to the search. THOROUGH searches inside one deadline (the cap), stops once the search stops
improving, reports why it stopped, and can be cancelled (caller gone) or stopped early (use the best
plan found so far)."""
from __future__ import annotations

import socket
import threading
import time

import httpx
import pytest

import dispatch_solver as ds
from dispatch_models import DispatchConfig, SearchReport
from dispatch_solver import SolveAborted, SolveControl, optimize_dispatch
from tests.test_dispatch import assert_reconciled, nmwc_day, rec, req

ALL = ["RECOMMENDED", "MIN_TRUCKS", "MIN_DISTANCE"]


# --------------------------------------------------------------------------------------
# QUICK: unchanged
# --------------------------------------------------------------------------------------

def _pre_change_rec_limit(time_limit: int, left: float) -> int:
    """_run_scenarios' RECOMMENDED limit before search modes existed (3451f4d)."""
    return max(1, min(time_limit, int(left) - ds.REC_OVERHEAD_SEC))


def test_quick_budgets_are_the_ones_from_before():
    for t in [1, 2, 5, 20, 35, 50, 100, 150, 240, 600]:
        for left in [0, 5, 21, 30, 100, 450, 539.9, 540]:
            for n_alts in (0, 1, 2):
                assert ds.rec_limit_sec("QUICK", t, left, n_alts) == _pre_change_rec_limit(t, left), (t, left, n_alts)
        assert ds._repack_cap_sec(t, False) == min(ds.REPACK_CAP_SEC, max(ds.REPACK_MIN_SEC, t / 2))


def test_quick_is_the_default_and_an_older_web_sends_no_mode():
    cfg = DispatchConfig()
    assert cfg.search_mode == "QUICK" and cfg.max_search_sec is None
    assert DispatchConfig.model_validate({"time_limit_sec": 5}).search_mode == "QUICK"
    with pytest.raises(ValueError):
        DispatchConfig(search_mode="FOREVER")
    with pytest.raises(ValueError):
        DispatchConfig(max_search_sec=4000)


def test_quick_search_gets_the_same_parameters_and_nothing_attached(monkeypatch):
    """The OR-Tools search of a QUICK request: PCI + GLS, the automatic limit, no callback and no
    extra monitor (a THOROUGH watch is never built)."""
    monkeypatch.setenv("SOLVER_PARALLEL", "0")
    from ortools.constraint_solver import pywrapcp as real

    seen: list = []

    class Model(real.RoutingModel):
        def AddAtSolutionCallback(self, *a):  # noqa: N802
            seen.append("callback")
            return super().AddAtSolutionCallback(*a)

        def AddSearchMonitor(self, *a):  # noqa: N802
            seen.append("monitor")
            return super().AddSearchMonitor(*a)

        def SolveWithParameters(self, params, *a):  # noqa: N802
            seen.append(("params", params.first_solution_strategy, params.local_search_metaheuristic,
                         params.time_limit.seconds))
            return super().SolveWithParameters(params, *a)

    class Proxy:
        RoutingModel = Model

        def __getattr__(self, item):
            return getattr(real, item)

    monkeypatch.setattr(ds, "pywrapcp", Proxy())
    monkeypatch.setattr(ds, "_SearchWatch", lambda *a, **k: pytest.fail("QUICK built a search watch"))
    stops, trucks = nmwc_day(30)
    resp = optimize_dispatch(req(stops, trucks, time_limit_sec=None))
    from ortools.constraint_solver import routing_enums_pb2 as enums

    assert seen == [("params", enums.FirstSolutionStrategy.PARALLEL_CHEAPEST_INSERTION,
                     enums.LocalSearchMetaheuristic.GUIDED_LOCAL_SEARCH, ds.auto_time_limit(30))]
    s = resp.search
    assert s is not None and s.mode == "QUICK" and s.stop_reason == "TIME_LIMIT"
    assert s.limit_sec == ds.auto_time_limit(30) and s.best_over_time == [] and s.cap_sec == ds.SOLVER_BUDGET_SEC


# --------------------------------------------------------------------------------------
# THOROUGH: budgets
# --------------------------------------------------------------------------------------

def test_thorough_cap_env_is_the_ceiling(monkeypatch):
    monkeypatch.delenv("THOROUGH_MAX_SEC", raising=False)
    assert ds.thorough_cap_sec(DispatchConfig(search_mode="THOROUGH")) == ds.THOROUGH_MAX_SEC == 1200
    assert ds.thorough_cap_sec(DispatchConfig(search_mode="THOROUGH", max_search_sec=300)) == 300
    monkeypatch.setenv("THOROUGH_MAX_SEC", "60")
    assert ds.thorough_cap_sec(DispatchConfig(search_mode="THOROUGH", max_search_sec=1200)) == 60
    monkeypatch.setenv("THOROUGH_MAX_SEC", "nonsense")
    assert ds.thorough_cap_sec(DispatchConfig(search_mode="THOROUGH")) == 1200


def test_thorough_budget_chain_fits_the_cap_and_never_searches_less_than_quick():
    """With the slowest road matrix, RECOMMENDED's limit + its overhead + the tail kept free for the
    alternatives and the load re-check fit the 20-min cap for every day size; RECOMMENDED never gets
    less than QUICK's time (T1), and the tail holds the alternatives' limit and grace and the stage's
    three repack sources and grace."""
    cap = ds.THOROUGH_MAX_SEC
    matrix = ds.matrix_budget_sec(cap)
    for n in range(1, ds.MAX_STOPS + 1):
        t = ds.auto_time_limit(n)
        limit = ds.rec_limit_sec("THOROUGH", t, cap - matrix, 2, cap)
        assert limit == ds.rec_limit_sec("THOROUGH", t, cap - matrix, 2), n  # the 30% bound never binds at 20 min
        tail = ds.thorough_tail_sec(t, 2)
        assert limit >= t, n
        assert matrix + limit + ds.REC_OVERHEAD_SEC + tail <= cap, n
        assert tail >= ds._thorough_alt_sec(t) + ds.ALT_GRACE_SEC + ds._repack_cap_sec(t, True) * 3 + ds.STAGE_GRACE_SEC, n
        # Most of the 20 minutes goes to the recommended plan's search (at least 835 s even with the
        # slowest road matrix and the biggest days' 120 s alternatives).
        assert limit >= 0.69 * cap, (n, limit)
    # A small cap (tests, or a mis-set env): never less than QUICK, never past what is left; the
    # tail is at most 30% of the cap (the alternatives and the re-check get what is left).
    assert ds.rec_limit_sec("THOROUGH", 20, 40, 2, 40) == ds.rec_limit_sec("QUICK", 20, 40, 2) == 20
    assert ds.rec_limit_sec("THOROUGH", 150, 60, 2, 60) == ds.rec_limit_sec("QUICK", 150, 60, 2) == 40
    assert ds.rec_limit_sec("THOROUGH", 2, 118, 0, 120) == 118 - ds.REC_OVERHEAD_SEC - 36


def test_stall_rule():
    r = ds.StallRule(min_sec=20, floor_sec=300, share=0.5)
    assert not r.should_stop(19, 0)  # never before QUICK's time
    assert not r.should_stop(299, 0)
    assert r.should_stop(300, 0)
    # The patience grows with the search: last improved at 8 min -> stop at 16 min, not 13.
    assert not r.should_stop(13 * 60, 8 * 60)
    assert r.should_stop(16 * 60, 8 * 60)
    assert r.stall_sec(100) == 300 and r.stall_sec(1000) == 500


def test_stall_rule_env(monkeypatch):
    monkeypatch.setenv("THOROUGH_STALL_SEC", "7")
    monkeypatch.setenv("THOROUGH_STALL_SHARE", "0.25")
    r = ds.stall_rule(3)
    assert (r.min_sec, r.floor_sec, r.share) == (3, 7, 0.25)
    monkeypatch.setenv("THOROUGH_STALL_SEC", "-1")
    assert ds.stall_rule(3).floor_sec == ds.THOROUGH_STALL_FLOOR_SEC


def test_report_keeps_at_most_twelve_points_first_and_last():
    w = ds._SearchWatch(routing=None, rule=ds.StallRule(1, 1, 0), flag=None)
    w.points = [(float(i), 10_000_000 - i * 1000) for i in range(200)]
    w.last = 199.0
    rep = w.report()
    assert 2 <= len(rep["points"]) <= 12
    assert rep["points"][0] == (0.0, 100.0) and rep["points"][-1] == (199.0, round((10_000_000 - 199_000) / 1e5, 2))
    assert [p[0] for p in rep["points"]] == sorted(p[0] for p in rep["points"])


# --------------------------------------------------------------------------------------
# THOROUGH: end to end
# --------------------------------------------------------------------------------------

@pytest.mark.parametrize("parallel", ["0", "1"])
def test_thorough_stops_once_it_stops_improving(parallel, monkeypatch):
    """A small day converges fast: with a 1 s stall (tests only) the search ends long before its
    limit, says CONVERGED, and the plan is complete and reconciled."""
    monkeypatch.setenv("SOLVER_PARALLEL", parallel)
    monkeypatch.setenv("THOROUGH_MAX_SEC", "120")
    monkeypatch.setenv("THOROUGH_STALL_SEC", "1")
    monkeypatch.setenv("THOROUGH_STALL_SHARE", "0")
    stops, trucks = nmwc_day(12)
    r = req(stops, trucks, time_limit_sec=2, search_mode="THOROUGH")
    t0 = time.perf_counter()
    resp = optimize_dispatch(r)
    s = resp.search
    assert s.mode == "THOROUGH" and s.stop_reason == "CONVERGED", s
    assert s.cap_sec == 120 and s.limit_sec > 20  # the long limit, not QUICK's 2 s ...
    assert s.search_sec < 15, s  # ... yet it stopped once it stopped improving
    assert 1 <= len(s.best_over_time) <= 12 and s.solutions and s.solutions >= len(s.best_over_time)
    assert s.last_improvement_sec is not None and s.stall_sec == 1.0
    assert time.perf_counter() - t0 < 60
    sc = rec(resp)
    assert sc.status == "OPTIMIZED"
    assert_reconciled(r, sc)


def test_thorough_never_stops_before_quicks_time(monkeypatch):
    monkeypatch.setenv("SOLVER_PARALLEL", "0")
    monkeypatch.setenv("THOROUGH_STALL_SEC", "0.5")
    monkeypatch.setenv("THOROUGH_STALL_SHARE", "0")
    stops, trucks = nmwc_day(12)
    resp = optimize_dispatch(req(stops, trucks, time_limit_sec=4, search_mode="THOROUGH"))
    assert resp.search.stop_reason == "CONVERGED"
    assert resp.search.search_sec >= 4 - 0.5, resp.search


def test_thorough_cap_is_honoured_even_when_the_load_recheck_hangs(monkeypatch):
    """One deadline for everything: a load re-check that never returns is cut at the cap, and the
    request answers within it (plus the in-process safety net), with the search's plan re-timed."""
    monkeypatch.delenv("SOLVER_PARALLEL", raising=False)
    monkeypatch.setenv("ROUTEIQ_TEST_HANG_REPACK", "1")
    monkeypatch.setenv("THOROUGH_MAX_SEC", "40")
    stops, trucks = nmwc_day(20)
    r = req(stops, trucks, time_limit_sec=2, search_mode="THOROUGH", scenarios=ALL)
    t0 = time.perf_counter()
    resp = optimize_dispatch(r)
    elapsed = time.perf_counter() - t0
    assert elapsed < 40 + 8, elapsed
    assert resp.search.cap_sec == 40 and resp.search.used_sec <= 40 + 5
    sc = rec(resp)
    assert sc.status == "OPTIMIZED"
    assert any("not re-checked" in w for w in sc.warnings), sc.warnings
    assert_reconciled(r, sc)


def test_thorough_cap_is_honoured_when_an_alternative_hangs(monkeypatch):
    monkeypatch.delenv("SOLVER_PARALLEL", raising=False)
    monkeypatch.setenv("ROUTEIQ_TEST_HANG_SCENARIO", "MIN_TRUCKS")
    monkeypatch.setenv("THOROUGH_MAX_SEC", "150")
    monkeypatch.setenv("THOROUGH_STALL_SEC", "1")
    monkeypatch.setenv("THOROUGH_STALL_SHARE", "0")
    stops, trucks = nmwc_day(20)
    r = req(stops, trucks, time_limit_sec=2, search_mode="THOROUGH", scenarios=ALL)
    t0 = time.perf_counter()
    resp = optimize_dispatch(r)
    assert time.perf_counter() - t0 < 150 + 8
    names = [s.name for s in resp.scenarios]
    assert "RECOMMENDED" in names and "MIN_TRUCKS" not in names
    assert any("skipped" in w for w in rec(resp).warnings)


@pytest.mark.parametrize("parallel", ["0", "1"])
def test_stop_request_returns_the_best_plan_found_so_far(parallel, monkeypatch):
    monkeypatch.setenv("SOLVER_PARALLEL", parallel)
    monkeypatch.setenv("THOROUGH_MAX_SEC", "300")  # would search ~4 min without the stop
    stops, trucks = nmwc_day(40)
    r = req(stops, trucks, time_limit_sec=2, search_mode="THOROUGH", scenarios=ALL)
    control = SolveControl()
    threading.Timer(4.0, control.request_stop).start()
    t0 = time.perf_counter()
    resp = optimize_dispatch(r, control=control)
    elapsed = time.perf_counter() - t0
    assert elapsed < 90, elapsed
    assert resp.search.stop_reason == "STOPPED", resp.search
    assert [s.name for s in resp.scenarios] == ["RECOMMENDED"]
    sc = rec(resp)
    assert sc.status == "OPTIMIZED"
    assert any("stopped early" in w for w in sc.warnings), sc.warnings
    assert_reconciled(r, sc)


def test_stop_is_ignored_by_a_quick_solve(monkeypatch):
    monkeypatch.setenv("SOLVER_PARALLEL", "0")
    stops, trucks = nmwc_day(12)
    control = SolveControl()
    control.request_stop()
    resp = optimize_dispatch(req(stops, trucks, time_limit_sec=2, scenarios=ALL), control=control)
    assert resp.search.stop_reason == "TIME_LIMIT"
    assert [s.name for s in resp.scenarios] == ALL


def test_cancel_aborts_the_solve_and_stops_its_workers(monkeypatch):
    monkeypatch.delenv("SOLVER_PARALLEL", raising=False)
    monkeypatch.setenv("THOROUGH_MAX_SEC", "600")
    stops, trucks = nmwc_day(40)
    r = req(stops, trucks, time_limit_sec=2, search_mode="THOROUGH", scenarios=ALL)
    control = SolveControl()
    threading.Timer(3.0, lambda: control.cancel("test: caller gone")).start()
    t0 = time.perf_counter()
    with pytest.raises(SolveAborted, match="cancelled"):
        optimize_dispatch(r, control=control)
    assert time.perf_counter() - t0 < 20


def test_search_report_is_part_of_the_response_contract():
    s = SearchReport(mode="THOROUGH", cap_sec=1200, limit_sec=985, search_sec=812.4, used_sec=870.2,
                     stop_reason="CONVERGED", last_improvement_sec=406.0, stall_sec=406.2,
                     best_over_time=[(0.5, 900.12), (406.0, 612.5)], solutions=12000)
    assert SearchReport.model_validate(s.model_dump(mode="json")) == s


# --------------------------------------------------------------------------------------
# main.py: the caller going away frees the slot; stop endpoint
# --------------------------------------------------------------------------------------

TOKEN = "unit-test-solver-token"


def _free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def _body(mode: str = "THOROUGH") -> dict:
    stops, trucks = nmwc_day(5)
    return req(stops, trucks, time_limit_sec=2, search_mode=mode).model_dump(mode="json")


@pytest.fixture()
def live_solver(monkeypatch):
    """main.app on a real uvicorn server (a closed connection is only visible over a real socket)."""
    import uvicorn

    import main

    monkeypatch.setattr(main, "SOLVER_TOKEN", TOKEN)
    monkeypatch.setattr(main, "DISCONNECT_POLL_SEC", 0.2)
    monkeypatch.setattr(main, "_DISPATCH_SLOTS", threading.BoundedSemaphore(1))
    port = _free_port()
    server = uvicorn.Server(uvicorn.Config(main.app, host="127.0.0.1", port=port, log_level="warning"))
    th = threading.Thread(target=server.run, daemon=True)
    th.start()
    for _ in range(100):
        if server.started:
            break
        time.sleep(0.05)
    try:
        yield main, f"http://127.0.0.1:{port}"
    finally:
        server.should_exit = True
        th.join(10)


def test_a_caller_that_disconnects_cancels_the_solve_and_frees_the_slot(live_solver, monkeypatch):
    main, url = live_solver
    seen: dict = {}

    def solve_until_cancelled(_req, *, control):
        seen["control"] = control
        assert control.cancelled.wait(20), "the solve was never cancelled"
        raise SolveAborted("cancelled")

    monkeypatch.setattr(main, "optimize_dispatch", solve_until_cancelled)
    with pytest.raises(httpx.TimeoutException):
        httpx.post(f"{url}/optimize-dispatch", json=_body(), headers={"X-Solver-Token": TOKEN}, timeout=1.5)
    # The client gave up and closed its connection: the solve is cancelled, the slot comes back.
    deadline = time.monotonic() + 10
    while time.monotonic() < deadline and not main._DISPATCH_SLOTS.acquire(blocking=False):
        time.sleep(0.1)
    else:
        main._DISPATCH_SLOTS.release()
    assert seen["control"].cancelled.is_set()
    assert "closed the connection" in seen["control"].why
    assert main._RUNNING == {}


def test_stop_endpoint(live_solver, monkeypatch):
    main, url = live_solver
    started = threading.Event()

    def solve_until_stopped(_req, *, control):
        started.set()
        assert control.stop_requested.wait(20), "no stop request arrived"
        raise SolveAborted("test: stopped")

    monkeypatch.setattr(main, "optimize_dispatch", solve_until_stopped)
    body = _body()
    headers = {"X-Solver-Token": TOKEN}
    run = {"run_id": body["run_id"], "tenant_id": body["tenant_id"]}
    assert httpx.post(f"{url}/optimize-dispatch/stop", json=run, headers=headers).status_code == 404
    out: dict = {}
    th = threading.Thread(target=lambda: out.setdefault("r", httpx.post(f"{url}/optimize-dispatch", json=body, headers=headers, timeout=30)))
    th.start()
    assert started.wait(10)
    assert httpx.post(f"{url}/optimize-dispatch/stop", json=run, headers={"X-Solver-Token": "wrong"}).status_code == 401
    assert httpx.post(f"{url}/optimize-dispatch/stop", json={**run, "tenant_id": "other"}, headers=headers).status_code == 404
    res = httpx.post(f"{url}/optimize-dispatch/stop", json=run, headers=headers)
    assert res.status_code == 200 and res.json()["stopping"] is True
    th.join(20)
    assert out["r"].status_code == 504


def test_stop_endpoint_refuses_a_quick_solve(live_solver, monkeypatch):
    main, url = live_solver
    started = threading.Event()
    release = threading.Event()

    def quick(_req, *, control):
        started.set()
        release.wait(20)
        raise SolveAborted("test: done")

    monkeypatch.setattr(main, "optimize_dispatch", quick)
    body = _body("QUICK")
    headers = {"X-Solver-Token": TOKEN}
    th = threading.Thread(target=lambda: httpx.post(f"{url}/optimize-dispatch", json=body, headers=headers, timeout=30))
    th.start()
    try:
        assert started.wait(10)
        res = httpx.post(f"{url}/optimize-dispatch/stop", json={"run_id": body["run_id"], "tenant_id": body["tenant_id"]}, headers=headers)
        assert res.status_code == 409
    finally:
        release.set()
        th.join(20)
