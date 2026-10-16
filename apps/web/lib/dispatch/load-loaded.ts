/**
 * The warehouse's "Loaded" (operations alerts, owner request 16 Oct 2026, design WP A3): loading in the
 * warehouse is timed per truck from the Loading press (the load's statusChangedAt while it is LOADING) to
 * the Loaded press (PlanLoad.loadedAt), so the alert "loading took more than N min" (lib/alerts/rules.ts
 * LOADING_OVER, off until the warehouse uses both presses) has a real end. The status stays LOADING
 * until Dispatch: Loaded is a time, not a status. Entering LOADING again (a paused load loaded again)
 * clears it (plan-service.ts changeStatusCore), so does going back to PLANNED.
 *
 * Runs inside the load-change transaction under the plan's row lock (updateLoad). Allowed only while the
 * load is LOADING (409 NOT_LOADING otherwise); pressing it again changes nothing. Audited LOAD_LOADED with
 * the loading start, the end and the minutes.
 */
import type { Prisma } from '@prisma/client';
import { audit } from '../audit';
import { PlanError } from './plan-errors';

type Tx = Prisma.TransactionClient;

const STATUS_WORD: Record<string, string> = { PLANNED: 'Planned', LOCKED: 'Locked', LOADING: 'Loading', DISPATCHED: 'Dispatched', COMPLETED: 'Completed' };

/** The answer to Loaded on a load that is not LOADING. */
export function notLoadingText(loadNo: number, status: string): string {
  return `Only a load that is Loading can be marked Loaded: Load ${loadNo} is ${STATUS_WORD[status] ?? status}. Press Loading when the warehouse starts loading the truck, then Loaded when it is done.`;
}

export async function markLoadedTx(tx: Tx, tenantId: string, run: { id: string }, loadId: string, user: { id: string }, now: Date) {
  const load = await tx.planLoad.findFirst({ where: { id: loadId, runId: run.id, tenantId } });
  if (!load) throw new PlanError('Load not found.', 404);
  if (load.status !== 'LOADING') throw new PlanError(notLoadingText(load.loadNo, load.status), 409, { code: 'NOT_LOADING' });
  if (load.loadedAt) return load;
  const updated = await tx.planLoad.update({ where: { id: loadId }, data: { loadedAt: now, loadedById: user.id } });
  const started = load.statusChangedAt ?? null;
  await audit(
    {
      tenantId,
      userId: user.id,
      action: 'LOAD_LOADED',
      entity: 'PlanLoad',
      entityId: loadId,
      beforeJson: { status: load.status, loadedAt: null } as never,
      afterJson: {
        runId: run.id,
        truckId: load.truckId,
        loadNo: load.loadNo,
        loadingStartedAt: started ? started.toISOString() : null,
        loadedAt: now.toISOString(),
        loadingMin: started ? Math.max(0, Math.round((now.getTime() - started.getTime()) / 60_000)) : null,
      } as never,
    },
    tx,
  );
  return updated;
}
