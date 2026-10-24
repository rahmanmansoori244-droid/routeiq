/**
 * Moves by hand (PR M3): the Move dialog (app/t/[slug]/dispatch/move-stop-dialog.tsx) on the REAL component
 * through the hook host (hook-host.ts); only api() is replaced. And the plan screen's entry points
 * (plan-view.tsx source): Move on PLANNED stops (disabled on a LOCKED load with the unlock hint), Put on a
 * truck on whole unserved rows, the header's "adjusted by hand" from details.manual, the toast after a save.
 *
 *  - The dialog opens on the stop's own load with Best place; Check sends exactly the change chosen (and the
 *    day on screen), one request per press, never on a change of choice.
 *  - A preview that can be saved: Save sends the preview's own change (a best place resolved), its hash and when
 *    the day was read; the dialog closes and hands the answer to the plan screen.
 *  - PREVIEW_CHANGED: the new preview replaces the old one, with its words; checking-only mode: Save off with the note.
 *  - Put on a truck: nothing to check until a load is chosen; never "take it off the plan".
 *  - Another change of the plan running: the dialog says so and sends nothing.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Host, elements, textOf } from './hook-host';
import type { PlanEditPreview } from '@/lib/dispatch/plan-edit-view';

vi.mock('react', async (importActual) => (await import('./hook-host')).mockReactHooks(importActual));

const net = vi.hoisted(() => ({
  calls: [] as { url: string; method: string; json: any }[],
  reply: (() => ({ ok: true, status: 200, data: null, error: null, errorBody: null })) as (url: string, json: any) => { ok: boolean; status: number; data: unknown; error: string | null; errorBody: Record<string, unknown> | null },
}));
vi.mock('@/app/t/[slug]/dispatch/client-api', async (importActual) => {
  const actual = (await importActual()) as Record<string, unknown>;
  return {
    ...actual,
    api: async (url: string, init?: { method?: string; json?: unknown }) => {
      net.calls.push({ url, method: init?.method ?? 'GET', json: init?.json });
      return net.reply(url, init?.json);
    },
  };
});

import { MoveStopDialog } from '@/app/t/[slug]/dispatch/move-stop-dialog';
import { EDIT_ERROR_TEXT } from '@/lib/dispatch/plan-edit-view';

afterEach(() => {
  net.calls = [];
});

const stop = (sequence: number, code: string) => ({ sequence, customerId: `cu-${code}`, customerCode: code, branchCode: null, customerName: `Customer ${code}`, cases: 10 });
const load = (id: string, truckId: string, loadNo: number, status: string, stops: ReturnType<typeof stop>[]) => ({
  id, truckId, truckCode: truckId, loadNo, status, departMin: 420, returnMin: 600, cases: 20, palletUnits: null, palletRoomUnits: null, stops,
});
const plan = (mode: 'CHECK' | 'ON' = 'ON') =>
  ({
    run: { id: 'R', version: 3, runDate: '2026-10-25', depot: { id: 'D1' } },
    loads: [load('A1', 'T01', 1, 'PLANNED', [stop(1, 'C1'), stop(2, 'C2')]), load('A2', 'T01', 2, 'LOCKED', [stop(1, 'C3')]), load('B1', 'T02', 1, 'PLANNED', [stop(1, 'C4')])],
    unserved: [],
    edit: { mode, trucks: [{ id: 'T01', code: 'T01', bays: null, capacityCases: 200, maxTrips: 3 }, { id: 'T02', code: 'T02', bays: null, capacityCases: 200, maxTrips: 3 }] },
  }) as any;

const preview = (over: Partial<PlanEditPreview> = {}): PlanEditPreview => ({
  ok: true, canSave: true, saveNote: null, mode: 'ON', version: 3, previewHash: 'a'.repeat(64), builtAt: '2026-10-24T15:00:00.000Z',
  move: { kind: 'MOVE', from: { loadId: 'A1', sequence: 2 }, to: { truckId: 'T02', loadId: 'B1', position: 1 } },
  title: 'Move Customer C2 (C2) from T01 L1, stop 2 to T02 L1, stop 2', trucks: [], warnings: [], dataChanged: [], options: [], deltaCostOmr: -1.5, deltaKm: -2,
  matrix: { provider: 'HAVERSINE', quality: 'ESTIMATED' }, ops: [], draftable: false, issues: [], overrides: null, ...over,
});

async function mount(subject: any, opts: { mode?: 'CHECK' | 'ON'; busy?: boolean } = {}) {
  const saved: unknown[] = [];
  const closed: boolean[] = [];
  const host: Host<any> = new Host(MoveStopDialog as any, {
    subject,
    plan: plan(opts.mode),
    runId: 'R',
    onOpenChange: (o: boolean) => closed.push(o),
    run: async (_key: string, fn: () => Promise<void>) => {
      if (opts.busy) return false;
      await fn();
      return true;
    },
    afterSave: (s: unknown) => void saved.push(s),
  });
  host.render();
  await host.settle();
  const byId = (id: string) => elements(host.tree).find((e) => e.props?.['data-testid'] === id);
  const click = async (id: string) => {
    const el = byId(id);
    if (!el) throw new Error(`no ${id}`);
    el.props.onClick();
    host.flush();
    await host.settle();
  };
  const choose = async (id: string, value: string) => {
    byId(id)!.props.onChange({ target: { value } });
    host.flush();
    await host.settle();
  };
  const options = (id: string) => elements(byId(id)).filter((e) => e.type === 'option').map((e) => ({ value: e.props.value, disabled: !!e.props.disabled, text: textOf(e) }));
  return { host, byId, click, choose, options, saved, closed };
}

const moveSubject = () => ({ kind: 'MOVE', load: plan().loads[0], stop: stop(2, 'C2') });

describe('the Move dialog', () => {
  it('opens on the stop\'s own load at Best place; a LOCKED load is offered disabled; Check sends the change chosen once', async () => {
    const d = await mount(moveSubject());
    expect(net.calls).toEqual([]);
    expect(d.byId('move-load')!.props.value).toBe('load:A1');
    expect(d.options('move-load').find((o) => o.value === 'load:A2')).toMatchObject({ disabled: true, text: 'L2 locked: unlock it first' });
    expect(d.options('move-position').map((o) => o.text)).toEqual(['Best place', 'First (before Customer C1)', 'Last (after Customer C1)']);
    await d.choose('move-truck', 'T02');
    await d.choose('move-load', 'load:B1');
    await d.choose('move-position', '1');
    expect(net.calls).toEqual([]);
    net.reply = () => ({ ok: true, status: 200, data: preview(), error: null, errorBody: null });
    await d.click('move-check');
    expect(net.calls).toEqual([
      { url: '/api/runs/R/edit/check', method: 'POST', json: { move: { kind: 'MOVE', from: { loadId: 'A1', sequence: 2 }, to: { truckId: 'T02', loadId: 'B1', position: 1 } }, expect: { date: '2026-10-25', depotId: 'D1' } } },
    ]);
    expect(d.byId('move-preview')).toBeUndefined(); // the panel is a child component: its props carry the preview
    expect(elements(d.host.tree).find((e) => e.props?.preview)?.props.preview.previewHash).toBe('a'.repeat(64));
    expect(d.byId('move-save')!.props.disabled).toBe(false);
    expect(textOf(d.byId('move-save'))).toBe('Save as version 4');
  });

  it('Save sends the preview\'s own change, hash and builtAt; the dialog closes and hands the answer on', async () => {
    const d = await mount(moveSubject());
    await d.choose('move-load', 'new:best');
    const best = preview({ move: { kind: 'MOVE', from: { loadId: 'A1', sequence: 2 }, to: { truckId: 'T01', loadId: null, before: 'A2' } } });
    net.reply = (url) => (url.endsWith('/check') ? { ok: true, status: 200, data: best, error: null, errorBody: null } : { ok: true, status: 200, data: { runId: 'R2', version: 4, reprint: ['T01 L2'], trucks: ['T01'] }, error: null, errorBody: null });
    await d.click('move-check');
    expect(net.calls[0]!.json.move.to).toEqual({ truckId: 'T01', loadId: null, before: 'BEST' });
    await d.click('move-save');
    expect(net.calls[1]).toEqual({ url: '/api/runs/R/edit', method: 'POST', json: { move: best.move, expect: { date: '2026-10-25', depotId: 'D1' }, previewHash: best.previewHash, builtAt: best.builtAt } });
    expect(d.closed).toEqual([false]);
    expect(d.saved).toEqual([{ runId: 'R2', version: 4, reprint: ['T01 L2'], trucks: ['T01'] }]);
  });

  it('PREVIEW_CHANGED shows the new result with its words; a change of choice clears the old result', async () => {
    const d = await mount(moveSubject());
    const fresh = preview({ previewHash: 'b'.repeat(64), ok: false, canSave: false, saveNote: 'Cannot be saved: it breaks the rules above.' });
    net.reply = (url) =>
      url.endsWith('/check')
        ? { ok: true, status: 200, data: preview(), error: null, errorBody: null }
        : { ok: false, status: 409, data: null, error: EDIT_ERROR_TEXT.PREVIEW_CHANGED, errorBody: { error: EDIT_ERROR_TEXT.PREVIEW_CHANGED, code: 'PREVIEW_CHANGED', preview: fresh } };
    await d.click('move-check');
    await d.click('move-save');
    expect(textOf(d.byId('move-error'))).toBe(EDIT_ERROR_TEXT.PREVIEW_CHANGED);
    expect(elements(d.host.tree).find((e) => e.props?.preview)?.props.preview.previewHash).toBe('b'.repeat(64));
    expect(d.byId('move-save')!.props.disabled).toBe(true);
    expect(textOf(d.byId('move-save-note'))).toBe('Cannot be saved: it breaks the rules above.');
    await d.choose('move-position', '0');
    expect(elements(d.host.tree).find((e) => e.props?.preview)).toBeUndefined();
  });

  it('checking only: the result shows, Save stays off with the note; a refused check says why', async () => {
    const d = await mount(moveSubject(), { mode: 'CHECK' });
    net.reply = () => ({ ok: true, status: 200, data: preview({ canSave: false, mode: 'CHECK', saveNote: EDIT_ERROR_TEXT.CHECK_ONLY }), error: null, errorBody: null });
    await d.click('move-check');
    expect(d.byId('move-save')!.props.disabled).toBe(true);
    expect(textOf(d.byId('move-save-note'))).toBe(EDIT_ERROR_TEXT.CHECK_ONLY);
    net.reply = () => ({ ok: false, status: 409, data: null, error: 'T01 L2 is locked: unlock it first to put stops on it.', errorBody: { code: 'LOAD_FROZEN' } });
    await d.click('move-check');
    expect(textOf(d.byId('move-error'))).toBe('T01 L2 is locked: unlock it first to put stops on it.');
  });

  it('Put on a truck: nothing to check until a load is chosen, and no "take it off"; another change running sends nothing', async () => {
    const subject = { kind: 'PLACE', unserved: { orderId: 'o9', customerId: 'cu-C9', customerCode: 'C9', branchCode: null, customerName: 'Customer C9' }, orders: 2, cases: 13 };
    const d = await mount(subject);
    expect(d.byId('move-check')!.props.disabled).toBe(true);
    expect(d.options('move-load').some((o) => o.value === 'remove')).toBe(false);
    await d.choose('move-load', 'new:end');
    expect(d.byId('move-check')!.props.disabled).toBe(false);
    const busy = await mount(subject, { busy: true });
    await busy.choose('move-load', 'new:end');
    await busy.click('move-check');
    expect(net.calls).toEqual([]);
    expect(textOf(busy.byId('move-error'))).toBe('Another change of this plan is running. Try again in a moment.');
  });
});

describe('the plan screen\'s entry points (plan-view.tsx)', () => {
  const src = readFileSync(path.resolve(__dirname, '../../app/t/[slug]/dispatch/plan-view.tsx'), 'utf8');
  it('Move on PLANNED and LOCKED stops only (LOCKED disabled with the unlock hint), under the live applied plan and the switch', () => {
    expect(src).toMatch(/const canMove = !!d\.edit && canPlan && applied && !superseded && !running;/);
    expect(src).toMatch(/move=\{canMove && \(l\.status === 'PLANNED' \|\| l\.status === 'LOCKED'\) \? \{ disabled: l\.status !== 'PLANNED' \|\| !!busy,/);
    expect(src).toMatch(/title=\{l\.status === 'LOCKED' \? LOCKED_MOVE_TITLE :/);
  });
  it('Put on a truck on whole unserved rows only; the dialog under the action lock; the toast; "adjusted by hand" from details.manual', () => {
    expect(src).toMatch(/\{!u\.partial && !u\.cancelled && !u\.carriedTo \? \(/);
    expect(src).toMatch(/run=\{\(key, fn\) => runPlanAction\(lock, key, fn, failed\)\}/);
    expect(src).toMatch(/toast\.success\(savedText\(saved\), \{ duration: 20_000 \}\);\s+await onChanged\?\.\(saved\.runId\);/);
    expect(src).toMatch(/\{d\.manual \? ' · adjusted by hand' : ''\}/);
  });
});

describe('part 2: several stops, whole loads, the change list and allow by hand (owner feedback 24 Oct 2026)', () => {
  it('opOfChoices for every subject: several stops (best place for each), take off, a whole load, a swap', async () => {
    const { opOfChoices } = await import('@/app/t/[slug]/dispatch/move-stop-dialog');
    const refs = [{ ref: { loadId: 'A1', sequence: 1 }, label: 'C1', cases: 10, from: 'T01 L1' }, { ref: { orderId: 'o9' }, label: 'C9', cases: 5, from: 'unserved' }];
    expect(opOfChoices({ kind: 'STOPS', refs }, 'T02', 'load:B1', 1)).toEqual({ kind: 'MOVE_STOPS', stops: [{ loadId: 'A1', sequence: 1 }, { orderId: 'o9' }], to: { truckId: 'T02', loadId: 'B1' } });
    expect(opOfChoices({ kind: 'STOPS', refs: [refs[0]!] }, 'T02', 'load:B1', 1)).toMatchObject({ to: { position: 1 } });
    expect(opOfChoices({ kind: 'STOPS', refs }, 'T02', 'new:best', 'BEST')).toMatchObject({ to: { truckId: 'T02', loadId: null, before: 'BEST' } });
    expect(opOfChoices({ kind: 'REMOVE_STOPS', refs }, '', '', 'BEST')).toEqual({ kind: 'REMOVE_STOPS', stops: [{ loadId: 'A1', sequence: 1 }] });
    const l = plan().loads[0];
    expect(opOfChoices({ kind: 'MOVE_LOAD', load: l }, 'T02', 'new:before:B1', 'BEST')).toEqual({ kind: 'MOVE_LOAD', loadId: 'A1', to: { truckId: 'T02', before: 'B1' } });
    expect(opOfChoices({ kind: 'MOVE_LOAD', load: l }, 'T02', 'new:end', 'BEST')).toEqual({ kind: 'MOVE_LOAD', loadId: 'A1', to: { truckId: 'T02', before: null } });
    expect(opOfChoices({ kind: 'SWAP_LOADS', load: l }, '', 'swap:B1', 'BEST')).toEqual({ kind: 'SWAP_LOADS', a: 'A1', b: 'B1' });
    expect(opOfChoices({ kind: 'SWAP_LOADS', load: l }, '', '', 'BEST')).toBeNull();
    expect(opOfChoices({ kind: 'DRAFT' }, '', '', 'BEST')).toBeNull();
  });

  const issue = (id: string, over: Record<string, unknown> = {}) => ({
    id, code: 'HARD_WINDOW', kind: 'LATE', overridable: true, whyNot: null, truckId: 'T01', truckCode: 'T01', loadNo: 1, stopLabel: 'C2', customerId: 'c', orderIds: ['o2'],
    amount: { unit: 'min', value: 800, limit: 780, over: 20 }, text: `late ${id}`, carried: null, previous: null, ...over,
  });
  const allowable = (needed: ReturnType<typeof issue>[], over: Record<string, unknown> = {}, top: Partial<PlanEditPreview> = {}) =>
    preview({
      ok: false, canSave: false, saveNote: 'Cannot be saved: it breaks the rules above.', ops: [{ kind: 'SWAP_LOADS', a: 'A1', b: 'B1' }], draftable: true, issues: needed as never,
      overrides: { ok: true, canSave: true, saveNote: null, needed: needed as never, remaining: [], previewHash: 'c'.repeat(64), trucks: [], warnings: [], deltaCostOmr: null, deltaKm: null, skipBreak: [], breakAlternative: [], ...over } as never,
      ...top,
    });
  const swapSubject = () => ({ kind: 'SWAP_LOADS', load: plan().loads[0] });
  async function mountWith(p: PlanEditPreview, canOverride: boolean) {
    const saved: unknown[] = [];
    const drafts: unknown[] = [];
    const host: Host<any> = new Host(MoveStopDialog as any, {
      subject: swapSubject(),
      plan: plan(),
      runId: 'R',
      onOpenChange: () => undefined,
      run: async (_k: string, fn: () => Promise<void>) => {
        await fn();
        return true;
      },
      afterSave: (x: unknown) => void saved.push(x),
      canOverride,
      onAddToDraft: (x: unknown) => void drafts.push(x),
    });
    host.render();
    await host.settle();
    const byId = (id: string) => elements(host.tree).find((e) => e.props?.['data-testid'] === id);
    byId('move-swap')!.props.onChange({ target: { value: 'swap:B1' } });
    host.flush();
    net.reply = () => ({ ok: true, status: 200, data: p, error: null, errorBody: null });
    byId('move-check')!.props.onClick();
    host.flush();
    await host.settle();
    const panel = () => elements(host.tree).find((e) => e.props?.overrides && e.props?.onTick);
    const act = async (fn: () => void) => {
      fn();
      host.flush();
      await host.settle();
    };
    return { host, byId, panel, act, saved, drafts };
  }

  it('a supervisor ticks each rule with a reason (Allow all, Use this reason for all), then saves the list with the overrides hash', async () => {
    const d = await mountWith(allowable([issue('ovr_a'), issue('ovr_b')]), true);
    expect(net.calls.at(-1)!.json).toEqual({ ops: [{ kind: 'SWAP_LOADS', a: 'A1', b: 'B1' }], expect: { date: '2026-10-25', depotId: 'D1' } });
    expect(textOf(d.byId('move-save'))).toBe('Allow 2 rules and save as version 4');
    expect(d.byId('move-save')!.props.disabled).toBe(true);
    await d.act(() => d.panel()!.props.onAllowAll());
    expect(d.byId('move-save')!.props.disabled).toBe(true); // ticked, no reasons yet
    await d.act(() => d.panel()!.props.onReasonForAll('agreed with the customers'));
    expect(d.byId('move-save')!.props.disabled).toBe(false);
    net.reply = () => ({ ok: true, status: 200, data: { runId: 'R2', version: 4, reprint: [], gone: [], trucks: [], allowed: 2 }, error: null, errorBody: null });
    await d.act(() => d.byId('move-save')!.props.onClick());
    expect(net.calls.at(-1)).toEqual({
      url: '/api/runs/R/edit',
      method: 'POST',
      json: {
        ops: [{ kind: 'SWAP_LOADS', a: 'A1', b: 'B1' }],
        expect: { date: '2026-10-25', depotId: 'D1' },
        previewHash: 'c'.repeat(64),
        builtAt: '2026-10-24T15:00:00.000Z',
        overrides: [
          { id: 'ovr_a', reason: 'agreed with the customers' },
          { id: 'ovr_b', reason: 'agreed with the customers' },
        ],
      },
    });
    expect(d.saved).toHaveLength(1);
  });

  it('OVERRIDES_CHANGED: the new result, the ticks cleared and the reasons kept by issue; a previous reason pre-fills', async () => {
    const d = await mountWith(allowable([issue('ovr_a', { previous: { reason: 'agreed last week', byName: 'A', at: '' } })]), true);
    expect(d.panel()!.props.reasons).toEqual({ ovr_a: 'agreed last week' });
    await d.act(() => d.panel()!.props.onTick('ovr_a', true));
    const fresh = allowable([issue('ovr_a'), issue('ovr_c')], { previewHash: 'd'.repeat(64) });
    net.reply = () => ({ ok: false, status: 409, data: null, error: 'The rules this change breaks changed since your check: confirm them again.', errorBody: { code: 'OVERRIDES_CHANGED', preview: fresh } });
    await d.act(() => d.byId('move-save')!.props.onClick());
    expect(textOf(d.byId('move-error'))).toBe('The rules this change breaks changed since your check: confirm them again.');
    expect(d.panel()!.props.ticks).toEqual({});
    expect(d.panel()!.props.reasons).toEqual({ ovr_a: 'agreed last week' });
    expect(textOf(d.byId('move-save'))).toBe('Allow 2 rules and save as version 4');
  });

  it('a PLANNER sees the panel but cannot save new allowances; only carried ones save for any role', async () => {
    const d = await mountWith(allowable([issue('ovr_a')], { canSave: false, saveNote: 'Only a supervisor or company admin can allow rules by hand. Ask one to open this change.' }), false);
    expect(d.panel()!.props.canOverride).toBe(false);
    expect(d.byId('move-save')!.props.disabled).toBe(true);
    expect(textOf(d.byId('move-save-note'))).toBe('Only a supervisor or company admin can allow rules by hand. Ask one to open this change.');
    const carried = await mountWith(allowable([issue('ovr_a', { carried: { fromId: 'ovr_0', reason: 'agreed', byName: 'Ahmed', byRole: 'SUPERVISOR', at: '2026-10-24T17:40:00.000Z' } })]), false);
    expect(textOf(carried.byId('move-save'))).toBe('Save as version 4 (keeps 1 rule allowed earlier)');
    expect(carried.byId('move-save')!.props.disabled).toBe(false);
    net.reply = () => ({ ok: true, status: 200, data: { runId: 'R2', version: 4, reprint: [], gone: [], trucks: [], carried: 1 }, error: null, errorBody: null });
    await carried.act(() => carried.byId('move-save')!.props.onClick());
    expect(net.calls.at(-1)!.json.overrides).toEqual([]);
  });

  it('Add another change keeps a red step that is explicit (draftable), and is not offered for one that is not', async () => {
    const d = await mountWith(allowable([issue('ovr_a')]), true);
    await d.act(() => d.byId('move-add-change')!.props.onClick());
    expect(d.drafts).toEqual([{ ops: [{ kind: 'SWAP_LOADS', a: 'A1', b: 'B1' }], steps: [{ title: 'Move Customer C2 (C2) from T01 L1, stop 2 to T02 L1, stop 2', red: true }] }]);
    const no = await mountWith(allowable([issue('ovr_a')], {}, { draftable: false }), true);
    expect(no.byId('move-add-change')).toBeUndefined();
  });

  it('the plan screen: a tick per stop and per unserved customer, the selection bar, the load actions, the change list banner, allowances shown', () => {
    const src = readFileSync(path.resolve(__dirname, '../../app/t/[slug]/dispatch/plan-view.tsx'), 'utf8');
    expect(src).toMatch(/data-testid="stop-select"/);
    expect(src).toMatch(/data-testid="unserved-select"/);
    expect(src).toMatch(/data-testid="selection-bar"/);
    expect(src).toMatch(/onMoveLoad: \(\) => setMoveFor\(\{ kind: 'MOVE_LOAD', load: l \}\)/);
    expect(src).toMatch(/onSwap: \(\) => setMoveFor\(\{ kind: 'SWAP_LOADS', load: l \}\)/);
    expect(src).toMatch(/data-testid="edit-draft-banner"/);
    expect(src).toMatch(/canOverride=\{canOverride\}/);
    expect(src).toMatch(/st\.handAllowed \? 'text-violet-700' : 'text-red-600'/);
    expect(src).toMatch(/allowances: allowancesOnPlannedText\(d\.allowedByHand\)/);
  });
});
