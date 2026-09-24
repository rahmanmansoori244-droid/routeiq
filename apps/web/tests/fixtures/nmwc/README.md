# NMWC dispatch fixtures

Sample daily sales-order files for the NMWC dispatch-planning MVP, in the NMWC ERP export
shape. They are **generated**, never hand-edited:

```bash
cd apps/web
pnpm fixtures:dispatch -- --date=2026-09-25            # rewrites this folder
pnpm fixtures:dispatch -- --date=2026-10-01 --out=../../.dev/fixtures
```

Everything comes from `prisma/nmwc-dispatch-data.ts` (pure, seeded PRNG). The same `--date`
always gives byte-identical files, and `orders-150.xlsx` is identical to the file
`pnpm db:seed:dispatch -- --orders=<date>` writes to `<repo>/.dev/`.

## Dates: regenerate in tests, do not rely on these files' date

The committed files are for delivery date **2026-09-25** (SO dates 23-24/09/2026). Once that date
is in the past, or after 18:00 Asia/Muscat on 24/09/2026, uploading them counts as a LATE
order / past date. **Tests should build their files at runtime for a future date** with the
exported generators; the committed files are only examples to open in Excel and for manual demos.

```ts
import { generateOrderRows, generateLateOrderRows, pickLateP1Customer, rowsToCsv, rowsToXlsxBuffer,
  summarizeOrderRows, ORDER_FILE_PRESETS } from '@/prisma/nmwc-dispatch-data';
import { addDaysIso, todayIso } from '@/lib/dispatch/time';

// +2 days: before the 18:00 cutoff whatever time the test runs (tomorrow is LATE after 18:00).
const date = addDaysIso(todayIso('Asia/Muscat'), 2);
const rows = generateOrderRows({ date, ...ORDER_FILE_PRESETS.small });
const csv = new File([rowsToCsv(rows)], 'orders.csv', { type: 'text/csv' });
const xlsx = new File([rowsToXlsxBuffer(rows)], 'orders.xlsx');
const expected = summarizeOrderRows(rows); // cases, casesBySku, casesBySalesOrder -> reconciliation
```

To load the matching master data into a throwaway test tenant:

```ts
import { seedNmwcMasterData } from '@/prisma/seed-nmwc-dispatch';
await seedNmwcMasterData(prisma, tenantId);                     // 180 branches
await seedNmwcMasterData(prisma, tenantId, { customers: 480 }); // for the large file
```

## Files (delivery date 2026-09-25)

| File | Rows | Stops | Sales orders | Cases | What it exercises |
|---|---|---|---|---|---|
| `orders-20.csv` | 47 | 20 | 22 | 1,394 | Small clean day for fast tests. 2 customers without coordinates (C1131, C1169), 2 customers with two SO numbers. |
| `orders-150.xlsx` | 345 | 150 | 157 | 8,748 (~104 t) | The realistic demo day: 3 unknown customers (C9001-C9003 -> new "LOCATION REQUIRED" stubs), 1 unknown item code (`TAN-750-SC`, 22 cases on C1118), 7 of the 8 customers without coordinates, 7 customers with two SO numbers, all 14 hypermarket branches, chain branches B01-B03. Needs ~1.3 fleet trips. |
| `orders-large.csv` | 885 | 400 | 435 | 17,718 (~212 t) | Benchmark. 154 stops from the demo master + 246 from the extended master (C2001+): **seed with `--customers=480`**, otherwise those become unknown customers. Close to 3 loads per truck, so shift/trip limits and priority-respecting drops show up. |
| `late-p1.csv` | 1 | 1 | 1 | 42 | One late P1 order (`SO260925-L001`) for C1036 Sadaf Hypermarket - Muttrah. Has an extra `Priority` column = `P1`. All P1 branches are already in `orders-150`, so it is an extra order for a stop that is already planned (possibly on a locked load). `generateLateOrderRows(date, code, { branch })` makes one for any customer. |

Unknown customers and the unknown product are part of the file on purpose: the intake must list
them, not drop them. Cases must reconcile exactly: uploaded = planned + unserved, per SKU and
per sales order.

### Columns

`SO No, SO Date, Req. Delivery Date, Customer Code, Branch, Customer Name, Item Code,
Item Description, Qty (Cases), Net Value, CM` (the headers the built-in aliases in
`lib/dispatch/order-intake.ts` map with no tenant configuration).

- Dates are `DD/MM/YYYY` text (tenant `dateOrder` = DMY). In the xlsx, quantities and values are
  real numbers; dates stay text.
- `Branch` is blank for single-site customers and `B01`, `B02`, ... for chains (same customer code).
- One customer's SKUs are several rows; sometimes the same customer has two SO numbers (the second
  one further down the file). Both become ONE stop at planning time.
- `Net Value` / `CM` (contribution margin) are OMR with 3 decimals. Prices and margins are
  **illustrative demo values**, not an NMWC price list. `withMargin: false` leaves `CM` blank.

## Master data behind the files (`pnpm db:seed:dispatch`)

- Tenant `nmwc` "National Mineral Water Co. (demo)", Oman, OMR. Depot `MCT-GHALA` Muscat Depot
  (Ghala) 23.5680, 58.3920, open 05:00-23:00.
- 12 trucks T01-T12 (3 large 900 cases / 10.5 t, 5 medium 550 / 6.5 t, 4 small 300 / 3.5 t),
  each with a default driver DR-001..DR-012.
- 9 products (Tanuf / Jabal water, tissue) with case weights.
- 8 customer-type profiles (tenant-editable defaults; a customer's own values win).
- 180 branches / 171 customer codes C1001-C1171 in 18 Muscat-area neighbourhoods (fictional names).
  Chains: C1041 (2 branches), C1047 (3), C1054 (3), C1118 (3), C1121 (2), C1161 (2).
  **8 without coordinates** (C1023, C1033, C1047/B03, C1051, C1082, C1113, C1131, C1169),
  10 with an unconfirmed priority (2 of them with no customer type), 12 verified locations,
  7 with their own receiving windows (two groceries receive only 14:00-21:00).
- Logins `dispatcher@nmwc.local` (PLANNER), `supervisor@nmwc.local` (SUPERVISOR),
  `admin@nmwc.local` (TENANT_ADMIN). Password: `SEED_PASSWORD` env, or a random one printed once
  when the logins are first created. No password is stored in the repo.
