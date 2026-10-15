# RouteIQ decision support: implementation report (15 Oct 2026)

For the NMWC operations owner. Branch `feat/decision-support`. All the evidence (E1-E5, on SYNTHETIC days and on the
REAL 15 Oct 2026 requests) measures the code recorded as `6b6de09d576c` in the result files: this branch's code with
all 19 review fixes, before the privacy rule on the IVMS aggregates (section 7.4). That rule changed no figure the
experiments use, so the results stand.

This is a **prototype**. It is not deployed, and the live planner does not use it. The design is in
[DESIGN.md](DESIGN.md); the raw evidence is in [results/](results/INDEX.md).

---

## 1. Summary

**What was built.** A set of analysis tools that sit on top of RouteIQ's existing route optimizer (the "engine").
They do not replace it and never change a plan in use. They answer five questions:

1. **What if** we relax a rule: 10/20/30 minutes of window flexibility, afternoon or night deliveries, faster unloading?
2. **Small orders:** what does a 1-3 case order really cost, and should it be served, combined, moved or deferred?
3. **Re-planning during the day:** how much does it help, and how often should it happen?
4. **Explanations:** was a stop left out because it is impossible, or because the search did not find a place for it?
   Which small change would serve it?
5. **How good are the engine's plans?** Checked against proven-best plans on small days.

There are 120 automatic tests (5 of them added on 15 Oct for experiment E6, the engine at production settings, section 7.1). The evidence suite (experiments E1-E5) ran in full: on invented, NMWC-like days
(SYNTHETIC) on GitHub's servers, and on two real RouteIQ requests of 15 Oct 2026 (REAL, anonymised when read) on the
project's codespace, where the private data stays (section 3.0). One real day is one sample: the REAL results show
what the tools say about that day, not a pattern across days.

**Most important findings**

1. **Search noise is larger than most effects we tried to measure, and largest on the real day.** At 20 seconds of
   search (what QUICK gives a day of this size), the same real 15 Oct request cost between 540.15 and 734.12 OMR
   over three seeds in one run (a 193.97 OMR spread, E1) and between 500.48 and 585.64 OMR in a second run with the
   same seeds and budget (85.16 OMR, E2). Seed 2 alone ended at 734.12 OMR with 12 trucks in one run and 516.93 OMR
   with 9 trucks in the other, so the spread comes from the seed and from the run (the timing of the codespace runs
   varied) (REAL). Half or more of the spread is truck fixed cost: the search put 9 to 12 trucks on the road. At
   40 seconds the SYNTHETIC day's spread was 43.68 OMR. On SYNTH-320 (all 12 what-if variants) and on the real day
   (all 5), every variant's mean cash change (cold runs) was smaller than the day's spread. Small differences between
   two plans are often search luck (section 3.1).
