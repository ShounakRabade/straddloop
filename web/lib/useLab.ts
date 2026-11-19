'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { ExportKind, LedgerRow, Params, Replay, RunResult } from './types';
import type { Research, ResearchProgress, ResearchRequest } from './research';

type State = { status: 'idle' | 'running' | 'done' | 'error'; result: RunResult | null; error: string | null; ms: number };
export type Page = { kind: string; total: number; offset: number; rows: LedgerRow[] };
export type DayRef = { path: string; buf?: ArrayBuffer };

/** Runs a backtest in the engine worker. Only the latest request's answer is kept.
 *  With `days`, it runs on real day files; buffers are sent once and the worker keeps them decoded. */
export function useLab() {
  const worker = useRef<Worker | null>(null);
  const latest = useRef(0);
  const waiting = useRef(new Map<number, (r: { ok: boolean; replay?: Replay | null; csv?: string | null; page?: Page | null; research?: Research; error?: string }) => void>());
  const progressFor = useRef(new Map<number, (p: ResearchProgress) => void>());
  const replays = useRef(0);
  const [state, setState] = useState<State>({ status: 'idle', result: null, error: null, ms: 0 });

  useEffect(() => {
    const w = new Worker('/engine/worker.js');
    worker.current = w;
    w.onmessage = (ev: MessageEvent) => {
      const { id, ok, result, error, ms } = ev.data;
      if (ev.data.progress) { progressFor.current.get(id)?.(ev.data.progress); return; }
      const cb = waiting.current.get(id);
      if (cb) { waiting.current.delete(id); cb(ev.data); return; }
      if (id !== latest.current) return;
      setState(ok ? { status: 'done', result, error: null, ms } : { status: 'error', result: null, error, ms: 0 });
    };
    w.onerror = () => setState({ status: 'error', result: null, error: 'The simulation engine could not start in this browser.', ms: 0 });
    return () => w.terminate();
  }, []);

  const run = useCallback((params: Params, days?: DayRef[]) => {
    latest.current += 1;
    setState((s) => ({ ...s, status: 'running', error: null }));
    const transfer = (days ?? []).flatMap((d) => (d.buf ? [d.buf] : []));
    worker.current?.postMessage({ id: latest.current, params, days }, transfer);
  }, []);

  const ask = useCallback(<T,>(msg: Record<string, unknown>, pick: (d: { ok: boolean; replay?: Replay | null; csv?: string | null; page?: Page | null; error?: string }) => T) => new Promise<T>((resolve) => {
    replays.current += 1;  // negative ids: a side request never touches the run result
    const id = -replays.current;
    waiting.current.set(id, (d) => resolve(pick(d)));
    worker.current?.postMessage({ id, ...msg });
  }), []);
  const replay = useCallback((date: string) => ask({ replay: date }, (d) => (d.ok ? d.replay ?? null : null)), [ask]);
  /** CSV text of the latest run, made in the worker from the same ledger the page shows. */
  const exportCsv = useCallback((kind: ExportKind) => ask({ exportKind: kind }, (d) => (d.ok ? d.csv ?? null : null)), [ask]);
  /** One page of tradebook / ledger / daily rows of the latest run. */
  const inspect = useCallback((kind: 'tradebook' | 'ledger' | 'daily', offset: number, limit: number) => ask({ inspect: { kind, offset, limit } }, (d) => (d.ok ? d.page ?? null : null)), [ask]);

  const fail = useCallback((error: string) => setState({ status: 'error', result: null, error, ms: 0 }), []);

  /** Research on the latest run (regimes, robustness check, optimisation study). Resolves with the analysis or
   *  an error message; onProgress gets { done, total, stage } while a study runs. `cancel` stops it between runs. */
  const research = useCallback((req: ResearchRequest, onProgress?: (p: ResearchProgress) => void) => {
    replays.current += 1;
    const id = -replays.current;
    if (onProgress) progressFor.current.set(id, onProgress);
    const done = new Promise<{ ok: true; research: Research } | { ok: false; error: string }>((resolve) => {
      waiting.current.set(id, (d) => { progressFor.current.delete(id); resolve(d.ok && d.research ? { ok: true, research: d.research } : { ok: false, error: d.error ?? 'Research stopped.' }); });
    });
    worker.current?.postMessage({ id, research: req });
    return { done, cancel: () => worker.current?.postMessage({ cancelResearch: id }) };
  }, []);

  return { ...state, run, replay, exportCsv, inspect, fail, research };
}
