# Optimizer benchmark and architecture decision (NMWC dispatch MVP)

Date: 2026-09-24 · Branch: `nmwc-dispatch-mvp` · Related: [OPTIMIZER_DESIGN.md](OPTIMIZER_DESIGN.md) (plain-language model), [OSRM_SETUP.md](OSRM_SETUP.md) (road matrix)

## 1. Decision

- **Keep Google OR-Tools (routing library) as the dispatch engine** (`apps/solver/dispatch_solver.py`, `POST /optimize-dispatch`).
  It is the only candidate that covers every NMWC rule (cases + kg, hard and preferred windows, strict P1 > P5
  priorities, several loads per truck, frozen loads) inside the existing Python solver, with no licence fee.
- **Distances come from a self-hosted OSRM** (Oman / GCC extract, URL set per tenant or through `OSRM_URL`). Haversine stays
  as a fallback that is labelled "estimated".
- **PyVRP** (changed 30 Sep 2026, §12): pinned at **0.14.0**, it now runs as the dispatch engine's **second search**. It
  searches the same day in a process of its own, and its best plan is one more candidate that the engine's own checks, exact
  timing and cost score judge. The legacy `/optimize` endpoint stays (ported to 0.14).
- **VROOM, Timefold, Google Route Optimization API**: not adopted. Revisit only if one of the triggers in §7 appears.
- **Fixed after the first measurements (see §5a):** at about 300 stops the automatic time limit was too short, and a
  warm-started alternative could stall past its time limit. Both are fixed and re-measured.
- **Fixed on 25 Sep 2026 (see §8):** on NMWC's real day the engine planned far too many trucks (13 trucks / 21 loads /
  754 OMR where 5 trucks / 14 loads / ~490 OMR were feasible). An exact post-solve step now re-assigns whole loads to trucks
  (CP-SAT, `load_repack.py`), priorities are strict, and loading / unloading time can follow the cases.
- **Long searches, 29 Sep 2026 (see §11):** a THOROUGH mode searches up to 20 minutes and stops early once the search stops
  improving (max(300 s, half the time searched so far) without a better plan). On NMWC-sized days the search keeps
  improving for most of the 20 minutes, so THOROUGH usually runs close to its cap; production-mode runs gave 3-11% lower
  objective than QUICK (the real day: one truck and three loads fewer, about 41 OMR a day less operating cost).

## 2. What the MVP must support

About 12 trucks, 60–300 drops a day, one depot (Ghala). Capacity is counted in cases and kg. Customer receiving windows are
hard, with a softer preferred window inside them. Priority P1 is the highest and P5 the lowest, and a P1 must never be dropped to
serve a P5. A truck can do up to 3 loads a day with a 30-minute reload between them. Loads that are locked or dispatched are
never changed, and late orders are handled by a new plan version. Every order ends up either planned or unserved with a
reason, and the cases reconcile exactly. Costs are in OMR (fixed, per km, fuel, driver hour, overtime). The system runs
self-hosted, next to the Next.js/Prisma app, and calls the solver over HTTP.

## 3. What the OR-Tools engine implements (as read from `dispatch_solver.py`)

| Concern | How it is modelled |
|---|---|
| Multi-trip (reloads) | There is one routing vehicle per physical truck. Each truck gets `trips_left - 1` optional **reload nodes** at the depot, pinned to that truck (`VehicleVar.SetValues([-1, v])`), which it can skip at zero cost. The capacity demand of a reload node is `-capacity` and it is the only node with slack, so a visit resets the load. This is the OR-Tools `cvrp_reload` sample pattern. Because all loads of a truck sit on one route, loads cannot overlap, and load k+1 leaves after load k returns plus its turnaround (`reload_min + loading_min_per_case x cases of load k+1`; the search uses 80% of a full truck for the unknown next load, the final timing the exact cases). The whole truck day is bounded by `shift_max_min`. The search's moves cannot move a whole load to another truck; the post-solve step does (row below). |
| Capacity | Two dimensions, `Cases` and `Kg` (kg is only active when a truck has a payload), each with a per-truck capacity. |
| Hard windows | `CumulVar(stop).SetRange(start, end)`: service must **start** inside the window. Depot hours and truck availability limit the start and end cumuls. |
| Soft windows | Preferred windows use `SetCumulVarSoftLowerBound` / `SetCumulVarSoftUpperBound` at `pref_window_penalty_per_min` OMR per minute. An early-arrival preference for P1/P2 and overtime after 9 h are also soft upper bounds. |
| Priorities / droppable orders | Each stop is an `AddDisjunction`. **Strict (default since 25 Sep 2026):** penalty = `SERVICE_BASE (1,000 OMR) × w(P)`, w(P5) = 1, w(P) = 1 + Σ over lower priorities q of n_q × w(q) (n_q = stops of priority q in the model), so one stop outweighs all lower-priority stops together. The int64 total is guarded (base scaled down, then weights capped with a warning, only for days of thousands of stops). **Weighted (`strict_priorities: false`)**: `SERVICE_UNIT × weight(P) / weight(P5)` with 10,000 / 1,000 / 100 / 10 / 1, where 11 P3 outweigh one P2. Margin, when every stop has one, adds a bonus that saturates smoothly below 0.4 service unit (10x cost for small margins) and only breaks ties within the same priority. The MIN_TRUCKS search multiplies the penalties by its largest cost multiplier (x20), so it never drops a stop to save a truck. |
| Costs | Each truck has its own arc cost (`cost_per_km + fuel_price / km_per_litre`, so fuel is counted once). The trip cost sits on arcs into reload nodes, and there is a fixed cost per truck-day. Driver time is a span cost, and overtime is a soft bound on the route end. (Since stabilization PR5 the driver is paid for the whole truck day in the report as well - `costing.py`; a truck with frozen loads is paid from its last frozen return.) |
| Frozen work | LOCKED / LOADING / DISPATCHED loads come in as `frozen_trips`. They stay out of the model and only change the truck's earliest departure (return + reload), its remaining trips and its shift anchor. |
| Reasons | Pre-filters return `EXCEEDS_ANY_TRUCK_CAPACITY`, `HARD_WINDOW_INFEASIBLE`, `SHIFT_LIMIT`, `NO_AVAILABLE_TRUCK` and `TRIP_LIMIT`. After the solve, dropped stops get `LATE_ORDER_NO_CAPACITY`, the fleet-shortage text, *"Not planned: the optimizer found no truck, trip or time slot ... within its time limit"*, or, for stops the search planned but the exact loading time did not leave room for, *"Not planned: once every load was timed with the loading time between loads ..."* (the last three as `SOLVER_DROPPED_LOW_PRIORITY`, labelled *"Not planned by the optimizer - see reason"* on the plan screen). Guided local search always ends on its time limit and reports `ROUTING_SUCCESS`, so the status is no proof: the engine never claims a stop impossible unless a pre-filter proved it. `_assert_reconciled` raises if any stop or case is missing or duplicated. |
| Search | `PARALLEL_CHEAPEST_INSERTION` followed by `GUIDED_LOCAL_SEARCH`. The automatic time limit (since stabilization PR7, `auto_time_limit`) is 5 s up to 25 stops, 20 s up to 120, then straight lines to 50 s at 150 and 150 s at 200, 150 s up to 350 and 240 s above; alternatives get half; within a 540 s budget per request. Until PR7 it was 5 / 20 / 150 / 240 s for ≤25 / ≤200 / ≤350 / >350 stops (and before that 3 / 8 / 20 for ≤25 / ≤80 / ≤200), so PR7 gives 121-200-stop days more time and no day size less (tested for 1-600 stops). Each measurement below ran on the schedule of its time; the 300-stop ones had 150 s, as now. |
| Scenarios | RECOMMENDED runs first with the full time budget. MIN_TRUCKS and MIN_DISTANCE are **warm-started** from it with half the budget: `CloseModelWithParameters` + `RoutesToAssignment` (Next variables only) + `SolveFromAssignmentWithParameters`, falling back to a cold solve when the plan cannot be loaded or the warm solve returns nothing. (`ReadAssignmentFromRoutes`, used before, restores cumul values and could stall > 100 s under time-dimension costs.) Every scenario, RECOMMENDED included, runs in a spawn worker process. OR-Tools holds the GIL for its whole search, so threads would not run scenarios in parallel, and an in-process search froze the API (health checks, route geometry) until it ended. Since rule 22 (30 Sep 2026) a pool that cannot start refuses the request within seconds (503 `WORKERS_UNAVAILABLE`, "The planner is busy or restarting - try again in a minute") instead of running the scenarios in-process; `SOLVER_PARALLEL=0` still runs them one after another in-process (tests and benchmarks), and `SOLVER_ALLOW_INPROCESS_FALLBACK=1` keeps the old fallback for development. |
| Post-solve load repack + selection | `load_repack.py`. For each raw scenario plan, CP-SAT keeps every load (stops and order) and re-assigns loads to trucks and departure times: no-wait offsets and a departure interval per load from hard windows; per truck earliest departure (after frozen loads + turnaround), latest return, depot hours, loads left, the shift span (unless anchored by frozen loads), cases / kg per load; loads of a truck do not overlap and are separated by the exact turnaround; identical trucks are symmetry-broken. Objective = the scenario's own prices (RECOMMENDED: fixed per used non-frozen truck + trip + km × truck rate + driver cost on the truck span + overtime + preferred-window / early-arrival hinges + plan continuity; MIN_TRUCKS: fixed × 20, trip × 5, km). Stops a plan left out (no shortage) enter as optional one-stop loads, lexicographically served first. Each solve: min(15 s, max(3 s, limit / 2)), 2 workers, stops when no better plan came for a quarter of that. Every candidate (raw plans re-timed + repacks) is timed by one LP per truck and scored on one RECOMMENDED objective (overtime from the first actual departure, as reported); RECOMMENDED takes the best objective, MIN_TRUCKS fewest trucks → loads → operating cost, MIN_DISTANCE fewest km → RECOMMENDED objective, none serving less than its raw plan. Runs in the worker pool with a deadline; on failure the raw plans are returned with a warning. |
| Matrix | `providers.py` requests the OSRM `/table` in blocks of 45 sources × 45 destinations (at most 90 coordinates per call, `OSRM_TABLE_TILE` = 90, because a stock server allows `--max-table-size` 100; since stabilization PR5 the tile is an environment setting, so a server with a larger table size needs one call per day). Road durations are multiplied by `road_time_factor` (1.25) to allow for slower trucks; since PR5 only real road cells are, never an estimated leg. The Haversine fallback uses ×1.3 at 40 km/h and is marked "estimated". |

## 4. Candidates compared

OSRM is **not an optimizer**. It is a road-network routing engine (Table, Route, Nearest, Match, Trip and Tile services). Its
Trip service is a greedy heuristic for a single vehicle (a travelling-salesman tour), not a multi-truck planner. In this design it
supplies the N×N distance and duration matrix and the map geometry, and any of the optimizers below can use it. It is licensed
BSD-2-Clause (latest release v26.9.0, 2026-09-01) and self-hosts on a small VM with the Geofabrik GCC extract. The stock
`car.lua` profile has no truck rules, which is why the solver applies `road_time_factor`.

