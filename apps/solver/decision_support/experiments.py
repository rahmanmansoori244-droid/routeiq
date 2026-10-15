"""The evidence suite (DESIGN.md sections 1 and 6): experiments E1-E6, run on the codespace.

    python -m decision_support.experiments {e1,e2,e3,e4,e5,e6,all} [--lane i/n] [--quick] [--report] [...]

- E1 what-if levers, E2 small-stop economics, E3 dynamic re-planning policies, E4 verdicts, ranked relaxations
  and the trade-off frontier, E5 the exact oracle against the engine. Each one runs its module's own functions.
  ``all`` runs these five.
- E6 the engine's behaviour at production settings: all three plan options in one response, worker processes and
  the second route search, THOROUGH (PROD) and QUICK (QUICKP), several seeds and days, and how far a plan moves
  after a small change of the day (perturbations). E6 is not equal compute; it sets its own solver switches.
- Every solve is cached as one JSON file under --cache-dir (default ~/ds-runs), keyed by git commit, experiment,
  day, variant, budget and seed. A lane that is stopped and started again reads back what it already solved.
- ``--lane i/n`` takes every n-th item of each run list, starting at item i. A lane that has finished its own
  items helps with any item no live lane has claimed. A solve that several items need (a baseline) is solved
  once: the other lanes wait for it.
- ``--report`` solves nothing. It rebuilds every experiment from the cache through the modules' own report
  code and writes one JSON (aggregates only) and one Markdown file per experiment, plus INDEX.md, to --out-dir.

Equal compute (E1-E5): every compared run has the same Budget, runs in-process (SOLVER_PARALLEL=0, one solve at a
time per lane) and without the second route search (SOLVER_PYVRP=off).

Real days are anonymised as soon as they are read, and every output is checked against their original ids and
coordinates before it is written. The cache holds anonymised requests with coordinates, so it stays outside the
repository, like ~/ds-data.
"""
from __future__ import annotations

import argparse
import contextlib
import hashlib
import json
import logging
import math
import os
import platform
import re
import socket
import statistics
import subprocess
import sys
import time
import traceback
from collections import Counter
from collections.abc import Callable, Iterable, Iterator
from dataclasses import asdict, dataclass, field, replace
from datetime import datetime, timezone
from pathlib import Path

import dispatch_solver as ds
from dispatch_models import DAY_MIN, DispatchRequest, DispatchResponse, DispatchScenario, DispatchTruck

from . import core, dynamic, economics, exact, explain, history, ivms, synth, whatif
from .core import Budget, RunResult

REPO = Path(__file__).resolve().parents[3]
DEFAULT_OUT = REPO / "docs" / "decision-support" / "results"
DEFAULT_CACHE = Path.home() / "ds-runs"
DEFAULT_DATA = Path.home() / "ds-data"
REAL_FILES = {"REAL-15OCT": "day-2026-10-15-v1-request.json", "REAL-15OCT-PREFIX": "day-2026-10-15-failed-request.json"}
SYNTH_DAYS = {"SYNTH-320": (320, 1), "SYNTH-400": (400, 2), "SYNTH-320-TIGHT": (320, 1),
              "SYNTH-320-S2": (320, 2), "SYNTH-400-S3": (400, 3)}  # (invoices, synth seed)
TIGHT_MIN = 60  # E4's tight day: hypermarket windows close this much earlier
ENV = {"SOLVER_PARALLEL": "0", "SOLVER_PYVRP": "off"}
EQUAL_COMPUTE = ("Every compared run has the same budget (search seconds, QUICK, RECOMMENDED only) and runs alone in "
                 "its lane's process (SOLVER_PARALLEL=0). Production also runs the second route search (PyVRP); it is "
                 "off here (SOLVER_PYVRP=off) so that every run gets the same single-core search.")
HONESTY = ("Distances are HAVERSINE estimates (estimated km). Plans are the best found in the time given, not proven "
           "optimal; only E5's oracle proves optimality, on the instances it enumerates completely. Cash is OMR "
           "(costing.truck_day_costs); solver penalties are ARTIFICIAL and never added to cash.")
NO_PROVENANCE = ("No real window has a provenance label today (RouteIQ records none), so every real window is UNKNOWN. "
                 "The window levers on a real day are HYPOTHETICAL: they show what flexing would do if those windows "
                 "turned out to be sales preferences.")
POLL_SEC = 3.0
_ENGINE_SOLVE = core.solve
_ENGINE_SOLVE_AS = explain._solve_as
_LONG_DECIMAL = re.compile(r"\d+\.\d{4,}")


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _say(msg: str) -> None:
    print(f"{time.strftime('%H:%M:%S')} {msg}", file=sys.stderr, flush=True)


def _slug(text: str) -> str:
    return re.sub(r"[^A-Za-z0-9+=.-]+", "_", text).strip("_")[:100]


def _tag(budget: Budget) -> str:
    return f"{budget.time_limit_sec}s-{budget.search_mode}"


def _recommended(run: RunResult) -> DispatchScenario:
    return next(sc for sc in run.response.scenarios if sc.name == "RECOMMENDED")


# ------------------------------------------------------------------------------------------------------------
# Settings and days
# ------------------------------------------------------------------------------------------------------------

@dataclass(frozen=True)
class Suite:
    """The settings of one invocation. Budgets are search seconds per run; the engine's load re-check comes on
    top. ``quick``: tiny smoke settings (2 s searches, 2 seeds, a few levers, one world, 4 small instances; E6:
    one seed, a 20 s THOROUGH cap, 2 s QUICK, three days). E6: ``e6_seeds`` for every variant and day, except
    PROD on a real day, which takes ``e6_real_prod_seeds`` (a 20-minute run each); ``prod_cap`` lowers the
    THOROUGH cap (production: the request's max_search_sec, 1,200 s)."""

    budget_real: int = 20
    budget_synth: int = 40
    budget_replan: int = 10
    budget_exact: int = 3
    seeds: tuple[int, ...] = (1, 2, 3)
    quick: bool = False
    e5_instances: int = 100
    data_dir: Path = DEFAULT_DATA
    e6_seeds: tuple[int, ...] = (1, 2, 3, 4, 5)
    e6_real_prod_seeds: tuple[int, ...] = (1, 2, 3)
    prod_cap: int = ds.THOROUGH_MAX_SEC

    @classmethod
    def smoke(cls, data_dir: Path = DEFAULT_DATA) -> "Suite":
        return cls(budget_real=2, budget_synth=2, budget_replan=2, budget_exact=2, seeds=(1, 2), quick=True,
                   e5_instances=4, data_dir=data_dir, e6_seeds=(1,), e6_real_prod_seeds=(1,), prod_cap=20)

    def budget(self, real: bool) -> Budget:
        return Budget(time_limit_sec=self.budget_real if real else self.budget_synth, seeds=self.seeds)


@dataclass(frozen=True)
class Day:
    """One day of the suite: a synth.SynthDay or an anonymised history.RealDay."""

    name: str
    kind: str  # SYNTHETIC or REAL
    data: object

    @property
    def real(self) -> bool:
        return self.kind == "REAL"

    @property
    def request(self) -> DispatchRequest:
        return self.data.request  # type: ignore[attr-defined]

    def describe(self) -> str:
        what = "REAL, anonymised" if self.real else self.data.label  # type: ignore[attr-defined]
        return f"{what}; {len(self.request.stops)} stops, {len(self.request.trucks)} trucks"


def tighten(day: synth.SynthDay, minutes: int = TIGHT_MIN) -> synth.SynthDay:
    """E4's tight day: every hypermarket window closes ``minutes`` earlier. A harder day, not a relaxation."""
    req = day.request.model_copy(deep=True)
    for s in req.stops:
        if day.customer_type.get(s.stop_id) == "HYPERMARKET" and s.hard_end_min is not None:
            s.hard_end_min = max(s.hard_start_min or 0, s.hard_end_min - minutes)
    return replace(day, request=req, label=f"SYNTHETIC tight (hypermarket windows close {minutes} min earlier)")


class Days:
    """Every day of the suite, built once per process. A real day is anonymised as soon as it is read; its
    original ids and coordinates are kept only for the leak check of the outputs. A missing real file gives None."""

    def __init__(self, data_dir: Path) -> None:
        self.data_dir = Path(data_dir).expanduser()
        self.secrets: set[str] = set()
        self.coords: set[str] = set()
        self._memo: dict[str, object] = {}

    def _remember(self, req: DispatchRequest) -> None:
        self.secrets |= {req.run_id, req.tenant_id, req.depot.id}
        for s in req.stops:
            self.secrets |= {s.stop_id, s.customer_id, *s.order_ids}
            self.coords |= {f"{s.lat:.4f}", f"{s.lng:.4f}"}
        for t in req.trucks:
            self.secrets.add(t.id)
            if len(t.code) >= 5 and any(c.isdigit() for c in t.code):  # plates; short model words are not ids
                self.secrets.add(t.code)
        self.coords |= {f"{req.depot.lat:.4f}", f"{req.depot.lng:.4f}"}
        self.secrets.discard("")

    def why(self, name: str) -> str:
        return f"{REAL_FILES[name]} not found in {self.data_dir.name}/: skipped"

    def get(self, name: str) -> Day | None:
        if name not in self._memo:
            self._memo[name] = self._load(name)
        return self._memo[name]  # type: ignore[return-value]

    def _load(self, name: str) -> Day | None:
        if name in REAL_FILES:
            path = self.data_dir / REAL_FILES[name]
            if not path.is_file():
                return None
            raw = history.load_real(path)
            self._remember(raw.request)
            return Day(name, "REAL", raw.anonymised())
        n, seed = SYNTH_DAYS[name]
        day = synth.make_day(n, seed)
        return Day(name, "SYNTHETIC", tighten(day) if name.endswith("-TIGHT") else day)

    def hire_options(self) -> tuple[DispatchTruck, ...]:
        """E4: the trucks REAL-15OCT had and the pre-fix request lacks (the trucks hired that day), as anonymous
        hire options (the explain CLI's --hire-from)."""
        if "hire" not in self._memo:
            v1, prefix = (self.data_dir / REAL_FILES[n] for n in ("REAL-15OCT", "REAL-15OCT-PREFIX"))
            options: tuple[DispatchTruck, ...] = ()
            if v1.is_file() and prefix.is_file():
                self.get("REAL-15OCT")  # its ids join the leak check
                options = explain._hire_options(str(v1), {t.id for t in core.load_request(prefix).trucks})
            self._memo["hire"] = options
        return self._memo["hire"]  # type: ignore[return-value]

    def dynamic_case(self) -> tuple[DispatchRequest, tuple[dynamic.NewOrder, ...]]:
        """E3's synthetic day: 280 invoices (seed 1), 15 of them late orders revealed 08:30-13:00."""
        if "dynamic" not in self._memo:
            self._memo["dynamic"] = dynamic.synthetic_case(280, 1, n_new=15)
        return self._memo["dynamic"]  # type: ignore[return-value]


# ------------------------------------------------------------------------------------------------------------
# The run cache
# ------------------------------------------------------------------------------------------------------------

class MissingRun(LookupError):
    """A report needs a run the cache does not hold (yet)."""


_BOOT_ID = Path("/proc/sys/kernel/random/boot_id")


def _owner() -> dict:
    boot = _BOOT_ID.read_text().strip() if _BOOT_ID.exists() else ""
    return {"host": socket.gethostname(), "boot": boot, "pid": os.getpid(), "since": _now()}


def _stale(lock: Path) -> bool:
    """A lock whose process has gone (same machine and boot; Linux), or that never got its owner written."""
    try:
        owner = json.loads(lock.read_text(encoding="utf-8") or "{}")
    except (OSError, ValueError):
        owner = {}
    if not owner:
        return time.time() - lock.stat().st_mtime > 60 if lock.exists() else True
    me = _owner()
    if owner.get("host") != me["host"] or owner.get("boot") != me["boot"]:
        return True
    return bool(me["boot"]) and not Path(f"/proc/{owner.get('pid')}").exists()


