'use client';
/**
 * The page side of optimisation studies: one pool of optimiser workers, the study store, and the running study.
 * Lives in the Lab page, so a study keeps running while the results are on screen.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { WorkerPool, configParams, runStudy, type InitReq, type Progress } from './controller.ts';
import { browserStore, memoryStore, type CandRecord, type StudyConfig, type StudyData, type StudyRecord, type Store } from './store.ts';
import { labStrategy, runParamsFor } from './space.ts';

/** Memory one optimiser worker needs for the decoded sessions (measured: about 1.7 MB a session, real or synthetic). */
export const MB_PER_SESSION = 1.7;
/** What the optimiser workers together may hold by default. */
export const MEMORY_BUDGET_MB = 600;
export function autoWorkers(sessions: number, cores: number): number {
  const byMem = Math.floor(MEMORY_BUDGET_MB / Math.max(1, sessions * MB_PER_SESSION));
  return Math.max(1, Math.min(4, Math.max(1, cores - 1), byMem));
}

export type LoadDays = (d: StudyData, onProgress: (done: number, total: number) => void) => Promise<{ path: string; buf: ArrayBuffer }[]>;
export type Opened = { study: StudyRecord; cands: CandRecord[] };

export function useOptimiser(loadDays: LoadDays) {
  const pool = useRef<WorkerPool | null>(null);
  const store = useRef<Store | null>(null);
  const [persistent, setPersistent] = useState(true);
  const [progress, setProgress] = useState<Progress | null>(null);
  const [download, setDownload] = useState<{ done: number; total: number } | null>(null);
  const [running, setRunning] = useState<StudyConfig | null>(null);
  const [studies, setStudies] = useState<StudyRecord[] | null>(null);
  const [opened, setOpened] = useState<Opened | null>(null);
  const [error, setError] = useState<string | null>(null);
  const signal = useRef({ cancelled: false });
  const load = useRef(loadDays);
  load.current = loadDays;

  const getStore = useCallback(async (): Promise<Store> => {
    if (store.current) return store.current;
    const b = browserStore();
    try { await b.listStudies(); store.current = b; }
    catch { store.current = memoryStore(); setPersistent(false); }
    return store.current;
  }, []);
  const refresh = useCallback(async () => { const s = await getStore(); setStudies(await s.listStudies()); }, [getStore]);
  useEffect(() => { refresh().catch(() => setStudies([])); }, [refresh]);
  useEffect(() => () => pool.current?.close(), []);

  /** A pool of the study's size; kept between studies (and their curves) on the same data. */
  const poolFor = (cfg: StudyConfig) => {
    if (!pool.current || pool.current.size !== cfg.workers) { pool.current?.close(); pool.current = new WorkerPool(cfg.workers); }
    return pool.current;
  };
  const initFor = (cfg: StudyConfig, p: WorkerPool) => async (): Promise<InitReq> => {
    const base = { lotSize: cfg.data.lotSize, plan: { split: cfg.split, folds: cfg.folds, wfMode: cfg.wfMode }, capital: cfg.capital, key: cfg.data.key };
    if (p.holds(cfg.data.key)) return { ...base, days: null, synthetic: null };
    if (cfg.data.source === 'synthetic') return { ...base, days: null, synthetic: cfg.data.synthetic! };
    setDownload({ done: 0, total: cfg.data.paths?.length ?? 0 });
    try { return { ...base, synthetic: null, days: await load.current(cfg.data, (done, total) => setDownload({ done, total })) }; }
    finally { setDownload(null); }
  };

  const start = useCallback(async (cfg: StudyConfig, resume?: Opened) => {
    if (running) return;
    signal.current = { cancelled: false };
    setRunning(cfg); setError(null); setOpened(null); setProgress(null);
    const p = poolFor(cfg);
    try {
      const out = await runStudy(cfg, { pool: p, store: await getStore(), init: initFor(cfg, p), onProgress: setProgress, signal: signal.current, batch: 4 }, resume);
      setOpened({ study: out.study, cands: [...out.cands.values()] });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setRunning(null);
      refresh().catch(() => undefined);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [running, getStore, refresh]);

  const cancel = useCallback(() => { signal.current.cancelled = true; pool.current?.cancel(); }, []);
  const open = useCallback(async (id: string) => { const s = await getStore(); const got = await s.loadStudy(id); if (got) setOpened(got); else setError('That study is no longer stored in this browser.'); }, [getStore]);
  const resume = useCallback(async (id: string) => { const s = await getStore(); const got = await s.loadStudy(id); if (got) await start(got.study.config, got); }, [getStore, start]);
  const remove = useCallback(async (id: string) => { const s = await getStore(); await s.deleteStudy(id); setOpened((o) => (o?.study.id === id ? null : o)); await refresh(); }, [getStore, refresh]);

  /** One configuration's day-by-day P&L on the study's data (for its curve). Loads the data into the pool if needed. */
  const curve = useCallback(async (cfg: StudyConfig, id: number) => {
    if (running && running.data.key !== cfg.data.key) throw new Error('A study on other data is running; its curve can be drawn when it finishes.');
    const p = running ? pool.current! : poolFor(cfg);
    if (!p.holds(cfg.data.key)) await p.init(await initFor(cfg, p)());
    const s = labStrategy(cfg.slug)!;
    return p.detail(runParamsFor(s, configParams(cfg, id), cfg.series));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [running]);

  return { persistent, progress, download, running, studies, opened, setOpened, error, setError, start, cancel, open, resume, remove, curve, refresh };
}
export type Optimiser = ReturnType<typeof useOptimiser>;
