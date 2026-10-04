/**
 * Long searches (owner request 29 Sep 2026: "make sure the solver is giving an optimal solution even
 * if it runs for 20 mins"; decision "night plans long, day re-plans quick"):
 * - the mode by day (company timezone, the plan-from.ts rule) and the dispatcher's choice;
 * - the confirmation, progress and result texts: honest, never "optimal";
 * - the solver call's wait per mode, its keepalive and the plain words for a lost connection;
 * - solve admission per mode: a THOROUGH night solve never holds up a same-day QUICK re-plan.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  defaultModeForDay,
  defaultSearchMode,
  fmtSearchTime,
  jobMaxMinutes,
  keepDeliveries,
  planSearching,
  queuedMessage,
  readResultsNow,
  quickExpectedSec,
  searchAssumptions,
  searchChoices,
  searchLeadMin,
  searchModeNow,
  searchOptionOf,
  searchPollMs,
  searchProgressText,
  searchResultText,
  solverWaitMs,
  thoroughMaxSec,
  type SearchReport,
} from '@/lib/dispatch/search-mode';
import { defaultAdmissionLimits, SolveAdmission, type AdmissionLimits, type SolveTicket } from '@/lib/dispatch/solve-admission';
import { callDispatchSolver, postJsonLong, SolverError, solverCallFailure, SOLVER_KEEPALIVE_MS } from '@/lib/solver-client';
import { autoTimeLimitSec } from '@/lib/planner-bounds';
import { requestedSearchMode } from '@/lib/dispatch/start-optimize';

const OPTIMAL = /\boptimal\b|\boptimum\b|best possible/i;

describe('the mode by day (company timezone)', () => {
  const MUSCAT = 'Asia/Muscat'; // UTC+4
  it('a plan made before its delivery day is THOROUGH; on the day (or after) QUICK', () => {
    const evening = new Date('2026-09-29T15:00:00Z'); // 19:00 in Muscat on the 29th
    expect(defaultSearchMode('2026-09-30', MUSCAT, evening)).toBe('THOROUGH');
    expect(defaultSearchMode('2026-10-02', MUSCAT, evening)).toBe('THOROUGH');
    expect(defaultSearchMode('2026-09-29', MUSCAT, evening)).toBe('QUICK');
    expect(defaultSearchMode('2026-09-20', MUSCAT, evening)).toBe('QUICK');
  });

  it('uses the company day, not the server (UTC) day', () => {
    // 20:30 UTC on the 29th is already 00:30 on the 30th in Muscat: the plan for the 30th is today's.
    const lateUtc = new Date('2026-09-29T20:30:00Z');
    expect(defaultSearchMode('2026-09-30', MUSCAT, lateUtc)).toBe('QUICK');
    expect(defaultSearchMode('2026-10-01', MUSCAT, lateUtc)).toBe('THOROUGH');
    // 23:59 in Muscat on the 29th: still the evening before.
    expect(defaultSearchMode('2026-09-30', MUSCAT, new Date('2026-09-29T19:59:00Z'))).toBe('THOROUGH');
    // Unknown or empty timezone: Asia/Muscat, as same-day planning uses.
    expect(defaultSearchMode('2026-09-30', 'Not/AZone', lateUtc)).toBe('QUICK');
    expect(defaultSearchMode('2026-09-30', null, lateUtc)).toBe('QUICK');
    expect(defaultSearchMode('2026-09-30', 'UTC', lateUtc)).toBe('THOROUGH');
  });

  it('the screens apply the same rule from the company today they show', () => {
    expect(defaultModeForDay('2026-09-30', '2026-09-29')).toBe('THOROUGH');
    expect(defaultModeForDay('2026-09-29', '2026-09-29')).toBe('QUICK');
  });

  it('the confirmation reads the clock when the button is pressed, not when the screen loaded (skeptic review: a screen left open across midnight)', () => {
    // Loaded at 23:50 in Muscat on the 29th for the 30th; pressed at 07:30 on the 30th without a reload.
    const loaded = { timezone: MUSCAT, today: '2026-09-29' };
    const evening = new Date('2026-09-29T19:50:00Z');
    const morning = new Date('2026-09-30T03:30:00Z');
    expect(searchModeNow('2026-09-30', loaded, evening)).toEqual({ defaultMode: 'THOROUGH', deliveryDay: false });
    expect(searchModeNow('2026-09-30', loaded, morning)).toEqual({ defaultMode: 'QUICK', deliveryDay: true });
    expect(searchModeNow('2026-09-30', loaded, morning).defaultMode).toBe(defaultSearchMode('2026-09-30', MUSCAT, morning));
    // The company's timezone, not the browser's: 20:30 UTC on the 29th is the 30th in Muscat.
    expect(searchModeNow('2026-09-30', { timezone: MUSCAT }, new Date('2026-09-29T20:30:00Z'))).toEqual({ defaultMode: 'QUICK', deliveryDay: true });
    expect(searchModeNow('2026-09-30', { timezone: 'UTC' }, new Date('2026-09-29T20:30:00Z'))).toEqual({ defaultMode: 'THOROUGH', deliveryDay: false });
    // Data without a timezone (an older payload): the loaded today, as before.
    expect(searchModeNow('2026-09-30', { today: '2026-09-29' }, morning)).toEqual({ defaultMode: 'THOROUGH', deliveryDay: false });
    expect(searchModeNow('2026-09-30', {}, morning)).toEqual({ defaultMode: 'QUICK', deliveryDay: true });
  });

  it("the dispatcher's choice wins on any day; a start that names none searches QUICK, as before", () => {
    expect(requestedSearchMode('THOROUGH')).toBe('THOROUGH');
    expect(requestedSearchMode('QUICK')).toBe('QUICK');
    expect(requestedSearchMode(undefined)).toBe('QUICK');
    expect(requestedSearchMode('FOREVER' as never)).toBe('QUICK');
  });
});

describe('THOROUGH cap and the waits that depend on it', () => {
  it('THOROUGH_MAX_SEC: 20 min by default, 10 s to 60 min', () => {
    expect(thoroughMaxSec({})).toBe(1200);
    expect(thoroughMaxSec({ THOROUGH_MAX_SEC: '60' })).toBe(60);
    for (const bad of ['', '5', '99999', 'twenty']) expect(thoroughMaxSec({ THOROUGH_MAX_SEC: bad })).toBe(1200);
  });

  it('the web waits 600 s for QUICK (as before) and the cap + 2 minutes for THOROUGH', () => {
    expect(solverWaitMs('QUICK', null)).toBe(600_000);
    expect(solverWaitMs(undefined, 1200)).toBe(600_000);
    expect(solverWaitMs('THOROUGH', 1200)).toBe(1_320_000);
    expect(solverWaitMs('THOROUGH', 60)).toBe(180_000);
    expect(solverWaitMs('THOROUGH', null)).toBe(1_320_000);
    // Above Node fetch's 300 s header limit in both modes: postJsonLong (node:http) is required.
    expect(solverWaitMs('QUICK', null)).toBeGreaterThan(300_000);
    expect(jobMaxMinutes('QUICK')).toBe(10);
    expect(jobMaxMinutes('THOROUGH', 1200)).toBe(22);
  });

  it('a long THOROUGH search is reloaded every 10 s after its first minute; everything else as before', () => {
    const now = new Date('2026-09-29T20:00:00Z');
    const started = (s: number) => new Date(now.getTime() - s * 1000).toISOString();
    expect(searchPollMs({ status: 'RUNNING', searchMode: 'THOROUGH', startedAt: started(30) }, 2500, now)).toBe(2500);
    expect(searchPollMs({ status: 'RUNNING', searchMode: 'THOROUGH', startedAt: started(90) }, 2500, now)).toBe(10_000);
    expect(searchPollMs({ status: 'RUNNING', searchMode: 'QUICK', startedAt: started(300) }, 3000, now)).toBe(3000);
    expect(searchPollMs({ status: 'QUEUED', searchMode: 'THOROUGH', startedAt: null }, 3000, now)).toBe(3000);
    expect(searchPollMs(null, 3000, now)).toBe(3000);
  });
});

describe('texts: expected time, progress, result - honest, never "optimal"', () => {
  it('the confirmation gives both choices with the expected time, the default marked', () => {
    const night = searchChoices('THOROUGH', 83, 1200);
    expect(night.map((c) => [c.mode, c.recommended])).toEqual([
      ['THOROUGH', true],
      ['QUICK', false],
    ]);
    expect(night[0].label).toBe('Thorough - up to 20 min');
    expect(night[0].detail).toMatch(/stops early once the plan stops improving/);
    expect(night[1].label).toBe(`Quick - usually about ${fmtSearchTime(quickExpectedSec(83))}`);
    expect(searchChoices('QUICK', null, 1200).find((c) => c.mode === 'QUICK')).toMatchObject({ recommended: true, label: 'Quick - usually a minute or two' });
    for (const c of [...night, ...searchChoices('QUICK', 400, 600)]) {
      expect(c.label + c.detail).not.toMatch(OPTIMAL);
    }
  });

  it('on the delivery day the Thorough choice says the plan cannot be used before its search ends (review of the long-search PR)', () => {
    const today = searchChoices('QUICK', 83, 1200, true).find((c) => c.mode === 'THOROUGH')!;
    expect(today.detail).toMatch(
      /This plan is for today: it cannot be used before the search ends, so its new loads leave no earlier than now \+ up to 20 min of search \+ the turnaround, and the plan's loads cannot be locked or dispatched until then\.$/,
    );
    expect(today.detail).not.toMatch(OPTIMAL);
    expect(searchChoices('THOROUGH', 83, 1200).find((c) => c.mode === 'THOROUGH')!.detail).not.toMatch(/for today/);
    expect(searchChoices('QUICK', 83, 1200, true).find((c) => c.mode === 'QUICK')!.detail).toBe(searchChoices('QUICK', 83, 1200).find((c) => c.mode === 'QUICK')!.detail);
    expect(searchLeadMin(1200)).toBe(20);
    expect(searchLeadMin(60)).toBe(1);
    expect(searchLeadMin(90)).toBe(2);
    expect(searchLeadMin(null)).toBe(20);
  });

  it("QUICK's estimate follows the automatic search time", () => {
    expect(quickExpectedSec(80)).toBe(Math.round(autoTimeLimitSec(80) * 1.5 + 30));
    expect(fmtSearchTime(quickExpectedSec(80))).toBe('1 min');
    expect(fmtSearchTime(quickExpectedSec(300))).toBe('4 min');
    expect(fmtSearchTime(45)).toBe('45 s');
    expect(fmtSearchTime(1200)).toBe('20 min');
  });

  it('the progress line while a search runs', () => {
    const now = new Date('2026-09-29T20:10:00Z');
    const started = new Date('2026-09-29T20:04:00Z').toISOString();
    expect(searchProgressText({ status: 'RUNNING', searchMode: 'THOROUGH', startedAt: started }, now, 1200)).toBe(
      'Searching for the best plan - up to 20 min, stops early when it stops improving - 6 min so far',
    );
    expect(searchProgressText({ status: 'RUNNING', searchMode: 'QUICK', startedAt: started }, now)).toBe('Searching for the best plan (Quick) - 6 min so far');
    expect(searchProgressText({ status: 'RUNNING', searchMode: null, startedAt: new Date('2026-09-29T20:09:20Z') }, now)).toBe(
      'Searching for the best plan (Quick) - 40 s so far',
    );
    expect(searchProgressText({ status: 'QUEUED', searchMode: 'THOROUGH', startedAt: null }, now)).toBeNull();
  });

  const report = (over: Partial<SearchReport>): SearchReport => ({
    mode: 'THOROUGH',
    cap_sec: 1200,
    limit_sec: 985,
    search_sec: 842,
    used_sec: 901,
    stop_reason: 'CONVERGED',
    last_improvement_sec: 421,
    stall_sec: 421,
    best_over_time: [
      [0.4, 612.4],
      [120, 540.2],
      [421, 525.3],
    ],
    solutions: 13000,
    ...over,
  });

  it('the result line says how long it searched and why it stopped', () => {
    expect(searchResultText(report({}))).toBe(
      'Thorough search: searched 14 min (up to 20 min allowed); stopped when it stopped improving (no better plan for 7 min). The best plan was last improved after 7 min.',
    );
    expect(searchResultText(report({ stop_reason: 'CAP', search_sec: 1110, last_improvement_sec: 1094 }))).toBe(
      'Thorough search: searched 19 min, all the time allowed (20 min in all); it was still finding small improvements near the end. The best plan was last improved after 18 min.',
    );
    // At the cap without a recent improvement: no claim that it was still improving.
    expect(searchResultText(report({ stop_reason: 'CAP', search_sec: 21, last_improvement_sec: 0, cap_sec: 60 }))).toBe(
      'Thorough search: searched 21 s, all the time allowed (1 min in all). The best plan was last improved after 0 s.',
    );
    expect(searchResultText(report({ stop_reason: 'STOPPED', search_sec: 360 }))).toMatch(/^Thorough search stopped early after 6 min by a dispatcher: the best plan found so far is used\./);
    expect(searchResultText(report({ mode: 'QUICK', stop_reason: 'TIME_LIMIT', search_sec: 20.4, last_improvement_sec: null, stall_sec: null, best_over_time: [] }))).toBe(
      'Quick search: 20 s, the automatic time for a day of this size.',
    );
    expect(searchResultText(null)).toBeNull();
  });

  it('nothing searched, or no plan found: never "stopped when it stopped improving" nor "the automatic time" (skeptic review)', () => {
    // Every order was left out before the search (no truck can carry it, its hours cannot be reached).
    const none = { search_sec: 0, last_improvement_sec: null, stall_sec: null, best_over_time: [], solutions: null };
    expect(searchResultText(report({ ...none, stop_reason: 'NOT_SEARCHED' }))).toBe(
      'Thorough search not run: no order could be planned with these trucks and hours, so there was nothing to search (see the unserved orders for why).',
    );
    expect(searchResultText(report({ ...none, mode: 'QUICK', stop_reason: 'NOT_SEARCHED' }))).toBe(
      'Quick search not run: no order could be planned with these trucks and hours, so there was nothing to search (see the unserved orders for why).',
    );
    // The search ran and ended without any plan.
    expect(searchResultText(report({ ...none, search_sec: 1.1, stop_reason: 'NO_PLAN' }))).toBe(
      'Thorough search: searched 1 s (up to 20 min allowed) and found no plan with these trucks and limits.',
    );
    expect(searchResultText(report({ ...none, mode: 'QUICK', search_sec: 2, stop_reason: 'NO_PLAN' }))).toBe(
      'Quick search: searched 2 s and found no plan with these trucks and limits.',
    );
    // The ASSUMPTIONS sheet: the line only - "the best one the search found" would be untrue.
    for (const stop_reason of ['NOT_SEARCHED', 'NO_PLAN'] as const) {
      const rows = searchAssumptions(report({ ...none, stop_reason }));
      expect(Object.keys(rows)).toEqual(['Route search']);
      expect(rows['Route search']).toBe(searchResultText(report({ ...none, stop_reason })));
    }
  });

  it('the ASSUMPTIONS rows: the result, what it means (no gap is known) and the progress', () => {
    const rows = searchAssumptions(report({}));
    expect(Object.keys(rows)).toEqual(['Route search', 'Route search - what it means', 'Route search - progress']);
    expect(rows['Route search - what it means']).toMatch(/not a proven best: no lower bound is computed/);
    expect(rows['Route search - progress']).toMatch(/^0 s: 612; 2 min: 540; 7 min: 525 - the search's own score/);
    expect(searchAssumptions(null)).toEqual({});
    expect(Object.keys(searchAssumptions(report({ mode: 'QUICK', stop_reason: 'TIME_LIMIT', best_over_time: [] })))).toEqual(['Route search', 'Route search - what it means']);
    for (const r of ['CONVERGED', 'CAP', 'STOPPED', 'TIME_LIMIT', 'NOT_SEARCHED', 'NO_PLAN'] as const) {
      for (const text of [searchResultText(report({ stop_reason: r })), ...Object.values(searchAssumptions(report({ stop_reason: r })))]) {
        // "best possible plan" appears only to say it is NOT claimed ("how far it could still be from ...").
        expect(text).not.toMatch(/\boptimal\b|\boptimum\b|is the best possible/i);
      }
    }
  });

  it('the progress row is a score, not money: each point says how many stops were not planned yet (skeptic review)', () => {
    // A short fleet: the first plans leave stops out, each costing the score a large penalty.
    const pts: [number, number, number][] = [
      [0, 28069.57, 10],
      [0.4, 25064.26, 7],
      [2.2, 23111.35, 1],
      [65, 193.14, 0],
    ];
    const row = searchAssumptions(report({ best_over_time: pts }))['Route search - progress'];
    expect(row).toBe(
      "0 s: 28070 (10 stops not planned yet); 0 s: 25064 (7 stops not planned yet); 2 s: 23111 (1 stop not planned yet); 1 min: 193 - the search's own score of the best plan so far, not money: the plan's cost and preferences plus a large penalty for every stop not planned yet, before the final load re-check.",
    );
    expect(row).not.toMatch(/in the currency|OMR/);
    // A report stored before the count existed: the points alone, with the same explanation.
    expect(searchAssumptions(report({ best_over_time: [[0, 612.4], [120, 540.2]] }))['Route search - progress']).toMatch(
      /^0 s: 612; 2 min: 540 - the search's own score of the best plan so far, not money: .* a large penalty for every stop not planned yet/,
    );
  });

  it('an alternative in use: its own search after the recommended one, never the recommended search as its own (skeptic review)', () => {
    // RECOMMENDED converged after 12 min; MIN_TRUCKS then searched its own 60 s limit, with no early stop.
    const rec = report({ search_sec: 720, last_improvement_sec: 360, stall_sec: 360 });
    const minTrucks = searchOptionOf('MIN_TRUCKS', 60)!;
    expect(minTrucks).toEqual({ name: 'MIN_TRUCKS', limitSec: 60 });
    expect(searchOptionOf('RECOMMENDED', 985)).toBeNull();
    expect(searchOptionOf(null, 60)).toBeNull();
    const line = searchResultText(rec, minTrucks)!;
    expect(line).toBe(
      "The MIN TRUCKS option is in use. It searched for up to 1 min for its own goal (the fewest trucks), after the recommended plan's search (Thorough: 12 min of up to 20 min; stopped when it stopped improving).",
    );
    // The recommended plan's stop and last improvement are never stated as this option's.
    expect(line).not.toMatch(/^Thorough search|best plan was last improved|no better plan for/);
    expect(searchResultText(report({ mode: 'QUICK', stop_reason: 'TIME_LIMIT', search_sec: 20.4, best_over_time: [] }), { name: 'MIN_DISTANCE', limitSec: 10 })).toBe(
      "The MIN DISTANCE option is in use. It searched for up to 10 s for its own goal (the fewest km), after the recommended plan's search (Quick: 20 s, the automatic time for a day of this size).",
    );
    expect(searchResultText(report({ stop_reason: 'CAP', search_sec: 1110 }), { name: 'MIN_TRUCKS', limitSec: null })).toBe(
      "The MIN TRUCKS option is in use. It searched for its own goal (the fewest trucks), after the recommended plan's search (Thorough: 19 min, all the time allowed).",
    );
    // The recommended search found no plan: the option searched after it all the same.
    expect(searchResultText(report({ search_sec: 1.1, stop_reason: 'NO_PLAN', best_over_time: [] }), minTrucks)).toBe(
      "The MIN TRUCKS option is in use. It searched for up to 1 min for its own goal (the fewest trucks), after the recommended plan's search (Thorough: 1 s, no plan found).",
    );
    // Nothing searched at all: the same for every option.
    expect(searchResultText(report({ search_sec: 0, stop_reason: 'NOT_SEARCHED' }), minTrucks)).toBe(searchResultText(report({ search_sec: 0, stop_reason: 'NOT_SEARCHED' })));
    // The ASSUMPTIONS rows: the option's line and what it means; the recommended plan's progress is left out.
    const rows = searchAssumptions(rec, minTrucks);
    expect(Object.keys(rows)).toEqual(['Route search', 'Route search - what it means']);
    expect(rows['Route search']).toBe(line);
    expect(Object.keys(searchAssumptions(report({ search_sec: 1.1, stop_reason: 'NO_PLAN' }), minTrucks))).toEqual(['Route search', 'Route search - what it means']);
    for (const text of [line, ...Object.values(rows)]) expect(text).not.toMatch(/\boptimal\b|\boptimum\b|is the best possible/i);
  });

  it('a plan from the second route search has one note, the plan\'s own warning: the search line adds none (decision D4)', () => {
    const chosen = report({ mode: 'QUICK', stop_reason: 'TIME_LIMIT', search_sec: 20.4, best_over_time: [], pyvrp: { status: 'CHOSEN', chosen_for: ['RECOMMENDED'] } });
    expect(searchResultText(chosen)).toBe('Quick search: 20 s, the automatic time for a day of this size.');
    for (const text of Object.values(searchAssumptions(chosen))) expect(text).not.toContain('second route search');
  });

  it('the job message of a queued start', () => {
    expect(queuedMessage('THOROUGH', 1200, null)).toBe('Queued. Thorough search: up to 20 min, stops early when it stops improving.');
    expect(queuedMessage('QUICK', 1200, 2)).toBe('Waiting: 2 optimization(s) ahead. Quick search.');
  });
});

describe('the solver call', () => {
  it('a lost connection, a refused one and our own wait running out are plain, retryable messages', () => {
    const reset = solverCallFailure(Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }), 1_320_000);
    expect(reset).toBeInstanceOf(SolverError);
    expect(reset.message).toBe('The route optimizer stopped during the search (it was restarted or updated). Nothing was saved - optimize again.');
    expect(solverCallFailure(new Error('socket hang up'), 600_000).message).toMatch(/^The route optimizer stopped during the search/);
    expect(solverCallFailure(new Error('no answer after 1320 s'), 1_320_000).message).toBe(
      'The route optimizer did not answer within 22 minutes. Nothing was saved - optimize again (Quick takes less time).',
    );
    expect(solverCallFailure(Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }), 600_000).message).toMatch(/cannot be reached right now/);
    expect(solverCallFailure(new Error('something else'), 600_000).message).toBe('Solver call failed: something else');
    const own = new SolverError('busy', 503, null);
    expect(solverCallFailure(own, 600_000)).toBe(own);
  });

  describe('postJsonLong on its own connection', () => {
    let server: http.Server;
    let base = '';
    const seen: { keepAlive?: boolean } = {};
    beforeAll(async () => {
      server = http.createServer((req, res) => {
        // A silent 6 s answer: longer than the Node 20+ default agent's 5 s idle timeout.
        setTimeout(() => {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ ok: true, connection: req.headers.connection ?? null }));
        }, 6_000);
      });
      await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
      base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    });
    afterAll(() => new Promise<void>((r) => server.close(() => r())));

    it('a silent answer after 6 s still arrives, over a connection with TCP keepalive', async () => {
      const orig = (await import('node:net')).Socket.prototype.setKeepAlive;
      const net = await import('node:net');
      net.Socket.prototype.setKeepAlive = function (this: import('node:net').Socket, enable?: boolean, delay?: number) {
        if (enable) seen.keepAlive = delay === SOLVER_KEEPALIVE_MS;
        return orig.call(this, enable, delay);
      };
      try {
        const r = await postJsonLong(`${base}/x`, {}, '{}', 20_000);
        expect(r.status).toBe(200);
        expect(JSON.parse(r.text).ok).toBe(true);
        expect(seen.keepAlive).toBe(true);
      } finally {
        net.Socket.prototype.setKeepAlive = orig;
      }
    }, 30_000);
  });
});

describe('callDispatchSolver waits as long as the mode needs (review of the long-search PR: only solverWaitMs was tested)', () => {
  let server: http.Server;
  let base = '';
  const env = { url: process.env.SOLVER_URL, token: process.env.SOLVER_TOKEN };
  beforeAll(async () => {
    server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ run_id: JSON.parse(body).run_id, scenarios: [], warnings: [] }));
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    process.env.SOLVER_URL = base;
    process.env.SOLVER_TOKEN = 'unit-test-token';
  });
  afterAll(async () => {
    process.env.SOLVER_URL = env.url;
    process.env.SOLVER_TOKEN = env.token;
    if (env.url === undefined) delete process.env.SOLVER_URL;
    if (env.token === undefined) delete process.env.SOLVER_TOKEN;
    await new Promise<void>((r) => server.close(() => r()));
  });

  /** The timers the call armed (ms), from a spy on setTimeout. */
  async function armedFor(config: Record<string, unknown> | undefined): Promise<number[]> {
    const spy = vi.spyOn(globalThis, 'setTimeout');
    try {
      const r = await callDispatchSolver({ run_id: 'r1', stops: [], trucks: [], ...(config ? { config } : {}) } as never);
      expect(r.run_id).toBe('r1');
      return spy.mock.calls.map((c) => Number(c[1]));
    } finally {
      spy.mockRestore();
    }
  }

  it('THOROUGH: the cap + 2 minutes (22 min for 20); QUICK and a request without a mode: 600 s', async () => {
    expect(await armedFor({ search_mode: 'THOROUGH', max_search_sec: 1200 })).toContain(1_320_000);
    expect(await armedFor({ search_mode: 'THOROUGH', max_search_sec: 60 })).toContain(180_000);
    const quick = await armedFor({ search_mode: 'QUICK', max_search_sec: null });
    expect(quick).toContain(600_000);
    expect(quick).not.toContain(1_320_000);
    expect(await armedFor(undefined)).toContain(600_000);
  });
});

