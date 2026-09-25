/**
 * The dispatch feasibility gate (review F04, part B). Pure: no database access here - the plan
 * service loads the rows (loadFeasibilityInput in plan-service.ts) and stores the result in
 * RunPlan.feasibilityJson.
 *
 * Checked per TRUCK-DAY over every load of the plan version, frozen copies included, from the
 * plan's own facts - the load and stop snapshots and the optimizer inputs - never from today's
 * master data:
 * - cases per load (from its stops) vs the truck's capacity;
 * - physical kg per load (a split portion's own kg, else the order's) vs the payload, with one
 *   rounding tolerance (KG_ROUNDING_TOL); cases PLANNED at 0 kg (no weight when the plan was
 *   made, read from the plan's rows) are reported as KG_UNKNOWN (a warning: the dispatcher
 *   accepted them explicitly at optimize, review F02) - unless a case weight entered since shows
 *   the load is over its payload, which blocks like any overload (CAPACITY_KG_NEW_WEIGHT);
 * - service starts inside the hard receiving window, and the stored "within hours" flag;
 * - turnaround: each load leaves after the previous load's return + reload + loading time per
 *   case x its cases (the rules the later load was planned with);
 * - the truck day: first departure after shift start / depot opening / truck availability,
 *   returns before the depot closes / availability ends, first departure -> last return within
 *   the shift maximum, loads per day;
 * - and the solver's own report for the option in use (apps/solver/feasibility.py): VIOLATED
 *   blocks its trucks; a missing report (an option from before the report existed, or a solver
 *   older than the web) is UNKNOWN - such a plan is blocked only on a concrete violation found
 *   here ("LEGACY_STRUCTURAL_ONLY").
 * Times are whole minutes with a 1-minute tolerance (the solver rounds seconds to minutes).
 *
 * A problem on a load that has already left (DISPATCHED / COMPLETED) is history: it is reported
 * as a warning, never blocks, so it can never lock the truck's later loads for good. A turnaround
 * problem belongs to the LATER load (the one that leaves too early), which a re-plan can move.
 * A problem on a LOCKED or LOADING load is flagged `frozen`: a re-plan carries that load over
 * unchanged, so the remedy is to put it back to Planned first (timingRemedy, feasibility-view.ts).
 * A truck whose capacity or payload was lowered since planning, below what a load not yet out
 * carries, is a warning (CAPACITY_CHANGED): the load keeps the truck it was planned with.
 *
 * LOCK, LOADING and DISPATCH of a load are refused while its truck-day is not OK
 * (plan-service.changeStatusTx), unless the operator switch FEASIBILITY_GATE=warn is set.
 */
import { createHash } from 'node:crypto';
import type { FeasibilityReport } from '@routeiq/shared-types';
import { usableWindow, type PlanRules } from './snapshots';
import { KG_ROUNDING_TOL } from './weights';

export const FEASIBILITY_VERSION = 1;
export const TOL_MIN = 1;
const KG_TOL = KG_ROUNDING_TOL;

export type WebViolationCode =
  | 'CAPACITY_CASES'
  | 'CAPACITY_KG'
  | 'CAPACITY_KG_NEW_WEIGHT'
  | 'KG_UNKNOWN'
  | 'HARD_WINDOW'
  | 'STOP_TIMES'
  | 'TURNAROUND'
  | 'EARLY_DEPARTURE'
  | 'DEPOT_CLOSE'
  | 'TRUCK_AVAILABILITY'
  | 'SHIFT_LIMIT'
  | 'TRIPS'
  | 'CAPACITY_CHANGED'
  | 'SOLVER';

export interface PlanViolation {
  code: WebViolationCode | string;
  /** BLOCK: LOCK / LOADING / DISPATCH refused for the truck. WARN: shown, not blocking. */
  severity: 'BLOCK' | 'WARN';
  source: 'WEB' | 'SOLVER';
  truckId: string | null;
  truckCode: string | null;
  loadId: string | null;
  loadNo: number | null;
  message: string;
  shortBy?: number | null;
  /** On a LOCKED or LOADING load: a re-plan keeps it as it is, so it must be put back to Planned first. */
  frozen?: boolean;
}

