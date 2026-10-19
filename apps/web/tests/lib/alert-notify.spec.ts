/**
 * Operations alerts by e-mail (owner request 16 Oct 2026; design PR-2 9.2 with the review's M4, M5, L5,
 * L7, L9): lib/email.ts sendPlainEmail and lib/alerts/notify.ts, without a database.
 * - Nothing is sent unless alerts are on, the company has recipients, "every N min" is not 0, the server
 *   has RESEND_API_KEY and RESEND_FROM, and it is not the quiet hours (22:00-06:00, across midnight).
 * - The digest: subject with the counts, grouped by depot and date (with the day's link), the worst truck
 *   first, HIGH before WARN, "(over at hh:mm)", "worse since the last e-mail", long digit runs removed,
 *   the footer says whether warnings are e-mailed.
 * - The claim (prismaDigestStore on a fake transaction): the company's e-mail lock (a busy lock skips),
 *   the throttle and the daily cap inside the claim's transaction, counted on OpsAlertDigest rows; the
 *   claim SQL orders HIGH first by rank, reads lastSeenAt, skips locked rows; a failed e-mail puts each
 *   row back to the tier it had; a digest a stopped process left SENDING is failed and its rows retried.
 * - Logs carry counts only: never an address, a subject or an alert text.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Prisma } from '@prisma/client';
import { EMAIL_TIMEOUT_MS, plainEmailConfigured, RESEND_URL, sendPlainEmail } from '@/lib/email';
import {
  ALERT_DIGEST_MAX_ROWS,
  buildDigestEmail,
  claimSql,
  digestGate,
  digestIdempotencyKey,
  emailCapReached,
  lastQuietEnd,
  prismaDigestStore,
  scrubNumbers,
  sendAlertDigest,
  type DigestConfig,
  type DigestRow,
  type DigestStore,
} from '@/lib/alerts/notify';
import { ALERT_EMAILS_ALL_PER_DAY, ALERT_EMAILS_PER_DAY } from '@/lib/alerts/catalog';

const ENV = { RESEND_API_KEY: 're_test_key', RESEND_FROM: 'RouteIQ <alerts@routeiq.example>', AUTH_URL: 'https://app.routeiq.example', NODE_ENV: 'test', ALERT_EMAIL_TENANTS: 'other, example' } as unknown as NodeJS.ProcessEnv;
const TZ = 'Asia/Muscat';
/** 10:00 in Muscat on 16 Oct 2026. */
const NOW = new Date('2026-10-16T06:00:00.000Z');
const at = (hhmm: string, day = '2026-10-16') => new Date(`${day}T${hhmm}:00.000+04:00`);

const cfg = (extra: Partial<DigestConfig> = {}): DigestConfig => ({
  alertsEnabled: true,
  alertEmails: 'owner@company.example, dispatch@company.example',
  alertEmailEveryMin: 15,
  alertEmailMinSeverity: 'HIGH',
  alertQuietFromMin: 22 * 60,
  alertQuietToMin: 6 * 60,
  timezone: TZ,
  slug: 'example',
  ...extra,
});

const row = (extra: Partial<DigestRow> = {}): DigestRow => ({
  id: 'a1',
  rule: 'ETA_LATE',
  severity: 'HIGH',
  tier: 2,
  emailedTier: 0,
  depotId: 'dep1',
  deliveryDate: new Date('2026-10-16T00:00:00.000Z'),
  truckCode: 'T05',
  text: 'T05 L1 is running about 65 min late: next stop 4 Shop Example C expected about 11:05 (planned 10:00).',
  occurredAt: at('09:42'),
  resolvedAt: null,
  ...extra,
});

let logs: unknown[][] = [];
beforeEach(() => {
  logs = [];
  for (const k of ['info', 'warn', 'error'] as const) vi.spyOn(console, k).mockImplementation((...a: unknown[]) => void logs.push(a));
});
afterEach(() => {
  vi.restoreAllMocks();
});

/** Everything the logs carried, as one text. */
const logged = () => JSON.stringify(logs);

