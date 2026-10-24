"""Far-area grouping: one more route search of RECOMMENDED with each far area on its fewest trucks.

Owner request (21 Oct 2026): "sometimes the model sends 2 or 3 trucks to one far away area - why can't it send
one whole truck?". The route search has no idea of an area: interior customers that close late become the
afternoon fill of small trucks' second loads, and its local search cannot move eight stops at once, so a far
area that one truck could carry is sometimes spread over two or three. A higher km price did not fix it.

What this step does (dispatch_solver drives it; nothing here searches):

1. ``detect``: the far areas, from coordinates only (no road matrix): stops at least MEMBER_KM from the depot,
   linked when their bearings are within LINK_DEG and they are within LINK_KM of each other or the nearer one is
   on the way to the farther one (DETOUR); a group is a far area when its farthest stop is at least
   SOLVER_FAR_AREA_KM out and every other stop of the day is at least GAP_KM away (so a suburb that runs on from
   the city is not one). An area is pinned only with MIN_STOPS..AREA_MAX_STOPS stops, at most MAX_AREAS a solve.
2. ``needs``: the fewest loads each area needs and the trucks that can carry it, by the load re-check's own
   pieces (load_repack: pallets or cases and kg through fits_truck, the windows with the START / FINISH rule, the
   break, the latest return, frozen loads and the small-truck lists through time_truck), within PLAN_SEC.
3. ``pinned``: a copy of the request with each area stop's allowed_truck_ids narrowed to those trucks. The twin
   search (dispatch_solver._variant_worker) searches it beside the main search, as long as it.
4. ``should_send``: the twin's plan goes to the load re-check, as the source SOURCE in its own stage job
   (``stage_in_worker``), only when it puts a pinned area that the main plan has on MORE loads than the route
   check's fewest on fewer loads, and no area on more (an area already on its fewest loads is never regrouped:
   the owner's "a needed second truck is never taken away").
5. ``judge``: each option takes the grouped plan only when it puts an area on fewer loads and none on more; serves
   every area stop the option's plan without it serves (grouping never by leaving out an area order); never puts
   an area below the route check's fewest loads; is not worse on the option's own goal (service by strict priority
   first, then the goal's measures); does not leave out another order of the same priority; keeps the slack
   setting; and (dispatch_solver) passes the independent check. Otherwise the option keeps exactly the plan it has
   with this step off.
6. ``explain_lines``: on RECOMMENDED, at most MAX_LINES lines saying why a far area is still on two or more loads.

Settings (read on every solve; a value that cannot be read, or is out of range, counts as its default and the
startup line names it):
- SOLVER_FAR_AREA: off (the default, the kill switch; also 0/false/no and any value not read) | report (the notes
  and search.far_area only, plans unchanged) | thorough (the twin search on THOROUGH solves, QUICK as report) |
  on (also 1/true/yes: both modes).
- SOLVER_FAR_AREA_KM: the area's core distance, 10-200 km (default 30).
- SOLVER_FAR_AREA_SLACK_MIN: 0-180 (default 0): a grouped load must be back at least this long before its
  truck's latest return. 0: the same timing rules as every plan.

Public repository: an area is named only by km and compass direction from the depot.
This module must not import dispatch_solver (which imports it), pyvrp or numpy.
"""
from __future__ import annotations

import itertools
import logging
import math
import os
import time
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field, replace
from typing import Any

import costing
import load_repack as LR
from dispatch_models import FarAreaReport, kg_units, pallet_text
from providers import haversine_km

log = logging.getLogger("routeiq.dispatch")

ENV_MODE = "SOLVER_FAR_AREA"
ENV_KM = "SOLVER_FAR_AREA_KM"
ENV_SLACK = "SOLVER_FAR_AREA_SLACK_MIN"
MODES = ("off", "report", "thorough", "on")
_OFF_WORDS = ("", "off", "0", "false", "no")
_ON_WORDS = ("on", "1", "true", "yes")

DEFAULT_KM = 30.0
KM_RANGE = (10.0, 200.0)
DEFAULT_SLACK_MIN = 0
SLACK_RANGE = (0, 180)

# Detection (changed only with a replay of saved real requests).
MEMBER_KM = 20.0  # a stop this far from the depot may belong to a far area
LINK_KM = 12.0  # two such stops this close (and on one bearing) are one area
LINK_DEG = 15.0  # ... their bearings from the depot within this many degrees
DETOUR = 1.2  # ... or the nearer one on the way to the farther one
GAP_KM = 8.0  # every other stop of the day at least this far from the area
MIN_STOPS = 2
AREA_MAX_STOPS = 30
MAX_AREAS = 2
# The route check: at most this many loads per area, and this long for every area together.
MAX_LOADS = 3
PLAN_SEC = 1.0
IMPROVE_SHARE = 0.2  # of PLAN_SEC, for the shortest round of an area's stops
# The twin search: its SearchRunReport index and the load re-check's source name of its plan.
TWIN_INDEX = 99
TWIN_KEY = "far"
SOURCE = "FAR~RECOMMENDED"
PIN_LABEL = "the far-area truck"
MAX_LINES = 2

# FarAreaInfo.min_loads_reason: the room bound decides (PALLETS), the day's time and windows do (TIME), no truck
# can carry the area on MAX_LOADS loads or fewer (NO_TRUCK), the route check ran out of time (OUT_OF_TIME).
PINNED_REASONS = ("PALLETS", "TIME")
# Reasons a solve does not explain its far areas at all (nothing to plan, no RECOMMENDED, the hire check).
NOT_EXPLAINED = ("HIRE_CHECK", "NOTHING_TO_PLAN", "NO_RECOMMENDED")
# A verdict's outcome -> FarAreaReport.reason when no option used the grouped plan.
_OUTCOME_REASON = {"KEPT_NOT_BETTER": "NOT_BETTER", "KEPT_SERVES_LESS": "SERVES_LESS", "KEPT_SWAP": "SWAP",
                   "KEPT_NO_FEWER_LOADS": "NO_FEWER_LOADS", "KEPT_AREA_STOP_OUT": "AREA_STOP_OUT",
                   "KEPT_BELOW_MIN_LOADS": "BELOW_MIN_LOADS", "KEPT_SLACK": "SLACK", "KEPT_NOT_VERIFIED": "NOT_VERIFIED",
                   "NO_CANDIDATE": "NO_CANDIDATE", "NOT_COMPARED": "NOT_COMPARED", "ERROR": "ERROR"}

_COMPASS = ("north", "north-east", "east", "south-east", "south", "south-west", "west", "north-west")
_SHORT = ("N", "NE", "E", "SE", "S", "SW", "W", "NW")


# ---------------------------------------------------------------------------------------------
# Settings (read on every call; off by default)
# ---------------------------------------------------------------------------------------------

def _raw(name: str) -> str:
    return os.environ.get(name, "").strip()