export type TruckTiming = 'VERIFIED' | 'VIOLATED' | 'UNVERIFIED' | 'STRUCTURAL_ONLY';

export interface PlanFeasibility {
  v: number;
  /** No truck-day is blocked. */
  ok: boolean;
  status: TruckTiming;
  /** SOLVER_AND_WEB: the solver checked the option in use too. LEGACY_STRUCTURAL_ONLY: no solver
   * report (an older option or solver) - blocked only on a concrete violation found here. */
  source: 'SOLVER_AND_WEB' | 'LEGACY_STRUCTURAL_ONLY';
  solverStatus: 'VERIFIED' | 'VIOLATED' | 'UNVERIFIED' | 'UNKNOWN';
  solverTiming: 'EXACT' | 'ESTIMATED' | null;
  trucks: Record<string, { truckCode: string; status: TruckTiming; ok: boolean; blocking: number; warnings: number }>;
  violations: PlanViolation[];
  inputHash: string;
  checkedAt: string;
}

export interface FeasStop {
  orderId: string;
  sequence: number;
  label: string;
  cases: number;
  kg: number;
  /** Some of these cases were planned with no weight (counted as 0 kg in `kg`). */
  kgUnknown: boolean;
  /** What the cases planned at 0 kg weigh at the product's case weight now (0 / absent: still no weight). */
  unknownKgNow?: number;
  etaMin: number | null;
  serviceStartMin: number | null;
  departureMin: number | null;
  hardWindowOk: boolean | null;
  /** The receiving window the stop was planned with (snapshot); undefined = not known. */
  hardStartMin?: number | null;
  hardEndMin?: number | null;
}

export interface FeasLoad {
  id: string;
  truckId: string;
  truckCode: string;
  loadNo: number;
  /** DISPATCHED / COMPLETED: its problems are history (warnings, never blocking). */
  onRoad: boolean;
  /** LOCKED / LOADING: a re-plan carries it over unchanged (its violations are flagged `frozen`). */
  frozen?: boolean;
  departMin: number;
  returnMin: number;
  cases: number;
  weightKg: number;
  /** The truck the load was planned on (snapshot, else the optimizer request); null = not known. */
  capacity: { cases: number; kg: number } | null;
  /** The truck's capacity in the master now (only for the CAPACITY_CHANGED warning); absent = not known. */
  capacityNow?: { cases: number; kg: number } | null;
  /** The rules the load was timed with; null = not known (no turnaround / shift check). */
  rules: PlanRules | null;
  stops: FeasStop[];
}

export interface FeasibilityInput {
  scenarioId: string | null;
  /** The solver's report for the option in use; undefined / null = none sent (UNKNOWN). */
  solver: FeasibilityReport | null | undefined;
  loads: FeasLoad[];
}

const hhmm = (m: number) => {
  const r = Math.round(m);
  return `${String(Math.floor(r / 60) % 24).padStart(2, '0')}:${String(((r % 60) + 60) % 60).padStart(2, '0')}${r >= 1440 ? '+1' : ''}`;
};
const r1 = (x: number) => Math.round(x * 10) / 10;

