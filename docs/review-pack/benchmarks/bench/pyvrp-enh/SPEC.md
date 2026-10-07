# Build spec: optimizer enhanced with PyVRP

- **PR title:** "Optimizer enhanced with PyVRP: a second search, the engine's rules pick the plan"
- **Branch:** `opt-pyvrp-candidate`, cut from `main` **after** P6 (`audit-p6-solver-accuracy`) and P10 (`opt-long-search`,
  with rule 22) have merged. Every line reference below is to P10 at `05bf585` and P6 at `7c81638`; re-read both after the merge.
- **Written:** 30 Sep 2026, from the Task A capability study (`taskA/`) and the Task B prototype (`pv_convert.py`,
  `pv_run.py`, `pv_bridge.py`, `hybrid_run.py`, `results/`), all under `C:/Users/abdulr/routeiq/.dev/bench/pyvrp-enh/`
  (git-ignored). No repo file was changed to write this spec.
- **Owner direction (30 Sep):** *"enhance our model by using techniques from the best open-source solver on the standard
  public sets. We don't need to invent something new now."* So this PR adopts PyVRP's published solver (iterated local
  search, the library as released) as a second search. It adds **no new search algorithm**. The engine's own feasibility
  checks, exact timing and RECOMMENDED cost score stay the only judge. A PyVRP plan is one more candidate: it can make the
  chosen plan better, never worse and never infeasible.
- **Owner answers used here:** (5) overtime is per driver, and a driver keeps one truck all day, so a truck day is a
  driver day. That is exactly the engine's `TruckDay` and PyVRP's per-route shift and overtime. (8) the working day is 07:00
  to 18:00 and the dispatcher must be able to change shifts and hours in Settings. So the PyVRP model reads every hour from
  the request (Settings), never from a constant (section 9.4).

---

## 1. What "done" means

1. On every solve (QUICK and THOROUGH), PyVRP 0.14.0 searches the same day in one more worker process of the solver's pool,
   inside the same single deadline.
2. Its best plan enters the engine's post-solve stage as one more source. It is re-timed exactly, repacked with CP-SAT for
   RECOMMENDED's and MIN_TRUCKS' prices, scored on the RECOMMENDED objective and checked by `feasibility.check_scenario`.
   Each option still picks its own best candidate by its own goal, and service comes first.
3. **Guarantee:** the engine's own candidates are built exactly as without PyVRP, and PyVRP only adds candidates. For every
   option, the chosen plan is therefore never worse on that option's goal (unserved priority value first, then cost) than
   the plan the engine alone would have chosen from the same search. A PyVRP-sourced plan that is not VERIFIED is never
   returned.
4. If PyVRP is off, fails, dies, hangs, cannot import, finds no feasible plan, or the machine is too small, the solve
   answers exactly as the engine alone would. It logs one line with the reason, and the search report says why.
5. Cancel, "use the best plan so far" (stop) and rule 22 behave as in P10. PyVRP stops within about 0.3 s of a stop or
   cancel (measured 0.09-0.31 s).
6. The benchmark gates in section 15.4 pass, and the owner gets the before/after table (section 15.5): priority service
   first, then trucks, loads, km, money and time.

---

## 2. Decisions for the owner (recommended answer first)

| # | Decision | Recommended | Why | If the owner says no |
|---|---|---|---|---|
| D1 | PyVRP version | **Pin `pyvrp==0.14.0`** and port the legacy `/optimize` `solver.py` to the 0.14 API (8 changed lines; the legacy endpoint stays, as decided) | 0.14.0 ran 1.4-2.2x more iterations per second in Task B (Task A measured about 0.9x on syn300). Through the judge it gave the better plan in 4 of 6 pilot runs: real80 x2, syn300, syn150 seed 1. It was worse on syn60 and syn150 seed 2 in the "hard" variant, and Task A called raw quality a tie within noise. With prizes, 0.13.4 got stuck at 11 routes on Solomon r108 and left 3 clients out. 0.14 also has search callbacks. Task A's port passes the legacy tests 27/27, run twice; unported, 0.14.0 fails 6/27 (`add_depot(x=)` TypeError) | Stay on 0.13.4 behind a ~40-line version shim (`taskA/vcompat.py`). Nothing NMWC needs is 0.14-only, but expect weaker plans on big days (pilot: syn300 1,208 against 1,009 OMR through the judge) |
| D2 | Default | **On for QUICK and THOROUGH**, switched off automatically below 2 effective CPUs (`SOLVER_PYVRP_MIN_CPUS`, confirmed by the 1-core bench lane) | The Railway solver's vCPU is still unknown (handbook 7.5). On 1 vCPU the two searches would share the core | `SOLVER_PYVRP=thorough` (night plans only) or `off` |
| D3 | THOROUGH timing | PyVRP may search until the tail that is kept for the load re-check, stopping earlier under the **same stall rule** as RECOMMENDED | On syn150 at 600 s, PyVRP's last improvement came at 1,129 of 1,200 s. The request still ends within the cap | PyVRP stops when the engine's searches stop (the request then ends sooner when RECOMMENDED converges early) |
| D4 | What the dispatcher sees | One sentence in the search result when a PyVRP plan was chosen, plus the option note (section 12.3). No new screen | Honest, and costs one line | Logs and the saved search report only |

---

## 3. Evidence so far (prototype, Task B)

**Conditions:** engine at `3451f4d` (before P6/P10), `SOLVER_PARALLEL=0` except the rows marked *production*, PyVRP
0.14.0 with default parameters, preferred windows imposed as hard windows ("prefhard"), seed 1. Machine: shared 6-core PC,
CPU 5-80%. Each row is *paired*: one engine search, then the post-solve stage run on engine sources only (E) and on engine
+ PyVRP sources (H). Every one of the 46 NMWC rows was VERIFIED, feasible under the independent evaluator, and re-scored
exactly. Units: RECOMMENDED objective in OMR, trucks / loads / km, 0 unserved on every row.

| Day | Limit | Engine alone (E) | Hybrid (H) | Change | E -> H trucks / loads / km | Early-arrival penalty E -> H (OMR) |
|---|---|---|---|---|---|---|
| real80 (83 stops) | auto 20 s | 533.73 | **527.93** | -1.09% | 5/14/991 -> 5/14/972 | 29.4 -> 31.3 |
| real80, production pool | auto 20 s | 533.01 | **524.80** | -1.54% | 5/14/977 -> 5/14/969 | 30.9 -> 29.0 |
| real80 | 600 s | 525.35 | **522.58** | -0.53% | 5/14/966 -> 5/14/961 | 28.4 -> 28.4 |
| syn60_s1 | auto 20 s | 254.54 | **238.56** | -6.28% | **4**/5/444 -> **3**/6/447 | 11.7 -> 16.9 |
| syn60_s1 | 600 s | 248.21 | **237.88** | -4.16% | **4**/5/413 -> **3**/5/434 | 12.8 -> 18.3 |
| syn150_s1 | auto 50 s | 506.00 | **490.43** | -3.08% | **8**/9/805 -> **7**/10/757 | 26.8 -> 45.5 |
| syn150_s1 | 600 s | 498.52 | **480.16** | -3.68% | **8**/9/766 -> **7**/9/716 | 28.8 -> 43.0 |
| syn300_s1 | auto 150 s | 1,036.60 | **913.54** | -11.87% | 12/24/1,754 -> 12/23/1,488 | 64.1 -> 65.8 |
| syn300_s1, production pool | auto 150 s | 1,019.35 | **906.83** | -11.04% | 12/24/1,807 -> 12/23/1,471 | 54.4 -> 64.3 |
| syn300_s1 | 600 s | 1,014.68 | **905.39** | -10.77% | 12/24/1,803 -> 12/23/1,454 | 51.8 -> 67.7 |

