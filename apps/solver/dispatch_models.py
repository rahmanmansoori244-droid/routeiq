"""Wire contract for ``POST /optimize-dispatch`` (NMWC daily dispatch planning).

Mirrors ``packages/shared-types/src/dispatch.ts`` field-for-field. All times are MINUTES FROM
MIDNIGHT of the delivery day (06:30 -> 390). Money is OMR. Distances in the response are km.
"""
from __future__ import annotations

import math
from typing import Literal

from pydantic import BaseModel, Field, model_validator

DispatchScenarioName = Literal["RECOMMENDED", "MIN_TRUCKS", "MIN_DISTANCE"]

UnservedReason = Literal[
    "MISSING_COORDINATES",
    "INVALID_LOCATION",
    "UNKNOWN_CUSTOMER",
    "UNKNOWN_PRODUCT",
    "EXCEEDS_ANY_TRUCK_CAPACITY",
    "NO_AVAILABLE_TRUCK",
    "HARD_WINDOW_INFEASIBLE",
    "SHIFT_LIMIT",
    "TRIP_LIMIT",
    "LOCKED_PLAN_CONFLICT",
    "LATE_ORDER_NO_CAPACITY",
    "SOLVER_DROPPED_LOW_PRIORITY",
    "ROUTING_PROVIDER_FAILURE",
    "INFEASIBLE",
    "UNKNOWN",
]

DAY_MIN = 24 * 60
# Largest day one optimization supports (review F19): the road matrix, the search and the
# post-solve stage are sized for it. More stops answer 422; the web checks it first.
MAX_STOPS = 600


# Weights (audit F08, owner decision 15: no hidden rounding margin). Every kg comparison of the
# engine - the route search's Kg dimension, the prefilters, the repack, the timing, the shortage
# reasons and the independent check - is made in whole units of 0.1 kg, so a load that weighs
# exactly the payload fits it. Before, each stop was rounded UP to a whole kg and the payload DOWN:
# 999.1 + 999.1 + 1001.8 = 3,000.0 kg was left out of a 3,000 kg truck, and float noise (7 x 9.3 kg
# = 65.10000000000001) cost another kg. The web sends every order's kg already to 0.1 kg.
# Each scenario reports the unit (DispatchScenario.weight_unit_kg).
WEIGHT_UNIT_KG = 0.1


def kg_units(kg: float) -> int:
    """A stop's (or load's) kg in 0.1 kg units, to the NEAREST unit: 65.10000000000001 -> 651,
    999.14 -> 9991, 0.05 -> 1. The same rule as the web's kgTenths (Math.round(kg x 10))."""
    return int(math.floor(kg * 10 + 0.5)) if kg > 0 else 0


def payload_units(kg: float) -> int:
    """A truck's payload in 0.1 kg units, rounded DOWN (never more than the truck may carry; a
    whole-kg or 0.1 kg payload is exact): 3000 -> 30000, 2998.5 -> 29985. 0 = no payload set."""
    return int(math.floor(kg * 10 + 1e-6)) if kg > 0 else 0


def kg_text(kg: float) -> str:
    """kg for a message: whole kg without decimals ("3,000"), else one decimal ("3,000.1")."""
    u = kg_units(kg) if kg >= 0 else -kg_units(-kg)
    return f"{u // 10:,}" if u % 10 == 0 else f"{u / 10:,.1f}"


# Pallets (owner decision 4 Oct 2026: truck capacity in pallets / bays, mixed pallets allowed). A
# truck with ``bays`` (pallet positions) is planned by PALLETS: a load fits when its pallet need is
# at most bays x Pallet fill (config.pallet_fill_pct, the company's safety margin, default 95%) AND
# its kg at most the payload; its case capacity is then not a limit. A truck without bays keeps the
# case rule exactly as before. A stop's pallet need comes from the web, in whole units of 1/1000
# pallet (demand_pallet_units): each order line's cases / its product's cases per pallet, rounded UP
# once per line, then added up (mixed pallets: fractions add up). Every pallet comparison of the
# engine - the route search's Pallets dimension, the prefilters, the repack, the shortage reasons,
# the second search and the independent check - adds and compares these integers, with no other
# rounding (the F08 pattern of the kg tenths). Orders, invoices and driver sheets stay in cases.
PALLET_UNIT = 0.001


