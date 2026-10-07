# RouteIQ: five realistic-volume invoice tests

Revised 25 September 2026 after the clarification that NMWC handles more than 300 invoices daily. This replaces the earlier small scenario datasets. The retained GitHub progress snapshot at the end is explicitly dated; repository progress was not rechecked as part of this data-volume revision.

**The earlier datasets were too small to establish readiness for NMWC's daily volume.** They checked individual rules. These replacements contain **1,920 distinct invoices and 5,740 SKU rows** across five separate synthetic days. Every day exceeds 300 invoices.

An invoice is a distinct `sales_order_no`. One invoice normally contains two to four SKU rows. Several invoices to the same customer branch on the same day can consolidate into one delivery; an oversized delivery can split into several stops. Invoice count, spreadsheet rows, branch count, solver stops and cases are different measures.

## Scale and scenarios

| File | Distinct invoices | SKU rows | Customer branches | Cases | Scenario |
|---|---:|---:|---:|---:|---|
| S01_Orders.xlsx | 320 | 971 | 200 | 6,384 | Normal day, branch consolidation and receiving windows |
| S02_Orders.xlsx | 350 | 1,010 | 195 | 7,663 | Wholesale surge, kg-limited splitting and one invalid carton weight |
| S03_Orders.xlsx | 400 | 1,203 | 240 | 7,737 | Fleet shortage, urgent hospitals and an already-closed receiver |
| S04_Orders.xlsx | 400 | 1,198 | 230 | 7,722 | 360 morning invoices followed by 40 late invoices; two dispatched loads |
| S05_Orders.xlsx | 450 | 1,358 | 340 | 8,888 | Large intake, master-data repair, inactive customers and duplicate retry |

The files retain the canonical import columns and header on row 1. S04 retains two sheets: `Orders` has **360 invoices / 1,082 rows / 6,990 cases**; `LateOrder` has **40 invoices / 116 rows / 732 cases**. Import these in separate phases.

These are reproducible synthetic Oman-style days, not actual NMWC invoices, fleet specifications, customer coordinates, SKU weights, prices or commercial terms. Each sample is a single-depot stress scenario. Your stated 300+ invoices may be distributed across several depots in practice; no depot distribution was supplied. Truck counts and capacities are explicit assumptions in the setup, not inferred facts about NMWC.

The samples use different seeds, quantities, SKU mixes, service times, priorities and geographic clusters. Receiving windows in S01, S02 and S05 are constructed around an independently feasible schedule, so a failure to serve everything is not explained away by randomly generating an impossible day. S03 deliberately has insufficient capacity. S04 preserves explicit committed work. Locations and travel are synthetic estimates, not verified road routes.

## Expected logical behavior

### S01 — normal day at real invoice scale

Eight available trucks each hold 600 cases and 6,500 kg, with up to three loads. Deliver **all 6,384 cases** from **all 320 invoices**. Preserve every SKU line and consolidate repeated branch/day demand into 200 destinations without losing invoice identities.

The independent reference serves everything in 11 loads using eight trucks. It establishes feasibility, not minimum truck count or minimum distance. A capacity-only lower bound is four trucks; it does not account for receiving windows or time. The interval between that lower bound and the reference is where optimization quality matters.

### S02 — wholesale surge and honest kg

Ten trucks each hold 600 cases but only **4,500 kg**. The first wholesale invoice contains **1,100 cases at 12.4 kg plus 100 cases at 9.3 kg: 1,200 cases / 14,570 kg**. The verified split is:

| Part | Cases | Physical kg |
|---|---:|---:|
| 1 | 362 | 4,488.8 |
| 2 | 362 | 4,488.8 |
| 3 | 362 | 4,488.8 |
| 4 | 114 | 1,103.6 |

The final part contains 14 cases of the first SKU plus 100 of the second. Every source line must reconcile across the parts.

One separate invoice deliberately contains **one carton recorded at 4,800 kg**. It fits no truck. Leave that case visible as unserved with a weight/capacity explanation; do not silently correct or clamp it. Deliver the other **7,662 cases**. The independent reference uses 20 loads on ten trucks; the payload/trip-count lower bound is seven trucks. The solver request has 197 stops after excluding the bad carton and splitting the wholesaler.

