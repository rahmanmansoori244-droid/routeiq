import { z } from 'zod';
import { withTenantApi, ok, parseBody, fail } from '@/lib/api';
import { prisma } from '@/lib/db';
import { audit } from '@/lib/audit';
import { isoDateSchema, normalizeBranchKey } from '@/lib/schemas';
import { normalizeProductCode, productCodeProblem, productKey, twinsOf } from '@/lib/product-code';
import { customerTwinsOf } from '@/lib/customer-code';
import { currentPlan } from '@/lib/dispatch/plan-service';
import { createIntakeKeys, INTAKE_BUSY, isIntakeKeyConflict, isTransactionTimeout, lockIntake } from '@/lib/dispatch/intake-server';
import { normSalesOrder, preferredCustomer, preferredProduct } from '@/lib/dispatch/order-intake';
import { dateOnly, isAfterCutoff } from '@/lib/dispatch/time';
import { intakeLineWeight } from '@/lib/dispatch/weights';

const schema = z.object({
  date: isoDateSchema,
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
        // The tidy code ("TN1.5L (6)"). A code that is not in the master yet must also follow the
        // Products page's rule (checked below, where the master is read); a product already there
        // is found whatever its code looks like, as in the file intake (lib/product-code.ts).
        productCode: z
          .string({ required_error: 'Required' })
          .max(200, 'Item code is too long')
          .transform(normalizeProductCode)
          .pipe(z.string().min(1, 'Required')),
        productDescription: z.string().trim().max(200).optional(),
        cases: z.number().int().positive(),
        salesOrderNo: z.string().trim().max(64).optional(),
      }),
    )
    .min(1),
});

/** A late order that cannot be recorded as entered: answered with its status, nothing saved. */
class LateOrderRefused extends Error {
  constructor(message: string, public status: number, public code: string) {
    super(message);
  }
}

/**
 * An active truck of the depot has a payload: only then do OPTIMIZE and RE-PLAN ask before planning
 * lines without a case weight (start-optimize.ts gate). A payload of 0 is no weight limit (owner
 * decisions of 4 Oct 2026: NMWC's trucks have none).
 */
async function depotHasPayload(depotId: string): Promise<boolean> {
  return (await prisma.truck.count({ where: { depotId, active: true, capacityWeightKg: { gt: 0 } } })) > 0;
}

