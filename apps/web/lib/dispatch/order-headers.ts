/**
 * Which columns of an order file hold which order field: the built-in header aliases, the company's
 * own ones and the test for a sheet that holds order rows. Moved out of order-intake.ts (which
 * re-exports all of it) for audit P5: it has no dependencies, so the upload parser process
 * (lib/upload-parse) picks the order sheet of a workbook with it without loading the rest of the
 * intake (schemas, zod).
 */

export type CanonicalField =
  | 'sales_order_no'
  | 'order_date'
  | 'delivery_date'
  | 'customer_code'
  | 'branch_code'
  | 'customer_name'
  | 'product_code'
  | 'product_description'
  | 'cases'
  | 'weight_kg'
  | 'sales_value'
  | 'margin'
  | 'priority'
  | 'notes'
  | 'depot_code'
  | 'customer_type'
  | 'sales_route';

/** Built-in aliases (normalized: lowercase, letters+digits only). Tenants can add more. */
export const HEADER_ALIASES: Record<CanonicalField, string[]> = {
  // Owner decision 12 Oct 2026: RouteIQ only ever gets sales INVOICES (the ERP turns the sales order
  // into an invoice; the number uploaded is the invoice number), so an invoice column is the document
  // number, and it wins over a sales-order column in the same file.
  sales_order_no: [
    'invoiceno',
    'invoicenumber',
    'invoice',
    'invno',
    'invoiceid',
    'salesinvoiceno',
    'salesinvoicenumber',
    'salesinvoice',
    'taxinvoiceno',
    'taxinvoicenumber',
    'salesorderno',
    'salesorder',
    'salesordernumber',
    'sono',
    'sonumber',
    'orderno',
    'ordernumber',
    'orderid',
    'docno',
    'documentno',
    'documentnumber',
    'so',
  ],
  order_date: ['orderdate', 'sodate', 'documentdate', 'docdate', 'salesorderdate', 'invoicedate', 'invdate'],
  delivery_date: ['deliverydate', 'requesteddeliverydate', 'reqdeliverydate', 'requesteddate', 'reqdate', 'deliverydt', 'shipdate', 'dispatchdate', 'deliveryon', 'date'],
  customer_code: ['customercode', 'custcode', 'customerno', 'customernumber', 'customerid', 'customer', 'accountcode', 'account', 'cust', 'soldto', 'soldtocode'],
  branch_code: ['branchcode', 'branch', 'branchno', 'shiptocode', 'shipto', 'shiptono', 'outletcode', 'outlet', 'site', 'sitecode', 'locationcode'],
  customer_name: ['customername', 'custname', 'name', 'outletname', 'shiptoname', 'accountname', 'branchname'],
  product_code: ['productcode', 'itemcode', 'sku', 'skucode', 'item', 'itemno', 'materialcode', 'material', 'productid', 'product'],
  product_description: ['productdescription', 'description', 'itemdescription', 'productname', 'itemname', 'skuname', 'materialdescription'],
  cases: ['cases', 'orderedcases', 'qtycases', 'casesordered', 'quantity', 'qty', 'orderqty', 'orderedqty', 'cartons', 'ctn', 'ctns', 'cs'],
  weight_kg: ['weightkg', 'weight', 'totalweight', 'grossweight', 'kg', 'netweight', 'linweight'],
  sales_value: ['salesvalue', 'value', 'amount', 'netvalue', 'netamount', 'salesamount', 'revenue', 'linevalue', 'totalvalue'],
  margin: ['contributionmargin', 'margin', 'cm', 'grossmargin', 'marginvalue', 'gm'],
  priority: ['priority', 'prio', 'deliverypriority'],
  notes: ['notes', 'note', 'remarks', 'remark', 'comment', 'comments', 'instructions'],
  depot_code: ['depotcode', 'depot', 'warehouse', 'warehousecode', 'plant', 'plantcode'],
  customer_type: ['customertype', 'channel', 'custtype', 'outlettype', 'segment'],
  // Salesman ETA (owner request 17 Oct 2026): the order file's "route" column is the code of the
  // salesman's route that sold the invoice (R1, R2X, ...), kept per order line (OrderLine.salesRoute)
  // for the Salesman ETA export. Optional: never required, never part of a duplicate key, and declared
  // last, so mapHeaders offers it a column only after every other field has taken its own - a file
  // without a route column maps every column exactly as before. None of these names is an alias of
  // another field (tests/lib/salesman-eta-intake.spec.ts checks it).
  sales_route: ['route', 'salesroute', 'salesmanroute', 'routecode', 'salesmancode', 'salesman'],
};

export function normHeader(h: string): string {
  return h.toLowerCase().replace(/[^a-z0-9]/g, '');
}

export interface ColumnMapping {
  /** canonical field -> original header used */
  used: Partial<Record<CanonicalField, string>>;
  unmapped: string[];
}

export function mapHeaders(headers: string[], extra: Partial<Record<CanonicalField, string[]>> = {}): ColumnMapping {
  const used: Partial<Record<CanonicalField, string>> = {};
  const byNorm = new Map(headers.map((h) => [normHeader(h), h]));
  const taken = new Set<string>();
  // Tenant aliases first, then exact canonical name, then built-ins in declaration order. The
  // document number is the exception (owner decision 12 Oct 2026): its built-ins start with the
  // invoice names, so its canonical name ("Sales Order No" = salesorderno, also a built-in after
  // them) must not be tried first, or a sales-order column would beat an invoice column.
  for (const field of Object.keys(HEADER_ALIASES) as CanonicalField[]) {
    const canonical = field === 'sales_order_no' ? [] : [normHeader(field)];
    const candidates = [...(extra[field] ?? []).map(normHeader), ...canonical, ...HEADER_ALIASES[field]];
    for (const c of candidates) {
      const h = byNorm.get(c);
      if (h && !taken.has(h)) {
        used[field] = h;
        taken.add(h);
        break;
      }
    }
  }
  return { used, unmapped: headers.filter((h) => !taken.has(h)) };
}

/**
 * A sheet whose header row has the order columns (canonical names or aliases, the tenant's own
 * included): customer code, product code and cases. Used to find the sheets of a workbook that
 * hold order rows, so a workbook with orders on two sheets is refused, not cut to one (S04 / B2).
 */
export function isOrderSheet(headers: string[], extra: Partial<Record<CanonicalField, string[]>> = {}): boolean {
  const used = mapHeaders(headers, extra).used;
  return !!(used.customer_code && used.product_code && used.cases);
}