describe('solve admission per mode', () => {
  const LIMITS: AdmissionLimits = { userPerHour: 100, tenantPerHour: 100, tenantConcurrent: 1, globalConcurrent: 2, maxQueue: 10, queueHardCap: 200, tenantQueue: 2, windowMs: 3_600_000 };
  const gate = (over: Partial<AdmissionLimits> = {}) => new SolveAdmission({ ...LIMITS, ...over }, () => 1_000_000, () => true);
  const ok = (r: ReturnType<SolveAdmission['reserve']>): SolveTicket => {
    if (!r.ok) throw new Error(`refused: ${r.code}`);
    return r.ticket;
  };

  it('a THOROUGH night solve never holds up a same-day QUICK re-plan of another plan of the company', () => {
    const a = gate();
    const night = ok(a.reserve('NMWC', 'u1', 'THOROUGH'));
    expect(night.waiting).toBe(false);
    expect(night.searchMode).toBe('THOROUGH');
    const sameDay = ok(a.reserve('NMWC', 'u2', 'QUICK'));
    expect(sameDay.waiting).toBe(false); // starts at once in the other slot
    expect(a.snapshot()).toMatchObject({ running: 2, runningThorough: 1 });
  });

  it('a second THOROUGH waits for the first (over all companies), and never holds up a QUICK queued after it', async () => {
    const a = gate();
    const first = ok(a.reserve('A', 'u1', 'THOROUGH'));
    const second = ok(a.reserve('B', 'v1', 'THOROUGH'));
    expect(second.waiting).toBe(true);
    const quick = ok(a.reserve('A', 'u2', 'QUICK'));
    expect(quick.waiting).toBe(false); // the free slot is not kept for the waiting THOROUGH
    quick.release();
    // A QUICK of B, queued after B's THOROUGH, still starts in the slot that frees.
    const quickB = ok(a.reserve('B', 'v2', 'QUICK'));
    expect(quickB.waiting).toBe(false);
    expect(second.waiting).toBe(true);
    first.release();
    quickB.release();
    await second.ready();
    expect(second.waiting).toBe(false);
  });

  it('a company runs at most one THOROUGH; QUICK solves wait only for QUICK ones and the total', () => {
    const a = gate({ globalConcurrent: 3 });
    ok(a.reserve('A', 'u1', 'THOROUGH'));
    expect(ok(a.reserve('A', 'u2', 'THOROUGH')).waiting).toBe(true); // one per company
    const q1 = ok(a.reserve('A', 'u3', 'QUICK'));
    expect(q1.waiting).toBe(false);
    expect(ok(a.reserve('A', 'u4', 'QUICK')).waiting).toBe(true); // the company's QUICK cap (tenantConcurrent 1)
    expect(ok(a.reserve('B', 'v1', 'QUICK')).waiting).toBe(false); // another company: the third slot
  });

  it('QUICK alone behaves exactly as before (the default mode)', () => {
    const a = gate();
    const t1 = ok(a.reserve('A', 'u1'));
    expect(t1.searchMode).toBe('QUICK');
    expect(ok(a.reserve('A', 'u2')).waiting).toBe(true); // one per company (global 2 - 1)
    expect(ok(a.reserve('B', 'v1')).waiting).toBe(false);
  });

  it('with SOLVER_MAX_CONCURRENT=1 a THOROUGH holds the only slot (documented: run at least 2)', () => {
    const a = gate({ globalConcurrent: 1 });
    ok(a.reserve('A', 'u1', 'THOROUGH'));
    expect(ok(a.reserve('B', 'v1', 'QUICK')).waiting).toBe(true);
  });

  it('thoroughConcurrent and tenantThoroughConcurrent can be set', () => {
    const a = gate({ globalConcurrent: 4, thoroughConcurrent: 2, tenantThoroughConcurrent: 2 });
    expect(ok(a.reserve('A', 'u1', 'THOROUGH')).waiting).toBe(false);
    expect(ok(a.reserve('A', 'u2', 'THOROUGH')).waiting).toBe(false);
    expect(ok(a.reserve('B', 'v1', 'THOROUGH')).waiting).toBe(true);
    expect(ok(a.reserve('B', 'v2', 'QUICK')).waiting).toBe(false);
  });

  it('waiting THOROUGH solves never use up the queue places of a same-day QUICK (review of the long-search PR)', () => {
    // NMWC: tomorrow's THOROUGH runs, two more THOROUGH plans wait (one per company at a time).
    const a = gate();
    ok(a.reserve('NMWC', 'u1', 'THOROUGH'));
    expect(ok(a.reserve('NMWC', 'u1', 'THOROUGH')).waiting).toBe(true);
    expect(ok(a.reserve('NMWC', 'u1', 'THOROUGH')).waiting).toBe(true);
    const depotA = ok(a.reserve('NMWC', 'u2', 'QUICK'));
    expect(depotA.waiting).toBe(false);
    // Today's re-plan of depot B waits for depot A's QUICK - it is queued, never refused.
    const depotB = a.reserve('NMWC', 'u3', 'QUICK');
    expect(depotB.ok && depotB.ticket.waiting).toBe(true);
    expect(a.snapshot()).toMatchObject({ running: 2, waiting: 3 });
    // Another company's QUICK holds the second slot: NMWC's first QUICK is queued too.
    const b = gate();
    ok(b.reserve('NMWC', 'u1', 'THOROUGH'));
    ok(b.reserve('NMWC', 'u1', 'THOROUGH'));
    ok(b.reserve('NMWC', 'u1', 'THOROUGH'));
    ok(b.reserve('OTHER', 'v1', 'QUICK'));
    const first = b.reserve('NMWC', 'u2', 'QUICK');
    expect(first.ok && first.ticket.waiting).toBe(true);
  });

  it('the company queue cap counts each mode on its own, and the refusal names the mode', () => {
    const a = gate();
    ok(a.reserve('NMWC', 'u1', 'THOROUGH'));
    ok(a.reserve('NMWC', 'u1', 'THOROUGH'));
    ok(a.reserve('NMWC', 'u1', 'THOROUGH'));
    const third = a.reserve('NMWC', 'u1', 'THOROUGH');
    expect(third).toMatchObject({ ok: false, status: 429, code: 'SOLVE_QUEUE_TENANT' });
    if (third.ok) throw new Error('not refused');
    expect(third.error).toBe(
      'Your company already has 2 Thorough optimization(s) waiting for the route optimizer. Try again once one of them has started (a Thorough search takes up to 20 min), or choose Quick.',
    );
    expect(third.retryAfterSec).toBe(600);
    // QUICK has its own places: two QUICK wait behind two running (another company's and NMWC's own).
    ok(a.reserve('NMWC', 'u2', 'QUICK'));
    expect(ok(a.reserve('NMWC', 'u2', 'QUICK')).waiting).toBe(true);
    expect(ok(a.reserve('NMWC', 'u2', 'QUICK')).waiting).toBe(true);
    const quick = a.reserve('NMWC', 'u2', 'QUICK');
    expect(quick).toMatchObject({ ok: false, status: 429, code: 'SOLVE_QUEUE_TENANT', retryAfterSec: 120 });
    if (!quick.ok) expect(quick.error).toBe('Your company already has 2 Quick optimization(s) waiting for the route optimizer. Try again once one of them has started.');
  });

  it('the Thorough refusal states the THOROUGH cap in use, and its Retry-After follows it (skeptic review)', () => {
    for (const [cap, said, retry] of [
      [3600, '1 h 0 min', 600],
      [600, '10 min', 600],
      [60, '1 min', 60],
    ] as const) {
      const a = gate({ thoroughCapSec: cap });
      for (let i = 0; i < 3; i++) ok(a.reserve('NMWC', 'u1', 'THOROUGH')); // one runs, two wait
      const refused = a.reserve('NMWC', 'u1', 'THOROUGH');
      expect(refused).toMatchObject({ ok: false, status: 429, code: 'SOLVE_QUEUE_TENANT', retryAfterSec: retry });
      if (!refused.ok) expect(refused.error).toContain(`(a Thorough search takes up to ${said}), or choose Quick.`);
    }
    // The process-wide gate takes the cap from THOROUGH_MAX_SEC, like the start and the dialog.
    expect(defaultAdmissionLimits({ THOROUGH_MAX_SEC: '3600' } as unknown as NodeJS.ProcessEnv).thoroughCapSec).toBe(3600);
    expect(defaultAdmissionLimits({ THOROUGH_MAX_SEC: '60' } as unknown as NodeJS.ProcessEnv).thoroughCapSec).toBe(60);
    expect(defaultAdmissionLimits({} as NodeJS.ProcessEnv).thoroughCapSec).toBe(1200);
  });

  it('a full shared queue refuses per mode: a THOROUGH waiting never gets the first QUICK of its company a 503 (skeptic review)', () => {
    const a = gate({ maxQueue: 4 });
    ok(a.reserve('S1', 'x', 'QUICK'));
    ok(a.reserve('S2', 'y', 'QUICK')); // both slots taken
    expect(ok(a.reserve('NMWC', 'u1', 'THOROUGH')).waiting).toBe(true); // tomorrow's plan waits
    ok(a.reserve('S3', 'z', 'QUICK'));
    ok(a.reserve('S3', 'z', 'QUICK'));
    ok(a.reserve('S4', 'w', 'QUICK'));
    expect(a.snapshot().waiting).toBe(4); // the shared queue is full
    // NMWC has nothing QUICK waiting: its same-day re-plan is queued, not refused.
    const sameDay = a.reserve('NMWC', 'u2', 'QUICK');
    expect(sameDay.ok && sameDay.ticket.waiting).toBe(true);
    // Now it has one of each waiting: a second of either mode gets 503 until there is room.
    expect(a.reserve('NMWC', 'u2', 'QUICK')).toMatchObject({ ok: false, status: 503, code: 'SOLVER_BUSY' });
    expect(a.reserve('NMWC', 'u1', 'THOROUGH')).toMatchObject({ ok: false, status: 503, code: 'SOLVER_BUSY' });
  });

  it('the queue position counts only what starts before it', () => {
    const a = gate();
    ok(a.reserve('A', 'u1', 'THOROUGH'));
    ok(a.reserve('B', 'v1', 'QUICK'));
    const t = ok(a.reserve('C', 'w1', 'THOROUGH'));
    const q = ok(a.reserve('C', 'w2', 'QUICK'));
    expect(t.waiting && q.waiting).toBe(true);
    expect(q.position()).toBe(1); // the QUICK starts when B's QUICK ends
    expect(t.position()).toBe(2);
  });
});

