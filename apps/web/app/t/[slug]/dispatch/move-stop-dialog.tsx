'use client';

import { useEffect, useMemo, useState } from 'react';
import { ArrowRightLeft, CheckCircle2, AlertTriangle, ShieldCheck } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import type { DetailLoad, DetailStop, DetailUnserved, PlanDetail } from '@/lib/dispatch/plan-detail';
import { palletText } from '@/lib/dispatch/pallets';
import {
  carriedText,
  EDIT_ERROR_GENERIC,
  EDIT_ERROR_TEXT,
  MAX_EDIT_OPS,
  OVERRIDE_CAPACITY_MAX_PCT,
  positionChoices,
  signedOmr,
  type EditIssue,
  type EditSource,
  type EditStopRef,
  type EditTarget,
  type EditTruckDayView,
  type EditTruckPreview,
  type OverridePreview,
  type PlanEditMove,
  type PlanEditOp,
  type PlanEditPreview,
  type PlanEditSaved,
} from '@/lib/dispatch/plan-edit-view';
import { api, hhmm } from './client-api';

/** A stop chosen on the plan screen (a stop of a Planned load, or an unserved customer visit), with its words. */
export interface SelectedStop {
  ref: EditStopRef;
  label: string;
  cases: number;
  /** "T03 L2" or "unserved". */
  from: string;
}

/**
 * What the dialog changes (moves by hand, part 2): a stop of a PLANNED load (MOVE), an unserved customer visit
 * (PLACE), several selected stops (STOPS, REMOVE_STOPS), a whole load (MOVE_LOAD, SWAP_LOADS), or the change list
 * checked so far with nothing new (DRAFT).
 */
export type EditSubject =
  | { kind: 'MOVE'; load: DetailLoad; stop: DetailStop }
  | { kind: 'PLACE'; unserved: DetailUnserved; orders: number; cases: number }
  | { kind: 'STOPS'; refs: SelectedStop[] }
  | { kind: 'REMOVE_STOPS'; refs: SelectedStop[] }
  | { kind: 'MOVE_LOAD'; load: DetailLoad }
  | { kind: 'SWAP_LOADS'; load: DetailLoad }
  | { kind: 'DRAFT' };
/** The v1 name (M3). */
export type MoveSubject = EditSubject;

/** A change list checked and kept for the next change ("Add another change", design D11): the ops and their words. */
export interface EditDraft {
  ops: PlanEditOp[];
  steps: { title: string; red: boolean }[];
}

/** The choices of the Load list: an existing load, a new load (at the end, before a load, best place), off the plan, or a load to swap with. */
type LoadChoice = string; // `load:<id>` | 'new:end' | `new:before:<id>` | 'new:best' | 'remove' | `swap:<id>`

const label = (s: { customerName: string; customerCode: string; branchCode: string | null }) => `${s.customerName} (${s.customerCode}${s.branchCode ? `/${s.branchCode}` : ''})`;
const stopsText = (n: number) => `${n} stop${n === 1 ? '' : 's'}`;
const loadWords = (l: Pick<DetailLoad, 'truckCode' | 'loadNo'>) => `${l.truckCode} L${l.loadNo}`;

/** "T08 after (−6.16 OMR, back −20 min)": the change of one truck's day, each part only when known. */
export function afterTitle(t: { truckCode: string; deltaCostOmr: number | null; deltaLastReturnMin: number | null }): string {
  const parts = [
    ...(t.deltaCostOmr !== null ? [`${signedOmr(t.deltaCostOmr)} OMR`] : []),
    ...(t.deltaLastReturnMin !== null && t.deltaLastReturnMin !== 0 ? [`back ${t.deltaLastReturnMin > 0 ? '+' : '−'}${Math.abs(t.deltaLastReturnMin)} min`] : []),
  ];
  return `${t.truckCode} after${parts.length ? ` (${parts.join(', ')})` : ''}`;
}

