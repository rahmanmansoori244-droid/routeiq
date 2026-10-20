/**
 * Warehouse paperwork (owner request 12 Oct 2026) - pure (no DB): the load sheet and return note
 * models, field by field, and the printable page (escaping, the one allowed script, one section per
 * load).
 */
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { PlanDetail } from '@/lib/dispatch/plan-detail';
import type { OutcomeOverlay, OverlayStop } from '@/lib/delivery/outcome-view';
import { loadSheetModel, NO_INVOICE, returnNoteModel, stopInvoices } from '@/lib/dispatch/warehouse-sheets';
import { esc, PRINT_SCRIPT_HASH, renderLoadSheetHtml, renderReturnNoteHtml, SHEET_CSP } from '@/lib/dispatch/warehouse-sheets-html';
import { busyFixture, fixture, INSTRUCTED, instructionFixture, LONG_TRUCK } from './plan-detail-fixture';

const OPTS = { tenantName: 'NMWC Test' };

function overlayStop(over: Partial<OverlayStop>): OverlayStop {
  return {
    state: 'DONE',
    outcome: null,
    reason: null,
    reasonText: null,
    note: null,
    source: 'driver',
    by: null,
    outcomeAt: null,
    arrivedAt: null,
    arrivalSource: null,
    arrivalObserved: true,
    arrivalNote: null,
    departedAt: null,
    departureGap: false,
    departedAtOutcome: false,
    departureNote: null,
    actualMin: null,
    actualLabel: null,
    awayMin: null,
    plannedMin: null,
    autoTimed: false,
    timingSuspect: false,
    casesPlanned: 0,
    casesDelivered: null,
    lines: [],
    photos: [],
    photoMissing: 0,
    noPhotoReason: null,
    noPhotoText: null,
    late: false,
    carriedTo: null,
    carryConflict: null,
    downgradedArrival: false,
    visitId: 'v',
    ...over,
  };
}

function overlay(stops: Record<string, OverlayStop>, loads: Record<string, string | null> = {}): OutcomeOverlay {
  return {
    runId: 'run',
    date: '2026-09-25',
    depotId: 'd',
    tz: 'Asia/Muscat',
    loads: Object.fromEntries(
      Object.entries(loads).map(([id, back]) => [id, { done: 0, total: 0, delivered: 0, notDelivered: 0, partly: 0, noResult: 0, backAtDepotAt: back, driverLink: null, cameraFailedToday: 0 }]),
    ),
    stops,
    summary: {} as OutcomeOverlay['summary'],
    noOutcome: [],
    copyConflicts: {},
    lockWarnings: {},
    cameraExceptions: [],
    cameraAlerts: [],
    turnarounds: {},
  };
}

