import { withTenantApi, ok, fail } from '@/lib/api';
import { trackerSuggestions, type TrackerListCall } from '@/lib/ivms/tracker-admin';

export const dynamic = 'force-dynamic';

/**
 * The provider call of the picker: one USER_GET_OBJECTS in the ADMIN class of the allowance, made by the
 * IVMS client (lib/ivms/ayun-client.ts with the ADMIN claim of lib/ivms/store.ts). Wired here when the
 * client lands; null = suggestions not available (the admin types the IMEI).
 */
const TRACKER_LIST_CALL: TrackerListCall | null = null;

// POST /api/ivms/objects - GPS tracker suggestions for the trucks without one (IVMS live link, 16 Oct
// 2026): ONE call to Ayun's object list, matched to the trucks by plate digits on the server. Company
// admin only; 3 calls per 10 minutes per user; never while GPS tracking is OFF. The answer carries the
// IMEIs, how well each matches and how old its last fix is: never a provider name or plate. Nothing is stored.
export const POST = (req: Request) =>
  withTenantApi(
    async (_r, { user }) => {
      const r = await trackerSuggestions(user.tenantId, TRACKER_LIST_CALL);
      if (!r.ok) return fail({ code: r.reason, message: r.message }, r.reason === 'MODE_OFF' || r.reason === 'OTHER_COMPANY' || r.reason === 'NOT_CONFIGURED' || r.reason === 'DISABLED' ? 409 : 502);
      return ok(r);
    },
    { role: 'TENANT_ADMIN', rateLimitKey: 'ivms-objects', rateLimitLimit: 3, rateLimitWindowMs: 10 * 60_000 },
  )(req);
