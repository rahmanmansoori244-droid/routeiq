# Operational rules 19 to 26: what RouteIQ does today and what is missing

This covers only rules 19 to 26, which the owner accepted on 27 Sep. P7 to P9 are left out, as you asked.

None of the eight rules is fully in place in production. Rules 23 and 25 are about half done. Each rule's evidence is in brackets after the claim. Paths are under `C:/Users/abdulr/routeiq`, at the version production runs (3451f4d). "P6" and "P10" are the two pieces of work already under way, in `C:/Users/abdulr/routeiq-wt-p6` and `C:/Users/abdulr/routeiq-wt-p10`.

## Rule by rule

**19. "On hold" for a truck breakdown, a sick driver or a customer stoppage**
- **Today:** there is only an Active on/off switch, and it only affects the next plan. A locked or loaded load whose truck, driver or customer was switched off can still be dispatched, because the lock, loading and dispatch checks never look at that switch (apps/web/lib/dispatch/plan-service.ts:1984-2054; the checks are at 2010-2014). Only a company admin can switch off a truck or driver (apps/web/app/api/trucks/[id]/route.ts:46).
- **Also today:** a stopped customer's cases on a loaded truck still go out (plan-service.ts:295-298). The screen message wrongly says those orders "will be left unserved" (apps/web/lib/dispatch/open-orders.ts:40).
- **Missing:**
  - an "On hold" state recording who set it, why, from when and until when, and who released it
  - a block on lock, loading and dispatch of every affected load that has not left
  - a supervisor override that needs a written reason
  - hold buttons that dispatchers can use
- **Effort:** about 8 days (7 to 10). Neither P6 nor P10 covers it.

**20. Truck payload corrected after planning**
- **Today:** RouteIQ notices that a load is now heavier than the corrected payload, but only shows a warning (apps/web/lib/dispatch/feasibility.ts:249-265). Lock, loading and dispatch all still go through. The warehouse loading sheet compares against the old payload and prints "OK" (apps/web/lib/dispatch/workbook.ts:59-71, 634).
- **Missing:** a block for loads that have not left, a supervisor override with a written reason, clear wording (for example "weighs 9,800 kg, payload now 8,000 kg"), and a loading sheet that shows the current payload.
- **Effort:** about 4 days. About 1 day less if the override is built once and shared with rule 19.

**21. Planned times go stale before lock or dispatch**
- **Today:** the clock is read only when Optimize or Re-plan is pressed (plan-service.ts:591-604). Lock and Dispatch accept a departure time that passed hours ago, and the timetable still shows "verified". That is because the check compares with the time the plan was made (feasibility.ts:294-311). The handbook already lists this as open (docs/PROJECT_HANDBOOK.md:2828).
- **Missing:** at lock and dispatch, if the departure is more than 30 minutes in the past, offer two choices:
  - re-plan from now (only for loads not yet locked)
  - continue, with the reason recorded

  It also needs a "departure passed" badge on the load. Frozen loads are never re-timed.
- **Effort:** 4 to 5 days. P10 fixes only the time a night plan spends waiting in the queue (routeiq-wt-p10, apps/web/lib/jobs/dispatch-job.ts:100-104).

**22. The planner cannot start its helper processes**
- **Today:** it quietly falls back to running the whole search inside its main process. In that mode there is no hard deadline, and the planner stops answering anything else until it finishes (apps/solver/dispatch_solver.py:1425-1426, with a second fallback at 1482-1487). The only trace is one warning line in the log.
- **Missing:** stop within seconds with "try again in a minute" and keep the previous plan. The web side already handles this cleanly (apps/web/lib/solver-client.ts:90-92). An alert to an administrator is also needed.
- **Effort:** about 1.5 days. P10 keeps the fallback, which would then allow a planner freeze of up to 20 minutes. This fix should ship together with P10.

**23. Exports show the numbers as they were planned**
- **Today:** about half done. Addresses, map pins, receiving hours, truck capacity and times are frozen, and phone numbers stay live as intended (apps/web/lib/dispatch/plan-detail.ts:396-414, 457-466). The loading manifest's cases, kg and product lines are read live (plan-detail.ts:367-371). An older plan exported again after a weight correction can print 600 kg on the lines under a 400 kg load, with no warning. The handbook admits this (docs/PROJECT_HANDBOOK.md:800). Renaming a product rewrites every past manifest.
- **Missing:** store each stop's planned cases, kg and product lines when the plan is applied, and print those. Add "changed since planning" notes for weight and product changes, and keep the notes on older versions.
- **Effort:** about 3.5 days, after P6. P6 already freezes the depot position and adds a MISMATCH warning.

**24. Say what the planner does not check**
- **Today:** the planner checks only cases, kg, receiving hours, shift length, depot hours and turnaround (apps/solver/dispatch_solver.py:696-722). The Excel ASSUMPTIONS sheet never says what is left out (workbook.ts:118-128). Help claims "capacity ... respected" without saying which capacity (apps/web/app/t/[slug]/help/page.tsx:39). The truck form requires a Volume figure that nothing uses (apps/web/app/t/[slug]/trucks/truck-form.tsx:271-281).
- **Missing:** a fixed "Not checked by the planner" list on every ASSUMPTIONS sheet, in the guide and in Help. It covers space and pallets, truck access at the customer, depot loading bays, helpers, breaks, stock, credit, returns and actual return times. Unused fields also need labels.
- **Effort:** 1 to 1.5 days. It is text only and changes no plans.

**25. What a receiving window means**
- **Today:** the planner already applies "unloading must start by closing" everywhere (dispatch_solver.py:719-731, 910-934; feasibility.ts:266-278). The screens say "never outside" instead (apps/web/app/t/[slug]/dispatch/customer-dialog.tsx:139), and nothing shows unloading that runs past closing.
- **Split deliveries:** the fixed stop time is shared in proportion to the cases. A 35-minute stop split 900/200 gets 29 and 6 minutes (apps/web/lib/dispatch/service-time.ts:33-36), so the second truck is planned with far too little time at the dock.
- **Missing:** plain wording everywhere, an "unloading until HH:MM" time with an amber "after closing, call ahead" note, and the full stop time for every split visit.
- **Effort:** 2.5 to 3 days, including a re-run of the planner benchmark.

**26. Priorities and costs when trucks are short**
- **Today:**
  - Priority-first works and is tested (dispatch_solver.py:470-514; apps/solver/tests/test_repack.py:103).
  - Among orders of the same priority, the planner counts stops, not orders or cases. Three small drops can therefore beat one large drop with several invoices (dispatch_solver.py:508-513).
  - One urgent order lifts the whole branch's day to its priority, and the plan never shows this (apps/web/lib/dispatch/intake-server.ts:471, 484-485; plan-service.ts:411-412, 559).
  - Fixed truck cost and driver pay are shown as "X OMR cheaper" (apps/web/lib/dispatch/plan-options.ts:153).
- **Missing:**
  - show the lift, for example "P1, lifted: 480 of 500 cases are P3"
  - correct the "higher priority always wins" wording (docs/DISPATCHER_GUIDE.md:64; workbook.ts:1042)
  - label fixed truck and driver cost as "allocated"
  - later, after sign-off, change how the planner chooses within one priority: whole orders first, then cases, then cost, then margin
- **Effort:** about 7.5 days in total, or 3 days for the visible part alone, which changes no plans.

## Recommended order, biggest real-world risk first

All of this should start after P6 and P10 are merged, because they change the same files.

1. **Rule 20, payload block.** It must be in place before NMWC enters its real truck payloads, which it still owes. On that day, every locked load over its real payload would otherwise leave overweight with an "OK" loading sheet. Build the supervisor override here once, and reuse it for rules 19 and 21. Before release, check production for locked loads that are already over their current payload.
2. **Rule 19, On hold.** Breakdowns, sick calls and customer stoppages are weekly events. Today they depend on people remembering a manual unlock and re-plan sequence, plus a switch that only an admin can use.
3. **Rule 22, stop instead of freezing.** It is small, and it should ship with P10.
4. **Rule 21, stale times.** A late-order plan left on screen can miss a customer's receiving hours while RouteIQ still shows the timetable as checked.
5. **Rule 25, split visits and window wording.** Every split delivery is currently planned with too little time at the dock.
6. **Rule 23, frozen exports.** This matters for disputes and audits. Build it on top of P6.
7. **Rule 26.** Do the visible part first. Change how the planner chooses only after NMWC operations and sales sign off.
8. **Rule 24, the "not checked" list.** It is the cheapest; fold it into the same wording work as rules 25 and 26.

## Total effort

- **Everything as recommended:** about 32 working days (roughly 29 to 38). That is about 6 to 7 weeks for one developer, with the override built once.
- **If rule 26 stops at the visible part:** about 27 to 28 days.
- **Optional extras, not included above:**
  - a "shift this truck's times" action: 2 to 3 days
  - a per-customer "must finish unloading by closing" option: 3 to 4 days
  - making Inactive block loads the way a hold does: about 1 day

## Questions only the owner or NMWC can answer

**Needed before building rules 19, 20 and 21:**
1. Who may put a truck, driver or customer on hold, and who may release it: dispatchers or supervisors only? May sales or finance put a customer on credit hold?
2. Does a hold end by itself (for example "on leave until Thursday"), or only by hand?
3. Who may override a block, and is a supervisor available during evening loading and at early dispatch? Does one override cover lock, loading and dispatch of that load? Must the reason appear on the driver sheet and in the Excel?
4. If a driver is on hold, should the load be blocked, or just need another driver? Should a load ever leave with no driver? Today it can.
5. Should the planner use fewer trucks when drivers are short? Today, with 13 trucks and 11 drivers, it plans all 13.
6. Should "Inactive" also block loads that have not left, or only warn?
7. Who enters the real truck payloads, and when? Is any tolerance allowed before a load is blocked?
8. Is Dispatch pressed when the truck actually leaves, or later as bookkeeping? If later, the late-departure check will fire on almost every truck.
9. Is the normal Re-plan acceptable as the "re-time" step, even though it may move orders between trucks?

**Planner failure (rule 22):**
10. Should RouteIQ retry once by itself, or should the dispatcher press the button again? Who should be alerted? Will the planner ever run in production anywhere other than Railway?

**Exports (rule 23):**
11. Should product names and codes on past manifests stay as planned? Should the driver's name be recorded at dispatch? Should older plans be filled in once from today's values?

**Things the planner does not check (rule 24):**
12. In recent months, has NMWC had a failed or late delivery caused by any of these: space, truck access, a depot queue, helpers, breaks, stock, credit or returns? Only a named case becomes a rule.
13. How many trucks can the depot load at the same time, in the evening and at midday? Are some customers off-limits to large trucks?
14. Who in the warehouse and operations owns the "not checked" list day to day?

**Receiving windows (rule 25):**
15. For the biggest accounts, does "closing" mean "last truck accepted" or "unloading finished"? Who will ask them, and by when?
16. Does a second split truck go through the full queue and paperwork again?
17. Who enters and keeps up the real receiving hours and unloading minutes? Today's figures are placeholders.

**Priorities and costs (rule 26):**
18. Is a "whole order" an ERP sales order or invoice, or the branch's whole delivery for the day? Does the ERP file carry a priority for each sales order?
19. Should "carry the most" be counted in cases, kg or litres?
20. Which costs are real cash on the day and which are allocated? Are the drivers salaried?
21. Is it acceptable that one urgent order lifts the branch's whole day, as long as the plan shows it?
22. Who signs off for operations and for sales, and do they want the visible part first?

---

# Per-rule detail (code evidence)

## 19. Hold for a truck breakdown, an unavailable driver or a customer stoppage

**Recommended default:** Add an "On hold" state for trucks, drivers and customers, separate from "Inactive". A hold blocks lock, loading and dispatch of every affected load that has not left yet. It keeps history: who set it, why, from when, and who released it. A supervisor can override it for one load by giving a reason, and the override is recorded. Accepted by the owner on 27 Sep. Today, setting a record inactive does not stop an existing plan.

**Today:**
Nothing called "On hold" exists anywhere in RouteIQ. The only switch is the old "Active" flag. Here is what that flag does and does not do at commit 3451f4d. Paths are under C:/Users/abdulr/routeiq/apps/web unless noted.

1) STOPPING A LOAD: nothing stops it. Lock, loading and dispatch all go through changeStatusTx (lib/dispatch/plan-service.ts:1984-2054). It checks five things:
- the lifecycle order (lib/dispatch/load-state.ts:42-72)
- the user's role (plan-service.ts:1998)
- that the cases reconcile (plan-service.ts:2000, 2003-2005)
- orders that were brought forward to a later day (plan-service.ts:2010)
- the customer's location (plan-service.ts:2013) and the timetable (plan-service.ts:2014)
It never reads truck.active, driver.active or customer.active. A supervisor can therefore dispatch a load whose truck, driver or customer was deactivated that morning. The only driver check is in setDriverTx (plan-service.ts:2343): it refuses to *pick* an inactive driver, but a driver already on the load stays and the load can still be dispatched. A load can also be dispatched with no driver at all, because changeStatusTx has no driver check. The auditor's probe showed all three cases (truck, driver, customer) passing LOCKED -> LOADING -> DISPATCHED with the timetable gate on "enforce": .dev/audit-2026-09-27/lifecycle/assessment.md:45-60 and deactivation-results.json. That probe ran at commit 83d8174, and the gates added since then (A5 location) still do not look at the Active flag.

2) PLANNING: a record set inactive only drops out of the next optimize or re-plan.
- Inactive trucks are left out of new plans (plan-service.ts:259).
- The PLANNED loads they had are replaced when the new plan is applied (plan-service.ts:1022).
- Inactive drivers are not given new trips (plan-service.ts:993-1006). A trip that loses its driver this way gets a yellow note saying why (lib/dispatch/load-state.ts:205-270).
- Locked, loading and dispatched loads keep their inactive driver on purpose (load-state.ts:225; test tests/lib/dispatch-load-state.spec.ts:368).
- An inactive customer's open orders are marked unserved with the reason INVALID_CUSTOMER, and the plan shows a warning (plan-service.ts:415-429, 636-638).
- But orders already on a locked or loading load are set aside earlier in the same function, before the Active check runs (plan-service.ts:295-298). The comment says "Frozen loads keep theirs". So a stopped customer's goods on a loaded truck still go out.

