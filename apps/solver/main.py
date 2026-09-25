"""RouteIQ optimization service.

Endpoints (all but /health require the shared-secret X-Solver-Token header):

* ``POST /optimize-dispatch`` - NMWC daily dispatch planner (OR-Tools): time windows,
  P1-P5 priorities, multi-load trucks, frozen (locked/dispatched) loads, road distance.
* ``POST /route-geometry``    - road polyline for a load via the configured OSRM.
* ``POST /optimize``          - legacy v1 three-scenario PyVRP solver (kept for comparison).
"""

import hmac
import logging
import os
import threading
import time
from typing import Annotated

import httpx
from fastapi import FastAPI, Header, HTTPException

from dispatch_models import DispatchRequest, DispatchResponse, GeometryRequest, GeometryResponse
from dispatch_solver import SolveAborted, optimize_dispatch
from models import OptimizeRequest, OptimizeResponse
from providers import HaversineProvider, OSRMProvider, configured_osrm_url
from solver import optimize

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s: %(message)s",
)
log = logging.getLogger("routeiq.api")

app = FastAPI(title="RouteIQ Solver", version="0.4.0")

SOLVER_TOKEN = os.environ.get("SOLVER_TOKEN", "")


def _env_int(name: str, default: int) -> int:
    try:
        value = int(os.environ.get(name, ""))
    except ValueError:
        return default
    return value if value > 0 else default


# Review F16 (defence in depth): one solver process serves every company, and each dispatch solve
# can use up to 3 OR-Tools processes for up to 540 s. At most MAX_CONCURRENT_DISPATCH solves run
# at once (default 2; size it to the solver's CPUs); another one is refused at once with 503
# "solver busy" instead of slowing every running solve past its deadline. The web's solve
# admission (lib/dispatch/solve-admission.ts) queues before this limit is ever reached; the 503
# covers a deploy overlap (two web processes) and direct callers.
MAX_CONCURRENT_DISPATCH = _env_int("MAX_CONCURRENT_DISPATCH", 2)
_DISPATCH_SLOTS = threading.BoundedSemaphore(MAX_CONCURRENT_DISPATCH)


def _on_railway() -> bool:
    return any(os.environ.get(k) for k in ("RAILWAY_ENVIRONMENT_ID", "RAILWAY_PROJECT_ID", "RAILWAY_ENVIRONMENT_NAME", "RAILWAY_ENVIRONMENT"))


def solver_parallel_warning() -> str | None:
    """SOLVER_PARALLEL=0 solves in the API process with NO deadline and NO time budget: nothing then
    keeps a solve under the web's 600 s limit, a hung OR-Tools call hangs the request, and /health
    stops answering during every solve. Development and tests only (review: SOLVER_PARALLEL=0
    disables every deadline). Returns the startup warning, or None when it is not set."""
    if os.environ.get("SOLVER_PARALLEL", "1") != "0":
        return None
    where = "on Railway (production)" if _on_railway() else "outside a deployment"
    return (f"SOLVER_PARALLEL=0 is set {where}: every solve runs inside the API process with no deadline and no time "
            "budget, and /health does not answer while solving. Use it for local development and tests only; "
            "remove it from any deployed solver.")


_PARALLEL_WARNING = solver_parallel_warning()
if _PARALLEL_WARNING:
    (log.error if _on_railway() else log.warning)(_PARALLEL_WARNING)


_ROUTING_CACHE: dict = {"at": 0.0, "value": None}
_ROUTING_TTL_S = 60


def routing_status() -> dict:
    """Is road routing available? OSRM down never fails the solver (plans fall back to
    estimated distances with a warning) - this is for monitoring. Cached 60 s; no URL leaked."""
    url = configured_osrm_url()
    if not url:
        return {"provider": "HAVERSINE", "status": "not_configured"}
    now = time.time()
    if _ROUTING_CACHE["value"] and now - _ROUTING_CACHE["at"] < _ROUTING_TTL_S:
        return _ROUTING_CACHE["value"]
    try:
        r = httpx.get(f"{url.rstrip('/')}/nearest/v1/driving/58.3920,23.5680", timeout=2.0)
        status = "up" if r.status_code == 200 and r.json().get("code") == "Ok" else "down"
    except Exception:  # noqa: BLE001
        status = "down"
    value = {"provider": "OSRM", "status": status}
    _ROUTING_CACHE.update(at=now, value=value)
    return value


