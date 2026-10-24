/**
 * Moves by hand (PR M2): the save of a checked change - POST /api/runs/:id/edit. Server only; the check,
 * the pure helpers and the rules are in plan-edit.ts (read its top first).
 *
 * savePlanEdit checks again with the day read as it was at the check (at most 10 minutes later), must
 * find the same preview, and then in ONE transaction, under the intake lock, the day lock and the plan
 * row (the dispatch writers' order, plan-locks.ts):
 *  1. reads the touched trucks again (editBasis): anything of them changed (a load locked, an order in,
 *     another option chosen) answers 409 DAY_CHANGED and nothing is written; a change elsewhere does not;
 *  2. makes version N+1, MANUAL_ADJUSTMENT (createNextVersionTx: every load copied with its rows,
 *     snapshots, driver and helpers, the option in use with its unserved rows; the parent SUPERSEDED);
 *  3. applyPlanEdit: only the edited trucks' PLANNED loads are deleted and made again from the solver's
 *     timetable (materializeLoads), with fresh snapshots for EVERY row of them (critic M4: they were all
 *     re-timed with today's data); drivers and helpers through planCrew with the other trucks' loads kept
 *     as they are (critic M6); the unserved list (a stop taken off: REMOVED_BY_HAND; an order put on: its
 *     row removed), the order statuses, the option merged (mergeOption) and the plan facts again;
 *  4. guards that roll everything back (409 EDIT_CHECK_FAILED): the plan reconciled and no longer does,
 *     the web's own timetable check of an edited truck disagrees with the solver's, or a frozen load moved;
 *  5. the audit ROUTE_MANUALLY_CHANGED (before and after per truck, ids and codes only).
 * After the commit, a hire check of the day is stopped and the salesman link's day is read again.
 */
import { Prisma, type OrderStatus, type RunPlan } from '@prisma/client';
import { prisma } from '../db';
import { audit } from '../audit';
import {
  applyWeightChanges,
  buildDispatchRequest,
  createNextVersionTx,
  materializeLoads,
  planCrew,
  planInputsOf,
  refreshPlanFacts,
  snapshotSource,
  type ScenarioDetails,
} from './plan-service';
import { asPlanBusy, lockPlanDay, lockRunForWrite, setLockTimeout } from './plan-locks';
import { lockIntake } from './intake-server';
import { appliedPlanStatus } from './plan-status';
import { deleteHelpersOfLoads } from './load-helpers-service';
import { cancelHireChecksOfDay } from './hire-whatif';
import { orderIdOf, readPortionLines } from './split';
import { DEFAULT_TZ, fmtHhmm, isoOf, localMinutes } from './time';
import { forgetSalesDay } from '../sales-link/day-read';
import type { DailySummary } from './summary';
import type { Reconciliation } from './reconcile';
import {
  checkPlanEdit,
  EDIT_FROM,
  editBasis,
  manualOf,
  mergeOption,
  PREVIEW_MAX_AGE_MS,
  readEditLoads,
  refuse,
  type EditCheck,
  type EditLoad,
  type ManualEdit,
} from './plan-edit';
import { EDIT_ERROR_TEXT, type PlanEditMove, type PlanEditSaved } from './plan-edit-view';
import type { ExpectedDay } from './start-optimize';
import { PlanError } from './plan-errors';

type Tx = Prisma.TransactionClient;

/** The day changed under the locks: nothing is written. */
class DayChanged extends PlanError {
  constructor() {
    super(EDIT_ERROR_TEXT.DAY_CHANGED, 409, { code: 'DAY_CHANGED' });
  }
}

/** A guard after the writes failed: the transaction rolls back (nothing saved). */
class EditCheckFailed extends PlanError {
  constructor(why: string) {
    const what = why.replace(/[.\s]+$/, '');
    super(`The change could not be saved: ${what}. Nothing was changed. Check the move again; if it happens again, re-plan the day.`, 409, { code: 'EDIT_CHECK_FAILED', why: what });
  }
}

/**
 * Save a checked change as version N+1 (see the top of this file). Refusals are PlanErrors: 409
 * PREVIEW_OLD, PREVIEW_CHANGED (with the new `preview`), MOVE_REFUSED (with the `preview`), ROADS_DOWN,
 * DAY_CHANGED, SUPERSEDED, OPTIMIZING, PLAN_BUSY, EDIT_CHECK_FAILED; and the check's own.
 */