3) SCREENS:
- The plan screen reads the truck code and capacity and the driver's name and phone, but not whether they are active (lib/dispatch/plan-detail.ts:336-337). A truck set inactive therefore looks normal.
- The only "out of date" note about deactivation is for customers, and only on PLANNED loads (plan-detail.ts:793-828; the check that skips other loads is at line 798).
- The day screen's "out of date, RE-PLAN" prompt has no input for a truck or driver being deactivated (app/t/[slug]/dispatch/dispatch-client.tsx:364-370). Its "trucks changed" count covers capacity and payload only (lib/dispatch/snapshots.ts:314).
- An inactive driver shows "(inactive)" in that load's Driver list, but nothing stops the load (app/t/[slug]/dispatch/plan-view.tsx:1066-1070, 1095).

4) WHO CAN USE THE SWITCH:
- Trucks and drivers can only be changed by a company admin (app/api/trucks/[id]/route.ts:46, 80; app/api/drivers/[id]/route.ts:49, 80). A dispatcher cannot take a broken truck out of service.
- Customers can be switched by a planner (app/api/customers/[id]/route.ts:93).
- The Active flag is a plain yes/no (prisma/schema.prisma:354, 374, 496). It has no reason, no start or end date and no "until". Truck availability hours exist (schema.prisma:349-350), but they apply every day, not to one date.
- The customer deactivation message says the open orders "will be left unserved at the next optimize or re-plan" (lib/dispatch/open-orders.ts:40). That is wrong for orders on locked or loading loads, which it also counts (open-orders.ts:9, status ASSIGNED) and which will actually be delivered.

5) HISTORY: every master-data change writes an audit row with the before and after state (schema.prisma:908-924). Locked loads keep a copy of the truck and customer facts they were planned with (schema.prisma:741, 818). That is the only history there is, and there is no list of holds.

6) OTHER PLACES:
- A late order for an inactive customer is refused (app/api/dispatch/late-order/route.ts:90-94).
- Bringing an order forward to another day is refused for an inactive customer (lib/dispatch/carry-over.ts:314-315).
- The Excel file and the driver sheets print the driver's name with no status (lib/dispatch/workbook.ts:519, 627; lib/dispatch/driver-pack.tsx:434).
- The optimizer (solver) has no idea of drivers at all, only trucks and their hours (apps/solver/dispatch_models.py:56-69). With 13 trucks and 11 drivers it still plans 13 trucks.

7) DOCS:
- The dispatcher guide tells dispatchers to deactivate a driver who is on leave (docs/DISPATCHER_GUIDE.md:124), which only an admin can do.
- The handbook lists "an 'On hold' state for masters (owner policy 19)" as not done (docs/PROJECT_HANDBOOK.md:2893).

What works today, done by hand: an admin deactivates the truck. The dispatcher then moves any loading load back to locked, unlocks the later loads first, and presses Re-plan (plan-view.tsx:404-421). The orders move to other trucks. Nothing forces or guides this sequence, and nothing stops someone skipping it and dispatching.

**Missing:**
- A hold record for trucks, drivers and customers, separate from Active: reason, who set it, when, optional until-date and time, who released it and when. Best as its own table with one row per hold, so past holds stay visible ("keeps history"). This needs a database change: none of the three models has any such field (prisma/schema.prisma:332-382, 478-517).
- A hold check in changeStatusTx next to the location and timetable checks (plan-service.ts:2010-2014), refusing LOCK, LOADING and DISPATCH when the load's truck is on hold, its driver is on hold, or any customer on it is on hold. It needs clear words and a remedy per load status, in the same style as noLocationLoadRemedy (plan-service.ts:2068-2074). Stepping back (unlock, back to locked) and Completed must never be refused, so the owner rule that frozen loads never change still holds.
- Supervisor override with a mandatory reason, for one load and one step. Nothing like this exists today: the timing gate's only override is a switch for the whole server (FEASIBILITY_GATE=warn, plan-service.ts:2287, 2298). It needs a new field on PATCH /api/runs/:id/loads/:loadId (route.ts:7-12) checked against the SUPERVISOR role, an audit row naming the hold and the reason, and an override dialog on the plan screen.
- Planning: leave trucks and drivers on hold out of new plans the way inactive ones are (plan-service.ts:259, 1006). Give orders of a customer on hold a new unserved reason (for example CUSTOMER_ON_HOLD), which needs a change to the UnservedReasonCode list in the database (schema.prisma:126-147). Released holds should bring those orders back at the next re-plan.
- Screens: an "On hold" badge on the load row and on the truck, driver and customer. A day-screen "out of date" count for trucks, drivers and customers on hold that are on PLANNED loads, so RE-PLAN lights up (dispatch-client.tsx:364-370, day-overview.ts). Hold and release buttons that a dispatcher can use; today truck and driver changes are admin-only.
- A decision on Inactive itself. Should deactivating a truck or driver also block their loads that have not left, or at least warn on the plan screen? Today it does neither (plan-detail.ts:336-337). The customer deactivation message should also stop promising that orders on locked loads will be left unserved (open-orders.ts:9, 40).
- Late orders and bring-forward: what to do for a customer on hold (today only Inactive is refused: late-order/route.ts:90-94, carry-over.ts:314-315).
- Exports and history: the Excel file and the driver sheet should carry the override note (who, why) for a load that went out despite a hold. The audit row alone is not visible to the warehouse.
- Tests: unit tests of the check for each status and each kind of hold; database-level tests like tests/integration/master-data-db.spec.ts (hold, re-plan, lock refused, override audited); an entry in the role table (tests/lib/api-role-matrix.spec.ts); screen-wording tests; and updates to the dispatcher guide and handbook, including DISPATCHER_GUIDE.md:124.

**Already in progress:** Neither branch covers this rule. I compared each with origin/main: neither touches changeStatusTx, the load gates, or the Active flag on trucks, drivers or customers.

- C:/Users/abdulr/routeiq-wt-p6 (audit-p6-solver-accuracy, fb1dc7e): this branch keeps each locked or dispatched load's depot origin (E1) and adds a "depot moved since planning" out-of-date count (lib/dispatch/day-overview.ts:83, 256 in that worktree). The same pattern can be reused for "truck, driver or customer on hold since planning".
- C:/Users/abdulr/routeiq-wt-p10 (opt-long-search, ff440ee): this branch helps indirectly. A same-day QUICK re-plan (for example after a morning breakdown) starts at once even while a THOROUGH night plan is running (lib/dispatch/solve-admission.ts:179, start-optimize.ts:296). It also adds a small database migration (RunJob searchMode and heartbeatAt).

Both branches change buildDispatchRequest in lib/dispatch/plan-service.ts, which a hold change must also touch. The hold work should therefore start after P6 and P10 are merged, to avoid conflicts. The handbook already lists "On hold" as a separate, open item (docs/PROJECT_HANDBOOK.md:2893).

**Example:** Truck: at 18:00 the dispatcher plans tomorrow. T07's Load 1 and Load 2 are locked, and Load 1 is loaded that evening (LOADING). At 05:45 T07 won't start. The dispatcher cannot deactivate T07, because only a company admin can (app/api/trucks/[id]/route.ts:46). Even if an admin does it, the plan screen shows T07 as normal (plan-detail.ts:336-337), RE-PLAN is not prompted (dispatch-client.tsx:364-370), and a supervisor on autopilot can still press Dispatched on T07 L1 (plan-service.ts:1984-2054 has no truck check). A plain re-plan leaves T07's locked orders on T07, because orders on frozen loads are skipped (plan-service.ts:295-298). Those customers get nothing unless someone knows to do "back to locked", unlock L2, unlock L1, re-plan, in that order. Then someone must remember to reactivate T07 after the repair.

Driver: Driver 04 calls in sick at 06:00. He is on T03 L1 (loaded) and T03 L2. Nothing stops T03 L1 going out with his name on the driver sheet and WhatsApp link. With no replacement driver the load can go out with "No driver". The guide's advice, "set the driver inactive" (DISPATCHER_GUIDE.md:124), is admin-only and has no end date.

Customer: at 07:30 a hypermarket branch calls: stock-take today, no deliveries (or finance puts it on credit hold). Its order is on T05 L1, locked and loaded. A dispatcher can deactivate the customer. But the plan only warns about PLANNED loads (plan-detail.ts:798), so T05 L1 is dispatched, the driver is turned away at the gate, and the cases come back. Meanwhile the deactivation message wrongly said the orders "will be left unserved" (open-orders.ts:40).

**Effort:** About 8 working days (7 to 10) for a careful change with tests and docs, at this repo's standard of reviews and database-level tests:
- data model, migration, hold and release API with audit and role table: 1.5 days
- planning (leave out held trucks and drivers, new unserved reason for held customers, warnings, out-of-date counts): 1.5 days
- the lock, loading and dispatch check, plus supervisor override with reason, audit, and remedy wording per load status: 2 days
- screens (hold and release on Trucks, Drivers and Customers, badges and override dialog on the plan, day-screen prompt): 2 days
- notes in the Excel file and driver sheet, the late-order and bring-forward decisions, docs and a review round: 1 to 1.5 days
Add about 1 day if the owner also wants Inactive to block loads that have not left, or a driver hold to reduce the number of trucks the optimizer uses.

**Risk:** Medium. The new check sits in the one function every lock, loading and dispatch goes through (plan-service.ts:1984-2054). A bug, or a hold nobody released, could block NMWC's early-morning dispatch. That is why the supervisor override with a reason is part of the default, and a warn-only switch like FEASIBILITY_GATE would be sensible for the first week.

The database changes are:
- a new hold table
- a new value in the UnservedReasonCode list. Adding a value to that list in PostgreSQL cannot simply be rolled back.
Both are safe to add, but a rollback means leaving them in place.

The change must never alter a frozen load. It only refuses the next step. Freeing a held truck's loads still goes through unlock and re-plan, which is the owner's standing rule.

Unless P6 and P10 merge first, expect conflicts in buildDispatchRequest.

The risk of not doing it is higher and very ordinary. Every breakdown, sick call or customer stoppage today depends on people remembering a manual unlock-and-re-plan sequence and an admin-only switch with no end date.

**Owner questions:**
- Who may put a truck, driver or customer on hold and release it: any dispatcher (planner), or supervisors only? Today trucks and drivers can only be changed by a company admin. Should sales or finance be able to put a customer on hold (credit hold)?
- Should a hold have an end (driver on leave until Thursday, truck in the workshop until 14:00) and release itself, or always be released by hand? Is a hold for one day only, or open until released?
- A truck goes on hold with a load already loaded the evening before. Is it enough that RouteIQ blocks the load and tells the dispatcher to unlock it and re-plan, with the warehouse moving the cases by hand? Or do you want a 'move this whole load to truck X' action? Frozen loads never change on their own either way.
- Driver on hold: should it block the load, or only require a different driver on it before lock or dispatch? And should any load be allowed to go out with no driver at all? Today it can.
- When drivers are on hold, should the optimizer plan fewer trucks? Today it has no idea of drivers, so with 13 trucks and 11 drivers it still plans 13 trucks.
- Customer on hold: should its orders on not-yet-planned loads become unserved with the reason 'customer on hold' and come back automatically when released? Should a late order for a held customer be refused, or accepted and kept waiting?
- Supervisor override: which holds may be overridden (all three, or not a truck breakdown)? Is one override good for that one load and step only, or for the whole day? Must the reason also appear on the driver sheet and in the Excel file?
- Should 'Inactive' also block lock, loading and dispatch of loads that have not left, the way a hold does? Or should it stay as today (drops out of the next plan only), with just a warning on the plan screen?
- A truck breaks down on the road with a dispatched load. Should RouteIQ record which stops were not delivered and put them back as open orders? Today a dispatched load can only be marked Completed, so this is a separate, larger rule.

## 20. Truck payload corrected after planning

**Recommended default:** If a load has not left yet (Planned, Locked or Loading) and weighs more than the truck's payload as it stands now in the Trucks list, block Lock, Loading and Dispatch for it. A supervisor can override with a written reason. A load that has already left (Dispatched or Completed) gets a warning only. Owner accepted this on 27 Sep (VERIFIED-ASSESSMENT.md:113).

**Today:**
In short, RouteIQ notices the problem but only warns, and the warehouse's own loading sheet says the load fits. All paths are under C:/Users/abdulr/routeiq at commit 3451f4d.

1) THE CHECK. When a load that has not left carries more than the truck's current payload, the check raises CAPACITY_CHANGED as a WARN, not a BLOCK (apps/web/lib/dispatch/feasibility.ts:249-265). The current payload is read from the Trucks list (apps/web/lib/dispatch/plan-service.ts:1570). Only BLOCK items stop a load: the truck status is computed at feasibility.ts:390-400 and the gate refuses at plan-service.ts:2296-2299. So Lock, Loading and Dispatch all go through. The gate itself runs on all three moves (plan-service.ts:2014; isGatedMove at 1639-1641). The auditor proved this case: a locked 6,000 kg load stays VERIFIED after its truck's payload is corrected from 10,000 to 3,000 kg (.dev/audit-2026-09-27/RouteIQ_Comprehensive_Audit_2026-09-27.md:434). Existing tests lock in this warning-only behaviour (apps/web/tests/lib/dispatch-feasibility.spec.ts:459-464; apps/web/tests/lib/plan-feasibility-gate.spec.ts:364-372).
Other weight problems already block:
- a load heavier than the payload it was planned with (CAPACITY_KG, feasibility.ts:220-223);
- a load that becomes too heavy once a product weight is entered later (CAPACITY_KG_NEW_WEIGHT, feasibility.ts:230-236).
Only a correction on the truck side is soft.

2) LOADS ALREADY GONE. The check skips them entirely (`!l.onRoad`, feasibility.ts:252). They only get:
- the general orange 'Changed after planning' badge (plan-detail.ts:487; app/t/[slug]/dispatch/plan-view.tsx:829-837);
- a plan note saying 're-plan to use the new one' (plan-detail.ts:763). That advice cannot apply to a truck already on the road.

