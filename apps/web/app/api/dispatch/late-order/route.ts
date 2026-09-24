import { z } from 'zod';
import { withTenantApi, ok, parseBody, fail } from '@/lib/api';
import { prisma } from '@/lib/db';
import { audit } from '@/lib/audit';
import { normalizeBranchKey } from '@/lib/schemas';
import { currentPlan } from '@/lib/dispatch/plan-service';
import { dateOnly, isAfterCutoff } from '@/lib/dispatch/time';

const schema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  depotId: z.string().min(1),
  customerCode: z.string().trim().min(1).max(64),
  branchCode: z.string().trim().max(32).optional(),
  customerName: z.string().trim().max(200).optional(),
  priority: z.number().int().min(1).max(5).optional(),
  reason: z.string().trim().min(3, 'Give the reason for accepting a late order').max(500),
  salesValue: z.number().min(0).optional(),
  margin: z.number().optional(),
  lines: z
    .array(
      z.object({
        productCode: z.string().trim().min(1).max(64),
        productDescription: z.string().trim().max(200).optional(),
        cases: z.number().int().positive(),
        salesOrderNo: z.string().trim().max(64).optional(),
      }),
    )
    .min(1),
});

// POST /api/dispatch/late-order - record a single late order (e.g. a P1 customer phoning at
// 22:15). Unknown customers become "LOCATION REQUIRED" stubs; nothing is planned until the
// dispatcher re-plans (new version, locked loads preserved).
export const POST = withTenantApi(
  async (req, { user, ip }) => {
    const input = await parseBody(req, schema);
    const tenantId = user.tenantId;
    const depot = await prisma.depot.findFirst({ where: { tenantId, id: input.depotId, active: true } });
    if (!depot) return fail('Depot not found', 400);
    const cfg = await prisma.tenantConfig.findUniqueOrThrow({ where: { tenantId } });
    const branchKey = normalizeBranchKey(input.branchCode);
    const plan = await currentPlan(tenantId, depot.id, input.date);
    const now = new Date();
    const late = isAfterCutoff(now, input.date, cfg.planningCutoffMin, cfg.timezone) || !!plan?.chosenScenarioId;

    const result = await prisma.$transaction(async (tx) => {
      // Codes are matched case-insensitively, like the file intake (c001 == C001).
      let customer = await tx.customer.findFirst({
        where: { tenantId, code: { equals: input.customerCode, mode: 'insensitive' }, branchKey: { equals: branchKey, mode: 'insensitive' } },
      });
      let customerCreated = false;
      if (!customer) {
        customer = await tx.customer.create({
          data: {
            tenantId,
            code: input.customerCode,
            branchCode: input.branchCode || null,
            branchKey,
            name: input.customerName || input.customerCode,
            createdFromUpload: true,
            geocodeConfidence: 'MISSING',
          },
        });
        customerCreated = true;
      } else if (!customer.active) {
        throw new Error(`Customer ${customer.code} is inactive.`);
      }
      const products: { id: string; weightPerCaseKg: number }[] = [];
      for (const l of input.lines) {
        const p =
          (await tx.product.findFirst({ where: { tenantId, code: { equals: l.productCode, mode: 'insensitive' } } })) ??
          (await tx.product.create({ data: { tenantId, code: l.productCode, name: l.productDescription || l.productCode, createdFromUpload: true } }));
        products.push(p);
      }
      const order = await tx.order.create({
        data: {
          tenantId,
          customerId: customer.id,
          depotId: depot.id,
          deliveryDate: dateOnly(input.date),
          totalCases: input.lines.reduce((a, l) => a + l.cases, 0),
          totalWeightKg: input.lines.reduce((a, l, i) => a + products[i].weightPerCaseKg * l.cases, 0),
          totalServiceTimeMin: Math.max(customer.avgServiceTimeMin, 1),
          priority: input.priority ?? customer.priority,
          priorityFromFile: input.priority !== undefined,
          status: 'VALIDATED',
          uploadedAt: now,
          isLate: late,
          lateReason: input.reason,
          lateRecordedById: user.id,
          salesValue: input.salesValue ?? null,
          marginValue: input.margin ?? null,
          lines: {
            create: input.lines.map((l, i) => ({
              productId: products[i].id,
              cases: l.cases,
              salesOrderNo: l.salesOrderNo ?? null,
              productDescription: l.productDescription ?? null,
              weightKg: products[i].weightPerCaseKg * l.cases,
            })),
          },
        },
      });
      return { order, customer, customerCreated };
    });

    await audit({
      tenantId,
      userId: user.id,
      action: 'LATE_ORDER_RECORDED',
      entity: 'Order',
      entityId: result.order.id,
      afterJson: { date: input.date, depot: depot.code, customer: input.customerCode, cases: result.order.totalCases, priority: result.order.priority, late, reason: input.reason } as never,
      ip,
    });
    return ok(
      {
        orderId: result.order.id,
        late,
        customerId: result.customer.id,
        customerCreated: result.customerCreated,
        locationRequired: result.customer.lat === null || result.customer.lng === null,
        planId: plan?.id ?? null,
        replanNeeded: !!plan?.chosenScenarioId,
      },
      201,
    );
  },
  { role: 'PLANNER' },
);
