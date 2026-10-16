import { z } from 'zod';
import { withTenantApi, ok, fail, parseBody } from '@/lib/api';
import { audit } from '@/lib/audit';
import { isoDateSchema } from '@/lib/schemas';
import { isoOf } from '@/lib/dispatch/time';
import { ackAlerts } from '@/lib/alerts/inbox';
import { ALERT_ACK_MAX_IDS, ALERT_MAX_TIER } from '@/lib/alerts/catalog';

const id = z.string().min(1).max(64);
const schema = z.union([
  z
    .object({
      ids: z.array(id).min(1).max(ALERT_ACK_MAX_IDS),
      // The tier each row was shown at: a row that became worse since is left open.
      seen: z.record(id, z.number().int().min(1).max(ALERT_MAX_TIER)).optional(),
    })
    .strict(),
  z.object({ all: z.object({ date: isoDateSchema.optional(), depotId: id.optional() }).strict() }).strict(),
]);

/** The audit row lists at most this many ids (the count is always exact). */
const AUDIT_IDS_MAX = 200;

// POST /api/alerts/ack { ids, seen? } | { all: { date?, depotId? } } - acknowledge operations alerts
// (owner request 16 Oct 2026): the dispatcher and up (PLANNER+), for the whole company (one shared state,
// not per user). Only open rows change; ids of another company, or none known, answer 404. One audit row
// ALERTS_ACKNOWLEDGED per request that changed something (raising an alert is not audited).
export const POST = withTenantApi(
  async (req, { user }) => {
    const body = await parseBody(req, schema);
    const now = new Date();
    const { acked, known } = await ackAlerts(user.tenantId, user.id, body, now, (tx, rows) =>
      audit(
        {
          tenantId: user.tenantId,
          userId: user.id,
          action: 'ALERTS_ACKNOWLEDGED',
          entity: 'OpsAlert',
          entityId: rows.length === 1 ? rows[0]!.id : null,
          afterJson: {
            count: rows.length,
            ids: rows.slice(0, AUDIT_IDS_MAX).map((r) => r.id),
            rules: [...new Set(rows.map((r) => r.rule))].sort(),
            dates: [...new Set(rows.map((r) => isoOf(r.deliveryDate)))].sort(),
            ...('all' in body ? { all: { date: body.all.date ?? null, depotId: body.all.depotId ?? null } } : {}),
          },
        },
        tx,
      ),
    );
    if (known === 0) return fail('Not found.', 404);
    return ok({ acked: acked.length, ids: acked.map((r) => r.id) });
  },
  { role: 'PLANNER', rateLimitKey: 'alerts' },
);
