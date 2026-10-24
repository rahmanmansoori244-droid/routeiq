"""Best-of-N route search: its settings, CPU gate, the stop orders of the other searches, and the report.

OR-Tools routing has no random seed (9.15.6755 has no seed field in its search parameters): searching the
same request again differs only by timing, while another order of the stops gives another first solution
and other neighbourhoods. Best-of-N runs RECOMMENDED's search K times at once, each in its own
worker process: search 0 (the main one) exactly as with one search - the request's order, the same
parameters, limit and stall rule - and searches 1..K-1 from other deterministic orders of the stops
(``order``), optionally with another first-solution strategy. The other searches only add candidates; the
engine's own checks, timing and cost score choose, as for the second search (PyVRP).

Every setting is OFF by default (owner decision 16 Oct 2026: nothing changes until a replay of saved real
requests shows a gain): SOLVER_BEST_OF and SOLVER_BEST_OF_QUICK are 1, so one search runs, exactly as before.
Settings are read on every call, like SOLVER_PYVRP; a value that cannot be read, or is out of range, falls
back to its default (as dispatch_solver._env_num does).

- SOLVER_BEST_OF (THOROUGH) / SOLVER_BEST_OF_QUICK (QUICK): searches per solve, 1 to MAX_K (default 1).
- SOLVER_BEST_OF_SOURCES: how many of the other searches' plans (the best ones, distinct from the main
  search's) go to the load re-check as candidate sources, 0 to MAX_SOURCES (default 1; never more than K-1).
  Each one adds one repack cap to the re-check's reserve, taken from RECOMMENDED's own search limit.
- SOLVER_BEST_OF_JOIN_SEC: THOROUGH, how long the other searches may go on after the main one ended,
  0 to 300 s (default 60).
- SOLVER_BEST_OF_STRATEGIES: first-solution strategies for searches 1.., comma-separated, from
  STRATEGY_WHITELIST (default PARALLEL_CHEAPEST_INSERTION only). Benchmarks and development only.

This module must not import pyvrp or numpy (the API process never loads them: test_api_process_no_pyvrp.py),
nor dispatch_solver (which imports it).
"""
from __future__ import annotations

import hashlib
import logging
import os
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from typing import Any, get_args

import pyvrp_candidate as PV
from dispatch_models import BestOfReport, SearchReport

log = logging.getLogger("routeiq.dispatch")

ENV_THOROUGH = "SOLVER_BEST_OF"
ENV_QUICK = "SOLVER_BEST_OF_QUICK"
ENV_SOURCES = "SOLVER_BEST_OF_SOURCES"
ENV_JOIN_SEC = "SOLVER_BEST_OF_JOIN_SEC"
ENV_STRATEGIES = "SOLVER_BEST_OF_STRATEGIES"

# Searches per solve, at most.
MAX_K = 8
# The other searches' plans sent to the load re-check, at most: each one adds one repack cap (30 s at the
# 20-minute cap) to the THOROUGH reserve, taken from RECOMMENDED's own search limit.
MAX_SOURCES = 2
DEFAULT_SOURCES = 1
# THOROUGH: how long the other searches may go on after the main one ended (SOLVER_BEST_OF_JOIN_SEC).
DEFAULT_JOIN_SEC = 60.0
MAX_JOIN_SEC = 300.0
# After the join: how long a search may take to hand back its best plan before it counts as TIMEOUT.
JOIN_GRACE_SEC = 10.0
# QUICK: how long the solve waits for the other searches once the main one is in (they end on their own
# time limit when it does - shortened by any wait to start - and nothing is attached to a QUICK search,
# so none can be joined: a later one is TIMEOUT and its process is stopped; critique of the design #14).
QUICK_WAIT_SEC = 5.0
# Ranking a search's plan that cannot be timed exactly: trim it for at most this long (as _trimmed does).
TRIM_FALLBACK_SEC = 1.5
# main.MAX_CONCURRENT_DISPATCH's default: solves that may run at once.
DEFAULT_MAX_CONCURRENT = 2

DEFAULT_STRATEGY = "PARALLEL_CHEAPEST_INSERTION"
STRATEGY_WHITELIST = (
    "PARALLEL_CHEAPEST_INSERTION",
    "LOCAL_CHEAPEST_INSERTION",
    "SEQUENTIAL_CHEAPEST_INSERTION",
    "LOCAL_CHEAPEST_COST_INSERTION",
)

