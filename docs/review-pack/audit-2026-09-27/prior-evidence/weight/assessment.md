# Weight snapshot review — 83d8174836deb339d54f90e65b803550ed34c20d

Two related inconsistencies are confirmed. The first is a live-plan output bug; the second is an explicitly documented historical consistency gap, not a newly discovered regression in version control.

## W1 — Live split replan prints stale SKU/manifest weights (medium)

**Failure scenario:** A 40-case order is originally 10 kg/case. Twenty cases are locked, so those 200 kg must remain frozen. The product is corrected to 15 kg/case and the remaining 20 cases are successfully replanned. The new portion correctly stores 300 kg and `kgPerCase: 15`. Shared OrderLine remains at 400 kg for 40 cases, deliberately protecting the locked half. The new plan detail reports the new load as 300 kg and its stop as 300 kg, but its SKU manifest as **200 kg**, with no warning and a VERIFIED feasibility result. Frozen half remains 200/200/200 kg.

**Code:**
- `apps/web/lib/dispatch/plan-service.ts:301–318`: partial-frozen orders do not add shared-line changes, while open lines take the current product weights.
- `apps/web/lib/dispatch/split.ts:265–271`: `rowLines` only selects portion case counts and prorates the live shared line weight; it discards the portion's captured `kgPerCase`.
- `apps/web/lib/dispatch/plan-detail.ts:278–282`: uses `rowLines` for SKU kg and separately uses stored `portionWeightKg` for stop kg; line385 aggregates those incorrect SKU weights into the manifest.
- `apps/web/lib/dispatch/workbook.ts:649,657`: prints those manifest kilograms and their sum. `kgCheck` at59–63 only compares stop kg with load kg, so the live partial case can evade that check.

**Evidence:** `probe.mjs` invokes actual `getPlanDetail` on the repository's fake Prisma with synthetic rows representing this documented partial-replan state; `results.json`, probe `live_partial_frozen_replan_manifest_uses_old_line_weight`: frozen 200/200/200; new 300/300/200; warnings empty. This is a read-path reproduction plus source verification of the state-producing path, not a complete optimizer/database integration run.

**Fix:** Resolve each portion SKU's weight from its persisted per-line `kgPerCase`, retaining an explicit compatibility fallback for legacy portions. Add checks for sum(SKU kg) = stop kg = load kg within rounding tolerance. Include a regression with a frozen old-weight half and an open corrected-weight half. Do not overwrite shared lines used by the frozen half to make the numbers agree.

## W2 — Successful reweight changes historical views (medium audit-trail concern)

**Failure scenario:** A PLANNED load in parent version1 has one 40-case order at 10 kg/case; load, stop and manifest each weigh400 kg. Product changes to15 kg/case. Successful child finalization calls `applyWeightChanges`, updating the shared order and line to600 kg. Viewing the superseded parent now shows **load400 / stop600 / manifest600**, without a warning. If the historical assignment has a stored portion, load/stop remain400 but SKU manifest becomes600.

**Code:** `plan-service.ts:780–806` changes shared Order/OrderLine; `plan-detail.ts:278–282,376,385` mixes live shared weights with stored load weights. `plan-detail.ts:455–456` suppresses outdated/master warnings for superseded plans. The handbook explicitly acknowledges successful reweight changing superseded parents' PLANNED stop kg at `docs/PROJECT_HANDBOOK.md:755`; this finding should be presented as a known design debt. It is broader than direct RunPlan-row immutability because indirect reads change.

**Evidence:** `probe.mjs` invokes actual `applyWeightChanges` and actual `getPlanDetail` with the repository fake Prisma; a narrowly scoped adapter executes only the two emitted guarded raw UPDATE statements in memory. `results.json` preserves the actual SQL and parameters, before/after output, and child audit event. No PostgreSQL, HTTP, full optimizer or production calls were made. Every assertion passed.

**Fix:** Capture per-assignment order/line kg when an option is applied and copy that snapshot between versions; historical detail/export paths should read those immutable planned amounts. Frozen-order exclusions currently prevent this particular mutation affecting truly frozen portions; keep that protection. Do not change historical load totals to the new weight to hide the inconsistency.

## Limits

No repository files were edited. Probe/assessment files are outside the checkout. These are deterministic current-source reproductions with mocked persistence, not a claim that the full CI or database workflow was run locally. The synthetic fixture is based on `tests/lib/plan-feasibility-gate.spec.ts`, using explicitly synthetic customer names.
