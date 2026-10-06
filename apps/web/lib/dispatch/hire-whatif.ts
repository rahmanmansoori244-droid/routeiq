/**
 * The hire suggestion's what-if job (owner request 6 Oct 2026). Server only.
 *
 * When a plan (OPTIMIZE or RE-PLAN, any day) leaves orders out for a reason a truck more can help
 * (hire.ts CAPACITY_REASONS) and its depot has active hire options, startHireCheck runs a what-if:
 * the same request as a re-plan of that version (frozen loads stay exactly as they are) plus one truck
 * per unit the day may still rent, the recommended plan only, Quick search. It is its own job
 * (HireSuggestion, never the plan's RunJob) on the same solve admission as every optimization, as a
 * BACKGROUND solve (solve-admission.ts reserveBackground): no hourly quota, and a dispatcher's solve
 * that needs its slot takes it at once (the what-if is cancelled: "Check hire options" runs it again).
 * It never changes the plan: only "Use this plan" (hire-use.ts) does.
 */
import { createHash } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import type { DispatchRequest, DispatchScenario } from '@routeiq/shared-types';
import { prisma } from '../db';
import { audit } from '../audit';
import { callDispatchSolver, SolverError } from '../solver-client';
import { solveAdmission, type SolveTicket } from './solve-admission';
import { buildDispatchRequest, isDispatchDetails, PlanError } from './plan-service';
import { isSupersededRun } from './plan-status';
import {
  fleetAverages,
  hireSuggestionText,
  hireTrucksForRequest,
  needsHireCheck,
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

const g = globalThis as unknown as { __routeiqHireJobs?: Map<string, AbortController> };
/** The what-ifs this process runs (suggestion id -> its cancel switch). */
export const activeHireJobs: Map<string, AbortController> = (g.__routeiqHireJobs ??= new Map());

/** What a what-if was computed from (HireSuggestion.basisJson): "Use this plan" compares it with the day now. */
export interface HireBasis {
  v: 1;
  depotId: string;
  dateIso: string;
  runVersion: number;
  /** The plan option in use when it was computed, and its unserved stops. */
  scenarioId: string;
  baseUnserved: { stop_id: string; order_ids: string[]; reason_code: string }[];
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

export type HireStartResult =
  | { started: true; suggestionId: string }
  | { started: false; reason: HireSkip; message: string; suggestionId?: string };

export type HireSkip =
  | 'NOT_FOUND'
  | 'NOT_CURRENT'
  | 'NO_PLAN'
  | 'NO_OPTIONS'
  | 'NOT_SHORT'
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
  NO_OPTIONS: 'This depot has no trucks to hire. A company admin enters them on the Trucks page (Trucks to hire).',
  NOT_SHORT: 'Nothing is left out because of the fleet: no truck needs to be hired.',
  RUNNING: 'The hire check is already running for this plan.',
  NOTHING_TO_PLAN: 'Nothing left to plan: every order is on a locked, loading or dispatched load.',
  NO_UNITS: 'Every truck you can hire for this day is already hired (their max per day).',
  BUSY: 'The route optimizer is busy with other plans, so the hire check did not run. Try again in a few minutes.',
};

function skip(reason: HireSkip, message?: string, suggestionId?: string): HireStartResult {
  return { started: false, reason, message: message ?? SKIP_TEXT[reason as keyof typeof SKIP_TEXT], ...(suggestionId ? { suggestionId } : {}) };
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
  const chosen = await prisma.scenarioResult.findFirst({ where: { id: run.chosenScenarioId, runId }, select: { detailsJson: true } });
  const details = isDispatchDetails(chosen?.detailsJson) ? chosen!.detailsJson : null;
  if (!details) return skip('NO_PLAN');
  const options = await depotHireOptions(tenantId, run.depotId);
  if (!options.length) return skip('NO_OPTIONS');
  if (!needsHireCheck(details.unserved)) return skip('NOT_SHORT');
  const running = await prisma.hireSuggestion.findFirst({ where: { tenantId, runId, status: { in: ['QUEUED', 'RUNNING'] } }, select: { id: true } });
  if (running) return skip('RUNNING', undefined, running.id);

  const withPallets = options.some((o) => o.bays !== null);
  let built;
  try {
    built = await buildDispatchRequest(tenantId, runId, ['RECOMMENDED'], { withPallets });
  } catch (e) {
    if (e instanceof PlanError) return skip('CANNOT_BUILD', e.message);
    throw e;
  }
  if (built.missingPalletFactors?.length) {
    const list = built.missingPalletFactors.map((p) => p.productCode).join(', ');
    return skip('PALLET_FACTORS', `The trucks to hire are loaded by pallets, but these products have no cases per pallet: ${list}. Enter them under Products, then check again.`);
  }
  if (!built.request.stops.length) return skip('NOTHING_TO_PLAN');
  const rented = await rentedOnDay(tenantId, run.depotId, run.runDate);
  const hires = hireTrucksForRequest(options, fleetAverages(built.request.trucks, built.request.config?.fuel_price_per_litre ?? 0), rented);
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
    baseUnserved: details.unserved.map((u) => ({ stop_id: u.stop_id, order_ids: u.order_ids, reason_code: u.reason_code })),
    fingerprint: basisFingerprint(built.request, built.scope.frozenLoadIds),
    withPallets,
    options,
    alreadyRented: rented,
  };

  const row = await prisma.$transaction(async (tx) => {
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
    return created;
  });

  const ctrl = new AbortController();
  const adm = solveAdmission.reserveBackground(tenantId, user.id, () => ctrl.abort());
  if (!adm.ok) {
    await finish(row.id, { tenantId, runId, userId: user.id, ip }, 'FAILED', SKIP_TEXT.BUSY, { reason: 'BUSY' });
    return skip('BUSY', undefined, row.id);
  }
  activeHireJobs.set(row.id, ctrl);
  void runHireJob({ id: row.id, tenantId, runId, userId: user.id, ip, request, basis, ticket: adm.ticket, ctrl });
  return { started: true, suggestionId: row.id };
}

