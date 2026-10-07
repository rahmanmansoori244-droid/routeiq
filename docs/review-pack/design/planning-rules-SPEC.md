# Planning rules PR: driver break, unloading finished by closing, full stop time per split visit

Build spec, 29 Sep 2026. Design only: nothing in any repo was changed to write it.

- **Base.** Production is `main` at 3451f4d. This PR is built after two branches: P6 (`audit-p6-solver-accuracy`, `C:/Users/abdulr/routeiq-wt-p6` at b8e6656) and P10 (`opt-long-search`, `C:/Users/abdulr/routeiq-wt-p10` at ff440ee plus uncommitted edits). Both rewrite the same solver and web files.
- **Line numbers.** They are given as `main` / `p6` / `p10` where they differ. They will drift after the merges, so every change is also named by its function.
- **Evidence.** The scratch experiments behind the numbers are in `C:/Users/abdulr/routeiq/.dev/design-planning-rules/` (git-ignored). Appendix B lists them.

## 0. What the owner decided (29 Sep 2026)

1. **Driver break.** A truck-day that works through midday gets one 60-minute break.
   - It starts between 12:00 and 14:00, company time.
   - It is taken wherever the truck is: between stops, or at the depot (for example during a reload).
   - It is never taken during unloading. The optimizer chooses the moment.
   - It counts inside the shift limit, so an 11 h day includes it.
   - A truck whose day ends before the break window needs no break.
2. **Receiving windows.** Closing time means unloading is finished: arrival + stop time <= closing. Today the rule is only that unloading must start before closing.
3. **Split deliveries.** Every visit of a split order gets the customer's full fixed stop time. Today the fixed time is shared in proportion to cases: a 35-min stop split 900/200 gets 29 + 6 min.

These existing rules stay as they are:
- Frozen, locked and dispatched loads never change.
- Same-day plans start from now.
- RECOMMENDED puts priority first.
- Locations are exact.
- Every order has a depot.
- The Quick and Thorough search modes stay.

The owner's message on 29 Sep also said:
- "add rule 22 to the long search PR". Appendix A covers this.
- "the only one will use this app is dispatcher". Every text in this PR is written for the dispatcher. The driver learns about the break only from the driver sheet and the WhatsApp message the dispatcher sends.
- "when the truck leaves last question unloading finished". This confirms decision 2.

Appendix C lists the owner's other answers (holds, driver names). They belong to other PRs.

## 1. Where it lands, and in what order

| Step | What | Where |
|---|---|---|
| 1 | P6 merges into `main` | its own PR |
| 2 | Rule 22 (the planner stops instead of freezing when it cannot start its worker processes) | **inside the long-search PR (P10)**, as the owner asked. Appendix A |
| 3 | P10 merges (rebased on P6) | its own PR |
| 4 | **This PR**, built from the P10 head with P6 in it | stacked PR on `opt-long-search`, or more commits in it (owner question Q1) |

**Why it builds on P6 and P10:**
- P6 rewrites `load_repack.time_truck` (the E4 overtime bound), the repack phase limits and the weight units. This PR changes the same functions.
- P10 rewrites `_run_scenarios`, `_post_solve(repack_cap)`, the Thorough tail and same-day timing. The extra break timing has to fit inside P10's budgets.

The owner's message can be read as asking for the break inside the long-search PR too. The design is the same either way; only the review and benchmark scope differ (Q1). The recommendation is a stacked PR, because the break changes plans on every day that crosses midday. That would invalidate P10's before/after benchmark, which measures only search modes.

**Optional split into two PRs.** Decisions 2 and 3 can ship first, in about 5 days (§11, phase A). The break then follows as phase B.

## 2. The rules, precisely

All times are minutes from midnight of the delivery day, company local time (Asia/Muscat). The solver has no time zone: `dispatch_models.py:1-4`.

### 2.1 Driver break

The settings are `L` = break length (60 min) and `[from, to]` = the allowed start (12:00 to 14:00, sent as 720 and 840).

- **A break is a gap of at least L minutes in the truck-day.** It starts inside `[from, to]` and holds no unloading. It may be spent:
  - driving part of a leg and stopping, or waiting at a customer before its receiving hours open (the waiting overlaps the break)
  - at the depot between two loads, overlapping the reload and loading ("e.g. during a reload"): the warehouse loads while the driver rests
  - at the depot before a truck's first new load, when the truck already did locked or dispatched loads that day
- **It counts inside the day.** The shift maximum is measured from the first departure to the last return, and the break is inside that span. So the SHIFT_LIMIT rule is unchanged.
- **It is paid**, as today's driver pay (the whole truck day, `costing.py` TRUCK_DAY_SPAN). Owner question Q3.
- **When is a break due?** The solver's rule is that a truck-day needs a planned break unless one of these holds:
  1. it is back at the depot for the last time by `to` (14:00): the driver takes the break after the last trip, and the plan shows none
  2. it has no locked or dispatched loads and leaves for the first time at `from + L` (13:00) or later: the break falls before the day
  3. a locked or dispatched load of that day already holds its break (§6)
  4. the locked or dispatched loads leave no room for it (§6: NOT_POSSIBLE, a warning and never a block)

  Rule 1 is one reading of "a truck whose day ends before the break window needs no break". The stricter reading gives every day still working at 12:00 a break. That is owner question Q2, and it costs about 0.5 day more (§5.5).

These examples come from the engine's real final plans (break_lp.py). They are truck-days of the real 26-Sep day and one synthetic day:

| Truck-day without the break | With the break |
|---|---|
| 06:00-12:12, 3 loads | none: back for good by 14:00 |
| 06:00-14:17, 3 loads, back at 12:00 between loads | at the depot 12:00-13:00 during the 30-min reload; the next load leaves 30 min later; the day ends 14:51 (+30) |
| 07:08-14:59, one long load | on the road after a stop, 12:06-13:06; the day ends 15:59 (+60) |
| locked yesterday, 09:00-15:10, no break recorded | NOT_POSSIBLE: a warning only |
| a locked load that holds its planned break | nothing new is planned |

### 2.2 Unloading finished by closing (hard windows)

- A stop with receiving hours `[hs, he]` and stop time `svc` must start unloading at or after `hs` and finish at or before `he`. The latest start is therefore `he - svc`.
- The web keeps sending the **true closing time** as `hard_end_min`. Only the solver subtracts the stop time.
- If the web shrank the closing time itself, the snapshot would store a wrong closing time. A stop with `end < start` would also make the whole request fail validation with a 422 (`dispatch_models` `_windows_ordered`).
- A stop whose unloading is longer than its window can never be served. The solver's prefilter drops it with a clear reason (§5.2). The prefilter must do this: an empty cumul range (`lo > hi`) raises "CP Solver fail" when the model is built and aborts the whole scenario (empty_window.py).

### 2.3 Preferred (soft) windows

They take the same meaning: **preferred end = unloading finished by then**.
- Each minute that unloading finishes after the preferred end costs the preferred-window penalty.
- Each minute that unloading starts before the preferred start costs the same.
- OR-Tools keeps one soft upper bound per cumul, and the early-arrival push for P1 and P2 shares it. That push is therefore counted from `pref_end - svc`, a slightly stronger push for those stops. When `svc` is longer than the preferred window, the penalty cannot be avoided: it stays soft and adds no warning.

### 2.4 Split deliveries

