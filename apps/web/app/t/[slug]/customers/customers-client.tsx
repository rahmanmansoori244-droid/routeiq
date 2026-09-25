'use client';

import { useMemo, useState, useTransition } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Search, MapPinOff } from 'lucide-react';
import { toast } from 'sonner';
import type { PaymentType } from '@prisma/client';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { errorMessage } from '@/lib/error-message';

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

const ALL = '__all__';
const NO_REGION = '__noregion__';

export function CustomersClient({
  slug,
  initial,
  regions,
  canEdit,
}: {
  slug: string;
  initial: CustomerRow[];
  regions: RegionOption[];
  canEdit: boolean;
}) {
  const router = useRouter();
  const [rows, setRows] = useState(initial);
  const [q, setQ] = useState('');
  const [regionFilter, setRegionFilter] = useState<string>(ALL);
  const [onlyActive, setOnlyActive] = useState(false);
  const [updating, startUpdate] = useTransition();

  const filtered = useMemo(() => {
    const lower = q.trim().toLowerCase();
    return rows.filter((c) => {
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
  }, [rows, q, regionFilter, onlyActive]);

  function patchRow(id: string, patch: Partial<CustomerRow>) {
    const before = rows.find((r) => r.id === id);
    if (!before) return;
    // Optimistic update
    setRows((rs) => rs.map((r) => (r.id === id ? { ...r, ...patch } : r)));
    startUpdate(async () => {
      const res = await fetch(`/api/customers/${id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(patch),
      });
      if (!res.ok) {
        // Rollback
        setRows((rs) => rs.map((r) => (r.id === id ? before : r)));
        const body = await res.json().catch(() => ({}));
        toast.error(errorMessage(body, 'Update failed.'));
        return;
      }
      toast.success('Customer updated');
      const body = await res.json().catch(() => ({}));
      if (typeof body?.data?.warning === 'string') toast.warning(body.data.warning, { duration: 10_000 });
      router.refresh();
    });
  }

  const missingCoords = rows.filter((c) => c.lat === null || c.lng === null).length;

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
        {missingCoords > 0 ? (
          <Badge variant="warning" className="ms-auto">
            <MapPinOff className="me-1 h-3 w-3" />
            {missingCoords} missing geocode
          </Badge>
        ) : null}
      </div>

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
                </TableCell>
                <TableCell className="text-muted-foreground">{c.region ? c.region.code : '—'}</TableCell>
                <TableCell className="text-right font-mono text-xs">
                  {c.lat !== null && c.lng !== null ? (
                    `${c.lat.toFixed(4)}, ${c.lng.toFixed(4)}`
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
