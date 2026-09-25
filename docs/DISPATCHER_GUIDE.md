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
- Click **OPTIMIZE**. A normal day (~150 customers) takes about half a minute.
- If some customers still have no location, you are asked whether to plan without them. Their orders become *unserved: location missing*.

## 4. Review the plan
- **Top row:** orders served, cases, trucks and loads, km, hours, utilisation, fuel, cost, service % for P1–P5.
- **Green bar:** *uploaded = planned + unserved*. If it is ever red, do not dispatch; report it.
- **Truck loads:** one row per truck and load (T01 · L1, T01 · L2 …) with departure/return, cases vs capacity and km. Click a row to see:
  - the **Loading manifest**: exact cases per product for the warehouse;
  - the **Delivery route**: DEPOT → customer 1 → customer 2 … → DEPOT, with ETA, receiving hours, cases, products and km.
- **Unserved orders:** every order that could not be planned, with the reason. *Rest of split* means the other part of that order is on a truck.
- **Split deliveries:** a customer whose day does not fit on any truck (cases or kg) is delivered in parts — each stop shows *Part 1 of 2*, *Part 2 of 2* and exactly which products and cases it carries. Parts can go on different trucks or loads. Turn this off in **Settings → Operations** if you prefer such customers to be left unserved.
- **Plan options:** MIN TRUCKS and MIN DISTANCE are shown for comparison only. Click **Use instead** only if you really want one of them.

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

## Good to know
- "Estimated km" means the road-routing service was not available and straight-line distances were used. The plan is still valid, but check long trips.
- Receiving hours and priority for many customers come from their **customer type**. Set the type once and the defaults apply.
- Everything you save (locations, priorities, hours) is kept on the customer master and in the audit log.
