"""Stabilization PR1 (security) checks for the solver service.

- L7: one constant-time token check (hmac.compare_digest on bytes) guards every endpoint except
  /health; a missing, wrong or non-ASCII token is a 401, never a 500.
- F22: the legacy distance module has no public OSRM default.
"""
from __future__ import annotations

import importlib

import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient

import main

TOKEN = "unit-test-solver-token"


@pytest.fixture
def configured(monkeypatch):
    monkeypatch.setattr(main, "SOLVER_TOKEN", TOKEN)


@pytest.mark.parametrize("sent", [None, "", "wrong-token", TOKEN + "x", "töken-üç", "مرحبا"])
def test_check_token_rejects_with_401(configured, sent):
    with pytest.raises(HTTPException) as exc:
        main._check_token(sent)
    assert exc.value.status_code == 401


def test_check_token_accepts_the_right_token(configured):
    assert main._check_token(TOKEN) is None


def test_check_token_without_configuration_is_500(monkeypatch):
    monkeypatch.setattr(main, "SOLVER_TOKEN", "")
    with pytest.raises(HTTPException) as exc:
        main._check_token(TOKEN)
    assert exc.value.status_code == 500


@pytest.mark.parametrize("endpoint", ["optimize_dispatch_endpoint", "route_geometry_endpoint", "optimize_endpoint"])
def test_every_protected_endpoint_goes_through_check_token(configured, monkeypatch, endpoint):
    calls = []

    def spy(token):
        calls.append(token)
        raise HTTPException(status_code=401, detail="Invalid solver token")

    monkeypatch.setattr(main, "_check_token", spy)
    with pytest.raises(HTTPException) as exc:
        getattr(main, endpoint)(None, x_solver_token="sent-token")
    assert exc.value.status_code == 401
    assert calls == ["sent-token"]


def test_non_ascii_header_is_401_over_http(configured):
    client = TestClient(main.app)
    # A valid geometry body, so the request reaches the token check.
    body = {"coords": [[23.58, 58.39], [23.59, 58.40]]}
    r = client.post("/route-geometry", json=body, headers={"X-Solver-Token": "töken".encode("utf-8")})
    assert r.status_code == 401
    r = client.post("/route-geometry", json=body)
    assert r.status_code == 401
    assert client.get("/health").status_code == 200


def test_ready_refuses_a_missing_or_wrong_token_with_401(configured, monkeypatch):
    """Audit F15: /ready is the web's dispatch-readiness probe. A web with no SOLVER_TOKEN, or
    another value than the solver's, gets the same 401 /optimize-dispatch would give it."""
    monkeypatch.delenv("OSRM_URL", raising=False)
    client = TestClient(main.app)
    assert client.get("/ready").status_code == 401
    assert client.get("/ready", headers={"X-Solver-Token": "not-the-token"}).status_code == 401
    assert client.get("/health").status_code == 200  # /health stays public and green


def test_ready_without_a_solver_token_is_500_not_configured(monkeypatch):
    monkeypatch.setattr(main, "SOLVER_TOKEN", "")
    monkeypatch.delenv("OSRM_URL", raising=False)
    r = TestClient(main.app).get("/ready", headers={"X-Solver-Token": "anything"})
    assert r.status_code == 500
    assert r.json()["detail"] == "Solver not configured"


def test_ready_with_the_right_token_answers_without_solving(configured, monkeypatch):
    """A matching token answers 200 at once: no optimization is run and no dispatch slot is taken."""
    monkeypatch.delenv("OSRM_URL", raising=False)

    def must_not_run(*_a, **_k):
        raise AssertionError("a readiness check must never optimize")

    monkeypatch.setattr(main, "optimize_dispatch", must_not_run)
    monkeypatch.setattr(main, "optimize", must_not_run)
    before = main._DISPATCH_SLOTS._value
    r = TestClient(main.app).get("/ready", headers={"X-Solver-Token": TOKEN})
    assert r.status_code == 200
    body = r.json()
    assert body["ok"] is True
    assert body["routing"] == {"provider": "HAVERSINE", "status": "not_configured"}
    assert body["max_concurrent_dispatch"] == main.MAX_CONCURRENT_DISPATCH
    assert main._DISPATCH_SLOTS._value == before


def test_ready_goes_through_check_token(configured, monkeypatch):
    calls = []

    def spy(token):
        calls.append(token)
        raise HTTPException(status_code=401, detail="Invalid solver token")

    monkeypatch.setattr(main, "_check_token", spy)
    with pytest.raises(HTTPException) as exc:
        main.ready_endpoint(x_solver_token="sent-token")
    assert exc.value.status_code == 401
    assert calls == ["sent-token"]


def test_legacy_distance_has_no_public_osrm_default(monkeypatch):
    import distance

    monkeypatch.delenv("OSRM_URL", raising=False)
    reloaded = importlib.reload(distance)
    try:
        assert reloaded.OSRM_URL == ""
    finally:
        importlib.reload(distance)