describe('sendPlainEmail (lib/email.ts)', () => {
  it('needs a key AND a sender: Resend refuses a sender whose domain is not verified, so there is no default', async () => {
    const f = vi.fn();
    expect(plainEmailConfigured(ENV)).toBe(true);
    for (const env of [{ ...ENV, RESEND_API_KEY: '' }, { ...ENV, RESEND_FROM: ' ' }, {}] as NodeJS.ProcessEnv[]) {
      expect(plainEmailConfigured(env)).toBe(false);
      expect(await sendPlainEmail({ to: ['a@x.example'], subject: 's', text: 't' }, env, f as never)).toMatchObject({ ok: false, reason: 'NOT_CONFIGURED' });
    }
    expect(await sendPlainEmail({ to: [' '], subject: 's', text: 't' }, ENV, f as never)).toMatchObject({ ok: false, reason: 'NO_RECIPIENTS' });
    expect(f).not.toHaveBeenCalled();
  });

  it('posts one message to Resend with the key, the sender, every recipient, and a timeout (L7)', async () => {
    const f = vi.fn(async () => new Response('{}', { status: 200 }));
    expect(await sendPlainEmail({ to: ['a@x.example', 'b@y.example'], subject: 'Hello', text: 'Body' }, ENV, f as never)).toEqual({ ok: true });
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(RESEND_URL);
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer re_test_key');
    expect(JSON.parse(init.body as string)).toEqual({ from: 'RouteIQ <alerts@routeiq.example>', to: ['a@x.example', 'b@y.example'], subject: 'Hello', text: 'Body' });
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(EMAIL_TIMEOUT_MS).toBe(10_000);
  });

  it('a refusal keeps the status only; no answer says so; it never throws', async () => {
    expect(await sendPlainEmail({ to: ['a@x.example'], subject: 's', text: 't' }, ENV, (async () => new Response('{"message":"a@x.example is invalid"}', { status: 422 })) as never)).toEqual({
      ok: false,
      reason: 'REJECTED',
      status: 422,
      error: 'provider answered 422',
    });
    const timeout = Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });
    expect(await sendPlainEmail({ to: ['a@x.example'], subject: 's', text: 't' }, ENV, (async () => Promise.reject(timeout)) as never)).toMatchObject({ ok: false, reason: 'FAILED', error: 'no answer within 10 s' });
    expect(await sendPlainEmail({ to: ['a@x.example'], subject: 's', text: 't' }, ENV, (async () => Promise.reject(new TypeError('fetch failed'))) as never)).toMatchObject({ ok: false, reason: 'FAILED', error: 'network error' });
  });
});

describe('digestGate: when a company may get an e-mail', () => {
  it('alerts off, no recipients, "every 0", e-mail not set up on the server: nothing', () => {
    expect(digestGate(null, NOW, ENV)).toEqual({ ok: false, skip: 'ALERTS_OFF' });
    expect(digestGate(cfg({ alertsEnabled: false }), NOW, ENV)).toEqual({ ok: false, skip: 'ALERTS_OFF' });
    expect(digestGate(cfg({ alertEmails: null }), NOW, ENV)).toEqual({ ok: false, skip: 'NO_RECIPIENTS' });
    expect(digestGate(cfg({ alertEmails: 'not-an-address' }), NOW, ENV)).toEqual({ ok: false, skip: 'NO_RECIPIENTS' });
    expect(digestGate(cfg({ alertEmailEveryMin: 0 }), NOW, ENV)).toEqual({ ok: false, skip: 'EMAIL_OFF' });
    expect(digestGate(cfg(), NOW, { RESEND_API_KEY: 'k' } as never)).toEqual({ ok: false, skip: 'NOT_CONFIGURED' });
    expect(digestGate(cfg(), NOW, ENV)).toEqual({ ok: true, recipients: ['owner@company.example', 'dispatch@company.example'] });
  });

  it('review H1: only a company on the server\'s ALERT_EMAIL_TENANTS list (signup is open: no list, no alert e-mail)', () => {
    expect(digestGate(cfg({ slug: 'someone-else' }), NOW, ENV)).toEqual({ ok: false, skip: 'NOT_ALLOWED' });
    expect(digestGate(cfg(), NOW, { ...ENV, ALERT_EMAIL_TENANTS: '' } as never)).toEqual({ ok: false, skip: 'NOT_ALLOWED' });
    expect(digestGate(cfg({ slug: undefined }), NOW, ENV)).toEqual({ ok: false, skip: 'NOT_ALLOWED' });
    expect(digestGate(cfg({ slug: 'Example' }), NOW, { ...ENV, ALERT_EMAIL_TENANTS: ' example ;other' } as never).ok).toBe(true);
  });

  it('quiet hours 22:00-06:00 in the company time zone, across midnight (L9); none when not set', () => {
    for (const [t, quiet] of [
      ['21:59', false],
      ['22:00', true],
      ['23:30', true],
      ['03:00', true],
      ['05:59', true],
      ['06:00', false],
    ] as const) {
      expect(digestGate(cfg(), at(t), ENV), t).toEqual(quiet ? { ok: false, skip: 'QUIET_HOURS' } : { ok: true, recipients: expect.any(Array) });
    }
    expect(digestGate(cfg({ alertQuietFromMin: null, alertQuietToMin: null }), at('23:30'), ENV).ok).toBe(true);
  });
});

