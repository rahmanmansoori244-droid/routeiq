/**
 * Driver sheets - pure (no DB). The model is checked field by field; the PDF is rendered and read
 * back (page objects + the text of each page) to check the page rules the drivers rely on.
 */
import { inflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import type { DetailStop, PlanDetail } from '@/lib/dispatch/plan-detail';
import { driverPackModel, qrPath, renderDriverPackPdf } from '@/lib/dispatch/driver-pack';
import {
  coordText,
  driverClashNotes,
  MAX_WAYPOINTS,
  noteParts,
  pinUrl,
  REPLACED_LINE,
  routeLinks,
  tripsByTruck,
  whatsappNumber,
  whatsappText,
  whatsappUrl,
} from '@/lib/dispatch/driver-links';
import { phoneCountryCode } from '@/lib/dispatch/customer-attrs';
import { pdfSafe, UNPRINTABLE } from '@/lib/dispatch/pdf-text';
import { fixture, LONG_TRUCK, ORDERS, load, stop } from './plan-detail-fixture';

const OPTS = { tenantName: 'NMWC Test' };

/** Fixture + a customer split over two loads + a stop without a location. */
function withSplitAndNoLocation(): PlanDetail {
  const d = fixture();
  const nesto = d.loads[2].stops[0]; // C004 on the long truck, trip 1
  d.loads[2].stops[0] = { ...nesto, split: { part: 1, parts: 2, restUnserved: false } };
  d.loads[1].stops.push({ ...nesto, sequence: 3, cases: 30, split: { part: 2, parts: 2, restUnserved: true } });
  d.loads[0].stops[1] = { ...d.loads[0].stops[1], lat: null, lng: null, mapsUrl: null };
  return d;
}

/** A load of `n` stops on truck T09 (customers cycle through the fixture orders). */
function longLoad(n: number): PlanDetail {
  const d = fixture();
  const ids = ORDERS.map((o) => o.id);
  d.loads = [load('LX', 't9', 'T09', 1, Array.from({ length: n }, (_, i) => stop(ids[i % ids.length], i + 1, 4, 4 * (i + 1), 380 + 20 * i)), false)];
  return d;
}

// ---- reading the PDF back ----------------------------------------------------------------

function pageCount(buf: Buffer): number {
  return (buf.toString('latin1').match(/\/Type\s*\/Page(?![s\w])/g) ?? []).length;
}

// WinAnsi bytes that differ from Latin-1 (the ones the sheet uses).
const WIN_ANSI: Record<number, string> = { 0x96: '–', 0x97: '—', 0x85: '…' };
const decode = (hex: string) => [...Buffer.from(hex, 'hex')].map((b) => WIN_ANSI[b] ?? String.fromCharCode(b)).join('');
/** Page text is compared without whitespace: react-pdf splits runs and positions words itself. */
const sq = (s: string) => s.replace(/\s+/g, '');

/** Text of every page, in page order, whitespace removed (TJ/Tj hex strings, Helvetica = WinAnsi). */
function pdfObjects(raw: string): Map<number, { dict: string; stream: Buffer | null }> {
  const out = new Map<number, { dict: string; stream: Buffer | null }>();
  const re = /(\d+) 0 obj/g;
  for (let m = re.exec(raw); m; m = re.exec(raw)) {
    const start = m.index + m[0].length;
    const streamAt = raw.indexOf('stream', start);
    const endAt = raw.indexOf('endobj', start);
    if (streamAt !== -1 && streamAt < endAt) {
      // Streams are binary: slice exactly /Length bytes and skip over them.
      const dict = raw.slice(start, streamAt);
      let at = streamAt + 'stream'.length;
      if (raw[at] === '\r') at++;
      if (raw[at] === '\n') at++;
      const len = Number(/\/Length\s+(\d+)/.exec(dict)![1]);
      out.set(Number(m[1]), { dict, stream: Buffer.from(raw.slice(at, at + len), 'latin1') });
      re.lastIndex = at + len;
    } else {
      out.set(Number(m[1]), { dict: raw.slice(start, endAt), stream: null });
      re.lastIndex = endAt;
    }
  }
  return out;
}

/** The hex strings drawn by the text operators (TJ / Tj) of every page, in page order. */
function pageTextHex(buf: Buffer): string[][] {
  const objs = pdfObjects(buf.toString('latin1'));
  const pagesObj = [...objs.values()].find((o) => /\/Type\s*\/Pages\b/.test(o.dict))!.dict;
  const kids = [...pagesObj.match(/\/Kids\s*\[([^\]]*)\]/)![1].matchAll(/(\d+) 0 R/g)].map((k) => Number(k[1]));
  return kids.map((id) => {
    const page = objs.get(id)!.dict;
    const refs = page.match(/\/Contents\s*(\[[^\]]*\]|\d+ 0 R)/)![1];
    return [...refs.matchAll(/(\d+) 0 R/g)].flatMap((r) => {
      const o = objs.get(Number(r[1]))!;
      const content = /\/FlateDecode/.test(o.dict) ? inflateSync(o.stream!).toString('latin1') : o.stream!.toString('latin1');
      return [...content.matchAll(/(\[(?:[^\]]*)\]\s*TJ|<[0-9a-fA-F]*>\s*Tj)/g)].flatMap((t) => [...t[1].matchAll(/<([0-9a-fA-F]*)>/g)].map((h) => h[1]));
    });
  });
}

