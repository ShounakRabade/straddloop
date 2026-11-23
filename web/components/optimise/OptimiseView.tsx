'use client';
/**
 * The optimiser, in the Lab's main area: what to search, how to judge it, the limits, an estimate before anything
 * runs, the running study, and studies saved in this browser. Figures come only from the study's measurements.
 */
import { useEffect, useMemo, useState } from 'react';
import Study from '@/public/engine/study.js';
import { HARD_CAP, axesFor, estimate, rangeValues, type AxisDef, type AxisPick, type Estimate, type Value } from '@/lib/optimiser/space';
import { MB_PER_SESSION, autoWorkers, type Optimiser } from '@/lib/optimiser/useOptimiser';
import type { StudyConfig, StudyData, StudyRecord } from '@/lib/optimiser/store';
import { OBJECTIVES } from '@/lib/researchSpace';
import type { LabStrategy } from '@/lib/strategyRegistry';
import { toHM, toMin } from '@/lib/sessionTime';
import { shortDate } from '@/lib/format';
import type { Params } from '@/lib/types';
import { StudyResults } from './StudyResults';

type PickState = { on: boolean; min: string; max: string; step: string; chosen: Value[] };
const OBJ = OBJECTIVES.filter(([k]) => k !== 'custom');
const OBJ_NOTE: Record<string, string> = {
  cagr: 'CAGR exists only for windows of a year or more; shorter windows are not eligible, and the study says so.',
  min_dd: 'Ranks the shallowest drawdown first. A configuration that rarely trades has a small drawdown too, which is why a minimum of traded days applies.',
  win_rate: 'Win rate ignores how big the wins and losses are. Read it with the profit factor.',
  net: 'Net profit after every charge and slippage. Larger positions win this almost by construction.',
};

function initPicks(defs: AxisDef[]): Record<string, PickState> {
  return Object.fromEntries(defs.map((a) => {
    if ('values' in a.suggest) return [a.key, { on: a.on, min: '', max: '', step: '', chosen: a.suggest.values }];
    const t = a.kind === 'time';
    return [a.key, { on: a.on, min: t ? toHM(a.suggest.min) : String(a.suggest.min), max: t ? toHM(a.suggest.max) : String(a.suggest.max), step: String(a.suggest.step), chosen: [] }];
  }));
}
/** The values a ticked axis will try, or why it cannot. */
function valuesOf(a: AxisDef, st: PickState): { values: Value[]; error: string | null } {
  if (a.kind === 'choice') return st.chosen.length ? { values: (a.options ?? []).map((o) => o.value).filter((v) => st.chosen.includes(v)), error: null } : { values: [], error: 'Pick at least one option.' };
  const n = (x: string) => (a.kind === 'time' ? toMin(x) ?? NaN : x.trim() === '' ? NaN : Number(x));
  return rangeValues(a, n(st.min), n(st.max), Number(st.step));
}
const nowText = (a: AxisDef, base: Params): string => {
  const v = base[a.key];
  if (a.key === 'call_offset' || a.key === 'put_offset') return 'from the legs';
  if (v === undefined) return '—';
  if (a.kind === 'choice') return a.options?.find((o) => o.value === v)?.label ?? String(v);
  return `${v}${a.unit && a.kind === 'number' ? ` ${a.unit}` : ''}`;
};
const dur = (ms: number) => { const s = Math.round(ms / 1000); return s < 60 ? `${s} s` : s < 3600 ? `${Math.floor(s / 60)} min ${s % 60 ? `${s % 60} s` : ''}`.trim() : `${Math.floor(s / 3600)} h ${Math.round((s % 3600) / 60)} min`; };
const n0 = (x: number) => x.toLocaleString('en-IN');

