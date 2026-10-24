"""Join small trips: after the load re-check, a company truck's small load rides on its other loads.

Pilot study (24 Oct 2026): the route search and the load re-check keep every load as the search built it, so a
company truck sometimes makes a second (or third) load of one to three customers that one of its other loads could
have carried - a whole depot turnaround, a trip cost and often an hour of driver time for nothing. Nothing in the
re-check can join two loads (its repack moves whole loads between trucks, its recovery only inserts stops it left
out). This step does, after each option's plan is chosen (dispatch_solver._post_solve drives it; nothing here
searches):

1. ``join_plan``: for every company truck (not rented, not day-paid, not a truck to rent) with two or more new
   loads, in truck order, the proposals that make it one load fewer - a small load (at most MAX_STOPS customer
   visits, the parts of one customer's split order counted once and kept together, any size: fits_truck decides
   the room) placed as a run in every gap of another load (JOIN), its visits spread over the other loads at their
   cheapest detour (SPREAD, three loads or more), and the truck's shortest round of all its stops cut into fewer
   loads (a re-cut, reported as JOIN) - ranked by load_repack's quick estimate of the day; the best TRIES are timed
   exactly (load_repack.time_truck: every hard rule, the driver break at its cheapest place, turnaround, latest
   return, shift and loads per day), and the best one gets up to three other stop orders per load. A proposal is
   taken when it is cheaper by at least MIN_GAIN_OMR (money plus the customer time preferences), costs no more
   money, drives no more km on MIN_DISTANCE, and keeps the margins (``slack_ok``); then the truck is tried again.
2. Moves onto another truck (MOVE): a one-visit load of a company truck inside a load of another company truck that
   already has new loads (no truck and no load opened), timed exactly on both, the gain summed over both (the
   giving truck's day cost too when it leaves the plan). Reported only (ACROSS = False) until the owner's OK.
3. ``record`` / ``finish`` / ``report_or_none``: SearchReport.join_trips; ``note``: the dispatcher's note.

dispatch_solver then re-checks the whole joined plan (the same stops, better on the option's goal, the gain, no
more money), builds it with the exact arguments of the plan it replaces and uses it only when the independent check
(feasibility.check_scenario) says VERIFIED. Locked, loading and dispatched loads are never in a plan, so they are
never touched; they bind a truck only through its TruckDay (ready_s, frozen_return_s, trips_left).

Setting (read on every solve): SOLVER_JOIN_TRIPS = off (the default; also 0/false/no and any value not read) |
report (computed, built and checked; plans unchanged; search.join_trips filled) | on (also 1/true/yes: applied).

Public repository: trucks are named by their code only, stops by their request ids in the report; no names.
This module must not import dispatch_solver (which imports it), pyvrp or numpy. Its LP and timing counts are its
own (load_repack.thread_lps), never the process-wide LP_STATS another solve shares.
"""
from __future__ import annotations

import itertools
import logging
import os
import time
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from typing import Any

import costing
import load_repack as LR
from dispatch_models import DAY_MIN, JoinTripsReport

log = logging.getLogger("routeiq.dispatch")

ENV_MODE = "SOLVER_JOIN_TRIPS"
MODES = ("off", "report", "on")
_OFF_WORDS = ("", "off", "0", "false", "no")
_ON_WORDS = ("on", "1", "true", "yes")

# Changed only after a replay of saved real requests (a test may monkeypatch them).
MIN_GAIN_OMR = 0.5  # money plus the customer time preferences must drop by at least this much per change
MIN_GAIN_UNITS = int(round(MIN_GAIN_OMR * costing.COST_SCALE))
SLACK_MIN = 20  # margins to the latest return and to the break window's end: at least this, or no tighter than before
MAX_STOPS = 3  # a small load: at most this many customer visits
TRIES = 12  # proposals timed exactly per round, best estimate first
MOVE_TRIES = 6  # moves onto another truck timed exactly per one-visit load
OPTION_SEC = 2.0  # per option
TOTAL_SEC = 6.0  # per solve (dispatch_solver: never later than the request's budget end - 2 s)
ACROSS = False  # moves onto another truck: reported only (owner decision pending)
SUFFIX = "+join"  # the joined candidate's source
MAX_NOTE_TRUCKS = 4
NOTE_HEAD = "Small loads joined after the load re-check: "

# The furthest step reached when nothing was taken (JoinTripsOption.outcome).
RANK = ("NO_SMALL_LOAD", "NONE_FITS", "NOT_BETTER", "SLACK", "OUT_OF_TIME")
# Why a solve does not join at all (JoinTripsReport.reason, status SKIPPED).
SKIP_REASONS = ("HIRE_CHECK", "NOTHING_TO_PLAN", "NO_STAGE")