def pallet_room_units(bays: int, fill_pct: int) -> int:
    """A bay truck's room in 1/1000 pallet: bays x fill % x 10 (12 bays at 95% = 11,400 = 11.4 pallets)."""
    return int(bays) * int(fill_pct) * 10


def pallet_text(units: int) -> str:
    """Pallets for a message, to one decimal, halves up: 11,400 -> "11.4", 2,513 -> "2.5", 160,250 -> "160.3"."""
    neg = units < 0
    tenths = (abs(int(units)) + 50) // 100
    text = f"{tenths // 10:,}.{tenths % 10}"
    return f"-{text}" if neg and tenths else text


class DispatchDepot(BaseModel):
    id: str
    lat: float = Field(ge=-90, le=90)
    lng: float = Field(ge=-180, le=180)
    open_min: int = Field(default=0, ge=0, le=DAY_MIN)
    close_min: int = Field(default=DAY_MIN, ge=0, le=DAY_MIN)


class FrozenTrip(BaseModel):
    """A load that is LOCKED / LOADING / DISPATCHED / COMPLETED. The solver never touches it - it
    only blocks that truck's time so new trips start after it returns (reload + loading of the
    next load's cases), and it counts against the truck's loads per day."""

    load_no: int = Field(ge=1)
    depart_min: int = Field(ge=0, le=DAY_MIN * 2)
    return_min: int = Field(ge=0, le=DAY_MIN * 2)
    cases: int = 0
    # The driver break planned with this load (on the road, or at the depot before it left); None
    # = none recorded (made before the break rule, or the break was elsewhere). Optional and
    # additive: an older web never sends it.
    break_start_min: int | None = Field(default=None, ge=0, le=DAY_MIN * 2)
    break_min: int | None = Field(default=None, ge=0, le=180)
    # The pallet need the load was planned with (1/1000 pallet), for the record only: frozen loads
    # are never re-checked. Optional and additive: an older web never sends it.
    pallet_units: int | None = Field(default=None, ge=0)


class DispatchTruck(BaseModel):
    id: str
    code: str = ""
    capacity_cases: int = Field(ge=0)
    capacity_kg: float = Field(default=0, ge=0)  # 0 = not constrained
    fixed_cost: float = Field(default=0, ge=0)  # OMR per day the truck is used
    trip_cost: float = Field(default=0, ge=0)  # OMR per load (loading labour etc.)
    cost_per_km: float = Field(default=0, ge=0)  # OMR/km EXCLUDING fuel when km_per_litre is set
    km_per_litre: float | None = Field(default=None, gt=0)
    available_from_min: int | None = Field(default=None, ge=0, le=DAY_MIN)
    available_to_min: int | None = Field(default=None, ge=0, le=DAY_MIN * 2)
    max_trips: int | None = Field(default=None, ge=1, le=10)
    frozen_trips: list[FrozenTrip] = Field(default_factory=list)
    # Pallet positions (owner decision 4 Oct 2026). Set: the truck is planned by pallets - room =
    # bays x config.pallet_fill_pct (pallet_room_units) and the payload; capacity_cases is then not a
    # limit. None (an older web, or a truck without bays): planned by cases, exactly as before.
    bays: int | None = Field(default=None, ge=1, le=40)


