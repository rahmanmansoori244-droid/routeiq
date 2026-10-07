# RouteIQ dispatch benchmark harness (`.dev/bench`)

**LOCAL ONLY.** The `real80*` instances contain real NMWC customer names and locations
(`.dev/` is git-ignored). Never publish, upload or send them or anything derived from them that
names customers.

This is the shared harness for benchmarking the NMWC dispatch engine
(`apps/solver/dispatch_solver.py`, OR-Tools). Every run is offline and reproducible: matrices
are cached in `cache/`. The solver is imported as a library, so no server is needed. Nothing in the
repo is modified. Other solvers (PyVRP, heuristics, ...) can be scored on exactly the same terms.

```python
import sys; sys.path.insert(0, r"C:\Users\abdulr\routeiq\.dev\bench")
import instances as I

I.list_instances()                 # standard set (9); I.list_instances(True) adds real80_prod
req  = I.load_instance("real80")   # DispatchRequest (fresh deep copy, run_id = "bench-real80")
mx   = I.matrix_for("real80")      # dist_km / dur_min (+ distance_m / duration_s ints), 0 = depot, i = req.stops[i-1]
plan, sc, wall = I.run_ortools("real80", time_limit_sec=None, scenario="RECOMMENDED")
ev   = I.evaluate(req, plan)       # neutral metrics + violations for ANY plan {truck_id: [[stop_id, ...], ...]}
```

Run with `C:/Users/abdulr/routeiq/apps/solver/.venv/Scripts/python.exe` (ortools 9.15, pyvrp,
httpx, pydantic). `instances.py` adds `apps/solver` to `sys.path` itself.

## API (`instances.py`)

| function | what it does |
|---|---|
| `list_instances(include_extra=False)` | `real80, real80_hav, syn60_s1..3, syn150_s1..3, syn300_s1` (+ `real80_prod`) |
| `load_instance(name)` | `dispatch_models.DispatchRequest`, all 3 scenarios, `time_limit_sec=None` (auto) |
| `matrix_for(name)` | the matrix the solver sees, built by the solver's own `providers.resolve_matrix` (road_time_factor on OSRM durations; Haversine x multiplier at avg speed). Cached in `cache/<name>.json`. It is checked against a hash of the coordinates |
| `patched_matrix(name)` | context manager: `dispatch_solver.optimize_dispatch` gets its matrix from the cache (the provider call is monkeypatched, so there is no network) |
| `run_ortools(name, time_limit_sec=None, scenario="RECOMMENDED", patch=None)` | `(plan, DispatchScenario, wall_sec)`. In-process (`SOLVER_PARALLEL=0`). An alternative scenario is solved the way production does it: RECOMMENDED first, then the alternative warm-started with half the time. `wall_sec` covers both |
| `run_ortools_response(name, time_limit_sec, scenarios, patch)` | the full `DispatchResponse` for any list of scenarios |
| `patch=` | `None`; a dict `{dispatch_solver attribute: value}` (e.g. `{"auto_time_limit": lambda n: 60}`); a context manager; or a list of these |
| `ortools_params_patch(fn)` | a patch that calls `fn(search_params)` just before every OR-Tools solve (metaheuristic, limits, logging ...) |
| `from_ortools(scenario)` | converts a scenario to a plan `{truck_id: [[stop_id, ...] per load in order]}` |
| `solver_summary(scenario)` | the engine's own reported numbers |
| `evaluate(req, plan, timing="lp", matrix=None, name=None, per_load=False)` | the neutral evaluator (below) |
| `describe(name)` | the instance table row |

For sweeps, use one process per run with `SOLVER_PARALLEL=0` (`run_ortools` sets it). Compare
quality at equal time limits. **Other benchmark agents run on the same 12-CPU machine**, so wall
times are measured under contention. OR-Tools stops on a wall-clock limit, so repeated runs can differ.

## Instances

