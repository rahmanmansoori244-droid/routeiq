# Dispatcher runs the Drivers page: local UI demo (7 Oct 2026)

Branch `dispatcher-drivers` (worktree `C:/Users/abdulr/routeiq-wt-drivers`, head `a2c766c`). It ran locally:
- web: `next dev` on :3021
- solver: :8021 (PyVRP venv `routeiq-wt-pyvrp/apps/solver/.venv-pv`, not modified). `OSRM_URL` was unset, so distances were straight-line estimates.
- database: a fresh scratch DB `routeiq_dv_demo` (`prisma migrate deploy`, all migrations including `20261006120000_driver_leave`).

The screenshots were taken with headless Chrome over the DevTools protocol, from small Node scripts, at 1366x900. Chrome used its own scratch profile and an OS-chosen DevTools port on 127.0.0.1.

Afterwards, every process was stopped, `routeiq_dv_demo` was dropped, the scratch files (with session cookies) were deleted, and the worktree was left clean.

## The demo company (synthetic only)

- **Company:** "Wadi Water Co (drivers demo)", slug `wadi-drivers-demo`. It was seeded directly with a Prisma script (local only).
- **Logins:**
  - `dispatcher@wadi-drivers-demo.local`: PLANNER, "Khalid Hamdan".
  - `admin@wadi-drivers-demo.local`: TENANT_ADMIN, "Maryam Al Rawahi".
  - Both have random passwords that were never used. Sessions were minted locally with a copy of `.dev/mint-session.ts` that adds the `authTime` and `pwf` claims.
- **Depot:** MCT-GHALA (Ghala, 23.57623, 58.37174), open 06:00-20:00.
- **Settings:** first departure 07:00, 11 h shift, 2 loads per truck, turnaround 30 min.
- **Products:**
  - WW-500 (500ml x24): 80 cases per pallet.
  - WW-1500 (1.5L x12): 50 cases per pallet.
- **Customers:** 15 made-up shops in Muscat, with pins, confirmed receiving hours and priority 3.
- **Trucks:** T01 and T02 (10-ton Isuzu) and T03 (10-ton Hino).
  - Each has 12 bays and payload 0 (no weight limit).
  - Usual drivers: T01 **Ahmed Said** (D01), T02 **Rashid Ali** (D02), T03 **Yousuf Khalfan** (D03).
  - Salim Nasser (D04) is a spare driver.
- **Orders:**
  - Sun **11 Oct 2026**: 15 orders, 4,170 cases, 55.5 pallets, as a CONFIRMED upload. That is more than 2 trucks can carry, so all 3 trucks are used.
  - Tue 13 Oct: a copy of the same orders.
- **Today** for the app was Wed 7 Oct (Asia/Muscat).

## What the dispatcher did (all as the PLANNER, in the UI)