- Each part gets the customer's full base stop time plus the per-case time of **its own** cases, capped at 480 min as today.
- An explicit 0-minute base gives 0 on every part: the 5-minute minimum per part goes away.
- This is web-only. The solver already reads each stop's own `service_min` everywhere.
- **Two parts on one load.** Parts of one customer can share one load only when they were sized for a truck at most half the size of another truck. `choosePartCapacity` (`split.ts` ~146-190) picks such a size only when the biggest trucks lack trips; on the real NMWC fleet, parts are sized for the largest class. In that rare case, the timetable counts the fixed time twice for that load. That is safe (never late), just pessimistic.

  Forbidding two parts on one load (a routing dimension per split group) was rejected. It bites exactly when trips are short and would drop parts. Merging the two fixed times needs a pairwise stop-time rule in five places and is left out. The plan screen shows a note for such a load (§8).

## 3. Data: company settings and migration

**Migration** `apps/web/prisma/migrations/2026100NNNNNNN_planning_rules_break`. It must sort after P10's `20261001090000_run_job_search_mode_heartbeat`.

```sql
ALTER TABLE "TenantConfig"
  ADD COLUMN "driverBreakMinutes" INTEGER NOT NULL DEFAULT 60,   -- 0 = no break is planned
  ADD COLUMN "driverBreakFromMin" INTEGER NOT NULL DEFAULT 720,  -- earliest break start 12:00
  ADD COLUMN "driverBreakToMin"   INTEGER NOT NULL DEFAULT 840;  -- latest break start 14:00
ALTER TABLE "PlanLoad" ADD COLUMN "breakJson" JSONB;             -- the planned break of this load, or NULL
```

- **The default is 60, not 0.** NMWC then gets the owner rule on deploy, with no manual step. The cost is that test fixtures whose day crosses midday need a review (§9). Any other tenant can set 0.
- **The window rule and the split rule are not settings.** They are owner rules for the product. The web always asks the solver for FINISH, and always computes full split stop times. The solver still supports both window rules, so older plans stay checkable.
- **`PlanLoad.breakJson`** holds `{ v: 1, startMin, endMin, lengthMin, where: 'DEPOT' | 'ROAD', afterSequence: number | null }`. It is written in `applyScenario` (plan-service.ts main ~1042-1070). `createNextVersion` copies it with every other column through `copyRowData` (`prisma-copy.ts:28-41`), so frozen loads keep their break across versions.

The break is stored on the load, not on RouteAssignment, because a depot break has no stop.

**Settings plumbing.** None of these files changes in P6 or P10, except `schemas.ts` and `schema.prisma` in P10.
- `schema.prisma` TenantConfig, next to the shift columns (:229-237).
- `tenantConfigSchema` (`schemas.ts:219-244`): length 0-180, from and to 0-1439, with a refine that from <= to (like `overtimeProblem`).
- `settings-fields.ts` SETTINGS_FIELDS (:8-28).
- `packages/shared-types/src/planner-bounds.json` config entries `break_min` (0-180), `break_start_from_min` and `break_start_to_min` (0-1440), and the web copy `lib/planner-bounds.ts`. `apps/solver/tests/test_dispatch.py:1177-1224` checks that every bound matches a solver field.
- `planner-config.ts`:
  - TenantPlannerConfig
  - SETTING_LABELS
  - `plannerSettingProblems`: warn when the break length is at least the shift maximum, and when from is after to
  - `dispatchConfigFromTenant` (:152-185): send `break_min`, `break_start_from_min`, `break_start_to_min` and `window_rule: 'FINISH'`
  - `effectivePlannerValues`: a "Driver break" row, and the "Driver shift maximum" note gets "the break is included"
- **Settings card** "Daily dispatch: timing" (`settings-form.tsx:187-230`) gets three inputs, "Driver break (min)", "Break may start from" and "... until", with this hint:

  > One break per truck-day that works through midday, taken between stops or at the depot (it may overlap reloading), never while unloading. It is inside the shift maximum. 0 = no break.

  The shift hint at :197 adds "including the driver break".

## 4. Contract (solver request and response) and deploys

Every change is **additive**, and absent always means the earlier rule. The solver ignores fields it does not know (`dispatch_models.py` has no `extra='forbid'`). The web does not validate the response strictly (`solver-client.ts:105` is a plain `JSON.parse`).

### 4.1 Request (`dispatch_models.py` and `packages/shared-types/src/dispatch.ts`, field for field)

```python
class DispatchConfig:
    # Receiving windows: "START" = unloading starts by closing (earlier rule, the default when absent);
    # "FINISH" = unloading finished by closing; the preferred end then means "finished by" too.
    window_rule: Literal["START", "FINISH"] = "START"
    # Driver break (owner rule 29 Sep 2026). 0 = none (the default: an older web sends nothing).
    break_min: int = Field(default=0, ge=0, le=180)
    break_start_from_min: int = Field(default=720, ge=0, le=DAY_MIN)
    break_start_to_min: int = Field(default=840, ge=0, le=DAY_MIN)
    # validator: break_start_from_min <= break_start_to_min; break_min < shift_max_min

class FrozenTrip:
    # The break planned inside this locked / loading / dispatched load (on the road, or at the depot
    # before it left). None = none recorded (made before the rule, or the break was elsewhere).
    break_start_min: int | None = Field(default=None, ge=0, le=DAY_MIN * 2)
    break_min: int | None = Field(default=None, ge=0, le=180)
```

The web builds `FrozenTrip.break_*` from the frozen load's `breakJson` (plan-service.ts main :583-588 / p6 :591 / p10 :639).

`DispatchStop` does not change (§2.4).

### 4.2 Response

```python
class PlannedBreak(BaseModel):
    start_min: int
    end_min: int
    where: Literal["DEPOT", "ROAD"]  # DEPOT: at the depot before this load leaves (may overlap its loading)
    after_sequence: int | None = None  # ROAD: last stop unloaded before it (0 = on the way to stop 1;
                                       # = number of stops: on the way back). DEPOT: None

class PlannedLoad:
    driver_break: PlannedBreak | None = None

class TruckDayCostOut:
    # None: no break rule (older solver, or break_min 0).
    break_status: Literal["PLANNED", "NOT_NEEDED", "IN_FROZEN_LOAD", "NOT_POSSIBLE"] | None = None
    break_start_min: int | None = None  # PLANNED or IN_FROZEN_LOAD

class DispatchScenario:
    # Rules this plan was actually made with (echo, like P6's weight_unit_kg / new_overtime_only).
    window_rule: Literal["START", "FINISH"] | None = None  # None = a solver before it (START)
    break_rule: BreakRule | None = None  # {length_min, start_from_min, start_to_min}; None = no break planned

FeasibilityCode += "BREAK"
```

**`PlannedStop` semantics** (no new field):
- For the stop right after a ROAD break, `arrival_min` includes the break when the break started before the truck would have arrived.
- `wait_min` never includes break minutes.
- `duration_min` of a load includes a road break.

`UnservedReason` gains no code. The prefilter reuses `HARD_WINDOW_INFEASIBLE` and `SHIFT_LIMIT` with new messages (§5.2, §5.4).

### 4.3 Old and new side by side during a deploy

| | old solver | new solver |
|---|---|---|
| **old web** | today | The web sends no new fields, so the solver uses START, no break and the web's own split minutes: identical to today. The echo fields are ignored. |
| **new web** | The solver ignores `window_rule` and `break_*`, plans the earlier way and sends no echo. The web stores the earlier rules on each load (absent echo), checks and prints them as earlier rules, and shows the note "made by a planner without the driver break / finish-by-closing rule: re-plan in a few minutes". | full |

- **Deploy order:** solver first (Railway), then the web and the migration. Rolling back either side lands in one of the safe cells above.
- **Rule for the web:** the rules a load was planned with come **only from the echo**, never from what the web asked for. Otherwise a mixed deploy would label plans "break included" that were planned without one.

## 5. Solver

### 5.1 TruckDay: the break state of each truck-day

