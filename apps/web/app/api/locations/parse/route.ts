import { z } from 'zod';
import { withTenantApi, ok, parseBody } from '@/lib/api';
import { resolveLocationInput } from '@/lib/dispatch/location-input';
import { parseServiceArea } from '@/lib/dispatch/customer-attrs';
import { rateLimit } from '@/lib/rate-limit';

const schema = z.object({ input: z.string().max(2000) });

// POST /api/locations/parse { input } - read a Google Maps link / coordinates. Short links are
// resolved server-side (Google hosts only). Nothing is saved here.
export const POST = withTenantApi(
  async (req, { db, user }) => {
    const rl = rateLimit(`loc-parse:${user.tenantId}:${user.id}`, 120, 60_000);
    if (!rl.ok) return ok({ ok: false, needsPin: true, warnings: [], error: 'Too many lookups - wait a minute.' });
    const { input } = await parseBody(req, schema);
    const cfg = await db.tenantConfig.findUnique({ where: { tenantId: user.tenantId } });
    const res = await resolveLocationInput(input, { area: parseServiceArea(cfg?.serviceAreaJson) });
    return ok(res);
  },
  { role: 'PLANNER' },
);
