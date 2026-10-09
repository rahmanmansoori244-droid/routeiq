/**
 * Typing coordinates into the map picker (Edit depot, the onboarding depot step). Review of 8 Oct
 * 2026 (ui-rest-3): the Latitude and Longitude fields were bound to the number, so "23." showed as
 * "23" (the dot vanished), the next digit made 236, and the pin map handed that to MapLibre, which
 * threw ("Invalid LngLat latitude value") inside an effect: the whole Depots page went to its error
 * screen and unsaved edits were lost. Now each field keeps the text as typed, the pin moves only for
 * a complete coordinate in range (typedCoordinate), and the pin map never places a point MapLibre
 * cannot show (isMapPoint).
 *
 * The REAL MapPicker is driven key by key through the hook host (hook-host.ts), as the browser's
 * controlled input does: each key is added to what the field shows. The pin map is a stub.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { Host, elements } from './hook-host';
import { isMapPoint, typedCoordinate } from '@/lib/maps';

vi.mock('react', async (importActual) => (await import('./hook-host')).mockReactHooks(importActual));
vi.mock('next/dynamic', () => ({ default: () => function PinMapStub() { return null; } }));

import { MapPicker } from '@/components/map-picker';

describe('typedCoordinate / isMapPoint (lib/maps.ts)', () => {
  it('a complete number in range is a coordinate; text on its way to one, or out of range, is not', () => {
    expect(typedCoordinate('23.5859', 90)).toBe(23.5859);
    expect(typedCoordinate(' -23 ', 90)).toBe(-23);
    expect(typedCoordinate('58.4059', 180)).toBe(58.4059);
    expect(typedCoordinate('179.9', 180)).toBe(179.9);
    for (const t of ['', '-', '23.', '.5', '23,5', '1e2', '0x10', '23.58, 58.40', 'abc']) expect(typedCoordinate(t, 90), t).toBeNull();
    expect(typedCoordinate('236', 90)).toBeNull();
    expect(typedCoordinate('-90.1', 90)).toBeNull();
    expect(typedCoordinate('5841', 180)).toBeNull();
    expect(typedCoordinate('90', 90)).toBe(90);
  });

  it('isMapPoint: only what MapLibre can show', () => {
    expect(isMapPoint(23.5859, 58.4059)).toBe(true);
    expect(isMapPoint(236, 58.4)).toBe(false);
    expect(isMapPoint(23.5, 5841)).toBe(false);
    expect(isMapPoint(Number.NaN, 58)).toBe(false);
  });

  it('the pin map places no point MapLibre cannot show (the effect and place() both check)', () => {
    const src = readFileSync(path.resolve(__dirname, '../../components/pin-map.tsx'), 'utf8');
    expect(src).toMatch(/if \(lat === null \|\| lng === null \|\| !map\.current \|\| !isMapPoint\(lat, lng\)\) return;/);
    expect(src).toMatch(/function place\(la: number, ln: number\) \{\s*if \(!map\.current \|\| !isMapPoint\(la, ln\)\) return;/);
  });
});

function setup(start: { lat: number | null; lng: number | null }) {
  const calls: [number, number][] = [];
  const host: Host<any> = new Host(MapPicker as any, {
    ...start,
    // The depot form: the picker's point becomes the form's lat / lng, passed back down.
    onChange: (lat: number, lng: number) => {
      calls.push([lat, lng]);
      host.render({ lat, lng });
    },
  });
  host.render();
  const field = (which: 'lat' | 'lng') => elements(host.tree).find((e) => e.props?.['data-testid'] === `map-picker-${which}`);
  const shown = (which: 'lat' | 'lng') => String(field(which).props.value);
  /** One key, added to what the field shows (or the field set to `text` when given). */
  const key = (which: 'lat' | 'lng', ch: string) => {
    field(which).props.onChange({ target: { value: shown(which) + ch } });
    host.flush();
  };
  const typeKeys = (which: 'lat' | 'lng', text: string) => {
    for (const ch of text) key(which, ch);
  };
  const set = (which: 'lat' | 'lng', text: string) => {
    field(which).props.onChange({ target: { value: text } });
    host.flush();
  };
  const blur = (which: 'lat' | 'lng') => {
    field(which).props.onBlur();
    host.flush();
  };
  const note = () =>
    elements(host.tree)
      .filter((e) => e.type === 'p' && String(e.props.className).includes('text-destructive'))
      .map((e) => String(e.props.children));
  const map = () => elements(host.tree).find((e) => e.type?.name === 'PinMapStub');
  return { host, calls, shown, key, typeKeys, set, blur, note, map };
}

