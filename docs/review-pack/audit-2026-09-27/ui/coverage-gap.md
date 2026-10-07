# Additional UI/master-management coverage — 83d8174

This is a bounded follow-up to `ui-review.md`, not another complete audit. Two additional callback probes executed in `gap-probes.mjs`, with results in `gap-results.json`. These use actual source callbacks/time helpers and synthetic state/network boundaries; no mounted React browser, production requests or database writes.

## Broader impact of UI-01 (same root cause, not a duplicate finding)

The editable foreign-company problem extends beyond Settings. `apps/web/app/t/[slug]/layout.tsx` supplies the foreign tenant's name and slug to `apps/web/components/sidebar.tsx` and `apps/web/components/topbar.tsx`, without a foreign/read-only state. Mutation controls are enabled by role rather than whether the displayed tenant matches the session tenant.

| Surface | Specific source chain | Consequence |
|---|---|---|
| Invite user | `apps/web/app/t/[slug]/users/page.tsx:14–44` renders B's users; `apps/web/app/t/[slug]/users/users-client.tsx:246–259` sends relative `POST /api/users`; `apps/web/app/api/users/route.ts:24–45` creates using `user.tenantId` | A platform admin who believes they are adding a member to B actually creates the member in A, including the selected TENANT_ADMIN role if chosen. This can grant access to the unintended company. Source-confirmed additional scenario; no user was created in this audit. |
| Customer import | `apps/web/app/t/[slug]/customers/import/page.tsx`, `apps/web/app/t/[slug]/customers/import/import-form.tsx:39–60`, `apps/web/app/api/customers/import/route.ts:53–83,247` | An import opened under B validates/updates A's customer master, because the importer also binds to the session tenant. |
| New product, driver or depot | `apps/web/app/t/[slug]/products/page.tsx`, `apps/web/app/t/[slug]/products/product-form.tsx:57–84`; `apps/web/app/t/[slug]/drivers/page.tsx`, `apps/web/app/t/[slug]/drivers/driver-form.tsx:50–59`; `apps/web/app/t/[slug]/depots/page.tsx`, `apps/web/app/t/[slug]/depots/depot-form.tsx:104–113`; corresponding `apps/web/app/api/products/route.ts`, `apps/web/app/api/drivers/route.ts`, `apps/web/app/api/depots/route.ts` | Creates the new master record in A, although the page is branded B. These creation payloads need no existing B-owned ID, so tenant filters do not reject them. |
| Onboarding | `apps/web/app/t/[slug]/onboard/page.tsx`, `apps/web/app/t/[slug]/onboard/onboard-wizard.tsx:107–125,177–210` | Foreign-branded wizard creates a home-company depot; the next step fetches home-company depots and can create a home-company truck. |
| Daily dispatch / audit reload | `apps/web/app/t/[slug]/dispatch/page.tsx`, `apps/web/app/t/[slug]/dispatch/dispatch-client.tsx:128–136`; `apps/web/app/t/[slug]/audit/audit-client.tsx:58–83` | API-backed content can reload A under B's shell. This is further context confusion, not authorization to change B. |

Existing-object PATCH/DELETE requests carrying an actual B-owned ID usually fail tenant ownership checks; do **not** generalize this finding into an arbitrary cross-tenant update. The dangerous cases are unscoped creates/imports/configuration and API-loaded home data under the foreign shell. Preserve the documented home-tenant API policy by making foreign views read-only, or implement a deliberately selected and audited tenant context across page and API. Invite-user risk warrants prioritizing the fix higher than a mere Settings usability defect.

## Additional confirmed defects

### UI-06 — Customer inline edits remain visually applied when the request never reaches the server (medium)

- Source: `apps/web/app/t/[slug]/customers/customers-client.tsx:78–100`.
- `patchRow` changes local rows first. It rolls back only when `fetch` returns a response whose `ok` is false. A rejected fetch (offline/connection failure) escapes the asynchronous callback, leaves the optimistic row applied, and produces no toast or reload.
- Probe: deactivate an active synthetic customer, reject fetch before sending. The displayed row remains inactive, server state remains active, and notifications are empty. This can falsely assure the operator that a customer's delivery has been disabled; the inverse affects priorities too.
- Fix: catch network failures, retain an explicit failed/uncertain save state, and reconcile the row with the server. Use the same robust API envelope already used by dispatch screens. Do not blindly replay after an ambiguous response, since the server may have committed.

### UI-07 — A truck available until midnight cannot be edited without resetting its availability (low)

- Sources: `apps/web/app/t/[slug]/trucks/truck-form.tsx:134–135,145–155`; `apps/web/lib/dispatch/time.ts:93–111`.
- A legitimate `availableToMin=1440` is put in form state using `fmtHhmm`, producing `00:00 +1`. The same form accepts only HH:MM when submitting. Any later save, even changing an unrelated field, fails with “Enter availability as HH:MM.” until the user changes that field. The depot form already special-cases its own midnight value.
- Probe uses actual formatting and actual submit callback: stored1440 becomes `00:00 +1`; zero requests sent; exact validation error above.
- Fix: distinguish time-input formatting from display formatting. Initialize end-of-day as `00:00` or a separate “until midnight” state that round-trips1440. Test create midnight → reopen → change unrelated property → save.

### UI-08 — Optional master fields cannot be cleared reliably (low; source-confirmed)

**Driver phone:** `apps/web/app/t/[slug]/drivers/driver-form.tsx:50–58` sends `phone:''` when the number is removed. `apps/web/lib/schemas.ts:114–120` rejects it through the nonempty phone regex and then transforms the empty literal to `undefined`. `apps/web/app/api/drivers/[id]/route.ts:19–21` passes that straight to Prisma, where an undefined field is not updated. Save can succeed while the old phone remains. Because phone data stay live in plan detail, WhatsApp links continue using the old number.

