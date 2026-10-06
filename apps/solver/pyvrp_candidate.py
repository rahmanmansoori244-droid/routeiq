"""The second route search: PyVRP 0.14.0 (owner direction 30 Sep 2026).

"Enhance our model by using techniques from the best open-source solver on the standard public
sets." PyVRP's published solver (iterated local search, the library as released) searches the same
day as the engine's RECOMMENDED search, in a worker process of its own. Its best plan is then ONE
MORE CANDIDATE of the engine's post-solve stage (dispatch_solver._post_solve): re-timed exactly,
repacked with CP-SAT, scored on the RECOMMENDED objective and checked by feasibility.check_scenario.
The engine's own checks, timing and cost score stay the only judge. See docs/OPTIMIZER_BENCHMARK.md
section 12 and docs/OPTIMIZER_DESIGN.md.

What the guarantee is (and is not): the engine's own candidates are built from the same inputs and
with the same time as without PyVRP, and PyVRP's candidates are only added; ties keep the engine's
plan. So each option's plan is never worse, on that option's goal (unserved priority value first,
then cost), than the plan the engine alone would have chosen FROM THE SAME SEARCH. It is not a
promise against a separate engine-only run: on a machine short of CPU the second search takes CPU
from the engine's own search (the CPU gate below keeps it off on one core).

Nothing here imports pyvrp or numpy at module level: the model is built and searched in the second
search's own worker process (dispatch_solver._PvProcess), which answers with plain Python data only.
The API process loads neither native library (tests/test_api_process_no_pyvrp.py; the legacy
solver.py imports pyvrp lazily, only when its /optimize runs).

The model (all prices from the engine's own functions, in its units: 1 unit = 0.00001 OMR):
  locations   0 = depot; 1..R = "reload depots" at the depot's place, one per distinct search
              turnaround (dispatch_solver._approx_gap_s); then the solvable stops in the engine's
              order (client k = solvable[k], matrix node k + 1)
  vehicles    one VehicleType per group of interchangeable usable trucks
  hard        cases (trucks without bays) and / or pallet units (trucks with bays: 1/1000 pallet,
              TruckDay.max_pallet_units = bays x fill) and 0.1 kg units per load
              (dispatch_models.kg_units, TruckDay.max_kg_units), one delivery dimension each,
              hard receiving windows (config.window_rule FINISH: the latest start is closing - stop
              time, load_repack.latest_start_s), truck hours (TruckDay: frozen return, same-day
              loading, the latest return), loads per truck (max_reloads = trips_left - 1), shift
              maximum (maximum route duration; a truck-day that may need the driver break keeps its
              length free, as the engine's search: dispatch_solver._search_day_end)
  costs       fixed + first trip, km per rate class, trip cost on each reload, driver pay per second
              of the truck day, overtime past overtime_after_min, plan continuity per truck
  priorities  every stop optional; prize = the engine's own drop penalty (strict priorities)
Not expressible in PyVRP (the judge prices them exactly afterwards): preferred windows (tightened
into the hard window when they carry a price: "prefhard"), the P1/P2 early-arrival preference,
the loading time per case of the next load (80% of a full truck, as the engine's own search), the
driver-pay anchor of trucks with frozen loads, and the driver break itself (the exact timing places
it, the break-aware repack and feasibility.check_scenario hold every plan of this search to it).
"""
from __future__ import annotations

import json
import logging
import math
import os
import time
from dataclasses import dataclass, field
from typing import TYPE_CHECKING

import load_repack as LR
from dispatch_models import DispatchRequest, DispatchStop, kg_units

if TYPE_CHECKING:  # numpy is imported where the model is built, in the worker process only
    import numpy as np

log = logging.getLogger("routeiq.dispatch")

VERSION = "0.14.0"  # requirements.txt pins exactly this (test_pyvrp_version_is_pinned)
# THOROUGH: while the engine searches, the second search goes on (it costs no waiting). Once the
# engine's searches ended, it stops when its last better plan is older than max(STALL_FLOOR_SEC,
# STALL_SHARE x its search time) - never before QUICK's time for the day - or at the load re-check's
# reserve (decision D3), a stop request or a cancel. Timed, not counted in iterations: 300,000
# iterations without a better plan (the first rule) took 29-87 minutes at the measured 57-171
# iterations/s, so it never triggered and every Thorough solve waited until the reserve.
STALL_FLOOR_SEC = 30.0
STALL_SHARE = 0.1
FLAG_CHECK_SEC = 0.25  # the stop flags (pipes, dispatch_solver._PipeFlag) are polled at most this often
INT62 = 2**62  # PyVRP's costs are int64: every penalised cost must stay below this (section 7)
DEFAULT_MAX_PENALTY = 100_000.0  # pyvrp.PenaltyParams().max_penalty
# Plan continuity needs one distance profile per truck; above this many MB of profiles the PyVRP
# model leaves continuity out (the judge still prices every moved stop).
CONTINUITY_PROFILE_MB = 64