describe('MapPicker: typing a coordinate key by key (ui-rest-3)', () => {
  it('"23.6123" typed into an empty latitude keeps its dot and ends as 23.6123; the pin never gets 236', () => {
    const t = setup({ lat: null, lng: null });
    t.typeKeys('lat', '23.');
    // Before: the field showed "23" here, and the next key made 236.
    expect(t.shown('lat')).toBe('23.');
    t.typeKeys('lat', '6123');
    expect(t.shown('lat')).toBe('23.6123');
    expect(t.calls.map(([la]) => la)).toEqual([2, 23, 23.6, 23.61, 23.612, 23.6123]);
    expect(t.calls.every(([la, ln]) => isMapPoint(la, ln))).toBe(true);
    expect(t.map().props.lat).toBe(23.6123);
  });

  it('correcting a saved latitude: back to "23." keeps the dot, the new digits make 23.6 (the Edit depot repro)', () => {
    const t = setup({ lat: 23.5859, lng: 58.4059 });
    expect(t.shown('lat')).toBe('23.5859');
    for (const text of ['23.585', '23.58', '23.5', '23.']) t.set('lat', text); // Backspace four times
    expect(t.shown('lat')).toBe('23.');
    t.key('lat', '6');
    expect(t.shown('lat')).toBe('23.6');
    // Before: 23.585, 23.58, 23.5, 23, then 236 (MapLibre threw, the page went to its error screen).
    expect(t.calls).toEqual([
      [23.585, 58.4059],
      [23.58, 58.4059],
      [23.5, 58.4059],
      [23.6, 58.4059],
    ]);
  });

  it('a longitude typed key by key ends as typed (before: 58. -> 58 -> 5841, refused by the server)', () => {
    const t = setup({ lat: 23.5859, lng: null });
    t.typeKeys('lng', '58.41');
    expect(t.shown('lng')).toBe('58.41');
    expect(t.calls.at(-1)).toEqual([23.5859, 58.41]);
    expect(t.calls.some(([, ln]) => Math.abs(ln) > 180)).toBe(false);
  });

  it('a latitude out of range never reaches the pin: the field says why, and leaving it shows the pin again', () => {
    const t = setup({ lat: 23.5859, lng: 58.4059 });
    t.set('lat', '236');
    expect(t.calls).toEqual([]);
    expect(t.map().props.lat).toBe(23.5859);
    expect(t.note()).toEqual(['Latitude is a number from -90 to 90: the pin stays where it is.']);
    t.blur('lat');
    expect(t.shown('lat')).toBe('23.5859');
    expect(t.note()).toEqual([]);
    // Still being typed: no note.
    for (const text of ['', '-', '23.']) {
      t.set('lat', text);
      expect(t.note(), JSON.stringify(text)).toEqual([]);
    }
  });

  it('a point set on the map shows in the fields', () => {
    const t = setup({ lat: 23.5859, lng: 58.4059 });
    t.typeKeys('lat', '0'); // "23.58590": the same point, the text as typed stays
    expect(t.shown('lat')).toBe('23.58590');
    t.host.render({ lat: 23.6012, lng: 58.4101 }); // a click on the map
    expect(t.shown('lat')).toBe('23.6012');
    expect(t.shown('lng')).toBe('58.4101');
  });
});
