"""Pytest config — make `apps/solver` importable from tests/."""
import os
import sys

import pytest

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)


@pytest.fixture(autouse=True)
def _disable_osrm_by_default(monkeypatch):
    """Tests assert against the Haversine code path. Disable the OSRM upgrade
    so we don't make real network calls in unit tests. Tests that specifically
    want to exercise OSRM can re-enable it inside the test body."""
    import distance
    monkeypatch.setattr(distance, "OSRM_URL", "")


@pytest.fixture(autouse=True)
def _second_search_off_by_default(monkeypatch):
    """The second route search (PyVRP, on in production) is off unless a test switches it on
    (test_pyvrp_candidate.py, and the parametrized end-to-end tests): every other test keeps its
    exact behaviour and time."""
    monkeypatch.setenv("SOLVER_PYVRP", "off")


@pytest.fixture(autouse=True)
def _fresh_worker_health():
    """Rule 22: /ready's worker status is process-wide, and a failure stays reported for minutes
    whatever pools start meanwhile (WORKER_ALERT_MIN_SEC): one test's broken pool must not make a
    later test's /ready fail."""
    import dispatch_solver
    dispatch_solver.WORKER_HEALTH.reset()
    yield
    dispatch_solver.WORKER_HEALTH.reset()
