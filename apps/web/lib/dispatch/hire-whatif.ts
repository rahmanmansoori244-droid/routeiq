/**
 * The hire suggestion's what-if job (owner request 6 Oct 2026). Server only.
 *
 * When a plan (OPTIMIZE or RE-PLAN, any day not over yet) leaves P1-P3 orders out for a reason a truck
 * more may help (hire.ts CAPACITY_REASONS; owner answer 1, 6 Oct 2026: P4/P5 orders alone never justify
 * renting - the box says so plainly) and its depot has active hire options, startHireCheck runs a
 * what-if: the same request as a re-plan of that version (frozen loads stay exactly as they are) plus
 * one truck per unit the day may still rent (fuel in the hire, its driver at the company's daily driver
 * day rate), the recommended plan only, Quick search. It is its own job
 * (HireSuggestion, never the plan's RunJob) on the same solve admission as every optimization, as a
 * BACKGROUND solve (solve-admission.ts reserveBackground): no hourly quota, and a dispatcher's solve
 * that needs its slot takes it at once - the what-if then goes back to the queue once and runs when a
 * slot frees (stopped for good only when it cannot wait). It never changes the plan: only "Use this
 * plan" (hire-use.ts) does.
 *
 * One check at a time per version (review of the hire branch): the "already running" test and the
 * create are one step under an advisory lock of the version, and the optimizer being busy is answered
 * before any row is made, so a refusal never hides a finished suggestion. A check that waited for a
 * slot looks at its version again when it gets one: a version no longer in use (or another plan option
 * in use) is not computed. Each depot-day keeps one check waiting for the optimizer (hireCheckKey; review:
 * three depots optimized in quick succession lost the third one's check), and none is run when every
 * order the plan left out is gone from the day (NOTHING_LEFT).
 */
import { createHash } from 'node:crypto';
import type { HireSuggestion, Prisma } from '@prisma/client';
import type { DispatchRequest, DispatchScenario } from '@routeiq/shared-types';
import { prisma } from '../db';
import { audit } from '../audit';
import { callDispatchSolver, SolverError } from '../solver-client';
import { solveAdmission, type SolveTicket } from './solve-admission';
import { buildDispatchRequest, isDispatchDetails, PlanError } from './plan-service';
import { isSupersededRun } from './plan-status';
import { orderIdOf } from './split';
import {
  DEFAULT_DRIVER_DAY_RATE,
  fleetAverages,
  hireNeed,
  hireSuggestionText,
  hireTrucksForRequest,
  lowPriorityOrders,
  lowPriorityText,
  needsHireCheck,
  NOTHING_LEFT_TEXT,
  requestBasisText,
  summarizeHire,
  type HireOptionFacts,
  type HireSummary,
} from './hire';
import { DEFAULT_TZ, isoOf, todayIso } from './time';

/** While a what-if waits or runs, its row's heartbeat is written this often. */
export const HIRE_HEARTBEAT_MS = 30_000;
/** A what-if with no heartbeat for this long, not running in this process, was lost (a restart). */
export const HIRE_LOST_AFTER_MS = 2 * 60_000;
/**
 * After a plan job saved its plan, its automatic check is created a moment later: for this long the
 * box says "Checking which trucks to hire" (HireView.checkExpected) even before the row exists.
 */
export const HIRE_EXPECT_MS = 20_000;

const g = globalThis as unknown as { __routeiqHireJobs?: Map<string, AbortController>; __routeiqHireStarts?: Map<string, HireStartNote> };
/** The what-ifs this process runs (suggestion id -> its cancel switch: a new optimization of the day, Start fresh). */
export const activeHireJobs: Map<string, AbortController> = (g.__routeiqHireJobs ??= new Map());

/** The automatic check of a plan just saved: being started (no row yet), or not started and why. */
interface HireStartNote {
  at: number;
  skipped?: { reason: HireSkip; message: string };
}
/** By plan version id (process memory: the web runs as one replica). Kept 10 minutes. */
const hireStarts: Map<string, HireStartNote> = (g.__routeiqHireStarts ??= new Map());
const START_NOTE_MS = 10 * 60_000;

/** What a what-if was computed from (HireSuggestion.basisJson): "Use this plan" compares it with the day now. */
export interface HireBasis {
  v: 1;
  depotId: string;
  dateIso: string;
  runVersion: number;
  /** The plan option in use when it was computed, and its unserved stops. */
  scenarioId: string;
  baseUnserved: { stop_id: string; order_ids: string[]; reason_code: string }[];
  /** The orders the plan in use delivers (its new loads' and its frozen loads'); absent on an older row. */
  baseOrders?: string[];
  /** When the request was built (ISO): a same-day plan's times are from then (hire-use.ts keeps them). */
  builtAt?: string;
  /** sha256 of requestBasisText(the request without the trucks to rent, the frozen loads' ids). */
  fingerprint: string;
  /** Built by pallets for a hire option with bays (buildDispatchRequest withPallets). */
  withPallets: boolean;
  options: HireOptionFacts[];
  /** One-day trucks already rented from each option for the day (their max per day counts them). */
  alreadyRented: Record<string, number>;
}

