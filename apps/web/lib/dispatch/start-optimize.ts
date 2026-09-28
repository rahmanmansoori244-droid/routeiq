import type { RunPlan } from '@prisma/client';
import { prisma } from '../db';
import { audit } from '../audit';
import { repairEndedJobPlan } from './stuck-plan';
import { scheduleDispatchOptimize } from '../jobs/dispatch-job';
import {
  buildDispatchRequest,
  createNextVersion,
  isLegacyPlan,
  ordersInScopeWhere,
  pendingLateOrderIds,
  PlanError,
  planErrorBody,
  type BuiltRequest,
} from './plan-service';
import { INTAKE_BUSY, isTransactionTimeout, lockIntake } from './intake-server';
import { isLockBusy, lockRunForWrite, PLAN_BUSY_MESSAGE, setLockTimeout } from './plan-locks';
import { isSupersededRun } from './plan-status';
import { solveAdmission, type AdmissionDenied, type SolveTicket } from './solve-admission';
import { isoOf } from './time';
import { describeUnknownWeights } from './weights';

export interface StartResult {
  status: number;
  body: Record<string, unknown>;
  /** Extra response headers (Retry-After on 429 / 503). */
  headers?: Record<string, string>;
}

/** What the dispatcher explicitly accepted when optimizing (after a 409 asked). */
export interface OptimizeOverrides {
  /** Plan anyway; customers without a (valid) location are left unserved. */
  allowMissingLocations?: boolean;
  /** Plan anyway; lines without a case weight count as 0 kg in the payload checks. */
  allowMissingWeights?: boolean;
}

/** The day and depot the dispatcher's screen shows (stale-screen guard, review ADD-STALE-DAY-CLIENT). */
export interface ExpectedDay {
  date: string;
  depotId: string;
}

/** Plans from the previous optimizer keep their routes as they were: re-optimizing them in
 * place would delete their assignments (including locked stops and delivery proofs). */
const LEGACY_PLAN: StartResult = {
  status: 409,
  body: {
    error: 'This plan was made by the previous optimizer (May 2026) and is kept exactly as it was. It cannot be re-optimized or re-planned.',
    code: 'LEGACY_PLAN',
  },
};

const SUPERSEDED: StartResult = { status: 409, body: { error: 'This plan version was superseded. Open the latest version.', code: 'SUPERSEDED' } };

/**
 * Every order of the day already sits on a locked, loading or dispatched load (review F03). The
 * advice to unlock is given only when a LOCKED or LOADING load exists: a dispatched load cannot
 * be unlocked.
 */
export function nothingToPlan(applied: boolean, canUnlock: boolean): StartResult {
  const what = 'Nothing to plan: every order of this day is already on a locked, loading or dispatched load.';
  let advice: string;
  if (canUnlock) advice = applied ? 'To change a load, unlock it first.' : 'This version has no optimized plan yet: unlock one load, then OPTIMIZE.';
  else advice = 'Every load has left the depot; they can still be marked completed. A late order for this day can still be planned.';
  return { status: 409, body: { error: `${what} ${advice}`, code: 'NOTHING_TO_PLAN' } };
}

/** PR9: orders of this version's depot and day brought forward to a later day (no longer open here). */
async function carriedAwayOfDay(tenantId: string, runId: string): Promise<number> {
  const run = await prisma.runPlan.findFirst({ where: { id: runId, tenantId }, select: { depotId: true, runDate: true } });
  if (!run) return 0;
  const where = await ordersInScopeWhere(tenantId, run.depotId, run.runDate);
  return prisma.order.count({ where: { ...where, carriedToOrderId: { not: null } } });
}

/**
 * True when the version has a LOCKED or LOADING load that could be unlocked (or put back to locked).
 * `withOrderOfDay` (PR9): only one holding an order not brought forward to a later day.
 */