### S03 — fleet shortage must preserve priority

Six trucks each carry at most 600 cases and can make **one load**. The fleet's case ceiling is **3,600**, while demand is 7,737. Time and kg may reduce the feasible total further. All trucks become available at 08:00 and return by 14:00.

There are 12 reachable P1 hospital branches and 24 P2 school branches. All 36 can be served together; the independent witness proves this. Another P1 receiver closes at 07:05, before any truck is available, and must be reported as `HARD_WINDOW_INFEASIBLE`.

The reference serves a priority vector **[12, 24, 35, 1, 0]** for P1 through P5, totaling 1,842 cases. This is a feasible benchmark, **not an exact service maximum**. Compare priority vectors lexicographically: higher-priority service is considered first. A different result may serve fewer cases yet satisfy priority better, or serve more cases while getting priorities wrong. Do not require the model to reproduce the reference's exact case total or route order. The old six-stop exhaustive proof does not apply to this large dataset.

### S04 — late work must respect dispatched loads

Start with the `Orders` sheet: 360 invoices and 6,990 cases. Two committed loads hold **60 invoices across 40 branches, totaling 1,104 cases**. T1 returns at 09:30 and T2 at 09:40. `frozen_state.json` includes source lines, customer snapshots, driver identities and feasible historical schedules, including intentional receiving waits.

At 09:00, add all 40 invoices from `LateOrder`, totaling 732 cases. The resulting day has 400 invoices and 7,722 cases. Six new urgent clinics close at 09:35. T1 and T2 cannot serve them because they must first return and complete **30 minutes plus 0.05 minute per next-load case** of turnaround. Other available trucks must handle those clinics.

Correct reconciliation is **1,104 frozen cases + 6,618 newly planned cases = 7,722**. The solver input contains the 190 open branch stops; frozen order rows are excluded and their truck-time reservations remain. The reference adds nine loads and uses nine physical trucks including trucks with committed loads.

Separately test the actual web/database flow: frozen instructions remain unchanged after master edits; a failed replacement does not destroy the active plan; concurrent scenario selection and replanning do not reactivate a superseded plan. A solver-only reservation check cannot prove those workflow guarantees.

### S05 — large intake and data recovery

This day has 450 invoices, 1,358 SKU rows and 340 branch destinations. Three customer codes each have two distinct branches. Keep all six branch identities separate.

Initially, three branches lack coordinates, and `TEST-NEW-SKU` has no case weight. File weights are deliberately blank so the workflow must use master weights. Intake occurs while all customers are active. Optimization without overrides must require the missing locations and, after they are repaired, the missing weight.

Use `scenario.json.location_repairs` to correct the three locations. Set the new SKU to **8.1 kg/case**. Then deactivate `S05-C05` and `S05-C250` **after intake**. Their 40 cases remain visible as `INVALID_CUSTOMER`; do not delete demand. Deliver the remaining **8,848 cases across 338 active branch stops**. The new SKU has 112 cases in the source; 108 remain active and contribute **874.8 kg** after repair.

The 338 solver stops plus depot produce a **339-node matrix**, so this case exercises more than 300 destinations as well as more than 300 invoices. The reference uses 15 loads on twelve trucks; it is not a performance measurement.

Resending `retry_orders.json`—all 1,358 lines shuffled, with lower-case customer/SKU codes—must add **zero invoices and zero cases**. `conflicting_amendment.json` changes the first source line from 9 to 14 cases under the same source identity. It must conflict instead of silently replacing history or adding demand. Also test simultaneous confirmation and planned-batch deletion using the real database.

## What has actually been checked

