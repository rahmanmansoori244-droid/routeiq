# Daily dispatch — dispatcher guide (NMWC)

Menu: **Daily dispatch**. Pick the **delivery date** (tomorrow by default) and the **depot**.

## 1. Upload orders
- Click **Choose the sales order file** and select the Excel or CSV exported from the sales system. The usual NMWC columns are recognised automatically (SO No, Req. Delivery Date, Customer Code, Branch, Item Code, Qty (Cases), Net Value, CM, …).
- Click **Check file**. Nothing is saved yet. You see: rows, customers, sales orders, **total cases**, new customers and new products, and any rows that need fixing.
- If a row has an error (for example cases = "abc"), fix the file and check it again. Nothing is half-imported.
- **New customers are not errors.** They are created and marked **LOCATION REQUIRED**.
- If the orders are **late** (after 18:00 the evening before, or after a plan already exists), type the reason.
- Click **Add … lines to the day**.

## 2. Resolve issues
Red cards need action before optimizing:
- **ADD LOCATION**: paste the customer's Google Maps link (a WhatsApp share link such as `maps.app.goo.gl/…` works) or `latitude, longitude`, click **Read**, check the pin, then **Save location**.
  - If the link only shows the map area and not a pin, or the point looks wrong, click the map to put the pin exactly on the shop.
  - The location is saved permanently. Tomorrow RouteIQ already knows this customer.

White cards are optional confirmations: priority (**P1 = highest**), customer type and receiving hours.
- **Hard hours:** the customer cannot receive outside them, e.g. hypermarket 06:00–10:00.
- **Preferred hours:** nice to have.

## 3. Optimize
- Click **OPTIMIZE**. A normal day (80-150 customers) takes about half a minute to a minute.
- If some customers still have no location, you are asked whether to plan without them. Their orders become *unserved: location missing*.
- **Priorities are strict:** one order of a higher priority always wins over any number of lower-priority orders (one P2 is never left out to fit eleven P3s). When the trucks really cannot carry everything, P5 orders are left out first, then P4, and so on.
- After the route search, RouteIQ re-checks which truck carries each load, so trucks do two or three loads each where the day allows instead of many trucks doing one short load. When this changed the plan you see a note such as *"Loads were re-assigned after the route search: 12 -> 5 trucks, 19 -> 14 loads, 720 -> 493 OMR operating cost."*
  - The re-check also tries to place orders the route search left out on free trucks or loads. When it does, the note ends with *"this also plans 2 stop(s) the route search had left out"*: loads and cost can then go up, because more is delivered.
  - Every load is then timed with the exact loading time between loads (Settings → Dispatch timing). The route search only estimates it, so on a tight day with very full loads its plan may not fit. The lowest priorities are then left out until it does, with the note *"... stop(s) the route search had planned are left out: with the loading time between loads ... its loads did not fit the truck days"*. Re-plan, add a truck, or check the loading time.

## 4. Review the plan
- **Top row:** orders served, cases, trucks and loads, km, hours, utilisation, fuel, cost, service % for P1–P5.
- **Green bar:** *uploaded = planned + unserved*. If it is ever red, do not dispatch; report it.
- **Truck loads:** one row per truck and load (T01 · L1, T01 · L2 …) with departure/return, cases vs capacity and km. Click a row to see:
  - the **Loading manifest**: exact cases per product for the warehouse;
  - the **Delivery route**: DEPOT → customer 1 → customer 2 … → DEPOT, with ETA, receiving hours, cases, products and km.
- **Unserved orders:** every order that could not be planned, with the reason. *Rest of split* means the other part of that order is on a truck.
  - *Receiving hours cannot be met*, *Does not fit the shift*, *Bigger than any truck*, *Trucks out of loads*: a check proved the order cannot fit.
  - *Not planned by the optimizer - see reason*: the line under it says why.
    - *"Fleet capacity shortage ..."*: the trucks cannot carry every order today (more cases than all trucks and loads together), so lower priorities are left out first. It does not prove that this order is the one that cannot fit. If far more is unserved than the shortage (the plan then says so), **Re-plan** or add a truck.
    - *"Not planned: the optimizer found no truck, trip or time slot ..."*: nothing proves the order impossible. **Re-plan** to search again, add a truck, or raise *Max loads per truck per day*.
    - *"Not planned: once every load was timed with the loading time between loads ..."*: see step 3.
- **Split deliveries:** a customer whose day does not fit on any truck (cases or kg) is delivered in parts — each stop shows *Part 1 of 2*, *Part 2 of 2* and exactly which products and cases it carries. Parts can go on different trucks or loads. Turn this off in **Settings → Operations** if you prefer such customers to be left unserved.
- **Plan options:** MIN TRUCKS (fewest trucks, then loads, then operating cost) and MIN DISTANCE (fewest km) are shown for comparison only. Unless they serve more orders, they never need more trucks / km than the recommendation; when one plan is best on every measure, the options show the same plan. Click **Use instead** only if you really want one of them.

## 5. Lock, export, dispatch
- **Lock** a load when the warehouse starts preparing it. Loads of one truck are locked in order (Load 1 before Load 2).
- **Loading → Dispatch** when the truck leaves. **Dispatched loads can never be changed.**
- **Export Excel** gives the master workbook: summary, load plan, one sheet per truck load (manifest + route, printable), SKU loading summary, unserved, reconciliation, assumptions.