/** After a plan job saved its plan: start the what-if when the plan needs one. Never throws. */
export async function startHireCheckAfterPlan(tenantId: string, runId: string, userId: string, ip: string | null): Promise<void> {
  try {
    const r = await startHireCheck(tenantId, runId, { id: userId }, ip, 'AFTER_PLAN');
    if (!r.started && r.reason !== 'NO_OPTIONS' && r.reason !== 'NOT_SHORT' && r.reason !== 'NOT_CURRENT') {
      console.warn('hire check not started after the plan', { runId, reason: r.reason });
    }
  } catch (err) {
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
  ticket: SolveTicket;
  ctrl: AbortController;
}

/** Stopped so a dispatcher's optimization could start at once (its solver slot was taken). */
export const PREEMPTED_TEXT = "Stopped so that a dispatcher's optimization could start at once. Press Check hire options to run it again.";

async function runHireJob(a: JobArgs): Promise<void> {
  const beat = setInterval(() => {
    prisma.hireSuggestion
      .updateMany({ where: { id: a.id, status: { in: ['QUEUED', 'RUNNING'] } }, data: { heartbeatAt: new Date() } })
      .catch(() => undefined);
  }, HIRE_HEARTBEAT_MS);
  beat.unref?.();
  const who = { tenantId: a.tenantId, runId: a.runId, userId: a.userId, ip: a.ip };
  // Stopped while it waits for a slot (a new optimization of the day): its queue place is given back at once.
  a.ctrl.signal.addEventListener('abort', () => a.ticket.release(), { once: true });
  try {
    if (a.ticket.waiting) await a.ticket.ready();
    if (a.ticket.preempted || a.ctrl.signal.aborted) {
      await finish(a.id, who, 'CANCELLED', cancelledText(a.ctrl), { reason: 'CANCELLED' });
      return;
    }
    const now = new Date();
    const started = await prisma.hireSuggestion.updateMany({
      where: { id: a.id, status: 'QUEUED' },
      data: { status: 'RUNNING', startedAt: now, heartbeatAt: now, message: `Checking which trucks to hire: ${a.request.stops.length} stops, Quick search` },
    });
    if (started.count !== 1) return;
    const resp = await callDispatchSolver(a.request, { signal: a.ctrl.signal });
    const sc = resp.scenarios?.find((s) => s.name === 'RECOMMENDED') as DispatchScenario | undefined;
    if (!sc || sc.status === 'NO_SOLUTION') throw new SolverError('The hire check found no plan this time. Try again.', 200, null);
    const summary = summarizeHire({ request: a.request, baseUnserved: a.basis.baseUnserved, whatIf: sc, options: a.basis.options });
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
            searchSec: resp.search?.search_sec ?? null,
          } as never,
          ip: a.ip,
        },
        tx,
      );
    });
  } catch (err) {
    const cancelled = a.ctrl.signal.aborted || a.ticket.preempted || (err instanceof SolverError && err.code === 'CANCELLED');
    if (cancelled) await finish(a.id, who, 'CANCELLED', cancelledText(a.ctrl), { reason: 'CANCELLED' });
    else {
      const message = err instanceof SolverError ? err.message : `The hire check failed: ${(err as Error)?.message ?? String(err)}`;
      console.error('hire check failed', { suggestionId: a.id, runId: a.runId, message });
      await finish(a.id, who, 'FAILED', message, { reason: err instanceof SolverError ? 'SOLVER_ERROR' : 'UNKNOWN', message, ...(err instanceof SolverError && err.code ? { code: err.code } : {}) });
    }
  } finally {
    clearInterval(beat);
    a.ticket.release();
    activeHireJobs.delete(a.id);
  }
}