export function inputHash(input: FeasibilityInput): string {
  const loads = [...input.loads]
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((l) => [
      l.id, l.truckId, l.loadNo, l.onRoad, l.departMin, l.returnMin, l.cases, r1(l.weightKg), l.capacity?.cases ?? null, l.capacity?.kg ?? null,
      l.capacityNow?.cases ?? null, l.capacityNow?.kg ?? null,
      l.rules ? [l.rules.shiftStartMin, l.rules.shiftMaxMin, l.rules.reloadMin, l.rules.loadingMinPerCase, l.rules.maxTrips, l.rules.depotOpenMin, l.rules.depotCloseMin, l.rules.availableFromMin, l.rules.availableToMin] : null,
      [...l.stops]
        .sort((a, b) => a.sequence - b.sequence || a.orderId.localeCompare(b.orderId))
        .map((s) => [s.orderId, s.sequence, s.cases, r1(s.kg), s.kgUnknown, r1(s.unknownKgNow ?? 0), s.etaMin, s.serviceStartMin, s.departureMin, s.hardWindowOk, s.hardStartMin ?? null, s.hardEndMin ?? null]),
    ]);
  const solver = input.solver ? [input.solver.status, input.solver.timing, input.solver.violations.map((v) => [v.code, v.truck_id ?? null, v.load_no ?? null])] : null;
  return createHash('sha256').update(JSON.stringify({ v: FEASIBILITY_VERSION, s: input.scenarioId, solver, loads })).digest('hex');
}