# SearchRunReport.status values (a plain string in the model: run_status maps every outcome to one).
RUN_STATUSES = ("OPTIMIZED", "NO_SOLUTION", "NOTHING_TO_PLAN", "NOT_RUN", "FAILED", "LOST", "TIMEOUT")
# BestOfReport.gate values: too few CPUs for that many searches, no worker processes (SOLVER_PARALLEL=0),
# or the other searches' own pool could not start (dispatch_solver._start_extra_workers).
GATES = ("CPU_GATE", "IN_PROCESS", "NO_WORKERS")
# A search's stop reasons: SearchReport's own, plus JOINED (ended when the main search ended).
JOINED = "JOINED"

# The load re-check's source name of search i > 0 (search 0 is RECOMMENDED itself); a candidate built from
# it is named "<source>" or "<source>+<how>" (LR.Candidate.source).
EXTRA_PREFIX = "RECOMMENDED~"

# dispatch_solver._await_all's outcome kinds other than "ok" -> SearchRunReport.status.
_AWAIT_STATUS = {"error": "FAILED", "lost": "LOST", "broken": "LOST", "timeout": "TIMEOUT"}
_TOP_STOP_REASONS = frozenset(get_args(SearchReport.model_fields["stop_reason"].annotation))


@dataclass(frozen=True)
class SearchVariant:
    """One route search of RECOMMENDED: ``index`` 0 is the main search (the request's order, as with one
    search); ``order_seed`` 0 keeps the request's order, i > 0 sorts the stops by sha256(f"{i}:{stop_id}")."""

    index: int
    order_seed: int
    first_solution: str = DEFAULT_STRATEGY
    # Far-area grouping's twin search (far_area.py): RECOMMENDED's search with each far area pinned to its fewest
    # trucks, in the other searches' pool. Never one of best-of's searches: never ranked among them, never a
    # source of theirs, never the main plan nor the alternatives' start.
    far: bool = False

    @property
    def source(self) -> str:
        return source_name(self.index)


# ---------------------------------------------------------------------------------------------
# Settings (read on every call; every default is off)
# ---------------------------------------------------------------------------------------------

def _env_int(name: str, default: int, lo: int, hi: int) -> int:
    try:
        value = int(os.environ.get(name, "").strip())
    except ValueError:
        return default
    return value if lo <= value <= hi else default


def setting(mode: str) -> int:
    """Searches asked for: SOLVER_BEST_OF for a THOROUGH solve, SOLVER_BEST_OF_QUICK for a QUICK one,
    1 to MAX_K. Unset, unreadable or out of range: 1 (one search, as before)."""
    return _env_int(ENV_THOROUGH if mode == "THOROUGH" else ENV_QUICK, 1, 1, MAX_K)


def max_concurrent() -> int:
    """MAX_CONCURRENT_DISPATCH, read as main.py reads it (default 2; not a positive integer: the default)."""
    try:
        value = int(os.environ.get("MAX_CONCURRENT_DISPATCH", ""))
    except ValueError:
        return DEFAULT_MAX_CONCURRENT
    return value if value > 0 else DEFAULT_MAX_CONCURRENT


def sources(k: int) -> int:
    """The other searches' plans sent to the load re-check: SOLVER_BEST_OF_SOURCES (0 to MAX_SOURCES,
    default 1), never more than k - 1; 0 with one search."""
    if k <= 1:
        return 0
    return min(_env_int(ENV_SOURCES, DEFAULT_SOURCES, 0, MAX_SOURCES), k - 1)


def join_sec() -> float:
    """THOROUGH: SOLVER_BEST_OF_JOIN_SEC, 0 to MAX_JOIN_SEC (default 60)."""
    try:
        value = float(os.environ.get(ENV_JOIN_SEC, ""))
    except ValueError:
        return DEFAULT_JOIN_SEC
    return value if 0.0 <= value <= MAX_JOIN_SEC else DEFAULT_JOIN_SEC  # NaN fails both: the default


