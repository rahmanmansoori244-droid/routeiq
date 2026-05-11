# Test fixtures

Static CSV samples used by the Vitest integration tests. These complement the
`/api/orders/sample?mode=...` runtime generator, which is bound to a live
tenant's master data — the static fixtures here are deterministic and don't
depend on the seeded NMWC customers.

The fixtures use placeholder customer/product codes from `nmwc-fixture-seed.sql`
(invoked once before any fixture test). That seed mirrors a minimal NMWC tenant
with the customer codes referenced below.

| File | Purpose |
|---|---|
| `nmwc-small.csv` | 20 valid rows for fast unit + integration tests |
| `nmwc-normal.csv` | 150 valid rows matching the seeded NMWC customers |
| `nmwc-stress.csv` | 2000 valid rows for the upload-hardening test |
| `nmwc-bad.csv` | Same shape as normal but with deliberate errors per row (missing columns, unknown codes, negative quantities, malformed dates) — for the validation-rejection acceptance test |
| `nmwc-priority-mix.csv` | 30 rows with explicit priorities 1-5 and intentionally-tight capacity → validates priority-respecting drops in the solver |
| `nmwc-blank-branch.csv` | Customers with blank `branch_code` → exercises `branchKey` normalization in CSV import |
| `nmwc-manual-baseline.csv` | Sample manual baseline (truck/customer/sequence) for the baseline-comparison test |
