# RouteIQ audit of 27 Sep 2026: consolidated verification

**Scope.** The auditor reviewed commit 83d8174, which is the production build. That covers 26 new findings (F01–F26) and 5 earlier items that are still open (E1–E5). Two verifiers checked each item on their own. They did not run the auditor's scripts. They wrote their own tests against real Postgres, real OR-Tools, real Excel output and a real production build. Nobody changed the repo or touched production.

## Bottom line

- **Nothing was refuted.** 29 items are confirmed. F01 and F24 are real problems, but the auditor described part of each one wrongly.
- **The risk for NMWC today is lower than the audit says.** The audit rated 1 item "high" and 18 "medium". For NMWC it comes to **8 medium and 23 low**. Many problems need conditions NMWC doesn't have yet, such as email password reset, a second depot, or money columns in the order file. None of them is a reason to stop using RouteIQ. The auditor's advice is reasonable: keep a person supervising each day's plan, and let the warehouse keep checking payload and times.
- **What matters most:**
  1. **Next.js 14 no longer gets security fixes.** The attack the auditor named cannot be used on RouteIQ, because the app has no "Server Actions" (proven on a production build). The next Next.js flaw may hit a part RouteIQ does use, and 14.x will get no fix. We can harden now in a few hours and move to Next 16 within weeks.
  2. **The dispatch screen can save the wrong thing:**
     - it can save customer A's pin onto customer B (F06);
     - it can accept broken hours or unloading time without an error (F07);
     - it can send a WhatsApp route message that is out of date (F13).
  3. **Order upload can lose an urgent priority or a delivery note** when the ERP file has the same sales order and product twice (F02).
  4. **One large Excel upload can freeze RouteIQ for every user for 17–38 seconds** (E2).
  5. **A crash at the wrong moment can leave a day stuck on "optimizing"**, and it never fixes itself (F09).
  6. **A platform-admin account can write to the wrong company.** If such an account exists, edits made on another company's pages land in its own company (F12).
- **Effort:** about 20 developer days in 9 PRs, plus about a week of staging tests for the Next 16 upgrade.

## Verdict per item

Severity is for NMWC. Where it differs from the auditor's rating, the auditor's rating is shown in brackets.

