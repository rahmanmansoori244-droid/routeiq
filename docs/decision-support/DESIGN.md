# RouteIQ decision support - prototype design (15 Oct 2026)

This is a prototype on branch `feat/decision-support`. It is not deployed, and nothing in `main.py` imports it.
It sits **on top of** the existing dispatch engine (`dispatch_solver.optimize_dispatch`). The optimizer is not
replaced. Every plan it produces is checked by the existing independent check (`feasibility.check_scenario`) and,
on small instances, by a new exact oracle.

## 0. Ground rules

- **Never relax genuine restrictions.** A customer's real closing time, driver breaks, shift and return limits,
  truck capacity, small-truck-only customers and the one-customer rule stay as they are in every scenario. Only
  a window marked `SALES_PREFERENCE` may be flexed. A window marked `UNKNOWN` is treated as genuine.
  - RouteIQ has no field for window provenance today (see section 7, "proposed").
  - So the caller supplies a `window_provenance` map. Synthetic days carry generated labels.
  - Real days default every window to `UNKNOWN`. A what-if that flexes `UNKNOWN` windows is labelled
    **HYPOTHETICAL - needs confirmation that these are preferences**.
- **Faster unloading or reloading is never free time.** Such levers are labelled `requires_evidence=True`. They
  are reported in a separate "operational improvement potential" section, never folded into the baseline.
- **Money is cash only.**
  - Cash: `DispatchScenario.operating_cost` and its `truck_days` breakdown: fixed, trip, distance, fuel,
    driver and overtime, from `costing.truck_day_costs`.
  - Not cash: solver penalties (`objective.unserved_penalty`, `objective_value`, `preference_penalties`).
    These are artificial and are reported separately and labelled as such.
  - Time and capacity freed (minutes, pallet units, trips) are a third, separate column.