3) SCREENS.
- The warning appears as an amber line in a box that shows only the first 6 warnings (plan-view.tsx:499-507), plus a badge whose detail is in a hover tooltip.
- The step-3 'plan out of date, RE-PLAN' banner counts only trucks with Planned loads (apps/web/lib/dispatch/day-overview.ts:234-245). A locked load over the new payload does not make the day look out of date.
- Saving a lower payload on the truck writes an audit row but says nothing about loads already planned on that truck (apps/web/app/api/trucks/[id]/route.ts:33-44).

4) EXPORTS.
- The Excel SUMMARY sheet lists 'CAPACITY_CHANGED (warning)' and the note (workbook.ts:451-455, 479-485).
- The LOAD PLAN sheet's 'Payload kg' and 'Kg check' columns, and the per-truck loading sheet ('Weight / payload kg'), use the payload the load was planned with (plan-detail.ts:463) and print 'OK' (apps/web/lib/dispatch/workbook.ts:59-71, 520, 634).
- No NOT VERIFIED header is printed, because the truck still passes (workbook.ts:617-619).
- Driver PDF sheets show cases only, no kg (driver-pack.tsx:443).

5) OPTIMIZER. This part is correct. A re-plan sends the corrected payload for new loads (plan-service.ts:571-589), and the optimizer checks new loads against it (apps/solver/feasibility.py:151-153). Locked and dispatched loads are sent as fixed trips (times and cases only, plan-service.ts:583-588) and kept unchanged, which matches the 'frozen loads never change' rule.

6) OVERRIDE. There is no per-load override. The only bypass is the company-wide emergency switch FEASIBILITY_GATE=warn (feasibility.ts:434; plan-service.ts:2298-2328). It switches off every payload and timetable block for everyone and leaves a trace only in the audit row. The only other 'override' in the product is the legacy run unlock, which has no reason field (app/api/runs/[id]/unlock/route.ts:34-46).

