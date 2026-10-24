"""Exact re-timing of a few truck days for a move by hand (``POST /retime-truck-days``, PR M1; v2 25 Oct 2026).

A dispatcher moves a stop (to another load of the same or another truck, at a chosen position or the best one; to a
new load; within its load; off the plan; or an unserved order onto a load). The web builds the version's request
FRESH (today's customers, trucks, settings, frozen loads and same-day clock), applies the move to the edited trucks'
PLANNED loads and sends them here. This module re-times exactly those truck days, with the engine's own functions and
nothing else - no route search, no CP-SAT, no worker process (rule 22): one small LP per truck and break position
(load_repack.time_truck, milliseconds each), as the safety net ``dispatch_solver._retime`` does in the API process.

* The truck days are those of the WHOLE request (``dispatch_solver._truck_days``: frozen loads, trips left, the break
  state, the bays), so they equal an optimization's. The loads are timed on a day of only the stops they carry
  (``_stage_ctx`` on a request of those stops), with one road matrix for every stop the call names.
* A truck whose loads keep every hard rule gets its exact timetable (``time_truck``, the driver break at its cheapest
  place). The scenario is built by ``dispatch_solver._build_scenario`` with ``exact_timing``, exactly as ``_retime``
  does, so its loads, legs, costs, pallets and its independent check (feasibility.check_scenario) are the plan's own.
* A truck that breaks one says why, by code and by how much (FeasibilityViolation): it has no time or no trip left
  (TRUCK_AVAILABILITY, TRIPS, BREAK), only the driver break has no place (timed again on a NEW day without the break
  rule: never the same day, whose timing cache is keyed by the truck's index), or - from the earliest timetable,
  each load leaving as soon as the truck is ready with the exact turnaround, through the independent check - the
  bays (98% several customers / 100% one customer), cases, kg, a small-truck-only customer, receiving hours, the
  latest return, the shift, the loads per day. Hard rules only: the web decides what a soft cost change means.
* ``before``: the same trucks' current loads timed in the same call, so the cost change is like for like (the same
  request, matrix and prices; never the stored costs of the solve).
* ``best``: every position of one load, or every place for a new one-stop load, prefiltered by the bays / cases / kg /
  allowed trucks, at most RETIME_BEST_TRIES timed, cheapest estimate first; ranked by money + time preferences, then
  the last return; the best 3 returned.
* The scenario covers the edited trucks only: the day-level warnings ``_build_scenario`` makes for a whole day (the
  priority ranking, other trucks' break notes, shortages) are dropped, and its truck counts are the edited trucks'.

Version 2 (owner feedback of 24 Oct 2026: whole loads, several stops at once, "allow anyway"). Everything new is
optional; a v1 request gets the v1 answer plus ``retime_version`` 2, ``loads``, ``relaxed`` None, ``allowed`` [] and the
violations' figures (value / limit / capacity, late_s):

* ``late_s`` on every HARD_WINDOW of the edited trucks: the seconds after the end of the hours, from the timetable the
  scenario was built from (a stop 1 s late has late_s 1, although its minutes round to the closing).
* Several stops at once and whole loads (``best.more_stop_ids`` / ``keep_order`` / ``new_load_at``, ``_best_v2``):
  each stop placed without an LP (estimate, fits, an earliest-timetable window screen), at most RETIME_BEST_TRIES
  exact timings in all. A best without a v2 field runs v1 ``_best`` unchanged.
* "Allow anyway" (``relax``): when the timing with every rule fails and every issue is of a kind the web may allow
  by hand (a late arrival, capacity up to ``capacity_factor``, the driver break) or NO_TIMETABLE, the trucks that fail
  are timed again on a NEW day per relaxation set (``_relaxed_side``: a late stop without its end of hours and a large
  penalty per second late, a bigger truck, no break) and the issues the independent check finds are split into
  allowed and remaining (``_partition``). The answer (``relaxed``) is made only by ``_relaxed_answer`` on an explicit
  layout, so a save of ``relaxed.loads`` gets exactly the same answer. No break is ever dropped by the solver on its
  own: only where the break alone had no place, or where the user asked (``seed_no_break``); a truck that would time
  without it is named in ``break_alternative``.
* ``before_relax``: the current loads are timed with the allowances they already carry.
* The budget: with ``relax`` the strict phase uses at most RELAX_SHARE of the time left after the road matrix.

Settings (read on every call, except RETIME_MAX_CONCURRENT, read once by main.py for its semaphore; a value that
cannot be read or is out of range takes its default and is named in the startup line):
RETIME_MAX_CONCURRENT (4) checks at once, RETIME_BUDGET_SEC (10) per check, RETIME_MATRIX_SEC (6) for road routing,
RETIME_BEST_TRIES (24) places timed for a best place.

This module imports neither pyvrp nor numpy (the API process never loads them: test_api_process_no_pyvrp.py).
"""
from __future__ import annotations

import logging
import os
import time
from dataclasses import dataclass, field, replace

import dispatch_solver as ds
import load_repack as LR
from dispatch_models import (
    RETIME_MAX_STOPS,
    RETIME_MAX_TRUCKS,
    DispatchRequest,
    DispatchScenario,
    DispatchStop,
    DispatchTruck,
    FeasibilityReport,
    FeasibilityViolation,
    RetimeBest,
    RetimeOption,
    RetimeRelaxations,
    RetimeRelaxed,
    RetimeRelaxPolicy,
    RetimeRequest,
    RetimeResponse,
    RetimeTruckBefore,
    RetimeTruckDay,
    RetimeTruckOut,
    payload_units,
)
from providers import MatrixResult, resolve_matrix

log = logging.getLogger("routeiq.retime")

VERSION = 2
ENV_MAX_CONCURRENT = "RETIME_MAX_CONCURRENT"
ENV_BUDGET_SEC = "RETIME_BUDGET_SEC"
ENV_MATRIX_SEC = "RETIME_MATRIX_SEC"
ENV_BEST_TRIES = "RETIME_BEST_TRIES"
# name -> (default, lowest, highest, whole numbers only)
_SETTINGS: dict[str, tuple[float, float, float, bool]] = {
    ENV_MAX_CONCURRENT: (4, 1, 16, True),
    ENV_BUDGET_SEC: (10.0, 1.0, 60.0, False),
    ENV_MATRIX_SEC: (6.0, 1.0, 30.0, False),
    ENV_BEST_TRIES: (24, 1, 200, True),
}
# The best options returned for RetimeRequest.best.
BEST_OPTIONS = 3
BUSY_TEXT = "Route checks busy: try again in a few seconds."
# v2, with ``relax``: the strict phase (the strict best place, the strict timing, ``before``) uses at most this share of
# the time left after the road matrix; the relaxed phase (the relaxed best place, the relaxed timing, the break probes)
# runs until the deadline. Without ``relax`` the strict phase has the whole budget (v1).
RELAX_SHARE = 0.5
OUT_OF_TIME_RELAXED = "Out of time while checking what can be allowed by hand: try again."
_CAPACITY = ("CAPACITY_PALLETS", "CAPACITY_CASES", "CAPACITY_KG")


class RetimeInvalid(ValueError):
    """A request the endpoint answers with 422: what is wrong with it, in plain words (ids only)."""


def _setting(name: str) -> tuple[float, str | None]:
    """(value, why the env value was not read) of one RETIME_* setting."""
    default, lo, hi, whole = _SETTINGS[name]
    raw = os.environ.get(name, "").strip()
    if not raw:
        return default, None
    try:
        value = int(raw) if whole else float(raw)
    except ValueError:
        value = None
    if value is None or not lo <= value <= hi:
        what = "a whole number" if whole else "a number"
        return default, f"{name}={raw[:20]!r} not read ({what} from {lo:g} to {hi:g}): its default is used"
    return value, None


def max_concurrent() -> int:
    return int(_setting(ENV_MAX_CONCURRENT)[0])


def budget_sec() -> float:
    return float(_setting(ENV_BUDGET_SEC)[0])


def matrix_sec() -> float:
    return float(_setting(ENV_MATRIX_SEC)[0])


def best_tries() -> int:
    return int(_setting(ENV_BEST_TRIES)[0])


def status() -> dict:
    """/ready's ``retime`` (never affects ok): the endpoint's version, so the web can tell an older solver."""
    return {"version": VERSION, "max_concurrent": max_concurrent(), "budget_sec": budget_sec(),
            "matrix_sec": matrix_sec(), "best_tries": best_tries()}


def startup_line() -> str:
    """The startup line (main.py; RAILWAY_DEPLOYMENT.md's check reads it, with /ready's ``retime``)."""
    notes = [why for name in _SETTINGS if (why := _setting(name)[1])]
    return (f"Re-timing for moves by hand (/retime-truck-days v{VERSION}): max {max_concurrent()} at once, budget "
            f"{budget_sec():g} s, road matrix {matrix_sec():g} s, best place {best_tries()} tries"
            + ("; " + "; ".join(notes) if notes else ""))


