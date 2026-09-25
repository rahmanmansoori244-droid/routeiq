/**
 * Session revalidation (review F09).
 *
 * Sessions are NextAuth JWT cookies. Without this module the claims written at sign-in (role,
 * tenant) were trusted until the cookie expired, and the cookie's expiry slid forward on every
 * request, so a deactivated, demoted or password-reset user kept their session indefinitely.
 *
 * Now:
 * - every session has an ABSOLUTE lifetime of 12 h from sign-in (`authTime` claim), checked in
 *   every runtime, the edge middleware included (no database there);
 * - in the Node runtime every session read re-loads the user (`loadPrincipal`, cached 30 s) and
 *   drops the session when the user is inactive or gone, the tenant is inactive or changed, or
 *   the password changed since sign-in (`pwf`, a fingerprint of the password hash). Role and
 *   tenant are overwritten with the database values, so a role change applies within 30 s
 *   (immediately on this server when it goes through the users API, which invalidates the cache);
 * - SUPER_ADMIN is honoured only when the email is also in `SUPER_ADMIN_EMAILS`. Otherwise the
 *   user acts as TENANT_ADMIN of their own tenant, or has no session if they have no tenant.
 *
 * Cookies minted before this change have no `authTime`/`pwf`, so they are invalid: every user
 * signs in once after the deploy.
 */
import type { Role } from '@prisma/client';
import { prisma } from './db';

/** Absolute session lifetime: one dispatch shift. */
export const SESSION_ABSOLUTE_MS = 12 * 60 * 60 * 1000;
/** How long a loaded principal is trusted before it is read again. */
export const PRINCIPAL_TTL_MS = 30_000;
/** If the database fails, a principal loaded this recently is still used (short outage grace). */
export const PRINCIPAL_STALE_IF_ERROR_MS = 10 * 60_000;
export const PRINCIPAL_CACHE_MAX = 1000;
/** Clock skew tolerated on `authTime` (it is written by this server, so this is just slack). */
const AUTH_TIME_SKEW_MS = 60_000;

export interface SessionClaims {
  userId?: unknown;
  tenantId?: unknown;
  role?: unknown;
  pwf?: unknown;
  authTime?: unknown;
  [key: string]: unknown;
}

export interface Principal {
  userId: string;
  email: string;
  active: boolean;
  role: Role;
  tenantId: string | null;
  /** null when the user has no tenant. */
  tenantActive: boolean | null;
  /** Fingerprint of the current password hash. */
  pwf: string;
}

// ---------------------------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------------------------

export function superAdminAllowlist(env: NodeJS.ProcessEnv = process.env): Set<string> {
  return new Set(
    (env.SUPER_ADMIN_EMAILS ?? '')
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  );
}

export function isSuperAdminEmail(email: string, env: NodeJS.ProcessEnv = process.env): boolean {
  return superAdminAllowlist(env).has(email.trim().toLowerCase());
}

/**
 * First 16 hex chars of SHA-256(passwordHash). Changes whenever the password changes. It lives
 * inside the encrypted session JWT, never in the clear. Web Crypto, so it also runs on the edge.
 */
export async function passwordFingerprint(passwordHash: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(passwordHash));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0'))
    .join('')
    .slice(0, 16);
}

/** SUPER_ADMIN needs the database role AND the env allowlist; otherwise TENANT_ADMIN or nothing. */
export function effectiveRole(
  role: Role,
  email: string,
  tenantId: string | null,
  env: NodeJS.ProcessEnv = process.env,
): Role | null {
  if (role !== 'SUPER_ADMIN') return role;
  if (isSuperAdminEmail(email, env)) return 'SUPER_ADMIN';
  return tenantId ? 'TENANT_ADMIN' : null;
}

/** DB-free check, safe on the edge: the session is younger than the absolute lifetime. */
export function withinAbsoluteLifetime(claims: SessionClaims, now: number = Date.now()): boolean {
  const t = claims.authTime;
  if (typeof t !== 'number' || !Number.isFinite(t)) return false;
  if (t > now + AUTH_TIME_SKEW_MS) return false;
  return now - t <= SESSION_ABSOLUTE_MS;
}

/**
 * The decision, given a freshly loaded principal. Returns the claims to keep (role and tenant
 * from the database), or null when the session must end.
 */