| name | stops | customers | cases | kg | trucks | cap cases (1 load each) | cap cases (all trips) | cap kg (1 load each) | priorities | hard windows | auto limit | matrix |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| real80 | 83 | 80 | 12,482 | 134,578 | 13 | 12,160 | 36,480 | 102,000 | P2:29 P3:51 P4:3 | 0 | 20 s | OSRM |
| real80_hav | 83 | 80 | 12,482 | 134,578 | 13 | 12,160 | 36,480 | 102,000 | P2:29 P3:51 P4:3 | 0 | 20 s | HAVERSINE |
| syn60_s1 | 60 | 60 | 3,043 | - | 12 | 7,200 | 21,600 | - | P1:5 P2:11 P3:14 P4:17 P5:13 | 60 | 8 s | HAVERSINE |
| syn60_s2 | 60 | 60 | 2,726 | - | 12 | 7,250 | 21,750 | - | P1:5 P2:13 P3:14 P4:8 P5:20 | 60 | 8 s | HAVERSINE |
| syn60_s3 | 60 | 60 | 2,155 | - | 12 | 7,900 | 23,700 | - | P1:4 P2:7 P3:21 P4:13 P5:15 | 60 | 8 s | HAVERSINE |
| syn150_s1 | 150 | 150 | 6,532 | - | 12 | 8,300 | 24,900 | - | P1:11 P2:24 P3:43 P4:32 P5:40 | 150 | 20 s | HAVERSINE |
| syn150_s2 | 150 | 150 | 6,367 | - | 12 | 7,050 | 21,150 | - | P1:10 P2:28 P3:44 P4:27 P5:41 | 150 | 20 s | HAVERSINE |
| syn150_s3 | 150 | 150 | 6,167 | - | 12 | 7,600 | 22,800 | - | P1:13 P2:21 P3:49 P4:29 P5:38 | 150 | 20 s | HAVERSINE |
| syn300_s1 | 300 | 300 | 12,449 | - | 12 | 6,850 | 20,550 | - | P1:15 P2:47 P3:90 P4:65 P5:83 | 300 | 150 s | HAVERSINE |
| real80_prod (extra) | 83 | 80 | 12,482 | 134,578 | 13 | 12,160 | 36,480 | 102,000 | P2:29 P3:51 P4:3 | 0 | 20 s | OSRM |

### real80 / real80_hav: the real 26-Sep test day, exactly as the web app sends it

This mirrors `apps/web/lib/dispatch/plan-service.ts buildDispatchRequest` (and `split.ts`,
`customer-attrs.ts`, `intake-server.ts`) for the day `.dev/realdata/run-test.mjs` loads:

* **Stops.** One order per customer (one line per file row, and identical SO + customer + product rows are summed, as
  in order-intake.ts). The order's kg is Σ cases × kg/case from `products.csv`, and those kg/case values are **ESTIMATES**.
  Priority comes from `customers.csv` (the import marks it confirmed; the order file has no priority column). The service
  time is the customer's `avg_service_time_min`, because there is no customer type and it is not confirmed. There are no
  windows, and no margin or revenue. `late=false`, and there is no `previous_truck_id` (this is version 1).
* **Split deliveries.** Three customers are bigger than any truck (10 t payload). They go through a
  line-for-line port of `choosePartCapacity` + `splitIntoParts`, with JS rounding. Parts are sized for
  R1-5187 (1140 cases / 10,000 kg). Stop ids are `<customer>#k`, order ids `ord-<customer>~k`, and part
  service = max(5, round(service × part cases / total cases)). The result:
  CUST-A → 935 + 165 cases, CUST-B → 703 + 317, CUST-C → 599 + 73.
* **Trucks.** The 13 PRESELL trucks in `trucks.csv`, sorted by code (the local Postgres uses locale C). The costs follow run-test.mjs:
  10 t = fixed 35, 0.10/km, 3.5 km/l, trip 3; 3 t = fixed 18, 0.06/km, 7 km/l, trip 2; max 3 trips.
* **Tenant config.** From run-test.mjs: shift start 06:00, shift max 660 min, overtime after 540 min at 4 OMR/h,
  reload 30 min, fuel 0.26 OMR/l, driver 2.5 OMR/h, preferred-window penalty 0.05/min, road_time_factor 1.25,
  Haversine × 1.3 at 40 km/h, and default priority weights. The depot is MCT-GHALA (23.568, 58.392), open 05:00-23:00.
* **Check against the app itself.** All 83 stops (customer, cases, kg, service, priority, lat/lng)
  are identical to the stops in the app's own local plan, `.dev/realdata/last-plan.json`.
