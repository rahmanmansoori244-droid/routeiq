/**
 * Public sign-up policy (review F10, owner decision Sep 2026).
 *
 * Sign-up stays OPEN by default in every environment: it creates a new company (tenant) whose
 * first user is that company's TENANT_ADMIN, never a platform admin. Set `SIGNUP_MODE=closed` to
 * turn it off (the API answers 404 and the screens say so). Platform admins (SUPER_ADMIN) are made
 * only by the owner-run script apps/web/prisma/grant-platform-admin.ts.
 */
export type SignupMode = 'open' | 'closed';

export function signupMode(env: NodeJS.ProcessEnv = process.env): SignupMode {
  return (env.SIGNUP_MODE ?? '').trim().toLowerCase() === 'closed' ? 'closed' : 'open';
}

export function signupOpen(env: NodeJS.ProcessEnv = process.env): boolean {
  return signupMode(env) === 'open';
}
