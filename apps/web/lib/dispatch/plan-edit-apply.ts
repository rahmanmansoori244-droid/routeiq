/**
 * Moves by hand (PR M2, part 2 of 24-25 Oct 2026): the save of a checked change - POST /api/runs/:id/edit.
 * Server only; the check, the pure helpers and the rules are in plan-edit.ts (read its top first).
 *
 * savePlanEdit checks again with the day read as it was at the check (at most 10 minutes later), must
 * find the same preview, and then in ONE transaction, under the intake lock, the day lock and the plan
 * row (the dispatch writers' order, plan-locks.ts):
 *  1. reads the touched trucks again (editBasis): anything of them changed (a load locked, an order in,
 *     another option chosen, an allowance by hand) answers 409 DAY_CHANGED and nothing is written; a
 *     change elsewhere does not;
 *  2. makes version N+1, MANUAL_ADJUSTMENT (createNextVersionTx: every load copied with its rows,
 *     snapshots, driver and helpers, the option in use with its unserved rows; the parent SUPERSEDED);
 *  3. applyPlanEdit: only the edited trucks' PLANNED loads are deleted and made again from the solver's
 *     timetable (materializeLoads) - the relaxed one when rules are allowed by hand, each allowance kept
 *     on its new load (truckSnapshotJson.handAllowed) - with fresh snapshots for EVERY row of them (critic
 *     M4: they were all re-timed with today's data); drivers and helpers through planCrew with the other
 *     trucks' loads kept as they are (critic M6: drivers stay with their trucks); the unserved list (the
 *     stops taken off: REMOVED_BY_HAND; the orders put on: their rows removed), the order statuses, the
 *     option merged (mergeOption) and the plan facts again;
 *  4. guards that roll everything back (409 EDIT_CHECK_FAILED): the plan reconciled and no longer does,
 *     the web's own timetable check of an edited truck disagrees with the solver's (an allowed issue is a
 *     warning there), or a frozen load moved;
 *  5. the audit ROUTE_MANUALLY_CHANGED (before and after per truck, ids and codes only, the change list,
 *     the rules allowed by hand) and RULE_ALLOWED_BY_HAND when allowances were stored.
 * After the commit, a hire check of the day is stopped and the salesman link's day is read again.
 *
 * Allow anyway (design 3.9): `overrides` present (even empty) saves the change with the issues it needs
 * allowed by hand: the switch must be on (409 OVERRIDES_OFF), new confirmations need SUPERVISOR or above
 * (403 OVERRIDE_ROLE), the overrides hash must be the check's, the change must still break a rule
 * (OVERRIDES_CHANGED), everything else must hold (MOVE_REFUSED), the confirmed ids must be exactly the
 * needed ones not carried (OVERRIDES_CHANGED / OVERRIDE_ROLE), and every needed issue is judged again on
 * the web's own figures (409 OVERRIDE_NOT_ALLOWED): a solver bug can never store more than allowed.
 */
import { Prisma, type OrderStatus, type Role, type RunPlan } from '@prisma/client';
import { prisma } from '../db';
import { audit } from '../audit';
import { canApproveOverride } from '../rbac';
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
import { readHandAllowances, type HandAllowance } from './snapshots';
import {
  allowancesOfSave,
  checkPlanEdit,
  EDIT_FROM,
  editBasis,
  isV1Op,
  manualOf,
  mergeOption,
  PREVIEW_MAX_AGE_MS,
  readEditLoads,
  refuse,
  type EditCheck,
  type EditLoad,
  type JudgedIssue,
  type ManualEdit,
} from './plan-edit';
import {
  allowedCountText,
  cleanOverrideReason,
  EDIT_ERROR_TEXT,
  OVERRIDE_REASON_MIN,
  overrideReasonOk,
  planEditOverridesOn,
  type PlanEditMove,
  type PlanEditOp,
  type PlanEditSaved,
} from './plan-edit-view';
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
 * A reason typed by hand: trimmed, control and Unicode format characters out (zero-width, bidi: review RA-2), as
 * it is printed on the sheets and sent on WhatsApp (plan-edit-view.ts cleanOverrideReason).
 */
