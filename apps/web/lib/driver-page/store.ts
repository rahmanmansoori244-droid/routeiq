/**
 * Where the driver page keeps what is not sent yet (owner request 4 Oct 2026, spec section 13.1):
 * IndexedDB database `riq-driver` with four stores - `queue` (actions and photos, by key), `drafts`
 * (the stop sheet being filled in), `manifests` (the last manifest received, shown without signal) and
 * `links` (a reload without signal finds its truck-day; tracking restarts by itself). Raw IndexedDB:
 * no library. Without IndexedDB (a blocked private mode, some in-app browsers) the page uses the
 * memory store and says "Keep this page open until everything is sent." Browser-safe.
 */
import type { Draft, LinkEntry, QueueItem, QueueStore, StoredManifest } from './queue';

const DB_NAME = 'riq-driver';
const DB_VERSION = 1;
const QUEUE = 'queue';
const DRAFTS = 'drafts';
const MANIFESTS = 'manifests';
const LINKS = 'links';

const draftKey = (ns: string, stopKey: string) => `${ns}|${stopKey}`;
const nsOfDraftKey = (k: string) => k.split('|').slice(0, 2).join('|');

/** An in-memory store: the tests, and browsers without IndexedDB (lost when the page closes). */
export function memoryStore(): QueueStore {
  const queue = new Map<string, QueueItem>();
  const drafts = new Map<string, Draft>();
  const manifests = new Map<string, StoredManifest<unknown>>();
  const links = new Map<string, LinkEntry>();
  const clone = <T>(v: T): T => (v && typeof v === 'object' && !(v instanceof Blob) ? structuredCloneSafe(v) : v);
  return {
    persistent: false,
    async items(ns) {
      return [...queue.values()].filter((i) => i.ns === ns).map((i) => ({ ...i }));
    },
    async put(items) {
      for (const i of items) queue.set(i.key, { ...i });
    },
    async remove(keys) {
      for (const k of keys) queue.delete(k);
    },
    async commit(ns, stopKey, photoKeys, action) {
      const keep = new Set(photoKeys);
      for (const [k, i] of [...queue.entries()]) {
        if (i.ns !== ns || i.stopKey !== stopKey || i.state !== 'draft') continue;
        if (keep.has(k)) queue.set(k, { ...i, state: 'ready', createdAt: action.createdAt + 1, nextAt: action.createdAt });
        else queue.delete(k);
      }
      queue.set(action.key, { ...action });
      drafts.delete(draftKey(ns, stopKey));
    },
    async dropDrafts(ns, stopKey) {
      for (const [k, i] of [...queue.entries()]) if (i.ns === ns && i.stopKey === stopKey && i.state === 'draft') queue.delete(k);
      drafts.delete(draftKey(ns, stopKey));
    },
    async getDraft(ns, stopKey) {
      const d = drafts.get(draftKey(ns, stopKey));
      return d ? clone(d) : null;
    },
    async drafts(ns) {
      const out: Record<string, Draft> = {};
      for (const [k, d] of drafts) if (nsOfDraftKey(k) === ns) out[k.slice(ns.length + 1)] = clone(d);
      return out;
    },
    async putDraft(ns, stopKey, draft) {
      drafts.set(draftKey(ns, stopKey), clone(draft));
    },
    async getManifest<M>(ns: string) {
      const m = manifests.get(ns);
      return m ? (clone(m) as StoredManifest<M>) : null;
    },
    async putManifest<M>(ns: string, value: StoredManifest<M>) {
      manifests.set(ns, clone(value) as StoredManifest<unknown>);
    },
    async getLink(h) {
      return links.get(h) ?? null;
    },
    async putLink(h, entry) {
      links.set(h, { ...entry });
    },
    async namespaces() {
      const s = new Set<string>();
      for (const i of queue.values()) s.add(i.ns);
      for (const k of drafts.keys()) s.add(nsOfDraftKey(k));
      for (const k of manifests.keys()) s.add(k);
      for (const l of links.values()) s.add(l.ns);
      return [...s];
    },
    async clearNamespace(ns) {
      for (const [k, i] of [...queue.entries()]) if (i.ns === ns) queue.delete(k);
      for (const k of [...drafts.keys()]) if (nsOfDraftKey(k) === ns) drafts.delete(k);
      manifests.delete(ns);
      for (const [h, l] of [...links.entries()]) if (l.ns === ns) links.delete(h);
    },
  };
}

