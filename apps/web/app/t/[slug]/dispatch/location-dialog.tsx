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
import { notExactMessage, type ServiceArea } from '@/lib/dispatch/location-input';
import { LOCATION_ADMIN_ONLY_MESSAGE, savedPointProblem } from '@/lib/dispatch/customer-attrs';

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

export const UNREAD_PIN_TEXT = "This could not be read. Drop the pin on the customer's exact location, then save.";

interface Props {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  customer: {
    customerId: string;
    code: string;
    branchCode: string | null;
    name: string;
    lat: number | null;
    lng: number | null;
    /** How exact the saved point is (owner's location rule): only an exact one can be saved again as it is. */
    locationVerified?: boolean;
    geocodeConfidence?: string | null;
  } | null;
  depot: { lat: number; lng: number };
  /**
   * The company's delivery area (Settings; Oman + UAE by default), as the server checks it: a saved
   * pin outside it that no dispatcher confirmed is not saved again as it is (A5 review).
   */
  serviceArea: ServiceArea;
  /**
   * Owner decision 1 Oct 2026 (location admin-lock): the customer has a usable saved location and the
   * user is not an admin, so only the saved point can be confirmed as it is; any other point is
   * refused (403 LOCATION_ADMIN_ONLY, the server checks it again).
   */
  locked?: boolean;
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
 *
 * The owner's location rule (27 Sep 2026, audit PR A5): "locations should always be correct". A
 * reading that is not exact (`needsPin`: LOW, and the MEDIUM ones - map centre, fewer than 4
 * decimals, degrees and minutes only, swapped, outside the area) or that could not be read is never
 * saved as read: Save stays off until the dispatcher drops or drags the pin by hand. The customer's
 * saved pin, shown when the dialog opens, can be saved again as it is only when it is exact:
 * verified, or HIGH and inside the company's delivery area (`savedPointProblem`, the server's own
 * test, with the reason as the note: not exact, outside the area, or latitude and longitude swapped).
 * The server checks all of this again (PUT /api/customers/:id/location).
 */
export function LocationDialog({ open, onOpenChange, customer, depot, serviceArea, locked = false, onSaved }: Props) {
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
  // A reading that is not exact, or not read: only a pin placed by hand can be saved (owner's rule).
  const needsConfirmation = !!parse && (parse.needsPin || !parse.ok);
  // Nothing read and no hand pin: Save would store the customer's saved pin as it is.
  const savedAsIs = !!pin && !pinMoved && readFrom === null;
  // Why that saved pin cannot be saved as it is (null = it can): the server's test, with the company's area.
  const savedProblem = savedAsIs && customer ? savedPointProblem(customer, serviceArea) : null;
  const savedNotExact = savedProblem !== null;
  const canSave = !!pin && (!textUnread || pinMoved) && (!needsConfirmation || pinMoved) && !savedNotExact && (!locked || savedAsIs);
  // What to do, in the owner's words (not while the text on screen waits for a Read: that note says it).
  // A pair padded with zeros says why first (owner decision of 28 Sep 2026: only one zero at the end
  // counts, and the text on screen looks like 4 decimals); the server's 422 says the same.
  const pinNote = pinMoved || textUnread || reading
    ? null
    : needsConfirmation
      ? parse?.ok
        ? notExactMessage(parse)
        : UNREAD_PIN_TEXT
      : savedProblem;
  // The preview's notes, without one the note above already says.
  const previewWarnings = parse ? parse.warnings.filter((w) => !pinNote?.startsWith(w)) : [];

  async function save() {
    // The same rule as the button (a click that reaches a disabled button saves nothing either).
    if (!customer || !pin || !canSave) return;
    const ticket = reqs.beginSave();
    if (!ticket) return;
    setSaving(true);
    const target = customer;
    const source = pinMoved || !parse?.ok ? 'MAP_PIN' : parse?.source ?? 'MANUAL_LATLNG';
    // The saved input is the text the point was read from, never text that was not read (a pin
    // dropped by hand without a Read is stored as "map pin"). With it goes the address a short link
    // led to at that Read, so the server reads the same text again without opening the link.
    const r = await api(`/api/customers/${target.customerId}/location`, {
      method: 'PUT',
      json: {
        lat: pin.lat,
        lng: pin.lng,
        source,
        input: readFrom ?? undefined,
        resolvedUrl: readFrom !== null ? parse?.resolvedUrl : undefined,
        confirmOutsideArea: outsideConfirm || undefined,
      },
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
          {locked ? (
            <p className="rounded-md border border-amber-300 bg-amber-50 p-2 text-xs font-medium text-amber-900" data-testid="location-admin-only">
              {LOCATION_ADMIN_ONLY_MESSAGE} You can confirm the saved location as it is. If it is wrong, ask your company admin to change it.
            </p>
          ) : null}
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
            {pinNote ? (
              <p className="text-xs font-semibold text-red-700" data-testid="location-pin-required">
                {pinNote}
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
                  {parse.needsPin ? ' Not exact: drop the pin on the map by hand.' : ''}
                </p>
              ) : (
                <p>{parse.error}</p>
              )}
              {previewWarnings.map((w) => (
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
            {outsideConfirm ? 'Confirm & save' : locked ? 'Confirm saved location' : 'Save location'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