describe('loadSheetModel', () => {
  it('has one sheet per load, in plan order, with the products to load and every invoice', () => {
    const d = fixture();
    const m = loadSheetModel(d, OPTS);
    expect(m.title).toBe('Load sheets 2026-09-25 v2');
    expect(m.sheets.map((s) => [s.loadId, s.truckCode, s.trip, s.trips])).toEqual([
      ['L1', 'T01', 1, 2],
      ['L2', 'T01', 2, 2],
      ['L3', LONG_TRUCK, 1, 1],
    ]);
    const s1 = m.sheets[0];
    expect(s1.products.map((p) => `${p.productCode}x${p.cases}`)).toEqual(['JAB-1500-6x20', 'TAN-500-24x80', 'TAN-5Gx10']);
    expect(s1.totalCases).toBe(110);
    expect(s1.invoices.map((i) => [i.stop, i.invoiceNo, i.customerName, i.cases])).toEqual([
      [1, 'SO-1001', 'Lumo Hypermarket Bausher', 70],
      [2, 'SO-1002', 'Al Fawz Qurum', 40],
    ]);
    expect(s1.invoices[0].lines.map((l) => `${l.productCode}x${l.cases}`)).toEqual(['JAB-1500-6x20', 'TAN-500-24x50']);
    expect(s1.invoices[0].branchCode).toBe('B1');
    expect(s1.matches).toBe(true);
    // A subset keeps plan order.
    expect(loadSheetModel(d, { ...OPTS, loadIds: ['L3', 'L1'] }).sheets.map((s) => s.loadId)).toEqual(['L1', 'L3']);
  });

  it('says a planned load is not locked yet, and a locked one is', () => {
    const d = fixture();
    d.loads[0] = { ...d.loads[0], status: 'PLANNED' };
    d.loads[1] = { ...d.loads[1], status: 'LOCKED' };
    const [a, b] = loadSheetModel(d, OPTS).sheets;
    expect(a.notLocked).toBe(true);
    expect(a.statusText).toMatch(/do not load yet/);
    expect(b.notLocked).toBe(false);
    expect(b.statusText).toBe('LOCKED');
  });

  it('lists each invoice of a stop on its own row, and a line without a number as such', () => {
    const d = fixture();
    const s = d.loads[0].stops[0];
    d.loads[0].stops[0] = {
      ...s,
      orderLines: [
        { ...s.orderLines[0], salesOrderNo: 'INV-1' },
        { ...s.orderLines[1], salesOrderNo: 'INV-2' },
        { ...s.orderLines[1], lineId: 'x', salesOrderNo: null, cases: 3 },
      ],
    };
    const rows = stopInvoices(d.loads[0].stops[0]);
    expect(rows.map((r) => [r.invoiceNo, r.cases])).toEqual([
      ['INV-1', 50],
      ['INV-2', 20],
      [NO_INVOICE, 3],
    ]);
  });

  it('marks a split delivery and a superseded version', () => {
    const d = fixture();
    d.loads[2].stops[0] = { ...d.loads[2].stops[0], split: { part: 1, parts: 2, restUnserved: false } };
    d.run = { ...d.run, status: 'SUPERSEDED' };
    const m = loadSheetModel(d, OPTS);
    expect(m.superseded).toBe(true);
    expect(m.sheets[2].invoices[0].split).toBe('part 1 of 2');
    expect(renderLoadSheetHtml(m)).toContain('VOID: a newer plan version exists');
  });

  it('says when the rest of a split order is not on a truck today, never just "part 1 of 1" (review of PR 66)', () => {
    const d = fixture();
    d.loads[2].stops[0] = { ...d.loads[2].stops[0], split: { part: 1, parts: 1, restUnserved: true } };
    const m = loadSheetModel(d, OPTS);
    expect(m.sheets[2].invoices[0].split).toBe('part 1 of 1 - the rest is NOT on a truck today');
    expect(renderLoadSheetHtml(m)).toContain('split delivery: part 1 of 1 - the rest is NOT on a truck today');
  });

  it('marks orders brought forward to a later day: not to be loaded from this paper (review of PR 66)', () => {
    const plain = loadSheetModel(fixture(), OPTS);
    expect(plain.sheets[0].carriedAway).toBe(0);
    expect(plain.sheets[0].invoices[0].carried).toBeNull();
    expect(renderLoadSheetHtml(plain)).not.toContain('brought forward');

    const d = fixture();
    d.loads[0] = { ...d.loads[0], status: 'LOCKED', carriedAway: 1, stops: [{ ...d.loads[0].stops[0], carriedTo: '2026-09-26' }, ...d.loads[0].stops.slice(1)] };
    const m = loadSheetModel(d, OPTS);
    expect(m.sheets[0].carriedAway).toBe(1);
    expect(m.sheets[0].carriedToDays).toBe('26 Sep');
    expect(m.sheets[0].invoices[0].carried).toBe('CARRIED OVER to 26 Sep - not delivered on this day');
    const html = renderLoadSheetHtml(m);
    expect(html).toContain('1 order(s) on this load were brought forward to 26 Sep: do not load them from this paper');
    expect(html).toContain('<b>CARRIED OVER to 26 Sep - not delivered on this day</b>');
  });
});