function structuredCloneSafe<T>(v: T): T {
  try {
    return structuredClone(v);
  } catch {
    return JSON.parse(JSON.stringify(v)) as T;
  }
}

function req<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

function done(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error('aborted'));
  });
}

function openDb(factory: IDBFactory): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const r = factory.open(DB_NAME, DB_VERSION);
    r.onupgradeneeded = () => {
      const db = r.result;
      if (!db.objectStoreNames.contains(QUEUE)) db.createObjectStore(QUEUE, { keyPath: 'key' }).createIndex('ns', 'ns');
      if (!db.objectStoreNames.contains(DRAFTS)) db.createObjectStore(DRAFTS);
      if (!db.objectStoreNames.contains(MANIFESTS)) db.createObjectStore(MANIFESTS);
      if (!db.objectStoreNames.contains(LINKS)) db.createObjectStore(LINKS);
    };
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
    r.onblocked = () => reject(new Error('blocked'));
  });
}

async function blobToBase64(b: Blob): Promise<string> {
  const buf = new Uint8Array(await b.arrayBuffer());
  let s = '';
  for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode(...buf.subarray(i, i + 0x8000));
  return btoa(s);
}

/**
 * The IndexedDB store, or null when IndexedDB is missing or refuses to open (the caller falls back to
 * memoryStore). A Blob that cannot be stored (old iOS) is kept as a base64 string.
 */
