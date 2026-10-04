/**
 * Driver links (owner request 4 Oct 2026, spec section 4.3) on the in-memory database
 * (fake-plan-db.ts): ensure, reissue, revoke and resolve; the reissue prompt; "used on N phones";
 * the audit rows (never a token). Synthetic data only: truck T05, drivers Salim and Khalid.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fakePrisma, rawLog, resetDb, row, tables } from './fake-plan-db';

vi.mock('@/lib/db', async () => ({ prisma: (await import('./fake-plan-db')).fakePrisma }));
vi.mock('@/lib/tenant', async () => {
  const m = await import('./fake-plan-db');
  return { tenantDb: () => m.fakePrisma };
});
vi.mock('@/lib/audit', () => ({
  audit: vi.fn(async (input: Record<string, unknown>, tx?: typeof fakePrisma) => (tx ?? fakePrisma).auditLog.create({ data: { ...input } })),
}));

import { ensureLink, listLinks, reissueLink, resolveDriverLink, revokeLink, touchUpdate, MAX_DEVICES } from '@/lib/driver-link/service';
import { earliestOpenLoad, reissuePrompt, reissuePromptText } from '@/lib/driver-link/reissue-prompt';
import { driverActor } from '@/lib/driver-link/actor';
import { tokenHash } from '@/lib/driver-link/token';

const T = 'tA';
const ENV = { NODE_ENV: 'test', NEXTAUTH_SECRET: 'unit-test-secret', AUTH_URL: 'https://routeiq.test' } as unknown as NodeJS.ProcessEnv;
const ROTATED = { ...ENV, NEXTAUTH_SECRET: 'rotated-secret' } as unknown as NodeJS.ProcessEnv;
// 5 Oct 2026, 09:00 Asia/Muscat: the link works until 6 Oct 12:00 (08:00 UTC).
const NOW = new Date('2026-10-05T05:00:00Z');
const opts = (over: Record<string, unknown> = {}) => ({ env: ENV, now: NOW, ...over });
const tokenOf = (url: string | null) => url!.split('/d/')[1]!;

function seed() {
  resetDb();
  tables.tenant = [{ id: T, name: 'Synthetic Water Co', active: true }];
  tables.tenantConfig = [{ id: 'cfg', tenantId: T, timezone: 'Asia/Muscat' }];
  tables.truck = [{ id: 't5', tenantId: T, code: 'T05', hired: false }];
  tables.driver = [
    { id: 'salim', tenantId: T, code: 'D1', name: 'Salim', phone: '+968 9000 0001', casual: false, active: true },
    { id: 'khalid', tenantId: T, code: 'DAY-261005-1', name: 'Khalid', phone: null, casual: true, active: true },
  ];
  tables.runPlan = [
    { id: 'R1', tenantId: T, depotId: 'D1', runDate: new Date('2026-10-05T00:00:00Z'), status: 'READY', version: 1, supersededAt: null, chosenScenarioId: 'sc', createdAt: new Date() },
  ];
  tables.planLoad = [
    { id: 'L1', tenantId: T, runId: 'R1', truckId: 't5', loadNo: 1, status: 'LOCKED', departMin: 430, returnMin: 700, driverId: 'salim', statusChangedAt: null },
    { id: 'L2', tenantId: T, runId: 'R1', truckId: 't5', loadNo: 2, status: 'PLANNED', departMin: 760, returnMin: 1000, driverId: null, statusChangedAt: null },
  ];
}

beforeEach(seed);

describe('ensureLink', () => {
  it('creates the truck-day link once, under the advisory lock, made for the first open load\'s driver', async () => {
    const a = await ensureLink(T, 'R1', 't5', 'u1', opts());
    expect(a.created).toBe(true);
    expect(a.url).toMatch(/^https:\/\/routeiq\.test\/d\/[A-Za-z0-9_-]{24}$/);
    expect(a.qr?.d).toMatch(/^M\d/);
    expect(a).toMatchObject({ truckCode: 'T05', date: '2026-10-05', generation: 1, revoked: false, expired: false, driverIdAtIssue: 'salim', driverNameAtIssue: 'Salim' });
    expect(a.expiresAt).toBe('2026-10-06T08:00:00.000Z');
    expect(a.uploadUntil).toBe('2026-10-09T08:00:00.000Z');
    expect(rawLog.some((s) => /pg_advisory_xact_lock\(hashtextextended\(\?, 0\)\)/.test(s))).toBe(true);
    const b = await ensureLink(T, 'R1', 't5', 'u1', opts());
    expect(b.created).toBe(false);
    expect(b.url).toBe(a.url); // the same link can be printed again
    expect(tables.driverLink).toHaveLength(1);
    // Only the hash is stored.
    const stored = tables.driverLink[0];
    expect(stored.tokenHash).toBe(tokenHash(tokenOf(a.url)));
    expect(JSON.stringify(stored)).not.toContain(tokenOf(a.url));
  });

  it('a unique-key error is answered from a fresh read OUTSIDE the transaction, never retried inside it', async () => {
    await ensureLink(T, 'R1', 't5', 'u1', opts());
    const real = fakePrisma.$transaction;
    const calls = { n: 0 };
    fakePrisma.$transaction = async () => {
      calls.n++;
      throw Object.assign(new Error('Unique constraint failed'), { code: 'P2002' });
    };
    try {
      const v = await ensureLink(T, 'R1', 't5', 'u1', opts());
      expect(v.created).toBe(false);
      expect(v.url).toMatch(/\/d\//);
      expect(calls.n).toBe(1);
    } finally {
      fakePrisma.$transaction = real;
    }
  });

  it('a revoked link stays revoked: no token, no QR, Reissue offered', async () => {
    const a = await ensureLink(T, 'R1', 't5', 'u1', opts());
    await revokeLink(T, a.linkId, 'u1', 'QR photographed', opts());
    const b = await ensureLink(T, 'R1', 't5', 'u1', opts());
    expect(b).toMatchObject({ revoked: true, url: null, qr: null });
  });

  it('refuses 409 LINK_DAY_OVER once the link has expired, and 404 for a truck without a load on the plan', async () => {
    await expect(ensureLink(T, 'R1', 't5', 'u1', opts({ now: new Date('2026-10-06T08:00:00Z') }))).rejects.toMatchObject({ status: 409, details: { code: 'LINK_DAY_OVER' } });
    await expect(ensureLink(T, 'R1', 'other', 'u1', opts())).rejects.toMatchObject({ status: 404 });
  });

  it('a link made before any driver was set takes the driver silently', async () => {
    row('planLoad', 'L1').driverId = null;
    const a = await ensureLink(T, 'R1', 't5', 'u1', opts());
    expect(a.driverIdAtIssue).toBeNull();
    row('planLoad', 'L1').driverId = 'khalid';
    const b = await ensureLink(T, 'R1', 't5', 'u1', opts());
    expect(b.driverIdAtIssue).toBe('khalid');
    expect(b.generation).toBe(1);
    expect(b.url).toBe(a.url);
  });

  it('off without a secret: 503 DRIVER_LINKS_OFF', async () => {
    await expect(ensureLink(T, 'R1', 't5', 'u1', opts({ env: { NODE_ENV: 'test' } }))).rejects.toMatchObject({ status: 503, details: { code: 'DRIVER_LINKS_OFF' } });
  });
});

describe('reissue, revoke and resolve', () => {
  it('reissue: generation + 1, the old token answers 410 LINK_REPLACED, the one before it 404', async () => {
    const a = await ensureLink(T, 'R1', 't5', 'u1', opts());
    const t1 = tokenOf(a.url);
    expect(await resolveDriverLink(t1, opts())).toMatchObject({ ok: true, mode: 'full', date: '2026-10-05' });
    const b = await reissueLink(T, a.linkId, 'u1', 'driver changed', opts());
    const t2 = tokenOf(b.url);
    expect(b.generation).toBe(2);
    expect(t2).not.toBe(t1);
    expect(row('driverLink', a.linkId).prevTokenHash).toBe(tokenHash(t1));
    expect(await resolveDriverLink(t1, opts())).toMatchObject({ ok: false, status: 410, code: 'LINK_REPLACED', known: true });
    expect(await resolveDriverLink(t2, opts())).toMatchObject({ ok: true });
    const c = await reissueLink(T, a.linkId, 'u1', null, opts());
    expect(await resolveDriverLink(t1, opts())).toMatchObject({ ok: false, status: 404, code: 'LINK_NOT_FOUND', known: false });
    expect(await resolveDriverLink(t2, opts())).toMatchObject({ ok: false, status: 410, code: 'LINK_REPLACED' });
    expect(await resolveDriverLink(tokenOf(c.url), opts())).toMatchObject({ ok: true });
    // A reissue keeps the expiry and starts the phone list again.
    expect(c.expiresAt).toBe(a.expiresAt);
    expect(c.devices.n).toBe(0);
  });

  it('revoke: 410 LINK_REVOKED; a reissue makes a working link again', async () => {
    const a = await ensureLink(T, 'R1', 't5', 'u1', opts());
    await revokeLink(T, a.linkId, 'u1', null, opts());
    expect(await resolveDriverLink(tokenOf(a.url), opts())).toMatchObject({ ok: false, status: 410, code: 'LINK_REVOKED' });
    const b = await reissueLink(T, a.linkId, 'u1', null, opts());
    expect(b.revoked).toBe(false);
    expect(await resolveDriverLink(tokenOf(b.url), opts())).toMatchObject({ ok: true });
  });

  it('expired: upload only inside the 72 h grace, UPLOAD_CLOSED after; a reissue is refused', async () => {
    const a = await ensureLink(T, 'R1', 't5', 'u1', opts());
    const t1 = tokenOf(a.url);
    expect(await resolveDriverLink(t1, opts({ now: new Date('2026-10-06T07:59:59Z') }))).toMatchObject({ ok: true, mode: 'full' });
    expect(await resolveDriverLink(t1, opts({ now: new Date('2026-10-06T08:00:00Z') }))).toMatchObject({ ok: true, mode: 'uploadOnly' });
    expect(await resolveDriverLink(t1, opts({ now: new Date('2026-10-09T08:00:00Z') }))).toMatchObject({ ok: false, status: 410, code: 'UPLOAD_CLOSED' });
    await expect(reissueLink(T, a.linkId, 'u1', null, opts({ now: new Date('2026-10-07T00:00:00Z') }))).rejects.toMatchObject({ details: { code: 'LINK_DAY_OVER' } });
  });

  it('a link whose keyId differs from the current key answers 410 LINK_REPLACED; ensure rewrites it', async () => {
    const a = await ensureLink(T, 'R1', 't5', 'u1', opts());
    const t1 = tokenOf(a.url);
    expect(await resolveDriverLink(t1, opts({ env: ROTATED }))).toMatchObject({ ok: false, status: 410, code: 'LINK_REPLACED', known: true });
    const listed = await listLinks(T, 'R1', opts({ env: ROTATED }));
    expect(listed[0]).toMatchObject({ keyChanged: true, url: null });
    const b = await ensureLink(T, 'R1', 't5', 'u1', opts({ env: ROTATED }));
    expect(b.url).not.toBe(a.url);
    expect(await resolveDriverLink(tokenOf(b.url), opts({ env: ROTATED }))).toMatchObject({ ok: true });
    expect(await resolveDriverLink(t1, opts({ env: ROTATED }))).toMatchObject({ ok: false, status: 404 });
  });

  it('a malformed token is refused with no database work; an inactive company is 404', async () => {
    const a = await ensureLink(T, 'R1', 't5', 'u1', opts());
    const spy = vi.spyOn(fakePrisma.driverLink, 'findFirst');
    expect(await resolveDriverLink('not a token', opts())).toMatchObject({ ok: false, status: 404, known: false });
    expect(await resolveDriverLink(null, opts())).toMatchObject({ ok: false, status: 404 });
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
    row('tenant', T).active = false;
    expect(await resolveDriverLink(tokenOf(a.url), opts())).toMatchObject({ ok: false, status: 404, code: 'LINK_NOT_FOUND', known: true });
  });

  it('writes the audit rows, and never a token, salt or hash in them', async () => {
    const a = await ensureLink(T, 'R1', 't5', 'u1', opts());
    await ensureLink(T, 'R1', 't5', 'u1', opts());
    const b = await reissueLink(T, a.linkId, 'u1', 'driver changed', opts());
    await revokeLink(T, a.linkId, 'u1', null, opts());
    const actions = tables.auditLog.map((r) => r.action);
    expect(actions).toEqual(['DRIVER_LINK_ISSUED', 'DRIVER_LINK_REISSUED', 'DRIVER_LINK_REVOKED']);
    const json = JSON.stringify(tables.auditLog);
    for (const secret of [tokenOf(a.url), tokenOf(b.url), row('driverLink', a.linkId).salt, row('driverLink', a.linkId).tokenHash]) expect(json).not.toContain(secret);
    expect(tables.auditLog[1].afterJson).toMatchObject({ generation: 2, reason: 'driver changed', driverName: 'Salim', truckCode: 'T05' });
  });
});

describe('"used on N phones"', () => {
  const at = (min: number) => new Date(NOW.getTime() + min * 60_000);
  it('writes at most every 5 minutes, and at once for a new phone, up to 5 phones', () => {
    let link = { lastSeenAt: null as Date | null, devicesJson: null as unknown };
    const step = (device: string, min: number) => {
      const u = touchUpdate(link, device, at(min));
      if (u) link = { lastSeenAt: u.lastSeenAt, devicesJson: u.devices };
      return u;
    };
    expect(step('aaaa0001', 0)).not.toBeNull();
    expect(step('aaaa0001', 1)).toBeNull(); // same phone within 5 min: nothing written
    expect(step('aaaa0002', 2)).not.toBeNull(); // a new phone: written at once
    expect(step('aaaa0001', 7)).not.toBeNull(); // 5 min passed
    for (let i = 3; i <= 8; i++) step(`aaaa000${i}`, 10 + i * 6);
    expect((link.devicesJson as unknown[]).length).toBe(MAX_DEVICES);
  });
});

describe('the reissue prompt (spec 4.3)', () => {
  const loads = [
    { id: 'L1', loadNo: 1, status: 'LOCKED', driverId: 'salim', departMin: 430 },
    { id: 'L2', loadNo: 2, status: 'PLANNED', driverId: null, departMin: 760 },
  ];
  it('a link made before any driver was set records the new driver silently', () => {
    expect(reissuePrompt({ driverIdAtIssue: null }, loads, 'L1', 'khalid')).toBe('RECORD');
  });
  it('asks when the earliest open load changes to another driver and nobody else is on the road', () => {
    expect(reissuePrompt({ driverIdAtIssue: 'salim' }, loads, 'L1', 'khalid')).toBe('PROMPT');
    expect(reissuePrompt({ driverIdAtIssue: 'salim' }, loads, 'L1', 'salim')).toBe('NONE');
    expect(reissuePrompt({ driverIdAtIssue: 'salim' }, loads, 'L1', null)).toBe('NONE');
    expect(reissuePrompt({ driverIdAtIssue: 'salim', revoked: true }, loads, 'L1', 'khalid')).toBe('NONE');
    expect(reissuePrompt(null, loads, 'L1', 'khalid')).toBe('NONE');
  });
  it('trip 2 changing while trip 1 is out with the link: no prompt', () => {
    const out = [{ ...loads[0], status: 'DISPATCHED' }, loads[1]];
    expect(earliestOpenLoad(out)?.id).toBe('L1');
    expect(reissuePrompt({ driverIdAtIssue: 'salim' }, out, 'L2', 'khalid')).toBe('NONE');
    // Trip 1 completed: trip 2 is the earliest open load, nobody on the road -> ask.
    const done = [{ ...loads[0], status: 'COMPLETED' }, loads[1]];
    expect(reissuePrompt({ driverIdAtIssue: 'salim' }, done, 'L2', 'khalid')).toBe('PROMPT');
  });
  it('says what happens', () => {
    expect(reissuePromptText('T05', '5 Oct', 'Salim', 'Khalid')).toBe(
      'The driver link for T05 on 5 Oct was made for Salim. Reissue it for Khalid? Printed sheets and WhatsApp messages already sent for T05 stop working: print or send again.',
    );
  });
});

describe('driverActor (audit wording)', () => {
  const load = { truckCode: 'T05', date: '2026-10-05', driverId: 'salim', driverName: 'Salim' };
  it('names the driver, the truck-day and the link generation; never the phone (audit rows outlive the location retention)', () => {
    expect(driverActor({ generation: 2, driverIdAtIssue: 'salim', driverNameAtIssue: 'Salim' }, load)).toBe('Driver link: Salim (T05, 5 Oct) · link #2');
    expect(driverActor({ generation: 1, driverIdAtIssue: 'salim', driverNameAtIssue: 'Salim' }, { ...load, driverId: 'khalid', driverName: 'Khalid' })).toBe(
      'Driver link: Khalid (T05, 5 Oct) · link #1 made for Salim',
    );
    expect(driverActor({ generation: 1, driverIdAtIssue: null }, load)).toBe('Driver link: Salim (T05, 5 Oct) · link #1 made before a driver was set');
  });
});
