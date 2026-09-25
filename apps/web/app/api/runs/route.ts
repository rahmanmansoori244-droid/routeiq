import { z } from 'zod';
import { OptimizationMode } from '@prisma/client';
import { withTenantApi, ok, parseBody, fail } from '@/lib/api';
import { audit } from '@/lib/audit';
import { currentPlan } from '@/lib/dispatch/plan-service';
import { isRealIsoDate } from '@/lib/schemas';

const createRunSchema = z.object({
  depotId: z.string().min(1),
  runDate: z.string().refine(isRealIsoDate, 'runDate must be a real date as YYYY-MM-DD'),
  optimizationMode: z.nativeEnum(OptimizationMode).default('BALANCED'),
});

export const GET = withTenantApi(async (_req, { db }) => {
  const runs = await db.runPlan.findMany({
    orderBy: [{ runDate: 'desc' }, { createdAt: 'desc' }],
    take: 100,
    include: {
      depot: { select: { id: true, code: true, name: true } },
      _count: { select: { scenarios: true, jobs: true, routes: true } },
    },
  });
  return ok(runs);
});

export const POST = withTenantApi(
  async (req, { db, user, ip }) => {
    const input = await parseBody(req, createRunSchema);

    const depot = await db.depot.findUnique({ where: { id: input.depotId } });
    if (!depot) return fail('Depot not found in this tenant', 400);
    if (!depot.active) return fail('Depot is inactive', 400);

    // One live plan per depot and day: "New run" opens the existing plan instead of forking the
    // day (a second plan would re-plan the same orders onto the same trucks).
    const existing = await currentPlan(user.tenantId, depot.id, input.runDate);
    if (existing) {
      return ok({ ...existing, depot: { id: depot.id, code: depot.code, name: depot.name }, existing: true }, 200);
    }

    const runDate = new Date(input.runDate);
    const trucks = await db.truck.count({ where: { depotId: depot.id, active: true } });
    if (trucks === 0) return fail('This depot has no active trucks. Configure trucks first.', 400);

    const orderCount = await db.order.count({ where: { deliveryDate: runDate, customer: { active: true } } });
    if (orderCount === 0) {
      return fail(
        `No orders found for ${input.runDate}. Upload and confirm an order file for that date first.`,
        400,
      );
    }

    const run = await db.runPlan.create({
      data: {
        tenantId: user.tenantId,
        depotId: depot.id,
        runDate,
        optimizationMode: input.optimizationMode,
        totalOrders: orderCount,
        createdById: user.id,
      },
    });

    await audit({
      tenantId: user.tenantId,
      userId: user.id,
      action: 'CREATE',
      entity: 'RunPlan',
      entityId: run.id,
      afterJson: {
        depotId: depot.id,
        depotCode: depot.code,
        runDate: input.runDate,
        optimizationMode: input.optimizationMode,
        totalOrders: orderCount,
      } as never,
      ip,
    });

    return ok({ ...run, depot: { id: depot.id, code: depot.code, name: depot.name }, orderCount }, 201);
  },
  { role: 'PLANNER' },
);
