'use client';

import dynamic from 'next/dynamic';
import { useEffect, useRef, useState } from 'react';
import { MapPin, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { api } from './client-api';
import { createLocationRequests, type LocationRequests } from './location-requests';

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
 *
 * Every Read and Save belongs to the dialog as it was when it started (audit F06, location-requests.ts):
 * an answer for another customer, a closed dialog or text changed since never reaches the dialog
 * on screen, and one request runs at a time (the Read button and the Enter key alike).
 *
 * A point read earlier is out of date once the text in the box is no longer the text it was read
 * from (audit F06, residual): the preview is greyed with "Text changed - press Read", and Save waits
 * for a Read of the text on screen. A pin the dispatcher drops by hand is the point and can be saved.
 */
export function LocationDialog({ open, onOpenChange, customer, depot, onSaved }: Props) {
  const [input, setInput] = useState('');
  const [parse, setParse] = useState<ParseResult | null>(null);
  // The text the point on screen was read from: saved as the location's input, never other text typed since.
  const [readFrom, setReadFrom] = useState<string | null>(null);
  const [pin, setPin] = useState<{ lat: number; lng: number } | null>(null);
  const [pinMoved, setPinMoved] = useState(false);
  const [reading, setReading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [outsideConfirm, setOutsideConfirm] = useState(false);
  const requests = useRef<LocationRequests | null>(null);
  requests.current ??= createLocationRequests();
  const reqs = requests.current;
  const busy = reading || saving;

  useEffect(() => {
    // Opened, closed, or opened for another customer: nothing started before belongs to this dialog
    // (a Read on its way is aborted and its answer dropped). In the same effect as the reset below,
    // so an answer either arrives before it (and is reset) or after it (and is dropped).
    reqs.dialogChanged();
    setReading(false);
    setSaving(false);
    if (open) {
      setInput('');
      setParse(null);
      setReadFrom(null);
      setPinMoved(false);
      setOutsideConfirm(false);
      setPin(customer?.lat != null && customer?.lng != null ? { lat: customer.lat, lng: customer.lng } : null);
    }
  }, [open, customer, reqs]);

  function changeInput(v: string) {
    // A Read of the previous text is out of date (aborted, its answer dropped).
    reqs.inputChanged();
    setReading(false);
    setInput(v);
  }

  async function preview() {
    const text = input.trim();
    if (!text || !customer) return;
    // One request at a time: also for the Enter key, which used to start a Read while one was running.
    const started = reqs.beginRead();
    if (!started) return;
    setReading(true);
    const r = await api<ParseResult>('/api/locations/parse', { method: 'POST', json: { input: text }, signal: started.signal });
    // For another customer, a closed dialog, or text changed since: dropped (the dialog was reset).
    if (!reqs.answered(started.ticket)) return;
    setReading(false);
    if (!r.ok || !r.data) {
      toast.error(r.error ?? 'Could not read that.');
      return;
    }
    setParse(r.data);
    setReadFrom(text);
    if (r.data.ok && r.data.lat !== undefined && r.data.lng !== undefined) {
      setPin({ lat: r.data.lat, lng: r.data.lng });
      setPinMoved(false);
      // "Confirm & save" confirmed the earlier point being outside Oman/UAE, not this one.
      setOutsideConfirm(false);
    }
  }

  // The text in the box is not the text the point on screen was read from: other text typed after a
  // Read, or text never read (with nothing read, only an empty box saves the pin already on the map).
  const typed = input.trim();
  const textUnread = typed !== (readFrom ?? '');
  // No "press Read" while the Read of this text is running.
  const unreadNote = !textUnread || reading
    ? null
    : pinMoved
      ? typed
        ? 'This text was not read: Save keeps the pin you set on the map. Press Read to use the text instead.'
        : null
      : readFrom === null
        ? 'Press Read to find this point before saving.'
        : typed
          ? 'Text changed - press Read. The point shown is from the earlier text.'
          : 'Text cleared - paste it again and press Read, or drop the pin on the map.';
  const needsConfirmation = !!parse && (parse.needsPin || !parse.ok);
  const canSave = !!pin && (!textUnread || pinMoved) && (!needsConfirmation || pinMoved || (parse?.ok ?? false));

  async function save() {
    // The same rule as the button (a click that reaches a disabled button saves nothing either).
    if (!customer || !pin || !canSave) return;
    const ticket = reqs.beginSave();
    if (!ticket) return;
    setSaving(true);
    const target = customer;
    const source = pinMoved || !parse?.ok ? 'MAP_PIN' : parse?.source ?? 'MANUAL_LATLNG';
    // The saved input is the text the point was read from, never text that was not read (a pin
    // dropped by hand without a Read is stored as "map pin").
    const r = await api(`/api/customers/${target.customerId}/location`, {
      method: 'PUT',
      json: { lat: pin.lat, lng: pin.lng, source, input: readFrom ?? undefined, confirmOutsideArea: outsideConfirm || undefined },
    });
    if (!reqs.answered(ticket)) {
      // Closed, or opened for another customer, while saving: say what happened to this customer
      // only; the dialog on screen is left as it is (it must not close, or ask to confirm its point).
      if (r.ok) {
        toast.success(`Location saved for ${target.name}.`);
        onSaved();
      } else if (r.errorBody?.code === 'OUTSIDE_AREA') {
        toast.warning(`The location of ${target.name} was not saved: the point is outside Oman/UAE. Open ADD LOCATION again to confirm it.`);
      } else {
        toast.error(`The location of ${target.name} was not saved: ${r.error ?? 'error'}`);
      }
      return;
    }
    setSaving(false);
    if (!r.ok) {
      if (r.errorBody?.code === 'OUTSIDE_AREA') {
        setOutsideConfirm(true);
        toast.warning('That point is outside Oman/UAE. Press Save again to confirm it.');
        return;
      }
      toast.error(r.error ?? 'Could not save the location.');
      return;
    }
    toast.success(`Location saved for ${target.name}. RouteIQ will remember it.`);
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
                onChange={(e) => changeInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    void preview();
                  }
                }}
              />
              <Button type="button" variant="secondary" onClick={preview} disabled={busy || !input.trim()} data-testid="read-location">
                {reading ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Read'}
              </Button>
            </div>
            {unreadNote ? (
              <p className="text-xs font-medium text-amber-800" data-testid="location-text-unread">
                {unreadNote}
              </p>
            ) : null}
          </div>
          {parse ? (
            <div
              data-testid="location-preview"
              data-out-of-date={textUnread || undefined}
              className={`rounded-md border p-2 text-sm ${
                textUnread
                  ? 'border-muted bg-muted/40 text-muted-foreground'
                  : parse.ok && !parse.needsPin
                    ? 'border-green-300 bg-green-50'
                    : 'border-amber-300 bg-amber-50'
              }`}
            >
              {parse.ok ? (
                <p>
                  Found <b>{parse.lat?.toFixed(6)}, {parse.lng?.toFixed(6)}</b> ({parse.confidence?.toLowerCase()} confidence).
                  {parse.needsPin ? ' Check the pin on the map and move it if needed.' : ''}
                </p>
              ) : (
                <p>{parse.error}</p>
              )}
              {parse.warnings.map((w) => (
                <p key={w} className={`text-xs ${textUnread ? '' : 'text-amber-800'}`}>
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
              // The dispatcher's own pin wins over a Read still on its way.
              reqs.inputChanged();
              setReading(false);
              setPin({ lat, lng });
              setPinMoved(true);
              // A new point: "Confirm & save" confirmed the earlier one being outside Oman/UAE.
              setOutsideConfirm(false);
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