def mode() -> str:
    """SOLVER_FAR_AREA: off (the default and anything not read), report, thorough or on."""
    raw = _raw(ENV_MODE).lower()
    if raw in ("report", "thorough"):
        return raw
    return "on" if raw in _ON_WORDS else "off"


def groups(search_mode: str) -> bool:
    """The twin search runs for a solve of this search mode: on, or thorough on a THOROUGH solve."""
    m = mode()
    return m == "on" or (m == "thorough" and search_mode == "THOROUGH")


def core_km() -> float:
    try:
        value = float(_raw(ENV_KM))
    except ValueError:
        return DEFAULT_KM
    return value if KM_RANGE[0] <= value <= KM_RANGE[1] else DEFAULT_KM  # NaN fails both: the default


def slack_min() -> int:
    try:
        value = int(_raw(ENV_SLACK))
    except ValueError:
        return DEFAULT_SLACK_MIN
    return value if SLACK_RANGE[0] <= value <= SLACK_RANGE[1] else DEFAULT_SLACK_MIN


def unread() -> list[tuple[str, str, str]]:
    """The settings that are set but not read (each then counts as its default): (name, value, what it takes)."""
    out: list[tuple[str, str, str]] = []
    raw = _raw(ENV_MODE)
    if raw and raw.lower() not in (*_OFF_WORDS, *_ON_WORDS, "report", "thorough"):
        out.append((ENV_MODE, raw[:20], "off, report, thorough or on"))
    for name, lo, hi, num, what in ((ENV_KM, KM_RANGE[0], KM_RANGE[1], float, "km from 10 to 200"),
                                    (ENV_SLACK, SLACK_RANGE[0], SLACK_RANGE[1], int, "whole minutes from 0 to 180")):
        raw = _raw(name)
        if not raw:
            continue
        try:
            ok = lo <= num(raw) <= hi
        except ValueError:
            ok = False
        if not ok:
            out.append((name, raw[:20], what))
    return out


def status() -> dict:
    """/ready's ``far_area`` (never affects ``ok``)."""
    return {"mode": mode(), "thorough": groups("THOROUGH"), "quick": groups("QUICK"), "core_km": core_km(),
            "slack_min": slack_min(), "unread": [name for name, _, _ in unread()]}


def startup_line() -> str:
    m = mode()
    tail = "".join(f"; {name}={raw!r} not read ({what}): its default is used" for name, raw, what in unread())
    if m == "off":
        return f"Far-area grouping: off (the default; {ENV_MODE} unset or off{tail})"
    what = {"report": "notes only: a plan says why a far area is on two or more loads; plans unchanged",
            "thorough": "THOROUGH plans also search with each far area on its fewest trucks; QUICK plans get the notes only",
            "on": "every plan also searches with each far area on its fewest trucks"}[m]
    return f"Far-area grouping: {m} ({what}; core {core_km():g} km, slack {slack_min()} min{tail})"


# ---------------------------------------------------------------------------------------------
# Detection: coordinates only
# ---------------------------------------------------------------------------------------------

def bearing_deg(lat1: float, lng1: float, lat2: float, lng2: float) -> float:
    """Initial bearing from point 1 to point 2, degrees clockwise from north, 0 to 360."""
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dl = math.radians(lng2 - lng1)
    x = math.sin(dl) * math.cos(p2)
    y = math.cos(p1) * math.sin(p2) - math.sin(p1) * math.cos(p2) * math.cos(dl)
    return (math.degrees(math.atan2(x, y)) + 360.0) % 360.0


def _angle(a: float, b: float) -> float:
    d = abs(a - b) % 360.0
    return min(d, 360.0 - d)