# ---------------------------------------------------------------------------------------------
# Setting (read on every call; off by default)
# ---------------------------------------------------------------------------------------------

def _raw() -> str:
    return os.environ.get(ENV_MODE, "").strip()


def mode() -> str:
    """SOLVER_JOIN_TRIPS: off (the default and anything not read), report or on."""
    raw = _raw().lower()
    if raw == "report":
        return raw
    return "on" if raw in _ON_WORDS else "off"


def unread() -> list[tuple[str, str, str]]:
    """The setting when it is set but not read (it then counts as off): (name, value, what it takes)."""
    raw = _raw()
    if raw and raw.lower() not in (*_OFF_WORDS, *_ON_WORDS, "report"):
        return [(ENV_MODE, raw[:20], "off, report or on")]
    return []


def status() -> dict:
    """/ready's ``join_trips`` (never affects ``ok``)."""
    return {"mode": mode(), "min_gain_omr": MIN_GAIN_OMR, "slack_min": SLACK_MIN, "max_stops": MAX_STOPS,
            "across_trucks": ACROSS, "unread": [name for name, _, _ in unread()]}


def startup_line() -> str:
    m = mode()
    tail = "".join(f"; {name}={raw!r} not read ({what}): off is used" for name, raw, what in unread())
    if m == "off":
        return f"Join small trips: off (the default; {ENV_MODE} unset or off{tail})"
    if m == "report":
        return (f"Join small trips: report (computed and reported in search.join_trips; plans unchanged; min gain "
                f"{MIN_GAIN_OMR:g} OMR, margin {SLACK_MIN} min, small = at most {MAX_STOPS} stops)")
    return (f"Join small trips: on (a small load of 1-{MAX_STOPS} stops rides on another load of the same company "
            f"truck when that saves at least {MIN_GAIN_OMR:g} OMR with every rule kept; margin {SLACK_MIN} min; moves "
            f"onto other trucks: {'applied' if ACROSS else 'reported only'})")


# ---------------------------------------------------------------------------------------------
# The rules of one change
# ---------------------------------------------------------------------------------------------

def margins(day: LR.Day, td: Any, timed: Sequence[LR.TimedLoad]) -> tuple[int | None, int | None]:
    """(end, break) margins of a truck's new-load day, in seconds. end: its latest return (19:00, the depot's
    closing, the truck's own hours, a frozen anchor + shift, or the break window's end when no break can be planned
    any more: TruckDay.latest_return_s) minus its last return - without frozen loads also capped by the shift
    maximum minus the day's span. break (a day that may need a driver break only): the break window's end minus the
    break's start, or minus the last return when the day holds no break because it is back by then; None when the
    day has no break question. (None, None) for no loads."""
    if not timed:
        return None, None
    last = timed[-1].return_s
    end = td.latest_return_s - last
    if td.shift_anchor_s is None:
        end = min(end, day.shift_max_s - (last - timed[0].depart_s))
    brk = None
    if LR.break_due(td):
        held = [tl.brk for tl in timed if tl.brk is not None]
        if held:
            brk = td.break_hi_s - held[0].start_s
        elif last <= td.break_to_s:
            brk = td.break_to_s - last
    return end, brk


def _need(before: int | None) -> int:
    """The margin a change must keep: SLACK_MIN, or the plan's own when it was already tighter."""
    slack = SLACK_MIN * 60
    return slack if before is None else min(slack, before)


def slack_ok(day: LR.Day, td: Any, before: Sequence[LR.TimedLoad], after: Sequence[LR.TimedLoad]) -> bool:
    """The changed day keeps at least SLACK_MIN to its latest return and to the break window's end, or is no
    tighter there than the day it replaces (owner decision 24 Oct 2026)."""
    eb, bb = margins(day, td, before)
    en, bn = margins(day, td, after)
    if en is not None and en < _need(eb):
        return False
    return bn is None or bn >= _need(bb)


def gain_ok(goal: str, before: tuple, after: tuple) -> bool:
    """``before`` / ``after``: (money, metres, value) in objective units (load_repack._order_value). The value
    drops by at least MIN_GAIN_UNITS, the money does not rise, and on MIN_DISTANCE the metres do not either."""
    if after[0] > before[0] or before[2] - after[2] < MIN_GAIN_UNITS:
        return False
    return goal != "MIN_DISTANCE" or after[1] <= before[1]


def _value(day: LR.Day, pricing: LR.Pricing, idx: int, timed: Sequence[LR.TimedLoad]) -> tuple:
    """(money, metres, money + time preferences + tie-breaker) of one truck's day; zeros without loads."""
    return LR._order_value(day, pricing, idx, list(timed), 0.0) if timed else (0, 0, 0.0)