async function hasUnlockableLoad(runId: string, opts: { withOrderOfDay?: boolean } = {}): Promise<boolean> {
  const where = { runId, status: { in: ['LOCKED' as const, 'LOADING' as const] } };
  return (await prisma.planLoad.count({ where: opts.withOrderOfDay ? { ...where, assignments: { some: { order: { carriedToOrderId: null } } } } : where })) > 0;
}

/**
 * PR9: LOCKED or LOADING loads of the version holding only orders brought forward to a later day.
 * They were loaded (in NMWC's flow the night before): their cases are on the truck but planned on
 * the later day now, so the answer says to unload them (never "they are never loaded").
 */
async function loadedCarriedLoads(runId: string): Promise<number> {
  const loads = await prisma.planLoad.findMany({
    where: { runId, status: { in: ['LOCKED', 'LOADING'] } },
    include: { assignments: { select: { order: { select: { carriedToOrderId: true } } } } },
  });
  return loads.filter((l) => l.assignments.length > 0 && l.assignments.every((a) => !!a.order?.carriedToOrderId)).length;
}

const NO_TRUCKS: StartResult = { status: 400, body: { error: 'No active trucks at this depot.', code: 'NO_TRUCKS' } };
const PLAN_BUSY: StartResult = { status: 409, body: { error: PLAN_BUSY_MESSAGE, code: 'PLAN_BUSY' } };

export function admissionRefused(a: AdmissionDenied): StartResult {
  return { status: a.status, body: { error: a.error, code: a.code, retryAfterSec: a.retryAfterSec }, headers: { 'Retry-After': String(a.retryAfterSec) } };
}

/** 409 when the plan is not for the day and depot the dispatcher's screen shows. */
export function dayMismatch(run: Pick<RunPlan, 'runDate' | 'depotId'>, expect: ExpectedDay | undefined): StartResult | null {
  if (!expect) return null;
  if (isoOf(run.runDate) === expect.date && run.depotId === expect.depotId) return null;
  return {
    status: 409,
    body: {
      error: 'This plan is for another date or depot than the one on your screen. Reload the day and try again.',
      code: 'DAY_MISMATCH',
    },
  };
}

/**
 * Checks on a built request that need the dispatcher's explicit go-ahead: customers without a
 * location (LOCATION_REQUIRED) and, when a truck has a payload, lines without a case weight
 * (WEIGHT_REQUIRED). With the override for weights, the plan carries a warning that stays on it.
 */
function gate(built: BuiltRequest, opts: OptimizeOverrides, verb: string): StartResult | null {
  if (built.blocking.length && !opts.allowMissingLocations) {
    return {
      status: 409,
      body: { error: `${built.blocking.length} customer(s) need a location before ${verb}.`, code: 'LOCATION_REQUIRED', blocking: built.blocking },
    };
  }
  const payloads = built.request.trucks.some((t) => (t.capacity_kg ?? 0) > 0);
  if (built.unknownWeights.length && payloads) {
    const lines = built.unknownWeights.reduce((a, u) => a + u.lines, 0);
    const cases = built.unknownWeights.reduce((a, u) => a + u.cases, 0);
    if (!opts.allowMissingWeights) {
      return {
        status: 409,
        body: {
          error: `${lines} order line(s) (${cases} cases) have no weight: ${describeUnknownWeights(built.unknownWeights)}. Truck payloads cannot be checked for them. Have the case weight entered under Products (company admins can edit products), or ${verb === 're-planning' ? 're-plan' : 'optimize'} anyway (treated as 0 kg).`,
          code: 'WEIGHT_REQUIRED',
          unknownWeights: built.unknownWeights,
        },
      };
    }
    const note = `Planned without weights for ${lines} order line(s) (${cases} cases): ${describeUnknownWeights(built.unknownWeights)} - counted as 0 kg, so loads may be heavier than shown. Optimized anyway by the dispatcher.`;
    if (!built.warnings.includes(note)) built.warnings.push(note);
  }
  return null;
}

