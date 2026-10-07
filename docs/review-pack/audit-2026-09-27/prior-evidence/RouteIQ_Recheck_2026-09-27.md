# RouteIQ — independent follow-up review

Reviewed 27 September 2026. Current main: [`83d8174836deb339d54f90e65b803550ed34c20d`](https://github.com/rahmanmansoori244-droid/routeiq/commit/83d8174836deb339d54f90e65b803550ed34c20d). Compared with the previous review at `577db7a`; original finding numbers refer to the review at `e29578e`.

## My assessment

RouteIQ is substantially stronger than the version first reviewed. The recent work addresses the underlying causes of several serious failures: plan replacement, concurrent mutations, dispatch feasibility, frozen data, cost reconciliation, intake accounting and same-day scheduling. This is meaningful stabilization work, supported by a much larger passing test suite.

I would support a supervised NMWC pilot with independent payload and timing checks. I would not yet sign off on the application as the sole authority for a full dispatch day. Four remaining code defects were confirmed in this follow-up, and a deliberate payload policy needs an operational decision. The repository also does not yet provide complete, repeatable end-to-end results for all five large synthetic days on this final commit.

The distinction matters: valid case totals, physically feasible routes, correct manifests, sensible cost choices and reliable operation at 300+ invoices are separate acceptance questions. Passing one does not establish the others.

## What was actually checked

- Retrieved all 488 tracked files at the pinned commit and verified every file against its Git blob hash. This was a targeted re-review of the seven merged PRs and the earlier risk areas, not a claim that every line received equal scrutiny.
- Read the handbook's reviewer guidance and unconfirmed leads, current implementation and relevant tests.
- Inspected the actual latest GitHub CI logs, rather than relying only on the README's counts.
- Executed current TypeScript intake, splitting, reconciliation and security decision functions against the five large synthetic datasets.
- Executed focused current-source reproductions for navigation snapshots, weight manifests, capacity policy and scheduling time. Persistence-dependent probes used the repository's fake database; no production data was used.
- Executed pure Python solver/costing/timing/provider checks. OR-Tools, httpx and pytest were unavailable locally: import stubs and synthetic responses were used where explicitly described. The overtime probe evaluated the exact source constraint through a numeric recorder, not a CP-SAT search.

No repository files were changed, no commits were made, and no production application, database, migration or deployment action was performed. Live deployment health and production configuration were not verified.

### Current progress and CI

Seven PRs merged after the previous checkpoint: [#34](https://github.com/rahmanmansoori244-droid/routeiq/pull/34), [#35](https://github.com/rahmanmansoori244-droid/routeiq/pull/35), [#37](https://github.com/rahmanmansoori244-droid/routeiq/pull/37), [#36](https://github.com/rahmanmansoori244-droid/routeiq/pull/36), [#38](https://github.com/rahmanmansoori244-droid/routeiq/pull/38), [#40](https://github.com/rahmanmansoori244-droid/routeiq/pull/40), and [#39](https://github.com/rahmanmansoori244-droid/routeiq/pull/39).

The final merge occurred at **12:09 Oman time on 27 September**. [CI run 36305317310](https://github.com/rahmanmansoori244-droid/routeiq/actions/runs/36305317310) completed successfully at **12:21 Oman time**, shortly before your message. Main was checked again at the end of this review and remained on the same commit.

| Current CI suite | Passed |
|---|---:|
| Solver | 213 |
| Web unit tests, 60 files | 1,056 |
| Web integration tests, 23 files | 197 |
| **Total** | **1,466** |

The web job also passed migration setup, type checking, lint and build. These are GitHub results I inspected, not a claim that I reran the full suite locally. Some integration tests use a fake optimizer. The normal CI run does not execute the complete five-day large-scenario acceptance exercise.

## What has improved

| Area | Current assessment |
|---|---|
| Failed replanning, F03 | Refusals are checked before destructive transitions; child versions retain a usable copy of loads, selected scenario and accounting when optimization fails. |
| Concurrent plan creation/application, F06/F07 | Depot/day advisory locks, plan-row locks, current-job checks and transactional finalization address the original races. Real PostgreSQL concurrency was not rerun locally. |
| Solver admission, F16 | Shared admission now covers main solve entry points and releases reservations on refusal and completion. Deployment remains designed around one web replica. |
| Dispatch timing, F04 | Exact feasibility is checked before operational transitions. A reproduced departure 20 minutes too early is now rejected. |
| Frozen data, F08 | Truck rules and customer stop coordinates/windows are captured and carried forward. Depot origin retention remains incomplete; see R1. |
| Cost reconciliation, F17 | Whole-day driver costs and displayed load totals now agree in the checked case: 190 minutes produced 19 OMR driver cost plus 8.667 OMR overtime. Search still has the separate objective mismatch in R3. |
| Routing estimates and deadline, F18/F19 | Estimated legs retain the correct label and avoid a second time multiplier. A simulated slow matrix response respected the short test deadline and returned labelled fallback. |
| Large-day intake/reporting | Invoice count is separated from consolidated branch orders; duplicate retries preserve totals; physical truck counts include frozen trucks. Multiple order sheets are explicitly refused rather than silently dropping one. |
| Same-day planning | New work starts from the planning time plus preparation and loading. A 09:00 plan with 30-minute preparation and 100 cases at one minute/case correctly requires 11:10 departure. |
| Recommendation explanation | The interface exposes the tradeoff between money and preferred delivery timing. A more expensive RECOMMENDED option is not automatically a bug. |

Earlier security/intake repairs remain in the current source. This follow-up did not repeat the entire original authentication, tenant-isolation and browser assessment. Pure checks did verify callback rejection and session-principal revocation decisions; they do not replace integration/security testing.

## Confirmed remaining code defects

All four findings below are medium severity under the reproduced conditions. Priority within the group reflects NMWC's operational use. None requires assuming that the whole optimizer returned a result it was not observed to return.

### R1 — Correcting the depot changes a dispatched load's navigation after replanning

**Failure:** A dispatched load originally starts and returns at depot coordinates `23.58, 58.39`. The depot pin is corrected to `23.65, 58.50`; a child plan is created and a new scenario applied. The carried dispatched load's row remains unchanged, but its navigation link now starts and returns at the corrected coordinates. There is no change warning.

**Cause:** [plan-detail.ts:265–267](https://github.com/rahmanmansoori244-droid/routeiq/blob/83d8174836deb339d54f90e65b803550ed34c20d/apps/web/lib/dispatch/plan-detail.ts#L265-L267) chooses one depot from the child scenario's input snapshot. Carried loads have no independent retained depot origin. That shared depot feeds the [map route geometry](https://github.com/rahmanmansoori244-droid/routeiq/blob/83d8174836deb339d54f90e65b803550ed34c20d/apps/web/app/api/runs/%5Bid%5D/load-geometry/route.ts#L34-L53), driver PDF route links and WhatsApp route links.

**Evidence:** Actual `createNextVersion`, `persistDispatchResult`, `applyScenario`, `getPlanDetail` and `routeLinks`, with repository fake persistence and a synthetic solver response. Parent became SUPERSEDED, child READY, carried load remained DISPATCHED and byte-unchanged; the route URL changed.

**Fix:** Store the planned depot coordinates per load and carry them forward. All geometry and driver-link consumers should use that origin. Newly planned loads can use a corrected depot. For older carried loads, recover the origin from their ancestor scenario inputs when available.

**Regression:** Correct the depot between versions; assert that a carried dispatched load keeps its navigation origin/destination and that new loads use the corrected origin.

### R2 — A split replan can print stale SKU weights in its loading manifest

**Failure:** A 40-case order starts at 10 kg/case. Twenty cases are locked at 200 kg. The product is corrected to 15 kg/case and the remaining 20 cases are replanned. The new load and stop correctly report **300 kg**, but the SKU manifest reports **200 kg**. The frozen half stays at 200 kg, and no warning appears.

**Cause:** [plan-service.ts:301–318](https://github.com/rahmanmansoori244-droid/routeiq/blob/83d8174836deb339d54f90e65b803550ed34c20d/apps/web/lib/dispatch/plan-service.ts#L301-L318) deliberately preserves shared order lines used by the frozen part, while the open portion uses the corrected product weight. However, [split.ts:265–271](https://github.com/rahmanmansoori244-droid/routeiq/blob/83d8174836deb339d54f90e65b803550ed34c20d/apps/web/lib/dispatch/split.ts#L265-L271) ignores the portion's captured `kgPerCase` and prorates the old shared line weight. [plan-detail.ts:278–282](https://github.com/rahmanmansoori244-droid/routeiq/blob/83d8174836deb339d54f90e65b803550ed34c20d/apps/web/lib/dispatch/plan-detail.ts#L278-L282) and [workbook.ts:649–657](https://github.com/rahmanmansoori244-droid/routeiq/blob/83d8174836deb339d54f90e65b803550ed34c20d/apps/web/lib/dispatch/workbook.ts#L649-L657) expose the mismatch.

**Evidence:** Actual current detail rendering on synthetic rows representing the source-verified partial-replan state. The new portion returned load/stop/manifest totals of `300 / 300 / 200 kg`, with a VERIFIED feasibility result. This was not a complete database/optimizer execution.

**Fix:** Calculate portion SKU weights from their persisted per-line weights, with an explicit legacy fallback. Check that SKU, stop and load totals reconcile within rounding tolerance. Do not overwrite shared frozen-order lines simply to make the numbers agree.

**Regression:** Freeze one half at the old weight, replan the other at a new weight and assert both manifests, stops and load totals remain consistent independently.

### R3 — The repack objective charges already-paid frozen overtime again

**Failure:** Truck A has frozen work from 06:00 to 10:00. Overtime begins after one hour at 4 OMR/hour. Adding a load from 10:00 to 10:30 costs **2 OMR incrementally**. A fresh truck B costs 3 OMR. Correct final costing prefers A, but the repack overtime expression charges A for **210 minutes**, rather than the additional 30 minutes.

**Cause:** [load_repack.py:619–626](https://github.com/rahmanmansoori244-droid/routeiq/blob/83d8174836deb339d54f90e65b803550ed34c20d/apps/solver/load_repack.py#L619-L626) calculates overtime from the original frozen shift anchor. The related [route-search soft bound](https://github.com/rahmanmansoori244-droid/routeiq/blob/83d8174836deb339d54f90e65b803550ed34c20d/apps/solver/dispatch_solver.py#L767-L769) also needs alignment. [costing.py:139–143](https://github.com/rahmanmansoori244-droid/routeiq/blob/83d8174836deb339d54f90e65b803550ed34c20d/apps/solver/costing.py#L139-L143) correctly charges only the incremental interval.

**Impact:** Candidate search has an incentive to use a more expensive fresh truck. This is an optimization-quality inconsistency, not evidence that the displayed final price is wrong or that routes violate capacity. The complete search was not run, so this review does not claim it actually returned B.

**Fix:** Use the later of `shift_anchor + overtime_threshold` and `last_frozen_return` as the incremental overtime baseline for frozen trucks, and align both search stages with final costing.

**Regression:** Compare an already-overtime frozen truck with a fresh alternative and assert that the objective's incremental money agrees with the independent cost calculation.

### R4 — The Excel parsing timeout cannot interrupt synchronous parsing

**Failure:** A slow synchronous Excel parse completes before the timeout is installed. Large or difficult workbooks can therefore tie up the application worker despite the apparent timeout.

**Cause:** [csv.ts:82–86](https://github.com/rahmanmansoori244-droid/routeiq/blob/83d8174836deb339d54f90e65b803550ed34c20d/apps/web/lib/csv.ts#L82-L86) evaluates `parseExcelSheets` before passing its result into `withTimeout`. [Lines 148–158](https://github.com/rahmanmansoori244-droid/routeiq/blob/83d8174836deb339d54f90e65b803550ed34c20d/apps/web/lib/csv.ts#L148-L158) also materialize all sheets before the selected-sheet row limit. The compressed file-size limit does not bound expanded workbook work.

**Evidence:** A bounded test of actual `parseUpload` used a 40 ms synchronous parser stub and a timer hook scaling the limit to 10 ms. The timer was not armed when parsing started, and the upload was accepted after 41.1 ms. No malicious workbook or production attack was used. This pattern predates these latest PRs.

**Fix:** Parse in a disposable worker/process with enforceable termination and expanded-size/cell bounds. Another Promise wrapper does not make synchronous work interruptible.

**Regression:** Verify that an intentionally slow parser is terminated, that a concurrent ordinary request remains responsive and that failure leaves no partially accepted upload.

## Operational policies and known limitations

These are separate from the four defects above: the handbook explicitly documents the behavior.

### Payload corrections currently warn rather than block

The actual gate accepted a **6,000 kg locked load** whose original truck snapshot allowed 10,000 kg, after the live truck payload was corrected to **3,000 kg**. It returned `ok: true`, `VERIFIED`, with `CAPACITY_CHANGED: WARN`.

[feasibility.ts:255–263](https://github.com/rahmanmansoori244-droid/routeiq/blob/83d8174836deb339d54f90e65b803550ed34c20d/apps/web/lib/dispatch/feasibility.ts#L255-L263) and [handbook line 904](https://github.com/rahmanmansoori244-droid/routeiq/blob/83d8174836deb339d54f90e65b803550ed34c20d/docs/PROJECT_HANDBOOK.md#L904) make this deliberate. Original-snapshot overload and newly supplied previously unknown product-weight overload were correctly blocked in control cases.

For NMWC, I recommend preserving the historical snapshot while blocking a not-yet-departed load that exceeds newly established physical capacity. Until that policy is resolved, a green feasibility result must not replace a real payload check. This is the highest operational priority in this report, despite being intentional behavior.

### Same-day time can become stale in the queue

The planning clock is captured before the job waits for admission. It is not refreshed when queued work starts or when the result is later used. In a pure-function check, a plan made at 09:00, leaving at 09:35 for a 09:45 deadline, still passed the gate when checked at 10:00. The later time affected `checkedAt`, not schedule validity.

This is a documented limitation, not a newly introduced regression, and the test did not simulate a real hour-long queue. Refresh the planning origin at execution and flag or retime elapsed new departures before operational use, preserving frozen movements. See [dispatch-job.ts:67–80](https://github.com/rahmanmansoori244-droid/routeiq/blob/83d8174836deb339d54f90e65b803550ed34c20d/apps/web/lib/jobs/dispatch-job.ts#L67-L80).

### Superseded plans still have weight-history inconsistency

A successful reweight can update shared order data used by an older version. Actual current weight-update/detail functions reproduced an old plan changing from load/stop/manifest `400 / 400 / 400 kg` to `400 / 600 / 600 kg`. An older split assignment retained its stop weight, but its manifest still changed. The [handbook explicitly acknowledges this at line 755](https://github.com/rahmanmansoori244-droid/routeiq/blob/83d8174836deb339d54f90e65b803550ed34c20d/docs/PROJECT_HANDBOOK.md#L755).

For trustworthy historical exports, capture assignment and line weights at application time and read those snapshots in older versions. This is related to R2, but R2 affects a current loading manifest and should be prioritized first.

### NMWC calibration remains necessary

The handbook still identifies estimated product weights and uncalibrated truck capacities, receiving windows and handling times. It records a default 06:00 departure against observed NMWC departures around 07:10–08:00, and observed truck cycles around 52% longer than model assumptions. Those are documented observations, not measurements independently collected in this review.

The model currently enforces cases and kilograms, not pallet positions or volume. Road-time multipliers, traffic assumptions and actual loading/service durations also need calibration. A logically consistent result can still be operationally wrong when these inputs do not represent the fleet and customers.

## What the larger tests prove

The five generated datasets are appropriate in invoice volume for NMWC's stated 300+ daily invoices. They contain multiple invoices per branch, so invoice count is not equal to routing-stop count.

| Scenario | Invoices | SKU rows | Cases | Distinct branches |
|---|---:|---:|---:|---:|
| S01 | 320 | 971 | 6,384 | 200 |
| S02 | 350 | 1,010 | 7,663 | 195 |
| S03 | 400 | 1,203 | 7,737 | 240 |
| S04 | 400 | 1,198 | 7,722 | 230 |
| S05 | 450 | 1,358 | 8,888 | 340 |
| **Total** | **1,920** | **5,740** | **38,394** | — |

Current-source intake/splitting checks passed for all five datasets. Across 22 passing checks, evidence includes case reconciliation, 1,165 active split portions, invoice counts, duplicate retry adding zero cases, conflicting amendments being rejected, and the deliberately overweight S02 carton retaining its actual 4,800 kg. The same probe also confirmed R4, separately from those 22 passing checks.

These checks do **not** establish that the full routing engine found the best plan for each day. No full five-day optimizer run occurred locally in this follow-up.

### Published performance evidence

The repository reports a historical PR5 benchmark serving **300 stops in 251 seconds**, using 12 trucks and 24 loads. RECOMMENDED reported 1,806.5 km and 965.2 OMR; the alternatives reported 1,738.9 km and 947.1 OMR. That benchmark used **Haversine and no kg dimension**. It is evidence of search scale, not proof of a weighted NMWC road-routing day. See [OPTIMIZER_BENCHMARK.md:349–372](https://github.com/rahmanmansoori244-droid/routeiq/blob/83d8174836deb339d54f90e65b803550ed34c20d/docs/OPTIMIZER_BENCHMARK.md#L349-L372).

The handbook describes historical S01–S05 runs and follow-up fixes. However:

- No complete tracked table of final-commit S01–S05 results or sanitized raw responses was found in the 488-file tree.
- [Handbook line 2635](https://github.com/rahmanmansoori244-droid/routeiq/blob/83d8174836deb339d54f90e65b803550ed34c20d/docs/PROJECT_HANDBOOK.md#L2635) leaves repeated S01/S03/S04c measurements open.
- S03 historically varied from 317.7 to 377.3 km at the same search budget. That calls for repeatability evidence; it does not by itself prove an invalid route.
- PR8 changes the valid timing for S04 late orders. Results produced before that change cannot validate its corrected behavior.
- S04's original two-order-sheet workbook must now be supplied as separate morning and late-order uploads. The new refusal is intentional and prevents silent data loss.

The honest answer to “does it give correct logical answers?” is: **many important invariants now have convincing checks, but final-commit large-day routing quality and operational accuracy are not yet fully demonstrated.**

## Recommended next work

1. Resolve the payload-correction policy before treating VERIFIED as a physical loading safeguard. Fix R2's current manifest inconsistency and R1's depot origin retention.
2. Fix R3's incremental overtime objective and R4's enforceable parsing boundary. Add focused regression tests for the reproduced conditions.
3. Run all five large days through the actual application at the final release commit, including confirmation, optimization, option selection, freezing, late upload, replan and export. Run each three times; split S04 uploads by phase. Record runtime, served/unserved quantities, explicit unserved reasons, physical trucks, loads, kg, distance, cost, time-window violations and reconciliation.
4. Save sanitized requests, responses and independent checker output as CI or release artifacts. Compare S03 against one higher-budget run so variation has an understandable reference. Do not require identical routes or claim global optimality.
5. Run a supervised five-day NMWC comparison using actual invoices, verified product weights and fleet limits. Compare planned versus actual departure, return, service time, loading time, distance and unserved reasons. Investigate systematic errors before accepting the planner as the normal dispatch authority.

Minimum acceptance is zero lost/duplicated cases, zero unexplained unserved demand, zero hard capacity/window/turnaround violations, stable frozen instructions, matching manifests, and a runtime and route quality NMWC considers usable. The permitted monetary tradeoff for earlier delivery is an owner decision that should be visible and measurable.

## Evidence package

`RouteIQ_Recheck_Evidence_2026-09-27.zip` includes the bounded reproduction scripts, JSON outputs, source verification, sanitized CI excerpts and scope notes. It excludes the repository clone and production data. Synthetic inputs required by the large-intake probe are included; obtain the pinned repository separately. The package README explains layout, prerequisites and the hard-coded paths in a few raw probes.

This review establishes concrete remaining defects and meaningful improvements. It is not a certification of the production deployment, an exhaustive security audit or a proof of global route optimality.