class DispatchStop(BaseModel):
    """One physical delivery stop = one customer branch. Several sales orders / SKU lines for
    that branch are aggregated by the caller; ``order_ids`` lets us map the result back."""

    stop_id: str
    order_ids: list[str] = Field(min_length=1)
    customer_id: str
    lat: float = Field(ge=-90, le=90)
    lng: float = Field(ge=-180, le=180)
    demand_cases: int = Field(ge=0)
    demand_kg: float = Field(default=0, ge=0)
    # The stop's pallet need in 1/1000 pallet (PALLET_UNIT): the sum over its order lines of
    # ceil(cases x 1000 / cases per pallet). Required on every stop when a truck has bays (the
    # request's validator); None otherwise (an older web, or a day without bay trucks).
    demand_pallet_units: int | None = Field(default=None, ge=0)
    service_min: int = Field(default=10, ge=0, le=480)
    priority: int = Field(default=3, ge=1, le=5)  # 1 = HIGHEST, 5 = LOWEST
    hard_start_min: int | None = Field(default=None, ge=0, le=DAY_MIN)
    hard_end_min: int | None = Field(default=None, ge=0, le=DAY_MIN)
    pref_start_min: int | None = Field(default=None, ge=0, le=DAY_MIN)
    pref_end_min: int | None = Field(default=None, ge=0, le=DAY_MIN)
    margin: float | None = None  # contribution margin OMR (only when reliable)
    revenue: float | None = None
    late: bool = False
    # Re-plans: the truck this stop was on in the previous plan version (plan continuity).
    previous_truck_id: str | None = None

    @model_validator(mode="after")
    def _windows_ordered(self) -> "DispatchStop":
        if self.hard_start_min is not None and self.hard_end_min is not None and self.hard_end_min < self.hard_start_min:
            raise ValueError(f"stop {self.stop_id}: hard window end before start")
        if self.pref_start_min is not None and self.pref_end_min is not None and self.pref_end_min < self.pref_start_min:
            raise ValueError(f"stop {self.stop_id}: preferred window end before start")
        return self