**Missing:**
- Make CAPACITY_CHANGED block instead of warn for Planned, Locked and Loading loads, so Lock, Loading and Dispatch are refused while a load is over the truck's current payload. This is essentially one severity change at feasibility.ts:256-264. The existing remedy text that names the unlock order (feasibility.ts:163-169) already fits.
- A supervisor override with a written reason. Nothing like it exists. It needs: a stored record per load (who, when, reason, and the payload it was granted against, so a second correction blocks again); an API only supervisors and company admins can call; copying the override to the load's copy when the day is re-planned (createNextVersion copies loads); the gate treating an overridden block as a recorded warning; and a new audit action. This means a small database migration.
- Payload-specific wording. Today a refusal says 'Truck T03: the timetable is not verified' (plan-service.ts:2308) and the badge says 'Times not verified'. For this case it should say something like 'T03 L1 weighs 9,800 kg; T03's payload is now 8,000 kg'.
- Screen: an Override button with a reason box for supervisors on the blocked load, and the override shown on the load afterwards. The step-3 'out of date' banner should also count Locked and Loading loads that are over the new payload, not only Planned ones (day-overview.ts:234-245).
- Excel: the 'Kg check' on the LOAD PLAN sheet and on the per-truck loading sheet should also compare with the current payload and print 'OVER CURRENT PAYLOAD (now X kg)' or 'OVERRIDDEN by <name>: <reason>' (workbook.ts:59-71, 634). The planned payload stays as the historical figure.
- Loads already gone: add an explicit history warning ('left with X kg; the truck's payload is now Y kg'), and stop the plan note from telling the dispatcher to re-plan them (plan-detail.ts:763).
- Truck form: when an admin lowers a payload below a load that has not left, list the loads that will now be held (trucks/[id]/route.ts:33-44). Also consider refusing a payload of 0 ('no limit') while loads are planned on the truck (feasibility.ts:254).
- Tests: change the warning-only tests listed above. Add tests for the block on each move (lock, loading, dispatch), the override being supervisor-only (api-role-matrix), the override surviving a re-plan, a block again after a second correction, the warning on a departed load, and the Excel text. Add one real-Postgres integration run.
- Docs: update PROJECT_HANDBOOK.md:958 and DISPATCHER_GUIDE.md:108, which both currently describe a warning.
- Pre-deploy check: query production for Locked or Loading loads already over their truck's current payload. They will be held the moment this ships.

**Already in progress:** Neither branch covers this rule.

audit-p6-solver-accuracy (C:/Users/abdulr/routeiq-wt-p6, fb1dc7e):
- It changes how kilograms are compared: weights in 0.1 kg, payload rounded down to 0.1 kg (weights.ts payloadTenths), and each stop's kg rounded in feasibilityInputFromRows. The new block must be built on top of it so it uses the same arithmetic.
- It does not touch CAPACITY_CHANGED or add any override. Its only capacity-related test checks that the 'Truck capacity changed' note stays hidden when the depot pin moved.
- It records decision 15's per-truck payload reserve as designed but not built (handbook section 7.5). If NMWC ever wants a reserve, 'current payload' in this rule should mean payload minus reserve.

opt-long-search (C:/Users/abdulr/routeiq-wt-p10, ff440ee):
- It touches neither payload nor overrides.
- It edits the same files (plan-service.ts, plan-detail.ts, day-overview.ts, workbook.ts) and adds its own migration (RunJob.searchMode, heartbeatAt). This work should start after both branches merge.

Related: decision 19 (On hold) also needs a 'supervisor override with a reason', and decision 21 needs a similar acknowledgment. Building the override once and reusing it saves about a day.

**Example:** According to the project notes, RouteIQ currently holds NMWC trucks at 10 t payload, and plans fill them to about 98% by weight. NMWC has not yet supplied the real payloads.

Example: on the evening of 28 Sep the dispatcher plans 29 Sep and locks T03 L1 at 9,800 kg. The warehouse loads it overnight. Next morning the fleet admin enters T03's real registered payload of 8,000 kg.

What RouteIQ does today:
- It adds an amber line and a 'Changed after planning' badge.
- At 06:00 the supervisor presses Dispatch and RouteIQ accepts it (feasibility.ts:256-264 is only a warning).
- The warehouse's Excel loading sheet still reads '9,800 / 10000', with Kg check 'OK' (workbook.ts:634, 59-71).

T03 leaves about 1.8 t over its real payload. The same happens to every locked load at once on the day NMWC's real payloads are entered.

With the rule in place: T03 L1 cannot be dispatched. The team can put it back to Planned and re-plan, which moves the surplus orders to other trucks or leaves them unserved, and unload the extra cases. Or a supervisor can override with a reason, for example 'the 8 t was a typing error, the registration card says 10 t'.

**Effort:** About 4 developer days (3.5 to 4.5), tests and docs included:
- 1 day: the block, the wording and the warning for loads already gone.
- 1.5 to 2 days: the supervisor override (migration, API, reason dialog, audit, carried through re-plans).
- 0.5 to 1 day: Excel columns, the step-3 banner and the notice on the truck form.

About 1 day less if the override is built once, together with decision 19 (On hold).

**Risk:** Low technical risk, medium operational risk.

Technically this is a severity change in a check that already runs on every Lock, Loading and Dispatch, plus a small new table for overrides.

Operational points:
- (a) The day it ships, any load already locked over a corrected payload is held. Check production first.
- (b) The gate works per truck-day, so a later load on the same truck that still fits is also held until the heavy load is dealt with. Loads go out in order anyway.
- (c) Trucks are loaded the evening before. A correction made at night or at 06:00 can hold a loaded truck, and a supervisor must be reachable to unload and re-plan or to override, or the morning start slips.
- (d) Overrides can become a rubber stamp. Show them on the plan and in the Excel so they stay visible.
- (e) A payload of 0 means 'no limit' (feasibility.ts:254). Clearing a truck's payload quietly removes the check.
- (f) The company-wide FEASIBILITY_GATE=warn emergency switch would also switch this rule off.

**Owner questions:**
- Who may override: supervisors and company admins only, not planners? Is a supervisor on duty in the evening when trucks are loaded, and at the early-morning dispatch?
- Should one override cover Lock, Loading and Dispatch of that load until the payload changes again (recommended), or must each step be overridden separately?
- Should a lowered case capacity (cases per truck, not only kg) block the same way? Today's warning treats both alike.
- Should there be any tolerance before blocking (for example 1%), or should any amount over the current payload block, as decision 15 ('no hidden margin') suggests? Today only a 0.5 kg rounding tolerance exists.
- Should the reason be free text, or a short pick-list plus text? Example options: 'payload was entered wrongly', 'weighed at the weighbridge, within limit', 'excess unloaded'.
- Who enters the real truck payloads NMWC still owes, and when? Should they be entered when no loads are locked, or do we accept that the first correction will hold locked loads?
- For a load that already left over the corrected payload: a warning on the plan only, or also a line in a report or a notification so someone follows up?
- Should the truck form refuse clearing a payload (0 = no limit) while loads are planned on that truck?

## 21. Planned times go stale while the plan waits in a queue or on screen. At lock or dispatch, if a new load's planned departure is more than 30 minutes in the past, require a re-time or an explicit acknowledgment. Never rewrite frozen or departed loads. (VERIFIED-ASSESSMENT.md:114; the auditor's text is at RouteIQ_Comprehensive_Audit_2026-09-27.md:435: "Refresh the planning origin before execution and detect elapsed new departures without rewriting frozen movements.")

**Recommended default:** Lock and Dispatch compare the load's planned departure (its day plus the depart time, in Muscat time) with the clock. If it is more than 30 minutes in the past, RouteIQ stops and offers two choices:
(a) Re-time: for a PLANNED load, run Re-plan from now.
(b) Continue anyway: an explicit acknowledgment, with a reason, recorded in the audit log.

A locked, loading or dispatched load is never re-timed automatically.

**Today:**
In short, RouteIQ reads the clock once, when the Optimize or Re-plan button is pressed. It never reads it again. Lock, Loading and Dispatch accept any planned departure, even one hours in the past, without a word. Screens and exports keep showing the old times.

1. The clock is read only when the plan request is built. plan-service.ts:591-604 computes "planned from" (now + turnaround) and loading_from_min (now) from `now`, and plan-service.ts:631-632 sends them to the solver. start-optimize.ts:335 builds the request when the button is pressed and start-optimize.ts:389 stores it. dispatch-job.ts:62 then waits for a solver slot, and dispatch-job.ts:73 sends that same stored request unchanged. The handbook says so: PROJECT_HANDBOOK.md:2461 ("now" is when the optimization starts; "a queued job does not move it"; there is no manual "plan from" time).

2. Lock, Loading and Dispatch never look at the clock. changeStatusTx (plan-service.ts:1984-2054) runs these gates:
- the load order: load-state.ts:42-72
- the plan must be applied: :1995
- the role: :1998
- the case reconciliation: :2000, :2003
- orders carried to another day: :2010
- the location rule: :2013
- the timetable check: :2014

None of them compares departMin with the current time. The only use of `now` is the word "today" in the carried-orders message (:2270).

3. The timetable check does not catch it either. timingGate (plan-service.ts:2290-2329) calls checkPlanFeasibility. In feasibility.ts:193 the `now` argument is used only for `checkedAt` (:422). The same-day rule (feasibility.ts:294-311) checks departures against the time the plan was MADE (rules.loadingFromMin), not against the time of the lock. So a load planned for 10:35 and locked at 11:20 still shows VERIFIED.

4. The handbook already lists this as open. PROJECT_HANDBOOK.md:2828: "a LOCKED load whose departure is already in the past keeps its time without a note".

5. There is no way to acknowledge a late load. The load API accepts only `status` and `driverId` (app/api/runs/[id]/loads/[loadId]/route.ts:7-12). A pattern to copy exists for Optimize: the server answers 409 and the dispatcher resends with an explicit override, like allowMissingLocations (start-optimize.ts:31-36, 124-149).

6. The screen gives no warning. setStatus (plan-view.tsx:176-193) sends the change with no confirmation. "Lock all loads" (:227-248) locks every PLANNED load in a loop. The load row shows "depart → return" with no "passed" marker (:841). The Lock and Dispatch buttons are disabled only for reconciliation or timetable problems (:1170-1200).

7. Exports keep the planned times. The WhatsApp text says "Depart hh:mm" (driver-links.ts:143). The driver sheet (driver-pack.tsx:198, 213) and the workbook (workbook.ts:520, 628, 688) print the planned departure. No field stores when the truck actually left; the only trace is statusChangedAt (schema.prisma:748), which is not compared with departMin (:726) or shown.

8. The solver has no clock. It only receives loading_from_min (dispatch_models.py:118; dispatch_solver.py:220-221).

9. There is no re-time action. The only way to move times is Re-plan: a new version planned from now (DISPATCHER_GUIDE.md:151). With no late order waiting, Re-plan is a full re-optimize that may move orders to other trucks (DISPATCHER_GUIDE.md:161). The solver has an exact per-truck re-timer, load_repack.time_plan (load_repack.py:416), but it is internal and has no endpoint.

**Missing:**
- A check for a departure that has passed: the plan's date plus departMin against the clock in the company timezone (the helpers exist: time.ts:30 localMinutes, plan-from.ts:74 planDayNowMin). It needs a 30-minute threshold, and a load on a past day always counts as passed. Nothing like this exists today.
- A gate in changeStatusTx next to the other gates (plan-service.ts:2010-2014) for PLANNED to LOCKED and for LOCKED/LOADING to DISPATCHED. It would answer 409 with a new code (for example DEPARTURE_PASSED), the minutes late, and a remedy that depends on the status: a PLANNED load can be re-planned from now; a LOCKED or LOADING load can only be acknowledged, never rewritten.
- An acknowledgment field on PATCH /api/runs/:id/loads/:loadId (route.ts:7-12 accepts only status and driverId), for example acknowledgeLateDeparture plus a reason. The load's audit row (plan-service.ts:2040-2051) should record it: who, when, the planned time, the actual time and the minutes late.
- Screen changes: a 'Departure passed' badge on the load row (plan-view.tsx:804-842). On a 409, a dialog offering 'Re-plan from now' or 'Lock/Dispatch anyway' with a reason. 'Lock all loads' (plan-view.tsx:227-248) needs one acknowledgment for the whole batch instead of stopping at the first refusal.
- A re-time path. Today the only option is a full Re-plan. It works, but it can move orders between trucks. A narrow 'shift this truck's PLANNED loads to now' does not exist; it would need a new solver endpoint around load_repack.time_plan or a web-side recomputation.
- Exports after an acknowledgment: the WhatsApp text, driver sheet and workbook still show the stale departure and arrival times, with no 'left late' note. No field stores the actual departure; only statusChangedAt exists.
- The queue part: on main, every job keeps the clock from when the button was pressed while it waits for a solver slot. p10 fixes this only for Thorough jobs; Quick jobs are still sent as built.
- Tests: unit tests for the check (timezone, midnight, past and future days, exactly 30 minutes); gate tests in plan-feasibility-gate.spec.ts and dispatch-load-state.spec.ts; an integration test with a fixed clock (updateLoad already accepts opts.now, plan-service.ts:1959) in dispatch-timing.spec.ts or same-day-plan-db.spec.ts. Docs: close the item in PROJECT_HANDBOOK.md:2828 and add a dispatcher-guide paragraph.

**Already in progress:** p10 (C:/Users/abdulr/routeiq-wt-p10, branch opt-long-search) covers part of the queue side only:
- For a same-day THOROUGH job, the job re-reads the clock when it actually starts, after any wait for a slot (lib/jobs/dispatch-job.ts:100-104 calls retimeSameDay, plan-service.ts:195-221 in that worktree, using sameDayTiming in plan-from.ts:137).
- It then plans from the job start + the up-to-20-minute search cap + the turnaround. For example: "Planned from 09:50 (now 09:00 + up to 20 min Thorough search + 30 min preparation)".
- QUICK jobs are still sent exactly as built. The branch's own comment at dispatch-job.ts:102-103 says so. In practice NMWC's Quick solves take about 30-60 seconds and wait only behind another Quick one, so the error there is small.

p10 does not change changeStatusTx, feasibility.ts or load-state.ts. That means no check at Lock or Dispatch and no acknowledgment, and nothing about a plan sitting on screen for an hour before Lock.

p6 (C:/Users/abdulr/routeiq-wt-p6, branch audit-p6-solver-accuracy): nothing relevant. Its diff touches none of plan-from, the lock/dispatch gates or feasibility. Its E1 change (locked loads keep the depot they were planned from) follows the same "never rewrite frozen loads" principle but has nothing to do with the clock.

**Example:** Case 1, late order (the case the rule targets):
- 10:05. A hospital phones in a late order. The dispatcher presses Re-plan (Quick). The plan says "Planned from 10:35". T07 gets a new Load 2: leave 10:35, the hospital (receiving hours until 12:00) at 11:40, then two shops.
- She is pulled away by a breakdown call. At 11:20 she presses Lock and the warehouse starts loading. At 11:35 the supervisor presses Dispatch.
- RouteIQ accepts both. The timetable check compares against 10:05, when the plan was made, so it shows VERIFIED. The WhatsApp message and driver sheet tell the driver "Depart 10:35" and hospital "11:40".
- In reality the truck leaves an hour late and reaches the hospital around 12:40, after receiving has closed. The delivery comes back.
- With the rule, the Lock at 11:20 (45 minutes past 10:35) would have stopped her with a choice. She could re-plan from now: RouteIQ would then see the hospital cannot be reached by 12:00 and put it on another truck or the unserved list. Or she could lock anyway with a recorded reason, knowing the times are wrong.

Case 2, morning dispatch:
- T03 Load 1 was loaded the evening before (LOADING) and is planned to leave at 06:00. The driver arrives at 06:50 and the supervisor dispatches at 06:55.
- The load is frozen, so re-timing is not allowed. The rule would only ask for an acknowledgment and record that it left 55 minutes late.
- Today nothing is recorded. T03 Load 2 (planned 10:30) can no longer make its time because Load 1 comes back later. The recommended default does not cover that follow-on effect.

**Effort:** 4-5 days for the recommended default, with tests and docs. That covers the check, the server gate with a 409 and an acknowledgment recorded in the audit log, the badge and dialog on the plan screen including Lock all, and the existing Re-plan used as the re-time path. Add 2-3 days for a narrow "re-time this truck from now" action that keeps its stops, if the owner wants one. Add about 0.5 day to extend p10's job-start re-timing to Quick jobs once p10 is merged.

**Risk:** Medium-low technically, medium operationally.

Technical:
- No database migration is needed if the acknowledgment lives in the audit row. An optional "left at" column would be additive.
- The main code risk is timezone and midnight mistakes, because the server runs in UTC and NMWC in Muscat. The existing helpers (planDayNowMin, todayIso) and the testable clock (opts.now) reduce this.
- The gate runs under the plan's row lock like the others, so no new race is expected.

Operational:
- If supervisors press Dispatch in RouteIQ after the trucks have already left, for example marking all 13 at 08:00, every truck will ask for an acknowledgment. The prompts become noise and people click through them. A batch acknowledgment or a "left at" entry reduces that.
- A careless default could also block the morning run. The gate must never block a frozen load; it should only ask.
- Decide whether the emergency switch FEASIBILITY_GATE=warn should also switch this check off.

**Owner questions:**
- At Dispatch the load is already locked or loaded (NMWC loads the evening before), and it must never be rewritten. Is an acknowledgment with a reason enough at Dispatch? Should RouteIQ also record the actual leaving time, or does the audit time do?
- Is Dispatch pressed in RouteIQ when the truck really leaves, or later as bookkeeping? If later, the check fires on almost every truck. Would you prefer a 'left at hh:mm' entry, or one acknowledgment for several trucks at once?
- Who may acknowledge: any planner at Lock and a supervisor at Dispatch (the current roles), or a supervisor only?
- Is 30 minutes fixed, or should it follow the Turnaround setting (30 today)? Should Loading (the warehouse starting to load) also be checked, or only Lock and Dispatch?
- Is the existing Re-plan acceptable as the re-time step? It builds a new version from now and may move orders to other trucks. Or do you want a narrower 'shift this truck's times from now, same stops' action (2-3 extra days)?
- After an acknowledged late Lock or Dispatch, should driver sheets and WhatsApp show new estimated times, or the planned times plus a 'left late' note? Decision 23 freezes planned values in exports.
- A late first load makes the same truck's later PLANNED loads late too. Should RouteIQ flag or block those loads, even though their own departure has not passed yet? This is outside the recommended default.
- A plan for a past day, for example locking yesterday's plan after midnight: block it, or treat it as one more acknowledgment?

## 22. Solver worker processes fail to start

**Recommended default:** In production, if the planner cannot start its separate worker processes, it stops within seconds and answers "planner busy, retry". It does not run the search inside the planner's main process with no hard deadline. Running in the main process stays available for development and tests only, through the existing SOLVER_PARALLEL=0 switch. The owner accepted this on 27 Sep (.dev/audit-2026-09-27/VERIFIED-ASSESSMENT.md:115).

Note on that line: it says "(current code does this, dispatch_solver.py:1426)". "This" means the unsafe fallback. Line 1426 is where the code falls back to the main process. Nothing fails fast today.

**Today:**
Production commit 3451f4d does the opposite of the rule. It falls back silently and keeps solving.

1. Where it happens. The planner tries to start its worker processes at apps/solver/dispatch_solver.py:1417-1424. If that raises any error (out of memory, process limit, and so on), line 1425-1426 only writes one WARNING line to the log ("worker processes unavailable ...; solving in-process") and carries on.
   - The recommended plan is then computed inside the planner's own API process (line 1435-1436).
   - The two alternatives run one after the other in that same process, not side by side (lines 1471-1477).
   - The load re-check runs there too (_post_solve with pool=None, lines 1701-1706).
   - A second fallback of the same kind exists at lines 1482-1487. After an alternative overran, fresh workers are started for the load re-check; if they cannot start, the re-check runs in the main process.

2. What is lost in that mode.
   - The hard backstop is gone. The kill-at-deadline logic (_await_worker and _await_all, lines 1342-1389) and the 504 "did not finish in time" only exist on the worker path. The code itself says OR-Tools sometimes ignores its own time limit (lines 1403-1405).
   - The planner API freezes for the whole solve. OR-Tools holds Python's lock (the GIL) during the search, so /health, /ready and /route-geometry stop answering. See the docstring at lines 1399-1401 and the test tests/test_dispatch.py:1114-1134 ("With the search in-process, one 0.2 s sleep here lasted the whole 4 s search").
   - Another company's solve running at the same time cannot check its own deadlines while the lock is held.
   - The time budget is sized for alternatives running in parallel (lines 1446-1452), but in this mode they run one after the other.
   - An out-of-memory kill would take down the whole planner API, and every running solve with it, not just one worker. This is inferred from the design, not tested.

3. The only related guard is for the SOLVER_PARALLEL=0 switch, not for this automatic fallback. apps/solver/main.py:62-76 logs a startup warning (an error on Railway) when the switch is set. The automatic fallback gets only the single WARNING line. The solver has no Sentry, so nobody is alerted.

4. The docs describe the fallback as intended behaviour:
   - docs/PROJECT_HANDBOOK.md:1596 ("If the pool cannot start ... everything runs in-process with no deadlines")
   - docs/OPTIMIZER_BENCHMARK.md:42
   - apps/solver/README.md:28 ("The solver falls back to it automatically when worker processes cannot start")

5. What the dispatcher would see after a fail-fast change: the web side already handles a 503 well.
   - apps/web/lib/solver-client.ts:90-92 turns any solver 503 into "The route optimizer is busy with other plans right now. Optimize again in a minute."
   - apps/web/lib/jobs/dispatch-job.ts:242-270 marks the job and that plan version FAILED, with an audit row.
   - The screen shows "Optimization failed - previous plan kept ... Re-plan to try again" (apps/web/app/t/[slug]/dispatch/plan-view.tsx:456-464).
   - A failed re-plan leaves the previous plan usable, and locked or dispatched loads untouched (apps/web/lib/dispatch/start-optimize.ts:445-453).
   - apps/solver/main.py:147-160 already answers 503 with Retry-After: 60 when both planner slots are full.
   - There is no automatic retry. The dispatcher presses the button again.

6. Where the check sits. The pool is started only after the road-distance matrix has been fetched (lines 1181-1190, then 1199). That fetch can take up to 90 s (MATRIX_BUDGET_CAP_SEC, line 109), so even a fail-fast check at that point would not be quick.

7. Exports and the Excel file are not involved.

**Missing:**
- In production, stop instead of falling back. When the worker pool cannot start (dispatch_solver.py:1424-1426), raise a clear 'planner unavailable' error unless SOLVER_PARALLEL=0 is set explicitly. SOLVER_PARALLEL=0 then stays the development and test path; the solver tests already use it (for example tests/test_repack.py and tests/test_feasibility.py).
- Map that error to HTTP 503 with Retry-After in apps/solver/main.py, next to the existing 'Solver busy' 503 at lines 147-160. Give it its own detail or code, so the logs and the web can tell 'could not start workers' apart from 'both slots in use'. Today the only abort answer is 504 (main.py:166-168).
- A decision for the second fallback: fresh workers for the load re-check after an alternative overran (lines 1482-1487). Failing the whole solve would throw away a finished recommended plan. The safer production choice is to skip the CP-SAT re-check and use the existing fast exact re-timing (_retime_fallback, dispatch_solver.py:1619+, milliseconds in the main process), with a note. Either way, no CP-SAT solve runs in the main process.
- Check or start the worker pool before the road matrix is fetched, so the dispatcher learns within seconds, not after up to 90 s of matrix work (dispatch_solver.py:109, 1181-1199).
- Clean up after a partly failed start. The message queue made at dispatch_solver.py:1306 is left behind if the Pool at line 1307 then fails. The auditor asked for this cleanup (.dev/audit-2026-09-27/solver/findings.md:35).
- Make the failure visible. Today it is one WARNING line and the solver has no Sentry. Needed: an ERROR log line. Optional: /ready reports 'degraded' for a few minutes after a failed pool start, so the web's /api/health shows it.
- Web wording. solver-client.ts:90-92 says 'busy with other plans', which is not quite true when the machine could not start processes. Use a separate message such as 'The planner could not start right now; your previous plan is kept. Try again in a minute.' Optionally one automatic retry.
- Tests. Make the worker start raise OSError, then prove that: the answer is 503 within seconds and no search runs in the main process; SOLVER_PARALLEL=0 is unchanged; a failed replacement pool keeps the recommended plan without a CP-SAT solve in the main process; the planner slot is released; the web records FAILED and a re-plan keeps the previous plan. No test covers the automatic fallback today (grep of apps/solver/tests finds none).
- Docs. docs/PROJECT_HANDBOOK.md:1596 and the failure-handling list at 1607-1614, docs/OPTIMIZER_BENCHMARK.md:42, apps/solver/README.md:28, docs/admin.md:126, and the 'Busy optimizer' paragraph in docs/DISPATCHER_GUIDE.md:172.
- A related gap the rule does not cover. A worker that starts and then dies before it picks up its job is noticed only at the deadline, up to 2x the time limit + 60 s for the recommended plan (dispatch_solver.py:1347, 1438). That is slow, but it is bounded and not silent, so it can stay as it is.

**Already in progress:** Neither branch implements the rule. One of them (p10) edits exactly these lines and makes the gap more costly.

- p6 (routeiq-wt-p6, branch audit-p6-solver-accuracy). `git diff origin/main...HEAD -- apps/solver` shows no change to the worker pool, the fallback or main.py. It only covers solver accuracy (F08, E4, E5, E3, F22, F23, E1). No overlap.

- p10 (routeiq-wt-p10, branch opt-long-search). It keeps both fallbacks: dispatch_solver.py:1755 ("solving in-process") and 1836 ("load re-check in-process"). It also rewrites the code around them, so any change for this rule will conflict with p10. Build it on top of p10, or after p10 merges. Specific points:
  - Long runs. THOROUGH night plans get up to THOROUGH_MAX_SEC = 1200 s (p10 dispatch_solver.py:128). A fallback into the main process can therefore last up to 20 minutes instead of about 9.
  - Stop works, cancel does not. p10 lets a main-process search see a 'use best plan so far' stop (line 1760, tested with SOLVER_PARALLEL=0 in tests/test_search_modes.py). But cancel(), used when the web restarts mid-solve, only sets `cancelled` (lines 310-312). The only code that checks `cancelled` is _await_all (line 1667), which the main-process path never uses. So a main-process night plan whose caller has gone keeps searching for nobody and holds a planner slot.
  - Error handling. p10 makes the endpoint async and turns any error other than SolveAborted into a 500 (p10 main.py:194-203). The new 'planner unavailable' error must be handled there explicitly.
  - p10's 503 handling in solver-client.ts is unchanged.

**Example:** The evening before 29 Sep, around 19:30, the dispatcher presses Optimize for tomorrow. The day is the size of the real 28 Sep: 88 orders, 13,616 cases, 13 trucks. With p10 this is a Thorough night plan of up to 20 minutes.

At the same moment the planner machine on Railway is short of memory. That could be another company's solve with its own worker processes, or workers from an earlier solve that are still shutting down. So the new worker processes cannot start.

**Today:** one WARNING line goes into the solver log, and the whole search runs inside the planner's main process:
- The planner stops answering /health and /ready, so the web's health page shows the solver as degraded or unreachable.
- Road lines on any open plan map fall back to straight lines after the 15 s timeout.
- The other company's solve cannot check its own deadlines.
- If OR-Tools overruns its time limit, nothing stops it. The web gives up after 600 s (solver-client.ts:19) and marks the plan FAILED, while the planner keeps working and holding a slot.
- If memory really is exhausted, the main process can be killed, taking every running solve with it.

**With the rule:** within seconds the dispatcher sees "The planner could not start right now - try again in a minute". The other solve finishes normally, and pressing Optimize a minute later works once memory frees up.

**During the day:** a late P1 order arrives at 11:00 and the supervisor presses Re-plan. The same failure costs one extra click. The previous plan stays on screen and can still be locked and dispatched as it is (plan-view.tsx:460), and frozen, locked and dispatched loads are never touched.

**Effort:** About 1.5 days, including tests and docs:
- Solver change, 503 mapping and the second-fallback decision: 0.5 day
- Solver and API tests (worker start made to fail, SOLVER_PARALLEL=0 unchanged, slot released) plus web message and test: 0.5 day
- Docs, and rebasing onto p10's changes to the same lines and the async endpoint: 0.5 day

Optional extras:
- /ready 'degraded' after a failed start: +0.25 day
- One automatic retry on the web side: +0.5 day

**Risk:** Low.

The change only affects an error path that has probably never run in production. The owner can check by searching the solver logs on Railway for "worker processes unavailable". The normal path, with workers, stays the same, and CI already runs real spawned workers.

Trade-offs to know about:
1. A brief resource hiccup that today ends in a slow but successful plan becomes a visible failure the dispatcher has to retry. For a re-plan, the previous plan stays usable.
2. If 'production' were detected by Railway variables alone, a planner running in production on the Windows PC would keep the unsafe fallback. So the switch should be the explicit SOLVER_PARALLEL=0, not the hosting platform.
3. It clashes with p10's edits to the same code, so the order of merges matters.

Risk of doing nothing: medium once p10 lands. A fallback into the main process could then freeze the planner for up to 20 minutes, and cancelling would not work.

**Owner questions:**
- When the planner cannot start, should Optimize and Re-plan fail within seconds with 'try again in a minute' (the previous plan kept), rather than run slowly with the planner frozen? This is the accepted default; please confirm it also applies to Thorough night plans.
- Should RouteIQ retry once by itself after about a minute before showing the failure, or should the dispatcher always press the button again?
- If the planner has already found the recommended plan and only the extra load re-check cannot start: keep that plan with the fast exact timing check and a note (recommended), or fail the whole run?
- What should the dispatcher read: the same 'busy with other plans' message as today, or a separate 'the planner could not start' message?
- Who should be told when this happens (health page, e-mail or Sentry alert to the administrator), and after how many failures in a row?
- What memory and CPU does the solver service have on Railway? This is already an open question in PROJECT_HANDBOOK.md:3156. And do the solver logs so far contain 'worker processes unavailable'?
- Will the planner ever run in production anywhere other than Railway (for example the Windows PC)? This decides whether 'development only' can be tied to the explicit SOLVER_PARALLEL=0 switch alone.

## Decision 23, historical exports. From lock onwards, the quantities, kg, times, depot origin and customer address a load was planned with are frozen, and every export reads those frozen values. Phone numbers stay live on purpose. Where something changed after planning, the plan and its exports show a "changed since planning" note. Sources: C:/Users/abdulr/routeiq/.dev/audit-2026-09-27/VERIFIED-ASSESSMENT.md:116. The auditor's text is RouteIQ_Comprehensive_Audit_2026-09-27.md:437: after later reweighting, old load/stop/manifest kg went from 400/400/400 to 400/600/600.

**Recommended default:** Accepted by the owner on 27 Sep: the numbers on a plan freeze from lock onwards (cases, kg, times, depot origin, customer address as planned), and Excel, PDF and WhatsApp print those frozen numbers. Phone numbers stay live, and so do the customer's access notes, which hold the receiver phone. Any later change in the master data appears as a "changed since planning" note and is never applied silently.

**Today:**
In plain words: about half of the rule is already built. Addresses, pins, hours, truck capacity and times are frozen. Phones are live, as the rule asks. The cases, kg and product lines on the loading manifest are not frozen: every export reads them live from the order and product tables. For the plan in use, one guard in the re-plan code stops a locked load's kg from changing. The loading sheets of older versions can still change.

All paths are under C:/Users/abdulr/routeiq/apps/web at 3451f4d.

1. Every export reads one function. The Excel route calls getPlanDetail (app/api/runs/[id]/export/excel/route.ts:37), and so does the driver-sheet PDF (app/api/runs/[id]/export/pdf/route.ts:35). WhatsApp text and the plan screen use the same data. Fixing that one read path therefore fixes all the outputs.

2. Already frozen (review F08 / PR4 snapshots, lib/dispatch/snapshots.ts:1-20):
- Stop facts: customer code, name, branch, type, pin, receiving hours and **address** come from RouteAssignment.stopSnapshotJson (plan-detail.ts:396-414, 429). They are captured when the plan option is applied (plan-service.ts:1238-1275).
- Truck code and capacities come from PlanLoad.truckSnapshotJson (plan-detail.ts:457-463).
- **Times**: departure, return, ETA, service start and wait are stored columns (schema.prisma:721-735, 791-818). A re-plan copies them unchanged (plan-service.ts:1826-1840) and only ever deletes PLANNED loads (plan-service.ts:1022). Stop moves are refused on dispatch plans (app/api/runs/[id]/routes/[assignmentId]/route.ts:34-35).
- Settings, the plan summary and the reconciliation are stored with the plan (plan-detail.ts:643-645, 740).

3. Live on purpose, as the rule wants:
- Driver phone and name: plan-detail.ts:465-466.
- Customer access notes (the receiver phone lives there; Customer has no phone field): plan-detail.ts:431-433.
- Both are documented in the dispatcher guide (docs/DISPATCHER_GUIDE.md:110).

4. Still live, which is the gap:
- **Cases and kg of a whole-order stop** come from the Order row (`a.portionCases ?? o.totalCases`, `a.portionWeightKg ?? o.totalWeightKg`, plan-detail.ts:369-370). Only split parts store their own figures.
- **The SKU lines on the loading manifest** use the live OrderLine kg and the live product code and name (`rowLines(o.lines, …)`, `ln.product.code/name`, plan-detail.ts:367, 371). The manifest is added up from those lines (plan-detail.ts:485) and printed on the loading sheet (workbook.ts:657-667).
- The load total, by contrast, is a stored number (`l.weightKg`, plan-detail.ts:476). The two can drift apart.
- What changes the order kg: a successful optimize or re-plan writes product-master weights onto the shared Order and OrderLine rows (applyWeightChanges, plan-service.ts:793-812). It skips any order that has a part on a locked, loading or dispatched load *of the version being re-planned* (plan-service.ts:301-318). So the plan in use is protected by that guard, not by a snapshot.
- Superseded versions are not protected. The handbook says so itself (docs/PROJECT_HANDBOOK.md:800): "saved weights may change orders on the superseded parent's PLANNED loads, whose stops then show the new kg". An unlock also makes a once-locked order open again, because LOCKED→PLANNED is allowed (load-state.ts:36). The next re-plan then reweighs it, and every older version where it was locked changes too.
- The auditors reproduced this: load 400 kg, stop 600 kg, manifest 600 kg, no warning (.dev/audit-2026-09-27/prior-evidence/weight/assessment.md, W2).
- **Product code and name** can be edited at any time (app/api/products/[id]/route.ts:13-17). The change rewrites every historical manifest, dispatched ones included.
- **Depot origin** is one pin for the whole plan version, taken from the plan option (plan-detail.ts:355, 638). Locked loads carried into a re-plan are therefore drawn from the new version's depot pin (audit E1). The Excel depot row uses it too (workbook.ts:680-681).
- **The unserved sheet** reads today's customer code and name and today's order kg (plan-detail.ts:531-535).
- The timetable badge is recomputed every time a plan is read, from live kg (plan-service.ts:1581). An old plan's "TIMES NOT VERIFIED" badge can therefore change after a reweigh.

5. "Changed since planning" notes, current state:
- They exist for pin, receiving hours, name, address and truck capacity only (snapshots.ts:191, 248-323). They show under each stop on screen (plan-view.tsx:1283-1288) and in the Excel "Changed after planning" column (workbook.ts:715), and are listed on the PDF sheet (driver-pack.tsx:164).
- There is no note kind for order kg or product changes.
- The plan-level warnings about master changes and outdated weights are switched off on superseded versions (plan-detail.ts:581-582, 700).
- The truck-capacity note is shown on screen but printed in neither Excel nor PDF: those only print stop-level notes (workbook.ts:715, driver-pack.tsx:164).
- On main, the Excel checks manifest *cases* against the load (workbook.ts:670) but not manifest *kg*, so the 400/600 drift prints silently.

6. Solver: not involved. It only plans new loads; frozen loads reach it as fixed facts.

**Missing:**
- Freeze each plan row's own quantities: cases, kg, and the SKU lines (line id, product code, product name, sales order, cases, kg). Store them in the existing stopSnapshotJson when a plan option is applied. No database migration is needed, and the re-plan copy already carries this field forward unchanged (plan-service.ts:1838).
- Read those frozen values everywhere: stops, manifest, SKU LOADING SUMMARY sheet, driver sheets and WhatsApp (plan-detail.ts:367-371, 485). Rows planned before the change fall back to live data with a 'current order data' label, the same way stops without a snapshot are labelled today (workbook.ts:676).
- Use the frozen kg in the timetable check that is recomputed on every read (plan-service.ts:1581), so an old plan's verified or not-verified badge cannot change after a reweigh.
- Freeze the product code and name printed on manifests (today live: plan-detail.ts:371; editable under Products: products/[id]/route.ts:13-17).
- Freeze the depot origin per load (audit E1). This is done in the P6 branch, not yet on main.
- Add note kinds for 'order weight changed since planning (now X kg, planned Y kg)' and 'product renamed since planning'. Today's kinds stop at LOCATION, HOURS, NAME, ADDRESS and CAPACITY (snapshots.ts:191).
- Print load-level notes (truck capacity changed, depot moved) on the Excel and PDF, not only on screen (workbook.ts:715 and driver-pack.tsx:164 print stop notes only).
- Keep 'changed since planning' notes on superseded versions and their exports. Plan-level notes are switched off for them today (plan-detail.ts:581-582, 700).
- Owner choice: the unserved sheet of a past plan still reads today's kg and customer name (plan-detail.ts:531-535).
- Optional one-off backfill for loads already locked or dispatched. For almost all of them, today's live values are still the planned ones because of the reweigh guard (plan-service.ts:301-318).
- Tests for the missing case: lock, re-plan, unlock, product weight corrected, re-plan, then re-export the first version. It must still show 400/400/400 plus a note. Add it to the unit, fake-DB and real-Postgres integration tests, and update the handbook (docs/PROJECT_HANDBOOK.md:800, 890) and the dispatcher guide ('Changed after planning', docs/DISPATCHER_GUIDE.md:105-110).

**Already in progress:** P6 (C:/Users/abdulr/routeiq-wt-p6, branch audit-p6-solver-accuracy, 6 commits ahead of main) covers part of the rule:
- **Depot origin (E1): fully covered.** Each load's snapshot now stores the depot pin it was planned from (TruckSnapshot.origin, snapshots.ts:162; captured at plan-service.ts:1240). Older copies are stamped during a re-plan (plannedOriginOf). The map, route links, WhatsApp text, driver sheet and Excel depot row all use it (plan-detail.ts:473; workbook.ts depot row; driver-pack route). A new note kind, DEPOT ("Depot moved since planning"), appears on screen, as a PDF badge and in the Excel depot row.
- **Manifest kg: partly covered (E3).** The manifest lines now share the row's kg (rowLinesKg; plan-detail.ts:383-384 in P6), so the loading sheet adds up to the stop. For split parts that kg is frozen, because it comes from the stored portion kg and per-line case weights.
- **Whole-order stops are still not frozen.** Their kg is still `o.totalWeightKg`, read live (P6 plan-detail.ts:383).
- **The 400/600 case is only detected.** When the manifest kg no longer matches the stored load kg, the Excel now prints "MISMATCH: load records X kg (order weights changed since planning)" (P6 workbook.ts:700), and the SKU summary gains a kg check. The live, changed kg is still what gets printed.
- **Not covered by P6:** product code and name, the unserved sheet, the recomputed timing badge, notes on superseded versions, and a truck-capacity note in the exports.

P10 (C:/Users/abdulr/routeiq-wt-p10, opt-long-search) covers nothing of this rule. It does edit the same files (plan-detail.ts, snapshots.ts, workbook.ts, the Excel export route) to add its search report, so there will be merge conflicts to resolve.

Build decision 23 after P6 lands, on top of P6's rowLinesKg and origin work.

**Example:** Evening of 28 Sep: the dispatcher plans 29 Sep (version 1). Truck T03 load 1 carries 40 cases of a 1.5 L x12 product, which the product master records at 10 kg per case, so 400 kg. The load is locked, and the warehouse prints the v1 loading sheet, loads the truck and signs it.

At 07:00 a late order arrives, and the re-plan creates v2. T03 L1 is kept unchanged, and v1 is now superseded.

At 09:00 the warehouse finds the case weight is really 15 kg, and an admin corrects it under Products. One of T03 L1's customers then asks to move its delivery. The dispatcher unlocks T03 L1 in v2 and re-plans (v3). Because that order is open again, v3 writes 600 kg onto the shared order and line rows.

A week later the finance team or a customer disputes the 29 Sep delivery, and someone re-exports v1, the version the truck was actually loaded from:
- The LOAD PLAN row still says 400 kg (stored).
- The loading manifest and the stop now print 600 kg (live).
- No warning appears, because notes are switched off on superseded versions and main has no manifest-kg check.

The printout no longer matches the signed paper sheet. P6 would add a "MISMATCH … order weights changed since planning" note, but it would still print 600 kg on the lines.

A second everyday case: the IVMS/ERP transition renames product codes. Every past manifest, dispatched ones included, would then print the new code and name.

A third case, fixed only by P6 (E1): if the depot pin is corrected, locked loads carried into a re-plan get their route links and Excel depot row drawn from the new pin.

**Effort:** About 3.5 developer days, range 3 to 4, after P6 has merged:
- 0.5 d: capture the planned cases, kg and SKU lines (with product code and name) in stopSnapshotJson at apply.
- 0.75 d: make plan-detail, the manifest, the SKU summary, the timing input, the driver sheet and WhatsApp read the snapshot, with a labelled fallback for older rows.
- 0.75 d: new note kinds (weight, product), load-level notes in Excel and PDF, notes kept on superseded versions.
- 0.25 d: optional one-off backfill for loads already locked or dispatched.
- 1 d: tests. Unit tests (snapshots, workbook, driver pack), a fake-DB repeat of the auditor's W2 probe, and a real-Postgres integration test of lock → re-plan → unlock → reweigh → re-export v1.
- 0.25 d: handbook and dispatcher guide.

No database migration (the data goes into existing JSON columns) and no solver change. Add about 0.5 d if the unserved sheet and driver name at dispatch are also frozen (owner questions 3 and 2).

**Risk:** Low to medium.

Low, because:
- The change is almost all on the read side, uses existing JSON columns and does not touch the solver.
- Today's plan numbers for locked loads don't change: they are already the planned values, thanks to the reweigh guard.

Medium, because:
- **The loading manifest is what the warehouse loads from.** A bug in the new read path would put wrong numbers on the sheet. Keep and extend the existing cross-checks (manifest cases against the load at workbook.ts:670, plus P6's kg check), and treat any MISMATCH as a blocker in tests.
- **Mixed old and new rows** after rollout need clear "current order data" labels, or a one-off backfill.
- **Current-version PLANNED loads change behaviour.** Once snapshots are taken at apply, they show the kg they were planned with plus an "out of date, re-plan" note, instead of today's kg. That matches how pins and hours already behave, but dispatchers should be told.
- **Merge conflicts:** P6 and P10 both edit plan-detail.ts, snapshots.ts and workbook.ts. Land this after both, or at least after P6.
- **Snapshot size:** small (about 320-450 invoices a day with a few lines each).

**Owner questions:**
- Should the product code and name on the loading manifest also be frozen as planned? Recommended: yes. Today a rename under Products rewrites every past manifest, dispatched ones included.
- Driver name: keep it live like the phone (today), or record the name on the load when it is dispatched so that history shows who actually drove? Recommended: keep it live on screen, record it at dispatch.
- Unserved sheet of a past plan: freeze the kg and customer name as planned, or keep them live? Recommended: freeze them, using the same mechanism.
- Never-locked loads in superseded versions: freeze those numbers too (recommended; the snapshot would be taken when the plan is applied, as for pins and hours), or let them follow live data? The rule as accepted only says 'from lock onwards'.
- Plans made before this change: backfill once from today's values (almost always identical for locked and dispatched loads), or leave them marked 'current order data'?
- Should a weight changed after planning on a load that has not left yet also block lock, loading or dispatch, or only show a note? Recommended: note only here. Blocking belongs with decision 20, the payload rule.

## 24. What the planner assumes about capacity. The recommended default is documentation only: name everything RouteIQ does not model (pallet space, customer vehicle access, dock and forklift capacity, helpers, breaks, stock and credit, returns) on the Excel ASSUMPTIONS sheet and in the handbook. A new planning rule is added only when NMWC names a real case. The warehouse keeps the physical checks.

**Recommended default:** Put one fixed list, "Not checked by the planner", on every ASSUMPTIONS sheet and in the handbook. It should say that the plan checks only cases, kg, receiving hours, the shift length, depot hours and the turnaround between loads. It does not check: pallet or floor space and volume; whether a given truck can reach or fit at a customer; how many trucks the depot can load at once (evening or midday); helpers or crew size; driver breaks (lunch, Friday prayers); stock on hand; the customer's credit status; empties, returns or cash collection; and actual return times (a re-plan assumes loads that are out come back when planned). The warehouse and the dispatcher check these. Nothing in planning changes until NMWC names a real case.

**Today:**
RouteIQ models only cases and kg, and the one existing list of what it leaves out is partial and hidden in the developer handbook.

WHAT THE PLANNER CHECKS
- Each truck is sent with cases, kg, costs, availability hours and a trip limit, and nothing else: apps/web/lib/dispatch/plan-service.ts:571-589; solver model apps/solver/dispatch_models.py:57-69.
- Each stop is sent with position, priority, windows, cases, kg, service minutes and margin. There is no "which trucks may serve it" field: plan-service.ts:503-530; dispatch_models.py:72-93.
- The solver has exactly two capacity counters, Cases and Kg, and one Time dimension: apps/solver/dispatch_solver.py:696-722.
- The design doc states the hard rules: capacity is "cases and kilograms": docs/OPTIMIZER_DESIGN.md:9.

WHAT IT DOES NOT CHECK, ITEM BY ITEM
- Pallets and volume: the data is stored but never used. Truck.palletCapacity and capacityVolumeL are at apps/web/prisma/schema.prisma:342,346; Product.casesPerPallet and volumePerCaseL at schema.prisma:526-528. The handbook lists them as unread (docs/PROJECT_HANDBOOK.md:1255) and pallet bays as backlog item 7 (PROJECT_HANDBOOK.md:2449, "approximated as bays x 95 cases").
- Customer vehicle access: the solver's only truck-to-node restriction ties each reload visit to its own truck (dispatch_solver.py:743). Access notes are free text, printed on the driver PDF (apps/web/lib/dispatch/driver-pack.tsx:323) and the Excel route Notes (apps/web/lib/dispatch/workbook.ts:705). The code states that they "do not change the timetable" (apps/web/lib/dispatch/snapshots.ts:17-18).
- Dock and forklift capacity: no depot-wide limit exists. The repack keeps loads from overlapping only within one truck (apps/solver/load_repack.py:579-582), and no AddCumulative constraint exists anywhere in the solver. The first load of a next-day plan is assumed loaded before the shift (PROJECT_HANDBOOK.md:1664; docs/DISPATCHER_GUIDE.md:231). This is still an open owner question (PROJECT_HANDBOOK.md:3177).
- Helpers: the Driver model has no crew or helper field (schema.prisma:364-382). Unloading uses one company-wide per-case rate (schema.prisma:232; plan-service.ts:497-499).
- Breaks: the day is limited only by its length (dispatch_solver.py:750-759), and there is no break setting (dispatch_models.py:104-153).
- Stock and credit: there is no stock, inventory, hold or credit-hold concept in the code (searched apps/: no matches). There is no HOLD order status (PROJECT_HANDBOOK.md:2447). Customer.paymentType is stored and shown on the Customers page (apps/web/app/t/[slug]/customers/customers-client.tsx:222), but the planner never reads it.
- Returns: pickups and returnable empties are listed as out of scope (PROJECT_HANDBOOK.md:2560; docs/OPTIMIZER_BENCHMARK.md:184). Order.paymentCollectionAmount is not read (PROJECT_HANDBOOK.md:1254).
- Actual return times: a re-plan sends out-on-the-road loads with their planned depart and return times (plan-service.ts:583-588). No actual-time field exists.

WHERE THE PARTIAL LIST LIVES
- The ASSUMPTIONS sheet (workbook.ts:891-916) prints the settings table (tenantAssumptions, workbook.ts:971-1058) plus 7 fixed NOTES (workbookNotes, workbook.ts:118-128). None of them lists what is not modelled.
- The only statements of this kind are in the developer handbook: "Cases and kg only. No pallets, bays or volume" (PROJECT_HANDBOOK.md:2465), plus the empties line above.
- Vehicle access, dock and forklift, helpers, breaks, stock, credit and actual return times are named nowhere.

SCREENS THAT OVERSTATE WHAT IS CHECKED
- The in-app Help says "capacity, receiving hours and priorities are respected" without saying which capacity (apps/web/app/t/[slug]/help/page.tsx:39).
- The Settings "effective values" panel lists only what the planner uses (apps/web/lib/dispatch/planner-config.ts:203-276).
- The Trucks form has a required "Volume (L)" field that the planner ignores (apps/web/app/t/[slug]/trucks/truck-form.tsx:271-281).
- Setting Primary unit to "Pallets" relabels the case capacity field as "Capacity (pallets)" (settings-form.tsx:170-182; truck-form.tsx:249). The solver still treats that number as cases.

**Missing:**
- The ASSUMPTIONS sheet needs a 'NOT CHECKED BY THE PLANNER - the warehouse and dispatcher check these' section with the 9 items: pallet or floor space and volume; truck access at the customer; depot loading capacity (bays, forklifts, evening loading of the first loads); helpers or crew; driver breaks; stock on hand; customer credit; empties, returns and cash collection; actual return times. This goes in addAssumptionsSheet or workbookNotes, apps/web/lib/dispatch/workbook.ts:118-128 and 891-916, with a test in apps/web/tests/lib/dispatch-workbook.spec.ts (the current checks at lines 273-278 search for text, so they will not break).
- The handbook needs one consolidated row in 7.2 Known limitations (docs/PROJECT_HANDBOOK.md, next to line 2465) that names all the items. Today it names only pallets, bays, volume and empties. Add the same short list to docs/DISPATCHER_GUIDE.md so dispatchers and the warehouse see it, not just developers.
- Screens should stop implying more than is checked. Help (help/page.tsx:39) should say 'cases and kg capacity'. The Settings effective-values panel (planner-config.ts:203-276) should get a few 'not checked' rows.
- Stored-but-unused inputs should be labelled or tidied, because they suggest they are checked. The truck 'Volume (L)' field (truck-form.tsx:271-281) is required but unused. The 'Pallets' and 'Kilograms' primary-unit choices relabel the case capacity (settings-form.tsx:170-182, truck-form.tsx:249). Product cases-per-pallet and volume, and customer payment type, should carry a note that planning does not use them.
- Wording plan by plan: if a rule is later modelled (for example pallets), older plans' exports must keep the list they were planned under. The p6 branch's solverRules pattern shows how. Until then the list can be fixed text.
- A register for 'NMWC named a real case' (who reported it, date, what happened) so a rule is added only on evidence. This can be a table in handbook 7.5.

**Already in progress:** Neither branch covers rule 24, and both change the same ASSUMPTIONS code.

- Branch p6 (C:/Users/abdulr/routeiq-wt-p6, audit-p6-solver-accuracy) adds a "Weights" row (0.1 kg, no margin) and "overtime already worked is not counted again" wording to tenantAssumptions. It also adds kg checks to the loading manifest and SKU summary, and a solverRules helper that words ASSUMPTIONS by the rules each plan was made with (workbook.ts in its diff). It records the optional per-truck payload reserve of decision 15 in handbook 7.5 but does not build it. That reserve is the nearest existing idea to "leave room" on a truck, and it is kg only. p6 adds no list of what is not modelled and does not touch the "Capacity model" limitation row.
- Branch p10 (C:/Users/abdulr/routeiq-wt-p10, opt-long-search) adds search-time rows to SUMMARY and ASSUMPTIONS through a searchAssumptions wrapper in workbook.ts. It has nothing on capacity.

Because both edit apps/web/lib/dispatch/workbook.ts ASSUMPTIONS code, rule 24 should land after them (or be rebased onto them). Its solverRules pattern is the right way to word the list per plan if a rule is modelled later.

**Example:** Midday reload on a late-order day. Five trucks come back from their first loads between 10:30 and 10:50. RouteIQ gives each one its own 30-minute turnaround plus loading minutes per case, so all five second loads show departures around 11:20-11:40. The timing check shows green (VERIFIED), because it checks each truck on its own day and has no depot-wide limit (load_repack.py:579-582 is per truck).

If the depot can load only two trucks at once, the last three actually leave around 12:30-13:00. A supermarket stop with receiving hours ending at 12:00 on one of those loads is then missed, although the plan said it fits. The same blind spot applies the evening before, when all 13 first loads are assumed loaded before the shift starts.

A second case: the plan can send the 10.5-t truck to a customer whose access note says the lane is too narrow for it. It reads the note only as text for the driver sheet.

Both are exactly what the "Not checked by the planner" list must tell the warehouse and dispatcher to check. Whether either has actually happened at NMWC is the owner's call. The truck sizes and access notes quoted come from the synthetic seed data (apps/web/prisma/nmwc-dispatch-data.ts:180-182, 436-443), not real NMWC records.

**Effort:** About 1 to 1.5 days for the recommended default, with tests:
- ASSUMPTIONS list and its test: 0.25 day.
- Handbook, dispatcher guide, Help and Settings wording: 0.25-0.5 day.
- Labelling or tidying the unused Volume field, the Pallets/Kg unit choice and the pallet/volume/payment fields: 0.25-0.5 day.
- Rebase onto p6 and p10: 0.25 day.

If NMWC later names a real case, each modelled rule is its own piece of work (rough estimates):
- Allowed trucks per customer (schema, form, solver, timing check, gate): 3-4 days.
- Pallets as a third capacity: 2-3 days.
- Driver breaks: 3-4 days.
- Depot loading bays shared across trucks: 5-8 days. This is hard inside the route search and would likely be checked after it.
- Order hold for credit or stock: 2-3 days, overlapping policy 19.

**Risk:** Low. The default is text only and changes no plan, timing or gate.

The main risks:
1. False comfort: a list nobody reads protects no one, so the warehouse must formally own these checks.
2. Merge conflicts in workbook.ts with p6 and p10.
3. Tidying the Primary unit choice or the required truck Volume field touches sign-up and other tenants, so label rather than remove unless the owner agrees.
4. If a rule is modelled later without per-plan wording, re-exported older plans would describe rules they were not planned with.

**Owner questions:**
- In the last few months, has any of these actually caused a failed or late delivery at NMWC: a truck too full by space although cases and kg fitted; a truck that could not reach or park at a customer; trucks queuing to load at the depot; a missing helper; a driver break; stock not available; a customer on credit hold; empties or returns taking space or time? Only a named case becomes a rule.
- How many trucks can the depot load at the same time (bays and forklifts), in the evening and at midday? How long does a full truck take to load? This also gives the real loading minutes per case, which is still 0 by default.
- Are some customers off-limits to the big trucks (narrow lanes, mall basements, height limits)? If so, which trucks can go where?
- Does every truck carry a helper? Do drivers take a fixed break (lunch, Friday prayers) that must fit inside the day?
- Who checks stock and credit today, and does the ERP export only orders already released for delivery? Should RouteIQ ever hold an order itself, or is that always settled before upload?
- Should the unused truck 'Volume (L)' field and the 'Pallets' and 'Kilograms' primary-unit choices be removed, or only labelled 'not used by the planner'?
- Who in operations and the warehouse signs off the 'not checked by the planner' list and owns those checks every day?

## 25. What a receiving window means: unloading must START before closing time (keep as the default and confirm with the biggest customers). Add a per-customer "must finish by closing" option only if a customer insists. A split delivery gets the full fixed stop time on each visit.

**Recommended default:** Keep "unloading must start no later than closing time" as the rule everywhere. Say so in plain words on every screen and export, and confirm it with the biggest customers. Build no "must finish by closing" option unless a named customer insists. Change split deliveries so every part (each truck visit) gets the customer's full fixed stop time, plus the per-case time for its own cases, instead of a proportional slice.

**Today:**
In short: the first half of the rule already works as the default. Every part of the planner uses "start by closing". What is missing is saying so in plain words on screens and exports. The second half, the split-delivery stop time, is not done.

1) Window meaning (planner and checks): RouteIQ already treats the window as "unloading must start by closing". Unloading may start as late as the closing minute itself, and the finish can run past closing. This holds in all five places that apply the window:
- Route search: each stop's clock value is its service start, and it is held inside [open, close] (apps/solver/dispatch_solver.py:719-731). Travel time includes the previous stop's unloading, so the clock value at a stop is when unloading starts there.
- Pre-filter that drops impossible stops: tests start > close only. Unloading time is used only for the shift check (dispatch_solver.py:426-431).
- Timetable output: hard_window_ok = open <= start <= close (dispatch_solver.py:910-934). Departure = start + service_min (dispatch_solver.py:931).
- Load repack and timing LP: the start variable is bounded by [open, close] (apps/solver/load_repack.py:37-41, 176-181, 221, 319, 404).
- Independent checks: the solver's feasibility.py:193-199 and the web lock/dispatch gate apps/web/lib/dispatch/feasibility.ts:266-278 both check the start only.
The technical docs say "start": PROJECT_HANDBOOK.md:1509 and 3225, OPTIMIZER_DESIGN.md:10, OPTIMIZER_BENCHMARK.md:35. The auditor's example is confirmed by the code: a 09:59 start with 30 min of unloading passes a 10:00 closing (audit .md:439).

2) What dispatchers, drivers and the owner are told is vaguer, or suggests "finish":
- Customer dialog label: "Receiving hours — HARD (never outside)" (apps/web/app/t/[slug]/dispatch/customer-dialog.tsx:139).
- Dispatcher guide: "every customer is served inside its receiving hours" (docs/DISPATCHER_GUIDE.md:96).
- Excel ASSUMPTIONS note: "Hard delivery windows are enforced." (apps/web/lib/dispatch/workbook.ts:123).
- Help page: "receiving hours ... are respected" (apps/web/app/t/[slug]/help/page.tsx:39).
- Schema comment: "delivery outside the hard window is infeasible" (apps/web/prisma/schema.prisma:503).
- Driver sheet: prints "ETA" (the arrival) and "Receives 06:00–11:00", with a warning only when the start is outside the hours (apps/web/lib/dispatch/driver-pack.tsx:125-128, 156-158, 341-347).
- Plan screen: shows ETA, wait, window and "35m", but no finish time (plan-view.tsx:1291-1296).
- Excel route table: ETA, Service start, Window and Service min, but no finish column (workbook.ts:603, 712-713).
Nothing anywhere flags "unloading runs past closing". No test fixes the start-versus-finish meaning either: no solver or web test covers a stop whose unloading ends after closing.