def strategies() -> tuple[str, ...]:
    """SOLVER_BEST_OF_STRATEGIES: the whitelisted names it lists, in its order, each once; names not on
    STRATEGY_WHITELIST are ignored. None left: (PARALLEL_CHEAPEST_INSERTION,)."""
    out: list[str] = []
    for part in os.environ.get(ENV_STRATEGIES, "").split(","):
        name = part.strip().upper()
        if name in STRATEGY_WHITELIST and name not in out:
            out.append(name)
    return tuple(out) or (DEFAULT_STRATEGY,)


def effective(mode: str, *, parallel: bool, pyvrp_on: bool) -> tuple[int, str | None]:
    """(searches to run, why fewer than asked). One asked: (1, None). No worker processes
    (SOLVER_PARALLEL=0): (1, "IN_PROCESS"). Otherwise each of MAX_CONCURRENT_DISPATCH solves may use
    effective_cpus // MAX_CONCURRENT_DISPATCH CPUs, one of them for the second search (PyVRP) when it runs:
    fewer than asked is "CPU_GATE" (24 CPUs at 2 solves: up to 11; a 4-CPU CI runner: 1)."""
    k = setting(mode)
    if k <= 1:
        return 1, None
    if not parallel:
        return 1, "IN_PROCESS"
    used = max(1, min(k, room(pyvrp_on)))
    return used, ("CPU_GATE" if used < k else None)


def room(pyvrp_on: bool) -> int:
    """Route searches one solve may run at once: effective_cpus // MAX_CONCURRENT_DISPATCH, less one for the
    second search (PyVRP) when it runs. Best-of's CPU gate (effective) and far-area grouping's twin search (one
    more process, only when a CPU is left after best-of's K) use it."""
    return PV.effective_cpus() // max_concurrent() - (1 if pyvrp_on else 0)


# ---------------------------------------------------------------------------------------------
# The searches and their stop orders
# ---------------------------------------------------------------------------------------------

def variants(k: int) -> list[SearchVariant]:
    """Search 0 (the request's order, PARALLEL_CHEAPEST_INSERTION), then searches 1..k-1: order seed i and
    the strategies of SOLVER_BEST_OF_STRATEGIES in turn. k is clamped to 1..MAX_K."""
    k = max(1, min(int(k), MAX_K))
    names = strategies()
    return [SearchVariant(0, 0, DEFAULT_STRATEGY)] + [SearchVariant(i, i, names[(i - 1) % len(names)]) for i in range(1, k)]


def _rank(seed: int, stop_id: str) -> str:
    return hashlib.sha256(f"{seed}:{stop_id}".encode()).hexdigest()


def order(stops: Sequence[Any], seed: int) -> list[int]:
    """The positions of ``stops`` (objects with ``stop_id``, or the ids themselves) in search ``seed``'s
    order. Seed 0: the request's order. Seed i > 0: sorted by sha256(f"{i}:{stop_id}") - the key of
    decision-support's ``seeded()``, so search i matches evidence seed i - which depends only on (seed,
    stop_id): not on the incoming order, nor on the Python version. Sorting a subset of the stops with it
    gives their relative order in the whole day's."""
    ids = [str(getattr(s, "stop_id", s)) for s in stops]
    if not seed:
        return list(range(len(ids)))
    return sorted(range(len(ids)), key=lambda k: (_rank(seed, ids[k]), ids[k], k))


def source_name(index: int) -> str:
    """The load re-check's source name of search ``index``: RECOMMENDED for the main search, else
    RECOMMENDED~<index>."""
    return "RECOMMENDED" if index == 0 else f"{EXTRA_PREFIX}{index}"


def from_extra(source: str) -> bool:
    """A candidate built from one of the other searches ("RECOMMENDED~2", "RECOMMENDED~2+repack"), not
    from the main search, an alternative or the second search (PyVRP)."""
    return source.split("+", 1)[0].startswith(EXTRA_PREFIX)


# ---------------------------------------------------------------------------------------------
# Report: total mappings, so no outcome of a search can fail a finished solve
# ---------------------------------------------------------------------------------------------

def run_status(kind: str, scenario_status: str | None = None) -> str:
    """SearchRunReport.status of one search from dispatch_solver._await_all's outcome ``kind`` ("ok",
    "error", "lost", "broken", "timeout") and, for "ok", the search's own status. Always one of
    RUN_STATUSES: an unknown kind or status is FAILED."""
    if kind == "ok":
        return scenario_status if scenario_status in RUN_STATUSES else "FAILED"
    return _AWAIT_STATUS.get(kind, "FAILED")


