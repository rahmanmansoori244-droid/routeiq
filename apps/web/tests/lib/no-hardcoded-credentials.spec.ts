/**
 * Review L9: no password (or PIN) may be hashed from a string literal in app code, lib or the
 * prisma scripts. The legacy seed that did (prisma/seed-nmwc.ts, `db:seed:nmwc`) is deleted; its
 * value is in git history and must be treated as compromised.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const WEB = path.resolve(__dirname, '../..');
const ROOT = path.resolve(WEB, '../..');

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === '.next' || name.startsWith('.')) continue;
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx|js|mjs|cjs)$/.test(name)) out.push(p);
  }
  return out;
}

// bcrypt.hash('...'), hashPassword("..."), hashPin(`...`): a literal as the first argument.
const LITERAL_HASH = /\b(?:bcrypt\.hash|bcrypt\.hashSync|hashPassword|hashPin)\(\s*['"`]/;

describe('no hard-coded credentials', () => {
  it('no hash call takes a string literal in app/, lib/ or prisma/', () => {
    const offenders: string[] = [];
    for (const dir of ['app', 'lib', 'prisma']) {
      for (const f of walk(path.join(WEB, dir))) {
        readFileSync(f, 'utf8')
          .split('\n')
          .forEach((line, i) => {
            if (LITERAL_HASH.test(line)) offenders.push(`${path.relative(WEB, f)}:${i + 1}`);
          });
      }
    }
    expect(offenders).toEqual([]);
  });

  it('the legacy seed with the published password is gone, with its scripts', () => {
    expect(existsSync(path.join(WEB, 'prisma/seed-nmwc.ts'))).toBe(false);
    const webPkg = JSON.parse(readFileSync(path.join(WEB, 'package.json'), 'utf8')) as { scripts: Record<string, string> };
    const rootPkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')) as { scripts: Record<string, string> };
    for (const scripts of [webPkg.scripts, rootPkg.scripts]) {
      expect(Object.keys(scripts)).not.toContain('db:seed:nmwc');
      expect(Object.values(scripts).join(' ')).not.toMatch(/seed-nmwc\.ts/);
    }
  });
});
