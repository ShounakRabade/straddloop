'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { ExportKind, LedgerRow, Params, Replay, RollingResult, RunResult } from './types';
import type { Research, ResearchProgress, ResearchRequest } from './research';

/** What a run is doing, as the worker reports it: unpacking day files, simulating sessions, booking the ledger. */
export type RunProgress = { phase: 'decode' | 'simulate' | 'ledger'; done?: number; total?: number };
type State = {
  status: 'idle' | 'running' | 'done' | 'error'; result: RunResult | null; error: string | null; ms: number;
  progress: RunProgress | null;
  /** the result on screen is no longer held by the engine (a later run was cancelled): replay and exports need a re-run */
  detached: boolean;
  /** with an error: MISSING (a day file the engine no longer holds), CHECKSUM (a damaged file), and the files concerned */
  code: string | null; paths: string[] | null;
};
export type Page = { kind: string; total: number; offset: number; rows: LedgerRow[] };
export type DayRef = { path: string; buf?: ArrayBuffer; sha256?: string | null };
const IDLE: State = { status: 'idle', result: null, error: null, ms: 0, progress: null, detached: false, code: null, paths: null };
const keyOf = (path: string, lot: number) => `${path}|${lot}`;
type Answer = { ok: boolean; replay?: Replay | null; csv?: string | null; page?: Page | null; research?: Research; rolling?: RollingResult; error?: string };

/** Runs a backtest in the engine worker. Only the latest request's answer is kept.
 *  With `days`, it runs on real day files; buffers are sent once and the worker keeps them decoded (`holds` says which).
 *  `cancel` ends the worker and starts a new one: the run stops at once, and the engine's copy of the days and of the
 *  result on screen are gone (the result stays on screen, marked `detached`). */
