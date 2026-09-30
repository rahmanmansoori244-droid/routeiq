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
      // Review of the simplified rules: on a tie (the same move, or no evidence load) the trip the
      // optimizer lists first goes first, and "No driver" is marked, so a note does not come back.
      [/whatever order the optimizer lists/i, 'drivers independent of the optimizer\'s trip order'],
      [/whichever truck is listed first/i, 'the same drivers whichever truck is listed first'],
      [/"No driver" clears (both|the marker)/i, '"No driver" clears the marker'],
      // Second review of the simplified rules: "No driver" cannot end a note on a trip that has no
      // driver (nothing is sent, nothing is marked), and no dispatch screen shows a finished job's message.
      [/or \*\*No driver\*\*\); after that it is not listed again/i, '"No driver" ends a note on a trip without a driver'],
      [/\*\*Keep\*\*, or "No driver"(;| -) (it does not come back|and never again)/i, '"No driver" ends a note on a trip without a driver'],
      [/The re-plan's message and \*\*Use instead\*\* also say/i, 'a re-plan message with the note count (never shown)'],
      // PR8 review: the plan screen shows the timing warnings and the notes about outdated weights,
      // changed master data and drivers above the optimizer's warnings, so "Planned from" is not
      // always the first yellow line (plan-view.tsx, plan-detail.ts).
      [/first yellow line/i, '"Planned from" as the first yellow line'],
      [/the first plan warning/i, '"Planned from" as the first plan warning'],
      // PR8 rebase review: PR7's "What it gains" line is built from the P1/P2 minutes-earlier figure
      // (independent of the same-day start) AND the preference-cost difference (whose early part
      // counts from it), plan-options.ts compare(); the docs must not claim either alone.
      [/\*What it gains\* compares service starts between options, which the start does not change/i, '"What it gains" never depends on the same-day start'],
      [/\(and so its \*What it gains\* line\)/i, 'the whole "What it gains" line counts from the same-day start'],
      // PR8 rebase review: the owner approved PR8 when it was merged; the docs record it as decided.
      [/PR8, \*\*awaiting owner approval/i, 'PR8 awaiting owner approval (decisions table)'],
      [/\(PR8, awaiting approval\.\)/i, 'PR8 awaiting approval (open questions)'],
      [/A behaviour change the owner must approve/i, 'PR8 as a change the owner must still approve'],
      // Audit A2 review: a customer import cannot clear an unloading time (a blank cell keeps the
      // stored time; customer-import-service-time.spec.ts); only the Details dialog, box emptied, can.
      [/(clear|cleared|clearing|back (on|to) the default)[^.\n]*\bor (by )?an? (customer )?import\b/i, 'an import clearing an unloading time'],
      // A1 review: the upload caps bound one upload's work, not its time. The "about 2 s" came from
      // one file; files within every cap blocked the app for 6-33 s or crashed it, and a file just
      // under the caps still blocks it for 5-11 s (lib/csv.ts, SECURITY.md section 9).
      [/cannot freeze the app for long/i, 'uploads "cannot freeze the app for long"'],
      [/(blocks?|block) (every user|it|the app) for about 2 s/i, 'the largest upload blocks the app for about 2 s'],
      [/up to about 2 seconds for the largest file/i, 'the largest upload takes up to about 2 seconds'],
      [/about 2 s at worst|worst case measured about 2 s/i, 'an upload worst case of about 2 s'],
      [/fixed as far as a quick fix can/i, 'E2 "fixed as far as a quick fix can"'],
      [/bounded by the 10 MB file limit and the row cap only/i, 'old .xls and text formats bounded by the size and row caps only'],
    ];
    const offenders = files.flatMap((f) => {
      const text = readFileSync(f, 'utf8');
      return STALE.filter(([re]) => re.test(text)).map(([, what]) => `${path.relative(REPO, f).split(path.sep).join('/')}: ${what}`);
    });
    expect(offenders).toEqual([]);
  });

  it('after a pin correction, nothing says the map or the WhatsApp message moves to the new pin (second A2 review)', () => {
    // A plan keeps the pin each stop was planned with (getPlanDetail reads the stop snapshot): the
    // reload after a pin correction adds the orange note, the badge and the WhatsApp / driver sheet
    // "New pin - ask the dispatcher" line, but the stop's pin link, the route link and the map stay
    // the planned ones until the load is re-planned (a locked one unlocked first).
    const REPO = path.resolve(APPS, '..');
    const files = [...walk(path.join(REPO, 'docs'), /\.md$/), ...walk(path.join(WEB, 'lib'), /\.tsx?$/), ...walk(path.join(WEB, 'app/t/[slug]/dispatch'), /\.tsx?$/)];
    const STALE: [RegExp, string][] = [
      [/\b(map|WhatsApp (messages?|texts?))\b[^.\n]*\buses? the (new|corrected) pin\b/i, 'the map or WhatsApp message using the new pin'],
      [/\b(map|WhatsApp)\b[^.\n]*\buse the customer as it is now\b/i, 'the map or WhatsApp texts using the customer as it is now'],
      [/\bmap\b[^.\n]*\b(keep|kept) the customer as it was\b/i, 'a reload moving the map to the corrected customer'],
    ];
    const offenders = files.flatMap((f) => {
      const raw = readFileSync(f, 'utf8');
      // A code comment is read as one text: its "//" and " * " line breaks become spaces.
      const text = f.endsWith('.md') ? raw : raw.replace(/[ \t]*\r?\n[ \t]*(\/\/|\*(?!\/))?[ \t]*/g, ' ');
      return STALE.filter(([re]) => re.test(text)).map(([, what]) => `${path.relative(REPO, f).split(path.sep).join('/')}: ${what}`);
    });
    expect(offenders).toEqual([]);
  });
});