function pageTexts(buf: Buffer): string[] {
  return pageTextHex(buf).map((hex) => hex.map(decode).join('').replace(/\s+/g, ''));
}

// Byte codes Helvetica (WinAnsi) has a glyph for.
const WIN_ANSI_OK = (b: number) => (b >= 0x20 && b <= 0x7e) || b >= 0xa0 || [0x80, 0x82, 0x83, 0x84, 0x85, 0x86, 0x87, 0x88, 0x89, 0x8a, 0x8b, 0x8c, 0x8e, 0x91, 0x92, 0x93, 0x94, 0x95, 0x96, 0x97, 0x98, 0x99, 0x9a, 0x9b, 0x9c, 0x9e, 0x9f].includes(b);

// ---------------------------------------------------------------------------------------

describe('driverPackModel', () => {
  it('has one section per load, in plan order, with trip k of n per truck', () => {
    const d = fixture();
    const m = driverPackModel(d, OPTS);
    expect(m.sheets.map((s) => s.loadId)).toEqual(['L1', 'L2', 'L3']);
    expect(m.sheets.map((s) => [s.truckCode, s.trip, s.trips])).toEqual([
      ['T01', 1, 2],
      ['T01', 2, 2],
      [LONG_TRUCK, 1, 1],
    ]);
    // A subset keeps plan order, whatever order the ids come in.
    expect(driverPackModel(d, { ...OPTS, loadIds: ['L3', 'L1'] }).sheets.map((s) => s.loadId)).toEqual(['L1', 'L3']);
    expect(m.title).toBe('Driver sheets 2026-09-25 v2');
    expect(m.depot).toEqual({ code: 'MCT', name: 'Muscat Depot' });
  });

  it('carries the header facts: driver, times, cases vs capacity, km label, load check, badges, return line', () => {
    const d = fixture();
    d.loads[2] = { ...d.loads[2], carried: true, status: 'DISPATCHED' };
    const [s1, s2, s3] = driverPackModel(d, OPTS).sheets;
    expect(s1).toMatchObject({ driverName: 'Salim Al Harthy', driverPhone: '+968 9123 4567', depart: '06:00', back: '09:25', cases: 110, capacityCases: 600 });
    expect(s1.kmLabel).toBe('Road km');
    expect(driverPackModel(fixture({ estimated: true }), OPTS).sheets[0].kmLabel).toBe('Estimated km');
    expect(s1.loadCheck.total).toBe(110);
    expect(s1.loadCheck.matchesLoad).toBe(true);
    expect(s1.loadCheck.items.map((k) => `${k.productCode}x${k.cases}`).sort()).toEqual(['JAB-1500-6x20', 'TAN-500-24x80', 'TAN-5Gx10']);
    expect(s1.badges).toEqual(['LOCKED']);
    expect(s2.badges).toEqual(['PLANNED - not locked yet']);
    expect(s3.badges).toEqual(['DISPATCHED', 'KEPT FROM PREVIOUS VERSION']);
    expect(s2.driverName).toBeNull();
    expect(s1.returnText).toBe('Return to depot MCT ~09:25 - load trip 2 (planned departure 10:00).');
    expect(s2.returnText).toBe('Return to depot MCT ~13:25 - last trip of the day.');
    expect(s1.footerText).toContain('void if a newer plan version is issued');
    // The load check flags a manifest that does not add up to the load.
    d.loads[0] = { ...d.loads[0], cases: 111 };
    expect(driverPackModel(d, OPTS).sheets[0].loadCheck.matchesLoad).toBe(false);
  });

  it('lists stops in delivery order with clock ETA, hours, SKUs, sales orders, address and notes', () => {
    const d = fixture();
    d.loads[0].stops.reverse(); // stored order must not matter
    const st = driverPackModel(d, OPTS).sheets[0].stops;
    expect(st.map((s) => s.sequence)).toEqual([1, 2]);
    expect(st[0]).toMatchObject({
      customerName: 'Lulu Hypermarket Bausher',
      customerCode: 'C001',
      branchCode: 'B1',
      customerType: 'HYPERMARKET',
      priority: 1,
      eta: '06:40', // etaMin 400 = minutes from midnight, not from departure
      hours: ['Receives 06:00–14:00', 'Best 07:00–10:00'],
      cases: 70,
      salesOrders: ['SO-1001'],
      address: 'Bausher, Sultan Qaboos St, near Muscat Grand Mall',
      accessNotes: 'Receiving at the back gate; forklift until 14:00',
      notes: [],
      pinUrl: 'https://www.google.com/maps/search/?api=1&query=23.5859,58.3829',
      coords: '23.5859,58.3829',
      split: null,
      late: false,
    });
    expect(st[1].notes).toEqual(['Call the store manager 30 min before']);
    expect(st[0].skus.reduce((a, k) => a + k.cases, 0)).toBe(70);
    const any = driverPackModel({ ...d, loads: [{ ...d.loads[0], stops: [{ ...d.loads[0].stops[0], window: 'Any time', hardWindowOk: false }] }] }, OPTS);
    expect(any.sheets[0].stops[0].hours).toEqual(['Any time']);
    expect(any.sheets[0].stops[0].outsideHours).toBe(true);
    expect(driverPackModel(d, OPTS).sheets[1].stops[0].late).toBe(true);
  });

  it('never carries money: no cost, fuel, revenue, margin or currency', () => {
    const d = fixture({ revenue: true });
    const json = JSON.stringify(driverPackModel(d, OPTS));
    expect(json).not.toMatch(/cost|fuel|revenue|margin|omr|operating|utili[sz]ation/i);
  });

  it('says which part of a split delivery this is and where the other parts are', () => {
    const m = driverPackModel(withSplitAndNoLocation(), OPTS);
    const part1 = m.sheets[2].stops[0];
    const part2 = m.sheets[1].stops.find((s) => s.sequence === 3)!;
    expect(part1.split).toEqual({ part: 1, parts: 2, others: ['part 2 on T01 trip 2'], restUnserved: false });
    expect(part2.split).toEqual({ part: 2, parts: 2, others: [`part 1 on ${LONG_TRUCK} trip 1`], restUnserved: true });
  });

  it('handles a stop without a location: no pin, left out of the route link, and said so', () => {
    const m = driverPackModel(withSplitAndNoLocation(), OPTS);
    const s1 = m.sheets[0];
    expect(s1.stops[1].pinUrl).toBeNull();
    expect(s1.stops[1].coords).toBeNull();
    expect(s1.route.skipped).toEqual([2]);
    expect(s1.route.links).toHaveLength(1);
    expect(s1.route.links[0].waypoints).toBe(1); // depot -> stop 1 -> depot
  });
});