export async function savePlanEdit(
  tenantId: string,
  runId: string,
  input: { move: PlanEditMove; expect?: ExpectedDay; previewHash: string; builtAt: string },
  user: { id: string; name?: string | null },
  ip: string | null,
  opts: { now?: Date } = {},
): Promise<PlanEditSaved> {
  const now = opts.now ?? new Date();
  const builtAt = new Date(input.builtAt);
  const age = now.getTime() - builtAt.getTime();
  // A minute of clock difference is allowed the other way; never a check from the future.
  if (!Number.isFinite(age) || age < -60_000 || age > PREVIEW_MAX_AGE_MS) throw refuse(409, 'PREVIEW_OLD', EDIT_ERROR_TEXT.PREVIEW_OLD);
  const check = await checkPlanEdit(tenantId, runId, { move: input.move, expect: input.expect, now: builtAt, mode: 'ON' });
  if (check.preview.previewHash !== input.previewHash) throw refuse(409, 'PREVIEW_CHANGED', EDIT_ERROR_TEXT.PREVIEW_CHANGED, { preview: check.preview });
  if (!check.answer.ok || !check.answer.scenario) throw refuse(409, 'MOVE_REFUSED', 'This change breaks a rule and cannot be saved.', { preview: check.preview });
  if (!check.preview.canSave) throw refuse(409, 'ROADS_DOWN', check.preview.saveNote ?? EDIT_ERROR_TEXT.ROADS_DOWN, { preview: check.preview });
  const { run } = check;
  let saved: { child: RunPlan; reprint: string[]; gone: string[] };
  try {
    saved = await prisma.$transaction(
      async (tx) => {
        await setLockTimeout(tx);
        await lockIntake(tx, tenantId);
        await lockPlanDay(tx, tenantId, run.depotId, run.runDate);
        const locked = await lockRunForWrite(tx, tenantId, runId, { allow: EDIT_FROM, optimizingMessage: 'An optimization is running for this plan. Wait for it to finish.' });
        if (await tx.runJob.count({ where: { runId, status: { in: ['QUEUED', 'RUNNING'] } } })) throw refuse(409, 'OPTIMIZING', 'An optimization is running for this plan. Wait for it to finish.');
        if (locked.chosenScenarioId !== run.chosenScenarioId) throw new DayChanged();
        // The touched trucks read again under the locks (critic M2): the same basis, or nothing is written.
        const again = await buildDispatchRequest(tenantId, runId, ['RECOMMENDED'], { now: builtAt });
        const loadsNow = await readEditLoads(tx, tenantId, runId);
        const unservedNow = check.placedOrderIds.length
          ? await tx.unservedOrder.findMany({ where: { scenarioId: run.chosenScenarioId!, orderId: { in: check.placedOrderIds } }, select: { orderId: true, reasonCode: true, portionLinesJson: true } })
          : [];
        const basisNow = editBasis({ request: again.request, edited: check.edit.edited, stopIds: stopIdsOf(check), loads: loadsNow, chosenScenarioId: locked.chosenScenarioId, unserved: unservedNow });
        if (basisNow !== check.basis) throw new DayChanged();

        const { child } = await createNextVersionTx(tx, tenantId, runId, 'MANUAL_ADJUSTMENT', `By hand: ${check.preview.title}`.slice(0, 500), user.id);
        // The edited orders' kg as the solver was sent them (usually nothing to do).
        const orders = editedOrderIds(check);
        await applyWeightChanges(
          tx,
          tenantId,
          child.id,
          { lines: check.built.weightChanges.lines.filter((c) => orders.has(c.orderId)), orders: check.built.weightChanges.orders.filter((c) => orders.has(c.orderId)) },
          user.id,
        );
        const applied = await applyPlanEdit(tx, tenantId, { child, parent: locked, check, user, at: now });
        await audit({ tenantId, userId: user.id, action: 'ROUTE_MANUALLY_CHANGED', entity: 'RunPlan', entityId: child.id, beforeJson: applied.before as never, afterJson: applied.after as never, ip }, tx);
        return { child, reprint: applied.reprint, gone: applied.gone };
      },
      { timeout: 60_000, maxWait: 10_000 },
    );
  } catch (e) {
    throw asPlanBusy(e);
  }
  // After the commit: a hire check of the day was for the version just replaced; the salesman link reads the new one at once.
  await cancelHireChecksOfDay(tenantId, run.depotId, run.runDate, 'Stopped: the plan was changed by hand (new version), so this check was for a plan no longer in use.');
  forgetSalesDay(tenantId, isoOf(run.runDate));
  return {
    runId: saved.child.id,
    version: saved.child.version,
    reprint: saved.reprint,
    gone: saved.gone,
    trucks: check.edit.edited.map((t) => check.preview.trucks.find((x) => x.truckId === t)?.truckCode ?? t),
  };
}