class ModelTooLarge(ValueError):
    """The day's worst penalised cost could pass int64 (section 7): PyVRP is skipped."""


# ---------------------------------------------------------------------------------------------
# Switch and CPU gate
# ---------------------------------------------------------------------------------------------

def setting() -> str:
    """SOLVER_PYVRP: "on" (default), "off" (also 0 / false / no) or "thorough" (night plans only)."""
    v = os.environ.get("SOLVER_PYVRP", "on").strip().lower()
    if v in ("0", "off", "false", "no"):
        return "off"
    return "thorough" if v == "thorough" else "on"


def min_cpus() -> int:
    try:
        return max(1, int(os.environ.get("SOLVER_PYVRP_MIN_CPUS", "2")))
    except ValueError:
        return 2


def seed() -> int:
    try:
        return int(os.environ.get("SOLVER_PYVRP_SEED", "1"))
    except ValueError:
        return 1


def max_iters() -> int | None:
    """SOLVER_PYVRP_MAX_ITERS: tests and development only - stop after N iterations."""
    try:
        n = int(os.environ.get("SOLVER_PYVRP_MAX_ITERS", ""))
    except ValueError:
        return None
    return n if n > 0 else None


def _env_float(name: str, default: float, lo: float, hi: float) -> float:
    try:
        v = float(os.environ.get(name, ""))
    except ValueError:
        return default
    return v if lo <= v <= hi else default


def stall_floor_sec() -> float:
    """THOROUGH: the shortest stall, in seconds, once the engine's searches ended (SOLVER_PYVRP_STALL_SEC)."""
    return _env_float("SOLVER_PYVRP_STALL_SEC", STALL_FLOOR_SEC, 0.1, 3600.0)


def stall_share() -> float:
    """THOROUGH: the stall's share of the search time so far (SOLVER_PYVRP_STALL_SHARE)."""
    return _env_float("SOLVER_PYVRP_STALL_SHARE", STALL_SHARE, 0.0, 10.0)


def stop_grace_sec() -> float:
    try:
        v = float(os.environ.get("SOLVER_PYVRP_STOP_GRACE_SEC", "10"))
    except ValueError:
        return 10.0
    return v if 0.5 <= v <= 120 else 10.0


def cgroup_cpus(cpu_max: str | None = None, quota_us: str | None = None, period_us: str | None = None) -> float | None:
    """CPUs a container quota allows: cgroup v2 ``cpu.max`` ("max 100000" = none, "200000 100000" =
    2), else cgroup v1 ``cpu.cfs_quota_us`` / ``cpu.cfs_period_us`` (-1 = none). None: no quota."""
    try:
        if cpu_max is not None:
            quota, _, period = cpu_max.strip().partition(" ")
            if quota == "max":
                return None
            return int(quota) / int(period or "100000")
        if quota_us is not None and period_us is not None:
            q, p = int(quota_us.strip()), int(period_us.strip())
            return q / p if q > 0 and p > 0 else None
    except (ValueError, ZeroDivisionError):
        return None
    return None


def _read(path: str) -> str | None:
    try:
        with open(path, encoding="ascii") as f:
            return f.read()
    except OSError:
        return None


def effective_cpus() -> int:
    """The CPUs this process may use: its affinity (Linux), capped by a container quota (Railway),
    else os.cpu_count()."""
    try:
        n = len(os.sched_getaffinity(0))  # type: ignore[attr-defined]
    except (AttributeError, OSError):
        n = os.cpu_count() or 1
    quota = cgroup_cpus(_read("/sys/fs/cgroup/cpu.max"))
    if quota is None:
        quota = cgroup_cpus(None, _read("/sys/fs/cgroup/cpu/cpu.cfs_quota_us"), _read("/sys/fs/cgroup/cpu/cpu.cfs_period_us"))
    if quota is not None:
        n = min(n, max(1, int(math.floor(quota))))
    return max(1, n)


def installed_version() -> str | None:
    try:
        from importlib.metadata import version  # noqa: PLC0415

        return version("pyvrp")
    except Exception:  # noqa: BLE001
        return None


def enabled(search_mode: str) -> tuple[bool, str | None]:
    """(on, why not): OFF (SOLVER_PYVRP, or "thorough" on a QUICK solve) or CPU_GATE."""
    s = setting()
    if s == "off" or (s == "thorough" and search_mode != "THOROUGH"):
        return False, "OFF"
    if effective_cpus() < min_cpus():
        return False, "CPU_GATE"
    return True, None


def status() -> dict:
    """/ready's ``pyvrp`` and the startup line: never affects ``ok``."""
    s, cpus, need = setting(), effective_cpus(), min_cpus()
    why = "OFF" if s == "off" else ("CPU_GATE" if cpus < need else None)
    return {"enabled": why is None, "setting": s, "version": installed_version(), "effective_cpus": cpus,
            "min_cpus": need, "why": why}


