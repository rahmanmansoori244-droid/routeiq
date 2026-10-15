"""Small-order delivery economics (DESIGN.md section 3): what a stop of 1-3 cases costs, and whether to serve
it, combine it with another load, move it, or defer it with the customer's agreement.

For every small stop (total cases <= 3; the solver plans stops, so the stop's invoices are listed with it):
- **Fixed-plan removal** (deterministic): the stop is taken out of the baseline plan's load and that load is
  timed again exactly by the engine's own timing (load_repack.time_truck) and priced by its own cost model
  (dispatch_solver._build_scenario -> costing.truck_day_costs). No search runs, so there is no search noise.
  This is also the "drop" comparison: it is shown, never recommended.
- **Combine**: the stop already rides with another stop of its load within ``combine_km`` (straight line).
- **Move**: the cheapest exactly timed insertion of the stop into another existing load or truck
  (load_repack._insertions, each candidate timed with time_truck), and its cash change.
- **Defer**: the day is re-optimized without the stop with the same budget and seeds as the baseline
  (core.solve_seeds): the avoidable cash (mean / min / max over seeds), the knock-on on other stops, and the
  time and capacity freed. The future delivery cost is the cheapest exact insertion into a given next-day
  plan; otherwise a PROXY: today's fixed-plan marginal cost of the same stop, reused.

Evidence from the owner's IVMS truck GPS report and the 13 Oct truck evidence (data/ivms_aggregates.json,
aggregates only) sits next to the plan's numbers: how often customers of the segment get a delivery, how
long small drops really take on site, and the detour's drive minutes at measured truck speeds.

Three kinds of numbers stay in separate columns (owner rules): cash OMR; time and capacity freed; ARTIFICIAL
solver penalties (OMR-equivalent, never money). A margin is used only from DispatchStop.margin or an
explicit, labelled ``margin_per_case`` assumption; otherwise the report gives a break-even margin per case
(with a next-day plan only: against a PROXY future cost it cannot be judged).
Nothing here deletes or changes an order.
"""
from __future__ import annotations

import argparse
import json
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Callable, Iterable, Sequence

import dispatch_solver as ds
import load_repack as LR
from costing import COST_SCALE
from dispatch_models import DispatchRequest, DispatchScenario, DispatchStop
from providers import haversine_km, resolve_matrix

from . import core, history, ivms
from .synth import SERVICE_PER_CASE

SMALL_MAX_CASES = 3  # the owner's small order: 1-3 cases
COMBINE_KM = 2.0  # "combined": another stop of the same load within this straight-line distance
CLEAR_OMR = 0.10  # a cheaper option must save more than this (on every seed) to change a recommendation
PROTECTED_PRIORITIES = (1, 2)  # always served (DESIGN.md section 3)

# Customer types of the synthetic days -> segments of the 13 Oct evidence ("Other delivery customers").
# An assumption on names: GROCERY is general trade (GT_RETAIL), HORECA the non-hotel HORECA segment.
SEGMENT_OF_TYPE = {"HYPERMARKET": "MT_HYPERMARKET", "SUPERMARKET": "MT_SUPERMARKET", "GROCERY": "GT_RETAIL",
                   "HORECA": "HORECA_OTHER", "DARK_STORE": "DARK_STORE"}
SMALL_DROP_BAND = "<50"  # the smallest drop-size band of the chain unloading evidence (cases)

ACTIONS = ("SERVE", "COMBINE", "MOVE", "DEFER_WITH_AGREEMENT", "REVIEW")

LABELS = {
    **core.LABELS,
    "cash_saved": "OMR cash the plan no longer spends without the stop (with - without); positive = saving",
    "move": "OMR cash change if the stop rides on another load instead (moved - now); negative = cheaper",
    "future": "OMR cash of delivering the stop later: NEXT_DAY_PLAN (exact insertion into the given plan) or "
              "PROXY (today's fixed-plan marginal cost of the same stop, reused)",
    "ride_along": "ASSUMPTION: OMR of the stop's extra unloading minutes if it waits for the customer's next "
                  f"regular delivery ({SERVICE_PER_CASE} min per case, the 14 Oct benchmark, x driver_cost_per_hour)",
    "margin": "contribution margin: DispatchStop.margin, or an explicit margin_per_case ASSUMPTION; never invented",
    "break_even": "OMR per case: deferring pays only if the margin lost is below this, (least cash saved - future "
                  f"cost - {CLEAR_OMR}) / cases, the figures the recommendation uses; only with a next-day plan (a "
                  "PROXY future cost gives none)",
    "evidence": "IVMS truck GPS (Feb-Mar 2026) and 13 Oct truck evidence aggregates: context, never cash",
}


def small_stops(req: DispatchRequest, max_cases: int = SMALL_MAX_CASES) -> list[str]:
    """The stops of ``max_cases`` cases or fewer in total, in request order."""
    return [s.stop_id for s in req.stops if s.demand_cases <= max_cases]


# --------------------------------------------------------------------------------------------
# The baseline plan, timed exactly by the engine
# --------------------------------------------------------------------------------------------

def stage(req: DispatchRequest) -> ds._StageCtx:
    """The engine's post-solve context for ``req`` (offline: HAVERSINE), built as optimize_dispatch builds
    it: truck days, prefilter, matrix, window prefilter (the recipe of tests/test_costing.py ``_stage``)."""
    r = core.offline(req)
    tds = ds._truck_days(r)
    solvable, drops, _ = ds._prefilter(r, tds)
    c = r.config
    mx = resolve_matrix([(r.depot.lat, r.depot.lng)] + [(s.lat, s.lng) for s in solvable], provider="HAVERSINE",
                        osrm_url=None, haversine_multiplier=c.haversine_multiplier, avg_speed_kmh=c.avg_speed_kmh,
                        road_time_factor=c.road_time_factor)
    keep, window_drops = ds._window_prefilter(solvable, tds, mx, c)
    if len(keep) != len(solvable):
        solvable, mx = ds._submatrix(solvable, keep, mx)
    return ds._stage_ctx(r, solvable, tds, mx, drops + window_drops)


def _scenario(ctx: ds._StageCtx, timed: LR.TimedPlan) -> DispatchScenario:
    """A timed plan as the engine reports it: loads, truck-day costs, unserved reasons and the independent
    feasibility check (dispatch_solver._build_scenario, the one place a plan becomes a scenario)."""
    return ds._build_scenario(
        "RECOMMENDED", ctx.req, ctx.solvable, ctx.tds, ctx.mx, timed, ctx.values, ctx.use_margin, ctx.drops,
        solver_status="FIXED_PLAN", elapsed=0.0, time_limit=ctx.req.config.time_limit_sec or 1,
        objective_value=LR.score(ctx.day, ctx.rec_pricing, timed).objective, extra_warnings=ctx.value_warnings,
        exact_timing=True)