function cancelledText(ctrl: AbortController): string {
  const why = (ctrl.signal as AbortSignal & { reason?: unknown }).reason;
  return typeof why === 'string' && why ? why : PREEMPTED_TEXT;
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
 * A new optimization started for a depot's day: its running or waiting what-ifs (of an older version)
 * are stopped - their answer would be for a plan no longer in use.
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
  /** The plan in use leaves orders out for a reason a truck more can help. */
  short: boolean;
  /** "Check hire options" can run now (the version in use, with a plan, options set). */
  canCheck: boolean;
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
    /** "Use this plan" is possible: finished, rents a truck, not used, and the version is still in use. */
    usable: boolean;
  };
}

export async function hireView(tenantId: string, runId: string, currency = 'OMR'): Promise<HireView | null> {
  const run = await prisma.runPlan.findFirst({ where: { id: runId, tenantId } });
  if (!run) return null;
  // A what-if lost with its process is shown as stopped, never as running forever.
  await failLostHireChecks(new Date(), { tenantId, runId }).catch(() => 0);
  const [options, chosen, row] = await Promise.all([
    prisma.hireOption.count({ where: { tenantId, depotId: run.depotId, active: true } }),
    run.chosenScenarioId ? prisma.scenarioResult.findFirst({ where: { id: run.chosenScenarioId, runId }, select: { detailsJson: true } }) : null,
    prisma.hireSuggestion.findFirst({ where: { tenantId, runId }, orderBy: { createdAt: 'desc' } }),
  ]);
  const details = isDispatchDetails(chosen?.detailsJson) ? chosen!.detailsJson : null;
  const short = needsHireCheck(details?.unserved);
  const live = !isSupersededRun(run) && run.status !== 'OPTIMIZING' && run.status !== 'ARCHIVED' && !!run.chosenScenarioId;
  const summary = (row?.summaryJson as HireSummary | null) ?? null;
  const text = summary ? hireSuggestionText(summary, currency) : null;
  return {
    options,
    short,
    canCheck: live && options > 0,
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
          usable: live && row.status === 'SUCCEEDED' && !row.usedAt && summary?.status === 'HIRE' && (summary?.hires.length ?? 0) > 0,
        }
      : null,
  };
}
