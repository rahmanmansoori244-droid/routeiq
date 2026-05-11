import { NextResponse } from 'next/server';
import { withTenantApi, notFoundIfNull } from '@/lib/api';

interface Params { params: { id: string; jobId: string } }

/**
 * Support endpoint: downloads the full requestJson/responseJson/errorJson of
 * a RunJob so a planner can attach it to a support ticket without copying.
 */
export const GET = (req: Request, { params }: Params) =>
  withTenantApi(async (_r, { db }) => {
    const job = notFoundIfNull(
      await db.runJob.findUnique({
        where: { id: params.jobId },
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
    if (job.runId !== params.id) {
      // Mismatched path — treat as not found (don't leak that jobId exists).
      throw new Error('Not found');
    }
    return new NextResponse(JSON.stringify(job, null, 2), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Content-Disposition': `attachment; filename="runjob-${job.attemptNo}.json"`,
      },
    });
  })(req);
