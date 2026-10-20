/**
 * The delivery retention janitor (owner request 4 Oct 2026, spec section 12.4), on the in-memory
 * database (fake-plan-db.ts): photo bytes purged by the SERVER receipt time (never the phone's
 * capture time), positions / IPs / browser ids erased after the location retention with every
 * distance kept, the location retention capped at the photo retention, idle daily drivers hidden at
 * 30 days and their phone erased later, the batch size and loop bound, one audit row per sweep that
 * changed something. Synthetic data only.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fakePrisma, rawLog, resetDb, row, tables } from './fake-plan-db';

vi.mock('@/lib/db', async () => ({ prisma: (await import('./fake-plan-db')).fakePrisma }));
vi.mock('@/lib/audit', async () => {
  const m = await import('./fake-plan-db');
  return { audit: vi.fn(async (input: Record<string, unknown>) => m.fakePrisma.auditLog.create({ data: { ...input } })) };
});

import { alertRowsKeptForAnalysis, clearIdleCasualDrivers, JANITOR_BATCH, JANITOR_MAX_BATCHES, purgeOldAlerts, purgeOldLocations, purgeOldPhotos, runDeliveryJanitor } from '@/lib/jobs/delivery-janitor';
import { readDevices, touchUpdate } from '@/lib/driver-link/service';

const NOW = new Date('2026-10-04T08:00:00Z');
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 24 * 60 * 60_000);
const day = (iso: string) => new Date(`${iso}T00:00:00Z`);

beforeEach(() => {
  resetDb();
  tables.tenantConfig = [{ tenantId: 'tA', photoRetentionDays: 365, locationRetentionDays: 90, timezone: 'Asia/Muscat' }];
  tables.auditLog = [];
});

describe('photo bytes (spec 12.4)', () => {
  it('purged by the server receipt time: a capture time in 2031 is still purged, a 2020 capture received today is kept', async () => {
    tables.deliveryPhoto = [
      { id: 'old', tenantId: 'tA', receivedAt: daysAgo(400), takenAt: new Date('2031-01-01T00:00:00Z'), bytes: Buffer.from([1]), purgedAt: null, distanceM: 30 },
      { id: 'new', tenantId: 'tA', receivedAt: daysAgo(1), takenAt: new Date('2020-01-01T00:00:00Z'), bytes: Buffer.from([2]), purgedAt: null, distanceM: 40 },
    ];
    expect(await purgeOldPhotos(NOW)).toEqual({ count: 1 });
    expect(row('deliveryPhoto', 'old')).toMatchObject({ bytes: null, purgedAt: NOW, distanceM: 30 });
    expect(row('deliveryPhoto', 'new').bytes).not.toBeNull();
    expect(tables.auditLog.map((a) => [a.action, a.entity, a.afterJson])).toEqual([['DELIVERY_PHOTOS_PURGED', 'Tenant', { count: 1, olderThanDays: 365 }]]);
    // Nothing more to do: no second audit row.
    expect(await purgeOldPhotos(NOW)).toEqual({ count: 0 });
    expect(tables.auditLog).toHaveLength(1);
  });

  it('works in batches of 200, at most 5 batches per sweep', async () => {
    tables.deliveryPhoto = Array.from({ length: JANITOR_BATCH * JANITOR_MAX_BATCHES + 7 }, (_, i) => ({ id: `p${i}`, tenantId: 'tA', receivedAt: daysAgo(500), bytes: Buffer.from([1]), purgedAt: null }));
    // The in-memory database ignores `take`: honour it here, and count the batches.
    const orig = fakePrisma.deliveryPhoto.findMany;
    let batches = 0;
    fakePrisma.deliveryPhoto.findMany = async (a: { take?: number }) => {
      batches++;
      return (await orig(a)).slice(0, a.take ?? undefined);
    };
    try {
      expect(await purgeOldPhotos(NOW)).toEqual({ count: 1000 });
      expect(batches).toBe(JANITOR_MAX_BATCHES);
      expect(await purgeOldPhotos(NOW)).toEqual({ count: 7 });
    } finally {
      fakePrisma.deliveryPhoto.findMany = orig;
    }
  });
});

describe('positions, IPs and browser ids (spec 12.4)', () => {
  it('erased after the location retention; every distance kept; gpsAt removed from the payload', async () => {
    tables.stopEvent = [
      { id: 'e1', tenantId: 'tA', receivedAt: daysAgo(100), lat: 23.6, lng: 58.4, accuracyM: 8, speedMps: 0, clientIp: '10.1.1.1', deviceId: 'abcd', distanceM: 12, payloadJson: { gpsAt: 'x', late: true } },
      { id: 'e2', tenantId: 'tA', receivedAt: daysAgo(100), lat: 23.6, lng: 58.4, accuracyM: 8, speedMps: null, clientIp: null, deviceId: null, distanceM: 15, payloadJson: { mode: 'AUTO' } },
      { id: 'e3', tenantId: 'tA', receivedAt: daysAgo(10), lat: 23.6, lng: 58.4, accuracyM: 8, clientIp: '10.1.1.1', deviceId: 'abcd', distanceM: 9, payloadJson: null },
    ];
    tables.stopVisit = [
      { id: 'v1', tenantId: 'tA', deliveryDate: day('2026-06-01'), locationPurgedAt: null, outcomeLat: 23.6, outcomeLng: 58.4, outcomeAccuracyM: 5, arrivalAccuracyM: 6, outcomeDistanceM: 20, arrivalDistanceM: 11 },
      { id: 'v2', tenantId: 'tA', deliveryDate: day('2026-10-01'), locationPurgedAt: null, outcomeLat: 23.6, outcomeLng: 58.4, outcomeAccuracyM: 5, arrivalAccuracyM: 6 },
    ];
    tables.deliveryPhoto = [
      { id: 'p1', tenantId: 'tA', receivedAt: daysAgo(100), locationPurgedAt: null, lat: 23.6, lng: 58.4, accuracyM: 5, exifLat: 23.6, exifLng: 58.4, clientIp: '1.2.3.4', deviceId: 'abcd', distanceM: 30, exifDistanceM: 31 },
    ];
    const res = await purgeOldLocations(NOW);
    expect(res).toEqual({ events: 2, visits: 1, photos: 1, links: 0 });
    expect(row('stopEvent', 'e1')).toMatchObject({ lat: null, lng: null, accuracyM: null, speedMps: null, clientIp: null, deviceId: null, distanceM: 12, payloadJson: { late: true } });
    expect(row('stopEvent', 'e2')).toMatchObject({ lat: null, distanceM: 15, payloadJson: { mode: 'AUTO' } });
    expect(row('stopEvent', 'e3')).toMatchObject({ lat: 23.6, clientIp: '10.1.1.1' });
    expect(row('stopVisit', 'v1')).toMatchObject({ outcomeLat: null, outcomeLng: null, outcomeAccuracyM: null, arrivalAccuracyM: null, locationPurgedAt: NOW, outcomeDistanceM: 20, arrivalDistanceM: 11 });
    expect(row('stopVisit', 'v2').outcomeLat).toBe(23.6);
    expect(row('deliveryPhoto', 'p1')).toMatchObject({ lat: null, lng: null, accuracyM: null, exifLat: null, exifLng: null, clientIp: null, deviceId: null, distanceM: 30, exifDistanceM: 31, locationPurgedAt: NOW });
    expect(tables.auditLog.map((a) => [a.action, a.afterJson])).toEqual([['DELIVERY_LOCATIONS_PURGED', { count: 4, events: 2, visits: 1, photos: 1, links: 0, olderThanDays: 90 }]]);
  });

  it('the browser ids on driver links (devicesJson) are erased after the location retention; "used on N phones" keeps its count', async () => {
    // The statement runs on PostgreSQL (jsonb): here only that it is sent, per company, for links
    // whose delivery date is older than the retention, and the erased form the link dialog reads.
    rawLog.length = 0;
    await purgeOldLocations(NOW);
    const sql = rawLog.filter((s) => s.includes('UPDATE "DriverLink"'));
    expect(sql).toHaveLength(1);
    expect(sql[0]).toMatch(/"tenantId" = \? AND "deliveryDate" < \?::date/);
    expect(sql[0]).toMatch(/jsonb_set\(e, '\{device\}', '""'::jsonb\)/);
    const erased = [
      { device: '', first: '2026-06-01T05:00:00.000Z', last: '2026-06-01T09:00:00.000Z' },
      { device: '', first: '2026-06-01T06:00:00.000Z', last: '2026-06-01T06:10:00.000Z' },
    ];
    expect(readDevices(erased)).toHaveLength(2);
    // A phone seen after the erase (never: the link expired long before) would not match an erased entry.
    expect(touchUpdate({ lastSeenAt: null, devicesJson: erased }, 'ab12cd34', NOW)!.devices).toHaveLength(3);
  });

  it('the location retention is never longer than the photo retention', async () => {
    tables.tenantConfig = [{ tenantId: 'tA', photoRetentionDays: 60, locationRetentionDays: 200, timezone: 'Asia/Muscat' }];
    tables.stopEvent = [{ id: 'e1', tenantId: 'tA', receivedAt: daysAgo(70), lat: 23.6, lng: 58.4, distanceM: 3, payloadJson: null }];
    expect((await purgeOldLocations(NOW)).events).toBe(1);
    expect(tables.auditLog[0]!.afterJson).toMatchObject({ olderThanDays: 60 });
  });
});

describe('idle daily drivers (spec 12.4)', () => {
  it('hidden after 30 days without a load, phone erased after the location retention; regular drivers never touched', async () => {
    tables.driver = [
      { id: 'd1', tenantId: 'tA', casual: true, active: true, phone: '+968 9000 0001' },
      { id: 'd2', tenantId: 'tA', casual: true, active: true, phone: '+968 9000 0002' },
      { id: 'd3', tenantId: 'tA', casual: true, active: false, phone: '+968 9000 0003' },
      { id: 'd4', tenantId: 'tA', casual: false, active: true, phone: '+968 9000 0004' },
      { id: 'd5', tenantId: 'tA', casual: true, active: true, phone: '+968 9000 0005' },
    ];
    tables.planLoad = [
      { id: 'l1', tenantId: 'tA', driverId: 'd1', run: { runDate: day('2026-09-25') } },
      { id: 'l2', tenantId: 'tA', driverId: 'd2', run: { runDate: day('2026-08-20') } },
      { id: 'l3', tenantId: 'tA', driverId: 'd3', run: { runDate: day('2026-05-01') } },
      { id: 'l4', tenantId: 'tA', driverId: 'd4', run: { runDate: day('2026-01-01') } },
    ];
    // d5 is on no load: counted from the day it was added.
    tables.auditLog = [{ id: 'a0', tenantId: 'tA', action: 'CASUAL_DRIVER_ADDED', entityId: 'd5', createdAt: new Date('2026-08-01T05:00:00Z') }];
    expect(await clearIdleCasualDrivers(NOW)).toEqual({ deactivated: 2, phonesCleared: 1 });
    expect(row('driver', 'd1')).toMatchObject({ active: true, phone: '+968 9000 0001' });
    expect(row('driver', 'd2')).toMatchObject({ active: false, phone: '+968 9000 0002' });
    expect(row('driver', 'd3')).toMatchObject({ active: false, phone: null });
    expect(row('driver', 'd4')).toMatchObject({ active: true, phone: '+968 9000 0004' });
    expect(row('driver', 'd5')).toMatchObject({ active: false });
    expect(tables.auditLog.filter((a) => a.action === 'CASUAL_DRIVERS_CLEARED').map((a) => a.afterJson)).toEqual([{ deactivated: 2, phonesCleared: 1, idleDays: 30, phoneAfterDays: 90 }]);
  });

  it('the loop runs the sweeps at most every 10 min (the cron route forces them)', async () => {
    const first = await runDeliveryJanitor(NOW, { force: true });
    expect(first).toMatchObject({ photos: { count: 0 } });
    expect(await runDeliveryJanitor(new Date(NOW.getTime() + 60_000))).toBeNull();
    expect(await runDeliveryJanitor(new Date(NOW.getTime() + 11 * 60_000))).not.toBeNull();
  });
});

describe('operations alerts retention (owner request 16 Oct 2026; cause & action, owner request 20 Oct 2026)', () => {
  /**
   * The in-memory database logs raw SQL only: apply the details removal (store.ts purgeOldAlertRows) to the alert
   * rows and the free-text removal (inbox.ts scrubReviewAuditTexts) to the audit rows, and keep each call's values.
   */
  const rawCalls: { sql: string; values: unknown[] }[] = [];
  function applyRaw() {
    const orig = fakePrisma.$executeRaw;
    rawCalls.length = 0;
    fakePrisma.$executeRaw = async (strings: TemplateStringsArray, ...values: unknown[]) => {
      await orig(strings, ...values);
      const sql = strings.join('?').replace(/\s+/g, ' ').trim();
      rawCalls.push({ sql, values });
      let n = 0;
      if (sql.startsWith('UPDATE "OpsAlert"')) {
        const [now, tenantId, cutoffIso] = values as [Date, string, string];
        for (const r of tables.opsAlert ?? []) {
          if (r.tenantId !== tenantId || !(r.deliveryDate < day(cutoffIso)) || r.detailsRemovedAt) continue;
          Object.assign(r, { text: '', factsJson: r.factsJson?.gps === true ? { gps: true } : null, emailError: null, reviewNote: null, reviewCauseOther: null, reviewActionOther: null, detailsRemovedAt: now });
          n++;
        }
      }
      if (sql.startsWith('UPDATE "AuditLog"')) {
        const [keys, , tenantId, actions, cutoffIso] = values as [string[], string[], string, string[], string];
        const has = (j: any) => !!j && typeof j === 'object' && keys.some((k) => k in j);
        const drop = (j: any) => (j && typeof j === 'object' ? Object.fromEntries(Object.entries(j).filter(([k]) => !keys.includes(k))) : j);
        for (const a of tables.auditLog ?? []) {
          if (a.tenantId !== tenantId || a.entity !== 'OpsAlert' || !actions.includes(a.action) || !(a.afterJson?.deliveryDate < cutoffIso)) continue;
          if (!has(a.afterJson) && !has(a.beforeJson)) continue;
          Object.assign(a, { beforeJson: drop(a.beforeJson), afterJson: drop(a.afterJson) });
          n++;
        }
      }
      return n;
    };
    return () => void (fakePrisma.$executeRaw = orig);
  }
  const reviewAudit = (id: string, tenantId: string, deliveryDate: string, extra: Record<string, unknown> = {}) => ({
    id,
    tenantId,
    action: 'ALERT_REVIEW_SAVED',
    entity: 'OpsAlert',
    entityId: `alert-${id}`,
    beforeJson: { cause: 'TRAFFIC', action: 'CALLED_DRIVER', followUp: false, causeOther: null, actionOther: null, note: 'Gate closed, sales agreed a new slot', noteChars: 35 },
    afterJson: { rule: 'ETA_LATE', deliveryDate, cause: 'OTHER', causeOther: 'Road closed', causeOtherChars: 11, action: 'CALLED_DRIVER', actionOther: null, note: 'Driver late', noteChars: 11 },
    ...extra,
  });

  it('owner decision pending (finding 4): by default every alert row older than 90 days is deleted as before, with or without a cause & action; no row is kept or changed', async () => {
    const restore = applyRaw();
    try {
      tables.opsAlert = [
        { id: 'reviewed-old', tenantId: 'tA', deliveryDate: day('2026-07-05'), resolvedAt: day('2026-07-05'), text: 'T05 L1', reviewedAt: new Date('2026-07-05T08:00:00Z'), reviewCause: 'TRAFFIC' },
        // The review's case: an alert nobody reviewed, 100 days old, still open (alerts were off).
        { id: 'plain-old', tenantId: 'tA', deliveryDate: day('2026-06-26'), resolvedAt: null, text: 'T07 L1 is running late' },
        { id: 'edge', tenantId: 'tA', deliveryDate: day('2026-07-06'), resolvedAt: null, text: 'kept as it is' },
        { id: 'new', tenantId: 'tA', deliveryDate: day('2026-10-03'), text: 'today' },
        { id: 'other', tenantId: 'tB', deliveryDate: day('2024-01-01'), text: 'another company' },
      ];
      tables.opsAlertDigest = [
        { id: 'd-old', tenantId: 'tA', createdAt: daysAgo(91) },
        { id: 'd-new', tenantId: 'tA', createdAt: daysAgo(10) },
      ];
      // Today in Muscat is 4 Oct 2026: the cutoff is 6 Jul.
      expect(await purgeOldAlerts(NOW, undefined, {} as NodeJS.ProcessEnv)).toEqual({ alerts: 2, reviewed: 1, closed: 0, detailsRemoved: 0, digests: 1, auditTexts: 0 });
      expect(tables.opsAlert.map((a) => a.id)).toEqual(['edge', 'new', 'other']);
      expect(tables.opsAlert.find((a) => a.id === 'edge')).toMatchObject({ text: 'kept as it is', resolvedAt: null });
      expect(tables.opsAlertDigest.map((a) => a.id)).toEqual(['d-new']);
      expect(rawLog.filter((s) => s.startsWith('UPDATE "OpsAlert"'))).toEqual([]);
      expect(tables.auditLog.map((a) => [a.action, a.afterJson])).toEqual([
        ['OPS_ALERTS_PURGED', { deleted: 2, deletedWithCauseAndAction: 1, closedAsExpired: 0, detailsRemoved: 0, auditTextsRemoved: 0, detailsAfterDays: 90, rowsAfterDays: 90 }],
      ]);
    } finally {
      restore();
    }
    // The switch: only ALERT_KEEP_FOR_ANALYSIS=1 keeps rows past 90 days.
    const env = (v?: string) => (v === undefined ? {} : { ALERT_KEEP_FOR_ANALYSIS: v }) as unknown as NodeJS.ProcessEnv;
    expect([alertRowsKeptForAnalysis(env()), alertRowsKeptForAnalysis(env('1')), alertRowsKeptForAnalysis(env('true')), alertRowsKeptForAnalysis(env('0'))]).toEqual([false, true, false, false]);
  });

  it('finding 2: the cause & action audit rows of alerts older than 90 days lose their free texts (note, Other texts), keeping the codes and lengths; newer ones, other companies and other audit rows stay', async () => {
    const restore = applyRaw();
    try {
      tables.opsAlert = [];
      tables.auditLog = [
        reviewAudit('old', 'tA', '2026-07-05'),
        reviewAudit('removed', 'tA', '2026-07-01', { action: 'ALERT_REVIEW_REMOVED', afterJson: { rule: 'ETA_LATE', deliveryDate: '2026-07-01' } }),
        reviewAudit('edge', 'tA', '2026-07-06'),
        reviewAudit('foreign', 'tB', '2026-01-01'),
        { id: 'unrelated', tenantId: 'tA', action: 'ORDER_CANCELLED', entity: 'OpsAlert', beforeJson: null, afterJson: { deliveryDate: '2026-01-01', note: 'kept' } },
      ];
      const r = await purgeOldAlerts(NOW, undefined, {} as NodeJS.ProcessEnv);
      expect(r.auditTexts).toBe(2);
      const scrub = rawCalls.find((c) => c.sql.startsWith('UPDATE "AuditLog"'))!;
      expect(scrub.sql).toMatch(/"beforeJson" = CASE WHEN jsonb_typeof\("beforeJson"\) = 'object' THEN "beforeJson" - \?::text\[\]/);
      expect(scrub.sql).toMatch(/"action" = ANY\(\?::text\[\]\) .*\("afterJson"->>'deliveryDate'\) < \?/);
      const keys = ['causeOther', 'actionOther', 'note'];
      // By the company's own today (4 Oct in Muscat) - 90 days.
      expect(scrub.values).toEqual([keys, keys, 'tA', ['ALERT_REVIEW_SAVED', 'ALERT_REVIEW_REMOVED'], '2026-07-06', keys, keys]);
      const a = (id: string) => tables.auditLog.find((x) => x.id === id)!;
      expect(a('old').beforeJson).toEqual({ cause: 'TRAFFIC', action: 'CALLED_DRIVER', followUp: false, noteChars: 35 });
      expect(a('old').afterJson).toEqual({ rule: 'ETA_LATE', deliveryDate: '2026-07-05', cause: 'OTHER', causeOtherChars: 11, action: 'CALLED_DRIVER', noteChars: 11 });
      expect(a('removed').beforeJson).not.toHaveProperty('note');
      expect(a('edge').afterJson).toMatchObject({ note: 'Driver late', causeOther: 'Road closed' });
      expect(a('foreign').afterJson).toMatchObject({ note: 'Driver late' });
      expect(a('unrelated').afterJson).toEqual({ deliveryDate: '2026-01-01', note: 'kept' });
      expect(tables.auditLog.filter((x) => x.action === 'OPS_ALERTS_PURGED').map((x) => x.afterJson)).toEqual([
        { deleted: 0, deletedWithCauseAndAction: 0, closedAsExpired: 0, detailsRemoved: 0, auditTextsRemoved: 2, detailsAfterDays: 90, rowsAfterDays: 90 },
      ]);
    } finally {
      restore();
    }
  });

  it('with ALERT_KEEP_FOR_ANALYSIS=1: after 90 days a row loses its text, facts and free texts (a row still open is closed first); it is deleted after the analysis retention; e-mail records after 90 days; one audit row of counts', async () => {
    const restore = applyRaw();
    vi.stubEnv('ALERT_KEEP_FOR_ANALYSIS', '1');
    try {
      const saved = new Date('2024-10-01T08:00:00Z');
      tables.opsAlert = [
        { id: 'ancient', tenantId: 'tA', deliveryDate: day('2024-10-03'), resolvedAt: saved, text: 'T05 L1', reviewedAt: saved, reviewCause: 'TRAFFIC' },
        { id: 'old', tenantId: 'tA', deliveryDate: day('2026-07-05'), resolvedAt: day('2026-07-05'), text: 'T05 L1 stop 2 Shop Example (TST0001)', factsJson: { gps: true, awayMin: 4 }, reviewedAt: saved, reviewCause: 'OTHER', reviewCauseOther: 'Gate locked', reviewNote: 'Waited', emailError: 'HTTP 500' },
        { id: 'open-old', tenantId: 'tA', deliveryDate: day('2026-07-01'), resolvedAt: null, resolvedReason: null, text: 'T05 L1 is running late', factsJson: { delayMin: 40 } },
        { id: 'edge', tenantId: 'tA', deliveryDate: day('2026-07-06'), resolvedAt: null, text: 'kept as it is' },
        { id: 'new', tenantId: 'tA', deliveryDate: day('2026-10-03'), text: 'today' },
        { id: 'other', tenantId: 'tB', deliveryDate: day('2024-01-01'), text: 'another company' },
      ];
      tables.opsAlertDigest = [
        { id: 'd-old', tenantId: 'tA', createdAt: daysAgo(91) },
        { id: 'd-new', tenantId: 'tA', createdAt: daysAgo(10) },
      ];
      // Today in Muscat is 4 Oct 2026: details go before 6 Jul 2026, rows before 4 Oct 2024 (730 days, the default).
      expect(await purgeOldAlerts(NOW)).toEqual({ alerts: 1, reviewed: 1, closed: 1, detailsRemoved: 2, digests: 1, auditTexts: 0 });
      expect(tables.opsAlert.map((a) => a.id)).toEqual(['old', 'open-old', 'edge', 'new', 'other']);
      const byId = (id: string) => tables.opsAlert.find((a) => a.id === id)!;
      expect(byId('old')).toMatchObject({ text: '', factsJson: { gps: true }, reviewCause: 'OTHER', reviewCauseOther: null, reviewNote: null, emailError: null, detailsRemovedAt: NOW });
      expect(byId('open-old')).toMatchObject({ resolvedAt: NOW, resolvedReason: 'EXPIRED', text: '', factsJson: null, detailsRemovedAt: NOW });
      expect(byId('edge')).toMatchObject({ text: 'kept as it is', resolvedAt: null });
      expect(byId('other').text).toBe('another company');
      expect(tables.opsAlertDigest.map((a) => a.id)).toEqual(['d-new']);
      expect(rawLog.find((s) => s.startsWith('UPDATE "OpsAlert"'))).toMatch(/"text" = '', "factsJson" = CASE .* "reviewNote" = NULL, "reviewCauseOther" = NULL, "reviewActionOther" = NULL, "detailsRemovedAt" = \?/);
      // The rows now hold the office's own input: one audit row of counts (no text).
      expect(tables.auditLog.map((a) => [a.action, a.entity, a.afterJson])).toEqual([
        ['OPS_ALERTS_PURGED', 'Tenant', { deleted: 1, deletedWithCauseAndAction: 1, closedAsExpired: 1, detailsRemoved: 2, auditTextsRemoved: 0, detailsAfterDays: 90, rowsAfterDays: 730 }],
      ]);
      // The janitor runs it once a day with the daily drivers; nothing more to do: no second audit row.
      const r = await runDeliveryJanitor(new Date(NOW.getTime() + 60 * 60_000), { force: true });
      expect(r).toMatchObject({ alerts: { alerts: 0, detailsRemoved: 0, digests: 0 } });
      expect(tables.auditLog.filter((a) => a.action === 'OPS_ALERTS_PURGED')).toHaveLength(1);
    } finally {
      vi.unstubAllEnvs();
      restore();
    }
  });

  it('with ALERT_KEEP_FOR_ANALYSIS=1, a company that keeps its analysis data less than 90 days: the alert rows still go at 90 days, as before (never sooner)', async () => {
    tables.tenantConfig = [{ tenantId: 'tA', photoRetentionDays: 365, locationRetentionDays: 90, analysisRetentionDays: 30, timezone: 'Asia/Muscat' }];
    tables.opsAlert = [
      { id: 'old', tenantId: 'tA', deliveryDate: day('2026-07-05'), reviewedAt: new Date('2026-07-05T08:00:00Z') },
      { id: 'edge', tenantId: 'tA', deliveryDate: day('2026-07-06') },
    ];
    expect(await purgeOldAlerts(NOW, undefined, { ALERT_KEEP_FOR_ANALYSIS: '1' } as unknown as NodeJS.ProcessEnv)).toMatchObject({ alerts: 1, reviewed: 1, closed: 0, detailsRemoved: 0 });
    expect(tables.opsAlert.map((a) => a.id)).toEqual(['edge']);
    expect(rawLog.filter((s) => s.startsWith('UPDATE "OpsAlert"'))).toEqual([]);
  });

  it('review L3: a failing alert purge is logged under its own name and stops nothing after it', async () => {
    const spy = vi.spyOn(fakePrisma.opsAlert, 'deleteMany').mockRejectedValue(new Error('db down'));
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const r = await runDeliveryJanitor(new Date(NOW.getTime() + 2 * 60 * 60_000), { force: true });
      expect(r).toMatchObject({ alerts: null, casual: expect.any(Object) });
      expect(err).toHaveBeenCalledWith('[janitor] alert retention not run', { error: 'db down' });
    } finally {
      spy.mockRestore();
      err.mockRestore();
    }
  });
});