@app.get("/health")
def health() -> dict:
    """Public health probe used by Railway and the web service /api/health."""
    return {"ok": True, "routing": routing_status()}


def _check_token(token: str | None) -> None:
    """Shared-secret check for every endpoint except /health. Constant-time, on bytes:
    hmac.compare_digest on str raises TypeError for non-ASCII input (a 500), bytes never do."""
    if not SOLVER_TOKEN:
        log.error("SOLVER_TOKEN env var is not set; refusing request")
        raise HTTPException(status_code=500, detail="Solver not configured")
    if not hmac.compare_digest((token or "").encode("utf-8"), SOLVER_TOKEN.encode("utf-8")):
        raise HTTPException(status_code=401, detail="Invalid solver token")


@app.post("/optimize-dispatch", response_model=DispatchResponse)
def optimize_dispatch_endpoint(
    req: DispatchRequest,
    x_solver_token: Annotated[str | None, Header(alias="X-Solver-Token")] = None,
) -> DispatchResponse:
    _check_token(x_solver_token)
    # Taken without waiting: a full solver answers 503 at once (the web shows "optimizer busy").
    slots = _DISPATCH_SLOTS
    if not slots.acquire(blocking=False):
        log.warning("optimize-dispatch run=%s refused: %d solve(s) already running", req.run_id, MAX_CONCURRENT_DISPATCH)
        raise HTTPException(
            status_code=503,
            detail=f"Solver busy: {MAX_CONCURRENT_DISPATCH} optimization(s) already running. Try again in a minute.",
            headers={"Retry-After": "60"},
        )
    try:
        started = time.time()
        log.info("optimize-dispatch run=%s tenant=%s stops=%d trucks=%d scenarios=%s",
                 req.run_id, req.tenant_id, len(req.stops), len(req.trucks), req.config.scenarios)
        try:
            resp = optimize_dispatch(req)
        except SolveAborted as exc:
            log.error("optimize-dispatch run=%s aborted: %s", req.run_id, exc)
            raise HTTPException(status_code=504, detail=str(exc)) from None
        log.info("optimize-dispatch run=%s done in %.1fs provider=%s", req.run_id, time.time() - started,
                 resp.matrix_provider)
        return resp
    finally:
        slots.release()


@app.post("/route-geometry", response_model=GeometryResponse)
def route_geometry_endpoint(
    req: GeometryRequest,
    x_solver_token: Annotated[str | None, Header(alias="X-Solver-Token")] = None,
) -> GeometryResponse:
    _check_token(x_solver_token)
    url = configured_osrm_url(req.osrm_url)
    if url:
        try:
            coords = OSRMProvider(url).get_route_geometry(list(req.coords))
            return GeometryResponse(provider="OSRM", is_estimated=False, coordinates=coords)
        except Exception as exc:  # noqa: BLE001
            return GeometryResponse(provider="HAVERSINE", is_estimated=True,
                                    coordinates=HaversineProvider().get_route_geometry(list(req.coords)),
                                    warning=f"Road geometry unavailable ({exc}); straight lines shown.")
    return GeometryResponse(provider="HAVERSINE", is_estimated=True,
                            coordinates=HaversineProvider().get_route_geometry(list(req.coords)),
                            warning="Road routing (OSRM) is not configured; straight lines shown.")


@app.post("/optimize", response_model=OptimizeResponse)
def optimize_endpoint(
    req: OptimizeRequest,
    x_solver_token: Annotated[str | None, Header(alias="X-Solver-Token")] = None,
) -> OptimizeResponse:
    _check_token(x_solver_token)

    started = time.time()
    log.info(
        "optimize run=%s tenant=%s stops=%d trucks=%d scenarios=%s",
        req.run_id, req.tenant_id, len(req.stops), len(req.trucks),
        req.config.scenarios_requested,
    )
    response = optimize(req)
    elapsed = time.time() - started
    log.info(
        "optimize run=%s done in %.2fs scenarios=%d",
        req.run_id, elapsed, len(response.scenarios),
    )
    return response