def _window_slack(day: LR.Day, timed: Sequence[LR.TimedLoad]) -> int | None:
    """The tightest stop: its latest service start minus its planned one (stops with a closing time only)."""
    out = None
    for tl in timed:
        for k, start in zip(tl.stops, tl.starts):
            if day.stops[k].hard_end_min is not None:
                v = LR._he(day, day.stops[k]) - start
                out = v if out is None else min(out, v)
    return out


def _road_wait(day: LR.Day, td: Any, timed: Sequence[LR.TimedLoad]) -> int:
    """Seconds waited on the road before unloadings (service start minus arrival), the planned break taken out."""
    w = 0
    for tl in timed:
        t, prev = tl.depart_s, 0
        for q, (k, start) in enumerate(zip(tl.stops, tl.starts)):
            if tl.brk is not None and tl.brk.where == "ROAD" and tl.brk.after == q:
                t = max(t, tl.brk.start_s) + td.break_s
            t += day.T[prev][k + 1]
            w += max(0, start - t)
            t = start + day.stops[k].service_min * 60
            prev = k + 1
    return w


# ---------------------------------------------------------------------------------------------
# One option's plan
# ---------------------------------------------------------------------------------------------

@dataclass(frozen=True)
class Move:
    """One change: JOIN (a load fewer on ``truck_id``, also a re-cut or another stop order), SPREAD (a small load's
    visits over the truck's other loads) or MOVE (a one-visit load onto ``to_truck_id``). Gains in objective units
    (positive: cheaper; metres positive: fewer); times in seconds; margins after the change (``margins``)."""

    kind: str
    truck_id: str
    truck_code: str
    to_truck_id: str | None
    to_truck_code: str | None
    stop_ids: tuple[str, ...]  # the small load's stops (a re-cut: the truck's smallest load before)
    cases: int
    loads_before: int
    loads_after: int
    gain: float
    gain_op: int
    gain_m: int
    back_before_s: int
    back_after_s: int
    break_start_s: int | None
    end_s: int | None
    break_slack_s: int | None
    window_s: int | None
    wait_before_s: int
    wait_after_s: int
    stops_after: tuple[tuple[str, ...], ...]  # the truck's new loads after the change, stops in order (MOVE: the other's)
    in_plan: bool = True  # same-truck changes always; a MOVE only with ACROSS

    def report(self, applied: bool) -> dict:
        """JoinTripsMove (minutes, OMR, km)."""
        m = (lambda s: None if s is None else int(round(s / 60)))
        return {"kind": self.kind, "truck_id": self.truck_id, "to_truck_id": self.to_truck_id,
                "stop_ids": list(self.stop_ids), "cases": self.cases, "loads_before": self.loads_before,
                "loads_after": self.loads_after, "gain_omr": round(self.gain / costing.COST_SCALE, 2),
                "gain_operating_omr": round(self.gain_op / costing.COST_SCALE, 2), "gain_km": round(self.gain_m / 1000, 1),
                "back_before_min": m(self.back_before_s), "back_after_min": m(self.back_after_s),
                "break_start_min": m(self.break_start_s), "end_slack_min": m(self.end_s),
                "break_slack_min": m(self.break_slack_s), "window_slack_min": m(self.window_s),
                "road_wait_before_min": m(self.wait_before_s), "road_wait_min": m(self.wait_after_s),
                "stops_after": [list(load) for load in self.stops_after], "applied": bool(applied and self.in_plan)}


@dataclass
class JoinResult:
    """``plan``: the option's plan with the changes taken (the same object when there is none); ``moves``: the
    same-truck changes taken; ``across``: the moves onto another truck that keep every rule (in ``plan`` only with
    ACROSS); ``outcome``: the furthest step reached when nothing was taken (RANK), or JOINED; ``tried``: proposals
    timed exactly; ``timings``: exact timings asked for; ``lps``: timing LPs this call solved."""

    plan: LR.TimedPlan
    moves: list[Move]
    across: list[Move]
    outcome: str
    tried: int = 0
    timings: int = 0
    lps: int = 0
    seconds: float = 0.0

    @property
    def changed(self) -> bool:
        return bool(self.moves) or any(m.in_plan for m in self.across)


class _Count:
    def __init__(self) -> None:
        self.timings = 0
        self.tried = 0


def _furthest(a: str, b: str) -> str:
    return a if RANK.index(a) >= RANK.index(b) else b


