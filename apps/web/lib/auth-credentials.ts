/**
 * Email + password check behind the NextAuth Credentials provider (review F16, account
 * enumeration).
 *
 * - Timing: an unknown email is compared against a throw-away bcrypt hash of the same cost, and
 *   an inactive user or tenant is refused only after the real compare, so the response time does
 *   not reveal which accounts exist.
 * - Throttling, soft (it pauses attempts; it never locks an account an attacker could keep
 *   locked):
 *     * per IP + email: 5 failures in 15 min pause that pair; a success clears the counter;
 *     * per IP: 30 attempts in 10 min. Skipped when the client IP cannot be resolved (a proxy
 *       misconfiguration, logged once by lib/client-ip.ts): every caller would then share one
 *       bucket, and one outsider could pause sign-in for all tenants;
 *     * per email: 20 failures in 1 h, from any IP, write one LOGIN_THROTTLED audit row in the
 *       user's tenant so an admin sees the guessing. It does not block the account.
 * - One outcome for the caller: a generic sign-in error, whatever the reason.
 */
import bcrypt from 'bcryptjs';
import { CredentialsSignin } from 'next-auth';
import type { Role } from '@prisma/client';
import { z } from 'zod';
import { prisma } from './db';
import { audit } from './audit';
import { clientIp } from './client-ip';
import { LIMITS, limiter, type RateLimiter } from './rate-limit';
import { effectiveRole, passwordFingerprint } from './session-principal';

/** The single message the login form shows for every failure. */
export const LOGIN_FAILED_MESSAGE =
  'Invalid email or password. After several failed attempts, sign-in pauses for a few minutes.';

export class LoginThrottled extends CredentialsSignin {
  code = 'throttled';
}

export const credentialsSchema = z.object({
  email: z.string().email().max(254),
  password: z.string().min(8).max(200),
});

export interface AuthorizedUser {
  id: string;
  tenantId: string | null;
  role: Role;
  name: string;
  email: string;
  /** Password fingerprint for the session (lib/session-principal.ts). */
  pwf: string;
}

// Same cost as hashPassword() in lib/auth.ts, so a compare against it takes as long as a real one.
const BCRYPT_COST = 12;
let dummyHash: Promise<string> | null = null;
function dummyPasswordHash(): Promise<string> {
  if (!dummyHash) {
    const bytes = new Uint8Array(24);
    globalThis.crypto.getRandomValues(bytes);
    const secret = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
    dummyHash = bcrypt.hash(secret, BCRYPT_COST);
  }
  return dummyHash;
}

type CredentialsDb = Pick<typeof prisma, 'user'>;

export interface VerifyDeps {
  db?: CredentialsDb;
  limiter?: RateLimiter;
  audit?: typeof audit;
  env?: NodeJS.ProcessEnv;
}

export function loginKeys(ip: string, email: string) {
  return {
    ip: `login:ip:${ip}`,
    ipEmail: `login:ipemail:${ip}:${email}`,
    email: `login:email:${email}`,
  };
}

/**
 * Returns the signed-in user, returns null for wrong credentials (NextAuth then reports a
 * generic CredentialsSignin), or throws LoginThrottled while a throttle is active.
 */
export async function verifyCredentials(
  raw: unknown,
  request?: Request,
  deps: VerifyDeps = {},
): Promise<AuthorizedUser | null> {
  const db = deps.db ?? prisma;
  const lim = deps.limiter ?? limiter;
  const writeAudit = deps.audit ?? audit;
  const env = deps.env ?? process.env;

  const parsed = credentialsSchema.safeParse(raw);
  if (!parsed.success) return null;
  const email = parsed.data.email.trim().toLowerCase();
  const ip = request ? clientIp(request, env) : null;
  const keys = loginKeys(ip ?? 'unknown', email);

  // No per-IP cap without a real IP: a shared 'unknown' bucket would let one caller pause sign-in
  // for everyone. The ip+email and per-email counters still apply.
  const ipOk = ip === null || lim.consume(keys.ip, LIMITS.loginIpAttempts.limit, LIMITS.loginIpAttempts.windowMs).ok;
  if (!ipOk || lim.isBlocked(keys.ipEmail, LIMITS.loginIpEmailFailures.limit)) throw new LoginThrottled();

  const user = await db.user.findUnique({
    where: { email },
    select: {
      id: true,
      email: true,
      name: true,
      role: true,
      active: true,
      tenantId: true,
      passwordHash: true,
      tenant: { select: { active: true } },
    },
  });

  // Always one bcrypt compare, against the real hash or a throw-away one.
  const passwordOk = await bcrypt.compare(parsed.data.password, user?.passwordHash ?? (await dummyPasswordHash()));

  const role = user ? effectiveRole(user.role, user.email, user.tenantId, env) : null;
  const allowed =
    !!user &&
    passwordOk &&
    user.active &&
    (user.tenantId ? user.tenant?.active === true : role === 'SUPER_ADMIN') &&
    role !== null;

  if (!allowed || !user || !role) {
    lim.hit(keys.ipEmail, LIMITS.loginIpEmailFailures.windowMs);
    const emailFailures = lim.hit(keys.email, LIMITS.loginEmailFailures.windowMs);
    if (emailFailures === LIMITS.loginEmailFailures.limit && user?.tenantId) {
      try {
        await writeAudit({
          tenantId: user.tenantId,
          userId: user.id,
          action: 'LOGIN_THROTTLED',
          entity: 'User',
          entityId: user.id,
          afterJson: { failedSignInsLastHour: emailFailures },
          ip,
        });
      } catch (err) {
        console.error('[auth] LOGIN_THROTTLED audit failed', (err as Error)?.message ?? err);
      }
    }
    return null;
  }

  lim.reset(keys.ipEmail);
  return {
    id: user.id,
    tenantId: user.tenantId,
    role,
    name: user.name,
    email: user.email,
    pwf: await passwordFingerprint(user.passwordHash),
  };
}
