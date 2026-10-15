"""The shared run-and-measure layer of the decision-support prototype (DESIGN.md section 1.1).

Every other module runs the dispatch engine through ``solve`` / ``solve_seeds`` and compares plans
through ``metrics`` / ``summarize`` / ``diff``. The engine itself (dispatch_solver.optimize_dispatch) is
not changed.

Three kinds of numbers are kept apart everywhere (owner rules):
- cash: the OMR the plan costs (DispatchScenario.truck_days, built by costing.truck_day_costs);
- ARTIFICIAL penalties: the solver's own prices for leaving a stop out or missing a preferred window.
  They are OMR-equivalent tuning values, never money;
- time and capacity (minutes, trips, trucks), a third column.

Distances come from HAVERSINE estimates (``offline``), so every km here is an "estimated km".
"""
from __future__ import annotations

import hashlib
import json
import os
import time
from dataclasses import asdict, dataclass, field
from pathlib import Path

import dispatch_solver as ds
import load_repack as LR
from dispatch_models import DispatchRequest, DispatchResponse, DispatchScenario, UnservedStop

# What the summaries say about each family of numbers (copied into every summary).
LABELS = {
    "cash": "OMR cash cost of the new loads (costing.truck_day_costs via DispatchScenario.truck_days)",
    "penalties": "ARTIFICIAL: solver penalties in OMR-equivalent (leaving stops out, preferred windows, early "
                 "arrival, plan continuity). Not cash; never add them to cash",
    "km": "estimated km (HAVERSINE: straight line x haversine_multiplier), not road km",
    "time": "minutes, trips and trucks: time and capacity, not cash",
}

# The engine's reason texts that carry a proof (dispatch_solver._prefilter, _window_prefilter,
# _no_room_reason, _not_placed_on_allowed, _shortage_reason, _no_plan_message). The reason codes are a
# database enum, so the engine tells proofs apart only by these words.
_WINDOW_SHIFT_HEAD = "A round trip to this customer does not fit"
_NO_ROOM_HEAD = "Not planned: no load or free trip has room for its"
_SHORTAGE_HEAD = "Fleet capacity shortage"
_OPEN_HEAD = "Not planned: the optimizer found no truck"
_ALLOWED_OPEN = "no such truck had room or time left"
_ALLOWED_NO_ROOM = "no such truck had room ("

# Kinds of unserved stops (proof_kind). The first three are proofs about the stop itself; they make up
# Metrics.proven_impossible. FLEET_SHORTAGE proves only that not every stop of the day fits, not which.
PROVEN_KINDS = ("PREFILTER", "WINDOW", "NO_ROOM")


def proof_kind(u: UnservedStop) -> str:
    """Why a stop is unserved, as a proof class: PREFILTER (no truck can ever carry it: size, allowed
    trucks, no truck or trip left), WINDOW (no truck can reach it inside its hours or shift), NO_ROOM (a
    capacity proof over every packing), FLEET_SHORTAGE (the day as a whole does not fit), TIMING (the exact
    load re-check cut it), HIRE_POLICY (a rented truck is not kept for P4/P5 alone), LATE (a late order),
    NO_PLAN (the search returned no plan at all) or SEARCH (no proof: a longer search or a change could
    serve it)."""
    code, msg = u.reason_code, u.reason_message
    if code in ("EXCEEDS_ANY_TRUCK_CAPACITY", "NO_AVAILABLE_TRUCK", "TRIP_LIMIT"):
        return "PREFILTER"
    if code == "HARD_WINDOW_INFEASIBLE":
        return "WINDOW"
    if code == "SHIFT_LIMIT":
        return "WINDOW" if msg.startswith(_WINDOW_SHIFT_HEAD) else "PREFILTER"
    if code == "NO_ALLOWED_TRUCK":
        if _ALLOWED_OPEN in msg:
            return "SEARCH"
        return "NO_ROOM" if _ALLOWED_NO_ROOM in msg else "PREFILTER"
    if code == "LATE_ORDER_NO_CAPACITY":
        return "LATE"
    if code == "INFEASIBLE":
        return "NO_PLAN"
    if code == "SOLVER_DROPPED_LOW_PRIORITY":
        if msg.startswith(ds.TIMING_DROP_HEAD):
            return "TIMING"
        if msg.startswith(ds.HIRE_DROP_HEAD):
            return "HIRE_POLICY"
        if msg.startswith(_SHORTAGE_HEAD):
            return "FLEET_SHORTAGE"
        if msg.startswith(_NO_ROOM_HEAD):
            return "NO_ROOM"
    return "SEARCH"


