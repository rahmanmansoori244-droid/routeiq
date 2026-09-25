'use client';

import { useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { api } from './client-api';

interface Props {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  date: string;
  depotId: string;
  onSaved: (res: { orderId: string; replanNeeded: boolean; locationRequired: boolean; planId: string | null; productsWithoutWeight?: string[] }) => void;
}

/** Record one late order (phone / WhatsApp) without a file. Planning happens on re-plan. */
export function LateOrderDialog({ open, onOpenChange, date, depotId, onSaved }: Props) {
  const [code, setCode] = useState('');
  const [branch, setBranch] = useState('');
  const [name, setName] = useState('');
  const [priority, setPriority] = useState(1);
  const [reason, setReason] = useState('');
  const [so, setSo] = useState('');
  const [lines, setLines] = useState([{ productCode: '', cases: '' }]);
  const [busy, setBusy] = useState(false);

  async function save() {
    const parsed = lines.filter((l) => l.productCode.trim()).map((l) => ({ productCode: l.productCode.trim(), cases: Number(l.cases), salesOrderNo: so.trim() || undefined }));
    if (!code.trim() || !parsed.length || parsed.some((l) => !Number.isInteger(l.cases) || l.cases <= 0)) {
      toast.error('Customer code and at least one product with whole cases are required.');
      return;
    }
    if (reason.trim().length < 3) {
      toast.error('Enter the reason for accepting this late order.');
      return;
    }
    setBusy(true);
    const r = await api<{ orderId: string; replanNeeded: boolean; locationRequired: boolean; planId: string | null; productsWithoutWeight?: string[] }>('/api/dispatch/late-order', {
      method: 'POST',
      json: { date, depotId, customerCode: code.trim(), branchCode: branch.trim() || undefined, customerName: name.trim() || undefined, priority, reason: reason.trim(), lines: parsed },
    });
    setBusy(false);
    if (!r.ok || !r.data) {
      toast.error(r.error ?? 'Could not save the late order.');
      return;
    }
    toast.success('Late order recorded.');
    setCode('');
    setBranch('');
    setName('');
    setReason('');
    setSo('');
    setLines([{ productCode: '', cases: '' }]);
    onOpenChange(false);
    onSaved(r.data);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Add late order</DialogTitle>
          <DialogDescription>For {date}. Locked and dispatched loads are never changed — the order goes into a new plan version.</DialogDescription>
        </DialogHeader>
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1">
            <Label htmlFor="lo-code">Customer code</Label>
            <Input id="lo-code" value={code} onChange={(e) => setCode(e.target.value)} />
          </div>
          <div className="space-y-1">
            <Label htmlFor="lo-branch">Branch (optional)</Label>
            <Input id="lo-branch" value={branch} onChange={(e) => setBranch(e.target.value)} />
          </div>
          <div className="space-y-1">
            <Label htmlFor="lo-name">Customer name (if new)</Label>
            <Input id="lo-name" value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <div className="space-y-1">
            <Label htmlFor="lo-prio">Priority</Label>
            <select id="lo-prio" className="h-9 w-full rounded-md border bg-background px-2 text-sm" value={priority} onChange={(e) => setPriority(Number(e.target.value))}>
              {[1, 2, 3, 4, 5].map((p) => (
                <option key={p} value={p}>
                  P{p}
                  {p === 1 ? ' — highest' : ''}
                </option>
              ))}
            </select>
          </div>
          <div className="space-y-1">
            <Label htmlFor="lo-so">Sales order no. (optional)</Label>
            <Input id="lo-so" value={so} onChange={(e) => setSo(e.target.value)} />
          </div>
          <div />
          <div className="col-span-2 space-y-1">
            <Label>Products</Label>
            {lines.map((l, i) => (
              <div key={i} className="flex gap-2">
                <Input placeholder="Item code, e.g. TAN-500-24" value={l.productCode} onChange={(e) => setLines(lines.map((x, j) => (j === i ? { ...x, productCode: e.target.value } : x)))} />
                <Input className="w-28" placeholder="Cases" inputMode="numeric" value={l.cases} onChange={(e) => setLines(lines.map((x, j) => (j === i ? { ...x, cases: e.target.value } : x)))} />
                <Button variant="ghost" size="icon" onClick={() => setLines(lines.length > 1 ? lines.filter((_, j) => j !== i) : lines)} aria-label="Remove line">
                  <Trash2 className="h-4 w-4" />
                </Button>
              </div>
            ))}
            <Button variant="outline" size="sm" onClick={() => setLines([...lines, { productCode: '', cases: '' }])}>
              <Plus className="mr-1 h-4 w-4" /> Add product
            </Button>
          </div>
          <div className="col-span-2 space-y-1">
            <Label htmlFor="lo-reason">Reason for accepting after cutoff</Label>
            <Input id="lo-reason" value={reason} placeholder="e.g. Key account promotion, requested by sales manager" onChange={(e) => setReason(e.target.value)} />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={save} disabled={busy}>
            Save late order
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