3) No per-customer "must finish" option exists. Customer and CustomerTypeProfile have only hard and preferred start/end minutes (schema.prisma:256-259, 503-506). The solver stop has only hard_start_min and hard_end_min (dispatch_models.py:85-86).

4) Split deliveries share the fixed stop time proportionally, which contradicts the recommended default. stopService gives each part max(5, round(base x partCases / totalCases)) plus per-case time (apps/web/lib/dispatch/service-time.ts:7-9, 33-36). plan-service.ts:551 calls it with the customer total. Tests fix the old behaviour: tests/lib/dispatch-service-time.spec.ts:22-26 and 44-45, for example 30 min split 935/165 gives 26 + 5. Side quirk: a customer with an explicit 0 min unloading time gets 5 min on every split part (service-time.ts:36). Parts are filled greedily to one truck (split.ts:66-91), so two parts never share one load: each part is its own arrival at the dock.

5) Placeholder values: in the seed data, hypermarkets are 06:00–11:00 with 35 min, supermarkets 06:00–14:00 with 20 min (apps/web/prisma/nmwc-dispatch-data.ts:251-252). Real receiving hours for key accounts and real unloading minutes are still owed by NMWC (handbook :3161; project notes). The type defaults can only be edited in the database (handbook :3162).

**Missing:**
- A plain-language statement of the rule wherever people read it: the customer dialog ('Receiving hours: unloading must START between these times', customer-dialog.tsx:139), the dispatcher guide (DISPATCHER_GUIDE.md:96), the help page (help/page.tsx:39), the Excel ASSUMPTIONS notes (workbook.ts:123), the driver sheet (e.g. 'Start unloading by 11:00' instead of 'Receives 06:00–11:00', driver-pack.tsx:127), and the schema comment (schema.prisma:503).
- A visible unloading finish time: 'unloading until HH:MM' on the plan screen stop row (plan-view.tsx:1291-1296) and a finish column in the Excel route table (workbook.ts:603, 712-713). Plus an amber, non-blocking note when the finish is after closing ('unloading until 11:33, after closing 11:00: call ahead'), on screen, on the driver sheet and in the Excel Notes column, so dispatchers know which customers to phone.
- Tests that pin the meaning so no one changes it silently: a solver test where a stop starting at closing with 35 min of unloading is served, hard_window_ok is true and feasibility is VERIFIED; the same on the web gate (tests/lib/dispatch-feasibility.spec.ts); and a test for the new 'after closing' note.
- Something to support 'confirm with the biggest customers': at least a list of which customers (by cases) had unloading planned past closing on recent plans. Today nothing shows this.
- Split deliveries: every part gets the full fixed base time plus the per-case time for its own cases (service-time.ts:33-36). Rewrite the tests that fix the proportional share (dispatch-service-time.spec.ts:22-26, 44-45), update the file header and the handbook, and decide what happens to the 5-minute minimum (it becomes moot, and an explicit 0 then means 0 on every part).
- A rule label for older plans: the ASSUMPTIONS sheet should say 'split parts: full stop time per visit' for new plans and 'earlier rule: parts shared the stop time' for plans made before the change. Older plans keep their planned minutes: stop snapshots store serviceMin (plan-service.ts:751-755, 1251-1255), and stopMasterChanges does not compare service time (snapshots.ts:248-287), so no false 'changed since planning' notes appear.
- A benchmark re-run after the split change (OPTIMIZER_BENCHMARK.md). Split customers get more total dock time, which can cost a trip or a stop on tight days.
- Only if a customer insists (not needed for the default): a per-customer 'must finish by closing' flag. It would need a Customer field (and maybe a type-profile field), the dialog and import column, an additive optional solver stop field, a close-minus-unloading upper bound in routing (dispatch_solver.py:731), the pre-filter (:416-431), the repack and LP (load_repack.py:181, 221, 319, 404), the hard_window_ok flag (:934), feasibility.py:193-199, the web gate (feasibility.ts:266-278), the snapshot and change notes, driver sheet wording, and tests. It must not be done by shrinking hard_end_min on the web: the snapshot would store the wrong closing time (plan-service.ts:751-752), and an unloading time longer than the window would make end < start, which fails the whole request with a 422 (dispatch_models.py:95-100) instead of leaving that one order unserved with a reason.

