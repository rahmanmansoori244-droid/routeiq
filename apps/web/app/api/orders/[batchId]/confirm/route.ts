import { z } from 'zod';
import { withTenantApi, ok, fail, notFoundIfNull } from '@/lib/api';
import { prisma } from '@/lib/db';
import { audit } from '@/lib/audit';
import {
  confirmIntake,
  INTAKE_BUSY,
  IntakeConflict,
  isIntakeKeyConflict,
  isTransactionTimeout,
  lockIntake,
  revalidateIntake,
  type IntakeValidation,
} from '@/lib/dispatch/intake-server';

interface Params { params: { batchId: string } }

class BatchRaceError extends Error {
  constructor(message: string, public status: number) {
    super(message);
  }
}

const bodySchema = z.object({ lateReason: z.string().trim().max(500).optional() }).optional();

// POST /api/orders/:batchId/confirm - add a checked file's lines to the day. Everything the check
// relied on is re-checked inside the transaction, under a per-tenant intake lock (another file,
// tab or late order may have confirmed the same lines meanwhile). A conflict answers 409 with a
// code and leaves the batch VALIDATED; nothing is saved.
export const POST = (req: Request, { params }: Params) =>
  withTenantApi(
    async (r, { db, user, ip }) => {
      let body: z.infer<typeof bodySchema> = undefined;
      try {
        const text = await r.text();
        body = text ? bodySchema.parse(JSON.parse(text)) : undefined;
      } catch {
        return fail('Invalid JSON body', 400);
      }
      const batch = notFoundIfNull(await db.uploadBatch.findUnique({ where: { id: params.batchId } }));
      if (batch.status === 'CONFIRMED') return fail('Batch already confirmed.', 409);
      if (batch.status === 'REJECTED' || batch.status === 'DELETED') return fail(`Batch is ${batch.status}.`, 409);
      if (batch.errorRows > 0) return fail('Fix the file errors and upload it again - a batch with errors cannot be confirmed.', 400);
      const v = batch.validationJson as unknown as IntakeValidation | null;
      if (!v || !Array.isArray(v.lines)) return fail('This batch was validated by an older version. Upload the file again.', 409);
      if (v.lines.length === 0) return fail('No valid rows to confirm.', 400);
      const lateReason = body?.lateReason?.trim() || null;
      if (v.late.isLate && !lateReason) {
        return fail({ code: 'LATE_REASON_REQUIRED', message: 'These orders arrived after the planning cutoff. Enter the reason for accepting them.', reasons: v.late.reasons }, 400);
      }

      let result;
      try {
        result = await prisma.$transaction(
          async (tx) => {
            await lockIntake(tx, user.tenantId);
            const locked = await tx.$queryRaw<Array<{ status: string; tenant_id: string }>>`
              SELECT "status", "tenantId" AS tenant_id FROM "UploadBatch" WHERE id = ${batch.id} FOR UPDATE`;
            if (!locked.length || locked[0].tenant_id !== user.tenantId) throw new BatchRaceError('Batch not found.', 404);
            if (locked[0].status === 'CONFIRMED') throw new BatchRaceError('Batch already confirmed.', 409);
            if (locked[0].status === 'REJECTED' || locked[0].status === 'DELETED') throw new BatchRaceError(`Batch is ${locked[0].status}.`, 409);
            const late = await revalidateIntake(tx, user.tenantId, batch, v, new Date());
            // Checked before the cutoff (or before a plan was applied) but confirmed after it:
            // the orders are late now and need a reason like any other late order.
            if (late.isLate && !lateReason) {
              throw new IntakeConflict('LATE_REASON_REQUIRED', 'These orders are late now (the cutoff passed or a plan was applied since the file was checked). Enter the reason for accepting them.', 409, {
                reasons: late.reasons,
              });
            }
            const res = await confirmIntake(tx, user.tenantId, { id: batch.id, depotId: batch.depotId }, v, user, {
              isLate: late.isLate,
              reason: lateReason,
            });
            await tx.uploadBatch.update({ where: { id: batch.id }, data: { status: 'CONFIRMED', lateReason, isLate: late.isLate } });
            return { ...res, late };
          },
          { timeout: 60_000, maxWait: 10_000 },
        );
      } catch (e) {
        if (e instanceof BatchRaceError) return fail(e.message, e.status);
        if (e instanceof IntakeConflict) return fail(e.body(), e.status);
        if (isTransactionTimeout(e)) return fail({ code: INTAKE_BUSY.code, message: INTAKE_BUSY.error }, 409);
        if (isIntakeKeyConflict(e)) {
          return fail({ code: 'DUPLICATE_LINES', message: 'Some of these lines were confirmed from another file or a late order at the same time. Upload the file again: lines already confirmed are then skipped.' }, 409);
        }
        throw e;
      }

      const { late, ...counts } = result;
      await audit({
        tenantId: user.tenantId,
        userId: user.id,
        action: 'UPDATE',
        entity: 'UploadBatch',
        entityId: batch.id,
        beforeJson: { status: batch.status } as never,
        afterJson: { status: 'CONFIRMED', ...counts, late: late.isLate, lateReason } as never,
        ip,
      });
      return ok({ batchId: batch.id, ...counts, late: late.isLate, deliveryDates: v.totals.deliveryDates, depotId: v.depotId });
    },
    { role: 'PLANNER' },
  )(req);
