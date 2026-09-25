# Daily dispatch — dispatcher guide (NMWC)

Menu: **Daily dispatch**. Pick the **delivery date** (tomorrow by default) and the **depot**.

## 1. Upload orders
- Click **Choose the sales order file** and select the Excel or CSV exported from the sales system. The usual NMWC columns are recognised automatically (SO No, Req. Delivery Date, Customer Code, Branch, Item Code, Qty (Cases), Net Value, CM, …).
- Click **Check file**. Nothing is saved yet. You see: rows, customers, sales orders, **total cases**, new customers and new products, and any rows that need fixing.
- If a row has an error (for example cases = "abc"), fix the file and check it again. Nothing is half-imported.
- **New customers are not errors.** They are created and marked **LOCATION REQUIRED**.
- If the orders are **late** (after 18:00 the evening before, or after a plan already exists), type the reason.
- Click **Add … lines to the day**.
- **A file is added only once.** Lines already added (same delivery date, sales order, customer and product) are skipped. Adding the same orders a second time — the same file again, a second browser tab, or an old checked file — is refused with a message and nothing is added. The same sales-order line with a **different number of cases** is an error: changing a confirmed line is not supported yet. Remove that row, and add the extra cases as a **late order without a sales-order number** (or with a new one); with the original number the late order is refused as well.
- A checked file must be added within **24 hours**; after that, check it again. If the cutoff passes or a plan is applied between **Check file** and **Add**, you are asked for the late reason at that moment.
- **Weights:** the weight column in a file is the kg of the whole line, and it is kept as it is. A weight of 0 counts as blank. A line without a weight (also a line added together from several rows when some of them have no weight) is weighed with the product's **case weight** and follows it: when a case weight is entered or corrected under **Products** (for example 1500 typed instead of 1.5), open orders get the new weight at the next **OPTIMIZE** or **RE-PLAN**. New products are created without a case weight. Only company admins can edit products: planners and supervisors ask an admin to add or correct it (see step 3).
- **Deleting a file** (old *Upload orders* page) is possible only while none of its orders has been optimized. Once a plan was made with them, the delete is refused, so the plan keeps every order it was made for. **Orders that are in a plan cannot be removed in the app yet** (a cancel function is not built yet): a late order only adds orders and a re-plan plans the same orders again, so neither removes them. If a wrong file was planned, ask your RouteIQ administrator.

## 2. Resolve issues
Red cards need action before optimizing:
- **ADD LOCATION**: paste the customer's Google Maps link (a WhatsApp share link such as `maps.app.goo.gl/…` works) or `latitude, longitude`, click **Read**, check the pin, then **Save location**.
  - If the link only shows the map area and not a pin, or the point looks wrong, click the map to put the pin exactly on the shop.
  - The location is saved permanently. Tomorrow RouteIQ already knows this customer.

A red card **Customer is deactivated** means the customer was deactivated after its orders were added: its open orders are not delivered (they show as *unserved: customer deactivated*). Reactivate the customer under **Customers** and re-plan to deliver them. If the plan was made before the customer was deactivated, the card says its orders are **still on planned loads**: click **RE-PLAN** to take them off (or reactivate the customer). Orders already on locked, loading or dispatched loads stay there, and the card is not shown for them.

Below the cards:
- *No weight for N cases of …*: those products have no case weight, so truck payloads (kg) cannot be checked for them. Add the case weight under **Products**, or ask a company admin to (only admins can edit products).
- *Case weight entered or corrected under Products after these orders were added …*: it is applied to them at the next **OPTIMIZE** or **RE-PLAN** (orders on locked or dispatched loads keep the weight they were loaded with). If a plan is already in use, step 3 says the plan is out of date and **RE-PLAN** is enabled even with no new order.

White cards are optional confirmations: priority (**P1 = highest**), customer type and receiving hours.
- **Hard hours:** the customer cannot receive outside them, e.g. hypermarket 06:00–10:00.
- **Preferred hours:** nice to have.