# ---------------------------------------------------------------------------------------------
# The request
# ---------------------------------------------------------------------------------------------

def _stop_ids(days: list[RetimeTruckDay]) -> list[str]:
    return [sid for d in days for load in d.loads for sid in load]


def _best_ids(b: RetimeBest) -> list[str]:
    """The stops a best place places: stop_id, then the v2 more stops (in the order sent)."""
    return [b.stop_id] + list(b.more_stop_ids)


def _is_v2(b: RetimeBest) -> bool:
    """A best that uses a v2 field (several stops, a whole load in its order, a chosen place for a new load). Any
    other best runs v1 ``_best`` exactly (review F15)."""
    return bool(b.more_stop_ids) or b.keep_order or b.new_load_at is not None


def check_request(body: RetimeRequest) -> None:
    """Raise RetimeInvalid when the request names a truck or stop that is not in it, a stop twice, an empty load,
    too many trucks or stops, a best place that does not fit truck_days, or v2 relaxations that do not fit it."""
    req = body.request
    trucks = {t.id for t in req.trucks}
    stops = {s.stop_id for s in req.stops}
    ids = [d.truck_id for d in body.truck_days]
    if len(ids) > RETIME_MAX_TRUCKS:
        raise RetimeInvalid(f"At most {RETIME_MAX_TRUCKS} trucks per check; this one names {len(ids)}.")
    if len(set(ids)) != len(ids):
        raise RetimeInvalid("A truck is listed twice in truck_days.")
    for sides, what in ((body.truck_days, "truck_days"), (body.before or [], "before")):
        for d in sides:
            if d.truck_id not in trucks:
                raise RetimeInvalid(f"Unknown truck {d.truck_id} in {what}: it is not in the request.")
            for j, load in enumerate(d.loads):
                if not load:
                    raise RetimeInvalid(f"Truck {d.truck_id} load {j + 1} in {what} has no stop.")
                for sid in load:
                    if sid not in stops:
                        raise RetimeInvalid(f"Unknown stop {sid} in {what}: it is not in the request.")
    after = _stop_ids(body.truck_days)
    if body.best is not None:
        b = body.best
        for sid in _best_ids(b):
            if sid not in stops:
                raise RetimeInvalid(f"Unknown stop {sid} for the best place: it is not in the request.")
        if len(set(b.more_stop_ids)) != len(b.more_stop_ids):
            twice = sorted({s for s in b.more_stop_ids if b.more_stop_ids.count(s) > 1})
            raise RetimeInvalid(f"Stop {twice[0]} is listed twice in more_stop_ids.")
        day = next((d for d in body.truck_days if d.truck_id == b.truck_id), None)
        if day is None:
            raise RetimeInvalid(f"The best place is asked on truck {b.truck_id}, which is not in truck_days.")
        if b.load_index is not None and b.load_index >= len(day.loads):
            raise RetimeInvalid(f"Truck {b.truck_id} has no load {b.load_index + 1} in truck_days for the best place.")
        if b.load_index is not None and (b.keep_order or b.new_load_at is not None):
            raise RetimeInvalid("keep_order and new_load_at are for a new load only (load_index null).")
        if b.new_load_at is not None and b.new_load_at > len(day.loads):
            raise RetimeInvalid(f"new_load_at {b.new_load_at} is outside truck {b.truck_id}'s loads: from 0 to "
                                f"{len(day.loads)}.")
        after += _best_ids(b)
    if len(set(after)) != len(after):
        twice = sorted({s for s in after if after.count(s) > 1})
        raise RetimeInvalid(f"Stop {twice[0]} is on more than one load (truck_days and best together).")
    before: list[str] = []
    if body.before is not None:
        b_ids = [d.truck_id for d in body.before]
        if sorted(b_ids) != sorted(ids):
            raise RetimeInvalid("before must list exactly the trucks of truck_days (a truck with no load: loads []).")
        before = _stop_ids(body.before)
        if len(set(before)) != len(before):
            twice = sorted({s for s in before if before.count(s) > 1})
            raise RetimeInvalid(f"Stop {twice[0]} is on more than one load in before.")
    if body.relax is not None:
        for tid in body.relax.seed_no_break:
            if tid not in ids:
                raise RetimeInvalid(f"Truck {tid} in seed_no_break is not in truck_days.")
    if body.before_relax is not None:
        br = body.before_relax
        in_before = set(before)
        for sid in br.late_stop_ids:
            if sid not in in_before:
                raise RetimeInvalid(f"Stop {sid} in before_relax is not in before.")
        for tid in br.over_capacity_truck_ids + br.no_break_truck_ids:
            if tid not in ids:
                raise RetimeInvalid(f"Truck {tid} in before_relax is not in truck_days.")
        if br.over_capacity_truck_ids and br.capacity_factor is None:
            raise RetimeInvalid("before_relax names trucks over capacity without its capacity_factor.")
    n = len(set(after) | set(before))
    if n > RETIME_MAX_STOPS:
        raise RetimeInvalid(f"At most {RETIME_MAX_STOPS} stops per check; this one names {n}.")


# ---------------------------------------------------------------------------------------------
# One side (after the move, or before it): its stops, matrix and day
# ---------------------------------------------------------------------------------------------

@dataclass
class _Side:
    ctx: ds._StageCtx
    ids: list[str]  # stop id of each stop index of ctx.solvable
    pos: dict[str, int]
    relaxed: ds._StageCtx | None = None  # the same stops on a day without the break rule (built when needed)


@dataclass
class _Result:
    timed: list[LR.TimedLoad] | None  # exact timetable ([] = no new load); None = no timetable keeps every rule
    shown: list[LR.TimedLoad]  # what the scenario shows: timed, or the earliest timetable
    violations: list[FeasibilityViolation] = field(default_factory=list)
    # v2: the BREAK of _own_reasons "only the driver break has no place" (the one BREAK a no-break relaxation may
    # allow), marked here, never matched by its words.
    no_place: FeasibilityViolation | None = None
    allowed: list[FeasibilityViolation] = field(default_factory=list)  # v2: allowed by relaxations

    @property
    def feasible(self) -> bool:
        return self.timed is not None and not self.violations


class _Count:
    timings = 0


def _side(req: DispatchRequest, tds: list, ids: list[str], union: list, upos: dict[str, int], mx: MatrixResult) -> _Side:
    stops, sub_mx = ds._submatrix(union, [upos[sid] for sid in ids], mx)
    sub = req.model_copy(update={"stops": stops})
    return _Side(ctx=ds._stage_ctx(sub, stops, tds, sub_mx, []), ids=list(ids), pos={sid: k for k, sid in enumerate(ids)})


def _plan(side: _Side, days: list[RetimeTruckDay], truck_idx: dict[str, int]) -> dict[int, list[tuple[int, ...]]]:
    return {truck_idx[d.truck_id]: [tuple(side.pos[sid] for sid in load) for load in d.loads] for d in days}


def _fits(day: LR.Day, td, loads: list[tuple[int, ...]]) -> bool:
    """The truck can take these loads at all: usable today, enough trips, every load within its room, kg and
    allowed trucks (load_repack.fits_truck: 98% bays for several customers, 100% for one)."""
    return td.usable and len(loads) <= td.trips_left and all(LR.fits_truck(LR.facts(day, l), td) for l in loads)


def _time(side: _Side, td, loads: list[tuple[int, ...]], count: _Count) -> list[LR.TimedLoad] | None:
    if not loads:
        return []
    if not _fits(side.ctx.day, td, loads):
        return None
    count.timings += 1
    return LR.time_truck(side.ctx.day, td, loads, side.ctx.rec_pricing)


def _earliest(day: LR.Day, td, loads: list[tuple[int, ...]]) -> list[LR.TimedLoad]:
    """The timetable of a truck whose loads cannot be timed with every rule, to say which rules they break: each
    load leaves as soon as the truck is ready - after the exact turnaround (reload + loading of ITS cases) from the
    previous return, the truck's last frozen return or the time a same-day plan was made - and no earlier than it
    needs to (no waiting on the road), or at the latest time that meets every window when it must wait; no break.
    Only for the screen and the check: never saved."""
    out: list[LR.TimedLoad] = []
    prev_return = None
    for load in loads:
        f = LR.facts(day, load)
        ready = LR._first_departure_s(day, td, f) if prev_return is None else max(td.earliest_depart_s, prev_return + f.gap)
        depart = max(ready, f.hi) if f.waits else max(ready, f.lo)
        starts = LR._forward_starts(day, f, depart)
        last = load[-1]
        ret = starts[-1] + day.stops[last].service_min * 60 + day.T[last + 1][0]
        out.append(LR.TimedLoad(stops=tuple(load), depart_s=depart, starts=tuple(starts), return_s=ret))
        prev_return = ret
    return out