def startup_line() -> str:
    st = status()
    if st["enabled"]:
        scope = "thorough searches only" if st["setting"] == "thorough" else "every search"
        return (f"PyVRP second search: on for {scope} (pyvrp {st['version']}, effective CPUs {st['effective_cpus']}, "
                f"min {st['min_cpus']})")
    why = "SOLVER_PYVRP=off" if st["why"] == "OFF" else f"CPU_GATE: effective CPUs {st['effective_cpus']} < {st['min_cpus']}"
    return f"PyVRP second search: off ({why})"


# ---------------------------------------------------------------------------------------------
# The model
# ---------------------------------------------------------------------------------------------

@dataclass
class PvModel:
    """Plain data for PyVRP (built in the worker) and what the mapping back needs."""

    depots: list[dict]
    clients: list[dict]
    vehicle_types: list[dict]
    coords: list[tuple[float, float]]
    dist: list[np.ndarray]
    dur: np.ndarray
    type_trucks: list[list[int]]  # vehicle type -> TruckDay.idx, in code order
    max_penalty: float
    penalty_mode: str  # DEFAULT or RAISED
    summary: dict = field(default_factory=dict)


def _local_xy(req: DispatchRequest, stops: list[DispatchStop]) -> list[tuple[float, float]]:
    """Depot-relative metres: PyVRP uses x / y only for its geometric neighbourhood, never for cost."""
    lat0, lng0 = req.depot.lat, req.depot.lng
    kx = 111_320.0 * math.cos(math.radians(lat0))
    ky = 110_574.0
    return [(0.0, 0.0)] + [(round((s.lng - lng0) * kx, 1), round((s.lat - lat0) * ky, 1)) for s in stops]


def worst_case(prizes_total: int, vtypes: list[dict], dist: list[np.ndarray], dur: np.ndarray, clients: list[dict],
               depots: list[dict]) -> tuple[int, int]:
    """(base, per unit of penalty): a conservative bound on PyVRP's penalised cost is
    base + max_penalty x per_unit (critique correction 6). Arcs: each client, reload and route end
    has one incoming arc. Time warp and route duration per route: all service, every arc at the
    longest drive, every reload at the longest turnaround, the horizon - doubled for the excess over
    the shift maximum."""
    n_veh = sum(v["num_available"] for v in vtypes)
    reloads = sum(v["num_available"] * v["max_reloads"] for v in vtypes)
    n_cl = len(clients)
    arcs = n_cl + reloads + n_veh
    max_arc = max(int(m.max()) for m in dist) if dist else 0
    max_drive = int(dur.max()) if dur.size else 0
    max_turn = max((d["service"] for d in depots), default=0)
    service = sum(c["service"] for c in clients)
    horizon = max((v["tw_late"] for v in vtypes), default=0)
    tw = 2 * (service + arcs * max_drive + reloads * max_turn + n_veh * horizon)
    base = prizes_total + max_arc * arcs * n_veh
    base += sum(v["num_available"] * (v["fixed_cost"] + (v["unit_duration_cost"] + v["unit_overtime_cost"]) * tw)
                for v in vtypes)
    load = sum(sum(c["delivery"]) for c in clients)
    return int(base), int(load + tw)