def _try_lock(lock: Path) -> bool:
    """Create ``lock`` for this process; False when a live process holds it. A stale lock is taken over."""
    lock.parent.mkdir(parents=True, exist_ok=True)
    for _ in range(2):
        try:
            fd = os.open(lock, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
        except FileExistsError:
            if _stale(lock):
                lock.unlink(missing_ok=True)
                continue
            return False
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(_owner(), f)
        return True
    return False


def _write_json(path: Path, data: dict) -> None:
    """Atomic: a reader never sees half a file."""
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(f"{path.name}.{os.getpid()}.tmp")
    tmp.write_text(json.dumps(data), encoding="utf-8")
    os.replace(tmp, path)


@contextlib.contextmanager
def _warm_start(loads: list) -> Iterator[dict]:
    """The next RECOMMENDED search starts from ``loads``: dispatch_solver._solve_scenario's own warm_start
    (the engine uses it for its alternative scenarios), given once, in-process (SOLVER_PARALLEL=0). The engine
    falls back to a cold search when it cannot load the plan; ``report["cold"]`` then turns True."""
    original = ds._solve_scenario
    report = {"injected": False, "cold": False}

    def solve_scenario(name, req, stops, tds, mx, time_limit, pre_drops, warm_start=None):
        if name == "RECOMMENDED" and warm_start is None and not report["injected"]:
            report["injected"], warm_start = True, loads
        return original(name, req, stops, tds, mx, time_limit, pre_drops, warm_start)

    class _Cold(logging.Handler):
        def emit(self, record: logging.LogRecord) -> None:
            if "warm start gave no solution" in record.getMessage():
                report["cold"] = True

    logger, handler = logging.getLogger("routeiq.dispatch"), _Cold()
    level = logger.level
    logger.addHandler(handler)
    logger.setLevel(logging.INFO)
    ds._solve_scenario = solve_scenario
    try:
        yield report
    finally:
        ds._solve_scenario = original
        logger.removeHandler(handler)
        logger.setLevel(level)


@dataclass(frozen=True)
class Item:
    """One unit of a run list: one solve (E1, E2, E4, E5) or one simulated day (E3)."""

    experiment: str
    day: str
    variant: str
    seed: int
    budget: str  # the budget tag: a quick run never counts for a full one

    @property
    def key(self) -> str:
        return f"{self.experiment}/{self.day}/{self.variant}/s{self.seed}/{self.budget}"


class RunCache:
    """Every solve as one JSON file, <cache>/<commit>/<experiment>/<day>/<variant>/<budget>[-scenario][-warm]-s<seed>.json,
    holding the anonymised request solved, the engine's response, its wall time and the solver switches.

    Inside ``hooked()``, core.solve and explain._solve_as go through ``solve`` / ``solve_as``: a cached run is
    read back; a missing one is solved and stored, or raises MissingRun when read-only. A ``.lock`` next to a
    run being solved makes another lane wait for it. ``scope`` names the experiment, the day and the variants
    (by core.digest of their requests; any other request, an E3 re-plan for one, is filed as req-<digest>)."""

    def __init__(self, root: Path, commit: str, *, read_only: bool = False) -> None:
        self.dir = Path(root).expanduser() / commit
        self.commit = commit
        self.read_only = read_only
        self.last: dict = {}  # the stored fields of the last run read or written (warm_used, wall_sec, ...)
        self._where = ("", "")
        self._names: dict[str, str] = {}
        self._warm: RunResult | None = None

    @contextlib.contextmanager
    def hooked(self) -> Iterator["RunCache"]:
        saved = core.solve, explain._solve_as
        core.solve, explain._solve_as = self.solve, self.solve_as
        try:
            yield self
        finally:
            core.solve, explain._solve_as = saved

    @contextlib.contextmanager
    def scope(self, experiment: str, day: str, names: dict[str, str]) -> Iterator[None]:
        saved = self._where, self._names
        self._where, self._names = (experiment, day), names
        try:
            yield
        finally:
            self._where, self._names = saved

    @contextlib.contextmanager
    def warm_from(self, base: RunResult) -> Iterator[None]:
        """Runs solved inside start their search from ``base``'s plan (filed with -warm)."""
        saved, self._warm = self._warm, base
        try:
            yield
        finally:
            self._warm = saved

    def path(self, req: DispatchRequest, budget: Budget, seed: int, scenario: str = "RECOMMENDED") -> Path:
        tag = _tag(budget) + ("" if scenario == "RECOMMENDED" else f"-{scenario}") + ("-warm" if self._warm else "")
        return self._file(req, tag, seed)

    def _file(self, req: DispatchRequest, tag: str, seed: int) -> Path:
        experiment, day = self._where
        d = core.digest(req)
        return self.dir / experiment / day / _slug(self._names.get(d, f"req-{d}")) / f"{tag}-s{seed}.json"

    def solve(self, req: DispatchRequest, budget: Budget, seed: int) -> RunResult:
        return self._run(req, budget, seed, "RECOMMENDED")

    def solve_as(self, req: DispatchRequest, budget: Budget, seed: int, scenario: str) -> RunResult:
        return self._run(req, budget, seed, scenario)

    def solve_setting(self, req: DispatchRequest, setting: "Setting", seed: int) -> RunResult:
        """E6: one run of ``req`` at ``setting`` (solve_setting: all three plan options), filed as
        <variant>/<setting tag>-s<seed>.json. Its RunResult's metrics are RECOMMENDED's."""
        path = self._file(req, setting.tag, seed)

        def solve() -> RunResult:
            run = _ENGINE_SETTING(req, setting, seed)
            self._store(path, req, run, seed, "RECOMMENDED", {"setting": asdict(setting), "options": list(OPTIONS)},
                        None)
            return run

        return self._get(path, req, seed, "RECOMMENDED", solve)

    def _run(self, req: DispatchRequest, budget: Budget, seed: int, scenario: str) -> RunResult:
        path = self.path(req, budget, seed, scenario)
        return self._get(path, req, seed, scenario, lambda: self._solve(path, req, budget, seed, scenario))

    def _get(self, path: Path, req: DispatchRequest, seed: int, scenario: str, solve: Callable[[], RunResult]) -> RunResult:
        """The run filed at ``path``: read back, or solved under its lock (another lane holding the lock is
        waited for), or MissingRun when read-only."""
        lock = path.with_name(path.name + ".lock")
        waited = 0.0
        while True:
            run = self._read(path, req, seed, scenario)
            if run is not None:
                return run
            if self.read_only:
                raise MissingRun(str(path.relative_to(self.dir)))
            if _try_lock(lock):
                try:
                    run = self._read(path, req, seed, scenario) or solve()
                finally:
                    lock.unlink(missing_ok=True)
                return run
            if waited % 60 < POLL_SEC:
                _say(f"waiting for another lane to finish {path.relative_to(self.dir)}")
            time.sleep(POLL_SEC)
            waited += POLL_SEC

    def _solve(self, path: Path, req: DispatchRequest, budget: Budget, seed: int, scenario: str) -> RunResult:
        def call() -> RunResult:
            if scenario == "RECOMMENDED":
                return _ENGINE_SOLVE(req, budget, seed)
            return _ENGINE_SOLVE_AS(req, budget, seed, scenario)

        warm_used = None
        if self._warm is None:
            run = call()
        else:
            with _warm_start(_recommended(self._warm).loads) as w:
                run = call()
            warm_used = w["injected"] and not w["cold"]
        self._store(path, req, run, seed, scenario,
                    {"budget": {"time_limit_sec": budget.time_limit_sec, "search_mode": budget.search_mode}}, warm_used)
        return run

    def _store(self, path: Path, req: DispatchRequest, run: RunResult, seed: int, scenario: str, how: dict,
               warm_used: bool | None) -> None:
        """File one run: its key (``how``: the budget, or E6's setting), the request solved and the response."""
        experiment, day = self._where
        data = {"key": {"commit": self.commit, "experiment": experiment, "day": day, "variant": path.parent.name,
                        "seed": seed, **how, "scenario": scenario, "warm": self._warm is not None},
                "request_digest": core.digest(req), "seed": seed, "scenario": scenario, "wall_sec": run.wall_sec,
                "env": run.env, "warm_used": warm_used, "solved_at": _now(), "host": socket.gethostname(),
                "request": run.request.model_dump(mode="json"), "response": run.response.model_dump(mode="json")}
        _write_json(path, data)
        self.last = {k: v for k, v in data.items() if k not in ("request", "response")}

    def _read(self, path: Path, req: DispatchRequest, seed: int, scenario: str) -> RunResult | None:
        if not path.is_file():
            return None
        data = json.loads(path.read_text(encoding="utf-8"))
        if (data["request_digest"], data["seed"], data["scenario"]) != (core.digest(req), seed, scenario):
            return None  # filed for another request (the day's data changed): solved again
        run_req = DispatchRequest.model_validate(data["request"])
        response = DispatchResponse.model_validate(data["response"])
        self.last = {k: v for k, v in data.items() if k not in ("request", "response")}
        return RunResult(seed=seed, digest=data["request_digest"], request=run_req, response=response,
                         metrics=core.metrics(run_req, response, scenario), wall_sec=data["wall_sec"], env=data["env"])

    # Items: a claim while one lane works on it, a marker once it is done.
    def _item_path(self, item: Item, suffix: str) -> Path:
        return self.dir / item.experiment / "_items" / f"{_slug(item.key)}{suffix}"

    def done(self, item: Item) -> dict | None:
        p = self._item_path(item, ".json")
        return json.loads(p.read_text(encoding="utf-8")) if p.is_file() else None

    def claim(self, item: Item) -> bool:
        return _try_lock(self._item_path(item, ".lock"))

    def release(self, item: Item) -> None:
        self._item_path(item, ".lock").unlink(missing_ok=True)

    def mark_done(self, item: Item, info: dict) -> None:
        _write_json(self._item_path(item, ".json"), {"item": item.key, **info})


# ------------------------------------------------------------------------------------------------------------
# Formatting
# ------------------------------------------------------------------------------------------------------------

def _fmt(st: dict | None, nd: int = 2, signed: bool = True) -> str:
    """mean [min..max] (just the mean when they agree)."""
    if not st or st.get("mean") is None:
        return "-"

    def f(v: float) -> str:
        return f"{v:+.{nd}f}" if signed else f"{v:.{nd}f}"

    return f(st["mean"]) if st["min"] == st["max"] else f"{f(st['mean'])} [{f(st['min'])}..{f(st['max'])}]"


def _spread(st: dict) -> float:
    return round(st["max"] - st["min"], 3)


def _vs_noise(st: dict | None, spread: float, nd: int) -> str:
    """A paired delta, flagged when its mean is smaller than the baseline's seed spread."""
    cell = _fmt(st, nd)
    return cell + (" within search noise" if st and spread > 0 and abs(st["mean"]) < spread else "")


def _stats(values: list[float]) -> dict:
    return {"mean": round(sum(values) / len(values), 3), "min": round(min(values), 3), "max": round(max(values), 3),
            "values": [round(v, 3) for v in values]}


def _demote(md: str, levels: int) -> str:
    return "\n".join("#" * levels + line if line.startswith("#") else line for line in md.splitlines())


def _rounded(obj):
    """Floats rounded to 3 decimals (JSON outputs carry no coordinate-like numbers)."""
    if isinstance(obj, float):
        return round(obj, 3) + 0.0
    if isinstance(obj, dict):
        return {str(k): _rounded(v) for k, v in obj.items()}
    if isinstance(obj, (list, tuple)):
        return [_rounded(v) for v in obj]
    return obj


def _checked(text: str, days: Days) -> str:
    """``text`` once no original id or coordinate of a real day is in it (ivms.check_no_leak), with every
    number in it rounded to 3 decimals."""
    if any(c in text for c in days.coords):
        raise ivms.LeakError("a real coordinate would be written")
    text = _LONG_DECIMAL.sub(lambda m: f"{float(m.group()):.3f}", text)
    ivms.check_no_leak(text, days.secrets, allow=set())
    return text


def machine() -> dict:
    """The machine this runs on (the codespace's 4 CPUs) and the solver's versions."""
    import ortools

    cpu = platform.processor()
    with contextlib.suppress(OSError, StopIteration):
        cpu = next(line.split(":", 1)[1].strip() for line in Path("/proc/cpuinfo").read_text().splitlines()
                   if line.startswith("model name"))
    return {"nproc": os.cpu_count(), "cpu": cpu, "python": platform.python_version(), "ortools": ortools.__version__,
            "platform": platform.platform()}


def ivms_parameters() -> dict:
    """The figures the experiments take from the owner's IVMS report and the 13 Oct truck evidence (the
    committed aggregates, decision_support/data/ivms_aggregates.json)."""
    agg = ivms.load()
    gap = explain.unloading_gap(agg)
    slow, _ = exact.ivms_slow_factor()
    model = history.UncertaintyModel.from_aggregates()
    return {
        "source": "decision_support/data/ivms_aggregates.json: aggregates of the IVMS report (Feb-Mar 2026) and the "
                  "13 Oct truck evidence",
        "whatif": whatif.ivms_evidence(agg),
        "uncertainty_model": asdict(model),
        "band_factors": dynamic.ivms_band_factors(agg),
        "small_drop_on_site_min": economics.small_drop_on_site(agg),
        "visit_every_days": economics.visit_frequency(agg, "all"),
        "unloading_gap": {"share": gap[0], "visits": gap[1]} if gap else None,
        "slow_day_factor": slow,
        "muscat_speed_kmh": {b: exact.ivms_speed_kmh(b)[0] for b in exact.IVMS_BANDS},
    }


def _ivms_lines(p: dict, keys: tuple[str, ...]) -> list[str]:
    w = p["whatif"]
    m = p["uncertainty_model"]
    texts = {
        "speed": f"evening / night drive speed factor {w['speed']['evening']} / {w['speed']['night']} x day speed "
                 f"(IVMS MOVING segments, Muscat)" if w.get("speed") else "no IVMS speed factors",
        "unloading": f"best-quartile unloading {p['unloading_gap']['share']:.0%} shorter than the median "
                     f"({p['unloading_gap']['visits']} GPS visits; the basis of the faster-unloading levers, which "
                     f"still REQUIRE EVIDENCE)" if p["unloading_gap"] else "no unloading spread",
        "model": f"world model: travel x lognormal(median {m['travel_median']}, sigma {m['travel_sigma']:.3f}), "
                 f"unloading x lognormal(median {m['unload_median']}, sigma {m['unload_sigma']:.3f}); medians "
                 f"{'are labelled defaults' if 'travel_median' in m['assumed'] else 'measured'}",
        "bands": "IVMS time-of-day travel factors: " + ", ".join(f"{b} {f}" for b, f in (p["band_factors"] or {}).items()),
        "drops": "small drops (under 50 cases) on site p25/p50/p75 "
                 + "/".join(f"{p['small_drop_on_site_min'][q]:g}" for q in ("p25", "p50", "p75")) + " min"
                 if p["small_drop_on_site_min"] else "no small-drop evidence",
        "visits": f"customers get a delivery every {p['visit_every_days']['p50']:g} days (median)"
                  if p["visit_every_days"] else "no visit frequency",
        "slow": f"slow-day stress: every drive x {p['slow_day_factor']} (IVMS p75 travel multiplier); Muscat p50 "
                "speeds " + ", ".join(f"{b} {v:g} km/h" for b, v in p["muscat_speed_kmh"].items()),
    }
    return [f"- {texts[k]}" for k in keys]


# ------------------------------------------------------------------------------------------------------------
# Experiments
# ------------------------------------------------------------------------------------------------------------

@dataclass
class Group:
    """One experiment's run list for one day (or E5 variant), split across lanes on its own."""

    experiment: str
    day: str
    phase: int  # the order of groups in `all`: long items first, SYNTH-400 last
    items: list[Item] = field(default_factory=list)
    skipped: str | None = None


class Experiment:
    name = ""
    slug = ""
    title = ""
    ivms_keys: tuple[str, ...] = ()

    def groups(self, suite: Suite, days: Days) -> list[Group]:
        raise NotImplementedError

    def run(self, item: Item, suite: Suite, days: Days, cache: RunCache) -> dict:
        """Solve one item through the cache hooks; returns what its done-marker keeps."""
        raise NotImplementedError

    def report(self, group: Group, suite: Suite, days: Days, cache: RunCache) -> tuple[dict, list[str]]:
        """The JSON payload and the Markdown lines of one group, from the cache only. A payload key "_status"
        (PARTIAL) overrides COMPLETE."""
        raise NotImplementedError

    def about(self, suite: Suite) -> list[str]:
        return []

    def meta(self, suite: Suite) -> dict:
        """What this experiment's report header says differently from E1-E5's (budgets, seeds, env, compute)."""
        return {}


class E1(Experiment):
    """What-if levers alone and in the chosen combinations, cold (searched from scratch per seed) and warm
    (searched from the same seed's baseline plan, against the baseline re-solved the same way)."""

    name, slug, title = "E1", "E1-whatif", "What-if levers"
    ivms_keys = ("speed", "unloading")
    PHASES = {"SYNTH-320": 2, "REAL-15OCT": 2, "SYNTH-400": 9}

    def __init__(self) -> None:
        self._memo: dict[tuple, object] = {}

    @staticmethod
    def levers(real: bool, quick: bool) -> tuple[tuple[whatif.Lever, ...], tuple[frozenset[str], ...]]:
        """The levers and the pairs to run together (by lever name)."""
        W = whatif
        if real:
            if quick:
                return (W.Flex(30, hypothetical=True), W.FasterReload(15)), ()
            return (W.Flex(10, hypothetical=True), W.Flex(20, hypothetical=True), W.Flex(30, hypothetical=True),
                    W.FasterUnloading(20), W.FasterReload(15)), ()
        aft = W.Afternoon(18 * 60)
        if quick:
            return (W.Flex(30), aft, W.FasterUnloading(20)), (frozenset({W.Flex(30).name, aft.name}),)
        return ((W.Flex(10), W.Flex(20), W.Flex(30), W.PrefFlex(30), aft, W.Night(22 * 60), W.FasterUnloading(20),
                 W.FasterReload(15)),
                (frozenset({W.Flex(30).name, aft.name}), frozenset({W.Flex(20).name, aft.name})))

    def context(self, day: Day) -> whatif.WhatIfContext:
        key = ("ctx", day.name)
        if key not in self._memo:
            self._memo[key] = (whatif.WhatIfContext.from_real(day.data) if day.real
                               else whatif.WhatIfContext.from_synth(day.data))  # type: ignore[arg-type]
        return self._memo[key]  # type: ignore[return-value]

    def variants(self, day: Day, suite: Suite) -> list[tuple[str, str, tuple[whatif.Lever, ...], DispatchRequest]]:
        """(variant id, group, levers, request) of every variant: each lever alone, the chosen pairs, all levers
        that need no evidence, and all levers (whatif.plan_variants, filtered)."""
        key = ("variants", day.name, suite.quick)
        if key not in self._memo:
            levers, pairs = self.levers(day.real, suite.quick)
            out = []
            for group, combo in whatif.plan_variants(levers, combos=bool(pairs)):
                groups = set(group.split(", "))
                if not (groups & {"SINGLE", "ALL", "ALL_WITH_EVIDENCE"} or frozenset(lv.name for lv in combo) in pairs):
                    continue
                vid = next((g for g in ("ALL_WITH_EVIDENCE", "ALL") if g in groups), None) \
                    or _slug(" + ".join(lv.name for lv in combo))
                out.append((vid, group, combo, whatif.apply_levers(day.request, combo, self.context(day))))
            self._memo[key] = out
        return self._memo[key]  # type: ignore[return-value]

    def _names(self, day: Day, suite: Suite) -> dict[str, str]:
        return {core.digest(day.request): "baseline"} | {core.digest(v[3]): v[0] for v in self.variants(day, suite)}

    def groups(self, suite: Suite, days: Days) -> list[Group]:
        out = []
        for name, phase in self.PHASES.items():
            if suite.quick and name == "SYNTH-400":
                continue
            day = days.get(name)
            if day is None:
                out.append(Group(self.name, name, phase, skipped=days.why(name)))
                continue
            tag = _tag(suite.budget(day.real))
            vids = ["baseline"] + [v[0] for v in self.variants(day, suite)]
            out.append(Group(self.name, name, phase, [Item(self.name, name, vid + mode, s, tag) for mode in ("", "@warm")
                                                      for vid in vids for s in suite.seeds]))
        return out

    def run(self, item: Item, suite: Suite, days: Days, cache: RunCache) -> dict:
        day = days.get(item.day)
        budget = suite.budget(day.real)
        vid, warm = item.variant.removesuffix("@warm"), item.variant.endswith("@warm")
        req = day.request if vid == "baseline" else next(v[3] for v in self.variants(day, suite) if v[0] == vid)
        with cache.scope(self.name, day.name, self._names(day, suite)):
            if not warm:
                core.solve(req, budget, item.seed)
                return {"warm_used": None}
            base = core.solve(day.request, budget, item.seed)
            with cache.warm_from(base):
                core.solve(req, budget, item.seed)
            return {"warm_used": cache.last.get("warm_used")}

    def _cash(self, base_req: DispatchRequest, run: RunResult, ctx: whatif.WhatIfContext) -> float:
        """Engine cash plus the second-driver assumption, as in WhatIfRow.cash."""
        return run.metrics.cash.total + whatif.second_shifts(base_req, _recommended(run))[0] * ctx.night_driver_cost

    def report(self, group: Group, suite: Suite, days: Days, cache: RunCache) -> tuple[dict, list[str]]:
        day = days.get(group.day)
        req, budget, ctx = day.request, suite.budget(day.real), self.context(day)
        variants = self.variants(day, suite)
        with cache.scope(self.name, day.name, self._names(day, suite)):
            base_runs = core.solve_seeds(req, budget)
            baseline = whatif._row("Baseline", "BASELINE", (), req, req, base_runs, None, ctx)
            rows = [whatif._row(" + ".join(lv.name for lv in combo), group_, combo, req, vreq,
                                core.solve_seeds(vreq, budget), baseline, ctx) for _, group_, combo, vreq in variants]
            report = whatif.WhatIfReport(
                label=ctx.label, digest=core.digest(req), budget=budget, normal_end_min=whatif.normal_end_min(req),
                night_driver_cost=ctx.night_driver_cost, baseline=baseline, rows=rows,
                assumptions=dict(ctx.assumptions), evidence=dict(ctx.evidence))
            warm: dict[str, dict] = {}
            for vid, vreq in [("baseline", req)] + [(v[0], v[3]) for v in variants]:
                runs, used = [], []
                for base in base_runs:
                    with cache.warm_from(base):
                        runs.append(core.solve(vreq, budget, base.seed))
                    used.append(bool(cache.last.get("warm_used")))
                warm[vid] = {"runs": runs, "used": used, "cash": [self._cash(req, r, ctx) for r in runs],
                             "summary": core.summarize(runs)}
        control = warm["baseline"]
        for vid, w in warm.items():
            w["delta_cash"] = _stats([c - b for c, b in zip(w["cash"], control["cash"])])
            w["delta"] = core.diff(control["summary"], w["summary"])["metrics"]
        m = baseline.summary["metrics"]
        noise = {"cold": {"cash": _spread(baseline.cash), "stops": _spread(m["stops_served"])},
                 "warm": {"cash": _spread(_stats(control["cash"])),
                          "stops": _spread(control["summary"]["metrics"]["stops_served"])}}
        payload = {
            "day": day.describe(), "budget": asdict(budget), "noise": noise, "report": report.to_dict(),
            "warm": {vid: {"delta_cash": w["delta_cash"], "delta_stops_served": w["delta"]["stops_served"],
                           "delta_trucks": w["delta"]["trucks_used"], "delta_km": w["delta"]["km"],
                           "warm_start_used": w["used"], "feasibility": w["summary"]["feasibility"]}
                     for vid, w in warm.items()},
        }
        nc, nw = noise["cold"], noise["warm"]
        wm = control["summary"]["metrics"]
        lines = [f"## {day.name}: {day.describe()}", "",
                 f"Budget {budget.time_limit_sec} s {budget.search_mode} per run, seeds {list(budget.seeds)}. "
                 f"{len(variants)} variants; every one solved cold and warm.", ""]
        if day.real:
            lines += [NO_PROVENANCE, ""]
        lines += [f"**Baseline, cold:** cash {_fmt(baseline.cash, 2, False)} OMR; stops served "
                  f"{_fmt(m['stops_served'], 1, False)} of {m['stops_total']['mean']:.0f}; trucks "
                  f"{_fmt(m['trucks_used'], 1, False)}; {_fmt(m['km'], 1, False)} estimated km. Seed spread (the search "
                  f"noise at this budget): cash {nc['cash']:.2f} OMR, stops {nc['stops']:g}.", "",
                  f"**Warm control** (the baseline re-solved for the same budget from its own plan): cash "
                  f"{_fmt(_stats(control['cash']), 2, False)} OMR; stops served {_fmt(wm['stops_served'], 1, False)}; "
                  f"seed spread: cash {nw['cash']:.2f} OMR, stops {nw['stops']:g}; warm start used in "
                  f"{sum(control['used'])}/{len(control['used'])} runs.", "",
                  f"| Variant | Group | Flags | Δ cash OMR, cold (spread {nc['cash']:.2f}) | Δ stops, cold (spread "
                  f"{nc['stops']:g}) | Δ cash OMR, warm (spread {nw['cash']:.2f}) | Δ stops, warm (spread "
                  f"{nw['stops']:g}) | warm start used |", "|---|---|---|---|---|---|---|---|"]
        for (vid, *_), row in zip(variants, rows):
            w = warm[vid]
            lines.append(f"| {row.name} | {row.group} | {', '.join(row.flags) or '-'} | "
                         f"{_vs_noise(row.delta_cash, nc['cash'], 2)} | "
                         f"{_vs_noise(row.delta['metrics']['stops_served'], nc['stops'], 1)} | "
                         f"{_vs_noise(w['delta_cash'], nw['cash'], 2)} | "
                         f"{_vs_noise(w['delta']['stops_served'], nw['stops'], 1)} | {sum(w['used'])}/{len(w['used'])} |")
        lines += ["", "Cold: variant and baseline each searched from scratch; Δ = variant - baseline, paired per seed, "
                      "mean [min..max]. Warm: the variant (and the baseline itself, as the control) searched for the same "
                      "budget starting from the same seed's cold baseline plan, which every lever here keeps feasible; "
                      "Δ = variant - control, paired per seed. The warm start only guarantees the route search's own "
                      "objective: the engine's exact load re-check after the search can still discard that plan and "
                      "rebuild one, so a warm Δ can be negative. 'warm start used' counts the runs whose search could "
                      "load the plan (the others searched cold). 'within search noise': the mean Δ is smaller than that "
                      "baseline's seed spread. Cash includes the second-driver assumption for a truck back after the "
                      "normal shift. Serving more stops costs more cash: read Δ cash with Δ stops.", "",
                  "### Full what-if report of the cold runs (whatif.WhatIfReport)", "",
                  _demote(report.to_markdown(), 3), ""]
        return payload, lines

    def about(self, suite: Suite) -> list[str]:
        return ["Levers on synthetic days: Flex +10/+20/+30 min (SALES_PREFERENCE windows only), PrefFlex +30, "
                "Afternoon (until 18:00), Night (until 22:00), and REQUIRES EVIDENCE: FasterUnloading 20% and "
                "FasterReload 15 min; the pairs Flex+30 & Afternoon and Flex+20 & Afternoon; all levers that need no "
                "evidence; all levers. Real day: HYPOTHETICAL Flex +10/+20/+30 (all windows UNKNOWN) and the two "
                "evidence levers, each alone." + (" QUICK: a reduced lever set." if suite.quick else "")]


class E2(Experiment):
    """Every small stop (3 cases or fewer): exact fixed-plan estimates for all of them, and the day re-optimized
    without each of the costliest ``k`` (largest fixed-plan saving first) for every seed."""

    name, slug, title = "E2", "E2-economics", "Small-stop economics"
    ivms_keys = ("drops", "visits")
    DAYS = ("REAL-15OCT", "SYNTH-320")

    def __init__(self) -> None:
        self._ranked: dict[str, list[str]] = {}

    @staticmethod
    def k(suite: Suite) -> int:
        return 1 if suite.quick else 8

    @staticmethod
    def _names(req: DispatchRequest) -> dict[str, str]:
        labels = core.label_stops(req)
        return {core.digest(req): "baseline"} | {core.digest(economics.without_stop(req, sid)): f"without-{labels[sid]}"
                                                 for sid in economics.small_stops(req)}

    def groups(self, suite: Suite, days: Days) -> list[Group]:
        out = []
        for name in self.DAYS:
            day = days.get(name)
            if day is None:
                out.append(Group(self.name, name, 3, skipped=days.why(name)))
                continue
            tag = _tag(suite.budget(day.real))
            variants = ["baseline"] + [f"reopt-{k}" for k in range(1, self.k(suite) + 1)]
            out.append(Group(self.name, name, 3, [Item(self.name, name, v, s, tag) for v in variants for s in suite.seeds]))
        return out

    def ranked(self, day: Day, budget: Budget, base_runs: list[RunResult]) -> list[str]:
        """The small stops the reference plan serves, costliest fixed-plan saving first: economics.analyze's own
        order for ``reoptimize``."""
        if day.name not in self._ranked:
            rep = economics.analyze_day(day.data, budget, reoptimize=0, base_runs=base_runs)
            ids = {label: sid for sid, label in core.label_stops(day.request).items()}
            rows = sorted((e for e in rep.stops if e.fixed is not None), key=lambda e: (-e.fixed.cash_saved.total, e.stop))
            self._ranked[day.name] = [ids[e.stop] for e in rows]
        return self._ranked[day.name]

    def run(self, item: Item, suite: Suite, days: Days, cache: RunCache) -> dict:
        day = days.get(item.day)
        req, budget = day.request, suite.budget(day.real)
        with cache.scope(self.name, day.name, self._names(req)):
            if item.variant == "baseline":
                core.solve(req, budget, item.seed)
                return {}
            ranked = self.ranked(day, budget, core.solve_seeds(req, budget))
            k = int(item.variant.split("-")[1])
            if k > len(ranked):
                return {"note": f"only {len(ranked)} small stops are served: nothing to re-optimize"}
            core.solve(economics.without_stop(req, ranked[k - 1]), budget, item.seed)
            return {"stop": core.label_stops(req)[ranked[k - 1]]}

    def report(self, group: Group, suite: Suite, days: Days, cache: RunCache) -> tuple[dict, list[str]]:
        day = days.get(group.day)
        req, budget = day.request, suite.budget(day.real)
        with cache.scope(self.name, day.name, self._names(req)):
            rep = economics.analyze_day(day.data, budget, reoptimize=self.k(suite),
                                        base_runs=core.solve_seeds(req, budget))
        m = rep.baseline["metrics"]
        actions = Counter(e.action for e in rep.stops)
        lines = [f"## {day.name}: {day.describe()}", "",
                 f"Budget {budget.time_limit_sec} s {budget.search_mode} per run, seeds {list(budget.seeds)}. "
                 f"{len(rep.stops)} small stops ({rep.max_cases} cases or fewer); the day re-optimized without each of "
                 f"the {self.k(suite)} costliest by fixed-plan saving. Reference plan: seed {rep.reference_seed}.", "",
                 f"**Baseline:** cash {_fmt(m['cash.total'], 2, False)} OMR; stops served "
                 f"{_fmt(m['stops_served'], 1, False)} of {m['stops_total']['mean']:.0f}. Seed spread: cash "
                 f"{_spread(m['cash.total']):.2f} OMR.", "",
                 "Actions: " + ", ".join(f"{a} {n}" for a, n in sorted(actions.items())) + ".", ""]
        if rep.invoices:
            i = rep.invoices
            lines += [f"Invoices: {i['small_invoices']} of {i['invoices']} are small: {i['in_small_stops']} in small "
                      f"stops of their own, {i['in_larger_stops']} inside larger stops of the same customer.", ""]
        lines += ["| stop | P | cases | late order | fixed-plan cash saved OMR | paid driver min freed | est. km freed | "
                  "ARTIFICIAL penalty if left out | re-optimized: cash saved OMR, all seeds | like-for-like seeds: cash "
                  "saved OMR | search noise OMR | re-opt decides | action |",
                  "|---|---|---|---|---|---|---|---|---|---|---|---|---|"]
        for e in rep.stops:
            f, d = e.fixed, e.defer
            fixed = ([f"{f.cash_saved.total:.2f}", str(f.freed.paid_driver_min), f"{f.freed.km:.2f}",
                      f"{f.penalty_change['unserved_penalty']:+.0f}"] if f else ["-"] * 4)
            reopt = ["-"] * 4
            if d:
                like = _fmt(d.avoidable_cash_like_for_like) if d.avoidable_cash_like_for_like else "none"
                reopt = [_fmt(d.avoidable_cash), f"{like} ({len(d.like_for_like_seeds)}/{len(d.seeds)})",
                         f"{d.noise_omr:.2f}" if d.noise_omr is not None else "-", "yes" if d.used else "no"]
            cells = [e.stop, str(e.priority), str(e.cases), "yes" if e.late else "no", *fixed, *reopt, e.action]
            lines.append("| " + " | ".join(cells) + " |")
        lines += ["", "Fixed-plan: the stop taken out of the reference plan and the plan re-timed exactly (no search "
                      "noise). Re-optimized: the whole day solved again without the stop, minus the baseline, paired per "
                      "seed; like-for-like seeds serve the same other stops. It decides only when every like-for-like "
                      "saving beats the fixed-plan estimate by more than the search noise. Cash in OMR; the penalty is "
                      "the solver's ARTIFICIAL price, not money.", "", "Reasons:", ""]
        lines += [f"- {e.stop} {e.action}: {'; '.join(e.reasons)}" for e in rep.stops]
        return {"day": day.describe(), "budget": asdict(budget), "report": rep.to_dict()}, lines + [""]

    def about(self, suite: Suite) -> list[str]:
        return ["Every small stop gets the exact fixed-plan removal estimate, the combine and move checks and an "
                "action; the costliest are also re-optimized without the stop for every seed. No margins are invented: "
                "without DispatchStop.margin a break-even margin needs a next-day plan; here the future cost is "
                "the labelled PROXY (today's cost reused), so none is given."]


SETTINGS = dynamic.Settings()
POLICY = {p.name: p for p in dynamic.POLICIES}


class E3(Experiment):
    """Policies A (static), B (re-plan at each depot return) and C (event-triggered) on the same sampled worlds,
    from one shared morning plan."""

    name, slug, title = "E3", "E3-dynamic", "Dynamic re-planning policies"
    ivms_keys = ("model", "bands")
    DAYS = ("SYNTH-280", "REAL-15OCT")

    def __init__(self) -> None:
        self._model: tuple | None = None

    def world_model(self) -> tuple[history.UncertaintyModel, dict | None]:
        if self._model is None:
            self._model = (history.UncertaintyModel.from_aggregates(), dynamic.ivms_band_factors())
        return self._model

    @staticmethod
    def worlds(name: str, suite: Suite) -> tuple[int, ...]:
        return (1,) if suite.quick else ((1, 2, 3, 4, 5) if name == "SYNTH-280" else (1, 2, 3))

    @staticmethod
    def case(name: str, days: Days) -> tuple[DispatchRequest, tuple[dynamic.NewOrder, ...]] | None:
        if name == "SYNTH-280":
            return days.dynamic_case()
        day = days.get(name)
        return (day.request, ()) if day is not None else None

    @staticmethod
    def windows(name: str) -> dict:
        """The World's window labels: the synthetic day's own; none on a real day (every window genuine)."""
        return dynamic.synthetic_windows(280, 1) if name == "SYNTH-280" else {}

    @staticmethod
    def budgets(name: str, suite: Suite) -> tuple[Budget, Budget]:
        """(morning plan, each re-plan), one solver seed: the policies share every world's draws instead."""
        seeds = (SETTINGS.solver_seed,)
        morning = suite.budget_synth if name.startswith("SYNTH") else suite.budget_real
        return Budget(time_limit_sec=morning, seeds=seeds), Budget(time_limit_sec=suite.budget_replan, seeds=seeds)

    def groups(self, suite: Suite, days: Days) -> list[Group]:
        out = []
        for name in self.DAYS:
            if self.case(name, days) is None:
                out.append(Group(self.name, name, 1, skipped=days.why(name)))
                continue
            morning, replan = self.budgets(name, suite)
            tag = f"{_tag(morning)}+{_tag(replan)}"
            items = [Item(self.name, name, "morning", SETTINGS.solver_seed, tag)]
            items += [Item(self.name, name, f"world-{w}-{p}", w, tag) for p in "CBA" for w in self.worlds(name, suite)]
            out.append(Group(self.name, name, 1, items))
        return out

    def run(self, item: Item, suite: Suite, days: Days, cache: RunCache) -> dict:
        known, new = self.case(item.day, days)
        morning_budget, replan = self.budgets(item.day, suite)
        with cache.scope(self.name, item.day, {core.digest(known): "morning"}):
            morning = dynamic.morning_plan(known, morning_budget, seed=SETTINGS.solver_seed)
            if item.variant == "morning":
                return {}
            model, bands = self.world_model()
            world = dynamic.World(known, item.seed, model, new, band_factors=bands, **self.windows(item.day))
            res = dynamic.simulate(world, POLICY[item.variant[-1]], morning, budget=replan, settings=SETTINGS)
            return {"outcome": _rounded(asdict(res.outcome))}

    def report(self, group: Group, suite: Suite, days: Days, cache: RunCache) -> tuple[dict, list[str]]:
        known, new = self.case(group.day, days)
        morning_budget, replan = self.budgets(group.day, suite)
        model, bands = self.world_model()
        worlds = [dynamic.World(known, w, model, new, band_factors=bands, **self.windows(group.day))
                  for w in self.worlds(group.day, suite)]
        with cache.scope(self.name, group.day, {core.digest(known): "morning"}):
            rep = dynamic.compare(worlds, dynamic.POLICIES, budget=replan, morning_budget=morning_budget, settings=SETTINGS)
        rep["day"] = {"name": group.day, "label": "SYNTHETIC" if group.day.startswith("SYNTH") else "REAL, anonymised",
                      "stops_known": len(known.stops), "new_orders": len(new), "trucks": len(known.trucks)}
        mo = rep["morning"]
        what = (f"SYNTHETIC: 280 invoices (seed 1), {len(known.stops)} stops known in the morning + {len(new)} late "
                "orders revealed 08:30-13:00" if new else f"REAL, anonymised: {len(known.stops)} stops, no new orders")
        lines = [f"## {group.day}: {what}; {len(known.trucks)} trucks", "",
                 f"Worlds {[w.seed for w in worlds]}; morning plan {morning_budget.time_limit_sec} s, each re-plan "
                 f"{replan.time_limit_sec} s ({replan.search_mode}, solver seed {SETTINGS.solver_seed}). Morning plan: "
                 f"{mo['stops_planned']} of {mo['stops_known']} stops on {mo['loads']} loads, {mo['trucks']} trucks, "
                 f"planned cash {mo['planned_cash']['total']:.2f} OMR, {mo['feasibility']}.", "",
                 "| metric, mean [min..max] over the worlds | " + " | ".join(
                     f"{p.name}: {p.label}" for p in dynamic.POLICIES) + " |",
                 "|---|" + "---|" * len(dynamic.POLICIES)]
        rows = (("served", "stops served", 1), ("served_known", "morning stops served", 1),
                ("served_new", "new orders served", 1), ("unserved", "stops unserved", 1),
                ("late_stops", "late stops (after the genuine closing time)", 1), ("late_min", "late minutes", 0),
                ("pref_late_stops", "sales-preference windows missed, inside the genuine hours", 1),
                ("late_returns", "returns after the limit", 1), ("late_breaks", "late breaks", 1),
                ("missing_breaks", "missing breaks", 1), ("cash.total", "cash OMR (the executed day)", 2),
                ("cash_per_case", "cash OMR per case served", 3), ("km", "estimated km", 1), ("loads", "loads", 1),
                ("overtime_min", "overtime min", 0), ("replans", "re-plans that searched", 1),
                ("replans_skipped", "re-plans with nothing to plan", 1), ("stops_moved", "stop moves", 1),
                ("stops_moved_distinct", "distinct stops moved", 1), ("truck_changes", "truck changes", 1),
                ("solver_sec", "solver seconds", 0))
        for key, text, nd in rows:
            lines.append(f"| {text} | " + " | ".join(_fmt(rep["summary"][p.name].get(key), nd, False)
                                                      for p in dynamic.POLICIES) + " |")
        first = dynamic.POLICIES[0].name
        lines += ["", f"Paired against {first} (same world), mean [min..max]:", "",
                  "| policy | Δ stops served | Δ morning stops served | Δ late stops | Δ cash OMR | Δ estimated km | "
                  "distinct stops moved |", "|---|---|---|---|---|---|---|"]
        for p in dynamic.POLICIES[1:]:
            d = rep[f"vs_{first}"][p.name]
            lines.append(f"| {p.name} | {_fmt(d['served'], 1)} | {_fmt(d['served_known'], 1)} | {_fmt(d['late_stops'], 1)} | "
                         f"{_fmt(d['cash.total'])} | {_fmt(d['km'], 1)} | "
                         f"{_fmt(rep['summary'][p.name]['stops_moved_distinct'], 1, False)} |")
        lines += ["", f"{rep['label']}. Cash: {rep['labels']['cash']}. Late: {rep['labels']['late']}. Re-plans: "
                      f"{rep['labels']['replans']}. Every re-plan is checked by feasibility.check_scenario. Policy A "
                      "never serves an order revealed after the morning plan: it is not today's practice, where a late "
                      "order can be added by hand.", ""]
        rep["runs"] = [{k: v for k, v in r.items() if k != "replan_log"} | {"replans_logged": len(r["replan_log"])}
                       for r in rep["runs"]]
        return rep, lines

    def about(self, suite: Suite) -> list[str]:
        return ["The simulator samples actual travel and unloading times per world and reveals each event only when "
                "it happens (no future information). The world model and its IVMS time-of-day factors are below."]


class E4(Experiment):
    """Verdicts of the base runs, conflicts of the stops left out, ranked relaxations and the frontier."""

    name, slug, title = "E4", "E4-explain", "Verdicts, ranked relaxations and the trade-off frontier"
    ivms_keys = ("unloading", "speed")
    DAYS = ("REAL-15OCT-PREFIX", "SYNTH-320-TIGHT")

    @staticmethod
    def options(suite: Suite) -> dict:
        """candidates_for's limits: window candidates for the highest-priority stops left out, +1 load, a hire."""
        if suite.quick:
            return {"minutes": (30,), "max_stops": 1, "max_trucks": 1, "max_hires": 1}
        return {"minutes": (10, 30), "max_stops": 3, "max_trucks": 2, "max_hires": 1}

    def max_candidates(self, suite: Suite) -> int:
        o = self.options(suite)
        return o["max_stops"] * len(o["minutes"]) + o["max_trucks"] + o["max_hires"] + 2  # + shift + unloading

    @staticmethod
    def context(day: Day, days: Days) -> explain.Context:
        if day.real:
            return explain.Context.of(day.data, hypothetical=True, hire_options=days.hire_options())
        return explain.Context.of(day.data)

    def groups(self, suite: Suite, days: Days) -> list[Group]:
        out = []
        for name in self.DAYS:
            day = days.get(name)
            if day is None:
                out.append(Group(self.name, name, 4, skipped=days.why(name)))
                continue
            tag = _tag(suite.budget(day.real))
            variants = ["base", "MIN_TRUCKS", "MIN_DISTANCE"] + [f"cand-{k:02d}"
                                                                 for k in range(1, self.max_candidates(suite) + 1)]
            out.append(Group(self.name, name, 4, [Item(self.name, name, v, s, tag) for v in variants for s in suite.seeds]))
        return out

    def _candidates(self, day: Day, ctx: explain.Context, suite: Suite, budget: Budget) -> tuple[list, dict[str, str]]:
        """The candidate relaxations of the base runs, and the names of every request."""
        req = day.request
        base_runs = core.solve_seeds(req, budget)
        cands = explain.candidates_for(req, [r.response for r in base_runs], ctx, **self.options(suite))
        labels = core.label_stops(req)
        names = {core.digest(req): "base"} | {core.digest(c.apply(req, ctx)): f"cand-{k:02d}-{c.label(labels)}"
                                              for k, c in enumerate(cands, start=1)}
        return cands, names

    def run(self, item: Item, suite: Suite, days: Days, cache: RunCache) -> dict:
        day = days.get(item.day)
        req, budget, ctx = day.request, suite.budget(day.real), self.context(day, days)
        with cache.scope(self.name, day.name, {core.digest(req): "base"}):
            if item.variant == "base":
                core.solve(req, budget, item.seed)
                return {}
            if item.variant in ("MIN_TRUCKS", "MIN_DISTANCE"):
                explain.frontier(req, [explain.FrontierConfig(item.variant, item.variant)],
                                 replace(budget, seeds=(item.seed,)), ctx)
                return {}
            cands, names = self._candidates(day, ctx, suite, budget)
        k = int(item.variant.split("-")[1])
        if k > len(cands):
            return {"note": f"only {len(cands)} candidates"}
        with cache.scope(self.name, day.name, names):
            core.solve(cands[k - 1].apply(req, ctx), budget, item.seed)
        return {"candidate": cands[k - 1].label(core.label_stops(req))}

    def report(self, group: Group, suite: Suite, days: Days, cache: RunCache) -> tuple[dict, list[str]]:
        day = days.get(group.day)
        req, budget, ctx = day.request, suite.budget(day.real), self.context(day, days)
        with cache.scope(self.name, day.name, {core.digest(req): "base"}):
            _, names = self._candidates(day, ctx, suite, budget)
        with cache.scope(self.name, day.name, names):
            ex = explain.explain_day(req, budget, ctx, frontier_relaxations=2, **self.options(suite))
        counts = [v.verdict for v in ex.verdicts]
        lines = [f"## {day.name}: {day.describe()}", "",
                 f"Budget {budget.time_limit_sec} s {budget.search_mode} per run, seeds {list(budget.seeds)}. Verdicts "
                 f"per seed: {', '.join(counts)}. Candidates: windows +{'/+'.join(map(str, self.options(suite)['minutes']))} "
                 f"min for up to {self.options(suite)['max_stops']} stops left out, +1 load on up to "
                 f"{self.options(suite)['max_trucks']} trucks, a hired truck, shift +30 min (HYPOTHETICAL), faster "
                 "unloading (REQUIRES EVIDENCE).", ""]
        if day.real:
            lines += [NO_PROVENANCE + " Hire options: the trucks REAL-15OCT had and this request lacks (hired on "
                      f"15 Oct), {len(ctx.hire_options)} of them, anonymous. A hire variant also runs the engine's own "
                      "hire check (extra solves), as in production.", ""]
        payload = {"day": day.describe(), "budget": asdict(budget), "options": self.options(suite),
                   "verdict_counts": [v.counts() for v in ex.verdicts], "explanation": ex.to_dict()}
        return payload, lines + [_demote(ex.to_markdown(), 1), ""]

    def about(self, suite: Suite) -> list[str]:
        return ["REAL-15OCT-PREFIX is the 94-stop request that hit the bug fixed in PR #71, solved by today's engine. "
                f"SYNTH-320-TIGHT is SYNTH-320 with every hypermarket window closing {TIGHT_MIN} min earlier."]


class E5(Experiment):
    """The exact oracle against the engine on random small SYNTHETIC days, with and without the ARTIFICIAL
    preferred-window prices."""

    name, slug, title = "E5", "E5-exact", "Exact oracle against the engine"
    ivms_keys = ("slow",)
    VARIANTS = ("DEFAULT", "PREFERENCES_OFF")
    MAX_STOPS = 7

    def __init__(self) -> None:
        self._names: dict[tuple, dict[str, str]] = {}

    @staticmethod
    def budget(suite: Suite) -> Budget:
        return Budget(time_limit_sec=suite.budget_exact, seeds=(1,))

    def instance(self, i: int, variant: str, suite: Suite) -> DispatchRequest:
        req, _ = exact.random_instance(i, self.MAX_STOPS, time_limit_sec=suite.budget_exact)
        return req if variant == "DEFAULT" else exact.without_preference_prices(req)

    def names(self, variant: str, suite: Suite) -> dict[str, str]:
        key = (variant, suite.e5_instances, suite.budget_exact)
        if key not in self._names:
            self._names[key] = {core.digest(self.instance(i, variant, suite)): f"inst-{i:03d}"
                                for i in range(1, suite.e5_instances + 1)}
        return self._names[key]

    def groups(self, suite: Suite, days: Days) -> list[Group]:
        tag = _tag(self.budget(suite))
        return [Group(self.name, v, 5, [Item(self.name, v, f"inst-{i:03d}", 1, tag) for i in range(1, suite.e5_instances + 1)])
                for v in self.VARIANTS]

    def run(self, item: Item, suite: Suite, days: Days, cache: RunCache) -> dict:
        req = self.instance(int(item.variant.split("-")[1]), item.day, suite)
        with cache.scope(self.name, item.day, {core.digest(req): item.variant}):
            core.solve_seeds(req, self.budget(suite))
        return {}

    def report(self, group: Group, suite: Suite, days: Days, cache: RunCache) -> tuple[dict, list[str]]:
        with cache.scope(self.name, group.day, self.names(group.day, suite)):
            got = exact.run_suite(suite.e5_instances, self.MAX_STOPS, self.budget(suite), first_seed=1,
                                  preference_prices=group.day == "DEFAULT")
        s = got["summary"]
        profiles = Counter(r["profile"] for r in got["rows"])

        def cell(v) -> str:
            if isinstance(v, dict) and "share" in v:
                return f"{v['true']}/{v['n']}" + (f" ({v['share']:.0%})" if v["share"] is not None else "")
            if isinstance(v, dict) and "mean" in v:
                return f"mean {v['mean']:.3f} [{v['min']:.3f}..{v['max']:.3f}], median {v['median']:.3f} (n={v['n']})"
            return "-" if isinstance(v, dict) else str(v)

        rows = (("complete_enumerations", "complete enumerations"), ("oracle_verified", "oracle plans verified by the engine's checks"),
                ("engine_plans_oracle_feasible", "engine plans feasible under the oracle's rules"),
                ("served_equal", "engine serves as many stops as the oracle"),
                ("service_equal", "same service value (priorities)"), ("stops_short_of_oracle", "stops short of the oracle"),
                ("proven_but_served", "stops proven never servable that the engine served"),
                ("engine_false_proofs", "engine proofs the oracle refutes"),
                ("engine_unproven_impossible", "impossible stops left out without an engine proof"),
                ("oracle_never_servable", "stops the oracle proves never servable"),
                ("cash_gap_omr", "cash gap engine - oracle optimum, OMR"), ("cash_gap_pct", "cash gap, %"),
                ("cash_gap_zero_share", "days with no cash gap (within 0.002 OMR)"),
                ("routing_gap_omr", "routing part of the gap, OMR"), ("timing_gap_omr", "timing part of the gap, OMR"),
                ("oracle_plans_survive_slow", "oracle plans that survive the slow day"),
                ("engine_plans_survive_slow", "engine plans that survive the slow day"),
                ("engine_wall_sec", "engine wall seconds per run"), ("oracle_seconds", "oracle seconds per day"))
        what = "with the engine's ARTIFICIAL preferred-window and early-arrival prices" if group.day == "DEFAULT" \
            else s["variant"]
        lines = [f"## {group.day}: {what}", "",
                 f"{s['instances']} SYNTHETIC days of 3-{s['max_stops']} stops (profiles: "
                 + ", ".join(f"{k} {n}" for k, n in sorted(profiles.items())) + f"); engine {s['budget']['time_limit_sec']} s "
                 f"per run, seed {', '.join(map(str, s['budget']['seeds']))}.", "", "| measure | value |", "|---|---|"]
        lines += [f"| {text} | {cell(s.get(key))} |" for key, text in rows]
        lines += ["", "The oracle's OPTIMAL claims hold for the instances it enumerated completely, for cash under its "
                      "own rules (the engine's timing rules, HAVERSINE estimated km).", ""]
        return {"summary": s, "profiles": dict(profiles)}, lines

    def about(self, suite: Suite) -> list[str]:
        return [f"{suite.e5_instances} random small instances per variant, at most {self.MAX_STOPS} stops and 2 trucks "
                "with one load each (exact.random_instance), each solved exactly by the oracle and once by the engine."]


# ------------------------------------------------------------------------------------------------------------
# E6: the engine at production settings
# ------------------------------------------------------------------------------------------------------------

OPTIONS = ("RECOMMENDED", "MIN_TRUCKS", "MIN_DISTANCE")  # the plan options production returns in one response
PROD_ENV = (("SOLVER_PARALLEL", "1"), ("SOLVER_PYVRP", "on"))  # worker processes and the second route search
# The engine's tuning switches, cleared for every E6 run: the engine then runs on its own rules (the THOROUGH cap
# and stall rule, the QUICK budget, the second search's stall and CPU gate).
TUNING_ENV = ("THOROUGH_MAX_SEC", "THOROUGH_STALL_SEC", "THOROUGH_STALL_SHARE", "SOLVER_BUDGET_SEC",
              "SOLVER_PYVRP_MIN_CPUS", "SOLVER_PYVRP_MAX_ITERS", "SOLVER_PYVRP_STALL_SEC", "SOLVER_PYVRP_STALL_SHARE")
CONVERGENCE_MARKS = (60, 120, 300, 600)  # seconds into RECOMMENDED's THOROUGH search
CASH_PARTS = ("fixed", "trip", "distance", "fuel", "driver", "overtime")
PRODUCTION = ("Not equal compute: E6 runs the engine as production does - all three plan options in one response, "
              "worker processes (SOLVER_PARALLEL=1), the second route search (SOLVER_PYVRP=on, its seed = the run's "
              "seed), the engine's own THOROUGH cap and stall rule (every tuning switch cleared) - one run at a time "
              "per machine. Unlike production it plans offline: HAVERSINE estimated km, not OSRM road distances.")

# Small changes of a real day for the stability test (QUICKP, seed 1). Changes of the day's data, never levers.
PERTURBATIONS = {
    "P0": "nothing changed: the same day solved again (the control: how much a timed search varies by itself)",
    "P1": "one small stop removed (an order cancelled)",
    "P2": "+5% cases (at least 1) on 10% of the stops",
    "P3": "one stop's receiving window 30 min later",
    "P4": "one truck unavailable",
    "P5": "one late order: a copy of a small stop, 1 km away",
}
DEMAND_UP, DEMAND_SHARE = 0.05, 0.10
WINDOW_LATER_MIN = 30
LATE_ORDER_KM = 1.0
KM_PER_DEG_LAT = 111.195


@dataclass(frozen=True)
class Setting:
    """How E6 runs the engine. ``time_limit_sec`` None: the engine's automatic time for the day (what the web
    sends); ``cap_sec``: THOROUGH's cap for the whole request (the request's max_search_sec, at most this)."""

    name: str
    search_mode: str
    cap_sec: int | None = None
    time_limit_sec: int | None = None
    env: tuple[tuple[str, str], ...] = PROD_ENV

    @property
    def tag(self) -> str:
        if self.search_mode == "THOROUGH":
            return f"{self.name}-{self.cap_sec}s"
        return f"{self.name}-{self.time_limit_sec}s" if self.time_limit_sec else f"{self.name}-auto"

    def describe(self) -> str:
        quick = f"{self.time_limit_sec} s" if self.time_limit_sec else "the automatic time by day size"
        what = (f"THOROUGH, cap {self.cap_sec} s for the whole request (the request's own max_search_sec when lower), "
                f"never less than QUICK's time ({quick}), the engine's stall rule" if self.search_mode == "THOROUGH"
                else f"QUICK, {quick}")
        return f"{what}; {' '.join(f'{k}={v}' for k, v in self.env)}; all three plan options"


@contextlib.contextmanager
def _solver_env(values: dict[str, str]) -> Iterator[dict[str, str]]:
    """``values`` set and every TUNING_ENV switch cleared for the duration (yields the switches the run has);
    the environment is restored afterwards."""
    keys = sorted(set(values) | set(TUNING_ENV))
    saved = {k: os.environ.get(k) for k in keys}
    for k in TUNING_ENV:
        os.environ.pop(k, None)
    os.environ.update(values)
    try:
        yield {k: os.environ[k] for k in keys if k in os.environ}
    finally:
        for k, v in saved.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v


def solve_setting(req: DispatchRequest, setting: Setting, seed: int) -> RunResult:
    """One optimize_dispatch run of ``req`` as production runs it: all three plan options in one response, the
    setting's search mode, times and solver switches; offline (HAVERSINE) and seeded as core.solve (seed s > 0
    also seeds the second search). Its metrics are RECOMMENDED's. Run from the command line (``__main__``
    guard): the worker processes are spawned."""
    run_req = core.offline(core.seeded(req, seed))
    cfg = run_req.config
    cfg.scenarios = list(OPTIONS)  # type: ignore[assignment]
    cfg.search_mode = setting.search_mode  # type: ignore[assignment]
    cfg.time_limit_sec = setting.time_limit_sec
    if setting.search_mode == "THOROUGH":
        cap = setting.cap_sec or ds.THOROUGH_MAX_SEC
        cfg.max_search_sec = min(req.config.max_search_sec or cap, cap)
    with _solver_env(dict(setting.env) | ({"SOLVER_PYVRP_SEED": str(seed)} if seed else {})) as env:
        started = time.perf_counter()
        response = ds.optimize_dispatch(run_req)
        wall = time.perf_counter() - started
    return RunResult(seed=seed, digest=core.digest(req), request=run_req, response=response,
                     metrics=core.metrics(run_req, response), wall_sec=round(wall, 2), env=env)


_ENGINE_SETTING = solve_setting


def _option(run: RunResult, name: str) -> DispatchScenario | None:
    return next((sc for sc in run.response.scenarios if sc.name == name), None)


def _served_ids(sc: DispatchScenario | None) -> set[str]:
    return {st.stop_id for ld in sc.loads for st in ld.stops} if sc is not None else set()


def _ranked(ids: Iterable[str], salt: str) -> list[str]:
    """``ids`` in a fixed pseudo-random order for ``salt``, whatever order they come in."""
    return sorted(ids, key=lambda i: hashlib.sha256(f"{salt}:{i}".encode()).hexdigest())


def perturb(req: DispatchRequest, kind: str, base: DispatchScenario) -> tuple[DispatchRequest, dict]:
    """The day ``req`` with one small change (PERTURBATIONS ``kind``) and what changed. The stop or truck changed
    is one the base plan ``base`` uses when there is one (a change the plan does not touch moves nothing), picked
    by a fixed hash order: the same day and plan always get the same change. These are changes of the day's data
    for the stability test, never relaxations offered to anyone."""
    out = req.model_copy(deep=True)
    served = _served_ids(base)
    by_id = {s.stop_id: s for s in out.stops}
    small = [s.stop_id for s in out.stops if s.demand_cases <= economics.SMALL_MAX_CASES]
    what: dict = {"kind": kind, "label": PERTURBATIONS[kind]}

    def pick(ids: list[str]) -> str:
        return _ranked([i for i in ids if i in served] or ids, kind)[0]

    if kind == "P0":
        out.run_id = f"{req.run_id}-again"  # another cache file; the engine plans exactly the same day
        what["change"] = "none"
    elif kind in ("P1", "P5"):
        sid = pick(small or sorted(by_id, key=lambda i: (by_id[i].demand_cases, i))[:5])
        s = by_id[sid]
        if kind == "P1":
            out.stops = [x for x in out.stops if x.stop_id != sid]
            what |= {"change": f"{sid} removed ({s.demand_cases} cases, P{s.priority})", "stop": sid}
        else:
            new = s.model_copy(deep=True)
            new.stop_id, new.customer_id = f"{sid}-late", f"{s.customer_id}-late"
            new.order_ids = [f"{o}-late" for o in s.order_ids]
            new.lat = min(90.0, s.lat + LATE_ORDER_KM / KM_PER_DEG_LAT)
            new.late, new.previous_truck_id = True, None
            out.stops.append(new)
            what |= {"change": f"{new.stop_id} added: a copy of {sid} ({s.demand_cases} cases, P{s.priority}) "
                               f"{LATE_ORDER_KM:g} km north, as a new customer's late order", "stop": new.stop_id}
    elif kind == "P2":
        k = max(1, round(DEMAND_SHARE * len(out.stops)))
        chosen = _ranked([s.stop_id for s in out.stops if s.demand_cases > 0], kind)[:k]  # any stop: demand grows anywhere
        added = 0
        for sid in chosen:
            s = by_id[sid]
            up = max(1, round(DEMAND_UP * s.demand_cases))
            f = (s.demand_cases + up) / s.demand_cases
            s.demand_cases += up
            s.demand_kg = round(s.demand_kg * f, 1)
            if s.demand_pallet_units is not None:
                s.demand_pallet_units = math.ceil(s.demand_pallet_units * f)
            s.service_min = min(synth.SERVICE_CAP_MIN, s.service_min + round(synth.SERVICE_PER_CASE * up))
            added += up
        what |= {"change": f"{len(chosen)} stops +{DEMAND_UP:.0%} cases (at least 1): {added} cases in all; kg and "
                           f"pallets in proportion; unloading +{synth.SERVICE_PER_CASE:g} min per case added",
                 "stops": len(chosen), "cases_added": added}
    elif kind == "P3":
        pool = [s.stop_id for s in out.stops if s.hard_end_min is not None and s.hard_end_min + WINDOW_LATER_MIN <= DAY_MIN]
        if not pool:
            what["change"] = "none: no stop has a closing time"
        else:
            sid = pick(pool)
            s = by_id[sid]

            def later(v: int | None) -> int | None:
                return None if v is None else min(DAY_MIN, v + WINDOW_LATER_MIN)

            s.hard_start_min, s.hard_end_min = later(s.hard_start_min), later(s.hard_end_min)
            s.pref_start_min, s.pref_end_min = later(s.pref_start_min), later(s.pref_end_min)
            what |= {"change": f"{sid}: receiving window {WINDOW_LATER_MIN} min later (opening, closing and any "
                               f"preferred window)", "stop": sid}
    elif kind == "P4":
        used = sorted({ld.truck_id for ld in base.loads})
        tid = _ranked(used or [t.id for t in out.trucks], kind)[0]
        carried = sum(len(ld.stops) for ld in base.loads if ld.truck_id == tid)
        out.trucks = [t for t in out.trucks if t.id != tid]
        for s in out.stops:
            if s.allowed_truck_ids is not None:
                s.allowed_truck_ids = [t for t in s.allowed_truck_ids if t != tid]
            if s.previous_truck_id == tid:
                s.previous_truck_id = None
        what |= {"change": f"{tid} unavailable (it carried {carried} stops in the base plan)", "truck": tid,
                 "stops_on_it": carried}
    else:
        raise ValueError(f"unknown perturbation {kind!r}")
    return DispatchRequest.model_validate(out.model_dump()), what  # validated again: unique ids, windows in order


def plan_moves(base: RunResult, new: RunResult, option: str = "RECOMMENDED") -> dict | None:
    """How far ``new``'s plan option moved from ``base``'s (dynamic.Replan's measures): stops of both plans on
    another (truck, load number) or another truck; stops of both days dropped, added, and the change in stops
    served; the trucks used before and after and how many differ; cash, loads and estimated km. None when either
    run lacks the option."""
    b, n = _option(base, option), _option(new, option)
    if b is None or n is None:
        return None
    old = {st.stop_id: (ld.truck_id, ld.load_no) for ld in b.loads for st in ld.stops}
    now = {st.stop_id: (ld.truck_id, ld.load_no) for ld in n.loads for st in ld.stops}
    common = {s.stop_id for s in base.request.stops} & {s.stop_id for s in new.request.stops}
    both = old.keys() & now.keys()
    t_old, t_new = {t for t, _ in old.values()}, {t for t, _ in now.values()}
    mb, mn = core.metrics(base.request, b), core.metrics(new.request, n)
    return {"stops_moved": sum(1 for s in both if old[s] != now[s]),
            "stops_other_truck": sum(1 for s in both if old[s][0] != now[s][0]),
            "dropped": len((old.keys() - now.keys()) & common), "added": len((now.keys() - old.keys()) & common),
            "served_change": len(now.keys() & common) - len(old.keys() & common),
            "trucks_before": len(t_old), "trucks_after": len(t_new), "trucks_changed": len(t_old ^ t_new),
            "cash_change": round(mn.cash.total - mb.cash.total, 3), "loads_change": n.trips - b.trips,
            "km_change": round(mn.km - mb.km, 2), "feasibility": mn.feasibility}


def run_record(run: RunResult) -> dict:
    """What E6 analyses of one run: per plan option its numbers, and the search report. Keys starting with "_"
    (the stops served, their priorities) are for the comparisons only and never written."""
    options: dict[str, dict] = {}
    for name in OPTIONS:
        sc = _option(run, name)
        if sc is None:
            continue
        m = core.metrics(run.request, sc)
        options[name] = {
            "status": m.status, "cash": asdict(m.cash), "trucks": m.trucks_used, "loads": m.trips,
            "stops_served": m.stops_served, "stops_total": m.stops_total, "cases_served": m.cases_served,
            "cases_total": m.cases_total, "served_by_priority": dict(m.served_by_priority),
            "unserved_by_priority": dict(m.unserved_by_priority), "late_stops": m.late_stops,
            "minutes_outside_pref": m.minutes_outside_pref, "km": m.km, "feasibility": m.feasibility,
            "penalties": dict(m.penalties), "search_sec": sc.solver_time_sec, "_served": sorted(_served_ids(sc))}
    s = run.response.search
    search = None
    if s is not None:
        search = {k: getattr(s, k) for k in ("mode", "cap_sec", "limit_sec", "search_sec", "used_sec", "stop_reason",
                                             "last_improvement_sec", "stall_sec", "solutions")}
        search["best_over_time"] = [list(p) for p in s.best_over_time]
        pv = s.pyvrp
        search["pyvrp"] = ({k: getattr(pv, k) for k in ("status", "reason", "stop_reason", "search_sec", "iterations",
                                                        "chosen_for")} if pv is not None else None)
    return {"seed": run.seed, "wall_sec": run.wall_sec, "env": dict(run.env), "options": options, "search": search,
            "_priority": {st.stop_id: st.priority for st in run.request.stops}}


def _public(obj):
    """``obj`` without the keys that start with "_" (stop ids kept only for the comparisons)."""
    if isinstance(obj, dict):
        return {k: _public(v) for k, v in obj.items() if not str(k).startswith("_")}
    if isinstance(obj, list):
        return [_public(v) for v in obj]
    return obj


def _desc(values: list[float]) -> dict:
    """n, mean, min, max and the sample standard deviation (0 for one value)."""
    return {"n": len(values), "mean": round(statistics.fmean(values), 3), "min": round(min(values), 3),
            "max": round(max(values), 3), "sd": round(statistics.stdev(values), 3) if len(values) > 1 else 0.0}


def _service(opt: dict) -> tuple[int, ...]:
    """Stops served by priority, P1 first: how the engine's strict priorities rank service."""
    return tuple(opt["served_by_priority"][p] for p in range(1, 6))


def spread(records: list[dict]) -> dict:
    """Per plan option, over the runs (seeds): every number's n / mean / min / max / sd, the cash parts' means,
    the mean stops left out per priority, and how many plans the independent check VERIFIED."""
    out: dict[str, dict] = {}
    for name in OPTIONS:
        rows = [r["options"][name] for r in records if name in r["options"]]
        if not rows:
            continue
        out[name] = {"runs": len(rows), "cash": _desc([x["cash"]["total"] for x in rows]),
                     "cash_parts_mean": {k: round(statistics.fmean(x["cash"][k] for x in rows), 3) for k in CASH_PARTS},
                     **{k: _desc([float(x[k]) for x in rows]) for k in ("trucks", "loads", "stops_served", "cases_served",
                                                                        "km", "late_stops", "minutes_outside_pref",
                                                                        "search_sec")},
                     "unserved_by_priority_mean": {p: round(statistics.fmean(x["unserved_by_priority"][p] for x in rows), 2)
                                                   for p in range(1, 6)},
                     "stops_total": rows[0]["stops_total"], "cases_total": rows[0]["cases_total"],
                     "verified": sum(1 for x in rows if x["feasibility"] == "VERIFIED"),
                     "status": dict(Counter(x["status"] for x in rows))}
    return out


def option_choice(records: list[dict]) -> dict:
    """Per run: the options that reach the run's best service (most P1 stops served, then P2, ...) and the
    cheapest of them (a tie counts for each); runs where all three serve alike; runs where RECOMMENDED serves less
    than the best option; and runs where RECOMMENDED leaves out a stop another option serves (those stops counted
    by priority)."""
    cheapest, at_best, left_out = Counter(), Counter(), Counter()
    runs = alike = behind = out_runs = 0
    for r in records:
        opts = r["options"]
        if not opts:
            continue
        runs += 1
        svc = {k: _service(v) for k, v in opts.items()}
        best = max(svc.values())
        top = [k for k in opts if svc[k] == best]
        low = min(opts[k]["cash"]["total"] for k in top)
        at_best.update(top)
        cheapest.update(k for k in top if opts[k]["cash"]["total"] <= low + 0.0005)
        alike += len(opts) == len(OPTIONS) and len(set(svc.values())) == 1
        rec = opts.get("RECOMMENDED")
        if rec is None:
            continue
        behind += svc["RECOMMENDED"] < best
        others = set().union(*(set(v["_served"]) for k, v in opts.items() if k != "RECOMMENDED"))
        missed = others - set(rec["_served"])
        if missed:
            out_runs += 1
            left_out.update(r["_priority"][s] for s in missed)
    return {"runs": runs, "cheapest_at_best_service": {k: cheapest[k] for k in OPTIONS},
            "at_best_service": {k: at_best[k] for k in OPTIONS}, "all_three_alike": alike,
            "recommended_serves_less": behind, "recommended_leaves_out_runs": out_runs,
            "recommended_leaves_out_by_priority": {p: left_out[p] for p in range(1, 6)}}


def convergence(records: list[dict], marks: tuple[int, ...] = CONVERGENCE_MARKS) -> dict:
    """THOROUGH runs: why and when RECOMMENDED's search stopped, and how far above its final search objective the
    best plan found by each mark was (best_over_time). The objective is the route search's own score - cash-like
    costs plus ARTIFICIAL penalties, 1,000 OMR or more per stop not planned yet - not cash, and it is the search's
    before the load re-check. The report keeps at most 12 points, so a value at a mark (the last kept point by
    then) is an upper bound of the true one."""
    rows = []
    for r in records:
        s = r["search"]
        if not s or s["mode"] != "THOROUGH":
            continue
        pts = s["best_over_time"]
        row = {"seed": r["seed"], "wall_sec": r["wall_sec"], "pyvrp": s["pyvrp"],
               **{k: s[k] for k in ("stop_reason", "limit_sec", "search_sec", "used_sec", "cap_sec",
                                    "last_improvement_sec", "stall_sec", "solutions")},
               "end_objective": pts[-1][1] if pts else None, "at": {}}
        for x in marks:
            upto = [p for p in pts if p[0] <= x]
            row["at"][x] = ({"above_end": round(upto[-1][1] - pts[-1][1], 2),
                             "not_planned": upto[-1][2] if len(upto[-1]) > 2 else None} if upto else None)
        rows.append(row)
    summary = {}
    for x in marks:
        vals = [row["at"][x]["above_end"] for row in rows if row["at"][x] is not None]
        summary[x] = {"runs": len(vals), "above_end": _desc(vals) if vals else None,
                      "still_searching": sum(1 for row in rows if (row["search_sec"] or 0) > x)}
    return {"runs": rows, "summary": summary, "stop_reasons": dict(Counter(row["stop_reason"] for row in rows))}


def pyvrp_summary(records: list[dict]) -> dict:
    """What the second route search did over the runs: its status (with the reason) and the options it was
    chosen for."""
    status, chosen = Counter(), Counter()
    for r in records:
        pv = (r["search"] or {}).get("pyvrp")
        if pv is None:
            status["no report"] += 1
            continue
        status[pv["status"] + (f" ({pv['reason']})" if pv.get("reason") else "")] += 1
        chosen.update(pv.get("chosen_for") or [])
    return {"status": dict(status), "chosen_for": {k: chosen[k] for k in OPTIONS}}


def prod_vs_quick(prod: list[dict], quick: list[dict]) -> dict:
    """PROD - QUICKP per plan option, paired by seed (the same stop order and second-search seed) over the seeds
    both have, and how often PROD's plan serves more (by priority), less, or alike for less, more or the same cash."""
    q = {r["seed"]: r for r in quick}
    pairs = [(p, q[p["seed"]]) for p in prod if p["seed"] in q]
    out: dict = {"seeds": [p["seed"] for p, _ in pairs], "options": {}}
    numbers: dict[str, Callable[[dict], float]] = {
        "cash": lambda o: o["cash"]["total"], "stops_served": lambda o: o["stops_served"],
        "trucks": lambda o: o["trucks"], "loads": lambda o: o["loads"], "km": lambda o: o["km"]}
    for name in OPTIONS:
        both = [(a["options"][name], b["options"][name]) for a, b in pairs if name in a["options"] and name in b["options"]]
        if not both:
            continue
        same = [(a, b) for a, b in both if _service(a) == _service(b)]
        cheaper = sum(1 for a, b in same if a["cash"]["total"] < b["cash"]["total"] - 0.0005)
        dearer = sum(1 for a, b in same if a["cash"]["total"] > b["cash"]["total"] + 0.0005)
        out["options"][name] = {"pairs": len(both), **{k: _desc([get(a) - get(b) for a, b in both]) for k, get in numbers.items()},
                                "prod_serves_more": sum(1 for a, b in both if _service(a) > _service(b)),
                                "prod_serves_less": sum(1 for a, b in both if _service(a) < _service(b)),
                                "alike_prod_cheaper": cheaper, "alike_prod_dearer": dearer,
                                "alike_same_cash": len(same) - cheaper - dearer}
    return out


def stability(base: RunResult, perturbed: list[tuple[str, dict, RunResult]], reruns: list[RunResult]) -> dict:
    """Each perturbed day's plans against the base plans (plan_moves, every option), with whether the changed stop
    is served before and after; and, as the reference, the same day's other seeds against the base (RECOMMENDED):
    how much a plan moves with no change of the day at all."""
    rows = []
    for kind, what, run in perturbed:
        for name in OPTIONS:
            mv = plan_moves(base, run, name)
            if mv is None:
                continue
            row = {"perturbation": kind, "option": name, "change": what["change"], **mv}
            if "stop" in what:
                row["changed_stop_served_before"] = what["stop"] in _served_ids(_option(base, name))
                row["changed_stop_served_after"] = what["stop"] in _served_ids(_option(run, name))
            if "stops_on_it" in what and name == "RECOMMENDED":
                row["stops_on_unavailable_truck"] = what["stops_on_it"]
            rows.append(row)
    seeds = [m for r in reruns if (m := plan_moves(base, r, "RECOMMENDED")) is not None]
    ref = ({k: _desc([float(m[k]) for m in seeds]) for k in ("stops_moved", "stops_other_truck", "trucks_changed",
                                                             "cash_change", "served_change")} if seeds else None)
    return {"rows": rows, "seed_reference": ref, "seed_reference_seeds": [r.seed for r in reruns]}


class E6(Experiment):
    """The engine as production runs it, over several seeds and days: PROD (THOROUGH) and QUICKP (QUICK), all
    three plan options in one response; on the real days also how far the plan moves after a small change of the
    day (QUICKP, seed 1, PERTURBATIONS)."""

    name, slug, title = "E6", "E6-production", "Model behaviour at production settings"
    DAYS = ("REAL-15OCT", "REAL-15OCT-PREFIX", "SYNTH-320", "SYNTH-320-S2", "SYNTH-400-S3")
    QUICK_DAYS = ("REAL-15OCT", "REAL-15OCT-PREFIX", "SYNTH-320")
    VARIANTS = ("PROD", "QUICKP")
    PHASE = 6

    @staticmethod
    def settings(suite: Suite) -> dict[str, Setting]:
        return {"PROD": Setting("PROD", "THOROUGH", cap_sec=suite.prod_cap),
                "QUICKP": Setting("QUICKP", "QUICK", time_limit_sec=2 if suite.quick else None)}

    @staticmethod
    def seeds(variant: str, day: Day, suite: Suite) -> tuple[int, ...]:
        return suite.e6_real_prod_seeds if variant == "PROD" and day.real else suite.e6_seeds

    @staticmethod
    def describe_day(day: Day) -> str:
        if day.real:
            return day.describe()
        n, seed = SYNTH_DAYS[day.name]
        return f"SYNTHETIC ({n} invoices, synth seed {seed}); {len(day.request.stops)} stops, {len(day.request.trucks)} trucks"

    def groups(self, suite: Suite, days: Days) -> list[Group]:
        settings, out = self.settings(suite), []
        for name in self.QUICK_DAYS if suite.quick else self.DAYS:
            day = days.get(name)
            if day is None:
                out.append(Group(self.name, name, self.PHASE, skipped=days.why(name)))
                continue
            items = [Item(self.name, name, v, s, settings[v].tag) for v in self.VARIANTS for s in self.seeds(v, day, suite)]
            if day.real:
                items += [Item(self.name, name, p, 1, settings["QUICKP"].tag) for p in PERTURBATIONS]
            out.append(Group(self.name, name, self.PHASE, items))
        return out

    @staticmethod
    def _done(run: RunResult) -> dict:
        s = run.response.search
        return {"solve_sec": run.wall_sec, "stop_reason": s.stop_reason if s is not None else None}

    def run(self, item: Item, suite: Suite, days: Days, cache: RunCache) -> dict:
        day = days.get(item.day)
        settings = self.settings(suite)
        with cache.scope(self.name, day.name, {core.digest(day.request): "base"}):
            if item.variant in settings:
                return self._done(cache.solve_setting(day.request, settings[item.variant], item.seed))
            base = cache.solve_setting(day.request, settings["QUICKP"], 1)
        preq, what = perturb(day.request, item.variant, _recommended(base))
        with cache.scope(self.name, day.name, {core.digest(preq): item.variant}):
            run = cache.solve_setting(preq, settings["QUICKP"], 1)
        return {"change": what["change"], **self._done(run)}

    def report(self, group: Group, suite: Suite, days: Days, cache: RunCache) -> tuple[dict, list[str]]:
        """Every cached run of the day; the runs not cached yet are listed and the day is PARTIAL (MissingRun only
        when none is cached)."""
        day = days.get(group.day)
        settings = self.settings(suite)
        runs: dict[str, list[RunResult]] = {v: [] for v in self.VARIANTS}
        missing: list[str] = []
        with cache.scope(self.name, day.name, {core.digest(day.request): "base"}):
            for v in self.VARIANTS:
                for s in self.seeds(v, day, suite):
                    try:
                        runs[v].append(cache.solve_setting(day.request, settings[v], s))
                    except MissingRun as e:
                        missing.append(str(e))
        base = next((r for r in runs["QUICKP"] if r.seed == 1), None)
        perturbed: list[tuple[str, dict, RunResult]] = []
        for kind in PERTURBATIONS if day.real else ():
            if base is None:
                missing.append(f"{kind} (needs QUICKP seed 1)")
                continue
            preq, what = perturb(day.request, kind, _recommended(base))
            try:
                with cache.scope(self.name, day.name, {core.digest(preq): kind}):
                    perturbed.append((kind, what, cache.solve_setting(preq, settings["QUICKP"], 1)))
            except MissingRun as e:
                missing.append(str(e))
        if not any(runs.values()):
            raise MissingRun(missing[0])
        records = {v: [run_record(r) for r in rs] for v, rs in runs.items()}
        done = {v: rs for v, rs in records.items() if rs}
        analysis = {
            "spread": {v: spread(rs) for v, rs in done.items()},
            "wall_sec": {v: _desc([r["wall_sec"] for r in rs]) for v, rs in done.items()},
            "option_choice": {v: option_choice(rs) for v, rs in done.items()},
            "convergence": convergence(records["PROD"]),
            "pyvrp": {v: pyvrp_summary(rs) for v, rs in done.items()},
            "prod_vs_quickp": prod_vs_quick(records["PROD"], records["QUICKP"]),
            "stability": (stability(base, perturbed, [r for r in runs["QUICKP"] if r.seed != 1])
                          if day.real and base is not None else None),
        }
        payload = {"day": self.describe_day(day), "settings": {v: s.describe() for v, s in settings.items()},
                   "seeds": {v: [r.seed for r in rs] for v, rs in runs.items()},
                   "runs": {v: [_public(r) for r in rs] for v, rs in records.items()},
                   "analysis": analysis, "missing": missing}
        if missing:
            payload["_status"] = "PARTIAL"
        return payload, self._markdown(day, suite, runs, perturbed, analysis, missing)

    def _markdown(self, day: Day, suite: Suite, runs: dict[str, list[RunResult]],
                  perturbed: list[tuple[str, dict, RunResult]], a: dict, missing: list[str]) -> list[str]:
        L = [f"## {day.name}: {self.describe_day(day)}", "",
             "Runs: " + "; ".join(f"{v} seeds {[r.seed for r in runs[v]]} of {list(self.seeds(v, day, suite))}"
                                  for v in self.VARIANTS)
             + (f"; perturbations {len(perturbed)} of {len(PERTURBATIONS)} (QUICKP, seed 1)" if day.real else "") + "."]
        if missing:
            L += ["", f"PARTIAL: {len(missing)} run(s) not in the cache yet (first: {missing[0]}); the tables use the "
                      "runs that are."]
        L += ["", "### Spread over the seeds", "",
              "| variant | option | runs | cash OMR, mean [min..max] | cash sd | trucks | loads | stops served | cases "
              "served | stops left out P1/P2/P3/P4/P5 (mean) | late stops (max) | min outside preferred windows | "
              "estimated km | VERIFIED | option's search s | whole request s |",
              "|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|"]
        for v in self.VARIANTS:
            for name, o in a["spread"].get(v, {}).items():
                L.append(f"| {v} | {name} | {o['runs']} | {_fmt(o['cash'], 2, False)} | {o['cash']['sd']:.2f} | "
                         f"{_fmt(o['trucks'], 1, False)} | {_fmt(o['loads'], 1, False)} | "
                         f"{_fmt(o['stops_served'], 1, False)} of {o['stops_total']} | "
                         f"{_fmt(o['cases_served'], 0, False)} of {o['cases_total']} | "
                         + "/".join(f"{o['unserved_by_priority_mean'][p]:g}" for p in range(1, 6))
                         + f" | {o['late_stops']['max']:g} | {_fmt(o['minutes_outside_pref'], 0, False)} | "
                         f"{_fmt(o['km'], 1, False)} | {o['verified']}/{o['runs']} | {_fmt(o['search_sec'], 0, False)} | "
                         f"{_fmt(a['wall_sec'][v], 0, False)} |")
        L += ["", "Cash parts, mean OMR (costing.truck_day_costs):", "",
              "| variant | option | " + " | ".join(CASH_PARTS) + " |", "|---|---|" + "---|" * len(CASH_PARTS)]
        for v in self.VARIANTS:
            for name, o in a["spread"].get(v, {}).items():
                L.append(f"| {v} | {name} | " + " | ".join(f"{o['cash_parts_mean'][k]:.2f}" for k in CASH_PARTS) + " |")
        L += ["", "### Which option is cheapest, and does RECOMMENDED leave out what another option serves", "",
              "| variant | runs | cheapest at the run's best service: RECOMMENDED / MIN_TRUCKS / MIN_DISTANCE | reach "
              "the best service: R / MT / MD | all three serve alike | RECOMMENDED serves less than the best option | "
              "runs where RECOMMENDED leaves out a stop another option serves | those stops, P1/P2/P3/P4/P5 |",
              "|---|---|---|---|---|---|---|---|"]
        for v, c in a["option_choice"].items():
            L.append(f"| {v} | {c['runs']} | " + " / ".join(str(c["cheapest_at_best_service"][k]) for k in OPTIONS)
                     + " | " + " / ".join(str(c["at_best_service"][k]) for k in OPTIONS)
                     + f" | {c['all_three_alike']} | {c['recommended_serves_less']} | {c['recommended_leaves_out_runs']} | "
                     + "/".join(str(c["recommended_leaves_out_by_priority"][p]) for p in range(1, 6)) + " |")
        L += ["", "Best service: the most P1 stops served, then P2, and so on (the engine's strict priorities). A tie "
                  "for cheapest counts for each option in it."]
        conv = a["convergence"]
        if conv["runs"]:
            marks = " / ".join(f"{x}" for x in CONVERGENCE_MARKS)
            L += ["", "### Convergence of PROD (THOROUGH)", "",
                  f"| seed | stopped | RECOMMENDED search s (limit) | whole request s (cap) | last improvement s | "
                  f"search objective above its end at {marks} s | stops not yet planned at {marks} s | second search "
                  "(PyVRP) |", "|---|---|---|---|---|---|---|---|"]
            for r in conv["runs"]:
                above = " / ".join("-" if r["at"][x] is None else f"{r['at'][x]['above_end']:.1f}" for x in CONVERGENCE_MARKS)
                left = " / ".join("-" if r["at"][x] is None or r["at"][x]["not_planned"] is None
                                  else str(r["at"][x]["not_planned"]) for x in CONVERGENCE_MARKS)
                pv = r["pyvrp"] or {}
                pv_text = (f"{pv.get('status')}" + (f" ({pv['reason']})" if pv.get("reason") else "")
                           + (f", chosen for {', '.join(pv['chosen_for'])}" if pv.get("chosen_for") else "")) if pv else "-"
                L.append(f"| {r['seed']} | {r['stop_reason']} | {r['search_sec']} ({r['limit_sec']}) | {r['used_sec']} "
                         f"({r['cap_sec']}) | {r['last_improvement_sec'] if r['last_improvement_sec'] is not None else '-'} | "
                         f"{above} | {left} | {pv_text} |")
            over = "; ".join(f"at {x} s mean {s['above_end']['mean']:.1f} [max {s['above_end']['max']:.1f}] above the "
                             f"end, {s['still_searching']} of {len(conv['runs'])} still searching"
                             for x, s in conv["summary"].items() if s["above_end"])
            L += ["", "Search objective: the route search's own score before the load re-check - cash-like costs plus "
                      "ARTIFICIAL penalties (1,000 OMR or more for each stop not planned yet) - not cash. A value at a "
                      "mark is the last of at most 12 kept points by then, so the true gap is at most that. '-': no "
                      "plan by then." + (f" Over the runs: {over}." if over else "")]
        L += ["", "Second route search (PyVRP): " + "; ".join(
            f"{v}: " + ", ".join(f"{k} {n}" for k, n in sorted(p["status"].items()))
            + " - chosen for " + ", ".join(f"{k} {p['chosen_for'][k]}" for k in OPTIONS) for v, p in a["pyvrp"].items()) + "."]
        pq = a["prod_vs_quickp"]
        if pq["options"]:
            L += ["", "### PROD against QUICKP (PROD - QUICKP, paired by seed)", "",
                  f"Seeds {pq['seeds']}. Whole request: PROD {_fmt(a['wall_sec'].get('PROD'), 0, False)} s, QUICKP "
                  f"{_fmt(a['wall_sec'].get('QUICKP'), 0, False)} s.", "",
                  "| option | pairs | Δ cash OMR | Δ stops served | Δ trucks | Δ loads | Δ estimated km | PROD serves more "
                  "/ less | alike: PROD cheaper / dearer / same cash |", "|---|---|---|---|---|---|---|---|---|"]
            for name, d in pq["options"].items():
                L.append(f"| {name} | {d['pairs']} | {_fmt(d['cash'])} | {_fmt(d['stops_served'], 1)} | "
                         f"{_fmt(d['trucks'], 1)} | {_fmt(d['loads'], 1)} | {_fmt(d['km'], 1)} | "
                         f"{d['prod_serves_more']} / {d['prod_serves_less']} | {d['alike_prod_cheaper']} / "
                         f"{d['alike_prod_dearer']} / {d['alike_same_cash']} |")
            L += ["", "Serving more stops costs more cash: read Δ cash with Δ stops served."]
        st = a["stability"]
        if st is not None:
            L += ["", "### Stability: the plan after a small change of the day (QUICKP, seed 1, RECOMMENDED)", "",
                  "| change | stops moved (truck or load) | stops on another truck | trucks used before -> after "
                  "(changed) | Δ cash OMR | Δ other stops served | Δ loads | the changed stop | VERIFIED |",
                  "|---|---|---|---|---|---|---|---|---|"]
            for r in (x for x in st["rows"] if x["option"] == "RECOMMENDED"):
                stop = "-"
                if "changed_stop_served_before" in r:
                    stop = {"P1": "served before" if r["changed_stop_served_before"] else "was left out before",
                            "P5": "served" if r["changed_stop_served_after"] else "left out"}.get(
                        r["perturbation"], f"served {'yes' if r['changed_stop_served_before'] else 'no'} -> "
                                           f"{'yes' if r['changed_stop_served_after'] else 'no'}")
                if "stops_on_unavailable_truck" in r:
                    stop = f"{r['stops_on_unavailable_truck']} stops had to leave the truck"
                L.append(f"| {r['perturbation']}: {r['change']} | {r['stops_moved']} | {r['stops_other_truck']} | "
                         f"{r['trucks_before']} -> {r['trucks_after']} ({r['trucks_changed']}) | {r['cash_change']:+.2f} | "
                         f"{r['served_change']:+d} | {r['loads_change']:+d} | {stop} | {r['feasibility']} |")
            ref = st["seed_reference"]
            if ref:
                L += ["", f"Reference with no change of the day: the plans of seeds {st['seed_reference_seeds']} "
                          f"against seed 1's moved {_fmt(ref['stops_moved'], 1, False)} stops "
                          f"({_fmt(ref['stops_other_truck'], 1, False)} to another truck), cash "
                          f"{_fmt(ref['cash_change'])} OMR, other stops served {_fmt(ref['served_change'], 1)}."]
            L += ["", "Each changed day is solved from scratch, as a new OPTIMIZE (no plan continuity: no previous truck "
                      "ids), and compared with the base plan. 'Stops moved': stops of both plans on another truck or "
                      "load number. 'Other stops served': stops of both days. P0 is the control: the same day solved "
                      "again, so whatever moves there is the timed search's own variation. All three options are in "
                      "the JSON."]
        return L + [""]

    def about(self, suite: Suite) -> list[str]:
        return ["Days: the real 15 Oct request (86 stops) and the pre-fix 15 Oct request (94 stops), anonymised, and "
                "three SYNTHETIC days (320 invoices, synth seeds 1 and 2; 400 invoices, synth seed 3). Variants: "
                "PROD = THOROUGH as the requests ask (cap 1,200 s for the whole request, the engine's stall rule: stop "
                "once the best plan has not improved for max(300 s, half the time searched)); QUICKP = QUICK, the "
                "automatic time by day size. Both return RECOMMENDED, MIN_TRUCKS and MIN_DISTANCE in one response, with "
                "worker processes and the second route search, as production. Perturbations on the real days: "
                + "; ".join(f"{k} {v}" for k, v in PERTURBATIONS.items()) + "."
                + (" QUICK smoke: one seed, a 20 s THOROUGH cap, 2 s QUICK, three days." if suite.quick else "")]

    def meta(self, suite: Suite) -> dict:
        settings = self.settings(suite)
        return {"budget_head": "Settings", "budgets": {v: s.describe() for v, s in settings.items()},
                "seeds": f"PROD on a real day {list(suite.e6_real_prod_seeds)}, every other run {list(suite.e6_seeds)}, "
                         "perturbations 1",
                "env": {"set": {v: dict(s.env) for v, s in settings.items()}, "cleared": list(TUNING_ENV)},
                "equal_compute": PRODUCTION}


EXPERIMENTS: dict[str, Experiment] = {e.name: e for e in (E1(), E2(), E3(), E4(), E5(), E6())}
ALL = ("E1", "E2", "E3", "E4", "E5")  # what `all` runs; E6 runs alone (production settings, hours of compute)


# ------------------------------------------------------------------------------------------------------------
# Lanes and reports
# ------------------------------------------------------------------------------------------------------------

def plan(names: list[str], suite: Suite, days: Days) -> list[Group]:
    """The run lists of the experiments, in the order `all` runs them (E3's long simulations first, SYNTH-400
    last)."""
    groups = [g for n in names for g in EXPERIMENTS[n].groups(suite, days)]
    return sorted(groups, key=lambda g: (g.phase, names.index(g.experiment)))


def lane_items(groups: list[Group], lane: int, lanes: int) -> list[Item]:
    """Lane ``lane``'s share: every ``lanes``-th item of each group, from item ``lane``."""
    return [it for g in groups for it in g.items[lane::lanes]]


def run_lane(groups: list[Group], suite: Suite, days: Days, cache: RunCache, lane: int, lanes: int,
             steal: bool = True) -> int:
    """Run this lane's items, then (``steal``) any item no live lane has claimed. Returns the number of failures."""
    mine = lane_items(groups, lane, lanes)
    own = set(mine)
    queue = mine + ([it for g in groups for it in g.items if it not in own] if steal else [])
    failed = 0
    with cache.hooked():
        for n, item in enumerate(queue, start=1):
            if cache.done(item) is not None or not cache.claim(item):
                continue
            started, t0 = _now(), time.perf_counter()
            try:
                try:
                    info = EXPERIMENTS[item.experiment].run(item, suite, days, cache)
                except Exception:  # noqa: BLE001 - one failed item must not stop the lane
                    failed += 1
                    _say(f"[lane {lane}/{lanes}] FAILED {item.key}\n{traceback.format_exc()}")
                    continue
                wall = round(time.perf_counter() - t0, 1)
                cache.mark_done(item, {"started_at": started, "finished_at": _now(), "wall_sec": wall,
                                       "lane": f"{lane}/{lanes}", "host": socket.gethostname(), **info})
            finally:
                cache.release(item)  # after the marker: no other lane can start a finished item
            _say(f"[lane {lane}/{lanes}] {item.key}: {wall:.0f} s ({n}/{len(queue)}{', helping' if n > len(mine) else ''})")
    return failed


def _meta(exp: Experiment, groups: list[Group], suite: Suite, cache: RunCache, params: dict) -> dict:
    infos = [cache.done(it) for g in groups for it in g.items]
    done = [x for x in infos if x]
    budgets = {"real_sec": suite.budget_real, "synthetic_sec": suite.budget_synth}
    if exp.name == "E3":
        budgets["replan_sec"] = suite.budget_replan
    if exp.name == "E5":
        budgets = {"engine_sec": suite.budget_exact}
    return {
        "commit": cache.commit, "generated_at": _now(), "quick": suite.quick, "budgets": budgets,
        "budget_head": "Budgets (search seconds per run; the engine's load re-check comes on top)",
        "seeds": list(suite.seeds) if exp.name in ("E1", "E2", "E4") else [1], "machine": machine(),
        "run_hosts": sorted({x.get("host", "?") for x in done}), "lanes": sorted({x.get("lane", "?") for x in done}),
        "env": dict(ENV), "equal_compute": EQUAL_COMPUTE, "honesty": HONESTY,
        "items": {"total": len(infos), "done": len(done)},
        "compute_sec": round(sum(x["wall_sec"] for x in done), 1),
        "first_start": min((x["started_at"] for x in done), default=None),
        "last_finish": max((x["finished_at"] for x in done), default=None),
        "ivms": params, "labels": dict(core.LABELS),
    } | exp.meta(suite)


def _elapsed_min(meta: dict) -> float | None:
    if not meta["first_start"]:
        return None
    a, b = (datetime.fromisoformat(meta[k]) for k in ("first_start", "last_finish"))
    return round((b - a).total_seconds() / 60, 1)


def write_report(exp: Experiment, groups: list[Group], suite: Suite, days: Days, cache: RunCache,
                 out_dir: Path, params: dict) -> dict:
    """The experiment's JSON and Markdown, from the cache only. A day whose runs are not all cached yet is
    marked INCOMPLETE; a real day without its file is SKIPPED."""
    meta = _meta(exp, groups, suite, cache, params)
    mc = meta["machine"]
    elapsed = _elapsed_min(meta)
    md = [f"# {exp.name}: {exp.title}", "",
          f"- Commit {cache.commit}; written {meta['generated_at']}" + (" (QUICK smoke settings)" if suite.quick else "") + ".",
          f"- {meta['budget_head']}: "
          + ", ".join(f"{k} {v}" for k, v in meta["budgets"].items()) + f"; seeds {meta['seeds']}.",
          f"- Machine: {mc['nproc']} CPUs, {mc['cpu']}; Python {mc['python']}; OR-Tools {mc['ortools']}.",
          f"- Items done {meta['items']['done']}/{meta['items']['total']}; compute {meta['compute_sec'] / 60:.1f} min "
          f"(sum of item wall times); wall time {elapsed if elapsed is not None else '-'} min (first start to last "
          f"finish); lanes {', '.join(meta['lanes']) or '-'}.",
          f"- {meta['equal_compute']}", f"- {HONESTY}", "", *exp.about(suite), ""]
    if exp.ivms_keys:
        md += ["IVMS-derived parameters used (committed aggregates of the owner's IVMS report and the 13 Oct truck "
               "evidence):", *_ivms_lines(params, exp.ivms_keys), ""]
    out_days: dict[str, dict] = {}
    for g in groups:
        markers = [m for m in (cache.done(it) for it in g.items) if m]
        done, compute = len(markers), round(sum(m["wall_sec"] for m in markers), 1)
        if g.skipped:
            out_days[g.day] = {"status": "SKIPPED", "why": g.skipped}
            md += [f"## {g.day}", "", f"SKIPPED: {g.skipped}.", ""]
            continue
        try:
            payload, lines = exp.report(g, suite, days, cache)
        except MissingRun as e:
            out_days[g.day] = {"status": "INCOMPLETE", "items_done": done, "items": len(g.items), "compute_sec": compute,
                               "missing": str(e)}
            md += [f"## {g.day}", "", f"INCOMPLETE: {done}/{len(g.items)} items done; first run missing: {e}.", ""]
            continue
        status = payload.pop("_status", "COMPLETE")
        out_days[g.day] = {"status": status, "items_done": done, "items": len(g.items), "compute_sec": compute,
                           **payload}
        md += lines
    payload = {"experiment": exp.name, "title": exp.title, "meta": meta, "days": out_days}
    text = _checked(json.dumps(_rounded(payload), indent=1, default=str), days)
    body = _checked("\n".join(md).rstrip() + "\n", days)
    out_dir.mkdir(parents=True, exist_ok=True)
    (out_dir / f"{exp.slug}.json").write_text(text + "\n", encoding="utf-8")
    (out_dir / f"{exp.slug}.md").write_text(body, encoding="utf-8")
    return payload


def report_all(names: list[str], groups: list[Group], suite: Suite, days: Days, cache: RunCache, out_dir: Path) -> None:
    """--report: every named experiment's files and INDEX.md, from the cache alone (``cache`` read-only)."""
    params = ivms_parameters()
    with cache.hooked():
        for n in names:
            write_report(EXPERIMENTS[n], [g for g in groups if g.experiment == n], suite, days, cache, out_dir, params)
            _say(f"wrote {out_dir / EXPERIMENTS[n].slug}.md and .json")
    write_index(out_dir)


def write_index(out_dir: Path) -> None:
    """INDEX.md over every experiment JSON in ``out_dir``."""
    lines = ["# Decision-support evidence (DESIGN.md section 6)", "",
             "Written by `python -m decision_support.experiments all --report` (E1-E5) and `... e6 --report` (E6) from "
             "the run cache. E1-E5: " + EQUAL_COMPUTE + " E6 runs the engine at production settings instead (its file "
             "says how).", "", HONESTY, "", "| Experiment | Day | Status | Items done | Commit | Compute min | Files |",
             "|---|---|---|---|---|---|---|"]
    for path in sorted(out_dir.glob("E*.json")):
        data = json.loads(path.read_text(encoding="utf-8"))
        meta = data["meta"]
        for day, d in data["days"].items():
            items = f"{d.get('items_done', 0)}/{d.get('items', 0)}" if d["status"] != "SKIPPED" else "-"
            compute = f"{d['compute_sec'] / 60:.1f}" if "compute_sec" in d else "-"
            lines.append(f"| {data['experiment']} {data['title']} | {day} | {d['status']} | {items} | {meta['commit']}"
                         f"{' QUICK' if meta['quick'] else ''} | {compute} | "
                         f"[{path.stem}.md]({path.stem}.md), [{path.name}]({path.name}) |")
    (out_dir / "INDEX.md").write_text("\n".join(lines) + "\n", encoding="utf-8")


# ------------------------------------------------------------------------------------------------------------
# Command line
# ------------------------------------------------------------------------------------------------------------

def git_commit() -> str:
    """This checkout's commit (12 hex digits), with -dirty when apps/solver has uncommitted changes."""
    try:
        head = subprocess.run(["git", "-C", str(REPO), "rev-parse", "--short=12", "HEAD"], capture_output=True,
                              text=True, check=True, timeout=30).stdout.strip()
        dirty = subprocess.run(["git", "-C", str(REPO), "status", "--porcelain", "--", "apps/solver"],
                               capture_output=True, text=True, check=True, timeout=30).stdout.strip()
    except (OSError, subprocess.SubprocessError):
        return "unknown"
    return head + ("-dirty" if dirty else "")


def _lane(text: str) -> tuple[int, int]:
    i, n = (int(x) for x in text.split("/"))
    if not 0 <= i < n:
        raise argparse.ArgumentTypeError("--lane i/n needs 0 <= i < n")
    return i, n


def _seeds(text: str) -> tuple[int, ...]:
    seeds = tuple(int(s) for s in text.split(","))
    if not seeds or any(s < 0 for s in seeds) or len(set(seeds)) != len(seeds):
        raise argparse.ArgumentTypeError("seeds: distinct non-negative integers, comma-separated")
    return seeds


def _cap(text: str) -> int:
    cap = int(text)
    if not 10 <= cap <= ds.THOROUGH_MAX_SEC:
        raise argparse.ArgumentTypeError(f"--prod-cap needs 10..{ds.THOROUGH_MAX_SEC} seconds")
    return cap


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="python -m decision_support.experiments",
                                 description="The decision-support evidence suite (DESIGN.md section 6).")
    ap.add_argument("experiment", choices=("e1", "e2", "e3", "e4", "e5", "e6", "all"),
                    help="all = E1-E5; E6 runs alone")
    ap.add_argument("--out-dir", type=Path, help=f"default {DEFAULT_OUT} (QUICK: <cache-dir>/quick-results)")
    ap.add_argument("--cache-dir", type=Path, default=DEFAULT_CACHE)
    ap.add_argument("--data-dir", type=Path, default=DEFAULT_DATA, help="the real requests (never in the repository)")
    ap.add_argument("--lane", type=_lane, default=(0, 1), metavar="i/n")
    ap.add_argument("--budget-real", type=int, default=20, help="search seconds per run on a real day")
    ap.add_argument("--budget-synth", type=int, default=40, help="search seconds per run on a synthetic day")
    ap.add_argument("--budget-replan", type=int, default=10, help="E3: search seconds per re-plan")
    ap.add_argument("--seeds", default="1,2,3", help="comma-separated solver seeds (E1, E2, E4)")
    ap.add_argument("--e6-seeds", type=_seeds, default=Suite.e6_seeds, metavar="1,2,...",
                    help="E6: seeds of every variant and day, except PROD on a real day (default 1,2,3,4,5)")
    ap.add_argument("--e6-real-prod-seeds", type=_seeds, default=Suite.e6_real_prod_seeds, metavar="1,2,...",
                    help="E6: seeds of PROD on a real day, a 20-minute run each (default 1,2,3)")
    ap.add_argument("--prod-cap", type=_cap, default=ds.THOROUGH_MAX_SEC,
                    help="E6: THOROUGH cap in seconds (default the requests' 1200; a lower cap is no longer production)")
    ap.add_argument("--quick", action="store_true", help="tiny smoke settings (ignores the budget and seed options)")
    ap.add_argument("--report", action="store_true", help="only aggregate the cache into the output files")
    ap.add_argument("--plan", action="store_true", help="print the run lists and this lane's share; solve nothing")
    ap.add_argument("--commit", help="the cache's commit (default: this checkout's HEAD)")
    ap.add_argument("--no-steal", action="store_true", help="run this lane's own items only")
    ap.add_argument("--only", metavar="REGEX", help="run only the items whose key matches (e.g. 'E1/SYNTH-320/baseline/')")
    a = ap.parse_args(argv)
    if a.only and a.report:
        ap.error("--only selects items to run; --report always needs every run of an experiment")
    os.environ.update(ENV)  # E1-E5's equal compute; E6 sets its own switches for each run (Setting.env)
    suite = Suite.smoke(a.data_dir) if a.quick else Suite(
        budget_real=a.budget_real, budget_synth=a.budget_synth, budget_replan=a.budget_replan,
        seeds=tuple(int(s) for s in a.seeds.split(",")), data_dir=a.data_dir, e6_seeds=a.e6_seeds,
        e6_real_prod_seeds=a.e6_real_prod_seeds, prod_cap=a.prod_cap)
    names = list(ALL) if a.experiment == "all" else [a.experiment.upper()]
    days = Days(suite.data_dir)
    cache = RunCache(a.cache_dir, a.commit or git_commit(), read_only=a.report)
    groups = plan(names, suite, days)
    if a.only:
        for g in groups:
            g.items = [it for it in g.items if re.search(a.only, it.key)]
    lane, lanes = a.lane
    if a.plan:
        for g in groups:
            share = len(g.items[lane::lanes])
            print(f"{g.experiment} {g.day:<18} phase {g.phase}: {len(g.items):4d} items, lane {lane}/{lanes} {share:4d}"
                  + (f"  [{g.skipped}]" if g.skipped else ""))
        return 0
    if a.report:
        report_all(names, groups, suite, days, cache, a.out_dir or (a.cache_dir / "quick-results" if a.quick else DEFAULT_OUT))
        return 0
    _say(f"lane {lane}/{lanes}: {len(lane_items(groups, lane, lanes))} own items of "
         f"{sum(len(g.items) for g in groups)}; cache {cache.dir}; env "
         + ("per run (E6 settings)" if names == ["E6"] else str(ENV)))
    failed = run_lane(groups, suite, days, cache, lane, lanes, steal=not a.no_steal)
    _say(f"lane {lane}/{lanes} finished, {failed} failed item(s)")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
