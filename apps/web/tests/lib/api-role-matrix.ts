/**
 * Reads every app/api/**\/route.ts and reports, per exported HTTP handler, how it is guarded:
 *   PUBLIC            no session needed (sign-in, sign-up, health, ...)
 *   TOKEN             a service token (janitor)
 *   GONE              retired, always 410 (lib/driver-app.ts)
 *   ANY               withTenantApi without a role: any signed-in tenant user, VIEWER included
 *   <ROLE>            withTenantApi({ role }) minimum role
 *   SESSION:<ROLE>    calls auth() itself and checks the role in the handler
 * Used by api-role-matrix.spec.ts, which compares it with the checked-in expectation.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const;

function routeFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) routeFiles(p, out);
    else if (name === 'route.ts') out.push(p);
  }
  return out;
}

function classify(segment: string, whole: string): string {
  if (/driverAppGone\(/.test(segment)) return 'GONE';
  if (/withTenantApi\(/.test(segment)) {
    const opts = [...segment.matchAll(/\}\s*,\s*\{\s*role:\s*'(\w+)'/g)];
    return opts.length ? opts[opts.length - 1]![1]! : 'ANY';
  }
  if (/janitorAuthorized|authorize\(req\)/.test(segment) || /janitorAuthorized/.test(whole)) return 'TOKEN';
  if (/await auth\(\)/.test(segment)) {
    const role = /hasRole\([^,]+,\s*'(\w+)'\)/.exec(segment);
    const can = /\b(canPlan|canManageMasterData|canApproveOverride)\(/.exec(segment);
    const map: Record<string, string> = { canPlan: 'PLANNER', canManageMasterData: 'TENANT_ADMIN', canApproveOverride: 'SUPERVISOR' };
    return `SESSION:${role?.[1] ?? (can ? map[can[1]!] : 'ANY')}`;
  }
  if (/fail\([^)]*,\s*405\)/.test(segment)) return '405';
  return 'PUBLIC';
}

export function apiRoleMatrix(webRoot: string): Record<string, string> {
  const apiDir = path.join(webRoot, 'app', 'api');
  const out: Record<string, string> = {};
  for (const file of routeFiles(apiDir)) {
    const src = readFileSync(file, 'utf8');
    const route = '/' + path.relative(path.join(webRoot, 'app'), path.dirname(file)).split(path.sep).join('/');
    // `export const { GET, POST } = handlers` (NextAuth)
    const destructured = /export const \{([^}]+)\}\s*=\s*handlers/.exec(src);
    if (destructured) {
      for (const m of destructured[1]!.split(',').map((s) => s.trim())) out[`${m} ${route}`] = 'PUBLIC';
      continue;
    }
    const starts: { method: string; at: number }[] = [];
    for (const m of src.matchAll(/export\s+(?:const|async function|function)\s+(GET|POST|PUT|PATCH|DELETE)\b/g)) {
      starts.push({ method: m[1]!, at: m.index! });
    }
    starts.sort((a, b) => a.at - b.at);
    starts.forEach((s, i) => {
      const seg = src.slice(s.at, i + 1 < starts.length ? starts[i + 1]!.at : undefined);
      out[`${s.method} ${route}`] = classify(seg, src);
    });
  }
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => {
    const [ma, ra] = a.split(' ');
    const [mb, rb] = b.split(' ');
    return ra === rb ? METHODS.indexOf(ma as never) - METHODS.indexOf(mb as never) : ra!.localeCompare(rb!);
  }));
}