def build_model(req: DispatchRequest, solvable: list[DispatchStop], tds: list, mx) -> PvModel:
    """``solvable`` / ``mx``: exactly what the engine's search sees (mx node 0 = depot, node k + 1 =
    solvable[k]); ``tds``: every TruckDay (only the usable ones become vehicles). Raises ValueError
    with nothing to model and ModelTooLarge past the 64-bit bound."""
    import numpy as np  # noqa: PLC0415 - never in the API process (see the module's docstring)

    import dispatch_solver as ds  # noqa: PLC0415 - dispatch_solver imports this module

    cfg = req.config
    w = ds.SCENARIOS["RECOMMENDED"]
    n = len(solvable)
    vehicles = [td for td in tds if td.usable]
    if not vehicles or not n:
        raise ValueError("nothing to model (no usable truck or no solvable stop)")
    D = np.asarray(mx.distance_m, dtype=np.int64)
    T = np.asarray(mx.duration_s, dtype=np.int64)

    gaps = sorted({ds._approx_gap_s(cfg, td) for td in vehicles if td.trips_left > 1})
    reload_of_gap = {g: 1 + i for i, g in enumerate(gaps)}
    R = len(gaps)
    loc_node = [0] + [0] * R + list(range(1, n + 1))  # location -> engine matrix node

    use_margin = cfg.use_margin and all(s.margin is not None for s in solvable)
    values, _ = ds._service_values(solvable, cfg, use_margin)
    prizes = ds._drop_penalties(values, w)
    kg_dem = [kg_units(s.demand_kg) for s in solvable]
    kg_active = any(td.max_kg_units > 0 for td in vehicles) and any(kg_dem)
    # Space: cases when a usable truck has no bays, pallet units when one has bays (both in a mixed
    # fleet); a truck gets room for the whole day in the measure it does not use, as in the engine.
    cases_active = any(not td.by_pallets for td in vehicles)
    pal_dem = [int(s.demand_pallet_units or 0) for s in solvable]
    pal_active = any(td.by_pallets for td in vehicles)
    no_pal = sum(pal_dem) + 1
    # Preferred windows become part of the hard window only when they carry a price (C10: the
    # engine ignores them at 0) and the intersection is not empty.
    prefhard = cfg.pref_window_penalty_per_min > 0
    horizon = ds.HORIZON_S
    clients, n_tight = [], 0
    for k, s in enumerate(solvable):
        hs = (s.hard_start_min or 0) * 60
        # config.window_rule FINISH: unloading finished by closing, so the latest START is closing -
        # stop time, and a preferred end means "finished by" (the engine's one meaning of both).
        he = min(LR.latest_start_s(s, cfg.window_rule), horizon)
        if prefhard and (s.pref_start_min is not None or s.pref_end_min is not None):
            pe = LR.pref_end_bound_s(s, cfg.window_rule)
            a = max(hs, s.pref_start_min * 60 if s.pref_start_min is not None else hs)
            b = min(he, pe if pe is not None else he)
            if a <= b:
                hs, he = a, b
                n_tight += 1
        clients.append(dict(delivery=([int(s.demand_cases)] if cases_active else []) + ([pal_dem[k]] if pal_active else [])
                            + ([int(kg_dem[k])] if kg_active else []),
                            service=int(s.service_min * 60), tw_early=int(hs), tw_late=int(he), prize=int(prizes[k])))

    L = 1 + R + n
    continuity = w.soft_prefs and cfg.change_penalty_per_stop > 0 and any(s.previous_truck_id for s in solvable)
    if continuity and len(vehicles) * L * L * 16 > CONTINUITY_PROFILE_MB * 1_000_000:
        continuity = False  # memory cap (C14): the judge still prices every moved stop
    change_units = int(round(cfg.change_penalty_per_stop * ds.COST_SCALE))
    time_coeff = int(round(cfg.driver_cost_per_hour * w.time * ds.COST_SCALE / 3600.0))
    ot_coeff = int(round(cfg.overtime_cost_per_hour * ds.COST_SCALE / 3600.0)) if cfg.overtime_after_min is not None else 0
    shift_s = cfg.shift_max_min * 60
    no_kg = sum(kg_dem) + 1  # a truck without a payload: the engine's own "unlimited"
    hp = ds.hire_premium(req)  # trucks to rent (the hire suggestion): their search premium, as in the engine
    groups: dict[tuple, list] = {}
    for td in vehicles:
        t = td.truck
        km_key = int(round(ds._km_rate_omr(t, cfg) * w.distance * ds.COST_SCALE / 1000.0 * 1000))
        trip_units = int(round(t.trip_cost * w.trip * ds.COST_SCALE))
        fixed = ((t.fixed_cost + ds.hire_extra_omr(t, hp)) * w.fixed if td.n_frozen == 0 else 0.0) + t.trip_cost * w.trip
        gap = ds._approx_gap_s(cfg, td)
        first = td.earliest_depart_s if td.ready_s is None else max(td.earliest_depart_s, td.ready_s + gap)
        kg_cap = (td.max_kg_units if td.max_kg_units > 0 else no_kg) if kg_active else None
        # The space capacities in the delivery order: cases (CASES_FREE on a truck with bays), then
        # pallet units (the whole day's on a truck without bays).
        space = ([int(td.max_cases)] if cases_active else []) + (
            [int(td.max_pallet_units if td.by_pallets else no_pal)] if pal_active else [])
        # Driver break: as in the engine's search, a DUE truck-day keeps the break's length free of
        # its shift (span and latest return); the exact timing places the break afterwards.
        end_s, span_s = ds._search_day_end(td, first, shift_s)
        key = (tuple(space), kg_cap, km_key, trip_units, int(round(fixed * ds.COST_SCALE)), min(first, td.latest_return_s),
               end_s, td.trips_left, td.shift_anchor_s, td.frozen_return_s, gap, span_s, t.id if continuity else None)
        groups.setdefault(key, []).append(td)

    prof_of: dict[tuple, int] = {}
    dist: list[np.ndarray] = []
    vtypes: list[dict] = []
    type_trucks: list[list[int]] = []
    for key, members in groups.items():
        space, kg_cap, km_key, trip_units, fixed_u, tw_e, tw_l, trips_left, anchor, _frozen_ret, gap, span_s, cont_id = key
        pkey = (km_key, trip_units, cont_id)
        if pkey not in prof_of:
            M = np.rint(D * km_key / 1000.0).astype(np.int64)  # the engine: int(round(d * key / 1000)) per arc
            full = M[np.ix_(loc_node, loc_node)].copy()
            for r in range(1, R + 1):
                full[:, r] += trip_units + 1  # a reload = one more load (+1: never reload for nothing)
            if cont_id is not None:
                for k, s in enumerate(solvable):
                    if s.previous_truck_id and s.previous_truck_id != cont_id:
                        full[:, 1 + R + k] += change_units
            np.fill_diagonal(full, 0)
            prof_of[pkey] = len(dist)
            dist.append(full)
        if anchor is None:  # the longest route: the shift maximum (less a DUE truck's break)
            if ot_coeff and cfg.overtime_after_min is not None and cfg.overtime_after_min * 60 < span_s:
                nominal, max_ot = cfg.overtime_after_min * 60, span_s - cfg.overtime_after_min * 60
            else:
                nominal, max_ot = span_s, 0
        else:
            # Frozen loads: the window already ends at anchor + shift maximum; only NEW overtime
            # counts (audit E4, load_repack.overtime_bound_s). Approximate: PyVRP counts from its own
            # route start.
            span = max(0, tw_l - tw_e)
            bound = LR.overtime_bound_s(members[0], cfg.overtime_after_min * 60) if cfg.overtime_after_min is not None else None
            if ot_coeff and bound is not None:
                nominal = int(min(span, max(0, bound - tw_e)))
                max_ot = span - nominal
            else:
                nominal, max_ot = span, 0
        vtypes.append(dict(num_available=len(members), capacity=list(space) + ([int(kg_cap)] if kg_cap is not None else []),
                           fixed_cost=int(fixed_u), tw_early=int(tw_e), tw_late=int(tw_l), shift_duration=int(nominal),
                           max_overtime=int(max_ot), unit_duration_cost=int(time_coeff),
                           unit_overtime_cost=int(ot_coeff) if max_ot else 0, profile=prof_of[pkey],
                           reload_depots=[reload_of_gap[gap]] if trips_left > 1 else [],
                           max_reloads=max(0, int(trips_left) - 1)))
        type_trucks.append([td.idx for td in sorted(members, key=lambda x: ((x.truck.code or x.truck.id).encode(), x.idx))])

    Tf = T[np.ix_(loc_node, loc_node)].copy()
    np.fill_diagonal(Tf, 0)
    for r in range(1, R + 1):  # depot <-> reload depot: the same place
        Tf[0, r] = Tf[r, 0] = 0
        for r2 in range(1, R + 1):
            Tf[r, r2] = 0
    earliest = min(v["tw_early"] for v in vtypes)
    latest = max(v["tw_late"] for v in vtypes)
    depots = [dict(tw_early=int(earliest), tw_late=int(latest), service=0)]
    depots += [dict(tw_early=int(earliest), tw_late=int(latest), service=int(g)) for g in gaps]
    xy = _local_xy(req, solvable)
    coords = [xy[node] for node in loc_node]

    # Section 7: default penalties unless the fleet is short of capacity; then 10 x the largest prize,
    # clamped so that the worst penalised cost stays below 2^62.
    # space: cases, pallets on an all-bay fleet, or each truck's own measure on a mixed fleet (_mixed_space_proven)
    short_space, short_kg = ds._fleet_shortage(solvable, tds)
    base, per_unit = worst_case(int(sum(prizes)), vtypes, dist, Tf, clients, depots)
    if short_space or short_kg:
        safe = (INT62 - base) // max(1, per_unit)
        max_penalty, mode = float(min(10 * max(prizes), safe)), "RAISED"
    else:
        max_penalty, mode = DEFAULT_MAX_PENALTY, "DEFAULT"
    if max_penalty < 1 or base + int(max_penalty) * per_unit >= INT62:
        raise ModelTooLarge(f"worst penalised cost {base + int(max(1, max_penalty)) * per_unit:.3g} >= 2^62")
    summary = dict(clients=n, types=len(vtypes), profiles=len(dist), reload_depots=R, kg="on" if kg_active else "off",
                   pallets="on" if pal_active else "off",
                   prefhard=n_tight, shortage="yes" if (short_space or short_kg) else "no", continuity=bool(continuity),
                   penalty=mode if mode == "DEFAULT" else f"RAISED {max_penalty:.2g}",
                   prizes=f"{min(prizes):.1e}..{max(prizes):.1e}")
    return PvModel(depots=depots, clients=clients, vehicle_types=vtypes, coords=coords, dist=dist, dur=Tf.astype(np.int64),
                   type_trucks=type_trucks, max_penalty=max_penalty, penalty_mode=mode, summary=summary)


