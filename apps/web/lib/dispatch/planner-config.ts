/**
 * The dispatch planner's settings as the optimizer gets them (review F21): ONE pure function turns
 * the tenant settings into the request's config (buildDispatchRequest), and the same code feeds the
 * read-only "Effective planner values" panel on Settings, so what the page shows is what plans use.
 *
 * Pure: no database, shared by the server and the Settings page.
 */
import type { DispatchConfig, DispatchScenarioName } from '@routeiq/shared-types';
import { autoTimeLimitSec, CONFIG_BOUNDS, LARGE_DAY_STOPS, MAX_DISPATCH_STOPS, outOfBounds, SEARCH_TIME_SCHEDULE, type ConfigBoundKey } from '../planner-bounds';
import { parsePriorityWeights, routingProviderFor } from './customer-attrs';
import { fmtHhmm } from './time';

/** The TenantConfig fields the planner reads (a Prisma TenantConfig row satisfies it). */
export interface TenantPlannerConfig {
  shiftStartMin: number;
  driverShiftMaxMinutes: number;
  overtimeAfterMin: number;
  overtimeCostPerHour: number;
  reloadMinutes: number;
  loadingMinPerCase: number;
  serviceMinPerCase: number;
  maxTripsPerTruck: number;
  splitDeliveries: boolean;
  defaultServiceTimeMin: number;
  fuelPricePerLitre: number;
  driverCostPerHour: number;
  prefWindowPenaltyPerMin: number;
  priorityWeightsJson: unknown;
  distanceProvider: string;
  osrmUrl: string | null;
  distanceMultiplier: number;
  avgSpeedKmh: number;
  roadTimeFactor: number;
  timezone: string;
  planningCutoffMin: number;
  dateOrder: string;
  serviceAreaJson?: unknown;
}

/**
 * The optimizer's constants no tenant setting changes (apps/solver/dispatch_models.py defaults),
 * listed on the Settings page so nothing that shapes a plan is hidden.
 */
export const PLANNER_CONSTANTS = {
  earlyPreferencePerMin: { 1: 0.01, 2: 0.005 } as Record<number, number>,
  changePenaltyPerStop: 3,
  // The automatic search time: SEARCH_TIME_SCHEDULE / autoTimeLimitSec (lib/planner-bounds.ts),
  // checked against the optimizer's schedule (PR7).
  matrixBudgetSec: 90,
} as const;

/** A 200-stop day: the size whose search time PR7 (T1) fixed, named on the Settings page. */
const SEARCH_TIME_EXAMPLE_STOPS = 200;

/**
 * The Settings page's "Search time" row, from the schedule the optimizer uses (PR7, T1): "5 s up
 * to 25 stops, 20 s up to 120, rising steadily to 50 s at 150 and 150 s at 200, 150 s up to 350,
 * 240 s above".
 */
export function searchTimeText(): string {
  const s = SEARCH_TIME_SCHEDULE;
  const [first, ...rest] = s.points;
  const last = s.points[s.points.length - 1];
  const marks = [...new Set([...rest.map(([n]) => n), SEARCH_TIME_EXAMPLE_STOPS])].filter((n) => n > first[0] && n <= last[0]).sort((a, b) => a - b);
  const at = marks.map((n) => `${autoTimeLimitSec(n)} s at ${n}`);
  const rising = at.length > 1 ? `${at.slice(0, -1).join(', ')} and ${at[at.length - 1]}` : at.join('');
  return (
    `${s.smallDaySec} s up to ${s.smallDayStops} stops, ${first[1]} s up to ${first[0]}` +
    (rising ? `, rising steadily to ${rising}` : '') +
    `, ${last[1]} s up to ${LARGE_DAY_STOPS}, ${s.largeDaySec} s above`
  );
}

/** Setting names as the Settings page shows them (also used in error messages). */
export const SETTING_LABELS: Record<ConfigBoundKey, string> = {
  shiftStartMin: 'First departure',
  driverShiftMaxMinutes: 'Driver shift maximum',
  overtimeAfterMin: 'Overtime after',
  overtimeCostPerHour: 'Overtime cost per hour',
  reloadMinutes: 'Turnaround between loads',
  loadingMinPerCase: 'Loading minutes per case',
  maxTripsPerTruck: 'Max loads per truck per day',
  fuelPricePerLitre: 'Fuel price per litre',
  driverCostPerHour: 'Driver cost per hour',
  prefWindowPenaltyPerMin: 'Preferred-window penalty per minute',
  distanceMultiplier: 'Straight-line distance multiplier',
  avgSpeedKmh: 'Average speed for estimates',
  roadTimeFactor: 'Road time factor (truck vs car)',
  defaultServiceTimeMin: 'Default service time',
  serviceMinPerCase: 'Unloading minutes per case',
  planningCutoffMin: 'Planning cutoff',
};

