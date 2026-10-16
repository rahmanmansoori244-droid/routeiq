"""Replay saved dispatch requests through the optimizer, arm against arm: the gate for switching on the solver
search upgrade's flags (best-of-N route search, PyVRP on small-truck-only days, the priority repair).

Every one of those flags ships off. docs/RAILWAY_DEPLOYMENT.md: none goes on until this tool's pre-written rule
(RULE below, written before any replay ran) passes on saved real requests.

How each solve runs: as the solver service runs it. The saved request is validated as a DispatchRequest, and
optimize_dispatch runs in a solve thread with its own SolveControl (main.py does the same), its route searches
in spawned worker pools (SOLVER_PARALLEL=1, never in this process). An ARM is a set of environment variables.
The solver reads each of them on every solve (best_of.py, pyvrp_candidate.allowed_setting,
dispatch_solver.priority_repair_on), so the bench sets them just before each run and restores them after it.
Each record keeps the settings exactly as the solver read them during that run. The arms are interleaved per
repetition, request and mode (A B C, then B C A, ...). So the runs of a pair (same request, mode and repetition)
ran minutes apart on the same machine.

    cd apps/solver
    .venv/bin/python scripts/bench_search.py ~/ds-data/day-*-request.json --dry-run
    .venv/bin/python scripts/bench_search.py ~/ds-data/day-*-request.json --out ~/bench/run1 \\
        --arms base,best_of,pyvrp_model,repair_on,all_on --modes QUICK,THOROUGH --reps 3 --cpu-note "codespace 4 vCPU"
    .venv/bin/python scripts/bench_search.py --summary-only --out ~/bench/run1

ARMS (--arms): arms separated by ";", each a custom arm NAME=VAR=VALUE,VAR=VALUE ("NAME=" alone: every flag at its
default) or presets separated by commas ("base,best_of;k4=SOLVER_BEST_OF=4"). The presets:
    base         every flag at its production default (off)
    best_of      SOLVER_BEST_OF=3, SOLVER_BEST_OF_QUICK=3
    pyvrp_model  SOLVER_PYVRP_ALLOWED=model
    repair_on    SOLVER_PRIORITY_REPAIR=on
    all_on       all three
Before each run, every flag in FLAG_VARS is unset, then the arm's own values are set. Every other variable
comes from the shell, and the header of the summary lists it. --base names the arm that the others are paired
against ("base" when there is one, else the first arm).

MODES (--modes): QUICK, THOROUGH, ASKED (each request's own mode). THOROUGH keeps the request's
max_search_sec, which is the production cap (--max-search-sec overrides it for short trials only).

ROAD MATRIX (--matrix): "cached" (the default) builds each request's matrix once, as the request asks (OSRM when
this machine's OSRM_URL is set, else the straight-line estimate). Every run then gets that same matrix and
waits as long as the first fetch took, so every arm plans on the same distances and the time budget stays honest.
"asked" fetches it on every run. "haversine" forces straight-line distances (decision-support's offline()).
A request's own osrm_url (the web sends the company's) is never called. Production plans on OSRM road distances;
a summary built on estimates says so.

MACHINE: production has 24 vCPU and MAX_CONCURRENT_DISPATCH=2. The bench runs one solve at a time and sets
MAX_CONCURRENT_DISPATCH=1 (--max-concurrent). Without this, a 4-CPU machine's CPU gate would cut best-of to one
search and the best_of arm would equal base. The records say when the gate still cut it (best_of.gate), and the
summary shows how many busy processes shared the CPUs.

LONG REPLAYS: results.jsonl is appended after each run, and a run already recorded in --out is skipped. Run the
same command again to continue after a stop, a lost connection or --stop-after-min. summary.md is rewritten
after each run.

PRIVACY (the repository is PUBLIC): this file holds no data, and real requests never enter the repository.
Output names a request by its file name and the first 16 hex characters of its sha256. It never holds a stop,
order, customer or truck id, a name or a coordinate: warnings and errors are kept with each id of the request
replaced by <id>. --out must be outside the repository (the bench refuses it otherwise). solver.log there holds
the solver's own log lines, which name stop ids. summary.md has the plans' totals of real days: publish only
differences and digests (docs/OPTIMIZER_BENCHMARK.md).
"""
from __future__ import annotations

import argparse
import glob
import hashlib
import json
import logging
import math
import os
import platform
import re
import statistics
import subprocess
import sys
import time
from collections import Counter
from concurrent.futures import ThreadPoolExecutor
from concurrent.futures import TimeoutError as FutureTimeout
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

SOLVER_DIR = Path(__file__).resolve().parent.parent
if str(SOLVER_DIR) not in sys.path:
    sys.path.insert(0, str(SOLVER_DIR))

TOOL_VERSION = 1

# The solver search upgrade's flags: unset before every run (each arm starts from production defaults).
FLAG_VARS = ("SOLVER_BEST_OF", "SOLVER_BEST_OF_QUICK", "SOLVER_BEST_OF_SOURCES", "SOLVER_BEST_OF_JOIN_SEC",
             "SOLVER_BEST_OF_STRATEGIES", "SOLVER_PYVRP_ALLOWED", "SOLVER_PRIORITY_REPAIR")
PRESETS: dict[str, dict[str, str]] = {
    "base": {},
    "best_of": {"SOLVER_BEST_OF": "3", "SOLVER_BEST_OF_QUICK": "3"},
    "pyvrp_model": {"SOLVER_PYVRP_ALLOWED": "model"},
    "repair_on": {"SOLVER_PRIORITY_REPAIR": "on"},
    "all_on": {"SOLVER_BEST_OF": "3", "SOLVER_BEST_OF_QUICK": "3", "SOLVER_PYVRP_ALLOWED": "model",
               "SOLVER_PRIORITY_REPAIR": "on"},
}
DEFAULT_ARMS = "base,best_of,pyvrp_model,repair_on,all_on"
MODES = ("QUICK", "THOROUGH")
# The bench decides these per run; an arm may not set them.
FIXED_VARS = ("SOLVER_PARALLEL", "SOLVER_ALLOW_INPROCESS_FALLBACK", "SOLVER_TOKEN")
# Variables of the shell the header records (a production value is unknown here: listed, never changed).
SHOWN_ENV = re.compile(r"^(SOLVER_|THOROUGH_|MATRIX_BUDGET_SEC$|OSRM_TABLE_TILE$|OSRM_PARALLEL$|MAX_CONCURRENT_DISPATCH$)")
SECRET_ENV = re.compile(r"TOKEN|KEY|SECRET|PASSWORD", re.I)
# The solver's source files: an arm may only set a variable one of them reads (catches typos such as
# SOLVER_BESTOF, which the solver would silently ignore).
SOLVER_SOURCES = ("dispatch_solver.py", "best_of.py", "pyvrp_candidate.py", "load_repack.py", "providers.py", "main.py",
                  "feasibility.py", "costing.py")

CAP_MARGIN_SEC = 60  # rule 4: every run answers within its cap minus this
CASH_TOL_OMR = 0.005  # two operating costs closer than this are equal
SIGN_P_MAX = 0.10  # benefit: one-sided sign test
PRODUCTION_CPUS = 24
PRODUCTION_MAX_CONCURRENT = 2
SEARCH_FAILURES = ("TIMEOUT", "LOST")
# Texts of the priority repair's outcomes in a timing-drop reason (dispatch_solver._timing_drop_reason).
REPAIR_TRIED_TEXTS = ("the planner then tried to put it in place of lower-priority stops",
                      "no time was left to try it in place of lower-priority stops")

RULE = """\
PRE-WRITTEN RULE (fixed before any replay ran: design section 9.3, critique-2 item 1, RAILWAY_DEPLOYMENT.md).
An arm's flag may be switched on for a search mode only if all of these hold over every run of that mode,
each arm run paired with the base run of the same request and repetition:
  1. Service: RECOMMENDED never serves the day worse by priority than in the base run beside it (stops left out
     compared P1 first, then P2 ... P5: the engine's own strict-priority order; with weighted priorities, the
     weight left out).
  2. Hard rules: every option of every run of the arm is OPTIMIZED and its independent check is VERIFIED
     (no NO_SOLUTION, VIOLATED or UNVERIFIED).
  3. Cash: the median of the paired differences in RECOMMENDED's operating cost (arm - base, OMR) is not above 0.
  4. Time: every run of the arm answers within its cap minus 60 s (search.used_sec <= search.cap_sec - 60).
  5. Robustness: no route search of the arm ends TIMEOUT or LOST (best-of's searches; PyVRP FAILED), no solve
     fails (an error: the service's 503 or 504), and no worker process is left after a run.
Verdict: FAIL when any of 1-5 fails. Otherwise INCOMPLETE while a planned pair is missing, and NOT EXERCISED
when the flag never took effect (best-of never ran 2+ searches, PyVRP never ran on a day with small-truck-only
stops, the repair never acted). Otherwise PASS. PASS means the flag is safe, not that it helps. Whether it is
worth switching on is the benefit line: wins and losses over the pairs (service first, then cash), with a
one-sided sign test (p <= 0.10, which needs at least 4 decisive pairs; 7 wins of 9 gives p = 0.09).
Switch on only with the owner's OK, one flag at a time, never during the evening's planning."""