def problem_data(m: PvModel):
    """PyVRP 0.14 ProblemData of the model (imports pyvrp)."""
    import pyvrp  # noqa: PLC0415

    nd = len(m.depots)
    locs = [pyvrp.Location(x=float(x), y=float(y)) for x, y in m.coords]
    depots = [pyvrp.Depot(location=i, tw_early=d["tw_early"], tw_late=d["tw_late"], service_duration=d["service"])
              for i, d in enumerate(m.depots)]
    clients = [pyvrp.Client(location=nd + k, delivery=c["delivery"], service_duration=c["service"], tw_early=c["tw_early"],
                            tw_late=c["tw_late"], prize=c["prize"], required=False) for k, c in enumerate(m.clients)]
    vts = [pyvrp.VehicleType(num_available=v["num_available"], capacity=v["capacity"], start_depot=0, end_depot=0,
                             fixed_cost=v["fixed_cost"], tw_early=v["tw_early"], tw_late=v["tw_late"],
                             shift_duration=v["shift_duration"], max_overtime=v["max_overtime"], unit_distance_cost=1,
                             unit_duration_cost=v["unit_duration_cost"], unit_overtime_cost=v["unit_overtime_cost"],
                             profile=v["profile"], reload_depots=v["reload_depots"], max_reloads=v["max_reloads"])
           for v in m.vehicle_types]
    return pyvrp.ProblemData(locs, clients, depots, vts, m.dist, [m.dur] * len(m.dist))


