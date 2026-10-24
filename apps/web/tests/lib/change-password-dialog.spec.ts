/**
 * "Change password" in the user menu (24 Oct 2026), driven through the hook host (hook-host.ts):
 * the REAL UserMenu opens the REAL ChangePasswordDialog; fetch and next-auth's signOut are faked.
 * - the menu offers "Change password" and opens the dialog for the signed-in user's email;
 * - the dialog refuses what the server would refuse (the shared rules) and two different new
 *   passwords, without a request;
 * - it sends { currentPassword, newPassword } to POST /api/account/password, and after the change
 *   signs out to /login?reason=password (every session ended, this one too);
 * - a refusal shows the server's words and keeps the user signed in; no answer says so;
 * - a session the server no longer accepts (401), or a password an admin reset / reset link changed
 *   meanwhile (409 CHANGED_MEANWHILE), never shows a bare "Unauthorized": the dialog says so and
 *   goes to the end-session page, back to this page after signing in (password review N1);
 * - one request at a time, and the dialog cannot be closed while it runs;
 * - closing the dialog puts the focus back on the menu's button (password review N2).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Host, elements, textOf, typeName } from './hook-host';

vi.mock('react', async (importActual) => (await import('./hook-host')).mockReactHooks(importActual));

const signOut = vi.fn(async (_opts?: unknown) => undefined);
vi.mock('next-auth/react', () => ({ signOut }));

interface Sent {
  url: string;
  init: RequestInit;
  answer: (status: number, body: unknown) => void;
  fail: () => void;
}
const sent: Sent[] = [];
vi.stubGlobal(
  'fetch',
  (url: string, init: RequestInit) =>
    new Promise((resolve, reject) =>
      sent.push({
        url,
        init,
        answer: (status, body) => resolve({ ok: status >= 200 && status < 300, status, json: async () => body }),
        fail: () => reject(new TypeError('Failed to fetch')),
      }),
    ),
);

const assigned: string[] = [];
vi.stubGlobal('window', { location: { pathname: '/t/acme/dispatch', search: '?date=2026-10-25', assign: (url: string) => assigned.push(url) } });

const { ChangePasswordDialog, CHANGE_PASSWORD_API, PASSWORD_CHANGED_LOGIN, NOT_THE_SAME, NO_ANSWER, SESSION_ENDED } = await import('@/components/change-password-dialog');
const { UserMenu } = await import('@/components/user-menu');
const { endSessionUrl } = await import('@/lib/safe-redirect');

beforeEach(() => {
  sent.length = 0;
  assigned.length = 0;
  signOut.mockClear();
});

function dialog() {
  const closed: boolean[] = [];
  const host: Host<any> = new Host(ChangePasswordDialog as any, {
    open: true,
    email: 'planner@a.example',
    onOpenChange: (v: boolean) => {
      closed.push(!v);
      host.render({ open: v });
    },
  });
  host.render();
  const els = () => elements(host.tree);
  const field = (id: string) => els().find((e) => e.props?.id === id);
  const type = (id: string, value: string) => {
    field(id).props.onChange({ target: { value } });
    host.flush();
  };
  const fill = (current: string, next: string, again = next) => {
    type('pw-current', current);
    type('pw-new', next);
    type('pw-again', again);
  };
  const submit = async () => {
    const form = els().find((e) => e.type === 'form');
    const p = form.props.onSubmit({ preventDefault: () => {} });
    host.flush();
    return p;
  };
  const errorText = () => textOf(els().find((e) => e.props?.role === 'alert') ?? null);
  const submitBtn = () => els().find((e) => typeName(e) === 'Button' && e.props?.type === 'submit');
  const description = () => textOf(els().find((e) => typeName(e) === 'DialogDescription'));
  const dialogEl = () => els().find((e) => typeName(e) === 'Dialog');
  return { host, field, fill, submit, errorText, submitBtn, description, dialogEl, closed };
}

describe('the user menu offers Change password', () => {
  it('"Change password" opens the dialog for the signed-in email; Sign out stays', () => {
    const host: Host<any> = new Host(UserMenu as any, { name: 'Pat Planner', email: 'planner@a.example', role: 'PLANNER' });
    host.render();
    const els = () => elements(host.tree);
    const item = (text: string) => els().find((e) => typeName(e) === 'DropdownMenuItem' && textOf(e).includes(text));
    const dlg = () => els().find((e) => e.type === ChangePasswordDialog);
    expect(item('Sign out')).toBeDefined();
    expect(dlg().props).toMatchObject({ open: false, email: 'planner@a.example' });
    item('Change password').props.onSelect();
    host.flush();
    expect(dlg().props.open).toBe(true);
    // The menu does not take the focus back from the dialog while it closes (once), then behaves as usual.
    const content = els().find((e) => typeName(e) === 'DropdownMenuContent');
    const first = { preventDefault: vi.fn() };
    content.props.onCloseAutoFocus(first);
    expect(first.preventDefault).toHaveBeenCalledTimes(1);
    const later = { preventDefault: vi.fn() };
    content.props.onCloseAutoFocus(later);
    expect(later.preventDefault).not.toHaveBeenCalled();
    dlg().props.onOpenChange(false);
    host.flush();
    expect(dlg().props.open).toBe(false);
  });

  it('closing the dialog puts the focus back on the menu button, not on the page body', () => {
    const host: Host<any> = new Host(UserMenu as any, { name: 'Pat Planner', email: 'planner@a.example', role: 'PLANNER' });
    host.render();
    const els = () => elements(host.tree);
    const button = els().find((e) => typeName(e) === 'Button' && e.props?.['aria-label'] === 'User menu');
    const focus = vi.fn();
    button.ref.current = { focus };
    const dlg = els().find((e) => e.type === ChangePasswordDialog);
    const closing = { preventDefault: vi.fn() };
    dlg.props.onCloseAutoFocus(closing);
    expect(closing.preventDefault).toHaveBeenCalledTimes(1);
    expect(focus).toHaveBeenCalledTimes(1);
  });
});

describe('ChangePasswordDialog', () => {
  it('refuses what the server would refuse, and two different new passwords, without a request', async () => {
    const d = dialog();
    d.fill('Current-Password-1', 'short');
    await d.submit();
    expect(d.errorText()).toBe('The new password must have at least 12 characters.');
    d.fill('Current-Password-1', 'Current-Password-1');
    await d.submit();
    expect(d.errorText()).toMatch(/different from your current password/);
    d.fill('Current-Password-1', 'planner@a.example');
    await d.submit();
    expect(d.errorText()).toMatch(/not be your email/);
    d.fill('Current-Password-1', 'A-brand-new-password-24', 'A-brand-new-password-25');
    await d.submit();
    expect(d.errorText()).toBe(NOT_THE_SAME);
    expect(sent).toEqual([]);
    expect(signOut).not.toHaveBeenCalled();
  });

  it('sends the two passwords to POST /api/account/password, then signs out to /login?reason=password', async () => {
    const d = dialog();
    d.fill('Current-Password-1', 'A-brand-new-password-24');
    const done = d.submit();
    expect(sent).toHaveLength(1);
    expect(sent[0]!.url).toBe(CHANGE_PASSWORD_API);
    expect(sent[0]!.init.method).toBe('POST');
    expect(JSON.parse(String(sent[0]!.init.body))).toEqual({ currentPassword: 'Current-Password-1', newPassword: 'A-brand-new-password-24' });
    // While it runs: the button is disabled, a second submit sends nothing, the dialog stays open.
    expect(d.submitBtn().props.disabled).toBe(true);
    await d.submit();
    expect(sent).toHaveLength(1);
    d.dialogEl().props.onOpenChange(false);
    expect(d.closed).toEqual([]);
    sent[0]!.answer(200, { data: { changed: true, signInAgain: true }, error: null });
    await done;
    await d.host.settle();
    expect(signOut).toHaveBeenCalledWith({ callbackUrl: PASSWORD_CHANGED_LOGIN });
    expect(PASSWORD_CHANGED_LOGIN).toBe('/login?reason=password');
    expect(d.description()).toMatch(/Your password is changed/);
    // The form is gone (nothing typed is kept), and the dialog cannot be closed while it signs out.
    expect(d.field('pw-current')).toBeUndefined();
    d.dialogEl().props.onOpenChange(false);
    expect(d.closed).toEqual([]);
  });

  it("a refusal shows the server's words and keeps the user signed in; they can try again", async () => {
    const d = dialog();
    d.fill('Not-my-password-1', 'A-brand-new-password-24');
    const p = d.submit();
    sent[0]!.answer(400, { data: null, error: { error: 'Your current password is not right. The password was not changed.', code: 'WRONG_PASSWORD' } });
    await p;
    await d.host.settle();
    expect(d.errorText()).toBe('Your current password is not right. The password was not changed.');
    expect(signOut).not.toHaveBeenCalled();
    expect(d.submitBtn().props.disabled).toBe(false);
    // Paused after too many wrong ones (429), the same way.
    const again = d.submit();
    sent[1]!.answer(429, { data: null, error: { error: 'Too many wrong current passwords.', code: 'THROTTLED' } });
    await again;
    await d.host.settle();
    expect(d.errorText()).toBe('Too many wrong current passwords.');
  });

  it('no answer (network): says the password may have changed; nothing is signed out', async () => {
    const d = dialog();
    d.fill('Current-Password-1', 'A-brand-new-password-24');
    const p = d.submit();
    sent[0]!.fail();
    await p;
    await d.host.settle();
    expect(d.errorText()).toBe(NO_ANSWER);
    expect(signOut).not.toHaveBeenCalled();
  });

  it('a session the server no longer accepts (401): says so and goes to end-session, back to this page; no bare "Unauthorized"', async () => {
    const d = dialog();
    d.fill('Current-Password-1', 'A-brand-new-password-24');
    const p = d.submit();
    sent[0]!.answer(401, { data: null, error: 'Unauthorized' });
    await p;
    await d.host.settle();
    expect(assigned).toEqual([endSessionUrl('/t/acme/dispatch?date=2026-10-25')]);
    expect(d.description()).toBe(SESSION_ENDED);
    expect(d.errorText()).toBe('');
    // Nothing typed is kept, the dialog cannot be closed while the page is replaced, next-auth is not asked.
    expect(d.field('pw-current')).toBeUndefined();
    d.dialogEl().props.onOpenChange(false);
    expect(d.closed).toEqual([]);
    expect(signOut).not.toHaveBeenCalled();
  });

  it('changed meanwhile by an admin reset or a reset link (409 CHANGED_MEANWHILE): shows the server words and goes to end-session', async () => {
    const d = dialog();
    d.fill('Current-Password-1', 'A-brand-new-password-24');
    const p = d.submit();
    const words = 'Your password was changed meanwhile (by an admin or a reset link), so it was not changed here. Sign in again with the newest password.';
    sent[0]!.answer(409, { data: null, error: { error: words, code: 'CHANGED_MEANWHILE' } });
    await p;
    await d.host.settle();
    expect(d.description()).toBe(words);
    expect(assigned).toEqual([endSessionUrl('/t/acme/dispatch?date=2026-10-25')]);
    expect(signOut).not.toHaveBeenCalled();
  });

  it('Cancel clears what was typed', () => {
    const d = dialog();
    d.fill('Current-Password-1', 'A-brand-new-password-24');
    const cancel = elements(d.host.tree).find((e) => typeName(e) === 'Button' && textOf(e).trim() === 'Cancel');
    cancel.props.onClick();
    d.host.flush();
    expect(d.closed).toEqual([true]);
    expect(d.field('pw-current').props.value).toBe('');
    expect(d.field('pw-new').props.value).toBe('');
    expect(d.field('pw-again').props.value).toBe('');
  });
});