class UsageError(Exception):
    """Bad arguments or inputs: printed, exit code 2, nothing solved."""


class Interrupted(Exception):
    """Ctrl-C during a run: the run is cancelled and not recorded."""


def _solver():
    """The solver modules, imported on first use (after sys.path is set; spawned workers import this file too)."""
    import best_of as BO
    import dispatch_solver as ds
    import pyvrp_candidate as PV
    from dispatch_models import DispatchRequest
    return ds, BO, PV, DispatchRequest


# ---------------------------------------------------------------------------------------------
# Inputs: requests, arms, modes
# ---------------------------------------------------------------------------------------------

@dataclass
class RequestFile:
    path: Path
    label: str
    digest: str
    req: Any  # DispatchRequest
    facts: dict
    redact: Any = None  # (str) -> str


@dataclass
class Arm:
    name: str
    env: dict[str, str] = field(default_factory=dict)

    def describe(self) -> str:
        return ", ".join(f"{k}={v}" if v != "" else f"{k} unset" for k, v in self.env.items()) or "every flag at its default"


def _expand(paths: list[str]) -> list[Path]:
    out: list[Path] = []
    for p in paths:
        p = os.path.expanduser(p)
        hits = sorted(glob.glob(p)) if any(c in p for c in "*?[") else [p]
        if not hits:
            raise UsageError(f"no file matches {p}")
        out += [Path(h) for h in hits]
    return out


def _redactor(req) -> Any:
    """Replaces every id and label of ``req`` in a text with <id> (a stop, order, customer or truck id, a truck code,
    the depot, the run and the company)."""
    tokens: set[str] = {req.run_id, req.tenant_id, req.depot.id}
    for t in req.trucks:
        tokens |= {t.id, t.code}
    for s in req.stops:
        tokens |= {s.stop_id, s.customer_id, *s.order_ids}
        tokens |= set(s.allowed_truck_ids or ())
        if s.previous_truck_id:
            tokens.add(s.previous_truck_id)
        if s.allowed_trucks_label:
            tokens.add(s.allowed_trucks_label)
    tokens = {t for t in tokens if t and len(t) >= 2 and not (t.isdigit() and len(t) < 5)}
    if not tokens:
        return lambda text: text
    rx = re.compile(r"(?<![A-Za-z0-9_\-])(?:" + "|".join(re.escape(t) for t in sorted(tokens, key=len, reverse=True))
                    + r")(?![A-Za-z0-9_\-])")
    coord = re.compile(r"(?<![\d.])-?\d{1,3}\.\d{5,}(?![\d.])")

    def redact(text: str | None) -> str | None:
        if text is None:
            return None
        return coord.sub("<num>", rx.sub("<id>", str(text)))[:400]
    return redact


def load_request(path: Path) -> RequestFile:
    ds, _BO, _PV, DispatchRequest = _solver()
    try:
        raw = path.read_bytes()
    except OSError as exc:
        raise UsageError(f"cannot read {path}: {exc.strerror or exc}") from None
    digest = hashlib.sha256(raw).hexdigest()[:16]
    try:
        req = DispatchRequest.model_validate_json(raw)
    except Exception as exc:  # noqa: BLE001 - pydantic or JSON: name the fields, never the values
        errors = getattr(exc, "errors", None)
        where = ""
        if callable(errors):
            try:
                where = "; ".join(".".join(str(x) for x in e.get("loc", ())) + f": {e.get('type')}"
                                  for e in errors(include_input=False, include_url=False)[:5])
            except TypeError:
                where = ""
        raise UsageError(f"{path.name} is not a dispatch request ({type(exc).__name__}{': ' + where if where else ''})") from None
    cfg = req.config
    prio = Counter(s.priority for s in req.stops)
    facts: dict[str, Any] = {
        "stops": len(req.stops), "trucks": len(req.trucks),
        "to_rent": sum(1 for t in req.trucks if t.hire_candidate),
        "stops_by_priority": [prio.get(p, 0) for p in range(1, 6)],
        "small_truck_only_stops": sum(1 for s in req.stops if s.allowed_truck_ids is not None),
        "asked_mode": cfg.search_mode, "max_search_sec": cfg.max_search_sec, "time_limit_sec": cfg.time_limit_sec,
        "scenarios": list(cfg.scenarios), "strict_priorities": cfg.strict_priorities,
        "distance_provider": cfg.distance_provider, "request_osrm_url_ignored": bool(cfg.osrm_url),
        "thorough_cap_sec": ds.thorough_cap_sec(cfg.model_copy(update={"search_mode": "THOROUGH"})),
    }
    try:
        solvable, drops, _w = ds._prefilter(req, ds._truck_days(req))
        facts.update(solvable=len(solvable), left_out_before_search=len(drops),
                     limits_decide=bool(ds._limits_decide(req, solvable)), full_truck_day=bool(ds._full_truck_day(req, solvable)),
                     quick_limit_sec=cfg.time_limit_sec or ds.auto_time_limit(len(solvable)))
    except Exception as exc:  # noqa: BLE001 - the solve itself will say what is wrong; the dry run only reports it
        facts.update(prefilter_error=type(exc).__name__)
    return RequestFile(path=path, label=path.name.removesuffix(".json"), digest=digest, req=req, facts=facts,
                       redact=_redactor(req))


def _solver_reads(name: str) -> bool:
    text = getattr(_solver_reads, "_text", None)
    if text is None:
        text = ""
        for f in SOLVER_SOURCES:
            try:
                text += (SOLVER_DIR / f).read_text(encoding="utf-8")
            except OSError:
                pass
        _solver_reads._text = text  # type: ignore[attr-defined]
    return f'"{name}"' in text


def parse_arms(spec: str) -> list[Arm]:
    """Arms separated by ";": a custom arm NAME=VAR=VALUE,VAR=VALUE, or presets separated by commas."""
    arms: list[Arm] = []
    for item in [x.strip() for x in spec.split(";") if x.strip()]:
        if "=" not in item:
            for name in [x.strip() for x in item.split(",") if x.strip()]:
                if name not in PRESETS:
                    raise UsageError(f"unknown arm preset {name!r} (presets: {', '.join(PRESETS)}; or NAME=VAR=VALUE,...)")
                arms.append(Arm(name, dict(PRESETS[name])))
            continue
        name, _, rest = item.partition("=")
        name = name.strip()
        if not re.fullmatch(r"[A-Za-z0-9_.\-]{1,40}", name):
            raise UsageError(f"arm name {name!r}: letters, digits, '_', '.', '-' only (at most 40)")
        env: dict[str, str] = {}
        for part in [p.strip() for p in rest.split(",") if p.strip()]:
            var, eq, value = part.partition("=")
            var = var.strip()
            if not eq:
                raise UsageError(f"arm {name}: {part!r} is not VAR=VALUE")
            env[var] = value.strip()
        arms.append(Arm(name, env))
    if not arms:
        raise UsageError("no arm given")
    names = [a.name for a in arms]
    if len(set(names)) != len(names):
        raise UsageError(f"an arm name is used twice: {names}")
    for a in arms:
        for var in a.env:
            if not re.fullmatch(r"[A-Z][A-Z0-9_]*", var):
                raise UsageError(f"arm {a.name}: {var!r} is not an environment variable name")
            if var in FIXED_VARS or var.startswith("ROUTEIQ_TEST_"):
                raise UsageError(f"arm {a.name}: {var} is fixed by the bench (production: worker pools, no test hooks)")
            if not _solver_reads(var):
                raise UsageError(f"arm {a.name}: the solver never reads {var} (a typo?)")
    return arms