class DispatchConfig(BaseModel):
    shift_start_min: int = Field(default=6 * 60, ge=0, le=DAY_MIN)  # earliest first departure
    shift_max_min: int = Field(default=11 * 60, ge=30, le=DAY_MIN)  # first departure -> last return
    # The latest return (owner: "18:00 is the latest return"): every truck is back at the depot by
    # this minute of the day, whenever it leaves - on a plan made on its delivery day too (the web
    # sends the tenant's first departure + shift maximum, never the "now + turnaround" start). None
    # (an older web): only the shift maximum from the first departure, as before. Echoed.
    latest_return_min: int | None = Field(default=None, ge=0, le=2 * DAY_MIN)
    overtime_after_min: int | None = Field(default=9 * 60, ge=0, le=DAY_MIN)  # soft, per truck day
    overtime_cost_per_hour: float = Field(default=4.0, ge=0)
    reload_min: int = Field(default=30, ge=0, le=240)  # depot turnaround between loads
    # Loading time on top of reload_min, per case of the NEXT load (0.04 -> 1,100 cases = 44 min).
    loading_min_per_case: float = Field(default=0.0, ge=0, le=1)
    # A plan made on its own delivery day (web, stabilization PR8 review): the time it was made.
    # Loading of a new load cannot start before it, so every new load - on a truck standing at the
    # depot as on one coming back - leaves no earlier than loading_from_min + reload_min +
    # loading_min_per_case x ITS cases (like after a frozen return, without using a trip or moving
    # the shift). None (a plan for a later day): the first load of the day is loaded before the
    # shift starts, as before. Optional and additive: an older web never sends it.
    loading_from_min: int | None = Field(default=None, ge=0, le=DAY_MIN)
    # Receiving hours (owner rule 29 Sep 2026). "FINISH": unloading is finished by closing
    # (service start + service_min <= hard_end_min), and a preferred end means "finished by" too.
    # "START": unloading only has to start by closing (the earlier rule; the default, so an older
    # web that sends nothing is planned exactly as before). The web sends the TRUE closing time;
    # only the solver subtracts the stop time (load_repack.latest_start_s).
    window_rule: Literal["START", "FINISH"] = "START"
    # Driver break (owner rule 29-30 Sep 2026): one break of break_min per truck-day (one driver
    # per truck per day), STARTING between break_start_from_min and break_start_to_min, on the road
    # between stops or at the depot (it may overlap a reload), never while unloading; inside the
    # shift, paid, counting toward overtime. A truck-day needs none when it is back at the depot
    # for good by break_start_to_min, or when its first departure is at break_start_from_min or
    # later. 0 = no break (the default: an older web sends nothing). Settings that cannot work
    # (from after to, or a break as long as the shift) plan no break and say so in a warning,
    # never a 422 (dispatch_solver.break_rule).
    break_min: int = Field(default=0, ge=0, le=180)
    break_start_from_min: int = Field(default=720, ge=0, le=DAY_MIN)
    break_start_to_min: int = Field(default=840, ge=0, le=DAY_MIN)
    max_trips_per_truck: int = Field(default=3, ge=1, le=10)
    # Pallet fill (owner decision 4 Oct 2026): the percent of a bay truck's bays the planner may fill
    # - the safety margin of mixed pallets (12 bays at 95% = 11.4 pallets). Only trucks with bays use it.
    pallet_fill_pct: int = Field(default=95, ge=50, le=100)
    fuel_price_per_litre: float = Field(default=0.0, ge=0)  # OMR/l; 0 = fuel not costed separately
    # OMR per hour of the WHOLE truck day: first departure (or first frozen departure) to last
    # return, depot turnaround and waiting included (costing.py, policy TRUCK_DAY_SPAN). Overtime
    # (overtime_cost_per_hour, after overtime_after_min from that first departure) is on top.
    driver_cost_per_hour: float = Field(default=0.0, ge=0)
    # Strict priorities (default): one higher-priority stop always wins over ANY number of
    # lower-priority stops. False = the weighted scheme below (e.g. 11 P3 outweigh one P2).
    strict_priorities: bool = True
    # Priority -> relative value of serving one stop when strict_priorities is off. Must be
    # strictly decreasing (P1 highest); validated either way.
    priority_weights: dict[int, float] = Field(
        default_factory=lambda: {1: 10000.0, 2: 1000.0, 3: 100.0, 4: 10.0, 5: 1.0}
    )
    pref_window_penalty_per_min: float = Field(default=0.05, ge=0)  # OMR per minute outside preferred window
    # How strongly an earlier arrival is preferred, per priority (OMR per minute after shift start).
    early_preference_per_min: dict[int, float] = Field(
        default_factory=lambda: {1: 0.01, 2: 0.005, 3: 0.0, 4: 0.0, 5: 0.0}
    )
    use_margin: bool = True  # only takes effect if every stop has a margin value
    # Plan continuity on re-plans (RECOMMENDED only): OMR-equivalent cost of moving a stop to a
    # different truck than in the previous version. Below any service value, so it never costs
    # an order; it only stops one late order from reshuffling the whole unlocked plan.
    change_penalty_per_stop: float = Field(default=3.0, ge=0, le=1000)
    distance_provider: Literal["OSRM", "HAVERSINE"] = "OSRM"
    osrm_url: str | None = None
    haversine_multiplier: float = Field(default=1.3, ge=1.0, le=3.0)
    avg_speed_kmh: float = Field(default=40.0, gt=0, le=130)
    # OSRM's car profile is faster than a loaded delivery truck; road durations are scaled by
    # this factor (1.25 = trucks take 25% longer than cars). Applied to real road cells only: an
    # estimated leg (Haversine, a leg OSRM could not route, a point far from any road) already
    # uses the truck average speed.
    road_time_factor: float = Field(default=1.25, ge=1.0, le=3.0)
    time_limit_sec: int | None = Field(default=None, ge=1, le=600)  # None = auto by size
    scenarios: list[DispatchScenarioName] = Field(
        default_factory=lambda: ["RECOMMENDED", "MIN_TRUCKS", "MIN_DISTANCE"]
    )

    @model_validator(mode="after")
    def _priority_monotonic(self) -> "DispatchConfig":
        w = self.priority_weights
        missing = [p for p in range(1, 6) if p not in w]
        if missing:
            raise ValueError(f"priority_weights missing priorities {missing}")
        for p in range(1, 5):
            if not w[p] > w[p + 1]:
                raise ValueError("priority_weights must be strictly decreasing: P1 > P2 > P3 > P4 > P5")
        if w[5] <= 0:
            raise ValueError("priority_weights must be positive")
        return self

    # How long to search (owner decision 29 Sep 2026: "night plans long, day re-plans quick").
    # QUICK (default): the automatic time by day size (dispatch_solver.auto_time_limit), exactly as
    # before. THOROUGH: the whole request may take up to max_search_sec (at most the solver's own
    # THOROUGH_MAX_SEC, 1200 s = 20 min); the recommended plan's search stops early once it stops
    # improving (dispatch_solver.StallRule). Optional and additive: an older web never sends them.
    search_mode: Literal["QUICK", "THOROUGH"] = "QUICK"
    max_search_sec: int | None = Field(default=None, ge=10, le=3600)


