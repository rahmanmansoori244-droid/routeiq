"""Exact re-timing of a few truck days for a move by hand (``POST /retime-truck-days``, PR M1).

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
from dataclasses import dataclass, field

import dispatch_solver as ds
import load_repack as LR
from dispatch_models import (
    RETIME_MAX_STOPS,
    RETIME_MAX_TRUCKS,
    DispatchRequest,
    DispatchScenario,
    FeasibilityViolation,
    RetimeOption,
    RetimeRequest,
    RetimeResponse,
    RetimeTruckBefore,
    RetimeTruckDay,
    RetimeTruckOut,
)
from providers import MatrixResult, resolve_matrix

log = logging.getLogger("routeiq.retime")

VERSION = 1
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


def check_request(body: RetimeRequest) -> None:
    """Raise RetimeInvalid when the request names a truck or stop that is not in it, a stop twice, an empty load,
    too many trucks or stops, or a best place that does not fit truck_days."""
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
        if b.stop_id not in stops:
            raise RetimeInvalid(f"Unknown stop {b.stop_id} for the best place: it is not in the request.")
        day = next((d for d in body.truck_days if d.truck_id == b.truck_id), None)
        if day is None:
            raise RetimeInvalid(f"The best place is asked on truck {b.truck_id}, which is not in truck_days.")
        if b.load_index is not None and b.load_index >= len(day.loads):
            raise RetimeInvalid(f"Truck {b.truck_id} has no load {b.load_index + 1} in truck_days for the best place.")
        after.append(b.stop_id)
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
                 count: _Count) -> tuple[list[FeasibilityViolation], bool]:
    """(the reasons found here, whether the independent check of the earliest timetable names the others)."""
    cfg = req.config
    code = td.truck.code or td.truck.id
    if not td.usable:
        if td.trips_left <= 0:
            most = td.truck.max_trips or cfg.max_trips_per_truck
            return [_violation("TRIPS", f"{code} already has {td.n_frozen} locked or dispatched load(s), its most loads "
                                        f"a day ({most}): it takes no new load.", td)], False
        if td.break_note:
            return [_violation("BREAK", td.break_note, td)], False
        return [_violation("TRUCK_AVAILABILITY", f"{code} has no time left for a new load today: ready at "
                                                 f"{ds._hhmm(td.earliest_depart_s // 60)}, back by "
                                                 f"{ds._hhmm(td.latest_return_s // 60)} at the latest.", td)], False
    if _fits(side.ctx.day, td, loads) and LR.break_due(td) and time.monotonic() < deadline:
        relaxed = _relaxed(side, req)
        td0 = relaxed.tds[td.idx]
        if td0.usable:
            count.timings += 1
            if LR.time_truck(relaxed.day, td0, loads, relaxed.rec_pricing) is not None:
                return [_violation("BREAK", f"No place for the driver's {cfg.break_min}-min break (to start "
                                            f"{ds._hhmm(cfg.break_start_from_min)}-{ds._hhmm(cfg.break_start_to_min)}) on "
                                            f"{code} with these stops in this order.", td)], False
    return [], True


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
        own, trust = _own_reasons(side, req, td, plan[idx], deadline, count)
        # The earliest timetable holds no break on purpose: a BREAK the check finds there is not a reason.
        r.violations = own + ([v for v in mine if v.code != "BREAK"] if trust else [])
        if not r.violations:
            r.violations = [_violation("NO_TIMETABLE", f"No timetable keeps every rule for {td.truck.code or td.truck.id} "
                                                       "with these loads in this order.", td)]
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
# Best place
# ---------------------------------------------------------------------------------------------

@dataclass
class _Best:
    options: list[tuple[RetimeOption, list[tuple[int, ...]]]]
    fallback: list[tuple[int, ...]]  # the cheapest estimate's loads (to say why when no place keeps every rule)
    total: int
    tried: int


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
    k = side.pos[b.stop_id]
    node = k + 1
    price = ctx.rec_pricing.trucks.get(idx)
    per_m = (price.per_m + price.tie_m) if price is not None else 0.0
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


# ---------------------------------------------------------------------------------------------
# The call
# ---------------------------------------------------------------------------------------------

def _matrix(req: DispatchRequest, stops: list, deadline: float, osrm_client=None) -> MatrixResult:
    cfg = req.config
    return resolve_matrix([(req.depot.lat, req.depot.lng)] + [(s.lat, s.lng) for s in stops], provider=cfg.distance_provider,
                          osrm_url=cfg.osrm_url, haversine_multiplier=cfg.haversine_multiplier,
                          avg_speed_kmh=cfg.avg_speed_kmh, road_time_factor=cfg.road_time_factor,
                          osrm_client=osrm_client, deadline=deadline)


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
    after_ids = _stop_ids(body.truck_days) + ([body.best.stop_id] if body.best is not None else [])
    seen = set(after_ids)
    before_ids = _stop_ids(body.before or [])
    union_ids = after_ids + [sid for sid in before_ids if sid not in seen]
    union = [stop_of[sid] for sid in union_ids]
    upos = {sid: k for k, sid in enumerate(union_ids)}
    mx = _matrix(req, union, min(deadline, started + matrix_sec()), osrm_client)
    log.info("retime run=%s matrix provider=%s quality=%s points=%d seconds=%.2f", req.run_id, mx.provider_name,
             mx.quality, len(union) + 1, mx.seconds)
    count = _Count()

    after = _side(req, tds, after_ids, union, upos, mx)
    plan = _plan(after, body.truck_days, truck_idx)
    best: _Best | None = None
    if body.best is not None:
        bidx = truck_idx[body.best.truck_id]
        best = _best(after, body, bidx, plan[bidx], deadline, count)
        plan[bidx] = best.options[0][1] if best.options else best.fallback
    results, sc = _evaluate(after, req, plan, deadline, count, started, want_scenario=True)

    befores: dict[int, RetimeTruckBefore] = {}
    if body.before is not None:
        bside = _side(req, tds, before_ids, union, upos, mx)
        bplan = _plan(bside, body.before, truck_idx)
        bres, _ = _evaluate(bside, req, bplan, deadline, count, started, want_scenario=False)
        for idx, r in bres.items():
            fig = _figures(bside, idx, r.timed) if r.feasible else {}
            befores[idx] = RetimeTruckBefore(feasible=r.feasible, violations=r.violations, loads=len(bplan[idx]), **fig)

    trucks: list[RetimeTruckOut] = []
    for d in body.truck_days:
        idx = truck_idx[d.truck_id]
        r = results[idx]
        fig = _figures(after, idx, r.timed) if r.feasible else {}
        brk = next((tl.brk for tl in (r.timed or []) if tl.brk is not None), None)
        bf = befores.get(idx)
        trucks.append(RetimeTruckOut(
            truck_id=d.truck_id, feasible=r.feasible, violations=r.violations, loads=len(plan[idx]), **fig,
            break_start_min=ds._min_of(brk.start_s) if brk is not None else None, before=bf,
            delta_money_omr=_delta(fig.get("money_omr"), bf.money_omr if bf else None),
            delta_soft_omr=_delta(fig.get("soft_omr"), bf.soft_omr if bf else None),
            delta_km=_delta(fig.get("km"), bf.km if bf else None, 2),
            delta_last_return_min=_delta(fig.get("last_return_min"), bf.last_return_min if bf else None, 0),
        ))
    ok = (all(t.feasible for t in trucks) and sc is not None and sc.feasibility is not None
          and sc.feasibility.status == "VERIFIED" and (best is None or bool(best.options)))
    warnings: list[str] = []
    if sc is not None and sc.feasibility is not None and sc.feasibility.status == "UNVERIFIED":
        warnings.append("The independent timetable check could not run for these trucks: the move cannot be saved now.")
    if best is not None and not best.options and best.tried < best.total and time.monotonic() > deadline:
        warnings.append(f"Out of time after {best.tried} of {best.total} places for the stop: try again.")

    def total(field_name: str, nd: int = 3):
        vals = [getattr(t, field_name) for t in trucks]
        return round(sum(vals), nd) if vals and all(v is not None for v in vals) else None

    seconds = round(time.monotonic() - started, 3)
    log.info("retime run=%s tenant=%s trucks=%d stops=%d ok=%s provider=%s timings=%d seconds=%.2f", req.run_id,
             req.tenant_id, len(body.truck_days), len(union), ok, mx.provider_name, count.timings, seconds)
    return RetimeResponse(
        ok=ok, matrix_provider=after.ctx.mx.provider_name, distance_quality=after.ctx.mx.quality,  # type: ignore[arg-type]
        distance_is_estimated=after.ctx.mx.is_estimated, scenario=sc, trucks=trucks,
        options=[o for o, _ in best.options] if best is not None else [],
        best_total=best.total if best is not None else None, best_tried=best.tried if best is not None else None,
        delta_money_omr=total("delta_money_omr"), delta_soft_omr=total("delta_soft_omr"), delta_km=total("delta_km", 2),
        timings=count.timings, seconds=seconds, warnings=warnings,
    )