def _time(day: LR.Day, pricing: LR.Pricing, td: Any, loads: Sequence[LR.Load], cache: dict,
          n: _Count) -> list[LR.TimedLoad] | None:
    """The exact timetable of ``loads`` on ``td`` (load_repack.time_truck: every hard rule, the driver break), each
    load first checked against the truck's room (fits_truck); None when no timetable keeps every rule."""
    if not loads or len(loads) > td.trips_left:
        return None
    for load in loads:
        f = cache.get(load)
        if f is None:
            f = cache[load] = LR.facts(day, load)
        if not LR.fits_truck(f, td):
            return None
    n.timings += 1
    return LR.time_truck(day, td, [tuple(load) for load in loads], pricing)


def _cases(day: LR.Day, stops: Sequence[int]) -> int:
    return sum(day.stops[k].demand_cases for k in stops)


def _smallest(day: LR.Day, loads: Sequence[LR.Load]) -> int:
    return min(range(len(loads)), key=lambda j: (len(LR._blocks(day, loads[j])), _cases(day, loads[j]), j))


def proposals(day: LR.Day, td: Any, loads: Sequence[LR.Load], deadline: float,
              cache: dict) -> list[tuple[str, int | None, tuple[LR.Load, ...]]]:
    """Every day of the truck's stops with at least one load fewer worth estimating: (kind, the small load's
    index or None for a re-cut, the loads in day order). The parts of one customer stay one run (_blocks). The
    smallest loads come first, so a day two proposals share names the smaller load as the one that was joined."""
    n = len(loads)
    blocks = [LR._blocks(day, load) for load in loads]
    out: list[tuple[str, int | None, tuple[LR.Load, ...]]] = []
    for b in sorted(range(n), key=lambda j: (len(blocks[j]), _cases(day, loads[j]), j)):
        bb = blocks[b]
        if len(bb) > MAX_STOPS:
            continue
        for a in range(n):
            if a == b:
                continue
            ab = blocks[a]
            rest = [load for j, load in enumerate(loads) if j not in (a, b)]
            for perm in sorted(set(itertools.permutations(bb))):
                for g in range(len(ab) + 1):
                    merged = LR._flat(ab[:g] + list(perm) + ab[g:])
                    for pos in range(len(rest) + 1):
                        out.append(("JOIN", b, tuple(rest[:pos] + [merged] + rest[pos:])))
        if n >= 3:
            # SPREAD: each visit of b, biggest first, at its cheapest detour (metres) among the truck's other loads.
            others = [list(blocks[j]) for j in range(n) if j != b]
            for blk in sorted(bb, key=lambda x: (-_cases(day, x), x)):
                inner = sum(day.D[x + 1][y + 1] for x, y in zip(blk, blk[1:]))
                best: tuple[int, int, int] | None = None
                for oi, ol in enumerate(others):
                    for g in range(len(ol) + 1):
                        p = ol[g - 1][-1] + 1 if g else 0
                        q = ol[g][0] + 1 if g < len(ol) else 0
                        det = day.D[p][blk[0] + 1] + inner + day.D[blk[-1] + 1][q] - day.D[p][q]
                        if best is None or det < best[0]:
                            best = (det, oi, g)
                assert best is not None
                _, oi, g = best
                others[oi] = others[oi][:g] + [blk] + others[oi][g:]
            out.append(("SPREAD", b, tuple(LR._flat(ol) for ol in others)))
    if any(len(bb) <= MAX_STOPS for bb in blocks):
        # The re-cut: the truck's shortest round of all its stops, cut into at most n - 1 loads that fit.
        allb = [x for bb in blocks for x in bb]
        tour, _ = LR._improve(LR._nearest(day, allb), lambda bl: float(day.metres(LR._flat(bl))), deadline)
        cut = LR._split(day, td, tour, n - 1, cache)
        if cut is not None:
            for p in (itertools.permutations(cut) if len(cut) <= 3 else (cut, cut[::-1])):
                out.append(("JOIN", None, tuple(LR._flat(x) for x in p)))
    return out


def _move(kind: str, day: LR.Day, td: Any, small: Sequence[int], before: list[LR.TimedLoad], after: list[LR.TimedLoad],
          v0: tuple, v1: tuple, to: Any | None = None, to_before: list[LR.TimedLoad] | None = None,
          to_after: list[LR.TimedLoad] | None = None, in_plan: bool = True) -> Move:
    side, side_b, side_a = (to, to_before or [], to_after or []) if to is not None else (td, before, after)
    end, brk_slack = margins(day, side, side_a)
    held = [tl.brk for tl in side_a if tl.brk is not None]
    return Move(kind=kind, truck_id=td.truck.id, truck_code=td.truck.code or td.truck.id,
                to_truck_id=to.truck.id if to is not None else None,
                to_truck_code=(to.truck.code or to.truck.id) if to is not None else None,
                stop_ids=tuple(day.stops[k].stop_id for k in small), cases=_cases(day, small),
                loads_before=len(before), loads_after=len(after), gain=v0[2] - v1[2], gain_op=v0[0] - v1[0],
                gain_m=v0[1] - v1[1], back_before_s=side_b[-1].return_s if side_b else 0,
                back_after_s=side_a[-1].return_s if side_a else 0, break_start_s=held[0].start_s if held else None,
                end_s=end, break_slack_s=brk_slack, window_s=_window_slack(day, side_a),
                wait_before_s=_road_wait(day, side, side_b), wait_after_s=_road_wait(day, side, side_a),
                stops_after=tuple(tuple(day.stops[k].stop_id for k in tl.stops) for tl in side_a), in_plan=in_plan)