export function basisFingerprint(request: DispatchRequest, frozenLoadIds: readonly string[] | undefined): string {
  return createHash('sha256').update(requestBasisText(request, frozenLoadIds ?? [])).digest('hex');
}

/** The active hire options of a depot, as the request and the suggestion use them. */
export async function depotHireOptions(tenantId: string, depotId: string, db: Prisma.TransactionClient | typeof prisma = prisma): Promise<HireOptionFacts[]> {
  const rows = await db.hireOption.findMany({ where: { tenantId, depotId, active: true }, orderBy: [{ label: 'asc' }] });
  return rows.map((o) => ({
    id: o.id,
    label: o.label,
    bays: o.bays,
    capacityCases: o.capacityCases,
    payloadKg: o.payloadKg,
    costPerDay: o.costPerDay,
    costPerKm: o.costPerKm,
    maxPerDay: o.maxPerDay,
  }));
}

/** One-day trucks rented from each option for a depot's day (active ones). */
export async function rentedOnDay(tenantId: string, depotId: string, runDate: Date, db: Prisma.TransactionClient | typeof prisma = prisma): Promise<Record<string, number>> {
  const rows = await db.truck.findMany({ where: { tenantId, depotId, onlyOnDate: runDate, active: true, hireOptionId: { not: null } }, select: { hireOptionId: true } });
  const out: Record<string, number> = {};
  for (const r of rows) if (r.hireOptionId) out[r.hireOptionId] = (out[r.hireOptionId] ?? 0) + 1;
  return out;
}

/** The company's today (its time zone). */
export async function companyToday(tenantId: string, db: Prisma.TransactionClient | typeof prisma = prisma): Promise<string> {
  const cfg = await db.tenantConfig.findFirst({ where: { tenantId }, select: { timezone: true } });
  return todayIso(cfg?.timezone || DEFAULT_TZ);
}

/** A delivery day before the company's today: nothing is planned or rented for it any more. */
export const DAY_OVER_TEXT = 'This day is over: no truck can be hired for it any more.';

export type HireStartResult =
  | { started: true; suggestionId: string }
  | { started: false; reason: HireSkip; message: string; suggestionId?: string };

export type HireSkip =
  | 'NOT_FOUND'
  | 'NOT_CURRENT'
  | 'NO_PLAN'
  | 'DAY_OVER'
  | 'NO_OPTIONS'
  | 'NOT_SHORT'
  | 'NOTHING_LEFT'
  | 'RUNNING'
  | 'CANNOT_BUILD'
  | 'PALLET_FACTORS'
  | 'NOTHING_TO_PLAN'
  | 'NO_UNITS'
  | 'BUSY';

const SKIP_TEXT: Record<Exclude<HireSkip, 'CANNOT_BUILD' | 'PALLET_FACTORS'>, string> = {
  NOT_FOUND: 'Plan not found.',
  NOT_CURRENT: 'This plan version is not the one in use (a newer version, or it is being optimized).',
  NO_PLAN: 'This plan version has no plan yet: optimize it first.',
  DAY_OVER: DAY_OVER_TEXT,
  NO_OPTIONS: 'This depot has no trucks to hire. A company admin enters them on the Trucks page (Trucks to hire).',
  NOT_SHORT: 'Nothing is left out because of the fleet: no truck needs to be hired.',
  NOTHING_LEFT: NOTHING_LEFT_TEXT,
  RUNNING: 'The hire check is already running for this plan.',
  NOTHING_TO_PLAN: 'Nothing left to plan: every order is on a locked, loading or dispatched load.',
  NO_UNITS: 'Every truck you can hire for this day is already hired (their max per day).',
  BUSY: 'The route optimizer is busy with other plans, so the hire check did not run. Try again in a few minutes.',
};

function skip(reason: HireSkip, message?: string, suggestionId?: string): HireStartResult {
  return { started: false, reason, message: message ?? SKIP_TEXT[reason as keyof typeof SKIP_TEXT], ...(suggestionId ? { suggestionId } : {}) };
}

/** The orders a plan option delivers: its new loads' and its frozen loads' (by order id). */
function deliveredOrders(details: { loads: { stops: { order_ids: string[] }[] }[]; scope?: { frozenOrderIds?: string[]; frozenLoadOrderIds?: string[] } }): string[] {
  const out = new Set<string>();
  for (const l of details.loads) for (const s of l.stops) for (const o of s.order_ids) out.add(orderIdOf(o));
  for (const o of details.scope?.frozenLoadOrderIds ?? details.scope?.frozenOrderIds ?? []) out.add(orderIdOf(o));
  return [...out].sort();
}

