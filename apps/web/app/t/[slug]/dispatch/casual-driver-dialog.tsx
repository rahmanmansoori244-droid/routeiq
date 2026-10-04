'use client';

import { useEffect, useState } from 'react';
import { UserPlus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import type { ApiResult } from './client-api';

export interface CasualDriverBody {
  name: string;
  phone: string;
  useExisting?: string;
}

export interface CasualDriverAnswer {
  driver: { id: string; name: string; code: string };
  reused: boolean;
}

/**
 * "+ Add daily driver…" from a load's Driver list (owner rule 20: a load never leaves without a
 * driver; daily drivers exist). Name and mobile; the driver is saved as a daily driver (no account)
 * and put on this load. When the phone already belongs to a driver, the dialog asks
 * "This phone belongs to <name>. Use <name>?" - never a silent swap.
 */
export function CasualDriverDialog({
  load,
  onOpenChange,
  submit,
}: {
  /** The load the driver is for; null = closed. */
  load: { id: string; truckCode: string; loadNo: number } | null;
  onOpenChange: (open: boolean) => void;
  /** Posts the body (POST /api/dispatch/casual-driver) under the plan's action lock; null when another action was running. */
  submit: (body: CasualDriverBody) => Promise<ApiResult<CasualDriverAnswer> | null>;
}) {
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [belongs, setBelongs] = useState<{ driverId: string; name: string; casual: boolean } | null>(null);

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

  const send = async (useExisting?: string) => {
    setBusy(true);
    setError(null);
    const r = await submit({ name: name.trim(), phone: phone.trim(), ...(useExisting ? { useExisting } : {}) });
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
      setBelongs({ driverId: b.driverId, name: b.name, casual: b.casual === true });
      return;
    }
    setError(r.error ?? 'Could not add the daily driver.');
  };

  const nameOk = name.trim().length >= 2 && name.trim().length <= 80;

  return (
    <Dialog open={load !== null} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md" data-testid="casual-driver-dialog">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <UserPlus className="h-5 w-5" /> Add a daily driver
          </DialogTitle>
          <DialogDescription>
            {load ? `${load.truckCode} L${load.loadNo}. ` : ''}A daily (casual) driver or the driver of a hired truck. Saved as a daily driver with no account, and
            put on this load. They open their trips with the driver link (QR).
          </DialogDescription>
        </DialogHeader>
        {belongs ? (
          <div className="space-y-3 text-sm" data-testid="phone-belongs">
            <p>
              This phone belongs to {belongs.casual ? 'daily driver' : 'driver'} <strong>{belongs.name}</strong>. Use {belongs.name}?
            </p>
            <div className="flex flex-wrap gap-2">
              <Button disabled={busy} onClick={() => void send(belongs.driverId)}>
                Use {belongs.name}
              </Button>
              <Button variant="outline" disabled={busy} onClick={() => setBelongs(null)}>
                Change the phone
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
                {busy ? 'Saving…' : 'Add and put on this load'}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
