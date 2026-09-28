/**
 * Location input parsing (pure) and short-link resolution (injected fetch - no network).
 */
import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_SERVICE_AREA,
  isGoogleMapsHost,
  isShortMapsLink,
  parseLocationInput,
  pinRequiredMessage,
  resolveLocationInput,
} from '@/lib/dispatch/location-input';
import { IMPORT_REASON, readImportedPair } from '@/lib/dispatch/import-location';

const LAT = 23.5859;
const LNG = 58.4059;

// Place URL whose map centre (@) differs from the pin (!3d!4d) - the pin must win.
const PLACE_URL =
  'https://www.google.com/maps/place/Lulu+Hypermarket+Bawshar/@23.5800,58.3900,17z/data=!3m1!4b1!4m6!3m5!1s0x3e91ff:0x1!8m2!3d23.5859!4d58.4059!16s%2Fg%2F11';

// A5 fourth review. The owner's rule: a reading that is not exact is saved only as a pin placed by
// hand, and ADD LOCATION keeps Save off until then. Its notes said "Confirm the pin", "Please confirm
// on the map" or "move the pin if needed", which the dialog does not allow. The warnings now say what
// is wrong with the reading; the dialog's own note says what to do (drop the pin by hand).
describe('parseLocationInput - a reading that needs a pin never asks to confirm it', () => {
  it.each([
    ['fewer than 4 decimals', '23.585, 58.4059', /fewer than 4 decimals/],
    ['a map-centre link', 'https://www.google.com/maps/@23.5859,58.4059,17z', /map centre, not a pin/],
    ['an ?ll= link', 'https://maps.google.com/maps?ll=23.5859,58.4059&z=16', /map centre, not a pin/],
    ['swapped', '58.4059, 23.5859', /swapped/],
    ['outside the delivery area', '19.0760, 72.8777', /outside the delivery area/],
    ['degrees and minutes only', `23°35'N 58°24'E`, /no seconds/],
    ['whole degrees only', '23°N 58°E', /Whole degrees only/],
    // A5 sixth review.
    ['a rough pair written as degrees, minutes and seconds', `23°34'48.0"N 58°24'36.0"E`, /written another way: fewer than 4 decimals/],
    ["Google's pin with fewer than 4 decimals", 'https://www.google.com/maps/place/X/data=!3d23.58!4d58.41', /fewer than 4 decimals/],
  ])('%s', (_what, input, says) => {
    const r = parseLocationInput(input);
    expect(r).toMatchObject({ ok: true, needsPin: true });
    expect(r.warnings.join(' ')).toMatch(says);
    // Before: "Confirm the pin.", "Please confirm on the map.", "Confirm it on the map.", "Check the
    // point and move the pin if needed."
    expect(r.warnings.join(' ')).not.toMatch(/confirm|if needed|check the point/i);
  });
});

describe('parseLocationInput - plain coordinates', () => {
  it('reads "lat, lng"', () => {
    const r = parseLocationInput('23.5859, 58.4059');
    expect(r).toMatchObject({ ok: true, lat: LAT, lng: LNG, source: 'MANUAL_LATLNG', confidence: 'HIGH', needsPin: false });
    expect(r.warnings).toEqual([]);
    expect(r.error).toBeUndefined();
  });

  it('reads "lat lng" (space separated), "lat;lng" and signed values', () => {
    expect(parseLocationInput('23.5859 58.4059')).toMatchObject({ ok: true, lat: LAT, lng: LNG, needsPin: false });
    expect(parseLocationInput('23.5859;58.4059')).toMatchObject({ ok: true, lat: LAT, lng: LNG, needsPin: false });
    expect(parseLocationInput('  +23.5859 ,  +58.4059  ')).toMatchObject({ ok: true, lat: LAT, lng: LNG });
  });

  it('rounds to 6 decimals', () => {
    const r = parseLocationInput('23.58591234, 58.40594567');
    expect(r.lat).toBe(23.585912);
    expect(r.lng).toBe(58.405946);
  });

  it('reads DMS exactly as Google copies it', () => {
    const r = parseLocationInput(`23°35'09.2"N 58°24'21.2"E`);
    expect(r.ok).toBe(true);
    expect(r.source).toBe('MANUAL_LATLNG');
    expect(r.needsPin).toBe(false);
    expect(r.lat).toBeCloseTo(23 + 35 / 60 + 9.2 / 3600, 6);
    expect(r.lng).toBeCloseTo(58 + 24 / 60 + 21.2 / 3600, 6);
  });

  it('reads DMS with typographic primes and southern/western hemispheres', () => {
    const r = parseLocationInput('23°35′09.2″N, 58°24′21.2″E');
    expect(r.ok).toBe(true);
    expect(r.lat).toBeCloseTo(23.585889, 5);
    // S/W give negative values (then flagged as outside the service area).
    const sw = parseLocationInput(`33°51'54.5"S 151°12'35.6"W`);
    expect(sw.ok).toBe(true);
    expect(sw.lat).toBeLessThan(0);
    expect(sw.lng).toBeLessThan(0);
    expect(sw.needsPin).toBe(true);
  });

  it('auto-swaps lat/lng that were pasted the wrong way round, but asks for a pin', () => {
    const r = parseLocationInput('58.4059, 23.5859');
    expect(r).toMatchObject({ ok: true, lat: LAT, lng: LNG, needsPin: true, confidence: 'MEDIUM' });
    expect(r.warnings.join(' ')).toMatch(/swapped/i);
  });

  it('flags a point outside Oman/UAE (still ok, but needs a pin, LOW confidence)', () => {
    const r = parseLocationInput('51.5074, -0.1278'); // London
    expect(r).toMatchObject({ ok: true, lat: 51.5074, lng: -0.1278, needsPin: true, confidence: 'LOW' });
    expect(r.warnings.join(' ')).toMatch(/outside the delivery area/i);
  });

  it('respects a custom service area', () => {
    const riyadh = { minLat: 20, maxLat: 30, minLng: 40, maxLng: 50 };
    const r = parseLocationInput('24.7136, 46.6753', riyadh);
    expect(r).toMatchObject({ ok: true, needsPin: false, confidence: 'HIGH' });
    // ... and the default area would have flagged it.
    expect(parseLocationInput('24.7136, 46.6753').needsPin).toBe(true);
  });

  it('asks for a pin when coordinates have fewer than 4 decimals', () => {
    const r = parseLocationInput('23.58, 58.40');
    expect(r).toMatchObject({ ok: true, lat: 23.58, lng: 58.4, needsPin: true, confidence: 'MEDIUM' });
    expect(r.warnings.join(' ')).toMatch(/fewer than 4 decimals/i);
    // Integers are the worst case.
    expect(parseLocationInput('23 58').needsPin).toBe(true);
    // One side precise, the other not: the weaker side decides.
    expect(parseLocationInput('23.5859, 58.4').needsPin).toBe(true);
  });

  it('reports both the swap and the low precision', () => {
    const r = parseLocationInput('58.40, 23.58');
    expect(r.ok).toBe(true);
    expect(r.lat).toBe(23.58);
    expect(r.needsPin).toBe(true);
    expect(r.warnings).toHaveLength(2);
  });

  it('rejects 0,0', () => {
    for (const s of ['0,0', '0.0000, 0.0000']) {
      const r = parseLocationInput(s);
      expect(r.ok).toBe(false);
      expect(r.needsPin).toBe(true);
      expect(r.error).toMatch(/0,0/);
      expect(r.lat).toBeUndefined();
    }
  });

  it('rejects out-of-range values', () => {
    for (const s of ['95.1234, 58.4059', '23.5859, 190.1234', '-91.0000, 10.0000']) {
      const r = parseLocationInput(s);
      expect(r.ok, s).toBe(false);
      expect(r.error, s).toMatch(/-90\.\.90/);
    }
  });

  it('rejects empty / blank / oversized input', () => {
    for (const s of ['', '   ']) {
      const r = parseLocationInput(s);
      expect(r.ok).toBe(false);
      expect(r.needsPin).toBe(true);
      expect(r.error).toMatch(/Paste a Google Maps link/);
    }
    expect(parseLocationInput(null as unknown as string).ok).toBe(false);
    expect(parseLocationInput(`https://www.google.com/maps?q=${'x'.repeat(2100)}`).error).toMatch(/too long/i);
  });

  it('rejects free text that is not a location', () => {
    expect(parseLocationInput('near the roundabout, Bawshar').ok).toBe(false);
    expect(parseLocationInput('Muscat').ok).toBe(false);
  });
});