2. **On the real request that failed on 15 Oct, today's engine produces a plan, and none of the stops it leaves out
   is proven impossible.** Every stop left out (10, 10 and 16 of 94 over the three seeds) can be served on its own: a
   search failure, not a proven impossibility. But no run served all 94 stops (at most 91, and that only with the
   unproven faster unloading), so whether they all fit together on the 9 own trucks is not known. Two changes usable
   today served more stops in every seed, each with a mean gain within the request's own 6-stop seed spread (78 to 84
   stops): one more load on truck-03, +2, +1 and +9 stops (mean +4) at about the same cash (+0.29 OMR, range
   -11.26..+8.28), but -4 cases on average, and in at least one seed it left out the P2 stop of 1000 cases that the
   base plan served; and hiring one truck, +4, +4 and +9 stops (mean +5.667) and more cases in every seed (mean +782),
   for +70.63 OMR. Neither gain is established. On this request, with each plan option searched alone for 20 s, the plan RouteIQ
   applies by default (RECOMMENDED) was beaten by the MIN_TRUCKS option in every seed (5.27-34.01 OMR cheaper and 1, 2
   and 8 more stops; but the mean gaps of 17.75 OMR and 3.7 stops are within this request's seed spread of 21.25 OMR
   and 6 stops, and seed 3's 78-stop RECOMMENDED run gives 8 of the 11 extra stops: suggestive, not established).
   Production settings may differ (E4, REAL).
3. **On small days the engine serves as many stops as the proven best plan.** On 100 small SYNTHETIC days with a
   proven best plan, each run with and without the preferred-window prices (200 engine runs), the engine served as
   many stops as the proven best, with the same priority value, every time, and never broke one of the oracle's
   rules. With the preferred-window prices on, the cash gap to the proven minimum is larger (mean 0.469 vs 0.049 OMR;
   70 vs 98 days with no gap). Most of the difference is likely the cash RECOMMENDED spends on preferred windows and
   early arrivals, but these results do not separate it from search misses: with the prices off, 2 of the same 100
   days still had a gap (up to 2.428 OMR) (E5, SYNTHETIC).
4. **Window flexibility of 10-30 minutes is not established either way; afternoon delivery did help on the busier
   synthetic day.** On both synthetic days no flex of 10, 20 or 30 minutes changed cash or stops by more than the
   search noise, except a loss of stops on SYNTH-400 at +10 minutes (-3.7 [-6.0..-1.0], every seed), a search effect.
   On the real day no window carries a source label, so every window change there is HYPOTHETICAL; none changed cash
   by more than the noise, and in the cold runs the one stop change beyond it was a loss (+20 minutes: -5.0
   [-14.0..+1.0], one seed lost 14 stops); warm, +20 and +30 minutes also lost stops beyond the warm spread. Again
   search effects (E1, REAL). Delivering until 18:00 to customers who accept it served +10.0
   stops [+7.0..+12.0] on the busier synthetic day (238 stops), for +54.97 OMR cash [+41.58..+72.88] (E1, SYNTHETIC;
   not run on the real day, where acceptance is not recorded).
5. **Faster unloading is the most consistent lever on the synthetic days, and it also lowered cash in every seed on
   the real day (where, as for every lever, seed 2's 12-truck base makes the mean large), but it needs evidence
   first.** At 20% it lowered cash in every cold seed on both synthetic days and on the real day (-25.32, -28.18 and
   -116.94 OMR on average, all within the search noise; on the real day the HYPOTHETICAL Flex +30 also lowered cash in
   every cold seed), and on the real day it freed 489-954 paid driver minutes in every seed. Unloading 39% faster
   (within a chain, the 25th-percentile time on site is 39% shorter than the median in the 13 Oct GPS evidence, 422
   visits, 8 chains; a spread across visits that mixes drop sizes and sites, not a measured crew effect) served more
   stops in every seed: +3.667 on the tight synthetic day and +7.667 on the real pre-fix request (E1, E4, SYNTHETIC
   and REAL, REQUIRES EVIDENCE).
6. **Small orders are cheap when they ride with neighbours.** On the real day, each of the 4 small stops (all late
   orders, so all served) cost 0.63-0.91 OMR of cash where it was (E2, REAL). On the synthetic day, taking one 1-3
   case stop out of a finished plan saved 0.46-2.57 OMR; one remote small stop saved 14.96 OMR (E2, SYNTHETIC). No
   deferral could be recommended: that needs tomorrow's plan and margins, which RouteIQ does not have.
7. **Re-planning helps when there is something new to place, and it can leave stops out.** On the synthetic day with
   15 late orders, re-planning at each depot return (B) served +11.6 stops (mostly the late orders) and 4.4 fewer late
   stops than the morning plan alone, for +27.39 OMR on average (range -11.56..+95.98); re-planning on every event (C)
   served as many (144.6 each) with 37.0 searches instead of 8.4 (E3, SYNTHETIC). On the real day, with no order
   arriving during the day, both re-planning policies served 1-3 fewer stops than the morning plan in every world and
   had 5.3 fewer late stops; B left a P1 stop out in 1 of 3 worlds (REAL request, SIMULATED day: E3, 3 worlds). In
   some synthetic worlds too, B and C left out a P1 or P2 stop the morning plan delivered (possibly late).

**What to do next**

- Measure the search noise with THOROUGH searches and the second route search (production settings) on 2-3 real days;
  this run used 20 s and 40 s QUICK without the second search.
- Check, at production settings, whether RECOMMENDED leaves out stops that MIN_TRUCKS or MIN_DISTANCE serve (E4, REAL).
- Start recording, per customer: whether a window is a genuine receiving time or a salesman's preference, and whether
  afternoon delivery is accepted. Record margins per case if available.
- Plan a measured unloading trial before counting on faster unloading.

### Words used in this report

| Word | Meaning |
|---|---|
| Engine | RouteIQ's existing route optimizer (`dispatch_solver.py`, Google OR-Tools search). |
| Search, seed | The engine searches for a good plan for a fixed time. A seed is a different starting order of the stops; different seeds make the search end at different plans for the same day. |
| Search noise | How much the result changes between seeds, or between runs, of the same day with the same search time. |
| QUICK, THOROUGH | The engine's two search modes. QUICK: a fixed time by day size (5 s up to 25 stops, 20 s up to 120 stops, more for larger days). THOROUGH: up to 20 minutes, stopping once it stops improving; the default for tomorrow's plan. |
| Cash (OMR) | What a plan costs in money: truck fixed cost, trip cost, distance, fuel, driver pay and overtime (the engine's own cost model). |
| ARTIFICIAL penalty | A price the engine uses only to steer its search (for leaving a stop out, missing a preferred window, arriving early). Written in OMR-equivalent but **not money**; never added to cash. |
| Time and capacity | Minutes, trips, trucks and pallets: a third kind of number, kept apart from cash and from penalties. |
| Estimated km | Straight-line distance x 1.3 (the HAVERSINE method), not road km. |
| SYNTHETIC | An invented day built to look like an NMWC day. No real customer, location or order. Its truck costs are invented too. |
| REAL | A real RouteIQ request of 15 Oct 2026, anonymised when read: stops and trucks become `stop-NNN` and `truck-NN` labels, and no id, name or location leaves the codespace. Its cash uses the truck costs in the request. |
| CUSTOMER_HARD, SALES_PREFERENCE, UNKNOWN | Where a delivery window comes from: the customer's real receiving hours; a salesman's or merchandiser's request; not known. Only SALES_PREFERENCE may be flexed. |
| HYPOTHETICAL | Needs a confirmation or an agreement first (a longer driver shift, or flexing an UNKNOWN window). |
| REQUIRES EVIDENCE | A gain that is real only once measured (faster unloading or reloading). Always shown apart. |
| VERIFIED | The plan passed RouteIQ's independent timetable check (`feasibility.check_scenario`). |
| Cold, warm | Cold: the search starts from scratch. Warm: it starts from the baseline plan. |
| Fixed-plan estimate | One stop taken out of a finished plan, which is then re-timed exactly. No search, so no noise, but no knock-on effects either. |
| Re-optimized | The whole day solved again without the stop. Includes knock-on effects, but has search noise. |
| PROXY future cost | Without tomorrow's plan, delivering a deferred stop later is assumed to cost what it costs today. A placeholder, not a measurement. |
| RECOMMENDED, MIN_TRUCKS, MIN_DISTANCE | The engine's three plan options for a day. RouteIQ applies RECOMMENDED; a planner can choose MIN_TRUCKS (fewer trucks) or MIN_DISTANCE (less distance) instead. |
| Frontier | The plans that no other plan beats on cash, stops served and lateness at the same time. A choice to make, not one score. |
| Oracle | A program that tries every possible plan of a small day, so its best plan is proven best. |
| P1-P5 | Order priority, P1 the highest. |
| Δ, [a..b] | Δ is the change (variant minus baseline). [a..b] is the lowest and highest value over the seeds or worlds. |

---

## 2. What was built

All code is in `apps/solver/decision_support/` (Python), with tests in `apps/solver/tests/test_ds_*.py`. It only calls
the engine; no engine file was changed.

**Where to run it.** Owner's rule: run every test and every solve on the project's codespace, never on the laptop.
Commands below start in `apps/solver`, with the solver's Python environment active. Real days are read from
`~/ds-data/` on the codespace and never copied into the repository. Write outputs of real days outside the
repository (for example `~/ds-out/`).

For a fair comparison, the module commands below should run with `SOLVER_PARALLEL=0 SOLVER_PYVRP=off` in front (one
search at a time, no second route search); the evidence suite sets this itself.

### 2.1 What-if and sensitivity (`whatif.py`)

**What it does.** Takes a day, changes one rule (a "lever"), solves the day again with the same search time and seeds,
and reports the change in cash, stops, cases, trucks, trips, estimated km and late stops. It also runs pairs of levers
and "all levers together". The levers:

| Lever | Change |
|---|---|
| Flex +10 / +20 / +30 min | The latest arrival of a window moves later. SALES_PREFERENCE windows only. |
| WidenPreference | A preference window widened to the customer's genuine hours. |
| PrefFlex +30 min | The soft "preferred" end moves later (only changes the ARTIFICIAL price). |
| Afternoon (until 18:00) | Customers who accept afternoon deliveries can be served until 18:00. |
| Night (until 22:00) | The same until 22:00. A truck back after the normal day needs a second driver, priced as an assumption, and depot staff after the normal day; RouteIQ cannot confirm either. The second driver's own break is not modelled. |
| FasterUnloading (-20% per case) | Unloading minutes per case cut. REQUIRES EVIDENCE. |
| FasterReload (-15 min) | Depot turnaround between loads cut. REQUIRES EVIDENCE. On the synthetic days -15 min (30 to 15 min) goes below the measured best quarter of reloads (19 min): an upper bound. On the real day it goes from 35 to 20 min. |

**How it respects the rules.**
- A check (`whatif.guard`) runs before any solve. It refuses a variant that changes a customer's genuine closing
  time, a break, capacity, pallet fill, allowed trucks, trips, order sizes or costs. The shift maximum, the latest
  return and the depot's closing time may only grow, and only with Afternoon or Night past the normal day, which adds
  a second driver priced as an assumption (E1: shift maximum 690 -> 870 min, latest return 19:00 -> 22:00).
- UNKNOWN windows move only in rows marked HYPOTHETICAL. A real day has only UNKNOWN windows today.
- Customers who do not accept night delivery are kept inside the normal day.
- Driving after the normal day is re-checked at the slower evening and night truck speeds measured in the IVMS report.
- Faster unloading or reloading is reported in a separate section ("operational improvement potential"), never as a
  baseline.
- Cash, ARTIFICIAL penalties and time are in separate columns.

**How to run.** There is no separate command; the what-if runs through the evidence suite:
`python -m decision_support.experiments e1 --only 'SYNTH-320/'` (or `'SYNTH-400/'`, `'REAL-15OCT/'`), then
`python -m decision_support.experiments e1 --report --out-dir ~/ds-out/results` (see section 2.5 on where results
go).

**Tests.** `test_ds_whatif.py`: 13 tests (one needs the real 15 Oct day and is skipped on CI).

### 2.2 Delivery economics of 1-3 case orders (`economics.py`)

**What it does.** For every stop of 3 cases or fewer:
- **Fixed-plan estimate:** the stop taken out of the plan, the load re-timed exactly. Gives the cash saved, the paid
  driver minutes and estimated km freed. This is also the "drop" figure: shown for comparison, never recommended.
- **Combine:** is the stop already on a load with another stop within 2 km?
- **Move:** the cheapest exactly timed place for it on another existing load or truck.
- **Defer:** the whole day re-optimized without it, with the same search time and seeds (knock-on effects included),
  plus the cost of delivering it later.
- **Recommendation:** SERVE, COMBINE, MOVE, DEFER or REVIEW, with the reason in words. It also lists which small
  invoices are in a stop of their own and which ride inside a larger stop of the same customer.

**How it respects the rules.**
- It never deletes or changes an order. P1 and P2 stops, late orders and service commitments are always SERVE.
- DEFER only when the saving beats the future cost (and the lost margin, when known) in every seed, by more than
  0.10 OMR.
- Margins are used only if the request carries them or the user passes a labelled assumption. Nothing is invented.
  Without tomorrow's plan, the future cost is a labelled PROXY and no break-even margin is given.
- The re-optimized figures are used only when they beat the search noise; otherwise the fixed-plan figure stands.
- Truck evidence (13 Oct analysis: how often customers get a delivery, how long small drops really take on site) is
  shown as context only.

**How to run.**
- Synthetic: `python -m decision_support.economics --synthetic 320 --time 40 --seeds 1,2,3 --reopt 8 --json ~/ds-out/e2.json`
- Real day (anonymised on reading):
  `python -m decision_support.economics --request ~/ds-data/day-2026-10-15-v1-request.json --time 20 --seeds 1,2,3 --reopt 4 --json ~/ds-out/e2-real.json`
- Add `--margin-per-case 0.5` (for example) only as an explicit, labelled assumption.

**Tests.** `test_ds_economics.py`: 15 tests.

### 2.3 Dynamic multi-trip re-planning (`dynamic.py`)

**What it does.** Simulates one delivery day minute by minute. Each simulated "world" draws actual travel and
unloading times (travel spread from the IVMS report, unloading spread from the 13 Oct truck evidence; medians a
labelled default) and reveals late orders during the day. Trucks run
loads 1, 2 and 3 with a reload at the depot in between. The dispatcher (the planner) sees only what has happened:
a load leaving, a stop completed with its actual times, a delay of more than 20 minutes, a new order, a truck back at
the depot. Three policies are compared on the same worlds:

- **A. Static:** the morning plan, executed as is. It never serves an order revealed later and never retries a stop
  the morning plan left out. (This is not today's practice: today a dispatcher can add a late order by hand.)
- **B. Re-plan at each depot return.**
- **C. Event-triggered:** re-plan at a depot return, a delay over 20 minutes, or a new order.

**How it respects the rules.**
- No future information: the planner gets a view built from past events only.
- A load that has left is never changed (the engine cannot re-route a truck on the road; the stock is on board).
  A load whose loading has started is committed. Every truck's first load is committed from the start (loaded the
  night before).
- Re-plans keep stops on their previous truck where possible (the engine's change price, ARTIFICIAL, default 3).
- Every re-plan is checked by the independent timetable check. "Late" means after the genuine closing time; a missed
  sales preference is counted apart. Late stops are still delivered and counted; nothing is relaxed. Returns after
  the limit, late driver breaks and missing driver breaks on the executed day are counted too (section 3.4).
- Cash is the executed day's cash, on the actual times and estimated km.

**How to run.**
`python -m decision_support.dynamic --invoices 280 --new-orders 15 --worlds 1 2 3 4 5 --budget 10 --morning-budget 40 --json ~/ds-out/e3.json`

**Tests.** `test_ds_dynamic.py`: 17 tests.

### 2.4 Feasibility and trade-off explanations (`explain.py`, `exact.py`)

**What it does.**
- **Verdict** for a run:
  - PLANNED: every stop served.
  - PROVEN_INFEASIBLE: a stop is impossible, with the proof (too big for any truck, cannot reach its window, and so on).
  - SEARCH_FAILURE: stops left out without proof: "not proven impossible: a longer search, a relaxation or a change
    could serve it".
  - MODEL_ERROR_SUSPECTED: no plan at all, found well before the time limit, while every stop can be served on its
    own. This is the signature of the bug fixed in PR #71.
- **Conflicts** per stop left out: its earliest arrival against its window, its size against the largest room, its
  round trip against the shift, its allowed trucks, and the room and time left on loads passing nearby.
- **Ranked relaxations:** each small change is solved with the same search time and seeds, then ranked: changes usable
  today first, then by stops and cases gained, then by cash. Each comes with a sentence in OMR, for example: *"Extending
  stop-180's window by 30 minutes changes cash cost by -17.50 OMR (range -25.10..-9.83 over 3 seeds) and changes
  deliveries by -2 on average"* (E4). Changes tried: a stop's window +10/+30 minutes, one more load on a truck, one
  hired truck, the shift +30 minutes (HYPOTHETICAL), faster unloading (REQUIRES EVIDENCE).
- **Frontier:** the plans not beaten on cash, stops served and lateness, side by side.
- **Exact oracle** (`exact.py`): for days of at most 8 stops and 2 trucks with one load each, it tries every plan,
  timed and priced with the engine's own rules. When it finishes, its plan is proven best. This is the **only** place
  where this prototype claims a plan is optimal.

**How it respects the rules.**
- Genuine closing times, breaks, capacity, small-truck-only customers and the one-customer rule are never relaxed.
- A window flexes only when labelled SALES_PREFERENCE (or UNKNOWN in a HYPOTHETICAL run). Any other label counts as
  UNKNOWN.
- A HYPOTHETICAL or REQUIRES EVIDENCE change is ranked apart and can never push an option usable today off the
  frontier.

**How to run.**
- A real day:
  `python -m decision_support.explain --request ~/ds-data/day-2026-10-15-failed-request.json --time-limit 20 --seeds 1 2 3 --hypothetical --hire-from ~/ds-data/day-2026-10-15-v1-request.json --out ~/ds-out/explain.md --json ~/ds-out/explain.json`
- The exact check:
  `python -m decision_support.exact --n 100 --max-stops 7 --time-limit 3 --out ~/ds-out/e5.json`
  (add `--no-preferences` for the second variant).

**Tests.** `test_ds_explain.py`: 10 tests. `test_ds_exact.py`: 32 tests.

### 2.5 Shared parts and the evidence suite

| File | What it does |
|---|---|
| `core.py` | Runs the engine with an equal search time and seeds; measures cash, ARTIFICIAL penalties and time apart; anonymous stop labels (`stop-017`). |
| `synth.py` | Builds SYNTHETIC NMWC-like days of 280-400 invoices: customers around public Muscat district centres, remote small orders in Quriyat, Samail and Bidbid, a mixed fleet of 4-14 bay trucks, tight morning windows for hypermarkets, about 25% of invoices of 1-3 cases. Every invented number is listed. |
| `history.py` | Reads a real day from outside the repository, replaces every id with a label, and models uncertain travel and unloading times. |
| `ivms.py` | Turns the owner's IVMS truck GPS report and the 13 Oct truck evidence into aggregates only (`data/ivms_aggregates.json`): speeds by hour, stop times, unloading per chain, visit frequency. It refuses to write a file that contains a name, plate, address or customer id it read, and it publishes figures for a region only when at least 3 vehicles drive there (section 7.4). |
| `experiments.py` | The evidence suite E1-E5. Caches every solve, splits the work into lanes, and writes the result files. Checks every output against the real days' ids and coordinates before writing it. |

**How to run the whole evidence suite** (on the codespace, 4 lanes, then the report):

```
cd apps/solver
for i in 0 1 2 3; do python -m decision_support.experiments all --lane $i/4 & done; wait
python -m decision_support.experiments all --report --out-dir ~/ds-out/results
```

The real days must be in `~/ds-data/` (`day-2026-10-15-v1-request.json`, `day-2026-10-15-failed-request.json`).
The lanes write only to the run cache (`~/ds-runs`, outside the repository); only `--report` writes result files.
Without `--out-dir` the results go to `docs/decision-support/results/` in the checkout. With the real days present,
always pass `--out-dir` outside the repository, and copy files into `results/` only after the leak check and the
owner's OK, because the repository is public.

**How to run the tests** (on the codespace):

```
cd apps/solver
python -m pytest tests/test_ds_*.py tests/test_api_process_no_pyvrp.py -q
```

| Test file | Tests | What they check |
|---|---|---|
| `test_ds_core.py` | 10 | Equal budgets, seeds, offline distances, anonymous labels, cash kept apart from penalties |
| `test_ds_synth.py` | 5 | The synthetic day's shape and labels; a small day planned and VERIFIED |
| `test_ds_history.py` | 10 | Anonymising, UNKNOWN windows on real days, the uncertainty model, no names or plates in the IVMS aggregates, no region figures for fewer than 3 vehicles (1 test needs the real day) |
| `test_ds_whatif.py` | 13 | Only the right windows flex, genuine limits never move, evidence levers apart, second driver and IVMS speed check (1 test needs the real day) |
| `test_ds_economics.py` | 15 | Exact fixed-plan figures, combine and move checks, P1/P2 and late orders always served, no invented margins, never deletes |
| `test_ds_dynamic.py` | 17 | No future information, departed loads never changed, delays push later loads, lateness against genuine closing times |
| `test_ds_explain.py` | 10 | Proofs vs search failure vs model error, relaxation sentences, ranking, the frontier |
| `test_ds_exact.py` | 32 | The oracle matches a brute force; never-servable stops proven; the engine never beats the oracle |
| `test_ds_experiments.py` | 8 | Run lists and lanes, the cache and leak check, the report rebuilt from the cache alone; E6: its run list, the production engine call, the perturbations, the analysis and its report from a fake cache |
| **Total** | **120** | |

---

## 3. Evidence and results

### 3.0 How the evidence was run

- **Where, synthetic days:** GitHub Actions run 38674195128, 15 Oct 2026, because the codespace had used up its free
  quota at the time. Each experiment ran on its own GitHub-hosted machine (E1 on two, one per synthetic day; 6
  machines in all): 4 CPUs (AMD EPYC 7763), Python 3.11.17, OR-Tools 9.15 (PyPI build 6755; the result files print
  9.15.675 because the leak check rounds long decimals). Each machine ran 4 lanes, one solve at a time per lane.
- **Where, real days:** the project's codespace (4 CPU cores), after the owner restored the Codespaces billing; the
  private requests never left it. Codespace time past the free quota is billed to the owner's GitHub account; see the
  billing page for the hours used. 4 lanes, one solve at a time per lane; 115 real-day items, all complete. Some
  items ran during a first overnight attempt, while the codespace's CPU was shared with other work, and the rest
  after a restart, so the timing of the runs varied. A timed search can end at another plan when the machine gets
  more or less far in its seconds (section 3.1).
- **Result files:** written on the codespace by the suite's `--report` step from the combined run cache (the Actions
  runs and the codespace runs). The synthetic results are the same as in the first version of this report; only
  E5's oracle, recomputed on the codespace when the report was written, differs: its time per day (by up to 33 ms)
  and the machine its result file names. The engine runs are the cached Actions runs.
- **Code:** the code recorded as `6b6de09d576c` for every run. The Actions run used a temporary branch with one extra
  workflow file; that branch has been deleted (section 7.4).
- **Equal compute:** every compared run had the same search time, QUICK mode, the RECOMMENDED plan only (E4's
  frontier: each plan option alone, with the same time), one search at a time (`SOLVER_PARALLEL=0`) and no second
  route search (`SOLVER_PYVRP=off`). Production runs the second search; it was off here so every run got the same
  single-core search.
- **Budgets:** 40 s of search per run on synthetic days, seeds 1, 2 and 3 (E1, E2, E4). E3: 40 s for the morning
  plan, 10 s per re-plan, 5 worlds. E5: 3 s per engine run. Real days: 20 s per run, seeds 1, 2 and 3 (E1, E2, E4);
  E3: 20 s for the morning plan, 10 s per re-plan, 3 worlds. 20 s is what QUICK gives a day of 86-94 stops. The
  engine's load re-check comes on top of the search time: on the real days a 20 s run took about 65-97 s in all (a
  hire variant about 240 s, because it also runs the engine's hire check).
  DESIGN.md had proposed 60 s for synthetic days and 30 s for real days, E1 on the pre-fix request as well, E2
  re-optimization for up to 12 stops, E3 on S320 and E5 on 60 instances; the suite used 40 s and 20 s, E1 on the
  15 Oct day only, E2 re-optimization of 8 stops (all 4 small stops on the real day), E3 on SYNTH-280, E3 on the real
  day with 3 worlds instead of 5, and E5 on 100 instances per variant.
- Distances are estimated km. Plans are the best found in the time given, not proven best (except E5's oracle).
- **Sections 3.1-3.6 are SYNTHETIC unless a number is marked REAL; section 3.7 is REAL (section 3.7.3 simulates the
  real request's execution).** Synthetic days use invented
  truck costs, so their OMR figures show direction and size, not NMWC's actual money. The real days use the truck
  costs in the requests.

| Experiment | Day | Where | Status | Compute (min) |
|---|---|---|---|---|
| E1 What-if levers | SYNTH-320, SYNTH-400 | GitHub Actions | COMPLETE (156 runs) | 133.4 |
| E1 What-if levers | REAL-15OCT: the 15 Oct request, 86 stops, 12 trucks (3 of them hired) | codespace | COMPLETE (36 runs) | 53.7 |
| E2 Small-stop economics | SYNTH-320 | GitHub Actions | COMPLETE (27 runs) | 21.0 |
| E2 Small-stop economics | REAL-15OCT | codespace | COMPLETE (27 items) | 20.9 |
| E3 Dynamic re-planning | SYNTH-280 | GitHub Actions | COMPLETE (16 items) | 41.0 |
| E3 Dynamic re-planning | REAL-15OCT, no new orders | codespace | COMPLETE (10 items) | 16.0 |
| E4 Verdicts, relaxations, frontier | SYNTH-320-TIGHT | GitHub Actions | COMPLETE (42 runs) | 30.4 |
| E4 Verdicts, relaxations, frontier | REAL-15OCT-PREFIX: the pre-fix 15 Oct request, 94 stops, 9 own trucks | codespace | COMPLETE (42 runs) | 73.5 |
| E5 Exact oracle | 100 small days x 2 engine variants | GitHub Actions | COMPLETE (200 runs) | 9.7 |

### 3.1 Read this first: search noise

The engine does not prove that its plan is the best one. It searches for a fixed time and keeps the best plan it
found. Started from another seed, it ends at another plan of the same day.

| Day | Search time | Seeds | Cash, mean [lowest..highest] OMR | Spread | Stops served |
|---|---|---|---|---|---|
| SYNTH-320, 185 stops (E1) | 40 s | 1, 2, 3 | 664.97 [636.90..680.59] | 43.68 OMR | 181.3 [178.0..183.0] |
| SYNTH-400, 238 stops (E1) | 40 s | 1, 2, 3 | 794.79 [783.03..813.73] | 30.69 OMR | 226.3 [225.0..228.0] |
| SYNTH-320 (E2 baseline) | 40 s | 1, 2, 3 | 667.50 [636.90..685.01] | 48.10 OMR | 181.7 [178.0..184.0] |
| **REAL 15 Oct day, 86 stops (E1 baseline)** | 20 s | 1, 2, 3 | 619.97 [540.15..734.12] | **193.97 OMR** | 83.7 [82.0..85.0] |
| **REAL 15 Oct day, the same request (E2 baseline)** | 20 s | 1, 2, 3 | 534.35 [500.48..585.64] | **85.16 OMR** | 84.3 [84.0..85.0] |
| REAL pre-fix 15 Oct request, 94 stops (E4 base) | 20 s | 1, 2, 3 | 514.60 [504.02..525.27] | 21.25 OMR | 82.0 [78.0..84.0] |

**The real day at 20 s has the largest spread measured** (REAL): 193.97 OMR over the three seeds in E1 and 85.16 OMR
in E2, for the same request, seeds and budget; over the six runs the cash went from 500.48 to 734.12 OMR. Half or
more of it is how many trucks the search put on the road: 9 to 12, and each truck beyond nine added 50 OMR of fixed
cost (the most expensive run used all 12 trucks). The pre-fix request's cash spread was smaller (21.25 OMR), but its
stops served varied by 6 (78 to 84 of 94).

Even the same seed of the same request and budget can end at another plan in another run. On the real day, seed 2
cost 734.12 OMR with 12 trucks in E1 and 516.93 OMR with 9 trucks in E2, and seed 1 cost 540.15 and 500.48 OMR; only
seed 3 ended at the same cash in both (585.64 OMR). On the synthetic day, seed 1 of SYNTH-320 cost 677.42 OMR in E1 and
685.01 OMR in E2. A timed search can depend on how far the machine gets in that time, and the timing of the real-day
runs varied (section 3.0).

**What it means for reading the results.**
- A difference smaller than the day's own spread is not established. The result files mark such rows "within search
  noise". On SYNTH-320, every one of the 12 variants was within search noise for cash in the cold runs; on the real
  day, every one of the 5 variants was (REAL).
- One base run can move every comparison. On the real day, every lever's mean cash change was negative (-27.45 to
  -130.43 OMR), largely because seed 2's base run was the 12-truck plan: each lever's seed-2 run cost 102.17 to 243.23
  OMR less (REAL). The paired deltas share one base run per seed, so a lucky or unlucky base moves them all together.
- A rule change can make a timed search find a worse plan, even when the change cannot make the best plan worse. On
  SYNTH-400, Flex +10 min served 3.7 fewer stops [-6.0..-1.0]; on the tight day of E4, all 8 usable relaxations (and
  the HYPOTHETICAL shift) lowered the mean stops served (-0.667 to -3.667); on the real day, Flex +20 min served 14
  fewer stops in one seed (REAL). A relaxation cannot make the best plan worse, so these are search effects.
- Read cash with stops served: of the six baseline runs on the real day, the most expensive (734.12 OMR, 12 trucks)
  also served the fewest stops (82 of 86), and on the pre-fix request RECOMMENDED cost more and served fewer stops
  than MIN_TRUCKS in every seed, though the mean gaps (17.75 OMR, 3.7 stops) are within that request's seed spread
  (section 3.7.4, REAL).
- This is why every comparison here is paired per seed, reports [lowest..highest], and is only called a finding when
  it is larger than the noise.

**What it means for daily planning.**
- Two QUICK searches of the same day can differ by tens of OMR on a synthetic day and by up to 234 OMR (9 against 12
  trucks) on the real 15 Oct day (REAL, 20 s, without the second route search). A re-plan that looks 20-40 OMR
  cheaper or dearer than the plan in use may be search luck, not a better or worse day; on a real day, so may a
  difference of a truck.
- Tomorrow's plan is made with THOROUGH by default (up to 20 minutes, stopping when it stops improving), with the
  second route search on. **This run did not measure THOROUGH or the second search**, so we do not yet know how much
  smaller the noise is in production. For scale only: an earlier benchmark in this repository
  ([OPTIMIZER_BENCHMARK.md](../OPTIMIZER_BENCHMARK.md) section 11.3, 29 Sep 2026) found THOROUGH about 41 OMR a day
  cheaper than QUICK on one real 83-stop day.
- Before acting on any rule change worth a few tens of OMR a day, measure it with several seeds, on real days, with
  THOROUGH searches.

### 3.2 E1: What-if levers

This section is SYNTHETIC; E1 on the real 15 Oct day is in section 3.7.1.

**Setup.** SYNTH-320 (320 invoices, 185 stops, 13 trucks) and SYNTH-400 (400 invoices, 238 stops, 16 trucks). 40 s per
run, seeds 1, 2, 3; every variant solved cold and warm. 156 runs, 133.4 compute minutes.
IVMS parameters used: evening and night drive speed 0.839 and 0.708 x the day speed (Muscat, IVMS MOVING segments).
From the 13 Oct GPS evidence: within a chain, the 25th-percentile time on site is 39% shorter than the median (422
visits, 8 chains; a spread across visits, not a measured crew effect), the basis of the faster-unloading lever, which
was run at 20%.

**Key results (cold runs; change against the baseline, mean [lowest..highest] over 3 seeds).** Figures in bold are
larger than the search noise.

| Lever | SYNTH-320: Δ cash OMR | SYNTH-320: Δ stops | SYNTH-400: Δ cash OMR | SYNTH-400: Δ stops |
|---|---|---|---|---|
| Flex +10 min | +12.63 [-4.92..+46.98] | +0.0 [-4.0..+6.0] | -0.21 [-21.72..+22.87] | **-3.7 [-6.0..-1.0]** (worse: a search effect) |
| Flex +20 min | -9.34 [-21.92..+12.41] | +1.3 [-1.0..+5.0] | +7.49 [-8.94..+19.56] | -1.0 [-2.0..+0.0] |
| Flex +30 min | +8.79 [-5.04..+22.44] | +3.0 [+1.0..+6.0] | -16.55 [-47.77..+3.26] | -2.3 [-4.0..+0.0] |
| PrefFlex +30 min | +1.10 [-24.89..+52.71] | +2.0 [-1.0..+5.0] | -1.59 [-9.80..+3.14] | -2.0 [-6.0..+1.0] |
| Afternoon until 18:00 | +23.22 [-8.65..+47.59] | +3.7 [+2.0..+7.0] | **+54.97 [+41.58..+72.88]** | **+10.0 [+7.0..+12.0]** |
| Night until 22:00 | +5.59 [+3.08..+9.91] | +3.0 [+2.0..+5.0] | **+61.61 [+9.66..+90.40]** | **+6.0 [+3.0..+9.0]** |
| Flex +20 and Afternoon | +5.62 [-14.15..+28.37] | +3.7 [+2.0..+7.0] | **+47.86 [+19.65..+67.77]** | **+10.7 [+9.0..+13.0]** |
| Flex +30 and Afternoon | +2.09 [-19.09..+29.39] | +3.3 [+2.0..+6.0] | **+55.40 [+38.71..+83.74]** | **+10.0 [+8.0..+12.0]** |
| All levers without evidence | +10.19 [-18.25..+46.57] | +3.7 [+2.0..+7.0] | **+45.62 [+41.11..+49.12]** | **+11.7 [+10.0..+13.0]** |
| *REQUIRES EVIDENCE:* faster unloading -20% per case | -25.32 [-36.22..-4.74] | +3.3 [+1.0..+7.0] | -28.18 [-40.00..-21.90] | +2.0 [-5.0..+6.0] |
| *REQUIRES EVIDENCE:* faster reload -15 min | -2.91 [-22.84..+25.89] | +2.0 [+1.0..+4.0] | +1.96 [-16.66..+33.58] | +1.0 [-2.0..+4.0] |
| *REQUIRES EVIDENCE:* all levers | -8.09 [-25.98..+17.70] | +3.7 [+2.0..+7.0] | +11.46 [-6.34..+22.75] | **+11.3 [+10.0..+12.0]** |

Search noise (the baseline's spread over seeds): SYNTH-320 43.68 OMR and 5 stops; SYNTH-400 30.69 OMR and 3 stops.
Serving more stops costs more cash: read Δ cash together with Δ stops.

**What it means.**
- **Window flexibility of 10, 20 or 30 minutes** (38 sales-preference windows on SYNTH-320, 51 on SYNTH-400) showed
  no effect larger than the search noise on either day (not established either way), except a loss of stops on
  SYNTH-400 at +10 minutes (-3.7 [-6.0..-1.0], every seed), a search effect rather than a property of the best plan.
  On SYNTH-320, Flex +30 served +3.0 stops [+1.0..+6.0] in every seed, within the 5-stop noise. Moving the soft
  preferred end (PrefFlex) only lowered the ARTIFICIAL window penalty (-59.89 and -135.57 OMR-equivalent: not money).
- **Afternoon delivery served more stops on the busier day.** On the busier SYNTH-400 it served +10.0 stops and
  +237 cases [+90..+422] for +54.97 OMR cash and +153.9 estimated km. On SYNTH-320 it served +3.7 stops [+2..+7]
  (every seed, but within the 5-stop noise) and its cash effect stayed within noise. Its "late stops" (+23.0 and
  +30.3) are the afternoon deliveries themselves, counted against the customers' original morning windows.
- **Night delivery** on SYNTH-400: +6.0 stops for +61.61 OMR, which includes 10.00 OMR for the second-driver
  assumption (1.0 extra driver shift on average). Re-timed at the IVMS evening and night speeds, no stop would arrive
  late (0.0).
- **Faster unloading** (REQUIRES EVIDENCE) is the only lever that lowered cash in every cold-run seed on both days,
  and saved 542 and 587 paid driver minutes. Cold, the mean saving (-25.32 and -28.18 OMR) is still within the noise.
  Started warm from the baseline plan, SYNTH-320 showed -36.35 OMR [-51.24..-18.84], larger than the warm runs' own
  noise (18.77 OMR).
- **Faster reload** by 15 minutes changed nothing beyond noise. The 15 minutes it leaves is below the measured best
  quarter of reloads (19 minutes), so this lever is an upper bound.

**Limits.**
- SYNTHETIC days with invented truck costs and generated afternoon/night acceptance.
- 40 s QUICK searches, without the second route search.
- The engine uses one travel-time table for the whole day; the evening and night speeds were only checked afterwards.
- The second driver costs 10 OMR per extra shift, an assumption (the web's default daily driver rate).
- One break per truck-day: the second driver's break and late depot staff are not modelled or priced.
- WidenPreference is built and tested but was not part of this run.

### 3.3 E2: Small-stop economics

This section is SYNTHETIC; E2 on the real 15 Oct day is in section 3.7.2.

**Setup.** SYNTH-320: 185 stops, 13 trucks; 25 small stops (3 cases or fewer). 40 s per run, seeds 1, 2, 3. Every
small stop got the fixed-plan estimate, the combine and move checks and an action; the 8 costliest were also
re-optimized for every seed. 27 runs, 21.0 compute minutes.
Truck-evidence parameters used (13 Oct analysis): small drops (under 50 cases) take 9.8 / 16 / 29 minutes on site (p25 / p50 / p75); customers get
a delivery every 5 days (median).

**Invoices.** 80 of the 320 invoices are small. 25 are small stops of their own; 55 ride inside a larger stop of the
same customer and cost no extra visit.

**Key results.** Baseline cash 667.50 [636.90..685.01] OMR; search noise 48.10 OMR.

| Stop (priority, cases) | Cash saved if taken out, fixed plan, OMR | Paid driver min freed | Est. km freed | Re-optimized: cash saved, all seeds, OMR | Action |
|---|---|---|---|---|---|
| stop-003 (P3, 3), remote | 14.96 | 160 | 78.86 | +14.98 [-0.00..+29.32] | SERVE |
| stop-143 (P2, 2) | 2.57 | 25 | 2.45 | +9.68 [-34.91..+35.66] | SERVE (P2: always served) |
| stop-101 (P3, 3) | 1.89 | 21 | 0.08 | -17.18 [-45.92..+14.44] | SERVE |
| stop-165 (P3, 3) | 1.82 | 15 | 1.96 | +1.30 [-21.59..+13.24] | SERVE |
| stop-008 (P3, 3) | 1.40 | 12 | 0.36 | +0.91 [-9.17..+11.89] | SERVE |
| stop-182 (P5, 3) | 1.39 | 12 | 0.29 | +15.88 [-3.26..+26.99] | SERVE |
| stop-132 (P3, 1) | 1.34 | 12 | 0.56 | +0.78 [-29.86..+24.27] | SERVE |
| stop-002 (P3, 3) | 1.32 | 12 | 0.07 | +1.20 [-9.27..+12.87] | SERVE |
| stop-057 (P5, 2) | 0.65 | 14 | 0.72 | not re-optimized | COMBINE: next to stop-116 on truck-06 load 2 it costs -0.14 OMR against today's place |
| stop-006 (P5, 3) | - | - | - | - | REVIEW: the plan leaves it out; never deleted, needs a dispatcher's decision |
| the other 15 small stops | 0.46 to 1.31 | 8 to 13 | 0.01 to 0.40 | not re-optimized | SERVE |

Actions: 23 SERVE, 1 COMBINE, 1 REVIEW, no DEFER. The ARTIFICIAL penalty for leaving one of these stops out ranges from
+1000 (P5) to +75924000 (P2) OMR-equivalent: a steering price, not money.

**What it means.**
- A small stop that rides with its neighbours costs little: 0.46 to 2.57 OMR of cash and 8 to 25 paid driver minutes
  (exact, for this plan). The remote small stop is the exception: 14.96 OMR, 160 paid minutes, 78.86 estimated km.
- The knock-on effect of one small stop could not be measured at 40 s: every re-optimized range crosses zero, and the
  search noise (48.10 OMR) is far larger than the stops' own cost. The fixed-plan figure is the usable one.
- No deferral was recommended. Without tomorrow's plan, the cost of delivering later is the PROXY (today's cost again),
  so a deferral cannot be shown to pay. Without margins, no profit figure exists, and no break-even margin can be given
  against a PROXY.

**Limits.** SYNTHETIC day with invented costs; PROXY future cost; no margins; one day.

### 3.4 E3: Dynamic re-planning

This section is SYNTHETIC; E3 on the real 15 Oct day is in section 3.7.3.

**Setup.** SYNTH-280: 147 stops known in the morning plus 15 late orders revealed between 08:30 and 13:00; 11 trucks.
5 simulated worlds; morning plan 40 s, each re-plan 10 s (QUICK, seed 1). 41.0 compute minutes. The morning plan served
133 of 147 stops on 19 loads, planned cash 564.49 OMR, VERIFIED.
World-model parameters used: travel time x a random factor with spread 0.373 (IVMS report), unloading spread 0.501
(13 Oct truck evidence), both medians 1.0 (a labelled default); IVMS time-of-day travel factors 06-09 0.77, 09-12
1.017, 12-15 1.033, 15-18 0.892, 18-22 1.148, 22-06 1.359.

**Key results** (SIMULATION, mean [lowest..highest] over the 5 worlds).

| Measure | A: static morning plan | B: re-plan at each depot return | C: re-plan on events |
|---|---|---|---|
| Stops served (147 known + 15 late) | 133.0 | 144.6 [141.0..149.0] | 144.6 [139.0..148.0] |
| of which morning stops | 133.0 | 130.0 [127.0..134.0] | 130.4 [127.0..133.0] |
| of which late orders | 0.0 | 14.6 [14.0..15.0] | 14.2 [12.0..15.0] |
| Late stops (after the genuine closing time) | 10.6 [9.0..13.0] | 6.2 [5.0..9.0] | 5.6 [4.0..8.0] |
| Late minutes | 641 [373..843] | 294 [80..486] | 273 [103..459] |
| Cash OMR, executed day | 651.00 [615.04..690.00] | 678.38 [643.66..711.02] | 666.66 [647.34..678.18] |
| Cash OMR per case served | 0.076 [0.072..0.081] | 0.082 [0.080..0.087] | 0.081 [0.076..0.087] |
| Estimated km | 1011.6 | 1152.0 [1075.0..1297.6] | 1131.6 [1076.0..1233.4] |
| Overtime minutes | 783 [469..1120] | 834 [544..1077] | 749 [608..900] |
| Returns after the limit | 3.4 [1..5] | 4.0 [2..6] | 3.8 [3..5] |
| Late breaks (truck-days) | 7.6 [6..10] | 6.2 [5..8] | 5.6 [4..7] |
| Missing breaks (truck-days) | 0.0 | 0.4 [0..1] | 0.4 [0..1] |
| Re-plans that searched | 0.0 | 8.4 [7.0..10.0] | 37.0 [31.0..40.0] |
| Distinct stops moved | 0.0 | 20.6 [16.0..23.0] | 32.8 [19.0..41.0] |
| Truck changes | 0.0 | 28.4 [19.0..39.0] | 57.6 [25.0..84.0] |
| Solver seconds | 0 | 85 [70..101] | 373 [313..402] |

Paired against A in the same world: B +11.6 stops, -4.4 late stops, +27.39 OMR cash [-11.56..+95.98], +140.5
estimated km; C +11.6 stops, -5.0 late stops, +15.66 OMR [-11.81..+56.42], +120.0 estimated km.

**What it means.**
- Re-planning during the day serves the late orders (14.6 of 15 for B) and lowers late deliveries (from 10.6 to 6.2
  stops; late minutes from 641 to 294).
- It costs more cash on average (+27.39 OMR for B), but the range crosses zero, and the cost per case rises from 0.076
  to 0.082 OMR.
- B and C served fewer morning stops than A (130.0 and 130.4 against 133.0; B paired -3.0 [-6..+1]), and they left
  out higher-priority stops that A served: a P1 stop in 1 of 5 worlds for B and 2 of 5 for C, and one more P2 stop
  than A in 4 of 5 worlds for B and 3 of 5 for C (stops dropped from an earlier plan: B 6.8, C 15.2 per day).
  Re-plans never plan an arrival after a genuine closing time, so part of the fall in late stops may come from not
  serving stops A delivered late. Why the morning stops were lost is not established.
- Re-planning at each depot return (B) served as many stops as re-planning on every event (C) (144.6 each), with 8.4
  searches instead of 37.0, 85 solver seconds instead of 373, 20.6 distinct stops moved instead of 32.8 and 28.4 truck
  changes instead of 57.6. C had slightly fewer late stops (5.6 vs 6.2), fewer late minutes (273 vs 294) and a lower
  mean cash change against A (+15.66 vs +27.39 OMR; lower than B's in 4 of 5 worlds), all within the spread of 5
  SYNTHETIC worlds. B is the cheaper policy to run; neither is shown to give better service.
- In the simulation, every policy had trucks back after their limit (latest return, depot closing or the truck's
  hours) in every world, 3.4 to 4.0 a day on average, and B and C each missed a driver break in 2 of 5 worlds; these
  are simulated outcomes of uncertain times, not relaxed rules.
- The morning plan's own cash was 564.49 OMR; executed in the simulated worlds, the same plan cost 651.00 OMR on
  average, with 783 overtime minutes; the difference is all driver pay and overtime. In the simulation, uncertain
  travel and unloading times made the day longer and dearer than planned. With medians fixed at 1.0, the simulated
  travel and unloading times average about 7% and 13% longer than planned by construction (the time-of-day factors
  come on top), so the size of this gap reflects the labelled default, not a measurement.
- No re-plan failed, and every re-plan was checked by the independent timetable check.

**Limits.** One SYNTHETIC day and 5 worlds; 10 s re-plans; policy A is not today's practice (a "re-plan only when a
late order arrives" policy is proposed, not built); truck positions come from the drivers' taps only (no live GPS);
depot stock always assumed available; the reload time is fixed at 30 minutes.

### 3.5 E4: Verdicts, ranked relaxations and the trade-off frontier

This section is SYNTHETIC; E4 on the real pre-fix 15 Oct request is in section 3.7.4.

**Setup.** SYNTH-320-TIGHT: SYNTH-320 with every hypermarket window closing 60 minutes earlier; 185 stops, 13 trucks.
40 s per run, seeds 1, 2, 3. 42 runs, 30.4 compute minutes.
IVMS parameters used: evening and night speed 0.839 and 0.708 x day speed. From the 13 Oct GPS evidence: within a
chain, the 25th-percentile time on site is 39% shorter than the median (422 visits; a spread across visits, not a
measured crew effect).

**Verdicts.** SEARCH_FAILURE in all three seeds: 182, 180 and 182 of 185 stops served; 3, 5 and 3 stops left out
without a proof. No stop was proven impossible. The conflict check found that every stop left out can be served on its
own; the loads passing nearby mostly lack room (for example stop-104, P5, 29 cases: nearby loads have 0.21, 0.13 and
0.12 pallets left, too little). In each seed one P3 stop was left out while 59-61 lower-priority stops were served.

**Ranked relaxations** (Δ against the base of 181.333 stops and 669.40 OMR, paired per seed).

| Relaxation | Tier | Δ stops | Gain in every seed? | Δ cash OMR (range) | Δ min past window |
|---|---|---|---|---|---|
| stop-003 window +10 min (SALES_PREFERENCE) | usable today | -0.667 | no | -1.66 (-14.72..+16.57) | -39 |
| T08 +1 load | usable today | -0.667 | no | -9.50 (-28.50..+0.00) | -301.333 |
| stop-023 window +30 min (SALES_PREFERENCE) | usable today | -1 | no | +8.61 (+1.12..+13.48) | +671 |
| stop-023 window +10 min (SALES_PREFERENCE) | usable today | -1 | no | +2.43 (-19.56..+26.84) | +138.333 |
| stop-180 window +10 min (SALES_PREFERENCE) | usable today | -1.667 | no | -6.10 (-11.96..+0.00) | -244.667 |
| stop-180 window +30 min (SALES_PREFERENCE) | usable today | -2 | no | -17.50 (-25.10..-9.83) | -821.667 |
| stop-003 window +30 min (SALES_PREFERENCE) | usable today | -2 | no | -13.55 (-22.64..-8.44) | -749.333 |
| T02 +1 load | usable today | -3.667 | no | -18.73 (-39.59..-2.17) | -1306.33 |
| shift and latest return +30 min | HYPOTHETICAL | -1.667 | no | -4.20 (-8.72..-1.42) | -183.667 |
| unloading 39% faster per case | REQUIRES EVIDENCE | **+3.667** | **yes** | -39.24 (-47.04..-25.76) | -4882 |

**Trade-off frontier** (means over the 3 seeds; no option beats another on all three counts).

| Option | Cash OMR (range) | Stops served | Minutes past window | Est. km |
|---|---|---|---|---|
| MIN_DISTANCE | 645.30 (638.19..659.27) | 181.333 | 11827.3 | 1021.4 |
| MIN_TRUCKS | 649.05 (621.95..688.30) | 182.667 | 12208.3 | 1035.5 |
| RECOMMENDED | 669.40 (663.55..674.47) | 181.333 | 8242.67 | 1187.2 |
| *Apart, REQUIRES EVIDENCE:* unloading 39% faster | 630.16 (618.62..648.72) | 185 | 3360.67 | 1262.8 |

Minutes past window (the result file calls them "min late") count against the original windows: the preferred end
where set, else the closing time. Every plan here is VERIFIED, so none arrives after a genuine closing time; these
are mostly minutes past soft preferences, not late deliveries in the sense of section 2.3.

**What it means.**
- The tool separates "impossible" from "not found". No stop was proven impossible, and each stop left out can be
  served on its own; whether all 185 can be served together under today's rules is not known (only the unproven
  faster-unloading lever served all 185). The 40 s search and full nearby loads are likely causes, not established.
- Window changes were tried only on the P3 stops with SALES_PREFERENCE windows. The P5 stops left out have UNKNOWN
  windows and were not flexed: the rule held.
- No change usable today gained stops in every seed; all 8 (and the HYPOTHETICAL shift) lowered the mean stops served
  (-0.667 to -3.667). A relaxation cannot make the best plan worse, so this is a search effect (section 3.1); the
  paired deltas share one base run per seed, so a lucky base moves them all together.
- Only faster unloading (REQUIRES EVIDENCE) gained stops in every seed (+3 to +5) and served all 185 stops. It is shown
  apart because it needs a trial first.
- There is no single best plan: MIN_DISTANCE is the cheapest, MIN_TRUCKS serves the most stops, and RECOMMENDED costs
  the most but has the fewest minutes past the preferred windows (no plan arrives after a genuine closing time). The
  dispatcher chooses.

**Limits.** SYNTHETIC day; no truck to hire is offered on it, so no hire was tried; relaxations tried one at a time;
40 s QUICK searches.

### 3.6 E5: Exact check against proven-best plans

**Setup.** 100 random SYNTHETIC small days, the same days in both variants: 3-7 stops, 1 or 2 trucks (1 truck on
about 25% of days), one load each (day types: LATE_START 38, MORNING 38, TIGHT_RETURN 24). Each day solved exactly by
the oracle and once by the engine in each variant (3 s, seed 1).
Two variants: DEFAULT (the engine's ARTIFICIAL preferred-window and early-arrival prices on) and PREFERENCES_OFF
(those prices off, so the engine ranks by service and cash, like the oracle). 9.7 compute minutes.
IVMS parameters used: Muscat median speeds 38.3 km/h (06-09), 29.01 km/h (09-12), 28.57 km/h (12-15); slow-day test:
every drive x 1.286 (the IVMS 75th-percentile travel factor).

| Measure | DEFAULT | PREFERENCES_OFF |
|---|---|---|
| Days the oracle enumerated completely (best plan proven) | 100 | 100 |
| Oracle plans that pass the engine's own checks | 100 | 100 |
| Engine plans that keep every rule of the oracle | 100/100 | 100/100 |
| Engine serves as many stops as the proven best | 100/100 | 100/100 |
| Same service value (priorities) | 100/100 | 100/100 |
| Stops proven never servable / of those, served by the engine | 68 / 0 | 68 / 0 |
| Engine proofs the oracle refutes | 0 | 0 |
| Days with no cash gap (within 0.002 OMR) | 70/100 (70%) | 98/100 (98%) |
| Cash gap, engine minus proven best, OMR | mean 0.469 [0.000..8.474], median 0.000 | mean 0.049 [-0.001..2.428], median 0.000 |
| Plans that survive the slow day: oracle / engine | 60/100 / 65/100 | 60/100 / 61/100 |

**What it means.**
- On these small days, the engine served as many stops, with the same priority value, as the proven best plan every
  time, and it never served a stop that is impossible.
- With the preferred-window prices off, the engine's cash matched the proven minimum on 98 of 100 days. With the
  preferred-window prices on, the gap is larger (mean 0.469 vs 0.049 OMR; 70 vs 98 days with no gap; at most 8.474
  OMR on one day). Most of the difference is likely the cash RECOMMENDED spends on preferred windows and early
  arrivals, but these results do not separate it from search misses: with the prices off, 2 of the same 100 days
  still had a gap (up to 2.428 OMR).
- 40 of the 100 proven-cheapest plans fail when every drive takes 1.286 times longer (engine plans: 35 fail with the
  prices on, 39 with them off); the cheapest plan on paper often has little slack.
- These are the only optimality claims in this report: they hold for the days the oracle enumerated completely, under
  its rules (the engine's own timing rules, estimated km).

**Limits.** Small days only (at most 7 stops, 1 or 2 trucks, 1 load each); this proves nothing about a 185-stop
day. The oracle uses the engine's own timing rules, so it checks the search, not whether the rules match the real
road.

### 3.7 Real days: the 15 Oct 2026 requests (REAL)

Every number in this section comes from the REAL requests; section 3.7.3 simulates their execution (labelled default
medians). The two real RouteIQ requests of 15 Oct 2026 were read and anonymised on the codespace (stops and trucks
are `stop-NNN` and `truck-NN` labels). Cash uses the truck costs in the requests. 20 s QUICK per
run, seeds 1, 2 and 3, one search at a time, no second route search (section 3.0). One day is one sample.

- **REAL-15OCT:** the 15 Oct request as planned: 86 stops, 12 trucks (3 of them hired, at 50 OMR a day each).
- **REAL-15OCT-PREFIX:** the 15 Oct request before PR #71, the one that hit the bug fixed there: 94 stops, the 9 own
  trucks. Solved here by today's engine.

No real window has a source label (RouteIQ records none), so every real window is UNKNOWN: a window change on a real
day is HYPOTHETICAL, never usable today. Early 20 s x 2 seed smoke runs on these requests during the build (on
build-phase code) are superseded by this section.

#### 3.7.1 E1 on the real day: what-if levers

**Setup.** REAL-15OCT. Levers: window flex +10 / +20 / +30 min (all HYPOTHETICAL: every window is UNKNOWN) and the
two REQUIRES EVIDENCE levers, each alone; every variant solved cold and warm. Afternoon and Night were not run: RouteIQ
has no record of which customers accept them. 36 runs, 53.7 compute minutes.
Baseline (cold): cash 619.97 [540.15..734.12] OMR; 83.7 [82.0..85.0] of 86 stops; 10.7 [10.0..12.0] trucks; 1247.2
[1067.9..1493.7] estimated km; VERIFIED in every seed. Search noise: 193.97 OMR and 3 stops cold; 235.82 OMR and 1
stop warm.

**Key results (cold runs; change against the baseline, mean [lowest..highest] over 3 seeds).** No cash change is
larger than the search noise.

| Lever | Group | Δ cash OMR | Δ stops | Δ trucks | Δ est. km | Δ late stops | Δ paid driver min |
|---|---|---|---|---|---|---|---|
| Flex +10 min | HYPOTHETICAL | -94.36 [-243.23..+22.71] | +0.7 [-1.0..+2.0] | -1.0 [-3.0..+0.0] | -199.2 [-481.5..+133.8] | +2.0 [+1.0..+3.0] | -331 [-812..+253] |
| Flex +20 min | HYPOTHETICAL | -47.27 [-102.17..+5.07] | -5.0 [-14.0..+1.0] (worse: a search effect) | -1.0 [-2.0..+0.0] | -30.6 [-87.6..+54.5] | +5.3 [+4.0..+6.0] | -10 [-152..+154] |
| Flex +30 min | HYPOTHETICAL | -130.43 [-240.45..-52.67] | +0.7 [-1.0..+3.0] | -1.7 [-3.0..-1.0] | -238.9 [-504.7..-50.0] | +5.7 [+4.0..+9.0] | -309 [-666..-33] |
| Faster unloading -20% per case | REQUIRES EVIDENCE | -116.94 [-223.14..-22.13] | +1.3 [+0.0..+3.0] | -1.3 [-3.0..+0.0] | -217.5 [-433.8..-68.6] | +0.0 | -702 [-954..-489] |
| Faster reload -15 min | REQUIRES EVIDENCE | -27.45 [-194.99..+146.48] | +0.7 [-1.0..+2.0] | +0.0 [-2.0..+2.0] | -57.9 [-429.6..+386.0] | +0.0 | -150 [-792..+427] |

Started warm from each seed's baseline plan (Δ against the warm control): Flex +10 -103.33 OMR, +0.7 stops; Flex
+20 -92.14 OMR, -4.7 stops [-16..+2]; Flex +30 -88.32 OMR, -3.3 stops [-12..+2]; faster unloading -132.97 OMR
[-273.98..-48.90], +1.7 stops [+1..+2]; faster reload -80.91 OMR, -3.0 stops [-12..+2]. Every warm cash change is
within the warm noise (235.82 OMR). Late stops count against the day's own windows, before any lever moved them:
in the flexed rows they are the arrivals the flex itself allowed, at most 10, 20 or 30 minutes after today's window
end. No variant needed a second driver.

**What it means.**
- **Window flexibility on the real day is not established and not usable today.** Every window is UNKNOWN, so these
  rows only show what flexing would do if the windows turned out to be sales preferences. No flex changed cash by
  more than the noise. Flex +30 used fewer trucks in every seed (-1.7 [-3..-1]) and fewer estimated km, with 4-9
  stops arriving up to 30 minutes after today's window end; this too is within the noise. Flex +20 lost 14 stops in
  one seed: a relaxation cannot make the best plan worse, so this is a search effect.
- **The mean cash changes are all negative mostly because of one base run.** Seed 2's baseline was the 12-truck plan
  (734.12 OMR), and every lever's seed-2 run cost 102.17 to 243.23 OMR less (section 3.1).
- **Faster unloading (REQUIRES EVIDENCE)** lowered cash in every seed (within the noise), freed 489-954 paid driver
  minutes in every seed, and, started warm, served +1.7 stops [+1..+2] in every seed. It cut the unloading time of
  72 stops by 378 minutes in all.
- **Faster reload (REQUIRES EVIDENCE):** the real request's reload setting is 35 minutes, so -15 minutes leaves 20,
  just above the measured best quarter of reloads (19 minutes). Nothing beyond the noise.

**Limits.** One real day; 20 s QUICK without the second route search; levers one at a time; no window source labels;
no afternoon or night acceptance data.

#### 3.7.2 E2 on the real day: small stops

**Setup.** REAL-15OCT: 4 small stops (3 cases or fewer), all P3, all late orders. Each got the fixed-plan estimate
(on seed 1's plan), the combine and move checks and an action, and was re-optimized for every seed. 27 items, 20.9
compute minutes. Baseline cash 534.35 [500.48..585.64] OMR; 84.3 [84.0..85.0] of 86 stops served; search noise 85.16
OMR.

| Stop (priority, cases) | Late order | Cash saved if taken out, fixed plan, OMR | Paid driver min freed | Est. km freed | Nearest stop on its load (straight line) | Re-optimized: cash saved, all seeds, OMR | Action |
|---|---|---|---|---|---|---|---|
| stop-041 (P3, 3) | yes | 0.91 | 17 | 1.60 | 0.92 km (combined) | -109.48 [-157.23..-29.25] | SERVE |
| stop-035 (P3, 3) | yes | 0.72 | 16 | 0.56 | 0.92 km (combined) | -3.54 [-57.28..+56.89] | SERVE |
| stop-069 (P3, 3) | yes | 0.65 | 13 | 0.82 | 0.50 km (combined) | -31.30 [-103.63..+26.12] | SERVE |
| stop-027 (P3, 1) | yes | 0.63 | 15 | 0.04 | 2.40 km | -44.06 [-171.45..+35.65] | SERVE |

Actions: 4 SERVE (a late order is always served). The move check found a timed place on another load for each, 0.08
to 1.51 OMR dearer than where it is. The ARTIFICIAL penalty for leaving one of them out is +3000 OMR-equivalent: a
steering price, not money.

**What it means.**
- On the real day a small stop costs 0.63-0.91 OMR of cash and 13-17 paid driver minutes where it is (exact, for this
  plan). Three of the four ride within 1 km (straight line) of another stop on the same load.
- Re-solving the whole day without one small stop changed the cash saved by -171.45 to +56.89 OMR: the re-solved day
  cost between 56.89 OMR less and 171.45 OMR more, often with 1-3 more trucks, against a search noise of 85.16 to
  197.88 OMR (as the result file computes it per stop), and only 1 of the 12 re-optimized runs served the other stops
  alike. These are search effects, not the stops' cost; the fixed-plan figure is the usable one.
- No deferral could be judged: there are no margins and no tomorrow's plan, and late orders are served by rule.

**Limits.** One real day; 4 small stops; PROXY future cost; no margins.

#### 3.7.3 E3 on the real day: re-planning without new orders

**Setup.** REAL-15OCT with all 86 stops known in the morning: no order is revealed during the day (the request's late
orders are known from the start here). 12 trucks; 3 simulated worlds; morning plan 20 s, each re-plan 10 s (QUICK,
seed 1). Morning plan: 85 of 86 stops on 14 loads, 10 trucks, planned cash 540.38 OMR, VERIFIED. Without window labels
every window counts as genuine. The world model is the one of section 3.4 (labelled default medians). 10 items, 16.0
compute minutes.

**Key results** (SIMULATION, mean [lowest..highest] over the 3 worlds).

| Measure | A: static morning plan | B: re-plan at each depot return | C: re-plan on events |
|---|---|---|---|
| Stops served (of 86) | 85.0 | 82.7 [82.0..84.0] | 83.0 [82.0..84.0] |
| Late stops (after the closing time) | 15.7 [10.0..20.0] | 10.3 [8.0..12.0] | 10.3 [8.0..12.0] |
| Late minutes | 786 [340..1054] | 486 [196..761] | 486 [196..761] |
| Cash OMR, executed day | 577.77 [570.52..587.26] | 583.63 [561.24..608.14] | 621.06 [581.80..673.23] |
| Cash OMR per case served | 0.073 [0.072..0.074] | 0.078 [0.074..0.081] | 0.080 [0.074..0.087] |
| Estimated km | 1066.8 | 1090.4 [1030.5..1206.3] | 1098.8 [1034.3..1206.3] |
| Overtime minutes | 186 [79..316] | 145 [59..307] | 145 [59..307] |
| Returns after the limit | 2.0 [1..3] | 2.0 [1..3] | 2.3 [2..3] |
| Late breaks (truck-days) | 3.3 [3..4] | 2.7 [2..3] | 2.7 [2..3] |
| Missing breaks (truck-days) | 2.3 [1..4] | 1.3 [0..3] | 1.3 [0..3] |
| Re-plans that searched | 0.0 | 6.0 [4.0..8.0] | 17.0 [14.0..19.0] |
| Distinct stops moved | 0.0 | 4.3 [1.0..7.0] | 6.3 [3.0..9.0] |
| Truck changes | 0.0 | 8.7 [1.0..17.0] | 15.0 [8.0..20.0] |
| Solver seconds | 0 | 77 [54..100] | 229 [174..269] |

Paired against A in the same world: B -2.3 stops [-3..-1], -5.3 late stops [-9..-2], +5.86 OMR cash
[-14.29..+37.62], +23.5 estimated km; C -2.0 stops [-3..-1], -5.3 late stops [-9..-2], +43.28 OMR [-5.46..+97.70],
+32.0 estimated km.

**What it means.**
- **With nothing new to place, re-planning served fewer stops** than the morning plan in every world (1 to 3 fewer
  for B and for C), and **had fewer late stops** in every world (5.3 fewer on average; late minutes 786 to 486), one
  missing break fewer in every world and less overtime (186 to 145 minutes). Re-plans never plan an arrival after a
  closing time, so part of the fall in late stops may come from not serving stops A delivered late; this was not
  established.
- B left out a P1 stop in 1 of 3 worlds that the morning plan delivered (possibly late); C left out only P3 stops. B
  served 393 fewer cases on average (6 to 990).
- C's mean cash change (+43.28 OMR) comes mostly from one world, where its re-plans put two more trucks on the road
  (+97.70 OMR). B's (+5.86 OMR) crosses zero.
- B and C had the same late stops and late minutes in every world; C needed 17.0 searches and 229 solver seconds
  against B's 6.0 and 77.
- Executed in the simulated worlds, the morning plan cost 577.77 OMR on average against 540.38 OMR planned: as on the
  synthetic day, the uncertain times (labelled default medians) made the day longer and dearer than planned.
- No re-plan failed, and every re-plan was checked by the independent timetable check.

**Limits.** One real day and 3 worlds; no order revealed during the day; 10 s re-plans; the reload time is fixed at
the request's setting (35 minutes); otherwise the same world-model defaults and limits as section 3.4.

#### 3.7.4 E4 on the real pre-fix request: verdicts, relaxations, frontier

**Setup.** REAL-15OCT-PREFIX: 94 stops, the 9 own trucks. 42 runs, 73.5 compute minutes. Candidates: windows +10 /
+30 min for up to 3 stops left out (HYPOTHETICAL: UNKNOWN windows), one more load on up to 2 trucks, one hired truck,
the shift and latest return +30 min (HYPOTHETICAL), unloading 39% faster (REQUIRES EVIDENCE). The hire options are the
3 trucks hired on 15 Oct that this request lacks, at their own hire price (50 OMR a day); a hire variant also runs the
engine's own hire check, as in production.

**Verdicts.** SEARCH_FAILURE in all three seeds: 84, 84 and 78 of 94 stops served; 10, 10 and 16 stops left out
without a proof. No stop was proven impossible and no model error was suspected: today's engine produces a plan for
the request that hit the bug fixed in PR #71. The conflict check found that every stop left out can be served on its
own; the loads passing nearby mostly lack room, or the detour misses the window (for example stop-061, P2, 1000
cases: its 8.9 pallets fit the largest truck's 12 and its round trip fits the shift, but the loads passing within
1.3 estimated km (straight line x 1.3) have 0.13 to 2.71 pallets left). In seed 1 that P2 stop was left out while 48
lower-priority stops were served; in seeds 1 and 2, P3 stops were left out while one or two P4 stops were served.

**Ranked relaxations** (Δ against the base of 82 [78..84] stops and 514.60 OMR, paired per seed; minutes past
window did not change for any of them except stop-010's window +30 min (+10 minutes, arrivals the flex itself
allowed)). The three groups are kept apart.

*Usable today:*

| Relaxation | Δ stops | Gain in every seed? | Δ cases | Δ cash OMR (range) |
|---|---|---|---|---|
| hire 1 truck (14 bays, 50 OMR a day) | +5.667 [+4..+9] | **yes** | +782.333 | +70.63 (+56.06..+92.67) |
| truck-03 +1 load | +4 [+1..+9] | **yes** | -4.333 | +0.29 (-11.26..+8.28) |
| truck-01 +1 load | +2 [-2..+9] | no | +134.333 | -10.74 (-29.22..+11.65) |

*HYPOTHETICAL (needs a confirmation or an agreement):*

| Relaxation | Δ stops | Gain in every seed? | Δ cases | Δ cash OMR (range) |
|---|---|---|---|---|
| shift and latest return +30 min | +2.333 [-1..+5] | no | +59.667 | +6.11 (-14.77..+27.32) |
| stop-010 window +30 min (UNKNOWN) | +2.333 [+0..+5] | no | +26.667 | -5.94 (-42.56..+27.50) |
| the 5 other window changes (stop-002, stop-010, stop-061; +10 or +30 min) | -0.333 to +0.667 | no | -28 to +27 | -4.30 to +3.67 |

*REQUIRES EVIDENCE (operational improvement potential, never a baseline):*

| Relaxation | Δ stops | Gain in every seed? | Δ cases | Δ cash OMR (range) |
|---|---|---|---|---|
| unloading 39% faster per case | +7.667 [+4..+13] | **yes** | +913.667 | -16.57 (-42.05..+27.68) |

**Trade-off frontier** (means over the 3 seeds).

| Option | Cash OMR (range) | Stops served | Minutes past window | Trucks | Est. km | On the frontier? |
|---|---|---|---|---|---|---|
| MIN_TRUCKS | 496.85 (480.51..511.29) | 85.667 | 0 | 9 | 945.9 | yes |
| MIN_DISTANCE | 505.41 (499.66..508.97) | 87 | 0 | 9 | 931.9 | yes |
| RECOMMENDED | 514.60 (504.02..525.27) | 82 | 0 | 9 | 1007.8 | no (beaten by MIN_TRUCKS) |
| truck-03 +1 load | 514.90 (503.26..529.13) | 86 | 0 | 9 | 1027.2 | no (beaten by MIN_DISTANCE) |
| hire 1 truck (14 bays, 50 OMR a day) | 585.24 (567.19..607.19) | 87.667 | 0 | 10 | 1043.8 | yes |

**What it means.**
- **Today's engine produces a plan for the request that failed on 15 Oct**, and none of the stops it leaves out is
  proven impossible. A longer search, a change or a relaxation could serve any one of them. No run served all 94
  stops (at most 91, and that only with the unproven faster unloading), so whether they all fit together on the 9 own
  trucks is not known.
- **One more load on truck-03 against hiring a truck.** One more load on truck-03 (a company setting: loads per truck
  per day; shift, return and break limits unchanged) served more stops in every seed (+2, +1 and +9; mean +4) at
  about the same cash (+0.29 OMR, range -11.26..+8.28). Most of the mean comes from seed 3, whose base run served only
  78 stops (the one-base-run effect of section 3.1), and +4 is within the request's own 6-stop seed spread (78 to
  84). It served fewer cases on average (-4, range -883..+999): more small stops and, in some seeds, fewer large
  ones; in at least one seed it left out the P2 stop of 1000 cases (stop-061) that the base plan served. Hiring one
  truck served +4, +4 and +9 stops (mean +5.667, also within the spread) and more cases in every seed (+317 to +1209,
  mean +782), for +70.63 OMR (the 50 OMR hire and the extra driving). Neither gain is established. Both are usable
  today; check what each option leaves out before choosing. One more load on truck-01 did not gain in every seed.
- **HYPOTHETICAL changes** (30 minutes more shift and latest return, or a window of unknown source moved) gained at
  most +2.333 stops on average, and none in every seed.
- **Faster unloading (REQUIRES EVIDENCE)** gained the most, +7.667 stops in every seed, at -16.57 OMR on average (the
  range crosses zero). It needs a measured trial first and is shown apart.
- **The engine's default plan was beaten on this request.** RECOMMENDED was beaten by MIN_TRUCKS in every seed
  (5.27-34.01 OMR cheaper and 1, 2 and 8 more stops; but the mean gaps of 17.75 OMR and 3.7 stops are within this
  request's seed spread of 21.25 OMR and 6 stops, and seed 3's 78-stop RECOMMENDED run gives 8 of the 11 extra stops:
  suggestive, not established). MIN_DISTANCE served the most stops without hiring (87 on average) for 9.19 OMR less
  than RECOMMENDED on average (but not in seed 3, where it cost 508.97 against RECOMMENDED's 504.02 OMR). Every plan
  arrived inside every window (0 minutes past window). Why RECOMMENDED served fewer stops here is not established.
  Here each option searched alone for 20 s QUICK, without the second route search; in production the two
  alternatives are warm-started from RECOMMENDED's plan with a shorter search (half the QUICK time; at least 60 s in
  THOROUGH), so production plans may differ.
- The frontier shows the choice: MIN_TRUCKS is the cheapest, MIN_DISTANCE serves the most stops without hiring, and a
  hired truck serves the most stops for 79.83 OMR more than MIN_DISTANCE.

**Limits.** One real request; 20 s QUICK without the second route search; relaxations tried one at a time; hires
limited to the 3 trucks hired that day.

---

## 4. Implemented vs proposed

IMPLEMENTED: built, tested and run (on SYNTHETIC days and, where a real day applies, on the REAL 15 Oct requests).
PARTIAL: built, but missing data limits it, it was not run, or it is not complete. PROPOSED: not built. OWNER TO
CONFIRM: only the owner can check it.

| # | Item from the owner's request | Status | Where | Note |
|---|---|---|---|---|
| **1** | **What-if and sensitivity** | | | |
| 1.1 | 10 / 20 / 30 min flexibility | IMPLEMENTED | `whatif.Flex`; E1 | SALES_PREFERENCE windows only; UNKNOWN only in HYPOTHETICAL rows |
| 1.2 | Wider windows | PARTIAL | `whatif.WidenPreference`, `PrefFlex` | PrefFlex +30 run in E1; WidenPreference built and tested, not run |
| 1.3 | Afternoon / night delivery | IMPLEMENTED | `whatif.Afternoon`, `Night`; E1 | Only customers who accept; second driver priced as an assumption; IVMS speed check |
| 1.4 | Realistic unloading / reloading reductions | IMPLEMENTED | `whatif.FasterUnloading`, `FasterReload`; `explain.FasterUnloading` | REQUIRES EVIDENCE; basis: the 39% spread in the 13 Oct truck evidence (upper bound) and the measured reload times. On the synthetic days FasterReload's -15 min (30 to 15 min) goes below the measured best quarter of reloads (19 min): an upper bound; on the real day it leaves 20 min |
| 1.5 | Genuine restrictions vs salesman preferences | PARTIAL | window labels in `synth`; rules in `whatif` and `explain` | The rule works, but RouteIQ has no field for it: every real window is UNKNOWN. A customer window-source field is PROPOSED |
| 1.6 | Never relax closing times, breaks, shift, capacity, safety | IMPLEMENTED | `whatif.guard`; explain levers; tests | Checked before every solve; the one exception is the second-driver extension of Afternoon/Night past the normal day (priced as an assumption) |
| 1.7 | Faster unloading needs evidence | IMPLEMENTED | `requires_evidence` flag | Reported apart, never a baseline |
| 1.8 | Combinations of levers | IMPLEMENTED | `whatif.run_whatif` | Pairs, all without evidence, all with evidence |
| 1.9 | What-if on a real day | IMPLEMENTED | E1 REAL-15OCT; section 3.7.1 | Run in full; its window levers are HYPOTHETICAL until windows are labelled (1.5) |
| **2** | **Delivery economics of 1-3 case orders** | | | |
| 2.1 | Serve / combine / other load / defer | IMPLEMENTED | `economics.fixed_plan`, `combine_check`, `move_check`, `defer` | |
| 2.2 | Marginal cost without knock-on effects | IMPLEMENTED | `economics.fixed_plan` | Exact re-timing, no search noise |
| 2.3 | Marginal cost with knock-on effects | IMPLEMENTED | `economics.defer` | Used only when it beats the search noise; in E2 it never did, on the synthetic or the real day |
| 2.4 | Contribution margin and avoidable cost, not revenue | PARTIAL | `economics` | Avoidable cash computed; margins only if supplied (none exist); break-even only with tomorrow's plan |
| 2.5 | Cash vs time/capacity vs ARTIFICIAL penalties | IMPLEMENTED | `core.metrics`, every report | Three separate columns |
| 2.6 | Future delivery cost | PARTIAL | `economics.next_day_cost` | Works with a next-day plan; none available, so the PROXY is used; IVMS visit frequency shown as context |
| 2.7 | Recommend, never delete | IMPLEMENTED | `economics` actions | Drop shown for comparison only |
| 2.8 | Invoices vs stops | IMPLEMENTED | `economics` | Which small invoices ride inside larger stops |
| 2.9 | Economics on a real day | IMPLEMENTED | E2 REAL-15OCT; section 3.7.2 | Run in full: 4 small stops, all late orders, all SERVE |
| **3** | **Dynamic multi-trip re-planning** | | | |
| 3.1 | Loads 1-3 with reload time | IMPLEMENTED (simulator) | `dynamic` | Reload fixed at the setting (30 min synthetic, 35 min on the real request) |
| 3.2 | Re-plan triggers | IMPLEMENTED (simulator) | policies A / B / C | Depot return, delay over 20 min, new order |
| 3.3 | Vehicle positions | PARTIAL | `dynamic` | Depot or last completed stop, from taps; live GPS PROPOSED |
| 3.4 | Onboard stock | PARTIAL | `dynamic` | A departed load's orders are its stock; re-delivery of failed drops not modelled |
| 3.5 | Completed and in-progress stops | IMPLEMENTED (simulator) | `dynamic` events | |
| 3.6 | Locks | PARTIAL | `dynamic` | Whole loads committed once loading starts; per-stop locks PROPOSED |
| 3.7 | Depot stock availability | PROPOSED | - | Assumed always available |
| 3.8 | Driver shifts | PARTIAL | the request's per-truck shift limits | Shifts per driver not available |
| 3.9 | Minimise changes | IMPLEMENTED | `dynamic` | Previous truck kept where possible (ARTIFICIAL change price); stops moved measured |
| 3.10 | Required data, events and integrations | IMPLEMENTED | `dynamic.data_requirements()`; section 6 | |
| 3.11 | Simulated events, no future information | IMPLEMENTED | `dynamic.World`, `PlannerView`; tests | |
| 3.12 | Automatic re-planning inside RouteIQ | PROPOSED | - | Today a re-plan starts on a click |
| 3.13 | Re-routing a truck already on the road | PROPOSED | - | Not modelled; the engine cannot |
| 3.14 | A "today's practice" policy (re-plan only when a late order arrives) | PROPOSED | - | Owner decision |
| 3.15 | Dynamic run on a real day | IMPLEMENTED (simulator) | E3 REAL-15OCT; section 3.7.3 | Run in full: 3 worlds, no order revealed during the day |
| **4** | **Feasibility and trade-off explanations** | | | |
| 4.1 | Proven impossible vs search failure vs suspected model error | IMPLEMENTED | `explain.verdict` | |
| 4.2 | Conflicting constraints | IMPLEMENTED | `explain.conflicts` | |
| 4.3 | Smallest useful relaxations, ranked | IMPLEMENTED | `explain.rank_relaxations` | One change at a time; combinations not tried |
| 4.4 | Sentences in OMR | IMPLEMENTED | `explain.relaxation_sentence` | |
| 4.5 | Cost / service trade-offs, not one score | IMPLEMENTED | `explain.frontier` | Unproven changes never beat options usable today |
| 4.6 | Explanations on RouteIQ's screens | PROPOSED | - | No screens built |
| 4.7 | Explanations of a real day | IMPLEMENTED | E4 REAL-15OCT-PREFIX; section 3.7.4 | Run in full on the request that failed on 15 Oct |
| **5** | **Execution and evidence** | | | |
| 5.1 | Historical data | PARTIAL | `history`, `ivms` | Two real requests of one day (15 Oct) and the IVMS report, all used; one day is one sample |
| 5.2 | 280-400 invoice days (300+ in E1, E2, E4; E3 uses 280 + 15 late orders), mixed trucks, clustered and remote small orders, tight morning windows | IMPLEMENTED | `synth.make_day`; SYNTH-280 / 320 / 400 / 320-TIGHT | |
| 5.3 | Uncertain travel and unloading | IMPLEMENTED | `history.UncertaintyModel`; E3; E5 slow day | Travel spread from the IVMS report, unloading spread from the 13 Oct truck evidence; medians a labelled default |
| 5.4 | Equal budgets and repeated seeds | IMPLEMENTED | `core.Budget`, `core.seeded`; `experiments` | A seed reorders the stops; seeds inside OR-Tools PROPOSED |
| 5.5 | Independent feasibility validation | IMPLEMENTED | `feasibility.check_scenario` on every plan | All plans VERIFIED |
| 5.6 | Exact small-instance checks | IMPLEMENTED | `exact`; E5 | Up to 8 stops, 2 trucks, 1 load each |
| 5.7 | No optimality claims without proof | IMPLEMENTED | all reports | Only E5's oracle |
| 5.8 | No future information | IMPLEMENTED | `dynamic` | |
| 5.9 | Runnable tests | IMPLEMENTED | `tests/test_ds_*.py` | 120 tests |
| 5.10 | Scenario results in OMR | IMPLEMENTED | `results/` | Synthetic and real complete (INDEX.md) |
| 5.11 | Implementation report and this table | IMPLEMENTED | this file | |
| 5.12 | Missing inputs and assumptions documented | IMPLEMENTED | section 5 | |
| 5.13 | Use of the IVMS report | IMPLEMENTED | `ivms`; `data/ivms_aggregates.json` | Aggregates only; used by every module |
| 5.14 | Evidence at production settings (THOROUGH, second search, road km) | PROPOSED | - | This run: 40 s (synthetic) and 20 s (real) QUICK, no second search, estimated km |
| 5.15 | Engine fix: a higher priority left out while lower priorities ride | PROPOSED | - | Seen again in E4: on the synthetic tight day (one P3 stop out per seed while 59-61 lower-priority stops were served) and on the real pre-fix request (a P2 stop out in one seed while 48 lower-priority stops were served) |
| 5.16 | Separate branch, no deploy | IMPLEMENTED | `feat/decision-support` | Not merged, not deployed; the live planner does not use it |
| 5.17 | Compute on GitHub or the codespace, never the laptop | IMPLEMENTED | section 3.0 | Synthetic days on GitHub Actions run 38674195128; real days on the codespace |
| 5.18 | No customer data exposed | PARTIAL until the history squash | section 7.4 | Committed files clean; earlier branch commits held small-region IVMS tables (squash pending) |
| 5.19 | No new charges | OWNER TO CONFIRM | section 3.0 | GitHub Actions is free for a public repository; the real-day runs (164 solver-minutes on 4 lanes, plus the first overnight attempt) used codespace time after the free quota, under the billing the owner restored |

---

## 5. Missing inputs and assumptions

### 5.1 What is not available

| Missing input | Why it matters | What was done instead |
|---|---|---|
| Window provenance (genuine receiving time vs salesman's preference) | Decides which windows may flex | Synthetic days carry generated labels; real windows are all UNKNOWN, flexed only in HYPOTHETICAL rows |
| Customers' genuine receiving hours | The limit a preference window can widen to | Synthetic only; real days use the window as sent |
| Which customers accept afternoon or night delivery | The afternoon and night levers | Generated flags on synthetic days |
| Margins per case or invoice values | Contribution margin of a small order | None used; no profit figures given |
| Tomorrow's plan | The real cost of delivering a deferred order later | PROXY: today's cost reused, labelled |
| Live truck GPS (Ayun / IVMS feed) | Truck positions between taps; late trucks spotted early | Positions from drivers' taps only |
| Onboard stock and depot stock | What a truck still carries; what can be loaded | A departed load's orders are its stock; depot stock assumed always available |
| Per-stop locks | Keeping a promised customer on its truck through re-plans | Whole loads committed once loading starts |
| Driver shifts per driver; driver agreement for longer shifts | Longer shift and night levers | Per-truck shift limits; a longer shift labelled HYPOTHETICAL |
| The real cost of a night or second driver | Night lever | 10 OMR per extra shift (assumption) |
| Depot staff, and their cost, after the normal day; the second driver's break | Afternoon / Night levers past the normal day | Not modelled or priced; RouteIQ cannot confirm them (the second driver is priced as an assumption) |
| Measured turnaround (reload) times per load | Reload uncertainty | Fixed reload setting (30 min synthetic, 35 min on the real request) |
| GPS-confirmed arrival and departure times | Any bias in planned travel and unloading times | Medians set to 1.0, a labelled default (on 14 Oct, 67 of 72 arrivals were tapped by hand) |
| Seeds inside OR-Tools | True repeated searches | A seed reorders the stops before the search |
| Evidence that unloading can be faster | Faster-unloading lever | Kept REQUIRES EVIDENCE; basis: the 39% spread in the 13 Oct truck evidence (upper bound) |
| More real days | One real day is one sample | Two requests of one day (15 Oct 2026) only |
| THOROUGH and second-search runs; road distances | Production-like noise and costs | Not measured; estimated km |

### 5.2 Assumptions used, and their source

| Assumption | Value | Source |
|---|---|---|
| Unloading time per case | 0.25 min | 14 Oct benchmark (13 Oct drop-size model: 0.243-0.245) |
| Unloading base time per customer type | per type | Synthetic generator (rounded from the 13 Oct truck evidence) |
| Window labels; afternoon / night acceptance | generated | Synthetic generator |
| Truck costs, fleet, shift, break, fuel price, driver pay | invented, same order of size as the company's settings | Synthetic generator |
| Share of small invoices | about 25% of invoices are 1-3 cases | Owner |
| Second driver for a truck back after the normal day | 10 OMR per truck-day, on top of the engine's own hourly and overtime pay (part of the pay may count twice) | Web default daily driver rate (`hire.ts`) |
| Evening / night drive speed | 0.839 / 0.708 x the day speed | IVMS aggregate (Muscat medians 30.7, 25.71 and 21.71 km/h) |
| Best-quartile unloading gap | 39% shorter than the median (a spread across visits within a chain, not a measured crew effect) | 13 Oct truck evidence (422 GPS visits, 8 chains) |
| Reload between loads | 3T: median 28 min; 10T: about 30 min | 13 Oct truck evidence |
| Latest return to the depot today | 10T median 17:00; 3T median 17:36 | 13 Oct truck evidence |
| Travel and unloading spread | 0.373 and 0.501 | IVMS aggregate (n=3719) and 13 Oct evidence (n=226) |
| Travel and unloading medians | 1.0 | Labelled default |
| Time-of-day travel factors | 06-09 0.77 ... 22-06 1.359 | IVMS aggregate |
| Muscat median speeds (E5) | 38.3 / 29.01 / 28.57 km/h | IVMS aggregate |
| Slow-day factor (E5) | 1.286 | IVMS aggregate (75th-percentile travel factor) |
| Small drops on site | 9.8 / 16 / 29 min (p25 / p50 / p75) | 13 Oct truck evidence (context only) |
| Days between deliveries | 5 (median) | 13 Oct truck evidence (context only) |
| Future cost of a deferred order | today's fixed-plan cost | PROXY (economics default) |
| A small stop is "combined" | another stop of its load within 2 km | Design default |
| A saving must beat | 0.10 OMR in every seed | Economics default |
| Delay that triggers a re-plan (policy C) | 20 min | Design default |
| Price for moving a stop to another truck | 3 OMR-equivalent, ARTIFICIAL | Engine default |
| First loads | loaded the night before (committed) | NMWC practice |
| Distances | straight line x 1.3, at the engine's speed settings | Engine (HAVERSINE), so estimated km |
| E4 tight day | hypermarket windows close 60 min earlier | Evidence suite |
| Real-day truck costs, fleet, shifts, windows | as in the 15 Oct requests (hired trucks 50 OMR a day each; reload 35 min) | The REAL requests |
| Real-day window source | UNKNOWN for every window | RouteIQ records none |

---

## 6. Required data, events and integrations for dynamic re-planning

From `dynamic.data_requirements()`. "Today" means what RouteIQ has now.

| Need | Kind | Today | Where it is today | What it is for |
|---|---|---|---|---|
| Stop arrival, departure and outcome taps | Event | YES | Driver page (stop visits and events) | Stop completed with actual times; delay detection. Hand taps are upper bounds (14 Oct: 67 of 72 arrivals tapped by hand) |
| Back at depot | Event | YES | Driver's "back at depot" event | The actual return that the truck's next load must follow |
| Load departed | Event | PARTIAL | Load status DISPATCHED with its time; the plan keeps the planned departure | The moment a load's stops become fixed |
| New / late order with its arrival time | Event | YES | Late-order intake (time uploaded, late flag) | New orders, revealed only when they arrive |
| Actual or forecast return of loads already out | Data | NO | Re-plans send the planned departure and return | Placing loads 2 and 3 after the real return |
| Plan continuity on re-plans | Data | PARTIAL | Previous truck sent; the change price is never sent (engine default 3, ARTIFICIAL) | Route stability: fewer stops moved |
| Live truck position (Ayun / IVMS feed) | Integration | NO | Reserved only; IVMS used as an offline report | Position between taps, an overdue truck spotted early, live arrival times |
| Onboard stock | Data | PARTIAL | Implicit: a dispatched load's orders; delivered cases per stop | Same-day re-delivery of failed drops; what a returning truck still carries |
| Stock availability at the depot | Data | NO | No inventory in RouteIQ; orders arrive by Excel upload | Loads 2 and 3 and new orders can only carry stock the warehouse has |
| Per-stop locks | Data | NO | Locks exist per load only | Keeping a promised customer on its truck or load through re-plans |
| Automatic re-plan trigger | Integration | NO | Re-plans start on a click; the day screen only flags a stale plan | Policies B and C; a background what-if that never changes the live plan |
| Re-routing a load on the road | Integration | NO | Every route starts and ends at the depot; dispatched loads cannot change | Changing a load already out (not modelled) |
| Measured turnaround (reload) times | Data | PARTIAL | "Back at depot" and the next departure give it; nothing adds it up | Reload uncertainty (fixed at the setting here) |
| Travel and unloading uncertainty | Data | PARTIAL | IVMS aggregates, 13 Oct evidence, 14 Oct plan vs actual | The simulated actual times; medians are labelled defaults |

---

## 7. Review and quality

### 7.1 Tests

120 decision-support tests in 9 files (section 2.5; 115 before experiment E6). Two of them need the real 15 Oct day and are skipped where it is
not present (as on CI). On the codespace, before the history was squashed, the code of commit `6b6de09` (identical
files) passed all 116 tests (the then 114 plus the 2 import-guard tests) in 71.6 s. The IVMS region rule of section
7.4 added the 115th test; with it, all 117 tests (115 plus 2) passed on the codespace. Experiment E6 (15 Oct, the engine at
production settings) added 5 tests to `test_ds_experiments.py`: 120 in all. All 122 (120 plus the 2 import-guard tests)
passed on the codespace in 73.2 s, from an uncommitted copy of the change, before it was committed.

### 7.2 CI

GitHub Actions CI run 38662580861 on commit `6b6de09`: **green**.
- Web job (lint, typecheck, unit and integration tests): success.
- Solver job (the whole solver suite): 729 passed, 5 skipped, 1 expected failure, in 1425.60 s. Of these, the
  decision-support tests: 112 passed, 2 skipped (the two real-day tests).
- The region test was added after this run; CI has not run on the branch since.

### 7.3 Adversarial review

Four reviewers read the code and re-ran small cases on purpose to break it. They reported 20 findings; two were the same
defect, so 19 distinct defects. **All 19 were fixed**; 16 came with a new or updated test (the two privacy fixes and
the policy-A label fix, number 14, did not), and every reviewer's reproduction was re-run before and after the fix.

| # | Finding (short) | Severity |
|---|---|---|
| 1 | What-if: the normal day's end was computed wrongly, so normal plans were charged a phantom second driver | high |
| 2 | What-if: late stops and preference minutes were measured against the relaxed windows, so flex looked free | high |
| 3 | Explanations: unproven levers (faster unloading, longer shift) could push today's real options off the frontier (found by two reviewers) | high |
| 4 | Faster unloading was computed two ways in two modules (624 vs 747 minutes saved on the real day) | medium |
| 5 | Economics: without tomorrow's plan the break-even margin always read 0.00, with "does not pay at any margin" | high |
| 6 | Explanations: a fleet-shortage drop was called proven impossible while lower-priority stops were served | high |
| 7 | Economics: the stated break-even used the mean saving, the decision the lowest | high |
| 8 | Explanations: the model-error signature was hidden when the second search rescued the run | medium |
| 9 | Economics: when the baseline could not be re-timed, per-stop figures included the truck's timing difference | medium |
| 10 | Explanations: an unexpected window label was flexed as a sales preference | medium |
| 11 | Explanations: the 1-second model-error threshold included model building time | low |
| 12 | Re-planning: "late after the genuine closing time" counted missed sales preferences | high |
| 13 | Re-planning: a road break was replayed differently from the engine, so a checked plan could run late with no uncertainty | high |
| 14 | Re-planning: the static policy could never serve late orders or retry left-out stops, and did not say so | medium |
| 15 | Re-planning: sub-minute "late" stops from rounding | low |
| 16 | Re-planning: re-plan counts included "nothing to plan", and stop moves were summed over re-plans | low |
| 17 | Privacy: identifying data in a test fixture (fixed) | blocker |
| 18 | Privacy: identifying data in a code comment (fixed) | blocker |
| 19 | Exact check: after an unfinished search, best-found values were still called "least cash" and "most served" | low |

### 7.4 Privacy

- An early working branch held identifying data; it was removed and the history squashed (owner follow-up recorded
  privately).
- The result files in `results/` hold the SYNTHETIC days and the two REAL requests of 15 Oct 2026. The real ones are
  anonymised: every stop is a `stop-NNN` label and every truck a `truck-NN` label, with no customer code, name,
  address, coordinate, plate or phone number. The evidence suite checks every output against the real days' ids and
  coordinates before it writes it; the real-day files were written outside the repository on the codespace, scanned
  again against every real id, code and coordinate, and only then copied into `results/`. A pattern scan of the
  report and the result files also found no code of three capitals and 3-5 digits, no database ids, no phone numbers
  and no coordinates with 4 or more decimals (in the decision-support code and tests the only matches are invented
  test values and a lint rule name). The real requests themselves never leave the codespace.
- **IVMS aggregates: no group smaller than 3.** A region driven by one or two vehicles would describe one or two
  drivers, and the repository is public. `ivms.py` publishes the speed and stop-time figures of a region only when at
  least 3 vehicles drive there (checked by a test in `test_ds_history.py`): Muscat (5 vehicles) and Nizwa (3) are
  published; 4 smaller regions are counted, not named, and their segments still count in the all-region figures. The
  same rule holds for customer segments (one segment of a single customer is counted, not published) and for vehicle
  classes (the bus, one vehicle, has no published travel factor). No figure the experiments use changed. Earlier
  versions of this branch held the small-group tables; the branch history was squashed and the temporary branch
  deleted.

---

## 8. Recommendations for NMWC

Each recommendation names its evidence: REAL (the 15 Oct 2026 requests, section 3.7) or SYNTHETIC (invented days with
invented truck costs, sections 3.2-3.6).

1. **Do not judge a plan or a rule change by one QUICK search; measure the noise at production settings.** REAL: the
   same 15 Oct request cost 500.48 to 734.12 OMR over six 20 s runs (seed spread 193.97 and 85.16 OMR), half or more
   of it from using 9 to 12 trucks (section 3.1). SYNTHETIC: 43.68 OMR at 40 s. Run 2-3 real days with THOROUGH, the
   second route search and several seeds. Until then, a re-plan that differs from the plan in use by tens of OMR, or
   by a truck, may be search luck.
2. **Compare the plan options when a day leaves stops out.** REAL (E4, the pre-fix 15 Oct request, 20 s QUICK):
   MIN_TRUCKS was cheaper than RECOMMENDED and served more stops in every seed (5.27-34.01 OMR cheaper and 1, 2 and 8
   more stops; but the mean gaps of 17.75 OMR and 3.7 stops are within this request's seed spread of 21.25 OMR and 6
   stops, and seed 3's 78-stop RECOMMENDED run gives 8 of the 11 extra stops: suggestive, not established), and
   MIN_DISTANCE served 87 stops on average against RECOMMENDED's 82. Check at production settings whether RECOMMENDED
   also leaves out stops that the other options serve on real days; why it did here is not established.
3. **When a day leaves stops out, compare one more load on a truck with hiring.** REAL (E4, one request, 20 s QUICK):
   one more load on truck-03 served more stops in every seed (+2, +1, +9; mean +4, within the request's 6-stop seed
   spread) at about the same cash (+0.29 OMR, -11.26..+8.28). It served fewer cases on average (-4), and in at least
   one seed it left out the P2 stop of 1000 cases that the base plan served. One more load on truck-01 did not gain in
   every seed. Hiring a truck served +4, +4 and +9 stops (mean +5.667, also within the spread) and more cases in every
   seed (+317..+1209), for +70.63 OMR. Neither gain is established; check what each option leaves out before choosing.
   The extra load is a company setting (shift, return and break limits unchanged). The explanation tool shows this for
   any day: whether a stop is impossible or only not found, what each change would cost in OMR, and which stops it
   would no longer serve.
4. **Record window provenance before counting on window flexibility.** REAL (E1, E4): every real window is UNKNOWN, so
   flexing it is HYPOTHETICAL; on the real day no flex changed cash by more than the noise, and on the pre-fix request
   no window change gained stops in every seed. SYNTHETIC (E1): 10-30 minutes showed no effect larger than the search
   noise (43.68 / 30.69 OMR, 5 / 3 stops). Not established either way: do not count on it or rule it out until it is
   measured on real days with THOROUGH searches, once windows are labelled.
5. **Ask customers whether they accept afternoon delivery; use it on busy days.** SYNTHETIC only (E1): on the busier
   synthetic day, delivering until 18:00 served +10.0 stops for +54.97 OMR. Not run on a real day, because acceptance
   is not recorded. It costs more cash but serves more: a capacity tool for peak days, not a saving. Night delivery
   needs the real driver cost and customer agreement first (SYNTHETIC, E1: +6.0 stops, +61.61 OMR on SYNTH-400 with
   the 10 OMR assumption).
6. **Run a measured unloading trial.** REAL and SYNTHETIC, REQUIRES EVIDENCE. At 20% faster, cash fell in every seed
   on both synthetic days and on the real day (E1, within the search noise), and on the real day it freed 489-954 paid
   driver minutes in every seed. At 39% faster, it served +7.667 stops in every seed on the real pre-fix request and
   +3.667 on the tight synthetic day (E4). The 39% is the gap between the quickest quarter of visits and the median
   visit at the same chain in the 13 Oct GPS evidence (422 visits). It mixes drop sizes, sites and waiting at the
   customer, so it is an upper bound, not what a crew can gain. Measure it on 2-3 chains before counting on it.
7. **Keep serving small orders; review only the remote ones.** REAL (E2): the 4 small stops of 15 Oct cost 0.63-0.91
   OMR each where they were, three of them within 1 km of another stop on the same load. SYNTHETIC (E2): 0.46-2.57 OMR
   near others, 14.96 OMR for the remote one. Never delete. To judge deferrals, provide margins per case and let the
   tool use tomorrow's plan.
8. **Re-plan when there is something new to place, and check what a re-plan leaves out.** SYNTHETIC (E3, 15 late
   orders): re-planning at each depot return served the late orders and as many stops as re-planning on every event,
   with 8.4 searches instead of 37.0 and 20.6 distinct stops moved instead of 32.8. REAL request, SIMULATED day (E3,
   3 worlds, no new orders): both policies served 1-3 fewer stops than the morning plan in every world, with 5.3
   fewer late stops, and re-planning at depot returns left a P1 stop out in 1 of 3 worlds; in some synthetic worlds
   too, re-planning left out a P1 or P2 stop the morning plan delivered (possibly late). A "re-plan now?" prompt at
   each depot return that shows what the re-plan would leave out would follow this; automatic triggers need the
   integrations in section 6.
9. **Start recording the missing data.** In order of value: window provenance (genuine vs preference) per customer
   (REAL, E1 and E4: without it every real window change is HYPOTHETICAL); afternoon / night acceptance; margins per
   case; measured reload times; live GPS. Each one unlocks a tool that today runs on assumptions (section 5).
10. **Fix "higher priority left out while lower priorities ride".** SYNTHETIC (E4): one P3 stop per seed was left out
    while 59-61 lower-priority stops were served, with the strict priority rule on. REAL (E4): on the pre-fix request
    a P2 stop of 1000 cases was left out in one seed while 48 lower-priority stops were served. This is already on the
    proposed list (DESIGN.md section 7).
11. **Decide whether the preferred-window prices are worth their cash.** SYNTHETIC: with them on, the engine's cash
    was 0.469 OMR above the proven minimum on average; with them off, 0.049 OMR (E5, small days; part of the gap may be
    search misses). On the tight day RECOMMENDED cost 669.40 OMR against 645.30 for MIN_DISTANCE (a different
    objective, not only the window prices), with fewer minutes past preferred windows (E4, invented truck costs). The
    prices are ARTIFICIAL; their cash effect is real.
12. **Privacy (done on this branch; one owner decision left).** The temporary branch is deleted and this branch is
    one squashed commit, so no branch shows the small-group IVMS tables (section 7.4). Old commit pages can stay
    reachable on GitHub by their id until GitHub Support purges them; whether to ask, and whether to make the
    repository private, is the owner's decision.