describe('the digest e-mail', () => {
  const labels = new Map([
    ['dep1', 'MCT Muscat'],
    ['dep2', 'SHR Example North'],
  ]);
  const build = (rows: DigestRow[], extra: Partial<Parameters<typeof buildDigestEmail>[0]> = {}) =>
    buildDigestEmail({ companyName: 'Example Water Co', slug: 'example', timezone: TZ, now: NOW, rows, depotLabels: labels, baseUrl: 'https://app.routeiq.example', minSeverity: 'HIGH', full: true, ...extra });

  it('subject: the count, the high count and the day - no name a user typed (review H1)', () => {
    expect(build([row(), row({ id: 'a2', severity: 'WARN', tier: 1 })]).subject).toBe('RouteIQ alerts: 2 new (1 high) - 16 Oct');
    expect(build([row()], { companyName: 'Call 5550 1234 now' }).subject).not.toContain('Call');
  });

  it('review L4: the truck and the depot lose long digit runs too, in any script', () => {
    const { text } = build([row({ truckCode: 'HIRE ٥٥٥٠١٢٣٤', text: 'T05 L1 ring ٥٥٥٠ ١٢٣٤ now' })], { depotLabels: new Map([['dep1', 'MCT call 5550 9876']]) });
    expect(text).not.toMatch(/5550|9876|٥٥٥٠|١٢٣٤/);
    expect(text).toContain('MCT call [number] - 16 Oct');
    expect(text).toContain('  HIRE [number]');
    expect(text).toContain('T05 L1 ring [number] now');
  });

  it('grouped by depot and date with the link to that day, the worst truck first, HIGH first within a truck', () => {
    const { text } = build([
      row({ id: 'w', truckCode: 'T02', severity: 'WARN', tier: 1, rule: 'DRIVER_SILENT', text: 'T02 L1: nothing from the driver for 2 h 05 min.', occurredAt: at('08:10') }),
      row({ id: 'h', truckCode: 'T09', rule: 'UNLOAD_OVER', text: 'T09 L1 stop 2 Hyper Example B: unloading for 95 min.', occurredAt: at('09:00') }),
      row({ id: 'h2', truckCode: 'T02', rule: 'ETA_LATE', text: 'T02 L1 is running about 70 min late.', occurredAt: at('09:30') }),
      row({ id: 'n', depotId: 'dep2', deliveryDate: new Date('2026-10-17T00:00:00.000Z'), truckCode: 'T07', rule: 'LOADING_OVER', text: 'T07 L2: loading for 95 min.' }),
    ]);
    const lines = text.split('\n');
    const i = (s: string) => lines.findIndex((l) => l.includes(s));
    expect(lines[0]).toBe('4 alerts since the last e-mail (3 high).');
    expect(i('MCT Muscat - 16 Oct')).toBeGreaterThan(0);
    expect(lines[i('MCT Muscat - 16 Oct') + 1]).toBe('Open the day in RouteIQ: https://app.routeiq.example/t/example/dispatch?date=2026-10-16&depot=dep1');
    expect(i('SHR Example North - 17 Oct')).toBeGreaterThan(i('MCT Muscat - 16 Oct'));
    // T02 and T09 both have a HIGH: by code; within T02 the HIGH comes before the WARN.
    expect(i('  T02')).toBeLessThan(i('  T09'));
    expect(i('[HIGH] 09:30 Running late: T02 L1')).toBeLessThan(i('[WARN] 08:10 Driver silent: T02 L1'));
    expect(text).toContain('    [HIGH] 09:00 Unloading longer than planned: T09 L1 stop 2 Hyper Example B: unloading for 95 min.');
  });

  it('says what is over and what got worse; removes long digit runs; footer by the minimum severity', () => {
    const { text } = build([
      row({ resolvedAt: at('10:50') }),
      row({ id: 'a2', truckCode: 'T06', emailedTier: 1, tier: 2, rule: 'DELIVERED_WITH_NOTE', text: 'T06 L1 stop 2 marked DELIVERED with a note: "call 5550 1234 or +000 5550 9876" (driver, 10:05).' }),
    ]);
    expect(text).toContain('(over at 10:50)');
    expect(text).toContain('(worse since the last e-mail)');
    expect(text).not.toMatch(/5550|1234|9876/);
    expect(text).toContain('"call [number] or [number]"');
    expect(text).toContain('This e-mail lists high alerts only; warnings show in RouteIQ.');
    expect(build([row()], { minSeverity: 'WARN' }).text).toContain('This e-mail lists warnings and high alerts.');
    expect(text).toContain('Settings > Operations alerts');
  });

  it("review of the branch (finding 1): a row closed at the end of its day says \"(day ended)\", never \"over at\" the midnight sweep", () => {
    const { text } = build([row({ deliveryDate: new Date('2026-10-15T00:00:00.000Z'), occurredAt: at('21:50', '2026-10-15'), resolvedAt: at('00:02'), resolvedReason: 'DAY_ENDED' })]);
    expect(text).toContain('MCT Muscat - 15 Oct');
    expect(text).toContain('    [HIGH] 21:50 Running late: T05 L1 is running about 65 min late');
    expect(text).toContain('(day ended)');
    expect(text).not.toContain('over at');
  });

  it('no link without a public address; a full e-mail says there may be more', () => {
    const { text } = build([row()], { baseUrl: null, full: false });
    expect(text).not.toContain('Open the day in RouteIQ');
    expect(text).toContain(`At most ${ALERT_DIGEST_MAX_ROWS} alerts go in one e-mail`);
  });

  it('scrubNumbers keeps times, stop numbers and short codes, removes phone numbers', () => {
    expect(scrubNumbers('T05 L1 stop 3 (C100 / B2) 13:25, planned 25 min - 50 min over, 2 of 9 stops, 2.4 km')).toBe('T05 L1 stop 3 (C100 / B2) 13:25, planned 25 min - 50 min over, 2 of 9 stops, 2.4 km');
    expect(scrubNumbers('ring 55501234, 5550-1234, +000 5550 1234 or 24/123456')).toBe('ring [number], [number], [number] or [number]');
  });
});