/**
 * PR9: nothing left to plan because the day's open orders were brought forward to a later day
 * (`carried` of them) - the loads and unserved lines that still show them stay in the plan for the
 * record, and a re-plan has nothing to change. Never "upload orders first" nor "every load has left
 * the depot". `loadedCarried`: LOCKED or LOADING loads holding only brought-forward orders - they
 * were loaded, so their cases are on the truck: unload them before the loads of the later day are picked.
 */
export function nothingLeftCarried(carried: number, othersFrozen: boolean, canUnlockOthers = false, loadedCarried = 0): StartResult {
  const rest = othersFrozen ? ' and every other order of this day is on a locked, loading or dispatched load' : '';
  // Unlock advice only for a locked or loading load holding an order that is still this day's:
  // unlocking a load holding only brought-forward orders would plan nothing.
  const unlock = canUnlockOthers ? ' To change a locked or loading load, unlock it first.' : '';
  const loaded = loadedCarried
    ? ` ${loadedCarried} locked or loading load(s) hold only brought-forward orders and were loaded: unload those cases back to stock, or tell the warehouse, before the loads of the later day are picked; then put the load back to Planned.`
    : '';
  return {
    status: 409,
    body: {
      error:
        `Nothing left to plan: ${carried} order(s) of this day were brought forward to a later day and are planned there${rest}. ` +
        'Loads and unserved lines that still show brought-forward orders stay in this plan for the record; nothing needs to be re-planned.' +
        loaded +
        ' A late order for this day can still be planned.' +
        unlock,
      code: 'NOTHING_TO_PLAN',
      carriedAway: carried,
    },
  };
}

/**
 * The checks after a request was built that would make the optimization pointless: nothing to
 * plan (409 NOTHING_TO_PLAN when every order is on a frozen load or was brought forward to a later
 * day; 400 with no orders at all) and no active truck (400). Shared by the optimize start and the
 * re-plan preflight.
 */
async function prerequisites(tenantId: string, runId: string, built: BuiltRequest, applied: boolean): Promise<StartResult | null> {
  if (built.scope.orderIds.length === 0) {
    const carried = await carriedAwayOfDay(tenantId, runId);
    if (carried > 0) {
      return nothingLeftCarried(carried, built.scope.frozenOrderIds.length > 0, await hasUnlockableLoad(runId, { withOrderOfDay: true }), await loadedCarriedLoads(runId));
    }
    if (built.scope.frozenOrderIds.length > 0) return nothingToPlan(applied, await hasUnlockableLoad(runId));
    return { status: 400, body: { error: 'No orders to plan for this depot and date. Upload orders first.', code: 'NO_ORDERS' } };
  }
  if (built.request.trucks.length === 0) return NO_TRUCKS;
  return null;
}

/**
 * The job already running for this version (answered 202 without starting another one). Audit
 * F09: only a job the database still has QUEUED or RUNNING - never an ended one, and never "the
 * in-flight map has something" alone: a job whose promise is just finishing after its commit is
 * over, and the new start is chained after it (scheduleDispatchOptimize).
 */
async function activeJobAnswer(runId: string): Promise<StartResult | null> {
  const active = await prisma.runJob.findFirst({ where: { runId, status: { in: ['QUEUED', 'RUNNING'] } }, orderBy: { attemptNo: 'desc' } });
  if (active) return { status: 202, body: { runJobId: active.id, status: active.status, runId } };
  return null;
}

/**
 * Audit F09: a version still OPTIMIZING although its current job has ended (a stuck plan) is put
 * back to FAILED first (repairEndedJobPlan, audited), so OPTIMIZE / RE-PLAN then start real work
 * instead of answering 202 with the dead job (or 409 "optimizing" forever). Returns the version
 * as it is now: read again after the job checks, never the row read before them. Review of audit
 * PR4: the job can end during the request (its failure or its saved plan moves the plan to FAILED
 * or READY); the row read before it still said OPTIMIZING, and OPTIMIZE answered 409 PLAN_STUCK
 * ("a supervisor can reset it now") for a plan that was not stuck.
 */