def _relaxed(side: _Side, req: DispatchRequest) -> ds._StageCtx:
    """The side's stops on a NEW day without the break rule (its own truck days and timing cache)."""
    if side.relaxed is None:
        cfg = req.config.model_copy(update={"break_min": 0})
        tds = ds._truck_days(req.model_copy(update={"config": cfg}))
        sub = side.ctx.req.model_copy(update={"config": cfg})
        side.relaxed = ds._stage_ctx(sub, side.ctx.solvable, tds, side.ctx.mx, [])
    return side.relaxed


def _violation(code: str, message: str, td, **kw) -> FeasibilityViolation:
    return FeasibilityViolation(code=code, message=message, truck_id=td.truck.id, **kw)  # type: ignore[arg-type]


def _own_reasons(side: _Side, req: DispatchRequest, td, loads: list[tuple[int, ...]], deadline: float,
                 count: _Count) -> tuple[list[FeasibilityViolation], bool, bool]:
    """(the reasons found here, whether the independent check of the earliest timetable names the others, whether
    the reason is "only the driver break has no place")."""
    cfg = req.config
    code = td.truck.code or td.truck.id
    if not td.usable:
        if td.trips_left <= 0:
            most = td.truck.max_trips or cfg.max_trips_per_truck
            return [_violation("TRIPS", f"{code} already has {td.n_frozen} locked or dispatched load(s), its most loads "
                                        f"a day ({most}): it takes no new load.", td)], False, False
        if td.break_note:
            return [_violation("BREAK", td.break_note, td)], False, False
        return [_violation("TRUCK_AVAILABILITY", f"{code} has no time left for a new load today: ready at "
                                                 f"{ds._hhmm(td.earliest_depart_s // 60)}, back by "
                                                 f"{ds._hhmm(td.latest_return_s // 60)} at the latest.", td)], False, False
    if _fits(side.ctx.day, td, loads) and LR.break_due(td) and time.monotonic() < deadline:
        relaxed = _relaxed(side, req)
        td0 = relaxed.tds[td.idx]
        if td0.usable:
            count.timings += 1
            if LR.time_truck(relaxed.day, td0, loads, relaxed.rec_pricing) is not None:
                return [_violation("BREAK", f"No place for the driver's {cfg.break_min}-min break (to start "
                                            f"{ds._hhmm(cfg.break_start_from_min)}-{ds._hhmm(cfg.break_start_to_min)}) on "
                                            f"{code} with these stops in this order.", td)], False, True
    return [], True, False


def _scenario(side: _Side, req: DispatchRequest, timed: dict[int, list[LR.TimedLoad]], exact: bool, edited: set[int],
              started: float) -> DispatchScenario:
    """The edited trucks' scenario, built as dispatch_solver._retime builds one, without the day-level warnings and
    with the edited trucks' own counts."""
    ctx = side.ctx
    shown = {idx: loads for idx, loads in timed.items() if loads}
    objective = LR.score(ctx.day, ctx.rec_pricing, shown).objective if exact else 0
    sc = ds._build_scenario("RECOMMENDED", ctx.req, ctx.solvable, ctx.tds, ctx.mx, shown, ctx.values, ctx.use_margin, [],
                            solver_status="RETIMED", elapsed=time.monotonic() - started, time_limit=0,
                            objective_value=objective, extra_warnings=[], exact_timing=exact)
    mine = [td for td in ctx.tds if td.idx in edited]
    keep = set(ctx.mx.warnings) | {td.break_note for td in mine if td.break_note}
    if (problem := ds.break_rule_problem(req.config)) is not None:
        keep.add(problem)
    sc.warnings = [w for w in sc.warnings if w in keep or w.startswith("Cost check:")]
    frozen = {td.truck.id for td in mine if td.n_frozen}
    sc.frozen_trucks = len(frozen)
    sc.frozen_loads = sum(td.n_frozen for td in mine)
    sc.trucks_used = len({ld.truck_id for ld in sc.loads} | frozen)
    ds._echo_rules(req, sc)
    return sc


def _evaluate(side: _Side, req: DispatchRequest, plan: dict[int, list[tuple[int, ...]]], deadline: float, count: _Count,
              started: float, *, want_scenario: bool) -> tuple[dict[int, _Result], DispatchScenario | None]:
    """Time every truck of ``plan`` exactly; say why for each one that cannot be. The scenario is built when asked
    for, and always when a truck cannot be timed (its violations come from the independent check)."""
    results: dict[int, _Result] = {}
    for idx, loads in plan.items():
        td = side.ctx.tds[idx]
        got = _time(side, td, loads, count)
        results[idx] = _Result(timed=got, shown=got if got is not None else _earliest(side.ctx.day, td, loads))
    exact = all(r.timed is not None for r in results.values())
    sc = None
    if exact and want_scenario:
        sc = _scenario(side, req, {idx: r.timed for idx, r in results.items()}, True, set(plan), started)
    elif not exact:
        try:
            sc = _scenario(side, req, {idx: r.shown for idx, r in results.items()}, False, set(plan), started)
        except Exception as exc:  # noqa: BLE001 - a refusal stays a refusal: the reasons found here still say why
            log.warning("retime run=%s: the timetable of a refused move could not be built: %s", req.run_id, exc)
    checked: dict[str, list[FeasibilityViolation]] = {}
    for v in (sc.feasibility.violations if sc is not None and sc.feasibility is not None else []):
        checked.setdefault(v.truck_id or "", []).append(v)
    for idx, r in results.items():
        td = side.ctx.tds[idx]
        mine = checked.get(td.truck.id, [])
        if r.timed is not None:
            r.violations = mine  # the independent check has the last word
            continue
        own, trust, no_place = _own_reasons(side, req, td, plan[idx], deadline, count)
        if no_place:
            r.no_place = own[0]
        # The earliest timetable holds no break on purpose: a BREAK the check finds there is not a reason.
        r.violations = own + ([v for v in mine if v.code != "BREAK"] if trust else [])
        if not r.violations:
            r.violations = [_violation("NO_TIMETABLE", f"No timetable keeps every rule for {td.truck.code or td.truck.id} "
                                                       "with these loads in this order.", td)]
    _set_late_s(side, req, _all_violations(results, sc), [r.shown for r in results.values()])
    return results, sc


def _figures(side: _Side, idx: int, timed: list[LR.TimedLoad]) -> dict:
    """Money (costing.truck_day_costs, the plan's own cost model), time preferences and km of one truck's exact
    timetable, from the same day and prices as every other figure of the call."""
    if not timed:
        return dict(money_omr=0.0, soft_omr=0.0, km=0.0, first_depart_min=None, last_return_min=None)
    s = LR.score(side.ctx.day, side.ctx.rec_pricing, {idx: timed})
    return dict(money_omr=round(s.operating / ds.COST_SCALE, 3), soft_omr=round((s.cost - s.operating) / ds.COST_SCALE, 3),
                km=round(s.metres / 1000.0, 2), first_depart_min=ds._min_of(timed[0].depart_s),
                last_return_min=ds._min_of(timed[-1].return_s))


def _delta(a: float | int | None, b: float | int | None, nd: int = 3):
    return None if a is None or b is None else round(a - b, nd)


# ---------------------------------------------------------------------------------------------
# v2: the figures of a violation (late_s), and whether it can be allowed by hand
# ---------------------------------------------------------------------------------------------

def _late_s(s: DispatchStop, start_s: int, rule: str | None) -> int | None:
    """Seconds after the end of the receiving hours (START: the service start after closing; FINISH: the end of
    unloading after closing), from the exact second the timetable gives - so a stop 1 s late is 1 s late although its
    minutes round to the closing (review F1). None: not late, or early (before opening)."""
    if s.hard_end_min is None:
        return None
    late = start_s - LR.latest_start_s(s, rule)
    return late if late > 0 and start_s >= (s.hard_start_min or 0) * 60 else None


def _set_late_s(side: _Side, req: DispatchRequest, violations: list[FeasibilityViolation],
                timetables: list[list[LR.TimedLoad]]) -> None:
    """late_s on every HARD_WINDOW of ``violations``, from the timetables the scenario was built from (exact, relaxed
    or earliest), against each stop's REAL hours (the request's stop: a relaxed day gives a late stop without its end)."""
    starts = {side.ids[k]: st for loads in timetables for tl in loads for k, st in zip(tl.stops, tl.starts)}
    stops = {s.stop_id: s for s in req.stops}
    for v in violations:
        if v.code == "HARD_WINDOW" and v.stop_id in starts and v.stop_id in stops:
            v.late_s = _late_s(stops[v.stop_id], starts[v.stop_id], req.config.window_rule)


def _all_violations(results: dict[int, _Result], sc: DispatchScenario | None) -> list[FeasibilityViolation]:
    """The violations of the trucks' results and of the scenario's check (the same objects where they are shared)."""
    out = [v for r in results.values() for v in r.violations]
    seen = {id(v) for v in out}
    out += [v for v in (sc.feasibility.violations if sc is not None and sc.feasibility is not None else []) if id(v) not in seen]
    return out