describe('parseLocationInput - DMS limits (audit F17)', () => {
  it('refuses minutes or seconds of 60 or more instead of rolling them over into another point', () => {
    // Before: 23°99'00"N was read as 24.65°N - a real point in Oman, HIGH confidence, no pin asked.
    expect(parseLocationInput(`23°99'00"N 58°24'00"E`)).toMatchObject({ ok: false, needsPin: true, error: expect.stringMatching(/Latitude: minutes must be 0 to 59/) });
    expect(parseLocationInput(`23°60'00"N 58°24'00"E`)).toMatchObject({ ok: false, error: expect.stringMatching(/minutes must be 0 to 59/) });
    expect(parseLocationInput(`23°35'99"N 58°24'21"E`)).toMatchObject({ ok: false, error: expect.stringMatching(/Latitude: seconds must be below 60/) });
    expect(parseLocationInput(`23°35'60"N 58°24'21"E`)).toMatchObject({ ok: false, error: expect.stringMatching(/seconds must be below 60/) });
    expect(parseLocationInput(`23°35'09"N 58°75'21"E`)).toMatchObject({ ok: false, error: expect.stringMatching(/Longitude: minutes must be 0 to 59/) });
    expect(parseLocationInput(`23°35'09"N 58°24'60.5"E`)).toMatchObject({ ok: false, error: expect.stringMatching(/Longitude: seconds must be below 60/) });
    for (const bad of [`23°99'00"N 58°24'00"E`, `23°35'99"N 58°24'21"E`]) {
      const r = parseLocationInput(bad);
      expect(r.lat, bad).toBeUndefined();
      expect(r.confidence, bad).toBeUndefined();
    }
  });

  it('still reads the highest valid minutes and seconds', () => {
    const r = parseLocationInput(`23°59'59.9"N 58°59'59"E`);
    expect(r).toMatchObject({ ok: true, confidence: 'HIGH', needsPin: false });
    expect(r.lat).toBeCloseTo(23 + 59 / 60 + 59.9 / 3600, 6);
    expect(r.lng).toBeCloseTo(58 + 59 / 60 + 59 / 3600, 6);
    // The lowest are read too. Whole degrees written with seconds are the rough pair 23, 58 (A5 sixth
    // review), so they need a pin: this line expected HIGH and needsPin false.
    expect(parseLocationInput(`23°00'00"N 58°00'00.0"E`)).toMatchObject({ ok: true, lat: 23, lng: 58, confidence: 'MEDIUM', needsPin: true });
  });

  it('keeps latitude within 90° and longitude within 180°, the boundary itself included', () => {
    expect(parseLocationInput(`90°00'01"N 58°24'21"E`)).toMatchObject({ ok: false, error: expect.stringMatching(/Latitude must be at most 90°/) });
    expect(parseLocationInput(`123°35'09"N 58°24'21"E`)).toMatchObject({ ok: false, error: expect.stringMatching(/Latitude must be at most 90°/) });
    expect(parseLocationInput(`23°35'09"N 181°00'00"E`)).toMatchObject({ ok: false, error: expect.stringMatching(/Longitude must be at most 180°/) });
    expect(parseLocationInput(`23°35'09"S 180°00'00.1"W`)).toMatchObject({ ok: false, error: expect.stringMatching(/Longitude must be at most 180°/) });
    // 90°N and 180°E are real (outside Oman/UAE, so they need the pin like any far point).
    expect(parseLocationInput(`90°00'00"N 58°24'21"E`)).toMatchObject({ ok: true, lat: 90, needsPin: true });
    expect(parseLocationInput(`23°35'09"N 180°00'00"E`)).toMatchObject({ ok: true, lng: 180, needsPin: true });
  });

  it('refuses seconds without minutes', () => {
    expect(parseLocationInput(`23°09.2"N 58°24'21.2"E`)).toMatchObject({ ok: false, error: expect.stringMatching(/seconds without minutes/) });
  });

  it('does not treat whole degrees or whole minutes as an exact point: the pin must be confirmed', () => {
    // Before: "23°N 58°E" (about 100 km) came back HIGH with no pin to confirm.
    expect(parseLocationInput('23°N 58°E')).toMatchObject({ ok: true, lat: 23, lng: 58, confidence: 'LOW', needsPin: true, warnings: [expect.stringMatching(/Whole degrees only/)] });
    expect(parseLocationInput(`23°35'N 58°24'E`)).toMatchObject({ ok: true, confidence: 'MEDIUM', needsPin: true, warnings: [expect.stringMatching(/no seconds/)] });
    // The less precise half decides.
    expect(parseLocationInput(`23°35'09.2"N 58°E`)).toMatchObject({ ok: true, confidence: 'LOW', needsPin: true });
    expect(parseLocationInput(`23°35'09.2"N 58°24'E`)).toMatchObject({ ok: true, confidence: 'MEDIUM', needsPin: true });
    // A swap never raises the confidence of a whole-degree point.
    expect(parseLocationInput('58°N 23°E')).toMatchObject({ ok: true, lat: 23, lng: 58, confidence: 'LOW', needsPin: true });
    // Whole seconds (about 30 m) stay exact.
    expect(parseLocationInput(`23°35'09"N 58°24'21"E`)).toMatchObject({ ok: true, confidence: 'HIGH', needsPin: false });
  });

  it('applies the same limits to DMS inside a Google Maps link', () => {
    expect(parseLocationInput(`https://www.google.com/maps?q=${encodeURIComponent(`23°99'00"N 58°24'00"E`)}`)).toMatchObject({ ok: false, error: expect.stringMatching(/minutes must be 0 to 59/) });
    expect(parseLocationInput(`https://www.google.com/maps/place/${encodeURIComponent(`23°35'75"N 58°24'21"E`)}`)).toMatchObject({ ok: false, error: expect.stringMatching(/seconds must be below 60/) });
    expect(parseLocationInput(`https://www.google.com/maps/place/${encodeURIComponent(`23°35'N 58°24'E`)}`)).toMatchObject({ ok: true, source: 'GOOGLE_MAPS_URL', confidence: 'MEDIUM', needsPin: true });
  });

  it('the server-side resolve refuses them too (the Read button and PUT { input })', async () => {
    const fetchImpl = vi.fn();
    expect(await resolveLocationInput(`23°99'00"N 58°24'00"E`, { fetchImpl })).toMatchObject({ ok: false, needsPin: true });
    expect(await resolveLocationInput('23°N 58°E', { fetchImpl })).toMatchObject({ ok: true, needsPin: true, confidence: 'LOW' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('parseLocationInput - Google Maps URLs', () => {
  it('prefers the place pin (!3d!4d) over the map centre (@)', () => {
    const r = parseLocationInput(PLACE_URL);
    expect(r).toMatchObject({ ok: true, lat: LAT, lng: LNG, source: 'GOOGLE_MAPS_URL', confidence: 'HIGH', needsPin: false });
    expect(r.resolvedUrl).toContain('!3d23.5859!4d58.4059');
  });

  it('reads ?q=lat,lng (also without https:// and on country domains)', () => {
    for (const u of [
      'https://maps.google.com/?q=23.5859,58.4059',
      'https://www.google.com/maps?q=23.5859,58.4059&z=17',
      'www.google.com/maps?q=23.5859,58.4059',
      'https://www.google.co.om/maps?q=23.5859,58.4059',
      'https://www.google.com.om/maps?q=loc:23.5859,58.4059',
    ]) {
      const r = parseLocationInput(u);
      expect(r, u).toMatchObject({ ok: true, lat: LAT, lng: LNG, source: 'GOOGLE_MAPS_URL', needsPin: false });
    }
  });

  it('reads ?ll= only as the map centre -> needs a pin (A5 third review)', () => {
    // In a classic link, ll is the centre of the view: Google shows no marker there. Before: HIGH,
    // needsPin false, so ADD LOCATION saved it as read and the server agreed.
    for (const u of [
      'https://maps.google.com/maps?ll=23.5859,58.4059&z=16',
      // q names a place, so the only coordinates are the view centre.
      'https://maps.google.com/maps?q=Lulu+Hypermarket&ll=23.5859,58.4059&z=15',
    ]) {
      const r = parseLocationInput(u);
      expect(r, u).toMatchObject({ ok: true, lat: LAT, lng: LNG, confidence: 'MEDIUM', needsPin: true });
      expect(r.warnings.join(' '), u).toMatch(/map centre, not a pin/);
    }
    // The other centre keys say the same.
    for (const key of ['center', 'sll']) {
      const r = parseLocationInput(`https://maps.google.com/maps?${key}=23.5859,58.4059&z=16`);
      expect(r, key).toMatchObject({ ok: true, confidence: 'MEDIUM', needsPin: true });
      expect(r.warnings.join(' '), key).toMatch(/map centre, not a pin/);
    }
    // Control: ?q= with coordinates wins over ?ll= and stays exact.
    expect(parseLocationInput('https://maps.google.com/maps?q=23.5859,58.4059&ll=23.5,58.3&z=15')).toMatchObject({ lat: LAT, lng: LNG, confidence: 'HIGH', needsPin: false });
  });

  describe('directions links (/maps/dir/...): only the end of the route is read (A5 third review)', () => {
    // Google puts the start in the path as coordinates when the route starts at "Your location" or at
    // a dropped pin. The destination here is a place name (its point is only in the data part).
    const FROM_HERE_TO_PLACE =
      'https://www.google.com/maps/dir/23.6100123,58.5400456/Lulu+Hypermarket+Bawshar/@23.59,58.42,13z/data=!4m8!4m7!1m0!1m5!1m1!1s0x3e8dfd:0x1!2m2!1d58.4059!2d23.5859';

    it('a link that starts at coordinates and ends at a place name never reads the start', () => {
      const r = parseLocationInput(FROM_HERE_TO_PLACE);
      // Before: { ok: true, lat: 23.610012, lng: 58.540046, confidence: 'HIGH', needsPin: false } - the start.
      expect(r.lat).not.toBeCloseTo(23.610012, 4);
      expect(r).toMatchObject({ ok: true, lat: 23.59, lng: 58.42, confidence: 'MEDIUM', needsPin: true });
      expect(r.warnings.join(' ')).toMatch(/directions link does not end at a point/);
      // The same with Google's "Your location" data part.
      const yours = parseLocationInput('https://www.google.com/maps/dir/23.6100123,58.5400456/Lulu+Hypermarket,+Muscat/@23.59,58.42,13z/data=!4m9!4m8!1m1!4e1!1m5!1m1!1s0x3e8dfd:0x1!2m2!1d58.4059!2d23.5859');
      expect(yours).toMatchObject({ needsPin: true, confidence: 'MEDIUM' });
      expect(yours.lat).not.toBeCloseTo(23.610012, 4);
    });

    it('three waypoints ending at a place name never read the middle one', () => {
      const r = parseLocationInput('https://www.google.com/maps/dir/23.6100123,58.5400456/23.5859123,58.4059123/Lulu+Hypermarket/@23.59,58.42,13z');
      // Before: the middle waypoint 23.585912, 58.405912, HIGH.
      expect(r).toMatchObject({ ok: true, lat: 23.59, lng: 58.42, needsPin: true });
    });

    it('"directions from here" (the start filled, the end empty) is not read as the customer', () => {
      for (const u of ['https://www.google.com/maps/dir/23.6100123,58.5400456//@23.59,58.42,13z', 'https://www.google.com/maps/dir/23.6100123,58.5400456']) {
        const r = parseLocationInput(u);
        // Before: the start, HIGH.
        expect(r.lat, u).not.toBeCloseTo(23.610012, 4);
        expect(r.needsPin, u).toBe(true);
      }
      // No map centre either: not read, drop a pin.
      const bare = parseLocationInput('https://www.google.com/maps/dir/23.6100123,58.5400456/Lulu+Hypermarket');
      expect(bare).toMatchObject({ ok: false, needsPin: true });
      expect(bare.error).toMatch(/directions link does not end at a point.*Drop a pin/);
    });

    it('a data part with a place pin (!3d!4d) is not read on a directions link', () => {
      const r = parseLocationInput('https://www.google.com/maps/dir/23.6100123,58.5400456/Lulu/@23.59,58.42,13z/data=!3d23.6100123!4d58.5400456');
      expect(r.lat).not.toBeCloseTo(23.610012, 4);
      expect(r.needsPin).toBe(true);
    });

    it('control: the end of the route, when it is a point, is read as before', () => {
      for (const u of [
        'https://www.google.com/maps/dir//23.5859,58.4059/@23.59,58.42,13z',
        'https://www.google.com/maps/dir/Office/23.5859,58.4059/@23.59,58.42,13z',
        'https://www.google.com/maps/dir/23.6100123,58.5400456/23.5859,+58.4059',
        'https://www.google.com/maps/dir/23.6100123,58.5400456/23.5859%2C58.4059/',
      ]) {
        expect(parseLocationInput(u), u).toMatchObject({ ok: true, lat: LAT, lng: LNG, confidence: 'HIGH', needsPin: false });
      }
      // Fewer than 4 decimals at the end: read, but needs a pin (as any other coarse pair).
      expect(parseLocationInput('https://www.google.com/maps/dir//23.58,58.40/')).toMatchObject({ ok: true, lat: 23.58, needsPin: true });
    });
  });

  it('reads ?query= (api=1 search links)', () => {
    expect(parseLocationInput('https://www.google.com/maps/search/?api=1&query=23.5859%2C58.4059')).toMatchObject({
      ok: true, lat: LAT, lng: LNG, needsPin: false, confidence: 'HIGH',
    });
  });

  it('reads ?destination= (api=1 directions links)', () => {
    expect(parseLocationInput('https://www.google.com/maps/dir/?api=1&destination=23.5859,58.4059&travelmode=driving')).toMatchObject({
      ok: true, lat: LAT, lng: LNG, needsPin: false,
    });
  });

  it('reads ?daddr= (legacy directions links)', () => {
    expect(parseLocationInput('https://maps.google.com/maps?saddr=My+Location&daddr=23.5859,58.4059')).toMatchObject({
      ok: true, lat: LAT, lng: LNG, needsPin: false,
    });
  });

  it('reads DMS inside ?q=', () => {
    const r = parseLocationInput(`https://www.google.com/maps?q=${encodeURIComponent(`23°35'09.2"N 58°24'21.2"E`)}`);
    expect(r.ok).toBe(true);
    expect(r.lat).toBeCloseTo(23.585889, 5);
  });

  it('reads /search/lat,+lng', () => {
    const r = parseLocationInput('https://www.google.com/maps/search/23.5859,+58.4059?entry=tts');
    expect(r).toMatchObject({ ok: true, lat: LAT, lng: LNG, needsPin: false, confidence: 'HIGH' });
    // Two-decimal search link: read, but needs a pin.
    const low = parseLocationInput('https://www.google.com/maps/search/23.58,+58.40');
    expect(low).toMatchObject({ ok: true, lat: 23.58, lng: 58.4, needsPin: true });
  });

  it('reads /place/lat,lng (and ignores the @centre that follows it)', () => {
    const r = parseLocationInput('https://www.google.com/maps/place/23.5859,58.4059/@23.5000,58.3000,17z');
    expect(r).toMatchObject({ ok: true, lat: LAT, lng: LNG, needsPin: false });
  });

  it('reads a DMS /place/ path', () => {
    const r = parseLocationInput(`https://www.google.com/maps/place/${encodeURIComponent(`23°35'09.2"N 58°24'21.2"E`)}`);
    expect(r.ok).toBe(true);
    expect(r.lat).toBeCloseTo(23.585889, 5);
    expect(r.needsPin).toBe(false);
  });

  it('accepts /@lat,lng,17z but only as the map centre -> needs a pin', () => {
    const r = parseLocationInput('https://www.google.com/maps/@23.5859,58.4059,17z');
    expect(r).toMatchObject({ ok: true, lat: LAT, lng: LNG, needsPin: true, confidence: 'MEDIUM', source: 'GOOGLE_MAPS_URL' });
    expect(r.warnings.join(' ')).toMatch(/map centre/i);
  });

  it('reads geo: URIs', () => {
    expect(parseLocationInput('geo:23.5859,58.4059')).toMatchObject({ ok: true, lat: LAT, lng: LNG, needsPin: false, source: 'GOOGLE_MAPS_URL' });
    expect(parseLocationInput('geo:23.5859,58.4059?z=17')).toMatchObject({ ok: true, lat: LAT, lng: LNG });
    expect(parseLocationInput('geo:23.58,58.40').needsPin).toBe(true);
  });

  it('place-name-only links fail with needsPin and a clear error', () => {
    for (const u of [
      'https://www.google.com/maps/place/Lulu+Hypermarket+Bawshar',
      'https://maps.google.com/?q=Lulu+Hypermarket+Bawshar',
    ]) {
      const r = parseLocationInput(u);
      expect(r.ok, u).toBe(false);
      expect(r.needsPin, u).toBe(true);
      expect(r.error, u).toMatch(/does not contain coordinates/);
    }
  });

  it('rejects non-Google URLs, including look-alike hosts', () => {
    for (const u of [
      'https://www.bing.com/maps?cp=23.5859~58.4059',
      'https://google.com.evil.example/maps?q=23.5859,58.4059',
      'https://evilgoogle.com/maps?q=23.5859,58.4059',
      'https://maps.google.com@evil.example/?q=23.5859,58.4059',
    ]) {
      const r = parseLocationInput(u);
      expect(r.ok, u).toBe(false);
      expect(r.error, u).toMatch(/Only Google Maps links/);
    }
  });

  it('unwraps a consent.google.com page to its continue= URL', () => {
    const u = `https://consent.google.com/ml?continue=${encodeURIComponent(PLACE_URL)}&gl=OM&hl=en`;
    expect(parseLocationInput(u)).toMatchObject({ ok: true, lat: LAT, lng: LNG, needsPin: false });
    // Consent page without a usable continue URL.
    const bare = parseLocationInput('https://consent.google.com/ml?gl=OM');
    expect(bare.ok).toBe(false);
    expect(bare.error).toMatch(/consent page/);
  });

  it('marks short links as needing server-side resolution', () => {
    const r = parseLocationInput('https://maps.app.goo.gl/AbCdEf123');
    expect(r.ok).toBe(false);
    expect(r.needsResolve).toBe(true);
    expect(parseLocationInput('https://goo.gl/maps/xyz').needsResolve).toBe(true);
  });
});

describe('host helpers', () => {
  it('isShortMapsLink', () => {
    expect(isShortMapsLink('https://maps.app.goo.gl/abc')).toBe(true);
    expect(isShortMapsLink('https://goo.gl/maps/abc')).toBe(true);
    expect(isShortMapsLink('https://www.google.com/maps?q=1,2')).toBe(false);
    expect(isShortMapsLink('not a url')).toBe(false);
  });

  it('isGoogleMapsHost', () => {
    for (const h of ['google.com', 'www.google.com', 'maps.google.com', 'www.google.co.om', 'google.com.om', 'maps.app.goo.gl', 'consent.google.com', 'WWW.GOOGLE.COM']) {
      expect(isGoogleMapsHost(h), h).toBe(true);
    }
    for (const h of ['evil.com', 'google.com.evil.com', 'notgoogle.com', 'mail.google.com', 'goo.gl.evil.com']) {
      expect(isGoogleMapsHost(h), h).toBe(false);
    }
  });

  it('default service area covers Muscat and Dubai', () => {
    const inside = (lat: number, lng: number) =>
      lat >= DEFAULT_SERVICE_AREA.minLat && lat <= DEFAULT_SERVICE_AREA.maxLat && lng >= DEFAULT_SERVICE_AREA.minLng && lng <= DEFAULT_SERVICE_AREA.maxLng;
    expect(inside(23.5859, 58.4059)).toBe(true);
    expect(inside(25.2048, 55.2708)).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------
// resolveLocationInput with an injected fetch
// ---------------------------------------------------------------------------------------

function redirect(to: string, status = 302): Response {
  return new Response(null, { status, headers: { location: to } });
}

function fetchSequence(responses: (Response | Error)[]) {
  const calls: string[] = [];
  let i = 0;
  const impl = vi.fn(async (url: string, _init?: RequestInit) => {
    calls.push(url);
    const r = responses[Math.min(i++, responses.length - 1)];
    if (r instanceof Error) throw r;
    return r;
  });
  return { impl, calls };
}

describe('resolveLocationInput', () => {
  it('does not fetch anything for inputs that parse on their own', async () => {
    const { impl } = fetchSequence([]);
    const r = await resolveLocationInput('23.5859, 58.4059', { fetchImpl: impl });
    expect(r).toMatchObject({ ok: true, lat: LAT, lng: LNG });
    await resolveLocationInput('https://www.bing.com/maps', { fetchImpl: impl });
    expect(impl).not.toHaveBeenCalled();
  });

  it('follows maps.app.goo.gl -> 302 -> google.com/maps/place/...!3d!4d', async () => {
    const { impl, calls } = fetchSequence([redirect(PLACE_URL)]);
    const r = await resolveLocationInput('https://maps.app.goo.gl/AbCdEf123', { fetchImpl: impl });
    expect(r).toMatchObject({ ok: true, lat: LAT, lng: LNG, needsPin: false, confidence: 'HIGH', source: 'GOOGLE_MAPS_URL' });
    expect(r.resolvedUrl).toContain('!3d23.5859!4d58.4059');
    // Only the short link itself is fetched; the Google Maps URL is parsed, not fetched.
    expect(calls).toEqual(['https://maps.app.goo.gl/AbCdEf123']);
    const init = impl.mock.calls[0][1];
    expect(init?.redirect).toBe('manual');
    expect(init?.signal).toBeDefined();
  });

  it('accepts a short link pasted without https://', async () => {
    const { impl, calls } = fetchSequence([redirect(PLACE_URL)]);
    const r = await resolveLocationInput('maps.app.goo.gl/AbCdEf123', { fetchImpl: impl });
    expect(r).toMatchObject({ ok: true, lat: LAT, lng: LNG });
    expect(calls).toEqual(['https://maps.app.goo.gl/AbCdEf123']);
  });

  it('follows a relative Location header against the short host', async () => {
    const { impl, calls } = fetchSequence([redirect('/next', 301), redirect(PLACE_URL)]);
    const r = await resolveLocationInput('https://goo.gl/maps/xyz', { fetchImpl: impl });
    expect(r.ok).toBe(true);
    expect(calls).toEqual(['https://goo.gl/maps/xyz', 'https://goo.gl/next']);
  });

  it('rejects a redirect to a non-Google host WITHOUT fetching it', async () => {
    const { impl, calls } = fetchSequence([redirect('https://evil.example/steal?x=1')]);
    const r = await resolveLocationInput('https://maps.app.goo.gl/AbCdEf123', { fetchImpl: impl });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/does not lead to Google Maps/);
    expect(impl).toHaveBeenCalledTimes(1);
    expect(calls).toEqual(['https://maps.app.goo.gl/AbCdEf123']);
  });

  it('rejects a redirect to a non-http scheme', async () => {
    const { impl } = fetchSequence([redirect('javascript:alert(1)')]);
    const r = await resolveLocationInput('https://maps.app.goo.gl/AbCdEf123', { fetchImpl: impl });
    expect(r.ok).toBe(false);
    expect(impl).toHaveBeenCalledTimes(1);
  });

  it('handles consent.google.com?continue=<encoded maps url>', async () => {
    const consent = `https://consent.google.com/ml?continue=${encodeURIComponent(PLACE_URL)}&gl=OM&m=0&pc=m&hl=en`;
    const { impl } = fetchSequence([redirect(consent)]);
    const r = await resolveLocationInput('https://maps.app.goo.gl/AbCdEf123', { fetchImpl: impl });
    expect(r).toMatchObject({ ok: true, lat: LAT, lng: LNG, needsPin: false });
    expect(impl).toHaveBeenCalledTimes(1);
  });

  it('resolves a chain of exactly 5 redirects', async () => {
    const hops = [1, 2, 3, 4].map((n) => redirect(`https://maps.app.goo.gl/hop${n}`));
    const { impl } = fetchSequence([...hops, redirect(PLACE_URL)]);
    const r = await resolveLocationInput('https://maps.app.goo.gl/start', { fetchImpl: impl });
    expect(r).toMatchObject({ ok: true, lat: LAT, lng: LNG });
    expect(impl).toHaveBeenCalledTimes(5);
  });

  it('gives up after more than 5 redirects', async () => {
    let n = 0;
    const impl = vi.fn(async () => redirect(`https://maps.app.goo.gl/loop${++n}`));
    const r = await resolveLocationInput('https://maps.app.goo.gl/start', { fetchImpl: impl });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/Too many redirects/);
    expect(impl).toHaveBeenCalledTimes(5);
  });

  it('turns a network error into a friendly message', async () => {
    const { impl } = fetchSequence([new TypeError('fetch failed')]);
    const r = await resolveLocationInput('https://maps.app.goo.gl/AbCdEf123', { fetchImpl: impl });
    expect(r.ok).toBe(false);
    expect(r.needsPin).toBe(true);
    expect(r.error).toMatch(/Could not open the short link \(fetch failed\)\. Paste the full link or drop a pin\./);
  });

  it('fails cleanly when the short link does not redirect', async () => {
    const { impl } = fetchSequence([new Response('<html></html>', { status: 200 })]);
    const r = await resolveLocationInput('https://maps.app.goo.gl/AbCdEf123', { fetchImpl: impl });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/did not redirect/);
  });

  it('a short link resolving to a place-name-only URL still needs a pin', async () => {
    const { impl } = fetchSequence([redirect('https://www.google.com/maps/place/Lulu+Hypermarket')]);
    const r = await resolveLocationInput('https://maps.app.goo.gl/AbCdEf123', { fetchImpl: impl });
    expect(r.ok).toBe(false);
    expect(r.needsPin).toBe(true);
    expect(r.resolvedUrl).toBe('https://www.google.com/maps/place/Lulu+Hypermarket');
  });
});

// Owner decision of 28 Sep 2026, "Same rule everywhere" (audit PR A5): a coordinate pair a dispatcher
// types or pastes is judged like the customer import. Of the zeros at the end of a decimal coordinate
// only one counts: "23.5800" is 3 decimals. A rough 23.58 copied from a cell formatted to show 4
// decimals, or written by a program that always prints 6 (Java "%f", JavaScript toFixed(6)), looks
// exact and is not. Before, ADD LOCATION and POST /api/customers counted every zero.
describe('parseLocationInput - only one zero at the end counts (owner decision of 28 Sep 2026)', () => {
  const ZEROS = 'Fewer than 4 decimals (only one zero at the end counts).';
  const FEW = 'Coordinates have fewer than 4 decimals (accurate to ~100 m or worse).';

  it.each([
    ['4 decimals ending in 00', '23.5800, 58.4100', 23.58, 58.41],
    ['one side only', '23.5859, 58.4100', 23.5859, 58.41],
    ['6 decimals ending in 0000', '23.580000, 58.410000', 23.58, 58.41],
    ['space separated', '23.5800 58.4100', 23.58, 58.41],
    ['semicolon, signed', '+23.5800;+58.4100', 23.58, 58.41],
    ['whole degrees padded', '23.0000, 58.0000', 23, 58],
  ])('a typed or pasted pair, %s: not exact, and the warning says why', (_what, text, lat, lng) => {
    const r = parseLocationInput(text);
    // Before: HIGH and needsPin false ("23.5800" counted 4 decimals), saved as a verified reading.
    expect(r).toMatchObject({ ok: true, lat, lng, source: 'MANUAL_LATLNG', confidence: 'MEDIUM', needsPin: true });
    expect(r.warnings).toEqual([ZEROS]);
    expect(pinRequiredMessage(r)).toBe("Fewer than 4 decimals (only one zero at the end counts). Drop the pin on the customer's exact location.");
  });

  it.each([
    ['4 decimals, one zero at the end', '23.5850, 58.4105'],
    ['4 decimals, no zero at the end', '23.5859, 58.4059'],
    ['6 decimals', '23.585912, 58.405934'],
    ['6 decimals ending in 00 (5 count)', '23.585900, 58.405900'],
    ['5 decimals ending in 00 (4 count)', '23.58500, 58.41050'],
  ])('control: %s still reads exact', (_what, text) => {
    expect(parseLocationInput(text)).toMatchObject({ ok: true, confidence: 'HIGH', needsPin: false, warnings: [] });
  });

  it('a pair written with fewer than 4 decimals keeps its own warning (the zeros did not make the difference)', () => {
    expect(parseLocationInput('23.58, 58.41').warnings).toEqual([FEW]);
    // "23.500" counts 2 decimals, but it was written with 3: fewer than 4 either way.
    expect(parseLocationInput('23.500, 58.4105').warnings).toEqual([FEW]);
    expect(pinRequiredMessage(parseLocationInput('23.58, 58.41'))).toBe("This reading is not exact. Drop the pin on the customer's exact location, then save.");
  });

  it('the same rule and the same words as the customer import (one implementation)', () => {
    const imported = readImportedPair('23.5800', '58.4100', DEFAULT_SERVICE_AREA);
    expect(imported).toMatchObject({ point: null, reason: IMPORT_REASON.FEW_DECIMALS_ZEROS });
    expect(parseLocationInput('23.5800, 58.4100').warnings).toEqual([IMPORT_REASON.FEW_DECIMALS_ZEROS]);
    expect(readImportedPair('23.5850', '58.4105', DEFAULT_SERVICE_AREA).point).toEqual({ lat: 23.585, lng: 58.4105 });
  });

  // A pair written into a link is text a person or another program wrote: /search/ and ?q= carry
  // the text searched for, as typed, and other programs build ?q=, ?query=, ?destination= and
  // geo: links with a fixed number of decimals. Padding reaches them, so they count the same way.
  it.each([
    ['?q=', 'https://maps.google.com/?q=23.5800,58.4100'],
    ['?query= (api=1 search link built by a program)', 'https://www.google.com/maps/search/?api=1&query=23.580000%2C58.410000'],
    ['?destination=', 'https://www.google.com/maps/dir/?api=1&destination=23.5800,58.4100&travelmode=driving'],
    ['?daddr=', 'https://maps.google.com/maps?saddr=My+Location&daddr=23.5800,58.4100'],
    ['/search/ (the text searched for)', 'https://www.google.com/maps/search/23.5800,+58.4100?entry=tts'],
    ['/place/<pair>', 'https://www.google.com/maps/place/23.5800,58.4100'],
    ['the end of a directions link', 'https://www.google.com/maps/dir/Seeb/23.5800,58.4100/'],
    ['geo: (Android apps print it with "%f", 6 decimals)', 'geo:23.580000,58.410000'],
  ])('a pair written in a link, %s, counts one zero at the end too', (_what, link) => {
    const r = parseLocationInput(link);
    // Before: HIGH, needsPin false.
    expect(r).toMatchObject({ ok: true, lat: 23.58, lng: 58.41, confidence: 'MEDIUM', needsPin: true });
    expect(r.warnings).toEqual([ZEROS]);
  });

  it.each([
    ['?q=', 'https://maps.google.com/?q=23.5850,58.4105'],
    ['/search/', 'https://www.google.com/maps/search/23.585900,+58.410500'],
    ['geo:', 'geo:23.585912,58.410534'],
  ])('control: a link whose pair counts 4 decimals or more, %s, still reads exact', (_what, link) => {
    expect(parseLocationInput(link)).toMatchObject({ ok: true, confidence: 'HIGH', needsPin: false, warnings: [] });
  });

  it("Google's own pin (!3d!4d) keeps its digits: its zeros at the end are not cut (Google writes none; its decimals are checked, see below)", () => {
    const r = parseLocationInput('https://www.google.com/maps/place/Seeb/@23.58,58.41,17z/data=!3m1!4b1!4m4!3m3!8m2!3d23.5850000!4d58.4105000');
    expect(r).toMatchObject({ ok: true, lat: 23.585, lng: 58.4105, confidence: 'HIGH', needsPin: false, warnings: [] });
  });
});

// A5 sixth review. Google Maps repeats a coordinate searched for. "23.58, 58.41" (or "23.5800, 58.4100")
// typed into Google Maps opens as the address below (seen live on 28 Sep 2026: Google drops the zeros at
// the end), whose pin (!3d!4d) is the numbers searched for, and Google shows the point as
// 23°34'48.0"N 58°24'36.0"E. The pin was read with no decimals check and those degrees, minutes and
// seconds as exact, so a point good to about 1 km was read HIGH with no hand pin, while the same pair
// typed was refused.
describe('parseLocationInput - a rough coordinate searched in Google Maps and shared is not exact (A5 sixth review)', () => {
  const FEW = 'Coordinates have fewer than 4 decimals (accurate to ~100 m or worse).';
  const ROUGH_DMS = 'These degrees, minutes and seconds are 23.58, 58.41 written another way: fewer than 4 decimals (accurate to ~100 m or worse).';
  const SHARED = "https://www.google.com/maps/place/23%C2%B034'48.0%22N+58%C2%B024'36.0%22E/@23.58,58.41,17z/data=!3m1!4b1!4m4!3m3!8m2!3d23.58!4d58.41?entry=ttu";

  it.each([
    ['the address Google opens for a searched "23.58, 58.41"', SHARED, 23.58, 58.41],
    ['one decimal', 'https://www.google.com/maps/place/X/data=!4m4!3m3!8m2!3d23.5!4d58.4', 23.5, 58.4],
    ['one side only', 'https://www.google.com/maps/place/X/data=!4m4!3m3!8m2!3d23.58!4d58.4105123', 23.58, 58.410512],
    ['through a consent page', `https://consent.google.com/ml?continue=${encodeURIComponent(SHARED)}&gl=OM`, 23.58, 58.41],
    // The price: a searched "23.5850, 58.4105" comes back with the zero dropped, 3 decimals, so its pin
    // is placed by hand (typed, it is exact). A real place marker has 6 or 7 decimals.
    ['a 4-decimal search ending in 0 (Google drops the zero)', 'https://www.google.com/maps/place/X/data=!4m4!3m3!8m2!3d23.585!4d58.4105', 23.585, 58.4105],
  ])("Google's pin with fewer than 4 decimals, %s: not exact", (_what, link, lat, lng) => {
    const r = parseLocationInput(link);
    // Before: HIGH, needsPin false, no warning.
    expect(r).toMatchObject({ ok: true, lat, lng, source: 'GOOGLE_MAPS_URL', confidence: 'MEDIUM', needsPin: true, warnings: [FEW] });
    expect(pinRequiredMessage(r)).toBe("This reading is not exact. Drop the pin on the customer's exact location, then save.");
  });

  it.each([
    ['as Google shows it', `23°34'48.0"N 58°24'36.0"E`, 'MANUAL_LATLNG'],
    ['with typographic primes and a comma', '23°34′48.0″N, 58°24′36.0″E', 'MANUAL_LATLNG'],
    ['in whole seconds', `23°34'48"N 58°24'36"E`, 'MANUAL_LATLNG'],
    ['in the /place/ address without its data part', "https://www.google.com/maps/place/23%C2%B034'48.0%22N+58%C2%B024'36.0%22E/@23.58,58.41,17z", 'GOOGLE_MAPS_URL'],
    ['in ?q=', `https://www.google.com/maps?q=${encodeURIComponent(`23°34'48.0"N 58°24'36.0"E`)}`, 'GOOGLE_MAPS_URL'],
    ['at the end of a directions link', `https://www.google.com/maps/dir/Office/${encodeURIComponent(`23°34'48.0"N 58°24'36.0"E`)}`, 'GOOGLE_MAPS_URL'],
  ])('degrees, minutes and seconds that are a pair with fewer than 4 decimals, %s: not exact, and the warning says why', (_what, text, source) => {
    const r = parseLocationInput(text);
    // Before: HIGH, needsPin false (seconds were always read as exact).
    expect(r).toMatchObject({ ok: true, lat: 23.58, lng: 58.41, source, confidence: 'MEDIUM', needsPin: true, warnings: [ROUGH_DMS] });
    expect(pinRequiredMessage(r)).toBe("This reading is not exact. Drop the pin on the customer's exact location, then save.");
  });

  it('whole degrees written with seconds are the pair 23, 58: not exact (before: HIGH)', () => {
    expect(parseLocationInput(`23°00'00"N 58°00'00.0"E`)).toMatchObject({
      ok: true, lat: 23, lng: 58, confidence: 'MEDIUM', needsPin: true,
      warnings: ['These degrees, minutes and seconds are 23, 58 written another way: fewer than 4 decimals (accurate to ~100 m or worse).'],
    });
  });

  it('the server-side resolve: the short link Google shares for it is not exact either', async () => {
    const { impl } = fetchSequence([redirect(SHARED)]);
    const r = await resolveLocationInput('https://maps.app.goo.gl/AbCdEf123', { fetchImpl: impl });
    // Before: HIGH, needsPin false.
    expect(r).toMatchObject({ ok: true, lat: 23.58, lng: 58.41, confidence: 'MEDIUM', needsPin: true, warnings: [FEW] });
    expect(r.resolvedUrl).toContain('!3d23.58!4d58.41');
  });

  it.each([
    ['a real place marker (Google writes 7 decimals)', 'https://www.google.com/maps/place/Grand+Mosque/@23.5838,58.3887,17z/data=!4m6!3m5!1s0x0:0x0!8m2!3d23.5838077!4d58.3886687'],
    ['a pin with exactly 4 decimals', PLACE_URL],
    ['degrees, minutes and seconds of a real point', `23°35'09.2"N 58°24'21.2"E`],
    ['whole seconds of a real point', `23°35'09"N 58°24'21"E`],
    ['a tenth of a second from a 3-decimal value', `23°34'48.1"N 58°24'36.1"E`],
    ['the highest seconds', `23°59'59.9"N 58°59'59"E`],
    ['a searched "23.5801, 58.4105" as Google shows it', `23°34'48.4"N 58°24'37.8"E`],
    // Both coordinates must land on a value with 3 decimals: one alone does that for a real point
    // once in 36 (a tenth of a second).
    ['only one coordinate lands on a value with 3 decimals', `23°34'48.0"N 58°24'21.2"E`],
    ['a real point in the /place/ address', `https://www.google.com/maps/place/${encodeURIComponent(`23°35'09.2"N 58°24'21.2"E`)}`],
  ])('control: %s still reads exact', (_what, text) => {
    expect(parseLocationInput(text)).toMatchObject({ ok: true, confidence: 'HIGH', needsPin: false, warnings: [] });
  });
});
