/**
 * "Pin may be wrong" (owner request 4 Oct 2026, spec section 11.2): 2 of the last 3 visits with
 * evidence more than 150 m from the planned pin (or the driver said wrong location); evidence = photos
 * with an OK position, else a manual arrival, else the result point, each with an accuracy of 100 m or
 * better; unverified visits and visits planned at an older pin are left out; after the location
 * retention the stored distances still count. Synthetic customers only (ACME, BETA).
 */
import { describe, expect, it } from 'vitest';
import { evidenceOf, PIN_CHECK_RULE_TEXT, pinCheck, pinFarText, suggestedMapsUrl, type PinVisit } from '@/lib/delivery/pin-check';

const PIN = { lat: 23.6, lng: 58.4 };
/** A point `m` metres north of the pin (1 degree of latitude is about 111,195 m). */
const north = (m: number) => ({ lat: PIN.lat + m / 111_195, lng: PIN.lng });

const visit = (id: string, date: string, over: Partial<PinVisit> = {}): PinVisit => ({
  visitId: id,
  customerId: 'ACME',
  deliveryDate: date,
  plannedLat: PIN.lat,
  plannedLng: PIN.lng,
  timingSuspect: false,
  reason: null,
  photos: [],
  manualArrival: null,
  result: null,
  ...over,
});
const photo = (m: number, over: Record<string, unknown> = {}) => ({ ...north(m), accuracyM: 10, distanceM: m, positionStatus: 'OK', ...over });
const pins = new Map([['ACME', PIN]]);

describe('pin check (spec 11.2)', () => {
  it('2 of the last 3 visits with evidence more than 150 m away flag the customer, with the suggested point', () => {
    const vs = [visit('v1', '2026-10-01', { photos: [photo(400)] }), visit('v2', '2026-10-02', { photos: [photo(20)] }), visit('v3', '2026-10-03', { photos: [photo(420)] })];
    const [f] = pinCheck(vs, pins);
    expect(f!.customerId).toBe('ACME');
    expect(f!.far.map((x) => [x.date, x.distanceM])).toEqual([
      ['2026-10-03', 420],
      ['2026-10-01', 400],
    ]);
    expect(f!.suggested!.lat).toBeCloseTo(north(410).lat, 6);
    expect(suggestedMapsUrl(f!.suggested!)).toMatch(/^https:\/\/www\.google\.com\/maps\/search\/\?api=1&query=23\.60\d+,58\.400000$/);
    // Only one far visit among the last three: not flagged.
    expect(pinCheck([...vs, visit('v4', '2026-10-04', { photos: [photo(10)] })], pins)).toEqual([]);
    // 150 m is not far; 151 m is.
    expect(pinCheck([visit('a', '2026-10-01', { photos: [photo(150)] }), visit('b', '2026-10-02', { photos: [photo(150)] })], pins)).toEqual([]);
    expect(pinCheck([visit('a', '2026-10-01', { photos: [photo(151)] }), visit('b', '2026-10-02', { photos: [photo(151)] })], pins)).toHaveLength(1);
  });

  it('only photos with an OK position; else a manual arrival, else the result; all with an accuracy of 100 m or better', () => {
    expect(evidenceOf(visit('x', '2026-10-01', { photos: [photo(400, { positionStatus: 'POOR', accuracyM: 300 })] }))).toBeNull();
    expect(evidenceOf(visit('x', '2026-10-01', { photos: [photo(400, { accuracyM: 150 })] }))).toBeNull();
    // EXIF when the Geolocation point is missing.
    expect(evidenceOf(visit('x', '2026-10-01', { photos: [{ lat: null, lng: null, accuracyM: null, distanceM: null, positionStatus: 'OK', exifLat: north(300).lat, exifLng: PIN.lng }] }))!.distanceM).toBeCloseTo(300, 0);
    const arrival = { ...north(200), accuracyM: 20, distanceM: 200 };
    const result = { ...north(30), accuracyM: 20, distanceM: 30 };
    expect(evidenceOf(visit('x', '2026-10-01', { manualArrival: arrival, result }))).toMatchObject({ source: 'ARRIVAL' });
    expect(evidenceOf(visit('x', '2026-10-01', { manualArrival: { ...arrival, accuracyM: 250 }, result }))).toMatchObject({ source: 'RESULT' });
    expect(evidenceOf(visit('x', '2026-10-01', { photos: [photo(500)], manualArrival: arrival }))).toMatchObject({ source: 'PHOTO' });
    // The median of several photo points.
    expect(evidenceOf(visit('x', '2026-10-01', { photos: [photo(100), photo(300), photo(500)] }))!.distanceM).toBeCloseTo(300, 0);
  });

  it('unverified visits and visits planned at an older pin are left out; "wrong location" counts', () => {
    const far = (id: string, d: string, over: Partial<PinVisit> = {}) => visit(id, d, { photos: [photo(400)], ...over });
    expect(pinCheck([far('a', '2026-10-01', { timingSuspect: true }), far('b', '2026-10-02')], pins)).toEqual([]);
    const old = { plannedLat: north(500).lat, plannedLng: PIN.lng };
    expect(pinCheck([far('a', '2026-10-01', old), far('b', '2026-10-02')], pins)).toEqual([]);
    const said = pinCheck([visit('a', '2026-10-01', { reason: 'WRONG_LOCATION' }), far('b', '2026-10-03')], pins);
    expect(said).toHaveLength(1);
    expect(said[0]!.wrongLocationDates).toEqual(['2026-10-01']);
    expect(said[0]!.far.find((x) => x.wrongLocation)!.distanceM).toBeNull();
  });

  it('after the location retention the stored distances still count, but only kept points build the suggestion', () => {
    const purged = (id: string, d: string) => visit(id, d, { photos: [{ lat: null, lng: null, accuracyM: null, distanceM: 380, positionStatus: 'OK', purged: true }] });
    const flags = pinCheck([purged('a', '2026-07-01'), purged('b', '2026-07-02')], pins);
    expect(flags).toHaveLength(1);
    expect(flags[0]!.far.map((x) => x.distanceM)).toEqual([380, 380]);
    expect(flags[0]!.suggested).toBeNull();
    const mixed = pinCheck([purged('a', '2026-07-01'), visit('b', '2026-10-02', { photos: [photo(400)] })], pins);
    expect(mixed[0]!.suggested!.lat).toBeCloseTo(north(400).lat, 6);
  });
});