describe('returnNoteModel', () => {
  function dayWithResults(): { d: PlanDetail; o: OutcomeOverlay } {
    const d = fixture();
    d.loads[0] = { ...d.loads[0], status: 'DISPATCHED' };
    d.loads[1] = { ...d.loads[1], status: 'COMPLETED' };
    // L3 stays PLANNED: it never left, so it has no return note.
    const o = overlay(
      {
        'L1:1': overlayStop({
          outcome: 'DELIVERED',
          casesPlanned: 70,
          casesDelivered: 70,
          lines: [
            { orderId: 'o1', lineId: 'o1-l1', productCode: 'TAN-500-24', plannedCases: 50, deliveredCases: 50 },
            // No delivered figure on a Delivered result: delivered, as Bring forward counts it.
            { orderId: 'o1', lineId: 'o1-l2', productCode: 'JAB-1500-6', plannedCases: 20, deliveredCases: null },
          ],
        }),
        'L1:2': overlayStop({
          outcome: 'PARTLY_DELIVERED',
          reason: 'DAMAGED_GOODS',
          reasonText: 'Damaged goods',
          casesPlanned: 40,
          casesDelivered: 20,
          lines: [
            { orderId: 'o2', lineId: 'o2-l1', productCode: 'TAN-500-24', plannedCases: 30, deliveredCases: 20 },
            { orderId: 'o2', lineId: 'o2-l2', productCode: 'TAN-5G', plannedCases: 10, deliveredCases: 0 },
          ],
        }),
        'L2:1': overlayStop({
          outcome: 'NOT_DELIVERED',
          reason: 'SHOP_CLOSED',
          reasonText: 'Shop closed',
          casesPlanned: 60,
          casesDelivered: 0,
          lines: [{ orderId: 'o3', lineId: 'o3-l1', productCode: 'JAB-1500-6', plannedCases: 60, deliveredCases: null }],
        }),
        // L2:2 has no result.
      },
      { L1: '2026-09-25T11:58:00.000Z', L2: null },
    );
    return { d, o };
  }

  it('has one note per load that left, with what came back per customer and the reason', () => {
    const { d, o } = dayWithResults();
    const m = returnNoteModel(d, o, OPTS);
    expect(m.notes.map((n) => n.loadId)).toEqual(['L1', 'L2']);
    const [n1, n2] = m.notes;
    expect(n1.backAt).toBe('15:58');
    expect(n1.notBack).toBe(false);
    expect(n1.stops.map((s) => [s.customerName, s.result, s.delivered, s.returned])).toEqual([
      ['Lumo Hypermarket Bausher', 'Delivered', 70, 0],
      ['Al Fawz Qurum', 'Partly delivered', 20, 20],
    ]);
    expect(n1.returnStops.map((s) => s.stop)).toEqual([2]);
    expect(n1.returnStops[0].reason).toBe('Damaged goods');
    expect(n1.returnStops[0].invoices).toEqual(['SO-1002']);
    expect(n1.returnedByProduct.map((p) => `${p.productCode}x${p.cases}`)).toEqual(['TAN-500-24x10', 'TAN-5Gx10']);
    expect([n1.totalPlanned, n1.totalDelivered, n1.totalReturned]).toEqual([110, 90, 20]);

    // Not delivered: everything comes back, whatever the line says. A stop without a result is flagged.
    expect(n2.stops[0]).toMatchObject({ result: 'Not delivered', reason: 'Shop closed', delivered: 0, returned: 60 });
    expect(n2.stops[1]).toMatchObject({ result: 'NO RESULT', noResult: true, delivered: null, returned: null });
    expect(n2.noResultStops).toBe(1);
    expect(n2.returnStops.map((s) => s.stop)).toEqual([1, 2]);
    // Completed: back, even without the driver's Back at depot tap.
    expect(n2.notBack).toBe(false);
    expect(n2.backAt).toBeNull();
  });

  it('says when Back at depot is not recorded (the truck may still be out)', () => {
    const { d, o } = dayWithResults();
    o.loads.L1.backAtDepotAt = null;
    expect(returnNoteModel(d, o, OPTS).notes[0].notBack).toBe(true);
    expect(renderReturnNoteHtml(returnNoteModel(d, o, OPTS))).toContain('Back at depot is not recorded yet: if the truck is still out, the results may still change.');
  });

  it('prints the goods to come back with a box to count at the gate, and the stop without a result', () => {
    const { d, o } = dayWithResults();
    const html = renderReturnNoteHtml(returnNoteModel(d, o, OPTS));
    expect(html.match(/<section class="sheet">/g)).toHaveLength(2);
    expect(html).toContain('RETURN NOTE · gate pass · T01 · trip 1 of 2');
    expect(html).toContain('Counted at gate');
    expect(html).toContain('Supervisor informed');
    expect(html).toContain('1 stop without a result');
    expect(html).toContain('? (of 40)');
  });
});

describe('the printable page', () => {
  it('escapes every text from the data and keeps Arabic names as they are', () => {
    const d = fixture();
    d.loads[0].stops[0] = { ...d.loads[0].stops[0], customerName: '<script>alert(1)</script> & "x"' };
    d.loads[0].stops[1] = { ...d.loads[0].stops[1], customerName: 'هايبر ماركت النمر' };
    const html = renderLoadSheetHtml(loadSheetModel(d, OPTS));
    expect(html).not.toContain('<script>alert(1)');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt; &amp; &quot;x&quot;');
    expect(html).toContain('<bdi>هايبر ماركت النمر</bdi>');
    expect(esc("a'b")).toBe('a&#39;b');
  });

  it('runs only its Print script, allowed by hash in the policy', () => {
    const html = renderLoadSheetHtml(loadSheetModel(fixture(), OPTS));
    const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
    expect(scripts).toHaveLength(1);
    expect(`sha256-${createHash('sha256').update(scripts[0]).digest('base64')}`).toBe(PRINT_SCRIPT_HASH);
    expect(SHEET_CSP).toContain(`script-src '${PRINT_SCRIPT_HASH}'`);
    expect(SHEET_CSP).toContain("default-src 'none'");
    expect(html.match(/<section class="sheet">/g)).toHaveLength(3);
    expect(html).toContain('LOAD SHEET · T01 · trip 1 of 2');
    expect(html).toContain('Invoice in truck');
  });
});