| Check | Result | Scope |
|---|---|---|
| Distinct invoice identities | PASS | All five exported files have the stated 320–450 unique invoice numbers. |
| Exported spreadsheet contents | PASS | All 5,740 source rows and every canonical input cell were read back and compared, including dates, numeric cells and intended blank weights. |
| Demand conservation | PASS | Every source line reconciles across solver portions, frozen demand and explicit web pre-drops. |
| Current intake and split functions | PASS | The actual source functions at commit `577db7afeea5fda1388c24269f6a196e62b3fa4d` processed all five large datasets; all active split case/kg demands matched. |
| Retry and quantity conflict | PASS | Pure intake validation rejected duplicate demand across 1,358 rows and identified the changed quantity. Database concurrency was not exercised. |
| Request schemas and matrices | PASS | All five current Pydantic schemas validated and matrices matched the current Haversine provider. |
| Feasible reference plans | PASS | Independent construction plus actual pure timing validation and output formatting; no route search. |
| Checker calibration | PASS | Four deliberately corrupted outputs were detected: duplicate stop, changed kg, invalid frozen turnaround and missing urgent service. |
| Workbook layout | PASS | Beginning and ending rows of every sheet were rendered and reviewed; import columns and tab names were retained. |
| Actual optimizer on these large days | **NOT RUN / BLOCKED** | Required solver dependencies, including OR-Tools, are unavailable in this environment. No large-day runtime, optimizer success rate, or production readiness is claimed. |

The evidence folder records these checks. It contains **zero full solver runs**. Reference schedules and source-function checks must not be presented as optimizer-produced answers. The previously inspected 834-test GitHub CI result belongs to the dated repository snapshot below; these new files were not part of that CI run.

## Run the real test

Give the coding agent the **whole ZIP** and `PROMPT_FOR_CODING_AGENT.txt`. Excel order uploads alone do not configure trucks, locations, receiving windows or frozen state. Use `master_data.json`, `web_setup.json` and the scenario steps in an isolated test environment. Preserve both the initial and after-repair master states for S05.

From the extracted pack, inside the working RouteIQ solver environment:

```bash
python run_routeiq_samples.py --repo /path/to/routeiq --repeat 3 --budget-seconds 540 --out results
```

The runner invokes the actual installed `optimize_dispatch`, including OR-Tools and repacking. It substitutes only the fixed distance matrix, makes no HTTP calls, and writes no production data. Each request asks for `RECOMMENDED`, `MIN_TRUCKS` and `MIN_DISTANCE`, with the application's automatic size-based search time limits. The request budget defaults to 540 seconds. Fifteen requests can yield 45 scenario outputs; record actual runtimes, warnings and failures. An application budget is not a guarantee that every end-to-end request completes before it.

The fixed-matrix run measures solver behavior, not OSRM latency or network performance. Test matrix retrieval and the web/database path separately before accepting production readiness. No performance SLA was provided; report measured latency and completion rate rather than inventing a pass threshold.

To validate a saved response:

```bash
python validate_result.py S03 results/S03_trial1_response.json
```

The independent validator checks source portion identity, served/unserved stop reconciliation, truthful cases and kg, travel sequence, service duration, service-start hard windows, availability, depot hours, reload/loading, trip limits, frozen reservations, shift span and known feasible service. Hard windows follow the handbook's **service-start** rule. Preferred windows are soft. P1 is highest. Money is OMR and all times are minutes from midnight in `Asia/Muscat` unless a reference explicitly uses seconds.

The API reports rounded minutes, so the checker uses 61 seconds of tolerance. Inspect exact internal seconds for production acceptance. This tolerance is not permission to violate a deadline. The validator does not prove global optimality, verify all monetary policy choices, or test web transactions. Preserve raw responses and compare cost components with persisted summaries and exports separately.

For S01, S02, S04 and S05, the checker expects all serviceable open demand. For S03 it expects all reachable P1/P2 branches and a priority vector at least as good as the feasible reference. For MIN_TRUCKS, the reference truck count is an upper bound. It is not a proven minimum. A result may fail quality while still respecting every physical constraint; report those categories separately.

## Pack contents

Each scenario folder includes the Excel file, source orders, master data, setup settings, scenario steps, normalized solver request, fixed matrix, source portion map, expected checks, and a feasible reference schedule. S04 adds frozen snapshots; S05 adds retry and amendment inputs.

`reference_solution.json` and `reference_formatted_NOT_SOLVER_RESULT.json` are **answer-key evidence only**. Save raw real-solver results before inspecting these references. The latter only formats the independent reference using RouteIQ's source code; it did not run the optimizer.