async function unstickIfEnded<T extends Pick<RunPlan, 'status'>>(
  tenantId: string,
  run: T,
  runId: string,
  actor: { userId: string; ip: string | null; via: 'OPTIMIZE' | 'REPLAN' },
): Promise<T | RunPlan | null> {
  if (run.status !== 'OPTIMIZING') return run;
  // Really optimizing (a job QUEUED or RUNNING): nothing to reset, and no plan row lock taken (a
  // click while the plan is being saved answers 202 at once instead of waiting for the lock).
  const active = await prisma.runJob.count({ where: { runId, status: { in: ['QUEUED', 'RUNNING'] } } });
  if (active === 0) await repairEndedJobPlan(tenantId, runId, actor);
  // Nothing to repair also when the job ended meanwhile and moved the plan itself: read it again.
  return prisma.runPlan.findFirst({ where: { id: runId, tenantId } });
}

/**
 * The version is OPTIMIZING but no job of it is QUEUED or RUNNING, and it could not be reset now.
 * Answered only inside the start transaction, on the locked plan row (see startDispatchOptimize).
 */
const PLAN_STUCK: StartResult = {
  status: 409,
  body: {
    error: 'This plan is still marked as optimizing although its optimization has ended. It is reset within a minute (a supervisor can reset it now); then try again.',
    code: 'PLAN_STUCK',
  },
};

/** Refused inside the start transaction: the version changed after the request was built. */
class StartRefused extends Error {
  constructor(public readonly result: StartResult) {
    super(String(result.body.error ?? 'refused'));
  }
}

export interface StartOptions extends OptimizeOverrides {
  prebuilt?: BuiltRequest;
  /**
   * A version just created by a re-plan (createNextVersion): it carries a copy of the previous
   * plan (chosenScenarioId set), which must not count as "already in use" - as long as it has
   * never had a job.
   */
  freshVersion?: boolean;
  /** Admission reserved by the caller (the re-plan reserves before creating the version). */
  ticket?: SolveTicket;
  expect?: ExpectedDay;
  /** The time the plan is made (default: the clock now; see buildDispatchRequest). Tests fix it here. */
  now?: Date;
}

/**
 * A version with an applied plan is never re-optimized in place - also when it is FAILED: after a
 * failed re-plan it still holds the previous plan (copy-forward), which the dispatcher may already
 * be dispatching. The one exception is the fresh copy a re-plan just created, before its first job.
 */
function inUse(run: Pick<RunPlan, 'chosenScenarioId'>, hasJobs: boolean, freshVersion: boolean): boolean {
  if (!run.chosenScenarioId) return false;
  return !(freshVersion && !hasJobs);
}

/** Versions an optimization can start on (not superseded or archived; OPTIMIZING answers 202). */
const START_FROM = ['DRAFT', 'READY', 'FAILED', 'DISPATCHED'] as const;

const NEW_VERSION_REQUIRED: StartResult = {
  status: 409,
  body: { error: 'This plan is already in use. Re-plan to create a new version.', code: 'NEW_VERSION_REQUIRED' },
};

/**
 * Start an optimization for a plan version that has not been applied yet (DRAFT, or FAILED /
 * READY without an applied plan), or for the version a re-plan just created. An applied plan -
 * also a FAILED version still holding the copy of the previous plan - is never re-optimized in
 * place: the caller must create a new version (see `replan`), so every plan the dispatcher has
 * seen stays traceable.
 *
 * Order: cheap checks (404, superseded, legacy, in use, already running = 202), then the request
 * is built and gated, then admission (solve-admission.ts: quotas and the concurrency queue), then
 * ONE transaction: intake lock, the plan row lock (FOR UPDATE), every check again on the locked
 * row, the frozen loads the request was built around unchanged, the scoped orders still there,
 * RunJob created, the plan set OPTIMIZING and the OPTIMIZE_STARTED audit row - so a refused start
 * leaves nothing behind (review F07 / ADD-JOB-AUDIT). The admission ticket is given back on every
 * return that does not start a job. Weights the request took from the product master are saved
 * only when the job applies its result (dispatch-job.ts), so a failed optimization changes no
 * order kg under the plan still in use.
 */