// ---------------------------------------------------------------------------------------
// Loading instruction (owner request 16 Oct 2026, lib/dispatch/loading-instruction.ts)
// ---------------------------------------------------------------------------------------

const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const WATER = 'Water at the bottom, max 5 layers';
/** The invented customers of L1 stops 1 and 2 (instructionFixture). */
const [C1, C2] = [INSTRUCTED.a.customerName, INSTRUCTED.b.customerName];

/** The fixture's L1 with its customers' instructions: C100 / B1 (stop 1) and C200 (stop 2). */
function withInstructions(texts: Record<number, string>, d: PlanDetail = instructionFixture()): PlanDetail {
  d.loads[0] = { ...d.loads[0], stops: d.loads[0].stops.map((s) => (texts[s.sequence] ? { ...s, loadingInstruction: texts[s.sequence] } : s)) };
  return d;
}

describe('loading instruction on the load sheet (owner request 16 Oct 2026)', () => {
  it('a day without instructions prints byte for byte what it printed before the feature (pinned at 76fcb57)', () => {
    // SHA-256 of the models and pages as main printed them on 16 Oct 2026 before this feature, for the plain
    // fixture and for one with every other mark of the sheet (VOID, brought forward, cancelled, small truck,
    // split). If a later change alters the sheets on purpose, replace the hash with the one the failure shows.
    const plain = loadSheetModel(fixture(), OPTS);
    expect(sha(JSON.stringify(plain))).toBe('426f250d089e305d6a8bd6409803c31a8517dd6c1893cdca72bea724a50cbf9a');
    expect(sha(renderLoadSheetHtml(plain))).toBe('296fb821ecc123ad18b68ff211aa8a0aa180fed5f0230d725ed7e8d0491e28c4');
    const busy = loadSheetModel(busyFixture(), OPTS);
    expect(sha(JSON.stringify(busy))).toBe('5fbb93b7c5a014147a898a4482d0a770503b928e7ac5eb70df232d1f2fd2f0e8');
    expect(sha(renderLoadSheetHtml(busy))).toBe('a2096b46b6c469bd173aec18f72ffe88a1e9e22da9d1a1806d557a3d8ca006f5');
    // The return note shares the page and its style: unchanged too.
    const d = fixture();
    d.loads[0] = { ...d.loads[0], status: 'DISPATCHED' };
    const none = { runId: 'r', date: '2026-09-25', depotId: 'd', tz: 'Asia/Muscat', loads: {}, stops: {}, summary: {}, noOutcome: [], copyConflicts: {}, lockWarnings: {}, cameraExceptions: [], cameraAlerts: [] };
    expect(sha(renderReturnNoteHtml(returnNoteModel(d, none as unknown as OutcomeOverlay, OPTS)))).toBe('aeca18967bc4bcebc51367ef8d5cffc27f95fe00769c5a587ac7094dfd9ac72f');
    for (const s of [...plain.sheets, ...busy.sheets]) {
      expect('loadingInstructions' in s).toBe(false);
      expect(s.invoices.some((i) => 'loadingInstruction' in i)).toBe(false);
    }
  });

  it('the model: one line per customer with its stops; the tag on its invoices', () => {
    const d = withInstructions({ 1: WATER });
    // The same customer again on stop 3 of this load (a second visit): one line, both stops.
    const first = d.loads[0].stops[0];
    d.loads[0].stops.push({ ...first, sequence: 3, orderIds: ['o1b'], orderLines: first.orderLines.map((l) => ({ ...l, orderId: 'o1b', salesOrderNo: 'SO-1001B' })) });
    const s = loadSheetModel(d, OPTS).sheets[0];
    expect(s.loadingInstructions).toEqual([{ stops: [1, 3], customerId: 'c100', customerName: C1, customerCode: 'C100', branchCode: 'B1', text: WATER }]);
    expect(s.invoices.map((i) => [i.stop, i.invoiceNo, i.loadingInstruction ?? null])).toEqual([
      [1, 'SO-1001', WATER],
      [2, 'SO-1002', null],
      [3, 'SO-1001B', WATER],
    ]);
    // The other loads have none.
    expect(loadSheetModel(d, OPTS).sheets.slice(1).map((x) => 'loadingInstructions' in x)).toEqual([false, false]);
  });

  it('a stop whose orders are all cancelled or brought forward is not listed and its invoices have no tag', () => {
    const d = withInstructions({ 1: WATER, 2: 'Cartons on top only' });
    d.loads[0].stops[0] = { ...d.loads[0].stops[0], cancelled: true, cancelledOrderIds: ['o1'] };
    d.loads[0].stops[1] = { ...d.loads[0].stops[1], carriedTo: '2026-09-26', carriedOrderIds: ['o2'] };
    const s = loadSheetModel(d, OPTS).sheets[0];
    expect('loadingInstructions' in s).toBe(false);
    expect(s.invoices.some((i) => i.loadingInstruction)).toBe(false);
    expect(renderLoadSheetHtml(loadSheetModel(d, OPTS))).not.toContain('SPECIAL LOADING');
  });

  it('the page: a SPECIAL LOADING box between the title and the head box, every value escaped, names and texts isolated', () => {
    const d = withInstructions({ 1: '<script>alert(1)</script> & "x"', 2: 'الماء في الأسفل' });
    d.loads[0].stops[1] = { ...d.loads[0].stops[1], customerName: 'هايبر مثال' };
    const html = renderLoadSheetHtml(loadSheetModel(d, OPTS));
    const sheet1 = html.slice(html.indexOf('<section class="sheet">'), html.indexOf('</section>'));
    const h1 = sheet1.indexOf('<h1>');
    const box = sheet1.indexOf('<div class="instr" data-kind="loading-instruction">');
    const head = sheet1.indexOf('<div class="head">');
    expect(h1).toBeGreaterThanOrEqual(0);
    expect(box).toBeGreaterThan(h1);
    expect(head).toBeGreaterThan(box);
    expect(sheet1).toContain('<div class="instr-h">SPECIAL LOADING</div><div class="instr-sub">Load this truck as these customers require:</div>');
    expect(sheet1).toContain(
      `<li><span class="instr-stop">Stop 1</span> <bdi>${C1}</bdi> (C100 / B1): <bdi>&lt;script&gt;alert(1)&lt;/script&gt; &amp; &quot;x&quot;</bdi></li>`,
    );
    expect(sheet1).toContain('<li><span class="instr-stop">Stop 2</span> <bdi>هايبر مثال</bdi> (C200): <bdi>الماء في الأسفل</bdi></li>');
    expect(html).not.toContain('<script>alert(1)');
    // The tag on each of the customers' invoice rows.
    expect(sheet1.match(/<br><b>SPECIAL LOADING - see the box at the top<\/b>/g)).toHaveLength(2);
    // Only the first load has a box; the others print as before.
    expect(html.match(/data-kind="loading-instruction"/g)).toHaveLength(1);
    // Still only the Print script, allowed by its hash: the CSP does not change.
    const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
    expect(scripts).toHaveLength(1);
    expect(`sha256-${createHash('sha256').update(scripts[0]).digest('base64')}`).toBe(PRINT_SCRIPT_HASH);
  });

  it('prints in black and white: a thick border and large bold text, no shading; kept on one page; style only on pages with a box', () => {
    const html = renderLoadSheetHtml(loadSheetModel(withInstructions({ 1: WATER }), OPTS));
    expect(html).toContain('.instr { border: 4px solid #000;');
    expect(html).toContain('.instr-h { font-size: 22pt; font-weight: 700;');
    expect(html).toContain('@media print { .instr { break-inside: avoid; } }');
    const instrCss = html.slice(html.indexOf('.instr {'), html.indexOf('</style>'));
    expect(instrCss).not.toMatch(/background/);
    expect(html).toContain('<div class="instr-sub">Load this truck as this customer requires:</div>');
    expect(html).toContain(`<span class="instr-stop">Stop 1</span> <bdi>${C1}</bdi> (C100 / B1): <bdi>${WATER}</bdi>`);
    expect(renderLoadSheetHtml(loadSheetModel(fixture(), OPTS))).not.toContain('.instr');
  });

  it('on a VOID paper the box comes after the VOID banner, so "do not load" is read first (review L3); NOT LOCKED keeps its place', () => {
    const d = withInstructions({ 1: WATER });
    d.run = { ...d.run, status: 'SUPERSEDED', supersededAt: '2026-09-25T01:00:00.000Z' };
    d.loads[0] = { ...d.loads[0], status: 'PLANNED' };
    const html = renderLoadSheetHtml(loadSheetModel(d, OPTS));
    const sheet1 = html.slice(html.indexOf('<section class="sheet">'), html.indexOf('</section>'));
    const head = sheet1.indexOf('<div class="head">');
    const voidAt = sheet1.indexOf('VOID: a newer plan version exists');
    const box = sheet1.indexOf('data-kind="loading-instruction"');
    const notLocked = sheet1.indexOf('NOT LOCKED: this load may still change');
    expect(head).toBeLessThan(voidAt);
    expect(voidAt).toBeLessThan(box);
    expect(box).toBeLessThan(notLocked);
  });

  it('a 200-character instruction without spaces wraps inside the box (overflow-wrap)', () => {
    const html = renderLoadSheetHtml(loadSheetModel(withInstructions({ 1: 'X'.repeat(200) }), OPTS));
    expect(html).toContain('overflow-wrap: anywhere');
    expect(html).toContain(`<bdi>${'X'.repeat(200)}</bdi>`);
  });
});

