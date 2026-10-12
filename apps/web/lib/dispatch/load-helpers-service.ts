/**
 * Helpers on loads (owner request 13 Oct 2026), the database side. The rules are in load-helpers.ts.
 * Every function runs inside the caller's transaction (the plan's row lock is already held by
 * applyScenario, createNextVersionTx or the load-change transaction) and names the company in every
 * statement.
 */
import type { Prisma } from '@prisma/client';
import { audit } from '../audit';
import { PlanError } from './plan-errors';
import { ON_ROAD, type LoadStatusName } from './load-state';
import { checkHelpersChange, helpersSetByDispatcher, isHandSetHelpers, sameHelpers, type HelperEvidence } from './load-helpers';

type Tx = Prisma.TransactionClient;

/** The helper ids of each load, in their order (loads without helpers are absent). */
export async function helperIdsOfLoads(tx: Tx, tenantId: string, loadIds: readonly string[]): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  if (!loadIds.length) return out;
  const rows = await tx.planLoadHelper.findMany({
    where: { tenantId, loadId: { in: [...loadIds] } },
    orderBy: [{ loadId: 'asc' }, { position: 'asc' }],
    select: { loadId: true, helperId: true, position: true },
  });
  for (const r of rows) {
    const list = out.get(r.loadId);
    if (list) list.push(r.helperId);
    else out.set(r.loadId, [r.helperId]);
  }
  return out;
}

/** Replaces a load's helpers with `helperIds` (positions 1..n). */
export async function writeLoadHelpers(tx: Tx, tenantId: string, loadId: string, helperIds: readonly string[]): Promise<void> {
  await tx.planLoadHelper.deleteMany({ where: { tenantId, loadId } });
  if (helperIds.length) {
    await tx.planLoadHelper.createMany({ data: helperIds.map((helperId, i) => ({ tenantId, loadId, helperId, position: i + 1 })) });
  }
}

/** Removes the helper rows of these loads (before the loads themselves are deleted). */
export async function deleteHelpersOfLoads(tx: Tx, tenantId: string, loadIds: readonly string[]): Promise<void> {
  if (loadIds.length) await tx.planLoadHelper.deleteMany({ where: { tenantId, loadId: { in: [...loadIds] } } });
}

/** The evidence planHelpers reads: every load of the version with its helpers and the marker. */
export async function helperEvidenceOf(tx: Tx, tenantId: string, runId: string): Promise<{ evidence: HelperEvidence[]; plannedIds: string[] }> {
  const loads = await tx.planLoad.findMany({
    where: { tenantId, runId },
    select: { id: true, truckId: true, loadNo: true, status: true, departMin: true, returnMin: true, helpersSetById: true, helpersSetAt: true },
  });
  const ids = await helperIdsOfLoads(tx, tenantId, loads.map((l) => l.id));
  return {
    evidence: loads.map((l) => ({
      truckId: l.truckId,
      loadNo: l.loadNo,
      status: l.status,
      departMin: l.departMin,
      returnMin: l.returnMin,
      helperIds: ids.get(l.id) ?? [],
      helpersSetById: l.helpersSetById ?? null,
      helpersSetAt: l.helpersSetAt ?? null,
    })),
    plannedIds: loads.filter((l) => l.status === 'PLANNED').map((l) => l.id),
  };
}

/** A new plan version: each copied load gets its original's helpers (`newLoadId`: original id -> copy id). */
export async function copyLoadHelpers(tx: Tx, tenantId: string, newLoadId: ReadonlyMap<string, string>): Promise<number> {
  const byLoad = await helperIdsOfLoads(tx, tenantId, [...newLoadId.keys()]);
  const data: Prisma.PlanLoadHelperCreateManyInput[] = [];
  for (const [from, ids] of byLoad) {
    const to = newLoadId.get(from);
    if (to) ids.forEach((helperId, i) => data.push({ tenantId, loadId: to, helperId, position: i + 1 }));
  }
  if (data.length) await tx.planLoadHelper.createMany({ data });
  return data.length;
}

/**
 * The dispatcher sets the helpers of one load (the plan screen's Helper(s) picker), inside the load-change
 * transaction under the plan's row lock. Refused once the load has left (409, as the driver). A new
 * helper must be an active helper of the company (one already on the load may stay after he was
 * deactivated). Re-sending the helpers RouteIQ filled in makes them the dispatcher's choice (kept by a
 * re-plan), as the driver's Keep. Audited LOAD_HELPERS_CHANGED with the names before and after.
 */
export async function setHelpersTx(tx: Tx, tenantId: string, run: { id: string }, loadId: string, helperIds: readonly string[], user: { id: string }) {
  const load = await tx.planLoad.findFirst({ where: { id: loadId, runId: run.id, tenantId } });
  if (!load) throw new PlanError('Load not found.', 404);
  const current = (await helperIdsOfLoads(tx, tenantId, [loadId])).get(loadId) ?? [];
  const check = checkHelpersChange({ status: load.status as LoadStatusName, helperIds: current }, helperIds);
  if (!check.ok) throw new PlanError(check.reason, 409, { code: 'HELPERS_AFTER_DISPATCH' });
  const keep = check.unchanged && helperIds.length > 0 && !isHandSetHelpers({ helperIds: current, ...load }) && !ON_ROAD.has(load.status as LoadStatusName);
  if (check.unchanged && !keep) return load;
  const wanted = [...new Set([...current, ...helperIds])];
  const helpers = wanted.length ? await tx.helper.findMany({ where: { tenantId, id: { in: wanted } }, select: { id: true, name: true, active: true } }) : [];
  const byId = new Map(helpers.map((h) => [h.id, h]));
  for (const id of helperIds) {
    const h = byId.get(id);
    if (!h) throw new PlanError('Helper not found.', 400, { code: 'HELPER_NOT_FOUND' });
    if (!h.active && !current.includes(id)) throw new PlanError(`Helper ${h.name} is inactive.`, 400, { code: 'HELPER_INACTIVE' });
  }
  if (!sameHelpers(current, helperIds)) await writeLoadHelpers(tx, tenantId, loadId, helperIds);
  const updated = await tx.planLoad.update({ where: { id: loadId }, data: { helpersSetById: user.id, helpersSetAt: new Date() } });
  const names = (ids: readonly string[]) => ids.map((id) => byId.get(id)?.name ?? 'Unknown helper');
  await audit(
    {
      tenantId,
      userId: user.id,
      action: 'LOAD_HELPERS_CHANGED',
      entity: 'PlanLoad',
      entityId: loadId,
      beforeJson: { helperIds: current, helperNames: names(current), ...(helpersSetByDispatcher(load) ? {} : { byHand: false }) } as never,
      afterJson: { helperIds: [...helperIds], helperNames: names(helperIds), runId: run.id, truckId: load.truckId, loadNo: load.loadNo, ...(keep ? { kept: true } : {}) } as never,
    },
    tx,
  );
  return updated;
}