def _join_truck(day: LR.Day, pricing: LR.Pricing, td: Any, cur: list[LR.TimedLoad], goal: str, until: float,
                n: _Count) -> tuple[list[LR.TimedLoad], list[Move], str]:
    """One truck: rounds of "one load fewer" until none passes (3 -> 2 -> 1). (its day, the changes, outcome)."""
    idx = td.idx
    price = pricing.trucks[idx]
    per_m, per_s = price.per_m + price.tie_m, price.per_s(pricing.span)
    moves: list[Move] = []
    outcome = "NO_SMALL_LOAD"
    while len(cur) >= 2:
        if time.monotonic() > until:
            outcome = _furthest(outcome, "OUT_OF_TIME")
            break
        loads = [tl.stops for tl in cur]
        if not any(len(LR._blocks(day, load)) <= MAX_STOPS for load in loads):
            break
        cache: dict = {}
        base = _value(day, pricing, idx, cur)
        ranked: list[tuple[float, tuple[LR.Load, ...], str, int | None]] = []
        seen: set[tuple[LR.Load, ...]] = set()
        for kind, b, p in proposals(day, td, loads, until, cache):
            if p in seen:
                continue
            seen.add(p)
            e = LR._day_estimate(day, pricing, td, list(p), per_m, per_s, cache)
            if e < float("inf"):
                ranked.append((e, p, kind, b))
        ranked.sort(key=lambda r: (r[0], r[1]))
        outcome = _furthest(outcome, "NONE_FITS")
        good: list[tuple[tuple, list[LR.TimedLoad], str, int | None]] = []
        for _e, p, kind, b in ranked[:TRIES]:
            if time.monotonic() > until:
                outcome = _furthest(outcome, "OUT_OF_TIME")
                break
            n.tried += 1
            t = _time(day, pricing, td, p, cache, n)
            if t is not None:
                good.append((_value(day, pricing, idx, t), t, kind, b))
        if good:
            # The best one's loads in other orders (load_repack._orders, as shorter_orders does).
            v0, t0, kind0, b0 = min(good, key=lambda g: (g[0][2], g[0][1], tuple(tl.stops for tl in g[1])))
            for j, tl in enumerate(t0):
                for order in LR._orders(day, pricing, td, tl, per_m, per_s, until):
                    trial = [x.stops for x in t0]
                    trial[j] = order
                    n.tried += 1
                    t = _time(day, pricing, td, trial, cache, n)
                    if t is not None:
                        good.append((_value(day, pricing, idx, t), t, kind0, b0))
            outcome = _furthest(outcome, "NOT_BETTER")
        taken = None
        for v, t, kind, b in sorted(good, key=lambda g: (g[0][2], g[0][1], tuple(tl.stops for tl in g[1]))):
            if not gain_ok(goal, base, v):
                continue
            if not slack_ok(day, td, cur, t):
                outcome = _furthest(outcome, "SLACK")
                continue
            taken = (v, t, kind, b)
            break
        if taken is None:
            break
        v, t, kind, b = taken
        small = loads[b] if b is not None else loads[_smallest(day, loads)]
        moves.append(_move(kind, day, td, small, cur, t, base, v))
        cur = t
    return cur, moves, ("JOINED" if moves else outcome)