| Criterion | OR-Tools routing | VROOM | Timefold (Solver / FSR) | Google Route Optimization API | PyVRP |
|---|---|---|---|---|---|
| What it is | C++ library with Python bindings. Routing layer on a CP solver, with local search and metaheuristics | C++ engine; runs via `vroom-express` (HTTP), pyvroom or the CLI | Solver is a Java/Kotlin constraint solver. FSR is a hosted model on the Timefold Platform | Hosted Google Maps Platform API (`optimizeTours`) | Python package with a C++ core. The installed 0.13.4 `solve()` runs **iterated local search** (`pyvrp.IteratedLocalSearch`), not the Hybrid Genetic Search (HGS) PyVRP's published benchmark results were made with |
| Licence | **Apache-2.0** (v9.15, 2026-01-12) | **BSD-2-Clause** (v1.15.0, 2026-03-12) | Solver Community **Apache-2.0** (v2.6.0). Enterprise edition is **commercial**. FSR and the other Platform models are **paid SaaS, price on request** | **Proprietary, paid per shipment** | **MIT** (v0.14.0, 2026-08-20) |
| Multi-dimensional capacity | Yes, any number of dimensions | Yes, amounts on any number of metrics | Solver: you model it. FSR documents no cargo capacity (it limits visits per shift). The Pick-up & Delivery model has capacity | Yes, `loadDemands` / `loadLimits` maps | Yes, list capacities |
| Hard time windows | Yes | Yes, several windows per job | Yes | Yes (`startTime` / `endTime`) | Yes (`tw_early` / `tw_late`) |
| Soft / preferred windows | Yes: soft cumul bounds with a linear cost | **No** in solve mode. Plan mode only makes constraints soft to compute ETAs for a given route | Yes, as soft constraints | Yes: soft start/end with a cost per hour | **No** preferred-window cost documented |
| Heterogeneous vehicles | Yes: capacity, costs and arc evaluator per vehicle | Yes: capacity, skills, fixed / per-hour / per-km costs, profiles | Yes | Yes: fixed cost, cost per km and per hour, route duration limit | Yes: vehicle types with their own costs and shifts |
| Priorities / droppable orders | Per-node disjunction penalty, fully controllable | Integer `priority` 0–100 that favours inclusion. **No per-job penalty cost** to trade against km or trucks | FSR: priorities 1–10 and optional `opt-1..10` with soft penalties | `penaltyCost` per shipment; when it is unset the shipment is mandatory | `prize` + `required=False` (prize-collecting) |
| Multi-trip (reloads) | No first-class feature. Uses **reload nodes with capacity slack** (official sample), which is what RouteIQ does | **Not native** (maintainer: "we don't handle that right now", issue #188). Workarounds: split a vehicle into copies with successive time windows, or model each delivery as a shipment picked up at the depot. That doubles the locations and cannot cap reloads per truck (#492) | FSR: **could not verify**. Its docs describe one route per vehicle shift and no depot reload. With Solver Community you would model it yourself in Java | No reload primitive in `ShipmentModel`. Same workarounds as VROOM | **Native since v0.11.0** (2025-05): `VehicleType.reload_depots`, `max_reloads`. v0.14 changed the route/trip API |
| Distance-matrix input | Any integer matrix or callback | Custom `durations` / `distances` / `costs` matrices per profile, or calls OSRM / Valhalla / ORS directly | Solver: bring your own. Platform: built-in maps | Google road network by default. Custom `durationDistanceMatrices` only when locations are given as tags, not lat/lng | Any integer matrix |
| Replanning with locked work | Initial routes, `ApplyLocks*`, or removing frozen work from the model (RouteIQ's approach) | Vehicle `steps`. v1.15 can apply heuristics to a partial input solution | Strong: pinning, `freezeTime`, real-time planning guides | `injectedFirstSolutionRoutes` + `InjectedSolutionConstraint` to freeze parts of routes | Initial solution only. No pinning primitive documented |
| Performance / scale | Measured here (§5): 150 stops ≈ 20 s. 300 stops needs more than 45 s | Built for low latency. Not measured here | Enterprise states it scales to 500k jobs. Not measured here | Hosted; batch requests up to 100 MB. Not measured here | State of the art on CVRP benchmarks. Not measured here with reloads |
| Cost | Free | Free | Community free; Enterprise and Platform by quote | Fleet Routing (≥2 vehicles) **$30 / 1,000 shipments** after 1,000 free per month, falling to $2.10 above 5M. Single Vehicle $10 / 1,000 after 5,000 free (pricing page updated 2026-09-17) | Free |
| Effort for RouteIQ (rough) | **Done**: engine and tests exist. Only the §5 fixes remain | Medium (~2–3 wk): rewrite the model, lose soft windows and penalty-priced priorities, build multi-trip workarounds, run a new binary | High (~4–6+ wk): a JVM service and new domain model, or a SaaS contract with order data leaving the site | Medium (~1–2 wk): client, GCP billing account, service-account secret, data-residency review | Medium (~1–2 wk): port to reload depots. Still no soft windows or pinning |
| Fit with Python FastAPI + Next.js/Prisma | Native: runs in-process in `apps/solver` | Good through pyvroom or a sidecar container | Poor: adds a JVM. The Python bindings repo is **archived** (last beta 1.12.0b, 2024) | OK over HTTP, but needs internet, gives vendor lock-in and a cost per run | Native (already a dependency) |

**Google RO cost at NMWC scale** (Fleet Routing SKU, about 26 working days a month; every scenario and every re-plan is a
separate billed request):

| Stops a day | Requests a day | Shipments a month | Estimated cost a month |
|---|---|---|---|
| 150 | 1 (one scenario) | 3,900 | ≈ $87 |
| 150 | 9 (3 scenarios × 3 plan versions) | 35,100 | ≈ $1,020 |
| 300 | 9 | 70,200 | ≈ $2,080 |

OSRM and OR-Tools cost only the VM they run on.

**Legacy PyVRP in this repo.** Commit `4c40e12` replaced OR-Tools with PyVRP 0.13 for `/optimize`. Its message cites better
CVRPLIB results for HGS; that claim was not re-verified here, and it does not apply to the installed version anyway: PyVRP
0.13.4's `solve()` is iterated local search (`IteratedLocalSearch`), not HGS. `solver.py` does **not** use reload depots. Its priority prizes
are linear (P1 costs only 5× P5 to drop), and it has no soft windows. `requirements.txt` pins `pyvrp<0.14` because 0.14 changed
`Model.add_depot()`. The NMWC dispatch path no longer uses it.

## 5. Measured numbers (this repo)

**Setup.** `apps/solver/scripts/bench_dispatch.py N` builds `tests.test_dispatch.nmwc_day(N)` with seed 1: stops in a Muscat-area box
(lat 23.45–23.70, lng 58.10–58.60) with the depot at 23.585, 58.39.

- 12% are hypermarkets: P1/P2, window 06:00–11:00, 30 min service, 80–200 cases.
- 18% are trading/catering: P2/P3, window 07:00–12:30, 15 min service, 20–80 cases.
- 70% are groceries: P3–P5, window 07:00–21:00 with a preferred 09:00–17:00, 10 min service, 5–40 cases.

The fleet is 12 trucks of 450, 600 or 800 cases. Each has a fixed cost of 25 OMR, 0.12 OMR/km and 4.5 km/l; fuel is
0.26 OMR/l and a driver 2.5 OMR/h. Defaults: shift from 06:00, 11 h maximum, overtime after 9 h at 4 OMR/h, 30 min reload,
3 loads per truck. The matrix is **Haversine** (×1.3, 40 km/h). There is no kg dimension, because the synthetic stops carry
no weight. Machine: AMD Ryzen 7 7445HS (6C/12T), 31 GB RAM, Windows 11, Python 3.12.13, OR-Tools 9.15.6755.

**Run as shipped** (`cd apps/solver && .venv/Scripts/python.exe scripts/bench_dispatch.py N`, all three scenarios, process-parallel):

| Stops | Wall | Scenario | Solver s | Status | Trucks | Loads | km | Op. cost (OMR) | Unserved |
|---|---|---|---|---|---|---|---|---|---|
| 60 | 12.6 s | RECOMMENDED | 8.0 | SUCCESS | 4 | 5 | 443.7 | 241.8 | 0 |
| | | MIN_TRUCKS | 4.0 | SUCCESS | 4 | 5 | 422.6 | 251.7 | 0 |
| | | MIN_DISTANCE | 4.0 | SUCCESS | 5 | 5 | 398.1 | 255.9 | 0 |
| 150 | 30.7 s | RECOMMENDED | 20.0 | SUCCESS | 8 | 9 | 805.6 | 478.6 | 0 |
| | | MIN_TRUCKS | 10.0 | SUCCESS | 8 | 9 | 805.2 | 496.3 | 0 |
| | | MIN_DISTANCE | 10.0 | SUCCESS | 8 | 9 | 743.8 | 463.7 | 0 |
| 300 | **> 240 s, killed** | – | – | The pool worker died ("terminated abruptly"), the sequential fallback then stalled | – | – | – | – | – |

**300-stop diagnosis.** A scratch script called `_solve_scenario` for one scenario at a time, on the same input:

| Run | Scenario (limit) | Status | Trucks | Loads | km | Op. cost | Unserved |
|---|---|---|---|---|---|---|---|
| A | RECOMMENDED (45 s, auto) | PARTIAL: local optimum not reached | 12 | 24 | 1,778–1,818 over 5 runs | 897–910 | **40, all P5**, `SOLVER_DROPPED_LOW_PRIORITY` |
| B | RECOMMENDED (150 s) | SUCCESS | 12 | 24 | 1,827 | 955.7 | **0** |
| C | MIN_DISTANCE warm-started from A (22 s) | SUCCESS | 12 | 26 | 1,867 | 971.2 | 0 |
| D | MIN_TRUCKS warm-started from A (22 s) | **did not return after ~190 s** (killed at 240 s wall) | – | – | – | – | – |
| E | MIN_TRUCKS cold (22 s) | PARTIAL | 12 | 25 | 1,845 | 901.7 | 60 |
| F | MIN_DISTANCE cold (22 s) | SUCCESS | 12 | 26 | 1,874 | 969.8 | 0 |

A cold start at 150 stops gives worse alternatives than a warm start (MIN_TRUCKS: 10 trucks cold vs 8 warm; MIN_DISTANCE:
857 km cold vs 744 km warm), so the warm start is worth keeping. Memory stayed at about 100 MB per process throughout.

**What the numbers say**

1. A normal NMWC day of 60–150 stops is comfortably in range. Every stop and every P1 is served, and all three options take
   13–31 s wall time.
2. At about 300 stops the **45 s auto limit is too short for the RECOMMENDED objective**. The 40 dropped P5 stops were not
   actually infeasible: runs B, C and F serve all 300 with the same fleet. They are still reported as
   `SOLVER_DROPPED_LOW_PRIORITY` ("could not be fitted…"), which misleads the planner. Fix: raise the >200-stop limit
   (the UI already polls asynchronously). Also, when the status is `…LOCAL_OPTIMUM_NOT_REACHED` and stops were dropped, say
   "not converged" instead of "could not be fitted". A fast pure-distance first phase that seeds RECOMMENDED is another option.
3. **The warm-start stall.** `SolveFromAssignmentWithParameters` for MIN_TRUCKS ignored its 22 s limit at 300 stops. The
   current guard only skips the warm start when there is a span cost, but MIN_TRUCKS has no span cost and still has soft cumul
   bounds (preferred windows, overtime). The pool has no timeout, so one stuck worker blocks the whole request. Fix: put a
   wall-clock timeout on each future and fall back to a cold solve, and/or warm-start only the pure-distance scenario.
4. The search is time-limited and not deterministic: km varies by about ±1–2% between identical runs.
5. At 150 stops MIN_DISTANCE shows a lower operating cost than RECOMMENDED (463.7 vs 478.6 OMR). RECOMMENDED also pays
   preferred-window and early-arrival penalties that "operating cost" does not include. Show the window penalty next to cost
   in the UI so the comparison is fair.

All figures use Haversine. With OSRM the km will be higher and the matrix fetch adds a few seconds, but the solve time does
not change, because the solver sees the same matrix size.

## 5a. Follow-up: fixes applied and re-measured (same day)

| Finding | Fix in `dispatch_solver.py` | Re-measured |
|---|---|---|
| Warm-started MIN_TRUCKS stalls inside `ReadAssignmentFromRoutes` (also reproduced with a real OSRM matrix on the NMWC demo day at 124 stops) | Alternatives no longer carry soft cumul costs (`soft_prefs=False`: preferred windows, early arrival and overtime apply only to RECOMMENDED). Warm start runs only when the time dimension has no cost. Alternatives run in a `spawn` pool with a **hard wall-clock deadline** (limit + 20 s grace). A worker that overruns is terminated and the alternative skipped with a warning; RECOMMENDED is never lost. Test: `test_alternative_deadline_never_loses_the_recommended_plan` | Demo day (124 stops, OSRM): the stalled run completed in 37 s. 300 synthetic: no stall |
| 45 s limit too short at ~300 stops (40 feasible P5 stops dropped as "could not be fitted") | Automatic limit is 150 s for 201–350 stops and 240 s above (150-stop days stay at 20 s). When the search stops without converging and capacity is sufficient, dropped stops say *"not planned yet: time limit reached"* plus a scenario warning. If an alternative serves more stops, RECOMMENDED carries a note pointing to it (the dispatcher decides) | **300 stops: all three options serve all 300; wall 226 s.** RECOMMENDED 12 trucks / 24 loads / 1,835 km / 958 OMR; MIN_TRUCKS 1,765 km; MIN_DISTANCE 1,774 km |
| A late order reshuffled the whole unlocked plan (116 assignments changed on the demo day) | **Plan continuity**: on a re-plan, moving a stop to another truck than in the previous version costs `change_penalty_per_stop` (3 OMR) in RECOMMENDED. Test: `test_replan_continuity_keeps_stops_on_their_previous_truck` | Demo re-plan: 16 assignments changed, 8 trucks unchanged |
| Operating-cost comparison unfair to RECOMMENDED | The plan screen shows each option's preferred-hours penalty next to its cost | — |

## 6. Recommendation

1. **Keep OR-Tools** as the MVP engine. Reasons:
   - It already implements every NMWC rule in about 740 lines of tested Python.
   - Multi-trip uses a documented OR-Tools pattern.
   - Priorities are exact penalties, so a P1 is never traded for km.
   - It runs in-process with no licence or per-run cost.
2. ~~Apply the two §5 fixes before go-live~~: **done** (§5a). Keep the 300-stop benchmark in the release checklist
   (`.venv/Scripts/python scripts/bench_dispatch.py 300`), and for any change to how locked loads are treated the re-plan
   comparison (`scripts/bench_replan.py`, §9.2).
3. **Configurable self-hosted OSRM** (already supported through `osrm_url` / `OSRM_URL`, see OSRM_SETUP.md). Run it with the
   GCC extract and `--max-table-size ≥ 400`. Calibrate `road_time_factor` against real Ayun GPS trip times, or build a truck
   Lua profile.
4. **PyVRP**: keep only behind `/optimize` for comparison. Remove the endpoint and the `pyvrp` dependency once nothing in
   `apps/web` calls it. This makes the image smaller and removes the risk from the 0.14 API break.
5. VROOM, Timefold and Google RO: no action now. Every one of them would lose at least one MVP rule (soft windows,
   penalty-priced priorities, native reloads) or add a new runtime or a per-run cost.

## 7. When to revisit

- **More than ~300 stops per depot, or several depots sharing trucks**, and even 150 s leaves stops unserved: benchmark
  PyVRP ≥ 0.14 (native reload depots; its `solve()` is iterated local search) against OR-Tools + load repack on NMWC data.
- **Interactive re-optimisation in under 5 s** (drag and drop, what-if while typing): consider VROOM as a fast
  construction engine, possibly with OR-Tools polishing the result.
- **Time-of-day traffic matters** (Muscat peak hours break windows): evaluate the Google RO API with traffic, or add
  time-dependent speeds to OSRM matrices.
- **Returnable empties / pickups** (collecting empty bottles): OR-Tools can model pickup and delivery, but re-check
  effort against VROOM and PyVRP, which support it natively.
- **Continuous real-time dispatch** (in-day reassignment, fairness, driver skills at scale): Timefold (Enterprise or
  Platform), which has pinning and freeze-time built in.
- **Planners distrust the plan quality**: run an offline comparison on real days (OR-Tools long run vs PyVRP) before
  changing the engine.

## 8. Follow-up 25 Sep 2026: fewer trucks, strict priorities, realistic timing (measured)

Branch `optimizer-fewer-trucks`. Measured with the local benchmark harness (`.dev/bench`, not in git: the real day names
customers; only aggregate numbers are given here).

### 8.1 What the harness showed on the old engine

- **Too many trucks on the real day.** NMWC's real 26-Sep day (real80: 83 stops incl. split parts, 13 trucks, no windows):
  RECOMMENDED at the default 20 s = 13 trucks / 21 loads / ~754 OMR. Re-assigning whole loads of the engine's *own*
  MIN_DISTANCE plan to trucks and departure times with exact CP-SAT gave 5 trucks / 14 loads / ~490 OMR (verified feasible in
  the engine's own model; lower bound 473.9 OMR). Cause: the routing search holds every load of a truck on one route between
  reload visits and moves one stop at a time, so it can never move a whole load to another truck; every truck kept one short
  morning load. More time barely helped (60 s: 12 trucks); MIN_TRUCKS also returned 11-13 trucks. On windowed synthetic
  days the engine was within ~0-15% of the best known plan.
- **Priorities were not strict.** With weights 10,000 / 1,000 / 100 / 10 / 1, eleven P3 stops (1,100) outweigh one P2
  (1,000); the objective's optimum drops the P2 (the search happened to keep it only because it was stuck).
- **Unserved reasons.** Guided local search always ends on its time limit *and* reports `ROUTING_SUCCESS`, so stops left out on
  a normal day got the false "could not be fitted" text; on small instances a feasible P5 stayed unserved where one more load
  would have carried it.
- **Warm start.** `ReadAssignmentFromRoutes` could stall > 100 s; `RoutesToAssignment` did not, but one warm start returned no
  solution, so a cold fallback is needed.
- **Timing too optimistic.** Service time was a fixed number per customer (a 1,100-case drop = 10 min), the depot turnaround a
  fixed 30 min and the first departure 06:00; NMWC's 24-Sep actual truck cycles were ~52% longer and trucks leave 07:10-08:00.

### 8.2 What changed

| Change | Where |
|---|---|
| Strict priorities (default): drop penalty = 1,000 OMR × w(P), w(P5) = 1, w(P) = 1 + Σ lower n_q × w(q); int64 guard | `dispatch_solver._service_values`, `DispatchConfig.strict_priorities` (web always sends `true`) |
| Post-solve load repack (CP-SAT) + exact LP timing + one scoring function + per-scenario selection + drop repair; runs in the worker pool with a deadline, falls back to the search's plans with a warning | `load_repack.py`, `dispatch_solver._post_solve` (§3 table) |
| Warm start: `CloseModelWithParameters` + `RoutesToAssignment` + `SolveFromAssignmentWithParameters`, cold fallback | `dispatch_solver._initial_assignment` |
| Honest unserved reasons: "Not planned: the optimizer found no truck, trip or time slot ... within its time limit" unless a pre-filter proved it | `dispatch_solver._build_scenario` (one builder for search and post-solve plans) |
| Turnaround = reload + `loading_min_per_case` × cases of the next load (search: 80% of a full truck; final timing: exact) | `DispatchConfig.loading_min_per_case`, `TenantConfig.loadingMinPerCase` |
| Service time = customer time + `serviceMinPerCase` × cases (split parts: proportional share, at least 5 min, + own cases; ≤ 480) | `TenantConfig.serviceMinPerCase`, `lib/dispatch/service-time.ts` |
| Settings → Dispatch timing: first departure, turnaround, loading / unloading minutes per case, max loads per truck | `settings-form.tsx`, `tenantConfigSchema` |
| Auto limit ≤ 25 stops 5 s (was 3), ≤ 80 stops 20 s (was 8) | `auto_time_limit` |

### 8.3 Validation (production mode)

`.dev/bench/opt_validate/validate.py`: the new engine exactly as production runs it (all three scenarios, automatic time
limits, worker pool), matrices from the harness cache, every returned plan re-scored by the harness's neutral evaluator
(`instances.evaluate`: feasibility and violations, and the RECOMMENDED objective on its own optimal timetable; its overtime is
counted from the shift start, so it can differ slightly from the engine's own score). Two runs per instance. For a fair
comparison the **old engine** (main, `b22a51a`) ran in the same session on the same machine (`old_engine.py`, in-process,
same automatic limits: 8 s for the 60-stop days, 20 s up to 200 stops, 150 s at 300). Machine: AMD Ryzen 7 7445HS (6C/12T),
other work running at the same time (~50-65% CPU load before the runs). OR-Tools 9.15. `real80_realism` = real80 with
service = customer time + 0.05 min/case, loading 0.04 min/case, turnaround 20 min, first departure 07:30.

**RECOMMENDED** (objective and costs in OMR; objective = neutral evaluator's RECOMMENDED objective, all stops served in every run):

| instance | old engine (same session): trucks / loads / op. cost / objective | old engine objective, earlier harness runs (min-max, n) | new engine, run 1 and run 2: trucks / loads / km / op. cost / objective | objective vs old (same session) | wall time, 3 options: new / old |
|---|---|---|---|---|---|
| real80 | 12 / 19 / 719.9 / 738.7 | 772.9-777.4 (7) | 5 / 14 / 979 / 492.4 / 531.0<br>5 / 14 / 984 / 494.9 / 534.2 | -28.1% / -27.7% | 49-53 s / 40 s |
| real80_prod | 12 / 21 / 467.2 / 477.5 | 477.5 (1) | 7 / 21 / 1,401 / 310.9 / 330.8<br>7 / 21 / 1,401 / 310.9 / 330.9 | -30.7% | 46-47 s / 40 s |
| syn60_s1 | 4 / 5 / 241.8 / 254.1 | 278.8 (3) | 4 / 5 / 444 / 241.8 / 254.1 (both) | 0.0% | 31-32 s / 16 s |
| syn60_s2 | 4 / 4 / 230.3 / 249.1 | 259.9-286.4 (3) | 4 / 4 / 396 / 231.1 / 248.3 (both) | -0.3% | 31 s / 16 s |
| syn60_s3 | 3 / 3 / 198.8 / 215.6 | 239.8 (3) | 3 / 3 / 386 / 198.8 / 215.6 (both) | 0.0% | 31 s / 16 s |
| syn150_s1 | 8 / 9 / 478.5 / 505.1 | 505.2-584.7 (5) | 8 / 9 / 805 / 478.5 / 505.1 (both) | 0.0% | 32 s / 40 s |
| syn150_s2 | 11 / 11 / 560.3 / 587.1 | 630.9-675.3 (4) | 8 / 11 / 828 / 490.5 / 531.0 (both) | -9.6% | 31 s / 40 s |
| syn150_s3 | 10 / 10 / 514.7 / 545.8 | 556.3-572.3 (4) | 8 / 10 / 755 / 464.7 / 509.0 (both) | -6.7% | 34 s / 40 s |
| syn300_s1 | 12 / 24 / 953.5 / 1,022.2 | 31-45 P5 unserved (3) | 12 / 24 / 1,807 / 950.1 / 1,018.7 (both) | -0.3% | 252-253 s / 300 s |
| real80_realism | 10 / 19 / 678.7 / 701.8 * | - | 6 / 14 / 991 / 574.0 / 596.0<br>6 / 14 / 991 / 575.3 / 594.5 | -15.1% / -15.3% | 54-57 s / 40 s |

\* The old engine cannot model loading time per case: 9 of its loads leave before the truck is loaded (20 min + 0.04 min/case
after the previous return). The new engine's plans have none.

**Alternatives** (first new run vs the old engine in the same session), trucks / loads / km:

| instance | MIN_TRUCKS old | MIN_TRUCKS new | MIN_DISTANCE old | MIN_DISTANCE new |
|---|---|---|---|---|
| real80 | 11 / 19 / 1,263 | 5 / 14 / 979 | 9 / 14 / 984 | 5 / 14 / 979 |
| real80_prod | 11 / 17 / 1,199 | 6 / 14 / 989 | 9 / 14 / 989 | 6 / 14 / 989 |
| syn60_s1 | 4 / 5 / 412 | 4 / 5 / 393 | 5 / 5 / 398 | 4 / 5 / 393 |
| syn60_s2 | 4 / 4 / 362 | 4 / 4 / 363 | 4 / 4 / 362 | 4 / 4 / 363 |
| syn60_s3 | 3 / 3 / 357 | 3 / 3 / 347 | 3 / 3 / 353 | 3 / 3 / 347 |
| syn150_s1 | 8 / 9 / 750 | 8 / 9 / 748 | 8 / 9 / 748 | 8 / 9 / 748 |
| syn150_s2 | 11 / 11 / 756 | 8 / 11 / 828 | 11 / 11 / 757 | 10 / 11 / 756 |
| syn150_s3 | 10 / 10 / 692 | 8 / 10 / 696 | 10 / 10 / 696 | 10 / 10 / 692 |
| syn300_s1 | 12 / 24 / 1,731 | 12 / 24 / 1,745 | 12 / 24 / 1,722 | 12 / 24 / 1,745 |
| real80_realism | 7 / 14 / 1,002 | 6 / 14 / 991 | 9 / 14 / 990 | 6 / 14 / 991 |

**Checks.** 60 returned scenarios (10 instances × 3 options × 2 runs): 0 evaluator violations, 0 violations of the exact
turnaround (reload + loading per case of the next load), every one reconciled (each stop exactly once, cases add up).

**Noise.** The old engine's RECOMMENDED objective varied by 5-14% between runs of the same instance at the automatic
limit (earlier harness runs under heavier CPU load plus this session; syn300 even between 31-45 dropped P5 stops and none).
The new engine varied by at most 0.6% between its two runs. On the 60-stop and syn150_s1 days, where the old engine
found the same plan in this session, the new engine is equal (±0.3%); MIN_DISTANCE km differ by up to ±1.3% either way
(the km search itself is time-limited: the stage never adds km to its plan). No instance is worse than the old engine by
more than that noise.

**Targets.** real80 RECOMMENDED: 5 trucks (target ≤ 9) and 492-495 OMR operating cost, **-34% against the old 754 OMR**
(-31% against the old engine's 720 OMR in this session), at the same 20 s search limit; within ~1% of the best plan found
by hours of offline search (527.6 objective, 5 trucks / 14 loads) and 4% above the 473.9 OMR lower bound. Wall time: at
most 57 s for the ≤ 200-stop days and 253 s at 300 stops, inside the 540 s request budget (the post-solve step took 1-2 s
on the 60-150-stop synthetic days and ~15-20 s on the real day, where CP-SAT keeps improving for longer).

**Unit tests** (`apps/solver/tests/test_repack.py`): strict priority probe (one P2 of 105 cases vs eleven P3 of 10 cases on one
110-case truck: the P2 is served), shortage ladder (strict and weighted), a crafted day where the search spreads 18 two-stop
loads over 7-8 trucks and the repack reaches the 6-truck floor (with and without a frozen load; hard windows, no overlap,
exact turnaround, frozen loads and reconciliation checked on every option), exact repack of six one-load trucks onto two,
drop repair, exact loading gap per case (and after a frozen load), repack / stage failure and a stuck stage worker fall back
to the search's plans, the warm start with time costs does not stall and falls back cold, honest reason text, int64 guard.

### 8.4 Review fixes (25 Sep 2026, same branch)

An adversarial review of the branch confirmed eleven defects. Fixed:

| Defect | Fix |
|---|---|
| Tight day, loads over 80% full, loading time per case set: every plan came back with the search's loads departing up to ~25 min before the truck could be loaded (the repack had to keep every stop the search carried) | When a search plan breaks the exact turnaround and no re-assignment keeps all its stops, it is repacked once more with every stop optional (whole loads, each load minus one stop, one-stop loads); phase 1 keeps the most strict-priority value that fits. The stops it loses get their own reason (*"Not planned: once every load was timed with the loading time between loads ..."*) and the plan a note. The search plan is kept (with a warning) only if even that fails (`load_repack.build_candidates`, `dispatch_solver._post_solve`) |
| RECOMMENDED said *"The MIN TRUCKS option serves 1 more stop(s) ... Use instead"* about an option whose times broke the loading time | Only options whose times passed the exact check are compared; `_post_solve` returns the ones that did not |
| A timed-out alternative kept its worker, so the load re-check queued behind it and RECOMMENDED lost it (review probe: 30.8 s, search plan returned as found) | Fresh workers for the re-check when an alternative overran (same probe: 9.2 s, re-check done: 5 -> 4 trucks) |
| Plan screen showed a 25-min unload as 24 or 26 min when service started at hh:mm:30 (`round()` rounds halves to even) | Minutes rounded once: departure = start + the service time sent |
| MIN_TRUCKS search (fixed cost x20) dropped a P5 stop that needed its own truck once the fixed cost reached ~50 OMR (20 x 60 > 1,000 OMR) | Drop penalties are multiplied by the scenario's largest cost multiplier (x20 for MIN_TRUCKS), within the int64 guard |
| Margin tie-break flat above 40 OMR of margin (was 4,000 OMR before strict priorities) | Smooth saturating bonus: 10x cost for small margins, never flat (50 -> ~222 OMR, 300 -> ~353 OMR of objective) |
| Drop repair skipped on fleet-shortage days: stops labelled "shortage" while loads stood free | Drop repair on every day (phase 1 is the strict ladder); a plan warns when far more cases are unserved than the shortage |
| Unserved label *"Left out (capacity/time) - lower priority"* over the honest message | *"Not planned by the optimizer - see reason"* |
| "Loads were re-assigned" note did not say that orders the search left out were added | *"...; this also plans N stop(s) the route search had left out."* |
| admin.md and in-app help had the old limits / durations; guide said "fleet capacity shortage" proves an order cannot fit | Updated |
| Tests could not fail on some of these defects | 10 new and 3 strengthened tests in `test_repack.py` (104 solver tests in all). Run against the branch before the fixes, every test aimed at one of these defects fails; the three that pass there cover paths that already worked but were untested (one failed CP-SAT solve only loses its candidate; a warm start that returns no solution solves cold; the alternatives' warm start from RECOMMENDED loads) |

**Stress days with loading time per case** (the reviewer's harness: 20 random days of 25-60 stops, 3-8 trucks of 200-400
cases, windows on ~35% of stops, frozen loads on ~35% of trucks, turnaround 20 min + 0.1-0.3 min per case; each returned
plan checked independently: capacity, windows, trips, turnaround exactly, shift, reconciliation):

| | before the fixes | after |
|---|---|---|
| days with a plan that breaks the loading time | 10 of 20 (every option on most of them) | **0 of 20** (0 of 60 options) |
| plans that had to leave out stops the search planned (lowest priority first, with the reason) | - | 6 days (1-4 stops each) |
| unserved stops, RECOMMENDED, all 20 days | 165, some of them "served" only by plans no truck could run | 176 |
| wall time per day, in-process (SOLVER_PARALLEL=0, 2 s limit) | 6-15 s | 9-19 s (the fit repacks; in production they run in parallel workers) |

*80% or 100% of a full truck for the search's turnaround estimate?* The review suggested pricing the search's reload visit at
100% (it then never under-reserves, and no plan needs the fit step). Measured on the same 20 days (RECOMMENDED; the searches
are time-limited, so single days are noisy): 100% left 166 stops / 17,410 cases unserved against 176 / 17,970 at 80%, but
more strict priority value (3.66 against 3.54 million OMR of penalty; 80% better on 5 days, 100% on 4, equal on 11), with 0
violations either way and 14% less wall time at 100%. No clear winner, so the spec's 80% stays; revisit with real NMWC days
that set a loading time.

**Validation after the fixes** (production mode, two runs, same harness and machine as §8.3; another process kept the CPU at
~65% throughout):

| instance | old engine: trucks / loads / op. cost / objective | branch before the fixes | after the fixes, run 1 / run 2 | objective after vs old |
|---|---|---|---|---|
| real80 | 12 / 19 / 719.9 / 738.7 | 5 / 14 / 492.4-494.9 / 531.0-534.2 | 6 / 16 / 521.4 / 560.1 *; 5 / 14 / 492.6 / 532.2 | -24.2% / -27.9% |
| real80_prod | 12 / 21 / 467.2 / 477.5 | 7 / 21 / 310.9 / 330.8 | 7 / 21 / 311.1 / 330.5 (both) | -30.8% |
| syn60_s1..s3 | as §8.3 | as §8.3 | identical to before (both runs) | 0.0% / -0.3% / 0.0% |
| syn150_s1..s3 | as §8.3 | as §8.3 | identical to before (both runs) | 0.0% / -9.6% / -6.7% |
| syn300_s1 | 12 / 24 / 953.5 / 1,022.2 | 12 / 24 / 950.1 / 1,018.7 | identical (both runs) | -0.3% |
| real80_realism | 10 / 19 / 678.7 / 701.8 | 6 / 14 / 574.0-575.3 / 594.5-596.0 | 6 / 14 / 574.2 / 593.9; 6 / 14 / 571.2 / 592.5 | -15.4% / -15.6% |

\* Search noise, not the fixes: in that run the MIN_DISTANCE search (code unchanged by the fixes on this day: no loading
time, no margins, no shortage) found a 1,080 km plan instead of ~979 km, so no 14-load candidate existed. An interleaved A/B
right after (3 runs each, same load): before the fixes 529.8-532.7, after 530.6-532.1, 5 trucks / 14 loads every time. Even
that run meets the targets: 6 trucks (≤ 9) and 521 OMR, -31% against 754 OMR. Checks: 60 options, 0 evaluator violations,
0 exact-turnaround violations, all reconciled. Wall time: 46-54 s for the ≤ 200-stop days, 239-244 s at 300 stops.

## 9. Stabilization PR5 (26 Sep 2026): whole-truck-day costs, release benchmark and re-plans

PR5 pays the driver for the whole truck day in the post-solve score and in every reported cost (`costing.py`), and aligns the
search for trucks with locked loads: the routing model pays the time from the last locked return to the first new departure
(a soft upper bound on the route start), the repack prices *last return - last locked return*, and the exact timing no longer
rewards a later first departure after locked loads. Fresh days are priced as before. Measured on the §5 machine (AMD Ryzen 7
7445HS, 31 GB RAM, Windows 11, Python 3.12.13, OR-Tools 9.15.6755), one run each, one version after the other. PR4 = `acb5f04`,
PR5 = branch `stab-5-costs` with its review fixes.

### 9.1 Release benchmark, 300 stops (`scripts/bench_dispatch.py 300`)

| Version | Wall | Scenario | Trucks | Loads | km | Op. cost (OMR) | Unserved |
|---|---|---|---|---|---|---|---|
| PR4 | 243 s | RECOMMENDED | 12 | 24 | 1,806.5 | 950.1 | 0 |
| | | MIN_TRUCKS | 12 | 24 | 1,740.1 | 932.6 | 0 |
| | | MIN_DISTANCE | 12 | 24 | 1,740.1 | 932.6 | 0 |
| PR5 | 251 s | RECOMMENDED | 12 | 24 | 1,806.5 | 965.2 | 0 |
| | | MIN_TRUCKS | 12 | 24 | 1,738.9 | 947.1 | 0 |
| | | MIN_DISTANCE | 12 | 24 | 1,738.9 | 947.1 | 0 |

**No change in plan quality.** RECOMMENDED is the same plan (12 trucks, 24 loads, 1,806.5 km, all 300 stops served); the
alternatives differ by 1.2 km (0.07%, inside the search's run-to-run variation). The reported cost rises by 15.1 OMR (+1.6%)
only because the depot turnaround and the waiting between loads are now paid. The 150-stop day gave the same plan on both
versions too (8 trucks, 9 loads, 805.3 km; 478.5 -> 479.8 OMR). Wall time stays inside the 540 s request budget.

### 9.2 Re-plans around locked loads (`scripts/bench_replan.py`)

The 300-stop day has no locked loads, so it cannot show the re-plan change. `scripts/bench_replan.py` builds two shapes of 8
days each (60 stops with seeds 1-5 and 150 stops with seeds 1-3; the §5 fleet and rates, overtime after 8 h at 1 OMR/h; all three
options, production worker pool). Both versions re-plan exactly the same requests, and the money of both is priced on one model
(PR5's whole-truck-day costing of each version's new loads; the locked loads are the same for both):

- **late**: the day is planned once, every truck's first load is locked, its stops leave the day; the other stops stay with the
  truck they were on (plan continuity) and 6 or 15 late orders (P1-P3) are added. The late-order re-plan;
- **half**: 6 of the 12 trucks have a locked first load 06:00-09:30; the whole day plus the late orders is planned around them.

| Shape (8 days) | Version | Unserved | New loads | km (new loads) | Cost of new loads (OMR) |
|---|---|---|---|---|---|
| late | PR4 | 0 | 14 | 1,350.6 | 561.4 |
| | PR5 | 0 | 14 | 1,359.3 | 585.4 |
| half | PR4 | 0 | 69 | 5,365.2 | 2,594.6 |
| | PR5 | 0 | 66 | 5,213.0 | 2,578.7 |

- **late**: the same plan on 7 of 8 days. On one (150 stops, seed 2: 61 stops to re-plan) PR5 puts a new load on an unused
  truck instead of a second load on a locked one: 143.4 against 119.4 OMR (+24.0 OMR, one truck's fixed cost). Two repeats
  gave the same result.
- **half**: PR5 is cheaper on 3 days (-13%, -6%, -5%) and dearer on 5 (+1%, +8%, +0.4%, +10%, +6%); in total 0.6% less money,
  2.8% fewer km and 3 loads fewer.
- No stop is left unserved on any day, by either version.
- Run-to-run variation of one version on one machine is about 1% km, so a single day is not a verdict; the per-day swings
  above are the two searches finding different plans.

**Cause of the late-order day, and why the release keeps the alignment.** An experiment with PR5 minus the routing model's soft
bound on the start of trucks with locked loads (the one change to the search model) found PR4's 119.5 OMR plan on that day and
the same plans on the other late days, but made the *half* shape 1.6% dearer (2,618.8 against 2,578.7 OMR). Over all 16 days
the totals are within 0.8% of each other: PR4 3,156.0, PR5 3,164.1, PR5 without the bound 3,180.3 OMR. Neither variant is
better on both shapes, so PR5 keeps the owner's rule (the driver is paid for the whole truck day in the search as in the report).

**Follow-up** (not in PR5): measure again on NMWC's real re-planned days once production has plans with locked loads. If the
late-order case shows up there, one search without the start bound can be added as an extra candidate: the post-solve score
already prices every candidate on the whole-day model, so it would only be chosen when it is cheaper.

## 10. Audit PR A6 (29 Sep 2026): solver and plan-output accuracy, main vs the branch

A6 changes what the optimizer compares and chooses: weights in 0.1 kg with no hidden margin (F08), only new overtime for a
truck with locked loads (E4), and a load repack that never gives up before its first answer (E5); the rest of A6 is output only
(loading-sheet kg, option wording, cost per case, the depot origin of locked loads). The assessment asked for a comparison on
the five synthetic scenario days and one real day, **priority service first, then cost** (owner decision 26).

**Method.** Same machine as §5 (AMD Ryzen 7 7445HS, 12 threads, 31 GB RAM, Windows 11; Python 3.12.13, OR-Tools 9.15.6755),
each version with its own web app (Next.js dev server) and solver (production worker pool), on its own database, one version at
a time: **main** `3451f4d` (web :3011, solver :8011, database `routeiq_p6_base` migrated with main's migrations) first, then
**the branch** (web :3009, solver :8009). Every day was run **twice per version** in fresh companies set up through the web API:

- the five synthetic days S01-S05 (plus S04b, S04's balanced variant) of the scenario harness (`.dev/scenarios/harness-final`,
  the order files `S01_Orders.xlsx` ... `S05_Orders.xlsx`, delivery 4-8 Oct 2026; straight-line distances x 1.3 at 40 km/h),
  from a copy with two changes made for both versions alike: OPTIMIZE passes "optimize anyway" for missing locations (A5 refuses
  S01's one customer without a location otherwise), and S04 uploads its Orders sheet alone (the two-sheet workbook is refused
  since B2). S04 and S04b plan a morning (v1), lock and dispatch its loads, add late orders and re-plan (v2);
- the real NMWC day: the 28 Sep order file (373 lines, 80 customers, 46 products, 13 trucks, NMWC's rates and settings),
  moved to 15 Oct 2026 for both versions (a future day, so the same-day "plan from now" rule does not apply), through a copy of
  `.dev/realdata/run-test.mjs` that writes only its own folder.

Every figure is the plan in use (RECOMMENDED), read back from `GET /api/runs/:id/plan` and the job's stored optimizer
response: orders served per priority, unserved orders with their reason codes, trucks, loads, km and cost of the whole day, the
option's own timing check and the optimizer's time (search + post-solve stage). No customer names; km and costs are estimates on
synthetic points or approximate real pins. Every option of every run (RECOMMENDED, MIN TRUCKS, MIN DISTANCE) was VERIFIED too.

**Caveat on this run.** Other work used the same PC during both versions' runs (the load sampler logged 100 % CPU almost all the
time; three optimizer research jobs and another branch's build ran alongside). OR-Tools' searches are time-limited, so their plans
depend on free CPU. The two runs of a version give the same plan on S02 and S04 (both versions), on S01, S03 and the real day
for main, and on S04b for the branch. They differ a little on the branch's S03 (0.2 km) and main's S04b (0.1 km), and more on
S05 (both versions), the branch's S01 and the branch's real day (6 trucks, 556.14 OMR against 5 trucks, 543.03 OMR). So the
controlled replay of 10.2 was added to tell the code from the machine.

### 10.1 The web API runs (harness and real day, two runs per version)

Each cell of a run is trucks / loads / km / cost in OMR for the whole day (a re-plan: the kept loads included). Every plan passed its own timing check (VERIFIED).

| Day | Orders served P1 · P2 · P3 · P4 · P5 (every run) | Unserved (reason) | main run 1: trucks / loads / km / OMR | main run 2 | branch run 1 | branch run 2 | Timing | Optimizer s (main; branch) |
|---|---|---|---|---|---|---|---|---|
| S01 normal day, Muscat | 5/5 · 23/23 · 94/94 · 59/60 · 18/18 | 1 (1 MISSING_COORDINATES) | 7 / 11 / 565.8 / 242.90 | 7 / 11 / 565.8 / 242.90 | 7 / 12 / 529.6 / 238.56 | 6 / 12 / 477.2 / 207.26 | VERIFIED | 163, 168; 156, 162 |
| S02 heavy day, Sohar (split deliveries) | 9/10 · 15/15 · 93/93 · 50/50 · 27/27 | 1 (1 EXCEEDS_ANY_TRUCK_CAPACITY) | 7 / 20 / 483.7 / 233.05 | 7 / 20 / 483.7 / 233.05 | 7 / 20 / 461.7 / 230.40 | 7 / 20 / 461.7 / 230.40 | VERIFIED | 188, 180; 188, 181 |
| S03 weight-bound shortage, Salalah | 12/13 · 24/24 · 64/64 · 9/70 · 0/69 | 131 (1 HARD_WINDOW_INFEASIBLE, 130 SOLVER_DROPPED_LOW_PRIORITY) | 6 / 6 / 340.7 / 190.88 | 6 / 6 / 340.7 / 190.88 | 6 / 6 / 337.5 / 190.50 | 6 / 6 / 337.3 / 190.48 | VERIFIED | 172, 165; 159, 153 |
| S04 re-plan with locked + dispatched loads, Nizwa | 11/11 · 40/40 · 114/115 · 46/47 · 17/17 | 2 (2 MISSING_COORDINATES) | 6 / 11 / 452.4 / 204.30 | 6 / 11 / 452.4 / 204.30 | 6 / 11 / 427.4 / 201.29 | 6 / 11 / 427.4 / 201.29 | VERIFIED | 144, 140; 136, 128 |
| S04b the same, balanced locked loads | 11/11 · 40/40 · 114/115 · 46/47 · 17/17 | 2 (2 MISSING_COORDINATES) | 7 / 12 / 508.8 / 236.05 | 7 / 12 / 508.7 / 236.05 | 6 / 11 / 479.3 / 207.52 | 6 / 11 / 479.3 / 207.52 | VERIFIED | 146, 142; 137, 132 |
| S05 data problems, Muscat | 9/9 · 42/42 · 158/158 · 94/96 · 35/35 | 2 (2 INVALID_CUSTOMER) | 11 / 19 / 1,134.0 / 411.07 | 12 / 18 / 1,290.1 / 454.82 | 11 / 18 / 1,320.5 / 433.47 | 12 / 16 / 675.2 / 381.03 | VERIFIED | 186, 178; 172, 164 |
| Real NMWC day (28 Sep orders) | 0/0 · 26/26 · 51/51 · 3/3 · 0/0 | 0 | 6 / 17 / 1,172.3 / 595.63 | 6 / 17 / 1,172.3 / 595.63 | 6 / 14 / 1,011.3 / 556.14 | 5 / 14 / 997.2 / 543.03 | VERIFIED | 50, 51; 51, 43 |

### 10.2 The same requests replayed back to back (controlled)

Because the machine's load changed between the versions' runs, each day's stored optimizer request from run 1 (main's request
on main's solver, the branch's request on the branch's solver: the same orders, the web of each version) was also solved again
in-process (`SOLVER_PARALLEL=0`), one after the other, day by day, at the same load, with the branch's final code (including the
E5 follow-up below). Re-plans count their new loads only here.

| Day | Unserved stops by priority (main = branch) | main: trucks / loads / km / OMR | branch: trucks / loads / km / OMR | Cost change | Timing | Optimizer s (main; branch) |
|---|---|---|---|---|---|---|
| S01 normal day | none | 7 / 11 / 565.8 / 242.90 | 7 / 12 / 503.3 / 235.40 | -3.1 % | VERIFIED | 158; 155 |
| S02 heavy day | none | 7 / 20 / 470.3 / 231.44 | 7 / 20 / 461.7 / 230.40 | -0.4 % | VERIFIED | 189; 170 |
| S03 weight-bound shortage | P1 1, P4 61, P5 69 | 6 / 6 / 340.7 / 190.88 | 6 / 6 / 337.3 / 190.48 | -0.2 % | VERIFIED | 155; 154 |
| S04 re-plan (new loads) | none | 6 / 9 / 414.7 / 149.76 | 6 / 9 / 389.7 / 146.76 | -2.0 % | VERIFIED | 129; 129 |
| S04b re-plan (new loads) | none | 7 / 10 / 468.5 / 181.22 | 6 / 9 / 439.0 / 152.68 | -15.7 % | VERIFIED | 132; 133 |
| S05 data problems | none | 11 / 16 / 692.3 / 358.08 | 11 / 16 / 707.1 / 359.85 | +0.5 % | VERIFIED | 180; 173 |
| Real NMWC day | none | 5 / 14 / 1,003.1 / 545.04 | 5 / 14 / 997.2 / 543.03 | -0.4 % | VERIFIED | 45; 47 |

### 10.3 Verdict

- **Priority service: never worse.** Every day, in every run of both versions, serves the same number of orders per priority (P1
  to P5) and leaves the same number unserved per priority and reason; the replays store the unserved count per priority only, and
  it is the same too. The orders themselves are the same on every day but S03: there both versions leave out 61 P4 orders, and 5
  of them differ (main leaves out 5 P4 orders the branch serves, and the branch 5 others that main serves). The branch then carries
  4 cases more (3,492 against 3,488). Both runs of each version leave out the same orders. Nothing to explain or fix under owner
  decision 26 (corrected by the second A6 review: this line said "exactly the same orders").
- **Cost: lower or equal on six of seven days, the seventh inside the search's variation.** In the replays the branch is cheaper
  on S01 (-3.1 %), S02 (-0.4 %), S03 (-0.2 %), the S04 re-plan (-2.0 %), the S04b re-plan (-15.7 %: one truck and one load fewer)
  and the real day (-0.4 %), and 0.5 % dearer on S05 (same trucks and loads, 15 km more). S05 is the day on which main's own two
  web runs differed by 10.6 % (411 and 455 OMR), so 0.5 % is the time-limited search finding another plan, not a rule. Over all
  seven replayed days the branch costs 1,858.6 OMR against 1,899.3 OMR (-2.1 %).
- **Why the plans differ.** The web runs had overtime unpriced on the synthetic days and no locked loads on the real day, so E4
  (only new overtime) does not act here; its effect is shown by the unit tests (a locked truck in overtime gets the new load for
  about 3 OMR instead of an idle truck for 6 OMR). The loads of these days are mostly case-bound, so F08's exact weights change the
  route search's arithmetic more than its choices: the search follows a different path and, on S04b, consistently finds a plan
  with one load and one truck fewer. The real day's large gap in the web runs (595.6 against 556.1 and 543.0 OMR) is mostly the
  machine: replayed back to back, main's request gives 545.0 OMR and the branch's 543.0.
- **Time.** The optimizer's own time is within 3 s of main's on every day and lower on most (its search limits did not change;
  E5 lets a repack run until its first answer, inside the same stage budget); the web runs' wall times moved with the machine's load. No solve came near the 540 s request budget.
- **E5 in practice.** In the branch's first real-day run one repack was given 0.6 s and ended UNKNOWN: its phase 1 ran past its
  40 % on the loaded machine and phase 2 was left a few hundredths of a second (the plan it started from stayed a candidate, and the
  day's plan came from another source's repack). The follow-up gives phase 2 at least 60 % of the solve's limit, at most 0.5 s
  (`load_repack.repack`, test `test_repack_phase_two_keeps_a_real_chance_when_phase_one_overran`); the replays ran with it and no
  repack ended without an answer. Main's logs show no UNKNOWN repack on these days either (its watchdog problem needs a first answer
  later than 1 s, as on the verifiers' tight 300-stop day).
- **Loading sheets.** In every saved workbook checked (S02, S03, both versions) each load sheet's manifest kg equals the load's
  kg. These synthetic days have no product weight corrected after planning and no order weighed at order level, so E3's change is
  shown by its unit tests, not here.

### 10.4 After the A6 review (no re-run needed)

The review of the branch changed the solver in two ways, and neither changes a plan:

- **The "no room" reason counts only stops of the same or a higher priority.** It decides the words of an unserved stop and
  whether the plan warns "no check proves they are impossible"; the route search, the repack, the timing and the choice between
  plans are the same code. It can only turn a "no load or free trip has room ..." reason into the search's own reason, or reword
  it. No stored answer of the branch has such a reason: in both of its web runs, on every day (S01-S05, S04b and the
  real day), the stored reasons are the web's own checks (a missing location, a deactivated customer, an order heavier than
  any truck), S03's unreachable window and fleet shortage (the shortage reason is decided before the "no room" one), and none on
  the real day (every order served). No stop has the search's own "found no truck, trip or time slot" reason either.
- **Each option reports the rules it was made with** (`weight_unit_kg` 0.1, `new_overtime_only`), which only the ASSUMPTIONS
  sheet reads.

So the tables of 10.1 and 10.2 stand for the reviewed branch. The web changes of the review (the depot note's distances, the
manifest's kg on screen, the day out of date for older planned loads on a moved depot pin, the ASSUMPTIONS rows of older plans)
change what is shown, not what is planned.

### 10.5 After the second A6 review (no re-run needed)

The second review changed the solver once, and it does not change a plan either:

- **The "no room" reason needs a proof.** A stop gets "no load or free trip has room ..." only when a check also proves that no
  other packing of the stops of its priority or higher could carry it (together they are more than all trips carry, or more of
  them are over half the biggest truck than there are trips). Otherwise it keeps the search's own reason and the plan's warning.
  This decides words and a warning only, and 10.4 found no such reason in any stored answer, so nothing on these days changes.
- **"Lowest priorities first"** is said only on a day that has lower-priority stops.

The web change (a note under an older version's loading manifest when a later re-plan re-weighed its orders) is shown, not
planned. The tables of 10.1 and 10.2 stand; only the wording of 10.3's priority line and of the caveat above was corrected.

The review also recorded an older limit, on main as on the branch: on a tight day where every trip is used, the route search can
leave a stop out although another packing carries every stop (1,000 + 1,500 + 1,500 + 1,000 + 1,000 kg on two 3,000 kg trucks
with one load each). It does not appear on these days, since NMWC's trucks do several trips. It is a follow-up in the handbook's
7.5.

### 10.6 After the third A6 review (no re-run needed)

The third review changed tests only, not the optimizer or the web:

- **The repack's phase-limit test** now checks each phase's time limit from the moment the phase started: phase 1 ends by the
  solve's limit, and phase 2 does too unless phase 1 ran long, when it still gets 60 % of the limit (at most 0.5 s). The old test
  failed at random on a busy machine; the repack itself is unchanged.
- **Two new tests** pin rules that were already in the code: the "no room" reason counts only the stops of the same or a higher
  priority, and two options with the same plan beside a broken one are not "the same plan as the other options".

No plan can change, so the tables of 10.1 and 10.2 stand.

## 11. Long searches: THOROUGH mode and its stopping rule (29 Sep 2026)

Measured on the long-search branch before audit PR A6 (§10) was merged into it (30 Sep 2026): the runs below were made
without A6's weight, overtime and load re-check changes; THOROUGH was not re-measured with them.

Owner request: *"make sure the solver is giving an optimal solution even if it runs for 20 mins."* Owner decision: *night
plans long, day re-plans quick*. The engine now has two search modes (`config.search_mode`; handbook 2.7 and 4.9):

- **QUICK**: the automatic search time by day size (§8, PR7), exactly as before.
- **THOROUGH**: the whole request may take up to `THOROUGH_MAX_SEC` (1,200 s). RECOMMENDED searches until a tail kept for the
  alternatives and the load re-check, and **stops early once it stops improving**: when its best plan has not improved for
  **max(300 s, 0.5 × the time searched so far)**, never before QUICK's time for the day.

No search proves the plan is the best possible one: guided local search computes no bound, so the screens say how long it
searched and why it stopped, never "optimal", and no gap is stated.

Measured with the local harness (`.dev/bench`, used read-only: its instances and cached matrices, with this branch's solver
first on `sys.path`; scratch scripts outside the repo). Machine as in §9 (AMD Ryzen 7 7445HS, 6 cores / 12 threads, OR-Tools
9.15.6755, Python 3.12.13), **heavily loaded**: 5 runs in parallel plus other work (CPU at 75-100%), so absolute times are
pessimistic, roughly × 2. Only aggregate numbers of the real day (real80: NMWC's day of 26 Sep, 83 stops) are given.

### 11.1 How long does the search keep improving? (1,200 s traces)

RECOMMENDED alone, in-process, 1,200 s, every improving solution recorded (time, objective). "Above its end" = how much worse
the best plan found by then was than the best plan found in 1,200 s, in OMR of the search objective (money plus preference
penalties; 1,000 OMR or more means stops were still unserved).

| run | stops | QUICK time | last improvement | longest time without improvement (from) | above its end at 20 s / 60 s / 300 s / 600 s (OMR) |
|---|---|---|---|---|---|
| syn60_s1 | 60 | 20 s | 721 s | 501 s (721 s) | 6.3 / 6.3 / 0.7 / 0.1 |
| syn150_s1 | 150 | 50 s | 321 s | 885 s (321 s) | 17.0 / 7.5 / 4.2 / 0.0 |
| syn150_s2 | 150 | 50 s | 448 s | 759 s (448 s) | 106.4 / 70.2 / 19.6 / 0.0 |
| syn150_s3 | 150 | 50 s | 710 s | 516 s (710 s) | 78.5 / 53.6 / 28.2 / 5.4 |
| syn300_s1, run 1 | 300 | 150 s | 881 s | 329 s (881 s) | 65,000 / 40,048 / 1,015 / 3.6 |
| syn300_s1, run 2 | 300 | 150 s | 741 s | 485 s (741 s) | 64,993 / 40,001 / 10.5 / 1.9 |
| real80, run 1 | 83 | 20 s | 702 s | 509 s (702 s) | 220.2 / 185.1 / 152.0 / 29.6 |
| real80, run 2 | 83 | 20 s | 1,142 s | 428 s (709 s) | 245.0 / 210.2 / 176.8 / 55.7 |
| real80 (straight-line matrix) | 83 | 20 s | 1,094 s | 311 s (476 s) | 206.3 / 148.6 / 67.8 / 32.7 |

The searches keep finding improvements well past 10 minutes, after long quiet stretches (real80 was quiet for 428-509 s and
then improved again). The search is deterministic (§5), so two runs of one instance differ only in how far the loaded machine
let it get.

### 11.2 Which stopping rule?

Each rule replayed on the nine traces above, and on the 18 older 120-600 s traces of the 25 Sep engine benchmark
(`.dev/bench/ortools/results/runs.jsonl`, read-only). "Loss" = search objective at the stop minus at the end of the run.

| rule: stop after this long without improvement | 1,200 s traces: runs that lost / worst loss | older traces: runs that lost / worst loss | time saved, 1,200 s traces (mean) |
|---|---|---|---|
| max(90 s, 15% of the time searched) (first proposal) | 9 of 9 / 176.8 OMR (real80 stopped at 278 s) | 5 of 18 / 117.6 OMR | 74% |
| max(180 s, 33%) | 5 of 9 / 32.7 OMR | 2 of 18 / 117.6 OMR | 39% |
| max(240 s, 50%) | 2 of 9 / 19.6 OMR (syn150_s2 stopped 3 s before a better plan) | 0 of 18 | 19% |
| **max(300 s, 50%)** (chosen) | **0 of 9** | **0 of 18** | 8% |
| max(360 s, 50%) | 0 of 9 | 0 of 18 | 8% |

Only rules that wait at least 300 s and half the search so far lost nothing, anywhere. The chosen rule stops the small
syn150 days at 642 s and 896 s; the real day and the 300-stop day run to the cap. So **THOROUGH usually uses most of the 20
minutes on NMWC-sized days**; stopping early mainly saves time on days that are easy for the search. The values can be tuned
without a release: `THOROUGH_STALL_SEC`, `THOROUGH_STALL_SHARE`.

**How the stop is made.** An at-solution callback records the best objective and, when the rule says so, calls
`Solver.FinishCurrentSearch()`: probes on syn60_s1 and real80 ended the search within 13 ms and 2 ms of the solution that
triggered it, returning the best plan found (objective equal to the best recorded). A `CustomLimit` (checked by OR-Tools on
every search node) was measured and rejected: it was called 35,000-110,000 times a second and cost 3-12% of the solutions
found in 30 s (real80: 592 and 579 solutions without it, 537 and 534 with it; syn150_s1: 488 and 487 against 478 and 468;
throttling the check inside it did not help, the call itself is the cost). The callback is called only for accepted solutions
(16 a second on real80, 1-2 a second at 300 stops), so the stop check costs nothing measurable.

**The progress points are a score, not money (skeptic review of the long-search PR).** The report keeps up to 12 points of
the best search objective over time. That objective holds a large penalty (1,000 OMR or more on real days) for every stop the
plan has not planned yet, so on a short day the first points are in the thousands: `nmwc_day(40)` with 2 trucks went
7,145 → 1,128 while the stops left out went 7 → 1, and a 40-stop day that ends with every stop served (about 170 OMR)
started at 7,226. The Excel sheet had called these figures "in the currency". Each point now also carries the number of stops
not planned yet, counted in the callback on each improvement (the stops whose successor is themselves). Measured in-process,
THOROUGH, 20 s searches, the callback's whole time with and without the count: 200 stops 0.125 s against 0.018 s over 390
improvements (about 0.3 ms each); 350 stops 0.041 s against 0.005 s over 96 (about 0.4 ms each). That is under 0.6% of the
search; QUICK has no callback at all.

### 11.3 What it buys: QUICK against THOROUGH, as production runs them

All three options, worker pool, load re-check, the same cached matrices. THOROUGH with the 1,200 s cap and the chosen rule;
QUICK with its automatic time. Objective = the RECOMMENDED objective after the load re-check (OMR).

| day | QUICK: trucks / loads / km / op. cost / objective, wall | THOROUGH: trucks / loads / km / op. cost / objective, wall (stop) | objective |
|---|---|---|---|
| real80 (83 stops) | 6 / 17 / 1,101 / 544.6 / 573.1, 63 s | 5 / 14 / 985 / 503.5 / 525.8, 1,101 s (cap; last improvement 696 s) | -8.3% |
| syn150_s2 (150 stops) | 8 / 11 / 828 / 494.3 / 531.9, 85 s | 8 / 12 / 805 / 484.7 / 517.8, 1,061 s (cap; last improvement 516 s) | -2.7% |
| syn300_s1 (300 stops) | 12 / 25 / 1,779 / 954.6 / 1,078.4, 274 s | 12 / 24 / 1,672 / 908.6 / 957.7, 1,101 s (cap; last improvement 966 s) | -11.2% |

Every plan served every stop and passed the independent timetable check (VERIFIED). The whole THOROUGH request took
1,061-1,101 s, inside the 1,200 s cap, with RECOMMENDED's search limit at 969-984 s (the rest: the road matrix, the
alternatives, the load re-check). On the real day THOROUGH found one truck and three loads fewer, about 41 OMR a day less
operating cost. QUICK on the real day has also found 5 trucks / 14 loads on a lighter-loaded machine (§8.3: objective 531-534):
QUICK's 20 s depend on how fast the machine is at that moment, THOROUGH's result much less.

RECOMMENDED alone (in-process, the load re-check on its own plan only): QUICK against the 1,200 s traces of §11.1 gave
objective -13.3% on the real day (QUICK 7 trucks / 21 loads, 608 objective, against 5 / 14, 525-529), -14.6% on its
straight-line variant, -1.5% to -3.1% on the synthetic 60- and 150-stop days, and on syn300_s1 QUICK left 7 and 10 stops
unserved where 1,200 s served all (the QUICK runs shared the machine with three 20-minute runs: pessimistic).

**QUICK unchanged.** QUICK sends the same search parameters, time limits and budgets as before (pytest
`test_search_modes.py`: the limits and budgets of the old formulas over a grid, the OR-Tools parameters of a QUICK solve, and
nothing attached to its search), and its report says `TIME_LIMIT`. On the harness, the solver before this change (`3451f4d`)
and after it, alternated twice, all three options in-process: the same OR-Tools calls (parallel cheapest insertion + guided
local search, 20 s for RECOMMENDED and 10 s for each alternative, on both days); syn60_s1 objective 254.5 / 254.5 before and
255.0 / 254.5 after; the real day 574.1 / 537.3 before and 569.3 / 562.3 after (5-6 trucks, 14-17 loads either way: the
real day's 20 s search depends on the machine's load at that moment, as in §8.4).

**Open.** No trace is longer than 1,200 s. The Railway solver's CPU is not known (handbook 7.5): at 1 vCPU a THOROUGH search
next to a QUICK one shares the core, which lowers both searches' quality (their limits are wall-clock), never their deadlines.
Re-measure on the production solver once it runs THOROUGH plans (the saved search reports hold the best objective over time).

### 11.4 Review of the long-search PR: caps below 20 minutes, and same-day plans

**Caps below 20 minutes.** The tail RECOMMENDED leaves free (the alternatives + 20 s grace + the load re-check: 195 s for
days up to 120 stops) was cut to 30% of a smaller cap, but the alternatives were still charged the full re-check reserve
(115 s). Under about 7 minutes they were therefore always skipped, and the recommended plan was the only option.
`thorough_tail` now shrinks the alternatives' limit and the re-check's time per CP-SAT solve together, in proportion, never
below QUICK's (half the search limit; min(15, max(3, limit / 2))), and `_run_scenarios` keeps exactly the re-check time the
tail kept. Synthetic 60-stop day (`nmwc_day(60)`), all three options, worker pool, straight-line matrix, the maintainer's
machine:

| cap | before: options, RECOMMENDED limit, time used | after: options, RECOMMENDED limit, alternatives' limit, time used |
|---|---|---|
| 150 s | RECOMMENDED only ("alternatives skipped"), 83-84 s, 97-113 s | all three, 44 s, 10 s, 58 s |
| 300 s | RECOMMENDED only ("alternatives skipped"), 188-189 s, 194-198 s | all three, 189 s, 15 s, 209 s |
| 1,200 s | unchanged (the tail is below 30% of the cap: 60 s alternatives, 30 s per re-check solve) | unchanged |

QUICK on the same day: all three options in 44-47 s. What stays unused is the margins (the 20 s before the alternatives,
their 20 s grace, the re-check's 20 + 5 s grace and whatever part of its time it does not need), as at 20 minutes (§11.3:
1,061-1,101 s of 1,200). A pytest checks the arithmetic for every cap from 60 s to 60 min and every day size (the
alternatives always get their share once RECOMMENDED searched longer than QUICK), and a 90 s cap end to end. Below a cap
of about 2-2.5 min for days up to 120 stops, 4.5-5.5 min at 175, 5.5-7 min from 200 to 350 and 8-9.5 min above 350 (the
higher figure with the slowest road matrix: the smallest cap at which `rec_limit_sec` gives RECOMMENDED more than QUICK's
limit, for every day size; skeptic review - the figures here were lower) THOROUGH searches no longer than QUICK and may
still skip the alternatives: production keeps 10 minutes or more (default 20). The stall rule is
unchanged: with a cap under about 9 minutes the recommended search rarely runs 5 minutes without improving, so it usually
ends at its limit and says so ("all the time allowed").

**Same-day plans.** A same-day plan starts from now (turnaround and loading counted from the button press; since 7 Oct 2026, ISSUE 6, from when its search really starts, after any wait in the queue - Quick and Thorough). A THOROUGH search
first takes up to its cap: the review measured a small synthetic same-day day that converged after about 6 minutes (the plan
existed at 14:58 for a 14:52 press, its first load planned at 15:25: 7 of the 30 preparation minutes gone), and the real day
takes 1,061-1,101 s (§11.3: about 18 minutes gone); queued behind another THOROUGH, departures were planned before the plan
existed. A same-day THOROUGH is now timed from the start of its search + the cap (the job re-times it when it really gets its
slot): at 1,200 s, no new load before start + 20 min + the turnaround. That is conservative when the search stops early (the
loads could have left up to about 15 minutes sooner); QUICK, the suggested choice on the delivery day, is unchanged.

## 12. A second search: PyVRP (30 Sep 2026)

Owner direction: *"enhance our model by using techniques from the best open-source solver on the standard public sets. We
don't need to invent something new now."* PyVRP's published solver (iterated local search, the library as released, default
parameters) now searches every day beside the engine's own RECOMMENDED search. It adds no new search algorithm. Build spec
and prototype: `.dev/bench/pyvrp-enh/SPEC.md` (with the two skeptic reviews' corrections, all applied here).

### 12.1 How it works

- **Where.** `apps/solver/pyvrp_candidate.py`. PyVRP runs in a worker process of its own (one spawn process and its
  pipes, no pool: `dispatch_solver._PvProcess`), started after rule 22's check of the engine's pool and never part of
  it: if it cannot start, the solve goes on with the engine alone (SKIPPED / NO_PROCESS). It is submitted right after
  RECOMMENDED, so the engine never waits behind it. It answers with plain Python data only (an error as text), and the
  solve kills, joins and releases it - with the engine's pools, their queues, locks and processes - before it returns:
  nothing is left for the garbage collector (CI, PR #50: a segmentation fault while it ran in the API's event loop).
- **The model.** The same day the engine searches (after its prefilters), with every price from the engine's own
  functions, in its units: vehicle types of interchangeable trucks, cases and 0.1 kg units, hard windows (with unloading
  finished by closing, §13, the latest start is closing - stop time, as in the engine), truck hours (frozen loads,
  same-day loading, the latest return), loads per truck as reload depots with the search's turnaround, the shift maximum
  (a truck-day that may need the driver break keeps its length free, as the engine's own search), driver
  pay for the truck day and overtime past `overtime_after_min` (only new overtime on trucks with frozen loads), km per rate
  class, trip cost per load, plan continuity per truck, and every stop optional with the engine's own strict-priority drop
  penalty as its prize. Nothing holds a time of day: shift start, shift maximum, overtime threshold, depot and truck hours
  come from the request (Settings). The owner's day, 07:00-18:00 with 18:00 the latest return and overtime as set, is
  expressed by the depot or truck closing time (a test checks it) or, since §13, by the latest return in Settings.
- **What it cannot see** (the judge prices all of them exactly): the early-arrival preference of P1/P2 (so its plans may
  deliver them later inside their hard windows when that saves more money than the preference is worth); preferred windows
  (tightened into the hard window when they carry a price and the two overlap, "prefhard"); the loading time per case of
  the next load (80% of a full truck, as the engine's own search); the driver-pay anchor of trucks with frozen loads; the
  driver break itself (§13: the exact timing places it and the check holds this search's plans to it, as the engine's).
- **When it stops.** QUICK: when the engine's searches end (the alternatives are in), within about 0.3 s; the answer is
  awaited at most `SOLVER_PYVRP_STOP_GRACE_SEC` (10 s) and never past the engine's stage reserve. THOROUGH (decision D3):
  while the engine searches, it searches too (that costs no waiting); once the engine's searches ended, it stops when its
  last better plan is older than max(30 s, 10% of its search time so far) - at once when it has not improved for that long,
  never before QUICK's time for the day - or at the load re-check's reserve, a stop request or a cancel
  (`SOLVER_PYVRP_STALL_SEC` / `SOLVER_PYVRP_STALL_SHARE`, development only). The first rule, 300,000 iterations without a
  better plan, never triggered: at the measured 57-171 iterations/s that is 29-87 minutes, so every Thorough solve waited for
  it until the reserve. Its answer is always collected before the engine's pool may be closed.
- **The judge.** Its plan is checked (indices, each stop at most once, loads per truck, cases and kg per load: otherwise
  INVALID_PLAN), then enters the post-solve stage as one more source. The engine's own sources, repair weights, time budget
  and stage jobs are built exactly as without it; the second search's repack (RECOMMENDED's prices, and MIN_TRUCKS' when that
  option exists) runs as a separate job in its own process, with at most the engine's job budget, so a repack of it that
  overruns or dies only loses its own candidates. Its candidates join the pick after the engine's; a tie keeps the option's
  own source, then any engine source, and so does a gain too small to show: its plan is used only when it plans more, or
  on the option's own goal saves at least 1 OMR (Recommended: the total cost with the customer time preferences), 1 km (Min
  Distance), or a truck, a load or 1 OMR of operating cost (Min Trucks). A pick of it that is not VERIFIED is replaced by
  the engine's (a WARNING line). An option whose own search found no plan takes the second search's best plan for its goal,
  with the status `SECOND_SEARCH` ("plan from the second route search"), not the failed search's "no plan found".
- **The promise, precisely.** For every option, the chosen plan is never worse on that option's goal (unserved priority value
  first, then cost) than the plan the engine alone would have chosen **from the same search**. It is not a promise against a
  separate engine-only run: the second search takes CPU from the engine's own search, which matters only on a machine short of
  cores (the CPU gate keeps it off below `SOLVER_PYVRP_MIN_CPUS`, 2; Railway's solver has 24 vCPU). CP-SAT repacks are
  time-limited, so the test of the promise makes them deterministic (one worker, no clock-driven stall stop) on days where
  every repack ends OPTIMAL (`test_hybrid_never_worse_than_engine_alone_on_the_same_seed`, five days).
- **What the dispatcher sees** (decision D4): one note, on the option whose plan came from it, compared with the engine's
  own final plan for that option (after its load re-check). "Better" names the option's own goal only; trucks, loads, km and
  operating cost follow neutrally, when they changed. Min Distance: *"A second route search found a better plan for this
  option than the main search: fewer km, 978.1 -> 974.2 km. Also changed: trucks 5 -> 6, loads 14 -> 15, operating cost 529
  -> 541 OMR. It passed the planner's own checks, timing and costs."* Recommended names *"a lower total cost including the
  customer time preferences"*; Min Trucks fewer trucks, fewer loads or a lower operating cost. The search line and the job
  message add nothing. `SearchReport.pyvrp` holds the details (status, reason, iterations, stop reason, chosen_for).

### 12.2 Measured: engine alone against engine + PyVRP (same seed, back to back)

Conditions (rerun after the review fixes: the goal-based pick and note, the timed Thorough stall): this branch (long
search + PR 6 merged), the production worker pool (`SOLVER_PARALLEL` unset), PyVRP seed 1, the same cached road matrices,
one of our solves at a time, on the shared 6-core / 12-thread development PC. The Quick rows up to 150 stops and the public
rows ran as three off/on pairs with the order alternating (off-on, on-off, off-on); syn300 and real80 Thorough ran once
each (single samples). **The machine was not idle for every run:** another session's solver test suite ran from about
13:27 to 14:02, during the public rows of the first pair, all of the second pair, syn150 to rc201 of the third pair, and
the syn300 and Thorough rows (the harness logs how many Python processes were running when each run started). So the
Wall and CPU columns come from a partly loaded machine. CPU counts the solver process and every worker process. Quick at
the automatic limit (20 s at real80 / syn60 / the 100-customer public instances, 50 s at syn150, 150 s at syn300); real80
Thorough with a 300 s cap. RECOMMENDED (OMR) is the recommended plan's objective (operating cost + preference penalties;
nothing unserved on any row); the median run's plan is shown, with the range over the runs. real80: aggregates only.
Harness: `bench_pv.py` (kept with the bench material, not in the repo).

| Day | Mode | PyVRP | Runs | Served P1/P2/P3/P4/P5 | Unserved | Trucks | Loads | km | RECOMMENDED (OMR), median (range) | Change | VERIFIED | Wall (s), median (range) | CPU (s), median | Second search |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| real80 | Quick | off | 3 | 0/29/51/3/0 | 0 | 5 | 14 | 979.8 | 534.16 (532.05-571.74) |  | VERIFIED | 50.9 (47.0-52.3) | 82.7 | SKIPPED (OFF) |
| real80 | Quick | on | 3 | 0/29/51/3/0 | 0 | 5 | 14 | 974.2 | 529.15 (529.15-529.15) | -0.94% | VERIFIED | 53.1 (46.9-53.8) | 121.8 | CHOSEN 3/3 (Recommended, Min Trucks, Min Distance) |
| syn60_s1 | Quick | off | 3 | 5/11/14/17/13 | 0 | 4 | 5 | 443.7 | 254.54 (254.54-254.54) |  | VERIFIED | 31.7 (31.6-32.5) | 41.9 | SKIPPED (OFF) |
| syn60_s1 | Quick | on | 3 | 5/11/14/17/13 | 0 | 3 | 6 | 446.8 | 238.56 (237.92-238.56) | -6.28% | VERIFIED | 32.4 (31.8-33.0) | 73.1 | CHOSEN 3/3 (Recommended, Min Trucks) |
| syn150_s1 | Quick | off | 3 | 11/24/43/32/40 | 0 | 8 | 9 | 805.3 | 506.00 (506.00-506.00) |  | VERIFIED | 77.5 (77.2-77.8) | 103.3 | SKIPPED (OFF) |
| syn150_s1 | Quick | on | 3 | 11/24/43/32/40 | 0 | 7 | 10 | 756.7 | 490.43 (485.13-490.43) | -3.08% | VERIFIED | 84.7 (78.1-85.2) | 192.5 | CHOSEN 3/3 (Recommended, Min Trucks) |
| syn300_s1 | Quick | off | 1 | 15/47/90/65/83 | 0 | 12 | 24 | 1,835.3 | 1,027.34 |  | VERIFIED | 249.9 | 346.0 | SKIPPED (OFF) |
| syn300_s1 | Quick | on | 1 | 15/47/90/65/83 | 0 | 12 | 24 | 1,501.7 | 921.63 | -10.29% | VERIFIED | 248.7 | 586.4 | CHOSEN 1/1 (Recommended, Min Trucks, Min Distance) |
| real80_thorough | Thorough 300 s | off | 1 | 0/29/51/3/0 | 0 | 5 | 14 | 969.7 | 527.51 |  | VERIFIED | 224.7 | 258.1 | SKIPPED (OFF) |
| real80_thorough | Thorough 300 s | on | 1 | 0/29/51/3/0 | 0 | 5 | 14 | 964.8 | 523.38 | -0.78% | VERIFIED | 223.1 | 471.7 | CHOSEN 1/1 (Recommended, Min Trucks, Min Distance); stop CONVERGED |
| X-n101-k25 | Quick | off | 3 | 0/0/100/0/0 | 0 | 27 | 27 | 29,375.0 | 293.75 (293.75-293.75) |  | VERIFIED | 21.4 (21.4-21.5) | 21.0 | SKIPPED (OFF); 27 veh |
| X-n101-k25 | Quick | on | 3 | 0/0/100/0/0 | 0 | 26 | 26 | 27,591.0 | 275.91 (275.91-275.91) | -6.07% | VERIFIED | 21.7 (21.6-21.7) | 41.2 | CHOSEN 3/3 (Recommended); 26 veh |
| r108 | Quick | off | 3 | 0/0/100/0/0 | 0 | 10 | 10 | 967.8 | 1,159.68 (1,159.68-1,159.68) |  | VERIFIED | 21.4 (21.4-21.4) | 20.7 | SKIPPED (OFF); 10 veh |
| r108 | Quick | on | 3 | 0/0/100/0/0 | 0 | 9 | 9 | 964.5 | 1,044.64 (1,044.64-1,044.64) | -9.92% | VERIFIED | 21.6 (21.5-21.8) | 41.1 | CHOSEN 3/3 (Recommended); 9 veh |
| rc201 | Quick | off | 3 | 0/0/100/0/0 | 0 | 4 | 4 | 1,443.8 | 522.44 (522.44-522.44) |  | VERIFIED | 21.3 (21.3-21.3) | 20.9 | SKIPPED (OFF); 4 veh |
| rc201 | Quick | on | 3 | 0/0/100/0/0 | 0 | 4 | 4 | 1,443.8 | 522.44 (522.44-522.44) | 0.00% | VERIFIED | 21.3 (21.3-21.7) | 41.0 | NOT_CHOSEN 3/3 (NOT_BETTER); 4 veh |

- **Priority service never dropped:** every run serves exactly the same stops per priority with the second search on, and
  nothing is unserved. Every option of every run is VERIFIED by the independent check.
- **Never worse, run by run:** in all 20 off/on pairs the "on" run's recommended plan costs the same or less than the "off"
  run's. Medians: -0.9% (real80 Quick; its engine alone ranged 532-572 OMR over three runs, the second search's plan was
  529.15 every time), -6.3% (syn60, one truck fewer), -3.1% (syn150, one truck fewer), -10.3% (syn300, 334 km less), -0.8%
  on real80 Thorough, and on the public instances X-n101-k25 at its proven optimum (27,591; 26 vehicles instead of 27, gap
  6.47% -> 0.0%) and r108 with 9 vehicles instead of 10 (the best-known count; distance gap 0.37%). rc201 is now equal: the
  second search's plan had been only 0.30 OMR better in the first measurement (522.14 against 522.44), and a gain under 1 OMR
  no longer replaces the engine's plan (§12.1). The first measurement's real80 Quick row (+0.03%, 529.01 -> 529.15) was a
  worse row between two separate engine searches; the promise (§12.1) holds within one run, where the second search's plan
  is judged against the engine's own final plan.
- **Time:** Quick answers about as fast as before: median wall -1.2 s to +7.2 s against the engine alone per row (syn150 the
  largest, +7.2 s: the second search's repack runs in its own process beside the engine's). Thorough: 223.1 s with the
  second search against 224.7 s without (the first measurement took 261 s against 216 s). The second search now stopped on
  its timed stall (CONVERGED after 203.5 s, its last better plan at 106.3 s) instead of waiting until the load re-check's
  reserve. The engine alone did not converge on this day: its RECOMMENDED search ran its full 189 s limit (stop CAP) in both
  runs. The first measurement's summary wrongly said it had converged.
- **CPU:** 1.5-2.0x the CPU-seconds of the engine alone (one more busy process during the search, and its repack). On
  Railway's 24 vCPU solver this is not a constraint.
- **What changed in the plans:** the second search's plans use fewer trucks or fewer km. On days with preferred windows they
  deliver some P1/P2 customers later inside their hard windows: the early-arrival preference it cannot see is priced by the
  judge, so these plans still win on the full objective. The dispatcher note names the option's goal, for example syn150
  Recommended *"a lower total cost including the customer time preferences, 506 -> 490 OMR. Also changed: trucks 8 -> 7,
  loads 9 -> 10, km 805.3 -> 756.7, operating cost 480 -> 446 OMR"*, and Min Distance on syn300 *"fewer km, 1,782.7 ->
  1,501.7 km"*.
- Limits: three pairs (or one) per row, on a partly loaded machine, and one seed. The prototype's paired runs (spec §3, 46
  rows, and the skeptics' 19 paired runs) point the same way, with the engine's plan never better than the hybrid.

## 13. Planning rules: unloading finished by closing and the driver break (2 Oct 2026)

Branch `planning-rules-break`, **every row on one build: f010a1d** (phase A, phase B and the review fixes), run back to back
13:41-14:06 on 30 Sep, one solve at a time (another worktree's test suite was running on the machine meanwhile, so wall
seconds are indicative). **Before** = production before the branch: unloading only has to start by closing, no break,
split parts share the stop time, no absolute latest return. **Finish** = unloading finished by closing, the full stop time
on every split part (real80) and the 18:00 latest return, but no break: it isolates the cost of the break. **After** =
what production runs once the dispatcher sets the shift and the break: finish + full split stop time + 18:00 latest
return + a 60-min break starting 12:00-14:00. All at the owner's shift (first departure 07:00, 11 h, back by 18:00),
overtime as each instance has it. Quick auto limits, the three scenarios as production asks for them, RECOMMENDED
reported; the harness runs in-process (`.dev/bench`, cached matrices), one run per cell (single runs: differences of a
truck or a few percent can be search noise). Unserved shows the solver's reason code. real80 in aggregates only.

| Instance | Config | Served P1 / P2 / P3 / P4 / P5 | Unserved (reason) | Trucks | Loads | km | OMR | Paid / overtime min | Timetable check | Truck-days with a break | Wall s (post-solve s) |
|---|---|---|---|---|---|---|---|---|---|---|---|
| real80 | before | - / 29 / 51 / 3 / - (all) | 0 | 5 | 14 | 978.1 | 501.44 | 2,700 / 22 | VERIFIED | - | 69.1 (29.1) |
| real80 | finish | - / 29 / 51 / 3 / - (all) | 0 | 5 | 14 | 986.5 | 519.70 (+3.6%) | 2,867 / 170 | VERIFIED | - | 54.3 (14.2) |
| real80 | after | - / 29 / 51 / 3 / - (all) | 0 | 5 | 14 | 988.7 | 539.60 (+7.6%; +3.8% vs finish) | 3,051 / 349 | VERIFIED | 5 of 5 (4 at the depot during a reload, 1 on the road) | 64.0 (23.9) |
| syn60_s1 | before | 5 / 11 / 14 / 17 / 13 (all) | 0 | 5 | 5 | 420.1 | 261.14 | 1,475 / 0 | VERIFIED (1 stop finishing after closing) | - | 40.9 (0.9) |
| syn60_s1 | after | 5 / 11 / 14 / 17 / 13 (all) | 0 | 5 | 5 | 421.9 | 261.58 (+0.2%) | 1,479 / 0 | VERIFIED | 0 of 5 (all back by 14:00 or starting at 12:00+) | 41.0 (0.9) |
| syn150_s1 | before | 11 / 24 / 43 / 32 / 40 (all) | 0 | 10 | 10 | 764.2 | 518.62 | 3,187 / 0 | VERIFIED | - | 101.8 (1.7) |
| syn150_s1 | after | 11 / 24 / 43 / 32 / 40 (all) | 0 | 8 | 10 | 798.6 | 487.06 (-6.1%, search noise: 2 trucks fewer) | 3,478 / 2 | VERIFIED | 3 of 8 (on the road) | 102.9 (2.8) |
| syn300_s1 | before | 15 / 47 / 90 / 65 / 83 (all) | 0 | 12 | 25 | 1,773.8 | 959.46 | 7,001 / 786 | VERIFIED (9 stops finishing after closing) | - | 332.9 (32.6) |
| syn300_s1 | finish | 15 / 47 / 90 / 65 / 83 (all) | 0 | 12 | 26 | 1,754.2 | 956.60 (-0.3%) | 7,000 / 795 | VERIFIED | - | 323.8 (23.5) |
| syn300_s1 | after | 15 / 47 / 89 / 65 / 83 | 1 P3 (SOLVER_DROPPED_LOW_PRIORITY) | 12 | 24 | 1,687.4 | 975.73 (+1.7%) | 7,455 / 976 | VERIFIED | 12 of 12 (9 on the road, 3 at the depot) | 348.5 (48.2) |

What it shows:
- Every plan is VERIFIED (the independent check re-derives the finish rule, the break and the 18:00 latest return); no
  truck is back after 18:00 in any row, and no stop finishes unloading after closing under the rule (the earlier rule let
  1 stop on syn60_s1 and 9 on syn300_s1 do so).
- real80, split in two: the finish rule with the full stop time on its 6 split parts costs +3.6% (paid driver time
  2,700 -> 2,867 min, overtime 22 -> 170 min); the break adds +3.8% more (paid 2,867 -> 3,051 min, overtime 170 -> 349
  min: the break is paid and counts toward overtime). That is +184 paid min over 5 truck-days: the 4 breaks taken at the
  depot overlap the 30-min reload and add at most 30 min each, the 1 on the road adds its full 60 min (4 x 30 + 60 = 180).
  Same 5 trucks and 14 loads.
- No P1 or P2 stop is lost anywhere. syn300_s1 is a tight day (every truck-day is bound by the shift): the finish rule
  alone still serves everything; with the break 1 P3 stop is left out (SOLVER_DROPPED_LOW_PRIORITY: the search dropped it
  as the cheapest to leave out). The owner decides whether that is acceptable; a THOROUGH search is the lever on such a day.
- Speed: post-solve seconds are of the same order before and after on every instance (0.9-2.8 s on syn60_s1 and syn150_s1,
  24-29 s on real80, 33-48 s on syn300_s1, where the break-aware CP-SAT model also runs because the break-free proposals
  cannot hold the breaks: +16 s wall). A first version that always solved the break-aware model took 33 s of post-solve
  on syn150_s1 (now 2.8 s).

## Sources

- OR-Tools repository and licence (Apache-2.0): https://github.com/google/or-tools · releases: https://github.com/google/or-tools/releases
- OR-Tools time windows: https://developers.google.com/optimization/routing/vrptw
- OR-Tools dropping visits with penalties: https://developers.google.com/optimization/routing/penalties
- OR-Tools search options: https://developers.google.com/optimization/routing/routing_options
- OR-Tools reload sample: https://github.com/google/or-tools/blob/stable/ortools/constraint_solver/samples/cvrp_reload.py
- VROOM repository and licence (BSD-2-Clause): https://github.com/VROOM-Project/vroom · API: https://github.com/VROOM-Project/vroom/blob/master/docs/API.md
- VROOM multi-trip discussions: https://github.com/VROOM-Project/vroom/issues/188 · https://github.com/VROOM-Project/vroom/issues/422 · https://github.com/VROOM-Project/vroom/issues/492
- VROOM bindings and server: https://pypi.org/project/pyvroom/ · https://github.com/VROOM-Project/vroom-express
- OSRM repository and licence (BSD-2-Clause): https://github.com/Project-OSRM/osrm-backend · HTTP API: https://github.com/Project-OSRM/osrm-backend/blob/master/docs/http.md
- GCC OSM extract: https://download.geofabrik.de/asia/gcc-states.html
- Timefold pricing and editions: https://timefold.ai/pricing · Solver docs: https://docs.timefold.ai/timefold-solver/latest/introduction
- Timefold Solver repository (Apache-2.0): https://github.com/TimefoldAI/timefold-solver · Python bindings (archived): https://github.com/TimefoldAI/timefold-solver-python
- Timefold FSR: https://docs.timefold.ai/field-service-routing/latest/introduction · shifts: https://docs.timefold.ai/field-service-routing/latest/vehicle-resource-constraints/shift-hours-and-overtime · priorities: https://docs.timefold.ai/field-service-routing/latest/visit-service-constraints/priority-visits-and-optional-visits · changelog: https://docs.timefold.ai/field-service-routing/latest/changelog
- Timefold Pick-up and Delivery Routing: https://docs.timefold.ai/pickup-delivery-routing/latest/introduction
- Google Route Optimization overview: https://developers.google.com/maps/documentation/route-optimization/overview
- Google RO billing (per shipment): https://developers.google.com/maps/documentation/route-optimization/usage-and-billing
- Google Maps Platform price list: https://developers.google.com/maps/billing-and-pricing/pricing
- Google RO ShipmentModel (soft windows, penalty cost, loads, matrices): https://developers.google.com/maps/documentation/route-optimization/reference/rest/v1/ShipmentModel
- Google RO InjectedSolutionConstraint: https://developers.google.com/maps/documentation/route-optimization/reference/rest/v1/InjectedSolutionConstraint
- PyVRP repository and licence (MIT): https://github.com/PyVRP/PyVRP · multi-trip release v0.11.0: https://github.com/PyVRP/PyVRP/releases/tag/v0.11.0 · API: https://pyvrp.org/api/pyvrp.html