@dataclass(frozen=True)
class Budget:
    """Equal compute for every compared run: the same search time, search mode and seeds."""

    time_limit_sec: int = 20
    search_mode: str = "QUICK"
    seeds: tuple[int, ...] = (1, 2, 3)

    def __post_init__(self) -> None:
        if not 1 <= self.time_limit_sec <= 600:
            raise ValueError("time_limit_sec must be 1..600 (DispatchConfig.time_limit_sec)")
        if self.search_mode not in ("QUICK", "THOROUGH"):
            raise ValueError("search_mode must be QUICK or THOROUGH")
        if not self.seeds or any(s < 0 for s in self.seeds) or len(set(self.seeds)) != len(self.seeds):
            raise ValueError("seeds must be distinct non-negative integers, at least one")


def load_request(path: str | os.PathLike) -> DispatchRequest:
    """A DispatchRequest from a JSON file: the raw request, or a wrapper {"request": {...}}."""
    data = json.loads(Path(path).read_text(encoding="utf-8"))
    if isinstance(data, dict) and "request" in data and "stops" not in data:
        data = data["request"]
    return DispatchRequest.model_validate(data)


def offline(req: DispatchRequest) -> DispatchRequest:
    """A copy that never calls OSRM: HAVERSINE distances (estimated km), no OSRM URL."""
    cfg = req.config.model_copy(update={"distance_provider": "HAVERSINE", "osrm_url": None})
    return req.model_copy(update={"config": cfg}, deep=True)


def _rank(seed: int, stop_id: str) -> str:
    return hashlib.sha256(f"{seed}:{stop_id}".encode()).hexdigest()


def seeded(req: DispatchRequest, seed: int) -> DispatchRequest:
    """A copy whose stops are in a deterministic order for ``seed`` (0 = the request's own order).

    OR-Tools routing has no seed of its own; the order of the stops changes its first solution and the
    neighbourhoods it searches, so different seeds explore different plans. Nothing else changes: the
    same stops, trucks and config, so every plan stays a plan for the same day. The order depends only on
    (seed, stop_id), not on the incoming order or the Python version."""
    out = req.model_copy(deep=True)
    if seed:
        out.stops = sorted(out.stops, key=lambda s: _rank(seed, s.stop_id))
    return out


def digest(req: DispatchRequest) -> str:
    """A short fingerprint of a request (16 hex characters of its JSON's SHA-256)."""
    return hashlib.sha256(req.model_dump_json().encode()).hexdigest()[:16]


def label_stops(req: DispatchRequest) -> dict[str, str]:
    """Anonymous labels for committed results: stop id -> "stop-001", ... in sorted stop-id order, so
    the labels do not depend on the order of the stops (seeded requests get the same labels)."""
    return {sid: f"stop-{i:03d}" for i, sid in enumerate(sorted(s.stop_id for s in req.stops), start=1)}


@dataclass(frozen=True)
class CashBreakdown:
    """OMR cash of a plan's new loads, by part (DispatchScenario.truck_days). total = operating_cost."""

    fixed: float = 0.0
    trip: float = 0.0
    distance: float = 0.0
    fuel: float = 0.0
    driver: float = 0.0
    overtime: float = 0.0
    total: float = 0.0


@dataclass
class Metrics:
    """Everything comparable about one scenario. ``cash`` is money; ``penalties`` are ARTIFICIAL
    (OMR-equivalent solver prices, never money); minutes, trucks and trips are time and capacity."""

    status: str
    solver_status: str
    stops_total: int
    stops_served: int
    cases_served: int
    cases_total: int
    served_by_priority: dict[int, int]
    unserved_by_priority: dict[int, int]
    unserved_by_reason: dict[str, int]
    proven_impossible: int  # unserved with a proof about the stop itself: PROVEN_KINDS
    trucks_used: int
    trips: int
    km: float  # estimated km
    cash: CashBreakdown
    penalties: dict[str, float]  # ARTIFICIAL: unserved_penalty, window, early, continuity
    # Planned stops outside the hard windows of the request measured against. The engine never plans one
    # outside its own request's windows; against the request before a lever, it counts the stops the lever made late.
    late_stops: int
    minutes_outside_pref: int  # against the preferred windows of the request measured against
    paid_driver_min: int
    feasibility: str  # VERIFIED / VIOLATED / UNVERIFIED (feasibility.check_scenario)

    def flat(self) -> dict[str, float]:
        """The numeric metrics as one flat dict ("cash.total", "served_by_priority.2", ...)."""
        out: dict[str, float] = {}
        for key, value in asdict(self).items():
            if isinstance(value, dict):
                for sub, v in value.items():
                    out[f"{key}.{sub}"] = float(v)
            elif isinstance(value, (int, float)) and not isinstance(value, bool):
                out[key] = float(value)
        return out