def _across(day: LR.Day, pricing: LR.Pricing, plan: LR.TimedPlan, trucks: frozenset[int], goal: str, deadline: float,
            n: _Count) -> tuple[LR.TimedPlan, list[Move]]:
    """Moves of a one-visit load of a company truck A into a load of another company truck B that already has new
    loads, kept only when they pass every rule on both trucks together (``gain_ok`` on the sums, ``slack_ok`` on
    each). Applied to the plan only with ACROSS; then the scan starts again on the changed plan."""
    out = {i: list(v) for i, v in plan.items()}
    found: list[Move] = []
    tried: set[tuple[int, LR.Load]] = set()
    again = True
    while again:
        again = False
        for ia in sorted(i for i in out if i in trucks and out[i]):
            tda = day.by_idx[ia]
            for b, tlb in enumerate(out[ia]):
                if time.monotonic() > deadline:
                    return out, found
                if len(LR._blocks(day, tlb.stops)) != 1 or (ia, tlb.stops) in tried:
                    continue
                tried.add((ia, tlb.stops))
                a_rest = [tl.stops for j, tl in enumerate(out[ia]) if j != b]
                cache: dict = {}
                price_a = pricing.trucks[ia]
                ea0 = LR._day_estimate(day, pricing, tda, [tl.stops for tl in out[ia]], price_a.per_m + price_a.tie_m,
                                       price_a.per_s(pricing.span), cache)
                ea1 = LR._day_estimate(day, pricing, tda, a_rest, price_a.per_m + price_a.tie_m,
                                       price_a.per_s(pricing.span), cache) if a_rest else 0.0
                if ea1 == float("inf"):
                    continue
                props: list[tuple[float, int, tuple[LR.Load, ...]]] = []
                for ib in sorted(i for i in out if i in trucks and i != ia and out[i]):
                    tdb = day.by_idx[ib]
                    price_b = pricing.trucks[ib]
                    bl = [tl.stops for tl in out[ib]]
                    pm, ps = price_b.per_m + price_b.tie_m, price_b.per_s(pricing.span)
                    eb0 = LR._day_estimate(day, pricing, tdb, bl, pm, ps, cache)
                    for j, load in enumerate(bl):
                        for g in range(len(load) + 1):
                            new = tuple(bl[:j] + [load[:g] + tlb.stops + load[g:]] + bl[j + 1:])
                            e = LR._day_estimate(day, pricing, tdb, list(new), pm, ps, cache)
                            if e < float("inf"):
                                props.append((e - eb0 + ea1 - ea0, ib, new))
                props.sort(key=lambda r: (r[0], r[1], r[2]))
                best = None
                for _d, ib, new in props[:MOVE_TRIES]:
                    if time.monotonic() > deadline:
                        break
                    tdb = day.by_idx[ib]
                    n.tried += 1
                    t_b = _time(day, pricing, tdb, new, cache, n)
                    t_a = _time(day, pricing, tda, a_rest, cache, n) if a_rest else []
                    if t_b is None or t_a is None:
                        continue
                    va0, vb0 = _value(day, pricing, ia, out[ia]), _value(day, pricing, ib, out[ib])
                    va1, vb1 = _value(day, pricing, ia, t_a), _value(day, pricing, ib, t_b)
                    v0 = tuple(x + y for x, y in zip(va0, vb0))
                    v1 = tuple(x + y for x, y in zip(va1, vb1))
                    if not (gain_ok(goal, v0, v1) and slack_ok(day, tdb, out[ib], t_b)
                            and (not t_a or slack_ok(day, tda, out[ia], t_a))):
                        continue
                    if best is None or (v0[2] - v1[2]) > best[0]:
                        best = (v0[2] - v1[2], ib, t_a, t_b, v0, v1)
                if best is None:
                    continue
                _g, ib, t_a, t_b, v0, v1 = best
                found.append(_move("MOVE", day, tda, tlb.stops, out[ia], t_a, v0, v1, to=day.by_idx[ib],
                                   to_before=out[ib], to_after=t_b, in_plan=ACROSS))
                if ACROSS:
                    out[ib] = t_b
                    if t_a:
                        out[ia] = t_a
                    else:
                        del out[ia]
                    again = True
                    break
            if again:
                break
    return out, found


def join_plan(day: LR.Day, pricing: LR.Pricing, plan: LR.TimedPlan, trucks: frozenset[int] | set[int], goal: str,
              deadline: float) -> JoinResult:
    """``plan`` (one option's chosen candidate, timed exactly) with the small loads of each of ``trucks`` (the
    company trucks) joined onto their other loads (see the module's docstring), for the option's ``goal``, until
    ``deadline`` (time.monotonic; each truck gets its share of the time left), then the moves onto other trucks.
    TruckDays and the plan are never modified; every timing goes through day.timing_cache."""
    t0 = time.monotonic()
    lp0 = LR.thread_lps()
    n = _Count()
    company = frozenset(i for i in trucks if i in day.by_idx)
    out: LR.TimedPlan = {i: list(v) for i, v in plan.items() if v}
    moves: list[Move] = []
    outcome = "NO_SMALL_LOAD"
    idxs = sorted(i for i in company if len(out.get(i) or []) >= 2)
    for n_left, idx in zip(range(len(idxs), 0, -1), idxs):
        now = time.monotonic()
        if now > deadline:
            outcome = _furthest(outcome, "OUT_OF_TIME")
            break
        until = now + (deadline - now) / n_left
        cur, got, why = _join_truck(day, pricing, day.by_idx[idx], out[idx], goal, until, n)
        out[idx] = cur
        moves += got
        if why != "JOINED":
            outcome = _furthest(outcome, why)
    across: list[Move] = []
    if time.monotonic() <= deadline:
        out, across = _across(day, pricing, out, company, goal, deadline, n)
    res = JoinResult(plan=out, moves=moves, across=across, outcome="JOINED" if moves else outcome, tried=n.tried,
                     timings=n.timings, lps=LR.thread_lps() - lp0, seconds=time.monotonic() - t0)
    if not res.changed:
        res.plan = plan
    return res


