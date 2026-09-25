/**
 * Static guards for the stabilization security release (PR1):
 * - F13: every Driver read or write under app/ projects its columns (`select`), so the legacy
 *   PIN hash can never reach a response, a page prop or an audit row;
 * - F22: no code under apps/ points at the public OSRM demo server;
 * - the retired driver app leaves no caller behind and its smoke script is gone;
 * - client IPs (rate limits, audit rows) come only from lib/client-ip.ts, never from the
 *   client-controlled left end of X-Forwarded-For;
 * - docs and messages do not send admins to a password-reset path that does not exist.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const WEB = path.resolve(__dirname, '../..');
const APPS = path.resolve(WEB, '..');
const SKIP_DIRS = new Set(['node_modules', '.next', '.venv', '__pycache__', '.pytest_cache', '.turbo']);

function walk(dir: string, exts: RegExp, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) walk(p, exts, out);
    else if (exts.test(name)) out.push(p);
  }
  return out;
}

/** The text of the call's argument list starting at `open` (index of "("). */
function callArgs(src: string, open: number): string {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '(') depth++;
    else if (src[i] === ')') {
      depth--;
      if (depth === 0) return src.slice(open + 1, i);
    }
  }
  return src.slice(open + 1);
}

describe('Driver rows are always projected under app/ (review F13)', () => {
  it('every driver.find*/create/update/upsert call has a select', () => {
    const CALL = /\bdriver\.(findUnique|findUniqueOrThrow|findFirst|findFirstOrThrow|findMany|create|update|upsert)\(/g;
    const offenders: string[] = [];
    for (const f of walk(path.join(WEB, 'app'), /\.(ts|tsx)$/)) {
      const src = readFileSync(f, 'utf8');
      for (const m of src.matchAll(CALL)) {
        const args = callArgs(src, m.index! + m[0].length - 1);
        if (!/\bselect\s*:/.test(args)) {
          const line = src.slice(0, m.index).split('\n').length;
          offenders.push(`${path.relative(WEB, f)}:${line} driver.${m[1]}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe('no public OSRM demo server (review F22)', () => {
  it('no file under apps/ references it', () => {
    const host = ['router', 'project-osrm', 'org'].join('.'); // built here so this file does not match itself
    const offenders = walk(APPS, /\.(ts|tsx|js|mjs|cjs|py|json|toml|txt|md|yml|yaml)$|^Dockerfile$/)
      .filter((f) => readFileSync(f, 'utf8').includes(host))
      .map((f) => path.relative(APPS, f));
    expect(offenders).toEqual([]);
  });
});

describe('the legacy driver app is retired (owner decision)', () => {
  it('its smoke script is deleted', () => {
    expect(existsSync(path.join(WEB, 'prisma/smoke-driver-flow.ts'))).toBe(false);
  });

  it('no screen calls the driver app API, the PIN route or the live route any more', () => {
    const offenders: string[] = [];
    for (const f of walk(path.join(WEB, 'app'), /\.tsx$/)) {
      const src = readFileSync(f, 'utf8');
      if (/['"`]\/api\/driver\//.test(src) || /\/pin[`'"]/.test(src) || /\/live[`'"]/.test(src)) offenders.push(path.relative(WEB, f));
    }
    expect(offenders).toEqual([]);
  });

  it('every retired route answers through driverAppGone()', () => {
    const routes = [
      'app/api/driver/login/route.ts',
      'app/api/driver/manifest/route.ts',
      'app/api/driver/ping/route.ts',
      'app/api/driver/stop/route.ts',
      'app/api/driver/shift/end/route.ts',
      'app/api/drivers/[id]/pin/route.ts',
      'app/api/runs/[id]/live/route.ts',
    ];
    for (const r of routes) {
      const src = readFileSync(path.join(WEB, r), 'utf8');
      expect(src, r).toContain('return driverAppGone();');
      expect(src, r).not.toMatch(/prisma|tenantDb|withTenantApi|requireDriverShift/);
    }
  });
});

describe('client IP only through lib/client-ip.ts (spoofable X-Forwarded-For)', () => {
  it('no other file under app/, lib/ or middleware.ts reads a forwarding header itself', () => {
    const files = [
      ...walk(path.join(WEB, 'app'), /\.(ts|tsx)$/),
      ...walk(path.join(WEB, 'lib'), /\.(ts|tsx)$/),
      path.join(WEB, 'middleware.ts'),
    ];
    const offenders = files
      .map((f) => path.relative(WEB, f).split(path.sep).join('/'))
      .filter((rel) => rel !== 'lib/client-ip.ts')
      .filter((rel) => /x-forwarded-for|x-real-ip/i.test(readFileSync(path.join(WEB, rel), 'utf8')));
    expect(offenders).toEqual([]);
  });
});

describe('password reset without email points to the real admin reset', () => {
  it('no doc, env example or server message describes the old non-existent fallbacks', () => {
    const REPO = path.resolve(APPS, '..');
    const files = [
      ...walk(path.join(REPO, 'docs'), /\.md$/),
      path.join(REPO, '.env.example'),
      ...walk(path.join(WEB, 'app'), /\.(ts|tsx)$/),
      ...walk(path.join(WEB, 'lib'), /\.(ts|tsx)$/),
    ];
    // "Deactivate and invite again" fails (the email already exists: 409), and there was no
    // "temporary-password flow" for an existing user before POST /api/users/:id/reset-password.
    const STALE = /invite \/ temporary-password flow|invite and temporary-password flow|deactivates? the user and invites? them again/i;
    const offenders = files.filter((f) => STALE.test(readFileSync(f, 'utf8'))).map((f) => path.relative(REPO, f).split(path.sep).join('/'));
    expect(offenders).toEqual([]);
  });

  it('the Users screen offers "Reset password" through the admin reset route', () => {
    const src = readFileSync(path.join(WEB, 'app/t/[slug]/users/users-client.tsx'), 'utf8');
    expect(src).toContain('/reset-password`');
    expect(src).toContain('Reset password');
  });
});

describe('docs promise only what the code guarantees (third review of PR3)', () => {
  it('no doc or code comment repeats a promise the second round of fixes had to take back', () => {
    const REPO = path.resolve(APPS, '..');
    const files = [...walk(path.join(REPO, 'docs'), /\.md$/), ...walk(path.join(WEB, 'lib'), /\.ts$/)];
    const STALE: [RegExp, string][] = [
      // Admission: a company running a solve can be overtaken; a second start can get 503.
      [/gets the next free one/i, 'another company gets the next free slot'],
      [/its OPTIMIZE is never refused because others filled the queue/i, 'never refused'],
      [/waits only for solves queued before it/i, 'waits only for solves queued before it'],
      // Plan screen: after a network error the plan and the day may need Try again.
      [/the buttons work again at once/i, 'buttons work again at once'],
      // Drivers: RouteIQ no longer keeps a driver on two trips it moved onto each other's hours.
      [/two planned trips that you gave the same driver/i, 'driver kept on two trips you gave'],
      [/both keep this version's driver/i, "both keep this version's driver"],
      // Fourth review: only a driver chosen by hand stays on overlapping trips (the marker decides,
      // not whether the trips overlapped before), and the re-plan job orders its trips too.
      [/Only when you had already given one driver two planned trips/i, 'a clash kept because the trips overlapped before'],
      [/The one exception is in step 1/i, 'the step-1 exception of the third round'],
      // Fifth review: picking the selected driver again fires nothing (Keep marks it), and the
      // "Use instead" count is driver notes (parked hand-set drivers included), not trips.
      [/until you pick it again/i, '"pick it again" to mark a driver'],
      [/how many trips have another driver/i, '"Use instead" counts trips with another driver'],
      // Simplified driver rules (owner decision after the sixth review): nothing brings a dropped
      // hand-set driver back, filling an empty trip is no note, and the previous version is not
      // read as separate evidence.
      [/goes back on it when/i, 'a dropped hand-set driver coming back with its trip'],
      [/RouteIQ remembers your pick/i, '"RouteIQ remembers your pick"'],
      [/Driver added by this plan/i, 'a "Driver added" note (filling an empty trip is no note)'],
      [/\b(planReplanDrivers|assignReplanDrivers|ownDriverEvidence|parkedEvidence|readParkedDrivers|toParkedDrivers|pickLoadDriver)\b/, 'a removed driver helper'],
    ];
    const offenders = files.flatMap((f) => {
      const text = readFileSync(f, 'utf8');
      return STALE.filter(([re]) => re.test(text)).map(([, what]) => `${path.relative(REPO, f).split(path.sep).join('/')}: ${what}`);
    });
    expect(offenders).toEqual([]);
  });
});
