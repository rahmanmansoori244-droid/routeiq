/**
 * Configuration checks logged once when the web server starts (instrumentation.ts). They never
 * stop the server; they make a missing production setting visible in the Railway logs.
 */
import { rateLimitConfigProblem } from './rate-limit';

export interface ConfigProblem {
  level: 'error' | 'warn';
  message: string;
}

export function configProblems(env: NodeJS.ProcessEnv = process.env): ConfigProblem[] {
  const out: ConfigProblem[] = [];
  const limits = rateLimitConfigProblem(env);
  if (limits) out.push({ level: 'error', message: limits });
  if ((env.FEASIBILITY_GATE ?? '').trim().toLowerCase() === 'warn') {
    out.push({
      level: 'warn',
      message:
        'FEASIBILITY_GATE=warn: trucks whose times break a planning rule (loading time between loads, receiving hours, payload, shift) can be locked and dispatched. Emergency switch only - remove it to enforce the check again.',
    });
  }
  if (env.NODE_ENV !== 'production') return out;

  if (!env.RESEND_API_KEY?.trim()) {
    out.push({
      level: 'warn',
      message:
        'Password-reset email is not configured (RESEND_API_KEY): reset links are not sent and /forgot says so. Tenant admins reset passwords on the Users screen ("Reset password").',
    });
  }
  if (!env.AUTH_URL?.trim() && !env.NEXTAUTH_URL?.trim()) {
    out.push({ level: 'warn', message: 'AUTH_URL / NEXTAUTH_URL is not set: password-reset links cannot be built.' });
  }
  if (!env.JANITOR_TOKEN?.trim()) {
    out.push({
      level: 'warn',
      message: 'JANITOR_TOKEN is not set: /api/cron/janitor refuses every call (the in-process janitor still runs).',
    });
  }
  return out;
}