@dataclass
class Baseline:
    """One plan of a day, timed exactly (load_repack.time_plan) and priced by the engine's cost model.
    ``retimed`` is False when the plan could not be timed again and the engine's own times were kept."""

    ctx: ds._StageCtx
    timed: LR.TimedPlan
    score: LR.Score
    scenario: DispatchScenario
    metrics: core.Metrics
    seed: int | None = None
    retimed: bool = True

    @property
    def request(self) -> DispatchRequest:
        return self.ctx.req

    @classmethod
    def of(cls, ctx: ds._StageCtx, timed: LR.TimedPlan, seed: int | None = None, retimed: bool = True) -> "Baseline":
        sc = _scenario(ctx, timed)
        return cls(ctx=ctx, timed=timed, score=LR.score(ctx.day, ctx.rec_pricing, timed), scenario=sc,
                   metrics=core.metrics(ctx.req, sc), seed=seed, retimed=retimed)

    @classmethod
    def from_run(cls, run: core.RunResult) -> "Baseline":
        """The RECOMMENDED plan of an engine run, on the exact request that run solved."""
        ctx = stage(run.request)
        sc = core._scenario(run.response, "RECOMMENDED")
        raw = ds._timed_from_scenario(sc, ctx.stop_idx, ctx.truck_idx)
        timed = LR.time_plan(ctx.day, LR.plan_of(raw), ctx.rec_pricing)
        return cls.of(ctx, timed if timed is not None else raw, seed=run.seed, retimed=timed is not None)

    @classmethod
    def from_plan(cls, req: DispatchRequest, plan: dict[str, list[list[str]]]) -> "Baseline":
        """A given plan, {truck id: [[stop id, ...] per load, in time order]}, timed exactly. ValueError when
        it breaks a hard rule (capacity, hours, shift, allowed trucks, trips)."""
        ctx = stage(req)
        missing = sorted({sid for loads in plan.values() for load in loads for sid in load} - set(ctx.stop_idx))
        if missing:
            raise ValueError(f"{len(missing)} planned stop(s) are not servable stops of the request")
        idx_plan = {ctx.truck_idx[tid]: [tuple(ctx.stop_idx[sid] for sid in load) for load in loads if load]
                    for tid, loads in plan.items()}
        timed = LR.time_plan(ctx.day, idx_plan, ctx.rec_pricing)
        if timed is None:
            raise ValueError("the plan breaks a hard rule: it cannot be timed")
        return cls.of(ctx, timed)


def _reference(runs: Sequence[core.RunResult]) -> core.RunResult:
    """The run a dispatcher would take: most stops served, then least cash, then the first seed."""
    return min(runs, key=lambda r: (-r.metrics.stops_served, r.metrics.cash.total, r.seed))


# --------------------------------------------------------------------------------------------
# Result records
# --------------------------------------------------------------------------------------------

_CASH_PARTS = ("fixed", "trip", "distance", "fuel", "driver", "overtime", "total")


def _cash_delta(a: core.CashBreakdown, b: core.CashBreakdown) -> core.CashBreakdown:
    """a - b, part by part (OMR)."""
    return core.CashBreakdown(**{p: round(getattr(a, p) - getattr(b, p), 3) for p in _CASH_PARTS})


def _penalty_delta(after: core.Metrics, before: core.Metrics) -> dict[str, float]:
    return {k: round(after.penalties[k] - before.penalties[k], 3) for k in sorted(after.penalties)}


@dataclass(frozen=True)
class Freed:
    """Time and capacity a change frees (positive) or uses (negative). Not cash."""

    paid_driver_min: int  # paid truck-day minutes (driver time, turnarounds and waiting included)
    km: float  # estimated km
    trucks: int
    trips: int
    cases: int
    pallets: float | None  # pallet places (demand_pallet_units / 1000); None when the request has none
    service_min: int  # the stop's planned unloading minutes
    detour_drive_min: float  # the engine's drive minutes of the stop's detour in its load


@dataclass(frozen=True)
class Combine:
    """Whether the stop already rides with a neighbour: the nearest other stop of its load (straight line)."""

    combined: bool
    nearest: str | None
    nearest_km: float | None
    combine_km: float


@dataclass(frozen=True)
class Placement:
    """Where the stop sits (or would sit): anonymous truck label and its load number of the day."""

    truck: str
    load_no: int
    position: int  # 1 = first stop of the load
    load_stops: int


@dataclass(frozen=True)
class FixedPlanEstimate:
    """The stop taken out of the baseline plan, its load timed again exactly. ``feasibility`` is the
    independent check of the plan without it."""

    at: Placement
    cash_saved: core.CashBreakdown
    freed: Freed
    penalty_change: dict[str, float]  # ARTIFICIAL (without - with): the solver's price of leaving it out
    feasibility: str


@dataclass(frozen=True)
class Move:
    """The cheapest exactly timed placement on another load or truck (or, for a stop the plan leaves out,
    anywhere in the plan). ``kind``: EXISTING_LOAD or NEW_LOAD (a trip of its own)."""

    found: bool
    tried: int
    timed_ok: int
    to: Placement | None = None
    kind: str | None = None
    near: str | None = None  # the target load's nearest other stop, and its straight-line km
    near_km: float | None = None
    cash_delta: core.CashBreakdown | None = None  # moved - now
    km_delta: float | None = None  # estimated km
    paid_driver_min_delta: int | None = None
    penalty_delta: dict[str, float] | None = None  # ARTIFICIAL
    feasibility: str | None = None


@dataclass(frozen=True)
class Deferral:
    """The day re-optimized without the stop, paired seed by seed with the baseline runs (equal budget).
    Stats are {mean, min, max[, values]}; savings and freed amounts are baseline - without (positive = saving).

    A seed is like-for-like when its baseline run serves the stop and its run without the stop serves exactly
    the other stops its baseline run serves. Otherwise its cash change is not the cost of serving the stop (that
    baseline left it out, or one search left out stops the other served: search noise, or a day short of
    trucks): it is reported in ``avoidable_cash`` and ``per_seed``, never used for a decision.
    ``avoidable_cash_like_for_like`` holds the like-for-like seeds only (None when there is none).

    Even like-for-like, two time-limited searches differ by more than one small stop costs. ``noise_omr`` is
    that run-to-run spread: the larger cash range over the seeds of the baseline runs and of the runs without
    the stop (None with one seed). ``used`` says whether the re-optimization decides: at least two like-for-like
    seeds whose smallest saving beats the exact fixed-plan estimate by more than the noise (and CLEAR_OMR), i.e.
    a saving the fixed plan cannot show (a trip or truck the day no longer needs). ``note`` says why or why not."""

    seeds: list[int]
    paired: bool
    avoidable_cash: dict  # every seed (core.diff of the summaries)
    avoidable_cash_like_for_like: dict | None
    like_for_like_seeds: list[int]
    noise_omr: float | None
    used: bool
    note: str
    per_seed: list[dict]  # seed, cash_saved, paid_driver_min, km, trucks, trips, dropped, gained, like_for_like
    cash_parts: dict[str, float]  # mean saving per cost part over every seed (OMR)
    freed: dict[str, dict]  # paid_driver_min, km (estimated), trucks_used, trips over every seed
    knock_on: dict  # other stops dropped / gained per seed, and their anonymous labels
    penalty_change: dict[str, dict]  # ARTIFICIAL (without - baseline)
    feasibility: dict[str, int]
    wall_sec: float


@dataclass(frozen=True)
class FutureCost:
    """The cash of delivering the stop later. ``omr`` None: it fits nowhere in the given next-day plan."""

    omr: float | None
    basis: str  # NEXT_DAY_PLAN | PROXY | NONE
    note: str
    ride_along_omr: float  # ASSUMPTION: rides with the customer's next regular delivery (LABELS["ride_along"])