describe('delivery results are not re-read on the polls of a running search (review of 4 Oct 2026)', () => {
  it('planSearching: OPTIMIZING, or a job QUEUED / RUNNING', () => {
    expect(planSearching({ status: 'OPTIMIZING' }, null)).toBe(true);
    expect(planSearching({ status: 'DISPATCHED' }, { status: 'RUNNING' })).toBe(true);
    expect(planSearching({ status: 'READY' }, { status: 'QUEUED' })).toBe(true);
    expect(planSearching({ status: 'DISPATCHED' }, { status: 'SUCCEEDED' })).toBe(false);
    expect(planSearching(null, null)).toBe(false);
  });

  it('keepDeliveries: a poll without them keeps the card shown for the same day and depot only', () => {
    type DayLike = { date: string; depot: { id: string }; deliveries?: unknown };
    const day = (date: string, depot: string, over: Partial<DayLike> = {}): DayLike => ({ date, depot: { id: depot }, ...over });
    const shown = day('2026-10-05', 'DA', { deliveries: { kpis: 1 } });
    expect(keepDeliveries(shown, day('2026-10-05', 'DA'))).toMatchObject({ deliveries: { kpis: 1 } });
    expect(keepDeliveries(shown, day('2026-10-05', 'DA', { deliveries: null })).deliveries).toBeNull();
    expect(keepDeliveries(shown, day('2026-10-06', 'DA')).deliveries).toBeUndefined();
    expect(keepDeliveries(shown, day('2026-10-05', 'DB')).deliveries).toBeUndefined();
    expect(keepDeliveries(null, day('2026-10-05', 'DA')).deliveries).toBeUndefined();
  });

  it('readResultsNow: skipped only on the polls of a running search once read; a load after a write (Record outcome) always reads them', () => {
    expect(readResultsNow({ searching: false, seen: true, afterWrite: false })).toBe(true);
    expect(readResultsNow({ searching: true, seen: false, afterWrite: false })).toBe(true);
    expect(readResultsNow({ searching: true, seen: true, afterWrite: false })).toBe(false);
    // The dispatcher records "Shop closed" during a 20-minute re-plan: the plan and the day card show it now.
    expect(readResultsNow({ searching: true, seen: true, afterWrite: true })).toBe(true);
  });
});
