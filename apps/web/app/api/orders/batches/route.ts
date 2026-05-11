import { withTenantApi, ok } from '@/lib/api';

export const GET = withTenantApi(async (_req, { db }) => {
  const batches = await db.uploadBatch.findMany({
    orderBy: { uploadedAt: 'desc' },
    take: 50,
    include: {
      uploadedBy: { select: { id: true, name: true, email: true } },
      _count: { select: { orders: true } },
    },
  });
  return ok(batches);
});