def _cap_units(x: int, factor: float) -> int:
    """x whole units at most ``factor`` x: floor(x * (100 + pct) / 100), pct = round((factor - 1) x 100) - the same
    integer rule as the web (OVERRIDE_CAPACITY_MAX_PCT)."""
    return x * (100 + round((factor - 1) * 100)) // 100


def _capacity_ok(v: FeasibilityViolation, truck: DispatchTruck | None, factor: float | None) -> bool:
    """A CAPACITY_* violation within ``factor`` x the truck's OWN capacity (bays x 1000 pallet units - never the
    planning room at the fill -, cases, or the payload in 0.1 kg units)."""
    if factor is None or truck is None or v.value is None:
        return False
    if v.code == "CAPACITY_PALLETS":
        return bool(truck.bays) and round(v.value * 1000) <= _cap_units(truck.bays * 1000, factor)
    if v.code == "CAPACITY_CASES":
        return truck.capacity_cases > 0 and round(v.value) <= _cap_units(truck.capacity_cases, factor)
    if v.code == "CAPACITY_KG":
        cap = payload_units(truck.capacity_kg)
        return cap > 0 and round(v.value * 10) <= _cap_units(cap, factor)
    return False


def _overridable(v: FeasibilityViolation, policy: RetimeRelaxPolicy, truck: DispatchTruck | None, no_place: bool) -> bool:
    """Whether the web may allow this issue by hand under ``policy`` (4.2): a late arrival (late_s from the timetable),
    capacity within the factor, or "only the driver break has no place" (_own_reasons). Never the break note of a
    truck with no time left, a BREAK of an earliest timetable, NO_TIMETABLE or any other rule."""
    if v.code == "HARD_WINDOW":
        return policy.late and v.late_s is not None
    if v.code in _CAPACITY:
        return _capacity_ok(v, truck, policy.capacity_factor)
    if v.code == "BREAK":
        return policy.no_break and no_place
    return False


def _judge(results: dict[int, _Result], sc: DispatchScenario | None, policy: RetimeRelaxPolicy | None,
           trucks: dict[str, DispatchTruck]) -> None:
    """overridable on every violation of the strict timing (only with ``relax``; None otherwise)."""
    if policy is None:
        return
    no_place = {id(r.no_place) for r in results.values() if r.no_place is not None}
    for v in _all_violations(results, sc):
        v.overridable = _overridable(v, policy, trucks.get(v.truck_id or ""), id(v) in no_place)


# ---------------------------------------------------------------------------------------------
# v2: relaxations (a NEW day per relaxation set) and the partition of what the check finds
# ---------------------------------------------------------------------------------------------

@dataclass(frozen=True)
class _Rel:
    """A relaxation set: stops given without their end of hours (late), trucks with ``factor`` x their capacity
    (over), truck-days without their driver break (no_break)."""

    late: frozenset[str] = frozenset()
    over: frozenset[str] = frozenset()
    factor: float | None = None
    no_break: frozenset[str] = frozenset()


def _over_capacity(td, factor: float):
    """The truck-day with ``factor`` x its OWN capacity: bays x 1000 pallet units for several customers and one alike
    (a bay truck keeps its free cases), else its cases; its payload when it has one."""
    up: dict = {}
    if td.by_pallets and td.bays:
        room = _cap_units(td.bays * 1000, factor)
        up.update(max_pallet_units=room, solo_pallet_units=room)
    else:
        up["max_cases"] = _cap_units(td.truck.capacity_cases, factor)
    cap = payload_units(td.truck.capacity_kg)
    if cap > 0:
        up["max_kg_units"] = _cap_units(cap, factor)
    return replace(td, **up)


def _relaxed_side(base: _Side, rel: _Rel) -> _Side:
    """``base``'s stops, matrix, prices and truck days on a NEW day (its own timing cache: load_repack.time_truck caches
    by the truck's index per Day, so two relaxation sets, or a relaxation and the strict day, never share one; review
    F6), differing in exactly: each stop of ``rel.late`` without its end of hours (it still waits for opening) and
    with its real latest start as a soft bound (Day.late_soft: LATE_SOFT_PER_S a second), each truck of ``rel.over``
    with ``rel.factor`` x its capacity, each truck-day of ``rel.no_break`` without its driver break."""
    ctx = base.ctx
    rule = ctx.req.config.window_rule
    stops = list(ctx.solvable)
    late_soft: dict[int, int] = {}
    for k, sid in enumerate(base.ids):
        if sid in rel.late and stops[k].hard_end_min is not None:
            late_soft[k] = LR.latest_start_s(stops[k], rule)
            stops[k] = stops[k].model_copy(update={"hard_end_min": None})
    tds = list(ctx.tds)
    for i, td in enumerate(tds):
        tid = td.truck.id
        if tid in rel.over and rel.factor is not None:
            td = _over_capacity(td, rel.factor)
        if tid in rel.no_break and LR.break_due(td):
            td = replace(td, break_state="OFF")
        tds[i] = td
    old = ctx.day
    day = LR.Day(stops=stops, trucks=[td for td in tds if td.usable], D=old.D, T=old.T, shift_max_s=old.shift_max_s,
                 reload_s=old.reload_s, loading_s_per_case=old.loading_s_per_case, values=old.values,
                 frozen_trucks=old.frozen_trucks, window_rule=old.window_rule, late_soft=late_soft)
    sub = ctx.req.model_copy(update={"stops": stops})
    return _Side(ctx=replace(ctx, req=sub, solvable=stops, tds=tds, day=day), ids=base.ids, pos=base.pos)


def _partition(violations: list[FeasibilityViolation], rel: _Rel, relaxed_timed: set[str], untimed: set[str],
               policy: RetimeRelaxPolicy, trucks: dict[str, DispatchTruck], codes: dict[str, str]
               ) -> tuple[dict[str, list[FeasibilityViolation]], dict[str, list[FeasibilityViolation]]]:
    """(allowed, remaining) per truck id of the check's violations of a relaxed timetable (4.5). Allowed: a
    HARD_WINDOW of a late stop on a truck timed on the relaxed side (late_s > 0 there, never early); a CAPACITY_*
    of a truck over capacity within the factor; a BREAK of a no-break truck timed on the relaxed side. On a truck
    that could not be timed even so (``untimed``), BREAK is dropped (its earliest timetable holds none on purpose,
    review F5) and NO_TIMETABLE is added when nothing that cannot be allowed names the reason."""
    allowed: dict[str, list[FeasibilityViolation]] = {}
    remaining: dict[str, list[FeasibilityViolation]] = {}
    for v in violations:
        tid = v.truck_id or ""
        ok = False
        if v.code == "HARD_WINDOW":
            ok = tid in relaxed_timed and v.stop_id in rel.late and v.late_s is not None
        elif v.code in _CAPACITY:
            ok = tid in rel.over and _capacity_ok(v, trucks.get(tid), rel.factor)
        elif v.code == "BREAK":
            ok = tid in rel.no_break and tid in relaxed_timed
        if ok:
            v.overridable = True
            allowed.setdefault(tid, []).append(v)
        elif not (v.code == "BREAK" and tid in untimed):
            v.overridable = _overridable(v, policy, trucks.get(tid), False)
            remaining.setdefault(tid, []).append(v)
    for tid in untimed:
        if not any(v.overridable is False for v in remaining.get(tid, [])):
            remaining.setdefault(tid, []).append(FeasibilityViolation(
                code="NO_TIMETABLE", truck_id=tid, overridable=False,
                message=f"No timetable keeps the rules that cannot be allowed by hand for {codes.get(tid, tid)} with these "
                        "loads in this order."))
    return allowed, remaining


# ---------------------------------------------------------------------------------------------
# Best place
# ---------------------------------------------------------------------------------------------

@dataclass
class _Best:
    options: list[tuple[RetimeOption, list[tuple[int, ...]]]]
    fallback: list[tuple[int, ...]]  # the cheapest estimate's loads (to say why when no place keeps every rule)
    total: int
    tried: int


def _per_m(side: _Side, idx: int) -> float:
    price = side.ctx.rec_pricing.trucks.get(idx)
    return (price.per_m + price.tie_m) if price is not None else 0.0


def _v1_cands(side: _Side, b: RetimeBest, idx: int, loads: list[tuple[int, ...]]
              ) -> list[tuple[float, int, int | None, int | None, int, list[tuple[int, ...]]]]:
    """v1's candidate places for one stop, cheapest estimate first: every position in loads[load_index] (the detour
    priced as _insertions does), or alone as a new load at every place (after the last load first)."""
    day = side.ctx.day
    k = side.pos[b.stop_id]
    node = k + 1
    per_m = _per_m(side, idx)
    cands: list[tuple[float, int, int | None, int | None, int, list[tuple[int, ...]]]] = []
    if b.load_index is not None:
        j = b.load_index
        load = loads[j]
        for p in range(len(load) + 1):
            a = load[p - 1] + 1 if p else 0
            z = load[p] + 1 if p < len(load) else 0
            detour = day.D[a][node] + day.D[node][z] - day.D[a][z]
            cands.append((per_m * detour, len(cands), j, None, p, loads[:j] + [load[:p] + (k,) + load[p:]] + loads[j + 1:]))
    else:
        out_back = per_m * (day.D[0][node] + day.D[node][0])
        for q in range(len(loads), -1, -1):  # after the last load first: the spare time at the end of the day
            cands.append((out_back + 0.001 * (len(loads) - q), len(cands), None, q, 0, loads[:q] + [(k,)] + loads[q:]))
    cands.sort(key=lambda c: (c[0], c[1]))
    return cands


