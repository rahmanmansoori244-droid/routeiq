/**
 * Password reset token machinery — CLAUDE.md §4 + §15.
 *
 * Spec:
 *   - 32 bytes from crypto.randomBytes, base64url-encoded → returned to caller
 *   - SHA-256 hash stored in DB, never the raw token
 *   - 24h expiry, single-use (delete on consumption)
 *   - Throttle: max 3 reset requests per email per hour
 *   - Only the newest link works: issuing a token retires the user's older unused ones, and a
 *     reset retires every other token of the user, in the same transaction as the new password
 *
 * Email delivery uses Resend when RESEND_API_KEY is set. In production without it, NOTHING is
 * sent and nothing about the link is logged (a logged link is a working account-takeover token):
 * admins then reset passwords with the invite / temporary-password flow. Outside production the
 * link is logged for local testing. The handler never leaks whether an email exists — same 200
 * response either way, and delivery runs after the response (fire-and-forget).
 */
import { createHash, randomBytes } from 'crypto';
import { prisma } from './db';

export const RESET_TOKEN_BYTES = 32;
export const RESET_TOKEN_TTL_MS = 24 * 60 * 60 * 1000;
export const RESET_THROTTLE_WINDOW_MS = 60 * 60 * 1000;
export const RESET_THROTTLE_MAX = 3;

export function hashToken(rawToken: string): string {
  return createHash('sha256').update(rawToken).digest('hex');
}

export function generateRawToken(): string {
  // base64url so it's URL-safe without escaping.
  return randomBytes(RESET_TOKEN_BYTES).toString('base64url');
}

export interface CreateTokenResult {
  rawToken: string | null; // null when throttled or user missing
  status: 'created' | 'throttled' | 'unknown_email';
  /** Set when status = 'created'. */
  userId?: string;
  tenantId?: string | null;
}

/**
 * Always returns 'unknown_email' OR 'throttled' OR 'created' — never throws.
 * Callers should respond identically for the first two so the response can't
 * be used to enumerate users.
 */
export async function createResetTokenForEmail(email: string): Promise<CreateTokenResult> {
  const lowered = email.trim().toLowerCase();
  const user = await prisma.user.findUnique({
    where: { email: lowered },
    select: { id: true, tenantId: true, active: true },
  });
  if (!user || !user.active) return { rawToken: null, status: 'unknown_email' };

  // Throttle: count tokens created for this user in the last hour.
  const since = new Date(Date.now() - RESET_THROTTLE_WINDOW_MS);
  const recent = await prisma.passwordResetToken.count({
    where: { userId: user.id, createdAt: { gte: since } },
  });
  if (recent >= RESET_THROTTLE_MAX) return { rawToken: null, status: 'throttled' };

  const raw = generateRawToken();
  const now = new Date();
  await prisma.$transaction([
    // Retire older unused links (mark used rather than delete, so the throttle still counts them).
    prisma.passwordResetToken.updateMany({
      where: { userId: user.id, usedAt: null },
      data: { usedAt: now },
    }),
    prisma.passwordResetToken.create({
      data: {
        userId: user.id,
        tenantId: user.tenantId,
        tokenHash: hashToken(raw),
        expiresAt: new Date(now.getTime() + RESET_TOKEN_TTL_MS),
      },
    }),
  ]);
  return { rawToken: raw, status: 'created', userId: user.id, tenantId: user.tenantId };
}

export type ConsumeResult =
  | { ok: true; userId: string; tenantId: string | null }
  | { ok: false; reason: 'invalid' | 'expired' | 'used' };

type Tx = Parameters<Parameters<typeof prisma.$transaction>[0]>[0];

/**
 * Validate + atomically consume a token (delete-on-use). `onConsumed` runs inside the same
 * transaction, so the password update commits together with the consumption, or not at all.
 */
