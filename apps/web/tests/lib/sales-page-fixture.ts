/**
 * Invented answers of GET /api/s/view for the salesman link page's specs (sales-page.spec.ts,
 * sales-page-hook.spec.ts): routes R1 / R2X / R9, trucks T05 / T06, customers TST0001.. "Customer A".., pins in
 * empty desert (tests/lib/sales-day-fixture.ts ORIGIN). Never a real customer, route, plate or place.
 */
import type { SalesDelivery, SalesLookup, SalesMeta, SalesOffTruck, SalesRouteView, SalesTruck, SalesViewAnswer } from '@/lib/sales-link/view-types';

export const TOKEN = 'AbCdEfGhIjKlMnOpQrStUv12';

export const meta = (over: Partial<SalesMeta> = {}): SalesMeta => ({
  date: '2026-10-19',
  dayText: 'Monday 19 October 2026',
  dayShort: 'Mon 19 Oct',
  company: 'Example Water Co',
  expiresAt: '2026-10-20T02:00:00.000Z',
  expiryText: 'Works until Tue 20 Oct 06:00',
  tz: 'Asia/Muscat',
  serverNow: '2026-10-19T06:30:00.000Z',
  refreshSec: 60,
  routeHint: 'Your route code, as on your Salesman ETA page',
  ...over,
});

export function delivery(over: Partial<SalesDelivery> & { no: number }): SalesDelivery {
  const no = over.no;
  return {
    key: `d${no}`,
    customerName: `Customer ${String.fromCharCode(64 + no)}`,
    customerCode: `TST000${no}`,
    branchCode: null,
    invoices: [`INV-${no}`],
    cases: 10 * no,
    truckKey: 't1',
    truckCode: 'T05',
    loadNo: 1,
    stopNo: no,
    stopsOnTrip: 9,
    part: null,
    status: 'PLANNED',
    statusText: 'Planned',
    detailText: null,
    window: '07:45-09:00',
    planned: '08:05',
    eta: null,
    stopsBefore: null,
    afterHours: null,
    at: null,
    delivered: null,
    reason: null,
    hours: '06:00-14:00',
    orderTime: null,
    notes: [],
    pin: { lat: 20.1, lng: 55.1 + no / 1000 },
    shareText: `Customer ${String.fromCharCode(64 + no)}: your delivery (invoice INV-${no}) is planned for Mon 19 Oct, expected between 07:45-09:00.`,
    ...over,
  };
}

export const truck = (over: Partial<SalesTruck> = {}): SalesTruck => ({
  key: 't1',
  truckCode: 'T05',
  trip: { loadNo: 1, status: 'DISPATCHED', text: 'On the road (trip 1) since 07:10' },
  trips: 1,
  lateText: null,
  nextYours: 'Customer B · about 09:10 · 1 stop before it',
  position: { lat: 20.101, lng: 55.102, fixAt: '2026-10-19T06:29:00.000Z', updatedText: 'Updated 10:29', ageMin: 1, stale: false, moving: true },
  gpsText: 'GPS: updated 10:29',
  ...over,
});

export const offTruck = (over: Partial<SalesOffTruck> = {}): SalesOffTruck => ({
  kind: 'CANCELLED',
  kindText: 'Cancelled',
  customerName: 'Customer Z',
  customerCode: 'TST0099',
  branchCode: null,
  invoices: ['INV-99'],
  cases: 5,
  why: 'Cancelled - Customer cancelled',
  ...over,
});

/** A route on the road: delivered, at the customer, on the way (late), planned; one cancelled order. */
export function routeView(route = 'R1', over: Partial<SalesRouteView> = {}): SalesRouteView {
  return {
    route,
    heading: `Route ${route} · Monday 19 October 2026`,
    updatedAt: '2026-10-19T06:30:00.000Z',
    updatedText: 'Updated 10:30',
    notLocked: false,
    counts: { delivered: 1, partly: 0, notDelivered: 0, noResult: 0, now: 1, onTheWay: 1, planned: 1, didNotGo: 0, delayed: 1, cancelled: 1, moved: 0, notPlanned: 0 },
    summaryText: '1 delivered · 1 at the customer now · 1 on the way · 1 planned · 1 cancelled',
    trucks: [truck()],
    deliveries: [
      delivery({ no: 1, status: 'DELIVERED', statusText: 'Delivered', detailText: 'Delivered 08:10', at: '08:10', delivered: { cases: 10, of: 10 } }),
      delivery({ no: 2, status: 'AT_CUSTOMER', statusText: 'Truck at the customer now', detailText: 'Truck there since 09:05' }),
      delivery({
        no: 3,
        status: 'ON_THE_WAY',
        statusText: 'On the way',
        window: '09:15-10:30',
        eta: { expected: '10:50', source: 'GPS', timing: 'LATE', lateMin: 20, earlyMin: null, text: 'Expected about 10:50 (GPS) - about 20 min after the window 09:15-10:30' },
        detailText: 'Expected about 10:50 (GPS) - about 20 min after the window 09:15-10:30 · 1 stop before',
        stopsBefore: 1,
      }),
      delivery({ no: 4, status: 'PLANNED', statusText: 'Planned', loadNo: 2, stopNo: 1, stopsOnTrip: 4, pin: null }),
    ],
    offTruck: [offTruck()],
    ...over,
  };
}

export const lookup = (routes: SalesRouteView[], over: Partial<SalesLookup> = {}): SalesLookup => ({
  asked: routes.map((r) => r.route),
  routes,
  notFound: [],
  ambiguous: [],
  notFoundText: null,
  ...over,
});

export const answer = (l: SalesLookup | null, m: Partial<SalesMeta> = {}): SalesViewAnswer => ({ meta: meta(m), lookup: l });