- **No invented financial results.**
  - Contribution margin is used only when the request carries `DispatchStop.margin`, or when the caller passes an
    explicit, labelled `margin_per_case` assumption.
  - Otherwise economics reports a **break-even margin per case**, not a profit. It needs a next-day plan: against a
    PROXY future cost (today's cost reused) a deferral cannot be judged, and no break-even is given.
- **No customer data in git.** Real requests stay outside the repository (codespace `~/ds-data`). Committed
  results for real days are aggregates or use anonymous stop labels (`stop-017`). They contain no customer ids,
  names or coordinates.
- **Honest claims.**
  - OR-Tools guided local search proves nothing; plans are "best found", never "optimal".
  - Optimality is claimed only from the exact oracle, on instances it solved completely.
  - Distances in experiments are HAVERSINE estimates (straight line x 1.3, road time factor). Production uses OSRM.
    Results say **estimated km**.
- **Equal compute.**
  - Every compared variant gets the same `config.time_limit_sec`, `search_mode='QUICK'` and scenario list
    `['RECOMMENDED']`, run one at a time, or with the same fixed concurrency.
  - "Seeds" are real seeds: OR-Tools routing has no seed, so seed *s* deterministically permutes the stop order of
    the request (`core.seeded`) and sets `SOLVER_PYVRP_SEED`. Results report the mean, min and max over seeds.
- **No future information in dynamic simulations.** The simulator samples actual durations and new orders up
  front with a seed, but reveals each one to the planner only when it happens.

## 1. Package layout (`apps/solver/decision_support/`)

| Module | Purpose |
|---|---|
| `__init__.py` | Package marker. Must stay free of `numpy` and `pyvrp` imports at module level (repo guard `test_api_process_no_pyvrp.py`). |
| `core.py` | Shared run and measure layer, used by every other module. |
| `synth.py` | Labelled synthetic NMWC-like days, 300+ invoices. |
| `history.py` | Historical adapters: loading a real request from a path outside the repo, anonymising it, and the empirical uncertainty model from aggregated 14 Oct actuals. |
| `ivms.py` | Aggregate statistics from the owner's IVMS truck GPS reports (section 1.4). |
| `whatif.py` | What-if and sensitivity analysis. |
| `economics.py` | Small-order (1-3 case) delivery economics. |
| `dynamic.py` | Rolling-horizon multi-trip simulator. |
| `explain.py` | Verdicts, conflict and relaxation ranking, trade-off frontier. |
| `exact.py` | Exact oracle for small instances. |
| `experiments.py` | CLI that runs the evidence suite and writes JSON + Markdown results. |

Tests live in `apps/solver/tests/test_ds_*.py`. They must be fast: total under 3 minutes on CI. Use tiny instances,
`time_limit_sec` 1-3 and `SOLVER_PARALLEL=0` where the existing tests do. Heavy runs live only in `experiments.py`.

### 1.1 `core.py` (the shared contract)

```python
@dataclass(frozen=True)
class Budget:            # equal compute for every compared run
    time_limit_sec: int = 20
    search_mode: str = "QUICK"
    seeds: tuple[int, ...] = (1, 2, 3)

def load_request(path) -> DispatchRequest           # json file (raw request or {"request": ...})
def offline(req) -> DispatchRequest                  # HAVERSINE, osrm_url None (experiments never call OSRM)
def seeded(req, seed) -> DispatchRequest             # deterministic stop-order permutation (seed 0 = unchanged)
def solve(req, budget, seed) -> RunResult            # one optimize_dispatch run, scenarios=['RECOMMENDED']
def solve_seeds(req, budget) -> list[RunResult]
@dataclass
class Metrics:            # everything comparable, from one scenario
    status: str; solver_status: str
    stops_total: int; stops_served: int; cases_served: int; cases_total: int
    served_by_priority: dict[int, int]; unserved_by_priority: dict[int, int]
    unserved_by_reason: dict[str, int]; proven_impossible: int     # prefilter / window-prefilter / no-room proofs
    trucks_used: int; trips: int; km: float
    cash: CashBreakdown          # fixed, trip, distance, fuel, driver, overtime, total (OMR) - from truck_days
    penalties: dict[str, float]  # ARTIFICIAL: unserved_penalty, window, early, continuity (OMR-equivalent, not cash)
    late_stops: int; minutes_outside_pref: int; paid_driver_min: int
    feasibility: str             # VERIFIED / VIOLATED / UNVERIFIED (independent check)
def metrics(req, response) -> Metrics
def summarize(results: list[RunResult]) -> dict      # mean/min/max of each numeric metric over seeds
def diff(base: dict, variant: dict) -> dict          # deltas of the summaries (variant - base)
```

`RunResult` holds the seed, the request digest, the `DispatchResponse` and `Metrics`. Helpers for anonymous
labels: `label_stops(req) -> dict[stop_id, "stop-NNN"]`.

### 1.2 `synth.py`

`make_day(n_invoices=320, seed=1, *, profile="nmwc") -> SynthDay` produces:
- the `DispatchRequest`;
- `window_provenance` (`CUSTOMER_HARD` / `SALES_PREFERENCE` / `UNKNOWN`);
- `accepts_afternoon` / `accepts_night` flags per customer;
- `invoice -> stop` mapping (several invoices per customer, merged per stop as the web does);
- `assumptions` (every invented number, listed).

Shape of the generated day:
- **Customers** are clustered around Muscat districts. The centres are public district coordinates; no real
  customer location is used.
- **Remote small orders** go to Quriyat, Samail and Bidbid.
- **Mixed fleet**: 4, 5, 6, 11, 12 and 14-bay trucks, `max_trips` 2-3.
- **Tight morning windows** for hypermarkets (07:00-11:00, 08:00-12:00).
- **About 25% of invoices** are 1-3 cases.
- **Service time** uses the web's formula: `base + per_case x cases`, with per case = 0.25 (the 14 Oct benchmark).
- **Priorities** P1-P5. Pallet units come from cases-per-pallet profiles.
- **Margins** are *not* generated unless `margin_per_case` is passed. The default is None.

### 1.3 `history.py`

- `load_real(path)`: the request plus `UNKNOWN` provenance for every window.
- `anonymise(req)`: replaces stop, customer and order ids with labels. Coordinates are kept in memory but never
  written to committed results.
- `UncertaintyModel`: lognormal multipliers for travel time and unloading minutes. Its parameters come from
  aggregated statistics of the 14 Oct plan-vs-actual data: reliable stops only, with medians and spreads committed
  as numbers. When no data is available, it uses defaults that are clearly labelled as assumptions.

### 1.4 `ivms.py`: truck GPS evidence (the owner's IVMS reports)

- **Sources.** Both files are kept outside the repository, on the codespace in `~/ds-data/`:
  - `ivms-feb-mar.xlsx`: the raw IVMS report, Feb-Mar 2026, 45,353 rows. Columns: driver/preseller, plate,
    vehicle type, STOPPED/IDLE/MOVING, start/end, duration, average and max speed, address, ignition, distance.
    There are no coordinates.
  - `truck-evidence-2026-10-12.xlsx`: the 13 Oct analysis, with sheets "Claims check" (unloading p25-p90 per chain
    from GPS visits), "Other delivery customers" (visits per customer), "Fleet parameters" (first departure, depot
    time, and so on) and "Proposed (truck GPS)".
- **Extraction.** `ivms.extract(raw_path, evidence_path) -> dict` imports openpyxl lazily (run with the tools
  environment on the codespace; openpyxl is not a solver dependency). It writes
  `decision_support/data/ivms_aggregates.json`, which holds **aggregates only**: no names, plates or addresses.
  The aggregates are:
  - **Travel speed** (km/h) percentiles of MOVING segments (>= 1 km, >= 2 min), by time-of-day band (06-09, 09-12,
    12-15, 15-18, 18-22, 22-06) and vehicle type. Used for the afternoon and night what-ifs and for travel-time
    uncertainty.
  - **Daytime stop dwell** percentiles (STOPPED 06:00-20:00, 3-360 min) and the share of dwells over 60 and 120
    min. Used for unloading uncertainty.
  - **Day shape**: first departure and last stop end per vehicle-day.
  - **Chain unloading** p25/p50/p75/p90 from "Claims check".
  - **Visit frequency** per customer segment (mean days between deliveries) from "Other delivery customers". Used
    for the future-delivery cost of a deferral.
  - **The "Fleet parameters" values**, as text.
- **Use.** `history.UncertaintyModel.from_aggregates()` and `whatif.Night/Afternoon` take their speeds and spreads
  from this file. An evidence-based unloading lever ("the best-quartile crews already unload at p25") is still
  `requires_evidence`. It is reported separately with the p25/p50 gap as its basis.

## 2. What-if and sensitivity (`whatif.py`)

Levers are small dataclasses with `apply(req, ctx) -> DispatchRequest` and the flags `requires_evidence` and
`hypothetical`.

| Lever | Change | Scope / guard |
|---|---|---|
| `Flex(m)` (m = 10/20/30) | `hard_end_min += m` (START rule: latest arrival) | only stops whose provenance is `SALES_PREFERENCE`; `UNKNOWN` only in the HYPOTHETICAL variant; `CUSTOMER_HARD` never |
| `WidenPreference()` | a preference window widened to the customer's genuine hours (`genuine_hours` when known, else +60 min both sides) | same as above |
| `PrefFlex(m)` | `pref_end_min += m` (soft, RECOMMENDED only) | any stop |
| `Afternoon(until)` / `Night(until)` | trucks' `available_to_min`, `latest_return_min`, depot close and stop windows extended | only for customers flagged `accepts_afternoon` / `accepts_night`; a night shift is a SECOND driver shift: extra `driver_day_cost` per truck used after the normal shift (a labelled assumption); breaks kept |
| `FasterUnloading(pct)` | `service_min` reduced by pct of the per-case part only | `requires_evidence` |
| `FasterReload(minutes)` | `reload_min` reduced | `requires_evidence` |

`run_whatif(req, levers, budget, ctx, combos=True) -> WhatIfReport`:
- runs the baseline;
- runs each lever alone;
- runs pairwise combinations and the "all non-evidence levers" combination;
- runs "all including evidence levers" separately.

Every row reports: delta cash OMR (mean and range over seeds), delta stops/cases served, delta trucks, trips and
km, delta late stops, delta proven-impossible stops, and the flags. It never relaxes closing times, breaks, shift,
capacity or safety.

## 3. Delivery economics (`economics.py`)

For each **small stop**, meaning total cases <= 3 (the solver plans stops; the invoice-to-stop mapping is reported),
it evaluates four options:

1. **Serve now.** The baseline plan.
2. **Combine / move.**
   - The stop is already combined if its load serves another stop within `combine_km` (default 2 km).
   - Otherwise the cheapest exact-timed insertion into another existing load or vehicle, via load_repack's
     `time_plan` / insertion helpers, with exact timing.
3. **Defer.**
   - Re-optimize the day without the stop. That gives the avoidable cash, the knock-on effects (stops served or
     dropped elsewhere) and the time and capacity freed.
   - Plus the **future delivery cost**: the cheapest insertion cost into a next-day plan when one is given.
   - Otherwise, a proxy: the marginal cost of the same stop on a day where its area is not otherwise visited. This
     is labelled as a proxy.
4. **Drop** (shown for comparison only; never recommended silently).

Marginal cost = cash(with) - cash(without), measured over the same seeds and budget, plus a deterministic
fixed-plan removal estimate (remove the stop from the baseline plan and re-time it exactly) that has no search
noise.

Recommendation rules:
- P1/P2, promised/urgent, late orders and service commitments are always **serve**.
- Others: defer only if cash saving > future cost + margin lost (when margin is known). Otherwise the report gives
  the break-even margin, from the same figures the rule uses (the least saving over the seeds).
- The output is a recommendation list with reasons. It never deletes an order.

## 4. Dynamic multi-trip planning (`dynamic.py`)

The simulator works in discrete events over one day. Its state:
- per truck: current load (frozen once it has left: onboard stock = its stops), completed stops, position (the
  depot, or the last completed stop), next free time, trips used, shift start;
- pending orders; the clock.

Events: `LOAD_DEPARTED`, `STOP_COMPLETED` (actual times), `DELAY` (an observed overrun beyond a threshold),
`NEW_ORDER` (revealed at its arrival time), `DEPOT_RETURN`.

Re-plan:
- Build a `DispatchRequest` for the still-unloaded orders. Each truck's departed or completed loads become
  `FrozenTrip`s with their actual or forecast return, so the engine's `ready_s` logic places loads 2/3 after the
  actual return plus reload.
- Set `previous_truck_id` and `change_penalty_per_stop` for route stability.
- Set `shift_start_min = now`.
- A load that has left is never re-routed. The engine cannot re-route mid-route, and the stock is on the truck.

Policies compared over the same sampled worlds (seeds):
- **A. Static:** the morning plan, executed as is. It never serves an order revealed later and never retries a
  stop the morning plan left out.
- **B. Re-plan at each depot return.**
- **C. Event-triggered:** a depot return, a delay above 20 minutes, or a new order.

Metrics: stops served, late stops and minutes (actual vs genuine windows: a SALES_PREFERENCE window is measured
against the customer's genuine hours, and a missed preference is counted apart), cash cost (actual), number of re-plans,
**stops moved** between trucks or loads versus the previous plan (stability), and solver seconds.

The report also lists the required data, events and integrations, separating existing from missing: live driver
events exist (StopVisit taps); GPS feeds (Ayun / IVMS) and stock availability are missing.

## 5. Feasibility and trade-off explanations (`explain.py`, `exact.py`)

- `verdict(req, response)` gives one of:
  - `PLANNED`.
  - `PROVEN_INFEASIBLE` for a stop: the prefilter, window-prefilter, no-room or fleet-shortage proofs.
  - `SEARCH_FAILURE`: NO_SOLUTION with `ROUTING_FAIL_TIMEOUT`, or stops dropped without proof.
  - `MODEL_ERROR_SUSPECTED`: NO_SOLUTION in < 1 s while every stop is individually servable. This is the
    signature of the 14 Oct bug, fixed in PR #71.

  Each unproven drop is labelled "not proven impossible: a longer search, a relaxation or a change could serve it".
- `conflicts(req, response)`: per unserved stop, the binding constraint candidates. These are its earliest
  possible arrival from the depot versus its window, its pallets versus the largest room, its round trip versus
  the shift, its allowed trucks, and the time or capacity left on the trucks that pass nearby.
- `rank_relaxations(req, candidates, budget)`: re-solves each candidate relaxation with equal budget and seeds,
  then ranks them by stops or cases gained (desc), then delta cash (asc). The candidates are:
  - a stop's window +10/+20/+30 (preference-labelled stops only, or a HYPOTHETICAL label);
  - +1 trip on a truck;
  - one hired truck (an existing `hire_candidate` truck);
  - shift +30 min (HYPOTHETICAL, needs driver agreement);
  - faster unloading (requires evidence).

  It produces sentences such as: *"Extending stop-017's window by 10 minutes changes cash cost by +0.84 OMR (range
  +0.61..+1.02 over 3 seeds) and allows 2 more deliveries (stop-031, stop-044)."*
- `frontier(req, configs, budget)`: (cash OMR, stops served, late minutes) for a set of configurations: scenarios,
  relaxations and priority-weight variants. It returns the non-dominated (Pareto) set with labels, not one score.
  A point flagged HYPOTHETICAL or REQUIRES_EVIDENCE is shown apart and never dominates an option usable today.
- `exact.solve_small(req, max_stops=8)`: exact enumeration and dynamic programming over subsets, orders and truck
  assignment for small instances (<= 8 stops, <= 2 trucks, 1 trip each). It uses the same timing rules (haversine
  matrix of the engine, START/FINISH window rule, service, capacity, shift) and finds the cash-optimal plan that
  serves the maximum number of stops. Tests compare it with the engine:
  - the engine's plan is feasible for the oracle;
  - the engine serves as many stops as the oracle;
  - the gap in cash is reported;
  - when the oracle proves a stop can never be served, the engine never serves it.

## 6. Evidence (`experiments.py`, run on the codespace, never on the laptop)

| Id | Days | What | Budget |
|---|---|---|---|
| E1 what-if | real 15 Oct (86 stops) and 15 Oct pre-fix request (94 stops); synthetic S320 (seed 1), S400 (seed 2) | levers alone + combinations | 30 s per run for real days, 60 s for synthetic; 3 seeds |
| E2 economics | real 15 Oct; S320 | every small stop: fixed-plan removal estimate; full re-optimization for up to 12 of them | 30 / 60 s; 3 seeds |
| E3 dynamic | S320 (with new orders) and real 15 Oct (no new orders) under the uncertainty model | policies A/B/C | 10-20 s per re-plan; 5 worlds |
| E4 explain | real 15 Oct pre-fix request; S320 "tight" (morning windows tightened) | verdicts, ranked relaxations, frontier | 30 / 60 s; 3 seeds |
| E5 exact | 60 random small instances | oracle vs engine | 3 s per engine run |
| E6 production settings (added 15 Oct) | real 15 Oct and pre-fix request; synthetic S320 (seeds 1, 2), S400 (seed 3) | the engine as production runs it: all three plan options, worker processes, the second search; spread over seeds, cheapest option at equal service, convergence, PROD vs QUICKP; perturbations P0-P5 on the real days | PROD = THOROUGH, cap 1,200 s, the engine's stall rule; QUICKP = QUICK, automatic time; 5 seeds (3 for PROD on a real day) |

The results go to `docs/decision-support/results/*.json` and `docs/decision-support/REPORT.md`: tables in OMR, the
compute budget, seeds, machine and commit hash.

## 7. Implemented vs proposed (filled in by the report)

Proposed, not built in this prototype:
- a `Customer.windowSource` field (CUSTOMER_HARD / SALES_PREFERENCE) captured from sales messages;
- product margins or invoice values in the upload;
- live GPS ingestion (Ayun / IVMS);
- stock availability per product;
- per-stop locks;
- an event bus from the driver page to automatic re-plans;
- UI screens;
- seeding inside OR-Tools (needs a fork or other first-solution diversification);
- the fix for "P2 left out while P3/P4 ride" (found in the 14 Oct review; `_repair_lost` only runs for hires).