@dataclass(frozen=True)
class Evidence:
    """IVMS / truck-evidence aggregates for this stop (context; never cash)."""

    segment: str
    visit_every_days: dict | None  # days between deliveries of the segment's customers: p25 / p50 / p75, n
    small_drop_on_site_min: dict | None  # time on site of drops under 50 cases (chains, visit-weighted)
    detour_drive_min_at_ivms: dict | None  # the detour's estimated km at measured truck speeds
    basis: dict[str, str] = field(default_factory=dict)


@dataclass(frozen=True)
class StopEconomics:
    """Everything about one small stop; ``action`` with its ``reasons``. Never a deletion."""

    stop: str  # anonymous label
    priority: int
    cases: int
    invoices: int
    late: bool
    committed: bool
    served: bool
    fixed: FixedPlanEstimate | None
    combine: Combine | None
    move: Move | None
    defer: Deferral | None
    future: FutureCost
    margin_omr: float | None
    margin_basis: str | None
    break_even_margin_per_case: float | None
    evidence: Evidence | None
    action: str
    reasons: list[str]


# --------------------------------------------------------------------------------------------
# Plan surgery: removal and insertion, timed exactly
# --------------------------------------------------------------------------------------------

def _locate(timed: LR.TimedPlan, k: int) -> tuple[int, int, int] | None:
    """(truck idx, load j, position i) of stop k in the plan."""
    for idx, loads in timed.items():
        for j, tl in enumerate(loads):
            if k in tl.stops:
                return idx, j, tl.stops.index(k)
    return None


def _without(ctx: ds._StageCtx, timed: LR.TimedPlan, k: int) -> LR.TimedPlan | None:
    """The plan with stop k taken out of its load, that truck timed again (None: it no longer times)."""
    idx, j, i = _locate(timed, k)
    loads = [tl.stops for tl in timed[idx]]
    rest = loads[j][:i] + loads[j][i + 1:]
    new = loads[:j] + ([rest] if rest else []) + loads[j + 1:]
    out = dict(timed)
    if not new:
        del out[idx]
        return out
    t = LR.time_truck(ctx.day, ctx.day.by_idx[idx], new, ctx.rec_pricing)
    if t is None:
        return None
    out[idx] = t
    return out


def _insert(ctx: ds._StageCtx, timed: LR.TimedPlan, k: int,
            skip: Callable[[int, list[LR.Load]], bool] | None = None) -> tuple[LR.TimedPlan | None, int, int, int | None]:
    """The cheapest exactly timed insertion of stop k (cash first, then the artificial soft costs) among every
    option of load_repack._insertions that ``skip`` does not refuse: the three cheapest positions in each load
    of each truck, or a new trip. All of them, as on a tight day only a few may time (about 85 options and
    under a second per stop on a 185-stop day). Returns (plan or None, tried, timed, truck idx)."""
    best: tuple[tuple, LR.TimedPlan, int] | None = None
    tried = ok = 0
    for _, idx, loads in LR._insertions(ctx.day, ctx.rec_pricing, timed, k):
        if skip is not None and skip(idx, loads):
            continue
        tried += 1
        t = LR.time_truck(ctx.day, ctx.day.by_idx[idx], loads, ctx.rec_pricing)
        if t is None:
            continue
        ok += 1
        trial = dict(timed)
        trial[idx] = t
        sc = LR.score(ctx.day, ctx.rec_pricing, trial)
        key = (sc.operating, sc.cost - sc.operating, idx)
        if best is None or key < best[0]:
            best = (key, trial, idx)
    if best is None:
        return None, tried, ok, None
    return best[1], tried, ok, best[2]


def _truck_labels(req: DispatchRequest) -> dict[str, str]:
    """Anonymous truck labels in request order (as history.anonymise labels them)."""
    return {t.id: f"truck-{i:02d}" for i, t in enumerate(req.trucks, start=1)}


def _placement(ctx: ds._StageCtx, timed: LR.TimedPlan, k: int, trucks: dict[str, str]) -> Placement:
    idx, j, i = _locate(timed, k)
    td = ctx.day.by_idx[idx]
    return Placement(truck=trucks[td.truck.id], load_no=td.n_frozen + j + 1, position=i + 1,
                     load_stops=len(timed[idx][j].stops))


def _nearest(ctx: ds._StageCtx, load: Sequence[int], k: int, labels: dict[str, str]) -> tuple[str | None, float | None]:
    s = ctx.solvable[k]
    best = min(((haversine_km(s.lat, s.lng, ctx.solvable[q].lat, ctx.solvable[q].lng), q) for q in load if q != k),
               default=None)
    if best is None:
        return None, None
    return labels[ctx.solvable[best[1]].stop_id], round(best[0], 2)


def _detour(ctx: ds._StageCtx, timed: LR.TimedPlan, k: int) -> tuple[float, float]:
    """(estimated km, drive minutes) of stop k's detour in its load, from the engine's matrix."""
    idx, j, i = _locate(timed, k)
    load = timed[idx][j].stops
    a = load[i - 1] + 1 if i else 0
    b = load[i + 1] + 1 if i + 1 < len(load) else 0
    n, D, T = k + 1, ctx.mx.distance_m, ctx.mx.duration_s
    return (D[a][n] + D[n][b] - D[a][b]) / 1000.0, (T[a][n] + T[n][b] - T[a][b]) / 60.0


def _before(base: Baseline, idxs: Iterable[int]) -> core.Metrics | None:
    """The baseline's metrics to compare a change to trucks ``idxs`` with. A baseline that kept the engine's own
    times (retimed False) gets those trucks timed exactly too, as the changed plan is, so the change is not
    credited with their timing difference. None when one of them does not time exactly."""
    if base.retimed:
        return base.metrics
    ctx = base.ctx
    out = dict(base.timed)
    for idx in set(idxs) & set(out):
        t = LR.time_truck(ctx.day, ctx.day.by_idx[idx], [tl.stops for tl in out[idx]], ctx.rec_pricing)
        if t is None:
            return None
        out[idx] = t
    return core.metrics(ctx.req, _scenario(ctx, out))


def fixed_plan(base: Baseline, stop_id: str) -> FixedPlanEstimate | None:
    """The deterministic removal estimate of one served stop (None when the baseline does not serve it, its
    load no longer times without it, or a baseline with the engine's own times cannot be timed exactly on that
    truck: then no exact estimate exists)."""
    ctx = base.ctx
    k = ctx.stop_idx.get(stop_id)
    loc = _locate(base.timed, k) if k is not None else None
    if loc is None:
        return None
    trucks = _truck_labels(ctx.req)
    without = _without(ctx, base.timed, k)
    before = _before(base, [loc[0]])
    if without is None or before is None:
        return None
    after = core.metrics(ctx.req, _scenario(ctx, without))
    s = ctx.solvable[k]
    km, drive = _detour(ctx, base.timed, k)
    freed = Freed(
        paid_driver_min=before.paid_driver_min - after.paid_driver_min, km=round(before.km - after.km, 2),
        trucks=before.trucks_used - after.trucks_used, trips=before.trips - after.trips,
        cases=s.demand_cases, pallets=s.demand_pallet_units / 1000 if s.demand_pallet_units is not None else None,
        service_min=s.service_min, detour_drive_min=round(drive, 1))
    return FixedPlanEstimate(at=_placement(ctx, base.timed, k, trucks), cash_saved=_cash_delta(before.cash, after.cash),
                             freed=freed, penalty_change=_penalty_delta(after, before), feasibility=after.feasibility)