# ---------------------------------------------------------------------------------------------
# The search (in its own worker process)
# ---------------------------------------------------------------------------------------------

@dataclass(frozen=True)
class PvSettings:
    mode: str  # QUICK or THOROUGH
    seed: int
    max_runtime: float  # seconds from the job's start: the backstop (THOROUGH: the re-check reserve)
    min_sec: float  # THOROUGH: never stops on its stall before QUICK's time for the day
    stall_floor_sec: float = STALL_FLOOR_SEC
    stall_share: float = STALL_SHARE
    max_iters: int | None = None


class Stopper:
    """PyVRP's stopping criterion: called once per iteration with the best feasible cost. Stops on
    the backstop time, the iteration limit (tests) and - read at most every FLAG_CHECK_SEC - the
    pool's "search over" flag (the engine's searches ended) or, THOROUGH only, its stop flag (a stop
    request or a cancel; a QUICK solve is not stoppable, a cancel kills it). QUICK stops as soon as
    the engine's searches ended; THOROUGH then stops on its timed stall (STALL_FLOOR_SEC)."""

    def __init__(self, s: PvSettings, started: float, stop_flag=None, search_over=None, clock=time.perf_counter):
        self.s = s
        self.started = started
        self.stop_flag = stop_flag
        self.search_over = search_over
        self.clock = clock
        self.engine_done = False
        self.next_check = 0.0
        self.iters = 0
        self.best: float | None = None
        self.last_sec: float | None = None
        self.points: list[tuple[float, float]] = []
        self.reason: str | None = None

    def __call__(self, best_cost) -> bool:
        now = self.clock()
        self.iters += 1
        t = now - self.started
        try:
            feasible = best_cost < INT62
        except TypeError:
            feasible = False
        if feasible and (self.best is None or best_cost < self.best):
            self.best, self.last_sec = best_cost, t
            self.points.append((round(t, 1), round(float(best_cost) / 100_000, 2)))
        if self.s.max_iters is not None and self.iters >= self.s.max_iters:
            return self._end("ITERATIONS")
        if t >= self.s.max_runtime:
            return self._end("CAP" if self.s.mode == "THOROUGH" else "MAX_RUNTIME")
        if now >= self.next_check:
            self.next_check = now + FLAG_CHECK_SEC
            if self.s.mode == "THOROUGH" and self.stop_flag is not None and self.stop_flag.is_set():
                return self._end("STOPPED")
            if self.search_over is not None and self.search_over.is_set():
                if self.s.mode != "THOROUGH":
                    return self._end("SEARCH_END")
                self.engine_done = True
        if self.engine_done and t >= self.s.min_sec:
            # Its timed stall, once the engine's searches ended; no feasible plan yet: from its start.
            last = self.last_sec if self.last_sec is not None else 0.0
            if t - last >= max(self.s.stall_floor_sec, self.s.stall_share * t):
                return self._end("CONVERGED")
        return False

    def _end(self, why: str) -> bool:
        self.reason = self.reason or why
        return True

    def report_points(self) -> list[list[float]]:
        pts = self.points
        if len(pts) > 12:
            idx = sorted({round(i * (len(pts) - 1) / 11) for i in range(12)})
            pts = [pts[i] for i in idx]
        return [list(p) for p in pts]


def routes_of(sol) -> list[dict]:
    """[{vt, trips: [[client index, ...] per load]}] for every used route (0.14: activities)."""
    out = []
    for r in sol.routes():
        trips: dict[int, list[int]] = {}
        for a in r:
            if a.is_client():
                trips.setdefault(int(a.trip), []).append(int(a.idx))
        loads = [trips[t] for t in sorted(trips) if trips[t]]
        if loads:
            out.append(dict(vt=int(r.vehicle_type()), trips=loads))
    return out