export function cleanReason(raw: string): string {
  return cleanOverrideReason(raw);
}

const APPROVER_ROLES = ['SUPERVISOR', 'TENANT_ADMIN', 'SUPER_ADMIN'] as const;
type ApproverRole = (typeof APPROVER_ROLES)[number];

/** One rule allowed by hand as the audit rows keep it: ids, codes and figures, and the user's own reason. */
function auditOverride(i: JudgedIssue, reason: string) {
  return {
    id: i.id,
    kind: i.kind,
    truckId: i.truckId,
    truckCode: i.truckCode,
    loadNo: i.loadNo,
    customerId: i.customerId,
    orderIds: i.orderIds,
    unit: i.amount?.unit ?? null,
    value: i.amount?.value ?? null,
    limit: i.amount?.limit ?? null,
    capacity: i.amount?.capacity ?? null,
    overPct: i.amount?.overPct ?? null,
    lateMin: i.kind === 'LATE' ? (i.amount?.over ?? null) : null,
    maxLateMin: i.kind === 'LATE' ? (i.carriedFrom?.maxLateMin ?? i.amount?.over ?? null) : null,
    maxValue: i.kind?.startsWith('CAPACITY_') ? (i.carriedFrom?.maxValue ?? i.amount?.value ?? null) : null,
    reason,
    ...(i.carriedFrom ? { carried: { fromId: i.carriedFrom.id, byName: i.carriedFrom.byName, at: i.carriedFrom.at } } : {}),
  };
}

/**
 * Save a checked change as version N+1 (see the top of this file). Refusals are PlanErrors: 409
 * PREVIEW_OLD, PREVIEW_CHANGED (with the new `preview`), MOVE_REFUSED (with the `preview`), ROADS_DOWN,
 * DAY_CHANGED, SUPERSEDED, OPTIMIZING, PLAN_BUSY, EDIT_CHECK_FAILED, OVERRIDES_OFF, OVERRIDES_CHANGED,
 * OVERRIDE_NOT_ALLOWED; 403 OVERRIDE_ROLE; and the check's own. `move` is the v1 body (one change).
 */
