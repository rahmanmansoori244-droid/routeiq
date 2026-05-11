import { withTenantApi, ok } from '@/lib/api';

export const GET = withTenantApi(async (req, { db }) => {
  const url = new URL(req.url);
  const date = url.searchParams.get('date'); // YYYY-MM-DD
  const depotId = url.searchParams.get('depotId') || undefined;
  const regionId = url.searchParams.get('regionId') || undefined;
  const status = url.searchParams.get('status') || undefined;
  const batchId = url.searchParams.get('batchId') || undefined;

  const where: Record<string, unknown> = {};
  if (date) where.deliveryDate = new Date(date);
  if (status) where.status = status;
  if (batchId) where.uploadBatchId = batchId;
  if (regionId) where.customer = { regionId };
  // depotId filter applies via the customer's region's default depot; v1 keeps it simple
  // and lets the planner just filter by region.
  if (depotId) {
    where.customer = { ...(where.customer as Record<string, unknown> | undefined), region: { depotId } };
  }

  const orders = await db.order.findMany({
    where: where as never,
    orderBy: [{ deliveryDate: 'desc' }, { uploadedAt: 'desc' }],
    include: {
      customer: { select: { id: true, code: true, name: true, branchKey: true, region: { select: { id: true, code: true } } } },
      _count: { select: { lines: true } },
    },
    take: 1000,
  });
  return ok(orders);
});
