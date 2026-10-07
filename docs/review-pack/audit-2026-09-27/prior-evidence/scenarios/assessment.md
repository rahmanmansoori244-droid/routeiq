# Scenario and benchmark evidence at 83d8174

## Verdict
The changes address issues the large samples exposed, rather than merely adding passing toy tests: current code refuses two order sheets instead of silently discarding one, counts real invoices separately from customer deliveries, preserves a deactivated customer's previously confirmed retry as duplicates, includes frozen trucks in physical counts, explains preference-versus-cost tradeoffs, and extends search time for 121–200 stops. Same-day timing changed again in PR8. This is materially stronger engineering. It is not yet a independently demonstrated full-scale operational acceptance of this final commit.

## Independent checks performed here
`node review-20260927/scenarios/check_large_intake.mjs` executes original current TypeScript functions (Node type stripping, database module stubbed for import). It does not run a server, database transaction, actual XLSX parser, OR-Tools search, or production.

| Sample | Distinct invoices | SKU rows | Cases | Customer branches | Active split portions checked |
|---|---:|---:|---:|---:|---:|
| S01 | 320 | 971 | 6384 | 200 | 200 |
| S02 | 350 | 1010 | 7663 | 195 | 197 |
| S03 | 400 | 1203 | 7737 | 240 | 240 |
| S04 | 400 | 1198 | 7722 | 230 | 190 |
| S05 | 450 | 1358 | 8888 | 340 | 338 |
| Total | 1920 | 5740 | 38394 | 1205 across separate days | 1165 |

22 checks passed; one bounded upload-timeout defect reproduced. All five normalizers/resolvers preserve case totals, all 1165 active portions agree with pack demands and physical weights, invoice summary counts match distinct invoice numbers. Retry1358S05 lines adds0cases; changed confirmed quantity refused; after customer deactivation the original lines remain duplicates with an explicit inactive note. S04 multi-sheet selection refuses both order sheets. These last two checks call the actual helpers, not HTTP. Missing S05 master data remains visible:1unknown SKU weight and3missing branch locations. The single S02overweight carton remains4800kg rather than being falsely capped.

## Published full-solver measurements (documentation, not reproduced here)

| Published run | Reported result | Source |
|---|---|---|
| PR5 release benchmark,300stops,1run | All3options serve300. RECOMMENDED12trucks/24loads/1806.5km/965.2OMR; alternatives12/24/1738.9km/947.1OMR;251s whole request | OPTIMIZER_BENCHMARK.md349–372 |
| Earlier post-solve study,10instances ×3options ×2runs |60returned plans,0evaluator/exact-turnaround violations,all reconciled;31–57s for60–150stops,252–253s for300 | OPTIMIZER_BENCHMARK.md239–286 |
| Earlier20random timing stress days |0/60options violated loading time after fixes;176unserved stops across20RECOMMENDED plans;9–19s with2s in-process searches | OPTIMIZER_BENCHMARK.md313–328 |
| PR5 re-plan study,16days |No unserved in either version; mixed quality: one late-order day+24OMR, half-fleet shape overall0.6%cheaper | OPTIMIZER_BENCHMARK.md374–409 |

The300stop benchmark uses Haversine,12synthetic trucks, and NO kg dimension because stops have no weight(OPTIMIZER_BENCHMARK.md90–100; tests/test_dispatch.py1038–1056). It proves less than the weighted S01–S05days and does not establish road timing accuracy.

## Published S01–S05 results and final-head gaps
The repository does not include a complete five-day results table or raw request/response artifacts for these runs. Do not invent missing served/cost/runtime figures.

