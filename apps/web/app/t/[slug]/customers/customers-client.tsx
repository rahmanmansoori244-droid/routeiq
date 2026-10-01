'use client';

import { useEffect, useMemo, useState, useTransition } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Download, Search, MapPin, MapPinOff } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { toast } from 'sonner';
import type { PaymentType } from '@prisma/client';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { runInlineUpdate } from '@/lib/customer-inline-update';
import { locationIssue } from '@/lib/dispatch/customer-attrs';
import type { ServiceArea } from '@/lib/dispatch/location-input';

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
  priority: number;
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

const ALL = '__all__';
const NO_REGION = '__noregion__';

export function CustomersClient({
  slug,
  initial,
  regions,
  canEdit,
  serviceArea,
  collect = null,
  initialCollectOnly = false,
}: {
  slug: string;
  initial: CustomerRow[];
  regions: RegionOption[];
  canEdit: boolean;
  /** The company's delivery area: a saved point outside it that nobody confirmed needs a pin. */
  serviceArea: ServiceArea;
  /** Dispatchers and up: the data to collect (customers with open orders soon that miss data). */
  collect?: CollectInfo | null;
  /** Opened from "Open on Customers" (?show=collect): only the data to collect. */
  initialCollectOnly?: boolean;
}) {
  const router = useRouter();
  const [rows, setRows] = useState(initial);
  // Rows whose last change the server did not confirm (no answer or a server error) and that could not be reloaded (audit F24).
  const [uncertain, setUncertain] = useState<ReadonlySet<string>>(new Set());
  // After router.refresh() the page's data is the server's: show it (reconciles every row).
  useEffect(() => {
    setRows(initial);
    setUncertain(new Set());
  }, [initial]);
  const [q, setQ] = useState('');
  const [regionFilter, setRegionFilter] = useState<string>(ALL);
  const [onlyActive, setOnlyActive] = useState(false);
  const [collectOnly, setCollectOnly] = useState(initialCollectOnly && !!collect);
  const [since, setSince] = useState('');
  const [updating, startUpdate] = useTransition();
  const toCollect = useMemo(() => collect?.rows ?? {}, [collect]);

  const filtered = useMemo(() => {
    const lower = q.trim().toLowerCase();
    const list = rows.filter((c) => {
      if (collectOnly && !toCollect[c.id]) return false;
      if (onlyActive && !c.active) return false;
      if (regionFilter === NO_REGION && c.regionId !== null) return false;
      if (regionFilter !== ALL && regionFilter !== NO_REGION && c.regionId !== regionFilter) return false;
      if (lower) {
        return (
          c.code.toLowerCase().includes(lower) ||
          c.name.toLowerCase().includes(lower) ||
          (c.branchCode?.toLowerCase().includes(lower) ?? false)
        );
      }
      return true;
    });
    // The data to collect: soonest delivery first (as the day screen and the Excel).
    if (collectOnly) list.sort((a, b) => (toCollect[a.id]?.firstDelivery ?? '').localeCompare(toCollect[b.id]?.firstDelivery ?? '') || a.code.localeCompare(b.code));
    return list;
  }, [rows, q, regionFilter, onlyActive, collectOnly, toCollect]);
  const collectCount = Object.keys(toCollect).length;

  function patchRow(id: string, patch: Partial<CustomerRow>) {
    const before = rows.find((r) => r.id === id);
    if (!before) return;
    // Optimistic update; runInlineUpdate then shows what the server has (saved, refused, or - with
    // no answer or a server error - reloaded or marked "not confirmed"). It never throws and never re-sends (audit F24).
    setRows((rs) => rs.map((r) => (r.id === id ? { ...r, ...patch } : r)));
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
      if (result === 'SAVED') router.refresh();
    });
  }

  const missingCoords = rows.filter((c) => c.lat === null || c.lng === null).length;
  // A5 third review: a saved point that blocks delivery (LOW or outside the area and never
  // confirmed, or 0,0) is not "missing", but its orders are not planned or sent out either. The
  // day card's test and words (locationIssue), so the dispatcher can find them before they have orders.
  const needsPinMessage = useMemo(() => {
    const out = new Map<string, string>();
    for (const c of rows) {
      if (c.lat === null || c.lng === null) continue;
      const issue = locationIssue(c, serviceArea);
      if (issue?.blocking) out.set(c.id, issue.message);
    }
    return out;
  }, [rows, serviceArea]);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-3">
        <div className="relative">
          <Search className="pointer-events-none absolute left-2 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search code, name, branch…"
            className="ps-8 w-72"
          />
        </div>
        <Select value={regionFilter} onValueChange={setRegionFilter}>
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
          <Switch checked={onlyActive} onCheckedChange={setOnlyActive} />
          Active only
        </label>
        {collect ? (
          <label className="flex items-center gap-2 text-sm text-muted-foreground" title={`Customers with open orders from ${collect.from} to ${collect.to} that miss a usable location or confirmed receiving hours`}>
            <Switch checked={collectOnly} onCheckedChange={setCollectOnly} data-testid="collect-only" />
            Data to collect ({collectCount})
          </label>
        ) : null}
        {needsPinMessage.size > 0 ? (
          <Badge variant="destructive" className="ms-auto" data-testid="customers-need-pin" title="Their saved location is not usable. Open each one and use Set location to drop the pin.">
            <MapPin className="me-1 h-3 w-3" />
            {needsPinMessage.size} need a pin
          </Badge>
        ) : null}
        {missingCoords > 0 ? (
          <Badge variant="warning" className={needsPinMessage.size > 0 ? '' : 'ms-auto'} data-testid="customers-missing-location">
            <MapPinOff className="me-1 h-3 w-3" />
            {missingCoords} missing geocode
          </Badge>
        ) : null}
      </div>

      {canEdit && collect ? (
        <div className="flex flex-wrap items-end gap-3 rounded-md border bg-muted/30 p-2 text-sm" data-testid="customer-downloads">
          <div className="space-y-1">
            <label htmlFor="master-since" className="text-xs text-muted-foreground">
              Changed since (empty = last 24 hours)
            </label>
            <Input id="master-since" type="date" value={since} onChange={(e) => setSince(e.target.value)} className="h-8 w-40" />
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
              <TableHead className="text-center">Priority</TableHead>
              <TableHead>Payment</TableHead>
              <TableHead className="text-center">Active</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {filtered.map((c) => (
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
                    <PriorityCell value={c.priority} disabled={updating} onChange={(v) => patchRow(c.id, { priority: v })} />
                  ) : (
                    <Badge variant="outline">{c.priority}</Badge>
                  )}
                </TableCell>
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
        {filtered.length === 0 ? (
          <div className="px-3 py-8 text-center text-sm text-muted-foreground">No customers match the filters.</div>
        ) : null}
      </div>
    </div>
  );
}

function PriorityCell({
  value,
  disabled,
  onChange,
}: {
  value: number;
  disabled: boolean;
  onChange: (v: number) => void;
}) {
  return (
    <Select value={String(value)} onValueChange={(v) => onChange(Number(v))} disabled={disabled}>
      <SelectTrigger className="h-7 w-16 px-2 py-0 text-xs">
        <SelectValue />
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