class DispatchRequest(BaseModel):
    run_id: str
    tenant_id: str
    depot: DispatchDepot
    trucks: list[DispatchTruck]
    stops: list[DispatchStop] = Field(max_length=MAX_STOPS)
    config: DispatchConfig = Field(default_factory=DispatchConfig)

    @model_validator(mode="after")
    def _unique_ids(self) -> "DispatchRequest":
        seen: set[str] = set()
        orders: set[str] = set()
        for s in self.stops:
            if s.stop_id in seen:
                raise ValueError(f"duplicate stop_id {s.stop_id}")
            seen.add(s.stop_id)
            for o in s.order_ids:
                if o in orders:
                    raise ValueError(f"order {o} appears in more than one stop")
                orders.add(o)
        truck_ids = [t.id for t in self.trucks]
        if len(truck_ids) != len(set(truck_ids)):
            raise ValueError("duplicate truck id")
        if any(t.bays is not None for t in self.trucks):
            # Planned by pallets: every stop needs its pallet need (the web refuses first, with the
            # products that have no cases per pallet: PALLET_FACTOR_REQUIRED).
            for s in self.stops:
                if s.demand_pallet_units is None:
                    raise ValueError(f"stop {s.stop_id} has no pallet need; every stop needs demand_pallet_units "
                                     "when a truck has bays")
        return self


class PlannedStop(BaseModel):
    sequence: int
    stop_id: str
    order_ids: list[str]
    customer_id: str
    arrival_min: int
    service_start_min: int
    departure_min: int
    wait_min: int
    leg_km: float
    cum_km: float
    leg_min: int
    cases: int
    kg: float
    hard_window_ok: bool
    pref_window_ok: bool
    # The leg into this stop is an estimate (straight line x multiplier), not a road distance.
    leg_estimated: bool = False
    # The stop's pallet need in 1/1000 pallet (DispatchStop.demand_pallet_units); None when the
    # request sent none.
    pallet_units: int | None = None


class PlannedBreak(BaseModel):
    """The driver break planned with a load. DEPOT: at the depot before this load leaves (it may
    overlap the reload and loading). ROAD: after unloading stop ``after_sequence`` (0 = on the way
    to stop 1; = the number of stops: on the way back), before the next unloading."""

    start_min: int
    end_min: int
    where: Literal["DEPOT", "ROAD"]
    after_sequence: int | None = None


class PlannedLoad(BaseModel):
    """One load. Costs follow costing.py (policy TRUCK_DAY_SPAN): total_cost = fixed_cost +
    trip_cost + distance_cost + fuel_cost + driver_cost + overtime_cost, where the driver and
    overtime costs are this load's share of the whole truck day - the paid interval from the truck's
    previous return (its departure for load 1, its last frozen return for the first new load after
    frozen loads) to this load's return. fixed_cost is the truck's day cost, on load 1 only.
    The fields after return_leg_km are optional for compatibility (a solver before them sent none;
    its fixed_cost then included the trip cost and total_cost excluded turnarounds and overtime)."""

    truck_id: str
    load_no: int
    depart_min: int
    return_min: int
    distance_km: float
    duration_min: int
    cases: int
    kg: float
    # max(cases, kg) share of the binding capacity; a truck with bays: max(pallet units / (bays x
    # 1,000), kg / payload) - against the physical bays, so a load at the 95% fill limit shows 95%.
    utilization_pct: float
    fuel_litres: float | None
    fuel_cost: float
    distance_cost: float
    time_cost: float
    fixed_cost: float
    total_cost: float
    return_leg_km: float
    stops: list[PlannedStop]
    trip_cost: float | None = None
    driver_cost: float | None = None  # = time_cost (kept as an alias)
    overtime_cost: float | None = None
    driver_paid_min: int | None = None  # minutes of paid truck day this load owns
    paid_from_min: int | None = None  # where that paid interval starts
    overtime_min: int | None = None
    # Legs of this load (the return included) whose distance is an estimate, not a road distance.
    estimated_legs: int | None = None
    # The driver break planned with this load (None: none on this load). The stop after a ROAD
    # break arrives after it when the break started on the way; wait_min never counts break minutes.
    driver_break: PlannedBreak | None = None
    # Pallets (a truck with bays only; None on a truck planned by cases): the load's pallet need
    # (the sum of its stops', 1/1000 pallet) and its truck's room (bays x fill % x 10).
    pallet_units: int | None = None
    pallet_room_units: int | None = None