/**
 * The solve admission's key of a depot-day's checks (solve-admission.ts reserveBackground): each depot-day
 * keeps one check waiting for the optimizer, so a company optimizing several depots in quick succession
 * loses none of their automatic checks (review of the hire branch).
 */
export function hireCheckKey(depotId: string, runDate: Date | string): string {
  return `${depotId}|${typeof runDate === 'string' ? runDate.slice(0, 10) : isoOf(runDate)}`;
}

/** A what-if's own attempt at the optimizer: its admission ticket and a cancel switch (a preemption, or the job's own). */
interface Attempt {
  ticket: SolveTicket;
  signal: AbortSignal;
  /** Stop following the job's own switch (the attempt is over). */
  detach(): void;
}

/**
 * Reserve a background solve for one attempt of a what-if: a dispatcher's solve that needs its slot
 * aborts the attempt (onPreempt); the job's own switch (`job`: a new optimization of the day) aborts
 * it too. Null when the optimizer cannot take one more waiting check (one per depot-day, `key`).
 */
function reserveAttempt(tenantId: string, userId: string, job: AbortController, key: string): Attempt | null {
  const attempt = new AbortController();
  const follow = () => attempt.abort((job.signal as AbortSignal & { reason?: unknown }).reason);
  const adm = solveAdmission.reserveBackground(tenantId, userId, () => attempt.abort(), key);
  if (!adm.ok) return null;
  if (job.signal.aborted) follow();
  else job.signal.addEventListener('abort', follow, { once: true });
  return { ticket: adm.ticket, signal: attempt.signal, detach: () => job.signal.removeEventListener('abort', follow) };
}

/**
 * Start the what-if for a plan version (the version in use, with a plan applied). `AFTER_PLAN`: called
 * after a plan job saved its plan; `ASKED`: the dispatcher's "Check hire options". Never throws for a
 * reason to skip: the result says why.
 */