export function evaluatePrincipal(
  claims: SessionClaims,
  principal: Principal | null,
  env: NodeJS.ProcessEnv = process.env,
): { role: Role; tenantId: string | null } | null {
  if (!principal || !principal.active) return null;
  if (typeof claims.pwf !== 'string' || claims.pwf !== principal.pwf) return null;
  const claimTenant = typeof claims.tenantId === 'string' ? claims.tenantId : null;
  if (claimTenant !== principal.tenantId) return null;
  if (principal.tenantId && principal.tenantActive !== true) return null;
  const role = effectiveRole(principal.role, principal.email, principal.tenantId, env);
  if (!role) return null;
  if (!principal.tenantId && role !== 'SUPER_ADMIN') return null;
  return { role, tenantId: principal.tenantId };
}

// ---------------------------------------------------------------------------------------------
// Cache + loader (Node runtime only)
// ---------------------------------------------------------------------------------------------

interface CacheEntry {
  principal: Principal | null;
  at: number;
}

const g = globalThis as unknown as { __routeiqPrincipals?: Map<string, CacheEntry> };
const cache: Map<string, CacheEntry> = g.__routeiqPrincipals ?? new Map();
g.__routeiqPrincipals = cache;

function remember(userId: string, entry: CacheEntry) {
  cache.delete(userId);
  if (cache.size >= PRINCIPAL_CACHE_MAX) {
    const now = entry.at;
    for (const [k, v] of cache) if (now - v.at > PRINCIPAL_STALE_IF_ERROR_MS) cache.delete(k);
    while (cache.size >= PRINCIPAL_CACHE_MAX) {
      const oldest = cache.keys().next().value;
      if (oldest === undefined) break;
      cache.delete(oldest);
    }
  }
  cache.set(userId, entry);
}

type PrincipalDb = Pick<typeof prisma, 'user'>;

async function readPrincipal(userId: string, db: PrincipalDb): Promise<Principal | null> {
  const u = await db.user.findUnique({
    where: { id: userId },
    select: {
      id: true,
      email: true,
      active: true,
      role: true,
      tenantId: true,
      passwordHash: true,
      tenant: { select: { active: true } },
    },
  });
  if (!u) return null;
  return {
    userId: u.id,
    email: u.email,
    active: u.active,
    role: u.role,
    tenantId: u.tenantId,
    tenantActive: u.tenant ? u.tenant.active : null,
    pwf: await passwordFingerprint(u.passwordHash),
  };
}

/**
 * The user's current account state, read at most once per PRINCIPAL_TTL_MS. Throws only when the
 * database fails and no reading from the last PRINCIPAL_STALE_IF_ERROR_MS is cached.
 */
export async function loadPrincipal(
  userId: string,
  opts: { now?: number; db?: PrincipalDb } = {},
): Promise<Principal | null> {
  const now = opts.now ?? Date.now();
  const hit = cache.get(userId);
  if (hit && now - hit.at < PRINCIPAL_TTL_MS) return hit.principal;
  try {
    const principal = await readPrincipal(userId, opts.db ?? prisma);
    remember(userId, { principal, at: now });
    return principal;
  } catch (err) {
    if (hit && now - hit.at < PRINCIPAL_STALE_IF_ERROR_MS) return hit.principal;
    throw err;
  }
}

/** Forget one user's cached state (after a role, active or password change). */
export function invalidatePrincipal(userId: string): void {
  cache.delete(userId);
}

/** Forget every cached user of a tenant (after the tenant is suspended or restored). */
export function invalidateTenant(tenantId: string): void {
  for (const [k, v] of cache) if (v.principal?.tenantId === tenantId) cache.delete(k);
}

export function _resetPrincipalCache(): void {
  cache.clear();
}

/**
 * The jwt-callback step for an existing session (Node runtime): returns the claims with role and
 * tenant refreshed from the database, or null to end the session. Fails closed on a database
 * error unless a recent reading is cached.
 */
export async function refreshSessionClaims<T extends SessionClaims>(
  claims: T,
  opts: { now?: number; db?: PrincipalDb; env?: NodeJS.ProcessEnv } = {},
): Promise<T | null> {
  const now = opts.now ?? Date.now();
  if (!withinAbsoluteLifetime(claims, now)) return null;
  if (typeof claims.userId !== 'string' || !claims.userId) return null;
  let principal: Principal | null;
  try {
    principal = await loadPrincipal(claims.userId, { now, db: opts.db });
  } catch (err) {
    console.error('[session] could not load the signed-in user; ending the session', (err as Error)?.message ?? err);
    return null;
  }
  const verdict = evaluatePrincipal(claims, principal, opts.env);
  if (!verdict) return null;
  return { ...claims, role: verdict.role, tenantId: verdict.tenantId };
}