class UnservedStop(BaseModel):
    stop_id: str
    order_ids: list[str]
    reason_code: UnservedReason
    reason_message: str


class ObjectiveComponents(BaseModel):
    unserved_penalty: float
    fixed_cost: float
    distance_cost: float
    fuel_cost: float
    time_cost: float
    overtime_cost: float
    window_penalty: float
    margin_served: float | None
    trip_cost: float | None = None  # fixed_cost above excludes it (cost_version 2)


class TruckDayCostOut(BaseModel):
    """The new loads' part of one truck day (costing.py). With frozen loads, the day started at
    day_start_min (first frozen departure) and this part is paid from paid_from_min (last frozen
    return); the frozen loads keep the costs they were planned with. Every figure is the sum of
    the truck's loads in this scenario."""

    truck_id: str
    loads: int
    frozen_loads: int
    day_start_min: int
    paid_from_min: int
    last_return_min: int
    paid_min: int
    overtime_min: int
    fixed_cost: float
    trip_cost: float
    distance_cost: float
    fuel_cost: float
    driver_cost: float
    overtime_cost: float
    total_cost: float
    # The driver break of this truck-day (None: no break rule - an older solver, or break_min 0).
    # PLANNED: on one of its new loads; NOT_NEEDED: back for good by the end of the break window,
    # or first departure at its start or later; IN_FROZEN_LOAD: a locked or dispatched load holds
    # it; NOT_POSSIBLE: its locked or dispatched loads run through the window with none recorded.
    break_status: Literal["PLANNED", "NOT_NEEDED", "IN_FROZEN_LOAD", "NOT_POSSIBLE"] | None = None
    break_start_min: int | None = None


class BreakRule(BaseModel):
    """The driver-break rule a plan was made with (the echo; config.break_*)."""

    length_min: int
    start_from_min: int
    start_to_min: int


class PreferencePenalties(BaseModel):
    """Soft preferences in OMR-equivalent (not money): minutes outside preferred windows, the
    early-arrival push for high priorities, plan continuity on re-plans."""

    window: float = 0.0
    early: float = 0.0
    continuity: float = 0.0


FeasibilityCode = Literal[
    "UNKNOWN_TRUCK",
    "UNKNOWN_STOP",
    "LOAD_NUMBER",
    "LOAD_TOTALS",
    "CAPACITY_CASES",
    "CAPACITY_KG",
    "CAPACITY_PALLETS",
    "HARD_WINDOW",
    "TRAVEL",
    "SERVICE_TIME",
    "RETURN",
    "TURNAROUND",
    "EARLY_DEPARTURE",
    "DEPOT_CLOSE",
    "TRUCK_AVAILABILITY",
    "SHIFT_LIMIT",
    "TRIPS",
    "FROZEN_OVERLAP",
    "BREAK",
]


class FeasibilityViolation(BaseModel):
    """One hard rule a scenario's timetable breaks (feasibility.check_scenario)."""

    code: FeasibilityCode
    truck_id: str | None = None
    load_no: int | None = None
    stop_id: str | None = None
    message: str
    short_by_min: float | None = None  # how many minutes (or cases / kg for capacity) it is short


class FeasibilityReport(BaseModel):
    """Independent re-check of a scenario's timetable against the request (review F04).

    status: VERIFIED = every hard rule holds; VIOLATED = at least one does not (see violations);
    UNVERIFIED = the check itself could not run (the web treats this as not dispatchable).
    timing: EXACT = departure times were computed with the exact loading time between loads
    (load_repack.time_plan, or no loading time per case is set); ESTIMATED = the route search's
    own times, which price each turnaround for 80% of a full truck (still checked exactly here).
    """

    status: Literal["VERIFIED", "VIOLATED", "UNVERIFIED"]
    timing: Literal["EXACT", "ESTIMATED"]
    violations: list[FeasibilityViolation] = Field(default_factory=list)
    checked_at_version: int = 1
    # False when no road matrix was available to the check: drive times were not re-checked.
    travel_checked: bool = True
    note: str | None = None


