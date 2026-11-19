'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Button, hard } from '@/components/ui';
import type { Research, ResearchProgress, ResearchRequest } from '@/lib/research';
import { PARAM_SPACE, ENGINE_DEFAULTS } from '@/lib/researchSpace';
import type { Params, RunResult } from '@/lib/types';
import { SampleTag } from './bits';
import { OptimiseForm, StudyView, type StudyForm } from './Optimise';
import { Diagnostics, Reading, Regimes, RobustnessView } from './Views';

type Lab = { research: (req: ResearchRequest, onProgress?: (p: ResearchProgress) => void) => { done: Promise<{ ok: true; research: Research } | { ok: false; error: string }>; cancel: () => void } };
type Tab = 'reading' | 'regimes' | 'robustness' | 'optimise' | 'diagnostics';
const TABS: [Tab, string][] = [['reading', 'Reading'], ['regimes', 'Regimes'], ['robustness', 'Robustness'], ['optimise', 'Optimise'], ['diagnostics', 'Diagnostics']];

/** Which part of the settings a research result belongs to; anything else changing makes it stale. */
const keyOf = (p: Params) => JSON.stringify(Object.keys(p).filter((k) => k !== 'seed_note').sort().map((k) => [k, p[k]]));

/**
 * Research on the run above it: a written reading, regimes, robustness, an optimisation study and
 * diagnostics, all computed in the Lab worker from the same ledger as the report. The quick analysis
 * reruns with every result; the robustness check and the study run only when asked, and never change
 * the settings unless the person presses "Load".
 */
