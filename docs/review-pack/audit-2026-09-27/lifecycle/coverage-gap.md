# Supplemental snapshot, plan-read and geometry coverage

Commit `83d8174836deb339d54f90e65b803550ed34c20d`; read-only source audit, synthetic in-memory probes only.

## LIF-03 — A read can combine one scenario's summary with another scenario's loads

Severity: medium; inconsistent plan-detail response and export-input data during a concurrent scenario switch. Application read schedule reproduced; not a PostgreSQL stress test or rendered XLSX test.

Source:

- `apps/web/lib/dispatch/plan-detail.ts:233–245`: `getPlanDetail` reads the RunPlan, then config/profiles/scenarios, then loads in independent queries, with no shared transaction/snapshot and no revision validation.
- `apps/web/lib/dispatch/plan-detail.ts:515–519`: chosen scenario, summary and reconciliation are returned from the initially read RunPlan; loads came from a later read.
- `apps/web/app/api/runs/[id]/export/excel/route.ts:36–43`: the workbook consumes this same PlanDetail.
- `apps/web/lib/dispatch/workbook.ts:364–366,382–384`: SUMMARY prints its stored summary km/cost. `513,529`: LOAD PLAN prints/sums the load rows' cost.

Deterministic reproduction:

1. Apply feasible/reconciled scenario A using actual `chooseScenario`: 12 km, OMR 21, departure minute 400.
2. Start actual `getPlanDetail`. It has read RunPlan A and the scenario rows.
3. At its load-query boundary, run actual `chooseScenario` B to completion: 25 km, OMR 35, departure minute 600. The writer's updates are atomic; this is not a partial writer commit.
4. Resume the read. Returned chosen scenario and summary are A (12 km/OMR 21), but its load rows are B (25 km/OMR 35/minute 600), while stored reconciliation still says OK.
5. A subsequent ordinary read is consistent with B, showing that this is a transient mixed read.

This is a valid ordering of independently committed reads and a concurrent writer; the fake boundary makes the timing deterministic. It can produce a mixed response on the plan screen, and that object is directly passed to the workbook producer. The specific conflicting SUMMARY/LOAD PLAN cell consumers are established in source. No claim is made that a real XLSX was generated or that a real PostgreSQL concurrent execution was measured.

Fix: read the entire export/plan model within a repeatable-read database transaction, ensuring every helper uses the transaction client rather than global Prisma. Alternatively attach a revision token to every plan mutation and retry if it changes before the completed read. Avoid holding the transaction during PDF/Excel rendering or network geometry calls: build a consistent immutable model, commit, then render.

Evidence: `mixed-read-probe.mjs` and `mixed-read-results.json`. Uses actual `chooseScenario` and `getPlanDetail`, repository fake Prisma, with the fixture adapter implementing the schema's assignment cascade and embedded Order include relations. There is no production access, migration or source modification.

## Coverage completed

- `plan-service.ts:674–763`: complete plan-settings snapshot mapping and optimizer request → PlanInputs serialization. Confirmed OSRM address is removed and only its configured flag retained; truck/stop/depot/config values are copied from the request. Settings retain original shift setting while effective same-day start/loading fields are preserved separately.
- `plan-service.ts:1169–1277`: complete load kg summation and snapshot source construction; PLAN versus MASTER provenance, planned stop coordinates/windows/service/priority, apply-time descriptive customer data, legacy master fallback, and per-truck rule construction.
- `snapshots.ts`: entire file; readers, rule derivation, coordinate/window/name/address change detection, truck capacity detection and current-plan change counts. Weak JSON readers are internal persistence readers; no user-controlled corruption path was established, so no new defect reported from that alone.
- `plan-detail.ts`: all remaining read/model/option/history/warning sections, including the multi-query read consistency shown above. Prior depot drift and live/shared-line manifest weight findings were recognized and not duplicated.
- `prisma-copy.ts`: entire file; DMMF JSON-field discovery, null conversion, omitted fields and override precedence. No new issue identified.
- `costs.ts`: entire file; solver breakdown persistence, load/day totals, mixed legacy label, paid-span warnings and estimated-distance labels. Frozen overtime objective issue remains owned by solver lane and is not duplicated.
- `load-path.ts`, `plan-map-state.ts`, `load-geometry.ts`: entire files; coordinate order/fingerprints, stale-content handling, straight-line labels, draw gate, cache copy/TTL/cap behavior, bounded concurrency and deadline fallback. No additional proven integrity bug identified.
- `api/runs/[id]/load-geometry/route.ts`: complete endpoint, data scoping and source snapshot selection; known depot-per-load gap not duplicated.
- Export route/model support: complete Excel/PDF routes and `exports/route-sheet-data.ts`; targeted workbook SUMMARY/LOAD PLAN consumers and legacy Excel model. The zero-load dispatch-to-legacy Excel routing defect was independently noticed but is owned and reproduced by the UI lane; it preserves basic unserved rows but loses richer dispatch sheets. No duplicate finding added here.

No additional snapshot serialization or arithmetic defect was proven in this gap pass. Keeping master-data contact notes live and using apply-time customer names/address are documented behavior and are not reported as accidental mutation bugs.
