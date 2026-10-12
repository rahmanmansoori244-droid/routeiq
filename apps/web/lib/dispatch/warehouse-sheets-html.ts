/**
 * The warehouse paperwork (warehouse-sheets.ts has the models) as one printable HTML page: A4
 * portrait, one page per truck load, black on white. The browser prints it, so customer names in
 * Arabic print as they are (the driver-sheet PDF prints Latin text only).
 *
 * Every text from the data is escaped (esc). The page runs one small script, the Print button, and
 * the export routes send it with a Content-Security-Policy that allows exactly that script (its
 * hash, PRINT_SCRIPT_HASH) and nothing else: no other script, no fetch, no images from anywhere.
 */
import { createHash } from 'node:crypto';
import type { LoadSheet, LoadSheetModel, ReturnNote, ReturnNoteModel, SheetHead } from './warehouse-sheets';

export function esc(s: string | number | null | undefined): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const PRINT_SCRIPT = "document.getElementById('print').addEventListener('click',function(){window.print()});";
/** The CSP hash of the page's only script (the Print button). */
export const PRINT_SCRIPT_HASH = `sha256-${createHash('sha256').update(PRINT_SCRIPT).digest('base64')}`;
/** The policy the export routes send with these pages. */
export const SHEET_CSP = `default-src 'none'; style-src 'unsafe-inline'; script-src '${PRINT_SCRIPT_HASH}'; img-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`;

const CSS = `
@page { size: A4 portrait; margin: 11mm 10mm 12mm; }
* { box-sizing: border-box; }
body { margin: 0; color: #000; background: #fff; font: 10.5pt/1.35 "Segoe UI", Tahoma, Arial, "Noto Sans", "Noto Sans Arabic", sans-serif; }
.bar { position: sticky; top: 0; display: flex; gap: 12px; align-items: center; padding: 10px 16px; background: #f1f1f1; border-bottom: 1px solid #999; }
.bar button { font: inherit; font-weight: 600; padding: 6px 16px; border: 1px solid #000; background: #fff; cursor: pointer; }
.sheet { padding: 14px 16px 8px; }
.sheet + .sheet { border-top: 2px dashed #999; }
h1 { font-size: 16pt; margin: 0 0 6px; }
h2 { font-size: 11.5pt; margin: 12px 0 4px; }
.head { display: grid; grid-template-columns: repeat(4, auto); gap: 2px 18px; justify-content: start; border: 2px solid #000; padding: 8px 10px; }
.head b { font-weight: 700; }
.banner { border: 2px solid #000; padding: 6px 10px; margin: 8px 0; font-weight: 700; background: #eee; }
table { width: 100%; border-collapse: collapse; margin-top: 4px; }
th, td { border: 1px solid #555; padding: 3px 6px; text-align: left; vertical-align: top; }
th { background: #e6e6e6; font-weight: 700; }
td.n, th.n { text-align: right; white-space: nowrap; font-variant-numeric: tabular-nums; }
td.box { width: 22mm; }
tr.total td { font-weight: 700; background: #f3f3f3; }
.muted { color: #333; font-size: 9pt; }
.sign { display: grid; grid-template-columns: repeat(4, 1fr); gap: 14px; margin-top: 16px; }
.sign div { border-top: 1px solid #000; padding-top: 2px; font-size: 9pt; }
.foot { margin-top: 10px; font-size: 8.5pt; color: #333; }
bdi { unicode-bidi: isolate; }
@media print {
  .bar { display: none; }
  .sheet { padding: 0; break-after: page; }
  .sheet:last-child { break-after: auto; }
  .sheet + .sheet { border-top: none; }
  tr, .head, .banner, .sign { break-inside: avoid; }
  thead { display: table-header-group; }
}
`;