def _best(side: _Side, body: RetimeRequest, idx: int, loads: list[tuple[int, ...]], deadline: float,
          count: _Count) -> _Best:
    """Every place for best.stop_id on its truck, cheapest estimate first (the detour priced as _insertions
    does), prefiltered by the truck's room, kg, allowed trucks and trips; at most RETIME_BEST_TRIES timed exactly
    within the budget; ranked by money + time preferences (load_repack._order_value), then the last return, then
    the estimate order. Deterministic: the same request gives the same options."""
    b = body.best
    assert b is not None
    ctx = side.ctx
    day, td = ctx.day, ctx.tds[idx]
    cands = _v1_cands(side, b, idx, loads)
    tries = best_tries()
    good: list[tuple[float, int, int, tuple, list[LR.TimedLoad]]] = []
    tried = 0
    for c in cands:
        if tried >= tries or time.monotonic() > deadline:
            break
        if not _fits(day, td, c[5]):
            continue
        tried += 1
        timed = _time(side, td, c[5], count)
        if timed is None:
            continue
        value = LR._order_value(day, ctx.rec_pricing, idx, timed, 0.0)[2]
        good.append((value, timed[-1].return_s, c[1], c, timed))
    good.sort(key=lambda g: (g[0], g[1], g[2]))
    options = []
    for _value, _ret, _order, c, timed in good[:BEST_OPTIONS]:
        fig = _figures(side, idx, timed)
        options.append((RetimeOption(truck_id=b.truck_id, load_index=c[2], new_load_at=c[3], position=c[4],
                                     loads=[[side.ids[s] for s in load] for load in c[5]], money_omr=fig["money_omr"],
                                     soft_omr=fig["soft_omr"], km=fig["km"], last_return_min=fig["last_return_min"]), c[5]))
    return _Best(options=options, fallback=cands[0][5], total=len(cands), tried=tried)


# --- v2: several stops at once, a whole load ---------------------------------------------------

@dataclass
class _Cand:
    """One place for the best stops: the truck's whole layout, and where they went."""

    loads: list[tuple[int, ...]]
    load_index: int | None
    new_load_at: int | None
    position: int
    order: int  # the estimate order (ties)


class _Tries:
    """The exact-timing budget of one best-place search (review F13): at most ``tries`` timings and the deadline,
    whatever the number of stops. A layout that already fails _fits costs nothing."""

    def __init__(self, tries: int, deadline: float) -> None:
        self.tries, self.deadline, self.tried, self.total = tries, deadline, 0, 0

    def left(self) -> bool:
        return self.tried < self.tries and time.monotonic() <= self.deadline

    def time(self, fit: _Side, idx: int, loads: list[tuple[int, ...]], count: _Count) -> list[LR.TimedLoad] | None:
        """One exact timing of ``loads`` on ``fit`` (None: it does not fit, does not time, or no try is left)."""
        if not _fits(fit.ctx.day, fit.ctx.tds[idx], loads) or not self.left():
            return None
        self.tried += 1
        return _time(fit, fit.ctx.tds[idx], loads, count)


def _placement_order(side: _Side, ks: list[int]) -> list[int]:
    """The order several stops are placed in: the earliest end of receiving hours first (none last), then the
    farthest from the depot, then the stop id - time-critical customers go in first, deterministically."""
    day = side.ctx.day

    def key(k: int):
        he = day.stops[k].hard_end_min
        return (he is None, he if he is not None else 0, -day.D[0][k + 1], side.ids[k])

    return sorted(ks, key=key)


def _positions_by_estimate(day: LR.Day, per_m: float, load: tuple[int, ...], k: int) -> list[int]:
    """Every position of stop k in ``load``, cheapest detour first (the estimate of _best), ties by position."""
    node = k + 1
    out = []
    for p in range(len(load) + 1):
        a = load[p - 1] + 1 if p else 0
        z = load[p] + 1 if p < len(load) else 0
        out.append((per_m * (day.D[a][node] + day.D[node][z] - day.D[a][z]), p))
    out.sort()
    return [p for _, p in out]


def _window_screen(day: LR.Day, td, loads: list[tuple[int, ...]], j: int) -> bool:
    """The cheap window screen (no LP): the truck's earliest timetable meets every end of receiving hours of load j
    (only the loads up to j decide when it leaves)."""
    tl = _earliest(day, td, loads[:j + 1])[j]
    return all(st <= LR._he(day, day.stops[k]) for k, st in zip(tl.stops, tl.starts))


def _with(loads: list[tuple[int, ...]], j: int, load: tuple[int, ...]) -> list[tuple[int, ...]]:
    return loads[:j] + [load] + loads[j + 1:]


def _place_stops(side: _Side, fit: _Side, idx: int, loads: list[tuple[int, ...]], j: int, ks: list[int]
                 ) -> list[tuple[int, ...]]:
    """Each stop of ``ks``, in that order, into loads[j] at a position chosen WITHOUT an LP: by estimate, the first
    that keeps the truck's whole layout within its room (_fits) and passes the window screen (the real hours, also
    for a relaxed ``fit`` side, whose room is the relaxed one); else the first that fits; else the cheapest
    estimate."""
    day, td = side.ctx.day, side.ctx.tds[idx]
    fday, ftd = fit.ctx.day, fit.ctx.tds[idx]
    per_m = _per_m(side, idx)
    for k in ks:
        load = loads[j]
        layouts = [_with(loads, j, load[:p] + (k,) + load[p:]) for p in _positions_by_estimate(day, per_m, load, k)]
        # The room does not depend on the position (a load's pallets, cases, kg and allowed trucks): one test for all.
        # A relaxed room is never smaller, so "fits the strict room, else the relaxed one" is "fits the relaxed one"
        # for the choice of a position.
        if _fits(day, td, layouts[0]) or (fit is not side and _fits(fday, ftd, layouts[0])):
            loads = next((L for L in layouts if _window_screen(day, td, L, j)), layouts[0])
        else:
            loads = layouts[0]
    return loads


def _repairs(side: _Side, idx: int, loads: list[tuple[int, ...]], j: int, ks: list[int]):
    """(how many, the layouts) the repairs of a placed load try, in order: going from the last placed stop to the
    first, each takes its next position by estimate (rank 1 for every stop, then rank 2, ...), one at a time."""
    day, per_m = side.ctx.day, _per_m(side, idx)
    load = loads[j]
    alts: list[tuple[int, tuple[int, ...], list[int]]] = []
    for k in reversed(ks):
        i = load.index(k)
        without = load[:i] + load[i + 1:]
        alts.append((k, without, [p for p in _positions_by_estimate(day, per_m, without, k) if p != i]))

    def gen():
        for r in range(max((len(a[2]) for a in alts), default=0)):
            for k, without, ps in alts:
                if r < len(ps):
                    p = ps[r]
                    yield _with(loads, j, without[:p] + (k,) + without[p:])

    return sum(len(a[2]) for a in alts), gen()


def _rank_key(side: _Side, fit: _Side, idx: int, loads: list[tuple[int, ...]], timed: list[LR.TimedLoad]) -> tuple:
    """How a timed place ranks: the loads over the planning room (fewer first; 0 on the strict side), the seconds late
    (on the relaxed side; 0 on the strict side), money + time preferences on the STRICT day (_order_value), the last
    return. With the strict side as ``fit`` this is v1's ranking."""
    day, td = side.ctx.day, side.ctx.tds[idx]
    over = sum(1 for l in loads if not LR.fits_truck(LR.facts(day, l), td))
    soft = fit.ctx.day.late_soft
    late = sum(max(0, st - soft[k]) for tl in timed for k, st in zip(tl.stops, tl.starts) if k in soft)
    value = LR._order_value(day, side.ctx.rec_pricing, idx, timed, 0.0)[2]
    return (over, late, value, timed[-1].return_s)


def _option(side: _Side, b: RetimeBest, idx: int, c: _Cand, timed: list[LR.TimedLoad]) -> tuple[RetimeOption, list]:
    fig = _figures(side, idx, timed)
    return (RetimeOption(truck_id=b.truck_id, load_index=c.load_index, new_load_at=c.new_load_at, position=c.position,
                         loads=[[side.ids[s] for s in load] for load in c.loads], money_omr=fig["money_omr"],
                         soft_omr=fig["soft_omr"], km=fig["km"], last_return_min=fig["last_return_min"]), c.loads)


