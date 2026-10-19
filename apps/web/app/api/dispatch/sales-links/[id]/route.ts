import { z } from 'zod';
import { withTenantApi, ok, parseBody } from '@/lib/api';
import { reissueSalesLink, revokeSalesLink } from '@/lib/sales-link/service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface Params { params: { id: string } }

const schema = z
  .object({
    action: z.enum(['REISSUE', 'REVOKE']),
    reason: z.string().trim().max(200).optional(),
  })
  .strict();

// PATCH /api/dispatch/sales-links/:id { action: REISSUE | REVOKE, reason? } (owner request 19 Oct 2026).
// REISSUE ("Make a new link"): the old link answers "replaced" at once and must be sent to the group again; the
// end time is kept. REVOKE ("Turn off"): no link of that day works until a new one is made; idempotent. Both
// audited. Another company's id: 404.
export const PATCH = (req: Request, { params }: Params) =>
  withTenantApi(
    async (r, { user }) => {
      const { action, reason } = await parseBody(r, schema);
      const opts = { origin: new URL(r.url).origin };
      const view =
        action === 'REISSUE'
          ? await reissueSalesLink(user.tenantId, params.id, user.id, reason ?? null, opts)
          : await revokeSalesLink(user.tenantId, params.id, user.id, reason ?? null, opts);
      return ok(view);
    },
    { role: 'PLANNER' },
  )(req);