def parse_modes(spec: str) -> list[str]:
    modes = []
    for m in [x.strip().upper() for x in spec.split(",") if x.strip()]:
        if m not in (*MODES, "ASKED"):
            raise UsageError(f"unknown mode {m!r} (QUICK, THOROUGH, ASKED)")
        if m not in modes:
            modes.append(m)
    if not modes:
        raise UsageError("no mode given")
    return modes


# ---------------------------------------------------------------------------------------------
# Environment of a run
# ---------------------------------------------------------------------------------------------

def _apply(arm: Arm, max_concurrent: int) -> dict[str, str | None]:
    names = set(FLAG_VARS) | set(arm.env) | {"SOLVER_PARALLEL", "SOLVER_ALLOW_INPROCESS_FALLBACK", "MAX_CONCURRENT_DISPATCH"}
    saved = {n: os.environ.get(n) for n in names}
    for n in FLAG_VARS:
        os.environ.pop(n, None)
    os.environ["SOLVER_PARALLEL"] = "1"
    os.environ.pop("SOLVER_ALLOW_INPROCESS_FALLBACK", None)
    os.environ["MAX_CONCURRENT_DISPATCH"] = str(max_concurrent)
    for n, v in arm.env.items():
        if v == "":
            os.environ.pop(n, None)
        else:
            os.environ[n] = v
    return saved


def _restore(saved: dict[str, str | None]) -> None:
    for n, v in saved.items():
        if v is None:
            os.environ.pop(n, None)
        else:
            os.environ[n] = v


def _effective(mode: str) -> dict:
    """The settings as the solver reads them now (with the arm's environment applied)."""
    ds, BO, PV, _ = _solver()
    k = BO.setting(mode)
    pyvrp_on, pyvrp_why = PV.enabled(mode)
    used, gate = BO.effective(mode, parallel=ds._parallel(), pyvrp_on=pyvrp_on)
    return {"best_of": k, "best_of_cpu_gate": used, "best_of_gate": gate, "best_of_sources": BO.sources(used),
            "best_of_join_sec": BO.join_sec(), "best_of_strategies": list(BO.strategies()),
            "pyvrp": PV.setting(), "pyvrp_on": pyvrp_on, "pyvrp_off_why": pyvrp_why, "pyvrp_allowed": PV.allowed_setting(),
            "pyvrp_models_limits": PV.limits_modelled(mode), "priority_repair": ds.priority_repair_on(),
            "parallel": ds._parallel(), "max_concurrent": BO.max_concurrent(), "cpus": PV.effective_cpus()}


def check_arm_values(arms: list[Arm], max_concurrent: int) -> None:
    """Every value of every arm is read as written (one the solver cannot read counts as its default - the arm would
    silently equal base)."""
    _ds, BO, PV, _ = _solver()
    for a in arms:
        saved = _apply(a, max_concurrent)
        try:
            bad = [f"{n}={raw!r} ({what})" for n, raw, what in BO.unread()]
            repair = os.environ.get("SOLVER_PRIORITY_REPAIR")
            if repair is not None and repair.strip().lower() not in ("on", "1", "true", "yes", "off", "0", "false", "no"):
                bad.append(f"SOLVER_PRIORITY_REPAIR={repair!r} (on or off)")
            allowed = os.environ.get("SOLVER_PYVRP_ALLOWED")
            if allowed is not None and allowed.strip().lower() not in PV.ALLOWED_SETTINGS:
                bad.append(f"SOLVER_PYVRP_ALLOWED={allowed!r} ({', '.join(PV.ALLOWED_SETTINGS)})")
            strategies = os.environ.get("SOLVER_BEST_OF_STRATEGIES")
            if strategies is not None:
                unknown = [s for s in strategies.split(",") if s.strip() and s.strip().upper() not in BO.STRATEGY_WHITELIST]
                if unknown:
                    bad.append(f"SOLVER_BEST_OF_STRATEGIES: {unknown} not in {list(BO.STRATEGY_WHITELIST)}")
            pyvrp = os.environ.get("SOLVER_PYVRP")
            if pyvrp is not None and pyvrp.strip().lower() not in ("on", "off", "0", "false", "no", "thorough"):
                bad.append(f"SOLVER_PYVRP={pyvrp!r} (on, off or thorough)")
            if bad:
                raise UsageError(f"arm {a.name}: the solver would not read " + "; ".join(bad))
        finally:
            _restore(saved)


def _shell_env() -> dict[str, str]:
    return {k: os.environ[k] for k in sorted(os.environ)
            if SHOWN_ENV.match(k) and not SECRET_ENV.search(k) and k not in FLAG_VARS}


def _commit() -> str | None:
    try:
        head = subprocess.run(["git", "-C", str(SOLVER_DIR), "rev-parse", "--short=12", "HEAD"], capture_output=True,
                              text=True, timeout=10).stdout.strip()
        dirty = subprocess.run(["git", "-C", str(SOLVER_DIR), "status", "--porcelain", "--", "."], capture_output=True,
                               text=True, timeout=10).stdout.strip()
        return (head + ("+dirty" if dirty else "")) or None
    except (OSError, subprocess.SubprocessError):
        return None


def _repo_root() -> Path | None:
    for p in (SOLVER_DIR, *SOLVER_DIR.parents):
        if (p / ".git").exists():
            return p
    return None


def check_out_dir(out: Path) -> Path:
    out = out.expanduser().resolve()
    root = _repo_root()
    if root is not None and (out == root or root in out.parents):
        raise UsageError(f"--out {out} is inside the repository ({root}), which is public: choose a folder outside it")
    if out.exists() and not out.is_dir():
        raise UsageError(f"--out {out} is a file")
    return out


# ---------------------------------------------------------------------------------------------
# One run
# ---------------------------------------------------------------------------------------------

class MatrixCache:
    """--matrix cached: each request's road matrix is built once (as the request asks) and every later run gets a copy
    of it, after waiting as long as the first fetch took (the solve's budget includes the matrix)."""

    def __init__(self, real) -> None:
        self.real = real
        self.store: dict[tuple, Any] = {}

    def __call__(self, coords, **kw):
        key = (tuple(coords), kw.get("provider"), kw.get("osrm_url"), kw.get("haversine_multiplier"),
               kw.get("avg_speed_kmh"), kw.get("road_time_factor"))
        hit = self.store.get(key)
        if hit is None:
            res = self.real(coords, **kw)
            self.store[key] = _copy_matrix(res)
            return res
        time.sleep(max(0.0, min(float(hit.seconds or 0.0), 120.0)))
        return _copy_matrix(hit)


def _copy_matrix(m):
    from dataclasses import replace
    return replace(m, distance_m=[r[:] for r in m.distance_m], duration_s=[r[:] for r in m.duration_s],
                   warnings=list(m.warnings), estimated=set(m.estimated))


def _children_left() -> int:
    import multiprocessing as mp
    deadline = time.monotonic() + 5.0
    n = len(mp.active_children())
    while n and time.monotonic() < deadline:
        time.sleep(0.25)
        n = len(mp.active_children())
    return n


def _loadavg() -> float | None:
    try:
        return round(os.getloadavg()[0], 2)
    except (AttributeError, OSError):
        return None


def _maxrss_mb() -> dict | None:
    try:
        import resource
    except ImportError:
        return None
    scale = 1 / 1024 if sys.platform != "darwin" else 1 / (1024 * 1024)
    return {"self": round(resource.getrusage(resource.RUSAGE_SELF).ru_maxrss * scale, 1),
            "children_so_far": round(resource.getrusage(resource.RUSAGE_CHILDREN).ru_maxrss * scale, 1)}


def _request_for(rf: RequestFile, mode: str, arm: Arm, rep: int, args) -> Any:
    # The request's own osrm_url (the web sends the company's) is never called: only this machine's OSRM_URL is.
    cfg_update: dict[str, Any] = {"search_mode": mode, "osrm_url": None}
    if mode == "THOROUGH" and args.max_search_sec:
        cfg_update["max_search_sec"] = args.max_search_sec
    if args.matrix == "haversine":
        cfg_update["distance_provider"] = "HAVERSINE"
    req = rf.req.model_copy(deep=True)
    return req.model_copy(update={"run_id": f"bench-{rf.digest[:8]}-{mode[0]}-{arm.name}-r{rep}",
                                  "config": req.config.model_copy(update=cfg_update)})


