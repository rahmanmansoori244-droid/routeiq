# RouteIQ deep audit: intake, master data and location input

Pinned commit: `83d8174836deb339d54f90e65b803550ed34c20d`.

Review only. No repository edits, commits, HTTP requests to production, real customer records, or database writes. Five source-level synthetic reproductions passed with Node 24.19.0. The harness executes actual current TypeScript after Node type stripping and substitutes only framework/auth/database/parser boundaries. The depot scope function is extracted unchanged from its source to avoid importing the unrelated solver/web dependency graph; PostgreSQL SET NULL actions are explicitly simulated from the checked schema and migration. No actual PostgreSQL integration suite or full optimizer was executed for these findings.

Evidence: `probe-intake.mjs`, `probe-intake-results.json`. Run `node probe-intake.mjs` from this directory; source is read from the sibling pinned checkout at `../../routeiq-20260927`.

## I01 — Medium: same-invoice/SKU merging discards urgency and delivery instructions

**Location:** `apps/web/lib/dispatch/order-intake.ts:495–507`; downstream persistence `apps/web/lib/dispatch/intake-server.ts:397–413`; effective priority `apps/web/lib/dispatch/plan-service.ts:404`.

**Reproduction:** Two rows have the same customer branch, delivery date, sales order and SKU. First row: 10 cases, P5, “Routine order”. Second: 5 cases, P1, “Urgent hospital: call receiving before delivery”. Both are valid, and 15 cases are reconciled correctly. `resolveOrderLines` merges only quantity, weight and money fields, leaving first-row `priority` and `notes` unchanged. `confirmIntake` therefore saves P5 and “Routine order”. For a P3 customer the solver receives effective P3, losing the requested P1 priority. Reversing the file rows saves P1 instead. Both source files have an identical order-insensitive content fingerprint.

**Impact:** Sorting an ERP file can change service priorities. Delivery instructions present only in a later row disappear from the order and its stored SKU line, without a warning that any instruction/priority was dropped. This is not an optimality issue: the solver is fed different business requirements.

**Fix:** Merge non-null priorities using `Math.min`, preserve distinct notes (prefer keeping source-row provenance), and explicitly detect conflicting metadata where there is no safe merge rule. Add permutation-invariance checks asserting identical meaning for any ordering of the same source rows.

**Evidence scope:** Actual normalize → resolve → confirm functions, with saved data inspected in a synthetic in-memory transaction. Effective priority is independently evaluated using the current min-with-customer expression; no complete routing run was needed or claimed.

## I02 — Medium: a partial money total becomes falsely “known” after merging

**Location:** `apps/web/lib/dispatch/order-intake.ts:503–504`; `apps/web/lib/dispatch/intake-server.ts:398–421,434–435`; solver enables margin scoring based on completeness at `apps/solver/dispatch_solver.py:634,1587`.

**Reproduction:** Same sales-order/SKU rows: 10 cases with sales value 100 OMR and margin 20 OMR, then 5 cases with blank value and blank margin. The merged 15-case line retains value 100 and margin 20 as if they cover the whole line. `confirmIntake` considers every merged line's money non-null and saves order totals 100/20. A control with the same quantities/money but different sales-order numbers correctly saves both order totals as null.

**Impact:** Unknown amounts are silently treated as zero for part of the order. Revenue/margin summaries and economic ranking can operate on incomplete information while claiming full money coverage. This differs from the deliberately conservative treatment already implemented for partial file weights.

**Fix:** Track source-row completeness separately for value and margin, or make a merged sum permanently null when any component is missing. Do not initialize missing money back to zero on a later row. Preserve any useful known subtotal separately from a complete total.

**Evidence scope:** Actual intake and confirmation functions. No claim that a particular final route changes; the corrupted monetary input and incorrect completeness decision are reproduced.

## I03 — Medium, potentially serious routing consequence: deleting a depot strips orders' depot ownership

**Location:** `apps/web/app/api/depots/[id]/route.ts:40–59`; `apps/web/prisma/schema.prisma:548,581`; `apps/web/prisma/migrations/20260924090000_nmwc_dispatch_mvp/migration.sql:224,227`; `apps/web/lib/dispatch/plan-service.ts:174–180`.

**Reproduction:** A tenant has depots NIZWA and MUSCAT. NIZWA has a confirmed 50-case order and its upload batch but no truck and no run yet. The DELETE handler checks only trucks and runs, then hard-deletes NIZWA. The explicit foreign keys set `Order.depotId` and `UploadBatch.depotId` to NULL. MUSCAT is now the only active depot. `ordersInScopeWhere` includes NULL-depot orders whenever there is at most one active depot, so the NIZWA order is now eligible for a MUSCAT plan.

**Impact:** An administrative cleanup can silently convert explicitly assigned demand into “legacy/unassigned” demand and move it into another depot's planning scope. If multiple other depots remain, it instead becomes excluded from all depot scopes. This violates the intended meaning of depot ownership even though case totals remain intact.

**Fix:** Preserve the depot row by deactivation whenever any order, upload batch or other business reference exists; lock/check those references atomically with deletion. Consider restricting order/batch depot deletion instead of SET NULL, or distinguishing genuine legacy unassigned orders from deleted-depot orders. Confirmation must also reject a validated batch whose depot was deleted/deactivated since validation instead of creating new unassigned demand.

**Evidence scope:** Actual current DELETE handler returned 200/deleted; exact current scope function included the NULL order in the remaining depot. FK effects are modeled from explicit schema and migration, not measured on an actual PostgreSQL instance. The order-to-other-depot selection is proved; no production deletion or solver call was made.

