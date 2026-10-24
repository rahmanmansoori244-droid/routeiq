'use client';

import { useEffect, useMemo, useState } from 'react';
import { ArrowRightLeft, CheckCircle2, AlertTriangle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import type { DetailLoad, DetailStop, DetailUnserved, PlanDetail } from '@/lib/dispatch/plan-detail';
import { palletText } from '@/lib/dispatch/pallets';
import {
  EDIT_ERROR_TEXT,
  positionChoices,
  signedOmr,
  type EditTarget,
  type EditTruckDayView,
  type PlanEditMove,
  type PlanEditPreview,
  type PlanEditSaved,
} from '@/lib/dispatch/plan-edit-view';
import { api, hhmm } from './client-api';

/** What the dialog moves: a stop of a PLANNED load, or an unserved customer visit (all its unserved orders). */
export type MoveSubject = { kind: 'MOVE'; load: DetailLoad; stop: DetailStop } | { kind: 'PLACE'; unserved: DetailUnserved; orders: number; cases: number };

/** The choices of the Load list: an existing load, a new load (at the end, before a load, best place), or off the plan. */
type LoadChoice = string; // `load:<id>` | 'new:end' | `new:before:<id>` | 'new:best' | 'remove'

const label = (s: { customerName: string; customerCode: string; branchCode: string | null }) => `${s.customerName} (${s.customerCode}${s.branchCode ? `/${s.branchCode}` : ''})`;
const stopsText = (n: number) => `${n} stop${n === 1 ? '' : 's'}`;

/** "T08 after (−6.16 OMR, back −20 min)": the change of one truck's day, each part only when known. */
export function afterTitle(t: { truckCode: string; deltaCostOmr: number | null; deltaLastReturnMin: number | null }): string {
  const parts = [
    ...(t.deltaCostOmr !== null ? [`${signedOmr(t.deltaCostOmr)} OMR`] : []),
    ...(t.deltaLastReturnMin !== null && t.deltaLastReturnMin !== 0 ? [`back ${t.deltaLastReturnMin > 0 ? '+' : '−'}${Math.abs(t.deltaLastReturnMin)} min`] : []),
  ];
  return `${t.truckCode} after${parts.length ? ` (${parts.join(', ')})` : ''}`;
}

/** The change the dialog's choices make (null: nothing chosen yet). */
export function moveOfChoices(subject: MoveSubject, truckId: string, choice: LoadChoice, position: number | 'BEST'): PlanEditMove | null {
  if (subject.kind === 'MOVE' && choice === 'remove') return { kind: 'REMOVE', from: { loadId: subject.load.id, sequence: subject.stop.sequence } };
  let to: EditTarget | null = null;
  if (choice.startsWith('load:')) to = { truckId, loadId: choice.slice(5), position };
  else if (choice === 'new:end') to = { truckId, loadId: null, before: null };
  else if (choice === 'new:best') to = { truckId, loadId: null, before: 'BEST' };
  else if (choice.startsWith('new:before:')) to = { truckId, loadId: null, before: choice.slice(11) };
  if (!to) return null;
  return subject.kind === 'MOVE' ? { kind: 'MOVE', from: { loadId: subject.load.id, sequence: subject.stop.sequence }, to } : { kind: 'PLACE', orderId: subject.unserved.orderId, to };
}

/**
 * Move stop (moves by hand, PR M3): pick the truck, the load (an existing PLANNED one, a new load, or
 * off the plan) and the position (Best place by default), press Check (one solver re-timing per press,
 * never on every change), read the result - before and after per truck, the rules it breaks in red, the
 * soft warnings in amber, what changed since planning - then Save as version N+1. Check and Save run
 * under the plan screen's action lock (`run`). A LOCKED load is offered disabled ("unlock it first");
 * LOADING and loads that left are never offered.
 */
export function MoveStopDialog({
  subject,
  plan,
  runId,
  onOpenChange,
  run,
  afterSave,
}: {
  subject: MoveSubject | null;
  plan: PlanDetail;
  runId: string;
  onOpenChange: (open: boolean) => void;
  /** Runs a request under the plan's action lock; false = another change of the plan was running. */
  run: (key: string, fn: () => Promise<void>) => Promise<boolean>;
  afterSave: (saved: PlanEditSaved) => Promise<void> | void;
}) {
  const trucks = plan.edit?.trucks ?? [];
  const startTruck = subject?.kind === 'MOVE' ? subject.load.truckId : (plan.loads.find((l) => l.status === 'PLANNED')?.truckId ?? trucks[0]?.id ?? '');
  const [truckId, setTruckId] = useState(startTruck);
  const [choice, setChoice] = useState<LoadChoice>('');
  const [position, setPosition] = useState<number | 'BEST'>('BEST');
  const [preview, setPreview] = useState<PlanEditPreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<'check' | 'save' | null>(null);

  // A fresh dialog for each subject.
  const key = subject ? (subject.kind === 'MOVE' ? `${subject.load.id}:${subject.stop.sequence}` : subject.unserved.orderId) : null;
  useEffect(() => {
    if (!key) return;
    setTruckId(startTruck);
    setChoice(subject?.kind === 'MOVE' ? `load:${subject.load.id}` : '');
    setPosition('BEST');
    setPreview(null);
    setError(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  const truckLoads = useMemo(() => plan.loads.filter((l) => l.truckId === truckId).sort((a, b) => a.loadNo - b.loadNo), [plan.loads, truckId]);
  const truck = trucks.find((t) => t.id === truckId) ?? null;
  // A new load needs a trip left: the source load disappears when the stop was its only one.
  const sourceGoes = subject?.kind === 'MOVE' && subject.load.truckId === truckId && subject.load.stops.length === 1;
  const tripLeft = !!truck && truckLoads.length - (sourceGoes ? 1 : 0) < truck.maxTrips;
  const targetLoad = choice.startsWith('load:') ? (truckLoads.find((l) => l.id === choice.slice(5)) ?? null) : null;
  const positionLabels = targetLoad
    ? targetLoad.stops.filter((s) => !(subject?.kind === 'MOVE' && targetLoad.id === subject.load.id && s.sequence === subject.stop.sequence)).map((s) => s.customerName)
    : [];
  const move = subject ? moveOfChoices(subject, truckId, choice, position) : null;
  const expect = { date: plan.run.runDate, depotId: plan.run.depot.id };

  const changed = () => {
    setPreview(null);
    setError(null);
  };

  async function check(m: PlanEditMove | null = move) {
    if (!m) return;
    setError(null);
    const ran = await run('plan-edit-check', async () => {
      setBusy('check');
      try {
        const r = await api<PlanEditPreview>(`/api/runs/${runId}/edit/check`, { method: 'POST', json: { move: m, expect } });
        if (r.ok && r.data) setPreview(r.data);
        else {
          setPreview(null);
          setError(r.status === 503 ? (r.error ?? EDIT_ERROR_TEXT.SOLVER_FAILED) : (r.error ?? 'The move could not be checked.'));
        }
      } finally {
        setBusy(null);
      }
    });
    if (!ran) setError('Another change of this plan is running. Try again in a moment.');
  }

  async function save() {
    if (!preview?.canSave) return;
    setError(null);
    const ran = await run('plan-edit-save', async () => {
      setBusy('save');
      try {
        const r = await api<PlanEditSaved>(`/api/runs/${runId}/edit`, {
          method: 'POST',
          json: { move: preview.move, expect, previewHash: preview.previewHash, builtAt: preview.builtAt },
        });
        if (r.ok && r.data) {
          onOpenChange(false);
          await afterSave(r.data);
          return;
        }
        const fresh = r.errorBody?.preview as PlanEditPreview | undefined;
        if (fresh && typeof fresh === 'object' && typeof fresh.previewHash === 'string') setPreview(fresh);
        else if (r.errorBody?.code === 'PREVIEW_OLD' || r.errorBody?.code === 'DAY_CHANGED') setPreview(null);
        const code = typeof r.errorBody?.code === 'string' ? r.errorBody.code : '';
        setError((code in EDIT_ERROR_TEXT ? EDIT_ERROR_TEXT[code as keyof typeof EDIT_ERROR_TEXT] : null) ?? r.error ?? 'The change could not be saved.');
      } finally {
        setBusy(null);
      }
    });
    if (!ran) setError('Another change of this plan is running. Try again in a moment.');
  }

  if (!subject || !plan.edit) return null;
  const title =
    subject.kind === 'MOVE'
      ? `Move ${label(subject.stop)} (${subject.stop.cases} cases) from ${subject.load.truckCode} L${subject.load.loadNo}, stop ${subject.stop.sequence}`
      : `Put ${label(subject.unserved)} on a truck (${subject.orders} order${subject.orders === 1 ? '' : 's'}, ${subject.cases} cases)`;

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl" data-testid="move-stop-dialog">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ArrowRightLeft className="h-5 w-5" /> {title}
          </DialogTitle>
          <DialogDescription>
            Only Planned loads change; the trucks you touch are timed again with today&apos;s customer, truck and settings data. Locked and dispatched loads stay as they are.
            {subject.kind === 'PLACE' ? ' Puts every unserved order of this customer on the truck (one stop is one customer).' : ''}
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-3 sm:grid-cols-3">
          <div className="space-y-1.5">
            <Label htmlFor="mv-truck">Truck</Label>
            <select
              id="mv-truck"
              className="h-9 w-full rounded-md border bg-background px-2 text-sm"
              value={truckId}
              onChange={(e) => {
                setTruckId(e.target.value);
                setChoice('');
                setPosition('BEST');
                changed();
              }}
              data-testid="move-truck"
            >
              {trucks.map((t) => {
                const own = plan.loads.filter((l) => l.truckId === t.id);
                const back = own.length ? Math.max(...own.map((l) => l.returnMin)) : null;
                return (
                  <option key={t.id} value={t.id}>
                    {t.code} · {own.length ? `${own.length} load${own.length === 1 ? '' : 's'} · back ${hhmm(back)}` : 'no load today'}
                  </option>
                );
              })}
            </select>
          </div>
          <div className="space-y-1.5 sm:col-span-2">
            <Label htmlFor="mv-load">Load</Label>
            <select
              id="mv-load"
              className="h-9 w-full rounded-md border bg-background px-2 text-sm"
              value={choice}
              onChange={(e) => {
                setChoice(e.target.value);
                setPosition('BEST');
                changed();
              }}
              data-testid="move-load"
            >
              <option value="">Choose a load…</option>
              {truckLoads.map((l) => (
                <option key={l.id} value={`load:${l.id}`} disabled={l.status !== 'PLANNED'}>
                  {l.status === 'PLANNED'
                    ? `L${l.loadNo} ${hhmm(l.departMin)}–${hhmm(l.returnMin)} · ${stopsText(l.stops.length)} · ${l.cases} cases${typeof l.palletUnits === 'number' && typeof l.palletRoomUnits === 'number' ? ` · ${palletText(l.palletUnits)}/${palletText(l.palletRoomUnits)} plt` : ''}`
                    : `L${l.loadNo} ${l.status === 'LOCKED' ? 'locked: unlock it first' : 'out or loading: never changed'}`}
                </option>
              ))}
              <option value="new:end" disabled={!tripLeft}>
                {tripLeft ? 'New load after the last load' : `No trip left (${truck?.maxTrips ?? 0} loads a day)`}
              </option>
              {tripLeft
                ? truckLoads
                    .filter((l) => l.status === 'PLANNED')
                    .map((l) => (
                      <option key={`before-${l.id}`} value={`new:before:${l.id}`}>
                        New load before L{l.loadNo}
                      </option>
                    ))
                : null}
              {tripLeft ? <option value="new:best">New load, best place in the day</option> : null}
              {subject.kind === 'MOVE' ? <option value="remove">Take it off the plan (unserved)</option> : null}
            </select>
          </div>
          {targetLoad ? (
            <div className="space-y-1.5 sm:col-span-3">
              <Label htmlFor="mv-pos">Position</Label>
              <select
                id="mv-pos"
                className="h-9 w-full rounded-md border bg-background px-2 text-sm"
                value={String(position)}
                onChange={(e) => {
                  setPosition(e.target.value === 'BEST' ? 'BEST' : Number(e.target.value));
                  changed();
                }}
                data-testid="move-position"
              >
                {positionChoices(positionLabels).map((p) => (
                  <option key={String(p.value)} value={String(p.value)}>
                    {p.label}
                  </option>
                ))}
              </select>
            </div>
          ) : null}
        </div>

        <div className="flex items-center gap-2">
          <Button variant="outline" onClick={() => void check()} disabled={!move || busy !== null} data-testid="move-check">
            {busy === 'check' ? 'Checking…' : 'Check'}
          </Button>
          {error ? (
            <span className="text-sm text-destructive" data-testid="move-error">
              {error}
            </span>
          ) : null}
        </div>

        {preview ? <PreviewPanel preview={preview} onOption={(m) => void check(m)} busy={busy !== null} /> : null}

        <DialogFooter>
          {preview?.saveNote ? <p className="mr-auto text-xs text-muted-foreground" data-testid="move-save-note">{preview.saveNote}</p> : null}
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={busy === 'save'}>
            Cancel
          </Button>
          <Button onClick={() => void save()} disabled={!preview?.canSave || busy !== null} data-testid="move-save">
            {busy === 'save' ? 'Saving…' : `Save as version ${(preview?.version ?? plan.run.version) + 1}`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function DayTable({ day, title, now = false }: { day: EditTruckDayView | null; title: string; now?: boolean }) {
  if (!day) return <p className="text-xs text-muted-foreground">{title}: no timetable.</p>;
  return (
    <div>
      <p className="text-[11px] font-semibold uppercase text-muted-foreground">{title}</p>
      {day.loads.length === 0 ? <p className="text-xs text-muted-foreground">No load.</p> : null}
      {day.loads.map((l) => (
        <div key={l.loadNo} className="mb-1 text-xs">
          <p className="font-medium">
            L{l.loadNo} {hhmm(l.departMin)}–{hhmm(l.returnMin)} · {stopsText(l.stops.length)} · {l.cases} cs
            {typeof l.palletUnits === 'number' ? ` · ${palletText(l.palletUnits)}${typeof l.roomUnits === 'number' ? `/${palletText(l.roomUnits)}` : ''} plt` : ''} · {l.km.toFixed(1)} km
            {l.costOmr !== null && !l.kept ? ` · ${l.costOmr.toFixed(2)} OMR` : ''}
            {l.kept ? ` · ${l.status.toLowerCase()} (kept)` : ''}
            {l.breakStartMin !== null ? ` · break ${hhmm(l.breakStartMin)}` : ''}
          </p>
          {l.kept ? null : (
            <ol className="ml-4 list-decimal">
              {l.stops.map((s) => (
                <li key={s.sequence} className={`${s.moved ? 'font-semibold' : ''} ${s.hardOk === false ? 'text-red-600' : s.prefOk === false ? 'text-amber-700' : ''}`}>
                  {s.label} · {hhmm(s.etaMin)}
                  {s.window ? ` (receives ${s.window})` : ''}
                </li>
              ))}
            </ol>
          )}
        </div>
      ))}
      <p className="text-xs text-muted-foreground">
        {now ? 'As planned: back' : 'Back'} {hhmm(day.lastReturnMin)} · {now ? 'Planned' : 'new'} loads {day.km.toFixed(1)} km{day.costOmr !== null ? ` · ${day.costOmr.toFixed(2)} OMR` : ''}
      </p>
      {now && day.timedNow ? (
        <p className="text-xs text-muted-foreground" data-testid="move-timed-now">
          Timed now with today&apos;s data (the change is counted from this): back {hhmm(day.timedNow.lastReturnMin)} · {day.timedNow.km.toFixed(1)} km · {day.timedNow.costOmr.toFixed(2)} OMR
        </p>
      ) : null}
    </div>
  );
}

function PreviewPanel({ preview, onOption, busy }: { preview: PlanEditPreview; onOption: (m: PlanEditMove) => void; busy: boolean }) {
  const broken = preview.trucks.flatMap((t) => t.violations.map((v) => ({ truck: t.truckCode, v })));
  return (
    <div className="space-y-3 rounded-md border p-3" data-testid="move-preview">
      <p className="text-sm font-medium">{preview.title}</p>
      {preview.ok ? (
        <p className="flex items-center gap-1 text-sm text-green-700" data-testid="move-ok">
          <CheckCircle2 className="h-4 w-4" /> Fits every rule.
          {preview.deltaCostOmr !== null ? ` Day cost of these trucks ${signedOmr(preview.deltaCostOmr)} OMR.` : ''}
        </p>
      ) : (
        <div className="text-sm text-red-700" data-testid="move-refused">
          <p className="flex items-center gap-1 font-medium">
            <AlertTriangle className="h-4 w-4" /> Cannot be moved:
          </p>
          <ul className="ml-5 list-disc">
            {broken.map(({ truck, v }, i) => (
              <li key={i}>
                {v.message}
                {v.shortBy !== null && !v.message.includes(String(v.shortBy)) ? ` (short by ${v.shortBy})` : ''} <span className="text-muted-foreground">[{truck}]</span>
              </li>
            ))}
            {!broken.length ? <li>No place keeps every rule for this stop.</li> : null}
          </ul>
        </div>
      )}
      {preview.trucks.map((t) => (
        <div key={t.truckId} className="grid gap-2 border-t pt-2 sm:grid-cols-2" data-testid={`move-truck-${t.truckCode}`}>
          <DayTable day={t.before} title={`${t.truckCode} now`} now />
          <DayTable day={t.after} title={afterTitle(t)} />
        </div>
      ))}
      {preview.warnings.length ? (
        <ul className="ml-5 list-disc text-xs text-amber-700" data-testid="move-warnings">
          {preview.warnings.map((w) => (
            <li key={w}>{w}</li>
          ))}
        </ul>
      ) : null}
      {preview.dataChanged.length ? (
        <div className="text-xs" data-testid="move-data-changed">
          <p className="font-semibold">Changed since planning (timed with today&apos;s data):</p>
          <ul className="ml-5 list-disc">
            {preview.dataChanged.map((c, i) => (
              <li key={i}>
                {c.label}: {c.text}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {preview.options.length ? (
        <div className="text-xs" data-testid="move-options">
          <p className="font-semibold">Other places that keep every rule:</p>
          {preview.options.map((o, i) => (
            <button key={i} type="button" className="mr-3 underline disabled:opacity-50" disabled={busy} onClick={() => onOption(o.move)}>
              {o.label}
              {o.deltaCostOmr !== null ? ` (${signedOmr(o.deltaCostOmr)} OMR)` : ''}
            </button>
          ))}
        </div>
      ) : null}
      <p className="text-[11px] text-muted-foreground">
        Distances: {preview.matrix.quality === 'ROAD' ? 'road' : preview.matrix.quality === 'MIXED' ? 'road, some legs estimated' : 'estimated (straight line)'}.
      </p>
    </div>
  );
}
