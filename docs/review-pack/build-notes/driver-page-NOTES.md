# Delivery outcome + driver phone page: local demo (4 Oct 2026)

Branch `delivery-outcome-driver-page` (worktree `C:/Users/abdulr/routeiq-wt-driver`, head 30555ae), run locally:
web `next dev` on :3017, solver on :8017 (PyVRP venv), DB `routeiq_dr`. All processes were stopped afterwards and the worktree is clean.
Unit tests on this head: `vitest run tests/lib tests/tenant-isolation.spec.ts`: 119 files, 2399 passed, 1 skipped.

## The demo company (synthetic only)

Tenant `sahil-demo`, "Sahil Springs Water (demo)", in `routeiq_dr` (left there for another look; delete the tenant row to remove it).
It has 1 depot (Ghala), 9 made-up customers in Muscat with exact pins and confirmed receiving hours, and 3 products (Sahil 500ml / 1.5L / 19L).
Trucks: S01 (driver Hamed Salim), S02 (Saeed Nasser) and **H01 marked "Hired from outside"**, which has no regular driver.
Orders were uploaded as a CSV for Sun 4 Oct through the normal upload and confirm path (late, with a reason). The day was then planned (quick search, straight-line distances) as v3: H01 5 stops, S01 3 stops, S02 1 stop.
Logins: `dispatcher@sahil-demo.local` (SUPERVISOR, see note 9) and `admin@sahil-demo.local`. Random passwords, never used. The session was minted locally, like `.dev/mint-session.ts`.

## What the demo showed (shots/)