/** A fake DigestStore that records what the digest did. */
function fakeStore(over: Partial<DigestStore> = {}) {
  const calls: { finish: unknown[][]; claim: unknown[][] } = { finish: [], claim: [] };
  const store: DigestStore = {
    readConfig: async () => ({ ...cfg(), name: 'Example Water Co', slug: 'example' }),
    claim: async (...a) => {
      calls.claim.push(a);
      return { ok: true, digestId: 'dg1', rows: [row(), row({ id: 'a2', severity: 'WARN', tier: 1 })] };
    },
    depotLabels: async () => new Map([['dep1', 'MCT Muscat']]),
    finish: async (...a) => void calls.finish.push(a),
    ...over,
  };
  return { store, calls };
}

describe('sendAlertDigest', () => {
  it('sends the claimed rows to the recipients and marks the digest sent; the log has counts only', async () => {
    const { store, calls } = fakeStore();
    const f = vi.fn(async () => new Response('{}', { status: 200 }));
    const out = await sendAlertDigest('tA', NOW, { store, env: ENV, fetchImpl: f as never });
    expect(out).toEqual({ sent: true, alerts: 2, high: 1, digestId: 'dg1' });
    // The quiet hours ended at 06:00 today: the claim leaves out what ended before then (review L5). Only
    // rows of the company's today or later (owner request 19 Oct 2026).
    expect(calls.claim[0]).toEqual(['tA', NOW, { everyMin: 15, minSeverity: 'HIGH', dayStart: new Date('2026-10-15T20:00:00.000Z'), today: '2026-10-16', recipients: 2, quietEndedAt: at('06:00') }]);
    const init = (f.mock.calls[0] as unknown as [string, RequestInit])[1];
    const body = JSON.parse(init.body as string);
    expect(body.to).toEqual(['owner@company.example', 'dispatch@company.example']);
    expect(body.subject).toBe('RouteIQ alerts: 2 new (1 high) - 16 Oct');
    // Review L2: an Idempotency-Key over the content (the same e-mail sent again within 24 h goes once).
    const key = (init.headers as Record<string, string>)['Idempotency-Key'];
    expect(key).toBe(digestIdempotencyKey('tA', body.to, body.subject, body.text));
    expect(key).toMatch(/^routeiq-alerts-[0-9a-f]{48}$/);
    expect(digestIdempotencyKey('tA', body.to, body.subject, `${body.text} `)).not.toBe(key);
    expect(calls.finish[0]![4]).toEqual({ ok: true });
    expect(logged()).not.toMatch(/@company\.example|running about|Example Water Co/);
    expect(logged()).toContain('"recipients":2');
  });

  it('owner request 19 Oct 2026: just after midnight the claim already reads the new day (the day before is history)', async () => {
    const { store, calls } = fakeStore({ readConfig: async () => ({ ...cfg({ alertQuietFromMin: null, alertQuietToMin: null }), name: 'Example Water Co', slug: 'example' }) });
    await sendAlertDigest('tA', at('00:02', '2026-10-17'), { store, env: ENV, fetchImpl: (async () => new Response('{}', { status: 200 })) as never });
    expect(calls.claim[0]![2]).toMatchObject({ today: '2026-10-17', dayStart: new Date('2026-10-16T20:00:00.000Z') });
    // One minute before midnight it is still the day before.
    const late = fakeStore({ readConfig: async () => ({ ...cfg({ alertQuietFromMin: null, alertQuietToMin: null }), name: 'Example Water Co', slug: 'example' }) });
    await sendAlertDigest('tA', at('23:59'), { store: late.store, env: ENV, fetchImpl: (async () => new Response('{}', { status: 200 })) as never });
    expect(late.calls.claim[0]![2]).toMatchObject({ today: '2026-10-16' });
  });

  it("review of the branch (finding 1): a HIGH raised at 21:50, after the 21:45 e-mail and before the quiet hours, closed at midnight as Day ended, goes in the first e-mail after them (06:02), marked \"(day ended)\"", async () => {
    const evening = row({ id: 'late', deliveryDate: new Date('2026-10-16T00:00:00.000Z'), occurredAt: at('21:50'), resolvedAt: at('00:02', '2026-10-17'), resolvedReason: 'DAY_ENDED' });
    const { store, calls } = fakeStore({
      claim: async (...a) => {
        calls.claim.push(a);
        return { ok: true, digestId: 'dg2', rows: [evening] };
      },
    });
    // 23:00: the quiet hours (22:00-06:00): no e-mail, nothing claimed.
    expect(await sendAlertDigest('tA', at('23:00'), { store, env: ENV, fetchImpl: (async () => new Response('{}', { status: 200 })) as never })).toMatchObject({ sent: false, skip: 'QUIET_HOURS' });
    expect(calls.claim).toEqual([]);
    const f = vi.fn(async () => new Response('{}', { status: 200 }));
    const out = await sendAlertDigest('tA', at('06:02', '2026-10-17'), { store, env: ENV, fetchImpl: f as never });
    expect(out).toEqual({ sent: true, alerts: 1, high: 1, digestId: 'dg2' });
    // The claim reads the new day and its start (the day before's rows: only one closed at its end, never e-mailed).
    expect(calls.claim[0]![2]).toMatchObject({ today: '2026-10-17', dayStart: new Date('2026-10-16T20:00:00.000Z'), quietEndedAt: at('06:00', '2026-10-17') });
    const body = JSON.parse(((f.mock.calls[0] as unknown as [string, RequestInit])[1].body as string));
    expect(body.text).toContain('MCT Muscat - 16 Oct');
    expect(body.text).toContain('[HIGH] 21:50 Running late: T05 L1 is running about 65 min late');
    expect(body.text).toContain('(day ended)');
  });

  it('a failed e-mail is handed to finish (the rows go back) and answered as not sent', async () => {
    const { store, calls } = fakeStore();
    const out = await sendAlertDigest('tA', NOW, { store, env: ENV, fetchImpl: (async () => new Response('', { status: 403 })) as never });
    expect(out).toEqual({ sent: false, error: 'provider answered 403', alerts: 2, high: 1, digestId: 'dg1' });
    expect(calls.finish[0]![4]).toMatchObject({ ok: false, reason: 'REJECTED', status: 403 });
    expect(logged()).not.toMatch(/@company\.example/);
  });

  it('nothing is claimed when the gate says no; a claim that skips is passed on; nothing is fetched', async () => {
    const f = vi.fn();
    const off = fakeStore({ readConfig: async () => ({ ...cfg({ alertEmails: null }), name: 'X', slug: 'x' }) });
    expect(await sendAlertDigest('tA', NOW, { store: off.store, env: ENV, fetchImpl: f as never })).toEqual({ sent: false, skip: 'NO_RECIPIENTS', alerts: 0, high: 0 });
    expect(off.calls.claim).toEqual([]);
    const quiet = fakeStore();
    expect(await sendAlertDigest('tA', at('23:00'), { store: quiet.store, env: ENV, fetchImpl: f as never })).toMatchObject({ sent: false, skip: 'QUIET_HOURS' });
    expect(quiet.calls.claim).toEqual([]);
    for (const skip of ['BUSY', 'TOO_SOON', 'DAILY_CAP', 'ALL_COMPANIES_CAP', 'NOTHING_NEW'] as const) {
      const s = fakeStore({ claim: async () => ({ ok: false, skip }) });
      expect(await sendAlertDigest('tA', NOW, { store: s.store, env: ENV, fetchImpl: f as never })).toEqual({ sent: false, skip, alerts: 0, high: 0 });
    }
    expect(f).not.toHaveBeenCalled();
  });

  it('never throws: a database error answers not sent and logs no address', async () => {
    const s = fakeStore({
      claim: async () => {
        throw new Error('connection to owner@company.example lost');
      },
    });
    expect(await sendAlertDigest('tA', NOW, { store: s.store, env: ENV })).toEqual({ sent: false, error: 'internal error', alerts: 0, high: 0 });
    expect(logged()).not.toMatch(/@company\.example/);
  });
});

