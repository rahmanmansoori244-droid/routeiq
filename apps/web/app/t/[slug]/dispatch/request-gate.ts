/**
 * Gate for the day screen's loads (review ADD-STALE-DAY-CLIENT). Each load takes a ticket keyed by
 * the day it is for ("date|depot"), so the screen can tell a refresh of the same day (polling,
 * after an action) from a switch to another day, which disables the day's actions until it has
 * loaded.
 *
 * - An answer for another day than the newest load's is dropped: a slow answer for a date or
 *   depot the dispatcher already left can never overwrite the day on screen.
 * - An answer for the same day as the newest load is shown when it is newer than the answer on
 *   screen, even if a later refresh of that day has started meanwhile. Otherwise a day overview
 *   slower than the polling interval would drop every answer and freeze the screen (for example
 *   on "Optimizing..." after the job ended). An older answer never replaces a newer one.
 *
 * Pure (no React), so it is unit-tested in tests/lib/request-gate.spec.ts.
 */
export interface GateTicket {
  readonly seq: number;
  readonly key: string;
}

export interface RequestGate {
  /** Start a load for `key`: answers for any other key are out of date from now on. */
  begin(key: string): GateTicket;
  /**
   * True when the answer to `t` may be shown: it is for the same day as the newest load, and newer
   * than the answer shown last.
   */
  isCurrent(t: GateTicket): boolean;
  /** The key of the newest load that has not finished yet, or null when none is pending. */
  pendingKey(): string | null;
  /** The answer to `t` was shown (or its error): older answers are out of date from now on. */
  finish(t: GateTicket): void;
}

export function createRequestGate(): RequestGate {
  let seq = 0;
  let newest: GateTicket | null = null;
  let pending: GateTicket | null = null;
  let shown = 0;
  return {
    begin(key) {
      const t = { seq: ++seq, key };
      newest = t;
      pending = t;
      return t;
    },
    isCurrent(t) {
      return newest !== null && t.key === newest.key && t.seq > shown;
    },
    pendingKey() {
      return pending?.key ?? null;
    },
    finish(t) {
      if (t.seq > shown) shown = t.seq;
      if (pending && pending.seq <= t.seq) pending = null;
    },
  };
}

/** The key of a day: its date and depot (the depot may be unknown before the first load). */
export function dayKey(date: string | null | undefined, depotId: string | null | undefined): string {
  return `${date ?? ''}|${depotId ?? ''}`;
}