`scenario_index.json` is the machine-readable count summary. `checksums.json` identifies the packaged inputs. `generate_large_fixtures.py` and `fixture_common.py` reproduce the JSON fixtures with standard Python; generating JSON does not regenerate the Excel files. `run_routeiq_samples.py` and `validate_result.py` are the evaluation tools. Keep fixtures unchanged when comparing commits.

## Earlier GitHub progress snapshot — retained for continuity

The following snapshot was checked on 25 September 2026 at approximately 19:53 Oman time. It is not a new progress check for this revision.

### What was merged at that check


| Batch | GitHub evidence | What changed |
|---|---|---|
| Security | [PR #32](https://github.com/rahmanmansoori244-droid/routeiq/pull/32), merged 18:15 Oman time | Session revalidation, safe login callbacks, no public SUPER_ADMIN creation, API role checks, PIN-hash redaction, retirement of the driver phone APIs, login throttling, reset-token handling and removal of the public OSRM default. |
| Demand and intake | [PR #33](https://github.com/rahmanmansoori244-droid/routeiq/pull/33), merged 18:23 Oman time | Truthful split kg, master-weight resolution, missing-weight prompt, durable intake-line identity and confirmation locking, duplicate/amendment checks, and protection against deletion of planned demand. |

The latest [main-branch CI run](https://github.com/rahmanmansoori244-droid/routeiq/actions/runs/36147186139) passed **119 solver + 566 web unit + 149 integration tests = 834 tests**. TypeScript, lint, migration application and production build passed too. I inspected the actual logs. The earlier reviewed commit had 522 tests, so this is an increase of 312 tests. More tests are useful evidence of broader coverage, not proof of correctness by themselves.

I retrieved and hash-verified all 418 tracked files at this commit. This progress review focused on the repairs and remaining high-impact paths; it is not a second complete security audit of every changed line.

### Current disposition of the original findings

| Original findings | Current assessment |
|---|---|
| F01, F02, F05: weight and duplicate intake | Addressed in the merged implementation. My new source-function checks confirm truthful split weight, recalculation of missing master-derived weight, duplicate rejection and quantity-conflict detection. Fresh real-database race testing was not run here; the new integration tests passed in CI. |
| F09–F15: sessions, signup, callback, driver scope/hashes, read-role gaps | Substantially addressed in PR #32. Legacy driver endpoints were retired rather than expanded. I additionally exercised the actual safe-callback and principal-decision helpers. Authentication transport, deployment and cache behavior were not independently exercised here. |
| F20: planned-batch deletion/history | The merged code adds transactional deletion guards, missing-scope checks and a non-cascading unserved-order relation. CI includes added integration coverage. |
| F22: public OSRM default | Removed in the merged source. Production routing configuration was not inspected. |
| F16: throttling | Partially addressed: credential login is protected; shared solve-admission limits remain later work. |
| F03, F06, F07, F08: replacement, concurrency, frozen snapshots | Still outstanding in merged code. In particular, `replan` still creates/supersedes before child solve success, and `applyScenario` still lacks the common row lock before its final READY write. Frozen details still use current master records. |
| F04: final feasibility gate | Still outstanding. The isolated timing-fallback reproduction still returns an invalid exact timetable as OPTIMIZED with a warning. |
| F17: cost consistency | Still reproducible against current pure solver functions. |
| F18: estimated routing provenance/scaling | Still reproducible against current provider functions. |
| F19: matrix deadline | Matrix construction still has serial work without an aggregate request deadline. The 301-node synthetic call count remains 49. |
| F21, F23: effective settings and audit filtering | Not addressed by the first two batches; current handbook still records these leads. |

Two details deserve clear acceptance criteria. First, the missing-weight change deliberately permits an explicit **optimize anyway with 0 kg** override. This is an owner-approved workflow in the PR, not an accidental disappearance of the warning. A plan using that override must not be described as verified for physical payload. Second, session refresh normally uses a 30-second cache, but the code permits a cached principal up to ten minutes old during a database error. “Revoked within 30 seconds” therefore needs that outage exception stated.

PR #33 reports a real 80-order day served on five trucks and 14 loads. That is the developer's reported result; I did not rerun that private day or independently verify the live deployment, migrations, backups, or production records.