class DispatchScenario(BaseModel):
    name: DispatchScenarioName
    status: Literal["OPTIMIZED", "NO_SOLUTION", "NOTHING_TO_PLAN"]
    solver_status: str
    solver_time_sec: float
    time_limit_sec: int
    objective_value: int
    objective: ObjectiveComponents
    # Physical trucks of the day with this plan: the trucks of its new loads + the trucks that carry
    # locked / loading / dispatched (frozen) loads (PR7, B3; before, the frozen loads' trucks were
    # left out, so a re-plan showed fewer trucks than the day uses).
    trucks_used: int
    trips: int  # the NEW loads this plan adds (frozen_loads are on top)
    total_distance_km: float
    total_duration_min: int
    total_cases: int
    total_kg: float
    avg_utilization_pct: float
    fuel_litres: float
    fuel_cost: float
    operating_cost: float
    loads: list[PlannedLoad]
    unserved: list[UnservedStop]
    warnings: list[str] = Field(default_factory=list)
    # Optional for compatibility: a web app older than this field ignores it, and a solver older
    # than it sends none (the web then treats the scenario as not checked by the solver).
    feasibility: FeasibilityReport | None = None
    # Cost model (review F17). Absent: a solver from before it (costs without turnarounds / overtime).
    cost_policy: str | None = None  # "TRUCK_DAY_SPAN"
    cost_version: int | None = None  # 2
    truck_days: list[TruckDayCostOut] = Field(default_factory=list)
    paid_driver_min: int | None = None
    preference_penalties: PreferencePenalties | None = None
    estimated_legs: int | None = None  # legs of the planned loads whose distance is an estimate
    # Of trucks_used, the trucks with frozen loads, and how many frozen loads the plan was made
    # around (PR7). None from a solver before them.
    frozen_trucks: int | None = None
    frozen_loads: int | None = None
    # The weight and overtime rules this plan was made with (audit A6 review), so an export states
    # only rules its plan was built with. None from a solver before them: its route search rounded
    # each stop UP to a whole kg and the payload down, and charged overtime that locked or
    # dispatched loads already work again for new loads.
    weight_unit_kg: float | None = None  # WEIGHT_UNIT_KG: every kg check in 0.1 kg units, no margin (F08)
    new_overtime_only: bool | None = None  # True: only new overtime counts when choosing a truck (E4)
    # The receiving-hours rule this plan was made with (config.window_rule, echoed on every
    # scenario). None from a solver before it: unloading only had to START by closing.
    window_rule: Literal["START", "FINISH"] | None = None
    # The driver-break rule this plan was made with; None = no break was planned (a solver before
    # the rule, break_min 0, or settings that cannot work - see the warnings).
    break_rule: BreakRule | None = None
    # The absolute latest return this plan was made with (config.latest_return_min, echoed); None =
    # none (a solver before it, or an older web that sent none).
    latest_return_min: int | None = None
    # The pallet rule this plan was made with (echoed when a truck of the request has bays): every
    # bay truck was checked by pallets in units of pallet_unit (0.001) at pallet_fill_pct; None = no
    # bay truck in the request (or a solver before the rule). The web marks loads as planned by
    # pallets ONLY from this echo. total_pallet_units: the sum over the bay trucks' loads.
    pallet_unit: float | None = None
    pallet_fill_pct: int | None = None
    total_pallet_units: int | None = None


class DispatchResponse(BaseModel):
    run_id: str
    engine: str
    matrix_provider: str
    # True only when every leg is an estimate (distance_quality ESTIMATED); per load see
    # PlannedLoad.estimated_legs (review F18).
    distance_is_estimated: bool
    # ROAD: every leg a road distance; MIXED: some legs estimated; ESTIMATED: all estimated.
    distance_quality: Literal["ROAD", "MIXED", "ESTIMATED"] | None = None
    scenarios: list[DispatchScenario]
    warnings: list[str] = Field(default_factory=list)
    # How the recommended plan was searched (QUICK / THOROUGH). None from a solver before it.
    search: SearchReport | None = None


