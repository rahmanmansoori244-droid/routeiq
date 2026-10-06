/**
 * The hire suggestion's "Use this plan" (owner request 6 Oct 2026), PLANNER and above. Server only.
 *
 * 1. The suggestion must be finished, rent at least one truck, never used, computed for the plan option
 *    in use (HIRE_OTHER_OPTION otherwise), and its plan version must still be the one in use (not
 *    optimizing), for a day that is not over.
 * 2. The day is read again as a re-plan would read it. When nothing changed since the what-if was
 *    computed (the same orders, stops, own trucks and their locked or dispatched loads, settings, hire
 *    options and trucks already rented; a plan made on its delivery day not more than
 *    SAME_DAY_SLACK_MIN later) and the what-if leaves out no order the plan in use delivers, ONE
 *    transaction rents the trucks the what-if used - one-day trucks for that date (Truck.onlyOnDate,
 *    hired, codes HIRE-10T-0710-1, the option's size and costs) - makes the next plan version
 *    (copy-forward, frozen loads exactly as they are) and applies the what-if's plan to it, with those
 *    trucks and with the times it was planned with (a same-day plan's first departures stay those of
 *    the check, so its own timetable check never blocks them), its optimizer findings under the rented
 *    trucks' ids.
 * 3. Otherwise the trucks are rented the same way and a RE-PLAN starts (Quick): it plans the day as it
 *    is now, with them.
 * Both ways ask the re-plan's questions first (lines without a weight, asked with the trucks to rent in
 * the request: their payload counts), before any truck is rented. Trucks are rented under a company
 * lock (their codes) and never past an option's max per day. Every step is audited
 * (HIRED_TRUCKS_ADDED, PLAN_VERSION_CREATED, SCENARIO_CHOSEN, HIRE_SUGGESTION_USED).
 */
import type { Prisma } from '@prisma/client';
import type { DispatchRequest, DispatchResponse, DispatchTruck } from '@routeiq/shared-types';
import { prisma } from '../db';
import { audit } from '../audit';
import {
  applyScenario,
  applyWeightChanges,
  buildDispatchRequest,
  createNextVersionTx,
  persistDispatchResult,
  PlanError,
  planErrorBody,
  retimeSameDay,
  type BuiltRequest,
} from './plan-service';
import { asPlanBusy, setLockTimeout } from './plan-locks';
import { isSupersededRun } from './plan-status';
import { dayMismatch, replan, replanRefusal, weightRefusal, type ExpectedDay, type OptimizeOverrides, type StartResult } from './start-optimize';
import { basisFingerprint, cancelHireChecksOfDay, companyToday, DAY_OVER_TEXT, depotHireOptions, rentedOnDay, type HireBasis } from './hire-whatif';
import { hireTruckCode, hiresText, parseVirtualHireId, sameDayMovedOn, type HireOptionFacts, type HireSummary } from './hire';
import { isoOf } from './time';

type Tx = Prisma.TransactionClient;

export interface UseOptions {
  expect?: ExpectedDay;
  overrides?: OptimizeOverrides;
  now?: Date;
}

function refuse(status: number, code: string, error: string, extra: Record<string, unknown> = {}): StartResult {
  return { status, body: { error, code, ...extra } };
}

/** The option values a rented truck is made from: unchanged since the what-if, or the plan is stale. */
function sameOption(a: HireOptionFacts | undefined, b: HireOptionFacts | undefined): boolean {
  return (
    !!a &&
    !!b &&
    a.bays === b.bays &&
    a.capacityCases === b.capacityCases &&
    a.payloadKg === b.payloadKg &&
    a.costPerDay === b.costPerDay &&
    a.costPerKm === b.costPerKm &&
    a.label === b.label &&
    a.maxPerDay === b.maxPerDay
  );
}

/**
 * Whether the what-if still holds for the day as it is now: the reasons it does not, in plain words
 * ([] = it holds). Pure, for the tests.
 */
export function staleReasons(input: {
  basis: HireBasis;
  whatIfRequest: DispatchRequest;
  nowRequest: DispatchRequest;
  nowFingerprint: string;
  optionsNow: HireOptionFacts[];
  rentedNow: Record<string, number>;
  summary: HireSummary;
}): string[] {
  const out: string[] = [];
  if (input.nowFingerprint !== input.basis.fingerprint) out.push('the orders, trucks, loads or settings of the day changed');
  if (sameDayMovedOn(input.whatIfRequest.config, input.nowRequest.config)) out.push('it was computed a while ago on the delivery day, so its first departures are too early now');
  const now = new Map(input.optionsNow.map((o) => [o.id, o]));
  const then = new Map(input.basis.options.map((o) => [o.id, o]));
  for (const h of input.summary.hires) {
    if (!sameOption(then.get(h.optionId), now.get(h.optionId))) out.push(`the ${h.label} hire option was changed or switched off`);
    else if ((input.rentedNow[h.optionId] ?? 0) !== (input.basis.alreadyRented[h.optionId] ?? 0)) out.push(`${h.label} trucks were rented for this day since`);
  }
  // Review of the hire branch: its plan would silently drop an order that is on a truck today.
  if (input.summary.dropped?.orders) out.push('its plan leaves out orders your plan in use delivers');
  return [...new Set(out)];
}

