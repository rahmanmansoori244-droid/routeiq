import { withTenantApi, ok, parseBody, fail } from '@/lib/api';
import { customerSchema, normalizeBranchKey } from '@/lib/schemas';
import { audit } from '@/lib/audit';

export const GET = withTenantApi(async (req, { db }) => {
  const url = new URL(req.url);
  const q = url.searchParams.get('q')?.trim().toLowerCase();
  const regionId = url.searchParams.get('regionId') || undefined;
  const onlyActive = url.searchParams.get('active') === '1';

  const where: Record<string, unknown> = {};
  if (regionId) where.regionId = regionId;
  if (onlyActive) where.active = true;
  if (q) {
    where.OR = [
      { code: { contains: q, mode: 'insensitive' } },
      { name: { contains: q, mode: 'insensitive' } },
      { branchCode: { contains: q, mode: 'insensitive' } },
    ];
  }

  const customers = await db.customer.findMany({
    where: where as never,
    orderBy: [{ active: 'desc' }, { code: 'asc' }],
    include: { region: { select: { id: true, code: true, name: true } } },
    take: 500,
  });
  return ok(customers);
});

export const POST = withTenantApi(
  async (req, { db, user, ip }) => {
    // An unloading time the planner typed is confirmed; the schema's default of 10 min is not
    // (the company default from Settings then applies, review F21).
    const raw = (await req
      .clone()
      .json()
      .catch(() => ({}))) as { avgServiceTimeMin?: unknown };
    const serviceTimeGiven = raw?.avgServiceTimeMin !== undefined && raw?.avgServiceTimeMin !== null && raw?.avgServiceTimeMin !== '';
    const input = await parseBody(req, customerSchema);
    if (input.regionId) {
      const region = await db.region.findUnique({ where: { id: input.regionId } });
      if (!region) return fail('Region not found in this tenant', 400);
    }
    const branchKey = normalizeBranchKey(input.branchCode);
    // Codes are one customer whatever their letter case (the order intake matches them that way):
    // "c001" next to "C001" would split one customer's orders between two rows.
    const twin = await db.customer.findFirst({
      where: { code: { equals: input.code, mode: 'insensitive' }, branchKey: { equals: branchKey, mode: 'insensitive' } },
      select: { code: true, branchCode: true },
    });
    if (twin) {
      return fail(`Customer ${twin.code}${twin.branchCode ? ` / ${twin.branchCode}` : ''} already exists (codes are the same whatever the letter case).`, 409);
    }
    const geocodeConfidence = input.lat !== undefined && input.lng !== undefined ? 'HIGH' : 'MISSING';
    const created = await db.customer.create({
      data: {
        tenantId: user.tenantId,
        code: input.code,
        name: input.name,
        branchCode: input.branchCode,
        branchKey,
        regionId: input.regionId,
        address: input.address,
        lat: input.lat as number | undefined,
        lng: input.lng as number | undefined,
        geocodeConfidence,
        priority: input.priority,
        avgServiceTimeMin: input.avgServiceTimeMin,
        serviceTimeConfirmed: serviceTimeGiven,
        paymentType: input.paymentType,
        accessNotes: input.accessNotes,
        active: input.active ?? true,
      },
    });
    await audit({
      tenantId: user.tenantId,
      userId: user.id,
      action: 'CREATE',
      entity: 'Customer',
      entityId: created.id,
      afterJson: created as never,
      ip,
    });
    return ok(created, 201);
  },
  { role: 'PLANNER' },
);
