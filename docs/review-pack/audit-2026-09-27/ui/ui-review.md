# UI, map and export review — RouteIQ 83d8174

Read-only review at `83d8174836deb339d54f90e65b803550ed34c20d`, 27 September 2026. This review does not repeat the previously confirmed frozen-depot-origin or portion-manifest kg defects. It does not claim browser end-to-end validation. `ui-probes.mjs` executes current pure modules and verbatim extracted component callbacks with explicit synthetic state/network boundaries; all four checks completed. The separate auth agent executed the real tenant settings route/wrapper with synthetic framework/database boundaries.

## Confirmed findings

### UI-01 — Foreign-company settings page writes the platform admin's home company (medium; cross-company operational integrity)

- Frontend sources: `apps/web/app/t/[slug]/settings/page.tsx:14–26` and `settings-form.tsx:82–94`.
- Backend sources: `apps/web/lib/api.ts:64–88`, `apps/web/app/api/tenant/config/route.ts:57–73`.
- A SUPER_ADMIN belonging to A opens B's Settings page. The server renders B's values and permits editing. Saving sends a relative `/api/tenant/config` request carrying changed fields and expectations but no selected-company identity. `withTenantApi` deliberately binds the request to A. If the original edited value agrees in both companies (especially their common defaults), optimistic comparison succeeds and the wrong company's setting is changed.
- Reproduction: both companies have reloadMinutes 30; changing the foreign page to 45 returns HTTP 200, changes A to 45, leaves B at 30, and audits A. Evidence: `../auth/foreign-tenant-settings-probe.mjs` and `foreign-tenant-settings-results.json`.
- Classification caveat: `docs/SECURITY.md` explicitly documents platform admins opening other companies' pages while API calls act on their home company. The API's policy is intentional; the defect is allowing a foreign-company view to look editable without preserving that boundary. This is not an unauthorized tenant escape.
- Fix: preserve the policy by rendering foreign-company views read-only and disabling API-backed reload/mutations that act on the home tenant. Alternatively implement an explicit, permission-checked, audited active-company switch end to end. Add a two-company UI/API regression with identical defaults; distinct default values alone would mask the bug behind a 409.

### UI-02 — Late location-preview response can replace another customer's pin (medium)

- Sources: `apps/web/app/t/[slug]/dispatch/location-dialog.tsx:48–71`, `:77–83`, `:163–166`.
- The dialog remains mounted while its `customer` changes. Start reading A's location, cancel, and open B before that read completes. The effect resets the inputs for B, but A's pending response later writes shared `parse` and `pin` state without checking which customer/request it belongs to. Clicking Save now sends A's point to B's customer ID. Cancel is permitted while the preview is busy.
- Bounded callback proof: B originally `(24.1, 56.9)`; A's delayed result `(23.5, 58.5)` overwrites the pin. Actual Save callback constructs `PUT /api/customers/customer-B/location` with `(23.5, 58.5)` and `MANUAL_LATLNG`. No request was sent to a real server.
- Impact: a dispatcher can permanently save the wrong customer's location, affecting subsequent routing. The point is visible before saving, so this is not an automatic write merely from closing the dialog.
- Fix: give each preview a generation containing customer ID and input; invalidate it on close/customer/input changes and ignore obsolete responses. Abort pending reads where possible. A React key by customer alone does not solve all same-customer, changed-input races. Regression should defer A, reopen B, resolve A, and verify B's pin remains unchanged.

### UI-03 — Invalid receiving times and unloading text silently become valid planning values (medium)

