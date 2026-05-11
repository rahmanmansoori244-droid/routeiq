"""Pydantic request/response models for the solver service.

The shapes here MUST match `packages/shared-types/src/index.ts` field-for-field.
Any change here that touches the wire format requires a parallel TS update.
"""
from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field

DistanceProvider = Literal["HAVERSINE", "MAPBOX_MATRIX"]
ScenarioName = Literal["MIN_TRUCKS", "MIN_DISTANCE", "BALANCED"]

UnservedReasonCode = Literal[
    "MISSING_COORDINATES",
    "EXCEEDS_TRUCK_CAPACITY",
    "NO_AVAILABLE_TRUCK",
    "SHIFT_TIME_LIMIT",
    "INVALID_CUSTOMER",
    "SOLVER_DROPPED_LOW_PRIORITY",
    "INFEASIBLE_ROUTE",
    "UNKNOWN",
]


class Depot(BaseModel):
    id: str
    lat: float
    lng: float


class Truck(BaseModel):
    id: str
    capacity_cases: int
    capacity_weight_kg: float = 0.0
    fixed_cost_per_day: float = 0.0
    cost_per_km: float = 0.0


class Stop(BaseModel):
    order_id: str
    customer_id: str
    lat: float
    lng: float
    demand_cases: int
    demand_weight_kg: float = 0.0
    service_time_min: int = 10
    priority: int = Field(default=3, ge=1, le=5)


class SolverConfig(BaseModel):
    avg_speed_kmh: float = 40.0
    distance_provider: DistanceProvider = "HAVERSINE"
    distance_multiplier: float = 1.30
    driver_shift_max_min: int = 540
    return_to_depot: bool = True
    solver_time_limit_sec: int = 30
    scenarios_requested: list[ScenarioName] = Field(
        default_factory=lambda: ["MIN_TRUCKS", "MIN_DISTANCE", "BALANCED"],
    )
    # Optional per-tenant weight overrides for BALANCED.
    weight_objective_trucks: float | None = None
    weight_objective_distance: float | None = None
    weight_objective_utilization: float | None = None
    # When true, re-weight BALANCED to maximize utilization (see CLAUDE.md §7).
    max_utilization_mode: bool = False


class OptimizeRequest(BaseModel):
    run_id: str
    tenant_id: str
    depot: Depot
    trucks: list[Truck]
    stops: list[Stop]
    config: SolverConfig


class UnservedOrder(BaseModel):
    order_id: str
    reason_code: UnservedReasonCode
    reason_message: str | None = None


class RouteStop(BaseModel):
    sequence: int
    order_id: str
    customer_id: str
    planned_arrival_min: int
    planned_distance_from_prev_km: float
    planned_load_cases: int


class Route(BaseModel):
    truck_id: str
    stops: list[RouteStop]
    total_distance_km: float
    total_time_min: int
    load_cases: int
    utilization_pct: float


class Scenario(BaseModel):
    name: ScenarioName
    trucks_used: int
    total_distance_km: float
    total_time_min: int
    total_cost: float
    avg_utilization_pct: float
    distance_provider: DistanceProvider
    distance_is_estimated: bool
    unserved_orders: list[UnservedOrder]
    routes: list[Route]


class OptimizeResponse(BaseModel):
    run_id: str
    scenarios: list[Scenario]
    warnings: list[str] = Field(default_factory=list)