- **Hybrid <= min(E, PyVRP alone) on every run.** real80 at 600 s gave 522.58 OMR, a new best known. The proven bound is
  492.79, so that plan is at most 6.0% above optimal.
- **At the automatic limit the hybrid beats the engine's own 600 s result on all three synthetic days.** On syn300 it also
  beats P10's THOROUGH result (957.7 OMR, `OPTIMIZER_BENCHMARK.md` §10.3).
- **Public sanity check at the automatic limit (paired):**
  - X-n101-k25: +6.47% -> the proven optimum 27,591 (27 -> 26 vehicles);
  - Solomon r108: 10 -> 9 vehicles;
  - Solomon rc201: +2.52% -> +0.47%.
- **The cost is CPU:** one more busy core during the search (about 2x CPU-seconds). The extra wall time was +0.1 to +10 s,
  for the extra source in the stage.
- **The one trade-off:** PyVRP cannot see the P1/P2 early-arrival preference (section 7). Its plans save 3-125 OMR of
  operating money but carry up to 19 OMR more early-arrival penalty (syn150). The judge counts that penalty, so the net
  objective was still lower on every row.
- **Model check:** the PyVRP model priced 18 existing engine plans at -0.14% to -0.20% of the engine's operating money
  (`results/model_check.json`). The gap comes from rounding the driver rate to whole units per second.

---

## 4. Version and dependencies

- **`apps/solver/requirements.txt`:** replace `pyvrp>=0.13.0,<0.14` with `pyvrp==0.14.0`. The comment says: the dispatch
  engine's second search, plus the legacy `/optimize` endpoint, and that the version is pinned exactly because 0.14 changed
  the API.
- **Legacy port (`apps/solver/solver.py`, D1):** apply the diff in `taskA/legacy_port/app/solver.py` against
  `solver_orig.py`:
  - `model.add_location(...)`, then `add_depot(location, ...)` and `add_client(location, ...)`;
  - edges join Locations;
  - `route.visits()` becomes `[a.idx + 1 for a in route if a.is_client()]`.

  `tests/test_solver.py` (27 tests) must pass unchanged. No behaviour change is intended for `/optimize`.
- **Wheels:** PyPI has `cp311-manylinux_2_27_x86_64.manylinux_2_28` for 0.14.0. The Dockerfile uses `python:3.11-slim`
  (glibc 2.36), so no compiler is needed. CI (`ci.yml`) uses Python 3.11 on ubuntu-latest. Local dev uses Python 3.12.13
  on Windows, which has a cp312 wheel (`venv-ref`).
- **Dependencies:** numpy (already present through OR-Tools), matplotlib, tqdm, vrplib. These are the same four as 0.13.4,
  so the image gains nothing new. The native module grows from 0.65 to 1.04 MB. The licence is MIT: add a line to the
  handbook's dependency table.
- **Guard test:** `importlib.metadata.version("pyvrp") == "0.14.0"`, and the requirements line reads exactly
  `pyvrp==0.14.0`.

---

## 5. Where PyVRP runs: one more process in the solver's worker pool

### 5.1 Pool size

`optimize_dispatch` starts the pool before the road matrix (rule 22) with **one more process when PyVRP is on**:
`_start_workers(max(1, n_alternatives) + (1 if pv_on else 0), ...)`.
- With all three options that is 3 processes (today: 2).
- With RECOMMENDED only, 2 (today: 1).

The rule-22 proof (`check_started`, one ping task) is unchanged. PyVRP gets no special treatment at pool start: a pool that
cannot start still answers 503 WORKERS_UNAVAILABLE.

### 5.2 Timeline

```
QUICK (auto limit L, three options)
  worker 1  | RECOMMENDED (L) ........ | MIN_TRUCKS (L/2) ..... | stage: RECOMMENDED goal ..... |
  worker 2  |                          | MIN_DISTANCE (L/2) ... | stage: MIN_TRUCKS goal ...... |
  worker 3  | PYVRP ......................................... X  (told to stop when the alternatives are collected)
                                                            ^ search_over.set(); PyVRP answers in <= 0.3 s (+ grace)
THOROUGH (cap C, e.g. 1,200 s)
  worker 1  | RECOMMENDED (until stall or C - tail) ..... | MIN_TRUCKS ... |     | stage (4 sources) |
  worker 2  |                                             | MIN_DISTANCE . |     |                   |
  worker 3  | PYVRP (until its own stall rule, a stop/cancel, or C - tail.stage_sec - grace) .. X |
```

- **Submit** the PyVRP job right after `_window_prefilter` and `_submatrix`, just before RECOMMENDED is submitted. The job's
  arguments are the same tuple as RECOMMENDED's `(req, solvable, tds, mx)` plus a `PvSettings`. The model is built **inside
  the worker**, so the API process never imports pyvrp or holds its matrices.
- **QUICK:** PyVRP searches for as long as the engine's searches, about 1.5 x L with three options (the prototype's
  production runs). When the alternatives are collected, or RECOMMENDED finishes when there are no alternatives or they were
  skipped, `_run_scenarios` sets the pool's new `search_over` Event. It then waits for PyVRP's answer until
  `now + SOLVER_PYVRP_STOP_GRACE_SEC` (default 10 s). QUICK's search timing is unchanged; only the stage gains one source
  (section 8.3).