// ---------------------------------------------------------------------------------------
// Special-loading lines (owner request 20 Oct 2026, lib/dispatch/loading-split.ts): the products of a load
// with such customers split into the normal lines and one block per instruction, never to be subtracted.
// ---------------------------------------------------------------------------------------

describe('special-loading lines on the load sheet (owner request 20 Oct 2026)', () => {
  const SPECIAL = 'SPECIAL';
  const sheet1 = (html: string) => html.slice(html.indexOf('<section class="sheet">'), html.indexOf('</section>'));
  const sections = (html: string) => html.split('<section class="sheet">').slice(1).map((s) => s.slice(0, s.indexOf('</section>')));

  it('the model: the normal lines and one block per instruction, product code order; normal + blocks = the products, the total unchanged', () => {
    const s = loadSheetModel(withInstructions({ 1: SPECIAL }), OPTS).sheets[0]!;
    expect(s.products.map((p) => `${p.productCode}x${p.cases}`)).toEqual(['JAB-1500-6x20', 'TAN-500-24x80', 'TAN-5Gx10']);
    expect(s.totalCases).toBe(110);
    expect(s.matches).toBe(true);
    expect(s.loadingSplit).toEqual({
      normal: [
        { productCode: 'TAN-500-24', productName: 'Tanuf 500ml x24', cases: 30 },
        { productCode: 'TAN-5G', productName: 'Tanuf 5 gallon', cases: 10 },
      ],
      normalCases: 40,
      groups: [
        {
          text: SPECIAL,
          tag: SPECIAL,
          stops: [1],
          products: [
            { productCode: 'JAB-1500-6', productName: 'Jabal 1.5L x6', cases: 20 },
            { productCode: 'TAN-500-24', productName: 'Tanuf 500ml x24', cases: 50 },
          ],
          cases: 70,
        },
      ],
    });
    const split = s.loadingSplit!;
    expect(split.normalCases + split.groups.reduce((a, g) => a + g.cases, 0)).toBe(s.totalCases);
    for (const p of s.products) {
      const parts = [...split.normal, ...split.groups.flatMap((g) => g.products)].filter((x) => x.productCode === p.productCode);
      expect(parts.reduce((a, x) => a + x.cases, 0)).toBe(p.cases);
    }
    expect('loadingSplitMismatch' in s).toBe(false);
    // The other loads have no customer with an instruction: no split.
    expect(loadSheetModel(withInstructions({ 1: SPECIAL }), OPTS).sheets.slice(1).map((x) => 'loadingSplit' in x)).toEqual([false, false]);
  });

  it('the page: normal heading, its rows, its total, then the framed block (heading, tagged rows, total), then the truck total', () => {
    const html = renderLoadSheetHtml(loadSheetModel(withInstructions({ 1: SPECIAL }), OPTS));
    const s1 = sheet1(html);
    const products = s1.slice(s1.indexOf('<h2>1. Products to load</h2>'), s1.indexOf('<h2>2. Invoices'));
    const order = [
      '<p class="muted">Load the normal lines as usual. Load each block below separately, as the SPECIAL LOADING box says',
      '<tr class="sub-h"><td colspan="4">NORMAL LOADING - every other customer</td></tr>',
      '<tr><td>TAN-500-24</td><td>Tanuf 500ml x24</td><td class="n">30</td><td class="box"></td></tr>',
      '<tr><td>TAN-5G</td><td>Tanuf 5 gallon</td><td class="n">10</td><td class="box"></td></tr>',
      '<tr class="sub"><td colspan="2">Normal loading total</td><td class="n">40</td><td></td></tr>',
      '<tbody class="split" data-kind="special-loading-lines"><tr class="split-h"><td colspan="4"><span class="split-tag"><bdi>SPECIAL</bdi></span> load separately, as the SPECIAL LOADING box says · Stop 1</td></tr>',
      '<tr class="split-row"><td>JAB-1500-6</td><td><span class="split-tag"><bdi>SPECIAL</bdi></span> Jabal 1.5L x6</td><td class="n">20</td><td class="box"></td></tr>',
      '<tr class="split-row"><td>TAN-500-24</td><td><span class="split-tag"><bdi>SPECIAL</bdi></span> Tanuf 500ml x24</td><td class="n">50</td><td class="box"></td></tr>',
      '<tr class="sub split-total"><td colspan="2"><bdi>SPECIAL total</bdi></td><td class="n">70</td><td></td></tr></tbody>',
      '<tbody><tr class="total"><td colspan="2">Total on this truck (normal + special loading)</td><td class="n">110</td><td></td></tr></tbody></table>',
    ];
    const at = order.map((part) => products.indexOf(part));
    expect(at.every((i) => i >= 0), JSON.stringify(at)).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
    // The products are no longer also listed whole: TAN-500-24 x80 appears nowhere in the table.
    expect(products).not.toContain('<td class="n">80</td>');
    // Each block row carries the tag; the box and the invoice tag are still there.
    expect(products.match(/<tr class="split-row">/g)).toHaveLength(2);
    expect(s1).toContain('data-kind="loading-instruction"');
    expect(s1.match(/<br><b>SPECIAL LOADING - see the box at the top<\/b>/g)).toHaveLength(1);
    // The head box still says the truck's cases.
    expect(s1).toContain('<span><b>Cases:</b> 110</span>');
  });

  it('two texts: one block each, in box order; no normal lines when every customer has one', () => {
    const html = renderLoadSheetHtml(loadSheetModel(withInstructions({ 1: SPECIAL, 2: 'Cartons on top only' }), OPTS));
    const s1 = sheet1(html);
    expect(s1).not.toContain('NORMAL LOADING');
    expect(s1.match(/data-kind="special-loading-lines"/g)).toHaveLength(2);
    expect(s1.indexOf('<bdi>SPECIAL total</bdi>')).toBeLessThan(s1.indexOf('<bdi>Cartons on top only total</bdi>'));
    expect(s1).toContain('<tbody><tr class="total"><td colspan="2">Total on this truck (normal + special loading)</td><td class="n">110</td>');
  });

  it('every value escaped, tags and texts isolated (<bdi>); a long text gets a short tag and is printed once in the heading; still one script', () => {
    const evil = '<script>alert(1)</script> & "x" keep these at the back';
    const d = withInstructions({ 1: evil, 2: 'الماء في الأسفل' });
    const html = renderLoadSheetHtml(loadSheetModel(d, OPTS));
    expect(html).not.toContain('<script>alert(1)');
    const s1 = sheet1(html);
    // The tag: cut at 23 characters (no word ends in the cut), escaped; the whole text once in the block heading, escaped and isolated.
    expect(s1).toContain('<span class="split-tag"><bdi>&lt;script&gt;alert(1)&lt;/scrip…</bdi></span> load separately');
    expect(s1).toContain(' · Stop 1 - <bdi>&lt;script&gt;alert(1)&lt;/script&gt; &amp; &quot;x&quot; keep these at the back</bdi></td></tr>');
    expect(s1).toContain('<span class="split-tag"><bdi>الماء في الأسفل</bdi></span> load separately, as the SPECIAL LOADING box says · Stop 2</td></tr>');
    expect(s1).toContain('<bdi>الماء في الأسفل total</bdi>');
    const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
    expect(scripts).toHaveLength(1);
    expect(`sha256-${createHash('sha256').update(scripts[0]).digest('base64')}`).toBe(PRINT_SCRIPT_HASH);
  });

  it('black and white: a thick frame, bold rows, a bordered tag, never shading; the style only on pages with such lines', () => {
    const html = renderLoadSheetHtml(loadSheetModel(withInstructions({ 1: SPECIAL }), OPTS));
    expect(html).toContain('tbody.split { border: 4px solid #000; }');
    expect(html).toContain('.split-tag { border: 2px solid #000;');
    expect(html).toContain('@media print { tbody.split { break-inside: avoid; } }');
    const css = html.slice(html.indexOf('tbody.split {'), html.indexOf('</style>'));
    expect(css).not.toMatch(/background/);
    for (const plain of [fixture(), busyFixture(), instructionFixture()]) expect(renderLoadSheetHtml(loadSheetModel(plain, OPTS))).not.toMatch(/split-tag|tbody\.split|special-loading-lines/);
  });

  it('the other loads of the page print exactly as without the instruction', () => {
    const withSplit = sections(renderLoadSheetHtml(loadSheetModel(withInstructions({ 1: SPECIAL }), OPTS)));
    const plain = sections(renderLoadSheetHtml(loadSheetModel(instructionFixture(), OPTS)));
    expect(withSplit).toHaveLength(3);
    expect(withSplit.slice(1)).toEqual(plain.slice(1));
    expect(withSplit[0]).not.toEqual(plain[0]);
  });

  it('cancelled and brought-forward orders stay in the normal lines: their banners say so only on a load with such lines', () => {
    const d = withInstructions({ 1: SPECIAL });
    // Stop 2 (no instruction) cancelled: the block is unchanged, the banner says where its cases are.
    d.loads[0] = { ...d.loads[0], cancelledHere: 1, stops: [d.loads[0].stops[0], { ...d.loads[0].stops[1], cancelled: true, cancelledOrderIds: ['o2'] }] };
    const s = loadSheetModel(d, OPTS).sheets[0]!;
    expect(s.loadingSplit!.groups[0]!.cases).toBe(70);
    expect(s.loadingSplit!.normalCases).toBe(40);
    const html = sheet1(renderLoadSheetHtml(loadSheetModel(d, OPTS)));
    expect(html).toContain('Re-plan the day to take them off. Their cases are in the normal lines, never in the special-loading lines.</div>');
    // A brought-forward order of the special customer: its cases leave the block and stay in the normal lines.
    const c = withInstructions({ 1: SPECIAL });
    c.loads[0] = { ...c.loads[0], status: 'LOCKED', carriedAway: 1 };
    const first = c.loads[0].stops[0];
    c.loads[0].stops[0] = {
      ...first,
      orderIds: ['o1', 'o1x'],
      carriedTo: '2026-09-26',
      carriedOrderIds: ['o1x'],
      orderLines: [...first.orderLines, { orderId: 'o1x', lineId: 'o1x-l1', salesOrderNo: 'SO-1001X', productCode: 'TAN-5G', productName: 'Tanuf 5 gallon', cases: 5, weightKg: 100 }],
      skus: [...first.skus, { productCode: 'TAN-5G', productName: 'Tanuf 5 gallon', cases: 5, weightKg: 100 }],
    };
    c.loads[0].manifest = c.loads[0].manifest.map((m) => (m.productCode === 'TAN-5G' ? { ...m, cases: 15, weightKg: 300 } : m));
    const cs = loadSheetModel(c, OPTS).sheets[0]!;
    expect(cs.loadingSplit!.groups[0]!.products.map((p) => `${p.productCode}x${p.cases}`)).toEqual(['JAB-1500-6x20', 'TAN-500-24x50']);
    expect(cs.loadingSplit!.normal.map((p) => `${p.productCode}x${p.cases}`)).toEqual(['TAN-500-24x30', 'TAN-5Gx15']);
    expect(sheet1(renderLoadSheetHtml(loadSheetModel(c, OPTS)))).toContain('They are marked CARRIED OVER below. Their cases are in the normal lines, never in the special-loading lines.</div>');
    // Without such lines the banners are as before.
    const plain = fixture();
    plain.loads[0] = { ...plain.loads[0], cancelledHere: 1 };
    expect(renderLoadSheetHtml(loadSheetModel(plain, OPTS))).not.toContain('special-loading lines');
  });

  it('order lines that do not add up to the products: the products as before, the box, and a banner to load those customers from their invoices', () => {
    const d = withInstructions({ 1: SPECIAL });
    d.loads[0].stops[0] = { ...d.loads[0].stops[0], orderLines: d.loads[0].stops[0].orderLines.map((l) => ({ ...l, cases: l.cases * 10 })) };
    const s = loadSheetModel(d, OPTS).sheets[0]!;
    expect(s.loadingSplitMismatch).toBe(true);
    expect('loadingSplit' in s).toBe(false);
    const html = sheet1(renderLoadSheetHtml(loadSheetModel(d, OPTS)));
    expect(html).toContain(
      '<div class="banner">The special-loading lines could not be worked out (the invoices and the products differ): load those customers from their invoices and ask the dispatcher.</div>',
    );
    expect(html).toContain('<tr class="total"><td colspan="2">Total</td><td class="n">110</td>');
    expect(html).toContain('data-kind="loading-instruction"');
    expect(html).not.toContain('special-loading-lines');
  });
});
