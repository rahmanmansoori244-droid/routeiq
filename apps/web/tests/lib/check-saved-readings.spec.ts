/**
 * Audit PR A5, seventh review: the owner's read-only count before the deploy
 * (`prisma/check-saved-readings.ts`, handbook 5.12 step 13 and the 7.5 question) counted customers
 * placed on the map as "confirmed from a pasted reading ... not exact today".
 *
 * Main's customer page saved a map click or two typed numbers with PATCH { lat, lng }: source
 * MANUAL_LATLNG, confirmed, HIGH, and the text (`locationInput`) left as it was, null or an older
 * ADD LOCATION text for another point. The script read that text, not the saved point, so a precise
 * map click with no text or with an old padded text was counted as a not exact pasted reading, and
 * a text RouteIQ wrote itself from the saved number was counted in the same total. It now counts
 * only a text that reads back to the saved point (or that holds it but reads otherwise today), and
 * lists the others apart: no text, a text for another point, the saved numbers as RouteIQ writes
 * them, a text that cannot be read. Every customer and coordinate here is made up.
 */
import { describe, expect, it } from 'vitest';
import { classifySavedReading, savedReadingsReport, type SavedReadingsDb } from '@/prisma/check-saved-readings';
import { DEFAULT_SERVICE_AREA } from '@/lib/dispatch/location-input';

interface Row {
  tenantId: string;
  lat: number | null;
  lng: number | null;
  locationInput: string | null;
  locationVerified: boolean;
  locationSource: string | null;
}

/** A precise point (a map click) and a rough one (two numbers typed with 2 decimals). */
const P = { lat: 23.601234, lng: 58.412345 };
const R = { lat: 23.58, lng: 58.41 };

const row = (point: { lat: number | null; lng: number | null }, locationInput: string | null, extra: Partial<Row> = {}): Row => ({
  tenantId: 't1',
  ...point,
  locationInput,
  locationVerified: true,
  locationSource: 'MANUAL_LATLNG',
  ...extra,
});

/** A fake of the three reads: `where` is applied (equality, `in`, `not: null`) and only the `select`ed fields come back. */
function fakeDb(rows: Row[]) {
  const customerCalls: Array<{ where: Record<string, unknown>; select: Record<string, boolean> }> = [];
  const matches = (r: Row, where: Record<string, unknown>) =>
    Object.entries(where).every(([k, v]) => {
      const have = (r as unknown as Record<string, unknown>)[k];
      if (v && typeof v === 'object' && 'in' in v) return (v as { in: unknown[] }).in.includes(have);
      if (v && typeof v === 'object' && 'not' in v && (v as { not: unknown }).not === null) return have !== null && have !== undefined;
      return have === v;
    });
  const db: SavedReadingsDb = {
    tenant: { findMany: async () => [{ id: 't1', slug: 'acme', country: 'OM' }] },
    tenantConfig: { findUnique: async () => null },
    customer: {
      findMany: async (args: object) => {
        const a = args as { where: Record<string, unknown>; select: Record<string, boolean> };
        customerCalls.push(a);
        return rows
          .filter((r) => matches(r, a.where))
          .map((r) => Object.fromEntries(Object.keys(a.select).map((k) => [k, (r as unknown as Record<string, unknown>)[k]]))) as never;
      },
    },
  };
  return { db, customerCalls };
}