export async function startHireCheck(
  tenantId: string,
  runId: string,
  user: { id: string },
  ip: string | null,
  trigger: 'AFTER_PLAN' | 'ASKED',
): Promise<HireStartResult> {
  const run = await prisma.runPlan.findFirst({ where: { id: runId, tenantId } });
  if (!run) return skip('NOT_FOUND');
  if (isSupersededRun(run) || run.status === 'OPTIMIZING' || run.status === 'ARCHIVED') return skip('NOT_CURRENT');
  if (!run.chosenScenarioId) return skip('NO_PLAN');
  if (isoOf(run.runDate) < (await companyToday(tenantId))) return skip('DAY_OVER');
  const chosen = await prisma.scenarioResult.findFirst({ where: { id: run.chosenScenarioId, runId }, select: { detailsJson: true } });
  const details = isDispatchDetails(chosen?.detailsJson) ? chosen!.detailsJson : null;
  if (!details) return skip('NO_PLAN');
  const options = await depotHireOptions(tenantId, run.depotId);
  if (!options.length) return skip('NO_OPTIONS');
  // Only P1-P3 orders justify renting (owner answer 1): P4/P5 orders left out alone are said plainly.
  const orderPriority = details.scope?.orderPriority ?? null;
  if (!needsHireCheck(details.unserved, orderPriority)) {
    const low = lowPriorityOrders(details.unserved, orderPriority);
    return skip('NOT_SHORT', low ? lowPriorityText(low) : undefined);
  }
  const running = await prisma.hireSuggestion.findFirst({ where: { tenantId, runId, status: { in: ['QUEUED', 'RUNNING'] } }, select: { id: true } });
  if (running) return skip('RUNNING', undefined, running.id);

  const withPallets = options.some((o) => o.bays !== null);
  // Built at a time it keeps: "Use this plan" times a same-day plan's new loads as this request did.
  const builtAt = new Date();
  let built;
  try {
    built = await buildDispatchRequest(tenantId, runId, ['RECOMMENDED'], { withPallets, now: builtAt });
  } catch (e) {
    if (e instanceof PlanError) return skip('CANNOT_BUILD', e.message);
    throw e;
  }
  if (built.missingPalletFactors?.length) {
    const list = built.missingPalletFactors.map((p) => p.productCode).join(', ');
    return skip('PALLET_FACTORS', `The trucks to hire are loaded by pallets, but these products have no cases per pallet: ${list}. Enter them under Products, then check again.`);
  }
  if (!built.request.stops.length) return skip('NOTHING_TO_PLAN');
  const baseUnserved = details.unserved.map((u) => ({ stop_id: u.stop_id, order_ids: u.order_ids, reason_code: u.reason_code }));
  const baseOrders = deliveredOrders(details);
  // Review of the hire branch: every P1-P3 order the plan left out is gone from the day to plan (brought
  // forward to tomorrow, say) and none was added - nothing to hire for; the box stops offering the check.
  const need = hireNeed({ request: built.request, baseUnserved, baseOrders });
  if (!need.leftOut.orders) {
    if (need.low.orders) return skip('NOT_SHORT', lowPriorityText(need.low.orders));
    noteSkipped(runId, 'NOTHING_LEFT', NOTHING_LEFT_TEXT);
    return skip('NOTHING_LEFT');
  }
  const rented = await rentedOnDay(tenantId, run.depotId, run.runDate);
  // Owner answers 2-4: each for the whole day, fuel in the hire, its driver at the company's day rate.
  const hires = hireTrucksForRequest(options, fleetAverages(built.request.trucks), rented, built.settings?.dailyDriverDayRate ?? DEFAULT_DRIVER_DAY_RATE);
  if (!hires.length) return skip('NO_UNITS');
  const request: DispatchRequest = {
    ...built.request,
    // Its own id at the optimizer (its running solves and "stop search" are keyed by it): never the plan's.
    run_id: `${runId}~hire`,
    trucks: [...built.request.trucks, ...hires],
    // The recommended plan only, Quick: the suggestion is its rented trucks.
    config: { ...built.request.config, scenarios: ['RECOMMENDED'], search_mode: 'QUICK', max_search_sec: null },
  };
  const basis: HireBasis = {
    v: 1,
    depotId: run.depotId,
    dateIso: isoOf(run.runDate),
    runVersion: run.version,
    scenarioId: run.chosenScenarioId,
    baseUnserved,
    baseOrders,
    builtAt: builtAt.toISOString(),
    fingerprint: basisFingerprint(built.request, built.scope.frozenLoadIds),
    withPallets,
    options,
    alreadyRented: rented,
  };

  // The optimizer first (review of the hire branch): a check it cannot take is answered BUSY with no
  // row, so a refusal never becomes the newest suggestion and hides a finished one.
  const job = new AbortController();
  const key = hireCheckKey(run.depotId, run.runDate);
  const attempt = reserveAttempt(tenantId, user.id, job, key);
  if (!attempt) return skip('BUSY');
  let row: { id: string } | { other: string };
  try {
    row = await prisma.$transaction(async (tx) => {
      // One check at a time per version: the automatic one and "Check hire options" pressed while it is
      // being prepared both get here; the second finds the first under this lock.
      await tx.$queryRaw`SELECT 1 AS locked FROM pg_advisory_xact_lock(hashtextextended(${`hire-check:${tenantId}|${runId}`}, 0))`;
      const other = await tx.hireSuggestion.findFirst({ where: { tenantId, runId, status: { in: ['QUEUED', 'RUNNING'] } }, select: { id: true } });
      if (other) return { other: other.id };
      const created = await tx.hireSuggestion.create({
        data: {
          tenantId,
          runId,
          status: 'QUEUED',
          trigger,
          message: 'Waiting for the route optimizer',
          basisJson: basis as unknown as Prisma.InputJsonValue,
          requestJson: request as unknown as Prisma.InputJsonValue,
          createdById: user.id,
          heartbeatAt: new Date(),
        },
      });
      await audit(
        {
          tenantId,
          userId: user.id,
          action: 'HIRE_CHECK_STARTED',
          entity: 'HireSuggestion',
          entityId: created.id,
          afterJson: {
            runId,
            version: run.version,
            trigger,
            stops: request.stops.length,
            leftOutStops: basis.baseUnserved.length,
            trucksToRent: hires.map((h) => h.code),
          } as never,
          ip,
        },
        tx,
      );
      return { id: created.id };
    });
  } catch (e) {
    attempt.ticket.release();
    attempt.detach();
    throw e;
  }
  if ('other' in row) {
    attempt.ticket.release();
    attempt.detach();
    return skip('RUNNING', undefined, row.other);
  }
  activeHireJobs.set(row.id, job);
  void runHireJob({ id: row.id, tenantId, runId, userId: user.id, ip, request, basis, job, attempt, key });
  return { started: true, suggestionId: row.id };
}

/** A check not run for this version, kept for the box (hireView): why, until START_NOTE_MS. */
function noteSkipped(runId: string, reason: HireSkip, message: string): void {
  hireStarts.set(runId, { at: Date.now(), skipped: { reason, message } });
}