describe('the claim SQL (review L5)', () => {
  const since = new Date(NOW.getTime() - 15 * 60_000);
  const DAY_START = new Date('2026-10-15T20:00:00.000Z');
  const sql = claimSql('tA', NOW, 'HIGH', since, '2026-10-16', DAY_START);
  it('HIGH first by rank (a CASE, not the alphabet), then the oldest; skips rows another sweep holds', () => {
    expect(sql.sql).toMatch(/ORDER BY CASE "severity" WHEN 'HIGH' THEN 0 ELSE 1 END, "firstSeenAt", "id"/);
    expect(sql.sql).toMatch(/FOR UPDATE SKIP LOCKED/);
  });
  it('only unacknowledged rows allowed in an e-mail, worse than e-mailed, seen in the last 12 h (lastSeenAt), open or over by themselves since the last e-mail', () => {
    expect(sql.sql).toMatch(/"ackedAt" IS NULL/);
    expect(sql.sql).toMatch(/"mayEmail" = true/);
    expect(sql.sql).toMatch(/"emailedTier" < "tier"/);
    expect(sql.sql).toMatch(/"lastSeenAt" > \?/);
    // The 12 h look back reads lastSeenAt; firstSeenAt is read only for the day's follow-up raised since the day's start (below).
    expect(sql.sql).not.toMatch(/"firstSeenAt" > \?/);
    expect(sql.sql).toMatch(/\("resolvedAt" IS NULL OR \("resolvedReason" = 'ENDED' AND "resolvedAt" > \?\)\)/);
    expect(sql.values).toContainEqual(since);
    expect(sql.values).toContain('tA');
    expect(sql.values).toContainEqual(new Date(NOW.getTime() - 12 * 3_600_000));
    expect(sql.values).toContain(ALERT_DIGEST_MAX_ROWS);
    // HIGH only by default; WARN too when the company e-mails warnings.
    expect(sql.values).toContain(false);
    expect(claimSql('tA', NOW, 'WARN', since, '2026-10-16', DAY_START).values).toContain(true);
  });
  it("owner request 19 Oct 2026: open or over by itself only for rows of the company's today or later (a row of yesterday still open because the sweep has not run since midnight is not e-mailed as open)", () => {
    const flat = sql.sql.replace(/\s+/g, ' ');
    expect(flat).toMatch(/\(\("deliveryDate" >= \?::date OR \("firstSeenAt" >= \? AND "rule" IN \(\?\)\)\) AND \("resolvedAt" IS NULL OR \("resolvedReason" = 'ENDED' AND "resolvedAt" > \?\)\)\)/);
    expect(sql.values).toContain('2026-10-16');
  });

  it("review of the branch (finding 1): a row closed at the end of its day goes once if it was never e-mailed; one e-mailed before is never sent again", () => {
    const flat = sql.sql.replace(/\s+/g, ' ');
    // Any day (it is always the day before): DAY_ENDED and emailedTier 0, besides every other condition (not
    // acknowledged, mayEmail, seen in the last 12 h, the severity). The claim sets emailedTier = tier: once.
    expect(flat).toMatch(/OR \("resolvedReason" = 'DAY_ENDED' AND "emailedTier" = 0\) \) AND/);
    expect(flat).toMatch(/WHERE "tenantId" = \? AND "ackedAt" IS NULL AND "mayEmail" = true AND "emailedTier" < "tier" AND "emailAttempts" < \? AND "lastSeenAt" > \? AND \(/);
    // No other closed reason is news: not EXPIRED, NOT_IN_PLAN, RULE_OFF, NOT_FOLLOWED or CORRECTED.
    for (const reason of ['EXPIRED', 'NOT_IN_PLAN', 'RULE_OFF', 'NOT_FOLLOWED', 'CORRECTED']) expect(flat).not.toContain(reason);
  });

  it("review of the branch (finding 2): the day's follow-up raised since the start of the company's today (Load not closed for a load planned back late) is e-mailed like a row of today", () => {
    expect(sql.values).toContainEqual(DAY_START);
    expect(sql.values).toContain('LOAD_NOT_CLOSED');
  });
});

