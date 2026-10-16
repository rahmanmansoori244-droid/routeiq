/**
 * IVMS live link (16 Oct 2026): who may call the Ayun webhook, POST/GET /api/ivms/ayun/<secret>. Ayun
 * cannot sign its calls or send a header of ours, so the shared secret is the last part of the URL's PATH
 * (not its query: the provider appends "?username=..." to the address). In the style of
 * lib/janitor-auth.ts: the path segment is compared with AYUN_WEBHOOK_SECRET and, during a rotation,
 * AYUN_WEBHOOK_SECRET_PREVIOUS, as SHA-256 digests of equal length in constant time, every accepted secret
 * checked (no early exit), so neither the length nor a prefix of a secret leaks through timing.
 * The secret binds the call to the one company of the Ayun account (AYUN_TENANT_SLUG).
 */
import { createHash } from 'node:crypto';
import { constantTimeEqual } from '../crypto';
import type { IvmsEnv } from './env';

const SECRET_SHAPE = /^[A-Za-z0-9_-]{32,128}$/;
const digest = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');

export function ivmsWebhookAuthorized(secret: unknown, env: Pick<IvmsEnv, 'webhookSecrets'>): boolean {
  if (typeof secret !== 'string' || !env.webhookSecrets.length || secret.length > 256) return false;
  const got = digest(secret);
  let ok = false;
  for (const s of env.webhookSecrets) ok = constantTimeEqual(got, digest(s)) || ok;
  return ok && SECRET_SHAPE.test(secret);
}