export async function savePlanEdit(
  tenantId: string,
  runId: string,
  input: { move?: PlanEditMove; ops?: PlanEditOp[]; expect?: ExpectedDay; skipBreak?: string[]; previewHash: string; builtAt: string; overrides?: { id: string; reason: string }[] },
  user: { id: string; name?: string | null; role?: Role | string | null },
  ip: string | null,
  opts: { now?: Date } = {},
): Promise<PlanEditSaved> {
  const now = opts.now ?? new Date();
  const builtAt = new Date(input.builtAt);
  const age = now.getTime() - builtAt.getTime();
  // A minute of clock difference is allowed the other way; never a check from the future.
  if (!Number.isFinite(age) || age < -60_000 || age > PREVIEW_MAX_AGE_MS) throw refuse(409, 'PREVIEW_OLD', EDIT_ERROR_TEXT.PREVIEW_OLD);
  const withOverrides = input.overrides !== undefined;
  const role = (user.role ?? null) as Role | null;
  const canOverride = !!role && canApproveOverride(role);
  const confirmed = new Map((input.overrides ?? []).map((o) => [o.id, cleanReason(o.reason)]));
  const overridesOn = planEditOverridesOn();
  if (withOverrides) {
    // Switched off: nothing new can be allowed; a save that only keeps earlier approvals (none confirmed) still can (review F5).
    if (!overridesOn && confirmed.size > 0) throw refuse(409, 'OVERRIDES_OFF', EDIT_ERROR_TEXT.OVERRIDES_OFF);
    if (confirmed.size > 0 && !canOverride) throw refuse(403, 'OVERRIDE_ROLE', EDIT_ERROR_TEXT.OVERRIDE_ROLE);
    for (const [id, reason] of confirmed) {
      if (!overrideReasonOk(reason)) throw refuse(422, 'BAD_REASON', `The reason for ${id} is too short: say why it is allowed (at least ${OVERRIDE_REASON_MIN} letters or digits).`);
    }
  }
  const check = await checkPlanEdit(tenantId, runId, { move: input.move, ops: input.ops, skipBreak: input.skipBreak, expect: input.expect, now: builtAt, mode: 'ON', canOverride });
  if (!withOverrides) {
    if (check.preview.previewHash !== input.previewHash) throw refuse(409, 'PREVIEW_CHANGED', EDIT_ERROR_TEXT.PREVIEW_CHANGED, { preview: check.preview });
    if (!check.answer.ok || !check.answer.scenario) throw refuse(409, 'MOVE_REFUSED', 'This change breaks a rule and cannot be saved.', { preview: check.preview });
    if (!check.preview.canSave) throw refuse(409, 'ROADS_DOWN', check.preview.saveNote ?? EDIT_ERROR_TEXT.ROADS_DOWN, { preview: check.preview });
  } else {
    const ov = check.preview.overrides;
    // b. It still breaks a rule (else nothing is to be allowed).
    if (check.answer.ok) throw refuse(409, 'OVERRIDES_CHANGED', 'This change keeps every rule now: save it without allowing anything.', { preview: check.preview });
    // c. Everything that cannot be allowed holds (a change refused even when allowed is refused whatever the hash).
    const judged = check.overrides;
    if (!ov || !ov.ok || !judged || judged.remaining.length || !check.answer.relaxed?.scenario) throw refuse(409, 'MOVE_REFUSED', 'This change breaks a rule that cannot be allowed by hand.', { preview: check.preview });
    // a. The overrides hash of the check.
    if (ov.previewHash !== input.previewHash) throw refuse(409, 'PREVIEW_CHANGED', EDIT_ERROR_TEXT.PREVIEW_CHANGED, { preview: check.preview });
    // d. Exactly the needed issues that are not carried are confirmed.
    const want = new Set(judged.needed.filter((n) => !n.carried).map((n) => n.id ?? ''));
    if (want.size && !overridesOn) throw refuse(409, 'OVERRIDES_OFF', EDIT_ERROR_TEXT.OVERRIDES_OFF, { preview: check.preview });
    if (want.size && !canOverride) throw refuse(403, 'OVERRIDE_ROLE', EDIT_ERROR_TEXT.OVERRIDE_ROLE);
    if (want.size !== confirmed.size || [...want].some((id) => !confirmed.has(id))) throw refuse(409, 'OVERRIDES_CHANGED', EDIT_ERROR_TEXT.OVERRIDES_CHANGED, { preview: check.preview });
    // e. Every needed issue judged again on the web's own figures (a solver bug can never store more than allowed).
    for (const n of judged.needed) {
      const bad = !n.kind || !n.id || !n.overridable || (n.kind === 'LATE' && (!n.amount || n.amount.value < n.amount.limit));
      if (bad) throw refuse(409, 'OVERRIDE_NOT_ALLOWED', `This cannot be allowed by hand: ${n.text}${n.whyNot ? ` (${n.whyNot})` : ''}.`, { preview: check.preview, issueId: n.id });
    }
    // f. Roads.
    if (!ov.canSave && ov.saveNote === EDIT_ERROR_TEXT.ROADS_DOWN) throw refuse(409, 'ROADS_DOWN', EDIT_ERROR_TEXT.ROADS_DOWN, { preview: check.preview });
  }
  const { run } = check;
  let saved: { child: RunPlan; reprint: string[]; gone: string[]; allowed: number; carried: number };
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

        const neededNow = withOverrides ? (check.overrides?.needed ?? []) : [];
        const countText = allowedCountText(neededNow.filter((n) => !n.carried).length, neededNow.filter((n) => !!n.carried).length);
        const allowedNote = countText ? `; ${countText}` : '';
        const { child } = await createNextVersionTx(tx, tenantId, runId, 'MANUAL_ADJUSTMENT', `By hand: ${check.preview.title}`.slice(0, 500 - allowedNote.length) + allowedNote, user.id);
        // The edited orders' kg as the solver was sent them (usually nothing to do).
        const orders = editedOrderIds(check);
        await applyWeightChanges(
          tx,
          tenantId,
          child.id,
          { lines: check.built.weightChanges.lines.filter((c) => orders.has(c.orderId)), orders: check.built.weightChanges.orders.filter((c) => orders.has(c.orderId)) },
          user.id,
        );
        const applied = await applyPlanEdit(tx, tenantId, { child, parent: locked, check, user, at: now, overrides: withOverrides ? confirmed : null });
        await audit({ tenantId, userId: user.id, action: 'ROUTE_MANUALLY_CHANGED', entity: 'RunPlan', entityId: child.id, beforeJson: applied.before as never, afterJson: applied.after as never, ip }, tx);
        if (applied.overrides.length) {
          await audit(
            {
              tenantId,
              userId: user.id,
              action: 'RULE_ALLOWED_BY_HAND',
              entity: 'RunPlan',
              entityId: child.id,
              // keptOnly: nothing new was allowed in this save; it only kept earlier approvals (their approvers are in `overrides[].carried`; review F7).
              afterJson: { parentRunId: run.id, runId: child.id, version: child.version, byRole: role, confirmed: applied.allowed, carried: applied.carried, keptOnly: applied.allowed === 0, overrides: applied.overrides } as never,
              ip,
            },
            tx,
          );
        }
        return { child, reprint: applied.reprint, gone: applied.gone, allowed: applied.allowed, carried: applied.carried };
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
    ...(saved.allowed || saved.carried ? { allowed: saved.allowed, carried: saved.carried } : {}),
  };
}