**Already in progress:** Neither in-progress branch covers any part of rule 25.
- p6 (audit-p6-solver-accuracy, 6 commits on top of 3451f4d) touches feasibility.py and split.ts for weights only: 0.1 kg units and no payload margin (F08), and planned kg on loading sheets (E3). It changes no window check, and service-time.ts is not in its diff. Its dispatch_solver.py changes in time handling concern overtime only (E4). One pattern is reusable: its "rules this plan was made with" mechanism (solverRules / weight_unit_kg / new_overtime_only, with an ASSUMPTIONS row that says "earlier rule" for older plans, commit fb1dc7e). The split-visit rule and the window wording can be labelled the same way.
- p10 (opt-long-search) only uses hard windows in a test fixture to force unserved stops (its test_search_modes diff).
Both branches edit files this work would touch: plan-service.ts, workbook.ts, plan-detail.ts, DISPATCHER_GUIDE.md and PROJECT_HANDBOOK.md, and p6 also driver-pack.tsx. Start rule 25 after both are merged to avoid conflicts.

**Example:** These numbers use RouteIQ's current hypermarket default (06:00–11:00, 35 min unloading) and the 900-case large truck. Both are placeholders until NMWC confirms real values.

Window: a hypermarket branch phones in a late P1 order and the dispatcher re-plans at 09:30. The only free truck can arrive at 10:58. RouteIQ plans it: unloading starts 10:58, inside the hours, and finishes 11:33. The plan passes the timing check and the load can be locked and dispatched. The driver sheet says "ETA 10:58 / Receives 06:00–11:00" with no warning, and the Excel sheet says "Hard delivery windows are enforced". If that hypermarket's real rule is "dock closes at 11:00, all trucks finished", the truck is turned away with the cases. The P1 order fails, the cases come back, and that truck's afternoon load leaves late. Nobody was warned, because no screen shows that unloading runs past closing.