describe('noteParts', () => {
  it('prints each distinct remark once, in order', () => {
    expect(noteParts('Route C7; truck R3 | Route C7; truck R3 |  Call first  | Route C7; truck R3')).toEqual(['Route C7; truck R3', 'Call first']);
    expect(noteParts(null)).toEqual([]);
    expect(noteParts('')).toEqual([]);
  });
});

describe('driver links', () => {
  const depot = { lat: 23.58, lng: 58.4 };
  const stops = (n: number): Pick<DetailStop, 'sequence' | 'lat' | 'lng'>[] =>
    Array.from({ length: n }, (_, i) => ({ sequence: i + 1, lat: 23.5 + i / 100, lng: 58.1 + i / 100 }));
  const params = (url: string) => new URL(url).searchParams;

  it('pins a stop on Google Maps (none without coordinates)', () => {
    expect(pinUrl({ lat: 23.588123456, lng: 58.41 })).toBe('https://www.google.com/maps/search/?api=1&query=23.588123,58.41');
    expect(pinUrl({ lat: null, lng: 58.4 })).toBeNull();
  });

  it('routes depot -> stops in order -> depot, at most 9 waypoints per link', () => {
    expect(MAX_WAYPOINTS).toBe(9);
    const one = routeLinks(depot, stops(9));
    expect(one.links).toHaveLength(1);
    expect(one.links[0].label).toBe('Whole route');
    const p = params(one.links[0].url);
    expect(p.get('origin')).toBe('23.58,58.4');
    expect(p.get('destination')).toBe('23.58,58.4');
    expect(p.get('travelmode')).toBe('driving');
    expect(p.get('waypoints')!.split('|')).toHaveLength(9);

    for (const n of [10, 20, 27]) {
      const r = routeLinks(depot, [...stops(n)].reverse()); // input order does not matter
      const pts: string[] = [];
      r.links.forEach((l, i) => {
        const q = params(l.url);
        const way = q.get('waypoints')?.split('|') ?? [];
        expect(way.length).toBeLessThanOrEqual(MAX_WAYPOINTS);
        expect(l.waypoints).toBe(way.length);
        expect(l.part).toBe(i + 1);
        expect(l.parts).toBe(r.links.length);
        if (i === 0) pts.push(q.get('origin')!);
        else expect(q.get('origin')).toBe(pts[pts.length - 1]); // each link starts where the last ended
        pts.push(...way, q.get('destination')!);
      });
      // Every stop exactly once, in sequence, between the depot at both ends.
      expect(pts).toEqual(['23.58,58.4', ...stops(n).map((s) => coordText(s.lat!, s.lng!)), '23.58,58.4']);
      expect(r.links).toHaveLength(Math.ceil((n + 1) / (MAX_WAYPOINTS + 1)));
    }
    expect(routeLinks(depot, stops(10)).links.map((l) => l.label)).toEqual(['Part 1 of 2: depot to stop 10', 'Part 2 of 2: stop 10 to depot']);
  });

  it('skips stops without coordinates and reports them', () => {
    const s = stops(4);
    s[1] = { ...s[1], lat: null, lng: null };
    const r = routeLinks(depot, s);
    expect(r.skipped).toEqual([2]);
    expect(params(r.links[0].url).get('waypoints')!.split('|')).toHaveLength(3);
    expect(routeLinks(depot, [{ sequence: 1, lat: null, lng: null }])).toEqual({ links: [], skipped: [1] });
  });

  it('counts trips per truck', () => {
    const t = tripsByTruck(fixture().loads);
    expect(t.get('t1')).toBe(2);
    expect(t.get('t2')).toBe(1);
  });

  it('writes a compact WhatsApp message per load and a wa.me link to the driver', () => {
    const d = withSplitAndNoLocation();
    const l = d.loads[0];
    const text = whatsappText(d.run, l, 2, { tenantName: 'NMWC' });
    const lines = text.split('\n');
    expect(lines[0]).toBe('*Truck T01 - Trip 1 of 2*');
    expect(lines[1]).toBe('NMWC · Delivery 2026-09-25 · Plan v2');
    expect(lines[2]).toBe('Depart 06:00 · 2 stops · 110 cases');
    const s1 = lines.indexOf('1. 06:40 Lulu Hypermarket Bausher (C001/B1) · 70 cs');
    const s2 = lines.indexOf('2. 07:30 Al Fair Qurum (C002) · 40 cs');
    expect(s1).toBeGreaterThan(2);
    expect(s2).toBeGreaterThan(s1);
    expect(lines[s1 + 1]).toBe('https://www.google.com/maps/search/?api=1&query=23.5859,58.3829');
    expect(lines[s2 + 1]).toBe('No location - call dispatcher');
    expect(text).toMatch(/^Route: https:\/\/www\.google\.com\/maps\/dir\/\?api=1&origin=/m);
    expect(text).toContain('Not in the route link (no location): stop 2');
    expect(text).toContain('Back at depot ~09:25');
    expect(text).not.toMatch(/cost|OMR|margin|revenue/i);
    expect(text.length).toBeLessThan(700);
    // Split part on the stop line.
    expect(whatsappText(d.run, d.loads[1], 2)).toContain('· 30 cs · part 2/2');

    expect(whatsappUrl('+968 9123 4567', text)).toBe(`https://wa.me/96891234567?text=${encodeURIComponent(text)}`);
    expect(whatsappUrl('00968 9123-4567', 'x')).toBe('https://wa.me/96891234567?text=x');
    expect(whatsappUrl(null, 'a b')).toBe('https://wa.me/?text=a%20b');
    expect(decodeURIComponent(whatsappUrl(null, text).split('?text=')[1])).toBe(text);
  });
});