| Sample | Concrete published observation | Final-head gap |
|---|---|---|
| S01 | Invoices320formerlydisplayedas200deliveryorders; tests retain earlier cost/preferred-window figures. S01/S02 ran197–200stops on20s before PR7. | Historical figures cannot measure new144–150ssearch. Repeat explicitly pending. |
| S02 | Overweight carton still only discovered at optimization (documented limitation); same197–200stop older schedule context. | No complete per-option outcome published. |
| S03 | Weight-bound day99.8%fullbykg;4095case capacity shortage vs4206casesunserved.240stop distances varied317.7–377.3km across runs, same150ssearchlimit. | Repeat/longer-search comparison still explicitly pending; no final-head stability proof. |
| S04 |1082morning+116lateSKUrows exposed silent second-sheet loss. Targeted re-plan used7physicaltrucks while showing6. Before PR8 a09:00re-plan had5/10newloads leave before09:00 and5/6lateclinics served before orders existed. | Timing policy changed in PR8; old outcomes no longer valid acceptance answers. Re-run with clock and loading-from fields. |
| S05 | P1average06:54underRECOMMENDED vs~09:47alternatives in historical main; retry-after-deactivation behaviorfixed.338solverstops retain150ssearchlimit. | No complete current-head run artifacts; validate repaired masterdata state and final clock policy. |

Source: PROJECT_HANDBOOK.md2603–2618(PR6),2620–2635(PR7),2639–2654(PR8),2704–2705(open decisions). Five-day web testing is explicitly historical mainPR1–PR3 at2603, and re-test main+PR4+PR5 at2620.2635explicitly leaves repeatsS01/S03/S04c open. The benchmark document ends withPR5§9, not finalPR8measurements.

The full tracked488-file source tree contains no S01–S05 request/response JSON/ZIP or complete resultreport; only focused regression tests reference their findings. The real-data harness is private `.dev/bench`, intentionally untracked(handbook1724,1776; .gitignore). No private files were accessed/copied. CI runs genericunit/integration suites but not `bench_dispatch.py300` or the five full scenario pack; see ci.yml104–105,133–135. `scenario-findings.spec.ts12` explicitly says no solver calls and seeds planrows;78–90 uses2+1rows to pin sheetrefusal. This is a valid regression test, not a300invoiceperformance test.

## Confirmed remaining defect: XLSX parsing timeout is ineffective
Severity: medium; authenticated upload availability risk, pre-existing.
Location: apps/web/lib/csv.ts82–86,148–158,183–195.
`Promise.resolve(parseExcelSheets(arr))` executes synchronous `XLSX.read` and sheet conversion BEFORE `withTimeout` registers its timer. A long parse blocks the web eventloop, and the already-completed promise wins once timer is registered. Rowlimits are checked after allsheet materialization; a10MB compressedfilebound alone is not an expanded-size/CPUbound. This is a concrete broken guard; no claim that a specific real maliciousfile was exploited.
Bounded controlled probe: actualparseUpload and helper source, mockparser40ms, timer delay scaled10000→10ms throughhook; parsed1row successfully in41.1ms and timerwasnotarmedwhenreadbegan. See current_source_checks.json, xlsx_watchdog_order. No realzipbomb and no production.
Pre-existed at577db7, csv.ts39–42; PR6 adds conversion of every sheet but did not create the timerpattern.
Proposed fix: parse in disposableworker/process, enforce wall-clocktermination and expanded workbook/entry/celllimits before materialization. Merely deferring synchronousparser to aPromise does not make timerpreemption work.

## Recommended acceptance evidence
Rerun allfive original fixtures on exact finalcommit with realwebintake, repairs, lock/dispatch/replan workflow, and independently evaluated solveroutputs;3repeats plus one largersearchcomparison onS03. Record inputhash, timestamp/timezone, effective settings, OSRM/Haversineprovenance, workers/memory/CPU, peroptionruntime, servedcases/invoices/priorities, unservedreasons, trucks/loads/km/cost, exactcapacity/windows/loading/shift/frozen/reconciliation violations. Archive sanitizedsyntheticrequest/response/checkeroutput asCIartifact. Reconcile changes toS04expectedanswers becausePR8 nowcorrectly forbidsretroactive departures.
