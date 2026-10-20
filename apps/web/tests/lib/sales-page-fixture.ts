/**
 * Invented answers of GET /api/s/view for the salesman link page's specs (sales-page.spec.ts, sales-page-hook.spec.ts,
 * sales-page-view.spec.ts): routes R1 / R2X / R9, trucks 1234-AB / C-1, customers "Customer A".. Never a real
 * customer, route, plate or place.
 */
import type { SalesLookup, SalesMeta, SalesRouteView, SalesRow, SalesViewAnswer } from '@/lib/sales-link/view-types';

export const TOKEN = 'AbCdEfGhIjKlMnOpQrStUv12';

export const meta = (over: Partial<SalesMeta> = {}): SalesMeta => ({
  date: '2026-10-19',
  company: 'Example Water Co',
  expiresAt: '2026-10-20T02:00:00.000Z',
  tz: 'Asia/Muscat',
  serverNow: '2026-10-19T06:30:00.000Z',
  refreshSec: 60,
  ...over,
});

/** One customer's row: on the way by default. */
export function row(over: Partial<SalesRow> & { key: string }): SalesRow {
  return {
    customer: `Customer ${over.key.toUpperCase()}`,
    branch: null,
    status: 'ON_THE_WAY',
    at: null,
    eta: null,
    inMin: null,
    atCustomer: false,
    cases: null,
    off: null,
    movedTo: null,
    ...over,
  };
}

/** A route on the road (company time 10:30): delivered, being delivered, delayed, on the way, partly delivered; one cancelled order. */
export function routeView(route = 'R1', over: Partial<SalesRouteView> = {}): SalesRouteView {
  return {
    kind: 'ROUTE',
    code: route,
    query: route,
    updated: '10:30',
    rows: [
      row({ key: 'd1', customer: 'Customer A', status: 'DELIVERED', at: '08:10' }),
      row({ key: 'd2', customer: 'Customer B', status: 'PARTLY_DELIVERED', cases: { delivered: 18, of: 24 } }),
      row({ key: 'd3', customer: 'Customer C', status: 'ON_THE_WAY', atCustomer: true }),
      row({ key: 'd4', customer: 'Customer D', branch: 'B2', status: 'DELAYED', eta: '11:50', inMin: 80 }),
      row({ key: 'd5', customer: 'Customer E', status: 'ON_THE_WAY', eta: '12:30', inMin: 120 }),
      row({ key: 'o1', customer: 'Customer Z', status: 'CANCELLED' }),
    ],
    ...over,
  };
}

/** A truck looked up (synthetic code 1234-AB): its customers of the day, every route. */
export function truckView(code = '1234-AB', over: Partial<SalesRouteView> = {}): SalesRouteView {
  return { ...routeView('R1'), kind: 'TRUCK', code, query: `Truck ${code}`, ...over };
}

export const lookup = (results: SalesRouteView[], over: Partial<SalesLookup> = {}): SalesLookup => ({
  asked: results.map((r) => r.query.toUpperCase()),
  results,
  notFound: [],
  ambiguous: [],
  choices: [],
  ...over,
});

export const answer = (l: SalesLookup | null, m: Partial<SalesMeta> = {}): SalesViewAnswer => ({ meta: meta(m), lookup: l });
