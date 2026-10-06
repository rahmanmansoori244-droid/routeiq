'use client';

import { useCallback, useEffect, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { errorMessage } from '@/lib/error-message';
import { fmtDayMonth } from '@/lib/dispatch/time';
import { LEAVE_NOTE_MAX } from '@/lib/dispatch/driver-leave';
import type { LeaveView } from '@/lib/dispatch/driver-leave-service';

/** A driver as the Drivers page's lists offer him. */
export interface DriverOption {
  id: string;
  code: string;
  name: string;
  active: boolean;
  casual?: boolean;
}

interface Props {
  driver: { id: string; code: string; name: string } | null;
  drivers: DriverOption[];
  canEdit: boolean;
  onOpenChange: (open: boolean) => void;
}

const blank = { from: '', until: '', coverDriverId: '', note: '' };
const PHASE: Record<LeaveView['phase'], { text: string; variant: 'warning' | 'outline' | 'secondary' }> = {
  NOW: { text: 'On leave now', variant: 'warning' },
  COMING: { text: 'Coming', variant: 'outline' },
  ENDED: { text: 'Ended', variant: 'secondary' },
};

/**
 * A driver's leave (owner request 6 Oct 2026): his periods, the latest first (ended ones are kept for
 * the record), and for the dispatcher (PLANNER and up) the form to add one, change one (an ended
 * period stays as it was; a started one keeps its first day) and remove one that has not started.
 * Rules and messages: lib/dispatch/driver-leave.ts, enforced by the server.
 */
export function LeaveDialog({ driver, drivers, canEdit, onOpenChange }: Props) {
  const router = useRouter();
  const [periods, setPeriods] = useState<LeaveView[] | null>(null);
  const [today, setToday] = useState('');
  const [form, setForm] = useState(blank);
  const [editing, setEditing] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const load = useCallback(async () => {
    if (!driver) return;
    const res = await fetch(`/api/drivers/${driver.id}/leave`);
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      toast.error(errorMessage(body, 'Could not read the leave of this driver.'));
      return;
    }
    setPeriods(body.data.periods as LeaveView[]);
    setToday(body.data.today as string);
  }, [driver]);

  useEffect(() => {
    setPeriods(null);
    setForm(blank);
    setEditing(null);
    void load();
  }, [load]);

  const covers = drivers.filter((d) => d.active && d.id !== driver?.id);

  function startEdit(p: LeaveView) {
    setEditing(p.id);
    setForm({ from: p.from, until: p.until, coverDriverId: p.coverDriverId ?? '', note: p.note ?? '' });
  }

  function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!driver) return;
    startTransition(async () => {
      const url = editing ? `/api/drivers/${driver.id}/leave/${editing}` : `/api/drivers/${driver.id}/leave`;
      const res = await fetch(url, {
        method: editing ? 'PATCH' : 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ from: form.from, until: form.until, coverDriverId: form.coverDriverId || null, note: form.note || null }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(errorMessage(body, 'Could not save the leave.'));
        return;
      }
      toast.success(editing ? `Leave of ${driver.name} changed.` : `Leave of ${driver.name} added: ${fmtDayMonth(form.from)} – ${fmtDayMonth(form.until)}.`);
      for (const w of (body?.data?.warnings ?? []) as string[]) toast.warning(w, { duration: 12_000 });
      setForm(blank);
      setEditing(null);
      await load();
      router.refresh();
    });
  }

  function remove(p: LeaveView) {
    if (!driver) return;
    if (!window.confirm(`Remove the leave of ${driver.name} from ${fmtDayMonth(p.from)} until ${fmtDayMonth(p.until)}?`)) return;
    startTransition(async () => {
      const res = await fetch(`/api/drivers/${driver.id}/leave/${p.id}`, { method: 'DELETE' });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(errorMessage(body, 'Could not remove the leave.'));
        return;
      }
      toast.success(`Leave of ${driver.name} removed.`);
      if (editing === p.id) {
        setEditing(null);
        setForm(blank);
      }
      await load();
      router.refresh();
    });
  }

  const started = (p: LeaveView) => !!today && p.from < today;

  return (
    <Dialog open={!!driver} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Leave of {driver?.name}</DialogTitle>
          <DialogDescription>
            On these days RouteIQ never puts {driver?.name ?? 'the driver'} on a load. His usual truck gets the cover driver when he is free that day;
            otherwise the load waits for you to pick a driver.
          </DialogDescription>
        </DialogHeader>

        <div className="max-h-56 space-y-1 overflow-y-auto text-sm" data-testid="leave-periods">
          {periods === null ? (
            <p className="text-muted-foreground">Loading…</p>
          ) : periods.length === 0 ? (
            <p className="text-muted-foreground">No leave recorded.</p>
          ) : (
            periods.map((p) => (
              <div key={p.id} className={`flex flex-wrap items-center gap-2 rounded-md border px-2 py-1 ${editing === p.id ? 'border-primary' : ''}`}>
                <Badge variant={PHASE[p.phase].variant}>{PHASE[p.phase].text}</Badge>
                <span className="font-medium">
                  {fmtDayMonth(p.from)} – {fmtDayMonth(p.until)}
                </span>
                <span className="text-muted-foreground">{p.coverName ? `cover ${p.coverName}` : 'no cover'}</span>
                {p.note ? <span className="text-muted-foreground">· {p.note}</span> : null}
                {canEdit && p.phase !== 'ENDED' ? (
                  <span className="ml-auto flex gap-2 text-xs">
                    <button type="button" className="text-primary hover:underline" onClick={() => startEdit(p)} disabled={pending}>
                      {started(p) ? 'Change / end early' : 'Change'}
                    </button>
                    {!started(p) ? (
                      <button type="button" className="text-destructive hover:underline" onClick={() => remove(p)} disabled={pending}>
                        Remove
                      </button>
                    ) : null}
                  </span>
                ) : null}
              </div>
            ))
          )}
        </div>

        {canEdit ? (
          <form onSubmit={submit} className="space-y-3 border-t pt-3">
            <p className="text-sm font-medium">{editing ? 'Change this leave' : 'Add leave'}</p>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="leave-from">From</Label>
                <Input
                  id="leave-from"
                  type="date"
                  value={form.from}
                  min={editing && periods?.find((x) => x.id === editing && started(x)) ? undefined : today || undefined}
                  disabled={!!editing && !!periods?.find((x) => x.id === editing && started(x))}
                  onChange={(e) => setForm({ ...form, from: e.target.value, until: form.until && form.until < e.target.value ? e.target.value : form.until })}
                  required
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="leave-until">Until (included)</Label>
                <Input id="leave-until" type="date" value={form.until} min={form.from || undefined} onChange={(e) => setForm({ ...form, until: e.target.value })} required />
              </div>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="leave-cover">Cover driver (drives his usual truck meanwhile)</Label>
              <select
                id="leave-cover"
                className="h-9 w-full rounded-md border bg-background px-2 text-sm"
                value={form.coverDriverId}
                onChange={(e) => setForm({ ...form, coverDriverId: e.target.value })}
              >
                <option value="">No cover: pick the driver on the plan</option>
                {covers.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.name}
                    {d.casual ? ' (daily)' : ''}
                  </option>
                ))}
              </select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="leave-note">Note</Label>
              <Input id="leave-note" value={form.note} maxLength={LEAVE_NOTE_MAX} placeholder="e.g. annual leave, sick" onChange={(e) => setForm({ ...form, note: e.target.value })} />
            </div>
            <DialogFooter>
              {editing ? (
                <Button
                  type="button"
                  variant="outline"
                  disabled={pending}
                  onClick={() => {
                    setEditing(null);
                    setForm(blank);
                  }}
                >
                  Cancel change
                </Button>
              ) : null}
              <Button type="submit" disabled={pending || !form.from || !form.until}>
                {pending ? 'Saving…' : editing ? 'Save change' : 'Add leave'}
              </Button>
            </DialogFooter>
          </form>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
