/**
 * Where studies live: IndexedDB in this browser (studies are large and private, so they are not sent anywhere).
 * Measurements are written in batches as they finish, so a study can be resumed after a cancel or a closed tab, and a
 * finished one can be opened again. A memory store with the same interface serves Node tests.
 */
import type { Value } from './space.ts';
import type { Params } from '../types';

/** A configuration's measurements (study.js summarise); kept opaque here. */
export type Summary = Record<string, any>;
export interface CandRecord {
  study: string;
  /** 'g<id>' a configuration of the study (0 = your settings, n = grid point n - 1); 's<id>' the same at doubled slippage */
  key: string;
  idx: number;
  kind: 'grid' | 'stress';
  values: Value[] | null;
  summary?: Summary;
  refused?: string;
  error?: string;
}
export interface StudyConfig {
  slug: string; name: string; base: Params;
  picks: { key: string; values: Value[] }[];
  objective: string; weights?: Record<string, number> | null; minTrades: number | null; topK: number;
  split: { train: number; validation: number; test: number }; folds: number; wfMode: 'rolling' | 'anchored';
  method: 'auto' | 'grid' | 'random'; max: number; seed: number; workers: number;
  real: boolean; series: 'WEEK' | 'MONTH';
  data: StudyData;
  capital: number;
}
/** The data a study ran on, enough to load the same sessions again (to resume it or draw a configuration's curve). */
export interface StudyData {
  source: 'synthetic' | 'dhan' | 'local';
  label: string; from: string | null; to: string | null; sessions: number;
  /** identifies the exact sessions (the Lab's range key, or the synthetic settings) */
  key: string;
  /** day files in date order (real data), and the sha256 the inventory lists for each (null when unknown) */
  paths?: string[];
  sha256?: (string | null)[];
  synthetic?: { days: number; seed: number; iv: number };
  lotSize: number;
}
export interface StudyRecord {
  id: string; created: string; updated: string;
  status: 'running' | 'cancelled' | 'done' | 'error';
  config: StudyConfig;
  plan?: Record<string, any>;
  /** evaluated: configurations of the search measured; extra: robustness runs (neighbours, doubled slippage) */
  counts: { planned: number; evaluated: number; refused: number; failed: number; extra?: number };
  result?: Record<string, any>;
  error?: string;
  ms?: number;
}
export interface Store {
  saveStudy(r: StudyRecord): Promise<void>;
  listStudies(): Promise<StudyRecord[]>;
  loadStudy(id: string): Promise<{ study: StudyRecord; cands: CandRecord[] } | null>;
  putCands(rows: CandRecord[]): Promise<void>;
  deleteStudy(id: string): Promise<void>;
}

export function memoryStore(): Store {
  const studies = new Map<string, StudyRecord>(), cands = new Map<string, Map<string, CandRecord>>();
  const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x));
  return {
    async saveStudy(r) { studies.set(r.id, clone(r)); },
    async listStudies() { return [...studies.values()].map(clone).sort((a, b) => (a.created < b.created ? 1 : -1)); },
    async loadStudy(id) { const s = studies.get(id); return s ? { study: clone(s), cands: [...(cands.get(id)?.values() ?? [])].map(clone) } : null; },
    async putCands(rows) { for (const r of rows) { const m = cands.get(r.study) ?? new Map(); m.set(r.key, clone(r)); cands.set(r.study, m); } },
    async deleteStudy(id) { studies.delete(id); cands.delete(id); },
  };
}

const DB = 'straddloop-optimiser', VER = 1;
function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, VER);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('studies')) db.createObjectStore('studies', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('cands')) db.createObjectStore('cands', { keyPath: ['study', 'key'] }).createIndex('study', 'study');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB is not available in this browser.'));
  });
}
const done = (t: IDBTransaction) => new Promise<void>((resolve, reject) => { t.oncomplete = () => resolve(); t.onerror = () => reject(t.error); t.onabort = () => reject(t.error); });

/** The browser store. Fails with a clear message where IndexedDB is blocked (some private windows). */
export function browserStore(): Store {
  let dbp: Promise<IDBDatabase> | null = null;
  const db = () => (dbp ??= open());
  return {
    async saveStudy(r) { const d = await db(); const t = d.transaction('studies', 'readwrite'); t.objectStore('studies').put(r); await done(t); },
    async listStudies() {
      const d = await db();
      return new Promise((resolve, reject) => { const q = d.transaction('studies').objectStore('studies').getAll(); q.onsuccess = () => resolve((q.result as StudyRecord[]).sort((a, b) => (a.created < b.created ? 1 : -1))); q.onerror = () => reject(q.error); });
    },
    async loadStudy(id) {
      const d = await db();
      const study = await new Promise<StudyRecord | undefined>((resolve, reject) => { const q = d.transaction('studies').objectStore('studies').get(id); q.onsuccess = () => resolve(q.result); q.onerror = () => reject(q.error); });
      if (!study) return null;
      const cands = await new Promise<CandRecord[]>((resolve, reject) => { const q = d.transaction('cands').objectStore('cands').index('study').getAll(id); q.onsuccess = () => resolve(q.result); q.onerror = () => reject(q.error); });
      return { study, cands };
    },
    async putCands(rows) { if (!rows.length) return; const d = await db(); const t = d.transaction('cands', 'readwrite'); const st = t.objectStore('cands'); for (const r of rows) st.put(r); await done(t); },
    async deleteStudy(id) {
      const d = await db(); const t = d.transaction(['studies', 'cands'], 'readwrite');
      t.objectStore('studies').delete(id);
      const q = t.objectStore('cands').index('study').openKeyCursor(IDBKeyRange.only(id));
      q.onsuccess = () => { const c = q.result; if (c) { t.objectStore('cands').delete(c.primaryKey); c.continue(); } };
      await done(t);
    },
  };
}