def solve_in_worker(job) -> dict:
    """``job`` = (req, solvable, tds, mx, PvSettings). Builds the model and runs PyVRP's own solver
    (pyvrp.solve, default parameters; max_penalty raised only on capacity-shortage days). Returns
    plain data: status OK / SKIPPED / FAILED with a reason, the routes as client indices per load and
    vehicle type, and what the search report needs. Test hooks: ROUTEIQ_TEST_FAIL_PYVRP (raises),
    ROUTEIQ_TEST_HANG_PYVRP (sleeps, ignoring every flag), ROUTEIQ_TEST_KILL_PYVRP (the process dies),
    ROUTEIQ_TEST_PYVRP_IMPORT_FAIL and ROUTEIQ_TEST_PYVRP_PLAN (a JSON plan {truck idx: [[stop k, ...],
    ...]} returned instead of searching)."""
    import dispatch_solver as ds  # noqa: PLC0415

    t0 = time.perf_counter()
    c0 = time.process_time()
    if os.environ.get("ROUTEIQ_TEST_FAIL_PYVRP"):
        raise RuntimeError("test hook: the second search failed")
    if os.environ.get("ROUTEIQ_TEST_HANG_PYVRP"):
        time.sleep(3600)
    if os.environ.get("ROUTEIQ_TEST_KILL_PYVRP"):
        os._exit(137)
    req, solvable, tds, mx, s = job
    base = dict(version=installed_version(), seed=s.seed)
    injected = os.environ.get("ROUTEIQ_TEST_PYVRP_PLAN")
    if injected:
        plan = {int(k): [list(map(int, load)) for load in v] for k, v in json.loads(injected).items()}
        return dict(base, status="OK", reason=None, feasible=True, plan=plan, iterations=0, search_sec=0.0,
                    stop_reason="ITERATIONS", penalty_mode="DEFAULT", summary={}, points=[], last_improvement_sec=None)
    try:
        if os.environ.get("ROUTEIQ_TEST_PYVRP_IMPORT_FAIL"):
            raise ImportError("test hook: pyvrp cannot be imported")
        import pyvrp  # noqa: PLC0415
        from pyvrp.solve import SolveParams  # noqa: PLC0415
    except ImportError as exc:
        return dict(base, status="FAILED", reason="IMPORT_FAILED", error=str(exc))
    try:
        model = build_model(req, solvable, tds, mx)
    except ModelTooLarge as exc:
        return dict(base, status="SKIPPED", reason="MODEL_TOO_LARGE", error=str(exc))
    except ValueError as exc:
        return dict(base, status="SKIPPED", reason="NOTHING_TO_PLAN", error=str(exc))
    data = problem_data(model)
    params = SolveParams() if model.penalty_mode == "DEFAULT" else SolveParams(
        penalty=pyvrp.PenaltyParams(max_penalty=model.max_penalty))
    stop = Stopper(s, t0, ds._STOP_FLAG, getattr(ds, "_SEARCH_OVER", None))
    t_search = time.perf_counter()
    res = pyvrp.solve(data, stop=stop, seed=s.seed, collect_stats=False, display=False, params=params)
    best = res.best
    feasible = bool(best.is_feasible())
    routes = routes_of(best) if feasible else []
    return dict(
        base, status="OK", reason=None if feasible else "NO_FEASIBLE_PLAN", feasible=feasible, routes=routes,
        type_trucks=model.type_trucks, iterations=int(res.num_iterations), search_sec=round(time.perf_counter() - t_search, 1),
        stop_reason=stop.reason or "SEARCH_END", last_improvement_sec=round(stop.last_sec, 1) if stop.last_sec is not None else None,
        points=stop.report_points(), penalty_mode=model.penalty_mode, summary=model.summary,
        routes_used=len(routes), loads=sum(len(r["trips"]) for r in routes), missing=int(best.num_missing_clients()),
        cpu_sec=round(time.process_time() - c0, 1), wall_sec=round(time.perf_counter() - t0, 1),
    )


# ---------------------------------------------------------------------------------------------
# Mapping back, validation and the PyVRP source's own stage job
# ---------------------------------------------------------------------------------------------

