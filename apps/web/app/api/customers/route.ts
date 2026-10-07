import { withTenantApi, ok, parseBody, fail } from '@/lib/api';
import { customerSchema, normalizeBranchKey } from '@/lib/schemas';
import { audit } from '@/lib/audit';
import { parseLocationInput } from '@/lib/dispatch/location-input';
import { tenantServiceArea } from '@/lib/dispatch/service-area';
import { customerTwinsOf } from '@/lib/customer-code';

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
      .catch(() => ({}))) as { avgServiceTimeMin?: unknown; lat?: unknown; lng?: unknown };
    const serviceTimeGiven = raw?.avgServiceTimeMin !== undefined && raw?.avgServiceTimeMin !== null && raw?.avgServiceTimeMin !== '';
    const input = await parseBody(req, customerSchema);
    if (input.regionId) {
      const region = await db.region.findUnique({ where: { id: input.regionId } });
      if (!region) return fail('Region not found in this tenant', 400);
    }
    // Coordinates are checked like a Read (owner's location rule, audit PR A5): a pair that needs a
    // pin (fewer than 4 decimals, swapped, outside the delivery area, 0,0) is refused, never stored
    // as a usable location. The text as sent is read, and of the zeros at the end of each coordinate
    // only one counts (owner decision of 28 Sep 2026, "Same rule everywhere", as in the customer
    // import): "23.5800" is 3 decimals. A JSON number has no zeros at the end (23.58).
    let loc: { lat: number; lng: number } | null = null;
    if (input.lat !== undefined || input.lng !== undefined) {
      if (input.lat === undefined || input.lng === undefined) return fail('Send both lat and lng, or neither.', 400);
      const p = parseLocationInput(`${String(raw.lat).trim()}, ${String(raw.lng).trim()}`, await tenantServiceArea(user.tenantId));
      if (!p.ok || p.needsPin || p.lat === undefined || p.lng === undefined) {
        // The reasons as sentences (they end with a full stop), then what to do.
        const why = (p.ok ? p.warnings.join(' ') : p.error ?? '').trim();
        return fail(
          {
            code: 'PIN_REQUIRED',
            message: `This location is not exact.${why ? ` ${why}` : ''} Create the customer without coordinates, then set its location on the map (Set location on the customer page).`,
            parse: p,
          } as Record<string, unknown>,
          422,
        );
      }
      loc = { lat: p.lat, lng: p.lng };
    }
    const branchKey = normalizeBranchKey(input.branchCode);
    // Codes are one customer whatever their letter case (the order intake matches them that way):
    // "c001" next to "C001" would split one customer's orders between two rows. Matched in the
    // program (lib/customer-code.ts): the database's case-insensitive equals is an ILIKE, which read
    // "_" as "any character", so "C_1" was refused because "CX1" exists.
    const twin = customerTwinsOf(await db.customer.findMany({ select: { code: true, branchCode: true, branchKey: true } }), input.code, branchKey)[0];
    if (twin) {
      return fail(`Customer ${twin.code}${twin.branchCode ? ` / ${twin.branchCode}` : ''} already exists (codes are the same whatever the letter case).`, 409);
    }
    const created = await db.customer.create({
      data: {
        tenantId: user.tenantId,
        code: input.code,
        name: input.name,
        branchCode: input.branchCode,
        branchKey,
        regionId: input.regionId,
        address: input.address,
        lat: loc?.lat,
        lng: loc?.lng,
        // An accepted reading is always HIGH (the parser asks for a pin for every other one).
        geocodeConfidence: loc ? 'HIGH' : 'MISSING',
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