| ID | What happens | Consensus | Severity | Fix size |
|---|---|---|---|---|
| F01 | Next.js 14.2.35 is out of support and inside the range of CVE-2026-23864 | **Partially.** Both verifiers agree on the version and support facts. The named attack can't reach RouteIQ: there are no Server Actions, proven on a production build | Medium (High) | S now, then L upgrade |
| F02 | Two rows with the same sales order and product keep only the first row's priority and note | Confirmed | Medium | S |
| F03 | Deleting a depot that has orders but no trucks leaves its orders without a depot. With one depot left they go to its plan; with two or more they disappear | Confirmed on a real database | Low today, Medium once a 2nd depot exists (verifiers split Low/Medium) | S (M with a database constraint change) |
| F04 | Merged rows with some money cells blank are saved as fully priced | Confirmed | Low (Medium). NMWC files have no money columns today | S |
| F05 | A customer import overwrites a pin a dispatcher verified during that import | Confirmed with a real database race | Low (Medium). Verifiers split: needs the same customer touched within seconds | S |
| F06 | A slow map-link read for customer A lands in customer B's dialog, and Save stores it | Confirmed. Verifiers also found a worse variant using the Enter key | Medium | S |
| F07 | The Details dialog turns "06:90" into 07:30, and "10 min" or a blank box into 0 minutes, then marks it confirmed | Confirmed | Medium | S |
| F08 | Rounding every stop up to whole kg blocks loads that fit exactly; the dropped stop says "low priority" | Confirmed with the full optimizer | Low (Medium). The loss is about 1 kg per stop at most | S |
| F09 | If the job clean-up fails between its two database writes, the plan stays "optimizing" forever | Confirmed on a real database | Medium | S |
| F10 | A reset link used at the same moment as an admin reset overwrites the admin's temporary password; the two can also deadlock | Confirmed | Low (Medium). Can't happen while email reset is off | S |
| F11 | Two admins demoting each other at the same instant leave the company with no admin | Confirmed | Low (Medium) | S |
| F12 | A platform admin's edits on another company's pages go to the admin's home company. An invite can create a company admin in the wrong company | Confirmed | Medium, only if a SUPER_ADMIN account exists | M |
| F13 | After a pin or hours correction, the open plan, its badges and the WhatsApp text stay out of date until the page is reloaded | Confirmed | Medium | S |
| F14 | On old (legacy) runs, a planner can delete locked stops on closed runs, and any delivery proof is deleted with them | Confirmed | Low (Medium). Old May-2026 runs only | S |
| F15 | `/api/health` shows green even when the solver token is missing or wrong | Confirmed | Low (Medium). The first Optimize fails with a clear error | S |
| F16 | A plan with no loads (nothing could be served) gets no dispatch Excel | Confirmed | Low | S |
| F17 | An impossible coordinate such as 99 minutes is accepted as "high confidence" | Confirmed | Low | S |
| F18 | The legacy `/optimize` distance cache labels estimates as road distances | Confirmed | Low. Not used by NMWC dispatch | S |
| F19 | The Docker OSRM health check only runs `--version` | Confirmed (config read) | Low. Railway is not affected | S |
| F20 | Deleting a driver at the same instant they are assigned removes the driver from a dispatched load | Confirmed | Low (Medium) | S |
| F21 | Reading or exporting a plan while someone switches options can mix the two options, including in the Excel file | Confirmed; Excel output rendered | Low (Medium) | M |
| F22 | An alternative that breaks timing rules is described as cheaper and better | Confirmed | Low (Medium). The dispatch gate still blocks it | S |
| F23 | Cost per case is rounded to 2 decimals and then shown with 3 (0.045 shows as 0.050) | Confirmed | Low | S |
| F24 | A network failure while toggling a customer on the Customers page has no handling | **Partially.** The defect is real, but in production the page switches to an error card; it does not silently look saved | Low (Medium) | S |
| F25 | A truck available "until midnight" can't be edited afterwards | Confirmed | Low | S |
| F26 | Clearing a driver's phone says "saved" but keeps the old number. "No depot" on a region fails, and a region can't be created without a depot | Confirmed on a real database | Low | S |
| E1 | After a re-plan, locked loads are redrawn from a moved depot pin | Confirmed | Low | M |
| E2 | The 10-second Excel parse timeout can never fire; a big workbook freezes the app | Confirmed: 17–38 s freezes with real files | **Medium** | S quick fix, then M |
| E3 | Excel loading-sheet kg differs from load kg after a product weight correction | Confirmed | Low | S |
| E4 | The optimizer charges overtime already worked again, so it opens another truck | Confirmed end to end | Low. Verifiers split Low/Medium; money only, and the reported cost is correct | S |
| E5 | The optimizer's load-rebuild step can give up before it finds its first answer | Confirmed. Seen on a synthetic tight day; zero times in 1,376 logged runs | Low. Verifiers split Medium/Low | S |
| Side | Readable client source code (source maps) is built and would be served publicly | One verifier only, on a local build; production not checked | Low | S |

## Remediation plan

The PRs are in priority order. PR 2, 3 and 4 don't depend on each other and can run in parallel.

| # | PR | Contents | Effort | Database change | Risks |
|---|---|---|---|---|---|
| 1 | **Quick hardening** | <ul><li>Switch off the image endpoint (`images.unoptimized`)</li><li>Drop the unused Server Action size setting (`serverActions.bodySizeLimit`)</li><li>Add a CI check that fails if any Server Action appears</li><li>Hide or delete source maps</li><li>Pin Node 22</li><li>E2 quick fix: stop reading past the row limit (`sheetRows`), refuse files whose unpacked size is too big, remove the fake timeout</li></ul> | 1 day | None | Node 22 on Railway: build on staging first |
| 2 | **Dispatch screen: never save the wrong thing** | F06, F07, F13, F16, F17, with component tests | 2 days | None | F07 changes what the dialog saves (decision 9) |
| 3 | **Intake and master data** | F02, F04, F05, F03, F20, F24, F25, F26 | 2.5 days | Optional: make the database refuse deletes that would orphan records (depot on orders and uploads, driver on loads) | Check production for orders with no depot before this migration |
| 4 | **Recovery, races, readiness** | <ul><li>F09, plus a one-off repair of plans already stuck</li><li>F10, F11</li><li>F21: read the whole plan in one consistent snapshot</li><li>F15, F19</li><li>Add real-Postgres race tests to the integration tests</li></ul> | 3 days | None | The F21 read must stay short. F15 gating needs decision 5 |
| 5 | **Upload parsing in a separate worker** | E2 proper fix: parse in a worker thread with a memory cap and a timeout that really stops it | 1.5 days | None | Bundling the Excel library into the worker; memory on Railway |
| 6 | **Solver and plan-output accuracy** | F08 (weights in 0.1 kg units, rounded rather than always rounded up), E4, E5, E3, F22, F23, E1 | 3.5 days, including a benchmark re-run | None: the depot origin goes into the existing truck snapshot field | Plans will shift slightly. Compare service by priority first, then cost, on the five synthetic days and one real day |
| 7 | **Platform-admin company context** | F12: other companies' pages become read-only with a banner, and the server refuses writes that come from another company's page | 2 days | None | Must not break `/admin`. Move this to #2 if a SUPER_ADMIN account exists and is used |
| 8 | **Retire legacy parts** | Make legacy runs read-only (F14); remove the legacy `/optimize` endpoint and its PyVRP/Mapbox code (F18) | 1 day | None | First confirm nobody opens legacy runs; this is an open question in the handbook |
| 9 | **Next.js 16 upgrade** | A series of sub-PRs (details below) | 3–5 days plus about 1 week on staging | None | Sign-in and session, PDF layout, Sentry, lint tools. Freeze other merges during the soak. Target: on Next 16 by mid-November |