- **Backstop:** PyVRP also carries `MaxRuntime(planned_phase + ALT_GRACE_SEC)`, in case the flag is missed.
- **THOROUGH (D3):**
  - PyVRP runs until the earliest of: its own stall under **P10's `stall_rule(min_sec = QUICK's limit for the day)`** with
    the same `THOROUGH_STALL_SEC` and `THOROUGH_STALL_SHARE`, applied to PyVRP's best feasible cost; the moment
    `budget_end - tail.stage_sec - grace`; a stop request; or a cancel.
  - After the alternatives, `_run_scenarios` waits for PyVRP until that moment. The request therefore still ends within the
    cap, and `used_sec` stays <= `cap_sec`.
  - When RECOMMENDED converges early and PyVRP is still improving, the request lasts longer than without PyVRP, but never
    past the cap.
- **`SOLVER_PARALLEL=0`** (tests and development only): PyVRP runs in-process after the engine's searches, bounded by
  `SOLVER_PYVRP_MAX_ITERS` if set, otherwise by RECOMMENDED's limit.

### 5.3 How PyVRP is stopped

PyVRP's stopping criterion is a small callable, as in the prototype's `Stopper`:

- it records the best cost and when it last improved (up to 12 points for the report);
- it returns True on `MaxRuntime`;
- if `SOLVER_PYVRP_MAX_ITERS` is set, it returns True at that iteration count;
- in THOROUGH, it returns True when the stall rule says so;
- **at most every 0.25 s**, it returns True when the pool's `_STOP_FLAG` (stop or cancel) or the new `_SEARCH_OVER` flag is
  set.

The flag check is throttled because the callable runs every iteration, and a multiprocessing Event costs a lock each time.

Both flags are multiprocessing Events that `_Workers.__init__` creates, and `_worker_init(beacon, stop_flag, search_over)`
passes them to the workers, exactly like P10's stop flag.

---

## 6. The model mapping

Port `pv_convert.build_spec` into `apps/solver/pyvrp_candidate.py` as `build_model(req, solvable, tds, mx) -> PvModel`: plain
data plus the numpy matrices. Every price comes from the engine's own functions, so there is no second price list. Units are
the engine's: 1 unit = 0.00001 OMR.

| NMWC rule | PyVRP 0.14 field | Source in the engine | Exact? |
|---|---|---|---|
| Depot, route start/end | `Depot` 0 at `Location` 0, service 0 (the first load is loaded before its departure: `TruckDay.ready_s` is in the truck's window) | `req.depot` | exact |
| Next load (reload) | one reload `Depot` per distinct search turnaround, at the depot's place (zero travel to depot 0); `service_duration = _approx_gap_s(cfg, td)`; `VehicleType.reload_depots`, `max_reloads = trips_left - 1` (hard) | `_approx_gap_s`, `TruckDay.trips_left` | as the engine's own search: the turnaround assumes 80% of a full truck; exact when `loading_min_per_case = 0` |
| Trucks | one `VehicleType` per group of interchangeable usable trucks; `num_available` = group size; group key as the prototype (capacity, kg units, km rate, trip cost, fixed, window, trips, frozen state, turnaround, continuity id) | `_truck_days`, `TruckDay.usable` | exact |
| Capacity | `capacity = [cases, kg]`, `Client.delivery = [cases, kg]`; kg in **P6's 0.1 kg units** (`kg_units(stop)`, `td.max_kg_units`); a truck without a payload gets `sum(demand units) + 1` (the engine's own "unlimited") | P6 `dispatch_models.kg_units/payload_units`, `TruckDay.max_kg_units` | exact |
| Hard receiving window (service must start inside) | `Client.tw_early/tw_late` (seconds; open end -> `min(2 x DAY_MIN x 60, HORIZON_S)`) | stop `hard_start_min/hard_end_min` | exact |
| Preferred window | "prefhard": the hard window is tightened to hard ∩ preferred when that is not empty; otherwise the hard window is kept | stop `pref_*` | approximation (PyVRP has no soft windows); the judge prices the real penalty |
| Service time | `Client.service_duration = service_min x 60` | stop | exact |
| Truck hours, frozen return, same-day loading | `VehicleType.tw_early = min(first, latest)` where `first = max(earliest_depart_s, ready_s + gap)`; `tw_late = latest_return_s` | `TruckDay` | exact for the window; the turnaround is approximate as above |
| Shift maximum | `shift_duration + max_overtime = shift_max_min x 60` (hard maximum route duration); for trucks with frozen loads the window already ends at anchor + shift max (the engine has no span bound there) | `cfg.shift_max_min`, `TruckDay.shift_anchor_s` | exact |
| Overtime (per driver = per truck day, owner answer 5) | `shift_duration = overtime_after_min x 60`, `unit_overtime_cost = round(overtime_cost_per_hour x 1e5 / 3600)`, `max_overtime = shift_max - overtime_after`; frozen trucks: nominal = `LR.overtime_bound_s(td, after) - tw_early` (P6 E4, only new overtime) | `cfg`, P6 `load_repack.overtime_bound_s` | exact for fresh trucks; approximate for frozen trucks (PyVRP counts from its own route start) |
| Driver pay (whole truck day) | `unit_duration_cost = round(driver_cost_per_hour x 1e5 / 3600)` on route duration (first departure -> last return, waiting and turnarounds included) | `cfg.driver_cost_per_hour` | rounding: 69 units/s for 2.5 OMR/h (-0.6% of driver pay); frozen trucks' waiting after their last frozen return is not counted |
| Km cost (fuel counted once) | one distance **profile** per km-rate class: `int(round(d x key / 1000))` per arc, key as in `_solve_scenario`; `unit_distance_cost = 1` | `_km_rate_omr` | exact (same rounding) |
| Per-load (trip) cost | + `trip_units + 1` on every arc into a reload depot (the engine's "+1: never reload for nothing"); the first load's trip cost goes into the fixed cost | `_solve_scenario` arc costs | exact |
| Fixed truck cost | `fixed_cost = fixed x 1 (0 for a truck with frozen loads, B3) + trip cost of the first load` | `SCENARIOS["RECOMMENDED"]` | exact |
| Plan continuity (re-plans) | when `change_penalty_per_stop > 0` and any stop has `previous_truck_id`: one profile and one vehicle type per truck, + change units on arcs into a stop that sat on another truck | `_solve_scenario` continuity | exact |
| Strict priorities | every stop optional (`required=False`), `prize = _drop_penalties(_service_values(...), RECOMMENDED)[k]`, the engine's own drop penalty | `_service_values`, `_drop_penalties` | exact on days with enough capacity; see section 7 for capacity-shortage days |
| Durations | one duration matrix (seconds) shared by every profile; depot <-> reload depot = 0 | `mx.duration_s` | exact |
| Coordinates | depot-relative metres, used only by PyVRP's geometric neighbourhood | `req.depot`, stops | not used for cost |

- **Mapping back:** `plan_of(result, model)` turns each route (vehicle type, then clients per trip) into `{truck idx: [load,
  ...]}`. It takes that type's trucks in code order, as the prototype does; identical trucks are relabelled by the repack
  anyway.
- **Validation before the stage:** client indices are in range and each appears at most once; loads per truck <=
  `trips_left`; every load fits cases and kg units. Otherwise the whole candidate is dropped with reason `INVALID_PLAN`, so
  `_assert_reconciled` can never be hit by a PyVRP bug.
- **Timing the source:** `LR.time_plan(day, plan, rec_pricing)` (exact). When that returns None, which is only possible with
  loading time per case, the prototype's `_asap` timetable with the search turnaround is used instead. The stage's fit repack
  then repairs the plan exactly as it repairs the engine's raw plans.
- **Search parameters:** `pyvrp.solve(data, stop, seed, collect_stats=False, display=False, params=SolveParams())`, i.e.
  PyVRP's default iterated local search (restart after 150,000 iterations without improvement), unchanged. The only
  deviation is `PenaltyParams.max_penalty` on capacity-shortage days (section 7). There is no warm start: PyVRP starts at the
  same moment as the engine.

---

## 7. Priorities, penalties and 64-bit safety

**What Task A measured:**
- PyVRP's costs are int64.
- With the default `max_penalty = 1e5` and a capacity shortage (1 P1 against 5 P5), both versions returned an
  **infeasible** plan on 6/6 runs.
- With `max_penalty` = 10 x the largest prize, both served only the P1 on 6/6 runs (strict priority kept).
- Priced at 1e15 per second, a 13,800 s time warp wraps int64 to -9.22e18.
- The engine's largest prize is 2.08e10 on real80, 4.5e12 on syn60, 1.49e14 on syn150 and 2.42e15 on syn300.

**The rule:**

1. **Days with enough capacity** (not short by the engine's own formula, below): default `PenaltyParams`, as measured
   (46/46 VERIFIED; every stop served on every benchmark day).
2. **Capacity-shortage days:** set `max_penalty = min(10 x max prize, P_safe)`. `P_safe` is the largest penalty for which a
   conservative bound on the penalised cost stays below 2^62:

   ```
   worst = sum(prizes) + sum over types of num x (fixed + (unit_duration + unit_overtime) x HORIZON_S)
         + max_arc x (n_clients + total reloads + n_vehicles) x n_vehicles
         + P x (sum(case demand) + sum(kg-unit demand) + n_vehicles x 2 x HORIZON_S)
   ```

   - On real80 this allows the full 10x: about 2.1e11 x 4.9e6 = 1.0e18.
   - On the big synthetic days it clamps to `P_safe`. PyVRP may then return an infeasible or non-strict plan. That is
     harmless: an infeasible best is not handed over (`NO_FEASIBLE_PLAN`), and a plan that serves less priority value loses
     in the judge, which ranks service first with the engine's full strict values.
   - `penalty_mode` (`DEFAULT` or `RAISED`, with the value) goes into the report.
3. **The shortage test** is the one `_build_scenario` already uses:
   `short_cases = sum(demand_cases) > sum(max_cases x trips_left)` over usable trucks, and `short_kg` in kg units when every
   usable truck has a payload. Extract it as `_fleet_shortage(stops, tds)` and use it in both places. Do not duplicate it.
4. **Hard assertion in `build_model`:** the day-shape bound with the chosen `max_penalty` is below 2^62. If it is not (it
   cannot be, given the engine's own `PENALTY_LIMIT`), PyVRP is skipped with `MODEL_TOO_LARGE`.
5. **Days short by time** (hard windows or shifts, not capacity) keep the default penalties. PyVRP may then return an
   infeasible best, so there is no candidate and the engine's plan stands. The bench's shortage lane measures how often this
   happens (section 15).

---

## 8. How PyVRP's routes enter the post-solve stage and the pick

### 8.1 `_post_solve(..., extra: dict[str, LR.TimedPlan] | None = None)`

Today (P10 line 2381) the sources are the raw scenarios. The change:

- `sources` = the engine's raw scenarios, **as today**. `extra_sources = [LR.Source("PYVRP", timed)]`.
- `carried`, `left_out` and `optional` for the engine's sources are computed **from the engine's sources only**, as today.
  This keeps their repack inputs identical: today `left_out` is taken over all sources, so a stop PyVRP misses would change
  the repair weights of the engine's sources.
- The PyVRP source gets its own optional set: the stops it does not carry, weighted by `_repair_weights` over the union's
  left-out stops.
- The stage jobs (one per goal in `_stage_goals`) receive `extra_sources` too. So PyVRP is repacked for RECOMMENDED's prices
  and, when MIN_TRUCKS has a plan, for MIN_TRUCKS' prices, like every engine source.
- `cands` now includes candidates named `PYVRP`, `PYVRP+repack:RECOMMENDED`, `PYVRP+repack:MIN_TRUCKS` and `PYVRP+fit:...`.
  The pick loop is unchanged:
  `best = min(fits, key=lambda c: (goal(c.score), c.source.split("+")[0] != name))`.
  Ties keep the option's own source.
- `_GOALS` and the three option names are unchanged. "PYVRP" is never an option on the wire. This replaces the prototype's
  monkeypatch of `_GOALS` and `_build_scenario`.
- **An option whose own search found no plan** (status `NO_SOLUTION`) takes the best candidate for its goal when the PyVRP
  source has one. Its status becomes `OPTIMIZED`, with the note in section 12.3. Today that option has no plan at all, so
  this can only help.

### 8.2 `load_repack.build_candidates(..., extra_sources=(), extra_optional=None, extra_budget_s=0.0)`

- `time_raw` also times and scores the extra raw plans.
- The engine's sources are processed first, in their existing order ("fewest loads first"), with their existing budget
  (`budget_s`, `share(n) = min(cap_s, left / (n_engine - n))`), exactly as today.
- Then each extra source gets `min(cap_s, budget_s + extra_budget_s - elapsed)` for its repack, and for its fit repack when
  needed.

Consequence: the engine's candidates are built from the same inputs with the same time as without PyVRP, and PyVRP only adds
candidates. So `min(engine candidates ∪ PyVRP candidates) <= min(engine candidates)` for every goal. CP-SAT is still
time-limited, so this is exact only when its solves finish (OPTIMAL). The tests use such days; the benchmark checks it on
real ones.

### 8.3 Stage time

- **QUICK:** `job_budget = min(cap x (n_engine_sources + 1), budget_end - t0 - STAGE_GRACE_SEC - 5)`, where `cap` is
  `min(15, max(3, L/2))`. That is at most +15 s, and +0.1 to +10 s was measured.
- **THOROUGH:** `ThoroughTail.of(alt_sec, repack_cap, n_alternatives, n_sources)` reserves `repack_cap x n_sources` with
  `n_sources = 3 + (1 if pv_on else 0)`. That is 30 s more for PyVRP by default, so RECOMMENDED's search is 30 s shorter.
  - `thorough_tail`'s proportional shrink replaces its hard-coded 3 with `n_sources`.
  - P10's `test_a_cap_below_20_min_shrinks_the_tail_in_proportion_and_keeps_the_alternatives` runs for 3 and 4 sources.
- **After a stop request:** QUICK's repack cap, as in P10. PyVRP's best-so-far plan is still judged.

### 8.4 Belt and braces: never an unchecked PyVRP plan

- After `_build_scenario` builds the chosen plan: if `best.source` starts with `PYVRP` and `new.feasibility.status !=
  "VERIFIED"`, rebuild that option from the best non-PYVRP candidate that fits. Log a WARNING
  `pyvrp run=<id> <option>: candidate failed the independent check (<n> violations); the engine's plan is used`.