# ---------------------------------------------------------------------------------------------
# One solve's state and its report (dispatch_solver passes it along; it never leaves the API process)
# ---------------------------------------------------------------------------------------------

@dataclass
class Run:
    mode: str
    report: dict

    @property
    def active(self) -> bool:
        return self.report.get("status") != "SKIPPED"


def new_report(m: str) -> dict:
    return {"mode": m, "status": "NONE", "reason": None, "min_gain_omr": MIN_GAIN_OMR, "slack_min": SLACK_MIN,
            "max_stops": MAX_STOPS, "across_trucks": ACROSS, "seconds": 0.0, "timings": 0, "lps": 0, "options": []}


def start() -> Run | None:
    """The solve's join state, or None with SOLVER_JOIN_TRIPS off (then nothing anywhere changes)."""
    m = mode()
    return None if m == "off" else Run(mode=m, report=new_report(m))


def skip(run: Run, reason: str) -> None:
    run.report.update(status="SKIPPED", reason=reason)


def _loads(plan: Mapping[int, Sequence[Any]]) -> int:
    return sum(len(v) for v in plan.values())


def record(run: Run, option: str, res: JoinResult | None, *, base: LR.TimedPlan | None = None, outcome: str | None = None,
           verified: bool | None = None, before: LR.Score | None = None, after: LR.Score | None = None,
           seconds: float = 0.0) -> dict:
    """The report entry of one option (JoinTripsOption): ``outcome`` (default: the result's own; JOINED in mode
    on and WOULD_JOIN in mode report once ``verified``), the plan's loads and gains (``before`` / ``after``
    scores of the whole plan, when it was changed), the changes (applied only when they are in the plan, the mode
    is on and the joined plan passed the independent check)."""
    if outcome is None:
        if res is not None and res.changed:
            outcome = "NOT_VERIFIED" if not verified else ("JOINED" if run.mode == "on" else "WOULD_JOIN")
        else:
            outcome = res.outcome if res is not None else "ERROR"
    applied = outcome == "JOINED"
    lb = _loads(base) if base is not None else 0
    la = _loads(res.plan) if res is not None and res.changed and after is not None else lb
    gain = (lambda f: round((getattr(before, f) - getattr(after, f)) / costing.COST_SCALE, 2)) \
        if before is not None and after is not None else (lambda f: 0.0)
    entry = {"option": option, "outcome": outcome, "loads_before": lb, "loads_after": la,
             "gain_omr": gain("cost"), "gain_operating_omr": gain("operating"),
             "gain_km": round((before.metres - after.metres) / 1000, 1) if before is not None and after is not None else 0.0,
             "tried": res.tried if res is not None else 0, "verified": verified,
             "moves": [m.report(applied) for m in ((res.moves + res.across) if res is not None else [])]}
    rep = run.report
    rep["options"] = [*[o for o in rep["options"] if o["option"] != option], entry]
    rep["seconds"] = float(rep.get("seconds") or 0.0) + (res.seconds if res is not None else 0.0) + seconds
    rep["timings"] = int(rep.get("timings") or 0) + (res.timings if res is not None else 0)
    rep["lps"] = int(rep.get("lps") or 0) + (res.lps if res is not None else 0)
    return entry


def finish(run: Run) -> None:
    """The report's final status once the solve is done, the first that applies: FAILED (an option's step failed or
    its joined plan did not pass the independent check - whatever the other options did, so the rollback check reads
    one field; each option's outcome is in ``options``), JOINED (an option uses a joined plan), WOULD_JOIN (report
    mode found one that passes every check), NONE; SKIPPED NO_STAGE when no option reached the step (the load
    re-check did not run)."""
    rep = run.report
    rep["seconds"] = round(float(rep.get("seconds") or 0.0), 3)
    if rep.get("status") == "SKIPPED":
        return
    outcomes = {o["outcome"] for o in rep.get("options") or []}
    if not outcomes:
        rep.update(status="SKIPPED", reason="NO_STAGE")
    elif outcomes & {"ERROR", "NOT_VERIFIED"}:
        rep.update(status="FAILED", reason=None)
    elif "JOINED" in outcomes:
        rep.update(status="JOINED", reason=None)
    elif "WOULD_JOIN" in outcomes:
        rep.update(status="WOULD_JOIN", reason=None)
    else:
        rep.update(status="NONE", reason=None)