export function OptimiseView({ strategy, params, real, series, data, dates, slip, brokerage, msPerRun, opt, onLoad, onClose }: {
  strategy: LabStrategy; params: Params; real: boolean; series: 'WEEK' | 'MONTH';
  /** the Lab's current data (null: not ready); `dates` its session dates when known (real data) */
  data: StudyData | null; dates: string[] | null; slip: number; brokerage: number;
  /** the latest backtest's time on this data (an upper bound per configuration), if there is one */
  msPerRun: number | null;
  opt: Optimiser;
  onLoad: (cfg: StudyConfig, id: number, run: boolean) => void;
  onClose: () => void;
}) {
  const defs = useMemo(() => axesFor(strategy, params), [strategy, params]);
  const [picks, setPicks] = useState<Record<string, PickState>>(() => initPicks(defs));
  // a new strategy (or new builder legs) brings its own axes
  const axisSig = defs.map((d) => d.key + d.label).join('|');
  useEffect(() => { setPicks(initPicks(defs)); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [strategy.slug, axisSig]);
  const [objective, setObjective] = useState('sharpe');
  const [minTrades, setMinTrades] = useState('');
  const [topK, setTopK] = useState(10);
  const [split, setSplit] = useState({ train: 60, validation: 20, test: 20 });
  const [folds, setFolds] = useState(4);
  const [wfMode, setWfMode] = useState<'rolling' | 'anchored'>('rolling');
  const [max, setMax] = useState(1000);
  const [method, setMethod] = useState<'auto' | 'grid' | 'random'>('auto');
  const [seed, setSeed] = useState(1);
  const [workersPick, setWorkersPick] = useState<'auto' | number>('auto');
  const [zeroSlipOk, setZeroSlipOk] = useState(false);
  const [tab, setTab] = useState<'setup' | 'saved'>('setup');

  const parsed = defs.map((a) => ({ a, st: picks[a.key], ...(picks[a.key] ? valuesOf(a, picks[a.key]) : { values: [], error: null }) }));
  const on = parsed.filter((x) => x.st?.on);
  const errors = on.filter((x) => x.error).map((x) => `${x.a.label}: ${x.error}`);
  const chosen: AxisPick[] = on.filter((x) => !x.error).map((x) => ({ key: x.a.key, values: x.values }));
  const sessions = data?.sessions ?? 0;
  const cores = typeof navigator !== 'undefined' ? navigator.hardwareConcurrency || 2 : 2;
  const workers = workersPick === 'auto' ? autoWorkers(sessions, cores) : workersPick;
  const splitOk = split.train >= 30 && split.validation >= 10 && split.test >= 10 && split.train + split.validation + split.test === 100;
  const plan = useMemo(() => (sessions ? Study.studyPlan(dates && dates.length === sessions ? dates : Array.from({ length: sessions }, () => ''), { split: { train: split.train / 100, validation: split.validation / 100, test: split.test / 100 }, folds, wfMode }) : null),
    [sessions, dates, split, folds, wfMode]);
  const trainN = plan ? plan.split.train[1] - plan.split.train[0] : 0;
  const autoMin = Math.max(3, Math.round(0.1 * trainN));
  const minT = minTrades.trim() === '' ? null : Math.max(0, Math.round(Number(minTrades)));

  // the estimate, recomputed a moment after the settings stop changing (it checks every configuration's rules)
  const [est, setEst] = useState<{ e: Estimate | null; error: string | null; sig: string } | null>(null);
  const sig = JSON.stringify([strategy.slug, chosen, method, max, seed, topK, real, series, params]);
  useEffect(() => {
    if (errors.length || !chosen.length) { setEst(null); return; }
    const t = setTimeout(() => {
      try { setEst({ e: estimate(strategy, params, defs, chosen, { method, max, seed, topK, real, series }), error: null, sig }); }
      catch (e) { setEst({ e: null, error: (e as Error).message, sig }); }
    }, 250);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sig, errors.length]);
  const e = est && est.sig === sig ? est.e : null;

  const needsOverride = real && slip === 0;
  const blockers = [
    !strategy.optimise.ok ? strategy.optimise.why : null,
    !data ? (real ? 'Choose a period with stored days first (Data & period, or the range bar above).' : 'The synthetic model is not ready.') : null,
    !chosen.length && !errors.length ? 'Tick at least one setting to search.' : null,
    ...errors,
    !splitOk ? 'The split must add up to 100%, with at least 30% training and 10% each for validation and the held-out test.' : null,
    est?.sig === sig && est.error ? est.error : null,
    e && e.valid <= 1 ? 'Only your current settings can run: every other configuration is refused (reasons below).' : null,
    needsOverride && !zeroSlipOk ? 'Zero slippage on real candles: tick the override below, or set slippage in Capital & execution.' : null,
    opt.running ? 'A study is already running.' : null,
  ].filter((x): x is string => !!x);

  function startStudy() {
    if (blockers.length || !data || !e) return;
    const cfg: StudyConfig = {
      slug: strategy.slug, name: `${strategy.short} · ${OBJ.find(([k]) => k === objective)?.[1] ?? objective}`, base: params, picks: chosen,
      objective, weights: null, minTrades: minT, topK,
      split: { train: split.train / 100, validation: split.validation / 100, test: split.test / 100 }, folds, wfMode,
      method, max, seed, workers, real, series, data, capital: Number(params.capital) || 500000,
    };
    opt.start(cfg);
  }

  const setPick = (key: string, patch: Partial<PickState>) => setPicks((p) => ({ ...p, [key]: { ...p[key], ...patch } }));
  const perWorker = sessions * MB_PER_SESSION;

  if (!strategy.optimise.ok) {
    return (
      <div className="ws-empty">
        <span className="lbl">Optimise</span>
        <h2>{strategy.name} is not searched</h2>
        <p>{strategy.optimise.why}</p>
        <div className="run-actions"><button type="button" className="qbtn" onClick={onClose}>Back to the results</button></div>
      </div>
    );
  }

  return (
    <div className="opt" aria-busy={!!opt.running}>
      <div className="run-head">
        <div style={{ minWidth: 0 }}>
          <span className="lbl">Optimise</span>
          <h1>{strategy.name}</h1>
          <div className="run-ctx">
            <span>{data ? <>{data.label}{data.from ? <> · <b>{shortDate(data.from)} – {shortDate(data.to!)}</b></> : null} · {data.sessions} sessions</> : 'No data chosen yet'}</span>
            <span>Charges and slippage as set in the Lab: slip {slip}% · ₹{brokerage}/order</span>
          </div>
        </div>
        <div className="run-actions">
          <div className="seg2 opt-tabs" role="tablist" aria-label="Optimiser">
            <button type="button" role="tab" aria-selected={tab === 'setup'} onClick={() => setTab('setup')}>Study</button>
            <button type="button" role="tab" aria-selected={tab === 'saved'} onClick={() => { setTab('saved'); opt.refresh(); }}>Saved{opt.studies?.length ? ` (${opt.studies.length})` : ''}</button>
          </div>
          <button type="button" className="qbtn" onClick={onClose}>Back to the results</button>
        </div>
      </div>

      {!opt.persistent && <div className="stale" role="status"><span>This browser blocks storage, so studies last only until this tab closes.</span></div>}
      {opt.error && <div className="opt-err" role="alert"><span className="sec-err">The study stopped: {opt.error}</span> <button type="button" className="qlink" onClick={() => opt.setError(null)}>Dismiss</button></div>}

      {opt.running && <RunningStudy opt={opt} />}

      {tab === 'saved' ? <SavedStudies opt={opt} onOpen={(id) => { opt.open(id); setTab('setup'); }} onResume={(id) => { opt.resume(id); setTab('setup'); }} />
        : opt.opened && !opt.running ? (
          <>
            <StudyResults opened={opt.opened} opt={opt} onLoad={onLoad} />
            <div className="run-actions opt-again"><button type="button" className="qbtn" onClick={() => opt.setOpened(null)}>Set up another study</button></div>
          </>
        ) : !opt.running && (
          <div className="opt-setup">
            <section className="blk" aria-labelledby="opt-axes-h">
              <div className="blk-h"><h2 id="opt-axes-h">What to search</h2><span className="sec-note">{on.length} of {defs.length} settings ticked</span></div>
              <p className="chart-cap">Tick a setting and give the range to try. Everything not ticked stays as it is in the Lab, and your current settings are always measured too, as configuration 0. Charges and slippage are never searched: they are assumptions, so the finalists are re-run at doubled slippage instead.</p>
              <div className="tscroll">
                <table className="tbl opt-axes">
                  <thead><tr><th>Search</th><th>Setting</th><th>From</th><th>To</th><th>Step</th><th className="r">Values</th><th>Now</th></tr></thead>
                  <tbody>
                    {parsed.map(({ a, st, values, error }) => st && (
                      <tr key={a.key} data-on={st.on || undefined}>
                        <td><input type="checkbox" checked={st.on} onChange={(ev) => setPick(a.key, { on: ev.target.checked })} aria-label={`Search ${a.label}`} /></td>
                        <td className="t"><b>{a.label}</b>{a.note && <div className="f-meta">{a.note}</div>}{st.on && error && <div className="sec-err">{error}</div>}</td>
                        {a.kind === 'choice' ? (
                          <td colSpan={3}>
                            <div className="opt-chips" role="group" aria-label={`${a.label} options`}>
                              {(a.options ?? []).map((o) => {
                                const sel = st.chosen.includes(o.value);
                                return <button key={String(o.value)} type="button" className="qbtn" aria-pressed={sel} disabled={!st.on}
                                  onClick={() => setPick(a.key, { chosen: sel ? st.chosen.filter((v) => v !== o.value) : [...st.chosen, o.value] })}>{o.label}</button>;
                              })}
                            </div>
                          </td>
                        ) : (['min', 'max', 'step'] as const).map((k) => (
                          <td key={k}><input className="in opt-in" inputMode={a.kind === 'time' && k !== 'step' ? 'numeric' : 'decimal'} disabled={!st.on} value={st[k]} aria-label={`${a.label} ${k === 'min' ? 'from' : k === 'max' ? 'to' : 'step'}${a.kind === 'time' && k === 'step' ? ' (minutes)' : ''}`}
                            aria-invalid={st.on && !!error} placeholder={a.kind === 'time' ? (k === 'step' ? 'min' : 'HH:MM') : undefined} onChange={(ev) => setPick(a.key, { [k]: ev.target.value })} />
                            {k === 'step' && a.kind === 'time' && <span className="f-meta"> min</span>}</td>
                        ))}
                        <td className="r">{st.on && !error ? values.length : '—'}</td>
                        <td>{nowText(a, params)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>

            <div className="opt-cols">
              <section className="blk" aria-labelledby="opt-judge-h">
                <div className="blk-h"><h2 id="opt-judge-h">How to judge</h2></div>
                <div className="f">
                  <div className="f-top"><label className="f-label" htmlFor="opt-obj">Rank by</label></div>
                  <select id="opt-obj" className="in" value={objective} onChange={(ev) => setObjective(ev.target.value)}>
                    {OBJ.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
                  </select>
                  {OBJ_NOTE[objective] && <div className="f-meta">{OBJ_NOTE[objective]}</div>}
                </div>
                <div className="f">
                  <div className="f-top"><label className="f-label" htmlFor="opt-min">Minimum traded days (training window)</label></div>
                  <input id="opt-min" className="in" inputMode="numeric" placeholder={`Automatic: ${autoMin}`} value={minTrades} onChange={(ev) => setMinTrades(ev.target.value.replace(/[^0-9]/g, ''))} />
                  <div className="f-meta">A configuration with fewer traded days is not eligible to win: a handful of lucky days is not a result. Automatic is 10% of the training sessions, at least 3; validation and the full in-sample part scale with their length.</div>
                </div>
                <div className="f">
                  <div className="f-top"><label className="f-label" htmlFor="opt-k">Finalists</label></div>
                  <input id="opt-k" className="in" type="number" min={3} max={20} value={topK} onChange={(ev) => setTopK(Math.max(3, Math.min(20, Math.round(Number(ev.target.value) || 10))))} />
                  <div className="f-meta">The best out-of-sample answer is chosen among the top {topK} by training; the most robust among the top {topK} by in-sample score, each re-run one step either side on every ordered setting and at doubled slippage.</div>
                </div>
              </section>

              <section className="blk" aria-labelledby="opt-val-h">
                <div className="blk-h"><h2 id="opt-val-h">Validation</h2></div>
                <div className="opt-split" role="group" aria-label="Chronological split, percent of sessions">
                  {(['train', 'validation', 'test'] as const).map((k) => (
                    <label key={k} className="f"><span className="f-label">{k === 'train' ? 'Training %' : k === 'validation' ? 'Validation %' : 'Held-out test %'}</span>
                      <input className="in" type="number" min={10} max={80} value={split[k]} aria-invalid={!splitOk} onChange={(ev) => setSplit((s) => ({ ...s, [k]: Math.round(Number(ev.target.value) || 0) }))} /></label>
                  ))}
                </div>
                {plan && (
                  <ol className="opt-windows">
                    {(['train', 'validation', 'test'] as const).map((k) => {
                      const [a, b] = plan.split[k] as number[], d = plan.dates[k] as (string | null)[];
                      return <li key={k} data-k={k}><b>{k === 'train' ? 'Training' : k === 'validation' ? 'Validation' : 'Held-out test'}</b> {b - a} sessions{d[0] ? ` · ${shortDate(d[0])} – ${shortDate(d[1]!)}` : ''}{k === 'test' ? ' · measured, never used to choose' : ''}</li>;
                    })}
                  </ol>
                )}
                <div className="opt-split">
                  <label className="f"><span className="f-label">Walk-forward folds</span>
                    <input className="in" type="number" min={2} max={8} value={folds} onChange={(ev) => setFolds(Math.max(2, Math.min(8, Math.round(Number(ev.target.value) || 4))))} /></label>
                  <label className="f"><span className="f-label">Training per fold</span>
                    <select className="in" value={wfMode} onChange={(ev) => setWfMode(ev.target.value as 'rolling' | 'anchored')}><option value="rolling">Rolling</option><option value="anchored">Anchored</option></select></label>
                </div>
                <div className="f-meta">{plan?.wfReason ? `Walk-forward will not run: ${plan.wfReason}.` : `Inside training + validation: each of ${folds} folds re-chooses on its own training sessions (${wfMode === 'rolling' ? 'the same number each time' : 'everything before the block'}) and is scored on the next, unseen block.`}</div>
              </section>

              <section className="blk" aria-labelledby="opt-lim-h">
                <div className="blk-h"><h2 id="opt-lim-h">Limits</h2></div>
                <div className="opt-split">
                  <label className="f"><span className="f-label">Most configurations</span>
                    <input className="in" type="number" min={1} max={HARD_CAP} value={max} onChange={(ev) => setMax(Math.max(1, Math.min(HARD_CAP, Math.round(Number(ev.target.value) || 1))))} /></label>
                  <label className="f"><span className="f-label">Search</span>
                    <select className="in" value={method} onChange={(ev) => setMethod(ev.target.value as typeof method)}>
                      <option value="auto">Grid, else sample</option><option value="grid">Whole grid only</option><option value="random">Random sample</option>
                    </select></label>
                </div>
                <div className="opt-split">
                  <label className="f"><span className="f-label">Sample seed</span>
                    <input className="in" type="number" min={1} value={seed} onChange={(ev) => setSeed(Math.max(1, Math.round(Number(ev.target.value) || 1)))} /></label>
                  <label className="f"><span className="f-label">Workers</span>
                    <select className="in" value={String(workersPick)} onChange={(ev) => setWorkersPick(ev.target.value === 'auto' ? 'auto' : Number(ev.target.value))}>
                      <option value="auto">Automatic ({autoWorkers(sessions, cores)})</option>{[1, 2, 3, 4].map((k) => <option key={k} value={k}>{k}</option>)}
                    </select></label>
                </div>
                <div className="f-meta">“Grid, else sample” runs the whole grid when it fits the limit, otherwise a seeded random sample of it. At most {n0(HARD_CAP)} configurations. Each worker holds its own copy of the sessions, about {Math.round(perWorker)} MB here; automatic keeps the workers under {600} MB together and leaves a core free.</div>
                {needsOverride && (
                  <label className="opt-override"><input type="checkbox" checked={zeroSlipOk} onChange={(ev) => setZeroSlipOk(ev.target.checked)} />
                    <span>Run with zero slippage anyway. Real candles have no bid/ask, so every fill would be at the candle price and the results will be optimistic.</span></label>
                )}
              </section>
            </div>

            <section className="blk" aria-labelledby="opt-est-h" aria-live="polite">
              <div className="blk-h"><h2 id="opt-est-h">Before it runs</h2>{e && <span className="sec-note">{e.exact ? 'Counted exactly' : 'Refusals estimated from a sample of 1,000'}</span>}</div>
              {e ? (
                <>
                  <div className="figs">
                    <div className="m"><span className="lbl">Grid</span><span className="m-v">{n0(e.size)}</span><span className="m-s">{chosen.map((c) => c.values.length).join(' × ')} values</span></div>
                    <div className="m"><span className="lbl">Will try</span><span className="m-v">{n0(e.planned)}</span><span className="m-s">{e.method === 'grid' ? 'the whole grid' : `a seeded random sample (seed ${seed})`} + your settings</span></div>
                    <div className="m"><span className="lbl">Can run</span><span className="m-v">{n0(e.valid)}</span><span className="m-s">{e.planned - e.valid ? `${n0(e.planned - e.valid)} refused before running` : 'none refused'}</span></div>
                    <div className="m"><span className="lbl">Robustness runs</span><span className="m-v">{n0(e.extra)}</span><span className="m-s">at most; fewer when neighbours were already measured</span></div>
                    <div className="m"><span className="lbl">Memory</span><span className="m-v">{Math.round(perWorker * workers)} MB</span><span className="m-s">{workers} worker{workers === 1 ? '' : 's'} × {Math.round(perWorker)} MB, beside the Lab’s own copy</span></div>
                    <div className="m"><span className="lbl">Time</span><span className="m-v">{msPerRun ? `≤ ${dur((e.runs * msPerRun) / workers)}` : 'measured live'}</span>
                      <span className="m-s">{msPerRun ? `at your last backtest’s ${(msPerRun / 1000).toFixed(2)} s a run; study runs skip the replay detail, so usually less` : 'the rate shows once 10 configurations have finished'}</span></div>
                  </div>
                  {e.refused.length > 0 && <ul className="opt-refused">{e.refused.map((r) => <li key={r.reason}><b className="num">{n0(r.n)}</b> {r.reason}</li>)}</ul>}
                </>
              ) : <p className="sec-note">{errors.length || !chosen.length ? 'The estimate appears once the ranges are valid.' : 'Counting…'}</p>}
              {blockers.length > 0 && <ul className="opt-block">{blockers.map((b) => <li key={b}>{b}</li>)}</ul>}
              <div className="run-actions">
                <button type="button" className="run-btn run-btn--inline" disabled={blockers.length > 0 || !e} onClick={startStudy}>Start the study</button>
                <span className="sec-note">Nothing about the Lab changes while it runs. Results are saved in this browser as they arrive; a cancelled study can be resumed.</span>
              </div>
            </section>
          </div>
        )}
    </div>
  );
}

const STAGE: Record<string, string> = {
  loading: 'Loading the sessions into the optimiser', searching: 'Measuring configurations', robustness: 'Robustness runs: neighbours and doubled slippage',
  analysing: 'Choosing the answers', done: 'Done', cancelled: 'Cancelled', error: 'Stopped',
};
function RunningStudy({ opt }: { opt: Optimiser }) {
  const p = opt.progress, dl = opt.download, cfg = opt.running!;
  const total = dl ? dl.total : p?.total ?? 0, done = dl ? dl.done : p?.done ?? 0;
  return (
    <section className="blk opt-run" aria-live="polite" aria-labelledby="opt-run-h">
      <div className="blk-h">
        <h2 id="opt-run-h">{dl ? `Downloading day files, ${done} of ${total}` : p ? STAGE[p.stage] : 'Starting'}</h2>
        <button type="button" className="qbtn" onClick={opt.cancel}>Cancel, keep what is measured</button>
      </div>
      <p className="sec-note">{cfg.name} · {cfg.data.label} · {cfg.data.sessions} sessions · {cfg.workers} worker{cfg.workers === 1 ? '' : 's'}</p>
      {total > 0 ? (
        <div className="progress" role="progressbar" aria-valuemin={0} aria-valuemax={total} aria-valuenow={done} aria-label="Study progress"><i style={{ width: `${(100 * done) / total}%` }} /></div>
      ) : <div className="progress" data-indeterminate role="progressbar" aria-label="Study progress"><i /></div>}
      {p && !dl && (
        <p className="num opt-rate">
          {total > 0 && <span>{n0(done)} of {n0(total)}</span>}
          {p.rate != null && <span>{p.rate.toFixed(1)} a second</span>}
          {p.etaMs != null && <span>about {dur(p.etaMs)} left at that rate</span>}
          {p.refused > 0 && <span>{n0(p.refused)} refused</span>}
          {p.failed > 0 && <span className="loss">{n0(p.failed)} failed</span>}
        </p>
      )}
    </section>
  );
}

function SavedStudies({ opt, onOpen, onResume }: { opt: Optimiser; onOpen: (id: string) => void; onResume: (id: string) => void }) {
  const list = opt.studies;
  if (!list) return <p className="sec-note">Reading the saved studies…</p>;
  if (!list.length) return <div className="plot-empty">No studies saved in this browser yet.</div>;
  const when = (iso: string) => new Date(iso).toLocaleString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  const st = (s: StudyRecord) => ({ running: 'Running', cancelled: 'Cancelled', done: 'Finished', error: 'Stopped' }[s.status]);
  return (
    <section className="blk" aria-labelledby="opt-saved-h">
      <div className="blk-h"><h2 id="opt-saved-h">Saved in this browser</h2><span className="sec-note">Studies stay on this device; nothing is uploaded.</span></div>
      <div className="tscroll">
        <table className="tbl">
          <thead><tr><th>Started</th><th>Study</th><th>Data</th><th>Status</th><th className="r">Measured</th><th aria-label="Actions" /></tr></thead>
          <tbody>
            {list.map((s) => (
              <tr key={s.id}>
                <td>{when(s.created)}</td>
                <td className="t">{s.config.name}</td>
                <td className="t">{s.config.data.label}{s.config.data.from ? ` · ${shortDate(s.config.data.from)} – ${shortDate(s.config.data.to!)}` : ''} · {s.config.data.sessions} sessions</td>
                <td>{st(s)}{s.error ? <div className="sec-err">{s.error}</div> : null}</td>
                <td className="r">{n0(s.counts.evaluated)} / {n0(s.counts.planned)}{s.counts.extra ? <div className="f-meta">+ {n0(s.counts.extra)} robustness runs</div> : null}</td>
                <td>
                  <div className="run-actions">
                    {s.status === 'done' && <button type="button" className="qlink" onClick={() => onOpen(s.id)}>Open</button>}
                    {(s.status === 'cancelled' || s.status === 'error' || s.status === 'running') && <button type="button" className="qlink" disabled={!!opt.running} onClick={() => onResume(s.id)}>Resume</button>}
                    <button type="button" className="qlink" disabled={!!opt.running && s.status === 'running'} onClick={() => { if (window.confirm('Delete this study and its measurements from this browser?')) opt.remove(s.id); }}>Delete</button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