/** After a plan job saved its plan: start the what-if when the plan needs one. Never throws. */
export async function startHireCheckAfterPlan(tenantId: string, runId: string, userId: string, ip: string | null): Promise<void> {
  // The box says "Checking which trucks to hire" while this runs (hireView checkExpected).
  const now = Date.now();
  for (const [k, v] of hireStarts) if (now - v.at > START_NOTE_MS) hireStarts.delete(k);
  hireStarts.set(runId, { at: now });
  try {
    const r = await startHireCheck(tenantId, runId, { id: userId }, ip, 'AFTER_PLAN');
    const quiet = r.started || r.reason === 'NO_OPTIONS' || r.reason === 'NOT_SHORT' || r.reason === 'NOT_CURRENT' || r.reason === 'DAY_OVER' || r.reason === 'RUNNING';
    if (quiet) hireStarts.delete(runId);
    else if (r.reason === 'NOTHING_LEFT') noteSkipped(runId, r.reason, r.message);
    else {
      hireStarts.set(runId, { at: Date.now(), skipped: { reason: r.reason, message: r.message } });
      console.warn('hire check not started after the plan', { runId, reason: r.reason });
    }
  } catch (err) {
    hireStarts.set(runId, { at: Date.now(), skipped: { reason: 'CANNOT_BUILD', message: 'The hire check could not start.' } });
    console.error('hire check: could not start after the plan', { runId, err: (err as Error)?.message ?? err });
  }
}

interface JobArgs {
  id: string;
  tenantId: string;
  runId: string;
  userId: string;
  ip: string | null;
  request: DispatchRequest;
  basis: HireBasis;
  /** The job's own switch (activeHireJobs): a new optimization of the day stops it for good. */
  job: AbortController;
  attempt: Attempt;
  /** Its depot-day at the solve admission (hireCheckKey). */
  key: string;
}

/** Stopped so a dispatcher's optimization could start at once (its solver slot was taken). */
export const PREEMPTED_TEXT = "Stopped so that a dispatcher's optimization could start at once. Press Check hire options to run it again.";
/** Taken off the optimizer for a dispatcher's optimization, waiting again (once). */
const REQUEUED_TEXT = "Waiting for the route optimizer again: a dispatcher's optimization needed its place.";
/** The version (or its plan option in use) changed while the check waited for a slot. */
const NOT_IN_USE_TEXT = 'Not run: this plan version is no longer the one in use.';
const OTHER_OPTION_TEXT = 'Not run: another plan option is in use now. Press Check hire options to check it.';

class NotRun extends Error {}

/** Why a check that waited for a slot must not run now (its version moved on), or null. */
async function notInUse(a: JobArgs): Promise<string | null> {
  const run = await prisma.runPlan.findFirst({ where: { id: a.runId, tenantId: a.tenantId }, select: { status: true, supersededAt: true, chosenScenarioId: true } });
  if (!run || isSupersededRun(run) || run.status === 'OPTIMIZING' || run.status === 'ARCHIVED') return NOT_IN_USE_TEXT;
  if (run.chosenScenarioId !== a.basis.scenarioId) return OTHER_OPTION_TEXT;
  return null;
}

