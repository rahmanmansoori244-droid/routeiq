/**
 * Plain-text e-mail through Resend's HTTP API (operations alerts, owner request 16 Oct 2026). The same
 * `fetch` shape as the password reset (lib/password-reset.ts deliverResetEmail, left as it is), plus a
 * timeout, so a slow provider never holds the alert sweep.
 *
 * Never throws. Never logs an address, a subject or a body: the caller logs counts only.
 */

/** The provider gives up after this long (the sweep runs every 2 min). */
export const EMAIL_TIMEOUT_MS = 10_000;
/** Resend's endpoint (the password reset uses the same). */
export const RESEND_URL = 'https://api.resend.com/emails';

/**
 * Whether alert e-mail can go out: a Resend key AND a sender set on the server. Unlike the password
 * reset, there is no default sender: Resend refuses a sender whose domain is not verified, so an
 * unset RESEND_FROM would fail every digest.
 */
export function plainEmailConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return !!env.RESEND_API_KEY?.trim() && !!env.RESEND_FROM?.trim();
}

export interface PlainEmail {
  /** One or more addresses; sent as one message (every recipient sees the others, like the company's own list). */
  to: string[];
  subject: string;
  text: string;
}

export type SendResult =
  | { ok: true }
  | {
      ok: false;
      /** NOT_CONFIGURED: no key or sender; NO_RECIPIENTS; REJECTED: the provider answered an error; FAILED: no answer (network, timeout). */
      reason: 'NOT_CONFIGURED' | 'NO_RECIPIENTS' | 'REJECTED' | 'FAILED';
      /** The provider's HTTP status (REJECTED). */
      status?: number;
      /** Short and safe to store: a status or an error class, never an address or the provider's body. */
      error: string;
    };

/** Send one plain-text e-mail. `fetchImpl` is the test seam. */
export async function sendPlainEmail(msg: PlainEmail, env: NodeJS.ProcessEnv = process.env, fetchImpl: typeof fetch = fetch): Promise<SendResult> {
  const apiKey = env.RESEND_API_KEY?.trim();
  const from = env.RESEND_FROM?.trim();
  if (!apiKey || !from) return { ok: false, reason: 'NOT_CONFIGURED', error: 'e-mail is not set up on the server' };
  const to = msg.to.map((a) => a.trim()).filter(Boolean);
  if (!to.length) return { ok: false, reason: 'NO_RECIPIENTS', error: 'no recipients' };
  try {
    const res = await fetchImpl(RESEND_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ from, to, subject: msg.subject, text: msg.text }),
      signal: AbortSignal.timeout(EMAIL_TIMEOUT_MS),
    });
    if (!res.ok) return { ok: false, reason: 'REJECTED', status: res.status, error: `provider answered ${res.status}` };
    return { ok: true };
  } catch (err) {
    const name = (err as Error)?.name;
    return { ok: false, reason: 'FAILED', error: name === 'TimeoutError' || name === 'AbortError' ? 'no answer within 10 s' : 'network error' };
  }
}
