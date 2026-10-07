'use client';

import { useEffect, useState } from 'react';
import { UserPlus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { casualDriverDialogText, type CasualDriverPlan } from '@/lib/dispatch/casual-driver-words';
import { onLeaveLabel, pickOnLeaveConfirm } from '@/lib/dispatch/driver-leave';
import type { ApiResult } from './client-api';

export interface CasualDriverBody {
  name: string;
  phone: string;
  useExisting?: string;
  /** The dispatcher answered "<name> is on leave until ... Put <name> on ... anyway?" (driver leave, 6 Oct 2026). */
  leaveConfirmed?: boolean;
}

export interface CasualDriverAnswer {
  driver: { id: string; name: string; code: string };
  reused: boolean;
  /** A truck rented for the day: its other planned loads the driver was also put on (one driver, the whole day). */
  alsoOn?: { loadId: string; loadNo: number }[];
}

/**
 * "+ Add daily driver…" from a load's Driver list (owner rule 20: a load never leaves without a
 * driver; daily drivers exist). Name and mobile; the driver is saved as a daily driver (no account)
 * and put on this load - on a truck rented for the day, on its other planned loads too and as its
 * default driver (one day-rate driver for the whole day; sixth review of the hire branch), said before
 * saving with the loads whose driver it replaces (`plan`, casualDriverPlan; seventh review: the dialog
 * said "put on this load" only). When the phone already belongs to a driver, the dialog asks "This
 * phone belongs to <name>. Use <name>?" - never a silent swap. A driver used again who is on
 * leave that day (driver leave, 6 Oct 2026) is put on the load only after the question the Driver
 * list asks: the server answers 409 DRIVER_ON_LEAVE (or names the leave in PHONE_BELONGS_TO), and
 * "Use <name>" then sends the answer (`leaveConfirmed`).
 */
export function CasualDriverDialog({
  load,
  onOpenChange,
  submit,
}: {
  /** The load the driver is for, and what the quick add will do for it (casualDriverPlan); null = closed. */
  load: { id: string; truckCode: string; loadNo: number; plan: CasualDriverPlan } | null;
  onOpenChange: (open: boolean) => void;
  /** Posts the body (POST /api/dispatch/casual-driver) under the plan's action lock; null when another action was running. */
  submit: (body: CasualDriverBody) => Promise<ApiResult<CasualDriverAnswer> | null>;
}) {
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The question to answer: the phone belongs to a driver, and/or the driver used again is on leave that day.
  const [belongs, setBelongs] = useState<{ driverId: string; name: string; casual: boolean; leaveUntil: string | null; onlyLeave: boolean } | null>(null);

  // A fresh form for each load the dialog opens for (the parent passes a new object on every render).
  const loadId = load?.id ?? null;
  useEffect(() => {
    if (loadId) {
      setName('');
      setPhone('');
      setError(null);
      setBelongs(null);
    }
  }, [loadId]);

  const send = async (useExisting?: string, leaveConfirmed = false) => {
    setBusy(true);
    setError(null);
    const r = await submit({ name: name.trim(), phone: phone.trim(), ...(useExisting ? { useExisting } : {}), ...(leaveConfirmed ? { leaveConfirmed: true } : {}) });
    setBusy(false);
    if (!r) {
      setError('Another change of this plan is running. Try again in a moment.');
      return;
    }
    if (r.ok) {
      onOpenChange(false);
      return;
    }
    const b = r.errorBody;
    if (r.status === 409 && b?.code === 'PHONE_BELONGS_TO' && typeof b.driverId === 'string' && typeof b.name === 'string') {
      setBelongs({ driverId: b.driverId, name: b.name, casual: b.casual === true, leaveUntil: typeof b.leaveUntil === 'string' ? b.leaveUntil : null, onlyLeave: false });
      return;
    }
    if (r.status === 409 && b?.code === 'DRIVER_ON_LEAVE' && typeof b.driverId === 'string' && typeof b.name === 'string' && typeof b.until === 'string') {
      setBelongs({ driverId: b.driverId, name: b.name, casual: true, leaveUntil: b.until, onlyLeave: true });
      return;
    }
    setError(r.error ?? 'Could not add the daily driver.');
  };

  const nameOk = name.trim().length >= 2 && name.trim().length <= 80;
  const words = load ? casualDriverDialogText(load, load.plan) : null;

  return (
    <Dialog open={load !== null} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md" data-testid="casual-driver-dialog">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <UserPlus className="h-5 w-5" /> Add a daily driver
          </DialogTitle>
          <DialogDescription data-testid="casual-driver-intro">{words?.intro ?? ''}</DialogDescription>
        </DialogHeader>
        {belongs ? (
          <div className="space-y-3 text-sm" data-testid="phone-belongs">
            {belongs.onlyLeave ? (
              <p className="text-amber-700" data-testid="casual-on-leave">
                {pickOnLeaveConfirm(belongs.name, belongs.leaveUntil!, load ? `${load.truckCode} · L${load.loadNo}` : 'this load')}
              </p>
            ) : (
              <p>
                This phone belongs to {belongs.casual ? 'daily driver' : 'driver'} <strong>{belongs.name}</strong>
                {belongs.leaveUntil ? <span className="text-amber-700">, who is {onLeaveLabel(belongs.leaveUntil)}</span> : null}. Use {belongs.name}
                {belongs.leaveUntil ? ' anyway' : ''}?
              </p>
            )}
            <div className="flex flex-wrap gap-2">
              {/* With the leave named in the question, "Use" is the answer to it too. */}
              <Button disabled={busy} onClick={() => void send(belongs.driverId, !!belongs.leaveUntil)}>
                Use {belongs.name}
                {belongs.leaveUntil ? ' anyway' : ''}
              </Button>
              <Button variant="outline" disabled={busy} onClick={() => setBelongs(null)}>
                {belongs.onlyLeave ? 'Back' : 'Change the phone'}
              </Button>
            </div>
          </div>
        ) : (
          <form
            className="space-y-3"
            onSubmit={(e) => {
              e.preventDefault();
              if (nameOk) void send();
            }}
          >
            <div className="space-y-1.5">
              <Label htmlFor="casual-name">Name</Label>
              <Input id="casual-name" value={name} onChange={(e) => setName(e.target.value)} maxLength={80} autoFocus required />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="casual-phone">Mobile (optional)</Label>
              <Input id="casual-phone" value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="+968 9123 4567" maxLength={40} inputMode="tel" />
              <p className="text-[11px] text-muted-foreground">With the country code, so WhatsApp opens the right chat.</p>
            </div>
            {error ? <p className="text-sm text-destructive">{error}</p> : null}
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
                Cancel
              </Button>
              <Button type="submit" disabled={busy || !nameOk} data-testid="casual-driver-save">
                {busy ? 'Saving…' : (words?.button ?? 'Add and put on this load')}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