/**
 * How many tests pytest collects from one solver test file, read from its source: every `def
 * test_...` (top level or in a class), times the size of each `@pytest.mark.parametrize` above it
 * (a list literal or `range(n)`). Throws on a parametrize it cannot size, so the guard below fails
 * loudly instead of guessing.
 */
function pytestCount(src: string, file: string): number {
  const listSize = (arg: string): number => {
    const t = arg.trim();
    const r = /^range\((\d+)\)/.exec(t);
    if (r) return Number(r[1]);
    if (!t.startsWith('[')) throw new Error(`${file}: cannot size the parametrize values ${t}`);
    let depth = 0;
    let quote: string | null = null;
    let items = 0;
    let seen = false;
    for (let i = 0; i < t.length; i++) {
      const c = t[i];
      if (quote) {
        if (c === '\\') i++;
        else if (c === quote) quote = null;
        continue;
      }
      if (c === '"' || c === "'") {
        quote = c;
        seen = true;
      } else if (c === '[' || c === '(' || c === '{') {
        if (depth === 1) seen = true;
        depth++;
      } else if (c === ']' || c === ')' || c === '}') {
        depth--;
        if (depth === 0) return items + (seen ? 1 : 0);
      } else if (c === ',' && depth === 1) {
        items++;
        seen = false;
      } else if (!/\s/.test(c) && depth === 1) {
        seen = true;
      }
    }
    throw new Error(`${file}: unterminated parametrize values`);
  };
  let total = 0;
  let mult = 1;
  for (const line of src.split(/\r?\n/)) {
    const p = /^\s*@pytest\.mark\.parametrize\(\s*(["'])[^"']*\1\s*,\s*(.*)$/.exec(line);
    if (p) {
      mult *= listSize(p[2]);
      continue;
    }
    if (/^\s*@/.test(line)) continue;
    if (/^\s*(async\s+)?def\s+test_\w*\s*\(/.test(line)) {
      total += mult;
      mult = 1;
    } else if (/^\s*((async\s+)?def|class)\s/.test(line)) {
      mult = 1;
    }
  }
  return total;
}

describe('the handbook counts the solver tests pytest collects (PR8 review)', () => {
  it('the solver test table lists every test file with its number of tests', () => {
    const REPO = path.resolve(APPS, '..');
    const dir = path.join(APPS, 'solver', 'tests');
    const files = readdirSync(dir).filter((f) => /^test_\w+\.py$/.test(f)).sort();
    const actual = Object.fromEntries(files.map((f) => [f, pytestCount(readFileSync(path.join(dir, f), 'utf8'), f)]));
    const handbook = readFileSync(path.join(REPO, 'docs', 'PROJECT_HANDBOOK.md'), 'utf8');
    const table = handbook.slice(handbook.indexOf('**Solver tests**'), handbook.indexOf('**Benchmarks and scripts**'));
    const documented = Object.fromEntries([...table.matchAll(/^\| `(test_\w+\.py)` \| (\d+) \|/gm)].map((m) => [m[1], Number(m[2])]));
    expect(documented).toEqual(actual);
  });

  it('counts a parametrized test once per value, and a class method like a function', () => {
    const src = [
      '@pytest.mark.parametrize("a", [1, (2, 3), "x,y"])',
      'def test_one(a):',
      '    pass',
      '@pytest.mark.parametrize("f", [False, True])',
      '@pytest.mark.parametrize("seed", range(8))',
      'def test_two(seed, f):',
      '    def helper():',
      '        pass',
      'class TestThing:',
      '    def test_three(self):',
      '        pass',
      'def not_a_test():',
      '    pass',
    ].join('\n');
    expect(pytestCount(src, 'x.py')).toBe(3 + 16 + 1);
  });
});

describe('the dispatcher guide keeps each customer rule under its own bullet (review of audit PR 3)', () => {
  const REPO = path.resolve(APPS, '..');
  const guide = () => readFileSync(path.join(REPO, 'docs', 'DISPATCHER_GUIDE.md'), 'utf8').replace(/\r\n/g, '\n');
  const bullet = (text: string, head: string) => {
    const line = text.split('\n').find((l) => l.startsWith(`- **${head}:**`));
    if (!line) throw new Error(`no "${head}" bullet in DISPATCHER_GUIDE.md`);
    return line;
  };

  it("the import's service-time and Validate only rules are under Customer import, not under the Customers page toggles", () => {
    const text = guide();
    const importRules = /A service time in the file \(at most 480 min\) counts as confirmed|\*\*Validate only\*\*/g;
    expect(bullet(text, 'Customer import').match(importRules)).toHaveLength(2);
    expect(bullet(text, 'Customers page').match(importRules)).toBeNull();
  });

  it('the Customers page bullet says a server error is not a refusal (F24)', () => {
    const page = bullet(guide(), 'Customers page');
    expect(page).toMatch(/server answers with an error/);
    expect(page).toMatch(/may or may not have been saved/);
    expect(page).toMatch(/\*\*not confirmed\*\*/);
  });

  it('the re-check of files merged the old way names the files it refuses (not every file checked before the update)', () => {
    const text = guide();
    expect(text).not.toMatch(/A file checked before the update that keeps every priority and note of repeated rows asks to be checked again/);
    expect(text).toMatch(/A file checked before this update that has the same sales order and product on two rows is refused at \*\*Add\*\*: check it again\./);
  });
});

describe('the handbook names every audit PR that is in it at the top (A1 v4 review)', () => {
  it('the audit status line near the top names each audit PR that has a 7.4 block', () => {
    const REPO = path.resolve(APPS, '..');
    const handbook = readFileSync(path.join(REPO, 'docs', 'PROJECT_HANDBOOK.md'), 'utf8').replace(/\r\n/g, '\n');
    const status = handbook.split('\n').find((l) => l.startsWith('- **Audit of 27 Sep 2026.**')) ?? '';
    const review = handbook.slice(handbook.indexOf('### 7.4 '), handbook.indexOf('### 7.5 '));
    // "**Audit of 27 Sep 2026, PR A2 ...", "**Audit of 27 Sep 2026, PR 3 ..." (A3), "**Audit A1 ...",
    // "**Audit P5 ..." (assessment PR 5; "A5" was already the owner-rules PR).
    const prs = new Set([...review.matchAll(/^\*\*Audit (?:of 27 Sep 2026, PR A?(\d+)|A(\d+)|(P\d+)) /gm)].map((m) => m[3] ?? `A${m[1] ?? m[2]}`));
    expect(prs.size).toBeGreaterThanOrEqual(4);
    expect(prs.has('P5')).toBe(true);
    for (const pr of prs) expect([pr, status.includes(`**${pr} `)]).toEqual([pr, true]);
  });
});

describe('the handbook describes the web tests and the health gate as they are (third review of audit PR4)', () => {
  const REPO = path.resolve(APPS, '..');
  const handbook = () => readFileSync(path.join(REPO, 'docs', 'PROJECT_HANDBOOK.md'), 'utf8').replace(/\r\n/g, '\n');
  const specs = (dir: string) => readdirSync(path.join(WEB, 'tests', dir)).filter((f) => f.endsWith('.spec.ts')).sort();
  const bullet = (text: string, start: string) => {
    const line = text.split('\n').find((l) => l.startsWith(start));
    if (!line) throw new Error(`no line starting with ${start} in PROJECT_HANDBOOK.md`);
    return line;
  };

  it('section 2.2 counts the unit and integration spec files on disk (merging main left 63 and 25)', () => {
    const text = handbook();
    const count = (line: string) => Number(/\((\d+) files\b/.exec(line)?.[1]);
    expect(count(bullet(text, '- `tests/lib/*.spec.ts` ('))).toBe(specs('lib').length);
    expect(count(bullet(text, '- `tests/integration/*.spec.ts` ('))).toBe(specs('integration').length);
  });

  it('section 2.2 names every integration spec that runs on the real database without the web server', () => {
    const line = bullet(handbook(), '- `tests/integration/*.spec.ts` (');
    const noServer = specs('integration').filter((f) => {
      // The header comment as one text: its " * " line starts become spaces.
      const header = readFileSync(path.join(WEB, 'tests', 'integration', f), 'utf8')
        .split('*/')[0]
        .replace(/\r?\n[ \t]*\*?[ \t]*/g, ' ')
        .replace(/\s+/g, ' ');
      return /the web server and (the )?solver are not used/i.test(header);
    });
    expect(noServer.length).toBeGreaterThanOrEqual(8);
    expect(noServer.filter((f) => !line.includes(`\`${f.replace(/\.spec\.ts$/, '')}\``))).toEqual([]);
  });

  it('no gotcha says /api/health answers 503 when the solver is down (since audit PR4 that is 200 degraded)', () => {
    const text = handbook();
    // Only the matching words are printed on a failure, not the whole handbook.
    expect(/`\/api\/health` returns 503 when the solver is down/i.exec(text)?.[0] ?? null).toBeNull();
    const gotchas = text.slice(text.indexOf('### 5.11 Known operational gotchas'), text.indexOf('### 5.12'));
    const row4 = bullet(gotchas, '| 4 |');
    expect(row4).toMatch(/200/);
    expect(row4).toMatch(/degraded/);
    expect(row4).toMatch(/`ok: false`/);
  });
});

describe('the handbook counts what is on disk and lists every spec in 5.3 (fourth review of audit PR4)', () => {
  const REPO = path.resolve(APPS, '..');
  const handbook = () => readFileSync(path.join(REPO, 'docs', 'PROJECT_HANDBOOK.md'), 'utf8').replace(/\r\n/g, '\n');
  const specs = (dir: string) => readdirSync(path.join(WEB, 'tests', dir)).filter((f) => f.endsWith('.spec.ts')).sort();
  const between = (text: string, from: string, to: string) => {
    const a = text.indexOf(from);
    const b = text.indexOf(to, a + 1);
    if (a < 0 || b < 0) throw new Error(`no text from "${from}" to "${to}" in PROJECT_HANDBOOK.md`);
    return text.slice(a, b);
  };
  /** Every count the pattern finds (its group 1), with the words it was found in, so a failure names the stale phrase. */
  const counts = (text: string, re: RegExp) => [...text.matchAll(re)].map((m) => ({ said: m[0], n: Number(m[1]) }));
  const allAre = (found: { said: string; n: number }[], n: number) => {
    expect(found.length).toBeGreaterThan(0);
    expect(found).toEqual(found.map((f) => ({ ...f, n })));
  };

  it('sections 1 and 2 count the route files, the migrations, the models and the enums on disk (they said 60, 10 and 9, 26)', () => {
    const text = handbook();
    const top = text.slice(0, text.indexOf('## 3. Daily dispatch process flow'));
    const routes = walk(path.join(WEB, 'app', 'api'), /^route\.ts$/);
    const migrationsDir = path.join(WEB, 'prisma', 'migrations');
    const migrations = readdirSync(migrationsDir).filter((n) => statSync(path.join(migrationsDir, n)).isDirectory());
    const schema = readFileSync(path.join(WEB, 'prisma', 'schema.prisma'), 'utf8');
    allAre(counts(top, /(\d+) route (?:handlers|files)\b/g), routes.length);
    allAre(counts(top, /(\d+) of the \d+ route files use `withTenantApi\(\)`/g), routes.filter((f) => readFileSync(f, 'utf8').includes('withTenantApi(')).length);
    allAre(counts(top, /(\d+) migrations\b/g), migrations.length);
    allAre(counts(top, /(\d+) models\b/g), (schema.match(/^model \w+/gm) ?? []).length);
    allAre(counts(top, /(\d+) enums\b/g), (schema.match(/^enum \w+/gm) ?? []).length);
  });

  it('5.3 names every spec file in its own part, unit or integration, and counts the unit specs (it said 32 of 74, and 17 specs were missing)', () => {
    const s53 = between(handbook(), '### 5.3 Test suites', '### 5.4');
    const unit = between(s53, '**Web unit specs**', '**Web integration specs**');
    const integration = between(s53, '**Web integration specs**', '**Solver tests**');
    const named = (part: string, f: string) => part.includes(`\`${f}\``) || part.includes(`\`${f.replace(/\.spec\.ts$/, '')}\``);
    expect(specs('lib').filter((f) => !named(unit, f))).toEqual([]);
    expect(specs('integration').filter((f) => !named(integration, f))).toEqual([]);
    allAre(counts(unit, /^\*\*Web unit specs\*\* \(`apps\/web\/tests\/lib\/`, (\d+) files/gm), specs('lib').length);
  });
});

describe('the web process never reads an upload itself (audit P5)', () => {
  const rel = (f: string) => path.relative(WEB, f).split(path.sep).join('/');
  const code = () => [
    ...walk(path.join(WEB, 'app'), /\.(ts|tsx)$/),
    ...walk(path.join(WEB, 'lib'), /\.(ts|tsx)$/),
    ...walk(path.join(WEB, 'components'), /\.(ts|tsx)$/),
    path.join(WEB, 'middleware.ts'),
    path.join(WEB, 'instrumentation.ts'),
  ];
  /** The modules a file imports as values (an `import type` brings no code in). */
  const valueImports = (src: string) =>
    [...src.matchAll(/^\s*(?:import|export)\s+(?!type\s)(?:[^'";]*?\sfrom\s+)?['"]([^'"]+)['"]/gm), ...src.matchAll(/\bimport\(\s*['"]([^'"]+)['"]\s*\)/g)].map((m) => m[1]!);

  it('only lib/csv.ts and lib/workbook-guard.ts load SheetJS or Papa Parse', () => {
    const offenders = code().filter((f) => valueImports(readFileSync(f, 'utf8')).some((m) => m === 'xlsx' || m === 'papaparse')).map(rel);
    expect(offenders.sort()).toEqual(['lib/csv.ts', 'lib/workbook-guard.ts']);
  });

  it('only the parser process (lib/upload-parse/handler.ts) loads lib/csv, where parseUpload is', () => {
    const csv = /^(@\/lib\/csv|(\.\.?\/)+csv)$/;
    const offenders = code().filter((f) => valueImports(readFileSync(f, 'utf8')).some((m) => csv.test(m))).map(rel);
    expect(offenders).toEqual(['lib/upload-parse/handler.ts']);
  });

  it('what the web process loads of lib/upload-parse brings in no parser code', () => {
    for (const f of ['lib/upload-parse/index.ts', 'lib/upload-parse/config.ts', 'lib/upload-parse/protocol.ts', 'lib/upload-errors.ts', 'lib/upload-limits.ts']) {
      const imports = valueImports(readFileSync(path.join(WEB, f), 'utf8'));
      expect([f, imports.filter((m) => /(^|\/)(csv|workbook-guard|handler|child|order-intake)$|^(xlsx|papaparse)$/.test(m))]).toEqual([f, []]);
    }
  });

  it('the handbook describes tests/setup.ts as it is: uploads read in the test process unless a spec starts the parser (P5 second review: "an empty placeholder")', () => {
    const REPO = path.resolve(APPS, '..');
    const handbook = readFileSync(path.join(REPO, 'docs', 'PROJECT_HANDBOOK.md'), 'utf8').replace(/\r\n/g, '\n');
    expect(readFileSync(path.join(WEB, 'tests', 'setup.ts'), 'utf8')).toMatch(/__routeiqUploadParseInProcess\s*=/);
    const vitest = handbook.split('\n').find((l) => l.startsWith('**Vitest configuration**')) ?? '';
    // Only the matching words are printed on a failure, not the whole paragraph.
    expect(/placeholder/i.exec(vitest)?.[0] ?? null).toBeNull();
    expect(vitest.includes('`__routeiqUploadParseInProcess`') && vitest.includes('`useRealUploadParser()`')).toBe(true);
  });

  it('the three upload routes read the file through parseUploadIsolated and answer its refusals', () => {
    for (const r of ['app/api/orders/upload/route.ts', 'app/api/customers/import/route.ts', 'app/api/runs/[id]/baseline/route.ts']) {
      const src = readFileSync(path.join(WEB, r), 'utf8');
      expect([r, /await parseUploadIsolated\(file\b/.test(src), /if \(err instanceof UploadParseRefused\) return uploadRefusedResponse\(err\);/.test(src)]).toEqual([r, true, true]);
    }
  });
});