/**
 * Settings outside what the planner accepts - only possible through a direct database edit, since
 * the Settings API enforces the same bounds. An optimization is refused with these (`blocking`)
 * instead of failing inside the optimizer with a 422 (review F21). `warnings`: accepted but
 * probably not meant (an overtime threshold after the shift maximum never applies).
 */
export function plannerSettingProblems(cfg: TenantPlannerConfig): { blocking: string[]; warnings: string[] } {
  const blocking = outOfBounds(CONFIG_BOUNDS, cfg as unknown as Partial<Record<ConfigBoundKey, number>>, (k) => SETTING_LABELS[k]);
  const warnings: string[] = [];
  if (cfg.overtimeAfterMin > cfg.driverShiftMaxMinutes && cfg.overtimeCostPerHour > 0) {
    warnings.push(
      `${SETTING_LABELS.overtimeAfterMin} (${fmtHhmm(cfg.overtimeAfterMin)} h) is after the ${SETTING_LABELS.driverShiftMaxMinutes.toLowerCase()} (${fmtHhmm(cfg.driverShiftMaxMinutes)} h), so overtime is never costed. Check Settings.`,
    );
  }
  return { blocking, warnings };
}

interface TruckRow {
  code: string;
  capacityCases: number;
  capacityWeightKg: number;
  fixedCostPerDay: number;
  tripCost: number;
  costPerKm: number;
  kmPerLitre: number | null;
  availableFromMin: number | null;
  availableToMin: number | null;
  maxTripsPerDay: number | null;
}

/**
 * Truck and depot values the optimizer's contract refuses (apps/solver/dispatch_models.py) -
 * possible only through a direct database edit, since the Trucks and Depots forms keep narrower
 * bounds. Refused before the optimizer with the truck named, instead of a 422 for the whole day.
 */
export function masterDataProblems(trucks: TruckRow[], depot: { openMin: number | null; closeMin: number | null }): string[] {
  const out: string[] = [];
  const bad = (v: number | null, lo: number, hi: number, opts: { int?: boolean; open?: boolean } = {}) =>
    v !== null && (!Number.isFinite(v) || (opts.open ? v <= lo : v < lo) || v > hi || (opts.int && !Number.isInteger(v)));
  for (const t of trucks) {
    const p: string[] = [];
    if (bad(t.capacityCases, 0, Number.MAX_SAFE_INTEGER, { int: true })) p.push(`capacity ${t.capacityCases} cases`);
    if (bad(t.capacityWeightKg, 0, Number.MAX_VALUE)) p.push(`payload ${t.capacityWeightKg} kg`);
    if (bad(t.fixedCostPerDay, 0, Number.MAX_VALUE) || bad(t.tripCost, 0, Number.MAX_VALUE) || bad(t.costPerKm, 0, Number.MAX_VALUE)) p.push('a negative cost');
    if (bad(t.kmPerLitre, 0, Number.MAX_VALUE, { open: true })) p.push(`km per litre ${t.kmPerLitre} (must be above 0, or empty)`);
    if (bad(t.maxTripsPerDay, 1, 10, { int: true })) p.push(`max loads ${t.maxTripsPerDay} (1-10)`);
    if (bad(t.availableFromMin, 0, 1440, { int: true }) || bad(t.availableToMin, 0, 2880, { int: true })) p.push('availability outside the day');
    if (p.length) out.push(`Truck ${t.code}: ${p.join(', ')}`);
  }
  if (bad(depot.openMin, 0, 1440, { int: true }) || bad(depot.closeMin, 0, 1440, { int: true })) out.push('Depot hours outside 00:00-24:00');
  return out;
}

/**
 * The request's config from the tenant settings and country (the routing decision included:
 * the shared road map covers Oman + UAE only). Everything the optimizer is told about the day
 * besides trucks, depot and stops.
 */
