"""RouteIQ optimization service.

Endpoints (all but /health require the shared-secret X-Solver-Token header):

* ``POST /optimize-dispatch`` - NMWC daily dispatch planner (OR-Tools): time windows,
  P1-P5 priorities, multi-load trucks, frozen (locked/dispatched) loads, road distance. A solve
  whose caller disconnects (the web app restarted) is cancelled and frees its slot. A solve whose
  worker processes cannot start is refused within seconds with 503 WORKERS_UNAVAILABLE (rule 22).
* ``POST /optimize-dispatch/stop`` - a THOROUGH solve returns the best plan found so far.
* ``POST /route-geometry``    - road polyline for a load via the configured OSRM.
* ``GET  /ready``             - dispatch readiness for the web's /api/health: proves the token is
  set on both sides and matches, without running an optimization (audit F15), and reports a
  recent failed worker start (rule 22).
* ``POST /optimize``          - legacy v1 three-scenario PyVRP solver (kept for comparison).
"""

import hmac
import logging
import os
import threading
import time
from functools import partial
from typing import Annotated

import anyio
import httpx
from fastapi import FastAPI, Header, HTTPException, Request
from pydantic import BaseModel

from fastapi.responses import JSONResponse

from dispatch_models import DispatchRequest, DispatchResponse, GeometryRequest, GeometryResponse
from dispatch_solver import WORKER_HEALTH, SolveAborted, SolveControl, WorkersUnavailable, optimize_dispatch
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
# can use up to 3 OR-Tools processes for up to 540 s (QUICK) or THOROUGH_MAX_SEC (THOROUGH, 20 min
# by default; mostly one process: RECOMMENDED's search). At most MAX_CONCURRENT_DISPATCH solves run
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


def inprocess_fallback_warning() -> str | None:
    """Rule 22: SOLVER_ALLOW_INPROCESS_FALLBACK=1 brings back the old fallback - a worker pool that
    cannot start makes the solve run inside the API process with no deadline, freezing the API for
    the whole search (20 minutes and more for a thorough one). Without it such a solve is refused at
    once with 503 "The planner is busy or restarting". Returns the startup warning, or None."""
    if os.environ.get("SOLVER_ALLOW_INPROCESS_FALLBACK", "") != "1":
        return None
    where = "on Railway (production)" if _on_railway() else "outside a deployment"
    return (f"SOLVER_ALLOW_INPROCESS_FALLBACK=1 is set {where}: when the worker processes cannot start, a solve runs "
            "inside the API process with no deadline and the planner stops answering until it ends. Use it for local "
            "development and tests only; remove it from any deployed solver.")


def log_startup_warnings() -> None:
    """At startup (below, when uvicorn imports this module): one line per development-only switch
    that is set - SOLVER_PARALLEL=0, SOLVER_ALLOW_INPROCESS_FALLBACK=1 - an ERROR on Railway, a
    WARNING elsewhere. The only guard against either on a deployed solver: RAILWAY_DEPLOYMENT.md's
    "verify after the deploy" step reads this line (test_worker_start.py)."""
    for warning in (solver_parallel_warning(), inprocess_fallback_warning()):
        if warning:
            (log.error if _on_railway() else log.warning)(warning)


log_startup_warnings()


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


@app.get("/ready")
def ready_endpoint(
    x_solver_token: Annotated[str | None, Header(alias="X-Solver-Token")] = None,
) -> dict:
    """Dispatch readiness (audit F15): the same token check as /optimize-dispatch, and nothing else.

    The web's /api/health calls it with its SOLVER_TOKEN. 401 = the web's token is wrong or
    missing; 500 "Solver not configured" = this service has no SOLVER_TOKEN; 200 = an optimize
    would be accepted. It never solves, takes no dispatch slot and reads no request body; the
    routing status is the cached one /health reports.

    Rule 22: ``workers`` says whether the worker processes failed recently. After a failed pool
    start (the solve was refused with 503 "The planner is busy or restarting"), a pool that broke
    during a solve, or one that did not close, it is "failed" and ``ok`` is false - for
    WORKER_ALERT_SEC (15 minutes), or until a pool starts WORKER_ALERT_MIN_SEC (5 minutes) or more
    after the failure; a pool that starts sooner clears nothing - so the web's /api/health answers
    "degraded" (SOLVER_WORKERS_FAILED) and monitoring alerts an administrator.
    """
    _check_token(x_solver_token)
    workers = WORKER_HEALTH.status()
    return {
        "ok": workers["status"] == "ok",
        "service": "routeiq-solver",
        "version": app.version,
        "max_concurrent_dispatch": MAX_CONCURRENT_DISPATCH,
        "routing": routing_status(),
        "workers": workers,
    }


