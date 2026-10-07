# bounds/: optimality gap of the dispatch engine (LOCAL ONLY)

`best_known_real80*.json` and the real80 entries of `bounds_summary.json` contain real NMWC customer codes.
Never publish or send them. The small exact instances are synthetic.

Run everything with `C:/Users/abdulr/routeiq/apps/solver/.venv/Scripts/python.exe` from this folder. Nothing in the repo
is modified. `lb_lib.py` installs a tiny `pandas` stub before OR-Tools CP-SAT is imported. On this shared machine,
loading pandas' DLLs near the commit limit aborted processes with STATUS_COMMITMENT_LIMIT, and none of this code uses pandas.

## Scripts

| script | what it does | output |
|---|---|---|
| `lb_lib.py` | Metric closure (Floyd-Warshall), load bounds (ceil per resource / joint cases+kg over the heterogeneous load list, Martello-Toth L2, conflict clique), radial km/time bound, L-tree Lagrangian (MST / Held-Karp style) bound, truck bounds (trips x capacity, deadline windows) | library |
| `km_lp.py` | Directed LP relaxation with rounded capacity cuts (components, greedy growth, max-flow fractional cuts). Column generation over arcs; the reported bound is the Lagrangian dual bound over **all** arcs, so it is valid at any round | library |
| `run_lp.py <inst> <D\|T> <budget_s> [knn\|full]` | Runs the LP for km (D) or travel seconds (T) | `results/lp_<inst>_<D\|T>.json` |
| `type_mip.py` | Joint truck-type MIP (SCIP): lower bounds on trucks, loads and operating cost (fixed + trip + per-type km + driver + overtime) | library |
| `repack.py` | Keeps every load's route and reassigns whole loads to trucks and departure times (CP-SAT, exact for that sub-problem). The result is re-scored by `instances.evaluate` | library |
| `engine_runs.py default <inst>` / `cold <inst> <SCEN> <sec>` | Engine runs in-process on the cached matrix | `results/engine_*.json` |
| `bounds_all.py [inst ...]` | All bounds + engine default (`../results/baseline.json`, `results/engine_default_*.json`) + best-known over every full-service plan (incl. `../ortools/results/runs.jsonl`) and its repack | `results/bounds_summary.json`, `results/best_known_<inst>.json` |
| `exact_model.py` | Exact CP-SAT model of the engine's objective (circuits with reload nodes, cases + kg, hard windows, span/overtime/preferred/early costs, the engine's integer rounding). Lexicographic: phase 1 = weighted unserved, phase 2 = the rest. `fix_plan=` re-costs any plan in the same model | library |
| `exact_small.py <first-last\|n> <cp_limit_s> <workers> [out.json]` | Seeded small instances (1-20 general, 101-110 shortage-focused, plus a P2-vs-11xP3 probe). Engine (auto limit, all 3 scenarios) vs exact optimum | `results/exact_small.json`, `results/exact_small_v2.json` |
| `exact_report.py` | Statistics over both exact sets | `results/exact_stats.json` |

Typical order: `run_lp.py` (D, then T for OSRM instances) -> `engine_runs.py` -> `bounds_all.py`; `exact_small.py` ->
`exact_report.py`. Wall times were measured while other benchmark agents shared the 12-CPU machine.