- Sources: `apps/web/app/t/[slug]/dispatch/client-api.ts:105–110`, `customer-dialog.tsx:55–77`; backend `apps/web/app/api/customers/[id]/route.ts:55–60` and `apps/web/lib/schemas.ts:154,162–181`.
- The form uses a permissive duplicate time parser rather than the validated `parseHhmm` helper. `06:90` becomes 450 minutes (07:30); the form considers it valid. For unloading time, `Number(service) || 0` turns invalid text such as `ten`, or a blank value, into zero. The API receives valid numbers and marks the zero service time as explicitly confirmed, so later planning no longer substitutes defaults.
- Actual callback result for hard hours `06:90–10:00` and unloading `ten`: request contains start450/end600/service0, with no frontend error. Control: the existing shared `parseHhmm('06:90')` throws correctly.
- Impact: hard windows can move silently, and fixed service time can disappear. For a route with many affected customers, a mathematically feasible plan can become operationally too optimistic.
- Fix: reuse `parseHhmm`, validate finite integer unloading minutes within bounds, and treat blank/invalid input as a validation error unless the user explicitly chooses zero. Add form/API regressions for `06:90`, `12:99`, blank, alphabetic and nonfinite values.

### UI-04 — Customer corrections refresh the day but leave the READY plan and WhatsApp warnings stale (medium)

- Sources: `apps/web/app/t/[slug]/dispatch/dispatch-client.tsx:138–145,517–539`, `plan-view.tsx:94–110,132–146,728–735`.
- LocationDialog and CustomerDialog `onSaved` only call `refresh()` for the day. An ordinary successful day refresh does not increment the plan refresh signal; that happens only after a preceding load error. The same plan ID/key keeps the existing PlanView mounted. READY plans do not poll, so correcting a customer pin or receiving hours leaves existing plan detail and its master-change warnings unchanged until another action reloads it.
- Reproduction: execute the actual day loader and its extracted show callback, then perform a successful second read reflecting master revision2; day updates but plan reload signal remains0. The same current `whatsappText` module omits the correction warning for the retained detail and includes it when given freshly loaded detail.
- Impact: the locally generated WhatsApp message can use the old planned pin without the intended notice that a new pin needs dispatcher confirmation. This does not prove server dispatch checks are bypassed: server status mutations recheck current data, and server-generated PDF/Excel exports reload detail.
- Fix: after customer/location save, refresh the day and bump `planReload` in place for the currently selected plan. Do not remount unrelated drafts/dialogs. Test a READY plan, edit a customer and check the map/warnings/share message without manual page reload.

### UI-05 — All-unserved dispatch plans cannot export the dispatch workbook (low)

- Sources: `apps/web/app/t/[slug]/dispatch/plan-view.tsx:345–359`, `apps/web/app/api/runs/[id]/export/excel/route.ts:67–79`; correct classification already exists in `apps/web/lib/dispatch/legacy-runs.ts:11–18`.
- Excel is hidden whenever `loads.length === 0`, including a valid applied plan whose demand is entirely unserved. Directly requesting the Excel URL also chooses the legacy generator based only on physical load count, so it loses the dispatch reconciliation, assumptions, invoice reporting and richer exception workbook.
- Source-confirmed branch; ExcelJS was unavailable in this audit runtime, so a full binary workbook was not rendered here. Legacy export does preserve basic unserved rows, so do not claim total loss of all exception information.
- Fix: use `isDispatchPlan` (or an explicit engine/type discriminator) at the export route, and allow Excel whenever a dispatch result exists. Keep the driver-PDF button hidden when there are no driver sheets. Add all-orders-unserved and zero-load-v2 export route tests.

## Testing and design observations

- The repository's dispatch screen tests explicitly describe themselves as static source guards and state that these screens have no committed DOM tests (`tests/lib/dispatch-screen-guards.spec.ts:1–30`). Pure helper tests are useful, but do not exercise component identity, modal cancellation and asynchronous request completion together. A small committed browser/component suite covering the five paths above would add meaningful confidence.
- The revised map handles content fingerprints, stale route shapes, failed fetches, draw readiness and estimated-road captions much more carefully. Popups use `setText` and labels use `textContent`; no new map XSS issue was confirmed.
- Dispatch workbook load sheet names are sanitized and made unique; cells are set to strings/numbers rather than user-controlled formula objects. No formula-injection finding was confirmed in that reviewed path.
- Driver PDF text explicitly detects unsupported glyphs; absence of Arabic font support is documented and should be an enhancement, not a newly alleged silent corruption bug. Driver messages and PDF models warn for superseded plans and failed timing checks.
- Master edits, old plan snapshots and generated documents need one consistent refresh strategy. Good server safeguards do not ensure the screen or an already-composed share message is current.