PR 9 sub-PRs, in order:
1. next-auth to beta.30 or later, landed on Next 14 first.
2. Next 16 and React 19 with the code-migration tools. Page and route inputs become asynchronous, and `middleware.ts` becomes `proxy.ts`.
3. Sentry 10.
4. `@react-pdf/renderer` 4 and a newer `lucide-react`.
5. ESLint 9, because `next lint` is removed in 16.

## Owner decisions

**A. From the verified findings**

| # | Decision | Recommended default |
|---|---|---|
| 1 | Next.js target version | **16.x latest patch.** Not 15: its support ends 21 Oct 2026 |
| 2 | Upgrade window | One staging week, with no other merges during it |
| 3 | Auth library | Stay on next-auth v5 (newest beta that supports Next 16). Going back to v4 is more work |
| 4 | Rule until the upgrade | No Server Actions (`'use server'`), enforced in CI. If the app is run on the Windows PC, bind it to localhost: one of the new critical flaws only affects Windows hosts |
| 5 | Deploy health gate (F15) | Fail on definite misconfiguration: token missing, or the solver answers 401 or "not configured". If the solver is only unreachable, report "degraded" and alert, but don't block the deploy |
| 6 | Duplicate rows (F02) | Lowest priority number wins, keep all distinct notes, show a warning rather than rejecting the file. Also ask NMWC IT whether the ERP can ever repeat the same sales order and product |
| 7 | Deleting depots (F03) | Deactivate only, once anything refers to the depot; the database enforces it |
| 8 | Deleting drivers (F20) | Always deactivate; never hard-delete from the screen |
| 9 | Blank unloading time (F07) | Blank means "use the customer-type or Settings default", not confirmed. An explicit 0 is still allowed. The dialog sends only the fields the dispatcher changed |
| 10 | Clearing optional fields (F26) | A field left out of a save stays unchanged; an empty value clears it |
| 11 | Platform admin on other companies' pages (F12) | Read-only, as SECURITY.md already says. No company switch for now |
| 12 | Legacy runs and `/optimize` (F14, F18) | Retire them: read-only runs, endpoint removed |
| 13 | Depot pin moved after planning (E1) | Locked and dispatched loads keep the origin they were planned from, with a "depot moved since planning" note |
| 14 | Overtime already worked (E4) | The optimizer counts only new cost. If NMWC wants to spare drivers already in overtime, add a visible penalty setting, off by default |
| 15 | Payload margin (F08) | No hidden rounding margin. Optional per-truck reserve in kg, default 0 |
| 16 | Upload limits (E2) | Keep 10 MB and 50k rows. Add caps of 50 MB unpacked and about 10 sheets. Check against NMWC's largest real files |
| 17 | "Reset stuck plan" button (F09) | Yes: supervisors only, recorded in the audit log |
| 18 | Email password reset (F10) | Keep it off until PR 4 lands |

**B. Operational policies the auditor raised**

| # | Policy | Recommended default |
|---|---|---|
| 19 | Hold for a truck breakdown, an unavailable driver or a customer stoppage | Add an "On hold" state for trucks, drivers and customers, separate from "Inactive". It blocks lock, loading and dispatch for the affected loads, keeps history, and a supervisor can override with a reason. Setting a record inactive does not stop an existing plan today |
| 20 | Truck payload corrected after planning | Block lock, loading and dispatch of a load that hasn't left if it exceeds the truck's current payload; supervisor override with a reason. For loads already gone, a warning only. Today this is a warning note only |
| 21 | Planned times going stale while the plan sits in a queue or on screen | At lock or dispatch, if a new load's planned departure is more than 30 minutes in the past, require a re-time or an explicit acknowledgment. Never rewrite frozen or departed loads |
| 22 | Solver worker processes fail to start | In production, fail fast with "planner busy, retry" instead of solving without a deadline (current code does this, `dispatch_solver.py:1426`). The fallback stays for development only |
| 23 | Historical exports | From lock onwards, quantities, kg, times, origin and the customer address as planned are frozen, and exports read the frozen values. Phone numbers stay live on purpose. Show "changed since planning" notes |
| 24 | What the planner assumes about capacity | List what is not modelled on the Excel ASSUMPTIONS sheet and in the handbook: pallet space, customer vehicle access, dock and forklift capacity, helpers, breaks, stock and credit, returns. Add a rule only when NMWC names a real case; the warehouse keeps the physical checks |
| 25 | What a receiving window means | Today unloading must **start** before closing time. Keep that as the default and confirm with the biggest customers. Add a per-customer "must finish by closing" option only if a customer insists. A split delivery gets the full fixed stop time on each visit |
| 26 | Priorities and costs when trucks are short | Priority first. Within the same priority, complete whole orders first, then maximise cases, then cost; margin only as a tie-break. Label truck and driver cost as "allocated", not cash saved. The auditor says a branch's strongest priority can lift all its demand that day (not verified here): accept it, but show it on the plan. Needs NMWC operations and sales sign-off |

