# RouteIQ Solver

FastAPI service, deployed separately from the web app. Every endpoint except `/health` requires the `X-Solver-Token` shared secret.

| Path | Engine | Purpose |
|---|---|---|
| `GET /health` | — | Railway health check |
| `POST /optimize-dispatch` | **OR-Tools** (`dispatch_solver.py` + `load_repack.py`) | NMWC daily dispatch planner: cases+kg capacity, hard + preferred windows, strict P1–P5 priorities, multi-load trucks (depot reload visits, turnaround per case), frozen locked/dispatched loads, RECOMMENDED + MIN_TRUCKS + MIN_DISTANCE; after the routing search a CP-SAT step re-assigns whole loads to trucks and every plan is timed exactly |
| `POST /route-geometry` | OSRM | road polyline for a load (straight lines when unavailable) |
| `POST /optimize` | PyVRP (`solver.py`) | legacy v1 three-scenario solver, kept for comparison only |

Road distance comes from `providers.py`: OSRM when `OSRM_URL` (or the request's `osrm_url`) is set, and otherwise Haversine × multiplier labelled as estimated. There is no silent public default; see `../../docs/OSRM_SETUP.md`.

## Local dev
```bash
python -m venv .venv && .venv/Scripts/pip install -r requirements.txt   # bin/ on Linux/macOS
SOLVER_TOKEN=dev-token OSRM_URL=http://localhost:5000 .venv/Scripts/python -m uvicorn main:app --port 8000
.venv/Scripts/python -m pytest tests -q
```

Every plan scenario runs in a worker process (OR-Tools holds the GIL, so an in-process search would freeze `/health` and every other request). `SOLVER_PARALLEL=0` runs every scenario inside the API process with no deadline, for tests and debugging only. The solver falls back to it automatically when worker processes cannot start. Design notes: `../../docs/OPTIMIZER_DESIGN.md`.