/** The what-if's trucks to rent that the suggestion uses (virtual ids), as the request carried them. */
function trucksToRent(whatIf: DispatchRequest, summary: HireSummary): DispatchTruck[] {
  const ids = new Set(summary.hires.flatMap((h) => h.truckIds));
  return whatIf.trucks.filter((t) => ids.has(t.id));
}

/**
 * The PLAN way applies the what-if's own loads, timed when its request was built (review of the hire
 * branch): the plan is stored with those times - the first departure and loading start of a same-day
 * plan, the plan warning and the settings kept with it - never with the later clock of "now", whose
 * timetable check would block the earliest of those loads (TURNAROUND / EARLY_DEPARTURE, up to
 * SAME_DAY_SLACK_MIN short).
 */
export function keepWhatIfTiming(built: BuiltRequest, whatIf: DispatchRequest, builtAt: string | undefined): void {
  if (builtAt && built.sameDay) retimeSameDay(built, new Date(builtAt), 0);
  const cfg = built.request.config as Record<string, unknown> | undefined;
  if (!cfg) return;
  for (const k of ['shift_start_min', 'loading_from_min'] as const) {
    const v = whatIf.config?.[k];
    if (v === undefined || v === null) delete cfg[k];
    else cfg[k] = v;
  }
  if (built.settings) built.settings.loadingFromMin = whatIf.config?.loading_from_min ?? null;
}

/** The truck rows of the trucks to rent, from the what-if's own trucks (what was planned with). */
async function rentTrucks(
  tx: Tx,
  tenantId: string,
  run: { id: string; depotId: string; runDate: Date },
  summary: HireSummary,
  whatIf: DispatchRequest,
  options: HireOptionFacts[],
  user: { id: string },
  ip: string | null,
): Promise<Map<string, { id: string; code: string; label: string }>> {
  const dateIso = isoOf(run.runDate);
  const virtual = new Map(whatIf.trucks.map((t) => [t.id, t]));
  const optionOf = new Map(options.map((o) => [o.id, o]));
  // One company-wide lock for the codes (review of the hire branch: two depots renting for the same
  // date at once both read the free codes, and the second hit the unique code). Only "Use this plan"
  // takes it, first among its locks (plan-locks.ts: before the day locks).
  await tx.$queryRaw`SELECT 1 AS locked FROM pg_advisory_xact_lock(hashtextextended(${`hire-codes:${tenantId}`}, 0))`;
  // Never past an option's max per day, also when it was lowered since the check (under the lock: two
  // presses for the same day are counted one after the other).
  const already = await rentedOnDay(tenantId, run.depotId, run.runDate, tx);
  for (const h of summary.hires) {
    const o = optionOf.get(h.optionId);
    if (o && (already[o.id] ?? 0) + h.truckIds.length > o.maxPerDay) {
      throw new PlanError(
        `At most ${o.maxPerDay} ${o.label} truck(s) can be hired a day, and ${already[o.id] ?? 0} are hired for ${dateIso} already. Check hire options again.`,
        409,
        { code: 'HIRE_LIMIT' },
      );
    }
  }
  const taken = new Set((await tx.truck.findMany({ where: { tenantId, code: { startsWith: 'HIRE-' } }, select: { code: true } })).map((t) => t.code));
  const made = new Map<string, { id: string; code: string; label: string }>();
  for (const h of summary.hires) {
    const o = optionOf.get(h.optionId);
    if (!o) throw new PlanError(`The ${h.label} hire option no longer exists. Check hire options again.`, 409, { code: 'HIRE_OPTION_GONE' });
    let n = 1;
    for (const vid of h.truckIds) {
      const t = virtual.get(vid);
      if (!t) throw new PlanError('The hire check is incomplete. Check hire options again.', 409, { code: 'HIRE_CHECK_INCOMPLETE' });
      while (taken.has(hireTruckCode(o.label, dateIso, n))) n++;
      const code = hireTruckCode(o.label, dateIso, n);
      taken.add(code);
      const row = await tx.truck.create({
        data: {
          tenantId,
          depotId: run.depotId,
          code,
          description: `Hired ${o.label} for ${dateIso} (hire suggestion)`,
          capacityCases: o.capacityCases,
          capacityWeightKg: o.payloadKg,
          capacityVolumeL: 0,
          fixedCostPerDay: o.costPerDay,
          // Fuel is in the hire (owner answer 3): only the rental's own km charge, no km per litre. Its
          // driver is paid the company's day rate whenever it is planned (hire.ts hiredTruckDriver).
          costPerKm: t.cost_per_km ?? 0,
          tripCost: t.trip_cost ?? 0,
          kmPerLitre: null,
          bays: o.bays,
          hired: true,
          onlyOnDate: run.runDate,
          hireOptionId: o.id,
          active: true,
        },
        select: { id: true, code: true },
      });
      made.set(vid, { id: row.id, code: row.code, label: o.label });
    }
  }
  await audit(
    {
      tenantId,
      userId: user.id,
      action: 'HIRED_TRUCKS_ADDED',
      entity: 'Truck',
      afterJson: { runId: run.id, date: dateIso, trucks: [...made.values()].map((m) => ({ id: m.id, code: m.code, option: m.label })) } as never,
      ip,
    },
    tx,
  );
  return made;
}

