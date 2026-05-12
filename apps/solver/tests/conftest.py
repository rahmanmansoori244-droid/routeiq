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
