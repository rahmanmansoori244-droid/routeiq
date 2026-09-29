import { withTenantApi, ok, notFoundIfNull } from '@/lib/api';

interface Params { params: { id: string } }

export const GET = (req: Request, { params }: Params) =>
  withTenantApi(async (_r, { db }) => {
    const run = notFoundIfNull(
      await db.runPlan.findUnique({
        where: { id: params.id },
        select: {
          id: true,
          status: true,
          currentJobId: true,
          totalOrders: true,
          chosenScenarioId: true,
        },
      }),
    );

    const job = run.currentJobId
      ? await db.runJob.findUnique({
          where: { id: run.currentJobId },
          select: {
            id: true,
            status: true,
            attemptNo: true,
            progressPct: true,
            message: true,
            errorJson: true,
            startedAt: true,
            finishedAt: true,
            createdAt: true,
            // Long searches: QUICK or THOROUGH, and the last sign of life of the process running it.
            searchMode: true,
            heartbeatAt: true,
          },
        })
      : null;

    return ok({ run, job });
  })(req);
