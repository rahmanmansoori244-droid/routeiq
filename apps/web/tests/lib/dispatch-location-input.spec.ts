/**
 * Location input parsing (pure) and short-link resolution (injected fetch - no network).
 */
import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_SERVICE_AREA,
  isGoogleMapsHost,
  isShortMapsLink,
  parseLocationInput,
  resolveLocationInput,
} from '@/lib/dispatch/location-input';

const LAT = 23.5859;
const LNG = 58.4059;

// Place URL whose map centre (@) differs from the pin (!3d!4d) - the pin must win.
const PLACE_URL =
  'https://www.google.com/maps/place/Lulu+Hypermarket+Bawshar/@23.5800,58.3900,17z/data=!3m1!4b1!4m6!3m5!1s0x3e91ff:0x1!8m2!3d23.5859!4d58.4059!16s%2Fg%2F11';

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

  it('reads ?ll=', () => {
    expect(parseLocationInput('https://maps.google.com/maps?ll=23.5859,58.4059&z=16')).toMatchObject({ ok: true, lat: LAT, lng: LNG, needsPin: false });
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