* **Matrix.** `real80` = OSRM **public demo server** (`router.project-osrm.org`). It took 4 table requests on
  25 Sep, cached in `cache/osrm_http/`, with 0 unroutable legs and no point snapped more than 5 km. Production uses a
  self-hosted OSRM built from the Oman extract, so road km can differ slightly. Over all legs, OSRM km / (Haversine × 1.3)
  has median 1.07 (p10 0.92, p90 1.34). OSRM duration × 1.25 is close to Haversine at 40 km/h (median ratio 0.99).
* **Locations.** 73 of the 80 customer locations are random real GT points; only 7 are the customer's own pin.
  Km compared with the real 24-Sep operation is therefore **indicative only**.

### real80_prod (extra, INFERRED production configuration)

The stops are the same as real80. The configuration is what the production test tenant ("nmwccc") most likely had.
`/api/auth/signup` creates `TenantConfig` with the Prisma schema defaults: shift max **540** min, fuel 0, driver 0,
overtime cost 0, and everything else the same. The trucks come from `prod-setup.json`: fixed 35/18 and 0.10/0.06 per km only, with
no km/l and no trip cost. This inference fits production v3's cost (294 OMR for 7 trucks / 1192 km works out
only if fuel and driver cost are 0, e.g. 4 × 10 t + 3 × 3 t with about 712 km on the 10 t trucks). It is **not confirmed**:
production settings may have been edited in the UI. Production v3 was also a **re-plan (version 3)**, which carries
`previous_truck_id` continuity penalties (3 OMR per moved stop) that no v1 request has.

### syn*: synthetic NMWC days

These come from `nmwc_day(n, seed)` in `apps/solver/tests/test_dispatch.py`, imported rather than copied, with the
`.dev/bench150.py` config. That means `req(...)` defaults (Haversine, depot "ghala" open all day), fuel 0.26 and driver 2.5,
with every other setting at the DispatchConfig defaults (shift 660, overtime 4/h after 540, reload 30). There are 12
trucks of 450/600/800 cases with no kg limit, costing fixed 25, 0.12/km and 4.5 km/l. Every stop has a hard window:
hypermarkets 06:00-11:00, trading 07:00-12:30, groceries 07:00-21:00 with a preferred window of 09:00-17:00. The
matrix is **Haversine**, which is what the engine sees for these requests. OSRM would take about 110 table requests
to the public server for all synthetic days, which is over the "few requests" budget.

## Neutral evaluator: `evaluate(req, plan, timing="lp")`

`plan = {truck_id: [[stop_id, ...] for each load in order]}`. Stops that are not in the plan count as unserved.

**Feasibility** does not depend on `timing`. A plan is feasible only if all of these hold:

* Each stop is known and appears once, and each truck is known and usable.
* Loads ≤ trips left (max_trips - frozen loads).
* Cases ≤ `capacity_cases` and kg ≤ `capacity_kg` (+0.01), per load.
* A timetable exists. This is an **elastic LP** (GLOP) that mirrors the engine's OR-Tools Time dimension:
  * the next cumul ≥ this cumul + service + travel;
  * a reload is a depot visit that takes `reload_min`;
  * service must *start* inside the hard window;
  * start, reloads and end fall in [earliest, latest], where earliest = max(shift start, depot open, truck available) and latest = min(depot close, truck available_to);
  * first departure → last return ≤ `shift_max`.

  Violations cost 10^6 units/s, so the least-violating timetable is found and reported as `HARD_END`,
  `LATEST_RETURN`, `RELOAD_AFTER_CLOSE` or `SHIFT` (minutes). The other codes are `CAPACITY_CASES`, `CAPACITY_KG`, `TRIP_LIMIT`,
  `DUPLICATE_STOP`, `UNKNOWN_STOP`, `UNKNOWN_TRUCK` and `TRUCK_UNUSABLE`.

**Timetable** (`timing`):

* `lp` (the default, **use this to compare plans**) is the optimum of RECOMMENDED's time-dimension costs, using the
  solver's own integer coefficients: span × driver cost, preferred windows, the early-arrival preference for P1/P2, and
  the soft overtime bound. A 0.001 unit/s tie-break favours a compact day. This is the timetable the engine
  reports for RECOMMENDED.