export async function startDispatchOptimize(
  tenantId: string,
  runId: string,
  user: { id: string },
  ip: string | null,
  opts: StartOptions = {},
): Promise<StartResult> {
  let ticket: SolveTicket | null = opts.ticket ?? null;
  let handedOff = false;
  try {
    const found = await prisma.runPlan.findFirst({ where: { id: runId, tenantId } });
    if (!found) return { status: 404, body: { error: 'Plan not found' } };
    const mismatch = dayMismatch(found, opts.expect);
    if (mismatch) return mismatch;
    if (isSupersededRun(found)) return SUPERSEDED;
    if (await isLegacyPlan(tenantId, runId)) return LEGACY_PLAN;
    // Audit F09: a stuck plan (OPTIMIZING, its job ended) is reset first, then optimized.
    const run = await unstickIfEnded(tenantId, found, runId, { userId: user.id, ip, via: 'OPTIMIZE' });
    if (!run) return { status: 404, body: { error: 'Plan not found' } };
    const active = await activeJobAnswer(runId);
    if (active) return active;
    // Review of audit PR4: no PLAN_STUCK here. `run` was read before the job lookup above, and a
    // job that ends in between (it moves its plan to FAILED or READY in the same transaction,
    // under the plan row lock) leaves this row saying OPTIMIZING although the plan is not stuck.
    // The start transaction below decides on the locked row: a job in progress answers 202,
    // OPTIMIZING without one answers 409 PLAN_STUCK, anything else is checked as usual.
    const jobs = await prisma.runJob.count({ where: { runId } });
    if (inUse(run, jobs > 0, !!opts.freshVersion)) return NEW_VERSION_REQUIRED;
    // Weights entered or corrected under Products after the orders were confirmed are planned
    // with (in memory); the job saves them on the orders together with the plan that uses them.
    const built = opts.prebuilt ?? (await buildDispatchRequest(tenantId, runId, undefined, { now: opts.now }));
    const refused = gate(built, opts, 'optimizing') ?? (await prerequisites(tenantId, runId, built, !!run.chosenScenarioId));
    if (refused) return refused;

    if (!ticket) {
      const adm = solveAdmission.reserve(tenantId, user.id);
      if (!adm.ok) return admissionRefused(adm);
      ticket = adm.ticket;
    }
    const orderCount = built.scope.orderIds.length;
    let job;
    try {
      job = await prisma.$transaction(
        async (tx) => {
          // Under the intake lock (confirm, late order and batch delete take it too): a batch
          // delete that committed after the request was built must not leave the job planning
          // orders that no longer exist. Once OPTIMIZING is committed, a delete is refused.
          await lockIntake(tx, tenantId);
          await setLockTimeout(tx);
          const locked = await lockRunForWrite(tx, tenantId, runId, { allow: START_FROM, allowOptimizing: true });
          const jobsNow = await tx.runJob.findMany({ where: { runId }, select: { id: true, status: true, attemptNo: true }, orderBy: { attemptNo: 'desc' } });
          // Another start won the race: answer with its job, start nothing.
          const running = jobsNow.find((j) => j.status === 'QUEUED' || j.status === 'RUNNING');
          if (running) throw new StartRefused({ status: 202, body: { runJobId: running.id, status: running.status, runId } });
          // Audit F09: OPTIMIZING with no job in progress is a stuck plan, never a 202 for a dead job.
          if (locked.status === 'OPTIMIZING') throw new StartRefused(PLAN_STUCK);
          if (inUse(locked, jobsNow.length > 0, !!opts.freshVersion)) throw new StartRefused(NEW_VERSION_REQUIRED);
          // The frozen loads must still be the ones the request was built around.
          const frozenNow = (await tx.planLoad.findMany({ where: { runId, status: { not: 'PLANNED' } }, select: { id: true } })).map((l) => l.id).sort();
          const frozenThen = [...(built.scope.frozenLoadIds ?? [])].sort();
          if (frozenNow.join() !== frozenThen.join()) {
            throw new StartRefused({
              status: 409,
              body: { error: 'Loads were locked or unlocked while the plan was being prepared. Optimize again.', code: 'LOADS_CHANGED' },
            });
          }
          const ids = [...new Set([...built.scope.orderIds, ...built.scope.frozenOrderIds])];
          const found = ids.length ? await tx.order.count({ where: { tenantId, id: { in: ids } } }) : 0;
          if (found !== ids.length) throw new PlanError('Orders of this day were removed while the plan was being prepared (a file was deleted). Optimize again.', 409, { code: 'ORDERS_CHANGED' });
          // PR9: an open order brought forward to a later day meanwhile is planned there now; this
          // request still plans it here. (Orders on frozen loads stay: those loads keep them.)
          const carriedAway = built.scope.orderIds.length ? await tx.order.count({ where: { tenantId, id: { in: built.scope.orderIds }, carriedToOrderId: { not: null } } }) : 0;
          if (carriedAway > 0) {
            throw new PlanError('Orders of this day were brought forward to a later day while the plan was being prepared. Optimize again.', 409, { code: 'ORDERS_CHANGED' });
          }
          const waiting = ticket!.waiting;
          const created = await tx.runJob.create({
            data: {
              tenantId,
              runId,
              attemptNo: (jobsNow[0]?.attemptNo ?? 0) + 1,
              status: 'QUEUED',
              message: waiting ? `Waiting: ${ticket!.position()} optimization(s) ahead` : 'Queued',
              createdById: user.id,
              requestJson: built.request as never,
            },
          });
          await tx.runPlan.update({ where: { id: runId }, data: { status: 'OPTIMIZING', currentJobId: created.id } });
          // In the same transaction: an audit failure rolls the start back (no orphan QUEUED job).
          await audit(
            {
              tenantId,
              userId: user.id,
              action: 'OPTIMIZE_STARTED',
              entity: 'RunPlan',
              entityId: runId,
              afterJson: {
                runJobId: created.id,
                stops: built.request.stops.length,
                orders: orderCount,
                preDropped: built.preDrops.length,
                frozenOrders: built.scope.frozenOrderIds.length,
                trucks: built.request.trucks.length,
                allowMissingLocations: !!opts.allowMissingLocations,
                allowMissingWeights: !!opts.allowMissingWeights,
                unknownWeightLines: built.unknownWeights.reduce((a, u) => a + u.lines, 0),
                // PR8: a plan made on its delivery day - no new load before this time (minutes after midnight).
                planFromMin: built.settings?.planFrom?.fromMin ?? null,
                // PR8 review: made on the delivery day at this time - loading of new loads starts then.
                loadingFromMin: built.settings?.loadingFromMin ?? null,
                queued: waiting,
              } as never,
              ip,
            },
            tx,
          );
          return created;
        },
        { timeout: 30_000, maxWait: 10_000 },
      );
    } catch (e) {
      if (e instanceof StartRefused) return e.result;
      if (e instanceof PlanError) {
        const body = planErrorBody(e);
        return { status: e.status, body: typeof body === 'string' ? { error: body, code: e.status === 409 ? 'ORDERS_CHANGED' : undefined } : body };
      }
      if (isTransactionTimeout(e)) return { status: 409, body: INTAKE_BUSY };
      if (isLockBusy(e)) return PLAN_BUSY;
      throw e;
    }
    ticket.commit();
    handedOff = true;
    scheduleDispatchOptimize({ runId, runJobId: job.id, tenantId, userId: user.id, ip, built, ticket });
    return { status: 202, body: { runJobId: job.id, status: 'QUEUED', runId, queued: ticket.waiting } };
  } finally {
    if (!handedOff) ticket?.release();
  }
}