async function runHireJob(a: JobArgs): Promise<void> {
  const beat = setInterval(() => {
    prisma.hireSuggestion
      .updateMany({ where: { id: a.id, status: { in: ['QUEUED', 'RUNNING'] } }, data: { heartbeatAt: new Date() } })
      .catch(() => undefined);
  }, HIRE_HEARTBEAT_MS);
  beat.unref?.();
  const who = { tenantId: a.tenantId, runId: a.runId, userId: a.userId, ip: a.ip };
  let att = a.attempt;
  let requeued = false;
  try {
    for (;;) {
      const cur = att;
      // Stopped while it waits for a slot: its queue place is given back at once.
      const giveBack = () => cur.ticket.release();
      cur.signal.addEventListener('abort', giveBack, { once: true });
      try {
        if (cur.ticket.waiting) await cur.ticket.ready();
        if (cur.ticket.preempted || cur.signal.aborted) throw new NotRun('cancelled');
        // It may have waited a while (review of the hire branch): a version replaced meanwhile, or
        // another option in use, is not computed - and gives the slot to the next check at once.
        const why = await notInUse(a);
        if (why) {
          await finish(a.id, who, 'CANCELLED', why, { reason: 'NOT_CURRENT' });
          return;
        }
        const now = new Date();
        const started = await prisma.hireSuggestion.updateMany({
          where: { id: a.id, status: 'QUEUED' },
          data: { status: 'RUNNING', startedAt: now, heartbeatAt: now, message: `Checking which trucks to hire: ${a.request.stops.length} stops, Quick search` },
        });
        if (started.count !== 1) return;
        const resp = await callDispatchSolver(a.request, { signal: cur.signal });
        const sc = resp.scenarios?.find((s) => s.name === 'RECOMMENDED') as DispatchScenario | undefined;
        if (!sc || sc.status === 'NO_SOLUTION') throw new SolverError('The hire check found no plan this time. Try again.', 200, null);
        const summary = summarizeHire({ request: a.request, baseUnserved: a.basis.baseUnserved, baseOrders: a.basis.baseOrders, whatIf: sc, options: a.basis.options });
        const text = hireSuggestionText(summary);
        await prisma.$transaction(async (tx) => {
          const n = await tx.hireSuggestion.updateMany({
            where: { id: a.id, status: 'RUNNING' },
            data: {
              status: 'SUCCEEDED',
              finishedAt: new Date(),
              message: text.headline.slice(0, 1000),
              responseJson: resp as unknown as Prisma.InputJsonValue,
              summaryJson: summary as unknown as Prisma.InputJsonValue,
            },
          });
          if (!n.count) return;
          await audit(
            {
              tenantId: a.tenantId,
              userId: a.userId,
              action: 'HIRE_CHECK_FINISHED',
              entity: 'HireSuggestion',
              entityId: a.id,
              afterJson: {
                runId: a.runId,
                status: summary.status,
                hires: summary.hires.map((h) => ({ label: h.label, count: h.count, costPerDay: h.costPerDay })),
                hireCost: summary.hireCost,
                leftOut: { orders: summary.leftOut.orders, cases: summary.leftOut.cases },
                stillLeft: { orders: summary.stillLeft.orders, cases: summary.stillLeft.cases },
                dropped: summary.dropped?.orders ?? 0,
                searchSec: resp.search?.search_sec ?? null,
              } as never,
              ip: a.ip,
            },
            tx,
          );
        });
        return;
      } catch (err) {
        const cancelled =
          err instanceof NotRun || cur.signal.aborted || cur.ticket.preempted || (err instanceof SolverError && err.code === 'CANCELLED');
        if (!cancelled) {
          const message = err instanceof SolverError ? err.message : `The hire check failed: ${(err as Error)?.message ?? String(err)}`;
          console.error('hire check failed', { suggestionId: a.id, runId: a.runId, message });
          await finish(a.id, who, 'FAILED', message, { reason: err instanceof SolverError ? 'SOLVER_ERROR' : 'UNKNOWN', message, ...(err instanceof SolverError && err.code ? { code: err.code } : {}) });
          return;
        }
        // A dispatcher's optimization took its slot (review of the hire branch: a stopped check was
        // never run again): back to the queue, once, unless the job itself was stopped.
        if (cur.ticket.preempted && !a.job.signal.aborted && !requeued) {
          requeued = true;
          cur.ticket.release();
          cur.detach();
          const next = reserveAttempt(a.tenantId, a.userId, a.job, a.key);
          if (next) {
            const back = await prisma.hireSuggestion.updateMany({
              where: { id: a.id, status: { in: ['QUEUED', 'RUNNING'] } },
              data: { status: 'QUEUED', message: REQUEUED_TEXT, heartbeatAt: new Date() },
            });
            att = next;
            if (back.count === 1) continue;
            return;
          }
        }
        await finish(a.id, who, 'CANCELLED', cancelledText(a.job), { reason: 'CANCELLED' });
        return;
      } finally {
        cur.signal.removeEventListener('abort', giveBack);
      }
    }
  } finally {
    clearInterval(beat);
    att.ticket.release();
    att.detach();
    activeHireJobs.delete(a.id);
  }
}

function cancelledText(job: AbortController): string {
  const why = (job.signal as AbortSignal & { reason?: unknown }).reason;
  return job.signal.aborted && typeof why === 'string' && why ? why : PREEMPTED_TEXT;
}

/** End a what-if (only while it is still QUEUED or RUNNING), with its audit row. Never throws. */
async function finish(
  id: string,
  who: { tenantId: string; runId: string; userId: string | null; ip: string | null },
  status: 'FAILED' | 'CANCELLED',
  message: string,
  errorJson: Record<string, unknown>,
): Promise<void> {
  try {
    await prisma.$transaction(async (tx) => {
      const n = await tx.hireSuggestion.updateMany({
        where: { id, status: { in: ['QUEUED', 'RUNNING'] } },
        data: { status, finishedAt: new Date(), message: message.slice(0, 1000), errorJson: errorJson as Prisma.InputJsonValue },
      });
      if (!n.count) return;
      await audit(
        { tenantId: who.tenantId, userId: who.userId, action: 'HIRE_CHECK_FAILED', entity: 'HireSuggestion', entityId: id, afterJson: { runId: who.runId, status, ...errorJson } as never, ip: who.ip },
        tx,
      );
    });
  } catch (err) {
    console.error('hire check: could not record its end', { id, err: (err as Error)?.message ?? err });
  }
}

/**
 * A new plan version, or a new optimization, for a depot's day: its running or waiting what-ifs (of an
 * older version) are stopped - their answer would be for a plan no longer in use.
 */