In `_truck_days` (main :237-266 / p6 :251+ / p10 :542+), TruckDay gains:
- `break_s`
- `break_lo_s`
- `break_hi_s`
- `break_state` in {`OFF`, `DUE`, `IN_FROZEN_LOAD`, `NOT_POSSIBLE`}

The state is set as follows:
- `break_min == 0`: `OFF`.
- A frozen trip carries `break_start_min`: `IN_FROZEN_LOAD`.
- Two consecutive frozen trips leave a depot gap that holds the break (`B = max(from, return_k) <= to` and `B + L <= depart_{k+1}`): `IN_FROZEN_LOAD`, "at the depot between locked loads". This covers loads locked before the rule.
- Otherwise:
  - `lo = max(from, last frozen return)` and `hi = to`.
  - If `lo > hi`, the frozen loads ran past 14:00 with no break: `NOT_POSSIBLE`. The warning is "T07: its locked or dispatched loads run 09:00-15:10 with no driver break (planned before the break rule)".
  - Else `DUE`.

There is no `now` term. For a same-day plan, new loads leave after `now` anyway (§6). A depot gap before the first new load, after a locked load, counts even when it is partly in the past: the truck stood at the depot then.

Add `break_lo_s`, `break_hi_s` and `break_state` to the `_identical_trucks` key (load_repack p6 :758). Symmetry breaking is otherwise invalid.

### 5.2 Unloading finished by closing (window_rule FINISH)

One helper sets the latest start, used by every place below: `latest_start_s(s) = he_s - svc_s` under FINISH, else `he_s`. A missing `he` means the end of the horizon.

| Place | Change |
|---|---|
| Routing, `_solve_scenario` (main :731 / p6 :822 / p10 :1036) | `CumulVar(stop).SetRange(hs, min(latest_start, HORIZON_S))`. The prefilter guarantees `hs <= latest_start`, and an assert makes that explicit. |
| Routing soft bounds (p10 :1038-1043) | Soft upper bound at `pref_end - svc` (coefficient pref + early, as today); the soft lower bound stays at `pref_start`. |
| `_window_prefilter` (main :404-451 / p6 :490+ / p10 :709+) | 1. New first test: `svc > he - hs` drops the stop as `HARD_WINDOW_INFEASIBLE`, "Unloading takes 90 min, but the receiving hours 06:00-07:00 are only 60 min long: it can never finish before closing." 2. The reachability test becomes `start > latest_start`, with "... early enough to finish unloading (35 min) by closing (11:00): earliest arrival 10:40". |
| `load_repack` (p6 lines) | `_he` (:196) becomes `_latest_start(s, rule)`, used by `facts().hi` (:226-240), the time_truck `t` upper bound (:341) and `timing_ok` (:427). `depart_range`, the CP-SAT ranges and the fit fallback follow automatically. `_soft_cost` (:288) and `_soft_terms` (:400) move their bound to `pref_end - svc`. They also drive the CP-SAT hinges and `_build_scenario`'s window cost, so the reported penalties equal the optimised ones. |
| `_build_scenario` (main :904-934 / p6 :1031 / p10 :1240) | `hard_window_ok = hs <= start and start + svc <= he`, and `pref_ok = start >= ps and start + svc <= pe`. The window cost is minutes before `ps` plus minutes after `pe - svc`. The early "after" bound becomes `pe - svc`. |
| `feasibility.check_scenario` (p6 :197-205) | Under `req.config.window_rule == "FINISH"`, HARD_WINDOW becomes `service_start >= hs and departure_min <= he + TOL_MIN`, with the message "T03 load 2: Customer X finishes unloading at 11:33, after its receiving hours end (11:00)". `CHECK_VERSION = 2`. |
| Echo | `DispatchScenario.window_rule` is set on every scenario, `_empty_scenario` included. |
| Docstrings that say START | dispatch_solver :21-23, load_repack :37-41, feasibility :13. |

The one-rule helper lives in `load_repack.py`. `dispatch_solver.py` imports it, so the search, the LP, the repack and the output cannot drift apart. `feasibility.py` re-derives the rule on purpose (it is the independent check).

### 5.3 Split deliveries

Nothing changes in the solver. The benchmark and the tests use the web's minutes (§9, §10).

### 5.4 Break: route search and prefilter

**The search stays break-free.** Putting OR-Tools breaks (`SetBreakIntervalsOfVehicle`) into the search found 3-9x fewer solutions at Quick limits and never reached a local optimum. Its raw cost was 2-33% higher, with up to 2 more trucks (seq_bench.txt). Inserting the break exactly after the search fitted every truck-day of the engine's final plans on three harness days (§5.5).

**Search-only margin.** For a `DUE` truck whose hours can cross the window (`earliest_depart < from + L` and `latest_return > to`):
- Without frozen loads: `SetSpanUpperBoundForVehicle(shift_s - break_s)` (main :758 / p6 :850 / p10 :1064).
- With frozen loads: the end cumul and its reload cumuls get `min(latest_return_s, anchor + shift - break_s)`. Depot closing and truck availability are not reduced.

The exact stages use the true shift. This mirrors how the search already estimates the reload (80% of a full truck) and leaves exact timing to the post-solve stage. With the shift 60 min shorter, the three harness days planned the same (lp_*_60.txt).

**Prefilter** (`_window_prefilter`, shift test). The round trip `[depart, finish]` alone may not be able to avoid the window (`depart < from + L` and `finish > to`) on a `DUE` truck. Then it needs `finish + L <= shift limit`. Otherwise the stop is dropped as `SHIFT_LIMIT`, "A round trip to this customer does not fit inside the shift once the 60-min driver break is included". This is a sound proof: a single trip that covers the window must contain the break.

**Not in this PR:** breaks inside the search for Thorough only. It was not measured at Thorough lengths, so it is left as a later experiment behind a flag. §5.9 has its recipe.

### 5.5 Break: exact LP timing (`load_repack.time_truck` / `time_plan`), the reference

The timetable of every returned plan comes from `time_plan`. So the break is placed here, exactly, for every candidate plan and every scenario.

**Notation.** Truck `td`; loads `j = 0..n-1` with stops `1..m_j`; departure `D_j`, service start `t_{j,i}`, stop time `s_{j,i}`, return `R_j`; `T(leg)` = drive seconds. Break start `B` is in `[lo, hi]` (`td.break_lo_s`, `td.break_hi_s`) and lasts `L`.

**Positions.** For a `DUE` truck, solve today's LP (P6 version, with the §5.2 latest start) once per position below, each with the break constraints added:

| Position | Constraints added | Result |
|---|---|---|
| `NONE_AFTER` | `B >= R_{n-1}` (the day ends by `to`) | NOT_NEEDED |
| `NONE_BEFORE` (no frozen loads only) | `D_0 >= B + L` (the day starts at `from + L` or later) | NOT_NEEDED |
| `DEPOT(0)` (frozen loads only) | `D_0 >= B + L`; `lo` already includes the last frozen return | DEPOT on load 0 |
| `DEPOT(j)`, j = 1..n-1 | `B >= R_{j-1}`, `D_j >= B + L`; the turnaround `D_j - R_{j-1} >= gap` stays, so they overlap | DEPOT on load j |
| `ROAD(j,i)`, i = 0..m_j | `a` = `D_j` (i = 0) or `t_{j,i} + s_{j,i}`; `b` = `t_{j,i+1}` (i < m_j) or `R_j`; `B >= a`, `B + L <= b`, and the leg's time constraint gains `+L`. Leg 0: `t_{j,1} = D_j + T + L`. Middle legs: `t_{j,i+1} >= t_{j,i} + s + T + L`. The return leg: `R_j = t_{j,m} + s + T + L`. | ROAD on load j, `after_sequence = i` |

