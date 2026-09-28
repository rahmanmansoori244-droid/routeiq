/**
 * A minimal single-component hook runtime for component tests without a DOM (the repo has no
 * jsdom). Adapted from the audit verifier's harness (.dev/audit-verify/ui-v2/hooks.ts, 27 Sep 2026).
 *
 * The REAL component function is called with useState / useEffect / useRef / useCallback / useMemo
 * implemented here (a spec replaces them with `vi.mock('react', ...)`, see mockReactHooks). Child
 * components are NOT rendered: their props are read from the element tree and their callbacks
 * called, like a user clicking or typing. Effects run after each render; setState marks the
 * component dirty and the host renders again until it is stable (React batches the same way).
 */
type AnyFn = (...a: any[]) => any;
let current: Host<any> | null = null;

export class Host<P extends object> {
  slots: any[] = [];
  i = 0;
  queued: (() => void)[] = [];
  dirty = false;
  tree: any = null;
  renders = 0;
  constructor(
    public comp: (p: P) => any,
    public props: P,
  ) {}

  /** Render with `next` merged into the props (a parent re-rendering it), then until stable. */
  render(next?: Partial<P>) {
    if (next) this.props = { ...this.props, ...next };
    let guard = 0;
    do {
      this.dirty = false;
      this.i = 0;
      this.queued = [];
      current = this;
      try {
        this.tree = this.comp(this.props);
      } finally {
        current = null;
      }
      this.renders++;
      const q = this.queued;
      this.queued = [];
      for (const e of q) e();
      if (++guard > 100) throw new Error('render loop');
    } while (this.dirty);
    return this.tree;
  }

  /** Render again when a callback changed state. */
  flush() {
    if (this.dirty) this.render();
  }

  /** Let pending promises (answers) run, then render what they changed. */
  async settle() {
    for (let k = 0; k < 20; k++) await new Promise((r) => setTimeout(r, 0));
    this.flush();
  }
}

function slot<T>(make: () => T): T {
  const h = current!;
  const k = h.i++;
  if (k >= h.slots.length) h.slots[k] = make();
  return h.slots[k];
}
const same = (a?: readonly unknown[], b?: readonly unknown[]) => !!a && !!b && a.length === b.length && a.every((x, k) => Object.is(x, b[k]));

function useState<T>(init: T | (() => T)) {
  const h = current!;
  const s = slot(() => {
    const st: any = { v: typeof init === 'function' ? (init as AnyFn)() : init };
    st.set = (nv: any) => {
      const next = typeof nv === 'function' ? nv(st.v) : nv;
      if (!Object.is(next, st.v)) {
        st.v = next;
        h.dirty = true;
      }
    };
    return st;
  });
  return [s.v, s.set];
}

function useEffect(fn: () => any, deps?: unknown[]) {
  const h = current!;
  const s = slot(() => ({ deps: undefined as unknown[] | undefined, cleanup: undefined as any, ran: false }));
  if (!s.ran || !deps || !same(s.deps, deps)) {
    s.ran = true;
    s.deps = deps;
    h.queued.push(() => {
      if (typeof s.cleanup === 'function') s.cleanup();
      s.cleanup = fn();
    });
  }
}

export const hooks = {
  useState,
  useEffect,
  useLayoutEffect: useEffect,
  useRef<T>(init: T) {
    return slot(() => ({ current: init }));
  },
  useCallback<F>(fn: F, deps: unknown[]) {
    const s = slot(() => ({ fn, deps }));
    if (!same(s.deps, deps)) {
      s.fn = fn;
      s.deps = deps;
    }
    return s.fn;
  },
  useMemo<T>(fn: () => T, deps: unknown[]) {
    const s = slot(() => ({ v: fn(), deps }));
    if (!same(s.deps, deps)) {
      s.v = fn();
      s.deps = deps;
    }
    return s.v;
  },
};

/** The `vi.mock('react', ...)` factory: the real React with the hooks above. */
export async function mockReactHooks(importActual: () => Promise<unknown>) {
  const actual = (await importActual()) as Record<string, unknown>;
  return { ...actual, ...hooks, default: { ...actual, ...hooks } };
}

/** Every React element in a tree (props.children followed; child components not rendered). */
export function elements(node: any, out: any[] = []): any[] {
  if (node == null || typeof node === 'boolean') return out;
  if (Array.isArray(node)) {
    for (const n of node) elements(n, out);
    return out;
  }
  if (typeof node === 'object' && node.$$typeof) {
    out.push(node);
    elements(node.props?.children, out);
  }
  return out;
}

/** The text inside an element (strings / numbers among its children, recursively). */
export function textOf(node: any): string {
  if (node == null || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textOf).join('');
  if (typeof node === 'object' && node.$$typeof) return textOf(node.props?.children);
  return '';
}

export const typeName = (el: any): string => (typeof el.type === 'string' ? el.type : el.type?.displayName ?? el.type?.name ?? el.type?.render?.name ?? '?');

/** A promise with its resolve outside (an answer that arrives when the test says so). */
export function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}