| Shot | What it shows |
|---|---|
| 01-drivers-page-dispatcher-view | The Drivers page as the dispatcher. It has **Add driver**, and per driver Leave / Edit / Deactivate (no delete). It has the "Drivers on leave (today and the coming 14 days)" card (empty) and **Usual driver of each truck** (T01 Ahmed, T02 Rashid, T03 Yousuf). |
| 02a-add-driver-dialog / 02b-driver-added | **Add driver** D05 **Nasser Hamed**, +968 9000 0105. Toast "Driver created", and D05 is in the list. |
| 03a-edit-mobile-dialog-code-locked / 03b-mobile-changed | **Edit** Yousuf Khalfan: the mobile changed to +968 9123 4103, toast "Driver updated". The **Code field is greyed out** for the dispatcher (title "Only a company admin changes a driver code: ask them on the Drivers page."). |
| 04a-leave-dialog-ahmed-with-cover | **Leave** of Ahmed Said: **9 Oct - 15 Oct**, cover **Nasser Hamed**, note "annual leave". The cover list offers Rashid, Yousuf, Salim and Nasser (never Ahmed himself). |
| 04b-leave-saved-ahmed | Toast "Leave of Ahmed Said added: 9 Oct – 15 Oct." The period shows as "Coming · 9 Oct – 15 Oct · cover Nasser Hamed · annual leave", with Change / Remove. |
| 05-usual-driver-T03-set | **T03's usual driver** changed from Yousuf Khalfan to **Salim Nasser** (the only truck field the dispatcher may change). The toast is quoted below the table. |
| 06-drivers-on-leave-list | "Drivers on leave": Ahmed Said · From 9 Oct · 9 Oct – 15 Oct · Cover: Nasser Hamed · annual leave. |
| 07a-dispatch-day-before-optimize | The 11 Oct day: 15 orders, 15 customers, 4,170 cases, "3 trucks (36 bays per load round)". |
| 07b-plan-v1-top / 07c-plan-v1-loads-cover-driver | **OPTIMIZE** (Quick, the plan was ready in about 14 s). The loads: **T01 L1 and L2: Nasser Hamed**, with "Covers Ahmed Said (on leave until 15 Oct)" under the driver. T02 L1/L2: Rashid Ali. T03 L1: **Salim Nasser** (the new usual driver). Every order is planned. |
| 08a-leave-dialog-rashid-no-cover | Leave of **Rashid Ali**: **7 Oct (today) - 12 Oct**, **no cover**, "sick leave". |
| 08b-leave-saved-warning-still-on-loads | Saved, with the warning "Rashid Ali is still the driver of 2 load(s) planned on those days (T02 · L1 on 11 Oct, T02 · L2 on 11 Oct): pick another driver on the plan, or re-plan (a driver picked by hand stays)." The period shows "On leave now". |
| 08c-drivers-page-rashid-on-leave-now | "Drivers on leave": **Rashid Ali · On leave now · 7 Oct – 12 Oct · No cover named · sick leave**, then Ahmed (from 9 Oct, cover Nasser). Rashid's row has the badge "on leave until 12 Oct". T02's Today column says "Rashid Ali is on leave until 12 Oct: no cover - pick the driver on the plan". |
| 09a-plan-v1-rashid-on-leave-still-on-T02 | Plan v1 before a re-plan: T02's list shows "Rashid Ali (on leave until 12 Oct)", with the amber note "Rashid Ali is on leave until 12 Oct". |
| 09b-plan-v2-T02-no-driver-leave-note | After **Re-plan** (Quick), plan v2: **T02 L1 and L2: No driver - "No driver: Rashid Ali is on leave until 12 Oct - pick a driver"**. T01 keeps Nasser (cover) and T03 keeps Salim. |
| 10a-T02-L1-locked-dispatch-off-no-driver | T02 L1 **locked**: **Dispatch is greyed out** (title "Pick the driver first: a load never leaves without a driver"). The server refuses it too: the Dispatch request (`PATCH /api/runs/<run>/loads/<load> {status: DISPATCHED}`) answered **409 DRIVER_REQUIRED**, "T02 L1: a load never leaves without a driver. Pick the driver in the Driver list, or add a daily driver, then dispatch." |
| 11a-driver-list-on-leave-labels | The Driver list of a T02 load: No driver, **Ahmed Said (on leave until 15 Oct)**, **Rashid Ali (on leave until 12 Oct)**, Yousuf Khalfan, Salim Nasser, Nasser Hamed, + Add daily driver…. It was drawn open as a list box for the picture (see notes). |
| (question, no picture) | Choosing Rashid Ali on T02 L1 asked **"Rashid Ali is on leave until 12 Oct. Put Rashid Ali on T02 · L1 anyway?"**. It was answered Cancel, and the load stayed "No driver". |
| 11b-T02-L1-yousuf-picked-dispatch-on | **Yousuf Khalfan** picked (free that day, no question). Toast "T02 Load 1: driver Yousuf Khalfan", "picked by hand", and **Dispatch is on**. |
| 11c-T02-L1-dispatched-with-yousuf | Dispatched: "DISPATCHED · Delivered 0/3 · 3 no result". |
| 11d-plan-11-oct-v2-final | The whole plan v2 (header to loads). The yellow box says "Driver changed by this plan: T02 · L2 (09:16–12:04) Rashid Ali → no driver, because Rashid Ali is on leave until 12 Oct." |
| 12a-trucks-page-dispatcher-read-only | **The dispatcher cannot change a truck's bays.** The Trucks page has no Add truck, Edit or Delete for him (read-only list). The server refuses it too, see "Server checks" below. |
| 12b-trucks-page-company-admin | The same page for the company admin: Add truck, Edit and Delete. |
| 13-audit-log-dispatcher-changes / 13b-audit-usual-driver-and-leave-details | The audit log (admin), every row with **who (dispatcher@…), when and IP**: CREATE Driver (D05), UPDATE Driver (phone before/after), DRIVER_LEAVE_ADDED x2 (driver, dates, note, cover with names), TRUCK_USUAL_DRIVER_SET (T03), the optimize/re-plan rows, LOAD_LOCKED, LOAD_DRIVER_SET and LOAD_DISPATCHED. |
| 14-plan-13-oct-rashid-back-ahmed-still-covered | **Tue 13 Oct** (OPTIMIZE, plan v1). **Rashid Ali drives T02 again by himself** (his leave ended 12 Oct). T01 again has Nasser Hamed covering Ahmed (still away until 15 Oct). T03 has Salim. |
| 15-overlapping-leave-refused | A second leave for Ahmed, 14-20 Oct, is **refused**: "This driver is already on leave from 9 Oct until 15 Oct. Change that period instead: one driver's periods cannot overlap." (Salim Nasser's one-day leave in the background comes from check 1 below.) |

The toast after the usual-driver change (shot 05) read:

> "T03: usual driver Salim Nasser. New plans use him. On plans already made, a re-plan can give a trip without a driver, a trip a cover drove and a trip whose driver is on leave that day to Salim Nasser or to the driver of another trip of T03; a driver you picked by hand stays while he is active. Check the drivers after the re-plan."

### Server checks (as the dispatcher, from the page)

- `PATCH /api/trucks/T01 {bays: 14}` → **403 ADMIN_ONLY_TRUCK_FIELD** `fields: ["bays"]`, "Only a company admin can change bays of a truck. A dispatcher can change its usual driver only. Nothing was saved."
- `{bays: 14, defaultDriverId: <Salim>}` together → the same 403. Nothing was saved: T01 kept 12 bays and Ahmed as usual driver.
- Dispatch without a driver → **409 DRIVER_REQUIRED** (shot 10a).
- No errors in the solver log. The browser console and the web log had only the audit-page key warning (pre-existing, below).

## Bugs / issues seen

1. **A driver who goes on leave after planning can be locked and dispatched without any question (medium).**
   - Check (done after the pictures, on 13 Oct):
     - T03 L1 had Salim Nasser, filled in by RouteIQ.
     - Salim's leave was entered for 13 Oct with no cover. The save warned that he is still on T03 L1.
     - On the plan the list showed "Salim Nasser (on leave until 13 Oct)" with the amber note "Salim Nasser is on leave until 13 Oct".
     - **Lock and then Dispatch went straight through** (the test answered Cancel to any question, and none came). T03 L1 became DISPATCHED with a driver who is on leave.
   - Choosing an on-leave driver in the list asks, and so does Keep, but Lock / Dispatch do not, and the server does not refuse it (no `leaveConfirmed` check on the status change).
   - Where: `plan-view.tsx` `setStatus` (it only asks the lock warnings), `LoadActions`, and the status path of `PATCH /api/runs/[id]/loads/[loadId]`.
   - Suggested fix: Dispatch (and possibly Lock) asks "<name> is on leave until <date>. Dispatch anyway?", and the server answers 409 DRIVER_ON_LEAVE without the confirmation, as the casual-driver path does.
2. **The on-leave label is cut off in the load's Driver list (low, cosmetic).**
   - Before a re-plan, the closed list on T02 reads "Rashid Ali (on leave until ▾" (shot 09a), because the select is narrow.
   - The amber note under it has the full text, so nothing is lost. A wider select or a shorter label ("on leave → 12 Oct") would fix it.
3. **A leave that starts today shows "On leave now" but still offers Remove (low, question).**
   - A period that started earlier offers only "Change / end early". One that starts today can still be removed outright (shot 08b).
   - This may be on purpose (the driver came in after all), but it does not match "remove one that has not started". Decide which is wanted.
4. **The audit of a usual-driver change is hard to read (low).**
   - TRUCK_USUAL_DRIVER_SET keeps the whole truck row before/after, with `defaultDriverId` as an id only. The field is also below the fold of the JSON box (shot 13b).
   - The leave rows store the driver and cover names. Adding `{truck, from: <name>, to: <name>}` would let the owner read it at a glance.
5. **The usual-driver toast is long (low, UX).** About 60 words, shown for 15 s (shot 05). Most of it is about re-planning plans already made; a short first sentence plus "details" would read better.
6. **Pre-existing, not from this branch:**
   - Audit log: React warning "Each child in a list should have a unique key prop" (`audit-client.tsx`, the `<>` fragment inside `filtered.map` has no key). It shows in the browser console and the web log.
   - Audit log at 1366 px: the filter row (the two date inputs) is wider than the page, so the page scrolls sideways (shot 13 is 1458 px wide).

## Notes on the demo itself (not app bugs)

- **Native browser widgets are not drawn in a headless screenshot.**
  - The confirm question (picking Rashid) was read through DevTools, and its text is quoted above.
  - The open Driver list (shot 11a) was drawn by setting the select's `size` attribute on the page for that picture only. It was taken on T02 L2 after L1 was dispatched, and it is the same list L1 showed (logged before the pick).
- **Display formats come from headless Chrome.** Date inputs show mm/dd/yyyy because the browser runs in en-US; the app's own text uses "9 Oct". The audit times are in the machine's local time.
- **Not exercised here:**
  - "Reissue link" after a driver change on a truck-day with a link (unchanged since #53; covered by tests and the 4 Oct demo).
  - The leave question inside "+ Add daily driver…" (409 DRIVER_ON_LEAVE).
  - A cover who is himself on leave or already driving another truck. That is covered by the unit and integration specs only.
- **Shot order:** shot 15 was taken after check 1, so Salim's one-day test leave shows in its background.
