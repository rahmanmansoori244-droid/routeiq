'use client';

import { useMemo, useState } from 'react';
import { Search } from 'lucide-react';
import type { OrderStatus } from '@prisma/client';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';

export interface OrderRow {
  id: string;
  deliveryDate: Date;
  totalCases: number;
  totalWeightKg: number;
  totalVolumeL: number;
  priority: number;
  status: OrderStatus;
  uploadedAt: Date;
  customer: {
    id: string;
    code: string;
    name: string;
    branchKey: string;
    region: { id: string; code: string } | null;
  };
  _count: { lines: number };
}

export interface RegionOption {
  id: string;
  code: string;
  name: string;
}

const ALL = '__all__';
const NO_REGION = '__noregion__';

const STATUS_VARIANT: Record<OrderStatus, 'default' | 'success' | 'warning' | 'secondary' | 'destructive' | 'outline'> = {
  UPLOADED: 'outline',
  VALIDATED: 'outline',
  ASSIGNED: 'warning',
  DISPATCHED: 'success',
  DELIVERED: 'success',
  FAILED: 'destructive',
  UNSERVED: 'destructive',
};

export function OrdersTable({ initial, regions }: { initial: OrderRow[]; regions: RegionOption[] }) {
  const [q, setQ] = useState('');
  const [date, setDate] = useState('');
  const [regionFilter, setRegionFilter] = useState(ALL);

  const filtered = useMemo(() => {
    const lower = q.trim().toLowerCase();
    return initial.filter((o) => {
      if (date && new Date(o.deliveryDate).toISOString().slice(0, 10) !== date) return false;
      if (regionFilter === NO_REGION && o.customer.region !== null) return false;
      if (regionFilter !== ALL && regionFilter !== NO_REGION && o.customer.region?.id !== regionFilter) return false;
      if (lower) {
        return (
          o.customer.code.toLowerCase().includes(lower) ||
          o.customer.name.toLowerCase().includes(lower)
        );
      }
      return true;
    });
  }, [initial, q, date, regionFilter]);

  // Aggregate totals for the filtered set
  const totals = useMemo(
    () =>
      filtered.reduce(
        (acc, o) => {
          acc.cases += o.totalCases;
          acc.kg += o.totalWeightKg;
          return acc;
        },
        { cases: 0, kg: 0 },
      ),
    [filtered],
  );

  if (initial.length === 0) {
    return (
      <div className="rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">
        No orders yet. Upload a file and confirm a batch to see them here.
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-3">
        <div className="relative">
          <Search className="pointer-events-none absolute left-2 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search customer code/name…"
            className="ps-8 w-64"
          />
        </div>
        <Input
          type="date"
          value={date}
          onChange={(e) => setDate(e.target.value)}
          className="w-44"
          aria-label="Delivery date filter"
        />
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
        <span className="ms-auto text-xs text-muted-foreground">
          {filtered.length} of {initial.length} orders · {totals.cases.toLocaleString()} cases · {totals.kg.toLocaleString()} kg
        </span>
      </div>

      <div className="rounded-lg border bg-card">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Customer</TableHead>
              <TableHead>Region</TableHead>
              <TableHead>Delivery date</TableHead>
              <TableHead className="text-right">Lines</TableHead>
              <TableHead className="text-right">Cases</TableHead>
              <TableHead className="text-right">Weight kg</TableHead>
              <TableHead className="text-center">Priority</TableHead>
              <TableHead>Status</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {filtered.map((o) => (
              <TableRow key={o.id}>
                <TableCell>
                  <div className="font-mono text-xs">{o.customer.code}</div>
                  <div className="text-sm">{o.customer.name}</div>
                </TableCell>
                <TableCell className="text-muted-foreground">{o.customer.region?.code ?? '—'}</TableCell>
                <TableCell className="font-mono text-xs">{new Date(o.deliveryDate).toISOString().slice(0, 10)}</TableCell>
                <TableCell className="text-right">{o._count.lines}</TableCell>
                <TableCell className="text-right tabular-nums">{o.totalCases}</TableCell>
                <TableCell className="text-right tabular-nums">{o.totalWeightKg.toLocaleString(undefined, { maximumFractionDigits: 1 })}</TableCell>
                <TableCell className="text-center">
                  <Badge variant="outline">{o.priority}</Badge>
                </TableCell>
                <TableCell>
                  <Badge variant={STATUS_VARIANT[o.status]}>{o.status.toLowerCase()}</Badge>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