export function ResearchPanel({ r, lab, params, msPerRun, meta, partial, dataNote, onLoad }: {
  r: RunResult; lab: Lab; params: Params; msPerRun: number;
  meta: { oneLine: string; changed: string[] }; partial: number; dataNote: string | null;
  onLoad: (changes: Record<string, unknown>) => void;
}) {
  const [tab, setTab] = useState<Tab>('reading');
  const [quick, setQuick] = useState<Research | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState<null | 'check' | 'optimise'>(null);
  const [progress, setProgress] = useState<ResearchProgress | null>(null);
  const [mode, setMode] = useState<'fixed' | 'percentile'>('fixed');
  const [deep, setDeep] = useState<{ kind: 'check' | 'optimise'; key: string; res: Research } | null>(null);
  const cancelRef = useRef<null | (() => void)>(null);
  // measured speed of research backtests, per session, from the last check or study (a Lab run also builds
  // the report and may fetch data, so its time overstates a research backtest)
  const [msPerSession, setMsPerSession] = useState<number | null>(null);
  const timing = useRef<{ t0: number; total: number }>({ t0: 0, total: 0 });
  const strategy = r.strategy === 'orb' ? 'orb' : 'straddle';
  const runKey = keyOf(params) + '|' + (r.account?.report.generated.run_hash ?? '') + '|' + r.curve.length;
  // the optimisation space and the research runner cover these two engines; anything else gets an explanation
  const supported = (r.strategy === 'straddle' || r.strategy === 'orb') && !!r.account;
  const extra = useCallback((): ResearchRequest['extra'] => ({ meta, regimeMode: mode, partial, dataNote: dataNote ?? undefined }), [meta, mode, partial, dataNote]);
  const research = lab.research;

  // the quick analysis follows every new result (cheap: no extra backtests)
  useEffect(() => {
    if (!supported) return;
    let live = true;
    const t = setTimeout(() => {
      const job = research({ kind: 'analyse', extra: extra() });
      job.done.then((res) => { if (!live) return; if (res.ok) { setQuick(res.research); setErr(null); } else setErr(res.error); });
    }, 350);
    return () => { live = false; clearTimeout(t); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runKey, supported, mode]);

  const start = useCallback((kind: 'check' | 'optimise', form?: StudyForm) => {
    setBusy(kind); setErr(null); setProgress(null);
    timing.current = { t0: performance.now(), total: 0 };
    const axes = kind === 'check'
      ? PARAM_SPACE[strategy].filter((p) => !p.engine || params[p.key] !== undefined).map((p) => {
        const vals = p.kind === 'choice' ? (p.options ?? []) : (() => { const cur = Number(params[p.key] ?? ENGINE_DEFAULTS[p.key]); const st = p.step ?? 1; return [cur - st, cur, cur + st].filter((v) => v >= (p.min ?? -Infinity) && v <= (p.max ?? Infinity)); })();
        return { key: p.key, label: p.label, values: vals };
      })
      : form!.axes;
    const job = research({ kind, axes, options: form?.options, extra: extra() }, (pr) => { timing.current.total = pr.total; setProgress(pr); });
    cancelRef.current = job.cancel;
    job.done.then((res) => {
      setBusy(null); cancelRef.current = null;
      if (res.ok) {
        setDeep({ kind, key: runKey, res: res.research });
        const runs = res.research.study?.runs_total ?? timing.current.total, n = res.research.perf.sessions;
        if (runs > 0 && n > 0) setMsPerSession((performance.now() - timing.current.t0) / runs / n);
      }
      else setErr(res.error === 'cancelled' ? 'Stopped. Nothing was changed.' : res.error);
    });
  }, [research, strategy, params, extra, runKey]);

  if (!supported) {
    return (
      <div className="sheet sheet-pad stack" {...hard}>
        <h2 className="h3">Research</h2>
        <p className="small muted">{r.strategy === 'fourleg'
          ? 'Regimes, robustness and the optimisation lab cover the two intraday NIFTY strategies, which run through the account ledger. The four-leg stock model is synthetic monthly data with its own margin model.'
          : 'Regimes, robustness and the optimisation lab cover the straddle and the opening range breakout for now. This strategy is not wired into them yet.'}</p>
      </div>
    );
  }
  const stale = !!deep && deep.key !== runKey;
  // the latest check/study result when it belongs to this run (it carries everything); otherwise the quick analysis
  const a = deep && !stale ? deep.res : quick;
  const study = deep?.res.study ?? null;
  // after "Load", the settings differ from when the study ran, by exactly the study's selection
  const loaded = !!study && stale && study.selected.changed.length > 0 && study.selected.changed.every((c) => params[c.key] === c.to);
  const p = a?.perf;
  return (
    <section className="sheet rep-sheet rs" {...hard} aria-label="Research">
      <div className="chart-sheet-head">
        <span className="label">Research · from this run’s ledger</span>
        {busy ? <span className="status" data-state="running"><i />{busy === 'check' ? 'Checking' : 'Optimising'}</span> : a ? <span className="status" data-state="done"><i />{a.source === 'synthetic' ? 'Synthetic model' : 'Real data'}</span> : <span className="status" data-state="running"><i />Analysing</span>}
      </div>
      <div className="rep-body stack" style={{ ['--gap' as string]: '14px' }}>
        {p && (
          <div className="rs-sampleline" data-k={p.sample.key}>
            <SampleTag p={p} />
            <span className="small">{p.sample.key === 'none' || p.sample.key === 'thin'
              ? `${p.traded} traded day${p.traded === 1 ? '' : 's'} over ${p.sessions} session${p.sessions === 1 ? '' : 's'}. Too few for conclusions: read everything below as a demonstration of the method, not evidence.`
              : `${p.traded} traded days over ${p.sessions} sessions, ${p.from} to ${p.to}.`}</span>
          </div>
        )}
        <div className="tabs" role="tablist" aria-label="Research sections">
          {TABS.map(([k, label]) => <button key={k} type="button" role="tab" aria-selected={tab === k} className="tab tab--sm" onClick={() => setTab(k)}>{label}</button>)}
        </div>
        {err && <p className="error small" role="alert">{err}</p>}
        {stale && (tab === 'optimise' || tab === 'robustness') && <p className="rs-note small">{loaded
          ? 'The Lab is now running the study’s selected settings. The study below was run from your earlier settings; the robustness score and reading above now describe the selection on its own.'
          : `The settings or dates changed after the ${deep!.kind === 'check' ? 'robustness check' : 'study'} ran.${deep!.kind === 'optimise' ? ' The study below is for the earlier settings; run it again to refresh it.' : ' Run the check again for these settings.'}`}</p>}
        <div role="tabpanel">
          {!a && <p className="small muted">Analysing this run…</p>}
          {a && tab === 'reading' && <Reading a={a} />}
          {a && tab === 'regimes' && <Regimes a={a} mode={mode} setMode={setMode} />}
          {a && tab === 'robustness' && (
            <div className="stack" style={{ ['--gap' as string]: '14px' }}>
              <div className="rs-row">
                {busy === 'check' ? <Button onClick={() => cancelRef.current?.()}>Cancel</Button> : <Button onClick={() => start('check')} disabled={!!busy}>{a.check ? 'Run the robustness check again' : 'Run the robustness check'}</Button>}
                <span className="small muted">{busy === 'check' && progress ? `${progress.done} of about ${progress.total} backtests` : 'Reruns these settings one step either side of each value, under five cost scenarios and across thirds of the range. Changes nothing.'}</span>
              </div>
              <RobustnessView a={a} />
            </div>
          )}
          {a && tab === 'optimise' && (
            <div className="stack" style={{ ['--gap' as string]: '18px' }}>
              <OptimiseForm strategy={strategy} params={params} sessions={p?.sessions ?? 0} msPerRun={msPerSession != null ? msPerSession * (p?.sessions ?? 0) : msPerRun} measured={msPerSession != null} busy={busy === 'optimise'} progress={progress}
                onRun={(f) => start('optimise', f)} onCancel={() => cancelRef.current?.()} />
              {study && <StudyView s={study} stale={stale && !loaded} loaded={loaded} onLoad={onLoad} />}
            </div>
          )}
          {a && tab === 'diagnostics' && <Diagnostics a={a} />}
        </div>
      </div>
    </section>
  );
}