## I04 — Low: malformed degrees/minutes/seconds coordinates are accepted as HIGH confidence

**Location:** `apps/web/lib/dispatch/location-input.ts:57–69`, DMS branch `:146–149`.

**Reproduction:** Input `23°99'00"N 58°24'00"E` returns `{ok:true,lat:24.65,lng:58.4,confidence:"HIGH",needsPin:false,warnings:[]}`. Minutes 99 are invalid; the parser normalizes them into another degree instead of rejecting the input. A seconds value above 59 has the same problem.

**Impact:** A transcription error can produce a substantially different point that still lies in the Oman service area and bypasses the normal map-confirmation request.

**Fix:** Require minutes and seconds in `[0,60)`, validate degree/hemisphere limits before conversion, and ask for pin confirmation or return a clear validation error on malformed DMS.

**Evidence scope:** Actual pure parser, no network calls.

## I05 — Medium: bulk customer import can overwrite a newly verified map pin

**Location:** `apps/web/app/api/customers/import/route.ts:182–190,235–281`, especially `:267–275`.

**Reproduction:** Import reads customer C1 with `locationVerified=false`. Before import reaches that row's update, a dispatcher confirms its real location as `23.8,58.7`, setting `locationVerified=true`. Import retains its earlier customer snapshot, decides it may write coordinates, and writes file coordinates `23.7,58.5`. Response is successful and reports zero kept verified locations. The customer remains `locationVerified=true` with the dispatcher's verification attribution, although its coordinates now come from the import and were not the coordinates that dispatcher verified.

**Impact:** Long/bulk imports can undo a simultaneous location correction and leave a false verified flag. This contradicts the explicitly documented promise that verified map points are never overwritten by import.

**Fix:** Separate ordinary-field updates from location writes; condition the latter atomically on the current `locationVerified=false`, or lock/re-read each affected customer row transactionally. Base the “kept verified” count on actual conditional write results. A read at the start of the upload is insufficient.

**Evidence scope:** Actual import POST with a deterministic read/write interleaving at the database boundary. Parser, authentication and database calls are stubbed. No real concurrent HTTP requests or database were required to show the missing write condition.

## Additional review notes, not counted as confirmed standalone bugs

- Customer master import performs row writes and its final audit sequentially without an encompassing transaction. A mid-import failure can leave a partially applied file with no final import audit; consider atomicity or explicit resumable batch status. This is source-observed hardening, not a reproduced database failure in this audit.
- Case-insensitive customer/product uniqueness is enforced by preflight reads, while database unique indexes remain case-sensitive. Concurrent creation of case variants can still create twin records. Intake has deterministic twin resolution and warning behavior, reducing but not eliminating the identity-management burden. No concurrent PostgreSQL reproduction was run here.
- Main order intake validation and confirmation use a tenant advisory lock and a unique per-line intake key. Plan start also takes that same intake lock and rechecks order existence. The previously suspected order-delete/plan-start race is therefore **dismissed** for the inspected path.
- The Google short-link resolver checks each redirect host, only fetches short Google hostnames, restricts protocol and limits hops/time. No arbitrary-host SSRF was established. DMS validation is a distinct non-network defect.
- Excel synchronous timeout weakness was already reported and is **not counted as new** here. There is also no workbook-1904 epoch handling in the raw-serial path; treat that as a compatibility lead requiring a real 1904 workbook test, not a confirmed production incident.
- The inability to amend/cancel an already planned order is documented/deferred, not reported again as a coding defect.

## Coverage

Read complete implementation files:

- `apps/web/lib/csv.ts`
- `apps/web/lib/schemas.ts`
- `apps/web/lib/dispatch/order-intake.ts`
- `apps/web/lib/dispatch/intake-server.ts`
- `apps/web/lib/dispatch/location-input.ts`
- `apps/web/lib/dispatch/time.ts`
- `apps/web/app/api/orders/upload/route.ts`
- `apps/web/app/api/orders/[batchId]/confirm/route.ts`
- `apps/web/app/api/orders/[batchId]/route.ts`
- `apps/web/app/api/orders/route.ts`
- `apps/web/app/api/orders/batches/route.ts`
- `apps/web/app/api/dispatch/late-order/route.ts`
- `apps/web/app/api/customers/route.ts`
- `apps/web/app/api/customers/[id]/route.ts`
- `apps/web/app/api/customers/import/route.ts`
- `apps/web/app/api/customers/[id]/location/route.ts`
- `apps/web/app/api/locations/parse/route.ts`
- `apps/web/app/api/depots/route.ts`
- `apps/web/app/api/depots/[id]/route.ts`
- `apps/web/app/api/trucks/route.ts`
- `apps/web/app/api/trucks/[id]/route.ts`
- `apps/web/app/api/drivers/route.ts`
- `apps/web/app/api/drivers/[id]/route.ts`
- `apps/web/app/api/regions/route.ts`
- `apps/web/app/api/regions/[id]/route.ts`
- `apps/web/app/api/products/route.ts`
- `apps/web/app/api/products/[id]/route.ts`

Targeted supporting reads: handbook 7.3/7.4 and intake/master sections; `schema.prisma` relevant models and their migration FKs; `plan-service.ts` scope and effective priority/money construction; `start-optimize.ts` intake-lock/start transaction; `weights.ts` line completeness convention; `dispatch_solver.py` monetary completeness activation; `tests/lib/dispatch-order-intake.spec.ts`; prior audit reports to avoid duplicate findings.

Five reproductions confirm specific defects, not universal correctness of the remaining paths. Source coverage is not a claim that every possible interleaving, malformed workbook or database failure was tested.
