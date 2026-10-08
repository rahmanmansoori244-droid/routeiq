'use client';

import { useCallback, useEffect, useMemo, useRef, useState, useTransition } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ChevronLeft, ChevronRight, Download, Search, MapPin, MapPinOff } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { toast } from 'sonner';
import type { PaymentType } from '@prisma/client';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { runInlineUpdate } from '@/lib/customer-inline-update';
import { CUSTOMER_SEARCH_MAX, NO_REGION, customerListQuery, type CustomerListParams } from '@/lib/customer-list';
import { locationIssue, unconfirmedPriorityText, type AttrSource } from '@/lib/dispatch/customer-attrs';
import type { ServiceArea } from '@/lib/dispatch/location-input';
import { MASTER_SINCE_MAX_DAYS } from '@/lib/dispatch/data-collection';
import { addDaysIso } from '@/lib/dispatch/time';
import type { CustomerDeliveryStats } from '@/lib/delivery/customer-stats';
import { measuredServiceValue } from '@/lib/delivery/measured';

interface CustomerRow {
  id: string;
  code: string;
  name: string;
  branchCode: string | null;
  branchKey: string;
  regionId: string | null;
  region: { id: string; code: string; name: string } | null;
  address: string | null;
  lat: number | null;
  lng: number | null;
  geocodeConfidence: string | null;
  locationVerified: boolean;
  /** The stored priority. */
  priority: number;
  priorityConfirmed: boolean;
  /** The priority the planner uses (review ui-rest-2): the type default wins over an unconfirmed stored one. */
  plannedPriority: number;
  plannedPrioritySource: AttrSource;
  avgServiceTimeMin: number;
  paymentType: PaymentType;
  active: boolean;
}

interface RegionOption {
  id: string;
  code: string;
  name: string;
}

/** The data to collect (owner decision 1 Oct 2026, item 4), by customer id. */
export interface CollectInfo {
  from: string;
  to: string;
  days: number;
  perDepot: { code: string; customers: number }[];
  rows: Record<string, { missing: string; firstDelivery: string; depots: string[] }>;
}

/** The page of the list the server read (lib/customer-list.ts), and the company's counts. */
export interface CustomerListInfo {
  /** The search, filters and page these rows are for. */
  params: CustomerListParams;
  /** Customers matching the filters, on every page. */
  total: number;
  pages: number;
  pageSize: number;
  /** Every customer of the company without a location, and with a saved point that needs a pin. */
  counts: { missingLocation: number; needsPin: number };
}

const ALL = '__all__';
/** The search starts once the typing pauses this long (each search reads the database). */
export const SEARCH_DELAY_MS = 300;

const fmt = (n: number) => n.toLocaleString('en-US');

