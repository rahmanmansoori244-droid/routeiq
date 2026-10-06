'use client';

/**
 * Trucks to hire (owner request 6 Oct 2026, the hire suggestion): the trucks a depot can rent for a
 * day - label, bays (or case capacity), payload (0 = no weight limit), cost per day, cost per km (empty
 * = the depot's fleet average, fuel included), max per day, active. Company admin edits; everyone with
 * the Trucks page sees them. When a plan leaves orders out because the fleet cannot carry them, the
 * plan screen says which of these to rent.
 */
import { useCallback, useEffect, useState } from 'react';
import { Pencil, Plus, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { api } from '../dispatch/client-api';

interface HireOptionRow {
  id: string;
  depotId: string;
  label: string;
  bays: number | null;
  capacityCases: number;
  payloadKg: number;
  costPerDay: number;
  costPerKm: number | null;
  maxPerDay: number;
  active: boolean;
  depot?: { id: string; code: string; name: string };
}

interface FormState {
  id: string | null;
  depotId: string;
  label: string;
  bays: string;
  capacityCases: string;
  payloadKg: string;
  costPerDay: string;
  costPerKm: string;
  maxPerDay: string;
  active: boolean;
}

const blank = (depotId: string): FormState => ({
  id: null,
  depotId,
  label: '',
  bays: '',
  capacityCases: '',
  payloadKg: '0',
  costPerDay: '',
  costPerKm: '',
  maxPerDay: '1',
  active: true,
});

export function HireOptionsCard({ depots, canManage, currency }: { depots: { id: string; code: string; name: string }[]; canManage: boolean; currency: string }) {
  const [rows, setRows] = useState<HireOptionRow[] | null>(null);
  const [form, setForm] = useState<FormState | null>(null);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    const r = await api<HireOptionRow[]>('/api/hire-options');
    if (r.ok && r.data) setRows(r.data);
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  const set = (k: keyof FormState, v: string | boolean) => setForm((f) => (f ? { ...f, [k]: v } : f));

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (!form) return;
    const num = (s: string) => (s.trim() === '' ? null : Number(s));
    const body = {
      depotId: form.depotId,
      label: form.label,
      bays: num(form.bays),
      capacityCases: num(form.capacityCases) ?? 0,
      payloadKg: num(form.payloadKg) ?? 0,
      costPerDay: num(form.costPerDay),
      costPerKm: num(form.costPerKm),
      maxPerDay: num(form.maxPerDay) ?? 1,
      active: form.active,
    };
    setSaving(true);
    const r = form.id ? await api(`/api/hire-options/${form.id}`, { method: 'PATCH', json: body }) : await api('/api/hire-options', { method: 'POST', json: body });
    setSaving(false);
    if (!r.ok) {
      toast.error(r.error ?? 'Could not save.');
      return;
    }
    toast.success(`${form.label} saved.`);
    setForm(null);
    await load();
  }

  async function remove(o: HireOptionRow) {
    if (!window.confirm(`Delete the hire option ${o.label}? Trucks already hired with it keep their own figures.`)) return;
    const r = await api(`/api/hire-options/${o.id}`, { method: 'DELETE' });
    if (!r.ok) toast.error(r.error ?? 'Could not delete.');
    else toast.success(`${o.label} deleted.`);
    await load();
  }

  return (
    <Card data-testid="hire-options">
      <CardHeader className="flex flex-row items-start justify-between gap-2 space-y-0 py-3">
        <div>
          <CardTitle className="text-base">Trucks to hire</CardTitle>
          <p className="text-xs text-muted-foreground">
            The trucks each depot can rent for a day. When a plan leaves orders out because the fleet cannot carry them, the plan screen says which of these to hire and
            what it costs. Cost per km empty = the depot&apos;s fleet average (fuel included).
          </p>
        </div>
        {canManage && depots.length ? (
          <Button size="sm" variant="outline" onClick={() => setForm(blank(depots[0]!.id))} data-testid="hire-option-add">
            <Plus className="me-1 h-4 w-4" /> Add truck to hire
          </Button>
        ) : null}
      </CardHeader>
      <CardContent className="space-y-3">
        {rows === null ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">None yet{canManage ? ': add the trucks you can rent (for example a 10-ton with 12 bays for 50 a day, at most 3).' : '.'}</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Truck</TableHead>
                <TableHead>Depot</TableHead>
                <TableHead className="text-right">Bays / cases</TableHead>
                <TableHead className="text-right">Payload (kg)</TableHead>
                <TableHead className="text-right">Per day ({currency})</TableHead>
                <TableHead className="text-right">Per km</TableHead>
                <TableHead className="text-right">Max per day</TableHead>
                <TableHead>Status</TableHead>
                {canManage ? <TableHead className="w-[1%]" /> : null}
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((o) => (
                <TableRow key={o.id}>
                  <TableCell className="font-medium">{o.label}</TableCell>
                  <TableCell className="font-mono text-xs">{o.depot?.code ?? '—'}</TableCell>
                  <TableCell className="text-right tabular-nums">{o.bays !== null ? `${o.bays} bays` : `${o.capacityCases.toLocaleString()} cases`}</TableCell>
                  <TableCell className="text-right tabular-nums">{o.payloadKg > 0 ? o.payloadKg.toLocaleString() : 'no limit'}</TableCell>
                  <TableCell className="text-right tabular-nums">{o.costPerDay.toLocaleString()}</TableCell>
                  <TableCell className="text-right tabular-nums">{o.costPerKm === null ? 'fleet average' : o.costPerKm}</TableCell>
                  <TableCell className="text-right tabular-nums">{o.maxPerDay}</TableCell>
                  <TableCell>{o.active ? <Badge variant="success">Active</Badge> : <Badge variant="secondary">Off</Badge>}</TableCell>
                  {canManage ? (
                    <TableCell className="flex gap-1">
                      <Button
                        size="icon"
                        variant="ghost"
                        aria-label={`Edit ${o.label}`}
                        onClick={() =>
                          setForm({
                            id: o.id,
                            depotId: o.depotId,
                            label: o.label,
                            bays: o.bays !== null ? String(o.bays) : '',
                            capacityCases: o.capacityCases ? String(o.capacityCases) : '',
                            payloadKg: String(o.payloadKg),
                            costPerDay: String(o.costPerDay),
                            costPerKm: o.costPerKm !== null ? String(o.costPerKm) : '',
                            maxPerDay: String(o.maxPerDay),
                            active: o.active,
                          })
                        }
                      >
                        <Pencil className="h-4 w-4" />
                      </Button>
                      <Button size="icon" variant="ghost" aria-label={`Delete ${o.label}`} onClick={() => void remove(o)}>
                        <Trash2 className="h-4 w-4 text-destructive" />
                      </Button>
                    </TableCell>
                  ) : null}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
        {form ? (
          <form onSubmit={save} className="grid gap-3 rounded-md border p-3 sm:grid-cols-3" data-testid="hire-option-form">
            <div className="space-y-1">
              <Label htmlFor="ho-label">Truck (label)</Label>
              <Input id="ho-label" value={form.label} onChange={(e) => set('label', e.target.value)} placeholder="10-ton" required maxLength={40} />
            </div>
            <div className="space-y-1">
              <Label htmlFor="ho-depot">Depot</Label>
              <select id="ho-depot" className="h-9 w-full rounded-md border bg-background px-2 text-sm" value={form.depotId} onChange={(e) => set('depotId', e.target.value)}>
                {depots.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.code} — {d.name}
                  </option>
                ))}
              </select>
            </div>
            <div className="space-y-1">
              <Label htmlFor="ho-bays">Bays (pallet positions)</Label>
              <Input id="ho-bays" inputMode="numeric" value={form.bays} onChange={(e) => set('bays', e.target.value)} placeholder="12 (empty: by cases)" />
            </div>
            <div className="space-y-1">
              <Label htmlFor="ho-cases">Capacity in cases</Label>
              <Input id="ho-cases" inputMode="numeric" value={form.capacityCases} onChange={(e) => set('capacityCases', e.target.value)} placeholder="only without bays" />
            </div>
            <div className="space-y-1">
              <Label htmlFor="ho-payload">Payload kg (0 = no limit)</Label>
              <Input id="ho-payload" inputMode="decimal" value={form.payloadKg} onChange={(e) => set('payloadKg', e.target.value)} />
            </div>
            <div className="space-y-1">
              <Label htmlFor="ho-day">Cost per day ({currency})</Label>
              <Input id="ho-day" inputMode="decimal" value={form.costPerDay} onChange={(e) => set('costPerDay', e.target.value)} placeholder="50" required />
            </div>
            <div className="space-y-1">
              <Label htmlFor="ho-km">Cost per km, fuel included</Label>
              <Input id="ho-km" inputMode="decimal" value={form.costPerKm} onChange={(e) => set('costPerKm', e.target.value)} placeholder="empty: fleet average" />
            </div>
            <div className="space-y-1">
              <Label htmlFor="ho-max">Max per day</Label>
              <Input id="ho-max" inputMode="numeric" value={form.maxPerDay} onChange={(e) => set('maxPerDay', e.target.value)} />
            </div>
            <label className="flex items-center gap-2 self-end text-sm">
              <input type="checkbox" checked={form.active} onChange={(e) => set('active', e.target.checked)} /> Active
            </label>
            <div className="flex gap-2 sm:col-span-3">
              <Button type="submit" size="sm" disabled={saving} data-testid="hire-option-save">
                {saving ? 'Saving…' : 'Save'}
              </Button>
              <Button type="button" size="sm" variant="outline" onClick={() => setForm(null)}>
                Cancel
              </Button>
            </div>
          </form>
        ) : null}
      </CardContent>
    </Card>
  );
}
