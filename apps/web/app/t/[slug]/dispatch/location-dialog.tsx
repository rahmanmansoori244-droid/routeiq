'use client';

import dynamic from 'next/dynamic';
import { useEffect, useState } from 'react';
import { MapPin, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { api } from './client-api';

const PinMap = dynamic(() => import('@/components/pin-map').then((m) => m.PinMap), { ssr: false });

interface ParseResult {
  ok: boolean;
  lat?: number;
  lng?: number;
  source?: 'MANUAL_LATLNG' | 'GOOGLE_MAPS_URL' | 'MAP_PIN';
  confidence?: string;
  needsPin: boolean;
  warnings: string[];
  error?: string;
  resolvedUrl?: string;
}

interface Props {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  customer: { customerId: string; code: string; branchCode: string | null; name: string; lat: number | null; lng: number | null } | null;
  depot: { lat: number; lng: number };
  onSaved: () => void;
}

/**
 * ADD LOCATION: paste a Google Maps link (incl. maps.app.goo.gl short links) or "lat, lng",
 * preview it, then confirm. If the link is not precise the dispatcher confirms/drops a pin.
 * Saving writes the customer master permanently.
 */
export function LocationDialog({ open, onOpenChange, customer, depot, onSaved }: Props) {
  const [input, setInput] = useState('');
  const [parse, setParse] = useState<ParseResult | null>(null);
  const [pin, setPin] = useState<{ lat: number; lng: number } | null>(null);
  const [pinMoved, setPinMoved] = useState(false);
  const [busy, setBusy] = useState(false);
  const [outsideConfirm, setOutsideConfirm] = useState(false);

  useEffect(() => {
    if (open) {
      setInput('');
      setParse(null);
      setPinMoved(false);
      setOutsideConfirm(false);
      setPin(customer?.lat != null && customer?.lng != null ? { lat: customer.lat, lng: customer.lng } : null);
    }
  }, [open, customer]);

  async function preview() {
    if (!input.trim()) return;
    setBusy(true);
    const r = await api<ParseResult>('/api/locations/parse', { method: 'POST', json: { input } });
    setBusy(false);
    if (!r.ok || !r.data) {
      toast.error(r.error ?? 'Could not read that.');
      return;
    }
    setParse(r.data);
    if (r.data.ok && r.data.lat !== undefined && r.data.lng !== undefined) {
      setPin({ lat: r.data.lat, lng: r.data.lng });
      setPinMoved(false);
    }
  }

  const needsConfirmation = !!parse && (parse.needsPin || !parse.ok);
  const canSave = !!pin && (!needsConfirmation || pinMoved || (parse?.ok ?? false));

  async function save() {
    if (!customer || !pin) return;
    setBusy(true);
    const source = pinMoved || !parse?.ok ? 'MAP_PIN' : parse?.source ?? 'MANUAL_LATLNG';
    const r = await api(`/api/customers/${customer.customerId}/location`, {
      method: 'PUT',
      json: { lat: pin.lat, lng: pin.lng, source, input: input.trim() || undefined, confirmOutsideArea: outsideConfirm || undefined },
    });
    setBusy(false);
    if (!r.ok) {
      if (r.errorBody?.code === 'OUTSIDE_AREA') {
        setOutsideConfirm(true);
        toast.warning('That point is outside Oman/UAE. Press Save again to confirm it.');
        return;
      }
      toast.error(r.error ?? 'Could not save the location.');
      return;
    }
    toast.success(`Location saved for ${customer.name}. RouteIQ will remember it.`);
    onOpenChange(false);
    onSaved();
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Add location</DialogTitle>
          <DialogDescription>
            {customer ? `${customer.name} — ${customer.code}${customer.branchCode ? ` / ${customer.branchCode}` : ''}` : ''}. Paste a Google Maps link or
            coordinates, or click the map. Saved permanently to the customer master.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1">
            <Label htmlFor="loc-input">Google Maps link or “latitude, longitude”</Label>
            <div className="flex gap-2">
              <Input
                id="loc-input"
                value={input}
                placeholder="https://maps.app.goo.gl/…  or  23.5880, 58.4081"
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    void preview();
                  }
                }}
              />
              <Button type="button" variant="secondary" onClick={preview} disabled={busy || !input.trim()}>
                {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Read'}
              </Button>
            </div>
          </div>
          {parse ? (
            <div className={`rounded-md border p-2 text-sm ${parse.ok && !parse.needsPin ? 'border-green-300 bg-green-50' : 'border-amber-300 bg-amber-50'}`}>
              {parse.ok ? (
                <p>
                  Found <b>{parse.lat?.toFixed(6)}, {parse.lng?.toFixed(6)}</b> ({parse.confidence?.toLowerCase()} confidence).
                  {parse.needsPin ? ' Check the pin on the map and move it if needed.' : ''}
                </p>
              ) : (
                <p>{parse.error}</p>
              )}
              {parse.warnings.map((w) => (
                <p key={w} className="text-xs text-amber-800">
                  {w}
                </p>
              ))}
            </div>
          ) : null}
          <PinMap
            lat={pin?.lat ?? null}
            lng={pin?.lng ?? null}
            center={depot}
            onChange={(lat, lng) => {
              setPin({ lat, lng });
              setPinMoved(true);
            }}
          />
          <p className="flex items-center gap-1 text-xs text-muted-foreground">
            <MapPin className="h-3 w-3" />
            {pin ? `Pin: ${pin.lat.toFixed(6)}, ${pin.lng.toFixed(6)}${pinMoved ? ' (set on map)' : ''}` : 'Click the map to drop a pin.'}
          </p>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={save} disabled={!canSave || busy} data-testid="save-location">
            {outsideConfirm ? 'Confirm & save' : 'Save location'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