/** The timetable check of one plan version (see the top of this file). */
export function checkPlanFeasibility(input: FeasibilityInput, now: Date = new Date()): PlanFeasibility {
  const out: PlanViolation[] = [];
  const byTruck = new Map<string, FeasLoad[]>();
  for (const l of input.loads) byTruck.set(l.truckId, [...(byTruck.get(l.truckId) ?? []), l]);
  const codeOf = new Map(input.loads.map((l) => [l.truckId, l.truckCode]));
  const onRoad = new Set(input.loads.filter((l) => l.onRoad).map((l) => l.id));
  const frozen = new Set(input.loads.filter((l) => l.frozen && !l.onRoad).map((l) => l.id));
  const history = ' (the load has already left: shown for the record, it does not block)';
  const frozenMark = (loadId: string | null) => (loadId && frozen.has(loadId) ? { frozen: true } : {});
  const v = (x: Omit<PlanViolation, 'source' | 'severity'> & { severity?: PlanViolation['severity'] }) =>
    out.push(
      x.loadId && onRoad.has(x.loadId) && (x.severity ?? 'BLOCK') === 'BLOCK'
        ? { source: 'WEB', ...x, severity: 'WARN', message: x.message + history }
        : { severity: 'BLOCK', source: 'WEB', ...x, ...frozenMark(x.loadId) },
    );

  for (const [truckId, list] of byTruck) {
    const loads = [...list].sort((a, b) => a.loadNo - b.loadNo || a.departMin - b.departMin);
    const code = loads[0].truckCode;
    const at = (l: FeasLoad) => ({ truckId, truckCode: code, loadId: l.id, loadNo: l.loadNo });
    for (const l of loads) {
      const cases = l.stops.reduce((a, s) => a + s.cases, 0);
      const kg = r1(l.stops.reduce((a, s) => a + s.kg, 0));
      if (l.capacity) {
        if (cases > l.capacity.cases) {
          v({ ...at(l), code: 'CAPACITY_CASES', message: `${code} load ${l.loadNo} carries ${cases} cases; the truck takes ${l.capacity.cases}.`, shortBy: cases - l.capacity.cases });
        }
        const overPlanned = l.capacity.kg > 0 && kg > l.capacity.kg + KG_TOL;
        if (overPlanned) {
          v({ ...at(l), code: 'CAPACITY_KG', message: `${code} load ${l.loadNo} weighs ${Math.round(kg)} kg; the truck's payload is ${Math.round(l.capacity.kg)} kg.`, shortBy: r1(kg - l.capacity.kg) });
        }
        const unknown = l.stops.filter((s) => s.kgUnknown);
        if (l.capacity.kg > 0 && unknown.length) {
          // Cases planned at 0 kg whose product has a case weight now: what the load really weighs.
          const laterKg = r1(unknown.reduce((a, s) => a + (s.unknownKgNow ?? 0), 0));
          const withLater = r1(kg + laterKg);
          const names = `${unknown.map((s) => s.label).slice(0, 3).join(', ')}${unknown.length > 3 ? ', ...' : ''}`;
          if (laterKg > 0 && !overPlanned && withLater > l.capacity.kg + KG_TOL) {
            v({
              ...at(l),
              code: 'CAPACITY_KG_NEW_WEIGHT',
              message: `${code} load ${l.loadNo} was planned with cases that had no weight (counted as 0 kg: ${names}); with the case weight entered under Products since, it weighs about ${Math.round(withLater)} kg - over the truck's payload of ${Math.round(l.capacity.kg)} kg.`,
              shortBy: r1(withLater - l.capacity.kg),
            });
          } else {
            v({
              ...at(l),
              severity: 'WARN',
              code: 'KG_UNKNOWN',
              message:
                `${code} load ${l.loadNo}: ${unknown.length} stop(s) have cases planned with no weight (counted as 0 kg: ${names}), so the payload of ${Math.round(l.capacity.kg)} kg is not fully checked.` +
                (laterKg > 0 ? ` With the case weight entered under Products since, the load weighs about ${Math.round(withLater)} kg.` : ''),
            });
          }
        }
      }
      // The truck was corrected in the master after planning and the load (not out yet) no longer
      // fits it: the load keeps the truck it was planned with, so this is shown, not blocked.
      const now = l.capacityNow;
      if (now && !l.onRoad && l.capacity && (now.cases !== l.capacity.cases || Math.abs(now.kg - l.capacity.kg) > 0.05)) {
        const overCases = now.cases > 0 && cases > now.cases;
        const overKg = now.kg > 0 && kg > now.kg + KG_TOL;
        if (overCases || overKg) {
          v({
            ...at(l),
            severity: 'WARN',
            code: 'CAPACITY_CHANGED',
            message:
              `${code} load ${l.loadNo} carries ${cases} cases / ${Math.round(kg)} kg, but the truck was changed to ${now.cases} cases / ${now.kg > 0 ? `${Math.round(now.kg)} kg` : 'no payload set'} after planning (planned with ${l.capacity.cases} cases / ${l.capacity.kg > 0 ? `${Math.round(l.capacity.kg)} kg` : 'no payload set'}). ` +
              (l.frozen ? 'Put the load back to Planned and re-plan to use the new capacity.' : 'Re-plan to use the new capacity.'),
          });
        }
      }
      for (const s of l.stops) {
        const start = s.serviceStartMin;
        // A window planned inverted (end before start) was sent as "any time" (usableWindow).
        const planned = s.hardStartMin === undefined && s.hardEndMin === undefined ? null : usableWindow(s.hardStartMin ?? null, s.hardEndMin ?? null);
        const hs = planned ? planned.start : undefined;
        const he = planned ? planned.end : undefined;
        const outside =
          s.hardWindowOk === false ||
          (start !== null && ((hs !== undefined && hs !== null && start < hs) || (he !== undefined && he !== null && start > he)));
        if (outside) {
          const w = hs !== undefined || he !== undefined ? ` ${hs === null || hs === undefined ? '--:--' : hhmm(hs)}-${he === null || he === undefined ? '--:--' : hhmm(he)}` : '';
          v({ ...at(l), code: 'HARD_WINDOW', message: `${code} load ${l.loadNo}: ${s.label} is served at ${start === null ? '--:--' : hhmm(start)}, outside its receiving hours${w}.` });
        }
        if (start !== null && s.departureMin !== null && s.departureMin < start) {
          v({ ...at(l), code: 'STOP_TIMES', message: `${code} load ${l.loadNo}: ${s.label} leaves (${hhmm(s.departureMin)}) before it is served (${hhmm(start)}).` });
        }
        if (start !== null && s.etaMin !== null && start < s.etaMin - TOL_MIN) {
          v({ ...at(l), code: 'STOP_TIMES', message: `${code} load ${l.loadNo}: ${s.label} is served (${hhmm(start)}) before the truck arrives (${hhmm(s.etaMin)}).` });
        }
      }
      if (l.returnMin < l.departMin) {
        v({ ...at(l), code: 'STOP_TIMES', message: `${code} load ${l.loadNo} is back (${hhmm(l.returnMin)}) before it leaves (${hhmm(l.departMin)}).` });
      }
    }
    // The truck day, with the rules of the loads (the later load's rules for its turnaround).
    for (let i = 1; i < loads.length; i++) {
      const a = loads[i - 1];
      const b = loads[i];
      if (!b.rules) {
        if (b.departMin < a.returnMin - TOL_MIN) {
          v({ ...at(b), code: 'TURNAROUND', message: `${code} load ${b.loadNo} leaves at ${hhmm(b.departMin)}, before load ${a.loadNo} is back (${hhmm(a.returnMin)}).`, shortBy: a.returnMin - b.departMin });
        }
        continue;
      }
      const need = b.rules.reloadMin + b.rules.loadingMinPerCase * b.cases;
      const ready = a.returnMin + need;
      if (b.departMin < ready - TOL_MIN) {
        v({
          ...at(b),
          code: 'TURNAROUND',
          message: `${code} load ${b.loadNo} leaves at ${hhmm(b.departMin)}, but after load ${a.loadNo} (back ${hhmm(a.returnMin)}) the truck needs ${r1(need)} min to reload and load ${b.cases} cases: ready ${hhmm(ready)}.`,
          shortBy: r1(ready - b.departMin),
        });
      }
    }
    // Each load against the rules IT was planned with (a carried load may predate a settings
    // change); the day as a whole (span, loads per day) against the latest load's rules, which
    // were planned around every earlier load.
    const first = loads[0];
    if (first.rules) {
      const r = first.rules;
      const earliest = Math.max(r.shiftStartMin, r.depotOpenMin, r.availableFromMin ?? 0);
      if (first.departMin < earliest - TOL_MIN) {
        const why = earliest === r.shiftStartMin ? 'the shift start' : earliest === r.depotOpenMin ? 'the depot opening' : "the truck's availability";
        v({ ...at(first), code: 'EARLY_DEPARTURE', message: `${code} load ${first.loadNo} leaves at ${hhmm(first.departMin)}, before ${why} (${hhmm(earliest)}).`, shortBy: earliest - first.departMin });
      }
    }
    for (const l of loads) {
      const r = l.rules;
      if (!r) continue;
      if (l.returnMin > r.depotCloseMin + TOL_MIN) {
        v({ ...at(l), code: 'DEPOT_CLOSE', message: `${code} load ${l.loadNo} is back at ${hhmm(l.returnMin)}, after the depot closes (${hhmm(r.depotCloseMin)}).`, shortBy: l.returnMin - r.depotCloseMin });
      }
      if (r.availableToMin !== null && l.returnMin > r.availableToMin + TOL_MIN) {
        v({ ...at(l), code: 'TRUCK_AVAILABILITY', message: `${code} load ${l.loadNo} is back at ${hhmm(l.returnMin)}, after the truck's availability ends (${hhmm(r.availableToMin)}).`, shortBy: l.returnMin - r.availableToMin });
      }
    }
    const rules = [...loads].reverse().find((l) => l.rules)?.rules ?? null;
    if (rules) {
      const startDay = Math.min(...loads.map((l) => l.departMin));
      const endDay = Math.max(...loads.map((l) => l.returnMin));
      if (endDay - startDay > rules.shiftMaxMin + TOL_MIN) {
        const last = loads[loads.length - 1];
        v({ ...at(last), code: 'SHIFT_LIMIT', message: `${code} is out from ${hhmm(startDay)} to ${hhmm(endDay)}: longer than the ${Math.floor(rules.shiftMaxMin / 60)}h${String(rules.shiftMaxMin % 60).padStart(2, '0')} shift maximum.`, shortBy: endDay - startDay - rules.shiftMaxMin });
      }
      if (loads.length > rules.maxTrips) {
        v({ ...at(loads[loads.length - 1]), code: 'TRIPS', message: `${code} has ${loads.length} loads; at most ${rules.maxTrips} per day.` });
      }
    }
  }

  // The solver's own report for the option in use.
  const solverStatus = input.solver ? input.solver.status : 'UNKNOWN';
  for (const sv of input.solver?.violations ?? []) {
    const truckId = sv.truck_id ?? null;
    const load = truckId !== null ? input.loads.find((l) => l.truckId === truckId && l.loadNo === sv.load_no) : undefined;
    const past = !!load && load.onRoad;
    out.push({
      code: sv.code,
      severity: past ? 'WARN' : 'BLOCK',
      source: 'SOLVER',
      truckId,
      truckCode: truckId !== null ? (codeOf.get(truckId) ?? truckId) : null,
      loadId: load?.id ?? null,
      loadNo: sv.load_no ?? null,
      message: past ? sv.message + history : sv.message,
      shortBy: sv.short_by_min ?? null,
      ...(past ? {} : frozenMark(load?.id ?? null)),
    });
  }

  const trucks: PlanFeasibility['trucks'] = {};
  const globalBlocks = out.filter((x) => x.severity === 'BLOCK' && x.truckId === null).length;
  for (const [truckId, list] of byTruck) {
    const mine = out.filter((x) => x.truckId === truckId);
    const blocking = mine.filter((x) => x.severity === 'BLOCK').length + globalBlocks;
    const status: TruckTiming = blocking
      ? 'VIOLATED'
      : solverStatus === 'VERIFIED' || solverStatus === 'VIOLATED'
        ? 'VERIFIED' // the solver's violations are per truck: none on this one
        : solverStatus === 'UNVERIFIED'
          ? 'UNVERIFIED'
          : 'STRUCTURAL_ONLY';
    trucks[truckId] = { truckCode: list[0].truckCode, status, ok: status === 'VERIFIED' || status === 'STRUCTURAL_ONLY', blocking, warnings: mine.length - (blocking - globalBlocks) };
  }
  const all = Object.values(trucks);
  const status: TruckTiming = all.some((t) => t.status === 'VIOLATED')
    ? 'VIOLATED'
    : all.some((t) => t.status === 'UNVERIFIED')
      ? 'UNVERIFIED'
      : solverStatus === 'UNKNOWN'
        ? 'STRUCTURAL_ONLY'
        : 'VERIFIED';
  return {
    v: FEASIBILITY_VERSION,
    ok: all.every((t) => t.ok) && globalBlocks === 0,
    status,
    source: input.solver ? 'SOLVER_AND_WEB' : 'LEGACY_STRUCTURAL_ONLY',
    solverStatus,
    solverTiming: input.solver?.timing ?? null,
    trucks,
    violations: out,
    inputHash: inputHash(input),
    checkedAt: now.toISOString(),
  };
}

/** A stored RunPlan.feasibilityJson, or null. */
export function readFeasibility(json: unknown): PlanFeasibility | null {
  const f = json as Partial<PlanFeasibility> | null;
  return f && typeof f === 'object' && typeof f.ok === 'boolean' && typeof f.inputHash === 'string' && f.trucks ? (f as PlanFeasibility) : null;
}

/** Operator switch: FEASIBILITY_GATE=warn lets unverified truck-days be locked and dispatched
 * (the violations are still shown and audited). Anything else, or unset, enforces the gate. */
export function feasibilityGateMode(env: Record<string, string | undefined> = process.env): 'enforce' | 'warn' {
  return (env.FEASIBILITY_GATE ?? '').trim().toLowerCase() === 'warn' ? 'warn' : 'enforce';
}

export { truckDayOk, truckViolations, timingRemedy, REPLAN_REMEDY, TIMING_TEXT } from './feasibility-view';
