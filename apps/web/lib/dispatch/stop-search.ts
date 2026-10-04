/**
 * "Use the best plan found so far" (owner request 29 Sep 2026, optional step): the dispatcher
 * (PLANNER or above since owner decision 4 of 5 Oct 2026; it was SUPERVISOR) ends a running THOROUGH
 * search early. The optimizer (POST /optimize-dispatch/stop) ends its search
 * at the next plan it finds, skips the alternatives and re-checks the loads with QUICK's time; the
 * job then saves that plan exactly as after a normal search (its search report says STOPPED). Nothing
 * is cancelled and nothing is lost: the plan keeps OPTIMIZING until the job saves it (or fails).
 * Audited as SEARCH_STOPPED.
 */
import { prisma } from '../db';
import { audit } from '../audit';
import { callStopSearch, type StopSearchReply } from '../solver-client';

export interface StopSearchResult {
  status: number;
  body: Record<string, unknown>;
}

export async function stopSearch(
  tenantId: string,
  runId: string,
  user: { id: string },
  ip: string | null,
  deps: { callStop?: (runId: string, tenantId: string) => Promise<StopSearchReply> } = {},
): Promise<StopSearchResult> {
  const run = await prisma.runPlan.findFirst({ where: { id: runId, tenantId }, select: { id: true, status: true, currentJobId: true } });
  if (!run) return { status: 404, body: { error: 'Plan not found.' } };
  const job = run.currentJobId ? await prisma.runJob.findFirst({ where: { id: run.currentJobId, runId }, select: { id: true, status: true, searchMode: true } }) : null;
  if (run.status !== 'OPTIMIZING' || !job || (job.status !== 'RUNNING' && job.status !== 'QUEUED')) {
    return { status: 409, body: { error: 'No search is running for this plan.', code: 'NOT_RUNNING' } };
  }
  if (job.searchMode !== 'THOROUGH') {
    return { status: 409, body: { error: 'This is a quick search: it ends by itself in a minute or two.', code: 'NOT_THOROUGH' } };
  }
  if (job.status === 'QUEUED') {
    return { status: 409, body: { error: 'The search has not started yet: it is waiting for the route optimizer. Try again once it runs.', code: 'NOT_STARTED' } };
  }
  const reply = await (deps.callStop ?? callStopSearch)(runId, tenantId);
  if (reply === 'NOT_RUNNING') {
    return {
      status: 409,
      body: { error: 'The route optimizer is not searching for this plan right now (it is starting, or already saving the plan). Wait a moment.', code: 'SOLVER_NOT_RUNNING' },
    };
  }
  if (reply !== 'STOPPING') {
    return { status: 502, body: { error: 'The route optimizer could not be reached to stop the search. The search goes on and ends by itself.', code: 'SOLVER_UNREACHABLE' } };
  }
  await audit({ tenantId, userId: user.id, action: 'SEARCH_STOPPED', entity: 'RunPlan', entityId: runId, afterJson: { runJobId: job.id } as never, ip });
  return {
    status: 202,
    body: { runId, runJobId: job.id, stopping: true, message: 'Stopping the search: the best plan found so far is checked and saved in about a minute.' },
  };
}