def _first_that_times(side: _Side, fit: _Side, b: RetimeBest, idx: int, first: _Cand, more, total: int,
                      tries: _Tries, count: _Count) -> _Best:
    """``first`` (the screened layout), then the repairs ``more``, timed in turn: the first that times is the one
    option (several stops show no "other places"). Else no option, and ``first`` is the fallback. The repairs only
    reorder the same load, so when ``first`` does not fit the truck at all none of them is tried."""
    tries.total = total
    if _fits(fit.ctx.day, fit.ctx.tds[idx], first.loads):
        for c in _chain([first], more):
            if not tries.left():
                break
            timed = tries.time(fit, idx, c.loads, count)
            if timed is not None:
                return _Best(options=[_option(side, b, idx, c, timed)], fallback=first.loads, total=total,
                             tried=tries.tried)
    return _Best(options=[], fallback=first.loads, total=total, tried=tries.tried)


def _every_place(side: _Side, fit: _Side, b: RetimeBest, idx: int, cands: list[_Cand], tries: _Tries,
                 count: _Count) -> _Best:
    """Each candidate timed (estimate order, within the tries), ranked by _rank_key then the estimate order; the
    best BEST_OPTIONS come back. The fallback is the first candidate."""
    tries.total = len(cands)
    good = []
    for c in cands:
        if not tries.left():
            break
        timed = tries.time(fit, idx, c.loads, count)
        if timed is not None:
            good.append((_rank_key(side, fit, idx, c.loads, timed), c.order, c, timed))
    good.sort(key=lambda g: (g[0], g[1]))
    return _Best(options=[_option(side, b, idx, c, timed) for _k, _o, c, timed in good[:BEST_OPTIONS]],
                 fallback=cands[0].loads, total=len(cands), tried=tries.tried)


def _best_v2(side: _Side, fit: _Side, b: RetimeBest, idx: int, loads: list[tuple[int, ...]], deadline: float,
             count: _Count) -> _Best:
    """Several stops, or a whole load, on one truck (4.3), within RETIME_BEST_TRIES exact timings in all (review F13).

    * Existing load (load_index j): the stops go in one by one, in _placement_order, each at a place chosen without an
      LP (_place_stops); the layout is timed once; if it does not time, the repairs (_repairs) are timed in turn, and
      the first that times is the one option.
    * New load (load_index None): its order is built the same way into an empty load (or, ``keep_order``, is the order
      sent); at ``new_load_at`` it is timed there (then the repairs of its order); otherwise every place of the day is
      timed (after the last load first) and the best 3 come back, ranked as v1.

    ``position`` of an option is best.stop_id's index in its load (0 for a new load). ``side`` is the strict side
    (order, screens, money); ``fit`` the side the timings run on (``side`` itself, or a relaxed side for the relaxed
    best place)."""
    tries = _Tries(best_tries(), deadline)
    ks = [side.pos[sid] for sid in _best_ids(b)]
    if not b.keep_order:
        ks = _placement_order(side, ks)
    k0 = side.pos[b.stop_id]
    if b.load_index is not None:
        j = b.load_index
        placed = _place_stops(side, fit, idx, list(loads), j, ks)
        n, more = _repairs(side, idx, placed, j, ks)
        return _first_that_times(side, fit, b, idx, _Cand(placed, j, None, placed[j].index(k0), 0),
                                 (_Cand(L, j, None, L[j].index(k0), i + 1) for i, L in enumerate(more)), 1 + n, tries, count)
    q0 = b.new_load_at
    at = len(loads) if q0 is None else q0
    n, more = 0, iter(())
    if b.keep_order:
        inner = tuple(ks)
    else:
        placed = _place_stops(side, fit, idx, list(loads[:at]) + [(ks[0],)] + list(loads[at:]), at, ks[1:])
        inner = placed[at]
        if q0 is not None:
            n, more = _repairs(side, idx, placed, at, ks)
    if q0 is not None:
        return _first_that_times(side, fit, b, idx, _Cand(list(loads[:q0]) + [inner] + list(loads[q0:]), None, q0, 0, 0),
                                 (_Cand(L, None, q0, 0, i + 1) for i, L in enumerate(more)), 1 + n, tries, count)
    every = [_Cand(list(loads[:q]) + [inner] + list(loads[q:]), None, q, 0, len(loads) - q)
             for q in range(len(loads), -1, -1)]  # after the last load first: the spare time at the end of the day
    return _every_place(side, fit, b, idx, every, tries, count)


def _chain(*its):
    for it in its:
        yield from it


# --- v2: the relaxed best place (4.6) ----------------------------------------------------------

def _relaxed_best(after: _Side, body: RetimeRequest, idx: int, loads: list[tuple[int, ...]], policy: RetimeRelaxPolicy,
                  deadline: float, count: _Count) -> list[tuple[int, ...]]:
    """The place a best with ``relax`` takes when no place keeps every rule (review F4): the same placement (v2) or the
    same candidates (one stop, v1 shape), timed on a policy-wide relaxed side of the best truck - every stop of its
    loads and the best stops late-soft (``late``), the truck over capacity (``capacity_factor``), no break only when the
    user asked (``seed_no_break``) - and ranked: fewer loads over the planning room, fewer seconds late, money + time
    preferences, the last return, the estimate. Its chosen layout (else its fallback) is what the explicit pipeline
    (_relaxed_answer) then decides on, never the strict fallback."""
    b = body.best
    assert b is not None
    tid = b.truck_id
    late = frozenset(([after.ids[k] for load in loads for k in load] + _best_ids(b)) if policy.late else [])
    rel = _Rel(late=late, over=frozenset([tid]) if policy.capacity_factor is not None else frozenset(),
               factor=policy.capacity_factor, no_break=frozenset([tid]) if tid in policy.seed_no_break else frozenset())
    fit = _relaxed_side(after, rel)
    if _is_v2(b):
        got = _best_v2(after, fit, b, idx, loads, deadline, count)
    else:
        cands = [_Cand(c[5], c[2], c[3], c[4], c[1]) for c in _v1_cands(after, b, idx, loads)]
        got = _every_place(after, fit, b, idx, cands, _Tries(best_tries(), deadline), count)
    return got.options[0][1] if got.options else got.fallback


# ---------------------------------------------------------------------------------------------
# The call
# ---------------------------------------------------------------------------------------------

def _matrix(req: DispatchRequest, stops: list, deadline: float, osrm_client=None) -> MatrixResult:
    cfg = req.config
    return resolve_matrix([(req.depot.lat, req.depot.lng)] + [(s.lat, s.lng) for s in stops], provider=cfg.distance_provider,
                          osrm_url=cfg.osrm_url, haversine_multiplier=cfg.haversine_multiplier,
                          avg_speed_kmh=cfg.avg_speed_kmh, road_time_factor=cfg.road_time_factor,
                          osrm_client=osrm_client, deadline=deadline)


@dataclass
class _Call:
    """What every part of one check shares."""

    body: RetimeRequest
    req: DispatchRequest
    tds: list
    truck_idx: dict[str, int]
    trucks: dict[str, DispatchTruck]
    stop_of: dict[str, DispatchStop]
    union: list
    upos: dict[str, int]
    mx: MatrixResult
    count: _Count
    started: float
    deadline: float
    befores: dict[int, RetimeTruckBefore] = field(default_factory=dict)

    @property
    def edited(self) -> list[str]:
        return [d.truck_id for d in self.body.truck_days]

    def code(self, tid: str) -> str:
        t = self.trucks.get(tid)
        return (t.code or t.id) if t is not None else tid


def _layout(side: _Side, call: _Call, plan: dict[int, list[tuple[int, ...]]]) -> list[RetimeTruckDay]:
    """The edited trucks' explicit layout of ``plan``, in truck_days order (what a save sends as truck_days)."""
    return [RetimeTruckDay(truck_id=tid, loads=[[side.ids[s] for s in load] for load in plan[call.truck_idx[tid]]])
            for tid in call.edited]


def _outs(side: _Side, call: _Call, plan: dict[int, list[tuple[int, ...]]], results: dict[int, _Result]
          ) -> list[RetimeTruckOut]:
    out: list[RetimeTruckOut] = []
    for tid in call.edited:
        idx = call.truck_idx[tid]
        r = results[idx]
        fig = _figures(side, idx, r.timed) if r.feasible else {}
        brk = next((tl.brk for tl in (r.timed or []) if tl.brk is not None), None)
        bf = call.befores.get(idx)
        out.append(RetimeTruckOut(
            truck_id=tid, feasible=r.feasible, violations=r.violations, loads=len(plan[idx]), **fig,
            break_start_min=ds._min_of(brk.start_s) if brk is not None else None, before=bf,
            delta_money_omr=_delta(fig.get("money_omr"), bf.money_omr if bf else None),
            delta_soft_omr=_delta(fig.get("soft_omr"), bf.soft_omr if bf else None),
            delta_km=_delta(fig.get("km"), bf.km if bf else None, 2),
            delta_last_return_min=_delta(fig.get("last_return_min"), bf.last_return_min if bf else None, 0),
            allowed=r.allowed,
        ))
    return out