export function dispatchConfigFromTenant(
  cfg: TenantPlannerConfig,
  country: string | null | undefined,
  scenarios: DispatchScenarioName[],
): { config: DispatchConfig; routing: { provider: 'OSRM' | 'HAVERSINE'; outsideCoverage: boolean } } {
  const routing = routingProviderFor(cfg, country);
  return {
    routing,
    config: {
      shift_start_min: cfg.shiftStartMin,
      shift_max_min: cfg.driverShiftMaxMinutes,
      overtime_after_min: cfg.overtimeAfterMin,
      overtime_cost_per_hour: cfg.overtimeCostPerHour,
      reload_min: cfg.reloadMinutes,
      loading_min_per_case: cfg.loadingMinPerCase,
      max_trips_per_truck: cfg.maxTripsPerTruck,
      fuel_price_per_litre: cfg.fuelPricePerLitre,
      driver_cost_per_hour: cfg.driverCostPerHour,
      // A higher priority always wins over any number of lower ones (weights kept for reference).
      strict_priorities: true,
      priority_weights: parsePriorityWeights(cfg.priorityWeightsJson),
      pref_window_penalty_per_min: cfg.prefWindowPenaltyPerMin,
      // Owner rule (29 Sep 2026), not a setting: unloading is finished by the end of the receiving
      // hours. Each load keeps the rule the solver REPORTS it planned with (PlanRules.windowRule).
      window_rule: 'FINISH',
      use_margin: true,
      distance_provider: routing.provider,
      osrm_url: cfg.osrmUrl ?? null,
      haversine_multiplier: cfg.distanceMultiplier,
      avg_speed_kmh: cfg.avgSpeedKmh,
      road_time_factor: cfg.roadTimeFactor,
      // Automatic by the number of stops (the old "solver time limit" setting had no effect).
      time_limit_sec: null,
      scenarios,
    },
  };
}

export type EffectiveSource = 'SETTING' | 'PLANNER' | 'OPERATIONS';

export interface EffectiveRow {
  label: string;
  value: string;
  source: EffectiveSource;
  note?: string;
}

const hm = (min: number) => `${Math.floor(min / 60)}:${String(Math.round(min % 60)).padStart(2, '0')}`;

/**
 * What the planner uses right now, row by row, with where each value comes from: a Settings field,
 * a fixed planner rule, or an operations setting only the maintainers change (timezone, the routing
 * server, the service area).
 */
