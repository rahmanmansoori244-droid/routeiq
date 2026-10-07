# Authentication, tenancy and security audit

Pinned commit: `83d8174836deb339d54f90e65b803550ed34c20d`.

The restored security controls are substantially better than the original review. This pass did not find a new anonymous authentication bypass or demonstrated ordinary-tenant data exfiltration. It did identify two concrete concurrency defects and contributed a runtime proof for the platform-admin foreign-page write defect owned by the UI reviewer.

All execution used synthetic data and the current source unchanged, with framework/database boundaries stubbed. No production request, live credential, repository edit or Postgres write was used. These results demonstrate application logic under explicit interleavings; they are not full HTTP/database concurrency tests.

## A01 — Password reset can consume a link after another reset retires it

Severity: medium; security-sensitive concurrency defect. An attacker would need possession of an otherwise valid reset link and favorable timing. This is not a token-guessing or anonymous account-takeover finding.

Source:

- `apps/web/lib/password-reset.ts:103–114`: reads `usedAt`, then deletes solely by `id`.
- `apps/web/lib/password-reset.ts:139–144`: consuming that row updates the password.
- `apps/web/app/api/users/[id]/reset-password/route.ts:46–57`: admin resets change the password and retire outstanding tokens.
- `apps/web/lib/password-reset.ts:67–80`: issuing another link also retires older links.

Failure schedule:

1. Token-reset transaction reads a still-valid, unused token.
2. An admin reset commits a new password and marks this token used. The same schedule can occur when a new email link retires an older one.
3. Token-reset transaction performs `deleteMany({where:{id}})`. The used row still matches, so deletion succeeds.
4. The previously retired link resets the password again, replacing the admin's new password.

The ordinary sequential case correctly rejects a link already retired before validation. The missing condition is at the atomic consumption write.

Runtime proof: `auth-race-probes.mjs` runs the real `resetPasswordWithToken` / `consumeResetToken` functions with a boundary callback that commits the retirement between SELECT and DELETE. It returns `{ok:true}` and overwrites the newer synthetic admin password. The already-retired control returns `{ok:false,reason:'used'}`. See `auth-race-results.json`.

Fix: consume conditionally with at least `id`, `usedAt:null` and an unexpired timestamp in the mutation predicate, and treat zero affected rows as invalid. Use a consistent per-user lock/serialization strategy across link issuance, consumption and admin reset to cover all reset lifecycle races; acquire locks in a consistent order to avoid deadlocks. Add a real Postgres barrier test in CI.

Related lead, not independently database-reproduced: creation counts recent tokens before its transaction, then retires existing tokens and inserts without a per-user lock. Concurrent first-time issuances can both observe no tokens and create more than one live link; concurrent requests can also bypass the three-per-hour count. The per-user serialization above addresses this as well.

## A02 — Concurrent admin changes can leave a tenant with no active administrator

Severity: medium; tenant administration availability/data-integrity defect.

Source: `apps/web/app/api/users/[id]/route.ts:33–58`.

The route correctly refuses a lone administrator's deactivation in a sequential request. However, the `remainingAdmins` count and update are separate database calls without a transaction or a common tenant lock.

Failure schedule: a tenant has exactly two active administrators. Two requests deactivate them concurrently. Each count sees the other administrator active, both pass, and both update. No active tenant administrator remains. Staff can no longer repair user access/settings without external platform-owner intervention.

Runtime proof: `auth-race-probes.mjs` executes both real PATCH handlers with a barrier after the count reads. Responses are `[200,200]`, with zero remaining active admins. The single-admin control returns 400 and leaves the account active.

Fix: lock a stable tenant row in a transaction, re-read the target and count, perform the change, and write its audit record in that transaction. Add a real database test for two simultaneous deactivations/demotions. A transaction alone at default READ COMMITTED isolation is insufficient without serialization of the shared invariant.

## Shared UI finding — Foreign-tenant settings page writes to the platform admin's own tenant

The UI reviewer owns the final finding and frontend evidence. This audit supplied `foreign-tenant-settings-probe.mjs` and `foreign-tenant-settings-results.json`.

`getCurrentTenant()` permits a SUPER_ADMIN to view another company (`lib/tenant.ts:114–128`). `withTenantApi()` deliberately resolves writes to the session's own company (`lib/api.ts:64–88`), as explicitly documented in `docs/SECURITY.md` section 3. The bug is that a foreign-company settings page still exposes working Save controls.

