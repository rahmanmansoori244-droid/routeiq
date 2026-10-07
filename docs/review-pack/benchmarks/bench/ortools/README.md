# OR-Tools engine benchmark (`.dev/bench/ortools`)

**LOCAL ONLY.** The real80 plans stored in `results/` name real NMWC customers. Never publish them.

Question: is the current dispatch engine (`apps/solver/dispatch_solver.py`, OR-Tools PCI + GLS,
RECOMMENDED / MIN_TRUCKS / MIN_DISTANCE) giving the best results it can? Everything here runs the
engine as a library on the shared harness (`../instances.py`, cached matrices, offline). Nothing in
the repo is modified: the search parameters and the extra steps are applied as runtime
monkeypatches. The server, database and solver HTTP service are not started.

Python: `C:/Users/abdulr/routeiq/apps/solver/.venv/Scripts/python.exe` (OR-Tools 9.15).

## Files

| file | what it does |
|---|---|
| `common.py` | Runs one engine configuration in-process (`SOLVER_PARALLEL=0`, `SOLVER_BUDGET_SEC=5000`). It patches `pywrapcp.RoutingModel` to set the first-solution strategy, metaheuristic, ILS or GLS lambda; to record every solution OR-Tools reports (time and objective); and to warm-start RECOMMENDED. Modes: `std` (the engine as is), `twophase` (MIN_TRUCKS or MIN_DISTANCE cold for half the time, then RECOMMENDED warm-started for the other half) and `warmplan` (RECOMMENDED warm-started from a given plan). Every plan is scored by `instances.evaluate` (the lp timetable). CLI: `common.py --job '<json>' --out results/runs.jsonl`. |
| `driver.py` | Runs a job list with one process per job and N at a time. It resumes by job key and kills a job after 3 × its limit + 180 s. |
| `make_jobs.py` | Writes `jobs_main.json`: groups A (convergence), B (strategies at the auto limit), C (scenarios) and D (two-phase). `jobs_extra.json` holds strategies at 60 s (real80, syn150_s1/s2) and syn300_s1 at 300 s. |
| `pathology.py` | Plan diagnostics for part (d): objective breakdown, truck and load use, waits, service start by priority, split parts, and single improving moves the engine missed (MOVE a whole load to another truck as an extra trip, MERGE two loads, RESEQ a load by 2-opt/or-opt). `polish()` applies the best improving move repeatedly. |
| `pipeline.py` | Remedy pipelines at the same total OR-Tools time. `half_polish_warm`: RECOMMENDED for T/2, then polish, then RECOMMENDED warm-started for T/2. `mt_polish_warm`: MIN_TRUCKS cold for T/2, then polish, then warm RECOMMENDED for T/2. `offline` polishes every stored engine plan and writes `results/polish_offline.jsonl`. |
| `best_push.py` | Builds the best-known reference: the best plan from any run is polished, then warm-started for T s. Writes `results/best_extra.jsonl`. |
| `sensitivity.py` | real80 variants: receiving deadline 14:00, and 60-minute reload. Runs the engine default vs the pipeline. |
| `warmstart_probe.py`, `reload_probe.py` | Probes: (1) `ReadAssignmentFromRoutes` stalls when time costs are present; (2) a reload-node penalty does not change syn300's first solution. |
| `analyze.py` | Writes all tables to `results/tables.md`. |

Results are in `results/`: `runs.jsonl` (one line per engine run, with plan and trace), `pipeline.jsonl`,
`polish_offline.jsonl`, `best_extra.jsonl`, `sensitivity.jsonl`, `pathology.json` and `tables.md`.

## Method notes

* **Objective.** Every plan, whichever scenario or method produced it, is scored on RECOMMENDED's own
  objective. `instances.evaluate` computes it and reproduces the engine within 0-6 units
  (1 unit = 1e-5 OMR). Warm starts gave an independent check: when OR-Tools was started from a
  polished plan, its first-solution objective matched the evaluator within 3 units.
  Example: real80 57,709,384 vs 57,709,381.
* **Repeats, not seeds.** OR-Tools routing has no random seed. Permuting the stop order was tested
  as a seed, and it gives *identical* solutions for a fixed number of solutions (checked on real80
  and syn60_s1). The search is deterministic, so runs of the same configuration differ only in where the
  wall-clock limit stops it. That depends on CPU speed and load.
* **Contention.** Other benchmark agents used the same 6-core / 12-thread machine at the same time,
  and CPU load was at 100%. Throughput dropped to about half: real80 at 20 s reported 910 solutions when the
  machine was lightly loaded, and 213-411 during the benchmark. Limits are equal across configurations, and job order was
  shuffled so contention hit every configuration alike. Absolute time-to-quality numbers are
  pessimistic, roughly × 2.
* **Warm start of RECOMMENDED.** The engine's `_initial_assignment` uses `ReadAssignmentFromRoutes`,
  which stalled for more than 40 s on syn60_s1 when the time dimension has soft costs; the engine's own code comment
  describes the same stall. This harness uses `CloseModelWithParameters` + `RoutesToAssignment`
  (Next variables only) + `SolveFromAssignmentWithParameters` instead, which did not stall.
  Across all runs it failed once (ROUTING_FAIL after 0.25 s, syn150_s2 two-phase, not reproducible), so a
  production version needs a fallback to a cold solve.
