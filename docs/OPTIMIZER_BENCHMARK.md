# Optimizer benchmark and architecture decision (NMWC dispatch MVP)

Date: 2026-09-24 · Branch: `nmwc-dispatch-mvp` · Related: [OPTIMIZER_DESIGN.md](OPTIMIZER_DESIGN.md) (plain-language model), [OSRM_SETUP.md](OSRM_SETUP.md) (road matrix)

## 1. Decision

- **Keep Google OR-Tools (routing library) as the dispatch engine** (`apps/solver/dispatch_solver.py`, `POST /optimize-dispatch`).
  It is the only candidate that covers every NMWC rule (cases + kg, hard and preferred windows, strict P1 > P5
  priorities, several loads per truck, frozen loads) inside the existing Python solver, with no licence fee.
- **Distances come from a self-hosted OSRM** (Oman / GCC extract, URL set per tenant or through `OSRM_URL`). Haversine stays
  as a fallback that is labelled "estimated".
- **PyVRP**: keep it only behind the legacy `/optimize` endpoint, then remove it once the web app no longer calls that endpoint.
- **VROOM, Timefold, Google Route Optimization API**: not adopted. Revisit only if one of the triggers in §7 appears.
- **Fixed after the first measurements (see §5a):** at about 300 stops the automatic time limit was too short, and a
  warm-started alternative could stall past its time limit. Both are fixed and re-measured.
- **Fixed on 25 Sep 2026 (see §8):** on NMWC's real day the engine planned far too many trucks (13 trucks / 21 loads /
  754 OMR where 5 trucks / 14 loads / ~490 OMR were feasible). An exact post-solve step now re-assigns whole loads to trucks
  (CP-SAT, `load_repack.py`), priorities are strict, and loading / unloading time can follow the cases.

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
| Priorities / droppable orders | Each stop is an `AddDisjunction`. **Strict (default since 25 Sep 2026):** penalty = `SERVICE_BASE (1,000 OMR) × w(P)`, w(P5) = 1, w(P) = 1 + Σ over lower priorities q of n_q × w(q) (n_q = stops of priority q in the model), so one stop outweighs all lower-priority stops together. The int64 total is guarded (base scaled down, then weights capped with a warning, only for days of thousands of stops). **Weighted (`strict_priorities: false`)**: `SERVICE_UNIT × weight(P) / weight(P5)` with 10,000 / 1,000 / 100 / 10 / 1, where 11 P3 outweigh one P2. Margin, when every stop has one, is capped below 0.4 service unit and only breaks ties within the same priority. |
| Costs | Each truck has its own arc cost (`cost_per_km + fuel_price / km_per_litre`, so fuel is counted once). The trip cost sits on arcs into reload nodes, and there is a fixed cost per truck-day. Driver time is a span cost, and overtime is a soft bound on the route end. |
| Frozen work | LOCKED / LOADING / DISPATCHED loads come in as `frozen_trips`. They stay out of the model and only change the truck's earliest departure (return + reload), its remaining trips and its shift anchor. |
| Reasons | Pre-filters return `EXCEEDS_ANY_TRUCK_CAPACITY`, `HARD_WINDOW_INFEASIBLE`, `SHIFT_LIMIT`, `NO_AVAILABLE_TRUCK` and `TRIP_LIMIT`. After the solve, dropped stops get `LATE_ORDER_NO_CAPACITY`, the fleet-shortage text, or *"Not planned: the optimizer found no truck, trip or time slot ... within its time limit"* (`SOLVER_DROPPED_LOW_PRIORITY`). Guided local search always ends on its time limit and reports `ROUTING_SUCCESS`, so the status is no proof: the engine never claims a stop impossible unless a pre-filter proved it. `_assert_reconciled` raises if any stop or case is missing or duplicated. |
| Search | `PARALLEL_CHEAPEST_INSERTION` followed by `GUIDED_LOCAL_SEARCH`. The automatic time limit is 5 / 20 / 150 / 240 s for ≤25 / ≤200 / ≤350 / >350 stops (was 3 / 8 / 20 for ≤25 / ≤80 / ≤200; alternatives get half), within a 540 s budget per request. |
| Scenarios | RECOMMENDED runs first with the full time budget. MIN_TRUCKS and MIN_DISTANCE are **warm-started** from it with half the budget: `CloseModelWithParameters` + `RoutesToAssignment` (Next variables only) + `SolveFromAssignmentWithParameters`, falling back to a cold solve when the plan cannot be loaded or the warm solve returns nothing. (`ReadAssignmentFromRoutes`, used before, restores cumul values and could stall > 100 s under time-dimension costs.) Every scenario, RECOMMENDED included, runs in a spawn worker process. OR-Tools holds the GIL for its whole search, so threads would not run scenarios in parallel, and an in-process search froze the API (health checks, route geometry) until it ended. If the pool fails the scenarios run one after another in-process, and `SOLVER_PARALLEL=0` forces that. |
| Post-solve load repack + selection | `load_repack.py`. For each raw scenario plan, CP-SAT keeps every load (stops and order) and re-assigns loads to trucks and departure times: no-wait offsets and a departure interval per load from hard windows; per truck earliest departure (after frozen loads + turnaround), latest return, depot hours, loads left, the shift span (unless anchored by frozen loads), cases / kg per load; loads of a truck do not overlap and are separated by the exact turnaround; identical trucks are symmetry-broken. Objective = the scenario's own prices (RECOMMENDED: fixed per used non-frozen truck + trip + km × truck rate + driver cost on the truck span + overtime + preferred-window / early-arrival hinges + plan continuity; MIN_TRUCKS: fixed × 20, trip × 5, km). Stops a plan left out (no shortage) enter as optional one-stop loads, lexicographically served first. Each solve: min(15 s, max(3 s, limit / 2)), 2 workers, stops when no better plan came for a quarter of that. Every candidate (raw plans re-timed + repacks) is timed by one LP per truck and scored on one RECOMMENDED objective (overtime from the first actual departure, as reported); RECOMMENDED takes the best objective, MIN_TRUCKS fewest trucks → loads → operating cost, MIN_DISTANCE fewest km → RECOMMENDED objective, none serving less than its raw plan. Runs in the worker pool with a deadline; on failure the raw plans are returned with a warning. |
| Matrix | `providers.py` requests the OSRM `/table` in 90×90 tiles, because a stock server allows `--max-table-size` 100. Durations are multiplied by `road_time_factor` (1.25) to allow for slower trucks. The Haversine fallback uses ×1.3 at 40 km/h and is marked "estimated". |

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
   (`.venv/Scripts/python scripts/bench_dispatch.py 300`).
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