class SearchReport(BaseModel):
    """How long the recommended plan was searched and why the search stopped (owner request 29 Sep
    2026). Never a claim of optimality: GUIDED_LOCAL_SEARCH proves no bound, so no gap is given.

    stop_reason: TIME_LIMIT = QUICK, the automatic time by day size; CONVERGED = THOROUGH, stopped
    once it had not improved for stall_sec (or the search ended by itself); CAP = THOROUGH, the
    time limit (cap_sec for the whole request) was reached while it was still improving; STOPPED =
    a supervisor asked for the best plan found so far. Either mode: NOT_SEARCHED = no search ran
    (every stop was left out before it: RECOMMENDED is NOTHING_TO_PLAN); NO_PLAN = the search ended
    without any plan (RECOMMENDED is NO_SOLUTION)."""

    mode: Literal["QUICK", "THOROUGH"]
    # The whole request's time budget: THOROUGH its cap; QUICK the solver's request budget.
    cap_sec: int
    # The recommended plan's search time limit (seconds).
    limit_sec: int
    # The recommended plan's search, and the whole request (road matrix, searches, load re-check).
    search_sec: float
    used_sec: float
    stop_reason: Literal["TIME_LIMIT", "CONVERGED", "CAP", "STOPPED", "NOT_SEARCHED", "NO_PLAN"]
    # THOROUGH: when the best plan was last improved (seconds into the search), and the stall that
    # stops the search at that moment of the search.
    last_improvement_sec: float | None = None
    stall_sec: float | None = None
    # THOROUGH: at most 12 (seconds into the search, search objective, stops not planned yet) points of
    # the best plan found so far. The search objective is the route search's own score, not money: its
    # cost and preferences plus a large penalty (1,000 OMR or more on real days) for each stop not planned yet, before
    # the final load re-check. Reports from before the count have two values per point.
    best_over_time: list[tuple[float, float, int] | tuple[float, float]] = Field(default_factory=list)
    solutions: int | None = None
    # The second route search (PyVRP), when this solver has it (pyvrp_candidate.py). None from a
    # solver before it.
    pyvrp: "PyvrpReport | None" = None


class PyvrpReport(BaseModel):
    """What the second route search (PyVRP) did in this solve. Its plan is one more candidate of the
    load re-check, judged by the engine's own checks, timing and cost score.

    status: CHOSEN = its plan (re-checked) is used by the options in ``chosen_for``; NOT_CHOSEN = it
    ran, and the engine's own plans were as good or better (or its plan was unusable: ``reason``);
    SKIPPED = not run (OFF, CPU_GATE, NOTHING_TO_PLAN, NO_PROCESS, MODEL_TOO_LARGE); FAILED = it
    failed (IMPORT_FAILED, FAILED, LOST, TIMEOUT). The plans are then the engine's alone.
    best_over_time: at most 12 [seconds, PyVRP's score] points - a score, not money (it holds the
    prize of every stop not planned yet)."""

    status: Literal["CHOSEN", "NOT_CHOSEN", "SKIPPED", "FAILED"]
    reason: str | None = None
    version: str | None = None
    seed: int | None = None
    penalty_mode: str | None = None
    search_sec: float | None = None
    iterations: int | None = None
    # SEARCH_END (told to stop when the engine's searches ended), CONVERGED, CAP, STOPPED,
    # ITERATIONS (tests), MAX_RUNTIME (the backstop).
    stop_reason: str | None = None
    last_improvement_sec: float | None = None
    feasible: bool | None = None
    routes: int | None = None
    loads: int | None = None
    missing: int | None = None
    chosen_for: list[str] = Field(default_factory=list)
    best_over_time: list[tuple[float, float]] = Field(default_factory=list)


SearchReport.model_rebuild()
DispatchResponse.model_rebuild()


class GeometryRequest(BaseModel):
    coords: list[tuple[float, float]] = Field(min_length=2, max_length=200)  # (lat, lng)
    osrm_url: str | None = None


class GeometryResponse(BaseModel):
    provider: str
    is_estimated: bool
    coordinates: list[list[float]]  # [lng, lat]
    warning: str | None = None