def _total(trucks: list[RetimeTruckOut], field_name: str, nd: int = 3):
    vals = [getattr(t, field_name) for t in trucks]
    return round(sum(vals), nd) if vals and all(v is not None for v in vals) else None


def _verified(results: dict[int, _Result], sc: DispatchScenario | None) -> bool:
    return (all(r.feasible for r in results.values()) and sc is not None and sc.feasibility is not None
            and sc.feasibility.status == "VERIFIED")


class _OutOfTime(Exception):
    """The deadline passed before the relaxed answer was complete (4.8): ``relaxed`` is None, with a warning."""


def _time_relaxed(side: _Side, call: _Call, plan: dict[int, list[tuple[int, ...]]], results: dict[int, _Result],
                  fail: list[int], rel: _Rel, policy: RetimeRelaxPolicy, *, abort_on_time: bool
                  ) -> tuple[dict[int, _Result], DispatchScenario | None, set[str]]:
    """The trucks of ``fail`` timed once each on a NEW relaxed side of ``side`` (_relaxed_side(rel)); every other truck
    keeps its strict result. The scenario is built on the STRICT side (the real stops, rooms and break rule: a late
    stop has hard_window_ok False, a no-break truck no driver_break - its break_status is then SKIPPED_BY_HAND), and
    the check's violations of the ``fail`` trucks get late_s from the relaxed timetable and are split into allowed and
    remaining (_partition). Returns (results, scenario, the trucks of ``fail`` still untimed)."""
    req = call.req
    rside = _relaxed_side(side, rel)
    out: dict[int, _Result] = {}
    untimed: set[str] = set()
    for idx, r in results.items():
        if idx not in fail:
            out[idx] = _Result(timed=r.timed, shown=r.shown, violations=list(r.violations), no_place=r.no_place)
            continue
        if abort_on_time and time.monotonic() > call.deadline:
            raise _OutOfTime
        td = rside.ctx.tds[idx]
        got = _time(rside, td, plan[idx], call.count)
        out[idx] = _Result(timed=got, shown=got if got is not None else _earliest(rside.ctx.day, td, plan[idx]))
        if got is None:
            untimed.add(td.truck.id)
    exact = all(r.timed is not None for r in out.values())
    sc: DispatchScenario | None = None
    try:
        sc = _scenario(side, req, {idx: r.shown for idx, r in out.items()}, exact, set(plan), call.started)
    except Exception as exc:  # noqa: BLE001 - nothing can be allowed on a timetable that cannot be built
        log.warning("retime run=%s: the relaxed timetable could not be built: %s", req.run_id, exc)
    fail_ids = {side.ctx.tds[idx].truck.id for idx in fail}
    relaxed_timed = fail_ids - untimed
    found = list(sc.feasibility.violations) if sc is not None and sc.feasibility is not None else []
    _set_late_s(side, req, found, [r.shown for r in out.values()])
    allowed, remaining = _partition([v for v in found if v.truck_id in fail_ids], rel, relaxed_timed, untimed, policy,
                                    call.trucks, {tid: call.code(tid) for tid in fail_ids})
    for idx in fail:
        tid = side.ctx.tds[idx].truck.id
        out[idx].violations = remaining.get(tid, [])
        out[idx].allowed = allowed.get(tid, [])
    if sc is not None:
        for d in sc.truck_days:
            if d.truck_id in rel.no_break and d.truck_id in relaxed_timed:
                d.break_status = "SKIPPED_BY_HAND"
        if sc.feasibility is not None:
            rest = [v for r in out.values() for v in r.violations]
            status = sc.feasibility.status
            if status != "UNVERIFIED":
                status = "VERIFIED" if not rest and exact else "VIOLATED"
            sc.feasibility = sc.feasibility.model_copy(update={
                "status": status, "violations": rest, "allowed": [v for r in out.values() for v in r.allowed]})
    return out, sc, untimed


def _relaxed_answer(side: _Side, call: _Call, plan: dict[int, list[tuple[int, ...]]], results: dict[int, _Result],
                    policy: RetimeRelaxPolicy) -> RetimeRelaxed | None:
    """The ONE way a relaxed answer is made (4.6), on the explicit layout ``plan`` of ``side`` (for a best request the
    side is rebuilt from the layout's stop order exactly as an explicit request builds it, so a save of
    ``relaxed.loads`` gets exactly this answer again; review F16). ``results``: that layout timed with every rule
    (judged). None when there is no violation (an UNVERIFIED check), and when an issue that cannot be allowed is
    present (anything but an issue that can be allowed or NO_TIMETABLE, review F17): the change cannot be saved even
    with overrides, and the web shows each issue with why not. Seeds come only from the trucks that fail with every
    rule (a truck that keeps every rule keeps its timetable and is never relaxed): late = every stop of their loads
    (the penalty keeps lateness to what is needed), capacity = those with a CAPACITY_* that can be allowed, no break =
    those whose only problem is the driver break (_own_reasons), plus the trucks of seed_no_break. The solver never
    drops a break on its own (review F5): a truck still untimed whose break is due is probed without it
    (``break_alternative``)."""
    found = [v for r in results.values() for v in r.violations]
    if not found or not all(v.overridable or v.code == "NO_TIMETABLE" for v in found):
        return None
    strict = _outs(side, call, plan, results)
    layout = _layout(side, call, plan)
    by_idx = {call.truck_idx[tid]: tid for tid in call.edited}
    fail = [idx for idx in by_idx if not results[idx].feasible]
    late: set[str] = set()
    over: set[str] = set()
    no_break: set[str] = set()
    for idx in fail:
        tid, r = by_idx[idx], results[idx]
        if policy.late:
            late.update(side.ids[k] for load in plan[idx] for k in load)
        if policy.capacity_factor is not None and any(v.code in _CAPACITY and v.overridable for v in r.violations):
            over.add(tid)
        if LR.break_due(side.ctx.tds[idx]) and ((policy.no_break and r.no_place is not None) or tid in policy.seed_no_break):
            no_break.add(tid)
    rel = _Rel(late=frozenset(late), over=frozenset(over), factor=policy.capacity_factor if over else None,
               no_break=frozenset(no_break))
    if time.monotonic() > call.deadline:
        raise _OutOfTime
    out, rsc, untimed = _time_relaxed(side, call, plan, results, fail, rel, policy, abort_on_time=True)
    alt: list[str] = []
    for idx in fail:
        tid = by_idx[idx]
        if tid not in untimed or tid in no_break or not policy.no_break or not LR.break_due(side.ctx.tds[idx]):
            continue
        if time.monotonic() > call.deadline:
            break  # the probes only run while time remains: the answer is complete without them
        probe = _relaxed_side(side, replace(rel, no_break=rel.no_break | {tid}))
        if _time(probe, probe.ctx.tds[idx], plan[idx], call.count) is not None:
            alt.append(tid)
    trucks = _outs(side, call, plan, out)
    late_ids = {v.stop_id for t in trucks for v in t.allowed if v.code == "HARD_WINDOW"}
    ok = (all(t.feasible for t in trucks) and rsc is not None and rsc.feasibility is not None
          and rsc.feasibility.status == "VERIFIED")
    warnings: list[str] = []
    if rsc is not None and rsc.feasibility is not None and rsc.feasibility.status == "UNVERIFIED":
        warnings.append("The independent timetable check could not run for these trucks: the change cannot be saved now.")
    return RetimeRelaxed(
        ok=ok, loads=layout, strict=strict, trucks=trucks, scenario=rsc,
        relaxations=RetimeRelaxations(
            late_stop_ids=[sid for d in layout for load in d.loads for sid in load if sid in late_ids],
            over_capacity_truck_ids=[t for t in call.edited if t in over], capacity_factor=rel.factor,
            no_break_truck_ids=[t for t in call.edited if t in no_break]),
        delta_money_omr=_total(trucks, "delta_money_omr"), delta_soft_omr=_total(trucks, "delta_soft_omr"),
        delta_km=_total(trucks, "delta_km", 2), break_alternative=alt, warnings=warnings,
    )


def _cand_of(side: _Side, loads: list[tuple[int, ...]], b: RetimeBest) -> _Cand:
    """Where best.stop_id went in ``loads``: an existing load (load_index as sent) or a new load (its place)."""
    k0 = side.pos[b.stop_id]
    j = next(i for i, load in enumerate(loads) if k0 in load)
    if b.load_index is not None:
        return _Cand(loads, b.load_index, None, loads[j].index(k0), 0)
    return _Cand(loads, None, j, 0, 0)


