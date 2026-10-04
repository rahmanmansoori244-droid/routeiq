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

import { clearIdleCasualDrivers, JANITOR_BATCH, JANITOR_MAX_BATCHES, purgeOldLocations, purgeOldPhotos, runDeliveryJanitor } from '@/lib/jobs/delivery-janitor';
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
