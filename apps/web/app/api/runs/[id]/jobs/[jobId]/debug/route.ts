import { NextResponse } from 'next/server';
import { withTenantApi, notFoundIfNull } from '@/lib/api';

interface Params { params: { id: string; jobId: string } }

/**
 * Support endpoint: downloads the full requestJson/responseJson/errorJson of
 * a RunJob so a supervisor can attach it to a support ticket without copying.
 * SUPERVISOR and above (review F15): the solver request carries per-stop revenue
 * and margin and every customer coordinate.
 */
export const GET = (req: Request, { params }: Params) =>
  withTenantApi(
    async (_r, { db }) => {
      // A job of another run is "not found" (404), never a 500 (review L16).
      const job = notFoundIfNull(
        await db.runJob.findFirst({
          where: { id: params.jobId, runId: params.id },
          select: {
            id: true,
            runId: true,
            attemptNo: true,
            status: true,
            message: true,
            createdAt: true,
            startedAt: true,
            finishedAt: true,
            requestJson: true,
            responseJson: true,
            errorJson: true,
          },
        }),
      );
      return new NextResponse(JSON.stringify(job, null, 2), {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
          'Content-Disposition': `attachment; filename="runjob-${job.attemptNo}.json"`,
        },
      });
    },
    { role: 'SUPERVISOR' },
  )(req);