/**
 * Late order / re-plan (review F03): a new version keeping frozen loads, then optimize the rest.
 *
 * Every known reason to refuse is checked BEFORE the new version exists, so a refused re-plan
 * leaves the parent as the live plan: missing locations and weights (409 LOCATION_REQUIRED /
 * WEIGHT_REQUIRED), nothing left to plan because every order is on a locked, loading or
 * dispatched load (409 NOTHING_TO_PLAN), no active truck (400), a job already running (409),
 * and the solve admission (429 / 503, reserved here and handed to the new version's start).
 * The new version starts as a copy of the parent's plan (createNextVersion), so a failed
 * optimization keeps the previous plan usable on it.
 */
export async function replan(
  tenantId: string,
  runId: string,
  reason: 'LATE_ORDER' | 'MANUAL_ADJUSTMENT' | 'REOPTIMIZE',
  note: string | null,
  user: { id: string },
  ip: string | null,
  overrides: OptimizeOverrides = {},
  expect?: ExpectedDay,
  clock: { now?: Date } = {},
): Promise<StartResult> {
  const found = await prisma.runPlan.findFirst({ where: { id: runId, tenantId } });
  if (!found) return { status: 404, body: { error: 'Plan not found' } };
  const mismatch = dayMismatch(found, expect);
  if (mismatch) return mismatch;
  if (isSupersededRun(found)) return { status: 409, body: { error: 'This version was already superseded; open the latest version.', code: 'SUPERSEDED' } };
  // Checked before anything is superseded: a legacy parent must stay the live plan.
  if (await isLegacyPlan(tenantId, runId)) return LEGACY_PLAN;
  // Audit F09: a stuck version (OPTIMIZING, its job ended) is reset first: never "optimizing" forever.
  const run = await unstickIfEnded(tenantId, found, runId, { userId: user.id, ip, via: 'REPLAN' });
  if (!run) return { status: 404, body: { error: 'Plan not found' } };
  if (!run.chosenScenarioId) {
    // Nothing applied yet: optimizing this version again is still fully traceable.
    return startDispatchOptimize(tenantId, runId, user, ip, { ...overrides, expect, now: clock.now });
  }
  if (run.status === 'OPTIMIZING' || (await activeJobAnswer(runId))) {
    return { status: 409, body: { error: 'An optimization is running for this plan. Wait for it to finish.', code: 'OPTIMIZING' } };
  }
  // Preflight on the parent: the scope is the same as the child's (buildDispatchRequest ignores
  // PLANNED loads, and the child copies the frozen ones). The probe plans weights entered since
  // the last optimize in memory only: the parent stays the live plan if this is refused, so its
  // orders and loads must not change. They are saved when the child's job applies its plan.
  const probe = await buildDispatchRequest(tenantId, runId, undefined, { now: clock.now });
  const refused = gate(probe, overrides, 're-planning') ?? (await prerequisites(tenantId, runId, probe, true));
  if (refused) return refused;
  // A late order waiting to be added makes this a late-order re-plan (the other orders keep their
  // trucks) whichever button started it; only with nothing late waiting is it a full re-optimize.
  const effectiveReason = reason === 'REOPTIMIZE' && (await pendingLateOrderIds(tenantId, run)).length ? 'LATE_ORDER' : reason;
  // Admission before the version exists: a 429 must never leave a new version behind.
  const adm = solveAdmission.reserve(tenantId, user.id);
  if (!adm.ok) return admissionRefused(adm);
  let child;
  try {
    child = (await createNextVersion(tenantId, runId, effectiveReason, note, user.id)).child;
  } catch (e) {
    adm.ticket.release();
    if (e instanceof PlanError) {
      const body = planErrorBody(e);
      return { status: e.status, body: typeof body === 'string' ? { error: body } : body };
    }
    throw e;
  }
  // The ticket is handed over: startDispatchOptimize releases it on any answer that starts no job.
  const res = await startDispatchOptimize(tenantId, child.id, user, ip, { ...overrides, freshVersion: true, ticket: adm.ticket, now: clock.now });
  return {
    status: res.status,
    headers: res.headers,
    body: { ...res.body, runId: child.id, version: child.version, parentRunId: runId, reason: effectiveReason, ...(res.status >= 400 ? { previousPlanKept: true } : {}) },
  };
}