/** A fake Prisma client for prismaDigestStore: the transaction runs on the same fake. */
function fakeDb(state: { locked?: boolean; lastAt?: Date | null; today?: number; all?: number; found?: Record<string, unknown>[]; stale?: string[] }) {
  const seen = { sql: [] as string[], values: [] as unknown[][], creates: [] as unknown[], updates: [] as unknown[], updateMany: [] as unknown[], digestUpdates: [] as unknown[] };
  const tx = {
    $queryRaw: async (q: Prisma.Sql | TemplateStringsArray, ...values: unknown[]) => {
      // A tagged template is an array of strings; Prisma.sql(...) is an object with .sql / .values.
      const text = Array.isArray(q) ? (q as TemplateStringsArray).join('?') : (q as Prisma.Sql).sql;
      seen.sql.push(text);
      seen.values.push(Array.isArray(q) ? values : (q as Prisma.Sql).values);
      if (text.includes('pg_try_advisory_xact_lock')) return [{ locked: state.locked ?? true }];
      return state.found ?? [];
    },
    $executeRaw: async (q: TemplateStringsArray | Prisma.Sql, ...values: unknown[]) => {
      seen.sql.push(Array.isArray(q) ? (q as TemplateStringsArray).join('?') : (q as Prisma.Sql).sql);
      seen.values.push(values);
      return 1;
    },
    opsAlertDigest: {
      findMany: async () => (state.stale ?? []).map((id) => ({ id })),
      findFirst: async () => (state.lastAt ? { createdAt: state.lastAt } : null),
      // The company's own count names it; the count of every company together does not.
      count: async (a: { where: { tenantId?: string } }) => (a.where.tenantId ? (state.today ?? 0) : (state.all ?? state.today ?? 0)),
      create: async (a: unknown) => {
        seen.creates.push(a);
        return { id: 'dgNew' };
      },
      update: async (a: unknown) => void seen.digestUpdates.push(a),
    },
    opsAlert: { updateMany: async (a: unknown) => void seen.updateMany.push(a) },
  };
  const db = { ...tx, $transaction: async (fn: (t: typeof tx) => unknown) => fn(tx) };
  return { db: db as never, seen };
}

