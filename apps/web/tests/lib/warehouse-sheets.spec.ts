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
import { fixture, LONG_TRUCK } from './plan-detail-fixture';

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
      [1, 'SO-1001', 'Lulu Hypermarket Bausher', 70],
      [2, 'SO-1002', 'Al Fair Qurum', 40],
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
      ['Lulu Hypermarket Bausher', 'Delivered', 70, 0],
      ['Al Fair Qurum', 'Partly delivered', 20, 20],
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
    d.loads[0].stops[1] = { ...d.loads[0].stops[1], customerName: 'هايبر ماركت النور' };
    const html = renderLoadSheetHtml(loadSheetModel(d, OPTS));
    expect(html).not.toContain('<script>alert(1)');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt; &amp; &quot;x&quot;');
    expect(html).toContain('<bdi>هايبر ماركت النور</bdi>');
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