| Shot | What it shows |
|---|---|
| 00-add-daily-driver | Rule 20 / D11: in H01's Driver list, **+ Add daily driver…** → name + mobile → saved as a daily driver (`DAY-261004-1`, "Khalid Juma (daily)") and put on the load. H01 had no Dispatch button until a driver was set. |
| 01-plan-driver-link-qr | D1: the **Link** dialog for S01. It shows the QR, the link (24-character token, about 144 bits), Copy, WhatsApp, "Works until 5 Oct, 12:00", the open count, Reissue and Revoke. |
| 02-pdf-driver-sheet-with-qr | The PDF driver sheet (kept for documentation) with **DRIVER PAGE** QR first ("Scan with the phone camera - opens in Chrome/Safari"), then the route QR and per-stop location QRs. |
| 03-driver-stop-list-en | The phone page (390x844): date, truck, driver, "All sent", **Start deliveries**, the trip with status "On the road", and the stops with ETA, receiving hours and cases. |
| 03b-driver-hired-truck-daily-driver | The same page for the **hired truck H01** with the **daily driver**: the header says "Hired truck". It needs no account, no PIN and no app. |
| 04-driver-stop-list-ar | Arabic with RTL: one tap on العربية. |
| 05-driver-stop-detail-navigate | Stop detail: big **Navigate** (Google Maps directions to the pin), planned arrival, "Unload until", receiving hours, cases per product per sales order, access notes, Call dispatcher, **I have arrived** and the 3 result buttons. |
| 06-driver-auto-timer-at-stop | D3: the **automatic timer**. GPS was emulated, driving from the depot into Qurum Fresh Mart (about 30 m from the pin). The arrival was taken by itself about 20 s later: "Arrived 07:00 · Unloading 1 min · Keep this page open…". |
| 07-driver-photo-step | D4: Delivered → **Take photo** (the camera file input was fed a synthetic JPEG) → preview with Use photo / Retake. Save stays grey until there is a photo, or "Camera not working". |
| 07b-driver-delivered-with-photo | The stop after Save: "Done 07:01 · 1 min", Delivered, the photo, Change result / Undo result. |
| 08-driver-not-delivered-reason | Muttrah Corniche Traders: Not delivered → reason list (Shop closed chosen). |
| 09-driver-waiting-to-send-offline | D5: Ruwi Star with the **network cut** (DevTools offline). Partly delivered 50/60 + 40/40 = 90 of 100, reason Damaged goods, a note and a photo. The header shows "No signal · 2" and the result "Saved on phone - waiting to send" with "Photos waiting to send: 1". |
| 09b-driver-list-waiting-to-send | The trip list while offline. Back online, everything was sent within about 1 s, once (no duplicate events). |
| 10-driver-back-at-depot | Back at the depot pin: **Back at depot?** confirmation. |
| 10b-driver-trip-done | D6: the load became **COMPLETED** by itself (every stop had a result): "Done 3/3 · Back at depot 07:08". |
| 11-dispatcher-plan-progress-results | D8: the plan (1366x900). S01 shows "COMPLETED · Delivered 1/3 · 1 partly · 1 not delivered · Back 07:08". The stop table shows Result + reason + "by driver", Arrived / Left, **Unload plan 20 / actual 2.6 min**, and photo links. H01 shows "hired", Khalid Juma (daily) and "5 no result". |
| 11b-dispatcher-photo-viewer | Photo viewer: "4 Oct, 07:01 · 29 m from pin · taken earlier (before the arrival)". See the note on "taken earlier" below. |
| 12-dispatcher-deliveries-day-summary | Day summary card: "4 of 9 stops have a result · 2 delivered in full · 1 partly · 1 not delivered · 5 no result yet", reasons with cases, "Arrived inside the window 100 % (of 4)", and the **"Back at the depot, no result recorded (counted as delivered)"** list (H01's 5 stops) with **Record**. |
| 12b-dispatcher-record-outcome | D6: the dispatcher records a result for S02 (driver without a phone): Delivered, Arrived 07:02, Left 07:08, with a note. It is audited with her name. |
| 13-bring-forward-not-delivered-reason | D7: Bring forward on 5 Oct lists **Ruwi 10 of 100 - Partly delivered: … Damaged goods (driver) (S01 L1 stop 3)** and **Muttrah 130 - Not delivered: Shop closed (driver) (S01 L1 stop 2)**, both **ticked by default**. Below: "Dispatched, no result recorded (counted as delivered): H01: 5 stops". |
| 14-delivery-actuals-excel-stops-sheet | D9c: the **Delivery actuals** Excel for 4 Oct. The Stops sheet (37 columns) is rendered as an HTML table in two halves. The workbook is `../delivery-actuals-2026-10-04.xlsx`, and its Summary and Reasons sheets are correct (cases delivered 73.1 % = 380/520). |
| 15-dashboard-deliveries-kpis | D9d: Dashboard Deliveries tile (7 / 30 days): delivered in full 50 %, inside the window 100 %, not delivered by reason. |

Also checked:
- **Stored data:** 12 stop events for S01 (ARRIVED / DEPARTED PHONE_AUTO, OUTCOME and PHOTO PHONE_MANUAL, BACK_AT_DEPOT), each with time, position, accuracy and distance from the pin (18-34 m at the shops). There is no track and no duplicates.
- **Visits:** autoServiceMinutes 2.6 / – / 0.8, and timingSuspect false. The emulated GPS used jitter and whole-metre accuracies.
- **Photos:** stored at 1600x1200, about 51-54 KB each (input 2000x1500, about 120 KB).
- **Audit names the actor** as "Driver link: Hamed Salim (S01, 4 Oct) · link #1"; the load completion reads "Driver link: Hamed Salim (S01, back at depot)".
- **Photo access:** with the S01 token, 200. With the H01 token (another truck-day), 404. With no session, 401. With the office session, 200.
- **Response headers** on /d/<token> and /api/d/*: Referrer-Policy no-referrer, X-Robots-Tag noindex, Cache-Control no-store, frame-ancestors none. The page HTML is an empty shell (no customer names in it), and an unknown token gives 404 LINK_NOT_FOUND.
- **WhatsApp message** for S01 contains "Your trips and delivery results: <link>", followed by the stops and map links.
- **D11:** changing S02's driver after its link was made asked "The driver link for S02 on 4 Oct was made for Saeed Nasser. Reissue it for Khalid Juma? …" (Keep link / Reissue link). Changing it back did not ask.

Not shown (they need history): **measured unloading time** ("Use measured time" needs at least 3 auto-timed visits per customer) and the admin's **"Pin may be wrong"** list (2 of the last 3 visits more than 150 m away). Both are covered by unit tests only.

## Bugs / issues seen

1. **Driver page can hang on "Loading…" when the browser's CacheStorage fails (medium, robustness).**
   - Where: `apps/web/public/driver-sw.js` lines 61-78.
   - The `/_next/static/` handler is cache-first: `caches.open(STATIC).then(...)` with no `.catch(() => fetch(req))`.
   - Here (headless Chrome) CacheStorage threw "Unexpected internal error". After the service worker took control, every new page load under `/d/` failed all its JS chunks (net::ERR_FAILED) and stayed on "Loading…".
   - A phone with full or broken site storage would brick the same way until its site data is cleared.
   - Fix: fall back to the network when any cache call rejects.
   - Related: under `next dev` the chunk URLs are not content-hashed, so cache-first serves stale JS to a developer. Register the worker only in production builds.
   - For the demo, the service worker was bypassed with DevTools (`Network.setBypassServiceWorker`).
2. **Bring forward wording is wrong for auto-ticked rows (low).**
   - Where: `carry-over-panel.tsx:235` and the group heading from `carry-view.ts:79`.
   - Today's rows that are ticked by default (driver result settled, truck back) still show "Today (4 Oct) - may still leave today … Not ticked by default: 2 ticked by you". The dispatcher ticked nothing, and the loads had already come back (shot 13).
3. **Daily driver's mobile kept in the audit log (low, privacy).**
   - The `CASUAL_DRIVER_ADDED` audit row's afterJson stores the phone ("+968 9000 0099"). `clearIdleCasualDrivers` erases `Driver.phone` after the retention, but the audit copy stays.
   - The guides tell drivers the mobile is erased. Either redact `phone` in that audit row or change the wording.
4. **Timer stays on after the last trip is done (low).** After Back at depot completed the only trip, the page still showed "Automatic timer on" and kept the location watch running, which uses battery for nothing. It could stop by itself when no DISPATCHED trip is left (shot 10b).
5. **Cosmetic, Dashboard:** the Deliveries tile says "Shop closed 1 stops / 130 cases", while the day card says "1 stop".
6. **Cosmetic, phone stop rows:** at 390 px "Cases:" and its number wrap onto separate lines (EN and AR, shots 03/04). Use nowrap on the pair.
7. **Cosmetic, photo label:** in the result form the heading stays "Photo required" after a photo was added to the draft. It only counts photos already sent for the stop. The thumbnail shows and Save is enabled, so only the label is wrong.
8. **Cosmetic, Excel Summary:** "Made 2026-10-04 03:10 UTC" is in UTC, while every other time in the workbook is Muscat time.
9. **Pre-existing, not from this branch:**
   - The Dispatch button needs SUPERVISOR or higher (`canApproveOverride`), so a PLANNER login (named "dispatcher" in the seeds) cannot dispatch, and rule 20 never comes up for it. The demo user was made a SUPERVISOR.
   - The Dashboard still has the old "LATE DELIVERIES — v2 feature — time windows not enforced in v1" tile next to the new on-time KPI.
   - The dev helper `.dev/mint-session.ts` no longer makes a valid session: it lacks the `authTime` and `pwf` claims that `lib/session-principal.ts` now requires. The demo used a copy that adds them.

Notes on the demo itself (not app bugs):
- **"taken earlier (before the arrival)" on both photos is correct.** The synthetic JPEGs were made at 06:17, so their file time is older than the 07:00 arrival, and the server flagged them like a gallery photo. A real camera capture has the current time.
- **One stop-timer interruption came from the test rig.** A DevTools session that had granted location reset that permission when it disconnected. The page correctly showed "Location is off: … Tap 'I have arrived'" and stopped the timer, and one more tap on **Start deliveries** resumed it. On a real phone this only happens if the driver revokes location; the page does not restart the timer by itself when location comes back.
- **Times:** stops were driven between 07:00 and 07:08 (real time, after the 07:00 window start), so the measured minutes are short (2.6 / 0.8 min).
- **An extra Chrome call:** while checking the Chrome version, `chrome.exe --version` was run once without a separate profile. Chrome printed "Opening in existing browser session", so it may have opened an empty window in the user's normal Chrome. Nothing else touched that browser.