def _solve(req) -> Any:
    """optimize_dispatch as main.py runs it: in a solve thread, with a SolveControl. Ctrl-C cancels it."""
    ds, *_ = _solver()
    control = ds.SolveControl()
    with ThreadPoolExecutor(max_workers=1, thread_name_prefix="bench-solve") as pool:
        fut = pool.submit(ds.optimize_dispatch, req, control=control)
        while True:
            try:
                return fut.result(timeout=1.0)
            except FutureTimeout:
                continue
            except KeyboardInterrupt:
                control.cancel("the bench was interrupted")
                print("\ninterrupted: cancelling the running solve (it is not recorded) ...", file=sys.stderr, flush=True)
                try:
                    fut.result(timeout=120)
                except BaseException:  # noqa: BLE001 - it was cancelled; only its end matters
                    pass
                raise Interrupted() from None


def run_one(rf: RequestFile, mode: str, arm: Arm, rep: int, position: int, args, commit: str | None) -> dict:
    ds, *_ = _solver()
    rec: dict[str, Any] = {"v": TOOL_VERSION, "request": rf.label, "digest": rf.digest, "mode": mode, "arm": arm.name,
                           "rep": rep, "position": position, "arm_env": dict(arm.env), "commit": commit,
                           "matrix_mode": args.matrix, "facts": rf.facts}
    saved = _apply(arm, args.max_concurrent)
    try:
        rec["effective"] = _effective(mode)
        req = _request_for(rf, mode, arm, rep, args)
        rec["started_at"] = datetime.now(timezone.utc).isoformat(timespec="seconds")
        rec["loadavg_before"] = _loadavg()
        t0 = time.perf_counter()
        try:
            resp = _solve(req)
        except Interrupted:
            raise
        except Exception as exc:  # noqa: BLE001 - a failed solve is a result (rule 5)
            rec["error"] = {"type": type(exc).__name__, "code": getattr(exc, "code", None),
                            "message": rf.redact(str(exc))}
            resp = None
        rec["wall_sec"] = round(time.perf_counter() - t0, 2)
        rec["loadavg_after"] = _loadavg()
        if resp is not None:
            try:
                rec.update(_from_response(resp, rf, ds))
                rec.setdefault("error", None)
            except Exception as exc:  # noqa: BLE001 - a response this tool cannot read fails the arm until looked at
                rec["error"] = {"type": f"BenchRecordError {type(exc).__name__}", "code": None,
                                "message": rf.redact(str(exc))}
    finally:
        _restore(saved)
    rec["children_left"] = _children_left()
    rec["maxrss_mb"] = _maxrss_mb()
    return rec


def _from_response(resp, rf: RequestFile, ds) -> dict:
    redact = rf.redact
    info = {s.stop_id: (s.priority, s.demand_cases) for s in rf.req.stops}
    weights = rf.req.config.priority_weights
    note = re.compile(r"^\s*(\d+)" + re.escape(ds.PRIORITY_REPAIR_NOTE))
    options: dict[str, dict] = {}
    for sc in resp.scenarios:
        stops, cases, weight, unknown = [0] * 5, [0] * 5, 0.0, 0
        for u in sc.unserved:
            p, c = info.get(u.stop_id, (None, 0))
            if p is None:
                unknown += 1
                continue
            stops[p - 1] += 1
            cases[p - 1] += c
            weight += float(weights.get(p, 0.0))
        served = {st.stop_id for ld in sc.loads for st in ld.stops}
        lowest = max((info[s][0] for s in served if s in info), default=0)
        inverted = sum(1 for u in sc.unserved if u.stop_id in info and info[u.stop_id][0] <= 3 and info[u.stop_id][0] < lowest)
        put_back = sum(int(m.group(1)) for w in sc.warnings if (m := note.match(w)))
        feas = sc.feasibility
        options[sc.name] = {
            "status": sc.status, "solver_status": redact(sc.solver_status),
            "feasibility": feas.status if feas else None, "timing": feas.timing if feas else None,
            "violations": dict(Counter(v.code for v in feas.violations)) if feas else {},
            "trucks": sc.trucks_used, "loads": sc.trips, "operating_omr": round(sc.operating_cost, 3),
            "km": round(sc.total_distance_km, 3), "served_stops": len(served),
            "left_out_stops": stops, "left_out_cases": cases, "left_out_weight": round(weight, 6),
            "left_out_unknown": unknown, "inverted": inverted,
            "repair": {"put_back": put_back,
                       "displaced": sum(1 for u in sc.unserved if u.reason_message.startswith(ds.PRIORITY_DISPLACED_HEAD)),
                       "tried_no_place_or_time": sum(1 for u in sc.unserved if u.reason_message.startswith(ds.TIMING_DROP_HEAD)
                                                     and any(t in u.reason_message for t in REPAIR_TRIED_TEXTS))},
            "warnings": [redact(w) for w in sc.warnings],
        }
    out: dict[str, Any] = {"options": options, "matrix_provider": resp.matrix_provider,
                           "distance_quality": resp.distance_quality, "distance_is_estimated": resp.distance_is_estimated,
                           "warnings": [redact(w) for w in resp.warnings]}
    s = resp.search
    if s is not None:
        out["search"] = {k: getattr(s, k) for k in ("mode", "cap_sec", "limit_sec", "search_sec", "used_sec", "stop_reason",
                                                    "last_improvement_sec", "stall_sec", "solutions", "ortools_version")}
        out["pyvrp"] = s.pyvrp.model_dump(exclude={"best_over_time"}) if s.pyvrp else None
        if s.best_of is not None:
            bo = s.best_of.model_dump()
            bo["won"] = {g["option"]: g["source"] for g in bo.get("gains", []) if g.get("used")}
            bo["best_ranked"] = next((r["index"] for r in bo.get("searches", []) if r.get("warm_start")), None)
            out["best_of"] = bo
        else:
            out["best_of"] = None
    hc = getattr(resp, "hire_check", None)
    if hc is not None:
        out["hire_check"] = {"to_rent": len(hc.used), "solves": hc.solves, "complete": hc.complete}
    return out


# ---------------------------------------------------------------------------------------------
# The rule and the summary (pure functions of the records)
# ---------------------------------------------------------------------------------------------

def _primary(rec: dict) -> dict | None:
    opts = rec.get("options") or {}
    return opts.get("RECOMMENDED") or (next(iter(opts.values())) if opts else None)


def service_key(rec: dict) -> tuple | None:
    """Larger serves the day better: stops left out per priority, P1 first (strict); the weight left out (weighted)."""
    p = _primary(rec)
    if p is None or p.get("status") != "OPTIMIZED":
        return None
    if (rec.get("facts") or {}).get("strict_priorities", True):
        return tuple(-x for x in p["left_out_stops"])
    return (-p["left_out_weight"],)


def _cmp(a, b) -> int:
    return (a > b) - (a < b)


def compare_pair(base: dict, arm: dict) -> dict | None:
    """The paired comparison of two runs of the same request, mode and repetition; None when either has no plan."""
    kb, ka = service_key(base), service_key(arm)
    if kb is None or ka is None:
        return None
    pb, pa = _primary(base), _primary(arm)
    svc = _cmp(ka, kb)
    d_cash = pa["operating_omr"] - pb["operating_omr"]
    if svc:
        outcome = "win" if svc > 0 else "loss"
    elif d_cash < -CASH_TOL_OMR:
        outcome = "win"
    elif d_cash > CASH_TOL_OMR:
        outcome = "loss"
    else:
        outcome = "tie"
    sb, sa = base.get("search") or {}, arm.get("search") or {}
    rate = None
    if sb.get("solutions") and sa.get("solutions") and sb.get("search_sec") and sa.get("search_sec"):
        rate = (sa["solutions"] / sa["search_sec"]) / (sb["solutions"] / sb["search_sec"])
    return {"service": svc, "outcome": outcome, "d_cash": d_cash, "d_km": pa["km"] - pb["km"],
            "d_trucks": pa["trucks"] - pb["trucks"], "d_loads": pa["loads"] - pb["loads"],
            "d_used": (sa.get("used_sec") or 0.0) - (sb.get("used_sec") or 0.0), "primary_rate_ratio": rate}


def not_verified(rec: dict) -> list[str]:
    """Options of a run that break rule 2."""
    bad = []
    for name, o in (rec.get("options") or {}).items():
        if o["status"] == "NOTHING_TO_PLAN":
            continue
        if o["status"] != "OPTIMIZED" or o.get("feasibility") != "VERIFIED":
            bad.append(f"{name}:{o['status'] if o['status'] != 'OPTIMIZED' else o.get('feasibility')}")
    return bad


