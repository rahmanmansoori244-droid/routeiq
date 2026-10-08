/**
 * The Customers page's list: searched, filtered and paged in the database (review findings
 * ui-rest-1, web-day-data-3 and M10, 9 Oct 2026).
 *
 * The page used to load the first 1,000 customers (active first, by code) and search only those in
 * the browser. Customer 1,001 and later could not be found or edited there ("No customers match the
 * filters", then a 409 "already exists" when the dispatcher created it again), the header said
 * "1000 customers" and the "need a pin" / "missing geocode" badges counted only the loaded rows.
 * Now the search (code, name, branch), the filters (region, active only, data to collect, need a
 * pin, missing location) and the paging run in the database over every customer of the company,
 * from the page's address (?q=&region=&active=1&show=&page=), and every count is the company's.
 *
 * `db` is the tenant-scoped client (getCurrentTenant / tenantDb): every query here adds the
 * company, so a region id or a page number in the address never reaches another company's rows.
 */
import type { Prisma } from '@prisma/client';
import type { TenantDb } from './tenant';
import { effectivePriority, locationIssue, type AttrSource, type CustomerForPlanning } from './dispatch/customer-attrs';
import type { ServiceArea } from './dispatch/location-input';

/** Rows per page: small enough for a quick page, large enough to scroll a region. */
export const CUSTOMER_PAGE_SIZE = 200;
/** The search box's longest text (a code, a name or a branch; longer text is cut). */
export const CUSTOMER_SEARCH_MAX = 100;
/** The region filter's "no region" choice (any other value is a region id). */
export const NO_REGION = '__noregion__';

/**
 * The one-at-a-time views: the data to collect (owner decision 1 Oct 2026, item 4; the day screen's
 * "Open on Customers" link is ?show=collect), the customers whose saved point needs a pin, and the
 * ones without a location. The header badges open the last two.
 */
export const CUSTOMER_VIEWS = ['collect', 'pin', 'missing'] as const;
export type CustomerView = (typeof CUSTOMER_VIEWS)[number];

export interface CustomerListParams {
  /** Trimmed search text; '' = no search. */
  q: string;
  /** '' = every region, NO_REGION = customers without a region, else a region id. */
  region: string;
  /** Active customers only. */
  active: boolean;
  show: CustomerView | null;
  /** 1 = the first page. */
  page: number;
}

export const DEFAULT_CUSTOMER_LIST: CustomerListParams = { q: '', region: '', active: false, show: null, page: 1 };

type SearchParams = Record<string, string | string[] | undefined> | undefined;
const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? '';

/** The list's settings from the page's address; anything unknown is the default. */
export function readCustomerListParams(sp: SearchParams): CustomerListParams {
  const show = first(sp?.show);
  const page = Number.parseInt(first(sp?.page), 10);
  return {
    q: first(sp?.q).trim().slice(0, CUSTOMER_SEARCH_MAX).trim(),
    region: first(sp?.region).trim(),
    active: first(sp?.active) === '1',
    show: (CUSTOMER_VIEWS as readonly string[]).includes(show) ? (show as CustomerView) : null,
    page: Number.isSafeInteger(page) && page >= 1 ? page : 1,
  };
}

/** The address part for these settings ('' for the defaults), read back by readCustomerListParams. */
export function customerListQuery(p: CustomerListParams): string {
  const s = new URLSearchParams();
  if (p.q) s.set('q', p.q);
  if (p.region) s.set('region', p.region);
  if (p.active) s.set('active', '1');
  if (p.show) s.set('show', p.show);
  if (p.page > 1) s.set('page', String(p.page));
  const out = s.toString();
  return out ? `?${out}` : '';
}

/**
 * The filters as one Prisma condition. `ids.collect` / `ids.needsPin` are the customers of those
 * views (worked out outside SQL: the worklist, and the day card's location test). The search is
 * case-insensitive "contains" on the code, the name and the branch code, as GET /api/customers.
 */
export function customerListWhere(p: CustomerListParams, ids: { collect?: readonly string[] | null; needsPin?: readonly string[] } = {}): Prisma.CustomerWhereInput {
  const and: Prisma.CustomerWhereInput[] = [];
  if (p.q) {
    and.push({
      OR: [
        { code: { contains: p.q, mode: 'insensitive' } },
        { name: { contains: p.q, mode: 'insensitive' } },
        { branchCode: { contains: p.q, mode: 'insensitive' } },
      ],
    });
  }
  if (p.region === NO_REGION) and.push({ regionId: null });
  else if (p.region) and.push({ regionId: p.region });
  if (p.active) and.push({ active: true });
  if (p.show === 'collect' && ids.collect) and.push({ id: { in: [...ids.collect] } });
  if (p.show === 'pin') and.push({ id: { in: [...(ids.needsPin ?? [])] } });
  if (p.show === 'missing') and.push({ OR: [{ lat: null }, { lng: null }] });
  return and.length ? { AND: and } : {};
}

/**
 * Customers with a saved point that blocks delivery: the day card's test and words (locationIssue,
 * the company's area), as the list's "needs pin" flag. A missing point is counted apart.
 */