- `_assert_reconciled` still runs on every built scenario, as today.

---

## 9. Frozen loads, same-day plans, continuity, settings

1. **Frozen loads (LOCKED / LOADING / DISPATCHED).**
   - They are never in the PyVRP model: PyVRP sees only the stops of new loads (`solvable`).
   - A truck with frozen loads becomes a vehicle only while `TruckDay.usable`, with fixed cost 0 (B3),
     `max_reloads = trips_left - 1`, and `tw_early` = the engine's first new departure (last frozen return + turnaround).
     Its `tw_late` = `min(depot close / own hours, anchor + shift max)`.
   - Its driver-pay anchor and E4 overtime are approximated (section 6); the judge prices both exactly (`costing.py`,
     `LR.time_truck`).
   - Frozen trucks form their own vehicle types (the group key includes `n_frozen`, anchor and frozen return).
2. **Same-day plans (`loading_from_min`).**
   - `TruckDay.ready_s` moves `tw_early` to `ready_s + gap`, exactly as `_solve_scenario` does for the route start.
   - Stops whose window has passed are removed by `_window_prefilter` before either search.
   - P10's same-day THOROUGH timing (start of search + cap) is unchanged, because PyVRP ends within the cap.
3. **Re-plans with continuity.** Per-truck profiles and types (section 6). The judge's `change` price stays the reference.
4. **Settings (owner answer 8).**
   - Nothing in `pyvrp_candidate.py` holds a time of day. Shift start, shift maximum, overtime threshold, depot hours and
     truck hours come from the request, which the web builds from Settings (`shiftStartMin`, `driverShiftMaxMinutes`,
     `overtimeAfterMin`, depot and truck availability).
   - A test changes them to 07:00 / 11 h and checks that the model follows.
   - Setting the owner's 07:00-18:00 default in Settings is a separate web change, not part of this PR (section 18, Q2).

---

## 10. Rule 22, cancel, stop and failures

| Event | What happens | Report `pyvrp.status / reason` |
|---|---|---|
| `SOLVER_PYVRP=off`, or THOROUGH-only and this is QUICK | nothing submitted; pool size as today | SKIPPED / OFF |
| effective CPUs < `SOLVER_PYVRP_MIN_CPUS` | as off | SKIPPED / CPU_GATE |
| nothing to plan (no solvable stop) | not submitted | SKIPPED / NOTHING_TO_PLAN |
| the pool cannot start (rule 22) | 503 WORKERS_UNAVAILABLE, exactly as P10 | none (no response) |
| `import pyvrp` fails in the worker | job error -> engine plan | FAILED / IMPORT_FAILED |
| model assertion (section 7) | job error -> engine plan | SKIPPED / MODEL_TOO_LARGE |
| PyVRP raises | `_await_all` "error" -> engine plan | FAILED / FAILED |
| PyVRP's process dies (C++ crash, out of memory) | "lost": only this task is lost, siblings go on (P10 L23) | FAILED / LOST |
| PyVRP does not answer within the grace | "timeout": counts as `overran`, so the stage gets fresh workers (P10 path) | FAILED / TIMEOUT |
| the pool breaks while PyVRP runs | P10 rule 22 path (503 before RECOMMENDED exists; RECOMMENDED kept after) | as P10 |
| best plan infeasible | no candidate | NOT_CHOSEN / NO_FEASIBLE_PLAN |
| plan fails validation | no candidate | NOT_CHOSEN / INVALID_PLAN |
| cancel (the caller is gone) | `control.cancel` raises the stop flag; PyVRP returns within ~0.3 s; `_await_all` raises SolveAborted within 0.5 s; `workers.close()` kills whatever is left | none (504 as P10) |
| stop ("use the best plan so far", THOROUGH) | the stop flag reaches PyVRP too; its best so far is judged with QUICK's repack cap | CHOSEN or NOT_CHOSEN / stop_reason STOPPED |
| RECOMMENDED's own worker fails | SolveAborted, as today: PyVRP does not rescue a failed engine search in this PR | none |