* `packed` is the shortest truck day with no soft costs. This is what the engine reports for MIN_TRUCKS / MIN_DISTANCE.
* `asap` sets every cumul to its earliest value.

**Metrics** use the same formulas as `dispatch_solver._extract`:

* Fixed cost is charged once per truck-day (on load_no 1), plus `trip_cost` per load.
* Distance = km × `cost_per_km`, and fuel = km / `km_per_litre` × fuel price. Fuel is counted once.
* Driver = load duration (depart → return, where departure is just-in-time for the first stop) × driver cost/h.
* Overtime per truck = (last return - first departure - overtime_after) × overtime cost/h, on rounded minutes.

The output fields are:

* `operating_cost` = fixed + trip + distance + fuel + driver + overtime, which is the engine's `operating_cost`.
* The component `costs`.
* `trucks_used`, `loads`, `km`, `driving_min` (road time), `duty_min` (Σ load durations), `truck_day_min`
  (first departure → last return, including reloads), `wait_min`, `service_min` and `fuel_litres`.
* Served and unserved stops and cases, plus the `by_priority` table.
* `pref_window_min_outside`, `pref_window_stops_outside` and `window_penalty`.
* `early_pref_cost`.
* `avg_utilization_pct` (the mean over loads of max(case %, kg %), as the engine reports it) and `case_fill_pct` (cases / capacity of the loads used).
* `unserved_penalty`.
* `engine_objective`, which is always the **RECOMMENDED objective in solver units (1 unit = 0.00001 OMR)** on the
  `lp` timetable. It lets any plan be ranked by the engine's own objective. Service dominates: a P5 stop is worth 100,000 OMR.

## Validation: `validate_baseline.py` → `results/baseline.json`

The run used the current engine at the default auto time limit, with all three scenarios as the web app asks for them. It ran in-process and
under contention, on 25 Sep 2026. The evaluator's timetable was `lp` for RECOMMENDED and `packed` for the alternatives.

| instance | scenario | solver status | trucks | loads | engine km | evaluator km | engine cost OMR | evaluator cost OMR | Δ | violations | loads with timetable Δ |
|---|---|---|---|---|---|---|---|---|---|---|---|
| real80 | RECOMMENDED | ROUTING_SUCCESS 20.0 s | 13 | 21 | 1392.90 | 1392.90 | 754.357 | 754.357 | 0.0% | 0 | 0 |
| real80 | MIN_TRUCKS | 10.0 s | 13 | 21 | 1381.17 | 1381.17 | 751.868 | 751.868 | 0.0% | 0 | 0 |
| real80 | MIN_DISTANCE | 10.0 s | 9 | 14 | 988.64 | 988.64 | 638.581 | 638.581 | 0.0% | 0 | 0 |
| syn150_s1 | RECOMMENDED | 20.0 s | 8 | 9 | 805.60 | 805.60 | 478.570 | 478.570 | 0.0% | 0 | 0 |
| syn150_s1 | MIN_TRUCKS | 10.0 s | 8 | 9 | 775.29 | 775.29 | 471.279 | 471.279 | 0.0% | 0 | 0 |
| syn150_s1 | MIN_DISTANCE | 10.1 s | 8 | 9 | 747.30 | 747.30 | 464.560 | 464.560 | 0.0% | 0 | 0 |
| real80_hav | RECOMMENDED | 20.0 s | 11 | 21 | 1440.38 | 1440.38 | 715.946 | 715.946 | 0.0% | 0 | 0 |
| real80_hav | MIN_TRUCKS | 10.0 s | 10 | 19 | 1282.47 | 1282.47 | 681.874 | 681.874 | 0.0% | 0 | 0 |
| real80_hav | MIN_DISTANCE | 10.0 s | 9 | 14 | 1003.13 | 1003.13 | 648.937 | 648.937 | 0.0% | 0 | 0 |
| real80_prod | RECOMMENDED | 20.0 s | 12 | 21 | 1401.75 | 1401.75 | 467.298 | 467.298 | 0.0% | 0 | 0 |
| real80_prod | MIN_TRUCKS | 10.0 s | 12 | 21 | 1389.66 | 1389.66 | 466.206 | 466.206 | 0.0% | 0 | 0 |
| real80_prod | MIN_DISTANCE | 10.0 s | 7 | 14 | 983.79 | 983.79 | 343.380 | 343.380 | 0.0% | 0 | 0 |