def over_time(rec: dict) -> bool:
    s = rec.get("search") or {}
    return s.get("used_sec") is not None and s.get("cap_sec") is not None and s["used_sec"] > s["cap_sec"] - CAP_MARGIN_SEC


def robustness_failures(rec: dict) -> list[str]:
    out = []
    if rec.get("error"):
        out.append(f"error {rec['error'].get('type')}")
    for r in ((rec.get("best_of") or {}).get("searches") or []):
        if r.get("status") in SEARCH_FAILURES:
            out.append(f"search {r.get('index')} {r['status']}")
    pv = rec.get("pyvrp") or {}
    if pv.get("status") == "FAILED":
        out.append(f"PyVRP FAILED {pv.get('reason')}")
    if rec.get("children_left"):
        out.append(f"{rec['children_left']} worker process(es) left")
    return out


def exercised(rec: dict) -> dict[str, bool]:
    """For each flag that applies to this run (as the solver read it): did it take effect?"""
    eff, out = rec.get("effective") or {}, {}
    if (eff.get("best_of") or 1) > 1:
        out["best-of"] = ((rec.get("best_of") or {}).get("used") or 1) >= 2
    if eff.get("pyvrp_models_limits"):
        out["PyVRP on small-truck-only days"] = bool((rec.get("facts") or {}).get("limits_decide")) and \
            (rec.get("pyvrp") or {}).get("status") in ("CHOSEN", "NOT_CHOSEN")
    if eff.get("priority_repair"):
        out["priority repair"] = any(sum(o["repair"].values()) > 0 for o in (rec.get("options") or {}).values())
    return out


def sign_p(wins: int, losses: int) -> float | None:
    n = wins + losses
    if n == 0:
        return None
    return sum(math.comb(n, k) for k in range(wins, n + 1)) / 2 ** n


def evaluate(records: list[dict], base: str, planned: dict[str, int]) -> dict[tuple[str, str], dict]:
    """The pre-written RULE for every (mode, arm) other than base. ``planned``: pairs planned per mode."""
    by_key = {(r["digest"], r["mode"], r["arm"], r["rep"]): r for r in records}
    arms = list(dict.fromkeys(r["arm"] for r in records if r["arm"] != base))
    modes = list(dict.fromkeys(r["mode"] for r in records))
    out: dict[tuple[str, str], dict] = {}
    for mode in modes:
        for arm in arms:
            runs = [r for r in records if r["mode"] == mode and r["arm"] == arm]
            if not runs:
                continue
            pairs, base_missing = [], 0
            for r in runs:
                b = by_key.get((r["digest"], mode, base, r["rep"]))
                if b is None or b.get("error"):
                    base_missing += 1
                    continue
                c = compare_pair(b, r)
                if c is not None:
                    pairs.append((r, c))
            worse = [c for _r, c in pairs if c["service"] < 0]
            unverified = [(r, not_verified(r)) for r in runs if not r.get("error") and not_verified(r)]
            d_cash = [c["d_cash"] for _r, c in pairs]
            med = statistics.median(d_cash) if d_cash else None
            slow = [r for r in runs if over_time(r)]
            fragile = [(r, robustness_failures(r)) for r in runs if robustness_failures(r)]
            ex: dict[str, int] = {}
            for r in runs:
                for flag, ok in exercised(r).items():
                    ex[flag] = ex.get(flag, 0) + int(ok)
            fails = []
            if worse:
                fails.append(f"1 service worse in {len(worse)} pair(s)")
            if unverified:
                fails.append(f"2 not VERIFIED in {len(unverified)} run(s)")
            if med is not None and med > CASH_TOL_OMR:
                fails.append(f"3 median cash +{med:.2f} OMR")
            if slow:
                fails.append(f"4 over cap-{CAP_MARGIN_SEC}s in {len(slow)} run(s)")
            if fragile:
                fails.append(f"5 {len(fragile)} run(s): " + "; ".join(sorted({x for _r, f in fragile for x in f}))[:200])
            n_planned = planned.get(mode, 0)
            idle = [flag for flag, n in ex.items() if n == 0]
            if fails:
                verdict = "FAIL: " + "; ".join(fails)
            elif len(pairs) < n_planned:
                verdict = f"INCOMPLETE: {len(pairs)} of {n_planned} pairs"
            elif idle:
                verdict = "NOT EXERCISED: " + ", ".join(idle) + " never took effect"
            else:
                verdict = "PASS"
            wins = sum(1 for _r, c in pairs if c["outcome"] == "win")
            losses = sum(1 for _r, c in pairs if c["outcome"] == "loss")
            p = sign_p(wins, losses)
            out[(mode, arm)] = {
                "verdict": verdict, "pass": verdict == "PASS", "pairs": len(pairs), "planned": n_planned,
                "base_missing": base_missing, "service_worse": len(worse), "not_verified_runs": len(unverified),
                "median_d_cash": med, "over_time_runs": len(slow), "robustness_runs": len(fragile), "exercised": ex,
                "runs": len(runs), "wins": wins, "ties": len(pairs) - wins - losses, "losses": losses, "sign_p": p,
                "benefit": bool(p is not None and wins > losses and p <= SIGN_P_MAX),
            }
    return out


def _num(x: float, nd: int, sign: bool) -> str:
    x = round(x, nd) + 0.0  # no "-0"
    return f"{x:+.{nd}f}" if sign else f"{x:.{nd}f}"


def _med(values: list[float], nd: int) -> str:
    if not values:
        return "-"
    return f"{_num(statistics.median(values), nd, True)} [{_num(min(values), nd, True)}, {_num(max(values), nd, True)}]"


def _abs(values: list[float], nd: int) -> str:
    if not values:
        return "-"
    return f"{_num(statistics.median(values), nd, False)} [{_num(min(values), nd, False)}, {_num(max(values), nd, False)}]"


def _table(head: list[str], rows: list[list[Any]]) -> str:
    lines = ["| " + " | ".join(head) + " |", "|" + "---|" * len(head)]
    lines += ["| " + " | ".join(str(x) for x in row) + " |" for row in rows]
    return "\n".join(lines)


def planned_pairs(header: dict) -> dict[str, int]:
    per_mode: Counter = Counter()
    for r in header.get("requests", []):
        for m in r.get("modes", []):
            per_mode[m] += header.get("reps", 0)
    return dict(per_mode)