def _changes(o: Mapping[str, Any]) -> str:
    """"changes JOIN 1, MOVE 1 (0 applied)": the changes found on one option by kind (a MOVE is found even when
    nothing on the truck itself could be joined)."""
    kinds: dict[str, int] = {}
    for m in o.get("moves") or []:
        kinds[m["kind"]] = kinds.get(m["kind"], 0) + 1
    applied = sum(1 for m in o.get("moves") or [] if m.get("applied"))
    return "changes " + (", ".join(f"{k} {v}" for k, v in sorted(kinds.items())) or "none") + f" ({applied} applied)"


def summary(run: Run) -> str:
    """One log line (truck ids and counts only)."""
    rep = run.report
    opts = "; ".join(f"{o['option']}: {o['outcome']} {o['loads_before']}->{o['loads_after']} loads, {o['gain_omr']:+.2f} OMR, "
                     f"{_changes(o)}" for o in rep.get("options") or [])
    return (f"mode={rep.get('mode')} status={rep.get('status')} reason={rep.get('reason')} seconds={rep.get('seconds')} "
            f"timings={rep.get('timings')} lps={rep.get('lps')}" + (f" | {opts}" if opts else ""))


def report_or_none(data: JoinTripsReport | Mapping[str, Any] | None) -> JoinTripsReport | None:
    """SearchReport.join_trips from the solve's join state: a report that does not validate is dropped with a
    warning (the plan is unaffected) instead of failing a finished solve."""
    if data is None:
        return None
    try:
        return data if isinstance(data, JoinTripsReport) else JoinTripsReport.model_validate(dict(data))
    except Exception as exc:  # noqa: BLE001 - a report must never cost the plan
        log.warning("join-trips report left out (the plan is unaffected): %s", exc)
        return None


# ---------------------------------------------------------------------------------------------
# The dispatcher's note (mode on, applied only)
# ---------------------------------------------------------------------------------------------

def _hhmm(s: int) -> str:
    m = int(round(s / 60))
    return f"{(m // 60) % 24:02d}:{m % 60:02d}" + ("+1" if m >= DAY_MIN else "")


def _back(after_s: int, before_s: int) -> str:
    """"back 13:40 instead of 15:10", or "back at 16:45 as before" when both print the same minute."""
    a, b = _hhmm(after_s), _hhmm(before_s)
    return f"back at {a} as before" if a == b else f"back {a} instead of {b}"


def _omr_pair(a: float, b: float) -> str:
    """"410 -> 402", with one decimal when whole OMR would print the same number twice."""
    fmt = ",.0f" if format(a, ",.0f") != format(b, ",.0f") else ",.1f"
    return f"{format(a, fmt)} -> {format(b, fmt)}"


def note(moves: Sequence[Move], loads_before: int, loads_after: int, ops_before: float, ops_after: float,
         break_rule: bool) -> str:
    """"Small loads joined after the load re-check: T05 2 -> 1 loads (back 13:40 instead of 15:10); ... In all 12 ->
    10 loads, 410 -> 402 OMR operating cost. Each joined day was timed again ..." - truck codes only, at most
    MAX_NOTE_TRUCKS trucks named."""
    per: dict[str, list] = {}
    parts: list[str] = []
    for m in moves:
        if m.kind == "MOVE":
            parts.append(f"{m.truck_code}'s one-stop load onto {m.to_truck_code} ({m.to_truck_code} "
                         f"{_back(m.back_after_s, m.back_before_s)})")
            continue
        if m.truck_code not in per:
            per[m.truck_code] = [m.loads_before, m.loads_after, m.back_before_s, m.back_after_s]
            parts.append(m.truck_code)
        else:
            per[m.truck_code][1], per[m.truck_code][3] = m.loads_after, m.back_after_s
    words = []
    for p in parts:
        if p in per:
            lb, la, bb, ba = per[p]
            words.append(f"{p} {lb} -> {la} loads ({_back(ba, bb)})")
        else:
            words.append(p)
    shown = words[:MAX_NOTE_TRUCKS]
    more = len(words) - len(shown)
    return (NOTE_HEAD + "; ".join(shown) + (f"; and {more} more truck(s)" if more else "")
            + f". In all {loads_before} -> {loads_after} loads, {_omr_pair(ops_before, ops_after)} OMR operating cost. "
            + "Each joined day was timed again with every rule" + (", the driver break included," if break_rule else "")
            + " and checked independently.")