The RECOMMENDED objective recomputed by the evaluator matches the solver's `objective_value` to within 0-6 units
(real80: 77,286,398 vs 77,286,399). Every run served every stop (0 unserved). The wall time was 40 s per instance for
all three scenarios (20 + 10 + 10).

Residual differences to expect:

* When the search stops on its time limit before converging, OR-Tools does not always leave the
  final timetable at its cost optimum. The evaluator re-times the same routes optimally, so it reports a slightly
  lower operating cost. Measured cases:
  * syn300_s1 at 5 s (`ROUTING_PARTIAL_SUCCESS_LOCAL_OPTIMUM_NOT_REACHED`). Routes, km and driver cost are identical. 6 of 24 loads
    depart 12-30 min later in the engine's timetable (e.g. a second load waiting 30 min at the depot beyond
    the reload), which makes the truck day longer. Overtime is 31.2 (engine) vs 27.2 (evaluator), operating cost 945.385 vs
    941.385 (-0.42%), and the objective differs by about 25 OMR, mostly span cost.
  * One exploratory syn150_s1 run at 6 s showed 0.8 OMR more overtime in the engine (0.13%).

  The runs at the default limits above converged (`ROUTING_SUCCESS`) and match exactly.
* Arc costs are rounded per arc in the solver and per route in the evaluator, which makes a difference of 1e-5 OMR or less.

**Baseline observation (for the optimizer phase).** On all three real80 variants, the MIN_DISTANCE plan
scores better **on RECOMMENDED's own objective** than the RECOMMENDED plan does. Examples: real80, 66,941,052 vs
77,286,398 units, which is about 103 OMR, with 9 trucks / 14 loads vs 13 / 21; real80_prod, 7 trucks / 343 OMR vs 12 / 467 OMR.
MIN_DISTANCE is warm-started from RECOMMENDED and is not forced to keep its structure. So at the default 20 s,
RECOMMENDED is far from optimal on the real day, with too many trucks. MIN_TRUCKS did not reduce trucks either.
On syn150_s1, RECOMMENDED is the best under its own objective, as expected.
More time alone does not close the gap. One RECOMMENDED run on real80 at **60 s** gave 12 trucks / 19 loads /
1249.1 km / 718.9 OMR, objective 73,679,470 (`results/baseline_real80_rec60.json`). That is still worse than the
10 s MIN_DISTANCE plan's 66,941,052. This points to the search structure (first solution / neighbourhoods that
cannot empty a truck), not only the time limit. It is a single run under contention, so treat it as indicative.

## Real day vs production v3 (26 Sep, reported: 80/80 served, 7 trucks, 16 loads, 1192 km OSRM, 294 OMR)

| run | trucks | loads | km | operating cost | served |
|---|---|---|---|---|---|
| production v3 (reported, self-hosted OSRM, version 3 re-plan) | 7 | 16 | 1192 | 294 | 80/80 |
| real80 RECOMMENDED (run-test costs) | 13 | 21 | 1392.9 | 754.4 (fuel, driver and trip costs included, so not comparable) | 83/83 stops |
| real80 MIN_DISTANCE | 9 | 14 | 988.6 | 638.6 | 83/83 |
| real80_prod RECOMMENDED (inferred prod config) | 12 | 21 | 1401.8 | 467.3 | 83/83 |
| real80_prod MIN_DISTANCE | 7 | 14 | 983.8 | 343.4 | 83/83 |

The differences have several causes:

* The production configuration is unknown, and real80_prod is inferred.
* The OSRM server differs (public demo vs Oman extract).
* v3 is a re-plan with continuity penalties.
* OR-Tools results vary from run to run.

Production's 294 OMR at 1192 km implies a cheaper truck mix, with 3 t trucks doing several loads, than any plan here.

## Files

* `instances.py`: the harness.
* `validate_baseline.py`: re-creates `results/baseline.json`.
* `cache/<name>.json`: solver matrices (ints, plus a coordinate hash).
* `cache/osrm_http/`: raw OSRM responses, keyed by URL. Set `BENCH_OFFLINE=1` to forbid any network access.
* `results/`: benchmark outputs.

Other agents' folders (`audit/`, `exports/`) are not part of this harness.