**Region depot:** `apps/web/app/t/[slug]/regions/region-form.tsx:58–71` represents “None” with `depotId:''`. `apps/web/lib/schemas.ts:128` puts an unrestricted `z.string()` before the empty-to-undefined alternative, so the empty string is accepted as a string. `apps/web/app/api/regions/[id]/route.ts:11–16` skips the truthy ownership check then writes the empty foreign key, rather than null. That fails instead of clearing the association.

Fix each PATCH contract so absence means unchanged and explicit null means clear, with form normalization matching it. Separate create defaults from PATCH semantics. Add real schema/DB tests for clearing an existing phone and depot. These are source traces, not executed schema/PostgreSQL tests in this runtime.

## Other relevant observations, not counted as additional confirmed defects

- Master dialogs submit the entire originally loaded record: notably `apps/web/app/t/[slug]/products/product-form.tsx:57–70` and `apps/web/app/t/[slug]/trucks/truck-form.tsx:157–174`. Their PATCH routes do not have Settings' optimistic expected-value guard. Concurrent edits can overwrite an unrelated newer capacity/weight/active value. A consistent changed-field PATCH plus version/expected-value check is worth implementing. No full database concurrency proof was run for this observation, so do not count it as another demonstrated race.
- The legacy driver pages are retirement notices and clear old browser tokens: `apps/web/app/driver/page.tsx`, `apps/web/app/driver/manifest/page.tsx`, `apps/web/app/driver/retired-notice.tsx`. There is no remaining live driver UI flow to audit there. Backend retirement/delete issues belong to the auth agent's review.
- Legacy run controls remain in `apps/web/app/t/[slug]/runs/[id]/run-detail.tsx`, but dispatch plans are redirected by `apps/web/app/t/[slug]/runs/[id]/page.tsx:23`. No new dispatch-plan bypass was established in this pass.
- The basic shared components reviewed are presentation/navigation wrappers and contain no tenant mutation logic; no additional injection finding was confirmed. Form/modal async handling deserves committed component tests, particularly across request rejection and closing/reopening a modal.

## Additional source coverage

Read in full or substantive functional portions (table-only JSX and repeated input markup not individually revalidated):

```
apps/web/app/driver/layout.tsx
apps/web/app/driver/page.tsx
apps/web/app/driver/manifest/page.tsx
apps/web/app/driver/retired-notice.tsx
apps/web/app/t/[slug]/layout.tsx
apps/web/app/t/[slug]/error.tsx
apps/web/app/t/[slug]/customers/[id]/page.tsx
apps/web/app/t/[slug]/customers/[id]/customer-editor.tsx
apps/web/app/t/[slug]/customers/customers-client.tsx
apps/web/app/t/[slug]/customers/import/page.tsx
apps/web/app/t/[slug]/customers/import/import-form.tsx
apps/web/app/t/[slug]/products/page.tsx
apps/web/app/t/[slug]/products/product-form.tsx
apps/web/app/t/[slug]/products/products-table.tsx
apps/web/app/t/[slug]/drivers/page.tsx
apps/web/app/t/[slug]/drivers/driver-form.tsx
apps/web/app/t/[slug]/depots/page.tsx
apps/web/app/t/[slug]/depots/depot-form.tsx
apps/web/app/t/[slug]/regions/page.tsx
apps/web/app/t/[slug]/regions/region-form.tsx
apps/web/app/t/[slug]/trucks/truck-form.tsx
apps/web/app/t/[slug]/users/page.tsx
apps/web/app/t/[slug]/users/users-client.tsx
apps/web/app/t/[slug]/onboard/page.tsx
apps/web/app/t/[slug]/onboard/onboard-wizard.tsx
apps/web/app/t/[slug]/audit/audit-client.tsx
apps/web/app/t/[slug]/upload/upload-dropzone.tsx
apps/web/app/t/[slug]/upload/[batchId]/validation-report.tsx
apps/web/app/t/[slug]/runs/[id]/run-detail.tsx
apps/web/app/t/[slug]/runs/[id]/routes-tab.tsx
apps/web/app/t/[slug]/runs/[id]/baseline-tab.tsx
apps/web/app/t/[slug]/runs/[id]/live/page.tsx
apps/web/app/t/[slug]/runs/new/page.tsx
apps/web/components/sidebar.tsx
apps/web/components/topbar.tsx
apps/web/components/user-menu.tsx
apps/web/components/mobile-sidebar.tsx
apps/web/components/nav-link.tsx
apps/web/components/page-shell.tsx
apps/web/components/empty-page.tsx
apps/web/components/empty-state.tsx
apps/web/components/map-picker.tsx
apps/web/components/pin-map.tsx
apps/web/app/api/products/[id]/route.ts
apps/web/app/api/drivers/[id]/route.ts
apps/web/app/api/regions/[id]/route.ts
apps/web/app/api/users/route.ts
apps/web/lib/schemas.ts (driver/region/product fields)
apps/web/package.json (runtime/framework versions)
```

Targeted ownership/mutation screening (not a full line-by-line read):

```
apps/web/app/t/[slug]/trucks/trucks-table.tsx
apps/web/app/t/[slug]/drivers/drivers-table.tsx
apps/web/app/t/[slug]/depots/depots-table.tsx
apps/web/app/t/[slug]/regions/regions-table.tsx
apps/web/app/t/[slug]/upload/batches-table.tsx
apps/web/app/t/[slug]/upload/orders-table.tsx
apps/web/app/t/[slug]/runs/[id]/page.tsx
apps/web/app/api/products/route.ts
apps/web/app/api/drivers/route.ts
apps/web/app/api/depots/route.ts
apps/web/app/api/customers/import/route.ts
```