New test hooks, like P10's: `ROUTEIQ_TEST_FAIL_PYVRP`, `ROUTEIQ_TEST_HANG_PYVRP` (sleeps and ignores flags),
`ROUTEIQ_TEST_KILL_PYVRP` (`os._exit(137)`), and `ROUTEIQ_TEST_PYVRP_PLAN` (injects a given plan: bad, infeasible,
duplicated).

---

## 11. CPU and memory on Railway

**Per solve (three options):**

| Phase | Busy worker processes today (P10) | With PyVRP |
|---|---|---|
| QUICK search, RECOMMENDED (L s) | 1 | 2 |
| QUICK search, alternatives (L/2 s) | 2 | 3 |
| THOROUGH search (most of the cap) | 1 | 2 |
| THOROUGH alternatives (>= 60 s) | 2 | 3 (when PyVRP is still running) |
| Stage (CP-SAT, `num_workers=2` per job) | 1-2 jobs | 1-2 jobs, one more source each |

- **CPU-seconds** roughly double: the prototype's hybrid used 1.6-2.1x the engine's CPU (real80 auto 1.6x, the other
  runs 1.9-2.1x). If the Railway plan bills CPU by use, solver CPU cost roughly doubles too.
- **Wall-clock limits are unchanged**, so deadlines hold whatever the CPU. On a shared core both searches just find less.

**CPU gate.** `pyvrp_candidate.effective_cpus()` is `len(os.sched_getaffinity(0))`, capped by the cgroup quota in
`/sys/fs/cgroup/cpu.max` (Railway containers). If it is not available, `os.cpu_count()` is used. PyVRP runs only when
`effective_cpus() >= SOLVER_PYVRP_MIN_CPUS` (default 2, to be confirmed by bench lane B5).

**Sizing guidance** for `RAILWAY_DEPLOYMENT.md`:
- 3 vCPU per solve allowed at once for full speed: 6 vCPU for the default `MAX_CONCURRENT_DISPATCH=2`.
- 2 vCPU works, but concurrent solves share cores.
- With 1 vCPU PyVRP switches itself off.
- The web's `SOLVER_MAX_CONCURRENT` stays at or below the solver's `MAX_CONCURRENT_DISPATCH`, as today.

**Memory.** Locally, a worker is about 54 MB after importing the engine, plus about 21 MB for numpy and PyVRP 0.14. Model
data is at most about 20 MB at 300 stops with per-truck continuity profiles: 2 x 302² x 8 B per profile. Budget about
**100 MB more per running solve**. The bench measures peak RSS on Linux (section 15). If the Railway memory limit is tight,
lower `MAX_CONCURRENT_DISPATCH` rather than turning PyVRP off.

**Startup and /ready.**
- `main.log_startup_warnings()` adds one INFO line:
  `PyVRP candidate: on (pyvrp 0.14.0, effective CPUs 4, min 2)`, or `off (reason)`.
- `/ready` gains `"pyvrp": {"enabled": bool, "version": "0.14.0", "effective_cpus": 4, "why": null}`. This is additive; `ok`
  does not depend on it.
- `RAILWAY_DEPLOYMENT.md`'s "verify after the deploy" step reads both.

---

## 12. Determinism and logging

### 12.1 Determinism

- **Seed:** fixed, from `SOLVER_PYVRP_SEED` (default 1), not derived from `run_id`. The same day and the same number of
  iterations give the same PyVRP plan.
