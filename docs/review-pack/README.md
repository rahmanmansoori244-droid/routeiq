# Review pack

This folder gives a code reviewer the background that is not in the code: the September audit, the design specs, the build notes and the benchmark reports. It was added on 7 Oct 2026. Most of these files were working documents on the owner's computer, and this is the first time they are on GitHub.

The files are kept as they were written. They record what was true **on their date**. When they disagree with the code or with `docs/PROJECT_HANDBOOK.md`, the code and the handbook are correct. Real customer codes and names have been replaced with `CUST-A` to `CUST-E`.

## Where to start

1. **`docs/PROJECT_HANDBOOK.md`:** the main reference. It covers what RouteIQ does, the owner's rules, every module, the test tables and the timeline of changes.
2. **`docs/LOCAL_DEV.md`:** how to run it locally. `.github/workflows/ci.yml` shows exactly what CI runs.
3. **The pull requests on GitHub (#1 onward):** each description gives the reason for the change, the design and the tests.
4. **This folder:** the history behind the decisions.

## What is here

| Path | What it is |
|---|---|
| `audit-2026-09-27/` | The full audit of 27 Sep 2026: auth, infra, intake, lifecycle, solver and UI. Each area has its findings and its coverage gaps. It also has the verified assessment and the findings register (JSON). The findings were then fixed in the stabilization and audit PRs (#34 onward); the handbook timeline lists them. |
| `design/` | The specs written before building three features: delivery outcomes and the driver phone page, pallet capacity, and the planning rules. Each spec was revised after critiques. |
| `build-notes/` | Notes taken during three builds (dispatcher drivers, driver page, hire suggestion). They include end-to-end demo results and the issues found in them. |
| `benchmarks/` | Optimizer benchmarks: OR-Tools alone against the PyVRP hybrid, bounds, public instances, and the accuracy replays from the P6 work. |
| `benchmark-2026-10-08/` | The outside simulation and optimization benchmark of 8 Oct 2026 (report only; findings F01-F07, see below). Its evidence bundle, with the synthetic days, the saved runs and an independent checker that imports no RouteIQ code, stays on the archive branch `evidence/benchmark-2026-10-08` (not merged). The three requests the fixes replay are in `apps/solver/tests/fixtures/benchmark-2026-10-08/`. |
| `operational-rules-19-26-gap.md` | The gap analysis of the owner's operational rules 19 to 26 (29 Sep). |
| `RouteIQ_Progress_and_Test_Guide_2026-09-25.md` | The progress and test guide as of 25 Sep. |
| `RouteIQ_Project_Brain_2026-09-28.html` | An interactive map of the project as of 28 Sep. Open it in a browser. |

## Bugs found by outside review and already fixed

Please don't report these again unless the fix is wrong.

| # | Bug | Fixed in |
|---|---|---|
| 1 | Undoing a carry-forward could delete only part of the brought-forward copies. | #59 (all-or-nothing undo) |
| 2 | Customer matching on intake treated `_` and `%` in a customer code as wildcards. | #59 (literal customer code identity, `lib/customer-code.ts`) |
| 3 | A truck working from two depots on one day could record a driver's result against the other depot's customer, because both had a "Load 1". | #60 (stop keys include the depot; an ambiguous old key is refused) |
| 4 | The hire what-if split customer orders by the own fleet's sizes before adding the trucks to rent, so it could suggest two rentals where one was enough. | #60 (split with the rental sizes; first-fit decreasing) |
| 5 | Per-km rental pricing used the day's average distance, so it could rule out the cheaper set of trucks to rent. | #61 (lower-bound ranking, actual-km comparison, "not proven cheapest" note) |
| 6 | Quick searches kept the departure time from when the job was queued, not from when it started. | #62 |
| 7 | "Use this plan" for a rental suggestion missed concurrent changes: a deactivated option, a lowered maximum, a changed plan. | #62 (re-check under locks) |
| 8 | The driver page could not reload offline after the first QR visit. | #62 (the service worker pre-caches the first visit) |
| 9 | Rental cost scaling could stop PyVRP finding any feasible plan. | #62 (penalty ceiling follows the request's scale) |
| 10 | PyVRP's missing-stop count was always 0. | #62 |
| 11 | Benchmark F02: a stop the route search planned, lost when exact timing removed its load, was never offered back on its own, so it stayed unserved while a truck stood idle (P02: C3, 54 cases). | #64 (wider fit pool; recovery of left-out stops in strict priority order) |
| 12 | Benchmark F07: a same-day re-plan whose search plan broke the driver breaks kept 84 of 180 stops, with 3 P1 and 20 P2 left out, while a checked plan serving all 180 existed (D5). | #64 (a fully timed incumbent before the fit repack, recovery, more of the request's time when P1-P3 work is still out, a constructive fallback) |
| 13 | Benchmark F01: with a short time limit an option could keep only a plan that breaks the rules (VIOLATED), so the dispatcher had nothing usable (D3 at 60 s). | #64 (a checked partial plan whose left-out orders say why; VIOLATED only when nothing of the plan can be timed) |

## Benchmark of 8 Oct 2026: what is fixed and what is not

- **F01, F02 and F07** are fixed (rows 11-13 above). The handbook's section 4.11 gives the recovery and fallback rules.
- **F03 is owner policy, not a bug.** A customer whose order fits one truck (own or rental) stays one visit, even when splitting it between an own truck and a small rental would be cheaper (the report's 110 against 30 OMR example). The owner decided this on 8 Oct 2026 (handbook 6.2).
- **F04 and F05 matter only with kg limits.** Both are about weight: greedy packing of items by kg (F04), and a heavy case checked against the own fleet's payload before a rental is considered (F05). NMWC plans by pallets with payload 0 (no kg limit), so neither affects its plans today.
- **F06 is wording.** The search report describes the main engine's last improvement as the history of the chosen plan, also when the chosen plan came from PyVRP. It does not change any plan.
- **Next fix:** PyVRP's penalty scaling (its default ceiling is far below the strict service values, so it can find no feasible plan on a tight day) and its preferred windows, which it treats as hard windows. These are in `pyvrp_candidate.py` and are deliberately not part of the F01/F02/F07 fix.

## Known open items (not bugs, or not built yet)

- **Rule 19, order hold/cancel:** not built yet.
- **The driver phone's "refused" change:** when a result changes to "refused" after Bring forward, only the first brought-forward copy is flagged.
- **Ayun GPS tracking link:** not built. The stop-event table has a `source` column ready for it.
- **Real-phone testing:** still to do on one Android and one iPhone. It covers the camera, the screen staying awake, iOS Safari, in-app browsers, and opening the QR offline after one visit.
- **Arabic text on the driver page:** not yet reviewed by a native speaker.
- **SheetJS:** it is installed from `cdn.sheetjs.com`, as `pnpm-lock.yaml` pins. Sandboxes that block that domain cannot install it, and the 5 upload test files then fail. CI is not affected.
- **Scope:** pre-sales delivery only. Home delivery and van sales are out of scope for now.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
