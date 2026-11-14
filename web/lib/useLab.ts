'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { Params, RunResult } from './types';

type State = { status: 'idle' | 'running' | 'done' | 'error'; result: RunResult | null; error: string | null; ms: number };

/** Runs a backtest in the engine worker. Only the latest request's answer is kept. */
export function useLab() {
  const worker = useRef<Worker | null>(null);
  const latest = useRef(0);
  const [state, setState] = useState<State>({ status: 'idle', result: null, error: null, ms: 0 });

  useEffect(() => {
    const w = new Worker('/engine/worker.js');
    worker.current = w;
    w.onmessage = (ev: MessageEvent) => {
      const { id, ok, result, error, ms } = ev.data;
      if (id !== latest.current) return;
      setState(ok ? { status: 'done', result, error: null, ms } : { status: 'error', result: null, error, ms: 0 });
    };
    w.onerror = () => setState({ status: 'error', result: null, error: 'The simulation engine could not start in this browser.', ms: 0 });
    return () => w.terminate();
  }, []);

  const run = useCallback((params: Params) => {
    latest.current += 1;
    setState((s) => ({ ...s, status: 'running', error: null }));
    worker.current?.postMessage({ id: latest.current, params });
  }, []);

  return { ...state, run };
}