## Driver sheets
Each driver gets one sheet per truck load: the stops in order with ETA and receiving hours, address and notes, cases per product, sales orders, a map link and QR code per stop, and a box for the customer to write the cases received, sign and stamp. The sheet never shows costs, fuel or margins.

**Assign the drivers**
- Set a **Default driver** for each truck once (menu **Trucks** → edit the truck). Every new plan puts that driver on the truck's loads.
- On the plan, each load row has a **Driver** list. Pick another driver for that load if someone else drives it (or **No driver**). Only active drivers are listed (add or reactivate them under **Drivers**).
- A re-plan (late order, **Re-plan**, **Use instead**) keeps the driver you chose for each trip: the same truck and trip first, then the driver of the truck's nearest trip, then the truck's **Default driver**. RouteIQ never guesses one driver onto two trucks at the same time; such a load is left with **No driver** for you to fill. Check the drivers after every re-plan.
- **No driver** is not kept through a re-plan: the load gets the truck's usual driver back. To stop a driver being put back (for example, on leave), clear the truck's **Default driver** or set the driver to inactive under **Drivers**.
- If you pick a driver who is already on another truck at the same time, the plan shows a yellow warning and the driver list turns yellow. Pick another driver for one of the two loads.
- Once a load is **Dispatched**, its driver can no longer be changed.
- Save each driver's mobile number with the country code (for example `+968 9123 4567`). A local number such as `9123 4567` gets your country's code (+968 in Oman, +971 in the UAE) in the WhatsApp link; in other countries WhatsApp asks you who to send it to.

**Print or send**
- **Driver sheets (PDF)** (next to Export Excel) gives the sheets for all loads of the plan. Each load starts on a new page: print the whole pack and hand each driver their own pages.
- **PDF** on a load row gives only that load's sheet.
- **WhatsApp** on a load row opens WhatsApp with a short message for that load: truck and trip, departure, each stop in order with ETA, cases and map link, then the route link. If the driver has no mobile number saved, WhatsApp asks you who to send it to. Check the message, then press send. **WhatsApp** is greyed out on a replaced plan version and while an optimization runs; a message copied from a replaced version starts with *REPLACED BY A NEWER PLAN - DO NOT USE*.
- On the sheet, **Route in Google Maps** (and the QR code at the top) opens the whole trip from the depot, stop by stop, and back. Long trips are split into parts, because a Google Maps link takes at most 9 stops between its start and end.
- A stop without a saved location says **No location - call dispatcher** and is left out of the route link.
- **Split deliveries** show *Part 1 of 2* and where the other part goes (truck and trip).
- A sheet is **void if a newer plan version is issued**: after a re-plan, print or send the new sheets for the loads that changed.
- The sheet prints Latin letters only. Text it cannot print (for example Arabic names or notes) shows as **[?]**, and the sheet says so: tell the driver, or also send the WhatsApp message, which shows the customer names in full.

The Excel workbook stays the dispatcher and warehouse file (loading manifests, costs, reconciliation); the driver sheets are for the drivers only.

## Late orders (e.g. a P1 customer calls at 22:15)
- Click **Late order** on the plan (or upload a small file in step 1), enter the customer, products, priority and reason.
- Click **Re-plan**. RouteIQ creates **plan version 2**:
  - locked, loading and dispatched loads stay exactly the same;
  - the late order goes into a free future load, another truck or an extra load, or is shown as *unserved: late order – no capacity*;
  - the blue bar tells you what changed.
- Older versions stay under **Plan versions** (read-only).
- A late-order re-plan keeps the other orders on their trucks where it can, so drivers and loading are not reshuffled for one order.
- **Re-plan** (on the plan, or **RE-PLAN** in step 3) with no late order waiting is a full re-optimize: RouteIQ looks for the best plan for everything not locked, even if that moves orders to other trucks. Lock the loads the warehouse has started first, and send new driver sheets for the loads that changed.

## Dispatch timing settings (Settings → Dispatch timing, admins)
Set these to what the depot and drivers really do; every load is timed with them.
- **First departure:** no truck leaves before this time (e.g. 07:30).
- **Turnaround between loads (minutes):** fixed depot time between two loads of one truck (paperwork, queue). Default 30.
- **Loading minutes per case:** added to the turnaround for every case of the next load. 0.04 = 44 min extra for a 1,100-case load. Default 0.
- **Unloading minutes per case:** added to each customer's service time for every case delivered. 0.05 = 55 min extra for a 1,100-case drop. Default 0. A split delivery part gets its share of the customer's time plus its own cases.
- **Max loads per truck per day:** default 3; a truck's own limit wins when it has one.

Changes apply to the next **OPTIMIZE** or **Re-plan**; plans already made keep their times.

## Signing in
- A session lasts one shift: after 12 hours you sign in again, even if you kept working. If your account is changed (deactivated, password reset, role changed) the change applies within a minute, and the sign-in page says "Your session has ended".
- After several wrong passwords, sign-in pauses for a few minutes; the message is the same as for a wrong password.
- The old driver phone app (`/driver`) is retired. Drivers get the **driver sheet** (PDF) or the **WhatsApp** message from the plan.
- Deleting a driver who is on any load deactivates the driver instead, so past loads keep their driver.

## Good to know
- "Estimated km" means the road-routing service was not available and straight-line distances were used. The plan is still valid, but check long trips.
- Receiving hours and priority for many customers come from their **customer type**. Set the type once and the defaults apply.
- Everything you save (locations, priorities, hours) is kept on the customer master and in the audit log.
