# Benchmark of 8 Oct 2026: saved requests

Three solver requests from the outside benchmark of 8 October 2026 (report:
[`docs/review-pack/benchmark-2026-10-08/`](../../../../../docs/review-pack/benchmark-2026-10-08/)), used by
`tests/test_benchmark_replay.py`. They are **synthetic**: fictional customers, orders and invoices,
straight-line distances x 1.3 (Haversine), no real NMWC data. Only the requests are kept here, minified;
the full evidence bundle (raw invoices, saved runs, the independent checker) lives on the archive branch
`evidence/benchmark-2026-10-08` and is not merged.

| File | Day | Finding | What the replay checks |
|---|---|---|---|
| `D5_late_frozen.request.json` | 180 pending stops, 320 invoices, 4,826 cases, 12 trucks, six frozen trips; same-day re-plan at 10:00 with driver breaks | F07 | native QUICK (automatic 110 s search, 540 s cap): every stop served (the greedy witness's [13, 36, 39, 51, 41]), VERIFIED |
| `P02_frozen_late_vip.request.json` | 108 pending stops (6,141 cases) after a frozen 721-case load and a late 40-case P1 order at 11:00 | F02 | native QUICK (20 s search): C3 (54 cases, three invoices) and every other stop served, 6,862 cases with the frozen load, VERIFIED |
| `D3_tight_receiving.request.json` | 200 stops, 340 invoices, 8,393 cases, tight receiving windows and driver breaks | F01 | 60 s search / 240 s cap: a VERIFIED plan (partial allowed) serving every P1-P3 stop, never a VIOLATED-only answer |

The P02 request is the bundle's `pipeline/results/P02-frozen-late-VIP/request.json` with `time_limit_sec`
removed, as its production two-CPU replay sends it. D5 and D3 are `large/<day>/request.json` unchanged;
the replay sets the time limit.

## Replay

The replays run the production worker path (worker processes, the second search on) and take 2-6 minutes
each on 4 CPUs, so they are skipped unless asked for:

```bash
cd apps/solver
ROUTEIQ_BENCH_REPLAY=1 ROUTEIQ_BENCH_OUT=/tmp/replays python -m pytest -q tests/test_benchmark_replay.py
```

`ROUTEIQ_BENCH_OUT` (optional) keeps each `request.json`, `response.json` and `matrix-used.json`.

## Check an output with the bundle's independent checker

The checker imports no RouteIQ code. Unpack the bundle outside the checkout, then check each replay:

```bash
git fetch origin evidence/benchmark-2026-10-08
git show FETCH_HEAD:bench/evidence-2026-10-08/RouteIQ_Benchmark_Evidence_2026-10-08.zip > /tmp/ev.zip
unzip -q /tmp/ev.zip -d /tmp/ev
R=/tmp/replays/D5_late_frozen-auto-540-s17
python /tmp/ev/benchmark-20261008/validation/validate.py "$R/request.json" "$R/response.json" \
  --matrix "$R/matrix-used.json" --output "$R/independent-check.json"
```

`status: PASS` means every hard rule (capacity, windows, breaks, loading readiness and turnaround, shift,
frozen reservations) and the invoice and cost accounting hold. It says nothing about optimality. For the
large days add `--raw-invoices /tmp/ev/benchmark-20261008/large/<day>/invoices.json` to check the
invoice lineage too. The lane READMEs in the bundle (`large/README.txt`, `pipeline/README.md`) describe
the same replays through the bundle's own scripts (`large/run_one.py`, `pipeline/run_production_two_cpu.py`).