- **Timing:** both searches are wall-clock limited, so production plans vary with machine load, as today (§10.1: "two runs
  differ only in how far the loaded machine let it get").
- **Tests:** `SOLVER_PYVRP_MAX_ITERS` makes PyVRP exactly reproducible, and small days let CP-SAT finish (OPTIMAL). Together
  they make the "never worse" guard deterministic.
- **The pick:** ties between equal goal keys keep the option's own source, so an equal PyVRP plan never replaces the
  engine's.

### 12.2 Log lines

Aggregates only; no stop ids or coordinates, the same policy as today:

```
INFO  pyvrp run=<id> model: clients=83 types=3 profiles=2 reload_depots=1 kg=on prefhard=0 shortage=no penalty=DEFAULT prizes=1.0e8..2.1e10
INFO  pyvrp run=<id> done: stop=SEARCH_END search=29.6s iters=4977 feasible=yes routes=5 loads=14 missing=0 best=497.15 last_improvement=29.4s
INFO  post-solve run=<id> RECOMMENDED: 5 -> 5 trucks, 14 -> 14 loads, 505.5 -> 497.9 OMR, +0/-0 stops (from PYVRP+repack:RECOMMENDED)   (existing line)
WARN  pyvrp run=<id> skipped: CPU_GATE (effective CPUs 1 < 2)
WARN  pyvrp run=<id> failed: LOST (its worker process stopped)
```

### 12.3 Response and web (additive only)

- **`dispatch_models.PyvrpReport`**, stored in `SearchReport.pyvrp: PyvrpReport | None = None`:
  - `status` (CHOSEN, NOT_CHOSEN, SKIPPED, FAILED) and `reason`;
  - `version`, `seed`, `penalty_mode`;
  - `search_sec`, `iterations`;
  - `stop_reason` (SEARCH_END, CONVERGED, CAP, STOPPED, ITERATIONS, MAX_RUNTIME) and `last_improvement_sec`;
  - `feasible`, `routes`, `loads`, `missing`;
  - `chosen_for: list[str]` (the option names);
  - `best_over_time`: up to 12 points of `[sec, PyVRP objective in OMR, stops left out]`. Like the engine's points, this is
    a score, not money: it includes uncollected prizes.
- **`packages/shared-types/src/dispatch.ts`:** the optional `PyvrpReport` type.
- **Engine name:** `DispatchResponse.engine` stays `"ortools-routing"`, the stored wire value.
- **Option note (dispatcher words),** when an option's chosen source starts with PYVRP. This replaces the "Loads were
  re-assigned after the route search" sentence for that option:
  *"A second route search (PyVRP) found a better plan: 6 -> 5 trucks, 17 -> 14 loads, 545 -> 498 OMR operating cost. It was
  checked, timed and costed by the planner's own rules."*
  For a NO_SOLUTION rescue:
  *"The main route search found no plan; this plan comes from the second route search (PyVRP) and passed the planner's
  checks."*
- **Web (D4, small):** `searchResultText` in `dispatch-job.ts` adds one sentence when `search.pyvrp.status == "CHOSEN"`:
  *"A second route search (PyVRP) found the chosen plan for: Recommended."* Add a vitest for it. No database migration: the
  web copies the fields it shows.

---

## 13. Code changes, file by file

| File | Change |
|---|---|
| `apps/solver/pyvrp_candidate.py` (new, ~450 lines) | `PvSettings`, `enabled(cfg) -> (bool, reason)`, `effective_cpus()`, `build_model()` (ported from `pv_convert.py`, using P6's `max_kg_units` / `kg_units` / `overtime_bound_s` directly), `worst_case_bound()`, `solve_in_worker(job)` (lazy `import pyvrp`; the stopping criterion of section 5.3; the test hooks), `plan_of()` plus validation, `timed_source()` (`time_plan`, else `_asap` from `pv_bridge.py`), `status()` for `/ready`. It does not import pyvrp at module level |
| `apps/solver/dispatch_solver.py` | `_Workers`: a `search_over` Event; `_worker_init(beacon, stop_flag, search_over)` and a `_SEARCH_OVER` global. `optimize_dispatch`: pool size +1 when on. `_run_scenarios`: submit PYVRP, set `search_over` (QUICK), wait with its deadline, `overran` includes a PyVRP timeout, pass `extra` to `_post_solve`, `state["pyvrp"]`. `ThoroughTail.of` / `thorough_tail`: `n_sources`. `_post_solve`: `extra` (section 8.1), the VERIFIED guard (8.4), the option notes (12.3), the NO_SOLUTION rescue. `_fleet_shortage()` extracted from `_build_scenario`. `_search_report`: the pyvrp field |
| `apps/solver/load_repack.py` | `build_candidates(..., extra_sources, extra_optional, extra_budget_s)` (section 8.2) |
| `apps/solver/dispatch_models.py` | `PyvrpReport`; `SearchReport.pyvrp` |
| `apps/solver/main.py` | the startup line; `/ready` `pyvrp`; docstring of `/optimize-dispatch/stop` (PyVRP's best so far is judged too) |
| `apps/solver/solver.py` | the 8-line 0.14 port (D1) |
| `apps/solver/requirements.txt` | `pyvrp==0.14.0` and its comment |
| `apps/solver/tests/conftest.py` | `SOLVER_PYVRP=off` by default, so every existing test keeps its exact behaviour; new tests switch it on |
| `apps/solver/tests/test_pyvrp_candidate.py` (new) | section 14 |
| `packages/shared-types/src/dispatch.ts`, `apps/web/lib/jobs/dispatch-job.ts` (+ vitest) | section 12.3 |

**New environment variables** (solver only; none needed on web):

| Variable | Default | Meaning |
|---|---|---|
| `SOLVER_PYVRP` | `on` | `on`, `off`, or `thorough` (night plans only) |
| `SOLVER_PYVRP_MIN_CPUS` | `2` | the CPU gate (section 11) |
| `SOLVER_PYVRP_SEED` | `1` | PyVRP's seed |
| `SOLVER_PYVRP_STOP_GRACE_SEC` | `10` | how long to wait for PyVRP's answer after it is told to stop |
| `SOLVER_PYVRP_MAX_ITERS` | unset | tests and development only: stop after N iterations |

THOROUGH's stall rule reuses `THOROUGH_STALL_SEC` and `THOROUGH_STALL_SHARE`.

---

## 14. Tests (pytest; small days, fast)

New file `apps/solver/tests/test_pyvrp_candidate.py`. Days come from `test_dispatch.nmwc_day(n, seed)` (20-40 stops) and
the `test_worker_start._day` helper. The PyVRP run uses `SOLVER_PYVRP_MAX_ITERS` (200-2,000) unless the test is about time.
Target: under 90 s added on CI.

**Model mapping (no search):**
1. `test_vehicle_types_group_interchangeable_trucks`: types, `num_available`, and type -> truck idx in code order.
2. `test_reloads_follow_trips_left`: reload depot service = `_approx_gap_s`; `max_reloads = trips_left - 1`; one reload
   depot per distinct turnaround.
3. `test_capacity_in_cases_and_p6_kg_units`, including a truck with no payload (= sum + 1) and a load exactly at the
   payload.
4. `test_prizes_are_the_engines_drop_penalties`: equal to `_drop_penalties(_service_values(...))`, strict and weighted
   priorities, with and without margins.
5. `test_shift_overtime_and_driver_pay_units`: `shift_duration`, `max_overtime`, `unit_overtime_cost`,
   `unit_duration_cost`; the maximum route duration equals the shift maximum.
6. `test_settings_hours_reach_the_model`: `shift_start_min=420`, shift max 660, a changed `overtime_after_min` and depot
   hours all move the vehicle windows and shift fields (owner answer 8).
7. `test_frozen_truck_and_same_day_windows`: a DISPATCHED load plus `loading_from_min`. Checks `tw_early` = the engine's
   route-start lower bound, fixed 0, and trips left.
8. `test_continuity_gives_one_type_per_truck_and_prices_moved_stops`.
9. `test_prefhard_tightens_only_when_the_intersection_is_not_empty`.
10. `test_model_prices_an_engine_plan_within_half_a_percent`: an engine plan re-built as a PyVRP `Solution`; the costs
    match the engine's operating money within 0.5% (measured -0.14% to -0.20%).

**Penalties and safety:**

11. `test_penalty_default_without_shortage_raised_and_bounded_with_shortage`: covers `_fleet_shortage`, `max_penalty` and
    `worst_case_bound < 2**62` on synthetic prize scales up to 2.4e15.
12. `test_shortage_day_serves_p1_before_p5` (the prio_probe case): the hybrid's RECOMMENDED serves the P1, and the unserved
    P5s carry the shortage reason.

**Round trip and the judge:**

13. `test_pyvrp_plan_maps_back_and_is_verified`: `plan_of` -> `time_plan` -> `_build_scenario` -> VERIFIED and reconciled.
14. **`test_hybrid_never_worse_than_engine_alone_on_the_same_seed`** (the guard). It is parametrized over 6 days
    (`nmwc_day(20|30|40, seed 1-2)`), plus a frozen-load day and a same-day day.
    - Capture the engine's raw scenarios once, through a `_post_solve` seam, with `SOLVER_PARALLEL=0`.
    - Run the stage twice on deep copies: E without `extra`, and H with the PyVRP source (fixed seed, `MAX_ITERS`).
    - For every option, assert `goal(H) <= goal(E)` (service first, then cost), `H.unserved` priority value <= E's, H is
      VERIFIED, and H's objective equals a re-score with `LR.time_plan` + `LR.score`.
    - The days are small enough that every CP-SAT solve ends OPTIMAL; the test asserts that, so a flaky timeout shows up
      as a test failure.
15. `test_a_bad_pyvrp_plan_never_wins`: injected (`ROUTEIQ_TEST_PYVRP_PLAN`) plans are one stop per load, one breaking a
    hard window, one over capacity, and one with a duplicated stop. Each time the engine's plan is returned, reasons are
    INVALID_PLAN or "infeasible when timed exactly", and the options are identical to the engine alone.
16. `test_unverified_pyvrp_pick_falls_back_to_the_engine` (`FZ.check_scenario` patched to VIOLATED for a PYVRP-sourced
    plan).
17. `test_no_solution_option_is_rescued_by_the_pyvrp_plan` (the option's search forced to NO_SOLUTION).
18. `test_engine_candidates_unchanged_by_the_extra_source`: `build_candidates` with and without `extra_sources` gives the
    same engine candidates (sources, plans, scores) on a day where every repack is OPTIMAL.

**Pool, timing and control (worker processes, like `test_worker_start.py`):**

19. `test_pool_has_one_more_process_only_when_pyvrp_is_on`, and `SOLVER_PYVRP=off` sends exactly P10's jobs.
20. `test_quick_search_timing_unchanged`: the OR-Tools parameters and limits are identical with PyVRP on (extends P10's
    `test_quick_search_gets_the_same_parameters_and_nothing_attached`); PyVRP's `stop_reason == "SEARCH_END"`; `used_sec`
    <= the off run's + cap + 3 s.
21. `test_thorough_pyvrp_stops_on_its_stall_rule_and_within_the_cap` (`THOROUGH_STALL_SEC=0.5`, a cap of 60 s).
22. `test_stop_request_reaches_pyvrp_and_its_plan_is_still_judged` (THOROUGH, stop at about 3 s).
23. `test_cancel_stops_pyvrp_and_its_worker_within_seconds`: SolveAborted within 1 s and no child process left.
24. `test_pyvrp_failure_modes_keep_the_engine_plan` (parametrized over FAIL / KILL / HANG / import error): the response
    equals the off run's shape; the reason is in the report and in one log line. HANG gives the stage fresh workers and the
    request still ends inside its budget.
25. `test_rule22_unchanged_with_pyvrp_on`: `ROUTEIQ_TEST_WORKER_START_EXIT=1` gives 503 WORKERS_UNAVAILABLE within
    seconds; nothing is searched in-process.
26. `test_cpu_gate` (`effective_cpus` patched to 1 gives SKIPPED / CPU_GATE; the cgroup parser is tested with sample
    `cpu.max` text).
27. `test_search_report_pyvrp_is_part_of_the_response_contract` (extends P10's contract test; the shared-types keys match).
28. `test_pyvrp_version_is_pinned`.

**Existing suites:**
- `test_solver.py` (legacy, 27) passes under 0.14.0.
- `test_dispatch.py`'s reconciliation, window and frozen-load e2e tests are parametrized to run once with `SOLVER_PYVRP=on`.
- Web vitest: one test for `searchResultText`.
- The web integration job in CI starts the real solver with PyVRP at its default (on), so the web tests exercise it.

---

## 15. Benchmark proof

### 15.1 Harness and rules

- **Harness:** `C:/Users/abdulr/routeiq/.dev/bench/pyvrp-enh/` (`hybrid_run.py` adapted to the PR, so that its paired
  E/H hook calls the new `_post_solve(extra=...)`), plus `.dev/bench/instances.py`, `bounds/` and `public/`. The repo is
  used read-only.
- **Machine:** at most 3 solver processes from the workflow. One production-mode hybrid solve alone uses 3 worker
  processes, so solves run **one at a time**.
- **Recording:** every command runs under `timeout N`, and every process started is checked and killed at the end.
  `bench_common.machine_context()` (CPU %, processes) is recorded before, during and after each run. Results are "time on a
  loaded machine".
- **Real data:** aggregates only for real80. Its PyVRP model files are deleted after each run, as in the prototype.

### 15.2 Runs (production worker pool, all three options unless noted)

| Lane | Instances | Mode | Before (P6+P10 main, `SOLVER_PYVRP=off`) | After (PR, on) | Wall-clock estimate |
|---|---|---|---|---|---|
| B1 NMWC QUICK | real80, syn60_s1..s3, syn150_s1..s3, syn300_s1 | QUICK | 2 runs (spread) | 3 PyVRP seeds, paired E/H in each | about 1.5 h |
| B2 NMWC THOROUGH | real80, syn150_s1, syn300_s1, shortage day (B3) | THOROUGH, cap 1,200 s | 1 run | 1 run (seed 1), paired | about 2.7 h |
| B3 priority service | `real80_short` and `syn150_s1_short` (harness variants: fleet cut until demand is about 115% of capacity; strict priorities) | QUICK | 1 | 3 seeds, paired | about 20 min |
| B4 frozen / same-day / settings | `scripts/bench_replan.py` days (locked and dispatched loads), a same-day `syn60_s1` (`loading_from_min` 10:00), `syn60_s1` with a 07:00 start and 11 h shift | QUICK | 1 | 1, paired | about 20 min |
| B5 CPU gate | real80, syn150_s1, pinned to 1 core and to 2 cores (`start /affinity 0x1` / `0x3`; children inherit) | QUICK | 1 | 1 | about 15 min |
| B6 public subset | X-n101-k25, X-n157-k13, X-n204-k19 (proven optima); Solomon r108, rc108, rc201, c108; G&H r1_2_1 (RECOMMENDED only, as the 29-Sep ladder) | auto limit | 1 | 1, paired | about 30 min |
| B7 memory | syn300_s1 hybrid on Linux (WSL or the CI image): peak RSS per worker (`/proc/<pid>/status` VmHWM) | QUICK | - | 1 | about 10 min |

Total: about 6 hours of machine time plus 1 day of hands-on work.

### 15.3 Checks on every row

- The engine's feasibility report is VERIFIED; the independent evaluator (`instances.evaluate` /
  `bench_common.evaluate`) finds it feasible; and `LR.time_plan` + `LR.score` re-score it exactly.
- Unserved counts are recorded per priority (P1..P5).
- For the paired runs, also: `H <= min(E, P)` on the objective and `unserved_value(H) <= unserved_value(E)`.

### 15.4 Gates (all must hold to merge)

- **G1:** all rows pass section 15.3.
- **G2 (priority service first):** on every paired run the hybrid serves no less priority value than the engine alone. On
  B3 the unserved counts P1..P5 after are lexicographically <= before, on every seed.
- **G3:** hybrid <= min(engine alone, PyVRP alone) on every paired run (the structural guarantee, visible).
- **G4 (quality):**
  - the median objective change over the 8 standard days is <= -1% at QUICK and <= 0% at THOROUGH;
  - no day's "after" is worse than its "before" by more than the spread of its two "before" runs;
  - on B6, no instance is worse (paired) and the median gap improves.
- **G5 (time):**
  - QUICK `used_sec` after <= before + the stage cap (<= 15 s) + 5 s on every day;
  - THOROUGH `used_sec` <= `cap_sec` on every run;
  - stop and cancel drills (tests 22-24) pass on the bench machine too.
- **G6:** the B5 and B7 results are recorded, and the `SOLVER_PYVRP_MIN_CPUS` default is set from B5. If the 1-core hybrid
  still beats the 1-core engine alone on both days, lower it to 1.

### 15.5 The owner's before/after table (template; priority service first)

One row per day and mode. The numbers are the median of the seeds; the full rows go in the appendix of §11 of
`OPTIMIZER_BENCHMARK.md`.

| Day | Mode | Unserved P1 / P2 / P3 / P4 / P5, before -> after | Trucks | Loads | km | Operating cost (OMR) | Preference penalties (OMR) | Objective (OMR) | Change | Time (s) | All checks |
|---|---|---|---|---|---|---|---|---|---|---|---|
| real80 | QUICK | 0/0/0/0/0 -> 0/0/0/0/0 | 5 -> 5 | 14 -> 14 | 977 -> 969 | 503.3 -> 496.9 | 30.9 -> 29.0 | 533.0 -> 524.8 | -1.5% | 47.6 -> 52.3 | yes |
| syn300_s1 | QUICK | 0/0/0/0/0 -> 0/0/0/0/0 | 12 -> 12 | 24 -> 23 | 1,807 -> 1,471 | 965.2 -> 843.9 | 55.2 -> 64.3 | 1,019.3 -> 906.8 | -11.0% | 241.0 -> 248.9 | yes |
| ... (all B1-B4 rows) | | | | | | | | | | | |

*The two rows shown are the prototype's production-pool runs (Task B, engine before P6/P10), as a preview only. The PR
replaces them with the B1-B4 results.*

Below the table, in plain words: what "preference penalties" are, including the early-arrival trade-off (section 3); that
no plan is claimed optimal; the proven "at most X% above optimal" line for real80 from `bounds/`; and the machine load.

---

## 16. Docs to update (in the PR)

- **`docs/OPTIMIZER_BENCHMARK.md`:**
  - §1 Decision: PyVRP is no longer "legacy only, to be removed". It is pinned at 0.14.0 and runs as a second search whose
    plans the engine judges.
  - New §11 "A second search: PyVRP (30 Sep 2026)": the method, what PyVRP cannot model, the guarantee, the B1-B7 results,
    the CPU and memory profile, and the gates.
- **`docs/OPTIMIZER_DESIGN.md`:** a plain-language section on how a plan is found now: two searches, one judge; what the
  second search cannot see (preferred windows approximated, the early-arrival preference, loading per case, frozen-truck
  pay); why the result can only get better.
- **`docs/PROJECT_HANDBOOK.md`:**
  - the architecture (the pool has one more process);
  - the search modes (2.7 / 4.9);
  - the env var table;
  - the dependency table (PyVRP 0.14.0, MIT);
  - the decision log (lines ~1814 and ~2464: PyVRP reversed);
  - the test counts;
  - 7.5: the solver vCPU question now also decides the CPU gate.
- **`docs/RAILWAY_DEPLOYMENT.md`:** the exact pin; CPU and memory per solve; the sizing guidance; `SOLVER_PYVRP*`; the
  "verify after the deploy" line (startup line and `/ready.pyvrp`); "each solve uses up to 3 OR-Tools processes" becomes
  "up to 3 worker processes (OR-Tools and PyVRP)".
- **`docs/DISPATCHER_GUIDE.md`:** one paragraph. A plan may come from the second search; nothing changes in how plans are
  reviewed, locked or dispatched; the option note says so.
- **`docs/admin.md`:** how to switch PyVRP off (`SOLVER_PYVRP=off`) and where the reason shows (`/ready`, the logs).
- **`apps/solver/README.md`:** the endpoint table (`/optimize-dispatch` engine: OR-Tools + PyVRP 0.14 candidate), the env
  vars, and the local-dev note (`SOLVER_PYVRP_MAX_ITERS`).

---

## 17. Effort and sequencing

| Step | Work | Days |
|---|---|---|
| 1 | Pin, legacy port, CI green (`test_solver.py` 27/27) | 0.25 |
| 2 | `pyvrp_candidate.py`: model (from `pv_convert`), runner and stopping criterion (from `pv_run`), mapping back and validation (from `pv_bridge`), penalty and 64-bit guard, CPU gate | 1.5 |
| 3 | `dispatch_solver`: pool size, `search_over` flag, submit and await, THOROUGH stall and tail (`n_sources`), stop and cancel, `SOLVER_PARALLEL=0` path, report | 2 |
| 4 | `_post_solve` extra sources, `build_candidates` isolation, VERIFIED guard, option notes, NO_SOLUTION rescue | 1 |
| 5 | Models, `main.py` (`/ready`, startup line), shared types, web sentence and its vitest | 0.75 |
| 6 | Tests (section 14) | 2 |
| 7 | Benchmark B1-B7 (1 day hands-on, about 6 h machine) and the owner table | 1 |
| 8 | Docs (section 16) | 1 |
| 9 | Review rounds and fixes (the project runs 2-4 review passes per PR) | 1.5-2 |
| | **Total** | **about 11-12 working days** |

**Order:** 1 -> 2 -> 4 (testable with `SOLVER_PARALLEL=0`) -> 3 -> 5 -> 6 -> 7 -> 8.

**Rebase notes after P6 and P10 merge:**
- use `TruckDay.max_kg_units`, `kg_units` and `LR.overtime_bound_s` directly; the prototype's `_kg_rule` probe goes;
- `_run_scenarios`, `thorough_tail` and rule 22's `_await_all` are P10's;
- P6's E5 "keep the plan it started from when a repack returns nothing" applies to the PyVRP source unchanged.

---

## 18. Risks and open questions

| Risk | Likelihood / impact | Mitigation |
|---|---|---|
| Railway solver has 1 vCPU (unknown, handbook 7.5) | medium / plans of both searches get weaker | CPU gate (default 2); B5 measures 1 and 2 cores; `/ready` shows effective CPUs; ask Railway's plan (Q1) |
| CPU and memory cost roughly double per solve | certain / cost, memory pressure | Documented; `MAX_CONCURRENT_DISPATCH` sizing; `SOLVER_PYVRP=thorough` as the cheaper setting |
| int64 overflow in PyVRP on large capacity-shortage days | low / a wrong "best" inside PyVRP | Default penalties when there is no shortage; `P_safe` clamp; bound assertion; the judge re-scores every plan anyway |
| Capacity-shortage days: raised penalties are unmeasured on NMWC days | medium / no gain on those days | B3 lane; worst case the engine's plan stands (G2) |
| PyVRP cannot see the early-arrival preference; preferred windows only approximated (prefhard) | certain / P1/P2 may arrive later inside their hard windows when that saves more money than the configured preference is worth (up to +19 OMR of penalty on syn150, net objective still lower) | The judge prices it with the owner's own `early_preference_per_min`. Raising that setting shifts the balance. State it in the owner table |
| prefhard makes PyVRP's day tighter than the real one | low / PyVRP needs more trucks and loses | Judge; no harm |
| Legacy `/optimize` port (D1) | low / the legacy endpoint breaks | 27 legacy tests; the owner's consent first; fallback is 0.13.4 with a shim |
| Time-limited results are not reproducible run to run | certain, as today | Fixed seed; tests use `MAX_ITERS`; the report says what ran |
| PyVRP native crash or hang | low / one task | Handled as "lost" or "timeout"; fresh stage workers; tests 24-25 |
| All three options become the same plan (seen on real80 and syn300) | medium / fewer real choices | Existing web handling ("Same plan as RECOMMENDED"); correct by design, since each option still picks by its own goal |
| THOROUGH requests last longer when RECOMMENDED converges early | medium / a slot held longer (never past the cap) | D3; `SOLVER_PYVRP` switch; the report shows both stop reasons |
| A future PyVRP release changes the API | certain over time | Exact pin; the version test; upgrade only with this bench |

**Open questions for the owner:**
- **Q1:** the Railway solver's vCPU and memory. This decides the CPU gate and `MAX_CONCURRENT_DISPATCH`.
- **Q2 (owner answer 8):** is 18:00 the latest return (shift maximum 11 h from 07:00), or when overtime starts? And should
  dispatchers, not only administrators, be allowed to edit shift hours? Today Settings needs the master-data role. This is
  a separate small web PR; the PyVRP model follows whatever the request says.
- **Q3:** agree D1 (pin 0.14.0 and port the 8 legacy lines).

---

## 19. Not in this PR (named so nobody adds them silently)

- Warm-starting the OR-Tools alternatives from the PyVRP plan (possible with `_initial_assignment`, but it needs sequencing
  and its own measurement).
- Warm-starting PyVRP from the plan in use, or from an incumbent store (REPORT.md item 5).
- PyVRP searches per option (MIN_TRUCKS or MIN_DISTANCE prices).
- OR-Tools 9.15's iterated local search and extra operators (REPORT.md item 3), a multi-core restart portfolio (item 4),
  and the proven "at most X% above optimal" line on screens (item 7).
- Retiring the legacy `/optimize` (the owner decided to keep it).

---

## Appendix: prototype files to port (all under `C:/Users/abdulr/routeiq/.dev/bench/pyvrp-enh/`)

- `pv_convert.py` -> `pyvrp_candidate.build_model`: the mapping is complete. Replace `_kg_rule` with P6's functions and the
  frozen-overtime approximation with `LR.overtime_bound_s`.
- `pv_run.py` -> `pyvrp_candidate.solve_in_worker`:
  - `build()` without the 0.13 branch;
  - `routes_of()` (0.14: activities with `.trip`);
  - `Stopper` gains the flags, the stall rule and MAX_ITERS.
- `pv_bridge.py` -> `plan_of_result` and `_asap` move into `pyvrp_candidate`. `extra_sources` and `judge` are replaced by
  the real `_post_solve(extra=...)` (section 8).
- `hybrid_run.py`, `final_table.py`, `model_check.py`: stay in the bench and become the B1-B7 driver.
- `taskA/legacy_port/app/solver.py`: the 0.14 port of the legacy solver (diff against `solver_orig.py`).
- `taskA/probe.py`, `taskA/prio_probe.py`, `taskA/overflow_probe.py`: sources for tests 11, 12 and 26's fixtures.
- Result files: `results/*.json` (46/46 verified rows); `results/model_check.json`.
