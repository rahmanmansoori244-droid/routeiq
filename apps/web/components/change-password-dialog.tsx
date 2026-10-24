'use client';

/**
 * "Change password" (user menu, every page with the top bar and the platform admin page; 24 Oct
 * 2026): the signed-in user types the current password and a new one twice; POST
 * /api/account/password changes it (lib/own-password.ts). The dialog checks the same rules first
 * (lib/password-rules.ts) so a refused password costs no request.
 *
 * After the change every session of the user has ended, this one included (the session carries a
 * fingerprint of the password hash), so the dialog says so and signs out to the sign-in page, which
 * says "Your password is changed" (/login?reason=password).
 */
import { useState } from 'react';
import { signOut } from 'next-auth/react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { errorMessage } from '@/lib/error-message';
import { newPasswordProblem, PASSWORD_MIN_CHARS } from '@/lib/password-rules';

export const CHANGE_PASSWORD_API = '/api/account/password';
export const PASSWORD_CHANGED_LOGIN = '/login?reason=password';

export const NOT_THE_SAME = 'The two new passwords are not the same.';
export const NO_ANSWER = 'No answer from RouteIQ. If your password was changed, you will be asked to sign in again; otherwise try again.';

export function ChangePasswordDialog({
  open,
  onOpenChange,
  email,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The signed-in user's email (the new password must not be it). */
  email: string;
}) {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [again, setAgain] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);

  function clear() {
    setCurrent('');
    setNext('');
    setAgain('');
    setError(null);
  }

  function onOpen(o: boolean) {
    // Not while the request runs, and not after the change (the dialog is signing out).
    if (busy || done) return;
    if (!o) clear();
    onOpenChange(o);
  }

  async function submit(e: { preventDefault: () => void }) {
    e.preventDefault();
    if (busy || done) return;
    const problem = newPasswordProblem(next, { currentPassword: current, email }) ?? (next !== again ? NOT_THE_SAME : null);
    if (problem) {
      setError(problem);
      return;
    }
    setError(null);
    setBusy(true);
    let res: Response;
    try {
      res = await fetch(CHANGE_PASSWORD_API, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ currentPassword: current, newPassword: next }),
      });
    } catch {
      setBusy(false);
      setError(NO_ANSWER);
      return;
    }
    const body: unknown = await res.json().catch(() => ({}));
    if (!res.ok) {
      setBusy(false);
      setError(errorMessage(body, 'The password was not changed.'));
      return;
    }
    clear();
    setDone(true);
    setBusy(false);
    // This session has ended with the others: clear its cookie and go to the sign-in page. Should the
    // sign-out request fail, the next page finds the session ended and sends the browser to sign in.
    try {
      await signOut({ callbackUrl: PASSWORD_CHANGED_LOGIN });
    } catch {
      window.location.assign(PASSWORD_CHANGED_LOGIN);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpen}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Change password</DialogTitle>
          <DialogDescription>
            {done
              ? 'Your password is changed. Signing you out: sign in again with your new password.'
              : `At least ${PASSWORD_MIN_CHARS} characters, not your current password and not your email. After the change you are signed out everywhere, here too, and sign in again with the new password.`}
          </DialogDescription>
        </DialogHeader>
        {done ? null : (
          <form onSubmit={submit} className="space-y-4">
            {/* Lets password managers save the new password for this account. */}
            <input type="text" name="username" autoComplete="username" value={email} readOnly hidden />
            <div className="space-y-1.5">
              <Label htmlFor="pw-current">Current password</Label>
              <Input
                id="pw-current"
                type="password"
                autoComplete="current-password"
                required
                value={current}
                onChange={(e) => setCurrent(e.target.value)}
                disabled={busy}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="pw-new">New password</Label>
              <Input
                id="pw-new"
                type="password"
                autoComplete="new-password"
                required
                value={next}
                onChange={(e) => setNext(e.target.value)}
                disabled={busy}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="pw-again">New password again</Label>
              <Input
                id="pw-again"
                type="password"
                autoComplete="new-password"
                required
                value={again}
                onChange={(e) => setAgain(e.target.value)}
                disabled={busy}
              />
            </div>
            {error ? (
              <p className="text-sm text-destructive" role="alert" aria-live="assertive">
                {error}
              </p>
            ) : null}
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => onOpen(false)} disabled={busy}>
                Cancel
              </Button>
              <Button type="submit" disabled={busy || !current || !next || !again}>
                {busy ? 'Changing…' : 'Change password'}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