const claimOpts = { everyMin: 15, minSeverity: 'HIGH', dayStart: new Date('2026-10-15T20:00:00.000Z'), today: '2026-10-16', recipients: 2 };
const sqlRow = (id: string, severity = 'HIGH', emailedTier = 0) => ({ ...row({ id, severity: severity as never, emailedTier }), tier: 2 });

describe('prismaDigestStore: the claim in one transaction under the company e-mail lock (M4, M5)', () => {
  it('another sweep holds the lock: skipped, nothing read or written', async () => {
    const { db, seen } = fakeDb({ locked: false });
    expect(await prismaDigestStore(db).claim('tA', NOW, claimOpts)).toEqual({ ok: false, skip: 'BUSY' });
    expect(seen.sql).toHaveLength(1);
    expect(seen.sql[0]).toContain('pg_try_advisory_xact_lock(hashtext(');
    expect(seen.values[0]).toEqual(['ops-alerts-mail:tA']);
    expect(seen.creates).toEqual([]);
  });

  it('the throttle and the daily cap are read inside the transaction, from the digest rows', async () => {
    expect(await prismaDigestStore(fakeDb({ lastAt: new Date(NOW.getTime() - 14 * 60_000) }).db).claim('tA', NOW, claimOpts)).toEqual({ ok: false, skip: 'TOO_SOON' });
    expect(await prismaDigestStore(fakeDb({ lastAt: new Date(NOW.getTime() - 15 * 60_000), today: ALERT_EMAILS_PER_DAY }).db).claim('tA', NOW, claimOpts)).toEqual({ ok: false, skip: 'DAILY_CAP' });
    expect(await prismaDigestStore(fakeDb({ today: ALERT_EMAILS_PER_DAY - 1 }).db).claim('tA', NOW, claimOpts)).toEqual({ ok: false, skip: 'NOTHING_NEW' });
  });

  it('review H1: every company together has a cap in any 24 h (the provider\'s free plan, the password reset)', async () => {
    expect(await prismaDigestStore(fakeDb({ today: 1, all: ALERT_EMAILS_ALL_PER_DAY }).db).claim('tA', NOW, claimOpts)).toEqual({ ok: false, skip: 'ALL_COMPANIES_CAP' });
    expect(await prismaDigestStore(fakeDb({ today: 1, all: ALERT_EMAILS_ALL_PER_DAY - 1 }).db).claim('tA', NOW, claimOpts)).toEqual({ ok: false, skip: 'NOTHING_NEW' });
  });

  it('review L5: the first e-mail after the quiet hours leaves out what ended during them', async () => {
    const night = fakeDb({ lastAt: at('21:45', '2026-10-15'), found: [] });
    await prismaDigestStore(night.db).claim('tA', at('06:02'), { ...claimOpts, quietEndedAt: at('06:00') });
    expect(night.seen.values.find((v) => v.includes('tA') && v.some((x) => x instanceof Date && x.getTime() === at('06:00').getTime()))).toBeTruthy();
    // Later in the day the last e-mail is the limit, as before.
    const day = fakeDb({ lastAt: at('09:30'), found: [] });
    await prismaDigestStore(day.db).claim('tA', NOW, { ...claimOpts, quietEndedAt: at('06:00') });
    expect(day.seen.values.find((v) => v.includes('tA') && v.some((x) => x instanceof Date && x.getTime() === at('09:30').getTime()))).toBeTruthy();
  });

  it('lastQuietEnd: today\'s end once passed, else yesterday\'s; none without quiet hours', () => {
    expect(lastQuietEnd(at('06:02'), TZ, 22 * 60, 6 * 60)).toEqual(at('06:00'));
    expect(lastQuietEnd(at('05:00'), TZ, 22 * 60, 6 * 60)).toEqual(at('06:00', '2026-10-15'));
    expect(lastQuietEnd(NOW, TZ, null, null)).toBeNull();
  });

  it('claims: one digest row with counts only, and the rows marked e-mailed at their tier with its id', async () => {
    const { db, seen } = fakeDb({ found: [sqlRow('a1'), sqlRow('a2', 'HIGH', 1)] });
    const out = await prismaDigestStore(db).claim('tA', NOW, claimOpts);
    expect(out).toMatchObject({ ok: true, digestId: 'dgNew' });
    expect((out as { rows: DigestRow[] }).rows.map((r) => [r.id, r.emailedTier])).toEqual([
      ['a1', 0],
      ['a2', 1],
    ]);
    expect(seen.creates).toEqual([{ data: { tenantId: 'tA', createdAt: NOW, status: 'SENDING', alertCount: 2, highCount: 2, recipientCount: 2 }, select: { id: true } }]);
    expect(JSON.stringify(seen.creates)).not.toMatch(/@|running/);
    const update = seen.sql.find((s) => s.startsWith('UPDATE "OpsAlert"'))!;
    expect(update).toMatch(/SET "emailedTier" = "tier", "emailedAt" = \?, "digestId" = \?\s+WHERE "tenantId" = \? AND "id" IN \(\?\)/);
  });

  it('a digest a stopped process left SENDING is failed and its rows are tried again', async () => {
    const { db, seen } = fakeDb({ stale: ['dgOld'] });
    await prismaDigestStore(db).claim('tA', NOW, claimOpts);
    expect(seen.digestUpdates).toEqual([{ where: { id: 'dgOld' }, data: { status: 'FAILED', error: 'interrupted before it was sent' } }]);
    expect(seen.updateMany).toEqual([{ where: { tenantId: 'tA', digestId: 'dgOld' }, data: { emailedTier: 0, emailAttempts: { increment: 1 }, emailError: 'interrupted before it was sent' } }]);
  });

  it('finish: sent marks the digest SENT; failed puts each row back to the tier it had and counts the attempt', async () => {
    const ok = fakeDb({});
    await prismaDigestStore(ok.db).finish('tA', 'dg1', [row()], NOW, { ok: true });
    expect(ok.seen.digestUpdates).toEqual([{ where: { id: 'dg1' }, data: { status: 'SENT', sentAt: NOW } }]);
    const bad = fakeDb({});
    await prismaDigestStore(bad.db).finish('tA', 'dg1', [row({ id: 'a1', emailedTier: 0 }), row({ id: 'a2', emailedTier: 1 }), row({ id: 'a3', emailedTier: 0 })], NOW, { ok: false, reason: 'REJECTED', status: 403, error: 'provider answered 403' });
    expect(bad.seen.digestUpdates).toEqual([{ where: { id: 'dg1' }, data: { status: 'FAILED', error: 'provider answered 403' } }]);
    expect(bad.seen.updateMany).toEqual([
      { where: { tenantId: 'tA', digestId: 'dg1', id: { in: ['a1', 'a3'] } }, data: { emailedTier: 0, emailAttempts: { increment: 1 }, emailError: 'provider answered 403' } },
      { where: { tenantId: 'tA', digestId: 'dg1', id: { in: ['a2'] } }, data: { emailedTier: 1, emailAttempts: { increment: 1 }, emailError: 'provider answered 403' } },
    ]);
  });
});

describe('emailCapReached (the bell says "daily limit reached")', () => {
  it('counts the digests since local midnight against ALERT_EMAILS_PER_DAY', async () => {
    const since: Date[] = [];
    expect(await emailCapReached(async (d) => (since.push(d), ALERT_EMAILS_PER_DAY), NOW, TZ)).toBe(true);
    expect(await emailCapReached(async () => ALERT_EMAILS_PER_DAY - 1, NOW, TZ)).toBe(false);
    expect(since[0]).toEqual(new Date('2026-10-15T20:00:00.000Z'));
  });
});