describe('the owner count judges only a text the saved point was read from', () => {
  it("the reviewers' six customers: only the padded reading is a not exact pasted reading", async () => {
    const { db, customerCalls } = fakeDb([
      row(P, null), // A: a map click on main's customer page (PATCH { lat, lng }), no text
      row(P, '23.5800, 58.4100'), // B: an old padded ADD LOCATION text, then a map click
      row(P, '23.601234, 58.412345'), // C: exact text that reads back
      row(R, '23.5800, 58.4100'), // D: a real padded reading
      row(R, '23.601234, 58.412345'), // E: an old exact text, then two rough numbers typed on the customer page
      row({ lat: 23.585, lng: 58.4123 }, '23.585, 58.4123'), // F: RouteIQ wrote the saved numbers (a saved point confirmed as it was)
    ]);
    const lines = await savedReadingsReport(db);
    expect(lines).toEqual([
      'acme: 6 confirmed customer(s) with a typed or pasted location (MANUAL_LATLNG, GOOGLE_MAPS_URL)',
      '  2 confirmed from a pasted reading (the saved text reads back to the saved point); 1 read as not exact today:',
      '    1 - the zeros at the end (only one counts)',
      '  4 not judged by their text (the saved point was not read from it, or the text cannot say); 2 with fewer than 4 decimals as stored:',
      '    1 - no text kept (set on the map or with typed numbers on the customer page before A5)',
      '    2 - the text reads as another point (the point was set after it, on the customer page before A5; or, before audit A2, the text in the box was changed after Read)',
      '    1 - the text is the saved numbers as RouteIQ writes them and reads as not exact (written when a saved point was confirmed as it was, so a stored 23.5850 reads 23.585; a pair typed exactly so looks the same)',
    ]);
    // The saved point is read with the text, and a customer with no point is not counted.
    expect(customerCalls[0]!.select).toMatchObject({ lat: true, lng: true, locationInput: true });
    expect(customerCalls[0]!.where).toMatchObject({ locationVerified: true, lat: { not: null }, lng: { not: null } });
  });

  it('a precise map click with no text is not a pasted reading, and not "another reason"', async () => {
    const { db } = fakeDb([row(P, null), row(P, '   ')]);
    const lines = await savedReadingsReport(db);
    expect(lines.join('\n')).not.toMatch(/another reason/);
    expect(lines).toContain('  0 confirmed from a pasted reading (the saved text reads back to the saved point); 0 read as not exact today');
    expect(lines).toContain('  2 not judged by their text (the saved point was not read from it, or the text cannot say); 0 with fewer than 4 decimals as stored:');
    expect(lines).toContain('    2 - no text kept (set on the map or with typed numbers on the customer page before A5)');
  });

  it('each kind of row, one by one', () => {
    const a = DEFAULT_SERVICE_AREA;
    // Not from the text kept.
    expect(classifySavedReading({ ...P, locationInput: null }, a)).toEqual({ kind: 'noText', roughAsStored: false });
    expect(classifySavedReading({ ...R, locationInput: '' }, a)).toEqual({ kind: 'noText', roughAsStored: true });
    expect(classifySavedReading({ ...P, locationInput: '23.5800, 58.4100' }, a)).toEqual({ kind: 'otherPoint', roughAsStored: false });
    expect(classifySavedReading({ ...R, locationInput: '23.601234, 58.412345' }, a)).toEqual({ kind: 'otherPoint', roughAsStored: true });
    // A hand pin in ADD LOCATION ("map pin"), then a map click on main's customer page.
    expect(classifySavedReading({ ...P, locationInput: 'map pin' }, a)).toEqual({ kind: 'unreadable', roughAsStored: false });
    // A map-centre link, then the point moved on the customer page.
    expect(classifySavedReading({ ...P, locationInput: 'https://www.google.com/maps/@23.5901,58.3902,17z' }, a)).toEqual({ kind: 'otherPoint', roughAsStored: false });
    // The saved numbers as RouteIQ writes them: exact ones read back like any text; not exact ones are apart.
    expect(classifySavedReading({ lat: 23.585, lng: 58.4123, locationInput: '23.585, 58.4123' }, a)).toEqual({ kind: 'storedNumbers', roughAsStored: true });
    expect(classifySavedReading({ ...P, locationInput: '23.601234, 58.412345' }, a)).toEqual({ kind: 'reading', exact: true });
    // A swapped point saved on main's customer page, then confirmed as it was: RouteIQ's text, not a reading.
    expect(classifySavedReading({ lat: 58.412345, lng: 23.601234, locationInput: '58.412345, 23.601234' }, a)).toEqual({ kind: 'storedNumbers', roughAsStored: false });
    // From the text kept.
    expect(classifySavedReading({ ...R, locationInput: '23.5800, 58.4100' }, a)).toEqual({ kind: 'reading', exact: false, reason: 'zeros' });
    expect(classifySavedReading({ ...R, locationInput: '23.58, 58.41' }, a)).toEqual({ kind: 'storedNumbers', roughAsStored: true });
    expect(classifySavedReading({ ...R, locationInput: '23.58,58.41' }, a)).toEqual({ kind: 'reading', exact: false, reason: 'fewDecimals' });
    expect(classifySavedReading({ ...R, locationInput: 'https://www.google.com/maps/place/x/data=!3d23.58!4d58.41' }, a)).toEqual({ kind: 'reading', exact: false, reason: 'fewDecimals' });
    expect(classifySavedReading({ ...R, locationInput: `23°34'48.0"N 58°24'36.0"E` }, a)).toEqual({ kind: 'reading', exact: false, reason: 'roughDms' });
    expect(classifySavedReading({ lat: 23.5901, lng: 58.3902, locationInput: 'https://www.google.com/maps/@23.5901,58.3902,17z' }, a)).toEqual({ kind: 'reading', exact: false, reason: 'other' });
    expect(classifySavedReading({ ...P, locationInput: 'https://www.google.com/maps/place/x/data=!3d23.6012341!4d58.4123449' }, a)).toEqual({ kind: 'reading', exact: true });
    expect(classifySavedReading({ ...P, locationInput: 'https://maps.app.goo.gl/AbCdEf123' }, a)).toEqual({ kind: 'shortLink' });
  });

  it('a text that holds the saved point but reads otherwise today was read differently before A5, and is counted', () => {
    const a = DEFAULT_SERVICE_AREA;
    // Main read a directions link at its start when its end was a place name (A5 third review).
    const dir = 'https://www.google.com/maps/dir/23.601234,58.412345/Some+Place/@23.59,58.40,15z';
    expect(classifySavedReading({ ...P, locationInput: dir }, a)).toEqual({ kind: 'reading', exact: false, reason: 'readDifferently' });
    // With no map centre it cannot be read at all today; it still holds the saved point.
    expect(classifySavedReading({ ...P, locationInput: 'https://www.google.com/maps/dir/23.601234,58.412345/Some+Place' }, a)).toEqual({
      kind: 'reading',
      exact: false,
      reason: 'readDifferently',
    });
    // Rounded to the 6 decimals the parser keeps, in either order.
    expect(classifySavedReading({ ...P, locationInput: 'https://www.google.com/maps/dir/58.4123449,23.6012341/Some+Place' }, a)).toMatchObject({ reason: 'readDifferently' });
  });

  it('the reasons and the other lines are named in the report; zero lines are left out', async () => {
    const dir = 'https://www.google.com/maps/dir/23.601234,58.412345/Some+Place';
    const { db } = fakeDb([row(P, dir, { locationSource: 'GOOGLE_MAPS_URL' }), row(P, 'map pin'), row(P, 'https://maps.app.goo.gl/AbCdEf123', { locationSource: 'GOOGLE_MAPS_URL' })]);
    expect(await savedReadingsReport(db)).toEqual([
      'acme: 3 confirmed customer(s) with a typed or pasted location (MANUAL_LATLNG, GOOGLE_MAPS_URL)',
      '  1 confirmed from a pasted reading (the saved text reads back to the saved point); 1 read as not exact today:',
      '    1 - the text reads as another point today, or cannot be read, but holds the saved point: it was read differently before A5 (for example a directions link read at its start)',
      '  1 short link(s) not read again (the address a short link led to is not kept)',
      '  1 not judged by their text (the saved point was not read from it, or the text cannot say); 0 with fewer than 4 decimals as stored:',
      '    1 - the text cannot be read today and does not hold the saved point (for example "map pin")',
    ]);
  });

  it('only confirmed customers with a typed or pasted source are read; none says so', async () => {
    const { db } = fakeDb([row(P, '23.5800, 58.4100', { locationSource: 'MAP_PIN' }), row(R, '23.5800, 58.4100', { locationVerified: false }), row({ lat: null, lng: null }, '23.5800, 58.4100')]);
    expect(await savedReadingsReport(db)).toEqual(['No customer has a confirmed typed or pasted location.']);
  });
});