def plan_of(result: dict, tds: list, solvable: list[DispatchStop]) -> tuple[LR.Plan | None, str | None]:
    """PyVRP's answer -> {truck idx: [load, ...]} (a vehicle type's routes take its trucks in code
    order: they are interchangeable, and the repack relabels identical trucks anyway), validated so
    that a PyVRP bug can never reach _assert_reconciled: client indices in range and each at most
    once, loads per truck <= trips_left, every load within the truck's pallet units (a truck with
    bays) or cases and its 0.1 kg units. (None, INVALID_PLAN) otherwise."""
    by_idx = {td.idx: td for td in tds if td.usable}
    plan: LR.Plan = {}
    try:
        if "plan" in result:
            raw = {int(k): v for k, v in result["plan"].items()}
        else:
            pool = [list(ts) for ts in result["type_trucks"]]
            raw = {}
            for r in result["routes"]:
                raw[pool[int(r["vt"])].pop(0)] = r["trips"]
        seen: set[int] = set()
        for idx, loads in raw.items():
            td = by_idx.get(idx)
            loads = [tuple(int(k) for k in load) for load in loads if load]
            if td is None or len(loads) > td.trips_left:
                return None, "INVALID_PLAN"
            for load in loads:
                if any(k < 0 or k >= len(solvable) or k in seen for k in load) or len(set(load)) != len(load):
                    return None, "INVALID_PLAN"
                seen.update(load)
                if td.by_pallets:
                    if sum(solvable[k].demand_pallet_units or 0 for k in load) > td.max_pallet_units:
                        return None, "INVALID_PLAN"
                elif sum(solvable[k].demand_cases for k in load) > td.max_cases:
                    return None, "INVALID_PLAN"
                if td.max_kg_units > 0 and sum(kg_units(solvable[k].demand_kg) for k in load) > td.max_kg_units:
                    return None, "INVALID_PLAN"
            if loads:
                plan[idx] = loads
    except (KeyError, IndexError, TypeError, ValueError):
        return None, "INVALID_PLAN"
    return (plan, None) if plan else (None, "NO_FEASIBLE_PLAN")


def _asap(day: LR.Day, plan: LR.Plan, gaps: dict[int, int]) -> LR.TimedPlan:
    """A timetable when the exact timing finds none (with loading time per case, which the model
    approximates like the engine's search, or a driver break it cannot place): every load as early
    as the truck allows, with the search's turnaround and no break. Only a hint: the stage's repacks
    (break-aware when needed) and fit repack repair it, as they repair the engine's raw plans, and
    every candidate is timed again exactly (load_repack.time_plan, the break included)."""
    out: LR.TimedPlan = {}
    for idx, loads in plan.items():
        td = day.by_idx[idx]
        ready = td.earliest_depart_s if td.ready_s is None else max(td.earliest_depart_s, td.ready_s + gaps[idx])
        tl_out = []
        for load in loads:
            f = LR.facts(day, load)
            depart = max(ready, f.lo) if not f.waits else max(ready, f.hi)
            starts = LR._forward_starts(day, f, depart)
            last = load[-1]
            ret = starts[-1] + day.stops[last].service_min * 60 + day.T[last + 1][0]
            tl_out.append(LR.TimedLoad(stops=tuple(load), depart_s=depart, starts=tuple(starts), return_s=ret))
            ready = ret + gaps[idx]
        out[idx] = tl_out
    return out


def stage_in_worker(job: dict) -> tuple[list[LR.Candidate], list[str]]:
    """The PyVRP source's own stage job (critique correction 4): never part of the engine's stage
    jobs, so a PyVRP repack that overruns, raises or dies only loses PyVRP's candidates. Times the
    plan exactly (else _asap), then load_repack.build_candidates once per goal, sharing ``budget_s``.
    Test hooks: ROUTEIQ_TEST_FAIL_PYVRP_STAGE, ROUTEIQ_TEST_HANG_PYVRP_STAGE, ROUTEIQ_TEST_KILL_PYVRP_STAGE."""
    if os.environ.get("ROUTEIQ_TEST_FAIL_PYVRP_STAGE"):
        raise RuntimeError("test hook: the second search's stage failed")
    if os.environ.get("ROUTEIQ_TEST_HANG_PYVRP_STAGE"):
        time.sleep(3600)
    if os.environ.get("ROUTEIQ_TEST_KILL_PYVRP_STAGE"):
        os._exit(137)
    t0 = time.perf_counter()
    day, plan, pricing = job["day"], job["plan"], job["score_pricing"]
    timed = LR.time_plan(day, plan, pricing)
    notes = [] if timed is not None else ["PYVRP: no exact timetable; its loads are repaired like a search's"]
    if timed is None:
        timed = _asap(day, plan, job["gaps"])
    src = [LR.Source("PYVRP", timed)]
    cands: list[LR.Candidate] = []
    goals = job["goals"]
    for i, (goal, goal_pricing) in enumerate(goals):
        left = job["budget_s"] - (time.perf_counter() - t0)
        if left < 0.5:
            notes.append(f"PYVRP: no time left for the {goal} repack")
            continue
        c, n = LR.build_candidates(day, pricing, goal, goal_pricing, src, job["optional"], job["cap_s"],
                                   left / (len(goals) - i), time_raw=i == 0, fit_weights=job["fit_weights"])
        cands += c
        notes += n
    return cands, notes