def top_level_stop_reason(reason: str | None) -> str | None:
    """A search's stop reason as SearchReport.stop_reason may hold it (for a search that replaced the main
    one): JOINED (ended when the main search ended) is CONVERGED; a reason SearchReport does not know is
    None - the caller then uses its own rule (CAP or CONVERGED by the time searched)."""
    if reason == JOINED:
        return "CONVERGED"
    return reason if reason in _TOP_STOP_REASONS else None


def report_or_none(data: BestOfReport | Mapping[str, Any] | None) -> BestOfReport | None:
    """SearchReport.best_of from the solve's best-of state: a report that does not validate is dropped
    with a warning (the plan is unaffected) instead of failing a finished solve."""
    if data is None:
        return None
    try:
        return data if isinstance(data, BestOfReport) else BestOfReport.model_validate(dict(data))
    except Exception as exc:  # noqa: BLE001 - a report must never cost the plan
        log.warning("best-of report left out (the plan is unaffected): %s", exc)
        return None


# ---------------------------------------------------------------------------------------------
# /ready and the startup line
# ---------------------------------------------------------------------------------------------

def _parallel() -> bool:
    """As dispatch_solver._parallel: False only with SOLVER_PARALLEL=0."""
    return os.environ.get("SOLVER_PARALLEL", "1") != "0"


def status() -> dict:
    """/ready's ``best_of`` and the startup line: searches asked for and run per mode, why fewer (CPU_GATE,
    IN_PROCESS), the other settings and the CPU figures. Never affects ``ok``."""
    out: dict[str, Any] = {}
    parallel = _parallel()
    for mode, key in (("THOROUGH", "thorough"), ("QUICK", "quick")):
        used, why = effective(mode, parallel=parallel, pyvrp_on=PV.enabled(mode)[0])
        out[key] = setting(mode)
        out[f"effective_{key}"] = used
        out[f"why_{key}"] = why
    out.update(sources=sources(out["effective_thorough"]), join_sec=join_sec(), strategies=list(strategies()),
               cpus=PV.effective_cpus(), max_concurrent=max_concurrent())
    return out


def unread() -> list[tuple[str, str, str]]:
    """The settings that are set but could not be read, or are out of range - each then counts as its default:
    (name, its value as set, what it takes). The startup line names them (review of 16 Oct 2026:
    SOLVER_BEST_OF=10 read as "SOLVER_BEST_OF=1" there, as if it had not been set)."""
    out: list[tuple[str, str, str]] = []
    for name, lo, hi, num in ((ENV_THOROUGH, 1, MAX_K, int), (ENV_QUICK, 1, MAX_K, int),
                              (ENV_SOURCES, 0, MAX_SOURCES, int), (ENV_JOIN_SEC, 0, int(MAX_JOIN_SEC), float)):
        raw = os.environ.get(name, "").strip()
        if not raw:
            continue
        try:
            ok = lo <= num(raw) <= hi  # NaN fails it
        except ValueError:
            ok = False
        if not ok:
            out.append((name, raw[:20], f"{'a whole number' if num is int else 'seconds'} from {lo} to {hi}"))
    return out


def _unread_clause() -> str:
    return "".join(f"; {name}={raw!r} not read ({what}): its default is used" for name, raw, what in unread())


def startup_line() -> str:
    st = status()
    if st["thorough"] == 1 and st["quick"] == 1:
        return f"Best-of route search: off (one route search per solve; {ENV_THOROUGH}=1, {ENV_QUICK}=1{_unread_clause()})"

    def part(mode: str, key: str) -> str:
        asked, used, why = st[key], st[f"effective_{key}"], st[f"why_{key}"]
        text = f"{mode} {used} search" + ("es" if used != 1 else "")
        return text + (f" of {asked} asked ({why})" if why else "")

    return (f"Best-of route search: {part('THOROUGH', 'thorough')}, {part('QUICK', 'quick')} "
            f"(effective CPUs {st['cpus']}, {st['max_concurrent']} solves at once, {st['sources']} extra source(s) "
            f"re-checked, join {st['join_sec']:g} s{_unread_clause()})")
