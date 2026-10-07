# Bounded final coverage pass: dispatch core helpers

Commit `83d8174836deb339d54f90e65b803550ed34c20d`.

All five files below were read completely. This pass established **no additional distinct production-reachable bug** beyond the findings already reported. It does not certify all inputs or paths.

| Actual filename | Review performed | Result |
|---|---|---|
| `apps/web/lib/dispatch/customer-attrs.ts` | Effective attribute precedence, coordinate validation/status, issue generation, service area/provider choice, priority weights. | Customer vs type vs company priority/service precedence matches documented behavior. Setting any customer window intentionally overrides the four-window group; this is explicit in handbook line665 and existing tests, so not counted as a new bug. A product/business improvement could make that override clearer, but current source matches its spec. |
| `apps/web/lib/dispatch/reconcile.ts` | Expected order identity, duplicate whole orders, split per-line conservation, customer/branch identity, missing reason checks, SKU/invoice totals, aggregation. | Synthetic tests reject wrong branch, equal-and-opposite cross-line corruption, unknown line, duplicate whole order, removed expected order and empty unserved reason. `ordersWithoutSo` comment describes orders, but workbook line343 correctly labels its output as customer branches; not treated as an observable counting defect. |
| `apps/web/lib/dispatch/weights.ts` | Unknown/file/master weights, completeness handling, proportional legacy interpretation, frozen-order protection and update arithmetic. | Targeted checks preserve frozen orders and explicit file weights, update only eligible master-derived open lines, and resolve partly known file kg using a complete master basis. Historical/split manifest drift remains the previously reported cross-module issue, not a new finding. |
| `apps/web/lib/dispatch/split.ts` | Part capacity, whole-case loop termination, case/weight accounting and rounding, portion money, portion IDs/maps and readers. | 200 deterministic randomized cases preserve every input line's quantity, positive integer portions, capacity except visible indivisible overweight cases, and exact part-level rounded kg sum. SKU-based portion-money calculation and null-money preservation checked. `rowLines` snapshot-weight issue is already known. |
| `apps/web/lib/dispatch/service-time.ts` | Base service, proportional split share, per-case time, rounding, maximum. | Basic arithmetic and cap flag checked. The 480-minute cap, warning behavior and base-time allocation are documented and already called out in prior review, so not recounted as new. |

Supporting reads: relevant `plan-service.ts` caller sections, handbook effective-window and service-time rules, `workbook.ts` no-SO label, related helper tests, and prior reviews to avoid duplicate findings.

Evidence: `probe-core-helpers.mjs`, `probe-core-helper-results.json`.

Execution: Node 24.19.0 imports and executes the actual current pure TypeScript modules using type stripping. Eleven grouped checks passed, including 200 generated split cases (seed 20260927). No database, framework or optimizer mock was required for those functions. This does not constitute a full solver run, integration suite, or proof of optimality. No repository edits or production actions occurred.