describe('renderDriverPackPdf', () => {
  it('renders a PDF with each load starting on a new page', async () => {
    const d = withSplitAndNoLocation();
    const m = driverPackModel(d, OPTS);
    const all = await renderDriverPackPdf(m);
    expect(all.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    const pages = pageCount(all);
    expect(pages).toBeGreaterThanOrEqual(d.loads.length);
    // Sections never share a page: the pack has exactly the pages of its loads rendered alone.
    let sum = 0;
    for (const l of d.loads) sum += pageCount(await renderDriverPackPdf(driverPackModel(d, { ...OPTS, loadIds: [l.id] })));
    expect(pages).toBe(sum);

    const text = pageTexts(all);
    expect(text).toHaveLength(pages);
    expect(text[0]).toContain(sq('Truck T01 — Trip 1 of 2'));
    expect(text[0]).toContain(sq('Salim Al Harthy'));
    expect(text[0]).toContain(sq('No location - call dispatcher'));
    expect(text[0]).toContain(sq('void if a newer plan version is issued'));
    expect(text[0]).toContain(sq('Load check:'));
    expect(text.some((t) => t.includes(sq('SPLIT DELIVERY - part 1 of 2 (part 2 on T01 trip 2)')))).toBe(true);
    expect(text.find((t) => t.includes(sq('Truck T01 — Trip 2 of 2')))).toBeTruthy();
    for (const t of text) expect(t).not.toMatch(/OMR|cost|margin|revenue/i);
  });

  it('never leaves the return line and sign-off alone on a page, and repeats the header on continuation pages', async () => {
    let sawContinuation = false;
    for (let n = 1; n <= 16; n++) {
      const buf = await renderDriverPackPdf(driverPackModel(longLoad(n), OPTS));
      const text = pageTexts(buf);
      expect(text[text.length - 1]).toContain(sq('Return to depot MCT'));
      expect(text[text.length - 1]).toContain(sq('Loaded by:'));
      text.forEach((t, i) => {
        // Every page carries at least one stop row, the compact header and its page number.
        expect(t, `n=${n} page ${i + 1}`).toContain(sq('Cases received:'));
        expect(t).toContain(sq('Driver sheet · Truck T09 · Trip 1 of 1'));
        expect(t).toContain(sq(`Page ${i + 1} / ${text.length}`));
      });
      if (text.length > 1) {
        sawContinuation = true;
        expect(text[1]).not.toContain(sq('Load check:')); // the full header is on the first page only
        expect(text[1]).toContain(sq('Sales order')); // the column header repeats
      }
    }
    expect(sawContinuation).toBe(true);
  }, 60_000);

  it('draws QR codes as one vector path', () => {
    const q = qrPath('https://www.google.com/maps/search/?api=1&query=23.5859,58.3829');
    expect(q.size).toBeGreaterThanOrEqual(21);
    expect(q.d.startsWith('M0 0H7V1H0Z')).toBe(true); // top-left finder pattern row
  });
});

describe('text the built-in font cannot print', () => {
  it('keeps Latin text, swaps look-alikes and marks each unprintable run once', () => {
    expect(pdfSafe('Café Mañana – 2×')).toEqual({ text: 'Café Mañana – 2×', lost: false });
    expect(pdfSafe('Zeta هايبر Market')).toEqual({ text: `Zeta ${UNPRINTABLE} Market`, lost: true });
    expect(pdfSafe('لولو هايبر ماركت Lulu')).toEqual({ text: '[?] Lulu', lost: true });
    expect(pdfSafe('السيب، شارع 18')).toEqual({ text: '[?] 18', lost: true });
    expect(pdfSafe('Gate 🚚 3')).toEqual({ text: 'Gate [?] 3', lost: true });
    expect(pdfSafe('Łódź Store')).toEqual({ text: 'Lódz Store', lost: false });
    expect(pdfSafe('Call before → gate 2 ✓')).toEqual({ text: 'Call before -> gate 2 OK', lost: false });
    expect(pdfSafe('Bldg ٣٤')).toEqual({ text: 'Bldg 34', lost: false });
    expect(pdfSafe('A\u200fB\u00adC')).toEqual({ text: 'ABC', lost: false }); // direction mark, soft hyphen
    expect(pdfSafe('line 1\nline 2\tend ')).toEqual({ text: 'line 1 line 2 end', lost: false });
    expect(pdfSafe('Cafe\u0301')).toEqual({ text: 'Café', lost: false });
  });

  it('cleans every text of the sheet and flags the sheets that lost some', () => {
    const d = fixture();
    d.loads[0].stops[0] = { ...d.loads[0].stops[0], customerName: 'Zeta هايبر Market', address: 'Łódź Store, شارع 18', notes: ['Call before → gate 2 ✓'] };
    const m = driverPackModel(d, OPTS);
    const st = m.sheets[0].stops[0];
    expect(st.customerName).toBe('Zeta [?] Market');
    expect(st.address).toBe('Lódz Store, [?] 18');
    expect(st.notes).toEqual(['Call before -> gate 2 OK']);
    expect(m.sheets.map((s) => s.unprintable)).toEqual([true, false, false]);
    // The tenant name is printed on every sheet.
    const t = driverPackModel(fixture(), { tenantName: 'شركة NMWC' });
    expect(t.tenantName).toBe('[?] NMWC');
    expect(t.sheets.every((s) => s.unprintable)).toBe(true);
    // Driver, truck, SKU and sales-order texts too.
    const d2 = fixture();
    d2.loads[0] = { ...d2.loads[0], driverName: 'سالم Salim', truckCode: 'T01', manifest: [{ ...d2.loads[0].manifest[0], productCode: 'مياه-1' }] };
    const s2 = driverPackModel(d2, OPTS).sheets[0];
    expect(s2.driverName).toBe('[?] Salim');
    expect(s2.loadCheck.items[0].productCode).toBe('[?]-1');
  });

  it('draws only characters Helvetica has, and the Latin text around the rest stays intact', async () => {
    const d = fixture();
    d.loads = [{ ...d.loads[0], stops: [{ ...d.loads[0].stops[0], customerName: 'Zeta هايبر Market', address: 'Łódź Store 🚚' }, d.loads[0].stops[1]] }];
    const buf = await renderDriverPackPdf(driverPackModel(d, OPTS));
    for (const hex of pageTextHex(buf).flat()) {
      expect(hex.length % 2, hex).toBe(0); // a character past 0xFF was written as 3+ hex digits before
      for (const b of Buffer.from(hex, 'hex')) expect(WIN_ANSI_OK(b), `byte ${b.toString(16)} in <${hex}>`).toBe(true);
    }
    const text = pageTexts(buf)[0];
    expect(text).toContain(sq('Zeta [?] Market'));
    expect(text).toContain(sq('Lódz Store [?]'));
    expect(text).toContain(sq('[?] = text this sheet cannot print (for example Arabic letters) - ask the dispatcher.'));
    // A sheet without such text carries no such note.
    expect(pageTexts(await renderDriverPackPdf(driverPackModel(fixture(), OPTS)))[0]).not.toContain(sq('cannot print'));
  });
});

describe('WhatsApp safeguards and driver clashes', () => {
  it('a message from a replaced plan version says so first', () => {
    const d = fixture();
    const replaced = whatsappText({ ...d.run, status: 'SUPERSEDED' }, d.loads[0], 2);
    expect(replaced.split('\n')[0]).toBe(REPLACED_LINE);
    expect(REPLACED_LINE).toContain('DO NOT USE');
    expect(replaced.split('\n')[1]).toBe('*Truck T01 - Trip 1 of 2*');
    expect(whatsappText(d.run, d.loads[0], 2)).not.toContain('DO NOT USE');
  });

  it('adds the country code to a local phone number, or lets the dispatcher pick the chat', () => {
    expect(whatsappNumber('9123 4567', '968')).toBe('96891234567');
    expect(whatsappUrl('9123 4567', 'hi', '968')).toBe('https://wa.me/96891234567?text=hi');
    // No calling code known: never "wa.me/91234567" (= +91, India).
    expect(whatsappNumber('9123 4567')).toBeNull();
    expect(whatsappUrl('9123 4567', 'hi')).toBe('https://wa.me/?text=hi');
    expect(whatsappNumber('050 123 4567', '971')).toBe('971501234567'); // UAE local, leading 0 dropped
    expect(whatsappNumber('96891234567', '971')).toBe('96891234567'); // country code already there
    expect(whatsappNumber('+968 9123 4567', '971')).toBe('96891234567');
    expect(whatsappNumber('00968 9123-4567', null)).toBe('96891234567');
    expect(whatsappNumber('', '968')).toBeNull();
    expect(whatsappNumber(null, '968')).toBeNull();
    expect(whatsappNumber(' - ', '968')).toBeNull();

    expect(phoneCountryCode('Oman')).toBe('968');
    expect(phoneCountryCode('Sultanate of Oman')).toBe('968');
    expect(phoneCountryCode('')).toBe('968'); // blank = NMWC default, as isOmanUae
    expect(phoneCountryCode('UAE')).toBe('971');
    expect(phoneCountryCode('United Arab Emirates')).toBe('971');
    expect(phoneCountryCode('الامارات')).toBe('971');
    expect(phoneCountryCode('Germany')).toBeNull();
  });

  it('warns when one driver is on two trucks at the same time', () => {
    const d = fixture(); // T01 L1 and the long truck's L1 both name Salim, 06:00-09:25
    const notes = driverClashNotes(d.loads);
    expect(notes).toEqual([
      { driverId: 'drv1', loadIds: ['L1', 'L3'], text: `Salim Al Harthy is on T01 · L1 (06:00–09:25) and ${LONG_TRUCK} · L1 (06:00–09:25) at the same time.` },
    ]);
    d.loads[2] = { ...d.loads[2], driverId: null, driverName: null };
    expect(driverClashNotes(d.loads)).toEqual([]);
    // Trips of one truck never clash.
    d.loads[1] = { ...d.loads[1], driverId: 'drv1', driverName: 'Salim Al Harthy' };
    expect(driverClashNotes(d.loads)).toEqual([]);
  });
});

describe('frozen plan facts and unverified times on the sheet (review F08 / F04)', () => {
  /** L1's first stop: its pin was corrected after planning; L2's truck-day breaks a rule. */
  function changedAndUnverified(): PlanDetail {
    const d = fixture();
    const s = d.loads[0].stops[0];
    d.loads[0].stops[0] = {
      ...s,
      masterChanged: [
        { kind: 'LOCATION', text: 'Location updated after planning: new pin 23.60100, 58.39000 (1.8 km from the planned one)', newLat: 23.601, newLng: 58.39, movedM: 1800 },
        { kind: 'HOURS', text: 'Receiving hours changed after planning: now receives 07:00–12:00 (planned with 06:00–14:00)' },
      ],
    };
    d.loads[1] = { ...d.loads[1], timing: { status: 'VIOLATED', ok: false } };
    return d;
  }

  it('keeps the planned pin and says the location was updated after planning, with the new pin', () => {
    const m = driverPackModel(changedAndUnverified(), OPTS);
    const st = m.sheets[0].stops[0];
    expect(st.pinUrl).toBe(pinUrl({ lat: ORDERS[0].lat, lng: ORDERS[0].lng })); // the planned destination
    expect(st.changeNotes[0]).toMatch(/^Location updated after planning: new pin 23\.60100, 58\.39000/);
    expect(st.changeNotes[1]).toMatch(/^Receiving hours changed after planning/);
    expect(st.newPinUrl).toBe(pinUrl({ lat: 23.601, lng: 58.39 }));
    expect(m.sheets[1].stops.every((x) => x.changeNotes.length === 0 && x.newPinUrl === null)).toBe(true);
  });

  it('marks the sheets of a truck whose times are not verified, and only those', async () => {
    const d = changedAndUnverified();
    const m = driverPackModel(d, OPTS);
    expect(m.timesNotVerified).toBe(true);
    expect(m.sheets.map((x) => x.timesNotVerified)).toEqual([false, true, false]);
    expect(m.sheets[1].badges).toContain('TIMES NOT VERIFIED');
    const text = pageTexts(await renderDriverPackPdf(m));
    expect(text.filter((t) => t.includes(sq('TIMES NOT VERIFIED - the departure or delivery times of this truck break a planning rule'))).length).toBeGreaterThanOrEqual(1);
    expect(text[0]).not.toContain(sq('TIMES NOT VERIFIED'));
    expect(text[0]).toContain(sq('Location updated after planning: new pin'));
    expect(text[0]).toContain(sq('Open the new pin'));
    expect(driverPackModel(fixture(), OPTS).timesNotVerified).toBe(false);
  });
});
