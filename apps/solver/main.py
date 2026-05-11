"""RouteIQ optimization service.

Phase 3 wires the OR-Tools solver behind the FastAPI `/optimize` endpoint with
shared-secret auth. See CLAUDE.md §7 for the request/response contract.
"""

import logging
import os
import time
from typing import Annotated

from fastapi import FastAPI, Header, HTTPException

from models import OptimizeRequest, OptimizeResponse
from solver import optimize

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s: %(message)s",
)
log = logging.getLogger("routeiq.api")

app = FastAPI(title="RouteIQ Solver", version="0.3.0")

SOLVER_TOKEN = os.environ.get("SOLVER_TOKEN", "")


@app.get("/health")
def health() -> dict[str, bool]:
    """Public health probe used by Railway and the web service /api/health."""
    return {"ok": True}


@app.post("/optimize", response_model=OptimizeResponse)
def optimize_endpoint(
    req: OptimizeRequest,
    x_solver_token: Annotated[str | None, Header(alias="X-Solver-Token")] = None,
) -> OptimizeResponse:
    if not SOLVER_TOKEN:
        log.error("SOLVER_TOKEN env var is not set; refusing /optimize")
        raise HTTPException(status_code=500, detail="Solver not configured")
    if x_solver_token != SOLVER_TOKEN:
        raise HTTPException(status_code=401, detail="Invalid solver token")

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
