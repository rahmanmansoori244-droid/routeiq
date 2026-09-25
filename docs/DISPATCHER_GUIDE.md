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

## 4. Review the plan
- **Top row:** orders served, cases, trucks and loads, km, hours, utilisation, fuel, cost, service % for P1–P5.
- **Green bar:** *uploaded = planned + unserved*. If it is ever red, do not dispatch; report it.
- **Truck loads:** one row per truck and load (T01 · L1, T01 · L2 …) with departure/return, cases vs capacity and km. Click a row to see:
  - the **Loading manifest**: exact cases per product for the warehouse;
  - the **Delivery route**: DEPOT → customer 1 → customer 2 … → DEPOT, with ETA, receiving hours, cases, products and km.
- **Unserved orders:** every order that could not be planned, with the reason. *Rest of split* means the other part of that order is on a truck. *"Not planned: the optimizer found no truck, trip or time slot ..."* means nothing proves the order impossible: **Re-plan** to search again, add a truck, or raise *Max loads per truck per day*. Reasons such as *receiving hours cannot be met*, *shift limit* or *fleet capacity shortage* mean a check proved it cannot fit.
- **Split deliveries:** a customer whose day does not fit on any truck (cases or kg) is delivered in parts — each stop shows *Part 1 of 2*, *Part 2 of 2* and exactly which products and cases it carries. Parts can go on different trucks or loads. Turn this off in **Settings → Operations** if you prefer such customers to be left unserved.
- **Plan options:** MIN TRUCKS (fewest trucks, then loads, then operating cost) and MIN DISTANCE (fewest km) are shown for comparison only. They never need more trucks / km than the recommendation; when one plan is best on every measure, the options show the same plan. Click **Use instead** only if you really want one of them.

## 5. Lock, export, dispatch
- **Lock** a load when the warehouse starts preparing it. Loads of one truck are locked in order (Load 1 before Load 2).
- **Loading → Dispatch** when the truck leaves. **Dispatched loads can never be changed.**
- **Export Excel** gives the master workbook: summary, load plan, one sheet per truck load (manifest + route, printable), SKU loading summary, unserved, reconciliation, assumptions.

## Late orders (e.g. a P1 customer calls at 22:15)
- Click **Late order** on the plan (or upload a small file in step 1), enter the customer, products, priority and reason.
- Click **Re-plan**. RouteIQ creates **plan version 2**:
  - locked, loading and dispatched loads stay exactly the same;
  - the late order goes into a free future load, another truck or an extra load, or is shown as *unserved: late order – no capacity*;
  - the blue bar tells you what changed.
- Older versions stay under **Plan versions** (read-only).

## Dispatch timing settings (Settings → Dispatch timing, admins)
Set these to what the depot and drivers really do; every load is timed with them.
- **First departure:** no truck leaves before this time (e.g. 07:30).
- **Turnaround between loads (minutes):** fixed depot time between two loads of one truck (paperwork, queue). Default 30.
- **Loading minutes per case:** added to the turnaround for every case of the next load. 0.04 = 44 min extra for a 1,100-case load. Default 0.
- **Unloading minutes per case:** added to each customer's service time for every case delivered. 0.05 = 55 min extra for a 1,100-case drop. Default 0. A split delivery part gets its share of the customer's time plus its own cases.
- **Max loads per truck per day:** default 3; a truck's own limit wins when it has one.

Changes apply to the next **OPTIMIZE** or **Re-plan**; plans already made keep their times.

## Good to know
- "Estimated km" means the road-routing service was not available and straight-line distances were used. The plan is still valid, but check long trips.
- Receiving hours and priority for many customers come from their **customer type**. Set the type once and the defaults apply.
- Everything you save (locations, priorities, hours) is kept on the customer master and in the audit log.
