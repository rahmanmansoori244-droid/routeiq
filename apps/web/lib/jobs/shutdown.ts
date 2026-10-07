/**
 * A web process stopped while optimizations run in it (every deploy sends SIGTERM to the running
 * container). Its background jobs cannot survive the process, and a THOROUGH search can take 20
 * minutes, so waiting for them is not an option. Instead, on SIGTERM / SIGINT, every job this
 * process runs is failed at once with a plain message, one transaction each (failJob: the job
 * FAILED, its plan FAILED - a re-plan version keeps the previous plan it holds -, OPTIMIZE_FAILED
 * audit row), so the plan can be optimized again right away and is never left "optimizing". The
 * connection to the optimizer closes with the process, and the optimizer cancels that solve and
 * frees its slot (apps/solver/main.py).
 *
 * Next.js 14 exits on SIGTERM by itself (server.close, then process.exit) unless
 * NEXT_MANUAL_SIG_HANDLE is set: without it these writes race the exit and may not land. With
 * NEXT_MANUAL_SIG_HANDLE=1 (docs/RAILWAY_DEPLOYMENT.md) this handler owns the exit: it fails the
 * jobs (at most SHUTDOWN_FAIL_MS), then exits. Either way a job whose process vanished without
 * this (SIGKILL, a crash, out of memory) stops its heartbeat: the plan screen shows it as lost 2
 * minutes after the last one and the janitor fails it 5 minutes after (optimize-job.ts).
 */
import { SolverError } from '../solver-client';
import { activeHireJobs, failHireChecksForShutdown } from '../dispatch/hire-whatif';
import { activeDispatchJobs, failJob } from './dispatch-job';

/** The longest the handler waits for the failure writes before the process exits. */
export const SHUTDOWN_FAIL_MS = 8_000;

export const SHUTDOWN_MESSAGE = 'The server was restarted (an update) during this optimization. Nothing was saved - optimize again.';

/**
 * Fail every job this process runs (see above) - the hire suggestion's checks too (third review of the
 * hire branch: they stayed "running" until the lost-check sweep, 2-3 minutes, blocking Start fresh and
 * "Check hire options"; hire-whatif.ts failHireChecksForShutdown), in the same race. Returns how many
 * there were. Never throws.
 */
export async function failJobsForShutdown(timeoutMs = SHUTDOWN_FAIL_MS): Promise<number> {
  const jobs = [...activeDispatchJobs.values()];
  const checks = activeHireJobs.size;
  if (!jobs.length && !checks) return 0;
  const err = new SolverError(SHUTDOWN_MESSAGE, 0, { reason: 'SHUTDOWN' });
  let timer: NodeJS.Timeout | undefined;
  await Promise.race([
    Promise.allSettled([...jobs.map((j) => failJob(j, err)), failHireChecksForShutdown()]),
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, timeoutMs);
    }),
  ]);
  clearTimeout(timer);
  return jobs.length + checks;
}

const g = globalThis as unknown as { __routeiqShutdownHandler?: boolean };

/**
 * Registered once per process from instrumentation.ts. `exit`: called after the jobs were failed
 * when this handler owns the exit (NEXT_MANUAL_SIG_HANDLE set); tests pass their own.
 */
export function installShutdownHandler(opts: { exit?: (code: number) => void; env?: NodeJS.ProcessEnv } = {}): boolean {
  if (g.__routeiqShutdownHandler) return false;
  g.__routeiqShutdownHandler = true;
  const env = opts.env ?? process.env;
  const owner = !!env.NEXT_MANUAL_SIG_HANDLE;
  const exit = opts.exit ?? ((code: number) => process.exit(code));
  let started = false;
  const onSignal = (signal: NodeJS.Signals) => {
    if (started) return;
    started = true;
    void failJobsForShutdown().then(
      (n) => {
        if (n) console.warn(`shutdown (${signal}): ${n} optimization(s) in progress failed so they can be started again`);
        if (owner) exit(0);
      },
      () => {
        if (owner) exit(0);
      },
    );
  };
  process.once('SIGTERM', onSignal);
  process.once('SIGINT', onSignal);
  return true;
}