function page(title: string, body: string, count: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${esc(title)}</title>
<style>${CSS}</style>
</head>
<body>
<div class="bar"><button type="button" id="print">Print</button><span>${esc(count)} · A4 portrait · one page per truck load</span></div>
${body}
<script>${PRINT_SCRIPT}</script>
</body>
</html>`;
}

const customer = (name: string, code: string, branch: string | null) =>
  `<bdi>${esc(name)}</bdi> <span class="muted">(${esc(code)}${branch ? ` / ${esc(branch)}` : ''})</span>`;

function headCells(h: SheetHead, rows: [string, string][]): string {
  const cells: [string, string][] = [
    ['Delivery date', h.runDate],
    ['Depot', `${h.depot.code} - ${h.depot.name}`],
    ['Plan', `v${h.version}`],
    ...rows,
  ];
  return `<div class="head">${cells.map(([k, v]) => `<span><b>${esc(k)}:</b> ${esc(v)}</span>`).join('')}</div>`;
}

const voidBanner = (h: SheetHead) =>
  h.superseded ? `<div class="banner">VOID: a newer plan version exists. Do not load or check from this paper - print it again from the plan in use.</div>` : '';

function loadSheetHtml(h: SheetHead, s: LoadSheet): string {
  const products = s.products
    .map((p) => `<tr><td>${esc(p.productCode)}</td><td>${esc(p.productName)}</td><td class="n">${p.cases}</td><td class="box"></td></tr>`)
    .join('');
  const invoices = s.invoices
    .map(
      (i) =>
        `<tr><td class="n">${i.stop}</td><td><b>${esc(i.invoiceNo)}</b></td><td>${customer(i.customerName, i.customerCode, i.branchCode)}${
          i.split ? `<br><span class="muted">split delivery: ${esc(i.split)}</span>` : ''
        }${i.carried ? `<br><b>${esc(i.carried)}</b>` : ''}</td><td>${i.lines.map((l) => `${esc(l.productCode)} × ${l.cases}`).join('<br>')}</td><td class="n">${i.cases}</td><td class="box"></td></tr>`,
    )
    .join('');
  return `<section class="sheet">
<h1>LOAD SHEET · ${esc(s.truckCode)} · trip ${s.trip} of ${s.trips}</h1>
${headCells(h, [
  ['Status', s.statusText],
  ['Driver', s.driverName ?? 'not set'],
  ['Helper(s)', s.helpers ?? 'none'],
  ['Departure', s.depart],
  ['Back', `~${s.back}`],
  ['Cases', String(s.totalCases)],
  ...(s.pallets ? ([['Pallets / bays', s.pallets]] as [string, string][]) : []),
  ['Invoices', String(s.invoices.length)],
])}
${voidBanner(h)}
${s.notLocked ? `<div class="banner">NOT LOCKED: this load may still change. Load only after the plan is locked.</div>` : ''}
${s.matches ? '' : `<div class="banner">The product total and the invoice total differ: ask the dispatcher before loading.</div>`}
${
  s.carriedAway > 0
    ? `<div class="banner">${s.carriedAway} order(s) on this load were brought forward to ${esc(s.carriedToDays)}: do not load them from this paper (unload them if already loaded) - ask the dispatcher. They are marked CARRIED OVER below.</div>`
    : ''
}
<h2>1. Products to load</h2>
<table><thead><tr><th>Product code</th><th>Product</th><th class="n">Cases</th><th>Loaded ✓</th></tr></thead>
<tbody>${products}<tr class="total"><td colspan="2">Total</td><td class="n">${s.totalCases}</td><td></td></tr></tbody></table>
<h2>2. Invoices to put in the truck</h2>
<p class="muted">Put each invoice paper in the truck with its goods, in the order of the stops. Stop = the stop number on the driver sheet.</p>
<table><thead><tr><th class="n">Stop</th><th>Invoice no.</th><th>Customer</th><th>Products × cases</th><th class="n">Cases</th><th>Invoice in truck ✓</th></tr></thead>
<tbody>${invoices}</tbody></table>
<div class="sign"><div>Loaded by</div><div>Checked by (field coordinator)</div><div>Driver</div><div>Time</div></div>
<p class="foot">${esc(s.footer)}</p>
</section>`;
}

export function renderLoadSheetHtml(m: LoadSheetModel): string {
  const body = m.sheets.map((s) => loadSheetHtml(m, s)).join('\n');
  return page(m.title, body, `${m.sheets.length} load sheet${m.sheets.length === 1 ? '' : 's'}`);
}

function returnNoteHtml(h: SheetHead, r: ReturnNote): string {
  const back = r.returnStops
    .flatMap((s) => {
      const rows = s.noResult ? s.lines : s.lines.filter((l) => (l.returned ?? 0) > 0);
      return rows.map(
        (l, i) =>
          `<tr>${
            i === 0
              ? `<td class="n" rowspan="${rows.length}">${s.stop}</td><td rowspan="${rows.length}">${customer(s.customerName, s.customerCode, s.branchCode)}<br><span class="muted">${esc(s.invoices.join(', '))}</span></td><td rowspan="${rows.length}"><b>${esc(s.result)}</b>${s.reason ? `<br>${esc(s.reason)}` : ''}</td>`
              : ''
          }<td>${esc(l.productCode)}</td><td class="n">${s.noResult ? `? (of ${l.planned})` : l.returned}</td><td class="box"></td></tr>`,
      );
    })
    .join('');
  const totals = r.returnedByProduct
    .map((p) => `<tr><td>${esc(p.productCode)}</td><td>${esc(p.productName)}</td><td class="n">${p.cases}</td><td class="box"></td><td class="box"></td></tr>`)
    .join('');
  const all = r.stops
    .map(
      (s) =>
        `<tr><td class="n">${s.stop}</td><td>${customer(s.customerName, s.customerCode, s.branchCode)}</td><td>${esc(s.invoices.join(', '))}</td><td>${esc(s.result)}</td><td class="n">${s.planned}</td><td class="n">${
          s.delivered ?? '?'
        }</td><td class="n">${s.returned ?? '?'}</td></tr>`,
    )
    .join('');
  return `<section class="sheet">
<h1>RETURN NOTE · gate pass · ${esc(r.truckCode)} · trip ${r.trip} of ${r.trips}</h1>
${headCells(h, [
  ['Driver', r.driverName ?? 'not set'],
  ['Helper(s)', r.helpers ?? 'none'],
  ['Departure', r.depart],
  ['Back at depot', r.backAt ?? 'not recorded'],
  ['Status', r.status],
  ['Delivered', `${r.totalDelivered} of ${r.totalPlanned} cases`],
  ['To come back', `${r.totalReturned} cases`],
])}
${voidBanner(h)}
${r.notBack ? `<div class="banner">Back at depot is not recorded yet: if the truck is still out, the results may still change. Print again when it is back.</div>` : ''}
${
  r.noResultStops
    ? `<div class="banner">${r.noResultStops} stop${r.noResultStops === 1 ? '' : 's'} without a result: ask the driver what happened before the truck leaves the gate, and tell the supervisor.</div>`
    : ''
}
<h2>1. Goods to come back, by customer</h2>
${
  back
    ? `<p class="muted">Count what is on the truck. Tell the supervisor the customers listed here.</p>
<table><thead><tr><th class="n">Stop</th><th>Customer / invoice</th><th>Result / reason</th><th>Product</th><th class="n">Cases back</th><th>Counted at gate</th></tr></thead><tbody>${back}</tbody></table>`
    : `<p><b>Nothing to come back:</b> every stop was delivered in full.</p>`
}
${
  totals
    ? `<h2>2. Total to come back, by product</h2>
<table><thead><tr><th>Product code</th><th>Product</th><th class="n">Cases back</th><th>Counted at gate</th><th>Difference</th></tr></thead>
<tbody>${totals}<tr class="total"><td colspan="2">Total</td><td class="n">${r.totalReturned}</td><td></td><td></td></tr></tbody></table>`
    : ''
}
<h2>${totals ? '3' : '2'}. Every stop</h2>
<table><thead><tr><th class="n">Stop</th><th>Customer</th><th>Invoice(s)</th><th>Result</th><th class="n">Planned</th><th class="n">Delivered</th><th class="n">Back</th></tr></thead><tbody>${all}</tbody></table>
<div class="sign"><div>Driver</div><div>Gate pass officer</div><div>Warehouse (returns received)</div><div>Supervisor informed</div></div>
<p class="foot">${esc(r.footer)}</p>
</section>`;
}

export function renderReturnNoteHtml(m: ReturnNoteModel): string {
  const body = m.notes.map((r) => returnNoteHtml(m, r)).join('\n');
  return page(m.title, body, `${m.notes.length} return note${m.notes.length === 1 ? '' : 's'}`);
}