def combine_check(base: Baseline, stop_id: str, labels: dict[str, str], combine_km: float = COMBINE_KM) -> Combine | None:
    """Does the stop's load serve another stop within ``combine_km`` (straight line)? None if not served."""
    k = base.ctx.stop_idx.get(stop_id)
    loc = _locate(base.timed, k) if k is not None else None
    if loc is None:
        return None
    near, km = _nearest(base.ctx, base.timed[loc[0]][loc[1]].stops, k, labels)
    return Combine(combined=km is not None and km <= combine_km, nearest=near, nearest_km=km, combine_km=combine_km)


def move_check(base: Baseline, stop_id: str, labels: dict[str, str]) -> Move | None:
    """The cheapest exactly timed placement of the stop on another load or truck than its own; for a stop the
    plan leaves out, anywhere in the plan. None when the stop is not servable at all (a prefilter proof); not
    found when nothing times, or a baseline with the engine's own times cannot be timed exactly on the trucks
    the move changes (_before)."""
    ctx = base.ctx
    k = ctx.stop_idx.get(stop_id)
    if k is None:
        return None
    loc = _locate(base.timed, k)
    trucks = _truck_labels(ctx.req)
    if loc is None:
        start, skip = base.timed, None
    else:
        start = _without(ctx, base.timed, k)
        if start is None:
            return Move(found=False, tried=0, timed_ok=0)
        idx0, j0, i0 = loc
        rest0 = base.timed[idx0][j0].stops[:i0] + base.timed[idx0][j0].stops[i0 + 1:]

        def skip(idx: int, loads: list[LR.Load]) -> bool:  # back into its own load = no move
            load = next(l for l in loads if k in l)
            return idx == idx0 and tuple(q for q in load if q != k) == rest0

    plan, tried, ok, idx = _insert(ctx, start, k, skip)
    before = _before(base, [idx] + ([loc[0]] if loc is not None else [])) if plan is not None else None
    if plan is None or before is None:
        return Move(found=False, tried=tried, timed_ok=ok)
    after = core.metrics(ctx.req, _scenario(ctx, plan))
    _, j, _ = _locate(plan, k)
    load = plan[idx][j].stops
    near, km = _nearest(ctx, load, k, labels)
    return Move(found=True, tried=tried, timed_ok=ok, to=_placement(ctx, plan, k, trucks),
                kind="NEW_LOAD" if len(load) == 1 else "EXISTING_LOAD", near=near, near_km=km,
                cash_delta=_cash_delta(after.cash, before.cash), km_delta=round(after.km - before.km, 2),
                paid_driver_min_delta=after.paid_driver_min - before.paid_driver_min,
                penalty_delta=_penalty_delta(after, before), feasibility=after.feasibility)


# --------------------------------------------------------------------------------------------
# Deferral: re-optimization without the stop, and the future delivery cost
# --------------------------------------------------------------------------------------------

def _served(run: core.RunResult) -> set[str]:
    sc = core._scenario(run.response, "RECOMMENDED")
    return {st.stop_id for ld in sc.loads for st in ld.stops}


def _neg(st: dict) -> dict:
    out = {"mean": round(-st["mean"], 4), "min": round(-st["max"], 4), "max": round(-st["min"], 4)}
    if "values" in st:
        out["values"] = [round(-v, 4) for v in st["values"]]
    return out


def _stats(values: list[float]) -> dict:
    return {"mean": round(sum(values) / len(values), 4), "min": min(values), "max": max(values), "values": values}


def without_stop(req: DispatchRequest, stop_id: str) -> DispatchRequest:
    """A copy of the request without one stop (nothing else changes)."""
    return req.model_copy(update={"stops": [s for s in req.stops if s.stop_id != stop_id]}, deep=True)


def per_seed(base_runs: Sequence[core.RunResult], runs: Sequence[core.RunResult], stop_id: str,
             labels: dict[str, str]) -> tuple[list[dict], set[str]]:
    """Seed by seed (seeds both lists have): what the run without the stop saves and frees against the
    baseline run of the same seed, the other stops it drops or gains, and whether that is like-for-like: the
    baseline run serves the stop and both runs serve the same other stops. Also the anonymous labels of every
    other stop served differently."""
    base = {r.seed: r for r in base_runs}
    rows: list[dict] = []
    changed: set[str] = set()
    for r in runs:
        b = base.get(r.seed)
        if b is None:
            continue
        base_served = _served(b)
        before, after = base_served - {stop_id}, _served(r)
        dropped, gained = before - after, after - before
        changed |= dropped | gained
        bm, vm = b.metrics, r.metrics
        rows.append({"seed": r.seed, "cash_saved": round(bm.cash.total - vm.cash.total, 3),
                     "paid_driver_min": bm.paid_driver_min - vm.paid_driver_min, "km": round(bm.km - vm.km, 2),
                     "trucks": bm.trucks_used - vm.trucks_used, "trips": bm.trips - vm.trips,
                     "served_in_baseline": stop_id in base_served, "dropped": len(dropped), "gained": len(gained),
                     "like_for_like": stop_id in base_served and not dropped and not gained})
    return rows, {labels[s] for s in changed}


def _use(like: list[dict], noise: float | None, fixed_saving: float | None) -> tuple[bool, str]:
    """Whether the like-for-like re-optimized savings decide (Deferral.used), and why (not)."""
    if len(like) < 2:
        return False, f"{len(like)} like-for-like seed(s): too few to tell a saving from search noise"
    if noise is None or fixed_saving is None:
        return False, "no noise estimate or no fixed-plan estimate to compare with"
    least = min(x["cash_saved"] for x in like)
    bar = max(noise, CLEAR_OMR)
    if least - fixed_saving > bar:
        return True, (f"every like-for-like seed saves at least {least:.2f} OMR, more than the fixed plan's "
                      f"{fixed_saving:.2f} by over the search noise ({noise:.2f} OMR)")
    return False, (f"like-for-like savings (from {least:.2f} OMR) are within search noise ({noise:.2f} OMR) of the "
                   f"fixed plan's {fixed_saving:.2f}: the exact fixed-plan estimate is used")


def defer(req: DispatchRequest, stop_id: str, budget: core.Budget, base_runs: Sequence[core.RunResult],
          labels: dict[str, str], fixed_saving: float | None = None) -> Deferral:
    """Re-optimize the day without the stop (core.solve_seeds, the baseline's budget) and compare.
    ``fixed_saving``: the stop's exact fixed-plan saving (OMR), the bar a re-optimized saving must beat."""
    runs = core.solve_seeds(without_stop(req, stop_id), budget)
    b, v = core.summarize(list(base_runs)), core.summarize(runs)
    d = core.diff(b, v)["metrics"]

    def stat(key: str) -> dict:
        return d.get(key, {"mean": 0.0, "min": 0.0, "max": 0.0})

    rows, changed = per_seed(base_runs, runs, stop_id, labels)
    like = [x for x in rows if x["like_for_like"]]
    spreads = [s["metrics"]["cash.total"]["max"] - s["metrics"]["cash.total"]["min"] for s in (b, v) if s["runs"] > 1]
    noise = round(max(spreads), 3) if spreads else None
    used, note = _use(like, noise, fixed_saving)
    knock = {"dropped_elsewhere": _stats([float(x["dropped"]) for x in rows]) if rows else None,
             "gained_elsewhere": _stats([float(x["gained"]) for x in rows]) if rows else None,
             "stops": sorted(changed)}
    return Deferral(
        seeds=[r.seed for r in runs], paired=b["seeds"] == v["seeds"], avoidable_cash=_neg(stat("cash.total")),
        avoidable_cash_like_for_like=_stats([x["cash_saved"] for x in like]) if like else None,
        like_for_like_seeds=[x["seed"] for x in like], noise_omr=noise, used=used, note=note, per_seed=rows,
        cash_parts={p: round(-stat(f"cash.{p}")["mean"], 3) for p in _CASH_PARTS if p != "total"},
        freed={k: _neg(stat(k)) for k in ("paid_driver_min", "km", "trucks_used", "trips")},
        knock_on=knock,
        penalty_change={k: stat(f"penalties.{k}") for k in ("unserved_penalty", "window", "early", "continuity")},
        feasibility=v["feasibility"], wall_sec=round(sum(r.wall_sec for r in runs), 2))