export async function cancelHireChecksOfDay(tenantId: string, depotId: string, runDate: Date, why: string): Promise<number> {
  try {
    const rows = await prisma.hireSuggestion.findMany({
      where: { tenantId, status: { in: ['QUEUED', 'RUNNING'] }, run: { depotId, runDate } },
      select: { id: true, runId: true },
    });
    for (const r of rows) {
      const ctrl = activeHireJobs.get(r.id);
      if (ctrl) ctrl.abort(why);
      else await finish(r.id, { tenantId, runId: r.runId, userId: null, ip: null }, 'CANCELLED', why, { reason: 'CANCELLED' });
    }
    return rows.length;
  } catch (err) {
    console.error('hire check: could not stop the checks of the day', (err as Error)?.message ?? err);
    return 0;
  }
}

/**
 * The janitor's sweep (and every read): a what-if QUEUED or RUNNING that this process does not run and
 * whose heartbeat is older than HIRE_LOST_AFTER_MS was lost with its process (a restart, a deploy).
 */
export async function failLostHireChecks(now: Date = new Date(), where: Prisma.HireSuggestionWhereInput = {}): Promise<number> {
  const before = new Date(now.getTime() - HIRE_LOST_AFTER_MS);
  const rows = await prisma.hireSuggestion.findMany({
    where: { ...where, status: { in: ['QUEUED', 'RUNNING'] }, OR: [{ heartbeatAt: { lt: before } }, { heartbeatAt: null, createdAt: { lt: before } }] },
    select: { id: true, tenantId: true, runId: true },
    take: 200,
  });
  let n = 0;
  for (const r of rows) {
    if (activeHireJobs.has(r.id)) continue;
    await finish(r.id, { tenantId: r.tenantId, runId: r.runId, userId: null, ip: null }, 'FAILED', 'The hire check stopped (the server restarted). Press Check hire options to run it again.', { reason: 'LOST' });
    n++;
  }
  return n;
}

/**
 * The janitor's sweep: one-day hired trucks whose day is over (before the company's today) are
 * retired (active false; the rows stay: plans, sheets and results name them). Never planned on another
 * day anyway (trucksOfDayWhere). One audit row per company.
 */
export async function retireOneDayTrucks(now: Date = new Date()): Promise<number> {
  const configs = await prisma.tenantConfig.findMany({ select: { tenantId: true, timezone: true } });
  let total = 0;
  for (const c of configs) {
    const today = todayIso(c.timezone || DEFAULT_TZ, now);
    const old = await prisma.truck.findMany({
      where: { tenantId: c.tenantId, active: true, onlyOnDate: { lt: new Date(`${today}T00:00:00.000Z`) } },
      select: { id: true, code: true, onlyOnDate: true },
      take: 500,
    });
    if (!old.length) continue;
    await prisma.$transaction(async (tx) => {
      await tx.truck.updateMany({ where: { tenantId: c.tenantId, id: { in: old.map((t) => t.id) } }, data: { active: false } });
      await audit(
        {
          tenantId: c.tenantId,
          userId: null,
          action: 'ONE_DAY_TRUCKS_RETIRED',
          entity: 'Truck',
          afterJson: { trucks: old.map((t) => ({ id: t.id, code: t.code, date: t.onlyOnDate ? isoOf(t.onlyOnDate) : null })) } as never,
          ip: false,
        },
        tx,
      );
    });
    total += old.length;
  }
  return total;
}

/** What the plan screen shows (GET /api/runs/:id/hire-suggestion). */
export interface HireView {
  /** Active hire options of the plan's depot. */
  options: number;
  /** The plan option in use leaves orders out for a reason a truck more may help. */
  short: boolean;
  /** "Check hire options" can run now (the version in use, with a plan, options set, its day not over). */
  canCheck: boolean;
  /** The day is before the company's today. */
  dayOver: boolean;
  /**
   * A check is on its way although none is shown yet (the plan's job saved its plan a moment ago, and
   * its automatic check is being started): the box polls; otherwise it never says "checking".
   */
  checkExpected: boolean;
  /** Why the automatic check of this plan did not start (products without cases per pallet, ...); null: it did, or none was due. */
  skipNote: string | null;
  /** P4/P5 orders the plan option in use leaves out for a reason a truck more may help: never a reason to rent (owner answer 1). */
  lowLeftOut: number;
  /** The owner's words for them ("Left out: 3 orders, all P4/P5 - renting is not suggested for them."), or null. */
  lowNote: string | null;
  suggestion: null | {
    id: string;
    status: 'QUEUED' | 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'CANCELLED';
    trigger: string;
    message: string | null;
    createdAt: string;
    finishedAt: string | null;
    usedAt: string | null;
    usedRunId: string | null;
    headline: string | null;
    details: string[];
    summary: HireSummary | null;
    /** Computed for another plan option than the one in use now: not offered ("Check hire options" checks the one in use). */
    forOtherOption: boolean;
    /** A newer check that failed or was stopped, shown under this (still usable) suggestion. */
    note: string | null;
    /** "Use this plan" is possible: finished, rents a truck, not used, for the option in use, and the version is still in use. */
    usable: boolean;
  };
}