/**
 * The what-if's request and answer with its rented trucks under their new ids (and only those used):
 * their loads, their truck days and the optimizer's own timetable findings (review of the hire branch:
 * a finding left on the placeholder id matched no truck, so the timetable gate let its loads go), and
 * the placeholder codes ("HIRE-10T-1") in the findings and warnings under the real codes.
 */
export function withRentedTrucks(
  whatIf: DispatchRequest,
  resp: DispatchResponse,
  made: Map<string, { id: string; code: string }>,
  base: DispatchRequest,
): { request: DispatchRequest; response: DispatchResponse } {
  const idOf = (id: string) => made.get(id)?.id ?? id;
  // Longest placeholder first ("HIRE-10T-10" before "HIRE-10T-1"); a whole code only.
  const codes = whatIf.trucks
    .filter((t) => made.has(t.id) && !!t.code)
    .map((t) => ({ from: t.code!, to: made.get(t.id)!.code }))
    .sort((a, b) => b.from.length - a.from.length);
  const recode = (text: string) =>
    codes.reduce((s, c) => s.replace(new RegExp(`${c.from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![A-Za-z0-9._-])`, 'g'), c.to), text);
  const rented: DispatchTruck[] = whatIf.trucks
    .filter((t) => made.has(t.id))
    .map((t) => {
      const { hire_candidate: _drop, ...rest } = t;
      void _drop;
      return { ...rest, id: made.get(t.id)!.id, code: made.get(t.id)!.code };
    });
  const request: DispatchRequest = { ...base, trucks: [...base.trucks.filter((t) => !t.hire_candidate), ...rented] };
  const scenarios = resp.scenarios
    .filter((s) => s.name === 'RECOMMENDED')
    .map((s) => ({
      ...s,
      loads: s.loads.map((l) => ({ ...l, truck_id: idOf(l.truck_id) })),
      truck_days: (s.truck_days ?? []).map((d) => ({ ...d, truck_id: idOf(d.truck_id) })),
      warnings: (s.warnings ?? []).map(recode),
      ...(s.feasibility
        ? {
            feasibility: {
              ...s.feasibility,
              violations: (s.feasibility.violations ?? []).map((v) => ({ ...v, ...(v.truck_id ? { truck_id: idOf(v.truck_id) } : {}), message: recode(v.message) })),
            },
          }
        : {}),
    }));
  return { request, response: { ...resp, warnings: (resp.warnings ?? []).map(recode), scenarios } };
}

