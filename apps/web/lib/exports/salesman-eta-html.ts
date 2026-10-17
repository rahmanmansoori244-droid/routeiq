/**
 * The Salesman ETA pages (owner request 17 Oct 2026; salesman-eta.ts has the model) as one printable
 * HTML document in the style of the warehouse sheets (lib/dispatch/warehouse-sheets-html.ts): A4
 * portrait, black on white, the day's summary on the first page and then one page per sales route. The
 * browser prints it, so customer names in Arabic print as they are.
 *
 * Every text from the data is escaped (esc), the map links too. The page runs one small script, the
 * same Print button as the warehouse sheets, and the route sends it with the same Content-Security-Policy
 * (SHEET_CSP: that script's hash and nothing else - no other script, no fetch, no images). There is no
 * driver name or phone on these pages: they go to the salesmen.
 */
import { esc, PRINT_SCRIPT } from '../dispatch/warehouse-sheets-html';
import { NO_SALES_ROUTE } from '../dispatch/sales-route';
import {
  ARRIVAL_NOTE,
  etaPalletsText,
  NOT_LOCKED_NOTE,
  NOT_PLANNED_HEADING,
  PALLETS_FOOTNOTE,
  type EtaRow,
  type EtaSection,
  type SalesmanEtaModel,
} from './salesman-eta';

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
.head { display: grid; grid-template-columns: repeat(3, auto); gap: 2px 18px; justify-content: start; border: 2px solid #000; padding: 8px 10px; }
.head b { font-weight: 700; }
.banner { border: 2px solid #000; padding: 6px 10px; margin: 8px 0; font-weight: 700; background: #eee; }
.note { margin: 6px 0; font-size: 9.5pt; font-style: italic; }
.totals { margin: 8px 0; padding: 6px 10px; border: 1px solid #555; }
.totals span { display: inline-block; margin-right: 16px; white-space: nowrap; }
table { width: 100%; border-collapse: collapse; margin-top: 4px; }
th, td { border: 1px solid #555; padding: 3px 6px; text-align: left; vertical-align: top; }
th { background: #e6e6e6; font-weight: 700; }
td.n, th.n { text-align: right; white-space: nowrap; font-variant-numeric: tabular-nums; }
tr.total td { font-weight: 700; background: #f3f3f3; }
.slot { white-space: nowrap; }
.slot + .slot { margin-top: 4px; padding-top: 3px; border-top: 1px dotted #777; }
.big { font-size: 12.5pt; font-weight: 700; font-variant-numeric: tabular-nums; }
.muted { color: #333; font-size: 9pt; }
a { color: #000; }
.foot { margin-top: 10px; font-size: 8.5pt; color: #333; }
bdi { unicode-bidi: isolate; }
@media print {
  .bar { display: none; }
  .sheet { padding: 0; break-after: page; }
  .sheet:last-child { break-after: auto; }
  .sheet + .sheet { border-top: none; }
  tr, .head, .banner, .totals { break-inside: avoid; }
  thead { display: table-header-group; }
}
`;

const num = (n: number) => n.toLocaleString('en-US');

function headCells(m: SalesmanEtaModel, extra: [string, string][]): string {
  const cells: [string, string][] = [
    ['Company', m.tenantName || '-'],
    ['Depot', `${m.depot.code} - ${m.depot.name}`],
    ...extra,
    ['Plan', `v${m.version}`],
    ['Printed', m.printedAt],
  ];
  return `<div class="head">${cells.map(([k, v]) => `<span><b>${esc(k)}:</b> <bdi>${esc(v)}</bdi></span>`).join('')}</div>`;
}

const voidBanner = (m: SalesmanEtaModel) =>
  m.superseded ? '<div class="banner">VOID: a newer plan version exists. Do not give these times to customers - print the pages again from the plan in use.</div>' : '';

function summaryHtml(m: SalesmanEtaModel): string {
  const d = m.day;
  const totals = [
    ['Trucks used', num(d.trucks)],
    ['Loads', num(d.loads)],
    ['Customers', num(d.customers)],
    ['Invoices', num(d.invoices)],
    ['Cases', num(d.cases)],
    ['Pallets', etaPalletsText(d.pallets)],
    ['Average utilisation', `${d.avgUtilizationPct}%`],
    [d.kmLabel, num(d.km)],
  ]
    .map(([k, v]) => `<span><b>${esc(k)}:</b> ${esc(v)}</span>`)
    .join('');
  const rows = m.routes
    .map(
      (r) =>
        `<tr><td><b>${esc(r.label)}</b></td><td class="n">${num(r.customers)}</td><td class="n">${num(r.invoices)}</td><td class="n">${num(r.cases)}</td><td class="n">${esc(etaPalletsText(r.pallets))}</td><td class="n">${num(r.trucks)}</td><td class="n">${num(r.loads)}</td></tr>`,
    )
    .join('');
  const t = m.total;
  const partial = d.pallets.partial || m.routes.some((r) => r.pallets.partial);
  return `<section class="sheet" data-kind="summary">
<h1>SALESMAN ETA · deliveries ${esc(m.dayText)}</h1>
${headCells(m, [['Sales routes', String(m.routes.length)]])}
${voidBanner(m)}
${m.notLocked ? `<p class="note">${esc(NOT_LOCKED_NOTE)}.</p>` : ''}
<div class="totals">${totals}</div>
<h2>By sales route</h2>
${
  m.routes.length
    ? `<table><thead><tr><th>Route</th><th class="n">Customers</th><th class="n">Invoices</th><th class="n">Cases</th><th class="n">Pallets</th><th class="n">Trucks</th><th class="n">Loads</th></tr></thead>
<tbody>${rows}<tr class="total"><td>Total</td><td class="n">${num(t.customers)}</td><td class="n">${num(t.invoices)}</td><td class="n">${num(t.cases)}</td><td class="n">${esc(etaPalletsText(t.pallets))}</td><td class="n">${num(t.trucks)}</td><td class="n">${num(t.loads)}</td></tr></tbody></table>
<p class="muted">Trucks / Loads = how many trucks and loads carry at least one invoice of the route. The total counts each truck and load of the day once.</p>`
    : '<p>No deliveries in this plan.</p>'
}
${partial ? `<p class="muted">${esc(PALLETS_FOOTNOTE)}</p>` : ''}
<p class="foot">${esc(ARRIVAL_NOTE)}</p>
</section>`;
}

function customerCell(r: EtaRow): string {
  return `<bdi>${esc(r.customerName)}</bdi><br><span class="muted">${esc(r.customerCode)}${r.branchCode ? ` / ${esc(r.branchCode)}` : ''}</span>${r.note ? `<br><b>${esc(r.note)}</b>` : ''}`;
}

function arrivalCell(r: EtaRow): string {
  return r.parts
    .map((p) => {
      const window = p.window ? `<span class="big">${esc(p.window)}</span>` : '<b>time not planned</b>';
      const planned = p.planned ? `<br><span class="muted">planned ${esc(p.planned)}</span>` : '';
      const part = p.part ? `<br><span class="muted">${esc(p.part)}: ${num(p.cases)} cases</span>` : '';
      return `<div class="slot">${window}${planned}${part}</div>`;
    })
    .join('');
}

function hoursCell(r: EtaRow): string {
  const lines = [r.hours, r.orderTime].filter((x): x is string => !!x);
  return lines.map((l) => esc(l)).join('<br>');
}

function sectionHtml(m: SalesmanEtaModel, s: EtaSection): string {
  const rows = s.rows
    .map(
      (r) =>
        `<tr><td class="n">${r.no}</td><td>${arrivalCell(r)}</td><td>${customerCell(r)}</td><td>${r.invoices.map((i) => esc(i)).join('<br>')}</td><td class="n">${num(r.cases)}</td><td>${
          r.mapUrl ? `<a href="${esc(r.mapUrl)}" target="_blank" rel="noopener noreferrer">Open map</a>` : 'no location'
        }</td><td>${hoursCell(r)}</td></tr>`,
    )
    .join('');
  const notPlanned = s.notPlanned
    .map(
      (n) =>
        `<tr><td><bdi>${esc(n.customerName)}</bdi><br><span class="muted">${esc(n.customerCode)}${n.branchCode ? ` / ${esc(n.branchCode)}` : ''}</span></td><td>${n.invoices
          .map((i) => esc(i))
          .join('<br>')}</td><td class="n">${num(n.cases)}</td><td>${esc(n.why)}</td></tr>`,
    )
    .join('');
  const label = s.route === null ? NO_SALES_ROUTE : `Route ${s.route}`;
  return `<section class="sheet" data-kind="route" data-route="${esc(s.route ?? '')}">
<h1>${esc(s.heading)}</h1>
${headCells(m, [['Customers', `${num(s.customers)} customer${s.customers === 1 ? '' : 's'}, ${num(s.cases)} cases`]])}
${voidBanner(m)}
${s.notLocked ? `<p class="note">${esc(NOT_LOCKED_NOTE)}.</p>` : ''}
${
  s.rows.length
    ? `<table><thead><tr><th class="n">#</th><th>Expected arrival</th><th>Customer</th><th>Invoice(s)</th><th class="n">Cases</th><th>Location</th><th>Receiving hours</th></tr></thead>
<tbody>${rows}</tbody></table>`
    : '<p>No delivery of this route is on a truck in this plan.</p>'
}
${
  notPlanned
    ? `<h2>${esc(NOT_PLANNED_HEADING)}</h2>
<table><thead><tr><th>Customer</th><th>Invoice(s)</th><th class="n">Cases</th><th>Why</th></tr></thead><tbody>${notPlanned}</tbody></table>`
    : ''
}
<p class="foot">${esc(ARRIVAL_NOTE)}</p>
<p class="foot">${esc(`Salesman ETA · ${label} · delivery ${m.runDate} · plan v${m.version} - void if a newer plan version is issued`)}</p>
</section>`;
}

export function renderSalesmanEtaHtml(m: SalesmanEtaModel): string {
  const pages = 1 + m.sections.length;
  const body = [summaryHtml(m), ...m.sections.map((s) => sectionHtml(m, s))].join('\n');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${esc(m.title)}</title>
<style>${CSS}</style>
</head>
<body>
<div class="bar"><button type="button" id="print">Print</button><span>${esc(`${pages} page${pages === 1 ? '' : 's'} · A4 portrait · the day, then one page per sales route`)}</span></div>
${body}
<script>${PRINT_SCRIPT}</script>
</body>
</html>`;
}
