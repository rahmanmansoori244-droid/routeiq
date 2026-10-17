'use client';

/**
 * GPS trackers (IVMS live link, 16 Oct 2026, design section 8.1): the company admin maps each truck to
 * its Ayun tracker by IMEI. Shown to the company admin only (the Trucks page decides). "Suggest from
 * Ayun" makes one call to the provider's object list (only when GPS tracking is MAP or TIMES) and offers,
 * per truck without a tracker, the trackers with the same plate digits: never a provider name or plate.
 * A one-day hired truck never gets a tracker. "Remove GPS times of a day" is the undo of the runbook
 * (docs/admin.md, first review M-3): a check (dry run) first, then the removal, audited.
 */
import { useState } from 'react';
import { toast } from 'sonner';
import { Satellite } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { errorMessage } from '@/lib/error-message';
import { normalizeImei, type MatchKind } from '@/lib/ivms/match';

export interface TrackerTruck {
  id: string;
  code: string;
  ivmsImei: string | null;
}

interface Suggestion {
  truckId: string;
  imei: string;
  match: MatchKind;
  fixAgeMin: number | null;
}

const MATCH_TEXT: Record<MatchKind, string> = { EXACT: 'same plate', DIGITS: 'same plate digits', AMBIGUOUS: 'one of several with these digits' };

/** Today in the browser's time zone, YYYY-MM-DD (the office is in the company's time zone). */
const localToday = () => new Date().toLocaleDateString('en-CA');

interface UndoCount {
  truckId: string;
  date: string;
  events: number;
  visits: number;
}

async function send<T>(url: string, init: RequestInit): Promise<{ ok: true; data: T } | { ok: false; message: string }> {
  try {
    const res = await fetch(url, { ...init, headers: { 'content-type': 'application/json' } });
    const body = (await res.json().catch(() => null)) as { data?: T; error?: unknown } | null;
    if (res.ok && body?.data !== undefined) return { ok: true, data: body.data };
    return { ok: false, message: errorMessage(body, `The server answered ${res.status}.`) };
  } catch {
    return { ok: false, message: 'No connection: nothing was saved. Try again.' };
  }
}

