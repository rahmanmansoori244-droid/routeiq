# RouteIQ Solver

FastAPI service, deployed separately from the web app. Every endpoint except `/health` requires the `X-Solver-Token` shared secret.

| Path | Engine | Purpose |
|---|---|---|
| `GET /health` | — | Railway health check |
| `POST /optimize-dispatch` | **OR-Tools** (`dispatch_solver.py` + `load_repack.py`) | NMWC daily dispatch planner: cases+kg capacity, hard + preferred windows, strict P1–P5 priorities, multi-load trucks (depot reload visits, turnaround per case), frozen locked/dispatched loads, RECOMMENDED + MIN_TRUCKS + MIN_DISTANCE; after the routing search a CP-SAT step re-assigns whole loads to trucks and every plan is timed exactly |
| `POST /route-geometry` | OSRM | road polyline for a load (straight lines when unavailable) |
| `POST /optimize` | PyVRP (`solver.py`) | legacy v1 three-scenario solver, kept for comparison only |

Road distance comes from `providers.py`: OSRM when `OSRM_URL` (or the request's `osrm_url`) is set, and otherwise Haversine × multiplier labelled as estimated. There is no silent public default; see `../../docs/OSRM_SETUP.md`. Each matrix cell knows whether it is a road or an estimated leg (a pair OSRM could not route, a point more than `OSRM_MAX_SNAP_M` from any road); the truck factor `road_time_factor` applies to road cells only, and the response says `distance_quality` ROAD / MIXED / ESTIMATED with `estimated_legs` per load. Road routing has a deadline: `MATRIX_BUDGET_SEC` (default min(90 s, 20% of `SOLVER_BUDGET_SEC`)); after it the whole matrix is estimated, with a "road routing too slow" warning. `OSRM_TABLE_TILE` (default 90 coordinates per `/table` call; production can raise it up to the OSRM server's `--max-table-size`, 1000 in `infra/osrm`, so a day needs one call) and `OSRM_PARALLEL` (default 2, max 4 calls at once) tune the calls. At most 600 stops per request (422 above).

Costs (`costing.py`, one model for the score and the report): the driver is paid for the WHOLE truck day, from the first departure (or first frozen departure) to the last return, turnarounds and waiting included; overtime after `overtime_after_min` from that first departure is added on top. Each load carries its share (the paid time from the truck's previous return to its own return), so frozen loads + new loads = the day.

## Local dev
```bash
python -m venv .venv && .venv/Scripts/pip install -r requirements.txt   # bin/ on Linux/macOS
# apps/solver/.env holds SOLVER_TOKEN (and OSRM_URL for a local OSRM); --env-file loads it.
# Inline variables still win: SOLVER_TOKEN=... .venv/Scripts/python -m uvicorn main:app --port 8000
.venv/Scripts/python -m uvicorn main:app --env-file .env --port 8000
# Smoke test: a wrong token answers 401 (a 500 "Solver not configured" means SOLVER_TOKEN was not loaded)
curl -s -o /dev/null -w "%{http_code}\n" -X POST http://localhost:8000/route-geometry -H "X-Solver-Token: wrong" \
  -H "content-type: application/json" -d '{"coords":[[23.6,58.4],[23.61,58.41]]}'
.venv/Scripts/python -m pytest tests -q
```

Every plan scenario runs in a worker process (OR-Tools holds the GIL, so an in-process search would freeze `/health` and every other request). `SOLVER_PARALLEL=0` runs every scenario inside the API process with no deadline and no time budget, for tests and debugging only (a warning is logged at startup; an error on Railway). Every returned option carries an independent timing check (`feasibility.py`, `DispatchScenario.feasibility`). The solver falls back to it automatically when worker processes cannot start. Design notes: `../../docs/OPTIMIZER_DESIGN.md`.