/** POST /api/runs/:id/hire-suggestion/use. */
export async function applyHireSuggestion(
  tenantId: string,
  runId: string,
  suggestionId: string,
  user: { id: string },
  ip: string | null,
  opts: UseOptions = {},
): Promise<StartResult> {
  const s = await prisma.hireSuggestion.findFirst({ where: { id: suggestionId, tenantId, runId } });
  if (!s) return refuse(404, 'NOT_FOUND', 'Hire suggestion not found.');
  if (s.usedAt) return refuse(409, 'ALREADY_USED', 'This hire suggestion was already used.', { usedRunId: s.usedRunId });
  if (s.status !== 'SUCCEEDED' || !s.summaryJson || !s.responseJson || !s.requestJson) return refuse(409, 'NOT_READY', 'The hire check has not finished. Wait for it, or check hire options again.');
  const summary = s.summaryJson as unknown as HireSummary;
  if (summary.status !== 'HIRE' || !summary.hires.length) return refuse(409, 'NOTHING_TO_HIRE', 'This suggestion hires no truck.');
  const basis = s.basisJson as unknown as HireBasis;
  const whatIf = s.requestJson as unknown as DispatchRequest;
  const resp = s.responseJson as unknown as DispatchResponse;

  const run = await prisma.runPlan.findFirst({ where: { id: runId, tenantId } });
  if (!run) return refuse(404, 'NOT_FOUND', 'Plan not found.');
  const mismatch = dayMismatch(run, opts.expect);
  if (mismatch) return mismatch;
  if (isSupersededRun(run)) {
    return refuse(409, 'SUPERSEDED', `A newer plan version is in use (this suggestion was for version ${run.version}). Check hire options on the plan in use.`);
  }
  if (run.status === 'OPTIMIZING' || (await prisma.runJob.count({ where: { runId, status: { in: ['QUEUED', 'RUNNING'] } } }))) {
    return refuse(409, 'OPTIMIZING', 'An optimization is running for this plan. Wait for it to finish.');
  }
  // Review of the hire branch: another plan option was chosen since the check ("Use instead"): its
  // what-if, its "dropped" orders and its counts were for the option it was computed for - never applied
  // to the option in use (a screen opened before still offered the button).
  if (basis.scenarioId && basis.scenarioId !== run.chosenScenarioId) {
    return refuse(409, 'HIRE_OTHER_OPTION', 'This hire suggestion was computed for another plan option than the one in use. Check hire options again.');
  }
  // Review of the hire branch: a day that is over gets no truck and no new plan version.
  if (isoOf(run.runDate) < (await companyToday(tenantId))) return refuse(409, 'DAY_OVER', DAY_OVER_TEXT);

  const [optionsNow, rentedNow] = await Promise.all([depotHireOptions(tenantId, run.depotId), rentedOnDay(tenantId, run.depotId, run.runDate)]);
  let now: BuiltRequest;
  try {
    now = await buildDispatchRequest(tenantId, runId, ['RECOMMENDED'], { withPallets: basis.withPallets, now: opts.now });
  } catch (e) {
    if (e instanceof PlanError) {
      const body = planErrorBody(e);
      return { status: e.status, body: typeof body === 'string' ? { error: body } : body };
    }
    throw e;
  }
  const stale = staleReasons({
    basis,
    whatIfRequest: whatIf,
    nowRequest: now.request,
    nowFingerprint: basisFingerprint(now.request, now.scope.frozenLoadIds),
    optionsNow,
    rentedNow,
    summary,
  });
  const note = `Hire suggestion: ${hiresText(summary.hires)}`;
  // The re-plan's weight question with the trucks to rent in the request (their payload counts), on
  // both ways, before anything is rented (review of the hire branch: the PLAN way never asked it, and
  // the re-plan way asked it only after the trucks were rented and the suggestion used).
  const withHires: BuiltRequest = { ...now, request: { ...now.request, trucks: [...now.request.trucks, ...trucksToRent(whatIf, summary)] }, warnings: [...now.warnings] };

  if (!stale.length) {
    const weights = weightRefusal(withHires, opts.overrides ?? {}, 're-planning');
    if (weights) return weights;
    // Nothing changed: the trucks, the version and the what-if's plan in one transaction.
    try {
      const out = await prisma.$transaction(
        async (tx) => {
          await setLockTimeout(tx);
          const claimed = await tx.hireSuggestion.updateMany({ where: { id: s.id, tenantId, usedAt: null, status: 'SUCCEEDED' }, data: { usedAt: new Date(), usedById: user.id } });
          if (!claimed.count) throw new PlanError('This hire suggestion was already used.', 409, { code: 'ALREADY_USED' });
          const made = await rentTrucks(tx, tenantId, run, summary, whatIf, optionsNow, user, ip);
          const { child, newLoadId } = await createNextVersionTx(tx, tenantId, runId, 'REOPTIMIZE', note, user.id);
          const mapped = withRentedTrucks(whatIf, resp, made, now.request);
          // The plan's own request, with the rented trucks and the frozen loads under their copies' ids.
          const built: BuiltRequest = {
            ...now,
            request: { ...mapped.request, run_id: child.id, config: { ...mapped.request.config } },
            scope: { ...now.scope, ...(now.scope.frozenLoadIds ? { frozenLoadIds: now.scope.frozenLoadIds.map((id) => newLoadId.get(id) ?? id).sort() } : {}) },
            warnings: [...withHires.warnings, `Planned with ${made.size} truck(s) hired for this day (hire suggestion): ${[...made.values()].map((m) => m.code).join(', ')}.`],
            ...(now.settings ? { settings: { ...now.settings } } : {}),
          };
          keepWhatIfTiming(built, whatIf, basis.builtAt);
          await applyWeightChanges(tx, tenantId, child.id, built.weightChanges, user.id);
          const ids = await persistDispatchResult(tx, tenantId, child.id, built, mapped.response, { jobId: null });
          await applyScenario(tx, tenantId, child.id, ids.get('RECOMMENDED')!, user.id);
          await tx.hireSuggestion.update({ where: { id: s.id }, data: { usedRunId: child.id } });
          await audit(
            {
              tenantId,
              userId: user.id,
              action: 'HIRE_SUGGESTION_USED',
              entity: 'HireSuggestion',
              entityId: s.id,
              afterJson: {
                runId,
                newRunId: child.id,
                version: child.version,
                how: 'PLAN_APPLIED',
                trucks: [...made.values()].map((m) => m.code),
                hireCost: summary.hireCost,
              } as never,
              ip,
            },
            tx,
          );
          return { child, made };
        },
        { timeout: 120_000, maxWait: 15_000 },
      );
      // A check of the day still waiting or running was for the version just replaced.
      await cancelHireChecksOfDay(tenantId, run.depotId, run.runDate, 'Stopped: a new plan version was made for this day (Use this plan), so this check was for a plan no longer in use.');
      return {
        status: 200,
        body: {
          runId: out.child.id,
          version: out.child.version,
          applied: 'PLAN',
          trucks: [...out.made.values()].map((m) => ({ id: m.id, code: m.code, label: m.label })),
        },
      };
    } catch (e) {
      const err = asPlanBusy(e);
      if (err instanceof PlanError) {
        const body = planErrorBody(err);
        return { status: err.status, body: typeof body === 'string' ? { error: body } : body };
      }
      throw err;
    }
  }

  // The day changed: the trucks are rented, then a re-plan (Quick) plans the day as it is now with
  // them. Its questions first (with the trucks to rent in the request), before anything is rented.
  const refusal = await replanRefusal(tenantId, runId, withHires, opts.overrides ?? {});
  if (refusal) return refusal;
  let made: Map<string, { id: string; code: string; label: string }>;
  try {
    made = await prisma.$transaction(
      async (tx) => {
        await setLockTimeout(tx);
        const claimed = await tx.hireSuggestion.updateMany({ where: { id: s.id, tenantId, usedAt: null, status: 'SUCCEEDED' }, data: { usedAt: new Date(), usedById: user.id } });
        if (!claimed.count) throw new PlanError('This hire suggestion was already used.', 409, { code: 'ALREADY_USED' });
        const m = await rentTrucks(tx, tenantId, run, summary, whatIf, optionsNow, user, ip);
        await audit(
          {
            tenantId,
            userId: user.id,
            action: 'HIRE_SUGGESTION_USED',
            entity: 'HireSuggestion',
            entityId: s.id,
            afterJson: { runId, how: 'REPLAN', why: stale, trucks: [...m.values()].map((x) => x.code), hireCost: summary.hireCost } as never,
            ip,
          },
          tx,
        );
        return m;
      },
      { timeout: 30_000, maxWait: 10_000 },
    );
  } catch (e) {
    const err = asPlanBusy(e);
    if (err instanceof PlanError) {
      const body = planErrorBody(err);
      return { status: err.status, body: typeof body === 'string' ? { error: body } : body };
    }
    throw err;
  }
  const trucks = [...made.values()].map((m) => ({ id: m.id, code: m.code, label: m.label }));
  const res = await replan(tenantId, runId, 'REOPTIMIZE', note, user, ip, opts.overrides ?? {}, opts.expect, { now: opts.now }, 'QUICK');
  const newRunId = typeof res.body.runId === 'string' ? res.body.runId : null;
  if (newRunId && res.status < 400) await prisma.hireSuggestion.update({ where: { id: s.id }, data: { usedRunId: newRunId } }).catch(() => undefined);
  if (res.status >= 400) {
    return {
      status: res.status,
      headers: res.headers,
      body: {
        ...res.body,
        error: `The hired trucks were added for ${isoOf(run.runDate)} (${trucks.map((t) => t.code).join(', ')}), but the re-plan did not start: ${String(res.body.error ?? '')} Re-plan to plan with them.`,
        trucks,
        applied: 'TRUCKS_ONLY',
      },
    };
  }
  return { status: res.status, headers: res.headers, body: { ...res.body, applied: 'REPLAN', why: stale, trucks } };
}
