# Benchmark evidence of 8 Oct 2026 (archive branch)

This branch holds an outside benchmark of RouteIQ at commit `5b2ee06`:
- `RouteIQ_Benchmark_Report_2026-10-08.md`: the report.
- `RouteIQ_Benchmark_Evidence_2026-10-08.zip`: its evidence bundle. It contains the synthetic days D1 to D5, the raw requests and answers, the pipeline cases P01 to P05, the exact-reference problems, the public instances, and an independent checker that imports no RouteIQ code.

All data is fictional; there is no real customer data and there are no credentials. The branch is an archive and is not meant to be merged. Fixes take only the small fixtures they need into `main`.

To unpack it outside the checkout:

```bash
git fetch origin evidence/benchmark-2026-10-08
git show FETCH_HEAD:bench/evidence-2026-10-08/RouteIQ_Benchmark_Evidence_2026-10-08.zip > /tmp/routeiq-evidence.zip
unzip -q /tmp/routeiq-evidence.zip -d /tmp/routeiq-evidence
cat /tmp/routeiq-evidence/benchmark-20261008/README.txt
```