/** The request stops the check depended on: the edited trucks' before and after, and the stops moved. */
export function stopIdsOf(check: Pick<EditCheck, 'edit'>): Set<string> {
  const best = check.edit.best ? [check.edit.best.stop_id, ...(check.edit.best.more_stop_ids ?? [])] : [];
  return new Set<string>([...check.edit.movedStops, ...[...check.edit.before.values(), ...check.edit.after.values()].flat(2), ...best]);
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
 * The writes of a save on the new version `child` (step 3 and 4 at the top). `overrides`: the confirmed
 * reasons by override id when the save allows rules by hand (null: every rule kept). Returns the audit
 * rows' before and after, the loads whose sheets must be printed again, and the rules allowed by hand.
 */
export async function applyPlanEdit(
  tx: Tx,
  tenantId: string,
  args: { child: RunPlan; parent: RunPlan; check: EditCheck; user: { id: string; name?: string | null; role?: Role | string | null }; at: Date; overrides?: ReadonlyMap<string, string> | null },
): Promise<{ before: Record<string, unknown>; after: Record<string, unknown>; reprint: string[]; gone: string[]; allowed: number; carried: number; overrides: ReturnType<typeof auditOverride>[] }> {
  const { child, parent, check, user, at } = args;
  const relaxedSave = !!args.overrides;
  const sc = relaxedSave ? check.answer.relaxed!.scenario! : check.answer.scenario!;
  const edited = new Set(check.edit.edited);
  const childLoads = await tx.planLoad.findMany({ where: { runId: child.id, tenantId }, select: { id: true, truckId: true, loadNo: true, status: true, departMin: true, returnMin: true, _count: { select: { assignments: true } } } });
  const replaced = childLoads.filter((l) => edited.has(l.truckId) && l.status === 'PLANNED');
  const frozenBefore = JSON.stringify(childLoads.filter((l) => l.status !== 'PLANNED').map((l) => [l.id, l.status, l.departMin, l.returnMin, l._count.assignments]).sort());
  const replacedKeys = new Set(replaced.map((l) => `${l.truckId}:${l.loadNo}`));
  const option = await tx.scenarioResult.findFirstOrThrow({ where: { id: child.chosenScenarioId!, runId: child.id } });
  const copied = option.detailsJson as unknown as ScenarioDetails;

  // The rules allowed by hand on the new loads: the needed issues, confirmed now or carried from earlier.
  const needed = relaxedSave ? (check.overrides?.needed ?? []) : [];
  const allowedCount = needed.filter((n) => !n.carried).length;
  const carriedCount = needed.filter((n) => !!n.carried).length;
  // A new approval is stored with the approver's own role. A role that may not approve never gets here (savePlanEdit
  // refuses it first); if it did, nothing is saved rather than a wrong "by" label (review RA-5).
  const isApprover = (APPROVER_ROLES as readonly string[]).includes(String(user.role));
  if (allowedCount > 0 && !isApprover) throw refuse(403, 'OVERRIDE_ROLE', EDIT_ERROR_TEXT.OVERRIDE_ROLE);
  const approver = (isApprover ? user.role : 'SUPERVISOR') as ApproverRole;
  const allowances = allowancesOfSave({
    needed,
    confirmed: args.overrides ?? new Map(),
    user: { id: user.id, name: user.name || 'a supervisor', role: approver },
    at: at.toISOString(),
    runId: child.id,
    newLoads: sc.loads,
    config: check.built.request.config,
  });

  // The option in use with the edited trucks re-timed (refs mapped back, critic M3).
  const frozenTruckIds = childLoads.filter((l) => l.status !== 'PLANNED').map((l) => l.truckId);
  const v1 = check.ops.length === 1 && isV1Op(check.ops[0]!) ? (check.ops[0] as PlanEditMove) : null;
  const manual: ManualEdit = {
    v: 1,
    at: at.toISOString(),
    byUserId: user.id,
    parentRunId: parent.id,
    count: (manualOf(copied)?.count ?? 0) + 1,
    ...(v1 ? { move: v1 } : {}),
    ops: check.ops,
    ...(allowedCount ? { allowed: allowedCount } : {}),
    ...(carriedCount ? { carried: carriedCount } : {}),
    trucks: check.edit.edited,
    builtAt: check.preview.builtAt,
    matrix: check.preview.matrix,
    previewHash: relaxedSave ? (check.preview.overrides?.previewHash ?? check.preview.previewHash) : check.preview.previewHash,
    preferenceApprox: true,
  };
  const clock = fmtHhmm(localMinutes(at, check.built.settings?.timezone || DEFAULT_TZ));
  const removedWhy = `Taken off the plan by hand (${user.name || 'a dispatcher'}). Put on a truck puts it back; a RE-PLAN plans it again.`;
  const kept = allowedCount + carriedCount;
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
    warning: `Changed by hand by ${user.name || 'a dispatcher'} at ${clock}: ${check.preview.title}${kept ? ` (${allowedCountText(allowedCount, carriedCount)})` : ''}.`,
    unserved: {
      placedOrderIds: check.placedOrderIds,
      removed: check.removedStops.map((r) => ({
        stop_id: r.stopId,
        order_ids: check.built.request.stops.find((s) => s.stop_id === r.stopId)?.order_ids ?? r.rows.map((x) => x.orderId),
        reason_message: removedWhy,
      })),
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
    allowances: (ld) => allowances.get(`${ld.truck_id}:${ld.load_no}`) ?? [],
  });

  // The unserved list and the order statuses.
  const movable = { notIn: ['DISPATCHED', 'DELIVERED'] as OrderStatus[] };
  if (check.placedOrderIds.length) {
    await tx.unservedOrder.deleteMany({ where: { scenarioId: option.id, orderId: { in: check.placedOrderIds } } });
    await tx.order.updateMany({ where: { tenantId, id: { in: check.placedOrderIds }, status: movable }, data: { status: 'ASSIGNED' } });
  }
  if (check.removedRows.length) {
    await tx.unservedOrder.createMany({
      data: check.removedRows.map((r) => ({
        scenarioId: option.id,
        orderId: r.orderId,
        reasonCode: 'REMOVED_BY_HAND' as const,
        reasonMessage: removedWhy,
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
  const keptSummary = child.summaryJson as unknown as DailySummary | null;
  const facts = await refreshPlanFacts(tx, tenantId, child.id, {
    driverChanges: [...(keptSummary?.driverChanges ?? []).filter((c) => !edited.has(c.truckId)), ...crew.driverChanges],
    helperChanges: [...(keptSummary?.helperChanges ?? []).filter((c) => !edited.has(c.truckId)), ...crew.helperChanges],
  });

  // Guards (critic M10): any of them rolls the whole save back.
  const parentRecon = parent.reconciliationJson as unknown as Reconciliation | null;
  if (parentRecon?.ok && facts && !facts.recon.ok) throw new EditCheckFailed('the plan would no longer reconcile with the orders');
  const loadsAfter = await tx.planLoad.findMany({
    where: { runId: child.id, tenantId },
    select: { id: true, truckId: true, loadNo: true, status: true, departMin: true, returnMin: true, distanceKm: true, operatingCost: true, cases: true, palletUnits: true, truckSnapshotJson: true, truck: { select: { code: true } }, _count: { select: { assignments: true } } },
  });
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
  // An allowance the web gate does not see as needed: said and audited, never a rollback (design 3.9 step 7).
  const matched = new Set((feas?.violations ?? []).map((v) => v.allowedByHand?.id).filter((x): x is string => !!x));
  const stored: HandAllowance[] = loadsAfter.filter((l) => newIds.has(l.id)).flatMap((l) => readHandAllowances(l.truckSnapshotJson));
  const allowanceUnmatched = [...new Set(stored.filter((a) => !matched.has(a.id)).map((a) => a.id))];
  if (allowanceUnmatched.length) console.warn('plan edit: an allowance by hand is not needed by the timetable check', { runId: child.id, allowanceUnmatched });

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
  // A change of one v1 operation keeps its `move` block (tests and the audit page read it).
  let move: Record<string, unknown> | null = null;
  if (v1 && check.movedStop) {
    const fromStop = v1.kind === 'PLACE' ? null : (check.loads.find((l) => l.id === v1.from.loadId) ?? null);
    const stopRows = fromStop && v1.kind !== 'PLACE' ? fromStop.rows.filter((r) => r.sequenceInTruck === v1.from.sequence) : [];
    const movedTo = sc.loads.flatMap((l) => l.stops.filter((s) => s.stop_id === check.movedStop).map((s) => ({ truckId: l.truck_id, truckCode: code(l.truck_id), loadNo: l.load_no, position: s.sequence })))[0] ?? null;
    move = {
      kind: v1.kind,
      orderIds: v1.kind === 'PLACE' ? check.placedOrderIds : stopRows.map((r) => r.orderId),
      customerId: check.built.request.stops.find((s) => s.stop_id === check.movedStop)?.customer_id ?? null,
      from: fromStop && v1.kind !== 'PLACE' ? { truckId: fromStop.truckId, truckCode: fromStop.truckCode, loadNo: fromStop.loadNo, sequence: v1.from.sequence } : 'UNSERVED',
      to: v1.kind === 'REMOVE' ? 'UNSERVED' : movedTo,
    };
  }
  const overrides = needed.map((n) => auditOverride(n, n.carriedFrom ? n.carriedFrom.reason : (args.overrides?.get(n.id ?? '') ?? '')));
  const after = {
    parentRunId: parent.id,
    runId: child.id,
    version: child.version,
    reason: 'MANUAL_ADJUSTMENT',
    ...(move ? { move } : {}),
    ops: check.ops,
    byRole: user.role ?? null,
    skipBreak: check.skipBreak,
    ...(overrides.length ? { overrides } : {}),
    ...(allowanceUnmatched.length ? { allowanceUnmatched } : {}),
    removed: check.removedStops.map((r) => ({ orderIds: [...new Set(r.rows.map((x) => x.orderId))] })),
    placedOrderIds: check.placedOrderIds,
    trucks: check.edit.edited.map((t) => ({
      truckId: t,
      truckCode: code(t),
      loads: loadsAfter.filter((l) => l.truckId === t).sort((a, b) => a.loadNo - b.loadNo).map((l) => auditLoad({ ...l, stops: newIds.has(l.id) ? stopsAfter(l.id) : [] })),
    })),
    costDeltaOmr: (relaxedSave ? check.answer.relaxed?.delta_money_omr : check.answer.delta_money_omr) ?? null,
    kmDelta: (relaxedSave ? check.answer.relaxed?.delta_km : check.answer.delta_km) ?? null,
    softWarnings: check.preview.warnings.length,
    dataChanged: check.preview.dataChanged.length,
    matrix: check.preview.matrix,
    previewHash: manual.previewHash,
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
  return { before, after, reprint, gone, allowed: allowedCount, carried: carriedCount, overrides };
}