# Solves running now, by run id -> (tenant id, search mode, control): the stop endpoint finds them here.
_RUNNING: dict[str, tuple[str, str, SolveControl]] = {}
_RUNNING_LOCK = threading.Lock()
# How often a running solve checks that its caller is still connected.
DISCONNECT_POLL_SEC = 1.0


@app.post("/optimize-dispatch", response_model=DispatchResponse)
async def optimize_dispatch_endpoint(
    request: Request,
    req: DispatchRequest,
    x_solver_token: Annotated[str | None, Header(alias="X-Solver-Token")] = None,
) -> DispatchResponse:
    """The solve runs in a worker thread (its searches in worker processes) while this request
    checks every second that the caller is still connected. A web app that restarts mid-solve (a
    deploy) closes the connection: the solve is cancelled at once and its slot frees, instead of
    searching on for nobody for up to THOROUGH_MAX_SEC while new solves get 503."""
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
    control = SolveControl()
    with _RUNNING_LOCK:
        _RUNNING[req.run_id] = (req.tenant_id, req.config.search_mode, control)
    try:
        started = time.time()
        log.info("optimize-dispatch run=%s tenant=%s stops=%d trucks=%d scenarios=%s mode=%s",
                 req.run_id, req.tenant_id, len(req.stops), len(req.trucks), req.config.scenarios, req.config.search_mode)
        outcome: dict = {}

        async def watch_caller() -> None:
            while True:
                await anyio.sleep(DISCONNECT_POLL_SEC)
                if await request.is_disconnected():
                    log.warning("optimize-dispatch run=%s: the caller disconnected; cancelling the solve", req.run_id)
                    control.cancel("the web app closed the connection")
                    return

        async with anyio.create_task_group() as tg:
            tg.start_soon(watch_caller)
            try:
                outcome["resp"] = await anyio.to_thread.run_sync(partial(optimize_dispatch, req, control=control))
            except Exception as exc:  # noqa: BLE001 - answered below, after the watcher stopped
                outcome["error"] = exc
            finally:
                tg.cancel_scope.cancel()
        exc = outcome.get("error")
        if isinstance(exc, WorkersUnavailable):
            # Rule 22: the worker processes could not start, or their pool broke during the search
            # (never a search inside this process). A plain answer within seconds; the web keeps the
            # previous plan and alerts (its job fails with this text, audited). Its own code tells it
            # apart from "Solver busy" above.
            log.error("optimize-dispatch run=%s refused (503 WORKERS_UNAVAILABLE): worker processes could not start or "
                      "stopped working (%s)", req.run_id, exc.cause)
            return JSONResponse(status_code=503, content={"detail": str(exc), "code": exc.code},
                                headers={"Retry-After": "60"})
        if isinstance(exc, SolveAborted):
            log.error("optimize-dispatch run=%s aborted: %s", req.run_id, exc)
            raise HTTPException(status_code=504, detail=str(exc)) from None
        if exc is not None:
            raise exc
        resp = outcome["resp"]
        log.info("optimize-dispatch run=%s done in %.1fs provider=%s", req.run_id, time.time() - started,
                 resp.matrix_provider)
        return resp
    finally:
        with _RUNNING_LOCK:
            if _RUNNING.get(req.run_id, (None, None, None))[2] is control:
                del _RUNNING[req.run_id]
        slots.release()


class StopRequest(BaseModel):
    run_id: str
    tenant_id: str


@app.post("/optimize-dispatch/stop")
def stop_dispatch_endpoint(
    body: StopRequest,
    x_solver_token: Annotated[str | None, Header(alias="X-Solver-Token")] = None,
) -> dict:
    """"Use the best plan found so far": a running THOROUGH solve ends its search at the next
    solution it finds (usually within a second), skips the alternatives and re-checks the loads with
    QUICK's time; its /optimize-dispatch request then answers as usual (stop_reason STOPPED).
    404: no solve of this plan (and company) is running here; 409: a QUICK solve (not stoppable)."""
    _check_token(x_solver_token)
    with _RUNNING_LOCK:
        entry = _RUNNING.get(body.run_id)
    if entry is None or entry[0] != body.tenant_id:
        raise HTTPException(status_code=404, detail="No optimization of this plan is running on the route optimizer.")
    _tenant, mode, control = entry
    if mode != "THOROUGH":
        raise HTTPException(status_code=409, detail="Only a thorough search can be stopped early; a quick one ends by itself.")
    control.request_stop()
    log.info("optimize-dispatch run=%s: stop requested (use the best plan found so far)", body.run_id)
    return {"ok": True, "stopping": True}


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