## 3. Optimize
- Click **OPTIMIZE**. A normal day (80-150 customers) takes about half a minute to a minute.
- If some customers still have no location, you are asked whether to plan without them. Their orders become *unserved: location missing*.
- If some order lines have **no weight** and a truck has a payload, you are asked the same way: **Cancel** and add the case weights under **Products** (planners and supervisors: ask a company admin, only admins can edit products), or **optimize anyway** — those lines then count as **0 kg**, so a load can be heavier than shown, and the plan keeps a yellow warning that says so. **Re-plan** asks the same question.
- One case heavier than every truck (usually a case weight typed per pallet or in grams) is not planned: it shows as *unserved: bigger than any truck* with *check the product weight*. The rest of that order is planned.
- A stop that would need more than 8 hours (480 min) of unloading is planned with 480 min and the plan warns about it; check the service time or split the delivery.
- **RE-PLAN without a new order:** step 3 also enables **RE-PLAN** when the plan in use is out of date: a case weight was entered or corrected for its orders, or a customer was deactivated while its orders are still on planned (not locked) loads. The plan view shows the same notes in yellow.
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
- A driver you pick in the **Driver** list stays on that trip (the same truck and trip number) through every re-plan (late order, **Re-plan**, **Use instead**), even when the new times overlap one of their locked, loading or dispatched loads, or another trip you gave the same driver: the plan then shows the yellow warning, and you decide who drives which. (A trip RouteIQ filled in with that driver at those times gets another driver instead.) Under the list, such a driver reads **picked by hand**. If you have set that driver to inactive since, RouteIQ fills the trip in instead and says so in yellow.
- A driver RouteIQ filled in has a **Keep** link under the list instead, while you can change that load's driver (not once the load is dispatched, not while the plan is being optimized, and not for an inactive driver). Press **Keep** when you agree with that driver: it becomes your pick and re-plans keep it on that trip. (Choosing the same name again in the list does nothing.) A driver picked before the September 2026 update counts as filled in by RouteIQ until you press **Keep**.
- A re-plan or **Use instead** never changes the driver of a locked, loading or dispatched load.
- Every other trip RouteIQ fills in, starting with the trip whose time moved least: the driver the trip already had, else the driver of the same truck's nearest trip, else the truck's **Default driver** - the first of them who is active and not on another trip at that time. So when a re-plan moves one of two trips of the same driver onto the other's hours (or onto their locked, loading or dispatched load), the trip that moved gets the next driver in that order, or **No driver** for you to fill. Trip 1 and trip 2 of one truck can have the same driver. A late order, **Re-plan** and **Use instead** decide the same trips the same way, whichever truck is listed first.
- A trip that lost or changed its driver is listed in yellow on the plan, for example *Driver changed by this plan: T02 · L1 (10:00–12:00) Ali → Sam, because Ali is on T03 · L1 at that time*, until you set a driver for that trip (another one, or **Keep** to agree with RouteIQ's). A trip that only got a driver (it had none) is not listed. The re-plan's message and **Use instead** also say how many driver notes the plan has. Check the drivers after every re-plan.
- If a re-plan or **Use instead** has no such trip for a driver you picked (for example **MIN_TRUCKS** leaves a truck out, or a truck gets fewer trips), the plan says so in yellow, for example *Driver picked by hand, not in this plan: you picked Bob for T03 · L1 (08:00–10:00), and this plan has no such trip. If a later plan has that trip again, pick the driver again.* RouteIQ does not put Bob back by itself: a later plan (or **Use instead** back to the first option) fills that trip in like any other, so pick Bob again if he should drive it.
- **No driver** is not kept through a re-plan: RouteIQ fills the trip in like any other (the driver of the truck's nearest trip, or the truck's usual driver), without a note, and never as your pick. To stop a driver being put back (for example, on leave), clear the truck's **Default driver** or set the driver to inactive under **Drivers**.
- If you pick a driver who is already on another truck at the same time, the plan shows a yellow warning and the driver list turns yellow. Pick another driver for one of the two loads. If a driver change cannot be saved (or its answer is lost), the plan is loaded again, so the list shows the driver RouteIQ has, or the plan says it may be out of date, with **Try again**.
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
  - A sales-order line that is already on the day (same sales order and product) is refused: enter only new lines. For **extra cases** of a line already added, leave the sales-order number empty, or use a new one.
  - A deactivated customer or product is refused: reactivate it, or use another code.
  - A new product has no case weight yet: add it under **Products** (or ask a company admin) before re-planning, or the re-plan asks before counting it as 0 kg.
  - *Another order file or late order is being added right now*: nothing was saved; try again in a moment.
- Click **Re-plan**. RouteIQ creates **plan version 2**:
  - locked, loading and dispatched loads stay exactly the same;
  - the late order goes into a free future load, another truck or an extra load, or is shown as *unserved: late order – no capacity*;
  - the blue bar tells you what changed.
- Older versions stay under **Plan versions** (read-only).
- A late-order re-plan keeps the other orders on their trucks where it can, so drivers and loading are not reshuffled for one order.
- **Re-plan** (on the plan, or **RE-PLAN** in step 3) with no late order waiting is a full re-optimize: RouteIQ looks for the best plan for everything not locked, even if that moves orders to other trucks. Lock the loads the warehouse has started first, and send new driver sheets for the loads that changed.
- **Nothing to plan:** when every order is already on a locked, loading or dispatched load (and nothing is unserved or waiting), **Re-plan** is greyed out and step 3 says *nothing left to plan*. To change a load, unlock it first (a dispatched load cannot be unlocked; for more orders on that day, add a late order).
- **If the optimization fails** (optimizer down, out of time, a system update during the solve), the new version shows *Optimization failed - previous plan kept*: its loads are the previous plan, and you can lock, load and dispatch them as they are. Only locked and dispatched loads are marked *kept*; the others are the previous plan until the next optimization. Weights entered under **Products** since are not applied yet: the plan still warns about them. Click **Re-plan** to try again.
- While an action runs (a lock, **Lock all loads**, **Use instead**, **Re-plan**, a late order's **Re-plan now**, or step 3's **OPTIMIZE / RE-PLAN**), the other buttons wait for it, until the screen shows its result. If two people change the same plan at once, one of them may see *Plan is being saved - retry in a moment*: nothing was changed, just click again.
- If the connection drops (or RouteIQ is being updated) while you click, you see *The server could not be reached*. The plan stays on screen (it may be out of date) with **Try again**; if the day could not be loaded either, the day shows **Try again** at the top. When the connection is back, click **Try again** (it is off while a reload or another action is still on its way): the screen then shows whether your change was saved, and the buttons work again. Click again if the change was not saved. A late order you are typing and the loads you opened stay open when the day comes back after a lost connection.
- An option that found no plan shows *No plan* instead of **Use instead**.
- **Busy optimizer:** one optimization per company runs at a time (with the standard settings); up to two more wait (*Queued: other optimizations are running*) and start on their own, in the order they were queued. A further one is refused with *Your company already has 2 optimization(s) waiting*: try again once one has started. When the optimizer is very busy with other companies, a second one may be refused with *The route optimizer is busy with other plans* while your first one waits; your first one is always queued. After many optimizations in one hour RouteIQ asks you to wait a few minutes.

## Changing date or depot
While the new day loads, the screen shows *Loading ...* and its buttons are off; if it cannot be loaded, you see the error and **Try again** instead of the previous day. Everything you do (upload, confirm, optimize) is always for the day on the screen. If you change the date while a lock, OPTIMIZE, **Add … lines to the day** or a save is still running, it finishes for the day you started it on, and the screen then shows the date you picked. A **Check file** that finishes after you changed the date is not shown: check the file again for the day on screen. After **Add … lines to the day**, a file for another delivery date moves the screen to that date, unless you picked another date meanwhile.

## Dispatch timing settings (Settings → Dispatch timing, admins)
Set these to what the depot and drivers really do; every load is timed with them.
- **First departure:** no truck leaves before this time (e.g. 07:30).
- **Turnaround between loads (minutes):** fixed depot time between two loads of one truck (paperwork, queue). Default 30.
- **Loading minutes per case:** added to the turnaround for every case of the next load. 0.04 = 44 min extra for a 1,100-case load. Default 0.
- **Unloading minutes per case:** added to each customer's service time for every case delivered. 0.05 = 55 min extra for a 1,100-case drop. Default 0. A split delivery part gets its share of the customer's time plus its own cases.
- **Max loads per truck per day:** default 3; a truck's own limit wins when it has one.

Changes apply to the next **OPTIMIZE** or **Re-plan**; plans already made keep their times.

## Signing in
- A session lasts one shift: after 12 hours you sign in again, even if you kept working. If your account is changed (deactivated, password reset, role changed) the change applies within a minute, and the sign-in page says "Your session has ended". After you sign in again you are back on the dispatch screen with the same day and depot (anything typed in an open dialog is lost).
- Forgot your password? Ask your company admin: on **Users**, **Reset password** gives you a new temporary password. ("Forgot your password?" on the sign-in page works only when reset email is set up; otherwise it says so.)
- After several wrong passwords, sign-in pauses for a few minutes; the message is the same as for a wrong password.
- The old driver phone app (`/driver`) is retired. Drivers get the **driver sheet** (PDF) or the **WhatsApp** message from the plan.
- Deleting a driver who is on any load deactivates the driver instead, so past loads keep their driver.

## Good to know
- "Estimated km" means the road-routing service was not available and straight-line distances were used. The plan is still valid, but check long trips.
- Receiving hours and priority for many customers come from their **customer type**. Set the type once and the defaults apply.
- Everything you save (locations, priorities, hours) is kept on the customer master and in the audit log.
- Customer and product codes are the same whatever their letter case: `c001` and `C001` are one customer. A second one differing only in case cannot be created.
- **Customer import:** a column that is missing or a blank cell never erases what is saved (service time, region, address, payment type, location). A service time in the file (at most 480 min) counts as confirmed for that customer. **Validate only** lists how many customers are new or updated and which confirmed service times would change.