Split: a 1,100-case hypermarket order goes as 900 + 200 on two trucks. Today the parts get 29 min and 6 min of the 35-minute stop time (service-time.ts:36). So the second truck is planned to be out of the dock 6 minutes after it starts unloading. In reality it queues again and does the goods receipt and stamp again, taking about 35 minutes. That truck's next stops and next load are about 29 minutes behind a timetable RouteIQ marked as checked, which can push a later customer past its closing time.

**Effort:** About 2.5 to 3 days for the recommended default, with tests:
- About 1 to 1.5 days to state the start-by-closing rule on every screen and export, add an 'unloading until' time with a non-blocking 'after closing' note, and add solver and web tests that fix the meaning.
- About 1 to 1.5 days to give every split visit the full fixed stop time: rewrite the service-time tests, add the ASSUMPTIONS 'earlier rule' label, update the handbook, and re-run the benchmark.
The optional per-customer 'must finish by closing' option, only if a customer insists, would add about 3 to 4 days. It touches the solver's time rules in five places plus a migration, the dialog, import, snapshots, the web check and driver sheets.

**Risk:** Wording, finish time and the after-closing note: low risk. Plans do not change; it is text and one extra computed time (departure = start + unloading, already stored).

Split full stop time: low to medium risk. Every plan with a split customer gets longer dock time. On tight days that can mean one more trip, a later load, or a low-priority stop left unserved, so the benchmark must be re-run and the change announced to dispatchers. Existing and locked plans are not affected, because they keep the minutes they were planned with.

Optional 'must finish' option: medium risk. It changes the solver's core time rules in routing, the pre-filter, the repack/LP and both feasibility checks, and they must stay consistent or plans will fail the lock/dispatch gate. Two traps: a window shorter than the unloading time must become an unserved reason, not a 422 error for the whole plan; and it must not be done by quietly shrinking the closing time, which would print a wrong closing time on driver sheets.

Keeping the default without confirming it with customers carries a business risk rather than a code risk. Until the big accounts confirm what 'closing' means, a plan marked checked can still be turned away at the gate.

**Owner questions:**
- For the biggest accounts (the hypermarket and supermarket chains, and the top customers by cases): does their closing time mean 'last truck accepted at the gate' or 'unloading finished and dock closed'? Who asks them (sales or operations), and by when?
- Which customers count as 'biggest' for this check? Top N by cases per month, or a named list?
- When a split order's second truck arrives, does it go through the full queue and goods-receipt paperwork again? Is the full stop time right, or should a second visit have a shorter fixed time (e.g. paperwork only)?
- Should RouteIQ warn, not block, when unloading will run past closing (an amber 'unloading until 11:33, after closing 11:00: call ahead' on the plan and driver sheet)? Or should it stay silent while the rule is 'start by closing'?
- Have the real receiving hours and unloading minutes for key accounts been entered? The 06:00–11:00 / 35 min hypermarket figures are placeholders, and the customer-type defaults can only be changed in the database today. Who maintains them?
- What is production's 'unloading minutes per case' setting (0 by default)? It decides how much of a split visit's time scales with cases and how much is fixed.
- If a customer later insists on 'must finish by closing': should the setting be per customer branch or per customer type (e.g. all hypermarkets)? And should the driver sheet then print 'finish unloading by 11:00'?

