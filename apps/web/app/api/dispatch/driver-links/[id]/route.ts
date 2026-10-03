import { z } from 'zod';
import { withTenantApi, ok, parseBody } from '@/lib/api';
import { reissueLink, revokeLink } from '@/lib/driver-link/service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface Params { params: { id: string } }

const schema = z
  .object({
    action: z.enum(['REISSUE', 'REVOKE']),
    reason: z.string().trim().max(200).optional(),
  })
  .strict();

// PATCH /api/dispatch/driver-links/:id { action: REISSUE | REVOKE, reason? } (owner request 4 Oct
// 2026). Reissue: a new link; the old one answers "replaced" at once (printed sheets and WhatsApp
// messages already sent stop working). Revoke: no link works until a reissue. Both audited.
export const PATCH = (req: Request, { params }: Params) =>
  withTenantApi(
    async (r, { user }) => {
      const { action, reason } = await parseBody(r, schema);
      const opts = { origin: new URL(r.url).origin };
      const view =
        action === 'REISSUE'
          ? await reissueLink(user.tenantId, params.id, user.id, reason ?? null, opts)
          : await revokeLink(user.tenantId, params.id, user.id, reason ?? null, opts);
      return ok(view);
    },
    { role: 'PLANNER' },
  )(req);
