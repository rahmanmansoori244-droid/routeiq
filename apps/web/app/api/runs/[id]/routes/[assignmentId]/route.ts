import { z } from 'zod';
import { withTenantApi, ok, fail, parseBody } from '@/lib/api';
import { prisma } from '@/lib/db';
import {
  RouteAdjustError,
  lockAssignment,
  moveAssignment,
  unassignAssignment,
  unlockAssignment,
} from '@/lib/route-adjust';

interface Params { params: { id: string; assignmentId: string } }

const patchSchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('move'),
    targetTruckId: z.string().min(1),
    insertionMode: z.enum(['after', 'end', 'auto']),
    insertAfterAssignmentId: z.string().optional().nullable(),
  }),
  z.object({
    action: z.literal('lock'),
    reason: z.string().max(500).optional().nullable(),
  }),
  z.object({
    action: z.literal('unlock'),
  }),
]);

export const PATCH = (req: Request, { params }: Params) =>
  withTenantApi(
    async (r, { user, ip }) => {
      if ((await prisma.planLoad.count({ where: { runId: params.id, tenantId: user.tenantId } })) > 0) {
        return fail('Stops cannot be moved one by one in a load-based plan yet. Lock the loads you want to keep and re-plan instead.', 409);
      }
      const input = await parseBody(r, patchSchema);
      try {
        const result = await prisma.$transaction(async (tx) => {
          // Defense in depth: confirm the run is in this tenant before mutating.
          const run = await tx.runPlan.findFirst({
            where: { id: params.id, tenantId: user.tenantId },
            select: { id: true, tenantId: true },
          });
          if (!run) throw new RouteAdjustError('Run not found.', 404);

          const ctx = { runId: params.id, tenantId: user.tenantId, userId: user.id, ip };
          if (input.action === 'move') {
            return moveAssignment(tx, ctx, {
              assignmentId: params.assignmentId,
              targetTruckId: input.targetTruckId,
              insertionMode: input.insertionMode,
              insertAfterAssignmentId: input.insertAfterAssignmentId ?? null,
            });
          }
          if (input.action === 'lock') {
            return lockAssignment(tx, ctx, params.assignmentId, input.reason ?? null);
          }
          return unlockAssignment(tx, ctx, params.assignmentId);
        });
        return ok(result);
      } catch (err) {
        if (err instanceof RouteAdjustError) return fail(err.message, err.status);
        throw err;
      }
    },
    { role: 'PLANNER' },
  )(req);

export const DELETE = (req: Request, { params }: Params) =>
  withTenantApi(
    async (_r, { user, ip }) => {
      if ((await prisma.planLoad.count({ where: { runId: params.id, tenantId: user.tenantId } })) > 0) {
        return fail('Stops cannot be moved one by one in a load-based plan yet. Lock the loads you want to keep and re-plan instead.', 409);
      }
      try {
        const result = await prisma.$transaction(async (tx) => {
          const run = await tx.runPlan.findFirst({
            where: { id: params.id, tenantId: user.tenantId },
            select: { id: true },
          });
          if (!run) throw new RouteAdjustError('Run not found.', 404);
          return unassignAssignment(tx, { runId: params.id, tenantId: user.tenantId, userId: user.id, ip }, params.assignmentId);
        });
        return ok(result);
      } catch (err) {
        if (err instanceof RouteAdjustError) return fail(err.message, err.status);
        throw err;
      }
    },
    { role: 'PLANNER' },
  )(req);