describe('pin check: the words (review of 4 Oct 2026)', () => {
  it('one "wrong location" report alone does not flag; the rule text says "at least 2 of the last 3"', () => {
    const near = (id: string, d: string) => visit(id, d, { photos: [photo(20)] });
    expect(pinCheck([near('a', '2026-10-01'), near('b', '2026-10-02'), visit('c', '2026-10-03', { reason: 'WRONG_LOCATION', photos: [photo(20)] })], pins)).toEqual([]);
    expect(PIN_CHECK_RULE_TEXT).toMatch(/at least 2 of the last 3 visits/);
  });

  it('a reported visit is listed as "wrong location", never with the near distance of its photos', () => {
    const fmt = (iso: string) => iso.slice(5);
    expect(
      pinFarText(
        [
          { date: '2026-10-03', distanceM: 20, wrongLocation: true },
          { date: '2026-10-01', distanceM: 412, wrongLocation: false },
          { date: '2026-09-28', distanceM: null, wrongLocation: false },
        ],
        fmt,
      ),
    ).toBe('wrong location (10-03), 412 m (10-01)');
  });

  it('many visits of many customers are grouped in one pass (no copy per visit)', () => {
    const many: PinVisit[] = [];
    for (let c = 0; c < 200; c++) for (let i = 0; i < 100; i++) many.push({ ...visit(`v${c}-${i}`, `2026-0${1 + (i % 9)}-1${i % 10}`, { photos: [photo(10)] }), customerId: `C${c}` });
    const t0 = Date.now();
    expect(pinCheck(many, new Map())).toEqual([]);
    expect(Date.now() - t0).toBeLessThan(2000);
  });
});