export function needsPinIds(rows: Pick<CustomerForPlanning, 'id' | 'lat' | 'lng' | 'locationVerified' | 'geocodeConfidence'>[], area: ServiceArea): string[] {
  return rows.filter((c) => c.lat !== null && c.lng !== null && locationIssue(c, area)?.blocking).map((c) => c.id);
}

/** Only the columns the table shows (the whole row made the page several MB). */
const ROW_SELECT = {
  id: true,
  code: true,
  name: true,
  branchCode: true,
  branchKey: true,
  regionId: true,
  region: { select: { id: true, code: true, name: true } },
  address: true,
  lat: true,
  lng: true,
  geocodeConfidence: true,
  locationVerified: true,
  priority: true,
  priorityConfirmed: true,
  customerType: true,
  avgServiceTimeMin: true,
  paymentType: true,
  active: true,
} satisfies Prisma.CustomerSelect;

type SelectedRow = Prisma.CustomerGetPayload<{ select: typeof ROW_SELECT }>;

export type CustomerListRow = Omit<SelectedRow, 'customerType'> & {
  /** The priority the planner uses (review ui-rest-2): the stored one only when confirmed. */
  plannedPriority: number;
  plannedPrioritySource: AttrSource;
};

/**
 * Active first, then by code and branch. The id last, so a page never repeats or skips a customer
 * whose code and branch sort the same as another's.
 */
const ORDER: Prisma.CustomerOrderByWithRelationInput[] = [{ active: 'desc' }, { code: 'asc' }, { branchKey: 'asc' }, { id: 'asc' }];

export interface CustomerList {
  /** The settings used: a page past the end is the last page; "data to collect" without the worklist is no view. */
  params: CustomerListParams;
  rows: CustomerListRow[];
  /** Customers matching the filters (all pages). */
  total: number;
  /** Every customer of the company. */
  all: number;
  pages: number;
  pageSize: number;
  /** The company's customers without a location, and with a saved point that needs a pin. */
  counts: { missingLocation: number; needsPin: number };
}

export async function loadCustomerList(
  db: TenantDb,
  asked: CustomerListParams,
  opts: {
    /** The data to collect by customer id (dispatchers and up), or null: then there is no such view. */
    collect: Record<string, { firstDelivery: string }> | null;
    area: ServiceArea;
    pageSize?: number;
  },
): Promise<CustomerList> {
  const pageSize = opts.pageSize ?? CUSTOMER_PAGE_SIZE;
  const show = asked.show === 'collect' && !opts.collect ? null : asked.show;
  const [all, missingLocation, located, profiles] = await Promise.all([
    db.customer.count(),
    db.customer.count({ where: { OR: [{ lat: null }, { lng: null }] } }),
    // Five small columns of every customer with a point: the "need a pin" count and view.
    db.customer.findMany({
      where: { lat: { not: null }, lng: { not: null } },
      select: { id: true, lat: true, lng: true, locationVerified: true, geocodeConfidence: true },
    }),
    db.customerTypeProfile.findMany({ select: { customerType: true, defaultPriority: true } }),
  ]);
  const needsPin = needsPinIds(located, opts.area);
  const collectIds = opts.collect ? Object.keys(opts.collect) : null;
  const where = customerListWhere({ ...asked, show }, { collect: collectIds, needsPin });

  let total: number;
  let page: number;
  let rows: SelectedRow[];
  if (show === 'collect' && opts.collect) {
    // The data to collect: soonest first delivery first (as the day screen and the Excel). The
    // worklist is the customers with open orders in the next days, so its ids are few enough to sort here.
    const toCollect = opts.collect;
    const keys = await db.customer.findMany({ where, select: { id: true, code: true, branchKey: true } });
    keys.sort(
      (a, b) =>
        (toCollect[a.id]?.firstDelivery ?? '').localeCompare(toCollect[b.id]?.firstDelivery ?? '') ||
        a.code.localeCompare(b.code) ||
        a.branchKey.localeCompare(b.branchKey) ||
        a.id.localeCompare(b.id),
    );
    total = keys.length;
    page = Math.min(asked.page, Math.max(1, Math.ceil(total / pageSize)));
    const ids = keys.slice((page - 1) * pageSize, page * pageSize).map((k) => k.id);
    const found = ids.length ? await db.customer.findMany({ where: { id: { in: ids } }, select: ROW_SELECT }) : [];
    const byId = new Map(found.map((r) => [r.id, r]));
    rows = ids.map((id) => byId.get(id)).filter((r): r is SelectedRow => !!r);
  } else {
    total = await db.customer.count({ where });
    page = Math.min(asked.page, Math.max(1, Math.ceil(total / pageSize)));
    rows = total ? await db.customer.findMany({ where, orderBy: ORDER, select: ROW_SELECT, skip: (page - 1) * pageSize, take: pageSize }) : [];
  }

  const byType = new Map(profiles.map((p) => [p.customerType, p]));
  return {
    params: { ...asked, show, page },
    rows: rows.map(({ customerType, ...r }) => {
      const eff = effectivePriority({ ...r, customerType }, byType);
      return { ...r, plannedPriority: eff.priority, plannedPrioritySource: eff.prioritySource };
    }),
    total,
    all,
    pages: Math.max(1, Math.ceil(total / pageSize)),
    pageSize,
    counts: { missingLocation, needsPin: needsPin.length },
  };
}