export async function consumeResetToken(
  rawToken: string,
  onConsumed?: (tx: Tx, row: { userId: string; tenantId: string | null }) => Promise<void>,
): Promise<ConsumeResult> {
  if (!rawToken || rawToken.length < 20) return { ok: false, reason: 'invalid' };
  const tokenHash = hashToken(rawToken);

  try {
    const result = await prisma.$transaction(async (tx) => {
      const row = await tx.passwordResetToken.findUnique({
        where: { tokenHash },
        select: { id: true, userId: true, tenantId: true, expiresAt: true, usedAt: true },
      });
      if (!row) return { ok: false as const, reason: 'invalid' as const };
      if (row.usedAt) return { ok: false as const, reason: 'used' as const };
      if (row.expiresAt < new Date()) return { ok: false as const, reason: 'expired' as const };
      // Single-use: a concurrent consume of the same token deletes 0 rows and loses.
      const deleted = await tx.passwordResetToken.deleteMany({ where: { id: row.id } });
      if (deleted.count !== 1) return { ok: false as const, reason: 'used' as const };
      if (onConsumed) await onConsumed(tx, { userId: row.userId, tenantId: row.tenantId });
      return { ok: true as const, userId: row.userId, tenantId: row.tenantId };
    });
    return result;
  } catch (err) {
    console.error('[password-reset] consume failed', (err as Error)?.message ?? err);
    return { ok: false, reason: 'invalid' };
  }
}

/** Read-only pre-check (no consumption): is this a live, unused token? */
export async function resetTokenUsable(rawToken: string): Promise<boolean> {
  if (!rawToken || rawToken.length < 20) return false;
  const row = await prisma.passwordResetToken.findUnique({
    where: { tokenHash: hashToken(rawToken) },
    select: { expiresAt: true, usedAt: true },
  });
  return !!row && !row.usedAt && row.expiresAt >= new Date();
}

/**
 * Consume the token and set the new password in ONE transaction, retiring the user's other
 * outstanding reset tokens. `passwordHash` is computed by the caller (bcrypt is slow; keep it
 * outside the transaction).
 */
export async function resetPasswordWithToken(rawToken: string, passwordHash: string): Promise<ConsumeResult> {
  return consumeResetToken(rawToken, async (tx, row) => {
    await tx.user.update({ where: { id: row.userId }, data: { passwordHash } });
    await tx.passwordResetToken.updateMany({
      where: { userId: row.userId, usedAt: null },
      data: { usedAt: new Date() },
    });
  });
}

/** Public base URL for links in emails: AUTH_URL (next-auth v5) or NEXTAUTH_URL. */
export function resetBaseUrl(env: NodeJS.ProcessEnv = process.env): string | null {
  const raw = (env.AUTH_URL ?? env.NEXTAUTH_URL ?? '').trim();
  if (raw) return raw.replace(/\/+$/, '');
  return env.NODE_ENV === 'production' ? null : 'http://localhost:3000';
}

export function resetUrlFor(rawToken: string, env: NodeJS.ProcessEnv = process.env): string | null {
  const base = resetBaseUrl(env);
  return base ? `${base}/reset?token=${encodeURIComponent(rawToken)}` : null;
}

export function emailDeliveryConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return !!env.RESEND_API_KEY?.trim();
}

/**
 * Send the reset link via Resend if configured. Without it: in production nothing is sent and
 * only the user id is logged; elsewhere the link is logged for local testing.
 * Never throws — the API route's "200 either way" contract requires it.
 */
export async function deliverResetEmail(
  email: string,
  rawToken: string,
  userId: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const production = env.NODE_ENV === 'production';
  const resetUrl = resetUrlFor(rawToken, env);
  if (!resetUrl) {
    console.error('[password-reset] AUTH_URL / NEXTAUTH_URL is not set; reset link NOT sent', { userId });
    return;
  }
  const apiKey = env.RESEND_API_KEY?.trim();
  if (!apiKey) {
    if (production) {
      console.error('[password-reset] email is not configured (RESEND_API_KEY); reset link NOT sent', { userId });
    } else {
      console.info(`[password-reset] dev only, no email configured: reset link for ${email}: ${resetUrl}`);
    }
    return;
  }
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        from: env.RESEND_FROM ?? 'RouteIQ <noreply@routeiq.io>',
        to: email,
        subject: 'Reset your RouteIQ password',
        text:
          `A password reset was requested for your RouteIQ account. ` +
          `If this was you, follow the link below (valid for 24 hours):\n\n${resetUrl}\n\n` +
          `If it wasn't you, you can safely ignore this email.`,
      }),
    });
    if (!res.ok) {
      // Resend's error body never contains the link; keep the status only.
      console.error('[password-reset] Resend rejected the request', res.status, { userId });
    }
  } catch (err) {
    console.error('[password-reset] email send failed', (err as Error)?.message ?? err, { userId });
  }
}