def summarize(records: list[dict], header: dict) -> str:
    base = header["base"]
    ev = evaluate(records, base, planned_pairs(header))
    by_key = {(r["digest"], r["mode"], r["arm"], r["rep"]): r for r in records}
    labels = {r["digest"]: r["label"] for r in header.get("requests", [])}
    labels.update({r["digest"]: r["request"] for r in records if r["digest"] not in labels})
    machine = header.get("machine", {})
    L: list[str] = ["# Search flags replay (scripts/bench_search.py)", ""]
    L.append(f"Written {datetime.now(timezone.utc).isoformat(timespec='seconds')} from {len(records)} run(s) in "
             f"`results.jsonl`. Keep this folder out of the repository: it has the plans' totals of real days.")
    L += ["", "## Machine and conditions", ""]
    cpus = machine.get("effective_cpus")
    L.append(f"- Note: {header.get('cpu_note') or '(none given: --cpu-note)'}")
    L.append(f"- CPUs {machine.get('cpus')} (effective {cpus}); {machine.get('platform')}; Python {machine.get('python')}; "
             f"OR-Tools {machine.get('ortools')}; PyVRP {machine.get('pyvrp')}; solver commit(s) "
             + ", ".join(sorted({str(r.get('commit')) for r in records} or {str(header.get('commit'))})))
    L.append(f"- Matrix: {header.get('matrix')}; seen: " + (", ".join(f"{k} x{v}" for k, v in sorted(Counter(
        f"{r.get('matrix_provider')}/{r.get('distance_quality')}" for r in records if r.get("matrix_provider")).items())) or "-"))
    L.append(f"- MAX_CONCURRENT_DISPATCH={header.get('max_concurrent')} in the bench; repetitions {header.get('reps')}; "
             f"THOROUGH cap: {'--max-search-sec ' + str(header['max_search_sec']) if header.get('max_search_sec') else 'each request' + chr(39) + 's own'}")
    L.append("- Shell environment (every arm): " + (", ".join(f"{k}={v}" for k, v in header.get("env", {}).items()) or "nothing set"))
    notes = []
    if any(r.get("distance_quality") == "ESTIMATED" for r in records):
        notes.append("distances are straight-line estimates (production plans on OSRM road distances)")
    if cpus and cpus < PRODUCTION_CPUS:
        notes.append(f"{cpus} effective CPUs (production {PRODUCTION_CPUS}); wall times and the stall rule do not carry over")
    if header.get("max_concurrent") != PRODUCTION_MAX_CONCURRENT:
        notes.append(f"MAX_CONCURRENT_DISPATCH={header.get('max_concurrent')} (production {PRODUCTION_MAX_CONCURRENT})")
    if header.get("max_search_sec"):
        notes.append("THOROUGH cap overridden (--max-search-sec): not the production cap")
    for k, v in header.get("env", {}).items():
        notes.append(f"{k}={v} is set in the bench's shell")
    if notes:
        L.append("- **Not production conditions:** " + "; ".join(notes) + ".")
    L += ["", "## Requests", ""]
    L.append(_table(["Request", "Digest", "Stops", "Trucks", "Small-truck-only (a list decides)", "Fills a truck alone",
                     "To rent", "Asked", "THOROUGH cap s", "Modes"],
                    [[r["label"], r["digest"], r["facts"].get("stops"), r["facts"].get("trucks"),
                      f"{r['facts'].get('small_truck_only_stops')} ({'yes' if r['facts'].get('limits_decide') else 'no'})",
                      "yes" if r["facts"].get("full_truck_day") else "no", r["facts"].get("to_rent"),
                      r["facts"].get("asked_mode"), r["facts"].get("thorough_cap_sec"), ", ".join(r.get("modes", []))]
                     for r in header.get("requests", [])]))
    L += ["", "## Arms", ""]
    L.append(_table(["Arm", "Settings"], [[a["name"] + (" (base)" if a["name"] == base else ""),
                                           Arm(a["name"], a["env"]).describe()] for a in header.get("arms", [])]))
    L += ["", "## The rule", "", "```", RULE, "```", "", "## Verdicts", ""]
    rows = []
    for (mode, arm), e in ev.items():
        p = "-" if e["sign_p"] is None else f"{e['sign_p']:.3f}"
        rows.append([arm, mode, f"**{e['verdict']}**", f"{e['pairs']}/{e['planned']}", e["service_worse"],
                     e["not_verified_runs"], "-" if e["median_d_cash"] is None else f"{e['median_d_cash']:+.2f}",
                     e["over_time_runs"], e["robustness_runs"],
                     ", ".join(f"{k} {v}/{e['runs']}" for k, v in e["exercised"].items()) or "n/a",
                     f"{e['wins']}/{e['ties']}/{e['losses']}", p, "yes" if e["benefit"] else "no"])
    L.append(_table(["Arm", "Mode", "Verdict", "Pairs", "1 Service worse", "2 Not VERIFIED", "3 Median Δ cash OMR",
                     "4 Over cap-60 s", "5 Failures", "Took effect", "Win/tie/loss", "Sign p", "Benefit"], rows)
             if rows else "No pair yet.")
    L += ["", "## Paired differences per request (arm - base: median [min, max])", ""]
    rows = []
    for (mode, arm) in ev:
        for digest in dict.fromkeys(r["digest"] for r in records if r["mode"] == mode and r["arm"] == arm):
            cs = []
            for r in records:
                if r["digest"] == digest and r["mode"] == mode and r["arm"] == arm:
                    b = by_key.get((digest, mode, base, r["rep"]))
                    c = compare_pair(b, r) if b and not b.get("error") else None
                    if c:
                        cs.append(c)
            svc = Counter(c["service"] for c in cs)
            rates = [c["primary_rate_ratio"] for c in cs if c["primary_rate_ratio"]]
            rows.append([labels.get(digest, digest), mode, arm, len(cs), f"{svc[-1]}/{svc[0]}/{svc[1]}",
                         _med([c["d_cash"] for c in cs], 2), _med([c["d_km"] for c in cs], 1),
                         _med([c["d_trucks"] for c in cs], 0), _med([c["d_loads"] for c in cs], 0),
                         _med([c["d_used"] for c in cs], 0), _abs(rates, 2) if rates else "-"])
    L.append(_table(["Request", "Mode", "Arm", "Pairs", "Service worse/same/better", "Δ cash OMR", "Δ km", "Δ trucks",
                     "Δ loads", "Δ used s", "Main search solutions/s vs base"], rows) if rows else "No pair yet.")
    L += ["", "## Runs per arm (RECOMMENDED: median [min, max])", ""]
    rows = []
    for mode in dict.fromkeys(r["mode"] for r in records):
        for arm in dict.fromkeys(r["arm"] for r in records):
            for digest in dict.fromkeys(r["digest"] for r in records):
                rs = [r for r in records if r["mode"] == mode and r["arm"] == arm and r["digest"] == digest]
                if not rs:
                    continue
                ok = [r for r in rs if not r.get("error") and _primary(r)]
                busy = [((r.get("best_of") or {}).get("used") or 1) + (1 if (r.get("pyvrp") or {}).get("status") in
                                                                       ("CHOSEN", "NOT_CHOSEN") else 0) for r in ok]
                rows.append([labels.get(digest, digest), mode, arm, f"{len(ok)}/{len(rs)}",
                             _abs([_primary(r)["operating_omr"] for r in ok], 2), _abs([_primary(r)["km"] for r in ok], 1),
                             _abs([_primary(r)["trucks"] for r in ok], 0),
                             _abs([float(sum(_primary(r)["left_out_stops"])) for r in ok], 0),
                             _abs([(r.get("search") or {}).get("used_sec") or 0.0 for r in ok], 0),
                             (ok[0].get("search") or {}).get("cap_sec", "-") if ok else "-",
                             f"{max(busy)} on {cpus}" if busy else "-"])
    L.append(_table(["Request", "Mode", "Arm", "Runs ok", "Cash OMR", "km", "Trucks", "Stops left out", "Used s", "Cap s",
                     "Busy searches (RECOMMENDED phase) on CPUs"], rows) if rows else "No run yet.")
    bo_rows, pv_rows, rp_rows = [], [], []
    for mode in dict.fromkeys(r["mode"] for r in records):
        for arm in dict.fromkeys(r["arm"] for r in records):
            rs = [r for r in records if r["mode"] == mode and r["arm"] == arm and not r.get("error")]
            bos = [r["best_of"] for r in rs if r.get("best_of")]
            if bos:
                st = Counter(f"{s.get('status')}/{s.get('stop_reason')}" for b in bos for s in b.get("searches", [])
                             if s.get("index", 0) > 0)
                gains = [g["gain_operating_omr"] for b in bos for g in b.get("gains", [])
                         if g.get("option") == "RECOMMENDED" and g.get("gain_operating_omr") is not None]
                won = Counter(src for b in bos for src in b.get("won", {}).values())
                bo_rows.append([arm, mode, len(bos), f"{min(b['used'] for b in bos)}-{max(b['used'] for b in bos)} of "
                                f"{max(b['requested'] for b in bos)}", ", ".join(f"{k} {v}" for k, v in Counter(
                                    str(b.get("gate") or "none") for b in bos).items()),
                                ", ".join(f"{k} {v}" for k, v in sorted(st.items())) or "-",
                                ", ".join(f"{k} {v}" for k, v in Counter(o for b in bos for o in b.get("chosen_for", [])).items()) or "-",
                                ", ".join(f"{k} {v}" for k, v in won.items()) or "-", _med(gains, 2),
                                sum(1 for b in bos if b.get("promoted") is not None)])
            pvs = Counter(f"{(r.get('pyvrp') or {}).get('status')}/{(r.get('pyvrp') or {}).get('reason')}" for r in rs
                          if r.get("pyvrp"))
            if pvs:
                pv_rows.append([arm, mode, ", ".join(f"{k} {v}" for k, v in sorted(pvs.items()))])
            if any((r.get("effective") or {}).get("priority_repair") for r in rs):
                rec_opts = [_primary(r) for r in rs if _primary(r)]
                rp_rows.append([arm, mode, len(rs),
                                sum(1 for r in rs if any(o["repair"]["put_back"] for o in r["options"].values())),
                                sum(o["repair"]["put_back"] for r in rs for o in r["options"].values()),
                                sum(o["repair"]["displaced"] for r in rs for o in r["options"].values()),
                                sum(o["repair"]["tried_no_place_or_time"] for r in rs for o in r["options"].values()),
                                _abs([float(o["inverted"]) for o in rec_opts], 0)])
    if bo_rows:
        L += ["", "## Best-of searches", "",
              "Gain: the other searches' best RECOMMENDED candidate against the best one without them, in the same run "
              "(operating OMR, positive = cheaper; best_of.gains), whether or not it was used.", ""]
        L.append(_table(["Arm", "Mode", "Runs", "Searches run", "Gate", "Other searches status/stop", "Chosen for",
                         "Won by", "Gain OMR (RECOMMENDED)", "Main search replaced"], bo_rows))
    if pv_rows:
        L += ["", "## PyVRP second search", ""]
        L.append(_table(["Arm", "Mode", "Status/reason counts"], pv_rows))
    if rp_rows:
        L += ["", "## Priority repair", ""]
        L.append(_table(["Arm", "Mode", "Runs", "Runs repaired", "Stops put back", "Stops displaced",
                         "Tried, no place or time", "P1-P3 still out under a lower priority (RECOMMENDED)"], rp_rows))
    errs = [r for r in records if r.get("error") or robustness_failures(r) or not_verified(r)]
    if errs:
        L += ["", "## Failures", ""]
        L.append(_table(["Request", "Mode", "Arm", "Rep", "What"],
                        [[labels.get(r["digest"], r["digest"]), r["mode"], r["arm"], r["rep"],
                          "; ".join(robustness_failures(r) + not_verified(r))
                          + (f" ({r['error'].get('message')})" if r.get("error") else "")] for r in errs]))
    return "\n".join(L) + "\n"