/**
 * The suggestion the box shows (review of the hire branch): the check running now; else the newest
 * finished one - and when the newest check failed or was stopped after a finished one that was never
 * used, the finished one stays (with the failure as a note): "Check again" never throws a usable
 * suggestion away.
 */
export function shownSuggestion(rows: readonly HireSuggestion[]): { row: HireSuggestion; note: string | null } | null {
  const sorted = [...rows].sort((x, y) => y.createdAt.getTime() - x.createdAt.getTime());
  const active = sorted.find((r) => r.status === 'QUEUED' || r.status === 'RUNNING');
  if (active) return { row: active, note: null };
  const newest = sorted[0];
  if (!newest) return null;
  if (newest.status === 'FAILED' || newest.status === 'CANCELLED') {
    const ok = sorted.find((r) => r.status === 'SUCCEEDED');
    if (ok && !ok.usedAt) return { row: ok, note: newest.message ?? null };
  }
  return { row: newest, note: null };
}

export async function hireView(tenantId: string, runId: string, currency = 'OMR'): Promise<HireView | null> {
  const run = await prisma.runPlan.findFirst({ where: { id: runId, tenantId } });
  if (!run) return null;
  // A what-if lost with its process is shown as stopped, never as running forever.
  await failLostHireChecks(new Date(), { tenantId, runId }).catch(() => 0);
  const [options, chosen, rows, today, job] = await Promise.all([
    prisma.hireOption.count({ where: { tenantId, depotId: run.depotId, active: true } }),
    run.chosenScenarioId ? prisma.scenarioResult.findFirst({ where: { id: run.chosenScenarioId, runId }, select: { detailsJson: true } }) : null,
    prisma.hireSuggestion.findMany({ where: { tenantId, runId }, orderBy: { createdAt: 'desc' }, take: 20 }),
    companyToday(tenantId),
    prisma.runJob.findFirst({ where: { tenantId, runId, status: 'SUCCEEDED' }, orderBy: { finishedAt: 'desc' }, select: { finishedAt: true } }),
  ]);
  const details = isDispatchDetails(chosen?.detailsJson) ? chosen!.detailsJson : null;
  // The automatic check of a plan just saved: being started, or not started and why.
  const note = hireStarts.get(runId);
  // P1-P3 orders left out only (owner answer 1); and not when a check found every one of them gone since.
  const orderPriority = details?.scope?.orderPriority ?? null;
  const short = needsHireCheck(details?.unserved, orderPriority) && note?.skipped?.reason !== 'NOTHING_LEFT';
  const lowLeftOut = lowPriorityOrders(details?.unserved, orderPriority);
  const dayOver = isoOf(run.runDate) < today;
  const live = !isSupersededRun(run) && run.status !== 'OPTIMIZING' && run.status !== 'ARCHIVED' && !!run.chosenScenarioId && !dayOver;
  const shown = shownSuggestion(rows);
  const row = shown?.row ?? null;
  const summary = (row?.summaryJson as HireSummary | null) ?? null;
  const basis = (row?.basisJson as HireBasis | null) ?? null;
  const forOtherOption = !!row && !!basis?.scenarioId && basis.scenarioId !== run.chosenScenarioId;
  const text = summary ? hireSuggestionText(summary, currency) : null;
  const justSaved = !!job?.finishedAt && Date.now() - job.finishedAt.getTime() < HIRE_EXPECT_MS;
  const checkExpected = live && short && options > 0 && !rows.length && ((!!note && !note.skipped) || (!note && justSaved));
  return {
    options,
    short,
    canCheck: live && options > 0,
    dayOver,
    checkExpected,
    skipNote: !rows.length && note?.skipped ? note.skipped.message : null,
    lowLeftOut,
    lowNote: lowLeftOut ? lowPriorityText(lowLeftOut, { also: short }) : null,
    suggestion: row
      ? {
          id: row.id,
          status: row.status,
          trigger: row.trigger,
          message: row.message,
          createdAt: row.createdAt.toISOString(),
          finishedAt: row.finishedAt?.toISOString() ?? null,
          usedAt: row.usedAt?.toISOString() ?? null,
          usedRunId: row.usedRunId,
          headline: text?.headline ?? null,
          details: text?.details ?? [],
          summary,
          forOtherOption,
          note: shown?.note ?? null,
          usable: live && !forOtherOption && row.status === 'SUCCEEDED' && !row.usedAt && summary?.status === 'HIRE' && (summary?.hires.length ?? 0) > 0,
        }
      : null,
  };
}