def _scenario(result: DispatchResponse | DispatchScenario, name: str) -> DispatchScenario:
    if isinstance(result, DispatchScenario):
        return result
    for sc in result.scenarios:
        if sc.name == name:
            return sc
    raise ValueError(f"the response has no {name} scenario")


def _outside_pref_min(s, start_min: int, rule: str) -> int:
    lo = s.pref_start_min
    hi_s = LR.pref_end_bound_s(s, rule)
    early = max(0, lo - start_min) if lo is not None else 0
    late = max(0, start_min - hi_s // 60) if hi_s is not None else 0
    return early + late


def _outside_hard(s, start_min: int, rule: str) -> bool:
    """A planned start outside the stop's hard window under the window rule (load_repack.latest_start_s)."""
    return start_min < (s.hard_start_min or 0) or start_min * 60 > LR.latest_start_s(s, rule)


def metrics(req: DispatchRequest, result: DispatchResponse | DispatchScenario, name: str = "RECOMMENDED") -> Metrics:
    """The Metrics of one scenario of ``result`` (RECOMMENDED by default) for ``req``: the request it answers,
    or the same day before a lever (late stops and minutes outside preferred windows then count against the
    windows the day had before the lever moved them)."""
    sc = _scenario(result, name)
    by_id = {s.stop_id: s for s in req.stops}
    served = [st for ld in sc.loads for st in ld.stops]
    served_ids = {st.stop_id for st in served}
    served_by_p = {p: 0 for p in range(1, 6)}
    unserved_by_p = {p: 0 for p in range(1, 6)}
    for s in req.stops:
        (served_by_p if s.stop_id in served_ids else unserved_by_p)[s.priority] += 1
    by_reason: dict[str, int] = {}
    for u in sc.unserved:
        by_reason[u.reason_code] = by_reason.get(u.reason_code, 0) + 1
    td = sc.truck_days
    cash = CashBreakdown(
        fixed=round(sum(d.fixed_cost for d in td), 3), trip=round(sum(d.trip_cost for d in td), 3),
        distance=round(sum(d.distance_cost for d in td), 3), fuel=round(sum(d.fuel_cost for d in td), 3),
        driver=round(sum(d.driver_cost for d in td), 3), overtime=round(sum(d.overtime_cost for d in td), 3),
        total=round(sum(d.total_cost for d in td), 3),
    )
    pp = sc.preference_penalties
    penalties = {
        "unserved_penalty": round(sc.objective.unserved_penalty, 3),
        "window": round(pp.window if pp else sc.objective.window_penalty, 3),
        "early": round(pp.early if pp else 0.0, 3),
        "continuity": round(pp.continuity if pp else 0.0, 3),
    }
    rule = req.config.window_rule
    return Metrics(
        status=sc.status, solver_status=sc.solver_status,
        stops_total=len(req.stops), stops_served=len(served_ids),
        cases_served=sum(by_id[st.stop_id].demand_cases for st in served),
        cases_total=sum(s.demand_cases for s in req.stops),
        served_by_priority=served_by_p, unserved_by_priority=unserved_by_p,
        unserved_by_reason=dict(sorted(by_reason.items())),
        proven_impossible=sum(1 for u in sc.unserved if proof_kind(u) in PROVEN_KINDS),
        trucks_used=sc.trucks_used, trips=sc.trips, km=round(sc.total_distance_km, 2),
        cash=cash, penalties=penalties,
        late_stops=sum(1 for st in served if _outside_hard(by_id[st.stop_id], st.service_start_min, rule)),
        minutes_outside_pref=sum(_outside_pref_min(by_id[st.stop_id], st.service_start_min, rule) for st in served),
        paid_driver_min=sc.paid_driver_min or 0,
        feasibility=sc.feasibility.status if sc.feasibility is not None else "UNVERIFIED",
    )


@dataclass
class RunResult:
    """One engine run: the seed, the fingerprint of the request as given (the same for every seed), the
    exact request solved (seeded, offline, with the budget), the response and its RECOMMENDED metrics."""

    seed: int
    digest: str
    request: DispatchRequest
    response: DispatchResponse
    metrics: Metrics
    wall_sec: float
    env: dict[str, str] = field(default_factory=dict)  # the solver env switches the run had


_ENV_KEYS = ("SOLVER_PARALLEL", "SOLVER_PYVRP", "SOLVER_PYVRP_SEED")


def solve(req: DispatchRequest, budget: Budget, seed: int) -> RunResult:
    """One optimize_dispatch run of ``req`` for ``seed``: offline (HAVERSINE), the budget's search time and
    mode, RECOMMENDED only. Seed s > 0 also sets SOLVER_PYVRP_SEED=s for the run (the second search's own
    seed), then restores it. A caller outside pytest needs an ``if __name__ == "__main__":`` guard, as the
    engine's worker processes are spawned (or SOLVER_PARALLEL=0)."""
    run_req = offline(seeded(req, seed))
    cfg = run_req.config
    cfg.time_limit_sec = budget.time_limit_sec
    cfg.search_mode = budget.search_mode  # type: ignore[assignment]
    cfg.scenarios = ["RECOMMENDED"]
    if budget.search_mode == "THOROUGH":
        cfg.max_search_sec = max(10, budget.time_limit_sec)  # the whole request's cap
    saved = os.environ.get("SOLVER_PYVRP_SEED")
    if seed:
        os.environ["SOLVER_PYVRP_SEED"] = str(seed)
    try:
        env = {k: os.environ[k] for k in _ENV_KEYS if k in os.environ}
        started = time.perf_counter()
        response = ds.optimize_dispatch(run_req)
        wall = time.perf_counter() - started
    finally:
        if saved is None:
            os.environ.pop("SOLVER_PYVRP_SEED", None)
        else:
            os.environ["SOLVER_PYVRP_SEED"] = saved
    return RunResult(seed=seed, digest=digest(req), request=run_req, response=response,
                     metrics=metrics(run_req, response), wall_sec=round(wall, 2), env=env)


def solve_seeds(req: DispatchRequest, budget: Budget) -> list[RunResult]:
    """``solve`` once per seed of the budget, one after the other."""
    return [solve(req, budget, s) for s in budget.seeds]


def _stats(values: list[float]) -> dict:
    return {"mean": round(sum(values) / len(values), 4), "min": round(min(values), 4), "max": round(max(values), 4),
            "values": [round(v, 4) for v in values]}


def _counts(items: list[str]) -> dict[str, int]:
    out: dict[str, int] = {}
    for x in items:
        out[x] = out.get(x, 0) + 1
    return dict(sorted(out.items()))


def summarize(results: list[RunResult]) -> dict:
    """Mean / min / max of every numeric metric over the runs (one per seed), with the per-seed values in
    seed order. A key missing from a run (an unserved reason it did not have) counts as 0 there. Status,
    solver status and feasibility are counted. No stop or customer ids are in it."""
    if not results:
        raise ValueError("nothing to summarize")
    flats = [r.metrics.flat() for r in results]
    keys = sorted(set().union(*flats))
    digests = sorted({r.digest for r in results})
    return {
        "runs": len(results),
        "seeds": [r.seed for r in results],
        "digest": digests[0] if len(digests) == 1 else digests,
        "metrics": {k: _stats([f.get(k, 0.0) for f in flats]) for k in keys},
        "status": _counts([r.metrics.status for r in results]),
        "solver_status": _counts([r.metrics.solver_status for r in results]),
        "feasibility": _counts([r.metrics.feasibility for r in results]),
        "wall_sec": _stats([r.wall_sec for r in results]),
        "labels": dict(LABELS),
    }


def diff(base: dict, variant: dict) -> dict:
    """variant - base for every metric of two summaries. With the same seeds in the same order the
    deltas are paired per seed (min / max over the seeds' own deltas); otherwise min / max are the
    widest possible range (variant.min - base.max .. variant.max - base.min)."""
    paired = base["seeds"] == variant["seeds"]
    out: dict[str, dict] = {}
    for k in sorted(set(base["metrics"]) | set(variant["metrics"])):
        n_b, n_v = len(base["seeds"]), len(variant["seeds"])
        b = base["metrics"].get(k) or {"mean": 0.0, "min": 0.0, "max": 0.0, "values": [0.0] * n_b}
        v = variant["metrics"].get(k) or {"mean": 0.0, "min": 0.0, "max": 0.0, "values": [0.0] * n_v}
        if paired:
            d = [round(y - x, 4) for x, y in zip(b["values"], v["values"])]
            out[k] = {"mean": round(sum(d) / len(d), 4), "min": min(d), "max": max(d), "values": d}
        else:
            out[k] = {"mean": round(v["mean"] - b["mean"], 4), "min": round(v["min"] - b["max"], 4),
                      "max": round(v["max"] - b["min"], 4)}
    return {"paired": paired, "seeds": variant["seeds"], "metrics": out, "labels": dict(LABELS)}
