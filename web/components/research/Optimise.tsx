'use client';
import { useMemo, useState } from 'react';
import { Button } from '@/components/ui';
import type { Axis, ResearchProgress, Study } from '@/lib/research';
import { CUSTOM_KEYS, ENGINE_DEFAULTS, OBJECTIVES, PARAM_SPACE, choiceLabel, parseValues } from '@/lib/researchSpace';
import { maxOf, minOf } from '@/lib/stats';
import type { Params } from '@/lib/types';
import { Histogram, Money, PERF_HEAD, PerfCells, Scroll, money, nm, pc } from './bits';
import { McView } from './Views';

type Row = { on: boolean; text: string };
export type StudyForm = { axes: Axis[]; options: Record<string, unknown> };

const current = (k: string, params: Params) => (params[k] !== undefined ? params[k] : ENGINE_DEFAULTS[k]);

export function OptimiseForm({ strategy, params, sessions, msPerRun, measured = false, busy, progress, onRun, onCancel }: {
  strategy: 'straddle' | 'orb'; params: Params; sessions: number; msPerRun: number; measured?: boolean; busy: boolean; progress: ResearchProgress | null;
  onRun: (f: StudyForm) => void; onCancel: () => void;
}) {
  const space = PARAM_SPACE[strategy];
  const [rows, setRows] = useState<Record<string, Row>>(() => Object.fromEntries(space.map((p, i) => {
    const cur = current(p.key, params);
    const vals = p.kind === 'choice' ? p.options ?? [] : Array.from(new Set([...(p.sweep ?? []), cur as number])).sort((a, b) => Number(a) - Number(b));
    return [p.key, { on: i < 2, text: vals.map(choiceLabel).join(', ') }];
  })));
  const [objective, setObjective] = useState('sharpe');
  const [weights, setWeights] = useState<Record<string, number>>({ sharpe: 1, net: 1, min_dd: 1 });
  const [method, setMethod] = useState<'auto' | 'grid' | 'random'>('auto');
  const [budget, setBudget] = useState(200);
  const [split, setSplit] = useState({ train: 60, validation: 20, test: 20 });
  const [wfMode, setWfMode] = useState<'rolling' | 'anchored'>('rolling');
  const [wfTrain, setWfTrain] = useState('');
  const [wfTest, setWfTest] = useState('');
  const [minTrades, setMinTrades] = useState('');

  const parsed = useMemo(() => space.map((p) => ({ p, row: rows[p.key], ...parseValues(p, rows[p.key].text) })), [space, rows]);
  const on = parsed.filter((x) => x.row.on);
  const errors = on.flatMap((x) => x.errors.map((e) => `${x.p.label}: ${e}`)).concat(on.filter((x) => !x.values.length).map((x) => `${x.p.label}: no values`));
  const size = on.reduce((a, x) => a * Math.max(1, x.values.length), 1);
  const evals = Math.min(size, method === 'random' ? budget : method === 'grid' ? size : Math.min(size, budget));
  const extra = on.length * 4 + 24;
  const secs = ((evals + extra) * msPerRun) / 1000;
  const splitOk = split.train >= 20 && split.validation >= 5 && split.test >= 5 && split.train + split.validation + split.test === 100;
  const gridTooBig = method === 'grid' && size > budget;
  const valid = on.length > 0 && !errors.length && splitOk && !gridTooBig && (objective !== 'custom' || Object.values(weights).some((w) => w > 0));

  function submit() {
    if (!valid) return;
    onRun({
      axes: on.map((x) => ({ key: x.p.key, label: x.p.label, values: x.values })),
      options: { objective, weights: objective === 'custom' ? weights : undefined, method, budget, split: { train: split.train, validation: split.validation, test: split.test },
        wf: { mode: wfMode, train: Number(wfTrain) || null, test: Number(wfTest) || null }, minTrades: minTrades === '' ? null : Number(minTrades) },
    });
  }

  return (
    <form className="stack rs-form" style={{ ['--gap' as string]: '14px' }} onSubmit={(e) => { e.preventDefault(); submit(); }} aria-label="Optimisation study settings">
      <fieldset className="stack" style={{ ['--gap' as string]: '6px' }}>
        <legend className="rep-h">Parameters to search</legend>
        <p className="small muted">Tick a setting and list the values to try, separated by commas. Your current value is included. Slippage, brokerage and capital are assumptions, so they are never searched (they are stress-tested instead).</p>
        <div className="rs-params">
          {parsed.map(({ p, row, errors: e }) => (
            <div key={p.key} className="rs-param" data-on={row.on ? '' : undefined}>
              <label className="rs-check"><input type="checkbox" checked={row.on} onChange={(ev) => setRows((r) => ({ ...r, [p.key]: { ...r[p.key], on: ev.target.checked } }))} />
                <span>{p.label}{p.engine && <span className="rs-sub"> · no field in the settings panel</span>}</span></label>
              <input className="input input--sm" aria-label={`${p.label} values`} disabled={!row.on} value={row.text} onChange={(ev) => setRows((r) => ({ ...r, [p.key]: { ...r[p.key], text: ev.target.value } }))} />
              <span className="rs-sub">now {choiceLabel(current(p.key, params))}{p.kind === 'range' ? ` · allowed ${p.min} to ${p.max}${p.unit ?? ''}` : ` · options ${(p.options ?? []).map(choiceLabel).join(', ')}`}</span>
              {row.on && e.map((x) => <span key={x} className="error small">{x}</span>)}
            </div>
          ))}
        </div>
      </fieldset>

      <div className="rs-grid2">
        <label className="field"><span className="flabel small">Rank configurations by</span>
          <select className="input input--sm" value={objective} onChange={(e) => setObjective(e.target.value)}>
            {OBJECTIVES.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
          </select></label>
        <label className="field"><span className="flabel small">Search</span>
          <select className="input input--sm" value={method} onChange={(e) => setMethod(e.target.value as 'auto' | 'grid' | 'random')}>
            <option value="auto">Grid if it fits the budget, else random</option><option value="grid">Grid (every combination)</option><option value="random">Random sample of the grid</option>
          </select></label>
        <label className="field"><span className="flabel small">Budget (backtests)</span>
          <input className="input input--sm" type="number" min={5} max={2000} value={budget} onChange={(e) => setBudget(Math.max(5, Math.min(2000, Number(e.target.value) || 5)))} /></label>
        <label className="field"><span className="flabel small">Minimum traded days in training</span>
          <input className="input input--sm" type="number" min={1} placeholder="auto (10%, at least 3)" value={minTrades} onChange={(e) => setMinTrades(e.target.value)} /></label>
      </div>
      {objective === 'custom' && (
        <fieldset className="rs-weights"><legend className="small">Weights (each configuration is scored by the weighted mean of its percentile rank on each metric)</legend>
          {CUSTOM_KEYS.map(([k, l]) => <label key={k} className="small">{l} <input className="input input--sm" type="number" min={0} max={5} step={1} value={weights[k] ?? 0} onChange={(e) => setWeights((w) => ({ ...w, [k]: Math.max(0, Number(e.target.value) || 0) }))} /></label>)}
        </fieldset>
      )}
      <div className="rs-grid2">
        <fieldset className="field"><legend className="flabel small">Chronological split, % of sessions</legend>
          <div className="rs-split">
            {(['train', 'validation', 'test'] as const).map((k) => <label key={k} className="small">{k === 'train' ? 'Training' : k === 'validation' ? 'Validation' : 'Held-out test'} <input className="input input--sm" type="number" min={5} max={90} value={split[k]} onChange={(e) => setSplit((s) => ({ ...s, [k]: Math.round(Number(e.target.value) || 0) }))} /></label>)}
          </div>
          {!splitOk && <span className="error small">The three must add to 100, with training ≥ 20 and the others ≥ 5.</span>}
          <span className="rs-sub">≈ {Math.round((sessions * split.train) / 100)} / {Math.round((sessions * split.validation) / 100)} / {sessions - Math.round((sessions * split.train) / 100) - Math.round((sessions * split.validation) / 100)} sessions</span>
        </fieldset>
        <fieldset className="field"><legend className="flabel small">Walk-forward</legend>
          <div className="seg" role="radiogroup" aria-label="Walk-forward windows">
            <label><input type="radio" name="wfm" checked={wfMode === 'rolling'} onChange={() => setWfMode('rolling')} /><span>Rolling</span></label>
            <label><input type="radio" name="wfm" checked={wfMode === 'anchored'} onChange={() => setWfMode('anchored')} /><span>Anchored</span></label>
          </div>
          <div className="rs-split">
            <label className="small">Train sessions <input className="input input--sm" type="number" min={5} placeholder={`auto ${Math.max(5, Math.round(sessions * 0.5))}`} value={wfTrain} onChange={(e) => setWfTrain(e.target.value)} /></label>
            <label className="small">Test sessions <input className="input input--sm" type="number" min={1} placeholder={`auto ${Math.max(2, Math.round(sessions * 0.125))}`} value={wfTest} onChange={(e) => setWfTest(e.target.value)} /></label>
          </div>
        </fieldset>
      </div>
      {errors.map((e) => <p key={e} className="error small" role="alert">{e}</p>)}
      {gridTooBig && <p className="error small" role="alert">The grid has {size.toLocaleString('en-IN')} combinations, more than the budget. Narrow the values, raise the budget or use random search.</p>}
      <div className="rs-row">
        {busy ? <Button onClick={onCancel}>Cancel</Button> : <Button variant="primary" onClick={submit} disabled={!valid}>Run the study</Button>}
        <span className="small muted">{on.length ? `${size.toLocaleString('en-IN')} combination${size === 1 ? '' : 's'} · ${evals} to test + about ${extra} for sensitivity and cost stress · ${measured ? 'roughly' : 'at most about'} ${secs < 1 ? 'a second' : secs < 90 ? `${Math.ceil(secs)} s` : `${Math.ceil(secs / 60)} min`}${measured ? '' : ' (from the Lab run’s time; the first check or study measures it)'}` : 'Tick at least one setting.'}</span>
      </div>
      {busy && progress && (
        <div className="rs-progress" role="progressbar" aria-valuemin={0} aria-valuemax={progress.total} aria-valuenow={progress.done} aria-label="Study progress">
          <span className="rs-track"><i style={{ width: `${Math.min(100, (100 * progress.done) / Math.max(1, progress.total))}%` }} /></span><span className="small mono">{progress.stage} · {progress.done} of about {progress.total}</span>
        </div>
      )}
    </form>
  );
}

const fmtParam = (k: string, v: unknown) => `${PARAM_SPACE.straddle.concat(PARAM_SPACE.orb).find((p) => p.key === k)?.label ?? k} ${choiceLabel(v)}`;

export function StudyView({ s, onLoad, stale, loaded = false }: { s: Study; onLoad: (changes: Record<string, unknown>) => void; stale: boolean; loaded?: boolean }) {
  const sel = s.selected, org = s.original;
  const changes = Object.fromEntries(sel.changed.map((c) => [c.key, c.to]));
  const nets = s.distribution.map((d) => d.net), lo = minOf(nets), hi = maxOf(nets);
  const bins = 20, counts = new Array(bins).fill(0);
  nets.forEach((v) => { counts[Math.min(bins - 1, Math.floor(hi > lo ? ((v - lo) / (hi - lo)) * bins : 0))]++; });
  const wf = s.walk_forward;
  return (
    <div className="stack" style={{ ['--gap' as string]: '18px' }}>
      <p className="small">{s.configs_tested} configurations by {s.method} search ({s.space_size.toLocaleString('en-IN')} possible), {s.runs_total} backtests in {(s.ms / 1000).toFixed(1)} s, ranked by {s.objective_label}. Minimum {s.min_trades} traded days in training. Selection: {s.selection_rule}.</p>
      <div className="stack" style={{ ['--gap' as string]: '8px' }}>
        <h3 className="rep-h">Selected vs your settings</h3>
        <Scroll label="Selected vs original">
          <table className="ptable legs rs-table">
            <thead><tr><th>Window</th><th>Settings</th>{PERF_HEAD}</tr></thead>
            <tbody>
              {([['Training', 'train', s.split.train], ['Validation', 'validation', s.split.validation], ['Held-out test', 'test', s.split.test], ['Whole range', 'full', null]] as const).flatMap(([name, k, w]) => [
                <tr key={`${k}-s`}><th scope="row" rowSpan={2}>{name}{w && <div className="rs-sub">{w[0]} to {w[1]} · {w[2]} sessions</div>}</th><td>Selected</td><PerfCells p={sel[k]} /></tr>,
                <tr key={`${k}-o`}><td>Yours</td><PerfCells p={org[k]} /></tr>,
              ])}
            </tbody>
          </table>
        </Scroll>
        <p className="small">{sel.changed.length ? <>Selected changes: {sel.changed.map((c) => `${fmtParam(c.key, c.from)} → ${choiceLabel(c.to)}`).join('; ')}.</> : 'The selected configuration is your own settings.'}</p>
        {sel.changed.length > 0 && (
          <div className="rs-apply">
            <Button variant="primary" onClick={() => onLoad(changes)} disabled={stale || loaded}>{loaded ? 'Loaded into the Lab' : 'Load the selected settings into the Lab'}</Button>
            <p className="small muted">{loaded ? 'Loaded. Use “Put my settings back” in the settings panel to undo. Saving to the notebook is still a separate step.' : stale ? 'Your settings or dates changed since this study ran. Run it again before loading.' : 'Nothing changes until you press this. The Lab then reruns; saving to the notebook stays a separate step, and you can put your settings back.'}</p>
          </div>
        )}
      </div>

      <div className="stack" style={{ ['--gap' as string]: '8px' }}>
        <h3 className="rep-h">Top {s.top.length} by training score</h3>
        <Scroll label="Top configurations">
          <table className="ptable legs rs-table">
            <thead><tr><th className="r">#</th><th>Changes from yours</th><th className="r">Train score</th><th className="r">Val. score</th><th className="r">Train net</th><th className="r">Val. net</th><th className="r">Val. traded</th></tr></thead>
            <tbody>
              {s.top.map((t) => (
                <tr key={t.idx} data-base={t.idx === sel.idx ? '' : undefined}>
                  <td className="r">{t.rank}</td>
                  <td>{t.changed.length ? t.changed.map((c) => fmtParam(c.key, c.to)).join(' · ') : 'your settings'}{t.idx === sel.idx ? ' (selected)' : ''}{!t.eligible ? ' · too few trades' : ''}</td>
                  <td className="r">{isFinite(t.score_train) ? nm(t.score_train) : '—'}</td><td className="r">{isFinite(t.score_val) ? nm(t.score_val) : '—'}</td>
                  <td className="r"><Money v={t.train.net} /></td><td className="r"><Money v={t.validation.net} /></td><td className="r">{t.validation.traded}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Scroll>
        <p className="small muted">Your settings rank {org.rank} of {s.configs_tested} on training. The held-out test is shown only for the selected settings and yours: picking by it would make it in-sample.</p>
      </div>

      {nets.length > 2 && <div className="stack" style={{ ['--gap' as string]: '6px' }}>
        <h3 className="rep-h">Spread of all tested configurations (whole-range net)</h3>
        <Histogram counts={counts} lo={lo} hi={hi} mark={org.full.net} label="net per configuration; line = your settings" />
        <p className="small muted">{nets.filter((v) => v > 0).length} of {nets.length} configurations made money over the whole range. Worst drawdown among them: {money(minOf(s.distribution.map((d) => d.dd)))}.</p>
      </div>}

      <div className="stack" style={{ ['--gap' as string]: '8px' }}>
        <h3 className="rep-h">Walk-forward ({wf.mode}, train {wf.train_sessions} / test {wf.test_sessions} sessions)</h3>
        {wf.status === 'not_run' ? <p className="small muted">Not run: {wf.reason}.</p> : <>
          <Scroll label="Walk-forward folds">
            <table className="ptable legs rs-table">
              <thead><tr><th>Train</th><th>Test</th><th>Chosen</th><th className="r">Test net</th><th className="r">Yours, same days</th></tr></thead>
              <tbody>{wf.folds.map((f, i) => (
                <tr key={i}><td>{f.train[0]} to {f.train[1]}</td><td>{f.test[0]} to {f.test[1]}</td>
                  <td>{f.chosen == null ? f.reason : f.chosen === 0 ? 'your settings' : (s.top.find((t) => t.idx === f.chosen)?.changed ?? []).map((c) => fmtParam(c.key, c.to)).join(' · ') || `configuration ${f.chosen}`}</td>
                  <td className="r"><Money v={f.oos?.net} /></td><td className="r"><Money v={f.orig_oos?.net} /></td></tr>
              ))}</tbody>
            </table>
          </Scroll>
          <p className="small">Out of sample, re-choosing each time: <Money v={wf.oos.net} /> on {wf.oos.traded} traded days; your settings on the same days: <Money v={wf.original_oos.net} />. Walk-forward efficiency {wf.wfe == null ? 'n/a (no in-sample profit)' : nm(wf.wfe)}; the choice changed {wf.distinct_choices} time{wf.distinct_choices === 1 ? '' : 's'} over {wf.folds.filter((f) => f.chosen != null).length} folds.</p>
        </>}
      </div>

      <div className="stack" style={{ ['--gap' as string]: '6px' }}>
        <h3 className="rep-h">Overfitting checks</h3>
        <table className="ptable rep"><tbody>
          <tr><th scope="row">Probability of backtest overfitting</th><td className="num">{s.pbo.status === 'ok' ? pc(100 * (s.pbo.pbo ?? 0), 0) : 'n/a'}</td><td className="rep-note">{s.pbo.status === 'ok' ? `${s.pbo.combinations} splits into ${s.pbo.blocks} blocks; above 50% the in-sample winner usually lands below the median out of sample` : s.pbo.reason}</td></tr>
          <tr><th scope="row">Deflated Sharpe ratio</th><td className="num">{s.dsr ? pc(100 * s.dsr.dsr, 0) : 'n/a'}</td><td className="rep-note">{s.dsr ? `chance the selected Sharpe beats the best of ${s.dsr.trials} configurations by luck alone (PSR vs zero ${pc(100 * s.dsr.psr, 0)})` : 'needs at least 3 sessions'}</td></tr>
          <tr><th scope="row">Training vs validation rank agreement</th><td className="num">{nm(s.rank_corr_train_val)}</td><td className="rep-note">Spearman; near zero means the ranking is mostly noise</td></tr>
        </tbody></table>
      </div>

      <SensBlock s={s} />
      <StressBlock s={s} />
      <McView mc={s.monte_carlo.selected} capital={null} title="Monte Carlo, selected settings" />
      <McView mc={s.monte_carlo.original} capital={null} title="Monte Carlo, your settings" />
    </div>
  );
}

function SensBlock({ s }: { s: Study }) {
  return (
    <div className="stack" style={{ ['--gap' as string]: '8px' }}>
      <h3 className="rep-h">Sensitivity of the selected settings (training + validation)</h3>
      <Scroll label="Sensitivity">
        <table className="ptable legs rs-table">
          <thead><tr><th>Setting</th><th>Value</th>{PERF_HEAD}</tr></thead>
          <tbody>{s.sensitivity.flatMap((x) => [
            <tr key={x.key} className="rs-group"><th colSpan={8}>{x.label} · neighbours keep {x.retention == null ? 'n/a' : pc(100 * x.retention, 0)} of the score · {x.positive_neighbours} of {x.neighbours} profitable</th></tr>,
            ...x.rows.map((r) => <tr key={`${x.key}-${String(r.value)}`} data-base={r.step === 0 ? '' : undefined}><td /><td>{choiceLabel(r.value)}{r.step === 0 ? ' (selected)' : ''}</td><PerfCells p={r.p} /></tr>),
          ])}</tbody>
        </table>
      </Scroll>
    </div>
  );
}

function StressBlock({ s }: { s: Study }) {
  return (
    <div className="stack" style={{ ['--gap' as string]: '8px' }}>
      <h3 className="rep-h">Transaction-cost stress (whole range)</h3>
      <Scroll label="Cost stress">
        <table className="ptable legs rs-table">
          <thead><tr><th>Scenario</th><th>Settings</th>{PERF_HEAD}</tr></thead>
          <tbody>{s.stress.selected.rows.flatMap((r, i) => [
            <tr key={`${r.key}-s`}><th scope="row" rowSpan={2}>{r.label}{r.inert && <span className="rs-sub">no effect on this data (quoted bid/ask)</span>}</th><td>Selected</td><PerfCells p={r.p} /></tr>,
            <tr key={`${r.key}-o`}><td>Yours</td><PerfCells p={s.stress.original.rows[i]?.p} /></tr>,
          ])}</tbody>
        </table>
      </Scroll>
      <p className="small">{s.stress.selected.slip_inert ? `Break-even slippage: ${s.stress.selected.break_even_note}.` : <>Break-even slippage per fill: selected {s.stress.selected.break_even_slip != null ? pc(s.stress.selected.break_even_slip, 2) : s.stress.selected.break_even_note}; yours {s.stress.original.break_even_slip != null ? pc(s.stress.original.break_even_slip, 2) : s.stress.original.break_even_note}.</>}</p>
    </div>
  );
}
