import { withTenantApi, ok, fail, notFoundIfNull } from '@/lib/api';
import { prisma } from '@/lib/db';
import { audit } from '@/lib/audit';
import type { ValidatedOrderRow } from '@/lib/order-validate';

interface Params { params: { batchId: string } }

export const POST = (req: Request, { params }: Params) =>
  withTenantApi(
    async (_r, { db, user, ip }) => {
      const batch = notFoundIfNull(
        await db.uploadBatch.findUnique({ where: { id: params.batchId } }),
      );

      if (batch.status === 'CONFIRMED') return fail('Batch already confirmed.', 409);
      if (batch.status === 'REJECTED' || batch.status === 'DELETED') return fail(`Batch is ${batch.status}.`, 409);
      if (batch.errorRows > 0) return fail('Cannot confirm a batch with errors.', 400);

      const json = batch.validationJson as { validated?: ValidatedOrderRow[] } | null;
      const validated = json?.validated ?? [];
      if (validated.length === 0) return fail('No valid rows to confirm.', 400);

      // Need product weights/volumes for order totals.
      const productIds = Array.from(new Set(validated.map((v) => v.productId)));
      const products = await db.product.findMany({
        where: { id: { in: productIds } },
        select: { id: true, weightPerCaseKg: true, volumePerCaseL: true },
      });
      const prodById = new Map(products.map((p) => [p.id, p]));

      const customerIds = Array.from(new Set(validated.map((v) => v.customerId)));
      const customers = await db.customer.findMany({
        where: { id: { in: customerIds } },
        select: { id: true, priority: true, avgServiceTimeMin: true },
      });
      const custById = new Map(customers.map((c) => [c.id, c]));

      // Group by (customerId, deliveryDate) → one Order per group; each row is an OrderLine.
      type OrderKey = string;
      const grouped = new Map<OrderKey, ValidatedOrderRow[]>();
      for (const v of validated) {
        const k = `${v.customerId}::${v.deliveryDate}`;
        const list = grouped.get(k);
        if (list) list.push(v);
        else grouped.set(k, [v]);
      }

      let ordersCreated = 0;
      let linesCreated = 0;

      // Run as one big transaction so partial failures don't leave orphans.
      await prisma.$transaction(async (tx) => {
        for (const [, rows] of grouped) {
          const first = rows[0];
          const cust = custById.get(first.customerId);
          if (!cust) throw new Error(`Customer ${first.customerId} disappeared mid-confirm.`);

          let totalCases = 0;
          let totalWeightKg = 0;
          let totalVolumeL = 0;
          let totalPay = 0;
          let minPriority = cust.priority;
          for (const r of rows) {
            const p = prodById.get(r.productId);
            if (!p) throw new Error(`Product ${r.productId} disappeared mid-confirm.`);
            totalCases += r.cases;
            totalWeightKg += p.weightPerCaseKg * r.cases;
            totalVolumeL += p.volumePerCaseL * r.cases;
            totalPay += r.paymentCollectionAmount ?? 0;
            if (r.priority !== null) minPriority = Math.min(minPriority, r.priority);
          }
          const totalServiceTimeMin = Math.max(cust.avgServiceTimeMin, 1);

          const order = await tx.order.create({
            data: {
              tenantId: user.tenantId,
              customerId: first.customerId,
              deliveryDate: new Date(first.deliveryDate),
              totalCases,
              totalWeightKg,
              totalVolumeL,
              totalServiceTimeMin,
              priority: minPriority,
              paymentCollectionAmount: totalPay,
              notes: rows
                .map((r) => r.notes)
                .filter(Boolean)
                .join(' | ') || null,
              status: 'VALIDATED',
              uploadBatchId: batch.id,
            },
          });
          ordersCreated++;

          await tx.orderLine.createMany({
            data: rows.map((r) => ({ orderId: order.id, productId: r.productId, cases: r.cases })),
          });
          linesCreated += rows.length;
        }

        await tx.uploadBatch.update({
          where: { id: batch.id },
          data: { status: 'CONFIRMED' },
        });
      });

      await audit({
        tenantId: user.tenantId,
        userId: user.id,
        action: 'UPDATE',
        entity: 'UploadBatch',
        entityId: batch.id,
        beforeJson: { status: batch.status } as never,
        afterJson: { status: 'CONFIRMED', ordersCreated, linesCreated } as never,
        ip,
      });

      return ok({ batchId: batch.id, ordersCreated, linesCreated });
    },
    { role: 'PLANNER' },
  )(req);