- The break never overlaps unloading, because every position lies between two unloadings.
- It may overlap waiting at a customer: middle legs allow `b - a > T + L`.
- It may be split across the drive (drive, stop, drive): `B` can be anywhere in `[a, b - L]`.
- The first leg and the return leg are needed positions. A single long load that is out all through midday has no other place for its break. The scratch LP left them out; the build must include them.

**Selection.** Add `EPS_B = 1e-7` objective units per second on `B`, so each LP returns the earliest break start (lunch at 12:00 when free). Then take the lowest objective, compared in whole units. Ties go to `NONE_*`, then `DEPOT`, then `ROAD`, then the earlier `B`. None feasible means `time_truck` returns None, and the candidate is discarded as today.

**Strict reading (Q2), if the owner chooses it.** `NONE_AFTER` is then allowed only when `R_{n-1} <= from`. A new position `DEPOT_END` gives `B >= R_{n-1}`, and the shift span and pay run to `B + L`. That is one more LP position and a span term, about 0.5 day.

**Exactness.** All constraints stay difference constraints with integer data. Rounding the GLOP optimum keeps the result feasible, and `timing_ok` checks it again in integer seconds.

**`timing_ok` (p6 :412)** gains a break check:
- `B` is in `[lo, hi]`.
- For the declared position, the gap holds `L`, and on a road leg `b - a >= T + L`.
- No `[t, t + s)` of the truck overlaps `[B, B + L)`.
- A `DUE` truck with no declared break must satisfy one of the `NONE_*` conditions.

**Data.** `TimedLoad` (p6 :78) gains `brk: BreakAt | None = None`, with `BreakAt(start_s, where, after)`. The default keeps every existing constructor valid. `plan_signature` does not change.

**Speed.** Measured at 1-2 ms per LP: real80's final plan needed 90 LPs in 154 ms, syn150_s1's 158 LPs in 169 ms. Two measures are required:
- a per-`(td.idx, loads)` cache for each `Day` and pricing inside `time_plan`, because repacks move few loads and most trucks repeat across candidates
- positions with no break (`NONE_*`) solved first; they end the search when `B` has no effect

Pruning with sound ASAP/ALAP bounds is optional. Skip a position whose latest possible `b` is before `lo + L`, or whose earliest possible `a` is after `hi`. Build it only if the harness shows more than 300 ms per plan.

### 5.6 Break: the CP-SAT repack (`load_repack.repack`, p6 :521-715)

**Why it is needed.** The repack is what turns 13 trucks into 5-7 on the real day. If it stays unaware of the break, it builds consolidations that the LP must discard. A long single load that crosses midday could also go on no truck. Its answer is still only a proposal: the LP (§5.5) remains the final judge.

For every `DUE` truck `td`:

1. **Depot break interval.** Add an optional `b_td` in `[lo, hi]` with interval `[b_td, b_td + L)` and presence `db_td`.
2. **Second NoOverlap.** It holds the road intervals `[e_j, e_j + occ_j)` of the loads (and variants) that can go on `td`, plus the depot break interval. The existing NoOverlap over `[e_j - gap_j, e_j + occ_j)` stays, so the break can overlap a turnaround, or sit before the day or after it.
3. **Road-break variants of pool loads.** `facts(day, load, pause_after=i)` inserts `L` seconds of pause after stop `i` (i = 0: after leaving the depot). Offsets, `d`, `lo`, `hi` and `occ` then follow as in `facts()`. The break start offset range is `[p_i, p_i + T(leg i)]`, with `p_i` the departure offset from stop `i` (0 for i = 0). The variant covers the same stops as its load, so the existing ExactlyOne or AtMostOne covering picks the load or one of its variants. For `x[v, td]`: `e_v + p_i <= hi_td` and `e_v + p_i + T >= lo_td`. Variants get `x` variables only on `DUE` trucks.
4. **Exactly one break per used truck.** `db_td + Σ x[variants on td] == used_td`.
5. **Which variants to generate.** Every leg position whose break-start range can meet `[min lo, max hi]` on some `DUE` truck. If that makes more than 3x the pool, keep only loads that must cross the window: those that cannot be back by `max hi` and cannot leave at or after `min lo + L`. Log the counts; §10 measures them.
6. **Hint.** Time the hinted plan with §5.5 first. A DEPOT break is hinted as `db = 1, b = B`. A ROAD break at `(j, i)` is hinted as the variant `(j, i)` instead of load `j`. The hint then stays feasible whenever the LP could time the plan, and phase 2 can reproduce it.
7. **Output.** A variant maps back to its plain load, `plan[td] = [stops...]`. `time_plan` then places the break exactly.

The redundant `busy` bound and the span and overtime terms need no change: a variant's `occ` already includes `L`.

### 5.7 Output: `_build_scenario` (main :859-1102 / p6 :956+ / p10 :1165+)

- `PlannedLoad.driver_break` is built from `TimedLoad.brk`.
- **ROAD break after stop `i`:**
  - `a` = departure from stop `i` (or the depot); `arr0 = a + T`.
  - If `B < arr0`, the truck was still driving, and `arrival = arr0 + L`. Otherwise the truck arrived first and rested at the customer, and `arrival = arr0`.
  - `wait_min = start - arrival - overlap([B, B+L), [arrival, start])`.
  - For `i = m`, the return is `a + T + L`. The return is recomputed here today (`return_s = prev_dep + back`), so this is required.
- `TruckDayCostOut.break_status` and `break_start_min` come from `td.break_state` and the loads.
- A scenario warning is added per `NOT_POSSIBLE` truck.
- **Fit-fallback message** (main ~1319 / p6 :1113): "Not planned: once every load was timed with the loading time between loads **and the drivers' midday break**, ..." The code stays `SOLVER_DROPPED_LOW_PRIORITY`.
- `_timed_from_scenario` (p10 :1917) reads `driver_break` back into `TimedLoad.brk`. `_retime` and the safety net re-time with §5.5 anyway.
- **Raw search plan returned unchanged**, when the stage and the safety net both failed: it has no break, so the check reports it VIOLATED (BREAK) and the web blocks Lock. The added warning reads "the driver breaks could not be timed: re-plan".
- Every scenario is echoed with `break_rule`.

### 5.8 `feasibility.check_scenario`: the independent check

It re-derives everything from the request and the emitted minutes, per truck, when `req.config.break_min > 0`:

1. **Done or impossible.** It rebuilds the frozen state from `FrozenTrip`s (a recorded break, or a frozen depot gap that holds one), or `NOT_POSSIBLE` (last frozen return > `to`, nothing recorded). In either case, a new load that declares a break is a violation ("second break").
2. **Break needed.** It is needed unless the day ends by `to` (last return, frozen ones included), or the truck has no frozen loads and first leaves at `from + L` or later.
3. **Declared breaks.** More than one is a violation. None while one is needed gives "T01 works 06:00-15:40 through midday without the 60-min driver break (to start between 12:00 and 14:00)".
4. **Validity of a declared break,** with TOL_MIN:
   - the start is in `[from, to]`, and after the last frozen return
   - DEPOT: start >= the previous load's return (new or frozen), and start + L <= this load's departure
   - ROAD after `i`: start >= `a`, start + L <= `b`, and `b - a >= leg + L` when the matrix is known
   - each failure gets its own message
5. SHIFT_LIMIT, TURNAROUND, TRAVEL and RETURN do not change. A depot break only adds to the gap, and a road break only makes later times later.
6. `CHECK_VERSION = 2`, bumped once for this rule and the FINISH rule.

### 5.9 Where every rule is applied: all must agree