/** The change the dialog's choices make for one stop (v1; null: nothing chosen yet). */
export function moveOfChoices(subject: { kind: 'MOVE'; load: { id: string }; stop: { sequence: number } } | { kind: 'PLACE'; unserved: { orderId: string } }, truckId: string, choice: LoadChoice, position: number | 'BEST'): PlanEditMove | null {
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
 * The operation the dialog's choices make for any subject (null: nothing chosen yet, or nothing new: DRAFT).
 * Several stops go to their best place in the load chosen (a position only for one stop).
 */
export function opOfChoices(subject: EditSubject, truckId: string, choice: LoadChoice, position: number | 'BEST'): PlanEditOp | null {
  if (subject.kind === 'MOVE' || subject.kind === 'PLACE') return moveOfChoices(subject, truckId, choice, position);
  if (subject.kind === 'DRAFT') return null;
  if (subject.kind === 'REMOVE_STOPS') {
    const stops = subject.refs.map((r) => r.ref).filter((r): r is EditSource => 'loadId' in r);
    return stops.length ? { kind: 'REMOVE_STOPS', stops } : null;
  }
  if (subject.kind === 'SWAP_LOADS') return choice.startsWith('swap:') ? { kind: 'SWAP_LOADS', a: subject.load.id, b: choice.slice(5) } : null;
  const before = choice === 'new:end' ? null : choice === 'new:best' ? 'BEST' : choice.startsWith('new:before:') ? choice.slice(11) : undefined;
  if (subject.kind === 'MOVE_LOAD') return before === undefined ? null : { kind: 'MOVE_LOAD', loadId: subject.load.id, to: { truckId, before } };
  const stops = subject.refs.map((r) => r.ref);
  if (!stops.length) return null;
  if (choice.startsWith('load:')) {
    const to: EditTarget = { truckId, loadId: choice.slice(5), ...(stops.length === 1 && typeof position === 'number' ? { position } : {}) };
    return { kind: 'MOVE_STOPS', stops, to };
  }
  return before === undefined ? null : { kind: 'MOVE_STOPS', stops, to: { truckId, loadId: null, before } };
}

/** The issues a save confirms (not carried), and whether each is ticked with a reason (3 characters or more). */
export function overridesToSend(ov: OverridePreview | null, ticks: Record<string, boolean>, reasons: Record<string, string>): { complete: boolean; list: { id: string; reason: string }[]; toConfirm: number; carried: number } {
  const need = (ov?.needed ?? []).filter((n) => !n.carried && n.id);
  const list = need.filter((n) => ticks[n.id!]).map((n) => ({ id: n.id!, reason: (reasons[n.id!] ?? '').trim() }));
  const complete = list.length === need.length && list.every((x) => x.reason.length >= 3);
  return { complete, list, toConfirm: need.length, carried: (ov?.needed ?? []).length - need.length };
}

/**
 * Moves by hand (PR M3, part 2): pick where the stop(s) or the load go - the truck, the load (an existing PLANNED
 * one, a new load, or off the plan) and the position (Best place by default) - press Check (one solver re-timing
 * per press, never on every change), read the result - before and after per truck, the rules it breaks in red
 * (each "can be allowed by hand" or "cannot be allowed"), the soft warnings in amber, what changed since planning
 * - then Save as version N+1. When the only problems can be allowed by hand, a supervisor or company admin ticks
 * each and types a reason, and saves with them ("Allow N rules and save"). A checked change can be kept and
 * another added ("Add another change": the list is saved as one version). Check and Save run under the plan
 * screen's action lock (`run`). A LOCKED load is offered disabled ("unlock it first"); LOADING and loads that
 * left are never offered.
 */
export function MoveStopDialog({
  subject,
  plan,
  runId,
  onOpenChange,
  run,
  afterSave,
  draft = null,
  onAddToDraft,
  canOverride = false,
}: {
  subject: EditSubject | null;
  plan: PlanDetail;
  runId: string;
  onOpenChange: (open: boolean) => void;
  /** Runs a request under the plan's action lock; false = another change of the plan was running. */
  run: (key: string, fn: () => Promise<void>) => Promise<boolean>;
  afterSave: (saved: PlanEditSaved) => Promise<void> | void;
  /** The change list checked so far (sent before this change); null = none. */
  draft?: EditDraft | null;
  /** "Add another change": keep this checked list (its ops, explicit) and close. */
  onAddToDraft?: (draft: EditDraft) => void;
  /** The user may allow rules by hand (SUPERVISOR or above); the server checks it again. */
  canOverride?: boolean;
}) {
  const trucks = plan.edit?.trucks ?? [];
  const startTruck =
    subject?.kind === 'MOVE' || subject?.kind === 'MOVE_LOAD' || subject?.kind === 'SWAP_LOADS'
      ? subject.load.truckId
      : (plan.loads.find((l) => l.status === 'PLANNED')?.truckId ?? trucks[0]?.id ?? '');
  const [truckId, setTruckId] = useState(startTruck);
  const [choice, setChoice] = useState<LoadChoice>('');
  const [position, setPosition] = useState<number | 'BEST'>('BEST');
  const [skipBreak, setSkipBreak] = useState<string[]>([]);
  const [preview, setPreview] = useState<PlanEditPreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<'check' | 'save' | null>(null);
  const [ticks, setTicks] = useState<Record<string, boolean>>({});
  const [reasons, setReasons] = useState<Record<string, string>>({});

  // A fresh dialog for each subject.
  const key = subject
    ? subject.kind === 'MOVE'
      ? `${subject.load.id}:${subject.stop.sequence}`
      : subject.kind === 'PLACE'
        ? subject.unserved.orderId
        : subject.kind === 'STOPS' || subject.kind === 'REMOVE_STOPS'
          ? `${subject.kind}:${subject.refs.map((r) => JSON.stringify(r.ref)).join(',')}`
          : subject.kind === 'DRAFT'
            ? `DRAFT:${draft?.ops.length ?? 0}`
            : `${subject.kind}:${subject.load.id}`
    : null;
  useEffect(() => {
    if (!key) return;
    setTruckId(startTruck);
    setChoice(subject?.kind === 'MOVE' ? `load:${subject.load.id}` : '');
    setPosition('BEST');
    setSkipBreak([]);
    setPreview(null);
    setError(null);
    setTicks({});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  const truckLoads = useMemo(() => plan.loads.filter((l) => l.truckId === truckId).sort((a, b) => a.loadNo - b.loadNo), [plan.loads, truckId]);
  const truck = trucks.find((t) => t.id === truckId) ?? null;
  const ownLoad = subject?.kind === 'MOVE' || subject?.kind === 'MOVE_LOAD' ? subject.load : null;
  // A new load needs a trip left: the source load disappears when the stop was its only one (or the load itself moves).
  const sourceGoes = !!ownLoad && ownLoad.truckId === truckId && (subject?.kind === 'MOVE_LOAD' || ownLoad.stops.length === 1);
  const tripLeft = !!truck && truckLoads.length - (sourceGoes ? 1 : 0) < truck.maxTrips;
  const targetLoad = choice.startsWith('load:') ? (truckLoads.find((l) => l.id === choice.slice(5)) ?? null) : null;
  const single = subject?.kind === 'MOVE' || subject?.kind === 'PLACE' || (subject?.kind === 'STOPS' && subject.refs.length === 1);
  const positionLabels = targetLoad
    ? targetLoad.stops.filter((s) => !(subject?.kind === 'MOVE' && targetLoad.id === subject.load.id && s.sequence === subject.stop.sequence)).map((s) => s.customerName)
    : [];
  const op = subject ? opOfChoices(subject, truckId, choice, position) : null;
  const ops = [...(draft?.ops ?? []), ...(op ? [op] : [])];
  const expect = { date: plan.run.runDate, depotId: plan.run.depot.id };
  const v1Body = !draft?.ops.length && !!op && (op.kind === 'MOVE' || op.kind === 'REMOVE' || op.kind === 'PLACE') && !skipBreak.length;
  const ov = preview?.overrides ?? null;
  const send = overridesToSend(ov, ticks, reasons);

  const changed = () => {
    setPreview(null);
    setError(null);
  };
  const errorText = (code: string, fallback: string | null, generic: string) =>
    (EDIT_ERROR_GENERIC.includes(code) && code in EDIT_ERROR_TEXT ? EDIT_ERROR_TEXT[code as keyof typeof EDIT_ERROR_TEXT] : null) ?? fallback ?? generic;

  async function check(list: PlanEditOp[] | null = null, skip: string[] = skipBreak) {
    const body = list
      ? { ops: list, expect, ...(skip.length ? { skipBreak: skip } : {}) }
      : v1Body
        ? { move: op, expect }
        : { ops, expect, ...(skip.length ? { skipBreak: skip } : {}) };
    if (!list && !ops.length) return;
    setError(null);
    const ran = await run('plan-edit-check', async () => {
      setBusy('check');
      try {
        const r = await api<PlanEditPreview>(`/api/runs/${runId}/edit/check`, { method: 'POST', json: body });
        if (r.ok && r.data) {
          setPreview(r.data);
          setTicks({});
          // A reason allowed before on the same stop, load or truck pre-fills the input.
          setReasons((old) => {
            const next = { ...old };
            for (const n of r.data!.overrides?.needed ?? []) if (n.id && !next[n.id] && n.previous) next[n.id] = n.previous.reason;
            return next;
          });
        } else {
          setPreview(null);
          setError(r.status === 503 ? (r.error ?? EDIT_ERROR_TEXT.SOLVER_FAILED) : (r.error ?? 'The change could not be checked.'));
        }
      } finally {
        setBusy(null);
      }
    });
    if (!ran) setError('Another change of this plan is running. Try again in a moment.');
  }

  async function save() {
    if (!preview) return;
    const withOverrides = !preview.ok && !!ov?.ok;
    if (withOverrides ? !(ov!.canSave && send.complete) : !preview.canSave) return;
    setError(null);
    const body = withOverrides
      ? { ops: preview.ops, expect, ...(ov!.skipBreak.length ? { skipBreak: ov!.skipBreak } : {}), previewHash: ov!.previewHash, builtAt: preview.builtAt, overrides: send.list }
      : preview.move && !draft?.ops.length && !ov?.skipBreak.length
        ? { move: preview.move, expect, previewHash: preview.previewHash, builtAt: preview.builtAt }
        : { ops: preview.ops, expect, previewHash: preview.previewHash, builtAt: preview.builtAt };
    const ran = await run('plan-edit-save', async () => {
      setBusy('save');
      try {
        const r = await api<PlanEditSaved>(`/api/runs/${runId}/edit`, { method: 'POST', json: body });
        if (r.ok && r.data) {
          onOpenChange(false);
          await afterSave(r.data);
          return;
        }
        const fresh = r.errorBody?.preview as PlanEditPreview | undefined;
        if (fresh && typeof fresh === 'object' && typeof fresh.previewHash === 'string') {
          // The new result: the ticks are cleared, the reasons kept by issue.
          setPreview(fresh);
          setTicks({});
        } else if (r.errorBody?.code === 'PREVIEW_OLD' || r.errorBody?.code === 'DAY_CHANGED') setPreview(null);
        const code = typeof r.errorBody?.code === 'string' ? r.errorBody.code : '';
        setError(errorText(code, r.error, 'The change could not be saved.'));
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
      : subject.kind === 'PLACE'
        ? `Put ${label(subject.unserved)} on a truck (${subject.orders} order${subject.orders === 1 ? '' : 's'}, ${subject.cases} cases)`
        : subject.kind === 'STOPS'
          ? `Move ${stopsText(subject.refs.length)} (${subject.refs.reduce((a, r) => a + r.cases, 0)} cases)`
          : subject.kind === 'REMOVE_STOPS'
            ? `Take ${stopsText(subject.refs.length)} off the plan`
            : subject.kind === 'MOVE_LOAD'
              ? `Move ${loadWords(subject.load)} (${stopsText(subject.load.stops.length)}, ${subject.load.cases} cases)`
              : subject.kind === 'SWAP_LOADS'
                ? `Swap ${loadWords(subject.load)} with another load`
                : 'Check the changes kept so far';
  const pickTarget = subject.kind === 'MOVE' || subject.kind === 'PLACE' || subject.kind === 'STOPS';
  const plannedOthers = plan.loads.filter((l) => l.status === 'PLANNED' && !(subject.kind === 'SWAP_LOADS' && l.id === subject.load.id));
  const nextVersion = (preview?.version ?? plan.run.version) + 1;
  const withOverrides = !!preview && !preview.ok && !!ov?.ok;
  const saveText = withOverrides
    ? send.toConfirm
      ? `Allow ${send.toConfirm} rule${send.toConfirm === 1 ? '' : 's'} and save as version ${nextVersion}`
      : `Save as version ${nextVersion} (keeps ${send.carried} rule${send.carried === 1 ? '' : 's'} allowed earlier)`
    : `Save as version ${nextVersion}`;
  const saveOn = withOverrides ? ov!.canSave && send.complete : !!preview?.canSave;
  const note = withOverrides ? (ov!.saveNote ?? (send.complete ? null : 'Tick each rule to allow and give a reason (at least 3 characters).')) : (preview?.saveNote ?? null);
  const canDraft = !!preview?.draftable && !!onAddToDraft && preview.ops.length < MAX_EDIT_OPS;

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] max-w-3xl overflow-y-auto" data-testid="move-stop-dialog">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ArrowRightLeft className="h-5 w-5" /> {title}
          </DialogTitle>
          <DialogDescription>
            Only Planned loads change; the trucks you touch are timed again with today&apos;s customer, truck and settings data. Locked and dispatched loads stay as they are.
            {subject.kind === 'PLACE' ? ' Puts every unserved order of this customer on the truck (one stop is one customer).' : ''}
            {subject.kind === 'MOVE_LOAD' ? ' The load keeps its stops in their order; it is timed again on the new truck. Drivers and helpers stay with their trucks.' : ''}
            {subject.kind === 'SWAP_LOADS' ? ' Each load keeps its stops in their order and is timed again on the other truck. Drivers and helpers stay with their trucks.' : ''}
          </DialogDescription>
        </DialogHeader>

        {draft?.steps.length ? (
          <div className="rounded-md border border-dashed p-2 text-xs" data-testid="move-draft">
            <p className="font-semibold">Changes checked before this one (saved together):</p>
            <ol className="ml-4 list-decimal">
              {draft.steps.map((s, i) => (
                <li key={i}>
                  {s.title}
                  {s.red ? <span className="text-red-700"> (red on its own)</span> : null}
                </li>
              ))}
            </ol>
          </div>
        ) : null}

        {subject.kind === 'STOPS' || subject.kind === 'REMOVE_STOPS' ? (
          <ul className="ml-5 list-disc text-xs" data-testid="move-selection">
            {subject.refs.map((r, i) => (
              <li key={i}>
                {r.label} · {r.cases} cs · from {r.from}
              </li>
            ))}
          </ul>
        ) : null}

        {pickTarget || subject.kind === 'MOVE_LOAD' ? (
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
              <Label htmlFor="mv-load">{subject.kind === 'MOVE_LOAD' ? 'Place' : 'Load'}</Label>
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
                <option value="">{subject.kind === 'MOVE_LOAD' ? 'Choose a place…' : 'Choose a load…'}</option>
                {subject.kind !== 'MOVE_LOAD'
                  ? truckLoads.map((l) => (
                      <option key={l.id} value={`load:${l.id}`} disabled={l.status !== 'PLANNED'}>
                        {l.status === 'PLANNED'
                          ? `L${l.loadNo} ${hhmm(l.departMin)}–${hhmm(l.returnMin)} · ${stopsText(l.stops.length)} · ${l.cases} cases${typeof l.palletUnits === 'number' && typeof l.palletRoomUnits === 'number' ? ` · ${palletText(l.palletUnits)}/${palletText(l.palletRoomUnits)} plt` : ''}`
                          : `L${l.loadNo} ${l.status === 'LOCKED' ? 'locked: unlock it first' : 'out or loading: never changed'}`}
                      </option>
                    ))
                  : null}
                <option value="new:end" disabled={!tripLeft}>
                  {tripLeft ? 'New load after the last load' : `No trip left (${truck?.maxTrips ?? 0} loads a day)`}
                </option>
                {tripLeft
                  ? truckLoads
                      .filter((l) => l.status === 'PLANNED' && !(subject.kind === 'MOVE_LOAD' && l.id === subject.load.id))
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
                  disabled={!single}
                  onChange={(e) => {
                    setPosition(e.target.value === 'BEST' ? 'BEST' : Number(e.target.value));
                    changed();
                  }}
                  data-testid="move-position"
                >
                  {single ? (
                    positionChoices(positionLabels).map((p) => (
                      <option key={String(p.value)} value={String(p.value)}>
                        {p.label}
                      </option>
                    ))
                  ) : (
                    <option value="BEST">Best place for each</option>
                  )}
                </select>
              </div>
            ) : null}
          </div>
        ) : null}

        {subject.kind === 'SWAP_LOADS' ? (
          <div className="space-y-1.5">
            <Label htmlFor="mv-swap">Swap {loadWords(subject.load)} with:</Label>
            <select
              id="mv-swap"
              className="h-9 w-full rounded-md border bg-background px-2 text-sm"
              value={choice}
              onChange={(e) => {
                setChoice(e.target.value);
                changed();
              }}
              data-testid="move-swap"
            >
              <option value="">Choose a load…</option>
              {plannedOthers.map((l) => (
                <option key={l.id} value={`swap:${l.id}`}>
                  {l.truckCode} L{l.loadNo} {hhmm(l.departMin)}–{hhmm(l.returnMin)} · {stopsText(l.stops.length)} · {l.cases} cases
                </option>
              ))}
            </select>
          </div>
        ) : null}

        <div className="flex items-center gap-2">
          <Button variant="outline" onClick={() => void check()} disabled={!ops.length || busy !== null} data-testid="move-check">
            {busy === 'check' ? 'Checking…' : 'Check'}
          </Button>
          {error ? (
            <span className="text-sm text-destructive" data-testid="move-error">
              {error}
            </span>
          ) : null}
        </div>

        {preview ? <PreviewPanel preview={preview} onOption={(m) => void check([...(draft?.ops ?? []), m])} busy={busy !== null} /> : null}
        {preview?.overrides ? (
          <OverridePanel
            overrides={preview.overrides}
            canOverride={canOverride}
            ticks={ticks}
            reasons={reasons}
            busy={busy !== null}
            onTick={(id, on) => setTicks((t) => ({ ...t, [id]: on }))}
            onReason={(id, text) => setReasons((r) => ({ ...r, [id]: text }))}
            onAllowAll={() => setTicks(Object.fromEntries(preview.overrides!.needed.filter((n) => !n.carried && n.id).map((n) => [n.id!, true])))}
            onReasonForAll={(text) =>
              setReasons((r) => {
                const next = { ...r };
                for (const n of preview.overrides!.needed) if (n.id && !n.carried && !(next[n.id] ?? '').trim()) next[n.id] = text;
                return next;
              })
            }
            onSkipBreak={(truck) => {
              const next = [...new Set([...skipBreak, truck])];
              setSkipBreak(next);
              void check(preview.ops, next);
            }}
          />
        ) : null}

        <DialogFooter>
          {note ? <p className="mr-auto text-xs text-muted-foreground" data-testid="move-save-note">{note}</p> : null}
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={busy === 'save'}>
            Cancel
          </Button>
          {canDraft ? (
            <Button
              type="button"
              variant="outline"
              disabled={busy !== null}
              data-testid="move-add-change"
              onClick={() => {
                onAddToDraft?.({ ops: preview!.ops, steps: [...(draft?.steps ?? []), { title: preview!.title.split('; ').at(-1) ?? preview!.title, red: !preview!.ok }] });
                onOpenChange(false);
              }}
            >
              Add another change
            </Button>
          ) : null}
          <Button onClick={() => void save()} disabled={!saveOn || busy !== null} data-testid="move-save">
            {busy === 'save' ? 'Saving…' : saveText}
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
                <li key={s.sequence} className={`${s.moved ? 'font-semibold' : ''} ${s.allowed ? 'text-violet-700' : s.hardOk === false ? 'text-red-600' : s.prefOk === false ? 'text-amber-700' : ''}`}>
                  {s.label} · {hhmm(s.etaMin)}
                  {s.window ? ` (receives ${s.window})` : ''}
                  {s.allowed ? ' · allowed by hand' : ''}
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

function TruckDays({ trucks }: { trucks: EditTruckPreview[] }) {
  return (
    <>
      {trucks.map((t) => (
        <div key={t.truckId} className="grid gap-2 border-t pt-2 sm:grid-cols-2" data-testid={`move-truck-${t.truckCode}`}>
          <DayTable day={t.before} title={`${t.truckCode} now`} now />
          <DayTable day={t.after} title={afterTitle(t)} />
        </div>
      ))}
    </>
  );
}

function IssueLine({ i }: { i: EditIssue }) {
  return (
    <li>
      {i.text}{' '}
      {i.overridable ? (
        <span className="rounded bg-amber-100 px-1 text-[10px] font-semibold text-amber-800">Can be allowed by hand</span>
      ) : (
        <span className="rounded bg-red-100 px-1 text-[10px] font-semibold text-red-800" title={i.whyNot ?? undefined}>
          Cannot be allowed{i.whyNot ? `: ${i.whyNot}` : ''}
        </span>
      )}
    </li>
  );
}

function PreviewPanel({ preview, onOption, busy }: { preview: PlanEditPreview; onOption: (m: PlanEditOp) => void; busy: boolean }) {
  const broken = preview.trucks.flatMap((t) => t.violations.map((v) => ({ truck: t.truckCode, v })));
  const issues = preview.issues ?? [];
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
            <AlertTriangle className="h-4 w-4" /> Cannot be moved{preview.overrides?.ok ? ' as it is - see what can be allowed by hand below' : ''}:
          </p>
          <ul className="ml-5 list-disc">
            {issues.length
              ? issues.map((i, k) => <IssueLine key={k} i={i} />)
              : broken.map(({ truck, v }, k) => (
                  <li key={k}>
                    {v.message}
                    {v.shortBy !== null && !v.message.includes(String(v.shortBy)) ? ` (short by ${v.shortBy})` : ''} <span className="text-muted-foreground">[{truck}]</span>
                  </li>
                ))}
            {!issues.length && !broken.length ? <li>No place keeps every rule for this change.</li> : null}
          </ul>
        </div>
      )}
      {preview.overrides?.ok ? (
        <details className="text-xs">
          <summary className="cursor-pointer text-muted-foreground">Timetable keeping every rule (as checked)</summary>
          <TruckDays trucks={preview.trucks} />
        </details>
      ) : (
        <TruckDays trucks={preview.trucks} />
      )}
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
      {preview.options.length || preview.loadOptions?.length ? (
        <div className="text-xs" data-testid="move-options">
          <p className="font-semibold">Other places that keep every rule:</p>
          {preview.options.map((o, i) => (
            <button key={i} type="button" className="mr-3 underline disabled:opacity-50" disabled={busy} onClick={() => onOption(o.move)}>
              {o.label}
              {o.deltaCostOmr !== null ? ` (${signedOmr(o.deltaCostOmr)} OMR)` : ''}
            </button>
          ))}
          {(preview.loadOptions ?? []).map((o, i) => (
            <button key={`l${i}`} type="button" className="mr-3 underline disabled:opacity-50" disabled={busy} onClick={() => onOption(o.ops[o.ops.length - 1]!)}>
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

/**
 * Allow by hand and save (owner item 3): what the change needs allowed (each with a tick and a reason, a carried
 * one as "Allowed earlier by ...: kept"), what still breaks even then, the timetable with the issues allowed, and
 * "Skip the driver break on T08 instead". Only a supervisor or company admin can save it; any planner sees it.
 */
function OverridePanel({
  overrides: ov,
  canOverride,
  ticks,
  reasons,
  busy,
  onTick,
  onReason,
  onAllowAll,
  onReasonForAll,
  onSkipBreak,
}: {
  overrides: OverridePreview;
  canOverride: boolean;
  ticks: Record<string, boolean>;
  reasons: Record<string, string>;
  busy: boolean;
  onTick: (id: string, on: boolean) => void;
  onReason: (id: string, text: string) => void;
  onAllowAll: () => void;
  onReasonForAll: (text: string) => void;
  onSkipBreak: (truckId: string) => void;
}) {
  const [common, setCommon] = useState('');
  const toTick = ov.needed.filter((n) => !n.carried && n.id);
  return (
    <div className="space-y-2 rounded-md border border-violet-300 bg-violet-50/40 p-3 text-sm" data-testid="move-overrides">
      <p className="flex items-center gap-1 font-medium text-violet-900">
        <ShieldCheck className="h-4 w-4" /> Allow by hand and save (supervisor or company admin)
      </p>
      {!ov.ok ? (
        <div className="text-red-700">
          {ov.remaining.length ? (
            <>
              <p>Even when allowed by hand, this change breaks:</p>
              <ul className="ml-5 list-disc">
                {ov.remaining.map((i, k) => (
                  <IssueLine key={k} i={i} />
                ))}
              </ul>
            </>
          ) : (
            <p>{ov.saveNote}</p>
          )}
        </div>
      ) : (
        <>
          <p className="text-xs text-muted-foreground">
            Late arrivals, the driver break and truck capacity up to {OVERRIDE_CAPACITY_MAX_PCT}% over the truck can be allowed by hand; the reason is printed on the load sheet and the driver sheet.
            {canOverride ? '' : ' Only a supervisor or company admin can allow them.'}
          </p>
          {toTick.length > 1 ? (
            <div className="flex flex-wrap items-center gap-2 text-xs">
              <Button type="button" size="sm" variant="outline" className="h-7" disabled={busy || !canOverride} onClick={onAllowAll} data-testid="move-allow-all">
                Allow all {toTick.length}
              </Button>
              <input
                className="h-7 w-56 rounded border bg-background px-2"
                placeholder="One reason for all"
                value={common}
                onChange={(e) => setCommon(e.target.value)}
                disabled={!canOverride}
              />
              <Button type="button" size="sm" variant="outline" className="h-7" disabled={busy || !canOverride || common.trim().length < 3} onClick={() => onReasonForAll(common.trim())} data-testid="move-reason-all">
                Use this reason for all
              </Button>
            </div>
          ) : null}
          <ul className="space-y-1.5">
            {ov.needed.map((n, k) =>
              n.carried ? (
                <li key={k} className="text-xs text-violet-900" data-testid="move-override-carried">
                  {n.text}. {carriedText(n.carried)}
                </li>
              ) : (
                <li key={k} className="text-xs">
                  <label className="flex items-start gap-2">
                    <input type="checkbox" checked={!!ticks[n.id ?? '']} disabled={!canOverride || !n.overridable} onChange={(e) => onTick(n.id ?? '', e.target.checked)} data-testid="move-override-tick" />
                    <span>
                      <b>Allow:</b> {n.text}
                      {!n.overridable && n.whyNot ? <span className="block text-red-700">{n.whyNot}</span> : null}
                    </span>
                  </label>
                  <input
                    className="ml-6 mt-1 h-7 w-[calc(100%-1.5rem)] rounded border bg-background px-2"
                    placeholder="Reason (required), e.g. agreed with the customer"
                    maxLength={300}
                    value={reasons[n.id ?? ''] ?? ''}
                    disabled={!canOverride}
                    onChange={(e) => onReason(n.id ?? '', e.target.value)}
                    data-testid="move-override-reason"
                  />
                </li>
              ),
            )}
          </ul>
        </>
      )}
      {ov.breakAlternative.length ? (
        <div className="text-xs">
          {ov.breakAlternative.map((b) => (
            <button key={b.truckId} type="button" className="mr-3 underline disabled:opacity-50" disabled={busy} onClick={() => onSkipBreak(b.truckId)} data-testid="move-skip-break">
              {b.only ? `${b.truckCode} can only be timed without its driver break: skip it` : `Skip the driver break on ${b.truckCode} instead`}
            </button>
          ))}
        </div>
      ) : null}
      {ov.trucks.length ? <TruckDays trucks={ov.trucks} /> : null}
      {ov.warnings.length ? (
        <ul className="ml-5 list-disc text-xs text-amber-700">
          {ov.warnings.map((w) => (
            <li key={w}>{w}</li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
