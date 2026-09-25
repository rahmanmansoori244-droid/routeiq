"""Wire contract for ``POST /optimize-dispatch`` (NMWC daily dispatch planning).

Mirrors ``packages/shared-types/src/dispatch.ts`` field-for-field. All times are MINUTES FROM
MIDNIGHT of the delivery day (06:30 -> 390). Money is OMR. Distances in the response are km.
"""
from __future__ import annotations

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


class DispatchDepot(BaseModel):
    id: str
    lat: float = Field(ge=-90, le=90)
    lng: float = Field(ge=-180, le=180)
    open_min: int = Field(default=0, ge=0, le=DAY_MIN)
    close_min: int = Field(default=DAY_MIN, ge=0, le=DAY_MIN)


class FrozenTrip(BaseModel):
    """A load that is LOCKED / LOADING / DISPATCHED. The solver never touches it - it only
    blocks that truck's time so new trips start after it returns."""

    load_no: int = Field(ge=1)
    depart_min: int = Field(ge=0, le=DAY_MIN * 2)
    return_min: int = Field(ge=0, le=DAY_MIN * 2)
    cases: int = 0


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
    overtime_after_min: int | None = Field(default=9 * 60, ge=0, le=DAY_MIN)  # soft, per truck day
    overtime_cost_per_hour: float = Field(default=4.0, ge=0)
    reload_min: int = Field(default=30, ge=0, le=240)  # depot turnaround between loads
    # Loading time on top of reload_min, per case of the NEXT load (0.04 -> 1,100 cases = 44 min).
    loading_min_per_case: float = Field(default=0.0, ge=0, le=1)
    max_trips_per_truck: int = Field(default=3, ge=1, le=10)
    fuel_price_per_litre: float = Field(default=0.0, ge=0)  # OMR/l; 0 = fuel not costed separately
    driver_cost_per_hour: float = Field(default=0.0, ge=0)  # OMR/h of on-road time
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
    # this factor (1.25 = trucks take 25% longer than cars). Not applied to Haversine, which
    # already uses the truck average speed.
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


class DispatchRequest(BaseModel):
    run_id: str
    tenant_id: str
    depot: DispatchDepot
    trucks: list[DispatchTruck]
    stops: list[DispatchStop]
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


class PlannedLoad(BaseModel):
    truck_id: str
    load_no: int
    depart_min: int
    return_min: int
    distance_km: float
    duration_min: int
    cases: int
    kg: float
    utilization_pct: float  # max(cases, kg) share of the binding capacity
    fuel_litres: float | None
    fuel_cost: float
    distance_cost: float
    time_cost: float
    fixed_cost: float
    total_cost: float
    return_leg_km: float
    stops: list[PlannedStop]


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


class DispatchScenario(BaseModel):
    name: DispatchScenarioName
    status: Literal["OPTIMIZED", "NO_SOLUTION", "NOTHING_TO_PLAN"]
    solver_status: str
    solver_time_sec: float
    time_limit_sec: int
    objective_value: int
    objective: ObjectiveComponents
    trucks_used: int
    trips: int
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


class DispatchResponse(BaseModel):
    run_id: str
    engine: str
    matrix_provider: str
    distance_is_estimated: bool
    scenarios: list[DispatchScenario]
    warnings: list[str] = Field(default_factory=list)


class GeometryRequest(BaseModel):
    coords: list[tuple[float, float]] = Field(min_length=2, max_length=200)  # (lat, lng)
    osrm_url: str | None = None


class GeometryResponse(BaseModel):
    provider: str
    is_estimated: bool
    coordinates: list[list[float]]  # [lng, lat]
    warning: str | None = None
