'use client';

import { useEffect, useState, type FormEvent } from 'react';
import { Search } from 'lucide-react';
import { MAX_QUERY_CHARS } from '@/lib/sales-link/route-code';
import { UI } from '@/lib/sales-page/format';

/**
 * The route code entry: one big field for a phone (16 px text, so iPhones do not zoom; capitals; no
 * autocorrect), the hint from the server ("as on your Salesman ETA page"), and the error of the last try.
 * Several routes at once: "R1, R2X"; a truck by its code ("1234-AB", or its digits "1234"; owner decision of 20 Oct 2026).
 */
export function RouteForm({
  initial,
  hint,
  error,
  working,
  waitSec,
  onSubmit,
}: {
  initial: string;
  hint: string | null;
  error: string | null;
  working: boolean;
  waitSec: number | null;
  onSubmit: (text: string) => void;
}) {
  const [text, setText] = useState(initial);
  useEffect(() => setText(initial), [initial]);
  const send = (e: FormEvent) => {
    e.preventDefault();
    if (!working) onSubmit(text);
  };
  return (
    <form onSubmit={send} className="space-y-3 rounded-lg bg-white p-4 shadow-sm ring-1 ring-slate-200" data-testid="route-form" noValidate>
      <label htmlFor="sales-route" className="block text-base font-semibold">
        {UI.routeLabel}
      </label>
      <input
        id="sales-route"
        name="route"
        value={text}
        onChange={(e) => setText(e.target.value)}
        autoCapitalize="characters"
        autoComplete="off"
        autoCorrect="off"
        spellCheck={false}
        enterKeyHint="go"
        maxLength={MAX_QUERY_CHARS}
        placeholder="R1"
        aria-describedby="sales-route-hint sales-route-error"
        aria-invalid={error ? true : undefined}
        className="block min-h-12 w-full rounded-md border border-slate-300 px-3 text-base uppercase tracking-wide placeholder:normal-case placeholder:text-slate-400 focus:border-slate-900 focus:outline-none focus:ring-2 focus:ring-slate-900/20"
        data-testid="route-input"
      />
      <p id="sales-route-hint" className="text-sm text-slate-600">
        {hint ?? 'Your route code (as on your Salesman ETA page) or a truck code'}. {UI.routeHelp}.
      </p>
      <div id="sales-route-error" aria-live="polite">
        {error ? (
          <p className="rounded-md bg-red-50 p-2 text-sm text-red-900" data-testid="route-error">
            {error}
          </p>
        ) : null}
        {waitSec ? <p className="rounded-md bg-amber-50 p-2 text-sm text-amber-900">{UI.busy(waitSec)}</p> : null}
      </div>
      <button
        type="submit"
        disabled={working}
        className="inline-flex min-h-12 w-full items-center justify-center gap-2 rounded-md bg-slate-900 px-4 text-base font-semibold text-white disabled:opacity-60"
        data-testid="route-submit"
      >
        <Search className="h-5 w-5" aria-hidden /> {working ? UI.loading : UI.show}
      </button>
    </form>
  );
}
