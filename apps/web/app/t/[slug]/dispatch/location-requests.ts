/**
 * The ADD LOCATION dialog's requests (audit F06). "Read" (POST /api/locations/parse, which can take
 * seconds for a short link) and "Save location" belong to the dialog as it was when they started:
 * the customer it was opened for and the text that was read.
 *
 * Before, a Read started for customer A that answered after the dialog had been closed and opened
 * for customer B put A's point into B's dialog, and Save wrote it onto B. The Enter key started a
 * second Read while the first was still running (the Read button was disabled, Enter was not), so
 * B's own answer could be replaced by A's late one as well.
 *
 * - `dialogChanged()`: the dialog opened, closed or shows another customer. Every request started
 *   before is out of date; a running Read is aborted.
 * - `inputChanged()`: the dispatcher typed other text or dropped a pin by hand. A running Read is
 *   out of date (and aborted); a running Save is not (it saves what was on screen when clicked).
 * - One request at a time: `beginRead()` / `beginSave()` answer null while one runs - the Read
 *   button and the Enter key alike.
 * - `answered(t)`: true when the answer may change the dialog on screen. A Save answer that is out of
 *   date is still reported for its own customer (it was saved), never applied to the dialog.
 *
 * Pure (no React), so it is unit-tested in tests/lib/dispatch-location-dialog.spec.ts (with the dialog itself).
 */
export interface DialogTicket {
  readonly kind: 'read' | 'save';
  /** The dialog generation (open / close / another customer) the request started in. */
  readonly dialog: number;
  /** The input generation (typed text, a pin dropped by hand) the request started in. */
  readonly input: number;
}

export interface LocationRequests {
  dialogChanged(): void;
  inputChanged(): void;
  /** Start a Read; null while a Read or a Save is running. `signal` aborts it when it goes out of date. */
  beginRead(): { ticket: DialogTicket; signal: AbortSignal } | null;
  /** Start a Save; null while a Read or a Save is running. */
  beginSave(): DialogTicket | null;
  /** The request of `t` ended: true when its answer may change the dialog on screen. */
  answered(t: DialogTicket): boolean;
  /** A Read or a Save is running. */
  busy(): boolean;
}

export function createLocationRequests(): LocationRequests {
  let dialog = 0;
  let input = 0;
  let running: { ticket: DialogTicket; ctrl: AbortController | null } | null = null;
  const drop = () => {
    running?.ctrl?.abort();
    running = null;
  };
  return {
    dialogChanged() {
      dialog++;
      input++;
      drop();
    },
    inputChanged() {
      input++;
      if (running?.ticket.kind === 'read') drop();
    },
    beginRead() {
      if (running) return null;
      const ctrl = new AbortController();
      const ticket: DialogTicket = { kind: 'read', dialog, input };
      running = { ticket, ctrl };
      return { ticket, signal: ctrl.signal };
    },
    beginSave() {
      if (running) return null;
      const ticket: DialogTicket = { kind: 'save', dialog, input };
      running = { ticket, ctrl: null };
      return ticket;
    },
    answered(t) {
      if (running?.ticket === t) running = null;
      return t.dialog === dialog && (t.kind === 'save' || t.input === input);
    },
    busy: () => running !== null,
  };
}
