'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { Params, Replay, RunResult } from './types';

type State = { status: 'idle' | 'running' | 'done' | 'error'; result: RunResult | null; error: string | null; ms: number };
export type DayRef = { path: string; buf?: ArrayBuffer };

/** Runs a backtest in the engine worker. Only the latest request's answer is kept.
 *  With `days`, it runs on real day files; buffers are sent once and the worker keeps them decoded. */
export function useLab() {
  const worker = useRef<Worker | null>(null);
  const latest = useRef(0);
  const waiting = useRef(new Map<number, (r: Replay | null) => void>());
  const replays = useRef(0);
  const [state, setState] = useState<State>({ status: 'idle', result: null, error: null, ms: 0 });

  useEffect(() => {
    const w = new Worker('/engine/worker.js');
    worker.current = w;
    w.onmessage = (ev: MessageEvent) => {
      const { id, ok, result, error, ms, replay } = ev.data;
      const cb = waiting.current.get(id);
      if (cb) { waiting.current.delete(id); cb(ok ? replay : null); return; }
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

  const replay = useCallback((date: string) => new Promise<Replay | null>((resolve) => {
    replays.current += 1;  // negative ids: a replay never touches the run result
    const id = -replays.current;
    waiting.current.set(id, resolve);
    worker.current?.postMessage({ id, replay: date });
  }), []);

  const fail = useCallback((error: string) => setState({ status: 'error', result: null, error, ms: 0 }), []);

  return { ...state, run, replay, fail };
}