export async function openIdbStore(factory: IDBFactory | undefined = typeof indexedDB !== 'undefined' ? indexedDB : undefined): Promise<QueueStore | null> {
  if (!factory) return null;
  let db: IDBDatabase;
  try {
    db = await openDb(factory);
  } catch {
    return null;
  }
  const store = (name: string, mode: IDBTransactionMode) => db.transaction(name, mode).objectStore(name);
  const putItems = async (items: QueueItem[]) => {
    const tx = db.transaction(QUEUE, 'readwrite');
    const os = tx.objectStore(QUEUE);
    for (const i of items) os.put(i);
    await done(tx);
  };
  const s: QueueStore = {
    persistent: true,
    async items(ns) {
      return (await req(store(QUEUE, 'readonly').index('ns').getAll(ns))) as QueueItem[];
    },
    async put(items) {
      if (!items.length) return;
      try {
        await putItems(items);
      } catch {
        // Old iOS cannot store a Blob: keep the photo as base64 instead.
        const fixed = await Promise.all(items.map(async (i) => (i.blob instanceof Blob ? { ...i, blob: await blobToBase64(i.blob) } : i)));
        await putItems(fixed);
      }
    },
    async remove(keys) {
      if (!keys.length) return;
      const tx = db.transaction(QUEUE, 'readwrite');
      for (const k of keys) tx.objectStore(QUEUE).delete(k);
      await done(tx);
    },
    async commit(ns, stopKey, photoKeys, action) {
      const keep = new Set(photoKeys);
      const tx = db.transaction([QUEUE, DRAFTS], 'readwrite');
      const q = tx.objectStore(QUEUE);
      const all = (await req(q.index('ns').getAll(ns))) as QueueItem[];
      for (const i of all) {
        if (i.stopKey !== stopKey || i.state !== 'draft') continue;
        if (keep.has(i.key)) q.put({ ...i, state: 'ready', createdAt: action.createdAt + 1, nextAt: action.createdAt });
        else q.delete(i.key);
      }
      q.put(action);
      tx.objectStore(DRAFTS).delete(draftKey(ns, stopKey));
      await done(tx);
    },
    async dropDrafts(ns, stopKey) {
      const tx = db.transaction([QUEUE, DRAFTS], 'readwrite');
      const q = tx.objectStore(QUEUE);
      const all = (await req(q.index('ns').getAll(ns))) as QueueItem[];
      for (const i of all) if (i.stopKey === stopKey && i.state === 'draft') q.delete(i.key);
      tx.objectStore(DRAFTS).delete(draftKey(ns, stopKey));
      await done(tx);
    },
    async getDraft(ns, stopKey) {
      return ((await req(store(DRAFTS, 'readonly').get(draftKey(ns, stopKey)))) as Draft | undefined) ?? null;
    },
    async drafts(ns) {
      const os = store(DRAFTS, 'readonly');
      const [keys, values] = await Promise.all([req(os.getAllKeys()), req(os.getAll())]);
      const out: Record<string, Draft> = {};
      keys.forEach((k, i) => {
        const key = String(k);
        if (nsOfDraftKey(key) === ns) out[key.slice(ns.length + 1)] = values[i] as Draft;
      });
      return out;
    },
    async putDraft(ns, stopKey, draft) {
      const tx = db.transaction(DRAFTS, 'readwrite');
      tx.objectStore(DRAFTS).put(draft, draftKey(ns, stopKey));
      await done(tx);
    },
    async getManifest<M>(ns: string) {
      return ((await req(store(MANIFESTS, 'readonly').get(ns))) as StoredManifest<M> | undefined) ?? null;
    },
    async putManifest<M>(ns: string, value: StoredManifest<M>) {
      const tx = db.transaction(MANIFESTS, 'readwrite');
      tx.objectStore(MANIFESTS).put(value, ns);
      await done(tx);
    },
    async getLink(h) {
      return ((await req(store(LINKS, 'readonly').get(h))) as LinkEntry | undefined) ?? null;
    },
    async putLink(h, entry) {
      const tx = db.transaction(LINKS, 'readwrite');
      tx.objectStore(LINKS).put(entry, h);
      await done(tx);
    },
    async namespaces() {
      const out = new Set<string>();
      const items = (await req(store(QUEUE, 'readonly').getAll())) as QueueItem[];
      for (const i of items) out.add(i.ns);
      for (const k of await req(store(DRAFTS, 'readonly').getAllKeys())) out.add(nsOfDraftKey(String(k)));
      for (const k of await req(store(MANIFESTS, 'readonly').getAllKeys())) out.add(String(k));
      for (const l of (await req(store(LINKS, 'readonly').getAll())) as LinkEntry[]) out.add(l.ns);
      return [...out];
    },
    async clearNamespace(ns) {
      const tx = db.transaction([QUEUE, DRAFTS, MANIFESTS, LINKS], 'readwrite');
      const q = tx.objectStore(QUEUE);
      for (const i of (await req(q.index('ns').getAll(ns))) as QueueItem[]) q.delete(i.key);
      const d = tx.objectStore(DRAFTS);
      for (const k of await req(d.getAllKeys())) if (nsOfDraftKey(String(k)) === ns) d.delete(k);
      tx.objectStore(MANIFESTS).delete(ns);
      const l = tx.objectStore(LINKS);
      const [lk, lv] = await Promise.all([req(l.getAllKeys()), req(l.getAll())]);
      lk.forEach((k, i) => {
        if ((lv[i] as LinkEntry).ns === ns) l.delete(k);
      });
      await done(tx);
    },
  };
  return s;
}

/** The phone's own date (YYYY-MM-DD, local). */
export function phoneTodayIso(now: Date = new Date()): string {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

/** A photo kept as base64 (old iOS) back as a Blob for the upload. */
export function photoBlob(b: Blob | string | null | undefined): Blob | null {
  if (!b) return null;
  if (typeof b !== 'string') return b;
  const bin = atob(b);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return new Blob([out], { type: 'image/jpeg' });
}