## 26. Priorities and costs when trucks are short

**Recommended default:** Priority always comes first. Among orders of the same priority, RouteIQ should first complete as many whole orders as it can, then carry as many cases as it can, and only then pick the cheaper plan. Margin only breaks a tie that is left after all of that. Truck fixed cost and driver day pay should be labelled "allocated" cost, never as cash saved. When one order of a branch has a strong priority, that priority may cover all of the branch's cases for the day, but the plan must say so. NMWC operations and sales still need to sign this off.

**Today:**
All paths are under C:/Users/abdulr/routeiq (commit 3451f4d).

1) PRIORITY FIRST: this part is done and works. The web always sends strict priorities (apps/web/lib/dispatch/planner-config.ts:170-174). One stop of a higher priority outweighs all lower-priority stops together (apps/solver/dispatch_solver.py:25-30, 470-477, 480-514). The post-solve selection also ranks service by priority first for every option (dispatch_solver.py:1527-1536; apps/solver/load_repack.py:455-485). This is covered by tests: test_strict_priority_one_p2_beats_eleven_p3 (apps/solver/tests/test_repack.py:103) and test_priority_ladder_under_shortage (tests/test_dispatch.py:90).

2) WITHIN THE SAME PRIORITY, RouteIQ counts stops, not orders or cases. It also puts margin above cost.
- A stop is one customer branch, with all of its orders for the day added together (apps/solver/dispatch_models.py:72-74; apps/web/lib/dispatch/plan-service.ts:407-412, 519-530).
- Leaving a stop out costs the same fixed amount per priority, whatever its size: base x w[priority], plus a margin bonus (dispatch_solver.py:508-513). The priority weights count stops (dispatch_solver.py:491). Cases and the number of orders or invoices are not in the value at all.
- The repair step and the CP-SAT re-check also weight each stop only by its priority (dispatch_solver.py:538-547; load_repack.py:499-506, 652).
- The result: among stops of equal priority, the optimizer serves the most stops (which favours small drops), then the lowest cost. It does not serve the most whole invoices, and it does not carry the most cases.
- Margin is worth about 10x the operating cost, up to 0.4 of a priority unit (dispatch_solver.py:31-34, 517-524; docs/OPTIMIZER_DESIGN.md:23). A 50 OMR margin adds about 222 OMR to the objective, so today margin ranks above cost, not as a last tie-break.
- For NMWC, margin is switched off in practice. It is used only when every stop has a margin (dispatch_solver.py:634, 1587), and NMWC files carry no money columns (VERIFIED-ASSESSMENT.md:30, 144).
- Split deliveries (a branch bigger than any truck) are cut at any case, ignoring sales-order boundaries (apps/web/lib/dispatch/split.ts:66-110). Each part is then treated as a separate stop, with nothing that favours delivering every part. On a short day an invoice can be half delivered. That is shown as "+N part" (apps/web/app/t/[slug]/dispatch/plan-view.tsx:537), but nothing tries to avoid it.

3) THE PRIORITY LIFT exists and is never shown on the plan. The auditor's claim holds: confirmed in the code here, though not run on a real day.
- At upload, all rows of one branch for one date become a single Order (apps/web/lib/dispatch/intake-server.ts:449). That Order takes the strongest priority found in the file (intake-server.ts:471, 484-485).
- Order lines have no priority field (apps/web/prisma/schema.prisma:622, model OrderLine), so each sales order's own priority is lost once the file is saved.
- At planning, the stop takes the strongest priority of all the branch's open orders, late orders included. The customer's master priority also sets a floor: a file can only raise it (plan-service.ts:411-412, 507).
- Every order in that stop is then recorded with the lifted priority (plan-service.ts:559). The plan screen, the unserved list, the P1-P5 service figures and the Excel all show that lifted priority (apps/web/lib/dispatch/plan-detail.ts:352, 392, 536; plan-service.ts:1384; apps/web/lib/dispatch/summary.ts:139-144; apps/web/lib/dispatch/workbook.ts:712, 799).
- The lift is described only in the developer handbook (docs/PROJECT_HANDBOOK.md:777).
- The dispatcher guide and the Excel ASSUMPTIONS sheet say "one order of a higher priority always wins" (docs/DISPATCHER_GUIDE.md:64; workbook.ts:1042), which is not accurate: the rule works per branch.
- A lifted stop also gets the early-arrival preference that P1/P2 stops get (dispatch_models.py:135-137).

4) COSTS ARE SHOWN AS PLAIN OPERATING COST, WITH SAVINGS WORDING. Nothing is labelled "allocated".
- Plan screen: "Operating cost OMR", including fixed and driver cost (plan-view.tsx:549-553), and the options column "Day cost OMR" (plan-view.tsx:617).
- The options comparison says "X OMR cheaper" or "costs X OMR more" (apps/web/lib/dispatch/plan-options.ts:153).
- Solver note: "720 -> 493 OMR operating cost" (dispatch_solver.py:1767).
- Excel: "Operating cost", "of which fixed truck cost" and "of which driver (whole truck day)" (workbook.ts:384-395), plus "day cost" in PLAN OPTIONS (workbook.ts:429).
- Dashboard: "Total cost" with a better/worse arrow (apps/web/app/t/[slug]/page.tsx:98).
- The optimizer minimises the fixed truck-day cost and the whole-day driver pay as if they were cash.

5) SHORTAGE EXPLANATIONS use the lifted priority, "Lower priorities are left out first (this is P1)" (dispatch_solver.py:305-317, 1017-1020). They never say which same-priority order was chosen over another, or why.

**Missing:**
- Show the lift on the plan. Keep each sales order's own priority: a new nullable OrderLine.priority, filled at upload and at late-order entry. Record which orders were lifted and how many cases. Show it as, for example, 'P1 (lifted: 480 of 500 cases are P3, by SO 12345)' on the stop, the unserved list, the Excel load and route sheets, and a plan warning line. P1-P5 service figures should show both 'by lifted priority' and 'by own priority'.
- Fix the wrong wording: 'one order of a higher priority always wins' appears in DISPATCHER_GUIDE.md:64 and on the Excel ASSUMPTIONS sheet (workbook.ts:1042). It should say that priority works per customer branch per day.
- Change the solver's order within a priority to: whole orders completed, then cases carried, then cost, then margin. That means sending the solver an order/invoice count per stop. Add in-priority terms that stay below one priority unit but above cost (the same way the margin +1 guard works today, dispatch_solver.py:476). Give CP-SAT repack phase 1 the same order, and extend Score and _GOALS with orders and cases before cost.
- Move margin out of the drop penalty (today it sits above cost) into a final tie-break after cost, and update test_margin_breaks_ties_within_same_priority and docs/OPTIMIZER_DESIGN.md:23.
- Complete whole orders in split deliveries: cut parts at sales-order boundaries where the truck allows, and give a bonus for delivering every part of a split order, so an invoice is not half delivered while a same-priority whole order is served instead.
- Relabel costs as 'allocated'. Truck fixed cost and driver day pay become allocated, with fuel, km, trip and overtime shown apart as variable. The options trade-off 'X OMR cheaper' becomes 'X OMR less allocated cost'. Also update the solver's re-assignment note, the Excel SUMMARY, PLAN OPTIONS and TRUCK DAYS sheets, and the dashboard 'Total cost' and 'Cost per case', with matching changes to the guide and handbook.
- Unserved reasons within a priority: say 'left out for a same-priority order that completes more orders or carries more cases', not only 'lower priorities first'.
- Re-run the benchmark (5 synthetic days + 1 real NMWC day). Compare service by priority first, then whole orders, then cases, then cost, so the change in plans is measured before release.
- Write a one-page sign-off sheet for NMWC operations and sales with worked examples, and record the decision in the handbook decisions table.

**Already in progress:** Both branches help a little, but neither one delivers rule 26.

- p6 (C:/Users/abdulr/routeiq-wt-p6, branch audit-p6-solver-accuracy):
  - E4: only NEW overtime counts for trucks that already have locked loads (load_repack.py:178 overtime_bound_s; dispatch_models.py:427). The optimizer's cost moves closer to real extra spend, but it changes no labels.
  - F08 review: a more honest unserved reason, 'no load or free trip has room ... even with every lower-priority stop taken off' (dispatch_solver.py:363-378 in that worktree). It still uses the lifted priority.
  - F22: options that break the timing rules no longer claim to be 'cheaper' or to serve '1 more order' (plan-options.ts:125, 191 there).
  - p6 does not change the order of choice within a priority, where margin sits, how priorities are combined per branch, or how costs are labelled. Checked: git diff origin/main...HEAD has no priority or cost-label change in plan-service.ts, workbook.ts or the app screens.
- p10 (C:/Users/abdulr/routeiq-wt-p10, branch opt-long-search):
  - The Thorough search (THOROUGH_MAX_SEC 1200, StallRule in dispatch_solver.py:124-128) gives a shortage-day plan more time to reach the best priority-first answer.
  - It does not change the objective, the lift or any cost wording.
- Both branches edit the same files rule 26 would change: dispatch_solver.py, load_repack.py, plan-service.ts, workbook.ts, plan-view.tsx and plan-options.ts. Rule 26 work should start after both are merged, to avoid conflicts and a second benchmark run.

**Example:** Example 1: the lift. Evening before, 2 of the 13 trucks are in the workshop, and next-day orders exceed what the remaining trucks can carry. A hypermarket branch has one urgent P1 sales order of 20 cases (a promo) and five normal P3 sales orders of 480 cases. RouteIQ saves them as one order at P1, so all 500 cases count as P1 and go ahead of every P2 and P3 in the day. Two P2 minimarkets and several P3 groceries are left out. The plan then shows 'P1 service 100%, P2 service 70%', and nothing tells the dispatcher or sales that 480 of those 'P1' cases were really P3.

The same thing happens during the day. At 11:00 a late P1 order of 10 cases is added for a branch whose 300-case P4 order was left out the evening before. On re-plan all 310 cases become P1 and take the afternoon's only free trip ahead of an unserved P2 customer.

Example 2: within one priority. The last free load has room for 450 cases and time for one more drop. RouteIQ picks three small P3 groceries (3 stops, 120 cases) over one P3 supermarket with 440 cases on 4 invoices, because it counts stops. The recommended rule would pick the supermarket: more whole orders and more cases.

Example 3: cost wording. The options table tells the owner that one option is '12 OMR cheaper'. Most of that is truck fixed cost and salaried driver time that NMWC pays anyway, so no cash is actually saved.

**Effort:** About 7.5 days in total (range 7-9), counting from after p6 and p10 are merged:
- Show the lift: 2 days. That covers the OrderLine.priority migration, storing it at upload and late-order entry, lift facts in the plan, the plan screen, unserved list and Excel, a warning line, and tests.
- 'Allocated' labels: 1 day, covering screen, options trade-off, Excel, dashboard, the solver note, guide and handbook, and the tests that check the wording.
- Solver order within a priority: 3.5 days. That is orders, then cases, then cost, then margin, in the route search, CP-SAT repack phase 1 and final selection, plus the int64 guard, split parts cut at sales-order boundaries with the completion bonus, and solver tests.
- Benchmark re-run, docs and the sign-off sheet: 1 day.

If the owner wants only the visible part now (the lift shown and the cost labels), that is about 3 days and changes no plans.

**Risk:** Medium.
- The solver change moves which customers are left out on short days. That is sensitive for sales, and total cost can rise, because bigger or farther same-priority drops get chosen over several small cheap ones.
- The route search is heuristic, so a new ranking can make its results less steady. It must be benchmarked before release, comparing priority service first.
- Adding orders and cases to the objective must keep priorities strict inside the 64-bit limit. Today a 400-stop day with margins uses about 7e17 of 4.6e18. The new terms have to stay below one priority unit, the same way margin does now.
- The lift display and the cost labels are low risk: an additive nullable column, and wording changes that break only tests which check exact text. Orders uploaded before the change have no line priority, so their lift shows as 'not known'.
- Locked, loading and dispatched loads are not touched, which keeps the owner's rule.
- The main practical risk is merge conflicts with p6 and p10, which change the same solver and plan files. Do this after they merge.

**Owner questions:**
- What does NMWC mean by a 'whole order': an ERP sales order or invoice (the sales order number on each line), or the branch's whole delivery for the day (a RouteIQ Order)? The recommended default reads it as the sales order or invoice.
- Does NMWC's ERP order file have a priority column, set per sales order? If it does not, priority comes only from the customer master and late-order entry. The lift then happens mostly on re-plans for late orders.
- When the plan should 'carry the most', should it count cases, kg, or litres? Cases of 5-gallon bottles and of 330 ml packs are very different. The default is cases.
- Which costs are real cash on the day for NMWC (fuel, overtime, per-km maintenance, loading labour) and which are allocated (truck fixed daily cost, salaried driver pay)? Are the drivers salaried, with only overtime paid extra?
- The lift: is it acceptable that one urgent sales order lifts the branch's whole delivery that day, as long as the plan shows it (the default)? Or should the urgent sales order go as its own drop when trucks are short?
- Should the customer's master priority stay a floor, so a file can raise a customer's priority but never lower it (plan-service.ts:411)?
- Will NMWC ever put sales value or margin in the order file? If not, the margin tie-break stays unused. Confirm that margin should rank below cost when it is used.
- When a delivery is bigger than any truck and has to be split, should the parts be cut at sales-order lines, so an invoice is never half delivered when trucks are short?
- Who at NMWC signs this off for operations and for sales, and by when? Do they want only the visible part first (the lift shown and the allocated labels, about 3 days, no change to plans), before the solver change?