# ---------------------------------------------------------------------------------------------
# The command
# ---------------------------------------------------------------------------------------------

def _parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="bench_search.py", description=__doc__.split("\n\n")[0],
                                formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("requests", nargs="*", help="saved request JSON files (glob patterns allowed)")
    p.add_argument("--arms", default=DEFAULT_ARMS, help=f"arms (default {DEFAULT_ARMS}); see the module docstring")
    p.add_argument("--base", default=None, help="the arm the others are paired against (default: base, else the first)")
    p.add_argument("--modes", default="QUICK,THOROUGH", help="QUICK, THOROUGH and/or ASKED (default QUICK,THOROUGH)")
    p.add_argument("--reps", type=int, default=3, help="repetitions per request, mode and arm (default 3)")
    p.add_argument("--out", default=None, help="results folder, outside the repository (results.jsonl, summary.md, ...)")
    p.add_argument("--cpu-note", default="", help="free text about the machine, recorded in the summary")
    p.add_argument("--matrix", choices=("cached", "asked", "haversine"), default="cached", help="road matrix (default cached)")
    p.add_argument("--max-concurrent", type=int, default=1, help="MAX_CONCURRENT_DISPATCH in the bench (default 1)")
    p.add_argument("--max-search-sec", type=int, default=None, help="override THOROUGH's cap (10-3600; not production)")
    p.add_argument("--stop-after-min", type=float, default=None, help="start no run after this many minutes")
    p.add_argument("--dry-run", action="store_true", help="check the inputs and print the plan; solve and write nothing")
    p.add_argument("--summary-only", action="store_true", help="rewrite summary.md from --out's results.jsonl")
    return p


@dataclass
class Plan:
    requests: list[RequestFile]
    arms: list[Arm]
    base: str
    modes: list[str]
    schedule: list[tuple[int, RequestFile, str, Arm, int]]  # (position, request, mode, arm, rep)
    out: Path | None


def prepare(args) -> Plan:
    if args.reps < 1:
        raise UsageError("--reps must be at least 1")
    if args.max_concurrent < 1:
        raise UsageError("--max-concurrent must be at least 1")
    if args.max_search_sec is not None and not 10 <= args.max_search_sec <= 3600:
        raise UsageError("--max-search-sec must be 10 to 3600")
    hooks = sorted(k for k in os.environ if k.startswith("ROUTEIQ_TEST_"))
    if hooks:
        raise UsageError(f"test hooks are set in this shell ({', '.join(hooks)}): unset them")
    out = check_out_dir(Path(args.out)) if args.out else None
    if not args.dry_run and out is None:
        raise UsageError("--out is needed (a folder outside the repository)")
    if not args.requests:
        raise UsageError("no request file given")
    arms = parse_arms(args.arms)
    check_arm_values(arms, args.max_concurrent)
    base = args.base or ("base" if any(a.name == "base" for a in arms) else arms[0].name)
    if base not in [a.name for a in arms]:
        raise UsageError(f"--base {base} is not one of the arms")
    modes = parse_modes(args.modes)
    requests = [load_request(p) for p in _expand(args.requests)]
    seen: dict[str, str] = {}
    for r in requests:
        if r.digest in seen:
            raise UsageError(f"{r.label} and {seen[r.digest]} are the same request")
        seen[r.digest] = r.label
    ordered = [base] + [a.name for a in arms if a.name != base]
    arms = sorted(arms, key=lambda a: ordered.index(a.name))
    schedule, group, position = [], 0, 0
    for rep in range(1, args.reps + 1):
        for rf in requests:
            for mode in dict.fromkeys(rf.facts["asked_mode"] if m == "ASKED" else m for m in modes):
                k = group % len(arms)
                for arm in arms[k:] + arms[:k]:
                    position += 1
                    schedule.append((position, rf, mode, arm, rep))
                group += 1
    return Plan(requests, arms, base, modes, schedule, out)


def _modes_of(plan: Plan, rf: RequestFile) -> list[str]:
    return list(dict.fromkeys(m for _p, r, m, _a, _rep in plan.schedule if r is rf))


def _header(plan: Plan, args) -> dict:
    ds, _BO, PV, _ = _solver()
    try:
        from importlib.metadata import version
        pyvrp_version = version("pyvrp")
    except Exception:  # noqa: BLE001 - informational
        pyvrp_version = None
    return {"v": TOOL_VERSION, "tool": "bench_search", "created": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            "base": plan.base, "arms": [{"name": a.name, "env": a.env} for a in plan.arms],
            "modes": plan.modes, "reps": args.reps, "matrix": args.matrix, "max_concurrent": args.max_concurrent,
            "max_search_sec": args.max_search_sec, "cpu_note": args.cpu_note, "commit": _commit(),
            "requests": [{"label": r.label, "digest": r.digest, "facts": r.facts, "modes": _modes_of(plan, r)}
                         for r in plan.requests],
            "machine": {"platform": platform.platform(terse=True), "python": platform.python_version(),
                        "cpus": os.cpu_count(), "effective_cpus": PV.effective_cpus(), "ortools": ds.ortools_version(),
                        "pyvrp": pyvrp_version},
            "env": _shell_env()}


def _merge_header(old: dict, new: dict) -> dict:
    """Continuing a replay in the same --out: the same arms (by name), base, matrix and machine settings, or refuse."""
    old_arms = {a["name"]: a["env"] for a in old.get("arms", [])}
    for a in new["arms"]:
        if a["name"] in old_arms and old_arms[a["name"]] != a["env"]:
            raise UsageError(f"arm {a['name']} ran with other settings in this --out ({old_arms[a['name']]}): "
                             "use another --out or another arm name")
    for k in ("base", "matrix", "max_concurrent", "max_search_sec"):
        if old.get(k) != new.get(k):
            raise UsageError(f"this --out was run with {k}={old.get(k)!r}, not {new.get(k)!r}: use another --out")
    merged = dict(new)
    arms = {a["name"]: a for a in old.get("arms", [])}
    arms.update({a["name"]: a for a in new["arms"]})
    merged["arms"] = list(arms.values())
    reqs = {r["digest"]: r for r in old.get("requests", [])}
    for r in new["requests"]:
        if r["digest"] in reqs:
            r = dict(r, modes=list(dict.fromkeys(reqs[r["digest"]].get("modes", []) + r["modes"])))
        reqs[r["digest"]] = r
    merged["requests"] = list(reqs.values())
    merged["modes"] = list(dict.fromkeys(old.get("modes", []) + new["modes"]))
    merged["reps"] = max(old.get("reps", 0), new["reps"])
    merged["created"] = old.get("created", new["created"])
    return merged