def _relax_phase(call: _Call, after: _Side, plan: dict[int, list[tuple[int, ...]]], results: dict[int, _Result],
                 best: _Best | None, bidx: int, policy: RetimeRelaxPolicy):
    """(relaxed, promoted) of a check with ``relax`` whose strict answer is not ok (4.6). Explicit: the pipeline on the
    call's own layout. Best: the place to decide on - the strict best place when it found one (another edited truck
    fails), else the relaxed best place (never the strict fallback, review F4) - on a side rebuilt from that layout;
    when that layout keeps every rule (the strict search ran out of tries) it is ``promoted`` to the strict answer's
    only option, and nothing needs allowing."""
    body = call.body
    if body.best is None:
        return _relaxed_answer(after, call, plan, results, policy), None
    assert best is not None
    if best.options:
        lay = plan[bidx]
    else:
        lay = _relaxed_best(after, body, bidx, _plan(after, body.truck_days, call.truck_idx)[bidx], policy, call.deadline,
                            call.count)
    layout = [RetimeTruckDay(truck_id=tid, loads=[[after.ids[s] for s in load]
                                                  for load in (lay if call.truck_idx[tid] == bidx else plan[call.truck_idx[tid]])])
              for tid in call.edited]
    if time.monotonic() > call.deadline:
        raise _OutOfTime
    pside = _side(call.req, call.tds, _stop_ids(layout), call.union, call.upos, call.mx)
    pplan = _plan(pside, layout, call.truck_idx)
    pres, psc = _evaluate(pside, call.req, pplan, call.deadline, call.count, call.started, want_scenario=True)
    _judge(pres, psc, policy, call.trucks)
    if not best.options and _verified(pres, psc):
        option = _option(pside, body.best, bidx, _cand_of(pside, pplan[bidx], body.best), pres[bidx].timed or [])
        return None, (pside, pplan, pres, psc, option)
    return _relaxed_answer(pside, call, pplan, pres, policy), None


def _before(call: _Call, before_ids: list[str], strict_deadline: float) -> None:
    """``before`` timed in the same call (v1); and (v2) each truck that fails with every rule while its loads carry
    allowances (``before_relax``) timed again with exactly those (no seed of its own) and partitioned, so a truck
    allowed by hand earlier is feasible when only allowed issues remain, and keeps its money and cost change (4.7)."""
    body, req = call.body, call.req
    if body.before is None:
        return
    bside = _side(req, call.tds, before_ids, call.union, call.upos, call.mx)
    bplan = _plan(bside, body.before, call.truck_idx)
    bres, _ = _evaluate(bside, req, bplan, strict_deadline, call.count, call.started, want_scenario=False)
    br = body.before_relax
    if br is not None:
        rel = _Rel(late=frozenset(br.late_stop_ids), over=frozenset(br.over_capacity_truck_ids), factor=br.capacity_factor,
                   no_break=frozenset(br.no_break_truck_ids))
        tid_of = {call.truck_idx[d.truck_id]: d.truck_id for d in body.before}
        fail = [idx for idx, r in bres.items() if not r.feasible and bplan[idx] and (
            tid_of[idx] in rel.over or tid_of[idx] in rel.no_break
            or any(bside.ids[k] in rel.late for load in bplan[idx] for k in load))]
        if fail:
            policy = RetimeRelaxPolicy(late=bool(rel.late), capacity_factor=rel.factor, no_break=bool(rel.no_break))
            bres = _time_relaxed(bside, call, bplan, bres, fail, rel, policy, abort_on_time=False)[0]
            for idx in fail:
                for v in bres[idx].violations:
                    v.overridable = None  # the current loads are not judged for overrides
    for idx, r in bres.items():
        fig = _figures(bside, idx, r.timed) if r.feasible else {}
        call.befores[idx] = RetimeTruckBefore(feasible=r.feasible, violations=r.violations, loads=len(bplan[idx]),
                                              allowed=r.allowed, **fig)


def retime_truck_days(body: RetimeRequest, *, osrm_client=None) -> RetimeResponse:
    """Re-time the edited truck days of ``body`` exactly (module docstring). Raises RetimeInvalid (422)."""
    started = time.monotonic()
    deadline = started + budget_sec()
    check_request(body)
    # Plan continuity (a stop on another truck than in the version before) is never priced in a move by hand.
    req = body.request.model_copy(update={"config": body.request.config.model_copy(update={"change_penalty_per_stop": 0.0})})
    tds = ds._truck_days(req)
    truck_idx = {t.id: i for i, t in enumerate(req.trucks)}
    stop_of = {s.stop_id: s for s in req.stops}
    best_ids = _best_ids(body.best) if body.best is not None else []
    after_ids = _stop_ids(body.truck_days) + best_ids
    seen = set(after_ids)
    before_ids = _stop_ids(body.before or [])
    union_ids = after_ids + [sid for sid in before_ids if sid not in seen]
    union = [stop_of[sid] for sid in union_ids]
    upos = {sid: k for k, sid in enumerate(union_ids)}
    mx = _matrix(req, union, min(deadline, started + matrix_sec()), osrm_client)
    log.info("retime run=%s matrix provider=%s quality=%s points=%d seconds=%.2f", req.run_id, mx.provider_name,
             mx.quality, len(union) + 1, mx.seconds)
    count = _Count()
    policy = body.relax
    now = time.monotonic()
    # With relax the strict phase gets RELAX_SHARE of the time left after the matrix (4.8); without it, all of it (v1).
    strict_deadline = deadline if policy is None else now + RELAX_SHARE * max(0.0, deadline - now)
    call = _Call(body=body, req=req, tds=tds, truck_idx=truck_idx, trucks={t.id: t for t in req.trucks}, stop_of=stop_of,
                 union=union, upos=upos, mx=mx, count=count, started=started, deadline=deadline)

    after = _side(req, tds, after_ids, union, upos, mx)
    plan = _plan(after, body.truck_days, truck_idx)
    best: _Best | None = None
    bidx = truck_idx[body.best.truck_id] if body.best is not None else -1
    if body.best is not None:
        if _is_v2(body.best):
            best = _best_v2(after, after, body.best, bidx, plan[bidx], strict_deadline, count)
        else:
            best = _best(after, body, bidx, plan[bidx], strict_deadline, count)
        plan[bidx] = best.options[0][1] if best.options else best.fallback
    results, sc = _evaluate(after, req, plan, strict_deadline, count, started, want_scenario=True)
    _judge(results, sc, policy, call.trucks)
    _before(call, before_ids, strict_deadline)
    ok = _verified(results, sc) and (best is None or bool(best.options))

    relaxed: RetimeRelaxed | None = None
    extra: list[str] = []
    if policy is not None and not ok:
        try:
            relaxed, promoted = _relax_phase(call, after, plan, results, best, bidx, policy)
            if promoted is not None:
                assert best is not None
                after, plan, results, sc, option = promoted
                best.options = [option]
                ok = True
        except _OutOfTime:
            extra.append(OUT_OF_TIME_RELAXED)
        except Exception:  # noqa: BLE001 - the answer with every rule stands; nothing is offered to allow by hand
            log.exception("retime run=%s: what can be allowed by hand could not be checked", req.run_id)
            extra.append("What can be allowed by hand could not be checked: try again.")

    trucks = _outs(after, call, plan, results)
    warnings: list[str] = []
    if sc is not None and sc.feasibility is not None and sc.feasibility.status == "UNVERIFIED":
        warnings.append("The independent timetable check could not run for these trucks: the move cannot be saved now.")
    if best is not None and not best.options and best.tried < best.total and time.monotonic() > strict_deadline:
        warnings.append(f"Out of time after {best.tried} of {best.total} places for "
                        f"{'the stop' if len(best_ids) == 1 else 'the stops'}: try again.")
    warnings += extra

    seconds = round(time.monotonic() - started, 3)
    log.info("retime run=%s tenant=%s trucks=%d stops=%d ok=%s relaxed=%s best_stops=%d alt=%d provider=%s timings=%d "
             "seconds=%.2f", req.run_id, req.tenant_id, len(body.truck_days), len(union), ok,
             "-" if relaxed is None else ("ok" if relaxed.ok else "no"), len(best_ids),
             len(relaxed.break_alternative) if relaxed is not None else 0, mx.provider_name, count.timings, seconds)
    return RetimeResponse(
        ok=ok, matrix_provider=after.ctx.mx.provider_name, distance_quality=after.ctx.mx.quality,  # type: ignore[arg-type]
        distance_is_estimated=after.ctx.mx.is_estimated, scenario=sc, trucks=trucks,
        options=[o for o, _ in best.options] if best is not None else [],
        best_total=best.total if best is not None else None, best_tried=best.tried if best is not None else None,
        delta_money_omr=_total(trucks, "delta_money_omr"), delta_soft_omr=_total(trucks, "delta_soft_omr"),
        delta_km=_total(trucks, "delta_km", 2), timings=count.timings, seconds=seconds, warnings=warnings,
        loads=_layout(after, call, plan), relaxed=relaxed,
    )
