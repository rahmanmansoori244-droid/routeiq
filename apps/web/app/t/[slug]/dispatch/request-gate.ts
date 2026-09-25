/**
 * Latest-only gate for the day screen's loads (review ADD-STALE-DAY-CLIENT). Each load takes a
 * ticket; only the answer to the newest ticket may be shown, so a slow answer for a date or depot
 * the dispatcher already left can never overwrite the day on screen. The key is the day the load
 * is for ("date|depot"), so the screen can tell a refresh of the same day (polling, after an
 * action) from a switch to another day, which disables the day's actions until it has loaded.
 * Pure (no React), so it is unit-tested in tests/lib/request-gate.spec.ts.
 */
export interface GateTicket {
  readonly seq: number;
  readonly key: string;
}

export interface RequestGate {
  /** Start a load for `key`: every earlier ticket is out of date from now on. */
  begin(key: string): GateTicket;
  /** True while `t` is the newest ticket: only then may its answer be shown. */
  isCurrent(t: GateTicket): boolean;
  /** The key of the newest load that has not finished yet, or null when none is pending. */
  pendingKey(): string | null;
  /** The newest load finished (answer shown or error shown); no-op for an older ticket. */
  finish(t: GateTicket): void;
}

export function createRequestGate(): RequestGate {
  let seq = 0;
  let pending: GateTicket | null = null;
  return {
    begin(key) {
      const t = { seq: ++seq, key };
      pending = t;
      return t;
    },
    isCurrent(t) {
      return t.seq === seq;
    },
    pendingKey() {
      return pending?.key ?? null;
    },
    finish(t) {
      if (pending && pending.seq === t.seq) pending = null;
    },
  };
}

/** The key of a day: its date and depot (the depot may be unknown before the first load). */
export function dayKey(date: string | null | undefined, depotId: string | null | undefined): string {
  return `${date ?? ''}|${depotId ?? ''}`;
}
