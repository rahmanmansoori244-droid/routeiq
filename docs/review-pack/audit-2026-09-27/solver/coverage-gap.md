# Final web/solver contract pass

Pinned source: `83d8174836deb339d54f90e65b803550ed34c20d`.

Read all 1,547 lines across these six helpers:

| File | Lines | Comparison performed |
|---|---:|---|
| `apps/web/lib/dispatch/costs.ts` | 236 | Python costing, load cost fields, legacy labels, totals and paid-minute aggregation |
| `apps/web/lib/dispatch/feasibility.ts` | 438 | Python feasibility, same-day preparation, frozen/on-road rules, capacities, report merging and status |
| `apps/web/lib/dispatch/feasibility-view.ts` | 98 | Per-truck gate and remedy semantics |
| `apps/web/lib/dispatch/summary.ts` | 289 | Cases/order status, partial-order money, costs, truck counts and version change summaries |
| `apps/web/lib/dispatch/planner-config.ts` | 276 | Python contract bounds/defaults, constant settings and automatic time schedule |
| `apps/web/lib/dispatch/plan-options.ts` | 210 | Python scenario goals, preference cost, feasibility-sensitive recommendations and physical trucks |

Also read the relevant producer/consumer paths in `plan-detail.ts` (option mapping and returned fields), `plan-service.ts` (feasibility inputs, fresh gate computation and summary construction), and the exact UI/workbook trade-off rendering lines. Existing policy risks, historical cost/weight findings and the prior integer-kg finding were not recounted as new discoveries.

## New confirmed medium finding — Infeasible options receive positive trade-off recommendations

Source locations:

- `apps/web/lib/dispatch/plan-detail.ts:484–496`, specifically line 486: an option is `usable` when its status is `OPTIMIZED` and its load array exists. Its `feasibility.status` is ignored.
- `apps/web/lib/dispatch/plan-options.ts:170–207`: all usable options enter comparisons, and the recommendation is compared with the cheapest different option.
- `apps/web/app/t/[slug]/dispatch/plan-view.tsx:649–650` and `apps/web/lib/dispatch/workbook.ts:436–437`: the resulting text appears directly in the app and workbook.
- In contrast, `apps/solver/dispatch_solver.py:1505–1516` explicitly excludes alternatives without a `VERIFIED` feasibility result when advertising more stops served. `docs/OPTIMIZER_DESIGN.md:85–88` says a plan that is not VERIFIED is never advertised as serving more.

Failure scenario: a valid recommendation serves one fewer order than a raw alternative whose timing breaks turnaround. That alternative is 20 OMR cheaper on paper. Although its stored feasibility is `VIOLATED`, the app's trade-off helper emits:

> vs RECOMMENDED: 1 more order served, 20.0 OMR cheaper

The valid recommendation is itself framed as having "no gain" and costing more compared with that infeasible plan. The separate timing status still indicates a violation, and the dispatch gate still blocks the bad truck day. This is misleading decision support, **not a dispatch-gate bypass**.

Proof: `options_feasibility_check.mjs` imports the actual `optionTradeoffs` helper and extracts/executes the actual usability expression from pinned `plan-detail.ts`. It passes an `OPTIMIZED` alternative explicitly marked `VIOLATED`; both problematic strings are reproduced. A control with that alternative excluded suppresses the comparison. Evidence is in `options_feasibility_check.json`. No database, browser or optimizer execution is claimed.

Fix: retain infeasible options for inspection if desired, but require a VERIFIED timetable for positive service/cost recommendations and selection as the recommendation's reference option. Show an explicit "not comparable until timing is valid" explanation for violated/unverified/legacy options, according to the chosen compatibility policy. Add a test covering a cheaper VIOLATED alternative with more orders, in both app data and workbook.

## No additional confirmed defect in the other five helpers

The pass found no further concrete new mismatch worth promoting in costs, feasibility-view, summary or planner-config beyond known findings/policies. Specific distinctions retained:

- Lowered live payload is deliberately warning-only; known operational policy risk.
- Missing old solver reports permit structural-only checking; documented compatibility policy.
- The web gate's 0.5 kg allowance differs from Python's 0.05 kg because persisted stop/portion weights are rounded; documented, not automatically a defect.
- On-road violations are historical warnings while new-load turnaround issues block; deliberate design.
- The gate recomputes fresh facts for state transitions. `inputHash` is not used as a cache authorization shortcut.
- Whole-day driver costs are summed from solver-supplied load shares rather than independently repriced; frozen cost consistency concerns remain as previously reported.
- Early-arrival settings wording omits the documented preferred-window-end exception; this is a clarity improvement, not a new algorithmic discovery.

This was a bounded source review and one executed pure-helper reproduction. It does not certify every possible behavior or imply a complete optimizer/database/browser suite ran.