def _read_records(path: Path) -> list[dict]:
    if not path.exists():
        return []
    out = []
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if line:
            try:
                out.append(json.loads(line))
            except json.JSONDecodeError:
                continue  # a line cut by a crash: that run is done again
    return out


def describe(plan: Plan, args) -> str:
    _ds, _BO, PV, _ = _solver()
    L = ["bench_search dry run: nothing is solved, nothing is written.", "",
         f"requests ({len(plan.requests)}):"]
    for r in plan.requests:
        f = r.facts
        L.append(f"  {r.label}  digest {r.digest}: {f['stops']} stops ({f.get('solvable', '?')} to plan, "
                 f"{f.get('left_out_before_search', '?')} left out before the search), {f['trucks']} trucks "
                 f"({f['to_rent']} to rent), asked {f['asked_mode']}, THOROUGH cap {f['thorough_cap_sec']} s, "
                 f"QUICK limit {f.get('quick_limit_sec', '?')} s, P1-P5 stops {f['stops_by_priority']}")
        L.append(f"      small-truck-only stops {f['small_truck_only_stops']} (a list decides: "
                 f"{'yes' if f.get('limits_decide') else 'no'}); a stop fills a truck alone: "
                 f"{'yes' if f.get('full_truck_day') else 'no'}"
                 + ("  -> PyVRP is skipped as FULL_TRUCK whatever SOLVER_PYVRP_ALLOWED says" if f.get("full_truck_day") else "")
                 + (f"; prefilter failed: {f['prefilter_error']}" if f.get("prefilter_error") else "")
                 + ("; its osrm_url is ignored (only this machine's OSRM_URL is used)" if f.get("request_osrm_url_ignored") else ""))
    L.append("")
    L.append(f"arms ({len(plan.arms)}), paired against {plan.base}:")
    for a in plan.arms:
        saved = _apply(a, args.max_concurrent)
        try:
            parts = []
            for mode in MODES:
                e = _effective(mode)
                parts.append(f"{mode} best-of {e['best_of_cpu_gate']}" + (f" of {e['best_of']} ({e['best_of_gate']})"
                                                                          if e["best_of_gate"] else "")
                             + ", PyVRP " + ("off" if not e["pyvrp_on"] else "on, models small-truck-only days"
                                             if e["pyvrp_models_limits"] else "on"))
            repair = "on" if _effective("QUICK")["priority_repair"] else "off"
        finally:
            _restore(saved)
        L.append(f"  {a.name:12} {a.describe()}")
        L.append(f"  {'':12} as read: {'; '.join(parts)}; priority repair {repair}")
    n = len(plan.schedule)
    worst = 0.0
    for _p, rf, mode, _a, _rep in plan.schedule:
        f = rf.facts
        worst += (args.max_search_sec or f["thorough_cap_sec"]) if mode == "THOROUGH" else (f.get("quick_limit_sec") or 60) + 60
    L += ["", f"modes {', '.join(plan.modes)}; repetitions {args.reps}; matrix {args.matrix}; "
              f"MAX_CONCURRENT_DISPATCH={args.max_concurrent} in the bench (production {PRODUCTION_MAX_CONCURRENT})",
          f"runs: {n} ({len(plan.requests)} request(s) x mode(s) x {len(plan.arms)} arm(s) x {args.reps} rep(s)), "
          f"at most {worst / 3600:.1f} h (each THOROUGH run at its cap, each QUICK run at its limit + 60 s)",
          f"machine: {os.cpu_count()} CPUs, {PV.effective_cpus()} effective (production {PRODUCTION_CPUS}); "
          f"{args.cpu_note or 'no --cpu-note'}",
          f"out: {plan.out or '(not given)'}"]
    env = _shell_env()
    if env:
        L.append("shell environment kept for every arm: " + ", ".join(f"{k}={v}" for k, v in env.items()))
    return "\n".join(L)


def main(argv: list[str] | None = None) -> int:
    args = _parser().parse_args(argv)
    try:
        if args.summary_only:
            if not args.out:
                raise UsageError("--summary-only needs --out")
            out = check_out_dir(Path(args.out))
            head = out / "bench.json"
            if not head.exists():
                raise UsageError(f"no bench.json in {out}")
            header = json.loads(head.read_text(encoding="utf-8"))
            (out / "summary.md").write_text(summarize(_read_records(out / "results.jsonl"), header), encoding="utf-8")
            print(f"summary: {out / 'summary.md'}")
            return 0
        plan = prepare(args)
    except UsageError as exc:
        print(f"bench_search: {exc}", file=sys.stderr)
        return 2
    if args.dry_run:
        print(describe(plan, args))
        return 0
    return run(plan, args)


def run(plan: Plan, args) -> int:
    ds, *_ = _solver()
    out = plan.out
    assert out is not None
    out.mkdir(parents=True, exist_ok=True)
    results, head = out / "results.jsonl", out / "bench.json"
    header = _header(plan, args)
    try:
        if head.exists():
            header = _merge_header(json.loads(head.read_text(encoding="utf-8")), header)
    except UsageError as exc:
        print(f"bench_search: {exc}", file=sys.stderr)
        return 2
    head.write_text(json.dumps(header, indent=1), encoding="utf-8")
    records = _read_records(results)
    done = {(r["digest"], r["mode"], r["arm"], r["rep"]) for r in records}
    todo = [s for s in plan.schedule if (s[1].digest, s[2], s[3].name, s[4]) not in done]
    print(f"bench_search: {len(plan.schedule)} runs planned, {len(plan.schedule) - len(todo)} already in {results}, "
          f"{len(todo)} to run", flush=True)
    handler = logging.FileHandler(out / "solver.log", encoding="utf-8")
    handler.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(name)s: %(message)s"))
    rq = logging.getLogger("routeiq")
    level = rq.level
    rq.addHandler(handler)
    rq.setLevel(logging.INFO)
    real = ds.resolve_matrix
    if args.matrix == "cached":
        ds.resolve_matrix = MatrixCache(real)
    commit = header.get("commit")
    t_start = time.monotonic()
    code = 0
    try:
        for i, (position, rf, mode, arm, rep) in enumerate(todo, 1):
            if args.stop_after_min is not None and time.monotonic() - t_start > args.stop_after_min * 60:
                print(f"bench_search: --stop-after-min reached; {len(todo) - i + 1} run(s) left: run the same command again")
                break
            rec = run_one(rf, mode, arm, rep, position, args, commit)
            with results.open("a", encoding="utf-8") as fh:
                fh.write(json.dumps(rec, default=str) + "\n")
                fh.flush()
                os.fsync(fh.fileno())
            records.append(rec)
            (out / "summary.md").write_text(summarize(records, header), encoding="utf-8")
            print(_progress(i, len(todo), rec), flush=True)
    except (Interrupted, KeyboardInterrupt):
        code = 130
    finally:
        ds.resolve_matrix = real
        rq.removeHandler(handler)
        rq.setLevel(level)
        handler.close()
    (out / "summary.md").write_text(summarize(records, header), encoding="utf-8")
    ev = evaluate(records, header["base"], planned_pairs(header))
    for (mode, arm), e in ev.items():
        print(f"  {arm} {mode}: {e['verdict']} (pairs {e['pairs']}/{e['planned']}, win/tie/loss "
              f"{e['wins']}/{e['ties']}/{e['losses']})")
    print(f"bench_search: {results} and {out / 'summary.md'}")
    return code


def _progress(i: int, n: int, rec: dict) -> str:
    head = f"[{i}/{n}] {rec['request']} {rec['mode']} {rec['arm']} rep {rec['rep']}:"
    if rec.get("error"):
        return f"{head} ERROR {rec['error']['type']}"
    p = _primary(rec) or {}
    s = rec.get("search") or {}
    bo = rec.get("best_of") or {}
    pv = rec.get("pyvrp") or {}
    return (f"{head} {p.get('operating_omr', 0):.2f} OMR, {p.get('trucks')} trucks, {p.get('loads')} loads, "
            f"left out {sum(p.get('left_out_stops', []))}, {p.get('feasibility')}, used {s.get('used_sec', 0):.0f}/"
            f"{s.get('cap_sec')} s ({s.get('stop_reason')}), best-of {bo.get('used', 1)}"
            f"{'/' + str(bo['requested']) if bo else ''}, PyVRP {pv.get('status', '-')}")


if __name__ == "__main__":  # required: the searches run in spawned worker processes, which import this file
    sys.exit(main())