| Rule | Route search | Prefilter | CP-SAT repack | LP timing + `timing_ok` | `_build_scenario` | `check_scenario` | Web gate |
|---|---|---|---|---|---|---|---|
| Finish by closing | cumul max `he - svc` | new infeasible reason | `facts().hi` | `t <= he - svc` | `hard_window_ok` | `departure <= he` | `departureMin <= he` (FINISH loads) |
| Preferred end = finished | soft UB `pe - svc` | - | hinges via `_soft_terms` | `_soft_terms` | `pref_ok`, window cost | - | amber "Best" cell |
| Break | shift margin only | break-aware shift test | depot interval + variants | exact positions | emitted, arrival and wait | BREAK | BREAK (§7.3) |
| Split full time | - (stop's own `service_min`) | - | - | - | - | SERVICE_TIME | - |

**Break in the search later (not in this PR), if ever:**
- one `FixedDurationIntervalVar` per `DUE` vehicle, start in `[lo, hi]`
- `SetBreakIntervalsOfVehicle(breaks, v, visit)`, with `visit = service_s` for stops and 0 for reloads
- added before `_initial_assignment`'s `CloseModelWithParameters`
- for overlap with the turnaround, move the reload gap from transit into `SlackVar(reload).SetMin(gap)`

It was verified with warm starts, frozen trucks, same-day plans and unused vehicles (break_semantics.py, break_overlap.py, warm_check.py).

## 6. Frozen loads and same-day plans

| Situation | What happens |
|---|---|
| A locked, loading or dispatched load **holds its planned break** (breakJson, ROAD or DEPOT) | The web sends `FrozenTrip.break_start_min`. The truck-day is `IN_FROZEN_LOAD`, no break is planned for its new loads, and the break never changes. |
| Frozen loads **end before 14:00**, no break recorded | `DUE` with `lo = max(12:00, last frozen return)`. The break goes at the depot before the first new load (overlapping its loading), or into a new load. |
| Frozen loads **left a 60-min depot gap** starting 12:00-14:00 (locked before the rule) | `IN_FROZEN_LOAD` ("at the depot between locked loads"). Nothing new. |
| Frozen loads **run past 14:00** with no recorded break (made before the rule) | `NOT_POSSIBLE`. A warning on the plan and TRUCK DAYS: "no driver break: its loads were planned before the rule". It never blocks, and a re-plan cannot fix it (frozen loads never change). |
| The break was planned at the depot **before a load that is still PLANNED** | It belongs to that load, so a re-plan places it again. |
| **Unlock** of a load that held the break | The load goes back to planning with its break (breakJson is re-planned like its times). |
| **Same-day plan**, truck without loads today | `NONE_BEFORE` applies when it can leave at 13:00 or later: the driver's lunch is before the day, whatever `now` is. Otherwise the break goes inside the day. The measured side effect: at 11:40 the cheapest plan may wait until 13:00 to leave rather than break on the road. That is correct under the rule and visible as later ETAs. |
| **Same-day plan**, truck back at 12:10 from a locked load, plan made at 13:30 | A DEPOT break from 12:10 counts (the truck stood at the depot), and the new load leaves after its loading from 13:30. The plan screen shows the past break as "12:10-13:10 at the depot (already passed)". |
| Same-day plan **made after 14:00** | Only `IN_FROZEN_LOAD`, `NONE_*` or `NOT_POSSIBLE` apply. The same-day warning (plan-from.ts `planFromWarning`, main :106-120 / p10 :162) adds "trucks without a recorded break before this plan get none today". |
| P10 retiming (`retimeSameDay`) and the Thorough lead time | They move only `shift_start_min` and `loading_from_min`. The break window is clock time and never moves. |
| Finish by closing, on frozen loads | Frozen loads are not in the model. The web checks each one under the window rule it was planned with (§7.3). |

## 7. Web: request, storage, rules per load, gate

### 7.1 Request (`plan-service.ts buildDispatchRequest`)
- The config comes from `dispatchConfigFromTenant`: `window_rule: 'FINISH'` and `break_*`.
- `frozen_trips[].break_start_min` and `break_min` come from each frozen load's `breakJson`.
- **Split** (`service-time.ts`): `stopService(base, perCase, cases)` gives `share = base` for every part. Drop the `totalCases` parameter, `MIN_PART_SERVICE_MIN` (:15) and the header text (:7-9). The 480 cap and the `longStops` warning stay.
- The call at main :550-551 / p6 :558-559 / p10 :606-607 becomes `serviceOf(cases)`, with the comment "each visit gets the full stop time".

### 7.2 Storage and the rules each load was planned with
- **`applyScenario`** writes `PlanLoad.breakJson` from `driver_break` (NULL when none).
- **`PlanRules`** (`snapshots.ts:27-44`) gains optional fields, set by `rulesFrom` **only from the scenario echo**, with the conditional spread already used for `loadingFromMin`:

  ```ts
  windowRule?: 'FINISH';                                               // absent = START (earlier rule)
  break?: { lengthMin: number; startFromMin: number; startToMin: number }; // absent = no break rule
  ```

  `snapshotSource` (plan-service.ts main :1192-1278) passes the scenario's echo into `rulesFrom`. `inputHash` (`feasibility.ts:177-183`) appends them only when set, so every stored hash stays the same. `FEASIBILITY_VERSION` stays 1.
- **`PlanSettings`** (`snapshots.ts:76-111`, `planSettingsOf` plan-service.ts main :683-718) stores what was asked:
  - `splitStopTime: 'FULL'` (web-side, so it is recorded here; absent = the earlier shared rule)
  - `driverBreak` (as sent)
  - `windowRule: 'FINISH'`
- **Out-of-date notices:**
  - A plan whose asked rules are missing from the echo gets an `outdatedNotes` line (plan-detail.ts :793): "made by a planner without the driver break / finish-by-closing rule (deploy in progress): re-plan".
  - A day-overview count `rulesOutdated` (day-overview.ts :67-80, like P6's `depotMoved`) counts PLANNED loads made before the rules: "planned before the break and finish-by-closing rules: re-plan before Lock".
  - Both are notices, never a block. Deploy after the evening's plans are locked, or re-plan them once.

### 7.3 The web gate (`feasibility.ts`, unchanged in P6 and P10)
- `FeasLoad` gains `break: { startMin, endMin, where, afterSequence } | null`, read in `feasibilityInputFromRows` (plan-service.ts main :1548-1594). Add `breakJson` to `FEASIBILITY_LOAD_INCLUDE`.
- **HARD_WINDOW** (:266-278): when `l.rules?.windowRule === 'FINISH'`, a stop is outside if `start < hs` or `departureMin > he + TOL_MIN`. The message is "`<customer>` finishes unloading at 11:33, after its receiving hours end (11:00)". Otherwise it keeps today's start test and wording.
- **BREAK**: a truck-day check, like SHIFT_LIMIT at :356-367. It runs when the latest load's rules carry `break`:
  - **Satisfied** by any of these:
    - a valid recorded break: start in `[from, to]`; DEPOT after the previous load's return and before this load leaves; ROAD after stop `i`, after that stop's departure (or the load's) and ending by the next stop's service start (or the load's return)
    - a depot gap between two loads of at least L that starts in the window
    - no break needed (§2.1 rules 1 and 2)
  - **Otherwise a violation**, attached to the load that spans the end of the window:
    - on a load already on the road: WARN (history)
    - on a LOCKED or LOADING load: flagged `frozen`, with the unlock remedy
    - on loads whose own rules have no break (made before the rule): WARN, "planned before the break rule"
    - on a PLANNED load under the rule: BLOCK
- Leg minutes are not stored, so the web cannot re-check drive plus break inside a leg. The solver's check covers that, and the web mirrors the solver's violations as today.
- **TURNAROUND** and `loadedFromNow` (:294-333) do not change: the break overlaps loading.
- **SHIFT_LIMIT** keeps its rule; its message adds "(driver break included)".

## 8. What the dispatcher sees

The owner says only dispatchers use RouteIQ. The driver gets the break and the "unloading until" time through the driver sheet and the WhatsApp text the dispatcher sends.

**Plan screen** (`plan-view.tsx`, main line numbers):
- The load row (:841) reads `06:00 -> 15:10 · break 12:40`.
- LoadDetail (:1204-1314):
  - a **BREAK row** between stop `i` and stop `i+1` (ROAD), or just before the DEPOT depart row (DEPOT): "Break 12:40-13:40 · driver break, 60 min" or "Break 12:00-13:00 at the depot (during loading)"
  - the ETA cell (:1291-1294) shows "06:40 · until 07:15", where "until" is `departureMin`
  - `wait` excludes the break
- `DetailStop` gains `closeMin` (the planned closing time in minutes, from the snapshot). For a stop of an **earlier-rule** plan whose unloading runs past closing, an amber note says "unloading until 11:33, after closing 11:00: call ahead". It is display only.
- `DetailLoad` gains `break` from breakJson.
- The truck-day summary reads "Driver break: planned for 9 of 11 truck-days; 2 not needed (back by 14:00)". A NOT_POSSIBLE truck-day shows its warning.
- A load with two parts of one split customer shows "stop time counted for each part".

**Excel** (`workbook.ts`):
- **Route sheet:** a new "Unloading until" column right after "Service start" (ROUTE_HEADS :602-606 and ROUTE_WIDTHS). This shifts the columns pinned in `dispatch-workbook.spec.ts:133-147`; update them. There is a BREAK row in the route table, and Notes (:695-707) add "after closing" for earlier-rule stops.
- **Load sheet:** header row 10 (free; the manifest starts at the fixed row 11) reads "Driver break: 12:40-13:40 on the road after stop 3". The LOADING MANIFEST (:651) gains a line when the break is at the depot before this load: "The driver's break is 12:00-13:00 at the depot; loading continues meanwhile."
- **TRUCK DAYS** (:549-599) gets a "Driver break" column with the time and place, "not needed (back 13:14)", "in a locked load", or "none: loads planned before the rule".
- **ASSUMPTIONS** (`tenantAssumptions`, `AssumptionConfig` :934-963). Each rule is worded by the rule its plan was made with:
  - *Receiving hours:* "Unloading must be finished by the end of the receiving hours." Earlier rule: "unloading had to start by closing and could run past it".
  - *Preferred hours:* "soft: a penalty per minute that unloading finishes after the preferred end or starts before the preferred start".
  - *Driver break:* "60 min, starting between 12:00 and 14:00, between stops or at the depot (may overlap reloading and loading), never while unloading; inside the 11 h shift maximum; paid driver time. Truck-days back for good by 14:00, or leaving for the first time at 13:00 or later, have none." Earlier rule: "not planned".
  - *Split deliveries:* "each truck visit gets the customer's full stop time plus the per-case time of its own cases". Earlier rule: "the parts shared the stop time in proportion to cases".
- **`workbookNotes`** (main :118-128 / p6 :141 / p10 :119) takes the window rule and break rule as arguments, as it already takes P6's cost rules.
- "Hours on the road" (:375), "Estimated time" (:637) and "Total time" (:732) say "(driver break included)".

**PDF driver sheet** (`driver-pack.tsx`; P6 changes it, so rebase on it):
- The header reads "Depart 06:00 · Back ~15:10 · Break 12:40-13:40".
- A break row goes among the stop rows (:489-491): "Break 12:40-13:40, after stop 3".
- The StopRow time cell (:340-348) reads "ETA 06:40 · unload until 07:15".
- `hoursLines` (:125-128) reads "Receives 06:00-11:00 (finish unloading by 11:00)" and "Best 07:00-10:00".
- "Outside receiving hours - call ahead" (:347) becomes "Unloading runs past closing - call ahead".
- `returnText` (:211-213) names a depot break before the next trip.

**WhatsApp** (`driver-links.ts`; P6 changes it):
- `MessageLoad` gains `departureMin` and the break.
- The stop line (:148) becomes `3. 10:40-11:15 Customer · 120 cs`.
- A line `Break 12:40-13:40` goes in its place. A depot break before the trip reads `Break 12:00-13:00 at the depot before leaving`.

**Wording** (one sentence everywhere: "unloading must be finished by the end of the receiving hours"):
- `customer-dialog.tsx:139` (today "never outside") and :103
- `settings-form.tsx:248`, :352, :366
- `planner-config.ts:241`
- `help/page.tsx:39`
- the `schema.prisma:503` comment
- `docs/DISPATCHER_GUIDE.md:96`, :155, :232
- `docs/PROJECT_HANDBOOK.md:785`, :954, :1509, :3225
- `docs/OPTIMIZER_DESIGN.md:41`, :96

**Customer and day warnings.** A customer whose unloading is longer than its receiving window can never be served. `customerIssues` (customer-attrs.ts:275-288) and the day overview (`IssueCustomer`) warn about it before planning. `detailsPatch` (customer-details.ts:131-140) shows it as a non-blocking note.

## 9. Tests

**Solver (pytest).** Add a new `apps/solver/tests/test_planning_rules.py` and extend the existing suites.

*Finish by closing:*
- F1: window 06:00-11:00 with 35 min: FINISH starts by 10:25, `hard_window_ok`, VERIFIED. START (field absent) may still start at 11:00, as today.
- F2: unloading 90 min, window 60 min: `HARD_WINDOW_INFEASIBLE` with the new message. The rest of the day is planned, and there is no "CP Solver fail".
- F3: a preferred end with stop time: the penalty in `preference_penalties.window` equals `score()` and the LP objective term (one meaning in search, repack, LP and report).
- F4: `check_scenario` flags a finish after closing under FINISH only; `CHECK_VERSION == 2`.
- F5: `facts().hi`, `depart_range` and `timing_ok` use the latest start.
- F6: the echo: `window_rule` on every scenario, including empty and NO_SOLUTION ones.

*Break:*
- B1: one far single-stop load 06:00-15:00: ROAD break on the first or return leg, start in [12:00, 14:00], the day +60, VERIFIED. This pins the leg-0 and return-leg positions the scratch LP lacked.
- B2: a 3-load day: DEPOT break during a reload, adding `max(0, L - turnaround)`.
- B3: days ending 13:30, or first leaving at 13:00: NOT_NEEDED, and no `driver_break` emitted.
- B4: property test on random harness days: no break overlaps any `[service_start, departure]`; every `DUE` truck-day has exactly one break or a `NONE_*` condition; `timing_ok` holds.
- B5: waiting overlap: arrival 12:10, opening 13:00: break 12:10-13:10, `wait_min` 0.
- B6: frozen cases: a recorded break gives IN_FROZEN_LOAD and no new break; frozen until 12:40 gives a DEPOT break at 12:40 or later; frozen 09:00-15:10 gives NOT_POSSIBLE, a warning and no violation; a frozen depot gap 11:00-13:10 gives IN_FROZEN_LOAD.
- B7: same-day: `loading_from` 11:40 and no frozen loads, either leave at 13:00 or later with no break, or a break inside; a frozen return 12:10 planned at 13:30 gives a DEPOT break at 12:10 that counts.
- B8: a binding shift (11 h): the span includes the break; the prefilter's break-aware SHIFT_LIMIT message.
- B9: the CP-SAT repack: a consolidation that needs a depot break is found; a single load crossing midday is placed through a variant (and not REQUIRED_STOP_UNPLACEABLE); the hint with the break is reproduced by phase 2.
- B10: back-compatibility golden test: a request without the new fields is identical, load for load and minute for minute, to the same request on the P6+P10 base.
- B11: `check_scenario` BREAK: missing, outside the window, overlapping unloading, two breaks, and a break in a load after IN_FROZEN_LOAD.
- B12: `_identical_trucks` separates trucks with different break windows.
- B13: the bounds test (test_dispatch.py:1177-1224) covers the new config fields; the validators reject from > to and `break_min >= shift_max_min`.
- B14: speed guard: the break timing of real80's final plan runs well under 1 s.
- B15: P10 `test_search_modes.py:272` (a window 0-1, unserved under both rules) still passes.

**Web unit tests** (Vitest):
- `dispatch-service-time.spec.ts`: rewrite :20-27 and :44-46 (full base per part; explicit 0 gives 0; cap).
- `dispatch-feasibility.spec.ts`:
  - FINISH vs START cases
  - BREAK valid ROAD and DEPOT, missing, legacy WARN, on-road WARN, frozen flag, a depot gap that satisfies it
  - a LOCKED earlier-rule load is never newly blocked
  - `rulesFrom` with no echo still equals the exact object (:253-258)
  - `inputHash` is unchanged for old plans
- `tenant-settings.spec.ts`: new keys in `fields`, `CHANGED` (every setting changes the request) and the bounds json.
- `dispatch-workbook.spec.ts`: new column indexes; BREAK rows; the load header; the manifest line; TRUCK DAYS break column; ASSUMPTIONS new and earlier-rule rows; notes.
- `driver-pack.spec.ts`: the break row, "unload until", the hours line (:162), the WhatsApp lines (:279-281), `returnText` (:142-143).
- `plan-detail-fixture.ts` and plan-detail: `DetailLoad.break`, `DetailStop.closeMin`, the after-closing amber note, the mixed-deploy note.
- day-overview: the `rulesOutdated` count (the UP_TO_DATE key pinning).
- P10 `same-day-plan.spec.ts:199` (`rulesFrom`).

**Integration** (`apps/web/tests/integration`):
- `dispatch-timing.spec.ts :102-115`: a 3-load day from 07:30 now gets a depot break. The `>=` assertions still hold; add an assertion on `breakJson`, and that Lock and Dispatch pass.
- A carry-over test: a load LOCKED under START with no break is carried into a new version made under FINISH and break. It is not newly blocked, and its ASSUMPTIONS rows say "earlier rule".
- A frozen-break test: lock a load with a ROAD break, then re-plan. The request carries `break_start_min`, no second break is planned, and `breakJson` is copied to the new version.
- A split test: two parts each get the full base time.
- A test with an old solver mocked (no echo): the rules are stored as earlier rules and the note appears.

**Test fixtures:** the migration default is 60, so fixtures whose day crosses midday now get a break. Review every integration fixture with a day from before 13:00 to after 14:00. Set `driverBreakMinutes: 0` only where a test is about something else.

## 10. Benchmark plan

The results are written up as section 11 of `docs/OPTIMIZER_BENCHMARK.md`.

**Harness.** `C:/Users/abdulr/routeiq/.dev/bench` (git-ignored), run with the solver's own Python. Harness changes live in `.dev` only:
- `evaluate(..., rules=)` learns the finish rule and the break check (or reads the engine's `feasibility`)
- a `real80_win` instance: the real 26-Sep day with placeholder NMWC receiving hours. Large chains 06:00-11:00 and the rest 06:00-14:00, so that about a third of the stops' windows bind. It is labelled PLACEHOLDER until NMWC supplies the real hours and stop minutes (gap report rule 25, question 17).
- two operational variants of real80: **same-day at 11:40** (`loading_from_min`) and **frozen** (load 1 of four trucks locked, two of them with a recorded break)

**Runs.** Sequential, one process each, never in parallel with other benchmark agents. Three runs per cell, reporting the median and the spread. Each is run at Quick auto limits, and Thorough with a 10-minute cap on real80, real80_win and syn150_s1.

| Configuration | What it isolates |
|---|---|
| base | main after P6 + P10 (+ rule 22), no new fields |
| +split | full stop time per split visit (web minutes) |
| +finish | `window_rule` FINISH |
| +break | `break_min` 60, window 12:00-14:00 |
| all | the three together (what production will run) |

The instances are real80, real80_win, syn60_s1-s3, syn150_s1-s3 and syn300_s1 (Quick only), plus the two real80 variants.

**Reported per run:**
- served stops and cases by priority P1-P5, and unserved with their reasons
- trucks, loads, km
- operating cost in OMR, driver paid hours, overtime minutes, preference penalties
- breaks: PLANNED (ROAD or DEPOT) / NOT_NEEDED / IN_FROZEN_LOAD / NOT_POSSIBLE, and the minutes they added to the day
- stops finishing after closing (must be 0 under FINISH)
- feasibility status
- search solutions, stage time, time spent in break LPs, repack pool size with variants, repack status
- wall time

**What to expect** (scratch runs, single and noisy; the build re-measures):

| Rule | Measured so far | Expected on NMWC-like days |
|---|---|---|
| Split full time | real80: 583.4 to 599.2 OMR (+2.7%), 1,394 to 1,429 km, same 7 trucks and 21 loads, VERIFIED | +2-4% where split customers exist; about 140 more dock minutes on real80 |
| Finish by closing | syn60_s2 +1.2% (4 stops had finished up to 20 min after closing); syn150_s1 +7.5%, 8 to 9 trucks; real80 0 (no windows) | +1-8% on windowed days; hypermarket drops move earlier in the morning |
| Break | real80 final plan: all 7 truck-days took it, 4 inside the day at the depot (+30 each, reload 30 min); syn150_s1: 3 of 8 on the road (+60 each); 40-240 ms of LPs per plan | +2-4 paid driver hours a day, a few % cost, 0 extra trucks on slack days; overtime appears where days already reach 9 h |
| All three | not measured together | +4-10% cost; +1 truck on tight windowed days; no P1-P3 stop lost on harness days |

**Gates before merge:**
- Every final plan is VERIFIED.
- No P1-P3 stop that the base served is lost on any harness day. If one is, investigate before merge; the likely cause is the break-free search, so try the margin and variant settings, then consider Thorough-only breaks in the search.
- Every `DUE` truck-day gets its break.
- The median stage time rises by less than 3 s at Quick, and Thorough stays within its cap.

## 11. Effort

These are working days for one developer who knows the code.

| Part | Days |
|---|---|
| **Solver** | |
| Contract, validators, echo, shared-types mirror | 0.5 |
| Finish by closing: 5 places, prefilter reason, preferred windows, messages | 1.0 |
| Break: TruckDay states, frozen gaps, search margin, prefilter | 0.75 |
| Break: exact LP positions, selection, cache, `timing_ok` | 1.5 |
| Break: CP-SAT depot interval, variants, exactly-one, hint, symmetry | 2.5 |
| Output (`_build_scenario` arrival, wait, return), truck status, warnings | 0.75 |
| `check_scenario` BREAK and FINISH | 0.75 |
| Solver tests | 2.0 |
| **Web** | |
| Split full stop time and its tests | 0.5 |
| Settings: migration, schema, bounds, form, labels, effective values, tests | 1.0 |
| Request, breakJson, per-load rules, PlanSettings, mismatch note, outdated count | 1.25 |
| Gate: FINISH and BREAK, with tests | 1.25 |
| Plan screen and plan-detail | 1.0 |
| Excel (route column and BREAK row, load header, manifest, TRUCK DAYS, ASSUMPTIONS, notes) | 1.25 |
| PDF and WhatsApp | 0.75 |
| Wording, and the customer warning for windows shorter than unloading | 0.5 |
| Integration tests | 1.0 |
| **Other** | |
| Benchmark (harness additions, runs, write-up) | 1.5 |
| Docs (handbook, dispatcher guide, optimizer design) | 0.75 |
| Rebase on P6, P10 and rule 22; review rounds | 1.5 |
| **Total** | **about 22 days (19 to 27)**, about 4.5 weeks |

**Phases if wanted:**
- Phase A is split full time plus finish by closing, with its outputs and wording: about 5.5 days. It is independent of the break and can merge first.
- Phase B is the break: about 16.5 days.

The CP-SAT part is the least certain (2 to 4 days). The benchmark decides whether the variant filter needs work. Rule 22 (Appendix A, about 1.5 days) belongs to the long-search PR and is not counted here.

## 12. Risks

1. **The break-free search can make afternoon windows or the shift infeasible once the break is inserted.** The fit fallback then drops the lowest priorities. It did not happen on three harness days, but real NMWC windows are still placeholders. The mitigations are the search margin (§5.4), a break-aware repack (§5.6) and the `real80_win` gate (§10). The fallback plan, if it is not enough, is OR-Tools breaks in the Thorough search only (§5.9 recipe).
2. **Variants enlarge the CP-SAT model.** Within its time limit the repack may consolidate less (the 13 to 7 truck gains). They are not measured yet. The generation filter and logged pool sizes decide it.
3. **Stage time.** The LP enumeration runs once per candidate. The cache and `NONE_*`-first ordering are required, and the stage must fit P10's `STAGE_GRACE_SEC` (20 s) and Thorough tail.
4. **Capacity is lost on tight days,** with all three rules at once: earlier hypermarket drops, full dock time per split visit, and one more hour per truck-day inside the same shift. Expect more loads, sometimes one more truck, and P4-P5 left out on the worst days. NMWC still owes real receiving hours and stop minutes.
5. **Mixed deploy labels the wrong rules.** Prevented only if the web takes rules from the echo (§4.3). There is a test for it.
6. **Frozen loads could be blocked after the fact.** Prevented by per-load `PlanRules` and the WARN attribution in §7.3. Tested with a carried LOCKED load.
7. **PLANNED loads made before the deploy** pass their own earlier-rule check and could be locked without a break. The out-of-date notice and the deploy timing (§7.2) cover this; it is not a block.
8. **The migration default of 60** changes the timings of integration fixtures that cross midday, so there is test churn (§9). A default of 0 would instead need a manual setting for NMWC.
9. **Same-day plans may hold trucks until 13:00** instead of a road break. That is correct under the rule but gives later ETAs; it is visible on the plan.
10. **Split parts on one load** count the fixed time twice. This is rare and conservative (§2.4).
11. **The early-arrival push for P1 and P2** moves to `pref_end - svc`, which slightly shifts those costs.
12. **The P10 tree is still being edited.** Its line numbers here are from ff440ee plus the uncommitted edits, and will drift.
13. **Putting this inside the long-search PR** would widen its review and invalidate its search-mode benchmark (Q1).

## 13. Owner questions that remain

- **Q1: where the break lands.** Your message says to add the break with rule 22 to the long-search PR. It is built on that branch either way.
  - Option (a): more commits inside that PR, so one review, but it holds up the search-mode work.
  - Option (b), recommended: a separate PR stacked right after it, so each is reviewed and benchmarked on its own.

  Which do you want?
- **Q2: a day that ends between 12:00 and 14:00.** The default here is that a truck back at the depot for good by 14:00 gets no planned break (the driver takes it after the last trip). Or must every day still working at 12:00 hold the break before it ends? On the real 26-Sep day, 3 of 7 truck-days (back 12:03, 12:12, 13:14) would then run up to an hour longer. It costs about 0.5 day more to build.
- **Q3: is the break paid driver time,** counted toward overtime as the rest of the day is today? The default is yes, with no change to costs.

Everything else has a stated default in this spec:
- the break may overlap loading and waiting
- a same-day plan does not move the window
- NOT_POSSIBLE warns and never blocks
- preferred windows mean "finished by"
- the break length and window are company-wide settings; there is no Friday variant in this PR

## Appendix A: rule 22 in the long-search PR (as the owner asked)

This is not part of this PR's effort. It lands in P10 (`opt-long-search`) before this PR. The evidence is in the gap report `.dev/session-notes-2026-09-29/operational-rules-19-26-gap.md` :426-531.

- **Solver** (P10 `dispatch_solver.py _run_scenarios`, :1755-1769):
  - When `_Workers(...)` fails to start and `SOLVER_PARALLEL != "0"`, raise a new `PlannerUnavailable`. Do not solve in-process.
  - Start or check the pool **before** the road-matrix fetch, so the answer comes within seconds, not after up to 90 s.
  - Clean up the message queue when the Pool fails after it was made.
  - Log at ERROR level.
- **The second fallback** (:1836-1845, fresh workers for the load re-check): if they cannot start, keep the recommended plan and use `_retime_fallback` (exact LP timing, milliseconds, in-process) with a scenario warning. CP-SAT never runs in the API process.
- **API** (P10 `main.py:194-203`): map `PlannerUnavailable` to HTTP 503 with `Retry-After: 60` and a distinct detail code `PLANNER_UNAVAILABLE`, next to the existing "Solver busy" 503. It is not a 500.
- **Web** (`solver-client.ts:90-92`): for that code, show "The planner could not start right now; your previous plan is kept. Try again in a minute." There is no automatic retry: the dispatcher, the only user, presses again. The job is marked FAILED and the previous plan stays usable, as today.
- **Tests:**
  - make `_Workers` raise `OSError`: 503 within seconds, no search in-process, the slot is released
  - `SOLVER_PARALLEL=0` is unchanged
  - a failed replacement pool keeps the recommended plan with no CP-SAT solve
  - the web message and the FAILED job
- **Docs:** PROJECT_HANDBOOK.md :1596 and :1607-1614, OPTIMIZER_BENCHMARK.md :42, apps/solver/README.md :28, admin.md :126, DISPATCHER_GUIDE.md :172.
- **Effort:** about 1.5 days. Optionally, /ready reports "degraded" for a few minutes after a failed start (+0.25 day).

## Appendix B: evidence (scratch, `C:/Users/abdulr/routeiq/.dev/design-planning-rules/`)

- `break_semantics.py`, `break_overlap.py`: OR-Tools break semantics. The break can sit before or after the day, never during a visit, and costs nothing on an unused vehicle. It truly overlaps a reload only when the turnaround is moved to a slack minimum.
- `empty_window.py`: `SetRange(lo > hi)` on an optional node raises "CP Solver fail" when the model is built.
- `break_bench.py`, `seq_bench.txt`: breaks inside the route search at Quick limits: 3-9x fewer solutions, LOCAL_OPTIMUM_NOT_REACHED, +2% to +33% raw cost.
- `warm_check.py`, `frozen_bench.txt`, `sameday_bench.txt`: warm starts, frozen trucks and same-day plans with search breaks.
- `break_lp.py`, `lp_*.txt`: exact break insertion after the search on the engine's final plans. All truck-days fitted, with no rule broken.
- `rules_bench.py`, `rules_*.txt`: finish-by-closing and full split time, before and after.

## Appendix C: owner answers recorded for other PRs (29 Sep)

These answers are not built here. They belong to the hold and driver work (gap report rules 19, 21 and 23):
- Holds are set only by dispatchers.
- Holds end only by hand.
- Only the dispatcher may override a block.
- A load must never leave without a driver entered. Day drivers are used sometimes, and their names must still be recorded.
- Dispatch is pressed when the truck actually leaves.

The driver sheet and WhatsApp in this PR show the break for whichever driver is named at dispatch.