// POST /api/dispatch/late-order - record a single late order (e.g. a P1 customer phoning at
// 22:15). Unknown customers become "LOCATION REQUIRED" stubs; nothing is planned until the
// dispatcher re-plans (new version, locked loads preserved). Like a confirmed file, a sales-order
// line can be recorded only once (IntakeLineKey), and inactive customers or products are refused.
export const POST = withTenantApi(
  async (req, { user, ip }) => {
    const input = await parseBody(req, schema);
    const tenantId = user.tenantId;
    const depot = await prisma.depot.findFirst({ where: { tenantId, id: input.depotId, active: true } });
    if (!depot) return fail('Depot not found', 400);
    const seen = new Set<string>();
    for (const l of input.lines) {
      const so = normSalesOrder(l.salesOrderNo);
      if (!so) continue;
      const k = `${so}|${productKey(l.productCode)}`;
      if (seen.has(k)) return fail(`Product ${l.productCode} is entered twice for sales order ${l.salesOrderNo}. Enter each product once with its total cases.`, 400);
      seen.add(k);
    }
    const cfg = await prisma.tenantConfig.findUniqueOrThrow({ where: { tenantId } });
    const branchKey = normalizeBranchKey(input.branchCode);
    const plan = await currentPlan(tenantId, depot.id, input.date);
    const now = new Date();
    const late = isAfterCutoff(now, input.date, cfg.planningCutoffMin, cfg.timezone) || !!plan?.chosenScenarioId;
    const deliveryDate = dateOnly(input.date);

    let result;
    try {
      result = await prisma.$transaction(async (tx) => {
        await lockIntake(tx, tenantId);
        // Codes are matched case-insensitively, like the file intake (c001 == C001); case-variant
        // twins resolve to the same row the file intake would use. Matched in the program on the
        // company's customers (lib/customer-code.ts), never with the database's case-insensitive
        // equals: an ILIKE, which read "_" and "%" as wildcards (a new "C_1" became the existing "CX1").
        const twinIds = customerTwinsOf(
          await tx.customer.findMany({ where: { tenantId }, select: { id: true, code: true, branchKey: true } }),
          input.customerCode,
          branchKey,
        ).map((c) => c.id);
        const twins = twinIds.length ? await tx.customer.findMany({ where: { tenantId, id: { in: twinIds } } }) : [];
        let customer = preferredCustomer(twins) ?? null;
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
          throw new LateOrderRefused(
            `Customer ${customer.code}${customer.branchCode ? ` / ${customer.branchCode}` : ''} is inactive. Reactivate it in Customers or use another code.`,
            409,
            'CUSTOMER_INACTIVE',
          );
        }
        const products: { id: string; code: string; weightPerCaseKg: number }[] = [];
        // Every case-variant twin of each product: a line keyed under another twin is the same line.
        const productTwinIds: string[][] = [];
        const newWithoutWeight: string[] = [];
        // The company's products once, matched on the code in the program (letter case and spacing;
        // "_" is a letter, not "any character" as in the database's ILIKE: lib/product-code.ts). A
        // product made below is added, so a second line with the same code uses it.
        const master = await tx.product.findMany({ where: { tenantId } });
        for (const l of input.lines) {
          const ptwins = twinsOf(master, l.productCode);
          const found = preferredProduct(ptwins);
          if (found && !found.active) {
            throw new LateOrderRefused(`Product ${found.code} is inactive. Reactivate it in Products or use another code.`, 409, 'PRODUCT_INACTIVE');
          }
          if (!found) {
            const bad = productCodeProblem(l.productCode);
            if (bad) throw new LateOrderRefused(`Item code ${JSON.stringify(l.productCode)} cannot be used: ${bad}.`, 400, 'PRODUCT_CODE_INVALID');
          }
          const p = found ?? (await tx.product.create({ data: { tenantId, code: l.productCode, name: l.productDescription || l.productCode, createdFromUpload: true } }));
          if (!found) master.push(p);
          if (!(p.weightPerCaseKg > 0)) newWithoutWeight.push(p.code);
          products.push(p);
          productTwinIds.push([...new Set([p.id, ...ptwins.map((x) => x.id)])]);
        }
        // The same sales-order line may already be confirmed (from the file or an earlier late
        // order). Matched by code like the file intake (confirmedLineMap): over every twin id of
        // the customer and the product, since which twin is preferred can change over time.
        const customerTwinIds = [...new Set([customer.id, ...twins.map((x) => x.id)])];
        const dupes: string[] = [];
        for (const [i, l] of input.lines.entries()) {
          const so = normSalesOrder(l.salesOrderNo);
          if (!so) continue;
          const k = await tx.intakeLineKey.findFirst({
            where: { tenantId, deliveryDate, salesOrderNorm: so, customerId: { in: customerTwinIds }, productId: { in: productTwinIds[i] } },
            select: { orderLine: { select: { cases: true } } },
          });
          if (k) dupes.push(`${l.salesOrderNo} / ${products[i].code} (${k.orderLine.cases} cases)`);
        }
        if (dupes.length) {
          throw new LateOrderRefused(
            `Already confirmed for ${input.date}: sales order ${dupes.join(', ')}. Record only new lines: for extra cases of a confirmed line, leave the sales-order number empty or use a new one (changing a confirmed line is not supported yet).`,
            409,
            'DUPLICATE_LINES',
          );
        }
        // Weighed from the product master (0 kg per case = unknown): the next optimize asks for it
        // (WEIGHT_REQUIRED), or applies the product's case weight once entered or corrected.
        const lineKg = input.lines.map((l, i) => intakeLineWeight({ cases: l.cases, weightKg: null }, products[i].weightPerCaseKg).weightKg);
        const order = await tx.order.create({
          data: {
            tenantId,
            customerId: customer.id,
            depotId: depot.id,
            deliveryDate,
            totalCases: input.lines.reduce((a, l) => a + l.cases, 0),
            totalWeightKg: lineKg.reduce((a, kg) => a + kg, 0),
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
                salesOrderNo: l.salesOrderNo || null,
                productDescription: l.productDescription ?? null,
                weightKg: lineKg[i],
                weightFromMaster: true,
              })),
            },
          },
        });
        await createIntakeKeys(tx, tenantId, order.id, customer.id, order.deliveryDate, null);
        return { order, customer, customerCreated, productsWithoutWeight: [...new Set(newWithoutWeight)] };
      }, { timeout: 30_000, maxWait: 10_000 });
    } catch (e) {
      if (e instanceof LateOrderRefused) return fail({ code: e.code, message: e.message }, e.status);
      if (isTransactionTimeout(e)) return fail({ code: INTAKE_BUSY.code, message: INTAKE_BUSY.error }, 409);
      if (isIntakeKeyConflict(e)) {
        return fail({ code: 'DUPLICATE_LINES', message: 'This sales-order line was confirmed at the same time from a file or another late order. Check the day before recording it again.' }, 409);
      }
      throw e;
    }

    await audit({
      tenantId,
      userId: user.id,
      action: 'LATE_ORDER_RECORDED',
      entity: 'Order',
      entityId: result.order.id,
      afterJson: {
        date: input.date,
        depot: depot.code,
        customer: input.customerCode,
        cases: result.order.totalCases,
        priority: result.order.priority,
        late,
        reason: input.reason,
        productsWithoutWeight: result.productsWithoutWeight,
      } as never,
      ip,
    });
    return ok(
      {
        orderId: result.order.id,
        late,
        customerId: result.customer.id,
        customerCreated: result.customerCreated,
        locationRequired: result.customer.lat === null || result.customer.lng === null,
        productsWithoutWeight: result.productsWithoutWeight,
        // Whether a re-plan would ask about them: only when an active truck of the depot has a payload
        // (payload 0 = no weight limit, owner decisions of 4 Oct 2026; start-optimize.ts gate).
        ...(result.productsWithoutWeight.length ? { weightLimited: await depotHasPayload(depot.id) } : {}),
        planId: plan?.id ?? null,
        replanNeeded: !!plan?.chosenScenarioId,
      },
      201,
    );
  },
  { role: 'PLANNER' },
);
