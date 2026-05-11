'use client';

import { useMemo, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';

interface DepotOption {
  id: string;
  code: string;
  name: string;
  _count: { trucks: number };
}

interface Props {
  slug: string;
  depots: DepotOption[];
  orderCounts: { date: string; count: number }[];
}

const MODES = [
  { value: 'BALANCED', label: 'Balanced (default)' },
  { value: 'MIN_TRUCKS', label: 'Minimize trucks used' },
  { value: 'MIN_DISTANCE', label: 'Minimize total distance' },
  { value: 'MAX_UTILIZATION', label: 'Maximize truck utilization' },
  { value: 'MIN_COST', label: 'Minimize cost' },
];

function tomorrowIso(): string {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  return d.toISOString().slice(0, 10);
}

export function NewRunForm({ slug, depots, orderCounts }: Props) {
  const router = useRouter();
  const [depotId, setDepotId] = useState(depots[0]?.id ?? '');
  const [runDate, setRunDate] = useState(tomorrowIso());
  const [mode, setMode] = useState('BALANCED');
  const [pending, startCreate] = useTransition();

  const ordersForDate = useMemo(
    () => orderCounts.find((o) => o.date === runDate)?.count ?? 0,
    [orderCounts, runDate],
  );
  const depot = depots.find((d) => d.id === depotId);
  const trucksAvail = depot?._count.trucks ?? 0;

  function submit(e: React.FormEvent) {
    e.preventDefault();
    startCreate(async () => {
      const res = await fetch('/api/runs', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ depotId, runDate, optimizationMode: mode }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(typeof body.error === 'string' ? body.error : 'Create failed.');
        return;
      }
      router.push(`/t/${slug}/runs/${body.data.id}`);
      router.refresh();
    });
  }

  return (
    <form onSubmit={submit} className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Run setup</CardTitle>
          <CardDescription>Pick a depot and the delivery date you want to optimize.</CardDescription>
        </CardHeader>
        <CardContent className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="depot">Depot</Label>
            <Select value={depotId} onValueChange={setDepotId}>
              <SelectTrigger id="depot">
                <SelectValue placeholder="Pick a depot" />
              </SelectTrigger>
              <SelectContent>
                {depots.map((d) => (
                  <SelectItem key={d.id} value={d.id}>
                    {d.code} — {d.name} ({d._count.trucks} trucks)
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {trucksAvail === 0 ? (
              <p className="text-xs text-destructive">Selected depot has no active trucks. Add some first.</p>
            ) : (
              <p className="text-xs text-muted-foreground">{trucksAvail} active trucks at this depot.</p>
            )}
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="date">Delivery date</Label>
            <Input id="date" type="date" value={runDate} onChange={(e) => setRunDate(e.target.value)} required />
            {ordersForDate > 0 ? (
              <p className="text-xs text-muted-foreground">
                <strong>{ordersForDate}</strong> orders confirmed for this date.
              </p>
            ) : (
              <p className="text-xs text-destructive">
                No orders confirmed for this date — upload + confirm a batch first.
              </p>
            )}
          </div>
          <div className="space-y-1.5 md:col-span-2">
            <Label htmlFor="mode">Optimization mode</Label>
            <Select value={mode} onValueChange={setMode}>
              <SelectTrigger id="mode">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {MODES.map((m) => (
                  <SelectItem key={m.value} value={m.value}>
                    {m.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">
              Influences how the Balanced scenario is weighted. All three scenarios (Min Trucks / Min Distance / Balanced)
              are always returned for comparison.
            </p>
          </div>
        </CardContent>
      </Card>

      <div className="flex justify-end gap-2">
        <Button type="submit" disabled={pending || ordersForDate === 0 || trucksAvail === 0}>
          {pending ? 'Creating…' : 'Create run'}
        </Button>
      </div>
    </form>
  );
}