## Read-only production checks (owner)

- `SELECT email, role, "tenantId" FROM "User" WHERE role='SUPER_ADMIN'`: this sets how urgent PR 7 is (F12).
- Count orders and upload batches whose `depotId` is NULL (F03).
- Is `RESEND_API_KEY` set on the web service (F10)?
- Does a request for any `/_next/static/chunks/*.js.map` return 404? If not, the source maps are public (side item).
- Is any plan in OPTIMIZING state whose current job is not queued or running (F09)?
- Do any delivery-proof rows exist (F14)?
- Do the solver logs contain "repack UNKNOWN" (E5)?
- How big are NMWC's largest real order and customer files (E2)?

## Where the auditor was wrong or off

**Wrong**

- **F01:** "Matches an advisory" suggests RouteIQ is exposed; it isn't, because it has no Server Actions. The upgrade is needed because 14.x is out of support, and it must target 16 rather than 15.
- **F24:** The auditor tested against the ordinary React release. Production pages run on the React build bundled with Next.js, where the failure shows an error card rather than a false "saved" state.
- **F14:** The auditor calls the stop lock a supervisor control, but any planner can unlock it. NMWC never used the driver app, so real delivery proofs are unlikely to exist.
- **F13:** The auditor says the day banner does warn. That is not true for LOCKED loads, which is the usual case when a driver phones about a wrong pin.

**Overstated.** 18 "medium" items come down to 8 for NMWC. Most downgrades are because the preconditions don't exist here:
- email reset is off (F10);
- there is one depot (F03);
- the order file has no money columns (F04);
- the code is legacy-only (F14, F18);
- the race needs millisecond timing (F11, F20, F21);
- the error is visible to the user (F15);
- the problem is on screen only (F22, F24).

**Understated**

- **F01:** About 20 more Next.js advisories since January have no 14.x fix, including two critical ones from August. Neither applies to Railway production (Linux, no image library installed), but the Windows one does apply if the app is served from the Windows PC. The image endpoint is reachable without login.
- **E2:** Real files freeze the app for 17–38 s, and a crafted 344 KB file is enough.
- **F03:** Orphaned orders cannot be uploaded again ("already confirmed"), so they are effectively lost.
- **F09:** If the stuck plan is a re-plan version, even locked loads can't be marked dispatched.
- **F26:** A region can't be created from the screen without picking a depot.

**Missed (found by the verifiers)**

- F10: the reset link and the admin reset can deadlock each other.
- F02: if the first row has no priority, a P1 on the second row is lost completely.
- F06: the Enter key skips the "busy" guard.
- F07: the Details dialog marks priority and unloading time as confirmed even when nobody touched them.
- F08: a stop left out for weight gets a misleading "re-plan" reason.
- F17: a degrees-only coordinate is treated as exact.
- F18: the legacy cache never retries after the map service recovers.
- F20: deleting a driver silently clears any truck's default driver.
- F03: the depot delete dialog says "will be deactivated", but the API hard-deletes.
- E3: orders weighted at order level show 0 kg on the loading sheet.
- Side item: public source maps.

**Evidence gaps closed.** Everything the auditor could only model was reproduced for real: database cascades and races, full optimizer runs, and the rendered Excel file. Two of the auditor's side claims were also spot-checked and hold:
- The placeholder tenant-isolation tests exist (`tests/tenant-isolation.spec.ts:95`).
- CI runs Postgres 16 while production runs 18. That is real, and already listed in handbook known-issue #13.

Each verifier's own tests and results are in `C:/Users/abdulr/routeiq/.dev/audit-verify/`, one folder per verifier (deps, intake, ui, auth, lifecycle and solver, two each).