Actual settings route and actual API wrapper execution: session home tenant A, settings page B, both initially `reloadMinutes=30`; page submits changed value 45 with expected value 30. Response is 200 and tenant A becomes 45, B remains 30; the audit row also records A. The optimistic precondition does not catch identical defaults.

Preserve the documented security policy by rendering foreign-company pages read-only and preventing their client API reloads from substituting home-company data. Alternatively implement explicit, audited tenant-switching semantics end-to-end. This is a wrong-target privileged write, not an ordinary user's cross-tenant authorization bypass.

## Additional engineering observations

- **Tenant wrapper is not a complete integrity boundary.** It scopes top-level queries, but `upsert` injects only into a nonexistent `data` property rather than `create`/`update`; ordinary updates do not prohibit changing `data.tenantId`; related foreign IDs are not automatically scoped. Current reviewed application schemas strip tenant IDs, current truck/customer APIs validate related IDs, and application code has no `tenantDb().upsert` caller, so this is a hardening/test gap rather than a demonstrated live exploit. Fail closed for unsupported mutation patterns, stamp all create branches and prohibit tenant reassignment/nested cross-tenant relations unless explicitly implemented.
- **Some tenant-isolation tests promise more than they assert.** `tests/tenant-isolation.spec.ts` has eight parameterized `expect(true).toBe(true)` placeholders. Its test titled "Truck — depotId from another tenant cannot be linked" creates an A truck linked to an A depot and only tests read isolation; it never attempts the named cross-tenant relation. Replace these with actual negative write tests and add update/upsert/nested-write coverage. Passing counts should not be described as eight independently enforced model-isolation guarantees.
- **Password-reset issuance throttling is weakened by deleting consumed rows.** The advertised three-issued-links-per-hour count only sees rows that still exist; a successful consume deletes its row. This is a policy/robustness observation, not a useful unauthenticated attack: consuming requires the delivered token. Retain a timestamped consumption record if the limit means issuance rather than outstanding attempts.
- **Run status exposes stored solver failure bodies.** `api/runs/[id]/status/route.ts:29` returns `errorJson` to any authenticated role; `dispatch-job.ts:220–225` can include `SolverError.responseBody`. The reviewed failure paths did not establish a concrete secret disclosure beyond plan/validation data the VIEWER already may access. Keep as defensive improvement: return a safe public error code/message and keep arbitrary backend bodies in the supervisor debug channel. Do not report this as a confirmed secret leak.
- **Malformed Google URL returns a server error.** A local pure-function probe of `parseLocationInput('https://www.google.com/maps?q=%E0%A4%A')` throws `URIError` from the unconditional decode in `location-input.ts:190`, instead of returning the normal invalid-location result. `withTenantApi` therefore maps this to 500. Low-severity robustness issue: catch URI decoding errors and return the existing invalid-input shape. The separate DMS range defect belongs to the intake review and is not duplicated here.

## Controls checked and not reopened

- Sign-in uses real/dummy bcrypt comparison, account/tenant activity checks and bounded throttles; public sign-up does not create platform administrators.
- JWT sessions enforce an absolute lifetime and refresh roles/activity/password fingerprint server-side. The documented 30-second cache and 10-minute stale-on-DB-error grace are intentional, not new bugs.
- Same-origin callback URL validation is applied on the server and client; stale-session handling avoids forcing logout of a valid session.
- Users/audit/settings reads and debug routes have the intended role gates. VIEWER plan/export access is documented policy.
- User mutations select/modify only their tenant; platform-admin accounts have an additional role guard.
- Seven retired driver endpoint handlers return 410 before auth or database work. The old driver-auth implementation has no active API caller.
- Driver public selects and recursive audit credential redaction remain in place.
- Production janitor auth fails closed without its own token. Solver token checking is centralized and constant-time.
- Google short-link fetches are limited to the exact short-host allowlist, checked at each hop; non-short hosts are parsed rather than fetched. No working internal-host SSRF path was found.
- `osrm_url` can target arbitrary configured endpoints behind the private solver token, but there is no writable tenant settings API field for it. This is a trusted service-configuration boundary, not a demonstrated tenant SSRF.
- No production runtime settings, secret rotation, external mail delivery, reverse-proxy behavior or deployment health was verified in this pass.

## Evidence files

- `auth-race-probes.mjs`
- `auth-race-results.json`
- `foreign-tenant-settings-probe.mjs`
- `foreign-tenant-settings-results.json`
- `boundary-inventory.mjs`
- `boundary-inventory.json` — all 86 exported HTTP handlers match the repository's checked-in static role matrix; this does not replace runtime authorization tests.
- `coverage.json`