@dataclass(frozen=True)
class Area:
    """One far area: ``stops`` are positions in the stop list ``detect`` was given, in the order of ``stop_ids``
    (ascending stop id: the same area whatever the stops' order)."""

    id: str
    stops: tuple[int, ...]
    stop_ids: tuple[str, ...]
    km_from: float
    km_to: float
    bearing: float
    gap_km: float | None  # the nearest other stop of the day (None: no other stop)

    @property
    def n(self) -> int:
        return len(self.stops)

    @property
    def direction(self) -> str:
        return _COMPASS[int(((self.bearing + 22.5) % 360.0) // 45.0)]

    @property
    def short_direction(self) -> str:
        return _SHORT[int(((self.bearing + 22.5) % 360.0) // 45.0)]

    @property
    def groupable(self) -> bool:
        return MIN_STOPS <= self.n <= AREA_MAX_STOPS

    @property
    def km_text(self) -> str:
        a, b = round(self.km_from), round(self.km_to)
        return f"{b} km" if a == b else f"{a}-{b} km"

    @property
    def label(self) -> str:
        """"the 6 stops 32-55 km south-west of the depot" (km and compass only: the repository is public)."""
        what = "the stop" if self.n == 1 else f"the {self.n} stops"
        return f"{what} {self.km_text} {self.direction} of the depot"

    def label_of(self, served: int | None) -> str:
        """The label for the ``served`` area stops a plan carries: "5 of the 6 stops 32-55 km south-west of the
        depot" when it leaves some out (never "the 6 stops" for a plan that carries 5), else ``label``."""
        if served is None or served >= self.n:
            return self.label
        return f"{served} of the {self.n} stops {self.km_text} {self.direction} of the depot"


def detect(depot_lat: float, depot_lng: float, stops: Sequence[Any], core: float | None = None) -> list[Area]:
    """The far areas among ``stops`` (objects with stop_id, lat, lng), numbered A1, A2, ... by their smallest
    stop id. Deterministic and independent of the stops' order."""
    core = core_km() if core is None else float(core)
    n = len(stops)
    pts = [(float(s.lat), float(s.lng)) for s in stops]
    ids = [str(s.stop_id) for s in stops]
    dist = [haversine_km(depot_lat, depot_lng, la, ln) for la, ln in pts]
    bear = [bearing_deg(depot_lat, depot_lng, la, ln) for la, ln in pts]
    cand = sorted((k for k in range(n) if dist[k] >= MEMBER_KM), key=lambda k: (ids[k], k))
    parent = {k: k for k in cand}

    def find(x: int) -> int:
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x

    for i, a in enumerate(cand):
        for b in cand[i + 1:]:
            if _angle(bear[a], bear[b]) > LINK_DEG:
                continue
            d_ab = haversine_km(*pts[a], *pts[b])
            near, far = (a, b) if dist[a] <= dist[b] else (b, a)
            if d_ab <= LINK_KM or dist[near] + d_ab <= DETOUR * dist[far]:
                ra, rb = find(a), find(b)
                if ra != rb:
                    parent[max(ra, rb, key=lambda r: (ids[r], r))] = min(ra, rb, key=lambda r: (ids[r], r))
    members: dict[int, list[int]] = {}
    for k in cand:
        members.setdefault(find(k), []).append(k)
    found: list[tuple[str, list[int], float | None]] = []
    for group in members.values():
        if max(dist[k] for k in group) < core:
            continue
        inside = set(group)
        gap = min((haversine_km(*pts[m], *pts[o]) for m in group for o in range(n) if o not in inside), default=None)
        if gap is not None and gap < GAP_KM:
            continue  # a suburb that runs on from the city
        found.append((min(ids[k] for k in group), sorted(group, key=lambda k: (ids[k], k)), gap))
    out: list[Area] = []
    for num, (_first, group, gap) in enumerate(sorted(found, key=lambda f: f[0]), start=1):
        sx = sum(math.sin(math.radians(bear[k])) for k in group)
        cx = sum(math.cos(math.radians(bear[k])) for k in group)
        out.append(Area(id=f"A{num}", stops=tuple(group), stop_ids=tuple(ids[k] for k in group),
                        km_from=round(min(dist[k] for k in group), 1), km_to=round(max(dist[k] for k in group), 1),
                        bearing=round((math.degrees(math.atan2(sx, cx)) + 360.0) % 360.0, 1),
                        gap_km=round(gap, 1) if gap is not None else None))
    return out


def groupable(areas: Sequence[Area]) -> list[Area]:
    """The areas a solve may pin: MIN_STOPS..AREA_MAX_STOPS stops, at most MAX_AREAS (most stops first, then the
    smallest stop id), in their id order."""
    keep = sorted((a for a in areas if a.groupable), key=lambda a: (-a.n, min(a.stop_ids)))[:MAX_AREAS]
    return sorted(keep, key=lambda a: int(a.id[1:]))


# ---------------------------------------------------------------------------------------------
# The route check: fewest loads and the pin trucks
# ---------------------------------------------------------------------------------------------

@dataclass
class Need:
    """What one area needs, by the load re-check's own pieces."""

    area: str
    reason: str  # PALLETS, TIME, NO_TRUCK, OUT_OF_TIME
    min_loads: int | None = None
    room_bound: int | None = None
    targets: tuple[str, ...] = ()
    one_truck: bool = False
    back_s: int | None = None  # the check's last return with nothing else on the truck's day
    pallet_units: int = 0
    cases: int = 0
    unload_min: int = 0
    by_pallets: bool = False
    biggest_room: int | None = None  # one truck's room in the area's measure (pallet units or cases)


def _cut(day: LR.Day, tour: list[LR.Load], k: int, fits, balance: bool, cache: dict) -> list[LR.Load] | None:
    """``tour`` (customer blocks, in order) cut into exactly ``k`` consecutive loads that each ``fits`` (a test on
    load_repack.Facts), of fewest metres - with ``balance``, of the shortest longest load first (one load per
    truck: the day's time is what limits each). None when no such cut exists. (load_repack._split takes the fewest
    metres with AT MOST k loads, so it never offers two loads where one is shorter but does not time.)"""
    n = len(tour)
    if k < 1 or k > n:
        return None
    best: list[list[tuple[int, int] | None]] = [[None] * (n + 1) for _ in range(k + 1)]
    cut = [[-1] * (n + 1) for _ in range(k + 1)]
    best[0][0] = (0, 0)
    for j in range(1, k + 1):
        for i in range(j, n + 1):
            for s in range(i - 1, j - 2, -1):
                load = LR._flat(tour[s:i])
                f = cache.get(load)
                if f is None:
                    f = cache[load] = LR.facts(day, load)
                if not fits(f):
                    break  # a longer run from further back fits even less
                prev = best[j - 1][s]
                if prev is None:
                    continue
                val = (max(prev[0], f.occ) if balance else 0, prev[1] + f.metres)
                if best[j][i] is None or val < best[j][i]:  # type: ignore[operator]
                    best[j][i], cut[j][i] = val, s
    if best[k][n] is None:
        return None
    out: list[LR.Load] = []
    i, j = n, k
    while j > 0:
        s = cut[j][i]
        out.append(LR._flat(tour[s:i]))
        i, j = s, j - 1
    return out[::-1]


def _room(td: Any, one_customer: bool) -> tuple[bool, int]:
    by_pallets = getattr(td, "max_pallet_units", 0) > 0
    if not by_pallets:
        return False, int(td.max_cases)
    room = int(td.max_pallet_units)
    if one_customer:
        room = max(room, int(getattr(td, "solo_pallet_units", 0)))
    return True, room


def _bound(td: Any, units: int, cases: int, kg: int, one_customer: bool) -> int:
    """Loads this truck needs for the area by room alone (pallets or cases, and kg)."""
    by_pallets, room = _room(td, one_customer)
    need = units if by_pallets else cases
    b = math.ceil(need / room) if room > 0 else (0 if need <= 0 else 10**6)
    if td.max_kg_units > 0 and kg > 0:
        b = max(b, math.ceil(kg / td.max_kg_units))
    return max(1, b)


def _tours(day: LR.Day, stops: Sequence[int], deadline: float) -> list[list[LR.Load]]:
    """The area's stops in customer blocks (a split order stays together), in a few orders worth cutting into
    loads: the nearest-neighbour round improved on metres, by latest start, and each reversed."""
    order = sorted(stops, key=lambda k: (str(day.stops[k].customer_id), k))
    blocks = LR._blocks(day, tuple(order))
    if len(blocks) < 2:
        return [list(blocks)]
    until = min(deadline, time.monotonic() + IMPROVE_SHARE * PLAN_SEC)
    short, _ = LR._improve(LR._nearest(day, blocks), lambda bl: float(day.metres(LR._flat(bl))), until)
    latest = sorted(blocks, key=lambda b: (min(LR.latest_start_s(day.stops[k], day.window_rule) for k in b), b))
    out: list[list[LR.Load]] = []
    for t in (short, latest, short[::-1], latest[::-1]):
        if t not in out:
            out.append(list(t))
    return out


def _one_truck(day: LR.Day, pricing: LR.Pricing, td: Any, tours: list[list[LR.Load]], k: int,
               cache: dict, deadline: float) -> list[LR.TimedLoad] | None | bool:
    """The area on k loads of this truck's otherwise empty day (each order of the loads in the day), timed exactly;
    None: no way found; False: out of time."""
    tried: set[tuple] = set()
    for tour in tours:
        loads = _cut(day, tour, k, lambda f: LR.fits_truck(f, td), False, cache)
        if loads is None:
            continue
        perms = itertools.permutations(loads) if len(loads) <= 3 else iter([tuple(loads)])
        for perm in perms:
            if perm in tried:
                continue
            tried.add(perm)
            if time.monotonic() > deadline:
                return False
            timed = LR.time_truck(day, td, list(perm), pricing)
            if timed:
                return timed
    return None


def _need(day: LR.Day, pricing: LR.Pricing, area: Area, deadline: float, taken: set[str]) -> Need:
    ks = list(area.stops)
    ss = [day.stops[k] for k in ks]
    units = sum(s.demand_pallet_units or 0 for s in ss)
    cases = sum(s.demand_cases for s in ss)
    kg = sum(kg_units(s.demand_kg) for s in ss)
    one = len({s.customer_id for s in ss}) == 1
    nd = Need(area=area.id, reason="NO_TRUCK", pallet_units=units, cases=cases, unload_min=sum(s.service_min for s in ss))
    trucks = [td for td in day.trucks if td.truck.id not in taken]
    allowed_all = [td for td in trucks
                   if all(s.allowed_truck_ids is None or td.truck.id in s.allowed_truck_ids for s in ss)]
    pool = allowed_all or trucks
    if not pool:
        return nd
    key = {td.idx: (_bound(td, units, cases, kg, one), -_room(td, one)[1], td.idx) for td in pool}
    pool.sort(key=lambda td: key[td.idx])
    nd.by_pallets, nd.biggest_room = _room(pool[0], one)
    nd.room_bound = key[pool[0].idx][0]
    if nd.room_bound > MAX_LOADS:
        return nd
    tours = _tours(day, ks, deadline)
    cache: dict = {}
    # The parts of the multi-truck cut are sized on the biggest truck without the small-truck lists; each part then
    # goes on a truck its stops may go on (fits_truck with them).
    big = pool[0]

    def sized(f: LR.Facts) -> bool:
        return LR.fits_truck(replace(f, allowed=None), big)

    per_m = {td.idx: pricing.trucks[td.idx].per_m if td.idx in pricing.trucks else 0.0 for td in trucks}
    for k in range(nd.room_bound, MAX_LOADS + 1):
        # One truck first: every area stop may go on it, at most k loads of its day.
        best: tuple | None = None
        for td in sorted(allowed_all, key=lambda td: key.get(td.idx, (10**6, 0, td.idx))):
            if k > td.trips_left:
                continue
            got = _one_truck(day, pricing, td, tours, k, cache, deadline)
            if got is False:
                nd.reason = "OUT_OF_TIME"
                return nd
            if got:
                rank = (got[-1].return_s, -_room(td, one)[1], per_m.get(td.idx, 0.0), td.idx)
                if best is None or rank < best[0]:
                    best = (rank, td, got)
        if best is not None:
            nd.min_loads, nd.targets, nd.one_truck, nd.back_s = k, (best[1].truck.id,), True, best[2][-1].return_s
            nd.reason = "PALLETS" if k == nd.room_bound else "TIME"
            return nd
        if k < 2:
            continue
        # Else k trucks with one load each: the parts of the round sized on the biggest truck, each on a truck
        # its stops may go on, timed alone (the earliest return first, then the biggest room, the lowest km rate).
        multi: tuple | None = None
        for tour in tours:
            split = _cut(day, tour, k, sized, True, cache)
            if split is None:
                continue
            parts = sorted(split, key=lambda p: -sum(day.stops[q].demand_pallet_units or day.stops[q].demand_cases
                                                     for q in p))
            used: set[str] = set()
            chosen: list[tuple[Any, list[LR.TimedLoad]]] = []
            for part in parts:
                f = LR.facts(day, part)
                pick = None
                for td in trucks:
                    if td.truck.id in used or not LR.fits_truck(f, td):
                        continue
                    if time.monotonic() > deadline:
                        nd.reason = "OUT_OF_TIME"
                        return nd
                    timed = LR.time_truck(day, td, [part], pricing)
                    if timed:
                        rank = (timed[-1].return_s, -_room(td, one)[1], per_m.get(td.idx, 0.0), td.idx)
                        if pick is None or rank < pick[0]:
                            pick = (rank, td, timed)
                if pick is None:
                    break
                used.add(pick[1].truck.id)
                chosen.append((pick[1], pick[2]))
            if len(chosen) == len(parts):
                back = max(t[-1].return_s for _, t in chosen)
                if multi is None or back < multi[0]:
                    multi = (back, tuple(td.truck.id for td, _ in chosen))
        if multi is not None:
            nd.min_loads, nd.targets, nd.one_truck, nd.back_s = k, multi[1], False, multi[0]
            nd.reason = "PALLETS" if k == nd.room_bound else "TIME"
            return nd
    return nd


def needs(day: LR.Day, pricing: LR.Pricing, areas: Sequence[Area], *, deadline: float) -> dict[str, Need]:
    """Each area's fewest loads and its target trucks (never a truck an earlier area took), all areas within
    ``deadline`` (time.monotonic)."""
    out: dict[str, Need] = {}
    taken: set[str] = set()
    for a in areas:
        nd = _need(day, pricing, a, deadline, taken)
        out[a.id] = nd
        taken.update(nd.targets)
    return out


def pins(areas: Sequence[Area], area_needs: Mapping[str, Need]) -> dict[str, tuple[str, ...]]:
    """stop id -> the trucks it is pinned to, for each area whose need is PALLETS or TIME with targets."""
    out: dict[str, tuple[str, ...]] = {}
    for a in areas:
        nd = area_needs.get(a.id)
        if nd is None or nd.reason not in PINNED_REASONS or not nd.targets:
            continue
        for sid in a.stop_ids:
            out[sid] = tuple(nd.targets)
    return out


def pinned(req: Any, stops: Sequence[Any], stop_pins: Mapping[str, Sequence[str]]) -> tuple[Any, list[Any]]:
    """(request, stops) with each pinned stop's allowed_truck_ids narrowed to its targets (intersected with its
    own list; never emptied) and labelled PIN_LABEL. Order, ids and every other field are unchanged."""
    def pin(s: Any) -> Any:
        targets = stop_pins.get(s.stop_id)
        if not targets:
            return s
        allowed = list(targets) if s.allowed_truck_ids is None else [t for t in s.allowed_truck_ids if t in set(targets)]
        if not allowed:
            return s
        return s.model_copy(update={"allowed_truck_ids": allowed, "allowed_trucks_label": PIN_LABEL})

    new = {s.stop_id: pin(s) for s in req.stops if s.stop_id in stop_pins}
    req_v = req.model_copy(update={"stops": [new.get(s.stop_id, s) for s in req.stops]})
    return req_v, [new.get(s.stop_id) or pin(s) for s in stops]


# ---------------------------------------------------------------------------------------------
# Counting an area's loads, and sending the twin's plan
# ---------------------------------------------------------------------------------------------

def plan_served(plan: Mapping[int, Sequence[Any]], idxs: frozenset[int] | set[int]) -> set[int]:
    """The area stops (of ``idxs``) a plan (truck idx -> loads, each a TimedLoad or a tuple of stop indices)
    serves."""
    return {k for ls in plan.values() for l in ls for k in (l.stops if isinstance(l, LR.TimedLoad) else l) if k in idxs}


def plan_counts(plan: Mapping[int, Sequence[Any]], idxs: frozenset[int] | set[int]) -> tuple[int, int, int]:
    """(new loads with an area stop, their trucks, area stops served) of a plan (truck idx -> loads, each a
    TimedLoad or a tuple of stop indices)."""
    loads = trucks = 0
    for ls in plan.values():
        hit = False
        for l in ls:
            st = l.stops if isinstance(l, LR.TimedLoad) else l
            if any(k in idxs for k in st):
                loads += 1
                hit = True
        trucks += int(hit)
    return loads, trucks, len(plan_served(plan, idxs))


def scenario_counts(sc: Any, ids: frozenset[str] | set[str]) -> tuple[int, int, int]:
    """plan_counts of a DispatchScenario, by stop id."""
    loads = 0
    trucks: set[str] = set()
    served: set[str] = set()
    for ld in sc.loads:
        inside = [st.stop_id for st in ld.stops if st.stop_id in ids]
        if inside:
            loads += 1
            trucks.add(ld.truck_id)
            served.update(inside)
    return loads, len(trucks), len(served)


def should_send(main: Sequence[tuple[int, int, int]] | None, twin: Sequence[tuple[int, int, int]],
                pinned_flags: Sequence[bool], *, stopped: bool, main_stuck: bool,
                mins: Sequence[int | None] | None = None) -> tuple[bool, str | None]:
    """The twin's plan goes to the load re-check when a pinned area that the main plan has on more loads than its
    fewest (``mins``: the route check's, per area; None: not known) is on fewer loads than in the main plan, and no
    area on more; else (False, why): AT_MIN_LOADS when every pinned area is already on its fewest loads in the main
    plan (nothing to group), NO_FEWER_LOADS otherwise. The twin may leave area stops out (the load re-check can put
    them back): that is judged per option (``judge``), never here."""
    if stopped:
        return False, "STOPPED"
    if main_stuck:
        return False, "MAIN_STUCK"
    if main is None:
        return False, "NO_MAIN_PLAN"
    mins = list(mins) if mins is not None else [None] * len(main)
    above = [p and (k is None or m[0] > k) for m, p, k in zip(main, pinned_flags, mins)]
    more = any(_worse(t[0], m[0]) for m, t in zip(main, twin))
    fewer = any(a and _fewer(t[0], m[0]) for m, t, a in zip(main, twin, above))
    if fewer and not more:
        return True, None
    return False, "AT_MIN_LOADS" if any(pinned_flags) and not any(above) else "NO_FEWER_LOADS"


def _fewer(after: int, before: int) -> bool:
    """An area on fewer loads: still on at least one (an area left out entirely is never grouped - review of the
    fixes: a far repack candidate with no loads at all counted as "the area on 0 loads")."""
    return 0 < after < before


def _worse(after: int, before: int) -> bool:
    """An area on more loads, or left out entirely where it had loads."""
    return after > before or after == 0 < before


def fewer_loads(plan: Mapping[int, Sequence[Any]], than: Mapping[int, Sequence[Any]],
                areas_idx: Sequence[frozenset[int]]) -> bool:
    """``plan`` puts an area on fewer loads than ``than`` (and still on one at least) and none on more (or on none
    where it had some)."""
    a = [plan_counts(plan, s)[0] for s in areas_idx]
    b = [plan_counts(than, s)[0] for s in areas_idx]
    return any(_fewer(x, y) for x, y in zip(a, b)) and not any(_worse(x, y) for x, y in zip(a, b))


def area_rule(plan: Mapping[int, Sequence[Any]], than: Mapping[int, Sequence[Any]],
              areas_idx: Sequence[frozenset[int]], mins: Sequence[int | None] | None = None) -> str | None:
    """Why ``plan`` (fewer area loads than ``than``) is not a grouping, or None when it is one:
    KEPT_AREA_STOP_OUT - it leaves out an area stop that ``than`` serves (a set, not a count: never "fewer loads"
    by dropping an area order, even one swapped for another area stop); KEPT_BELOW_MIN_LOADS - it puts an area on
    fewer loads than the route check's fewest (``mins``; None: not known), which the planner never does (a needed
    second truck is never taken away, the owner's rule)."""
    mins = list(mins) if mins is not None else [None] * len(areas_idx)
    for s in areas_idx:
        if not plan_served(plan, s) >= plan_served(than, s):
            return "KEPT_AREA_STOP_OUT"
    for s, k in zip(areas_idx, mins):
        after, before = plan_counts(plan, s)[0], plan_counts(than, s)[0]
        if k is not None and after < before and after < k:
            return "KEPT_BELOW_MIN_LOADS"
    return None


def from_far(source: str) -> bool:
    """A load re-check candidate built from the twin search's plan ("FAR~RECOMMENDED", "...+repack:...")."""
    return source.split("+", 1)[0] == SOURCE


def stage_in_worker(job: dict) -> tuple[list[LR.Candidate], list[str]]:
    """The twin's plan's own stage job (PyVRP's pattern): never part of the engine's jobs, so a repack that
    overruns, raises or dies only loses these candidates. load_repack.build_candidates once per goal, sharing
    ``budget_s``; no constructive fallback (the engine's RECOMMENDED job builds it). Test hooks:
    ROUTEIQ_TEST_FAIL_FAR_STAGE, ROUTEIQ_TEST_HANG_FAR_STAGE, ROUTEIQ_TEST_KILL_FAR_STAGE."""
    if os.environ.get("ROUTEIQ_TEST_FAIL_FAR_STAGE"):
        raise RuntimeError("test hook: the far-area stage failed")
    if os.environ.get("ROUTEIQ_TEST_HANG_FAR_STAGE"):
        time.sleep(3600)
    if os.environ.get("ROUTEIQ_TEST_KILL_FAR_STAGE"):
        os._exit(137)
    LR.warm_up()
    t0 = time.perf_counter()
    day, plan, pricing = job["day"], job["plan"], job["score_pricing"]
    src = [LR.Source(SOURCE, plan)]
    cands: list[LR.Candidate] = []
    notes: list[str] = []
    goals = job["goals"]
    for i, (goal, goal_pricing) in enumerate(goals):
        left = job["budget_s"] - (time.perf_counter() - t0)
        if left < 0.5:
            notes.append(f"{SOURCE}: no time left for the {goal} repack")
            continue
        c, n = LR.build_candidates(day, pricing, goal, goal_pricing, src, job["optional"], job["cap_s"],
                                   left / (len(goals) - i), time_raw=i == 0, fit_weights=job["fit_weights"],
                                   extra_s=job.get("extra_s", 0.0), fallback=False)
        cands += c
        notes += n
    return cands, notes


# ---------------------------------------------------------------------------------------------
# The keep rule
# ---------------------------------------------------------------------------------------------

@dataclass
class Verdict:
    """One option's judgement of the grouped plan against ``prev``, the plan it has with this step off."""

    option: str
    outcome: str
    use: bool = False
    source: str | None = None
    before: list[tuple[int, int, int]] = field(default_factory=list)  # per area: loads, trucks, stops served
    after: list[tuple[int, int, int]] = field(default_factory=list)
    gains: dict = field(default_factory=dict)  # "without minus with"
    slack_s: int | None = None  # the tightest grouped load: its truck's latest return minus its return
    back_s: int | None = None  # that load's return
    added: int = 0  # stops it plans that prev does not
    dropped: int = 0  # stops prev plans that it does not
    prev_score: Any = None
    fc_score: Any = None
    # Orders on another truck than in the previous plan of the day (re-plans only; a first plan has none): the
    # plan-continuity part of the preference cost (load_repack.score), for prev and for the grouped plan.
    moved_before: int | None = None
    moved_after: int | None = None
    area_left: list[int] = field(default_factory=list)  # per area: its stops prev serves and the grouped plan does not


def _moved(day: Any, plan: Mapping[int, Sequence[Any]]) -> int | None:
    """Stops of ``plan`` on another truck than in the previous plan (load_repack._moved, the rule the preference
    cost charges); None when ``day`` has no stops to read."""
    by_idx = getattr(day, "by_idx", None)
    if getattr(day, "stops", None) is None or by_idx is None:
        return None
    return sum(int(LR._moved(day, k, by_idx[idx])) for idx, ls in plan.items() if idx in by_idx
               for l in ls for k in (l.stops if isinstance(l, LR.TimedLoad) else l))


def _gains(prev: LR.Candidate, fc: LR.Candidate) -> dict:
    r, b = prev.score, fc.score
    s = costing.COST_SCALE
    return {"gain_omr": round((r.cost - b.cost) / s, 3), "gain_operating_omr": round((r.operating - b.operating) / s, 3),
            "gain_preferences_omr": round(((r.cost - r.operating) - (b.cost - b.operating)) / s, 3),
            "gain_km": round((r.metres - b.metres) / 1000.0, 3), "gain_trucks": r.trucks - b.trucks,
            "gain_loads": r.loads - b.loads}


def judge(name: str, fc: LR.Candidate | None, fc_lost: bool, prev: LR.Candidate | None, prev_lost: bool,
          areas_idx: Sequence[frozenset[int]], day: LR.Day, slack_s: int, n_far: int,
          mins: Sequence[int | None] | None = None) -> Verdict:
    """Use ``fc`` (the best grouped candidate for the option's goal) instead of ``prev`` only when: it puts an
    area on fewer loads and none on more (R3); it serves every area stop prev serves and puts no area below the
    route check's fewest loads (``mins``; area_rule: R3a, R3b); it is not worse on the goal, the tie-breaker aside
    (R1: service by strict priority first, never a candidate that serves less than the option's own plan when prev
    does not); it leaves out no stop prev plans unless it serves strictly better by priority (R2); and with a slack
    setting every grouped load is back that long before its truck's latest return (R4). R5, the independent check,
    is the caller's."""
    if prev is None:
        return Verdict(name, "NOT_COMPARED")
    before = [plan_counts(prev.plan, s) for s in areas_idx]
    if fc is None:
        return Verdict(name, "KEPT_NO_FEWER_LOADS" if n_far else "NO_CANDIDATE", before=before)
    after = [plan_counts(fc.plan, s) for s in areas_idx]
    served_p, served_f = LR.served_of(prev.plan), LR.served_of(fc.plan)
    v = Verdict(name, "", source=fc.source, before=before, after=after, gains=_gains(prev, fc),
                added=len(served_f - served_p), dropped=len(served_p - served_f), prev_score=prev.score, fc_score=fc.score,
                moved_before=_moved(day, prev.plan), moved_after=_moved(day, fc.plan),
                area_left=[len(plan_served(prev.plan, s) - plan_served(fc.plan, s)) for s in areas_idx])
    grouped = [i for i in range(len(areas_idx)) if _fewer(after[i][0], before[i][0])]
    goal = LR.GOALS[name]
    if not grouped or any(_worse(after[i][0], before[i][0]) for i in range(len(areas_idx))):
        v.outcome = "KEPT_NO_FEWER_LOADS"
    elif (why := area_rule(fc.plan, prev.plan, areas_idx, mins)) is not None:
        v.outcome = why
    elif fc_lost and not prev_lost:
        v.outcome = "KEPT_SERVES_LESS"
    elif tuple(goal(fc.score))[:-1] > tuple(goal(prev.score))[:-1]:
        v.outcome = "KEPT_SERVES_LESS" if fc.score.service > prev.score.service else "KEPT_NOT_BETTER"
    elif not (fc.score.service < prev.score.service or served_f >= served_p):
        v.outcome = "KEPT_SWAP"
    else:
        idxs = set().union(*(areas_idx[i] for i in grouped))
        tight: tuple[int, int] | None = None
        for idx, loads in fc.plan.items():
            td = day.by_idx.get(idx)
            for tl in loads:
                if td is None or not any(k in idxs for k in tl.stops):
                    continue
                slack = td.latest_return_s - tl.return_s
                if tight is None or slack < tight[0]:
                    tight = (slack, tl.return_s)
        if tight is not None:
            v.slack_s, v.back_s = tight
        if slack_s > 0 and tight is not None and tight[0] < slack_s:
            v.outcome = "KEPT_SLACK"
        else:
            v.outcome, v.use = "GROUPED", True
    return v


def result_of(v: Verdict) -> dict:
    """FarAreaResult of a verdict (a dict; report_or_none validates it)."""
    out = {"option": v.option, "outcome": v.outcome, "source": v.source, **v.gains,
           "loads_before": [b[0] for b in v.before], "loads_after": [a[0] for a in v.after],
           "slack_min": round(v.slack_s / 60.0, 1) if v.slack_s is not None else None,
           "moved_before": v.moved_before, "moved_after": v.moved_after}
    if v.prev_score is not None:
        out["served_delta"] = v.added - v.dropped
    return out


def _n(count: int, word: str) -> str:
    return f"{count} {word}" + ("" if count == 1 else "s")


def _hhmm(s: int) -> str:
    m = int(round(s / 60.0))
    return f"{(m // 60) % 24:02d}:{m % 60:02d}"


def _are(count: int) -> str:
    return "is" if count == 1 else "are"


def _left_out(a: Area, served: int, what: str) -> str:
    """" (1 stop of the area is left out, as without this step: see Unserved orders)" when ``served`` < the area's
    stops, else ""."""
    left = a.n - served
    return f" ({_n(left, 'stop')} of the area {_are(left)} left out{what}: see Unserved orders)" if left > 0 else ""


def grouped_note(v: Verdict, areas: Sequence[Area], slack_setting_min: int = 0) -> str:
    """The dispatcher's note on an option that took the grouped plan, compared with the plan it would have had
    without this step (never with the raw search plan). It names the area stops the grouped plan carries ("5 of
    the 6 stops"): an area stop it leaves out was left out without it too (judge's area rule)."""
    parts = [f"{a.label_of(f[2])} now go on {_n(f[0], 'load')} ({_n(f[1], 'truck')}) instead of {b[0]} "
             f"({_n(b[1], 'truck')}){_left_out(a, f[2], ', as without this step')}"
             for a, b, f in zip(areas, v.before, v.after) if _fewer(f[0], b[0])]
    r, b = v.prev_score, v.fc_score
    s = costing.COST_SCALE
    text = "Far area: " + "; ".join(parts) + "."
    if r is not None and b is not None:
        text += (f" Trucks {r.trucks} -> {b.trucks}, loads {r.loads} -> {b.loads}, km {r.metres / 1000:,.0f} -> "
                 f"{b.metres / 1000:,.0f}, operating cost {r.operating / s:,.0f} -> {b.operating / s:,.0f} OMR.")
    if v.dropped:
        text += (f" It serves the day better by priority: it plans {_n(v.added, 'stop')} left out without it, and "
                 f"{_n(v.dropped, 'other stop')} {'is' if v.dropped == 1 else 'are'} left out in their place "
                 "(see Unserved orders).")
    elif v.added:
        text += f" It also plans {_n(v.added, 'more stop')}."
    if slack_setting_min > 0 and v.back_s is not None and v.slack_s is not None:
        text += f" Its grouped load is back at {_hhmm(v.back_s)}, {v.slack_s // 60} min before the latest return."
    return text + " It passed the planner's own checks, timing and costs."


def dearer_text(v: Verdict) -> str:
    """Why a grouped plan was dearer on RECOMMENDED's goal, each part with its own sign (never one part "of" the
    other): the money to run it (operating cost, and km) and the preference cost (load_repack.score: orders on
    another truck than in the previous plan of the day, early delivery of P1/P2 and the customers' preferred hours;
    the handbook's "preference cost", never all of it called "preferred hours")."""
    g = v.gains
    total = round(-(g.get("gain_omr") or 0.0))
    money = round(-(g.get("gain_operating_omr") or 0.0))
    pref = round(-(g.get("gain_preferences_omr") or 0.0))
    km = round(-(g.get("gain_km") or 0.0))
    km_text = f"{abs(km):,} km {'longer' if km > 0 else 'shorter'}" if km else "about as many km"
    moved = (v.moved_after - v.moved_before) if v.moved_before is not None and v.moved_after is not None else 0
    why_pref = (f" ({_n(moved, 'more order')} on another truck than in the previous plan)" if moved > 0
                else " (early delivery of P1/P2, the customers' preferred hours and orders kept on their previous truck)")
    if money < 0 < pref:
        return (f"it is {-money:,} OMR cheaper to run and {km_text}, but its preference cost is {pref:,} OMR higher"
                f"{why_pref}, so {total:,} OMR more in all")
    if money == 0 < pref:
        return f"it costs about the same to run ({km_text}), but its preference cost is {pref:,} OMR higher{why_pref}"
    if pref < 0 < money:
        return (f"it costs {money:,} OMR more to run ({km_text}), and its preference cost is only {-pref:,} OMR lower, "
                f"so {total:,} OMR more in all")
    if money > 0 and pref > 0:
        return f"it costs {total:,} OMR more: {money:,} OMR more to run ({km_text}) and {pref:,} OMR more in preference cost{why_pref}"
    if money > 0:
        return f"it costs {money:,} OMR more to run ({km_text})"
    return "it is not cheaper on the plan's goal"


def explain_lines(run: "Run", counts: Sequence[tuple[int, int, int]]) -> list[str]:
    """At most MAX_LINES lines on RECOMMENDED: why each far area served on two or more loads still is. Each names the
    area stops the plan carries ("6 of the 7 stops") and how many are left out."""
    out: list[str] = []
    verdict = run.verdicts.get("RECOMMENDED")
    for a, (loads, trucks, served) in zip(run.areas, counts):
        if len(out) >= MAX_LINES:
            break
        if served < 2 or loads < 2:
            continue
        nd = run.needs.get(a.id)
        k = nd.min_loads if nd is not None else None
        whole = served >= a.n
        head = f"Far area: {a.label_of(served)} are on {_n(loads, 'load')} ({_n(trucks, 'truck')})"
        tail = "." + (f" {_n(a.n - served, 'other stop')} of the area {_are(a.n - served)} left out (see Unserved orders)."
                      if not whole else "")
        i = run.areas.index(a)
        if nd is not None and nd.reason == "PALLETS" and k is not None and loads <= k and k >= 2:
            whose = "their" if whole else "the whole area's"
            if nd.by_pallets:
                what = f"{whose} {pallet_text(nd.pallet_units)} pallets"
                room = f"{pallet_text(nd.biggest_room or 0)} pallets"
            else:
                what, room = f"{whose} {nd.cases:,} cases", f"{(nd.biggest_room or 0):,} cases"
            out.append(f"{head}: {what} need at least {k} loads (one load holds at most {room}){tail}")
        elif nd is not None and nd.reason == "TIME" and k is not None and loads <= k:
            them = "them all" if whole else "the whole area"
            out.append(f"{head}: one load cannot do {them} within the day's hours ({nd.unload_min / 60:.1f} h of "
                       f"unloading plus the driving and the break), so at least {k} loads are needed{tail}")
        elif verdict is not None and verdict.outcome.startswith("KEPT_") and len(verdict.after) > i and \
                len(verdict.before) > i and _fewer(verdict.after[i][0], verdict.before[i][0]):
            left = verdict.area_left[i] if len(verdict.area_left) > i else 0
            why = {"KEPT_NOT_BETTER": dearer_text(verdict),
                   "KEPT_AREA_STOP_OUT": f"it would leave out {_n(left, 'stop')} of the area itself" if left else
                                         "it would leave out a stop of the area itself",
                   "KEPT_BELOW_MIN_LOADS": f"that is fewer than the {k} loads the whole area needs" if k else
                                           "that is fewer loads than the whole area needs",
                   "KEPT_SERVES_LESS": "it would leave out another order",
                   "KEPT_SWAP": "it would leave out another order",
                   "KEPT_SLACK": (f"a truck would be back at {_hhmm(verdict.back_s)}, less than {slack_min()} min before "
                                  "the latest return") if verdict.back_s is not None else "a truck would be back too late",
                   "KEPT_NOT_VERIFIED": "it did not pass the planner's own checks"}.get(verdict.outcome)
            if why:
                out.append(f"{head}: a plan with them on {_n(verdict.after[i][0], 'load')} was checked: {why}{tail}")
        elif nd is not None and nd.reason in PINNED_REASONS and k is not None and k < loads:
            if run.report.get("search") is not None and run.report.get("reason") == "NO_FEWER_LOADS":
                out.append(f"{head}: the search with the area on its fewest trucks found no plan with fewer loads{tail}")
            elif run.report.get("search") is None:
                if nd.by_pallets:
                    size = f"{pallet_text(nd.pallet_units)} pallets"
                else:
                    size = f"{nd.cases:,} cases"
                them = "them all" if whole else "the whole area"
                carry = f"one load could carry {them}" if k == 1 else \
                    f"{_n(k, 'load')} {'on one truck ' if nd.one_truck else 'on different trucks '}could carry {them}"
                back = f", back about {_hhmm(nd.back_s)} with nothing else on its day" if nd.back_s is not None and nd.one_truck else ""
                out.append(f"{head}: by pallets and time {carry} ({size}{back}); far-area grouping did not run for "
                           f"this plan{tail}")
    return out


# ---------------------------------------------------------------------------------------------
# One solve's state and its report
# ---------------------------------------------------------------------------------------------

@dataclass
class Run:
    """One solve's far-area state (dispatch_solver passes it along; it never leaves the API process)."""

    mode: str
    search_mode: str
    report: dict
    twin: bool = False  # the twin search is wanted (it passed every gate before the road matrix)
    areas: list[Area] = field(default_factory=list)  # on the final stops
    needs: dict[str, Need] = field(default_factory=dict)
    pins: dict[str, tuple[str, ...]] = field(default_factory=dict)
    checked: bool = False  # the route check ran on the final stops
    judged: bool = False  # the load re-check judged the grouped plan
    verdicts: dict[str, Verdict] = field(default_factory=dict)


def new_report(m: str) -> dict:
    return {"mode": m, "status": "SKIPPED", "reason": None, "core_km": core_km(), "slack_min": slack_min(),
            "plan_sec": None, "sent": False, "chosen_for": [], "areas": [], "search": None, "results": []}


def start(search_mode: str) -> Run:
    m = mode()
    return Run(mode=m, search_mode=search_mode, report=new_report(m))


def skip(run: Run, reason: str) -> None:
    run.twin = False
    run.report.update(status="SKIPPED", reason=reason)


def explains(run: Run) -> bool:
    """The solve explains its far areas (every mode but off, unless nothing is planned for RECOMMENDED here)."""
    return run.report.get("reason") not in NOT_EXPLAINED


def fail(run: Run, reason: str) -> None:
    run.report.update(status="FAILED", reason=reason)


def note_stage(run: Run | None, reason: str) -> None:
    """The grouped plan was sent but its stage job did not give candidates (OUT_OF_TIME, NO_STAGE_WORKER, NO_STAGE,
    STAGE_FAILED): nothing changes but the report."""
    if run is None:
        return
    run.report.update(status="FAILED" if reason == "STAGE_FAILED" else "NOT_USED", reason=reason)


def area_info(a: Area, nd: Need | None, pinned_area: bool) -> dict:
    return {"area": a.id, "label": a.label, "stops": a.n, "km_from": a.km_from, "km_to": a.km_to,
            "direction": a.direction, "gap_km": a.gap_km, "pallet_units": nd.pallet_units if nd else None,
            "cases": nd.cases if nd else None, "unload_min": nd.unload_min if nd else None,
            "min_loads": nd.min_loads if nd else None, "min_loads_reason": nd.reason if nd else None,
            "targets": list(nd.targets) if nd and pinned_area else [], "pinned": pinned_area}


def check(run: Run, day: LR.Day, pricing: LR.Pricing, depot_lat: float, depot_lng: float, stops: Sequence[Any],
          deadline: float | None = None) -> dict[str, tuple[str, ...]]:
    """Detection on the final stops (``day.stops``), the route check within PLAN_SEC and the pins; recorded in
    ``run`` and its report."""
    t0 = time.monotonic()
    run.areas = groupable(detect(depot_lat, depot_lng, stops))
    run.needs = needs(day, pricing, run.areas, deadline=deadline if deadline is not None else t0 + PLAN_SEC)
    run.pins = pins(run.areas, run.needs)
    run.checked = True
    run.report["plan_sec"] = round(time.monotonic() - t0, 2)
    run.report["areas"] = [area_info(a, run.needs.get(a.id), any(sid in run.pins for sid in a.stop_ids)) for a in run.areas]
    return run.pins


def pinned_flags(run: Run) -> list[bool]:
    return [any(sid in run.pins for sid in a.stop_ids) for a in run.areas]


def min_loads(run: Run) -> list[int | None]:
    """Per area: the route check's fewest loads (PALLETS / TIME; None: not known - not checked, NO_TRUCK,
    OUT_OF_TIME)."""
    out: list[int | None] = []
    for a in run.areas:
        nd = run.needs.get(a.id)
        out.append(nd.min_loads if nd is not None and nd.reason in PINNED_REASONS else None)
    return out


def set_counts(run: Run, key: str, counts: Sequence[tuple[int, int, int]] | None) -> None:
    if counts is None:
        return
    for info, c in zip(run.report.get("areas") or [], counts):
        info.update({f"loads_{key}": c[0], f"trucks_{key}": c[1], f"served_{key}": c[2]})


def judged(run: Run, verdicts: Mapping[str, Verdict]) -> None:
    """The load re-check judged the grouped plan for these options: the report's results, chosen_for, status."""
    run.judged = True
    run.verdicts.update(verdicts)
    run.report["results"] = [result_of(v) for v in verdicts.values()]
    run.report["chosen_for"] = [name for name, v in verdicts.items() if v.use]
    if run.report["chosen_for"]:
        run.report.update(status="USED", reason=None)
    else:
        first = verdicts.get("RECOMMENDED") or next(iter(verdicts.values()), None)
        run.report.update(status="NOT_USED", reason=_OUTCOME_REASON.get(first.outcome, first.outcome) if first else "NO_CANDIDATE")


def finish(run: Run) -> None:
    """The report's final status once the solve is done (the grouped plan sent but never judged: NO_STAGE)."""
    rep = run.report
    if rep.get("sent") and not run.judged and rep.get("reason") is None:
        rep.update(status="NOT_USED", reason="NO_STAGE")
    if run.judged:
        judged(run, dict(run.verdicts))  # the verdicts as they ended (R5 fallbacks)


def summary(run: Run) -> str:
    """One log line per area (km and compass only)."""
    rep = run.report
    out = []
    for a, info in zip(run.areas, rep.get("areas") or []):
        nd = run.needs.get(a.id)
        size = f"{pallet_text(nd.pallet_units)} pallets" if nd is not None and nd.by_pallets else \
            f"{nd.cases} cases" if nd is not None else "?"
        out.append(f"{a.id}: {a.n} stops {a.km_text} {a.short_direction}, {size}, needs {nd.min_loads if nd else '?'} "
                   f"({nd.reason if nd else '?'}), targets {list(info.get('targets') or []) or '-'} | main "
                   f"{info.get('loads_main', '-')} loads | twin {info.get('loads_far', '-')} | final {info.get('loads_final', '-')}")
    verdicts = "; ".join(f"{r['option']}: {r['outcome']}" for r in rep.get("results") or [])
    return (f"mode={rep.get('mode')} status={rep.get('status')} reason={rep.get('reason')} sent={rep.get('sent')} "
            + (" | ".join(out) or "no far area") + (f" | {verdicts}" if verdicts else ""))


def report_or_none(data: FarAreaReport | Mapping[str, Any] | None) -> FarAreaReport | None:
    """SearchReport.far_area from the solve's far-area state: a report that does not validate is dropped with a
    warning (the plan is unaffected) instead of failing a finished solve."""
    if data is None:
        return None
    try:
        return data if isinstance(data, FarAreaReport) else FarAreaReport.model_validate(dict(data))
    except Exception as exc:  # noqa: BLE001 - a report must never cost the plan
        log.warning("far-area report left out (the plan is unaffected): %s", exc)
        return None