/** The request stops the check depended on: the edited trucks' before and after, and the stop moved. */
export function stopIdsOf(check: Pick<EditCheck, 'movedStop' | 'edit'>): Set<string> {
  return new Set<string>([check.movedStop, ...[...check.edit.before.values(), ...check.edit.after.values()].flat(2)]);
}

/** Every order the change re-times, takes off or puts on. */
function editedOrderIds(check: EditCheck): Set<string> {
  const edited = new Set(check.edit.edited);
  return new Set([
    ...check.placedOrderIds,
    ...check.loads.filter((l) => edited.has(l.truckId) && l.status === 'PLANNED').flatMap((l) => l.rows.map((r) => r.orderId)),
  ]);
}

/** A load as the audit row keeps it: ids, codes and figures only. */
function auditLoad(l: { loadNo: number; status: string; departMin: number; returnMin: number; distanceKm: number; operatingCost: number; cases: number; palletUnits: number | null; stops: { sequence: number; customerId: string; orderIds: string[] }[] }) {
  return { loadNo: l.loadNo, status: l.status, departMin: l.departMin, returnMin: l.returnMin, km: l.distanceKm, costOmr: l.operatingCost, cases: l.cases, palletUnits: l.palletUnits, stops: l.stops };
}

function storedStops(l: EditLoad) {
  const by = new Map<number, { sequence: number; customerId: string; orderIds: string[] }>();
  for (const r of l.rows) {
    const s = by.get(r.sequenceInTruck) ?? { sequence: r.sequenceInTruck, customerId: r.customerId, orderIds: [] };
    s.orderIds.push(r.orderId);
    by.set(r.sequenceInTruck, s);
  }
  return [...by.values()].sort((a, b) => a.sequence - b.sequence);
}

/**
 * The writes of a save on the new version `child` (step 3 and 4 at the top). Returns the audit row's
 * before and after, and the loads whose sheets must be printed again.
 */
