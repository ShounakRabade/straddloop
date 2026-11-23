'use client';
/**
 * Day files kept in this browser (IndexedDB), so a stored day is downloaded once: later runs, a restarted engine
 * (after a cancel) and optimiser studies read it from here. Each file is kept under its path with the sha256 the
 * inventory lists for it; a file re-uploaded with new content has a new hash, so the old copy is not used. The engine
 * checks every file against that hash when it unpacks it, so a damaged copy is refused there and removed here.
 * Where storage is blocked (some private windows) everything still works; files are simply downloaded each time.
 */
import { download } from './marketData';

export type DayFileRef = { path: string; sha256: string | null };
export type DayFile = { path: string; buf: ArrayBuffer; sha256: string | null };
type Entry = { path: string; sha256: string; buf: ArrayBuffer; bytes: number; at: number };

const DB = 'straddloop-days', STORE = 'files';
let dbp: Promise<IDBDatabase> | null = null;
function open(): Promise<IDBDatabase> {
  if (typeof indexedDB === 'undefined') return Promise.reject(new Error('no IndexedDB'));
  return (dbp ??= new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => { if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE, { keyPath: 'path' }).createIndex('bytes', 'bytes'); };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB is blocked'));
  }).catch((e) => { dbp = null; throw e; }));
}
const done = (t: IDBTransaction) => new Promise<void>((resolve, reject) => { t.oncomplete = () => resolve(); t.onerror = () => reject(t.error); t.onabort = () => reject(t.error); });

/** The cached copies of these files that still match their hash (by path). Never throws: a blocked store is empty. */
async function cached(files: DayFileRef[]): Promise<Map<string, ArrayBuffer>> {
  const out = new Map<string, ArrayBuffer>();
  const want = files.filter((f) => f.sha256);
  if (!want.length) return out;
  try {
    const db = await open();
    const t = db.transaction(STORE), st = t.objectStore(STORE);
    await Promise.all(want.map((f) => new Promise<void>((resolve) => {
      const q = st.get(f.path);
      q.onsuccess = () => { const e = q.result as Entry | undefined; if (e && e.sha256 === f.sha256) out.set(f.path, e.buf); resolve(); };
      q.onerror = () => resolve();
    })));
  } catch { /* storage blocked: nothing cached */ }
  return out;
}
async function keep(files: DayFile[]): Promise<void> {
  const ok = files.filter((f) => f.sha256);
  if (!ok.length) return;
  try {
    const db = await open();
    const t = db.transaction(STORE, 'readwrite'), st = t.objectStore(STORE), at = Date.now();
    for (const f of ok) st.put({ path: f.path, sha256: f.sha256!, buf: f.buf, bytes: f.buf.byteLength, at } satisfies Entry);
    await done(t);
  } catch { /* storage blocked or full: the files were still used for this run */ }
}

/**
 * The files in the order asked: from this browser when a matching copy is kept, otherwise downloaded (and kept).
 * onProgress({ cached, downloaded, total }) after the cache is read and after each download. Each buffer returned is
 * the caller's own (it may be transferred to a worker).
 */
export async function fetchDays(files: DayFileRef[], onProgress?: (p: { cached: number; downloaded: number; total: number }) => void,
  signal?: { aborted: boolean }): Promise<DayFile[]> {
  const have = await cached(files);
  const missing = files.filter((f) => !have.has(f.path));
  onProgress?.({ cached: have.size, downloaded: 0, total: files.length });
  const sha = new Map(files.map((f) => [f.path, f.sha256]));
  // each file is kept as it arrives, so a cancelled download keeps what it already fetched
  const writes: Promise<void>[] = [];
  const got = missing.length ? await download(missing.map((f) => f.path), (n) => onProgress?.({ cached: have.size, downloaded: n, total: files.length }),
    { signal, onFile: (g) => writes.push(keep([{ path: g.path, buf: g.buf, sha256: sha.get(g.path) ?? null }])) }) : [];
  await Promise.all(writes);
  const fresh = new Map(got.map((g) => [g.path, g.buf]));
  return files.map((f) => ({ path: f.path, sha256: f.sha256, buf: (have.get(f.path) ?? fresh.get(f.path))! }));
}

/** Drops kept copies (a file the engine refused as damaged, or everything). */
export async function forgetDays(paths?: string[]): Promise<void> {
  try {
    const db = await open();
    const t = db.transaction(STORE, 'readwrite'), st = t.objectStore(STORE);
    if (paths) for (const p of paths) st.delete(p); else st.clear();
    await done(t);
  } catch { /* nothing kept */ }
}

/** How much is kept: files and bytes. null when storage is blocked. */
export async function dayCacheUsage(): Promise<{ files: number; bytes: number } | null> {
  try {
    const db = await open();
    return await new Promise((resolve, reject) => {
      let files = 0, bytes = 0;
      // key cursor on the size index: counts without reading the files themselves
      const q = db.transaction(STORE).objectStore(STORE).index('bytes').openKeyCursor();
      q.onsuccess = () => { const c = q.result; if (!c) { resolve({ files, bytes }); return; } files++; bytes += Number(c.key); c.continue(); };
      q.onerror = () => reject(q.error);
    });
  } catch { return null; }
}