export function GpsTrackersCard({ trucks, canSuggest, modeText }: { trucks: TrackerTruck[]; canSuggest: boolean; modeText: string }) {
  const [rows, setRows] = useState(trucks);
  const [typed, setTyped] = useState<Record<string, string>>(() => Object.fromEntries(trucks.map((t) => [t.id, t.ivmsImei ?? ''])));
  const [busy, setBusy] = useState<string | null>(null);
  const [suggestions, setSuggestions] = useState<Suggestion[] | null>(null);
  const [summary, setSummary] = useState<string | null>(null);
  const [undoTruck, setUndoTruck] = useState(trucks[0]?.id ?? '');
  const [undoDate, setUndoDate] = useState(localToday);
  const [undoCount, setUndoCount] = useState<UndoCount | null>(null);

  async function save(truckId: string, value: string | null) {
    setBusy(truckId);
    const r = await send<{ imei: string | null; suppressedToday: boolean }>(`/api/ivms/trucks/${truckId}/tracker`, { method: 'PUT', body: JSON.stringify({ imei: value }) });
    setBusy(null);
    if (!r.ok) return void toast.error(r.message);
    setRows((xs) => xs.map((x) => (x.id === truckId ? { ...x, ivmsImei: r.data.imei } : x)));
    setTyped((m) => ({ ...m, [truckId]: r.data.imei ?? '' }));
    toast.success(r.data.imei ? 'GPS tracker saved.' : 'GPS tracker removed.');
    if (r.data.suppressedToday) toast.message("Today's GPS times of this truck are no longer written (the tracker changed during the day).");
  }

  async function undo(dryRun: boolean) {
    const code = rows.find((x) => x.id === undoTruck)?.code ?? '';
    if (!dryRun && !window.confirm(`Remove the GPS times of ${code} on ${undoDate}? The driver's and the office's times stay; GPS writes nothing more for this truck and day.`)) return;
    setBusy('undo');
    const r = await send<UndoCount & { dryRun: boolean }>(`/api/ivms/trucks/${undoTruck}/gps-times`, { method: 'POST', body: JSON.stringify({ date: undoDate, dryRun }) });
    setBusy(null);
    if (!r.ok) return void toast.error(r.message);
    if (dryRun) return void setUndoCount({ truckId: r.data.truckId, date: r.data.date, events: r.data.events, visits: r.data.visits });
    setUndoCount(null);
    toast.success(`${r.data.events} GPS time${r.data.events === 1 ? '' : 's'} removed from ${r.data.visits} stop${r.data.visits === 1 ? '' : 's'}.`);
  }

  async function suggest() {
    setBusy('suggest');
    const r = await send<{ suggestions: Suggestion[]; unmatchedTrackers: number; trackers: number }>('/api/ivms/objects', { method: 'POST', body: '{}' });
    setBusy(null);
    if (!r.ok) return void toast.error(r.message);
    setSuggestions(r.data.suggestions);
    setSummary(`${r.data.trackers} tracker${r.data.trackers === 1 ? '' : 's'} on the Ayun account; ${r.data.unmatchedTrackers} match no truck without a tracker.`);
  }

  return (
    <Card>
      <CardHeader className="py-3">
        <CardTitle className="flex items-center gap-2 text-sm">
          <Satellite className="h-4 w-4" /> GPS trackers (Ayun)
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        <p className="text-muted-foreground">
          The tracker of each truck, by its IMEI (digits only, from the Ayun portal). A truck without one keeps using the driver&apos;s phone only. {modeText}
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <Button type="button" size="sm" variant="outline" disabled={!canSuggest || busy !== null} onClick={() => void suggest()} title={canSuggest ? 'One call to Ayun: trackers with the same plate digits' : 'Available when GPS tracking is MAP or TIMES and the Ayun account is set up'}>
            Suggest from Ayun
          </Button>
          {summary ? <span className="text-xs text-muted-foreground">{summary}</span> : null}
        </div>
        <table className="w-full text-sm" data-testid="gps-trackers">
          <thead>
            <tr className="text-left text-xs text-muted-foreground">
              <th className="py-1 pr-2">Truck</th>
              <th className="py-1 pr-2">Tracker IMEI</th>
              <th className="py-1" />
            </tr>
          </thead>
          <tbody>
            {rows.map((t) => {
              const value = typed[t.id] ?? '';
              const valid = value.trim() === '' || normalizeImei(value) !== null;
              const mine = (suggestions ?? []).filter((s) => s.truckId === t.id);
              return (
                <tr key={t.id} className="border-t align-top">
                  <td className="py-1 pr-2 font-medium">{t.code}</td>
                  <td className="py-1 pr-2">
                    <Input
                      value={value}
                      inputMode="numeric"
                      aria-label={`GPS tracker IMEI of ${t.code}`}
                      aria-invalid={!valid}
                      className="h-8 max-w-[16rem]"
                      onChange={(e) => setTyped((m) => ({ ...m, [t.id]: e.target.value }))}
                    />
                    {!valid ? <p className="text-xs text-red-700">10 to 20 digits.</p> : null}
                    {mine.map((s) => (
                      <p key={s.imei} className="mt-1 text-xs text-muted-foreground">
                        Ayun: {s.imei} ({MATCH_TEXT[s.match]}
                        {s.fixAgeMin !== null ? `, last position ${s.fixAgeMin} min ago` : ''}){' '}
                        <button type="button" className="underline" onClick={() => setTyped((m) => ({ ...m, [t.id]: s.imei }))}>
                          Use
                        </button>
                      </p>
                    ))}
                  </td>
                  <td className="space-x-1 py-1 text-right">
                    <Button type="button" size="sm" className="h-8" disabled={busy !== null || !valid || (value.trim() || null) === (t.ivmsImei ?? null)} onClick={() => void save(t.id, value.trim() || null)}>
                      Save
                    </Button>
                    {t.ivmsImei ? (
                      <Button type="button" size="sm" variant="outline" className="h-8" disabled={busy !== null} onClick={() => void save(t.id, null)}>
                        Clear
                      </Button>
                    ) : null}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        <div className="space-y-2 border-t pt-3" data-testid="gps-undo">
          <p className="font-medium">Remove GPS times of a day</p>
          <p className="text-xs text-muted-foreground">
            If a tracker or the time setting was wrong: removes the GPS arrival and departure times one truck got on one day. The driver&apos;s and the office&apos;s times stay, and GPS writes nothing more for
            that truck and day.
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <select
              aria-label="Truck"
              className="h-8 rounded-md border px-2 text-sm"
              value={undoTruck}
              onChange={(e) => {
                setUndoTruck(e.target.value);
                setUndoCount(null);
              }}
            >
              {rows.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.code}
                </option>
              ))}
            </select>
            <Input
              type="date"
              aria-label="Delivery date"
              className="h-8 w-40"
              value={undoDate}
              max={localToday()}
              onChange={(e) => {
                setUndoDate(e.target.value);
                setUndoCount(null);
              }}
            />
            <Button type="button" size="sm" variant="outline" className="h-8" disabled={busy !== null || !undoTruck || !undoDate} onClick={() => void undo(true)}>
              Check
            </Button>
            {undoCount && undoCount.truckId === undoTruck && undoCount.date === undoDate ? (
              <>
                <span className="text-xs text-muted-foreground">
                  {undoCount.events} GPS time{undoCount.events === 1 ? '' : 's'} on {undoCount.visits} stop{undoCount.visits === 1 ? '' : 's'}.
                </span>
                <Button type="button" size="sm" variant="destructive" className="h-8" disabled={busy !== null} onClick={() => void undo(false)}>
                  Remove
                </Button>
              </>
            ) : null}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