export function CustomersClient({
  slug,
  initial,
  list,
  regions,
  canEdit,
  serviceArea,
  collect = null,
  measured = {},
}: {
  slug: string;
  /** This page's rows, searched and filtered in the database over every customer of the company. */
  initial: CustomerRow[];
  list: CustomerListInfo;
  regions: RegionOption[];
  canEdit: boolean;
  /** The company's delivery area: a saved point outside it that nobody confirmed needs a pin. */
  serviceArea: ServiceArea;
  /** Dispatchers and up: the data to collect (customers with open orders soon that miss data). */
  collect?: CollectInfo | null;
  /** Measured unloading times (delivery outcome, spec section 11.1), by customer id: only customers that have one. */
  measured?: Record<string, CustomerDeliveryStats>;
}) {
  const router = useRouter();
  const { params } = list;
  const [rows, setRows] = useState(initial);
  // Rows whose last change the server did not confirm (no answer or a server error) and that could not be reloaded (audit F24).
  const [uncertain, setUncertain] = useState<ReadonlySet<string>>(new Set());
  // After router.refresh() the page's data is the server's: show it (reconciles every row).
  useEffect(() => {
    setRows(initial);
    setUncertain(new Set());
  }, [initial]);
  const [q, setQ] = useState(params.q);
  const [since, setSince] = useState('');
  const [updating, startUpdate] = useTransition();
  const [navigating, startNavigation] = useTransition();
  const toCollect = useMemo(() => collect?.rows ?? {}, [collect]);
  const collectCount = Object.keys(toCollect).length;

  // The search, the filters and the page are the page's address: the server reads that page of
  // every customer of the company (review ui-rest-1 / web-day-data-3 / M10). A new search or
  // filter starts at the first page.
  const asked = useRef(params.q);
  const go = useCallback(
    (next: Partial<CustomerListParams>) => {
      const target: CustomerListParams = { ...params, q: q.trim(), page: 1, ...next };
      asked.current = target.q;
      startNavigation(() => router.replace(`/t/${slug}/customers${customerListQuery(target)}`, { scroll: false }));
    },
    [params, q, router, slug],
  );
  // The address changed without the search box (a link, Show all): the box shows its search.
  useEffect(() => {
    if (params.q !== asked.current) {
      asked.current = params.q;
      setQ(params.q);
    }
  }, [params.q]);
  // Typing searches once it pauses (Enter at once).
  useEffect(() => {
    const want = q.trim();
    if (want === asked.current) return;
    const t = setTimeout(() => go({ q: want }), SEARCH_DELAY_MS);
    return () => clearTimeout(t);
  }, [q, go]);
  const filtered = !!(params.q || params.region || params.active || params.show);

  function patchRow(id: string, patch: Partial<CustomerRow>) {
    const before = rows.find((r) => r.id === id);
    if (!before) return;
    // A priority saved here is confirmed (the PATCH sets priorityConfirmed), so it is the one planned (review ui-rest-2).
    const planned = (r: CustomerRow): CustomerRow =>
      patch.priority === undefined ? r : { ...r, priorityConfirmed: true, plannedPriority: r.priority, plannedPrioritySource: 'CUSTOMER' };
    // Optimistic update; runInlineUpdate then shows what the server has (saved, refused, or - with
    // no answer or a server error - reloaded or marked "not confirmed"). It never throws and never re-sends (audit F24).
    setRows((rs) => rs.map((r) => (r.id === id ? planned({ ...r, ...patch }) : r)));
    startUpdate(async () => {
      const result = await runInlineUpdate(before, patch, {
        fetchImpl: fetch,
        setRow: (row) => setRows((rs) => rs.map((r) => (r.id === id ? row : r))),
        setUncertain: (u) =>
          setUncertain((s) => {
            const next = new Set(s);
            if (u) next.add(id);
            else next.delete(id);
            return next;
          }),
        notify: { success: (m) => toast.success(m), error: (m) => toast.error(m, { duration: 10_000 }), warning: (m) => toast.warning(m, { duration: 10_000 }) },
      });
      if (result === 'SAVED') {
        setRows((rs) => rs.map((r) => (r.id === id ? planned(r) : r)));
        router.refresh();
      }
    });
  }

  // A5 third review: a saved point that blocks delivery (LOW or outside the area and never
  // confirmed, or 0,0) is not "missing", but its orders are not planned or sent out either. The
  // day card's test and words (locationIssue), so the dispatcher can find them before they have
  // orders. The rows of this page are flagged here; the badges count the whole company (server).
  const needsPinMessage = useMemo(() => {
    const out = new Map<string, string>();
    for (const c of rows) {
      if (c.lat === null || c.lng === null) continue;
      const issue = locationIssue(c, serviceArea);
      if (issue?.blocking) out.set(c.id, issue.message);
    }
    return out;
  }, [rows, serviceArea]);
  const { counts } = list;
  const first = list.total ? (params.page - 1) * list.pageSize + 1 : 0;
  const last = Math.min(params.page * list.pageSize, list.total);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-3">
        <div className="relative">
          <Search className="pointer-events-none absolute left-2 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') go({ q: q.trim() });
            }}
            maxLength={CUSTOMER_SEARCH_MAX}
            placeholder="Search all customers: code, name, branch…"
            className="ps-8 w-72"
            data-testid="customers-search"
          />
        </div>
        <Select value={params.region || ALL} onValueChange={(v) => go({ region: v === ALL ? '' : v })}>
          <SelectTrigger className="w-56">
            <SelectValue placeholder="All regions" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>All regions</SelectItem>
            <SelectItem value={NO_REGION}>— no region —</SelectItem>
            {regions.map((r) => (
              <SelectItem key={r.id} value={r.id}>
                {r.code} — {r.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <label className="flex items-center gap-2 text-sm text-muted-foreground">
          <Switch checked={params.active} onCheckedChange={(v) => go({ active: v })} data-testid="active-only" />
          Active only
        </label>
        {collect ? (
          <label className="flex items-center gap-2 text-sm text-muted-foreground" title={`Customers with open orders from ${collect.from} to ${collect.to} that miss a usable location or confirmed receiving hours`}>
            <Switch checked={params.show === 'collect'} onCheckedChange={(v) => go({ show: v ? 'collect' : null })} data-testid="collect-only" />
            Data to collect ({collectCount})
          </label>
        ) : null}
        {/* The company's counts (not only this page's); each opens its customers, a second click shows all again. */}
        {counts.needsPin > 0 ? (
          <button
            type="button"
            className="ms-auto rounded-full"
            aria-pressed={params.show === 'pin'}
            onClick={() => go({ show: params.show === 'pin' ? null : 'pin' })}
            data-testid="show-need-pin"
          >
            <Badge
              variant="destructive"
              className={params.show === 'pin' ? 'ring-2 ring-destructive ring-offset-1' : ''}
              data-testid="customers-need-pin"
              title="Their saved location is not usable. Click to list them; open each one and use Set location to drop the pin."
            >
              <MapPin className="me-1 h-3 w-3" />
              {counts.needsPin} need a pin
            </Badge>
          </button>
        ) : null}
        {counts.missingLocation > 0 ? (
          <button
            type="button"
            className={counts.needsPin > 0 ? 'rounded-full' : 'ms-auto rounded-full'}
            aria-pressed={params.show === 'missing'}
            onClick={() => go({ show: params.show === 'missing' ? null : 'missing' })}
            data-testid="show-missing-location"
          >
            <Badge
              variant="warning"
              className={params.show === 'missing' ? 'ring-2 ring-amber-500 ring-offset-1' : ''}
              data-testid="customers-missing-location"
              title="Click to list the customers without a location."
            >
              <MapPinOff className="me-1 h-3 w-3" />
              {counts.missingLocation} missing geocode
            </Badge>
          </button>
        ) : null}
      </div>

      {canEdit && collect ? (
        <div className="flex flex-wrap items-end gap-3 rounded-md border bg-muted/30 p-2 text-sm" data-testid="customer-downloads">
          <div className="space-y-1">
            <label htmlFor="master-since" className="text-xs text-muted-foreground">
              Changed since (empty = last 24 hours; at most {MASTER_SINCE_MAX_DAYS} days back)
            </label>
            <Input
              id="master-since"
              type="date"
              value={since}
              min={addDaysIso(collect.from, -MASTER_SINCE_MAX_DAYS)}
              max={collect.from}
              onChange={(e) => setSince(e.target.value)}
              className="h-8 w-40"
            />
          </div>
          <Button asChild size="sm" variant="outline">
            <a href={`/api/customers/master${since ? `?since=${since}` : ''}`} data-testid="download-master">
              <Download className="me-1 h-4 w-4" />
              Download customer master
            </a>
          </Button>
          <Button asChild size="sm" variant="outline">
            <a href="/api/customers/data-to-collect?format=xlsx" data-testid="download-collect">
              <Download className="me-1 h-4 w-4" />
              Data to collect (Excel)
            </a>
          </Button>
          <p className="basis-full text-xs text-muted-foreground">
            The master has every customer, the ones changed since the date, and the ones still missing data
            {collect.perDepot.length ? ` (${collect.perDepot.map((d) => `${d.code}: ${d.customers}`).join(', ')} with orders from ${collect.from} to ${collect.to})` : ''}. Correct
            the first sheet and import it back with Import CSV: a blank cell keeps what is saved, and only an admin can change a saved location.
          </p>
        </div>
      ) : null}

      <div className="rounded-lg border bg-card">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Code / Branch</TableHead>
              <TableHead>Name</TableHead>
              <TableHead>Region</TableHead>
              <TableHead className="text-right">Lat/Lng</TableHead>
              <TableHead className="text-center" title="The stored priority; under it the one the planner uses when that is not a confirmed priority (P1 = highest)">
                Priority
              </TableHead>
              {Object.keys(measured).length ? <TableHead title="Planned unloading time, and the time measured by the driver page (median of the last timed visits)">Unloading</TableHead> : null}
              <TableHead>Payment</TableHead>
              <TableHead className="text-center">Active</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((c) => (
              <TableRow key={c.id} className="cursor-default">
                <TableCell className="font-mono text-xs">
                  <Link className="hover:underline" href={`/t/${slug}/customers/${c.id}`}>
                    {c.code}
                    {c.branchKey !== '__MAIN__' ? <span className="text-muted-foreground"> · {c.branchKey}</span> : null}
                  </Link>
                </TableCell>
                <TableCell className="font-medium">
                  <Link className="hover:underline" href={`/t/${slug}/customers/${c.id}`}>
                    {c.name}
                  </Link>
                  {toCollect[c.id] ? (
                    <span className="ms-2 inline-flex items-center gap-1 text-xs font-normal" data-testid="to-collect" data-customer={c.code}>
                      <Badge variant="warning">{toCollect[c.id]!.missing}</Badge>
                      <span className="text-muted-foreground">
                        first delivery {toCollect[c.id]!.firstDelivery} ({toCollect[c.id]!.depots.join(', ')})
                      </span>
                    </span>
                  ) : null}
                </TableCell>
                <TableCell className="text-muted-foreground">{c.region ? c.region.code : '—'}</TableCell>
                <TableCell className="text-right font-mono text-xs">
                  {c.lat !== null && c.lng !== null ? (
                    <>
                      {`${c.lat.toFixed(4)}, ${c.lng.toFixed(4)}`}
                      {needsPinMessage.has(c.id) ? (
                        <Badge variant="destructive" className="ms-2" data-testid="customer-needs-pin" data-customer={c.code} title={needsPinMessage.get(c.id)}>
                          needs pin
                        </Badge>
                      ) : null}
                    </>
                  ) : (
                    <Badge variant="warning">missing</Badge>
                  )}
                </TableCell>
                <TableCell className="text-center">
                  {canEdit ? (
                    <PriorityCell value={c.priority} confirmed={c.priorityConfirmed} disabled={updating} onChange={(v) => patchRow(c.id, { priority: v })} />
                  ) : (
                    <Badge variant="outline">{c.priority}</Badge>
                  )}
                  <PlannedPriority row={c} canEdit={canEdit} />
                </TableCell>
                {Object.keys(measured).length ? (
                  <TableCell className="text-xs" data-testid="customer-measured" data-customer={c.code}>
                    {measured[c.id]?.measured ? (
                      <span title={measured[c.id]!.text}>
                        {measured[c.id]!.plannedMin} min planned · <b>measured {measured[c.id]!.measured!.minutes}</b>
                        <span className="text-muted-foreground"> ({measured[c.id]!.measured!.n} visits)</span>
                        {canEdit && measuredServiceValue(measured[c.id]!.measured!) !== measured[c.id]!.plannedMin ? (
                          <button
                            type="button"
                            className="ms-1 text-primary underline-offset-2 hover:underline disabled:opacity-50"
                            disabled={updating}
                            onClick={() => {
                              const v = measuredServiceValue(measured[c.id]!.measured!);
                              if (window.confirm(`Set the unloading time of ${c.name} to ${v} min (measured)? It is saved as confirmed; the next plans use it.`)) patchRow(c.id, { avgServiceTimeMin: v });
                            }}
                            data-testid="use-measured-time"
                          >
                            Use measured time
                          </button>
                        ) : null}
                      </span>
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </TableCell>
                ) : null}
                <TableCell>
                  <Badge variant={c.paymentType === 'CASH' ? 'secondary' : c.paymentType === 'PREPAID' ? 'success' : 'outline'}>
                    {c.paymentType.toLowerCase()}
                  </Badge>
                </TableCell>
                <TableCell className="text-center">
                  {uncertain.has(c.id) ? (
                    <Badge variant="warning" className="me-1" title="The server did not confirm the last change (no answer or a server error): reload the page to see what is saved.">
                      not confirmed
                    </Badge>
                  ) : null}
                  {canEdit ? (
                    <Switch
                      checked={c.active}
                      disabled={updating}
                      onCheckedChange={(v) => patchRow(c.id, { active: v })}
                    />
                  ) : c.active ? (
                    <Badge variant="success">Active</Badge>
                  ) : (
                    <Badge variant="secondary">Inactive</Badge>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
        {rows.length === 0 ? (
          <div className="px-3 py-8 text-center text-sm text-muted-foreground" data-testid="customers-none">
            No customers match the filters.
            {filtered ? (
              <Button
                variant="link"
                size="sm"
                onClick={() => {
                  setQ('');
                  go({ q: '', region: '', active: false, show: null });
                }}
                data-testid="customers-show-all"
              >
                Show all customers
              </Button>
            ) : null}
          </div>
        ) : null}
        <div className="flex flex-wrap items-center justify-between gap-2 border-t px-3 py-2 text-xs text-muted-foreground" data-testid="customers-paging">
          <span data-testid="customers-shown">
            {list.total ? `${fmt(first)}–${fmt(last)} of ${fmt(list.total)}${filtered ? ' matching' : ''}` : 'None'}
            {navigating ? ' · loading…' : ''}
          </span>
          {list.pages > 1 ? (
            <span className="flex items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                className="h-7 px-2"
                disabled={params.page <= 1}
                onClick={() => go({ q: params.q, page: params.page - 1 })}
                data-testid="customers-prev"
              >
                <ChevronLeft className="h-4 w-4" />
                Previous
              </Button>
              <span>
                Page {params.page} of {list.pages}
              </span>
              <Button
                variant="outline"
                size="sm"
                className="h-7 px-2"
                disabled={params.page >= list.pages}
                onClick={() => go({ q: params.q, page: params.page + 1 })}
                data-testid="customers-next"
              >
                Next
                <ChevronRight className="h-4 w-4" />
              </Button>
            </span>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function PriorityCell({
  value,
  confirmed,
  disabled,
  onChange,
}: {
  value: number;
  confirmed: boolean;
  disabled: boolean;
  onChange: (v: number) => void;
}) {
  // An unconfirmed priority is not selected: the stored one shows as the placeholder, and picking
  // any priority - also that one - confirms it (review ui-rest-2). Radix calls onValueChange only
  // for a value other than the selected one, so picking the shown value used to send nothing.
  return (
    <Select value={confirmed ? String(value) : ''} onValueChange={(v) => onChange(Number(v))} disabled={disabled}>
      <SelectTrigger className="mx-auto h-7 w-16 px-2 py-0 text-xs" aria-label={confirmed ? `Priority ${value}` : `Priority ${value}, not confirmed`}>
        <SelectValue placeholder={String(value)} />
      </SelectTrigger>
      <SelectContent>
        {[1, 2, 3, 4, 5].map((n) => (
          <SelectItem key={n} value={String(n)}>
            {n}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

/**
 * The priority the planner uses when the stored one is not confirmed (review ui-rest-2): the
 * customer type's default wins (customer-attrs.ts effectivePriority), so a grocery stored as 3 with
 * a P4 type default is planned - and dropped first when trucks are short - as P4.
 */
function PlannedPriority({ row, canEdit }: { row: CustomerRow; canEdit: boolean }) {
  const text = unconfirmedPriorityText({ priority: row.plannedPriority, prioritySource: row.plannedPrioritySource });
  if (!text) return null;
  return (
    <span
      className="mt-0.5 block whitespace-nowrap text-[11px] text-muted-foreground"
      title={`The planner uses ${text}.${canEdit ? ' Pick a priority to confirm it.' : ''}`}
      data-testid="customer-planned-priority"
      data-customer={row.code}
    >
      {row.plannedPriority !== row.priority ? `planned P${row.plannedPriority}` : 'not confirmed'}
    </span>
  );
}