## Exact review coverage

Full or substantial functional review (not a claim that every source line received independent execution):

```
docs/PROJECT_HANDBOOK.md (7.3 and 7.4, relevant limitations and UI/export sections)
apps/web/lib/dispatch/driver-links.ts
apps/web/lib/dispatch/pdf-text.ts
apps/web/lib/dispatch/driver-pack.tsx (model 1–234, rendering inspected for data/link use)
apps/web/lib/dispatch/workbook.ts (1–325, reporting and manifests 325–790, reconciliation/assumptions 790–1003)
apps/web/lib/dispatch/time.ts
apps/web/lib/dispatch/legacy-runs.ts
apps/web/lib/dispatch/load-path.ts
apps/web/lib/dispatch/plan-map-state.ts
apps/web/lib/dispatch/day-overview.ts (master-change and returned day fields)
apps/web/lib/dashboard.ts
apps/web/lib/exports/route-sheet-data.ts
apps/web/lib/exports/excel.ts (summary, truck sheet and unserved selection)
apps/web/components/plan-map.tsx
apps/web/app/api/runs/[id]/export/excel/route.ts
apps/web/app/api/runs/[id]/export/pdf/route.ts
apps/web/app/t/[slug]/dispatch/client-api.ts
apps/web/app/t/[slug]/dispatch/day-loader.ts
apps/web/app/t/[slug]/dispatch/request-gate.ts
apps/web/app/t/[slug]/dispatch/plan-actions.ts
apps/web/app/t/[slug]/dispatch/customer-dialog.tsx
apps/web/app/t/[slug]/dispatch/location-dialog.tsx
apps/web/app/t/[slug]/dispatch/late-order-dialog.tsx
apps/web/app/t/[slug]/dispatch/dispatch-client.tsx (state/effects, upload/confirm/action handlers, plan and dialog composition)
apps/web/app/t/[slug]/dispatch/plan-view.tsx (request/actions/effects, export/scenario/load actions, drivers/WhatsApp, manifests)
apps/web/app/t/[slug]/dispatch/plan/[id]/plan-version-client.tsx
apps/web/app/t/[slug]/settings/page.tsx
apps/web/app/t/[slug]/settings/settings-form.tsx
apps/web/app/api/customers/[id]/route.ts
apps/web/lib/schemas.ts (customer fields/window validation)
apps/web/lib/api.ts (withTenantApi identity)
apps/web/app/api/tenant/config/route.ts (optimistic check/write)
apps/web/tests/lib/dispatch-screen-guards.spec.ts
apps/web/tests/lib/dispatch-plan-map-state.spec.ts (map behavior cases)
apps/web/tests/lib/dispatch-workbook.spec.ts (rendering helpers, sheet cases, warning/snapshot coverage searched)
apps/web/tests/lib/plan-actions.spec.ts (reload/action cases searched)
apps/web/tests/lib/request-gate.spec.ts (day reload cases searched)
apps/web/tests/integration/dispatch-mvp.spec.ts (export cases searched)
apps/web/tests/lib/dashboard-live-plans.spec.ts (scope/denominator cases searched)
apps/web/tests/integration/dashboard-db.spec.ts (scope cases searched)
```

No production access or changes, no repository edits, no communications through the app, and no claims of full browser or solver execution. Evidence consists of four UI checks plus the auth agent's synthetic settings-handler test. Screenshot/render quality and real mobile link behavior remain untested.
