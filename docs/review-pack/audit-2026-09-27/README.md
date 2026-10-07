**RouteIQ deep-audit evidence — 27 September 2026**

Source commit: `83d8174836deb339d54f90e65b803550ed34c20d`.

Read the comprehensive report first. The JSON register contains the 26 new actionable items. Earlier issues and documented policy decisions are excluded from that count. Each lane's report provides additional source references and scope limits.

**Evidence levels**

- Actual-function probes execute unchanged application logic with synthetic framework/database/network boundaries.
- Component probes execute unchanged callbacks with controlled state and promises; they do not mount a browser.
- Concurrency/fault probes specify valid interleavings. They do not measure PostgreSQL isolation or production incident frequency. Foreign-key effects are explicitly modeled where stated.
- Solver probes execute pure functions, exact extracted constraints and control flow. OR-Tools, CP-SAT, PyVRP and GLOP searches were not executed in this pass.
- Source/configuration findings are explicitly identified. The dependency finding matches installed versions against primary advisories; no exploitation occurred.
- Remote CI excerpts are from the reviewed commit's inspected GitHub run, not a local full-suite rerun.

**Contents**

| Directory/file | Purpose |
|---|---|
| auth | Reset/admin races, tenant context, driver-delete race, dashboard precision and API boundary inventory |
| intake | Invoice merging, depot ownership, verified-pin import, coordinate parser, split/reconciliation checks |
| lifecycle | Recovery, legacy lock enforcement, deactivation policy and mixed-scenario reads |
| solver | Weight encoding, watchdog/fallback/cache checks and option feasibility comparisons |
| ui | Form, location, refresh, export and master-edit state behavior |
| infra | Readiness probe, dependency sources, configuration/schema coverage |
| prior-evidence | Earlier same-head reports/probes, retained to substantiate carried-forward items |
| source_inventory.json | All 488 tracked repository blob hashes and file classifications |
| coverage_register.json | File inventory linked to documented review lanes; mentions/static inspection are not runtime coverage |
| ci_evidence.json | Selected same-head remote CI log evidence |

**Reproduction**

Obtain the repository at the exact commit and place it alongside the audit folder as `routeiq-20260927`. Use Node 24 with TypeScript stripping for the `.mjs` probes and Python 3 with the imports identified by the individual solver script. Some probes use repository test fixtures, source extraction and import hooks instead of installed web/solver dependencies. Inspect each script's source-root/output path before running it: several record the original review workspace, and should be pointed at the equivalent local checkout. The source tree itself is not bundled here.

Run Node probes with `node path/to/probe.mjs`, from the working directory indicated by the script/report. Run the solver probe with `python path/to/deep_solver_checks.py`. Outputs record the specific limitations. A probe passing generally confirms the currently existing defect; these are review demonstrations, not already-fixed regression tests.

After implementing fixes, convert the scenarios into the project's normal test suites, especially real database concurrency tests and mounted component/browser tests. Run the handbook's normal CI commands in a fully provisioned disposable environment. Never point these synthetic probes or future destructive concurrency tests at production.

The evidence contains synthetic fixtures and read-only source observations. No production records, live credentials, full dependency trees or repository checkout are included.