export async function applyPlanEdit(
  tx: Tx,
  tenantId: string,
  args: { child: RunPlan; parent: RunPlan; check: EditCheck; user: { id: string; name?: string | null }; at: Date },
): Promise<{ before: Record<string, unknown>; after: Record<string, unknown>; reprint: string[]; gone: string[] }> {
  const { child, parent, check, user, at } = args;
  const sc = check.answer.scenario!;
  const edited = new Set(check.edit.edited);
  const childLoads = await tx.planLoad.findMany({ where: { runId: child.id, tenantId }, select: { id: true, truckId: true, loadNo: true, status: true, departMin: true, returnMin: true, _count: { select: { assignments: true } } } });
  const replaced = childLoads.filter((l) => edited.has(l.truckId) && l.status === 'PLANNED');
  const frozenBefore = JSON.stringify(childLoads.filter((l) => l.status !== 'PLANNED').map((l) => [l.id, l.status, l.departMin, l.returnMin, l._count.assignments]).sort());
  const replacedKeys = new Set(replaced.map((l) => `${l.truckId}:${l.loadNo}`));
  const option = await tx.scenarioResult.findFirstOrThrow({ where: { id: child.chosenScenarioId!, runId: child.id } });
  const copied = option.detailsJson as unknown as ScenarioDetails;

  // The option in use with the edited trucks re-timed (refs mapped back, critic M3).
  const frozenTruckIds = childLoads.filter((l) => l.status !== 'PLANNED').map((l) => l.truckId);
  const manual: ManualEdit = {
    v: 1,
    at: at.toISOString(),
    byUserId: user.id,
    parentRunId: parent.id,
    count: (manualOf(copied)?.count ?? 0) + 1,
    move: check.move,
    trucks: check.edit.edited,
    builtAt: check.preview.builtAt,
    matrix: check.preview.matrix,
    previewHash: check.preview.previewHash,
    preferenceApprox: true,
  };
  const clock = fmtHhmm(localMinutes(at, check.built.settings?.timezone || DEFAULT_TZ));
  const removedWhy = `Taken off the plan by hand (${user.name || 'a dispatcher'}). Put on a truck puts it back; a RE-PLAN plans it again.`;
  const merged = mergeOption({
    copied,
    sc,
    edited,
    replacedKeys,
    refMap: check.refMap,
    freshScope: check.built.scope,
    frozenTruckIds,
    truckOrder: check.built.request.trucks.map((t) => t.id),
    manual,
    warning: `Changed by hand by ${user.name || 'a dispatcher'} at ${clock}: ${check.preview.title}.`,
    unserved: {
      placedOrderIds: check.placedOrderIds,
      removed:
        check.move.kind === 'REMOVE'
          ? { stop_id: check.movedStop, order_ids: check.built.request.stops.find((s) => s.stop_id === check.movedStop)?.order_ids ?? check.removedRows.map((r) => r.orderId), reason_message: removedWhy }
          : null,
    },
  });

  // Drivers and helpers of the re-timed trucks; every other truck's loads keep theirs (critic M6).
  const keepTrucks = new Set(childLoads.map((l) => l.truckId).filter((t) => !edited.has(t)));
  const crew = await planCrew(tx, tenantId, child, merged.loads, { keepTrucks });
  await deleteHelpersOfLoads(tx, tenantId, replaced.map((l) => l.id));
  if (replaced.length) await tx.planLoad.deleteMany({ where: { runId: child.id, tenantId, id: { in: replaced.map((l) => l.id) } } });
  await tx.routeAssignment.deleteMany({ where: { runId: child.id, loadId: null } });

  // Every row of the re-timed trucks gets today's facts (critic M4): the option's own inputs stay the plan's.
  const inputs = planInputsOf(check.built, null);
  const evalDetails: ScenarioDetails = {
    ...merged.details,
    cost_version: sc.cost_version ?? merged.details.cost_version,
    pallet_unit: sc.pallet_unit,
    pallet_fill_pct: sc.pallet_fill_pct,
    single_customer_fill_pct: sc.single_customer_fill_pct,
    window_rule: sc.window_rule,
    break_rule: sc.break_rule,
    latest_return_min: sc.latest_return_min,
    distance_is_estimated: merged.details.distance_is_estimated || check.answer.distance_is_estimated,
    ...(inputs ? { inputs } : {}),
  };
  const orderIds = [...new Set(merged.loads.flatMap((l) => l.stops.flatMap((s) => s.order_ids.map(orderIdOf))))];
  const { kgMismatches, palletMismatches } = await materializeLoads(tx, tenantId, child.id, evalDetails, merged.loads, {
    orderIds,
    snap: await snapshotSource(tx, tenantId, child.depotId, evalDetails, crew.trucks),
    crew,
  });

  // The unserved list and the order statuses.
  const movable = { notIn: ['DISPATCHED', 'DELIVERED'] as OrderStatus[] };
  if (check.placedOrderIds.length) {
    await tx.unservedOrder.deleteMany({ where: { scenarioId: option.id, orderId: { in: check.placedOrderIds } } });
    await tx.order.updateMany({ where: { tenantId, id: { in: check.placedOrderIds }, status: movable }, data: { status: 'ASSIGNED' } });
  }
  if (check.removedRows.length) {
    const why = removedWhy;
    await tx.unservedOrder.createMany({
      data: check.removedRows.map((r) => ({
        scenarioId: option.id,
        orderId: r.orderId,
        reasonCode: 'REMOVED_BY_HAND' as const,
        reasonMessage: why,
        portionCases: r.portionCases,
        portionWeightKg: r.portionWeightKg,
        portionLinesJson: readPortionLines(r.portionLinesJson) ? (r.portionLinesJson as Prisma.InputJsonValue) : Prisma.DbNull,
      })),
    });
    // An order with a part still on a load stays ASSIGNED (a split order counts as assigned).
    const stillOn = new Set((await tx.routeAssignment.findMany({ where: { runId: child.id, orderId: { in: check.removedRows.map((r) => r.orderId) } }, select: { orderId: true } })).map((r) => r.orderId));
    const off = [...new Set(check.removedRows.map((r) => r.orderId))].filter((id) => !stillOn.has(id));
    if (off.length) await tx.order.updateMany({ where: { tenantId, id: { in: off }, status: movable }, data: { status: 'UNSERVED' } });
  }

  // The option in use: the merged details and its columns, counted over the merged loads.
  const unservedCount = new Set((await tx.unservedOrder.findMany({ where: { scenarioId: option.id }, select: { orderId: true } })).map((u) => u.orderId)).size;
  const d = merged.details;
  await tx.scenarioResult.update({
    where: { id: option.id },
    data: {
      detailsJson: d as never,
      trucksUsed: d.trucks_used,
      totalDistanceKm: d.total_distance_km,
      totalTimeMin: d.total_duration_min,
      totalCost: d.operating_cost,
      avgUtilizationPct: d.avg_utilization_pct,
      unservedCount,
    },
  });
  const next = appliedPlanStatus((await tx.planLoad.findMany({ where: { runId: child.id }, select: { status: true } })).map((l) => l.status));
  const wrote = await tx.runPlan.updateMany({ where: { id: child.id, tenantId, status: { not: 'SUPERSEDED' }, supersededAt: null }, data: { status: next, finalizedAt: next === 'DISPATCHED' ? (child.finalizedAt ?? new Date()) : null } });
  if (wrote.count !== 1) throw refuse(409, 'SUPERSEDED', 'This plan version was superseded by a newer version. Open the latest version.');
  // The driver and helper notes: the other trucks' as they were, the edited trucks' from this change.
  const kept = child.summaryJson as unknown as DailySummary | null;
  const facts = await refreshPlanFacts(tx, tenantId, child.id, {
    driverChanges: [...(kept?.driverChanges ?? []).filter((c) => !edited.has(c.truckId)), ...crew.driverChanges],
    helperChanges: [...(kept?.helperChanges ?? []).filter((c) => !edited.has(c.truckId)), ...crew.helperChanges],
  });

  // Guards (critic M10): any of them rolls the whole save back.
  const parentRecon = parent.reconciliationJson as unknown as Reconciliation | null;
  if (parentRecon?.ok && facts && !facts.recon.ok) throw new EditCheckFailed('the plan would no longer reconcile with the orders');
  const loadsAfter = await tx.planLoad.findMany({ where: { runId: child.id, tenantId }, select: { id: true, truckId: true, loadNo: true, status: true, departMin: true, returnMin: true, distanceKm: true, operatingCost: true, cases: true, palletUnits: true, truck: { select: { code: true } }, _count: { select: { assignments: true } } } });
  const newIds = new Set(loadsAfter.filter((l) => edited.has(l.truckId) && l.status === 'PLANNED').map((l) => l.id));
  const feas = facts?.feasibility ?? null;
  const disagree = (feas?.violations ?? []).filter((v) => v.severity === 'BLOCK' && !v.frozen && !!v.truckId && edited.has(v.truckId) && (v.loadId === null || newIds.has(v.loadId)));
  if (disagree.length) {
    console.error('plan edit: the web timetable check disagrees with the solver', { runId: child.id, violations: disagree.map((v) => ({ code: v.code, truckId: v.truckId, loadNo: v.loadNo })) });
    throw new EditCheckFailed(`the timetable check found ${disagree.map((v) => v.message).join(' ')}`);
  }
  const frozenAfter = JSON.stringify(loadsAfter.filter((l) => l.status !== 'PLANNED').map((l) => [l.id, l.status, l.departMin, l.returnMin, l._count.assignments]).sort());
  if (frozenAfter !== frozenBefore) throw new EditCheckFailed('a locked or dispatched load would have changed');
  if (kgMismatches.length || palletMismatches.length) console.warn('plan edit: load kg or pallets differ from the optimizer', { runId: child.id, kgMismatches, palletMismatches });

  // The audit row: before and after per edited truck (ids, codes, figures).
  const rowsAfter = await tx.routeAssignment.findMany({ where: { runId: child.id, loadId: { in: [...newIds] } }, select: { loadId: true, sequenceInTruck: true, orderId: true, order: { select: { customerId: true } } }, orderBy: [{ sequenceInTruck: 'asc' }, { orderInStop: 'asc' }] });
  const stopsAfter = (loadId: string) => {
    const by = new Map<number, { sequence: number; customerId: string; orderIds: string[] }>();
    for (const r of rowsAfter.filter((x) => x.loadId === loadId)) {
      const s = by.get(r.sequenceInTruck) ?? { sequence: r.sequenceInTruck, customerId: r.order.customerId, orderIds: [] };
      s.orderIds.push(r.orderId);
      by.set(r.sequenceInTruck, s);
    }
    return [...by.values()];
  };
  const code = (truckId: string) => check.preview.trucks.find((t) => t.truckId === truckId)?.truckCode ?? truckId;
  const before = {
    runId: parent.id,
    version: parent.version,
    trucks: check.edit.edited.map((t) => ({
      truckId: t,
      truckCode: code(t),
      loads: check.loads.filter((l) => l.truckId === t).map((l) => auditLoad({ ...l, stops: storedStops(l) })),
    })),
  };
  const fromStop = check.move.kind === 'PLACE' ? null : check.loads.find((l) => l.id === (check.move as { from: { loadId: string } }).from.loadId) ?? null;
  const stopRows = fromStop && check.move.kind !== 'PLACE' ? fromStop.rows.filter((r) => r.sequenceInTruck === (check.move as { from: { sequence: number } }).from.sequence) : [];
  const movedTo = sc.loads.flatMap((l) => l.stops.filter((s) => s.stop_id === check.movedStop).map((s) => ({ truckId: l.truck_id, truckCode: code(l.truck_id), loadNo: l.load_no, position: s.sequence })))[0] ?? null;
  const after = {
    parentRunId: parent.id,
    runId: child.id,
    version: child.version,
    reason: 'MANUAL_ADJUSTMENT',
    move: {
      kind: check.move.kind,
      orderIds: check.move.kind === 'PLACE' ? check.placedOrderIds : stopRows.map((r) => r.orderId),
      customerId: check.built.request.stops.find((s) => s.stop_id === check.movedStop)?.customer_id ?? null,
      from: fromStop && check.move.kind !== 'PLACE' ? { truckId: fromStop.truckId, truckCode: fromStop.truckCode, loadNo: fromStop.loadNo, sequence: check.move.from.sequence } : 'UNSERVED',
      to: check.move.kind === 'REMOVE' ? 'UNSERVED' : movedTo,
    },
    trucks: check.edit.edited.map((t) => ({
      truckId: t,
      truckCode: code(t),
      loads: loadsAfter.filter((l) => l.truckId === t).sort((a, b) => a.loadNo - b.loadNo).map((l) => auditLoad({ ...l, stops: newIds.has(l.id) ? stopsAfter(l.id) : [] })),
    })),
    costDeltaOmr: check.answer.delta_money_omr ?? null,
    kmDelta: check.answer.delta_km ?? null,
    softWarnings: check.preview.warnings.length,
    dataChanged: check.preview.dataChanged.length,
    matrix: check.preview.matrix,
    previewHash: check.preview.previewHash,
    builtAt: check.preview.builtAt,
    ...(crew.driverChanges.length ? { driverChanges: crew.driverChanges.map((c) => ({ truckId: c.truckId, loadNo: c.loadNo, from: c.from?.id ?? null, to: c.to?.id ?? null, reason: c.reason })) } : {}),
    ...(kgMismatches.length ? { loadKgMismatches: kgMismatches } : {}),
  };
  const reprint = loadsAfter
    .filter((l) => newIds.has(l.id))
    .sort((a, b) => a.truck.code.localeCompare(b.truck.code) || a.loadNo - b.loadNo)
    .map((l) => `${code(l.truckId)} L${l.loadNo}`);
  // The edited trucks' Planned loads that are no longer there (a truck left with fewer loads): their sheets are void.
  const gone = replaced
    .map((l) => `${code(l.truckId)} L${l.loadNo}`)
    .filter((t) => !reprint.includes(t))
    .sort();
  return { before, after, reprint, gone };
}

