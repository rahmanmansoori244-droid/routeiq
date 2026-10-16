/**
 * The Ayun webhook (IVMS live link, 16 Oct 2026): GET or POST /api/ivms/ayun/<AYUN_WEBHOOK_SECRET>.
 * Outside withTenantApi on purpose: Ayun has no session. The path secret is the authentication
 * (lib/ivms/webhook-auth.ts ivmsWebhookAuthorized: constant-time, the current and the previous secret),
 * and it binds the call to the one company of the Ayun account. Everything else - the kill switch, the
 * mode, the rate limits, the body cap, the fields read, the IMEI lookup in that company only, the
 * idempotency - is lib/ivms/webhook.ts handleAyunWebhook. 404 while no secret is configured.
 */
import { handleAyunWebhook } from '@/lib/ivms/webhook';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Ctx = { params: { secret: string } };

export async function GET(req: Request, { params }: Ctx) {
  return handleAyunWebhook(req, params.secret);
}

export async function POST(req: Request, { params }: Ctx) {
  return handleAyunWebhook(req, params.secret);
}
