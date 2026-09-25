/**
 * Static guards for the stabilization security release (PR1):
 * - F13: every Driver read or write under app/ projects its columns (`select`), so the legacy
 *   PIN hash can never reach a response, a page prop or an audit row;
 * - F22: no code under apps/ points at the public OSRM demo server;
 * - the retired driver app leaves no caller behind and its smoke script is gone.
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
