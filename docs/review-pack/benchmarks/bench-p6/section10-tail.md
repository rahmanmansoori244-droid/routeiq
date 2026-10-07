
### 10.2 The same requests replayed back to back (controlled)

Because the machine's load changed between the versions' runs, each day's stored optimizer request from run 1 (main's request
on main's solver, the branch's request on the branch's solver: the same orders, the web of each version) was also solved again
in-process (`SOLVER_PARALLEL=0`), one after the other, day by day, at the same load, with the branch's final code (including the
E5 follow-up below). Re-plans count their new loads only here.

REPLAY_TABLE

### 10.3 Verdict

- **Priority service: never worse.** Every day, in every run of both versions and in the replays, serves exactly the same orders
  per priority (P1 to P5) and leaves the same ones unserved for the same reasons. Nothing to explain or fix under owner decision 26.
- **Cost: lower or equal on six of seven days, the seventh inside the search's variation.** In the replays the branch is cheaper
  on S01 (-3.1 %), S02 (-0.4 %), S03 (-0.2 %), the S04 re-plan (-2.0 %), the S04b re-plan (-15.7 %: one truck and one load fewer)
  and the real day (-0.4 %), and 0.5 % dearer on S05 (same trucks and loads, 15 km more). S05 is the day on which main's own two
  web runs differed by 10.6 % (411 and 455 OMR), so 0.5 % is the time-limited search finding another plan, not a rule. Over all
  seven replayed days the branch costs 1,858.6 OMR against 1,899.3 OMR (-2.1 %).
- **Why the plans differ.** The web runs had overtime unpriced on the synthetic days and no locked loads on the real day, so E4
  (only new overtime) does not act here; its effect is shown by the unit tests (a locked truck in overtime gets the new load for
  about 3 OMR instead of an idle truck for 6 OMR). The loads of these days are mostly case-bound, so F08's exact weights change the
  route search's arithmetic more than its choices: the search follows a different path and, on S04b, consistently finds a plan
  with one load and one truck fewer. The real day's large gap in the web runs (595.6 against 556.1 and 543.0 OMR) is mostly the
  machine: replayed back to back, main's request gives 545.0 OMR and the branch's 543.0.
- **Time.** The optimizer's own time is the same or lower on every day (its search limits did not change); the web runs' wall
  times moved with the machine's load. No solve came near the 540 s request budget.
- **E5 in practice.** In the branch's first real-day run one repack was given 0.6 s and ended UNKNOWN: its phase 1 ran past its
  40 % on the loaded machine and phase 2 was left a few hundredths of a second (the plan it started from stayed a candidate, and the
  day's plan came from another source's repack). The follow-up gives phase 2 at least 60 % of the solve's limit, at most 0.5 s
  (`load_repack.repack`, test `test_repack_phase_two_keeps_a_real_chance_when_phase_one_overran`); the replays ran with it and no
  repack ended without an answer. Main's logs show no UNKNOWN repack on these days either (its watchdog problem needs a first answer
  later than 1 s, as on the verifiers' tight 300-stop day).
- **Loading sheets.** In every saved workbook checked (S02, S03, both versions) each load sheet's manifest kg equals the load's
  kg. These synthetic days have no product weight corrected after planning and no order weighed at order level, so E3's change is
  shown by its unit tests, not here.