export function effectivePlannerValues(cfg: TenantPlannerConfig, country: string | null | undefined, currency: string): EffectiveRow[] {
  const { routing } = dispatchConfigFromTenant(cfg, country, ['RECOMMENDED']);
  const overtimeNever = cfg.overtimeAfterMin >= cfg.driverShiftMaxMinutes;
  const rows: EffectiveRow[] = [
    {
      label: 'First departure (earliest)',
      value: fmtHhmm(cfg.shiftStartMin),
      source: 'SETTING',
      note: `a plan made on the delivery day itself starts from now + ${cfg.reloadMinutes} min (the turnaround between loads) when that is later, and each new load also waits for its loading per case from now; locked, loading and dispatched loads keep their times`,
    },
    {
      label: 'Driver shift maximum',
      value: `${hm(cfg.driverShiftMaxMinutes)} h`,
      source: 'SETTING',
      note: `first departure to last return of a truck: leaving at ${fmtHhmm(cfg.shiftStartMin)}, it is back by ${fmtHhmm(cfg.shiftStartMin + cfg.driverShiftMaxMinutes)} at the latest`,
    },
    {
      label: 'Driver cost',
      value: `${cfg.driverCostPerHour} ${currency} per hour`,
      source: 'SETTING',
      note: 'paid for the whole truck day: first departure to last return, depot turnaround and waiting included',
    },
    {
      label: 'Overtime',
      value: cfg.overtimeCostPerHour > 0 ? `after ${hm(cfg.overtimeAfterMin)} h, +${cfg.overtimeCostPerHour} ${currency} per hour` : 'not costed (0 per hour)',
      source: 'SETTING',
      note: overtimeNever && cfg.overtimeCostPerHour > 0 ? 'never reached: the threshold is at or after the shift maximum' : undefined,
    },
    {
      label: 'Turnaround between loads',
      value: `${cfg.reloadMinutes} min + ${cfg.loadingMinPerCase} min per case of the next load`,
      source: 'SETTING',
      note: `the ${cfg.reloadMinutes} min are also the preparation time of a plan made on the delivery day; there loading per case counts from now for every truck, also one standing at the depot`,
    },
    {
      label: 'Unloading time',
      value: `customer's own time (default ${cfg.defaultServiceTimeMin} min) + ${cfg.serviceMinPerCase} min per case`,
      source: 'SETTING',
      note: "a confirmed customer time wins, then its customer type, then the default; each truck visit of a split delivery gets the customer's full time plus the per-case time of its own cases",
    },
    {
      label: 'Receiving hours',
      value: 'unloading must be finished by the end of the receiving hours',
      source: 'PLANNER',
      note: 'a customer whose unloading takes longer than its receiving hours cannot be planned',
    },
    { label: 'Max loads per truck per day', value: String(cfg.maxTripsPerTruck), source: 'SETTING', note: "a truck's own limit wins" },
    { label: 'Split deliveries bigger than any truck', value: cfg.splitDeliveries ? 'yes' : 'no', source: 'SETTING' },
    { label: 'Fuel price', value: cfg.fuelPricePerLitre > 0 ? `${cfg.fuelPricePerLitre} ${currency} per litre` : '0 (fuel not costed separately)', source: 'SETTING' },
    {
      label: 'Preferred-window penalty',
      value: `${cfg.prefWindowPenaltyPerMin} ${currency} per minute outside`,
      source: 'SETTING',
      note: 'soft: per minute that unloading starts before the preferred start or finishes after the preferred end; receiving hours are never broken',
    },
    {
      label: 'Distances',
      value: routing.provider === 'OSRM' ? 'road distances (OSRM)' : 'straight-line estimates, labelled Estimated km',
      source: 'SETTING',
      note: routing.outsideCoverage ? 'the company country is outside the Oman + UAE road map, so plans use estimates' : undefined,
    },
    { label: 'Road time factor', value: `x${cfg.roadTimeFactor} on road travel times`, source: 'SETTING', note: 'trucks are slower than the cars OSRM times; not applied to estimates' },
    { label: 'Estimates', value: `straight line x${cfg.distanceMultiplier} at ${cfg.avgSpeedKmh} km/h`, source: 'SETTING' },
    { label: 'Planning cutoff', value: `${fmtHhmm(cfg.planningCutoffMin)} the day before delivery`, source: 'SETTING', note: 'orders received later are LATE' },
    { label: 'Dates in order files', value: cfg.dateOrder === 'MDY' ? 'month/day/year' : 'day/month/year', source: 'SETTING' },
    { label: 'Timezone', value: cfg.timezone, source: 'OPERATIONS' },
    { label: 'Road routing server', value: cfg.osrmUrl ? 'company server set' : "the planner's own (Oman + UAE map)", source: 'OPERATIONS' },
    { label: 'Service area check', value: cfg.serviceAreaJson ? 'company box' : 'Oman + UAE (or none outside them)', source: 'OPERATIONS' },
    { label: 'Priorities', value: 'strict: P1 always wins over any number of lower priorities', source: 'PLANNER' },
    {
      label: 'Early arrival preference',
      value: Object.entries(PLANNER_CONSTANTS.earlyPreferencePerMin).map(([p, v]) => `P${p} ${v}`).join(', ') + ` ${currency} per minute after first departure`,
      source: 'PLANNER',
    },
    { label: 'Keep late-order re-plans steady', value: `${PLANNER_CONSTANTS.changePenaltyPerStop} ${currency} per stop moved to another truck`, source: 'PLANNER' },
    {
      label: 'Search time',
      value: searchTimeText(),
      source: 'PLANNER',
      note: 'automatic by the size of the day, for the recommended plan; the alternatives, started from it, get half',
    },
    {
      label: 'Largest day',
      value: `${MAX_DISPATCH_STOPS} stops per optimization (a warning above ${LARGE_DAY_STOPS})`,
      source: 'PLANNER',
    },
    { label: 'Road routing time', value: `at most ${PLANNER_CONSTANTS.matrixBudgetSec} s, then estimates (labelled)`, source: 'PLANNER' },
  ];
  return rows;
}