def next_day_cost(next_day: Baseline, stop: DispatchStop) -> float | None:
    """Cash (OMR) of adding the stop to a next-day plan: its cheapest exactly timed insertion. None when it
    fits nowhere in that plan (or no truck of that day can ever serve it)."""
    nd = next_day.request
    sid = stop.stop_id if stop.stop_id not in {s.stop_id for s in nd.stops} else f"{stop.stop_id}~deferred"
    extra = stop.model_copy(update={"stop_id": sid, "late": False, "previous_truck_id": None}, deep=True)
    ctx = stage(nd.model_copy(update={"stops": list(nd.stops) + [extra]}, deep=True))
    k = ctx.stop_idx.get(sid)
    if k is None:
        return None
    old = next_day.ctx.solvable
    plan = {idx: [tuple(ctx.stop_idx[old[q].stop_id] for q in tl.stops) for tl in loads]
            for idx, loads in next_day.timed.items()}
    timed = LR.time_plan(ctx.day, plan, ctx.rec_pricing)
    if timed is None:
        return None
    after, _, _, _ = _insert(ctx, timed, k)
    if after is None:
        return None
    before = LR.score(ctx.day, ctx.rec_pricing, timed).operating
    return round((LR.score(ctx.day, ctx.rec_pricing, after).operating - before) / COST_SCALE, 3)


def ride_along_omr(stop: DispatchStop, req: DispatchRequest) -> float:
    """ASSUMPTION: the cash of the stop's cases riding with the customer's next regular delivery: only their
    unloading minutes (SERVICE_PER_CASE per case) at the driver's hourly rate."""
    return round(stop.demand_cases * SERVICE_PER_CASE / 60.0 * req.config.driver_cost_per_hour, 3)


# --------------------------------------------------------------------------------------------
# IVMS / truck-evidence aggregates (the owner's reports, committed as aggregates only)
# --------------------------------------------------------------------------------------------

def default_aggregates() -> dict | None:
    """The committed aggregates (data/ivms_aggregates.json), or None when the file is missing."""
    try:
        return ivms.load()
    except FileNotFoundError:
        return None


def visit_frequency(agg: dict, segment: str) -> dict | None:
    """Days between deliveries of a segment's customers (13 Oct evidence, 'Other delivery customers'); the
    segment 'all' pools every customer."""
    vf = (agg.get("evidence_2026_10_12") or {}).get("visit_frequency") or {}
    row = vf.get("all") if segment == "all" else (vf.get("by_segment") or {}).get(segment)
    if not row or not row.get("days_between_deliveries"):
        return None
    d = row["days_between_deliveries"]
    return {"p25": d.get("p25"), "p50": d.get("p50"), "p75": d.get("p75"), "customers": row.get("customers")}


def _weighted_median(pairs: list[tuple[float, int]]) -> float:
    pairs = sorted(pairs)
    total, seen = sum(n for _, n in pairs), 0
    for v, n in pairs:
        seen += n
        if 2 * seen >= total:
            return v
    return pairs[-1][0]


def small_drop_on_site(agg: dict) -> dict | None:
    """Time on site of drops under 50 cases (the smallest band of the chain unloading evidence): the
    visit-weighted median over chains of each chain's p25 / p50 / p75, chains with enough visits only."""
    rows = (((agg.get("evidence_2026_10_12") or {}).get("chain_unloading") or {}).get("by_drop_size") or [])
    rows = [r for r in rows if r.get("cases") == SMALL_DROP_BAND and (r.get("n_visits") or 0) >= history.MIN_BAND_VISITS]
    if not rows:
        return None
    out = {q: _weighted_median([(r[f"{q}_min"], int(r["n_visits"])) for r in rows]) for q in ("p25", "p50", "p75")}
    return {**out, "chains": len(rows), "visits": int(sum(r["n_visits"] for r in rows))}