export function useLab() {
  const worker = useRef<Worker | null>(null);
  const latest = useRef(0);
  const waiting = useRef(new Map<number, (r: Answer) => void>());
  const progressFor = useRef(new Map<number, (p: ResearchProgress) => void>());
  const replays = useRef(0);
  const held = useRef(new Set<string>());
  const detached = useRef(false);
  const [state, setState] = useState<State>(IDLE);

  const start = useCallback(() => {
    const w = new Worker('/engine/worker.js');
    worker.current = w;
    w.onmessage = (ev: MessageEvent) => {
      const d = ev.data, id = d.id;
      if (d.progress) {
        if (id > 0 && id === latest.current) setState((s) => (s.status === 'running' ? { ...s, progress: d.progress } : s));
        else progressFor.current.get(id)?.(d.progress);
        return;
      }
      const cb = waiting.current.get(id);
      if (cb) { waiting.current.delete(id); cb(d); return; }
      if (id !== latest.current) return;
      for (const k of (d.evicted ?? []) as string[]) held.current.delete(k);
      if (!d.ok && d.paths) for (const p of d.paths as string[]) for (const k of [...held.current]) if (k.startsWith(`${p}|`)) held.current.delete(k);
      if (d.ok) detached.current = false;
      setState(d.ok ? { ...IDLE, status: 'done', result: d.result, ms: d.ms }
        : { ...IDLE, status: 'error', error: d.error, code: d.code ?? null, paths: d.paths ?? null });
    };
    w.onerror = () => setState({ ...IDLE, status: 'error', error: 'The simulation engine could not start in this browser.' });
    return w;
  }, []);

  useEffect(() => { start(); return () => worker.current?.terminate(); }, [start]);

  const run = useCallback((params: Params, days?: DayRef[]) => {
    latest.current += 1;
    const lot = Number(params.lot_size) || 0;
    for (const d of days ?? []) if (d.buf) held.current.add(keyOf(d.path, lot));
    setState((s) => ({ ...s, status: 'running', error: null, code: null, paths: null, progress: null }));
    const transfer = (days ?? []).flatMap((d) => (d.buf ? [d.buf] : []));
    worker.current?.postMessage({ id: latest.current, params, days }, transfer);
  }, []);
  /** Whether the engine already holds this day (decoded for this lot size), so its file need not be sent. */
  const holds = useCallback((path: string, lot: number) => held.current.has(keyOf(path, lot)), []);
  /** Sends every day again on the next run (new files under the same names, e.g. reloaded from this computer). */
  const forget = useCallback(() => held.current.clear(), []);

  /** Stops whatever the engine is doing by ending the worker, and starts a fresh one. */
  const cancel = useCallback(() => {
    worker.current?.terminate();
    held.current.clear();
    latest.current += 1; // a late answer from the old worker can no longer land
    for (const [, cb] of waiting.current) cb({ ok: false, error: 'cancelled' });
    waiting.current.clear(); progressFor.current.clear();
    start();
    setState((s) => {
      detached.current = detached.current || !!s.result;
      return { ...s, status: s.result ? 'done' : 'idle', progress: null, error: null, code: null, paths: null, detached: !!s.result };
    });
  }, [start]);

  const ask = useCallback(<T,>(msg: Record<string, unknown>, pick: (d: Answer) => T, none: T) => {
    if (detached.current) return Promise.resolve(none); // the engine no longer holds the result on screen
    return new Promise<T>((resolve) => {
      replays.current += 1;  // negative ids: a side request never touches the run result
      const id = -replays.current;
      waiting.current.set(id, (d) => resolve(pick(d)));
      worker.current?.postMessage({ id, ...msg });
    });
  }, []);
  const replay = useCallback((date: string) => ask({ replay: date }, (d) => (d.ok ? d.replay ?? null : null), null), [ask]);
  /** CSV text of the latest run, made in the worker from the same ledger the page shows. */
  const exportCsv = useCallback((kind: ExportKind) => ask({ exportKind: kind }, (d) => (d.ok ? d.csv ?? null : null), null), [ask]);
  /** One page of tradebook / ledger / daily rows of the latest run. */
  const inspect = useCallback((kind: 'tradebook' | 'ledger' | 'daily', offset: number, limit: number) => ask({ inspect: { kind, offset, limit } }, (d) => (d.ok ? d.page ?? null : null), null), [ask]);

  const fail = useCallback((error: string) => setState({ ...IDLE, status: 'error', error }), []);

  /** Research on the latest run (regimes, robustness check, optimisation study). Resolves with the analysis or
   *  an error message; onProgress gets { done, total, stage } while a study runs. `cancel` stops it between runs. */
  const research = useCallback((req: ResearchRequest, onProgress?: (p: ResearchProgress) => void) => {
    replays.current += 1;
    const id = -replays.current;
    if (onProgress) progressFor.current.set(id, onProgress);
    const done = new Promise<{ ok: true; research: Research } | { ok: false; error: string }>((resolve) => {
      if (detached.current) { resolve({ ok: false, error: 'The result on screen is no longer loaded in the engine (the run after it was cancelled). Run it again first.' }); return; }
      waiting.current.set(id, (d) => { progressFor.current.delete(id); resolve(d.ok && d.research ? { ok: true, research: d.research } : { ok: false, error: d.error ?? 'Research stopped.' }); });
    });
    if (!detached.current) worker.current?.postMessage({ id, research: req });
    return { done, cancel: () => worker.current?.postMessage({ cancelResearch: id }) };
  }, []);

  /** Rolling windows over the latest real run's sessions: each window its own backtest. onProgress gets
   *  { done, total, label } between windows; `cancel` stops it before the next window. */
  const rolling = useCallback((req: { params: Params; days: DayRef[]; windows: { from: string; to: string }[] }, onProgress?: (p: ResearchProgress & { label?: string }) => void) => {
    replays.current += 1;
    const id = -replays.current;
    if (onProgress) progressFor.current.set(id, onProgress);
    const done = new Promise<{ ok: true; rolling: RollingResult } | { ok: false; error: string }>((resolve) => {
      waiting.current.set(id, (d) => { progressFor.current.delete(id); resolve(d.ok && d.rolling ? { ok: true, rolling: d.rolling } : { ok: false, error: d.error ?? 'Stopped.' }); });
    });
    // paths only: the worker decoded these days for the run they belong to
    worker.current?.postMessage({ id, rolling: { params: req.params, days: req.days.map((d) => ({ path: d.path })), windows: req.windows } });
    return { done, cancel: () => worker.current?.postMessage({ cancelResearch: id }) };
  }, []);

  return { ...state, run, holds, forget, cancel, replay, exportCsv, inspect, fail, research, rolling };
}