def _band(minute: int) -> str:
    hour = (minute // 60) % 24
    for name, lo, hi in ivms.BANDS:
        if (lo <= hour < hi) if lo < hi else (hour >= lo or hour < hi):
            return name
    return ivms.BANDS[-1][0]


def ivms_drive_min(agg: dict, km: float, minute: int) -> dict | None:
    """The detour's estimated km at the IVMS speeds of 5 km+ MOVING segments in the time band of the stop's
    planned service start: minutes at the p50 speed, and at the p75 (fast) and p25 (slow) speeds."""
    speeds = (((agg.get("ivms_raw") or {}).get("travel_speed_kmh") or {}).get("by_band_5km_plus") or {})
    band = _band(minute)
    p = speeds.get(band)
    if not p or not p.get("p25") or km <= 0:
        return None
    return {"band": band, "at_p50": round(km / p["p50"] * 60, 1), "fast_p75": round(km / p["p75"] * 60, 1),
            "slow_p25": round(km / p["p25"] * 60, 1), "speed_kmh_p50": p["p50"], "n": p.get("n")}


def evidence_for(agg: dict | None, segment: str, detour_km: float | None, start_min: int | None) -> Evidence | None:
    """The stop's evidence from the aggregates (None without aggregates)."""
    if not agg:
        return None
    return Evidence(
        segment=segment, visit_every_days=visit_frequency(agg, segment), small_drop_on_site_min=small_drop_on_site(agg),
        detour_drive_min_at_ivms=ivms_drive_min(agg, detour_km, start_min) if detour_km and start_min is not None else None,
        basis={"visit_every_days": "13 Oct truck evidence 'Other delivery customers': delivery dates in September "
                                   "(30 / dates); segment mapping " + ("of the synthetic type" if segment != "all"
                                                                      else "unknown: all customers"),
               "small_drop_on_site_min": "13 Oct evidence 'Claims check' (GPS visits), drops under 50 cases; a "
                                         "broader band than 1-3 cases",
               "detour_drive_min_at_ivms": "IVMS raw report Feb-Mar 2026, MOVING segments of 5 km+, all regions; "
                                           "applied to the engine's estimated km"})


# --------------------------------------------------------------------------------------------
# The recommendation
# --------------------------------------------------------------------------------------------

def _protected(s: DispatchStop, committed: bool) -> list[str]:
    out = []
    if s.priority in PROTECTED_PRIORITIES:
        out.append(f"P{s.priority}: always served")
    if s.late:
        out.append("late order: always served")
    if committed:
        out.append("service commitment: always served")
    return out


def _saving(fixed: FixedPlanEstimate, dfr: Deferral | None) -> tuple[float, float, str]:
    """(mean, min, source) of the cash a deferral saves today: the like-for-like re-optimized seeds when they
    decide (Deferral.used), else the exact fixed-plan estimate."""
    if dfr is not None and dfr.used:
        like = dfr.avoidable_cash_like_for_like
        return like["mean"], like["min"], f"re-optimized without it, {len(like['values'])} like-for-like seeds"
    return fixed.cash_saved.total, fixed.cash_saved.total, "fixed plan"


def _recommend(s: DispatchStop, e: dict) -> tuple[str, list[str]]:
    """SERVE / COMBINE / MOVE / DEFER_WITH_AGREEMENT / REVIEW with plain reasons (e: the stop's figures)."""
    fixed: FixedPlanEstimate | None = e["fixed"]
    combine: Combine | None = e["combine"]
    move: Move | None = e["move"]
    dfr: Deferral | None = e["defer"]
    future: FutureCost = e["future"]
    reasons = _protected(s, e["committed"])
    move_saving = -move.cash_delta.total if move is not None and move.found else None
    move_words = None
    if move_saving is not None:
        where = f"{move.to.truck} load {move.to.load_no}"
        kind = "COMBINE" if move.near_km is not None and move.near_km <= e["combine_km"] else "MOVE"
        near = f" next to {move.near} ({move.near_km} km)" if kind == "COMBINE" else ""
        move_words = (kind, f"on {where}{near} it costs {-move_saving:+.2f} OMR cash against today's placement")

    if not e["served"]:
        if move is not None and move.found:
            return "MOVE", reasons + [f"the plan leaves it out; it fits exactly on {move.to.truck} load {move.to.load_no} "
                                      f"for {move.cash_delta.total:+.2f} OMR cash"]
        why = "no truck can ever serve it today (a proof)" if move is None else "no exactly timed place found in the plan"
        return "REVIEW", reasons + [f"the plan leaves it out: {why}; never deleted, needs a dispatcher's decision"]

    if reasons:
        if fixed is not None:
            reasons.append(f"serving it costs {fixed.cash_saved.total:.2f} OMR cash today (fixed plan)")
        if move_words is not None and move_saving > CLEAR_OMR:
            reasons.append(f"cheaper option while serving it: {move_words[1]}")
        return "SERVE", reasons

    if move_words is not None and move_saving > CLEAR_OMR:
        return move_words[0], [move_words[1]]
    if fixed is None:
        return "SERVE", ["its load no longer times without it, so leaving it out is not an option as planned"]

    saving_mean, saving_min, source = _saving(fixed, dfr)
    if dfr is not None and not dfr.used:
        reasons.append(f"re-optimization not used: {dfr.note}")
    if future.omr is None:
        reasons.append(f"defer saves {saving_mean:.2f} OMR ({source}) but it fits nowhere in the next-day plan")
        return "SERVE", reasons
    lost = e["margin_omr"] or 0.0
    net_min = saving_min - future.omr - lost
    margin_words = f" + margin {lost:.2f}" if e["margin_omr"] is not None else ""
    if net_min > CLEAR_OMR:
        return "DEFER_WITH_AGREEMENT", reasons + [
            f"defer saves {saving_mean:.2f} OMR today ({source}, at least {saving_min:.2f}) against future cost "
            f"{future.omr:.2f} ({future.basis}){margin_words}: net at least {net_min:.2f} OMR"]
    if combine is not None and combine.combined:
        reasons.append(f"already rides with {combine.nearest} ({combine.nearest_km} km) on its load")
    least = f", at least {saving_min:.2f}" if round(saving_min, 2) != round(saving_mean, 2) else ""
    reasons.append(f"defer saves {saving_mean:.2f} OMR ({source}{least}), not clearly more than future cost "
                   f"{future.omr:.2f} ({future.basis}){margin_words}")
    if e["margin_omr"] is None and future.basis == "PROXY":
        reasons.append("no break-even margin: the future cost is a PROXY (today's cost reused), so whether a deferral "
                       "pays cannot be judged without a next-day plan")
    elif e["margin_omr"] is None and e["break_even"] is not None:
        reasons.append(f"break-even margin {e['break_even']:.2f} OMR per case: "
                       + ("deferral pays only below it" if e["break_even"] > 0 else "deferral does not pay at any margin"))
    return "SERVE", reasons


# --------------------------------------------------------------------------------------------
# The analysis and its report
# --------------------------------------------------------------------------------------------

@dataclass
class EconomicsReport:
    """The small-stop economics of one day. Anonymous: stop and truck labels only, no coordinates."""

    source: str  # SYNTHETIC / REAL (anonymised)
    digest: str
    budget: dict
    baseline: dict  # core.summarize of the baseline runs (or the given plan's metrics)
    reference_seed: int | None
    baseline_retimed: bool
    max_cases: int
    combine_km: float
    stops: list[StopEconomics]
    invoices: dict | None  # the invoice-to-stop mapping of small invoices (invoice_cases given)
    assumptions: dict[str, str]
    labels: dict[str, str] = field(default_factory=lambda: dict(LABELS))

    def to_dict(self) -> dict:
        return asdict(self)

    def table(self) -> str:
        """A plain-text table: cash, time/capacity and ARTIFICIAL penalties in separate columns."""
        head = (f"{'stop':<8} {'P':>1} {'cs':>2} {'inv':>3} {'on':<11} | {'cash saved':>10} {'re-opt like-for-like':>28} | "
                f"{'drv min':>7} {'est km':>7} {'pallets':>7} {'plan/IVMS':>9} | {'ARTIF. pen.':>11} | {'comb km':>7} "
                f"{'move OMR':>8} | {'future OMR':>16} {'margin/BE':>12} | action")
        lines = [head, "-" * len(head)]
        for e in self.stops:
            f = e.fixed
            on = f"{f.at.truck}/L{f.at.load_no}" if f else "-"
            cash = f"{f.cash_saved.total:10.2f}" if f else f"{'-':>10}"
            reopt = "-"
            if e.defer is not None:
                a, n = e.defer.avoidable_cash_like_for_like, f"{len(e.defer.like_for_like_seeds)}/{len(e.defer.seeds)}"
                reopt = f"{a['mean']:.2f} [{a['min']:.2f}..{a['max']:.2f}] {n}" if a is not None else f"n/c {n}"
                reopt += "*" if e.defer.used else ""
            drv = f"{f.freed.paid_driver_min:7d}" if f else f"{'-':>7}"
            km = f"{f.freed.km:7.2f}" if f else f"{'-':>7}"
            pal = f"{f.freed.pallets:7.3f}" if f and f.freed.pallets is not None else f"{'-':>7}"
            pen = f"{f.penalty_change['unserved_penalty']:+11.1f}" if f else f"{'-':>11}"
            comb = f"{e.combine.nearest_km:7.2f}" if e.combine and e.combine.nearest_km is not None else f"{'-':>7}"
            mv = f"{e.move.cash_delta.total:+8.2f}" if e.move and e.move.found else f"{'none':>8}"
            fut = f"{e.future.omr:.2f} {e.future.basis}" if e.future.omr is not None else f"- {e.future.basis}"
            if e.margin_omr is not None:
                mg = f"m {e.margin_omr:.2f}"
            elif e.break_even_margin_per_case is not None:
                mg = f"BE {e.break_even_margin_per_case:.2f}/cs"
            elif e.future.basis == "PROXY":
                mg = "BE n/a PROXY"
            else:
                mg = "-"
            lines.append(f"{e.stop:<8} {e.priority:>1} {e.cases:>2} {e.invoices:>3} {on:<11} | {cash} {reopt:>28} | "
                         f"{drv} {km} {pal} {_minutes(e):>9} | {pen} | {comb} {mv} | {fut:>16} {mg:>12} | {e.action}")
        lines += ["", "cash saved: fixed-plan removal (exact). re-opt like-for-like: re-optimized without the stop, mean "
                      "[min..max] over the seeds whose run serves the same other stops, and how many seeds (n/c: none; *: "
                      "beyond search noise, so it decides; OMR cash). "
                      "drv min / est km / pallets: time and capacity freed. plan/IVMS: the stop's unloading + detour drive "
                      "minutes, planned vs IVMS evidence (small-drop time on site p50 + detour at measured p50 speed). "
                      "ARTIF. pen.: the solver's penalty for leaving it out, OMR-equivalent, NOT cash. move OMR: moved - "
                      "now. BE: break-even margin per case (none with a PROXY future cost)."
                      + ("" if self.baseline_retimed else " The baseline kept the engine's own times (it could not be "
                         "timed exactly): every fixed-plan and move figure times the trucks it changes exactly on both "
                         "sides."), ""]
        for e in self.stops:
            lines.append(f"{e.stop} {e.action}: " + "; ".join(e.reasons))
            if e.defer is not None:
                lines.append("  re-opt per seed: " + "; ".join(
                    f"seed {x['seed']} saves {x['cash_saved']:.2f} OMR, frees {x['paid_driver_min']} min / {x['km']:.1f} km"
                    + ("" if x["like_for_like"] else " (NOT like-for-like: " + (
                        f"{x['dropped']} other stop(s) left out, {x['gained']} added)" if x["served_in_baseline"]
                        else "its baseline run did not serve it)")) for x in e.defer.per_seed)
                    + (f"; search noise {e.defer.noise_omr:.2f} OMR" if e.defer.noise_omr is not None else "")
                    + ("; USED" if e.defer.used else "; not used"))
            if e.evidence is not None:
                lines.append(f"  evidence: {_evidence_words(e)}")
        return "\n".join(lines)


def _minutes(e: StopEconomics) -> str:
    """'planned/IVMS' minutes of the stop's visit: unloading + detour drive."""
    f, ev = e.fixed, e.evidence
    if f is None:
        return "-"
    plan = f.freed.service_min + f.freed.detour_drive_min
    on_site = ev.small_drop_on_site_min if ev is not None else None
    if on_site is None:
        return f"{plan:.0f}/-"
    drive = ev.detour_drive_min_at_ivms
    return f"{plan:.0f}/{on_site['p50'] + (drive['at_p50'] if drive else 0.0):.0f}"


def _evidence_words(e: StopEconomics) -> str:
    """The stop's IVMS / truck-evidence context in one line."""
    ev = e.evidence
    out = []
    if ev.visit_every_days is not None:
        v = ev.visit_every_days
        out.append(f"segment {ev.segment} customers get a delivery every {v['p50']:g} days (p25-p75 {v['p25']:g}-"
                   f"{v['p75']:g}, {v['customers']} customers): a deferral could ride with the next one (ride-along "
                   f"{e.future.ride_along_omr:.2f} OMR, ASSUMPTION)")
    if ev.small_drop_on_site_min is not None:
        s = ev.small_drop_on_site_min
        planned = f" (plan {e.fixed.freed.service_min} min)" if e.fixed is not None else ""
        out.append(f"drops under 50 cases take {s['p25']:g}-{s['p75']:g} min on site, p50 {s['p50']:g}{planned}")
    if ev.detour_drive_min_at_ivms is not None and e.fixed is not None:
        d = ev.detour_drive_min_at_ivms
        out.append(f"detour drive {d['at_p50']:g} min at IVMS p50 speed {d['speed_kmh_p50']:g} km/h, band {d['band']} "
                   f"({d['fast_p75']:g}-{d['slow_p25']:g}; plan {e.fixed.freed.detour_drive_min:g} min)")
    return "; ".join(out) if out else "none"


def _invoices(req: DispatchRequest, small: list[str], invoice_cases: dict[str, int] | None, max_cases: int) -> dict | None:
    """Small invoices (max_cases cases or fewer) by where they go: a small stop of their own, or a larger stop
    of the same customer, which they reach without a visit of their own."""
    if invoice_cases is None:
        return None
    stop_of = {o: s.stop_id for s in req.stops for o in s.order_ids}
    tiny = [i for i, c in invoice_cases.items() if c <= max_cases and i in stop_of]
    small_set = set(small)
    own = sum(1 for i in tiny if stop_of[i] in small_set)
    return {"invoices": len(invoice_cases), "small_invoices": len(tiny), "in_small_stops": own,
            "in_larger_stops": len(tiny) - own,
            "note": "a small invoice inside a larger stop adds only its cases and unloading minutes to a visit made "
                    "anyway; only small stops are evaluated here"}


def analyze(req: DispatchRequest, budget: core.Budget, *, max_cases: int = SMALL_MAX_CASES,
            combine_km: float = COMBINE_KM, reoptimize: int | Sequence[str] = 0,
            base_runs: Sequence[core.RunResult] | None = None, base: Baseline | None = None,
            next_day: Baseline | None = None, margin_per_case: float | None = None,
            committed: Iterable[str] = (), customer_type: dict[str, str] | None = None,
            aggregates: dict | None = None, invoice_cases: dict[str, int] | None = None,
            source: str = "SYNTHETIC") -> EconomicsReport:
    """The economics of every small stop of ``req``.

    The baseline is ``base`` (a given plan) or the best of ``base_runs`` (solved with ``budget`` when not
    given). ``reoptimize``: how many small stops (the costliest by fixed-plan cash first) or which stop ids
    get the full re-optimization without them; it needs baseline runs. ``aggregates``: the IVMS / evidence
    aggregates; None loads the committed file, {} uses none. ``customer_type`` (stop id -> synthetic type)
    picks the evidence segment; without it the segment is 'all'. ``invoice_cases`` (invoice id -> cases)
    adds where the small invoices go: their own small stop, or a larger stop of the same customer."""
    if aggregates is None:
        aggregates = default_aggregates()
    committed = set(committed)
    labels = core.label_stops(req)
    want_reopt = bool(reoptimize) if isinstance(reoptimize, int) else bool(list(reoptimize))
    if base is None or (want_reopt and base_runs is None):
        base_runs = list(base_runs) if base_runs is not None else core.solve_seeds(req, budget)
    ref = _reference(base_runs) if base is None else None
    if base is None:
        base = Baseline.from_run(ref)
    by_id = {s.stop_id: s for s in req.stops}
    small = small_stops(req, max_cases)

    figures: dict[str, dict] = {}
    for sid in small:
        s = by_id[sid]
        k = base.ctx.stop_idx.get(sid)
        served = k is not None and _locate(base.timed, k) is not None
        fixed = fixed_plan(base, sid) if served else None
        figures[sid] = {"stop": s, "served": served, "fixed": fixed,
                        "combine": combine_check(base, sid, labels, combine_km) if served else None,
                        "move": move_check(base, sid, labels), "defer": None, "committed": sid in committed,
                        "combine_km": combine_km}

    if isinstance(reoptimize, int):
        ranked = sorted((sid for sid in small if figures[sid]["fixed"] is not None),
                        key=lambda sid: (-figures[sid]["fixed"].cash_saved.total, labels[sid]))
        chosen = ranked[:reoptimize]
    else:
        chosen = [sid for sid in reoptimize if sid in figures and figures[sid]["fixed"] is not None]
    for sid in chosen:
        figures[sid]["defer"] = defer(req, sid, budget, base_runs, labels, figures[sid]["fixed"].cash_saved.total)

    out: list[StopEconomics] = []
    for sid in small:
        e = figures[sid]
        s: DispatchStop = e["stop"]
        fixed: FixedPlanEstimate | None = e["fixed"]
        if next_day is not None:
            omr = next_day_cost(next_day, s)
            future = FutureCost(omr=omr, basis="NEXT_DAY_PLAN", ride_along_omr=ride_along_omr(s, req),
                                note="cheapest exactly timed insertion into the given next-day plan"
                                     if omr is not None else "fits nowhere in the given next-day plan")
        elif fixed is not None:
            future = FutureCost(omr=fixed.cash_saved.total, basis="PROXY", ride_along_omr=ride_along_omr(s, req),
                                note="PROXY: today's fixed-plan marginal cost of the same stop, reused")
        else:
            future = FutureCost(omr=None, basis="NONE", ride_along_omr=ride_along_omr(s, req),
                                note="not served today: no marginal cost to reuse")
        if s.margin is not None:
            margin, basis = round(s.margin, 3), "DispatchStop.margin (from the request)"
        elif margin_per_case is not None:
            margin = round(s.demand_cases * margin_per_case, 3)
            basis = f"ASSUMPTION: {margin_per_case:g} OMR per case (given by the caller)"
        else:
            margin, basis = None, None
        # The margin per case below which deferring pays, from the figures the rule uses (the least saving and
        # CLEAR_OMR, _recommend). None with a PROXY future cost: today's cost reused cannot tell whether it pays.
        saving_min = _saving(fixed, e["defer"])[1] if fixed is not None else None
        break_even = (round((saving_min - future.omr - CLEAR_OMR) / s.demand_cases, 3)
                      if saving_min is not None and future.basis == "NEXT_DAY_PLAN" and future.omr is not None
                      and s.demand_cases > 0 else None)
        e.update(future=future, margin_omr=margin, break_even=break_even)
        action, reasons = _recommend(s, e)
        ctype = (customer_type or {}).get(sid)
        segment = SEGMENT_OF_TYPE.get(ctype, "all") if ctype else "all"
        start = None
        if fixed is not None:
            idx, j, i = _locate(base.timed, base.ctx.stop_idx[sid])
            start = base.timed[idx][j].starts[i] // 60
        out.append(StopEconomics(
            stop=labels[sid], priority=s.priority, cases=s.demand_cases, invoices=len(s.order_ids), late=s.late,
            committed=e["committed"], served=e["served"], fixed=fixed, combine=e["combine"], move=e["move"],
            defer=e["defer"], future=future, margin_omr=margin, margin_basis=basis,
            break_even_margin_per_case=break_even if margin is None else None,
            evidence=evidence_for(aggregates, segment, fixed.freed.km if fixed is not None else None, start),
            action=action, reasons=reasons))

    if base_runs is not None and ref is not None:
        summary = core.summarize(list(base_runs))
    else:
        summary = {"runs": 0, "metrics": base.metrics.flat(), "feasibility": base.metrics.feasibility}
    return EconomicsReport(
        source=source, digest=core.digest(req), budget=asdict(budget), baseline=summary,
        reference_seed=ref.seed if ref is not None else None, baseline_retimed=base.retimed,
        max_cases=max_cases, combine_km=combine_km, stops=out, invoices=_invoices(req, small, invoice_cases, max_cases),
        assumptions={
            "clear_omr": f"{CLEAR_OMR} OMR: a cheaper option must save more than this (re-optimization: on every seed)",
            "combine_km": f"{combine_km} km straight line between stops of one load",
            "segment_of_type": json.dumps(SEGMENT_OF_TYPE),
            "ride_along": LABELS["ride_along"],
            "margin": f"margin_per_case = {margin_per_case}" if margin_per_case is not None
                      else "none given: break-even margins only (stops with DispatchStop.margin use it)",
            "future": "next-day plan given" if next_day is not None else "PROXY (no next-day plan given)",
        })


def analyze_day(day, budget: core.Budget, **kw) -> EconomicsReport:
    """``analyze`` for a synth.SynthDay or a history.RealDay (use RealDay.anonymised() for anything kept)."""
    kw.setdefault("customer_type", getattr(day, "customer_type", None))
    kw.setdefault("source", getattr(day, "label", "SYNTHETIC"))
    kw.setdefault("invoice_cases", getattr(day, "invoice_cases", None))
    return analyze(day.request, budget, **kw)


def main(argv: list[str] | None = None) -> None:
    """Run the economics on a real request (anonymised at once) or a synthetic day; print the table."""
    ap = argparse.ArgumentParser(description="Small-order delivery economics (DESIGN.md section 3)")
    src = ap.add_mutually_exclusive_group(required=True)
    src.add_argument("--request", help="a real request JSON outside the repository (anonymised before use)")
    src.add_argument("--synthetic", type=int, metavar="N_INVOICES", help="a synthetic day of N invoices")
    ap.add_argument("--day-seed", type=int, default=1)
    ap.add_argument("--time", type=int, default=20)
    ap.add_argument("--seeds", default="1,2")
    ap.add_argument("--reopt", type=int, default=0, help="small stops re-optimized without them (costliest first)")
    ap.add_argument("--margin-per-case", type=float, default=None)
    ap.add_argument("--json", help="write the report as JSON here")
    a = ap.parse_args(argv)
    budget = core.Budget(time_limit_sec=a.time, seeds=tuple(int(x) for x in a.seeds.split(",")))
    if a.request:
        day = history.load_real(a.request).anonymised()
    else:
        from .synth import make_day
        day = make_day(a.synthetic, a.day_seed)
    report = analyze_day(day, budget, reoptimize=a.reopt, margin_per_case=a.margin_per_case)
    m = report.baseline["metrics"]
    cash = m["cash.total"]
    print(f"{report.source} digest {report.digest}: {len(day.request.stops)} stops, {len(report.stops)} small; "
          f"budget {a.time} s x seeds {budget.seeds}; baseline cash "
          + (f"{cash['mean']:.2f} OMR [{cash['min']:.2f}..{cash['max']:.2f}]" if isinstance(cash, dict) else f"{cash:.2f} OMR")
          + f"; reference seed {report.reference_seed}")
    if report.invoices is not None:
        i = report.invoices
        print(f"invoices: {i['invoices']}, of which {i['small_invoices']} small: {i['in_small_stops']} in small stops, "
              f"{i['in_larger_stops']} inside larger stops of the same customer (no visit of their own)")
    print(report.table())
    if a.json:
        Path(a.json).write_text(json.dumps(report.to_dict(), indent=1, default=str), encoding="utf-8")


if __name__ == "__main__":
    main()
